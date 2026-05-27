import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { GraduationCap, RefreshCw, X as XIcon } from "lucide-react";
import { CandlestickChart, type CandleBar, type ZoneBand, type ChartHandle } from "./CandlestickChart";
import { type FrozenImbalanceZone, buildCandleFootprints, type FootprintCandle, analyzeFootprint, buildProxyFootprintCandle } from "@/lib/footprint-analysis";
import { buildFpImbalanceBands, type FpZoneBand } from "./FootprintLadder";

// ── palette ───────────────────────────────────────────────────────────────────
const MW = {
  bg: "#05080d", panel: "#090d14", border: "#1a2535",
  text: "#c8d8e8", muted: "#4a6080", accent: "#42a5f5",
  up: "#26c87a", down: "#ef5350",
};

// ── types ──────────────────────────────────────────────────────────────────────
type RiskLevel  = "safeplus" | "safe" | "risky" | "riskiest";
type IntervalKey = "1m" | "5m" | "15m" | "60m";
type OutcomeResult = "Win" | "Loss" | "Open";

interface SignalEntry {
  key: string;
  id?: number;    // DB id — present for external signals passed from market.tsx
  time: number;
  interval: IntervalKey;
  direction: "Long" | "Short";
  riskLevel: RiskLevel;
  price: number;   // close = entry
  open: number;    // candle open
  high: number;
  low: number;
  tp1: number;
  tp2: number;
  sl: number;
  rth: boolean;
  outcome: OutcomeResult;
  tpHit: 1 | 2 | null;   // which TP was hit (null = loss or open)
  points: number | null;
  milkOk: boolean;
  secondaryVecOk: boolean;
  imbalanceOk?: boolean;
  zonesLoaded?: boolean;
  footprintReading?: string; // FOOTPRINT-UI: JSON FootprintReading
  confidence?: number; // 0–100 confidence score
}

interface Annotation {
  note: string;
  markedBad: boolean;
  reason?: string;
}

/** Matches the CSig shape from market.tsx. Passed in to avoid duplicate signal computation. */
export interface ExternalSignal {
  time: number;
  direction: "Long" | "Short";
  riskLevel: RiskLevel;
  price: number;
  high: number;
  low: number;
  tp1: number; tp2: number; sl: number;
  confirmations: { milkOk: boolean; vecOk: boolean; secondaryVecOk: boolean };
  outcome?: "win_tp1" | "win_tp2" | "loss" | "open";
  zonesLoaded?: boolean;
  footprintReading?: string; // FOOTPRINT-UI: JSON-serialized FootprintReading
  confidence?: number; // 0–100 confidence score
  interval?: string; // FIX: interval at signal creation — used to filter panel by current interval
}

export interface SignalsPanelProps {
  defaultSymbol?: string;
  defaultInterval?: IntervalKey;
  onClose?: () => void;
  /** When provided, bypasses internal computeSignals — chart and panel share one source of truth. */
  externalSignals?: ExternalSignal[];
  /** Called when user clicks "View on Chart". In market.tsx: scrolls chart. In today-signals: navigates. */
  onViewOnChart: (timestamp: number, intervalSec: number) => void;
  /** Milk zone bands from the parent (for preview chart overlay). */
  milkZones?: ZoneBand[];
  /** Full candle dataset from the parent chart — used for preview lookups so any signal can be previewed. */
  allCandles?: CandleBar[];
  /** FOOTPRINT-UI: mid-trade divergence alerts keyed by signal id (signalId → alert data) */
  footprintAlerts?: Record<number, { pocPrice: number; message: string }>; // FOOTPRINT-UI:
  /** Frozen imbalance zones from the parent (prior-session imbalance bands for preview chart overlay). */
  frozenImbalances?: FrozenImbalanceZone[];
  /** Called when user clicks the Refresh Signals button — parent refetches candle data */
  onRefreshSignals?: () => Promise<void>;
  /** Pre-set the risk filter to match the chart's current risk level */
  defaultRiskLevel?: "all" | RiskLevel;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function isRTH(ts: number): boolean {
  const d = new Date(ts * 1000);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 13 * 60 + 30 && m < 20 * 60; // 9:30 AM – 4:00 PM ET
}

/** Returns true if the timestamp falls in the CME ES/MES settlement break (4:30pm–6:00pm ET). */
function isMarketBreak(ts: number): boolean {
  const d = new Date(ts * 1000);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return false;
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  const [h, m] = et.split(":").map(Number);
  const etMins = h * 60 + m;
  return etMins >= 16 * 60 + 30 && etMins < 18 * 60;
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York",
  });
}

function fmtDateShort(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "America/New_York",
  });
}

function fmtDateFull(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York",
  });
}

const VEC_LENGTH = 20;

function computeVectorLine(candles: CandleBar[]): Array<{ time: number; value: number }> {
  if (!candles.length) return [];
  const s = [...candles].sort((a, b) => a.time - b.time);
  const n = s.length;
  const lb = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let lo = s[i].low;
    for (let j = Math.max(0, i - VEC_LENGTH + 1); j < i; j++) if (s[j].low < lo) lo = s[j].low;
    lb[i] = lo;
  }
  const result: Array<{ time: number; value: number }> = [];
  for (let i = 0; i < n; i++) {
    let hi = lb[i];
    for (let j = Math.max(0, i - VEC_LENGTH + 1); j < i; j++) if (lb[j] > hi) hi = lb[j];
    result.push({ time: s[i].time, value: hi });
  }
  return result;
}

function forwardFillVector(
  vec: Array<{ time: number; value: number }>,
  chartTimes: number[],
): Array<{ time: number; value: number }> {
  if (!vec.length || !chartTimes.length) return [];
  const sorted = [...vec].sort((a, b) => a.time - b.time);
  const result: Array<{ time: number; value: number }> = [];
  let vi = 0;
  for (const t of chartTimes) {
    while (vi + 1 < sorted.length && sorted[vi + 1].time <= t) vi++;
    if (sorted[vi] && sorted[vi].time <= t) result.push({ time: t, value: sorted[vi].value });
  }
  return result;
}

function aggToInterval(candles: CandleBar[], intervalSec: number): CandleBar[] {
  if (!candles.length) return [];
  const s = [...candles].sort((a, b) => a.time - b.time);
  const map = new Map<number, CandleBar>();
  for (const c of s) {
    const bucket = Math.floor(c.time / intervalSec) * intervalSec;
    const ex = map.get(bucket);
    if (!ex) {
      map.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, rth: c.rth });
    } else {
      ex.high   = Math.max(ex.high, c.high);
      ex.low    = Math.min(ex.low, c.low);
      ex.close  = c.close;
      ex.volume = (ex.volume ?? 0) + (c.volume ?? 0);
      if (c.rth) ex.rth = true;
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}


// Fixed-point exits — Monte Carlo calibrated on real MES 5m data
const TP_FIXED_1    = 10.0;  // 10 pts (40 ticks)
const TP_FIXED_2    = 20.0;  // 20 pts (80 ticks)
const SL_FIXED      = 5.0;   // 5 pts  (20 ticks)
const MILK_TOL      = 2.0;   // zone proximity tolerance in pts
const COOLDOWN_BARS = 10;
const ETH_COOLDOWN  = 20;
// Legacy ATR constants kept for reference only
const TP_ATR_MULT   = 1.0;
const SL_ATR_MULT   = 0.5;
const ATR_PERIOD    = 14;

interface RawSignal {
  time: number; open: number; high: number; low: number; direction: "Long" | "Short";
  riskLevel: RiskLevel; price: number;
  tp1: number; tp2: number; sl: number;
  milkOk: boolean; secondaryVecOk: boolean;
  zonesLoaded?: boolean;
  /** Pre-computed outcome from market.tsx (only set when externalSignals provided) */
  preOutcome?: "win_tp1" | "win_tp2" | "win_trailer" | "loss" | "open";
  footprintReading?: string; // FOOTPRINT-UI: JSON FootprintReading
  confidence?: number; // 0–100 confidence score
}

function isBullZone(z: ZoneBand): boolean {
  if (z.label) {
    const l = z.label.toLowerCase();
    if (/sell|resist|bear|supply|absorb\s*buy|cap\s*session|ceiling|non.fair|iv.wall|iv.overflow|pivot(?!.*floor)|gex.wall.short|wall.short|short.median/i.test(l)) return false;
    if (/buy|demand|support|bull|absorb\s*sell|floor|gex.wall.long|wall.long|long.median|spy.floor|ovn.spy.floor/i.test(l)) return true;
  }
  const c = z.color.toLowerCase().trim();
  if (c === "#22c55e" || c === "#3b82f6" || c === "#14b8a6") return true;
  const m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) { const r = +m[1], g = +m[2], b = +m[3]; return g > r || (b > r && b > g); }
  return false;
}

function computeSignals(candles: CandleBar[], secondaryCandles: CandleBar[][] = [], zones: ZoneBand[] = []): RawSignal[] {
  if (!candles.length) return [];
  const sorted     = [...candles].sort((a, b) => a.time - b.time);
  const chartTimes = sorted.map(c => c.time);
  const vecArr     = computeVectorLine(sorted);
  const vecMap     = new Map(vecArr.map(v => [v.time, v.value]));

  const secMaps = secondaryCandles.filter(sc => sc.length > 0).map(sc => {
    const sv = computeVectorLine([...sc].sort((a, b) => a.time - b.time));
    return new Map(forwardFillVector(sv, chartTimes).map(v => [v.time, v.value]));
  });

  // Pre-build proxy footprint for all bars
  const fpByTime = new Map<number, FootprintCandle>();
  for (const c of sorted) fpByTime.set(c.time, buildProxyFootprintCandle(c));

  const raw: RawSignal[] = [];
  let lastLongBar = -COOLDOWN_BARS, lastLongEthBar = -ETH_COOLDOWN;
  let lastShortBar = -COOLDOWN_BARS, lastShortEthBar = -ETH_COOLDOWN;

  for (let i = 0; i < sorted.length; i++) {
    const c   = sorted[i];
    const lb  = vecMap.get(c.time);
    if (lb == null || isMarketBreak(c.time)) continue;

    const rthFlag      = c.rth ?? isRTH(c.time);
    const utcH         = (c.time / 3600 | 0) % 24;
    const minsUtc      = utcH * 60 + ((c.time / 60 | 0) % 60);
    const isRthForMilk = rthFlag && minsUtc >= 13 * 60 + 30 && minsUtc < 20 * 60 + 30;

    const secLongOk  = secMaps.some(m => { const v = m.get(c.time); return v != null && c.close > v; });
    const secShortOk = secMaps.some(m => { const v = m.get(c.time); return v != null && c.close < v; });

    let milkBullOk = false, milkBearOk = false;
    let milkPtsL = 0, milkPtsS = 0;
    if (isRthForMilk) {
      for (const z of zones) {
        // Only dated zones (fromTime > 0) count for milk confirmation
        if (!z.fromTime || c.time < z.fromTime || (z.toTime != null && c.time > z.toTime)) continue;
        const bull = isBullZone(z);
        if (bull) {
          if (c.low <= z.topPrice + 0.5) {
            const below = z.bottomPrice - c.close;
            const pts = below <= 0.5 ? 3 : below <= 1.5 ? 1 : 0;
            if (pts > milkPtsL) { milkPtsL = pts; if (pts > 0) milkBullOk = true; }
          }
        } else {
          if (c.high >= z.bottomPrice - 0.5) {
            const above = c.close - z.topPrice;
            const pts = above <= 0.5 ? 3 : above <= 1.5 ? 1 : 0;
            if (pts > milkPtsS) { milkPtsS = pts; if (pts > 0) milkBearOk = true; }
          }
        }
      }
    }

    const fpCandle = fpByTime.get(c.time)!;
    const priorFp  = sorted.slice(Math.max(0, i - 4), i).map(b => fpByTime.get(b.time)!);

    const prevBarLb  = i > 0 ? vecMap.get(sorted[i - 1].time) : undefined;
    const prevBarLb2 = i > 1 ? vecMap.get(sorted[i - 2].time) : undefined;

    // ── Long ──────────────────────────────────────────────────────────────
    if (c.close > lb) {
      const fpR = analyzeFootprint(fpCandle, "Long", priorFp, c.close);
      if (!fpR?.vetoed) {
        const sideEntry   = prevBarLb != null && sorted[i - 1].close <= prevBarLb && c.close > lb;
        const tabletopTest = prevBarLb != null && prevBarLb2 != null
          && Math.abs(lb - prevBarLb) < 0.5 && Math.abs(prevBarLb - prevBarLb2) < 0.5
          && c.close > lb && c.close >= c.open;
        const vecTestedL = sideEntry || tabletopTest;

        const fpFires = fpR?.confirmed || fpR?.partial;
        let fpStrong  = false;
        if (fpFires) {
          if (fpCandle.imbalances.some(cl => cl.direction === "buy"  && cl.levelCount >= 2)) fpStrong = true;
          if (!fpStrong && priorFp.length > 0) {
            const avg = priorFp.reduce((s, p) => s + Math.abs(p.candleDelta), 0) / priorFp.length;
            if (avg > 0 && Math.abs(fpCandle.candleDelta) >= 2 * avg) fpStrong = true;
          }
        }
        // FIX 4: proxy data cannot be "strong" — cap at weak (2pts max)
        if (fpR?.isProxyData) fpStrong = false;
        const totalPts = (fpFires ? (fpStrong ? 4 : 2) : 0) + milkPtsL + (vecTestedL ? 2 : 0);
        if (totalPts >= 1) {
          const level: RiskLevel = totalPts >= 8 ? "safeplus" : totalPts >= 4 ? "safe" : totalPts >= 3 ? "risky" : "riskiest";
          if (!(rthFlag && utcH >= 20 && level !== "safe" && level !== "safeplus")) {
            const cd = rthFlag ? COOLDOWN_BARS : ETH_COOLDOWN;
            if (i - (rthFlag ? lastLongBar : lastLongEthBar) >= cd) {
              if (rthFlag) lastLongBar = i; else lastLongEthBar = i;
              raw.push({ time: c.time, open: c.open, high: c.high, low: c.low, direction: "Long", riskLevel: level, price: c.close,
                tp1: c.close + TP_FIXED_1, tp2: c.close + TP_FIXED_2, sl: c.close - SL_FIXED,
                milkOk: milkBullOk, secondaryVecOk: secLongOk, zonesLoaded: zones.some(z => (z.fromTime ?? 0) > 0), footprintReading: fpR ? JSON.stringify(fpR) : undefined });
            }
          }
        }
      }
    }

    // ── Short ─────────────────────────────────────────────────────────────
    if (c.close < lb) {
      const fpR = analyzeFootprint(fpCandle, "Short", priorFp, c.close);
      if (!fpR?.vetoed) {
        const sideEntry    = prevBarLb != null && sorted[i - 1].close >= prevBarLb && c.close < lb;
        const tabletopTest = prevBarLb != null && prevBarLb2 != null
          && Math.abs(lb - prevBarLb) < 0.5 && Math.abs(prevBarLb - prevBarLb2) < 0.5
          && c.close < lb && c.close <= c.open;
        const vecTestedS = sideEntry || tabletopTest;

        const fpFires = fpR?.confirmed || fpR?.partial;
        let fpStrong  = false;
        if (fpFires) {
          if (fpCandle.imbalances.some(cl => cl.direction === "sell" && cl.levelCount >= 2)) fpStrong = true;
          if (!fpStrong && priorFp.length > 0) {
            const avg = priorFp.reduce((s, p) => s + Math.abs(p.candleDelta), 0) / priorFp.length;
            if (avg > 0 && Math.abs(fpCandle.candleDelta) >= 2 * avg) fpStrong = true;
          }
        }
        // FIX 4: proxy data cannot be "strong" — cap at weak (2pts max)
        if (fpR?.isProxyData) fpStrong = false;
        const totalPts = (fpFires ? (fpStrong ? 4 : 2) : 0) + milkPtsS + (vecTestedS ? 2 : 0);
        if (totalPts >= 1) {
          const level: RiskLevel = totalPts >= 8 ? "safeplus" : totalPts >= 4 ? "safe" : totalPts >= 3 ? "risky" : "riskiest";
          if (!(rthFlag && utcH >= 20 && level !== "safe" && level !== "safeplus")) {
            const cd = rthFlag ? COOLDOWN_BARS : ETH_COOLDOWN;
            if (i - (rthFlag ? lastShortBar : lastShortEthBar) >= cd) {
              if (rthFlag) lastShortBar = i; else lastShortEthBar = i;
              raw.push({ time: c.time, open: c.open, high: c.high, low: c.low, direction: "Short", riskLevel: level, price: c.close,
                tp1: c.close - TP_FIXED_1, tp2: c.close - TP_FIXED_2, sl: c.close + SL_FIXED,
                milkOk: milkBearOk, secondaryVecOk: secShortOk, zonesLoaded: zones.some(z => (z.fromTime ?? 0) > 0), footprintReading: fpR ? JSON.stringify(fpR) : undefined });
            }
          }
        }
      }
    }
  }
  return raw;
}

function computeOutcome(
  sig: { direction: "Long"|"Short"; price: number; tp1: number; tp2: number; sl: number; time: number },
  sorted: CandleBar[],
): { outcome: OutcomeResult; tpHit: 1 | 2 | null; points: number | null } {
  const isLong = sig.direction === "Long";
  const start  = sorted.findIndex(c => c.time > sig.time);
  if (start === -1) return { outcome: "Open", tpHit: null, points: null };
  for (let i = start; i < sorted.length; i++) {
    const c = sorted[i];
    if (isLong) {
      if (c.high >= sig.tp2) return { outcome: "Win",  tpHit: 2, points: +(sig.tp2 - sig.price).toFixed(2) };
      if (c.high >= sig.tp1) return { outcome: "Win",  tpHit: 1, points: +(sig.tp1 - sig.price).toFixed(2) };
      if (c.low  <= sig.sl)  return { outcome: "Loss", tpHit: null, points: +(sig.sl - sig.price).toFixed(2) };
    } else {
      if (c.low  <= sig.tp2) return { outcome: "Win",  tpHit: 2, points: +(sig.price - sig.tp2).toFixed(2) };
      if (c.low  <= sig.tp1) return { outcome: "Win",  tpHit: 1, points: +(sig.price - sig.tp1).toFixed(2) };
      if (c.high >= sig.sl)  return { outcome: "Loss", tpHit: null, points: +(sig.price - sig.sl).toFixed(2) };
    }
  }
  return { outcome: "Open", tpHit: null, points: null };
}

// ── exit strategy profiles — exact mirror of EXIT_STRATEGY_PROFILES in market.tsx ─────
// Each profile has per-tier TP/SL values so simulated outcomes respect the signal's risk level.
const EXIT_VIEW_PROFILES = {
  safe: {
    label: "Tight", color: "#26c87a",
    rth: {
      safeplus: { tp1: 14.0, tp2: 28.0, sl: 3.5 },
      safe:     { tp1: 12.5, tp2: 25.0, sl: 4.0 },
      risky:    { tp1:  9.0, tp2: 20.0, sl: 5.5 },
      riskiest: { tp1:  7.0, tp2: 16.0, sl: 8.0 },
    },
    eth: {
      safeplus: { tp1:  8.5, tp2: 17.0, sl: 2.5 },
      safe:     { tp1:  7.5, tp2: 15.0, sl: 3.0 },
      risky:    { tp1:  5.5, tp2: 12.0, sl: 4.0 },
      riskiest: { tp1:  4.0, tp2:  9.0, sl: 5.5 },
    },
  },
  risky: {
    label: "Standard", color: "#f59e0b",
    rth: {
      safeplus: { tp1: 12.0, tp2: 22.0, sl: 4.0 },
      safe:     { tp1: 10.0, tp2: 20.0, sl: 5.0 },
      risky:    { tp1:  7.5, tp2: 17.0, sl: 6.5 },
      riskiest: { tp1:  5.5, tp2: 13.0, sl: 9.0 },
    },
    eth: {
      safeplus: { tp1:  7.0, tp2: 13.0, sl: 3.0 },
      safe:     { tp1:  6.0, tp2: 12.0, sl: 3.5 },
      risky:    { tp1:  4.5, tp2: 10.0, sl: 4.5 },
      riskiest: { tp1:  3.5, tp2:  8.0, sl: 6.0 },
    },
  },
  riskiest: {
    label: "Wide", color: "#ef5350",
    rth: {
      safeplus: { tp1: 18.0, tp2: 35.0, sl:  8.0 },
      safe:     { tp1: 16.0, tp2: 30.0, sl: 10.0 },
      risky:    { tp1: 12.0, tp2: 25.0, sl: 12.0 },
      riskiest: { tp1: 10.0, tp2: 20.0, sl: 15.0 },
    },
    eth: {
      safeplus: { tp1: 10.0, tp2: 20.0, sl: 5.5 },
      safe:     { tp1:  9.0, tp2: 17.0, sl: 7.0 },
      risky:    { tp1:  7.0, tp2: 14.0, sl: 8.5 },
      riskiest: { tp1:  6.0, tp2: 12.0, sl: 10.0 },
    },
  },
} as const;
type ExitView = "current" | "safe" | "risky" | "riskiest" | "mc";

// ── MC calibration types ───────────────────────────────────────────────────────
interface TierCal {
  tier: string;
  sl_atr: number; tp1_atr: number; tp2_atr: number;
  win_rate_tp1: number; win_rate_tp2: number;
  ev_tp1: number; ev_combined: number;
  sample_count: number; calibrated_at: string;
  ev_ci_low: number; ev_ci_high: number;
  top5: Array<{ tp_atr: number; sl_atr: number; ev: number; wr: number }>;
  mae_p70_atr: number; mfe_p50_atr: number; mfe_p75_atr: number;
  date_range: string;
}
type MCCalibration = Record<string, TierCal>;

const MC_TIER_MULT: Record<string, number> = { safe: 1.0, risky: 1.25, riskiest: 1.50 };
const MC_ATR_FLOOR = 1.25;
const MC_TICK      = 0.25; // MES tick size

// ── constants ─────────────────────────────────────────────────────────────────
const SYMBOLS   = ["MES", "ES", "SPY", "QQQ", "NQ", "MNQ"];
const IVAL_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };

function defaultStartDate(): string {
  // Default to today's date so the panel opens showing today's signals
  return new Date().toISOString().split("T")[0];
}

// ── main component ─────────────────────────────────────────────────────────────
export default function SignalsPanel({ defaultSymbol = "MES", defaultInterval = "5m", onClose, onViewOnChart, externalSignals, milkZones, allCandles, footprintAlerts, frozenImbalances, onRefreshSignals, defaultRiskLevel }: SignalsPanelProps) { // FOOTPRINT-UI:
  const [sym,       setSym]       = useState(defaultSymbol);
  const [ival,      setIval]      = useState<IntervalKey>(defaultInterval);
  const [activeTab,   setActiveTab]   = useState<"signals" | "learned" | "montecarlo">("signals");
  const [direction,   setDirection]   = useState<"all"|"long"|"short">("all");
  const [riskFilter,  setRiskFilter]  = useState<"all"|RiskLevel>(defaultRiskLevel ?? "all");
  const [rthOnly,     setRthOnly]     = useState(false);
  const [exitView,    setExitView]    = useState<ExitView>("current");
  const [minPts,      setMinPts]      = useState(0);
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [editMode,      setEditMode]      = useState(false);
  const [selKey,        setSelKey]        = useState<string | null>(null);
  const [editNote,      setEditNote]      = useState("");
  const [learnLoading,      setLearnLoading]      = useState(false);
  const [learnLog,          setLearnLog]          = useState<any | null>(null);
  const [learnToast,        setLearnToast]        = useState<string | null>(null);
  const [signalsRefreshing, setSignalsRefreshing] = useState(false);

  const [showLearnedTrades, setShowLearnedTrades] = useState(false);

  const [previewSig,               setPreviewSig]               = useState<SignalEntry | null>(null);
  const [previewShowVector,        setPreviewShowVector]        = useState(true);
  const [previewShowZones,         setPreviewShowZones]         = useState(true);
  const [previewShowExtraVectors,  setPreviewShowExtraVectors]  = useState(true);
  const [previewShowFpFrozen,      setPreviewShowFpFrozen]      = useState(true);
  const [previewShowFootprint,     setPreviewShowFootprint]     = useState(true);
  const [previewShowFpBands,       setPreviewShowFpBands]       = useState(true);
  const previewChartRef = useRef<ChartHandle>(null);

  const [annotations, setAnnotations] = useState<Record<string, Annotation>>(() => {
    try { return JSON.parse(localStorage.getItem("sp-annotations") ?? "{}"); }
    catch { return {}; }
  });

  const saveAnnotation = useCallback((key: string, ann: Annotation) => {
    setAnnotations(prev => {
      const next = { ...prev, [key]: ann };
      localStorage.setItem("sp-annotations", JSON.stringify(next));
      return next;
    });
  }, []);

  // ── date range ──────────────────────────────────────────────────────────────
  // toTs: no upper-bound filter — live signals fired during the session must not be cut off.
  // A stale useMemo(()=>Date.now(),[]) would silently drop any signal whose candle closes
  // after the panel was first mounted.
  const toTs   = 9_999_999_999;
  const fromTs = useMemo(() => {
    // Interpret startDate as a calendar day in ET and find midnight UTC for that day.
    // new Date(date + "T00:00:00") = midnight local; subtract local UTC offset to get UTC midnight.
    const d = new Date(startDate + "T00:00:00");
    return Math.floor(d.getTime() / 1000); // UTC midnight of the selected date
  }, [startDate]);

  // ── data fetching ───────────────────────────────────────────────────────────
  const fetchIval = ival === "1m" ? "1m" : "5m";
  const { data: mainData, isLoading } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["sp-candles", sym, fetchIval, fromTs, toTs],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${sym}/${fetchIval}?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("fetch failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  // Secondary 5m (only when interval=1m — needed for secondary vectors)
  const { data: sec5m } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["sp-candles", sym, "5m", fromTs, toTs],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${sym}/5m?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("fetch failed");
      return r.json();
    },
    enabled: ival === "1m",
    staleTime: 60_000,
  });

  // ── MC calibration ──────────────────────────────────────────────────────────
  const { data: mcCalibration } = useQuery<MCCalibration | null>({
    queryKey: ["mc-calibration"],
    queryFn: async () => {
      const r = await fetch("/api/mc-calibration");
      if (!r.ok) return null;
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  // ── candle derivation ───────────────────────────────────────────────────────
  const base5m    = useMemo(() => ival === "1m" ? (sec5m?.candles ?? []) : (mainData?.candles ?? []), [ival, mainData, sec5m]);
  const base1m    = useMemo(() => ival === "1m" ? (mainData?.candles ?? []) : [], [ival, mainData]);
  const candles15m = useMemo(() => aggToInterval(base5m, 900),  [base5m]);
  const candles60m = useMemo(() => aggToInterval(base5m, 3600), [base5m]);

  const primaryCandles = useMemo(() => {
    if (ival === "1m")  return base1m;
    if (ival === "5m")  return base5m;
    if (ival === "15m") return candles15m;
    return candles60m;
  }, [ival, base1m, base5m, candles15m, candles60m]);

  const secondaryCandles = useMemo(() => {
    if (ival === "1m")  return [base5m, candles15m, candles60m];
    if (ival === "5m")  return [candles15m, candles60m];
    if (ival === "15m") return [base5m, candles60m];
    return [base5m, candles15m];
  }, [ival, base5m, candles15m, candles60m]);

  const sortedPrimary = useMemo(() => [...primaryCandles].sort((a, b) => a.time - b.time), [primaryCandles]);
  // For exit-view outcome scanning: prefer parent allCandles (full historical range) over panel's fetched data
  const allSortedCandles = useMemo(() => {
    const src = allCandles?.length ? allCandles : sortedPrimary;
    return [...src].sort((a, b) => a.time - b.time);
  }, [allCandles, sortedPrimary]);

  // ── ATR-14 map (time → atr) for MC exit computation ─────────────────────────
  const atr14Map = useMemo(() => {
    const map = new Map<number, number>();
    const s = [...sortedPrimary];
    for (let i = 1; i < s.length; i++) {
      const start = Math.max(1, i - 13);
      let sum = 0, count = 0;
      for (let j = start; j <= i; j++) {
        const tr = Math.max(s[j].high - s[j].low, Math.abs(s[j].high - s[j - 1].close), Math.abs(s[j].low - s[j - 1].close));
        sum += tr; count++;
      }
      if (count > 0) map.set(s[i].time, sum / count);
    }
    return map;
  }, [sortedPrimary]);

  // ── learnings fetch ─────────────────────────────────────────────────────────
  const { data: learningsData, refetch: refetchLearnings } = useQuery<{ content: string }>({
    queryKey: ["learnings"],
    queryFn: async () => {
      const r = await fetch("/api/learnings");
      if (!r.ok) return { content: "" };
      return r.json();
    },
    enabled: activeTab === "learned",
    staleTime: 30_000,
  });

  // When embedded in market.tsx (externalSignals provided), always mirror the chart's signals.
  // Symbol/interval selectors are hidden in this mode — change via the main chart controls.
  const embedded = externalSignals != null;
  const useExternal = embedded;

  // Sync ival/sym with parent props when interval or symbol changes on the chart.
  // useState only uses the initial value — without this effect the panel shows the wrong
  // interval's signals after the user switches intervals on the chart.
  useEffect(() => {
    if (!embedded) return;
    setIval(defaultInterval as IntervalKey);
    setSym(defaultSymbol);
  }, [defaultInterval, defaultSymbol, embedded]);

  // ── signal computation ──────────────────────────────────────────────────────
  const openMap = useMemo(() => new Map(sortedPrimary.map(c => [c.time, c.open])), [sortedPrimary]);
  const rawSignals = useMemo((): RawSignal[] => {
    if (useExternal) {
      // FIX: only show signals tagged for the current interval — safety filter for any stale cross-interval signals
      const intervalFiltered = externalSignals.filter(s => !s.interval || s.interval === defaultInterval);
      return intervalFiltered.map(s => ({
        time: s.time,
        open: openMap.get(s.time) ?? s.price,
        high: s.high,
        low: s.low,
        direction: s.direction as "Long",
        riskLevel: s.riskLevel,
        price: s.price,
        tp1: s.tp1, tp2: s.tp2, sl: s.sl,
        milkOk: s.confirmations.milkOk,
        secondaryVecOk: s.confirmations.secondaryVecOk,
        preOutcome: s.outcome,
        zonesLoaded: s.zonesLoaded,
        footprintReading: s.footprintReading, // FOOTPRINT-UI:
        confidence: s.confidence,
      }));
    }
    return computeSignals(primaryCandles, secondaryCandles, milkZones ?? []);
  }, [useExternal, externalSignals, openMap, primaryCandles, secondaryCandles, milkZones]);

  const signals = useMemo((): SignalEntry[] => {
    return rawSignals
      .map(s => {
        let outcome: OutcomeResult;
        let tpHit: 1 | 2 | null;
        let points: number | null;

        if (exitView === "mc" && mcCalibration) {
          // MC-calibrated exits: 3-step SL, MFE-based TPs, tier multiplier
          const tierKey = (s.riskLevel === "safeplus" ? "safe" : s.riskLevel) as string;
          const cal = mcCalibration[tierKey];
          if (cal) {
            const atr    = atr14Map.get(s.time) ?? 8.0;
            const mult   = MC_TIER_MULT[tierKey] ?? 1.0;
            const slDist = Math.max(MC_ATR_FLOOR * atr, (cal.mae_p70_atr || 0) * atr, cal.sl_atr * atr) * mult;
            const tp1Dist = (cal.mfe_p50_atr > 0 ? cal.mfe_p50_atr : cal.tp1_atr) * atr;
            const tp2Dist = (cal.mfe_p75_atr > 0 ? cal.mfe_p75_atr : cal.tp2_atr) * atr;
            const snap = (d: number) => Math.round(d / MC_TICK) * MC_TICK;
            const isLong = s.direction === "Long";
            const eTp1 = isLong ? s.price + snap(tp1Dist) : s.price - snap(tp1Dist);
            const eTp2 = isLong ? s.price + snap(tp2Dist) : s.price - snap(tp2Dist);
            const eSl  = isLong ? s.price - snap(slDist)  : s.price + snap(slDist);
            const res  = computeOutcome({ ...s, tp1: eTp1, tp2: eTp2, sl: eSl }, allSortedCandles);
            outcome = res.outcome; tpHit = res.tpHit; points = res.points;
          } else {
            const res = computeOutcome(s, allSortedCandles);
            outcome = res.outcome; tpHit = res.tpHit; points = res.points;
          }
        } else if (exitView !== "current" && exitView !== "mc") {
          // Re-compute outcome using the selected exit strategy profile's TP/SL levels.
          // Use the signal's actual riskLevel tier so the simulation is tier-accurate.
          const ep  = EXIT_VIEW_PROFILES[exitView];
          const ses = isRTH(s.time) ? ep.rth : ep.eth;
          const tier = (ses as Record<string, { tp1: number; tp2: number; sl: number }>)[s.riskLevel] ?? ses.riskiest;
          const isLong = s.direction === "Long";
          const eTp1 = isLong ? s.price + tier.tp1 : s.price - tier.tp1;
          const eTp2 = isLong ? s.price + tier.tp2 : s.price - tier.tp2;
          const eSl  = isLong ? s.price - tier.sl  : s.price + tier.sl;
          const res  = computeOutcome({ ...s, tp1: eTp1, tp2: eTp2, sl: eSl }, allSortedCandles);
          outcome = res.outcome; tpHit = res.tpHit; points = res.points;
        } else if (s.preOutcome) {
          // Use pre-computed outcome from market.tsx — fast path, no candle scanning
          const isLong = s.direction === "Long";
          if (s.preOutcome === "win_tp2")         { outcome = "Win";  tpHit = 2;    points = isLong ? +(s.tp2 - s.price).toFixed(2) : +(s.price - s.tp2).toFixed(2); }
          else if (s.preOutcome === "win_tp1")    { outcome = "Win";  tpHit = 1;    points = isLong ? +(s.tp1 - s.price).toFixed(2) : +(s.price - s.tp1).toFixed(2); }
          else if (s.preOutcome === "win_trailer"){ outcome = "Win";  tpHit = 1;    points = isLong ? +(s.tp1 - s.price).toFixed(2) : +(s.price - s.tp1).toFixed(2); }
          else if (s.preOutcome === "loss")       { outcome = "Loss"; tpHit = null; points = isLong ? +(s.sl  - s.price).toFixed(2) : +(s.price - s.sl ).toFixed(2); }
          else                                    { outcome = "Open"; tpHit = null; points = null; }
        } else {
          const res = computeOutcome(s, sortedPrimary);
          outcome = res.outcome; tpHit = res.tpHit; points = res.points;
        }
        return { key: `${sym}-${s.time}-${s.direction}-${ival}`, ...s, interval: ival, rth: isRTH(s.time), outcome, tpHit, points };
      })
      .filter(s => {
        if (s.time < fromTs || s.time > toTs) return false;
        if (isMarketBreak(s.time))                                    return false;
        if (rthOnly && !s.rth)                                                return false;
        if (direction === "long"  && s.direction !== "Long")                  return false;
        if (direction === "short" && (s.direction as string) !== "Short")      return false;
        if (riskFilter !== "all"  && s.riskLevel !== riskFilter)              return false;
        if (minPts > 0 && Math.abs(s.tp2 - s.price) < minPts)               return false;
        return true;
      })
      .sort((a, b) => a.time - b.time);
  }, [rawSignals, sortedPrimary, allSortedCandles, sym, ival, fromTs, toTs, rthOnly, direction, riskFilter, minPts, exitView, mcCalibration, atr14Map]);

  const selectedSignal = useMemo(() => signals.find(s => s.key === selKey) ?? null, [signals, selKey]);

  const handleRowClick = useCallback((sig: SignalEntry) => {
    const next = selKey === sig.key ? null : sig.key;
    setSelKey(next);
    if (next) setEditNote(annotations[next]?.note ?? "");
  }, [selKey, annotations]);

  // ── stats ───────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const decided = signals.filter(s => s.outcome !== "Open");
    const wins    = decided.filter(s => s.outcome === "Win").length;
    const pnl     = decided.reduce((sum, s) => sum + (s.points ?? 0), 0);
    return { wins, losses: decided.length - wins, wr: decided.length ? Math.round(wins / decided.length * 100) : null, pnl, total: signals.length };
  }, [signals]);

  // ── learned-tab stats ────────────────────────────────────────────────────────
  const learnedStats = useMemo(() => {
    const taught   = signals.filter(s => annotations[s.key]?.note?.trim());
    const badDecided = taught.filter(s => s.outcome !== "Open");
    const badWins    = badDecided.filter(s => s.outcome === "Win").length;
    // "clean" = signals not annotated as bad
    const clean      = signals.filter(s => !annotations[s.key]?.markedBad);
    const cleanDec   = clean.filter(s => s.outcome !== "Open");
    const cleanWins  = cleanDec.filter(s => s.outcome === "Win").length;
    return {
      taughtCount:  taught.length,
      badWr:        badDecided.length ? Math.round(badWins / badDecided.length * 100) : null,
      cleanWr:      cleanDec.length   ? Math.round(cleanWins / cleanDec.length * 100) : null,
      cleanWins, cleanLosses: cleanDec.length - cleanWins,
    };
  }, [signals, annotations]);

  // ── parse lessons from LEARNINGS.md ─────────────────────────────────────────
  const lessons = useMemo(() => {
    const raw = learningsData?.content ?? "";
    if (!raw.trim()) return [];
    // Each lesson block starts with "- **..."
    const blocks = raw.split(/\n(?=- \*\*)/).filter(b => b.trim().startsWith("- **"));
    return blocks.map(block => {
      const lines   = block.trim().split("\n");
      const header  = lines[0].replace(/^- \*\*/, "").replace(/\*\*:.*/, "").trim();
      const desc    = (lines[0].match(/\*\*: (.+)/) ?? [])[1] ?? "";
      const action  = (lines.find(l => l.includes("Action:")) ?? "").replace(/.*Action:\s*/, "").trim();
      const conf    = (lines.find(l => l.includes("Confidence:")) ?? "").replace(/.*Confidence:\s*/, "").trim();
      const dateM   = block.match(/\*\*(\d{4}-\d{2}-\d{2})/);
      return { header, desc, action, conf, date: dateM?.[1] ?? "" };
    });
  }, [learningsData]);

  // ── post-learning signals: fired AFTER first lesson was recorded, not annotated bad ──
  const postLearningSignals = useMemo(() => {
    const dated = lessons.filter(l => l.date).map(l => l.date).sort();
    if (!dated.length) return [];
    const firstLessonTs = new Date(dated[0] + "T00:00:00Z").getTime() / 1000;
    return signals.filter(s => s.time >= firstLessonTs && !annotations[s.key]?.note?.trim());
  }, [signals, annotations, lessons]);

  // ── preview chart data ───────────────────────────────────────────────────────
  const previewData = useMemo(() => {
    if (!previewSig) return null;
    // Prefer parent-supplied full candle dataset (covers all dates); fall back to panel's own fetch
    const base = allCandles?.length
      ? [...allCandles].sort((a, b) => a.time - b.time)
      : sortedPrimary;
    const idx = base.findIndex(c => c.time === previewSig.time);
    if (idx === -1) return null;

    const SHOW = 25;
    const LOOKBACK = 80; // extra bars before display window for accurate vector computation
    const vecStart     = Math.max(0, idx - LOOKBACK);
    const displayStart = Math.max(0, idx - SHOW);
    const displayEnd   = Math.min(base.length, idx + SHOW + 1);
    // Deduplicate before passing to lw-charts (v5 silently drops duplicate timestamps)
    const seen = new Set<number>();
    const dedup = (arr: CandleBar[]) => arr.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
    seen.clear();
    const vecCandles     = dedup(base.slice(vecStart, displayEnd));
    seen.clear();
    const displayCandles = dedup(base.slice(displayStart, displayEnd));
    const fullVector  = computeVectorLine(vecCandles);
    const displaySet  = new Set(displayCandles.map(c => c.time));
    const vector      = fullVector.filter(v => displaySet.has(v.time));
    const lastTime    = displayCandles[displayCandles.length - 1]?.time ?? previewSig.time;

    // Scan forward from the signal to find the actual TP/SL exit bar, capped at lastTime
    const isLong = previewSig.direction === "Long";
    let toTime = lastTime;
    for (let j = idx + 1; j < base.length; j++) {
      const f = base[j];
      if (f.time > lastTime) break; // stay within display window
      if (isLong) {
        if (f.high >= previewSig.tp1 || f.low <= previewSig.sl) { toTime = f.time; break; }
      } else {
        if (f.low <= previewSig.tp1 || f.high >= previewSig.sl) { toTime = f.time; break; }
      }
    }

    return { displayCandles, vector, lastTime, toTime };
  }, [previewSig, sortedPrimary, allCandles]);

  const previewZones = useMemo((): ZoneBand[] => {
    if (!previewSig || !previewData || !milkZones?.length) return [];
    const { displayCandles } = previewData;
    if (!displayCandles.length) return [];
    const firstTime = displayCandles[0].time;
    const lastTime  = displayCandles[displayCandles.length - 1].time;
    return milkZones.filter(z => {
      const zFrom = z.fromTime ?? 0;
      const zTo   = z.toTime   ?? Infinity;
      return zFrom <= lastTime && zTo >= firstTime;
    });
  }, [previewSig, previewData, milkZones]);

  const previewConfluenceSig = useMemo(() => {
    if (!previewSig || !previewData) return null;
    return {
      time:      previewSig.time,
      price:     previewSig.price,
      direction: previewSig.direction as "Long" | "Short",
      tp1:       previewSig.tp1,
      tp2:       previewSig.tp2,
      sl:        previewSig.sl,
      toTime:    previewData.toTime,
      riskLevel: previewSig.riskLevel,
      confirmations: { milkOk: previewSig.milkOk, vecOk: true, secondaryVecOk: previewSig.secondaryVecOk },
    };
  }, [previewSig, previewData]);

  // ── secondary vector lines for preview (15m + 60m computed from allCandles) ──
  const previewExtraVectors = useMemo((): Array<{ label: string; color: string; data: Array<{ time: number; value: number }> }> => {
    if (!previewData || !allCandles?.length) return [];
    const base = [...allCandles].sort((a, b) => a.time - b.time);
    const chartTimes = previewData.displayCandles.map(c => c.time);
    const result: Array<{ label: string; color: string; data: Array<{ time: number; value: number }> }> = [];

    const candles15m = aggToInterval(base, 900);
    if (candles15m.length) {
      const vec15 = computeVectorLine(candles15m);
      if (vec15.length) result.push({ label: "15m", color: "#fbbf24", data: forwardFillVector(vec15, chartTimes) });
    }

    const candles60m = aggToInterval(base, 3600);
    if (candles60m.length) {
      const vec60 = computeVectorLine(candles60m);
      if (vec60.length) result.push({ label: "60m", color: "#a855f7", data: forwardFillVector(vec60, chartTimes) });
    }

    return result;
  }, [previewData, allCandles]);

  // ── footprint candle map for preview (proxy footprints from OHLCV) ────────────
  const previewCandleFootprints = useMemo((): Map<number, FootprintCandle> | undefined => {
    if (!previewData?.displayCandles.length) return undefined;
    return buildCandleFootprints(previewData.displayCandles);
  }, [previewData]);

  // ── FP imbalance bands for preview (stacked imbalance zone overlays) ──────────
  const previewFpBands = useMemo((): FpZoneBand[] => {
    if (!previewData?.displayCandles.length) return [];
    return buildFpImbalanceBands(previewData.displayCandles);
  }, [previewData]);

  // After chart mounts / signal changes, center the view on the signal.
  // The chart's default wasFirstLoad path calls scrollToRealTime() which scrolls
  // past historical data — fix by re-scrolling to the signal bar after a frame.
  useEffect(() => {
    if (!previewSig) return;
    const ivSec = IVAL_SEC[previewSig.interval] ?? 300;
    const frame = requestAnimationFrame(() => {
      previewChartRef.current?.scrollToTime(previewSig.time, ivSec, 25);
    });
    return () => cancelAnimationFrame(frame);
  }, [previewSig]);

  const rlColor = (rl: string) => rl === "safeplus" ? "#a78bfa" : rl === "safe" ? "#26c87a" : rl === "risky" ? "#f59e0b" : "#ef4444";
  const ocColor = (oc: OutcomeResult) => oc === "Win" ? "#26c87a" : oc === "Loss" ? "#ef5350" : MW.muted;

  const sel = (active: boolean, color = MW.accent) => ({
    padding: "0 10px", height: 26, fontSize: 11, borderRadius: 13,
    border: `1px solid ${active ? color + "88" : MW.border}`,
    background: active ? color + "18" : "transparent",
    color: active ? color : MW.muted, cursor: "pointer",
    fontFamily: "'Trebuchet MS', monospace",
  });

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: MW.bg, color: MW.text, fontFamily: "'Trebuchet MS', monospace" }}>

      {/* ── Preview panel (floats to the LEFT of the signals drawer) ──────── */}
      {previewSig && previewData && previewConfluenceSig && (
        <div style={{
          position: "absolute", right: "100%", top: 0, bottom: 0, width: 500,
          background: "#05080d", borderLeft: "1px solid #1a2535",
          boxShadow: "-8px 0 32px rgba(0,0,0,0.72)",
          display: "flex", flexDirection: "column", zIndex: 10,
        }}>
          {/* Preview header */}
          <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid #1a2535", background: "#090d14" }}>
            <span style={{ fontSize: 10, color: MW.accent, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Preview</span>
            <span style={{ fontSize: 10, color: previewSig.direction === "Long" ? "#26c87a" : "#ef5350", fontWeight: 700 }}>
              {previewSig.direction === "Long" ? "▲" : "▼"} {previewSig.direction.toUpperCase()}
            </span>
            <span style={{ fontSize: 10, color: MW.muted }}>{fmtDateShort(previewSig.time)} {fmtTime(previewSig.time)}</span>
            <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: rlColor(previewSig.riskLevel) + "18", color: rlColor(previewSig.riskLevel) }}>{previewSig.riskLevel}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <button style={sel(previewShowVector, MW.accent)} onClick={() => setPreviewShowVector(v => !v)}>Vector</button>
              {previewExtraVectors.length > 0 && (
                <button style={sel(previewShowExtraVectors, "#9ca3af")} onClick={() => setPreviewShowExtraVectors(v => !v)}>15m/60m</button>
              )}
              {milkZones?.length ? (
                <button style={sel(previewShowZones, "#22c55e")} onClick={() => setPreviewShowZones(v => !v)}>Zones</button>
              ) : null}
              {frozenImbalances?.length ? (
                <button style={sel(previewShowFpFrozen, "#f97316")} onClick={() => setPreviewShowFpFrozen(v => !v)}>Prior Imbalances</button>
              ) : null}
              {previewCandleFootprints && (
                <button style={sel(previewShowFootprint, "#818cf8")} onClick={() => setPreviewShowFootprint(v => !v)}>Footprint</button>
              )}
              {previewFpBands.length > 0 && (
                <button style={sel(previewShowFpBands, "#f59e0b")} onClick={() => setPreviewShowFpBands(v => !v)}>FP Bands</button>
              )}
              <button onClick={() => setPreviewSig(null)} style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 15, padding: "0 2px", lineHeight: 1 }}>✕</button>
            </div>
          </div>
          {/* Chart */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <CandlestickChart
              ref={previewChartRef}
              candles={previewData.displayCandles}
              vectorData={previewShowVector ? previewData.vector : undefined}
              showVector={previewShowVector}
              extraVectors={previewShowExtraVectors ? previewExtraVectors : undefined}
              zones={[
                ...(previewShowZones ? previewZones : []),
                ...(previewShowFpBands ? previewFpBands : []),
              ]}
              frozenImbalances={previewShowFpFrozen ? frozenImbalances : undefined}
              candleFootprints={previewShowFootprint ? previewCandleFootprints : undefined}
              confluenceSignals={[previewConfluenceSig]}
              activeSignalTime={previewSig.time}
              showVolume={false}
              showLabels={true}
            />
          </div>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", borderBottom: `1px solid ${MW.border}`, background: MW.panel, flexShrink: 0 }}>
        {/* Tab buttons */}
        {([
          { id: "signals",     label: "Signals",   color: MW.accent },
          { id: "learned",     label: "Learned",   color: "#a78bfa" },
          { id: "montecarlo",  label: "Monte Carlo", color: "#22d3ee" },
        ] as const).map(({ id, label, color }) => (
          <button key={id} onClick={() => { setActiveTab(id); if (id === "learned") refetchLearnings(); }}
            style={{
              padding: "3px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer",
              background: activeTab === id ? color + "22" : "transparent",
              border: `1px solid ${activeTab === id ? color + "88" : MW.border}`,
              color: activeTab === id ? color : MW.muted,
              fontFamily: "'Trebuchet MS', monospace", textTransform: "uppercase", letterSpacing: "0.05em",
            }}
          >{label}</button>
        ))}

        <span style={{ color: MW.muted, fontSize: 11 }}>
          {activeTab === "signals" ? `${stats.total} signals` : activeTab === "learned" ? `${lessons.length} lessons` : "MC calibration"}
        </span>

        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {activeTab === "signals" && onRefreshSignals && (
            <button
              onClick={async () => {
                if (signalsRefreshing) return;
                setSignalsRefreshing(true);
                try { await onRefreshSignals(); } finally { setSignalsRefreshing(false); }
              }}
              disabled={signalsRefreshing}
              title="Refresh signals — refetch candle data and recompute all signals"
              style={{
                padding: "3px 10px", borderRadius: 4, fontSize: 11,
                cursor: signalsRefreshing ? "not-allowed" : "pointer",
                background: "transparent",
                border: `1px solid ${MW.border}`,
                color: signalsRefreshing ? MW.accent : MW.muted,
                fontFamily: "'Trebuchet MS', monospace",
                display: "flex", alignItems: "center", gap: 5,
                opacity: signalsRefreshing ? 0.7 : 1,
              }}
            >
              <RefreshCw size={11} style={{ animation: signalsRefreshing ? "spin 1s linear infinite" : "none" }} />
              {signalsRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          )}
          {activeTab === "signals" && (
            <button
              onClick={() => setEditMode(v => !v)}
              title="Author mode — annotate signals"
              style={{
                padding: "3px 10px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                background: editMode ? "rgba(167,139,250,0.18)" : "transparent",
                border: `1px solid ${editMode ? "#a78bfa88" : MW.border}`,
                color: editMode ? "#a78bfa" : MW.muted,
                fontFamily: "'Trebuchet MS', monospace",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              ✏ {editMode ? "Author ON" : "Author"}
            </button>
          )}
          {activeTab === "signals" && (
            <button
              onClick={async () => {
                setLearnLoading(true);
                try {
                  // Backfill signals from all cached_candles across every interval first
                  await fetch("/api/learn/backfill", { method: "POST" });
                  const res = await fetch("/api/learn/run", { method: "POST" });
                  const data = await res.json();
                  setLearnLog(data);
                  setLearnToast(`Learned from ${data.signalCount ?? 0} signals (${((data.winRate ?? 0) * 100).toFixed(0)}% win rate)`);
                  setTimeout(() => setLearnToast(null), 4000);
                } catch {
                  setLearnToast("Learn failed — server error");
                  setTimeout(() => setLearnToast(null), 3000);
                } finally {
                  setLearnLoading(false);
                }
              }}
              disabled={learnLoading}
              style={{
                padding: "3px 10px", borderRadius: 4, fontSize: 11, cursor: learnLoading ? "not-allowed" : "pointer",
                background: learnLog ? "rgba(34,211,238,0.15)" : "transparent",
                border: `1px solid ${learnLog ? "#22d3ee" : MW.border}`,
                color: learnLog ? "#22d3ee" : MW.muted,
                fontFamily: "'Trebuchet MS', monospace",
                display: "flex", alignItems: "center", gap: 5, opacity: learnLoading ? 0.6 : 1,
              }}
            >
              <GraduationCap size={12} />
              {learnLoading ? "Learning…" : "Learn"}
            </button>
          )}
          {onClose && (
            <button onClick={onClose} style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 17, padding: "0 2px", lineHeight: 1 }}>✕</button>
          )}
        </div>
      </div>

      {/* ── Stats bar ──────────────────────────────────────────────────────── */}
      {activeTab === "signals" && !isLoading && (
        <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "6px 14px", borderBottom: `1px solid ${MW.border}`, background: "#070b11", flexShrink: 0 }}>
          {stats.wr !== null ? (
            <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: stats.wr >= 50 ? "#26c87a" : "#ef5350", lineHeight: 1 }}>{stats.wr}%</span>
              <span style={{ fontSize: 10, color: MW.muted }}>win rate</span>
              {exitView !== "current" && exitView !== "mc" && (
                <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: EXIT_VIEW_PROFILES[exitView].color + "18", color: EXIT_VIEW_PROFILES[exitView].color, marginLeft: 4 }}>
                  {EXIT_VIEW_PROFILES[exitView].label}
                </span>
              )}
              {exitView === "mc" && (
                <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "rgba(34,211,238,0.12)", color: "#22d3ee", marginLeft: 4 }}>MC</span>
              )}
            </div>
          ) : (
            <span style={{ fontSize: 12, color: MW.muted }}>—% win rate</span>
          )}
          <div style={{ width: 1, height: 24, background: MW.border }} />
          <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
            <span><span style={{ color: "#26c87a", fontWeight: 700 }}>{stats.wins}</span><span style={{ color: MW.muted }}> W</span></span>
            <span><span style={{ color: "#ef5350", fontWeight: 700 }}>{stats.losses}</span><span style={{ color: MW.muted }}> L</span></span>
            <span style={{ color: MW.muted }}>{stats.total - stats.wins - stats.losses} open</span>
          </div>
          <div style={{ width: 1, height: 24, background: MW.border }} />
          <span style={{ fontWeight: 700, fontSize: 12, color: stats.pnl >= 0 ? "#26c87a" : "#ef5350" }}>
            {stats.pnl >= 0 ? "+" : ""}{stats.pnl.toFixed(2)} pts
          </span>
        </div>
      )}

      {/* ── Settings ───────────────────────────────────────────────────────── */}
      {activeTab === "signals" && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderBottom: `1px solid ${MW.border}`, background: MW.panel, flexShrink: 0, flexWrap: "wrap" }}>

        {/* Symbol + Interval — hidden in embedded mode (chart controls these) */}
        {!embedded && <>
          <select value={sym} onChange={e => setSym(e.target.value)}
            style={{ height: 26, padding: "0 6px", fontSize: 11, borderRadius: 4, background: "#0d1420", border: `1px solid ${MW.border}`, color: MW.accent, cursor: "pointer", fontFamily: "'Trebuchet MS', monospace" }}>
            {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={ival} onChange={e => setIval(e.target.value as IntervalKey)}
            style={{ height: 26, padding: "0 6px", fontSize: 11, borderRadius: 4, background: "#0d1420", border: `1px solid ${MW.border}`, color: MW.text, cursor: "pointer", fontFamily: "'Trebuchet MS', monospace" }}>
            {(["1m","5m","15m","60m"] as const).map(iv => <option key={iv} value={iv}>{iv}</option>)}
          </select>
          <span style={{ width: 1, height: 16, background: MW.border }} />
        </>}

        {/* Direction */}
        <button style={sel(direction === "all")}             onClick={() => setDirection("all")}>All</button>
        <button style={sel(direction === "long",  "#26c87a")} onClick={() => setDirection("long")}>Long ▲</button>
        <button style={sel(direction === "short", "#ef5350")} onClick={() => setDirection("short")}>Short ▼</button>

        <span style={{ width: 1, height: 16, background: MW.border }} />

        {/* Risk filter */}
        <button style={sel(riskFilter === "all")}                   onClick={() => setRiskFilter("all")}>All Risk</button>
        <button style={sel(riskFilter === "safeplus",  "#a78bfa")}   onClick={() => setRiskFilter("safeplus")}>SAFE+</button>
        <button style={sel(riskFilter === "safe",     "#26c87a")}   onClick={() => setRiskFilter("safe")}>Safe</button>
        <button style={sel(riskFilter === "risky",    "#f59e0b")}   onClick={() => setRiskFilter("risky")}>Risky</button>
        <button style={sel(riskFilter === "riskiest", "#ef5350")}   onClick={() => setRiskFilter("riskiest")}>Riskiest</button>

        <span style={{ width: 1, height: 16, background: MW.border }} />

        {/* Min points */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 10, color: MW.muted }}>≥</span>
          <input
            type="number" min={0} step={0.5} value={minPts}
            onChange={e => setMinPts(Math.max(0, parseFloat(e.target.value) || 0))}
            style={{ width: 48, height: 26, padding: "0 6px", fontSize: 11, borderRadius: 4, background: "#0d1420", border: `1px solid ${MW.border}`, color: MW.text, fontFamily: "'Trebuchet MS', monospace" }}
            title="Minimum TP2 points"
          />
          <span style={{ fontSize: 10, color: MW.muted }}>pts</span>
        </div>

        <span style={{ width: 1, height: 16, background: MW.border }} />

        {/* Date from */}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 10, color: MW.muted }}>From</span>
          <input
            type="date" value={startDate}
            onChange={e => setStartDate(e.target.value)}
            max={new Date().toISOString().split("T")[0]}
            style={{ height: 26, padding: "0 6px", fontSize: 11, borderRadius: 4, background: "#0d1420", border: `1px solid ${MW.border}`, color: MW.text, fontFamily: "'Trebuchet MS', monospace", colorScheme: "dark" }}
          />
          <span style={{ fontSize: 10, color: MW.muted }}>→ today</span>
        </div>

        <span style={{ width: 1, height: 16, background: MW.border }} />

        {/* RTH only toggle */}
        <button
          style={sel(rthOnly, "#f59e0b")}
          onClick={() => setRthOnly(v => !v)}
          title="Only show signals that fired during Regular Trading Hours (9:30am–4:30pm ET)"
        >RTH Only</button>

        <span style={{ width: 1, height: 16, background: MW.border }} />

        {/* Exit strategy view — recomputes outcomes with each profile's TP/SL */}
        <span style={{ fontSize: 9, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Exit:</span>
        <button style={sel(exitView === "current")} onClick={() => setExitView("current")} title="Show outcomes using the signal's actual TP/SL levels">Current</button>
        {(["safe", "risky", "riskiest"] as const).map(ev => (
          <button key={ev} style={sel(exitView === ev, EXIT_VIEW_PROFILES[ev].color)} onClick={() => setExitView(ev)}
            title={`Simulate outcomes using ${EXIT_VIEW_PROFILES[ev].label} exit levels — SAFE tier: TP1=${EXIT_VIEW_PROFILES[ev].rth.safe.tp1} TP2=${EXIT_VIEW_PROFILES[ev].rth.safe.tp2} SL=${EXIT_VIEW_PROFILES[ev].rth.safe.sl} pts`}>
            {EXIT_VIEW_PROFILES[ev].label}
          </button>
        ))}
        <button
          style={sel(exitView === "mc", "#22d3ee")}
          onClick={() => setExitView("mc")}
          title={mcCalibration ? "MC-calibrated exits: ATR-floor SL + MFE-based TPs + tier multipliers" : "No MC calibration — run exit_strategy.py recalibrate first"}
        >
          MC {mcCalibration ? "✓" : "–"}
        </button>
      </div>}

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      {activeTab === "learned" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Learned stats bar */}
          <div style={{ display: "flex", gap: 16, padding: "12px 14px", borderRadius: 6, background: "#070b11", border: `1px solid ${MW.border}`, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: learnedStats.cleanWr !== null ? (learnedStats.cleanWr >= 50 ? "#26c87a" : "#ef5350") : MW.muted }}>
                {learnedStats.cleanWr !== null ? `${learnedStats.cleanWr}%` : "—%"}
              </span>
              <span style={{ fontSize: 9, color: MW.muted }}>win rate (excl. bad trades)</span>
            </div>
            <div style={{ width: 1, background: MW.border }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: "#a78bfa" }}>{learnedStats.taughtCount}</span>
              <span style={{ fontSize: 9, color: MW.muted }}>trades taught to AI</span>
            </div>
            <div style={{ width: 1, background: MW.border }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: "#22d3ee" }}>{postLearningSignals.length}</span>
              <span style={{ fontSize: 9, color: MW.muted }}>trades after learning</span>
            </div>
          </div>

          {/* View post-learning trades button */}
          {postLearningSignals.length > 0 && (
            <button
              onClick={() => setShowLearnedTrades(true)}
              style={{
                padding: "7px 14px", borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: "pointer",
                fontFamily: "'Trebuchet MS', monospace", textTransform: "uppercase", letterSpacing: "0.05em",
                background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.35)", color: "#22d3ee",
                display: "flex", alignItems: "center", gap: 6, alignSelf: "flex-start",
              }}
            >
              <span>▶</span> View Trades After Learning ({postLearningSignals.length})
            </button>
          )}

          {/* Lessons list */}
          <div>
            <div style={{ fontSize: 9, color: "#a78bfa", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
              What Claude Learned ({lessons.length} patterns)
            </div>
            {lessons.length === 0 ? (
              <div style={{ color: MW.muted, fontSize: 12, padding: "20px 0" }}>
                No lessons yet. Use the <strong style={{ color: "#a78bfa" }}>Teach</strong> button on a bad trade to start building the knowledge base.
              </div>
            ) : lessons.map((l, i) => (
              <div key={i} style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 5, background: MW.panel, border: `1px solid ${MW.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa" }}>{l.header || `Lesson ${i + 1}`}</span>
                  {l.date && <span style={{ fontSize: 9, color: MW.muted }}>{l.date}</span>}
                </div>
                {l.desc && <div style={{ fontSize: 11, color: MW.text, lineHeight: 1.6, marginBottom: 6 }}>{l.desc}</div>}
                {l.action && (
                  <div style={{ fontSize: 10, color: "#22d3ee", background: "rgba(34,211,238,0.07)", borderRadius: 3, padding: "4px 8px", marginBottom: 4, border: "1px solid rgba(34,211,238,0.15)" }}>
                    <strong>Action:</strong> {l.action}
                  </div>
                )}
                {l.conf && (
                  <div style={{ fontSize: 9, color: MW.muted }}>Confidence: {l.conf}</div>
                )}
              </div>
            ))}
          </div>

          {/* Future trades section placeholder */}
          <div style={{ padding: "12px 14px", borderRadius: 5, background: MW.panel, border: `1px solid ${MW.border}` }}>
            <div style={{ fontSize: 9, color: MW.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Trades Influenced by Learnings</div>
            <div style={{ fontSize: 11, color: MW.muted, lineHeight: 1.7 }}>
              As more trades are taught, the system will track which future signals were filtered or modified based on learned patterns. Keep annotating bad trades with the <span style={{ color: "#a78bfa" }}>Teach</span> button to grow this section.
            </div>
          </div>
        </div>
      )}

      {/* ── Learned Trades Modal ──────────────────────────────────────────────── */}
      {showLearnedTrades && (() => {
        const tradesToShow = postLearningSignals;
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.72)" }}
            onClick={() => setShowLearnedTrades(false)}>
            <div style={{ width: 640, maxHeight: "80vh", display: "flex", flexDirection: "column", borderRadius: 8, background: "#0a0f1a", border: `1px solid rgba(34,211,238,0.3)`, boxShadow: "0 0 40px rgba(0,0,0,0.9)" }}
              onClick={e => e.stopPropagation()}>
              {/* Modal header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${MW.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "#22d3ee", textTransform: "uppercase", letterSpacing: "0.08em" }}>Trades After Learning</span>
                  <span style={{ fontSize: 10, color: MW.muted, background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.25)", borderRadius: 3, padding: "1px 7px" }}>{tradesToShow.length}</span>
                </div>
                <button onClick={() => setShowLearnedTrades(false)} style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>✕</button>
              </div>
              {/* Trade list */}
              <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                {tradesToShow.length === 0 ? (
                  <div style={{ color: MW.muted, fontSize: 12, padding: "30px 0", textAlign: "center" }}>No post-learning trades yet.</div>
                ) : tradesToShow.map((s) => {
                  const ann = annotations[s.key];
                  const dirColor = s.direction === "Long" ? "#26c87a" : "#ef5350";
                  const rlColor = s.riskLevel === "safeplus" ? "#a78bfa" : s.riskLevel === "safe" ? "#26c87a" : s.riskLevel === "risky" ? "#f59e0b" : "#ef4444";
                  const ocColor = s.outcome === "Win" ? "#26c87a" : s.outcome === "Loss" ? "#ef5350" : MW.muted;
                  const dt = new Date(s.time * 1000);
                  const dateStr = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
                  const timeStr = dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/New_York" });
                  return (
                    <div key={s.key} style={{ padding: "10px 12px", borderRadius: 6, background: MW.panel, border: `1px solid ${MW.border}` }}>
                      {/* Row 1: meta */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10, color: MW.muted }}>{dateStr} {timeStr}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: dirColor, textTransform: "uppercase" }}>{s.direction}</span>
                        <span style={{ fontSize: 9, color: rlColor, textTransform: "uppercase", border: `1px solid ${rlColor}44`, borderRadius: 3, padding: "1px 5px" }}>{s.riskLevel}</span>
                        <span style={{ fontSize: 9, color: ocColor, textTransform: "uppercase", border: `1px solid ${ocColor}44`, borderRadius: 3, padding: "1px 5px" }}>{s.outcome}</span>
                        <span style={{ fontSize: 9, color: MW.muted }}>{s.interval}</span>
                      </div>
                      {/* Entry/price info */}
                      <div style={{ display: "flex", gap: 14, marginBottom: 6 }}>
                        <span style={{ fontSize: 10, color: MW.muted }}>Entry <span style={{ color: MW.text }}>{s.price.toFixed(2)}</span></span>
                        <span style={{ fontSize: 10, color: MW.muted }}>TP1 <span style={{ color: MW.text }}>{s.tp1.toFixed(2)}</span></span>
                        <span style={{ fontSize: 10, color: MW.muted }}>SL <span style={{ color: MW.text }}>{s.sl.toFixed(2)}</span></span>
                        {s.points != null && (
                          <span style={{ fontSize: 10, color: s.points >= 0 ? "#26c87a" : "#ef5350", fontWeight: 700 }}>
                            {s.points >= 0 ? "+" : ""}{s.points.toFixed(2)} pts
                          </span>
                        )}
                      </div>
                      {/* Action buttons */}
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => { setPreviewSig(s); setShowLearnedTrades(false); }}
                          style={{ padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Trebuchet MS', monospace", background: "rgba(103,232,249,0.08)", border: "1px solid rgba(103,232,249,0.3)", color: "#67e8f9" }}
                        >Preview</button>
                        <button
                          onClick={() => { onViewOnChart(s.time, IVAL_SEC[s.interval] ?? 300); setShowLearnedTrades(false); }}
                          style={{ padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Trebuchet MS', monospace", background: "rgba(66,165,245,0.1)", border: "1px solid rgba(66,165,245,0.35)", color: MW.accent }}
                        >View on Chart</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {activeTab === "signals" && <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Signal list */}
        <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
          {isLoading ? (
            <div style={{ textAlign: "center", padding: 50, color: MW.muted, fontSize: 13 }}>Loading signals…</div>
          ) : signals.length === 0 ? (
            <div style={{ textAlign: "center", padding: 50, color: MW.muted, fontSize: 13 }}>
              No signals match the current filters.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead style={{ position: "sticky", top: 0, background: MW.panel, zIndex: 2 }}>
                <tr style={{ borderBottom: `1px solid ${MW.border}` }}>
                  {["", "Date", "Time", "Dir", "Risk", "Entry", "TP1", "SL", "R:R", "W/L", "P&L", ""].map((h, i) => (
                    <th key={i} style={{ padding: "5px 8px", textAlign: "left", fontSize: 9, color: MW.muted, fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signals.map((s, idx) => {
                  const isSel = selKey === s.key;
                  const ann   = annotations[s.key];
                  const oc    = ocColor(s.outcome);
                  const rl    = rlColor(s.riskLevel);
                  return (
                    <tr
                      key={s.key}
                      onClick={() => handleRowClick(s)}
                      style={{
                        borderBottom: `1px solid ${MW.border}`,
                        background: isSel ? "rgba(66,165,245,0.08)" : idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)",
                        cursor: "pointer",
                        opacity: s.riskLevel === "riskiest" ? 0.65 : 1,
                      }}
                    >
                      {/* Bad trade marker + confidence */}
                      <td style={{ padding: "5px 4px 5px 10px", width: 28 }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                          {ann?.markedBad && <span style={{ color: "#ef5350", fontSize: 8 }}>●</span>}
                          {s.confidence != null && (
                            <span style={{
                              fontSize: 8, fontWeight: 700,
                              color: s.confidence >= 90 ? "#26c87a" : s.confidence >= 75 ? "#f59e0b" : "#6b7280",
                            }}>
                              {s.confidence}%
                            </span>
                          )}
                        </div>
                      </td>
                      {/* Date */}
                      <td style={{ padding: "5px 8px", color: MW.muted, whiteSpace: "nowrap", fontSize: 10 }}>
                        {fmtDateShort(s.time)}
                      </td>
                      {/* Time — click to open preview panel */}
                      <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>
                        <span
                          onClick={e => { e.stopPropagation(); setPreviewSig(s); }}
                          style={{ color: previewSig?.key === s.key ? "#67e8f9" : MW.accent, cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 2 }}
                          title="Preview on chart"
                        >
                          {fmtTime(s.time)}
                        </span>
                      </td>
                      {/* Direction */}
                      <td style={{ padding: "5px 8px", color: s.direction === "Long" ? "#26c87a" : "#ef5350", fontWeight: 700, fontSize: 10 }}>
                        <span>{s.direction === "Long" ? "▲ L" : "▼ S"}</span>
                      </td>
                      {/* Risk + MZ badge */}
                      <td style={{ padding: "5px 8px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: rl + "18", color: rl }}>{s.riskLevel}</span>
                          {s.milkOk && <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: "rgba(245,158,11,0.15)", color: "#f59e0b", fontWeight: 700 }}>MZ</span>}
                        </div>
                      </td>
                      {/* Entry */}
                      <td style={{ padding: "5px 8px", color: "#e2e8f0" }}>{s.price.toFixed(2)}</td>
                      {/* TP1 */}
                      <td style={{ padding: "5px 8px", color: "#67e8f9" }}>{s.tp1.toFixed(2)}</td>
                      {/* SL */}
                      <td style={{ padding: "5px 8px", color: "#f87171" }}>{s.sl.toFixed(2)}</td>
                      {/* R:R (TP1/SL) */}
                      <td style={{ padding: "5px 8px", color: MW.muted, fontSize: 10 }}>
                        {(() => {
                          const sl = Math.abs(s.sl - s.price);
                          const tp = Math.abs(s.tp1 - s.price);
                          return sl > 0 ? (tp / sl).toFixed(1) : "—";
                        })()}
                      </td>
                      {/* W/L badge */}
                      <td style={{ padding: "5px 6px" }}>
                        {s.outcome === "Open" ? (
                          <span style={{ fontSize: 9, color: MW.muted }}>—</span>
                        ) : s.outcome === "Win" ? (
                          <span style={{
                            display: "inline-block", minWidth: 20, padding: "1px 5px",
                            borderRadius: 3, fontSize: 9, fontWeight: 800, textAlign: "center",
                            background: s.tpHit === 2 ? "rgba(38,200,122,0.22)" : "rgba(38,200,122,0.14)",
                            color: s.tpHit === 2 ? "#26c87a" : "#4ade80",
                            border: `1px solid ${s.tpHit === 2 ? "rgba(38,200,122,0.6)" : "rgba(74,222,128,0.4)"}`,
                          }}>
                            W{s.tpHit}
                          </span>
                        ) : (
                          <span style={{
                            display: "inline-block", minWidth: 20, padding: "1px 5px",
                            borderRadius: 3, fontSize: 9, fontWeight: 800, textAlign: "center",
                            background: "rgba(239,68,68,0.14)",
                            color: "#ef5350",
                            border: "1px solid rgba(239,68,68,0.4)",
                          }}>
                            L
                          </span>
                        )}
                      </td>
                      {/* P&L */}
                      <td style={{ padding: "5px 8px", color: oc, fontWeight: 700 }}>
                        {s.points !== null ? `${s.points >= 0 ? "+" : ""}${s.points.toFixed(2)}` : "—"}
                      </td>
                      {/* Note indicator */}
                      <td style={{ padding: "5px 8px", fontSize: 10 }}>
                        {ann?.note ? <span style={{ color: MW.muted }}>📝</span> : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Side panel ─────────────────────────────────────────────────── */}
        {selectedSignal && (
          <div style={{ width: 300, flexShrink: 0, borderLeft: `1px solid ${MW.border}`, display: "flex", flexDirection: "column", overflowY: "auto", background: MW.panel }}>
            <SignalDetail
              signal={selectedSignal}
              annotation={annotations[selectedSignal.key]}
              editMode={editMode}
              editNote={editNote}
              setEditNote={setEditNote}
              onSave={(ann) => saveAnnotation(selectedSignal.key, ann)}
              onViewOnChart={() => setPreviewSig(selectedSignal)}
              onClose={() => setSelKey(null)}
              candles={sortedPrimary}
              footprintAlert={footprintAlerts?.[selectedSignal.id as number]} // FOOTPRINT-UI:
            />
          </div>
        )}
      </div>}

      {/* ── Monte Carlo Tab ──────────────────────────────────────────────────── */}
      {activeTab === "montecarlo" && <MonteCarloTab cal={mcCalibration ?? null} />}

      {/* ── Learn toast ───────────────────────────────────────────────────────── */}
      {learnToast && (
        <div style={{
          position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
          zIndex: 999, padding: "8px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700,
          background: "rgba(8,14,24,0.97)", border: "1px solid rgba(34,211,238,0.5)",
          color: "#22d3ee", whiteSpace: "nowrap", boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
          fontFamily: "'Trebuchet MS', monospace",
        }}>
          {learnToast}
          {learnLog && (
            <button onClick={() => setLearnLog(learnLog)} style={{ marginLeft: 10, fontSize: 10, color: "#94a3b8", textDecoration: "underline", background: "none", border: "none", cursor: "pointer" }}>
              View Log
            </button>
          )}
        </div>
      )}

      {/* ── Learn log modal ───────────────────────────────────────────────────── */}
      {learnLog && !learnToast && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.75)" }}
          onClick={() => setLearnLog(null)}
        >
          <div
            style={{ width: 620, maxHeight: "80vh", display: "flex", flexDirection: "column", borderRadius: 8, background: "#090d14", border: "1px solid rgba(34,211,238,0.3)", boxShadow: "0 0 40px rgba(0,0,0,0.9)", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #1a2535", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <GraduationCap size={14} color="#22d3ee" />
                <span style={{ fontSize: 12, fontWeight: 800, color: "#22d3ee", textTransform: "uppercase", letterSpacing: "0.08em" }}>Learning Log</span>
                <span style={{ fontSize: 10, color: MW.muted, padding: "1px 7px", borderRadius: 3, background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.2)" }}>
                  {learnLog.signalCount} signals · {((learnLog.winRate ?? 0) * 100).toFixed(0)}% win rate
                </span>
              </div>
              <button onClick={() => setLearnLog(null)} style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer" }}>
                <XIcon size={16} />
              </button>
            </div>
            {/* Body — insights only */}
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Top insight */}
              <div style={{ padding: "10px 14px", borderRadius: 6, background: "rgba(34,211,238,0.06)", border: "1px solid rgba(34,211,238,0.2)" }}>
                <div style={{ fontSize: 9, color: "#22d3ee", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Top Insight</div>
                <div style={{ fontSize: 12, color: MW.text, lineHeight: 1.6 }}>{learnLog.topInsight}</div>
              </div>
              {/* By tier */}
              {learnLog.byTier && Object.keys(learnLog.byTier).length > 0 && (
                <div>
                  <div style={{ fontSize: 9, color: MW.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Win Rate by Tier</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["safe", "risky", "riskiest"] as const).map(tier => {
                      const d = learnLog.byTier[tier];
                      if (!d) return null;
                      const wr = d.count > 0 ? d.wins / d.count : 0;
                      const col = tier === "safe" ? "#26c87a" : tier === "risky" ? "#f59e0b" : "#ef5350";
                      return (
                        <div key={tier} style={{ flex: 1, padding: "8px 10px", borderRadius: 5, background: "rgba(255,255,255,0.03)", border: `1px solid ${col}33`, textAlign: "center" }}>
                          <div style={{ fontSize: 10, color: col, fontWeight: 700, textTransform: "capitalize" }}>{tier}</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: wr >= 0.5 ? "#26c87a" : "#ef5350" }}>{(wr * 100).toFixed(0)}%</div>
                          <div style={{ fontSize: 9, color: MW.muted }}>{d.wins}/{d.count}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Recent trades */}
              {learnLog.trades && learnLog.trades.length > 0 && (
                <div>
                  <div style={{ fontSize: 9, color: MW.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Recent Trade Notes</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {(learnLog.trades as any[]).slice(0, 8).map((t: any, i: number) => (
                      <div key={i} style={{ padding: "8px 10px", borderRadius: 5, background: "rgba(255,255,255,0.02)", border: "1px solid #1a2535" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: t.direction === "Long" ? "#26c87a" : "#ef5350" }}>{t.direction}</span>
                          <span style={{ fontSize: 9, color: MW.muted }}>{t.riskLevel} · {t.sessionBucket}</span>
                          <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: t.outcome.startsWith("win") ? "#26c87a" : "#ef5350" }}>{t.outcome}</span>
                        </div>
                        <div style={{ fontSize: 10, color: MW.muted, lineHeight: 1.5 }}>{t.whyWorkedOrFailed}</div>
                        {t.watchNextTime && (
                          <div style={{ fontSize: 9, color: "#a78bfa", marginTop: 3 }}>Watch: {t.watchNextTime}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.5); cursor: pointer; }
        input[type="number"]::-webkit-inner-spin-button { opacity: 0.4; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// ── Monte Carlo Tab ───────────────────────────────────────────────────────────
function MonteCarloTab({ cal }: { cal: MCCalibration | null }) {
  const [selTier, setSelTier] = useState<"safe" | "risky" | "riskiest">("safe");
  const MW2 = { bg: "#05080d", panel: "#090d14", border: "#1a2535", text: "#c8d8e8", muted: "#4a6080", accent: "#42a5f5" };
  const tierColor = (t: string) => t === "safe" ? "#26c87a" : t === "risky" ? "#f59e0b" : "#ef5350";
  const REF_ATR = 8.0;
  const TICK_SZ = 0.25;
  const pts = (x: number) => (x * REF_ATR).toFixed(2);
  const ticks = (x: number) => Math.round(x * REF_ATR / TICK_SZ);

  if (!cal) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 40, color: MW2.muted, fontFamily: "'Trebuchet MS', monospace" }}>
        <div style={{ fontSize: 32 }}>📊</div>
        <div style={{ fontSize: 13, color: MW2.text, textAlign: "center" }}>No MC calibration found</div>
        <div style={{ fontSize: 11, color: MW2.muted, textAlign: "center", maxWidth: 320, lineHeight: 1.7 }}>
          Run the calibration engine to generate exit strategy data:
        </div>
        <code style={{ fontSize: 10, padding: "6px 12px", borderRadius: 4, background: "#0d1420", border: "1px solid #1a2535", color: "#22d3ee" }}>
          python exit_strategy.py recalibrate
        </code>
      </div>
    );
  }

  const c = cal[selTier];
  const mult = MC_TIER_MULT[selTier] ?? 1.0;
  const finalSl = Math.max(MC_ATR_FLOOR, c.mae_p70_atr || 0, c.sl_atr) * mult;
  const tp1Use  = c.mfe_p50_atr > 0 ? c.mfe_p50_atr : c.tp1_atr;
  const tp2Use  = c.mfe_p75_atr > 0 ? c.mfe_p75_atr : c.tp2_atr;
  const rr1 = finalSl > 0 ? tp1Use / finalSl : 0;
  const rr2 = finalSl > 0 ? tp2Use / finalSl : 0;
  const evDol = c.ev_tp1 * (REF_ATR / TICK_SZ) * 1.25;

  const firstCal = Object.values(cal)[0];
  const dateRange  = firstCal?.date_range ?? "";
  const calAt      = firstCal?.calibrated_at?.slice(0, 19) ?? "";
  const totalN     = Object.values(cal).reduce((s, t) => s + t.sample_count, 0);

  return (
    <div style={{ flex: 1, overflowY: "auto", fontFamily: "'Trebuchet MS', monospace", color: MW2.text }}>

      {/* Header banner */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #1a2535", background: "#070b11" }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#22d3ee", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>
          Monte Carlo Exit Calibration
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 10, color: MW2.muted }}>
          {dateRange && <span>Range: <span style={{ color: MW2.text }}>{dateRange}</span></span>}
          {calAt     && <span>Calibrated: <span style={{ color: MW2.text }}>{calAt}</span></span>}
          <span>Total signals: <span style={{ color: MW2.text }}>{totalN}</span></span>
          <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.25)", color: "#22d3ee" }}>
            ref ATR = {REF_ATR} pts
          </span>
        </div>
      </div>

      {/* Tier selector */}
      <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid #1a2535" }}>
        {(["safe", "risky", "riskiest"] as const).map(t => {
          const tc = cal[t];
          return (
            <button key={t} onClick={() => setSelTier(t)} style={{
              padding: "5px 14px", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer",
              background: selTier === t ? tierColor(t) + "22" : "transparent",
              border: `1px solid ${selTier === t ? tierColor(t) + "99" : "#1a2535"}`,
              color: selTier === t ? tierColor(t) : MW2.muted,
              fontFamily: "'Trebuchet MS', monospace", textTransform: "uppercase",
            }}>
              {t} <span style={{ fontSize: 9, marginLeft: 4, color: MW2.muted }}>n={tc?.sample_count ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Exit levels overview */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {[
            { label: "Stop Loss", val: `${pts(finalSl)} pts`, sub: `${ticks(finalSl)} ticks · ${finalSl.toFixed(2)}× ATR`, color: "#f87171" },
            { label: "TP1  (50% exit)", val: `${pts(tp1Use)} pts`, sub: `${ticks(tp1Use)} ticks · R:R ${rr1.toFixed(2)}`, color: "#67e8f9" },
            { label: "TP2  (50% exit)", val: `${pts(tp2Use)} pts`, sub: `${ticks(tp2Use)} ticks · R:R ${rr2.toFixed(2)}`, color: "#22d3ee" },
          ].map(({ label, val, sub, color }) => (
            <div key={label} style={{ padding: "10px 12px", borderRadius: 6, background: MW2.panel, border: `1px solid ${color}33`, textAlign: "center" }}>
              <div style={{ fontSize: 9, color: MW2.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 16, fontWeight: 800, color }}>{val}</div>
              <div style={{ fontSize: 9, color: MW2.muted, marginTop: 2 }}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Win rate + EV */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {[
            { label: "Win Rate (TP1)", val: `${(c.win_rate_tp1 * 100).toFixed(1)}%`, color: c.win_rate_tp1 >= 0.5 ? "#26c87a" : "#ef5350" },
            { label: "Win Rate (TP2)", val: `${(c.win_rate_tp2 * 100).toFixed(1)}%`, color: c.win_rate_tp2 >= 0.5 ? "#26c87a" : "#ef5350" },
            { label: "EV / Trade", val: `$${evDol >= 0 ? "+" : ""}${evDol.toFixed(2)}`, color: evDol >= 0 ? "#26c87a" : "#ef5350" },
          ].map(({ label, val, color }) => (
            <div key={label} style={{ padding: "10px 12px", borderRadius: 6, background: MW2.panel, border: "1px solid #1a2535", textAlign: "center" }}>
              <div style={{ fontSize: 9, color: MW2.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 16, fontWeight: 800, color }}>{val}</div>
            </div>
          ))}
        </div>

        {/* 3-Step SL Methodology */}
        <div style={{ padding: "12px 14px", borderRadius: 6, background: "#070b11", border: "1px solid #1a2535" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#f59e0b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            3-Step Stop Loss Methodology
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11 }}>
            <div style={{ display: "flex", gap: 10, padding: "6px 10px", borderRadius: 4, background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.15)" }}>
              <span style={{ color: "#f59e0b", fontWeight: 700, minWidth: 52 }}>Step A</span>
              <span style={{ color: MW2.muted }}>ATR floor: min 1.25× ATR</span>
              <span style={{ marginLeft: "auto", color: MW2.text }}>= {pts(MC_ATR_FLOOR)} pts ({ticks(MC_ATR_FLOOR)} t)</span>
            </div>
            <div style={{ display: "flex", gap: 10, padding: "6px 10px", borderRadius: 4, background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.15)" }}>
              <span style={{ color: "#f59e0b", fontWeight: 700, minWidth: 52 }}>Step B</span>
              <span style={{ color: MW2.muted }}>MC MAE-p70: {(c.mae_p70_atr || 0).toFixed(2)}× ATR</span>
              <span style={{ marginLeft: "auto", color: MW2.text }}>= {pts(c.mae_p70_atr || 0)} pts ({ticks(c.mae_p70_atr || 0)} t)</span>
            </div>
            <div style={{ display: "flex", gap: 10, padding: "6px 10px", borderRadius: 4, background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.15)" }}>
              <span style={{ color: "#f59e0b", fontWeight: 700, minWidth: 52 }}>Step C</span>
              <span style={{ color: MW2.muted }}>Tier multiplier ({selTier}): {mult.toFixed(2)}×</span>
              <span style={{ marginLeft: "auto", color: MW2.text }}>base × {mult.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", gap: 10, padding: "6px 10px", borderRadius: 4, background: "rgba(34,211,238,0.06)", border: "1px solid rgba(34,211,238,0.2)" }}>
              <span style={{ color: "#22d3ee", fontWeight: 700, minWidth: 52 }}>Result</span>
              <span style={{ color: MW2.muted }}>max(A, B, MC-SL) × C</span>
              <span style={{ marginLeft: "auto", color: "#22d3ee", fontWeight: 700 }}>= {pts(finalSl)} pts ({ticks(finalSl)} t)</span>
            </div>
          </div>
        </div>

        {/* TP methodology */}
        <div style={{ padding: "12px 14px", borderRadius: 6, background: "#070b11", border: "1px solid #1a2535" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#67e8f9", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            MFE-Based Take Profits + Partial Exit Plan
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11 }}>
            <div style={{ display: "flex", gap: 10, padding: "6px 10px", borderRadius: 4, background: "rgba(103,232,249,0.05)", border: "1px solid rgba(103,232,249,0.15)" }}>
              <span style={{ color: "#67e8f9", fontWeight: 700, minWidth: 52 }}>TP1</span>
              <span style={{ color: MW2.muted }}>MFE-p50 {c.mfe_p50_atr > 0 ? `= ${c.mfe_p50_atr.toFixed(2)}× ATR` : `(fallback: ${c.tp1_atr.toFixed(2)}× ATR)`}</span>
              <span style={{ marginLeft: "auto", color: "#67e8f9" }}>{pts(tp1Use)} pts · Close 50% here</span>
            </div>
            <div style={{ display: "flex", gap: 10, padding: "6px 10px", borderRadius: 4, background: "rgba(34,211,238,0.05)", border: "1px solid rgba(34,211,238,0.15)" }}>
              <span style={{ color: "#22d3ee", fontWeight: 700, minWidth: 52 }}>BE</span>
              <span style={{ color: MW2.muted }}>Move SL to breakeven once TP1 hit</span>
              <span style={{ marginLeft: "auto", color: MW2.muted }}>entry price</span>
            </div>
            <div style={{ display: "flex", gap: 10, padding: "6px 10px", borderRadius: 4, background: "rgba(34,211,238,0.05)", border: "1px solid rgba(34,211,238,0.15)" }}>
              <span style={{ color: "#22d3ee", fontWeight: 700, minWidth: 52 }}>TP2</span>
              <span style={{ color: MW2.muted }}>MFE-p75 {c.mfe_p75_atr > 0 ? `= ${c.mfe_p75_atr.toFixed(2)}× ATR` : `(fallback: ${c.tp2_atr.toFixed(2)}× ATR)`}</span>
              <span style={{ marginLeft: "auto", color: "#22d3ee" }}>{pts(tp2Use)} pts · Close remaining 50%</span>
            </div>
          </div>
        </div>

        {/* CI + MC stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div style={{ padding: "10px 12px", borderRadius: 6, background: MW2.panel, border: "1px solid #1a2535" }}>
            <div style={{ fontSize: 9, color: MW2.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>95% Confidence Interval (EV)</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: MW2.text }}>
              [{c.ev_ci_low >= 0 ? "+" : ""}{c.ev_ci_low.toFixed(3)}, {c.ev_ci_high >= 0 ? "+" : ""}{c.ev_ci_high.toFixed(3)}] ATR
            </div>
            <div style={{ fontSize: 9, color: MW2.muted, marginTop: 2 }}>
              {c.ev_ci_low > 0 ? "✓ Positive EV with 95% confidence" : "⚠ EV crosses zero — uncertain edge"}
            </div>
          </div>
          <div style={{ padding: "10px 12px", borderRadius: 6, background: MW2.panel, border: "1px solid #1a2535" }}>
            <div style={{ fontSize: 9, color: MW2.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Sample Statistics</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: MW2.text }}>n = {c.sample_count} signals</div>
            <div style={{ fontSize: 9, color: MW2.muted, marginTop: 2 }}>
              {c.sample_count >= 50 ? "HIGH confidence" : c.sample_count >= 20 ? "MEDIUM confidence" : "LOW confidence — needs more data"}
            </div>
          </div>
        </div>

        {/* Top-5 MC grid cells */}
        {c.top5 && c.top5.length > 0 && (
          <div style={{ padding: "12px 14px", borderRadius: 6, background: "#070b11", border: "1px solid #1a2535" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#a78bfa", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
              Top-5 MC Grid Cells (bootstrap optimum)
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1a2535" }}>
                  {["#", "TP (×ATR)", "SL (×ATR)", "EV", "Win%"].map(h => (
                    <th key={h} style={{ padding: "3px 8px", textAlign: "left", fontSize: 9, color: MW2.muted, fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.top5.map((row, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #0d1420", background: i === 0 ? "rgba(167,139,250,0.05)" : "transparent" }}>
                    <td style={{ padding: "4px 8px", color: i === 0 ? "#a78bfa" : MW2.muted }}>{i + 1}</td>
                    <td style={{ padding: "4px 8px", color: "#22d3ee" }}>{row.tp_atr.toFixed(2)}×</td>
                    <td style={{ padding: "4px 8px", color: "#f87171" }}>{row.sl_atr.toFixed(2)}×</td>
                    <td style={{ padding: "4px 8px", color: row.ev >= 0 ? "#26c87a" : "#ef5350", fontWeight: i === 0 ? 700 : 400 }}>
                      {row.ev >= 0 ? "+" : ""}{row.ev.toFixed(4)}
                    </td>
                    <td style={{ padding: "4px 8px", color: row.wr >= 0.5 ? "#26c87a" : "#ef5350" }}>{(row.wr * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Pattern analysis ──────────────────────────────────────────────────────────
interface PatternResult { name: string; bias: "bull" | "bear" | "neutral"; strength: "strong" | "moderate" | "weak" }

function detectPatterns(open: number, high: number, low: number, close: number, direction: "Long" | "Short"): PatternResult[] {
  const body        = Math.abs(close - open);
  const range       = high - low;
  if (range < 0.01) return [{ name: "Flat / No Range", bias: "neutral", strength: "weak" }];
  const upperShadow = high - Math.max(open, close);
  const lowerShadow = Math.min(open, close) - low;
  const bodyPct     = body / range;
  const isBull      = close >= open;
  const results: PatternResult[] = [];

  // Doji variants
  if (bodyPct < 0.08) {
    if (lowerShadow > upperShadow * 2.5) results.push({ name: "Dragonfly Doji", bias: "bull", strength: "strong" });
    else if (upperShadow > lowerShadow * 2.5) results.push({ name: "Gravestone Doji", bias: "bear", strength: "strong" });
    else results.push({ name: "Doji", bias: "neutral", strength: "moderate" });
  }

  // Hammer (long lower wick, small body near top, direction-aware name)
  if (lowerShadow > body * 2.2 && upperShadow < body * 0.6 && bodyPct < 0.35) {
    results.push({ name: direction === "Long" ? "Hammer" : "Hanging Man", bias: "bull", strength: lowerShadow / range > 0.6 ? "strong" : "moderate" });
  }

  // Shooting Star / Inverted Hammer (long upper wick, small body near bottom)
  if (upperShadow > body * 2.2 && lowerShadow < body * 0.6 && bodyPct < 0.35) {
    results.push({ name: direction === "Short" ? "Shooting Star" : "Inverted Hammer", bias: "bear", strength: upperShadow / range > 0.6 ? "strong" : "moderate" });
  }

  // Pin bar (dominant shadow > 60% of full range)
  if (lowerShadow / range > 0.62 && results.length === 0) results.push({ name: "Bull Pin Bar", bias: "bull", strength: "strong" });
  if (upperShadow / range > 0.62 && results.length === 0) results.push({ name: "Bear Pin Bar", bias: "bear", strength: "strong" });

  // Strong body (marubozu-like): tiny wicks
  if (bodyPct > 0.80) {
    results.push({ name: isBull ? "Strong Bull Candle" : "Strong Bear Candle", bias: isBull ? "bull" : "bear", strength: bodyPct > 0.90 ? "strong" : "moderate" });
  } else if (bodyPct > 0.55 && results.length === 0) {
    results.push({ name: isBull ? "Bull Body" : "Bear Body", bias: isBull ? "bull" : "bear", strength: "moderate" });
  }

  // Body momentum (as % move)
  const bodyMoveStr = ((body / open) * 100).toFixed(2) + "%";
  results.push({ name: `Body move: ${bodyMoveStr}`, bias: isBull ? "bull" : "bear", strength: "weak" });

  if (results.length === 0) results.push({ name: "No clear pattern", bias: "neutral", strength: "weak" });
  return results;
}

// ── Side panel detail ──────────────────────────────────────────────────────────
interface DetailProps {
  signal: SignalEntry;
  annotation?: Annotation;
  editMode: boolean;
  editNote: string;
  setEditNote: (s: string) => void;
  onSave: (ann: Annotation) => void;
  onViewOnChart: () => void;
  onClose: () => void;
  candles: CandleBar[];
  footprintAlert?: { pocPrice: number; message: string }; // FOOTPRINT-UI:
}

const FEEDBACK_REASONS = [
  "", // no reason (default)
  "Zone invalidated",
  "Against dominant trend",
  "Chop / no clear direction",
  "Missed entry timing",
  "FUD / news event",
  "Wrong timeframe",
  "Late entry",
  "SL too tight",
  "Other",
] as const;

function SignalDetail({ signal: s, annotation, editMode, editNote, setEditNote, onSave, onViewOnChart, onClose, candles, footprintAlert }: DetailProps) { // FOOTPRINT-UI:
  const isFpDegraded = false; // reclassifyReason removed
  const rlC = s.riskLevel === "safe" ? (isFpDegraded ? "rgba(38,200,122,0.65)" : "#26c87a") : s.riskLevel === "risky" ? "#f59e0b" : "#ef4444"; // FIX: 65% opacity for footprint-degraded SAFE
  const ocC = s.outcome === "Win" ? "#26c87a" : s.outcome === "Loss" ? "#ef5350" : MW.muted;
  const isBad = annotation?.markedBad ?? false;

  const [feedbackReason, setFeedbackReason] = useState((annotation as any)?.reason ?? "");
  const [teachState, setTeachState]   = useState<"idle" | "loading" | "done" | "error">("idle");
  const [teachLesson, setTeachLesson] = useState("");

  const saveWithServer = (ann: Annotation) => {
    onSave(ann);
    fetch("/api/signals/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: s.key, time: s.time, direction: s.direction,
        riskLevel: s.riskLevel, outcome: s.outcome,
        isBad: ann.markedBad, reason: ann.reason ?? feedbackReason, note: ann.note,
      }),
    }).catch(() => {});
  };

  const handleTeach = async () => {
    if (!editNote.trim()) return;
    saveWithServer({ note: editNote, markedBad: isBad, reason: feedbackReason });
    setTeachState("loading");
    try {
      const r = await fetch("/api/ai/teach-signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal: s, note: editNote }),
      });
      const text = await r.text();
      if (text.trimStart().startsWith("<")) {
        setTeachLesson("Server needs restart — stop and re-run `npm run dev`");
        setTeachState("error");
        return;
      }
      const data = JSON.parse(text);
      if (data.lesson) { setTeachLesson(data.lesson); setTeachState("done"); }
      else { setTeachLesson(data.error ?? "No response from server"); setTeachState("error"); }
    } catch (e: any) {
      setTeachLesson(e.message ?? "Network error");
      setTeachState("error");
    }
  };

  const row = (label: string, value: string, color: string) => (
    <>
      <span style={{ color: MW.muted }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </>
  );

  return (
    <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>

      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: s.direction === "Long" ? "#26c87a" : "#ef5350" }}>
          {s.direction === "Long" ? "▲ LONG" : "▼ SHORT"}
        </span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 15, padding: 0, lineHeight: 1 }}>✕</button>
      </div>

      {/* Timestamp */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 11, color: MW.text, fontWeight: 700 }}>{fmtDateFull(s.time)}</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: MW.accent }}>{fmtTime(s.time)} ET</span>
          <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: s.rth ? "rgba(245,158,11,0.12)" : "rgba(99,102,241,0.12)", color: s.rth ? "#f59e0b" : "#818cf8" }}>
            {s.rth ? "RTH" : "ETH"}
          </span>
          <span style={{ fontSize: 9, color: MW.muted }}>{s.interval}</span>
        </div>
      </div>

      <div style={{ height: 1, background: MW.border }} />

      {/* Price grid */}
      <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", rowGap: 5, fontSize: 11 }}>
        {row("Open",  s.open.toFixed(2),  "#c8d8e8")}
        {row("Close", s.price.toFixed(2), "#e2e8f0")}
        {row("TP1",   s.tp1.toFixed(2),   "#67e8f9")}
        {row("TP2",   s.tp2.toFixed(2),   "#22d3ee")}
        {row("Stop",  s.sl.toFixed(2),    "#f87171")}
        {row("R:R",   `1 : ${(Math.abs(s.tp2 - s.price) / Math.max(Math.abs(s.sl - s.price), 0.01)).toFixed(1)}`, MW.text)}
        {s.confidence != null && row("Confidence", `${s.confidence}%`, s.confidence >= 90 ? "#26c87a" : s.confidence >= 75 ? "#f59e0b" : MW.muted)}
      </div>

      <div style={{ height: 1, background: MW.border }} />

      {/* Why signal fired */}
      <div>
        <div style={{ fontSize: 9, color: MW.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 7 }}>Why Signal Fired</div>
        {/* Zones loaded badge — tells user whether dated milk zones were active at compute time */}
        <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
            background: s.zonesLoaded ? "rgba(38,200,122,0.12)" : "rgba(100,116,139,0.12)",
            color: s.zonesLoaded ? "#26c87a" : MW.muted,
            border: `1px solid ${s.zonesLoaded ? "rgba(38,200,122,0.35)" : "rgba(100,116,139,0.25)"}`,
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            {s.zonesLoaded ? "Zones Active" : "No Zones Loaded"}
          </span>
          {!s.zonesLoaded && s.milkOk && (
            <span style={{ fontSize: 9, color: "#f59e0b" }}>⚠ zone data unavailable at signal time</span>
          )}
        </div>
        {[
          { ok: true,                  label: "Primary Vector",             sub: "always required"           },
          { ok: s.milkOk,              label: "Milk Zone",                  sub: "FVG / Order Block / Struct" },
          { ok: s.secondaryVecOk,      label: "Secondary Timeframe Vector", sub: "multi-TF confluence"       },
        ].map(({ ok, label, sub }) => (
          <div key={label} style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 5 }}>
            <span style={{ fontSize: 13, lineHeight: 1, color: ok ? "#26c87a" : MW.muted, marginTop: 1 }}>{ok ? "✓" : "○"}</span>
            <div>
              <div style={{ fontSize: 11, color: ok ? MW.text : MW.muted }}>{label}</div>
              <div style={{ fontSize: 9, color: MW.muted }}>{sub}</div>
            </div>
          </div>
        ))}
        {/* RISKIEST warning: no MilkZone or Vector confirmed */}
        {s.riskLevel === "riskiest" && (
          <div style={{ marginTop: 4, fontSize: 10, color: "#f87171", background: "rgba(239,68,68,0.07)", borderRadius: 4, padding: "5px 8px", border: "1px solid rgba(239,68,68,0.18)" }}>
            ⚠ Pattern-only signal — no Zone, Vector, or Footprint confirmation present {/* FIX: added Footprint to warning */}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: MW.border }} />

      {/* FOOTPRINT-UI: Footprint order-flow section */}
      {(() => { // FOOTPRINT-UI:
        const fp = s.footprintReading ? (() => { try { return JSON.parse(s.footprintReading as string); } catch { return null; } })() : null; // FOOTPRINT-UI:
        if (!fp) return null; // FOOTPRINT-UI: no footprint data yet — section hidden
        const fpColor = fp.vetoed ? "#ef4444" : fp.confirmed ? "#26c87a" : fp.partial ? "#f59e0b" : MW.muted; // FOOTPRINT-UI:
        const fpLabel = fp.vetoed ? `✗ Vetoed — ${fp.vetoReason ?? "delta divergence"}` // FOOTPRINT-UI:
          : fp.confirmed ? "✓ Footprint confirmed" : "◐ Footprint partial — delta agrees, no bonus yet"; // FOOTPRINT-UI:
        return ( // FOOTPRINT-UI:
          <div> {/* FOOTPRINT-UI: */}
            <div style={{ fontSize: 9, color: MW.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 7 }}>Footprint</div>
            {/* mid-trade divergence amber banner */} {/* FOOTPRINT-UI: */}
            {footprintAlert && ( // FOOTPRINT-UI:
              <div style={{ marginBottom: 6, fontSize: 10, color: "#f59e0b", background: "rgba(245,158,11,0.08)", borderRadius: 4, padding: "5px 8px", border: "1px solid rgba(245,158,11,0.3)" }}> {/* FOOTPRINT-UI: */}
                ⚠ Mid-trade divergence — tighten stop to POC ({footprintAlert.pocPrice.toFixed(2)}) {/* FOOTPRINT-UI: */}
              </div> // FOOTPRINT-UI:
            )} {/* FOOTPRINT-UI: */}
            <div style={{ fontSize: 11, color: fpColor, marginBottom: 4 }}>{fpLabel}</div> {/* FOOTPRINT-UI: */}
            <div style={{ display: "flex", gap: 12, marginBottom: 4 }}> {/* FOOTPRINT-UI: */}
              <span style={{ fontSize: 10, color: MW.muted }}>Delta: <span style={{ color: fp.candleDelta >= 0 ? "#26c87a" : "#ef5350", fontWeight: 600 }}>{fp.candleDelta >= 0 ? "+" : ""}{fp.candleDelta}</span></span> {/* FOOTPRINT-UI: */}
              <span style={{ fontSize: 10, color: MW.muted }}>POC: <span style={{ color: MW.text }}>{fp.poc.toFixed(2)}</span></span> {/* FOOTPRINT-UI: */}
            </div> {/* FOOTPRINT-UI: */}
            {fp.exitAdjustments?.usePocStop && fp.exitAdjustments.pocStopPrice != null && ( // FOOTPRINT-UI:
              <div style={{ fontSize: 10, color: "#60a5fa", marginBottom: 2 }}>Stop: {fp.exitAdjustments.pocStopPrice.toFixed(2)} (POC-based)</div> // FOOTPRINT-UI:
            )} {/* FOOTPRINT-UI: */}
            {fp.exitAdjustments?.tp1Override != null && ( // FOOTPRINT-UI:
              <div style={{ fontSize: 10, color: "#a78bfa", marginBottom: 2 }}>TP1 → unfinished auction at {fp.exitAdjustments.tp1Override.toFixed(2)}</div> // FOOTPRINT-UI:
            )} {/* FOOTPRINT-UI: */}
            {fp.exitAdjustments?.tp2Extension != null && ( // FOOTPRINT-UI:
              <div style={{ fontSize: 10, color: "#a78bfa", marginBottom: 2 }}>TP2 extended {(fp.exitAdjustments.tp2Extension * 100).toFixed(0)}% — stacked imbalances</div> // FOOTPRINT-UI:
            )} {/* FOOTPRINT-UI: */}
          </div> // FOOTPRINT-UI:
        ); // FOOTPRINT-UI:
      })()} {/* FOOTPRINT-UI: */}

      {/* FOOTPRINT-UI: separator only when footprint data present */}
      {s.footprintReading && <div style={{ height: 1, background: MW.border }} />} {/* FOOTPRINT-UI: */}

      {/* Pattern Analysis */}
      {(() => {
        const patterns = detectPatterns(s.open, s.high, s.low, s.price, s.direction);
        const biasColor = (b: "bull" | "bear" | "neutral") => b === "bull" ? "#26c87a" : b === "bear" ? "#ef5350" : MW.muted;
        const strengthDot = (str: "strong" | "moderate" | "weak") =>
          str === "strong" ? "●●●" : str === "moderate" ? "●●○" : "●○○";

        // Count how many candles in history produced the same pattern name (excluding this candle)
        const patternCounts = new Map<string, number>();
        if (candles.length > 1) {
          for (const c of candles) {
            if (c.time === s.time) continue;
            const ps = detectPatterns(c.open, c.high, c.low, c.close, s.direction);
            for (const p of ps) {
              if (p.name.startsWith("Body move:")) continue; // skip the body % line
              patternCounts.set(p.name, (patternCounts.get(p.name) ?? 0) + 1);
            }
          }
        }

        return (
          <div>
            <div style={{ fontSize: 9, color: MW.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 7 }}>Pattern Analysis</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {patterns.map((p, i) => {
                const isBodyLine = p.name.startsWith("Body move:");
                const count = isBodyLine ? null : (patternCounts.get(p.name) ?? null);
                return (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", borderRadius: 4, background: "rgba(255,255,255,0.02)", border: `1px solid ${MW.border}` }}>
                    <span style={{ fontSize: 11, color: biasColor(p.bias), fontWeight: p.strength === "strong" ? 700 : 400 }}>{p.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {!isBodyLine && (
                        <span style={{ fontSize: 9, color: MW.muted }}>
                          {candles.length <= 1 ? "N/A" : count != null ? `×${count} seen` : "N/A"}
                        </span>
                      )}
                      <span style={{ fontSize: 9, color: biasColor(p.bias), letterSpacing: "0.04em", opacity: 0.7 }}>{strengthDot(p.strength)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 5, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, fontSize: 10 }}>
              <div style={{ textAlign: "center", padding: "3px 0", background: "rgba(255,255,255,0.02)", borderRadius: 3 }}>
                <div style={{ color: MW.muted, fontSize: 9 }}>Open</div>
                <div style={{ color: MW.text }}>{s.open.toFixed(2)}</div>
              </div>
              <div style={{ textAlign: "center", padding: "3px 0", background: "rgba(255,255,255,0.02)", borderRadius: 3 }}>
                <div style={{ color: MW.muted, fontSize: 9 }}>High</div>
                <div style={{ color: "#26c87a" }}>{s.high.toFixed(2)}</div>
              </div>
              <div style={{ textAlign: "center", padding: "3px 0", background: "rgba(255,255,255,0.02)", borderRadius: 3 }}>
                <div style={{ color: MW.muted, fontSize: 9 }}>Low</div>
                <div style={{ color: "#ef5350" }}>{s.low.toFixed(2)}</div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Strength + risk */}
      <div>
        <div style={{ fontSize: 9, color: MW.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Strength & Risk</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 5 }}>
          <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: rlC + "18", color: rlC }}>{s.riskLevel}</span>
          <span style={{ fontSize: 10, color: MW.muted }}>
            {s.riskLevel === "safe" ? "Zone + Vector + Footprint confirmed" : s.riskLevel === "risky" ? "One of Zone / Vector / Footprint" : "No Zone, Vector, or Footprint"} {/* FIX: updated tier descriptions to include Footprint */}
          </span>
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 10 }}>
          <span style={{ color: MW.muted }}>Stop: <span style={{ color: "#f87171" }}>{Math.abs(s.sl - s.price).toFixed(2)} pts</span></span>
          <span style={{ color: MW.muted }}>Target: <span style={{ color: "#22d3ee" }}>{Math.abs(s.tp2 - s.price).toFixed(2)} pts</span></span>
        </div>
      </div>

      {/* Outcome */}
      <div style={{ padding: "8px 10px", borderRadius: 5, background: s.outcome === "Win" ? "rgba(38,200,122,0.07)" : s.outcome === "Loss" ? "rgba(239,83,80,0.07)" : "rgba(255,255,255,0.03)", border: `1px solid ${s.outcome === "Win" ? "rgba(38,200,122,0.18)" : s.outcome === "Loss" ? "rgba(239,83,80,0.18)" : MW.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 9, color: MW.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Result</span>
          <div style={{ fontSize: 12, fontWeight: 700, color: s.outcome === "Win" ? "#26c87a" : s.outcome === "Loss" ? "#ef5350" : MW.muted }}>
            {s.outcome === "Open" ? "Still Open" : s.outcome}
            {s.points !== null && (
              <span style={{ marginLeft: 6, fontSize: 11 }}>{s.points >= 0 ? "+" : ""}{s.points.toFixed(2)} pts</span>
            )}
          </div>
        </div>
      </div>

      {/* Edit mode annotation */}
      {editMode && (
        <div>
          <div style={{ fontSize: 9, color: "#a78bfa", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Trade Feedback</div>
          {/* Reason dropdown */}
          <select
            value={feedbackReason}
            onChange={e => setFeedbackReason(e.target.value)}
            style={{ width: "100%", padding: "5px 8px", borderRadius: 4, fontSize: 11, marginBottom: 6, background: "#0d1420", border: `1px solid ${MW.border}`, color: feedbackReason ? MW.text : MW.muted, fontFamily: "'Trebuchet MS', monospace" }}
          >
            <option value="">Reason for review…</option>
            {FEEDBACK_REASONS.slice(1).map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <textarea
            value={editNote}
            onChange={e => { setEditNote(e.target.value); if (teachState !== "idle") setTeachState("idle"); }}
            placeholder="Additional notes — what you noticed, what the market was doing..."
            rows={3}
            style={{ width: "100%", padding: "6px 8px", borderRadius: 4, fontSize: 11, resize: "vertical", boxSizing: "border-box", background: "#0d1420", border: `1px solid ${MW.border}`, color: MW.text, fontFamily: "'Trebuchet MS', monospace", outline: "none" }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              onClick={() => saveWithServer({ note: editNote, markedBad: true, reason: feedbackReason })}
              style={{ flex: 1, padding: "4px 0", borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: "'Trebuchet MS', monospace", background: isBad ? "rgba(239,83,80,0.18)" : "transparent", border: `1px solid ${isBad ? "#ef5350" : MW.border}`, color: isBad ? "#ef5350" : MW.muted }}
            >{isBad ? "● Marked Bad" : "Mark as Bad"}</button>
            <button
              onClick={() => { saveWithServer({ note: editNote, markedBad: isBad, reason: feedbackReason }); handleTeach(); }}
              disabled={teachState === "loading" || !editNote.trim()}
              style={{
                flex: 1, padding: "4px 0", borderRadius: 4, fontSize: 11, cursor: teachState === "loading" ? "default" : "pointer",
                fontFamily: "'Trebuchet MS', monospace",
                background: teachState === "done"    ? "rgba(167,139,250,0.22)"
                           : teachState === "error"   ? "rgba(239,83,80,0.12)"
                           : teachState === "loading" ? "rgba(167,139,250,0.08)"
                           : "rgba(167,139,250,0.12)",
                border: `1px solid ${teachState === "done" ? "#a78bfa" : teachState === "error" ? "#ef5350" : "#a78bfa66"}`,
                color: teachState === "done" ? "#a78bfa" : teachState === "error" ? "#ef5350" : "#a78bfa",
                opacity: !editNote.trim() ? 0.4 : 1,
              }}
            >
              {teachState === "loading" ? "Teaching…" : teachState === "done" ? "✓ Taught" : "Teach"}
            </button>
          </div>

          {/* Claude's lesson */}
          {teachState === "done" && teachLesson && (
            <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 5, background: "rgba(167,139,250,0.07)", border: "1px solid rgba(167,139,250,0.25)" }}>
              <div style={{ fontSize: 9, color: "#a78bfa", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 }}>Learned</div>
              <div style={{ fontSize: 10, color: MW.text, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{teachLesson}</div>
            </div>
          )}
          {teachState === "error" && (
            <div style={{ marginTop: 6, fontSize: 10, color: "#ef5350" }}>Error: {teachLesson}</div>
          )}
        </div>
      )}

      {/* Annotation display (read mode) */}
      {!editMode && annotation && (annotation.note || annotation.markedBad || annotation.reason) && (
        <div style={{ borderTop: `1px solid ${MW.border}`, paddingTop: 8 }}>
          {annotation.markedBad && <div style={{ fontSize: 10, color: "#ef5350", fontWeight: 600, marginBottom: 3 }}>● Marked as bad trade</div>}
          {annotation.reason && <div style={{ fontSize: 10, color: "#f59e0b", marginBottom: 3 }}>Reason: {annotation.reason}</div>}
          {annotation.note && <div style={{ fontSize: 11, color: MW.muted, lineHeight: 1.6 }}>{annotation.note}</div>}
        </div>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* View on Chart — opens popup preview to the left */}
      <button
        onClick={onViewOnChart}
        style={{ padding: "8px 0", borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: "pointer", background: "rgba(66,165,245,0.12)", border: `1px solid rgba(66,165,245,0.4)`, color: MW.accent, fontFamily: "'Trebuchet MS', monospace", letterSpacing: "0.02em" }}
      >
        View on Chart
      </button>
    </div>
  );
}
