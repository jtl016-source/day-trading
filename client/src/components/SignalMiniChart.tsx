/**
 * SignalMiniChart — compact candlestick chart centred on a signal.
 *
 * Shows: candlesticks (vector-coloured), all interval vector lines, milk zones,
 * entry circle, TP1/TP2/SL as solid highlighted bands — exactly like the main chart.
 *
 * Props
 *   candles       – full candle array for the interval (sorted or unsorted)
 *   signal        – { time, direction, price, tp1?, tp2?, sl?, atr? }
 *   zones         – pre-computed ZoneBand[] (optional)
 *   vecMap        – main-interval vector Map<time→value> (optional; built from candles)
 *   extraVecMaps  – additional interval vectors [{label, color, map}]
 *   showVec       – show vector lines (default true)
 *   showMilk      – show zone rectangles (default true)
 *   height        – px height of chart (default 200)
 */
import { useRef, useMemo, useLayoutEffect, useEffect } from "react";
import {
  createChart, CandlestickSeries, LineSeries,
  ColorType, LineStyle, CrosshairMode, type IChartApi, type ISeriesApi,
} from "lightweight-charts";
import { type CandleBar, type ZoneBand, CHART_THEMES } from "./CandlestickChart";

const T = CHART_THEMES.motivewave;
const VEC_LENGTH  = 20;
const BEFORE      = 10;
const AFTER       = 10;
const MAX_EXTRA   = 3;       // pre-allocated extra LineSeries slots
const ATR_TP1_M   = 1.0;
const ATR_TP2_M   = 2.0;
const ATR_SL_M    = 0.5;
const FALLBACK_ATR = 5;

function buildVecMap(sorted: CandleBar[]): Map<number, number> {
  const n  = sorted.length;
  const lb = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let lo = sorted[i].low;
    for (let j = Math.max(0, i - VEC_LENGTH + 1); j < i; j++) if (sorted[j].low < lo) lo = sorted[j].low;
    lb[i] = lo;
  }
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    let hi = lb[i];
    for (let j = Math.max(0, i - VEC_LENGTH + 1); j < i; j++) if (lb[j] > hi) hi = lb[j];
    m.set(sorted[i].time, hi);
  }
  return m;
}

/** Forward-fill a coarser vector map onto finer chart times. */
function forwardFill(
  map:   Map<number, number>,
  times: number[],
): Array<{ time: any; value: number }> {
  const entries = Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  const result: Array<{ time: any; value: number }> = [];
  let vi = 0;
  for (const t of times) {
    while (vi + 1 < entries.length && entries[vi + 1][0] <= t) vi++;
    if (entries[vi] && entries[vi][0] <= t) result.push({ time: t as any, value: entries[vi][1] });
  }
  return result;
}

export interface SignalMiniChartProps {
  candles:       CandleBar[];
  signal: {
    time:      number;
    direction: "Long" | "Short";
    price:     number;
    tp1?:      number;
    tp2?:      number;
    sl?:       number;
    atr?:       number;   // used to derive tp/sl when tp1/tp2/sl not supplied
    toTime?:    number;   // first bar where TP1/TP2/SL is hit; bounds fill width
    riskLevel?: string;   // "safe" | "risky" | "riskiest" — controls marker color
  };
  zones?:        ZoneBand[];
  vecMap?:       Map<number, number>;
  extraVecMaps?:    Array<{ label: string; color: string; map: Map<number, number> }>;
  showVec?:         boolean;
  showMilk?:        boolean;
  showSignalMark?:  boolean;  // show glow + circle on signal candle (default true)
  height?:          number;
}

export function SignalMiniChart({
  candles,
  signal,
  zones,
  vecMap:          vecMapProp,
  extraVecMaps     = [],
  showVec          = true,
  showMilk         = true,
  showSignalMark   = true,
  height           = 200,
}: SignalMiniChartProps) {
  const containerRef    = useRef<HTMLDivElement>(null);
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const chartRef        = useRef<IChartApi | null>(null);
  const candleRef       = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vecRef          = useRef<ISeriesApi<"Line"> | null>(null);
  const extraVecRefs    = useRef<ISeriesApi<"Line">[]>([]);
  const drawRef         = useRef<() => void>(() => {});

  const sorted = useMemo(() => [...candles].sort((a, b) => a.time - b.time), [candles]);

  const vecMap = useMemo(() => vecMapProp ?? buildVecMap(sorted), [vecMapProp, sorted]);

  const signalIdx = useMemo(() => {
    const exact = sorted.findIndex(c => c.time === signal.time);
    if (exact !== -1) return exact;
    let idx = 0;
    for (let i = 0; i < sorted.length; i++) { if (sorted[i].time <= signal.time) idx = i; else break; }
    return idx;
  }, [sorted, signal.time]);

  const candleWindow = useMemo(
    () => sorted.slice(Math.max(0, signalIdx - BEFORE), Math.min(sorted.length, signalIdx + AFTER + 1)),
    [sorted, signalIdx],
  );

  // ── Canvas draw ────────────────────────────────────────────────────────────
  drawRef.current = () => {
    const canvas = canvasRef.current, chart = chartRef.current, series = candleRef.current;
    if (!canvas || !chart || !series || !candleWindow.length) return;
    const dpr  = globalThis.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cw   = rect.width, ch = rect.height;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width  = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width  = cw + "px";
      canvas.style.height = ch + "px";
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const ts   = chart.timeScale();
    const winS = candleWindow[0].time;
    const winE = candleWindow[candleWindow.length - 1].time;

    // ── Zone rectangles ────────────────────────────────────────────────────
    if (showMilk) {
      for (const z of (zones ?? [])) {
        const zFrom = z.fromTime ?? 0, zTo = z.toTime ?? 9e9;
        if (zTo < winS || zFrom > winE) continue;
        const lx = ts.timeToCoordinate(Math.max(zFrom, winS) as any) ?? 0;
        const rx = ts.timeToCoordinate(Math.min(zTo, winE)   as any) ?? cw;
        const yt = series.priceToCoordinate(z.topPrice);
        const yb = series.priceToCoordinate(z.bottomPrice);
        if (yt == null || yb == null) continue;
        const zx = Math.min(lx, rx), zw = Math.abs(rx - lx);
        const zy = Math.min(yt, yb), zh = Math.abs(yb - yt);
        if (zw < 1) continue;
        ctx.save();
        ctx.fillStyle   = z.color + "28";
        ctx.strokeStyle = z.color + "bb";
        ctx.lineWidth   = 1;
        ctx.fillRect(zx, zy, zw, Math.max(zh, 1));
        ctx.strokeRect(zx, zy, zw, Math.max(zh, 1));
        if (z.label && zh > 10) {
          ctx.font      = "bold 8px 'Trebuchet MS', monospace";
          ctx.fillStyle = z.color + "dd";
          ctx.textAlign = "left";
          ctx.fillText(z.label, zx + 3, zy + 9);
        }
        ctx.restore();
      }
    }

    // ── TP / SL levels + entry circle ──────────────────────────────────────
    const isLong   = signal.direction === "Long";
    const dirClr   = isLong ? "#26c87a" : "#ef5350";
    const atr      = signal.atr ?? FALLBACK_ATR;
    const tp1      = signal.tp1 ?? (isLong ? signal.price + ATR_TP1_M * atr : signal.price - ATR_TP1_M * atr);
    const tp2      = signal.tp2 ?? (isLong ? signal.price + ATR_TP2_M * atr : signal.price - ATR_TP2_M * atr);
    const sl       = signal.sl  ?? (isLong ? signal.price - ATR_SL_M  * atr : signal.price + ATR_SL_M  * atr);

    const sigX  = ts.timeToCoordinate(signal.time as any);
    const rightX = ts.timeToCoordinate(winE as any) ?? cw;

    // Tier-based marker color: safe=green, risky=amber, riskiest=red (falls back to direction)
    const rl = signal.riskLevel;
    const tierRgb = rl === "safe" ? "38,200,122" : rl === "risky" ? "245,158,11" : rl === "riskiest" ? "239,68,68" : (isLong ? "38,200,122" : "239,83,80");

    // ── Mark the signal candle — vertical glow strip ──────────────────────
    if (sigX != null && showSignalMark) {
      const grd = ctx.createLinearGradient(sigX - 8, 0, sigX + 8, 0);
      grd.addColorStop(0, "transparent");
      grd.addColorStop(0.5, `rgba(${tierRgb},0.22)`);
      grd.addColorStop(1, "transparent");
      ctx.save();
      ctx.fillStyle = grd;
      ctx.fillRect(sigX - 8, 0, 16, ch);
      ctx.restore();
    }

    if (sigX != null) {
      // Exit-time x: use toTime if provided and within window, else end of window
      const toTimeX = signal.toTime != null ? (ts.timeToCoordinate(signal.toTime as any) ?? rightX) : rightX;
      const fillRx = Math.max(sigX, toTimeX);
      const lx = Math.min(sigX, rightX), rx = Math.max(sigX, rightX);

      // ── Background bands (drawn first, under lines) — bounded to exit time ─
      const drawBand = (priceA: number, priceB: number, fillColor: string) => {
        const yA = series.priceToCoordinate(priceA);
        const yB = series.priceToCoordinate(priceB);
        if (yA == null || yB == null) return;
        const top = Math.min(Number(yA), Number(yB));
        const ht  = Math.max(Math.abs(Number(yA) - Number(yB)), 1);
        ctx.save();
        ctx.fillStyle = fillColor;
        ctx.fillRect(lx, top, fillRx - lx, ht);
        ctx.restore();
      };

      // ONE full profit fill (entry→TP2) and ONE full risk fill (entry→SL)
      drawBand(signal.price, tp2, isLong ? "rgba(38,166,154,0.07)" : "rgba(239,83,80,0.07)");
      drawBand(signal.price, sl,  isLong ? "rgba(239,83,80,0.07)"  : "rgba(38,166,154,0.07)");

      // ── Level lines — dashed (exact renderTradeSegment style) ─────────────
      const PRICE_SCALE_W = 65;
      const drawLevel = (price: number, color: string, dash: number[], lw: number, label: string) => {
        const y = series.priceToCoordinate(price);
        if (y == null) return;
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(rx, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "bold 9px 'Trebuchet MS', monospace";
        const tw   = ctx.measureText(label).width + 8;
        const labelX = (cw > 0 && rx + tw + 4 > cw - PRICE_SCALE_W) ? rx - tw - 4 : rx + 2;
        ctx.fillStyle = color + "cc";
        ctx.fillRect(labelX, Number(y) - 8, tw, 15);
        ctx.fillStyle = "#fff"; ctx.textAlign = "left";
        ctx.fillText(label, labelX + 4, Number(y) + 4);
        ctx.restore();
      };

      drawLevel(tp2,          dirClr,        [8, 4], 1.5, `TP2 ${tp2.toFixed(2)}`);
      drawLevel(tp1,          dirClr + "bb", [5, 3], 1,   `TP1 ${tp1.toFixed(2)}`);
      drawLevel(signal.price, "#ffffffaa",   [],     1,   `E ${signal.price.toFixed(2)}`);
      drawLevel(sl,           "#ef5350",     [5, 3], 1,   `Stop ${sl.toFixed(2)}`);

      // ── Vertical entry tick ───────────────────────────────────────────────
      const ey = series.priceToCoordinate(signal.price);
      if (ey != null) {
        ctx.save();
        ctx.strokeStyle = dirClr + "44"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(sigX, Number(ey) - 30); ctx.lineTo(sigX, Number(ey) + 30);
        ctx.stroke(); ctx.setLineDash([]); ctx.restore();

        // ── Signal circle (▲/▼) — colored by risk tier ───────────────────────
        if (showSignalMark) {
          const cy = isLong ? Number(ey) + 22 : Number(ey) - 22;
          ctx.save();
          ctx.beginPath(); ctx.arc(sigX, cy, 9, 0, Math.PI * 2);
          ctx.fillStyle   = `rgba(${tierRgb},0.92)`;
          ctx.strokeStyle = `rgba(0,0,0,0.5)`;
          ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#fff"; ctx.font = "bold 11px 'Trebuchet MS', monospace";
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(isLong ? "▲" : "▼", sigX, cy);
          ctx.restore();
        }
      }
    }
  };

  // ── Chart init ─────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      width:  el.offsetWidth || 400,
      height,
      layout: {
        background: { type: ColorType.Solid, color: T.bg },
        textColor:  T.axisText,
        fontFamily: "'Trebuchet MS', monospace",
        fontSize:   10,
      },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#ffffff99", style: LineStyle.Dashed, labelBackgroundColor: "#1e3050", labelVisible: true },
        horzLine: { color: "#ffffff99", style: LineStyle.Dashed, labelBackgroundColor: "#1e3050", labelVisible: true },
      },
      rightPriceScale: { borderColor: T.axisBorder, minimumWidth: 60 },
      timeScale: { borderColor: T.axisBorder, timeVisible: true, secondsVisible: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true } },
    });
    chartRef.current = chart;

    const cs = chart.addSeries(CandlestickSeries, {
      upColor: T.vecAboveUp, downColor: T.vecAboveDown,
      borderVisible: false,
      wickUpColor: T.wickUp, wickDownColor: T.wickDown,
      lastValueVisible: false, priceLineVisible: false,
    });
    candleRef.current = cs;

    // Main vector line
    const vs = chart.addSeries(LineSeries, {
      color: T.vectorLine ?? "#9ca3af", lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    });
    vecRef.current = vs;

    // Pre-allocate extra vector slots (3 max)
    const extras: ISeriesApi<"Line">[] = [];
    for (let i = 0; i < MAX_EXTRA; i++) {
      extras.push(chart.addSeries(LineSeries, {
        color: "#9ca3af", lineWidth: 1,
        lastValueVisible: false, priceLineVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      }));
    }
    extraVecRefs.current = extras;

    const redraw = () => requestAnimationFrame(() => drawRef.current());
    chart.timeScale().subscribeVisibleTimeRangeChange(redraw);
    chart.subscribeCrosshairMove(redraw);

    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth;
      if (w > 0) chart.applyOptions({ width: w });
      requestAnimationFrame(() => drawRef.current());
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      vecRef.current = null;
      extraVecRefs.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, signal.time]);

  // ── Push candle + vector data ──────────────────────────────────────────────
  useEffect(() => {
    const cs = candleRef.current, vs = vecRef.current;
    if (!cs || !vs || !candleWindow.length) return;

    // Gap detection — same logic as CandlestickChart to avoid stretched candles
    let barIntervalSec = Infinity;
    for (let k = 1; k < candleWindow.length; k++) {
      const d = candleWindow[k].time - candleWindow[k - 1].time;
      if (d > 0 && d <= 4 * 3600) barIntervalSec = Math.min(barIntervalSec, d);
    }
    if (!isFinite(barIntervalSec)) barIntervalSec = 300;
    const GAP_THRESHOLD_SEC = barIntervalSec * 2;
    const GAP_SPACERS = 3;

    const candleData: any[] = [];
    for (let i = 0; i < candleWindow.length; i++) {
      const c = candleWindow[i];
      // Insert whitespace spacers for gaps wider than 2× the bar interval
      if (i > 0 && c.time - candleWindow[i - 1].time > GAP_THRESHOLD_SEC) {
        const prev = candleWindow[i - 1].time;
        const step = Math.floor((c.time - prev) / (GAP_SPACERS + 1));
        for (let g = 1; g <= GAP_SPACERS; g++) {
          candleData.push({ time: (prev + step * g) as any });
        }
      }
      const isUp  = c.close >= c.open;
      const lb    = vecMap.get(c.time);
      const above = !showVec || lb == null || c.close >= lb;
      candleData.push({
        time:      c.time as any,
        open: c.open, high: c.high, low: c.low, close: c.close,
        color:     above ? (isUp ? T.vecAboveUp  : T.vecAboveDown ) : (isUp ? T.vecBelowUp  : T.vecBelowDown ),
        wickColor: above ? (isUp ? T.wickUp       : T.wickDown     ) : (isUp ? T.vecBelowUp  : T.vecBelowDown ),
      });
    }
    cs.setData(candleData);

    // Main vector line
    if (showVec) {
      const vecData = candleWindow
        .map(c => ({ time: c.time as unknown as any, value: vecMap.get(c.time) }))
        .filter((v): v is { time: any; value: number } => v.value != null);
      vs.setData(vecData);
      vs.applyOptions({ visible: true });
    } else {
      vs.setData([]);
      vs.applyOptions({ visible: false });
    }

    // Extra vector lines
    const windowTimes = candleWindow.map(c => c.time);
    const evs = extraVecRefs.current;
    for (let i = 0; i < MAX_EXTRA; i++) {
      const ev = showVec ? extraVecMaps[i] : undefined;
      if (ev) {
        evs[i].applyOptions({ color: ev.color, visible: true });
        const filled = forwardFill(ev.map, windowTimes);
        evs[i].setData(filled);
      } else {
        evs[i].setData([]);
        evs[i].applyOptions({ visible: false });
      }
    }

    chartRef.current?.timeScale().fitContent();
    // Triple-RAF: chart needs 2 frames to finish layout after fitContent, then we draw
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => drawRef.current())));
  }, [candleWindow, vecMap, showVec, extraVecMaps]);

  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => drawRef.current())));
  }, [zones, signal, showMilk, showSignalMark]);

  return (
    <div style={{ position: "relative", width: "100%", height }}>
      <div ref={containerRef} style={{ width: "100%", height }} />
      <canvas ref={canvasRef} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: `${height}px`, pointerEvents: "none" }} />
    </div>
  );
}
