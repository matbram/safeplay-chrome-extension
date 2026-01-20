// SafePlay Popup Script
import {
  UserPreferences,
  DEFAULT_PREFERENCES,
  FilterMode,
  SeverityLevel,
  CreditInfo,
  AuthState,
} from '../types';
import { PROFANITY_LIST, getWordsBySeverity } from '../filter/profanity-list';
import './popup.css';

class PopupController {
  private preferences: UserPreferences = DEFAULT_PREFERENCES;
  private wordPreviewExpanded = false;
  private creditInfo: CreditInfo | null = null;
  private authState: AuthState | null = null;

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
  private autoEnableToggle!: HTMLInputElement;
  // Credit elements
  private creditLoading!: HTMLElement;
  private creditContent!: HTMLElement;
  private creditError!: HTMLElement;
  private creditValue!: HTMLElement;
  private creditProgressFill!: HTMLElement;
  private creditUsed!: HTMLElement;
  private creditPlan!: HTMLElement;
  private creditBonus!: HTMLElement;
  private creditBonusText!: HTMLElement;

  // Account elements
  private accountLoggedOut!: HTMLElement;
  private accountLoggedIn!: HTMLElement;
  private signInBtn!: HTMLButtonElement;
  private signOutBtn!: HTMLButtonElement;
  private creditSignInBtn!: HTMLButtonElement;
  private accountAvatar!: HTMLElement;
  private accountName!: HTMLElement;
  private accountEmail!: HTMLElement;
  private accountPlanBadge!: HTMLElement;
  private accountUpgradeLink!: HTMLAnchorElement;

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
    this.autoEnableToggle = document.getElementById('autoEnableToggle') as HTMLInputElement;
    // Credit elements
    this.creditLoading = document.getElementById('creditLoading') as HTMLElement;
    this.creditContent = document.getElementById('creditContent') as HTMLElement;
    this.creditError = document.getElementById('creditError') as HTMLElement;
    this.creditValue = document.getElementById('creditValue') as HTMLElement;
    this.creditProgressFill = document.getElementById('creditProgressFill') as HTMLElement;
    this.creditUsed = document.getElementById('creditUsed') as HTMLElement;
    this.creditPlan = document.getElementById('creditPlan') as HTMLElement;
    this.creditBonus = document.getElementById('creditBonus') as HTMLElement;
    this.creditBonusText = document.getElementById('creditBonusText') as HTMLElement;

    // Account elements
    this.accountLoggedOut = document.getElementById('accountLoggedOut') as HTMLElement;
    this.accountLoggedIn = document.getElementById('accountLoggedIn') as HTMLElement;
    this.signInBtn = document.getElementById('signInBtn') as HTMLButtonElement;
    this.signOutBtn = document.getElementById('signOutBtn') as HTMLButtonElement;
    this.creditSignInBtn = document.getElementById('creditSignInBtn') as HTMLButtonElement;
    this.accountAvatar = document.getElementById('accountAvatar') as HTMLElement;
    this.accountName = document.getElementById('accountName') as HTMLElement;
    this.accountEmail = document.getElementById('accountEmail') as HTMLElement;
    this.accountPlanBadge = document.getElementById('accountPlanBadge') as HTMLElement;
    this.accountUpgradeLink = document.getElementById('accountUpgradeLink') as HTMLAnchorElement;

    // Display word counts
    this.displayWordCounts();

    // Load preferences
    await this.loadPreferences();

    // Set up event listeners
    this.setupEventListeners();

    // Set up account event listeners
    this.setupAccountListeners();

    // Check current video status
    await this.checkVideoStatus();

    // Load auth state and user profile
    await this.loadAuthState();

    // Listen for status updates
    this.setupMessageListener();
  }

  private async loadCredits(): Promise<void> {
    // Don't load credits if not authenticated
    if (!this.authState?.isAuthenticated) {
      this.creditLoading.style.display = 'none';
      this.creditContent.style.display = 'none';
      this.creditError.style.display = 'flex';
      return;
    }

    try {
      // Show loading state
      this.creditLoading.style.display = 'block';
      this.creditContent.style.display = 'none';
      this.creditError.style.display = 'none';

      const response = await chrome.runtime.sendMessage({ type: 'GET_CREDITS' });

      if (response.success && response.data) {
        this.creditInfo = response.data;
        this.displayCredits();
      } else {
        // Show error state (likely not authenticated)
        this.creditLoading.style.display = 'none';
        this.creditError.style.display = 'flex';
      }
    } catch (error) {
      console.error('Failed to load credits:', error);
      this.creditLoading.style.display = 'none';
      this.creditError.style.display = 'flex';
    }
  }

  private displayCredits(): void {
    if (!this.creditInfo) return;

    const { available, used_this_period, plan_allocation, plan } = this.creditInfo;

    // Show content, hide loading/error
    this.creditLoading.style.display = 'none';
    this.creditContent.style.display = 'flex';
    this.creditError.style.display = 'none';

    // Calculate base vs bonus credits (same logic as website)
    const planQuota = plan_allocation;
    const effectiveTotal = available + used_this_period;
    const bonusTotal = Math.max(0, effectiveTotal - planQuota);
    const baseRemaining = Math.max(0, planQuota - used_this_period);
    const bonusRemaining = Math.max(0, available - baseRemaining);
    const usagePercent = Math.min(100, (used_this_period / planQuota) * 100);

    // Update credit value - show total available
    this.creditValue.textContent = available.toString();
    this.creditValue.classList.remove('low', 'empty');
    if (available === 0) {
      this.creditValue.classList.add('empty');
    } else if (baseRemaining === 0 && bonusRemaining <= 5) {
      // Only show "low" warning if we're into bonus credits and running low
      this.creditValue.classList.add('low');
    }

    // Update progress bar - based on plan usage only
    this.creditProgressFill.style.width = `${usagePercent}%`;
    this.creditProgressFill.classList.remove('warning', 'danger');
    if (usagePercent >= 100) {
      this.creditProgressFill.classList.add('danger');
    } else if (usagePercent >= 70) {
      this.creditProgressFill.classList.add('warning');
    }

    // Update labels - show plan credits usage
    this.creditUsed.textContent = `${Math.min(used_this_period, planQuota)}/${planQuota} plan used`;

    // Format plan name
    const planNames: Record<string, string> = {
      free: 'Free Plan',
      base: 'Base Plan',
      professional: 'Pro Plan',
      unlimited: 'Unlimited',
    };
    this.creditPlan.textContent = planNames[plan || 'free'] || 'Free Plan';

    // Show bonus credits if any exist
    if (bonusTotal > 0) {
      this.creditBonus.style.display = 'block';
      this.creditBonusText.textContent = `+${bonusRemaining} bonus available`;
    } else {
      this.creditBonus.style.display = 'none';
    }
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

    // Update auto-enable toggle
    if (this.autoEnableToggle) {
      this.autoEnableToggle.checked = this.preferences.autoEnableForFilteredVideos ?? true;
    }

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

    // Auto-enable toggle
    if (this.autoEnableToggle) {
      this.autoEnableToggle.addEventListener('change', () => {
        this.savePreferences({ autoEnableForFilteredVideos: this.autoEnableToggle.checked });
      });
    }

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
      'age-restricted': 'Age-Restricted',
    };

    this.videoStatusValue.textContent = statusMap[state.status] || state.status;

    // Remove previous state classes
    this.statusBanner.classList.remove('error', 'warning');

    if (state.status === 'age-restricted') {
      // Age-restricted is a warning, not an error
      this.statusBanner.classList.add('warning');
      this.statusText.textContent = 'Cannot Filter';
      if (state.error) {
        this.videoStatusValue.textContent = 'Age-Restricted';
        this.videoStatusValue.title = state.error;
      }
    } else if (state.status === 'error' && state.error) {
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
      if (message.type === 'CREDIT_UPDATE' && message.payload) {
        this.creditInfo = message.payload;
        this.displayCredits();
      }
      if (message.type === 'AUTH_STATE_CHANGED' && message.payload) {
        // Reload auth state when authentication changes
        this.loadAuthState();
      }
    });
  }

  private setupAccountListeners(): void {
    // Sign in button
    this.signInBtn?.addEventListener('click', () => {
      this.handleSignIn();
    });

    // Sign out button
    this.signOutBtn?.addEventListener('click', () => {
      this.handleSignOut();
    });

    // Credit section sign in button
    this.creditSignInBtn?.addEventListener('click', () => {
      this.handleSignIn();
    });
  }

  private async loadAuthState(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_USER_PROFILE' });

      if (response.success && response.data) {
        this.authState = response.data;
        this.updateAccountUI();

        // Load credits if authenticated
        if (this.authState?.isAuthenticated) {
          await this.loadCredits();
        }
      } else {
        // Not authenticated
        this.authState = {
          isAuthenticated: false,
          user: null,
          subscription: null,
          credits: null,
          token: null,
        };
        this.updateAccountUI();
      }
    } catch (error) {
      console.error('Failed to load auth state:', error);
      this.authState = {
        isAuthenticated: false,
        user: null,
        subscription: null,
        credits: null,
        token: null,
      };
      this.updateAccountUI();
    }
  }

  private updateAccountUI(): void {
    if (!this.authState) return;

    if (this.authState.isAuthenticated && this.authState.user) {
      // Show logged in state
      this.accountLoggedOut.style.display = 'none';
      this.accountLoggedIn.style.display = 'flex';

      // Update user info
      const user = this.authState.user;
      this.accountName.textContent = user.full_name || user.email?.split('@')[0] || 'User';
      this.accountEmail.textContent = user.email || '';

      // Update avatar
      if (user.avatar_url) {
        this.accountAvatar.innerHTML = `<img src="${this.escapeHtml(user.avatar_url)}" alt="Avatar">`;
      } else {
        this.accountAvatar.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        `;
      }

      // Update plan badge
      const subscription = this.authState.subscription;
      const planName = subscription?.plans?.name || 'Free';
      const planId = planName.toLowerCase();
      this.accountPlanBadge.textContent = planName;
      this.accountPlanBadge.className = `account-plan-badge ${planId}`;

      // Hide upgrade link for unlimited plans
      if (planId === 'unlimited' || planId === 'organization') {
        this.accountUpgradeLink.style.display = 'none';
      } else {
        this.accountUpgradeLink.style.display = 'inline-block';
      }
    } else {
      // Show logged out state
      this.accountLoggedOut.style.display = 'flex';
      this.accountLoggedIn.style.display = 'none';

      // Update credit section to show sign in prompt
      this.creditLoading.style.display = 'none';
      this.creditContent.style.display = 'none';
      this.creditError.style.display = 'flex';
    }
  }

  private async handleSignIn(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'OPEN_LOGIN' });
      // Close the popup after opening login page
      window.close();
    } catch (error) {
      console.error('Failed to open login:', error);
    }
  }

  private async handleSignOut(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'LOGOUT' });

      // Update local state
      this.authState = {
        isAuthenticated: false,
        user: null,
        subscription: null,
        credits: null,
        token: null,
      };
      this.creditInfo = null;

      // Update UI
      this.updateAccountUI();
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const popup = new PopupController();
  popup.initialize();
});
