// Resilient YouTube Button Injector for SafePlay
// Based on pattern recognition rather than brittle class selectors

export interface InjectorOptions {
  onButtonClick: (youtubeId: string, container: HTMLElement) => void;
  debug?: boolean;
}

interface DetectedContainer {
  element: HTMLElement;
  youtubeId: string;
  thumbnail: HTMLElement | null;
}

const PROCESSED_ATTR = 'data-safeplay-processed';
const BUTTON_CLASS = 'safeplay-filter-btn';

export class ResilientInjector {
  private options: InjectorOptions;
  private observer: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private debounceTimer: number | null = null;
  private processedContainers = new WeakSet<HTMLElement>();

  constructor(options: InjectorOptions) {
    this.options = options;
  }

  // Start observing and injecting
  start(): void {
    this.log('Starting resilient injector');

    // Initial injection
    this.injectButtons();

    // Set up mutation observer for dynamic content
    this.setupMutationObserver();

    // Set up intersection observer for lazy-loaded content
    this.setupIntersectionObserver();

    // Listen for YouTube SPA navigation
    this.setupNavigationListener();
  }

  // Stop observing
  stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }

    this.log('Stopped resilient injector');
  }

  // Main injection function
  injectButtons(): void {
    const containers = this.detectVideoContainers();
    this.log(`Found ${containers.length} video containers`);

    for (const container of containers) {
      this.injectButton(container);
    }
  }

  // Detect video containers using multiple strategies
  private detectVideoContainers(): DetectedContainer[] {
    const containers: DetectedContainer[] = [];
    const seen = new Set<HTMLElement>();

    // Strategy 1: Find by video link pattern
    const videoLinks = document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/watch?v="], a[href*="/shorts/"]'
    );

    for (const link of videoLinks) {
      const youtubeId = this.extractYoutubeId(link.href);
      if (!youtubeId) continue;

      const container = this.findContainerFromLink(link);
      if (container && !seen.has(container) && !this.isProcessed(container)) {
        seen.add(container);
        containers.push({
          element: container,
          youtubeId,
          thumbnail: this.findThumbnail(container),
        });
      }
    }

    // Strategy 2: Find by thumbnail image pattern
    const thumbnails = document.querySelectorAll<HTMLImageElement>(
      'img[src*="ytimg.com"], img[src*="i.ytimg.com"]'
    );

    for (const img of thumbnails) {
      const container = this.findContainerFromThumbnail(img);
      if (!container || seen.has(container) || this.isProcessed(container)) continue;

      const link = container.querySelector<HTMLAnchorElement>('a[href*="/watch?v="], a[href*="/shorts/"]');
      const youtubeId = link ? this.extractYoutubeId(link.href) : null;
      if (!youtubeId) continue;

      seen.add(container);
      containers.push({
        element: container,
        youtubeId,
        thumbnail: img.closest('[class*="thumbnail"]') as HTMLElement || img.parentElement,
      });
    }

    return containers;
  }

  // Extract YouTube video ID from URL
  private extractYoutubeId(url: string): string | null {
    // Handle /watch?v= format
    const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (watchMatch) return watchMatch[1];

    // Handle /shorts/ format
    const shortsMatch = url.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];

    return null;
  }

  // Find the container element from a video link
  private findContainerFromLink(link: HTMLAnchorElement): HTMLElement | null {
    // Walk up the DOM to find a suitable container
    let element: HTMLElement | null = link;
    let lastValidContainer: HTMLElement | null = null;

    while (element && element !== document.body) {
      // Check for common container patterns
      if (this.looksLikeVideoContainer(element)) {
        lastValidContainer = element;
      }

      // Stop if we've gone too far up
      if (this.isTooHighInDOM(element)) {
        break;
      }

      element = element.parentElement;
    }

    return lastValidContainer;
  }

  // Find container from a thumbnail image
  private findContainerFromThumbnail(img: HTMLImageElement): HTMLElement | null {
    let element: HTMLElement | null = img;
    let lastValidContainer: HTMLElement | null = null;

    while (element && element !== document.body) {
      if (this.looksLikeVideoContainer(element)) {
        lastValidContainer = element;
      }

      if (this.isTooHighInDOM(element)) {
        break;
      }

      element = element.parentElement;
    }

    return lastValidContainer;
  }

  // Check if an element looks like a video container
  private looksLikeVideoContainer(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();

    // Must have reasonable dimensions
    if (rect.width < 100 || rect.height < 80) return false;

    // Check for video-related attributes/classes
    const className = element.className.toLowerCase();
    const tagName = element.tagName.toLowerCase();

    // Common YouTube container patterns
    const containerPatterns = [
      'video', 'item', 'renderer', 'content', 'card', 'tile', 'entry'
    ];

    const hasContainerPattern = containerPatterns.some(
      (pattern) => className.includes(pattern) || tagName.includes(pattern)
    );

    // Must contain both a link and an image
    const hasLink = element.querySelector('a[href*="/watch"], a[href*="/shorts"]') !== null;
    const hasImage = element.querySelector('img[src*="ytimg.com"]') !== null;

    return hasContainerPattern || (hasLink && hasImage);
  }

  // Check if we've gone too high in the DOM tree
  private isTooHighInDOM(element: HTMLElement): boolean {
    const className = element.className.toLowerCase();
    const id = element.id.toLowerCase();

    const stopPatterns = [
      'page', 'content', 'main', 'body', 'app', 'root',
      'feed', 'browse', 'results', 'grid', 'list'
    ];

    return stopPatterns.some(
      (pattern) => className.includes(pattern) || id.includes(pattern)
    );
  }

  // Find thumbnail element within container
  private findThumbnail(container: HTMLElement): HTMLElement | null {
    // Look for thumbnail wrapper
    const thumbnailSelectors = [
      '[class*="thumbnail"]',
      '[id*="thumbnail"]',
      'ytd-thumbnail',
      '.ytd-thumbnail',
    ];

    for (const selector of thumbnailSelectors) {
      const thumb = container.querySelector<HTMLElement>(selector);
      if (thumb) return thumb;
    }

    // Fallback: find the element containing the img
    const img = container.querySelector<HTMLImageElement>('img[src*="ytimg.com"]');
    return img?.parentElement || null;
  }

  // Check if container is already processed
  private isProcessed(container: HTMLElement): boolean {
    return (
      this.processedContainers.has(container) ||
      container.hasAttribute(PROCESSED_ATTR) ||
      container.querySelector(`.${BUTTON_CLASS}`) !== null
    );
  }

  // Inject button into a container
  private injectButton(detected: DetectedContainer): void {
    if (this.isProcessed(detected.element)) return;

    // Mark as processed
    detected.element.setAttribute(PROCESSED_ATTR, 'true');
    this.processedContainers.add(detected.element);

    // Create button
    const button = this.createButton(detected.youtubeId);

    // Find injection point (prefer after thumbnail)
    const injectionPoint = detected.thumbnail || detected.element.firstElementChild;

    if (injectionPoint) {
      injectionPoint.parentElement?.insertBefore(
        button,
        injectionPoint.nextSibling
      );
    } else {
      detected.element.appendChild(button);
    }

    this.log(`Injected button for video: ${detected.youtubeId}`);
  }

  // Create the SafePlay button element
  private createButton(youtubeId: string): HTMLElement {
    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    button.setAttribute('data-youtube-id', youtubeId);
    button.innerHTML = `
      <svg class="safeplay-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
      </svg>
      <span class="safeplay-text">SafePlay</span>
    `;

    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const container = button.closest(`[${PROCESSED_ATTR}]`) as HTMLElement;
      this.options.onButtonClick(youtubeId, container);
    });

    return button;
  }

  // Set up mutation observer for dynamic content
  private setupMutationObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      let shouldInject = false;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node instanceof HTMLElement) {
              // Check if the added node or its children might contain videos
              if (
                node.querySelector?.('a[href*="/watch"], a[href*="/shorts"]') ||
                node.querySelector?.('img[src*="ytimg.com"]')
              ) {
                shouldInject = true;
                break;
              }
            }
          }
        }

        if (shouldInject) break;
      }

      if (shouldInject) {
        this.debouncedInject();
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // Set up intersection observer for lazy loading
  private setupIntersectionObserver(): void {
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        const hasVisibleUnprocessed = entries.some(
          (entry) =>
            entry.isIntersecting &&
            !this.isProcessed(entry.target as HTMLElement)
        );

        if (hasVisibleUnprocessed) {
          this.debouncedInject();
        }
      },
      { rootMargin: '200px' }
    );

    // Observe potential video containers
    const containers = document.querySelectorAll<HTMLElement>(
      'ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer'
    );

    containers.forEach((container) => {
      this.intersectionObserver?.observe(container);
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

    // Also listen for YouTube's custom navigation event
    document.addEventListener('yt-navigate-finish', () => {
      this.onNavigation();
    });
  }

  private onNavigation(): void {
    this.log('Navigation detected, re-injecting buttons');
    // Wait for DOM to update
    setTimeout(() => this.injectButtons(), 500);
  }

  // Debounced injection to prevent excessive processing
  private debouncedInject(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.injectButtons();
      this.debounceTimer = null;
    }, 100);
  }

  // Debug logging
  private log(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[SafePlay Injector]', ...args);
    }
  }
}
