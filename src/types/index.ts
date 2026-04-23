// API Response Types

export interface TranscriptSegment {
  text: string;
  start_time: number;
  end_time: number;
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
  credit_cost_note?: string; // Note when duration/cost is unknown
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
  status: 'pending' | 'processing' | 'downloading' | 'transcribing' | 'completed' | 'failed';
  progress: number;
  message?: string;
  transcript?: Transcript;
  error?: string;
  error_code?: 'AGE_RESTRICTED' | 'VIDEO_UNAVAILABLE' | string;
  video?: {
    youtube_id: string;
    title?: string;
  };
  // Expected completion time for the job in seconds (server-computed from
  // video duration). May be null if the duration couldn't be resolved.
  eta_seconds?: number | null;
  // ISO-8601 creation timestamp of the job row on the server. Used by the
  // extension to compute elapsed time for the in-session retry budget.
  created_at?: string;
}

// Response from POST /api/filter/retry
export interface RetryJobResponse {
  status: 'processing';
  job_id: string;
  youtube_id?: string;
  message?: string;
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
  // Countdown-based progress (replaces the old percentage-driven display).
  // When set, renderers show `statusText` verbatim and MAY animate a fill
  // using remainingSeconds/totalEstimatedSeconds. progress is ignored if
  // these are present.
  remainingSeconds?: number | null;
  totalEstimatedSeconds?: number | null;
  phase?: 'connecting' | 'preparing' | 'transcribing' | 'almost-done' | 'still-working' | 'done' | 'error';
  statusText?: string;
}

// Snapshot shared between content script and popup so both show the same
// countdown without running independent timers.
export interface TranscriptionStateBroadcast {
  youtubeId: string;
  phase: 'connecting' | 'preparing' | 'transcribing' | 'almost-done' | 'still-working' | 'done' | 'error';
  remainingSeconds: number | null;
  totalEstimatedSeconds: number | null;
  statusText: string;
  errorCode?: string;
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
  autoFilterAllVideos: boolean; // Auto-start filter on every YouTube video (opt-in)
  confirmBeforeAutoFilter: boolean; // When auto-filter-all is on, still show the credit confirmation modal
  showTimelineMarkers: boolean; // Render profanity markers on the video progress bar
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
  autoFilterAllVideos: false, // Off by default — users opt in when they want total coverage
  confirmBeforeAutoFilter: false, // Off by default — auto-filter runs without interrupting. Users can flip on for cost oversight.
  showTimelineMarkers: true, // On by default — useful visual affordance
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
  | 'RETRY_JOB'
  | 'GET_CREDITS'
  | 'GET_PREFERENCES'
  | 'SET_PREFERENCES'
  | 'FINISH_ONBOARDING'
  | 'GET_AUTH_STATUS'
  | 'CHECK_AUTH_STRICT'
  | 'GET_USER_PROFILE'
  | 'LOGOUT'
  | 'OPEN_LOGIN'
  | 'CLEAR_CACHE'
  // Reactive store plumbing: non-background contexts send STORE_PROPOSE to
  // the background when they want to mutate a shared key. Background is the
  // only writer — every other surface subscribes via chrome.storage.onChanged.
  | 'STORE_PROPOSE';

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
  creditCostNote?: string; // Note when cost is unknown (e.g., "~1 credit per minute")
  creditCostUnknown?: boolean; // True when duration unavailable
  userCredits: number;
  hasSufficientCredits: boolean;
  isCached: boolean;
}

// Filter confirmation payload from content script
export interface FilterConfirmPayload {
  youtubeId: string;
  filterType?: 'mute' | 'bleep';
  customWords?: string[];
  creditCost?: number;
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

// ---------------------------------------------------------------------------
// Reactive store state — per-tab snapshots and singleflight visibility.
//
// SessionState lives in chrome.storage.local and is wholly owned by the
// background worker. Content scripts propose patches; popup/options read via
// chrome.storage.onChanged. Tab IDs don't survive a browser restart, so
// background wipes `byTab` on onStartup.
// ---------------------------------------------------------------------------

export interface TabSnapshot {
  tabId: number;
  url: string;
  videoId: string | null;
  filterActive: boolean;
  buttonState: ButtonStateInfo;
  transcription: TranscriptionStateBroadcast | null;
  intervalCount: number;
  updatedAt: number;
}

export interface JobSummary {
  jobId: string;
  youtubeId: string;
  status: 'pending' | 'processing' | 'downloading' | 'transcribing' | 'completed' | 'failed';
  startedAt: number;
  creditCost?: number;
}

export interface SessionState {
  byTab: Record<number, TabSnapshot>;
  activeJobs: Record<string, JobSummary>;
  lastUpdated: number;
}

// InflightState lives in chrome.storage.session (per-browser-session, fires
// onChanged in every context). Popup subscribes to render "fetching..." UI
// without requiring bespoke messages from background.
export interface InflightState {
  // keyed by youtubeId — a filter start in flight to the server
  filterStarts: Record<string, { startedAt: number }>;
  // keyed by youtubeId — a preview fetch in flight
  previews: Record<string, { startedAt: number }>;
  // keyed by some coarse identifier — credit balance refresh in flight
  creditFetch: { startedAt: number } | null;
}

export const EMPTY_INFLIGHT_STATE: InflightState = {
  filterStarts: {},
  previews: {},
  creditFetch: null,
};

export const EMPTY_SESSION_STATE: SessionState = {
  byTab: {},
  activeJobs: {},
  lastUpdated: 0,
};

// STORE_PROPOSE payload: non-background surfaces send a partial patch for a
// top-level reactive key. Background merges with a per-key mutex and commits.
export interface StoreProposePayload {
  key: 'preferences' | 'sessionState' | 'inflight';
  // For sessionState, patch is { byTab?: Record<tabId, Partial<TabSnapshot>>,
  //                              activeJobs?: Record<jobId, Partial<JobSummary> | null> }.
  // A null value under byTab/activeJobs means "delete this entry".
  patch: unknown;
}
