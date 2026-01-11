import { FilterResponse, JobStatusResponse, Transcript } from '../types';
import { getAuthToken } from '../utils/storage';

const API_BASE_URL = 'https://api.safeplay.app';

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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requiresAuth) {
    const token = await getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new ApiError(
      errorData.message || `Request failed with status ${response.status}`,
      response.status,
      errorData
    );
  }

  return response.json();
}

export async function requestFilter(youtubeId: string): Promise<FilterResponse> {
  return request<FilterResponse>('/api/filter', {
    method: 'POST',
    body: { youtube_id: youtubeId },
  });
}

export async function checkJobStatus(jobId: string): Promise<JobStatusResponse> {
  return request<JobStatusResponse>(`/api/jobs/${jobId}`);
}

export async function getTranscript(youtubeId: string): Promise<Transcript> {
  return request<Transcript>(`/api/transcript/${youtubeId}`);
}

export async function pollForTranscript(
  jobId: string,
  onProgress?: (progress: number) => void,
  maxAttempts = 120,
  intervalMs = 2000
): Promise<Transcript> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    const status = await checkJobStatus(jobId);

    if (onProgress) {
      onProgress(status.progress);
    }

    if (status.status === 'completed' && status.transcript) {
      return status.transcript;
    }

    if (status.status === 'failed') {
      throw new ApiError(
        status.error || 'Transcription failed',
        500,
        status
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    attempts++;
  }

  throw new ApiError('Transcription timed out', 408);
}

export async function getOrRequestTranscript(
  youtubeId: string,
  onProgress?: (progress: number) => void
): Promise<Transcript> {
  const response = await requestFilter(youtubeId);

  if (response.status === 'cached' && response.transcript) {
    return response.transcript;
  }

  if (response.status === 'processing' && response.job_id) {
    return pollForTranscript(response.job_id, onProgress);
  }

  throw new ApiError('Unexpected response from filter API', 500, response);
}

export { ApiError };
