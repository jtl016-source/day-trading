// useTerminalData.ts — wires the MERIDIAN terminal to REAL data sources:
//   • Candles  → GET /api/data/cached-continuous/:symbol/:interval
//   • Signals  → GET /api/signals/history/:symbol/:interval  (+ live `signal_new` over WS)
//   • Live     → /ws/live-bars  `tick` (last price + forming candle) / `bar` (new candle)
//                `data_updated` (silent dataset refresh, no wave re-reveal)
//
// The MarketPage engine stays mounted (hidden) and remains the producer of all of this;
// this hook is a pure consumer, exactly like the iPhone app.
import { useEffect, useRef, useState, useCallback } from "react";
import { isSessionLegalSignal } from "@shared/signal-rules";
import { isOutcomeTransitionAllowed } from "@shared/outcome-resolver"; // OUTCOME-GUARD: first-touch immutability (2026-07-31)
import { parseRiskFlags } from "@shared/signal-display"; // RISK DISPLAY: risk_flags JSON → string[]
import { strategyLabel } from "@/lib/strategyLabel";
import { terminalDeepHistoryQuery } from "@/lib/candle-window"; // CANDLE WINDOW (2026-09-24): capped deep-history request

export interface TerminalCandle { time: number; o: number; h: number; l: number; c: number; }

export type SignalStatus = "ACTIVE" | "TP1 HIT" | "TARGET" | "STOPPED" | "EOD" | "FILLED" | "EXPIRED";

// A signal with no recorded outcome is only truly "ACTIVE" for a limited window. After this it
// almost certainly resolved (TP/SL) without the outcome being written back — show EXPIRED, not
// a perpetual ACTIVE. Mirrors the iPhone app's 48h rule.
const ACTIVE_WINDOW_SEC = 48 * 3600;

export interface TerminalSignal {
  id: string;
  time: string;       // HH:MM:SS ET
  ts: number;         // unix seconds (for sorting / today filter)
  side: "LONG" | "SHORT";
  strat: string;
  tier: string;       // single-tier: always "SAFE"
  entry: number;
  stop: number;
  tp1: number;
  /** TP1-ONLY policy (2026-08-13): null on all post-policy rows — one target only. */
  tp2: number | null;
  status: SignalStatus;
  pnl: number | null;
  // raw extras for the detail view
  signalType: string | null;
  outcome: string | null;
  confirmations: string | null;   // JSON {milkOk, milkPts, vecOk, secondaryVecOk, ...}
  footprintReading: string | null; // JSON FootprintReading
  label: string | null;           // FACT-ENGINE: composite fact-list label
  // BACKTEST-GRADE EXIT DETAIL (2026-07-29) — straight from signal_history (null on open /
  // legacy rows). pnl above PREFERS pointsResult when present (the workbook's realized number).
  exitPrice: number | null;
  exitTs: number | null;
  pointsResult: number | null;
  mae: number | null;
  mfe: number | null;
  barsToExit: number | null;
  // RISK DISPLAY (2026-07-30): the fire-time fact-combo key ("FG+Fr+YB") + situational risk
  // flags (parsed from the JSON column). Null/empty on rows without risk info — the UI then
  // simply shows no risk cell content (graceful).
  comboKey: string | null;
  riskFlags: string[];
  /** SOURCE PROVENANCE (2026-08-11 late-signal failsafe): 'live' = fired by a live tab at the
   *  time; 'catchup' = back-filled later by the intraday replay (engine-endorsed); 'regen' =
   *  weekly/historical book row. The Signals tab badges non-live rows so a late-appearing
   *  signal can never masquerade as a live fire. */
  source: string | null;
}

export interface SignalRow {
  timestamp: number;
  direction: string;
  riskLevel: string;
  signalType: string | null;
  entry: number;
  tp1: number;
  tp2: number | null;
  sl: number;
  outcome: string | null;
  confirmations: string | null;
  footprintReading: string | null;
  label: string | null;           // FACT-ENGINE: composite fact-list label (nullable for old rows)
  // BACKTEST-GRADE EXIT DETAIL (2026-07-29): additive/nullable signal_history columns.
  exitPrice?: number | null;
  exitTs?: number | null;
  pointsResult?: number | null;
  mae?: number | null;
  mfe?: number | null;
  barsToExit?: number | null;
  // RISK DISPLAY (2026-07-30): additive/nullable — combo_key TEXT + risk_flags TEXT (JSON
  // string array). The WS-merge path may hand an already-parsed array through (TerminalSignal
  // field) — parseRiskFlags accepts both shapes.
  comboKey?: string | null;
  riskFlags?: string | string[] | null;
  /** SOURCE PROVENANCE (2026-08-11): additive/nullable signal_history column. */
  source?: string | null;
}

// Keep ALL available history (user wants the full dataset, however large). lightweight-charts
// v5 renders 100k+ candles efficiently with viewport culling, so this is a soft safety cap,
// not a display window. (5m ≈ 100k bars back to 2025; 15m ≈ 84k back to 2022.)
// (2026-09-24: the deep load is now span-capped — 1m 14 d, 5m 90 d; 15m/60m full=1 still reach
// back years, so this slice still matters for them.)
const MAX_CANDLES = 200000;

// Seconds per display bar — used to bucket live ticks/bars to the visible interval.
const INTERVAL_SECS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };
function ivSecs(interval: string): number { return INTERVAL_SECS[interval] ?? 300; }

// Real bars sit exactly on their interval boundary. The live relay sometimes persists a
// forming/partial bar at a raw (non-aligned) timestamp — those render as thin "no-body"
// ghost candles. Drop anything not aligned to the interval. (60m uses a session offset, so
// skip the strict check there.)
function isAligned(time: number, interval: string): boolean {
  if (interval === "60m") return true;
  const sec = INTERVAL_SECS[interval] ?? 300;
  return Number.isInteger(time) && time % sec === 0;
}

// Map raw server rows → clean, time-sorted TerminalCandles.
// Ghost "no-body" candles are removed SURGICALLY: a forming/partial bar the relay persisted
// has zero volume — drop those. We do NOT use a neighbour-isolation filter: in a trending
// market real bars legitimately don't overlap their distant neighbours, so that filter
// deletes genuine candles and tears holes (gaps) in the chart.
function cleanRows(raw: any[], interval: string): TerminalCandle[] {
  const thr = spikeThr(interval);
  return raw
    .map((b: any) => ({ time: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: Number(b.volume ?? b.v ?? 1) }))
    .filter((b: any) => !badBar(b.o, b.h, b.l, b.c, thr) && isAligned(b.time, interval) && b.v > 0)
    .map((b: any): TerminalCandle => ({ time: b.time, o: b.o, h: b.h, l: b.l, c: b.c }))
    .sort((a: TerminalCandle, b: TerminalCandle) => a.time - b.time);
}

// Fast-open window: initial load pulls only this many days so the chart paints instantly.
// The full history is fetched lazily when the user scrolls back to the left edge.
const FAST_OPEN_DAYS = 10;

function normSym(s: string): string {
  // Strip a futures month/year suffix (MESM6 → MES) and uppercase.
  return s.toUpperCase().replace(/([A-Z]{2,})[FGHJKMNQUVXZ]\d{1,2}$/, "$1");
}

// PERF (2026-07-30): ONE module-level formatter. This runs per signal row (2,600+ rows on the
// 1m interval) and Intl.DateTimeFormat CONSTRUCTION is ~ms-scale — constructing per row burned
// seconds of main thread on every signal refetch.
const _etTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
function fmtEtTime(tsSec: number): string {
  return _etTimeFmt.format(new Date(tsSec * 1000));
}

/** Unix seconds at the most recent ET midnight (DST-safe). */
function etDayStartSec(): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const secsIntoEtDay = g("hour") * 3600 + g("minute") * 60 + g("second");
  return Math.floor(now.getTime() / 1000) - secsIntoEtDay;
}

/** YYYY-MM-DD for the ET calendar day containing `ms` (default now). */
export function etDateStr(ms: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
}

/** UTC second bounds [start, end) of an ET calendar date string 'YYYY-MM-DD' (DST-safe). */
export function etDayBounds(dateStr: string): { start: number; end: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  // ET midnight is 04:00 UTC (EDT) or 05:00 UTC (EST). Probe midday to read the day's offset.
  const probe = Date.UTC(y, m - 1, d, 16, 0, 0); // ~noon ET — safely the same ET date
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" })
    .formatToParts(new Date(probe)).find((p) => p.type === "timeZoneName")?.value;
  const offH = tz === "EST" ? 5 : 4;
  const start = Date.UTC(y, m - 1, d, offH, 0, 0) / 1000;
  return { start, end: start + 86400 };
}

function intervalToResolution(interval: string): string {
  if (interval === "60m") return "60";
  if (interval === "1m") return "1";
  return "5"; // 5m and 15m both ride the 5m base
}

function mapStatus(outcome: string | null): SignalStatus {
  switch ((outcome ?? "").toLowerCase()) {
    case "win_tp2":
    case "win":
    case "target": return "TARGET";
    case "win_tp1":
    case "tp1": return "TP1 HIT";
    case "loss":
    case "stopped":
    case "stop":
    case "sl": return "STOPPED";
    case "eod": return "EOD"; // force-closed at the 17:00 ET settle (not a stop-out)
    case "filled": return "FILLED";
    default: return "ACTIVE";
  }
}

function mapPnl(r: SignalRow): number | null {
  // BACKTEST-GRADE (2026-07-29): the persisted realized points (harness 1m walk / live engine
  // walk) are the truth when present — the tp/sl arithmetic below is only the legacy fallback.
  if (typeof r.pointsResult === "number" && Number.isFinite(r.pointsResult)) return +r.pointsResult.toFixed(2);
  const dir = r.direction.toLowerCase().startsWith("l") ? 1 : -1;
  switch ((r.outcome ?? "").toLowerCase()) {
    // win_tp2 only exists on legacy-convention rows (tp2 present); tp1 fallback is honest.
    case "win_tp2": case "win": case "target": return +(((r.tp2 ?? r.tp1) - r.entry) * dir).toFixed(2);
    case "win_tp1": case "tp1": return +((r.tp1 - r.entry) * dir).toFixed(2);
    case "loss": case "stopped": case "stop": case "sl": return +((r.sl - r.entry) * dir).toFixed(2);
    default: return null; // ACTIVE / FILLED / EOD-without-points → unrealized
  }
}

export function mapSignal(r: SignalRow): TerminalSignal {
  let status = mapStatus(r.outcome);
  // Old unresolved signal → EXPIRED, not perpetually ACTIVE (fixes "still active" bug).
  if (status === "ACTIVE" && Math.floor(Date.now() / 1000) - r.timestamp > ACTIVE_WINDOW_SEC) {
    status = "EXPIRED";
  }
  return {
    id: `${r.timestamp}-${r.direction}`,
    time: fmtEtTime(r.timestamp),
    ts: r.timestamp,
    side: r.direction.toLowerCase().startsWith("l") ? "LONG" : "SHORT",
    // FACT-ENGINE: the STRATEGY column shows the composite fact-list label (never "Confluence").
    // New rows carry `label`; old rows fall back to strategyLabel() derived from confirmations.
    strat: r.label || strategyLabel(r.signalType, r.confirmations, r.footprintReading),
    tier: "SAFE",
    entry: r.entry,
    stop: r.sl,
    tp1: r.tp1,
    tp2: r.tp2,
    status,
    pnl: mapPnl(r),
    signalType: r.signalType ?? null,
    outcome: r.outcome ?? null,
    confirmations: r.confirmations ?? null,
    footprintReading: r.footprintReading ?? null,
    label: r.label ?? null,
    exitPrice: r.exitPrice ?? null,
    exitTs: r.exitTs ?? null,
    pointsResult: r.pointsResult ?? null,
    mae: r.mae ?? null,
    mfe: r.mfe ?? null,
    barsToExit: r.barsToExit ?? null,
    comboKey: r.comboKey ?? null,
    riskFlags: parseRiskFlags(r.riskFlags),
    source: r.source ?? null,
  };
}

// (dedupeSignals DELETED 2026-07-14 — SIGNAL-INTEGRITY D2: the 5-bar same-side cluster collapse
//  HID persisted signals from the tab/chart, breaking chart↔tab parity. The engine's own global
//  4-bar cooldown already spaces signals; every rule-compliant persisted signal is now shown.)

// Max H-L spread (fraction of close) before a bar is treated as a corrupt spike (mirrors
// the server's isSpikeBar thresholds) — keeps ghost/spike candles off the chart.
function spikeThr(interval: string): number {
  return interval === "1m" ? 0.005 : interval === "5m" ? 0.010 : interval === "15m" ? 0.015 : 0.025;
}
function badBar(o: number, h: number, l: number, c: number, thr: number): boolean {
  if (![o, h, l, c].every((v) => Number.isFinite(v))) return true;
  if (h < l || o > h + 1e-9 || o < l - 1e-9 || c > h + 1e-9 || c < l - 1e-9 || c <= 0) return true;
  if ((h - l) / c > thr) return true; // absurd range
  return false;
}

/** CONTRACT GUARD snapshot (2026-09-18) — the last `contract_guard` WS message (ANY event,
 *  including the on-connect "snapshot"). offContract = MotiveWave's chart is on a different
 *  contract month than Yahoo's front month (MW quarantined). translationActive = while
 *  off-contract the server shifts MW ticks onto the front month by offsetPts, so the chart stays
 *  tick-live; when it is FALSE while offContract, Yahoo's ~10-min-delayed feed is driving. */
export interface TerminalGuard {
  /** Also true during a MIXED-MONTHS quarantine (msg.mixedMonths — two month codes on the tick
   *  stream at once): the server's isMwOffContract() is offContract || mixedMonths, MW is
   *  quarantined the same way and Yahoo drives, so MarketView must read DELAYED there too. */
  offContract: boolean;
  rollPending: boolean;
  translationActive: boolean;
  offsetPts: number;
  /** Epoch sec since which THIS client has been receiving translated ticks under the current
   *  price regime — re-seeded by a flip / roll event and by every WS (re)connect snapshot;
   *  0 while translation is off. reconcile()'s PARTIAL-ROW HOLD only protects local candles of
   *  buckets that started at/after it. */
  translatingSinceSec: number;
}

/** Seconds per live-bar resolution string ("1" | "5" | "15" | "60"). */
const RES_SECS: Record<string, number> = { "1": 60, "5": 300, "15": 900, "60": 3600 };

/** PARTIAL-ROW HOLD window (see reconcile()): Yahoo's CME chart feed lags ~10 min; 20 min = lag
 *  + margin before a derived coarse row is trusted over a complete tick-built local candle. */
const PARTIAL_HOLD_SEC = 20 * 60;

/** Age (ms) of a live `tick` message. Prefers the SERVER-computed `ageMs` (MotiveWave and the
 *  server share a clock, so a tunnel/phone client with a skewed clock can still tell a live tick
 *  from a stale one); falls back to browser-clock `Date.now() − msg.time` for older servers.
 *  A tick with neither field reads as age 0 (the disk-heartbeat tick carries no time). */
function tickAgeMs(msg: any): number {
  if (typeof msg?.ageMs === "number" && Number.isFinite(msg.ageMs)) return msg.ageMs;
  const t = Number(msg?.time);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Date.now() - (t < 1e11 ? t * 1000 : t); // tolerate a seconds-denominated time
}

export interface TerminalData {
  candles: TerminalCandle[];
  signals: TerminalSignal[];
  lastPrice: number | null;
  connected: boolean;
  source: string;
  /** MotiveWave feed health from the server (`feedStatus` WS message). */
  feedStatus: "live" | "stale" | "unknown";
  /** CONTRACT GUARD state from the server (`contract_guard` WS message); null until the first
   *  message (older servers never send one). Drives the MarketView LIVE/DELAYED badge. */
  guard: TerminalGuard | null;
  /** INTERIOR REPAINT (2026-09-18): bumped whenever reconcile() REPLACED the OHLC of an
   *  already-loaded CLOSED bar that is not the tail (provisional → canonical, tick-built →
   *  server-official). Such a merge leaves length / first time / last time unchanged, which is
   *  exactly TerminalLiveChart's tick fast-path signature — the chart keys a full repaint on
   *  this counter instead. Monotonically increasing. */
  candlesRevision: number;
  /** Pull the full deep history (call when the user scrolls to the left edge). */
  loadMoreHistory: () => void;
  /** True once the full history has been loaded (no more to fetch). */
  fullyLoaded: boolean;
  /** Last auto-trade order the server placed (for a visible "order placed" toast). */
  autoTradeFired: { id: number; symbol: string; direction: string; interval: string; price: number; contracts: number } | null;
  /** Bumped on a `signals_resync` WS broadcast (bulk signal_history wipe+reinsert) — consumers
   *  with their own signal fetches (SignalsView date-browse) key a refetch effect on it. */
  signalsResyncNonce: number;
}

export function useTerminalData(symbol: string, interval: string, reloadToken: number): TerminalData {
  const [candles, setCandles] = useState<TerminalCandle[]>([]);
  const [signals, setSignals] = useState<TerminalSignal[]>([]);
  // RESYNC (2026-07-30): bumped on a `signals_resync` WS broadcast (regen --persist finished a
  // bulk wipe+reinsert). Consumers with their OWN signal fetches (SignalsView date-browse) key
  // an effect on it so they refetch too; this hook's live list refetches directly.
  const [signalsResyncNonce, setSignalsResyncNonce] = useState(0);
  // Gen of the last SUCCESSFUL signals fetch — lets the fetch-failure path distinguish "transient
  // failure, displayed set is still for this symbol/interval" (keep it) from "failed after a
  // symbol/interval switch" (blank it — cross-interval rows must never linger).
  const signalsGenRef = useRef(-1);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [source, setSource] = useState("");
  const [feedStatus, setFeedStatus] = useState<"live" | "stale" | "unknown">("unknown");
  const [autoTradeFired, setAutoTradeFired] = useState<TerminalData["autoTradeFired"]>(null);

  const symRef = useRef(symbol);
  const resRef = useRef(intervalToResolution(interval));
  const intervalRef = useRef(interval);
  const lastCloseRef = useRef(0); // last good close — used to clamp corrupt live ticks
  // Mirror of the last candle so the live tick/bar handlers can bucket + merge without
  // depending on setState's `prev` (keeps lastPrice / refs consistent with the chart).
  const lastBarRef = useRef<TerminalCandle | null>(null);
  // Throttle the per-tick candle re-render: copying a 100k-bar array on every tick (and
  // re-rendering the whole terminal) is the main live-feed lag. We coalesce same-bar tick
  // updates to ~8/sec (leading + trailing) — the price readout still updates on every tick.
  const tickEmitRef = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | null }>({ last: 0, timer: null });
  const TICK_EMIT_MS = 120;
  // CHART LIVENESS (2026-09-18 — "the chart is having trouble staying live / is laggy"):
  //  • lastTickAcceptMsRef — wall-clock ms of the last ACCEPTED tick. While ticks are flowing the
  //    forming candle's close is tick-owned: a same-bucket `bar` message that is not the live
  //    close (a forming bar, or a delayed Yahoo sub-bar) may widen high/low but never rewind it.
  //  • candlesMirrorRef — the candles array as last RENDERED (what the chart is showing). Lets
  //    reconcile() / the contract-guard reset inspect the dataset OUTSIDE a setState updater, so
  //    every updater stays pure (React StrictMode double-invokes updaters in dev).
  //  • guard / candlesRevision — see TerminalData.
  //  • regimeResetBucketRef — the wall-clock bucket in which a contract-guard regime reset dropped
  //    the forming candle. For THAT bucket only, reconcile() unions the server's row with the
  //    re-opened tick candle (canonical open + both extremes, live close) instead of letting the
  //    seconds-old tick candle mask it — on a 60m chart the reset would otherwise blank up to an
  //    hour of the bucket's range until it closed.
  const lastTickAcceptMsRef = useRef(0);
  const regimeResetBucketRef = useRef(0);
  const candlesMirrorRef = useRef<TerminalCandle[]>([]);
  candlesMirrorRef.current = candles;
  const [guard, setGuard] = useState<TerminalGuard | null>(null);
  const [candlesRevision, setCandlesRevision] = useState(0);
  symRef.current = symbol;
  resRef.current = intervalToResolution(interval);
  intervalRef.current = interval;

  // Lazy-history state: open fast with a recent window, pull the full history only when the
  // user scrolls back to the left edge (TerminalLiveChart calls loadMoreHistory).
  const [fullyLoaded, setFullyLoaded] = useState(false);
  const fullyLoadedRef = useRef(false);
  const loadingMoreRef = useRef(false);
  fullyLoadedRef.current = fullyLoaded;

  // FETCH-GENERATION TOKEN: bumped on every symbol / interval / reload change. Every async
  // fetch captures the generation before awaiting and discards its response if a newer
  // generation started meanwhile — a slow old-interval response can never clobber the new
  // interval's dataset (the "interval switch strands the view in the past" bug).
  const genRef = useRef(0);
  // Earliest loaded candle time — the loaded-range floor. data_updated refreshes re-fetch from
  // here (not the 10-day fast-open window) so lazily-loaded deep history is never wiped.
  const floorRef = useRef(0);

  // ── Candle fetch (re-runs on symbol / interval / reload button) ──────────────
  // FAST OPEN: initial load fetches only the last FAST_OPEN_DAYS so the chart paints instantly.
  // RETRY ON FAILURE (2026-08-18 — "trading.jacksonlems.com for the chart doesnt work"): through
  // the Cloudflare tunnel the FIRST fetch occasionally 502s, and the old one-shot left the chart
  // WEDGED at zero candles until a manual reload (the JournalView/LedgerView one-shot-probe
  // lesson, third instance). Failures now retry on a 4s→8s→16s→30s backoff, generation-guarded
  // so interval/symbol switches cancel any pending retry.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const fetchCandles = useCallback(async () => {
    const gen = genRef.current;
    const scheduleRetry = (): void => {
      if (gen !== genRef.current) return;
      const delay = Math.min(4000 * 2 ** retryAttemptRef.current, 30_000);
      retryAttemptRef.current++;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => { if (gen === genRef.current) void fetchCandles(); }, delay);
    };
    try {
      const from = Math.floor(Date.now() / 1000) - FAST_OPEN_DAYS * 86400;
      const res = await fetch(`/api/data/cached-continuous/${encodeURIComponent(symbol)}/${interval}?from=${from}`);
      if (!res.ok) throw new Error(`candles HTTP ${res.status}`); // tunnel 502s must NOT read as "no data"
      const data = await res.json();
      if (gen !== genRef.current) return; // stale response for a previous symbol/interval
      const raw = Array.isArray(data?.candles) ? data.candles : [];
      const mapped = cleanRows(raw, interval).slice(-MAX_CANDLES);
      retryAttemptRef.current = 0;
      setCandles(mapped);
      setSource(typeof data?.source === "string" ? data.source : "");
      floorRef.current = mapped.length ? mapped[0].time : 0;
      lastBarRef.current = mapped.length ? mapped[mapped.length - 1] : null;
      if (mapped.length) { setLastPrice(mapped[mapped.length - 1].c); lastCloseRef.current = mapped[mapped.length - 1].c; }
    } catch {
      if (gen === genRef.current) { setCandles([]); scheduleRetry(); }
    }
  }, [symbol, interval]);

  // Reset the lazy-history flag whenever the symbol / interval / reload token changes, then
  // (re)load the fast-open window. Bumps the fetch generation and CLEARS the old-interval
  // dataset + lastBarRef so in-flight responses and live ticks from the old interval can't
  // mutate the chart during the switch.
  useEffect(() => {
    genRef.current++;
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    retryAttemptRef.current = 0;
    setFullyLoaded(false);
    fullyLoadedRef.current = false;
    loadingMoreRef.current = false;
    lastBarRef.current = null;
    floorRef.current = 0;
    setCandles([]);
    fetchCandles();
  }, [fetchCandles, reloadToken]);

  // ── Deep history (lazy) ──────────────────────────────────────────────────────
  // Fetches the deep window and MERGES it under the already-loaded recent window + live
  // forming bar. Called once, when the user scrolls near the left edge.
  // CANDLE WINDOW (2026-09-24): the server now caps every served span, so "no `from`" no
  // longer means the entire dataset. 15m / 60m ask for `full=1` (the only intervals the server
  // honors it for); 1m / 5m request their capped window explicitly (1m 14 d, 5m 90 d).
  const loadMoreHistory = useCallback(async () => {
    if (fullyLoadedRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const gen = genRef.current;
    try {
      const q = terminalDeepHistoryQuery(interval, Math.floor(Date.now() / 1000));
      const res = await fetch(`/api/data/cached-continuous/${encodeURIComponent(symbol)}/${interval}?${q}`);
      if (!res.ok) throw new Error(`deep history HTTP ${res.status}`); // keep current candles; scroll again to retry
      const data = await res.json();
      if (gen !== genRef.current) return; // interval/symbol changed while loading — discard
      const raw = Array.isArray(data?.candles) ? data.candles : [];
      const full = cleanRows(raw, interval);
      if (!full.length) return;
      setCandles((prev) => {
        const m = new Map<number, TerminalCandle>();
        for (const c of full) m.set(c.time, c);
        for (const c of prev) m.set(c.time, c); // recent + live forming bar win over historical
        const arr = [...m.values()].sort((a, b) => a.time - b.time).slice(-MAX_CANDLES);
        floorRef.current = arr.length ? arr[0].time : 0;
        return arr;
      });
      setFullyLoaded(true);
      fullyLoadedRef.current = true;
    } catch {
      /* keep current candles on error — user can scroll again to retry */
    } finally {
      loadingMoreRef.current = false;
    }
  }, [symbol, interval]);

  // ── Signal fetch ────────────────────────────────────────────────────────────
  const fetchSignals = useCallback(async () => {
    const gen = genRef.current;
    try {
      // Cover the LOADED CANDLE RANGE: signals back to the earliest loaded candle (at minimum
      // the last 30 days), so markers appear on lazily-loaded deep history too. The chart's
      // own time-range filter (minT/maxT in TerminalLiveChart) trims to visible candles.
      const cutoff = Math.min(
        floorRef.current > 0 ? floorRef.current : Infinity,
        Math.floor(Date.now() / 1000) - 30 * 86400,
      );
      // PERF (2026-07-30): `since` mirrors the cutoff filter below — the server pre-trims the
      // response (the 1m interval is ~2MB unfiltered). Older servers ignore the param and the
      // client-side filter below stays as defense in depth either way.
      const res = await fetch(`/api/signals/history/${encodeURIComponent(symbol)}/${interval}?since=${Number.isFinite(cutoff) ? Math.floor(cutoff) : 0}`);
      const data = await res.json();
      if (gen !== genRef.current) return; // stale response for a previous symbol/interval
      const rows: SignalRow[] = Array.isArray(data?.signals) ? data.signals : [];
      const mapped = rows
        .filter((r) => r && Number.isFinite(r.entry) && r.timestamp >= cutoff)
        // SIGNAL-INTEGRITY (D1): the SHARED rule validator — bar-CLOSE time semantics
        // (timestamp + interval secs) checking break/weekend/15:15/ETH-purity. Redundant with
        // the server's C2 read filter by design (defense in depth); identical logic on both
        // sides via shared/signal-rules.ts so chart and tab can never disagree.
        .filter((r) => isSessionLegalSignal(r.timestamp, interval, r.signalType))
        .map(mapSignal)
        .sort((a, b) => a.ts - b.ts);
      setSignals(mapped); // D2: no cluster dedupe — every rule-compliant persisted signal shows
      signalsGenRef.current = gen;
    } catch {
      // RESILIENCE (2026-07-30): a transient endpoint stall (server event loop queued behind a
      // bulk write / OneDrive I/O burst) used to BLANK the Signals tab + chart markers here until
      // the 120s safety poll healed it. Keep the displayed set when it belongs to this same
      // symbol/interval (gen match); blank ONLY when the failure follows a symbol/interval
      // switch, so stale cross-interval rows never survive. A newer in-flight fetch (gen
      // mismatch vs genRef) owns the state — touch nothing.
      if (gen === genRef.current && signalsGenRef.current !== gen) setSignals([]);
    }
  }, [symbol, interval]);

  // Initial fetch + refetch when deep history finishes loading (fullyLoaded flips true after
  // floorRef moved back) so old signals appear on the newly-loaded range.
  useEffect(() => { fetchSignals(); }, [fetchSignals, fullyLoaded]);

  // PERF (2026-07-30): incremental application of `signal_new` rows (the broadcast now carries
  // the upserted rows) — replaces the refetch-everything-on-every-fire pattern. Applies the SAME
  // filters as fetchSignals (finite entry / loaded-range cutoff / shared session validator) and
  // mirrors the server upsert's COALESCE guards: a null label/signalType/exit field in the
  // payload keeps the stored (already-displayed) value.
  const applySignalRows = useCallback((rows: SignalRow[]) => {
    const cutoff = Math.min(
      floorRef.current > 0 ? floorRef.current : Infinity,
      Math.floor(Date.now() / 1000) - 30 * 86400,
    );
    setSignals(prev => {
      const by = new Map(prev.map(s => [s.id, s]));
      let changed = false;
      for (const r of rows) {
        if (!r || !Number.isFinite(r.entry) || r.timestamp < cutoff) continue;
        if (!isSessionLegalSignal(r.timestamp, intervalRef.current, r.signalType)) continue;
        const ex = by.get(`${r.timestamp}-${r.direction}`);
        // OUTCOME-GUARD (2026-07-31): mirror the server's first-touch immutability — only a
        // REAL allowed outcome change (open→*, win_tp1→win_tp2) lets the payload's record
        // win; identity/no-op payloads and locked transitions (e.g. win_tp1 → loss from a
        // stale tab or a pre-guard server) keep the displayed outcome AND exit fields
        // (payload values only fill displayed NULLs).
        const realChange = !!ex && r.outcome != null && r.outcome !== ex.outcome && isOutcomeTransitionAllowed(ex.outcome, r.outcome);
        const merged: SignalRow = ex ? {
          ...r,
          signalType:   r.signalType ?? ex.signalType,
          label:        r.label ?? ex.label,
          outcome:      realChange ? r.outcome : ex.outcome,
          exitPrice:    realChange ? (r.exitPrice ?? ex.exitPrice) : (ex.exitPrice ?? r.exitPrice),
          exitTs:       realChange ? (r.exitTs ?? ex.exitTs) : (ex.exitTs ?? r.exitTs),
          pointsResult: realChange ? (r.pointsResult ?? ex.pointsResult) : (ex.pointsResult ?? r.pointsResult),
          mae:          realChange ? (r.mae ?? ex.mae) : (ex.mae ?? r.mae),
          mfe:          realChange ? (r.mfe ?? ex.mfe) : (ex.mfe ?? r.mfe),
          barsToExit:   realChange ? (r.barsToExit ?? ex.barsToExit) : (ex.barsToExit ?? r.barsToExit),
          // RISK DISPLAY: mirror the upsert's COALESCE — a null payload keeps displayed values
          // (ex.riskFlags is the parsed array; parseRiskFlags in mapSignal accepts it as-is).
          comboKey:     r.comboKey ?? ex.comboKey,
          riskFlags:    r.riskFlags ?? ex.riskFlags,
        } : r;
        const m = mapSignal(merged);
        by.set(m.id, m);
        changed = true;
      }
      if (!changed) return prev;
      return [...by.values()].sort((a, b) => a.ts - b.ts);
    });
  }, []);

  // SAFETY poll — catches any signals whose signal_new WS broadcast was missed (e.g. brief
  // disconnect) and refreshes ACTIVE→EXPIRED statuses. PERF (2026-07-30): 30s → 120s; live
  // updates arrive incrementally over WS now, so the poll is a slow backstop, not the pipe.
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) void fetchSignals(); }, 120_000);
    return () => clearInterval(id);
  }, [fetchSignals]);

  // ── Periodic candle reconciliation ───────────────────────────────────────────
  // Re-pull completed bars from the engine's DB and MERGE, so any bar missed during
  // a live WS hiccup is recovered and the chart never drifts stale. The current
  // forming candle (live ticks) is preserved. This is the terminal's equivalent of
  // market.tsx's HTTP poll fallback. Runs every 15s; off when the tab is hidden.
  // `holdFromSec` = TerminalGuard.translatingSinceSec AT CALL TIME (0 = not translating; see
  // PARTIAL-ROW HOLD below). A parameter — not a ref — on purpose: a new hook in this file changes
  // the hook count, and a hooks-count change over HMR wedges already-open tabs (Learnings 2026-09-18).
  const reconcile = useCallback(async (fromOverride?: number, holdFromSec: number = 0) => {
    const gen = genRef.current;
    try {
      // Only re-pull the recent window — deep history doesn't change, so this stays light
      // and MERGES on top of whatever is loaded (preserving lazily-loaded deep history).
      // data_updated passes fromOverride = the loaded floor so the whole loaded range refreshes.
      const from = fromOverride ?? Math.floor(Date.now() / 1000) - FAST_OPEN_DAYS * 86400;
      const res = await fetch(`/api/data/cached-continuous/${encodeURIComponent(symbol)}/${interval}?from=${from}`);
      const data = await res.json();
      if (gen !== genRef.current) return; // interval/symbol changed while fetching — discard
      const raw = Array.isArray(data?.candles) ? data.candles : [];
      const server = cleanRows(raw, interval);
      if (typeof data?.source === "string") setSource(data.source);
      if (!server.length) return;
      // PARTIAL-ROW HOLD (2026-09-18, contract guard — adversarial review). While the guard
      // reports translationActive, Yahoo's ~10-min-delayed 1m poll is the store's only writer
      // and the 5m/15m/60m rows are re-derived after every 1m it lands — so the server's row
      // for a bucket that closed a few minutes ago is PARTIAL (built from the 1m bars that have
      // arrived so far), while the local candle for that bucket is COMPLETE (built tick by tick
      // from the translated MotiveWave stream). "Server wins on closed buckets" swapped the
      // complete candle for the partial one for ~10 min (candlesRevision made it visible: a
      // closed bar shrinking, then growing back). Rule: while translating, a server row whose
      // bucket END is younger than now − 20 min never REPLACES an existing local candle; it
      // still fills a hole, and it is taken on a later pass once it is older (Yahoo's lag
      // + margin). ONLY buckets that STARTED at/after holdFromSec qualify — the moment this
      // client began receiving translated ticks under the current regime (flip / roll / WS
      // connect): an older local candle was built on the OTHER regime (at a trip: raw
      // wrong-month prints, ~66 pts off) or across a disconnect, and the canonical row must
      // still replace it at once. Not translating (on-contract, or Yahoo driving) → unchanged.
      const holdAfter = holdFromSec > 0
        ? Math.floor(Date.now() / 1000) - PARTIAL_HOLD_SEC - ivSecs(intervalRef.current)
        : Infinity;
      const held = (t: number): boolean => t > holdAfter && t >= holdFromSec; // bucket end (t + sec) > now − 20 min, bucket inside the regime
      // INTERIOR REPAINT (2026-09-18): did the server REPLACE the OHLC of a bar the chart is
      // already showing? That happens every bar now — the tick-built candle of a just-closed
      // bucket vs the server's official bar, and (contract guard) a provisional translated bar
      // vs Yahoo's canonical one ~10 min later. Such a merge changes neither the array length
      // nor its first/last time, which is exactly TerminalLiveChart's tick FAST-PATH signature
      // (series.update of the LAST bar only) — so the replaced bar kept rendering its old shape
      // until the next structural setData, and then several candles changed at once. Detect it
      // HERE, against the last-rendered mirror and OUTSIDE the state updater (updaters must stay
      // pure — StrictMode double-invokes them), and bump candlesRevision in the same batch as
      // the merge below. Both arrays are time-sorted → one binary search + a linear walk. The
      // TAIL bar is skipped (the fast path repaints it) and so is the current wall-clock bucket
      // (the live forming candle is preserved over the server's row below).
      let interiorChanged = false;
      const mirror = candlesMirrorRef.current;
      if (mirror.length > 1) {
        const secD = ivSecs(intervalRef.current);
        const curBucketD = Math.floor(Date.now() / 1000 / secD) * secD;
        const tailTime = mirror[mirror.length - 1].time;
        let lo = 0, hi = mirror.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (mirror[mid].time < server[0].time) lo = mid + 1; else hi = mid; }
        let i = lo;
        for (const sb of server) {
          if (sb.time >= tailTime || sb.time >= curBucketD) break;
          while (i < mirror.length && mirror[i].time < sb.time) i++;
          if (i >= mirror.length) break;
          const mb = mirror[i];
          // (a HELD server row is not applied below → it is not an interior change either)
          if (mb.time === sb.time && !held(sb.time) && (mb.o !== sb.o || mb.h !== sb.h || mb.l !== sb.l || mb.c !== sb.c)) { interiorChanged = true; break; }
        }
      }
      setCandles((prev) => {
        const sec = ivSecs(intervalRef.current);
        const curBucket = Math.floor(Date.now() / 1000 / sec) * sec;
        const live = lastBarRef.current;
        const liveOwnsCur = !!live && live.time === curBucket;
        // PERF NO-OP (2026-09-18 — "laggy"): most 15 s reconciles change NOTHING (the server's
        // rows already sit in the array byte-for-byte), yet every one rebuilt a Map of the whole
        // dataset, re-sorted it (200k bars once deep history is loaded) and returned a NEW array
        // — re-rendering the terminal and every `candles` consumer four times a minute for no
        // visible change. Walk the (time-sorted) server rows against prev first and hand back
        // the SAME array when they are all present and identical. The live bucket is skipped
        // (the forming candle wins there, below) unless this is the regime-reset bucket, whose
        // union with the server row can change.
        if (prev.length && !(liveOwnsCur && regimeResetBucketRef.current === curBucket)) {
          let plo = 0, phi = prev.length;
          while (plo < phi) { const mid = (plo + phi) >> 1; if (prev[mid].time < server[0].time) plo = mid + 1; else phi = mid; }
          let pi = plo, same = true;
          for (const sb of server) {
            if (liveOwnsCur && sb.time === curBucket) continue;
            while (pi < prev.length && prev[pi].time < sb.time) pi++;
            const pb = prev[pi];
            if (pb && pb.time === sb.time && held(sb.time)) continue; // PARTIAL-ROW HOLD: local candle stays → no change
            if (!pb || pb.time !== sb.time || pb.o !== sb.o || pb.h !== sb.h || pb.l !== sb.l || pb.c !== sb.c) { same = false; break; }
          }
          if (same) {
            if (!lastBarRef.current) lastBarRef.current = prev[prev.length - 1];
            return prev;
          }
        }
        const m = new Map<number, TerminalCandle>();
        for (const c of prev) m.set(c.time, c);    // keep everything already loaded (incl. deep history)
        for (const c of server) {                  // overlay fresh recent bars (server wins on CLOSED buckets)
          if (held(c.time) && m.has(c.time)) continue; // PARTIAL-ROW HOLD: never replace a local candle with a young (partial) row
          m.set(c.time, c);
        }
        // Preserve the live forming candle ONLY for the CURRENT wall-clock bucket. A stale
        // local forming bar (ticks stopped mid-bucket) must never overwrite the server's
        // completed row for an already-CLOSED bucket.
        if (live && live.time === curBucket) {
          // REGIME-RESET BUCKET (2026-09-18, contract guard): the live candle here was re-opened
          // seconds ago from a single tick — the server's row for this bucket (front-month
          // canonical, same regime as the translated / re-rolled ticks) is the only record of
          // the bucket's earlier range. Union them: canonical open, both extremes, live close.
          // Idempotent (max/min) so a StrictMode double-invoke lands on the same candle; every
          // other bucket keeps the long-standing "forming candle wins" rule.
          const srv = regimeResetBucketRef.current === curBucket && server[server.length - 1].time === curBucket
            ? server[server.length - 1] : null;
          m.set(live.time, srv ? { time: live.time, o: srv.o, h: Math.max(srv.h, live.h), l: Math.min(srv.l, live.l), c: live.c } : live);
        }
        const arr = [...m.values()].sort((a, b) => a.time - b.time).slice(-MAX_CANDLES);
        lastBarRef.current = arr.length ? arr[arr.length - 1] : null;
        floorRef.current = arr.length ? arr[0].time : 0;
        return arr;
      });
      // Same React batch as the merge above → the chart sees the new array AND the new revision
      // in one render (the `r + 1` updater is pure, so a StrictMode double-invoke bumps once).
      if (interiorChanged) setCandlesRevision((r) => r + 1);
    } catch { /* keep current candles on error */ }
  }, [symbol, interval]);

  // PARTIAL-ROW HOLD input for the poll: the guard STATE (the WS handler keeps its own
  // closure-local copy — it must not wait for a render to see what it just received).
  const pollHoldFromSec = guard?.translationActive ? guard.translatingSinceSec : 0;
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) void reconcile(undefined, pollHoldFromSec); }, 15000);
    return () => clearInterval(id);
  }, [reconcile, pollHoldFromSec]);

  // ── Live WebSocket (tick / bar / data_updated / signal_new) ──────────────────
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    // PARTIAL-ROW HOLD (2026-09-18): epoch sec since which this socket has delivered translated
    // ticks under the current regime (mirrors TerminalGuard.translatingSinceSec; 0 = off).
    // Zeroed on every (re)connect — ticks were missed while disconnected, so the candles built
    // before it are not complete; the on-connect "snapshot" re-seeds it.
    let holdFromSec = 0;

    const matches = (msgSym: unknown) =>
      typeof msgSym === "string" && normSym(msgSym) === normSym(symRef.current);

    const connect = () => {
      const url = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/live-bars`;
      ws = new WebSocket(url);

      ws.onopen = () => { holdFromSec = 0; setConnected(true); };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) reconnect = setTimeout(connect, 2500);
      };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };

      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === "tick" && matches(msg.symbol) && Number.isFinite(msg.price)) {
          const px = Number(msg.price);
          if (px <= 0) return;
          // STALE-TICK GUARD (2026-09-17): a tick older than two minutes is not "live" — the
          // Yahoo fallback's tick carries a bar-close time and Yahoo's CME chart feed runs
          // ~10 min DELAYED, so applying it here painted a ten-minute-old print into the live
          // forming candle every cycle (wicks + a jumping close). Such prices arrive as `bar`
          // messages and via reconcile() instead; MotiveWave ticks are ~0s old and pass.
          // (2026-09-18) The age now comes from the SERVER-computed `msg.ageMs` when present: the
          // browser-clock form (Date.now() − msg.time) dropped EVERY live tick on a client whose
          // clock ran >2 min ahead (phone / tunnel) and admitted stale ones on a clock running
          // behind. Browser-clock math is only the fallback for a server that predates ageMs.
          if (tickAgeMs(msg) > 120_000) return;
          const last = lastBarRef.current;
          if (!last) return; // no candles loaded yet — wait for fetch/bar
          // Bucket the tick to the visible interval so 15m/60m roll over to a NEW candle on
          // their own boundary (the server only emits 1m/5m bars). Mirrors market.tsx.
          const sec = ivSecs(intervalRef.current);
          const bucket = Math.floor(Date.now() / 1000 / sec) * sec;

          if (bucket > last.time) {
            // New bucket → open a fresh candle. Seed open from the tick on a session gap
            // (>0.5% jump) to avoid a phantom catch-up bar; else carry the last close.
            // (2026-09-18) lastCloseRef === 0 marks a contract-guard regime reset: the previous
            // bar's close belongs to the OLD price regime, so seed from the tick even when the
            // regime shift is under 0.5% (a small roll spread / offset re-measure).
            const dev = last.c > 0 ? Math.abs(px - last.c) / last.c : 1;
            const open = dev > 0.005 || lastCloseRef.current <= 0 ? px : last.c;
            const nb: TerminalCandle = { time: bucket, o: open, h: px, l: px, c: px };
            lastBarRef.current = nb;
            lastCloseRef.current = px;
            lastTickAcceptMsRef.current = Date.now(); // the close is tick-owned from here (see bar handler)
            setLastPrice(px);
            // New bar is structural — emit immediately (and cancel any pending throttle).
            const th = tickEmitRef.current;
            if (th.timer) { clearTimeout(th.timer); th.timer = null; }
            th.last = Date.now();
            setCandles((prev) => (prev.length ? [...prev, nb] : [nb]).slice(-MAX_CANDLES));
            return;
          }
          if (bucket < last.time) return; // stale tick before the current bar — ignore
          // Same bucket → clamp absurd single-tick moves (>2% = bad print) then accumulate.
          const ref = lastCloseRef.current;
          if (ref > 0 && Math.abs(px - ref) / ref > 0.02) return;
          const u: TerminalCandle = { time: last.time, o: last.o, h: Math.max(last.h, px), l: Math.min(last.l, px), c: px };
          lastBarRef.current = u;
          lastCloseRef.current = px;
          lastTickAcceptMsRef.current = Date.now();
          setLastPrice(px); // price readout stays per-tick responsive
          // Throttle the (expensive) candle array re-render to ~8/sec. lastBarRef always holds the
          // freshest bar, so the leading/trailing emit shows the latest OHLC.
          const flush = () => {
            const u2 = lastBarRef.current;
            if (!u2) return;
            setCandles((prev) => { if (!prev.length) return prev; const n = prev.slice(); n[n.length - 1] = u2; return n; });
          };
          const now = Date.now();
          const th = tickEmitRef.current;
          if (now - th.last >= TICK_EMIT_MS) {
            th.last = now;
            if (th.timer) { clearTimeout(th.timer); th.timer = null; }
            flush();
          } else if (!th.timer) {
            th.timer = setTimeout(() => { th.timer = null; tickEmitRef.current.last = Date.now(); flush(); }, TICK_EMIT_MS - (now - th.last));
          }
          return;
        }

        if (msg.type === "bar") {
          // The server broadcasts { type:"bar", resolution, bar:{ symbol, time, open, ... } } —
          // the payload is NESTED under `bar` (see live-bars.ts / mw-reader.ts broadcasts).
          // Reading flat msg.* fields left this handler completely dead (msg.symbol undefined),
          // killing the disk-heartbeat fallback when ticks are quiet. Accept both shapes.
          const b = msg.bar && typeof msg.bar === "object" ? msg.bar : msg;
          if (!matches(b.symbol ?? msg.symbol)) return;
          // Resolution gate: accept the interval's base resolution, plus exact "15" bars for 15m.
          const iv = intervalRef.current;
          const msgRes = String(msg.resolution ?? b.resolution ?? "5").replace("m", "");
          const isExact15 = iv === "15m" && msgRes === "15";
          if (msgRes !== resRef.current && !isExact15) return;
          // Bucket 5m bars up to the 15m boundary (the server emits 5m for both 5m & 15m charts).
          const rawTime = Number(b.time);
          const t = iv === "15m" && !isExact15 ? Math.floor(rawTime / 900) * 900 : rawTime;
          const o = Number(b.open), h = Number(b.high), l = Number(b.low), c = Number(b.close);
          // Reject malformed / spike bars so they never render as ghosts.
          if (!Number.isFinite(t) || badBar(o, h, l, c, spikeThr(iv))) return;
          const last = lastBarRef.current;
          // Dataset cleared (interval/symbol switch in flight) — do NOT seed a 1-bar dataset
          // from a live broadcast: the chart would fit that lone bar, mistake the incoming
          // fetch for a deep-history prepend, and strand a collapsed 6-bar view. The pending
          // fetch delivers this bar anyway.
          if (!last) return;
          // Older bucket — ignore (reconcile() delivers it). (2026-09-18) This return used to sit
          // BELOW `lastCloseRef.current = c`, so an IGNORED bar — Yahoo's complete 1m bars arrive
          // ~10 min late and always land here while ticks drive the chart — still became the
          // reference for the tick handler's 2% bad-print clamp. The reference is now only ever
          // a close this handler actually adopted.
          if (t < last.time) return;
          if (t > last.time) {
            // New display bar → append (its OHLC seeds the 15m bucket's open).
            const nb: TerminalCandle = { time: t, o, h, l, c };
            lastBarRef.current = nb;
            lastCloseRef.current = c;
            setCandles((prev) => (prev.length ? [...prev, nb] : [nb]).slice(-MAX_CANDLES));
            setLastPrice(c);
            return;
          }
          // Same display bar → MERGE: keep the bucket open, accumulate high/low, update close.
          // (Replacing would discard high/low from earlier 5m sub-bars of a 15m bucket.)
          // LIVE-CLOSE OWNERSHIP (2026-09-18): while ticks are flowing (one accepted within the
          // last 5 s) the forming candle's close is the TICK's. A same-bucket `bar` that is not
          // the live close must not overwrite it — (a) a FORMING bar (complete !== true: the
          // server throttles those to 1/s and the disk-heartbeat / REST-fallback variants are
          // older still), and (b) a COMPLETE sub-bar whose own bucket ended >2 min ago (Yahoo's
          // CME chart feed is ~10 min delayed: on a 15m chart its 10:00 5m bar can land at 10:12
          // INSIDE the still-forming 10:00 bucket). Either one rewound the close — and the HUD
          // price via setLastPrice — until the next tick snapped it back: the visible backward
          // flicker. High/low are still unioned (a real sub-bar's extremes belong to the bucket);
          // a just-completed bar (MW, bucket end ≈ now) stays authoritative for the close.
          const now = Date.now();
          const tickLive = now - lastTickAcceptMsRef.current < 5000;
          const barEndMs = (rawTime + (RES_SECS[msgRes] ?? ivSecs(iv))) * 1000;
          const keepLiveClose = tickLive && (b.complete !== true || now - barEndMs > 120_000);
          const merged: TerminalCandle = { time: t, o: last.o, h: Math.max(last.h, h), l: Math.min(last.l, l), c: keepLiveClose ? last.c : c };
          // PERF: the 1/s forming bar usually carries NOTHING the ticks have not already painted
          // — skip the state update then (each one copied the whole 100k-bar array and
          // re-rendered the terminal for an identical candle). A pending throttled tick flush
          // still emits lastBarRef on its own timer.
          if (merged.h !== last.h || merged.l !== last.l || merged.c !== last.c) {
            lastBarRef.current = merged;
            setCandles((prev) => { if (!prev.length) return [merged]; const n = prev.slice(); n[n.length - 1] = merged; return n; });
          }
          if (!keepLiveClose) { lastCloseRef.current = c; setLastPrice(c); }
          return;
        }

        if (msg.type === "data_updated" && (!msg.symbol || matches(msg.symbol))) {
          // Silent dataset refresh — MERGE from the currently-loaded floor (not the 10-day
          // fast-open window, which used to WIPE lazily-loaded deep history and could blank
          // the viewport on an empty response). Re-arm the lazy deep-history trigger so
          // scroll-back reloading still works if the server gained earlier data.
          // RANGED (2026-09-18): the server now stamps `fromTs` (sec) = "only rows at/after this
          // time changed" (gap-heal inserts, contract-guard flips, roll repair). Without it EVERY
          // data_updated re-downloaded the entire loaded range — after one scroll-back that is
          // the full deep history (100k+ rows on 1m) per message — and cleared fullyLoaded, which
          // re-armed the deep-history trigger and refetched every signal. Pull only from fromTs
          // (never below the loaded floor) and re-arm the lazy trigger only when data EARLIER
          // than the loaded floor may have appeared. No fromTs → the old whole-range behaviour.
          const floor = floorRef.current;
          const ranged = typeof msg.fromTs === "number" && Number.isFinite(msg.fromTs) && msg.fromTs > 0;
          if (ranged) void reconcile(floor > 0 ? Math.max(floor, Math.floor(msg.fromTs)) : undefined, holdFromSec);
          else void reconcile(floor > 0 ? floor : undefined, holdFromSec);
          if (fullyLoadedRef.current && (!ranged || msg.fromTs < floor)) { setFullyLoaded(false); fullyLoadedRef.current = false; }
          return;
        }

        // CONTRACT GUARD (2026-09-18). Every message (the on-connect "snapshot" included) refreshes
        // the exposed guard state (MarketView's LIVE/DELAYED badge). flip / roll / offset mean the
        // PRICE REGIME of live ticks just changed (raw ↔ translated, or a different offset): the
        // forming candle of the current wall-clock bucket now straddles two regimes — a ~66-pt
        // wick that no later tick can repair. Drop that candle, fall back to the previous bar as
        // the tail, clear the tick-emit throttle and the 2%-clamp reference (it belongs to the
        // old regime and would REJECT the first new-regime ticks on a big spread), then pull the
        // canonical store. The next accepted tick opens a fresh candle (bucket > tail; the >0.5%
        // rule seeds its open from the tick itself). The new tail is read from the rendered
        // mirror, NOT inside the updater (purity) — walking back from the end also covers a
        // just-appended candle the mirror has not rendered yet.
        if (msg.type === "contract_guard" && (!msg.symbol || matches(msg.symbol))) {
          const tr = msg.translation && typeof msg.translation === "object" ? msg.translation : {};
          // PARTIAL-ROW HOLD anchor: (re)start it when translation turns on, on a flip / roll (a
          // NEW regime — candles built before it belong to the other one) and on the first
          // snapshot after a (re)connect (holdFromSec was zeroed in onopen). An "offset"
          // re-centre (1–2 pts) keeps it.
          if (tr.active !== true) holdFromSec = 0;
          else if (holdFromSec === 0 || msg.event === "flip" || msg.event === "roll") holdFromSec = Math.floor(Date.now() / 1000);
          setGuard({
            // (2026-09-18) mixedMonths = the MIXED-MONTHS quarantine: same server-side treatment
            // as off-contract (isMwOffContract() ORs them) but msg.offContract stays false — the
            // badge read LIVE while Yahoo's delayed feed was driving.
            offContract: msg.offContract === true || msg.mixedMonths === true,
            rollPending: msg.rollPending === true,
            translationActive: tr.active === true,
            offsetPts: Number.isFinite(Number(tr.offsetPts)) ? Number(tr.offsetPts) : 0,
            translatingSinceSec: holdFromSec,
          });
          if (msg.event === "flip" || msg.event === "roll" || msg.event === "offset") {
            const sec = ivSecs(intervalRef.current);
            const curBucket = Math.floor(Date.now() / 1000 / sec) * sec;
            const th = tickEmitRef.current;
            if (th.timer) { clearTimeout(th.timer); th.timer = null; }
            th.last = 0;
            lastCloseRef.current = 0;
            lastTickAcceptMsRef.current = 0;
            regimeResetBucketRef.current = curBucket; // reconcile() unions the server row for THIS bucket
            const live = lastBarRef.current;
            if (live && live.time >= curBucket) {
              const mirror = candlesMirrorRef.current;
              let k = mirror.length - 1;
              while (k >= 0 && mirror[k].time >= curBucket) k--;
              lastBarRef.current = k >= 0 ? mirror[k] : null;
              setCandles((prev) => {
                let end = prev.length;
                while (end > 0 && prev[end - 1].time >= curBucket) end--;
                return end === prev.length ? prev : prev.slice(0, end);
              });
            }
            void reconcile(undefined, holdFromSec);
          }
          return;
        }

        if (msg.type === "feedStatus" && (!msg.symbol || matches(msg.symbol))) {
          const st = msg.status;
          if (st === "live" || st === "stale" || st === "unknown") setFeedStatus(st);
          return;
        }

        if (msg.type === "signal_new" && matches(msg.symbol)) {
          // PERF (2026-07-30): the broadcast carries the upserted rows — apply incrementally
          // for OUR interval; other intervals' fires are irrelevant to this consumer (every
          // fire on ANY interval used to trigger a full endpoint refetch in every open tab).
          if (Array.isArray(msg.rows) && typeof msg.interval === "string") {
            if (msg.interval === intervalRef.current) applySignalRows(msg.rows as SignalRow[]);
          } else {
            fetchSignals(); // legacy broadcast without rows
          }
          return;
        }

        // SIGNAL-INTEGRITY (B2): a persisted intra-candle signal was retracted (reaction
        // cancelled before bar close) — drop it immediately. Incremental by the same natural
        // key as the DB row; falls back to a full refetch on a legacy payload.
        if (msg.type === "signal_removed" && matches(msg.symbol)) {
          if (typeof msg.interval === "string" && Number.isFinite(msg.timestamp) && typeof msg.direction === "string") {
            if (msg.interval !== intervalRef.current) return;
            const id = `${msg.timestamp}-${msg.direction}`;
            setSignals(prev => (prev.some(s => s.id === id) ? prev.filter(s => s.id !== id) : prev));
          } else {
            fetchSignals();
          }
          return;
        }

        // RESYNC (2026-07-30): the regen harness finished a bulk --persist wipe+reinsert of
        // signal_history. Incremental signal_new/signal_removed cannot convey a mass replacement
        // (the wipe happens on the harness's own DB connection), so do a FULL refetch — it
        // REPLACES state, covering deletions — and bump the nonce so SignalsView's date-browse
        // (its own fetch) reloads too. Absent symbol = all symbols.
        if (msg.type === "signals_resync" && (!msg.symbol || matches(msg.symbol))) {
          void fetchSignals();
          setSignalsResyncNonce((n) => n + 1);
          return;
        }

        if (msg.type === "auto_trade_fired") {
          setAutoTradeFired({
            id: Date.now(),
            symbol: String(msg.symbol ?? ""),
            direction: String(msg.direction ?? ""),
            interval: String(msg.interval ?? ""),
            price: Number(msg.price ?? 0),
            contracts: Number(msg.contracts ?? 0),
          });
          return;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnect) clearTimeout(reconnect);
      if (tickEmitRef.current.timer) { clearTimeout(tickEmitRef.current.timer); tickEmitRef.current.timer = null; }
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [fetchSignals, reconcile, applySignalRows]);

  return { candles, signals, lastPrice, connected, source, feedStatus, guard, candlesRevision, loadMoreHistory, fullyLoaded, autoTradeFired, signalsResyncNonce };
}
