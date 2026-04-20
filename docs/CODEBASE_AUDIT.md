# SafePlay Chrome Extension — Codebase Audit

_Audit date: 2026-04-20. Branch: `claude/codebase-audit-documentation-bX5yf`._

This document is a line-by-line inventory of every system in the extension, plus
a gap analysis focused on root causes rather than symptoms. Where I found
issues, I flag them inline with `[GAP]`, `[BUG]`, or `[RISK]` and collect them
into a ranked list at the bottom.

Special emphasis on **authentication/session handling**, which is also where
the most user-visible regressions live (see §3).

---

## 1. System Inventory

### 1.1 Build & configuration
- `package.json` — webpack build, TS, eslint. Scripts: `dev`, `build`, `clean`,
  `lint`, `typecheck`. No test harness.
- `tsconfig.json` — strict mode on (`strict`, `noImplicitAny`, `strictNullChecks`,
  `noUnusedLocals`, `noUnusedParameters`). `rootDir: src`, `outDir: dist`.
- `webpack.config.js` — 4 entry points (`background`, `content`, `popup`,
  `options`). Copies `public/manifest.json` + icons. `MiniCssExtractPlugin` for
  popup/options/content CSS. `HtmlWebpackPlugin` for popup + options.
- `.eslintrc.json` — standard TS-eslint preset. `no-console: off`.
- `public/manifest.json` — MV3, permissions `storage`, `tabs`, `activeTab`,
  `alarms`. Host permissions include `trysafeplay.com`, `safeplay.app`,
  `api.safeplay.app`, `youtube.com`, and three localhost ports.
  `externally_connectable` matches trysafeplay.com, safeplay.app, and
  `localhost:3000`. Content script runs at `document_idle` on
  `https://(www\.)?youtube.com/*`.

### 1.2 Background service worker (`src/background/index.ts`, 922 LOC)
Responsibilities:
- Message router for `chrome.runtime.onMessage` (17 message types).
- External message listener (`chrome.runtime.onMessageExternal`) for
  `AUTH_TOKEN`, `CREDIT_UPDATE`, `LOGOUT` from the website.
- Badge management: reads credit info on SW wake-up, listens for
  `chrome.storage.onChanged` to re-render, and registers a
  `chrome.alarms`-backed 2-minute credit refresh.
- Optimistic credit deduction (`deductCreditsOptimistic`) with an in-memory
  `pendingJobCosts` map keyed by `job_id`.
- Dispatches preferences-updated and auth-state-changed broadcasts to all
  YouTube tabs.

### 1.3 API client (`src/api/client.ts`, 409 LOC)
- `request<T>()` wrapper with bearer-token auth, 401-retry, and uniform
  `ApiError` throws.
- Endpoints: `/api/filter/preview`, `/api/filter/start`,
  `/api/filter/status/:id`, `/api/filter/events/:id` (SSE, called from
  content), `/api/filter/record-history`, `/api/credits/balance`,
  `/api/user/profile`, `/api/transcript/:id` (deprecated),
  `/api/extension/session` (called from `storage.ts`, not here).
- Legacy helpers `requestFilter`, `getOrRequestTranscript`, `pollForTranscript`,
  `getTranscript` remain exported. Only `requestFilter` is still used
  (background `GET_FILTER` path). The other two are dead.

### 1.4 Storage/auth layer (`src/utils/storage.ts`, 638 LOC)
- 14 storage keys under the `safeplay_` prefix.
- Preferences (default in `src/types/index.ts`).
- Auth: `AUTH_TOKEN`, `REFRESH_TOKEN`, `TOKEN_EXPIRES_AT`, `USER_ID`.
- Profile bundle: `USER_PROFILE` / `USER_SUBSCRIPTION` / `USER_CREDITS` with
  10-minute TTL for profile and 5-minute TTL for credit info.
- Transcript cache: `CACHED_TRANSCRIPTS`, LRU-trimmed to 15 entries, handles
  quota exceptions by flushing + retry.
- Filtered-video history: `FILTERED_VIDEOS`, capped at 500.
- Core auth functions: `getAuthToken` (auto-refreshes), `refreshAuthToken`,
  `setAuthToken`, `clearAuthData`, `isAuthenticated`. Plus
  `isAuthenticatedStrict` and `getAuthTokenRaw` which are **dead exports**.

### 1.5 Content script (`src/content/index.ts`, 1265 LOC)
Class `SafePlayContentScript` owns:
- `ResilientInjector` — injects the watch-page button and per-Short buttons.
- `VideoController` — manages playback filtering via `AudioFilter`.
- `CaptionFilter` — mutation-observes and rewrites YouTube's caption DOM.
- `TimelineMarkers` — overlays profanity markers on the progress bar.
- `CreditConfirmation` dialog + `showAuthRequiredMessage` +
  `showFilterErrorNotification` helpers.
- `TranscriptionSSEClient` — streams real-time job events with a bearer token.
- `TimeEstimator` — honest ETA countdown (computed from video duration).

State: `navigationId` cancellation pattern, `filteringVideoId` to scope
button-state updates, `pendingAuthVideoId` to resume after sign-in,
`autoRetryTimer` for silent recovery after errors, `skipNextConfirmation` to
bypass confirm on auto-retry.

### 1.6 Filter layer (`src/filter/`)
- `audio-filter.ts` — Web Audio `MediaElementAudioSourceNode` + `GainNode` with
  linear ramps. Bleep mode uses two detuned 1 kHz sine oscillators.
- `transcript-parser.ts` — word-level matching via `PROFANITY_MAP` and
  `findEmbeddedProfanity`, merges intervals, applies severity filters.
- `profanity-list.ts` — static word list (not re-read here; unchanged).

### 1.7 Popup (`src/popup/`)
Tabs: status, preferences, account, theme. Starts a 5-second credit poll and
a 2-second active-tab video-state poll. Listens for `VIDEO_STATE_CHANGED`,
`TRANSCRIPTION_STATE_CHANGED`, `PREFERENCES_UPDATED`, `CREDIT_UPDATE`, and
`AUTH_STATE_CHANGED` broadcasts.

### 1.8 Options page (`src/options/`)
Custom blacklist/whitelist, timing knobs (`paddingBeforeMs`, `paddingAfterMs`,
`mergeThresholdMs`), auto-enable toggle, cache-clear button. Uses the same
`GET_PREFERENCES`/`SET_PREFERENCES` messaging.

### 1.9 Types (`src/types/index.ts`)
Single source of truth for wire types. `MessageType` enumerates 15 types. Note
the content script dispatches several types (`VIDEO_STATE_CHANGED`,
`PREFERENCES_UPDATED`, `AUTH_STATE_CHANGED`, `CREDIT_UPDATE`,
`GET_VIDEO_STATE`) that are **not in the `MessageType` union** — see §4.

---

## 2. End-to-End Wire Map

| User action | Entry point | Path through code |
| --- | --- | --- |
| Click extension icon | `chrome.action` | popup loads → `GET_PREFERENCES` → `GET_USER_PROFILE` → `GET_CREDITS` + 5s/2s polls start |
| Click "SafePlay" on watch page | `ResilientInjector.onButtonClick` | `onFilterButtonClick` → `CHECK_AUTH_STRICT` → `GET_PREVIEW` → `CreditConfirmation.show` → `START_FILTER` → SSE (`/api/filter/events/:id`) → `CHECK_JOB` on complete → `applyFilter` → `AudioFilter` + `CaptionFilter` + `TimelineMarkers` |
| YouTube SPA nav | `yt-navigate-finish` | content `onNavigation` → `videoController.stop()` → `captionFilter.stop()` → `stopTranscriptionResources()` → `timelineMarkers.destroy()` → re-evaluate `checkAutoEnable` |
| Website sign-in completes | `chrome.runtime.sendMessage` (external) | BG `onMessageExternal` → `setAuthToken` + bundle storage → broadcast `AUTH_STATE_CHANGED` to all tabs |
| Token near expiry | Any `getAuthToken()` caller | storage `getAuthToken` → `refreshAuthToken` → `GET /api/extension/session` (cookies) → restore tokens |
| API 401 | `request()` | `hasRefreshToken()` check → `refreshAuthToken` → retry once → on failure, `clearAuthData` + broadcast `AUTH_STATE_CHANGED(false)` |
| 2-min alarm | `chrome.alarms` | `refreshCredits()` → `getCreditBalance` (uses `getAuthToken`) → `setCreditInfo` → badge update via `chrome.storage.onChanged` |
| Filter toggle (pill or player control) | button click → `toggleFilterFromButton` | `VideoController.stop/resume` + `CaptionFilter.stop/start` + `TimelineMarkers.hide/show` |

---

## 3. Authentication & Session — Root-Cause Analysis

This is the "why am I being asked to re-authenticate?" section. My conclusion
after tracing every auth path: **the extension does not actually use its own
stored refresh token.** The code paths that *look* like refresh are all
delegating to website session cookies, and those cookies can (and do) disappear
out from under the extension in ways the user never sees.

### 3.1 The claimed model (from `docs/WEBSITE_AUTH_INTEGRATION.md`)
The integration doc promises a classic access-token / refresh-token setup:
- Website sends `{ token, refreshToken, expiresAt, ... }` on sign-in (§6 of the
  doc describes a `/api/auth/refresh` endpoint that accepts a refresh token).
- Extension auto-refreshes when the access token is close to expiry.
- If refresh fails, user is asked to sign in again.

### 3.2 The actual model (what the code does)
`src/utils/storage.ts:56-120` — `refreshAuthToken()` **never sends the stored
refresh token anywhere.** It calls:

```ts
const url = `${API_BASE_URL}/api/extension/session?extensionId=${extensionId}`;
const response = await fetch(url, { method: 'GET', credentials: 'include' });
```

That means "refresh" is really "ask the website whether the user is still
signed in on the site, via cookies, and copy whatever tokens it returns
back into `chrome.storage.local`." There is no code path anywhere in the
extension that POSTs a refresh token.

`/api/auth/refresh` described in the integration doc is never called.

### 3.3 Why users see re-auth prompts after "some time has passed"
Every one of the following causes a prompt that shouldn't need one:

1. **Website session cookie expired.** If trysafeplay.com's session cookie
   lifetime is shorter than the user's idle time (typical Supabase SSR
   cookies default to ~7d but can be shorter), the next `/api/extension/session`
   returns `authenticated: false`. The extension then clears its access
   token (`storage.ts:96-101`) even though the locally stored refresh token
   is still valid.
2. **Third-party cookies blocked / ITP.** The extension's fetch to
   trysafeplay.com is cross-site relative to the current tab. In Chrome's
   3rd-party-cookie phase-out and in Safari-like profiles, `credentials:
   'include'` won't send the website cookie → every refresh returns
   `authenticated: false`. The user is forced to sign in again on *every*
   token expiry (~1h).
3. **User signed out on another device / browser profile.** Supabase
   invalidates the refresh token globally, but the extension doesn't hear
   about it until the next 401. At that point `hasRefreshToken()` gates the
   retry, but since the refresh mechanism is cookie-based and the website
   also lost its session, the fallback kicks in and wipes auth data.
4. **A single transient 401 nukes everything.** `src/api/client.ts:101-124` —
   on 401 + failed refresh, we call `clearAuthData()`, which deletes the
   refresh token *and* profile/subscription/credits. One bad 401 (network
   blip while website session is briefly unauthenticated, or a Supabase
   rolling-deploy hiccup) permanently logs the user out.
5. **Expiry-unit confusion in the refresh path.** `storage.ts:105`:
   ```ts
   const expiresAtSeconds = Math.floor(data.expiresAt / 1000);
   ```
   This divides unconditionally, assuming `/api/extension/session` returns
   `expiresAt` in **milliseconds**. If the endpoint returns it in **seconds**
   (which is what Supabase natively uses for `session.expires_at` — see the
   same integration doc, §Message Format: `expiresAt: session.expires_at //
   (seconds)`), we end up storing a 1970-ish timestamp. On every next call
   `getAuthToken()` sees a wildly-expired token and triggers another refresh,
   which returns the same bad value — the user is in a hot refresh loop until
   something finally returns a 401 and clears auth data. `setAuthToken()`
   auto-detects the unit (`storage.ts:232-243`); `refreshAuthToken()` does
   not. The two paths must agree.
6. **Concurrent refresh races.** No singleflight. A popup open fires
   `GET_USER_PROFILE` + `GET_CREDITS` in parallel; the content script's
   `CHECK_AUTH_STRICT` + `GET_PREVIEW` happen on button click; the 2-min
   alarm runs independently. All of these can hit
   `getAuthToken()` while the token is in the 5-minute expiry window. Each
   spawns its own `refreshAuthToken()` fetch. If the website uses refresh
   token rotation, only one request wins; the rest end up storing stale
   state, or one of them gets a 401 during the race and calls
   `clearAuthData()`.
7. **Alarm amplifies the refresh burst.** The 2-minute `CREDIT_REFRESH_ALARM`
   (background `/index.ts:141-156`) calls `refreshCredits()` →
   `getAuthToken()`. During the last 5 minutes of the access token's life,
   every alarm tick triggers a refresh attempt. If any one of them fails,
   §3.3.4 applies.

### 3.4 Dead code that was supposed to help
- `isAuthenticatedStrict` and `getAuthTokenRaw` (`storage.ts:201, 442`) are
  exported but not imported anywhere in the repo. They were designed to
  allow an auth check without triggering refresh. Because they're unused,
  every auth check goes through the refresh-happy `getAuthToken()`, which
  is a contributor to §3.3.6–§3.3.7.
- `hasRefreshToken()` (`storage.ts:207`) gates the 401 retry in
  `api/client.ts:86-99`, but the "refresh" doesn't use that token — it
  uses cookies. The gate is checking the wrong thing. A user could have a
  perfectly valid locally-stored refresh token and still be told "we can't
  refresh" because the website session cookie is gone.

### 3.5 Root-cause summary
The refresh mechanism is **cookie-dependent masquerading as token-based**.
The access-token lifetime (≈1h) sets an upper bound on how long a user can
be inactive before they're forced back through a full OAuth flow, because
the thing that actually keeps them signed in is the website's session
cookie — not the refresh token the extension is carefully storing and
ignoring. Everything described in §3.3 is a symptom of that one design
mismatch.

**Proposed fix direction** (not implemented — these are the knobs to turn):
1. Wire `refreshAuthToken()` to actually `POST /api/auth/refresh` with the
   stored refresh token body. Fall back to `/api/extension/session` only
   if no local refresh token is present.
2. Normalize `expiresAt` unit handling in *both* `setAuthToken` and
   `refreshAuthToken` via a single helper.
3. Add a singleflight/mutex around `refreshAuthToken` so parallel callers
   share one in-flight request.
4. Soften the 401 handler: only `clearAuthData()` after N consecutive
   refresh failures or an explicit "refresh token revoked" response code.
   A single 401 should not log the user out.
5. Remove `isAuthenticatedStrict`/`getAuthTokenRaw` or wire them in where
   "I just want to know if we're logged in without triggering a refresh
   storm" is the correct semantics (e.g. the silent `checkAutoEnable`
   path in `content/index.ts:1232-1243` — it currently uses
   `CHECK_AUTH_STRICT` which the BG translates into a refreshing check).

### 3.6 Self-challenge
Is there a kinder reading where this is intentional? Sort of. A "website
session = source of truth" design is defensible: it guarantees that
signing out on the site signs out the extension. **But** the current code
pretends to do token-based refresh — it carefully stores the refresh
token, logs its length, checks its presence — and then never uses it for
refresh. Either commit to "cookies are the source of truth" (drop the
refresh-token storage entirely, and design for the case where cookies
aren't available), or actually implement refresh-token refresh. The
hybrid is what's biting users.

---

## 4. Critical Issues (not already covered in §3)

### [BUG] Audio routing breaks on second video in the same SPA session
`src/filter/audio-filter.ts:72-104` — `initializeAudioContext()` returns early
when `this.audioContext` already exists. But `SafePlayContentScript` keeps a
single `VideoController` instance and reuses it across YouTube SPA navigations
(`content/index.ts:97-104`, constructor runs once). On the second filter
operation in the same tab:
- `audioFilter.initialize()` sets `this.video` to the *new* `<video>` element.
- The guard skips re-creating the source node, so the existing
  `MediaElementAudioSourceNode` is still bound to the *first* (now-detached)
  `<video>` element.
- Result: audio on the new video is not routed through the gain node, so
  profanity is not muted (or bleeps play over silence).

Either `destroy()` + re-`initialize` the AudioContext per navigation, or
tear down and recreate the graph when `this.video` changes.

### [BUG] `VideoController.applyFilter` double-fetches the transcript
`content/index.ts:907-910` calls
`videoController.onTranscriptReceived(transcript)` (which sets the transcript
and runs `processTranscript`) and then `videoController.applyFilter()`.
`applyFilter` (`video-controller.ts:82-132`) unconditionally sends a
`GET_FILTER` message to the background, overwriting the just-provided
transcript. For cached videos this is a wasted round-trip; for uncached ones
it's potentially kicking off a second job. The first call is effectively
dead — either remove `onTranscriptReceived` from the hot path, or remove the
internal `GET_FILTER` in `applyFilter()`.

### [BUG] `recordCachedHistory` can fire twice for one filter action
Both `handleStartFilter` (`background/index.ts:329-335`) and `handleGetFilter`
(`background/index.ts:414-418`) call `recordCachedHistory` for the cached
path. The content script uses `START_FILTER` for new flows but
`VideoController.applyFilter` internally calls `GET_FILTER` — so both paths
run for any cached video, yielding two history rows.

### [BUG] `/api/extension/session` `expiresAt` unit is assumed
Covered in §3.3.5. Calling this out again at the top level because its
consequence ("auto-detected infinite refresh loop") is particularly nasty
if the endpoint ever returns seconds.

### [BUG] Auth-state broadcast goes to *every* tab
`background/index.ts:743-752` and `api/client.ts:105-117` broadcast
`AUTH_STATE_CHANGED` via `chrome.tabs.query({})` (no URL filter). Content
scripts only run on YouTube, so the broadcasts are safe, but the
`chrome.tabs.sendMessage` spam to hundreds of non-YouTube tabs can trigger
"Receiving end does not exist" errors for each one. They're caught, but it
adds noise and allocates per-tab message ports. Query `{ url:
'*://*.youtube.com/*' }` instead.

### [BUG] Alarm reset at every SW wake-up
`background/index.ts:144-146` calls `chrome.alarms.create` at module top
level. Every SW wake-up resets the alarm timer. If wake-ups happen more
often than the 2-minute period (e.g., frequent popup opens while user is
active on YouTube), the alarm **never fires**. Move creation into
`chrome.runtime.onInstalled` / `onStartup`, or guard with `alarms.get`.

---

## 5. Medium-priority Issues

### [GAP] `MessageType` union is out of date
`src/types/index.ts:222-237` lists 15 types. The runtime actually uses:
- Missing from the union but dispatched in code: `VIDEO_STATE_CHANGED`
  (content → BG/popup), `PREFERENCES_UPDATED` (BG → tabs), `AUTH_STATE_CHANGED`
  (BG → tabs), `CREDIT_UPDATE` (external → BG → tabs), `GET_VIDEO_STATE`
  (popup → content), and `AUTH_TOKEN` + `LOGOUT` via external messaging.
- Types in the union but routed through `handleMessage`: `TRANSCRIPTION_STATE_CHANGED`
  and `GET_TRANSCRIPTION_STATE` only ever travel between popup ↔ content, not
  through the BG router. Inclusion in the BG router's `switch` is currently
  missing (it falls through to "Unknown message type"). Either handle them in
  BG, or split the union into "to-BG" vs. "BG-broadcast" vs. "to-content" sets.

### [GAP] Dead / legacy code not deleted
- `api/client.ts`: `getOrRequestTranscript`, `pollForTranscript`,
  `getTranscript` — exported but unreferenced. Delete or fold into the
  active path so there's one way to fetch a transcript.
- `api/client.ts:340-369`: `requestFilter` is a thin wrapper around
  `startFilter`. Drop, and have `handleGetFilter` call `startFilter` directly.
- `storage.ts`: `isAuthenticatedStrict`, `getAuthTokenRaw` — unused (see §3.4).
- `storage.ts:316-335`: `updateCreditsAfterFilter` is exported but not called;
  the BG uses its own `deductCreditsOptimistic`. Consolidate.

### [GAP] `checkAutoEnable` silently triggers full filter flow
`content/index.ts:1227-1252` — on navigation to a previously-filtered video,
calls `onFilterButtonClick(videoId)`. That method's step 0 runs
`CHECK_AUTH_STRICT`, and on failure pops the sign-in modal. The early
"silent skip" guard in `checkAutoEnable` protects from this *most* of the
time, but there's a TOCTOU: auth can flip between the guard and the button
click (especially near expiry). A "please sign in" modal appears on page
load with no user interaction, confusing the user.

Fix: pass a "silent" flag into `onFilterButtonClick` (or extract a non-UI
entry point that bails silently) so auto-enable never shows modals.

### [GAP] No singleflight / mutex on `refreshAuthToken`
See §3.3.6. Even if the refresh mechanism itself is fixed, parallel callers
will still hit the endpoint multiple times under today's code.

### [GAP] External message sender trust
`background/index.ts:795-919` checks `sender.origin` against a hard-coded
list (`trysafeplay.com`, `safeplay.app`, `localhost:3000`). Three observations:
1. `externally_connectable` in the manifest already restricts this at the
   browser level, so this is belt-and-suspenders — fine.
2. But the BG then *trusts the entire payload* (token, refreshToken,
   user profile, subscription info, credits). If the website is XSS'd, any
   value the attacker wants lands in `chrome.storage.local`. Consider at
   least validating shapes (e.g. token is a JWT-shaped string) before
   storing.
3. The dynamic `import('../utils/storage')` on line 820 is functionally
   correct but means an edge failure (e.g., SW recycling mid-flow) silently
   drops the auth write. Prefer a top-of-file static import.

### [GAP] `preferences.enabled` is checked inconsistently
`VideoController.applyFilter` honors `preferences.enabled` (`video-controller.ts:88-91`).
But the content-script `onFilterButtonClick` doesn't — clicking the button
starts a filter flow even when preferences are disabled, and you only find
out "disabled" state once applyFilter runs (after the transcript is already
fetched + credits deducted). Gate earlier, or hide the button entirely when
disabled.

### [GAP] `handleSetPreferences` doesn't broadcast to the popup
`background/index.ts:598-609` only `chrome.tabs.sendMessage`s to YouTube
tabs. The options page (running in an extension tab, not a YouTube tab)
doesn't receive updates made elsewhere until it reloads. `chrome.runtime.sendMessage`
(no tabId) would reach popup + options.

### [GAP] `pendingJobCosts` map lives in SW memory only
`background/index.ts:50` — if the SW is evicted between `handleStartFilter`
and the matching `handleCheckJob`, the optimistic deduction is lost. The
next `refreshCredits` corrects it, so this is a minor UX gap (brief wrong
badge). Persist to `chrome.storage.session` (or `local`) for stronger
guarantees.

### [GAP] Fallback poller budget counts from SSE close, not job start
`content/index.ts:671-747` — if SSE succeeds for 5 minutes then drops,
the fallback poller gets a *fresh* 6-min budget (or scaled), effectively
doubling the tolerated job time. Not necessarily wrong (long videos may
legitimately need more), but worth documenting. Counter-argument: if
the user's connection is flaky, they pay tokens on a job they'll likely
abandon.

---

## 6. Low-priority Observations

### [RISK] Verbose auth logging leaks token metadata
`storage.ts` logs access-token / refresh-token length and prefixes on every
refresh. `background/index.ts:807-818` logs the same on every external
`AUTH_TOKEN` message. Acceptable in dev, but this ships in production bundles
too. Gate behind a `DEBUG` flag or strip in production builds.

### [RISK] `chrome.tabs.query({})` fan-out
Several places (BG logout, BG auth broadcast, BG credit update, API 401)
query every tab. On a user with dozens of tabs, this generates dozens of
`chrome.tabs.sendMessage` attempts, most of which throw "Receiving end does
not exist" and are swallowed. Restrict to YouTube tabs.

### [OBSERVATION] Two `API_BASE_URL` constants
`src/api/client.ts:12` and `src/utils/storage.ts:30` both hardcode
`https://trysafeplay.com`. Manifest permits `safeplay.app` and localhost too.
Centralize into a shared config (`src/utils/api-config.ts`) and switch on
build env.

### [OBSERVATION] `CaptionFilter` retries `setupCaptionObserver` forever
`content/caption-filter.ts:145-151` — if the caption container never appears
(e.g., captions disabled), we keep polling every 500ms while the filter is
"active". Bounded retry + log-and-stop would be cleaner.

### [OBSERVATION] `TimelineMarkers` retry loop
`content/timeline-markers.ts:52-72` — 20 retries × 500ms = up to 10 seconds of
silent retry. If the progress bar never appears (e.g., audio-only embed),
we silently give up. Currently fine, but surface an error state so callers
know markers aren't coming.

### [OBSERVATION] `CaptionFilter.initialize` receives `muteIntervals` it never reads
`content/caption-filter.ts:72-75` — the arg is discarded. The class filters
purely by word-list, not by the time-aligned `MuteInterval[]` passed from
the controller. Either drop the unused parameter or actually gate caption
censoring to mute-interval times (it currently censors the entire caption
regardless of video time).

### [OBSERVATION] `BADGE` clears silently on logout
`background/index.ts:741` calls `clearBadge()` on logout, which also happens
if a single 401 trips the clear-auth path (§3.3.4). For the user, the badge
disappearing is the first visible sign they've been logged out.

### [OBSERVATION] Popup credit poll runs forever while open
`src/popup/index.ts:103-115` — 5s credit + 2s video-state polls. Each credit
poll goes through `getAuthToken()` → can trigger a refresh. Popups are
short-lived (close on blur), so impact is small, but worth aligning with
the alarm so we don't double-poll during the expiry window.

### [OBSERVATION] `autoEnableForFilteredVideos` default is `true` + cached blacklist is 500 entries
First-time visitors to a previously-filtered video will auto-trigger a
filter on page load — user sees the video pause/resume without having
clicked SafePlay. This is an intended feature per `DEFAULT_PREFERENCES`
(`src/types/index.ts:204`), but the onboarding should explain it or the
default should be off. Not a bug; UX consideration.

### [OBSERVATION] `onVideoStateChange` broadcasts to the runtime, not tabs
`content/index.ts:1072-1087` sends `VIDEO_STATE_CHANGED` via
`chrome.runtime.sendMessage`. Popup picks this up. BG's message handler
doesn't have a case for `VIDEO_STATE_CHANGED`, so it falls through to
"Unknown message type" and logs an error on every state change. Either add
a no-op case or only send when the popup is known open.

### [OBSERVATION] `chrome.storage.local` quota risk
Transcripts are capped to 15, filtered videos to 500. Profile/subscription/
credits are single entries. No global size accounting. For very long videos
with dense transcripts, a single entry can approach the per-key size limit;
the code catches "quota exceeded" and flushes (`storage.ts:404-413`), but
only for transcripts — a bloated profile (unlikely but possible) would
silently fail.

---

## 7. Ranked Fix List (if you want a short to-do)

| Rank | Issue | Where | Effort |
| --- | --- | --- | --- |
| 1 | Implement real refresh-token refresh (or commit fully to cookies) | `storage.ts:56-120` | Medium |
| 2 | Normalize `expiresAt` unit in both `setAuthToken` and `refreshAuthToken` | `storage.ts:105, 232-243` | Small |
| 3 | Add singleflight around `refreshAuthToken` | `storage.ts` | Small |
| 4 | Soften 401 auth-wipe (don't clear on a single failure) | `api/client.ts:101-124` | Small |
| 5 | Fix AudioContext reuse across SPA navigations | `filter/audio-filter.ts:72-104` | Small |
| 6 | Stop double-fetching the transcript in `VideoController.applyFilter` | `content/video-controller.ts:82-132` | Small |
| 7 | Dedup `recordCachedHistory` call path | `background/index.ts:329-335, 414-418` | Tiny |
| 8 | Restrict tab broadcasts to YouTube tabs | `background/index.ts`, `api/client.ts` | Tiny |
| 9 | Move alarm creation into `onInstalled`/`onStartup` | `background/index.ts:144-146` | Tiny |
| 10 | Remove or wire dead auth helpers (`isAuthenticatedStrict`, `getAuthTokenRaw`) | `storage.ts` | Tiny |
| 11 | Make `checkAutoEnable` path silent end-to-end | `content/index.ts:1227-1252` | Small |
| 12 | Add BG handling for `VIDEO_STATE_CHANGED` or stop logging it as unknown | `background/index.ts:168-225` | Tiny |
| 13 | Update `MessageType` union to match actual usage | `types/index.ts:222-237` | Tiny |
| 14 | Persist `pendingJobCosts` to storage.session | `background/index.ts:50` | Small |
| 15 | `CaptionFilter` unused `muteIntervals` arg | `content/caption-filter.ts` | Tiny |

---

## 8. Meta: things I couldn't verify from the client side
These depend on server behavior and would need to be confirmed against the
website code:
- Does `/api/extension/session` return `expiresAt` in seconds or milliseconds?
  (§3.3.5 is a bug either way until the client auto-detects.)
- Does the website invalidate / rotate refresh tokens on every refresh?
  Supabase defaults to yes — which amplifies §3.3.6.
- Is `/api/auth/refresh` (the one in the integration doc) actually deployed?
  If so, the extension can stop relying on cookies and use it directly.
- What is the session cookie lifetime on `trysafeplay.com`? If it's less than
  the user's typical idle period, §3.3.1 is the dominant re-auth cause.
- Do content scripts run on YouTube embeds (`youtube-nocookie.com`,
  `youtube.com/embed/...`)? The manifest doesn't match them; confirm that's
  intentional.

