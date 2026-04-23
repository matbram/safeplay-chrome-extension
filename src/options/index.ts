import {
  UserPreferences,
  DEFAULT_PREFERENCES,
  AuthState,
  UserProfile,
  UserSubscription,
  UserCredits,
  CreditInfo,
} from '../types';
import { subscribe as storeSubscribe } from '../utils/reactiveStore';
import './options.css';

type Section = 'settings' | 'words' | 'billing' | 'account' | 'advanced';

const SAVE_SECTIONS: Section[] = ['settings', 'words', 'advanced'];

class OptionsController {
  private prefs: UserPreferences = DEFAULT_PREFERENCES;
  private authState: AuthState | null = null;
  private storeUnsubs: Array<() => void> = [];
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
  private sidebarCreditsOf!:  HTMLElement;
  private sidebarCreditsFill!: HTMLElement;
  private billingCreditsLeft!: HTMLElement;
  private billingCreditsOf!:   HTMLElement;
  private billingFill!:        HTMLElement;
  private billingUsed!:        HTMLElement;
  private billingPct!:         HTMLElement;
  private usageCardMeta!:      HTMLElement;
  private statVideos!:         HTMLElement;
  private statAvg!:            HTMLElement;
  private statWords!:          HTMLElement;
  private creditPacks!:        NodeListOf<HTMLButtonElement>;
  private buyCreditsBtn!:      HTMLButtonElement;
  private buyCreditsLabel!:    HTMLElement;
  private selectedPack: { credits: number; price: number } = { credits: 1500, price: 9 };

  // Sidebar
  private sidebarBackBtn!:    HTMLButtonElement;

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
    this.loadTheme();
    this.setupNav();
    this.setupListeners();
    // Register the listener before any awaits so broadcasts that arrive
    // during startup (e.g. CREDIT_UPDATE after a just-completed filter) aren't dropped.
    this.setupMessageListener();
    this.setupStoreSubscriptions();
    window.addEventListener('unload', () => {
      for (const unsub of this.storeUnsubs) unsub();
      this.storeUnsubs = [];
    });

    // Paint cached account + credits first so the page never opens with
    // blank sections. Revalidation below replaces stale values once the
    // background round-trip completes.
    await this.renderFromCache();

    await Promise.all([
      this.loadPreferences(),
      this.loadAuthState(),
      this.loadCacheCount(),
    ]);

    this.loadCredits();
    this.readSectionFromHash();
  }

  // Read last-known auth + credits from chrome.storage.local and render
  // immediately — same pattern as the popup. Stale data beats a blank
  // flash for 1-2 seconds while loadAuthState / loadCredits revalidate.
  private async renderFromCache(): Promise<void> {
    try {
      const result = await chrome.storage.local.get([
        'safeplay_auth_token',
        'safeplay_user_profile',
        'safeplay_user_subscription',
        'safeplay_user_credits',
        'safeplay_credit_info',
      ]);

      const token        = (result['safeplay_auth_token']        as string           | undefined) ?? null;
      const profile      = (result['safeplay_user_profile']      as UserProfile      | undefined) ?? null;
      const subscription = (result['safeplay_user_subscription'] as UserSubscription | undefined) ?? null;
      const userCredits  = (result['safeplay_user_credits']      as UserCredits      | undefined) ?? null;
      const creditInfo   = (result['safeplay_credit_info']       as CreditInfo       | undefined) ?? null;

      this.authState = {
        isAuthenticated: !!token,
        user: profile,
        subscription,
        credits: userCredits,
        token,
      };
      this.renderAccount();

      if (this.authState.isAuthenticated && creditInfo) {
        this.renderCredits(
          creditInfo.available,
          creditInfo.used_this_period,
          creditInfo.plan_allocation,
          creditInfo.plan ?? 'free',
          creditInfo.reset_date,
        );
      }
    } catch { /* no cache yet — sections stay at their HTML default */ }
  }

  private setupMessageListener(): void {
    // All cross-surface state (preferences, auth, credits) flows through
    // reactiveStore.subscribe → chrome.storage.onChanged. No bespoke
    // runtime messages remain. Retained as a hook point.
  }

  // Reactive-store subscriptions: one listener path for auth state, driven
  // by chrome.storage.onChanged rather than bespoke runtime messages. A
  // logout triggered from the website, popup, or another options tab lands
  // here within one storage round-trip.
  private setupStoreSubscriptions(): void {
    this.storeUnsubs.push(
      storeSubscribe('authState', (next) => {
        this.authState = next;
        this.renderAccount();
        // Server-authoritative: prime fresh credits on auth flip. The
        // creditInfo subscription below covers steady-state changes.
        void this.loadCredits();
      }),
      storeSubscribe('preferences', (next) => {
        this.prefs = next;
        this.renderPrefs();
      }),
      storeSubscribe('creditInfo', (next) => {
        // Observe server-committed credit changes directly from storage —
        // no GET_CREDITS round-trip. This is the one path responsible for
        // keeping the sidebar + billing usage bars in sync.
        if (!next) return;
        this.renderCredits(
          next.available,
          next.used_this_period,
          next.plan_allocation,
          next.plan ?? '',
          next.reset_date,
        );
      }),
    );
  }

  private loadTheme(): void {
    const saved = localStorage.getItem('safeplay_theme');
    if (saved === 'dark') document.body.classList.add('dark');
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
    this.sidebarCreditsOf   = document.getElementById('sidebarCreditsOf')   as HTMLElement;
    this.sidebarCreditsFill = document.getElementById('sidebarCreditsFill') as HTMLElement;
    this.billingCreditsLeft = document.getElementById('billingCreditsLeft') as HTMLElement;
    this.billingCreditsOf   = document.getElementById('billingCreditsOf')   as HTMLElement;
    this.billingFill        = document.getElementById('billingFill')        as HTMLElement;
    this.billingUsed        = document.getElementById('billingUsed')        as HTMLElement;
    this.billingPct         = document.getElementById('billingPct')         as HTMLElement;
    this.usageCardMeta      = document.getElementById('usageCardMeta')      as HTMLElement;
    this.statVideos         = document.getElementById('statVideos')         as HTMLElement;
    this.statAvg            = document.getElementById('statAvg')            as HTMLElement;
    this.statWords          = document.getElementById('statWords')          as HTMLElement;
    this.creditPacks        = document.querySelectorAll<HTMLButtonElement>('.credit-pack');
    this.buyCreditsBtn      = document.getElementById('buyCreditsBtn')      as HTMLButtonElement;
    this.buyCreditsLabel    = document.getElementById('buyCreditsLabel')    as HTMLElement;
    this.sidebarBackBtn     = document.getElementById('sidebarBackBtn')     as HTMLButtonElement;

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
    this.signInBtnOptions?.addEventListener('click', async () => {
      // Same pattern as the popup — route through background for extension-id
      // injection, fall back to opening the auth URL directly if the
      // background can't be reached so the click never silently no-ops.
      try {
        const res = await chrome.runtime.sendMessage({ type: 'OPEN_LOGIN' });
        if (res?.success) return;
      } catch { /* fall through */ }
      const extensionId = chrome.runtime?.id ?? '';
      chrome.tabs.create({
        url: `https://trysafeplay.com/extension/auth?extensionId=${extensionId}`,
      });
    });

    // Sidebar back
    this.sidebarBackBtn?.addEventListener('click', () => window.close());

    // Credit packs
    this.creditPacks.forEach(pack => {
      pack.addEventListener('click', () => this.selectCreditPack(pack));
    });
    this.buyCreditsBtn?.addEventListener('click', () => {
      chrome.tabs.create({
        url: `https://trysafeplay.com/billing?pack=${this.selectedPack.credits}`,
      });
    });
  }

  private selectCreditPack(pack: HTMLButtonElement): void {
    this.creditPacks.forEach(p => p.classList.toggle('selected', p === pack));
    const credits = parseInt(pack.dataset.pack ?? '0', 10);
    const price   = parseInt(pack.dataset.price ?? '0', 10);
    this.selectedPack = { credits, price };
    this.buyCreditsLabel.textContent = `Buy ${credits.toLocaleString()} credits · $${price}`;
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
    let saved = false;
    let errorMsg: string | null = null;
    try {
      const updates = this.collectPrefs();
      const res = await chrome.runtime.sendMessage({ type: 'SET_PREFERENCES', payload: updates });
      if (res?.success && res.data) {
        this.prefs = res.data;
        saved = true;
      } else {
        errorMsg = (res?.error as string) || "Couldn't save — try again.";
      }
    } catch {
      errorMsg = "Couldn't save — you may be offline.";
    }

    if (saved) {
      if (!silent) {
        this.saveStatus.textContent = '✓ Saved.';
        this.saveStatus.classList.add('saved');
        this.saveStatus.classList.remove('error');
        setTimeout(() => {
          this.saveStatus.textContent = 'Changes save automatically.';
          this.saveStatus.classList.remove('saved');
        }, 1800);
      }
      return;
    }

    // Surface the failure instead of silently pretending success.
    this.saveStatus.textContent = errorMsg || 'Save failed.';
    this.saveStatus.classList.add('error');
    this.saveStatus.classList.remove('saved');
    setTimeout(() => {
      this.saveStatus.textContent = 'Changes save automatically.';
      this.saveStatus.classList.remove('error');
    }, silent ? 3000 : 2500);
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
    const planName = this.formatPlanName(plan);

    let resetStr = '';
    let daysLeft = 0;
    if (resetDate) {
      const reset = new Date(resetDate);
      resetStr = reset.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      daysLeft = Math.max(0, Math.ceil((reset.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
    }

    // Sidebar widget
    this.sidebarCredits.textContent   = available.toLocaleString();
    this.sidebarCreditsOf.textContent = `of ${total.toLocaleString()}`;
    this.sidebarCreditsFill.style.width = `${(1 - pct) * 100}%`;

    // Billing section
    this.billingCreditsLeft.textContent = available.toLocaleString();
    this.billingCreditsOf.textContent   = `of ${total.toLocaleString()} credits left`;
    this.billingFill.style.width        = `${pct * 100}%`;
    this.billingUsed.textContent        = `${used.toLocaleString()} used`;
    this.billingPct.textContent         = `${Math.round(pct * 100)}%`;
    this.usageCardMeta.textContent      = resetStr
      ? `${planName} plan · resets ${resetStr}${daysLeft > 0 ? ` (${daysLeft} days)` : ''}`
      : `${planName} plan`;

    // Stat row — derive what we can from cache + credits
    this.renderUsageStats(used);
  }

  private async renderUsageStats(used: number): Promise<void> {
    try {
      const storage = await chrome.storage.local.get('cachedTranscripts');
      const videosFiltered = Object.keys(storage.cachedTranscripts ?? {}).length;
      this.statVideos.textContent = videosFiltered.toLocaleString();
      this.statAvg.textContent    = videosFiltered > 0
        ? (used / videosFiltered).toFixed(1)
        : '—';
      this.statWords.textContent  = '—';
    } catch {
      this.statVideos.textContent = '—';
      this.statAvg.textContent    = '—';
      this.statWords.textContent  = '—';
    }
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

  // Build the default Clear Cache button contents (SVG icon + label) as
  // real DOM nodes rather than assigning innerHTML. The string is static
  // today and safe, but DOM construction removes the only innerHTML = '…'
  // assignment left in this file so future editors don't mistake it for
  // a template pattern that's safe to reuse with dynamic content.
  private renderClearCacheButton(label: string): void {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');

    const polyline = document.createElementNS(svgNS, 'polyline');
    polyline.setAttribute('points', '3 6 5 6 21 6');
    svg.appendChild(polyline);

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
    svg.appendChild(path);

    this.clearCacheBtn.replaceChildren(svg, document.createTextNode(` ${label}`));
  }

  private async clearCache(): Promise<void> {
    // Disable the button for the duration of the request so rapid clicks
    // don't fire duplicate CLEAR_CACHE messages to the background.
    if (this.clearCacheBtn.disabled) return;
    this.clearCacheBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      this.cacheVideoCount.textContent = '0';
      this.clearCacheBtn.textContent = 'Cleared';
      setTimeout(() => {
        this.renderClearCacheButton('Clear cache');
        this.clearCacheBtn.disabled = false;
      }, 1500);
    } catch {
      // Re-enable immediately on error so the user can retry.
      this.clearCacheBtn.disabled = false;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new OptionsController().initialize();
});
