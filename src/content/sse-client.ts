// SSE client for transcription job events.
// Uses fetch() + ReadableStream so we can attach a Bearer token header
// (plain EventSource can't set Authorization). Runs in the content
// script; lifecycle is tied to the content script instance.

export interface SSEConnectedData {
  job_id: string;
  status: string;
  progress?: number;
}

export interface SSEProgressData {
  job_id: string;
  status: string;
  progress?: number;
}

export interface SSECompleteData {
  job_id: string;
}

export interface SSEErrorData {
  job_id: string;
  error: string;
  error_code?: string;
}

export interface SSEClientHandlers {
  onConnected?: (data: SSEConnectedData) => void;
  onProgress?: (data: SSEProgressData) => void;
  onComplete?: (data: SSECompleteData) => void;
  onServerError?: (data: SSEErrorData) => void;
  // Transport-level failure (network, auth, parse) — caller should fall back to polling.
  onTransportError?: (err: Error) => void;
}

export interface SSEClientOptions extends SSEClientHandlers {
  url: string;
  token: string;
  debug?: boolean;
}

export class TranscriptionSSEClient {
  private controller: AbortController | null = null;
  private closed = false;
  private readonly opts: SSEClientOptions;

  constructor(opts: SSEClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.controller = new AbortController();
    try {
      const response = await fetch(this.opts.url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        signal: this.controller.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error('SSE response has no body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line ("\n\n"). Normalize CRLF
        // to LF so we handle both.
        buffer = buffer.replace(/\r\n/g, '\n');

        let sepIdx: number;
        while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          this.dispatchFrame(frame);
        }
      }
    } catch (err) {
      if (this.closed) return; // Abort was intentional.
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name === 'AbortError') return;
      this.log('SSE transport error:', error.message);
      this.opts.onTransportError?.(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller?.abort();
    this.controller = null;
  }

  private dispatchFrame(frame: string): void {
    // Skip empty frames and comment/heartbeat lines (":heartbeat", ":ok", etc.).
    // A frame may contain multiple lines; if every non-empty line starts with
    // ":", it's a pure comment frame — skip it.
    const lines = frame.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return;
    if (lines.every((l) => l.startsWith(':'))) return;

    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue; // inline comment
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      // Ignore id:/retry: — not used by our server.
    }
    if (dataLines.length === 0) return;

    const rawData = dataLines.join('\n');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      this.log('SSE: failed to parse JSON payload:', rawData.slice(0, 200));
      return;
    }

    // Wrap each handler call so a throw inside application code (updating
    // DOM, touching stale filter state, etc.) doesn't propagate up through
    // the read loop. The read loop's catch treats ANY throw as a transport
    // error and disconnects the stream, which would leave the filter flying
    // blind on real-time progress even though the network connection is
    // perfectly healthy.
    const invoke = <T>(handler: ((data: T) => void) | undefined, data: T, name: string): void => {
      if (!handler) return;
      try {
        handler(data);
      } catch (err) {
        this.log(`SSE: handler for "${name}" threw (continuing):`, err);
      }
    };

    switch (eventName) {
      case 'connected':
        invoke(this.opts.onConnected, parsed as SSEConnectedData, eventName);
        break;
      case 'progress':
        invoke(this.opts.onProgress, parsed as SSEProgressData, eventName);
        break;
      case 'complete':
        invoke(this.opts.onComplete, parsed as SSECompleteData, eventName);
        break;
      case 'error':
        invoke(this.opts.onServerError, parsed as SSEErrorData, eventName);
        break;
      default:
        this.log('SSE: unknown event:', eventName);
    }
  }

  private log(...args: unknown[]): void {
    if (this.opts.debug) console.log('[SafePlay SSE]', ...args);
  }
}
