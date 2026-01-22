// SafePlay Popup Script - Clean Redesign
import {
  UserPreferences,
  DEFAULT_PREFERENCES,
  FilterMode,
  SeverityLevel,
  CreditInfo,
  AuthState,
} from '../types';
import { PROFANITY_LIST } from '../filter/profanity-list';
import './popup.css';

const THEME_STORAGE_KEY = 'safeplay_theme';
const CREDIT_POLL_INTERVAL = 5000; // Poll credits every 5 seconds
const VIDEO_POLL_INTERVAL = 2000; // Poll video status every 2 seconds

class PopupController {
  private preferences: UserPreferences = DEFAULT_PREFERENCES;
  private creditInfo: CreditInfo | null = null;
  private authState: AuthState | null = null;

  // Polling intervals
  private creditPollTimer: number | null = null;
  private videoPollTimer: number | null = null;

  // Word counts by severity
  private wordCounts: Record<SeverityLevel, number> = {
    mild: 0,
    moderate: 0,
    severe: 0,
    religious: 0,
  };

  // DOM Elements
  private themeToggle!: HTMLButtonElement;
  private enableToggle!: HTMLInputElement;
  private filterModeRadios!: NodeListOf<HTMLInputElement>;
  private severityMild!: HTMLInputElement;
  private severityModerate!: HTMLInputElement;
  private severitySevere!: HTMLInputElement;
  private severityReligious!: HTMLInputElement;
  private statusPill!: HTMLElement;
  private statusLabel!: HTMLElement;
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

  // Account elements
  private accountLoggedOut!: HTMLElement;
  private accountLoggedIn!: HTMLElement;
  private signInBtn!: HTMLButtonElement;
  private signOutBtn!: HTMLButtonElement;
  private accountAvatar!: HTMLElement;
  private accountName!: HTMLElement;
  private accountPlanBadge!: HTMLElement;
  private accountUpgradeLink!: HTMLAnchorElement;
  private creditValue!: HTMLElement;

  async initialize(): Promise<void> {
    // Calculate word counts
    this.calculateWordCounts();

    // Cache DOM elements
    this.cacheElements();

    // Load and apply theme
    this.loadTheme();

    // Display word counts
    this.displayWordCounts();

    // Load preferences
    await this.loadPreferences();

    // Set up event listeners
    this.setupEventListeners();

    // Check current video status
    await this.checkVideoStatus();

    // Load auth state and user profile
    await this.loadAuthState();

    // Listen for status updates
    this.setupMessageListener();

    // Start real-time polling
    this.startPolling();

    // Cleanup on popup close
    window.addEventListener('unload', () => this.stopPolling());
  }

  private startPolling(): void {
    // Poll credits every 5 seconds
    this.creditPollTimer = window.setInterval(() => {
      if (this.authState?.isAuthenticated) {
        this.loadCredits();
      }
    }, CREDIT_POLL_INTERVAL);

    // Poll video status every 2 seconds
    this.videoPollTimer = window.setInterval(() => {
      this.checkVideoStatus();
    }, VIDEO_POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (this.creditPollTimer !== null) {
      clearInterval(this.creditPollTimer);
      this.creditPollTimer = null;
    }
    if (this.videoPollTimer !== null) {
      clearInterval(this.videoPollTimer);
      this.videoPollTimer = null;
    }
  }

  private cacheElements(): void {
    this.themeToggle = document.getElementById('themeToggle') as HTMLButtonElement;
    this.enableToggle = document.getElementById('enableToggle') as HTMLInputElement;
    this.filterModeRadios = document.querySelectorAll('input[name="filterMode"]');
    this.severityMild = document.getElementById('severityMild') as HTMLInputElement;
    this.severityModerate = document.getElementById('severityModerate') as HTMLInputElement;
    this.severitySevere = document.getElementById('severitySevere') as HTMLInputElement;
    this.severityReligious = document.getElementById('severityReligious') as HTMLInputElement;
    this.statusPill = document.getElementById('statusPill') as HTMLElement;
    this.statusLabel = document.getElementById('statusLabel') as HTMLElement;
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

    // Account elements
    this.accountLoggedOut = document.getElementById('accountLoggedOut') as HTMLElement;
    this.accountLoggedIn = document.getElementById('accountLoggedIn') as HTMLElement;
    this.signInBtn = document.getElementById('signInBtn') as HTMLButtonElement;
    this.signOutBtn = document.getElementById('signOutBtn') as HTMLButtonElement;
    this.accountAvatar = document.getElementById('accountAvatar') as HTMLElement;
    this.accountName = document.getElementById('accountName') as HTMLElement;
    this.accountPlanBadge = document.getElementById('accountPlanBadge') as HTMLElement;
    this.accountUpgradeLink = document.getElementById('accountUpgradeLink') as HTMLAnchorElement;
    this.creditValue = document.getElementById('creditValue') as HTMLElement;
  }

  private loadTheme(): void {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === 'light') {
      document.body.classList.add('light-theme');
    }
  }

  private toggleTheme(): void {
    const isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem(THEME_STORAGE_KEY, isLight ? 'light' : 'dark');
  }

  private async loadCredits(): Promise<void> {
    if (!this.authState?.isAuthenticated) {
      this.creditValue.textContent = '0';
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_CREDITS' });

      if (response.success && response.data) {
        this.creditInfo = response.data;
        this.displayCredits();
      }
    } catch (error) {
      console.error('Failed to load credits:', error);
    }
  }

  private displayCredits(): void {
    if (!this.creditInfo) return;

    const { available, used_this_period, plan_allocation } = this.creditInfo;

    // Update credit value
    this.creditValue.textContent = available.toString();
    this.creditValue.classList.remove('low', 'empty');

    // Calculate remaining base credits
    const baseRemaining = Math.max(0, plan_allocation - used_this_period);
    const bonusRemaining = Math.max(0, available - baseRemaining);

    if (available === 0) {
      this.creditValue.classList.add('empty');
    } else if (baseRemaining === 0 && bonusRemaining <= 5) {
      this.creditValue.classList.add('low');
    }
  }

  private calculateWordCounts(): void {
    for (const item of PROFANITY_LIST) {
      this.wordCounts[item.severity]++;
    }
  }

  private displayWordCounts(): void {
    this.mildCount.textContent = this.wordCounts.mild.toString();
    this.moderateCount.textContent = this.wordCounts.moderate.toString();
    this.severeCount.textContent = this.wordCounts.severe.toString();
    this.religiousCount.textContent = this.wordCounts.religious.toString();

    this.updateTotalWordCount();
  }

  private updateTotalWordCount(): void {
    let total = 0;
    if (this.severityMild?.checked) total += this.wordCounts.mild;
    if (this.severityModerate?.checked) total += this.wordCounts.moderate;
    if (this.severitySevere?.checked) total += this.wordCounts.severe;
    if (this.severityReligious?.checked) total += this.wordCounts.religious;

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

    // Update status pill
    this.updateStatusPill();

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
  }

  private updateStatusPill(): void {
    this.statusPill.classList.remove('inactive', 'error', 'warning');

    if (!this.preferences.enabled) {
      this.statusPill.classList.add('inactive');
      this.statusLabel.textContent = 'Disabled';
    } else {
      this.statusLabel.textContent = 'Active';
    }
  }

  private setupEventListeners(): void {
    // Theme toggle
    this.themeToggle.addEventListener('click', () => {
      this.toggleTheme();
    });

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
    const severityHandler = () => {
      this.saveSeverityLevels();
      this.updateTotalWordCount();
    };

    this.severityMild.addEventListener('change', severityHandler);
    this.severityModerate.addEventListener('change', severityHandler);
    this.severitySevere.addEventListener('change', severityHandler);
    this.severityReligious.addEventListener('change', severityHandler);

    // Account listeners
    this.signInBtn?.addEventListener('click', () => this.handleSignIn());
    this.signOutBtn?.addEventListener('click', () => this.handleSignOut());

    // Settings link
    const settingsLink = document.getElementById('settingsLink');
    settingsLink?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage?.();
    });
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
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id || !tab.url?.includes('youtube.com/watch')) {
        this.videoStatusSection.style.display = 'none';
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_STATE' });

      if (response?.success && response.data) {
        this.updateVideoStatus(response.data);
      }
    } catch (error) {
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

    const statusMap: Record<string, string> = {
      idle: 'Ready',
      loading: 'Loading',
      processing: 'Processing',
      active: 'Filtering',
      error: 'Error',
      disabled: 'Disabled',
      'age-restricted': 'Restricted',
    };

    this.videoStatusValue.textContent = statusMap[state.status] || state.status;

    // Update status pill for special states
    this.statusPill.classList.remove('error', 'warning');

    if (state.status === 'age-restricted') {
      this.statusPill.classList.add('warning');
      this.statusLabel.textContent = 'Restricted';
    } else if (state.status === 'error') {
      this.statusPill.classList.add('error');
      this.statusLabel.textContent = 'Error';
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
        this.loadAuthState();
      }
    });
  }

  private async loadAuthState(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_USER_PROFILE' });

      if (response.success && response.data) {
        this.authState = response.data;
        this.updateAccountUI();

        if (this.authState?.isAuthenticated) {
          await this.loadCredits();
        }
      } else {
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

      const user = this.authState.user;
      this.accountName.textContent = user.full_name || user.email?.split('@')[0] || 'User';

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
      this.accountPlanBadge.className = `account-plan ${planId}`;

      // Hide upgrade link for unlimited plans
      if (planId === 'unlimited' || planId === 'organization') {
        this.accountUpgradeLink.style.display = 'none';
      } else {
        this.accountUpgradeLink.style.display = 'flex';
      }
    } else {
      // Show logged out state
      this.accountLoggedOut.style.display = 'flex';
      this.accountLoggedIn.style.display = 'none';
      this.creditValue.textContent = '0';
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private async handleSignIn(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'OPEN_LOGIN' });
      window.close();
    } catch (error) {
      console.error('Failed to open login:', error);
    }
  }

  private async handleSignOut(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'LOGOUT' });

      this.authState = {
        isAuthenticated: false,
        user: null,
        subscription: null,
        credits: null,
        token: null,
      };
      this.creditInfo = null;

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
