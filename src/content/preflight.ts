// Client-side pre-flight gate for the filter button. Decides whether
// SafePlay can plausibly filter a given YouTube video before we hit our
// own backend, so we don't waste a credit-confirmation dialog on videos
// the upstream transcription provider can never access (private,
// age-restricted, members-only, deleted) or that have no complete file
// to transcribe yet (active live streams).
//
// Defense in depth: server-side validation in /api/filter/preview and
// /api/filter/start remains the source of truth. Pre-flight just catches
// the common failures earlier and gives the user a clearer message.

import { UnfilterableReason } from './credit-confirmation';

export type PreflightResult =
  | { ok: true }
  | { ok: false, reason: UnfilterableReason };

// Same-origin fetch from the YouTube page; no auth required, no credit
// cost, no rate-limit concern at the volume one user generates.
const OEMBED_URL = 'https://www.youtube.com/oembed';

// DOM selectors for "this video is currently live." YouTube uses several
// markers; we match any of them. Replays of ended streams don't match
// these (the live badge is gone once the stream ends), so this
// intentionally only catches active live streams.
const LIVE_BADGE_SELECTORS = [
  '.ytp-live-badge',
  '.badge-style-type-live-now',
  'ytd-badge-supported-renderer .badge-style-type-live-now',
];

function isCurrentlyLive(): boolean {
  for (const sel of LIVE_BADGE_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    // Some live-badge classes are reused for "premiere countdown" or
    // pre-show banners; the visible-live indicator on the player itself
    // (.ytp-live-badge) is the most reliable. Don't trip on a hidden node.
    const style = window.getComputedStyle(el);
    if (style.display !== 'none' && style.visibility !== 'hidden') {
      return true;
    }
  }
  return false;
}

export async function preflightVideoFilterable(videoId: string): Promise<PreflightResult> {
  // Synchronous live check first — no network round trip needed.
  if (isCurrentlyLive()) {
    return { ok: false, reason: 'live' };
  }

  // oEmbed: 200 for public/unlisted, 401/403 for private/age-restricted/
  // members-only, 404 for deleted/non-existent. We don't need to read the
  // body — the status alone tells us what we need.
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const url = `${OEMBED_URL}?url=${encodeURIComponent(watchUrl)}&format=json`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      // Don't send YouTube's session cookies — we want the same view of
      // the video that the upstream transcription provider will see.
      credentials: 'omit',
    });

    if (response.ok) {
      return { ok: true };
    }

    // 401/403/404 → the upstream provider can't access this video either.
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { ok: false, reason: 'unavailable' };
    }

    // 5xx or any other unexpected status: fail open. We'd rather start a
    // job that the server eventually rejects than block a filterable video
    // because YouTube's oEmbed had a bad day.
    return { ok: true };
  } catch {
    // Network error / CORS hiccup — fail open. Server validation catches
    // anything we let through.
    return { ok: true };
  }
}
