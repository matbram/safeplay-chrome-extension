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

export interface FilterResponse {
  status: 'completed' | 'processing';
  cached?: boolean;
  transcript?: Transcript;
  job_id?: string;
  message?: string;
}

export interface JobStatusResponse {
  status: 'pending' | 'downloading' | 'transcribing' | 'completed' | 'failed';
  progress: number;
  transcript?: Transcript;
  error?: string;
  video?: {
    youtube_id: string;
    title?: string;
  };
}

// Button state for UX
export type ButtonState =
  | 'idle'
  | 'connecting'
  | 'downloading'
  | 'transcribing'
  | 'processing'
  | 'filtering'
  | 'error';

export interface ButtonStateInfo {
  state: ButtonState;
  text: string;
  progress?: number;
  intervalCount?: number;
  error?: string;
}

// Profanity Types

export type SeverityLevel = 'mild' | 'moderate' | 'severe';

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
  };
  customBlacklist: string[];
  customWhitelist: string[];
  paddingMs: number; // Legacy/fallback symmetric padding
  paddingBeforeMs?: number; // Padding before word starts (catches attack)
  paddingAfterMs?: number; // Padding after word ends (catches release)
  mergeThresholdMs: number;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  enabled: true,
  filterMode: 'mute',
  severityLevels: {
    mild: false,
    moderate: true,
    severe: true,
  },
  customBlacklist: [],
  customWhitelist: [],
  paddingMs: 50, // Legacy/fallback symmetric padding
  paddingBeforeMs: 75, // Reduced - smooth fade adds ~90ms effective lead time
  paddingAfterMs: 25, // Reduced - fade-in handles smooth transition
  mergeThresholdMs: 100,
};

// Storage Types

export interface StorageData {
  preferences: UserPreferences;
  authToken?: string;
  userId?: string;
  subscriptionTier?: 'free' | 'basic' | 'professional' | 'unlimited';
  cachedTranscripts: Record<string, Transcript>;
}

// Message Types (between content script and background)

export type MessageType =
  | 'GET_FILTER'
  | 'CHECK_JOB'
  | 'GET_PREFERENCES'
  | 'SET_PREFERENCES'
  | 'GET_AUTH_STATUS'
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
