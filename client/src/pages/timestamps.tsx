import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { BarChart3, ChevronLeft, Filter, Pencil, Zap, Brain, Save, BookOpen } from "lucide-react";
import { type ZoneBand } from "@/components/CandlestickChart";
import { SignalMiniChart } from "@/components/SignalMiniChart";

// ── Types ──────────────────────────────────────────────────────────────────────
interface CandleBar { time: number; open: number; high: number; low: number; close: number; volume?: number }

type Direction = "Long" | "Short" | "Neutral";
type ConfluenceLevel = "2/2" | "1/2" | "0/2";
type RiskLevel = "safe" | "risky" | "riskiest";

// ── Pattern recognition types ─────────────────────────────────────────────────
type PatternType =
  | "HH_HL" | "LL_LH"
  | "BOS_BULL" | "BOS_BEAR"
  | "ENGULF_BULL" | "ENGULF_BEAR"
  | "PIN_BULL" | "PIN_BEAR"
  | "IB_BULL" | "IB_BEAR";

type PatternStrength = "strongest" | "strong" | "weak";

type PatternSig = {
  time: number; price: number;
  direction: "Long" | "Short";
  pattern: PatternType;
  strength: PatternStrength;
  milkVote: boolean; vectorVote: boolean;
  tp1: number; tp2: number; sl: number; atr: number;
  outcome: "Win" | "Loss" | "Open";
  points: number | null;
};

interface CandleSignal {
  time: number;
  open: number; high: number; low: number; close: number;
  vecSignal:     Direction;
  vecValue:      number | null;
  milkZoneDir:   Direction;
  confluence:    ConfluenceLevel;
  confluencePct: number;
  finalSignal:   string;
  longCount:     number;
  shortCount:    number;
  outcome:       "Win" | "Loss" | "--";
  points:        number | null;
  explanation:   string;
  atr:           number;
}

interface LearnedFilters {
  noETH:          boolean;
  requireBody:    boolean;
  require2of2:    boolean;
  noLastHourRTH:  boolean;
  noOpenHalfHour: boolean;
  lessons:        string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────
const VEC_LENGTH  = 20;
const ATR_PERIOD  = 14;
const TP_ATR_MULT = 1.0;
const SL_ATR_MULT = 0.5;

// ── Vector helpers ─────────────────────────────────────────────────────────────
function computeVectorLine(candles: CandleBar[]): Map<number, number> {
  if (!candles.length) return new Map();
  const s = [...candles].sort((a, b) => a.time - b.time);
  const n = s.length;
  const lb = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let lo = s[i].low;
    for (let j = Math.max(0, i - VEC_LENGTH + 1); j < i; j++) if (s[j].low < lo) lo = s[j].low;
    lb[i] = lo;
  }
  const result = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    let hi = lb[i];
    for (let j = Math.max(0, i - VEC_LENGTH + 1); j < i; j++) if (lb[j] > hi) hi = lb[j];
    result.set(s[i].time, hi);
  }
  return result;
}

function vecSignal(c: CandleBar, vecMap: Map<number, number>): Direction {
  const lb = vecMap.get(c.time);
  if (lb == null) return "Neutral";
  if (c.close > lb) return "Long";
  if (c.close < lb) return "Short";
  return "Neutral";
}

function isRTH(ts: number): boolean {
  const d = new Date(ts * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins < 21 * 60; // 9:30 AM – 5:00 PM ET (EDT)
}

function buildMilkZoneSets(candles: CandleBar[]): { bull: Set<number>; bear: Set<number> } {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const rth = sorted.filter(c => isRTH(c.time));
  const BAR_INT = 5 * 60;
  const bull = new Set<number>(), bear = new Set<number>();
  if (rth.length < 3) return { bull, bear };

  const atrAt = (i: number): number => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - 13); j <= i; j++) {
      const b = rth[j], p = j > 0 ? rth[j - 1] : b;
      s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
      n++;
    }
    return n > 0 ? s / n : 2;
  };

  type ZE = { from: number; to: number; isBull: boolean };
  const zones: ZE[] = [];

  for (let i = 1; i < rth.length - 1; i++) {
    const prev = rth[i - 1], curr = rth[i], next = rth[i + 1];
    const atr = atrAt(i);
    if (prev.high < next.low && next.low - prev.high >= 0.5)
      zones.push({ from: curr.time, to: curr.time + 24 * BAR_INT, isBull: true });
    if (prev.low > next.high && prev.low - next.high >= 0.5)
      zones.push({ from: curr.time, to: curr.time + 24 * BAR_INT, isBull: false });
    if (curr.close < curr.open) {
      let maxUp = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++) maxUp = Math.max(maxUp, rth[j].high - curr.high);
      if (maxUp >= atr * 1.5) zones.push({ from: curr.time, to: curr.time + 15 * BAR_INT, isBull: true });
    }
    if (curr.close > curr.open) {
      let maxDown = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++) maxDown = Math.max(maxDown, curr.low - rth[j].low);
      if (maxDown >= atr * 1.5) zones.push({ from: curr.time, to: curr.time + 15 * BAR_INT, isBull: false });
    }
    const LB = 3;
    let isHigh = true, isLow = true;
    for (let j = Math.max(0, i - LB); j < i; j++) { if (rth[j].high >= curr.high) isHigh = false; if (rth[j].low <= curr.low) isLow = false; }
    for (let j = i + 1; j <= Math.min(rth.length - 1, i + LB); j++) { if (rth[j].high >= curr.high) isHigh = false; if (rth[j].low <= curr.low) isLow = false; }
    const dur = 78 * BAR_INT;
    if (isHigh) zones.push({ from: curr.time, to: curr.time + dur, isBull: false });
    if (isLow)  zones.push({ from: curr.time, to: curr.time + dur, isBull: true });
  }

  for (const z of zones) {
    let lo = 0, hi = sorted.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].time < z.from) lo = mid + 1; else hi = mid; }
    for (let j = lo; j < sorted.length && sorted[j].time <= z.to; j++) {
      if (z.isBull) bull.add(sorted[j].time); else bear.add(sorted[j].time);
    }
  }
  return { bull, bear };
}

function buildConfluence(vec: Direction, milk: Direction): { level: ConfluenceLevel; pct: number; final: string; longCount: number; shortCount: number } {
  const longs  = [vec, milk].filter(s => s === "Long").length;
  const shorts = [vec, milk].filter(s => s === "Short").length;
  if (longs > 0 && shorts > 0) return { level: "0/2", pct: 0, final: "No Trade", longCount: longs, shortCount: shorts };
  const domCount = Math.max(longs, shorts);
  const dominant = longs > 0 ? "Long" : "Short";
  const level: ConfluenceLevel = domCount === 2 ? "2/2" : domCount === 1 ? "1/2" : "0/2";
  const pct = Math.round((domCount / 2) * 100);
  let final = "No Trade";
  if (domCount === 2)      final = dominant === "Long" ? "Strong Long ▲▲" : "Strong Short ▼▼";
  else if (domCount === 1) final = dominant === "Long" ? "Weak Long ▲"    : "Weak Short ▼";
  return { level, pct, final, longCount: longs, shortCount: shorts };
}

// ── Risk level gate ────────────────────────────────────────────────────────────
const ETH_PROX: Record<RiskLevel, number> = { safe: 0.8, risky: 1.2, riskiest: 2.0 };

function qualifiesForRisk(s: CandleSignal, level: RiskLevel): boolean {
  if (s.finalSignal === "No Trade") return false;
  const rth = isRTH(s.time);
  if (!rth) {
    if (s.vecSignal === "Neutral") return false;
    if (level !== "riskiest") {
      const bodyOk = s.finalSignal.includes("Long") ? s.close > s.open : s.close < s.open;
      if (!bodyOk) return false;
    }
    if (s.vecValue != null) {
      const range = Math.max(s.high - s.low, 0.25);
      if (Math.abs(s.close - s.vecValue) > ETH_PROX[level] * range) return false;
    }
    return true;
  }
  if (level === "safe") {
    if (s.confluence !== "2/2") return false;
    return s.finalSignal.includes("Long") ? s.close > s.open : s.close < s.open;
  }
  if (level === "risky") return s.confluence === "2/2";
  return s.confluence === "2/2" || s.confluence === "1/2";
}

// ── Learned filter derivation ──────────────────────────────────────────────────
function deriveFilters(badSignals: Array<CandleSignal & { reason: string }>): LearnedFilters {
  const total = badSignals.length;
  if (!total) return { noETH: false, requireBody: false, require2of2: false, noLastHourRTH: false, noOpenHalfHour: false, lessons: ["No bad trades marked yet."] };
  const p = (n: number) => n / total;
  const lessons: string[] = [];

  const ethCnt = badSignals.filter(s => !isRTH(s.time)).length;
  const noETH = p(ethCnt) >= 0.6;
  if (noETH) lessons.push(`⛔ Skip ETH: ${Math.round(p(ethCnt) * 100)}% of bad trades were ETH session`);

  const noBodyCnt = badSignals.filter(s => {
    const isLong = s.finalSignal.includes("Long");
    return isLong ? s.close <= s.open : s.close >= s.open;
  }).length;
  const requireBody = p(noBodyCnt) >= 0.5;
  if (requireBody) lessons.push(`⛔ Require body: ${Math.round(p(noBodyCnt) * 100)}% of bad trades had no body confirmation`);

  const weakCnt = badSignals.filter(s => s.confluence !== "2/2").length;
  const require2of2 = p(weakCnt) >= 0.5;
  if (require2of2) lessons.push(`⛔ Require 2/2: ${Math.round(p(weakCnt) * 100)}% of bad trades were weak (1/2) confluence`);

  const lastHrCnt = badSignals.filter(s => {
    const m = new Date(s.time * 1000).getUTCHours() * 60 + new Date(s.time * 1000).getUTCMinutes();
    return m >= 20 * 60;
  }).length;
  const noLastHourRTH = p(lastHrCnt) >= 0.5;
  if (noLastHourRTH) lessons.push(`⛔ Skip 4–5pm ET: ${Math.round(p(lastHrCnt) * 100)}% of bad trades in last RTH hour`);

  const openCnt = badSignals.filter(s => {
    const m = new Date(s.time * 1000).getUTCHours() * 60 + new Date(s.time * 1000).getUTCMinutes();
    return m >= 13 * 60 + 30 && m < 14 * 60;
  }).length;
  const noOpenHalfHour = p(openCnt) >= 0.5;
  if (noOpenHalfHour) lessons.push(`⛔ Skip 9:30–10am ET: ${Math.round(p(openCnt) * 100)}% of bad trades at RTH open`);

  const reasonsText = badSignals.map(s => s.reason.toLowerCase()).join(" ");
  if (reasonsText.match(/chasing|overextend|extended|late entry/))
    lessons.push("📝 Reasons mention chasing/overextended — tighten vector proximity rules");
  if (reasonsText.match(/news|macro|cpi|fomc|event|data/))
    lessons.push("📝 Reasons mention macro events — avoid signals near news releases");
  if (reasonsText.match(/counter.trend|against.trend|fade|wrong.direction/))
    lessons.push("📝 Reasons mention counter-trend — only take trades aligned with vector direction");

  if (!lessons.length) lessons.push("✓ No dominant pattern found — mark more bad trades for better analysis");

  return { noETH, requireBody, require2of2, noLastHourRTH, noOpenHalfHour, lessons };
}

function qualifiesWithLearnings(s: CandleSignal, level: RiskLevel, f: LearnedFilters): boolean {
  if (!qualifiesForRisk(s, level)) return false;
  if (f.noETH && !isRTH(s.time)) return false;
  if (f.requireBody) {
    const isLong = s.finalSignal.includes("Long");
    if (isLong ? s.close <= s.open : s.close >= s.open) return false;
  }
  if (f.require2of2 && s.confluence !== "2/2") return false;
  if (f.noLastHourRTH || f.noOpenHalfHour) {
    const m = new Date(s.time * 1000).getUTCHours() * 60 + new Date(s.time * 1000).getUTCMinutes();
    if (f.noLastHourRTH   && m >= 20 * 60) return false;
    if (f.noOpenHalfHour  && m >= 13 * 60 + 30 && m < 14 * 60) return false;
  }
  return true;
}

// ── Palette ────────────────────────────────────────────────────────────────────
const MW = {
  bg: "#060b14", panel: "#0a1220", toolbar: "#0d1829", border: "#142033",
  text: "#b8c8d8", muted: "#4a6080", accent: "#1a72d4",
};

function dirColor(d: Direction) {
  if (d === "Long")  return "#26c87a";
  if (d === "Short") return "#ef5350";
  return "#4a6080";
}

function finalColor(final: string) {
  if (final.includes("Strong Long"))  return "#26c87a";
  if (final.includes("Strong Short")) return "#ef5350";
  if (final.includes("Weak Long"))    return "#a3e8c4";
  if (final.includes("Weak Short"))   return "#f49c9a";
  return "#4a6080";
}

function fmtTs(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });
}

// ── Pattern matching ───────────────────────────────────────────────────────────
function computePatternStats(sorted: CandleBar[], idx: number, atr: number, dir: "Long" | "Short") {
  const WINDOW = 15, FORWARD = 20, TOP_K = 15, SEARCH = 300;
  if (idx < WINDOW) return null;
  const refClose = sorted[idx].close;
  const scale    = Math.max(atr, 0.25);
  const feat     = Array.from({ length: WINDOW }, (_, k) => (sorted[idx - WINDOW + 1 + k].close - refClose) / scale);
  const lo = Math.max(0, idx - SEARCH - WINDOW + 1);
  const results: { d: number; j: number }[] = [];
  for (let j = lo; j <= idx - WINDOW - 1; j++) {
    const base = sorted[j + WINDOW - 1].close;
    let d = 0;
    for (let k = 0; k < WINDOW; k++) { const dv = feat[k] - (sorted[j + k].close - base) / scale; d += dv * dv; }
    results.push({ d, j });
  }
  results.sort((a, b) => a.d - b.d);
  const top = results.slice(0, TOP_K);
  if (!top.length) return null;
  let fav = 0, sumGain = 0, sumLoss = 0;
  for (const { j } of top) {
    const base = sorted[j + WINDOW - 1].close;
    let maxGain = 0, maxLoss = 0;
    for (let f = j + WINDOW; f <= Math.min(sorted.length - 1, j + WINDOW + FORWARD - 1); f++) {
      maxGain = Math.max(maxGain, sorted[f].high - base);
      maxLoss = Math.max(maxLoss, base - sorted[f].low);
    }
    sumGain += maxGain; sumLoss += maxLoss;
    if ((dir === "Long" && maxGain > maxLoss) || (dir === "Short" && maxLoss > maxGain)) fav++;
  }
  return { count: top.length, favPct: Math.round((fav / top.length) * 100), avgMaxGain: sumGain / top.length, avgMaxLoss: sumLoss / top.length };
}

function buildSignalExplanation(s: Omit<CandleSignal, "explanation" | "atr">, sorted: CandleBar[], idx: number, atr: number): string {
  const dir = s.finalSignal.includes("Long") ? "Long" : "Short" as "Long" | "Short";
  const parts: string[] = [];
  if (s.confluence === "2/2")
    parts.push(`2/2 confluence — Vector ${s.vecSignal === "Long" ? "▲ Long" : "▼ Short"} + Milk Zone ${s.milkZoneDir === "Long" ? "▲ Long" : "▼ Short"} agree`);
  else if (s.confluence === "1/2") {
    const dom = s.vecSignal !== "Neutral" ? `Vector ${s.vecSignal === "Long" ? "▲ Long" : "▼ Short"}` : `Milk Zone ${s.milkZoneDir === "Long" ? "▲ Long" : "▼ Short"}`;
    parts.push(`1/2 partial — ${dom} fires; other signal is Neutral`);
  }
  const isLong = dir === "Long";
  const bodyOk = isLong ? s.close > s.open : s.close < s.open;
  const bodyPts = Math.abs(s.close - s.open).toFixed(2);
  parts.push(bodyOk ? `Body confirms: ${isLong ? "bullish" : "bearish"} close (+${bodyPts} pts body)` : `No body confirmation — ${isLong ? "bearish" : "bullish"} candle at entry`);
  parts.push(isRTH(s.time) ? `RTH session · ATR = ${atr.toFixed(2)} pts` : `ETH session · vector proximity entry · ATR = ${atr.toFixed(2)} pts`);
  const ps = computePatternStats(sorted, idx, atr, dir);
  if (ps) {
    parts.push(`${ps.count} similar 15-bar patterns (last 300 bars)`);
    parts.push(`${ps.favPct}% resolved ${isLong ? "bullishly" : "bearishly"} · avg max gain +${ps.avgMaxGain.toFixed(1)} pts · avg max drawdown −${ps.avgMaxLoss.toFixed(1)} pts`);
  }
  return parts.join("|");
}

// ── Milk zone detector (exact copy from market.tsx) ────────────────────────────
function detectMilkZones(candles: CandleBar[], historyBars = 234, displayCap = 60): ZoneBand[] {
  const rth = [...candles].sort((a, b) => a.time - b.time).filter(c => (c as any).rth !== false);
  const zones: ZoneBand[] = [];
  const BAR_INT = 5 * 60;
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
    if (prev.high < next.low && next.low - prev.high >= 0.5)
      zones.push({ topPrice: next.low, bottomPrice: prev.high, color: "#22c55e", label: "IMBALANCE", fromTime: curr.time, toTime: curr.time + 24 * BAR_INT });
    if (prev.low > next.high && prev.low - next.high >= 0.5)
      zones.push({ topPrice: prev.low, bottomPrice: next.high, color: "#ef4444", label: "RESIST IMBALANCE", fromTime: curr.time, toTime: curr.time + 24 * BAR_INT });
    if (curr.close < curr.open) {
      let maxUp = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++) maxUp = Math.max(maxUp, rth[j].high - curr.high);
      if (maxUp >= atr * 1.5) zones.push({ topPrice: Math.max(curr.open, curr.close), bottomPrice: curr.low, color: "#3b82f6", label: "ABSORPTION", fromTime: curr.time, toTime: curr.time + 15 * BAR_INT });
    }
    if (curr.close > curr.open) {
      let maxDown = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++) maxDown = Math.max(maxDown, curr.low - rth[j].low);
      if (maxDown >= atr * 1.5) zones.push({ topPrice: curr.high, bottomPrice: Math.min(curr.open, curr.close), color: "#f97316", label: "RESISTIVE", fromTime: curr.time, toTime: curr.time + 15 * BAR_INT });
    }
    const LB = 3;
    let isHigh = true, isLow = true;
    for (let j = Math.max(0, i - LB); j < i; j++) { if (rth[j].high >= curr.high) isHigh = false; if (rth[j].low <= curr.low) isLow = false; }
    for (let j = i + 1; j <= Math.min(rth.length - 1, i + LB); j++) { if (rth[j].high >= curr.high) isHigh = false; if (rth[j].low <= curr.low) isLow = false; }
    const sz = Math.max(atr * 0.25, 1.5), sessionDur = 78 * BAR_INT;
    if (isHigh) zones.push({ topPrice: curr.high + sz * 0.15, bottomPrice: curr.high - sz, color: "#f43f5e", label: "STRUCTURAL RESIST", fromTime: curr.time, toTime: curr.time + sessionDur });
    if (isLow)  zones.push({ topPrice: curr.low + sz, bottomPrice: curr.low - sz * 0.15, color: "#14b8a6", label: "STRUCTURAL SUPPORT", fromTime: curr.time, toTime: curr.time + sessionDur });
  }
  return displayCap > 0 ? zones.slice(-displayCap) : zones;
}

// ── Candle aggregation helper ──────────────────────────────────────────────────
function aggToInterval(candles: CandleBar[], intervalSec: number): CandleBar[] {
  if (!candles.length) return [];
  const s = [...candles].sort((a, b) => a.time - b.time);
  const map = new Map<number, CandleBar>();
  for (const c of s) {
    const bucket = Math.floor(c.time / intervalSec) * intervalSec;
    const ex = map.get(bucket);
    if (!ex) {
      map.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 });
    } else {
      ex.high   = Math.max(ex.high, c.high);
      ex.low    = Math.min(ex.low,  c.low);
      ex.close  = c.close;
      ex.volume = (ex.volume ?? 0) + (c.volume ?? 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

// ── Pattern recognition ────────────────────────────────────────────────────────

const PATTERN_LABELS: Record<PatternType, string> = {
  HH_HL: "HH+HL Trend", LL_LH: "LL+LH Trend",
  BOS_BULL: "BOS Break ↑", BOS_BEAR: "BOS Break ↓",
  ENGULF_BULL: "Bull Engulf", ENGULF_BEAR: "Bear Engulf",
  PIN_BULL: "Hammer", PIN_BEAR: "Shooting Star",
  IB_BULL: "IB Breakout ↑", IB_BEAR: "IB Breakout ↓",
};

function detectFractals(sorted: CandleBar[]) {
  const highs: Array<{time: number; price: number; idx: number}> = [];
  const lows:  Array<{time: number; price: number; idx: number}> = [];
  for (let i = 2; i < sorted.length - 2; i++) {
    const b = sorted[i];
    if (b.high > sorted[i-1].high && b.high > sorted[i-2].high &&
        b.high > sorted[i+1].high && b.high > sorted[i+2].high)
      highs.push({time: b.time, price: b.high, idx: i});
    if (b.low < sorted[i-1].low && b.low < sorted[i-2].low &&
        b.low < sorted[i+1].low && b.low < sorted[i+2].low)
      lows.push({time: b.time, price: b.low, idx: i});
  }
  return {highs, lows};
}

function computePatternSignals(
  sorted: CandleBar[],
  vecMap: Map<number, number>,
  milkBull: Set<number>,
  milkBear: Set<number>,
): PatternSig[] {
  if (sorted.length < 10) return [];
  const ATR_P = 14, TP_M = 1.0, SL_M = 0.5;

  const atrArr = sorted.map((c, i) => {
    let s = 0;
    const st = Math.max(0, i - ATR_P + 1);
    for (let j = st; j <= i; j++) {
      const b = sorted[j], p = j > 0 ? sorted[j-1] : b;
      s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    }
    return Math.max(s / (i - st + 1), 0.25);
  });

  const {highs: allH, lows: allL} = detectFractals(sorted);
  const results: PatternSig[] = [];
  const cooldown: Record<string, number> = {};
  const COOL = 5;

  for (let i = 4; i < sorted.length - 2; i++) {
    const c = sorted[i], prev = sorted[i-1], prev2 = sorted[i-2];
    const atr = atrArr[i];
    if (!isRTH(c.time)) continue;

    // Only confirmed fractals (center idx ≤ i-2)
    const cH = allH.filter(f => f.idx <= i - 2).slice(-5);
    const cL = allL.filter(f => f.idx <= i - 2).slice(-5);
    if (!cH.length && !cL.length) continue;

    const fired: Array<{pat: PatternType; dir: "Long"|"Short"}> = [];

    // 1. HH+HL — bullish trend structure
    if (cH.length >= 2 && cL.length >= 2 &&
        cH[cH.length-1].price > cH[cH.length-2].price &&
        cL[cL.length-1].price > cL[cL.length-2].price)
      fired.push({pat: "HH_HL", dir: "Long"});

    // 2. LL+LH — bearish trend structure
    if (cH.length >= 2 && cL.length >= 2 &&
        cL[cL.length-1].price < cL[cL.length-2].price &&
        cH[cH.length-1].price < cH[cH.length-2].price)
      fired.push({pat: "LL_LH", dir: "Short"});

    // 3. BOS Bull — first close above last confirmed swing high
    if (cH.length && c.close > cH[cH.length-1].price && prev.close <= cH[cH.length-1].price)
      fired.push({pat: "BOS_BULL", dir: "Long"});

    // 4. BOS Bear — first close below last confirmed swing low
    if (cL.length && c.close < cL[cL.length-1].price && prev.close >= cL[cL.length-1].price)
      fired.push({pat: "BOS_BEAR", dir: "Short"});

    // 5. Bullish Engulfing near fractal low
    if (cL.length && c.close > c.open && c.open <= prev.close && c.close >= prev.open && c.close > prev.open &&
        cL.some(fl => Math.abs(c.low - fl.price) <= atr * 1.5))
      fired.push({pat: "ENGULF_BULL", dir: "Long"});

    // 6. Bearish Engulfing near fractal high
    if (cH.length && c.close < c.open && c.open >= prev.close && c.close <= prev.open && c.close < prev.open &&
        cH.some(fh => Math.abs(c.high - fh.price) <= atr * 1.5))
      fired.push({pat: "ENGULF_BEAR", dir: "Short"});

    // 7. Hammer (pin bar) near fractal low
    if (cL.length) {
      const body = Math.abs(c.close - c.open), range = c.high - c.low;
      const lw = Math.min(c.open, c.close) - c.low;
      if (range > 0 && body > 0 && lw >= 2 * body && (Math.max(c.open, c.close) - c.low) / range >= 0.6 &&
          cL.some(fl => Math.abs(c.low - fl.price) <= atr * 1.5))
        fired.push({pat: "PIN_BULL", dir: "Long"});
    }

    // 8. Shooting Star near fractal high
    if (cH.length) {
      const body = Math.abs(c.close - c.open), range = c.high - c.low;
      const uw = c.high - Math.max(c.open, c.close);
      if (range > 0 && body > 0 && uw >= 2 * body && (c.high - Math.min(c.open, c.close)) / range >= 0.6 &&
          cH.some(fh => Math.abs(c.high - fh.price) <= atr * 1.5))
        fired.push({pat: "PIN_BEAR", dir: "Short"});
    }

    // 9+10. Inside Bar Breakout (prev bar inside prev2)
    if (prev.high < prev2.high && prev.low > prev2.low) {
      if (c.close > prev2.high) fired.push({pat: "IB_BULL", dir: "Long"});
      if (c.close < prev2.low)  fired.push({pat: "IB_BEAR", dir: "Short"});
    }

    for (const {pat, dir} of fired) {
      const key = `${pat}_${dir}`;
      if (i - (cooldown[key] ?? -COOL) < COOL) continue;

      const lb = vecMap.get(c.time);
      const vecVote  = lb != null && (dir === "Long" ? c.close > lb : c.close < lb);
      const milkVote = dir === "Long"
        ? (milkBull.has(c.time) && !milkBear.has(c.time))
        : (milkBear.has(c.time) && !milkBull.has(c.time));
      const votes = 1 + (vecVote ? 1 : 0) + (milkVote ? 1 : 0);
      const strength: PatternStrength = votes === 3 ? "strongest" : votes === 2 ? "strong" : "weak";

      const tp1 = dir === "Long" ? c.close + TP_M * atr       : c.close - TP_M * atr;
      const tp2 = dir === "Long" ? c.close + TP_M * 2 * atr   : c.close - TP_M * 2 * atr;
      const sl  = dir === "Long" ? c.close - SL_M * atr       : c.close + SL_M * atr;

      let outcome: "Win"|"Loss"|"Open" = "Open", points: number|null = null;
      for (let j = i + 1; j < sorted.length; j++) {
        const f = sorted[j];
        if (dir === "Long") {
          if (f.high >= tp1) { outcome = "Win";  points = +(TP_M * atr).toFixed(2); break; }
          if (f.low  <= sl)  { outcome = "Loss"; points = -(SL_M * atr).toFixed(2); break; }
        } else {
          if (f.low  <= tp1) { outcome = "Win";  points = +(TP_M * atr).toFixed(2); break; }
          if (f.high >= sl)  { outcome = "Loss"; points = -(SL_M * atr).toFixed(2); break; }
        }
      }

      cooldown[key] = i;
      results.push({time: c.time, price: c.close, direction: dir, pattern: pat, strength, milkVote, vectorVote: vecVote, tp1, tp2, sl, atr, outcome, points});
    }
  }
  return results.sort((a, b) => b.time - a.time);
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default function TimestampsPage() {
  const [selectedSymbol, setSelectedSymbol] = useState("MES");
  const [riskLevel, setRiskLevel]           = useState<RiskLevel>("safe");
  const [filterDir, setFilterDir]           = useState<"all" | "Long" | "Short">("all");
  const [interval, setInterval]             = useState<"1m" | "5m" | "15m" | "60m">("15m");
  const [filterFromDate, setFilterFromDate] = useState("");
  const [minPoints, setMinPoints]           = useState(5);
  const [selectedSignal, setSelectedSignal] = useState<CandleSignal | null>(null);

  // Edit / author mode
  const [editMode, setEditMode]   = useState(false);
  const [learnActive, setLearnActive] = useState(false);
  const [badTrades, setBadTrades] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("mw_bad_trades") || "{}"); } catch { return {}; }
  });

  // AI learning panel state
  const [aiPanelOpen,  setAiPanelOpen]  = useState(false);
  const [aiAnalyzing,  setAiAnalyzing]  = useState(false);
  const [aiLessons,    setAiLessons]    = useState<string>("");
  const [aiSaved,      setAiSaved]      = useState(false);
  const [aiSaveError,  setAiSaveError]  = useState<string>("");

  // Mini chart toggles (start off)
  const [showMilk,   setShowMilk]   = useState(false);
  const [showVec,    setShowVec]    = useState(false);
  const [showSignal, setShowSignal] = useState(true);

  // Pattern tab state
  const [activeTab,          setActiveTab]          = useState<"signals" | "patterns">("signals");
  const [selectedPatternSig, setSelectedPatternSig] = useState<PatternSig | null>(null);
  const [patternStrFilter,   setPatternStrFilter]   = useState<"all" | PatternStrength>("all");
  const [patternDirFilter,   setPatternDirFilter]   = useState<"all" | "Long" | "Short">("all");
  const [patternTypeFilter,  setPatternTypeFilter]  = useState<"all" | PatternType>("all");

  // Persist bad trades to localStorage
  useEffect(() => {
    localStorage.setItem("mw_bad_trades", JSON.stringify(badTrades));
  }, [badTrades]);

  const toggleBad = (time: number) => {
    const key = String(time);
    setBadTrades(prev => {
      const next = { ...prev };
      if (key in next) delete next[key]; else next[key] = "";
      return next;
    });
  };

  const setReason = (time: number, reason: string) => {
    setBadTrades(prev => ({ ...prev, [String(time)]: reason }));
  };

  // ── Data fetch ────────────────────────────────────────────────────────────
  const nowSec        = useMemo(() => Math.floor(Date.now() / 1000), []);
  const fromTs        = useMemo(() => nowSec - 90 * 86400, [nowSec]);
  const toTs          = useMemo(() => nowSec + 3600,        [nowSec]);
  const fetchInterval = interval === "15m" ? "5m" : interval;

  const { data: candleData, isLoading: candlesLoading } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["/api/data/cached-continuous", selectedSymbol, fetchInterval, fromTs, toTs],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${selectedSymbol}/${fetchInterval}?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  const candles = useMemo(() => {
    const raw = candleData?.candles ?? [];
    if (!raw.length || interval === "5m" || interval === "1m" || interval === "60m") return raw;
    const T = 15 * 60;
    const s = [...raw].sort((a, b) => a.time - b.time);
    const result: CandleBar[] = [];
    let bucket: CandleBar | null = null, bucketStart = 0;
    for (const c of s) {
      const aligned = Math.floor(c.time / T) * T;
      if (bucket && bucketStart === aligned) {
        bucket.high   = Math.max(bucket.high, c.high);
        bucket.low    = Math.min(bucket.low, c.low);
        bucket.close  = c.close;
        bucket.volume = (bucket.volume ?? 0) + (c.volume ?? 0);
      } else {
        if (bucket) result.push(bucket);
        bucketStart = aligned;
        bucket = { ...c, time: aligned };
      }
    }
    if (bucket) result.push(bucket);
    return result;
  }, [candleData, interval]);

  // ── Core computation: sorted candles, vector, zones ───────────────────────
  const computedBase = useMemo(() => {
    if (!candles.length) return null;
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const vecMap = computeVectorLine(sorted);
    // RULE (user): milk zones only count when uploaded via PNG. This page has no PNG-upload
    // mechanism, so there are no milk zones here — NEVER synthesize them from candle price
    // action (detectMilkZones). milkBull/milkBear stay empty so no signal reasoning claims
    // milk-zone confluence without an actual upload.
    const milkZones: ZoneBand[] = [];
    const milkBull = new Set<number>();
    const milkBear = new Set<number>();
    return { sorted, vecMap, milkBull, milkBear, milkZones };
  }, [candles]);

  // ── Extra vector maps for mini chart (5m/15m/60m from raw candle data) ───────
  const extraVecMaps = useMemo(() => {
    const raw = candleData?.candles ?? [];
    if (!raw.length) return [];
    const sorted5m = [...raw].sort((a, b) => a.time - b.time);
    const currentSec = fetchInterval === "1m" ? 60 : 300; // raw base resolution
    const INTERVALS: Array<{ sec: number; label: string; color: string }> = [
      { sec: 60,   label: "1m",  color: "#60a5fa" },
      { sec: 300,  label: "5m",  color: "#9ca3af" },
      { sec: 900,  label: "15m", color: "#fbbf24" },
      { sec: 3600, label: "60m", color: "#a855f7" },
    ];
    const chartSec = interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : 3600;
    const result: Array<{ label: string; color: string; map: Map<number, number> }> = [];
    for (const iv of INTERVALS) {
      if (iv.sec === chartSec) continue;  // already shown as main vec
      if (iv.sec < currentSec) continue; // can't go finer than raw data
      const base = iv.sec === currentSec ? sorted5m : aggToInterval(sorted5m, iv.sec);
      if (!base.length) continue;
      const vecMap = computeVectorLine(base);
      result.push({ label: iv.label, color: iv.color, map: vecMap });
    }
    return result;
  }, [candleData, interval, fetchInterval]);

  // ── Compute signals ───────────────────────────────────────────────────────
  const signals = useMemo((): CandleSignal[] => {
    if (!computedBase) return [];
    const { sorted, vecMap, milkBull, milkBear } = computedBase;

    const atrArr = sorted.map((c, i) => {
      let sum = 0;
      const start = Math.max(0, i - ATR_PERIOD + 1);
      for (let j = start; j <= i; j++) {
        const b = sorted[j], prev = j > 0 ? sorted[j - 1] : b;
        sum += Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
      }
      return Math.max(sum / (i - start + 1), 0.25);
    });

    return sorted.map((c, idx) => {
      const vec      = vecSignal(c, vecMap);
      const vecValue = vecMap.get(c.time) ?? null;
      const milk: Direction = milkBull.has(c.time) && !milkBear.has(c.time) ? "Long"
                            : milkBear.has(c.time) && !milkBull.has(c.time) ? "Short"
                            : "Neutral";
      // Slope gate: vector must be moving in the same direction as the signal (matches market.tsx)
      const prevVec = idx >= 3 ? (vecMap.get(sorted[idx - 3].time) ?? null) : null;
      const slopeBlocked = vecValue != null && prevVec != null
        && ((vec === "Long" && vecValue < prevVec) || (vec === "Short" && vecValue > prevVec));
      const raw = buildConfluence(vec, milk);
      const { level, pct, final: rawFinal, longCount, shortCount } = raw;
      const final = slopeBlocked ? "No Trade" : rawFinal;

      const atr = atrArr[idx];
      let outcome: "Win" | "Loss" | "--" = "--";
      let points: number | null = null;
      if (final !== "No Trade") {
        const isLong = final.includes("Long");
        const tp = isLong ? c.close + TP_ATR_MULT * atr : c.close - TP_ATR_MULT * atr;
        const sl = isLong ? c.close - SL_ATR_MULT * atr : c.close + SL_ATR_MULT * atr;
        const tpPts = +(TP_ATR_MULT * atr).toFixed(2);
        const slPts = +(SL_ATR_MULT * atr).toFixed(2);
        for (let j = idx + 1; j < sorted.length; j++) {
          const f = sorted[j];
          if (isLong) { if (f.high >= tp) { outcome = "Win";  points =  tpPts; break; } if (f.low  <= sl) { outcome = "Loss"; points = -slPts; break; } }
          else        { if (f.low  <= tp) { outcome = "Win";  points =  tpPts; break; } if (f.high >= sl) { outcome = "Loss"; points = -slPts; break; } }
        }
      }

      const base = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, vecSignal: vec, vecValue, milkZoneDir: milk, confluence: level, confluencePct: pct, finalSignal: final, longCount, shortCount, outcome, points };
      const explanation = final !== "No Trade" ? buildSignalExplanation(base, sorted, idx, atr) : "";
      return { ...base, explanation, atr };
    });
  }, [computedBase]);

  // ── Compute tp1/tp2/sl/toTime for the selected signal (used by mini chart) ─
  const selectedSignalFull = useMemo(() => {
    if (!selectedSignal || !computedBase) return null;
    const isLong = selectedSignal.finalSignal.includes("Long");
    const atr    = selectedSignal.atr;
    const price  = selectedSignal.close;
    const tp1 = isLong ? price + 1.0 * atr : price - 1.0 * atr;
    const tp2 = isLong ? price + 2.0 * atr : price - 2.0 * atr;
    const sl  = isLong ? price - 0.5 * atr : price + 0.5 * atr;
    const sorted = computedBase.sorted;
    const sigIdx = sorted.findIndex((c: { time: number }) => c.time === selectedSignal.time);
    let toTime = sorted.length > 0 ? sorted[sorted.length - 1].time : selectedSignal.time;
    if (sigIdx >= 0) {
      for (let j = sigIdx + 1; j < sorted.length; j++) {
        const c = sorted[j] as { high: number; low: number; time: number };
        if (isLong ? (c.high >= tp1 || c.low <= sl) : (c.low <= tp1 || c.high >= sl)) {
          toTime = c.time; break;
        }
      }
    }
    return { time: selectedSignal.time, direction: isLong ? "Long" as const : "Short" as const, price, atr, tp1, tp2, sl, toTime };
  }, [selectedSignal, computedBase]);

  // ── Filter helpers ────────────────────────────────────────────────────────
  const filterFromTs = useMemo(() =>
    filterFromDate ? Math.floor(new Date(filterFromDate + "T00:00:00Z").getTime() / 1000) : 0,
    [filterFromDate]);

  // ── Pattern signals ───────────────────────────────────────────────────────
  const patternSignals = useMemo((): PatternSig[] => {
    if (!computedBase) return [];
    return computePatternSignals(computedBase.sorted, computedBase.vecMap, computedBase.milkBull, computedBase.milkBear);
  }, [computedBase]);

  const filteredPatterns = useMemo(() => patternSignals.filter(s => {
    if (patternStrFilter  !== "all" && s.strength  !== patternStrFilter)  return false;
    if (patternDirFilter  !== "all" && s.direction !== patternDirFilter)  return false;
    if (patternTypeFilter !== "all" && s.pattern   !== patternTypeFilter) return false;
    if (filterFromTs > 0 && s.time < filterFromTs) return false;
    return true;
  }), [patternSignals, patternStrFilter, patternDirFilter, patternTypeFilter, filterFromTs]);

  const patternStats = useMemo(() => {
    const statOf = (list: PatternSig[]) => {
      const d = list.filter(s => s.outcome !== "Open");
      const wins = d.filter(s => s.outcome === "Win").length;
      const pts  = d.reduce((a, s) => a + (s.points ?? 0), 0);
      return { count: list.length, decided: d.length, wr: d.length ? Math.round(wins / d.length * 100) : null, pts };
    };
    const byStr = {
      strongest: statOf(patternSignals.filter(s => s.strength === "strongest")),
      strong:    statOf(patternSignals.filter(s => s.strength === "strong")),
      weak:      statOf(patternSignals.filter(s => s.strength === "weak")),
    };
    const byPat: Partial<Record<PatternType, ReturnType<typeof statOf>>> = {};
    for (const pt of Object.keys(PATTERN_LABELS) as PatternType[])
      byPat[pt] = statOf(patternSignals.filter(s => s.pattern === pt));
    return { overall: statOf(patternSignals), byStr, byPat };
  }, [patternSignals]);

  // Mini-chart signal shape for a selected pattern signal
  const patternSelectedFull = useMemo(() => {
    if (!selectedPatternSig || !computedBase) return null;
    const s = selectedPatternSig;
    const sorted = computedBase.sorted;
    const sigIdx = sorted.findIndex(c => c.time === s.time);
    let toTime = sorted.length ? sorted[sorted.length - 1].time : s.time;
    if (sigIdx >= 0) {
      for (let j = sigIdx + 1; j < sorted.length; j++) {
        const c = sorted[j] as {high: number; low: number; time: number};
        if (s.direction === "Long" ? (c.high >= s.tp1 || c.low <= s.sl) : (c.low <= s.tp1 || c.high >= s.sl)) {
          toTime = c.time; break;
        }
      }
    }
    return { time: s.time, direction: s.direction, price: s.price, atr: s.atr, tp1: s.tp1, tp2: s.tp2, sl: s.sl, toTime };
  }, [selectedPatternSig, computedBase]);

  // ── Risk meter ────────────────────────────────────────────────────────────
  const riskStats = useMemo(() => {
    const base = signals.filter(s => {
      if (filterFromTs > 0 && s.time < filterFromTs) return false;
      if (filterDir === "Long"  && s.longCount  < 1) return false;
      if (filterDir === "Short" && s.shortCount < 1) return false;
      if (s.points !== null && Math.abs(s.points) < minPoints) return false;
      return true;
    });
    const totalRTH = base.filter(s => isRTH(s.time) && s.finalSignal !== "No Trade").length;
    const compute = (level: RiskLevel) => {
      const q = base.filter(s => qualifiesForRisk(s, level));
      const decided = q.filter(s => s.outcome !== "--");
      const wins    = decided.filter(s => s.outcome === "Win").length;
      const wr      = decided.length > 0 ? (wins / decided.length) * 100 : null;
      const totalPts = decided.reduce((a, s) => a + (s.points ?? 0), 0);
      const avgPts   = decided.length > 0 ? totalPts / decided.length : null;
      const days = new Set(q.map(s => { const d = new Date(s.time * 1000); return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; }));
      const daysActive = days.size;
      const perDay = daysActive > 0 ? q.length / daysActive : 0;
      const pctOfAll = totalRTH > 0 ? Math.round((q.length / totalRTH) * 100) : 0;
      let rec = "—";
      if (wr !== null) {
        if (wr >= 63) rec = `Take all · ${perDay.toFixed(1)}/day`;
        else if (wr >= 53) rec = `Best ${Math.max(1, Math.round(perDay * 0.55)).toFixed(0)}/day`;
        else if (wr >= 45) rec = "1 per day max";
        else rec = "Paper trade only";
      }
      return { count: q.length, decidedCount: decided.length, wr, totalPts, avgPts, perDay, pctOfAll, rec };
    };
    return { safe: compute("safe"), risky: compute("risky"), riskiest: compute("riskiest") };
  }, [signals, filterFromTs, filterDir, minPoints]);

  // ── Base filtered (used when learnings not active) ────────────────────────
  const filtered = useMemo(() =>
    signals.filter(s => {
      if (!qualifiesForRisk(s, riskLevel)) return false;
      if (filterFromTs > 0 && s.time < filterFromTs) return false;
      if (filterDir === "Long"  && s.longCount  < 1) return false;
      if (filterDir === "Short" && s.shortCount < 1) return false;
      if (s.points !== null && Math.abs(s.points) < minPoints) return false;
      return true;
    }).reverse(),
    [signals, riskLevel, filterDir, filterFromTs, minPoints]);

  // ── Bad signals for analysis ──────────────────────────────────────────────
  const badSignalsData = useMemo(() =>
    filtered
      .filter(s => String(s.time) in badTrades)
      .map(s => ({ ...s, reason: badTrades[String(s.time)] })),
    [filtered, badTrades]);

  // ── Learned filters (computed when learnActive) ───────────────────────────
  const learnedFilters = useMemo((): LearnedFilters | null => {
    if (!learnActive || !badSignalsData.length) return null;
    return deriveFilters(badSignalsData);
  }, [learnActive, badSignalsData]);

  // ── Load existing LEARNINGS.md content ────────────────────────────────────
  const { data: learningsData } = useQuery<{ content: string }>({
    queryKey: ["/api/learnings"],
    queryFn: () => fetch("/api/learnings").then(r => r.json()),
    staleTime: 60_000,
  });

  // ── Build per-hour win stats for AI analysis ───────────────────────────────
  const hourlyStats = useMemo(() => {
    const buckets: Record<string, { wins: number; total: number; label: string }> = {};
    for (const s of filtered) {
      if (s.outcome === "--") continue;
      const d = new Date(s.time * 1000);
      const etHour = ((d.getUTCHours() - 4 + 24) % 24); // ET offset (approx)
      const label = `${etHour}:00-${etHour+1}:00 ET`;
      if (!buckets[label]) buckets[label] = { wins: 0, total: 0, label };
      buckets[label].total++;
      if (s.outcome === "Win") buckets[label].wins++;
    }
    return Object.values(buckets).sort((a, b) => a.label.localeCompare(b.label));
  }, [filtered]);

  // ── AI analysis function ──────────────────────────────────────────────────
  async function runAiAnalysis() {
    if (aiAnalyzing) return;
    setAiAnalyzing(true);
    setAiLessons("");
    setAiSaved(false);
    setAiSaveError("");
    try {
      const allDecided  = filtered.filter(s => s.outcome !== "--");
      const recentSlice = allDecided.slice(-20);
      const recentWins  = recentSlice.filter(s => s.outcome === "Win").length;

      const bySession = {
        rth: { wins: 0, total: 0 },
        eth: { wins: 0, total: 0 },
      };
      const byDir   = { long: { wins: 0, total: 0 }, short: { wins: 0, total: 0 } };
      const byConf  = { two:  { wins: 0, total: 0 }, one:   { wins: 0, total: 0 } };

      for (const s of allDecided) {
        const win = s.outcome === "Win";
        const sess = isRTH(s.time) ? bySession.rth : bySession.eth;
        sess.total++; if (win) sess.wins++;
        const dir = s.finalSignal.includes("Long") ? byDir.long : byDir.short;
        dir.total++; if (win) dir.wins++;
        const conf = s.confluence === "2/2" ? byConf.two : byConf.one;
        conf.total++; if (win) conf.wins++;
      }

      const payload = {
        symbol: selectedSymbol,
        interval,
        riskLevel,
        totalSignals: filteredFinal.length,
        decidedCount: allDecided.length,
        winRate: allDecided.length > 0 ? Math.round(allDecided.filter(s => s.outcome === "Win").length / allDecided.length * 100) : null,
        totalPts: allDecided.reduce((s, c) => s + (c.points ?? 0), 0),
        bySession,
        byDirection: byDir,
        byConfluence: byConf,
        byHour: hourlyStats,
        badTrades: badSignalsData.map(s => ({
          time: s.time,
          conditions: `${new Date(s.time*1000).toISOString().slice(0,16)} ${s.finalSignal} ${s.confluence} ATR=${s.atr.toFixed(1)}`,
          reason: s.reason,
        })),
        recentWinRate: recentSlice.length > 0 ? Math.round(recentWins / recentSlice.length * 100) : null,
        existingLessons: learningsData?.content
          ? learningsData.content.split("## Session Log")[0].slice(0, 2000)
          : "",
      };

      const r = await fetch("/api/ai/analyze-trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const ct = r.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const data = await r.json();
          throw new Error(data.error ?? "Analysis failed");
        }
        throw new Error(`Server error (${r.status}) — check ANTHROPIC_API_KEY in .env`);
      }
      const data = await r.json();
      setAiLessons(data.lessons);
    } catch (e: any) {
      setAiLessons(`Error: ${e.message}`);
    } finally {
      setAiAnalyzing(false);
    }
  }

  async function saveAiLessons() {
    if (!aiLessons) return;
    setAiSaved(false);
    setAiSaveError("");
    try {
      const r = await fetch("/api/learnings/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry: aiLessons }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      setAiSaved(true);
    } catch (e: any) {
      setAiSaveError(e.message);
    }
  }

  // ── Final filtered list ───────────────────────────────────────────────────
  const filteredFinal = useMemo(() => {
    if (!learnedFilters) return filtered;
    return signals.filter(s => {
      if (!qualifiesWithLearnings(s, riskLevel, learnedFilters)) return false;
      if (filterFromTs > 0 && s.time < filterFromTs) return false;
      if (filterDir === "Long"  && s.longCount  < 1) return false;
      if (filterDir === "Short" && s.shortCount < 1) return false;
      if (s.points !== null && Math.abs(s.points) < minPoints) return false;
      return true;
    }).reverse();
  }, [learnedFilters, filtered, signals, riskLevel, filterFromTs, filterDir, minPoints]);

  // ── Summary stats ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const high  = filteredFinal.filter(s => s.confluence === "2/2").length;
    const med   = filteredFinal.filter(s => s.confluence === "1/2").length;
    const longs = filteredFinal.filter(s => s.longCount >= 1).length;
    const shorts = filteredFinal.filter(s => s.shortCount >= 1).length;
    const decided    = filteredFinal.filter(s => s.outcome !== "--");
    const wins       = decided.filter(s => s.outcome === "Win").length;
    const winRate    = decided.length > 0 ? Math.round((wins / decided.length) * 100) : null;
    const totalPts   = decided.reduce((sum, s) => sum + (s.points ?? 0), 0);
    return { high, med, longs, shorts, total: filteredFinal.length, winRate, decidedCount: decided.length, totalPts };
  }, [filteredFinal]);

  const badCount = Object.keys(badTrades).length;

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: MW.bg, color: MW.text, fontFamily: "'Trebuchet MS', sans-serif" }}>

      {/* Header */}
      <header className="flex items-center gap-3 px-4 flex-shrink-0"
        style={{ height: 44, background: MW.toolbar, borderBottom: `1px solid ${MW.border}` }}>
        <Link href="/">
          <button className="flex items-center gap-1.5 text-xs" style={{ color: MW.muted, cursor: "pointer", background: "transparent", border: "none" }}>
            <ChevronLeft className="w-3.5 h-3.5" /> Chart
          </button>
        </Link>
        <div style={{ width: 1, height: 16, background: MW.border }} />
        <BarChart3 style={{ color: MW.accent }} className="w-4 h-4" />
        <span style={{ fontSize: 13, fontWeight: 700, color: MW.text }}>Timestamps — Confluence Signals</span>
        <div className="flex-1" />

        {/* Edit mode toggle */}
        <button
          onClick={() => { setEditMode(e => !e); if (!editMode) setLearnActive(false); }}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600,
            background: editMode ? "#1a72d420" : "transparent",
            border: `1px solid ${editMode ? MW.accent : MW.border}`,
            color: editMode ? MW.accent : MW.muted, cursor: "pointer",
          }}
        >
          <Pencil className="w-3 h-3" />
          {editMode ? "Editing" : "Edit Mode"}
        </button>

        {/* Analyze button (only when edit mode + bad trades exist) */}
        {editMode && badCount > 0 && (
          <button
            onClick={() => setLearnActive(la => !la)}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600,
              background: learnActive ? "#8b5cf620" : "#f59e0b15",
              border: `1px solid ${learnActive ? "#8b5cf6" : "#f59e0b"}`,
              color: learnActive ? "#8b5cf6" : "#f59e0b", cursor: "pointer",
            }}
          >
            <Zap className="w-3 h-3" />
            {learnActive ? "Rework Active" : `Rework (${badCount} bad)`}
          </button>
        )}

        {/* AI Brain button — always visible */}
        <button
          onClick={() => { setAiPanelOpen(o => !o); setAiSaved(false); setAiSaveError(""); }}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600,
            background: aiPanelOpen ? "#22d3ee20" : "transparent",
            border: `1px solid ${aiPanelOpen ? "#22d3ee" : MW.border}`,
            color: aiPanelOpen ? "#22d3ee" : MW.muted, cursor: "pointer",
          }}
          title="AI Trade Analysis — analyze patterns and save to LEARNINGS.md"
        >
          <Brain className="w-3 h-3" />
          AI Brain
        </button>

        {/* Symbol */}
        <select value={selectedSymbol} onChange={e => setSelectedSymbol(e.target.value)}
          style={{ background: MW.panel, border: `1px solid ${MW.border}`, color: MW.text, fontSize: 12, padding: "2px 8px", borderRadius: 4, cursor: "pointer" }}>
          {["MES","ES","MNQ","NQ","SPY","QQQ"].map(s => <option key={s}>{s}</option>)}
        </select>

        {/* Interval tabs */}
        <div style={{ display: "flex", gap: 2 }}>
          {(["1m","5m","15m","60m"] as const).map(iv => (
            <button key={iv} onClick={() => setInterval(iv)} style={{
              padding: "0 10px", height: 28, fontSize: 11,
              fontWeight: interval === iv ? 700 : 400, borderRadius: 4,
              background: interval === iv ? "rgba(26,114,212,0.2)" : "transparent",
              color: interval === iv ? "#1a72d4" : MW.muted,
              border: `1px solid ${interval === iv ? "rgba(26,114,212,0.5)" : MW.border}`,
              cursor: "pointer",
            }}>{iv}</button>
          ))}
        </div>
      </header>

      {/* Risk Meter */}
      <div className="flex flex-shrink-0" style={{ borderBottom: `1px solid ${MW.border}` }}>
        {(["safe", "risky", "riskiest"] as RiskLevel[]).map((level, idx) => {
          const rs = riskStats[level];
          const active = riskLevel === level;
          const color  = level === "safe" ? "#26c87a" : level === "risky" ? "#f59e0b" : "#ef5350";
          const label  = level === "safe" ? "SAFE" : level === "risky" ? "RISKY" : "RISKIEST";
          const desc   = level === "safe" ? "2/2+body (RTH) · Vec side-entry tight (ETH)" : level === "risky" ? "2/2 (RTH) · Vec side-entry (ETH)" : "≥1/2 (RTH) · Vec wide-entry (ETH)";
          return (
            <button key={level} onClick={() => setRiskLevel(level)} style={{
              flex: 1, background: active ? `${color}10` : MW.bg,
              border: "none", borderRight: idx < 2 ? `1px solid ${MW.border}` : "none",
              borderBottom: active ? `2px solid ${color}` : `2px solid transparent`,
              padding: "9px 16px", cursor: "pointer", textAlign: "left", color: MW.text,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: "0.08em" }}>{label}</span>
                <span style={{ fontSize: 10, color: MW.muted }}>{desc}</span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: MW.muted }}>{rs.pctOfAll}% of RTH signals</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 12 }}>
                <span>Win Rate: <b style={{ color: rs.wr == null ? MW.muted : rs.wr >= 60 ? "#26c87a" : rs.wr >= 50 ? "#f59e0b" : "#ef5350" }}>{rs.wr == null ? "—" : `${Math.round(rs.wr)}%`}</b>{rs.decidedCount > 0 && <span style={{ color: MW.muted, fontSize: 10 }}> ({rs.decidedCount})</span>}</span>
                <span style={{ color: MW.muted }}>{rs.count} trades · {rs.perDay.toFixed(1)}/day</span>
                <span style={{ color: rs.totalPts >= 0 ? "#26c87a" : "#ef5350" }}>P&L: <b>{rs.totalPts >= 0 ? "+" : ""}{rs.totalPts.toFixed(1)} pts</b></span>
                <span>Avg: <b style={{ color: rs.avgPts == null ? MW.muted : rs.avgPts >= 0 ? "#a3e8c4" : "#f49c9a" }}>{rs.avgPts == null ? "—" : `${rs.avgPts >= 0 ? "+" : ""}${rs.avgPts.toFixed(1)}`}</b></span>
                <span style={{ marginLeft: "auto", fontSize: 11, color, fontWeight: active ? 700 : 400 }}>Rec: {rs.rec}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Tab switcher ─────────────────────────────────────────────────── */}
      <div className="flex items-center flex-shrink-0" style={{ background: MW.toolbar, borderBottom: `1px solid ${MW.border}` }}>
        {(["signals", "patterns"] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: "8px 20px", fontSize: 11, fontWeight: activeTab === tab ? 700 : 400,
            background: "transparent", border: "none", cursor: "pointer",
            borderBottom: activeTab === tab ? `2px solid ${MW.accent}` : "2px solid transparent",
            color: activeTab === tab ? MW.accent : MW.muted,
          }}>
            {tab === "signals" ? "Confluence Signals" : `Pattern Signals${patternSignals.length ? ` (${patternSignals.length})` : ""}`}
          </button>
        ))}
      </div>

      {/* Learned filters banner */}
      {learnedFilters && (
        <div className="flex flex-shrink-0 flex-wrap gap-2 px-4 py-2 items-start"
          style={{ background: "#8b5cf608", borderBottom: `1px solid #8b5cf620` }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: "#8b5cf6", letterSpacing: "0.08em", marginTop: 2, whiteSpace: "nowrap" }}>
            ⚡ REWORK ACTIVE
          </span>
          <div className="flex flex-wrap gap-2 flex-1">
            {learnedFilters.lessons.map((l, i) => (
              <span key={i} style={{ fontSize: 10, color: "#c4b5fd", background: "#8b5cf610", border: "1px solid #8b5cf630", borderRadius: 3, padding: "2px 8px" }}>
                {l}
              </span>
            ))}
          </div>
          <span style={{ fontSize: 10, color: MW.muted, whiteSpace: "nowrap", marginTop: 2 }}>
            {filtered.length - filteredFinal.length} signals removed · win rate {stats.winRate ?? "—"}%
          </span>
        </div>
      )}

      {/* ── AI Brain Panel ──────────────────────────────────────────────────── */}
      {aiPanelOpen && (
        <div className="flex-shrink-0" style={{ background: "#0a1520", borderBottom: `1px solid #22d3ee30`, maxHeight: 420, overflowY: "auto" }}>
          <div className="flex items-center gap-3 px-4 py-2" style={{ borderBottom: `1px solid #22d3ee20` }}>
            <Brain className="w-4 h-4" style={{ color: "#22d3ee" }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: "#22d3ee", letterSpacing: "0.05em" }}>AI TRADE BRAIN</span>
            <span style={{ fontSize: 10, color: MW.muted, marginLeft: 4 }}>
              Analyzes your signal history and saves patterns to LEARNINGS.md
            </span>
            <div className="flex-1" />
            <button
              onClick={runAiAnalysis}
              disabled={aiAnalyzing}
              style={{
                display: "flex", alignItems: "center", gap: 5, padding: "4px 12px",
                borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: aiAnalyzing ? "not-allowed" : "pointer",
                background: aiAnalyzing ? "#22d3ee15" : "#22d3ee25",
                border: `1px solid ${aiAnalyzing ? "#22d3ee30" : "#22d3ee"}`,
                color: aiAnalyzing ? "#22d3ee80" : "#22d3ee",
              }}
            >
              {aiAnalyzing ? (
                <><span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span> Analyzing…</>
              ) : (
                <><Brain className="w-3 h-3" /> Analyze {filteredFinal.length} signals</>
              )}
            </button>
            {aiLessons && !aiSaved && (
              <button
                onClick={saveAiLessons}
                style={{
                  display: "flex", alignItems: "center", gap: 5, padding: "4px 12px",
                  borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer",
                  background: "#26c87a20", border: `1px solid #26c87a`, color: "#26c87a",
                }}
              >
                <Save className="w-3 h-3" /> Save to LEARNINGS.md
              </button>
            )}
            {aiSaved && <span style={{ fontSize: 11, color: "#26c87a", fontWeight: 600 }}>✓ Saved to LEARNINGS.md</span>}
            {aiSaveError && <span style={{ fontSize: 11, color: "#ef5350" }}>{aiSaveError}</span>}
          </div>

          {/* AI output */}
          {aiLessons ? (
            <div style={{ padding: "12px 16px" }}>
              <div style={{ fontSize: 10, color: "#22d3ee80", fontWeight: 700, marginBottom: 8, letterSpacing: "0.06em" }}>
                AI FINDINGS — {new Date().toLocaleDateString()} · {selectedSymbol} {interval} {riskLevel}
              </div>
              <pre style={{ fontSize: 11, color: "#c8d8e8", lineHeight: 1.7, whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0 }}>
                {aiLessons}
              </pre>
            </div>
          ) : (
            <div style={{ padding: "12px 16px" }}>
              {/* Existing learnings preview */}
              {learningsData?.content ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <BookOpen className="w-3.5 h-3.5" style={{ color: "#a855f7" }} />
                    <span style={{ fontSize: 10, color: "#a855f7", fontWeight: 700, letterSpacing: "0.06em" }}>CURRENT LEARNINGS.MD</span>
                  </div>
                  <pre style={{ fontSize: 10, color: "#8090a8", lineHeight: 1.6, whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0, maxHeight: 200, overflowY: "auto" }}>
                    {learningsData.content.length > 1500 ? learningsData.content.slice(0, 1500) + "\n…" : learningsData.content}
                  </pre>
                  <div style={{ marginTop: 10, fontSize: 10, color: MW.muted }}>
                    Click "Analyze {filteredFinal.length} signals" to run AI analysis on current data and update learnings.
                  </div>
                </>
              ) : (
                <span style={{ fontSize: 11, color: MW.muted }}>
                  Click "Analyze {filteredFinal.length} signals" to have Claude AI find patterns in your trade history and write them to LEARNINGS.md.
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === "signals" && (<>
      {/* Summary bar */}
      <div className="flex items-center gap-6 px-4 flex-shrink-0"
        style={{ height: 36, background: MW.panel, borderBottom: `1px solid ${MW.border}`, fontSize: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>
          Win Rate: <b style={{ color: stats.winRate == null ? MW.muted : stats.winRate >= 55 ? "#26c87a" : stats.winRate >= 45 ? "#f59e0b" : "#ef5350", fontSize: 14 }}>{stats.winRate == null ? "—" : `${stats.winRate}%`}</b>
          {stats.decidedCount > 0 && <span style={{ color: MW.muted, fontSize: 10, fontWeight: 400 }}> ({stats.decidedCount} trades)</span>}
        </span>
        <div style={{ width: 1, height: 18, background: MW.border }} />
        <span style={{ fontWeight: 700, fontSize: 13 }}>
          Total P&L: <b style={{ fontSize: 14, color: stats.decidedCount === 0 ? MW.muted : stats.totalPts >= 0 ? "#26c87a" : "#ef5350" }}>{stats.decidedCount === 0 ? "—" : `${stats.totalPts >= 0 ? "+" : ""}${stats.totalPts.toFixed(2)} pts`}</b>
        </span>
        <div style={{ width: 1, height: 18, background: MW.border }} />
        <span style={{ color: MW.muted }}>Total: <b style={{ color: MW.text }}>{stats.total}</b></span>
        <span style={{ color: "#26c87a" }}>2/2: <b>{stats.high}</b></span>
        <span style={{ color: "#9ca3af" }}>1/2: <b style={{ color: MW.text }}>{stats.med}</b></span>
        <span style={{ color: "#26c87a" }}>▲ Long: <b>{stats.longs}</b></span>
        <span style={{ color: "#ef5350" }}>▼ Short: <b>{stats.shorts}</b></span>
        {editMode && badCount > 0 && (
          <span style={{ color: "#ef5350", fontSize: 11 }}>
            ✗ <b>{badCount}</b> marked bad
          </span>
        )}
        <div className="flex-1" />
        <Filter className="w-3 h-3" style={{ color: MW.muted }} />
        <span style={{ color: MW.muted, fontSize: 11 }}>From:</span>
        <input type="date" value={filterFromDate} onChange={e => setFilterFromDate(e.target.value)}
          style={{ background: MW.toolbar, border: `1px solid ${MW.border}`, color: MW.text, fontSize: 11, padding: "2px 6px", borderRadius: 3, cursor: "pointer", colorScheme: "dark" }} />
        {filterFromDate && (
          <button onClick={() => setFilterFromDate("")}
            style={{ background: "transparent", border: "none", color: MW.muted, cursor: "pointer", fontSize: 12, padding: "0 2px" }}>✕</button>
        )}
        <div style={{ width: 1, height: 14, background: MW.border }} />
        <span style={{ color: MW.muted, fontSize: 11 }}>Direction:</span>
        <select value={filterDir} onChange={e => setFilterDir(e.target.value as any)}
          style={{ background: MW.toolbar, border: `1px solid ${MW.border}`, color: MW.text, fontSize: 11, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}>
          <option value="all">All</option><option value="Long">Long only</option><option value="Short">Short only</option>
        </select>
        <span style={{ color: MW.muted, fontSize: 11 }}>Min pts:</span>
        <select value={minPoints} onChange={e => setMinPoints(Number(e.target.value))}
          style={{ background: MW.toolbar, border: `1px solid ${MW.border}`, color: MW.text, fontSize: 11, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}>
          {[0,3,5,8,10,15,20].map(v => <option key={v} value={v}>{v === 0 ? "Any" : `≥${v}`}</option>)}
        </select>
        <span style={{ color: MW.muted, fontSize: 11 }}>Showing: <b style={{ color: MW.text }}>{filteredFinal.length}</b></span>
      </div>

      {/* Content */}
      <div className="flex flex-1 min-h-0">

        {/* Table */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {/* Headers */}
          <div className="flex-shrink-0 grid" style={{
            gridTemplateColumns: "160px 80px 110px 110px 110px 140px 70px 70px",
            background: MW.toolbar, borderBottom: `1px solid ${MW.border}`,
            padding: "0 16px", height: 28, alignItems: "center",
            fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: MW.muted,
          }}>
            <span>Timestamp (ET)</span><span>Price</span><span>Vector</span>
            <span>Milk Zone</span><span>Confluence</span><span>Final Signal</span>
            <span>Outcome</span><span>Points</span>
          </div>

          {/* Rows */}
          <div className="flex-1 overflow-y-auto">
            {candlesLoading ? (
              <div className="flex items-center justify-center h-full" style={{ color: MW.muted }}>
                <div className="flex flex-col items-center gap-3">
                  <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: `${MW.accent} transparent transparent transparent` }} />
                  <span className="text-sm">Computing signals...</span>
                </div>
              </div>
            ) : filteredFinal.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <span style={{ color: MW.muted, fontSize: 13 }}>No signals found.</span>
              </div>
            ) : (
              filteredFinal.map((s, i) => {
                const isSelected = selectedSignal?.time === s.time;
                const isBad      = editMode && String(s.time) in badTrades;
                return (
                  <div key={s.time} className="grid"
                    onClick={() => setSelectedSignal(isSelected ? null : s)}
                    style={{
                      gridTemplateColumns: "160px 80px 110px 110px 110px 140px 70px 70px",
                      padding: "0 16px", height: 32, alignItems: "center",
                      background: isSelected ? `${MW.accent}22` : isBad ? "#ef535012" : i % 2 === 0 ? "transparent" : MW.panel + "88",
                      borderBottom: `1px solid ${isSelected ? MW.accent + "66" : MW.border + "33"}`,
                      borderLeft: isSelected ? `2px solid ${MW.accent}` : isBad ? "2px solid #ef535066" : "2px solid transparent",
                      fontSize: 12, cursor: "pointer",
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = `${MW.border}88`; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = isBad ? "#ef535012" : i % 2 === 0 ? "transparent" : MW.panel + "88"; }}
                  >
                    <span style={{ color: MW.muted, fontFamily: "monospace" }}>
                      {isBad && <span style={{ color: "#ef5350", marginRight: 4 }}>✗</span>}
                      {fmtTs(s.time)}
                    </span>
                    <span style={{ color: s.close >= s.open ? "#26c87a" : "#ef5350", fontWeight: 600 }}>{s.close.toFixed(2)}</span>
                    <span style={{ color: dirColor(s.vecSignal), fontWeight: s.vecSignal !== "Neutral" ? 600 : 400 }}>
                      {s.vecSignal === "Long" ? "▲ Long" : s.vecSignal === "Short" ? "▼ Short" : "— Neutral"}
                    </span>
                    <span style={{ color: dirColor(s.milkZoneDir), fontWeight: s.milkZoneDir !== "Neutral" ? 600 : 400 }}>
                      {s.milkZoneDir === "Long" ? "▲ Long" : s.milkZoneDir === "Short" ? "▼ Short" : "— Neutral"}
                    </span>
                    <span style={{ color: s.confluence === "2/2" ? "#26c87a" : s.confluence === "1/2" ? "#f59e0b" : MW.muted, fontWeight: s.confluence !== "0/2" ? 700 : 400 }}>
                      {s.confluence} ({s.confluencePct}%)
                    </span>
                    <span style={{ color: finalColor(s.finalSignal), fontWeight: s.finalSignal.includes("Strong") ? 700 : 400 }}>
                      {s.finalSignal}
                    </span>
                    <span style={{ color: s.outcome === "Win" ? "#26c87a" : s.outcome === "Loss" ? "#ef5350" : MW.muted, fontWeight: s.outcome !== "--" ? 700 : 400 }}>
                      {s.outcome === "Win" ? "✓ Win" : s.outcome === "Loss" ? "✗ Loss" : "—"}
                    </span>
                    <span style={{ color: s.points == null ? MW.muted : s.points >= 0 ? "#26c87a" : "#ef5350", fontWeight: s.points != null ? 700 : 400, fontFamily: "monospace" }}>
                      {s.points == null ? "—" : `${s.points >= 0 ? "+" : ""}${s.points.toFixed(2)}`}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Side panel */}
        {selectedSignal && computedBase && (
          <div className="flex flex-col flex-shrink-0" style={{ width: 380, borderLeft: `1px solid ${MW.border}`, background: MW.panel }}>

            {/* Panel header */}
            <div className="flex items-center justify-between px-3 py-2 flex-shrink-0"
              style={{ borderBottom: `1px solid ${MW.border}` }}>
              <div>
                <span style={{ fontSize: 11, fontWeight: 700, color: MW.text }}>Trade Reasoning</span>
                <span style={{ marginLeft: 8, fontSize: 10, color: MW.muted }}>{fmtTs(selectedSignal.time)}</span>
              </div>
              <button onClick={() => setSelectedSignal(null)}
                style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
            </div>

            {/* Direction + outcome */}
            <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0" style={{ borderBottom: `1px solid ${MW.border}` }}>
              <span style={{ padding: "2px 10px", borderRadius: 3, fontSize: 12, fontWeight: 700,
                background: selectedSignal.finalSignal.includes("Long") ? "#26c87a22" : "#ef535022",
                color: selectedSignal.finalSignal.includes("Long") ? "#26c87a" : "#ef5350",
                border: `1px solid ${selectedSignal.finalSignal.includes("Long") ? "#26c87a55" : "#ef535055"}`,
              }}>
                {selectedSignal.finalSignal.includes("Long") ? "▲ LONG" : "▼ SHORT"}
              </span>
              <span style={{ padding: "2px 8px", borderRadius: 3, fontSize: 11,
                background: selectedSignal.outcome === "Win" ? "#26c87a22" : selectedSignal.outcome === "Loss" ? "#ef535022" : `${MW.border}44`,
                color: selectedSignal.outcome === "Win" ? "#26c87a" : selectedSignal.outcome === "Loss" ? "#ef5350" : MW.muted,
              }}>
                {selectedSignal.outcome === "Win" ? "✓ Win" : selectedSignal.outcome === "Loss" ? "✗ Loss" : "Open"}
              </span>
              {selectedSignal.points != null && (
                <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, fontFamily: "monospace",
                  color: selectedSignal.points >= 0 ? "#26c87a" : "#ef5350" }}>
                  {selectedSignal.points >= 0 ? "+" : ""}{selectedSignal.points.toFixed(2)} pts
                </span>
              )}
            </div>

            {/* Mini chart */}
            <div className="flex-shrink-0" style={{ borderBottom: `1px solid ${MW.border}` }}>
              {selectedSignalFull && (
              <SignalMiniChart
                candles={computedBase.sorted}
                signal={selectedSignalFull}
                zones={showMilk ? computedBase.milkZones : []}
                vecMap={computedBase.vecMap}
                extraVecMaps={showVec ? extraVecMaps : []}
                showVec={showVec}
                showMilk={showMilk}
                showSignalMark={showSignal}
                height={220}
              />
              )}
            </div>

            {/* M / V toggles */}
            <div className="flex items-center gap-2 px-3 flex-shrink-0"
              style={{ height: 36, borderBottom: `1px solid ${MW.border}` }}>
              <span style={{ fontSize: 10, color: MW.muted, marginRight: 4 }}>Overlay:</span>
              {/* M toggle */}
              <button onClick={() => setShowMilk(v => !v)} style={{
                width: 28, height: 22, borderRadius: 4, fontSize: 11, fontWeight: 800,
                background: showMilk ? "#26c87a20" : MW.toolbar,
                border: `1px solid ${showMilk ? "#26c87a" : MW.border}`,
                color: showMilk ? "#26c87a" : MW.muted,
                cursor: "pointer",
              }}>M</button>
              <span style={{ fontSize: 9, color: MW.muted }}>Milk Zones</span>
              <div style={{ width: 1, height: 14, background: MW.border, margin: "0 4px" }} />
              {/* V toggle */}
              <button onClick={() => setShowVec(v => !v)} style={{
                width: 28, height: 22, borderRadius: 4, fontSize: 11, fontWeight: 800,
                background: showVec ? "#00b4d820" : MW.toolbar,
                border: `1px solid ${showVec ? "#00b4d8" : MW.border}`,
                color: showVec ? "#00b4d8" : MW.muted,
                cursor: "pointer",
              }}>V</button>
              <span style={{ fontSize: 9, color: MW.muted }}>Vector</span>
              <div style={{ width: 1, height: 14, background: MW.border, margin: "0 4px" }} />
              {/* S toggle */}
              <button onClick={() => setShowSignal(v => !v)} style={{
                width: 28, height: 22, borderRadius: 4, fontSize: 11, fontWeight: 800,
                background: showSignal ? "#f59e0b20" : MW.toolbar,
                border: `1px solid ${showSignal ? "#f59e0b" : MW.border}`,
                color: showSignal ? "#f59e0b" : MW.muted,
                cursor: "pointer",
              }}>S</button>
              <span style={{ fontSize: 9, color: MW.muted }}>Signal</span>
              <div className="flex-1" />
              {showMilk && (
                <div className="flex items-center gap-2" style={{ fontSize: 9, color: MW.muted }}>
                  <span style={{ display: "inline-block", width: 8, height: 8, background: "#22c55e" }} /> FVG
                  <span style={{ display: "inline-block", width: 8, height: 8, background: "#3b82f6" }} /> OB
                  <span style={{ display: "inline-block", width: 8, height: 8, background: "#f43f5e" }} /> Struct
                </div>
              )}
            </div>

            {/* Explanation (scrollable) */}
            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-col gap-0 px-3 py-2">
                {selectedSignal.explanation.split("|").map((line, li) => {
                  const isPatternLine = line.includes("similar") || line.includes("resolved");
                  const isConditionLine = li === 0;
                  return (
                    <div key={li} style={{ padding: "6px 0", borderBottom: li < selectedSignal.explanation.split("|").length - 1 ? `1px solid ${MW.border}33` : "none" }}>
                      {isConditionLine && <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: MW.muted, marginBottom: 3 }}>Entry Condition</div>}
                      {li === 3 && <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: MW.muted, marginBottom: 3 }}>Pattern Analysis</div>}
                      <span style={{ fontSize: 11, lineHeight: 1.5, color: isPatternLine ? MW.text : isConditionLine ? finalColor(selectedSignal.finalSignal) : MW.text, fontWeight: isConditionLine ? 600 : 400 }}>
                        {line}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Edit section (only when editMode) */}
            {editMode && (
              <div className="flex-shrink-0 px-3 py-3" style={{ borderTop: `1px solid ${MW.border}`, background: MW.bg + "dd" }}>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: MW.muted, marginBottom: 8 }}>Author Review</div>
                <button
                  onClick={() => toggleBad(selectedSignal.time)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, width: "100%",
                    padding: "6px 10px", borderRadius: 4, fontSize: 12, fontWeight: 600,
                    background: String(selectedSignal.time) in badTrades ? "#ef535020" : MW.toolbar,
                    border: `1px solid ${String(selectedSignal.time) in badTrades ? "#ef535066" : MW.border}`,
                    color: String(selectedSignal.time) in badTrades ? "#ef5350" : MW.muted,
                    cursor: "pointer", marginBottom: 8,
                  }}
                >
                  <span style={{ fontSize: 14 }}>{String(selectedSignal.time) in badTrades ? "✗" : "○"}</span>
                  {String(selectedSignal.time) in badTrades ? "Marked as Bad Signal" : "Mark as Bad Signal"}
                </button>

                {String(selectedSignal.time) in badTrades && (
                  <div>
                    <div style={{ fontSize: 9, color: MW.muted, marginBottom: 4 }}>Why was this trade bad?</div>
                    <textarea
                      value={badTrades[String(selectedSignal.time)]}
                      onChange={e => setReason(selectedSignal.time, e.target.value)}
                      placeholder="e.g. chasing extended move, no body confirmation, counter-trend, news spike..."
                      rows={3}
                      style={{
                        width: "100%", background: MW.toolbar,
                        border: `1px solid ${MW.border}`, color: MW.text,
                        fontSize: 11, padding: "6px 8px", borderRadius: 4,
                        resize: "none", fontFamily: "inherit", outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                    <div style={{ fontSize: 9, color: MW.muted, marginTop: 4 }}>
                      {badCount} bad trade{badCount !== 1 ? "s" : ""} marked · Click "Rework" in header to analyze
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      </>)}

      {/* ── Pattern Signals Tab ──────────────────────────────────────────────── */}
      {activeTab === "patterns" && (
        <div className="flex flex-col flex-1 min-h-0">

          {/* Pattern stats bar */}
          <div className="flex flex-shrink-0 flex-wrap gap-0" style={{ borderBottom: `1px solid ${MW.border}` }}>
            {(["strongest","strong","weak"] as PatternStrength[]).map((str, idx) => {
              const rs = patternStats.byStr[str];
              const color = str === "strongest" ? "#26c87a" : str === "strong" ? "#f59e0b" : "#9ca3af";
              const label = str.charAt(0).toUpperCase() + str.slice(1);
              const desc  = str === "strongest" ? "Pattern + Milk + Vector" : str === "strong" ? "Pattern + one signal" : "Pattern only";
              return (
                <button key={str} onClick={() => setPatternStrFilter(s => s === str ? "all" : str)}
                  style={{
                    flex: 1, padding: "8px 14px", cursor: "pointer", textAlign: "left",
                    background: patternStrFilter === str ? `${color}10` : MW.bg,
                    border: "none", borderRight: idx < 2 ? `1px solid ${MW.border}` : "none",
                    borderBottom: patternStrFilter === str ? `2px solid ${color}` : "2px solid transparent",
                    color: MW.text,
                  }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: "0.06em" }}>{label.toUpperCase()}</span>
                    <span style={{ fontSize: 10, color: MW.muted }}>{desc}</span>
                    <span style={{ marginLeft: "auto", fontSize: 10, color: MW.muted }}>{rs.count} signals</span>
                  </div>
                  <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
                    <span>Win Rate: <b style={{ color: rs.wr == null ? MW.muted : rs.wr >= 60 ? "#26c87a" : rs.wr >= 50 ? "#f59e0b" : "#ef5350" }}>{rs.wr == null ? "—" : `${rs.wr}%`}</b>
                      {rs.decided > 0 && <span style={{ fontSize: 10, color: MW.muted }}> ({rs.decided})</span>}
                    </span>
                    <span style={{ color: rs.pts >= 0 ? "#26c87a" : "#ef5350" }}>P&L: <b>{rs.pts >= 0 ? "+" : ""}{rs.pts.toFixed(1)} pts</b></span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Filter row */}
          <div className="flex items-center gap-3 px-4 flex-shrink-0"
            style={{ height: 36, borderBottom: `1px solid ${MW.border}`, background: MW.panel, fontSize: 11 }}>
            <span style={{ color: MW.muted }}>Direction:</span>
            <select value={patternDirFilter} onChange={e => setPatternDirFilter(e.target.value as any)}
              style={{ background: MW.toolbar, border: `1px solid ${MW.border}`, color: MW.text, fontSize: 11, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}>
              <option value="all">All</option><option value="Long">Long</option><option value="Short">Short</option>
            </select>
            <span style={{ color: MW.muted }}>Pattern:</span>
            <select value={patternTypeFilter} onChange={e => setPatternTypeFilter(e.target.value as any)}
              style={{ background: MW.toolbar, border: `1px solid ${MW.border}`, color: MW.text, fontSize: 11, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}>
              <option value="all">All patterns</option>
              {(Object.entries(PATTERN_LABELS) as [PatternType, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v} ({patternStats.byPat[k]?.count ?? 0})</option>
              ))}
            </select>
            <div className="flex-1" />
            <span style={{ color: MW.muted }}>Showing: <b style={{ color: MW.text }}>{filteredPatterns.length}</b></span>
            <span style={{ color: MW.muted }}>Overall WR: <b style={{ color: patternStats.overall.wr == null ? MW.muted : patternStats.overall.wr >= 55 ? "#26c87a" : "#f59e0b" }}>{patternStats.overall.wr == null ? "—" : `${patternStats.overall.wr}%`}</b></span>
          </div>

          {/* Table + side panel */}
          <div className="flex flex-1 min-h-0">
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              {/* Table header */}
              <div className="flex-shrink-0 grid" style={{
                gridTemplateColumns: "155px 110px 70px 90px 80px 80px 80px 70px 70px",
                background: MW.toolbar, borderBottom: `1px solid ${MW.border}`,
                padding: "0 16px", height: 28, alignItems: "center",
                fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: MW.muted,
              }}>
                <span>Timestamp (ET)</span><span>Pattern</span><span>Dir</span>
                <span>Strength</span><span>Price</span><span>TP1</span><span>TP2</span>
                <span>Outcome</span><span>Points</span>
              </div>
              {/* Rows */}
              <div className="flex-1 overflow-y-auto">
                {filteredPatterns.length === 0 ? (
                  <div style={{ padding: 24, textAlign: "center", color: MW.muted, fontSize: 12 }}>
                    No pattern signals found. Try a longer date range or different interval.
                  </div>
                ) : filteredPatterns.map((s, i) => {
                  const isSelected = selectedPatternSig?.time === s.time && selectedPatternSig?.pattern === s.pattern;
                  const isLong = s.direction === "Long";
                  const oc = s.outcome === "Win" ? "#26c87a" : s.outcome === "Loss" ? "#ef5350" : MW.muted;
                  const sc = s.strength === "strongest" ? "#26c87a" : s.strength === "strong" ? "#f59e0b" : "#9ca3af";
                  return (
                    <div key={`${s.time}-${s.pattern}-${i}`}
                      onClick={() => setSelectedPatternSig(isSelected ? null : s)}
                      className="grid cursor-pointer"
                      style={{
                        gridTemplateColumns: "155px 110px 70px 90px 80px 80px 80px 70px 70px",
                        padding: "0 16px", height: 30, alignItems: "center", fontSize: 11,
                        background: isSelected ? `${MW.accent}12` : i % 2 === 0 ? MW.bg : MW.panel,
                        borderBottom: `1px solid ${MW.border}30`,
                        borderLeft: isSelected ? `2px solid ${MW.accent}` : "2px solid transparent",
                      }}>
                      <span style={{ color: MW.muted, fontSize: 10 }}>{fmtTs(s.time)}</span>
                      <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{PATTERN_LABELS[s.pattern]}</span>
                      <span style={{ color: isLong ? "#26c87a" : "#ef5350", fontWeight: 700 }}>{isLong ? "▲ L" : "▼ S"}</span>
                      <span style={{ color: sc, fontWeight: 700, fontSize: 10 }}>{s.strength}</span>
                      <span style={{ color: "#e2e8f0" }}>{s.price.toFixed(2)}</span>
                      <span style={{ color: "#67e8f9" }}>{s.tp1.toFixed(2)}</span>
                      <span style={{ color: "#22d3ee" }}>{s.tp2.toFixed(2)}</span>
                      <span style={{ color: oc, fontWeight: 700, fontSize: 10 }}>{s.outcome === "Open" ? "—" : s.outcome}</span>
                      <span style={{ color: oc, fontWeight: 700 }}>{s.points !== null ? `${s.points >= 0 ? "+" : ""}${s.points.toFixed(1)}` : "—"}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Side panel */}
            {selectedPatternSig && computedBase && (
              <div className="flex flex-col flex-shrink-0" style={{ width: 380, borderLeft: `1px solid ${MW.border}`, background: MW.panel }}>
                <div className="flex items-center justify-between px-3 py-2 flex-shrink-0"
                  style={{ borderBottom: `1px solid ${MW.border}` }}>
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: MW.text }}>Pattern Detail</span>
                    <span style={{ marginLeft: 8, fontSize: 10, color: MW.muted }}>{fmtTs(selectedPatternSig.time)}</span>
                  </div>
                  <button onClick={() => setSelectedPatternSig(null)}
                    style={{ background: "none", border: "none", color: MW.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                </div>

                {/* Mini chart */}
                <div className="flex-shrink-0" style={{ borderBottom: `1px solid ${MW.border}` }}>
                  {patternSelectedFull && (
                    <SignalMiniChart
                      candles={computedBase.sorted}
                      signal={patternSelectedFull}
                      zones={showMilk ? computedBase.milkZones : []}
                      vecMap={computedBase.vecMap}
                      extraVecMaps={showVec ? extraVecMaps : []}
                      showVec={showVec}
                      showMilk={showMilk}
                      showSignalMark={showSignal}
                      height={200}
                    />
                  )}
                </div>

                {/* M/V/S toggles */}
                <div className="flex items-center gap-2 px-3 flex-shrink-0"
                  style={{ height: 36, borderBottom: `1px solid ${MW.border}` }}>
                  <span style={{ fontSize: 10, color: MW.muted, marginRight: 4 }}>Overlay:</span>
                  <button onClick={() => setShowMilk(v => !v)} style={{ width: 28, height: 22, borderRadius: 4, fontSize: 11, fontWeight: 800, background: showMilk ? "#26c87a20" : MW.toolbar, border: `1px solid ${showMilk ? "#26c87a" : MW.border}`, color: showMilk ? "#26c87a" : MW.muted, cursor: "pointer" }}>M</button>
                  <span style={{ fontSize: 9, color: MW.muted }}>Milk</span>
                  <div style={{ width: 1, height: 14, background: MW.border, margin: "0 4px" }} />
                  <button onClick={() => setShowVec(v => !v)} style={{ width: 28, height: 22, borderRadius: 4, fontSize: 11, fontWeight: 800, background: showVec ? "#00b4d820" : MW.toolbar, border: `1px solid ${showVec ? "#00b4d8" : MW.border}`, color: showVec ? "#00b4d8" : MW.muted, cursor: "pointer" }}>V</button>
                  <span style={{ fontSize: 9, color: MW.muted }}>Vector</span>
                  <div style={{ width: 1, height: 14, background: MW.border, margin: "0 4px" }} />
                  <button onClick={() => setShowSignal(v => !v)} style={{ width: 28, height: 22, borderRadius: 4, fontSize: 11, fontWeight: 800, background: showSignal ? "#f59e0b20" : MW.toolbar, border: `1px solid ${showSignal ? "#f59e0b" : MW.border}`, color: showSignal ? "#f59e0b" : MW.muted, cursor: "pointer" }}>S</button>
                  <span style={{ fontSize: 9, color: MW.muted }}>Signal</span>
                </div>

                {/* Stats */}
                <div style={{ padding: "10px 12px", overflowY: "auto" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: selectedPatternSig.direction === "Long" ? "#26c87a" : "#ef5350", marginBottom: 8 }}>
                    {selectedPatternSig.direction === "Long" ? "▲ LONG" : "▼ SHORT"} {PATTERN_LABELS[selectedPatternSig.pattern]}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", rowGap: 5, fontSize: 11 }}>
                    <span style={{ color: MW.muted }}>Entry</span><span style={{ color: "#fff", fontWeight: 600 }}>{selectedPatternSig.price.toFixed(2)}</span>
                    <span style={{ color: "#67e8f9" }}>TP1</span><span style={{ color: "#67e8f9" }}>{selectedPatternSig.tp1.toFixed(2)}</span>
                    <span style={{ color: "#22d3ee" }}>TP2</span><span style={{ color: "#22d3ee", fontWeight: 700 }}>{selectedPatternSig.tp2.toFixed(2)}</span>
                    <span style={{ color: "#f87171" }}>SL</span><span style={{ color: "#f87171" }}>{selectedPatternSig.sl.toFixed(2)}</span>
                    <span style={{ color: MW.muted }}>Strength</span>
                    <span style={{ color: selectedPatternSig.strength === "strongest" ? "#26c87a" : selectedPatternSig.strength === "strong" ? "#f59e0b" : "#9ca3af", fontWeight: 700 }}>{selectedPatternSig.strength}</span>
                    <span style={{ color: MW.muted }}>Votes</span>
                    <span style={{ color: MW.text, fontSize: 10 }}>
                      Pattern ✓ {selectedPatternSig.vectorVote ? "· Vector ✓" : "· Vector ✗"} {selectedPatternSig.milkVote ? "· Milk ✓" : "· Milk ✗"}
                    </span>
                    <span style={{ color: MW.muted }}>Outcome</span>
                    <span style={{ color: selectedPatternSig.outcome === "Win" ? "#26c87a" : selectedPatternSig.outcome === "Loss" ? "#ef5350" : MW.muted, fontWeight: 700 }}>
                      {selectedPatternSig.outcome}{selectedPatternSig.points !== null ? ` (${selectedPatternSig.points >= 0 ? "+" : ""}${selectedPatternSig.points.toFixed(2)} pts)` : ""}
                    </span>
                  </div>
                  {/* Pattern-type win rate */}
                  {(() => {
                    const ps = patternStats.byPat[selectedPatternSig.pattern];
                    if (!ps || !ps.decided) return null;
                    return (
                      <div style={{ marginTop: 10, padding: "8px 10px", background: MW.toolbar, borderRadius: 4, border: `1px solid ${MW.border}` }}>
                        <div style={{ fontSize: 10, color: MW.muted, marginBottom: 4 }}>{PATTERN_LABELS[selectedPatternSig.pattern]} — Historical Performance</div>
                        <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
                          <span>WR: <b style={{ color: ps.wr! >= 55 ? "#26c87a" : "#f59e0b" }}>{ps.wr}%</b></span>
                          <span style={{ color: MW.muted }}>{ps.decided} decided / {ps.count} total</span>
                          <span style={{ color: ps.pts >= 0 ? "#26c87a" : "#ef5350" }}>P&L: {ps.pts >= 0 ? "+" : ""}{ps.pts.toFixed(1)}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center px-4 gap-4 flex-shrink-0"
        style={{ height: 24, background: MW.toolbar, borderTop: `1px solid ${MW.border}`, fontSize: 10, color: MW.muted }}>
        <span>Vector: LB = Highest(Lowest(Low, 20), 20)</span>
        <span>·</span><span>Confluence: Milk Zone + Vector agree → Strong signal</span>
        <span>·</span><span>ATR 2:1 R:R (TP=1×ATR, SL=0.5×ATR)</span>
        <span>·</span><span>Click row → mini chart · Toggle M/V to overlay zones & vector</span>
        {editMode && <><span>·</span><span style={{ color: MW.accent }}>Edit mode: mark bad trades, then click Rework to improve signals</span></>}
      </div>
    </div>
  );
}
