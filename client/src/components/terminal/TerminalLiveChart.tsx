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

const fmtVol = (v: number): string =>
  v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + "M" : v >= 1_000 ? Math.round(v / 1_000) + "k" : String(Math.round(v));

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

type DeltaMap = Map<number, number>;

const INTERVAL_SECS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };
const VEC_LABELS = ["1m", "5m", "15m", "60m"] as const;
const VEC_COLORS: Record<string, string> = { "1m": "#60a5fa", "5m": "#9ca3af", "15m": "#fbbf24", "60m": "#a855f7" };

function dedupe(candles: TerminalCandle[]): TerminalCandle[] {
  const m = new Map<number, TerminalCandle>();
  for (const c of candles) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}
const toCB = (c: TerminalCandle): CandleBar => ({ time: c.time, open: c.o, high: c.h, low: c.l, close: c.c });

function footprintDelta(fc: any): number {
  if (typeof fc?.candleDelta === "number") return fc.candleDelta;
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
  onNeedHistory, fullyLoaded,
}: {
  candles: TerminalCandle[];
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
  const fpOnRef = useRef(false);
  const milkOnRef = useRef(false);
  const milkZonesRef = useRef<MilkZone[]>([]);
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
  onNeedHistoryRef.current = onNeedHistory;
  fullyLoadedRef.current = fullyLoaded;
  candlesRef.current = candles;
  fpOnRef.current = strategies.Footprint;
  milkOnRef.current = strategies.MilkZone;
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
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false, rightOffset: 6 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: {
        mouseWheel: true, pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
    });
    chartRef.current = chart;

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
      fpRafRef.current = requestAnimationFrame(() => drawFpRef.current());
    });
    ro.observe(hostRef.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
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

  useEffect(() => {
    const s = candleRef.current;
    const ts = chartRef.current?.timeScale();
    const n = candles.length;
    const footprintChanged = prevFootprintRef.current !== strategies.Footprint;
    prevFootprintRef.current = strategies.Footprint;

    // FAST PATH: a live tick only mutates the LAST bar's OHLC (same length, same bar times).
    // Update that single bar — O(1) — instead of re-uploading the entire (up to 100k) series,
    // which is the main source of lag during live ticks.
    if (s && !footprintChanged && n > 0 && n === prevLenRef.current &&
        candles[n - 1].time === prevLastTimeRef.current && candles[0].time === prevFirstTimeRef.current) {
      try { s.update(toItem(candles[n - 1])); } catch { applyCandles(); }
      prevLastTimeRef.current = candles[n - 1].time;
      scheduleFpDraw();
      return;
    }

    // STRUCTURAL PATH: new bar / reconcile / deep-history prepend / footprint toggle → full setData.
    // Detect a PREPEND (array grew AND the first bar got older) so we can keep the user's current
    // view fixed instead of letting the shifted logical indices jump it.
    const grewOlder = n > prevLenRef.current && n > 0 &&
      prevFirstTimeRef.current > 0 && candles[0].time < prevFirstTimeRef.current;
    const addedAtFront = grewOlder ? n - prevLenRef.current : 0;
    const savedRange = grewOlder && ts ? ts.getVisibleLogicalRange() : null;

    applyCandles();

    if (savedRange && ts) {
      // Shift the visible logical range right by the number of bars inserted at the front.
      ts.setVisibleLogicalRange({ from: savedRange.from + addedAtFront, to: savedRange.to + addedAtFront });
    } else if (!didFitRef.current && n && chartRef.current) {
      chartRef.current.timeScale().fitContent();
      didFitRef.current = true;
    }
    prevFirstTimeRef.current = candles.length ? candles[0].time : 0;
    prevLenRef.current = candles.length;
    prevLastTimeRef.current = candles.length ? candles[candles.length - 1].time : 0;
    scheduleFpDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, strategies.Footprint]);

  const barSig = candles.length ? `${candles.length}:${candles[candles.length - 1].time}` : "0";

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
    const clipBottom = ch;

    // ── Milk zones (uploaded PNG bands) — EXACT port of the old CandlestickChart band render:
    // filled rect fromTime→toTime, color derived from the zone, border + price/name labels.
    if (milkOnRef.current && milkZonesRef.current.length) {
      // Pixel-density estimator → map any unix ts → X even when timeToCoordinate() is null.
      const sortedC = [...candlesRef.current].sort((a, b) => a.time - b.time);
      let pxPerSec = 0, refX = 0, refT = 0;
      for (let si = sortedC.length - 1; si > 0; si--) {
        const t1 = sortedC[si - 1].time, t2 = sortedC[si].time;
        const cx1 = ts.timeToCoordinate(t1 as any) as number | null;
        const cx2 = ts.timeToCoordinate(t2 as any) as number | null;
        if (cx1 !== null && cx2 !== null && t2 !== t1) { pxPerSec = (cx2 - cx1) / (t2 - t1); refX = cx2; refT = t2; break; }
      }
      const estX = (t: number): number => { const c = ts.timeToCoordinate(t as any) as number | null; return c !== null ? c : (pxPerSec !== 0 ? refX + (t - refT) * pxPerSec : -1); };
      const fb = currentRthSession();
      // largest zones first so narrow entry zones draw on top
      const zsorted = [...milkZonesRef.current].sort((a, b) => Math.abs(b.top - b.bottom) - Math.abs(a.top - a.bottom));
      for (const z of zsorted) {
        if (!Number.isFinite(z.top) || !Number.isFinite(z.bottom)) continue;
        const fromT = z.fromTime || fb.fromTime, toT = z.toTime || fb.toTime;
        const rawLeft = estX(fromT); const zLeft = Math.max(0, rawLeft < 0 ? 0 : rawLeft);
        const rawRight = estX(toT); const zRight = rawRight >= 0 ? Math.min(cw, rawRight) : cw;
        const zoneW = zRight - zLeft; if (zLeft >= cw || zRight <= 0 || zoneW <= 0) continue;
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

    // Step 1 — cluster imbalance zones (full-width bands, mitigation, historical at 28%).
    const zX1 = cw - 62;
    if (zX1 > 0) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, zX1, clipBottom); ctx.clip();
      const cans = [...candlesRef.current].sort((a, b) => a.time - b.time);
      for (const zfp of [...sessions].sort((a, b) => a.time - b.time)) {
        if (zfp.time === activeT) continue;
        const xfR2 = ts.timeToCoordinate(zfp.time as any);
        const isCurZ = xfR2 !== null && (xfR2 as number) >= 0 && (xfR2 as number) <= cw;
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
      const xf = xfR as number; if (xf < 0 || xf > cw) continue;
      renderLadder(fp, xf);
    }
    } // end sessions.length > 0
    } // end fpOnRef.current

    // ── Selected signal: Entry / TP1 / TP2 / Stop lines + fill bands ──────────
    // Always drawn regardless of Footprint toggle.
    // Ported from CandlestickChart.tsx renderConfluenceSegment — same visual as the old chart.
    const sel = selectedSigRef.current;
    if (sel) {
      const isLong = sel.side === "LONG";
      const dirColor = isLong ? "#26c87a" : "#ef5350";
      const safeSlPrice = isLong ? Math.min(sel.stop, sel.entry - 0.25) : Math.max(sel.stop, sel.entry + 0.25);
      const x1R = ts.timeToCoordinate(sel.ts as any);
      const x1 = x1R !== null ? (x1R as number) : 0;
      const x2 = cw;

      // Background fills (profit zone / risk zone)
      const fillBand = (priceA: number, priceB: number, fillColor: string) => {
        const yA = series.priceToCoordinate(priceA), yB = series.priceToCoordinate(priceB);
        if (yA == null || yB == null) return;
        const top = Math.min(yA as number, yB as number), ht = Math.max(Math.abs((yA as number) - (yB as number)), 1);
        ctx.save(); ctx.fillStyle = fillColor; ctx.fillRect(x1, top, x2 - x1, ht); ctx.restore();
      };
      fillBand(sel.entry, sel.tp2,    isLong ? "rgba(38,166,154,0.07)" : "rgba(239,83,80,0.07)");
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

      drawLevel(sel.tp2,      dirColor,          [8, 4], 1.5, `TP2 ${sel.tp2.toFixed(2)}`);
      drawLevel(sel.tp1,      dirColor + "bb",   [5, 3], 1,   `TP1 ${sel.tp1.toFixed(2)}`);
      drawLevel(sel.entry,    "#ffffffaa",        [],     1,   `E ${sel.entry.toFixed(2)}`);
      drawLevel(safeSlPrice,  "#ef5350",          [5, 3], 1,   `Stop ${safeSlPrice.toFixed(2)}`);

      // "Press Esc to clear" hint at top-left
      ctx.save();
      ctx.font = "10px 'IBM Plex Mono',monospace"; ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("Click elsewhere or press Esc to clear", 8, 8);
      ctx.restore();
    }
  };
  drawFpRef.current = drawFootprint;

  // ── Footprint: fetch REAL per-candle data → delta tint + session aggregates → redraw ──
  useEffect(() => {
    if (!strategies.Footprint) { deltaRef.current = new Map(); fpSessionsRef.current = []; applyCandles(); scheduleFpDraw(); return; }

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
    applyCandles();
    scheduleFpDraw();

    // Upgrade with REAL persisted footprint where applicable: any chart candle whose time matches a
    // real per-candle bucket uses the real bid/ask levels; the rest stay proxy. Sessions covered by
    // real data become accurate; historical sessions keep their proxy zones. Also drives delta tint.
    let cancelled = false;
    const base = interval === "15m" ? "5m" : interval;
    fetch(`/api/footprint/history/${encodeURIComponent(symbol)}/${base}`)
      .then((r) => r.json())
      .then((arr) => {
        if (cancelled || !Array.isArray(arr)) return;
        const realByTime = new Map<number, FootprintCandle>();
        const m: DeltaMap = new Map();
        for (const fc of arr) {
          if (!fc || typeof fc.time !== "number") continue;
          m.set(fc.time, footprintDelta(fc));
          if (Array.isArray(fc.levels) && fc.levels.length) realByTime.set(fc.time, fc as FootprintCandle);
        }
        deltaRef.current = m;
        // Only merge real per-candle data when the chart interval matches the data's base interval,
        // so candle times line up 1:1 with real buckets (a 15m chart uses a 5m base → times don't align).
        if (interval === base && realByTime.size) fpSessionsRef.current = buildSessions(realByTime);
        applyCandles();
        scheduleFpDraw();
      })
      .catch(() => { /* ignore — proxy session ladders are already drawn */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, strategies.Footprint, barSig]);

  // Redraw the footprint overlay when the visible time range changes (pan / zoom).
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const sub = () => scheduleFpDraw();
    chart.timeScale().subscribeVisibleTimeRangeChange(sub);
    return () => { try { chart.timeScale().unsubscribeVisibleTimeRangeChange(sub); } catch { /* ignore */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Lazy deep-history: load the full history when the user scrolls near the left edge ──
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const sub = (range: { from: number; to: number } | null) => {
      if (!range || fullyLoadedRef.current) return;
      // `from` is a logical index; < ~20 means the user is within 20 bars of the loaded start.
      if (range.from < 20) onNeedHistoryRef.current?.();
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
    const minT = times.length ? Math.min(...times) : 0;
    const maxT = times.length ? Math.max(...times) : 0;
    const markers = [...signals]
      .filter((s) => s.ts >= minT && s.ts <= maxT)
      .sort((a, b) => a.ts - b.ts)
      .map((s) => s.side === "LONG"
        ? { time: s.ts as UTCTimestamp, position: "belowBar" as const, color: C.up, shape: "arrowUp" as const, text: "L" }
        : { time: s.ts as UTCTimestamp, position: "aboveBar" as const, color: C.down, shape: "arrowDown" as const, text: "S" });
    m.setMarkers(markers);
  }, [signals, barSig]);

  // MilkZone bands are drawn on the overlay canvas (drawFootprint, filled-band render — same as
  // the old chart). Redraw when the zones, the toggle, or the candle set changes.
  useEffect(() => { scheduleFpDraw(); }, [milkZones, strategies.MilkZone, barSig]);

  // Redraw when the selected signal changes (shows/hides the Entry/TP1/TP2/Stop lines).
  useEffect(() => { scheduleFpDraw(); }, [selectedSig]);

  // ── Reload / enter-Market / interval switch: re-fit ──
  useEffect(() => {
    // Reset prepend-tracking so the first candle set for the new interval/reload re-fits
    // cleanly instead of being mistaken for a deep-history prepend (which would offset the view).
    prevFirstTimeRef.current = 0;
    prevLenRef.current = 0;
    prevLastTimeRef.current = 0;
    didFitRef.current = false;
    if (chartRef.current && candles.length) chartRef.current.timeScale().fitContent();
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
      <div key={"sweep" + chartKey} className="tt-sweep" />
    </div>
  );
}
