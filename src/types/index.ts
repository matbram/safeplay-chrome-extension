// API Response Types

export interface CharacterTiming {
  char: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  text: string;
  start_time: number;
  end_time: number;
  characters: CharacterTiming[];
}

export interface Transcript {
  id: string;
  youtube_id?: string; // May be set from context
  full_text?: string;
  segments: TranscriptSegment[];
  duration?: number;
  language?: string;
  created_at?: string;
}

// Video metadata from preview endpoint
export interface VideoMetadata {
  youtube_id: string;
  title: string;
  duration: number; // in seconds
  thumbnail?: string;
  channel?: string;
}

// Credit system types
export interface CreditInfo {
  available: number;
  used_this_period: number;
  plan_allocation: number;
  percent_consumed: number;
  plan?: 'free' | 'base' | 'professional' | 'unlimited';
  reset_date?: string;
}

// Preview response - check cost before filtering (matches actual API format)
export interface PreviewResponse {
  youtube_id: string;
  title: string;
  channel_name?: string;
  duration_seconds: number;
  thumbnail_url?: string;
  credit_cost: number;
  user_credits: number;
  has_sufficient_credits: boolean;
  cached: boolean;
  has_transcript: boolean;
  error?: string;
  error_code?: 'AGE_RESTRICTED' | 'VIDEO_UNAVAILABLE' | 'UNAUTHORIZED' | string;
}

// Credit balance response
export interface CreditBalanceResponse {
  success: boolean;
  credits: CreditInfo;
  error?: string;
}

// Filter start response
export interface FilterStartResponse {
  success: boolean;
  status: 'completed' | 'processing' | 'failed';
  cached?: boolean;
  transcript?: Transcript;
  job_id?: string;
  message?: string;
  error?: string;
  error_code?: 'INSUFFICIENT_CREDITS' | 'AGE_RESTRICTED' | 'VIDEO_UNAVAILABLE' | 'UNAUTHORIZED' | string;
  credits_required?: number;
  credits_available?: number;
}

// Job status response
export interface JobStatusResponse {
  status: 'pending' | 'downloading' | 'transcribing' | 'completed' | 'failed';
  progress: number;
  message?: string;
  transcript?: Transcript;
  error?: string;
  error_code?: 'AGE_RESTRICTED' | 'VIDEO_UNAVAILABLE' | string;
  video?: {
    youtube_id: string;
    title?: string;
  };
}

// Legacy FilterResponse - kept for compatibility during migration
export interface FilterResponse {
  status: 'completed' | 'processing' | 'failed';
  cached?: boolean;
  transcript?: Transcript;
  job_id?: string;
  message?: string;
  error?: string;
  error_code?: string;  // 'AGE_RESTRICTED', 'VIDEO_UNAVAILABLE', etc.
}

// Button state for UX
export type ButtonState =
  | 'idle'
  | 'connecting'
  | 'downloading'
  | 'transcribing'
  | 'processing'
  | 'filtering'
  | 'paused'  // Filter is paused (user can re-enable)
  | 'error'
  | 'age-restricted';  // Video is age-restricted and cannot be filtered

export interface ButtonStateInfo {
  state: ButtonState;
  text: string;
  progress?: number;
  intervalCount?: number;
  error?: string;
  videoId?: string; // Track which video this state belongs to (for Shorts)
}

// Profanity Types

export type SeverityLevel = 'mild' | 'moderate' | 'severe' | 'religious';

export interface ProfanityWord {
  word: string;
  severity: SeverityLevel;
}

export interface MuteInterval {
  start: number;
  end: number;
  word: string;
  severity: SeverityLevel;
}

export interface ProfanityMatch {
  segmentIndex: number;
  word: string;
  severity: SeverityLevel;
  startTime: number;
  endTime: number;
  isPartialMatch: boolean;
  matchedPortion?: string;
}

// User Preferences

export type FilterMode = 'mute' | 'bleep';

export interface UserPreferences {
  enabled: boolean;
  filterMode: FilterMode;
  severityLevels: {
    mild: boolean;
    moderate: boolean;
    severe: boolean;
    religious: boolean;
  };
  customBlacklist: string[];
  customWhitelist: string[];
  paddingMs: number; // Legacy/fallback symmetric padding
  paddingBeforeMs?: number; // Padding before word starts (catches attack)
  paddingAfterMs?: number; // Padding after word ends (catches release)
  mergeThresholdMs: number;
  autoEnableForFilteredVideos: boolean; // Auto-enable filter for previously filtered videos
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  enabled: true,
  filterMode: 'mute',
  severityLevels: {
    mild: false,
    moderate: true,
    severe: true,
    religious: false, // Off by default - user opt-in
  },
  customBlacklist: [],
  customWhitelist: [],
  paddingMs: 50, // Legacy/fallback symmetric padding
  paddingBeforeMs: 100, // Padding before word - smooth fade adds ~130ms effective lead time
  paddingAfterMs: 30, // Padding after word ends
  mergeThresholdMs: 100,
  autoEnableForFilteredVideos: true, // Auto-enable filter for previously filtered videos
};

// Storage Types

export type SubscriptionTier = 'free' | 'base' | 'professional' | 'unlimited';

export interface StorageData {
  preferences: UserPreferences;
  authToken?: string;
  userId?: string;
  subscriptionTier?: SubscriptionTier;
  creditInfo?: CreditInfo;
  cachedTranscripts: Record<string, Transcript>;
}

// Message Types (between content script and background)

export type MessageType =
  | 'GET_FILTER'
  | 'GET_PREVIEW'
  | 'START_FILTER'
  | 'CHECK_JOB'
  | 'GET_CREDITS'
  | 'GET_PREFERENCES'
  | 'SET_PREFERENCES'
  | 'GET_AUTH_STATUS'
  | 'GET_USER_PROFILE'
  | 'LOGOUT'
  | 'OPEN_LOGIN'
  | 'CLEAR_CACHE';

export interface Message<T = unknown> {
  type: MessageType;
  payload?: T;
}

export interface MessageResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// Preview data passed to content script
export interface PreviewData {
  video: VideoMetadata;
  creditCost: number;
  userCredits: number;
  hasSufficientCredits: boolean;
  isCached: boolean;
}

// Filter confirmation payload from content script
export interface FilterConfirmPayload {
  youtubeId: string;
  filterType?: 'mute' | 'bleep';
  customWords?: string[];
}

// User Profile Types
export interface UserProfile {
  id: string;
  email: string;
  full_name?: string;
  avatar_url?: string;
  created_at?: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'active' | 'canceled' | 'past_due' | 'paused';
  current_period_start?: string;
  current_period_end?: string;
  plans?: {
    id: string;
    name: string;
    monthly_credits: number;
  };
}

export interface UserCredits {
  user_id: string;
  available_credits: number;
  used_this_period: number;
  rollover_credits: number;
  updated_at?: string;
}

export interface UserProfileResponse {
  user: UserProfile;
  subscription: UserSubscription | null;
  credits: UserCredits | null;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: UserProfile | null;
  subscription: UserSubscription | null;
  credits: UserCredits | null;
  token: string | null;
}
