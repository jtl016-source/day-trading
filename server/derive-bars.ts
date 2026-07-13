/**
 * Derive 5m / 15m / 60m bars from stored 1-minute bars.
 *
 * ARCHITECTURE (2026-07-13, user-directed): the user consolidated to a single MotiveWave 1m
 * chart. 1m is now the single source of truth; every higher interval is COMPUTED from the 1m
 * bars ("that is the rawest form of data ... so it should be the most accurate"). This replaces
 * the old model where MW backfilled each resolution independently — which left the stored native
 * 5m/15m/60m history MUTUALLY INCONSISTENT in deep history (the separate MW charts didn't share a
 * contract-roll adjustment base). Deriving everything from one 1m base makes all intervals
 * internally consistent by construction.
 *
 * Bucketing (all epoch SECONDS, matching cached_candles):
 *   5m  → floor(t/300)*300   (:00/:05/:10/…)
 *   15m → floor(t/900)*900   (:00/:15/:30/:45)
 *   60m → floor(t/3600)*3600 (:00 top-of-hour — this branch standardized 60m on :00, see LEARNINGS 2026-07-01)
 * Aggregation: O = first 1m open, H = max 1m high, L = min 1m low, C = last 1m close, V = Σ 1m volume.
 *
 * SAFETY — the never-delete-native rule:
 *   A bucket with ZERO 1m bars (a 1m GAP) produces NOTHING and leaves any existing row untouched.
 *   Those native 5m/15m/60m rows sit where the 1m grid has a hole and are REAL data — we keep them.
 *   Derived-row deletion happens ONLY in `deriveForDeletedOneMin`, and only for a bucket that HAD
 *   1m bars which were just reconcile-deleted (phantom prints) and now has none — a native-only
 *   1m-gap bucket is never in that set, so it can never be deleted here.
 */
import { db } from "./db";

// Resolutions derived from 1m + their bucket widths (seconds).
const DERIVED: ReadonlyArray<{ res: string; sec: number }> = [
  { res: "5",  sec: 300 },
  { res: "15", sec: 900 },
  { res: "60", sec: 3600 },
];

// Widest derived bucket. Read windows are expanded to whole hours so every bucket sees ALL its
// 1m constituents even when the caller passes a partial span (a single live 1m completion, or a
// mid-bucket backfill batch that only carries part of a 5m/15m/60m period).
const MAX_BUCKET_SEC = 3600;

interface OneMin { timestamp: number; open: number; high: number; low: number; close: number; volume: number }
interface Bucket { o: number; h: number; l: number; c: number; v: number; firstTs: number; lastTs: number }

// Prepared statements (better-sqlite3, synchronous — far faster than drizzle for a bulk rebuild).
const selRange = db.$client.prepare(
  `SELECT timestamp, open, high, low, close, volume FROM cached_candles
     WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<=? ORDER BY timestamp ASC`,
);
const upsert = db.$client.prepare(
  `INSERT INTO cached_candles (symbol, resolution, timestamp, open, high, low, close, volume)
   VALUES (@symbol,@resolution,@timestamp,@open,@high,@low,@close,@volume)
   ON CONFLICT(symbol, resolution, timestamp) DO UPDATE SET
     open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`,
);
const delDerived = db.$client.prepare(
  `DELETE FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp=?`,
);

export interface DeriveResult { [res: string]: { written: number } }

/**
 * Read the 1m bars overlapping [fromTs, toTs] (expanded to whole hours) and upsert the derived
 * 5m/15m/60m buckets they compose. Buckets with no 1m bars are skipped — any native row there is
 * left intact. Idempotent: re-deriving an unchanged span rewrites identical values. Returns the
 * number of buckets written per resolution.
 */
export function deriveRange(symbol: string, fromTs: number, toTs: number): DeriveResult {
  const sym = symbol.toUpperCase();
  const result: DeriveResult = {};
  for (const { res } of DERIVED) result[res] = { written: 0 };
  if (!(toTs >= fromTs)) return result;

  const readFrom = Math.floor(fromTs / MAX_BUCKET_SEC) * MAX_BUCKET_SEC;
  const readTo = Math.floor(toTs / MAX_BUCKET_SEC) * MAX_BUCKET_SEC + (MAX_BUCKET_SEC - 1);
  const rows = selRange.all(sym, readFrom, readTo) as OneMin[];
  if (rows.length === 0) return result;

  for (const { res, sec } of DERIVED) {
    const buckets = new Map<number, Bucket>();
    for (const r of rows) {
      // Defensive: never let a corrupt 1m row (should not exist — write-guarded on ingest) poison a bucket.
      if (!(r.high >= r.low) || r.open <= 0 || r.close <= 0) continue;
      const bt = Math.floor(r.timestamp / sec) * sec;
      const ex = buckets.get(bt);
      if (!ex) {
        buckets.set(bt, { o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, firstTs: r.timestamp, lastTs: r.timestamp });
      } else {
        if (r.high > ex.h) ex.h = r.high;
        if (r.low  < ex.l) ex.l = r.low;
        if (r.timestamp < ex.firstTs) { ex.firstTs = r.timestamp; ex.o = r.open; }  // rows arrive ASC, so this rarely fires — kept for safety
        if (r.timestamp > ex.lastTs)  { ex.lastTs = r.timestamp;  ex.c = r.close; }
        ex.v += r.volume;
      }
    }
    if (buckets.size === 0) continue;
    const tx = db.$client.transaction((entries: [number, Bucket][]) => {
      for (const [bt, b] of entries) {
        upsert.run({ symbol: sym, resolution: res, timestamp: bt, open: b.o, high: b.h, low: b.l, close: b.c, volume: Math.round(b.v) });
      }
    });
    const entries = [...buckets.entries()];
    tx(entries);
    result[res].written = entries.length;
  }
  return result;
}

/**
 * Re-derive the 5m/15m/60m buckets that contained 1m bars just deleted by a reconcile sweep
 * (`gap-audit.reconcileRange`). For each affected bucket: if 1m bars remain, recompute + upsert
 * (healing the derived row to the reconciled 1m). If the bucket lost ALL its 1m bars, DELETE the
 * derived row — it was itself derived from the now-deleted phantom 1m prints.
 *
 * This can never touch a native-only 1m-gap row: such a bucket never had 1m bars to delete, so it
 * is never in `deletedTsSec`'s bucket set.
 */
export function deriveForDeletedOneMin(symbol: string, deletedTsSec: number[]): { rederived: number; deleted: number } {
  const sym = symbol.toUpperCase();
  let rederived = 0, deleted = 0;
  if (deletedTsSec.length === 0) return { rederived, deleted };

  for (const { res, sec } of DERIVED) {
    const affected = new Set<number>();
    for (const t of deletedTsSec) affected.add(Math.floor(t / sec) * sec);
    for (const bt of affected) {
      const rows = selRange.all(sym, bt, bt + sec - 1) as OneMin[];
      if (rows.length === 0) {
        const changes = delDerived.run(sym, res, bt).changes;
        if (changes > 0) deleted += changes;
        continue;
      }
      let o = rows[0].open, h = rows[0].high, l = rows[0].low, c = rows[rows.length - 1].close, v = 0;
      for (const r of rows) { if (r.high > h) h = r.high; if (r.low < l) l = r.low; v += r.volume; }
      upsert.run({ symbol: sym, resolution: res, timestamp: bt, open: o, high: h, low: l, close: c, volume: Math.round(v) });
      rederived++;
    }
  }
  return { rederived, deleted };
}
