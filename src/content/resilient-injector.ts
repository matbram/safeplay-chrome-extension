// SafePlay Video Page Button Injector
// Injects the SafePlay button next to the Subscribe button on YouTube watch pages

import { ButtonState, ButtonStateInfo } from '../types';

export interface InjectorOptions {
  onButtonClick: (youtubeId: string) => void;
  debug?: boolean;
}

const PROCESSED_ATTR = 'data-safeplay-processed';
const BUTTON_CONTAINER_CLASS = 'safeplay-video-page-button-container';

// Button state configurations with colors and text
const BUTTON_STATES: Record<ButtonState, { bg: string; hoverBg: string; text: string; shadow: string }> = {
  idle: {
    bg: 'linear-gradient(135deg, #4CAF50 0%, #45a049 100%)',
    hoverBg: 'linear-gradient(135deg, #45a049 0%, #3d8b40 100%)',
    text: 'SafePlay',
    shadow: 'rgba(76, 175, 80, 0.3)',
  },
  connecting: {
    bg: 'linear-gradient(135deg, #607D8B 0%, #546E7A 100%)',
    hoverBg: 'linear-gradient(135deg, #546E7A 0%, #455A64 100%)',
    text: 'Connecting...',
    shadow: 'rgba(96, 125, 139, 0.3)',
  },
  downloading: {
    bg: 'linear-gradient(135deg, #7E57C2 0%, #673AB7 100%)',
    hoverBg: 'linear-gradient(135deg, #673AB7 0%, #5E35B1 100%)',
    text: 'Analyzing...',
    shadow: 'rgba(126, 87, 194, 0.3)',
  },
  transcribing: {
    bg: 'linear-gradient(135deg, #7E57C2 0%, #673AB7 100%)',
    hoverBg: 'linear-gradient(135deg, #673AB7 0%, #5E35B1 100%)',
    text: 'Analyzing...',
    shadow: 'rgba(126, 87, 194, 0.3)',
  },
  processing: {
    bg: 'linear-gradient(135deg, #7E57C2 0%, #673AB7 100%)',
    hoverBg: 'linear-gradient(135deg, #673AB7 0%, #5E35B1 100%)',
    text: 'Analyzing...',
    shadow: 'rgba(126, 87, 194, 0.3)',
  },
  filtering: {
    bg: 'linear-gradient(135deg, #26A69A 0%, #00897B 100%)',
    hoverBg: 'linear-gradient(135deg, #00897B 0%, #00796B 100%)',
    text: 'Active',
    shadow: 'rgba(38, 166, 154, 0.3)',
  },
  error: {
    bg: 'linear-gradient(135deg, #EF5350 0%, #E53935 100%)',
    hoverBg: 'linear-gradient(135deg, #E53935 0%, #D32F2F 100%)',
    text: 'Retry',
    shadow: 'rgba(239, 83, 80, 0.3)',
  },
};

export class ResilientInjector {
  private options: InjectorOptions;
  private observer: MutationObserver | null = null;
  private currentVideoId: string | null = null;
  private injectionAttempts = 0;
  private maxAttempts = 50;
  private retryInterval: number | null = null;
  private currentState: ButtonState = 'idle';

  constructor(options: InjectorOptions) {
    this.options = options;
  }

  // Start observing and injecting
  start(): void {
    this.log('Starting video page injector');

    // Initial injection attempt
    this.attemptInjection();

    // Set up mutation observer for SPA navigation
    this.setupMutationObserver();

    // Listen for YouTube SPA navigation
    this.setupNavigationListener();
  }

  // Stop observing
  stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.retryInterval !== null) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }

    this.log('Stopped video page injector');
  }

  private isWatchPage(): boolean {
    return window.location.pathname === '/watch' &&
           window.location.search.includes('v=');
  }

  private getVideoId(): string | null {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v');
  }

  // Main injection function
  private attemptInjection(): void {
    if (!this.isWatchPage()) {
      return;
    }

    const videoId = this.getVideoId();
    if (!videoId) {
      this.log('No video ID found');
      return;
    }

    // Check if already injected for this video
    if (this.currentVideoId === videoId && this.isButtonPresent()) {
      this.log('Button already present for this video');
      return;
    }

    // Try to find the subscribe button container
    const subscribeButton = this.findSubscribeButton();

    if (subscribeButton) {
      this.injectButton(subscribeButton, videoId);
      this.currentVideoId = videoId;
      this.injectionAttempts = 0;
      if (this.retryInterval !== null) {
        clearInterval(this.retryInterval);
        this.retryInterval = null;
      }
    } else {
      this.injectionAttempts++;
      this.log(`Subscribe button not found, attempt ${this.injectionAttempts}/${this.maxAttempts}`);

      // Retry with interval
      if (this.injectionAttempts < this.maxAttempts && this.retryInterval === null) {
        this.retryInterval = window.setInterval(() => {
          this.attemptInjection();
        }, 200);
      }
    }
  }

  private findSubscribeButton(): HTMLElement | null {
    const selectors = [
      '#subscribe-button.ytd-watch-metadata',
      'ytd-watch-metadata #subscribe-button',
      '#owner #subscribe-button',
      '#subscribe-button',
    ];

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) {
        this.log(`Found subscribe button with selector: ${selector}`);
        return element;
      }
    }

    return null;
  }

  private isButtonPresent(): boolean {
    return document.querySelector(`.${BUTTON_CONTAINER_CLASS}`) !== null;
  }

  private injectButton(subscribeButton: HTMLElement, videoId: string): void {
    // Remove any existing SafePlay button
    const existingButton = document.querySelector(`.${BUTTON_CONTAINER_CLASS}`);
    if (existingButton) {
      existingButton.remove();
    }

    // Reset state for new video
    this.currentState = 'idle';

    // Create button container
    const container = document.createElement('div');
    container.className = `${BUTTON_CONTAINER_CLASS} style-scope ytd-watch-metadata`;
    container.style.cssText = 'display: inline-flex; align-items: center; margin-left: 8px;';
    container.setAttribute(PROCESSED_ATTR, 'true');

    // Create the button matching YouTube's style
    const button = document.createElement('button');
    button.className = 'safeplay-main-button yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono yt-spec-button-shape-next--size-m yt-spec-button-shape-next--icon-leading';
    button.title = 'Filter profanity with SafePlay';
    button.setAttribute('aria-label', 'SafePlay Filter');
    button.setAttribute('data-video-id', videoId);

    const stateConfig = BUTTON_STATES.idle;
    button.style.cssText = `
      border: none;
      background: ${stateConfig.bg};
      color: #ffffff;
      border-radius: 18px;
      padding: 0 16px;
      height: 36px;
      font-family: "Roboto", "Arial", sans-serif;
      font-size: 14px;
      font-weight: 500;
      line-height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      min-width: 120px;
      box-shadow: 0 2px 4px ${stateConfig.shadow};
      position: relative;
      overflow: hidden;
    `;

    // Create progress bar (hidden initially)
    const progressBar = document.createElement('div');
    progressBar.className = 'safeplay-progress-bar';
    progressBar.style.cssText = `
      position: absolute;
      bottom: 0;
      left: 0;
      height: 3px;
      width: 0%;
      background: rgba(255, 255, 255, 0.5);
      transition: width 0.3s ease;
      border-radius: 0 0 18px 18px;
    `;

    // Add icon
    const iconWrapper = document.createElement('div');
    iconWrapper.className = 'safeplay-icon';
    iconWrapper.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex-shrink: 0;';
    iconWrapper.innerHTML = this.getIconSVG('idle');

    // Add text
    const textSpan = document.createElement('span');
    textSpan.className = 'safeplay-text';
    textSpan.style.cssText = 'color: currentColor; font-size: 14px; font-weight: 500; line-height: 1; white-space: nowrap;';
    textSpan.textContent = stateConfig.text;

    button.appendChild(iconWrapper);
    button.appendChild(textSpan);
    button.appendChild(progressBar);

    // Add hover effects
    button.addEventListener('mouseenter', () => {
      const config = BUTTON_STATES[this.currentState];
      button.style.background = config.hoverBg;
      button.style.boxShadow = `0 4px 8px ${config.shadow}`;
      button.style.transform = 'translateY(-1px)';
    });

    button.addEventListener('mouseleave', () => {
      const config = BUTTON_STATES[this.currentState];
      button.style.background = config.bg;
      button.style.boxShadow = `0 2px 4px ${config.shadow}`;
      button.style.transform = 'translateY(0)';
    });

    // Add click handler
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Only allow click in idle or error state
      if (this.currentState === 'idle' || this.currentState === 'error') {
        this.options.onButtonClick(videoId);
      }
    });

    container.appendChild(button);

    // Insert after subscribe button
    subscribeButton.parentElement?.insertBefore(container, subscribeButton.nextSibling);

    this.log(`Injected SafePlay button for video: ${videoId}`);
  }

  private getIconSVG(state: ButtonState): string {
    switch (state) {
      case 'connecting':
      case 'downloading':
      case 'transcribing':
      case 'processing':
        // Spinning loader icon
        return `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="safeplay-spinner">
            <style>.safeplay-spinner { animation: safeplay-spin 1s linear infinite; } @keyframes safeplay-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }</style>
            <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
            <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/>
          </svg>
        `;
      case 'filtering':
        // Active shield icon
        return `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
          </svg>
        `;
      case 'error':
        // Error icon
        return `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
        `;
      default:
        // Default checkmark icon
        return `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
          </svg>
        `;
    }
  }

  // Update button state with detailed info
  updateButtonState(stateInfo: ButtonStateInfo): void {
    const container = document.querySelector(`.${BUTTON_CONTAINER_CLASS}`);
    if (!container) return;

    const button = container.querySelector<HTMLButtonElement>('.safeplay-main-button');
    const textSpan = container.querySelector<HTMLSpanElement>('.safeplay-text');
    const iconWrapper = container.querySelector<HTMLDivElement>('.safeplay-icon');
    const progressBar = container.querySelector<HTMLDivElement>('.safeplay-progress-bar');

    if (!button || !textSpan || !iconWrapper) return;

    this.currentState = stateInfo.state;
    const config = BUTTON_STATES[stateInfo.state];

    // Update colors
    button.style.background = config.bg;
    button.style.boxShadow = `0 2px 4px ${config.shadow}`;

    // Update icon
    iconWrapper.innerHTML = this.getIconSVG(stateInfo.state);

    // Update text
    let displayText = stateInfo.text || config.text;

    // Add progress percentage for processing states
    if (stateInfo.progress !== undefined && stateInfo.progress > 0) {
      if (stateInfo.state === 'downloading' || stateInfo.state === 'transcribing' || stateInfo.state === 'processing') {
        displayText = `${config.text.replace('...', '')} ${Math.round(stateInfo.progress)}%`;
      }
    }

    // Add interval count for filtering state
    if (stateInfo.state === 'filtering' && stateInfo.intervalCount !== undefined) {
      displayText = `Filtering (${stateInfo.intervalCount})`;
    }

    textSpan.textContent = displayText;

    // Update progress bar
    if (progressBar) {
      if (stateInfo.progress !== undefined && stateInfo.progress > 0 && stateInfo.progress < 100) {
        progressBar.style.width = `${stateInfo.progress}%`;
        progressBar.style.display = 'block';
      } else {
        progressBar.style.width = '0%';
        progressBar.style.display = 'none';
      }
    }

    // Update cursor
    if (stateInfo.state === 'idle' || stateInfo.state === 'error') {
      button.style.cursor = 'pointer';
    } else {
      button.style.cursor = 'default';
    }

    // Update title/tooltip
    switch (stateInfo.state) {
      case 'connecting':
        button.title = 'Connecting to SafePlay service...';
        break;
      case 'downloading':
        button.title = `Downloading video audio${stateInfo.progress ? ` (${Math.round(stateInfo.progress)}%)` : '...'}`;
        break;
      case 'transcribing':
        button.title = `Transcribing audio${stateInfo.progress ? ` (${Math.round(stateInfo.progress)}%)` : '...'}`;
        break;
      case 'processing':
        button.title = 'Processing transcript...';
        break;
      case 'filtering':
        button.title = `Filtering profanity${stateInfo.intervalCount ? ` - ${stateInfo.intervalCount} instances found` : ''}`;
        break;
      case 'error':
        button.title = stateInfo.error || 'An error occurred. Click to retry.';
        break;
      default:
        button.title = 'Click to filter profanity with SafePlay';
    }

    this.log(`Button state updated to: ${stateInfo.state}`, stateInfo);
  }

  // Convenience method for simple state updates
  setButtonState(state: ButtonState, text?: string, progress?: number): void {
    this.updateButtonState({ state, text: text || '', progress });
  }

  // Set up mutation observer for dynamic content changes
  private setupMutationObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node instanceof HTMLElement) {
              if (node.id === 'subscribe-button' ||
                  node.querySelector?.('#subscribe-button') ||
                  node.closest?.('ytd-watch-metadata')) {
                this.log('Subscribe button area changed, re-injecting');
                this.attemptInjection();
                return;
              }
            }
          }
        }
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // Listen for YouTube SPA navigation
  private setupNavigationListener(): void {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = (...args) => {
      originalPushState.apply(history, args);
      this.onNavigation();
    };

    history.replaceState = (...args) => {
      originalReplaceState.apply(history, args);
      this.onNavigation();
    };

    window.addEventListener('popstate', () => {
      this.onNavigation();
    });

    document.addEventListener('yt-navigate-finish', () => {
      this.onNavigation();
    });

    document.addEventListener('yt-page-data-updated', () => {
      this.log('Page data updated');
      this.onNavigation();
    });
  }

  private onNavigation(): void {
    this.log('Navigation detected');
    this.currentVideoId = null;
    this.currentState = 'idle';
    this.injectionAttempts = 0;

    if (this.retryInterval !== null) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }

    setTimeout(() => {
      this.attemptInjection();
    }, 300);
  }

  // Get current video ID
  getCurrentVideoId(): string | null {
    return this.currentVideoId;
  }

  // Debug logging
  private log(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[SafePlay Injector]', ...args);
    }
  }
}
