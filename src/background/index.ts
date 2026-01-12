// SafePlay Background Service Worker
import {
  Message,
  MessageResponse,
  Transcript,
  UserPreferences,
  JobStatusResponse,
} from '../types';
import {
  getPreferences,
  setPreferences,
  getCachedTranscript,
  setCachedTranscript,
  getAuthToken,
  clearCachedTranscripts,
  isAuthenticated,
} from '../utils/storage';
import { requestFilter, checkJobStatus } from '../api/client';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[SafePlay BG]', ...args);
  }
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

      case 'CHECK_JOB':
        return await handleCheckJob(message.payload as { jobId: string });

      case 'GET_PREFERENCES':
        return await handleGetPreferences();

      case 'SET_PREFERENCES':
        return await handleSetPreferences(
          message.payload as Partial<UserPreferences>
        );

      case 'GET_AUTH_STATUS':
        return await handleGetAuthStatus();

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

// Handle initial filter request - returns cached transcript or job_id for polling
async function handleGetFilter(
  payload: { youtubeId: string }
): Promise<MessageResponse<{ status: string; transcript?: Transcript; jobId?: string }>> {
  const { youtubeId } = payload;

  // Check local cache first
  const cached = await getCachedTranscript(youtubeId);
  if (cached) {
    log('Returning cached transcript for:', youtubeId);
    return {
      success: true,
      data: { status: 'cached', transcript: cached },
    };
  }

  try {
    // Make initial request to API
    const response = await requestFilter(youtubeId);

    if (response.status === 'cached' && response.transcript) {
      // API had it cached - save locally and return
      await setCachedTranscript(youtubeId, response.transcript);
      return {
        success: true,
        data: { status: 'cached', transcript: response.transcript },
      };
    }

    if (response.status === 'processing' && response.job_id) {
      // Processing started - return job ID for polling
      return {
        success: true,
        data: { status: 'processing', jobId: response.job_id },
      };
    }

    return { success: false, error: 'Unexpected API response' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to request filter';
    return { success: false, error: errorMessage };
  }
}

// Handle job status polling
async function handleCheckJob(
  payload: { jobId: string }
): Promise<MessageResponse<JobStatusResponse>> {
  const { jobId } = payload;

  try {
    const status = await checkJobStatus(jobId);

    // If completed, cache the transcript
    if (status.status === 'completed' && status.transcript) {
      await setCachedTranscript(status.transcript.youtube_id, status.transcript);
    }

    return { success: true, data: status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to check job status';
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
    if (sender.origin === 'https://safeplay.app') {
      if (message.type === 'AUTH_TOKEN') {
        import('../utils/storage').then(({ setAuthToken, setUserId, setSubscriptionTier }) => {
          Promise.all([
            setAuthToken(message.token),
            setUserId(message.userId),
            setSubscriptionTier(message.tier),
          ]).then(() => {
            sendResponse({ success: true });
          });
        });
        return true;
      }
    }
    return false;
  }
);

log('SafePlay background service worker initialized');
