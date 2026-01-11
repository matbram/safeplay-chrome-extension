// SafePlay Content Script - Main Entry Point
import { ResilientInjector } from './resilient-injector';
import { VideoController } from './video-controller';
import { UserPreferences, DEFAULT_PREFERENCES } from '../types';
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

  constructor() {
    // Initialize resilient injector
    this.injector = new ResilientInjector({
      onButtonClick: (youtubeId, container) => this.onFilterButtonClick(youtubeId, container),
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

    // Start injector for thumbnail buttons
    this.injector.start();

    // Check if we're on a watch page
    if (this.isWatchPage()) {
      await this.handleWatchPage();
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

  private async handleWatchPage(): Promise<void> {
    const videoId = this.getVideoIdFromUrl();
    if (!videoId) return;

    // Don't re-initialize for same video
    if (videoId === this.currentVideoId) return;

    this.currentVideoId = videoId;
    log('Watch page detected, video ID:', videoId);

    // Create player controls
    this.injectPlayerControls();

    // Auto-filter if enabled
    if (this.preferences.enabled) {
      await this.startFiltering(videoId);
    }
  }

  private async startFiltering(videoId: string): Promise<void> {
    if (!this.videoController) return;

    await this.videoController.initialize(videoId, this.preferences);
    await this.videoController.applyFilter();
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
    button.className = 'ytp-button safeplay-player-controls';
    button.title = 'SafePlay Filter';
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
      </svg>
    `;

    button.addEventListener('click', () => this.toggleFilter());

    // Insert before settings button
    const settingsButton = container.querySelector('.ytp-settings-button');
    if (settingsButton) {
      container.insertBefore(button, settingsButton);
    } else {
      container.appendChild(button);
    }

    this.updatePlayerButtonState();
  }

  private updatePlayerButtonState(): void {
    const button = document.querySelector('.safeplay-player-controls');
    if (!button) return;

    const state = this.videoController?.getState();
    const isActive = state?.status === 'active';

    button.classList.toggle('safeplay-active', isActive);
    button.setAttribute('title', isActive ? 'SafePlay Active' : 'SafePlay Inactive');
  }

  private async toggleFilter(): Promise<void> {
    if (!this.videoController) return;

    const state = this.videoController.getState();

    if (state.status === 'active') {
      this.videoController.stop();
    } else if (this.currentVideoId) {
      await this.startFiltering(this.currentVideoId);
    }

    this.updatePlayerButtonState();
  }

  private onFilterButtonClick(youtubeId: string, container: HTMLElement): void {
    log('Filter button clicked for:', youtubeId);

    // Update button to show loading state
    const button = container.querySelector('.safeplay-filter-btn');
    if (button) {
      button.classList.add('safeplay-loading');
    }

    // Navigate to the video with filter enabled
    // For now, just navigate - filtering will auto-start on watch page
    window.location.href = `https://www.youtube.com/watch?v=${youtubeId}`;
  }

  private onVideoStateChange(state: ReturnType<VideoController['getState']>): void {
    log('Video state changed:', state);
    this.updatePlayerButtonState();

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

      case 'TRANSCRIPT_RECEIVED': {
        const transcript = message.payload as { transcript: unknown };
        this.videoController?.onTranscriptReceived(transcript.transcript as import('../types').Transcript);
        return { success: true };
      }

      case 'PROCESSING_PROGRESS': {
        const progress = (message.payload as { progress: number }).progress;
        this.videoController?.onProcessingProgress(progress);
        return { success: true };
      }

      case 'PROCESSING_ERROR': {
        const error = (message.payload as { error: string }).error;
        this.videoController?.onProcessingError(error);
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

    // Re-inject buttons
    setTimeout(() => {
      this.injector.injectButtons();
    }, 500);

    // Check if on watch page
    if (this.isWatchPage()) {
      setTimeout(() => {
        this.handleWatchPage();
      }, 1000);
    } else {
      this.currentVideoId = null;
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
