// ── In-memory cache with stale-while-revalidate ──────────────────────────────
// Keeps the free-tier FMP budget tiny: a value is served from cache until its TTL,
// then on the next read it returns the STALE value immediately and refreshes in the
// background (so a request never blocks on the network and never crashes the route).
//
// Isolated to the portfolio module — no shared global state.

interface Entry<T> {
  value: T;
  fetchedAt: number;
  refreshing: boolean;
}

const store = new Map<string, Entry<unknown>>();

export interface SwrResult<T> {
  value: T;
  dataStale: boolean; // true if served stale or from a degraded/empty fallback
}

/**
 * Get `key`, populating via `loader`. Within `ttlMs` returns the cached value.
 * After TTL, returns the cached (stale) value immediately and refreshes in the
 * background. If nothing is cached yet, awaits the loader once. On loader failure
 * the previous value is kept (or `fallback` is used) and dataStale is set.
 */
export async function swr<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  fallback: T,
): Promise<SwrResult<T>> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;

  // Cold cache — must load once.
  if (!hit) {
    try {
      const value = await loader();
      store.set(key, { value, fetchedAt: now, refreshing: false });
      return { value, dataStale: false };
    } catch {
      // Degrade gracefully: cache the fallback briefly so we don't hammer a failing API.
      store.set(key, { value: fallback, fetchedAt: now - ttlMs + 30_000, refreshing: false });
      return { value: fallback, dataStale: true };
    }
  }

  const fresh = now - hit.fetchedAt < ttlMs;
  if (fresh) return { value: hit.value, dataStale: false };

  // Stale — kick a background refresh (once) and return the stale value now.
  if (!hit.refreshing) {
    hit.refreshing = true;
    loader()
      .then((value) => store.set(key, { value, fetchedAt: Date.now(), refreshing: false }))
      .catch(() => { hit.refreshing = false; }); // keep stale value on failure
  }
  return { value: hit.value, dataStale: true };
}

/** Direct peek (no refresh) — used by routes that just want whatever we have. */
export function peek<T>(key: string): T | undefined {
  return store.get(key)?.value as T | undefined;
}

export function clearCache(): void {
  store.clear();
}
