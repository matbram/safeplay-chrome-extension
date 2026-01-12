// SafePlay Popup Script
import { UserPreferences, DEFAULT_PREFERENCES, FilterMode, SeverityLevel } from '../types';
import { PROFANITY_LIST, getWordsBySeverity } from '../filter/profanity-list';
import './popup.css';

class PopupController {
  private preferences: UserPreferences = DEFAULT_PREFERENCES;
  private wordPreviewExpanded = false;

  // Word counts by severity
  private wordCounts: Record<SeverityLevel, number> = {
    mild: 0,
    moderate: 0,
    severe: 0,
    religious: 0,
  };

  // DOM Elements
  private enableToggle!: HTMLInputElement;
  private filterModeRadios!: NodeListOf<HTMLInputElement>;
  private severityMild!: HTMLInputElement;
  private severityModerate!: HTMLInputElement;
  private severitySevere!: HTMLInputElement;
  private severityReligious!: HTMLInputElement;
  private statusBanner!: HTMLElement;
  private statusText!: HTMLElement;
  private videoStatusSection!: HTMLElement;
  private videoStatusValue!: HTMLElement;
  private filteredCount!: HTMLElement;
  private progressBar!: HTMLElement;
  private progressFill!: HTMLElement;
  private totalWordCount!: HTMLElement;
  private mildCount!: HTMLElement;
  private moderateCount!: HTMLElement;
  private severeCount!: HTMLElement;
  private religiousCount!: HTMLElement;
  private wordPreviewToggle!: HTMLElement;
  private wordPreviewArrow!: HTMLElement;
  private wordPreviewContent!: HTMLElement;
  private wordTags!: HTMLElement;

  async initialize(): Promise<void> {
    // Calculate word counts
    this.calculateWordCounts();

    // Get DOM elements
    this.enableToggle = document.getElementById('enableToggle') as HTMLInputElement;
    this.filterModeRadios = document.querySelectorAll('input[name="filterMode"]');
    this.severityMild = document.getElementById('severityMild') as HTMLInputElement;
    this.severityModerate = document.getElementById('severityModerate') as HTMLInputElement;
    this.severitySevere = document.getElementById('severitySevere') as HTMLInputElement;
    this.severityReligious = document.getElementById('severityReligious') as HTMLInputElement;
    this.statusBanner = document.getElementById('statusBanner') as HTMLElement;
    this.statusText = document.getElementById('statusText') as HTMLElement;
    this.videoStatusSection = document.getElementById('videoStatus') as HTMLElement;
    this.videoStatusValue = document.getElementById('videoStatusValue') as HTMLElement;
    this.filteredCount = document.getElementById('filteredCount') as HTMLElement;
    this.progressBar = document.getElementById('progressBar') as HTMLElement;
    this.progressFill = document.getElementById('progressFill') as HTMLElement;
    this.totalWordCount = document.getElementById('totalWordCount') as HTMLElement;
    this.mildCount = document.getElementById('mildCount') as HTMLElement;
    this.moderateCount = document.getElementById('moderateCount') as HTMLElement;
    this.severeCount = document.getElementById('severeCount') as HTMLElement;
    this.religiousCount = document.getElementById('religiousCount') as HTMLElement;
    this.wordPreviewToggle = document.getElementById('wordPreviewToggle') as HTMLElement;
    this.wordPreviewArrow = document.getElementById('wordPreviewArrow') as HTMLElement;
    this.wordPreviewContent = document.getElementById('wordPreviewContent') as HTMLElement;
    this.wordTags = document.getElementById('wordTags') as HTMLElement;

    // Display word counts
    this.displayWordCounts();

    // Load preferences
    await this.loadPreferences();

    // Set up event listeners
    this.setupEventListeners();

    // Check current video status
    await this.checkVideoStatus();

    // Listen for status updates
    this.setupMessageListener();
  }

  private calculateWordCounts(): void {
    // Count words by severity from the profanity list
    for (const item of PROFANITY_LIST) {
      this.wordCounts[item.severity]++;
    }
  }

  private displayWordCounts(): void {
    // Update individual counts
    this.mildCount.textContent = `(${this.wordCounts.mild})`;
    this.moderateCount.textContent = `(${this.wordCounts.moderate})`;
    this.severeCount.textContent = `(${this.wordCounts.severe})`;
    this.religiousCount.textContent = `(${this.wordCounts.religious})`;

    // Update total (will be recalculated based on selected levels)
    this.updateTotalWordCount();
  }

  private updateTotalWordCount(): void {
    let total = 0;
    if (this.severityMild?.checked) total += this.wordCounts.mild;
    if (this.severityModerate?.checked) total += this.wordCounts.moderate;
    if (this.severitySevere?.checked) total += this.wordCounts.severe;
    if (this.severityReligious?.checked) total += this.wordCounts.religious;

    // Add custom blacklist count
    total += this.preferences.customBlacklist.length;

    this.totalWordCount.textContent = `${total} words`;
  }

  private async loadPreferences(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_PREFERENCES' });
      if (response.success && response.data) {
        this.preferences = response.data;
        this.updateUI();
      }
    } catch (error) {
      console.error('Failed to load preferences:', error);
    }
  }

  private updateUI(): void {
    // Update toggle
    this.enableToggle.checked = this.preferences.enabled;
    document.body.classList.toggle('disabled', !this.preferences.enabled);

    // Update status banner
    this.updateStatusBanner();

    // Update filter mode
    this.filterModeRadios.forEach((radio) => {
      radio.checked = radio.value === this.preferences.filterMode;
    });

    // Update severity checkboxes
    this.severityMild.checked = this.preferences.severityLevels.mild;
    this.severityModerate.checked = this.preferences.severityLevels.moderate;
    this.severitySevere.checked = this.preferences.severityLevels.severe;
    this.severityReligious.checked = this.preferences.severityLevels.religious;

    // Update total word count
    this.updateTotalWordCount();

    // Update word preview if expanded
    if (this.wordPreviewExpanded) {
      this.renderWordPreview();
    }
  }

  private updateStatusBanner(): void {
    this.statusBanner.classList.remove('inactive', 'error');

    if (!this.preferences.enabled) {
      this.statusBanner.classList.add('inactive');
      this.statusText.textContent = 'Protection Disabled';
    } else {
      this.statusText.textContent = 'Protection Active';
    }
  }

  private setupEventListeners(): void {
    // Enable toggle
    this.enableToggle.addEventListener('change', () => {
      this.savePreferences({ enabled: this.enableToggle.checked });
    });

    // Filter mode
    this.filterModeRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          this.savePreferences({ filterMode: radio.value as FilterMode });
        }
      });
    });

    // Severity levels
    this.severityMild.addEventListener('change', () => {
      this.saveSeverityLevels();
      this.updateTotalWordCount();
      if (this.wordPreviewExpanded) this.renderWordPreview();
    });

    this.severityModerate.addEventListener('change', () => {
      this.saveSeverityLevels();
      this.updateTotalWordCount();
      if (this.wordPreviewExpanded) this.renderWordPreview();
    });

    this.severitySevere.addEventListener('change', () => {
      this.saveSeverityLevels();
      this.updateTotalWordCount();
      if (this.wordPreviewExpanded) this.renderWordPreview();
    });

    this.severityReligious.addEventListener('change', () => {
      this.saveSeverityLevels();
      this.updateTotalWordCount();
      if (this.wordPreviewExpanded) this.renderWordPreview();
    });

    // Word preview toggle
    this.wordPreviewToggle.addEventListener('click', () => {
      this.toggleWordPreview();
    });

    // Settings link
    const settingsLink = document.getElementById('settingsLink');
    settingsLink?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage?.();
    });
  }

  private toggleWordPreview(): void {
    this.wordPreviewExpanded = !this.wordPreviewExpanded;
    this.wordPreviewArrow.classList.toggle('expanded', this.wordPreviewExpanded);
    this.wordPreviewContent.classList.toggle('show', this.wordPreviewExpanded);

    if (this.wordPreviewExpanded) {
      this.renderWordPreview();
    }
  }

  private renderWordPreview(): void {
    const words: { word: string; isCustom: boolean }[] = [];

    // Add words from selected severity levels
    if (this.severityMild.checked) {
      getWordsBySeverity('mild').forEach(word => words.push({ word, isCustom: false }));
    }
    if (this.severityModerate.checked) {
      getWordsBySeverity('moderate').forEach(word => words.push({ word, isCustom: false }));
    }
    if (this.severitySevere.checked) {
      getWordsBySeverity('severe').forEach(word => words.push({ word, isCustom: false }));
    }
    if (this.severityReligious.checked) {
      getWordsBySeverity('religious').forEach(word => words.push({ word, isCustom: false }));
    }

    // Add custom blacklist words
    this.preferences.customBlacklist.forEach(word => words.push({ word, isCustom: true }));

    // Sort alphabetically
    words.sort((a, b) => a.word.localeCompare(b.word));

    // Render tags
    this.wordTags.innerHTML = words
      .map(({ word, isCustom }) =>
        `<span class="word-tag${isCustom ? ' custom' : ''}">${this.escapeHtml(word)}</span>`
      )
      .join('');
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private saveSeverityLevels(): void {
    this.savePreferences({
      severityLevels: {
        mild: this.severityMild.checked,
        moderate: this.severityModerate.checked,
        severe: this.severitySevere.checked,
        religious: this.severityReligious.checked,
      },
    });
  }

  private async savePreferences(updates: Partial<UserPreferences>): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SET_PREFERENCES',
        payload: updates,
      });

      if (response.success && response.data) {
        this.preferences = response.data;
        this.updateUI();
      }
    } catch (error) {
      console.error('Failed to save preferences:', error);
    }
  }

  private async checkVideoStatus(): Promise<void> {
    try {
      // Get current active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id || !tab.url?.includes('youtube.com/watch')) {
        this.videoStatusSection.style.display = 'none';
        return;
      }

      // Query content script for video state
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_STATE' });

      if (response?.success && response.data) {
        this.updateVideoStatus(response.data);
      }
    } catch (error) {
      // Content script not loaded or not on YouTube
      this.videoStatusSection.style.display = 'none';
    }
  }

  private updateVideoStatus(state: {
    status: string;
    progress: number;
    error?: string;
    intervalCount: number;
    currentlyMuting: boolean;
  }): void {
    this.videoStatusSection.style.display = 'block';

    // Update status text
    const statusMap: Record<string, string> = {
      idle: 'Ready',
      loading: 'Loading...',
      processing: 'Processing...',
      active: 'Filtering',
      error: 'Error',
      disabled: 'Disabled',
    };

    this.videoStatusValue.textContent = statusMap[state.status] || state.status;

    if (state.status === 'error' && state.error) {
      this.videoStatusValue.textContent = state.error;
      this.statusBanner.classList.add('error');
      this.statusText.textContent = 'Error Occurred';
    }

    // Update filtered count
    this.filteredCount.textContent = state.intervalCount.toString();

    // Update progress bar
    if (state.status === 'processing') {
      this.progressBar.style.display = 'block';
      this.progressFill.style.width = `${state.progress}%`;
    } else {
      this.progressBar.style.display = 'none';
    }
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'VIDEO_STATE_CHANGED' && message.payload) {
        this.updateVideoStatus(message.payload);
      }
      if (message.type === 'PREFERENCES_UPDATED' && message.payload) {
        this.preferences = message.payload;
        this.updateUI();
      }
    });
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const popup = new PopupController();
  popup.initialize();
});
