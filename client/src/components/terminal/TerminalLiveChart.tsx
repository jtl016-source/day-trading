// TerminalLiveChart.tsx — the MARKET IS THE BACKGROUND.
// Full-screen, scrollable/zoomable lightweight-charts (v5) candlestick chart behind the
// floating HUD. Real candles; native pan/zoom; signal markers; per-strategy overlays:
//   • Vector    → ALL timeframe vectors at once (1m/5m/15m/60m), current = teal, others colored
//   • MilkZone  → uploaded-picture zones (price-line bands)
//   • Footprint → candle delta tint + POC/VAH/VAL + imbalance ZONES on the chart
//                 (the bid/ask LADDER is the floating FootprintPanel)
//
// A teal "sweep" replays on chartKey change (load / enter Market / reload).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createChart, CandlestickSeries, LineSeries, createSeriesMarkers, ColorType, CrosshairMode,
  TickMarkType,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type UTCTimestamp, type Time,
} from "lightweight-charts";
import { computeVectorLine, aggToInterval, forwardFillVector } from "@/lib/trading-utils";
import type { CandleBar } from "@/components/CandlestickChart";
import { C } from "./terminalStyles";
import type { TerminalCandle, TerminalSignal } from "@/hooks/useTerminalData";
import type { StrategyToggles } from "@/lib/terminalSettings";
import { currentRthSession, type MilkZone } from "@/lib/milkZones";
import { aggregateSessions } from "./footprintAggregate";
import { buildProxyFootprintCandle, type FootprintCandle } from "@/lib/footprint-analysis";
import { computeProbabilitySnapshot, type ProbabilitySnapshot } from "@/lib/probability";
import type { Regime } from "@/lib/hurst";

const fmtVol = (v: number): string =>
  v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + "M" : v >= 1_000 ? Math.round(v / 1_000) + "k" : String(Math.round(v));

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

type DeltaMap = Map<number, number>;

/** YELLOW-BOX: one labeled structural band (mwml-imported or auto persistent cluster). */
interface YbBand { type: string; label: string; top: number; bottom: number; color: string; source: string }
/** YELLOW-BOX: one trading day's full zone set from GET /api/yellowbox/day-zones. */
interface YbDay {
  sessionStartTs: number;
  sessionEndTs: number;
  boxTop: number;
  boxBottom: number;
  initRes: number;
  initSup: number;
  maxRangeUp?: number;
  maxRangeDn?: number;
  normalRangeUp?: number;
  normalRangeDn?: number;
  maxTrendUp?: number;
  longAve?: number;
  shortAve?: number;
  bands?: YbBand[];
}

const INTERVAL_SECS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };
const VEC_LABELS = ["1m", "5m", "15m", "60m"] as const;
const VEC_COLORS: Record<string, string> = { "1m": "#60a5fa", "5m": "#9ca3af", "15m": "#fbbf24", "60m": "#a855f7" };

// Default view: land on the live edge showing a readable recent window. fitContent() on the
// full dataset is a trap — with 100k+ bars it clamps to minBarSpacing (0.5px/bar), rendering
// an unusable smear where pan/zoom look dead, and puts logical 0 in view which auto-fires the
// deep-history load on open.
const DEFAULT_VIEW_BARS = 240;
const RIGHT_OFFSET_BARS = 6;

// ── ET time axis (CLAUDE.md: NEVER hardcode a UTC offset — always Intl with America/New_York).
const ET_TICK_HM = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
const ET_TICK_HMS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const ET_TICK_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "numeric" });
const ET_TICK_MON = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short" });
const ET_TICK_YEAR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" });
const ET_CROSSHAIR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function etTickMark(time: number, type: TickMarkType): string {
  const d = new Date(time * 1000);
  switch (type) {
    case TickMarkType.Year: return ET_TICK_YEAR.format(d);
    case TickMarkType.Month: return ET_TICK_MON.format(d);
    case TickMarkType.DayOfMonth: return ET_TICK_DAY.format(d);
    case TickMarkType.TimeWithSeconds: return ET_TICK_HMS.format(d);
    case TickMarkType.Time:
    default: return ET_TICK_HM.format(d);
  }
}
function etCrosshairTime(time: number): string {
  return ET_CROSSHAIR.format(new Date(time * 1000)) + " ET";
}

function dedupe(candles: TerminalCandle[]): TerminalCandle[] {
  const m = new Map<number, TerminalCandle>();
  for (const c of candles) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}
const toCB = (c: TerminalCandle): CandleBar => ({ time: c.time, open: c.o, high: c.h, low: c.l, close: c.c });

function footprintDelta(fc: any): number {
  // (candle-level delta field removed 2026-07-13 — rule 7. Net delta derives from totals/levels.)
  if (typeof fc?.totalAskVol === "number" && typeof fc?.totalBidVol === "number") return fc.totalAskVol - fc.totalBidVol;
  if (typeof fc?.delta === "number") return fc.delta;
  const levels = fc?.levels;
  if (Array.isArray(levels)) {
    let a = 0, b = 0;
    for (const lv of levels) { a += Number(lv?.askVol ?? lv?.a ?? lv?.ask ?? 0); b += Number(lv?.bidVol ?? lv?.b ?? lv?.bid ?? 0); }
    return a - b;
  }
  return 0;
}

export function TerminalLiveChart({
  candles, signals, milkZones, symbol, interval, strategies, chartKey, onSignalClick, selectedSig,
  onNeedHistory, fullyLoaded, candlesRevision,
}: {
  candles: TerminalCandle[];
  /** INTERIOR REPAINT (2026-09-18): useTerminalData bumps this when reconcile() replaced the
   *  OHLC of an already-loaded CLOSED interior bar (provisional → canonical, tick-built →
   *  server-official) — a change the tick fast path cannot see (same length / first / last). */
  candlesRevision?: number;
  signals: TerminalSignal[];
  milkZones: MilkZone[];
  symbol: string;
  interval: string;
  strategies: StrategyToggles;
  chartKey: number;
  onSignalClick?: (s: TerminalSignal) => void;
  selectedSig?: TerminalSignal | null;
  /** Called when the user scrolls near the left edge — triggers a deep-history load. */
  onNeedHistory?: () => void;
  /** True once the full history is loaded (stops the scroll-back trigger). */
  fullyLoaded?: boolean;
}) {
  const currentSec = INTERVAL_SECS[interval] ?? 300;

  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vecSeriesRef = useRef<Record<string, ISeriesApi<"Line">>>({});
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const deltaRef = useRef<DeltaMap>(new Map());
  const didFitRef = useRef(false);

  // Overlay canvas draws BOTH the milk-zone bands and the footprint (real-data session
  // ladders + cluster imbalance zones), synced to the chart's time/price scales.
  const fpCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fpSessionsRef = useRef<FootprintCandle[]>([]);
  const fpRafRef = useRef(0);
  const drawFpRef = useRef<() => void>(() => {});
  const candlesRef = useRef<TerminalCandle[]>([]);
  // Probability overlay canvas (separate layer — never touches the candle/vector series, so it
  // can't destabilize the chart). Renders each fractal concept individually, flag-gated.
  const probCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const probRafRef = useRef(0);
  const drawProbRef = useRef<() => void>(() => {});
  const probSnapRef = useRef<ProbabilitySnapshot | null>(null);
  const fpOnRef = useRef(false);
  const milkOnRef = useRef(false);
  const milkZonesRef = useRef<MilkZone[]>([]);
  // YELLOW-BOX: per-trading-day boxes (fetched from /api/yellowbox/day-zones) + toggle gate.
  const yellowOnRef = useRef(false);
  const ybRef = useRef<YbDay[]>([]);
  // PML/TML: LIVE-ONLY money lines (/api/pml-tml, options exposure). Rendered as full-width
  // dashed reference lines under the YellowBox toggle family — current levels only, no history.
  const pmlTmlRef = useRef<{ pml: number | null; tml: number | null; source?: string } | null>(null);
  // CLOSE-EST (2026-08-09 Fractal Exchange study session): LIVE-ONLY end-of-day close-estimate
  // zone (/api/close-estimate). estCloseHigh = running HOD − avg green-day pullback, estCloseLow
  // = running LOD + avg red-day bounce, OPEN = the card's reversion target into the close.
  // Same family/pattern as PML/TML: current-day levels only, 3-min poll, YellowBox toggle,
  // display-only (never an engine input — the zone derives from RUNNING session extremes).
  const closeEstRef = useRef<{ estCloseHigh: number | null; estCloseLow: number | null; rthOpen: number | null } | null>(null);
  const closeEstOnRef = useRef(false); // CLOSE-EST toggle gate (own Strategies entry since 2026-08-09)
  // 1m-history seam: the server-declared floor of served 1m data (servedFloorTs), when the
  // endpoint exists. null = unknown (fall back to the fullyLoaded flag for the seam note).
  const seamFloorRef = useRef<number | null>(null);
  const signalsRef = useRef<TerminalSignal[]>([]);
  const onSignalClickRef = useRef<((s: TerminalSignal) => void) | undefined>(undefined);
  const intervalRef = useRef(interval);
  const selectedSigRef = useRef<TerminalSignal | null>(null);
  // Lazy deep-history: keep the callbacks/flag fresh for the range-subscription closure, and
  // track the previous first-bar time + length so we can preserve the view when history is
  // prepended (the logical indices all shift right by the number of bars added at the front).
  const onNeedHistoryRef = useRef(onNeedHistory);
  const fullyLoadedRef = useRef(fullyLoaded);
  const prevFirstTimeRef = useRef(0);
  const prevLenRef = useRef(0);
  const prevLastTimeRef = useRef(0);     // last bar's time — fast-path detects tick-only updates
  const prevFootprintRef = useRef(false); // re-tint all bars (full setData) when this toggles
  const prevRevisionRef = useRef(candlesRevision ?? 0); // interior-bar replacement counter last painted
  onNeedHistoryRef.current = onNeedHistory;
  fullyLoadedRef.current = fullyLoaded;
  candlesRef.current = candles;
  fpOnRef.current = strategies.Footprint;
  milkOnRef.current = strategies.MilkZone;
  yellowOnRef.current = strategies.YellowBox; // YELLOW-BOX:
  closeEstOnRef.current = strategies.CloseEst; // CLOSE-EST: own toggle (was YellowBox-family at first ship)
  milkZonesRef.current = milkZones;
  signalsRef.current = signals;
  onSignalClickRef.current = onSignalClick;
  intervalRef.current = interval;
  selectedSigRef.current = selectedSig ?? null;

  const [base1m, setBase1m] = useState<TerminalCandle[]>([]);

  // ── Init chart once (useLayoutEffect — dimensions are 0 at useEffect time) ──
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const chart = createChart(hostRef.current, {
      width: hostRef.current.clientWidth,
      height: hostRef.current.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: C.bg },
        textColor: C.muted,
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        attributionLogo: false,
      },
      grid: { vertLines: { color: "rgba(255,255,255,0.035)" }, horzLines: { color: "rgba(255,255,255,0.035)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)", autoScale: true },
      // ET everywhere: tick marks + crosshair label match the ET clock (default was UTC).
      localization: { timeFormatter: (t: Time) => etCrosshairTime(t as number) },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false,
        rightOffset: RIGHT_OFFSET_BARS,
        tickMarkFormatter: (t: Time, type: TickMarkType) => etTickMark(t as number, type),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: {
        mouseWheel: true, pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
    });
    chartRef.current = chart;
    // DEV-only escape hatch for browser-side diagnostics (visible range, options, etc.).
    if (import.meta.env.DEV) (window as any).__ttChart = chart;

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down,
      wickUpColor: "rgba(31,217,138,0.6)", wickDownColor: "rgba(255,77,109,0.6)",
      priceLineColor: C.accent, priceLineStyle: 2,
    });

    // ALL timeframe vectors — pre-allocate one line series per interval (current = teal).
    // lastValueVisible:true + title shows the interval label on the right axis next to the line.
    for (const label of VEC_LABELS) {
      const isCur = INTERVAL_SECS[label] === currentSec;
      vecSeriesRef.current[label] = chart.addSeries(LineSeries, {
        color: isCur ? C.accent : VEC_COLORS[label],
        lineWidth: isCur ? 2 : 1,
        priceLineVisible: false,
        lastValueVisible: true,
        title: label,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      });
    }

    // MilkZone bands are drawn on the overlay canvas (filled bands, same as the old chart),
    // not as chart series — see drawFootprint().

    markersRef.current = createSeriesMarkers(candleRef.current, []);

    // Click a signal marker → open its detail (exit strategy + mini chart).
    // Primary: match by time — find the signal whose ts is closest to the clicked bar's
    // timestamp (param.time). Accept within 2 bars (2 × interval). Fallback: pixel distance
    // within 60px for when param.time is null (click between bars).
    chart.subscribeClick((param) => {
      const cb = onSignalClickRef.current;
      if (!cb) return;
      const sigs = signalsRef.current;
      if (!sigs.length) return;
      const ivSec = INTERVAL_SECS[intervalRef.current] ?? 300;
      const threshold = ivSec * 2; // accept within 2 bars

      // Primary: time-based (most reliable)
      if (param.time != null) {
        const clickT = param.time as number;
        let best: TerminalSignal | null = null, bestDt = Infinity;
        for (const s of sigs) {
          const dt = Math.abs(s.ts - clickT);
          if (dt < bestDt) { bestDt = dt; best = s; }
        }
        if (best && bestDt <= threshold) { cb(best); return; }
      }

      // Fallback: pixel distance
      if (!param.point) return;
      const ts2 = chart.timeScale();
      const clickX = param.point.x;
      let best: TerminalSignal | null = null, bestDx = Infinity;
      for (const s of sigs) {
        const x = ts2.timeToCoordinate(s.ts as any) as number | null;
        if (x === null) continue;
        const dx = Math.abs(x - clickX);
        if (dx < bestDx) { bestDx = dx; best = s; }
      }
      if (best && bestDx <= 60) { cb(best); return; }
      // Nothing nearby → pass null to clear the selection
      cb(null as any);
    });

    const ro = new ResizeObserver(() => {
      if (!hostRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: hostRef.current.clientWidth, height: hostRef.current.clientHeight });
      cancelAnimationFrame(fpRafRef.current);
      fpRafRef.current = requestAnimationFrame(() => { drawFpRef.current(); drawProbRef.current(); });
    });
    ro.observe(hostRef.current);

    // Overlays must track PRICE-SCALE changes too (axis drag / autoscale reset / wheel zoom).
    // lw-charts exposes no Y-scale subscription, so redraw on any pointer interaction that can
    // move the price scale: drag moves (buttons pressed), pointer-up, wheel, axis double-click.
    // Redraws are rAF-coalesced (scheduleFpDraw-equivalent) so this is cheap.
    const host = hostRef.current;
    const kickRedraw = () => {
      cancelAnimationFrame(fpRafRef.current);
      fpRafRef.current = requestAnimationFrame(() => { drawFpRef.current(); drawProbRef.current(); });
    };
    const onPtrMove = (e: PointerEvent) => { if (e.buttons !== 0) kickRedraw(); };
    host.addEventListener("pointermove", onPtrMove, { passive: true });
    host.addEventListener("pointerup", kickRedraw, { passive: true });
    host.addEventListener("wheel", kickRedraw, { passive: true });
    host.addEventListener("dblclick", kickRedraw);

    return () => {
      host.removeEventListener("pointermove", onPtrMove);
      host.removeEventListener("pointerup", kickRedraw);
      host.removeEventListener("wheel", kickRedraw);
      host.removeEventListener("dblclick", kickRedraw);
      ro.disconnect(); chart.remove(); chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 1m base data (for finer-than-current vectors) ──
  useEffect(() => {
    if (currentSec <= 60) { setBase1m([]); return; }
    let cancelled = false;
    const from = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    fetch(`/api/data/cached-continuous/${encodeURIComponent(symbol)}/1m?from=${from}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const raw = Array.isArray(d?.candles) ? d.candles : [];
        setBase1m(raw
          .map((b: any) => ({ time: b.time, o: b.open, h: b.high, l: b.low, c: b.close }))
          .filter((b: TerminalCandle) => Number.isFinite(b.o) && Number.isFinite(b.c)));
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [symbol, currentSec]);

  // ── Candle data (+ footprint delta tint) ──
  // Build one lightweight-charts candle item (with optional footprint delta tint).
  const toItem = (c: TerminalCandle): any => {
    const item: any = { time: c.time as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c };
    if (strategies.Footprint) {
      const d = deltaRef.current.get(c.time);
      if (typeof d === "number" && d !== 0) {
        const col = d > 0 ? C.up : C.down;
        item.color = col; item.borderColor = col;
        item.wickColor = d > 0 ? "rgba(31,217,138,0.75)" : "rgba(255,77,109,0.75)";
      }
    }
    return item;
  };
  const applyCandles = () => {
    const s = candleRef.current;
    if (!s) return;
    s.setData(dedupe(candles).map(toItem));
  };

  // Land the view on the LIVE EDGE at a readable zoom (last DEFAULT_VIEW_BARS bars).
  // Never fitContent() a full deep-history dataset — see DEFAULT_VIEW_BARS note.
  const fitRecent = () => {
    const chart = chartRef.current;
    const n = candlesRef.current.length;
    if (!chart || !n) return;
    const ts = chart.timeScale();
    if (n <= DEFAULT_VIEW_BARS) ts.fitContent();
    else ts.setVisibleLogicalRange({ from: n - DEFAULT_VIEW_BARS - 0.5, to: n - 1 + RIGHT_OFFSET_BARS });
  };
  const fitRecentRef = useRef(fitRecent);
  fitRecentRef.current = fitRecent;

  useEffect(() => {
    const s = candleRef.current;
    const ts = chartRef.current?.timeScale();
    const n = candles.length;
    const footprintChanged = prevFootprintRef.current !== strategies.Footprint;
    prevFootprintRef.current = strategies.Footprint;
    // INTERIOR REPAINT (2026-09-18): reconcile() regularly REPLACES interior closed bars
    // (provisional → canonical OHLC, tick-built → server-official) without changing the array's
    // length, first time or last time — byte-for-byte the fast path's "tick only" signature. The
    // replaced bars kept their old shape until the next structural setData and then several
    // candles changed at once. A revision bump forces the STRUCTURAL path; with length/first/last
    // unchanged it classifies as APPEND/SAME below, so the user's view is left alone.
    const revision = candlesRevision ?? 0;
    const revisionChanged = revision !== prevRevisionRef.current;
    prevRevisionRef.current = revision;

    // FAST PATH: a live tick only mutates the LAST bar's OHLC (same length, same bar times).
    // Update that single bar — O(1) — instead of re-uploading the entire (up to 100k) series,
    // which is the main source of lag during live ticks.
    if (s && !footprintChanged && !revisionChanged && n > 0 && n === prevLenRef.current &&
        candles[n - 1].time === prevLastTimeRef.current && candles[0].time === prevFirstTimeRef.current) {
      try { s.update(toItem(candles[n - 1])); } catch { applyCandles(); }
      prevLastTimeRef.current = candles[n - 1].time;
      scheduleFpDraw();
      return;
    }

    // STRUCTURAL PATH: new bar / reconcile / deep-history prepend / interval switch / footprint
    // toggle → full setData. Classify the change so the view responds correctly:
    //   PREPEND     — old dataset is verifiably a SUFFIX of the new one (deep-history load, or a
    //                 merge that also filled interior gaps): keep the user's view anchored on the
    //                 bar that used to be first (indices shifted right).
    //   APPEND/SAME — same first bar, last bar moved forward (live bar, reconcile): leave the
    //                 view alone (lw-charts tracks the right edge itself).
    //   REPLACEMENT — anything else (interval/symbol switch landed a brand-new dataset, first
    //                 data after a reset): force the view to the live edge REGARDLESS of
    //                 didFitRef — this is what used to strand the view in the past.
    const prevLen = prevLenRef.current, prevFirst = prevFirstTimeRef.current, prevLast = prevLastTimeRef.current;
    const grewOlder = n > prevLen && n > 0 && prevLen > 0 && prevFirst > 0 && candles[0].time < prevFirst;
    // Signed index shift of the OLD dataset's bars inside the NEW one:
    //   + : bars inserted at the front (deep-history prepend — old first bar found in new array)
    //   − : bars trimmed from the front (MAX_CANDLES cap slid forward — new first bar found in
    //       the OLD series data). Both preserve the user's view by shifting the logical range.
    let shiftBy = 0;
    let isTrimSlide = false;
    if (grewOlder && candles[n - 1].time >= prevLast) {
      // Index of the previously-first bar in the new array (binary search; exact match required).
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (candles[m].time < prevFirst) lo = m + 1; else hi = m; }
      if (candles[lo]?.time === prevFirst) shiftBy = lo;
    } else if (s && prevLen > 0 && n > 0 && prevFirst > 0 &&
               candles[0].time > prevFirst && candles[n - 1].time >= prevLast) {
      // Left-trim continuation: find the new first bar in the OLD series data.
      const old = s.data();
      let lo = 0, hi = old.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if ((old[m].time as number) < candles[0].time) lo = m + 1; else hi = m; }
      if (old[lo] && (old[lo].time as number) === candles[0].time && lo > 0) { shiftBy = -lo; isTrimSlide = true; }
    }
    const isPrepend = shiftBy > 0;
    const isAppendOrSame = !isPrepend && !isTrimSlide && prevLen > 0 && n >= prevLen &&
      candles[0]?.time === prevFirst && (n === 0 || candles[n - 1].time >= prevLast);
    //   TAIL DROP   — (2026-09-18, contract guard) useTerminalData's regime reset REMOVES the
    //                 forming candle on every flip / roll / offset, so the array arrives ONE
    //                 shorter: same first bar, new last bar = the bar that was second-to-last.
    //                 "Shorter" used to fall through to REPLACEMENT and fitRecent() threw away
    //                 the user's zoom / scroll on each guard event. It is the same dataset minus
    //                 its tail — leave the view alone exactly like APPEND/SAME (the next tick
    //                 re-appends the bucket). The old second-to-last time is read from the series
    //                 itself (still the OLD data here — applyCandles() runs below).
    let isTailDrop = false;
    if (s && !isPrepend && !isTrimSlide && prevLen > 1 && n === prevLen - 1 && candles[0].time === prevFirst) {
      const old = s.data();
      isTailDrop = old.length >= 2 && (old[old.length - 2].time as number) === candles[n - 1].time;
    }
    // For a trim-slide, only shift when the user is NOT hugging the live edge — at the edge,
    // lw-charts' own right-edge tracking does the right thing.
    const savedRange = (isPrepend || isTrimSlide) && ts ? ts.getVisibleLogicalRange() : null;
    const atLiveEdge = savedRange !== null && savedRange.to >= prevLen - 1;

    applyCandles();

    if (savedRange && ts && shiftBy !== 0 && !(isTrimSlide && atLiveEdge)) {
      // Shift the visible logical range so the same bars stay in view.
      ts.setVisibleLogicalRange({ from: savedRange.from + shiftBy, to: savedRange.to + shiftBy });
    } else if (n && !((isAppendOrSame || isTailDrop) && didFitRef.current) && !(isTrimSlide && atLiveEdge)) {
      // REPLACEMENT (or very first dataset): land on the live edge.
      fitRecent();
      didFitRef.current = true;
    }
    prevFirstTimeRef.current = candles.length ? candles[0].time : 0;
    prevLenRef.current = candles.length;
    prevLastTimeRef.current = candles.length ? candles[candles.length - 1].time : 0;
    scheduleFpDraw();
    // candlesRevision is a dep so a bump that lands in a LATER render than its candles array
    // (it is normally the same React batch) still repaints.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, strategies.Footprint, candlesRevision]);

  const barSig =candles.length ? `${candles.length}:${candles[candles.length - 1].time}` : "0";

  // ── Interval / symbol switch: reset the prepend-tracking refs so the incoming dataset is
  // classified as a REPLACEMENT (fresh fit), never as a prepend against the old interval's
  // bars — and re-apply the "current interval" teal styling to the right vector series
  // (it was frozen at mount, so after a switch the wrong vector stayed highlighted).
  useEffect(() => {
    prevFirstTimeRef.current = 0;
    prevLenRef.current = 0;
    prevLastTimeRef.current = 0;
    didFitRef.current = false;
    for (const label of VEC_LABELS) {
      const s = vecSeriesRef.current[label];
      if (!s) continue;
      const isCur = INTERVAL_SECS[label] === currentSec;
      s.applyOptions({ color: isCur ? C.accent : VEC_COLORS[label], lineWidth: isCur ? 2 : 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, symbol]);

  // ── ALL timeframe vectors ──
  useEffect(() => {
    const chartCB = dedupe(candles).map(toCB);
    const chartTimes = chartCB.map((c) => c.time);
    const base1mCB = dedupe(base1m).map(toCB);
    for (const label of VEC_LABELS) {
      const s = vecSeriesRef.current[label];
      if (!s) continue;
      if (!strategies.Vector || !chartTimes.length) { s.setData([]); continue; }
      const sec = INTERVAL_SECS[label];
      let base: CandleBar[];
      if (sec === currentSec) base = chartCB;
      else if (sec > currentSec) base = aggToInterval(chartCB, sec);
      else base = base1mCB.length ? (sec === 60 ? base1mCB : aggToInterval(base1mCB, sec)) : [];
      if (!base.length) { s.setData([]); continue; }
      const filled = forwardFillVector(computeVectorLine(base), chartTimes);
      s.setData(filled.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barSig, base1m, strategies.Vector]);

  // ── Footprint overlay — schedule a canvas redraw (coalesced to one rAF) ──
  const scheduleFpDraw = () => {
    cancelAnimationFrame(fpRafRef.current);
    fpRafRef.current = requestAnimationFrame(() => drawFpRef.current());
  };

  // The OLD footprint, on real data: per-session ladders anchored to each session's first
  // candle (full HOD→LOD height) + cluster imbalance ZONES sized to the imbalance. Ported
  // from CandlestickChart.tsx; coordinates from the live chart's time/price scales.
  const drawFootprint = () => {
    const canvas = fpCanvasRef.current, chart = chartRef.current, series = candleRef.current, host = hostRef.current;
    if (!canvas || !chart || !series || !host) return;
    const cw = host.clientWidth, ch = host.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
      canvas.width = Math.floor(cw * dpr); canvas.height = Math.floor(ch * dpr);
      canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
    }
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const ts = chart.timeScale();

    // PANE GEOMETRY — the drawable area excludes the price axis (right) and time axis (bottom).
    // Using the host's full width/height painted boxes over the axes and shifted X positions by
    // the price-axis width. timeScale().width() IS the pane width; height() is the axis strip.
    let paneW = cw, paneBottom = ch;
    try { const w = ts.width(); if (w > 0 && w <= cw) paneW = w; } catch { /* keep cw */ }
    try { const h = ts.height(); if (h > 0 && h < ch) paneBottom = ch - h; } catch { /* keep ch */ }
    const clipBottom = paneBottom;

    // ── Shared X mapping (bar-index space) ─────────────────────────────────────
    // The x-axis is BAR-INDEX spaced (gaps take no width), so ALL overlay layers must map
    // time → x by snapping to candle indices — any linear-in-time estimate stretches sessions.
    // Times between bars interpolate between neighbours; times beyond either end extrapolate
    // at one interval per logical step. Deliberately NOT ts.logicalToCoordinate — this
    // lw-charts build returns 0 for it here, silently collapsing widths.
    const cansAll = candlesRef.current; // ascending + deduped (useTerminalData)
    const nC = cansAll.length;
    const vr = ts.getVisibleLogicalRange() as { from: number; to: number } | null;
    const logToX = vr && vr.to > vr.from
      ? (L: number): number => ((L - vr.from) / (vr.to - vr.from)) * paneW
      : null;
    // first index with time >= t
    const lbTime = (t: number): number => {
      let lo = 0, hi = nC;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cansAll[m].time < t) lo = m + 1; else hi = m; }
      return lo;
    };
    const secPerBar = INTERVAL_SECS[intervalRef.current] ?? 300;
    const timeToXSnap = (t: number): number | null => {
      if (!logToX || nC < 2 || !Number.isFinite(t)) return null;
      let L: number;
      if (t <= cansAll[0].time) L = -((cansAll[0].time - t) / secPerBar);
      else if (t >= cansAll[nC - 1].time) L = (nC - 1) + (t - cansAll[nC - 1].time) / secPerBar;
      else {
        const i = lbTime(t);
        const a = cansAll[i - 1].time, b = cansAll[i].time;
        L = b === a ? i : (i - 1) + (t - a) / (b - a);
      }
      return logToX(L);
    };

    // ── YELLOW-BOX DAY-ZONE STACK (drawn FIRST so milk zones / footprint / signals stay on top):
    // per visible session — red/green range shading → dashed normal-range/max-trend lines →
    // LongAve/ShortAve → gold Yellow Box → labeled persistent bands (mwml + auto).
    //
    // X edges SNAP TO CANDLE INDICES (binary search + logical coordinates). The chart's x-axis is
    // BAR-INDEX spaced — overnight/weekend gaps occupy no width — so any linear-in-time estimate
    // (the old estX fallback) over-stretches sessions and pushes older ones off-screen; that was
    // the "boxes on only two sessions" defect. Sessions without candles (holidays / beyond the
    // loaded range) naturally have no span and are skipped, as are off-screen sessions (cheap).
    if (yellowOnRef.current && ybRef.current.length && logToX && nC > 1) {
      {
        const Y = (p: number | null | undefined): number | null => {
          if (p == null || !Number.isFinite(p)) return null;
          const y = series.priceToCoordinate(p);
          return y === null ? null : (y as number);
        };
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, paneW, clipBottom); ctx.clip();
        ctx.font = "9px 'IBM Plex Mono',monospace"; ctx.textAlign = "left";
        // Persistent bands are collected across sessions and merged into RUNS (one continuous
        // band when the same top/bottom spans consecutive days) — drawn after the session loop.
        interface BandRun { top: number; bottom: number; color: string; label: string; x0: number; x1: number }
        const bandRuns: BandRun[] = [];
        const openRuns = new Map<string, BandRun>();
        const days = [...ybRef.current].sort((a, b) => a.sessionStartTs - b.sessionStartTs);
        for (const yb of days) {
          const iFirst = lbTime(yb.sessionStartTs);
          const iLast = lbTime(yb.sessionEndTs + 1) - 1; // last index with time <= end
          if (iFirst >= nC || iLast < iFirst) continue;  // no candles in this session
          const rawLeft = logToX(iFirst - 0.5), rawRight = logToX(iLast + 0.5);
          if (rawRight < 0 || rawLeft > paneW) continue; // off-screen session
          const bxLeft = Math.max(0, rawLeft), bxRight = Math.min(paneW, rawRight);
          const bxW = bxRight - bxLeft;
          if (bxW <= 1) continue;

          // 1) Session range shading — RED initRes→maxRangeUp, GREEN initSup→maxRangeDn (low alpha).
          const shade = (pA: number | undefined, pB: number | undefined, fill: string): void => {
            const yA = Y(pA), yB = Y(pB);
            if (yA === null || yB === null) return;
            const y0 = Math.max(0, Math.min(yA, yB)), y1 = Math.min(clipBottom, Math.max(yA, yB));
            if (y1 - y0 < 1) return;
            ctx.fillStyle = fill; ctx.fillRect(bxLeft, y0, bxW, y1 - y0);
          };
          shade(yb.initRes, yb.maxRangeUp, "rgba(198,40,40,0.07)");
          shade(yb.initSup, yb.maxRangeDn, "rgba(46,125,50,0.07)");

          // 2) Dashed levels: normal-range (grey), max-trend (white), init res/sup (red/green tint).
          const dash = (p: number | undefined, color: string, pattern: number[]): void => {
            const y = Y(p);
            if (y === null || y < 0 || y > clipBottom) return;
            ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(pattern);
            ctx.beginPath(); ctx.moveTo(bxLeft, y); ctx.lineTo(bxRight, y); ctx.stroke();
            ctx.setLineDash([]);
          };
          dash(yb.normalRangeUp, "rgba(176,190,197,0.55)", [4, 3]);
          dash(yb.normalRangeDn, "rgba(176,190,197,0.55)", [4, 3]);
          dash(yb.maxTrendUp, "rgba(232,234,240,0.60)", [7, 4]);
          dash(yb.initRes, "rgba(239,154,154,0.85)", [5, 3]);
          dash(yb.initSup, "rgba(165,214,167,0.85)", [5, 3]);
          // 3) LongAve / ShortAve — thin solid cyan lines.
          const solid = (p: number | undefined): void => {
            const y = Y(p);
            if (y === null || y < 0 || y > clipBottom) return;
            ctx.strokeStyle = "rgba(77,208,225,0.65)"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(bxLeft, y); ctx.lineTo(bxRight, y); ctx.stroke();
          };
          solid(yb.longAve);
          solid(yb.shortAve);

          // 4) The gold Yellow Box.
          const yT = Y(yb.boxTop), yB = Y(yb.boxBottom);
          if (yT !== null && yB !== null) {
            const by = Math.max(0, Math.min(yT, yB)), byb = Math.min(clipBottom, Math.max(yT, yB));
            const brh = byb - by;
            if (brh >= 1) {
              ctx.fillStyle = "rgba(245,217,10,0.10)"; ctx.fillRect(bxLeft, by, bxW, brh);
              ctx.strokeStyle = "rgba(245,217,10,0.85)"; ctx.lineWidth = 1; ctx.strokeRect(bxLeft, by, bxW, brh);
              if (brh > 12 && bxW > 26) {
                ctx.fillStyle = "rgba(245,217,10,0.95)";
                ctx.fillText("YB", bxLeft + 3, by + 9);
              }
            }
          }

          // 5) Persistent bands — COLLECT into cross-session runs (drawn after the loop).
          // Identity is GEOMETRY (top/bottom), not label: when a band's role flips between
          // sessions (e.g. RES one day, SUP the next) the run still merges, and the label of
          // the MOST RECENT session in the run wins — no more contradictory adjacent labels.
          for (const band of yb.bands ?? []) {
            if (!Number.isFinite(band.top) || !Number.isFinite(band.bottom)) continue;
            const key = `${band.top.toFixed(2)}|${band.bottom.toFixed(2)}`;
            const run = openRuns.get(key);
            if (run && bxLeft <= run.x1 + 8) {
              // contiguous with the previous session's identical band → extend the run
              run.x1 = Math.max(run.x1, bxRight);
              run.label = band.label;   // most recent session's label wins
              run.color = band.color;
            } else {
              if (run) bandRuns.push(run);
              openRuns.set(key, { top: band.top, bottom: band.bottom, color: band.color, label: band.label, x0: bxLeft, x1: bxRight });
            }
          }
        }
        for (const run of openRuns.values()) bandRuns.push(run);
        // Draw the merged runs; labels dedupe on pixel collision (older/further-left labels
        // yield to the ones already placed — the current session draws last, so sort by x0).
        const placedLabels: Array<{ x: number; y: number; w: number; h: number }> = [];
        bandRuns.sort((a, b) => b.x1 - a.x1); // right-most (most recent) runs place labels first
        for (const run of bandRuns) {
          const yA = Y(run.top), yB2 = Y(run.bottom);
          if (yA === null || yB2 === null) continue;
          const y0 = Math.max(0, Math.min(yA, yB2)), y1 = Math.min(clipBottom, Math.max(yA, yB2));
          const bh = y1 - y0;
          const bw = run.x1 - run.x0;
          if (bh < 1 || bw <= 1) continue;
          ctx.fillStyle = hexToRgba(run.color, 0.10);
          ctx.fillRect(run.x0, y0, bw, bh);
          ctx.strokeStyle = hexToRgba(run.color, 0.70); ctx.lineWidth = 1;
          ctx.strokeRect(run.x0, y0, bw, bh);
          if (bh >= 11 && bw > 90) {
            const text = `${run.label} ${run.bottom.toFixed(0)}-${run.top.toFixed(0)}`;
            const tw = ctx.measureText(text).width;
            const lx = Math.max(run.x0, 0) + 3;
            const ly = y0 + Math.min(9, bh - 2);
            const rect = { x: lx, y: ly - 9, w: tw, h: 11 };
            const collides = placedLabels.some((p) =>
              rect.x < p.x + p.w && rect.x + rect.w > p.x && rect.y < p.y + p.h && rect.y + rect.h > p.y);
            if (!collides) {
              ctx.fillStyle = hexToRgba(run.color, 0.95);
              ctx.fillText(text, lx, ly);
              placedLabels.push(rect);
            }
          }
        }
        ctx.restore();
      }
    }

    // ── PML/TML LIVE money lines (options exposure — /api/pml-tml) — YellowBox toggle family.
    // CURRENT levels only (no history exists): full-width dashed lines + right-edge labels.
    if (yellowOnRef.current && pmlTmlRef.current) {
      const mm = pmlTmlRef.current;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, paneW, clipBottom); ctx.clip();
      ctx.font = "9px 'IBM Plex Mono',monospace"; ctx.textAlign = "right";
      const mmLine = (p: number | null, color: string, tag: string): void => {
        if (p == null || !Number.isFinite(p)) return;
        const y = series.priceToCoordinate(p);
        if (y === null || (y as number) < 0 || (y as number) > clipBottom) return;
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([9, 5]);
        ctx.beginPath(); ctx.moveTo(0, y as number); ctx.lineTo(paneW, y as number); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.fillText(`${tag} ${p.toFixed(2)}`, paneW - 4, (y as number) - 3);
      };
      mmLine(mm.pml, "rgba(239,83,80,0.9)", "PML");  // red — peak MM exposure (guide's red line)
      mmLine(mm.tml, "rgba(129,199,132,0.9)", "TML"); // green — balanced trough / pin zone
      ctx.restore();
    }

    // ── CLOSE-EST zone (/api/close-estimate) — own Strategies toggle, same live-only shape
    // as PML/TML. Amber magnet band between the two estimates + dashed est lines + solid OPEN
    // reversion-target line. Current-day levels only; off-pane levels simply don't draw (the
    // y-guard skips them — never fall back to an on-screen position, per the yellowbox lesson).
    if (closeEstOnRef.current && closeEstRef.current) {
      const ce = closeEstRef.current;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, paneW, clipBottom); ctx.clip();
      ctx.font = "9px 'IBM Plex Mono',monospace"; ctx.textAlign = "left";
      const yOf = (p: number | null): number | null => {
        if (p == null || !Number.isFinite(p)) return null;
        const y = series.priceToCoordinate(p);
        return y === null || (y as number) < 0 || (y as number) > clipBottom ? null : (y as number);
      };
      const yHi = yOf(ce.estCloseHigh), yLo = yOf(ce.estCloseLow);
      if (yHi !== null && yLo !== null && Math.abs(yLo - yHi) > 1) {
        ctx.fillStyle = "rgba(255,193,7,0.07)"; // close-magnet band (single fill — no stacking)
        ctx.fillRect(0, Math.min(yHi, yLo), paneW, Math.abs(yLo - yHi));
      }
      const ceLine = (y: number | null, p: number | null, color: string, tag: string, dash: number[], labelBelow = false): void => {
        if (y === null || p == null) return;
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(paneW, y); ctx.stroke();
        ctx.setLineDash([]);
        if (!tag) return;
        ctx.fillStyle = color;
        ctx.fillText(`${tag} ${p.toFixed(2)}`, 4, labelBelow ? y + 11 : y - 3); // left edge — PML/TML own the right
      };
      // DECLUTTER (2026-08-10): a TIGHT zone put the two EST labels ~0-3px apart and they
      // overprinted each other — when the lines sit within 14px, draw both lines but ONE
      // merged range label. OPEN labels BELOW its line so it can't collide with an EST
      // label sitting just above it.
      if (yHi !== null && yLo !== null && Math.abs(yLo - yHi) < 14 && ce.estCloseHigh != null && ce.estCloseLow != null) {
        ceLine(yHi, ce.estCloseHigh, "rgba(255,193,7,0.85)", "", [4, 3]);
        ceLine(yLo, ce.estCloseLow, "rgba(255,152,0,0.85)", "", [4, 3]);
        const lo = Math.min(ce.estCloseHigh, ce.estCloseLow), hi = Math.max(ce.estCloseHigh, ce.estCloseLow);
        ctx.fillStyle = "rgba(255,193,7,0.9)";
        ctx.fillText(`EST CL ${lo.toFixed(2)}–${hi.toFixed(2)}`, 4, Math.min(yHi, yLo) - 3);
      } else {
        ceLine(yHi, ce.estCloseHigh, "rgba(255,193,7,0.85)", "EST CL▲", [4, 3]);
        ceLine(yLo, ce.estCloseLow, "rgba(255,152,0,0.85)", "EST CL▼", [4, 3]);
      }
      ceLine(yOf(ce.rthOpen), ce.rthOpen, "rgba(96,165,250,0.8)", "OPEN", [], true);
      ctx.restore();
    }

    // ── Milk zones (uploaded PNG bands) — EXACT port of the old CandlestickChart band render:
    // filled rect fromTime→toTime, color derived from the zone, border + price/name labels.
    if (milkOnRef.current && milkZonesRef.current.length) {
      // Bar-index-snapped X mapping (same as the yellowbox layer). The old time-linear estX
      // was wrong on a bar-index axis (gaps take no width) AND conflated its -1 "can't map"
      // sentinel with legitimately negative off-screen-left coordinates, which rendered stale
      // full-width zones. timeToXSnap returns REAL coordinates (negative = off-left) or null
      // only when there's no data at all.
      const fb = currentRthSession();
      // largest zones first so narrow entry zones draw on top
      const zsorted = [...milkZonesRef.current].sort((a, b) => Math.abs(b.top - b.bottom) - Math.abs(a.top - a.bottom));
      for (const z of zsorted) {
        if (!Number.isFinite(z.top) || !Number.isFinite(z.bottom)) continue;
        const fromT = z.fromTime || fb.fromTime, toT = z.toTime || fb.toTime;
        const rawLeft = timeToXSnap(fromT), rawRight = timeToXSnap(toT);
        if (rawLeft === null || rawRight === null) continue; // no candles loaded — nothing to anchor to
        const zLeft = Math.max(0, rawLeft);
        const zRight = Math.min(paneW, rawRight);
        const zoneW = zRight - zLeft; if (zoneW <= 0) continue; // fully off-screen either side
        const rawYt = series.priceToCoordinate(z.top), rawYb = series.priceToCoordinate(z.bottom);
        if (rawYt === null || rawYb === null) continue;
        const zy = Math.max(0, Math.min(rawYt as number, rawYb as number));
        const zyb = Math.min(clipBottom, Math.max(rawYt as number, rawYb as number));
        const zrh = zyb - zy; if (zrh < 1) continue;
        let fillColor: string, borderColor: string, labelBgColor: string;
        const rgbaM = z.color?.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
        if (rgbaM) {
          const [, r, g, b, aStr] = rgbaM; const srcA = aStr ? parseFloat(aStr) : 0.07;
          const pd = Math.abs(z.top - z.bottom); const fa = pd > 50 ? Math.min(srcA, 0.04) : Math.min(srcA, 0.09);
          fillColor = `rgba(${r},${g},${b},${fa})`; borderColor = `rgba(${r},${g},${b},0.88)`; labelBgColor = `rgba(${r},${g},${b},0.62)`;
        } else if (z.color && /^#[0-9a-f]{6}$/i.test(z.color)) {
          fillColor = hexToRgba(z.color, 0.12); borderColor = hexToRgba(z.color, 0.90); labelBgColor = hexToRgba(z.color, 0.65);
        } else {
          const lbl = (z.label ?? "").toLowerCase(); const isS = lbl.includes("support") || lbl.includes("buy"); const isR = lbl.includes("resist") || lbl.includes("sell");
          fillColor = isS ? "rgba(38,200,122,0.12)" : isR ? "rgba(239,68,68,0.12)" : "rgba(200,180,50,0.12)";
          borderColor = isS ? "rgba(60,200,100,0.85)" : isR ? "rgba(220,60,60,0.85)" : "rgba(200,180,50,0.85)";
          labelBgColor = isS ? "rgba(30,120,60,0.80)" : isR ? "rgba(150,40,40,0.80)" : "rgba(140,120,30,0.80)";
        }
        ctx.save();
        ctx.fillStyle = fillColor; ctx.fillRect(zLeft, zy, zoneW, zrh);
        ctx.strokeStyle = borderColor; ctx.lineWidth = 1; ctx.strokeRect(zLeft, zy, zoneW, zrh);
        ctx.font = "bold 10px 'IBM Plex Mono',monospace"; ctx.textAlign = "right";
        const topLabel = z.top.toFixed(2), topLabelW = ctx.measureText(topLabel).width + 6;
        ctx.fillStyle = labelBgColor; ctx.fillRect(zLeft + zoneW - topLabelW, zy, topLabelW, 14);
        ctx.fillStyle = "#ffffff"; ctx.fillText(topLabel, zLeft + zoneW - 2, zy + 10);
        const botLabel = z.bottom.toFixed(2), botLabelW = ctx.measureText(botLabel).width + 6;
        ctx.fillStyle = labelBgColor; ctx.fillRect(zLeft + zoneW - botLabelW, zyb - 14, botLabelW, 14);
        ctx.fillStyle = "#ffffff"; ctx.fillText(botLabel, zLeft + zoneW - 2, zyb - 4);
        if (z.label && zrh > 18) {
          ctx.font = "bold 11px 'IBM Plex Mono',sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = borderColor;
          ctx.save(); ctx.beginPath(); ctx.rect(zLeft + 3, zy, zoneW - 6, zrh); ctx.clip();
          ctx.fillText(z.label, zLeft + 4, zy + Math.min(zrh / 2 + 4, zrh - 4)); ctx.restore();
        }
        ctx.restore();
      }
    }

    // ── Footprint ladder + cluster zones (only when Footprint enabled) ──────────
    if (fpOnRef.current) {
    const sessions = fpSessionsRef.current;
    if (sessions.length > 0) {
    const C_TOT = 80, MIN_ROW_H = 16;
    const activeT = sessions.reduce((m, s) => Math.max(m, s.time), 0);

    // Step 1 — cluster imbalance zones (full-pane bands, mitigation, historical at 28%).
    const zX1 = paneW - 62;
    if (zX1 > 0) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, zX1, clipBottom); ctx.clip();
      const cans = [...candlesRef.current].sort((a, b) => a.time - b.time);
      for (const zfp of [...sessions].sort((a, b) => a.time - b.time)) {
        if (zfp.time === activeT) continue;
        const xfR2 = ts.timeToCoordinate(zfp.time as any);
        const isCurZ = xfR2 !== null && (xfR2 as number) >= 0 && (xfR2 as number) <= paneW;
        const aM = isCurZ ? 1.0 : 0.28;
        const postStartTime = zfp.time + 25000;
        for (const cl of zfp.imbalances) {
          if (!cl.stacked) continue;
          const lo = Math.min(cl.startPrice, cl.endPrice), hi = Math.max(cl.startPrice, cl.endPrice);
          const buy = cl.direction === "buy";
          if (!isCurZ) {
            const mid = (lo + hi) / 2; let mitigated = false;
            for (const mc of cans) { if (mc.time < postStartTime) continue; if (buy ? mc.c < mid : mc.c > mid) { mitigated = true; break; } }
            if (mitigated) continue;
          }
          const tyR = series.priceToCoordinate(hi + 0.5), byR = series.priceToCoordinate(lo - 0.5);
          if (tyR === null || byR === null) continue;
          const zt = tyR as number, zh = Math.max(2, (byR as number) - zt);
          const tierMult = cl.strengthTier === 3 ? 1.8 : cl.strengthTier === 2 ? 1.4 : 1.0;
          const fillA = Math.min(0.45, 0.18 * aM * tierMult), lineA = Math.min(1.0, 0.75 * aM * tierMult);
          ctx.fillStyle = buy ? `rgba(31,217,138,${fillA.toFixed(3)})` : `rgba(255,77,109,${fillA.toFixed(3)})`;
          ctx.fillRect(0, zt, zX1, zh);
          ctx.strokeStyle = buy ? `rgba(31,217,138,${lineA.toFixed(3)})` : `rgba(255,77,109,${lineA.toFixed(3)})`;
          ctx.lineWidth = cl.strengthTier === 3 ? 1.5 : 1; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(0, zt); ctx.lineTo(zX1, zt); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, zt + zh); ctx.lineTo(zX1, zt + zh); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Step 2 — session ladders anchored at each session's first candle (net-delta column).
    const renderLadder = (fp: FootprintCandle, xL: number) => {
      if (fp.levels.length < 1 || fp.high <= fp.low) return;
      const lvSorted = [...fp.levels].sort((a, b) => b.price - a.price);
      const stkBuy = new Set<number>(), stkSell = new Set<number>(), inVA = new Set<number>();
      for (const lv of lvSorted) if (lv.price >= fp.val - 0.5 && lv.price <= fp.vah + 0.5) inVA.add(lv.price);
      for (const cl of fp.imbalances) {
        if (!cl.stacked) continue;
        const lo = Math.min(cl.startPrice, cl.endPrice), hi = Math.max(cl.startPrice, cl.endPrice);
        for (const lv of lvSorted) if (lv.price >= lo - 0.5 && lv.price <= hi + 0.5) (cl.direction === "buy" ? stkBuy : stkSell).add(lv.price);
      }
      const visible = lvSorted.filter((lv) => { const y = series.priceToCoordinate(lv.price); return y !== null && (y as number) >= -MIN_ROW_H && (y as number) <= clipBottom + MIN_ROW_H; });
      if (!visible.length) return;
      let pixPerLevel = MIN_ROW_H;
      if (visible.length >= 2) { const ya = series.priceToCoordinate(visible[0].price) as number; const yb = series.priceToCoordinate(visible[1].price) as number; pixPerLevel = Math.max(0.5, Math.abs(yb - ya)); }
      const skip = Math.max(1, Math.ceil(MIN_ROW_H / pixPerLevel)), displayH = pixPerLevel * skip;
      const rows = visible.filter((lv, i) => i % skip === 0 || i === visible.length - 1 || lv.price === fp.poc);
      if (!rows.length) return;
      ctx.save(); ctx.beginPath(); ctx.rect(xL, 0, C_TOT, clipBottom); ctx.clip();
      { const topY = (series.priceToCoordinate(rows[0].price) as number) - displayH / 2; ctx.fillStyle = "rgba(6,9,18,0.97)"; ctx.fillRect(xL, topY - 14, C_TOT, 14); ctx.font = "bold 8px 'IBM Plex Mono',monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.fillStyle = fp.symbol === "RTH" ? "#5b7fa8" : "#8070a8"; ctx.fillText(fp.symbol, xL + C_TOT / 2, topY - 7); }
      for (const lv of rows) {
        const yr = series.priceToCoordinate(lv.price); if (yr === null) continue;
        const cy = yr as number, rTop = cy - displayH / 2, rH = displayH;
        const isPoc = lv.price === fp.poc, isStkB = stkBuy.has(lv.price), isStkS = stkSell.has(lv.price), isBuy = lv.imbalance === "buy", isSell = lv.imbalance === "sell", isVA = inVA.has(lv.price);
        const bg = isStkS ? "rgba(26,5,5,0.95)" : isStkB ? "rgba(4,20,9,0.95)" : isSell ? "rgba(18,4,4,0.95)" : isBuy ? "rgba(3,14,7,0.95)" : isVA ? "rgba(9,14,28,0.95)" : "rgba(7,10,20,0.95)";
        ctx.fillStyle = bg; ctx.fillRect(xL, rTop, C_TOT, rH);
        const stripe = isStkS ? "#b91c1c" : isStkB ? "#15803d" : isSell ? "#6b1515" : isBuy ? "#0f5c2a" : isPoc ? "#92400e" : null;
        if (stripe) { ctx.fillStyle = stripe; ctx.fillRect(xL, rTop, 2, rH); }
        ctx.fillStyle = "rgba(255,255,255,0.03)"; ctx.fillRect(xL, rTop + rH - 1, C_TOT, 1);
        if (isPoc) { ctx.strokeStyle = "#92400e"; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(xL, rTop + 0.5); ctx.lineTo(xL + C_TOT, rTop + 0.5); ctx.stroke(); ctx.beginPath(); ctx.moveTo(xL, rTop + rH - 0.5); ctx.lineTo(xL + C_TOT, rTop + rH - 0.5); ctx.stroke(); }
        if (rH < 8) continue;
        const fs = Math.min(12, Math.max(9, rH * 0.52)), tY = rTop + rH / 2; ctx.textBaseline = "middle";
        ctx.font = `${isStkB || isStkS ? "bold" : "normal"} ${fs}px 'IBM Plex Mono',monospace`;
        ctx.fillStyle = isStkS ? "#ef4444" : isStkB ? "#22c55e" : isSell ? "#f87171" : isBuy ? "#4ade80" : "rgba(128,140,160,0.88)";
        ctx.textAlign = "center";
        const nd = lv.askVol - lv.bidVol; ctx.fillText((nd >= 0 ? "+" : "") + fmtVol(nd), xL + C_TOT / 2, tY);
      }
      { const t0 = (series.priceToCoordinate(rows[0].price) as number) - displayH / 2; const t1 = (series.priceToCoordinate(rows[rows.length - 1].price) as number) + displayH / 2; ctx.strokeStyle = "rgba(60,80,120,0.25)"; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.strokeRect(xL, t0, C_TOT, t1 - t0); }
      ctx.restore();
      // VAH / VAL guide lines
      ctx.save(); ctx.font = "bold 8px 'IBM Plex Mono',monospace"; ctx.textBaseline = "middle";
      const drawHL = (price: number, lbl: string, col: string) => { const vy = series.priceToCoordinate(price); if (vy === null) return; const y = vy as number; if (y < 0 || y > clipBottom) return; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.beginPath(); ctx.moveTo(xL, y); ctx.lineTo(xL + C_TOT, y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.textAlign = "right"; ctx.fillText(lbl, xL - 3, y); };
      drawHL(fp.vah, "VAH", "rgba(74,222,128,0.45)"); drawHL(fp.val, "VAL", "rgba(248,113,113,0.45)");
      ctx.restore();
    };
    for (const fp of sessions) {
      const xfR = ts.timeToCoordinate(fp.time as any); if (xfR === null) continue;
      const xf = xfR as number; if (xf < 0 || xf > paneW) continue;
      renderLadder(fp, xf);
    }
    } // end sessions.length > 0
    } // end fpOnRef.current

    // ── OUTCOME-STYLED SIGNAL MARKERS (2026-07-29) ─────────────────────────────
    // Resolved signals draw HERE on the overlay canvas (no new lw-charts series — architecture
    // rule): win = solid arrow + subtle green halo, loss = red HOLLOW arrow, session-end close =
    // gray arrow. OPEN/unresolved signals keep the plugin's current styling (see the markers
    // effect, which now feeds the plugin only unresolved rows). X snaps to candle indices via
    // timeToXSnap; Y anchors to the firing bar's low (long, below) / high (short, above).
    if (logToX && nC > 1) {
      const sigs = signalsRef.current;
      if (sigs.length) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, paneW, clipBottom); ctx.clip();
        ctx.font = "bold 8px 'IBM Plex Mono',monospace"; ctx.textAlign = "center";
        for (const s of sigs) {
          const kind = s.status === "TARGET" || s.status === "TP1 HIT" ? "win"
            : s.status === "STOPPED" ? "loss"
            : s.status === "EOD" ? "eod" : null;
          if (!kind) continue; // open/expired → plugin marker (current styling)
          // Anchor bar: the candle at the fire time (tolerate one-interval snap).
          const bi = lbTime(s.ts);
          const cand = bi < nC && Math.abs(cansAll[bi].time - s.ts) < secPerBar ? cansAll[bi]
            : bi > 0 && Math.abs(cansAll[bi - 1].time - s.ts) < secPerBar ? cansAll[bi - 1] : null;
          if (!cand) continue;
          const xR = timeToXSnap(cand.time);
          if (xR == null || xR < -12 || xR > paneW + 12) continue;
          const x = xR;
          const isLong = s.side === "LONG";
          const pyR = series.priceToCoordinate(isLong ? cand.l : cand.h);
          if (pyR == null) continue;
          const yA = (pyR as number) + (isLong ? 6 : -6); // arrow tip, offset off the wick
          if (yA < -12 || yA > clipBottom + 12) continue;
          const h = 8, w2 = 4.5; // triangle height / half-width
          const yBase = isLong ? yA + h : yA - h;
          const color = kind === "win" ? (isLong ? "#26c87a" : "#ef5350")
            : kind === "loss" ? "#ef5350" : "#8b93a0";
          if (kind === "win") { // subtle green halo behind the solid arrow
            ctx.beginPath();
            ctx.arc(x, yA + (isLong ? h / 2 : -h / 2), 9.5, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(38,200,122,0.16)";
            ctx.fill();
          }
          ctx.beginPath();
          ctx.moveTo(x, yA);
          ctx.lineTo(x - w2, yBase);
          ctx.lineTo(x + w2, yBase);
          ctx.closePath();
          if (kind === "loss") { // hollow: outline only
            ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
          } else {
            ctx.fillStyle = color; ctx.fill();
          }
          ctx.fillStyle = color; ctx.textBaseline = isLong ? "top" : "bottom";
          ctx.fillText(isLong ? "L" : "S", x, yBase + (isLong ? 3 : -3));
        }
        ctx.restore();
      }
    }

    // ── Selected signal: Entry / TP1 / TP2 / Stop lines + fill bands ──────────
    // Always drawn regardless of Footprint toggle.
    // Ported from CandlestickChart.tsx renderConfluenceSegment — same visual as the old chart.
    const sel = selectedSigRef.current;
    if (sel) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, paneW, clipBottom); ctx.clip(); // never paint over the axes
      const isLong = sel.side === "LONG";
      const dirColor = isLong ? "#26c87a" : "#ef5350";
      const safeSlPrice = isLong ? Math.min(sel.stop, sel.entry - 0.25) : Math.max(sel.stop, sel.entry + 0.25);
      const x1R = ts.timeToCoordinate(sel.ts as any);
      const x1 = x1R !== null ? (x1R as number) : (timeToXSnap(sel.ts) ?? 0);
      const x2 = paneW;

      // Background fills (profit zone / risk zone)
      const fillBand = (priceA: number, priceB: number, fillColor: string) => {
        const yA = series.priceToCoordinate(priceA), yB = series.priceToCoordinate(priceB);
        if (yA == null || yB == null) return;
        const top = Math.min(yA as number, yB as number), ht = Math.max(Math.abs((yA as number) - (yB as number)), 1);
        ctx.save(); ctx.fillStyle = fillColor; ctx.fillRect(x1, top, x2 - x1, ht); ctx.restore();
      };
      // TP1-ONLY (2026-08-13): tp2 null on post-policy rows — the profit band runs to TP1.
      fillBand(sel.entry, sel.tp2 ?? sel.tp1, isLong ? "rgba(38,166,154,0.07)" : "rgba(239,83,80,0.07)");
      fillBand(sel.entry, safeSlPrice, isLong ? "rgba(239,83,80,0.07)" : "rgba(38,166,154,0.07)");

      // Horizontal level lines with right-edge labels
      const drawLevel = (price: number, color: string, dash: number[], width: number, label: string) => {
        const y = series.priceToCoordinate(price); if (y == null) return;
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(x1, y as number); ctx.lineTo(x2, y as number); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "bold 9px 'IBM Plex Mono',monospace"; ctx.textBaseline = "middle";
        const lw = ctx.measureText(label).width + 8;
        const labelX = x2 - lw - 6;
        ctx.fillStyle = color + "dd"; ctx.fillRect(labelX, (y as number) - 7, lw, 14);
        ctx.fillStyle = "#ffffff"; ctx.textAlign = "left";
        ctx.fillText(label, labelX + 4, y as number);
        ctx.restore();
      };

      // Vertical entry bar
      const ey = series.priceToCoordinate(sel.entry);
      if (ey != null) {
        ctx.save(); ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(x1, (ey as number) - 30); ctx.lineTo(x1, (ey as number) + 30);
        ctx.stroke(); ctx.setLineDash([]); ctx.restore();
      }

      // TP1-ONLY (2026-08-13): single TP line when tp2 is null.
      if (sel.tp2 != null) {
        drawLevel(sel.tp2,    dirColor,          [8, 4], 1.5, `TP2 ${sel.tp2.toFixed(2)}`);
        drawLevel(sel.tp1,    dirColor + "bb",   [5, 3], 1,   `TP1 ${sel.tp1.toFixed(2)}`);
      } else {
        drawLevel(sel.tp1,    dirColor,          [8, 4], 1.5, `TP ${sel.tp1.toFixed(2)}`);
      }
      drawLevel(sel.entry,    "#ffffffaa",        [],     1,   `E ${sel.entry.toFixed(2)}`);
      drawLevel(safeSlPrice,  "#ef5350",          [5, 3], 1,   `Stop ${safeSlPrice.toFixed(2)}`);

      // "Press Esc to clear" hint at top-left
      ctx.save();
      ctx.font = "10px 'IBM Plex Mono',monospace"; ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("Click elsewhere or press Esc to clear", 8, 8);
      ctx.restore();
      ctx.restore(); // pane clip
    }

    // ── 1m history seam note ────────────────────────────────────────────────────
    // When the 1m history floor is reached (server-declared servedFloorTs when available,
    // else the fully-loaded flag) and the left edge is in view, mark the seam instead of
    // just stopping — older data lives on the coarser resolutions.
    if (intervalRef.current === "1m" && nC > 0 && logToX && vr && vr.from < 2) {
      const floorT = seamFloorRef.current;
      // The 1m timeline "ends here" for the user when either (a) the loaded data reaches the
      // server-declared servedFloorTs, or (b) the full history is loaded — nothing more will
      // arrive on scroll-back even if the server floor is older (MAX_CANDLES caps the client
      // at 200k bars ≈ 7 months of 1m; the older months only exist on coarser resolutions).
      const atFloor = fullyLoadedRef.current ||
                      (floorT !== null && cansAll[0].time <= floorT + 120);
      if (atFloor) {
        const x = Math.max(1.5, logToX(-0.5));
        ctx.save();
        ctx.strokeStyle = "rgba(255,180,84,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, clipBottom); ctx.stroke(); ctx.setLineDash([]);
        const msg1 = "1m history ends here";
        const msg2 = "switch to 5m for older data";
        ctx.font = "10px 'IBM Plex Mono',monospace"; ctx.textAlign = "left"; ctx.textBaseline = "top";
        const w = Math.max(ctx.measureText(msg1).width, ctx.measureText(msg2).width) + 14;
        const bx = x + 6, by = Math.max(8, clipBottom * 0.35);
        ctx.fillStyle = "rgba(8,10,16,0.88)";
        ctx.fillRect(bx, by, w, 34);
        ctx.strokeStyle = "rgba(255,180,84,0.45)"; ctx.strokeRect(bx, by, w, 34);
        ctx.fillStyle = "rgba(255,180,84,0.95)";
        ctx.fillText(msg1, bx + 7, by + 5);
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fillText(msg2, bx + 7, by + 18);
        ctx.restore();
      }
    }
  };
  drawFpRef.current = drawFootprint;

  // ── Probability overlays: each fractal concept drawn individually on its own canvas layer ──
  const scheduleProbDraw = () => {
    cancelAnimationFrame(probRafRef.current);
    probRafRef.current = requestAnimationFrame(() => drawProbRef.current());
  };
  const drawProbability = () => {
    const canvas = probCanvasRef.current, chart = chartRef.current, series = candleRef.current, host = hostRef.current;
    if (!canvas || !chart || !series || !host) return;
    const cw = host.clientWidth, ch = host.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
      canvas.width = Math.floor(cw * dpr); canvas.height = Math.floor(ch * dpr);
      canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
    }
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!strategies.Probability) return;
    const snap = probSnapRef.current; if (!snap) return;
    const ts = chart.timeScale();
    // Pane geometry — keep overlay marks off the price/time axes (same as drawFootprint).
    let paneW = cw, paneBottom = ch;
    try { const w = ts.width(); if (w > 0 && w <= cw) paneW = w; } catch { /* keep cw */ }
    try { const h = ts.height(); if (h > 0 && h < ch) paneBottom = ch - h; } catch { /* keep ch */ }
    ctx.font = "10px 'IBM Plex Mono', monospace";

    // Pixel-density estimator → map any unix ts → X, including FUTURE times (forecast cone).
    const sortedC = [...candlesRef.current].sort((a, b) => a.time - b.time);
    let pxPerSec = 0, refX = 0, refT = 0;
    for (let si = sortedC.length - 1; si > 0; si--) {
      const t1 = sortedC[si - 1].time, t2 = sortedC[si].time;
      const cx1 = ts.timeToCoordinate(t1 as any) as number | null;
      const cx2 = ts.timeToCoordinate(t2 as any) as number | null;
      if (cx1 !== null && cx2 !== null && t2 !== t1) { pxPerSec = (cx2 - cx1) / (t2 - t1); refX = cx2; refT = t2; break; }
    }
    const estX = (t: number): number => { const c = ts.timeToCoordinate(t as any) as number | null; return c !== null ? c : (pxPerSec !== 0 ? refX + (t - refT) * pxPerSec : -1); };
    const Y = (p: number): number | null => { const y = series.priceToCoordinate(p); return y === null ? null : (y as number); };

    // ── 1. Value Area — long-run POC / VAH / VAL horizontal lines + 70% band ──
    if (strategies.probValueArea && snap.valueArea) {
      const va = snap.valueArea;
      const yH = Y(va.vah), yL = Y(va.val);
      if (yH !== null && yL !== null) { ctx.fillStyle = "rgba(255,180,84,0.05)"; ctx.fillRect(0, Math.min(yH, yL), paneW, Math.abs(yL - yH)); }
      const hLine = (price: number, color: string, label: string, dash: number[] = []) => {
        const y = Y(price); if (y === null || y < 0 || y > paneBottom) return;
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(paneW, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = color; ctx.textAlign = "left"; ctx.fillText(label, 6, y - 3);
      };
      hLine(va.vah, C.down, `VAH ${va.vah.toFixed(2)}`, [4, 3]);
      hLine(va.poc, C.amber, `POC ${va.poc.toFixed(2)}`);
      hLine(va.val, C.up, `VAL ${va.val.toFixed(2)}`, [4, 3]);
    }

    // ── 2. Target Levels — Hurst target-scaler ± expected range at the current price ──
    if (strategies.probScaler && snap.projection) {
      ctx.textAlign = "right";
      for (const lv of snap.projection.levels) {
        for (const [price, tag] of [[lv.up, `+${lv.horizon}b`], [lv.dn, `-${lv.horizon}b`]] as [number, string][]) {
          const y = Y(price); if (y === null || y < 0 || y > paneBottom) continue;
          ctx.strokeStyle = "rgba(96,165,250,0.45)"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(paneW * 0.58, y); ctx.lineTo(paneW, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = "rgba(96,165,250,0.85)"; ctx.fillText(tag, paneW - 5, y - 2);
        }
      }
    }

    // ── 3. Forecast Cone — fBm Hurst-scaled expected range projecting right from the last bar ──
    if (strategies.probForecast && snap.projection && sortedC.length) {
      const last = sortedC[sortedC.length - 1];
      const ivSec = INTERVAL_SECS[interval] ?? 300;
      const x0 = estX(last.time), y0 = Y(snap.price);
      if (y0 !== null && x0 >= 0) {
        const pts = snap.projection.levels.map((lv) => ({ x: estX(last.time + lv.horizon * ivSec), yu: Y(lv.up), yd: Y(lv.dn) }));
        ctx.beginPath(); ctx.moveTo(x0, y0);
        for (const p of pts) if (p.yu !== null) ctx.lineTo(p.x, p.yu);
        for (let i = pts.length - 1; i >= 0; i--) if (pts[i].yd !== null) ctx.lineTo(pts[i].x, pts[i].yd as number);
        ctx.closePath(); ctx.fillStyle = "rgba(45,212,191,0.08)"; ctx.fill();
        ctx.strokeStyle = "rgba(45,212,191,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x0, y0); for (const p of pts) if (p.yu !== null) ctx.lineTo(p.x, p.yu); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, y0); for (const p of pts) if (p.yd !== null) ctx.lineTo(p.x, p.yd as number); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ── 4. Regime Ribbon — DFA-Hurst regime colored along the bottom of the chart over time ──
    if (strategies.probRegime && snap.regimeStrip.length) {
      const ribH = 7, ribY = paneBottom - ribH - 2; // above the time axis, not painted over it
      const regColor: Record<Regime, string> = { PERSISTENT: C.up, MEANREVERT: C.amber, NEUTRAL: "rgba(124,129,144,0.7)", UNKNOWN: "rgba(86,91,105,0.45)" };
      const strip = snap.regimeStrip;
      for (let i = 0; i < strip.length; i++) {
        const x1 = estX(strip[i].time);
        const x2 = i + 1 < strip.length ? estX(strip[i + 1].time) : x1 + (pxPerSec !== 0 && strip[i - 1] ? pxPerSec * (strip[i].time - strip[i - 1].time) : 8);
        const xa = Math.max(0, x1), xb = Math.min(paneW, x2); if (xb <= xa) continue;
        ctx.fillStyle = regColor[strip[i].regime]; ctx.fillRect(xa, ribY, xb - xa, ribH);
      }
      ctx.fillStyle = C.muted; ctx.textAlign = "left"; ctx.font = "8px 'IBM Plex Mono', monospace";
      ctx.fillText("REGIME", 6, ribY - 2);
    }
  };
  drawProbRef.current = drawProbability;

  // ── Footprint: fetch REAL per-candle data → delta tint + session aggregates → redraw ──
  // Coverage tracking: refetch the (whole-history) footprint endpoint ONLY when footprint is ON
  // and the candle coverage actually extends past what the last fetch saw — NOT on every bar
  // rollover, and never at all when the toggle is OFF (the old effect did a full setData +
  // full refetch per rollover even when OFF).
  const fpFetchKeyRef = useRef("");
  const fpFetchedToRef = useRef(0);
  useEffect(() => {
    if (!strategies.Footprint) {
      // Idempotent early-out: clear once when toggling off, no per-rollover work after that.
      const hadData = deltaRef.current.size > 0 || fpSessionsRef.current.length > 0;
      deltaRef.current = new Map();
      fpSessionsRef.current = [];
      fpFetchKeyRef.current = "";
      fpFetchedToRef.current = 0;
      if (hadData) applyCandles(); // un-tint once
      scheduleFpDraw();
      return;
    }

    // Session ladders + imbalance ZONES. Baseline = OHLCV PROXY footprint per chart candle,
    // aggregated into RTH/ETH sessions (each anchored at its first candle). This is the always-
    // available "old footprint" so EVERY session has a ladder/zones even with no real data, and it
    // renders instantly (synchronous, no fetch, no server restart). Real persisted data then
    // UPGRADES the sessions it applies to (below) — proxy stays for the rest.
    const validCandles = candles.filter((c) => c && c.h >= c.l);
    const buildSessions = (realByTime?: Map<number, FootprintCandle>) =>
      aggregateSessions(
        validCandles.map((c) =>
          realByTime?.get(c.time) ??
          buildProxyFootprintCandle({ time: c.time, open: c.o, high: c.h, low: c.l, close: c.c }),
        ),
      );
    fpSessionsRef.current = buildSessions();
    scheduleFpDraw(); // sessions redraw is canvas-only — no candle setData needed here

    // Refetch gate: same symbol/interval AND no new candle coverage → keep existing deltas.
    const lastT = candles.length ? candles[candles.length - 1].time : 0;
    const key = `${symbol}|${interval}`;
    if (key === fpFetchKeyRef.current && lastT <= fpFetchedToRef.current) return;

    // Upgrade with REAL persisted footprint where applicable: any chart candle whose time matches a
    // real per-candle bucket uses the real bid/ask levels; the rest stay proxy. Sessions covered by
    // real data become accurate; historical sessions keep their proxy zones. Also drives delta tint.
    let cancelled = false;
    const base = interval === "15m" ? "5m" : interval;
    fetch(`/api/footprint/history/${encodeURIComponent(symbol)}/${base}`)
      .then((r) => r.json())
      .then((arr) => {
        if (cancelled || !Array.isArray(arr)) return;
        fpFetchKeyRef.current = key;
        fpFetchedToRef.current = lastT;
        const realByTime = new Map<number, FootprintCandle>();
        const m: DeltaMap = new Map();
        for (const fc of arr) {
          if (!fc || typeof fc.time !== "number") continue;
          m.set(fc.time, footprintDelta(fc));
          if (Array.isArray(fc.levels) && fc.levels.length) realByTime.set(fc.time, fc as FootprintCandle);
        }
        // Diff old→new deltas so a rollover with unchanged history can apply incrementally.
        const old = deltaRef.current;
        const changed: number[] = [];
        for (const [t, d] of m) if (old.get(t) !== d) { changed.push(t); if (changed.length > 2) break; }
        if (changed.length <= 2) for (const t of old.keys()) if (!m.has(t)) { changed.push(t); if (changed.length > 2) break; }
        deltaRef.current = m;
        // Only merge real per-candle data when the chart interval matches the data's base interval,
        // so candle times line up 1:1 with real buckets (a 15m chart uses a 5m base → times don't align).
        if (interval === base && realByTime.size) fpSessionsRef.current = buildSessions(realByTime);
        const lastBar = candles.length ? candles[candles.length - 1] : null;
        if (changed.length === 0) {
          // nothing new — canvas redraw only
        } else if (lastBar && changed.length <= 2 && changed.every((t) => t === lastBar.time)) {
          // INCREMENTAL: only the forming/last bar's delta changed — lw-charts only allows
          // update() on the last bar, which is exactly this case.
          try { candleRef.current?.update(toItem(lastBar)); } catch { applyCandles(); }
        } else {
          applyCandles(); // historical tint changed — full re-upload required
        }
        scheduleFpDraw();
      })
      .catch(() => { /* ignore — proxy session ladders are already drawn */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, strategies.Footprint, barSig]);

  // ── YELLOW-BOX: fetch the per-trading-day boxes for the loaded candle range → redraw ──
  // Keyed off barSig so the boxes EXTEND as deep history lazy-loads (the terminal fast-open
  // loads ~10 days; scroll-back prepends more bars → barSig changes → wider range refetch).
  // Completed days are served from the server's immutable cache, so refetches are sub-ms.
  useEffect(() => {
    if (!strategies.YellowBox) { scheduleFpDraw(); return; } // keep cached days; the draw gate hides them
    if (!candles.length) return;
    let cancelled = false;
    const fromTs = candles[0].time;
    const toTs = candles[candles.length - 1].time + 86400; // include today's box (server clamps to now)
    fetch(`/api/yellowbox/day-zones?symbol=${encodeURIComponent(symbol)}&fromTs=${fromTs}&toTs=${toTs}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d || !Array.isArray(d.days)) return;
        ybRef.current = d.days as YbDay[];
        scheduleFpDraw();
      })
      .catch(() => { /* ignore — boxes simply don't draw this pass */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, barSig, strategies.YellowBox]);

  // ── PML/TML: LIVE money lines under the YellowBox toggle family (3-min poll, matches the
  // server cache). Options-chain data — current levels only; nothing draws when the fetch is
  // skipped server-side (no chain / offline). ──
  useEffect(() => {
    if (!strategies.YellowBox) { pmlTmlRef.current = null; scheduleFpDraw(); return; }
    let cancelled = false;
    const pull = () => {
      fetch(`/api/pml-tml?symbol=${encodeURIComponent(symbol)}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          pmlTmlRef.current = d && !d.skipped ? { pml: d.pml ?? null, tml: d.tml ?? null, source: d.source } : null;
          scheduleFpDraw();
        })
        .catch(() => { /* ignore — lines simply don't draw */ });
    };
    pull();
    const id = window.setInterval(pull, 3 * 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, strategies.YellowBox]);

  // ── CLOSE-EST: EOD close-estimate zone under its OWN Strategies toggle (3-min poll,
  // matches the server cache; levels are time-based, not bar-based — same as PML/TML). The
  // server reruns from the running extremes, so a new HOD/LOD lands on the next poll. ──
  useEffect(() => {
    if (!strategies.CloseEst) { closeEstRef.current = null; scheduleFpDraw(); return; }
    let cancelled = false;
    const pull = () => {
      fetch(`/api/close-estimate?symbol=${encodeURIComponent(symbol)}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          closeEstRef.current = d && !d.skipped && d.day
            ? {
                estCloseHigh: Number.isFinite(d.day.estCloseHigh) ? d.day.estCloseHigh : null,
                estCloseLow: Number.isFinite(d.day.estCloseLow) ? d.day.estCloseLow : null,
                rthOpen: Number.isFinite(d.day.rthOpen) ? d.day.rthOpen : null,
              }
            : null;
          scheduleFpDraw();
        })
        .catch(() => { /* ignore — the zone simply doesn't draw */ });
    };
    pull();
    const id = window.setInterval(pull, 3 * 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, strategies.CloseEst]);

  // ── 1m seam floor: consume the server's servedFloorTs when the endpoint exists ──
  // Coded defensively behind existence checks (the endpoint is being added server-side):
  // probe /api/data/served-range then /api/data/gaps for a servedFloorTs field; absence is fine
  // (the seam note then keys off the fullyLoaded flag alone).
  useEffect(() => {
    seamFloorRef.current = null;
    if (interval !== "1m") return;
    let cancelled = false;
    (async () => {
      const sym = encodeURIComponent(symbol);
      for (const url of [`/api/data/served-range/${sym}/1`, `/api/data/gaps/${sym}/1`]) {
        try {
          const r = await fetch(url);
          if (!r.ok) continue;
          const d = await r.json();
          const f = Number(d?.servedFloorTs ?? d?.servedFloor ?? NaN);
          if (cancelled) return;
          if (Number.isFinite(f) && f > 0) { seamFloorRef.current = f; scheduleFpDraw(); return; }
        } catch { /* endpoint not live yet — keep probing / fall back */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  // Redraw the footprint + probability overlays when the visible time range changes (pan / zoom).
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const sub = () => { scheduleFpDraw(); scheduleProbDraw(); };
    chart.timeScale().subscribeVisibleTimeRangeChange(sub);
    return () => { try { chart.timeScale().unsubscribeVisibleTimeRangeChange(sub); } catch { /* ignore */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute the probability snapshot when the bar set changes (memoized to barSig), then redraw.
  useEffect(() => {
    if (!strategies.Probability) { probSnapRef.current = null; scheduleProbDraw(); return; }
    const ivSec = INTERVAL_SECS[interval] ?? 300;
    probSnapRef.current = computeProbabilitySnapshot(candles, ivSec);
    scheduleProbDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barSig, strategies.Probability, interval]);

  // Redraw (no recompute) when an individual overlay is toggled.
  useEffect(() => { scheduleProbDraw(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strategies.probValueArea, strategies.probRegime, strategies.probForecast, strategies.probScaler, selectedSig]);

  // ── Lazy deep-history: load the full history when the user scrolls near the left edge ──
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const sub = (range: { from: number; to: number } | null) => {
      if (!range || fullyLoadedRef.current) return;
      // `from` is a logical index; < ~20 means the user is within 20 bars of the loaded start.
      // Require a non-trivial dataset: a transient view during an interval switch (or a tiny
      // seed) must never auto-fire the full deep-history download.
      if (range.from < 20 && candlesRef.current.length > 50) onNeedHistoryRef.current?.();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(sub);
    return () => { try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(sub); } catch { /* ignore */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Signal markers ──
  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    const times = candles.map((c) => c.time);
    // NOTE: Math.min/max(...times) overflows the call stack on 1m (~190k bars spread as args).
    // Compute via a loop instead — never spread a full-history candle array.
    let minT = 0, maxT = 0;
    if (times.length) {
      minT = maxT = times[0];
      for (let i = 1; i < times.length; i++) { const t = times[i]; if (t < minT) minT = t; if (t > maxT) maxT = t; }
    }
    // OUTCOME-STYLED MARKERS (2026-07-29): resolved signals (win / loss / session-end close)
    // render on the overlay canvas in drawFootprint — the plugin keeps ONLY unresolved signals
    // at the current styling. Total shown = plugin + canvas = every signal in the candle range.
    const resolvedOnCanvas = new Set(["TARGET", "TP1 HIT", "STOPPED", "EOD"]);
    const markers = [...signals]
      .filter((s) => s.ts >= minT && s.ts <= maxT && !resolvedOnCanvas.has(s.status))
      .sort((a, b) => a.ts - b.ts)
      .map((s) => s.side === "LONG"
        ? { time: s.ts as UTCTimestamp, position: "belowBar" as const, color: C.up, shape: "arrowUp" as const, text: "L" }
        : { time: s.ts as UTCTimestamp, position: "aboveBar" as const, color: C.down, shape: "arrowDown" as const, text: "S" });
    m.setMarkers(markers);
    scheduleFpDraw(); // outcome markers live on the overlay canvas — redraw with the new signal set
  }, [signals, barSig]);

  // MilkZone bands are drawn on the overlay canvas (drawFootprint, filled-band render — same as
  // the old chart). Redraw when the zones, the toggle, or the candle set changes.
  useEffect(() => { scheduleFpDraw(); }, [milkZones, strategies.MilkZone, barSig]);

  // YELLOW-BOX: immediate overlay redraw when the toggle flips (fetch effect handles data).
  useEffect(() => { scheduleFpDraw(); }, [strategies.YellowBox]);

  // Redraw when the selected signal changes (shows/hides the Entry/TP1/TP2/Stop lines).
  useEffect(() => { scheduleFpDraw(); }, [selectedSig]);

  // ── Reload / enter-Market / interval switch: re-land on the live edge ──
  useEffect(() => {
    // Reset prepend-tracking so the first candle set for the new interval/reload re-fits
    // cleanly instead of being mistaken for a deep-history prepend (which would offset the view).
    prevFirstTimeRef.current = 0;
    prevLenRef.current = 0;
    prevLastTimeRef.current = 0;
    didFitRef.current = false;
    if (chartRef.current && candles.length) { fitRecent(); didFitRef.current = true; }
    scheduleFpDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartKey]);

  return (
    <div className="tt-livechart">
      <div className="tt-livechart-host" ref={hostRef} />
      <canvas
        ref={fpCanvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 3 }}
      />
      <canvas
        ref={probCanvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 4 }}
      />
      <div key={"sweep" + chartKey} className="tt-sweep" />
    </div>
  );
}
