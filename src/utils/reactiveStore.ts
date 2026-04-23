// reactiveStore: single abstraction over chrome.storage used by every surface
// (background, popup, options, content). Replaces the ad-hoc mix of bespoke
// broadcast messages (PREFERENCES_UPDATED, AUTH_STATE_CHANGED, CREDIT_UPDATE)
// and polling loops with one contract:
//
//   - Any context can `get(key)` or `subscribe(key, cb)`.
//   - Only the background context may `commit(key, next)` directly. Other
//     contexts send a `propose` through a STORE_PROPOSE message; the
//     background merges and commits under a per-key chained-Promise mutex.
//   - Every context observes changes via chrome.storage.onChanged — no more
//     chrome.tabs.sendMessage broadcasts for state updates.
//
// `authState` is a derived key: changes to any of USER_PROFILE, USER_SUBSCRIPTION,
// USER_CREDITS, or AUTH_TOKEN recompute it and fire subscribers only if the
// recomputed object differs by deep equality.

import {
  AuthState,
  CreditInfo,
  EMPTY_INFLIGHT_STATE,
  EMPTY_SESSION_STATE,
  InflightState,
  SessionState,
  UserCredits,
  UserPreferences,
  UserProfile,
  UserSubscription,
  DEFAULT_PREFERENCES,
} from '../types';
import { STORAGE_KEYS } from './storage';

// ---------------------------------------------------------------------------
// Public key namespace — maps logical keys to storage-level layout.
// ---------------------------------------------------------------------------

export type StoreSchema = {
  preferences: UserPreferences;
  authState: AuthState;
  creditInfo: CreditInfo | null;
  sessionState: SessionState;
  inflight: InflightState;
};

export type StoreKey = keyof StoreSchema;

type Listener<K extends StoreKey> = (
  next: StoreSchema[K],
  prev: StoreSchema[K] | undefined,
) => void;

// Each key maps to its storage area + raw backing keys. `authState` is
// synthesized from four different backing keys.
const AREA: Record<StoreKey, chrome.storage.StorageArea> = {
  preferences: chrome.storage.local,
  authState: chrome.storage.local,
  creditInfo: chrome.storage.local,
  sessionState: chrome.storage.local,
  inflight: chrome.storage.session,
};

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

export async function get<K extends StoreKey>(key: K): Promise<StoreSchema[K]> {
  switch (key) {
    case 'preferences': {
      const res = await chrome.storage.local.get(STORAGE_KEYS.PREFERENCES);
      return (res[STORAGE_KEYS.PREFERENCES] || DEFAULT_PREFERENCES) as StoreSchema[K];
    }
    case 'creditInfo': {
      const res = await chrome.storage.local.get(STORAGE_KEYS.CREDIT_INFO);
      return (res[STORAGE_KEYS.CREDIT_INFO] ?? null) as StoreSchema[K];
    }
    case 'sessionState': {
      const res = await chrome.storage.local.get(STORAGE_KEYS.SESSION_STATE);
      return (res[STORAGE_KEYS.SESSION_STATE] || EMPTY_SESSION_STATE) as StoreSchema[K];
    }
    case 'inflight': {
      const res = await chrome.storage.session.get(STORAGE_KEYS.INFLIGHT);
      return (res[STORAGE_KEYS.INFLIGHT] || EMPTY_INFLIGHT_STATE) as StoreSchema[K];
    }
    case 'authState': {
      const res = await chrome.storage.local.get([
        STORAGE_KEYS.AUTH_TOKEN,
        STORAGE_KEYS.USER_PROFILE,
        STORAGE_KEYS.USER_SUBSCRIPTION,
        STORAGE_KEYS.USER_CREDITS,
      ]);
      const token = (res[STORAGE_KEYS.AUTH_TOKEN] ?? null) as string | null;
      const profile = (res[STORAGE_KEYS.USER_PROFILE] ?? null) as UserProfile | null;
      const subscription = (res[STORAGE_KEYS.USER_SUBSCRIPTION] ?? null) as UserSubscription | null;
      const credits = (res[STORAGE_KEYS.USER_CREDITS] ?? null) as UserCredits | null;
      const state: AuthState = {
        isAuthenticated: token !== null,
        user: profile,
        subscription,
        credits,
        token,
      };
      return state as StoreSchema[K];
    }
  }
  throw new Error(`reactiveStore.get: unknown key ${String(key)}`);
}

// ---------------------------------------------------------------------------
// subscribe()
//
// Registers a listener that fires on every chrome.storage.onChanged affecting
// the backing key(s). Calls the listener once synchronously-ish with the
// current value so consumers don't need a separate get(). Returns an
// unsubscribe function.
// ---------------------------------------------------------------------------

export function subscribe<K extends StoreKey>(key: K, listener: Listener<K>): () => void {
  // Which raw backing keys does this logical key depend on?
  const backingKeys: string[] =
    key === 'authState'
      ? [
          STORAGE_KEYS.AUTH_TOKEN,
          STORAGE_KEYS.USER_PROFILE,
          STORAGE_KEYS.USER_SUBSCRIPTION,
          STORAGE_KEYS.USER_CREDITS,
        ]
      : key === 'preferences'
      ? [STORAGE_KEYS.PREFERENCES]
      : key === 'creditInfo'
      ? [STORAGE_KEYS.CREDIT_INFO]
      : key === 'sessionState'
      ? [STORAGE_KEYS.SESSION_STATE]
      : key === 'inflight'
      ? [STORAGE_KEYS.INFLIGHT]
      : [];

  const area = AREA[key];
  let last: StoreSchema[K] | undefined = undefined;

  const fire = (next: StoreSchema[K]) => {
    if (!deepEqual(next, last)) {
      const prev = last;
      last = next;
      try {
        listener(next, prev);
      } catch (err) {
        console.error('[reactiveStore] listener threw for key', key, err);
      }
    }
  };

  // Initial fetch + fire.
  get(key).then(fire);

  const handler = (
    changes: { [k: string]: chrome.storage.StorageChange },
    changedArea: chrome.storage.AreaName,
  ) => {
    const areaName: chrome.storage.AreaName =
      area === chrome.storage.session ? 'session' : 'local';
    if (changedArea !== areaName) return;
    const touched = backingKeys.some(bk => bk in changes);
    if (!touched) return;
    // For single-key logical keys we could use the change record directly,
    // but for `authState` we need to recompute from all four backing keys.
    // A tiny re-get is fine — the onChanged already serializes us to the
    // post-write state, and the storage cache is hot.
    get(key).then(fire);
  };

  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

// ---------------------------------------------------------------------------
// propose() — non-background writer API.
//
// Sends STORE_PROPOSE to the background. The background merges the patch
// with the current value under a per-key Promise chain mutex and commits.
// Non-background callers MUST NOT write directly to chrome.storage for
// reactive keys; doing so bypasses the merge and opens us back up to the
// read-modify-write races the abstraction exists to eliminate.
// ---------------------------------------------------------------------------

export async function propose<K extends 'preferences' | 'sessionState' | 'inflight'>(
  key: K,
  patch: Partial<StoreSchema[K]> | object,
): Promise<void> {
  await chrome.runtime.sendMessage({
    type: 'STORE_PROPOSE',
    payload: { key, patch },
  });
}

// Content-script-only helper: propose a patch to the caller's own TabSnapshot.
// Background uses sender.tab.id to resolve which byTab[] slot gets the merge,
// so the content script doesn't need to know its own tab ID.
export async function proposeSelfTab(
  patch: Partial<import('../types').TabSnapshot>,
): Promise<void> {
  await chrome.runtime.sendMessage({
    type: 'STORE_PROPOSE',
    payload: { key: 'sessionState', patch: { selfTab: patch } },
  });
}

// ---------------------------------------------------------------------------
// commit() + per-key mutex — background-only.
//
// Writes are serialized per top-level key using a chained-Promise mutex.
// Crucially, commit does storage-read → merge → storage-write so that if
// the service worker is torn down between writes from separate incarnations,
// the second one still sees the first's committed state.
// ---------------------------------------------------------------------------

const commitQueues = new Map<StoreKey, Promise<void>>();

export async function commit<K extends 'preferences' | 'sessionState' | 'inflight' | 'creditInfo'>(
  key: K,
  updater: (prev: StoreSchema[K]) => StoreSchema[K] | Promise<StoreSchema[K]>,
): Promise<StoreSchema[K]> {
  const prevChain = commitQueues.get(key) ?? Promise.resolve();
  let resolveNext: () => void;
  const nextChain = new Promise<void>(res => { resolveNext = res; });
  commitQueues.set(key, prevChain.then(() => nextChain));

  let result!: StoreSchema[K];
  try {
    await prevChain;
    const current = await get(key);
    const next = await updater(current);
    await writeRaw(key, next);
    result = next;
  } finally {
    resolveNext!();
    // Release the queue slot if we're at the end.
    if (commitQueues.get(key) === nextChain) {
      // Leave the entry in place; consecutive commits chain correctly either
      // way. Clearing only once empty avoids a race where a new commit starts
      // as we delete.
    }
  }
  return result;
}

async function writeRaw<K extends StoreKey>(key: K, next: StoreSchema[K]): Promise<void> {
  switch (key) {
    case 'preferences':
      await chrome.storage.local.set({ [STORAGE_KEYS.PREFERENCES]: next });
      return;
    case 'creditInfo':
      await chrome.storage.local.set({
        [STORAGE_KEYS.CREDIT_INFO]: next,
        [STORAGE_KEYS.CREDIT_CACHE_TIME]: Date.now(),
      });
      return;
    case 'sessionState':
      await chrome.storage.local.set({ [STORAGE_KEYS.SESSION_STATE]: next });
      return;
    case 'inflight':
      await chrome.storage.session.set({ [STORAGE_KEYS.INFLIGHT]: next });
      return;
  }
  throw new Error(`reactiveStore.writeRaw: unsupported key ${String(key)}`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}
