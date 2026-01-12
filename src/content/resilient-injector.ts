// SafePlay Video Page Button Injector
// Injects the SafePlay button next to the Subscribe button on YouTube watch pages

export interface InjectorOptions {
  onButtonClick: (youtubeId: string) => void;
  debug?: boolean;
}

const PROCESSED_ATTR = 'data-safeplay-processed';
const BUTTON_CONTAINER_CLASS = 'safeplay-video-page-button-container';

export class ResilientInjector {
  private options: InjectorOptions;
  private observer: MutationObserver | null = null;
  private currentVideoId: string | null = null;
  private injectionAttempts = 0;
  private maxAttempts = 50;
  private retryInterval: number | null = null;

  constructor(options: InjectorOptions) {
    this.options = options;
  }

  // Start observing and injecting
  start(): void {
    this.log('Starting video page injector');

    // Only run on watch pages
    if (!this.isWatchPage()) {
      this.log('Not a watch page, waiting for navigation');
    }

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

      // Retry with exponential backoff
      if (this.injectionAttempts < this.maxAttempts && this.retryInterval === null) {
        this.retryInterval = window.setInterval(() => {
          this.attemptInjection();
        }, 200);
      }
    }
  }

  private findSubscribeButton(): HTMLElement | null {
    // Primary selector: the subscribe button container in watch metadata
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

    // Create button container
    const container = document.createElement('div');
    container.className = `${BUTTON_CONTAINER_CLASS} style-scope ytd-watch-metadata`;
    container.style.cssText = 'display: inline-block; margin-left: 8px;';
    container.setAttribute(PROCESSED_ATTR, 'true');

    // Create the button matching YouTube's style
    const button = document.createElement('button');
    button.className = 'yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono yt-spec-button-shape-next--size-m yt-spec-button-shape-next--icon-leading yt-spec-button-shape-next--enable-backdrop-filter-experiment';
    button.title = 'Filter profanity with SafePlay';
    button.setAttribute('aria-label', 'SafePlay Filter');
    button.style.cssText = `
      border: 1px solid var(--yt-spec-outline);
      background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
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
      min-width: 110px;
      box-shadow: 0 1px 3px rgba(76, 175, 80, 0.3);
    `;

    // Add icon
    const iconWrapper = document.createElement('div');
    iconWrapper.style.cssText = 'display: inline-block; width: 20px; height: 20px; vertical-align: middle; flex-shrink: 0;';
    iconWrapper.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
      </svg>
    `;

    // Add text
    const textSpan = document.createElement('span');
    textSpan.style.cssText = 'color: currentColor; font-size: 14px; font-weight: 500; line-height: 1;';
    textSpan.textContent = 'SafePlay';

    button.appendChild(iconWrapper);
    button.appendChild(textSpan);

    // Add hover effects
    button.addEventListener('mouseenter', () => {
      button.style.background = 'linear-gradient(135deg, #45a049 0%, #3d8b40 100%)';
      button.style.boxShadow = '0 2px 6px rgba(76, 175, 80, 0.4)';
      button.style.transform = 'translateY(-1px)';
    });

    button.addEventListener('mouseleave', () => {
      button.style.background = 'linear-gradient(135deg, #4CAF50 0%, #45a049 100%)';
      button.style.boxShadow = '0 1px 3px rgba(76, 175, 80, 0.3)';
      button.style.transform = 'translateY(0)';
    });

    // Add click handler
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.options.onButtonClick(videoId);
    });

    container.appendChild(button);

    // Insert after subscribe button
    subscribeButton.parentElement?.insertBefore(container, subscribeButton.nextSibling);

    this.log(`Injected SafePlay button for video: ${videoId}`);
  }

  // Update button state (loading, active, error)
  updateButtonState(state: 'idle' | 'loading' | 'active' | 'error', message?: string): void {
    const container = document.querySelector(`.${BUTTON_CONTAINER_CLASS}`);
    if (!container) return;

    const button = container.querySelector('button');
    const textSpan = container.querySelector('span');
    if (!button || !textSpan) return;

    switch (state) {
      case 'loading':
        button.style.background = 'linear-gradient(135deg, #888 0%, #666 100%)';
        button.style.cursor = 'wait';
        textSpan.textContent = message || 'Loading...';
        break;

      case 'active':
        button.style.background = 'linear-gradient(135deg, #2196F3 0%, #1976D2 100%)';
        button.style.boxShadow = '0 1px 3px rgba(33, 150, 243, 0.3)';
        button.style.cursor = 'pointer';
        textSpan.textContent = message || 'Filtering';
        break;

      case 'error':
        button.style.background = 'linear-gradient(135deg, #f44336 0%, #d32f2f 100%)';
        button.style.boxShadow = '0 1px 3px rgba(244, 67, 54, 0.3)';
        button.style.cursor = 'pointer';
        textSpan.textContent = message || 'Error';
        break;

      case 'idle':
      default:
        button.style.background = 'linear-gradient(135deg, #4CAF50 0%, #45a049 100%)';
        button.style.boxShadow = '0 1px 3px rgba(76, 175, 80, 0.3)';
        button.style.cursor = 'pointer';
        textSpan.textContent = 'SafePlay';
        break;
    }
  }

  // Set up mutation observer for dynamic content changes
  private setupMutationObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      // Check if we need to re-inject (e.g., after YouTube updates the page)
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          // Check if subscribe button area was modified
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
    // YouTube uses History API for navigation
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

    // YouTube's custom navigation event
    document.addEventListener('yt-navigate-finish', () => {
      this.onNavigation();
    });

    // Also handle yt-page-data-updated for video changes within watch page
    document.addEventListener('yt-page-data-updated', () => {
      this.log('Page data updated');
      this.onNavigation();
    });
  }

  private onNavigation(): void {
    this.log('Navigation detected');
    this.currentVideoId = null;
    this.injectionAttempts = 0;

    if (this.retryInterval !== null) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }

    // Wait for DOM to update
    setTimeout(() => {
      this.attemptInjection();
    }, 300);
  }

  // Debug logging
  private log(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[SafePlay Injector]', ...args);
    }
  }
}
