// SafePlay Caption Filter - Hijacks YouTube's native captions
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
  private processedNodes = new WeakSet<Node>();

  constructor(_options: CaptionFilterOptions = {}) {
    // Options for future use
  }

  /**
   * Initialize the caption filter with user preferences
   */
  initialize(preferences: UserPreferences, _muteIntervals: MuteInterval[]): void {
    this.preferences = preferences;
    log('Caption filter initialized');
  }

  /**
   * Start hijacking YouTube captions
   */
  start(): void {
    if (this.isActive) {
      log('Caption filter already active');
      return;
    }

    log('Starting caption filter - hijacking YouTube captions');
    this.isActive = true;
    this.censoredWordCount = 0;
    this.processedNodes = new WeakSet();

    // Set up mutation observer on the caption container
    this.setupCaptionObserver();
  }

  /**
   * Stop hijacking captions
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
   * Update preferences
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
   * Set up observer specifically on YouTube's caption container
   */
  private setupCaptionObserver(): void {
    // YouTube uses these containers for captions
    const captionContainerSelectors = [
      '.ytp-caption-window-container',
      '.caption-window',
      '#movie_player .ytp-caption-window-bottom',
      '#movie_player',
    ];

    let container: Element | null = null;
    for (const selector of captionContainerSelectors) {
      container = document.querySelector(selector);
      if (container) break;
    }

    if (!container) {
      log('Caption container not found, retrying in 500ms');
      setTimeout(() => {
        if (this.isActive) this.setupCaptionObserver();
      }, 500);
      return;
    }

    log('Found caption container, setting up observer');

    // Create observer that intercepts caption text changes
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Handle added nodes (new caption segments appear)
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            this.processCaptionNode(node);
          });
        }

        // Handle direct text changes in caption segments
        if (mutation.type === 'characterData') {
          const target = mutation.target;
          if (target.parentElement && this.isCaptionElement(target.parentElement)) {
            this.filterTextNode(target as Text);
          }
        }
      }
    });

    // Watch for all changes in the container
    this.observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    log('Caption observer active on container');
  }

  /**
   * Process a node that was added to the caption container
   */
  private processCaptionNode(node: Node): void {
    if (!this.isActive) return;

    // Skip if already processed
    if (this.processedNodes.has(node)) return;

    // If it's a text node inside a caption element, filter it
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (parent && this.isCaptionElement(parent)) {
        this.filterTextNode(node as Text);
      }
      return;
    }

    // If it's an element, check if it's a caption segment
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;

      // Check if this element or its children contain caption text
      if (this.isCaptionElement(element)) {
        this.filterCaptionElement(element);
      }

      // Also process any caption segments within this element
      const segments = element.querySelectorAll('.ytp-caption-segment');
      segments.forEach((segment) => {
        this.filterCaptionElement(segment);
      });
    }
  }

  /**
   * Check if element is a YouTube caption element
   */
  private isCaptionElement(element: Element): boolean {
    if (!element) return false;

    const className = element.className || '';

    // Check for YouTube caption classes
    if (className.includes('ytp-caption-segment')) return true;
    if (className.includes('captions-text')) return true;
    if (className.includes('caption-visual-line')) return true;

    // Check if it's inside a caption window
    if (element.closest('.ytp-caption-window-container')) return true;
    if (element.closest('.caption-window')) return true;

    return false;
  }

  /**
   * Filter text within a caption element by modifying its text nodes directly
   */
  private filterCaptionElement(element: Element): void {
    if (!this.preferences) return;
    if (this.processedNodes.has(element)) return;

    // Get all text nodes within the element
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );

    const textNodes: Text[] = [];
    let currentNode: Node | null;
    while ((currentNode = walker.nextNode())) {
      textNodes.push(currentNode as Text);
    }

    // Filter each text node
    textNodes.forEach((textNode) => {
      this.filterTextNode(textNode);
    });

    this.processedNodes.add(element);
  }

  /**
   * Filter a single text node by replacing profanity with (bleep)
   */
  private filterTextNode(textNode: Text): void {
    if (!this.preferences) return;
    if (this.processedNodes.has(textNode)) return;

    const originalText = textNode.textContent || '';
    if (!originalText.trim()) return;

    const filteredText = this.censorText(originalText);

    if (filteredText !== originalText) {
      // Directly modify the text node's content
      textNode.textContent = filteredText;
      log('Censored:', originalText, '->', filteredText);
    }

    this.processedNodes.add(textNode);
  }

  /**
   * Censor profanity in text string
   */
  private censorText(text: string): string {
    if (!this.preferences) return text;

    // Split by word boundaries while keeping delimiters
    const tokens = text.split(/(\s+|[.,!?;:'"()-])/);
    let result = '';
    let modified = false;

    for (const token of tokens) {
      // Skip whitespace and punctuation
      if (!token || /^[\s.,!?;:'"()-]+$/.test(token)) {
        result += token;
        continue;
      }

      // Check if it's a safe word
      if (isSafeWord(token)) {
        result += token;
        continue;
      }

      // Check for profanity
      const profanityMatches = findEmbeddedProfanity(token);

      if (profanityMatches.length > 0) {
        // Filter by enabled severity levels
        const enabledMatches = profanityMatches.filter((match) => {
          const severity = match.severity as SeverityLevel;
          return this.preferences!.severityLevels[severity];
        });

        if (enabledMatches.length > 0) {
          result += '(bleep)';
          this.censoredWordCount += enabledMatches.length;
          modified = true;
          continue;
        }
      }

      // Check custom blacklist
      if (this.preferences.customBlacklist.some(
        (banned) => token.toLowerCase() === banned.toLowerCase()
      )) {
        result += '(bleep)';
        this.censoredWordCount++;
        modified = true;
        continue;
      }

      result += token;
    }

    return modified ? result : text;
  }
}
