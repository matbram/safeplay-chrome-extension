import { FilterResponse, JobStatusResponse, Transcript } from '../types';
import { getAuthToken } from '../utils/storage';

// API URL for the orchestration service
const API_BASE_URL = 'https://safeplay-orchestrator-production.up.railway.app';

// Verbose logging
function logApi(...args: unknown[]): void {
  console.log('[SafePlay API]', ...args);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  requiresAuth?: boolean;
}

class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = 'GET', body, requiresAuth = true } = options;
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

      throw new ApiError(
        errorData.message as string || errorData.error as string || `Request failed with status ${response.status}`,
        response.status,
        errorData
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

export async function requestFilter(youtubeId: string): Promise<FilterResponse> {
  logApi('=== requestFilter ===', youtubeId);
  return request<FilterResponse>('/api/filter', {
    method: 'POST',
    body: { youtube_id: youtubeId },
    requiresAuth: false, // Allow without auth for now
  });
}

export async function checkJobStatus(jobId: string): Promise<JobStatusResponse> {
  logApi('=== checkJobStatus ===', jobId);
  return request<JobStatusResponse>(`/api/jobs/${jobId}`, {
    requiresAuth: false, // Allow without auth for now
  });
}

export async function getTranscript(youtubeId: string): Promise<Transcript> {
  logApi('=== getTranscript ===', youtubeId);
  return request<Transcript>(`/api/transcript/${youtubeId}`, {
    requiresAuth: false,
  });
}

export async function pollForTranscript(
  jobId: string,
  onProgress?: (progress: number) => void,
  maxAttempts = 120,
  intervalMs = 2000
): Promise<Transcript> {
  logApi('=== pollForTranscript ===', jobId);
  let attempts = 0;

  while (attempts < maxAttempts) {
    const status = await checkJobStatus(jobId);

    if (onProgress) {
      onProgress(status.progress);
    }

    if (status.status === 'completed' && status.transcript) {
      logApi('Poll completed, got transcript');
      return status.transcript;
    }

    if (status.status === 'failed') {
      logApi('Poll failed:', status.error);
      throw new ApiError(
        status.error || 'Transcription failed',
        500,
        status
      );
    }

    logApi(`Poll attempt ${attempts + 1}/${maxAttempts}, status: ${status.status}, progress: ${status.progress}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    attempts++;
  }

  throw new ApiError('Transcription timed out', 408);
}

export async function getOrRequestTranscript(
  youtubeId: string,
  onProgress?: (progress: number) => void
): Promise<Transcript> {
  logApi('=== getOrRequestTranscript ===', youtubeId);
  const response = await requestFilter(youtubeId);

  if (response.status === 'cached' && response.transcript) {
    logApi('Got cached transcript');
    return response.transcript;
  }

  if (response.status === 'processing' && response.job_id) {
    logApi('Processing started, job_id:', response.job_id);
    return pollForTranscript(response.job_id, onProgress);
  }

  throw new ApiError('Unexpected response from filter API', 500, response);
}

export { ApiError };
