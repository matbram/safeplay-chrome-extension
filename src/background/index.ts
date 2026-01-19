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
  updateCreditsAfterFilter,
  clearAuthData,
  setUserProfile,
  setUserSubscription,
  setUserCredits,
  getFullAuthState,
} from '../utils/storage';
import {
  requestFilter,
  checkJobStatus,
  getPreview,
  startFilter,
  getCreditBalance,
  getUserProfile,
} from '../api/client';

function log(...args: unknown[]): void {
  // Always log for debugging
  console.log('[SafePlay BG]', ...args);
}

function logError(...args: unknown[]): void {
  console.error('[SafePlay BG ERROR]', ...args);
}

// Message handler
chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse: (response: MessageResponse) => void) => {
    handleMessage(message, sender).then(sendResponse);
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

      case 'GET_CREDITS':
        return await handleGetCredits();

      case 'GET_PREFERENCES':
        return await handleGetPreferences();

      case 'SET_PREFERENCES':
        return await handleSetPreferences(
          message.payload as Partial<UserPreferences>
        );

      case 'GET_AUTH_STATUS':
        return await handleGetAuthStatus();

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
  const { youtubeId, filterType = 'mute', customWords } = payload;
  log('handleStartFilter called:', { youtubeId, filterType });

  // Check local cache first
  const cached = await getCachedTranscript(youtubeId);
  if (cached) {
    log('Found in local cache, returning cached transcript');
    return {
      success: true,
      data: { status: 'cached', transcript: cached },
    };
  }

  try {
    const response = await startFilter(youtubeId, filterType, customWords);
    log('Start filter response:', JSON.stringify(response).substring(0, 300));

    if (!response.success) {
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

      // Log transcript structure to verify character-level data
      const t = response.transcript;
      log('Transcript structure:', {
        id: t.id,
        segmentCount: t.segments?.length,
        firstSegment: t.segments?.[0] ? {
          text: t.segments[0].text,
          start_time: t.segments[0].start_time,
          end_time: t.segments[0].end_time,
          hasCharacters: !!t.segments[0].characters,
          characterCount: t.segments[0].characters?.length,
          firstChar: t.segments[0].characters?.[0],
          lastChar: t.segments[0].characters?.[t.segments[0].characters?.length - 1],
        } : null,
      });

      // Log a few segments to see character data
      if (t.segments && t.segments.length > 0) {
        for (let i = 0; i < Math.min(3, t.segments.length); i++) {
          const seg = t.segments[i];
          log(`Segment ${i}: "${seg.text}" (${seg.start_time}s - ${seg.end_time}s)`, {
            characters: seg.characters?.slice(0, 5), // First 5 chars
            totalChars: seg.characters?.length,
          });
        }
      }

      await setCachedTranscript(youtubeId, response.transcript);
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

      // Log transcript structure to verify character-level data
      const t = status.transcript;
      log('Job transcript structure:', {
        id: t.id,
        segmentCount: t.segments?.length,
        firstSegment: t.segments?.[0] ? {
          text: t.segments[0].text,
          start_time: t.segments[0].start_time,
          end_time: t.segments[0].end_time,
          hasCharacters: !!t.segments[0].characters,
          characterCount: t.segments[0].characters?.length,
          sampleChars: t.segments[0].characters?.slice(0, 3),
        } : null,
      });

      await setCachedTranscript(cacheKey, status.transcript);

      // Update credits after successful completion
      // The credit cost is calculated based on video duration (1 credit per minute, min 1)
      // For now, we'll do an optimistic update with 1 credit since we don't have duration here
      await updateCreditsAfterFilter(1);
    }

    return { success: true, data: status };
  } catch (error) {
    logError('handleCheckJob error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to check job status';
    return { success: false, error: errorMessage };
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

  // Fetch from API
  try {
    const response = await getCreditBalance();
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

  // Broadcast to all YouTube tabs
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'PREFERENCES_UPDATED',
        payload: updated,
      }).catch(() => {});
    }
  }

  return { success: true, data: updated };
}

async function handleGetAuthStatus(): Promise<
  MessageResponse<{ authenticated: boolean; token?: string }>
> {
  const authenticated = await isAuthenticated();
  const token = authenticated ? (await getAuthToken()) || undefined : undefined;
  return { success: true, data: { authenticated, token } };
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

    // Store the profile data
    if (response.user) {
      await setUserProfile(response.user);
    }
    if (response.subscription) {
      await setUserSubscription(response.subscription);
    }
    if (response.credits) {
      await setUserCredits(response.credits);

      // Also update the credit info for compatibility with existing credit display
      const planName = response.subscription?.plans?.name?.toLowerCase() || 'free';
      const planAllocation = response.subscription?.plans?.monthly_credits || 30;
      const available = response.credits.available_credits;
      const usedThisPeriod = response.credits.used_this_period;

      await setCreditInfo({
        available,
        used_this_period: usedThisPeriod,
        plan_allocation: planAllocation,
        percent_consumed: planAllocation > 0 ? (usedThisPeriod / planAllocation) * 100 : 0,
        plan: planName as 'free' | 'base' | 'professional' | 'unlimited',
      });
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

// Handle open login - opens the website login page
const WEBSITE_BASE_URL = 'https://astonishing-youthfulness-production.up.railway.app';

async function handleOpenLogin(): Promise<MessageResponse> {
  log('handleOpenLogin called');

  // Get the extension ID for the callback
  const extensionId = chrome.runtime.id;

  // Open the website login page with extension callback
  const loginUrl = `${WEBSITE_BASE_URL}/login?extension=${extensionId}&callback=extension`;

  await chrome.tabs.create({ url: loginUrl });

  return { success: true };
}

// Handle extension icon click
chrome.action.onClicked.addListener((_tab) => {
  log('Extension icon clicked');
});

// Handle installation/update
chrome.runtime.onInstalled.addListener((details) => {
  log('Extension installed/updated:', details.reason);

  if (details.reason === 'install') {
    // First install - could open onboarding page
    // chrome.tabs.create({ url: 'https://safeplay.app/welcome' });
  }
});

// Handle auth callback from website (deep-link auth flow)
chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {
    const allowedOrigins = [
      'https://astonishing-youthfulness-production.up.railway.app',
      'https://safeplay.app',
      'http://localhost:3000', // Development
    ];

    if (allowedOrigins.includes(sender.origin || '')) {
      if (message.type === 'AUTH_TOKEN') {
        log('Received AUTH_TOKEN from website');
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
            // Store auth data
            await setAuthToken(message.token);

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
