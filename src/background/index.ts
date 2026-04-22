// SafePlay Background Service Worker
import {
  Message,
  MessageResponse,
  Transcript,
  UserPreferences,
  JobStatusResponse,
  CreditInfo,
  PreviewData,
  FilterConfirmPayload,
  AuthState,
} from '../types';
import {
  getPreferences,
  setPreferences,
  getCachedTranscript,
  setCachedTranscript,
  getAuthToken,
  clearCachedTranscripts,
  isAuthenticated,
  getCreditInfo,
  setCreditInfo,
  clearAuthData,
  getFullAuthState,
  STORAGE_KEYS,
} from '../utils/storage';
import {
  requestFilter,
  checkJobStatus,
  retryFilterJob,
  getPreview,
  startFilter,
  getCreditBalance,
  getUserProfile,
  recordCachedHistory,
} from '../api/client';

function log(...args: unknown[]): void {
  // Always log for debugging
  console.log('[SafePlay BG]', ...args);
}

function logError(...args: unknown[]): void {
  // Promote any Error arg's .stack to a second console.error line so the
  // stack trace survives text-only log extraction (support copy-paste, CI
  // capture). Chrome's devtools panel renders Error objects with an
  // expandable stack inline, but plain console readers only see the
  // .toString() (name + message).
  console.error('[SafePlay BG ERROR]', ...args);
  for (const arg of args) {
    if (arg instanceof Error && arg.stack) {
      console.error(arg.stack);
    }
  }
}

// Track credit costs for in-flight processing jobs so we can update
// the badge optimistically when they complete (before the API catches up).
// Persisted so the mapping survives service worker suspension between
// starting a job and receiving its completion status.
const PENDING_JOB_COSTS_KEY = 'safeplay_pending_job_costs';
const PENDING_JOB_COST_TTL_MS = 24 * 60 * 60 * 1000;

type PendingJobCostEntry = { cost: number; createdAt: number };
type PendingJobCostsMap = Record<string, PendingJobCostEntry>;

async function readPendingJobCosts(): Promise<PendingJobCostsMap> {
  const result = await chrome.storage.local.get(PENDING_JOB_COSTS_KEY);
  const raw = result[PENDING_JOB_COSTS_KEY];
  if (!raw || typeof raw !== 'object') return {};
  const now = Date.now();
  const pruned: PendingJobCostsMap = {};
  for (const [jobId, entry] of Object.entries(raw as PendingJobCostsMap)) {
    if (
      entry &&
      typeof entry.cost === 'number' &&
      typeof entry.createdAt === 'number' &&
      now - entry.createdAt < PENDING_JOB_COST_TTL_MS
    ) {
      pruned[jobId] = entry;
    }
  }
  return pruned;
}

async function setPendingJobCost(jobId: string, cost: number): Promise<void> {
  const costs = await readPendingJobCosts();
  costs[jobId] = { cost, createdAt: Date.now() };
  await chrome.storage.local.set({ [PENDING_JOB_COSTS_KEY]: costs });
}

async function takePendingJobCost(jobId: string): Promise<number | undefined> {
  const costs = await readPendingJobCosts();
  const entry = costs[jobId];
  if (entry) {
    delete costs[jobId];
  }
  await chrome.storage.local.set({ [PENDING_JOB_COSTS_KEY]: costs });
  return entry?.cost;
}

async function deletePendingJobCost(jobId: string): Promise<void> {
  const costs = await readPendingJobCosts();
  if (!(jobId in costs)) return;
  delete costs[jobId];
  await chrome.storage.local.set({ [PENDING_JOB_COSTS_KEY]: costs });
}

// Optimistically deduct credits and update badge immediately.
// Reads directly from storage (bypassing cache TTL) and calls updateBadge()
// directly (not relying on the storage change listener) for reliability.
async function deductCreditsOptimistic(creditCost: number): Promise<void> {
  const result = await chrome.storage.local.get('safeplay_credit_info');
  const currentInfo = result['safeplay_credit_info'] as CreditInfo | undefined;
  if (!currentInfo) return;

  // Validate the stored shape before doing arithmetic. A corrupt or
  // schema-drifted entry could have string / undefined / NaN in these
  // fields; subtracting NaN produces NaN, which Math.max preserves,
  // which then ends up written back to storage and rendered as "NaN"
  // on the badge. Treat validation failure as "skip optimistic update
  // and let the next server refresh reconcile."
  if (
    typeof currentInfo.available !== 'number' ||
    !Number.isFinite(currentInfo.available) ||
    typeof currentInfo.used_this_period !== 'number' ||
    !Number.isFinite(currentInfo.used_this_period) ||
    typeof currentInfo.plan_allocation !== 'number' ||
    !Number.isFinite(currentInfo.plan_allocation)
  ) {
    logError('Stored credit_info has non-numeric fields; skipping optimistic deduction:', currentInfo);
    return;
  }

  const updatedInfo: CreditInfo = {
    ...currentInfo,
    available: Math.max(0, currentInfo.available - creditCost),
    used_this_period: currentInfo.used_this_period + creditCost,
    percent_consumed: Math.min(
      100,
      ((currentInfo.used_this_period + creditCost) / currentInfo.plan_allocation) * 100
    ),
  };
  await setCreditInfo(updatedInfo);
  updateBadge(updatedInfo);
}

// Badge management - shows remaining credits on extension icon
function updateBadge(creditInfo: CreditInfo | null): void {
  if (!creditInfo) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  const { available } = creditInfo;
  const text = available.toString();

  chrome.action.setBadgeText({ text });

  // Color-code: green for healthy, orange for low, red for empty
  let color: string;
  if (available === 0) {
    color = '#F44336'; // Red
  } else if (available <= 5) {
    color = '#FF9800'; // Orange
  } else {
    color = '#4CAF50'; // Green
  }
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadge(): void {
  chrome.action.setBadgeText({ text: '' });
}

// Listen for credit info changes in storage to keep badge in sync
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes.safeplay_credit_info) {
    const newValue = changes.safeplay_credit_info.newValue as CreditInfo | undefined;
    updateBadge(newValue || null);
  }
});

// Restore badge from storage on every service worker wake-up.
// Reads directly from storage ignoring cache TTL — even "stale" data is better than an empty badge.
// This is fast (local storage only, no network) so it completes before the worker can be killed.
chrome.storage.local.get('safeplay_credit_info').then((result) => {
  const creditInfo = result['safeplay_credit_info'] as CreditInfo | undefined;
  if (creditInfo) {
    updateBadge(creditInfo);
  }
});

// Full initialization: fetch fresh credits from API if authenticated.
// Called from onInstalled/onStartup event handlers where Chrome keeps the worker alive.
async function initBadge(): Promise<void> {
  try {
    const token = await getAuthToken();
    if (!token) {
      clearBadge();
      return;
    }

    const response = await getCreditBalance();
    if (response.success && response.credits) {
      await setCreditInfo(response.credits);
    }
  } catch {
    // Ignore errors — badge will update on next alarm or credit fetch
  }
}

// Periodic credit refresh via chrome.alarms — keeps badge accurate in real-time
const CREDIT_REFRESH_ALARM = 'safeplay_credit_refresh';
const CREDIT_REFRESH_INTERVAL_MIN = 2; // Every 2 minutes

// Create the alarm only if it doesn't already exist. Previously this ran at
// module top level on every service-worker wake, which resets the alarm
// timer; if wake-ups happened more often than every 2 minutes (normal while
// a user is active), the alarm never actually fired. Called from
// onInstalled/onStartup below so Chrome keeps the worker alive long enough
// for the create() to persist (docs/CODEBASE_AUDIT.md §4).
async function ensureCreditRefreshAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(CREDIT_REFRESH_ALARM);
  if (!existing) {
    await chrome.alarms.create(CREDIT_REFRESH_ALARM, {
      periodInMinutes: CREDIT_REFRESH_INTERVAL_MIN,
    });
    log('Credit refresh alarm created');
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CREDIT_REFRESH_ALARM) return;

  const token = await getAuthToken();
  if (!token) return;

  log('Alarm: refreshing credits');
  await refreshCredits();
});

// Message handler
chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse: (response: MessageResponse) => void) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true; // Keep channel open for async
  }
);

async function handleMessage(
  message: Message,
  _sender: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  log('Received message:', message.type);

  try {
    switch (message.type) {
      case 'GET_FILTER':
        return await handleGetFilter(message.payload as { youtubeId: string });

      case 'GET_PREVIEW':
        return await handleGetPreview(message.payload as { youtubeId: string });

      case 'START_FILTER':
        return await handleStartFilter(message.payload as FilterConfirmPayload);

      case 'CHECK_JOB':
        return await handleCheckJob(message.payload as { jobId: string });

      case 'RETRY_JOB':
        return await handleRetryJob(message.payload as { jobId: string });

      case 'GET_CREDITS':
        return await handleGetCredits();

      case 'GET_PREFERENCES':
        return await handleGetPreferences();

      case 'SET_PREFERENCES':
        return await handleSetPreferences(
          message.payload as Partial<UserPreferences>
        );

      case 'FINISH_ONBOARDING':
        return await handleFinishOnboarding(
          message.payload as Partial<UserPreferences>
        );

      case 'GET_AUTH_STATUS':
        return await handleGetAuthStatus();

      case 'CHECK_AUTH_STRICT':
        return await handleCheckAuthStrict();

      case 'GET_USER_PROFILE':
        return await handleGetUserProfile();

      case 'LOGOUT':
        return await handleLogout();

      case 'OPEN_LOGIN':
        return await handleOpenLogin();

      case 'CLEAR_CACHE':
        return await handleClearCache();

      default:
        return { success: false, error: 'Unknown message type' };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log('Message handler error:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

// Handle video preview request - check credits and get video info
async function handleGetPreview(
  payload: { youtubeId: string }
): Promise<MessageResponse<PreviewData>> {
  const { youtubeId } = payload;
  log('handleGetPreview called with youtubeId:', youtubeId);

  // Check local cache first
  const cached = await getCachedTranscript(youtubeId);
  if (cached) {
    log('Found in local cache, preview shows 0 cost');
    // Get current credit info for display
    let userCredits = 0;
    const creditInfo = await getCreditInfo();
    if (creditInfo) {
      userCredits = creditInfo.available;
    }

    return {
      success: true,
      data: {
        video: {
          youtube_id: youtubeId,
          title: 'Cached Video',
          duration: 0,
        },
        creditCost: 0,
        userCredits,
        hasSufficientCredits: true,
        isCached: true,
      },
    };
  }

  log('Not in local cache, fetching preview from API...');

  try {
    const preview = await getPreview(youtubeId);
    log('Preview response:', JSON.stringify(preview).substring(0, 300));

    // Check for error response
    if (preview.error || preview.error_code) {
      return {
        success: false,
        error: preview.error || `Error: ${preview.error_code}`,
        data: undefined,
      };
    }

    // Update cached credit info
    if (preview.user_credits !== undefined) {
      const existingInfo = await getCreditInfo();
      if (existingInfo) {
        await setCreditInfo({
          ...existingInfo,
          available: preview.user_credits,
        });
      }
    }

    // Convert API response format to PreviewData format
    // Note: credit_cost === 0 with no transcript means unknown duration, not free
    const isUnknownCost = preview.credit_cost === 0 && !preview.cached && !preview.has_transcript;

    return {
      success: true,
      data: {
        video: {
          youtube_id: preview.youtube_id,
          title: preview.title,
          duration: preview.duration_seconds,
          thumbnail: preview.thumbnail_url,
          channel: preview.channel_name,
        },
        creditCost: preview.credit_cost,
        creditCostNote: preview.credit_cost_note,
        creditCostUnknown: isUnknownCost,
        userCredits: preview.user_credits,
        hasSufficientCredits: preview.has_sufficient_credits,
        isCached: preview.cached || preview.has_transcript,
      },
    };
  } catch (error) {
    logError('handleGetPreview error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to get preview';
    return { success: false, error: errorMessage };
  }
}

// Handle start filter request - actually start the filtering process
async function handleStartFilter(
  payload: FilterConfirmPayload
): Promise<MessageResponse<{ status: string; transcript?: Transcript; jobId?: string; error?: string; error_code?: string }>> {
  const { youtubeId, filterType = 'mute', customWords, creditCost } = payload;
  log('handleStartFilter called:', { youtubeId, filterType, creditCost });

  // Check local cache first
  const cached = await getCachedTranscript(youtubeId);
  if (cached) {
    log('Found in local cache, returning cached transcript');

    // Record history for cached video (fire and forget - don't await)
    recordCachedHistory({
      youtubeId,
      filterType,
      customWords,
    }).catch(() => {
      // Silently ignore - already logged in the function
    });

    return {
      success: true,
      data: { status: 'cached', transcript: cached },
    };
  }

  try {
    const response = await startFilter(youtubeId, filterType, customWords);
    log('Start filter response:', JSON.stringify(response).substring(0, 300));

    // Check for explicit failure or error
    if (response.status === 'failed' || response.error) {
      return {
        success: true,
        data: {
          status: 'failed',
          error: response.error,
          error_code: response.error_code,
        },
      };
    }

    if (response.status === 'completed' && response.transcript) {
      log('API returned completed/cached transcript, saving locally');
      await setCachedTranscript(youtubeId, response.transcript);
      // Deduct credits immediately so badge updates without waiting for the API
      if (creditCost && creditCost > 0) {
        await deductCreditsOptimistic(creditCost);
      }
      // Then refresh from API for accuracy (corrects the optimistic value if needed)
      await refreshCredits();
      return {
        success: true,
        data: { status: 'completed', transcript: response.transcript },
      };
    }

    if (response.status === 'processing' && response.job_id) {
      log('API returned processing status, job_id:', response.job_id);
      // Store credit cost so handleCheckJob can deduct optimistically on completion
      if (creditCost && creditCost > 0) {
        await setPendingJobCost(response.job_id, creditCost);
      }
      return {
        success: true,
        data: { status: 'processing', jobId: response.job_id },
      };
    }

    return {
      success: true,
      data: {
        status: 'failed',
        error: response.error || 'Unexpected response',
        error_code: response.error_code,
      },
    };
  } catch (error) {
    logError('handleStartFilter error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to start filter';
    return { success: false, error: errorMessage };
  }
}

// Handle initial filter request (legacy) - returns cached transcript or job_id for polling
async function handleGetFilter(
  payload: { youtubeId: string }
): Promise<MessageResponse<{ status: string; transcript?: Transcript; jobId?: string; error?: string; error_code?: string }>> {
  const { youtubeId } = payload;
  log('handleGetFilter called with youtubeId:', youtubeId);

  // Check local cache first
  const cached = await getCachedTranscript(youtubeId);
  if (cached) {
    log('Found in local cache, returning cached transcript');

    // Intentionally no recordCachedHistory() here — the canonical
    // user-triggered path is handleStartFilter, which already records it.
    // Previously both paths wrote, producing two history rows per filter
    // on cached videos (docs/CODEBASE_AUDIT.md §4).

    return {
      success: true,
      data: { status: 'cached', transcript: cached },
    };
  }

  log('Not in local cache, making API request...');

  try {
    // Make initial request to API
    log('Calling requestFilter API...');
    const response = await requestFilter(youtubeId);
    log('API response:', JSON.stringify(response).substring(0, 200));

    if (response.status === 'completed' && response.transcript) {
      log('API returned completed/cached transcript, saving locally');

      // Log transcript structure
      const t = response.transcript;
      log('Transcript structure:', {
        id: t.id,
        segmentCount: t.segments?.length,
        firstSegment: t.segments?.[0] ? {
          text: t.segments[0].text,
          start_time: t.segments[0].start_time,
          end_time: t.segments[0].end_time,
        } : null,
      });

      await setCachedTranscript(youtubeId, response.transcript);
      await refreshCredits();
      return {
        success: true,
        data: { status: 'completed', transcript: response.transcript },
      };
    }

    if (response.status === 'processing' && response.job_id) {
      log('API returned processing status, job_id:', response.job_id);
      return {
        success: true,
        data: { status: 'processing', jobId: response.job_id },
      };
    }

    // Handle failed status (e.g., age-restricted videos)
    if (response.status === 'failed') {
      log('API returned failed status, error_code:', response.error_code);
      return {
        success: true,
        data: {
          status: 'failed',
          error: response.error,
          error_code: response.error_code,
        },
      };
    }

    logError('Unexpected API response:', response);
    return { success: false, error: 'Unexpected API response: ' + JSON.stringify(response) };
  } catch (error) {
    logError('handleGetFilter error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to request filter';
    return { success: false, error: errorMessage };
  }
}

// Handle job status polling
async function handleCheckJob(
  payload: { jobId: string }
): Promise<MessageResponse<JobStatusResponse>> {
  const { jobId } = payload;
  log('handleCheckJob called with jobId:', jobId);

  try {
    log('Calling checkJobStatus API...');
    const status = await checkJobStatus(jobId);
    log('Job status response:', JSON.stringify(status).substring(0, 300));

    // If completed, cache the transcript and update credits
    if (status.status === 'completed' && status.transcript) {
      const cacheKey = status.video?.youtube_id || status.transcript.id;
      log('Job completed, caching transcript for:', cacheKey);

      // Log transcript structure
      const t = status.transcript;
      log('Job transcript structure:', {
        id: t.id,
        segmentCount: t.segments?.length,
        firstSegment: t.segments?.[0] ? {
          text: t.segments[0].text,
          start_time: t.segments[0].start_time,
          end_time: t.segments[0].end_time,
        } : null,
      });

      await setCachedTranscript(cacheKey, status.transcript);

      // Deduct stored credit cost immediately so badge updates without waiting
      // for the balance API (which may still return stale data right after completion)
      const creditCost = await takePendingJobCost(jobId);
      if (creditCost && creditCost > 0) {
        await deductCreditsOptimistic(creditCost);
      }

      // Then refresh from API for accuracy
      await refreshCredits();
    }

    // Clean up pending cost if job failed
    if (status.status === 'failed') {
      await deletePendingJobCost(jobId);
    }

    return { success: true, data: status };
  } catch (error) {
    logError('handleCheckJob error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to check job status';
    return { success: false, error: errorMessage };
  }
}

// Handle in-session retry for a stuck transcription job. The server keeps
// job_id stable across the restart, so the caller can keep polling the same
// status URL. Per the contract, the extension fires this at most once per
// job_id; the background job sweep handles persistent failures.
async function handleRetryJob(
  payload: { jobId: string }
): Promise<MessageResponse<{ jobId: string; status: string }>> {
  const { jobId } = payload;
  log('handleRetryJob called with jobId:', jobId);

  try {
    const response = await retryFilterJob(jobId);
    log('Retry job response:', JSON.stringify(response).substring(0, 200));
    return {
      success: true,
      data: { jobId: response.job_id || jobId, status: response.status },
    };
  } catch (error) {
    logError('handleRetryJob error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to retry job';
    return { success: false, error: errorMessage };
  }
}

// Singleflight so simultaneous GET_CREDITS calls (popup + options open at
// once) share one network request instead of firing duplicates.
let inflightCreditFetch: ReturnType<typeof getCreditBalance> | null = null;
function fetchCreditBalanceSingleflight(): ReturnType<typeof getCreditBalance> {
  if (inflightCreditFetch) return inflightCreditFetch;
  inflightCreditFetch = getCreditBalance().finally(() => {
    inflightCreditFetch = null;
  });
  return inflightCreditFetch;
}

// One-shot retry after transient refresh failure so the badge self-corrects
// in ~10s instead of waiting for the next periodic alarm (~2min).
let creditRefreshRetryTimer: number | null = null;
function scheduleCreditRefreshRetry(): void {
  if (creditRefreshRetryTimer !== null) return;
  creditRefreshRetryTimer = self.setTimeout(() => {
    creditRefreshRetryTimer = null;
    refreshCredits();
  }, 10_000);
}

// Fetch fresh credit balance from API and update storage + badge directly
async function refreshCredits(): Promise<void> {
  try {
    const response = await fetchCreditBalanceSingleflight();
    if (response.success && response.credits) {
      await setCreditInfo(response.credits);
      updateBadge(response.credits);
      log('Credits refreshed from API:', response.credits.available);
      return;
    }
    log('Credits refresh returned unsuccessful response; scheduling retry');
    scheduleCreditRefreshRetry();
  } catch (error) {
    log('Failed to refresh credits:', error);
    scheduleCreditRefreshRetry();
  }
}

// Handle get credits request
async function handleGetCredits(): Promise<MessageResponse<CreditInfo>> {
  log('handleGetCredits called');

  // Check cache first
  const cachedInfo = await getCreditInfo();
  if (cachedInfo) {
    log('Returning cached credit info:', cachedInfo);
    return { success: true, data: cachedInfo };
  }

  // Fetch from API (shared across concurrent callers)
  try {
    const response = await fetchCreditBalanceSingleflight();
    log('Credit balance response:', JSON.stringify(response));

    if (!response.success) {
      return { success: false, error: response.error || 'Failed to get credits' };
    }

    // Cache the credit info
    await setCreditInfo(response.credits);

    return { success: true, data: response.credits };
  } catch (error) {
    logError('handleGetCredits error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to get credits';
    return { success: false, error: errorMessage };
  }
}

async function handleGetPreferences(): Promise<MessageResponse<UserPreferences>> {
  const preferences = await getPreferences();
  return { success: true, data: preferences };
}

async function handleSetPreferences(
  payload: Partial<UserPreferences>
): Promise<MessageResponse<UserPreferences>> {
  const updated = await setPreferences(payload);
  await broadcastPreferences(updated);
  return { success: true, data: updated };
}

async function broadcastPreferences(updated: UserPreferences): Promise<void> {
  // Broadcast to all YouTube tabs (content scripts)
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'PREFERENCES_UPDATED',
        payload: updated,
      }).catch(() => {});
    }
  }

  // Also broadcast to extension contexts (popup, options page) so an
  // update from one surface lands on every other surface immediately.
  chrome.runtime.sendMessage({
    type: 'PREFERENCES_UPDATED',
    payload: updated,
  }).catch(() => {});
}

// Merges the strictness preferences AND marks onboarding complete in a
// single atomic storage.local.set call, so the user never ends up in a
// "prefs saved but onboarding not marked complete" or vice-versa state
// if the onboarding tab is closed partway through.
async function handleFinishOnboarding(
  payload: Partial<UserPreferences>
): Promise<MessageResponse<UserPreferences>> {
  const current = await getPreferences();
  const updated = { ...current, ...payload };
  await chrome.storage.local.set({
    [STORAGE_KEYS.PREFERENCES]: updated,
    onboardingComplete: true,
  });
  await broadcastPreferences(updated);
  return { success: true, data: updated };
}

async function handleGetAuthStatus(): Promise<
  MessageResponse<{ authenticated: boolean; token?: string }>
> {
  const authenticated = await isAuthenticated();
  const token = authenticated ? (await getAuthToken()) || undefined : undefined;
  return { success: true, data: { authenticated, token } };
}

/**
 * Strict auth check - first checks local token validity, then attempts
 * a token refresh if the token is expired but a refresh token exists.
 * This ensures users with valid sessions aren't asked to re-authenticate
 * just because their access token expired.
 */
async function handleCheckAuthStrict(): Promise<
  MessageResponse<{ authenticated: boolean }>
> {
  // Single source of truth: use getAuthToken() which handles expiry, refresh, etc.
  // This is the same path the popup and alarm use, so auth behaves consistently.
  const token = await getAuthToken();
  const authenticated = token !== null;
  log('handleCheckAuthStrict:', authenticated);
  return { success: true, data: { authenticated } };
}

async function handleClearCache(): Promise<MessageResponse> {
  await clearCachedTranscripts();
  return { success: true };
}

// Handle get user profile request - fetches profile from API and caches it
async function handleGetUserProfile(): Promise<MessageResponse<AuthState>> {
  log('handleGetUserProfile called');

  // First check if authenticated
  const token = await getAuthToken();
  if (!token) {
    log('Not authenticated, returning empty auth state');
    return {
      success: true,
      data: {
        isAuthenticated: false,
        user: null,
        subscription: null,
        credits: null,
        token: null,
      },
    };
  }

  try {
    // Fetch fresh profile from API
    const response = await getUserProfile();
    log('User profile response:', JSON.stringify(response).substring(0, 300));

    // Store the profile data atomically. A single chrome.storage.local.set
    // with multiple keys lands as one all-or-nothing write, so concurrent
    // readers (popup, options) never observe a partially-updated snapshot
    // where, e.g., the new user is already visible but the new subscription
    // hasn't landed yet.
    const profileUpdate: Record<string, unknown> = {};
    if (response.user) {
      profileUpdate[STORAGE_KEYS.USER_PROFILE] = response.user;
    }
    if (response.subscription) {
      profileUpdate[STORAGE_KEYS.USER_SUBSCRIPTION] = response.subscription;
    }
    if (response.credits) {
      profileUpdate[STORAGE_KEYS.USER_CREDITS] = response.credits;

      // Also update the credit info for compatibility with existing credit display
      const planName = response.subscription?.plans?.name?.toLowerCase() || 'free';
      const planAllocation = response.subscription?.plans?.monthly_credits || 30;
      const available = response.credits.available_credits;
      const usedThisPeriod = response.credits.used_this_period;

      profileUpdate[STORAGE_KEYS.CREDIT_INFO] = {
        available,
        used_this_period: usedThisPeriod,
        plan_allocation: planAllocation,
        percent_consumed: planAllocation > 0 ? (usedThisPeriod / planAllocation) * 100 : 0,
        plan: planName as 'free' | 'base' | 'professional' | 'unlimited',
      };
    }
    if (Object.keys(profileUpdate).length > 0) {
      await chrome.storage.local.set(profileUpdate);
    }

    return {
      success: true,
      data: {
        isAuthenticated: true,
        user: response.user,
        subscription: response.subscription,
        credits: response.credits,
        token,
      },
    };
  } catch (error) {
    logError('handleGetUserProfile error:', error);

    // If token is invalid, clear auth data
    if (error instanceof Error && error.message.includes('401')) {
      log('Token invalid, clearing auth data');
      await clearAuthData();
      return {
        success: true,
        data: {
          isAuthenticated: false,
          user: null,
          subscription: null,
          credits: null,
          token: null,
        },
      };
    }

    // Return cached data on other errors
    const cachedState = await getFullAuthState();
    return {
      success: true,
      data: {
        isAuthenticated: cachedState.isAuthenticated,
        user: cachedState.profile,
        subscription: cachedState.subscription,
        credits: cachedState.credits,
        token: cachedState.token,
      },
    };
  }
}

// Handle logout - clears all auth data
async function handleLogout(): Promise<MessageResponse> {
  log('handleLogout called');

  await clearAuthData();
  clearBadge();

  // Broadcast logout to all tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'AUTH_STATE_CHANGED',
        payload: { isAuthenticated: false },
      }).catch(() => {});
    }
  }

  return { success: true };
}

// Handle open login - opens the website extension auth page
const WEBSITE_BASE_URL = 'https://trysafeplay.com';

async function handleOpenLogin(): Promise<MessageResponse> {
  log('handleOpenLogin called');

  // Get the extension ID for the callback
  const extensionId = chrome.runtime.id;

  // Open the dedicated extension auth page
  // This page will check if user is already logged in:
  // - If logged in: sends token to extension immediately
  // - If not logged in: redirects to login with extension callback
  const authUrl = `${WEBSITE_BASE_URL}/extension/auth?extensionId=${extensionId}`;

  await chrome.tabs.create({ url: authUrl });

  return { success: true };
}

// Handle extension icon click
chrome.action.onClicked.addListener((_tab) => {
  log('Extension icon clicked');
});

// Current schema version. Bump every time a storage shape changes,
// add a matching migration step in runMigrations().
const CURRENT_SCHEMA_VERSION = 1;
const SCHEMA_VERSION_KEY = 'safeplay_schema_version';

async function runMigrations(): Promise<void> {
  const result = await chrome.storage.local.get(SCHEMA_VERSION_KEY);
  const stored = result[SCHEMA_VERSION_KEY];
  const fromVersion = typeof stored === 'number' ? stored : 0;

  if (fromVersion >= CURRENT_SCHEMA_VERSION) return;

  log(`Running storage migrations from v${fromVersion} to v${CURRENT_SCHEMA_VERSION}`);
  // Future migrations go here, one block per version bump:
  // if (fromVersion < 2) { ... migrate v1 -> v2 ... }

  await chrome.storage.local.set({ [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION });
  log(`Storage migrations complete; now at v${CURRENT_SCHEMA_VERSION}`);
}

// Handle installation/update — initialize badge within event handler so worker stays alive
chrome.runtime.onInstalled.addListener(async (details) => {
  log('Extension installed/updated:', details.reason);
  await runMigrations();
  await initBadge();
  await ensureCreditRefreshAlarm();

  if (details.reason === 'install') {
    // Show onboarding on first install
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// Handle browser startup — also initialize badge
chrome.runtime.onStartup.addListener(async () => {
  log('Browser started');
  await initBadge();
  await ensureCreditRefreshAlarm();
});

// Handle auth callback from website (deep-link auth flow)
chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {
    const allowedOrigins = [
      'https://trysafeplay.com',
      'https://safeplay.app',
      'http://localhost:3000', // Development
    ];

    if (allowedOrigins.includes(sender.origin || '')) {
      if (message.type === 'AUTH_TOKEN') {
        log('Received AUTH_TOKEN from website');
        // Detailed logging to diagnose token issues
        log('Message token details:', {
          hasToken: !!message.token,
          tokenLength: message.token?.length,
          hasRefreshToken: !!message.refreshToken,
          refreshTokenLength: message.refreshToken?.length,
          refreshTokenPreview: message.refreshToken ? `${String(message.refreshToken).substring(0, 15)}...` : 'none',
          hasExpiresAt: !!message.expiresAt,
          expiresAt: message.expiresAt,
          expiresAtType: typeof message.expiresAt,
          hasUserId: !!message.userId,
          userId: message.userId,
        });

        // Origin was validated above, but we still validate the payload
        // shape. A bug on the website side (or an older version talking
        // to a newer extension) could send a malformed message that
        // poisons storage with undefined token / wrong expiry type /
        // missing user id, causing cryptic downstream failures later.
        if (typeof message.token !== 'string' || message.token.length === 0) {
          logError('AUTH_TOKEN rejected: token is missing or not a string');
          sendResponse({ success: false, error: 'Invalid auth payload: token' });
          return;
        }
        if (
          message.refreshToken !== undefined &&
          (typeof message.refreshToken !== 'string' || message.refreshToken.length === 0)
        ) {
          logError('AUTH_TOKEN rejected: refreshToken is present but not a non-empty string');
          sendResponse({ success: false, error: 'Invalid auth payload: refreshToken' });
          return;
        }
        if (
          message.expiresAt !== undefined &&
          message.expiresAt !== null &&
          typeof message.expiresAt !== 'number' &&
          typeof message.expiresAt !== 'string'
        ) {
          logError('AUTH_TOKEN rejected: expiresAt is present but not number/string');
          sendResponse({ success: false, error: 'Invalid auth payload: expiresAt' });
          return;
        }
        if (message.userId !== undefined && typeof message.userId !== 'string') {
          logError('AUTH_TOKEN rejected: userId is present but not a string');
          sendResponse({ success: false, error: 'Invalid auth payload: userId' });
          return;
        }

        import('../utils/storage').then(async ({
          setAuthToken,
          setUserId,
          setSubscriptionTier,
          setCreditInfo,
          setUserProfile,
          setUserSubscription,
          setUserCredits,
        }) => {
          try {
            // Store auth data including refresh token and expiry
            // Note: setAuthToken will normalize expiresAt to seconds if it's in milliseconds
            await setAuthToken(
              message.token,
              message.refreshToken,  // Refresh token for auto-refresh
              message.expiresAt      // Token expiry timestamp (auto-detected: seconds or milliseconds)
            );

            if (message.userId) {
              await setUserId(message.userId);
            }

            if (message.tier) {
              await setSubscriptionTier(message.tier);
            }

            if (message.credits) {
              await setCreditInfo(message.credits);
            }

            // Store user profile if provided
            if (message.user) {
              await setUserProfile(message.user);
            }

            if (message.subscription) {
              await setUserSubscription(message.subscription);
            }

            if (message.userCredits) {
              await setUserCredits(message.userCredits);
            }

            // Broadcast auth state change to all tabs
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, {
                  type: 'AUTH_STATE_CHANGED',
                  payload: {
                    isAuthenticated: true,
                    user: message.user,
                  },
                }).catch(() => {});
              }
            }

            log('Auth data stored successfully');
            sendResponse({ success: true });
          } catch (error) {
            logError('Error storing auth data:', error);
            sendResponse({ success: false, error: 'Failed to store auth data' });
          }
        });
        return true;
      }

      // Handle credit update messages from website
      if (message.type === 'CREDIT_UPDATE') {
        import('../utils/storage').then(({ setCreditInfo }) => {
          setCreditInfo(message.credits).then(() => {
            // Broadcast credit update
            chrome.tabs.query({}).then(tabs => {
              for (const tab of tabs) {
                if (tab.id) {
                  chrome.tabs.sendMessage(tab.id, {
                    type: 'CREDIT_UPDATE',
                    payload: message.credits,
                  }).catch(() => {});
                }
              }
            });
            sendResponse({ success: true });
          });
        });
        return true;
      }

      // Handle logout from website
      if (message.type === 'LOGOUT') {
        log('Received LOGOUT from website');
        handleLogout().then(() => {
          sendResponse({ success: true });
        });
        return true;
      }
    }
    return false;
  }
);

log('SafePlay background service worker initialized');
