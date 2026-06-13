// useTerminalData.ts — wires the MERIDIAN terminal to REAL data sources:
//   • Candles  → GET /api/data/cached-continuous/:symbol/:interval
//   • Signals  → GET /api/signals/history/:symbol/:interval  (+ live `signal_new` over WS)
//   • Live     → /ws/live-bars  `tick` (last price + forming candle) / `bar` (new candle)
//                `data_updated` (silent dataset refresh, no wave re-reveal)
//
// The MarketPage engine stays mounted (hidden) and remains the producer of all of this;
// this hook is a pure consumer, exactly like the iPhone app.
import { useEffect, useRef, useState, useCallback } from "react";
import { isRTH } from "@/lib/trading-utils";

export interface TerminalCandle { time: number; o: number; h: number; l: number; c: number; }

export type SignalStatus = "ACTIVE" | "TP1 HIT" | "TARGET" | "STOPPED" | "FILLED" | "EXPIRED";

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
  tp2: number;
  status: SignalStatus;
  pnl: number | null;
  // raw extras for the detail view
  signalType: string | null;
  outcome: string | null;
  confirmations: string | null;   // JSON {milkOk, milkPts, vecOk, secondaryVecOk, ...}
  footprintReading: string | null; // JSON FootprintReading
}

export interface SignalRow {
  timestamp: number;
  direction: string;
  riskLevel: string;
  signalType: string | null;
  entry: number;
  tp1: number;
  tp2: number;
  sl: number;
  outcome: string | null;
  confirmations: string | null;
  footprintReading: string | null;
}

// Keep ALL available history (user wants the full dataset, however large). lightweight-charts
// v5 renders 100k+ candles efficiently with viewport culling, so this is a soft safety cap,
// not a display window. (5m ≈ 100k bars back to 2025; 15m ≈ 84k back to 2022.)
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

function fmtEtTime(tsSec: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(tsSec * 1000));
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
    case "stop": return "STOPPED";
    case "filled": return "FILLED";
    default: return "ACTIVE";
  }
}

function mapPnl(r: SignalRow): number | null {
  const dir = r.direction.toLowerCase().startsWith("l") ? 1 : -1;
  switch ((r.outcome ?? "").toLowerCase()) {
    case "win_tp2": case "win": case "target": return +((r.tp2 - r.entry) * dir).toFixed(2);
    case "win_tp1": case "tp1": return +((r.tp1 - r.entry) * dir).toFixed(2);
    case "loss": case "stopped": case "stop": return +((r.sl - r.entry) * dir).toFixed(2);
    default: return null; // ACTIVE / FILLED → unrealized
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
    strat: r.signalType || "Confluence",
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
  };
}

// Collapse "bundled" signals: the engine can emit several same-direction signals on
// consecutive bars (a cluster of S/S/S or L/L/L). For a clean chart + readable list, keep only
// the FIRST signal of each same-direction cluster within a few bars. Expects ASC-sorted input.
export function dedupeSignals(sigs: TerminalSignal[], interval: string): TerminalSignal[] {
  const sec = INTERVAL_SECS[interval] ?? 300;
  const windowSec = sec * 5; // signals of the same side within ~5 bars = one cluster
  const out: TerminalSignal[] = [];
  const lastBySide: Record<string, number> = {};
  for (const s of sigs) {
    const last = lastBySide[s.side];
    if (last != null && s.ts - last < windowSec) continue; // inside an existing cluster — drop
    out.push(s);
    lastBySide[s.side] = s.ts;
  }
  return out;
}

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

export interface TerminalData {
  candles: TerminalCandle[];
  signals: TerminalSignal[];
  lastPrice: number | null;
  connected: boolean;
  source: string;
  /** MotiveWave feed health from the server (`feedStatus` WS message). */
  feedStatus: "live" | "stale" | "unknown";
  /** Pull the full deep history (call when the user scrolls to the left edge). */
  loadMoreHistory: () => void;
  /** True once the full history has been loaded (no more to fetch). */
  fullyLoaded: boolean;
  /** Last auto-trade order the server placed (for a visible "order placed" toast). */
  autoTradeFired: { id: number; symbol: string; direction: string; interval: string; price: number; contracts: number } | null;
}

export function useTerminalData(symbol: string, interval: string, reloadToken: number): TerminalData {
  const [candles, setCandles] = useState<TerminalCandle[]>([]);
  const [signals, setSignals] = useState<TerminalSignal[]>([]);
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
  symRef.current = symbol;
  resRef.current = intervalToResolution(interval);
  intervalRef.current = interval;

  // Lazy-history state: open fast with a recent window, pull the full history only when the
  // user scrolls back to the left edge (TerminalLiveChart calls loadMoreHistory).
  const [fullyLoaded, setFullyLoaded] = useState(false);
  const fullyLoadedRef = useRef(false);
  const loadingMoreRef = useRef(false);
  fullyLoadedRef.current = fullyLoaded;

  // ── Candle fetch (re-runs on symbol / interval / reload button) ──────────────
  // FAST OPEN: initial load fetches only the last FAST_OPEN_DAYS so the chart paints instantly.
  const fetchCandles = useCallback(async () => {
    try {
      const from = Math.floor(Date.now() / 1000) - FAST_OPEN_DAYS * 86400;
      const res = await fetch(`/api/data/cached-continuous/${encodeURIComponent(symbol)}/${interval}?from=${from}`);
      const data = await res.json();
      const raw = Array.isArray(data?.candles) ? data.candles : [];
      const mapped = cleanRows(raw, interval).slice(-MAX_CANDLES);
      setCandles(mapped);
      setSource(typeof data?.source === "string" ? data.source : "");
      lastBarRef.current = mapped.length ? mapped[mapped.length - 1] : null;
      if (mapped.length) { setLastPrice(mapped[mapped.length - 1].c); lastCloseRef.current = mapped[mapped.length - 1].c; }
    } catch {
      setCandles([]);
    }
  }, [symbol, interval]);

  // Reset the lazy-history flag whenever the symbol / interval / reload token changes, then
  // (re)load the fast-open window.
  useEffect(() => {
    setFullyLoaded(false);
    fullyLoadedRef.current = false;
    loadingMoreRef.current = false;
    fetchCandles();
  }, [fetchCandles, reloadToken]);

  // ── Deep history (lazy) ──────────────────────────────────────────────────────
  // Fetches the ENTIRE dataset (no `from`) and MERGES it under the already-loaded recent
  // window + live forming bar. Called once, when the user scrolls near the left edge.
  const loadMoreHistory = useCallback(async () => {
    if (fullyLoadedRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    try {
      const res = await fetch(`/api/data/cached-continuous/${encodeURIComponent(symbol)}/${interval}`);
      const data = await res.json();
      const raw = Array.isArray(data?.candles) ? data.candles : [];
      const full = cleanRows(raw, interval);
      if (!full.length) { loadingMoreRef.current = false; return; }
      setCandles((prev) => {
        const m = new Map<number, TerminalCandle>();
        for (const c of full) m.set(c.time, c);
        for (const c of prev) m.set(c.time, c); // recent + live forming bar win over historical
        return [...m.values()].sort((a, b) => a.time - b.time).slice(-MAX_CANDLES);
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
    try {
      const res = await fetch(`/api/signals/history/${encodeURIComponent(symbol)}/${interval}`);
      const data = await res.json();
      const rows: SignalRow[] = Array.isArray(data?.signals) ? data.signals : [];
      // Show all signals from the last 30 days — the chart's own time-range filter (minT/maxT
      // in TerminalLiveChart) keeps only the markers that fall within the visible candles.
      // The old "today only" filter caused only ~5 signals to appear on a multi-day chart.
      const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
      const mapped = rows
        .filter((r) => r && Number.isFinite(r.entry) && r.timestamp >= cutoff)
        .map(mapSignal)
        // USER RULE: in ETH, show ONLY vector side-entry signals — drop any other ETH signal.
        .filter((s) => isRTH(s.ts) || s.signalType === "vector-side-entry")
        .sort((a, b) => a.ts - b.ts);
      setSignals(dedupeSignals(mapped, interval)); // collapse bundled same-direction clusters
    } catch {
      setSignals([]);
    }
  }, [symbol, interval]);

  useEffect(() => { fetchSignals(); }, [fetchSignals]);

  // Periodic signal refresh — catches any signals whose signal_new WS broadcast was
  // missed (e.g. brief disconnect) and picks up outcome updates on open signals.
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) void fetchSignals(); }, 30_000);
    return () => clearInterval(id);
  }, [fetchSignals]);

  // ── Periodic candle reconciliation ───────────────────────────────────────────
  // Re-pull completed bars from the engine's DB and MERGE, so any bar missed during
  // a live WS hiccup is recovered and the chart never drifts stale. The current
  // forming candle (live ticks) is preserved. This is the terminal's equivalent of
  // market.tsx's HTTP poll fallback. Runs every 15s; off when the tab is hidden.
  const reconcile = useCallback(async () => {
    try {
      // Only re-pull the recent window — deep history doesn't change, so this stays light
      // and MERGES on top of whatever is loaded (preserving lazily-loaded deep history).
      const from = Math.floor(Date.now() / 1000) - FAST_OPEN_DAYS * 86400;
      const res = await fetch(`/api/data/cached-continuous/${encodeURIComponent(symbol)}/${interval}?from=${from}`);
      const data = await res.json();
      const raw = Array.isArray(data?.candles) ? data.candles : [];
      const server = cleanRows(raw, interval);
      if (typeof data?.source === "string") setSource(data.source);
      if (!server.length) return;
      setCandles((prev) => {
        const m = new Map<number, TerminalCandle>();
        for (const c of prev) m.set(c.time, c);    // keep everything already loaded (incl. deep history)
        for (const c of server) m.set(c.time, c);  // overlay fresh recent bars
        // Preserve the live forming candle if it's at/after the server's latest completed bar.
        const live = lastBarRef.current;
        const lastServerT = server[server.length - 1].time;
        if (live && live.time >= lastServerT) m.set(live.time, live);
        const arr = [...m.values()].sort((a, b) => a.time - b.time).slice(-MAX_CANDLES);
        lastBarRef.current = arr.length ? arr[arr.length - 1] : null;
        return arr;
      });
    } catch { /* keep current candles on error */ }
  }, [symbol, interval]);

  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) void reconcile(); }, 15000);
    return () => clearInterval(id);
  }, [reconcile]);

  // ── Live WebSocket (tick / bar / data_updated / signal_new) ──────────────────
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const matches = (msgSym: unknown) =>
      typeof msgSym === "string" && normSym(msgSym) === normSym(symRef.current);

    const connect = () => {
      const url = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/live-bars`;
      ws = new WebSocket(url);

      ws.onopen = () => setConnected(true);
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
          const last = lastBarRef.current;
          if (!last) return; // no candles loaded yet — wait for fetch/bar
          // Bucket the tick to the visible interval so 15m/60m roll over to a NEW candle on
          // their own boundary (the server only emits 1m/5m bars). Mirrors market.tsx.
          const sec = ivSecs(intervalRef.current);
          const bucket = Math.floor(Date.now() / 1000 / sec) * sec;

          if (bucket > last.time) {
            // New bucket → open a fresh candle. Seed open from the tick on a session gap
            // (>0.5% jump) to avoid a phantom catch-up bar; else carry the last close.
            const dev = last.c > 0 ? Math.abs(px - last.c) / last.c : 1;
            const open = dev > 0.005 ? px : last.c;
            const nb: TerminalCandle = { time: bucket, o: open, h: px, l: px, c: px };
            lastBarRef.current = nb;
            lastCloseRef.current = px;
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

        if (msg.type === "bar" && matches(msg.symbol)) {
          // Resolution gate: accept the interval's base resolution, plus exact "15" bars for 15m.
          const iv = intervalRef.current;
          const msgRes = String(msg.resolution);
          const isExact15 = iv === "15m" && msgRes === "15";
          if (msgRes !== resRef.current && !isExact15) return;
          // Bucket 5m bars up to the 15m boundary (the server emits 5m for both 5m & 15m charts).
          const rawTime = Number(msg.time);
          const t = iv === "15m" && !isExact15 ? Math.floor(rawTime / 900) * 900 : rawTime;
          const o = Number(msg.open), h = Number(msg.high), l = Number(msg.low), c = Number(msg.close);
          // Reject malformed / spike bars so they never render as ghosts.
          if (!Number.isFinite(t) || badBar(o, h, l, c, spikeThr(iv))) return;
          lastCloseRef.current = c;
          const last = lastBarRef.current;
          if (!last || t > last.time) {
            // New display bar → append (its OHLC seeds the 15m bucket's open).
            const nb: TerminalCandle = { time: t, o, h, l, c };
            lastBarRef.current = nb;
            setCandles((prev) => (prev.length ? [...prev, nb] : [nb]).slice(-MAX_CANDLES));
          } else if (t === last.time) {
            // Same display bar → MERGE: keep the bucket open, accumulate high/low, update close.
            // (Replacing would discard high/low from earlier 5m sub-bars of a 15m bucket.)
            const merged: TerminalCandle = { time: t, o: last.o, h: Math.max(last.h, h), l: Math.min(last.l, l), c };
            lastBarRef.current = merged;
            setCandles((prev) => { if (!prev.length) return [merged]; const n = prev.slice(); n[n.length - 1] = merged; return n; });
          } else {
            return; // older bucket — ignore
          }
          setLastPrice(c);
          return;
        }

        if (msg.type === "data_updated" && (!msg.symbol || matches(msg.symbol))) {
          fetchCandles(); // silent dataset refresh — keeps chartKey unchanged so no replay
          return;
        }

        if (msg.type === "feedStatus" && (!msg.symbol || matches(msg.symbol))) {
          const st = msg.status;
          if (st === "live" || st === "stale" || st === "unknown") setFeedStatus(st);
          return;
        }

        if (msg.type === "signal_new" && matches(msg.symbol)) {
          fetchSignals();
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
  }, [fetchCandles, fetchSignals]);

  return { candles, signals, lastPrice, connected, source, feedStatus, loadMoreHistory, fullyLoaded, autoTradeFired };
}
