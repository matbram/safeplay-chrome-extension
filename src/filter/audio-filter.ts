import { MuteInterval, FilterMode } from '../types';

// Fade duration in seconds for smooth transitions
const FADE_DURATION = 0.05; // 50ms fade - fast but smooth
const FADE_BUFFER = 0.08; // 80ms - start fading before interval begins

export class AudioFilter {
  private video: HTMLVideoElement | null = null;
  private muteIntervals: MuteInterval[] = [];
  private filterMode: FilterMode = 'mute';
  private isActive = false;
  private checkIntervalId: number | null = null;
  private isMuted = false;
  private isFading = false;

  // Web Audio API for smooth volume control
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;

  // Bleep sound nodes
  private bleepOscillator: OscillatorNode | null = null;
  private bleepGain: GainNode | null = null;

  // Track current gain target to avoid redundant fades
  private currentGainTarget = 1;

  // Callbacks
  private onMuteStart?: (interval: MuteInterval) => void;
  private onMuteEnd?: () => void;

  constructor(options?: {
    onMuteStart?: (interval: MuteInterval) => void;
    onMuteEnd?: () => void;
  }) {
    this.onMuteStart = options?.onMuteStart;
    this.onMuteEnd = options?.onMuteEnd;
  }

  // Initialize with video element and mute intervals
  initialize(
    video: HTMLVideoElement,
    intervals: MuteInterval[],
    mode: FilterMode = 'mute'
  ): void {
    this.video = video;
    this.muteIntervals = intervals;
    this.filterMode = mode;

    // Sort intervals by start time for efficient lookup
    this.muteIntervals.sort((a, b) => a.start - b.start);

    // Initialize Web Audio API for smooth volume control
    this.initializeAudioContext();
  }

  private initializeAudioContext(): void {
    if (!this.video || this.audioContext) return;

    try {
      this.audioContext = new AudioContext();

      // Create source from video element
      this.sourceNode = this.audioContext.createMediaElementSource(this.video);

      // Create gain node for volume control
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1; // Start at full volume

      // Connect: video -> gain -> destination (speakers)
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);

      // Setup bleep gain for bleep mode
      if (this.filterMode === 'bleep') {
        this.bleepGain = this.audioContext.createGain();
        this.bleepGain.gain.value = 0;
        this.bleepGain.connect(this.audioContext.destination);
      }

      console.log('[SafePlay] Audio context initialized with smooth fading');
    } catch (error) {
      console.error('[SafePlay] Failed to initialize audio context:', error);
      // Fallback: will use video.muted instead
    }
  }

  // Start monitoring playback
  start(): void {
    if (this.isActive || !this.video) {
      return;
    }

    this.isActive = true;

    // Resume audio context if suspended (browser autoplay policy)
    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume();
    }

    // Check every 5ms for precise timing
    this.checkIntervalId = window.setInterval(() => {
      this.checkCurrentTime();
    }, 5);

    console.log('[SafePlay] Audio filter started with', this.muteIntervals.length, 'intervals (smooth fading enabled)');
  }

  // Stop monitoring
  stop(): void {
    if (!this.isActive) {
      return;
    }

    this.isActive = false;

    if (this.checkIntervalId !== null) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }

    // Restore full volume
    this.fadeToVolume(1);

    // Stop bleep if playing
    if (this.bleepOscillator) {
      this.bleepOscillator.stop();
      this.bleepOscillator = null;
    }

    console.log('[SafePlay] Audio filter stopped');
  }

  // Clean up resources
  destroy(): void {
    this.stop();

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  // Check if current time falls within or is approaching any mute interval
  private checkCurrentTime(): void {
    if (!this.video || !this.isActive) {
      return;
    }

    const currentTime = this.video.currentTime;

    // Check if we're in an interval OR approaching one (within fade buffer)
    const activeInterval = this.findActiveInterval(currentTime);
    const approachingInterval = this.findApproachingInterval(currentTime);

    if (activeInterval) {
      // We're inside a mute interval - ensure volume is 0
      if (!this.isMuted) {
        this.startMute(activeInterval);
      }
    } else if (approachingInterval) {
      // We're approaching an interval - start fading out
      if (!this.isMuted && !this.isFading) {
        this.startFadeOut(approachingInterval);
      }
    } else {
      // We're outside all intervals - ensure volume is restored
      if (this.isMuted) {
        this.endMute();
      }
    }
  }

  // Find if we're currently inside a mute interval
  private findActiveInterval(time: number): MuteInterval | null {
    for (const interval of this.muteIntervals) {
      if (time >= interval.start && time <= interval.end) {
        return interval;
      }
      // Since sorted, we can break early
      if (interval.start > time + FADE_BUFFER) {
        break;
      }
    }
    return null;
  }

  // Find if we're approaching a mute interval (within fade buffer)
  private findApproachingInterval(time: number): MuteInterval | null {
    for (const interval of this.muteIntervals) {
      // Check if we're within the fade buffer before the interval starts
      const fadeStartTime = interval.start - FADE_BUFFER;
      if (time >= fadeStartTime && time < interval.start) {
        return interval;
      }
      // Since sorted, we can break early
      if (interval.start > time + FADE_BUFFER) {
        break;
      }
    }
    return null;
  }

  // Start fading out before the interval
  private startFadeOut(interval: MuteInterval): void {
    this.isFading = true;
    this.fadeToVolume(0, () => {
      this.isFading = false;
      this.isMuted = true;
      if (this.onMuteStart) {
        this.onMuteStart(interval);
      }
    });

    // Start bleep if in bleep mode
    if (this.filterMode === 'bleep') {
      this.startBleep();
    }
  }

  // Immediately mute (when we enter an interval without approaching it first, e.g., seeking)
  private startMute(interval: MuteInterval): void {
    this.isMuted = true;
    this.fadeToVolume(0);

    if (this.filterMode === 'bleep') {
      this.startBleep();
    }

    if (this.onMuteStart) {
      this.onMuteStart(interval);
    }
  }

  // End mute - fade back in
  private endMute(): void {
    this.isMuted = false;
    this.fadeToVolume(1);

    if (this.filterMode === 'bleep') {
      this.stopBleep();
    }

    if (this.onMuteEnd) {
      this.onMuteEnd();
    }
  }

  // Smooth fade to target volume
  private fadeToVolume(target: number, onComplete?: () => void): void {
    // Skip if already at target
    if (this.currentGainTarget === target) {
      onComplete?.();
      return;
    }

    this.currentGainTarget = target;

    if (this.gainNode && this.audioContext) {
      const now = this.audioContext.currentTime;

      // Cancel any ongoing transitions
      this.gainNode.gain.cancelScheduledValues(now);

      // Set current value
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);

      // Ramp to target over fade duration
      this.gainNode.gain.linearRampToValueAtTime(target, now + FADE_DURATION);

      // Call completion callback after fade
      if (onComplete) {
        setTimeout(onComplete, FADE_DURATION * 1000);
      }
    } else {
      // Fallback to hard mute if no audio context
      if (this.video) {
        this.video.muted = target === 0;
      }
      onComplete?.();
    }
  }

  private startBleep(): void {
    if (!this.audioContext || !this.bleepGain) return;

    // Resume audio context if suspended
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Create oscillator for bleep sound
    this.bleepOscillator = this.audioContext.createOscillator();
    this.bleepOscillator.type = 'sine';
    this.bleepOscillator.frequency.value = 1000; // 1kHz bleep
    this.bleepOscillator.connect(this.bleepGain);

    // Fade in bleep
    const now = this.audioContext.currentTime;
    this.bleepGain.gain.setValueAtTime(0, now);
    this.bleepGain.gain.linearRampToValueAtTime(0.3, now + FADE_DURATION);

    this.bleepOscillator.start();
  }

  private stopBleep(): void {
    if (!this.audioContext || !this.bleepGain || !this.bleepOscillator) return;

    // Fade out bleep
    const now = this.audioContext.currentTime;
    this.bleepGain.gain.linearRampToValueAtTime(0, now + FADE_DURATION);

    // Stop and disconnect after fade
    const oscillator = this.bleepOscillator;
    setTimeout(() => {
      try {
        oscillator.stop();
        oscillator.disconnect();
      } catch (e) {
        // Already stopped
      }
    }, FADE_DURATION * 1000 + 10);

    this.bleepOscillator = null;
  }

  // Update intervals (e.g., when preferences change)
  updateIntervals(intervals: MuteInterval[]): void {
    this.muteIntervals = intervals;
    this.muteIntervals.sort((a, b) => a.start - b.start);
  }

  // Update filter mode
  updateMode(mode: FilterMode): void {
    this.filterMode = mode;

    // Initialize bleep gain if switching to bleep mode
    if (mode === 'bleep' && this.audioContext && !this.bleepGain) {
      this.bleepGain = this.audioContext.createGain();
      this.bleepGain.gain.value = 0;
      this.bleepGain.connect(this.audioContext.destination);
    }
  }

  // Get current state
  getState(): {
    isActive: boolean;
    isMuted: boolean;
    intervalCount: number;
    filterMode: FilterMode;
  } {
    return {
      isActive: this.isActive,
      isMuted: this.isMuted,
      intervalCount: this.muteIntervals.length,
      filterMode: this.filterMode,
    };
  }

  // Check if filtering is active
  isFiltering(): boolean {
    return this.isActive;
  }

  // Get all intervals (for debugging/display)
  getIntervals(): MuteInterval[] {
    return [...this.muteIntervals];
  }
}
