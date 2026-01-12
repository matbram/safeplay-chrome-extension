// SafePlay Content Script - Main Entry Point
import { ResilientInjector } from './resilient-injector';
import { VideoController } from './video-controller';
import { UserPreferences, DEFAULT_PREFERENCES, Transcript, ButtonStateInfo } from '../types';
import './styles.css';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[SafePlay]', ...args);
  }
}

class SafePlayContentScript {
  private injector: ResilientInjector;
  private videoController: VideoController | null = null;
  private preferences: UserPreferences = DEFAULT_PREFERENCES;
  private currentVideoId: string | null = null;
  private isProcessing = false;

  constructor() {
    // Initialize resilient injector for video watch page
    this.injector = new ResilientInjector({
      onButtonClick: (youtubeId) => this.onFilterButtonClick(youtubeId),
      debug: DEBUG,
    });

    // Initialize video controller
    this.videoController = new VideoController({
      onStateChange: (state) => this.onVideoStateChange(state),
      debug: DEBUG,
    });
  }

  async initialize(): Promise<void> {
    log('Initializing SafePlay content script');

    // Load user preferences
    await this.loadPreferences();

    // Start injector - it handles watch page detection internally
    this.injector.start();

    // Check if we're on a watch page
    if (this.isWatchPage()) {
      this.currentVideoId = this.getVideoIdFromUrl();
    }

    // Listen for messages from background/popup
    this.setupMessageListener();

    // Listen for URL changes (YouTube SPA)
    this.setupNavigationListener();

    log('SafePlay initialized');
  }

  private async loadPreferences(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_PREFERENCES',
      });

      if (response.success && response.data) {
        this.preferences = response.data;
      }
    } catch (error) {
      log('Failed to load preferences:', error);
    }
  }

  private isWatchPage(): boolean {
    return window.location.pathname === '/watch';
  }

  private getVideoIdFromUrl(): string | null {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
  }

  private updateButtonState(stateInfo: ButtonStateInfo): void {
    this.injector.updateButtonState(stateInfo);
  }

  // Main filter flow - called when SafePlay button is clicked
  private async onFilterButtonClick(youtubeId: string): Promise<void> {
    if (this.isProcessing) {
      log('Already processing, ignoring click');
      return;
    }

    log('Filter button clicked for:', youtubeId);
    this.isProcessing = true;
    this.currentVideoId = youtubeId;

    try {
      // Step 1: Connecting
      this.updateButtonState({ state: 'connecting', text: 'Connecting...' });

      // Request filter from background script (which calls the API)
      const response = await chrome.runtime.sendMessage({
        type: 'GET_FILTER',
        payload: { youtubeId },
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to request filter');
      }

      const { status, transcript, jobId } = response.data;

      if ((status === 'cached' || status === 'completed') && transcript) {
        // Transcript was cached (locally or on server), skip to processing
        log('Using cached transcript');
        this.updateButtonState({ state: 'processing', text: 'Processing...' });
        await this.applyFilter(transcript);
      } else if (status === 'processing' && jobId) {
        // Need to poll for job completion
        log('Job started, polling for completion:', jobId);
        await this.pollJobStatus(jobId);
      } else {
        throw new Error('Unexpected API response');
      }
    } catch (error) {
      log('Filter request failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.updateButtonState({
        state: 'error',
        text: 'Error',
        error: errorMessage,
      });
      this.isProcessing = false;
    }
  }

  // Poll for job status with progress updates
  private async pollJobStatus(jobId: string): Promise<void> {
    const maxAttempts = 180; // 6 minutes max (2s intervals)
    const pollInterval = 2000;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'CHECK_JOB',
          payload: { jobId },
        });

        if (!response.success) {
          throw new Error(response.error || 'Failed to check job status');
        }

        const { status, progress, transcript, error } = response.data;

        log(`Job status: ${status}, progress: ${progress}%`);

        // Update button based on job status with user-friendly messages
        switch (status) {
          case 'pending':
            this.updateButtonState({
              state: 'processing',
              text: 'Starting...',
              progress: 5,
            });
            break;

          case 'downloading':
          case 'transcribing':
            // Show generic "Analyzing" with progress percentage
            // Scale progress: downloading 0-30%, transcribing 30-90%
            const scaledProgress = status === 'downloading'
              ? Math.round(progress * 0.3)
              : Math.round(30 + progress * 0.6);
            this.updateButtonState({
              state: 'processing',
              text: `Analyzing ${scaledProgress}%`,
              progress: scaledProgress,
            });
            break;

          case 'completed':
            if (transcript) {
              this.updateButtonState({
                state: 'processing',
                text: 'Analyzing 95%',
                progress: 95,
              });
              await this.applyFilter(transcript);
              return;
            } else {
              throw new Error('Job completed but no transcript returned');
            }

          case 'failed':
            throw new Error(error || 'Processing failed');

          default:
            // Generic processing state
            this.updateButtonState({
              state: 'processing',
              text: `Analyzing ${Math.round(progress)}%`,
              progress,
            });
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        attempts++;
      } catch (error) {
        log('Poll error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.updateButtonState({
          state: 'error',
          text: 'Error',
          error: errorMessage,
        });
        this.isProcessing = false;
        return;
      }
    }

    // Timeout
    this.updateButtonState({
      state: 'error',
      text: 'Timeout',
      error: 'Processing took too long. Please try again.',
    });
    this.isProcessing = false;
  }

  // Apply the filter using the transcript
  private async applyFilter(transcript: Transcript): Promise<void> {
    if (!this.videoController) {
      throw new Error('Video controller not initialized');
    }

    const videoId = this.currentVideoId;
    if (!videoId) {
      throw new Error('No video ID');
    }

    // Log transcript structure to verify character-level data
    log('Transcript received for filtering:', {
      id: transcript.id,
      segmentCount: transcript.segments?.length,
      sampleSegment: transcript.segments?.[0] ? {
        text: transcript.segments[0].text,
        times: `${transcript.segments[0].start_time}s - ${transcript.segments[0].end_time}s`,
        hasCharacters: !!transcript.segments[0].characters,
        charCount: transcript.segments[0].characters?.length,
        sampleChars: transcript.segments[0].characters?.slice(0, 3),
      } : null,
    });

    try {
      // Initialize video controller with transcript
      await this.videoController.initialize(videoId, this.preferences);
      this.videoController.onTranscriptReceived(transcript);

      // Apply the filter
      await this.videoController.applyFilter();

      // Get the interval count for display
      const state = this.videoController.getState();
      const intervalCount = state.intervalCount || 0;

      // Update button to filtering state
      this.updateButtonState({
        state: 'filtering',
        text: `Filtering (${intervalCount})`,
        intervalCount,
      });

      log(`Filter applied successfully. ${intervalCount} profanity instances will be muted.`);

      // Create player controls for toggling
      this.injectPlayerControls();
    } catch (error) {
      log('Failed to apply filter:', error);
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  private injectPlayerControls(): void {
    // Check if already injected
    if (document.querySelector('.safeplay-player-controls')) return;

    // Wait for player controls to be available
    const waitForControls = () => {
      const rightControls = document.querySelector('.ytp-right-controls');
      if (rightControls) {
        this.createPlayerButton(rightControls);
      } else {
        setTimeout(waitForControls, 500);
      }
    };

    waitForControls();
  }

  private createPlayerButton(container: Element): void {
    const button = document.createElement('button');
    button.className = 'ytp-button safeplay-player-controls safeplay-active';
    button.title = 'SafePlay Filter Active - Click to toggle';
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
      </svg>
    `;

    button.addEventListener('click', () => this.toggleFilter());

    // Insert before settings button (if it's a direct child)
    const settingsButton = container.querySelector('.ytp-settings-button');
    if (settingsButton && settingsButton.parentElement === container) {
      container.insertBefore(button, settingsButton);
    } else {
      // Just prepend to the container
      container.insertBefore(button, container.firstChild);
    }
  }

  private async toggleFilter(): Promise<void> {
    if (!this.videoController) return;

    const state = this.videoController.getState();
    const playerButton = document.querySelector('.safeplay-player-controls');

    if (state.status === 'active') {
      this.videoController.stop();
      playerButton?.classList.remove('safeplay-active');
      playerButton?.setAttribute('title', 'SafePlay Filter Paused - Click to resume');
      this.updateButtonState({ state: 'idle', text: 'SafePlay' });
    } else if (this.currentVideoId) {
      // Resume filtering
      this.videoController.resume();
      playerButton?.classList.add('safeplay-active');
      playerButton?.setAttribute('title', 'SafePlay Filter Active - Click to toggle');

      const intervalCount = state.intervalCount || 0;
      this.updateButtonState({
        state: 'filtering',
        text: `Filtering (${intervalCount})`,
        intervalCount,
      });
    }
  }

  private onVideoStateChange(state: ReturnType<VideoController['getState']>): void {
    log('Video state changed:', state);

    // Notify popup of state change
    chrome.runtime.sendMessage({
      type: 'VIDEO_STATE_CHANGED',
      payload: state,
    }).catch(() => {
      // Popup might not be open
    });
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      this.handleMessage(message).then(sendResponse);
      return true; // Keep channel open for async response
    });
  }

  private async handleMessage(message: { type: string; payload?: unknown }): Promise<unknown> {
    switch (message.type) {
      case 'PREFERENCES_UPDATED': {
        const newPrefs = message.payload as UserPreferences;
        this.preferences = newPrefs;
        this.videoController?.updatePreferences(newPrefs);
        return { success: true };
      }

      case 'GET_VIDEO_STATE': {
        return {
          success: true,
          data: this.videoController?.getState() || null,
        };
      }

      default:
        return { success: false, error: 'Unknown message type' };
    }
  }

  private setupNavigationListener(): void {
    // YouTube SPA navigation
    document.addEventListener('yt-navigate-finish', () => {
      log('YouTube navigation detected');
      this.onNavigation();
    });

    // Fallback: popstate
    window.addEventListener('popstate', () => {
      this.onNavigation();
    });
  }

  private onNavigation(): void {
    // Stop current filter if any
    if (this.videoController) {
      this.videoController.stop();
    }

    // Reset state
    this.currentVideoId = null;
    this.isProcessing = false;

    // Remove player button
    const playerButton = document.querySelector('.safeplay-player-controls');
    if (playerButton) {
      playerButton.remove();
    }

    // Update video ID if on watch page
    if (this.isWatchPage()) {
      this.currentVideoId = this.getVideoIdFromUrl();
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const safeplay = new SafePlayContentScript();
    safeplay.initialize();
  });
} else {
  const safeplay = new SafePlayContentScript();
  safeplay.initialize();
}
