import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { normalizeSymbol } from "@shared/symbol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CandlestickChart,
  type CandleBar,
  type ChartHandle,
  type ZoneOverlay,
  type BandOverlay,
  type ZoneBand,
  type DrawingTool,
  type Drawing,
  type RectDrawing,
  type TradeSegment,
  type ChartTheme,
  type SignalClickInfo,
  CHART_THEMES,
} from "@/components/CandlestickChart";
import SignalsPanel, { type ExternalSignal } from "@/components/SignalsPanel";
import FootprintLadder from "@/components/FootprintLadder";
import StrategyGuardDialog from "@/components/StrategyGuardDialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Link, useLocation } from "wouter";
import {
  BarChart3,
  Search,
  ChevronLeft,
  ChevronRight,
  Database,
  Newspaper,
  MousePointer2,
  Minus,
  Square,
  GitBranch,
  Pencil,
  Maximize2,
  Trash2,
  Undo2,
  LayoutTemplate,
  Settings,
  X,
  Clock,
  RefreshCw,
  FlaskConical,
  MessageSquare,
  BookOpen,
  ClipboardList,
  Crosshair,
} from "lucide-react";

import { analyzeFootprint, buildProxyFootprintCandle, setFootprintDataConfirmed, FOOTPRINT_DATA_CONFIRMED, IMBALANCE_THRESHOLD, MW_IMBALANCE_THRESHOLDS, NET_THRESHOLDS, PROXY_TIER2, PROXY_TIER3, getCurrentSessionType, getLastCompletedSession, buildFrozenImbalances, updateMitigation, type FrozenImbalanceZone, type FootprintCandle, type ImbalanceCluster, type FootprintReading, type PriceLevelData } from "@/lib/footprint-analysis"; // FOOTPRINT-STRATEGY:

// ── Types ─────────────────────────────────────────────────────────────────
interface SymbolInfo { symbol: string; name: string }
interface SymbolsData { stocks: SymbolInfo[]; etfs: SymbolInfo[]; futures: SymbolInfo[]; indices: SymbolInfo[] }
interface DayInfo { date: string; open: number; high: number; low: number; close: number; volume: number }

interface VectorSignal {
  time: number; entryPrice: number;
  tp1: number; tp2: number; stopInitial: number;
}

// ── RTH helper — Mon-Fri, 9:30 AM – 4:00 PM ET (DST-safe via Intl) ───────────
// Must use America/New_York, NOT a hardcoded UTC offset: 9:30 ET is 13:30 UTC in summer
// (EDT) but 14:30 UTC in winter (EST), so a fixed 13:30–20:00 UTC window is an hour off
// for ~5 months of the year.
const _rthWeekdayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
function isRTH(timestampSec: number): boolean {
  const parts = _rthWeekdayFmt.formatToParts(new Date(timestampSec * 1000));
  const wd = parts.find(p => p.type === "weekday")?.value ?? "";
  if (wd === "Sat" || wd === "Sun") return false;
  const h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 17 * 60; // 9:30 AM – 5:00 PM ET
}

// Reuse a single Intl formatter — creating one per call is very expensive in hot loops
const _etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
});
/** CME ES/MES settlement break: 4:30pm–6:00pm ET — no signals should fire here. */
function isMarketBreak(timestampSec: number): boolean {
  const d = new Date(timestampSec * 1000);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return false;
  const et = _etFmt.format(d);
  const col = et.indexOf(":");
  const etMins = parseInt(et.slice(0, col)) * 60 + parseInt(et.slice(col + 1));
  return etMins >= 16 * 60 + 30 && etMins < 18 * 60;
}
/** User rule: no signals at or after 3:15 PM ET — too risky into the RTH close. */
function isAfter315ET(timestampSec: number): boolean {
  const et = _etFmt.format(new Date(timestampSec * 1000));
  const col = et.indexOf(":");
  const etMins = parseInt(et.slice(0, col)) * 60 + parseInt(et.slice(col + 1));
  return etMins >= 15 * 60 + 15; // 3:15 PM ET
}


const RISK_QUALITY: Record<string, number> = { safeplus: 4, safe: 3, risky: 2, riskiest: 1 };

// ── Milk Zone detector ────────────────────────────────────────────────────
// Reverse-engineered from 15,000+ Milk Yellow Box MWML zones.
// Detects three zone types that match Milk's intraday charting:
//   1. Fair Value Gap  (IMBALANCE)  — gap between candle[i-1] and candle[i+1]
//   2. Order Block     (ABSORPTION / RESISTIVE) — last candle before a big move
//   3. Structural level (STRUCTURAL) — swing high/low with ≥3 confirming bars each side
// historyBars: how many recent RTH bars to scan (0 = all). displayCap: max zones returned (0 = all).
/** Returns the Unix timestamp of 21:00 UTC (RTH close) on the same calendar day as `ts`. */
function rthCloseOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 21 * 3600;
}
/** Returns the Unix timestamp of 20:30 UTC (4:30 PM EDT / CME settlement) on the same calendar day as `ts`.
 *  Milk zones are scoped to the regular session and must end at market close (4:30 PM ET). */
function rthSettleOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 20 * 3600 + 30 * 60;
}
/** Returns the Unix timestamp of 13:30 UTC (9:30 AM ET / RTH open) on the same calendar day as `ts`. */
function rthOpenOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 13 * 3600 + 30 * 60;
}

function detectMilkZones(candles: CandleBar[], historyBars = 234, displayCap = 60): ZoneBand[] {
  const rth = [...candles].sort((a, b) => a.time - b.time).filter(c => c.rth !== false);
  const zones: ZoneBand[] = [];
  const BAR_INT = 5 * 60; // 5-minute bar = 300 s

  // Pre-build map of UTC calendar day → last RTH bar timestamp BEFORE 4:30 PM ET (20:30 UTC).
  // isRTH() runs to 21:00 UTC (5:00 PM ET) but we cap zones at 4:30 PM ET.
  // Using an actual bar timestamp guarantees timeToCoordinate() succeeds —
  // rthSettleOfDay() (20:30 UTC) falls in the CME break where no bars exist.
  const lastRthBarBefore430 = new Map<number, number>();
  for (const c of rth) {
    const secsIntoDay = c.time % 86400;
    if (secsIntoDay >= 20 * 3600 + 30 * 60) continue; // skip bars at/after 4:30 PM ET
    const day = Math.floor(c.time / 86400);
    lastRthBarBefore430.set(day, c.time); // later bars overwrite → map holds the last one before 4:30
  }
  const sessionEndOf = (ts: number): number =>
    lastRthBarBefore430.get(Math.floor(ts / 86400)) ?? rthSettleOfDay(ts);

  // 14-period ATR
  const atrAt = (i: number): number => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - 13); j <= i; j++) {
      const b = rth[j], p = j > 0 ? rth[j - 1] : b;
      s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
      n++;
    }
    return n > 0 ? s / n : 2;
  };

  const startIdx = historyBars > 0 ? Math.max(0, rth.length - historyBars) : 0;

  for (let i = startIdx + 1; i < rth.length - 1; i++) {
    const prev = rth[i - 1], curr = rth[i], next = rth[i + 1];
    const atr  = atrAt(i);

    // ── 1. Fair Value Gap (Imbalance) ────────────────────────────────────
    // Bullish FVG: gap up — [i-1].high < [i+1].low
    // toTime: 24 bars forward (no dayRthClose cap — zones are multi-session levels)
    if (prev.high < next.low && next.low - prev.high >= 0.5) {
      zones.push({
        topPrice:    next.low,
        bottomPrice: prev.high,
        color:       "#22c55e",
        label:       "IMBALANCE",
        fromTime:    curr.time,
        toTime:      sessionEndOf(curr.time),
      });
    }
    // Bearish FVG: gap down — [i-1].low > [i+1].high
    if (prev.low > next.high && prev.low - next.high >= 0.5) {
      zones.push({
        topPrice:    prev.low,
        bottomPrice: next.high,
        color:       "#ef4444",
        label:       "RESIST IMBALANCE",
        fromTime:    curr.time,
        toTime:      sessionEndOf(curr.time),
      });
    }

    // ── 2. Order Blocks ──────────────────────────────────────────────────
    // Bullish OB: bearish candle followed by strong up move
    if (curr.close < curr.open) {
      let maxUp = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++)
        maxUp = Math.max(maxUp, rth[j].high - curr.high);
      if (maxUp >= atr * 1.5) {
        zones.push({
          topPrice:    Math.max(curr.open, curr.close),
          bottomPrice: curr.low,
          color:       "#3b82f6",
          label:       "ABSORPTION",
          fromTime:    curr.time,
          toTime:      sessionEndOf(curr.time),
        });
      }
    }
    // Bearish OB: bullish candle followed by strong down move
    if (curr.close > curr.open) {
      let maxDown = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++)
        maxDown = Math.max(maxDown, curr.low - rth[j].low);
      if (maxDown >= atr * 1.5) {
        zones.push({
          topPrice:    curr.high,
          bottomPrice: Math.min(curr.open, curr.close),
          color:       "#f97316",  // orange — distinct from FVG red
          label:       "RESISTIVE",
          fromTime:    curr.time,
          toTime:      sessionEndOf(curr.time),
        });
      }
    }

    // ── 3. Structural Highs/Lows ─────────────────────────────────────────
    // toTime: extend 30 days forward so zones stay visible across sessions
    const LB = 3; // bars on each side needed for a swing
    let isHigh = true, isLow = true;
    for (let j = Math.max(0, i - LB); j < i; j++) {
      if (rth[j].high >= curr.high) isHigh = false;
      if (rth[j].low  <= curr.low)  isLow  = false;
    }
    for (let j = i + 1; j <= Math.min(rth.length - 1, i + LB); j++) {
      if (rth[j].high >= curr.high) isHigh = false;
      if (rth[j].low  <= curr.low)  isLow  = false;
    }
    const sz = Math.max(atr * 0.25, 1.5);
    if (isHigh) {
      zones.push({
        topPrice:    curr.high + sz * 0.15,
        bottomPrice: curr.high - sz,
        color:       "#f43f5e",  // rose — distinct from FVG/OB red
        label:       "STRUCTURAL RESIST",
        fromTime:    curr.time,
        toTime:      sessionEndOf(curr.time),
      });
    }
    if (isLow) {
      zones.push({
        topPrice:    curr.low + sz,
        bottomPrice: curr.low - sz * 0.15,
        color:       "#14b8a6",  // teal — distinct from FVG green
        label:       "STRUCTURAL SUPPORT",
        fromTime:    curr.time,
        toTime:      sessionEndOf(curr.time),
      });
    }
  }

  return displayCap > 0 ? zones.slice(-displayCap) : zones;
}

// ── Constants ─────────────────────────────────────────────────────────────
// Monte Carlo calibrated on real MES 5m data (222 signals, June 2025–Apr 2026):
//   TP=10pts / SL=5pts → 32% WR baseline; with milk zone price filter → ~50-60% WR
//   TP=20pts / SL=5pts → 4:1 R:R, 2.05 expected pts/trade (best fixed-point config)
// Safe signals (high confluence) get a bonus +2.5 on TP1 (10 → 12.5).
const TP_FIXED_1_SAFE    = 12.5;  // TP1 for safe signals (strong confluence, zone + vec + imbalance)
const TP_FIXED_1         = 10.0;  // TP1 for risky/riskiest signals
const TP_FIXED_2         = 20.0;  // TP2: 20 pts (cap — market can't always extend)
const SL_FIXED           = 5.0;   // SL: 5 pts (20 ticks, $25/MES)
const MILK_TOLERANCE_PTS = 2.0;  // zone price proximity tolerance (8 ticks)

// ── Exit strategy profiles — tier-aware TP/SL (2026-05-08) ──────────────────────────────────
// Each global profile (Tight/Standard/Wide) contains per-signal-tier exits.
// SAFE+: tightest SL, most aggressive TP (FP-on-zone confirmed).
// SAFE:  standard; matches prior tp1Safe baseline.
// RISKY: wider SL, conservative TP1 (lower confidence).
// RISKIEST: swing-wide exits; user must size very small.
// Monte Carlo calibration: run backtest → Monte Carlo tab → "Calibrate" to update these.
const EXIT_STRATEGY_PROFILES = {
  safe: {
    label: "Tight", desc: "FP confirmed — SAFE+ 3.5pt SL · 28pt TP2",
    winRate: 0.74, ev: 8.2, avgPts: 8.2,
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
    label: "Standard", desc: "Zone+secondary — SAFE 5pt SL · 20pt TP2",
    winRate: 0.50, ev: 2.5, avgPts: 2.5,
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
    label: "Wide", desc: "Swing style — SAFE 10pt SL · 30pt TP2",
    winRate: 0.30, ev: 0.5, avgPts: 0.5,
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

// Legacy ATR multipliers (kept for VEC signal, not confluence)
const TP_ATR_MULT = 1.0;
const SL_ATR_MULT = 0.5;

const VEC_LENGTH       = 20;
const VEC_STOP_BELOW   = 3.5;
const VEC_STOP_BE      = 15.0;
const VEC_TP1          = 7.5;
const VEC_TP2          = 26.0;
const VEC_MAX_STOP     = 8.0;

// ── Candle sanity filter ─────────────────────────────────────────────────
// Shared filter applied to all raw candle arrays before vector computation.
// Removes: zero/NaN values, doji-spike bars, extreme wick bars, and isolated bars
// that don't share price range with at least 7 of their nearest 50 neighbours.
function filterCandlesForVector(raw: CandleBar[]): CandleBar[] {
  if (!raw.length) return raw;
  const MIN_P = 1, MAX_P = 9e13;
  const pass = raw
    .filter(c => {
      if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) return false;
      if (c.open < MIN_P || c.high < MIN_P || c.low < MIN_P || c.close < MIN_P) return false;
      if (c.open >= MAX_P || c.high >= MAX_P || c.low >= MAX_P || c.close >= MAX_P) return false;
      if (c.high <= c.low) return false;
      const range = c.high - c.low;
      if (range / c.close > 0.015 && Math.abs(c.open - c.close) / range < 0.10) return false;
      const bL = Math.min(c.open, c.close), bH = Math.max(c.open, c.close);
      if ((bL - c.low) / c.close > 0.015 || (c.high - bH) / c.close > 0.015) return false;
      return true;
    })
    .sort((a, b) => a.time - b.time);
  const MIN_CONN = 7, CONN_WIN = 25;
  return pass.filter((c, i) => {
    let conn = 0;
    for (let j = Math.max(0, i - CONN_WIN); j <= Math.min(pass.length - 1, i + CONN_WIN); j++) {
      if (j === i) continue;
      if (pass[j].low <= c.high && pass[j].high >= c.low && ++conn >= MIN_CONN) break;
    }
    return conn >= MIN_CONN;
  });
}

// ── Vector computation ────────────────────────────────────────────────────
// O(n) sliding-window min/max using monotonic deques — replaces O(n * VEC_LENGTH).
function computeVectorLine(candles: CandleBar[]): Array<{ time: number; value: number }> {
  if (!candles.length) return [];
  // All bars (RTH + ETH): matches ThinkorSwim vectorexitstrat behaviour.
  const s = [...candles].sort((a, b) => a.time - b.time);
  const n = s.length;
  const lb = new Float64Array(n);

  // Pass 1: Lowest(low, VEC_LENGTH) via monotonic min-deque
  const dq1 = new Int32Array(n);
  let d1f = 0, d1b = 0;
  for (let i = 0; i < n; i++) {
    while (d1f < d1b && dq1[d1f] <= i - VEC_LENGTH) d1f++;
    while (d1f < d1b && s[dq1[d1b - 1]].low >= s[i].low) d1b--;
    dq1[d1b++] = i;
    lb[i] = s[dq1[d1f]].low;
  }

  // Pass 2: Highest(LowerBand, VEC_LENGTH) via monotonic max-deque
  const result: Array<{ time: number; value: number }> = new Array(n);
  const dq2 = new Int32Array(n);
  let d2f = 0, d2b = 0;
  for (let i = 0; i < n; i++) {
    while (d2f < d2b && dq2[d2f] <= i - VEC_LENGTH) d2f++;
    while (d2f < d2b && lb[dq2[d2b - 1]] <= lb[i]) d2b--;
    dq2[d2b++] = i;
    result[i] = { time: s[i].time, value: lb[dq2[d2f]] };
  }
  return result;
}

// ── Background signal scanner (used for all-interval notifications) ──────────
// Lightweight version of allConfluenceSignals: finds safe signals (zone+vector)
// from any candle array. No live candle merging, no extraVec maps needed.
function computeBgSignals(
  candles: CandleBar[],
  vecLine: Array<{ time: number; value: number }>,
  milkZones: ZoneBand[],
): Array<{ time: number; direction: "Long" | "Short"; price: number; tp1: number; tp2: number; sl: number; riskLevel: "safe" | "risky" | "riskiest" }> {
  if (candles.length < 22 || !vecLine.length) return [];
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const vecMap = new Map(vecLine.map(v => [v.time, v.value]));
  const isBullZone = (z: ZoneBand): boolean => {
    const c = z.color.toLowerCase().trim();
    if (c === "#22c55e" || c === "#3b82f6" || c === "#14b8a6") return true;
    const m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) { const r = +m[1], g = +m[2], b = +m[3]; return g > r || (b > r && b > g); }
    return false;
  };

  const results: Array<{ time: number; direction: "Long" | "Short"; price: number; tp1: number; tp2: number; sl: number; riskLevel: "safe" | "risky" | "riskiest" }> = [];
  let lastLongBar = -20, lastShortBar = -20;
  const COOLDOWN = 10;

  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.rth === false) continue;
    const lb = vecMap.get(c.time);
    if (lb == null) continue;
    const prev  = sorted[i - 1];
    const prevLb = vecMap.get(prev.time);

    const utcH = new Date(c.time * 1000).getUTCHours();
    // Skip settlement break (20:30–22:00 UTC = 4:30–6pm ET)
    if (utcH >= 20) continue;

    const milkBullOk = milkZones.some(z =>
      isBullZone(z) &&
      c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity) &&
      c.low  <= z.topPrice    + MILK_TOLERANCE_PTS &&
      c.close >= z.bottomPrice - MILK_TOLERANCE_PTS
    );
    const milkBearOk = milkZones.some(z =>
      !isBullZone(z) &&
      c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity) &&
      c.high >= z.bottomPrice - MILK_TOLERANCE_PTS &&
      c.close <= z.topPrice   + MILK_TOLERANCE_PTS
    );

    if (c.close > lb && (prevLb == null || lb >= prevLb) && i - lastLongBar >= COOLDOWN) {
      const riskLevel: "safe" | "risky" | "riskiest" = milkBullOk ? "safe" : "risky";
      lastLongBar = i;
      results.push({ time: c.time, direction: "Long", price: c.close, tp1: c.close + TP_FIXED_1, tp2: c.close + TP_FIXED_2, sl: c.close - SL_FIXED, riskLevel });
    }
    if (c.close < lb && (prevLb == null || lb <= prevLb) && i - lastShortBar >= COOLDOWN) {
      const riskLevel: "safe" | "risky" | "riskiest" = milkBearOk ? "safe" : "risky";
      lastShortBar = i;
      results.push({ time: c.time, direction: "Short", price: c.close, tp1: c.close - TP_FIXED_1, tp2: c.close - TP_FIXED_2, sl: c.close + SL_FIXED, riskLevel });
    }
  }
  return results;
}

// ── Backtest engine ─────────────────────────────────────────────────────────
type BacktierStat = { count: number; winTp1: number; winTp2: number; loss: number; open: number };
type BacktestSignal = {
  time: number; direction: "Long" | "Short"; price: number;
  tier: "safe" | "risky" | "riskiest";
  outcome: "win_tp1" | "win_tp2" | "loss" | "open";
  note: string; noteType: "good" | "caution" | "miss";
  symbol: string; interval: string;
};
type BacktestResult = {
  symbol: string; interval: string; exitStrategy: string;
  fromDate: string; toDate: string; totalBars: number;
  tiers: { safe: BacktierStat; risky: BacktierStat; riskiest: BacktierStat };
  signals: BacktestSignal[];
  ranAt: number;
};

function btWalkForward(
  sorted: CandleBar[], startIdx: number,
  tp1: number, tp2: number, sl: number, isLong: boolean,
): "win_tp1" | "win_tp2" | "loss" | "open" {
  const c = sorted[startIdx];
  let settleTs = rthSettleOfDay(c.time);
  for (let d = 0; c.time >= settleTs && d < 4; d++) settleTs = rthSettleOfDay(c.time + (d + 1) * 86400);
  const pastEnd = Math.floor(Date.now() / 1000) > settleTs;
  for (let j = startIdx + 1; j < sorted.length; j++) {
    const f = sorted[j];
    if (f.time > settleTs) break;
    if (isLong) {
      if (f.high >= tp2) return "win_tp2";
      if (f.high >= tp1) return "win_tp1";
      if (f.low  <= sl)  return "loss";
    } else {
      if (f.low  <= tp2) return "win_tp2";
      if (f.low  <= tp1) return "win_tp1";
      if (f.high >= sl)  return "loss";
    }
  }
  return pastEnd ? "loss" : "open";
}

function runBacktest(
  candles: CandleBar[],
  milkZones: ZoneBand[],
  profile: { rth: { tp1Safe: number; tp1: number; tp2: number; sl: number } },
  symbol: string, interval: string, exitStratLabel: string,
): BacktestResult {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const vec    = computeVectorLine(sorted);
  const vecMap = new Map(vec.map(v => [v.time, v.value]));
  const isBullZ = (z: ZoneBand): boolean => {
    const c = z.color.toLowerCase().trim();
    if (c === "#22c55e" || c === "#3b82f6" || c === "#14b8a6") return true;
    const m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) { const r = +m[1], g = +m[2], b = +m[3]; return g > r || (b > r && b > g); }
    return false;
  };

  // Build full-day HOD/LOD map (date-key → { high, low })
  const dayHLMap = new Map<string, { high: number; low: number }>();
  for (const c of sorted) {
    const d   = new Date(c.time * 1000);
    const dk  = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const cur = dayHLMap.get(dk) ?? { high: -Infinity, low: Infinity };
    dayHLMap.set(dk, { high: Math.max(cur.high, c.high), low: Math.min(cur.low, c.low) });
  }

  const tiers: BacktestResult["tiers"] = {
    safe:     { count: 0, winTp1: 0, winTp2: 0, loss: 0, open: 0 },
    risky:    { count: 0, winTp1: 0, winTp2: 0, loss: 0, open: 0 },
    riskiest: { count: 0, winTp1: 0, winTp2: 0, loss: 0, open: 0 },
  };
  const signals: BacktestSignal[] = [];
  let lastLongBar = -10, lastShortBar = -10;

  const mkNote = (
    isLong: boolean, price: number, tier: "safe"|"risky"|"riskiest",
    out: "win_tp1"|"win_tp2"|"loss"|"open", time: number,
    tp1Price: number, tp2Price: number,
  ): { note: string; noteType: "good"|"caution"|"miss" } => {
    if (out === "win_tp2") return { note: "Clean hit — zone + vector held to full target", noteType: "good" };

    const utcH  = new Date(time * 1000).getUTCHours();
    const d     = new Date(time * 1000);
    const dk    = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const dayHL = dayHLMap.get(dk) ?? { high: Infinity, low: 0 };

    if (out === "win_tp1") {
      // Check if a zone blocked between TP1 and TP2
      const blocker = milkZones.find(z =>
        time >= (z.fromTime ?? 0) && time <= (z.toTime ?? Infinity) &&
        (isLong ? (!isBullZ(z) && z.bottomPrice > tp1Price && z.bottomPrice <= tp2Price)
                : ( isBullZ(z) && z.topPrice   < tp1Price && z.topPrice   >= tp2Price)));
      if (blocker) return {
        note: isLong ? `Resistance at ${blocker.bottomPrice.toFixed(2)} capped the run`
                     : `Support at ${blocker.topPrice.toFixed(2)} stopped the run`,
        noteType: "caution",
      };
      return { note: "Hit TP1 — stalled before full target", noteType: "caution" };
    }

    if (out === "loss") {
      if (isLong) {
        const res = milkZones.find(z => !isBullZ(z) && time >= (z.fromTime ?? 0) && time <= (z.toTime ?? Infinity) && z.bottomPrice > price && z.bottomPrice - price <= 5);
        if (res) return { note: `Resistance ${(res.bottomPrice - price).toFixed(1)}pts overhead`, noteType: "miss" };
        if (price >= dayHL.high - 3) return { note: "Entry near HOD — limited upside", noteType: "miss" };
        if (utcH >= 19) return { note: "Late session — expired near close", noteType: "caution" };
        if (utcH >= 18) return { note: "Afternoon entry — momentum often faded", noteType: "caution" };
        if (tier !== "safe") return { note: "No zone confirmation — vector-only stopped out", noteType: "miss" };
        return { note: "Zone held but momentum failed", noteType: "miss" };
      } else {
        const sup = milkZones.find(z => isBullZ(z) && time >= (z.fromTime ?? 0) && time <= (z.toTime ?? Infinity) && z.topPrice < price && price - z.topPrice <= 5);
        if (sup) return { note: `Support ${(price - sup.topPrice).toFixed(1)}pts below — buyers defended`, noteType: "miss" };
        if (price <= dayHL.low + 3) return { note: "Entry near LOD — bounce risk", noteType: "miss" };
        if (utcH >= 19) return { note: "Late session — expired near close", noteType: "caution" };
        if (utcH >= 18) return { note: "Afternoon entry — momentum often faded", noteType: "caution" };
        if (tier !== "safe") return { note: "No zone confirmation — vector-only stopped out", noteType: "miss" };
        return { note: "Zone held but momentum failed", noteType: "miss" };
      }
    }
    return { note: "Open — session not yet resolved", noteType: "caution" };
  };

  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    if (!isRTH(c.time)) continue;
    if (new Date(c.time * 1000).getUTCHours() >= 20) continue;
    const lb = vecMap.get(c.time);
    if (lb == null) continue;
    const prevLb = vecMap.get(sorted[i - 1].time);

    const milkBullOk = milkZones.some(z =>
      isBullZ(z) && c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity) &&
      c.low <= z.topPrice + 2.0 && c.close >= z.bottomPrice - 2.0);
    const milkBearOk = milkZones.some(z =>
      !isBullZ(z) && c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity) &&
      c.high >= z.bottomPrice - 2.0 && c.close <= z.topPrice + 2.0);

    if (c.close > lb && (prevLb == null || lb >= prevLb) && i - lastLongBar >= 10) {
      lastLongBar = i;
      const tier: keyof BacktestResult["tiers"] = milkBullOk ? "safe" : "risky";
      const tp1F  = tier === "safe" ? profile.rth.tp1Safe : profile.rth.tp1;
      const tp1   = c.close + tp1F;
      const tp2   = c.close + profile.rth.tp2;
      const sl    = c.close - profile.rth.sl;
      const out   = btWalkForward(sorted, i, tp1, tp2, sl, true);
      tiers[tier].count++;
      if (out === "win_tp1") tiers[tier].winTp1++;
      else if (out === "win_tp2") tiers[tier].winTp2++;
      else if (out === "loss") tiers[tier].loss++;
      else tiers[tier].open++;
      const { note, noteType } = mkNote(true, c.close, tier, out, c.time, tp1, tp2);
      signals.push({ time: c.time, direction: "Long", price: c.close, tier, outcome: out, note, noteType, symbol, interval });
    }
    if (c.close < lb && (prevLb == null || lb <= prevLb) && i - lastShortBar >= 10) {
      lastShortBar = i;
      const tier: keyof BacktestResult["tiers"] = milkBearOk ? "safe" : "risky";
      const tp1F  = tier === "safe" ? profile.rth.tp1Safe : profile.rth.tp1;
      const tp1   = c.close - tp1F;
      const tp2   = c.close - profile.rth.tp2;
      const sl    = c.close + profile.rth.sl;
      const out   = btWalkForward(sorted, i, tp1, tp2, sl, false);
      tiers[tier].count++;
      if (out === "win_tp1") tiers[tier].winTp1++;
      else if (out === "win_tp2") tiers[tier].winTp2++;
      else if (out === "loss") tiers[tier].loss++;
      else tiers[tier].open++;
      const { note, noteType } = mkNote(false, c.close, tier, out, c.time, tp1, tp2);
      signals.push({ time: c.time, direction: "Short", price: c.close, tier, outcome: out, note, noteType, symbol, interval });
    }
  }

  const fromDate = sorted.length ? new Date(sorted[0].time * 1000).toLocaleDateString() : "—";
  const toDate   = sorted.length ? new Date(sorted[sorted.length - 1].time * 1000).toLocaleDateString() : "—";
  return { symbol, interval, exitStrategy: exitStratLabel, fromDate, toDate, totalBars: sorted.length, tiers, signals, ranAt: Date.now() };
}

function computeVectorSignals(
  candles: CandleBar[],
  vecLine: Array<{ time: number; value: number }>
): VectorSignal[] {
  if (candles.length < 2 || !vecLine.length) return [];
  const s = [...candles].sort((a, b) => a.time - b.time);
  const vecMap = new Map(vecLine.map(v => [v.time, v.value]));
  const signals: VectorSignal[] = [];

  for (let i = 1; i < s.length; i++) {
    const c = s[i], prev = s[i - 1];
    const lb     = vecMap.get(c.time);
    const prevLb = vecMap.get(prev.time);
    if (lb == null || prevLb == null) continue;
    const slope     = lb - prevLb;
    const sideEntry = prev.close < prevLb && c.close > lb && slope < 0;
    if (!sideEntry) continue;
    const entry    = c.close;
    const stopVec  = lb - VEC_STOP_BELOW;
    const stopMax  = entry - VEC_MAX_STOP;
    signals.push({
      time: c.time, entryPrice: entry,
      tp1: entry + VEC_TP1,
      tp2: entry + VEC_TP2,
      stopInitial: Math.max(stopVec, stopMax),
    });
  }
  return signals;
}

function computeVectorTradeOverlays(
  signals: VectorSignal[],
  candles: CandleBar[],
  vecLine: Array<{ time: number; value: number }>
): { bands: BandOverlay[]; segments: TradeSegment[] } {
  if (!signals.length) return { bands: [], segments: [] };
  const s = [...candles].sort((a, b) => a.time - b.time);
  const vecMap = new Map(vecLine.map(v => [v.time, v.value]));
  const bands: BandOverlay[] = [];
  const segments: TradeSegment[] = [];

  for (const sig of signals) {
    const sigIdx = s.findIndex(c => c.time === sig.time);
    if (sigIdx < 0) continue;
    let stop = sig.stopInitial;
    let beHit = false;
    let endTime = s[s.length - 1].time;

    for (let i = sigIdx + 1; i < s.length; i++) {
      const c  = s[i];
      const lb = vecMap.get(c.time);
      if (!beHit && c.high >= sig.entryPrice + VEC_STOP_BE) {
        beHit = true;
        stop  = sig.entryPrice;
      } else if (!beHit && lb != null) {
        stop = Math.max(lb - VEC_STOP_BELOW, sig.entryPrice - VEC_MAX_STOP);
      }
        if (c.high >= sig.tp2 || c.low <= stop) { endTime = c.time; break; }
    }

    // Bounded fills — stop at TP1 for width (same as confluence signals)
    let fillEnd = endTime;
    for (let i = sigIdx + 1; i < s.length; i++) {
      const c = s[i];
      if (c.high >= sig.tp1 || c.low <= sig.stopInitial) { fillEnd = c.time; break; }
    }
    bands.push({ topPrice: sig.tp2,        bottomPrice: sig.entryPrice, fillColor: "rgba(38,166,154,0.06)", fromTime: sig.time, toTime: fillEnd });
    bands.push({ topPrice: sig.entryPrice, bottomPrice: sig.stopInitial, fillColor: "rgba(239,83,80,0.06)",   fromTime: sig.time, toTime: fillEnd });

    // Canvas-rendered segment — lines cut off exactly at toTime
    segments.push({
      fromTime: sig.time,
      toTime: endTime,
      entry: sig.entryPrice,
      tp1: sig.tp1,
      tp2: sig.tp2,
      stop: sig.stopInitial,
    });
  }

  return { bands, segments };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmt(n?: number | null, digits = 2): string {
  if (n == null) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (n >= 1) return n.toFixed(digits);
  return n.toFixed(4);
}

function fmtVol(v?: number | null): string {
  if (!v) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(v);
}

function getPersistedSetting<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem("mwb_settings");
    if (!stored) return fallback;
    const obj = JSON.parse(stored);
    return (key in obj) ? (obj[key] as T) : fallback;
  } catch { return fallback; }
}

function fmtDate(s: string): string {
  const [y,m,d] = s.split("-");
  return new Date(+y, +m-1, +d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDateFull(s: string): string {
  const [y,m,d] = s.split("-");
  return new Date(+y, +m-1, +d).toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric", year:"numeric" });
}

function dateToTs(s: string, h = 0): number {
  const [y,m,d] = s.split("-").map(Number);
  return Math.floor(new Date(Date.UTC(y, m-1, d, h)).getTime() / 1000);
}


function agg5mTo15m(candles: CandleBar[]): CandleBar[] {
  if (!candles.length) return [];
  const s = [...candles].sort((a,b) => a.time-b.time);
  const result: CandleBar[] = [];
  let bucket: CandleBar | null = null, bucketStart = 0;
  const T = 15 * 60;
  for (const c of s) {
    const aligned = Math.floor(c.time / T) * T;
    if (bucket && bucketStart === aligned) {
      bucket.high   = Math.max(bucket.high, c.high);
      bucket.low    = Math.min(bucket.low, c.low);
      bucket.close  = c.close;
      bucket.volume = (bucket.volume ?? 0) + (c.volume ?? 0);
      if (c.rth) bucket.rth = true;
    } else {
      if (bucket) result.push(bucket);
      bucketStart = aligned;
      bucket = { ...c, time: aligned };
    }
  }
  if (bucket) result.push(bucket);
  return result;
}


// Generic candle aggregation to any interval (e.g. 5m→15m, 5m→60m, 1m→5m)
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
      ex.low    = Math.min(ex.low,  c.low);
      ex.close  = c.close;
      ex.volume = (ex.volume ?? 0) + (c.volume ?? 0);
      // If any bar in the bucket is RTH, promote the bucket to RTH.
      // Without this, a boundary bucket whose first bar is ETH gets rth:false
      // and is excluded from computeVectorLine, making the vector appear flat.
      if (!ex.rth && c.rth) ex.rth = c.rth;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

// Forward-fill a vector (computed at one interval) onto another interval's timestamps.
// For each chart time T, emits the last vector value whose time ≤ T.
function forwardFillVector(
  vec: Array<{ time: number; value: number }>,
  chartTimes: number[]
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

// ── Drawing tool config ───────────────────────────────────────────────────
const DRAWING_TOOLS: { id: DrawingTool; icon: React.ElementType; label: string }[] = [
  { id: "cursor",    icon: MousePointer2, label: "Select" },
  { id: "signal",    icon: Crosshair,     label: "Analyze Candle — click any candle to see why a signal should/shouldn't have fired" },
  { id: "line",      icon: Pencil,        label: "Trendline" },
  { id: "hline",     icon: Minus,         label: "Horiz. Line" },
  { id: "vline",     icon: LayoutTemplate, label: "Vert. Line" },
  { id: "rectangle", icon: Square,        label: "Rectangle" },
  { id: "fibonacci", icon: GitBranch,     label: "Fibonacci" },
];

// ── Interval → seconds (used in multiple places) ─────────────────────────
const IVAL_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };

// ── MW color tokens ────────────────────────────────────────────────────────
// ── Midnight Glow palette ─────────────────────────────────────────────────
// Deep navy with electric-blue glow accents. Drives all chrome (inline styles).
// Chart rendering uses CHART_THEMES separately, so this is cosmetic-only.
const MW = {
  bg:       "#060b14",   // app/chrome background — deep navy-black
  panel:    "#0a1322",   // panel backgrounds — navy
  toolbar:  "#0b1626",   // toolbar — slightly lifted navy
  border:   "#18293f",   // borders — soft navy
  text:     "#cdd9ea",   // primary text — cool light
  muted:    "#647fa6",   // secondary text — slate-blue (more readable)
  accent:   "#2f9bff",   // electric blue accent
  accentHov:"#54b3ff",
  accent2:  "#38e0ff",   // cyan glow companion
  glow:     "rgba(47,155,255,0.45)", // accent glow for box-shadows
  up:       "#2196f3",   // up / long — MotiveWave blue
  down:     "#ef4444",   // down / short — vivid red
};

// ── Page component ────────────────────────────────────────────────────────
export default function MarketPage() {
  // Read initial symbol/interval from URL query params (e.g. /?symbol=MES&interval=5m)
  const urlParams = new URLSearchParams(window.location.search);
  const urlSymbol   = urlParams.get("symbol")?.toUpperCase() ?? null;
  const urlInterval = urlParams.get("interval") as "1m" | "5m" | "15m" | "60m" | null;
  const urlTime     = parseInt(urlParams.get("time") ?? "0") || null;
  const urlPadding  = parseInt(urlParams.get("padding") ?? "30") || 30;

  const [selectedSymbol, setSelectedSymbol] = useState(() => urlSymbol ?? getPersistedSetting("selectedSymbol", "MES"));
  const [symbolDropdownOpen, setSymbolDropdownOpen] = useState(false);
  const [symbolSearch, setSymbolSearch] = useState("");
  const [showVector, setShowVector]         = useState(() => getPersistedSetting("showVector", true));
  const [showMlZones,   setShowMlZones]     = useState(() => getPersistedSetting("showMlZones", true));
  const [showMilkZones, setShowMilkZones]   = useState(() => getPersistedSetting("showMilkZones", true));
  const [wsReconnectKey, setWsReconnectKey] = useState(0); // increment to force WS reconnect
  const [chartRefreshKey, setChartRefreshKey] = useState(0); // increment to force full chart setData
  const [selectedSignal, setSelectedSignal] = useState<SignalClickInfo | null>(null);
  const [manualSignalState, setManualSignalState] = useState<{ candle: CandleBar; direction: "Long" | "Short" | null; draftNote?: string } | null>(null);
  const [manualEditMode, setManualEditMode] = useState(false);
  const [chartRiskLevel, setChartRiskLevel] = useState<"safe" | "risky" | "riskiest" | "all">(() => getPersistedSetting("chartRiskLevel", "risky" as "safe" | "risky" | "riskiest" | "all"));
  const [exitStrategy,  setExitStrategy]   = useState<"safe" | "risky" | "riskiest">(() => getPersistedSetting("exitStrategy", "risky" as "safe" | "risky" | "riskiest"));
  const [useTrailer,    setUseTrailer]     = useState(() => getPersistedSetting("useTrailer", false));
  const [trailerOffset, setTrailerOffset]  = useState(() => getPersistedSetting("trailerOffset", 2.0));
  const [useZoneTargets, setUseZoneTargets] = useState(() => getPersistedSetting("useZoneTargets", false));
  // Feature: take EVERY vector side-entry as a Long, exiting with the vector's exit strategy.
  // When on, these become first-class signals (chart + panel + persisted + iPhone) and are
  // auto-trade eligible (explicit override of the safe/safe+ auto-trade gate — see fire logic).
  const [takeSideEntries, setTakeSideEntries] = useState(() => getPersistedSetting("takeSideEntries", false));
  const [showSignalsPanel, setShowSignalsPanel] = useState(false);
  const [showLabels,    setShowLabels]    = useState(() => getPersistedSetting("showLabels", true));
  const [autoScale,     setAutoScale]     = useState(true);
  const [uploadedZones, setUploadedZones] = useState<BandOverlay[]>([]);
  const [parsedZones,   setParsedZones]   = useState<ZoneBand[]>([]);
  const [zoneUploading, setZoneUploading] = useState(false);
  const [zoneCount,     setZoneCount]     = useState(0);
  const [showZoneList,  setShowZoneList]  = useState(false);
  const [startDayIdx, setStartDayIdx] = useState(0);
  const [endDayIdx,   setEndDayIdx]   = useState(59);
  // Default window = 90 days so the initial load is fast & reliable. Loading "ALL"
  // (2yr of 5m ≈ 100k candles ≈ 10MB / 12s) is too heavy to fetch on first paint and
  // leaves the chart blank — the user can still pick a larger window from the dropdown
  // (incl. ALL) to pull deep history on demand. Key bumped v3→v4 to clear the stale
  // 9999/ALL value some browsers cached.
  const [windowSize,  setWindowSize]  = useState(() => getPersistedSetting("windowSize_v4", 90));
  const [interval, setInterval] = useState<"1m" | "5m" | "15m" | "60m">(() => {
    if ((["1m","5m","15m","60m"] as const).includes(urlInterval as any)) return urlInterval as "1m"|"5m"|"15m"|"60m";
    // Default to 15m: native 15m history loads ~4x faster than 5m (fewer bars over the
    // same window) and is the primary interval for this strategy.
    return getPersistedSetting<"1m"|"5m"|"15m"|"60m">("interval", "15m");
  });
  const [activeTool,  setActiveTool]  = useState<DrawingTool>("cursor");
  const [drawings,    setDrawings]    = useState<Drawing[]>([]);
  const [crosshair,   setCrosshair]   = useState<{ time?:number; open?:number; high?:number; low?:number; close?:number; volume?:number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [discordUnread, setDiscordUnread] = useState(0);
  const [location] = useLocation();
  const [discordWebhook, setDiscordWebhook]       = useState("");
  const [discordWebhookInput, setDiscordWebhookInput] = useState("");
  const [discordSaveState, setDiscordSaveState]   = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [discordTestState, setDiscordTestState]   = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [discordError, setDiscordError]           = useState("");
  // Auto Trade (enabled is persisted so it survives page reloads)
  const [autoTradeEnabled, setAutoTradeEnabled]         = useState(() => getPersistedSetting("autoTradeEnabled", true));
  const [autoTradeContracts, setAutoTradeContracts]     = useState(() => getPersistedSetting("autoTradeContracts", 1));
  const [autoTradeContractType, setAutoTradeContractType] = useState<"MES" | "ES">(() => getPersistedSetting<"MES"|"ES">("autoTradeContractType", "MES"));
  const [autoTradeRiskLevels, setAutoTradeRiskLevels]   = useState<Set<string>>(() => new Set(getPersistedSetting<string[]>("autoTradeRiskLevels", ["safe"])));
  const [autoTradeIntervals, setAutoTradeIntervals]     = useState<Set<string>>(() => new Set(getPersistedSetting<string[]>("autoTradeIntervals", ["5m"])));
  const [autoTradeConnected, setAutoTradeConnected]     = useState(false);
  const [mwSyncStatus, setMwSyncStatus] = useState<"pending" | "syncing" | "done">("pending");
  const [mwSyncBars, setMwSyncBars]     = useState(0);
  // FOOTPRINT-TIER: latest footprint candles received from server via WS footprint_candle messages
  const footprintCandlesRef = useRef<FootprintCandle[]>([]); // PERF: ref for signal computation — avoids triggering recompute on every heartbeat
  const [footprintCandles, setFootprintCandles]           = useState<FootprintCandle[]>([]); // FOOTPRINT-TIER: kept for display (ladder panel count)
  const [fpCompletedVersion, setFpCompletedVersion]       = useState(0); // PERF: increments only on new complete bar — gates allConfluenceSignals recompute
  const [footprintAlerts, setFootprintAlerts]             = useState<Record<number, { pocPrice: number; message: string }>>({}); // FOOTPRINT-TIER:
const [showFpPanel, setShowFpPanel]                     = useState(false); // FOOTPRINT-TIER: toggle side-panel ladder
  const [fpSession, setFpSession] = useState<"rth" | "eth">("rth"); // FIX: controlled session; was hardcoded rth=true in fpLadderData and internal useState in badge — badge toggle had no effect on canvas column
  const [showBacktest, setShowBacktest]   = useState(false);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [backtestRunning, setBacktestRunning] = useState(false);
  const [showZonePaste, setShowZonePaste] = useState(false);
  const [zonePasteText, setZonePasteText] = useState("");
  const [zonePasteStatus, setZonePasteStatus] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [zonePasteCount, setZonePasteCount] = useState(0);
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [adjustmentsSaving, setAdjustmentsSaving] = useState(false);
  const [adjustmentsSaved, setAdjustmentsSaved] = useState(false);
  const [scaleInMode, setScaleInMode] = useState(() => getPersistedSetting("autoTrade_scaleIn", false)); // FIX: scale-in — 50% at signal, 50% on pullback within 2pts of TP1
  const [autoTradeTp1Only, setAutoTradeTp1Only]         = useState(() => getPersistedSetting("autoTradeTp1Only", false));
  const [autoTradeDirection, setAutoTradeDirection]     = useState<"both" | "long" | "short">(() => getPersistedSetting<"both"|"long"|"short">("autoTradeDirection", "both"));
  const [autoTradeToast, setAutoTradeToast] = useState<{ ok: boolean; msg: string; direction: string; price: number } | null>(null);
  const autoTradeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Confirmed auto-trade: signal must persist 3s before order is sent.
  const pendingAutoTradeRef  = useRef<{ timer: ReturnType<typeof setTimeout>; key: string } | null>(null);
  // Live snapshot of all active signal keys (time_direction) across every interval.
  // Updated synchronously so the 3s confirmation callback always reads fresh data.
  const latestSignalsRef     = useRef<Set<string>>(new Set());
  const autoTradeEnabledRef      = useRef(getPersistedSetting("autoTradeEnabled", true));
  const autoTradeContractsRef    = useRef(1);
  const autoTradeContractTypeRef = useRef<"MES" | "ES">("MES");
  const autoTradeRiskRef         = useRef<Set<string>>(new Set(["safe"]));
  const autoTradeIntervalRef     = useRef<Set<string>>(new Set(["5m"]));
  const autoTradeTp1OnlyRef      = useRef(false);
  const autoTradeDirectionRef    = useRef<"both" | "long" | "short">("both");
  const useTrailerRef            = useRef(getPersistedSetting("useTrailer", false));
  const trailerOffsetRef         = useRef(getPersistedSetting("trailerOffset", 2.0));
  const [themeKey, setThemeKey] = useState<string>(() => getPersistedSetting("themeKey", "motivewave"));
  const [customTheme, setCustomTheme] = useState<ChartTheme>(() => getPersistedSetting("customTheme", CHART_THEMES.motivewave));
  const currentTheme: ChartTheme = themeKey === "custom" ? customTheme : (CHART_THEMES[themeKey] ?? CHART_THEMES.motivewave);
  const [favoriteThemes, setFavoriteThemes] = useState<Record<string, ChartTheme>>(() => {
    try { return JSON.parse(localStorage.getItem("fav_themes") ?? "{}"); } catch { return {}; }
  });
  const [favThemeNameInput, setFavThemeNameInput] = useState("");
  const [showETH,     setShowETH]     = useState(() => getPersistedSetting("showETH", true)); // true = show extended + regular hours

  // ── Favorites ─────────────────────────────────────────────────────────────
  type SavedView = { name: string; interval: string; showVector: boolean; showMlZones: boolean; chartRiskLevel: string; showETH: boolean; themeKey: string; customTheme?: ChartTheme };
  const [showFavorites, setShowFavorites] = useState(false);
  const [favoriteSymbols, setFavoriteSymbols] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("fav_symbols") ?? "[]"); } catch { return []; }
  });
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => {
    try { return JSON.parse(localStorage.getItem("saved_views") ?? "[]"); } catch { return []; }
  });
  const [viewNameInput, setViewNameInput] = useState("");
  const [signalWinRates, setSignalWinRates] = useState<Record<string, { winRate: number; sampleCount: number }>>({});

  function toggleFavSymbol(sym: string) {
    setFavoriteSymbols(prev => {
      const next = prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym];
      localStorage.setItem("fav_symbols", JSON.stringify(next));
      return next;
    });
  }
  function saveCurrentView(name: string) {
    if (!name.trim()) return;
    const view: SavedView = { name: name.trim(), interval, showVector, showMlZones, chartRiskLevel, showETH, themeKey, ...(themeKey === "custom" ? { customTheme } : {}) };
    setSavedViews(prev => {
      const next = [...prev.filter(v => v.name !== view.name), view];
      localStorage.setItem("saved_views", JSON.stringify(next));
      return next;
    });
    setViewNameInput("");
  }
  function applyView(v: SavedView) {
    setInterval(v.interval as "1m" | "5m" | "15m" | "60m");
    setShowVector(v.showVector);
    setShowMlZones(v.showMlZones);
    setChartRiskLevel(v.chartRiskLevel as "safe" | "risky" | "riskiest" | "all");
    setShowETH(v.showETH);
    if (v.themeKey) {
      setThemeKey(v.themeKey);
      if (v.themeKey === "custom" && v.customTheme) setCustomTheme(v.customTheme);
    }
  }
  function deleteView(name: string) {
    setSavedViews(prev => {
      const next = prev.filter(v => v.name !== name);
      localStorage.setItem("saved_views", JSON.stringify(next));
      return next;
    });
  }
  const [liveCandles, setLiveCandles] = useState<CandleBar[]>([]);
  const [liveStatus, setLiveStatus]   = useState<"disconnected" | "connecting" | "live">("disconnected");
  const [mwFeedStale, setMwFeedStale] = useState<"live" | "stale" | "unknown">("unknown");
  const [refreshing, setRefreshing]   = useState(false);
  const queryClient = useQueryClient();
  const [clockTime, setClockTime] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setClockTime(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // On mount: sync autoTradeEnabled from server so the PC reflects the last-known state
  // (survives browser refresh, new tab, or PC restart mid-session).
  useEffect(() => {
    fetch("/api/trade/settings")
      .then(r => r.ok ? r.json() : null)
      .then((d: { enabled?: boolean; intervals?: string[]; riskLevels?: string[]; direction?: "both" | "long" | "short"; contracts?: number; contractType?: "MES" | "ES"; tp1Only?: boolean } | null) => {
        if (!d) return;
        if (typeof d.enabled === "boolean") {
          setAutoTradeEnabled(d.enabled);
          autoTradeEnabledRef.current = d.enabled;
        }
        if (Array.isArray(d.intervals)) {
          const s = new Set<string>(d.intervals);
          setAutoTradeIntervals(s);
          autoTradeIntervalRef.current = s;
        }
        if (Array.isArray(d.riskLevels)) {
          const s = new Set<string>(d.riskLevels);
          setAutoTradeRiskLevels(s);
          autoTradeRiskRef.current = s;
        }
        if (d.direction === "both" || d.direction === "long" || d.direction === "short") {
          setAutoTradeDirection(d.direction);
          autoTradeDirectionRef.current = d.direction;
        }
        if (typeof d.contracts === "number" && d.contracts >= 1) {
          const n = Math.floor(d.contracts);
          setAutoTradeContracts(n);
          autoTradeContractsRef.current = n;
        }
        if (d.contractType === "MES" || d.contractType === "ES") {
          setAutoTradeContractType(d.contractType);
          autoTradeContractTypeRef.current = d.contractType;
        }
        if (typeof d.tp1Only === "boolean") {
          setAutoTradeTp1Only(d.tp1Only);
          autoTradeTp1OnlyRef.current = d.tp1Only;
        }
      })
      .catch(() => {});
  }, []); // mount only

  // Fetch data-driven win rates for ML confidence scores (loads once, updates signalWinRates)
  useEffect(() => {
    fetch("/api/signals/win-rates")
      .then(r => r.json())
      .then((d: { winRates?: Record<string, { winRate: number; sampleCount: number }> }) => {
        if (d.winRates) setSignalWinRates(d.winRates);
      })
      .catch(() => {});
  }, []);

  // Load Discord webhook — localStorage first (survives server restarts when DB is over quota),
  // then server (may have a newer value). If we loaded from localStorage but server is empty,
  // re-register with server to repopulate memDiscordWebhook for this session.
  useEffect(() => {
    const lsHook = localStorage.getItem("discord_webhook") ?? "";
    if (lsHook) {
      setDiscordWebhook(lsHook);
      setDiscordWebhookInput(lsHook);
      discordWebhookRef.current = lsHook;
      // Repopulate server memory store so /api/discord/send has the webhook this session
      fetch("/api/discord/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhook: lsHook }),
      }).catch(() => {});
    }
    fetch("/api/discord/settings").then(r => r.json()).then(d => {
      if (d.webhook) {
        setDiscordWebhook(d.webhook); setDiscordWebhookInput(d.webhook);
        discordWebhookRef.current = d.webhook;
        localStorage.setItem("discord_webhook", d.webhook);
      }
    }).catch(() => {});
  }, []);

  // Keep discordWebhookRef in sync
  useEffect(() => { discordWebhookRef.current = discordWebhook; }, [discordWebhook]);

  // Clear Discord unread badge when navigating to the feed
  useEffect(() => { if (location === "/discord") setDiscordUnread(0); }, [location]);

  // Poll AutoTrader Java study connection status every 5s.
  // cache:"no-store" — otherwise the browser revalidates and a 304 (empty body) makes r.json()
  // throw, leaving the connection flag stale ("disconnected" while the study is actually connected).
  useEffect(() => {
    const poll = () => fetch("/api/trade/status", { cache: "no-store" }).then(r => r.json())
      .then(d => setAutoTradeConnected(!!d.connected)).catch(() => {});
    poll();
    const t = window.setInterval(poll, 5000);
    return () => window.clearInterval(t);
  }, []);

  // Poll MW sync status on mount (handles page load after sync already completed)
  useEffect(() => {
    fetch("/api/mw/sync-status").then(r => r.json()).then(d => {
      if (d.status) setMwSyncStatus(d.status);
      if (d.barsReceived) setMwSyncBars(d.barsReceived);
    }).catch(() => {});
  }, []);

  // Keep auto-trade refs in sync with state (stale-closure-safe)
  useEffect(() => { autoTradeEnabledRef.current      = autoTradeEnabled; },      [autoTradeEnabled]);
  useEffect(() => { autoTradeContractsRef.current    = autoTradeContracts; },    [autoTradeContracts]);
  useEffect(() => { autoTradeContractTypeRef.current = autoTradeContractType; }, [autoTradeContractType]);
  useEffect(() => { autoTradeRiskRef.current         = autoTradeRiskLevels; },   [autoTradeRiskLevels]);
  useEffect(() => { autoTradeIntervalRef.current     = autoTradeIntervals; },    [autoTradeIntervals]);
  useEffect(() => { autoTradeTp1OnlyRef.current      = autoTradeTp1Only; },      [autoTradeTp1Only]);
  useEffect(() => { autoTradeDirectionRef.current    = autoTradeDirection; },    [autoTradeDirection]);
  useEffect(() => { useTrailerRef.current            = useTrailer; },             [useTrailer]);
  useEffect(() => { trailerOffsetRef.current         = trailerOffset; },          [trailerOffset]);

  // ── Persist settings to localStorage ──────────────────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem("mwb_settings", JSON.stringify({
        selectedSymbol, themeKey, customTheme,
        showVector, showMlZones, showMilkZones, showETH, showLabels,
        chartRiskLevel, exitStrategy, windowSize_v4: windowSize, interval,
        autoTradeEnabled,
        autoTradeContracts, autoTradeContractType,
        autoTradeRiskLevels: [...autoTradeRiskLevels],
        autoTradeIntervals:  [...autoTradeIntervals],
        autoTradeTp1Only,
        autoTradeDirection,
        useTrailer,
        trailerOffset,
        useZoneTargets,
        takeSideEntries,
      }));
    } catch {}
  }, [selectedSymbol, themeKey, customTheme, showVector, showMlZones, showMilkZones, showETH, showLabels,
      chartRiskLevel, exitStrategy, windowSize, interval, autoTradeEnabled, autoTradeContracts, autoTradeContractType,
      autoTradeRiskLevels, autoTradeIntervals, autoTradeTp1Only, autoTradeDirection, useTrailer, trailerOffset, useZoneTargets, takeSideEntries]);

  // When exit strategy changes, clear all non-DB-locked signal levels so they recompute
  // with the new TP/SL parameters. DB-locked signals are re-applied on the next render.
  // Verified (permanent) signals are immediately re-seeded so their TP/SL never change mid-trade.
  useEffect(() => {
    lockedSignalLevelsRef.current.clear();
    beTriggeredRef.current.clear();
    permanentSignalLevelsRef.current.forEach((val, key) => lockedSignalLevelsRef.current.set(key, val));
  }, [exitStrategy, useTrailer, trailerOffset, useZoneTargets]);

  // ── Live confluence alert ─────────────────────────────────────────────────
  const [liveAlert, setLiveAlert] = useState<{
    direction: "Long" | "Short";
    price: number; tp1: number; tp2: number; sl: number;
    time: number; interval: string;
    riskLevel?: string;
    confidence?: number;
    scoreLabel?: string;
  } | null>(null);
  // Per-interval+direction last-notified timestamp — Long and Short tracked independently
  // so a recent Long signal never blocks an incoming Short signal (and vice-versa)
  const lastNotifiedRef = useRef<Record<string, number>>({
    "1m_Long": 0, "1m_Short": 0, "5m_Long": 0, "5m_Short": 0,
    "15m_Long": 0, "15m_Short": 0, "60m_Long": 0, "60m_Short": 0,
  });
  // Tracks the risk level of the last auto-trade fired per key so upgrades (risky→safe) re-fire
  const lastNotifiedRiskRef = useRef<Record<string, string>>({});
  // Per-interval+direction initialized flag — set on first load so we don't fire history
  const notifyInitializedRef = useRef<Record<string, boolean>>({
    "1m_Long": false, "1m_Short": false, "5m_Long": false, "5m_Short": false,
    "15m_Long": false, "15m_Short": false, "60m_Long": false, "60m_Short": false,
  });
  const alertDismissTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signalVerifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One-shot guard: which `${time}_${direction}` signals have already alerted Discord (prevents
  // a tier-upgrade or recompute from re-sending an alert for the same fired signal).
  const discordSentRef = useRef<Set<string>>(new Set());
  // Ref so fireSignalNotification always sees latest discordWebhook without stale closure
  const discordWebhookRef = useRef<string>("");

  const chartRef          = useRef<ChartHandle>(null);
  const timelineRef       = useRef<HTMLDivElement>(null);
  const scrubberDragRef   = useRef<{ startX: number; startIdx: number; trackWidth: number } | null>(null);
  const scrubberStateRef  = useRef({ total: 0, windowSize: 60 });
  const symbolDropdownRef = useRef<HTMLDivElement>(null);
  const intervalRef       = useRef(interval);
  useEffect(() => { intervalRef.current = interval; }, [interval]);
  // Tracks last seen bucket so we detect when a candle period rolls over
  const lastTickBucketRef = useRef<number>(0);
  useEffect(() => { lastTickBucketRef.current = 0; }, [selectedSymbol, interval]);

  // FOOTPRINT-TIER: seed footprint candles from server on symbol/interval change
  useEffect(() => {
    const sym = selectedSymbol.toUpperCase();
    const iv  = interval === "15m" ? "5m" : interval; // footprint runs on 5m base
    fetch(`/api/footprint/history/${sym}/${iv}`)
      .then(r => r.ok ? r.json() : [])
      .then((candles: FootprintCandle[]) => {
        if (!Array.isArray(candles) || candles.length === 0) return;
        footprintCandlesRef.current = candles.slice(-50);
        setFootprintCandles(footprintCandlesRef.current);
        setFpCompletedVersion(v => v + 1);
      })
      .catch(() => {});
  }, [selectedSymbol, interval]); // FOOTPRINT-TIER:
  // Tracks last WS tick timestamp — HTTP poll suppresses close overwrite when ticks are active
  const lastWsTickMsRef = useRef<number>(0);
  // PERF: throttle forming-bar setLiveCandles updates — complete bars always update immediately
  const lastFormingBarUpdateMs = useRef<number>(0);
  // Tracks last handleRefresh timestamp — HTTP poll skips for 3s after refresh to prevent
  // stale in-memory server bars from overwriting freshly loaded DB data
  const lastRefreshMsRef = useRef<number>(0);
  // Lock: set to true after handleRefresh so signal loss can never revert the chart.
  // Blocks data_updated invalidations and fetchGapCandles overwrites of existing bars.
  // Cleared only at the start of the next manual Refresh.
  const chartLockedRef = useRef<boolean>(false);
  // Latest timestamp from rawCandleData — fetchGapCandles skips bars at or before this when locked
  const baseEndTsRef = useRef<number>(0);
  // Tracks latest live price for test order
  const lastLivePriceRef = useRef<number>(0);

  // ── Live Edits ──────────────────────────────────────────────────────────────
  const [liveEditOpen,    setLiveEditOpen]    = useState(false);
  const [liveEditPrompt,  setLiveEditPrompt]  = useState("");
  const [liveEditLoading, setLiveEditLoading] = useState(false);
  const [liveEditResult,  setLiveEditResult]  = useState<{ ok: boolean; message: string; reloading?: boolean } | null>(null);
  const [stratGuardData,  setStratGuardData]  = useState<{ matched: Array<{ id: string; name: string; matchedKeywords: string[] }>; pendingPrompt: string } | null>(null);

  const sendLiveEdit = (prompt: string, strategyUpdateIds?: string[]) => {
    const p = prompt.toLowerCase();
    const files: string[] = [];
    if (p.includes("chart") || p.includes("candle") || p.includes("zoom") || p.includes("pan") || p.includes("vector") || p.includes("series") || p.includes("mouse") || p.includes("cursor") || p.includes("draw"))
      files.push("client/src/components/CandlestickChart.tsx");
    if (p.includes("signal") || p.includes("zone") || p.includes("toolbar") || p.includes("button") || p.includes("panel") || p.includes("interval") || p.includes("market") || p.includes("live edit"))
      files.push("client/src/pages/market.tsx");
    if (p.includes("route") || p.includes("api") || p.includes("endpoint") || p.includes("server") || p.includes("fetch"))
      files.push("server/routes.ts");
    if (p.includes("schema") || p.includes("database") || p.includes("table") || p.includes("column"))
      files.push("shared/schema.ts");
    if (files.length === 0) files.push("shared/schema.ts");

    // Strategy guard pre-flight: check if prompt mentions protected strategies
    if (!strategyUpdateIds) {
      // First call — check for strategy mentions server-side
      fetch("/api/strategies/check-mention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      })
        .then(r => r.json())
        .then(d => {
          if (d.triggered && d.matchedStrategies?.length > 0) {
            setStratGuardData({ matched: d.matchedStrategies, pendingPrompt: prompt });
          } else {
            sendLiveEdit(prompt, []); // no strategies touched — proceed directly
          }
        })
        .catch(() => sendLiveEdit(prompt, [])); // on error, proceed
      return;
    }

    setLiveEditLoading(true);
    setLiveEditResult(null);
    fetch("/api/live-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, files }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) {
          setLiveEditResult({ ok: false, message: d.error });
          return;
        }
        const nApplied = d.applied?.length ?? 0;
        const nErrors  = d.errors?.length  ?? 0;
        if (nApplied === 0) {
          // Nothing changed — treat as failure regardless of explanation
          const reason = nErrors > 0 ? d.errors.join("\n") : "No changes were applied.";
          setLiveEditResult({ ok: false, message: reason });
        } else if (nErrors > 0) {
          // Partial success
          setLiveEditResult({ ok: true, message: `${d.explanation || "Done"} (${nApplied} file${nApplied > 1 ? "s" : ""} updated)\n⚠ Partial: ${d.errors.join("; ")}`, reloading: true });
          setTimeout(() => window.location.reload(), 2500);
        } else {
          // Full success
          setLiveEditResult({ ok: true, message: `${d.explanation || "Done"} (${nApplied} file${nApplied > 1 ? "s" : ""} updated)`, reloading: true });
          setTimeout(() => window.location.reload(), 2500);
        }
      })
      .catch(err => setLiveEditResult({ ok: false, message: String(err) }))
      .finally(() => setLiveEditLoading(false));
  };

  // ── Live bar WebSocket ─────────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // CATCH-UP CANDLE FIX: on reconnect, fetch missing candles between the last stored
    // bar timestamp and now from the REST API, then append them individually.
    // This prevents the chart from showing a single oversized "catch-up" bar covering
    // the disconnect period — every missing candle is inserted at its correct timestamp.
    function fetchGapCandles() {
      const iv = intervalRef.current;
      const res = iv === "60m" ? "60" : iv === "1m" ? "1" : "5";
      const sym = selectedSymbol.toUpperCase();
      // Only gap-fill futures (stocks/ETFs use HTTP poll which already handles gaps)
      if (!sym.match(/^(ES|NQ|YM|CL|GC|SI|NG|MES|MNQ|RTY)[A-Z]?\d*$/i)) return;
      const now = Math.floor(Date.now() / 1000);
      const from = now - 4 * 3600; // fetch last 4 hours to cover any reconnect gap
      fetch(`/api/data/cached-continuous/${sym}/${iv}?from=${from}&to=${now}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data?.candles?.length) return;
          // Append gap candles into liveCandles — each candle at its exact timestamp.
          // Binary-merge: identical timestamps are overwritten, new ones are inserted.
          setLiveCandles(prev => {
            const result = [...prev];
            // CANDLE FIX: compute current forming bucket so we never overwrite it with a REST snapshot
            const iv = intervalRef.current;
            const intervalSecs = iv === "1m" ? 60 : iv === "60m" ? 3600 : 300;
            const currentBucket = Math.floor(Date.now() / 1000 / intervalSecs) * intervalSecs;
            for (const c of data.candles as CandleBar[]) {
              if (c.time >= currentBucket) continue; // CANDLE FIX: skip forming bar — live stream owns it
              // CHART-LOCK: after a manual Refresh, don't let gap-fill overwrite historical bars.
              // Only add bars that arrived AFTER the last rawCandleData timestamp (genuine new bars).
              if (chartLockedRef.current && (c.time as number) <= baseEndTsRef.current) continue;
              if (!isFinite(c.open) || !isFinite(c.close) || c.high <= c.low) continue;
              const idx = result.findIndex(x => x.time === c.time);
              if (idx >= 0) result[idx] = c; // overwrite stale forming bar
              else result.push(c);           // insert missing candle
            }
            return result.sort((a, b) => a.time - b.time);
          });
        })
        .catch(() => {}); // gap-fill is best-effort, never fatal
    }

    function connect() {
      setLiveStatus("connecting");
      const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/live-bars`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setLiveStatus("live");
        // Fill any gap that opened during the disconnect period
        fetchGapCandles();
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          // ── Fast path: raw price tick (no OHLCV) ──────────────────────────
          // Bypasses React state entirely — calls series.update() directly so
          // the Y-axis label and candle close update within one animation frame.
          if (msg.type === "tick") {
            const tickSym = normalizeSymbol(msg.symbol as string);
            const sel     = normalizeSymbol(selectedSymbol);
            if (tickSym && sel && tickSym === sel) {
              const p = msg.price as number;
              if (typeof p === "number" && isFinite(p) && p > 0) {
                // Track last tick time so HTTP poll doesn't overwrite live prices
                lastWsTickMsRef.current = Date.now();
                lastLivePriceRef.current = p;
                // Fast path: update chart visuals only — no React state, no bar creation.
                // Pass bucketSec so a new bar is opened when there's a session gap (stale
                // last DB bar is far in the past) — avoids the phantom catch-up bar.
                // Clock skew is harmless here: bucket boundaries are 60-3600s wide and NTP
                // keeps client/server within <1s; the authoritative "bar" message corrects
                // the bar's open/time within the next second anyway.
                const _iv = intervalRef.current;
                const _ivSec = _iv === "1m" ? 60 : _iv === "60m" ? 3600 : _iv === "15m" ? 900 : 300;
                const _bucket = Math.floor(Date.now() / 1000 / _ivSec) * _ivSec;
                chartRef.current?.updateLastBarClose(p, _bucket);

                // Break-even: once price is 3+ pts in profit, move SL to entry (once per signal)
                const BE_TRIGGER = 3;
                let beFired = false;
                for (const sig of openSignalsRef.current) { // PERF: pre-filtered to open signals only
                  const isLong = sig.direction === "Long";
                  const keyBase = `${sig.time}_${sig.direction}`;
                  if (beTriggeredRef.current.has(keyBase)) continue;
                  const locked = lockedSignalLevelsRef.current.get(keyBase);
                  if (!locked) continue;
                  const entry = locked.price;
                  const triggered = isLong
                    ? p >= entry + BE_TRIGGER && locked.sl < entry
                    : p <= entry - BE_TRIGGER && locked.sl > entry;
                  if (triggered) {
                    lockedSignalLevelsRef.current.set(keyBase, { ...locked, sl: entry });
                    beTriggeredRef.current.add(keyBase);
                    beFired = true;
                  }
                }
                if (beFired) setBeVersion(v => v + 1);
              }
            }
            return;
          }
          if (msg.type === "feedStatus") {
            const sym = normalizeSymbol(msg.symbol as string);
            const sel = normalizeSymbol(selectedSymbol);
            if (sym && sel && sym === sel) {
              setMwFeedStale(msg.status as "live" | "stale" | "unknown");
            }
            return;
          }
          // MW bulk_bars sync progress
          if (msg.type === "mw_sync_progress") {
            setMwSyncStatus("syncing");
            setMwSyncBars(msg.barsReceived as number ?? 0);
            return;
          }
          if (msg.type === "mw_sync_done") {
            setMwSyncStatus("done");
            setMwSyncBars(msg.barsReceived as number ?? 0);
            return;
          }
          // MW bulk_bars sync finished — DB now has exact MW data; force cache refresh
          if (msg.type === "data_updated") {
            // Fired by bulk_bars sync (MotiveWave historical data dump).
            // Normally blocked when chart is locked (prevents stale WS reconnect from
            // reverting the chart). Exception: within 60s of a manual Reload the MW study
            // was just forced to reconnect, so this bulk_bars IS the fresh data we want.
            const isPostReload = Date.now() - lastRefreshMsRef.current < 60_000;
            if (chartLockedRef.current && !isPostReload) return;
            // Before first manual Refresh: gate 10s to avoid double-refetch on initial load.
            // Skip this gate during post-reload window — we WANT the bulk_bars data_updated.
            if (!isPostReload && Date.now() - lastRefreshMsRef.current < 10_000) return;
            const updatedSym = normalizeSymbol(msg.symbol as string);
            const selSym = normalizeSymbol(selectedSymbol);
            if (updatedSym && selSym && updatedSym === selSym) {
              queryClient.invalidateQueries({ queryKey: ["/api/data/cached-continuous"] });
              queryClient.invalidateQueries({ queryKey: ["/api/data/cached-days", selectedSymbol] });
            }
            return;
          }
          if (msg.type === "bar_persisted") {
            // Fired when a single completed bar is written to DB. The bar is already in
            // liveCandles via the WS "bar" message above, so no query refetch is needed —
            // the chart already shows it. Background signal queries self-refresh on their
            // own refetchInterval (30s). This handler exists only to consume the message.
            return;
          }
          // AutoTrader ack/error/queued forwarded from Java study
          if (msg.type === "order_status") {
            if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
            setAutoTradeToast({ ok: true, msg: `MotiveWave: ${msg.msg}`, direction: "Long", price: 0 });
            autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 15000);
            return;
          }
          if (msg.type === "order_queued") {
            if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
            setAutoTradeToast({ ok: true, msg: `Queued in MotiveWave: ${msg.direction} @ ${Number(msg.entry).toFixed(2)} — waiting for next bar tick...`, direction: msg.direction ?? "Long", price: msg.entry ?? 0 });
            autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 15000);
            return;
          }
          if (msg.type === "order_ack") {
            if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
            setAutoTradeToast({ ok: true, msg: `Order placed in MotiveWave: ${msg.direction} @ ${Number(msg.entry).toFixed(2)}`, direction: msg.direction ?? "Long", price: msg.entry ?? 0 });
            autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 8000);
            return;
          }
          if (msg.type === "order_error") {
            if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
            setAutoTradeToast({ ok: false, msg: `MotiveWave error: ${msg.error}`, direction: "Long", price: 0 });
            autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 12000);
            return;
          }
          if (msg.type === "position_closed") {
            // Don't disable auto-trade — MW strategy auto-deactivates itself, app stays ready for next signal
            if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
            setAutoTradeToast({ ok: true, msg: "Position closed — ready for next signal", direction: "Long", price: 0 });
            autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 8000);
            return;
          }
          if (msg.type === "order_filled") {
            if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
            setAutoTradeToast({ ok: true, msg: `Order filled: ${msg.order ?? ""}`, direction: "Long", price: 0 });
            autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 8000);
            return;
          }
          if (msg.type === "flag_reset") {
            if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
            setAutoTradeToast({ ok: true, msg: "Trade lock reset — ready for new orders", direction: "Long", price: 0 });
            autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 5000);
            return;
          }
          if (msg.type === "auto_trade_state") {
            // The server is the authoritative source for auto-trade config. The terminal/iPhone
            // write it; this hidden engine MIRRORS it live so firing uses the right interval/tier.
            if (typeof msg.enabled === "boolean") {
              setAutoTradeEnabled(msg.enabled);
              autoTradeEnabledRef.current = msg.enabled;
            }
            if (Array.isArray(msg.intervals)) {
              const s = new Set<string>(msg.intervals);
              setAutoTradeIntervals(s);
              autoTradeIntervalRef.current = s;
            }
            if (Array.isArray(msg.riskLevels)) {
              // SAFETY: the engine's fire-gate independently requires safe/safeplus, so even if a
              // bad tier slipped in here it could never auto-execute — but keep the set clean too.
              const s = new Set<string>(msg.riskLevels);
              setAutoTradeRiskLevels(s);
              autoTradeRiskRef.current = s;
            }
            if (msg.direction === "both" || msg.direction === "long" || msg.direction === "short") {
              setAutoTradeDirection(msg.direction);
              autoTradeDirectionRef.current = msg.direction;
            }
            if (typeof msg.contracts === "number" && msg.contracts >= 1) {
              const n = Math.floor(msg.contracts);
              setAutoTradeContracts(n);
              autoTradeContractsRef.current = n;
            }
            if (msg.contractType === "MES" || msg.contractType === "ES") {
              setAutoTradeContractType(msg.contractType);
              autoTradeContractTypeRef.current = msg.contractType;
            }
            if (typeof msg.tp1Only === "boolean") {
              setAutoTradeTp1Only(msg.tp1Only);
              autoTradeTp1OnlyRef.current = msg.tp1Only;
            }
          }
          if (msg.type === "discord_message") {
            if (window.location.pathname !== "/discord") setDiscordUnread(n => n + 1);
            return;
          }
          if (msg.type === "footprint_candle") { // FOOTPRINT-TIER:
            const fc = msg.candle as FootprintCandle; // FOOTPRINT-TIER:
            const prevFp = footprintCandlesRef.current; // PERF:
            const lastFp = prevFp[prevFp.length - 1]; // PERF:
            if (!lastFp || lastFp.time !== fc.time) { // PERF: new bar boundary
              footprintCandlesRef.current = [...prevFp.slice(-49), fc]; // PERF:
              setFootprintCandles(footprintCandlesRef.current); // PERF: display count only
              setFpCompletedVersion(v => v + 1); // PERF: triggers signal recompute once per bar
            } else { // PERF: update to forming bar — update ref only, no React state churn
              const next = prevFp.slice(0, -1); next.push(fc); footprintCandlesRef.current = next; // PERF:
            } // PERF:
            return; // FOOTPRINT-TIER:
          } // FOOTPRINT-TIER:
          if (msg.type === "footprint_alert") { // FOOTPRINT-TIER:
            const { signalId, pocPrice, message } = msg as { signalId: number; pocPrice: number; message: string }; // FOOTPRINT-TIER:
            setFootprintAlerts(prev => ({ ...prev, [signalId]: { pocPrice, message } })); // FOOTPRINT-TIER:
            return; // FOOTPRINT-TIER:
          } // FOOTPRINT-TIER:
          if (msg.type === "footprint_data_confirmed") { // FOOTPRINT-RULE: real MW tick bid/ask data has arrived
            setFootprintDataConfirmed(true); // FOOTPRINT-RULE: flip flag — ladder now shows real data, not blank
            return; // FOOTPRINT-RULE:
          } // FOOTPRINT-RULE:
          if (msg.type !== "bar") return;
          const raw = msg.bar;
          // Only merge bars for the currently selected symbol (e.g. MESM6 → MES, MES=F → MES)
          const sym = normalizeSymbol(raw.symbol as string);
          const sel = normalizeSymbol(selectedSymbol);
          if (!sym || !sel || sym !== sel) return;
          // Filter by resolution: only apply bars that match the visible interval
          // 1m chart → accept resolution "1"; 5m/15m → accept resolution "5" or "15"; 60m → accept "60"
          const iv = intervalRef.current;
          const msgRes = msg.resolution as string | undefined;
          const wantRes = iv === "1m" ? "1" : iv === "60m" ? "60" : "5";
          // For 15m: accept either "5" (bucket client-side) or "15" (exact MW bars — use directly)
          const isExact15m = iv === "15m" && msgRes === "15";
          if (msgRes && msgRes !== wantRes && !isExact15m) return;
          // For 15m with 5m bars: bucket client-side. For exact "15" bars: use time as-is.
          const bucketSec = (iv === "15m" && !isExact15m) ? Math.floor(raw.time / 900) * 900 : raw.time;

          // CATCH-UP CANDLE FIX: validate OHLCV before merging into liveCandles.
          // Reject any bar with invalid price data — these are corrupt reconnect artifacts.
          if (!isFinite(raw.open) || !isFinite(raw.high) || !isFinite(raw.low) || !isFinite(raw.close) ||
              raw.open <= 0 || raw.high <= 0 || raw.low <= 0 || raw.close <= 0 ||
              raw.high < raw.low) return;

          const bar: CandleBar = { time: bucketSec, open: raw.open, high: raw.high, low: raw.low, close: raw.close, volume: raw.volume, rth: isRTH(bucketSec) };
          // PERF: throttle forming-bar state updates to at most 1/2s — reduces allConfluenceSignals recomputes
          // Complete bars (raw.complete === true) always pass through immediately
          if (!raw.complete) {
            const now = Date.now();
            if (now - lastFormingBarUpdateMs.current < 2000) return;
            lastFormingBarUpdateMs.current = now;
          }
          setLiveCandles(prev => {
            // Search from end — live bars always arrive at the tail (O(1) in practice vs O(n) from start)
            let idx = -1;
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].time === bar.time) { idx = i; break; }
              if (prev[i].time < bar.time) break; // bars are sorted ascending — stop early
            }
            if (idx >= 0) {
              const existing = prev[idx];
              const newHigh = Math.max(existing.high, bar.high);
              const newLow  = Math.min(existing.low,  bar.low);
              // Skip state update if nothing meaningful changed (suppresses heartbeat noise)
              if (existing.close === bar.close && existing.high === newHigh && existing.low === newLow && existing.rth === bar.rth) return prev;
              const merged: CandleBar = {
                time:   bar.time,
                open:   existing.open, // keep original open
                high:   newHigh,
                low:    newLow,
                close:  bar.close,
                volume: bar.volume ?? existing.volume ?? 0,
                rth:    bar.rth,
              };
              const next = [...prev]; next[idx] = merged; return next;
            }
            // CHART-LOCK: after a manual Refresh, block historical bars sent by MW on WS reconnect.
            // MW sometimes replays recently-completed bars when the study reconnects — these would
            // overwrite locked base candles in windowedCandles if not filtered here.
            if (chartLockedRef.current && bar.time <= baseEndTsRef.current) return prev;
            return [...prev, bar];
          });
        } catch {}
      };

      ws.onclose = () => {
        setLiveStatus("disconnected");
        reconnectTimer = setTimeout(connect, 2000); // reconnect in 2s, not 5s
      };

      ws.onerror = () => { ws?.close(); };

      // Ping every 10s to keep the connection alive through proxies/firewalls
      const pingId = window.setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 10_000);
      ws.addEventListener("close", () => window.clearInterval(pingId));
    }

    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [selectedSymbol, wsReconnectKey]);

  // Reset live candles when the symbol or interval changes
  useEffect(() => { setLiveCandles([]); }, [selectedSymbol, interval]);

  // Reset alert trackers when symbol changes — new symbol's history should not fire
  useEffect(() => {
    lastNotifiedRef.current = {
      "1m_Long": 0, "1m_Short": 0, "5m_Long": 0, "5m_Short": 0,
      "15m_Long": 0, "15m_Short": 0, "60m_Long": 0, "60m_Short": 0,
    };
    notifyInitializedRef.current = {
      "1m_Long": false, "1m_Short": false, "5m_Long": false, "5m_Short": false,
      "15m_Long": false, "15m_Short": false, "60m_Long": false, "60m_Short": false,
    };
  }, [selectedSymbol]);


  // Close symbol dropdown on outside click
  useEffect(() => {
    if (!symbolDropdownOpen) return;
    const h = (e: MouseEvent) => {
      if (symbolDropdownRef.current && !symbolDropdownRef.current.contains(e.target as Node)) {
        setSymbolDropdownOpen(false); setSymbolSearch("");
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [symbolDropdownOpen]);

  // ── Queries ─────────────────────────────────────────────────────────────
  const { data: symbolsData } = useQuery<SymbolsData>({ queryKey: ["/api/market/symbols"] });

  const { data: cachedDaysData, isLoading: daysLoading } = useQuery<{ symbol: string; days: DayInfo[] }>({
    queryKey: ["/api/data/cached-days", selectedSymbol],
    staleTime: 60_000,
  });

  const sortedDays = useMemo(() => {
    if (!cachedDaysData?.days?.length) return [];
    const todayStr = new Date().toISOString().split("T")[0];
    return [...cachedDaysData.days]
      .filter(d => d.date <= todayStr)              // drop corrupt future-dated days
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [cachedDaysData]);

  const hasCachedData = sortedDays.length > 0;

  useEffect(() => {
    if (sortedDays.length > 0) {
      const end = sortedDays.length - 1;
      setEndDayIdx(end);
      setStartDayIdx(Math.max(0, end - windowSize + 1));
    }
  }, [sortedDays.length, selectedSymbol, windowSize]);

  const windowedDays = useMemo(() =>
    sortedDays.slice(startDayIdx, endDayIdx + 1),
    [sortedDays, startDayIdx, endDayIdx]);

  const monthTicks = useMemo(() => {
    const ticks: { label: string; pct: number }[] = [];
    const total = sortedDays.length;
    if (total === 0) return ticks;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    sortedDays.forEach((day, idx) => {
      if (idx === 0 || day.date.substring(0, 7) !== sortedDays[idx - 1].date.substring(0, 7)) {
        const [y, m] = day.date.split("-");
        ticks.push({ label: `${months[parseInt(m) - 1]} '${y.slice(2)}`, pct: (idx / total) * 100 });
      }
    });
    return ticks;
  }, [sortedDays]);

  scrubberStateRef.current = { total: sortedDays.length, windowSize };

  // Fallback: when no DB days loaded yet, use last 730 days so the query always fires
  const fallbackFromTs = useMemo(() => Math.floor(Date.now() / 1000) - 730 * 86400, []);
  // toTs is always "now + 24h" — stable (computed once on mount), always covers today's session
  // regardless of how long the user keeps the app open.
  // Using windowedDays last date for toTs would exclude today's bars if today isn't yet in the
  // day list, causing the query key to cascade-change the moment today's date is added.
  const stableToTs = useMemo(() => Math.floor(Date.now() / 1000) + 86400, []);
  const fromTs = useMemo(() => windowedDays.length ? dateToTs(windowedDays[0].date, 0) : fallbackFromTs, [windowedDays, fallbackFromTs]);
  const toTs   = useMemo(() => {
    const nowTs = Math.floor(Date.now() / 1000) + 3600;
    return Math.min(stableToTs, nowTs); // never request bars dated in the future
  }, [stableToTs]);

  const fetchInterval = interval === "60m" ? "60m" : interval === "1m" ? "1m" : interval === "15m" ? "15m" : "5m";

  const { data: rawCandleData, isLoading: candlesLoading, error: candleError } = useQuery<{
    symbol: string; interval: string; candles: CandleBar[]; source: string; resolution?: string;
  }>({
    queryKey: ["/api/data/cached-continuous", selectedSymbol, fetchInterval, fromTs, toTs],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${selectedSymbol}/${fetchInterval}?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("Failed");
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      return d;
    },
    enabled: fromTs > 0 && toTs > 0,
    staleTime: Infinity,         // never auto-refetch — only handleRefresh (invalidateQueries) changes chart data
    refetchOnWindowFocus: false, // window focus must not silently revert the chart
    refetchOnReconnect: false,   // network reconnect must not silently revert the chart
    retry: false,
  });

  // Track latest timestamp from rawCandleData so fetchGapCandles knows which bars to skip when locked
  useEffect(() => {
    const candles = rawCandleData?.candles;
    if (!candles?.length) return;
    let max = 0;
    for (const c of candles) { if ((c.time as number) > max) max = c.time as number; }
    baseEndTsRef.current = max;
  }, [rawCandleData]);

  const candleData = useMemo(() => {
    if (!rawCandleData?.candles?.length) return rawCandleData;
    if (interval === "15m") {
      // The server serves NATIVE 15m bars (resolution "15") when available and only
      // falls back to 5m aggregation when no 15m bars exist. Aggregating already-15m
      // data with agg5mTo15m re-buckets it AND merges live forming bars (which arrive at
      // non-15m-aligned timestamps with volume 0) into adjacent real bars — corrupting the
      // most recent candles. So: if the data is already 15m, pass it through (cleaned +
      // aligned); only aggregate when the server fell back to 5m.
      const isNative15m = rawCandleData.resolution === "15";
      // Pre-filter bad bars (doji-wick spikes / corrupt wicks) before use/aggregation.
      const clean = rawCandleData.candles.filter(c => {
        if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) return false;
        if (c.high <= c.low) return false; // drops flat zero-range forming "dot" bars
        const range = c.high - c.low;
        if (range / c.close > 0.015 && Math.abs(c.open - c.close) / range < 0.10) return false;
        const bL = Math.min(c.open, c.close), bH = Math.max(c.open, c.close);
        if ((bL - c.low) / c.close > 0.015 || (c.high - bH) / c.close > 0.015) return false;
        return true;
      });
      if (isNative15m) {
        // Keep only true 15m-aligned bars — removes the live forming bars that the relay
        // persists at raw (non-900-aligned) timestamps and that would otherwise appear as
        // stray candles at the right edge.
        const aligned = clean.filter(c => c.time % 900 === 0);
        return { ...rawCandleData, candles: aligned };
      }
      return { ...rawCandleData, candles: agg5mTo15m(clean) };
    }
    return rawCandleData;
  }, [rawCandleData, interval]);

  // Secondary 1m fetch — needed to compute the 1m vector on 5m/15m/60m charts.
  // When the user is already on the 1m chart, rawCandleData IS 1m data so this is disabled.
  const { data: raw1mData } = useQuery<{
    symbol: string; interval: string; candles: CandleBar[]; source: string;
  }>({
    queryKey: ["/api/data/cached-continuous", selectedSymbol, "1m", fromTs, toTs],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${selectedSymbol}/1m?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: showVector && fetchInterval !== "1m" && fromTs > 0 && toTs > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Secondary 60m fetch — needed to compute the 60m vector on 1m/5m/15m charts.
  // Polygon stores 60m bars starting at 09:30 ET (13:30 UTC), not epoch-aligned to 13:00 UTC.
  // Aggregating 5m→60m with Math.floor(t/3600)*3600 produces wrong OHLC buckets for stocks,
  // causing the 60m vector to look completely different from the 60m chart's main vector.
  // Using the actual DB 60m data ensures the same bar alignment as the 60m chart.
  const { data: raw60mData } = useQuery<{
    symbol: string; interval: string; candles: CandleBar[]; source: string;
  }>({
    queryKey: ["/api/data/cached-continuous", selectedSymbol, "60m", fromTs, toTs],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${selectedSymbol}/60m?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: showVector && fetchInterval !== "60m" && fromTs > 0 && toTs > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // ── Background candle fetches for background signal monitoring ───────────
  // These run regardless of which interval is being viewed so signals fire
  // from all intervals in real-time, not just the currently displayed one.
  // No auto-refetch — data only updates when handleRefresh explicitly invalidates queries.
  const { data: bg1mData } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["/api/data/cached-continuous", selectedSymbol, "1m", fromTs, toTs, "bg"],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${selectedSymbol}/1m?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("Failed"); return r.json();
    },
    enabled: interval !== "1m" && fromTs > 0 && toTs > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data: bg5mData } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["/api/data/cached-continuous", selectedSymbol, "5m", fromTs, toTs, "bg"],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${selectedSymbol}/5m?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("Failed"); return r.json();
    },
    enabled: interval !== "5m" && fromTs > 0 && toTs > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data: bg15mData } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["/api/data/cached-continuous", selectedSymbol, "15m", fromTs, toTs, "bg"],
    queryFn: async () => {
      // 15m is aggregated from 5m
      const r = await fetch(`/api/data/cached-continuous/${selectedSymbol}/5m?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("Failed");
      const d = await r.json();
      return { ...d, candles: agg5mTo15m(d.candles ?? []) };
    },
    enabled: interval !== "15m" && fromTs > 0 && toTs > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data: bg60mData } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["/api/data/cached-continuous", selectedSymbol, "60m", fromTs, toTs, "bg"],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${selectedSymbol}/60m?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("Failed"); return r.json();
    },
    enabled: interval !== "60m" && fromTs > 0 && toTs > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // raw5mForZones removed — zones now come from ML pipeline, not client-side heuristic

  // Current interval resolution in seconds — used to filter live bar updates
  const intervalSec = interval === "1m" ? 60 : interval === "5m" || interval === "15m" ? 300 : 3600;


  // ── Symbols ───────────────────────────────────────────────────────────────
  const allSymbols = useMemo(() => {
    if (!symbolsData) return [];
    return [
      ...(symbolsData.etfs || []).map(s => ({ ...s, cat: "ETFs" })),
      ...(symbolsData.stocks || []).map(s => ({ ...s, cat: "Stocks" })),
      ...(symbolsData.futures || []).map(s => ({ ...s, cat: "Futures" })),
      ...(symbolsData.indices || []).map(s => ({ ...s, cat: "Indices" })),
    ];
  }, [symbolsData]);

  // True when the selected symbol is a futures contract (use MW live relay instead of Polygon)
  const isFutures = useMemo(() => {
    if (!symbolsData?.futures?.length) return false;
    // Also match by prefix (e.g. MESM6 matches MES from futures list)
    const sel = selectedSymbol.toUpperCase();
    return symbolsData.futures.some(f => sel === f.symbol || sel.startsWith(f.symbol));
  }, [symbolsData, selectedSymbol]);

  // 1-second HTTP poll for futures live bar (fallback to fill gaps between WebSocket pushes)
  useEffect(() => {
    if (!isFutures) return;
    const sym = selectedSymbol.toUpperCase().replace(/[A-Z]\d+$/, "").replace("=F", "");
    const poll = async () => {
      // Skip poll for 3s after a refresh — prevents stale server in-memory bar from
      // overwriting freshly loaded DB data before the real live tick resumes.
      if (Date.now() - lastRefreshMsRef.current < 3000) return;
      // Skip entirely when WS is active — WS forming-bar messages (throttled 2s) already
      // keep liveCandles current. Polling while WS is live triggers the full
      // windowedCandles→vectorLine→allConfluenceSignals recompute chain at 4Hz for no gain.
      if (Date.now() - lastWsTickMsRef.current < 2000) return;
      const iv = intervalRef.current;
      const resParam = iv === "1m" ? "?res=1" : "";
      try {
        const r = await fetch(`/api/live/bar/${sym}${resParam}`);
        if (!r.ok) return;
        const { bar } = await r.json();
        if (!bar) return;
        // Align timestamp to the same bucket the WS handler uses, so HTTP and WS bars have identical keys.
        // 15m and 60m both receive a 5m forming bar from the server — bucket it to the visible interval.
        const bucketSec = iv === "15m" ? Math.floor(bar.timeSec / 900)  * 900
                        : iv === "60m" ? Math.floor(bar.timeSec / 3600) * 3600
                        : bar.timeSec;
        const liveBar: CandleBar = { time: bucketSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, rth: isRTH(bucketSec) };
        setLiveCandles(prev => {
          const idx = prev.findIndex(c => c.time === liveBar.time);
          if (idx >= 0) {
            const newHigh = Math.max(prev[idx].high, liveBar.high);
            const newLow  = Math.min(prev[idx].low,  liveBar.low);
            // When WS ticks are active, keep the existing close so the HTTP poll doesn't
            // overwrite the more granular tick-level price — prevents 250ms price stutter.
            const wsTickRecent = Date.now() - lastWsTickMsRef.current < 5000;
            const newClose = wsTickRecent ? prev[idx].close : liveBar.close;
            if (prev[idx].close === newClose && prev[idx].high === newHigh && prev[idx].low === newLow) return prev;
            const merged: CandleBar = {
              time:   liveBar.time,
              open:   prev[idx].open, // keep original open
              high:   newHigh,
              low:    newLow,
              close:  newClose,
              volume: liveBar.volume,
              rth:    liveBar.rth,
            };
            const next = [...prev]; next[idx] = merged; return next;
          }
          // CANDLE FIX: reject stale bars that belong in baseCandles, not the live forming slot
          const iv = intervalRef.current;
          const intervalSecs = iv === "1m" ? 60 : iv === "60m" ? 3600 : 300;
          const expectedBucket = Math.floor(Date.now() / 1000 / intervalSecs) * intervalSecs;
          if (liveBar.time < expectedBucket - intervalSecs) return prev;
          return [...prev, liveBar];
        });
      } catch {}
    };
    poll();
    const id = window.setInterval(poll, 1000);
    return () => window.clearInterval(id);
  }, [selectedSymbol, isFutures]);

  // Live candle updates for stocks/ETFs — polls MarketData.app every 5s
  // Merges the last 2 hours of candles (including current forming candle) into liveCandles
  useEffect(() => {
    if (isFutures) return; // MES updates via WebSocket from mw-reader
    const iv = intervalRef.current;
    const res = iv === "60m" ? "60" : iv === "1m" ? "1" : "5";
    async function refresh() {
      // Skip for 3s after a refresh to avoid overwriting freshly loaded data
      if (Date.now() - lastRefreshMsRef.current < 3000) return;
      try {
        const r = await fetch(`/api/live/candles/${selectedSymbol}?res=${res}`);
        if (!r.ok) return;
        const data = await r.json();
        if (!data.candles?.length) return;
        setLiveCandles(data.candles as CandleBar[]);
      } catch {}
    }
    refresh();
    const id = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(id);
  }, [selectedSymbol, isFutures, interval]);

  const filteredSymbols = useMemo(() => {
    const q = symbolSearch.trim().toLowerCase();
    if (!q) return allSymbols;
    return allSymbols.filter(s => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [allSymbols, symbolSearch]);

  const groupedSymbols = useMemo(() => {
    const g: Record<string, typeof filteredSymbols> = {};
    for (const s of filteredSymbols) {
      if (!g[s.cat]) g[s.cat] = [];
      g[s.cat].push(s);
    }
    return g;
  }, [filteredSymbols]);

  const selectedName = allSymbols.find(s => s.symbol === selectedSymbol)?.name ?? "";

  // ── Window shift ──────────────────────────────────────────────────────────
  const shiftWindow = useCallback((dir: number) => {
    if (!sortedDays.length) return;
    const ns = Math.max(0, Math.min(sortedDays.length - 1, startDayIdx + dir));
    const ne = Math.min(sortedDays.length - 1, ns + windowSize - 1);
    setStartDayIdx(ns); setEndDayIdx(ne);
  }, [sortedDays.length, startDayIdx, windowSize]);

  const jumpToRange = useCallback((idx: number) => {
    if (!sortedDays.length) return;
    const hw = Math.floor(windowSize / 2);
    const center = Math.max(hw, Math.min(sortedDays.length - 1 - (windowSize - hw - 1), idx));
    const ns = Math.max(0, center - hw);
    const ne = Math.min(sortedDays.length - 1, ns + windowSize - 1);
    setStartDayIdx(ns); setEndDayIdx(ne);
  }, [sortedDays.length, windowSize]);

  const handleWindowSizeChange = useCallback((newSize: number) => {
    setWindowSize(newSize);
    if (!sortedDays.length) return;
    setStartDayIdx(Math.max(0, endDayIdx - newSize + 1));
  }, [sortedDays.length, endDayIdx]);

  // Global scrubber drag handlers
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = scrubberDragRef.current;
      if (!drag) return;
      const { total, windowSize: ws } = scrubberStateRef.current;
      if (total === 0) return;
      const dxPct = (e.clientX - drag.startX) / drag.trackWidth;
      const dxIdx = Math.round(dxPct * total);
      const newStart = Math.max(0, Math.min(total - ws, drag.startIdx + dxIdx));
      setStartDayIdx(newStart);
      setEndDayIdx(Math.min(total - 1, newStart + ws - 1));
    };
    const onUp = () => { scrubberDragRef.current = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Base candles: historical data sorted+filtered (only reruns when DB data changes)
  const baseCandles = useMemo(() => {
    const MAX_PRICE = 9e13;
    // MIN_PRICE rejects corrupt near-zero values (e.g. 2e-19) that pass "> 0" but destroy Y-scale
    const MIN_PRICE = 1;
    const MAX_TS = Math.floor(Date.now() / 1000) + 36 * 3600; // reject future-dated corrupt bars
    const sorted = (candleData?.candles ?? [])
      .filter(c => {
        if (c.time <= 1262304000 || c.time > MAX_TS) return false; // corrupt timestamp
        if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) return false;
        if (c.open < MIN_PRICE || c.high < MIN_PRICE || c.low < MIN_PRICE || c.close < MIN_PRICE) return false;
        if (c.open >= MAX_PRICE || c.high >= MAX_PRICE || c.low >= MAX_PRICE || c.close >= MAX_PRICE) return false;
        if (c.high <= c.low) return false; // strict — removes flat dot bars (open=close=high=low)
        if (!showETH && c.rth === false) return false;
        // Reject doji-wick spikes: body <10% of range on a bar with >1.5% spread.
        // These are corrupt MW binary reads — a bad float32 creates an extreme wick while
        // open/close stay near the real price. Slips through the 5% DB filter but renders
        // as a huge teal/red column with a hair-thin body on the chart.
        const range = c.high - c.low;
        if (range / c.close > 0.015 && Math.abs(c.open - c.close) / range < 0.10) return false;
        // Reject bars where any wick exceeds 1.5% of price — spike survives doji check when body is large
        const bL = Math.min(c.open, c.close), bH = Math.max(c.open, c.close);
        if ((bL - c.low) / c.close > 0.015 || (c.high - bH) / c.close > 0.015) return false;
        return true;
      })
      .sort((a, b) => a.time - b.time);
    // Neighbor-based outlier filter: reject bars where ANY OHLC value deviates >20%
    // from the previous bar's close. Catches corrupt tick/bar records that slipped
    // through server-side validation (e.g. readLastTickRecord returning a wrong float32).
    const result: CandleBar[] = [];
    for (const c of sorted) {
      if (result.length > 0) {
        const ref = result[result.length - 1].close;
        if (ref > 0 && (c.low / ref < 0.80 || c.high / ref > 1.20)) continue;
      }
      result.push(c);
    }
    // Second pass: phantom-bar detection.
    // Catches corrupt bars where body is large (doji filter misses) but the bar's midpoint
    // is inconsistent with surrounding price context. Two phantom types:
    // - Close-type: close is way off; next bar snaps back to prev level (dEnd > 0.5%)
    // - Open-type: bar opens against a large apparent gap but body fully reverses that gap
    const final: CandleBar[] = [];
    for (let i = 0; i < result.length; i++) {
      if (i > 0 && i < result.length - 1) {
        const pc = result[i - 1].close, no = result[i + 1].open;
        const surrounding = (pc + no) / 2;
        const mid = (result[i].open + result[i].close) / 2;
        if (surrounding > 0 && Math.abs(mid - surrounding) / surrounding > 0.015) {
          const dEnd = Math.abs(no - result[i].close) / result[i].close;
          const isClosePhantom = dEnd > 0.005;
          const gapDir = result[i].open - pc;
          const barDir = result[i].close - result[i].open;
          const isOpenPhantom = Math.abs(gapDir) / pc > 0.01 && Math.sign(barDir) !== Math.sign(gapDir);
          if (isClosePhantom || isOpenPhantom) continue;
        }
      }
      final.push(result[i]);
    }
    // Third pass: isolation filter — a bar must have [low,high] price overlap with at least 7
    // of its nearest 50 neighbours. Phantom bars at abnormal price levels connect to nobody.
    const MIN_CONN = 7, CONN_WIN = 25;
    return final.filter((c, i, arr) => {
      let conn = 0;
      for (let j = Math.max(0, i - CONN_WIN); j <= Math.min(arr.length - 1, i + CONN_WIN); j++) {
        if (j === i) continue;
        if (arr[j].low <= c.high && arr[j].high >= c.low && ++conn >= MIN_CONN) break;
      }
      return conn >= MIN_CONN;
    });
  }, [candleData, showETH]);

  // Merge live bars on top — runs on every tick but is O(liveCandles) not O(all candles)
  const windowedCandles = useMemo(() => {
    if (!liveCandles.length) return baseCandles;
    const MAX_PRICE = 9e13;
    const MIN_PRICE = 1;
    // Use the last historical bar as a reference to reject corrupt live prices.
    // A live bar whose close deviates >20% from the last completed bar is
    // a corrupt tick-file read (e.g. half the real price) — discard it.
    const refClose = baseCandles.length ? baseCandles[baseCandles.length - 1].close : null;
    // Validate live bars: reject corrupt prices and outliers.
    // NOTE: Do NOT add a timestamp-alignment check here — the HTTP poll sends 5m bars
    // bucketed to the visible interval (e.g. 3600-aligned for 60m chart), and
    // strict alignment would silently filter out the forming bar on every non-5m chart.
    // Catch-up candles are already rejected upstream (live-bars.ts bulk_bars validation
    // and the individual bar OHLCV check in the WS bar handler below).
    const validLive = liveCandles.filter(c =>
      isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close) &&
      c.open >= MIN_PRICE && c.high >= MIN_PRICE && c.low >= MIN_PRICE && c.close >= MIN_PRICE &&
      c.open < MAX_PRICE && c.high < MAX_PRICE && c.low < MAX_PRICE && c.close < MAX_PRICE &&
      c.high > c.low && // strict — exclude forming dot bars (first tick, open=close=high=low)
      (refClose == null || (c.close / refClose >= 0.80 && c.close / refClose <= 1.20 && c.low / refClose >= 0.80 && c.high / refClose <= 1.20)) &&
      (showETH || c.rth !== false));
    if (!validLive.length) return baseCandles;
    // Binary-search insert / overwrite live bars into sorted base array
    const result = [...baseCandles];
    for (const live of validLive) {
      let lo = 0, hi = result.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (result[mid].time < live.time) lo = mid + 1; else hi = mid; }
      if (lo < result.length && result[lo].time === live.time) result[lo] = live;
      else result.splice(lo, 0, live);
    }
    return result;
  }, [baseCandles, liveCandles, showETH]);

  // ── Vector ───────────────────────────────────────────────────────────────
  // The vector MUST be computed on ALL bars (ETH + RTH) regardless of the showETH display
  // setting. RTH-only filtering causes large staircase steps that don't match MotiveWave
  // because the 20-bar lookback window only spans ~100 RTH minutes instead of the full
  // calendar window MW/TOS uses. (See LEARNINGS.md — "Vector computation uses ALL bars")
  //
  // allBarsForVector = candleData.candles (current interval, ETH included) + live bars,
  // same outlier filter as baseCandles but without the showETH gate.
  const allBarsForVector = useMemo(() => {
    const result = filterCandlesForVector(candleData?.candles ?? []);
    // Merge live bars (binary-search insert) so the forming bar contributes to the vector
    if (liveCandles.length) {
      for (const live of liveCandles) {
        if (!isFinite(live.open) || !isFinite(live.close) || !isFinite(live.low) || !isFinite(live.high)) continue;
        if (live.low <= 0 || live.high <= 0 || live.open <= 0 || live.close <= 0 || live.high <= live.low) continue;
        let lo = 0, hi = result.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (result[mid].time < live.time) lo = mid + 1; else hi = mid; }
        if (lo < result.length && result[lo].time === live.time) result[lo] = live;
        else result.splice(lo, 0, live);
      }
    }
    return result;
  }, [candleData, liveCandles]);

  const vectorLine = useMemo(() => {
    if (!allBarsForVector.length) return [];
    const raw = computeVectorLine(allBarsForVector);
    // Forward-fill to EVERY chart candle timestamp so the LineSeries has no gaps
    const chartTimes = windowedCandles.map(c => c.time).sort((a, b) => a - b);
    return chartTimes.length ? forwardFillVector(raw, chartTimes) : raw;
  }, [allBarsForVector, windowedCandles]);

  const vectorSignals = useMemo(() =>
    showVector ? computeVectorSignals(windowedCandles, vectorLine) : [],
    [showVector, windowedCandles, vectorLine]);

  const vectorOverlays = useMemo(() =>
    // Limit to last 15 signals — historical bands accumulate alpha and create an opaque shape
    showVector ? computeVectorTradeOverlays(vectorSignals.slice(-15), windowedCandles, vectorLine)
               : { bands: [], segments: [] as TradeSegment[] },
    [showVector, vectorSignals, windowedCandles, vectorLine]);

  // Extra vector lines — all 4 intervals (1m/5m/15m/60m) shown simultaneously.
  // Each vector must be computed from its own native-resolution data so the values
  // match what you'd see on that interval's chart. The 60m vector in particular
  // must use the actual DB 60m bars (raw60mData) rather than epoch-aggregating 5m→60m,
  // because Polygon stores 60m bars at session-open alignment (09:30 ET) while
  // Math.floor(t/3600)*3600 gives epoch-aligned (09:00 ET) buckets — completely wrong OHLC.
  const extraVectorLines = useMemo(() => {
    if (!showVector) return [];

    // 1m: windowedCandles on 1m chart (includes live); otherwise dedicated fetch filtered for phantoms
    const base1m: CandleBar[] = interval === "1m"
      ? windowedCandles
      : filterCandlesForVector(raw1mData?.candles ?? []);

    // 5m: windowedCandles on 5m chart (includes live 5m bars); rawCandleData (5m) on 15m chart;
    // otherwise aggregate from already-filtered 1m.
    const base5m: CandleBar[] = interval === "5m"
      ? windowedCandles
      : interval === "15m"
        ? filterCandlesForVector(rawCandleData?.candles ?? [])
        : base1m.length ? aggToInterval(base1m, 300) : [];

    // 60m: windowedCandles on 60m chart (includes live 60m bars); actual DB 60m bars otherwise.
    // Fall back to epoch-aggregation only when raw60mData hasn't loaded yet.
    const base60m: CandleBar[] = interval === "60m"
      ? windowedCandles
      : filterCandlesForVector(raw60mData?.candles ?? (base5m.length ? aggToInterval(base5m, 3600) : []));

    const currentSec = interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : 3600;
    // Use all windowed candle times (incl. ETH) so forward-fill covers the full history.
    // This prevents extra vectors from disappearing during overnight/weekend gaps.
    const chartTimes = windowedCandles.map(c => c.time).sort((a, b) => a - b);
    if (!chartTimes.length) return [];

    const INTERVALS: Array<{ sec: number; label: string; color: string; base: CandleBar[] }> = [
      { sec: 60,   label: "1m",  color: "#60a5fa", base: base1m },
      { sec: 300,  label: "5m",  color: "#9ca3af", base: base5m },
      { sec: 900,  label: "15m", color: "#fbbf24", base: base5m.length ? aggToInterval(base5m, 900) : [] },
      { sec: 3600, label: "60m", color: "#a855f7", base: base60m },
    ];

    const result: Array<{ label: string; color: string; data: Array<{ time: number; value: number }> }> = [];
    for (const iv of INTERVALS) {
      if (iv.sec === currentSec) continue;   // already shown as main vector
      if (!iv.base.length)       continue;   // data not yet loaded
      const vec = computeVectorLine(iv.base);
      if (!vec.length) continue;
      // Forward-fill to all chart times so the line is continuous (no ETH/overnight gaps)
      result.push({ label: iv.label, color: iv.color, data: forwardFillVector(vec, chartTimes) });
    }
    return result;
  }, [showVector, rawCandleData, raw1mData, raw60mData, interval, fetchInterval, windowedCandles]);

  // Secondary vector maps used by allConfluenceSignals for tier bonus computation.
  // extraVectorLines.data is already forward-filled to windowedCandle times, so
  // building the Map directly from it gives O(1) lookup per candle timestamp.
  const extraVecSignalLines = useMemo(() => {
    return extraVectorLines.map(ev => {
      const map = new Map(ev.data.map(v => [v.time, v.value] as [number, number]));
      const flatMap     = new Map<number, boolean>();
      const declineMap  = new Map<number, boolean>();
      let declining     = false;
      let lastKnownVal: number | null = null;
      for (let i = 0; i < ev.data.length; i++) {
        const curr  = ev.data[i].value;
        const prev2 = i >= 2 ? ev.data[i - 2].value : null;
        // flat = vector barely moved over last 2 steps → side-entry environment on that interval
        flatMap.set(ev.data[i].time, prev2 !== null && Math.abs(curr - prev2) <= 1.0);
        // decline = vector is in a falling phase (reset on any upward tick)
        if (lastKnownVal !== null && curr !== lastKnownVal) {
          declining    = curr < lastKnownVal;
          lastKnownVal = curr;
        } else if (lastKnownVal === null) {
          lastKnownVal = curr;
        }
        declineMap.set(ev.data[i].time, declining);
      }
      return { label: ev.label, color: ev.color, map, flatMap, declineMap };
    });
  }, [extraVectorLines]);

  const { zoneOverlays: _zoneOverlaysPlaceholder, bandOverlayData: _bandPlaceholder, tradeSegments } = useMemo(() => ({
    zoneOverlays:    [] as ZoneOverlay[],
    bandOverlayData: [...vectorOverlays.bands, ...uploadedZones],
    tradeSegments:   vectorOverlays.segments,
  }), [vectorOverlays, uploadedZones]);


  const zoneOverlays: ZoneOverlay[] = [];

  const bandOverlayData = [...(_bandPlaceholder)];

  // Two aggregate footprint ladders: one RTH, one ETH.
  // buildProxyFootprintCandle now returns whole-number levels so no Math.floor needed. // FOOTPRINT-SIZE-FIX:
  const candleFootprintMap = useMemo(() => { // FOOTPRINT-SIZE-FIX:
    if (!showFpPanel || windowedCandles.length === 0) return undefined; // FOOTPRINT-SIZE-FIX:

    const isRTHc = (c: typeof windowedCandles[0]) => { // FOOTPRINT-SIZE-FIX:
      if (c.rth !== undefined) return c.rth !== false; // FOOTPRINT-SIZE-FIX:
      const d = new Date(c.time * 1000); // FOOTPRINT-SIZE-FIX:
      const day = d.getUTCDay(); // FOOTPRINT-SIZE-FIX:
      if (day === 0 || day === 6) return false; // FOOTPRINT-SIZE-FIX:
      const m = d.getUTCHours() * 60 + d.getUTCMinutes(); // FOOTPRINT-SIZE-FIX:
      return m >= 13 * 60 + 30 && m < 21 * 60; // RTH: 9:30 AM – 5:00 PM ET (EDT)
    }; // FOOTPRINT-SIZE-FIX:

    const buildAggregate = (candles: typeof windowedCandles, anchorTime: number, label: string): FootprintCandle | null => { // FOOTPRINT-SIZE-FIX:
      const combined = new Map<number, { bid: number; ask: number }>(); // FOOTPRINT-SIZE-FIX:
      for (const c of candles) { // FOOTPRINT-SIZE-FIX:
        const fp = buildProxyFootprintCandle(c); // FOOTPRINT-SIZE-FIX: returns whole-number levels
        for (const lv of fp.levels) { // FOOTPRINT-SIZE-FIX:
          const entry = combined.get(lv.price) ?? { bid: 0, ask: 0 }; // FOOTPRINT-SIZE-FIX:
          entry.bid += lv.bidVol; entry.ask += lv.askVol; // FOOTPRINT-SIZE-FIX:
          combined.set(lv.price, entry); // FOOTPRINT-SIZE-FIX:
        } // FOOTPRINT-SIZE-FIX:
      } // FOOTPRINT-SIZE-FIX:
      if (combined.size === 0) return null; // FOOTPRINT-SIZE-FIX:

      const prices = [...combined.keys()].sort((a, b) => a - b); // FOOTPRINT-SIZE-FIX:
      let maxVol = 0, poc = prices[0]; // FOOTPRINT-SIZE-FIX: initialize to first valid key
      for (const [price, { bid, ask }] of combined) { // FOOTPRINT-SIZE-FIX:
        if (bid + ask > maxVol) { maxVol = bid + ask; poc = price; } // FOOTPRINT-SIZE-FIX:
      } // FOOTPRINT-SIZE-FIX:
      const totalVol = prices.reduce((s, p) => s + combined.get(p)!.bid + combined.get(p)!.ask, 0); // FOOTPRINT-SIZE-FIX:
      const pocIdx = prices.indexOf(poc); // FOOTPRINT-SIZE-FIX:
      let lo = pocIdx, hi = pocIdx; // FOOTPRINT-SIZE-FIX:
      let accVol = combined.get(poc)!.bid + combined.get(poc)!.ask; // FOOTPRINT-SIZE-FIX:
      while (accVol < totalVol * 0.7) { // FOOTPRINT-SIZE-FIX:
        const lv2 = lo > 0 ? combined.get(prices[lo - 1])!.bid + combined.get(prices[lo - 1])!.ask : 0; // FOOTPRINT-SIZE-FIX:
        const hv2 = hi < prices.length - 1 ? combined.get(prices[hi + 1])!.bid + combined.get(prices[hi + 1])!.ask : 0; // FOOTPRINT-SIZE-FIX:
        if (!lv2 && !hv2) break; // FOOTPRINT-SIZE-FIX:
        if (lv2 >= hv2 && lo > 0) { lo--; accVol += lv2; } // FOOTPRINT-SIZE-FIX:
        else if (hi < prices.length - 1) { hi++; accVol += hv2; } // FOOTPRINT-SIZE-FIX:
        else break; // FOOTPRINT-SIZE-FIX:
      } // FOOTPRINT-SIZE-FIX:

      const levels: PriceLevelData[] = prices.map(price => { // FOOTPRINT-SIZE-FIX:
        const { bid, ask } = combined.get(price)!; // FOOTPRINT-SIZE-FIX:
        const buyR = bid > 0 ? ask / bid : ask > 0 ? 999 : 1; // FOOTPRINT-SIZE-FIX:
        const selR = ask > 0 ? bid / ask : bid > 0 ? 999 : 1; // FOOTPRINT-SIZE-FIX:
        const imbalance: "buy" | "sell" | "none" = buyR >= IMBALANCE_THRESHOLD ? "buy" : selR >= IMBALANCE_THRESHOLD ? "sell" : "none"; // FOOTPRINT-RULE: threshold from data source
        return { price, bidVol: bid, askVol: ask, delta: ask - bid, net: Math.abs(ask - bid), imbalance }; // FOOTPRINT-SIZE-FIX:
      }); // FOOTPRINT-SIZE-FIX:

      // Compute stacked imbalance clusters from aggregate levels
      const imbalances: ImbalanceCluster[] = []; // FOOTPRINT-SIZE-FIX:
      let csIdx = -1, csDir: "buy" | "sell" | null = null, csDelta = 0, csAsk2 = 0, csBid2 = 0; // FOOTPRINT-SIZE-FIX:
      const flush = (end: number) => { // FOOTPRINT-SIZE-FIX:
        if (csIdx < 0 || !csDir) return; // FOOTPRINT-SIZE-FIX:
        const cnt = end - csIdx; // FOOTPRINT-SIZE-FIX:
        const clRatio2 = csDir === "buy" ? (csBid2 > 0 ? csAsk2 / csBid2 : 999) : (csAsk2 > 0 ? csBid2 / csAsk2 : 999); // FOOTPRINT-SIZE-FIX:
        const clNet2   = cnt > 0 ? Math.abs(csAsk2 - csBid2) / cnt : 0; // FOOTPRINT-SIZE-FIX:
        let strengthTier: 1 | 2 | 3 = 1; // FOOTPRINT-SIZE-FIX:
        if (FOOTPRINT_DATA_CONFIRMED) { // FOOTPRINT-SIZE-FIX:
          if (clRatio2 >= MW_IMBALANCE_THRESHOLDS.tier3 && clNet2 >= NET_THRESHOLDS.tier3) strengthTier = 3; // FOOTPRINT-SIZE-FIX:
          else if (clRatio2 >= MW_IMBALANCE_THRESHOLDS.tier2 && clNet2 >= NET_THRESHOLDS.tier2) strengthTier = 2; // FOOTPRINT-SIZE-FIX:
        } else { // FOOTPRINT-SIZE-FIX:
          if (clRatio2 >= PROXY_TIER2 * IMBALANCE_THRESHOLD) strengthTier = clRatio2 >= PROXY_TIER3 * IMBALANCE_THRESHOLD ? 3 : 2; // FOOTPRINT-SIZE-FIX:
        } // FOOTPRINT-SIZE-FIX:
        imbalances.push({ startPrice: levels[csIdx].price, endPrice: levels[end - 1].price, // FOOTPRINT-SIZE-FIX:
          direction: csDir, levelCount: cnt, stacked: cnt >= 3, totalDelta: csDelta, strengthTier }); // FOOTPRINT-SIZE-FIX:
        csIdx = -1; csDir = null; csDelta = 0; csAsk2 = 0; csBid2 = 0; // FOOTPRINT-SIZE-FIX:
      }; // FOOTPRINT-SIZE-FIX:
      for (let i = 0; i < levels.length; i++) { // FOOTPRINT-SIZE-FIX:
        const lev = levels[i]; // FOOTPRINT-SIZE-FIX:
        if (lev.imbalance !== "none") { // FOOTPRINT-SIZE-FIX:
          if (lev.imbalance === csDir) { csDelta += lev.delta; csAsk2 += lev.askVol; csBid2 += lev.bidVol; } // FOOTPRINT-SIZE-FIX:
          else { flush(i); csIdx = i; csDir = lev.imbalance; csDelta = lev.delta; csAsk2 = lev.askVol; csBid2 = lev.bidVol; } // FOOTPRINT-SIZE-FIX:
        } else flush(i); // FOOTPRINT-SIZE-FIX:
      } // FOOTPRINT-SIZE-FIX:
      flush(levels.length); // FOOTPRINT-SIZE-FIX:

      return { // FOOTPRINT-SIZE-FIX:
        symbol: label, interval: "", time: anchorTime, levels, poc, // FOOTPRINT-SIZE-FIX:
        vah: prices[hi], val: prices[lo], // FOOTPRINT-SIZE-FIX:
        high: prices[prices.length - 1], low: prices[0], // FOOTPRINT-SIZE-FIX:
        totalBidVol: prices.reduce((s, p) => s + combined.get(p)!.bid, 0), // FOOTPRINT-SIZE-FIX:
        totalAskVol: prices.reduce((s, p) => s + combined.get(p)!.ask, 0), // FOOTPRINT-SIZE-FIX:
        candleDelta: 0, absorption: null, unfinishedAuction: null, complete: true, imbalances, // FOOTPRINT-SIZE-FIX:
      }; // FOOTPRINT-SIZE-FIX:
    }; // FOOTPRINT-SIZE-FIX:

    const sorted = [...windowedCandles].sort((a, b) => a.time - b.time);

    // Group candles into RTH/ETH sessions by detecting type transitions.
    // Each contiguous run of RTH candles = one RTH session; same for ETH.
    // Produces one aggregate FootprintCandle per session keyed by firstCandleTime.
    const sessions: Array<{ type: "RTH" | "ETH"; candles: typeof windowedCandles }> = [];
    let prevIsRTH: boolean | null = null;
    let curSession: (typeof sessions)[0] | null = null;
    for (const c of sorted) {
      const rth = isRTHc(c);
      if (rth !== prevIsRTH) {
        curSession = { type: rth ? "RTH" : "ETH", candles: [] };
        sessions.push(curSession);
        prevIsRTH = rth;
      }
      curSession!.candles.push(c);
    }

    // Keep last 40 sessions (~3 weeks of RTH + ETH interleaved).
    // Active session is included so the ladder still renders — zone drawing is
    // suppressed separately via the activeSessionTime prop on CandlestickChart.
    const result = new Map<number, FootprintCandle>();
    for (const sg of sessions.slice(-40)) {
      if (sg.candles.length < 2) continue;
      const agg = buildAggregate(sg.candles, sg.candles[0].time, sg.type);
      if (agg) result.set(sg.candles[0].time, agg);
    }
    return result.size > 0 ? result : undefined;
  }, [showFpPanel, windowedCandles]); // FOOTPRINT-SIZE-FIX:

  // Per-candle footprint map from real MW tick data (MW Volume Imprint style).
  // Keyed by candle time; only populated when real footprint_bar data has arrived.
  const perCandleFootprintMap = useMemo((): Map<number, FootprintCandle> | undefined => {
    if (!showFpPanel) return undefined;
    const snap = footprintCandlesRef.current; // footprintCandles state dep keeps this reactive
    if (snap.length === 0) return undefined;
    const map = new Map<number, FootprintCandle>();
    for (const fc of snap) map.set(fc.time, fc);
    return map;
  }, [showFpPanel, footprintCandles]); // FOOTPRINT-PER-CANDLE:

  // FOOTPRINT-RENDER: anchor time of the currently-active (incomplete) session.
  // Zones for this session are suppressed in the chart; the ladder still renders.
  const activeSessionTime = useMemo((): number | undefined => {
    if (!showFpPanel || !candleFootprintMap || candleFootprintMap.size === 0) return undefined;
    const nowSec = Math.floor(Date.now() / 1000);
    // windowedCandles is already sorted ascending — no copy/sort needed
    if (windowedCandles.length === 0) return undefined;
    const lastCandle = windowedCandles[windowedCandles.length - 1];
    if (nowSec - lastCandle.time > 20 * 60) return undefined; // all sessions completed
    // The active session's anchor = max key in candleFootprintMap
    let maxTime = 0;
    for (const t of candleFootprintMap.keys()) { if (t > maxTime) maxTime = t; }
    return maxTime || undefined;
  }, [showFpPanel, candleFootprintMap, windowedCandles]); // FOOTPRINT-RENDER:


  // FOOTPRINT-RULE: frozen imbalances from the opposite completed session.
  // Current RTH → use last completed ETH zones. Current ETH → use last completed RTH zones.
  // Zones are immutable once built; only mitigation (candle CLOSE through midPrice) updates them.
  const frozenImbalanceZones = useMemo((): FrozenImbalanceZone[] => {
    if (baseCandles.length === 0) return []; // FOOTPRINT-RULE:
    // PERF: uses baseCandles — frozen zones are built from completed sessions; forming bar doesn't change history
    const nowSec = Math.floor(Date.now() / 1000); // FOOTPRINT-RULE:
    const currentSession = getCurrentSessionType(nowSec); // FOOTPRINT-RULE:
    const oppositeType: "rth" | "eth" = currentSession === "rth" ? "eth" : "rth"; // FOOTPRINT-RULE: use opposite session's zones
    const lastSession = getLastCompletedSession(nowSec, oppositeType); // FOOTPRINT-RULE:
    if (!lastSession) return []; // FOOTPRINT-RULE:
    const zones = buildFrozenImbalances(baseCandles, lastSession.start, lastSession.end, oppositeType); // FOOTPRINT-RULE:
    if (zones.length === 0) return []; // FOOTPRINT-RULE:
    const candlesAfterSession = baseCandles.filter(c => c.time >= lastSession.end); // FOOTPRINT-RULE:
    return updateMitigation(zones, candlesAfterSession); // FOOTPRINT-RULE: close-only mitigation check
  }, [baseCandles]); // FOOTPRINT-RULE: PERF: baseCandles only — not windowedCandles

  // ── Milk zones for signal confluence ──────────────────────────────────────
  // RULE (user): a signal may only claim milk-zone confluence when the zones were
  // uploaded by the user via PNG (→ parsedZones). NOT auto-read Discord zones, and
  // NOT synthetic/auto-detected zones. Before a PNG upload there are zero milk zones,
  // so no trade/signal reasoning can include "Milk Zone". The Discord-zone auto-fetch
  // was intentionally removed here — it was firing milk confluence without any upload.
  const activeZones = useMemo((): ZoneBand[] => parsedZones, [parsedZones]);


  // ── Confluence signals — all risk levels ──────────────────────────────────
  // Three strategy components vote for Long direction:
  //   milkOk: price is in a bullish Milk zone
  //   vecOk:  price is above the vector (+ vector is rising)
  //   bodyOk: candle closes bullish (close > open = pattern confirmation)
  // safe=3/3, risky=2/3, riskiest=1/3
  const ATR_PERIOD = 14;

  // ── Locked signal levels ──────────────────────────────────────────────────
  // When a signal fires, its entry/TP/SL are frozen here and never change again.
  // Key: `${time}_${direction}` — unique per bar+direction.
  // This prevents live tick updates from shifting TP/SL levels after signal fires.
  type LockVal = { price: number; tp1: number; tp2: number; sl: number };
  const lockedSignalLevelsRef = useRef<Map<string, LockVal>>(new Map());
  // Signals verified for 3+ seconds — their TP/SL are frozen forever and survive exit strategy changes
  const permanentSignalLevelsRef = useRef<Map<string, LockVal>>(new Map());
  // Loaded from DB — DB values permanently win over freshly computed c.close
  const [dbSignalHistory, setDbSignalHistory] = useState<Map<string, LockVal>>(new Map());

  // ── SIGNAL TIER LOCK ──────────────────────────────────────────────────────
  // THE risk factor (tier) is decided ONCE — the first time a signal fires for a bar+direction —
  // and frozen here. Without this, every live tick re-reads footprint / milk-zone / vector and
  // re-derives the tier, so the SAME signal flickers RISKIEST→RISKY→SAFE as data arrives, which
  // corrupts auto-trade decisions. Key: `${time}_${direction}`. Stores the locked tier plus the
  // exact confirmation breakdown captured at fire time. Loaded from the DB on mount so the tier
  // survives reloads, and cleared on symbol/interval change.
  type LockTier = {
    riskLevel: "safeplus" | "safe" | "risky" | "riskiest";
    confirmations: { milkOk: boolean; milkPts?: number; vecOk: boolean; secondaryVecOk: boolean; secondaryVecCount?: number };
    footprintReading?: string;
    confidence?: number;
  };
  const lockedSignalTierRef = useRef<Map<string, LockTier>>(new Map());
  // Break-even tracking: once price reaches entry ± 3pts, SL moves to entry (once per signal)
  const beTriggeredRef   = useRef<Set<string>>(new Set());
  const [beVersion, setBeVersion] = useState(0); // increments to force allConfluenceSignals recompute
  // Ref mirror of allConfluenceSignals so the WS tick handler always sees latest signals
  const confluenceSignalsRef = useRef<typeof allConfluenceSignals>([] as any);

  type CSig = {
    time: number; price: number; high: number; low: number; direction: "Long" | "Short";
    tp1: number; tp2: number; sl: number; toTime: number;
    riskLevel: "safeplus" | "safe" | "risky" | "riskiest";
    confirmations: { milkOk: boolean; milkPts?: number; vecOk: boolean; secondaryVecOk: boolean; secondaryVecCount?: number };
    reclassifyReason?: string;
    outcome?: "win_tp1" | "win_tp2" | "win_trailer" | "loss" | "open";
    /** True when dated milk zones (fromTime > 0) were loaded at signal compute time */
    zonesLoaded?: boolean;
    /** FOOTPRINT-TIER: JSON-serialized FootprintReading, null when footprint data unavailable */
    footprintReading?: string; // FOOTPRINT-TIER:
    /** 0–100 confidence score — only main Long/Short signals ≥ 75 are emitted; tabletop uses zone votes */
    confidence?: number;
    /** FIX: interval at signal creation — used to filter SignalsPanel by current interval */
    interval?: string;
    /** Signal source — "vector-side-entry" marks the take-every-side-entry-as-Long feature (auto-trade eligible). */
    signalType?: string;
  };

  const allConfluenceSignals = useMemo((): CSig[] => {
    if (!windowedCandles.length) return [];
    // PERF: windowedCandles is already sorted (baseCandles sorted from DB; live bars binary-inserted)
    const sorted = windowedCandles;
    const barSec = interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : 3600;
    const vecMap = new Map(vectorLine.map(v => [v.time, v.value]));
    // Bull zones: label text is primary (most reliable — directly from Milk's terminology);
    // color is the fallback for zones with no label or ambiguous text.
    const isBullZone = (z: ZoneBand): boolean => {
      if (z.label) {
        const l = z.label.toLowerCase();
        // Bear keywords take priority over bull (e.g. "sellers absorb buyers" is bear)
        if (/sell|resist|bear|supply|absorb\s*buy|cap\s*session|ceiling|non.fair|iv.wall|iv.overflow|pivot(?!.*floor)|gex.wall.short|wall.short|short.median/i.test(l)) return false;
        if (/buy|demand|support|bull|absorb\s*sell|floor|gex.wall.long|wall.long|long.median|spy.floor|ovn.spy.floor/i.test(l)) return true;
      }
      // Color fallback: green/blue/teal hex OR green/blue-dominant rgba
      const c = z.color.toLowerCase().trim();
      if (c === "#22c55e" || c === "#3b82f6" || c === "#14b8a6") return true;
      const m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) { const r = +m[1], g = +m[2], b = +m[3]; return g > r || (b > r && b > g); }
      return false;
    };
    // PERF: pre-compute zone bull/bear classification once — avoids regex on every candle×zone
    const zoneBullish = activeZones.map(z => isBullZone(z));

    // ── Exit strategy: tier-aware TP/SL lookup ────────────────────────────────
    // Changing exitStrategy clears lockedSignalLevelsRef so all signals recompute cleanly.
    // When Trailer is on, TP1 from the selected tier becomes the activation level (not a fixed exit).
    const _ep = EXIT_STRATEGY_PROFILES[exitStrategy];
    const tierExits = (lv: string, rth: boolean) => {
      const side = rth ? _ep.rth : _ep.eth;
      return (side as Record<string, { tp1: number; tp2: number; sl: number }>)[lv] ?? side.riskiest;
    };

    // FOOTPRINT-TIER: build a time-indexed lookup for footprint candles received this session
    const fpCandlesSnap = footprintCandlesRef.current; // PERF: read from ref — not a React dep
    const fpByTime = new Map<number, FootprintCandle>(); // FOOTPRINT-TIER:
    for (const fc of fpCandlesSnap) fpByTime.set(fc.time, fc); // FOOTPRINT-TIER:

    // FP candles arrive in chronological order and are appended in order — no sort needed
    const sortedFpCandles = fpCandlesSnap; // PERF: already ordered by arrival time
    let fpPtr = 0; // advances through sortedFpCandles as we scan sorted candles in order // PERF:

    const raw: CSig[] = [];
    // Vector side-entry longs collected during the scan (outcome computed via the closure
    // `walkForward`, so they MUST be built inside the loop); merged into `raw` after the loop.
    const sideEntryRaw: CSig[] = [];
    const COOLDOWN_BARS   = 10;
    const ETH_COOLDOWN    = 20;
    const PROX_PTS        = 5.0;
    // Separate cooldowns per direction (LEARNINGS: shared cooldown blocks opposite-direction signals)
    let lastLongBar     = -COOLDOWN_BARS;
    let lastLongEthBar  = -ETH_COOLDOWN;
    let lastShortBar    = -COOLDOWN_BARS;
    let lastShortEthBar = -ETH_COOLDOWN;

    // Zones with fromTime > 0 are dated session zones (MWML/Discord milk zones).
    // Zones with fromTime === 0 are persistent structural levels — they don't count
    // for milk zone confirmation since they have no specific session context.
    const hasDatedZones = activeZones.some(z => (z.fromTime ?? 0) > 0);

    // ── HOD/LOD caution logic ─────────────────────────────────────────────
    // If TP1 is close to or above HOD (for longs) / below LOD (for shorts),
    // tighten TP1 so it can actually hit. TP2 is never clamped.
    const HOD_PROX_PTS  = 3.0;  // within this many pts of HOD/LOD = "close to" (TP1 tightening)
    const HOD_BUF_PTS   = 2.0;  // set TP1 to HOD − buf (or LOD + buf)
    const MIN_TP1_PTS   = 3.0;  // never squeeze TP1 below this profit
    const LOD_ENTRY_PROX = 3.0; // suppress shorts within this many pts above LOD (no downside room)
    const HOD_ENTRY_PROX = 3.0; // suppress longs within this many pts below HOD (no upside room)
    let hodDay  = -1;
    let hodHigh = -Infinity;    // RTH high of day at current candle (including current bar)
    let hodLow  =  Infinity;    // RTH low of day at current candle

    // 60m hard veto: pre-locate the 60m secondary vector line so we can check per-candle
    const vec60mLine = extraVecSignalLines.find(ev => ev.label === "60m") ?? null;

    // Precompute rolling 14-bar ATR (O(n) sliding window) — used for vector proximity tests
    const atrArr = new Float64Array(sorted.length);
    {
      let runSum = 0;
      const buf = new Float64Array(14);
      let bufLen = 0, bufIdx = 0;
      for (let i = 0; i < sorted.length; i++) {
        const b = sorted[i], p = i > 0 ? sorted[i - 1] : b;
        const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
        if (bufLen < 14) { buf[bufIdx % 14] = tr; bufLen++; }
        else { runSum -= buf[bufIdx % 14]; buf[bufIdx % 14] = tr; }
        runSum += tr; bufIdx++;
        atrArr[i] = runSum / bufLen;
      }
    }
    // How many bars back to look for a vector test (price heading towards the vector)
    const VEC_TEST_BARS = 5;

    for (let i = 0; i < sorted.length; i++) {
      const c      = sorted[i];

      // Never fire a signal on the current forming bar (complete === false).
      // Forming bars have a live close that oscillates each second — signals
      // computed here would appear, disappear, and re-appear within the same candle.
      // Signals on completed bars (complete === true or undefined for historical) are permanent.
      if ((c as any).complete === false) continue;

      // ── Update HOD/LOD before any early-exit so all RTH bars are counted ──
      const utcH    = (c.time / 3600 | 0) % 24;
      const minsUtc = utcH * 60 + ((c.time / 60 | 0) % 60);
      const rthC    = c.rth ?? isRTH(c.time);
      const cDay    = Math.floor(c.time / 86400);
      if (cDay !== hodDay) { hodDay = cDay; hodHigh = -Infinity; hodLow = Infinity; }
      // Capture HOD/LOD BEFORE the current bar (prevents suppressing valid breakout/breakdown bars).
      const prevDayHodHigh = hodHigh;
      const prevDayHodLow  = hodLow;
      if (rthC) { if (c.high > hodHigh) hodHigh = c.high; if (c.low < hodLow) hodLow = c.low; }
      // Suppress short entries approaching LOD from above (selling into a floor, no downside room).
      const nearLodShort = rthC && prevDayHodLow < Infinity
        && c.close > prevDayHodLow && c.close <= prevDayHodLow + LOD_ENTRY_PROX;
      // Suppress long entries approaching HOD from below (buying into a ceiling, no upside room).
      const nearHodLong = rthC && prevDayHodHigh > -Infinity
        && c.close >= prevDayHodHigh - HOD_ENTRY_PROX && c.close < prevDayHodHigh;

      const lb     = vecMap.get(c.time);
      const prevLb = i >= 3 ? vecMap.get(sorted[i - 3].time) : undefined;

      if (isMarketBreak(c.time)) continue;
      if (lb == null) continue;
      // USER RULE: no signals (confluence OR side-entry) in the RTH-close window 3:15–5:00 PM ET —
      // too risky into the close. ETH side-entries (outside RTH) are unaffected.
      if (rthC && isAfter315ET(c.time)) continue;

      // Compute milk-zone bonuses for both directions in a single pass.
      // Scoring:
      //   close currently INSIDE the zone → 4 pts (best — price is in the zone right now)
      //   close within 0.5 pts of zone bottom/top → 3 pts
      //   close between 0.5 and 1.5 pts outside zone → 1 pt (partial touch)
      //   close more than 1.5 pts outside zone → 0 pts
      const isRthForMilk = rthC && minsUtc >= 13 * 60 + 30 && minsUtc < 20 * 60 + 30;
      let milkPtsL = 0, milkPtsS = 0;
      let milkBullOk = false, milkBearOk = false;
      if (isRthForMilk) {
        for (let zi = 0; zi < activeZones.length; zi++) {
          const z = activeZones[zi];
          // Only dated zones (fromTime > 0) count for milk confirmation — static structural
          // zones (fromTime=0) have no session context and would bleed into all history.
          if (!(z.fromTime ?? 0) || c.time < z.fromTime! || (z.toTime != null && c.time > z.toTime)) continue;
          const bull = zoneBullish[zi];
          if (bull) {
            if (c.low <= z.topPrice + 0.5) {
              const inZone = c.close >= z.bottomPrice && c.close <= z.topPrice;
              const below = z.bottomPrice - c.close; // positive = close is below zone bottom
              const pts = inZone ? 4 : below <= 0.5 ? 3 : below <= 1.5 ? 1 : 0;
              if (pts > milkPtsL) { milkPtsL = pts; if (pts > 0) milkBullOk = true; }
            }
          } else {
            if (c.high >= z.bottomPrice - 0.5) {
              const above = c.close - z.topPrice; // positive = close is above zone top
              const inZone = c.close >= z.bottomPrice && c.close <= z.topPrice;
              const pts = inZone ? 4 : above <= 0.5 ? 3 : above <= 1.5 ? 1 : 0;
              if (pts > milkPtsS) { milkPtsS = pts; if (pts > 0) milkBearOk = true; }
            }
          }
          if (milkBullOk && milkPtsL === 4 && milkBearOk && milkPtsS === 4) break; // PERF
        }
      }

      // Secondary vector confluence: only counts when that interval's vector is flat
      // (flat = ≤1pt change over 2 steps → consolidation/side-entry on that interval per strategy)
      // PERF: single pass replaces 4 separate some()/filter() calls
      let secLongOk = false, secShortOk = false, secLongCount = 0, secShortCount = 0;
      for (const ev of extraVecSignalLines) {
        const v = ev.map.get(c.time);
        if (v == null || ev.flatMap.get(c.time) !== true) continue;
        if (c.close > v) { secLongCount++;  secLongOk  = true; }
        else if (c.close < v) { secShortCount++; secShortOk = true; }
      }

      // ── Helper: walk-forward outcome for a given set of exit prices ──────
      const walkForward = (tp1: number, tp2: number, sl: number, isLong: boolean): { outcome: CSig["outcome"]; toTime: number } => {
        // For ETH signals after today's RTH close (e.g. 22:00 UTC), rthSettleOfDay returns a
        // time already in the past — advance to the next session's close to keep exits forward.
        let settleTs = rthSettleOfDay(c.time);
        if (c.time >= settleTs) {
          for (let d = 1; d <= 4; d++) {
            settleTs = rthSettleOfDay(c.time + d * 86400);
            if (settleTs > c.time) break;
          }
        }
        const pastSessionEnd = Math.floor(Date.now() / 1000) > settleTs;

        // ── Trailer mode: TP1 is the activation level, not a fixed exit ──────
        // Phase 1: wait for price to reach TP1 (activation). SL is a hard stop.
        // Phase 2 (armed): trail the peak; exit when price retreats trailerOffset pts.
        // TP1 level comes from whichever risk tier (safe/risky/riskiest) is selected.
        if (useTrailer) {
          let activationIdx = -1;
          for (let j = i + 1; j < sorted.length; j++) {
            const f = sorted[j];
            if (f.time > settleTs) break;
            if (isLong) {
              if (f.low <= sl)   return { outcome: "loss",    toTime: f.time };
              if (f.high >= tp1) { activationIdx = j; break; }
            } else {
              if (f.high >= sl)  return { outcome: "loss",    toTime: f.time };
              if (f.low  <= tp1) { activationIdx = j; break; }
            }
          }
          if (activationIdx === -1) {
            // TP1 never reached — position ends at session close
            return { outcome: pastSessionEnd ? "loss" : "open", toTime: settleTs };
          }
          // Phase 2: trail from peak after TP1 activation
          let trailPeak = isLong ? sorted[activationIdx].high : sorted[activationIdx].low;
          for (let j = activationIdx + 1; j < sorted.length; j++) {
            const f = sorted[j];
            if (f.time > settleTs) break;
            if (isLong) {
              if (f.high > trailPeak) trailPeak = f.high;
              if (f.low <= trailPeak - trailerOffset) return { outcome: "win_trailer", toTime: f.time };
            } else {
              if (f.low < trailPeak) trailPeak = f.low;
              if (f.high >= trailPeak + trailerOffset) return { outcome: "win_trailer", toTime: f.time };
            }
          }
          // Session ended while still trailing — count as a win (trade was in profit)
          return { outcome: pastSessionEnd ? "win_trailer" : "open", toTime: settleTs };
        }

        // ── Standard TP1/TP2 fixed-exit mode ─────────────────────────────────
        let toTime = settleTs;
        let outcome: CSig["outcome"] = "open";
        for (let j = i + 1; j < sorted.length; j++) {
          const f = sorted[j];
          if (f.time > settleTs) break; // never exit past session close
          if (isLong) {
            if (f.high >= tp2) { outcome = "win_tp2"; toTime = f.time; break; }
            if (f.high >= tp1) { outcome = "win_tp1"; toTime = f.time; break; }
            if (f.low  <= sl)  { outcome = "loss";    toTime = f.time; break; }
          } else {
            if (f.low  <= tp2) { outcome = "win_tp2"; toTime = f.time; break; }
            if (f.low  <= tp1) { outcome = "win_tp1"; toTime = f.time; break; }
            if (f.high >= sl)  { outcome = "loss";    toTime = f.time; break; }
          }
        }
        // Day trading: all positions close at session end.
        // If the session is over and no TP/SL was hit (incomplete bar data), mark as loss.
        if (outcome === "open" && pastSessionEnd) {
          outcome = "loss";
        }
        return { outcome, toTime };
      };

      // Advance footprint pointer past current candle time (amortised O(1) across the loop)
      while (fpPtr < sortedFpCandles.length && sortedFpCandles[fpPtr].time < c.time) fpPtr++;

      // ── Vector side-entry longs (feature: take EVERY side entry as a Long) ───
      // Side entry = price closed below the vector last bar and back above it this bar, on a
      // flat/declining vector (same definition as computeVectorSignals). The bracket IS the
      // vector's exit strategy: stop = vector − VEC_STOP_BELOW (capped at VEC_MAX_STOP risk),
      // targets entry + VEC_TP1 / VEC_TP2. Outcome via the shared walk-forward (honours the
      // trailer toggle exactly like confluence signals). Levels are locked on first fire so the
      // live forming bar can't drift them. Persisted + auto-trade eligible via signalType.
      if (takeSideEntries) {
        const sePrev   = i > 0 ? sorted[i - 1] : undefined;
        const sePrevLb = sePrev ? vecMap.get(sePrev.time) : undefined;
        if (sePrev && sePrevLb != null && sePrev.close < sePrevLb && c.close > lb && (lb - sePrevLb) < 0) {
          const seKey = `${c.time}_Long_SE`;
          let seLock = lockedSignalLevelsRef.current.get(seKey);
          if (!seLock) {
            const seEntry = c.close;
            const seSl    = Math.max(lb - VEC_STOP_BELOW, seEntry - VEC_MAX_STOP);
            seLock = { price: seEntry, tp1: seEntry + VEC_TP1, tp2: seEntry + VEC_TP2, sl: seSl };
            lockedSignalLevelsRef.current.set(seKey, seLock);
          }
          const { outcome: seOutcome, toTime: seToTime } = walkForward(seLock.tp1, seLock.tp2, seLock.sl, true);
          sideEntryRaw.push({
            time: c.time, price: seLock.price, high: c.high, low: c.low, direction: "Long",
            tp1: seLock.tp1, tp2: seLock.tp2, sl: seLock.sl, toTime: seToTime,
            riskLevel: "risky",
            confirmations: { milkOk: false, milkPts: 0, vecOk: true, secondaryVecOk: false, secondaryVecCount: 0 },
            outcome: seOutcome, interval, signalType: "vector-side-entry", confidence: 50,
          });
        }
      }

      // USER RULE: confluence signals (milk/vector/footprint) are RTH-only. During ETH only the
      // vector side-entry above may fire — skip the rest of this bar's evaluation when not RTH.
      if (!rthC) continue;

      // ── LONG signal evaluation ──────────────────────────────────────────────
      if (c.close > lb) {
        const fpCandleL: FootprintCandle = fpByTime.get(c.time) ?? buildProxyFootprintCandle(c);
        const priorFpL = sortedFpCandles.length > 0
          ? sortedFpCandles.slice(Math.max(0, fpPtr - 3), fpPtr)
          : sorted.slice(Math.max(0, i - 4), i).map((b: CandleBar) => buildProxyFootprintCandle(b));
        const fpReadingL: FootprintReading | null = analyzeFootprint(fpCandleL, "Long", priorFpL, c.close);

        if (!fpReadingL?.vetoed) {
          const fpFullL    = fpReadingL?.confirmed ?? false;
          const fpPartialL = fpReadingL?.partial   ?? false;

          // Vector side-entry + tabletop momentum detection:
          // Side entry: previous bar closed at/below vector, current bar closed above (crossed from below).
          // Tabletop test: vector flat over last 2 bars — price tested the level and closed above (bullish momentum).
          const prevBarLb  = i > 0 ? vecMap.get(sorted[i - 1].time) : undefined;
          const prevBarLb2 = i > 1 ? vecMap.get(sorted[i - 2].time) : undefined;
          const sideEntryL = prevBarLb != null && sorted[i - 1].close <= prevBarLb && c.close > lb;
          const tabletopTestL = prevBarLb != null && prevBarLb2 != null
            && Math.abs(lb - prevBarLb) < 0.5 && Math.abs(prevBarLb - prevBarLb2) < 0.5
            && c.close > lb && c.close >= c.open;
          const vecTestedL = sideEntryL || tabletopTestL;

          // Weighted scoring: FP strong=4, FP weak=2 | MilkZone=3 | Vector=2 | Pattern=1
          // SAFE+=8+ or strong-FP-on-zone | SAFE=4–7 or partial-FP-on-zone | RISKY=3 | RISKIEST=1–2
          const fpFiresL = fpFullL || fpPartialL;
          let fpStrongL = false, fpOnMilkZoneL = false, fpPartialOnZoneL = false;
          if (fpFiresL) {
            // Condition 1: 2+ consecutive imbalance levels in buy direction
            if (fpCandleL.imbalances.some(cl => cl.direction === "buy" && cl.levelCount >= 2)) fpStrongL = true;
            // Condition 2: candle delta >= 2x average of prior candles
            if (!fpStrongL && priorFpL.length > 0) {
              const avgAbsDelta = priorFpL.reduce((s, pc) => s + Math.abs(pc.candleDelta), 0) / priorFpL.length;
              if (avgAbsDelta > 0 && Math.abs(fpCandleL.candleDelta) >= 2 * avgAbsDelta) fpStrongL = true;
            }
            // Condition 3: imbalance cluster overlaps active Milk zone
            // Strong FP on zone → SAFE+ override; partial FP on zone → SAFE floor (not SAFE+)
            outer: for (const cl of fpCandleL.imbalances) {
              for (const z of activeZones) {
                if (!(z.fromTime ?? 0) || c.time < z.fromTime! || (z.toTime != null && c.time > z.toTime)) continue;
                if (cl.startPrice <= z.topPrice && cl.endPrice >= z.bottomPrice) {
                  if (fpStrongL) { fpOnMilkZoneL = true; } else { fpPartialOnZoneL = true; }
                  break outer;
                }
              }
            }
          }
          // FIX 4: proxy data cannot be "strong" — cannot claim safeplus via FP-on-zone
          if (fpReadingL?.isProxyData) { fpStrongL = false; fpOnMilkZoneL = false; }
          const fpPtsL   = fpFiresL ? 4 : 0;
          const vecPtsL  = vecTestedL ? 2 : 0;
          const totalPtsL = fpPtsL + milkPtsL + vecPtsL;

          // SINGLE-TIER: a signal only fires when the setup clears the SAFE quality bar — the
          // same conditions that used to produce "safe"/"safeplus": ≥4 confluence pts, or a
          // footprint on/at a milk zone. Weaker setups (the old "risky"/"riskiest", 1–3 pts) are
          // no longer signals at all. Every signal that fires is labeled "safe" — no categories.
          const lockKey = `${c.time}_Long`;
          const existingTierL = lockedSignalTierRef.current.get(lockKey);
          const safeQualityL = totalPtsL >= 4 || fpOnMilkZoneL || fpPartialOnZoneL;
          const cdL = rthC ? COOLDOWN_BARS : ETH_COOLDOWN;
          // FIRE-LOCK: a NEW signal fires only if it clears the safe bar + HOD/cooldown gates.
          // An ALREADY-FIRED signal (existingTierL is set) re-emits UNCONDITIONALLY on every
          // recompute, so once a dot is on the chart it can NEVER disappear — even if late-arriving
          // footprint/milk/vector data would no longer qualify it. Fired = locked, permanently.
          const newFireL = safeQualityL && !nearHodLong && (i - (rthC ? lastLongBar : lastLongEthBar) >= cdL);
          if (existingTierL || newFireL) {
            const level = "safe" as const;
            const _wrL = signalWinRates[`safe:Long`];
            const confL = (_wrL && _wrL.sampleCount >= 5) ? Math.round(_wrL.winRate * 100) : 75;
            // Advance the cooldown anchor on every emit (locked re-emit too) so new signals stay spaced.
            if (rthC) lastLongBar = i; else lastLongEthBar = i;

            // First fire → lock the risk factor + the exact footprint/milk/vector reading.
            let tierL = existingTierL;
            if (!tierL) {
              tierL = {
                riskLevel: level,
                confirmations: { milkOk: milkBullOk, milkPts: milkPtsL, vecOk: vecTestedL, secondaryVecOk: secLongOk, secondaryVecCount: secLongCount },
                footprintReading: fpReadingL ? JSON.stringify(fpReadingL) : undefined,
                confidence: confL,
              };
              lockedSignalTierRef.current.set(lockKey, tierL);
            }
            // Tier is always "safe" now → exits use the safe profile; the lock only freezes
            // the confirmation breakdown so the chips don't flicker as data loads.
            const { tp1: tp1F, tp2: tp2F, sl: slF } = tierExits(level, rthC);
                const dbLock = dbSignalHistory.get(lockKey);
                if (dbLock) { lockedSignalLevelsRef.current.set(lockKey, dbLock); }
                else if (!lockedSignalLevelsRef.current.has(lockKey)) {
                  if (useZoneTargets) {
                    const zonesNow = activeZones.filter(z => c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity));
                    const above = zonesNow.filter(z => z.bottomPrice > c.close + 0.5).sort((a, b) => a.bottomPrice - b.bottomPrice);
                    const below = zonesNow.filter(z => z.topPrice   < c.close - 0.5).sort((a, b) => b.topPrice - a.topPrice);
                    if (above.length >= 1 && above[0].bottomPrice - c.close >= MIN_TP1_PTS) {
                      const ztTp1 = above[0].bottomPrice;
                      const ztTp2 = above[1] ? above[1].bottomPrice : above[0].topPrice;
                      const ztSl  = below.length > 0 ? below[0].bottomPrice - 0.5 : c.close - slF;
                      lockedSignalLevelsRef.current.set(lockKey, { price: c.close, tp1: ztTp1, tp2: ztTp2, sl: ztSl });
                    } else {
                      const rawTp1L = c.close + tp1F;
                      const adjTp1L = (rthC && isFinite(hodHigh) && rawTp1L >= hodHigh - HOD_PROX_PTS)
                        ? Math.max(c.close + MIN_TP1_PTS, hodHigh - HOD_BUF_PTS) : rawTp1L;
                      lockedSignalLevelsRef.current.set(lockKey, { price: c.close, tp1: adjTp1L, tp2: c.close + tp2F, sl: c.close - slF });
                    }
                  } else {
                    const rawTp1L = c.close + tp1F;
                    const adjTp1L = (rthC && isFinite(hodHigh) && rawTp1L >= hodHigh - HOD_PROX_PTS)
                      ? Math.max(c.close + MIN_TP1_PTS, hodHigh - HOD_BUF_PTS) : rawTp1L;
                    lockedSignalLevelsRef.current.set(lockKey, { price: c.close, tp1: adjTp1L, tp2: c.close + tp2F, sl: c.close - slF });
                  }
                }
                const locked = lockedSignalLevelsRef.current.get(lockKey)!;
                const entryClose = locked.price;
                const tp1 = locked.tp1, tp2 = locked.tp2, sl = entryClose - slF;

                const { outcome, toTime } = walkForward(tp1, tp2, sl, true);
                // Always "safe" — confirmations/footprint frozen on first fire (lock) so the chips
                // don't flicker; confidence falls back to the freshly computed safe win-rate.
                raw.push({ time: c.time, price: locked.price, high: c.high, low: c.low, direction: "Long", tp1, tp2, sl, toTime, riskLevel: level, confirmations: tierL.confirmations, zonesLoaded: hasDatedZones, outcome, footprintReading: tierL.footprintReading, interval, confidence: tierL.confidence ?? confL });
          }
        }
      }

      // ── SHORT signal evaluation ─────────────────────────────────────────────
      if (c.close < lb) {
        const fpCandleS: FootprintCandle = fpByTime.get(c.time) ?? buildProxyFootprintCandle(c);
        const priorFpS = sortedFpCandles.length > 0
          ? sortedFpCandles.slice(Math.max(0, fpPtr - 3), fpPtr)
          : sorted.slice(Math.max(0, i - 4), i).map((b: CandleBar) => buildProxyFootprintCandle(b));
        const fpReadingS: FootprintReading | null = analyzeFootprint(fpCandleS, "Short", priorFpS, c.close);

        if (!fpReadingS?.vetoed) {
          const fpFullS    = fpReadingS?.confirmed ?? false;
          const fpPartialS = fpReadingS?.partial   ?? false;

          // Vector side-entry + tabletop momentum detection (Short):
          // Side entry: previous bar closed at/above vector, current bar closed below (crossed from above).
          // Tabletop test: vector flat over last 2 bars — price tested the level and closed below (bearish momentum).
          const prevBarLbS  = i > 0 ? vecMap.get(sorted[i - 1].time) : undefined;
          const prevBarLbS2 = i > 1 ? vecMap.get(sorted[i - 2].time) : undefined;
          const sideEntryS = prevBarLbS != null && sorted[i - 1].close >= prevBarLbS && c.close < lb;
          const tabletopTestS = prevBarLbS != null && prevBarLbS2 != null
            && Math.abs(lb - prevBarLbS) < 0.5 && Math.abs(prevBarLbS - prevBarLbS2) < 0.5
            && c.close < lb && c.close <= c.open;
          const vecTestedS = sideEntryS || tabletopTestS;

          // Weighted scoring: FP strong=4, FP weak=2 | MilkZone=3 | Vector=2 | Pattern=1
          // SAFE+=8+ or FP-on-zone | SAFE=4–7 | RISKY=3 | RISKIEST=1–2
          const fpFiresS = fpFullS || fpPartialS;
          let fpStrongS = false, fpOnMilkZoneS = false, fpPartialOnZoneS = false;
          if (fpFiresS) {
            // Condition 1: 2+ consecutive imbalance levels in sell direction
            if (fpCandleS.imbalances.some(cl => cl.direction === "sell" && cl.levelCount >= 2)) fpStrongS = true;
            // Condition 2: candle delta >= 2x average of prior candles (negative delta for shorts)
            if (!fpStrongS && priorFpS.length > 0) {
              const avgAbsDelta = priorFpS.reduce((s, pc) => s + Math.abs(pc.candleDelta), 0) / priorFpS.length;
              if (avgAbsDelta > 0 && Math.abs(fpCandleS.candleDelta) >= 2 * avgAbsDelta) fpStrongS = true;
            }
            // Condition 3: FIX 3 — strong FP on zone → SAFE+; partial FP on zone → SAFE floor only
            outer: for (const cl of fpCandleS.imbalances) {
              for (const z of activeZones) {
                if (!(z.fromTime ?? 0) || c.time < z.fromTime! || (z.toTime != null && c.time > z.toTime)) continue;
                if (cl.startPrice <= z.topPrice && cl.endPrice >= z.bottomPrice) {
                  if (fpStrongS) { fpOnMilkZoneS = true; } else { fpPartialOnZoneS = true; }
                  break outer;
                }
              }
            }
          }
          // FIX 4: proxy data cannot be "strong" — cannot claim safeplus via FP-on-zone
          if (fpReadingS?.isProxyData) { fpStrongS = false; fpOnMilkZoneS = false; }
          const fpPtsS   = fpFiresS ? 4 : 0;
          const vecPtsS  = vecTestedS ? 2 : 0;
          const totalPtsS = fpPtsS + milkPtsS + vecPtsS;

          // SINGLE-TIER (Short): fire only when the setup clears the SAFE quality bar (≥4 pts or
          // footprint on/at a milk zone). Weaker setups are no longer signals. Every signal = "safe".
          const lockKey = `${c.time}_Short`;
          const existingTierS = lockedSignalTierRef.current.get(lockKey);
          const safeQualityS = totalPtsS >= 4 || fpOnMilkZoneS || fpPartialOnZoneS;
          const cdS = rthC ? COOLDOWN_BARS : ETH_COOLDOWN;
          // FIRE-LOCK: a NEW short fires only if it clears the safe bar + LOD/cooldown gates. An
          // ALREADY-FIRED short (existingTierS) re-emits unconditionally so it never disappears.
          const newFireS = safeQualityS && !nearLodShort && (i - (rthC ? lastShortBar : lastShortEthBar) >= cdS);
          if (existingTierS || newFireS) {
            const level = "safe" as const;
            const _wrS = signalWinRates[`safe:Short`];
            const confS = (_wrS && _wrS.sampleCount >= 5) ? Math.round(_wrS.winRate * 100) : 75;
            if (rthC) lastShortBar = i; else lastShortEthBar = i; // spacing anchor on every emit

            // First fire → lock the risk factor + the exact footprint/milk/vector reading.
            let tierS = existingTierS;
            if (!tierS) {
              tierS = {
                riskLevel: level,
                confirmations: { milkOk: milkBearOk, milkPts: milkPtsS, vecOk: vecTestedS, secondaryVecOk: secShortOk, secondaryVecCount: secShortCount },
                footprintReading: fpReadingS ? JSON.stringify(fpReadingS) : undefined,
                confidence: confS,
              };
              lockedSignalTierRef.current.set(lockKey, tierS);
            }
            // Tier is always "safe" → exits use the safe profile; lock only freezes the chips.
            const { tp1: tp1F, tp2: tp2F, sl: slF } = tierExits(level, rthC);
                const dbLock = dbSignalHistory.get(lockKey);
                if (dbLock) { lockedSignalLevelsRef.current.set(lockKey, dbLock); }
                else if (!lockedSignalLevelsRef.current.has(lockKey)) {
                  if (useZoneTargets) {
                    const zonesNow = activeZones.filter(z => c.time >= (z.fromTime ?? 0) && c.time <= (z.toTime ?? Infinity));
                    const above = zonesNow.filter(z => z.bottomPrice > c.close + 0.5).sort((a, b) => a.bottomPrice - b.bottomPrice);
                    const below = zonesNow.filter(z => z.topPrice   < c.close - 0.5).sort((a, b) => b.topPrice - a.topPrice);
                    if (below.length >= 1 && c.close - below[0].topPrice >= MIN_TP1_PTS) {
                      const ztTp1 = below[0].topPrice;
                      const ztTp2 = below[1] ? below[1].topPrice : below[0].bottomPrice;
                      const ztSl  = above.length > 0 ? above[0].topPrice + 0.5 : c.close + slF;
                      lockedSignalLevelsRef.current.set(lockKey, { price: c.close, tp1: ztTp1, tp2: ztTp2, sl: ztSl });
                    } else {
                      const rawTp1S = c.close - tp1F;
                      const adjTp1S = (rthC && isFinite(hodLow) && hodLow < Infinity && rawTp1S <= hodLow + HOD_PROX_PTS)
                        ? Math.min(c.close - MIN_TP1_PTS, hodLow + HOD_BUF_PTS) : rawTp1S;
                      lockedSignalLevelsRef.current.set(lockKey, { price: c.close, tp1: adjTp1S, tp2: c.close - tp2F, sl: c.close + slF });
                    }
                  } else {
                    const rawTp1S = c.close - tp1F;
                    const adjTp1S = (rthC && isFinite(hodLow) && hodLow < Infinity && rawTp1S <= hodLow + HOD_PROX_PTS)
                      ? Math.min(c.close - MIN_TP1_PTS, hodLow + HOD_BUF_PTS) : rawTp1S;
                    lockedSignalLevelsRef.current.set(lockKey, { price: c.close, tp1: adjTp1S, tp2: c.close - tp2F, sl: c.close + slF });
                  }
                }
                const locked = lockedSignalLevelsRef.current.get(lockKey)!;
                const entryClose = locked.price;
                const tp1 = locked.tp1, tp2 = locked.tp2, sl = entryClose + slF;

                const { outcome, toTime } = walkForward(tp1, tp2, sl, false);
                // Always "safe" — confirmations/footprint frozen on first fire; confidence falls
                // back to the freshly computed safe win-rate.
                raw.push({ time: c.time, price: locked.price, high: c.high, low: c.low, direction: "Short", tp1, tp2, sl, toTime, riskLevel: level, confirmations: tierS.confirmations, zonesLoaded: hasDatedZones, outcome, footprintReading: tierS.footprintReading, interval, confidence: tierS.confidence ?? confS });
          }
        }
      }

    }

    // Merge vector side-entry longs, skipping bars where a confluence Long already fired
    // (a confluence Long takes priority and avoids the (symbol,interval,time,direction) DB
    // unique-key collision since both persist as direction "Long").
    if (sideEntryRaw.length) {
      const longTimes = new Set(raw.filter(s => s.direction === "Long").map(s => s.time));
      for (const se of sideEntryRaw) if (!longTimes.has(se.time)) raw.push(se);
    }

    // Sort by time so the panel shows signals in chronological order
    return raw.sort((a, b) => a.time - b.time);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowedCandles, vectorLine, interval, extraVecSignalLines, activeZones, dbSignalHistory, exitStrategy, useTrailer, trailerOffset, beVersion, fpCompletedVersion, useZoneTargets, signalWinRates, takeSideEntries]); // PERF: fpCompletedVersion replaces latestFootprintCandle+footprintCandles — increments only on new complete bar

  // Keep ref mirror in sync so the WS tick handler always has current signals
  useEffect(() => { confluenceSignalsRef.current = allConfluenceSignals; }, [allConfluenceSignals]);
  // PERF: pre-filter to open signals only — BE loop iterates this instead of full list
  const openSignalsRef = useRef<CSig[]>([]);
  useEffect(() => {
    openSignalsRef.current = allConfluenceSignals.filter(s => !s.outcome || s.outcome === "open");
  }, [allConfluenceSignals]);

  // Show signals at or above the selected quality threshold, keeping all visible levels
  // Every signal is a single "safe" tier now — no risk categories, so no tier filtering.
  const confluenceSignals = useMemo(() => allConfluenceSignals, [allConfluenceSignals]);

  // ── Signal persistence: load from DB into state so allConfluenceSignals can depend on it ──
  // DB values are the permanent truth — they always win over freshly computed c.close locks.
  useEffect(() => {
    // Clear stale locks from the previous symbol/interval immediately
    lockedSignalLevelsRef.current.clear();
    lockedSignalTierRef.current.clear(); // TIER LOCK: reset frozen risk factors on symbol/interval switch
    beTriggeredRef.current.clear();
    setDbSignalHistory(new Map());
    fetch(`/api/signals/history/${encodeURIComponent(selectedSymbol)}/${interval}`)
      .then(r => r.json())
      .then((data: { signals?: Array<{ timestamp: number; direction: string; entry: number; tp1: number; tp2: number; sl: number; riskLevel?: string; confirmations?: string; footprintReading?: string }> }) => {
        if (!data.signals?.length) return;
        const newMap = new Map<string, LockVal>();
        for (const s of data.signals) {
          const val: LockVal = { price: s.entry, tp1: s.tp1, tp2: s.tp2, sl: s.sl };
          // Store under all key variants used by the useMemo
          newMap.set(`${s.timestamp}_${s.direction}`, val);
          newMap.set(`${s.timestamp}_Pure${s.direction}`, val);
          newMap.set(`${s.timestamp}_Side${s.direction}`, val);
          // TIER LOCK: restore the risk factor the PC locked when the signal first fired, so a
          // reload re-uses the SAME tier instead of re-deriving (and possibly flickering) it.
          if (s.riskLevel === "safeplus" || s.riskLevel === "safe" || s.riskLevel === "risky" || s.riskLevel === "riskiest") {
            let conf: LockTier["confirmations"] = { milkOk: false, vecOk: false, secondaryVecOk: false };
            try { if (s.confirmations) conf = { ...conf, ...JSON.parse(s.confirmations) }; } catch { /* keep default */ }
            lockedSignalTierRef.current.set(`${s.timestamp}_${s.direction}`, {
              riskLevel: s.riskLevel, confirmations: conf, footprintReading: s.footprintReading,
            });
          }
        }
        // Also sync into lockedSignalLevelsRef so in-session locking stays consistent
        newMap.forEach((val, key) => lockedSignalLevelsRef.current.set(key, val));
        // Setting state triggers allConfluenceSignals to re-run with DB values winning
        setDbSignalHistory(newMap);
      })
      .catch(() => {});
  }, [selectedSymbol, interval]);

  // ── Persist newly computed signals to DB ─────────────────────────────────────
  // Signals are written in TWO passes:
  //   1. On first fire (outcome="open") — terminal sees the signal immediately.
  //   2. On outcome resolution (win/loss/tp1/tp2) — server upserts to update outcome.
  // The dedup key includes the outcome so both writes fire; the server handles idempotency.
  // Previously this skipped outcome="open", meaning live signals never appeared in the
  // terminal until they had already closed — which is too late.
  const persistedSignalKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!allConfluenceSignals.length) return;
    const toSave = allConfluenceSignals.filter(s => {
      // Key includes outcome so a signal is persisted both when first open AND when it closes.
      const key = `${selectedSymbol}_${interval}_${s.time}_${s.direction}_${s.outcome ?? "open"}`;
      if (persistedSignalKeysRef.current.has(key)) return false;
      persistedSignalKeysRef.current.add(key);
      return true;
    });
    if (!toSave.length) return;
    fetch("/api/signals/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signals: toSave.map(s => ({
          symbol: selectedSymbol,
          interval,
          timestamp: s.time,
          direction: s.direction,
          riskLevel: s.riskLevel,
          entry: s.price,
          tp1: s.tp1,
          tp2: s.tp2,
          sl: s.sl,
          outcome: s.outcome,
          signalType: s.signalType, // e.g. "vector-side-entry" — keeps the source visible on iPhone
          footprintReading: s.footprintReading, // FOOTPRINT-TIER:
          confirmations: JSON.stringify(s.confirmations), // PARITY: iPhone chip breakdown
        })),
      }),
    }).catch(() => {});
  }, [allConfluenceSignals, selectedSymbol, interval]);

  // ── Today's panel signals (bottom slide-up) ──────────────────────────────
  // Use the last visible day in the chart window so signals always appear,
  // even on weekends (last trading day = Friday) or when viewing historical data.
  const todayStartSec = useMemo(() => {
    if (windowedDays.length) {
      return dateToTs(windowedDays[windowedDays.length - 1].date, 0);
    }
    const ET_OFFSET_H = 4;
    const nowMs = Date.now() - ET_OFFSET_H * 3_600_000;
    const d = new Date(nowMs);
    return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + ET_OFFSET_H * 3_600_000) / 1000);
  }, [windowedDays]);

  // ── Background signals for all intervals ─────────────────────────────────
  // Each interval always sources from its own data — background fetch or current view.
  const bgSignals1m  = useMemo(() => {
    const candles = interval === "1m" ? windowedCandles : (bg1mData?.candles ?? []);
    if (!candles.length) return [];
    return computeBgSignals(candles, computeVectorLine(candles), activeZones);
  }, [windowedCandles, bg1mData, interval, activeZones]);

  const bgSignals5m  = useMemo(() => {
    const candles = interval === "5m" ? windowedCandles : (bg5mData?.candles ?? []);
    if (!candles.length) return [];
    return computeBgSignals(candles, computeVectorLine(candles), activeZones);
  }, [windowedCandles, bg5mData, interval, activeZones]);

  const bgSignals15m = useMemo(() => {
    const candles = interval === "15m" ? windowedCandles : (bg15mData?.candles ?? []);
    if (!candles.length) return [];
    return computeBgSignals(candles, computeVectorLine(candles), activeZones);
  }, [windowedCandles, bg15mData, interval, activeZones]);

  const bgSignals60m = useMemo(() => {
    const candles = interval === "60m" ? windowedCandles : (bg60mData?.candles ?? []);
    if (!candles.length) return [];
    return computeBgSignals(candles, computeVectorLine(candles), activeZones);
  }, [windowedCandles, bg60mData, interval, activeZones]);

  // Keep latestSignalsRef in sync so the 3s auto-trade confirmation callback
  // can verify a signal is still live before sending an order.
  useEffect(() => {
    const keys = new Set<string>();
    for (const s of [...bgSignals1m, ...bgSignals5m, ...bgSignals15m, ...bgSignals60m, ...allConfluenceSignals]) {
      keys.add(`${s.time}_${s.direction}`);
    }
    latestSignalsRef.current = keys;
  }, [bgSignals1m, bgSignals5m, bgSignals15m, bgSignals60m, allConfluenceSignals]);

  // ── Multi-interval live confluence signal detection ───────────────────────
  // Fires for all intervals regardless of which one is currently viewed.
  // On first load (initialized=false), silently records the latest signal time
  // so history doesn't trigger notifications — only NEW signals fire.
  const fireSignalNotification = (
    sig: {
      direction: "Long" | "Short"; price: number; tp1: number; tp2: number; sl: number; time: number;
      riskLevel?: string; confidence?: number;
      confirmations?: { milkOk: boolean; vecOk: boolean; secondaryVecOk: boolean };
      footprintReading?: string; signalType?: string;
    },
    ivLabel: string,
    autoTradeEligible = true,
  ) => {
    // Build human-readable score breakdown from confirmation fields
    const parts: string[] = [];
    if (sig.confirmations?.milkOk) parts.push("Zone");
    const fp = sig.footprintReading ? (() => { try { return JSON.parse(sig.footprintReading!); } catch { return null; } })() : null;
    if (fp?.confirmed) parts.push("FP✓");
    else if (fp?.partial) parts.push("FP~");
    if (sig.confirmations?.vecOk) parts.push("Vec");
    const scoreLabel = parts.join(" · ");

    setLiveAlert({ direction: sig.direction, price: sig.price, tp1: sig.tp1, tp2: sig.tp2, sl: sig.sl, time: sig.time, interval: ivLabel, riskLevel: sig.riskLevel, confidence: sig.confidence, scoreLabel });
    if (alertDismissTimer.current) clearTimeout(alertDismissTimer.current);
    alertDismissTimer.current = setTimeout(() => setLiveAlert(null), 30_000);

    // 3-second verification: if the signal survives 3s it is real, not transient tick noise.
    // Once verified: cancel the auto-dismiss so the alert stays on screen permanently,
    // and freeze the TP/SL levels so exit strategy changes cannot alter them mid-trade.
    if (signalVerifyTimerRef.current) clearTimeout(signalVerifyTimerRef.current);
    const vSigKey = `${sig.time}_${sig.direction}`;
    signalVerifyTimerRef.current = setTimeout(() => {
      signalVerifyTimerRef.current = null;
      if (!latestSignalsRef.current.has(vSigKey)) return; // disappeared — transient noise, do nothing
      // Cancel the auto-dismiss — signal is verified, keep the alert on screen until user closes it
      if (alertDismissTimer.current) { clearTimeout(alertDismissTimer.current); alertDismissTimer.current = null; }
      // Freeze TP/SL: prefer the locked value (zone-target or profile based), fall back to signal snapshot
      const frozen = lockedSignalLevelsRef.current.get(vSigKey) ?? { price: sig.price, tp1: sig.tp1, tp2: sig.tp2, sl: sig.sl };
      permanentSignalLevelsRef.current.set(vSigKey, frozen);
      // Re-seed into lockedSignalLevelsRef so any immediate recompute also uses the frozen values
      lockedSignalLevelsRef.current.set(vSigKey, frozen);
    }, 3000);

    // Discord alert — fire ONLY after the signal survives 3s (a REAL fired signal). Firing
    // immediately spammed Discord for forming-bar signals that vanish as the bar updates. Uses a
    // standalone per-signal timer (NOT the shared verify ref) so concurrent Long+Short both alert,
    // and a one-shot guard so a tier upgrade on the same bar doesn't double-send.
    if (discordWebhookRef.current && !discordSentRef.current.has(vSigKey)) {
      setTimeout(() => {
        if (!latestSignalsRef.current.has(vSigKey)) return;     // vanished — transient noise, no alert
        if (discordSentRef.current.has(vSigKey)) return;        // already alerted this bar+direction
        discordSentRef.current.add(vSigKey);
        if (discordSentRef.current.size > 500) discordSentRef.current.clear(); // bound memory
        const lv = permanentSignalLevelsRef.current.get(vSigKey)
          ?? lockedSignalLevelsRef.current.get(vSigKey)
          ?? { price: sig.price, tp1: sig.tp1, tp2: sig.tp2, sl: sig.sl };
        fetch("/api/discord/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: selectedSymbol,
            direction: sig.direction,
            interval: ivLabel,
            riskLevel: sig.riskLevel ?? "unknown",
            confidence: sig.confidence ?? 0,
            scoreLabel,
            price: lv.price, tp1: lv.tp1, tp2: lv.tp2, sl: lv.sl,
          }),
        }).then(r => {
          if (!r.ok) r.json().then(d => console.warn("[Discord] Send failed:", d.error)).catch(() => {});
        }).catch(e => console.warn("[Discord] Network error:", e));
      }, 3000);
    }

    const tierLabel = sig.riskLevel === "safeplus" ? "SAFE+" : (sig.riskLevel ?? "").toUpperCase();
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(
          `${tierLabel} — ${selectedSymbol} ${ivLabel} ${sig.direction === "Long" ? "▲ LONG" : "▼ SHORT"}`,
          { body: `${scoreLabel}${sig.confidence != null ? ` (${sig.confidence}%)` : ""}  Entry ${sig.price.toFixed(2)}  TP1 ${sig.tp1.toFixed(2)}  SL ${sig.sl.toFixed(2)}` }
        );
      } catch {}
    }

    try {
      const ac = new AudioContext();
      const isSafePlus = sig.riskLevel === "safeplus";
      if (isSafePlus) {
        // SAFE+: double-beep ascending chord — distinct from single-sweep
        const playBeep = (startT: number, freq: number) => {
          const o = ac.createOscillator(); const g2 = ac.createGain();
          o.connect(g2); g2.connect(ac.destination);
          o.type = "sine"; o.frequency.setValueAtTime(freq, startT);
          g2.gain.setValueAtTime(0.3, startT);
          g2.gain.exponentialRampToValueAtTime(0.001, startT + 0.2);
          o.start(startT); o.stop(startT + 0.22);
        };
        const base = sig.direction === "Long" ? 880 : 550;
        playBeep(ac.currentTime, base);
        playBeep(ac.currentTime + 0.28, base * 1.25);
      } else {
        const osc = ac.createOscillator(); const g = ac.createGain();
        osc.connect(g); g.connect(ac.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(sig.direction === "Long" ? 660 : 440, ac.currentTime);
        osc.frequency.linearRampToValueAtTime(sig.direction === "Long" ? 990 : 330, ac.currentTime + 0.25);
        g.gain.setValueAtTime(0.25, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.5);
        osc.start(); osc.stop(ac.currentTime + 0.5);
      }
    } catch {}

    // Auto-trade execution — only when enabled + passes filters.
    // Signal must remain confirmed for 3 seconds before the order is sent.
    // If it disappears within that window (transient tick noise), the order is cancelled.
    // autoTradeEligible=false for background signals (computeBgSignals) — they do NOT
    // persist to DB and would fire trades with no visible signal dot on the chart.
    if (!autoTradeEligible) {
      console.log(`[auto-trade] BG SIGNAL — not eligible for auto-trade (no DB entry): ${sig.direction} ${ivLabel} @ ${sig.price}`);
    }
    if (!autoTradeEnabledRef.current) {
      console.log(`[auto-trade] DISABLED — signal missed: ${sig.direction} ${ivLabel} @ ${sig.price}`);
    }
    if (autoTradeEligible && autoTradeEnabledRef.current) {
      // Vector side-entry longs are an explicit, opt-in auto-trade type: they bypass the
      // safe/safe+ tier gate (per user config) but still honour interval + direction filters.
      const isSideEntry = sig.signalType === 'vector-side-entry';
      const isPermanentRisk = sig.riskLevel === 'safe' || sig.riskLevel === 'safeplus';
      const riskOk = isSideEntry || (isPermanentRisk && autoTradeRiskRef.current.has(sig.riskLevel ?? ""));
      const ivOk   = autoTradeIntervalRef.current.has(ivLabel);
      const dirFilter = autoTradeDirectionRef.current;
      const dirOk  = dirFilter === "both"
        || (dirFilter === "long"  && sig.direction === "Long")
        || (dirFilter === "short" && sig.direction === "Short");
      const showToast = (ok: boolean, msg: string) => {
        if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
        setAutoTradeToast({ ok, msg, direction: sig.direction, price: sig.price });
        autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 8000);
      };
      if (!riskOk || !ivOk || !dirOk) {
        const reason = !ivOk ? `interval ${ivLabel} not in filter (${[...autoTradeIntervalRef.current].join(",")})` : !riskOk ? `risk level "${sig.riskLevel ?? "?"}" not in filter` : `direction ${sig.direction} blocked by "${autoTradeDirectionRef.current}" filter`;
        console.warn(`[auto-trade] FILTERED — ${sig.direction} ${ivLabel} @ ${sig.price}: ${reason}`);
        showToast(false, `Filtered: ${reason}`);
      } else {
        const sigKey = `${sig.time}_${sig.direction}`;
        // Cancel any prior pending order — new signal supersedes it
        if (pendingAutoTradeRef.current) {
          clearTimeout(pendingAutoTradeRef.current.timer);
          pendingAutoTradeRef.current = null;
        }
        showToast(true, `Signal detected — confirming in 3s (${sig.direction} @ ${sig.price.toFixed(2)})`);
        const timer = setTimeout(() => {
          pendingAutoTradeRef.current = null;
          // Abort if signal is no longer present — it was transient tick noise
          if (!latestSignalsRef.current.has(sigKey)) {
            showToast(false, `Auto-trade cancelled — signal at ${sig.price.toFixed(2)} invalidated before confirmation`);
            return;
          }
          // Signal confirmed stable — compute levels and send order
          const _ep = EXIT_STRATEGY_PROFILES[exitStrategy];
          const _sigRth = isRTH(sig.time);
          const _te = (_sigRth ? _ep.rth : _ep.eth)[sig.riskLevel as keyof typeof _ep.rth] ?? (_sigRth ? _ep.rth : _ep.eth).riskiest;
          const _slFixed  = _te.sl;
          const _tp1Fixed = _te.tp1;
          const _tp2Fixed = _te.tp2;
          // Prefer the signal's actual SL (may be FP/zone-target adjusted); fallback to tier profile
          const _sl  = (sig.sl  != null && sig.sl  !== sig.price) ? sig.sl  : (sig.direction === "Long" ? sig.price - _slFixed  : sig.price + _slFixed);
          const _tp1 = (sig.tp1 != null && sig.tp1 !== sig.price) ? sig.tp1 : (sig.direction === "Long" ? sig.price + _tp1Fixed : sig.price - _tp1Fixed);
          const _tp2 = (sig.tp2 != null && sig.tp2 !== sig.price) ? sig.tp2 : (sig.direction === "Long" ? sig.price + _tp2Fixed : sig.price - _tp2Fixed);
          // Validate bracket: SL must be on the correct side of entry
          const _slValid = sig.direction === "Long" ? _sl < sig.price : _sl > sig.price;
          const _slSafe  = _slValid ? _sl : (sig.direction === "Long" ? sig.price - _slFixed : sig.price + _slFixed);
          fetch("/api/trade/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              symbol: autoTradeContractTypeRef.current,
              direction: sig.direction,
              interval: ivLabel,
              riskLevel: sig.riskLevel,
              price: sig.price,
              tp1: _tp1,
              tp2: _tp2,
              sl: _slSafe,
              contracts: autoTradeContractsRef.current,
              tp1Only: autoTradeTp1OnlyRef.current,
              useTrailer: useTrailerRef.current,
              trailingOffset: trailerOffsetRef.current,
            }),
          }).then(async r => {
            if (r.ok) {
              showToast(true, `Order sent to MotiveWave: ${autoTradeContractsRef.current}x ${autoTradeContractTypeRef.current} ${sig.direction} @ ${sig.price.toFixed(2)}`);
            } else {
              const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
              showToast(false, d.error ?? `HTTP ${r.status}`);
            }
          }).catch(e => showToast(false, `Network error: ${e.message}`));
        }, 3000);
        pendingAutoTradeRef.current = { timer, key: sigKey };
      }
    }
    // (Discord alert moved into the 3s-verify callback above — only fires for confirmed signals.)
  };

  // Risk level rank — higher number = better confirmation. Used to detect zone upgrades.
  const RISK_RANK: Record<string, number> = { riskiest: 0, risky: 1, safe: 2, safeplus: 3 };

  const checkIntervalSignals = (
    signals: Array<{ time: number; direction: "Long" | "Short"; price: number; tp1: number; tp2: number; sl: number; riskLevel: string }>,
    ivKey: string,
    ivLabel: string,
    ivSec: number,
  ) => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Check Long and Short independently — a recent Long must not block a Short (and vice-versa)
    for (const dir of ["Long", "Short"] as const) {
      const notifyKey = `${ivKey}_${dir}`;
      const dirSigs = signals.filter(s => s.direction === dir);
      // Always initialize both directions on first pass — even if no signals exist for this
      // direction yet. Prevents the first Short of an all-Long day from being silently swallowed.
      if (!notifyInitializedRef.current[notifyKey]) {
        lastNotifiedRef.current[notifyKey] = dirSigs.length ? dirSigs[dirSigs.length - 1].time : 0;
        lastNotifiedRiskRef.current[notifyKey] = dirSigs.length ? (dirSigs[dirSigs.length - 1].riskLevel ?? "riskiest") : "riskiest";
        notifyInitializedRef.current[notifyKey] = true;
        continue;
      }
      if (!dirSigs.length) continue;
      const latest = dirSigs[dirSigs.length - 1];
      const lastTime = lastNotifiedRef.current[notifyKey] ?? 0;
      const lastRisk = lastNotifiedRiskRef.current[notifyKey] ?? "riskiest";
      const isNewBar  = latest.time > lastTime;
      const isUpgrade = latest.time === lastTime &&
        (RISK_RANK[latest.riskLevel ?? "riskiest"] ?? 0) > (RISK_RANK[lastRisk] ?? 0);
      if (!isNewBar && !isUpgrade) continue;
      // Only fire if signal is fresh (within last 2 bar intervals of now)
      if (nowSec - latest.time > ivSec * 2) {
        lastNotifiedRef.current[notifyKey] = latest.time;
        lastNotifiedRiskRef.current[notifyKey] = latest.riskLevel ?? "riskiest";
        continue;
      }
      lastNotifiedRef.current[notifyKey] = latest.time;
      lastNotifiedRiskRef.current[notifyKey] = latest.riskLevel ?? "riskiest";
      // Background signals: notifications/Discord only — NOT auto-trade eligible
      // (they are not saved to DB and would produce trades with no chart signal dot).
      fireSignalNotification(latest, ivLabel, false);
    }
  };

  // Primary: watch allConfluenceSignals — fires the moment a new signal bar appears.
  // Also re-fires if zones UPGRADE a signal from risky → safe so auto-trade catches the
  // confirmed entry. lastNotifiedRef + lastNotifiedRiskRef prevent any other double-firing.
  // This takes priority because it shares lastNotifiedRef with the bg* effects below;
  // whichever fires first sets the time and blocks the other from double-firing.
  useEffect(() => {
    if (!allConfluenceSignals.length) return;
    const ivSec = interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : 3600;
    const nowSec = Math.floor(Date.now() / 1000);
    const ivKey = interval;
    // Check Long and Short independently — a recent Long must not block a Short (and vice-versa)
    for (const dir of ["Long", "Short"] as const) {
      const notifyKey = `${ivKey}_${dir}`;
      const dirSigs = allConfluenceSignals.filter(s => s.direction === dir);
      if (!notifyInitializedRef.current[notifyKey]) {
        // Always initialize both directions on first pass — even if no signals exist for this
        // direction yet. If we only initialize when signals exist, the first real signal of an
        // unseen direction (e.g. first Short on an all-Long day) would be silently swallowed.
        lastNotifiedRef.current[notifyKey] = dirSigs.length ? dirSigs[dirSigs.length - 1].time : 0;
        lastNotifiedRiskRef.current[notifyKey] = dirSigs.length ? (dirSigs[dirSigs.length - 1].riskLevel ?? "riskiest") : "riskiest";
        notifyInitializedRef.current[notifyKey] = true;
        continue;
      }
      if (!dirSigs.length) continue;
      const latest = dirSigs[dirSigs.length - 1];
      const lastTime = lastNotifiedRef.current[notifyKey] ?? 0;
      const lastRisk = lastNotifiedRiskRef.current[notifyKey] ?? "riskiest";
      const isNewBar  = latest.time > lastTime;
      // Zone upgrade: same bar but Milk zones now confirm a higher tier (risky→safe etc.)
      const isUpgrade = latest.time === lastTime &&
        (RISK_RANK[latest.riskLevel ?? "riskiest"] ?? 0) > (RISK_RANK[lastRisk] ?? 0);
      if (!isNewBar && !isUpgrade) continue;
      if (nowSec - latest.time > ivSec * 2) {
        // Signal is stale — record it but don't fire (prevent firing when app catches up)
        lastNotifiedRef.current[notifyKey] = latest.time;
        lastNotifiedRiskRef.current[notifyKey] = latest.riskLevel ?? "riskiest";
        continue;
      }
      lastNotifiedRef.current[notifyKey] = latest.time;
      lastNotifiedRiskRef.current[notifyKey] = latest.riskLevel ?? "riskiest";
      fireSignalNotification(latest, ivKey);
    }
  }, [allConfluenceSignals]);

  // Background intervals — catch signals on intervals other than the currently viewed one
  useEffect(() => {
    if (interval === "1m") return; // allConfluenceSignals already covers current interval
    checkIntervalSignals(bgSignals1m,  "1m",  "1m",  60);
  }, [bgSignals1m, interval]);

  useEffect(() => {
    if (interval === "5m") return;
    checkIntervalSignals(bgSignals5m,  "5m",  "5m",  300);
  }, [bgSignals5m, interval]);

  useEffect(() => {
    if (interval === "15m") return;
    checkIntervalSignals(bgSignals15m, "15m", "15m", 900);
  }, [bgSignals15m, interval]);

  useEffect(() => {
    if (interval === "60m") return;
    checkIntervalSignals(bgSignals60m, "60m", "60m", 3600);
  }, [bgSignals60m, interval]);

  // Request browser notification permission once
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  const currentDay = windowedDays.length ? windowedDays[windowedDays.length - 1] : null;

  // OHLCV display: prefer crosshair values, fall back to current day
  const ohlcv = crosshair ?? (currentDay ? {
    open: currentDay.open, high: currentDay.high,
    low: currentDay.low, close: currentDay.close, volume: currentDay.volume,
  } : null);

  // Drawing handlers
  const handleAddDrawing = useCallback((d: Drawing) => {
    setDrawings(prev => [...prev, d]);
  }, []);

  const handleUpdateDrawing = useCallback((updated: Drawing) => {
    setDrawings(prev => prev.map(d => d.id === updated.id ? updated : d));
  }, []);

  const undoLastDrawing = useCallback(() => {
    setDrawings(prev => prev.slice(0, -1));
  }, []);

  const clearDrawings = useCallback(() => {
    setDrawings([]);
  }, []);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    // Unlock so this refresh can freely update rawCandleData
    chartLockedRef.current = false;
    // Lock polling for 3s — prevents stale HTTP-poll bars from overwriting
    // freshly loaded DB data before the live WS tick feed resumes.
    lastRefreshMsRef.current = Date.now();
    try {
      // Re-read MotiveWave bar files from disk → refresh DB (futures only)
      if (isFutures) {
        await fetch("/api/admin/reload-mw", { method: "POST" }).catch(() => {});
        // Also kick off a Yahoo Finance historical backfill in the background.
        // ON CONFLICT DO NOTHING so MW relay data is never overwritten.
        fetch("/api/data/yahoo-backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: selectedSymbol }),
        }).catch(() => {});
      }
      // Refetch all candle + day data from DB. Await completion before touching anything else.
      // (Clearing liveCandles BEFORE this would blank the chart during the refetch.)
      await queryClient.invalidateQueries({ queryKey: ["/api/data/cached-days", selectedSymbol] });
      await queryClient.invalidateQueries({ queryKey: ["/api/data/cached-continuous"] });
      // Force the chart to call series.setData() on ALL bars, not just the last one.
      // Required because structKey only detects timestamp/count changes — if historical bars
      // are corrected in the DB (same timestamps, updated OHLCV), the chart would otherwise
      // only update the last bar via the fast path.
      setChartRefreshKey(k => k + 1);

      // Sync baseEndTs from the fresh query cache NOW, before locking and before WS reconnects.
      // The useEffect that normally updates baseEndTsRef fires async (after render), so
      // fetchGapCandles triggered by the reconnect below would use a stale anchor without this.
      try {
        const freshQueries = queryClient.getQueriesData<{ candles?: Array<{ time: number }> }>({
          queryKey: ["/api/data/cached-continuous"],
        });
        let freshMax = 0;
        for (const [, d] of freshQueries) {
          if (d?.candles) {
            for (const c of d.candles) {
              const t = c.time as number;
              if (t > freshMax) freshMax = t;
            }
          }
        }
        if (freshMax > 0) baseEndTsRef.current = freshMax;
      } catch { /* non-fatal */ }

      // Lock chart BEFORE reconnecting WS so gap-fill respects the fresh baseEndTs anchor.
      chartLockedRef.current = true;

      // Clear stale forming bars — base data is now fresh so the blank gap is minimal.
      setLiveCandles([]);

      // Fetch current live price BEFORE reconnecting WS.
      // The await yields to the microtask queue, letting React re-render and the candle
      // useEffect re-run (rebuilding _compPairs from base-only data). Without this yield,
      // the WS could receive a tick before _compPairs is rebuilt, placing the forming bar
      // at a stale high index and creating a visible gap in the chart.
      const sym = selectedSymbol.toUpperCase().replace(/[A-Z]\d+$/, "").replace("=F", "");
      const r = await fetch(`/api/live/bar/${sym}`);
      if (r.ok) {
        const { bar, price } = await r.json();
        if (typeof price === "number" && price > 0) {
          chartRef.current?.updateLastBarClose(price);
        } else if (bar?.close) {
          chartRef.current?.updateLastBarClose(bar.close);
        }
      }

      // Reconnect WS after the live-price fetch so the candle useEffect has had time to
      // rebuild bar-index maps. Ticks that arrive now will use the correct _compPairs.
      setWsReconnectKey(k => k + 1);
    } finally {
      setRefreshing(false);
      // Ensure lock is set even if an error occurred mid-refresh.
      chartLockedRef.current = true;
    }
  }, [refreshing, isFutures, queryClient, selectedSymbol]);

  // Signals refresh: invalidate candle data so allConfluenceSignals recomputes, then persist to DB.
  const handleRefreshSignals = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["/api/data/cached-continuous"] });
    await fetch("/api/learn/backfill", { method: "POST" }).catch(() => {});
  }, [queryClient]);

  // ── Zone file upload ──────────────────────────────────────────────────────
  const zoneFileInputRef = useRef<HTMLInputElement>(null);

  const handleZoneFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setZoneUploading(true);
    try {
      const reader = new FileReader();
      const base64: string = await new Promise((resolve, reject) => {
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const body: Record<string, unknown> = { filename: file.name, data: base64 };
      // For screenshots, provide visible chart price range as context
      if (/\.(png|jpg|jpeg|webp|gif)$/i.test(file.name)) {
        const lastCandle = (windowedCandles ?? []).at(-1);
        const firstCandle = (windowedCandles ?? []).at(0);
        if (lastCandle && firstCandle) {
          const prices = (windowedCandles ?? []).flatMap(c => [c.high, c.low]);
          body.visibleHigh = Math.max(...prices);
          body.visibleLow  = Math.min(...prices);
        }
      }
      const r = await fetch("/api/zones/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) { alert(`Zone parse error: ${data.error ?? data.message ?? r.status}`); return; }
      const count = data.count as number;
      if (count === 0) {
        const snippet = data.xmlSnippet ? `\n\nFile preview:\n${data.xmlSnippet}` : "";
        alert(`No zones found in ${file.name}. The file may use an unsupported format.${snippet}`);
        return;
      }

      // Convert parsed zones → ZoneBand objects with automatic color coding
      const rawZones = data.zones as Array<{ topPrice: number; bottomPrice: number; fillColor: string; fromTime: number; toTime: number; label?: string; zoneScope?: "ovn" | "rth" }>;
      const lastPrice = windowedCandles?.at(-1)?.close ?? 0;

      // Filter out clearly bogus values (version numbers, style IDs, etc.)
      // Use wide ±60% band so legitimate zones from adjacent contracts still load.
      // If lastPrice is unknown, only filter extreme outliers (< 1 or > 10,000,000).
      const priceFloor = lastPrice > 0 ? lastPrice * 0.4 : 1;
      const priceCeil  = lastPrice > 0 ? lastPrice * 1.6 : 10_000_000;
      const filteredZones = rawZones.filter(z =>
        z.topPrice >= priceFloor && z.topPrice <= priceCeil &&
        z.bottomPrice >= priceFloor && z.bottomPrice <= priceCeil
      );
      // If price filter killed everything, fall back to accepting all parsed zones
      const finalZones = filteredZones.length > 0 ? filteredZones : rawZones;

      // Keep ALL zones — large structural zones (IV Wall, Max Range, Normal Range, etc.) are
      // intentionally wide and must be shown. Only filter genuinely absurd values: zones whose
      // MIDPOINT is more than 600 pts from current price (completely off-screen) to catch bad parses.
      const displayZones = lastPrice > 0
        ? finalZones.filter(z => Math.abs((z.topPrice + z.bottomPrice) / 2 - lastPrice) <= 600)
        : finalZones;

      // DST-aware helper: returns UTC timestamp for a given ET date + hour:minute.
      // Tries EDT (UTC-4) first, verifies via Intl, falls back to EST (UTC-5).
      const etToUtc = (y: number, m: number, d: number, h: number, min: number): number => {
        const edtTs = Date.UTC(y, m - 1, d, h + 4, min, 0) / 1000;
        const check = parseInt(
          new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false })
            .format(new Date(edtTs * 1000))
        );
        return check === h ? edtTs : Date.UTC(y, m - 1, d, h + 5, min, 0) / 1000;
      };

      // Current ET calendar date — determines which session "today" means.
      const etDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
      const [etYear, etMonth, etDay] = etDateStr.split("-").map(Number);

      // Today's RTH open: 9:30 AM ET on the current ET calendar date.
      const todayRthOpen = etToUtc(etYear, etMonth, etDay, 9, 30);

      const todayRthClose = todayRthOpen + 23400; // +6.5 h = 4:00 PM ET RTH close (one session)

      // RULE (user): a milk zone is valid for ONE RTH session only — never the overnight or
      // multiple days. Every uploaded zone is time-bounded to today's RTH session (9:30 AM ET
      // open → 4:00 PM ET close) so it charts at the correct time and never extends farther
      // than a single session.
      const zoneBands: ZoneBand[] = displayZones.map(z => ({
        topPrice:    z.topPrice,
        bottomPrice: z.bottomPrice,
        color:       z.fillColor,
        label:       z.label,
        fromTime:    todayRthOpen,
        toTime:      todayRthClose,
      }));

      setUploadedZones([]);
      setDrawings(prev => prev.filter(d => !d.id.startsWith("zone-")));
      setParsedZones(zoneBands);
      setZoneCount(zoneBands.length);

      // Scroll the chart to today's mid-RTH so zones are immediately visible.
      const ivSec = IVAL_SEC[interval] ?? 900;
      const rthMid = todayRthOpen + Math.round(23400 / 2); // 12:45 PM ET
      setTimeout(() => chartRef.current?.scrollToTime(rthMid, ivSec, 60), 100);
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setZoneUploading(false);
      e.target.value = "";
    }
  }, [windowedCandles, interval]);

  // Scroll to time from URL param (e.g. coming from Today's Signals "View on Chart")
  const urlTimeScrolledRef = useRef(false);
  useEffect(() => {
    if (!urlTime || urlTimeScrolledRef.current) return;
    if (!windowedCandles.length) return;
    urlTimeScrolledRef.current = true;
    const ivSec = IVAL_SEC[interval] ?? 300;
    // Small delay to let the chart finish rendering its initial data
    const t = setTimeout(() => { chartRef.current?.scrollToTime(urlTime, ivSec, urlPadding); }, 300);
    return () => clearTimeout(t);
  }, [urlTime, windowedCandles, interval]);

  // Deselect tool on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveTool("cursor");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ background: MW.bg, color: MW.text, fontFamily: "'Trebuchet MS', 'Roboto', sans-serif" }}
    >
      {/* ── Top toolbar ───────────────────────────────────────────────── */}
      <header
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{ height: 44, position: "relative", background: "linear-gradient(180deg, #0d1a30 0%, #0a1322 100%)", borderBottom: `1px solid ${MW.border}`, boxShadow: "0 8px 24px -16px rgba(47,155,255,0.55)" }}
      >
        {/* Animated flowing accent line beneath the toolbar */}
        <div className="mg-accent-bar" style={{ position: "absolute", left: 0, right: 0, bottom: 0, pointerEvents: "none" }} />

        {/* Symbol selector */}
        <div className="relative" ref={symbolDropdownRef}>
          <button
            data-testid="button-symbol-dropdown"
            className="flex items-center gap-2 px-3 h-8 rounded"
            style={{
              background: MW.panel, border: `1px solid ${MW.border}`,
              color: MW.text, fontSize: 13, fontWeight: 600, cursor: "pointer",
              minWidth: 160,
            }}
            onClick={() => { setSymbolDropdownOpen(o => !o); setSymbolSearch(""); }}
          >
            <span className="mg-accent-text" style={{ fontWeight: 800, letterSpacing: 0.3 }}>{selectedSymbol}</span>
            <span style={{ color: MW.muted, fontWeight: 400, fontSize: 11, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selectedName}
            </span>
          </button>

          {symbolDropdownOpen && (
            <div
              className="absolute z-50 overflow-hidden shadow-2xl"
              style={{ top: "100%", left: 0, marginTop: 4, width: 280, background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 6 }}
            >
              <div className="p-2" style={{ borderBottom: `1px solid ${MW.border}` }}>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: MW.muted }} />
                  <Input
                    data-testid="input-symbol-search"
                    placeholder="Search symbol or type to confirm..."
                    value={symbolSearch}
                    onChange={e => setSymbolSearch(e.target.value.toUpperCase())}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        // Exact match first, then first filtered result
                        const exact = filteredSymbols.find(s => s.symbol === symbolSearch.trim().toUpperCase());
                        const pick = exact ?? filteredSymbols[0];
                        if (pick) { setSelectedSymbol(pick.symbol); setSymbolDropdownOpen(false); setSymbolSearch(""); }
                      } else if (e.key === "Escape") {
                        setSymbolDropdownOpen(false); setSymbolSearch("");
                      }
                    }}
                    autoFocus
                    className="pl-8 h-8 text-sm border-0 focus-visible:ring-0"
                    style={{ background: MW.bg, color: MW.text, fontSize: 12 }}
                  />
                </div>
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {/* Favorites section — pinned at top if any */}
                {favoriteSymbols.length > 0 && !symbolSearch && (
                  <div>
                    <div className="px-3 py-1" style={{ fontSize: 10, fontWeight: 700, color: "#f59e0b", background: MW.toolbar, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      ★ Favorites
                    </div>
                    {allSymbols.filter(s => favoriteSymbols.includes(s.symbol)).map(s => (
                      <div key={s.symbol} className="flex items-center" style={{ background: s.symbol === selectedSymbol ? MW.accent + "22" : "transparent", borderLeft: s.symbol === selectedSymbol ? `2px solid ${MW.accent}` : "2px solid transparent" }}
                        onMouseEnter={e => (e.currentTarget.style.background = MW.border)}
                        onMouseLeave={e => (e.currentTarget.style.background = s.symbol === selectedSymbol ? MW.accent + "22" : "transparent")}
                      >
                        <button className="flex-1 px-3 py-1.5 text-left flex items-center gap-2" style={{ background: "transparent", color: MW.text, fontSize: 12, cursor: "pointer", border: "none" }}
                          onClick={() => { setSelectedSymbol(s.symbol); setSymbolDropdownOpen(false); setSymbolSearch(""); }}>
                          <span style={{ fontWeight: 600, color: s.symbol === selectedSymbol ? MW.accent : MW.text }}>{s.symbol}</span>
                          <span style={{ color: MW.muted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                        </button>
                        <button onClick={e => { e.stopPropagation(); toggleFavSymbol(s.symbol); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#f59e0b", fontSize: 13, padding: "0 8px", flexShrink: 0, lineHeight: 1 }}>★</button>
                      </div>
                    ))}
                  </div>
                )}
                {Object.entries(groupedSymbols).map(([cat, syms]) => (
                  <div key={cat}>
                    <div className="px-3 py-1" style={{ fontSize: 10, fontWeight: 700, color: MW.muted, background: MW.toolbar, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      {cat}
                    </div>
                    {syms.map(s => {
                      const isFav = favoriteSymbols.includes(s.symbol);
                      return (
                        <div key={s.symbol} className="flex items-center" style={{ background: s.symbol === selectedSymbol ? MW.accent + "22" : "transparent", borderLeft: s.symbol === selectedSymbol ? `2px solid ${MW.accent}` : "2px solid transparent" }}
                          onMouseEnter={e => (e.currentTarget.style.background = MW.border)}
                          onMouseLeave={e => (e.currentTarget.style.background = s.symbol === selectedSymbol ? MW.accent + "22" : "transparent")}
                        >
                          <button
                            data-testid={`button-symbol-${s.symbol}`}
                            className="flex-1 px-3 py-1.5 text-left flex items-center gap-2"
                            style={{ background: "transparent", color: MW.text, fontSize: 12, cursor: "pointer", border: "none" }}
                            onClick={() => { setSelectedSymbol(s.symbol); setSymbolDropdownOpen(false); setSymbolSearch(""); }}
                          >
                            <span style={{ fontWeight: 600, color: s.symbol === selectedSymbol ? MW.accent : MW.text }}>{s.symbol}</span>
                            <span style={{ color: MW.muted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                          </button>
                          <button onClick={e => { e.stopPropagation(); toggleFavSymbol(s.symbol); }}
                            title={isFav ? "Remove from favorites" : "Add to favorites"}
                            style={{ background: "none", border: "none", cursor: "pointer", color: isFav ? "#f59e0b" : MW.muted, fontSize: 13, padding: "0 8px", flexShrink: 0, lineHeight: 1, opacity: isFav ? 1 : 0.4 }}>
                            {isFav ? "★" : "☆"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
                {!filteredSymbols.length && (
                  <div className="px-3 py-4 text-center" style={{ color: MW.muted, fontSize: 12 }}>No symbols found</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Live indicator (futures only) */}
        {isFutures && (() => {
          const wsOk    = liveStatus === "live";
          const isStale = wsOk && mwFeedStale === "stale";
          const dotColor = !wsOk ? (liveStatus === "connecting" ? "#f59e0b" : "#4a6080")
                         : isStale ? "#f59e0b" : "#26c87a";
          const bg    = !wsOk ? "#1a1a1a" : isStale ? "#2a1800" : "#0d2a1a";
          const border= !wsOk ? MW.border  : isStale ? "#f59e0b55" : "#26c87a55";
          const label = !wsOk ? (liveStatus === "connecting" ? "CONNECTING" : "OFFLINE")
                      : isStale ? "MW STALE" : "LIVE";
          const title = isStale ? "Rithmic feed stopped sending data. MW shows green but ticks are frozen — reconnect MW to Rithmic." : undefined;
          return (
            <div className="flex items-center gap-1.5 px-2 h-7 rounded" title={title}
              style={{ background: bg, border: `1px solid ${border}` }}>
              <span style={{
                display: "inline-block", width: 7, height: 7, borderRadius: "50%",
                background: dotColor,
                boxShadow: wsOk && !isStale ? "0 0 6px #26c87a" : "none",
                animation: wsOk && !isStale ? "pulse 1.4s ease-in-out infinite" : "none",
              }} />
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: dotColor }}>
                {label}
              </span>
            </div>
          );
        })()}

        {/* MW sync indicator */}
        {mwSyncStatus !== "done" && (
          <div className="flex items-center gap-1.5 px-2 h-7 rounded"
            style={{ background: "#0d1a2a", border: `1px solid ${mwSyncStatus === "syncing" ? "#f59e0b55" : "#4a608055"}` }}>
            {mwSyncStatus === "syncing" && (
              <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "#f59e0b",
                animation: "pulse 0.8s ease-in-out infinite" }} />
            )}
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
              color: mwSyncStatus === "syncing" ? "#f59e0b" : "#4a6080" }}>
              {mwSyncStatus === "syncing" ? `SYNCING ${mwSyncBars.toLocaleString()} bars` : "WAITING FOR MW"}
            </span>
          </div>
        )}

        {/* Timeframe tabs */}
        <div className="flex items-center rounded overflow-hidden" style={{ border: `1px solid ${MW.border}`, background: MW.panel }}>
          {(["1m","5m","15m","60m"] as const).map(iv => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              style={{
                padding: "0 10px", height: 28, fontSize: 11, fontWeight: interval === iv ? 700 : 400,
                background: interval === iv ? MW.accent : "transparent",
                color: interval === iv ? "#fff" : MW.muted,
                cursor: "pointer", border: "none", outline: "none",
                borderRight: iv !== "60m" ? `1px solid ${MW.border}` : "none",
              }}
            >
              {iv}
            </button>
          ))}
        </div>

        {/* ETH toggle */}
        <button
          onClick={() => setShowETH(v => !v)}
          title={showETH ? "Extended hours visible — click to show RTH only" : "RTH only — click to show extended hours"}
          style={{
            marginLeft: 6, padding: "0 9px", height: 28, fontSize: 11, fontWeight: showETH ? 600 : 400, borderRadius: 4,
            background: showETH ? "#1a2d42" : "transparent",
            border: `1px solid ${showETH ? "#3b82f655" : MW.border}`,
            color: showETH ? "#60a5fa" : MW.muted,
            cursor: "pointer",
          }}
        >ETH</button>

        {/* Separator */}
        <div style={{ width: 1, height: 20, background: MW.border, margin: "0 4px" }} />

        {/* Overlay toggles */}
        <button
          onClick={() => setShowVector(v => !v)}
          style={{
            padding: "0 10px", height: 28, fontSize: 11, fontWeight: showVector ? 700 : 400, borderRadius: 4,
            background: showVector ? "#9ca3af22" : "transparent",
            color: showVector ? "#9ca3af" : MW.muted,
            border: `1px solid ${showVector ? "#9ca3af66" : MW.border}`,
            cursor: "pointer",
          }}
        >
          Vector
        </button>

        {/* FOOTPRINT-TIER: opens ladder panel + enables imbalance zone overlay on chart */}
        <button
          onClick={() => setShowFpPanel(prev => !prev)}
          title={footprintCandles.length ? `Footprint ladder (${footprintCandles.length} live candles)` : "Footprint ladder — proxy synthesized from OHLCV"}
          style={{
            padding: "0 10px", height: 28, fontSize: 11, fontWeight: showFpPanel ? 700 : 400, borderRadius: 4,
            background: showFpPanel ? "rgba(168,85,247,0.15)" : "transparent",
            color: showFpPanel ? "#a855f7" : MW.muted,
            border: `1px solid ${showFpPanel ? "rgba(168,85,247,0.5)" : MW.border}`,
            cursor: "pointer",
          }}
        >
          Footprint
        </button>

        {/* Risk-level dropdown removed — there are no signal categories anymore. Every signal
            is a single "safe" tier, so there is nothing to filter by. */}

        {/* Zone upload */}
        <input
          ref={zoneFileInputRef}
          type="file"
          accept=".mwml,.xml,.png,.jpg,.jpeg,.webp,.gif,.pdf"
          style={{ display: "none" }}
          onChange={handleZoneFileChange}
        />
        <div style={{ position: "relative" }}>
          <button
            onClick={() => zoneCount > 0 ? setShowZoneList(v => !v) : zoneFileInputRef.current?.click()}
            disabled={zoneUploading}
            title={zoneCount > 0 ? "Show zone list" : "Upload .mwml or screenshot to plot zones on chart"}
            style={{
              padding: "0 10px", height: 28, fontSize: 11, borderRadius: 4,
              background: zoneCount > 0 ? "rgba(100,140,255,0.15)" : "transparent",
              color: zoneCount > 0 ? "#7ba7ff" : MW.muted,
              border: `1px solid ${zoneCount > 0 ? "#7ba7ff66" : MW.border}`,
              cursor: zoneUploading ? "default" : "pointer",
              fontWeight: zoneCount > 0 ? 700 : 400,
            }}
          >
            {zoneUploading ? "Parsing…" : zoneCount > 0 ? `Zones (${zoneCount})` : "Upload Zones"}
          </button>

          {/* Zone list dropdown */}
          {showZoneList && parsedZones.length > 0 && (
            <div
              style={{
                position: "absolute", top: 32, left: 0, zIndex: 200,
                background: MW.panel, border: `1px solid ${MW.border}`,
                borderRadius: 6, minWidth: 260, maxHeight: 360, overflowY: "auto",
                boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
              }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ padding: "8px 10px 4px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${MW.border}` }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: MW.text }}>Zones ({parsedZones.length})</span>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    onClick={() => zoneFileInputRef.current?.click()}
                    style={{ fontSize: 10, padding: "2px 7px", borderRadius: 3, background: "transparent", border: `1px solid ${MW.border}`, color: MW.muted, cursor: "pointer" }}
                  >Replace</button>
                  <button
                    onClick={() => { setUploadedZones([]); setParsedZones([]); setZoneCount(0); setShowZoneList(false); setDrawings(prev => prev.filter(d => !d.id.startsWith("zone-"))); }}
                    style={{ fontSize: 10, padding: "2px 7px", borderRadius: 3, background: "transparent", border: `1px solid #EF535044`, color: "#EF5350", cursor: "pointer" }}
                  >Clear</button>
                  <button onClick={() => setShowZoneList(false)} style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                </div>
              </div>
              {[...parsedZones].sort((a, b) => b.topPrice - a.topPrice).map((z, i) => {
                const scopeSec = z.fromTime ? z.fromTime % 86400 : -1;
                const isRthZone = scopeSec === 48600 || scopeSec === 52200;
                const scopeTag = z.fromTime ? (isRthZone ? "RTH" : "OVN") : null;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: `1px solid ${MW.border}22` }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: z.color, flexShrink: 0, opacity: 0.9 }} />
                    <div style={{ flex: 1, fontSize: 11, color: MW.text, fontVariantNumeric: "tabular-nums" }}>
                      <span style={{ color: "#26C87A" }}>{z.topPrice.toFixed(2)}</span>
                      <span style={{ color: MW.muted, margin: "0 4px" }}>–</span>
                      <span style={{ color: "#EF5350" }}>{z.bottomPrice.toFixed(2)}</span>
                    </div>
                    {scopeTag && <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: isRthZone ? "rgba(38,200,122,0.18)" : "rgba(100,140,255,0.18)", color: isRthZone ? "#26C87A" : "#7ba7ff", fontWeight: 700 }}>{scopeTag}</span>}
                    {z.label && <span style={{ fontSize: 10, color: MW.muted, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{z.label}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {zoneCount > 0 && !showZoneList && (
          <button
            onClick={() => { setUploadedZones([]); setParsedZones([]); setZoneCount(0); setDrawings(prev => prev.filter(d => !d.id.startsWith("zone-"))); }}
            title="Clear uploaded zones"
            style={{ width: 20, height: 20, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center",
              background: "transparent", border: "none", color: MW.muted, cursor: "pointer", fontSize: 14, lineHeight: 1 }}
          >×</button>
        )}
        {zoneCount > 0 && (
          <button
            onClick={() => setShowMilkZones(v => !v)}
            title={showMilkZones ? "Hide Milk zones on chart" : "Show Milk zones on chart"}
            style={{ padding: "0 8px", height: 28, fontSize: 11, borderRadius: 4,
              background: showMilkZones ? "rgba(100,140,255,0.12)" : "transparent",
              color: showMilkZones ? "#7ba7ff" : MW.muted,
              border: `1px solid ${showMilkZones ? "#7ba7ff44" : MW.border}`,
              cursor: "pointer" }}
          >{showMilkZones ? "Zones On" : "Zones Off"}</button>
        )}

        {/* Window size */}
        <Select value={String(windowSize)} onValueChange={v => handleWindowSizeChange(Number(v))}>
          <SelectTrigger
            className="h-7 border-0 focus:ring-0 text-xs"
            style={{ background: MW.panel, border: `1px solid ${MW.border}`, color: MW.muted, width: 72 }}
            data-testid="select-window-size"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={{ background: MW.panel, border: `1px solid ${MW.border}`, color: MW.text }}>
            {[20,40,60,90,180,365,730].map(n => <SelectItem key={n} value={String(n)}>{n}d</SelectItem>)}
            <SelectItem value="9999">ALL</SelectItem>
          </SelectContent>
        </Select>

        {/* Spacer */}
        <div className="flex-1" />

        <div style={{ width: 1, height: 20, background: MW.border }} />

        {/* Live clock */}
        <div style={{
          padding: "0 10px", height: 28, display: "flex", alignItems: "center", gap: 4,
          fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", fontVariantNumeric: "tabular-nums",
          color: MW.text, background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 4,
          whiteSpace: "nowrap",
        }}>
          <span style={{ color: MW.muted, fontSize: 10 }}>ET</span>
          {clockTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "America/New_York" })}
        </div>

        <div style={{ width: 1, height: 20, background: MW.border }} />

        {/* Nav links */}


        <Link href="/journal">
          <button className="flex items-center gap-1.5 px-2.5 h-7 rounded text-xs"
            style={{ background: MW.panel, border: `1px solid ${MW.border}`, color: MW.muted, cursor: "pointer" }}>
            <BookOpen className="w-3.5 h-3.5" />Journal
          </button>
        </Link>

        {/* Favorites button */}
        <button
          title="Favorites"
          onClick={() => { setShowFavorites(v => !v); setShowSettings(false); }}
          style={{
            width: 28, height: 28, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
            background: showFavorites ? "#f59e0b33" : favoriteSymbols.length > 0 ? "#f59e0b11" : "transparent",
            border: `1px solid ${showFavorites ? "#f59e0b" : favoriteSymbols.length > 0 ? "#f59e0b55" : MW.border}`,
            color: showFavorites ? "#f59e0b" : favoriteSymbols.length > 0 ? "#f59e0baa" : MW.muted, cursor: "pointer",
            fontSize: 14, lineHeight: 1,
          }}
        >★</button>
        <button
          title="Settings"
          onClick={() => setShowSettings(v => !v)}
          style={{
            width: 28, height: 28, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
            background: showSettings ? MW.accent + "33" : "transparent",
            border: `1px solid ${showSettings ? MW.accent : MW.border}`,
            color: showSettings ? MW.accent : MW.muted, cursor: "pointer",
          }}
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </header>

      {/* ── Main area ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 relative">

        {/* ── Signals panel overlay ───────────────────────────────────── */}
        {showSignalsPanel && (
          <div
            className="absolute right-0 top-0 bottom-0 z-50 flex flex-col mg-fade-in"
            style={{ width: "min(760px, 88vw)", background: MW.bg, borderLeft: `1px solid ${MW.border}`, boxShadow: "-12px 0 40px -12px rgba(0,0,0,0.6), -1px 0 0 0 rgba(47,155,255,0.18)" }}
          >
            <SignalsPanel
              defaultSymbol={selectedSymbol}
              defaultInterval={interval}
              defaultRiskLevel="all"
              externalSignals={allConfluenceSignals as ExternalSignal[]}
              milkZones={activeZones}
              allCandles={candleData?.candles}
              footprintAlerts={footprintAlerts}
              frozenImbalances={frozenImbalanceZones}
              onClose={() => setShowSignalsPanel(false)}
              onViewOnChart={() => { /* handled inside panel as popup */ }}
              onRefreshSignals={handleRefreshSignals}
            />
          </div>
        )}

        {/* ── Favorites panel ─────────────────────────────────────────── */}
        {showFavorites && (
          <div className="absolute right-0 top-0 bottom-0 z-40 flex flex-col overflow-y-auto"
            style={{ width: 280, background: MW.panel, borderLeft: `1px solid ${MW.border}`, boxShadow: "-4px 0 20px rgba(0,0,0,0.4)" }}>
            <div className="flex items-center justify-between px-3 py-2 flex-shrink-0" style={{ borderBottom: `1px solid ${MW.border}` }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#f59e0b" }}>★ Favorites</span>
              <button onClick={() => setShowFavorites(false)} style={{ color: MW.muted, cursor: "pointer", background: "transparent", border: "none" }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Favorite Symbols */}
            <div className="px-3 py-2" style={{ borderBottom: `1px solid ${MW.border}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Symbols</div>
              {favoriteSymbols.length === 0 ? (
                <div style={{ fontSize: 11, color: MW.muted, padding: "4px 0" }}>
                  No favorites yet. Click ☆ next to any symbol in the dropdown.
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {allSymbols.filter(s => favoriteSymbols.includes(s.symbol)).map(s => (
                    <div key={s.symbol} className="flex items-center gap-2 rounded px-2 py-1"
                      style={{ background: s.symbol === selectedSymbol ? MW.accent + "22" : MW.bg, border: `1px solid ${s.symbol === selectedSymbol ? MW.accent + "55" : "transparent"}` }}>
                      <button onClick={() => { setSelectedSymbol(s.symbol); setShowFavorites(false); }}
                        className="flex-1 text-left"
                        style={{ background: "none", border: "none", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: s.symbol === selectedSymbol ? MW.accent : MW.text }}>{s.symbol}</span>
                        <span style={{ fontSize: 10, color: MW.muted }}>{s.name}</span>
                      </button>
                      <button onClick={() => toggleFavSymbol(s.symbol)} title="Remove from favorites"
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#f59e0b", fontSize: 13, padding: 0, lineHeight: 1, flexShrink: 0 }}>★</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Saved Views */}
            <div className="px-3 py-2">
              <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Saved Views</div>
              <div className="flex gap-1 mb-3">
                <input
                  value={viewNameInput}
                  onChange={e => setViewNameInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveCurrentView(viewNameInput)}
                  placeholder="Name this view…"
                  style={{
                    flex: 1, height: 26, borderRadius: 4, border: `1px solid ${MW.border}`,
                    background: MW.bg, color: MW.text, fontSize: 11, padding: "0 8px",
                    outline: "none",
                  }}
                />
                <button onClick={() => saveCurrentView(viewNameInput)}
                  title="Save current chart config as a view"
                  style={{
                    height: 26, padding: "0 8px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                    background: "#f59e0b22", border: `1px solid #f59e0b66`, color: "#f59e0b", fontWeight: 700, flexShrink: 0,
                  }}>Save</button>
              </div>
              {savedViews.length === 0 ? (
                <div style={{ fontSize: 11, color: MW.muted }}>No saved views yet.</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {savedViews.map(v => (
                    <div key={v.name} className="flex items-center gap-1 rounded px-2 py-1.5"
                      style={{ background: MW.bg, border: `1px solid ${MW.border}` }}>
                      <button onClick={() => { applyView(v); setShowFavorites(false); }}
                        className="flex-1 text-left" style={{ background: "none", border: "none", cursor: "pointer" }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: MW.text }}>{v.name}</div>
                        <div style={{ fontSize: 10, color: MW.muted, marginTop: 2 }}>
                          {v.interval} · {[v.showVector && "Vec", v.showMlZones && "Zones"].filter(Boolean).join(" · ") || "No overlays"} · {v.chartRiskLevel} · {v.showETH ? "ETH+RTH" : "RTH"}{v.themeKey ? ` · ${v.themeKey}` : ""}
                        </div>
                      </button>
                      <button onClick={() => deleteView(v.name)} title="Delete view"
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#ef535088", fontSize: 13, padding: 0, lineHeight: 1, flexShrink: 0 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Settings panel ──────────────────────────────────────────── */}
        {showSettings && (
          <div
            className="absolute right-0 top-0 bottom-0 z-40 flex flex-col overflow-y-auto"
            style={{ width: 260, background: MW.panel, borderLeft: `1px solid ${MW.border}`, boxShadow: "-4px 0 20px rgba(0,0,0,0.4)" }}
          >
            <div className="flex items-center justify-between px-3 py-2 flex-shrink-0" style={{ borderBottom: `1px solid ${MW.border}` }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: MW.text }}>Chart Settings</span>
              <button onClick={() => setShowSettings(false)} style={{ color: MW.muted, cursor: "pointer", background: "transparent", border: "none" }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Display toggles */}
            <div className="px-3 py-3" style={{ borderBottom: `1px solid ${MW.border}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Display</div>
              <div className="flex flex-col gap-2">
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: MW.text, cursor: "pointer" }}>
                  Signal Labels
                  <button onClick={() => setShowLabels(v => !v)} style={{
                    width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer",
                    background: showLabels ? "#26c87a" : "#2a3a4a", position: "relative", transition: "background 0.2s",
                  }}>
                    <span style={{ position: "absolute", top: 2, left: showLabels ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </button>
                </label>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: MW.text, cursor: "pointer" }}>
                  Auto-Scale
                  <button onClick={() => { const n = !autoScale; setAutoScale(n); chartRef.current?.setAutoScale(n); }} style={{
                    width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer",
                    background: autoScale ? "#1a72d4" : "#2a3a4a", position: "relative", transition: "background 0.2s",
                  }}>
                    <span style={{ position: "absolute", top: 2, left: autoScale ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </button>
                </label>
              </div>
            </div>

            {/* Exit Strategy */}
            <div className="px-3 py-3" style={{ borderBottom: `1px solid ${MW.border}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Exit Strategy</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                {(["safe", "risky", "riskiest"] as const).map(tier => {
                  const p = EXIT_STRATEGY_PROFILES[tier];
                  const active = exitStrategy === tier;
                  const col = tier === "safe" ? "#26c87a" : tier === "risky" ? "#f59e0b" : "#ef4444";
                  return (
                    <button
                      key={tier}
                      onClick={() => setExitStrategy(tier)}
                      style={{
                        flex: 1, padding: "7px 4px", borderRadius: 5, cursor: "pointer", textAlign: "center",
                        background: active ? col + "1a" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${active ? col : MW.border}`,
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 700, color: active ? col : MW.text, marginBottom: 3 }}>{p.label}</div>
                      <div style={{ fontSize: 9, color: MW.muted }}>SAFE SL {p.rth.safe.sl} · SAFE+ TP2 {p.rth.safeplus.tp2}</div>
                    </button>
                  );
                })}
              </div>

              {/* Trailer toggle — simple inline switch */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderRadius: 5, background: useTrailer ? "#06b6d40d" : "rgba(255,255,255,0.02)", border: `1px solid ${useTrailer ? "#06b6d440" : MW.border}` }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: useTrailer ? "#06b6d4" : MW.text }}>Trailer Stop</div>
                  {useTrailer
                    ? <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 2 }}>⚠ Fixed TPs disabled — trails {trailerOffset} pts after TP1</div>
                    : <div style={{ fontSize: 9, color: MW.muted, marginTop: 2 }}>Standard bracket — TP1 + TP2 fixed exits</div>
                  }
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {useTrailer && (
                    <input
                      type="number"
                      min={0.25}
                      step={0.25}
                      value={trailerOffset}
                      onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setTrailerOffset(v); }}
                      style={{ width: 48, padding: "2px 5px", borderRadius: 4, fontSize: 11, textAlign: "right", background: "#0f1923", color: "#06b6d4", border: "1px solid #06b6d488", outline: "none" }}
                    />
                  )}
                  <button
                    onClick={() => setUseTrailer(v => !v)}
                    style={{ width: 38, height: 22, borderRadius: 11, border: "none", cursor: "pointer", background: useTrailer ? "#06b6d4" : "#2a3a4a", position: "relative", flexShrink: 0, transition: "background 0.2s" }}
                  >
                    <span style={{ position: "absolute", top: 3, left: useTrailer ? 18 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </button>
                </div>
              </div>

              {/* Zone Targets toggle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", marginTop: 6, borderRadius: 5, background: useZoneTargets ? "#a855f70d" : "rgba(255,255,255,0.02)", border: `1px solid ${useZoneTargets ? "#a855f740" : MW.border}` }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: useZoneTargets ? "#a855f7" : MW.text }}>Zone Targets</div>
                  <div style={{ fontSize: 9, color: MW.muted, marginTop: 2 }}>
                    {useZoneTargets ? "TP/SL snap to nearest zones above/below entry" : "TP/SL at next zone boundary — bounces zone-to-zone"}
                  </div>
                </div>
                <button
                  onClick={() => setUseZoneTargets(v => !v)}
                  style={{ width: 38, height: 22, borderRadius: 11, border: "none", cursor: "pointer", background: useZoneTargets ? "#a855f7" : "#2a3a4a", position: "relative", flexShrink: 0, transition: "background 0.2s" }}
                >
                  <span style={{ position: "absolute", top: 3, left: useZoneTargets ? 18 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </button>
              </div>

              {/* Take every side entry as a Long (vector exit) toggle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", marginTop: 6, borderRadius: 5, background: takeSideEntries ? "#26a69a12" : "rgba(255,255,255,0.02)", border: `1px solid ${takeSideEntries ? "#26a69a55" : MW.border}` }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: takeSideEntries ? "#26a69a" : MW.text }}>Side-Entry Longs</div>
                  <div style={{ fontSize: 9, color: MW.muted, marginTop: 2 }}>
                    {takeSideEntries
                      ? "Every vector side entry fires a Long (vector exit: stop −3.5, TP +7.5/+26) · auto-trade eligible"
                      : "Take every vector side entry as a Long with the vector's exit strategy"}
                  </div>
                </div>
                <button
                  onClick={() => setTakeSideEntries(v => !v)}
                  style={{ width: 38, height: 22, borderRadius: 11, border: "none", cursor: "pointer", background: takeSideEntries ? "#26a69a" : "#2a3a4a", position: "relative", flexShrink: 0, transition: "background 0.2s" }}
                >
                  <span style={{ position: "absolute", top: 3, left: takeSideEntries ? 18 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </button>
              </div>
            </div>

            {/* Theme selector */}
            <div className="px-3 py-3" style={{ borderBottom: `1px solid ${MW.border}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Theme</div>
              <div className="flex flex-col gap-1.5">
                {Object.entries(CHART_THEMES).map(([key, th]) => (
                  <button
                    key={key}
                    onClick={() => setThemeKey(key)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: 4,
                      background: themeKey === key ? MW.accent + "22" : "transparent",
                      border: `1px solid ${themeKey === key ? MW.accent : MW.border}`,
                      color: themeKey === key ? MW.accent : MW.text, cursor: "pointer", fontSize: 12, textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", gap: 3 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: th.up, display: "inline-block" }} />
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: th.down, display: "inline-block" }} />
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: th.bg, border: `1px solid ${MW.border}`, display: "inline-block" }} />
                    </span>
                    {th.name}
                  </button>
                ))}
                {Object.entries(favoriteThemes).map(([key, th]) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button
                      onClick={() => { setThemeKey("custom"); setCustomTheme(th); }}
                      style={{
                        flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: 4,
                        background: themeKey === "custom" && JSON.stringify(currentTheme) === JSON.stringify(th) ? MW.accent + "22" : "transparent",
                        border: `1px solid ${themeKey === "custom" && JSON.stringify(currentTheme) === JSON.stringify(th) ? MW.accent : MW.border}`,
                        color: themeKey === "custom" && JSON.stringify(currentTheme) === JSON.stringify(th) ? MW.accent : MW.text,
                        cursor: "pointer", fontSize: 12, textAlign: "left",
                      }}
                    >
                      <span style={{ display: "flex", gap: 3 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: th.up, display: "inline-block" }} />
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: th.down, display: "inline-block" }} />
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: th.bg, border: `1px solid ${MW.border}`, display: "inline-block" }} />
                      </span>
                      ★ {th.name}
                    </button>
                    <button
                      onClick={() => {
                        const updated = { ...favoriteThemes };
                        delete updated[key];
                        setFavoriteThemes(updated);
                        localStorage.setItem("fav_themes", JSON.stringify(updated));
                      }}
                      style={{ padding: "4px 6px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "transparent", border: `1px solid ${MW.border}`, color: "#ef5350", flexShrink: 0 }}
                      title="Remove favorite"
                    >✕</button>
                  </div>
                ))}
              </div>
            </div>

            {/* Discord Alerts */}
            <div className="px-3 py-3" style={{ borderBottom: `1px solid ${MW.border}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                Discord Alerts
              </div>
              <div style={{ fontSize: 11, color: MW.muted, marginBottom: 8, lineHeight: 1.5 }}>
                Paste a Discord Webhook URL to receive signal alerts in your Discord channel.
                <div style={{ marginTop: 4, color: "#67e8f9", fontSize: 10 }}>
                  Discord → Server Settings → Integrations → Webhooks → New Webhook → Copy URL
                </div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <input
                  type="text"
                  placeholder="https://discord.com/api/webhooks/…"
                  value={discordWebhookInput}
                  onChange={e => setDiscordWebhookInput(e.target.value)}
                  style={{
                    width: "100%", padding: "6px 8px", borderRadius: 4, fontSize: 11,
                    background: "#0d1420", border: `1px solid ${MW.border}`, color: MW.text,
                    boxSizing: "border-box", outline: "none", fontFamily: "'Trebuchet MS', monospace",
                  }}
                />
              </div>
              {discordError && (
                <div style={{ fontSize: 11, color: "#ef5350", background: "rgba(239,83,80,0.08)", border: "1px solid rgba(239,83,80,0.25)", borderRadius: 4, padding: "6px 9px", marginBottom: 6, lineHeight: 1.4 }}>
                  {discordError}
                </div>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={async () => {
                    setDiscordSaveState("saving"); setDiscordError("");
                    try {
                      const r = await fetch("/api/discord/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ webhook: discordWebhookInput }),
                      });
                      const d = await r.json();
                      if (!r.ok) { setDiscordError(d.error); setDiscordSaveState("error"); return; }
                      setDiscordWebhook(d.webhook);
                      localStorage.setItem("discord_webhook", discordWebhookInput);
                      setDiscordSaveState("saved");
                      setTimeout(() => setDiscordSaveState("idle"), 2000);
                    } catch { setDiscordError("Network error"); setDiscordSaveState("error"); }
                  }}
                  style={{
                    flex: 1, padding: "5px 0", borderRadius: 4, fontSize: 11, cursor: "pointer",
                    fontFamily: "'Trebuchet MS', monospace", fontWeight: 600,
                    background: discordSaveState === "saved" ? "rgba(38,200,122,0.15)" : "rgba(66,165,245,0.1)",
                    border: `1px solid ${discordSaveState === "saved" ? "#26c87a" : discordSaveState === "error" ? "#ef5350" : MW.accent}`,
                    color: discordSaveState === "saved" ? "#26c87a" : discordSaveState === "error" ? "#ef5350" : MW.accent,
                  }}
                >
                  {discordSaveState === "saving" ? "Saving…" : discordSaveState === "saved" ? "✓ Saved" : "Save"}
                </button>
                {discordWebhookInput && (
                  <button
                    onClick={async () => {
                      setDiscordTestState("sending"); setDiscordError("");
                      try {
                        const r = await fetch("/api/discord/test", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ webhook: discordWebhookInput }),
                        });
                        const d = await r.json();
                        if (!r.ok) { setDiscordError(d.error ?? "Send failed"); setDiscordTestState("error"); return; }
                        setDiscordTestState("sent");
                        setTimeout(() => setDiscordTestState("idle"), 4000);
                      } catch { setDiscordError("Network error"); setDiscordTestState("error"); }
                    }}
                    style={{
                      flex: 1, padding: "5px 0", borderRadius: 4, fontSize: 11, cursor: "pointer",
                      fontFamily: "'Trebuchet MS', monospace", fontWeight: 600,
                      background: discordTestState === "sent" ? "rgba(38,200,122,0.15)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${discordTestState === "sent" ? "#26c87a" : discordTestState === "error" ? "#ef5350" : MW.border}`,
                      color: discordTestState === "sent" ? "#26c87a" : discordTestState === "error" ? "#ef5350" : MW.muted,
                    }}
                  >
                    {discordTestState === "sending" ? "Sending…" : discordTestState === "sent" ? "✓ Sent!" : "Test"}
                  </button>
                )}
                {discordWebhook && (
                  <button
                    onClick={async () => {
                      await fetch("/api/discord/settings", { method: "DELETE" });
                      localStorage.removeItem("discord_webhook");
                      setDiscordWebhook(""); setDiscordWebhookInput(""); setDiscordError("");
                    }}
                    style={{
                      padding: "5px 8px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                      background: "transparent", border: `1px solid ${MW.border}`, color: "#ef5350",
                    }}
                    title="Remove webhook"
                  >✕</button>
                )}
              </div>
              {discordWebhook && (
                <div style={{ marginTop: 6, fontSize: 10, color: "#26c87a" }}>✓ Alerts will post to your Discord channel</div>
              )}
            </div>

            {/* Auto Trade */}
            <div className="px-3 py-3" style={{ borderBottom: `1px solid ${MW.border}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                Auto Trade
              </div>

              {/* Java study connection status */}
              <div style={{ fontSize: 11, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: autoTradeConnected ? "#26c87a" : "#ef5350", display: "inline-block", flexShrink: 0 }} />
                {autoTradeConnected
                  ? <span style={{ color: "#26c87a" }}>AutoTrader connected</span>
                  : <span style={{ color: MW.muted }}>AutoTrader not connected — add study to chart in MotiveWave</span>
                }
              </div>

              {/* Reset trade lock — always visible so user can unstick stuck flag */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 10, color: MW.muted }}>Stuck? Clear trade lock</span>
                <button
                  onClick={() => {
                    if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
                    fetch("/api/trade/reset-flag", { method: "POST" })
                      .then(async r => {
                        const text = await r.text();
                        try {
                          const d = JSON.parse(text);
                          setAutoTradeToast({ ok: !!d.ok, msg: d.ok ? "Trade lock reset — ready for new orders" : `Not connected — lock will clear on next MotiveWave connect`, direction: "Long", price: 0 });
                        } catch {
                          // Server returned non-JSON (404 before server restart, etc.)
                          setAutoTradeToast({ ok: false, msg: `Server error ${r.status} — restart the app server`, direction: "Long", price: 0 });
                        }
                        autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 6000);
                      })
                      .catch(e => {
                        setAutoTradeToast({ ok: false, msg: `Network error: ${e.message}`, direction: "Long", price: 0 });
                        autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 6000);
                      });
                  }}
                  style={{
                    padding: "3px 10px", borderRadius: 4, fontSize: 10, cursor: "pointer",
                    fontFamily: "'Trebuchet MS', monospace",
                    background: "rgba(255,255,255,0.03)",
                    border: `1px solid ${MW.border}`,
                    color: MW.muted,
                  }}
                >Reset Lock</button>
              </div>

              {/* Master toggle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: autoTradeEnabled ? "#ef5350" : MW.muted, fontWeight: autoTradeEnabled ? 700 : 400 }}>
                  {autoTradeEnabled ? "AUTO TRADE ON — ORDERS WILL BE PLACED" : "Auto trade disabled"}
                </span>
                <button
                  onClick={() => {
                    const next = !autoTradeEnabled;
                    setAutoTradeEnabled(next);
                    // Sync to server so iPhone mirrors state via auto_trade_state WS push
                    fetch("/api/trade/settings", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ enabled: next }),
                    }).catch(() => {});
                  }}
                  style={{
                    padding: "4px 12px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                    fontFamily: "'Trebuchet MS', monospace", fontWeight: 700,
                    background: autoTradeEnabled ? "rgba(239,83,80,0.15)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${autoTradeEnabled ? "#ef5350" : MW.border}`,
                    color: autoTradeEnabled ? "#ef5350" : MW.muted,
                  }}
                >{autoTradeEnabled ? "Disable" : "Enable"}</button>
              </div>

              {autoTradeEnabled && (
                <div style={{ fontSize: 11, color: "#f59e0b", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 4, padding: "7px 10px", marginBottom: 10, lineHeight: 1.5 }}>
                  ⚠ Real orders will be placed through MotiveWave when signals fire.<br />
                  Make sure MotiveWave is in <strong>sim mode</strong> until you are ready to trade live.
                </div>
              )}

              {/* Contract type */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: MW.muted, marginBottom: 6 }}>Contract type</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["MES", "ES"] as const).map(type => (
                    <button
                      key={type}
                      onClick={() => setAutoTradeContractType(type)}
                      style={{
                        flex: 1, padding: "5px 0", borderRadius: 4, fontSize: 11, cursor: "pointer",
                        fontFamily: "'Trebuchet MS', monospace", fontWeight: 600,
                        background: autoTradeContractType === type ? "rgba(66,165,245,0.15)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${autoTradeContractType === type ? MW.accent : MW.border}`,
                        color: autoTradeContractType === type ? MW.accent : MW.muted,
                      }}
                    >{type === "MES" ? "MES  Micro" : "ES  Full"}</button>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: MW.muted, marginTop: 4 }}>
                  {autoTradeContractType === "MES" ? "Micro E-mini — $5/pt per contract" : "E-mini — $50/pt per contract"}
                </div>
              </div>

              {/* Contract size */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: MW.muted, marginBottom: 4 }}>Contracts per trade</div>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={autoTradeContracts}
                  onChange={e => setAutoTradeContracts(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                  style={{
                    width: 70, padding: "5px 8px", borderRadius: 4, fontSize: 12,
                    background: "#0d1420", border: `1px solid ${MW.border}`, color: MW.text,
                    outline: "none", fontFamily: "'Trebuchet MS', monospace",
                  }}
                />
              </div>

              {/* Exit mode — TP1 only vs TP1 + TP2 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: MW.muted, marginBottom: 6 }}>Exit mode</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {([false, true] as const).map(tp1Only => (
                    <button
                      key={String(tp1Only)}
                      onClick={() => setAutoTradeTp1Only(tp1Only)}
                      style={{
                        flex: 1, padding: "5px 0", borderRadius: 4, fontSize: 11, cursor: "pointer",
                        fontFamily: "'Trebuchet MS', monospace", fontWeight: 600,
                        background: autoTradeTp1Only === tp1Only ? "rgba(66,165,245,0.15)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${autoTradeTp1Only === tp1Only ? MW.accent : MW.border}`,
                        color: autoTradeTp1Only === tp1Only ? MW.accent : MW.muted,
                      }}
                    >{tp1Only ? "TP1 only" : "TP1 + TP2"}</button>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: MW.muted, marginTop: 4 }}>
                  {autoTradeTp1Only
                    ? "All contracts exit at TP1"
                    : "Half at TP1, rest at TP2"}
                </div>
              </div>

              {/* Scale-In Mode */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: MW.muted, marginBottom: 6 }}>Scale-in mode</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {([false, true] as const).map(si => (
                    <button
                      key={String(si)}
                      onClick={() => { setScaleInMode(si); localStorage.setItem("autoTrade_scaleIn", JSON.stringify(si)); }} // FIX: persist scale-in preference
                      style={{
                        flex: 1, padding: "5px 0", borderRadius: 4, fontSize: 11, cursor: "pointer",
                        fontFamily: "'Trebuchet MS', monospace", fontWeight: 600,
                        background: scaleInMode === si ? "rgba(66,165,245,0.15)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${scaleInMode === si ? MW.accent : MW.border}`,
                        color: scaleInMode === si ? MW.accent : MW.muted,
                      }}
                    >{si ? "Scale in" : "Full size"}</button>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: MW.muted, marginTop: 4 }}>
                  {scaleInMode
                    ? "50% at signal + 50% on pullback within 2pts of TP1"
                    : "Full contracts at signal"}
                </div>
              </div>

              {/* Direction filter */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: MW.muted, marginBottom: 6 }}>Direction</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["both", "long", "short"] as const).map(d => (
                    <button
                      key={d}
                      onClick={() => setAutoTradeDirection(d)}
                      style={{
                        flex: 1, padding: "5px 0", borderRadius: 4, fontSize: 11, cursor: "pointer",
                        fontFamily: "'Trebuchet MS', monospace", fontWeight: 600,
                        background: autoTradeDirection === d
                          ? d === "long"  ? "rgba(34,197,94,0.15)"
                          : d === "short" ? "rgba(239,68,68,0.15)"
                          :                 "rgba(66,165,245,0.15)"
                          : "rgba(255,255,255,0.03)",
                        border: `1px solid ${autoTradeDirection === d
                          ? d === "long"  ? "#26c87a"
                          : d === "short" ? "#ef5350"
                          :                 MW.accent
                          : MW.border}`,
                        color: autoTradeDirection === d
                          ? d === "long"  ? "#26c87a"
                          : d === "short" ? "#ef5350"
                          :                 MW.accent
                          : MW.muted,
                      }}
                    >{d === "both" ? "Both" : d === "long" ? "▲ Long" : "▼ Short"}</button>
                  ))}
                </div>
              </div>

              {/* Risk level filter */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: MW.muted, marginBottom: 6 }}>Trade on risk levels</div>
                {(["safeplus", "safe", "risky", "riskiest"] as const).map(level => (
                  <label key={level} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={autoTradeRiskLevels.has(level)}
                      onChange={e => {
                        setAutoTradeRiskLevels(prev => {
                          const next = new Set(prev);
                          e.target.checked ? next.add(level) : next.delete(level);
                          return next;
                        });
                      }}
                      style={{ accentColor: MW.accent }}
                    />
                    <span style={{ fontSize: 11, color: level === "safeplus" ? "#a78bfa" : level === "safe" ? "#26c87a" : level === "risky" ? "#f59e0b" : "#ef5350", textTransform: "capitalize" }}>{level === "safeplus" ? "SAFE+" : level}</span>
                  </label>
                ))}
              </div>

              {/* Interval filter */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: MW.muted, marginBottom: 6 }}>Trade on intervals</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["1m", "5m", "15m", "60m"] as const).map(iv => (
                    <label key={iv} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={autoTradeIntervals.has(iv)}
                        onChange={e => {
                          setAutoTradeIntervals(prev => {
                            const next = new Set(prev);
                            e.target.checked ? next.add(iv) : next.delete(iv);
                            return next;
                          });
                        }}
                        style={{ accentColor: MW.accent }}
                      />
                      <span style={{ fontSize: 11, color: MW.text }}>{iv}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Test order button */}
              <div>
                <div style={{ fontSize: 10, color: MW.muted, marginBottom: 6 }}>Connection test — sends a dummy Long order to MotiveWave</div>
                <button
                  onClick={() => {
                    const showToast = (ok: boolean, msg: string) => {
                      if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current);
                      setAutoTradeToast({ ok, msg, direction: "Long", price: 0 });
                      autoTradeToastTimer.current = setTimeout(() => setAutoTradeToast(null), 8000);
                    };
                    const currentPrice = lastLivePriceRef.current > 0
                      ? lastLivePriceRef.current
                      : (windowedCandles.at(-1)?.close ?? 6900);
                    fetch("/api/trade/execute", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        symbol: autoTradeContractType,
                        direction: "Long",
                        interval: "test",
                        riskLevel: "safe",
                        price: currentPrice,
                        tp1: currentPrice + 10,
                        tp2: currentPrice + 20,
                        sl:  currentPrice - 10,
                        contracts: autoTradeContracts,
                        tp1Only: autoTradeTp1Only,
                      }),
                    }).then(async r => {
                      if (r.ok) showToast(true, "Test order sent — check MotiveWave order manager");
                      else { const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` })); showToast(false, d.error ?? `HTTP ${r.status}`); }
                    }).catch(e => showToast(false, `Network error: ${e.message}`));
                  }}
                  style={{
                    padding: "5px 14px", borderRadius: 4, fontSize: 11,
                    cursor: "pointer", fontFamily: "'Trebuchet MS', monospace",
                    background: "rgba(26,114,212,0.1)",
                    border: `1px solid ${MW.accent}`,
                    color: MW.accent,
                  }}
                >Send Test Order</button>
              </div>
            </div>

            {/* Custom colors */}
            <div className="px-3 py-3">
              <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Custom Colors</div>
              {[
                { label: "Up candle",    field: "up"         as keyof ChartTheme },
                { label: "Down candle",  field: "down"       as keyof ChartTheme },
                { label: "Background",   field: "bg"         as keyof ChartTheme },
                { label: "Vector line",  field: "vectorLine" as keyof ChartTheme },
                { label: "Above-vec up", field: "vecAboveUp" as keyof ChartTheme },
                { label: "Above-vec dn", field: "vecAboveDown" as keyof ChartTheme },
              ].map(({ label, field }) => (
                <div key={field} className="flex items-center justify-between mb-2">
                  <span style={{ fontSize: 11, color: MW.muted }}>{label}</span>
                  <input
                    type="color"
                    value={(currentTheme[field] as string).slice(0, 7)}
                    onChange={e => {
                      setThemeKey("custom");
                      setCustomTheme(prev => ({ ...currentTheme, ...prev, [field]: e.target.value }));
                    }}
                    style={{ width: 32, height: 22, cursor: "pointer", border: `1px solid ${MW.border}`, borderRadius: 3, background: "transparent", padding: 1 }}
                  />
                </div>
              ))}
              <button
                onClick={() => { setThemeKey("motivewave"); setCustomTheme(CHART_THEMES.motivewave); }}
                style={{ marginTop: 4, fontSize: 11, color: MW.muted, background: "transparent", border: `1px solid ${MW.border}`, borderRadius: 3, padding: "3px 10px", cursor: "pointer" }}
              >
                Reset to MotiveWave
              </button>
              <div style={{ marginTop: 10, borderTop: `1px solid ${MW.border}`, paddingTop: 10 }}>

                <div style={{ fontSize: 10, color: MW.muted, marginBottom: 4 }}>Save current colors as favorite</div>
                <div style={{ display: "flex", gap: 4 }}>
                  <input
                    type="text"
                    placeholder="Name…"
                    value={favThemeNameInput}
                    onChange={e => setFavThemeNameInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && favThemeNameInput.trim()) {
                        const key = favThemeNameInput.trim().toLowerCase().replace(/\s+/g, "_") + "_" + Date.now();
                        const updated = { ...favoriteThemes, [key]: { ...currentTheme, name: favThemeNameInput.trim() } };
                        setFavoriteThemes(updated);
                        localStorage.setItem("fav_themes", JSON.stringify(updated));
                        setFavThemeNameInput("");
                      }
                    }}
                    style={{
                      flex: 1, padding: "4px 7px", borderRadius: 3, fontSize: 11,
                      background: "#0d1420", border: `1px solid ${MW.border}`, color: MW.text,
                      outline: "none", fontFamily: "'Trebuchet MS', monospace",
                    }}
                  />
                  <button
                    disabled={!favThemeNameInput.trim()}
                    onClick={() => {
                      if (!favThemeNameInput.trim()) return;
                      const key = favThemeNameInput.trim().toLowerCase().replace(/\s+/g, "_") + "_" + Date.now();
                      const updated = { ...favoriteThemes, [key]: { ...currentTheme, name: favThemeNameInput.trim() } };
                      setFavoriteThemes(updated);
                      localStorage.setItem("fav_themes", JSON.stringify(updated));
                      setFavThemeNameInput("");
                    }}
                    style={{
                      padding: "4px 8px", borderRadius: 3, fontSize: 11, cursor: favThemeNameInput.trim() ? "pointer" : "default",
                      background: favThemeNameInput.trim() ? MW.accent + "22" : "transparent",
                      border: `1px solid ${favThemeNameInput.trim() ? MW.accent : MW.border}`,
                      color: favThemeNameInput.trim() ? MW.accent : MW.muted, flexShrink: 0,
                    }}
                  >★ Save</button>
                </div>
              </div>
            </div>

            {/* Navigation */}
            <div className="px-3 py-3" style={{ borderTop: `1px solid ${MW.border}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Navigation</div>
              <Link href="/data" onClick={() => setShowSettings(false)}>
                <button className="flex items-center gap-2 w-full px-3 h-8 rounded text-xs"
                  style={{ background: "transparent", border: `1px solid ${MW.border}`, color: MW.muted, cursor: "pointer", justifyContent: "flex-start" }}>
                  <Database className="w-3.5 h-3.5" />Data Download
                </button>
              </Link>
            </div>
          </div>
        )}

        {/* ── Left drawing toolbar ────────────────────────────────────── */}
        <aside
          className="flex flex-col items-center py-2 gap-0.5 flex-shrink-0"
          style={{ width: 42, background: MW.toolbar, borderRight: `1px solid ${MW.border}` }}
        >
          {/* Cursor tool — drag to pan, Ctrl+drag to zoom, right-click for signal details */}
          <button
            title="Select (drag=pan · Ctrl+drag=zoom · right-click=signal info)"
            onClick={() => setActiveTool("cursor")}
            style={{
              width: 32, height: 32, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
              background: activeTool === "cursor" ? MW.accent + "33" : "transparent",
              border: `1px solid ${activeTool === "cursor" ? MW.accent : "transparent"}`,
              color: activeTool === "cursor" ? MW.accent : MW.muted,
              cursor: "pointer",
            }}
          >
            <MousePointer2 className="w-4 h-4" />
          </button>

          {/* Rest of drawing tools */}
          {DRAWING_TOOLS.slice(1).map(tool => {
            const Icon = tool.icon;
            const active = activeTool === tool.id;
            return (
              <button
                key={tool.id}
                title={tool.label}
                onClick={() => setActiveTool(active ? "cursor" : tool.id)}
                style={{
                  width: 32, height: 32, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
                  background: active ? MW.accent + "33" : "transparent",
                  border: `1px solid ${active ? MW.accent : "transparent"}`,
                  color: active ? MW.accent : MW.muted,
                  cursor: "pointer",
                }}
              >
                <Icon className="w-4 h-4" />
              </button>
            );
          })}

          {/* Divider */}
          <div style={{ width: 26, height: 1, background: MW.border, margin: "4px 0" }} />

          {/* Reset zoom / Fit all */}
          <button
            title="Fit all data (right-click chart for more options)"
            onClick={() => chartRef.current?.resetZoom()}
            style={{ width:32, height:32, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center",
              background:"transparent", border:`1px solid transparent`, color: MW.muted, cursor:"pointer" }}
          >
            <Maximize2 className="w-4 h-4" />
          </button>

          {/* Download candle + signal data as CSV */}
          <button
            title="Download candle and signal data as CSV"
            onClick={() => {
              if (!windowedCandles.length) return;
              // Build candle CSV
              const candleHeader = "time_utc,time_et,open,high,low,close,volume,rth";
              const candleRows = windowedCandles.map(c => {
                const etStr = new Date(c.time * 1000).toLocaleString("en-US", {
                  timeZone: "America/New_York", year: "numeric", month: "2-digit",
                  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
                });
                return `${c.time},${etStr},${c.open},${c.high},${c.low},${c.close},${c.volume ?? 0},${c.rth ?? ""}`;
              });
              const candleCsv = [candleHeader, ...candleRows].join("\n");

              // Build signal CSV
              const sigHeader = "time_utc,time_et,direction,risk_level,signal_type,entry,tp1,tp2,sl,outcome";
              const sigRows = allConfluenceSignals.map(s => {
                const etStr = new Date(s.time * 1000).toLocaleString("en-US", {
                  timeZone: "America/New_York", year: "numeric", month: "2-digit",
                  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
                });
                return `${s.time},${etStr},${s.direction},${s.riskLevel},${s.price},${s.tp1},${s.tp2},${s.sl},${s.outcome ?? "open"}`;
              });
              const sigCsv = [sigHeader, ...sigRows].join("\n");

              // Download candles
              const candleBlob = new Blob([candleCsv], { type: "text/csv" });
              const candleUrl = URL.createObjectURL(candleBlob);
              const candleA = document.createElement("a");
              candleA.href = candleUrl;
              candleA.download = `${selectedSymbol}_${interval}_candles.csv`;
              candleA.click();
              URL.revokeObjectURL(candleUrl);

              // Download signals
              if (allConfluenceSignals.length) {
                const sigBlob = new Blob([sigCsv], { type: "text/csv" });
                const sigUrl = URL.createObjectURL(sigBlob);
                const sigA = document.createElement("a");
                sigA.href = sigUrl;
                sigA.download = `${selectedSymbol}_${interval}_signals.csv`;
                sigA.click();
                URL.revokeObjectURL(sigUrl);
              }
            }}
            style={{ width:32, height:32, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center",
              background:"transparent", border:`1px solid transparent`, color: windowedCandles.length ? MW.muted : MW.border,
              cursor: windowedCandles.length ? "pointer" : "default", fontSize: 14, lineHeight: 1 }}
          >
            ↓
          </button>

          {/* Refresh — refetch candle data + pull latest live price */}
          <button
            title="Refresh chart data and sync current market price"
            onClick={handleRefresh}
            disabled={refreshing}
            style={{ width:32, height:32, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center",
              background:"transparent", border:`1px solid transparent`, color: refreshing ? MW.accent : MW.muted,
              cursor: refreshing ? "default" : "pointer" }}
          >
            <RefreshCw className="w-4 h-4" style={{ animation: refreshing ? "spin 0.7s linear infinite" : "none" }} />
          </button>

          {/* Divider */}
          <div style={{ width: 26, height: 1, background: MW.border, margin: "4px 0" }} />

          {/* Undo */}
          <button
            title="Undo last drawing"
            onClick={undoLastDrawing}
            disabled={!drawings.length}
            style={{ width:32, height:32, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center",
              background:"transparent", border:`1px solid transparent`,
              color: drawings.length ? MW.muted : MW.border, cursor: drawings.length ? "pointer" : "default" }}
          >
            <Undo2 className="w-4 h-4" />
          </button>

          {/* Clear all */}
          <button
            title="Clear all drawings"
            onClick={clearDrawings}
            disabled={!drawings.length}
            style={{ width:32, height:32, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center",
              background:"transparent", border:`1px solid transparent`,
              color: drawings.length ? "#ef5350aa" : MW.border, cursor: drawings.length ? "pointer" : "default" }}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </aside>

        {/* ── Chart column ────────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">

          {/* Chart — fills all space, OHLCV floats over top-left like MW/TOS */}
          <div className="flex-1 min-h-0 relative" style={{ overflow: "hidden" }}>

            {/* Floating OHLCV + live status overlay (top-left, MW style) */}
            <div
              data-testid="text-symbol"
              className="select-none"
              style={{
                position: "absolute", top: 8, left: 8, zIndex: 10,
                display: "flex", alignItems: "center", gap: 10,
                background: "rgba(5,8,13,0.82)", backdropFilter: "blur(4px)",
                border: "1px solid rgba(20,32,51,0.85)", borderRadius: 4,
                padding: "4px 12px", fontSize: 11, pointerEvents: "none",
                fontFamily: "'Trebuchet MS', monospace",
              }}
            >
              <span style={{ color: MW.accent, fontWeight: 700, fontSize: 12 }}>{selectedSymbol}</span>
              {ohlcv ? (
                <>
                  <span style={{ color: MW.muted }}>O <span style={{ color: MW.text }}>{fmt(ohlcv.open)}</span></span>
                  <span style={{ color: MW.muted }}>H <span style={{ color: MW.up }}>{fmt(ohlcv.high)}</span></span>
                  <span style={{ color: MW.muted }}>L <span style={{ color: MW.down }}>{fmt(ohlcv.low)}</span></span>
                  <span style={{ color: MW.muted }}>C <span style={{
                    color: ohlcv.close != null && ohlcv.open != null
                      ? ohlcv.close >= ohlcv.open ? MW.up : MW.down
                      : MW.text,
                    fontWeight: 600,
                  }}>{fmt(ohlcv.close)}</span></span>
                  <span style={{ color: MW.muted }}>V <span style={{ color: MW.text }}>{fmtVol(ohlcv.volume)}</span></span>
                </>
              ) : null}
              {/* Separator */}
              <span style={{ width: 1, height: 12, background: MW.border, display: "inline-block" }} />
              {/* Live status dot */}
              <div className="flex items-center gap-1" style={{ fontSize: 10 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", display: "inline-block",
                  background: liveStatus === "live" ? "#26c87a" : liveStatus === "connecting" ? "#f59e0b" : "#4a6080",
                  boxShadow: liveStatus === "live" ? "0 0 5px #26c87a" : "none",
                }} />
                <span style={{ color: liveStatus === "live" ? "#26c87a" : "#4a6080" }}>
                  {liveStatus === "live" ? "LIVE" : liveStatus === "connecting" ? "…" : ""}
                </span>
              </div>
              {/* Vector legend */}
              {showVector && (
                <>
                  <span style={{ width: 1, height: 12, background: MW.border, display: "inline-block" }} />
                  <div className="flex items-center gap-1.5" style={{ fontSize: 10, color: MW.muted }}>
                    {/* Current interval vector */}
                    <span className="w-5 h-0.5 inline-block rounded" style={{ background: "#9ca3af" }} />
                    <span>Vec {interval}</span>
                    {/* Extra interval vectors */}
                    {extraVectorLines.map(ev => (
                      <span key={ev.label} className="flex items-center gap-1 ml-1">
                        <span className="w-5 h-0.5 inline-block rounded" style={{ background: ev.color }} />
                        <span style={{ color: ev.color }}>{ev.label}</span>
                      </span>
                    ))}
                    <span className="w-2.5 h-2.5 rounded-sm inline-block ml-1" style={{ background: "#42a5f5" }} />
                    <span style={{ color: MW.muted }}>Above</span>
                    <span className="w-2.5 h-2.5 rounded-sm inline-block ml-1" style={{ background: "#0d3a5c" }} />
                    <span style={{ color: MW.muted }}>Below</span>
                  </div>
                </>
              )}
            </div>

            {/* ── Signals button (top-right of chart) ─────────────────── */}
            <button
              onClick={() => setShowSignalsPanel(v => !v)}
              style={{
                position: "absolute", top: 10, right: 12, zIndex: 40,
                padding: "0 12px", height: 28, borderRadius: 4, fontSize: 11, fontWeight: 700,
                cursor: "pointer", letterSpacing: "0.04em",
                background: showSignalsPanel ? "rgba(66,165,245,0.22)" : "rgba(5,8,13,0.88)",
                border: `1px solid ${showSignalsPanel ? "rgba(66,165,245,0.7)" : "rgba(66,165,245,0.35)"}`,
                color: "#42a5f5",
                backdropFilter: "blur(4px)",
                fontFamily: "'Trebuchet MS', monospace",
              }}
            >
              Signals
            </button>


            {/* ── Backtest results modal ────────────────────────────────── */}
            {showBacktest && backtestResult && (() => {
              const T = MW;
              const fmtTier = (t: BacktierStat, tp1Pts: number, tp2Pts: number, slPts: number) => {
                const resolved  = t.winTp1 + t.winTp2 + t.loss;
                const winRate   = resolved > 0 ? (t.winTp1 + t.winTp2) / resolved : 0;
                const avgWin    = (t.winTp1 * tp1Pts + t.winTp2 * tp2Pts) / Math.max(1, t.winTp1 + t.winTp2);
                const ev        = resolved > 0 ? ((t.winTp1 * tp1Pts + t.winTp2 * tp2Pts) - t.loss * slPts) / resolved : 0;
                return { winRate, avgWin, ev };
              };
              const profile = EXIT_STRATEGY_PROFILES[exitStrategy];
              const safeStats    = fmtTier(backtestResult.tiers.safe,     profile.rth.safe.tp1,  profile.rth.safe.tp2,  profile.rth.safe.sl);
              const riskyStats   = fmtTier(backtestResult.tiers.risky,    profile.rth.risky.tp1, profile.rth.risky.tp2, profile.rth.risky.sl);
              const totalSigs    = Object.values(backtestResult.tiers).reduce((s, t) => s + t.count, 0);
              const totalWins    = Object.values(backtestResult.tiers).reduce((s, t) => s + t.winTp1 + t.winTp2, 0);
              const totalResolved = Object.values(backtestResult.tiers).reduce((s, t) => s + t.winTp1 + t.winTp2 + t.loss, 0);
              const overallWr    = totalResolved > 0 ? totalWins / totalResolved : 0;

              const TierRow = ({ label, color, t, tp1Pts, tp2Pts, slPts }: { label: string; color: string; t: BacktierStat; tp1Pts: number; tp2Pts: number; slPts: number }) => {
                const stats = fmtTier(t, tp1Pts, tp2Pts, slPts);
                const resolved = t.winTp1 + t.winTp2 + t.loss;
                return (
                  <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 6, alignItems: "start", borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 8 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color, textTransform: "uppercase" }}>{label}</span>
                      <span style={{ fontSize: 10, color: T.muted }}>{t.count} signals</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4 }}>
                      {[
                        { label: "Win rate", val: resolved > 0 ? `${(stats.winRate * 100).toFixed(0)}%` : "—", hi: stats.winRate >= 0.5 },
                        { label: "EV/trade", val: resolved > 0 ? `${stats.ev >= 0 ? "+" : ""}${stats.ev.toFixed(1)} pts` : "—", hi: stats.ev > 0 },
                        { label: "TP1 hits", val: t.winTp1.toString(), hi: false },
                        { label: "TP2 hits", val: t.winTp2.toString(), hi: false },
                      ].map(cell => (
                        <div key={cell.label} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 4, padding: "5px 6px" }}>
                          <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>{cell.label}</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: cell.hi ? "#26c87a" : T.text }}>{cell.val}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              };

              return (
                <div
                  style={{
                    position: "absolute", top: 46, right: 80, zIndex: 80,
                    width: 380, maxHeight: "80vh", overflowY: "auto",
                    background: "linear-gradient(180deg,rgba(12,16,22,0.98),rgba(8,12,18,0.98))",
                    border: `1px solid ${T.border}`,
                    borderRadius: 8, padding: "14px 16px",
                    fontFamily: "'Trebuchet MS', monospace",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                  }}
                >
                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#f59e0b" }}>Backtest — {backtestResult.symbol} {backtestResult.interval}</div>
                      <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>
                        {backtestResult.fromDate} → {backtestResult.toDate} · {backtestResult.totalBars.toLocaleString()} bars · exit: {backtestResult.exitStrategy}
                      </div>
                    </div>
                    <button onClick={() => setShowBacktest(false)} style={{ background: "none", border: "none", cursor: "pointer", color: T.muted, padding: 0 }}>
                      <X size={14} />
                    </button>
                  </div>

                  {/* Overall */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginBottom: 4 }}>
                    {[
                      { label: "Total signals", val: totalSigs.toString() },
                      { label: "Overall win rate", val: totalResolved > 0 ? `${(overallWr * 100).toFixed(0)}%` : "—", hi: overallWr >= 0.4 },
                      { label: "Resolved", val: `${totalWins}W / ${totalResolved - totalWins}L` },
                    ].map(cell => (
                      <div key={cell.label} style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 5, padding: "7px 10px" }}>
                        <div style={{ fontSize: 9, color: T.muted, marginBottom: 3 }}>{cell.label}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: ("hi" in cell && cell.hi) ? "#26c87a" : "#f59e0b" }}>{cell.val}</div>
                      </div>
                    ))}
                  </div>

                  <TierRow label="Safe"  color="#26c87a" t={backtestResult.tiers.safe}  tp1Pts={profile.rth.safe.tp1}  tp2Pts={profile.rth.safe.tp2}  slPts={profile.rth.safe.sl} />
                  <TierRow label="Risky" color="#f59e0b" t={backtestResult.tiers.risky} tp1Pts={profile.rth.risky.tp1} tp2Pts={profile.rth.risky.tp2} slPts={profile.rth.risky.sl} />

                  {/* Adjustments toggle */}
                  <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: showAdjustments ? 8 : 0 }}>
                      <button
                        onClick={() => setShowAdjustments(v => !v)}
                        style={{ background: showAdjustments ? "rgba(139,92,246,0.15)" : "rgba(255,255,255,0.04)", border: `1px solid ${showAdjustments ? "rgba(139,92,246,0.5)" : T.border}`, borderRadius: 4, padding: "5px 10px", cursor: "pointer", color: showAdjustments ? "#a78bfa" : T.muted, fontSize: 10, fontWeight: 700 }}
                      >
                        Adjustments ({backtestResult.signals.filter(s => s.noteType !== "good").length})
                      </button>
                      {showAdjustments && backtestResult.signals.filter(s => s.noteType !== "good").length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                          <button
                            disabled={adjustmentsSaving || adjustmentsSaved}
                            onClick={async () => {
                              setAdjustmentsSaving(true);
                              setAdjustmentsSaved(false);
                              try {
                                const nonClean = backtestResult.signals.filter(s => s.noteType !== "good");
                                await fetch("/api/learn/adjustments", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ adjustments: nonClean }),
                                });
                                await fetch("/api/learn/run", { method: "POST" });
                                setAdjustmentsSaved(true);
                              } finally {
                                setAdjustmentsSaving(false);
                              }
                            }}
                            style={{ background: adjustmentsSaved ? "rgba(34,211,238,0.15)" : adjustmentsSaving ? "rgba(139,92,246,0.05)" : "rgba(139,92,246,0.2)", border: `1px solid ${adjustmentsSaved ? "rgba(34,211,238,0.5)" : "rgba(139,92,246,0.4)"}`, borderRadius: 4, padding: "5px 10px", cursor: adjustmentsSaving ? "wait" : adjustmentsSaved ? "default" : "pointer", color: adjustmentsSaved ? "#22d3ee" : "#a78bfa", fontSize: 10, fontWeight: 700 }}
                          >
                            {adjustmentsSaving ? "Writing to LEARNINGS.md…" : adjustmentsSaved ? "✓ Saved to LEARNINGS.md" : "Save to Learn Engine"}
                          </button>
                          {!adjustmentsSaved && !adjustmentsSaving && (
                            <span style={{ fontSize: 9, color: T.muted }}>Writes pattern notes to LEARNINGS.md + runs learn</span>
                          )}
                          {adjustmentsSaved && (
                            <span style={{ fontSize: 9, color: "#22d3ee" }}>Learn engine updated — patterns added to LEARNINGS.md</span>
                          )}
                        </div>
                      )}
                    </div>

                    {showAdjustments && (() => {
                      const nonClean = backtestResult.signals.filter(s => s.noteType !== "good");
                      if (nonClean.length === 0) return <div style={{ fontSize: 10, color: T.muted }}>No adjustments — all signals hit TP2 cleanly.</div>;
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" }}>
                          {nonClean.map((sig, i) => {
                            const col = sig.noteType === "caution" ? "#f59e0b" : "#ef4444";
                            const dt = new Date(sig.time * 1000);
                            const dateStr = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                            const timeStr = dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });
                            return (
                              <div key={i} style={{ display: "grid", gridTemplateColumns: "58px 36px 52px 1fr", gap: 6, alignItems: "center", background: "rgba(255,255,255,0.02)", borderRadius: 4, padding: "5px 8px", borderLeft: `2px solid ${col}` }}>
                                <div style={{ fontSize: 9, color: T.muted }}>{dateStr} {timeStr}</div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: sig.direction === "Long" ? "#26c87a" : "#ef5350" }}>{sig.direction === "Long" ? "▲" : "▼"} {sig.tier[0].toUpperCase()}</div>
                                <div style={{ fontSize: 10, color: T.text }}>{sig.price.toFixed(2)}</div>
                                <div style={{ fontSize: 10, color: col }}>{sig.note}</div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Note */}
                  <div style={{ marginTop: 8, fontSize: 9, color: T.muted, lineHeight: 1.5, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                    Backtest uses vector + Milk zone rules with current exit profile ({exitStrategy}).
                    Zone-confirmed = Safe. Vector-only = Risky. Last run: {new Date(backtestResult.ranAt).toLocaleTimeString()}.
                  </div>
                </div>
              );
            })()}

            {/* ── Live confluence signal alert ─────────────────────────── */}
            {liveAlert && (() => {
              const isSafePlus = liveAlert.riskLevel === "safeplus";
              const dirColor = liveAlert.direction === "Long" ? "#26c87a" : "#ef5350";
              const tierColor = isSafePlus ? "#a78bfa" : liveAlert.riskLevel === "safe" ? "#26c87a" : liveAlert.riskLevel === "risky" ? "#f59e0b" : liveAlert.riskLevel === "riskiest" ? "#ef4444" : dirColor;
              const borderColor = isSafePlus ? "#a78bfa" : dirColor;
              const glowColor = isSafePlus
                ? "rgba(167,139,250,0.4)"
                : liveAlert.direction === "Long" ? "rgba(38,200,122,0.35)" : "rgba(239,83,80,0.35)";
              const bgGrad = isSafePlus
                ? "linear-gradient(135deg,rgba(25,15,50,0.97),rgba(12,6,30,0.97))"
                : liveAlert.direction === "Long"
                  ? "linear-gradient(135deg,rgba(10,40,25,0.97),rgba(5,20,14,0.97))"
                  : "linear-gradient(135deg,rgba(40,8,8,0.97),rgba(20,4,4,0.97))";
              return (
                <div
                  className="mg-lift"
                  style={{
                    position: "absolute", top: 50, right: 12, zIndex: 50,
                    background: bgGrad,
                    border: `1.5px solid ${borderColor}`,
                    borderRadius: 10, padding: "14px 18px", minWidth: 240,
                    boxShadow: `0 0 30px ${glowColor}, 0 18px 44px -22px rgba(0,0,0,0.75)`,
                    backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
                    fontFamily: "'Trebuchet MS', monospace",
                    animation: "fadeInRight 0.34s cubic-bezier(.2,.8,.2,1)",
                  }}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
                    <div className="flex items-center gap-2">
                      <div style={{
                        width: 10, height: 10, borderRadius: "50%",
                        background: dirColor,
                        boxShadow: `0 0 6px ${dirColor}`,
                        animation: "pulse 1s ease infinite",
                      }} />
                      <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: "0.06em", color: dirColor }}>
                        {liveAlert.direction === "Long" ? "▲ LONG" : "▼ SHORT"}
                      </span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, color: "#22d3ee",
                        background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.3)",
                        borderRadius: 3, padding: "1px 6px", letterSpacing: "0.06em",
                      }}>{liveAlert.interval}</span>
                      {liveAlert.riskLevel && (
                        <span style={{
                          fontSize: 9, fontWeight: 800, color: tierColor,
                          background: tierColor + "18", border: `1px solid ${tierColor}55`,
                          borderRadius: 3, padding: "1px 5px", letterSpacing: "0.05em", textTransform: "uppercase",
                        }}>{isSafePlus ? "SAFE+" : liveAlert.riskLevel}</span>
                      )}
                    </div>
                    <button
                      onClick={() => { setLiveAlert(null); if (alertDismissTimer.current) clearTimeout(alertDismissTimer.current); }}
                      style={{ background: "transparent", border: "none", color: MW.muted, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px" }}
                    >✕</button>
                  </div>
                  {/* Levels */}
                  <div style={{ display: "grid", gridTemplateColumns: "36px 1fr", rowGap: 5, fontSize: 12 }}>
                    <span style={{ color: MW.muted }}>Entry</span>
                    <span style={{ color: "#fff", fontWeight: 600 }}>{liveAlert.price.toFixed(2)}</span>
                    <span style={{ color: "#22d3ee" }}>TP2</span>
                    <span style={{ color: "#22d3ee", fontWeight: 700 }}>{liveAlert.tp2.toFixed(2)}</span>
                    <span style={{ color: "#67e8f9" }}>TP1</span>
                    <span style={{ color: "#67e8f9", fontWeight: 600 }}>{liveAlert.tp1.toFixed(2)}</span>
                    <span style={{ color: "#ef5350" }}>SL</span>
                    <span style={{ color: "#ef5350", fontWeight: 600 }}>{liveAlert.sl.toFixed(2)}</span>
                    {liveAlert.scoreLabel && (<>
                      <span style={{ color: MW.muted, fontSize: 10 }}>Score</span>
                      <span style={{ color: "#cbd5e1", fontSize: 10 }}>{liveAlert.scoreLabel}{liveAlert.confidence != null ? ` (${liveAlert.confidence}%)` : ""}</span>
                    </>)}
                  </div>
                  {/* Symbol + time */}
                  <div style={{ marginTop: 8, fontSize: 10, color: MW.muted, borderTop: `1px solid ${MW.border}`, paddingTop: 6 }}>
                    {selectedSymbol} · {new Date(liveAlert.time * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" })} ET
                  </div>
                </div>
              );
            })()}

            {/* auto-trade toast rendered below at page level */}

            {/* ── Signal detail panel (click on any signal marker) ──────── */}
            {selectedSignal && (() => {
              const s = selectedSignal;
              const isLong = s.direction === "Long";
              const accentColor = isLong ? "#26c87a" : "#ef5350";
              const rl = s.riskLevel;
              const rlColor = rl === "safeplus" ? "#a78bfa" : rl === "safe" ? "#26c87a" : rl === "risky" ? "#f59e0b" : rl === "riskiest" ? "#ef4444" : accentColor;
              const rlLabel = rl === "safeplus" ? "SAFE+" : rl ? rl.charAt(0).toUpperCase() + rl.slice(1) : "";
              const title = `● ${rlLabel ? rlLabel + " " : ""}Confluence ${s.direction.toUpperCase()}`;

              // Section 3: build confirmation component list
              const conf = s.confirmations;
              const compParts: string[] = [];
              if (conf?.vecOk)          compParts.push("Primary Vec");
              if (conf?.secondaryVecOk) compParts.push("Sec Vec");
              if (conf?.milkOk)         compParts.push("Milk Zone");
              const compLine = compParts.join(" + ");

              return (
                <div style={{
                  position: "absolute", bottom: 55, left: 12, zIndex: 50,
                  background: "linear-gradient(135deg,rgba(6,15,26,0.97),rgba(3,8,16,0.97))",
                  border: `1.5px solid ${rlColor}55`,
                  borderRadius: 8, padding: "12px 16px", minWidth: 270, maxWidth: 340,
                  boxShadow: `0 0 20px ${rlColor}22`,
                  fontFamily: "'Trebuchet MS', monospace",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: rlColor }}>{title}</span>
                    <button onClick={() => setSelectedSignal(null)} style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", rowGap: 4, fontSize: 11, marginBottom: 10 }}>
                    <span style={{ color: MW.muted }}>Entry</span><span style={{ color: "#fff", fontWeight: 600 }}>{s.price.toFixed(2)}</span>
                    <span style={{ color: "#22d3ee" }}>TP2</span><span style={{ color: "#22d3ee", fontWeight: 700 }}>{s.tp2.toFixed(2)}</span>
                    <span style={{ color: "#67e8f9" }}>TP1</span><span style={{ color: "#67e8f9" }}>{s.tp1.toFixed(2)}</span>
                    <span style={{ color: "#ef5350" }}>SL</span><span style={{ color: "#ef5350" }}>{s.sl.toFixed(2)}</span>
                  </div>
                  <div style={{ borderTop: `1px solid ${MW.border}`, paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    {compLine && (
                      <div style={{ fontSize: 10, color: rlColor + "cc", lineHeight: 1.4 }}>
                        {compLine}
                      </div>
                    )}
                    {s.reclassifyReason && (
                      <div style={{ fontSize: 10, color: "#f59e0b", lineHeight: 1.4 }}>
                        ⚠ Zone conflict: {s.reclassifyReason}
                      </div>
                    )}
                    {!compLine && !s.reclassifyReason && (
                      <div style={{ fontSize: 10, color: MW.muted, lineHeight: 1.4 }}>
                        {rl === "safe" ? "Milk Zone + Vector — strongest" : rl === "risky" ? "Vector + 1 bonus (no zone)" : "Vector gate only — lowest conviction"}
                      </div>
                    )}
                    <button
                      onClick={() => chartRef.current?.scrollToTime(s.time, IVAL_SEC[interval] ?? 300)}
                      style={{
                        marginTop: 4, padding: "4px 0", borderRadius: 4, fontSize: 11,
                        cursor: "pointer", width: "100%",
                        background: "rgba(66,165,245,0.12)",
                        border: `1px solid rgba(66,165,245,0.4)`,
                        color: MW.accent,
                        fontFamily: "'Trebuchet MS', monospace",
                        fontWeight: 600,
                      }}
                    >
                      View on Chart →
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* ── Manual signal analysis panel (Crosshair tool click) ────── */}
            {manualSignalState && (() => {
              const { candle, direction } = manualSignalState;
              const sorted = windowedCandles;
              const idx = sorted.findIndex(c => c.time === candle.time);
              const vecMap = new Map(vectorLine.map(v => [v.time, v.value]));
              const lb = vecMap.get(candle.time);
              const prevLb = idx > 0 ? vecMap.get(sorted[idx - 1].time) : undefined;

              const isBullZ2 = (z: ZoneBand): boolean => {
                const c2 = z.color.toLowerCase().trim();
                if (c2 === "#22c55e" || c2 === "#3b82f6" || c2 === "#14b8a6") return true;
                const m2 = c2.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
                if (m2) { const r2 = +m2[1], g2 = +m2[2], b2 = +m2[3]; return g2 > r2 || (b2 > r2 && b2 > g2); }
                return false;
              };

              // Build per-direction analysis when direction is chosen
              const buildAnalysis = (dir: "Long" | "Short") => {
                const isLong = dir === "Long";
                type Check = { met: boolean; label: string; detail: string };
                const checks: Check[] = [];

                // 1. RTH check
                const rthFlag = candle.rth ?? isRTH(candle.time);
                checks.push({
                  met: rthFlag,
                  label: "RTH Session",
                  detail: rthFlag
                    ? "Regular Trading Hours (Mon–Fri 9:30am–4pm ET)"
                    : "Extended Hours — signals have lower institutional conviction",
                });

                // 2. Market break check
                const inBreak = isMarketBreak(candle.time);
                if (inBreak) checks.push({ met: false, label: "Settlement Break", detail: "4:30–6:00pm ET CME break — no signals allowed here" });

                // 3. Primary vector
                const vecOk = lb != null && (isLong ? candle.close > lb : candle.close < lb);
                const vecTrend = lb != null && prevLb != null && (isLong ? lb >= prevLb : lb <= prevLb);
                checks.push({
                  met: vecOk,
                  label: `Primary Vector (${lb != null ? lb.toFixed(2) : "N/A"})`,
                  detail: lb == null
                    ? "Vector not available for this bar"
                    : vecOk
                      ? `Price ${candle.close.toFixed(2)} is ${isLong ? "above" : "below"} vector ${lb.toFixed(2)} — ${isLong ? "long" : "short"} bias ✓`
                      : `Price ${candle.close.toFixed(2)} is ${isLong ? "below" : "above"} vector ${lb.toFixed(2)} — ${isLong ? "long" : "short"} bias ✗`,
                });
                if (lb != null && prevLb != null) {
                  checks.push({
                    met: vecTrend,
                    label: "Vector Direction",
                    detail: vecTrend
                      ? `Vector is ${isLong ? "rising/flat" : "falling/flat"} (${prevLb.toFixed(2)} → ${lb.toFixed(2)}) — momentum aligned`
                      : `Vector is ${isLong ? "declining" : "rising"} (${prevLb.toFixed(2)} → ${lb.toFixed(2)}) — momentum against ${dir}`,
                  });
                }

                // 4. Milk zone
                const matchingBullZone = activeZones.find(z =>
                  isBullZ2(z) && candle.time >= (z.fromTime ?? 0) && candle.time <= (z.toTime ?? Infinity) &&
                  candle.low <= z.topPrice + 0.5 && candle.close >= z.bottomPrice - 2.0);
                const matchingBearZone = activeZones.find(z =>
                  !isBullZ2(z) && candle.time >= (z.fromTime ?? 0) && candle.time <= (z.toTime ?? Infinity) &&
                  candle.high >= z.bottomPrice - 0.5 && candle.close <= z.topPrice + 2.0);
                const milkOk = isLong ? !!matchingBullZone : !!matchingBearZone;
                const matchZone = isLong ? matchingBullZone : matchingBearZone;
                checks.push({
                  met: milkOk,
                  label: "Milk Zone",
                  detail: milkOk
                    ? `Price in ${isLong ? "bullish" : "bearish"} zone [${matchZone!.bottomPrice.toFixed(2)}–${matchZone!.topPrice.toFixed(2)}]${matchZone?.label ? ` (${matchZone.label})` : ""}`
                    : `No ${isLong ? "bullish support" : "bearish resistance"} zone at this price`,
                });

                // 5. Secondary vector confluence
                const secOkVecs: string[] = [];
                for (const ev of extraVectorLines) {
                  const v = ev.data.findLast?.(p => p.time <= candle.time)?.value
                    ?? ev.data.filter(p => p.time <= candle.time).at(-1)?.value;
                  if (v == null) continue;
                  // Check flatness: compare to value 2 steps back
                  const v2 = ev.data.filter(p => p.time < candle.time).at(-2)?.value;
                  const flat = v2 != null && Math.abs(v - v2) <= 1.0;
                  const aboveOrBelow = isLong ? candle.close > v : candle.close < v;
                  if (aboveOrBelow && flat) secOkVecs.push(`${ev.label} (${v.toFixed(2)}, flat)`);
                }
                checks.push({
                  met: secOkVecs.length > 0,
                  label: "Secondary Vectors",
                  detail: secOkVecs.length > 0
                    ? `Flat confluence: ${secOkVecs.join(", ")}`
                    : "No flat secondary vector confluence (vectors must be consolidating)",
                });

                // 6. HOD/LOD proximity (simplified)
                const dayStart = Math.floor(candle.time / 86400) * 86400;
                const dayBars = sorted.filter(c => c.time >= dayStart && c.time < dayStart + 86400 && (c.rth ?? isRTH(c.time)));
                const barsBeforeThis = dayBars.filter(c => c.time < candle.time);
                const hodBefore = barsBeforeThis.reduce((h, c) => Math.max(h, c.high), -Infinity);
                const lodBefore = barsBeforeThis.reduce((l, c) => Math.min(l, c.low), Infinity);
                const nearHod = isLong && hodBefore > -Infinity && candle.close < hodBefore && candle.close >= hodBefore - 5;
                const nearLod = !isLong && lodBefore < Infinity && candle.close > lodBefore && candle.close <= lodBefore + 5;
                if (isLong && hodBefore > -Infinity) {
                  checks.push({
                    met: !nearHod,
                    label: `HOD Proximity (${hodBefore.toFixed(2)})`,
                    detail: nearHod
                      ? `Entry within 5pts of day's high — limited upside, buying into resistance`
                      : `${(hodBefore - candle.close).toFixed(1)}pts below HOD — room to run`,
                  });
                }
                if (!isLong && lodBefore < Infinity) {
                  checks.push({
                    met: !nearLod,
                    label: `LOD Proximity (${lodBefore.toFixed(2)})`,
                    detail: nearLod
                      ? `Entry within 5pts of day's low — bounce risk, shorting into support`
                      : `${(candle.close - lodBefore).toFixed(1)}pts above LOD — room to fall`,
                  });
                }

                // 7. Resistance/support nearby
                const overhead = activeZones.filter(z =>
                  !isBullZ2(z) && candle.time >= (z.fromTime ?? 0) && candle.time <= (z.toTime ?? Infinity) &&
                  z.bottomPrice > candle.close && z.bottomPrice - candle.close <= 5);
                const below = activeZones.filter(z =>
                  isBullZ2(z) && candle.time >= (z.fromTime ?? 0) && candle.time <= (z.toTime ?? Infinity) &&
                  z.topPrice < candle.close && candle.close - z.topPrice <= 5);
                if (isLong && overhead.length > 0) {
                  const closest = overhead.reduce((a, b) => b.bottomPrice - candle.close < a.bottomPrice - candle.close ? b : a);
                  checks.push({
                    met: false,
                    label: "Overhead Resistance",
                    detail: `${overhead.length} resistance zone${overhead.length > 1 ? "s" : ""} within 5pts — closest: ${closest.bottomPrice.toFixed(2)} (${(closest.bottomPrice - candle.close).toFixed(1)}pts up)${closest.label ? ` "${closest.label}"` : ""}`,
                  });
                }
                if (!isLong && below.length > 0) {
                  const closest = below.reduce((a, b) => candle.close - b.topPrice < candle.close - a.topPrice ? b : a);
                  checks.push({
                    met: false,
                    label: "Nearby Support",
                    detail: `${below.length} support zone${below.length > 1 ? "s" : ""} within 5pts — closest: ${closest.topPrice.toFixed(2)} (${(candle.close - closest.topPrice).toFixed(1)}pts down)${closest.label ? ` "${closest.label}"` : ""}`,
                  });
                }

                // 7b. Zone label ceiling/floor check — comprehensive Milk vocabulary
                const ANLYS_LONG_VETO_RE  = /ceiling|max[\s_]?for[\s_]?day|max[\s_]?range|iv[\s_]?wall|iv[\s_]?overflow|seller[s']?[\s_]?ultimate|seller[s']?[\s_]?soft[\s_]?target|spy[\s_]?(ceiling|top)|ovn[\s_]?spy[\s_]?(ceiling|top)|session[\s_]?cap|gex[\s_]?wall[\s_]?(short|up)|daily[\s_]?(max|ceiling)/i;
                const ANLYS_LONG_DG_RE    = /seller[s']?[\s_]?posit|seller[s']?[\s_]?absorb|seller[s']?[\s_]?object|sellers?[\s_]?will[\s_]?value|non[\s_]?fair[\s_]?value|resistive/i;
                const ANLYS_SHORT_VETO_RE = /floor|min[\s_]?for[\s_]?day|buyer[s']?[\s_]?ultimate|buyer[s']?[\s_]?soft[\s_]?target|spy[\s_]?(floor|bot)|ovn[\s_]?spy[\s_]?(floor|bot)|gex[\s_]?wall[\s_]?(long|down)|daily[\s_]?(min|floor)/i;
                const ANLYS_SHORT_DG_RE   = /buyer[s']?[\s_]?posit|buyer[s']?[\s_]?absorb|buyer[s']?[\s_]?object|buyers?[\s_]?will[\s_]?value|non[\s_]?fair[\s_]?value|supportive/i;
                const ANLYS_PROX = 15;
                if (isLong) {
                  const ceilVeto = activeZones.find(z => {
                    if (!z.label) return false;
                    if (candle.time < (z.fromTime ?? 0) || candle.time > (z.toTime ?? Infinity)) return false;
                    const zBot = Math.min(z.topPrice, z.bottomPrice);
                    const zTop = Math.max(z.topPrice, z.bottomPrice);
                    if (zBot > candle.close + ANLYS_PROX || zTop < candle.close - 2) return false;
                    if (!ANLYS_LONG_VETO_RE.test(z.label)) return false;
                    return !sorted.slice(Math.max(0, idx - 8), idx + 1).some(b => b.close > zTop);
                  });
                  const ceilDg = !ceilVeto && activeZones.find(z => {
                    if (!z.label) return false;
                    if (candle.time < (z.fromTime ?? 0) || candle.time > (z.toTime ?? Infinity)) return false;
                    const zBot = Math.min(z.topPrice, z.bottomPrice);
                    const zTop = Math.max(z.topPrice, z.bottomPrice);
                    if (zBot > candle.close + 8 || zTop < candle.close - 2) return false;
                    return ANLYS_LONG_DG_RE.test(z.label);
                  });
                  if (ceilVeto) checks.push({ met: false, label: `Zone Label Veto: "${ceilVeto.label}"`, detail: `"${ceilVeto.label}" acts as a ceiling — Long signals blocked until price closes above ${Math.max(ceilVeto.topPrice, ceilVeto.bottomPrice).toFixed(2)}` });
                  else if (ceilDg) checks.push({ met: false, label: `Zone Label Downgrade: "${ceilDg.label}"`, detail: `"${ceilDg.label}" is a seller zone nearby — weakens Long conviction` });
                } else {
                  const floorVeto = activeZones.find(z => {
                    if (!z.label) return false;
                    if (candle.time < (z.fromTime ?? 0) || candle.time > (z.toTime ?? Infinity)) return false;
                    const zBot = Math.min(z.topPrice, z.bottomPrice);
                    const zTop = Math.max(z.topPrice, z.bottomPrice);
                    if (zTop < candle.close - ANLYS_PROX || zBot > candle.close + 2) return false;
                    if (!ANLYS_SHORT_VETO_RE.test(z.label)) return false;
                    return !sorted.slice(Math.max(0, idx - 8), idx + 1).some(b => b.close < zBot);
                  });
                  const floorDg = !floorVeto && activeZones.find(z => {
                    if (!z.label) return false;
                    if (candle.time < (z.fromTime ?? 0) || candle.time > (z.toTime ?? Infinity)) return false;
                    const zBot = Math.min(z.topPrice, z.bottomPrice);
                    const zTop = Math.max(z.topPrice, z.bottomPrice);
                    if (zTop < candle.close - 8 || zBot > candle.close + 2) return false;
                    return ANLYS_SHORT_DG_RE.test(z.label);
                  });
                  if (floorVeto) checks.push({ met: false, label: `Zone Label Veto: "${floorVeto.label}"`, detail: `"${floorVeto.label}" acts as a floor — Short signals blocked until price closes below ${Math.min(floorVeto.topPrice, floorVeto.bottomPrice).toFixed(2)}` });
                  else if (floorDg) checks.push({ met: false, label: `Zone Label Downgrade: "${floorDg.label}"`, detail: `"${floorDg.label}" is a buyer zone nearby — weakens Short conviction` });
                }

                // 8. Cooldown check
                const COOLDOWN = 10;
                const recentSignal = allConfluenceSignals
                  .filter(s => s.direction === dir && s.time < candle.time)
                  .sort((a, b) => b.time - a.time)[0];
                const barsSince = recentSignal
                  ? sorted.filter(c => c.time > recentSignal.time && c.time <= candle.time).length
                  : COOLDOWN + 1;
                checks.push({
                  met: barsSince > COOLDOWN,
                  label: `Signal Cooldown (${COOLDOWN}-bar)`,
                  detail: barsSince > COOLDOWN
                    ? `No recent ${dir} signal — cooldown clear (${recentSignal ? `last was ${barsSince} bars ago` : "no prior signal today"})`
                    : `${dir} signal fired only ${barsSince} bars ago @ ${recentSignal!.price.toFixed(2)} — cooldown blocks this candle`,
                });

                // Tier assignment
                const metCount = checks.filter(c => c.met).length;
                const tier: "safe" | "risky" | "riskiest" =
                  milkOk && vecOk ? "safe" : vecOk ? "risky" : "riskiest";
                const wouldFire = vecOk && barsSince > COOLDOWN && !inBreak;

                // Compute levels
                const _ep2 = EXIT_STRATEGY_PROFILES[exitStrategy];
                const _rth2 = candle.rth ?? isRTH(candle.time);
                const { tp1: tp1F, tp2: tp2F, sl: slF } = ((_rth2 ? _ep2.rth : _ep2.eth) as Record<string, { tp1: number; tp2: number; sl: number }>)[tier] ?? (_rth2 ? _ep2.rth : _ep2.eth).riskiest;
                const entryPrice = candle.close;
                const tp1 = isLong ? entryPrice + tp1F : entryPrice - tp1F;
                const tp2 = isLong ? entryPrice + tp2F : entryPrice - tp2F;
                const sl  = isLong ? entryPrice - slF  : entryPrice + slF;

                // Walk-forward outcome
                let outcome: string | null = null;
                if (idx >= 0 && idx < sorted.length - 1) {
                  const settleTs = rthSettleOfDay(candle.time);
                  for (let j = idx + 1; j < sorted.length; j++) {
                    const f = sorted[j];
                    if (f.time > settleTs) { outcome = "Open (session ended)"; break; }
                    if (isLong) {
                      if (f.high >= tp2) { outcome = `Win TP2 @ ${tp2.toFixed(2)}`; break; }
                      if (f.high >= tp1) { outcome = `Win TP1 @ ${tp1.toFixed(2)}`; break; }
                      if (f.low  <= sl)  { outcome = `Loss — SL hit @ ${sl.toFixed(2)}`; break; }
                    } else {
                      if (f.low  <= tp2) { outcome = `Win TP2 @ ${tp2.toFixed(2)}`; break; }
                      if (f.low  <= tp1) { outcome = `Win TP1 @ ${tp1.toFixed(2)}`; break; }
                      if (f.high >= sl)  { outcome = `Loss — SL hit @ ${sl.toFixed(2)}`; break; }
                    }
                  }
                  if (outcome === null) outcome = "Open (no resolution yet)";
                }

                return { checks, tier, wouldFire, entryPrice, tp1, tp2, sl, outcome, metCount };
              };

              const analysis = direction ? buildAnalysis(direction) : null;
              const isLong = direction === "Long";
              const tierColor = analysis?.tier === "safe" ? "#26c87a" : analysis?.tier === "risky" ? "#f59e0b" : "#ef4444";
              const timeStr = new Date(candle.time * 1000).toLocaleString("en-US", {
                weekday: "short", month: "short", day: "numeric",
                hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York",
              }) + " ET";

              // Note helpers (localStorage keyed by candle time + direction)
              const noteKey = direction ? `candle-note-${candle.time}-${direction}` : null;
              const savedNote = noteKey ? (() => { try { return localStorage.getItem(noteKey) ?? ""; } catch { return ""; } })() : "";
              const saveNote = (note: string) => {
                if (!noteKey) return;
                try { if (note.trim()) localStorage.setItem(noteKey, note); else localStorage.removeItem(noteKey); } catch {}
              };

              return (
                <div style={{
                  position: "absolute", bottom: 55, left: 12, zIndex: 60,
                  background: "linear-gradient(135deg,rgba(6,15,26,0.97),rgba(3,8,16,0.97))",
                  border: `1.5px solid ${direction ? (isLong ? "#26c87a55" : "#ef535055") : "#1a72d455"}`,
                  borderRadius: 8, padding: "12px 14px",
                  minWidth: 310, maxWidth: 380,
                  boxShadow: `0 0 24px rgba(0,0,0,0.6)`,
                  fontFamily: "'Trebuchet MS', monospace",
                  maxHeight: "70vh", overflowY: "auto",
                }}>
                  {/* Header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#42a5f5" }}>Candle Analysis</div>
                      <div style={{ fontSize: 10, color: MW.muted, marginTop: 1 }}>{timeStr}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {direction && (
                        <button
                          onClick={() => {
                            if (manualEditMode) {
                              // Switching back to view mode — draft is already in state
                            }
                            setManualEditMode(m => !m);
                            if (!manualEditMode) {
                              // Entering edit mode — prime draft with saved note
                              setManualSignalState(s => s ? { ...s, draftNote: savedNote } : s);
                            }
                          }}
                          title={manualEditMode ? "View computed analysis" : "Write your own analysis (author mode)"}
                          style={{ background: manualEditMode ? "rgba(66,165,245,0.15)" : "none", border: `1px solid ${manualEditMode ? "#42a5f5" : MW.border}`, borderRadius: 4, color: manualEditMode ? "#42a5f5" : MW.muted, cursor: "pointer", fontSize: 11, padding: "2px 6px", lineHeight: 1.4 }}>
                          {manualEditMode ? "View" : "✍ Edit"}
                        </button>
                      )}
                      <button onClick={() => setManualSignalState(null)} style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
                    </div>
                  </div>

                  {/* Candle OHLCV */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4, fontSize: 10, marginBottom: 10, padding: "6px 0", borderBottom: `1px solid ${MW.border}`, borderTop: `1px solid ${MW.border}` }}>
                    {([["O", candle.open, MW.muted], ["H", candle.high, "#26c87a"], ["L", candle.low, "#ef5350"], ["C", candle.close, candle.close >= candle.open ? "#26c87a" : "#ef5350"]] as const).map(([label, val, color]) => (
                      <div key={label} style={{ textAlign: "center" }}>
                        <div style={{ color: MW.muted, fontSize: 9 }}>{label}</div>
                        <div style={{ color, fontWeight: 600, fontSize: 11 }}>{(val as number).toFixed(2)}</div>
                      </div>
                    ))}
                  </div>

                  {/* Direction picker */}
                  {!direction && (
                    <div>
                      <div style={{ fontSize: 10, color: MW.muted, marginBottom: 6, textAlign: "center" }}>
                        Select direction to analyze why a signal should/shouldn't fire here:
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => setManualSignalState(s => s ? { ...s, direction: "Long" } : s)}
                          style={{ flex: 1, padding: "8px 0", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 700,
                            background: "rgba(38,200,122,0.12)", border: "1.5px solid #26c87a66", color: "#26c87a" }}
                        >▲ Long</button>
                        <button
                          onClick={() => setManualSignalState(s => s ? { ...s, direction: "Short" } : s)}
                          style={{ flex: 1, padding: "8px 0", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 700,
                            background: "rgba(239,83,80,0.12)", border: "1.5px solid #ef535066", color: "#ef5350" }}
                        >▼ Short</button>
                      </div>
                    </div>
                  )}

                  {/* Analysis */}
                  {analysis && direction && (
                    <div>
                      {/* Direction toggle */}
                      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                        <button onClick={() => { setManualSignalState(s => s ? { ...s, direction: "Long" } : s); setManualEditMode(false); }}
                          style={{ flex: 1, padding: "5px 0", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 700,
                            background: direction === "Long" ? "rgba(38,200,122,0.18)" : "transparent",
                            border: `1.5px solid ${direction === "Long" ? "#26c87a" : "#1a2535"}`, color: direction === "Long" ? "#26c87a" : MW.muted }}>
                          ▲ Long
                        </button>
                        <button onClick={() => { setManualSignalState(s => s ? { ...s, direction: "Short" } : s); setManualEditMode(false); }}
                          style={{ flex: 1, padding: "5px 0", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 700,
                            background: direction === "Short" ? "rgba(239,83,80,0.18)" : "transparent",
                            border: `1.5px solid ${direction === "Short" ? "#ef5350" : "#1a2535"}`, color: direction === "Short" ? "#ef5350" : MW.muted }}>
                          ▼ Short
                        </button>
                      </div>

                      {/* Author mode: textarea for writing own analysis */}
                      {manualEditMode ? (
                        <div>
                          <div style={{ fontSize: 10, color: MW.muted, marginBottom: 5 }}>Write your own analysis for this {direction} at {candle.close.toFixed(2)}:</div>
                          <textarea
                            value={manualSignalState?.draftNote ?? savedNote}
                            onChange={e => setManualSignalState(s => s ? { ...s, draftNote: e.target.value } : s)}
                            placeholder="Why should/shouldn't a signal fire here? What did price do, what was the context, what would you have done differently?"
                            style={{
                              width: "100%", minHeight: 120, background: "rgba(10,20,35,0.8)",
                              border: `1px solid ${isLong ? "#26c87a44" : "#ef535044"}`, borderRadius: 5,
                              color: MW.text, fontSize: 11, padding: "7px 9px", resize: "vertical",
                              fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box",
                            }}
                          />
                          <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
                            <button
                              onClick={() => {
                                saveNote(manualSignalState?.draftNote ?? "");
                                setManualEditMode(false);
                              }}
                              style={{ flex: 1, padding: "6px 0", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 700,
                                background: isLong ? "rgba(38,200,122,0.18)" : "rgba(239,83,80,0.18)",
                                border: `1px solid ${isLong ? "#26c87a" : "#ef5350"}`, color: isLong ? "#26c87a" : "#ef5350" }}>
                              Save Note
                            </button>
                            <button
                              onClick={() => setManualEditMode(false)}
                              style={{ padding: "6px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11,
                                background: "transparent", border: `1px solid ${MW.border}`, color: MW.muted }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                      <div>
                      {/* Saved author note (shown below direction toggle when a note exists) */}
                      {savedNote && (
                        <div style={{ marginBottom: 10, padding: "7px 9px", borderRadius: 5,
                          background: "rgba(66,165,245,0.06)", border: `1px solid #42a5f522` }}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: "#42a5f5", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>Your Analysis</div>
                          <div style={{ fontSize: 11, color: MW.text, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{savedNote}</div>
                        </div>
                      )}

                      {/* Would it have fired? */}
                      <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 8, padding: "5px 8px", borderRadius: 4,
                        background: analysis.wouldFire ? "rgba(38,200,122,0.1)" : "rgba(239,83,80,0.1)",
                        border: `1px solid ${analysis.wouldFire ? "#26c87a44" : "#ef535044"}`,
                        color: analysis.wouldFire ? "#26c87a" : "#ef5350" }}>
                        {analysis.wouldFire
                          ? `✓ Algorithm WOULD fire: ${analysis.tier.toUpperCase()} ${direction}`
                          : `✗ Algorithm would NOT fire a ${direction} signal here`}
                      </div>

                      {/* Condition checklist */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10 }}>
                        {analysis.checks.map((check, i) => (
                          <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 0, color: check.met ? "#26c87a" : "#ef5350" }}>
                              {check.met ? "✓" : "✗"}
                            </span>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: check.met ? "#c8d8e8" : "#6a7a8a" }}>{check.label}</div>
                              <div style={{ fontSize: 10, color: check.met ? "#4a7a6a" : "#5a4a4a", lineHeight: 1.4 }}>{check.detail}</div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Hypothetical levels + walk-forward — always shown so user can see what would have happened */}
                      <div style={{ borderTop: `1px solid ${MW.border}`, paddingTop: 8, marginBottom: analysis.outcome ? 8 : 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          Hypothetical {analysis.tier.toUpperCase()} Levels
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", rowGap: 3, fontSize: 11 }}>
                          <span style={{ color: MW.muted }}>Entry</span><span style={{ color: "#fff", fontWeight: 600 }}>{analysis.entryPrice.toFixed(2)}</span>
                          <span style={{ color: "#22d3ee" }}>TP2</span><span style={{ color: "#22d3ee", fontWeight: 700 }}>{analysis.tp2.toFixed(2)}</span>
                          <span style={{ color: "#67e8f9" }}>TP1</span><span style={{ color: "#67e8f9" }}>{analysis.tp1.toFixed(2)}</span>
                          <span style={{ color: "#ef5350" }}>SL</span><span style={{ color: "#ef5350" }}>{analysis.sl.toFixed(2)}</span>
                        </div>
                      </div>

                      {/* Walk-forward outcome */}
                      {analysis.outcome && (
                        <div style={{ borderTop: `1px solid ${MW.border}`, paddingTop: 8 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>Walk-Forward Result</div>
                          <div style={{ fontSize: 11, color: analysis.outcome.startsWith("Win") ? "#26c87a" : analysis.outcome.startsWith("Loss") ? "#ef5350" : "#f59e0b", fontWeight: 600 }}>
                            {analysis.outcome}
                          </div>
                        </div>
                      )}
                      </div>
                      )} {/* end author/computed mode conditional */}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* DB error banner — shown when the database quota is exceeded or query fails */}
            {candleError && (
              <div style={{
                position: "absolute", top: 40, left: "50%", transform: "translateX(-50%)",
                zIndex: 50, background: "#1a0a0a", border: "1px solid #7f1d1d",
                borderRadius: 6, padding: "8px 16px", fontSize: 11, color: "#fca5a5",
                maxWidth: 420, textAlign: "center", pointerEvents: "none",
              }}>
                ⚠ Database error: {(candleError as Error).message}
              </div>
            )}

            {/* Chart is always mounted — never conditionally replaced to prevent flicker/remount */}
            <CandlestickChart
              ref={chartRef}
              candles={windowedCandles}
              height={undefined as any}
              showVolume
              intervalKey={`${interval}-${windowSize}`}
              refreshKey={chartRefreshKey}
              zoneOverlays={zoneOverlays}
              bandOverlays={bandOverlayData}
              zones={showMilkZones ? parsedZones : []}
              vectorData={vectorLine}
              showVector={showVector}
              extraVectors={extraVectorLines}
              showLabels={showLabels}
              entrySignals={showVector ? vectorSignals.map(s => ({ time: s.time, price: s.entryPrice })) : []}
              confluenceSignals={allConfluenceSignals}
              activeSignalTime={selectedSignal?.time ?? undefined}
              onSignalClick={info => setSelectedSignal(info)}
              onManualSignalClick={candle => { setManualSignalState({ candle, direction: null }); setManualEditMode(false); }}
              tradeSegments={tradeSegments}
              candleFootprints={candleFootprintMap} // FOOTPRINT-RENDER:
              perCandleFootprints={perCandleFootprintMap} // FOOTPRINT-PER-CANDLE:
              activeSessionTime={activeSessionTime} // FOOTPRINT-RENDER:
              frozenImbalances={frozenImbalanceZones} // FOOTPRINT-RULE:
              theme={currentTheme}
              activeTool={activeTool}
              drawings={drawings}
              onAddDrawing={handleAddDrawing}
              onUpdateDrawing={handleUpdateDrawing}
              onCrosshairMove={setCrosshair}
              onClearDrawings={clearDrawings}
              onUndoDrawing={undoLastDrawing}
            />

            {/* FootprintLadder panel removed — session ladders now drawn directly on canvas */}

            {/* Loading overlay — shown on top of chart while data loads */}
            {(daysLoading || (candlesLoading && windowedCandles.length === 0)) && (
              <div className="mg-backdrop mg-fade-in" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(6,11,20,0.72)", zIndex: 5 }}>
                <div className="flex flex-col items-center gap-3" style={{ color: MW.muted }}>
                  <div className="w-7 h-7 border-2 rounded-full animate-spin" style={{ borderColor: `${MW.accent} transparent transparent transparent`, boxShadow: `0 0 18px -4px ${MW.glow}` }} />
                  <span className="text-sm">{daysLoading ? "Loading..." : "Loading candles..."}</span>
                </div>
              </div>
            )}

            {/* No-data overlay — futures waiting for live relay */}
            {!daysLoading && !candlesLoading && windowedCandles.length === 0 && isFutures && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5 }}>
                <div className="text-center" style={{ color: MW.muted, maxWidth: 420 }}>
                  <div style={{ fontSize: 36, marginBottom: 16 }}>📡</div>
                  <h2 className="text-base font-semibold mb-2" style={{ color: MW.text }}>
                    Waiting for Live Data — {selectedSymbol}
                  </h2>
                  <p className="text-sm mb-5" style={{ lineHeight: 1.6 }}>
                    Futures data comes directly from MotiveWave via the LiveBarRelay study.
                    Open a <strong style={{ color: MW.text }}>{selectedSymbol}</strong> chart in MotiveWave
                    with the <strong style={{ color: MW.text }}>Live Bar Relay</strong> study applied,
                    then bars will appear here automatically.
                  </p>
                  <div className="flex items-center justify-center gap-2" style={{ fontSize: 12 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%", display: "inline-block",
                      background: liveStatus === "live" ? "#26c87a" : liveStatus === "connecting" ? "#f59e0b" : "#ef5350",
                      boxShadow: liveStatus === "live" ? "0 0 6px #26c87a" : "none",
                    }} />
                    <span style={{ color: liveStatus === "live" ? "#26c87a" : liveStatus === "connecting" ? "#f59e0b" : "#4a6080" }}>
                      {liveStatus === "live" ? "WebSocket connected — waiting for bars" : liveStatus === "connecting" ? "Connecting to WebSocket…" : "WebSocket offline (server not running)"}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* No-data overlay — non-futures, no historical data downloaded */}
            {!daysLoading && !candlesLoading && windowedCandles.length === 0 && !isFutures && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5 }}>
                <div className="text-center" style={{ color: MW.muted, maxWidth: 380 }}>
                  <Database className="w-12 h-12 mx-auto mb-4 opacity-30" />
                  <h2 className="text-base font-semibold mb-2" style={{ color: MW.text }}>No Data for {selectedSymbol}</h2>
                  <p className="text-sm mb-4">Download historical data first to view charts.</p>
                  <Link href="/data">
                    <button data-testid="button-go-to-data" className="px-4 py-2 rounded text-sm"
                      style={{ background: MW.accent, color: "#fff" }}>
                      Go to Data Download
                    </button>
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* ── Timeline scrubber ──────────────────────────────────────── */}
          {hasCachedData && (
            <div
              className="flex items-center gap-1 flex-shrink-0"
              style={{ height: 36, background: MW.panel, borderTop: `1px solid ${MW.border}`, padding: "0 6px" }}
            >
              <button
                data-testid="button-window-prev"
                disabled={startDayIdx <= 0}
                onClick={() => shiftWindow(-1)}
                style={{ width:22, height:22, borderRadius:3, background: MW.toolbar, border:`1px solid ${MW.border}`,
                  color: startDayIdx > 0 ? MW.text : MW.border, cursor: startDayIdx > 0 ? "pointer" : "default",
                  display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              {/* Scrollbar track */}
              <div
                ref={timelineRef}
                data-testid="timeline-scroll"
                style={{ flex:1, position:"relative", height:22, cursor:"pointer", userSelect:"none" }}
                onMouseDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = (e.clientX - rect.left) / rect.width;
                  const total = sortedDays.length;
                  if (total === 0) return;
                  const clickedIdx = Math.floor(pct * total);
                  if (clickedIdx >= startDayIdx && clickedIdx <= endDayIdx) {
                    scrubberDragRef.current = { startX: e.clientX, startIdx: startDayIdx, trackWidth: rect.width };
                  } else {
                    jumpToRange(clickedIdx);
                  }
                  e.preventDefault();
                }}
              >
                {/* Background */}
                <div style={{ position:"absolute", inset:0, background: MW.toolbar, borderRadius:3, border:`1px solid ${MW.border}` }} />
                {/* Window indicator */}
                {sortedDays.length > 0 && (
                  <div style={{
                    position:"absolute", top:2, bottom:2,
                    left: `${(startDayIdx / sortedDays.length) * 100}%`,
                    width: `${(Math.min(windowSize, sortedDays.length) / sortedDays.length) * 100}%`,
                    background: MW.accent + "44",
                    border: `1px solid ${MW.accent}88`,
                    borderRadius:2, pointerEvents:"none",
                  }} />
                )}
                {/* Month tick marks */}
                {monthTicks.map(({ label, pct }) => (
                  <div key={label} style={{ position:"absolute", top:2, left:`${pct}%`, pointerEvents:"none" }}>
                    <div style={{ width:1, height:5, background: MW.border + "cc" }} />
                    <div style={{ fontSize:8, color: MW.muted, whiteSpace:"nowrap", transform:"translateX(-40%)", lineHeight:1.2 }}>{label}</div>
                  </div>
                ))}
              </div>

              <button
                data-testid="button-window-next"
                disabled={endDayIdx >= sortedDays.length - 1}
                onClick={() => shiftWindow(1)}
                style={{ width:22, height:22, borderRadius:3, background: MW.toolbar, border:`1px solid ${MW.border}`,
                  color: endDayIdx < sortedDays.length-1 ? MW.text : MW.border,
                  cursor: endDayIdx < sortedDays.length-1 ? "pointer" : "default",
                  display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Status bar ────────────────────────────────────────────────── */}
      <footer
        className="flex items-center gap-4 px-3 flex-shrink-0"
        style={{ height: 22, background: MW.toolbar, borderTop: `1px solid ${MW.border}`, fontSize: 10, color: MW.muted }}
      >
        <span>{selectedSymbol} · {interval}</span>
        {windowedDays.length > 0 && (
          <span>{fmtDateFull(windowedDays[0].date)} — {fmtDateFull(windowedDays[windowedDays.length-1].date)}</span>
        )}
        <div className="flex-1" />
        <span style={{ display:"flex", alignItems:"center", gap:4 }}>
          <span className="w-2 h-2 rounded-sm inline-block" style={{background:"#2196f3"}} />
          <span className="w-2 h-2 rounded-sm inline-block" style={{background:"#c62828"}} /> RTH
          <span className="w-2 h-2 rounded-sm inline-block ml-2" style={{background:"#2196f38c"}} />
          <span className="w-2 h-2 rounded-sm inline-block" style={{background:"#c628288c"}} /> ETH
          {showVector && <><span className="w-2 h-2 rounded-sm inline-block ml-2" style={{background:"#0d3a5c"}} /> Below Vec</>}
        </span>
        {activeTool !== "cursor" && (
          <span style={{ color: MW.accent }}>Tool: {DRAWING_TOOLS.find(t => t.id === activeTool)?.label} · ESC to cancel</span>
        )}
        {drawings.length > 0 && <span>{drawings.length} drawing{drawings.length !== 1 ? "s" : ""}</span>}
      </footer>

      {/* ── Live Edits floating panel ─────────────────────────────────────── */}
      <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 9999, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
        {liveEditOpen && (
          <div style={{
            background: "#1a1a2e", border: `1px solid ${MW.border}`, borderRadius: 8,
            padding: 12, width: 340, boxShadow: "0 4px 24px #0008",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: MW.text, letterSpacing: "0.06em" }}>LIVE EDITS</span>
              <button
                onClick={() => { setLiveEditOpen(false); setLiveEditResult(null); setLiveEditPrompt(""); }}
                style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 14, lineHeight: 1 }}
              >✕</button>
            </div>
            <textarea
              value={liveEditPrompt}
              onChange={e => setLiveEditPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!liveEditLoading && liveEditPrompt.trim()) {
                    setLiveEditLoading(true);
                    setLiveEditResult(null);
                    sendLiveEdit(liveEditPrompt.trim());
                  }
                }
              }}
              placeholder="Describe the code change you want…"
              rows={4}
              style={{
                width: "100%", background: "#111", border: `1px solid ${MW.border}`,
                borderRadius: 4, color: MW.text, fontSize: 11, padding: "6px 8px",
                resize: "vertical", fontFamily: "inherit", outline: "none",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                disabled={liveEditLoading || !liveEditPrompt.trim()}
                onClick={() => { if (!liveEditLoading && liveEditPrompt.trim()) sendLiveEdit(liveEditPrompt.trim()); }}
                style={{
                  flex: 1, padding: "5px 10px", borderRadius: 4, fontSize: 11, fontWeight: 700,
                  background: liveEditLoading ? MW.toolbar : MW.accent, color: "#fff",
                  border: "none", cursor: liveEditLoading ? "default" : "pointer",
                  opacity: (!liveEditPrompt.trim() || liveEditLoading) ? 0.5 : 1,
                }}
              >
                {liveEditLoading ? "Applying…" : "Apply Edit"}
              </button>
              <span style={{ fontSize: 9, color: MW.muted }}>⌘↵</span>
            </div>
            {liveEditResult && (
              <div style={{
                fontSize: 10,
                color: liveEditResult.reloading ? "#facc15" : liveEditResult.ok ? "#26c87a" : "#ef5350",
                background: liveEditResult.reloading ? "#1a1500" : liveEditResult.ok ? "#0d2b1a" : "#2b0d0d",
                border: `1px solid ${liveEditResult.reloading ? "#5c4a00" : liveEditResult.ok ? "#1a5c36" : "#5c1a1a"}`,
                borderRadius: 4, padding: "5px 8px", lineHeight: 1.6,
                whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 120, overflowY: "auto",
              }}>
                {liveEditResult.reloading ? `✓ ${liveEditResult.message}\n\nReloading in 2 seconds…` : liveEditResult.message}
              </div>
            )}
          </div>
        )}
        <button
          onClick={() => { setLiveEditOpen(o => !o); setLiveEditResult(null); }}
          style={{
            padding: "7px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700,
            background: liveEditOpen ? MW.accent : "#1a1a2e",
            border: `1px solid ${liveEditOpen ? MW.accent : MW.border}`,
            color: liveEditOpen ? "#fff" : MW.text,
            cursor: "pointer", boxShadow: "0 2px 10px #0006",
            letterSpacing: "0.05em",
          }}
        >
          Live Edits
        </button>
      </div>
    </div>

    {/* ── Auto-trade toast — fixed so it shows above settings panel ── */}

    {autoTradeToast && (
      <div style={{
        position: "fixed", bottom: 32, right: 24, zIndex: 9999,
        background: autoTradeToast.ok
          ? "linear-gradient(135deg,rgba(10,30,45,0.97),rgba(5,15,25,0.97))"
          : "linear-gradient(135deg,rgba(45,12,12,0.97),rgba(25,6,6,0.97))",
        border: `1.5px solid ${autoTradeToast.ok ? "#1a72d4" : "#ef5350"}`,
        borderRadius: 8, padding: "12px 16px", minWidth: 280, maxWidth: 380,
        boxShadow: `0 4px 32px ${autoTradeToast.ok ? "rgba(26,114,212,0.45)" : "rgba(239,83,80,0.45)"}`,
        fontFamily: "'Trebuchet MS', monospace",
      }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", color: autoTradeToast.ok ? "#1a72d4" : "#ef5350" }}>
            {autoTradeToast.ok ? "✓ ORDER SENT" : "✕ AUTO TRADE FAILED"}
          </span>
          <button
            onClick={() => { setAutoTradeToast(null); if (autoTradeToastTimer.current) clearTimeout(autoTradeToastTimer.current); }}
            style={{ background: "transparent", border: "none", color: "#666", cursor: "pointer", fontSize: 14, padding: "0 2px" }}
          >✕</button>
        </div>
        <div style={{ fontSize: 11, color: autoTradeToast.ok ? "#90caf9" : "#ff8a80", lineHeight: 1.5, wordBreak: "break-word" }}>
          {autoTradeToast.msg}
        </div>
        {!autoTradeToast.ok && (
          <div style={{ marginTop: 6, fontSize: 10, color: "#666", borderTop: "1px solid #1e2a3a", paddingTop: 5 }}>
            Is the AutoTrader study loaded on your MES chart in MotiveWave?
          </div>
        )}
      </div>
    )}
    {/* ── Zone paste modal ─────────────────────────────────────────────── */}
    {showZonePaste && (
      <div className="mg-backdrop mg-fade-in" style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(3,7,14,0.66)" }}
        onClick={e => { if (e.target === e.currentTarget) setShowZonePaste(false); }}>
        <div className="mg-pop-in" style={{ background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 12, padding: 20, width: 520, maxWidth: "90vw", boxShadow: "0 0 0 1px rgba(47,155,255,0.12), 0 24px 60px -24px rgba(0,0,0,0.8), 0 0 40px -16px rgba(47,155,255,0.4)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#c8d8e8" }}>Paste Milk's Pre-Market Zones</div>
              <div style={{ fontSize: 11, color: "#4a6080", marginTop: 3 }}>Copy and paste Milk's pre-market message — zones load automatically for today's session.</div>
            </div>
            <button onClick={() => setShowZonePaste(false)} style={{ background: "transparent", border: "none", color: "#4a6080", cursor: "pointer", fontSize: 18, padding: "0 4px" }}>×</button>
          </div>
          <textarea
            value={zonePasteText}
            onChange={e => { setZonePasteText(e.target.value); setZonePasteStatus("idle"); }}
            placeholder={"Paste Milk's zone message here...\n\nExample:\nIV WALL 7230-7255\nBUYER POSITIONING 7170-7185\nSELLER POSITIONING 7220-7235\nNON FAIR VALUE 7150-7165"}
            style={{ width: "100%", height: 180, resize: "vertical", background: "#05080d", border: "1px solid #1a2535", borderRadius: 6, padding: "10px 12px", color: "#c8d8e8", fontSize: 12, fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}
          />
          {zonePasteStatus === "ok" && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#26c87a" }}>✓ Loaded {zonePasteCount} zone{zonePasteCount !== 1 ? "s" : ""} for today's session.</div>
          )}
          {zonePasteStatus === "err" && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#ef5350" }}>⚠ No recognizable zones found. Check the text contains zone labels and price ranges.</div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
            <button
              onClick={async () => {
                await fetch(`/api/discord-zones/paste?symbol=${selectedSymbol}`, { method: "DELETE" });
                setZonePasteText("");
                setZonePasteCount(0);
                setZonePasteStatus("idle");
                queryClient.invalidateQueries({ queryKey: ["/api/discord-zones"] });
              }}
              style={{ padding: "6px 14px", borderRadius: 5, background: "transparent", border: "1px solid #1a2535", color: "#4a6080", cursor: "pointer", fontSize: 12 }}>
              Clear Today
            </button>
            <button
              disabled={zonePasteStatus === "loading" || !zonePasteText.trim()}
              onClick={async () => {
                if (!zonePasteText.trim()) return;
                setZonePasteStatus("loading");
                try {
                  const r = await fetch("/api/discord-zones/paste", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: zonePasteText, symbol: selectedSymbol, channel: "manual-paste" }),
                  });
                  const d = await r.json();
                  if (d.ok && d.zonesFound > 0) {
                    setZonePasteCount(d.zonesFound);
                    setZonePasteStatus("ok");
                    queryClient.invalidateQueries({ queryKey: ["/api/discord-zones"] });
                  } else {
                    setZonePasteStatus("err");
                  }
                } catch { setZonePasteStatus("err"); }
              }}
              style={{ padding: "6px 14px", borderRadius: 5, background: zonePasteStatus === "loading" ? "#1a2535" : "#1a72d4", border: "none", color: "#fff", cursor: zonePasteText.trim() ? "pointer" : "not-allowed", fontSize: 12, opacity: zonePasteText.trim() ? 1 : 0.5 }}>
              {zonePasteStatus === "loading" ? "Parsing…" : "Load Zones"}
            </button>
          </div>
        </div>
      </div>
    )}

    {stratGuardData && (
      <StrategyGuardDialog
        matchedStrategies={stratGuardData.matched}
        onCancel={() => setStratGuardData(null)}
        onProceedWithout={() => {
          const p = stratGuardData.pendingPrompt;
          setStratGuardData(null);
          sendLiveEdit(p, []);
        }}
        onProceedAndUpdate={(ids) => {
          const p = stratGuardData.pendingPrompt;
          setStratGuardData(null);
          // Fire strategy updates first, then run the edit
          Promise.all(ids.map(id =>
            fetch(`/api/strategies/${id}/update`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt: p }),
            })
          )).finally(() => sendLiveEdit(p, ids));
        }}
      />
    )}
    </>
  );
}
