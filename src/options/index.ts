// SafePlay Options Page Script
import { UserPreferences, DEFAULT_PREFERENCES } from '../types';
import './options.css';

class OptionsController {
  private preferences: UserPreferences = DEFAULT_PREFERENCES;

  // DOM Elements
  private customBlacklist!: HTMLTextAreaElement;
  private customWhitelist!: HTMLTextAreaElement;
  private paddingBefore!: HTMLInputElement;
  private paddingAfter!: HTMLInputElement;
  private mergeThreshold!: HTMLInputElement;
  private autoEnableFiltered!: HTMLInputElement;
  private cacheCount!: HTMLElement;
  private clearCacheBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private saveStatus!: HTMLElement;

  async initialize(): Promise<void> {
    // Get DOM elements
    this.customBlacklist = document.getElementById('customBlacklist') as HTMLTextAreaElement;
    this.customWhitelist = document.getElementById('customWhitelist') as HTMLTextAreaElement;
    this.paddingBefore = document.getElementById('paddingBefore') as HTMLInputElement;
    this.paddingAfter = document.getElementById('paddingAfter') as HTMLInputElement;
    this.mergeThreshold = document.getElementById('mergeThreshold') as HTMLInputElement;
    this.autoEnableFiltered = document.getElementById('autoEnableFiltered') as HTMLInputElement;
    this.cacheCount = document.getElementById('cacheCount') as HTMLElement;
    this.clearCacheBtn = document.getElementById('clearCacheBtn') as HTMLButtonElement;
    this.saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
    this.saveStatus = document.getElementById('saveStatus') as HTMLElement;

    // Load preferences
    await this.loadPreferences();

    // Load cache count
    await this.loadCacheCount();

    // Set up event listeners
    this.setupEventListeners();
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
    // Update custom word lists
    this.customBlacklist.value = this.preferences.customBlacklist.join('\n');
    this.customWhitelist.value = this.preferences.customWhitelist.join('\n');

    // Update timing settings
    this.paddingBefore.value = (this.preferences.paddingBeforeMs ?? this.preferences.paddingMs).toString();
    this.paddingAfter.value = (this.preferences.paddingAfterMs ?? this.preferences.paddingMs).toString();
    this.mergeThreshold.value = this.preferences.mergeThresholdMs.toString();

    // Update behavior settings
    this.autoEnableFiltered.checked = this.preferences.autoEnableForFilteredVideos !== false;
  }

  private async loadCacheCount(): Promise<void> {
    try {
      const storage = await chrome.storage.local.get('cachedTranscripts');
      const cached = storage.cachedTranscripts || {};
      const count = Object.keys(cached).length;
      this.cacheCount.textContent = count.toString();
    } catch (error) {
      console.error('Failed to load cache count:', error);
      this.cacheCount.textContent = '0';
    }
  }

  private setupEventListeners(): void {
    // Save button
    this.saveBtn.addEventListener('click', () => {
      this.saveSettings();
    });

    // Clear cache button
    this.clearCacheBtn.addEventListener('click', () => {
      this.clearCache();
    });

    // Listen for preference updates from other tabs
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'PREFERENCES_UPDATED' && message.payload) {
        this.preferences = message.payload;
        this.updateUI();
      }
    });
  }

  private parseWordList(text: string): string[] {
    return text
      .split('\n')
      .map(word => word.trim().toLowerCase())
      .filter(word => word.length > 0);
  }

  private async saveSettings(): Promise<void> {
    try {
      const updates: Partial<UserPreferences> = {
        customBlacklist: this.parseWordList(this.customBlacklist.value),
        customWhitelist: this.parseWordList(this.customWhitelist.value),
        paddingBeforeMs: parseInt(this.paddingBefore.value, 10) || 100,
        paddingAfterMs: parseInt(this.paddingAfter.value, 10) || 30,
        mergeThresholdMs: parseInt(this.mergeThreshold.value, 10) || 100,
        autoEnableForFilteredVideos: this.autoEnableFiltered.checked,
      };

      const response = await chrome.runtime.sendMessage({
        type: 'SET_PREFERENCES',
        payload: updates,
      });

      if (response.success) {
        this.preferences = response.data;
        this.showSaveStatus('Settings saved successfully!', 'success');
      } else {
        this.showSaveStatus('Failed to save settings', 'error');
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showSaveStatus('Failed to save settings', 'error');
    }
  }

  private async clearCache(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });

      if (response.success) {
        this.cacheCount.textContent = '0';
        this.showSaveStatus('Cache cleared!', 'success');
      } else {
        this.showSaveStatus('Failed to clear cache', 'error');
      }
    } catch (error) {
      console.error('Failed to clear cache:', error);
      this.showSaveStatus('Failed to clear cache', 'error');
    }
  }

  private showSaveStatus(message: string, type: 'success' | 'error'): void {
    this.saveStatus.textContent = message;
    this.saveStatus.className = `save-status ${type}`;

    // Clear after 3 seconds
    setTimeout(() => {
      this.saveStatus.textContent = '';
      this.saveStatus.className = 'save-status';
    }, 3000);
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const options = new OptionsController();
  options.initialize();
});
