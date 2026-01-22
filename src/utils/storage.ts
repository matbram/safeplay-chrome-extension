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

const STORAGE_KEYS = {
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
const API_BASE_URL = 'https://astonishing-youthfulness-production.up.railway.app';

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

// Refresh the auth token using the refresh token
export async function refreshAuthToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.REFRESH_TOKEN);
  const refreshToken = result[STORAGE_KEYS.REFRESH_TOKEN];

  // Detailed logging to diagnose token issues
  console.log('[SafePlay Storage] Refresh token retrieval:', {
    hasToken: !!refreshToken,
    tokenLength: refreshToken?.length,
    tokenPreview: refreshToken ? `${refreshToken.substring(0, 10)}...${refreshToken.substring(refreshToken.length - 10)}` : 'none',
  });

  if (!refreshToken) {
    console.log('[SafePlay Storage] No refresh token available');
    return null;
  }

  // Validate refresh token length - Supabase tokens are 100+ chars
  if (refreshToken.length < 50) {
    console.error('[SafePlay Storage] Refresh token appears invalid (too short):', refreshToken.length, 'chars');
    console.error('[SafePlay Storage] This suggests the wrong value was stored as refresh token');
    // Don't clear - let user retry login manually
    return null;
  }

  try {
    console.log('[SafePlay Storage] Attempting to refresh auth token...');
    const response = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData: Record<string, unknown> = {};
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { rawError: errorText };
      }

      console.log('[SafePlay Storage] Token refresh failed:', {
        status: response.status,
        error: errorData.error || errorData.message || errorText,
        code: errorData.code || errorData.error_code,
      });

      // Only clear access token on failure - keep refresh token for potential retry
      // unless it's an "already used" error which means the token is permanently invalid
      const errorCode = String(errorData.code || errorData.error_code || '');
      const errorMsg = String(errorData.error || errorData.message || '');
      const isTokenInvalid = errorCode.includes('already_used') ||
                            errorMsg.includes('Already Used') ||
                            errorCode.includes('invalid') ||
                            response.status === 400;

      if (isTokenInvalid) {
        console.log('[SafePlay Storage] Refresh token is invalid, clearing all auth data');
        await chrome.storage.local.remove([
          STORAGE_KEYS.AUTH_TOKEN,
          STORAGE_KEYS.REFRESH_TOKEN,
          STORAGE_KEYS.TOKEN_EXPIRES_AT,
        ]);
      } else {
        // For other errors (rate limit, server error), only clear access token
        console.log('[SafePlay Storage] Clearing only access token, keeping refresh token for retry');
        await chrome.storage.local.remove([STORAGE_KEYS.AUTH_TOKEN]);
      }
      return null;
    }

    const data = await response.json();

    // Handle both snake_case and camelCase response formats
    const newAccessToken = data.access_token || data.token;
    const newRefreshToken = data.refresh_token || data.refreshToken;
    const newExpiresAt = data.expires_at || (data.expiresAt ? Math.floor(data.expiresAt / 1000) : null);

    console.log('[SafePlay Storage] Refresh response:', {
      hasAccessToken: !!newAccessToken,
      hasRefreshToken: !!newRefreshToken,
      refreshTokenLength: newRefreshToken?.length,
      expiresAt: newExpiresAt,
      expiresAtSource: data.expires_at ? 'expires_at (seconds)' : 'expiresAt (converted from ms)',
    });

    // Validate new refresh token before storing
    if (!newRefreshToken || newRefreshToken.length < 50) {
      console.error('[SafePlay Storage] New refresh token is missing or invalid, keeping old one');
      // Store access token but keep old refresh token
      if (newAccessToken) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.AUTH_TOKEN]: newAccessToken,
          ...(newExpiresAt && { [STORAGE_KEYS.TOKEN_EXPIRES_AT]: newExpiresAt }),
        });
      }
      return newAccessToken || null;
    }

    // Store new tokens
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTH_TOKEN]: newAccessToken,
      [STORAGE_KEYS.REFRESH_TOKEN]: newRefreshToken,
      ...(newExpiresAt && { [STORAGE_KEYS.TOKEN_EXPIRES_AT]: newExpiresAt }),
    });

    console.log('[SafePlay Storage] Token refreshed successfully, new refresh token stored');
    return newAccessToken;
  } catch (error) {
    // Network errors (Failed to fetch) are expected when offline or server unreachable
    // Don't clear auth data - keep tokens for retry when network is back
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
      console.log('[SafePlay Storage] Token refresh failed (network unavailable), keeping tokens for retry');
    } else {
      console.warn('[SafePlay Storage] Token refresh error:', error);
    }
    return null;
  }
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
        const newToken = await refreshAuthToken();
        if (newToken) {
          return newToken;
        }
      }

      // Refresh failed and token is expired - clear access token but keep refresh for manual retry
      console.log('[SafePlay Storage] Token expired and refresh failed');
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
        const newToken = await refreshAuthToken();
        if (newToken) {
          return newToken;
        }
        // Refresh failed but token is still valid - use it anyway
        console.log('[SafePlay Storage] Proactive refresh failed but token still valid, using existing token');
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

  // Validate refresh token before storing
  if (refreshToken && refreshToken.length < 50) {
    console.error('[SafePlay Storage] WARNING: Refresh token appears too short:', refreshToken.length, 'chars');
    console.error('[SafePlay Storage] Expected 100+ chars for a valid Supabase refresh token');
    console.error('[SafePlay Storage] Received value:', refreshToken);
  }

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
      // New format with timestamp
      entry.timestamp = Date.now();
      await chrome.storage.local.set({ [STORAGE_KEYS.CACHED_TRANSCRIPTS]: cache });
      return entry.transcript;
    } else if (entry.segments) {
      // Old format - transcript stored directly, migrate to new format
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
