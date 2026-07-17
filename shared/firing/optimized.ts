// shared/firing/optimized.ts — THE PROGRAM STRATEGY (optimized 2026-07-16/17)
// ─────────────────────────────────────────────────────────────────────────────
// Winner of a 480-configuration train/test grid search over every combination
// of the strategy components (Vector / Yellow Box / ICT Zones / Candle Body /
// Footprint) × interval × session × exit parameters on 1 month of MES data,
// selected on a 21-day train window and validated on an untouched 9-day test
// window. See LEARNINGS.md 2026-07-16/17 entries.
//
// ENTRY RULE (both directions):
//   An RTH candle tests-and-holds an ICT zone (Fair Value Gap / Order Block /
//   structural swing level, ±2 pts) AND closes in the trade direction.
//   No vector gate, no footprint gate.
//
// The strategy trades TWO intervals, each with grid-calibrated exits — NEVER
// share exit parameters across intervals (15m exits on 5m bars: +56 pts @ 34.9%
// vs the calibrated 5m exits: +332 pts @ 58.3%):
//   15m: TP1 +8 / TP2 +16 / SL −4  → +412 pts @ 52.5% WR on the benchmark month
//   5m:  TP1 +4 / TP2 +8  / SL −4  → +332 pts @ 58.3% WR (test window 60.7%)
//
// Baseline risk filters always on: 10-bar per-direction cooldown, HOD long
// suppression (5 pts, pre-bar HOD), 60m declining-vector long veto, CME
// settlement-break skip, day-trade session-settle exits.
//
// Per shared/firing rules: NO React / DOM / chart imports. Deterministic when
// nowSec is injected. Closed-candle discipline is the caller's responsibility
// (pass completed bars; the forming bar's signal settles at bar close).

// ── Types ─────────────────────────────────────────────────────────────────────
export interface OptCandle {
  time: number; open: number; high: number; low: number; close: number;
  volume?: number; rth?: boolean;
}

export interface OptZone {
  topPrice: number; bottomPrice: number; color: string; label?: string;
  fromTime?: number; toTime?: number;
}

export type OptimizedInterval = "5m" | "15m";
export type OptOutcome = "win_tp1" | "win_tp2" | "loss" | "open";

export interface OptimizedSignal {
  time: number;
  direction: "Long" | "Short";
  price: number;       // entry = signal candle close
  high: number; low: number;
  tier: "safe" | "risky";   // safe = zone-confirmed (always true here: zone is a hard gate)
  tp1: number; tp2: number; sl: number;
  outcome: OptOutcome;
  toTime: number;      // exit bar time (or session settle while open)
  milkOk: boolean;     // ICT zone confirmation (hard gate → always true)
  interval: OptimizedInterval;
}

export interface OptExitLevels { tp1: number; tp2: number; sl: number }

// ── Strategy constants ────────────────────────────────────────────────────────
export const OPTIMIZED_ZONE_TOLERANCE = 2.0;   // pts — zone test-and-hold tolerance
export const OPTIMIZED_COOLDOWN_BARS  = 10;    // per-direction signal cooldown
export const OPTIMIZED_VEC_LENGTH     = 20;    // HL20 vector (60m veto only)

export const OPTIMIZED_EXITS_BY_INTERVAL: Record<OptimizedInterval, OptExitLevels> = {
  "15m": { tp1: 8, tp2: 16, sl: 4 },
  "5m":  { tp1: 4, tp2: 8,  sl: 4 },
};

export const OPTIMIZED_INTERVALS: ReadonlyArray<{ sec: number; label: OptimizedInterval }> = [
  { sec: 300, label: "5m" },
  { sec: 900, label: "15m" },
];

// ── Session helpers ───────────────────────────────────────────────────────────
export function optIsRTH(ts: number): boolean {
  const d = new Date(ts * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins < 20 * 60; // 9:30 AM – 4:00 PM ET
}

export function optSettleOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 20 * 3600 + 30 * 60; // 20:30 UTC
}

// ── Aggregation ───────────────────────────────────────────────────────────────
export function optAggregate(candles: OptCandle[], intervalSec: number): OptCandle[] {
  if (!candles.length) return [];
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const buckets = new Map<number, OptCandle>();
  for (const c of sorted) {
    const t = Math.floor(c.time / intervalSec) * intervalSec;
    const b = buckets.get(t);
    if (!b) buckets.set(t, { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, rth: optIsRTH(t) });
    else {
      b.high = Math.max(b.high, c.high);
      b.low  = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume = (b.volume ?? 0) + (c.volume ?? 0);
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

// ── Vector: Highest(Lowest(low,20),20) on ALL bars — used ONLY for the 60m veto ──
function computeVectorMap(candles: OptCandle[]): Map<number, number> {
  const s = candles; // caller passes sorted
  const n = s.length;
  const lb = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let lo = s[i].low;
    for (let j = Math.max(0, i - OPTIMIZED_VEC_LENGTH + 1); j < i; j++) if (s[j].low < lo) lo = s[j].low;
    lb[i] = lo;
  }
  const map = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    let hi = lb[i];
    for (let j = Math.max(0, i - OPTIMIZED_VEC_LENGTH + 1); j < i; j++) if (lb[j] > hi) hi = lb[j];
    map.set(s[i].time, hi);
  }
  return map;
}

// ── ICT zone detection (FVG / Order Block / structural swing levels) ──────────
export const optIsBullZone = (z: OptZone): boolean =>
  z.color === "#22c55e" || z.color === "#3b82f6" || z.color === "#14b8a6";

export function detectOptIctZones(candles: OptCandle[]): OptZone[] {
  const rth = [...candles].sort((a, b) => a.time - b.time).filter(c => c.rth !== false);
  const zones: OptZone[] = [];

  const lastRthBarBefore430 = new Map<number, number>();
  for (const c of rth) {
    if (c.time % 86400 >= 20 * 3600 + 30 * 60) continue;
    lastRthBarBefore430.set(Math.floor(c.time / 86400), c.time);
  }
  const sessionEndOf = (ts: number) =>
    lastRthBarBefore430.get(Math.floor(ts / 86400)) ?? optSettleOfDay(ts);

  const atrAt = (i: number) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - 13); j <= i; j++) {
      const b = rth[j], p = j > 0 ? rth[j - 1] : b;
      s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
      n++;
    }
    return n > 0 ? s / n : 2;
  };

  for (let i = 1; i < rth.length - 1; i++) {
    const prev = rth[i - 1], curr = rth[i], next = rth[i + 1];
    const atr  = atrAt(i);

    // Fair Value Gaps
    if (prev.high < next.low && next.low - prev.high >= 0.5)
      zones.push({ topPrice: next.low, bottomPrice: prev.high, color: "#22c55e", label: "IMBALANCE", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    if (prev.low > next.high && prev.low - next.high >= 0.5)
      zones.push({ topPrice: prev.low, bottomPrice: next.high, color: "#ef4444", label: "RESIST IMBALANCE", fromTime: curr.time, toTime: sessionEndOf(curr.time) });

    // Order Blocks
    if (curr.close < curr.open) {
      let maxUp = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++) maxUp = Math.max(maxUp, rth[j].high - curr.high);
      if (maxUp >= atr * 1.5)
        zones.push({ topPrice: Math.max(curr.open, curr.close), bottomPrice: curr.low, color: "#3b82f6", label: "ABSORPTION", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    }
    if (curr.close > curr.open) {
      let maxDown = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++) maxDown = Math.max(maxDown, curr.low - rth[j].low);
      if (maxDown >= atr * 1.5)
        zones.push({ topPrice: curr.high, bottomPrice: Math.min(curr.open, curr.close), color: "#f97316", label: "RESISTIVE", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    }

    // Structural swing highs/lows
    const LB = 3, sz = Math.max(atr * 0.25, 1.5);
    let isHigh = true, isLow = true;
    for (let j = Math.max(0, i - LB); j < i; j++) { if (rth[j].high >= curr.high) isHigh = false; if (rth[j].low <= curr.low) isLow = false; }
    for (let j = i + 1; j <= Math.min(rth.length - 1, i + LB); j++) { if (rth[j].high >= curr.high) isHigh = false; if (rth[j].low <= curr.low) isLow = false; }
    if (isHigh) zones.push({ topPrice: curr.high + sz * 0.15, bottomPrice: curr.high - sz, color: "#f43f5e", label: "STRUCTURAL RESIST", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    if (isLow)  zones.push({ topPrice: curr.low + sz, bottomPrice: curr.low - sz * 0.15, color: "#14b8a6", label: "STRUCTURAL SUPPORT", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
  }
  return zones;
}

// ── Walk-forward outcome (day-trade: resolves by session settle) ──────────────
function walkForward(
  sorted: OptCandle[], startIdx: number,
  tp1: number, tp2: number, sl: number, isLong: boolean, nowSec: number,
): { outcome: OptOutcome; toTime: number } {
  const c = sorted[startIdx];
  let settleTs = optSettleOfDay(c.time);
  for (let d = 0; c.time >= settleTs && d < 4; d++) settleTs = optSettleOfDay(c.time + (d + 1) * 86400);
  const pastEnd = nowSec > settleTs;
  for (let j = startIdx + 1; j < sorted.length; j++) {
    const f = sorted[j];
    if (f.time > settleTs) break;
    if (isLong) {
      if (f.high >= tp2) return { outcome: "win_tp2", toTime: f.time };
      if (f.high >= tp1) return { outcome: "win_tp1", toTime: f.time };
      if (f.low  <= sl)  return { outcome: "loss",    toTime: f.time };
    } else {
      if (f.low  <= tp2) return { outcome: "win_tp2", toTime: f.time };
      if (f.low  <= tp1) return { outcome: "win_tp1", toTime: f.time };
      if (f.high >= sl)  return { outcome: "loss",    toTime: f.time };
    }
  }
  return { outcome: pastEnd ? "loss" : "open", toTime: settleTs };
}

// ── Core engine: one interval ─────────────────────────────────────────────────
/** `candles` must be at `interval` resolution or FINER (5m bars for the 5m
 *  component; 5m or 15m bars for the 15m component). Aggregation is idempotent
 *  for matching input. Never pass coarser bars (60m cannot be disaggregated). */
export function computeOptimizedSignalsForInterval(
  candles: OptCandle[],
  interval: OptimizedInterval,
  nowSec: number = Math.floor(Date.now() / 1000),
): OptimizedSignal[] {
  if (!candles.length) return [];
  const ivSec  = interval === "5m" ? 300 : 900;
  const exits  = OPTIMIZED_EXITS_BY_INTERVAL[interval];
  const sorted = optAggregate(candles, ivSec);
  const zones  = detectOptIctZones(sorted);

  // Index zones by UTC day (all detected zones are same-day) for fast lookups
  const zonesByDay = new Map<number, OptZone[]>();
  for (const z of zones) {
    const dk = Math.floor((z.fromTime ?? 0) / 86400);
    let arr = zonesByDay.get(dk);
    if (!arr) zonesByDay.set(dk, arr = []);
    arr.push(z);
  }

  // 60m declining-vector veto for Longs
  const candles60m = optAggregate(sorted, 3600);
  const vec60mMap  = computeVectorMap(candles60m);
  const vec60mDecline = new Map<number, boolean>();
  let prev60m: number | null = null;
  for (const c of candles60m) {
    const v = vec60mMap.get(c.time);
    if (v != null) {
      vec60mDecline.set(c.time, prev60m !== null && v < prev60m);
      prev60m = v;
    }
  }
  const is60mDeclining = (ts: number) => vec60mDecline.get(Math.floor(ts / 3600) * 3600) ?? false;

  // Pre-bar HOD per day for Long suppression
  const hodBeforeBar = new Map<number, number>();
  const hodRunning   = new Map<number, number>();
  for (const c of sorted) {
    if (!optIsRTH(c.time)) continue;
    const dk = Math.floor(c.time / 86400);
    const prevHod = hodRunning.get(dk) ?? -Infinity;
    hodBeforeBar.set(c.time, prevHod);
    hodRunning.set(dk, Math.max(prevHod, c.high));
  }

  const TOL = OPTIMIZED_ZONE_TOLERANCE;
  const signals: OptimizedSignal[] = [];
  let lastLongBar = -OPTIMIZED_COOLDOWN_BARS, lastShortBar = -OPTIMIZED_COOLDOWN_BARS;

  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    if (!optIsRTH(c.time)) continue;                       // RTH-only strategy
    const utcH = new Date(c.time * 1000).getUTCHours();
    if (utcH >= 20 && utcH < 22) continue;                 // CME settlement break

    const zonesHere = zonesByDay.get(Math.floor(c.time / 86400)) ?? [];
    const bullOk = zonesHere.some(z =>
      optIsBullZone(z) && c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity) &&
      c.low <= z.topPrice + TOL && c.close >= z.bottomPrice - TOL);
    const bearOk = zonesHere.some(z =>
      !optIsBullZone(z) && c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity) &&
      c.high >= z.bottomPrice - TOL && c.close <= z.topPrice + TOL);

    const prevHod = hodBeforeBar.get(c.time) ?? -Infinity;
    const nearHodLong = prevHod > -Infinity && c.close < prevHod && c.close >= prevHod - 5;

    // LONG: zone test-and-hold + bullish close (+ risk filters + cooldown)
    if (bullOk && c.close >= c.open && i - lastLongBar >= OPTIMIZED_COOLDOWN_BARS && !nearHodLong && !is60mDeclining(c.time)) {
      lastLongBar = i;
      const tp1 = c.close + exits.tp1, tp2 = c.close + exits.tp2, sl = c.close - exits.sl;
      const { outcome, toTime } = walkForward(sorted, i, tp1, tp2, sl, true, nowSec);
      signals.push({ time: c.time, direction: "Long", price: c.close, high: c.high, low: c.low, tier: "safe", tp1, tp2, sl, outcome, toTime, milkOk: true, interval });
    }
    // SHORT: zone test-and-hold + bearish close (+ cooldown)
    if (bearOk && c.close <= c.open && i - lastShortBar >= OPTIMIZED_COOLDOWN_BARS) {
      lastShortBar = i;
      const tp1 = c.close - exits.tp1, tp2 = c.close - exits.tp2, sl = c.close + exits.sl;
      const { outcome, toTime } = walkForward(sorted, i, tp1, tp2, sl, false, nowSec);
      signals.push({ time: c.time, direction: "Short", price: c.close, high: c.high, low: c.low, tier: "safe", tp1, tp2, sl, outcome, toTime, milkOk: true, interval });
    }
  }
  return signals;
}

/** Both trading intervals merged chronologically. `candles` must be ≤5m bars. */
export function computeOptimizedSignals(
  candles: OptCandle[],
  nowSec: number = Math.floor(Date.now() / 1000),
): OptimizedSignal[] {
  if (!candles.length) return [];
  return OPTIMIZED_INTERVALS
    .flatMap(iv => computeOptimizedSignalsForInterval(candles, iv.label, nowSec))
    .sort((a, b) => a.time - b.time);
}
