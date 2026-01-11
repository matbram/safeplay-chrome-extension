// SafePlay Background Service Worker
import {
  Message,
  MessageResponse,
  Transcript,
  UserPreferences,
  FilterResponse,
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
import { getOrRequestTranscript, pollForTranscript, ApiError } from '../api/client';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[SafePlay BG]', ...args);
  }
}

// Track active jobs for progress reporting
const activeJobs = new Map<string, { tabId: number; youtubeId: string }>();

// Message handler
chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse: (response: MessageResponse) => void) => {
    handleMessage(message, sender).then(sendResponse);
    return true; // Keep channel open for async
  }
);

async function handleMessage(
  message: Message,
  sender: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  log('Received message:', message.type);

  try {
    switch (message.type) {
      case 'GET_FILTER':
        return await handleGetFilter(
          message.payload as { youtubeId: string },
          sender.tab?.id
        );

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

async function handleGetFilter(
  payload: { youtubeId: string },
  tabId?: number
): Promise<MessageResponse<{ status: string; transcript?: Transcript; progress?: number }>> {
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

  // Check if authenticated (for now, skip auth check - will implement later)
  // const authenticated = await isAuthenticated();
  // if (!authenticated) {
  //   return { success: false, error: 'Authentication required' };
  // }

  try {
    // Request from API with progress callback
    const transcript = await getOrRequestTranscript(youtubeId, (progress) => {
      // Send progress updates to content script
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: 'PROCESSING_PROGRESS',
          payload: { progress },
        }).catch(() => {
          // Tab might be closed
        });
      }
    });

    // Cache the transcript locally
    await setCachedTranscript(youtubeId, transcript);

    // Notify content script
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'TRANSCRIPT_RECEIVED',
        payload: { transcript },
      }).catch(() => {});
    }

    return {
      success: true,
      data: { status: 'completed', transcript },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get transcript';

    // Notify content script of error
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'PROCESSING_ERROR',
        payload: { error: errorMessage },
      }).catch(() => {});
    }

    return { success: false, error: errorMessage };
  }
}

async function handleCheckJob(
  payload: { jobId: string }
): Promise<MessageResponse> {
  // This is handled within pollForTranscript, but keeping for direct polling if needed
  return { success: true, data: { message: 'Use GET_FILTER instead' } };
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
chrome.action.onClicked.addListener((tab) => {
  // Open popup is handled by manifest, but we can add extra logic here if needed
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
// This will be implemented when we build the website
chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {
    // Handle messages from safeplay.app for auth
    if (sender.origin === 'https://safeplay.app') {
      if (message.type === 'AUTH_TOKEN') {
        // Store the auth token
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
