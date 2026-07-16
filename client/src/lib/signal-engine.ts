// ── Shared signal engine ──────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for strategy signals. The Backtest page, the Market
// chart, and the Signals tab all call computeEngineSignals() so every surface
// shows the SAME EXACT signals. This logic was extracted verbatim from
// backtest.tsx runBacktest() — do not fork per-page copies again.
//
// Pure module: no React, no DOM. Also imported by scripts/generate-backtest-xlsx.ts.

import { buildProxyFootprintCandle, analyzeFootprint } from "./footprint-analysis";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface EngineCandle {
  time: number; open: number; high: number; low: number; close: number;
  volume?: number; rth?: boolean;
}

export interface EngineZone {
  topPrice: number; bottomPrice: number; color: string; label?: string;
  fromTime?: number; toTime?: number;
}

export type EngineTier    = "safe" | "risky";
export type EngineSession = "rth" | "eth";
export type EngineOutcome = "win_tp1" | "win_tp2" | "win_trailer" | "loss" | "open";
export type ExitKey       = "safe" | "risky" | "riskiest";

export interface ExitLevels { tp1Safe: number; tp1: number; tp2: number; sl: number }
export interface ExitProfile { rth: ExitLevels; eth: ExitLevels }

export interface EngineSignal {
  time: number;
  direction: "Long" | "Short";
  price: number;       // entry = signal candle close
  high: number;        // signal candle high
  low: number;         // signal candle low
  tier: EngineTier;
  tp1: number; tp2: number; sl: number;
  outcome: EngineOutcome;
  toTime: number;      // exit bar time (or session settle when open)
  milkOk: boolean;     // zone confirmation present
  session: EngineSession;
}

/** Strategy-component gates. Defaults reproduce the Backtest page exactly.
 *  Used by the Excel backtest generator to isolate each strategy and build combos. */
export interface EngineGates {
  /** Primary vector hard gate (close vs HL20 vector + slope). Default true. */
  vector?: boolean;
  /** Milk zone handling: "tier" = zone upgrades Long tier & hard-gates Shorts (backtest
   *  behavior, default); "required" = zone confirmation required for BOTH directions;
   *  "off" = zones ignored entirely (tier is always "risky"). */
  zone?: "tier" | "required" | "off";
  /** Candle-body confirmation (bullish close for Longs, bearish for Shorts). Default true. */
  body?: boolean;
  /** Proxy-footprint delta agreement + divergence veto + exit adjustments. Default true. */
  footprint?: boolean;
}

// ── Constants (identical to backtest.tsx) ─────────────────────────────────────
export const VEC_LENGTH     = 20;
export const MILK_TOLERANCE = 2.0;
export const COOLDOWN_BARS  = 10;

export const EXIT_STRATEGY_PROFILES: Record<ExitKey, ExitProfile & { label: string; desc: string }> = {
  safe: {
    // FP-confirmed SAFE: ~73–78% WR → aggressive TP, tighter SL (POC stop enhances further)
    rth: { tp1Safe: 12.5, tp1: 10.0, tp2: 25.0, sl: 4.0 },
    eth: { tp1Safe:  7.5, tp1:  6.0, tp2: 15.0, sl: 3.0 },
    label: "Tight",    desc: "FP confirmed — 4pt SL · 25pt TP2",
  },
  risky: {
    // Standard exits for zone+secondary (no fp) signals: ~45–55% WR
    rth: { tp1Safe: 10.0, tp1:  8.0, tp2: 20.0, sl: 5.0 },
    eth: { tp1Safe:  6.0, tp1:  5.0, tp2: 12.0, sl: 3.5 },
    label: "Standard", desc: "Zone+secondary — 5pt SL · 20pt TP2",
  },
  riskiest: {
    // Wide swing exits — size very small; marginal fp-standalone signals
    rth: { tp1Safe: 20.0, tp1: 16.0, tp2: 40.0, sl: 10.0 },
    eth: { tp1Safe: 12.0, tp1: 10.0, tp2: 22.0, sl:  7.0 },
    label: "Wide",     desc: "Swing style — 10pt SL · 40pt TP2",
  },
};

// ── RTH helpers ───────────────────────────────────────────────────────────────
export function isRTH(ts: number): boolean {
  const d = new Date(ts * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins < 20 * 60; // 9:30 AM – 4:00 PM ET
}

export function rthSettleOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 20 * 3600 + 30 * 60;
}

// ── Interval aggregator ───────────────────────────────────────────────────────
export function aggregateToInterval(candles: EngineCandle[], intervalSec: number): EngineCandle[] {
  if (!candles.length) return [];
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const buckets = new Map<number, EngineCandle>();
  for (const c of sorted) {
    const t = Math.floor(c.time / intervalSec) * intervalSec;
    if (!buckets.has(t)) {
      buckets.set(t, { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, rth: isRTH(t) });
    } else {
      const b = buckets.get(t)!;
      b.high   = Math.max(b.high, c.high);
      b.low    = Math.min(b.low,  c.low);
      b.close  = c.close;
      b.volume = (b.volume ?? 0) + (c.volume ?? 0);
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

// ── Vector line: Highest(Lowest(low,20),20) on ALL bars (RTH+ETH) ─────────────
export function computeVectorLine(candles: EngineCandle[]): Map<number, number> {
  const s = [...candles].sort((a, b) => a.time - b.time);
  const n = s.length;
  const lb = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let lo = s[i].low;
    for (let j = Math.max(0, i - VEC_LENGTH + 1); j < i; j++) if (s[j].low < lo) lo = s[j].low;
    lb[i] = lo;
  }
  const map = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    let hi = lb[i];
    for (let j = Math.max(0, i - VEC_LENGTH + 1); j < i; j++) if (lb[j] > hi) hi = lb[j];
    map.set(s[i].time, hi);
  }
  return map;
}

// ── Zone detection (identical to backtest.tsx detectMilkZones) ────────────────
export function detectMilkZones(candles: EngineCandle[]): EngineZone[] {
  const rth = [...candles].sort((a, b) => a.time - b.time).filter(c => c.rth !== false);
  const zones: EngineZone[] = [];

  const lastRthBarBefore430 = new Map<number, number>();
  for (const c of rth) {
    if (c.time % 86400 >= 20 * 3600 + 30 * 60) continue;
    lastRthBarBefore430.set(Math.floor(c.time / 86400), c.time);
  }
  const sessionEndOf = (ts: number) =>
    lastRthBarBefore430.get(Math.floor(ts / 86400)) ?? rthSettleOfDay(ts);

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

    if (prev.high < next.low && next.low - prev.high >= 0.5)
      zones.push({ topPrice: next.low, bottomPrice: prev.high, color: "#22c55e", label: "IMBALANCE", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    if (prev.low > next.high && prev.low - next.high >= 0.5)
      zones.push({ topPrice: prev.low, bottomPrice: next.high, color: "#ef4444", label: "RESIST IMBALANCE", fromTime: curr.time, toTime: sessionEndOf(curr.time) });

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

    const LB = 3, sz = Math.max(atr * 0.25, 1.5);
    let isHigh = true, isLow = true;
    for (let j = Math.max(0, i - LB); j < i; j++) { if (rth[j].high >= curr.high) isHigh = false; if (rth[j].low <= curr.low) isLow = false; }
    for (let j = i + 1; j <= Math.min(rth.length - 1, i + LB); j++) { if (rth[j].high >= curr.high) isHigh = false; if (rth[j].low <= curr.low) isLow = false; }
    if (isHigh) zones.push({ topPrice: curr.high + sz * 0.15, bottomPrice: curr.high - sz, color: "#f43f5e", label: "STRUCTURAL RESIST", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    if (isLow)  zones.push({ topPrice: curr.low + sz, bottomPrice: curr.low - sz * 0.15, color: "#14b8a6", label: "STRUCTURAL SUPPORT", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
  }
  return zones;
}

export const isBullZone = (z: EngineZone): boolean =>
  z.color === "#22c55e" || z.color === "#3b82f6" || z.color === "#14b8a6";

// ── Yellow Box strategy (per-day, percentage-based) ───────────────────────────
// Implements Milk's Yellow Box spec (attached_assets/Pasted-Build-an-algorithm-…):
// for EACH trading day a fresh yellow box is drawn, centered on the day's
// OPENING price, with width = the average daily candle range (H−L) over the
// last 14 trading days. Support/resistance zones start a percentage distance
// away from the box edges, where the percentage is how far today's open moved
// from the previous day's open (raw_diff, floored at 0.1%).
export interface YellowBoxDay {
  dayKey: number;          // UTC day index (unix / 86400)
  open: number;            // day's opening price = yellow box center (POC)
  prevOpen: number;
  rawDiff: number;         // max(|open − prevOpen| / open, minRawDiff)
  avgRange: number;        // mean daily H−L over the lookback window
  yellowTop: number; yellowBottom: number;
  resistanceLevel: number; resistanceTop: number; resistanceBot: number;
  supportLevel: number;    supportTop: number;    supportBot: number;
  fromTime: number;        // first RTH bar of the day
  toTime: number;          // session settle (20:30 UTC)
}

export interface YellowBoxOptions {
  avgRangeLookback?: number;      // default 14 trading days
  zoneThicknessFraction?: number; // default 0.3
  minRawDiff?: number;            // default 0.001 (0.1%)
}

export function computeYellowBoxDays(candles: EngineCandle[], opts: YellowBoxOptions = {}): YellowBoxDay[] {
  const lookback  = opts.avgRangeLookback ?? 14;
  const thickFrac = opts.zoneThicknessFraction ?? 0.3;
  const minDiff   = opts.minRawDiff ?? 0.001;

  // Build daily OHLC from RTH bars (a "trading day" = the RTH session)
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const days = new Map<number, { open: number; high: number; low: number; firstTime: number }>();
  for (const c of sorted) {
    if (!isRTH(c.time)) continue;
    const dk = Math.floor(c.time / 86400);
    const d = days.get(dk);
    if (!d) days.set(dk, { open: c.open, high: c.high, low: c.low, firstTime: c.time });
    else { d.high = Math.max(d.high, c.high); d.low = Math.min(d.low, c.low); }
  }
  const dayList = [...days.entries()].sort((a, b) => a[0] - b[0]);
  const ranges  = dayList.map(([, d]) => d.high - d.low);

  const result: YellowBoxDay[] = [];
  // Spec: start from the THIRD trading day (needs prev open + range history)
  for (let i = 2; i < dayList.length; i++) {
    const [dayKey, d] = dayList[i];
    const prevOpen = dayList[i - 1][1].open;
    const open     = d.open;
    if (!(open > 0)) continue;

    const rawDiff  = Math.max(Math.abs(open - prevOpen) / open, minDiff);
    const rangeWin = ranges.slice(Math.max(0, i - lookback), i);
    const avgRange = rangeWin.reduce((a, b) => a + b, 0) / rangeWin.length;

    const yellowTop    = open + avgRange / 2;
    const yellowBottom = open - avgRange / 2;
    const pctDist      = rawDiff * open;
    const thickness    = pctDist * thickFrac;

    const rStart = yellowTop + pctDist;
    const sStart = yellowBottom - pctDist;

    result.push({
      dayKey, open, prevOpen, rawDiff, avgRange, yellowTop, yellowBottom,
      resistanceLevel: rStart, resistanceBot: rStart, resistanceTop: rStart + thickness,
      supportLevel: sStart,    supportTop: sStart,    supportBot: sStart - thickness,
      fromTime: d.firstTime,
      toTime: rthSettleOfDay(d.firstTime),
    });
  }
  return result;
}

/** Yellow Box SIGNAL zones: each day's support zone (bullish) and resistance
 *  zone (bearish). These replace the old milk zones as the program's zone
 *  confirmation source — "zone test and hold" semantics are unchanged. */
export function computeYellowBoxZones(candles: EngineCandle[], opts: YellowBoxOptions = {}): EngineZone[] {
  const zones: EngineZone[] = [];
  for (const yb of computeYellowBoxDays(candles, opts)) {
    zones.push({ topPrice: yb.supportTop,    bottomPrice: yb.supportBot,    color: "#22c55e", label: "YB SUPPORT", fromTime: yb.fromTime, toTime: yb.toTime });
    zones.push({ topPrice: yb.resistanceTop, bottomPrice: yb.resistanceBot, color: "#ef4444", label: "YB RESIST",  fromTime: yb.fromTime, toTime: yb.toTime });
  }
  return zones;
}

/** Yellow Box DISPLAY bands: the box itself plus its R/S zones, for chart overlays. */
export function computeYellowBoxDisplayBands(candles: EngineCandle[], opts: YellowBoxOptions = {}): EngineZone[] {
  const bands: EngineZone[] = [];
  for (const yb of computeYellowBoxDays(candles, opts)) {
    bands.push({ topPrice: yb.yellowTop,     bottomPrice: yb.yellowBottom,  color: "#eab308", label: "YELLOW BOX", fromTime: yb.fromTime, toTime: yb.toTime });
    bands.push({ topPrice: yb.supportTop,    bottomPrice: yb.supportBot,    color: "#22c55e", label: "YB SUPPORT", fromTime: yb.fromTime, toTime: yb.toTime });
    bands.push({ topPrice: yb.resistanceTop, bottomPrice: yb.resistanceBot, color: "#ef4444", label: "YB RESIST",  fromTime: yb.fromTime, toTime: yb.toTime });
  }
  return bands;
}

/** ICT zones — Fair Value Gaps, Order Blocks and structural swing levels.
 *  This is the original zone detector (previously called "milk zones"); it is
 *  kept as an explicit ICT strategy component for backtesting/combos. */
export const detectIctZones = detectMilkZones;

// ── Walk-forward outcome (identical rules to backtest.tsx btWalkForward) ──────
export function btWalkForward(
  sorted: EngineCandle[], startIdx: number,
  tp1: number, tp2: number, sl: number, isLong: boolean,
  nowSec: number = Math.floor(Date.now() / 1000),
): { outcome: EngineOutcome; toTime: number } {
  const c = sorted[startIdx];
  let settleTs = rthSettleOfDay(c.time);
  for (let d = 0; c.time >= settleTs && d < 4; d++) settleTs = rthSettleOfDay(c.time + (d + 1) * 86400);
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

// ── Signal engine ─────────────────────────────────────────────────────────────
// Extracted VERBATIM from backtest.tsx runBacktest()'s signal loop. With default
// gates the emitted signals are bit-identical to the Backtest page.
export function computeEngineSignals(
  candles: EngineCandle[],
  milkZones: EngineZone[] | EngineZone[][],
  profile: ExitProfile,
  session: EngineSession,
  gates: EngineGates = {},
  nowSec: number = Math.floor(Date.now() / 1000),
): EngineSignal[] {
  const gVector    = gates.vector    ?? true;
  const gZone      = gates.zone      ?? "tier";
  const gBody      = gates.body      ?? true;
  const gFootprint = gates.footprint ?? true;

  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const vecMap = computeVectorLine(sorted);

  // 60m vector for hard veto on Long signals (declining 60m = skip all longs per strategy)
  const candles60m  = aggregateToInterval(sorted, 3600);
  const vec60mMap   = computeVectorLine(candles60m);
  const vec60mDeclineMap = new Map<number, boolean>();
  const sorted60m = [...candles60m].sort((a, b) => a.time - b.time);
  let prev60mVec: number | null = null;
  for (const c of sorted60m) {
    const v = vec60mMap.get(c.time);
    if (v != null) {
      vec60mDeclineMap.set(c.time, prev60mVec !== null && v < prev60mVec);
      prev60mVec = v;
    }
  }
  function get60mDecline(ts: number): boolean {
    const bucket = Math.floor(ts / 3600) * 3600;
    return vec60mDeclineMap.get(bucket) ?? false;
  }

  // Pre-compute per-day HOD before each bar for HOD suppression
  const hodBeforeBar = new Map<number, number>();
  const hodRunning   = new Map<number, number>();
  for (const c of sorted) {
    if (!isRTH(c.time)) continue;
    const dayKey = Math.floor(c.time / 86400);
    const prevHod = hodRunning.get(dayKey) ?? -Infinity;
    hodBeforeBar.set(c.time, prevHod);
    hodRunning.set(dayKey, Math.max(prevHod, c.high));
  }

  // Zone SETS: the app passes one zone list; the combo backtester may pass
  // several (e.g. Yellow Box zones + ICT zones). In "required" mode EVERY set
  // must confirm independently; in "tier" mode ANY set confirming counts
  // (identical to the original single-list behavior).
  const zoneSets: EngineZone[][] =
    milkZones.length && Array.isArray(milkZones[0])
      ? (milkZones as EngineZone[][])
      : [milkZones as EngineZone[]];

  // Index each set's zones by UTC day for O(zonesPerDay) lookups. Zone detectors
  // only emit same-day zones; anything spanning multiple days (or open-ended)
  // falls back to a global list so the result is IDENTICAL to a linear scan —
  // just much faster, which matters when the Market chart re-runs the engine
  // on live bar updates.
  const indexed = zoneSets.map(set => {
    const zonesByDay = new Map<number, EngineZone[]>();
    const globalZones: EngineZone[] = [];
    for (const z of set) {
      const f = z.fromTime ?? 0, t = z.toTime ?? Infinity;
      const fd = Math.floor(f / 86400);
      if (f > 0 && isFinite(t) && Math.floor(t / 86400) === fd) {
        let arr = zonesByDay.get(fd);
        if (!arr) zonesByDay.set(fd, arr = []);
        arr.push(z);
      } else {
        globalZones.push(z);
      }
    }
    const zonesActiveAt = (ts: number): EngineZone[] => {
      const arr = zonesByDay.get(Math.floor(ts / 86400));
      if (!arr) return globalZones;
      return globalZones.length ? [...arr, ...globalZones] : arr;
    };
    return { zonesActiveAt };
  });

  const exitProfile = profile[session];
  const signals: EngineSignal[] = [];
  let lastLongBar = -10, lastShortBar = -10;

  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    const rth = isRTH(c.time);
    if (session === "rth" && !rth) continue;
    if (session === "eth" &&  rth) continue;
    // Skip CME settlement break (20:30–22:00 UTC) even in ETH mode
    if (new Date(c.time * 1000).getUTCHours() >= 20 && new Date(c.time * 1000).getUTCHours() < 22) continue;
    const lb     = vecMap.get(c.time);
    if (lb == null) continue;
    const prevLb = vecMap.get(sorted[i - 1].time);

    // Per-set zone confirmations ("zone test and hold" semantics)
    let bullSets = 0, bearSets = 0;
    if (gZone !== "off") {
      for (const { zonesActiveAt } of indexed) {
        const zonesHere = zonesActiveAt(c.time);
        if (zonesHere.some(z =>
          isBullZone(z) && c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity) &&
          c.low <= z.topPrice + MILK_TOLERANCE && c.close >= z.bottomPrice - MILK_TOLERANCE)) bullSets++;
        if (zonesHere.some(z =>
          !isBullZone(z) && c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity) &&
          c.high >= z.bottomPrice - MILK_TOLERANCE && c.close <= z.topPrice + MILK_TOLERANCE)) bearSets++;
      }
    }
    // ANY set confirming (tier semantics / single-list behavior)…
    const milkBullOk = gZone !== "off" && bullSets > 0;
    const milkBearOk = gZone !== "off" && bearSets > 0;
    // …vs EVERY set confirming (required-gate semantics for strategy combos)
    const allBullOk = gZone !== "off" && bullSets === indexed.length;
    const allBearOk = gZone !== "off" && bearSets === indexed.length;

    // HOD suppression: skip long entries within 5 pts of pre-bar HOD
    const prevHod = hodBeforeBar.get(c.time) ?? -Infinity;
    const nearHodLong = rth && prevHod > -Infinity && c.close < prevHod && c.close >= prevHod - 5;

    // 60m hard veto for longs
    const vec60mVetoed = get60mDecline(c.time);

    // ── LONG ──────────────────────────────────────────────────────────────
    const longVecOk  = !gVector || (c.close > lb && (prevLb == null || lb >= prevLb));
    const longZoneOk = gZone === "required" ? allBullOk : true;
    const longBodyOk = !gBody || c.close >= c.open;
    if (longVecOk && longZoneOk && longBodyOk && i - lastLongBar >= COOLDOWN_BARS && !nearHodLong && !vec60mVetoed) {
      // Require bullish close: bearish candles touching a zone are rejections, not bounces
      let fp: ReturnType<typeof analyzeFootprint> | null = null;
      if (gFootprint) {
        const fpCandle = buildProxyFootprintCandle(c);
        const priorFp  = sorted.slice(Math.max(0, i - 4), i).map((b: EngineCandle) => buildProxyFootprintCandle(b));
        fp = analyzeFootprint(fpCandle, "Long", priorFp, c.close);
      }
      if (fp?.vetoed) continue;                       // divergence veto — signal suppressed
      if (gFootprint && fp && !fp.deltaAgrees) continue; // delta must agree for Long

      lastLongBar = i;
      // Tier: zone = safe; no zone confirmation = risky (mirrors backtest.tsx)
      const tier: EngineTier = milkBullOk ? "safe" : "risky";
      const tp1F = tier === "safe" ? exitProfile.tp1Safe : exitProfile.tp1;
      let tp1  = c.close + tp1F;
      let tp2  = c.close + exitProfile.tp2;
      let sl   = c.close - exitProfile.sl;
      if (fp) {
        if (fp.exitAdjustments.usePocStop && fp.exitAdjustments.pocStopPrice != null && fp.exitAdjustments.pocStopPrice < c.close)
          sl = fp.exitAdjustments.pocStopPrice;
        if (fp.exitAdjustments.tp1Override != null) tp1 = fp.exitAdjustments.tp1Override;
        if (fp.exitAdjustments.tp2Extension != null) tp2 = c.close + (tp2 - c.close) * (1 + fp.exitAdjustments.tp2Extension);
      }
      const { outcome, toTime } = btWalkForward(sorted, i, tp1, tp2, sl, true, nowSec);
      signals.push({ time: c.time, direction: "Long", price: c.close, high: c.high, low: c.low, tier, tp1, tp2, sl, outcome, toTime, milkOk: milkBullOk, session });
    }

    // ── SHORT — zone-confirmed only (backtest rule), bearish close required ──
    const shortVecOk  = !gVector || (c.close < lb && (prevLb == null || lb <= prevLb));
    const shortZoneOk = gZone === "off" ? true : gZone === "required" ? allBearOk : milkBearOk;
    const shortBodyOk = !gBody || c.close <= c.open;
    if (shortZoneOk && shortVecOk && shortBodyOk && i - lastShortBar >= COOLDOWN_BARS) {
      let fp: ReturnType<typeof analyzeFootprint> | null = null;
      if (gFootprint) {
        const fpCandle = buildProxyFootprintCandle(c);
        const priorFp  = sorted.slice(Math.max(0, i - 4), i).map((b: EngineCandle) => buildProxyFootprintCandle(b));
        fp = analyzeFootprint(fpCandle, "Short", priorFp, c.close);
      }
      if (fp?.vetoed) continue;
      if (gFootprint && fp && !fp.deltaAgrees) continue; // delta must agree — bearish bar has negative delta

      lastShortBar = i;
      const tier: EngineTier = milkBearOk ? "safe" : "risky";
      const tp1F = tier === "safe" ? exitProfile.tp1Safe : exitProfile.tp1;
      let tp1  = c.close - tp1F;
      let tp2  = c.close - exitProfile.tp2;
      let sl   = c.close + exitProfile.sl;
      if (fp) {
        if (fp.exitAdjustments.usePocStop && fp.exitAdjustments.pocStopPrice != null && fp.exitAdjustments.pocStopPrice > c.close)
          sl = fp.exitAdjustments.pocStopPrice;
        if (fp.exitAdjustments.tp1Override != null) tp1 = fp.exitAdjustments.tp1Override;
        if (fp.exitAdjustments.tp2Extension != null) tp2 = c.close - (c.close - tp2) * (1 + fp.exitAdjustments.tp2Extension);
      }
      const { outcome, toTime } = btWalkForward(sorted, i, tp1, tp2, sl, false, nowSec);
      signals.push({ time: c.time, direction: "Short", price: c.close, high: c.high, low: c.low, tier, tp1, tp2, sl, outcome, toTime, milkOk: milkBearOk, session });
    }
  }

  return signals;
}

/** Convenience: run the engine for BOTH sessions (RTH + ETH) and merge chronologically.
 *  Each session's subset is exactly what the Backtest page produces in that session mode. */
export function computeEngineSignalsBothSessions(
  candles: EngineCandle[],
  milkZones: EngineZone[] | EngineZone[][],
  profile: ExitProfile,
  gates: EngineGates = {},
  nowSec: number = Math.floor(Date.now() / 1000),
): EngineSignal[] {
  return [
    ...computeEngineSignals(candles, milkZones, profile, "rth", gates, nowSec),
    ...computeEngineSignals(candles, milkZones, profile, "eth", gates, nowSec),
  ].sort((a, b) => a.time - b.time);
}
