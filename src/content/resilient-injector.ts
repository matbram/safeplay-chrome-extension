// SafePlay Video Page Button Injector
// Injects the SafePlay button next to the Subscribe button on YouTube watch pages
// and above the like button on YouTube Shorts

import { ButtonState, ButtonStateInfo } from '../types';

export interface InjectorOptions {
  onButtonClick: (youtubeId: string) => void;
  onToggleFilter?: () => void; // Called when user clicks to toggle filter on/off
  debug?: boolean;
}

const PROCESSED_ATTR = 'data-safeplay-processed';
const BUTTON_CONTAINER_CLASS = 'safeplay-video-page-button-container';
const SHORTS_BUTTON_CLASS = 'safeplay-shorts-button';

// Button state configurations with YouTube theme colors
// Water fill uses blue (#3b82f6) that fills from bottom to top during processing
const BUTTON_STATES: Record<ButtonState, { bg: string; hoverBg: string; text: string; shadow: string; useWater?: boolean }> = {
  idle: {
    bg: '#ff0000', // YouTube red
    hoverBg: '#cc0000',
    text: 'SafePlay',
    shadow: 'rgba(255, 0, 0, 0.3)',
  },
  connecting: {
    bg: '#3f3f3f', // YouTube dark gray
    hoverBg: '#4f4f4f',
    text: 'Connecting...',
    shadow: 'rgba(63, 63, 63, 0.3)',
  },
  downloading: {
    bg: '#212121', // Dark background for water contrast
    hoverBg: '#2a2a2a',
    text: 'Filtering...',
    shadow: 'rgba(59, 130, 246, 0.4)',
    useWater: true,
  },
  transcribing: {
    bg: '#212121', // Dark background for water contrast
    hoverBg: '#2a2a2a',
    text: 'Filtering...',
    shadow: 'rgba(59, 130, 246, 0.4)',
    useWater: true,
  },
  processing: {
    bg: '#212121', // Dark background for water contrast
    hoverBg: '#2a2a2a',
    text: 'Filtering...',
    shadow: 'rgba(59, 130, 246, 0.4)',
    useWater: true,
  },
  filtering: {
    bg: '#3b82f6', // Blue - fully filled with water
    hoverBg: '#2563eb',
    text: 'Censored',
    shadow: 'rgba(59, 130, 246, 0.4)',
  },
  paused: {
    bg: '#6b7280', // Gray - paused state
    hoverBg: '#4b5563',
    text: 'Paused',
    shadow: 'rgba(107, 114, 128, 0.4)',
  },
  error: {
    bg: '#ff4e45', // YouTube error red-orange
    hoverBg: '#e63e35',
    text: 'Retry',
    shadow: 'rgba(255, 78, 69, 0.4)',
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
  // Track Shorts button states by video ID
  private shortsButtonStates: Map<string, ButtonState> = new Map();
  private shortsScrollObserver: IntersectionObserver | null = null;

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

    // Set up Shorts scroll observer
    this.setupShortsScrollObserver();
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

    if (this.shortsScrollObserver) {
      this.shortsScrollObserver.disconnect();
      this.shortsScrollObserver = null;
    }

    this.log('Stopped video page injector');
  }

  private isWatchPage(): boolean {
    return window.location.pathname === '/watch' &&
           window.location.search.includes('v=');
  }

  private isShortsPage(): boolean {
    return window.location.pathname.startsWith('/shorts');
  }

  private getVideoId(): string | null {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v');
  }

  private getShortsVideoId(): string | null {
    const match = window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  // Main injection function
  private attemptInjection(): void {
    // Handle Shorts pages
    if (this.isShortsPage()) {
      this.attemptShortsInjection();
      return;
    }

    // Handle regular watch pages
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

  // Attempt injection for YouTube Shorts
  private attemptShortsInjection(): void {
    // Find all Shorts renderers on the page
    const shortsRenderers = document.querySelectorAll('ytd-reel-video-renderer, ytd-shorts');

    shortsRenderers.forEach((renderer) => {
      // Skip if already processed
      if (renderer.getAttribute(PROCESSED_ATTR) === 'true') {
        return;
      }

      // Find the video ID from the renderer
      const videoId = this.getShortsVideoIdFromRenderer(renderer);
      if (!videoId) {
        return;
      }

      // Find the action buttons container (like, dislike, comment, share)
      const actionsContainer = this.findShortsActionsContainer(renderer);
      if (!actionsContainer) {
        this.log('Shorts actions container not found for', videoId);
        return;
      }

      // Inject the button
      this.injectShortsButton(actionsContainer, videoId, renderer);
      renderer.setAttribute(PROCESSED_ATTR, 'true');
    });

    // Also try to inject into the currently visible Short
    this.injectIntoVisibleShort();
  }

  // Get video ID from a Shorts renderer element
  private getShortsVideoIdFromRenderer(renderer: Element): string | null {
    // Try to get from URL/link in the renderer
    const link = renderer.querySelector('a[href*="/shorts/"]');
    if (link) {
      const href = link.getAttribute('href');
      const match = href?.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
      if (match) return match[1];
    }

    // Try to extract from video source
    const videoElement = renderer.querySelector('video');
    if (videoElement) {
      const src = videoElement.src || videoElement.currentSrc;
      if (src) {
        const match = src.match(/\/([a-zA-Z0-9_-]{11})\//);
        if (match) return match[1];
      }
    }

    // DO NOT fall back to URL - it may have stale video ID when scrolling
    // Only injectIntoVisibleShort should use the URL
    return null;
  }

  // Find the actions container in Shorts (like button, dislike, etc.)
  private findShortsActionsContainer(renderer: Element): HTMLElement | null {
    // Shorts uses different selectors - try multiple
    const selectors = [
      '#actions', // Main actions container
      'ytd-reel-player-overlay-renderer #actions',
      '#like-button', // Fall back to like button itself
      '[id="like-button"]',
      'ytd-like-button-renderer',
    ];

    for (const selector of selectors) {
      const element = renderer.querySelector<HTMLElement>(selector);
      if (element) {
        this.log(`Found Shorts actions with selector: ${selector}`);
        return element;
      }
    }

    // Also try document-level for the currently playing Short
    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(`ytd-shorts ${selector}, ytd-reel-video-renderer ${selector}`);
      if (element) {
        this.log(`Found Shorts actions at document level: ${selector}`);
        return element;
      }
    }

    return null;
  }

  // Inject into the currently visible/active Short
  private injectIntoVisibleShort(): void {
    const videoId = this.getShortsVideoId();
    if (!videoId) return;

    // Check if already injected for this video
    const existingButton = document.querySelector(`.${SHORTS_BUTTON_CLASS}[data-video-id="${videoId}"]`);
    if (existingButton) return;

    // Find the actions container for the current Short
    const actionsContainer = document.querySelector<HTMLElement>(
      'ytd-shorts #actions, ytd-reel-video-renderer[is-active] #actions, #shorts-player #actions'
    );

    if (actionsContainer && !actionsContainer.querySelector(`.${SHORTS_BUTTON_CLASS}`)) {
      const renderer = actionsContainer.closest('ytd-reel-video-renderer, ytd-shorts') || document.body;
      this.injectShortsButton(actionsContainer, videoId, renderer);
    }
  }

  // Inject SafePlay button into Shorts UI
  private injectShortsButton(actionsContainer: HTMLElement, videoId: string, renderer: Element): void {
    // Remove any existing button for this video
    const existingButton = renderer.querySelector(`.${SHORTS_BUTTON_CLASS}[data-video-id="${videoId}"]`);
    if (existingButton) {
      existingButton.remove();
    }

    // Initialize state for this video
    if (!this.shortsButtonStates.has(videoId)) {
      this.shortsButtonStates.set(videoId, 'idle');
    }

    // Create button container matching Shorts style
    const container = document.createElement('div');
    container.className = `${SHORTS_BUTTON_CLASS}`;
    container.setAttribute('data-video-id', videoId);
    container.style.cssText = `
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-bottom: 16px;
      cursor: pointer;
    `;

    // Create circular button (matching YouTube Shorts action buttons)
    const button = document.createElement('button');
    button.className = 'safeplay-shorts-action-button';
    const state = this.shortsButtonStates.get(videoId) || 'idle';
    const stateConfig = BUTTON_STATES[state];

    button.style.cssText = `
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      background: ${stateConfig.bg};
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      position: relative;
      overflow: hidden;
    `;

    // Add icon
    const iconWrapper = document.createElement('div');
    iconWrapper.className = 'safeplay-shorts-icon';
    iconWrapper.style.cssText = 'display: flex; align-items: center; justify-content: center; position: relative; z-index: 1;';
    iconWrapper.innerHTML = this.getShortsIconSVG(state);
    button.appendChild(iconWrapper);

    // Add label below button
    const label = document.createElement('span');
    label.className = 'safeplay-shorts-label';
    label.style.cssText = `
      color: white;
      font-size: 12px;
      margin-top: 4px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.5);
      font-family: "Roboto", "Arial", sans-serif;
    `;
    label.textContent = state === 'filtering' ? 'Censored' : (state === 'idle' ? 'SafePlay' : stateConfig.text);

    // Add hover effects
    button.addEventListener('mouseenter', () => {
      const currentState = this.shortsButtonStates.get(videoId) || 'idle';
      const config = BUTTON_STATES[currentState];
      button.style.background = config.hoverBg;
      button.style.transform = 'scale(1.1)';
    });

    button.addEventListener('mouseleave', () => {
      const currentState = this.shortsButtonStates.get(videoId) || 'idle';
      const config = BUTTON_STATES[currentState];
      button.style.background = config.bg;
      button.style.transform = 'scale(1)';
    });

    // Add click handler
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const currentState = this.shortsButtonStates.get(videoId) || 'idle';

      if (currentState === 'idle' || currentState === 'error') {
        this.currentVideoId = videoId;
        this.options.onButtonClick(videoId);
      } else if (currentState === 'filtering' || currentState === 'paused') {
        this.currentVideoId = videoId;
        if (this.options.onToggleFilter) {
          this.options.onToggleFilter();
        }
      }
    });

    container.appendChild(button);
    container.appendChild(label);

    // Insert at the top of the actions container (above like button)
    actionsContainer.insertBefore(container, actionsContainer.firstChild);

    this.log(`Injected SafePlay Shorts button for video: ${videoId}`);
  }

  // Get icon SVG for Shorts buttons (smaller, simpler icons)
  private getShortsIconSVG(state: ButtonState): string {
    switch (state) {
      case 'connecting':
      case 'downloading':
      case 'transcribing':
      case 'processing':
        return `
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="safeplay-spinner">
            <style>.safeplay-spinner { animation: safeplay-spin 1s linear infinite; } @keyframes safeplay-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }</style>
            <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
            <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/>
          </svg>
        `;
      case 'filtering':
        return `
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
          </svg>
        `;
      case 'paused':
        return `
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 14H9V9h2v6zm4 0h-2V9h2v6z"/>
          </svg>
        `;
      case 'error':
        return `
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
        `;
      default:
        // Shield icon for idle state
        return `
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
          </svg>
        `;
    }
  }

  // Set up IntersectionObserver for Shorts scroll detection
  private setupShortsScrollObserver(): void {
    if (this.shortsScrollObserver) {
      this.shortsScrollObserver.disconnect();
    }

    this.shortsScrollObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            // A Short has scrolled into view
            const renderer = entry.target;
            const videoId = this.getShortsVideoIdFromRenderer(renderer);

            if (videoId) {
              this.log(`Short scrolled into view: ${videoId}`);
              // Update current video ID
              this.currentVideoId = videoId;
              // Attempt to inject button if not present
              if (!renderer.querySelector(`.${SHORTS_BUTTON_CLASS}`)) {
                this.attemptShortsInjection();
              }
            }
          }
        });
      },
      {
        threshold: 0.5, // Trigger when 50% visible
      }
    );

    // Observe existing Shorts renderers
    this.observeShortsRenderers();
  }

  // Observe Shorts renderers for scroll detection
  private observeShortsRenderers(): void {
    if (!this.shortsScrollObserver) return;

    const renderers = document.querySelectorAll('ytd-reel-video-renderer, ytd-shorts');
    renderers.forEach((renderer) => {
      this.shortsScrollObserver!.observe(renderer);
    });
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

    // Create water fill element (for progress animation)
    const waterFill = document.createElement('div');
    waterFill.className = 'safeplay-water-fill';
    waterFill.style.cssText = `
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 0%;
      background: linear-gradient(to top, #3b82f6, #60a5fa);
      transition: height 0.3s ease-out;
      overflow: hidden;
      border-radius: 18px;
      z-index: 0;
    `;

    // Add icon (z-index to appear above water)
    const iconWrapper = document.createElement('div');
    iconWrapper.className = 'safeplay-icon';
    iconWrapper.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex-shrink: 0; position: relative; z-index: 1;';
    iconWrapper.innerHTML = this.getIconSVG('idle');

    // Add text (z-index to appear above water)
    const textSpan = document.createElement('span');
    textSpan.className = 'safeplay-text';
    textSpan.style.cssText = 'color: currentColor; font-size: 14px; font-weight: 500; line-height: 1; white-space: nowrap; position: relative; z-index: 1;';
    textSpan.textContent = stateConfig.text;

    button.appendChild(waterFill);
    button.appendChild(iconWrapper);
    button.appendChild(textSpan);

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

      // Allow click in idle, error, filtering (censored), or paused state
      if (this.currentState === 'idle' || this.currentState === 'error') {
        this.options.onButtonClick(videoId);
      } else if (this.currentState === 'filtering' || this.currentState === 'paused') {
        // Toggle filter on/off
        if (this.options.onToggleFilter) {
          this.options.onToggleFilter();
        }
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
        // Active shield icon with checkmark
        return `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
          </svg>
        `;
      case 'paused':
        // Paused - shield with pause bars
        return `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 14H9V9h2v6zm4 0h-2V9h2v6z"/>
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
    // Update regular watch page button
    this.updateWatchPageButton(stateInfo);

    // Update Shorts button - use videoId from stateInfo if provided, otherwise currentVideoId
    const targetVideoId = stateInfo.videoId || this.currentVideoId;
    if (targetVideoId) {
      this.updateShortsButton(targetVideoId, stateInfo);
    }
  }

  // Update watch page button
  private updateWatchPageButton(stateInfo: ButtonStateInfo): void {
    const container = document.querySelector(`.${BUTTON_CONTAINER_CLASS}`);
    if (!container) return;

    const button = container.querySelector<HTMLButtonElement>('.safeplay-main-button');
    const textSpan = container.querySelector<HTMLSpanElement>('.safeplay-text');
    const iconWrapper = container.querySelector<HTMLDivElement>('.safeplay-icon');
    const waterFill = container.querySelector<HTMLDivElement>('.safeplay-water-fill');

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

    // Add interval count for filtering state (completed)
    if (stateInfo.state === 'filtering' && stateInfo.intervalCount !== undefined) {
      displayText = `Censored (${stateInfo.intervalCount})`;
    }

    textSpan.textContent = displayText;

    // Update water fill effect
    if (waterFill) {
      if (config.useWater && stateInfo.progress !== undefined && stateInfo.progress > 0) {
        // Show water filling up during processing states
        waterFill.style.height = `${stateInfo.progress}%`;
        waterFill.classList.remove('safeplay-water-full');
      } else if (stateInfo.state === 'filtering') {
        // Fully filled when complete - solid blue
        waterFill.style.height = '100%';
        waterFill.classList.add('safeplay-water-full');
      } else if (stateInfo.state === 'paused') {
        // Paused - drain the water (animate to empty)
        waterFill.style.height = '0%';
        waterFill.classList.remove('safeplay-water-full');
      } else {
        // Reset water for other states
        waterFill.style.height = '0%';
        waterFill.classList.remove('safeplay-water-full');
      }
    }

    // Update cursor - clickable in idle, error, filtering, and paused states
    if (stateInfo.state === 'idle' || stateInfo.state === 'error' ||
        stateInfo.state === 'filtering' || stateInfo.state === 'paused') {
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
        button.title = `Filtering: Downloading audio${stateInfo.progress ? ` (${Math.round(stateInfo.progress)}%)` : '...'}`;
        break;
      case 'transcribing':
        button.title = `Filtering: Transcribing audio${stateInfo.progress ? ` (${Math.round(stateInfo.progress)}%)` : '...'}`;
        break;
      case 'processing':
        button.title = 'Filtering: Processing transcript...';
        break;
      case 'filtering':
        button.title = `Censored${stateInfo.intervalCount ? ` - ${stateInfo.intervalCount} words filtered` : ''} - Click to disable`;
        break;
      case 'paused':
        button.title = 'Filter paused - Click to re-enable';
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

  // Update Shorts button state for a specific video
  private updateShortsButton(videoId: string, stateInfo: ButtonStateInfo): void {
    const container = document.querySelector(`.${SHORTS_BUTTON_CLASS}[data-video-id="${videoId}"]`);
    if (!container) return;

    const button = container.querySelector<HTMLButtonElement>('.safeplay-shorts-action-button');
    const iconWrapper = container.querySelector<HTMLDivElement>('.safeplay-shorts-icon');
    const label = container.querySelector<HTMLSpanElement>('.safeplay-shorts-label');

    if (!button || !iconWrapper) return;

    // Update state tracking
    this.shortsButtonStates.set(videoId, stateInfo.state);
    const config = BUTTON_STATES[stateInfo.state];

    // Update button background
    button.style.background = config.bg;

    // Update icon
    iconWrapper.innerHTML = this.getShortsIconSVG(stateInfo.state);

    // Update label
    if (label) {
      let labelText = stateInfo.state === 'idle' ? 'SafePlay' : config.text;

      if (stateInfo.state === 'filtering' && stateInfo.intervalCount !== undefined) {
        labelText = `${stateInfo.intervalCount}`;
      } else if (stateInfo.state === 'filtering') {
        labelText = 'Censored';
      }

      // Show progress for processing states
      if (stateInfo.progress !== undefined && stateInfo.progress > 0) {
        if (stateInfo.state === 'downloading' || stateInfo.state === 'transcribing' || stateInfo.state === 'processing') {
          labelText = `${Math.round(stateInfo.progress)}%`;
        }
      }

      label.textContent = labelText;
    }

    // Update cursor
    if (stateInfo.state === 'idle' || stateInfo.state === 'error' ||
        stateInfo.state === 'filtering' || stateInfo.state === 'paused') {
      button.style.cursor = 'pointer';
    } else {
      button.style.cursor = 'default';
    }

    this.log(`Shorts button state updated to: ${stateInfo.state} for ${videoId}`);
  }

  // Set up mutation observer for dynamic content changes
  private setupMutationObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node instanceof HTMLElement) {
              // Watch page: detect subscribe button changes
              if (node.id === 'subscribe-button' ||
                  node.querySelector?.('#subscribe-button') ||
                  node.closest?.('ytd-watch-metadata')) {
                this.log('Subscribe button area changed, re-injecting');
                this.attemptInjection();
                return;
              }

              // Shorts: detect new Short renderers being added
              if (node.tagName === 'YTD-REEL-VIDEO-RENDERER' ||
                  node.tagName === 'YTD-SHORTS' ||
                  node.querySelector?.('ytd-reel-video-renderer')) {
                this.log('Shorts renderer added, attempting injection');
                // Add new renderers to the intersection observer
                this.observeShortsRenderers();
                this.attemptShortsInjection();
                return;
              }

              // Shorts: detect actions container being added
              if (node.id === 'actions' || node.querySelector?.('#actions')) {
                if (this.isShortsPage()) {
                  this.log('Shorts actions container added');
                  this.attemptShortsInjection();
                  return;
                }
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

    // Clear processed attribute on Shorts renderers so they can be re-processed
    // This is needed because scrolling in Shorts triggers navigation events
    if (this.isShortsPage()) {
      document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach(el => {
        el.removeAttribute(PROCESSED_ATTR);
      });
      // Remove all existing Shorts buttons - they'll be re-injected with correct state
      document.querySelectorAll(`.${SHORTS_BUTTON_CLASS}`).forEach(el => {
        el.remove();
      });
      // Clear button states for fresh start
      this.shortsButtonStates.clear();
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
