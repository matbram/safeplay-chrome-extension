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

// Biases toward ~5s overshoot on median so the countdown rarely hits 0
// before completion. Constants are chosen from early production runs
// showing ~5s undershoot with the previous formula; this shifts by +10s.
// Floor of 25s keeps short videos from displaying a near-instant ETA
// that the overhead can't actually meet.
export function computeEstimate(durationSeconds: number | undefined): number | null {
  if (!durationSeconds || durationSeconds <= 0) return null;
  return Math.max(25, Math.round(20 + durationSeconds / 13));
}

// User-facing status text. Kept deliberately generic — we don't reveal
// download/transcription internals to the user. The popup reads this
// verbatim; the button renderer derives its own compact form.
function statusPrefix(phase: TranscriptionPhase): string {
  switch (phase) {
    case 'connecting':
      return 'Getting ready';
    case 'preparing':
      return 'Processing video';
    case 'transcribing':
      return 'Processing video';
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

  private lastEmittedPhase: TranscriptionPhase | null = null;
  private lastEmittedRemaining: number | null | undefined = undefined;
  private lastEmittedText: string | null = null;

  private emit(errorCode?: string, errorMessage?: string): void {
    const prefix = statusPrefix(this.phase);
    let text: string;
    if (this.phase === 'error') {
      text = errorMessage || 'Error';
    } else if (this.phase === 'done') {
      text = 'Done!';
    } else if (this.phase === 'almost-done' || this.remaining === null) {
      text = `${prefix}...`;
    } else {
      text = `${prefix} — ETA ${this.remaining}s`;
    }

    // Dedup: the same server status arriving during a stable tick will
    // otherwise fire back-to-back identical emits and clutter the console.
    if (
      this.phase === this.lastEmittedPhase &&
      this.remaining === this.lastEmittedRemaining &&
      text === this.lastEmittedText
    ) {
      return;
    }
    this.lastEmittedPhase = this.phase;
    this.lastEmittedRemaining = this.remaining;
    this.lastEmittedText = text;

    this.listener({
      phase: this.phase,
      remainingSeconds: this.remaining,
      statusText: text,
      totalEstimatedSeconds: this.totalEstimate,
      errorCode,
    });
  }
}
