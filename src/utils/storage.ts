import {
  StorageData,
  UserPreferences,
  DEFAULT_PREFERENCES,
  Transcript,
} from '../types';

const STORAGE_KEYS = {
  PREFERENCES: 'safeplay_preferences',
  AUTH_TOKEN: 'safeplay_auth_token',
  USER_ID: 'safeplay_user_id',
  SUBSCRIPTION_TIER: 'safeplay_subscription_tier',
  CACHED_TRANSCRIPTS: 'safeplay_cached_transcripts',
  FILTERED_VIDEOS: 'safeplay_filtered_videos',
} as const;

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

export async function getAuthToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.AUTH_TOKEN);
  return result[STORAGE_KEYS.AUTH_TOKEN] || null;
}

export async function setAuthToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKEN]: token });
}

export async function clearAuthToken(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.AUTH_TOKEN);
}

export async function getUserId(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.USER_ID);
  return result[STORAGE_KEYS.USER_ID] || null;
}

export async function setUserId(userId: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_ID]: userId });
}

export async function getSubscriptionTier(): Promise<
  StorageData['subscriptionTier'] | null
> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SUBSCRIPTION_TIER);
  return result[STORAGE_KEYS.SUBSCRIPTION_TIER] || null;
}

export async function setSubscriptionTier(
  tier: StorageData['subscriptionTier']
): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.SUBSCRIPTION_TIER]: tier });
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
