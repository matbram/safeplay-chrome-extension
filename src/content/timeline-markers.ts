// Timeline Markers - Visual indicators on YouTube's progress bar showing profanity locations
import { MuteInterval, SeverityLevel } from '../types';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[SafePlay Timeline]', ...args);
  }
}

// Colors for different severity levels
const SEVERITY_COLORS: Record<SeverityLevel, string> = {
  mild: '#FFA500',      // Orange
  moderate: '#FF6B6B',  // Red
  severe: '#DC143C',    // Crimson
  religious: '#9370DB', // Medium Purple
};

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
  private retryCount = 0;
  private maxRetries = 20;
  private retryDelay = 500;

  constructor(_options?: TimelineMarkersOptions) {
    // Options for future use
  }

  /**
   * Initialize the timeline markers with mute intervals
   */
  initialize(video: HTMLVideoElement, muteIntervals: MuteInterval[]): void {
    this.video = video;
    this.muteIntervals = muteIntervals;

    log('Initializing timeline markers with', muteIntervals.length, 'intervals');

    // Try to inject the overlay
    this.injectOverlayWithRetry();

    // Setup event listeners for duration changes
    this.setupEventListeners();
  }

  /**
   * Retry injection until progress bar is available
   */
  private injectOverlayWithRetry(): void {
    const progressBar = this.findProgressBar();

    if (progressBar) {
      this.progressBarElement = progressBar;
      this.createOverlay();
      this.isInitialized = true;
      log('Timeline overlay injected successfully');
    } else if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      setTimeout(() => this.injectOverlayWithRetry(), this.retryDelay);
    } else {
      log('Failed to find progress bar after', this.maxRetries, 'attempts');
    }
  }

  /**
   * Find YouTube's progress bar element
   * We need to find the parent of .ytp-timed-markers-container to be at the same level
   */
  private findProgressBar(): HTMLElement | null {
    // First, try to find where ytp-timed-markers-container lives
    // and inject as a sibling to it
    const timedMarkersContainer = document.querySelector<HTMLElement>('.ytp-timed-markers-container');
    if (timedMarkersContainer?.parentElement) {
      log('Found ytp-timed-markers-container, using its parent:', timedMarkersContainer.parentElement.className);
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
      if (element) {
        log('Found progress bar element:', selector);
        return element;
      }
    }

    return null;
  }

  /**
   * Create the overlay container and markers
   */
  private createOverlay(): void {
    if (!this.progressBarElement) return;

    // Remove existing overlay if any
    this.removeOverlay();

    // Log the parent element's structure for debugging
    log('Progress bar element:', this.progressBarElement);
    log('Progress bar parent:', this.progressBarElement.parentElement);
    log('Progress bar computed style position:', window.getComputedStyle(this.progressBarElement).position);
    log('Progress bar computed style z-index:', window.getComputedStyle(this.progressBarElement).zIndex);

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
      log('Disabled pointer events on ytp-timed-markers-container');
    }

    log('Overlay container created and appended');
    log('Overlay computed z-index:', window.getComputedStyle(this.overlayContainer).zIndex);

    // Log sibling elements to understand the stacking context
    const siblings = this.progressBarElement.children;
    log('Progress bar children count:', siblings.length);
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i] as HTMLElement;
      const style = window.getComputedStyle(sibling);
      log(`  Child ${i}: ${sibling.className}, z-index: ${style.zIndex}, position: ${style.position}`);
    }

    // Create markers for each mute interval
    this.renderMarkers();

    // Setup resize observer to handle player resizing
    this.setupResizeObserver();

    // Add a test click listener on the overlay to see if events reach it
    this.overlayContainer.addEventListener('click', (e) => {
      log('Click on overlay container at:', e.clientX, e.clientY);
    }, true);

    // Add a global listener to debug what's receiving clicks in the progress bar area
    this.setupDebugListeners();
  }

  /**
   * Setup debug listeners to understand event flow
   */
  private setupDebugListeners(): void {
    // Listen for mousemove on document to check what's under cursor in progress bar area
    const progressBarRect = this.progressBarElement?.getBoundingClientRect();

    document.addEventListener('mousemove', (e) => {
      if (!progressBarRect) return;

      // Only log when mouse is in the progress bar area
      if (e.clientY >= progressBarRect.top && e.clientY <= progressBarRect.bottom &&
          e.clientX >= progressBarRect.left && e.clientX <= progressBarRect.right) {
        const elements = document.elementsFromPoint(e.clientX, e.clientY);
        const topElement = elements[0];
        if (topElement && !topElement.className.includes('safeplay')) {
          log('Top element at cursor:', topElement.tagName, topElement.className, 'z-index:', window.getComputedStyle(topElement).zIndex);
        }
      }
    }, { passive: true });
  }

  /**
   * Render all profanity markers on the timeline
   */
  private renderMarkers(): void {
    if (!this.overlayContainer || !this.video) return;

    const duration = this.video.duration;
    if (!duration || !isFinite(duration)) {
      log('Video duration not available yet, waiting...');
      // Retry when duration becomes available
      this.video.addEventListener('loadedmetadata', () => this.renderMarkers(), { once: true });
      return;
    }

    // Clear existing markers
    this.overlayContainer.innerHTML = '';

    log('Rendering', this.muteIntervals.length, 'markers for video duration:', duration);

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
    marker.className = `safeplay-timeline-marker safeplay-severity-${interval.severity}`;

    // Calculate position and width as percentages
    const leftPercent = (interval.start / videoDuration) * 100;
    const endTime = Math.min(interval.end, videoDuration);
    const widthPercent = ((endTime - interval.start) / videoDuration) * 100;

    // Minimum visible width (0.3% of timeline or 3px equivalent)
    const minWidth = Math.max(widthPercent, 0.3);

    const color = SEVERITY_COLORS[interval.severity] || SEVERITY_COLORS.moderate;

    marker.style.cssText = `
      position: absolute;
      left: ${leftPercent}%;
      width: ${minWidth}%;
      height: 100%;
      background-color: ${color};
      opacity: 0.8;
      border-radius: 1px;
      pointer-events: auto;
      cursor: pointer;
      z-index: 78;
      transition: opacity 0.2s ease, transform 0.2s ease;
    `;

    // Add tooltip with word info
    marker.title = `${this.formatTimestamp(interval.start)} - "${interval.word}" (${interval.severity})`;

    // Hover effect
    marker.addEventListener('mouseenter', (e) => {
      log('MOUSEENTER on marker:', interval.word, 'at', e.clientX, e.clientY);
      marker.style.opacity = '1';
      marker.style.transform = 'scaleY(1.5)';
      marker.style.zIndex = '79';
    });

    marker.addEventListener('mouseleave', () => {
      log('MOUSELEAVE on marker:', interval.word);
      marker.style.opacity = '0.8';
      marker.style.transform = 'scaleY(1)';
      marker.style.zIndex = '78';
    });

    marker.addEventListener('mouseover', (e) => {
      log('MOUSEOVER on marker:', interval.word);
      // Check what elements are at this point
      const elementsAtPoint = document.elementsFromPoint(e.clientX, e.clientY);
      log('Elements at point:', elementsAtPoint.slice(0, 10).map(el => `${el.tagName}.${el.className}`));
    });

    // Click to seek to that position
    marker.addEventListener('click', (e) => {
      log('CLICK on marker:', interval.word);
      e.stopPropagation();
      e.preventDefault();
      if (this.video) {
        // Seek to slightly before the profanity
        this.video.currentTime = Math.max(0, interval.start - 2);
        log('Seeked to', interval.start - 2, 'for interval:', interval.word);
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
      log('Duration changed:', this.video?.duration);
      if (this.isInitialized) {
        this.renderMarkers();
      }
    });

    // Handle video source changes (for playlists, etc.)
    this.video.addEventListener('loadedmetadata', () => {
      log('Metadata loaded, duration:', this.video?.duration);
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
      log('Progress bar resized');
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
    log('Destroying timeline markers');

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.removeOverlay();
    this.video = null;
    this.progressBarElement = null;
    this.muteIntervals = [];
    this.isInitialized = false;
    this.retryCount = 0;
  }
}
