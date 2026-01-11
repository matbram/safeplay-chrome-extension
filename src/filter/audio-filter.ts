import { MuteInterval, FilterMode } from '../types';

export class AudioFilter {
  private video: HTMLVideoElement | null = null;
  private muteIntervals: MuteInterval[] = [];
  private filterMode: FilterMode = 'mute';
  private isActive = false;
  private checkIntervalId: number | null = null;
  private isMuted = false;

  // Audio context for bleep sound
  private audioContext: AudioContext | null = null;
  private bleepOscillator: OscillatorNode | null = null;
  private bleepGain: GainNode | null = null;

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

    // Initialize audio context for bleep mode
    if (mode === 'bleep') {
      this.initializeAudioContext();
    }
  }

  private initializeAudioContext(): void {
    try {
      this.audioContext = new AudioContext();
      this.bleepGain = this.audioContext.createGain();
      this.bleepGain.gain.value = 0; // Start silent
      this.bleepGain.connect(this.audioContext.destination);
    } catch (error) {
      console.error('[SafePlay] Failed to initialize audio context:', error);
    }
  }

  // Start monitoring playback
  start(): void {
    if (this.isActive || !this.video) {
      return;
    }

    this.isActive = true;

    // Check every 10ms for precise timing
    this.checkIntervalId = window.setInterval(() => {
      this.checkCurrentTime();
    }, 10);

    console.log('[SafePlay] Audio filter started with', this.muteIntervals.length, 'intervals');
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

    // Restore audio state
    this.unmute();

    // Clean up audio context
    if (this.bleepOscillator) {
      this.bleepOscillator.stop();
      this.bleepOscillator = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    console.log('[SafePlay] Audio filter stopped');
  }

  // Check if current time falls within any mute interval
  private checkCurrentTime(): void {
    if (!this.video || !this.isActive) {
      return;
    }

    const currentTime = this.video.currentTime;
    const activeInterval = this.findActiveInterval(currentTime);

    if (activeInterval && !this.isMuted) {
      this.mute(activeInterval);
    } else if (!activeInterval && this.isMuted) {
      this.unmute();
    }
  }

  // Binary search for active interval (optimized for sorted intervals)
  private findActiveInterval(time: number): MuteInterval | null {
    let low = 0;
    let high = this.muteIntervals.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const interval = this.muteIntervals[mid];

      if (time >= interval.start && time <= interval.end) {
        return interval;
      } else if (time < interval.start) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return null;
  }

  private mute(interval: MuteInterval): void {
    if (!this.video) return;

    this.isMuted = true;

    if (this.filterMode === 'mute') {
      // Simple mute - set volume to 0
      this.video.muted = true;
    } else if (this.filterMode === 'bleep') {
      // Bleep mode - mute video and play bleep tone
      this.video.muted = true;
      this.startBleep();
    }

    if (this.onMuteStart) {
      this.onMuteStart(interval);
    }
  }

  private unmute(): void {
    if (!this.video) return;

    this.isMuted = false;
    this.video.muted = false;

    if (this.filterMode === 'bleep') {
      this.stopBleep();
    }

    if (this.onMuteEnd) {
      this.onMuteEnd();
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

    // Fade in
    this.bleepGain.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.bleepGain.gain.linearRampToValueAtTime(0.3, this.audioContext.currentTime + 0.01);

    this.bleepOscillator.start();
  }

  private stopBleep(): void {
    if (!this.audioContext || !this.bleepGain || !this.bleepOscillator) return;

    // Fade out
    this.bleepGain.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.01);

    // Stop and disconnect
    setTimeout(() => {
      if (this.bleepOscillator) {
        this.bleepOscillator.stop();
        this.bleepOscillator.disconnect();
        this.bleepOscillator = null;
      }
    }, 20);
  }

  // Update intervals (e.g., when preferences change)
  updateIntervals(intervals: MuteInterval[]): void {
    this.muteIntervals = intervals;
    this.muteIntervals.sort((a, b) => a.start - b.start);
  }

  // Update filter mode
  updateMode(mode: FilterMode): void {
    this.filterMode = mode;

    // Initialize audio context if switching to bleep mode
    if (mode === 'bleep' && !this.audioContext) {
      this.initializeAudioContext();
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
