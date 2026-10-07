// shared/day-range-median.ts
// ─────────────────────────────────────────────────────────────────────────────
// DEAD-TAPE BASELINE (risk display, 2026-07-30): the median full-session-day realized range
// over the reporting window — the "0.6× the median" denominator behind the dead-tape risk
// flag (shared/fact-engine computeRiskFlags / scripts/risk-factor-analysis.ts regimeDrift).
//
// ONE implementation, consumed by BOTH sides so they can never drift:
//   • scripts/fact-engine-backtest.ts loadData()  → passes the value into every enginePass
//   • server/routes.ts GET /api/risk/combo-stats  → serves it to the live client adapter
// The parity test asserts the two values are EQUAL (fails loudly on any divergence).
//
// The bar chain mirrors the harness's serving-path 5m mirror byte-for-byte (loadServed →
// buildBaseCandles), then aggregates via the SAME buildSessionDays the yellowbox derivation
// uses, filters exactly like scripts/risk-factor-analysis.ts step 5 (window days only,
// bars ≥ 60, Mon–Fri, unfinished last day excluded from the median), and takes the median
// of (day.h − day.l). The analysis JSON's regimeBaseline (80.25 over 76 days on 2026-07-30)
// is this number.
// ─────────────────────────────────────────────────────────────────────────────
import { buildSessionDays, median, etWallToEpoch, etParts, rnd2, type Bar } from "./yellowbox-core";
import { buildBaseCandles, type LiveCandle } from "./live-adapter";

/** Minimal structural slice of a better-sqlite3 handle — keeps this module dependency-free
 *  (the client bundle must never pull better-sqlite3; only server/harness import this). */
export interface SqliteLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

// ── Serving-path 5m mirror predicates (VERBATIM from scripts/fact-engine-backtest.ts
// loadServed — which itself mirrors /api/data/cached-continuous's serve-time chain). ──
const SPIKE_THR_5M = 0.040;
function isServeSpikeBar5m(o: number, h: number, l: number, c: number): boolean {
  if (h < l || o > h || o < l || c > h || c < l || c <= 0) return true;
  const range = h - l;
  if (range / c > SPIKE_THR_5M) return true;
  if (range / c > SPIKE_THR_5M * 0.5) {
    if ((Math.abs(o - h) < 0.5 && Math.abs(l - c) < 0.5) ||
        (Math.abs(o - l) < 0.5 && Math.abs(h - c) < 0.5)) return true;
  }
  return false;
}
const _closedCache = new Map<number, boolean>();
function isMarketClosedEt(t: number): boolean {
  const hb = Math.floor(t / 3600);
  const hit = _closedCache.get(hb);
  if (hit !== undefined) return hit;
  const p = etParts(t);
  const dow = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
  const mins = p.hh * 60 + p.mm;
  let closed: boolean;
  if (dow === 6) closed = true;                       // Saturday
  else if (dow === 5) closed = mins >= 17 * 60;       // Friday after 5 PM ET
  else if (dow === 0) closed = mins < 18 * 60;        // Sunday before 6 PM ET
  else closed = mins >= 17 * 60 && mins < 18 * 60;    // daily maintenance halt
  _closedCache.set(hb, closed);
  return closed;
}

export interface DayRangeMedianResult {
  /** Median session-day realized range (pts), rounded to 2dp like the analysis meta. 0 when
   *  no eligible days exist (callers treat 0/absent as "flag not computable"). */
  median: number;
  nDays: number;
  windowFromKey: string;
}

/** Compute the window median session-day range straight from a cached_candles DB handle.
 *  `windowFromKey` MUST be the harness's reporting-window start (WINDOW_START_KEY) on both
 *  sides — the parity test asserts the resulting medians are equal. */
export function medianSessionDayRangeFromDb(
  db: SqliteLike,
  symbol: string,
  windowFromKey: string,
  nowSec: number,
): DayRangeMedianResult {
  // Session day X spans (X−1) 18:00 ET → X 17:00 ET, so a 2-day head margin before the
  // window's first calendar day covers the first session completely.
  const fromTs = etWallToEpoch(windowFromKey, 0, 0) - 2 * 86400;
  const rows = db.prepare(
    `SELECT timestamp t, open o, high h, low l, close c, volume v
     FROM cached_candles WHERE symbol=? AND resolution='5' AND timestamp>=? ORDER BY timestamp`
  ).all(symbol, fromTs) as Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;

  // Serve-mirror chain (off-grid / flat / spike / closed / dup-last-wins), then the client
  // primary chain (buildBaseCandles, showETH=true) — identical to the harness's full5m.
  const served: LiveCandle[] = [];
  for (const r of rows) {
    if (r.t % 300 !== 0) continue;
    if (r.h === r.l) continue;
    if (isServeSpikeBar5m(r.o, r.h, r.l, r.c)) continue;
    if (isMarketClosedEt(r.t)) continue;
    if (served.length && served[served.length - 1].time === r.t) served.pop();
    served.push({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v ?? 0 });
  }
  const full5m = buildBaseCandles(served, true, nowSec);
  const bars: Bar[] = full5m.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? 0 }));

  const { dayMap } = buildSessionDays(bars);
  const days = [...dayMap.values()]
    .filter(d => d.bars >= 60 && d.weekday >= 1 && d.weekday <= 5 && d.key >= windowFromKey)
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const lastKey = days[days.length - 1]?.key ?? "";
  const lastUnfinished = lastKey !== "" && etWallToEpoch(lastKey, 17, 0) > nowSec;
  const ranges = days
    .filter(d => !(lastUnfinished && d.key === lastKey))
    .map(d => d.h - d.l);
  return { median: ranges.length ? rnd2(median(ranges)) : 0, nDays: ranges.length, windowFromKey };
}
