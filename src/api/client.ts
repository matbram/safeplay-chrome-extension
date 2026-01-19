import {
  FilterStartResponse,
  JobStatusResponse,
  Transcript,
  PreviewResponse,
  CreditBalanceResponse,
  UserProfileResponse,
} from '../types';
import { getAuthToken, refreshAuthToken } from '../utils/storage';

// API URL for the SafePlay website API
const API_BASE_URL = 'https://astonishing-youthfulness-production.up.railway.app';

// Verbose logging
function logApi(...args: unknown[]): void {
  console.log('[SafePlay API]', ...args);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  requiresAuth?: boolean;
  _isRetry?: boolean; // Internal flag to prevent infinite retry loops
}

export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: unknown,
    public errorCode?: string  // 'AGE_RESTRICTED', 'VIDEO_UNAVAILABLE', 'INSUFFICIENT_CREDITS', etc.
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = 'GET', body, requiresAuth = true, _isRetry = false } = options;
  const url = `${API_BASE_URL}${endpoint}`;

  logApi(`>>> ${method} ${url}`, body ? JSON.stringify(body) : '');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requiresAuth) {
    const token = await getAuthToken();
    logApi('Auth token:', token ? `${token.substring(0, 20)}...` : 'none');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    logApi(`<<< ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      logApi('Error response body:', errorText);

      let errorData: Record<string, unknown> = {};
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { rawError: errorText };
      }

      // Handle 401 Unauthorized - try to refresh token and retry
      if (response.status === 401 && requiresAuth && !_isRetry) {
        logApi('Got 401, attempting token refresh...');
        const newToken = await refreshAuthToken();

        if (newToken) {
          logApi('Token refreshed, retrying request...');
          // Retry the request with the new token
          return request<T>(endpoint, { ...options, _isRetry: true });
        }

        logApi('Token refresh failed, user needs to re-login');
        throw new ApiError(
          'Session expired. Please sign in again.',
          401,
          errorData,
          'SESSION_EXPIRED'
        );
      }

      throw new ApiError(
        errorData.message as string || errorData.error as string || `Request failed with status ${response.status}`,
        response.status,
        errorData,
        errorData.error_code as string
      );
    }

    const data = await response.json();
    logApi('Response data:', JSON.stringify(data).substring(0, 500));
    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    // Network or other error
    const message = error instanceof Error ? error.message : 'Network error';
    logApi('Request failed:', message);
    throw new ApiError(message, 0, { networkError: true, originalError: String(error) });
  }
}

/**
 * Get video preview - retrieves video metadata and credit cost before filtering
 * This should be called first to check if the user has enough credits
 */
export async function getPreview(youtubeId: string): Promise<PreviewResponse> {
  logApi('=== getPreview ===', youtubeId);
  return request<PreviewResponse>('/api/filter/preview', {
    method: 'POST',
    body: { youtube_id: youtubeId },
    requiresAuth: true,
  });
}

/**
 * Get user's credit balance
 */
export async function getCreditBalance(): Promise<CreditBalanceResponse> {
  logApi('=== getCreditBalance ===');
  return request<CreditBalanceResponse>('/api/credits/balance', {
    method: 'GET',
    requiresAuth: true,
  });
}

/**
 * Get user profile including subscription and credits
 */
export async function getUserProfile(): Promise<UserProfileResponse> {
  logApi('=== getUserProfile ===');
  return request<UserProfileResponse>('/api/user/profile', {
    method: 'GET',
    requiresAuth: true,
  });
}

/**
 * Start filtering a video - initiates transcription if not cached
 * Credits are deducted upon completion
 */
export async function startFilter(
  youtubeId: string,
  filterType: 'mute' | 'bleep' = 'mute',
  customWords?: string[]
): Promise<FilterStartResponse> {
  logApi('=== startFilter ===', youtubeId, filterType);
  return request<FilterStartResponse>('/api/filter/start', {
    method: 'POST',
    body: {
      youtube_id: youtubeId,
      filter_type: filterType,
      custom_words: customWords,
    },
    requiresAuth: true,
  });
}

/**
 * Check job status - poll for transcription progress
 */
export async function checkJobStatus(jobId: string): Promise<JobStatusResponse> {
  logApi('=== checkJobStatus ===', jobId);
  return request<JobStatusResponse>(`/api/filter/status/${jobId}`, {
    method: 'GET',
    requiresAuth: true,
  });
}

/**
 * Get cached transcript by YouTube ID
 * @deprecated Use getPreview and startFilter instead
 */
export async function getTranscript(youtubeId: string): Promise<Transcript> {
  logApi('=== getTranscript ===', youtubeId);
  return request<Transcript>(`/api/transcript/${youtubeId}`, {
    requiresAuth: true,
  });
}

/**
 * Poll for transcript completion with progress updates
 */
export async function pollForTranscript(
  jobId: string,
  onProgress?: (progress: number, message?: string) => void,
  maxAttempts = 120,
  intervalMs = 2000
): Promise<Transcript> {
  logApi('=== pollForTranscript ===', jobId);
  let attempts = 0;

  while (attempts < maxAttempts) {
    const status = await checkJobStatus(jobId);

    if (onProgress) {
      onProgress(status.progress, status.message);
    }

    if (status.status === 'completed' && status.transcript) {
      logApi('Poll completed, got transcript');
      return status.transcript;
    }

    if (status.status === 'failed') {
      logApi('Poll failed:', status.error, 'error_code:', status.error_code);
      throw new ApiError(
        status.error || 'Transcription failed',
        500,
        status,
        status.error_code
      );
    }

    logApi(`Poll attempt ${attempts + 1}/${maxAttempts}, status: ${status.status}, progress: ${status.progress}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    attempts++;
  }

  throw new ApiError('Transcription timed out', 408);
}

/**
 * Main entry point for filtering - handles preview, credit check, and starting filter
 * Use this for new integrations instead of the legacy requestFilter
 */
export async function getOrRequestTranscript(
  youtubeId: string,
  onProgress?: (progress: number, message?: string) => void,
  skipPreview = false
): Promise<{ transcript: Transcript; creditCost: number; wasCached: boolean }> {
  logApi('=== getOrRequestTranscript ===', youtubeId);

  // Step 1: Get preview (unless skipped, e.g., for cached videos)
  if (!skipPreview) {
    const preview = await getPreview(youtubeId);

    // Check for error in response
    if (preview.error || preview.error_code) {
      throw new ApiError(
        preview.error || 'Failed to get video preview',
        400,
        preview,
        preview.error_code
      );
    }

    if (!preview.has_sufficient_credits) {
      throw new ApiError(
        `Insufficient credits. Need ${preview.credit_cost}, have ${preview.user_credits}`,
        402,
        preview,
        'INSUFFICIENT_CREDITS'
      );
    }
  }

  // Step 2: Start filtering
  const response = await startFilter(youtubeId);

  if (!response.success) {
    throw new ApiError(
      response.error || 'Failed to start filter',
      400,
      response,
      response.error_code
    );
  }

  if (response.status === 'completed' && response.transcript) {
    logApi('Got completed/cached transcript');
    return {
      transcript: response.transcript,
      creditCost: 0, // Cached transcripts don't cost credits
      wasCached: response.cached || false,
    };
  }

  if (response.status === 'processing' && response.job_id) {
    logApi('Processing started, job_id:', response.job_id);
    const transcript = await pollForTranscript(response.job_id, onProgress);
    return {
      transcript,
      creditCost: 1, // Credits deducted after completion
      wasCached: false,
    };
  }

  throw new ApiError('Unexpected response from filter API', 500, response);
}

// Legacy function for backwards compatibility during migration
export async function requestFilter(youtubeId: string): Promise<{
  status: 'completed' | 'processing' | 'failed';
  cached?: boolean;
  transcript?: Transcript;
  job_id?: string;
  error?: string;
  error_code?: string;
}> {
  logApi('=== requestFilter (legacy) ===', youtubeId);
  try {
    const response = await startFilter(youtubeId);
    return {
      status: response.status,
      cached: response.cached,
      transcript: response.transcript,
      job_id: response.job_id,
      error: response.error,
      error_code: response.error_code,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        status: 'failed',
        error: error.message,
        error_code: error.errorCode,
      };
    }
    throw error;
  }
}

export { ApiError as default };
