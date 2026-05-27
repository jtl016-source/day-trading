import NodeCache from "node-cache";

// TTL buckets (seconds)
const TTL = {
  candles:    60,      // completed candle rows — stable for 1 min; live bars bypass cache
  days:       120,     // daily summary — changes slowly
  continuous: 5,       // cached-continuous — short TTL so new bars appear within 5s
} as const;

const store = new NodeCache({ checkperiod: 30, useClones: false });

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
