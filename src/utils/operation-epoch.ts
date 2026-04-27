// Cancellation primitive for async user-intent operations in the content script.
//
// Every async operation that ends in a side effect (filtering, charging,
// updating the button, applying a transcript) captures a token at entry.
// Before applying any side effect after an await, the operation re-checks
// the token. If the token is stale, the result is dropped silently.
//
// The token is invalidated by ANY user action that changes the operation's
// premise:
//   - SPA navigation (the user moved to a different video)
//   - Master toggle off (the user no longer wants any filtering)
//   - Auto-filter-all toggled off (the user no longer wants auto-filter)
//   - Auth flipped to signed-out (the user can't filter anymore)
//
// Each call site doesn't need to know which specific events to watch — it
// just calls isOperationStale() before doing anything that costs work or
// changes the screen.
//
// This collapses six previously-independent race-condition bugs into a
// single rule: "no async result mutates state without revalidating its
// epoch." Replaces the half-implemented `navigationId` pattern that lived
// only on three of the eight async paths that needed it.

let currentEpoch = 0;

export interface OperationToken {
  epoch: number;
  videoId: string | null;
}

// Capture the current operation context. Pass the videoId the caller is
// operating on; this is checked separately from the epoch counter so a
// nav A → B → A round trip (which leaves the epoch incremented but
// currentVideoId back to A) is still correctly detected as a different
// operation.
export function captureOperation(videoId: string | null): OperationToken {
  return { epoch: currentEpoch, videoId };
}

// True if anything has happened since the token was captured that should
// invalidate the in-flight operation. `currentVideoId` is the page's
// current video at the call site (typically `this.currentVideoId`).
export function isOperationStale(
  token: OperationToken,
  currentVideoId: string | null,
): boolean {
  return token.epoch !== currentEpoch || token.videoId !== currentVideoId;
}

// Bump the epoch. Every in-flight token captured before this call is now
// stale. Reason is logged for debugging — pick something specific
// ("navigation", "master-off", "auto-filter-all-off", "signed-out").
export function bumpEpoch(reason: string): void {
  currentEpoch++;
  // eslint-disable-next-line no-console
  console.log(`[SafePlay OperationEpoch] bumped to ${currentEpoch} (${reason})`);
}

// Read-only accessor for tests / debug surfaces. Don't make decisions on
// this value — capture a token instead.
export function getCurrentEpoch(): number {
  return currentEpoch;
}
