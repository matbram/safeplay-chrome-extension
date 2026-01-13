// Controller for managing video filtering on watch pages
import { Transcript, MuteInterval, UserPreferences } from '../types';
import { AudioFilter } from '../filter/audio-filter';
import { parseTranscript } from '../filter/transcript-parser';

export type FilterStatus =
  | 'idle'
  | 'loading'
  | 'processing'
  | 'active'
  | 'error'
  | 'disabled';

export interface VideoControllerState {
  status: FilterStatus;
  progress: number;
  error?: string;
  intervalCount: number;
  currentlyMuting: boolean;
}

interface VideoControllerOptions {
  onStateChange?: (state: VideoControllerState) => void;
  debug?: boolean;
}

export class VideoController {
  private youtubeId: string | null = null;
  private video: HTMLVideoElement | null = null;
  private audioFilter: AudioFilter;
  private transcript: Transcript | null = null;
  private muteIntervals: MuteInterval[] = [];
  private preferences: UserPreferences | null = null;
  private status: FilterStatus = 'idle';
  private progress = 0;
  private error?: string;
  private options: VideoControllerOptions;
  private statusOverlay: HTMLElement | null = null;

  constructor(options: VideoControllerOptions = {}) {
    this.options = options;
    this.audioFilter = new AudioFilter({
      onMuteStart: (interval) => this.onMuteStart(interval),
      onMuteEnd: () => this.onMuteEnd(),
    });
  }

  // Initialize controller for a video
  async initialize(
    youtubeId: string,
    preferences: UserPreferences
  ): Promise<void> {
    this.youtubeId = youtubeId;
    this.preferences = preferences;
    this.updateStatus('idle');

    // Find video element
    this.video = this.findVideoElement();
    if (!this.video) {
      this.log('Video element not found, waiting...');
      await this.waitForVideo();
    }

    if (!this.video) {
      this.updateStatus('error', 0, 'Could not find video element');
      return;
    }

    this.log('Video controller initialized for:', youtubeId);
  }

  // Request and apply filter
  async applyFilter(): Promise<void> {
    if (!this.youtubeId || !this.video || !this.preferences) {
      this.log('Cannot apply filter: missing required data');
      return;
    }

    if (!this.preferences.enabled) {
      this.updateStatus('disabled');
      return;
    }

    try {
      this.updateStatus('loading');

      // Request transcript from background script
      const response = await chrome.runtime.sendMessage({
        type: 'GET_FILTER',
        payload: { youtubeId: this.youtubeId },
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to get transcript');
      }

      // If processing, we'll receive progress updates
      if (response.data.status === 'processing') {
        this.updateStatus('processing', response.data.progress || 0);
        return; // Background will send completion message
      }

      // Parse transcript and create mute intervals
      this.transcript = response.data.transcript;
      await this.processTranscript();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.updateStatus('error', 0, message);
      this.log('Filter error:', error);
    }
  }

  // Process transcript and start filtering
  async processTranscript(): Promise<void> {
    if (!this.transcript || !this.preferences || !this.video) {
      return;
    }

    // Parse transcript for profanity
    this.muteIntervals = parseTranscript(this.transcript, this.preferences);
    this.log('Found', this.muteIntervals.length, 'mute intervals');

    if (this.muteIntervals.length === 0) {
      this.updateStatus('active');
      this.log('No profanity detected in video');
      return;
    }

    // Initialize and start audio filter
    this.audioFilter.initialize(
      this.video,
      this.muteIntervals,
      this.preferences.filterMode
    );
    this.audioFilter.start();

    this.updateStatus('active');
    this.showStatusOverlay();
  }

  // Handle transcript received from background
  onTranscriptReceived(transcript: Transcript): void {
    this.transcript = transcript;
    this.processTranscript();
  }

  // Handle processing progress
  onProcessingProgress(progress: number): void {
    this.updateStatus('processing', progress);
  }

  // Handle processing error
  onProcessingError(error: string): void {
    this.updateStatus('error', 0, error);
  }

  // Stop filtering
  stop(): void {
    this.audioFilter.stop();
    this.hideStatusOverlay();
    this.updateStatus('idle');
  }

  // Resume filtering (re-start audio filter)
  resume(): void {
    if (!this.video || this.muteIntervals.length === 0) {
      return;
    }
    this.audioFilter.start();
    this.updateStatus('active');
    this.showStatusOverlay();
  }

  // Update preferences
  updatePreferences(preferences: UserPreferences): void {
    this.preferences = preferences;

    if (!preferences.enabled) {
      this.stop();
      return;
    }

    // Re-parse with new preferences
    if (this.transcript) {
      this.muteIntervals = parseTranscript(this.transcript, preferences);
      this.audioFilter.updateIntervals(this.muteIntervals);
      this.audioFilter.updateMode(preferences.filterMode);
    }
  }

  // Get current state
  getState(): VideoControllerState {
    const filterState = this.audioFilter.getState();
    return {
      status: this.status,
      progress: this.progress,
      error: this.error,
      intervalCount: filterState.intervalCount,
      currentlyMuting: filterState.isMuted,
    };
  }

  // Get mute intervals for caption filtering
  getMuteIntervals(): MuteInterval[] {
    return this.muteIntervals;
  }

  // Find the YouTube video element
  private findVideoElement(): HTMLVideoElement | null {
    // Main player video
    const selectors = [
      'video.html5-main-video',
      'video.video-stream',
      '#movie_player video',
      'ytd-player video',
      'video',
    ];

    for (const selector of selectors) {
      const video = document.querySelector<HTMLVideoElement>(selector);
      if (video && video.src) {
        return video;
      }
    }

    return null;
  }

  // Wait for video element to appear
  private waitForVideo(timeout = 10000): Promise<HTMLVideoElement | null> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const check = () => {
        this.video = this.findVideoElement();
        if (this.video) {
          resolve(this.video);
          return;
        }

        if (Date.now() - startTime > timeout) {
          resolve(null);
          return;
        }

        requestAnimationFrame(check);
      };

      check();
    });
  }

  // Update status and notify listeners
  private updateStatus(
    status: FilterStatus,
    progress = 0,
    error?: string
  ): void {
    this.status = status;
    this.progress = progress;
    this.error = error;

    if (this.options.onStateChange) {
      this.options.onStateChange(this.getState());
    }
  }

  // Show status overlay on video
  private showStatusOverlay(): void {
    if (this.statusOverlay) return;

    const playerContainer = document.querySelector('#movie_player');
    if (!playerContainer) return;

    this.statusOverlay = document.createElement('div');
    this.statusOverlay.className = 'safeplay-status-overlay';
    this.statusOverlay.innerHTML = `
      <div class="safeplay-status-badge">
        <svg class="safeplay-status-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
        </svg>
        <span>SafePlay Active</span>
      </div>
    `;

    playerContainer.appendChild(this.statusOverlay);

    // Auto-hide after 3 seconds
    setTimeout(() => {
      this.statusOverlay?.classList.add('safeplay-status-hidden');
    }, 3000);
  }

  // Hide status overlay
  private hideStatusOverlay(): void {
    if (this.statusOverlay) {
      this.statusOverlay.remove();
      this.statusOverlay = null;
    }
  }

  // Event handlers
  private onMuteStart(interval: MuteInterval): void {
    this.log('Muting:', interval.word);
    this.notifyStateChange();
  }

  private onMuteEnd(): void {
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    if (this.options.onStateChange) {
      this.options.onStateChange(this.getState());
    }
  }

  // Debug logging
  private log(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[SafePlay Controller]', ...args);
    }
  }
}
