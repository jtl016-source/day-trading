import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { GraduationCap, X as XIcon } from "lucide-react";
import { CandlestickChart, type CandleBar, type ZoneBand, type ChartHandle } from "./CandlestickChart";
import { computeOptimizedSignals } from "@/lib/signal-engine"; // SHARED-ENGINE: THE program strategy — same signals on chart, tab and backtest

// ── palette ───────────────────────────────────────────────────────────────────
const MW = {
  bg: "#05080d", panel: "#090d14", border: "#1a2535",
  text: "#c8d8e8", muted: "#4a6080", accent: "#42a5f5",
  up: "#26c87a", down: "#ef5350",
};

// ── types ──────────────────────────────────────────────────────────────────────
type RiskLevel  = "safe" | "risky" | "riskiest";
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
  reclassifyReason?: string;
  signalType?: "pure_tabletop" | "side_tabletop";
  footprintReading?: string; // FOOTPRINT-UI: JSON FootprintReading
  confidence?: number; // 0–100 confidence score
}

interface Annotation {
  note: string;
  markedBad: boolean;
}

/** Matches the CSig shape from market.tsx. Passed in to avoid duplicate signal computation. */
export interface ExternalSignal {
  time: number;
  direction: "Long" | "Short";
  riskLevel: "safe" | "risky" | "riskiest";
  price: number;
  high: number;
  low: number;
  tp1: number; tp2: number; sl: number;
  confirmations: { milkOk: boolean; vecOk: boolean; secondaryVecOk: boolean };
  reclassifyReason?: string;
  outcome?: "win_tp1" | "win_tp2" | "loss" | "open";
  signalType?: "pure_tabletop" | "side_tabletop";
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
const RESIST_PROX   = 5.0;
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
  reclassifyReason?: string;
  /** Pre-computed outcome from market.tsx (only set when externalSignals provided) */
  preOutcome?: "win_tp1" | "win_tp2" | "win_trailer" | "loss" | "open";
  signalType?: "pure_tabletop" | "side_tabletop";
  footprintReading?: string; // FOOTPRINT-UI: JSON FootprintReading
  confidence?: number; // 0–100 confidence score
}

type MLZone = { from_ts: number; to_ts: number; top: number; bottom: number; is_bull: boolean; score: number };

// SHARED-ENGINE: standalone signal computation delegates to computeOptimizedSignals —
// THE program strategy (ICT Zones + Candle Body on 15m RTH, TP1 +8 / TP2 +16 /
// SL −4) — the EXACT code path the Market chart and Backtest page run, so the
// Signals tab always shows the SAME EXACT signals. Input candles are aggregated
// to 15m inside the engine regardless of the panel's display interval.
function computeSignals(candles: CandleBar[]): RawSignal[] {
  if (!candles.length) return [];
  const sorted  = [...candles].sort((a, b) => a.time - b.time);
  const openMap = new Map(sorted.map(c => [c.time, c.open]));
  return computeOptimizedSignals(sorted).map(s => ({
    time: s.time,
    open: openMap.get(s.time) ?? s.price,
    high: s.high,
    low:  s.low,
    direction: s.direction,
    riskLevel: s.tier as RiskLevel,
    price: s.price,
    tp1: s.tp1, tp2: s.tp2, sl: s.sl,
    milkOk: s.milkOk,
    secondaryVecOk: false,
    preOutcome: s.outcome,
  }));
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

// ── exit strategy profiles (mirrors EXIT_STRATEGY_PROFILES in market.tsx) ─────
const EXIT_VIEW_PROFILES = {
  safe:     { rth: { tp1: 8.5,  tp2: 14.0, sl: 3.5 }, eth: { tp1: 6.0,  tp2: 10.0, sl: 2.5 }, label: "Tight",    color: "#26c87a" },
  risky:    { rth: { tp1: 10.0, tp2: 20.0, sl: 5.0 }, eth: { tp1: 5.0,  tp2: 10.0, sl: 3.0 }, label: "Standard", color: "#f59e0b" },
  riskiest: { rth: { tp1: 14.0, tp2: 28.0, sl: 8.0 }, eth: { tp1: 10.0, tp2: 18.0, sl: 5.0 }, label: "Wide",     color: "#ef5350" },
} as const;
type ExitView = "current" | "safe" | "risky" | "riskiest";

// ── constants ─────────────────────────────────────────────────────────────────
const SYMBOLS   = ["MES", "ES", "SPY", "QQQ", "NQ", "MNQ"];
const IVAL_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };

function defaultStartDate(): string {
  // Default to today's date so the panel opens showing today's signals
  return new Date().toISOString().split("T")[0];
}

// ── main component ─────────────────────────────────────────────────────────────
export default function SignalsPanel({ defaultSymbol = "MES", defaultInterval = "5m", onClose, onViewOnChart, externalSignals, milkZones, allCandles, footprintAlerts }: SignalsPanelProps) { // FOOTPRINT-UI:
  const [sym,       setSym]       = useState(defaultSymbol);
  const [ival,      setIval]      = useState<IntervalKey>(defaultInterval);
  const [activeTab,   setActiveTab]   = useState<"signals" | "learned">("signals");
  const [direction,   setDirection]   = useState<"all"|"long"|"short">("all");
  const [riskFilter,  setRiskFilter]  = useState<"all"|RiskLevel>("all");
  const [rthOnly,     setRthOnly]     = useState(true);
  const [exitView,    setExitView]    = useState<ExitView>("current");
  const [minPts,      setMinPts]      = useState(0);
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [editMode,      setEditMode]      = useState(false);
  const [selKey,        setSelKey]        = useState<string | null>(null);
  const [editNote,      setEditNote]      = useState("");
  const [learnLoading,  setLearnLoading]  = useState(false);
  const [learnLog,      setLearnLog]      = useState<any | null>(null);
  const [learnToast,    setLearnToast]    = useState<string | null>(null);

  const [showLearnedTrades, setShowLearnedTrades] = useState(false);

  const [previewSig,        setPreviewSig]        = useState<SignalEntry | null>(null);
  const [previewShowVector, setPreviewShowVector] = useState(true);
  const [previewShowZones,  setPreviewShowZones]  = useState(true);
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
  const toTs   = useMemo(() => Math.floor(Date.now() / 1000), []);
  const fromTs = useMemo(() => {
    const d = new Date(startDate + "T09:30:00");  // start of trading day ET
    return Math.floor(d.getTime() / 1000) - 4 * 3600; // convert ET to UTC
  }, [startDate]);

  // ── data fetching ───────────────────────────────────────────────────────────
  // SHARED-ENGINE: fetch 2 extra lead-in days so the engine's 20-bar vector,
  // zone detection and 10-bar cooldown have warm-up history — signals shown for
  // the selected range then match the Backtest page (which loads full history).
  // Display filtering below still uses fromTs, so no extra signals appear.
  const dataFromTs = fromTs - 2 * 86400;
  const fetchIval = ival === "1m" ? "1m" : "5m";
  const { data: mainData, isLoading } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["sp-candles", sym, fetchIval, dataFromTs, toTs],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${sym}/${fetchIval}?from=${dataFromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("fetch failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  // Secondary 5m (only when interval=1m — needed for secondary vectors)
  const { data: sec5m } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["sp-candles", sym, "5m", dataFromTs, toTs],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/${sym}/5m?from=${dataFromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("fetch failed");
      return r.json();
    },
    enabled: ival === "1m",
    staleTime: 60_000,
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

  // ── signal computation ──────────────────────────────────────────────────────
  const openMap = useMemo(() => new Map(sortedPrimary.map(c => [c.time, c.open])), [sortedPrimary]);
  const rawSignals = useMemo((): RawSignal[] => {
    if (useExternal) {
      // THE program strategy fires on 15m only — show its signals regardless of
      // the chart's viewed interval (no cross-interval filtering needed).
      return externalSignals.map(s => ({
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
        reclassifyReason: s.reclassifyReason,
        preOutcome: s.outcome,
        signalType: s.signalType,
        footprintReading: s.footprintReading, // FOOTPRINT-UI:
        confidence: s.confidence,
      }));
    }
    // Standalone mode: always compute from the 5m dataset — the engine
    // aggregates to 15m internally (60m display bars cannot be disaggregated).
    return computeSignals(base5m);
  }, [useExternal, externalSignals, openMap, base5m]);

  const signals = useMemo((): SignalEntry[] => {
    return rawSignals
      .map(s => {
        let outcome: OutcomeResult;
        let tpHit: 1 | 2 | null;
        let points: number | null;

        if (exitView !== "current") {
          // Re-compute outcome using the selected exit strategy profile's TP/SL levels
          const ep  = EXIT_VIEW_PROFILES[exitView];
          const ses = isRTH(s.time) ? ep.rth : ep.eth;
          const isLong = s.direction === "Long";
          const eTp1 = isLong ? s.price + ses.tp1 : s.price - ses.tp1;
          const eTp2 = isLong ? s.price + ses.tp2 : s.price - ses.tp2;
          const eSl  = isLong ? s.price - ses.sl  : s.price + ses.sl;
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
        // All program signals are 15m strategy signals — tag them as such so
        // "View on Chart" navigates to the 15m interval where they fired.
        return { key: `${sym}-${s.time}-15m`, ...s, interval: "15m" as IntervalKey, rth: isRTH(s.time), outcome, tpHit, points };
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
  }, [rawSignals, sortedPrimary, allSortedCandles, sym, ival, fromTs, toTs, rthOnly, direction, riskFilter, minPts, exitView]);

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

  const rlColor = (rl: string) => rl === "safe" ? "#26c87a" : rl === "risky" ? "#f59e0b" : "#ef4444";
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
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              <button style={sel(previewShowVector, MW.accent)} onClick={() => setPreviewShowVector(v => !v)}>Vector</button>
              {milkZones?.length ? (
                <button style={sel(previewShowZones, "#22c55e")} onClick={() => setPreviewShowZones(v => !v)}>Zones</button>
              ) : null}
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
              zones={previewShowZones && previewZones.length ? previewZones : undefined}
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
        {(["signals", "learned"] as const).map(tab => (
          <button key={tab} onClick={() => { setActiveTab(tab); if (tab === "learned") refetchLearnings(); }}
            style={{
              padding: "3px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer",
              background: activeTab === tab ? (tab === "learned" ? "rgba(167,139,250,0.18)" : "rgba(66,165,245,0.15)") : "transparent",
              border: `1px solid ${activeTab === tab ? (tab === "learned" ? "#a78bfa88" : MW.accent + "88") : MW.border}`,
              color: activeTab === tab ? (tab === "learned" ? "#a78bfa" : MW.accent) : MW.muted,
              fontFamily: "'Trebuchet MS', monospace", textTransform: "uppercase", letterSpacing: "0.05em",
            }}
          >{tab}</button>
        ))}

        <span style={{ color: MW.muted, fontSize: 11 }}>
          {activeTab === "signals" ? `${stats.total} signals` : `${lessons.length} lessons`}
        </span>

        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
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
              {exitView !== "current" && (
                <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: EXIT_VIEW_PROFILES[exitView].color + "18", color: EXIT_VIEW_PROFILES[exitView].color, marginLeft: 4 }}>
                  {EXIT_VIEW_PROFILES[exitView].label}
                </span>
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
            title={`Simulate outcomes using ${EXIT_VIEW_PROFILES[ev].label} exit levels (TP1=${EXIT_VIEW_PROFILES[ev].rth.tp1} TP2=${EXIT_VIEW_PROFILES[ev].rth.tp2} SL=${EXIT_VIEW_PROFILES[ev].rth.sl} pts)`}>
            {EXIT_VIEW_PROFILES[ev].label}
          </button>
        ))}
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
                  const rlColor = s.riskLevel === "safe" ? "#26c87a" : s.riskLevel === "risky" ? "#f59e0b" : "#ef4444";
                  const ocColor = s.outcome === "Win" ? "#26c87a" : s.outcome === "Loss" ? "#ef5350" : MW.muted;
                  const dt = new Date(s.time * 1000);
                  const dateStr = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  const timeStr = dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
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
                  {["", "Date", "Time", "Dir", "Risk", "Entry", "TP1", "SL", "W/L", "P&L", ""].map((h, i) => (
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
                      {/* Bad trade marker */}
                      <td style={{ padding: "5px 4px 5px 10px", width: 12 }}>
                        {ann?.markedBad && <span style={{ color: "#ef5350", fontSize: 8 }}>●</span>}
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
                      {/* Direction + tabletop badge */}
                      <td style={{ padding: "5px 8px", color: s.direction === "Long" ? "#26c87a" : "#ef5350", fontWeight: 700, fontSize: 10 }}>
                        <span>{s.direction === "Long" ? "▲ L" : "▼ S"}</span>
                        {s.signalType === "pure_tabletop" && (
                          <span title="Pure Tabletop" style={{ marginLeft: 4, fontSize: 8, padding: "0 3px", borderRadius: 2, background: "rgba(245,158,11,0.18)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.4)", verticalAlign: "middle" }}>⊤</span>
                        )}
                        {s.signalType === "side_tabletop" && (
                          <span title="Side-Entry Tabletop" style={{ marginLeft: 4, fontSize: 8, padding: "0 3px", borderRadius: 2, background: "rgba(34,211,238,0.15)", color: "#22d3ee", border: "1px solid rgba(34,211,238,0.35)", verticalAlign: "middle" }}>⊏</span>
                        )}
                      </td>
                      {/* Risk */}
                      <td style={{ padding: "5px 8px" }}>
                        <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: rl + "18", color: rl }}>{s.riskLevel}</span>
                      </td>
                      {/* Entry */}
                      <td style={{ padding: "5px 8px", color: "#e2e8f0" }}>{s.price.toFixed(2)}</td>
                      {/* TP1 */}
                      <td style={{ padding: "5px 8px", color: "#67e8f9" }}>{s.tp1.toFixed(2)}</td>
                      {/* SL */}
                      <td style={{ padding: "5px 8px", color: "#f87171" }}>{s.sl.toFixed(2)}</td>
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
      `}</style>
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

function SignalDetail({ signal: s, annotation, editMode, editNote, setEditNote, onSave, onViewOnChart, onClose, candles, footprintAlert }: DetailProps) { // FOOTPRINT-UI:
  const isFpDegraded = s.riskLevel === "safe" && s.reclassifyReason?.includes("Footprint"); // FIX: SAFE with no/partial footprint data
  const rlC = s.riskLevel === "safe" ? (isFpDegraded ? "rgba(38,200,122,0.65)" : "#26c87a") : s.riskLevel === "risky" ? "#f59e0b" : "#ef4444"; // FIX: 65% opacity for footprint-degraded SAFE
  const ocC = s.outcome === "Win" ? "#26c87a" : s.outcome === "Loss" ? "#ef5350" : MW.muted;
  const isBad = annotation?.markedBad ?? false;

  const [teachState, setTeachState]   = useState<"idle" | "loading" | "done" | "error">("idle");
  const [teachLesson, setTeachLesson] = useState("");

  const handleTeach = async () => {
    if (!editNote.trim()) return;
    onSave({ note: editNote, markedBad: isBad });
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
        {/* SAFE bonus: pattern confluence (placeholder — fires when pattern recognition is implemented) */}
        {s.riskLevel === "safe" && ( // FIX: removed false && — pattern confluence section now active for SAFE signals
          <div style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 5 }}>
            <span style={{ fontSize: 13, lineHeight: 1, color: "#a78bfa", marginTop: 1 }}>✓</span>
            <div>
              <div style={{ fontSize: 11, color: "#a78bfa" }}>Pattern confluence present</div>
              <div style={{ fontSize: 9, color: MW.muted }}>additional confirmation</div>
            </div>
          </div>
        )}
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
        {s.reclassifyReason && (
          <div style={{ fontSize: 10, color: "#fbbf24", background: "rgba(245,158,11,0.07)", borderRadius: 4, padding: "5px 8px", border: "1px solid rgba(245,158,11,0.18)", marginBottom: 4 }}>
            ⚠ {s.reclassifyReason}
          </div>
        )}
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
          <div style={{ fontSize: 9, color: "#a78bfa", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Trade Note</div>
          <textarea
            value={editNote}
            onChange={e => { setEditNote(e.target.value); if (teachState !== "idle") setTeachState("idle"); }}
            placeholder="Describe why this trade was bad, what you noticed, what the market was doing..."
            rows={3}
            style={{ width: "100%", padding: "6px 8px", borderRadius: 4, fontSize: 11, resize: "vertical", boxSizing: "border-box", background: "#0d1420", border: `1px solid ${MW.border}`, color: MW.text, fontFamily: "'Trebuchet MS', monospace", outline: "none" }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              onClick={() => onSave({ note: editNote, markedBad: true })}
              style={{ flex: 1, padding: "4px 0", borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: "'Trebuchet MS', monospace", background: isBad ? "rgba(239,83,80,0.18)" : "transparent", border: `1px solid ${isBad ? "#ef5350" : MW.border}`, color: isBad ? "#ef5350" : MW.muted }}
            >{isBad ? "● Marked Bad" : "Mark as Bad"}</button>
            <button
              onClick={handleTeach}
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
      {!editMode && annotation && (annotation.note || annotation.markedBad) && (
        <div style={{ borderTop: `1px solid ${MW.border}`, paddingTop: 8 }}>
          {annotation.markedBad && <div style={{ fontSize: 10, color: "#ef5350", fontWeight: 600, marginBottom: 3 }}>● Marked as bad trade</div>}
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
