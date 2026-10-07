// shared/ict-engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// ICT STRATEGY ENGINE — mechanical implementations of the seven ICT setups the
// user studied at theicttrader.com (five articles by Fadi Zeidan):
//   1. "Introduction to ICT Trading"                       (liquidity / structure context)
//   2. "Wicks Require Special Consideration"               (consequent encroachment, 50% fibs)
//   3. "Understanding Order Blocks"                        (high-probability OB, CISD)
//   4. "Order Blocks, Breaker Blocks and Mitigation Blocks" (breaker, unicorn, mitigation)
//   5. "ICT Balanced and Imbalanced Price Ranges"          (fair value gaps / BPR)
//
// PURE + STANDALONE: no DB, no DOM. The CORE ENGINE takes significant liquidity
// levels (prior-day / session highs & lows) INJECTED as time-windowed
// LiquidityLevel rows, so it stays deterministic and unit-testable on synthetic
// bars. For callers that want the standard derivation, `deriveSessionLevels`
// (bottom of this file) builds those rows from raw candles — the SAME derivation
// scripts/ict-backtest.ts uses — and `killZoneOf` names the ICT kill zone of a
// timestamp. Both are caller-side helpers, separate from the engine pass.
//
// NO LOOKAHEAD, by construction: every detection at bar i reads only bars ≤ i;
// swings need SWING_N later bars, so a pivot at p is only *usable* from bar
// p + SWING_N onward (its confirmation bar). Verified by a truncation test in
// shared/ict-engine.test.ts.
//
// The engine emits SETUPS (trade plans: entry kind/level, stop, TP1/TP2,
// invalidation). Fill resolution on 1m bars, session bookkeeping and outcome
// walking live in scripts/ict-backtest.ts (mirroring the fact-engine split).
// ─────────────────────────────────────────────────────────────────────────────

import type { FiringCandle } from "./firing/types";
import { etParts, etWallToEpoch, sessionDayKey, priorCalendarDay } from "./yellowbox-core";

export type IctDirection = "Long" | "Short";
export type IctStrategy =
  | "ICT-OB"          // high-probability order block
  | "ICT-FVG"         // fair value gap
  | "ICT-BREAKER"     // failed OB traded from the other side (may be flagged unicorn)
  | "ICT-SWEEP"       // liquidity sweep reversal (turtle soup)
  | "ICT-MSS"         // market structure shift + OTE retracement
  | "ICT-CE"          // consequent-encroachment wick reversal
  | "ICT-MITIGATION"; // the article's lower-probability (incomplete) order block

export const ICT_STRATEGIES: IctStrategy[] = [
  "ICT-OB", "ICT-FVG", "ICT-BREAKER", "ICT-SWEEP", "ICT-MSS", "ICT-CE", "ICT-MITIGATION",
];

/** User-facing names (no internal jargon in anything the user reads). */
export const ICT_DISPLAY: Record<IctStrategy, string> = {
  "ICT-OB": "ICT Order Block",
  "ICT-FVG": "ICT Fair Value Gap",
  "ICT-BREAKER": "ICT Breaker",
  "ICT-SWEEP": "ICT Liquidity Sweep",
  "ICT-MSS": "ICT Structure Shift + OTE",
  "ICT-CE": "ICT Wick Reversal (C.E.)",
  "ICT-MITIGATION": "ICT Mitigation Block",
};

// ─────────────────────────── NAMED CONSTANTS ────────────────────────────────
// Every threshold the detectors use, in one place (documented in the workbook README).

export const ICT_CONST = {
  /** Fractal swing: a pivot high needs N strictly-lower highs on EACH side (ties = no pivot). */
  SWING_N: 2,
  /** Displacement: candle body > this multiple of the 20-bar median body. */
  DISPLACEMENT_MULT: 1.5,
  /** Bars in the rolling median used for displacement (body) and wick (range) tests. */
  MEDIAN_LOOKBACK: 20,
  /** Displacement floor: the body must also exceed this many points (guards dead-flat stretches
   *  where the median body is ~0 and any tick would count as displacement). */
  DISPLACEMENT_MIN_PTS: 0.5,
  /** OB/MSS qualifying liquidity sweep must have happened within this many bars before the displacement. */
  SWEEP_LOOKBACK_BARS: 10,
  /** How far back from the displacement candle we search for the last opposite-color (OB) candle. */
  OB_SEARCH_MAX_BARS: 10,
  /** Limit entries (OB/FVG/BREAKER/MSS/CE) must fill within this many bars of the signal, else expire. */
  RETEST_WINDOW_BARS: 30,
  /** A high-probability OB can turn into a breaker only if it fails within this many bars of its birth. */
  OB_FAIL_WINDOW_BARS: 60,
  /** Turtle-soup swing levels must be at least this many bars old ("significant" resting liquidity). */
  SWEEP_SWING_MIN_AGE_BARS: 20,
  /** OTE zone = 62%–79% retracement of the displacement leg; the limit sits at the 62% line. */
  OTE_MIN_RETRACE: 0.62,
  OTE_MAX_RETRACE: 0.79,
  /** C.E. wick candle: wick ≥ 2× its own body AND wick ≥ 1.5× the 20-bar median RANGE. */
  CE_WICK_BODY_MULT: 2,
  CE_WICK_RANGE_MULT: 1.5,
  /** C.E. "at/near a pivot": the wick makes a new 20-bar extreme, or lands within tolerance of a resting swing. */
  CE_PIVOT_LOOKBACK_BARS: 20,
  CE_PIVOT_TOL_PTS: 2,
  /** TP1 = the CLOSER of (next opposing liquidity pool, 2R). TP2 = the pool itself. */
  TP_RR_CAP: 2,
  /** No pool in view: TP1 = 2R and TP2 = twice the TP1 distance (4R). */
  TP2_FALLBACK_RR: 4,
  /** An opposing pool must sit at least this far beyond entry to count as a target. */
  MIN_POOL_DIST_PTS: 1,
  /** Stops sit this many ticks beyond the anchor extreme ("beyond" needs a real buffer). */
  STOP_BUFFER_TICKS: 1,
  TICK: 0.25,
  /** Signal cooldown per strategy per interval (bars between emitted setups, both directions).
   *  SCOPE (2026-09-25): spaces the ICT engine's own SETUPS only — those become corroborator
   *  facts. It is NOT the fire cooldown: every writer (catch-up, live engine, tab, admission)
   *  uses FACT_ENGINE_DEFAULTS.COOLDOWN_BARS (shared/fact-engine.ts); guarded by
   *  scripts/fire-admission.test.ts "no divergent cooldown copy". */
  COOLDOWN_BARS: 4,
  /** ICT+ICT / ICT×existing confluence window (bars on the same interval, same direction). */
  CONFLUENCE_WINDOW_BARS: 3,
  /** A breaker is a "Unicorn" when a same-direction FVG formed within this many bars overlaps its zone. */
  UNICORN_FVG_LOOKBACK_BARS: 20,
  /** Resting-liquidity memory: only the most recent N unswept swings per side are tracked
   *  (bounds cost; decade-old liquidity is not tradeable intraday — judgment call, documented). */
  LIQUIDITY_MEMORY_SWINGS: 200,
  /** Nothing fires before this many bars (median window + swing confirmation warmup). */
  MIN_WARMUP_BARS: 25,
} as const;

const K = ICT_CONST;
const STOP_BUFFER_PTS = K.STOP_BUFFER_TICKS * K.TICK;

// ─────────────────────────────── TYPES ──────────────────────────────────────

/** A significant liquidity level injected by the caller (prior-day / session high-low).
 *  The engine may treat it as sweepable only while closeTs ∈ [activeFromTs, activeToTs]. */
export interface LiquidityLevel {
  price: number;
  /** The other side of the swept range (target for turtle-soup TP2). */
  opposite: number;
  /** Plain-English kind, e.g. "prior-day high", "Asia session low". */
  kind: string;
  /** true = a HIGH (swept by an up-wick, traded short); false = a LOW. */
  isHigh: boolean;
  activeFromTs: number;
  activeToTs: number;
}

export interface IctSetup {
  strategy: IctStrategy;
  direction: IctDirection;
  interval: string;
  /** Bar index of the signal bar (detection bar) within the input candle array. */
  setupIdx: number;
  /** Signal bar OPEN time (unix sec) — mirrors FactSignal.time. */
  setupTime: number;
  /** Signal bar CLOSE time = the earliest moment the setup is actionable. */
  barCloseTs: number;
  /** "market" = enter at the signal bar close (SWEEP). "limit" = resting order at `entry`. */
  entryKind: "limit" | "market";
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  /** FVG only: if a 1m bar OPENS beyond this level before the limit fills, the setup is invalid
   *  (price "exceeded the 50% fib" without offering the entry — gap-through). */
  invalidBeyond?: number;
  /** BREAKER only: an overlapping same-direction FVG upgrades it to the "Unicorn". */
  unicorn?: boolean;
  /** Plain-English WHY IT FIRED. */
  why: string;
  /** Plain-English anchor descriptions for the exit levels. */
  tp1Anchor: string;
  tp2Anchor: string;
  slAnchor: string;
  /** Raw audit values (level prices, indices) for spot-checking trades. */
  refs: Record<string, number>;
}

export interface IctEngineInput {
  candles: FiringCandle[];
  interval: string;
  /** Bar length in seconds (e.g. 300 for 5m). */
  barSec: number;
  /** Caller-provided significant levels, sorted by activeFromTs ascending. */
  levels?: LiquidityLevel[];
  /** Restrict to a subset of strategies (default: all seven). */
  strategies?: IctStrategy[];
}

// ─────────────────────────── SMALL HELPERS ──────────────────────────────────

const body = (c: FiringCandle): number => Math.abs(c.close - c.open);
const isUp = (c: FiringCandle): boolean => c.close > c.open;
const isDown = (c: FiringCandle): boolean => c.close < c.open;
const rnd2 = (x: number): number => Math.round(x * 100) / 100;

/** Rolling median over the PREVIOUS `win` values (value at i covers [i-win, i-1]; NaN until full). */
export function rollingMedianPrev(values: number[], win: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const sorted: number[] = [];
  const insertAt = (v: number): number => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (let i = 0; i < values.length; i++) {
    if (sorted.length === win) {
      const m = win % 2 ? sorted[(win - 1) / 2] : (sorted[win / 2 - 1] + sorted[win / 2]) / 2;
      out[i] = m;
      const gone = values[i - win];
      sorted.splice(insertAt(gone), 1); // duplicates fine — removes one equal value
    }
    sorted.splice(insertAt(values[i]), 0, values[i]);
    if (sorted.length > win) {
      // only reachable on the first pass before out[] starts (kept for safety)
      const gone = values[i - win];
      sorted.splice(insertAt(gone), 1);
    }
  }
  return out;
}

interface SwingPt { idx: number; price: number }

/** Fractal pivots: STRICTLY higher high (or lower low) than SWING_N bars on each side.
 *  Returned in index order; a pivot at idx is only knowable from bar idx+N onward. */
export function findSwings(candles: FiringCandle[], n: number): { highs: SwingPt[]; lows: SwingPt[] } {
  const highs: SwingPt[] = [], lows: SwingPt[] = [];
  for (let p = n; p < candles.length - n; p++) {
    let isHi = true, isLo = true;
    for (let k = 1; k <= n && (isHi || isLo); k++) {
      if (!(candles[p].high > candles[p - k].high && candles[p].high > candles[p + k].high)) isHi = false;
      if (!(candles[p].low < candles[p - k].low && candles[p].low < candles[p + k].low)) isLo = false;
    }
    if (isHi) highs.push({ idx: p, price: candles[p].high });
    if (isLo) lows.push({ idx: p, price: candles[p].low });
  }
  return { highs, lows };
}

// ─────────────────────────────── ENGINE ─────────────────────────────────────

interface ObRecord { dir: IctDirection; obIdx: number; obOpen: number; obHigh: number; obLow: number; emittedAtIdx: number }
interface FvgRecord { dir: IctDirection; formIdx: number; lo: number; hi: number }
interface SweepEvent { barIdx: number; level: number; extreme: number }
interface PendingTs { level: number; opposite: number; kind: string; extreme: number; barIdx: number; rank: number }

export function runIctEngine(input: IctEngineInput): IctSetup[] {
  const { candles: cs, interval, barSec } = input;
  const enabled = new Set<IctStrategy>(input.strategies ?? ICT_STRATEGIES);
  const out: IctSetup[] = [];
  if (cs.length < K.MIN_WARMUP_BARS + 1) return out;

  // Precompute bodies / ranges / prior-window medians and swing pivots.
  const bodies = cs.map(body);
  const ranges = cs.map(c => c.high - c.low);
  const medBody = rollingMedianPrev(bodies, K.MEDIAN_LOOKBACK);
  const medRange = rollingMedianPrev(ranges, K.MEDIAN_LOOKBACK);
  const displacement = (i: number): boolean => {
    const m = medBody[i];
    if (!isFinite(m)) return false;
    return bodies[i] > Math.max(K.DISPLACEMENT_MULT * m, K.DISPLACEMENT_MIN_PTS);
  };
  const dispMult = (i: number): number => (isFinite(medBody[i]) && medBody[i] > 0 ? bodies[i] / medBody[i] : 0);
  const { highs: allHighs, lows: allLows } = findSwings(cs, K.SWING_N);
  let nextHi = 0, nextLo = 0; // cursors into allHighs/allLows (added at confirmation bar)

  // Liquidity view (consumed on WICK) and structure view (consumed on CLOSE-through).
  const liqHighs: SwingPt[] = [], liqLows: SwingPt[] = [];
  const structHighs: SwingPt[] = [], structLows: SwingPt[] = [];
  const capPush = (arr: SwingPt[], s: SwingPt): void => {
    arr.push(s);
    if (arr.length > K.LIQUIDITY_MEMORY_SWINGS) arr.shift();
  };
  let lastConfirmedLow: number | null = null, lastConfirmedHigh: number | null = null;

  // Caller levels: time-sorted queue → active list.
  const levelQueue = [...(input.levels ?? [])].sort((a, b) => a.activeFromTs - b.activeFromTs);
  let levelCursor = 0;
  const activeLevels: LiquidityLevel[] = [];

  // Rolling state.
  let lastLowSweep: SweepEvent | null = null;   // wick below a resting level, close back above
  let lastHighSweep: SweepEvent | null = null;
  let pendingHighTs: PendingTs | null = null;   // turtle soup awaiting next-candle close-back
  let pendingLowTs: PendingTs | null = null;
  const obRegistry: ObRecord[] = [];            // high-probability OBs armed for breaker duty
  const fvgRegistry: FvgRecord[] = [];          // recent FVG zones (unicorn overlap checks)
  const obUsedLong = new Set<number>(), obUsedShort = new Set<number>(); // OB-candle dedupe
  const lastEmitIdx: Partial<Record<IctStrategy, number>> = {};

  const cooled = (st: IctStrategy, i: number): boolean => {
    const last = lastEmitIdx[st];
    return last === undefined || i - last >= K.COOLDOWN_BARS;
  };

  /** Nearest resting liquidity pool ≥ MIN_POOL_DIST beyond `from` in the profit direction. */
  const nearestPool = (from: number, dir: IctDirection): number | null => {
    let best: number | null = null;
    if (dir === "Long") {
      for (const s of liqHighs) if (s.price >= from + K.MIN_POOL_DIST_PTS && (best === null || s.price < best)) best = s.price;
    } else {
      for (const s of liqLows) if (s.price <= from - K.MIN_POOL_DIST_PTS && (best === null || s.price > best)) best = s.price;
    }
    return best;
  };

  /** TP1 = closer of (pool, 2R); TP2 = the pool (or 2× TP1 distance when no pool is in view). */
  const targetsFor = (entry: number, risk: number, dir: IctDirection): {
    tp1: number; tp2: number; tp1Anchor: string; tp2Anchor: string; pool: number | null;
  } => {
    const pool = nearestPool(entry, dir);
    const sgn = dir === "Long" ? 1 : -1;
    const rrTp = entry + sgn * K.TP_RR_CAP * risk;
    if (pool === null) {
      return {
        tp1: rnd2(rrTp), tp2: rnd2(entry + sgn * K.TP2_FALLBACK_RR * risk),
        tp1Anchor: `${K.TP_RR_CAP}R cap (no opposing liquidity pool in view)`,
        tp2Anchor: `twice the TP1 distance (no opposing liquidity pool in view)`,
        pool,
      };
    }
    const poolCloser = dir === "Long" ? pool < rrTp : pool > rrTp;
    return {
      tp1: rnd2(poolCloser ? pool : rrTp),
      tp2: rnd2(pool),
      tp1Anchor: poolCloser
        ? `next opposing liquidity pool (resting swing ${dir === "Long" ? "high" : "low"}) at ${rnd2(pool)}`
        : `${K.TP_RR_CAP}R cap (the pool at ${rnd2(pool)} sits beyond it)`,
      tp2Anchor: `the liquidity pool at ${rnd2(pool)}`,
      pool,
    };
  };

  const emit = (s: IctSetup): void => {
    out.push(s);
    lastEmitIdx[s.strategy] = s.setupIdx;
  };

  /** Shared OB/MITIGATION emission (identical geometry; the qualifying facts differ). */
  const emitObLike = (
    st: IctStrategy, dir: IctDirection, i: number, obIdx: number, why: string, refs: Record<string, number>,
  ): boolean => {
    const ob = cs[obIdx];
    const entry = ob.open;
    const c = cs[i];
    if (dir === "Long") {
      if (!(entry <= c.close - K.TICK)) return false;          // must be a retracement entry
      const stop = ob.low - STOP_BUFFER_PTS;
      const risk = entry - stop;
      if (risk < K.TICK) return false;
      const t = targetsFor(entry, risk, dir);
      emit({
        strategy: st, direction: dir, interval, setupIdx: i, setupTime: cs[i].time, barCloseTs: cs[i].time + barSec,
        entryKind: "limit", entry: rnd2(entry), stop: rnd2(stop), tp1: t.tp1, tp2: t.tp2,
        why, tp1Anchor: t.tp1Anchor, tp2Anchor: t.tp2Anchor,
        slAnchor: `1 tick below the order-block candle's low ${rnd2(ob.low)}`,
        refs: { ...refs, obIdx, obOpen: ob.open, obHigh: ob.high, obLow: ob.low },
      });
    } else {
      if (!(entry >= c.close + K.TICK)) return false;
      const stop = ob.high + STOP_BUFFER_PTS;
      const risk = stop - entry;
      if (risk < K.TICK) return false;
      const t = targetsFor(entry, risk, dir);
      emit({
        strategy: st, direction: dir, interval, setupIdx: i, setupTime: cs[i].time, barCloseTs: cs[i].time + barSec,
        entryKind: "limit", entry: rnd2(entry), stop: rnd2(stop), tp1: t.tp1, tp2: t.tp2,
        why, tp1Anchor: t.tp1Anchor, tp2Anchor: t.tp2Anchor,
        slAnchor: `1 tick above the order-block candle's high ${rnd2(ob.high)}`,
        refs: { ...refs, obIdx, obOpen: ob.open, obHigh: ob.high, obLow: ob.low },
      });
    }
    return true;
  };

  // ────────────────────────── MAIN FORWARD PASS ─────────────────────────────
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const closeTs = c.time + barSec;

    // (a) Swings confirmed at this bar (pivot p = i - SWING_N).
    while (nextHi < allHighs.length && allHighs[nextHi].idx + K.SWING_N === i) {
      capPush(liqHighs, { ...allHighs[nextHi] });
      capPush(structHighs, { ...allHighs[nextHi] });
      lastConfirmedHigh = allHighs[nextHi].price;
      nextHi++;
    }
    while (nextLo < allLows.length && allLows[nextLo].idx + K.SWING_N === i) {
      capPush(liqLows, { ...allLows[nextLo] });
      capPush(structLows, { ...allLows[nextLo] });
      lastConfirmedLow = allLows[nextLo].price;
      nextLo++;
    }

    // (b) Caller-level lifecycle.
    while (levelCursor < levelQueue.length && levelQueue[levelCursor].activeFromTs <= closeTs) {
      activeLevels.push(levelQueue[levelCursor++]);
    }
    for (let x = activeLevels.length - 1; x >= 0; x--) {
      if (activeLevels[x].activeToTs < closeTs) activeLevels.splice(x, 1);
    }

    // (c) Sweep detection for bar i — versus resting swings (liquidity view, pre-consumption)
    //     and versus caller levels. Records reclaim events + turtle-soup candidates.
    interface TsCand { level: number; opposite: number; kind: string; rank: number }
    let tsHighCand: TsCand | null = null; // best high-level swept this bar (rank: 0 prior-day, 1 session, 2 swing)
    let tsLowCand: TsCand | null = null;
    const sweptLowPricesThisBar: number[] = [];  // for CE "near a pivot" (the wick may consume the very pivot it reacts to)
    const sweptHighPricesThisBar: number[] = [];
    {
      // swing highs wicked this bar
      let reclaimedHi: number | null = null;
      let sweptOldHi: SwingPt | null = null;
      for (let x = liqHighs.length - 1; x >= 0; x--) {
        const s = liqHighs[x];
        if (c.high > s.price) {
          sweptHighPricesThisBar.push(s.price);
          if (c.close < s.price && (reclaimedHi === null || s.price > reclaimedHi)) reclaimedHi = s.price;
          if (i - s.idx >= K.SWEEP_SWING_MIN_AGE_BARS && (sweptOldHi === null || s.price > sweptOldHi.price)) sweptOldHi = s;
          liqHighs.splice(x, 1); // consumed (wicked) either way
        }
      }
      if (reclaimedHi !== null) lastHighSweep = { barIdx: i, level: reclaimedHi, extreme: c.high };
      if (sweptOldHi) tsHighCand = { level: sweptOldHi.price, opposite: lastConfirmedLow ?? sweptOldHi.price, kind: `resting swing high (${i - sweptOldHi.idx} bars old)`, rank: 2 };

      // swing lows wicked this bar
      let reclaimedLo: number | null = null;
      let sweptOldLo: SwingPt | null = null;
      for (let x = liqLows.length - 1; x >= 0; x--) {
        const s = liqLows[x];
        if (c.low < s.price) {
          sweptLowPricesThisBar.push(s.price);
          if (c.close > s.price && (reclaimedLo === null || s.price < reclaimedLo)) reclaimedLo = s.price;
          if (i - s.idx >= K.SWEEP_SWING_MIN_AGE_BARS && (sweptOldLo === null || s.price < sweptOldLo.price)) sweptOldLo = s;
          liqLows.splice(x, 1);
        }
      }
      if (reclaimedLo !== null) lastLowSweep = { barIdx: i, level: reclaimedLo, extreme: c.low };
      if (sweptOldLo) tsLowCand = { level: sweptOldLo.price, opposite: lastConfirmedHigh ?? sweptOldLo.price, kind: `resting swing low (${i - sweptOldLo.idx} bars old)`, rank: 2 };

      // caller levels wicked this bar (prior-day rank 0, session rank 1)
      for (let x = activeLevels.length - 1; x >= 0; x--) {
        const L = activeLevels[x];
        const rank = L.kind.startsWith("prior-day") ? 0 : 1;
        if (L.isHigh && c.high > L.price) {
          if (c.close < L.price) lastHighSweep = { barIdx: i, level: L.price, extreme: c.high };
          if (!tsHighCand || rank < tsHighCand.rank || (rank === tsHighCand.rank && L.price > tsHighCand.level)) {
            tsHighCand = { level: L.price, opposite: L.opposite, kind: L.kind, rank };
          }
          activeLevels.splice(x, 1); // one turtle soup per level per day
        } else if (!L.isHigh && c.low < L.price) {
          if (c.close > L.price) lastLowSweep = { barIdx: i, level: L.price, extreme: c.low };
          if (!tsLowCand || rank < tsLowCand.rank || (rank === tsLowCand.rank && L.price < tsLowCand.level)) {
            tsLowCand = { level: L.price, opposite: L.opposite, kind: L.kind, rank };
          }
          activeLevels.splice(x, 1);
        }
      }
    }

    const warm = i >= K.MIN_WARMUP_BARS;

    // (d) ICT-SWEEP (turtle soup): same-candle close-back with displacement, else arm next-candle check.
    if (warm && enabled.has("ICT-SWEEP")) {
      // resolve pendings from bar i-1 first (next-candle confirmation)
      if (pendingHighTs && pendingHighTs.barIdx === i - 1) {
        const p = pendingHighTs;
        if (c.close < p.level && displacement(i) && cooled("ICT-SWEEP", i)) {
          emitSweep("Short", i, p.level, p.opposite, p.kind, Math.max(p.extreme, c.high), "the next candle");
        }
        pendingHighTs = null;
      }
      if (pendingLowTs && pendingLowTs.barIdx === i - 1) {
        const p = pendingLowTs;
        if (c.close > p.level && displacement(i) && cooled("ICT-SWEEP", i)) {
          emitSweep("Long", i, p.level, p.opposite, p.kind, Math.min(p.extreme, c.low), "the next candle");
        }
        pendingLowTs = null;
      }
      if (tsHighCand) {
        if (c.close < tsHighCand.level && displacement(i) && cooled("ICT-SWEEP", i)) {
          emitSweep("Short", i, tsHighCand.level, tsHighCand.opposite, tsHighCand.kind, c.high, "the same candle");
        } else if (c.close >= tsHighCand.level) {
          pendingHighTs = { ...tsHighCand, extreme: c.high, barIdx: i };
        }
      }
      if (tsLowCand) {
        if (c.close > tsLowCand.level && displacement(i) && cooled("ICT-SWEEP", i)) {
          emitSweep("Long", i, tsLowCand.level, tsLowCand.opposite, tsLowCand.kind, c.low, "the same candle");
        } else if (c.close <= tsLowCand.level) {
          pendingLowTs = { ...tsLowCand, extreme: c.low, barIdx: i };
        }
      }
    } else {
      pendingHighTs = pendingLowTs = null;
    }

    // (e) FVG detection (3-candle displacement gap ending at bar i) — registered for unicorn
    //     checks even when the tradeable setup is suppressed (cooldown/geometry).
    if (i >= 2) {
      const c1 = cs[i - 2], c2 = cs[i - 1];
      // bullish: c1.high < c3.low with an up displacement middle candle
      if (c1.high < c.low && isUp(c2) && displacement(i - 1)) {
        fvgRegistry.push({ dir: "Long", formIdx: i, lo: c1.high, hi: c.low });
        if (warm && enabled.has("ICT-FVG") && cooled("ICT-FVG", i)) {
          const gapCe = (c1.high + c.low) / 2;                 // consequent encroachment of the gap
          const bprFib = (c2.high + c1.low) / 2;               // 50% of the c2.high→c1.low impulse (wicks article)
          const entry = Math.max(gapCe, bprFib);               // the shallower 50% is offered first
          const invalidBeyond = Math.min(gapCe, bprFib);       // gapping past the deeper 50% kills the setup
          const stop = c1.low - STOP_BUFFER_PTS;
          const risk = entry - stop;
          if (entry <= c.close - K.TICK && risk >= K.TICK) {
            const t = targetsFor(entry, risk, "Long");
            emit({
              strategy: "ICT-FVG", direction: "Long", interval, setupIdx: i, setupTime: c.time, barCloseTs: closeTs,
              entryKind: "limit", entry: rnd2(entry), stop: rnd2(stop), tp1: t.tp1, tp2: t.tp2,
              invalidBeyond: rnd2(invalidBeyond),
              why: `A 3-candle gap opened under price: candle 1's high ${rnd2(c1.high)} never traded against candle 3's low ${rnd2(c.low)}, and the middle candle was a displacement candle (body ${dispMult(i - 1).toFixed(1)}x the 20-bar median). Buy limit at ${rnd2(entry)} — the 50% consequent-encroachment level — invalid if price gaps below ${rnd2(invalidBeyond)} before filling.`,
              tp1Anchor: t.tp1Anchor, tp2Anchor: t.tp2Anchor,
              slAnchor: `1 tick below candle 1's low ${rnd2(c1.low)}`,
              refs: { gapLo: c1.high, gapHi: c.low, gapCe: rnd2(gapCe), bprFib: rnd2(bprFib), c1Low: c1.low, c2High: c2.high, dispMult: rnd2(dispMult(i - 1)) },
            });
          }
        }
      }
      // bearish: c1.low > c3.high with a down displacement middle candle
      if (c1.low > c.high && isDown(c2) && displacement(i - 1)) {
        fvgRegistry.push({ dir: "Short", formIdx: i, lo: c.high, hi: c1.low });
        if (warm && enabled.has("ICT-FVG") && cooled("ICT-FVG", i)) {
          const gapCe = (c1.low + c.high) / 2;
          const bprFib = (c2.low + c1.high) / 2;
          const entry = Math.min(gapCe, bprFib);
          const invalidBeyond = Math.max(gapCe, bprFib);
          const stop = c1.high + STOP_BUFFER_PTS;
          const risk = stop - entry;
          if (entry >= c.close + K.TICK && risk >= K.TICK) {
            const t = targetsFor(entry, risk, "Short");
            emit({
              strategy: "ICT-FVG", direction: "Short", interval, setupIdx: i, setupTime: c.time, barCloseTs: closeTs,
              entryKind: "limit", entry: rnd2(entry), stop: rnd2(stop), tp1: t.tp1, tp2: t.tp2,
              invalidBeyond: rnd2(invalidBeyond),
              why: `A 3-candle gap opened above price: candle 1's low ${rnd2(c1.low)} never traded against candle 3's high ${rnd2(c.high)}, and the middle candle was a displacement candle (body ${dispMult(i - 1).toFixed(1)}x the 20-bar median). Sell limit at ${rnd2(entry)} — the 50% consequent-encroachment level — invalid if price gaps above ${rnd2(invalidBeyond)} before filling.`,
              tp1Anchor: t.tp1Anchor, tp2Anchor: t.tp2Anchor,
              slAnchor: `1 tick above candle 1's high ${rnd2(c1.high)}`,
              refs: { gapLo: c.high, gapHi: c1.low, gapCe: rnd2(gapCe), bprFib: rnd2(bprFib), c1High: c1.high, c2Low: c2.low, dispMult: rnd2(dispMult(i - 1)) },
            });
          }
        }
      }
      if (fvgRegistry.length > 100) fvgRegistry.splice(0, fvgRegistry.length - 100);
    }

    // (f) ICT-OB / ICT-MITIGATION: displacement candle → find the OB candle → qualify.
    if (warm && displacement(i) && (enabled.has("ICT-OB") || enabled.has("ICT-MITIGATION"))) {
      const dir: IctDirection = isUp(c) ? "Long" : "Short";
      // last opposite-color candle before the move
      let obIdx = -1;
      for (let j = i - 1; j >= Math.max(0, i - K.OB_SEARCH_MAX_BARS); j--) {
        if (dir === "Long" ? isDown(cs[j]) : isUp(cs[j])) { obIdx = j; break; }
      }
      const used = dir === "Long" ? obUsedLong : obUsedShort;
      if (obIdx >= 0 && !used.has(obIdx)) {
        // (a) liquidity sweep within the last SWEEP_LOOKBACK_BARS
        const sweep = dir === "Long" ? lastLowSweep : lastHighSweep;
        const sweepOk = sweep !== null && i - sweep.barIdx <= K.SWEEP_LOOKBACK_BARS;
        // (b) market structure shift: bar i CLOSES through a still-intact opposing swing
        let broken: SwingPt | null = null;
        if (dir === "Long") {
          for (const s of structHighs) if (s.idx < i && c.close > s.price && (!broken || s.price > broken.price)) broken = s;
        } else {
          for (const s of structLows) if (s.idx < i && c.close < s.price && (!broken || s.price < broken.price)) broken = s;
        }
        const mssOk = broken !== null;
        const sweepTxt = sweep && sweepOk
          ? `price wicked ${dir === "Long" ? "below" : "above"} the resting level at ${rnd2(sweep.level)} and closed back ${dir === "Long" ? "above" : "below"} it ${i - sweep.barIdx === 0 ? "this bar" : `${i - sweep.barIdx} bar(s) ago`} (liquidity sweep)`
          : "";
        const brkTxt = broken
          ? `the displacement candle (body ${dispMult(i).toFixed(1)}x the 20-bar median) closed through the prior swing ${dir === "Long" ? "high" : "low"} at ${rnd2(broken.price)} (market structure shift)`
          : "";
        if (sweepOk && mssOk && enabled.has("ICT-OB") && cooled("ICT-OB", i)) {
          const ob = cs[obIdx];
          const ok = emitObLike("ICT-OB", dir, i, obIdx,
            `High-probability order block: ${sweepTxt}, then ${brkTxt}. The last ${dir === "Long" ? "down" : "up"} candle before that move is the order block — ${dir === "Long" ? "buy" : "sell"} limit at its open ${rnd2(ob.open)} (the change-in-state-of-delivery level), good for ${K.RETEST_WINDOW_BARS} bars.`,
            { sweptLevel: sweep!.level, sweepBarsAgo: i - sweep!.barIdx, brokenSwing: broken!.price, dispMult: rnd2(dispMult(i)) });
          if (ok) {
            used.add(obIdx);
            obRegistry.push({ dir, obIdx, obOpen: cs[obIdx].open, obHigh: cs[obIdx].high, obLow: cs[obIdx].low, emittedAtIdx: i });
          }
        } else if (!(sweepOk && mssOk) && enabled.has("ICT-MITIGATION") && cooled("ICT-MITIGATION", i)) {
          const missing = !sweepOk && !mssOk ? "a liquidity sweep or a structure break"
            : !sweepOk ? "a liquidity sweep" : "a structure break";
          const haveTxt = [sweepOk ? sweepTxt : "", mssOk ? brkTxt : ""].filter(Boolean).join("; ");
          const ob = cs[obIdx];
          const ok = emitObLike("ICT-MITIGATION", dir, i, obIdx,
            `Mitigation block (the article's lower-probability order block): a displacement candle (body ${dispMult(i).toFixed(1)}x the 20-bar median) with a ${dir === "Long" ? "down" : "up"} candle before it, but WITHOUT ${missing}${haveTxt ? ` (it did have: ${haveTxt})` : ""}. ${dir === "Long" ? "Buy" : "Sell"} limit at the block's open ${rnd2(ob.open)}.`,
            { dispMult: rnd2(dispMult(i)), hadSweep: sweepOk ? 1 : 0, hadMss: mssOk ? 1 : 0 });
          if (ok) used.add(obIdx);
        }
      }
    }

    // (g) ICT-MSS: sweep + displacement through opposing structure → OTE retracement limit.
    if (warm && enabled.has("ICT-MSS") && displacement(i) && cooled("ICT-MSS", i)) {
      const dir: IctDirection = isUp(c) ? "Long" : "Short";
      const sweep = dir === "Long" ? lastLowSweep : lastHighSweep;
      if (sweep && i - sweep.barIdx <= K.SWEEP_LOOKBACK_BARS) {
        let broken: SwingPt | null = null;
        if (dir === "Long") {
          for (const s of structHighs) if (s.idx < i && c.close > s.price && (!broken || s.price > broken.price)) broken = s;
        } else {
          for (const s of structLows) if (s.idx < i && c.close < s.price && (!broken || s.price < broken.price)) broken = s;
        }
        if (broken) {
          let legLo = Infinity, legHi = -Infinity;
          for (let j = sweep.barIdx; j <= i; j++) { legLo = Math.min(legLo, cs[j].low); legHi = Math.max(legHi, cs[j].high); }
          const leg = legHi - legLo;
          if (leg >= K.TICK * 4) {
            if (dir === "Long") {
              const entry = legHi - K.OTE_MIN_RETRACE * leg;
              const stop = legLo - STOP_BUFFER_PTS;
              const risk = entry - stop;
              if (entry <= c.close - K.TICK && risk >= K.TICK) {
                const t = targetsFor(entry, risk, "Long");
                emit({
                  strategy: "ICT-MSS", direction: "Long", interval, setupIdx: i, setupTime: c.time, barCloseTs: closeTs,
                  entryKind: "limit", entry: rnd2(entry), stop: rnd2(stop), tp1: t.tp1, tp2: t.tp2,
                  why: `Market structure shift: after the liquidity sweep at ${rnd2(sweep.level)} (${i - sweep.barIdx} bar(s) ago), a displacement candle (body ${dispMult(i).toFixed(1)}x the 20-bar median) closed through the prior swing high at ${rnd2(broken.price)}. Buy limit in the optimal-trade-entry zone at ${rnd2(entry)} (${Math.round(K.OTE_MIN_RETRACE * 100)}% retracement of the ${rnd2(legLo)}→${rnd2(legHi)} leg).`,
                  tp1Anchor: t.tp1Anchor, tp2Anchor: t.tp2Anchor,
                  slAnchor: `1 tick below the leg origin ${rnd2(legLo)}`,
                  refs: { legLo, legHi, sweptLevel: sweep.level, brokenSwing: broken.price, dispMult: rnd2(dispMult(i)) },
                });
              }
            } else {
              const entry = legLo + K.OTE_MIN_RETRACE * leg;
              const stop = legHi + STOP_BUFFER_PTS;
              const risk = stop - entry;
              if (entry >= c.close + K.TICK && risk >= K.TICK) {
                const t = targetsFor(entry, risk, "Short");
                emit({
                  strategy: "ICT-MSS", direction: "Short", interval, setupIdx: i, setupTime: c.time, barCloseTs: closeTs,
                  entryKind: "limit", entry: rnd2(entry), stop: rnd2(stop), tp1: t.tp1, tp2: t.tp2,
                  why: `Market structure shift: after the liquidity sweep at ${rnd2(sweep.level)} (${i - sweep.barIdx} bar(s) ago), a displacement candle (body ${dispMult(i).toFixed(1)}x the 20-bar median) closed through the prior swing low at ${rnd2(broken.price)}. Sell limit in the optimal-trade-entry zone at ${rnd2(entry)} (${Math.round(K.OTE_MIN_RETRACE * 100)}% retracement of the ${rnd2(legHi)}→${rnd2(legLo)} leg).`,
                  tp1Anchor: t.tp1Anchor, tp2Anchor: t.tp2Anchor,
                  slAnchor: `1 tick above the leg origin ${rnd2(legHi)}`,
                  refs: { legLo, legHi, sweptLevel: sweep.level, brokenSwing: broken.price, dispMult: rnd2(dispMult(i)) },
                });
              }
            }
          }
        }
      }
    }

    // (h) ICT-CE: long-wick candle at/near a pivot → limit at the wick's 50%.
    if (warm && enabled.has("ICT-CE") && cooled("ICT-CE", i) && isFinite(medRange[i])) {
      const b = bodies[i];
      const loWick = Math.min(c.open, c.close) - c.low;
      const hiWick = c.high - Math.max(c.open, c.close);
      // 20-bar extreme test (bar i makes the extreme itself — knowable at bar i, no lookahead)
      let minLow = Infinity, maxHigh = -Infinity;
      for (let j = Math.max(0, i - K.CE_PIVOT_LOOKBACK_BARS); j < i; j++) {
        minLow = Math.min(minLow, cs[j].low); maxHigh = Math.max(maxHigh, cs[j].high);
      }
      const nearSwingLow = liqLows.some(s => Math.abs(c.low - s.price) <= K.CE_PIVOT_TOL_PTS)
        || sweptLowPricesThisBar.some(p => Math.abs(c.low - p) <= K.CE_PIVOT_TOL_PTS);
      const nearSwingHigh = liqHighs.some(s => Math.abs(c.high - s.price) <= K.CE_PIVOT_TOL_PTS)
        || sweptHighPricesThisBar.some(p => Math.abs(c.high - p) <= K.CE_PIVOT_TOL_PTS);
      if (loWick >= K.CE_WICK_BODY_MULT * b && loWick >= K.CE_WICK_RANGE_MULT * medRange[i]
        && (c.low <= minLow || nearSwingLow)) {
        const entry = (c.low + Math.min(c.open, c.close)) / 2;
        const stop = c.low - STOP_BUFFER_PTS;
        const risk = entry - stop;
        if (entry <= c.close - K.TICK && risk >= K.TICK) {
          const t = targetsFor(entry, risk, "Long");
          const at = c.low <= minLow ? `a fresh ${K.CE_PIVOT_LOOKBACK_BARS}-bar low` : "a resting swing low";
          emit({
            strategy: "ICT-CE", direction: "Long", interval, setupIdx: i, setupTime: c.time, barCloseTs: closeTs,
            entryKind: "limit", entry: rnd2(entry), stop: rnd2(stop), tp1: t.tp1, tp2: t.tp2,
            why: `Long lower wick of ${rnd2(loWick)} pts (${b > 0 ? (loWick / b).toFixed(1) : "99"}x the candle body, ${(loWick / medRange[i]).toFixed(1)}x the 20-bar median range) rejected ${at}. Buy limit at the wick's 50% level — its consequent encroachment — at ${rnd2(entry)}.`,
            tp1Anchor: t.tp1Anchor, tp2Anchor: t.tp2Anchor,
            slAnchor: `1 tick below the wick extreme ${rnd2(c.low)}`,
            refs: { wickPts: rnd2(loWick), bodyPts: rnd2(b), wickLow: c.low, medRange: rnd2(medRange[i]) },
          });
        }
      } else if (hiWick >= K.CE_WICK_BODY_MULT * b && hiWick >= K.CE_WICK_RANGE_MULT * medRange[i]
        && (c.high >= maxHigh || nearSwingHigh)) {
        const entry = (c.high + Math.max(c.open, c.close)) / 2;
        const stop = c.high + STOP_BUFFER_PTS;
        const risk = stop - entry;
        if (entry >= c.close + K.TICK && risk >= K.TICK) {
          const t = targetsFor(entry, risk, "Short");
          const at = c.high >= maxHigh ? `a fresh ${K.CE_PIVOT_LOOKBACK_BARS}-bar high` : "a resting swing high";
          emit({
            strategy: "ICT-CE", direction: "Short", interval, setupIdx: i, setupTime: c.time, barCloseTs: closeTs,
            entryKind: "limit", entry: rnd2(entry), stop: rnd2(stop), tp1: t.tp1, tp2: t.tp2,
            why: `Long upper wick of ${rnd2(hiWick)} pts (${b > 0 ? (hiWick / b).toFixed(1) : "99"}x the candle body, ${(hiWick / medRange[i]).toFixed(1)}x the 20-bar median range) rejected ${at}. Sell limit at the wick's 50% level — its consequent encroachment — at ${rnd2(entry)}.`,
            tp1Anchor: t.tp1Anchor, tp2Anchor: t.tp2Anchor,
            slAnchor: `1 tick above the wick extreme ${rnd2(c.high)}`,
            refs: { wickPts: rnd2(hiWick), bodyPts: rnd2(b), wickHigh: c.high, medRange: rnd2(medRange[i]) },
          });
        }
      }
    }

    // (i) ICT-BREAKER: a registered high-probability OB fails (close through its far side)
    //     → flip direction, limit back at the failed block's open.
    if (enabled.has("ICT-BREAKER") || obRegistry.length) {
      for (let x = obRegistry.length - 1; x >= 0; x--) {
        const ob = obRegistry[x];
        if (i - ob.emittedAtIdx > K.OB_FAIL_WINDOW_BARS) { obRegistry.splice(x, 1); continue; }
        const failed = ob.dir === "Long" ? c.close < ob.obLow : c.close > ob.obHigh;
        if (!failed) continue;
        obRegistry.splice(x, 1);
        if (!warm || !enabled.has("ICT-BREAKER") || !cooled("ICT-BREAKER", i)) continue;
        const dir: IctDirection = ob.dir === "Long" ? "Short" : "Long"; // trade the flip
        const zLo = ob.obLow, zHi = ob.obHigh;
        const unicorn = fvgRegistry.some(f =>
          f.dir === dir && i - f.formIdx <= K.UNICORN_FVG_LOOKBACK_BARS &&
          Math.max(f.lo, zLo) <= Math.min(f.hi, zHi));
        const entry = ob.obOpen;
        const stop = dir === "Short" ? zHi + STOP_BUFFER_PTS : zLo - STOP_BUFFER_PTS;
        const risk = Math.abs(entry - stop);
        const sane = dir === "Short" ? entry >= c.close + K.TICK : entry <= c.close - K.TICK;
        if (!sane || risk < K.TICK) continue;
        const t = targetsFor(entry, risk, dir);
        emit({
          strategy: "ICT-BREAKER", direction: dir, interval, setupIdx: i, setupTime: c.time, barCloseTs: closeTs,
          entryKind: "limit", entry: rnd2(entry), stop: rnd2(stop), tp1: t.tp1, tp2: t.tp2,
          unicorn,
          why: `Breaker: the high-probability ${ob.dir === "Long" ? "bullish" : "bearish"} order block from ${i - ob.emittedAtIdx} bar(s) earlier FAILED — this candle closed ${ob.dir === "Long" ? "below its low" : "above its high"} at ${rnd2(ob.dir === "Long" ? zLo : zHi)}. The block flips to ${dir === "Short" ? "resistance" : "support"}: ${dir === "Short" ? "sell" : "buy"} limit back at its open ${rnd2(entry)}.${unicorn ? " A same-direction fair value gap overlaps the breaker zone — the higher-odds 'Unicorn' combination." : ""}`,
          tp1Anchor: t.tp1Anchor, tp2Anchor: t.tp2Anchor,
          slAnchor: dir === "Short" ? `1 tick above the breaker high ${rnd2(zHi)}` : `1 tick below the breaker low ${rnd2(zLo)}`,
          refs: { obIdx: ob.obIdx, obOpen: ob.obOpen, obHigh: zHi, obLow: zLo, failBarsAfterOb: i - ob.emittedAtIdx, unicorn: unicorn ? 1 : 0 },
        });
      }
    }

    // (j) Structure consumption: closes through remaining swing levels break structure.
    for (let x = structHighs.length - 1; x >= 0; x--) if (c.close > structHighs[x].price) structHighs.splice(x, 1);
    for (let x = structLows.length - 1; x >= 0; x--) if (c.close < structLows[x].price) structLows.splice(x, 1);
  }

  return out;

  // ── ICT-SWEEP emission helper (market entry at the confirming candle's close) ──
  function emitSweep(
    dir: IctDirection, i: number, level: number, opposite: number, kind: string, extreme: number, when: string,
  ): void {
    const c = cs[i];
    const entry = c.close;
    const stop = dir === "Short" ? extreme + STOP_BUFFER_PTS : extreme - STOP_BUFFER_PTS;
    const risk = Math.abs(entry - stop);
    if (risk < K.TICK) return;
    const sgn = dir === "Long" ? 1 : -1;
    const rrTp = entry + sgn * K.TP_RR_CAP * risk;
    const oppOk = dir === "Long" ? opposite >= entry + K.MIN_POOL_DIST_PTS : opposite <= entry - K.MIN_POOL_DIST_PTS;
    const mid = (level + opposite) / 2;
    const midOk = dir === "Long" ? mid >= entry + K.MIN_POOL_DIST_PTS : mid <= entry - K.MIN_POOL_DIST_PTS;
    let tp1: number, tp2: number, tp1Anchor: string, tp2Anchor: string;
    if (oppOk) {
      tp2 = opposite; tp2Anchor = `the opposite side of the swept range at ${rnd2(opposite)}`;
      if (midOk) {
        const midCloser = dir === "Long" ? mid < rrTp : mid > rrTp;
        tp1 = midCloser ? mid : rrTp;
        tp1Anchor = midCloser ? `the swept range's midpoint ${rnd2(mid)}` : `${K.TP_RR_CAP}R cap (range midpoint ${rnd2(mid)} sits beyond it)`;
      } else { tp1 = rrTp; tp1Anchor = `${K.TP_RR_CAP}R (range midpoint is behind the entry)`; }
      // TP1 must not sit beyond TP2
      if (dir === "Long" ? tp1 > tp2 : tp1 < tp2) { tp1 = tp2; tp1Anchor = tp2Anchor; }
    } else {
      tp1 = rrTp; tp2 = entry + sgn * K.TP2_FALLBACK_RR * risk;
      tp1Anchor = `${K.TP_RR_CAP}R cap (no usable opposite side)`; tp2Anchor = "twice the TP1 distance (no usable opposite side)";
    }
    emit({
      strategy: "ICT-SWEEP", direction: dir, interval, setupIdx: i, setupTime: c.time, barCloseTs: c.time + barSec,
      entryKind: "market", entry: rnd2(entry), stop: rnd2(stop), tp1: rnd2(tp1), tp2: rnd2(tp2),
      why: `Turtle soup: a wick took out the ${kind} at ${rnd2(level)}, then ${when} closed back ${dir === "Short" ? "below" : "above"} it with displacement (body ${dispMult(i).toFixed(1)}x the 20-bar median). ${dir === "Short" ? "Sell" : "Buy"} at the close ${rnd2(entry)}.`,
      tp1Anchor, tp2Anchor,
      slAnchor: `1 tick beyond the sweep extreme ${rnd2(extreme)}`,
      refs: { sweptLevel: level, sweepExtreme: extreme, opposite, dispMult: rnd2(dispMult(i)) },
    });
  }
}

// ─────────────────────── CALLER-SIDE HELPERS (not the engine pass) ───────────────────────

/** ICT KILL ZONES (ET wall-clock windows; names are the user-facing flags carried in
 *  fact notes). Windows follow the common ICT convention; only NY-AM / NY-PM can
 *  appear on RTH facts (corroborator facts are RTH-only in the fact engine). */
export const ICT_KILL_ZONES: Array<{ name: string; fromMin: number; toMin: number }> = [
  { name: "Asia", fromMin: 20 * 60, toMin: 24 * 60 },        // 8:00 PM – midnight ET
  { name: "London", fromMin: 2 * 60, toMin: 5 * 60 },        // 2:00 – 5:00 AM ET
  { name: "NY-AM", fromMin: 8 * 60 + 30, toMin: 11 * 60 },   // 8:30 – 11:00 AM ET
  { name: "NY-PM", fromMin: 13 * 60 + 30, toMin: 16 * 60 },  // 1:30 – 4:00 PM ET
];

/** Kill-zone name for a unix-seconds timestamp, or null outside every zone. */
export function killZoneOf(epochSec: number): string | null {
  const p = etParts(epochSec);
  const mins = p.hh * 60 + p.mm;
  for (const z of ICT_KILL_ZONES) if (mins >= z.fromMin && mins < z.toMin) return z.name;
  return null;
}

/** Standard significant-level derivation from raw candles — the SAME rows
 *  scripts/ict-backtest.ts injects: per Globex session day (prior-day 6:00 PM ET →
 *  5:00 PM ET), the PRIOR day's full-session high/low + prior-day NY-session
 *  high/low (when distinct), and the CURRENT day's Asia (18:00–03:00 ET) and
 *  London (03:00–08:30 ET) window highs/lows, each armed only AFTER its window
 *  completes (no lookahead). Works on candles of any interval — session extremes
 *  are extremes; only bars straddling a window boundary blur slightly on coarse
 *  intervals. Used by shared/fact-engine.ts so live and backtest derive levels
 *  identically. */
export function deriveSessionLevels(candles: FiringCandle[]): LiquidityLevel[] {
  interface DayWin { dayHi: number; dayLo: number; asiaHi: number; asiaLo: number; lonHi: number; lonLo: number; nyHi: number; nyLo: number; hasAsia: boolean; hasLon: boolean; hasNy: boolean }
  const dayMap = new Map<string, DayWin>();
  const boundsCache = new Map<string, { start: number; asiaEnd: number; lonEnd: number; end: number }>();
  const boundsOf = (k: string): { start: number; asiaEnd: number; lonEnd: number; end: number } => {
    let b = boundsCache.get(k);
    if (!b) {
      b = {
        start: etWallToEpoch(priorCalendarDay(k), 18, 0),
        asiaEnd: etWallToEpoch(k, 3, 0),
        lonEnd: etWallToEpoch(k, 8, 30),
        end: etWallToEpoch(k, 17, 0),
      };
      boundsCache.set(k, b);
    }
    return b;
  };
  for (const c of candles) {
    const k = sessionDayKey(c.time);
    let d = dayMap.get(k);
    if (!d) { d = { dayHi: -Infinity, dayLo: Infinity, asiaHi: -Infinity, asiaLo: Infinity, lonHi: -Infinity, lonLo: Infinity, nyHi: -Infinity, nyLo: Infinity, hasAsia: false, hasLon: false, hasNy: false }; dayMap.set(k, d); }
    d.dayHi = Math.max(d.dayHi, c.high); d.dayLo = Math.min(d.dayLo, c.low);
    const b = boundsOf(k);
    if (c.time < b.asiaEnd) { d.asiaHi = Math.max(d.asiaHi, c.high); d.asiaLo = Math.min(d.asiaLo, c.low); d.hasAsia = true; }
    else if (c.time < b.lonEnd) { d.lonHi = Math.max(d.lonHi, c.high); d.lonLo = Math.min(d.lonLo, c.low); d.hasLon = true; }
    else { d.nyHi = Math.max(d.nyHi, c.high); d.nyLo = Math.min(d.nyLo, c.low); d.hasNy = true; }
  }
  const keys = [...dayMap.keys()].sort();
  const levels: LiquidityLevel[] = [];
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i], prev = dayMap.get(keys[i - 1])!, cur = dayMap.get(k)!;
    const b = boundsOf(k);
    levels.push({ price: prev.dayHi, opposite: prev.dayLo, kind: "prior-day high", isHigh: true, activeFromTs: b.start, activeToTs: b.end });
    levels.push({ price: prev.dayLo, opposite: prev.dayHi, kind: "prior-day low", isHigh: false, activeFromTs: b.start, activeToTs: b.end });
    if (prev.hasNy && prev.nyHi < prev.dayHi) levels.push({ price: prev.nyHi, opposite: prev.nyLo, kind: "prior-day NY session high", isHigh: true, activeFromTs: b.start, activeToTs: b.end });
    if (prev.hasNy && prev.nyLo > prev.dayLo) levels.push({ price: prev.nyLo, opposite: prev.nyHi, kind: "prior-day NY session low", isHigh: false, activeFromTs: b.start, activeToTs: b.end });
    if (cur.hasAsia) {
      levels.push({ price: cur.asiaHi, opposite: cur.asiaLo, kind: "Asia session high", isHigh: true, activeFromTs: b.asiaEnd, activeToTs: b.end });
      levels.push({ price: cur.asiaLo, opposite: cur.asiaHi, kind: "Asia session low", isHigh: false, activeFromTs: b.asiaEnd, activeToTs: b.end });
    }
    if (cur.hasLon) {
      levels.push({ price: cur.lonHi, opposite: cur.lonLo, kind: "London session high", isHigh: true, activeFromTs: b.lonEnd, activeToTs: b.end });
      levels.push({ price: cur.lonLo, opposite: cur.lonHi, kind: "London session low", isHigh: false, activeFromTs: b.lonEnd, activeToTs: b.end });
    }
  }
  levels.sort((a, b) => a.activeFromTs - b.activeFromTs);
  return levels;
}
