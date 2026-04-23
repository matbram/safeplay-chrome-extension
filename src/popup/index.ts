import {
  UserPreferences,
  DEFAULT_PREFERENCES,
  AuthState,
  CreditInfo,
  TranscriptionStateBroadcast,
  UserProfile,
  UserSubscription,
  UserCredits,
} from '../types';
import { subscribe as storeSubscribe } from '../utils/reactiveStore';
import type { SessionState, TabSnapshot } from '../types';
import './popup.css';

// Strictness level → severityLevels mapping
type StrictnessLevel = 'kids' | 'family' | 'adult';

const STRICTNESS_SEVERITY: Record<StrictnessLevel, UserPreferences['severityLevels']> = {
  kids:   { mild: true,  moderate: true,  severe: true,  religious: true  },
  family: { mild: false, moderate: true,  severe: true,  religious: false },
  adult:  { mild: false, moderate: false, severe: true,  religious: false },
};

const STRICTNESS_EXAMPLES: Record<StrictnessLevel, string> = {
  kids:   'Safest — removes every bad word, even mild ones.',
  family: 'Removes common swears and anything stronger.',
  adult:  'Lightest — only the harshest words are removed.',
};

const AUTO_CAPTIONS = {
  always: 'Every video starts clean (uses more credits).',
  ask:    'You decide before each new video.',
  off:    'Only clean the videos you pick.',
};

function severityToStrictness(s: UserPreferences['severityLevels']): StrictnessLevel {
  if (s.mild && s.moderate && s.severe) return 'kids';
  if (!s.mild && s.moderate && s.severe) return 'family';
  if (!s.mild && !s.moderate && s.severe) return 'adult';
  return 'family';
}

// Context types
type PopupContext = 'off-youtube' | 'no-video' | 'watching';
type YTState = 'idle' | 'connecting' | 'processing' | 'almost-done' | 'done' | 'error' | 'age-restricted' | 'disabled';


class PopupController {
  private prefs: UserPreferences = DEFAULT_PREFERENCES;
  private authState: AuthState | null = null;
  private transcriptionState: TranscriptionStateBroadcast | null = null;
  private context: PopupContext = 'off-youtube';
  private ytState: YTState = 'idle';
  private wordCount = 0;
  private activeTabId: number | null = null;
  private latestSessionState: SessionState | null = null;
  private videoPollTimer:  number | null = null;
  private storeUnsubs: Array<() => void> = [];

  // Elements
  private ctxHero!:           HTMLElement;
  private strictnessBtns!:    NodeListOf<HTMLButtonElement>;
  private strictnessExample!: HTMLElement;
  private modeMuteOption!:    HTMLButtonElement;
  private modeBleepOption!:   HTMLButtonElement;
  private autoAlwaysOption!:  HTMLButtonElement;
  private autoAskOption!:     HTMLButtonElement;
  private autoOffOption!:     HTMLButtonElement;
  private autoRowCaption!:    HTMLElement;
  private themeToggleBtn!:    HTMLButtonElement;
  private usageBar!:          HTMLElement;
  private usageNumber!:       HTMLElement;
  private usageOf!:           HTMLElement;
  private usageMeta!:         HTMLElement;
  private usageFill!:         HTMLElement;
  private usageHint!:         HTMLElement;
  private addCreditsBtn!:     HTMLButtonElement;
  private accountSignedIn!:   HTMLElement;
  private accountSignedOut!:  HTMLElement;
  private accountAvatar!:     HTMLElement;
  private accountName!:       HTMLElement;
  private accountEmail!:      HTMLElement;
  private signInBtn!:         HTMLButtonElement;
  private settingsBtn!:       HTMLButtonElement;

  async initialize(): Promise<void> {
    this.cacheElements();
    this.loadTheme();
    this.setupListeners();
    // Register the broadcast listener before any awaits so updates that
    // arrive during startup (CREDIT_UPDATE after a just-completed filter)
    // aren't dropped. Auth now flows through reactiveStore.subscribe below.
    this.setupMessageListener();
    this.setupStoreSubscriptions();

    // Paint cached account + credits first so the popup never opens
    // with blank sections. Revalidation below will silently replace
    // stale values once fresh data arrives.
    await this.renderFromCache();

    await Promise.all([
      this.loadPreferences(),
      this.detectContext(),
      this.loadAuthState(),
    ]);

    this.startPolling();
    window.addEventListener('unload', () => {
      this.stopPolling();
      for (const unsub of this.storeUnsubs) unsub();
      this.storeUnsubs = [];
    });
  }

  // Subscribe to reactive-store keys so cross-surface updates (a website
  // logout, a website credit purchase, a preferences change from options)
  // reach the popup without bespoke broadcast messages. This is the one
  // path auth state travels — no polling, no AUTH_STATE_CHANGED.
  private setupStoreSubscriptions(): void {
    this.storeUnsubs.push(
      storeSubscribe('authState', (next) => {
        this.authState = next;
        this.renderAccount();
        if (next.isAuthenticated) {
          // Kick a server-side refresh on sign-in so the usage bar isn't
          // stuck on "—" waiting for the 2-minute alarm tick.
          void this.loadCredits();
        }
      }),
      storeSubscribe('preferences', (next) => {
        this.prefs = next;
        this.renderPrefs();
      }),
      storeSubscribe('creditInfo', (next) => {
        // Server-authoritative credits: whenever background commits a new
        // CreditInfo (after a filter, purchase, or the 2-min alarm), the
        // usage bar re-renders from storage without polling.
        if (!next) return;
        const planName = this.formatPlanName(next.plan ?? '');
        const resetDate = next.reset_date
          ? new Date(next.reset_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '';
        this.renderUsage(next.available, next.plan_allocation, planName, resetDate);
      }),
      storeSubscribe('sessionState', (next) => {
        // Per-tab snapshot arrives here whenever any content script pushes
        // an update. Slice on the popup's active tab and re-render the hero.
        this.latestSessionState = next;
        this.applyActiveTabSnapshot();
      }),
    );
  }

  // Slice the current SessionState on the popup's active tab and drive
  // ytState / wordCount / transcriptionState from that snapshot. Called
  // whenever sessionState changes or the active tab changes.
  private applyActiveTabSnapshot(): void {
    if (this.context !== 'watching' || this.activeTabId == null) return;
    const snap: TabSnapshot | undefined = this.latestSessionState?.byTab[this.activeTabId];
    if (!snap) return;
    if (snap.transcription) {
      this.transcriptionState = snap.transcription;
      this.ytState = this.phaseToYTState(snap.transcription.phase);
    } else {
      this.ytState = this.buttonStateToYTState(snap.buttonState, snap.filterActive);
    }
    this.wordCount = snap.intervalCount ?? 0;
    this.renderHero();
  }

  // Map a content-script ButtonStateInfo to the popup's coarser YTState.
  // Used when there's no active transcription snapshot — the button state
  // alone determines what the hero should show.
  private buttonStateToYTState(
    info: import('./../types').ButtonStateInfo | undefined,
    filterActive: boolean,
  ): YTState {
    if (!info) return filterActive ? 'done' : 'idle';
    switch (info.state) {
      case 'connecting':      return 'connecting';
      case 'downloading':     return 'connecting';
      case 'transcribing':    return 'processing';
      case 'processing':      return 'processing';
      case 'filtering':       return 'done';
      case 'paused':          return 'disabled';
      case 'error':           return 'error';
      case 'age-restricted':  return 'age-restricted';
      case 'idle':            return filterActive ? 'done' : 'idle';
      default:                return 'idle';
    }
  }

  // Read the last-known user/credit snapshot directly from
  // chrome.storage.local (no background IPC, no network) and render
  // immediately. TTLs in storage.ts are intentionally bypassed — stale
  // content beats a blank section for 1–2 seconds while the revalidate
  // round-trip completes.
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
        const planName  = this.formatPlanName(creditInfo.plan ?? '');
        const resetDate = creditInfo.reset_date
          ? new Date(creditInfo.reset_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '';
        this.renderUsage(creditInfo.available, creditInfo.plan_allocation, planName, resetDate);
      }
    } catch { /* no cache yet — sections stay at their HTML default (hidden) */ }
  }

  private cacheElements(): void {
    this.ctxHero           = document.getElementById('ctxHero')           as HTMLElement;
    this.strictnessBtns    = document.querySelectorAll<HTMLButtonElement>('.strictness-btn');
    this.strictnessExample = document.getElementById('strictnessExample') as HTMLElement;
    this.modeMuteOption    = document.getElementById('modeMuteOption')    as HTMLButtonElement;
    this.modeBleepOption   = document.getElementById('modeBleepOption')   as HTMLButtonElement;
    this.autoAlwaysOption  = document.getElementById('autoAlwaysOption')  as HTMLButtonElement;
    this.autoAskOption     = document.getElementById('autoAskOption')     as HTMLButtonElement;
    this.autoOffOption     = document.getElementById('autoOffOption')     as HTMLButtonElement;
    this.autoRowCaption    = document.getElementById('autoRowCaption')    as HTMLElement;
    this.themeToggleBtn    = document.getElementById('themeToggleBtn')    as HTMLButtonElement;
    this.usageBar          = document.getElementById('usageBar')          as HTMLElement;
    this.usageNumber       = document.getElementById('usageNumber')       as HTMLElement;
    this.usageOf           = document.getElementById('usageOf')           as HTMLElement;
    this.usageMeta         = document.getElementById('usageMeta')         as HTMLElement;
    this.usageFill         = document.getElementById('usageFill')         as HTMLElement;
    this.usageHint         = document.getElementById('usageHint')         as HTMLElement;
    this.addCreditsBtn     = document.getElementById('addCreditsBtn')     as HTMLButtonElement;
    this.accountSignedIn   = document.getElementById('accountSignedIn')   as HTMLElement;
    this.accountSignedOut  = document.getElementById('accountSignedOut')  as HTMLElement;
    this.accountAvatar     = document.getElementById('accountAvatar')     as HTMLElement;
    this.accountName       = document.getElementById('accountName')       as HTMLElement;
    this.accountEmail      = document.getElementById('accountEmail')      as HTMLElement;
    this.signInBtn         = document.getElementById('signInBtn')         as HTMLButtonElement;
    this.settingsBtn       = document.getElementById('settingsBtn')       as HTMLButtonElement;
  }

  private loadTheme(): void {
    const saved = localStorage.getItem('safeplay_theme');
    if (saved === 'dark') document.body.classList.add('dark');
  }

  private setupListeners(): void {
    // Strictness
    this.strictnessBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const level = btn.dataset.level as StrictnessLevel;
        this.savePrefs({ severityLevels: STRICTNESS_SEVERITY[level] });
      });
    });

    // Mode
    this.modeMuteOption.addEventListener('click',  () => this.savePrefs({ filterMode: 'mute'  }));
    this.modeBleepOption.addEventListener('click', () => this.savePrefs({ filterMode: 'bleep' }));

    // Auto-filter
    this.autoAlwaysOption.addEventListener('click', () =>
      this.savePrefs({ autoFilterAllVideos: true,  confirmBeforeAutoFilter: false }));
    this.autoAskOption.addEventListener('click', () =>
      this.savePrefs({ autoFilterAllVideos: true,  confirmBeforeAutoFilter: true  }));
    this.autoOffOption.addEventListener('click', () =>
      this.savePrefs({ autoFilterAllVideos: false, confirmBeforeAutoFilter: false }));

    // Theme toggle
    this.themeToggleBtn.addEventListener('click', () => {
      const isDark = document.body.classList.toggle('dark');
      try { localStorage.setItem('safeplay_theme', isDark ? 'dark' : 'light'); } catch { /* ignore */ }
    });

    // Add credits
    this.addCreditsBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://trysafeplay.com/billing' });
    });

    // Sign in — route through the background so the auth page can include
    // the extension id, but if the background isn't reachable (asleep,
    // context invalidating) fall back to opening the auth URL directly
    // so the click never silently no-ops.
    this.signInBtn?.addEventListener('click', async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'OPEN_LOGIN' });
        if (res?.success) return;
      } catch { /* fall through */ }
      const extensionId = chrome.runtime?.id ?? '';
      chrome.tabs.create({
        url: `https://trysafeplay.com/extension/auth?extensionId=${extensionId}`,
      });
    });

    // Settings
    this.settingsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage?.();
    });
  }

  private async loadPreferences(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_PREFERENCES' });
      if (res?.success && res.data) {
        this.prefs = res.data;
      }
    } catch { /* popup opened before BG ready */ }
    this.renderPrefs();
  }

  private async savePrefs(updates: Partial<UserPreferences>): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SET_PREFERENCES', payload: updates });
      if (res?.success && res.data) {
        this.prefs = res.data;
      } else {
        // Background rejected the save. Don't pretend it succeeded by
        // applying the update locally — leave this.prefs at its prior
        // value so renderPrefs restores the UI to the real, saved state.
        console.warn('[SafePlay popup] SET_PREFERENCES rejected:', res?.error);
      }
    } catch {
      // IPC/network hiccup — background may still be warming up or the
      // tab is being torn down. Keep the optimistic update; a later
      // broadcast (or the next popup open) will reconcile.
      Object.assign(this.prefs, updates);
    }
    this.renderPrefs();
  }

  private renderPrefs(): void {
    // Strictness
    const level = severityToStrictness(this.prefs.severityLevels);
    this.strictnessBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === level);
    });
    this.strictnessExample.textContent = STRICTNESS_EXAMPLES[level];

    // Mode
    this.modeMuteOption.classList.toggle('active',  this.prefs.filterMode === 'mute');
    this.modeBleepOption.classList.toggle('active', this.prefs.filterMode === 'bleep');

    // Auto-filter
    const autoAlways = this.prefs.autoFilterAllVideos && !this.prefs.confirmBeforeAutoFilter;
    const autoAsk    = this.prefs.autoFilterAllVideos &&  this.prefs.confirmBeforeAutoFilter;
    const autoOff    = !this.prefs.autoFilterAllVideos;
    this.autoAlwaysOption.classList.toggle('active', autoAlways);
    this.autoAskOption.classList.toggle('active',    autoAsk);
    this.autoOffOption.classList.toggle('active',    autoOff);
    const autoKey: keyof typeof AUTO_CAPTIONS = autoAlways ? 'always' : autoAsk ? 'ask' : 'off';
    this.autoRowCaption.textContent = AUTO_CAPTIONS[autoKey];
  }

  // ── Context detection ──────────────────────────────────────

  private async detectContext(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url ?? '';
      this.activeTabId = tab?.id ?? null;

      if (!url.includes('youtube.com')) {
        this.context = 'off-youtube';
        this.renderHero();
        return;
      }

      if (!url.includes('/watch')) {
        this.context = 'no-video';
        this.renderHero();
        return;
      }

      this.context = 'watching';
      // The sessionState subscription below feeds ytState / wordCount /
      // transcription snapshot as soon as the content script has proposed
      // its snapshot. If sessionState is already populated (cached from a
      // prior popup open), slice it now so the hero renders immediately.
      this.applyActiveTabSnapshot();
    } catch {
      this.context = 'off-youtube';
    }
    this.renderHero();
  }

  private phaseToYTState(phase: TranscriptionStateBroadcast['phase']): YTState {
    switch (phase) {
      case 'connecting':   return 'connecting';
      case 'preparing':    return 'connecting';
      case 'transcribing': return 'processing';
      case 'almost-done':  return 'almost-done';
      case 'still-working': return 'almost-done';
      case 'done':         return 'done';
      case 'error':        return 'error';
      default:             return 'idle';
    }
  }

  private renderHero(): void {
    if (this.context === 'off-youtube') {
      this.ctxHero.innerHTML = `
        <div class="ctx-title">Safeplay only runs on YouTube.</div>
        <div class="ctx-sub">Your settings below are saved and will apply the next time you open a video.</div>
        <a href="https://youtube.com" class="ctx-cta" target="_blank">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#e5232b"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>
          Open YouTube
        </a>`;
      return;
    }

    if (this.context === 'no-video') {
      this.ctxHero.innerHTML = `
        <div class="ctx-title">Ready when you are.</div>
        <div class="ctx-sub">Open any video and click the <b>Filter with Safeplay</b> button next to Subscribe.</div>`;
      return;
    }

    // watching — state-specific
    const stateMap: Record<YTState, { dot: string; pulse?: boolean; label: string; title: string; sub: string }> = {
      idle: {
        dot: 'var(--text-muted)', label: 'This video',
        title: "This video isn't filtered yet.",
        sub: 'Click <b>Filter with Safeplay</b> on the video to start.',
      },
      connecting: {
        dot: '#7c3aed', pulse: true, label: 'This video',
        title: 'Getting ready…',
        sub: 'Fetching captions for this video.',
      },
      processing: {
        dot: '#7c3aed', pulse: true, label: 'This video',
        title: 'Finding bad words…',
        sub: this.transcriptionState?.statusText || 'This takes about half a minute. You can keep watching.',
      },
      'almost-done': {
        dot: '#7c3aed', pulse: true, label: 'This video',
        title: 'Almost there…',
        sub: 'Wrapping up.',
      },
      done: {
        dot: 'var(--success)', label: 'This video',
        title: "You're protected.",
        sub: this.wordCount > 0
          ? `<b style="color:var(--accent);font-weight:700">${this.wordCount}</b> bad words being hidden in this video.`
          : 'This video is being filtered.',
      },
      error: {
        dot: 'var(--danger)', label: 'This video',
        title: "Couldn't filter this one.",
        sub: "YouTube didn't return captions. Hit Retry on the video.",
      },
      'age-restricted': {
        dot: '#d97706', label: 'This video',
        title: 'Age-restricted video.',
        sub: 'Sign into YouTube so Safeplay can read the captions.',
      },
      disabled: {
        dot: 'var(--text-muted)', label: 'This video',
        title: 'Safeplay is off here.',
        sub: 'Paused for this channel. Tap the toggle below to turn it back on.',
      },
    };

    const s = stateMap[this.ytState] ?? stateMap.idle;
    this.ctxHero.innerHTML = `
      <div class="ctx-badge">
        <span class="ctx-dot${s.pulse ? ' pulsing' : ''}" style="background:${s.dot};box-shadow:0 0 0 3px ${s.dot}22"></span>
        <span class="ctx-badge-label">${s.label}</span>
      </div>
      <div class="ctx-title">${s.title}</div>
      <div class="ctx-sub">${s.sub}</div>`;
  }

  // ── Credits / Usage ────────────────────────────────────────

  private renderUsage(available: number, total: number, plan: string, resetDate: string): void {
    this.usageBar.style.display = '';
    const pct  = Math.max(0, Math.min(1, available / total));
    const low  = pct < 0.15;
    const warn = pct < 0.30;

    this.usageNumber.textContent = available.toLocaleString();
    this.usageOf.textContent     = `of ${total.toLocaleString()} credits`;
    this.usageMeta.textContent   = `${plan} · resets ${resetDate}`;

    this.usageFill.style.width = `${pct * 100}%`;
    this.usageFill.classList.toggle('low',  low);
    this.usageFill.classList.toggle('warn', warn && !low);

    if (low) {
      this.usageHint.textContent = 'Running low.';
      this.usageHint.classList.add('low');
      this.addCreditsBtn.classList.add('urgent');
    } else if (warn) {
      this.usageHint.textContent = 'Getting low.';
      this.usageHint.classList.remove('low');
      this.addCreditsBtn.classList.add('urgent');
    } else {
      this.usageHint.textContent = '1 credit ≈ 1 minute of video.';
      this.usageHint.classList.remove('low');
      this.addCreditsBtn.classList.remove('urgent');
    }
  }

  // ── Auth ───────────────────────────────────────────────────

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
    if (this.authState?.isAuthenticated) await this.loadCredits();
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
      this.accountAvatar.textContent = initials;
      this.accountName.textContent   = full_name ?? email ?? '';
      this.accountEmail.textContent  = email ?? '';
    }
  }

  private async loadCredits(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_CREDITS' });
      if (res?.success && res.data) {
        const { available, plan_allocation, plan, reset_date } = res.data;
        const planName  = this.formatPlanName(plan ?? '');
        const resetDate = reset_date ? new Date(reset_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        this.renderUsage(available, plan_allocation, planName, resetDate);
      }
    } catch { /* offline */ }
  }

  private formatPlanName(plan: string): string {
    switch (plan) {
      case 'base':         return 'Base';
      case 'professional': return 'Pro';
      case 'unlimited':    return 'Unlimited';
      default:             return 'Free';
    }
  }

  // ── Polling ────────────────────────────────────────────────

  private startPolling(): void {
    // All polling retired: video + transcription state comes from
    // reactiveStore.subscribe('sessionState', ...) and credits from
    // subscribe('creditInfo', ...) / the 2-minute alarm. Kept as a
    // no-op hook in case a future surface wants periodic behavior.
  }

  private stopPolling(): void {
    if (this.videoPollTimer !== null) { clearInterval(this.videoPollTimer); this.videoPollTimer = null; }
  }

  private setupMessageListener(): void {
    // All cross-surface state (auth, preferences, credits, per-tab video +
    // transcription) now flows through reactiveStore.subscribe. The popup's
    // runtime message listener is intentionally empty — it's retained as a
    // hook point in case we add bespoke one-shot signals later.
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new PopupController().initialize();
});
