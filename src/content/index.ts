// SafePlay Content Script - Main Entry Point
import { ResilientInjector } from './resilient-injector';
import { VideoController } from './video-controller';
import { SmoothProgressAnimator } from './smooth-progress';
import { CaptionFilter } from './caption-filter';
import { UserPreferences, DEFAULT_PREFERENCES, Transcript, ButtonStateInfo } from '../types';
import { addFilteredVideo, isVideoFiltered } from '../utils/storage';
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
  private captionFilter: CaptionFilter;
  private preferences: UserPreferences = DEFAULT_PREFERENCES;
  private currentVideoId: string | null = null;
  private isProcessing = false;
  private videoWasPlaying = false; // Track if video was playing before we paused it
  private progressAnimator: SmoothProgressAnimator | null = null;
  private lastIntervalCount = 0; // Store interval count for toggle restore
  private isFilterActive = false; // Track if filter is currently active

  constructor() {
    // Initialize resilient injector for video watch page
    this.injector = new ResilientInjector({
      onButtonClick: (youtubeId) => this.onFilterButtonClick(youtubeId),
      onToggleFilter: () => this.toggleFilterFromButton(),
      debug: DEBUG,
    });

    // Initialize video controller
    this.videoController = new VideoController({
      onStateChange: (state) => this.onVideoStateChange(state),
      debug: DEBUG,
    });

    // Initialize caption filter
    this.captionFilter = new CaptionFilter({ debug: DEBUG });
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

      // Check for auto-enable after a short delay (allow button to inject first)
      if (this.currentVideoId) {
        setTimeout(() => this.checkAutoEnable(), 1000);
      }
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

  // Get the video element
  private getVideoElement(): HTMLVideoElement | null {
    return document.querySelector('video.html5-main-video') ||
           document.querySelector('video.video-stream') ||
           document.querySelector('#movie_player video') ||
           document.querySelector('video');
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

    // Pause video while we load the filter to prevent hearing profanity
    const video = this.getVideoElement();
    this.videoWasPlaying = !!(video && !video.paused);
    if (video && this.videoWasPlaying) {
      video.pause();
      log('Video paused while loading filter');
    }

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
      // Resume video on error
      if (this.videoWasPlaying) {
        const video = this.getVideoElement();
        if (video) {
          video.play();
          log('Video resumed after error');
        }
        this.videoWasPlaying = false;
      }
      this.isProcessing = false;
    }
  }

  // Poll for job status with progress updates
  private async pollJobStatus(jobId: string): Promise<void> {
    const maxAttempts = 180; // 6 minutes max (2s intervals)
    const pollInterval = 2000;
    let attempts = 0;

    // Initialize smooth progress animator
    this.progressAnimator = new SmoothProgressAnimator(
      (progress, text) => {
        this.updateButtonState({
          state: 'processing',
          text,
          progress,
        });
      },
      'Analyzing'
    );
    this.progressAnimator.start();

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

        // Calculate actual progress and update animator target
        switch (status) {
          case 'pending':
            this.progressAnimator.setTarget(5);
            break;

          case 'downloading':
            // Scale downloading: 0-100% server progress -> 5-30% display
            this.progressAnimator.setTarget(5 + progress * 0.25);
            break;

          case 'transcribing':
            // Scale transcribing: 0-100% server progress -> 30-85% display
            this.progressAnimator.setTarget(30 + progress * 0.55);
            break;

          case 'completed':
            if (transcript) {
              // Signal completion - animator will smoothly reach 100%
              this.progressAnimator.setTarget(95);
              // Give a moment for progress to animate up
              await new Promise((resolve) => setTimeout(resolve, 300));
              this.progressAnimator.complete();
              // Wait for animation to finish
              await new Promise((resolve) => setTimeout(resolve, 500));
              this.progressAnimator.stop();
              this.progressAnimator = null;
              await this.applyFilter(transcript);
              return;
            } else {
              throw new Error('Job completed but no transcript returned');
            }

          case 'failed':
            throw new Error(error || 'Processing failed');

          default:
            // Generic processing state
            this.progressAnimator.setTarget(progress);
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        attempts++;
      } catch (error) {
        log('Poll error:', error);
        // Stop animator on error
        if (this.progressAnimator) {
          this.progressAnimator.stop();
          this.progressAnimator = null;
        }
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

    // Timeout - stop animator
    if (this.progressAnimator) {
      this.progressAnimator.stop();
      this.progressAnimator = null;
    }
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

      // Get the interval count and mute intervals for display
      const state = this.videoController.getState();
      const intervalCount = state.intervalCount || 0;
      const muteIntervals = this.videoController.getMuteIntervals();

      // Store interval count for toggle restore
      this.lastIntervalCount = intervalCount;
      this.isFilterActive = true;

      // Start caption filtering as well
      this.captionFilter.initialize(this.preferences, muteIntervals);
      this.captionFilter.start();
      log('Caption filter started');

      // Update button to filtering state
      this.updateButtonState({
        state: 'filtering',
        text: `Censored (${intervalCount})`,
        intervalCount,
      });

      log(`Filter applied successfully. ${intervalCount} profanity instances will be muted.`);

      // Store this video as filtered for auto-enable feature
      if (videoId) {
        await addFilteredVideo(videoId);
        log(`Video ${videoId} added to filtered videos list`);
      }

      // Resume video if it was playing before
      if (this.videoWasPlaying) {
        const video = this.getVideoElement();
        if (video) {
          video.play();
          log('Video resumed after filter applied');
        }
        this.videoWasPlaying = false;
      }

      // Create player controls for toggling
      this.injectPlayerControls();
    } catch (error) {
      log('Failed to apply filter:', error);
      // Resume video even on error
      if (this.videoWasPlaying) {
        const video = this.getVideoElement();
        if (video) {
          video.play();
          log('Video resumed after filter error');
        }
        this.videoWasPlaying = false;
      }
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

  // Toggle filter from player controls button
  private async toggleFilter(): Promise<void> {
    await this.toggleFilterFromButton();
  }

  // Toggle filter on/off - called from main button or player controls
  private async toggleFilterFromButton(): Promise<void> {
    if (!this.videoController) return;

    const playerButton = document.querySelector('.safeplay-player-controls');

    if (this.isFilterActive) {
      // Disable filter
      this.videoController.stop();
      this.captionFilter.stop();
      this.isFilterActive = false;

      playerButton?.classList.remove('safeplay-active');
      playerButton?.setAttribute('title', 'SafePlay Filter Paused - Click to resume');

      this.updateButtonState({
        state: 'paused',
        text: 'Paused',
        intervalCount: this.lastIntervalCount,
      });

      log('Filter paused by user');
    } else if (this.currentVideoId && this.lastIntervalCount > 0) {
      // Resume filtering (we have data from before)
      this.videoController.resume();
      this.captionFilter.start();
      this.isFilterActive = true;

      playerButton?.classList.add('safeplay-active');
      playerButton?.setAttribute('title', 'SafePlay Filter Active - Click to toggle');

      this.updateButtonState({
        state: 'filtering',
        text: `Censored (${this.lastIntervalCount})`,
        intervalCount: this.lastIntervalCount,
      });

      log('Filter resumed by user');
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
        this.captionFilter.updatePreferences(newPrefs);
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

    // Stop caption filter
    this.captionFilter.stop();

    // Reset state
    this.currentVideoId = null;
    this.isProcessing = false;
    this.isFilterActive = false;
    this.lastIntervalCount = 0;

    // Remove player button
    const playerButton = document.querySelector('.safeplay-player-controls');
    if (playerButton) {
      playerButton.remove();
    }

    // Update video ID if on watch page
    if (this.isWatchPage()) {
      this.currentVideoId = this.getVideoIdFromUrl();

      // Check for auto-enable after a short delay (allow button to inject first)
      if (this.currentVideoId) {
        setTimeout(() => this.checkAutoEnable(), 500);
      }
    }
  }

  // Check if we should auto-enable filter for this video
  private async checkAutoEnable(): Promise<void> {
    log('Checking auto-enable for video:', this.currentVideoId);
    log('Auto-enable setting:', this.preferences.autoEnableForFilteredVideos);

    if (!this.currentVideoId) {
      log('No video ID, skipping auto-enable check');
      return;
    }

    // Default to true if undefined (for backwards compatibility with old preferences)
    if (this.preferences.autoEnableForFilteredVideos === false) {
      log('Auto-enable is disabled in preferences');
      return;
    }

    // Don't auto-enable if already processing
    if (this.isProcessing) {
      log('Already processing, skipping auto-enable');
      return;
    }

    try {
      const wasFiltered = await isVideoFiltered(this.currentVideoId);
      log(`Video ${this.currentVideoId} was previously filtered:`, wasFiltered);

      if (wasFiltered) {
        log(`Auto-enabling filter for video: ${this.currentVideoId}`);
        // Automatically trigger filter
        this.onFilterButtonClick(this.currentVideoId);
      }
    } catch (error) {
      log('Error checking auto-enable:', error);
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
