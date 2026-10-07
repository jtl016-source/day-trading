/**
 * fractal-geometry.ts — Fractal Exchange GUIDE corroborators (2026-07-15 study mission).
 *
 * Mechanical translations of the studied Fractal Exchange material into walk-forward,
 * OHLCV-only detectors evaluated against OUR vector line (Highest(Lowest(low,20),20)):
 *
 *   • RECLAIM — "Best Counter-Trend Reversal" (Fractal Geometry Guide) unified with the
 *     Vector guide's Bullish/Bearish Ghost, Side Exit C and Table Top B: price falsely
 *     breaks the vector, then a bullish/bearish BODY closes back across it within
 *     RECLAIM_MAX_BREAK bars. Confirmation in the reclaim direction.
 *   • FLAT-BOUNCE — Side Exit B / Table Top A: the vector goes FLAT, price dips into it,
 *     takes support/resistance and closes away in trend direction.
 *   • VECTOR CHASE — Vector guide: "the VECTOR adjusts in the opposite direction of price;
 *     price tends to chase back toward the VECTOR". A CONTRADICTION against continuation
 *     away from the vector (per coordinator directive: contradicting fact, not corroborator).
 *   • WAVE TAPE MEASURE — Fractal Geometry Guide's Bullish/Bearish Percentage + Point Gain:
 *     the current wave's extent vs the distribution of prior same-direction wave extents.
 *     Below the median = "room to run" (confirmation); at/beyond the EXHAUST_PCTL percentile
 *     = exhaustion (contradiction) — the videos' 10-20% tail-band fade semantics
 *     ("80% chance of reversal", don't target open states inside the tail band).
 *   • COMPRESSION RELEASE — Bullish/Bearish Compression: >= COMPRESS_LEGS progressively
 *     shallower pullbacks (ascending pivot lows / descending pivot highs) resolving with a
 *     body close beyond the recent range.
 *   • PRIOR-CLOSE CROSS (E/S VECTORS) — the E/S VECTOR levels Milk draws nightly. No guide
 *     formula exists (proprietary); empirically identified from 24 labeled pairs mined out
 *     of data/reference/*.mwml: E VECTOR = prior trading day's 17:00 ET futures close
 *     (MAE 2.18 pts, max 5.63, n=14 same-contract days), S VECTOR ≈ prior day's 16:00 ET
 *     close (cash-close proxy; MAE 4.97). Fact = the first close crossing BEYOND BOTH
 *     levels (fresh conviction through yesterday's closes), corroborating for
 *     RECENT_BARS bars — a cross EVENT, not a standing state, to avoid fact inflation.
 *
 * Deliberately NOT implemented (documented judgment calls):
 *   • Open-state magnets as facts — an unswept wave extreme sits within reach on MOST bars;
 *     a standing state that is nearly always true corroborates nothing. Headroom semantics
 *     are covered by the tape measure's "room" state.
 *   • QQQ/SPY/ES synchronization — needs multi-index data we do not store.
 *   • W/M midpoint patterns — subsumed by reclaim (the second leg's midpoint break closes
 *     back across the vector in every guide illustration; a separate detector double-counts).
 *
 * WALK-FORWARD: every per-bar value derives ONLY from bars <= i (waves complete at their
 * crossing bar and enter the tape from that bar on). Truncation-tested in
 * fractal-geometry.test.ts — no lookahead.
 */

import type { FiringCandle } from "./firing/types";

export const FG_CONST = {
  FLAT_LOOKBACK: 6,         // bars the vector must be flat over ("adjusts ... goes flat")
  FLAT_TOL_PTS: 1.0,        // max |vector drift| over FLAT_LOOKBACK to call it flat
  TOUCH_TOL_PTS: 2.0,       // wick must come within this of the vector to be a "test"
  RECLAIM_MAX_BREAK: 5,     // false-break bars allowed before the reclaim close (Side Exit C window)
  CHASE_BARS: 8,            // slope window for vector-chase divergence
  CHASE_MIN_PRICE_PTS: 4,   // net price move needed before chase divergence counts
  CHASE_MIN_VEC_PTS: 0.25,  // vector must actually be adjusting (one tick over the window)
  WAVE_MIN_EXTENT_PTS: 3,   // ignore micro-waves in the tape measure
  WAVE_MIN_SAMPLE: 4,       // completed same-direction waves required before the tape speaks
  EXHAUST_PCTL: 0.8,        // current wave >= p80 of priors = exhaustion (tail-band fade)
  COMPRESS_LEGS: 3,         // >= this many progressively shallower pullbacks (guide: ~4)
  COMPRESS_SCAN_BARS: 40,   // pivot scan window for compression legs
  COMPRESS_BREAK_BARS: 10,  // breakout must clear the high/low of this many recent bars
  RECENT_BARS: 3,           // event facts corroborate for this many bars (incl. their own)
} as const;

export type FgDir = 1 | -1 | 0;

/** Which FG fact kinds COUNT toward the ≥2-agreeing-facts confluence (counted:true).
 *  DATA-DRIVEN (3-month window run, 2026-07-15): the first full pipeline run with all five
 *  kinds counted degraded the aggregate (before exp 1.46/PF 1.23 → after 0.94/1.14) because
 *  marginal stacks completed confluence on weak evidence. Per-kind expectancy on final trades:
 *    prior-close-cross +2.48 (win 56.7%, n=282)  ✓ counted
 *    reclaim           +0.82 (win 45.0%, n=420)  ✓ counted
 *    wave-room         +0.51 (n=1129 — a standing state on 36% of trades; below aggregate) → note
 *    flat-bounce       +0.34 (n=722)                                                       → note
 *    compression       −0.09 (n=539)                                                       → note
 *  Kinds below the aggregate are LABEL-NOTES (counted:false): they still display, still list
 *  in the WHY column, but can never complete confluence or bypass the gate. */
export const FG_COUNTED_KINDS: ReadonlySet<string> = new Set(["reclaim", "prior-close-cross"]);

export interface FgWaveTape {
  dir: 1 | -1;        // current wave direction (vs vector)
  extent: number;     // current wave extent (pts from the vector at the cross bar)
  median: number;     // median prior same-direction completed extent
  p80: number;        // EXHAUST_PCTL percentile of prior same-direction completed extents
  state: "room" | "exhausted" | "neutral";
}

export interface FractalGeometrySeries {
  /** Per-bar event direction: +1 Long / -1 Short / 0 none. Events fire ON their bar. */
  reclaim: FgDir[];
  flatBounce: FgDir[];
  compression: FgDir[];
  /** Vector-chase EXPECTED-RETURN direction (+1 = price expected to chase back UP to the
   *  vector => contradicts Shorts; -1 mirror). A warning state, evaluated per bar. */
  chase: FgDir[];
  /** Wave tape measure at each bar (null until WAVE_MIN_SAMPLE same-direction waves exist). */
  tape: (FgWaveTape | null)[];
  /** First close beyond BOTH prior-day closes (E above/S below → +1; mirror → -1). */
  priorCloseCross: FgDir[];
  /** E vector (prior trading day's final ~17:00 ET close) known at each bar; null while warming. */
  eVec: (number | null)[];
  /** S vector (prior trading day's 16:00 ET close) known at each bar; null while warming. */
  sVec: (number | null)[];
}

/** ET wall-clock minutes + calendar day key for a UTC epoch (DST-correct; never a fixed offset). */
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function etDayMins(epochSec: number): { day: string; mins: number } {
  const parts = ET_FMT.formatToParts(new Date(epochSec * 1000));
  const get = (t: string): string => parts.find(p => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, mins: (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10) };
}

/**
 * One O(n) pass over the primary interval's candles + vector values.
 * `vector[i]` may be null while the vector warms up — all detectors stay silent there.
 * `barSec` = the REAL bar spacing (caller infers it; close time = c.time + barSec).
 */
export function computeFractalGeometrySeries(
  candles: FiringCandle[],
  vector: (number | null)[],
  barSec: number,
): FractalGeometrySeries {
  const n = candles.length;
  const reclaim: FgDir[] = new Array(n).fill(0);
  const flatBounce: FgDir[] = new Array(n).fill(0);
  const compression: FgDir[] = new Array(n).fill(0);
  const chase: FgDir[] = new Array(n).fill(0);
  const tape: (FgWaveTape | null)[] = new Array(n).fill(null);
  const priorCloseCross: FgDir[] = new Array(n).fill(0);
  const eVecArr: (number | null)[] = new Array(n).fill(null);
  const sVecArr: (number | null)[] = new Array(n).fill(null);
  const C = FG_CONST;

  // ── wave state (vs vector) + completed-extent distributions per direction ──
  let side: FgDir = 0;             // current wave side (close vs vector)
  let waveBase: number | null = null; // vector value at the wave's cross bar
  let waveExtreme = 0;             // running extreme of the current wave
  const upExt: number[] = [];      // completed up-wave extents (ascending insert)
  const dnExt: number[] = [];      // completed down-wave extents
  const insertSorted = (arr: number[], v: number): void => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
    arr.splice(lo, 0, v);
  };

  // ── prior-close (E/S vector) day tracking ──
  let curDay = "";                    // ET calendar day of the CLOSE time
  let day16Close: number | null = null; // latest close whose close-time is <= 16:00 ET today
  let dayLastClose: number | null = null; // latest close today (the 17:00 close when the day ends)
  let eVec: number | null = null;     // committed prior-day final close
  let sVec: number | null = null;     // committed prior-day 16:00 close
  /** Yesterday-close band position of the PREVIOUS bar: 1 above both, -1 below both, 0 inside,
   *  null = no prior reading today (a day's FIRST reading is a POSITION, never a cross). */
  let prevDayState: FgDir | null = null;

  // ── pivot rings for compression (3-bar pivots, confirmed 1 bar late) ──
  const pivotLows: { idx: number; v: number }[] = [];
  const pivotHighs: { idx: number; v: number }[] = [];

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const v = vector[i];
    const closeTime = c.time + barSec;

    // ── E/S prior-close tracking (session-agnostic: uses ET calendar day of the close) ──
    const { day, mins } = etDayMins(closeTime);
    if (day !== curDay) {
      if (curDay !== "" && dayLastClose != null) {
        eVec = dayLastClose;                     // prior day's final (~17:00 ET) close
        sVec = day16Close ?? dayLastClose;       // prior day's 16:00 ET close (fallback: final)
      }
      curDay = day; day16Close = null; dayLastClose = null;
      prevDayState = null; // a new day re-arms the cross event (first reading = position)
    }
    if (mins <= 16 * 60) day16Close = c.close;
    dayLastClose = c.close;
    eVecArr[i] = eVec; sVecArr[i] = sVec;
    if (eVec != null && sVec != null) {
      const hi = Math.max(eVec, sVec), lo = Math.min(eVec, sVec);
      const nowState: FgDir = c.close > hi ? 1 : c.close < lo ? -1 : 0;
      if (prevDayState != null && nowState !== 0 && nowState !== prevDayState) priorCloseCross[i] = nowState;
      prevDayState = nowState;
    }

    if (v == null) continue; // vector warming — everything below needs it

    // ── wave bookkeeping ──
    const s: FgDir = c.close >= v ? 1 : -1;
    if (s !== side) {
      if (side !== 0 && waveBase != null) {
        const ext = Math.abs(waveExtreme - waveBase);
        if (ext >= C.WAVE_MIN_EXTENT_PTS) insertSorted(side === 1 ? upExt : dnExt, ext);
      }
      side = s; waveBase = v; waveExtreme = s === 1 ? c.high : c.low;
    } else {
      if (s === 1 && c.high > waveExtreme) waveExtreme = c.high;
      if (s === -1 && c.low < waveExtreme) waveExtreme = c.low;
    }

    // tape measure (current wave vs prior same-direction completed extents)
    const dist = side === 1 ? upExt : dnExt; // side is ±1 from here on (s is always ±1)
    if (waveBase != null && dist.length >= C.WAVE_MIN_SAMPLE) {
      const extent = Math.abs(waveExtreme - waveBase);
      const median = dist[Math.floor(dist.length / 2)];
      const p80 = dist[Math.min(dist.length - 1, Math.floor(dist.length * C.EXHAUST_PCTL))];
      tape[i] = { dir: side as 1 | -1, extent, median, p80, state: extent >= p80 ? "exhausted" : extent < median ? "room" : "neutral" };
    }

    // ── reclaim (counter-trend reversal / Ghost / Side Exit C / Table Top B) ──
    if (i >= 2) {
      if (c.close > v && c.close > c.open) {
        let below = 0, j = i - 1;
        while (j >= 0 && vector[j] != null && candles[j].close < (vector[j] as number) && below <= C.RECLAIM_MAX_BREAK) { below++; j--; }
        if (below >= 1 && below <= C.RECLAIM_MAX_BREAK && j >= 0 && vector[j] != null && candles[j].close >= (vector[j] as number)) reclaim[i] = 1;
      } else if (c.close < v && c.close < c.open) {
        let above = 0, j = i - 1;
        while (j >= 0 && vector[j] != null && candles[j].close > (vector[j] as number) && above <= C.RECLAIM_MAX_BREAK) { above++; j--; }
        if (above >= 1 && above <= C.RECLAIM_MAX_BREAK && j >= 0 && vector[j] != null && candles[j].close <= (vector[j] as number)) reclaim[i] = -1;
      }
    }

    // ── flat-bounce (Side Exit B / Table Top A) ──
    if (i >= C.FLAT_LOOKBACK) {
      const v0 = vector[i - C.FLAT_LOOKBACK];
      if (v0 != null && Math.abs(v - v0) <= C.FLAT_TOL_PTS) {
        if (c.close > v && c.close > c.open && Math.abs(c.low - v) <= C.TOUCH_TOL_PTS) flatBounce[i] = 1;
        else if (c.close < v && c.close < c.open && Math.abs(c.high - v) <= C.TOUCH_TOL_PTS) flatBounce[i] = -1;
      }
    }

    // ── vector chase (contradiction state) ──
    if (i >= C.CHASE_BARS) {
      const v0 = vector[i - C.CHASE_BARS];
      if (v0 != null) {
        const dv = v - v0, dp = c.close - candles[i - C.CHASE_BARS].close;
        if (Math.abs(dp) >= C.CHASE_MIN_PRICE_PTS && Math.abs(dv) >= C.CHASE_MIN_VEC_PTS) {
          if (dv > 0 && dp < 0) chase[i] = 1;       // expect chase back UP → contradicts Short
          else if (dv < 0 && dp > 0) chase[i] = -1; // expect chase back DOWN → contradicts Long
        }
      }
    }

    // ── compression release ──
    // confirm 3-bar pivots one bar late (pivot at i-1 needs bar i's neighbor — walk-forward safe)
    if (i >= 2) {
      const m = i - 1;
      if (candles[m].low < candles[m - 1].low && candles[m].low < candles[i].low) {
        pivotLows.push({ idx: m, v: candles[m].low });
        if (pivotLows.length > 40) pivotLows.shift();
      }
      if (candles[m].high > candles[m - 1].high && candles[m].high > candles[i].high) {
        pivotHighs.push({ idx: m, v: candles[m].high });
        if (pivotHighs.length > 40) pivotHighs.shift();
      }
    }
    if (i >= C.COMPRESS_SCAN_BARS) {
      const recentLows = pivotLows.filter(p => p.idx >= i - C.COMPRESS_SCAN_BARS).map(p => p.v);
      const recentHighs = pivotHighs.filter(p => p.idx >= i - C.COMPRESS_SCAN_BARS).map(p => p.v);
      const lastK = (a: number[]): number[] => a.slice(-C.COMPRESS_LEGS);
      const strictlyAsc = (a: number[]): boolean => a.length >= C.COMPRESS_LEGS && a.every((x, k) => k === 0 || x > a[k - 1]);
      const strictlyDesc = (a: number[]): boolean => a.length >= C.COMPRESS_LEGS && a.every((x, k) => k === 0 || x < a[k - 1]);
      let hh = -Infinity, ll = Infinity;
      for (let j = Math.max(0, i - C.COMPRESS_BREAK_BARS); j < i; j++) { if (candles[j].high > hh) hh = candles[j].high; if (candles[j].low < ll) ll = candles[j].low; }
      if (strictlyAsc(lastK(recentLows)) && c.close > hh && c.close > c.open) compression[i] = 1;
      else if (strictlyDesc(lastK(recentHighs)) && c.close < ll && c.close < c.open) compression[i] = -1;
    }
  }

  return { reclaim, flatBounce, compression, chase, tape, priorCloseCross, eVec: eVecArr, sVec: sVecArr };
}
