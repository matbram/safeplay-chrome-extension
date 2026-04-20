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
  private isBleeping = false; // Track if bleep should be playing

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

  // Bound event handlers for cleanup
  private boundHandleVideoPause: () => void;
  private boundHandleVideoPlay: () => void;
  private boundHandleVideoEnded: () => void;
  private boundHandleVideoSeeking: () => void;
  private boundHandleVisibilityChange: () => void;

  constructor(options?: {
    onMuteStart?: (interval: MuteInterval) => void;
    onMuteEnd?: () => void;
  }) {
    this.onMuteStart = options?.onMuteStart;
    this.onMuteEnd = options?.onMuteEnd;

    // Bind event handlers
    this.boundHandleVideoPause = this.handleVideoPause.bind(this);
    this.boundHandleVideoPlay = this.handleVideoPlay.bind(this);
    this.boundHandleVideoEnded = this.handleVideoEnded.bind(this);
    this.boundHandleVideoSeeking = this.handleVideoSeeking.bind(this);
    this.boundHandleVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  // Initialize with video element and mute intervals.
  //
  // IMPORTANT: If called again with a DIFFERENT <video> element (e.g. after
  // YouTube SPA navigation swaps the player), we tear down the old Web Audio
  // graph first. Web Audio's MediaElementAudioSourceNode is permanently
  // attached to the element it was created from — reusing the old graph
  // against a new element silently fails (new element plays audio natively
  // while our muted gain node sits orphaned). That was the root cause of
  // "filter says Censored but audio still plays" after SPA navigation.
  initialize(
    video: HTMLVideoElement,
    intervals: MuteInterval[],
    mode: FilterMode = 'mute'
  ): void {
    // Rebuild the audio graph if the video element changed, OR if the old
    // element is no longer attached to the document (YouTube detached it).
    const videoChanged = this.video !== null && this.video !== video;
    const oldVideoDetached = this.video !== null && !this.video.isConnected;
    if (videoChanged || oldVideoDetached) {
      this.teardownAudioGraph();
    }

    this.video = video;
    this.muteIntervals = intervals;
    this.filterMode = mode;

    // Reset per-video runtime flags so stale state from a previous video
    // doesn't leak into the new one (e.g. isMuted=true carried across nav).
    this.isMuted = false;
    this.isFading = false;
    this.isBleeping = false;
    this.currentGainTarget = 1;

    // Sort intervals by start time for efficient lookup
    this.muteIntervals.sort((a, b) => a.start - b.start);

    // Initialize Web Audio API for smooth volume control
    this.initializeAudioContext();
  }

  // Tear down the Web Audio graph and detach video event listeners — called
  // when the target <video> element changes. Does NOT clear mute intervals
  // or state like isActive; the caller decides what to do next.
  private teardownAudioGraph(): void {
    // Stop any active bleep oscillator(s) before disconnecting nodes.
    if (this.bleepOscillator) {
      const secondOsc = (this.bleepOscillator as any)._secondOscillator;
      const mixer = (this.bleepOscillator as any)._mixer;
      try { this.bleepOscillator.stop(); } catch { /* already stopped */ }
      try { this.bleepOscillator.disconnect(); } catch { /* already disconnected */ }
      if (secondOsc) {
        try { secondOsc.stop(); } catch { /* already stopped */ }
        try { secondOsc.disconnect(); } catch { /* already disconnected */ }
      }
      if (mixer) {
        try { mixer.disconnect(); } catch { /* already disconnected */ }
      }
      this.bleepOscillator = null;
    }

    // Remove listeners from the OLD video before we drop the reference.
    this.removeVideoEventListeners();

    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch { /* already disconnected */ }
      this.sourceNode = null;
    }
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch { /* already disconnected */ }
      this.gainNode = null;
    }
    if (this.bleepGain) {
      try { this.bleepGain.disconnect(); } catch { /* already disconnected */ }
      this.bleepGain = null;
    }
    if (this.audioContext) {
      // close() is async; we don't need to await it for correctness, and a
      // synchronous caller shouldn't be blocked. Swallow the rejection that
      // can fire if the context was already closed.
      this.audioContext.close().catch(() => { /* already closed */ });
      this.audioContext = null;
    }
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

      // Add video event listeners for bleep control
      this.addVideoEventListeners();

      console.log('[SafePlay] Audio context initialized with smooth fading');
    } catch (error) {
      // The most common failure here is "HTMLMediaElement has already been
      // connected to a different MediaElementAudioSourceNode" — can happen
      // if a prior graph wasn't torn down. Drop refs so fadeToVolume's
      // fallback branch (video.muted) kicks in.
      console.error('[SafePlay] Failed to initialize audio context:', error);
      if (this.audioContext) {
        try { this.audioContext.close(); } catch { /* ignore */ }
      }
      this.audioContext = null;
      this.sourceNode = null;
      this.gainNode = null;
      this.bleepGain = null;
    }
  }

  // Add event listeners for video state changes
  private addVideoEventListeners(): void {
    if (!this.video) return;

    this.video.addEventListener('pause', this.boundHandleVideoPause);
    this.video.addEventListener('play', this.boundHandleVideoPlay);
    this.video.addEventListener('ended', this.boundHandleVideoEnded);
    this.video.addEventListener('seeking', this.boundHandleVideoSeeking);
    document.addEventListener('visibilitychange', this.boundHandleVisibilityChange);
  }

  // Remove event listeners
  private removeVideoEventListeners(): void {
    if (this.video) {
      this.video.removeEventListener('pause', this.boundHandleVideoPause);
      this.video.removeEventListener('play', this.boundHandleVideoPlay);
      this.video.removeEventListener('ended', this.boundHandleVideoEnded);
      this.video.removeEventListener('seeking', this.boundHandleVideoSeeking);
    }
    document.removeEventListener('visibilitychange', this.boundHandleVisibilityChange);
  }

  // Handle video pause - stop bleep immediately
  private handleVideoPause(): void {
    if (this.isBleeping) {
      this.stopBleep();
    }
  }

  // Handle video play - resume bleep if we're in a mute interval
  private handleVideoPlay(): void {
    if (!this.video || !this.isActive) return;

    // Check if we're currently in a mute interval
    const currentTime = this.video.currentTime;
    const activeInterval = this.findActiveInterval(currentTime);

    if (activeInterval && this.isMuted && this.filterMode === 'bleep') {
      this.startBleep();
    }
  }

  // Handle video ended - stop everything
  private handleVideoEnded(): void {
    if (this.isBleeping) {
      this.stopBleep();
    }
    this.isMuted = false;
    this.isBleeping = false;
  }

  // Handle seeking - stop bleep during seek, checkCurrentTime will restart if needed
  private handleVideoSeeking(): void {
    if (this.isBleeping) {
      this.stopBleep();
    }
  }

  // Handle tab visibility change
  // Note: We do NOT stop the bleep when tab is hidden because the user
  // may switch tabs while still wanting to hear the video with profanity filtered.
  // The bleep should only stop when the video is actually paused.
  private handleVisibilityChange(): void {
    // When tab becomes visible again, check if we need to resume bleep
    // (in case browser throttled audio while hidden)
    if (!document.hidden && this.video && !this.video.paused && this.isMuted && this.filterMode === 'bleep') {
      const currentTime = this.video.currentTime;
      const activeInterval = this.findActiveInterval(currentTime);

      if (activeInterval && !this.bleepOscillator) {
        this.startBleep();
      }
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
    this.isBleeping = false;

    if (this.checkIntervalId !== null) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }

    // Restore full volume
    this.fadeToVolume(1);

    // Stop bleep if playing
    if (this.bleepOscillator) {
      try {
        this.bleepOscillator.stop();
      } catch (e) {
        // Already stopped
      }
      this.bleepOscillator = null;
    }

    console.log('[SafePlay] Audio filter stopped');
  }

  // Clean up resources
  destroy(): void {
    this.stop();
    this.teardownAudioGraph();
    this.video = null;
    this.muteIntervals = [];
  }

  // Check if current time falls within or is approaching any mute interval
  private checkCurrentTime(): void {
    if (!this.video || !this.isActive) {
      return;
    }

    // Don't process if video is paused, ended, or not ready
    if (this.video.paused || this.video.ended || this.video.readyState < 2) {
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

  // Classic TV censor bleep settings
  private readonly BLEEP_FREQUENCY = 1000; // 1kHz - the classic censor bleep frequency
  private readonly BLEEP_VOLUME = 0.35; // Volume level (0-1)
  private readonly BLEEP_ATTACK = 0.008; // 8ms attack - very fast like real censor bleeps
  private readonly BLEEP_RELEASE = 0.025; // 25ms release - slightly slower to avoid clicks

  private startBleep(): void {
    if (!this.audioContext || !this.bleepGain) return;

    // Don't start bleep if video is paused or ended
    // Note: We DO allow bleep when tab is hidden - user may switch tabs
    // while still wanting to hear filtered audio
    if (this.video && (this.video.paused || this.video.ended)) return;

    // Don't start if already bleeping
    if (this.bleepOscillator) return;

    this.isBleeping = true;

    // Resume audio context if suspended
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Create main oscillator for classic censor bleep
    this.bleepOscillator = this.audioContext.createOscillator();
    this.bleepOscillator.type = 'sine'; // Pure sine wave for clean bleep
    this.bleepOscillator.frequency.value = this.BLEEP_FREQUENCY;

    // Create a subtle second oscillator slightly detuned for richness (optional TV effect)
    const oscillator2 = this.audioContext.createOscillator();
    oscillator2.type = 'sine';
    oscillator2.frequency.value = this.BLEEP_FREQUENCY * 1.001; // Slight detune for thickness

    // Create a mixer for the two oscillators
    const mixer = this.audioContext.createGain();
    mixer.gain.value = 0.5;

    // Connect oscillators
    this.bleepOscillator.connect(this.bleepGain);
    oscillator2.connect(mixer);
    mixer.connect(this.bleepGain);

    // Fast attack envelope - classic censor bleep snaps on quickly
    const now = this.audioContext.currentTime;
    this.bleepGain.gain.setValueAtTime(0, now);
    this.bleepGain.gain.linearRampToValueAtTime(this.BLEEP_VOLUME, now + this.BLEEP_ATTACK);

    // Start both oscillators
    this.bleepOscillator.start(now);
    oscillator2.start(now);

    // Store reference to second oscillator for cleanup
    (this.bleepOscillator as any)._secondOscillator = oscillator2;
    (this.bleepOscillator as any)._mixer = mixer;
  }

  private stopBleep(): void {
    this.isBleeping = false;

    if (!this.audioContext || !this.bleepGain || !this.bleepOscillator) return;

    // Smooth release to avoid clicks
    const now = this.audioContext.currentTime;
    this.bleepGain.gain.setValueAtTime(this.bleepGain.gain.value, now);
    this.bleepGain.gain.linearRampToValueAtTime(0, now + this.BLEEP_RELEASE);

    // Stop and disconnect after release completes
    const oscillator = this.bleepOscillator;
    const oscillator2 = (oscillator as any)._secondOscillator;
    const mixer = (oscillator as any)._mixer;

    setTimeout(() => {
      try {
        oscillator.stop();
        oscillator.disconnect();
        if (oscillator2) {
          oscillator2.stop();
          oscillator2.disconnect();
        }
        if (mixer) {
          mixer.disconnect();
        }
      } catch (e) {
        // Already stopped
      }
    }, this.BLEEP_RELEASE * 1000 + 10);

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
