// SafePlay Content Script - Main Entry Point
import { ResilientInjector } from './resilient-injector';
import { VideoController } from './video-controller';
import { CaptionFilter } from './caption-filter';
import { TimelineMarkers } from './timeline-markers';
import { CreditConfirmation, showAuthRequiredMessage, showFilterErrorNotification } from './credit-confirmation';
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

const API_BASE_URL = 'https://trysafeplay.com';
// Floor for the transcription budget (applies to short/medium videos).
// The actual budget scales up with the ETA estimate for long videos —
// see SafePlayContentScript.transcriptionBudgetMs().
const TRANSCRIPTION_BUDGET_FLOOR_MS = 6 * 60 * 1000;
const FALLBACK_POLL_INTERVAL_MS = 2000;
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
  private navigationId = 0; // Incremented on each navigation to cancel stale async operations
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
      this.currentVideoId = this.getVideoIdFromUrl();

      // Check for auto-enable after a short delay (allow button to inject first)
      if (this.currentVideoId) {
        setTimeout(() => this.checkAutoEnable(), 1000);
      }
    }

    // Listen for messages from background/popup
    this.setupMessageListener();

    // Listen for URL changes (YouTube SPA)
    this.setupNavigationListener();

    log('SafePlay initialized');
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

  // Main filter flow - called when SafePlay button is clicked
  private async onFilterButtonClick(youtubeId: string): Promise<void> {
    if (this.isProcessing) {
      log('Already processing, ignoring click');
      return;
    }

    log('Filter button clicked for:', youtubeId);

    // Step 0: Check authentication via background script (uses getAuthToken with auto-refresh)
    try {
      const authResponse = await safeSendMessage<{ success: boolean; data?: { authenticated: boolean } }>({
        type: 'CHECK_AUTH_STRICT',
      });

      // Null response means extension context invalidated (extension was reloaded)
      if (!authResponse) {
        log('Extension context invalidated, showing reload message');
        this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId: youtubeId });
        return;
      }

      if (!authResponse.success || !authResponse.data?.authenticated) {
        log('User not authenticated, showing sign in modal');
        this.pendingAuthVideoId = youtubeId; // Store video ID to filter after auth
        showAuthRequiredMessage();
        return;
      }
    } catch (error) {
      log('Auth check failed:', error);
      this.pendingAuthVideoId = youtubeId; // Store video ID to filter after auth
      showAuthRequiredMessage();
      return;
    }

    this.isProcessing = true;
    this.currentVideoId = youtubeId;
    this.filteringVideoId = youtubeId;

    try {
      // Step 1: Get preview (credit cost and video info)
      this.updateButtonState({ state: 'connecting', text: 'Checking...', videoId: youtubeId });

      const previewResponse = await safeSendMessage<{ success: boolean; error?: string; data?: PreviewData }>({
        type: 'GET_PREVIEW',
        payload: { youtubeId },
      });

      // Handle extension context invalidated
      if (!previewResponse) {
        this.isProcessing = false;
        this.filteringVideoId = null;
        this.updateButtonState({ state: 'error', text: 'Reload page', error: 'Extension reloaded', videoId: youtubeId });
        return;
      }

      // Handle auth errors
      if (!previewResponse.success) {
        if (previewResponse.error?.includes('UNAUTHORIZED') || previewResponse.error?.includes('401')) {
          this.isProcessing = false;
          this.filteringVideoId = null;
          this.updateButtonState({ state: 'idle', text: 'SafePlay', videoId: youtubeId });
          showAuthRequiredMessage();
          return;
        }
        throw new Error(previewResponse.error || 'Failed to get preview');
      }

      if (!previewResponse.data) {
        throw new Error('No preview data received');
      }

      const previewData: PreviewData = previewResponse.data;
      this.lastCreditCost = previewData.creditCost;
      this.lastVideoDuration = previewData.video.duration || undefined;

      // Skip the confirmation modal when the video is cached/free, or when
      // skipNextConfirmation was explicitly set by an auto-trigger path
      // (auto-filter-all with confirmBeforeAutoFilter off, or silent
      // auto-retry after a transient error).
      if ((previewData.isCached && previewData.creditCost === 0) || this.skipNextConfirmation) {
        log(this.skipNextConfirmation ? 'Skipping confirmation (auto-trigger or retry)' : 'Video is cached, skipping confirmation');
        this.skipNextConfirmation = false;
        // Reset isProcessing since proceedWithFiltering will set it again
        this.isProcessing = false;
        await this.proceedWithFiltering(youtubeId);
        return;
      }

      // Pause video before showing confirmation dialog so user can review without missing content
      const video = this.getVideoElement();
      const videoWasPlayingBeforeDialog = !!(video && !video.paused);
      if (video && videoWasPlayingBeforeDialog) {
        video.pause();
        log('Video paused for credit confirmation');
      }

      // Show credit confirmation dialog
      this.updateButtonState({ state: 'idle', text: 'SafePlay', videoId: youtubeId });
      this.isProcessing = false;

      const confirmation = new CreditConfirmation({
        onConfirm: async () => {
          log('User confirmed filtering');
          // Pass the video state to proceedWithFiltering
          this.videoWasPlaying = videoWasPlayingBeforeDialog;
          await this.proceedWithFiltering(youtubeId);
        },
        onCancel: () => {
          log('User cancelled filtering');
          this.filteringVideoId = null;
          // Resume video if it was playing before we showed the dialog
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.updateButtonState({
        state: 'error',
        text: 'Retry',
        error: `${errorMessage} - Click to retry`,
        videoId: youtubeId,
      });
      this.isProcessing = false;
      this.filteringVideoId = null;
      // Show notification about the filtering issue
      showFilterErrorNotification();
      // Silently auto-retry after a delay
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
    // Capture navigation ID to detect if user navigates away during filtering
    const startNavigationId = this.navigationId;

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

      // Check if user navigated away during the request
      if (this.navigationId !== startNavigationId) {
        log(`Filtering aborted for ${youtubeId}: user navigated away during START_FILTER`);
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

        // Final navigation check before applying filter
        if (this.navigationId !== startNavigationId) {
          log(`Filtering aborted for ${youtubeId}: user navigated away before applying cached filter`);
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

    const navigationId = this.navigationId;
    const isStillCurrent = () =>
      this.navigationId === navigationId && this.filteringVideoId === videoId;

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
      },
      onProgress: (data) => {
        if (!isStillCurrent()) return;
        this.estimator?.setServerStatus(data.status);
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
      data?: { status: string; progress: number; transcript?: Transcript; error?: string; error_code?: string };
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

    const { status, transcript, error, error_code } = response.data;
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
    const startedAt = Date.now();
    const budgetMs = this.transcriptionBudgetMs();
    const navigationId = this.navigationId;
    const isStillCurrent = () =>
      this.navigationId === navigationId && this.filteringVideoId === videoId;

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
          data?: { status: string; progress: number; transcript?: Transcript; error?: string; error_code?: string };
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

      const { status, transcript, error, error_code } = response.data;
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

      if (isExtensionContextValid()) {
        chrome.runtime.sendMessage({
          type: 'TRANSCRIPTION_STATE_CHANGED',
          payload: broadcast,
        }).catch(() => {
          // Popup might be closed; that's fine.
        });
      }
    });
    this.estimator = estimator;
    estimator.start();
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

    // Capture navigation ID to detect if user navigates during async operations
    const startNavigationId = this.navigationId;

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

      // Check if user navigated away during initialization
      if (this.navigationId !== startNavigationId) {
        log(`Filter apply aborted for ${videoId}: user navigated away during initialization`);
        return;
      }

      this.videoController.onTranscriptReceived(transcript);

      // Apply the filter
      await this.videoController.applyFilter();

      // Check if user navigated away during filter application
      if (this.navigationId !== startNavigationId) {
        log(`Filter apply aborted for ${videoId}: user navigated away during filter application`);
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

    // Notify popup of state change (if extension context still valid)
    if (!isExtensionContextValid()) {
      log('Extension context invalidated, skipping state change notification');
      return;
    }

    chrome.runtime.sendMessage({
      type: 'VIDEO_STATE_CHANGED',
      payload: state,
    }).catch(() => {
      // Popup might not be open or extension context invalidated
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
        this.handleMessage(message).then(sendResponse);
        return true; // Keep channel open for async response
      });
    } catch (error) {
      log('Failed to setup message listener (extension context may be invalidated):', error);
    }
  }

  private async handleMessage(message: { type: string; payload?: unknown }): Promise<unknown> {
    switch (message.type) {
      case 'PREFERENCES_UPDATED': {
        const newPrefs = message.payload as UserPreferences;
        const prevShowMarkers = this.preferences.showTimelineMarkers !== false;
        const prevAutoAll = this.preferences.autoFilterAllVideos === true;
        this.preferences = newPrefs;
        this.videoController?.updatePreferences(newPrefs);
        this.captionFilter.updatePreferences(newPrefs);

        const nowShowMarkers = newPrefs.showTimelineMarkers !== false;
        if (prevShowMarkers !== nowShowMarkers) {
          if (!nowShowMarkers && this.timelineMarkers) {
            // Toggled off — tear down markers immediately.
            this.timelineMarkers.destroy();
            this.timelineMarkers = null;
            log('Timeline markers destroyed (toggled off)');
          } else if (nowShowMarkers && this.isFilterActive && !this.timelineMarkers) {
            // Toggled on while a filter is already active — materialize them
            // from the intervals the video controller already parsed.
            const muteIntervals = this.videoController?.getMuteIntervals() || [];
            const video = this.getVideoElement();
            if (video && muteIntervals.length > 0) {
              this.timelineMarkers = new TimelineMarkers({ debug: DEBUG });
              this.timelineMarkers.initialize(video, muteIntervals);
              log('Timeline markers initialized (toggled on)');
            }
          }
        }

        // If the user just turned on auto-filter-all while sitting on a
        // YouTube video page that isn't already filtering, kick one off.
        // Matches the UX of toggling it on from the options page without
        // having to refresh or navigate away.
        const nowAutoAll = newPrefs.autoFilterAllVideos === true;
        if (!prevAutoAll && nowAutoAll && this.currentVideoId && !this.isFilterActive && !this.isProcessing) {
          log('Auto-filter-all just enabled — running checkAutoEnable for current video');
          this.checkAutoEnable();
        }

        return { success: true };
      }

      case 'AUTH_STATE_CHANGED': {
        const payload = message.payload as { isAuthenticated: boolean };
        log('Auth state changed:', payload);

        // If user just authenticated and we have a pending video to filter
        if (payload.isAuthenticated && this.pendingAuthVideoId) {
          log('User authenticated, closing auth modal and starting filter for:', this.pendingAuthVideoId);

          // Close the auth modal if it's open
          const authModal = document.querySelector('.safeplay-credit-dialog-overlay');
          if (authModal) {
            authModal.remove();
          }

          // Start filtering the pending video
          const videoId = this.pendingAuthVideoId;
          this.pendingAuthVideoId = null;
          this.onFilterButtonClick(videoId);
        }
        return { success: true };
      }

      case 'GET_VIDEO_STATE': {
        return {
          success: true,
          data: this.videoController?.getState() || null,
        };
      }

      case 'GET_TRANSCRIPTION_STATE': {
        return {
          success: true,
          data: this.lastTranscriptionState,
        };
      }

      default:
        return { success: false, error: 'Unknown message type' };
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
    // Increment navigation ID to cancel any stale async operations
    this.navigationId++;
    const currentNavId = this.navigationId;
    log(`Navigation detected, navigationId: ${currentNavId}`);

    // Fully tear down the filter for the previous video. Must be destroy(),
    // not stop() — the Web Audio graph is permanently attached to the prior
    // <video> element, and if we carry it forward, the next video's audio
    // will silently bypass our gain node and play profanity unmuted while
    // the button reports "Censored". See audio-filter.ts teardownAudioGraph.
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

    // Close any active SSE connection + fallback poll + estimator tick
    this.stopTranscriptionResources();

    // Clean up timeline markers
    if (this.timelineMarkers) {
      this.timelineMarkers.destroy();
      this.timelineMarkers = null;
    }

    // Reset ALL state to prevent stale data from persisting
    this.currentVideoId = null;
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
      this.currentVideoId = this.getVideoIdFromUrl();

      // Check for auto-enable after a short delay (allow button to inject first)
      if (this.currentVideoId) {
        setTimeout(() => this.checkAutoEnable(), 500);
      }
    }
  }

  // Check if we should auto-enable filter for this video.
  // Two paths, in order of user intent:
  //   1. autoFilterAllVideos — user opted into filtering every video. Triggers
  //      regardless of whether they've filtered this one before.
  //   2. autoEnableForFilteredVideos + previously filtered — legacy behavior,
  //      triggers only for known videos.
  // Both paths are gated on master `enabled`, auth, and no in-flight filter.
  private async checkAutoEnable(): Promise<void> {
    if (!this.currentVideoId) return;
    if (this.isProcessing) return;
    if (this.isFilterActive) return;
    // Master toggle off — don't auto-trigger (would burn credits on a
    // filter that VideoController.applyFilter would then short-circuit).
    if (this.preferences.enabled === false) return;

    const autoFilterAll = this.preferences.autoFilterAllVideos === true;
    const autoEnableFiltered = this.preferences.autoEnableForFilteredVideos !== false;
    if (!autoFilterAll && !autoEnableFiltered) return;

    try {
      // First check if user is authenticated - silently skip if not
      // (don't show auth modal on navigation, only when user clicks button)
      const authResponse = await safeSendMessage<{ success: boolean; data?: { authenticated: boolean } }>({
        type: 'CHECK_AUTH_STRICT',
      });

      if (!authResponse?.success || !authResponse?.data?.authenticated) {
        log('Auto-enable skipped: user not authenticated');
        return;
      }

      if (autoFilterAll) {
        // Auto-filter-all is the user's explicit opt-in to a low-friction
        // workflow. Unless they've asked for per-video credit prompts via
        // the sub-toggle, suppress the confirmation modal. The existing
        // `skipNextConfirmation` one-shot is reused for this (same flag
        // the auto-retry path uses) so the rest of onFilterButtonClick
        // doesn't need to know about auto-filter specifically.
        const requireConfirmation = this.preferences.confirmBeforeAutoFilter === true;
        if (!requireConfirmation) {
          this.skipNextConfirmation = true;
        }
        log(`Auto-enabling filter (auto-filter-all on, confirm=${requireConfirmation}) for: ${this.currentVideoId}`);
        this.onFilterButtonClick(this.currentVideoId);
        return;
      }

      const wasFiltered = await isVideoFiltered(this.currentVideoId);
      if (wasFiltered) {
        log(`Auto-enabling filter for previously filtered video: ${this.currentVideoId}`);
        this.onFilterButtonClick(this.currentVideoId);
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
