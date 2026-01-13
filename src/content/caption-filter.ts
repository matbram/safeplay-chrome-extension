// SafePlay Caption Filter - Real-time caption text censoring
import { UserPreferences, MuteInterval, SeverityLevel } from '../types';
import { findEmbeddedProfanity, isSafeWord } from '../filter/profanity-list';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[SafePlay:Captions]', ...args);
  }
}

export interface CaptionFilterOptions {
  debug?: boolean;
}

export class CaptionFilter {
  private observer: MutationObserver | null = null;
  private preferences: UserPreferences | null = null;
  private isActive = false;
  private censoredWordCount = 0;

  // YouTube caption selectors (they change occasionally, so we try multiple)
  private readonly CAPTION_SELECTORS = [
    '.ytp-caption-segment',           // Individual caption segments
    '.captions-text',                  // Alternative caption text
    '.ytp-caption-window-container',   // Caption window
    '.caption-window',                 // Another variant
    '.ytp-caption-window-bottom',      // Bottom caption window
  ];

  constructor(_options: CaptionFilterOptions = {}) {
    // Options for future use
  }

  /**
   * Initialize the caption filter with user preferences and mute intervals
   */
  initialize(preferences: UserPreferences, _muteIntervals: MuteInterval[]): void {
    this.preferences = preferences;
    log('Caption filter initialized');
  }

  /**
   * Start watching and filtering captions
   */
  start(): void {
    if (this.isActive) {
      log('Caption filter already active');
      return;
    }

    log('Starting caption filter');
    this.isActive = true;
    this.censoredWordCount = 0;

    // Set up mutation observer to watch for caption changes
    this.setupObserver();

    // Also do an initial scan of any existing captions
    this.scanExistingCaptions();
  }

  /**
   * Stop watching captions
   */
  stop(): void {
    if (!this.isActive) return;

    log('Stopping caption filter. Censored', this.censoredWordCount, 'words total.');
    this.isActive = false;

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  /**
   * Update preferences (e.g., when user changes severity levels)
   */
  updatePreferences(preferences: UserPreferences): void {
    this.preferences = preferences;
  }

  /**
   * Get the count of censored words
   */
  getCensoredCount(): number {
    return this.censoredWordCount;
  }

  /**
   * Set up MutationObserver to watch for caption text changes
   */
  private setupObserver(): void {
    // Find the player container to observe
    const playerContainer = document.querySelector('#movie_player') ||
                           document.querySelector('.html5-video-player') ||
                           document.querySelector('ytd-player');

    if (!playerContainer) {
      log('Player container not found, retrying in 500ms');
      setTimeout(() => this.setupObserver(), 500);
      return;
    }

    // Create observer that watches for caption changes
    this.observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });

    // Observe the player for any DOM changes (captions are dynamically added)
    this.observer.observe(playerContainer, {
      childList: true,
      subtree: true,
      characterData: true,
      characterDataOldValue: true,
    });

    log('Caption observer set up on player container');
  }

  /**
   * Handle DOM mutations - look for caption text changes
   */
  private handleMutations(mutations: MutationRecord[]): void {
    if (!this.isActive) return;

    for (const mutation of mutations) {
      // Handle text content changes
      if (mutation.type === 'characterData' && mutation.target.parentElement) {
        const parent = mutation.target.parentElement;
        if (this.isCaptionElement(parent)) {
          this.filterCaptionElement(parent);
        }
      }

      // Handle new nodes being added (new caption segments)
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            // Check if this is a caption element
            if (this.isCaptionElement(node)) {
              this.filterCaptionElement(node);
            }
            // Also check children
            const captionElements = this.findCaptionElements(node);
            captionElements.forEach((el) => this.filterCaptionElement(el));
          }
        });
      }
    }
  }

  /**
   * Check if an element is a caption element
   */
  private isCaptionElement(element: Element): boolean {
    for (const selector of this.CAPTION_SELECTORS) {
      if (element.matches(selector) || element.closest(selector)) {
        return true;
      }
    }
    // Also check class names that might indicate caption content
    const className = element.className || '';
    return className.includes('caption') || className.includes('ytp-caption');
  }

  /**
   * Find caption elements within a container
   */
  private findCaptionElements(container: Element): Element[] {
    const elements: Element[] = [];
    for (const selector of this.CAPTION_SELECTORS) {
      const found = container.querySelectorAll(selector);
      found.forEach((el) => elements.push(el));
    }
    return elements;
  }

  /**
   * Scan for existing captions on the page
   */
  private scanExistingCaptions(): void {
    for (const selector of this.CAPTION_SELECTORS) {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el) => this.filterCaptionElement(el));
    }
  }

  /**
   * Filter profanity from a caption element
   */
  private filterCaptionElement(element: Element): void {
    if (!this.preferences) return;

    const originalText = element.textContent || '';
    if (!originalText.trim()) return;

    // Check if already processed
    if (element.getAttribute('data-safeplay-filtered') === 'true') {
      return;
    }

    const filteredText = this.censorText(originalText);

    if (filteredText !== originalText) {
      // Text was modified, update the element
      element.textContent = filteredText;
      element.setAttribute('data-safeplay-filtered', 'true');
      log('Censored caption:', originalText, '->', filteredText);
    }
  }

  /**
   * Censor profanity in text
   */
  private censorText(text: string): string {
    if (!this.preferences) return text;

    // Check against safe words first
    const words = text.split(/(\s+)/); // Split keeping whitespace
    let result = '';

    for (const word of words) {
      if (/^\s+$/.test(word)) {
        // It's whitespace, keep it
        result += word;
        continue;
      }

      // Strip punctuation for checking but preserve for output
      const punctuationMatch = word.match(/^([^a-zA-Z]*)(.+?)([^a-zA-Z]*)$/);
      if (!punctuationMatch) {
        result += word;
        continue;
      }

      const [, leadingPunct, coreWord, trailingPunct] = punctuationMatch;

      // Check if it's a safe word
      if (isSafeWord(coreWord)) {
        result += word;
        continue;
      }

      // Check for profanity
      const profanityMatches = findEmbeddedProfanity(coreWord);

      if (profanityMatches.length > 0) {
        // Filter by enabled severity levels
        const enabledMatches = profanityMatches.filter((match) => {
          const severity = match.severity as SeverityLevel;
          return this.preferences!.severityLevels[severity];
        });

        if (enabledMatches.length > 0) {
          // Censor the word - replace with (bleep)
          result += leadingPunct + '(bleep)' + trailingPunct;
          this.censoredWordCount += enabledMatches.length;
        } else {
          result += word;
        }
      } else {
        // Also check custom blacklist
        if (this.preferences.customBlacklist.some(
          (banned) => coreWord.toLowerCase() === banned.toLowerCase()
        )) {
          result += leadingPunct + '(bleep)' + trailingPunct;
          this.censoredWordCount++;
        } else {
          result += word;
        }
      }
    }

    return result;
  }
}
