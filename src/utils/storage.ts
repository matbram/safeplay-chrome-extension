import {
  UserPreferences,
  DEFAULT_PREFERENCES,
  Transcript,
  CreditInfo,
  SubscriptionTier,
  UserProfile,
  UserSubscription,
  UserCredits,
} from '../types';

export const STORAGE_KEYS = {
  PREFERENCES: 'safeplay_preferences',
  AUTH_TOKEN: 'safeplay_auth_token',
  REFRESH_TOKEN: 'safeplay_refresh_token',
  TOKEN_EXPIRES_AT: 'safeplay_token_expires_at',
  USER_ID: 'safeplay_user_id',
  SUBSCRIPTION_TIER: 'safeplay_subscription_tier',
  CREDIT_INFO: 'safeplay_credit_info',
  CREDIT_CACHE_TIME: 'safeplay_credit_cache_time',
  CACHED_TRANSCRIPTS: 'safeplay_cached_transcripts',
  FILTERED_VIDEOS: 'safeplay_filtered_videos',
  USER_PROFILE: 'safeplay_user_profile',
  USER_SUBSCRIPTION: 'safeplay_user_subscription',
  USER_CREDITS: 'safeplay_user_credits',
  PROFILE_CACHE_TIME: 'safeplay_profile_cache_time',
} as const;

// API base URL for token refresh
const API_BASE_URL = 'https://trysafeplay.com';

// Token refresh buffer - refresh 5 minutes before expiry
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Credit cache duration in milliseconds (5 minutes)
const CREDIT_CACHE_DURATION = 5 * 60 * 1000;

// Cache limits
const MAX_CACHED_TRANSCRIPTS = 15; // Keep only 15 most recent transcripts

export async function getPreferences(): Promise<UserPreferences> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.PREFERENCES);
  return result[STORAGE_KEYS.PREFERENCES] || DEFAULT_PREFERENCES;
}

export async function setPreferences(
  preferences: Partial<UserPreferences>
): Promise<UserPreferences> {
  const current = await getPreferences();
  const updated = { ...current, ...preferences };
  await chrome.storage.local.set({ [STORAGE_KEYS.PREFERENCES]: updated });
  return updated;
}

/**
 * Refresh result kinds:
 *   - ok:        got a fresh access token
 *   - transient: refresh couldn't complete (network, 5xx, 404, cookie missing).
 *                Stored auth should NOT be wiped — the next caller can retry.
 *   - revoked:   server explicitly said the refresh token is no longer valid.
 *                Caller should log the user out.
 */
export type RefreshResult =
  | { kind: 'ok'; token: string }
  | { kind: 'transient' }
  | { kind: 'revoked' };

// Normalize a Unix timestamp to seconds. Some endpoints return ms, some
// return seconds; Supabase's session.expires_at is seconds. Treat values
// above 10 billion as ms (that threshold is year 2286 in seconds).
function normalizeExpiresAtToSeconds(value: number): number {
  if (value > 10000000000) return Math.floor(value / 1000);
  return Math.floor(value);
}

async function persistRefreshResult(
  accessToken: string,
  refreshToken?: string,
  expiresAt?: number
): Promise<void> {
  const data: Record<string, unknown> = {
    [STORAGE_KEYS.AUTH_TOKEN]: accessToken,
  };
  if (refreshToken) data[STORAGE_KEYS.REFRESH_TOKEN] = refreshToken;
  if (expiresAt !== undefined && expiresAt !== null) {
    const seconds = normalizeExpiresAtToSeconds(expiresAt);
    data[STORAGE_KEYS.TOKEN_EXPIRES_AT] = seconds;
    console.log('[SafePlay Storage] ✅ Token refreshed; expires at', new Date(seconds * 1000).toISOString());
  }
  await chrome.storage.local.set(data);
}

// Wipe only the three token keys — keep profile/subscription/credits bundle.
// api/client.ts's clearAuthData() does the bigger wipe when appropriate.
async function wipeTokensOnly(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_KEYS.AUTH_TOKEN,
    STORAGE_KEYS.REFRESH_TOKEN,
    STORAGE_KEYS.TOKEN_EXPIRES_AT,
  ]);
}

// Primary refresh path: POST the stored refresh token to /api/auth/refresh.
// Succeeds when the server deploys that endpoint and the token is still
// valid. Returns:
//   - ok      : got fresh tokens
//   - revoked : server said 401/403 — refresh token definitively dead
//   - null    : any other outcome (404 endpoint missing, 5xx, network) —
//               caller should fall back to the cookie path.
async function refreshViaToken(refreshToken: string): Promise<RefreshResult | null> {
  const url = `${API_BASE_URL}/api/auth/refresh`;
  console.log('[SafePlay Storage] 🔄 Attempting refresh via /api/auth/refresh');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (err) {
    console.log('[SafePlay Storage] /api/auth/refresh network error:', err);
    return null; // transient — try cookie fallback
  }

  if (response.ok) {
    const data = await response.json();
    const accessToken = data.access_token || data.token;
    if (!accessToken) {
      console.log('[SafePlay Storage] /api/auth/refresh returned 200 without access_token');
      return null; // malformed — try cookie fallback
    }
    await persistRefreshResult(
      accessToken,
      data.refresh_token || data.refreshToken,
      data.expires_at ?? data.expiresAt
    );
    return { kind: 'ok', token: accessToken };
  }

  if (response.status === 401 || response.status === 403) {
    console.log('[SafePlay Storage] /api/auth/refresh rejected token — revoked');
    await wipeTokensOnly();
    return { kind: 'revoked' };
  }

  // 404 = endpoint not deployed; 5xx = transient. Either way, fall back.
  console.log(`[SafePlay Storage] /api/auth/refresh returned ${response.status}; falling back to cookie path`);
  return null;
}

// Legacy / fallback refresh path: GET /api/extension/session with the
// website session cookie. Works only when cookies are present. Never
// returns 'revoked' — cookie absence could mean "user signed out" OR
// "cookies blocked" OR "cookie TTL shorter than token TTL" and we can't
// tell those apart. Always transient when it fails.
async function refreshViaCookie(): Promise<RefreshResult> {
  try {
    const extensionId = chrome.runtime.id;
    const url = `${API_BASE_URL}/api/extension/session?extensionId=${extensionId}`;

    console.log('[SafePlay Storage] 🔄 Falling back to cookie refresh (/api/extension/session)');

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      console.log('[SafePlay Storage] Cookie session fetch failed:', response.status);
      return { kind: 'transient' };
    }

    const data = await response.json();

    if (!data.authenticated) {
      // Soft signal. Previously this wiped the refresh token too, which
      // caused the re-auth issue: a website cookie expiring would force
      // the user to sign in again even though their refresh token was
      // still valid. We now drop only the access token (it's useless if
      // it was expired anyway) and leave the refresh token alone so the
      // token path can be retried.
      console.log('[SafePlay Storage] Cookie session says unauthenticated — keeping refresh token, dropping access token');
      await chrome.storage.local.remove([STORAGE_KEYS.AUTH_TOKEN]);
      return { kind: 'transient' };
    }

    await persistRefreshResult(data.token, data.refreshToken, data.expiresAt);
    return { kind: 'ok', token: data.token };
  } catch (err) {
    console.log('[SafePlay Storage] Cookie session fetch threw:', err);
    return { kind: 'transient' };
  }
}

// Singleflight so N parallel callers share one in-flight refresh.
// Prevents the race where one refresh rotates the token and the other
// callers' inflight requests fail with 401, causing a cascade logout.
let inflightRefresh: Promise<RefreshResult> | null = null;

export function refreshAuthTokenDetailed(): Promise<RefreshResult> {
  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async (): Promise<RefreshResult> => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.REFRESH_TOKEN);
      const refreshToken = stored[STORAGE_KEYS.REFRESH_TOKEN];

      if (refreshToken) {
        const tokenResult = await refreshViaToken(refreshToken);
        if (tokenResult) return tokenResult; // ok or revoked — definitive
        // null → fall through to cookie fallback (endpoint missing / transient)
      }

      return await refreshViaCookie();
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

// Get auth token - automatically refreshes if expired
export async function getAuthToken(): Promise<string | null> {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.AUTH_TOKEN,
    STORAGE_KEYS.REFRESH_TOKEN,
    STORAGE_KEYS.TOKEN_EXPIRES_AT,
  ]);

  const token = result[STORAGE_KEYS.AUTH_TOKEN];
  const refreshToken = result[STORAGE_KEYS.REFRESH_TOKEN];
  const expiresAt = result[STORAGE_KEYS.TOKEN_EXPIRES_AT];

  if (!token) {
    return null;
  }

  // Check if token is expired or expiring soon
  if (expiresAt) {
    const now = Date.now();
    // expiresAt should be stored in seconds (normalized in setAuthToken)
    // But handle both cases for safety
    let expiresAtMs = expiresAt;
    if (expiresAt < 10000000000) {
      // It's in seconds, convert to milliseconds
      expiresAtMs = expiresAt * 1000;
    }
    // else it's already in milliseconds (legacy data)

    const timeUntilExpiry = expiresAtMs - now;
    const isExpired = timeUntilExpiry < 0;
    const isExpiringSoon = timeUntilExpiry < TOKEN_REFRESH_BUFFER_MS;

    // If token is completely expired (past expiry time)
    if (isExpired) {
      console.log('[SafePlay Storage] Token expired:', {
        expiresAt,
        expiresAtMs,
        now,
        expiredAgo: Math.abs(timeUntilExpiry) / 1000 + ' seconds',
        hasRefreshToken: !!refreshToken,
        refreshTokenLength: refreshToken?.length,
      });

      if (refreshToken) {
        const refreshResult = await refreshAuthTokenDetailed();
        if (refreshResult.kind === 'ok') {
          return refreshResult.token;
        }
        if (refreshResult.kind === 'revoked') {
          // Server explicitly said this refresh token is no longer valid —
          // proper logout. refreshAuthTokenDetailed has already cleared
          // the tokens from storage; just return null.
          console.log('[SafePlay Storage] Refresh revoked — user logged out');
          return null;
        }
        // kind === 'transient' — network/5xx/endpoint-not-deployed.
        // Don't wipe the access token just because we couldn't reach
        // the server: a later call (or page reload with better network)
        // may succeed. Return the existing (expired) token so the API
        // client's own 401-retry path can have one more attempt, rather
        // than flashing the user to a signed-out UI on a network blip.
        console.log('[SafePlay Storage] Refresh transient — keeping stored tokens, returning expired access token');
        return token;
      }

      // No refresh token at all — nothing to try.
      console.log('[SafePlay Storage] Token expired and no refresh token available');
      await chrome.storage.local.remove([STORAGE_KEYS.AUTH_TOKEN]);
      return null;
    }

    // If token is expiring soon (within buffer) but not yet expired, try to refresh
    // but still return the current token if refresh fails
    if (isExpiringSoon) {
      console.log('[SafePlay Storage] Token expiring soon:', {
        expiresIn: timeUntilExpiry / 1000 + ' seconds',
        hasRefreshToken: !!refreshToken,
      });

      if (refreshToken) {
        const refreshResult = await refreshAuthTokenDetailed();
        if (refreshResult.kind === 'ok') {
          return refreshResult.token;
        }
        if (refreshResult.kind === 'revoked') {
          // Already wiped by refreshAuthTokenDetailed.
          console.log('[SafePlay Storage] Proactive refresh revoked — user logged out');
          return null;
        }
        // Transient failure during proactive refresh — current token is
        // still valid, use it.
        console.log('[SafePlay Storage] Proactive refresh failed (transient) but token still valid, using existing token');
      }
    }
  }

  return token;
}

// Get raw auth token without refresh check (for internal use)
export async function getAuthTokenRaw(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.AUTH_TOKEN);
  return result[STORAGE_KEYS.AUTH_TOKEN] || null;
}

// Check if a refresh token exists locally (for checking if user has explicit session)
export async function hasRefreshToken(): Promise<boolean> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.REFRESH_TOKEN);
  return !!result[STORAGE_KEYS.REFRESH_TOKEN];
}

export async function setAuthToken(token: string, refreshToken?: string, expiresAt?: number): Promise<void> {
  // Detailed logging to diagnose token storage issues
  console.log('[SafePlay Storage] setAuthToken called:', {
    hasToken: !!token,
    tokenLength: token?.length,
    hasRefreshToken: !!refreshToken,
    refreshTokenLength: refreshToken?.length,
    refreshTokenPreview: refreshToken ? `${refreshToken.substring(0, 10)}...` : 'none',
    expiresAt,
    expiresAtType: typeof expiresAt,
  });

  const data: Record<string, unknown> = {
    [STORAGE_KEYS.AUTH_TOKEN]: token,
  };

  if (refreshToken) {
    data[STORAGE_KEYS.REFRESH_TOKEN] = refreshToken;
  }

  if (expiresAt) {
    // Normalize expiresAt to seconds
    // If the value is > 10 billion, it's likely in milliseconds (ms timestamps are ~13 digits)
    // If the value is < 10 billion, it's likely in seconds (second timestamps are ~10 digits)
    let expiresAtSeconds = expiresAt;
    if (expiresAt > 10000000000) {
      console.log('[SafePlay Storage] expiresAt appears to be in milliseconds, converting to seconds');
      expiresAtSeconds = Math.floor(expiresAt / 1000);
    }
    data[STORAGE_KEYS.TOKEN_EXPIRES_AT] = expiresAtSeconds;
    console.log('[SafePlay Storage] Storing expiresAt:', expiresAtSeconds, '(seconds), expires:', new Date(expiresAtSeconds * 1000).toISOString());
  }

  await chrome.storage.local.set(data);
  console.log('[SafePlay Storage] Auth tokens stored successfully');
}

export async function clearAuthToken(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_KEYS.AUTH_TOKEN,
    STORAGE_KEYS.REFRESH_TOKEN,
    STORAGE_KEYS.TOKEN_EXPIRES_AT,
  ]);
}

export async function getUserId(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.USER_ID);
  return result[STORAGE_KEYS.USER_ID] || null;
}

export async function setUserId(userId: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_ID]: userId });
}

export async function getSubscriptionTier(): Promise<SubscriptionTier | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SUBSCRIPTION_TIER);
  return result[STORAGE_KEYS.SUBSCRIPTION_TIER] || null;
}

export async function setSubscriptionTier(tier: SubscriptionTier): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.SUBSCRIPTION_TIER]: tier });
}

// Credit Info storage with caching
export async function getCreditInfo(): Promise<CreditInfo | null> {
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.CREDIT_INFO,
      STORAGE_KEYS.CREDIT_CACHE_TIME,
    ]);

    const cacheTime = result[STORAGE_KEYS.CREDIT_CACHE_TIME];
    const creditInfo = result[STORAGE_KEYS.CREDIT_INFO];

    // Check if cache is valid
    if (cacheTime && creditInfo && Date.now() - cacheTime < CREDIT_CACHE_DURATION) {
      return creditInfo;
    }

    return null; // Cache expired or not present
  } catch (error) {
    console.error('[SafePlay Storage] Error getting credit info:', error);
    return null;
  }
}

export async function setCreditInfo(creditInfo: CreditInfo): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.CREDIT_INFO]: creditInfo,
      [STORAGE_KEYS.CREDIT_CACHE_TIME]: Date.now(),
    });
  } catch (error) {
    console.error('[SafePlay Storage] Error setting credit info:', error);
  }
}

export async function clearCreditInfo(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_KEYS.CREDIT_INFO,
    STORAGE_KEYS.CREDIT_CACHE_TIME,
  ]);
}

// Update credit info after a filter operation (optimistic update)
export async function updateCreditsAfterFilter(creditCost: number): Promise<void> {
  try {
    const currentInfo = await getCreditInfo();
    if (currentInfo) {
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
    }
  } catch (error) {
    console.error('[SafePlay Storage] Error updating credits after filter:', error);
  }
}

interface CachedTranscriptEntry {
  transcript: Transcript;
  timestamp: number;
}

interface TranscriptCache {
  [youtubeId: string]: CachedTranscriptEntry;
}

export async function getCachedTranscript(
  youtubeId: string
): Promise<Transcript | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.CACHED_TRANSCRIPTS);
    const cache = result[STORAGE_KEYS.CACHED_TRANSCRIPTS] || {};
    const entry = cache[youtubeId];

    if (!entry) return null;

    // Handle both old format (direct transcript) and new format (with timestamp)
    if (entry.transcript) {
      // New format. We intentionally DO NOT update entry.timestamp on read
      // and rewrite the cache — that's a giant write (transcripts are tens
      // of KB each) every time a video is replayed, and two concurrent
      // reads can clobber each other's timestamp bumps. Eviction falls
      // back to oldest-by-insert-order, which setCachedTranscript already
      // tracks on write.
      return entry.transcript;
    } else if (entry.segments) {
      // Old format - transcript stored directly, migrate to new format.
      // This write happens once per legacy entry per browser, not on every
      // read, so the cost is bounded.
      const transcript = entry as Transcript;
      cache[youtubeId] = { transcript, timestamp: Date.now() };
      await chrome.storage.local.set({ [STORAGE_KEYS.CACHED_TRANSCRIPTS]: cache });
      return transcript;
    }

    return null;
  } catch (error) {
    console.error('[SafePlay Storage] Error getting cached transcript:', error);
    return null;
  }
}

export async function setCachedTranscript(
  youtubeId: string,
  transcript: Transcript
): Promise<void> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.CACHED_TRANSCRIPTS);
    let cache: TranscriptCache = result[STORAGE_KEYS.CACHED_TRANSCRIPTS] || {};

    // Add new entry with timestamp
    cache[youtubeId] = {
      transcript,
      timestamp: Date.now(),
    };

    // Enforce cache limit - remove oldest entries if over limit
    const entries = Object.entries(cache);
    if (entries.length > MAX_CACHED_TRANSCRIPTS) {
      // Sort by timestamp (oldest first) and keep only the newest
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toKeep = entries.slice(-MAX_CACHED_TRANSCRIPTS);
      cache = Object.fromEntries(toKeep);
      console.log(`[SafePlay Storage] Trimmed transcript cache to ${MAX_CACHED_TRANSCRIPTS} entries`);
    }

    await chrome.storage.local.set({ [STORAGE_KEYS.CACHED_TRANSCRIPTS]: cache });
  } catch (error: unknown) {
    // Handle quota exceeded error
    if (error instanceof Error && error.message.includes('quota')) {
      console.warn('[SafePlay Storage] Quota exceeded, clearing transcript cache...');
      await clearCachedTranscripts();
      // Retry with fresh cache
      try {
        const freshCache: TranscriptCache = {
          [youtubeId]: { transcript, timestamp: Date.now() }
        };
        await chrome.storage.local.set({ [STORAGE_KEYS.CACHED_TRANSCRIPTS]: freshCache });
        console.log('[SafePlay Storage] Cache cleared and new transcript saved');
      } catch (retryError) {
        console.error('[SafePlay Storage] Failed to save transcript after clearing cache:', retryError);
      }
    } else {
      console.error('[SafePlay Storage] Error caching transcript:', error);
    }
  }
}

export async function clearCachedTranscripts(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.CACHED_TRANSCRIPTS);
}

export async function clearAllData(): Promise<void> {
  await chrome.storage.local.clear();
}

export async function isAuthenticated(): Promise<boolean> {
  const token = await getAuthToken();
  return token !== null;
}

/**
 * Check if user is authenticated WITHOUT triggering any auto-refresh.
 * This is a strict check that only looks at local storage.
 * Use this when you need to verify auth state without potentially
 * re-authenticating via website cookies.
 */
export async function isAuthenticatedStrict(): Promise<boolean> {
  const token = await getAuthTokenRaw();
  if (!token) {
    return false;
  }

  // Also check if token is expired
  const result = await chrome.storage.local.get(STORAGE_KEYS.TOKEN_EXPIRES_AT);
  const expiresAt = result[STORAGE_KEYS.TOKEN_EXPIRES_AT];

  if (expiresAt) {
    const now = Date.now();
    let expiresAtMs = expiresAt;
    if (expiresAt < 10000000000) {
      // It's in seconds, convert to milliseconds
      expiresAtMs = expiresAt * 1000;
    }

    // Token is expired
    if (expiresAtMs < now) {
      return false;
    }
  }

  return true;
}

// Filtered Videos Storage - tracks which videos have been filtered
export async function getFilteredVideos(): Promise<string[]> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.FILTERED_VIDEOS);
    return result[STORAGE_KEYS.FILTERED_VIDEOS] || [];
  } catch (error) {
    console.error('[SafePlay Storage] Error getting filtered videos:', error);
    return [];
  }
}

export async function addFilteredVideo(youtubeId: string): Promise<void> {
  try {
    const videos = await getFilteredVideos();
    if (!videos.includes(youtubeId)) {
      videos.push(youtubeId);
      // Keep only last 500 videos to prevent storage bloat
      const trimmedVideos = videos.slice(-500);
      await chrome.storage.local.set({ [STORAGE_KEYS.FILTERED_VIDEOS]: trimmedVideos });
    }
  } catch (error) {
    console.error('[SafePlay Storage] Error adding filtered video:', error);
  }
}

export async function isVideoFiltered(youtubeId: string): Promise<boolean> {
  try {
    const videos = await getFilteredVideos();
    return videos.includes(youtubeId);
  } catch (error) {
    console.error('[SafePlay Storage] Error checking if video filtered:', error);
    return false;
  }
}

export async function removeFilteredVideo(youtubeId: string): Promise<void> {
  const videos = await getFilteredVideos();
  const filtered = videos.filter(id => id !== youtubeId);
  await chrome.storage.local.set({ [STORAGE_KEYS.FILTERED_VIDEOS]: filtered });
}

export async function clearFilteredVideos(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.FILTERED_VIDEOS);
}

// Profile cache duration in milliseconds (10 minutes)
const PROFILE_CACHE_DURATION = 10 * 60 * 1000;

// User Profile Storage
export async function getUserProfile(): Promise<UserProfile | null> {
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.USER_PROFILE,
      STORAGE_KEYS.PROFILE_CACHE_TIME,
    ]);

    const cacheTime = result[STORAGE_KEYS.PROFILE_CACHE_TIME];
    const profile = result[STORAGE_KEYS.USER_PROFILE];

    // Check if cache is valid
    if (cacheTime && profile && Date.now() - cacheTime < PROFILE_CACHE_DURATION) {
      return profile;
    }

    return null;
  } catch (error) {
    console.error('[SafePlay Storage] Error getting user profile:', error);
    return null;
  }
}

export async function setUserProfile(profile: UserProfile): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.USER_PROFILE]: profile,
      [STORAGE_KEYS.PROFILE_CACHE_TIME]: Date.now(),
    });
  } catch (error) {
    console.error('[SafePlay Storage] Error setting user profile:', error);
  }
}

export async function getUserSubscription(): Promise<UserSubscription | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.USER_SUBSCRIPTION);
    return result[STORAGE_KEYS.USER_SUBSCRIPTION] || null;
  } catch (error) {
    console.error('[SafePlay Storage] Error getting user subscription:', error);
    return null;
  }
}

export async function setUserSubscription(subscription: UserSubscription | null): Promise<void> {
  try {
    if (subscription) {
      await chrome.storage.local.set({ [STORAGE_KEYS.USER_SUBSCRIPTION]: subscription });
    } else {
      await chrome.storage.local.remove(STORAGE_KEYS.USER_SUBSCRIPTION);
    }
  } catch (error) {
    console.error('[SafePlay Storage] Error setting user subscription:', error);
  }
}

export async function getUserCredits(): Promise<UserCredits | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.USER_CREDITS);
    return result[STORAGE_KEYS.USER_CREDITS] || null;
  } catch (error) {
    console.error('[SafePlay Storage] Error getting user credits:', error);
    return null;
  }
}

export async function setUserCredits(credits: UserCredits | null): Promise<void> {
  try {
    if (credits) {
      await chrome.storage.local.set({ [STORAGE_KEYS.USER_CREDITS]: credits });
    } else {
      await chrome.storage.local.remove(STORAGE_KEYS.USER_CREDITS);
    }
  } catch (error) {
    console.error('[SafePlay Storage] Error setting user credits:', error);
  }
}

// Clear all auth-related data (for logout)
export async function clearAuthData(): Promise<void> {
  try {
    await chrome.storage.local.remove([
      STORAGE_KEYS.AUTH_TOKEN,
      STORAGE_KEYS.REFRESH_TOKEN,
      STORAGE_KEYS.TOKEN_EXPIRES_AT,
      STORAGE_KEYS.USER_ID,
      STORAGE_KEYS.SUBSCRIPTION_TIER,
      STORAGE_KEYS.CREDIT_INFO,
      STORAGE_KEYS.CREDIT_CACHE_TIME,
      STORAGE_KEYS.USER_PROFILE,
      STORAGE_KEYS.USER_SUBSCRIPTION,
      STORAGE_KEYS.USER_CREDITS,
      STORAGE_KEYS.PROFILE_CACHE_TIME,
    ]);
    console.log('[SafePlay Storage] Auth data cleared');
  } catch (error) {
    console.error('[SafePlay Storage] Error clearing auth data:', error);
  }
}

// Get full auth state
export async function getFullAuthState(): Promise<{
  isAuthenticated: boolean;
  profile: UserProfile | null;
  subscription: UserSubscription | null;
  credits: UserCredits | null;
  token: string | null;
}> {
  const token = await getAuthToken();
  const profile = await getUserProfile();
  const subscription = await getUserSubscription();
  const credits = await getUserCredits();

  return {
    isAuthenticated: token !== null,
    profile,
    subscription,
    credits,
    token,
  };
}
