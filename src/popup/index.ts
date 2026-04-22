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
import './popup.css';

// Strictness level → severityLevels mapping
type StrictnessLevel = 'kids' | 'family' | 'adult';

const STRICTNESS_SEVERITY: Record<StrictnessLevel, UserPreferences['severityLevels']> = {
  kids:   { mild: true,  moderate: true,  severe: true,  religious: true  },
  family: { mild: false, moderate: true,  severe: true,  religious: false },
  adult:  { mild: false, moderate: false, severe: true,  religious: false },
};

const STRICTNESS_EXAMPLES: Record<StrictnessLevel, string> = {
  kids:   'hides crap, hell, & stronger',
  family: 'hides sh‑t and stronger',
  adult:  'hides only f‑word & c‑word',
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

const CREDIT_POLL_MS = 5000;
const VIDEO_POLL_MS  = 2000;

class PopupController {
  private prefs: UserPreferences = DEFAULT_PREFERENCES;
  private authState: AuthState | null = null;
  private transcriptionState: TranscriptionStateBroadcast | null = null;
  private context: PopupContext = 'off-youtube';
  private ytState: YTState = 'idle';
  private wordCount = 0;
  private creditPollTimer: number | null = null;
  private videoPollTimer:  number | null = null;

  // Elements
  private powerBtn!:          HTMLButtonElement;
  private powerDot!:          HTMLElement;
  private powerLabel!:        HTMLElement;
  private ctxHero!:           HTMLElement;
  private strictnessBtns!:    NodeListOf<HTMLButtonElement>;
  private strictnessExample!: HTMLElement;
  private modeMuteOption!:    HTMLButtonElement;
  private modeBleepOption!:   HTMLButtonElement;
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
    // arrive during startup (CREDIT_UPDATE after a just-completed filter,
    // AUTH_STATE_CHANGED from a concurrent website login) aren't dropped.
    this.setupMessageListener();

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
    window.addEventListener('unload', () => this.stopPolling());
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
    this.powerBtn          = document.getElementById('powerBtn')         as HTMLButtonElement;
    this.powerDot          = document.getElementById('powerDot')         as HTMLElement;
    this.powerLabel        = document.getElementById('powerLabel')        as HTMLElement;
    this.ctxHero           = document.getElementById('ctxHero')           as HTMLElement;
    this.strictnessBtns    = document.querySelectorAll<HTMLButtonElement>('.strictness-btn');
    this.strictnessExample = document.getElementById('strictnessExample') as HTMLElement;
    this.modeMuteOption    = document.getElementById('modeMuteOption')    as HTMLButtonElement;
    this.modeBleepOption   = document.getElementById('modeBleepOption')   as HTMLButtonElement;
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
    // Power toggle
    this.powerBtn.addEventListener('click', () => {
      const next = !this.prefs.enabled;
      this.savePrefs({ enabled: next });
    });

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

    // Add credits
    this.addCreditsBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://trysafeplay.com/billing' });
    });

    // Sign in
    this.signInBtn?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_LOGIN' });
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
    // Power button + global paused state
    const on = this.prefs.enabled;
    this.powerLabel.textContent = on ? 'On' : 'Off';
    this.powerDot.classList.toggle('off', !on);
    document.body.classList.toggle('is-paused', !on);

    // Strictness
    const level = severityToStrictness(this.prefs.severityLevels);
    this.strictnessBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === level);
    });
    this.strictnessExample.textContent = STRICTNESS_EXAMPLES[level];

    // Mode
    this.modeMuteOption.classList.toggle('active',  this.prefs.filterMode === 'mute');
    this.modeBleepOption.classList.toggle('active', this.prefs.filterMode === 'bleep');

    // Re-render the hero since its copy depends on prefs.enabled
    this.renderHero();
  }

  // ── Context detection ──────────────────────────────────────

  private async detectContext(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url ?? '';

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

      // Get video state from content script
      if (tab?.id) {
        const [videoResp, transcResp] = await Promise.all([
          chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_STATE' }).catch(() => null),
          chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPTION_STATE' }).catch(() => null),
        ]);

        if (transcResp?.success && transcResp.data) {
          this.transcriptionState = transcResp.data as TranscriptionStateBroadcast;
          this.ytState = this.phaseToYTState(this.transcriptionState.phase);
        } else if (videoResp?.success && videoResp.data) {
          this.ytState = this.videoStatusToYTState(videoResp.data.status);
          this.wordCount = videoResp.data.intervalCount ?? 0;
        }
      }
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
      case 'done':         return 'done';
      case 'error':        return 'error';
      default:             return 'idle';
    }
  }

  private videoStatusToYTState(status: string): YTState {
    switch (status) {
      case 'filtering':      return 'done';
      case 'active':         return 'done';
      case 'paused':         return 'disabled';
      case 'disabled':       return 'disabled';
      case 'error':          return 'error';
      case 'age-restricted': return 'age-restricted';
      default:               return 'idle';
    }
  }

  private renderHero(): void {
    // Master toggle overrides every other state — when paused, nothing filters.
    if (!this.prefs.enabled) {
      this.ctxHero.innerHTML = `
        <div class="ctx-badge">
          <span class="ctx-dot" style="background:var(--text-muted);box-shadow:0 0 0 3px rgba(138,134,128,0.13)"></span>
          <span class="ctx-badge-label">Paused</span>
        </div>
        <div class="ctx-title">Safeplay is paused.</div>
        <div class="ctx-sub">Nothing is being filtered. Tap <b>On</b> at the top to resume.</div>`;
      return;
    }

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
    this.creditPollTimer = window.setInterval(() => {
      if (this.authState?.isAuthenticated) this.loadCredits();
    }, CREDIT_POLL_MS);

    this.videoPollTimer = window.setInterval(() => {
      this.pollVideoState();
    }, VIDEO_POLL_MS);
  }

  private stopPolling(): void {
    if (this.creditPollTimer !== null) { clearInterval(this.creditPollTimer); this.creditPollTimer = null; }
    if (this.videoPollTimer  !== null) { clearInterval(this.videoPollTimer);  this.videoPollTimer  = null; }
  }

  private async pollVideoState(): Promise<void> {
    if (this.context !== 'watching') return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const [videoResp, transcResp] = await Promise.all([
        chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_STATE' }).catch(() => null),
        chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPTION_STATE' }).catch(() => null),
      ]);

      let changed = false;
      if (transcResp?.success && transcResp.data) {
        const next = transcResp.data as TranscriptionStateBroadcast;
        const nextState = this.phaseToYTState(next.phase);
        if (nextState !== this.ytState || next.statusText !== this.transcriptionState?.statusText) {
          this.transcriptionState = next;
          this.ytState = nextState;
          changed = true;
        }
      } else if (videoResp?.success && videoResp.data) {
        const nextState = this.videoStatusToYTState(videoResp.data.status);
        const nextCount = videoResp.data.intervalCount ?? 0;
        if (nextState !== this.ytState || nextCount !== this.wordCount) {
          this.ytState = nextState;
          this.wordCount = nextCount;
          changed = true;
        }
      }
      if (changed) this.renderHero();
    } catch { /* tab closed */ }
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'TRANSCRIPTION_STATE_CHANGED' && msg.payload && this.context === 'watching') {
        this.transcriptionState = msg.payload as TranscriptionStateBroadcast;
        this.ytState = this.phaseToYTState(this.transcriptionState.phase);
        this.renderHero();
      }
      if (msg.type === 'VIDEO_STATE_CHANGED' && msg.payload && this.context === 'watching') {
        const nextState = this.videoStatusToYTState(msg.payload.status);
        this.ytState = nextState;
        this.wordCount = msg.payload.intervalCount ?? 0;
        this.renderHero();
      }
      if (msg.type === 'PREFERENCES_UPDATED' && msg.payload) {
        this.prefs = msg.payload as UserPreferences;
        this.renderPrefs();
      }
      if (msg.type === 'AUTH_STATE_CHANGED') {
        this.loadAuthState();
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new PopupController().initialize();
});
