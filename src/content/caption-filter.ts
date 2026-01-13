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

// Patterns for YouTube's pre-censored words (e.g., f******, s***, b****)
const CENSORED_PATTERNS: { pattern: RegExp; severity: SeverityLevel }[] = [
  // F-word variations
  { pattern: /\bf+[\*\#\-\_]+(?:ck|ck(?:ing|ed|er|ers|s)?)?\b/gi, severity: 'severe' },
  { pattern: /\bf+u+[\*\#\-\_]+k*(?:ing|ed|er|ers|s)?\b/gi, severity: 'severe' },
  { pattern: /\bf[\*\#\-\_]{2,}(?:ing|ed|er|ers|s)?\b/gi, severity: 'severe' },

  // S-word variations
  { pattern: /\bs+h+[\*\#\-\_]+t*(?:ty|s|head|heads)?\b/gi, severity: 'moderate' },
  { pattern: /\bs[\*\#\-\_]{2,}t?\b/gi, severity: 'moderate' },

  // B-word variations
  { pattern: /\bb+[\*\#\-\_]+(?:tch|tch(?:es|y)?)?\b/gi, severity: 'moderate' },
  { pattern: /\bb[\*\#\-\_]{2,}(?:es|y)?\b/gi, severity: 'moderate' },

  // A-word variations
  { pattern: /\ba+[\*\#\-\_]+(?:ss|ss(?:hole|holes)?)?\b/gi, severity: 'moderate' },
  { pattern: /\ba[\*\#\-\_]{1,}(?:hole|holes)?\b/gi, severity: 'moderate' },

  // C-word variations (severe)
  { pattern: /\bc+[\*\#\-\_]+(?:nt|nts)?\b/gi, severity: 'severe' },

  // D-word variations
  { pattern: /\bd+[\*\#\-\_]+(?:ck|cks|ckhead)?\b/gi, severity: 'moderate' },

  // P-word variations
  { pattern: /\bp+[\*\#\-\_]+(?:ssy|ss(?:ies|y)?)?\b/gi, severity: 'moderate' },

  // N-word variations (severe)
  { pattern: /\bn+[\*\#\-\_]+(?:gg|gga|gger|ggers|ggas)?\b/gi, severity: 'severe' },

  // Generic asterisk patterns (3+ asterisks likely profanity)
  { pattern: /\b\w[\*\#]{3,}\w*\b/gi, severity: 'moderate' },
];

export class CaptionFilter {
  private observer: MutationObserver | null = null;
  private preferences: UserPreferences | null = null;
  private isActive = false;
  private censoredWordCount = 0;
  private lastProcessedTexts = new Map<Node, string>();

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
    this.lastProcessedTexts.clear();

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

    this.lastProcessedTexts.clear();
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
      if (!this.isActive) return;

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
          if (target.nodeType === Node.TEXT_NODE) {
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

    // Also do an initial scan
    this.scanForCaptions(container);

    log('Caption observer active on container');
  }

  /**
   * Scan container for existing captions
   */
  private scanForCaptions(container: Element): void {
    const segments = container.querySelectorAll('.ytp-caption-segment');
    segments.forEach((segment) => {
      this.filterCaptionElement(segment);
    });
  }

  /**
   * Process a node that was added to the caption container
   */
  private processCaptionNode(node: Node): void {
    if (!this.isActive) return;

    // If it's a text node, filter it directly
    if (node.nodeType === Node.TEXT_NODE) {
      this.filterTextNode(node as Text);
      return;
    }

    // If it's an element, check if it's a caption segment
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;

      // Check if this element is or contains caption text
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
  }

  /**
   * Filter a single text node by replacing profanity with (bleep)
   */
  private filterTextNode(textNode: Text): void {
    if (!this.preferences) return;

    const originalText = textNode.textContent || '';
    if (!originalText.trim()) return;

    // Skip if already fully processed (contains only bleeps or same text)
    const lastText = this.lastProcessedTexts.get(textNode);
    if (lastText === originalText) return;

    const filteredText = this.censorText(originalText);

    if (filteredText !== originalText) {
      // Directly modify the text node's content
      textNode.textContent = filteredText;
      this.lastProcessedTexts.set(textNode, filteredText);
      log('Censored:', originalText, '->', filteredText);
    } else {
      this.lastProcessedTexts.set(textNode, originalText);
    }
  }

  /**
   * Censor profanity in text string
   */
  private censorText(text: string): string {
    if (!this.preferences) return text;

    let result = text;
    let modified = false;

    // First, handle YouTube's pre-censored words (e.g., f******, s***)
    result = this.replaceCensoredPatterns(result);
    if (result !== text) {
      modified = true;
    }

    // Then handle regular profanity word by word
    const tokens = result.split(/(\s+)/);
    let newResult = '';

    for (const token of tokens) {
      // Skip whitespace
      if (!token || /^\s+$/.test(token)) {
        newResult += token;
        continue;
      }

      // Skip if already (bleep)
      if (token === '(bleep)') {
        newResult += token;
        continue;
      }

      // Check if it's a safe word
      if (isSafeWord(token)) {
        newResult += token;
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
          newResult += '(bleep)';
          this.censoredWordCount += enabledMatches.length;
          modified = true;
          continue;
        }
      }

      // Check custom blacklist
      const tokenLower = token.toLowerCase().replace(/[.,!?;:'"()-]/g, '');
      if (this.preferences.customBlacklist.some(
        (banned) => tokenLower === banned.toLowerCase()
      )) {
        newResult += '(bleep)';
        this.censoredWordCount++;
        modified = true;
        continue;
      }

      newResult += token;
    }

    return modified ? newResult : text;
  }

  /**
   * Replace YouTube's pre-censored patterns (f******, s***, etc.)
   */
  private replaceCensoredPatterns(text: string): string {
    if (!this.preferences) return text;

    let result = text;

    for (const { pattern, severity } of CENSORED_PATTERNS) {
      // Check if this severity level is enabled
      if (!this.preferences.severityLevels[severity]) continue;

      // Reset regex state
      pattern.lastIndex = 0;

      if (pattern.test(result)) {
        pattern.lastIndex = 0;
        const matches = result.match(pattern);
        if (matches) {
          this.censoredWordCount += matches.length;
        }
        result = result.replace(pattern, '(bleep)');
      }
    }

    return result;
  }
}
