import {
  UserPreferences,
  DEFAULT_PREFERENCES,
  FilterMode,
  AuthState,
  TranscriptionStateBroadcast,
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
  private modeMute!:          HTMLButtonElement;
  private modeBleep!:         HTMLButtonElement;
  private modeMuteOption!:    HTMLElement;
  private modeBleepOption!:   HTMLElement;
  private mutePrevBtn!:       HTMLButtonElement;
  private bleepPrevBtn!:      HTMLButtonElement;
  private previewNotice!:     HTMLElement;
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

    // Load prefs + context in parallel
    await Promise.all([
      this.loadPreferences(),
      this.detectContext(),
    ]);

    await this.loadAuthState();
    this.setupMessageListener();
    this.startPolling();
    window.addEventListener('unload', () => this.stopPolling());
  }

  private cacheElements(): void {
    this.powerBtn          = document.getElementById('powerBtn')         as HTMLButtonElement;
    this.powerDot          = document.getElementById('powerDot')         as HTMLElement;
    this.powerLabel        = document.getElementById('powerLabel')        as HTMLElement;
    this.ctxHero           = document.getElementById('ctxHero')           as HTMLElement;
    this.strictnessBtns    = document.querySelectorAll<HTMLButtonElement>('.strictness-btn');
    this.strictnessExample = document.getElementById('strictnessExample') as HTMLElement;
    this.modeMute          = document.getElementById('modeMute')          as HTMLButtonElement;
    this.modeBleep         = document.getElementById('modeBleep')         as HTMLButtonElement;
    this.modeMuteOption    = document.getElementById('modeMuteOption')    as HTMLElement;
    this.modeBleepOption   = document.getElementById('modeBleepOption')   as HTMLElement;
    this.mutePrevBtn       = document.getElementById('mutePrevBtn')       as HTMLButtonElement;
    this.bleepPrevBtn      = document.getElementById('bleepPrevBtn')      as HTMLButtonElement;
    this.previewNotice     = document.getElementById('previewNotice')     as HTMLElement;
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
    this.modeMute.addEventListener('click',  () => this.savePrefs({ filterMode: 'mute'  }));
    this.modeBleep.addEventListener('click', () => this.savePrefs({ filterMode: 'bleep' }));

    // Preview buttons
    this.mutePrevBtn.addEventListener('click',  (e) => { e.stopPropagation(); this.playPreview('mute');  });
    this.bleepPrevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.playPreview('bleep'); });

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

  private playPreview(mode: FilterMode): void {
    this.previewNotice.textContent = `playing ${mode} preview…`;
    setTimeout(() => { this.previewNotice.textContent = ''; }, 900);
    // In a real extension, play a short audio clip here.
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
        Object.assign(this.prefs, updates);
      }
    } catch {
      Object.assign(this.prefs, updates);
    }
    this.renderPrefs();
  }

  private renderPrefs(): void {
    // Power button
    const on = this.prefs.enabled;
    this.powerLabel.textContent = on ? 'On' : 'Off';
    this.powerDot.classList.toggle('off', !on);

    // Strictness
    const level = severityToStrictness(this.prefs.severityLevels);
    this.strictnessBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === level);
    });
    this.strictnessExample.textContent = STRICTNESS_EXAMPLES[level];

    // Mode
    this.modeMuteOption.classList.toggle('active',  this.prefs.filterMode === 'mute');
    this.modeBleepOption.classList.toggle('active', this.prefs.filterMode === 'bleep');
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
      case 'error':          return 'error';
      case 'age-restricted': return 'age-restricted';
      default:               return 'idle';
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
