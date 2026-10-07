import NodeCache from "node-cache";

// TTL buckets (seconds)
const TTL = {
  candles:    60,      // completed candle rows — stable for 1 min; live bars bypass cache
  days:       120,     // daily summary — changes slowly
  continuous: 5,       // cached-continuous — short TTL so new bars appear within 5s
} as const;

// checkperiod 30 → 5 (2026-09-18): cached-continuous now stores SERIALIZED bodies (up to ~9 MB
// each, 5 s TTL); node-cache only frees an expired key on access or on its check tick, so a 30 s
// tick kept six TTLs' worth of dead multi-MB strings resident on a memory-starved machine.
const store = new NodeCache({ checkperiod: 5, useClones: false });

export function cacheGet<T>(key: string): T | undefined {
  return store.get<T>(key);
}

export function cacheSet<T>(key: string, value: T, ttl: number): void {
  store.set(key, value, ttl);
}

/** Invalidate all cache keys for a symbol (call after DB write). */
export function cacheInvalidate(symbol: string): void {
  const keys = store.keys().filter(k => k.startsWith(symbol + ":"));
  if (keys.length) store.del(keys);
}

/** Flush the entire server-side cache (call after a full MW reload). */
export function cacheFlushAll(): void {
  store.flushAll();
}

export { TTL };
