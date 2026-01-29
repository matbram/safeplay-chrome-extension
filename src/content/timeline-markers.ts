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
   * Uses multiple selectors for robustness
   */
  private findProgressBar(): HTMLElement | null {
    // Selectors for YouTube's progress bar container (in order of preference)
    const selectors = [
      '.ytp-progress-bar-container',
      '.ytp-progress-bar',
      '.ytp-chrome-bottom .ytp-progress-bar-container',
      '#movie_player .ytp-progress-bar-container',
    ];

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) {
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

    // Create overlay container
    this.overlayContainer = document.createElement('div');
    this.overlayContainer.className = 'safeplay-timeline-overlay';

    // Position relative to progress bar
    this.overlayContainer.style.cssText = `
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 100%;
      pointer-events: none;
      z-index: 30;
    `;

    // Insert overlay into progress bar container
    this.progressBarElement.style.position = 'relative';
    this.progressBarElement.appendChild(this.overlayContainer);

    // Create markers for each mute interval
    this.renderMarkers();

    // Setup resize observer to handle player resizing
    this.setupResizeObserver();
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
      opacity: 0.7;
      border-radius: 1px;
      pointer-events: auto;
      cursor: pointer;
      transition: opacity 0.2s ease, transform 0.2s ease;
    `;

    // Add tooltip with word info
    marker.title = `${this.formatTimestamp(interval.start)} - "${interval.word}" (${interval.severity})`;

    // Hover effect
    marker.addEventListener('mouseenter', () => {
      marker.style.opacity = '1';
      marker.style.transform = 'scaleY(1.3)';
      marker.style.zIndex = '31';
    });

    marker.addEventListener('mouseleave', () => {
      marker.style.opacity = '0.7';
      marker.style.transform = 'scaleY(1)';
      marker.style.zIndex = '30';
    });

    // Click to seek to that position
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
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
