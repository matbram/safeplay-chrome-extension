// SafePlay Content Script - Main Entry Point
import { ResilientInjector } from './resilient-injector';
import { VideoController } from './video-controller';
import { SmoothProgressAnimator } from './smooth-progress';
import { CaptionFilter } from './caption-filter';
import { CreditConfirmation, showAuthRequiredMessage } from './credit-confirmation';
import { UserPreferences, DEFAULT_PREFERENCES, Transcript, ButtonStateInfo, PreviewData } from '../types';
import { addFilteredVideo, isVideoFiltered } from '../utils/storage';
import './styles.css';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[SafePlay]', ...args);
  }
}

// Check if the extension context is still valid (not invalidated by extension reload)
function isExtensionContextValid(): boolean {
  try {
    // Accessing chrome.runtime.id will throw if context is invalidated
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// Safe wrapper for chrome.runtime.sendMessage
async function safeSendMessage<T>(message: unknown): Promise<T | null> {
  if (!isExtensionContextValid()) {
    log('Extension context invalidated, skipping message');
    return null;
  }
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    // Extension context might have been invalidated during the call
    if (String(error).includes('Extension context invalidated')) {
      log('Extension context invalidated during message');
      return null;
    }
    throw error;
  }
}

class SafePlayContentScript {
  private injector: ResilientInjector;
  private videoController: VideoController | null = null;
  private captionFilter: CaptionFilter;
  private preferences: UserPreferences = DEFAULT_PREFERENCES;
  private currentVideoId: string | null = null;
  private filteringVideoId: string | null = null; // Track which video is being filtered (for Shorts)
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

    // Start injector - it handles watch page and Shorts detection internally
    this.injector.start();

    // Check if we're on a watch page or Shorts page
    if (this.isWatchPage() || this.isShortsPage()) {
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
      const response = await safeSendMessage<{ success: boolean; data?: UserPreferences }>({
        type: 'GET_PREFERENCES',
      });

      if (response?.success && response.data) {
        this.preferences = response.data;
      }
    } catch (error) {
      log('Failed to load preferences:', error);
    }
  }

  private isWatchPage(): boolean {
    return window.location.pathname === '/watch';
  }

  private isShortsPage(): boolean {
    return window.location.pathname.startsWith('/shorts');
  }

  private getVideoIdFromUrl(): string | null {
    // Check for regular watch page
    if (this.isWatchPage()) {
      const params = new URLSearchParams(window.location.search);
      return params.get('v');
    }

    // Check for Shorts page
    if (this.isShortsPage()) {
      const match = window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
      return match ? match[1] : null;
    }

    return null;
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

  // Resume video if it was playing before we paused it
  private resumeVideoIfNeeded(): void {
    if (this.videoWasPlaying) {
      const video = this.getVideoElement();
      if (video) {
        video.play();
        log('Video resumed');
      }
      this.videoWasPlaying = false;
    }
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
    this.filteringVideoId = youtubeId;

    try {
      // Step 1: Get preview (credit cost and video info)
      this.updateButtonState({ state: 'connecting', text: 'Checking...', videoId: youtubeId });

      const previewResponse = await safeSendMessage<{ success: boolean; error?: string; data?: PreviewData }>({
        type: 'GET_PREVIEW',
        payload: { youtubeId },
      });

      // Handle extension context invalidated
      if (!previewResponse) {
        this.isProcessing = false;
        this.filteringVideoId = null;
        this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId: youtubeId });
        return;
      }

      // Handle auth errors
      if (!previewResponse.success) {
        if (previewResponse.error?.includes('UNAUTHORIZED') || previewResponse.error?.includes('401')) {
          this.isProcessing = false;
          this.filteringVideoId = null;
          this.updateButtonState({ state: 'idle', text: 'SafePlay', videoId: youtubeId });
          showAuthRequiredMessage();
          return;
        }
        throw new Error(previewResponse.error || 'Failed to get preview');
      }

      if (!previewResponse.data) {
        throw new Error('No preview data received');
      }

      const previewData: PreviewData = previewResponse.data;

      // If cached and has sufficient credits (free), skip confirmation
      if (previewData.isCached && previewData.creditCost === 0) {
        log('Video is cached, skipping confirmation');
        await this.proceedWithFiltering(youtubeId);
        return;
      }

      // Show credit confirmation dialog
      this.updateButtonState({ state: 'idle', text: 'SafePlay', videoId: youtubeId });
      this.isProcessing = false;

      const confirmation = new CreditConfirmation({
        onConfirm: async () => {
          log('User confirmed filtering');
          await this.proceedWithFiltering(youtubeId);
        },
        onCancel: () => {
          log('User cancelled filtering');
          this.filteringVideoId = null;
        },
        debug: DEBUG,
      });

      confirmation.show(previewData);
    } catch (error) {
      log('Preview request failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.updateButtonState({
        state: 'error',
        text: 'Error',
        error: errorMessage,
        videoId: youtubeId,
      });
      this.isProcessing = false;
      this.filteringVideoId = null;
    }
  }

  // Proceed with filtering after user confirmation or for cached videos
  private async proceedWithFiltering(youtubeId: string): Promise<void> {
    if (this.isProcessing) {
      log('Already processing, ignoring');
      return;
    }

    log('Proceeding with filtering for:', youtubeId);
    this.isProcessing = true;
    this.filteringVideoId = youtubeId;

    // Pause video while we load the filter to prevent hearing profanity
    const video = this.getVideoElement();
    this.videoWasPlaying = !!(video && !video.paused);
    if (video && this.videoWasPlaying) {
      video.pause();
      log('Video paused while loading filter');
    }

    try {
      // Step 1: Connecting
      this.updateButtonState({ state: 'connecting', text: 'Connecting...', videoId: youtubeId });

      // Request filter from background script (uses START_FILTER which deducts credits)
      const response = await safeSendMessage<{
        success: boolean;
        error?: string;
        data?: { status: string; transcript?: Transcript; jobId?: string; error?: string; error_code?: string };
      }>({
        type: 'START_FILTER',
        payload: { youtubeId, filterType: this.preferences.filterMode },
      });

      // Handle extension context invalidated
      if (!response) {
        this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId: youtubeId });
        this.resumeVideoIfNeeded();
        return;
      }

      if (!response.success) {
        throw new Error(response.error || 'Failed to request filter');
      }

      if (!response.data) {
        throw new Error('No filter data received');
      }

      const { status, transcript, jobId, error_code, error } = response.data;

      // Handle immediate failure with error_code
      if (status === 'failed') {
        if (error_code === 'AGE_RESTRICTED') {
          this.updateButtonState({
            state: 'age-restricted',
            text: 'Age-Restricted',
            error: error || 'This video is age-restricted by YouTube. SafePlay cannot filter age-restricted content.',
            videoId: youtubeId,
          });
        } else if (error_code === 'INSUFFICIENT_CREDITS') {
          this.updateButtonState({
            state: 'error',
            text: 'No Credits',
            error: error || 'Insufficient credits. Please purchase more credits at safeplay.app',
            videoId: youtubeId,
          });
        } else {
          this.updateButtonState({
            state: 'error',
            text: 'Error',
            error: error || 'Failed to filter video',
            videoId: youtubeId,
          });
        }
        // Resume video since we can't filter
        if (this.videoWasPlaying) {
          const video = this.getVideoElement();
          if (video) {
            video.play();
            log('Video resumed after error');
          }
          this.videoWasPlaying = false;
        }
        this.isProcessing = false;
        this.filteringVideoId = null;
        return;
      }

      if ((status === 'cached' || status === 'completed') && transcript) {
        // Transcript was cached (locally or on server), skip to processing
        log('Using cached transcript');
        this.updateButtonState({ state: 'processing', text: 'Processing...', videoId: youtubeId });
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
        videoId: youtubeId,
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
      this.filteringVideoId = null;
    }
  }

  // Poll for job status with progress updates
  private async pollJobStatus(jobId: string): Promise<void> {
    const maxAttempts = 180; // 6 minutes max (2s intervals)
    const pollInterval = 2000;
    let attempts = 0;
    // Capture the video ID being filtered at the start
    const videoId = this.filteringVideoId;

    // Initialize smooth progress animator
    this.progressAnimator = new SmoothProgressAnimator(
      (progress, text) => {
        this.updateButtonState({
          state: 'processing',
          text,
          progress,
          videoId: videoId || undefined,
        });
      },
      'Analyzing'
    );
    this.progressAnimator.start();

    while (attempts < maxAttempts) {
      try {
        const response = await safeSendMessage<{
          success: boolean;
          error?: string;
          data?: { status: string; progress: number; transcript?: Transcript; error?: string; error_code?: string };
        }>({
          type: 'CHECK_JOB',
          payload: { jobId },
        });

        // Handle extension context invalidated
        if (!response) {
          this.progressAnimator?.stop();
          this.progressAnimator = null;
          this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId: videoId || undefined });
          this.resumeVideoIfNeeded();
          return;
        }

        if (!response.success) {
          throw new Error(response.error || 'Failed to check job status');
        }

        if (!response.data) {
          throw new Error('No job status data received');
        }

        const { status, progress, transcript, error, error_code } = response.data;

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
            // Check for specific error codes that need special handling
            if (error_code === 'AGE_RESTRICTED') {
              // Stop animator
              if (this.progressAnimator) {
                this.progressAnimator.stop();
                this.progressAnimator = null;
              }
              // Show age-restricted state with helpful message
              this.updateButtonState({
                state: 'age-restricted',
                text: 'Age-Restricted',
                error: error || 'This video is age-restricted by YouTube. SafePlay cannot filter age-restricted content.',
                videoId: videoId || undefined,
              });
              this.isProcessing = false;
              this.filteringVideoId = null;
              // Resume video since we can't filter
              if (this.videoWasPlaying) {
                const video = this.getVideoElement();
                if (video) {
                  video.play();
                  log('Video resumed after age-restricted detection');
                }
                this.videoWasPlaying = false;
              }
              return;
            }
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
          videoId: videoId || undefined,
        });
        this.isProcessing = false;
        this.filteringVideoId = null;
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
      videoId: videoId || undefined,
    });
    this.isProcessing = false;
    this.filteringVideoId = null;
  }

  // Apply the filter using the transcript
  private async applyFilter(transcript: Transcript): Promise<void> {
    if (!this.videoController) {
      throw new Error('Video controller not initialized');
    }

    // Use filteringVideoId which tracks the video being filtered
    const videoId = this.filteringVideoId || this.currentVideoId;
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
        videoId,
      });

      log(`Filter applied successfully. ${intervalCount} profanity instances will be muted.`);

      // Store this video as filtered for auto-enable feature
      if (videoId) {
        await addFilteredVideo(videoId);
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
      this.filteringVideoId = null;
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

    // Notify popup of state change (if extension context still valid)
    if (!isExtensionContextValid()) {
      log('Extension context invalidated, skipping state change notification');
      return;
    }

    chrome.runtime.sendMessage({
      type: 'VIDEO_STATE_CHANGED',
      payload: state,
    }).catch(() => {
      // Popup might not be open or extension context invalidated
    });
  }

  private setupMessageListener(): void {
    // Check if extension context is still valid before setting up listener
    if (!isExtensionContextValid()) {
      log('Extension context invalidated, skipping message listener setup');
      return;
    }

    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        this.handleMessage(message).then(sendResponse);
        return true; // Keep channel open for async response
      });
    } catch (error) {
      log('Failed to setup message listener (extension context may be invalidated):', error);
    }
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

    // Update video ID if on watch page or Shorts page
    if (this.isWatchPage() || this.isShortsPage()) {
      this.currentVideoId = this.getVideoIdFromUrl();

      // Check for auto-enable after a short delay (allow button to inject first)
      if (this.currentVideoId) {
        setTimeout(() => this.checkAutoEnable(), 500);
      }
    }
  }

  // Check if we should auto-enable filter for this video
  private async checkAutoEnable(): Promise<void> {
    if (!this.currentVideoId) return;
    if (this.preferences.autoEnableForFilteredVideos === false) return;
    if (this.isProcessing) return;

    try {
      const wasFiltered = await isVideoFiltered(this.currentVideoId);
      if (wasFiltered) {
        log(`Auto-enabling filter for previously filtered video: ${this.currentVideoId}`);
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
