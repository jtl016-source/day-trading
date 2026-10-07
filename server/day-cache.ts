// server/day-cache.ts
// ─────────────────────────────────────────────────────────────────────────────
// CACHED-DAYS PERF (2026-07-30): GET /api/data/cached-days ran a window-function query with
// per-row DATE(datetime(...)) string conversions over EVERY 5/15/60 row for the symbol
// (~700k rows for MES) — 3.2s of SYNCHRONOUS better-sqlite3 work that froze the event loop
// (live ticks, signal GETs, everything) on every page load and every data_updated refetch.
//
// This module replaces it with an in-process per-symbol day-aggregate cache:
//   • COLD BUILD (once per process / per invalidation): integer-day GROUP BY (timestamp/86400,
//     no string funcs) + per-day open/close boundary lookups — ~0.5s, then never again.
//   • INCREMENTAL REFRESH (every request): rowid watermark — `id > lastMaxId NOT INDEXED`
//     forces the INTEGER PRIMARY KEY range scan (0.4ms) to find days touched by new inserts;
//     only those days are re-aggregated (~0.7ms each). The cache's LAST day + today are always
//     re-aggregated too, because live bar upserts UPDATE the forming bucket in place (no new
//     rowid). Steady-state request cost: ~2ms.
//   • INVALIDATION: broadcast({type:"data_updated"}) in live-bars.ts calls invalidateDayCache —
//     bulk MW syncs / reconciles can rewrite OLD rows in place (no new rowids), and every such
//     flow already broadcasts data_updated to make clients refetch. Pure DELETEs of old days
//     with no broadcast are the one (rare, script-driven) case that stays stale until restart.
//
// Output rows are IDENTICAL to the old SQL: date = UTC day (DATE(datetime(ts,'unixepoch'))),
// open = MIN(open) among rows at the day's min timestamp, close = MIN(close) at max timestamp,
// high/low/volume aggregated across ALL of resolutions 5/15/60 (volume triple-counting
// preserved — same as before), ordered date DESC.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "./db";

export interface CachedDayRow {
  date: string; open: number; high: number; low: number; close: number; volume: number;
}

interface DayAgg { dayNum: number; open: number; high: number; low: number; close: number; volume: number; }
interface SymCache { days: Map<number, DayAgg>; maxId: number; }

const cache = new Map<string, SymCache>();

// Prepared statements (better-sqlite3, synchronous — all tuned to stay sub-ms except the
// one-time cold build).
const sqlite = () => (db as any).$client as import("better-sqlite3").Database;
let _stmts: {
  maxId: any; aggAll: any; newDays: any; dayAgg: any; openAt: any; closeAt: any;
} | null = null;
function stmts() {
  if (_stmts) return _stmts;
  const c = sqlite();
  _stmts = {
    maxId: c.prepare(`SELECT MAX(id) m FROM cached_candles`),
    aggAll: c.prepare(`
      SELECT timestamp/86400 AS dayNum,
             MAX(high) AS high, MIN(low) AS low, SUM(volume) AS volume,
             MIN(timestamp) AS tsMin, MAX(timestamp) AS tsMax
      FROM cached_candles
      WHERE symbol = ? AND resolution IN ('5','15','60')
      GROUP BY dayNum`),
    // NOT INDEXED is deliberate: it forbids the (symbol,resolution,timestamp) autoindex so the
    // planner uses the INTEGER PRIMARY KEY range scan on id — 0.4ms vs 75ms (measured).
    newDays: c.prepare(`
      SELECT DISTINCT timestamp/86400 AS dayNum
      FROM cached_candles NOT INDEXED
      WHERE id > ? AND symbol = ? AND resolution IN ('5','15','60')`),
    dayAgg: c.prepare(`
      SELECT MAX(high) AS high, MIN(low) AS low, SUM(volume) AS volume,
             MIN(timestamp) AS tsMin, MAX(timestamp) AS tsMax, COUNT(*) AS n
      FROM cached_candles
      WHERE symbol = ? AND resolution IN ('5','15','60') AND timestamp >= ? AND timestamp < ?`),
    openAt:  c.prepare(`SELECT MIN(open) AS v FROM cached_candles WHERE symbol = ? AND resolution IN ('5','15','60') AND timestamp = ?`),
    closeAt: c.prepare(`SELECT MIN(close) AS v FROM cached_candles WHERE symbol = ? AND resolution IN ('5','15','60') AND timestamp = ?`),
  };
  return _stmts;
}

function toAgg(sym: string, dayNum: number, r: any): DayAgg {
  return {
    dayNum,
    open:  Number(stmts().openAt.get(sym, r.tsMin)?.v),
    close: Number(stmts().closeAt.get(sym, r.tsMax)?.v),
    high: Number(r.high), low: Number(r.low), volume: Number(r.volume),
  };
}

function buildFull(sym: string): SymCache {
  const s = stmts();
  const maxId = Number(s.maxId.get()?.m ?? 0);
  const days = new Map<number, DayAgg>();
  for (const r of s.aggAll.all(sym) as any[]) {
    days.set(Number(r.dayNum), toAgg(sym, Number(r.dayNum), r));
  }
  return { days, maxId };
}

function refreshDay(sym: string, sc: SymCache, dayNum: number) {
  const r: any = stmts().dayAgg.get(sym, dayNum * 86400, (dayNum + 1) * 86400);
  if (!r || !r.n) { sc.days.delete(dayNum); return; }
  sc.days.set(dayNum, toAgg(sym, dayNum, r));
}

/** Day list for a symbol (date DESC), mirroring the old SQL row-for-row. ~2ms steady-state. */
export function getCachedDays(sym: string): CachedDayRow[] {
  let sc = cache.get(sym);
  if (!sc) {
    sc = buildFull(sym);
    cache.set(sym, sc);
  } else {
    const s = stmts();
    const newMaxId = Number(s.maxId.get()?.m ?? 0);
    if (newMaxId > sc.maxId) {
      for (const r of s.newDays.all(sc.maxId, sym) as any[]) refreshDay(sym, sc, Number(r.dayNum));
      sc.maxId = newMaxId;
    }
    // Forming-bucket upserts UPDATE in place (no new rowid) — always refresh the newest cached
    // day and today's UTC day so live OHLC/volume stay current.
    const today = Math.floor(Date.now() / 1000 / 86400);
    let lastCached = -1;
    for (const d of sc.days.keys()) if (d > lastCached) lastCached = d;
    if (lastCached >= 0) refreshDay(sym, sc, lastCached);
    if (today !== lastCached) refreshDay(sym, sc, today);
  }
  return [...sc.days.values()]
    .sort((a, b) => b.dayNum - a.dayNum) // date DESC, same as the old ORDER BY
    .map(d => ({
      date: new Date(d.dayNum * 86400000).toISOString().slice(0, 10), // UTC day, == DATE(datetime(ts,'unixepoch'))
      open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
    }));
}

/** Drop the cached aggregate (one symbol, or all) — next request does a full rebuild.
 *  Called from broadcast() on data_updated (bulk syncs may rewrite old rows in place). */
export function invalidateDayCache(symbol?: string) {
  if (symbol) cache.delete(symbol.toUpperCase());
  else cache.clear();
}
