// Honest countdown: an estimate for how long transcription will take,
// computed from the video duration we already have from the preview
// payload. ElevenLabs doesn't give us real percentage progress, so we
// show time remaining instead of an invented percentage.

export type TranscriptionPhase =
  | 'connecting'      // establishing SSE (or waiting for first poll)
  | 'preparing'       // server is fetching the video / queueing
  | 'transcribing'    // ElevenLabs is running
  | 'almost-done'     // countdown hit zero but SSE hasn't said complete yet
  | 'done'            // complete has fired
  | 'error';

export interface TranscriptionStateSnapshot {
  phase: TranscriptionPhase;
  // null when duration was unknown, when phase === 'almost-done', or before start.
  remainingSeconds: number | null;
  statusText: string;
  // Total estimate at start of the job (for computing elapsed fraction if a
  // UI wants to animate a bar without lying about server-side progress).
  totalEstimatedSeconds: number | null;
  // error_code from the server when phase === 'error'
  errorCode?: string;
}

export type EstimatorListener = (state: TranscriptionStateSnapshot) => void;

// Scribe v2 is ~13x real-time for the core transcription step, but our
// pipeline also has yt-dlp download + queue + webhook round-trip before
// and after. Adding a 10s constant covers overhead, floor of 20s keeps
// short clips honest.
export function computeEstimate(durationSeconds: number | undefined): number | null {
  if (!durationSeconds || durationSeconds <= 0) return null;
  return Math.max(20, Math.round(10 + durationSeconds / 13));
}

// Status-text map used when we're showing text only (no countdown). Also
// used as the prefix when a countdown is present.
function statusPrefix(phase: TranscriptionPhase, serverStatus?: string): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting';
    case 'preparing':
      return serverStatus === 'downloading' ? 'Downloading audio' : 'Preparing video';
    case 'transcribing':
      return 'Transcribing';
    case 'almost-done':
      return 'Almost done';
    case 'done':
      return 'Done!';
    case 'error':
      return 'Error';
  }
}

export class TimeEstimator {
  private tickId: ReturnType<typeof setInterval> | null = null;
  private totalEstimate: number | null;
  private remaining: number | null;
  private phase: TranscriptionPhase = 'connecting';
  private serverStatus: string | undefined;
  private closed = false;
  private readonly listener: EstimatorListener;

  constructor(durationSeconds: number | undefined, listener: EstimatorListener) {
    this.listener = listener;
    this.totalEstimate = computeEstimate(durationSeconds);
    this.remaining = this.totalEstimate;
  }

  start(): void {
    if (this.tickId !== null || this.closed) return;
    // Emit initial state immediately.
    this.emit();
    // Tick once per second; only meaningful once phase moves past
    // 'connecting', but running it always keeps UX consistent.
    this.tickId = setInterval(() => this.tick(), 1000);
  }

  // Called on SSE 'connected'/'progress' events. Sets the phase based on
  // the server-reported status.
  setServerStatus(status: string): void {
    if (this.closed) return;
    this.serverStatus = status;
    if (this.phase === 'done' || this.phase === 'error') return;
    if (status === 'pending' || status === 'downloading') {
      this.phase = 'preparing';
    } else if (status === 'transcribing' || status === 'processing') {
      this.phase = 'transcribing';
    }
    this.emit();
  }

  markComplete(): void {
    if (this.closed) return;
    this.phase = 'done';
    this.remaining = 0;
    this.emit();
    this.stopTick();
  }

  markError(errorCode?: string, errorMessage?: string): void {
    if (this.closed) return;
    this.phase = 'error';
    this.remaining = null;
    this.emit(errorCode, errorMessage);
    this.stopTick();
  }

  close(): void {
    this.closed = true;
    this.stopTick();
  }

  // Force the UI into the "almost done" indeterminate state even if the
  // countdown hasn't hit zero yet (e.g. polling fallback doesn't know the
  // server status). Used sparingly.
  forceAlmostDone(): void {
    if (this.closed || this.phase === 'done' || this.phase === 'error') return;
    this.phase = 'almost-done';
    this.remaining = null;
    this.emit();
  }

  private tick(): void {
    if (this.closed) return;
    if (this.phase === 'done' || this.phase === 'error') return;
    if (this.remaining === null) {
      this.emit();
      return;
    }
    this.remaining = Math.max(0, this.remaining - 1);
    if (this.remaining === 0 && this.phase !== 'almost-done') {
      this.phase = 'almost-done';
      this.remaining = null;
    }
    this.emit();
  }

  private stopTick(): void {
    if (this.tickId !== null) {
      clearInterval(this.tickId);
      this.tickId = null;
    }
  }

  private emit(errorCode?: string, errorMessage?: string): void {
    const prefix = statusPrefix(this.phase, this.serverStatus);
    let text: string;
    if (this.phase === 'error') {
      text = errorMessage || 'Error';
    } else if (this.phase === 'done') {
      text = 'Done!';
    } else if (this.phase === 'almost-done' || this.remaining === null) {
      text = `${prefix}...`;
    } else {
      text = `${prefix}... about ${this.remaining}s remaining`;
    }
    this.listener({
      phase: this.phase,
      remainingSeconds: this.remaining,
      statusText: text,
      totalEstimatedSeconds: this.totalEstimate,
      errorCode,
    });
  }
}
