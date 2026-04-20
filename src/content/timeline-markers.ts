// Timeline Markers - Visual indicators on YouTube's progress bar showing profanity locations
import { MuteInterval } from '../types';

export interface TimelineMarkersOptions {
  debug?: boolean;
}

export class TimelineMarkers {
  private muteIntervals: MuteInterval[] = [];
  private video: HTMLVideoElement | null = null;
  private overlayContainer: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private progressBarElement: HTMLElement | null = null;
  private isInitialized = false;
  private isDestroyed = false; // Flag to prevent operations after destroy
  private retryCount = 0;
  private maxRetries = 20;
  private retryDelay = 500;
  private retryTimeoutId: number | null = null; // Track timeout for cleanup
  private debug: boolean;

  constructor(options?: TimelineMarkersOptions) {
    this.debug = options?.debug ?? false;
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[SafePlay Timeline]', ...args);
    }
  }

  /**
   * Initialize the timeline markers with mute intervals
   */
  initialize(video: HTMLVideoElement, muteIntervals: MuteInterval[]): void {
    this.video = video;
    this.muteIntervals = muteIntervals;

    this.log('Initializing timeline markers with', muteIntervals.length, 'intervals');

    // Try to inject the overlay
    this.injectOverlayWithRetry();

    // Setup event listeners for duration changes
    this.setupEventListeners();
  }

  /**
   * Retry injection until progress bar is available
   */
  private injectOverlayWithRetry(): void {
    // Don't do anything if destroyed
    if (this.isDestroyed) {
      this.log('Skipping retry - markers were destroyed');
      return;
    }

    const progressBar = this.findProgressBar();

    if (progressBar) {
      this.progressBarElement = progressBar;
      this.createOverlay();
      this.isInitialized = true;
      this.log('Timeline overlay injected successfully');
    } else if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      this.retryTimeoutId = window.setTimeout(() => this.injectOverlayWithRetry(), this.retryDelay);
    } else {
      this.log('Failed to find progress bar after', this.maxRetries, 'attempts');
      // Last-resort on Shorts: paint our own thin bar at the bottom of the
      // video element so users still see profanity markers even when
      // YouTube's DOM has no addressable progress bar for us.
      const isShorts = window.location.pathname.startsWith('/shorts');
      if (isShorts) {
        this.log('Shorts: falling back to video-anchored overlay');
        this.injectVideoAnchoredOverlay();
      }
    }
  }

  /**
   * Find YouTube's progress bar element
   * We need to find the parent of .ytp-timed-markers-container to be at the same level
   */
  private findProgressBar(): HTMLElement | null {
    const isShorts = window.location.pathname.startsWith('/shorts');

    // Shorts: scope lookups to the ACTIVE reel, otherwise we'd attach
    // markers to a preloaded neighbor's progress bar and they'd never
    // appear to the user.
    //
    // IMPORTANT: the Shorts page embeds a *hidden* copy of the legacy
    // player (#shorts-player has ytp-hide-controls). That hidden player
    // still contains .ytp-progress-bar-container in the DOM — but since
    // it's not rendered, markers attached to it are invisible. So we
    // explicitly avoid .ytp-* selectors in the Shorts branch and target
    // the real visible progress bar, which lives under
    //   <div id="scrubber"> → <desktop-shorts-player-controls>
    //     → <yt-progress-bar> → .ytPlayerProgressBarDragContainer
    //       → .ytProgressBarLineProgressBarLine
    if (isShorts) {
      const activeReel = document.querySelector<HTMLElement>('ytd-reel-video-renderer[is-active]');
      const shortsSelectors = [
        // Line element — the visually rendered horizontal bar. Most
        // accurate anchor because our overlay inherits its height.
        '.ytProgressBarLineProgressBarLine',
        // Drag container — the role="slider" that spans the full bar
        // hit area. Slightly taller than the line, still the right width.
        '.ytPlayerProgressBarDragContainer',
        // Inner wrapper around the line/loaded/played divs.
        '.ytPlayerProgressBarProgressBar',
        // yt-progress-bar host element (custom element wrapping the above).
        'yt-progress-bar.ytPlayerProgressBarHostCustom',
        'yt-progress-bar',
        // Desktop-shorts-player-controls host — broader fallback.
        'desktop-shorts-player-controls',
        // Legacy/alt names used in older Shorts builds.
        '.YtProgressBarProgressBarLine',
        '.ytReelPlayerProgressBarHost',
        // Last-ditch slider-role lookup scoped by aria-label.
        '[role="slider"][aria-label*="Seek" i]',
        '[role="slider"][aria-label*="progress" i]',
      ];

      const roots: (HTMLElement | Document)[] = activeReel ? [activeReel, document] : [document];
      for (const root of roots) {
        for (const selector of shortsSelectors) {
          const element = root.querySelector<HTMLElement>(selector);
          if (element) {
            // Skip elements that aren't actually visible — e.g. the
            // hidden legacy player inside ytp-hide-controls that still
            // exposes its DOM.
            const rect = element.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 1) {
              this.log('Skipping hidden/zero-size candidate:', selector, `(${rect.width}x${rect.height})`);
              continue;
            }
            this.log('Found Shorts progress bar:', selector, 'root:', root === document ? 'document' : 'active reel');
            return element;
          }
        }
      }

      this.log('No Shorts progress bar found');
      return null;
    }

    // First, try to find where ytp-timed-markers-container lives
    // and inject as a sibling to it
    const timedMarkersContainer = document.querySelector<HTMLElement>('.ytp-timed-markers-container');
    if (timedMarkersContainer?.parentElement && this.isUsableContainer(timedMarkersContainer.parentElement)) {
      this.log('Found ytp-timed-markers-container, using its parent:', timedMarkersContainer.parentElement.className);
      return timedMarkersContainer.parentElement;
    }

    // Fallback selectors
    const selectors = [
      '.ytp-progress-bar-container',
      '.ytp-chapter-hover-container',
      '.ytp-progress-bar',
      '#movie_player .ytp-progress-bar-container',
    ];

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element && this.isUsableContainer(element)) {
        this.log('Found progress bar element:', selector);
        return element;
      }
    }

    return null;
  }

  // Reject progress-bar candidates that YouTube has already detached from
  // the document or hasn't rendered yet. Without this check, a mid-SPA-nav
  // findProgressBar() call could return a doomed element, we'd append our
  // overlay to it, and YouTube would remove the whole subtree — leaving
  // markers invisible until the user refreshes. Mirrors the guard the
  // Shorts branch already applies.
  private isUsableContainer(el: HTMLElement): boolean {
    if (!el.isConnected) {
      this.log('Rejecting detached progress-bar candidate');
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 1) {
      this.log(`Rejecting zero-size progress-bar candidate (${rect.width}x${rect.height})`);
      return false;
    }
    return true;
  }

  /**
   * Create the overlay container and markers
   */
  private createOverlay(): void {
    if (!this.progressBarElement || this.isDestroyed) return;

    // Remove existing overlay if any
    this.removeOverlay();


    // Create overlay container
    this.overlayContainer = document.createElement('div');
    this.overlayContainer.className = 'safeplay-timeline-overlay';

    // Position relative to progress bar with high z-index to be above YouTube's elements
    // YouTube uses z-index up to ~70 for various interactive elements
    this.overlayContainer.style.cssText = `
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      bottom: 0;
      height: 100%;
      width: 100%;
      pointer-events: none;
      z-index: 77;
    `;

    // Insert overlay into progress bar container
    this.progressBarElement.style.position = 'relative';
    this.progressBarElement.appendChild(this.overlayContainer);

    // CRITICAL: Disable pointer events on ytp-timed-markers-container so our markers receive events
    const timedMarkersContainer = document.querySelector<HTMLElement>('.ytp-timed-markers-container');
    if (timedMarkersContainer) {
      timedMarkersContainer.style.pointerEvents = 'none';
      this.log('Disabled pointer events on ytp-timed-markers-container');
    }

    this.log('Overlay container created and appended');

    // Create markers for each mute interval
    this.renderMarkers();

    // Setup resize observer to handle player resizing
    this.setupResizeObserver();

  }

  /**
   * Fallback for Shorts when YouTube's progress bar can't be found via
   * any of our selectors. Creates a 6px bar anchored to the bottom of
   * the video element's nearest positioned ancestor — users get the
   * same marker visualization without depending on YouTube's DOM.
   *
   * We prefer a YouTube-provided player container as the anchor (so the
   * overlay follows theater/fullscreen resize), and only fall back to
   * the direct video parent if none is available.
   */
  private injectVideoAnchoredOverlay(): void {
    if (!this.video || this.isDestroyed) return;

    const anchor: HTMLElement | null =
      this.video.closest<HTMLElement>('.html5-video-container') ||
      this.video.closest<HTMLElement>('#movie_player') ||
      this.video.closest<HTMLElement>('ytd-reel-video-renderer') ||
      this.video.parentElement;

    if (!anchor) {
      this.log('Video-anchored fallback: no usable anchor element');
      return;
    }

    // Tear down any existing overlay (from an earlier attempt)
    this.removeOverlay();

    // Ensure the anchor is a positioned container for our absolute overlay.
    const computed = window.getComputedStyle(anchor);
    if (computed.position === 'static') {
      anchor.style.position = 'relative';
    }

    this.overlayContainer = document.createElement('div');
    this.overlayContainer.className = 'safeplay-timeline-overlay safeplay-timeline-overlay-shorts';
    // Thin bar flush with the bottom edge. Background tint mimics the
    // look of YouTube's native progress track so the markers feel at
    // home. pointer-events: none on the container lets YouTube's own
    // UI underneath (comments button etc.) still be clickable; markers
    // themselves re-enable pointer-events so clicking seeks.
    this.overlayContainer.style.cssText = `
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 6px;
      width: 100%;
      pointer-events: none;
      z-index: 100;
      background: rgba(255, 255, 255, 0.12);
    `;
    anchor.appendChild(this.overlayContainer);

    this.progressBarElement = anchor;
    this.isInitialized = true;
    this.log('Video-anchored overlay injected on', anchor.tagName, anchor.id || anchor.className);

    this.renderMarkers();
    this.setupResizeObserver();
  }

  /**
   * Render all profanity markers on the timeline
   */
  private renderMarkers(): void {
    if (!this.overlayContainer || !this.video || this.isDestroyed) return;

    const duration = this.video.duration;
    if (!duration || !isFinite(duration)) {
      this.log('Video duration not available yet, waiting...');
      // Retry when duration becomes available
      this.video.addEventListener('loadedmetadata', () => this.renderMarkers(), { once: true });
      return;
    }

    // Clear existing markers
    this.overlayContainer.innerHTML = '';

    this.log('Rendering', this.muteIntervals.length, 'markers for video duration:', duration);

    // Create a marker for each mute interval
    for (const interval of this.muteIntervals) {
      const marker = this.createMarker(interval, duration);
      if (marker) {
        this.overlayContainer.appendChild(marker);
      }
    }
  }

  /**
   * Create a single marker element for a mute interval
   */
  private createMarker(interval: MuteInterval, videoDuration: number): HTMLElement | null {
    if (interval.start >= videoDuration) return null;

    const marker = document.createElement('div');
    marker.className = 'safeplay-timeline-marker';

    // Calculate position and width as percentages
    const leftPercent = (interval.start / videoDuration) * 100;
    const endTime = Math.min(interval.end, videoDuration);
    const widthPercent = ((endTime - interval.start) / videoDuration) * 100;

    // Minimum width of 0.8% for subtle but visible markers
    const minWidth = Math.max(widthPercent, 0.8);

    // Center the marker on the profanity start time if we expanded it
    const adjustedLeft = widthPercent < 0.8
      ? Math.max(0, leftPercent - (0.8 - widthPercent) / 2)
      : leftPercent;

    // Use white for all markers - provides good contrast against YouTube's red progress bar
    marker.style.cssText = `
      position: absolute;
      left: ${adjustedLeft}%;
      width: ${minWidth}%;
      height: 6px;
      bottom: 0;
      background-color: #FFFFFF;
      opacity: 0.9;
      border-radius: 2px;
      pointer-events: auto;
      cursor: pointer;
      z-index: 78;
      box-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
      transition: opacity 0.2s ease, transform 0.2s ease;
    `;

    // Add tooltip with word info
    marker.title = `${this.formatTimestamp(interval.start)} - "${interval.word}"`;

    // Hover effect - make it very visible
    marker.addEventListener('mouseenter', () => {
      marker.style.opacity = '1';
      marker.style.transform = 'scaleY(1.5)';
      marker.style.zIndex = '99';
      marker.style.boxShadow = '0 0 8px 2px rgba(255, 255, 255, 0.8)';
    });

    marker.addEventListener('mouseleave', () => {
      marker.style.opacity = '0.9';
      marker.style.transform = 'scaleY(1)';
      marker.style.zIndex = '78';
      marker.style.boxShadow = '0 0 2px rgba(0, 0, 0, 0.5)';
    });

    // Click to seek to that position
    marker.addEventListener('click', (e) => {
      this.log('CLICK on marker:', interval.word);
      e.stopPropagation();
      e.preventDefault();
      if (this.video) {
        // Seek to slightly before the profanity
        this.video.currentTime = Math.max(0, interval.start - 2);
        this.log('Seeked to', interval.start - 2, 'for interval:', interval.word);
      }
    });

    return marker;
  }

  /**
   * Format timestamp for tooltip display
   */
  private formatTimestamp(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Setup event listeners for video element
   */
  private setupEventListeners(): void {
    if (!this.video) return;

    // Re-render markers when video duration becomes available or changes
    this.video.addEventListener('durationchange', () => {
      this.log('Duration changed:', this.video?.duration);
      if (this.isInitialized) {
        this.renderMarkers();
      }
    });

    // Handle video source changes (for playlists, etc.)
    this.video.addEventListener('loadedmetadata', () => {
      this.log('Metadata loaded, duration:', this.video?.duration);
      if (this.isInitialized) {
        this.renderMarkers();
      }
    });
  }

  /**
   * Setup resize observer to reposition markers when player resizes
   */
  private setupResizeObserver(): void {
    if (!this.progressBarElement) return;

    this.resizeObserver = new ResizeObserver(() => {
      // Markers use percentages, so they scale automatically
      // But we log for debugging
      this.log('Progress bar resized');
    });

    this.resizeObserver.observe(this.progressBarElement);
  }

  /**
   * Update the mute intervals (e.g., when preferences change)
   */
  update(muteIntervals: MuteInterval[]): void {
    this.muteIntervals = muteIntervals;
    if (this.isInitialized) {
      this.renderMarkers();
    }
  }

  /**
   * Show the timeline markers
   */
  show(): void {
    if (this.overlayContainer) {
      this.overlayContainer.style.display = 'block';
    }
  }

  /**
   * Hide the timeline markers
   */
  hide(): void {
    if (this.overlayContainer) {
      this.overlayContainer.style.display = 'none';
    }
  }

  /**
   * Remove the overlay from DOM
   */
  private removeOverlay(): void {
    if (this.overlayContainer) {
      this.overlayContainer.remove();
      this.overlayContainer = null;
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.log('Destroying timeline markers');

    // Set destroyed flag first to prevent any pending operations
    this.isDestroyed = true;

    // Cancel any pending retry timeout
    if (this.retryTimeoutId !== null) {
      window.clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.removeOverlay();

    // Also remove any orphaned overlays by class name (safety net)
    const orphanedOverlays = document.querySelectorAll('.safeplay-timeline-overlay');
    orphanedOverlays.forEach(overlay => overlay.remove());

    this.video = null;
    this.progressBarElement = null;
    this.muteIntervals = [];
    this.isInitialized = false;
    this.retryCount = 0;
  }
}
