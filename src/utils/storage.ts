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

export async function getCachedTranscript(
  youtubeId: string
): Promise<Transcript | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CACHED_TRANSCRIPTS);
  const cache = result[STORAGE_KEYS.CACHED_TRANSCRIPTS] || {};
  return cache[youtubeId] || null;
}

export async function setCachedTranscript(
  youtubeId: string,
  transcript: Transcript
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CACHED_TRANSCRIPTS);
  const cache = result[STORAGE_KEYS.CACHED_TRANSCRIPTS] || {};
  cache[youtubeId] = transcript;
  await chrome.storage.local.set({ [STORAGE_KEYS.CACHED_TRANSCRIPTS]: cache });
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
  const result = await chrome.storage.local.get(STORAGE_KEYS.FILTERED_VIDEOS);
  return result[STORAGE_KEYS.FILTERED_VIDEOS] || [];
}

export async function addFilteredVideo(youtubeId: string): Promise<void> {
  const videos = await getFilteredVideos();
  if (!videos.includes(youtubeId)) {
    videos.push(youtubeId);
    // Keep only last 500 videos to prevent storage bloat
    const trimmedVideos = videos.slice(-500);
    await chrome.storage.local.set({ [STORAGE_KEYS.FILTERED_VIDEOS]: trimmedVideos });
  }
}

export async function isVideoFiltered(youtubeId: string): Promise<boolean> {
  const videos = await getFilteredVideos();
  return videos.includes(youtubeId);
}

export async function removeFilteredVideo(youtubeId: string): Promise<void> {
  const videos = await getFilteredVideos();
  const filtered = videos.filter(id => id !== youtubeId);
  await chrome.storage.local.set({ [STORAGE_KEYS.FILTERED_VIDEOS]: filtered });
}

export async function clearFilteredVideos(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.FILTERED_VIDEOS);
}
