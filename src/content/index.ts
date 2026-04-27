// SafePlay Content Script - Main Entry Point
import { ResilientInjector } from './resilient-injector';
import { VideoController } from './video-controller';
import { CaptionFilter } from './caption-filter';
import { TimelineMarkers } from './timeline-markers';
import {
  CreditConfirmation,
  dismissCheckBackLaterNotification,
  showAuthRequiredMessage,
  showCheckBackLaterNotification,
  showFilterErrorNotification,
  showUnfilterableVideoNotification,
} from './credit-confirmation';
import { preflightVideoFilterable } from './preflight';
import { TranscriptionSSEClient } from './sse-client';
import { TimeEstimator, TranscriptionStateSnapshot } from './time-estimator';
import {
  UserPreferences,
  DEFAULT_PREFERENCES,
  Transcript,
  ButtonStateInfo,
  PreviewData,
  TranscriptionStateBroadcast,
} from '../types';
import { subscribe as storeSubscribe, proposeSelfTab } from '../utils/reactiveStore';
import {
  captureOperation,
  isOperationStale,
  bumpEpoch,
} from '../utils/operation-epoch';

const API_BASE_URL = 'https://trysafeplay.com';
// Floor for the transcription budget (applies to short/medium videos).
// The actual budget scales up with the ETA estimate for long videos —
// see SafePlayContentScript.transcriptionBudgetMs().
const TRANSCRIPTION_BUDGET_FLOOR_MS = 6 * 60 * 1000;
const FALLBACK_POLL_INTERVAL_MS = 2000;
// Grace period added on top of the server-provided eta_seconds before we
// consider a job stuck. Matches the website's own stale-threshold heuristic.
const RETRY_GRACE_SECONDS = 30;
// Conservative fallback when the server didn't send eta_seconds (old job
// row, duration unresolvable). After this much elapsed time we give up in
// session and defer to the background sweep.
const NO_ETA_GIVE_UP_SECONDS = 5 * 60;
import { addFilteredVideo, isVideoFiltered } from '../utils/storage';
import './styles.css';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[SafePlay]', ...args);
  }
}

// Check if the extension context is still valid (not invalidated by extension reload)
function isExtensionContextValid(): boolean {
  try {
    // Accessing chrome.runtime.id will throw if context is invalidated
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// Safe wrapper for chrome.runtime.sendMessage
async function safeSendMessage<T>(message: unknown): Promise<T | null> {
  if (!isExtensionContextValid()) {
    log('Extension context invalidated, skipping message');
    return null;
  }
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    // Extension context might have been invalidated during the call
    if (String(error).includes('Extension context invalidated')) {
      log('Extension context invalidated during message');
      return null;
    }
    throw error;
  }
}

class SafePlayContentScript {
  private injector: ResilientInjector;
  private videoController: VideoController | null = null;
  private captionFilter: CaptionFilter;
  private preferences: UserPreferences = DEFAULT_PREFERENCES;
  private currentVideoId: string | null = null;
  private filteringVideoId: string | null = null; // Track which video is being filtered (for Shorts)
  private isProcessing = false;
  private videoWasPlaying = false; // Track if video was playing before we paused it
  private lastIntervalCount = 0; // Store interval count for toggle restore
  private isFilterActive = false; // Track if filter is currently active
  private timelineMarkers: TimelineMarkers | null = null; // Visual markers on progress bar
  // navigationId removed — replaced by the OperationEpoch primitive in
  // src/utils/operation-epoch.ts. Async paths now capture an OperationToken
  // at entry and check isOperationStale() at every await boundary. The same
  // token also covers preference toggles and auth flip-out, not just
  // navigation, which the old navigationId field never did.
  private storeUnsubs: Array<() => void> = []; // reactiveStore subscriptions; torn down on teardown
  private initialAutoEnableTimer: ReturnType<typeof setTimeout> | null = null;
  private currentVideoIdRev = 0; // Bumps every time currentVideoId is replaced — used by waitForVideoReady to abort stale callbacks.
  private pendingAuthVideoId: string | null = null; // Track video ID when waiting for auth
  private lastCreditCost = 0; // Credit cost from preview, passed to START_FILTER for optimistic badge update
  private lastVideoDuration: number | undefined; // Duration in seconds from preview, used to compute the transcription countdown
  private autoRetryTimer: ReturnType<typeof setTimeout> | null = null; // Timer for automatic retry after error
  private skipNextConfirmation = false; // Skip credit confirmation on auto-retry
  private estimator: TimeEstimator | null = null;
  private sseClient: TranscriptionSSEClient | null = null;
  private fallbackPollTimer: ReturnType<typeof setTimeout> | null = null;
  private statusCallInFlight = false; // Ensures we only call /status/:jobId once on complete
  private jobStartedAt = 0; // Wall-clock start of transcription flow, used only for the completion log
  private lastTranscriptionState: TranscriptionStateBroadcast | null = null;
  // Per-job in-session retry tracking. The extension is allowed one retry
  // per job_id; after the second ETA+grace window we defer to the server's
  // background sweep and show the check-back-later message. Survives SSE ↔
  // polling transitions because it's keyed on job_id, not on which transport
  // happens to be active.
  private retryState: {
    jobId: string;
    retried: boolean;
    giveUpTriggered: boolean;
    retryInFlight: boolean;
    etaSeconds: number | null;
    createdAt: string | null;
    // Fallback anchor when the server didn't send created_at (old rows).
    localStartMs: number;
  } | null = null;
  // Set of job_ids we've already fired /api/filter/retry for in this
  // content-script session. Outlives retryState (which gets cleared on
  // give-up / navigation) so the contract "one retry per job_id per
  // session" holds even if the user clicks Filter again and the server's
  // dedupe hands back the same still-in-flight job.
  private retriedJobIds: Set<string> = new Set();

  constructor() {
    // Initialize resilient injector for video watch page
    this.injector = new ResilientInjector({
      onButtonClick: (youtubeId) => this.onFilterButtonClick(youtubeId),
      onToggleFilter: () => this.toggleFilterFromButton(),
      debug: DEBUG,
    });

    // Initialize video controller
    this.videoController = new VideoController({
      onStateChange: (state) => this.onVideoStateChange(state),
      debug: DEBUG,
    });

    // Initialize caption filter
    this.captionFilter = new CaptionFilter({ debug: DEBUG });
  }

  async initialize(): Promise<void> {
    log('Initializing SafePlay content script');

    // Load user preferences
    await this.loadPreferences();

    // Start injector - it handles watch page and Shorts detection internally
    this.injector.start();

    // Check if we're on a watch page or Shorts page
    if (this.isWatchPage() || this.isShortsPage()) {
      this.setCurrentVideoId(this.getVideoIdFromUrl());

      // Check for auto-enable after a short delay (allow button to inject first).
      // Stored on the instance so onNavigation can cancel it if the user
      // navigates within the first second of page load — without that, the
      // timer would still fire against whatever currentVideoId became after
      // the navigation, racing with the new page's own checkAutoEnable.
      if (this.currentVideoId) {
        this.initialAutoEnableTimer = setTimeout(() => {
          this.initialAutoEnableTimer = null;
          this.checkAutoEnable();
        }, 1000);
      }
    }

    // Listen for messages from background/popup
    this.setupMessageListener();
    this.setupStoreSubscriptions();

    // Listen for URL changes (YouTube SPA)
    this.setupNavigationListener();

    log('SafePlay initialized');
  }

  // Subscribe to reactive-store keys whose changes should drive behavior in
  // the content script. Currently: preferences (master toggle, strictness,
  // marker visibility). authState and sessionState are driven elsewhere.
  private setupStoreSubscriptions(): void {
    try {
      this.storeUnsubs.push(
        storeSubscribe('preferences', (next) => {
          this.applyPreferenceUpdate(next);
        }),
        storeSubscribe('authState', (next, prev) => {
          // Auth flipped to signed-out — every in-flight async operation
          // is now invalid (no token to call APIs with). Bump the epoch so
          // anything waiting on a server response drops its result instead
          // of acting on it.
          if (prev?.isAuthenticated && !next.isAuthenticated) {
            bumpEpoch('signed-out');
          }

          // Pending-auth resumption: if the user was waiting on a
          // sign-in before we kicked off a filter (e.g. clicked "Filter"
          // on a video while signed out), fire it now that the auth
          // state has flipped. Only fire on the false→true transition so
          // re-renders don't re-trigger.
          const becameAuthed = next.isAuthenticated && prev && !prev.isAuthenticated;
          if (becameAuthed && this.pendingAuthVideoId) {
            const pendingId = this.pendingAuthVideoId;
            this.pendingAuthVideoId = null;
            // Don't blindly resume — the user may have navigated to a
            // different video while waiting on sign-in. If the page no
            // longer matches the original click, do nothing. The user can
            // click Filter again on whatever they're now watching.
            if (this.currentVideoId !== pendingId) {
              log(`Pending-auth resumption skipped: page is on ${this.currentVideoId}, click was for ${pendingId}`);
              return;
            }
            log('authState transitioned to authenticated; resuming pending filter');
            const modal = document.querySelector('.safeplay-credit-dialog-overlay');
            if (modal) modal.remove();
            this.onFilterButtonClick(pendingId);
          }
        }),
      );
    } catch (err) {
      log('Failed to register reactiveStore subscriptions:', err);
    }
  }

  // Centralized setter for currentVideoId. Bumps a per-video revision
  // counter so waitForVideoReady callbacks can detect navigation that
  // happened while they were waiting and bail out instead of running
  // against the new video.
  private setCurrentVideoId(id: string | null): void {
    if (this.currentVideoId === id) return;
    this.currentVideoId = id;
    this.currentVideoIdRev++;
  }

  private async loadPreferences(): Promise<void> {
    try {
      const response = await safeSendMessage<{ success: boolean; data?: UserPreferences }>({
        type: 'GET_PREFERENCES',
      });

      if (response?.success && response.data) {
        this.preferences = response.data;
      }
    } catch (error) {
      log('Failed to load preferences:', error);
    }
  }

  private isWatchPage(): boolean {
    return window.location.pathname === '/watch';
  }

  private isShortsPage(): boolean {
    return window.location.pathname.startsWith('/shorts');
  }

  private getVideoIdFromUrl(): string | null {
    // Check for regular watch page
    if (this.isWatchPage()) {
      const params = new URLSearchParams(window.location.search);
      return params.get('v');
    }

    // Check for Shorts page
    if (this.isShortsPage()) {
      const match = window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
      return match ? match[1] : null;
    }

    return null;
  }

  private updateButtonState(stateInfo: ButtonStateInfo): void {
    this.injector.updateButtonState(stateInfo);
    // Mirror the state into the per-tab snapshot so the popup and any other
    // subscriber (in-player overlay, badge, future UI) renders from the
    // exact same source. proposeSelfTab is fire-and-forget; on a closed
    // popup this write has no observers but still keeps storage fresh for
    // the next open. Extension context validity is implicit in proposeSelfTab
    // (chrome.runtime.sendMessage rejects quietly if the worker is gone).
    void this.proposeTabSnapshot({
      buttonState: stateInfo,
      filterActive: this.isFilterActive,
      videoId: this.currentVideoId,
      intervalCount: this.lastIntervalCount,
    });
  }

  // Wrapper for STORE_PROPOSE writes from this content script. All
  // sessionState mutations (button state, transcription progress,
  // filter-active flips, video state ticks) flow through here.
  //
  // Throttled: at most one storage write every TAB_SNAPSHOT_THROTTLE_MS
  // (2.5s). The first write after a quiet period flushes immediately so
  // user-visible transitions (Idle → Connecting, Connecting → Filtering)
  // appear instantly in the popup. Subsequent writes within the throttle
  // window get coalesced into a single pending patch and flushed at the
  // window boundary.
  //
  // Without throttling, three call sites combined to produce 100+ writes
  // per filtered video: the transcription estimator ticks at 1Hz, the
  // VideoController fires onstate-change roughly per timeupdate event
  // (~4Hz during playback), and updateButtonState fires per estimator
  // tick. Each write went through chained-mutex commit + chrome.storage
  // fanout, dominating the service-worker logs. Coalesce here once
  // rather than throttling each call site individually (which is what
  // the previous fix attempted and missed two of three sites).
  private static readonly TAB_SNAPSHOT_THROTTLE_MS = 2500;
  private pendingTabSnapshotPatch: Partial<import('../types').TabSnapshot> | null = null;
  private tabSnapshotFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTabSnapshotFlushAt = 0;

  private proposeTabSnapshot(patch: Partial<import('../types').TabSnapshot>): Promise<void> {
    if (!isExtensionContextValid()) return Promise.resolve();

    // Merge into the pending patch (last writer wins per top-level field).
    this.pendingTabSnapshotPatch = { ...this.pendingTabSnapshotPatch, ...patch };

    const now = Date.now();
    const elapsed = now - this.lastTabSnapshotFlushAt;
    if (elapsed >= SafePlayContentScript.TAB_SNAPSHOT_THROTTLE_MS) {
      // Quiet period — flush immediately for snappy UX.
      return this.flushTabSnapshotNow();
    }

    // Inside throttle window — schedule a single trailing flush at the
    // window boundary if one isn't already scheduled.
    if (this.tabSnapshotFlushTimer === null) {
      this.tabSnapshotFlushTimer = setTimeout(() => {
        this.tabSnapshotFlushTimer = null;
        void this.flushTabSnapshotNow();
      }, SafePlayContentScript.TAB_SNAPSHOT_THROTTLE_MS - elapsed);
    }
    return Promise.resolve();
  }

  private flushTabSnapshotNow(): Promise<void> {
    if (this.tabSnapshotFlushTimer !== null) {
      clearTimeout(this.tabSnapshotFlushTimer);
      this.tabSnapshotFlushTimer = null;
    }
    const patch = this.pendingTabSnapshotPatch;
    this.pendingTabSnapshotPatch = null;
    this.lastTabSnapshotFlushAt = Date.now();
    if (!patch) return Promise.resolve();
    return proposeSelfTab(patch).catch(err => {
      log('proposeSelfTab failed (non-fatal):', err);
    });
  }

  // Schedule a silent auto-retry after a delay, dismissing the error modal automatically
  private scheduleAutoRetry(videoId: string, delayMs = 5000): void {
    // Clear any existing auto-retry timer
    if (this.autoRetryTimer) {
      clearTimeout(this.autoRetryTimer);
    }
    this.autoRetryTimer = setTimeout(() => {
      this.autoRetryTimer = null;
      // Dismiss the error modal if it's still showing
      const errorOverlay = document.querySelector('[role="dialog"]')?.closest('div[style*="z-index: 999999"]');
      if (errorOverlay) {
        errorOverlay.remove();
      }
      // Skip confirmation on retry since user already intended to filter
      this.skipNextConfirmation = true;
      log('Auto-retrying filter for:', videoId);
      this.onFilterButtonClick(videoId);
    }, delayMs);
  }

  // Get the video element. On Shorts we must target the ACTIVE reel —
  // YouTube keeps preloaded neighbor <video> elements in the DOM, and the
  // first generic `video` selector used to return the wrong one, causing
  // timeline markers to be positioned against the neighbor's duration.
  private getVideoElement(): HTMLVideoElement | null {
    return document.querySelector<HTMLVideoElement>('ytd-reel-video-renderer[is-active] video') ||
           document.querySelector<HTMLVideoElement>('#shorts-player video') ||
           document.querySelector<HTMLVideoElement>('video.html5-main-video') ||
           document.querySelector<HTMLVideoElement>('video.video-stream') ||
           document.querySelector<HTMLVideoElement>('#movie_player video') ||
           document.querySelector<HTMLVideoElement>('video');
  }

  // Resume video if it was playing before we paused it
  private resumeVideoIfNeeded(): void {
    if (this.videoWasPlaying) {
      const video = this.getVideoElement();
      if (video) {
        video.play();
        log('Video resumed');
      }
      this.videoWasPlaying = false;
    }
  }

  // Main filter flow - called when SafePlay button is clicked.
  //
  // Two structural changes from the previous version:
  //
  //   1. isProcessing is set BEFORE any awaits. Previously the guard was
  //      checked at function entry but the flag wasn't set until after
  //      auth + preflight had completed (~1s of awaits), leaving a window
  //      where two parallel entries (user click + auto-trigger) would both
  //      pass the guard and produce stacked confirmation dialogs.
  //   2. Every async result is gated by isOperationStale(). Navigation,
  //      preference toggles, and sign-out all bump the operation epoch;
  //      stale results silently drop instead of mutating UI / charging
  //      credits / filtering the wrong video.
  //
  // currentVideoId is no longer overwritten here. That's a property of the
  // page, not of the click. Use filteringVideoId to track what we're
  // operating on.
  private async onFilterButtonClick(youtubeId: string): Promise<void> {
    if (this.isProcessing) {
      log('Already processing, ignoring click');
      return;
    }

    // Close the guard gap immediately.
    this.isProcessing = true;
    this.filteringVideoId = youtubeId;
    const token = captureOperation(youtubeId);
    const stale = (): boolean => isOperationStale(token, this.currentVideoId);
    const release = (): void => {
      // Only release if we still own the flag — a confirmation-dialog flow
      // may have already handed off to proceedWithFiltering, which manages
      // isProcessing for the remainder of the lifecycle.
      if (this.filteringVideoId === youtubeId) {
        this.isProcessing = false;
        this.filteringVideoId = null;
      }
    };

    log('Filter button clicked for:', youtubeId);

    // Master toggle flip-on (synchronous; no race surface here).
    if (this.preferences.enabled === false) {
      log('Master toggle was off — flipping on before filtering');
      this.preferences = { ...this.preferences, enabled: true };
      chrome.runtime.sendMessage({
        type: 'SET_PREFERENCES',
        payload: { enabled: true },
      }).catch(() => {});
    }

    // Step 0: Auth check via background (uses getAuthToken with refresh)
    try {
      const authResponse = await safeSendMessage<{ success: boolean; data?: { authenticated: boolean } }>({
        type: 'CHECK_AUTH_STRICT',
      });

      if (stale()) { log(`onFilterButtonClick aborted post-auth: stale operation`); release(); return; }

      if (!authResponse) {
        this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId: youtubeId });
        release();
        return;
      }
      if (!authResponse.success || !authResponse.data?.authenticated) {
        log('User not authenticated, showing sign in modal');
        this.pendingAuthVideoId = youtubeId;
        release();
        showAuthRequiredMessage();
        return;
      }
    } catch (error) {
      log('Auth check failed:', error);
      if (!stale()) {
        this.pendingAuthVideoId = youtubeId;
        showAuthRequiredMessage();
      }
      release();
      return;
    }

    // Step 0.5: Pre-flight gate
    const preflight = await preflightVideoFilterable(youtubeId);
    if (stale()) { log('onFilterButtonClick aborted post-preflight: stale operation'); release(); return; }
    if (!preflight.ok) {
      log(`Pre-flight rejected ${youtubeId}: ${preflight.reason}`);
      showUnfilterableVideoNotification(preflight.reason);
      release();
      return;
    }

    try {
      this.updateButtonState({ state: 'connecting', text: 'Checking...', videoId: youtubeId });

      const previewResponse = await safeSendMessage<{ success: boolean; error?: string; data?: PreviewData }>({
        type: 'GET_PREVIEW',
        payload: { youtubeId },
      });

      if (stale()) { log('onFilterButtonClick aborted post-preview: stale operation'); release(); return; }

      if (!previewResponse) {
        this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId: youtubeId });
        release();
        return;
      }

      // The "user not signed in" case was already handled by the
      // CHECK_AUTH_STRICT gate above. A 401 here is almost always transient
      // (rotation drift between the website and the extension, retry-
      // after-refresh 401, server hiccup) — surface it through the normal
      // error path instead of popping the sign-in modal. Previously this
      // branch substring-matched the error message for "401" / "UNAUTHORIZED"
      // and re-fired showAuthRequiredMessage(), which false-positived on
      // healthy sessions.
      if (!previewResponse.success) {
        throw new Error(previewResponse.error || 'Failed to get preview');
      }

      if (!previewResponse.data) {
        throw new Error('No preview data received');
      }

      const previewData: PreviewData = previewResponse.data;
      this.lastCreditCost = previewData.creditCost;
      this.lastVideoDuration = previewData.video.duration || undefined;

      // Cached / skip-next-confirmation: hand off to proceedWithFiltering.
      // proceedWithFiltering manages its own isProcessing lifecycle, so we
      // release here to satisfy its "if (isProcessing) return" guard.
      if ((previewData.isCached && previewData.creditCost === 0) || this.skipNextConfirmation) {
        log(this.skipNextConfirmation ? 'Skipping confirmation (auto-trigger or retry)' : 'Video is cached, skipping confirmation');
        this.skipNextConfirmation = false;
        release();
        await this.proceedWithFiltering(youtubeId);
        return;
      }

      // Pause video and show confirmation dialog
      const video = this.getVideoElement();
      const videoWasPlayingBeforeDialog = !!(video && !video.paused);
      if (video && videoWasPlayingBeforeDialog) {
        video.pause();
        log('Video paused for credit confirmation');
      }

      this.updateButtonState({ state: 'idle', text: 'SafePlay', videoId: youtubeId });
      release();

      const confirmation = new CreditConfirmation({
        onConfirm: async () => {
          log('User confirmed filtering');
          // Recheck staleness — the user may have navigated while the
          // dialog was up. A confirmed dialog whose underlying page has
          // changed should NOT trigger filtering on the new page.
          if (stale()) {
            log('Confirmation accepted but operation is stale — dropping');
            return;
          }
          this.videoWasPlaying = videoWasPlayingBeforeDialog;
          await this.proceedWithFiltering(youtubeId);
        },
        onCancel: () => {
          log('User cancelled filtering');
          this.filteringVideoId = null;
          if (videoWasPlayingBeforeDialog && video) {
            video.play();
            log('Video resumed after cancel');
          }
        },
        debug: DEBUG,
      });

      confirmation.show(previewData);
    } catch (error) {
      log('Preview request failed:', error);
      if (stale()) { release(); return; }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.updateButtonState({
        state: 'error',
        text: 'Retry',
        error: `${errorMessage} - Click to retry`,
        videoId: youtubeId,
      });
      release();
      showFilterErrorNotification();
      this.scheduleAutoRetry(youtubeId);
    }
  }

  // Proceed with filtering after user confirmation or for cached videos
  private async proceedWithFiltering(youtubeId: string): Promise<void> {
    if (this.isProcessing) {
      log('Already processing, ignoring');
      return;
    }

    log('Proceeding with filtering for:', youtubeId);
    this.isProcessing = true;
    this.filteringVideoId = youtubeId;
    // Capture an operation token. Replaces the old navigationId-only check;
    // also catches preference flips and auth flip-out, not just navigation.
    const token = captureOperation(youtubeId);
    const stale = (): boolean => isOperationStale(token, this.currentVideoId);

    // Video should already be paused from the confirmation dialog
    // If not (e.g., for cached videos that skip confirmation), pause it now
    const video = this.getVideoElement();
    if (!this.videoWasPlaying) {
      // Only set videoWasPlaying if it wasn't already set by the confirmation flow
      this.videoWasPlaying = !!(video && !video.paused);
      if (video && this.videoWasPlaying) {
        video.pause();
        log('Video paused while loading filter');
      }
    }

    try {
      // Step 1: Connecting
      this.updateButtonState({ state: 'connecting', text: 'Connecting...', videoId: youtubeId });

      // Request filter from background script (uses START_FILTER which deducts credits)
      const response = await safeSendMessage<{
        success: boolean;
        error?: string;
        data?: { status: string; transcript?: Transcript; jobId?: string; error?: string; error_code?: string };
      }>({
        type: 'START_FILTER',
        payload: { youtubeId, filterType: this.preferences.filterMode, creditCost: this.lastCreditCost },
      });

      if (stale()) {
        log(`Filtering aborted for ${youtubeId}: stale post-START_FILTER`);
        return;
      }

      // Handle extension context invalidated
      if (!response) {
        this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId: youtubeId });
        this.resumeVideoIfNeeded();
        return;
      }

      if (!response.success) {
        throw new Error(response.error || 'Failed to request filter');
      }

      if (!response.data) {
        throw new Error('No filter data received');
      }

      const { status, transcript, jobId, error_code, error } = response.data;

      // Handle immediate failure with error_code
      if (status === 'failed') {
        if (error_code === 'AGE_RESTRICTED') {
          this.updateButtonState({
            state: 'age-restricted',
            text: 'Age-Restricted',
            error: error || 'This video is age-restricted by YouTube. SafePlay cannot filter age-restricted content.',
            videoId: youtubeId,
          });
        } else if (error_code === 'INSUFFICIENT_CREDITS') {
          this.updateButtonState({
            state: 'error',
            text: 'No Credits',
            error: error || 'Insufficient credits. Please purchase more credits at safeplay.app',
            videoId: youtubeId,
          });
        } else {
          this.updateButtonState({
            state: 'error',
            text: 'Retry',
            error: (error || 'Failed to filter video') + ' - Click to retry',
            videoId: youtubeId,
          });
          // Show notification about the filtering issue
          showFilterErrorNotification();
          // Silently auto-retry after a delay
          this.scheduleAutoRetry(youtubeId);
        }
        // Resume video since we can't filter
        if (this.videoWasPlaying) {
          const video = this.getVideoElement();
          if (video) {
            video.play();
            log('Video resumed after error');
          }
          this.videoWasPlaying = false;
        }
        this.isProcessing = false;
        this.filteringVideoId = null;
        return;
      }

      if ((status === 'cached' || status === 'completed') && transcript) {
        // Transcript was cached (locally or on server), skip to processing
        log('Using cached transcript');

        if (stale()) {
          log(`Filtering aborted for ${youtubeId}: stale before applying cached filter`);
          return;
        }

        this.updateButtonState({ state: 'processing', text: 'Processing...', videoId: youtubeId });
        await this.applyFilter(transcript);
      } else if (status === 'processing' && jobId) {
        // Kick off SSE for real-time updates; falls back to polling internally.
        log('Job started, opening SSE for:', jobId);
        await this.runTranscriptionFlow(jobId, youtubeId);
      } else {
        throw new Error('Unexpected API response');
      }
    } catch (error) {
      log('Filter request failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.updateButtonState({
        state: 'error',
        text: 'Retry',
        error: `${errorMessage} - Click to retry`,
        videoId: youtubeId,
      });
      // Resume video on error
      if (this.videoWasPlaying) {
        const video = this.getVideoElement();
        if (video) {
          video.play();
          log('Video resumed after error');
        }
        this.videoWasPlaying = false;
      }
      this.isProcessing = false;
      this.filteringVideoId = null;
      // Show notification about the filtering issue
      showFilterErrorNotification();
      // Silently auto-retry after a delay
      this.scheduleAutoRetry(youtubeId);
    }
  }

  // Budget for both SSE safety timer and polling fallback. Scales with
  // the ETA estimate so long videos (where transcription legitimately
  // takes tens of minutes) don't get killed at 6 minutes while the
  // server is still actively working. 2× the estimate gives comfortable
  // headroom; short/medium jobs stay at the 6-min floor.
  private transcriptionBudgetMs(): number {
    const est = this.lastTranscriptionState?.totalEstimatedSeconds;
    if (!est || est <= 0) return TRANSCRIPTION_BUDGET_FLOOR_MS;
    return Math.max(TRANSCRIPTION_BUDGET_FLOOR_MS, est * 2 * 1000);
  }

  // Open the SSE connection for live transcription updates and kick off the
  // countdown. Falls back to polling on transport/HTTP failure or if the
  // server never sends 'complete' within the transcription budget.
  private async runTranscriptionFlow(jobId: string, videoId: string): Promise<void> {
    this.jobStartedAt = Date.now();
    this.startEstimator(videoId);
    this.ensureRetryState(jobId);

    const opToken = captureOperation(videoId);
    const isStillCurrent = (): boolean =>
      !isOperationStale(opToken, this.currentVideoId) && this.filteringVideoId === videoId;

    // Ask the background for a fresh bearer token (it handles refresh).
    const authResp = await safeSendMessage<{
      success: boolean;
      data?: { authenticated: boolean; token?: string };
    }>({ type: 'GET_AUTH_STATUS' });

    if (!isStillCurrent()) return;

    const token = authResp?.data?.token;
    if (!token) {
      // Shouldn't happen (auth was checked in onFilterButtonClick), but be
      // safe: fall back to polling silently.
      log('No bearer token for SSE, falling back to polling');
      this.pollJobStatusFallback(jobId, videoId);
      return;
    }

    const budgetMs = this.transcriptionBudgetMs();
    const safetyTimer = setTimeout(() => {
      log(`SSE budget expired after ${budgetMs}ms, falling back to polling`);
      if (this.sseClient) {
        this.sseClient.close();
        this.sseClient = null;
      }
      if (isStillCurrent()) this.pollJobStatusFallback(jobId, videoId);
    }, budgetMs);

    const clearSafety = () => clearTimeout(safetyTimer);

    const client = new TranscriptionSSEClient({
      url: `${API_BASE_URL}/api/filter/events/${encodeURIComponent(jobId)}`,
      token,
      debug: DEBUG,
      onConnected: (data) => {
        if (!isStillCurrent()) return;
        log('SSE connected:', data.status);
        this.estimator?.setServerStatus(data.status);
        this.ingestJobMeta(jobId, data.eta_seconds, data.created_at);
        this.evaluateRetryOrGiveUp(jobId, videoId, data.status);
      },
      onProgress: (data) => {
        if (!isStillCurrent()) return;
        this.estimator?.setServerStatus(data.status);
        this.ingestJobMeta(jobId, data.eta_seconds, data.created_at);
        this.evaluateRetryOrGiveUp(jobId, videoId, data.status);
      },
      onComplete: async (data) => {
        clearSafety();
        if (this.sseClient) {
          this.sseClient.close();
          this.sseClient = null;
        }
        if (!isStillCurrent()) {
          log(`Ignoring SSE complete for ${data.job_id}: video changed`);
          return;
        }
        this.estimator?.markComplete();
        await this.finalizeCompletedJob(data.job_id, videoId);
      },
      onServerError: (data) => {
        clearSafety();
        if (this.sseClient) {
          this.sseClient.close();
          this.sseClient = null;
        }
        if (!isStillCurrent()) return;
        this.estimator?.markError(data.error_code, data.error);
        this.surfaceJobError(videoId, data.error, data.error_code);
      },
      onTransportError: (err) => {
        clearSafety();
        if (this.sseClient) {
          this.sseClient.close();
          this.sseClient = null;
        }
        if (!isStillCurrent()) return;
        log('SSE transport error, falling back to polling:', err.message);
        this.pollJobStatusFallback(jobId, videoId);
      },
    });

    this.sseClient = client;
    // Fire-and-forget: the client's async run loop is self-contained.
    client.start().catch((err) => {
      log('SSE start error (already handled by onTransportError):', err);
    });
  }

  // Single status call triggered by SSE 'complete'. The status route does
  // the server-side bookkeeping (credit charging, history, caching). If it
  // returns something other than a completed transcript, fall through to
  // the polling path (idempotent) to wait for server catch-up.
  private async finalizeCompletedJob(jobId: string, videoId: string): Promise<void> {
    if (this.statusCallInFlight) return;
    this.statusCallInFlight = true;

    type JobCheckResponse = {
      success: boolean;
      error?: string;
      data?: {
        status: string;
        progress: number;
        transcript?: Transcript;
        error?: string;
        error_code?: string;
        eta_seconds?: number | null;
        created_at?: string;
      };
    };
    let response: JobCheckResponse | null;
    try {
      response = await safeSendMessage<JobCheckResponse>({
        type: 'CHECK_JOB',
        payload: { jobId },
      });
    } catch (err) {
      log('CHECK_JOB failed after SSE complete:', err);
      this.statusCallInFlight = false;
      if (this.filteringVideoId === videoId) this.pollJobStatusFallback(jobId, videoId);
      return;
    }
    this.statusCallInFlight = false;

    if (this.filteringVideoId !== videoId) return;

    if (!response) {
      // Extension context invalidated
      this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId });
      this.stopTranscriptionResources();
      this.resumeVideoIfNeeded();
      this.isProcessing = false;
      this.filteringVideoId = null;
      return;
    }

    if (!response.success || !response.data) {
      log('CHECK_JOB returned unsuccessful after SSE complete, falling back to polling');
      this.pollJobStatusFallback(jobId, videoId);
      return;
    }

    const { status, transcript, error, error_code, eta_seconds, created_at } = response.data;
    this.ingestJobMeta(jobId, eta_seconds, created_at);
    if (status === 'completed' && transcript) {
      await this.applyCompletedTranscript(transcript, videoId);
      return;
    }
    if (status === 'failed') {
      this.estimator?.markError(error_code, error);
      this.surfaceJobError(videoId, error, error_code);
      return;
    }
    // Server bookkeeping hasn't caught up yet — let the fallback poller
    // wait for it. This also preserves the 6-min polling budget.
    this.pollJobStatusFallback(jobId, videoId);
  }

  // Fallback path: 2s polling loop, preserved as a safety net if SSE can't
  // connect or dies mid-stream. Gets its own 6-min budget from the moment
  // it starts.
  private async pollJobStatusFallback(jobId: string, videoId: string): Promise<void> {
    // Avoid double-starting if we're already polling (e.g. safety timer
    // fired while a previous fallback tick was in flight).
    if (this.fallbackPollTimer !== null) {
      clearTimeout(this.fallbackPollTimer);
      this.fallbackPollTimer = null;
    }

    if (!this.estimator) this.startEstimator(videoId);
    this.ensureRetryState(jobId);
    const startedAt = Date.now();
    const budgetMs = this.transcriptionBudgetMs();
    const opToken = captureOperation(videoId);
    const isStillCurrent = (): boolean =>
      !isOperationStale(opToken, this.currentVideoId) && this.filteringVideoId === videoId;

    const tick = async (): Promise<void> => {
      if (!isStillCurrent()) return;
      if (Date.now() - startedAt > budgetMs) {
        this.estimator?.markError(undefined, 'Processing timed out');
        this.surfaceJobError(videoId, 'Processing timed out', undefined);
        return;
      }

      let response;
      try {
        response = await safeSendMessage<{
          success: boolean;
          error?: string;
          data?: {
            status: string;
            progress: number;
            transcript?: Transcript;
            error?: string;
            error_code?: string;
            eta_seconds?: number | null;
            created_at?: string;
          };
        }>({ type: 'CHECK_JOB', payload: { jobId } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log('Poll error:', msg);
        this.estimator?.markError(undefined, msg);
        this.surfaceJobError(videoId, msg, undefined);
        return;
      }

      if (!isStillCurrent()) return;

      if (!response) {
        // Extension context invalidated
        this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId });
        this.stopTranscriptionResources();
        this.resumeVideoIfNeeded();
        this.isProcessing = false;
        this.filteringVideoId = null;
        return;
      }

      if (!response.success || !response.data) {
        const msg = response.error || 'Failed to check job status';
        this.estimator?.markError(undefined, msg);
        this.surfaceJobError(videoId, msg, undefined);
        return;
      }

      const { status, transcript, error, error_code, eta_seconds, created_at } = response.data;
      this.ingestJobMeta(jobId, eta_seconds, created_at);
      log(`Fallback poll status: ${status}`);

      if (status === 'completed' && transcript) {
        this.estimator?.markComplete();
        await this.applyCompletedTranscript(transcript, videoId);
        return;
      }
      if (status === 'failed') {
        this.estimator?.markError(error_code, error);
        this.surfaceJobError(videoId, error, error_code);
        return;
      }

      this.estimator?.setServerStatus(status);

      // Evaluate the in-session retry budget. If this triggers the
      // give-up path it tears down polling via stopTranscriptionResources,
      // so check afterwards and bail out instead of scheduling another tick.
      this.evaluateRetryOrGiveUp(jobId, videoId, status);
      if (!isStillCurrent() || this.retryState?.giveUpTriggered) return;

      this.fallbackPollTimer = setTimeout(tick, FALLBACK_POLL_INTERVAL_MS);
    };

    tick();
  }

  // Tear down SSE, estimator, and any pending fallback poll.
  private stopTranscriptionResources(): void {
    if (this.sseClient) {
      this.sseClient.close();
      this.sseClient = null;
    }
    if (this.estimator) {
      this.estimator.close();
      this.estimator = null;
    }
    if (this.fallbackPollTimer !== null) {
      clearTimeout(this.fallbackPollTimer);
      this.fallbackPollTimer = null;
    }
    this.statusCallInFlight = false;
    this.lastTranscriptionState = null;
    this.jobStartedAt = 0;
    // stopTranscriptionResources is only called on terminal paths
    // (success, error, give-up, navigation). The SSE→polling fallback
    // tears down the SSE client directly without calling this method, so
    // the retry state correctly survives that transition.
    this.retryState = null;
  }

  // Create the estimator and wire its updates to the button UI + popup.
  private startEstimator(videoId: string): void {
    if (this.estimator) return;
    const estimator = new TimeEstimator(this.lastVideoDuration, (state: TranscriptionStateSnapshot) => {
      const broadcast: TranscriptionStateBroadcast = {
        youtubeId: videoId,
        phase: state.phase,
        remainingSeconds: state.remainingSeconds,
        totalEstimatedSeconds: state.totalEstimatedSeconds,
        statusText: state.statusText,
        errorCode: state.errorCode,
      };
      this.lastTranscriptionState = broadcast;

      // Map estimator phase → ButtonState so existing color/icon logic still works.
      const buttonState: ButtonStateInfo['state'] =
        state.phase === 'connecting' ? 'connecting'
        : state.phase === 'done' ? 'processing'
        : state.phase === 'error' ? 'error'
        : 'transcribing';

      this.updateButtonState({
        state: buttonState,
        text: state.statusText,
        videoId,
        phase: state.phase,
        remainingSeconds: state.remainingSeconds,
        totalEstimatedSeconds: state.totalEstimatedSeconds,
        statusText: state.statusText,
      });

      // Drive the popup via the shared TabSnapshot. Throttling lives in
      // proposeTabSnapshot itself now (see TAB_SNAPSHOT_THROTTLE_MS), so
      // this just hands off the latest broadcast and lets the wrapper
      // coalesce with concurrent updates from updateButtonState and
      // onVideoStateChange. storage.onChanged delivers the eventual
      // commit to the popup's reactiveStore.subscribe('sessionState')
      // listener.
      void this.proposeTabSnapshot({ transcription: broadcast });
    });
    this.estimator = estimator;
    estimator.start();
  }

  // Set up per-job retry bookkeeping. Preserved across SSE ↔ polling
  // transitions (same jobId keeps its `retried` flag) so we never exceed
  // the one-retry-per-job-per-session rule. Called from both the SSE and
  // polling entry points.
  private ensureRetryState(jobId: string): void {
    if (this.retryState?.jobId === jobId) return;
    // If we already burned our one retry for this job_id earlier in the
    // session (user gave up, came back, and hit the server's dedupe), we
    // must NOT fire a second retry. The Set survives stopTranscriptionResources.
    const alreadyRetried = this.retriedJobIds.has(jobId);
    this.retryState = {
      jobId,
      retried: alreadyRetried,
      giveUpTriggered: false,
      retryInFlight: false,
      etaSeconds: null,
      createdAt: null,
      localStartMs: Date.now(),
    };
  }

  // Merge server-provided job metadata (eta_seconds, created_at) into the
  // retry state. Called on every status update from SSE progress events and
  // CHECK_JOB responses.
  private ingestJobMeta(
    jobId: string,
    etaSeconds?: number | null,
    createdAt?: string
  ): void {
    if (!this.retryState || this.retryState.jobId !== jobId) return;
    if (etaSeconds !== undefined) {
      // eta_seconds may be explicitly null (old job row / duration unknown);
      // preserve that — the retry evaluator treats null as "skip in-session
      // retry, use conservative fallback timeout."
      this.retryState.etaSeconds = etaSeconds;
    }
    if (createdAt) {
      this.retryState.createdAt = createdAt;
    }
  }

  // Elapsed time since the server created the job row. Falls back to the
  // local start timestamp if the server didn't send created_at.
  private elapsedSeconds(): number {
    if (!this.retryState) return 0;
    if (this.retryState.createdAt) {
      const created = Date.parse(this.retryState.createdAt);
      if (!Number.isNaN(created)) {
        return Math.max(0, (Date.now() - created) / 1000);
      }
    }
    return Math.max(0, (Date.now() - this.retryState.localStartMs) / 1000);
  }

  // Core in-session retry policy, invoked on every non-terminal status
  // update. Two windows keyed off the server's eta_seconds:
  //   * elapsed > ETA + 30s → surface the reassuring "taking longer" modal
  //     and fire the one allowed retry silently in the background.
  //   * elapsed > 2*(ETA+30)s → tear down in-session polling. Don't re-show
  //     the modal (it's either already up or the user dismissed it).
  // When eta_seconds is null (old job row / duration unknown) we skip the
  // retry entirely and use a conservative 5-minute fallback for give-up
  // (which still surfaces the modal at the give-up moment, since the user
  // hasn't seen any prior reassurance).
  private evaluateRetryOrGiveUp(jobId: string, videoId: string, status: string): void {
    const state = this.retryState;
    if (!state || state.jobId !== jobId) return;
    if (state.giveUpTriggered || state.retryInFlight) return;
    // Only evaluate for non-terminal states. completed/failed are handled
    // by the existing branches before this is called.
    if (status === 'completed' || status === 'failed') return;

    const elapsed = this.elapsedSeconds();

    // No ETA from the server → skip the in-session retry entirely per the
    // API contract; just enforce a conservative give-up deadline so we
    // don't poll forever.
    if (state.etaSeconds == null) {
      if (elapsed > NO_ETA_GIVE_UP_SECONDS) {
        log(`No eta_seconds; exceeded ${NO_ETA_GIVE_UP_SECONDS}s — giving up in session for ${jobId}`);
        this.surfaceCheckBackLater(videoId);
      }
      return;
    }

    const windowSec = state.etaSeconds + RETRY_GRACE_SECONDS;

    if (state.retried) {
      // Already used our one retry — second window means tear down polling.
      // Don't re-show the modal; either it's still up from window 1, or the
      // user dismissed it on purpose. Re-popping is annoying.
      if (elapsed > 2 * windowSec) {
        log(`Retry exhausted and elapsed ${Math.round(elapsed)}s > ${2 * windowSec}s — terminating polling for ${jobId}`);
        this.terminateInSession(videoId);
      }
      return;
    }

    if (elapsed > windowSec) {
      log(`Elapsed ${Math.round(elapsed)}s > ${windowSec}s — surfacing reassurance + firing one retry for ${jobId}`);
      // Surface the modal *before* the retry so the user sees the
      // reassurance immediately, even if the retry POST takes a moment.
      // The retry continues silently; if it succeeds and the job completes
      // the modal auto-dismisses (see applyCompletedTranscript).
      showCheckBackLaterNotification();
      state.retryInFlight = true;
      this.fireJobRetry(jobId, videoId);
    }
  }

  // Fire the one allowed retry via the background. On success we mark
  // retried=true so we never fire a second one, and leave polling/SSE
  // running — the server keeps the same job_id so the existing transport
  // stays valid. On failure we short-circuit to the check-back-later UI
  // since the contract says not to attempt a second retry.
  private async fireJobRetry(jobId: string, videoId: string): Promise<void> {
    const state = this.retryState;
    if (!state || state.jobId !== jobId) return;
    // Record the attempt EAGERLY — before awaiting — so that even if
    // retryState gets nulled mid-flight (surfaceJobError, navigation), a
    // later re-entry on the same job_id won't fire a second retry. The
    // contract is "one /api/filter/retry call per job_id per session"
    // regardless of the outcome of this call.
    this.retriedJobIds.add(jobId);
    try {
      const response = await safeSendMessage<{
        success: boolean;
        error?: string;
        data?: { jobId: string; status: string };
      }>({ type: 'RETRY_JOB', payload: { jobId } });

      if (this.retryState !== state || state.jobId !== jobId) {
        // Navigation / new job raced the retry — abandon silently. The
        // jobId is already in retriedJobIds so the one-retry contract
        // still holds if the user re-enters.
        return;
      }

      state.retryInFlight = false;

      if (!response || !response.success) {
        const errMsg = response?.error || 'Retry request failed';
        log(`Retry failed for ${jobId}: ${errMsg}`);
        // Per contract: no second retry attempt.
        state.retried = true;
        this.surfaceCheckBackLater(videoId);
        return;
      }

      state.retried = true;
      log(`Retry accepted for ${jobId}; continuing to poll same job_id`);
    } catch (err) {
      if (this.retryState === state) {
        state.retryInFlight = false;
        state.retried = true;
        log(`Retry threw for ${jobId}:`, err);
        this.surfaceCheckBackLater(videoId);
      }
    }
  }

  // Tear down in-session transport + reset processing state, leaving the
  // button in a clean idle state. Does NOT show any modal — callers decide
  // whether the user needs a message. Used by both the give-up paths
  // (with modal) and the second-window terminal path (without modal,
  // because the modal is already on screen from the first window).
  private terminateInSession(videoId: string): void {
    if (this.retryState) this.retryState.giveUpTriggered = true;
    // Cancel any pending auto-retry from an earlier error path — it would
    // re-fire onFilterButtonClick in ~5s and restart the filter, which is
    // exactly the opposite of the deferred-to-server state we're entering.
    if (this.autoRetryTimer) {
      clearTimeout(this.autoRetryTimer);
      this.autoRetryTimer = null;
    }
    this.stopTranscriptionResources();

    this.updateButtonState({
      state: 'idle',
      text: 'SafePlay',
      videoId,
    });

    if (this.videoWasPlaying) {
      const video = this.getVideoElement();
      if (video) {
        video.play();
        log('Video resumed after terminating in-session polling');
      }
      this.videoWasPlaying = false;
    }
    this.isProcessing = false;
    this.filteringVideoId = null;
  }

  // Give-up path: tear down transport AND show the friendly deferred-to-server
  // message. Used by the no-ETA fallback and by retry-failure call sites
  // (where the modal may not be on screen yet). The modal helper is
  // idempotent, so callers that may double-fire don't need to coordinate.
  private surfaceCheckBackLater(videoId: string): void {
    this.terminateInSession(videoId);
    showCheckBackLaterNotification();
  }

  // Apply a completed transcript — wraps the existing applyFilter to make
  // sure estimator/SSE resources are torn down first.
  private async applyCompletedTranscript(transcript: Transcript, videoId: string): Promise<void> {
    // Eyeball-friendly completion log for tuning the ETA formula during
    // early launch. Intentionally console-only — no persistence, no
    // reporting endpoint. Captured BEFORE stopTranscriptionResources()
    // because that clears lastTranscriptionState.
    if (this.jobStartedAt > 0) {
      const actualSec = Math.round((Date.now() - this.jobStartedAt) / 1000);
      const estimateSec = this.lastTranscriptionState?.totalEstimatedSeconds ?? null;
      const deltaSec = estimateSec != null ? actualSec - estimateSec : null;
      const sign = deltaSec != null && deltaSec >= 0 ? '+' : '';
      console.log(
        `[SafePlay ETA] video=${videoId} duration=${this.lastVideoDuration ?? '?'}s ` +
        `estimate=${estimateSec ?? '?'}s actual=${actualSec}s ` +
        `delta=${deltaSec != null ? sign + deltaSec + 's' : '?'}`
      );
      this.jobStartedAt = 0;
    }
    this.stopTranscriptionResources();
    // If the "taking longer than expected" modal is still on screen from
    // window 1, quietly remove it now that the job has actually completed.
    // No-op when the modal isn't present.
    dismissCheckBackLaterNotification();
    this.updateButtonState({ state: 'processing', text: 'Applying filter...', videoId });
    await this.applyFilter(transcript);
  }

  // Common error-surfacing for SSE server errors, failed statuses, and
  // polling timeouts. Matches the legacy behavior of the old pollJobStatus.
  private surfaceJobError(videoId: string, error?: string, error_code?: string): void {
    this.stopTranscriptionResources();

    if (error_code === 'AGE_RESTRICTED') {
      this.updateButtonState({
        state: 'age-restricted',
        text: 'Age-Restricted',
        error: error || 'This video is age-restricted by YouTube. SafePlay cannot filter age-restricted content.',
        videoId,
      });
    } else {
      const msg = (error || 'Processing failed') + ' - Click to retry';
      this.updateButtonState({
        state: 'error',
        text: 'Retry',
        error: msg,
        videoId,
      });
      showFilterErrorNotification();
      this.scheduleAutoRetry(videoId);
    }

    if (this.videoWasPlaying) {
      const video = this.getVideoElement();
      if (video) {
        video.play();
        log('Video resumed after transcription error');
      }
      this.videoWasPlaying = false;
    }
    this.isProcessing = false;
    this.filteringVideoId = null;
  }

  // Apply the filter using the transcript
  private async applyFilter(transcript: Transcript): Promise<void> {
    if (!this.videoController) {
      throw new Error('Video controller not initialized');
    }

    // Use filteringVideoId which tracks the video being filtered
    const videoId = this.filteringVideoId || this.currentVideoId;
    if (!videoId) {
      throw new Error('No video ID');
    }

    const opToken = captureOperation(videoId);
    const stale = (): boolean => isOperationStale(opToken, this.currentVideoId);

    // Log transcript structure
    log('Transcript received for filtering:', {
      id: transcript.id,
      segmentCount: transcript.segments?.length,
      sampleSegment: transcript.segments?.[0] ? {
        text: transcript.segments[0].text,
        times: `${transcript.segments[0].start_time}s - ${transcript.segments[0].end_time}s`,
      } : null,
    });

    try {
      // Initialize video controller with transcript
      await this.videoController.initialize(videoId, this.preferences);

      if (stale()) {
        log(`Filter apply aborted for ${videoId}: stale during initialization`);
        return;
      }

      this.videoController.onTranscriptReceived(transcript);

      // Apply the filter
      await this.videoController.applyFilter();

      if (stale()) {
        log(`Filter apply aborted for ${videoId}: stale during filter application`);
        return;
      }

      // Get the interval count and mute intervals for display
      const state = this.videoController.getState();
      const intervalCount = state.intervalCount || 0;
      const muteIntervals = this.videoController.getMuteIntervals();

      // Store interval count for toggle restore
      this.lastIntervalCount = intervalCount;
      this.isFilterActive = true;

      // Start caption filtering as well
      this.captionFilter.initialize(this.preferences, muteIntervals);
      this.captionFilter.start();
      log('Caption filter started');

      // Initialize timeline markers to show profanity locations on progress bar.
      // Gated on the user's showTimelineMarkers preference — see the
      // PREFERENCES_UPDATED handler for dynamic toggling mid-video.
      const showMarkers = this.preferences.showTimelineMarkers !== false;
      const video = this.getVideoElement();
      if (showMarkers && video && muteIntervals.length > 0) {
        this.timelineMarkers = new TimelineMarkers({ debug: DEBUG });
        this.timelineMarkers.initialize(video, muteIntervals);
        log('Timeline markers initialized');
      } else if (!showMarkers) {
        log('Timeline markers skipped (disabled in preferences)');
      }

      // Update button to filtering state
      this.updateButtonState({
        state: 'filtering',
        text: `Censored (${intervalCount})`,
        intervalCount,
        videoId,
      });

      log(`Filter applied successfully. ${intervalCount} profanity instances will be muted.`);

      // Store this video as filtered for auto-enable feature
      if (videoId) {
        await addFilteredVideo(videoId);
      }

      // Resume video if it was playing before
      if (this.videoWasPlaying) {
        const video = this.getVideoElement();
        if (video) {
          video.play();
          log('Video resumed after filter applied');
        }
        this.videoWasPlaying = false;
      }

      // Create player controls for toggling
      this.injectPlayerControls();
    } catch (error) {
      log('Failed to apply filter:', error);
      // Resume video even on error
      if (this.videoWasPlaying) {
        const video = this.getVideoElement();
        if (video) {
          video.play();
          log('Video resumed after filter error');
        }
        this.videoWasPlaying = false;
      }
      throw error;
    } finally {
      this.isProcessing = false;
      this.filteringVideoId = null;
    }
  }

  private injectPlayerControls(): void {
    // Check if already injected
    if (document.querySelector('.safeplay-player-controls')) return;

    // Wait for player controls to be available
    const waitForControls = () => {
      const rightControls = document.querySelector('.ytp-right-controls');
      if (rightControls) {
        this.createPlayerButton(rightControls);
      } else {
        setTimeout(waitForControls, 500);
      }
    };

    waitForControls();
  }

  private createPlayerButton(container: Element): void {
    const button = document.createElement('button');
    button.className = 'ytp-button safeplay-player-controls safeplay-active';
    button.title = 'SafePlay Filter Active - Click to toggle';
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
      </svg>
    `;

    button.addEventListener('click', () => this.toggleFilter());

    // Insert before settings button (if it's a direct child)
    const settingsButton = container.querySelector('.ytp-settings-button');
    if (settingsButton && settingsButton.parentElement === container) {
      container.insertBefore(button, settingsButton);
    } else {
      // Just prepend to the container
      container.insertBefore(button, container.firstChild);
    }
  }

  // Toggle filter from player controls button
  private async toggleFilter(): Promise<void> {
    await this.toggleFilterFromButton();
  }

  // Toggle filter on/off - called from main button or player controls
  private async toggleFilterFromButton(): Promise<void> {
    if (!this.videoController) return;

    // Master is off → click means "turn master on". The PREFERENCES_UPDATED
    // handler's resume branch will restore the filter for this video if we
    // have cached intervals, so we don't need to duplicate resume logic here.
    if (this.preferences.enabled === false) {
      log('Button click with master off — flipping master on');
      chrome.runtime.sendMessage({
        type: 'SET_PREFERENCES',
        payload: { enabled: true },
      }).catch(() => {});
      return;
    }

    const playerButton = document.querySelector('.safeplay-player-controls');

    if (this.isFilterActive) {
      // Disable filter
      this.videoController.stop();
      this.captionFilter.stop();
      this.timelineMarkers?.hide();
      this.isFilterActive = false;

      playerButton?.classList.remove('safeplay-active');
      playerButton?.setAttribute('title', 'SafePlay Filter Paused - Click to resume');

      this.updateButtonState({
        state: 'paused',
        text: 'Paused',
        intervalCount: this.lastIntervalCount,
      });

      log('Filter paused by user');
    } else if (this.currentVideoId && this.lastIntervalCount > 0) {
      // Resume filtering (we have data from before)
      this.videoController.resume();
      this.captionFilter.start();
      this.timelineMarkers?.show();
      this.isFilterActive = true;

      playerButton?.classList.add('safeplay-active');
      playerButton?.setAttribute('title', 'SafePlay Filter Active - Click to toggle');

      this.updateButtonState({
        state: 'filtering',
        text: `Censored (${this.lastIntervalCount})`,
        intervalCount: this.lastIntervalCount,
      });

      log('Filter resumed by user');
    }
  }

  private onVideoStateChange(state: ReturnType<VideoController['getState']>): void {
    log('Video state changed:', state);

    // Per-tab snapshot carries filter-active + intervalCount; popup reads
    // both via subscribe('sessionState', ...). No runtime broadcast needed.
    void this.proposeTabSnapshot({
      filterActive: state.status === 'active',
      intervalCount: state.intervalCount ?? 0,
    });
  }

  private setupMessageListener(): void {
    // Check if extension context is still valid before setting up listener
    if (!isExtensionContextValid()) {
      log('Extension context invalidated, skipping message listener setup');
      return;
    }

    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        this.handleMessage(message).then(sendResponse, (error) => {
          log('Message handler rejected:', error);
          sendResponse({ success: false, error: error?.message || 'Handler error' });
        });
        return true; // Keep channel open for async response
      });
    } catch (error) {
      log('Failed to setup message listener (extension context may be invalidated):', error);
    }
  }

  private async handleMessage(message: { type: string; payload?: unknown }): Promise<unknown> {
    switch (message.type) {
      default:
        // All cross-surface state (preferences, auth, per-tab video +
        // transcription) flows through reactiveStore.subscribe. The content
        // script no longer exposes request-response RPCs to the popup —
        // its snapshot is proposed via proposeSelfTab and read from
        // sessionState. Unknown types are dropped quietly because legacy
        // broadcasts may still arrive during a staggered reload.
        return { success: false, error: 'Unknown message type' };
    }
  }

  // Apply a new UserPreferences snapshot with the same side-effect logic
  // used by the legacy PREFERENCES_UPDATED broadcast: toggle master on/off
  // mid-video, materialize/destroy timeline markers, kick auto-filter-all
  // when it's just been enabled. Called both from the legacy message case
  // and from reactiveStore.subscribe('preferences', ...).
  private applyPreferenceUpdate(newPrefs: UserPreferences): void {
    const prevEnabled = this.preferences.enabled !== false;
    const prevShowMarkers = this.preferences.showTimelineMarkers !== false;
    const prevAutoAll = this.preferences.autoFilterAllVideos === true;
    const nowEnabledLocal = newPrefs.enabled !== false;
    const nowAutoAllLocal = newPrefs.autoFilterAllVideos === true;

    // Bump the epoch for any preference change that invalidates an in-flight
    // operation. Master flipped off → no filter should land. Auto-filter-all
    // flipped off → an in-flight checkAutoEnable should drop. The epoch is
    // bumped BEFORE this.preferences is updated so functions reading
    // captured tokens see the change immediately.
    if (prevEnabled && !nowEnabledLocal) bumpEpoch('master-off');
    if (prevAutoAll && !nowAutoAllLocal) bumpEpoch('auto-filter-all-off');

    this.preferences = newPrefs;
    this.videoController?.updatePreferences(newPrefs);
    this.captionFilter.updatePreferences(newPrefs);

    const nowEnabled = newPrefs.enabled !== false;
    if (prevEnabled && !nowEnabled && this.isFilterActive) {
      this.captionFilter.stop();
      this.timelineMarkers?.hide();
      this.isFilterActive = false;
      this.updateButtonState({
        state: 'paused',
        text: 'Paused',
        intervalCount: this.lastIntervalCount,
      });
      log('Filter paused by master toggle (popup Off)');
    } else if (!prevEnabled && nowEnabled && this.currentVideoId && this.lastIntervalCount > 0) {
      this.videoController?.resume();
      this.captionFilter.start();
      this.timelineMarkers?.show();
      this.isFilterActive = true;
      this.updateButtonState({
        state: 'filtering',
        text: `Censored (${this.lastIntervalCount})`,
        intervalCount: this.lastIntervalCount,
      });
      log('Filter resumed by master toggle (popup On)');
    }

    const nowShowMarkers = newPrefs.showTimelineMarkers !== false;
    if (prevShowMarkers !== nowShowMarkers) {
      if (!nowShowMarkers && this.timelineMarkers) {
        this.timelineMarkers.destroy();
        this.timelineMarkers = null;
        log('Timeline markers destroyed (toggled off)');
      } else if (nowShowMarkers && this.isFilterActive && !this.timelineMarkers) {
        const muteIntervals = this.videoController?.getMuteIntervals() || [];
        const video = this.getVideoElement();
        if (video && muteIntervals.length > 0) {
          this.timelineMarkers = new TimelineMarkers({ debug: DEBUG });
          this.timelineMarkers.initialize(video, muteIntervals);
          log('Timeline markers initialized (toggled on)');
        }
      }
    }

    const nowAutoAll = newPrefs.autoFilterAllVideos === true;
    if (!prevAutoAll && nowAutoAll && this.currentVideoId && !this.isFilterActive && !this.isProcessing) {
      log('Auto-filter-all just enabled — running checkAutoEnable for current video');
      this.checkAutoEnable();
    }
  }

  private setupNavigationListener(): void {
    // YouTube SPA navigation
    document.addEventListener('yt-navigate-finish', () => {
      log('YouTube navigation detected');
      this.onNavigation();
    });

    // Fallback: popstate
    window.addEventListener('popstate', () => {
      this.onNavigation();
    });
  }

  private onNavigation(): void {
    bumpEpoch('navigation');
    log(`Navigation detected`);

    // Reset the controller's per-video state. See VideoController.destroy()
    // for why this intentionally does NOT close the AudioContext — YouTube's
    // SPA reuses the same <video> element across watch pages, and the Web
    // Audio source binding is permanent per element.
    if (this.videoController) {
      this.videoController.destroy();
    }

    // Stop caption filter
    this.captionFilter.stop();

    // Cancel any pending auto-retry
    if (this.autoRetryTimer) {
      clearTimeout(this.autoRetryTimer);
      this.autoRetryTimer = null;
    }
    this.skipNextConfirmation = false;

    // Cancel the initial-page-load auto-enable timer if it hasn't fired yet.
    // Without this, a navigation within the first 1s of page load would
    // leave the timer to fire against the new page, racing with the new
    // page's own checkAutoEnable.
    if (this.initialAutoEnableTimer) {
      clearTimeout(this.initialAutoEnableTimer);
      this.initialAutoEnableTimer = null;
    }

    // Drop any throttled-but-not-yet-flushed tab-snapshot patch from the
    // previous video. We're about to overwrite the relevant fields anyway
    // (currentVideoId, filterActive, intervalCount), and the trailing
    // flush would otherwise land a stale snapshot against the new page.
    if (this.tabSnapshotFlushTimer !== null) {
      clearTimeout(this.tabSnapshotFlushTimer);
      this.tabSnapshotFlushTimer = null;
    }
    this.pendingTabSnapshotPatch = null;

    // Close any active SSE connection + fallback poll + estimator tick
    this.stopTranscriptionResources();

    // Clean up timeline markers
    if (this.timelineMarkers) {
      this.timelineMarkers.destroy();
      this.timelineMarkers = null;
    }

    // Reset ALL state to prevent stale data from persisting
    this.setCurrentVideoId(null);
    this.filteringVideoId = null;
    this.isProcessing = false;
    this.pendingAuthVideoId = null;
    this.isFilterActive = false;
    this.lastIntervalCount = 0;
    this.videoWasPlaying = false;

    // Remove player button
    const playerButton = document.querySelector('.safeplay-player-controls');
    if (playerButton) {
      playerButton.remove();
    }

    // Update video ID if on watch page or Shorts page
    if (this.isWatchPage() || this.isShortsPage()) {
      this.setCurrentVideoId(this.getVideoIdFromUrl());

      // Wait until YouTube's data layer has caught up with the new video
      // before running auto-enable. See waitForVideoReady for why we now
      // listen for yt-page-data-updated rather than just any <video>
      // element appearing — YouTube reuses the same <video> across SPA
      // navigations, so "video element exists" can fire while metadata
      // (duration, title, etc.) still reflects the previous page.
      if (this.currentVideoId) {
        this.waitForVideoReady(() => this.checkAutoEnable());
      }
    }
  }

  /**
   * Fire the callback once a <video> element is present in the DOM after an
   * SPA navigation. Resolves immediately if one is already there; otherwise
   * sets up a MutationObserver on <body> and tears it down as soon as the
   * video appears. A 5-second safety timeout fires the callback anyway so we
   * never hang forever if something unexpected happens to YouTube's DOM.
   */
  // Wait for YouTube's SPA to actually finish loading the new video's data
  // before running the callback. The previous version checked only for the
  // presence of a <video> element, but YouTube REUSES the same <video>
  // across SPA navigations — so getVideoElement() can return immediately
  // while the underlying metadata (duration, title, etc.) still reflects
  // the previous page. Auto-enable would then make decisions on stale
  // information.
  //
  // The right signal is `yt-page-data-updated`, which YouTube fires once
  // its data layer has caught up with the URL. Listen for that one event,
  // with a 5s safety fallback if it doesn't arrive.
  //
  // Also captures the per-video revision counter at registration time and
  // re-checks before firing the callback. If the user navigates again
  // before this fires, the callback drops silently — the new navigation's
  // own waitForVideoReady will queue its own callback.
  private waitForVideoReady(callback: () => void): void {
    const rev = this.currentVideoIdRev;
    let fired = false;

    const fire = (reason: string): void => {
      if (fired) return;
      fired = true;
      document.removeEventListener('yt-page-data-updated', onUpdated);
      window.clearTimeout(timeoutId);
      if (this.currentVideoIdRev !== rev) {
        log(`waitForVideoReady: dropping callback (${reason}); navigated again before ready`);
        return;
      }
      callback();
    };

    const onUpdated = (): void => fire('yt-page-data-updated');
    document.addEventListener('yt-page-data-updated', onUpdated, { once: true });

    // YouTube has been observed to skip yt-page-data-updated on certain
    // back/forward navigations. The 5s fallback ensures auto-enable still
    // runs in those cases — slightly stale metadata is better than no
    // auto-enable at all.
    const timeoutId = window.setTimeout(() => fire('5s safety timeout'), 5000);
  }

  // Check if we should auto-enable filter for this video.
  // Two paths, in order of user intent:
  //   1. autoFilterAllVideos — user opted into filtering every video. Triggers
  //      regardless of whether they've filtered this one before.
  //   2. autoEnableForFilteredVideos + previously filtered — legacy behavior,
  //      triggers only for known videos.
  // Both paths are gated on master `enabled`, auth, and no in-flight filter.
  private async checkAutoEnable(): Promise<void> {
    // Capture identity at entry. Every read of `this.currentVideoId` and
    // `this.preferences` after an await must check against this token —
    // otherwise a navigation, master-off, or autoFilterAll-off during the
    // await silently filters the wrong video (or filters one the user no
    // longer wants filtered).
    const videoId = this.currentVideoId;
    if (!videoId) return;
    if (this.isProcessing) return;
    if (this.isFilterActive) return;
    if (this.preferences.enabled === false) return;

    const autoFilterAll = this.preferences.autoFilterAllVideos === true;
    const autoEnableFiltered = this.preferences.autoEnableForFilteredVideos !== false;
    if (!autoFilterAll && !autoEnableFiltered) return;

    const token = captureOperation(videoId);
    const stale = (): boolean => isOperationStale(token, this.currentVideoId);

    try {
      // Auth: silent skip when signed out (don't pop a sign-in modal on
      // navigation; only on explicit user click).
      const authResponse = await safeSendMessage<{ success: boolean; data?: { authenticated: boolean } }>({
        type: 'CHECK_AUTH_STRICT',
      });

      if (stale()) { log('Auto-enable aborted post-auth: stale operation'); return; }

      if (!authResponse?.success || !authResponse?.data?.authenticated) {
        log('Auto-enable skipped: user not authenticated');
        return;
      }

      // No need for a second explicit master-enabled / auto-filter-all
      // recheck here: applyPreferenceUpdate calls bumpEpoch('master-off')
      // and bumpEpoch('auto-filter-all-off') the moment those flip, so a
      // stale() check at the next await boundary already covers it. We
      // do still snapshot autoFilterAll here to choose which sub-path to
      // run — captured at function entry, used here.

      if (autoFilterAll) {
        const requireConfirmation = this.preferences.confirmBeforeAutoFilter === true;
        if (!requireConfirmation) {
          this.skipNextConfirmation = true;
        }
        log(`Auto-enabling filter (auto-filter-all on, confirm=${requireConfirmation}) for: ${videoId}`);
        this.onFilterButtonClick(videoId);
        return;
      }

      // Storage lookup of "did the user previously filter this video".
      // Pass the captured videoId — if currentVideoId has changed during
      // the await, we want the answer for the ORIGINAL operation, not the
      // new page.
      const wasFiltered = await isVideoFiltered(videoId);
      if (stale()) { log('Auto-enable aborted post-isVideoFiltered: stale operation'); return; }
      if (wasFiltered) {
        log(`Auto-enabling filter for previously filtered video: ${videoId}`);
        this.onFilterButtonClick(videoId);
      }
    } catch (error) {
      log('Error checking auto-enable:', error);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const safeplay = new SafePlayContentScript();
    safeplay.initialize();
  });
} else {
  const safeplay = new SafePlayContentScript();
  safeplay.initialize();
}
