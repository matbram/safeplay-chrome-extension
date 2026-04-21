import { UserPreferences, DEFAULT_PREFERENCES, AuthState } from '../types';
import './options.css';

type Section = 'settings' | 'words' | 'billing' | 'account' | 'advanced';

const SAVE_SECTIONS: Section[] = ['settings', 'words', 'advanced'];

class OptionsController {
  private prefs: UserPreferences = DEFAULT_PREFERENCES;
  private authState: AuthState | null = null;
  // Nav + sections
  private navItems!:      NodeListOf<HTMLButtonElement>;
  private contentSections!: NodeListOf<HTMLElement>;

  // Settings
  private autoFilterAllVideos!:    HTMLInputElement;
  private confirmBeforeAutoFilter!: HTMLInputElement;
  private confirmBeforeAutoFilterRow!: HTMLElement;
  private autoEnableFiltered!:     HTMLInputElement;
  private showTimelineMarkers!:    HTMLInputElement;

  // Words
  private customBlacklist!:  HTMLTextAreaElement;
  private customWhitelist!:  HTMLTextAreaElement;
  private blacklistCount!:   HTMLElement;
  private whitelistCount!:   HTMLElement;

  // Billing
  private sidebarCredits!:    HTMLElement;
  private sidebarCreditsFill!: HTMLElement;
  private billingCreditsLeft!: HTMLElement;
  private billingCreditsOf!:   HTMLElement;
  private billingFill!:        HTMLElement;
  private billingUsed!:        HTMLElement;
  private billingPct!:         HTMLElement;
  private usageCardMeta!:      HTMLElement;
  // credit-pack buttons handled via delegation in future; declared for completeness

  // Account
  private accountSignedIn!:  HTMLElement;
  private accountSignedOut!: HTMLElement;
  private accountAvatarLg!:  HTMLElement;
  private accountNameLg!:    HTMLElement;
  private accountEmailLg!:   HTMLElement;
  private signOutBtn!:       HTMLButtonElement;
  private signInBtnOptions!: HTMLButtonElement;

  // Advanced
  private paddingBefore!:    HTMLInputElement;
  private paddingAfter!:     HTMLInputElement;
  private cacheVideoCount!:  HTMLElement;
  private clearCacheBtn!:    HTMLButtonElement;

  // Save bar
  private saveBar!:    HTMLElement;
  private saveStatus!: HTMLElement;
  private saveBtn!:    HTMLButtonElement;

  // Credits widget
  private creditsWidget!: HTMLButtonElement;

  async initialize(): Promise<void> {
    this.cacheElements();
    this.setupNav();
    this.setupListeners();

    await Promise.all([
      this.loadPreferences(),
      this.loadAuthState(),
      this.loadCacheCount(),
    ]);

    this.loadCredits();
    this.readSectionFromHash();
  }

  private cacheElements(): void {
    this.navItems          = document.querySelectorAll<HTMLButtonElement>('.nav-item');
    this.contentSections   = document.querySelectorAll<HTMLElement>('.content-section');

    this.autoFilterAllVideos       = document.getElementById('autoFilterAllVideos')       as HTMLInputElement;
    this.confirmBeforeAutoFilter   = document.getElementById('confirmBeforeAutoFilter')   as HTMLInputElement;
    this.confirmBeforeAutoFilterRow= document.getElementById('confirmBeforeAutoFilterRow') as HTMLElement;
    this.autoEnableFiltered        = document.getElementById('autoEnableFiltered')        as HTMLInputElement;
    this.showTimelineMarkers       = document.getElementById('showTimelineMarkers')       as HTMLInputElement;

    this.customBlacklist  = document.getElementById('customBlacklist')  as HTMLTextAreaElement;
    this.customWhitelist  = document.getElementById('customWhitelist')  as HTMLTextAreaElement;
    this.blacklistCount   = document.getElementById('blacklistCount')   as HTMLElement;
    this.whitelistCount   = document.getElementById('whitelistCount')   as HTMLElement;

    this.sidebarCredits     = document.getElementById('sidebarCredits')     as HTMLElement;
    this.sidebarCreditsFill = document.getElementById('sidebarCreditsFill') as HTMLElement;
    this.billingCreditsLeft = document.getElementById('billingCreditsLeft') as HTMLElement;
    this.billingCreditsOf   = document.getElementById('billingCreditsOf')   as HTMLElement;
    this.billingFill        = document.getElementById('billingFill')        as HTMLElement;
    this.billingUsed        = document.getElementById('billingUsed')        as HTMLElement;
    this.billingPct         = document.getElementById('billingPct')         as HTMLElement;
    this.usageCardMeta      = document.getElementById('usageCardMeta')      as HTMLElement;
    // credit packs are static buy-links; no JS binding needed beyond the href

    this.accountSignedIn  = document.getElementById('accountSignedIn')  as HTMLElement;
    this.accountSignedOut = document.getElementById('accountSignedOut') as HTMLElement;
    this.accountAvatarLg  = document.getElementById('accountAvatarLg')  as HTMLElement;
    this.accountNameLg    = document.getElementById('accountNameLg')    as HTMLElement;
    this.accountEmailLg   = document.getElementById('accountEmailLg')   as HTMLElement;
    this.signOutBtn       = document.getElementById('signOutBtn')       as HTMLButtonElement;
    this.signInBtnOptions = document.getElementById('signInBtnOptions') as HTMLButtonElement;

    this.paddingBefore   = document.getElementById('paddingBefore')   as HTMLInputElement;
    this.paddingAfter    = document.getElementById('paddingAfter')    as HTMLInputElement;
    this.cacheVideoCount = document.getElementById('cacheVideoCount') as HTMLElement;
    this.clearCacheBtn   = document.getElementById('clearCacheBtn')   as HTMLButtonElement;

    this.saveBar    = document.getElementById('saveBar')    as HTMLElement;
    this.saveStatus = document.getElementById('saveStatus') as HTMLElement;
    this.saveBtn    = document.getElementById('saveBtn')    as HTMLButtonElement;

    this.creditsWidget = document.getElementById('creditsWidget') as HTMLButtonElement;
  }

  private setupNav(): void {
    this.navItems.forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchSection(btn.dataset.section as Section);
      });
    });
    this.creditsWidget.addEventListener('click', () => {
      this.switchSection('billing');
    });
  }

  private switchSection(section: Section): void {
    window.location.hash = section;

    this.navItems.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.section === section);
    });

    this.contentSections.forEach(el => {
      el.classList.toggle('active', el.dataset.section === section);
    });

    const showSave = SAVE_SECTIONS.includes(section);
    this.saveBar.style.display = showSave ? '' : 'none';
  }

  private readSectionFromHash(): void {
    const hash = window.location.hash.replace('#', '') as Section;
    const valid: Section[] = ['settings', 'words', 'billing', 'account', 'advanced'];
    if (valid.includes(hash)) {
      this.switchSection(hash);
    } else {
      this.switchSection('settings');
    }
  }

  private setupListeners(): void {
    // Settings toggles — autosave on change
    this.autoFilterAllVideos.addEventListener('change', () => {
      this.updateConfirmSubtoggleState();
      this.autosave();
    });
    this.confirmBeforeAutoFilter.addEventListener('change', () => this.autosave());
    this.autoEnableFiltered.addEventListener('change',    () => this.autosave());
    this.showTimelineMarkers.addEventListener('change',   () => this.autosave());

    // Word lists
    this.customBlacklist.addEventListener('input', () => {
      this.blacklistCount.textContent = this.countLines(this.customBlacklist.value).toString();
    });
    this.customWhitelist.addEventListener('input', () => {
      this.whitelistCount.textContent = this.countLines(this.customWhitelist.value).toString();
    });

    // Advanced
    this.paddingBefore.addEventListener('change', () => this.autosave());
    this.paddingAfter.addEventListener('change',  () => this.autosave());

    // Save btn
    this.saveBtn.addEventListener('click', () => this.save());

    // Cache
    this.clearCacheBtn.addEventListener('click', () => this.clearCache());

    // Account
    this.signOutBtn?.addEventListener('click',       () => this.signOut());
    this.signInBtnOptions?.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_LOGIN' }));
  }

  private countLines(value: string): number {
    return value.split('\n').filter(l => l.trim().length > 0).length;
  }

  private updateConfirmSubtoggleState(): void {
    const parentOn = this.autoFilterAllVideos.checked;
    this.confirmBeforeAutoFilter.disabled = !parentOn;
    this.confirmBeforeAutoFilterRow.classList.toggle('enabled', parentOn);
  }

  // ── Preferences ────────────────────────────────────────────

  private async loadPreferences(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_PREFERENCES' });
      if (res?.success && res.data) {
        this.prefs = res.data;
      }
    } catch { /* BG not ready */ }
    this.renderPrefs();
  }

  private renderPrefs(): void {
    this.autoFilterAllVideos.checked     = this.prefs.autoFilterAllVideos === true;
    this.confirmBeforeAutoFilter.checked = this.prefs.confirmBeforeAutoFilter === true;
    this.autoEnableFiltered.checked      = this.prefs.autoEnableForFilteredVideos !== false;
    this.showTimelineMarkers.checked     = this.prefs.showTimelineMarkers !== false;

    this.customBlacklist.value = this.prefs.customBlacklist.join('\n');
    this.customWhitelist.value = this.prefs.customWhitelist.join('\n');
    this.blacklistCount.textContent = this.prefs.customBlacklist.length.toString();
    this.whitelistCount.textContent = this.prefs.customWhitelist.length.toString();

    this.paddingBefore.value = (this.prefs.paddingBeforeMs ?? this.prefs.paddingMs).toString();
    this.paddingAfter.value  = (this.prefs.paddingAfterMs  ?? this.prefs.paddingMs).toString();

    this.updateConfirmSubtoggleState();
  }

  private collectPrefs(): Partial<UserPreferences> {
    return {
      autoFilterAllVideos:        this.autoFilterAllVideos.checked,
      confirmBeforeAutoFilter:    this.confirmBeforeAutoFilter.checked,
      autoEnableForFilteredVideos: this.autoEnableFiltered.checked,
      showTimelineMarkers:        this.showTimelineMarkers.checked,
      customBlacklist: this.customBlacklist.value.split('\n').map(l => l.trim()).filter(Boolean),
      customWhitelist: this.customWhitelist.value.split('\n').map(l => l.trim()).filter(Boolean),
      paddingBeforeMs: parseInt(this.paddingBefore.value, 10) || 100,
      paddingAfterMs:  parseInt(this.paddingAfter.value,  10) || 30,
    };
  }

  private async autosave(): Promise<void> {
    await this.save(/* silent= */ true);
  }

  private async save(silent = false): Promise<void> {
    try {
      const updates = this.collectPrefs();
      const res = await chrome.runtime.sendMessage({ type: 'SET_PREFERENCES', payload: updates });
      if (res?.success && res.data) this.prefs = res.data;
    } catch { /* offline */ }

    if (!silent) {
      this.saveStatus.textContent = '✓ Saved.';
      this.saveStatus.classList.add('saved');
      setTimeout(() => {
        this.saveStatus.textContent = 'Changes save automatically.';
        this.saveStatus.classList.remove('saved');
      }, 1800);
    }
  }

  // ── Credits ────────────────────────────────────────────────

  async loadCredits(): Promise<void> {
    if (!this.authState?.isAuthenticated) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_CREDITS' });
      if (res?.success && res.data) {
        const { available, used_this_period, plan_allocation, plan, reset_date } = res.data;
        this.renderCredits(available, used_this_period, plan_allocation, plan, reset_date);
      }
    } catch { /* offline */ }
  }

  private renderCredits(
    available: number,
    used: number,
    total: number,
    plan: string,
    resetDate?: string,
  ): void {
    const pct = Math.max(0, Math.min(1, used / total));
    const resetStr = resetDate
      ? new Date(resetDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
      : '';
    const planName = this.formatPlanName(plan);

    // Sidebar widget
    this.sidebarCredits.textContent = available.toLocaleString();
    this.sidebarCreditsFill.style.width = `${(1 - pct) * 100}%`;

    // Billing section
    this.billingCreditsLeft.textContent = available.toLocaleString();
    this.billingCreditsOf.textContent   = `of ${total.toLocaleString()} credits left`;
    this.billingFill.style.width        = `${pct * 100}%`;
    this.billingUsed.textContent        = `${used.toLocaleString()} used`;
    this.billingPct.textContent         = `${Math.round(pct * 100)}%`;
    this.usageCardMeta.textContent      = `${planName} plan · resets ${resetStr}`;
  }

  private formatPlanName(plan: string): string {
    switch (plan) {
      case 'base':         return 'Base';
      case 'professional': return 'Pro';
      case 'unlimited':    return 'Unlimited';
      default:             return 'Free';
    }
  }

  // ── Auth ────────────────────────────────────────────────────

  private async loadAuthState(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_USER_PROFILE' });
      if (res?.success && res.data) {
        this.authState = res.data as AuthState;
      } else {
        this.authState = { isAuthenticated: false, user: null, subscription: null, credits: null, token: null };
      }
    } catch {
      this.authState = { isAuthenticated: false, user: null, subscription: null, credits: null, token: null };
    }
    this.renderAccount();
  }

  private renderAccount(): void {
    if (!this.authState) return;
    const signedIn = this.authState.isAuthenticated && !!this.authState.user;
    this.accountSignedIn.style.display  = signedIn ? '' : 'none';
    this.accountSignedOut.style.display = signedIn ? 'none' : '';

    if (signedIn && this.authState.user) {
      const { full_name, email } = this.authState.user;
      const initials = (full_name ?? email ?? '?')
        .split(' ')
        .map(w => w[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
      this.accountAvatarLg.textContent = initials;
      this.accountNameLg.textContent   = full_name ?? email ?? '';
      this.accountEmailLg.textContent  = email ?? '';
    }
  }

  private async signOut(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'LOGOUT' });
      await this.loadAuthState();
    } catch { /* ignore */ }
  }

  // ── Cache ────────────────────────────────────────────────────

  private async loadCacheCount(): Promise<void> {
    try {
      const storage = await chrome.storage.local.get('cachedTranscripts');
      const count = Object.keys(storage.cachedTranscripts ?? {}).length;
      this.cacheVideoCount.textContent = count.toString();
    } catch {
      this.cacheVideoCount.textContent = '0';
    }
  }

  private async clearCache(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      this.cacheVideoCount.textContent = '0';
      this.clearCacheBtn.textContent = 'Cleared';
      setTimeout(() => { this.clearCacheBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Clear cache`; }, 1500);
    } catch { /* ignore */ }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new OptionsController().initialize();
});
