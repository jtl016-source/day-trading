import { useEffect, useLayoutEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type WhitespaceData,
  type LineData,
  LineStyle,
  ColorType,
  CrosshairMode,
  TickMarkType,
} from "lightweight-charts";

import { type FootprintCandle, type FrozenImbalanceZone } from "@/lib/footprint-analysis"; // FOOTPRINT-RENDER:

// ── Public types ──────────────────────────────────────────────────────────────

export interface CandleBar {
  time: number; open: number; high: number; low: number; close: number;
  volume?: number; rth?: boolean;
}

export interface ZoneOverlay {
  data: Array<{ time: number; value: number }>;
  color: string; lineWidth: number; lineStyle?: number; title?: string;
}

export interface BandOverlay {
  topPrice: number; bottomPrice: number; fillColor: string;
  fromTime: number; toTime: number;
}


export interface ZoneBand {
  topPrice: number;
  bottomPrice: number;
  color: string;   // hex e.g. "#FFD700"
  label?: string;
  fromTime?: number;  // unix seconds; 0 or undefined = all bars
  toTime?: number;    // unix seconds; 0 or undefined = all bars
}

export interface ChartHandle {
  /** Scroll chart so `timestamp` is centered with `paddingCandles` on each side (default 10). */
  scrollToTime: (timestamp: number, intervalSec?: number, paddingCandles?: number) => void;
  resetZoom: () => void;
  /** Directly update the close (and high/low) of the current forming bar without a React re-render.
   *  Pass bucketSec (interval-aligned unix timestamp) so a new bar is opened when the period rolls over. */
  updateLastBarClose: (price: number, bucketSec?: number) => void;
  setAutoScale: (enabled: boolean) => void;
  /** Shift the visible logical range (bar indices). */
  setVisibleLogicalRange: (from: number, to: number) => void;
}

export type DrawingTool = "cursor" | "pan" | "detail" | "line" | "hline" | "vline" | "rectangle" | "fibonacci";

export interface LineDrawing   { id: string; type: "line";      t1: number; p1: number; t2: number; p2: number; color: string; }
export interface HLineDrawing  { id: string; type: "hline";     price: number; color: string; style?: "solid" | "dashed"; }
export interface RectDrawing   { id: string; type: "rectangle"; t1: number; p1: number; t2: number; p2: number; color: string; label?: string; }
export interface FibDrawing    { id: string; type: "fibonacci"; t1: number; p1: number; t2: number; p2: number; }
export type Drawing = LineDrawing | HLineDrawing | RectDrawing | FibDrawing;

/** A single vector trade: entry → exit with TP/Stop levels drawn as canvas lines */
export interface TradeSegment {
  fromTime: number; toTime: number;
  entry: number; tp1: number; tp2: number; stop: number;
}

export interface ChartTheme {
  name: string;
  bg: string;
  grid: string;
  up: string;
  down: string;
  upEth: string;
  downEth: string;
  vecAboveUp: string;
  vecAboveDown: string;
  vecBelowUp: string;
  vecBelowDown: string;
  vectorLine: string;
  wickUp: string;
  wickDown: string;
  crosshair: string;
  axisText: string;
  axisBorder: string;
}

export const CHART_THEMES: Record<string, ChartTheme> = {
  motivewave: {
    name: "MotiveWave",
    bg: "#05080d", grid: "#05080d",
    up: "#26a69a", down: "#ef5350",
    upEth: "#26a69a70", downEth: "#ef535070",
    vecAboveUp: "#4caf50", vecAboveDown: "#f44336",
    vecBelowUp: "#2e6640", vecBelowDown: "#8c2828",
    vectorLine: "#e8e8e8",
    wickUp: "#1a7a72", wickDown: "#9a1a1a",
    crosshair: "#3a4a5c", axisText: "#5a7090", axisBorder: "#0d1a26",
  },
  navy: {
    name: "Navy",
    bg: "#060b14", grid: "#0a1220",
    up: "#2196f3", down: "#c62828",
    upEth: "#2196f38c", downEth: "#c628288c",
    vecAboveUp: "#42a5f5", vecAboveDown: "#ef5350",
    vecBelowUp: "#1a5080", vecBelowDown: "#8a1c1c",
    vectorLine: "#9ca3af",
    wickUp: "#1565c0", wickDown: "#8b0000",
    crosshair: "#2a3a4c", axisText: "#4a6080", axisBorder: "#0f1e2e",
  },
  classic: {
    name: "Classic",
    bg: "#131722", grid: "#1e222d",
    up: "#26a69a", down: "#ef5350",
    upEth: "#26a69a80", downEth: "#ef535080",
    vecAboveUp: "#4dc4b8", vecAboveDown: "#ff6b68",
    vecBelowUp: "#2a8070", vecBelowDown: "#9a2a2a",
    vectorLine: "#9ca3af",
    wickUp: "#26a69a", wickDown: "#ef5350",
    crosshair: "#758696", axisText: "#787b86", axisBorder: "#2a2e39",
  },
  light: {
    name: "Light",
    bg: "#f5f7fa", grid: "#e8ecf0",
    up: "#0d9e88", down: "#d32f2f",
    upEth: "#0d9e8860", downEth: "#d32f2f60",
    vecAboveUp: "#388e3c", vecAboveDown: "#c62828",
    vecBelowUp: "#aed6c8", vecBelowDown: "#f5b8b8",
    vectorLine: "#333333",
    wickUp: "#0d9e88", wickDown: "#d32f2f",
    crosshair: "#9e9e9e", axisText: "#555555", axisBorder: "#d0d8e0",
  },
};

interface CrosshairData {
  time?: number; open?: number; high?: number; low?: number; close?: number; volume?: number;
}

export type SignalClickInfo = {
  type: "confluence";
  time: number;
  direction: "Long" | "Short";
  price: number; tp1: number; tp2: number; sl: number;
  riskLevel?: string;
  signalType?: string;
  confirmations?: { milkOk: boolean; vecOk: boolean; secondaryVecOk: boolean };
  reclassifyReason?: string;
};

interface CandlestickChartProps {
  candles: CandleBar[];
  height?: number;
  showVolume?: boolean;
  zoneOverlays?: ZoneOverlay[];
  bandOverlays?: BandOverlay[];
  zones?: ZoneBand[];
  vectorData?: Array<{ time: number; value: number }>;
  showVector?: boolean;
  extraVectors?: Array<{ label: string; color: string; data: Array<{ time: number; value: number }> }>;
  entrySignals?: Array<{ time: number; price: number }>;
  confluenceSignals?: Array<{
    time: number; price: number; direction: "Long" | "Short";
    tp1: number; tp2: number; sl: number; toTime: number;
    riskLevel?: "safe" | "risky" | "riskiest";
    signalType?: "confluence" | "trend" | "pure_tabletop" | "side_tabletop";
    confirmations?: { milkOk: boolean; vecOk: boolean; secondaryVecOk: boolean };
    reclassifyReason?: string;
    /** Side-entry tabletop: the consolidation range that was broken out of */
    rangeHigh?: number;
    rangeLow?: number;
    /** Both tabletop types: where the pattern started (for drawing the channel / flat line) */
    patternFromTime?: number;
    /** Backtest outcome — used by backtestMode to color green=win / red=loss */
    outcome?: "win_tp1" | "win_tp2" | "win_trailer" | "loss" | "open";
  }>;
  onSignalClick?: (info: SignalClickInfo) => void;
  /** When set, TP/SL lines are only drawn for the signal with this timestamp. All others show circles only. */
  activeSignalTime?: number;
  tradeSegments?: TradeSegment[];
  activeTool?: DrawingTool;
  onDetailClick?: (info: CrosshairData & { x: number; y: number }) => void;
  drawings?: Drawing[];
  onAddDrawing?: (d: Drawing) => void;
  onUpdateDrawing?: (d: Drawing) => void;
  onCrosshairMove?: (data: CrosshairData | null) => void;
  onClearDrawings?: () => void;
  onUndoDrawing?: () => void;
  onVisibleRangeChange?: (from: number, to: number) => void;
  theme?: ChartTheme;
  showLabels?: boolean;
  /** When true: signal dots colored green=win / red=loss, "L"/"S" text, no tier fading */
  backtestMode?: boolean;
  /** Changing this key forces a zoom reset to the last 80 candles (use interval string, e.g. "15m"). */
  intervalKey?: string;
  /** When set, renders per-candle footprint bid×ask at each 0.25-tick price level inside each candle. */
  candleFootprints?: Map<number, FootprintCandle>; // FOOTPRINT-RENDER:
  /** Anchor time (first-candle time) of the currently active/incomplete session.
   *  Imbalance ZONES are suppressed for this session; the ladder still renders. */
  activeSessionTime?: number; // FOOTPRINT-RENDER:
  /** Frozen imbalance zones from the opposite completed session. Rendered as colored overlays. */
  frozenImbalances?: FrozenImbalanceZone[]; // FOOTPRINT-RULE:
}

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618];
const FIB_COLORS = ["#787b86","#f59e0b","#3b82f6","#22c55e","#ef4444","#8b5cf6","#787b86","#f97316","#ef4444"];

function uid() { return Math.random().toString(36).slice(2, 10); }

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}


// ── Rect hit-test ─────────────────────────────────────────────────────────────
const HANDLE_R = 8;
type RectHit = "move" | "tl" | "tr" | "bl" | "br" | "top" | "bottom" | "left" | "right";

function hitTestRect(
  d: RectDrawing, px: number, py: number,
  chart: IChartApi, series: ISeriesApi<"Candlestick">, cw: number
): RectHit | null {
  const ts = chart.timeScale();
  const x1 = ts.timeToCoordinate(d.t1 as any) ?? 0;
  const x2 = ts.timeToCoordinate(d.t2 as any) ?? cw;
  const y1 = series.priceToCoordinate(d.p1);
  const y2 = series.priceToCoordinate(d.p2);
  if (y1 == null || y2 == null) return null;
  const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
  const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
  const near = (ax: number, ay: number) => Math.abs(px - ax) <= HANDLE_R && Math.abs(py - ay) <= HANDLE_R;
  if (near(rx,        ry       )) return "tl";
  if (near(rx + rw,   ry       )) return "tr";
  if (near(rx,        ry + rh  )) return "bl";
  if (near(rx + rw,   ry + rh  )) return "br";
  if (near(rx + rw/2, ry       )) return "top";
  if (near(rx + rw/2, ry + rh  )) return "bottom";
  if (near(rx,        ry + rh/2)) return "left";
  if (near(rx + rw,   ry + rh/2)) return "right";
  if (px >= rx && px <= rx + rw && py >= ry && py <= ry + rh) return "move";
  return null;
}

// ── Drawing canvas renderer ───────────────────────────────────────────────────
function renderDrawing(ctx: CanvasRenderingContext2D, d: Drawing, chart: IChartApi, series: ISeriesApi<"Candlestick">, cw: number, ch: number, selectedId: string | null = null) {
  const ts = chart.timeScale();
  ctx.save();
  if (d.type === "line") {
    const x1 = ts.timeToCoordinate(d.t1 as any), y1 = series.priceToCoordinate(d.p1);
    const x2 = ts.timeToCoordinate(d.t2 as any), y2 = series.priceToCoordinate(d.p2);
    if (x1 == null || y1 == null || x2 == null || y2 == null) { ctx.restore(); return; }
    const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx*dx+dy*dy)||1;
    const ex = dx/len*Math.max(cw,ch)*3, ey = dy/len*Math.max(cw,ch)*3;
    ctx.beginPath(); ctx.moveTo(x1-ex, y1-ey); ctx.lineTo(x2+ex, y2+ey);
    ctx.strokeStyle = d.color; ctx.lineWidth = 1.5; ctx.stroke();
    [{ x: x1, y: y1 }, { x: x2, y: y2 }].forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI*2);
      ctx.fillStyle = d.color; ctx.fill();
    });
  } else if (d.type === "hline") {
    const y = series.priceToCoordinate(d.price);
    if (y == null) { ctx.restore(); return; }
    ctx.strokeStyle = d.color; ctx.lineWidth = 1;
    if (d.style === "dashed") ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke(); ctx.setLineDash([]);
    const label = d.price.toFixed(2), tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = d.color + "cc"; ctx.fillRect(cw-tw-2, y-9, tw, 16);
    ctx.fillStyle = "#fff"; ctx.font = "10px 'Trebuchet MS', monospace"; ctx.textAlign = "right";
    ctx.fillText(label, cw-6, y+4);
  } else if (d.type === "rectangle") {
    const y1 = series.priceToCoordinate(d.p1);
    const y2 = series.priceToCoordinate(d.p2);
    if (y1==null||y2==null) { ctx.restore(); return; }
    // Clamp out-of-range or sentinel time coords to chart edges
    const x1 = ts.timeToCoordinate(d.t1 as any) ?? 0;
    const x2 = ts.timeToCoordinate(d.t2 as any) ?? cw;
    const rx=Math.min(x1,x2),ry=Math.min(y1,y2),rw=Math.abs(x2-x1),rh=Math.abs(y2-y1);
    ctx.fillStyle = d.color+"33"; ctx.fillRect(rx,ry,rw,rh);
    ctx.strokeStyle = d.color; ctx.lineWidth = selectedId === d.id ? 2 : 1.5; ctx.strokeRect(rx,ry,rw,rh);
    if (selectedId === d.id) {
      const hpts: [number, number][] = [
        [rx,        ry       ], [rx + rw,   ry       ],
        [rx,        ry + rh  ], [rx + rw,   ry + rh  ],
        [rx + rw/2, ry       ], [rx + rw/2, ry + rh  ],
        [rx,        ry + rh/2], [rx + rw,   ry + rh/2],
      ];
      ctx.fillStyle = "#ffffff"; ctx.strokeStyle = d.color; ctx.lineWidth = 1;
      for (const [hx, hy] of hpts) {
        ctx.fillRect(hx - 4, hy - 4, 8, 8);
        ctx.strokeRect(hx - 4, hy - 4, 8, 8);
      }
    }
    if (d.label && rh > 14) {
      ctx.save();
      ctx.fillStyle = d.color; ctx.globalAlpha = 0.9;
      ctx.font = "bold 10px 'Trebuchet MS', monospace"; ctx.textAlign = "left";
      ctx.fillText(d.label, rx + 5, ry + 13);
      ctx.restore();
    }
  } else if (d.type === "fibonacci") {
    const x1 = ts.timeToCoordinate(d.t1 as any), y1 = series.priceToCoordinate(d.p1);
    const x2 = ts.timeToCoordinate(d.t2 as any), y2 = series.priceToCoordinate(d.p2);
    if (x1==null||y1==null||x2==null||y2==null) { ctx.restore(); return; }
    const pd = d.p2-d.p1, lx=Math.min(x1,x2), rx2=Math.max(x1,x2);
    FIB_LEVELS.forEach((lvl, i) => {
      const py = series.priceToCoordinate(d.p1 + pd*lvl);
      if (py==null) return;
      ctx.strokeStyle=FIB_COLORS[i]; ctx.lineWidth=1; ctx.setLineDash([4,3]); ctx.globalAlpha=0.8;
      ctx.beginPath(); ctx.moveTo(lx, py); ctx.lineTo(rx2, py); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha=1;
      ctx.fillStyle=FIB_COLORS[i]; ctx.font="9px 'Trebuchet MS',monospace"; ctx.textAlign="left";
      ctx.fillText(`${(lvl*100).toFixed(1)}%  ${(d.p1+pd*lvl).toFixed(2)}`, lx+4, py-2);
    });
  }
  ctx.restore();
}

// ── Trade segment renderer ────────────────────────────────────────────────────
function renderTradeSegment(ctx: CanvasRenderingContext2D, seg: TradeSegment, chart: IChartApi, series: ISeriesApi<"Candlestick">, cw: number, showLabels = true) {
  const ts = chart.timeScale();
  const x1 = ts.timeToCoordinate(seg.fromTime as any);
  const x2 = ts.timeToCoordinate(seg.toTime as any);
  if (x1 == null || x2 == null) return;
  const lx = Math.min(x1, x2), rx = Math.max(x1, x2);

  const drawLevel = (price: number, color: string, dash: number[], width: number, label: string) => {
    const y = series.priceToCoordinate(price);
    if (y == null) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(rx, y); ctx.stroke();
    ctx.setLineDash([]);
    if (showLabels) {
      const lw = ctx.measureText(label).width + 8;
      ctx.fillStyle = color + "dd";
      ctx.fillRect(rx + 2, y - 8, lw, 15);
      ctx.fillStyle = "#ffffff"; ctx.font = "bold 9px 'Trebuchet MS', monospace"; ctx.textAlign = "left";
      ctx.fillText(label, rx + 6, y + 4);
    }
    ctx.restore();
  };

  // Entry vertical marker
  const entryY = series.priceToCoordinate(seg.entry);
  if (entryY != null) {
    ctx.save();
    ctx.strokeStyle = "#ffffff55"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(lx, entryY - 30); ctx.lineTo(lx, entryY + 30); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // TP2 — thick green long-dash
  drawLevel(seg.tp2,  "#26c87a", [8, 4], 1.5, `TP2 ${seg.tp2.toFixed(2)}`);
  // TP1 — thin green short-dash
  drawLevel(seg.tp1,  "#4ade80", [5, 3], 1,   `TP1 ${seg.tp1.toFixed(2)}`);
  // Entry — white solid
  drawLevel(seg.entry,"#ffffffaa", [], 1, `E ${seg.entry.toFixed(2)}`);
  // Stop — red short-dash
  drawLevel(seg.stop, "#ef5350", [5, 3], 1,   `Stop ${seg.stop.toFixed(2)}`);
}

function renderConfluenceSegment(
  ctx: CanvasRenderingContext2D,
  sig: { time: number; price: number; direction: "Long" | "Short"; tp1: number; tp2: number; sl: number; toTime: number; riskLevel?: string },
  chart: IChartApi, series: ISeriesApi<"Candlestick">, showLabels = true, cw = 0,
  usedLabels?: Array<{ rx: number; y: number }>
) {
  const isLong  = sig.direction === "Long";
  const dirColor = isLong ? "#26c87a" : "#ef5350";   // green / red

  // Clamp: stop must always be below entry for Long, above for Short
  const safeSlPrice = isLong
    ? Math.min(sig.sl, sig.price - 0.25)
    : Math.max(sig.sl, sig.price + 0.25);

  const ts = chart.timeScale();
  const x1 = ts.timeToCoordinate(sig.time   as any);
  // For open signals, toTime may be beyond the visible range — fall back to canvas right edge
  const x2Raw = ts.timeToCoordinate(sig.toTime as any);
  const x2 = x2Raw ?? (cw > 0 ? cw : null);
  if (x1 == null || x2 == null) return;
  const lx = Math.min(x1, x2), rx = Math.max(x1, x2);
  // Fills stop exactly at toTime; skip fills when toTime is beyond visible chart (open live signal)
  const fillRx = x2Raw != null ? Math.max(x1, x2Raw) : null;

  const LABEL_H = 15;
  const LABEL_X_RANGE = 160; // treat labels as colliding if rx values are within this many px

  // ── Full-area background fills (entry→TP2 profit, entry→SL risk) ──────────
  const fillBand = (priceA: number, priceB: number, fillColor: string) => {
    if (fillRx == null) return;  // no fill for open signals extending past chart edge
    const yA = series.priceToCoordinate(priceA);
    const yB = series.priceToCoordinate(priceB);
    if (yA == null || yB == null) return;
    const top = Math.min(Number(yA), Number(yB));
    const ht  = Math.max(Math.abs(Number(yA) - Number(yB)), 1);
    ctx.save(); ctx.fillStyle = fillColor;
    ctx.fillRect(lx, top, fillRx - lx, ht);
    ctx.restore();
  };
  fillBand(sig.price, sig.tp2,    isLong ? "rgba(38,166,154,0.07)" : "rgba(239,83,80,0.07)");
  fillBand(sig.price, safeSlPrice, isLong ? "rgba(239,83,80,0.07)"  : "rgba(38,166,154,0.07)");

  // ── Level lines — exact vector style (dashed) ──────────────────────────────
  // isStopLevel: stop label nudges away from entry (Long→down, Short→up), opposite to profit labels
  const drawLevel = (price: number, color: string, dash: number[], width: number, label: string, isStopLevel = false) => {
    const y = series.priceToCoordinate(price);
    if (y == null) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(rx, y); ctx.stroke();
    ctx.setLineDash([]);
    if (showLabels) {
      ctx.font = "bold 9px 'Trebuchet MS', monospace";
      let labelY: number = y as number;
      if (usedLabels) {
        let attempts = 0;
        while (attempts < 12) {
          const hit = usedLabels.find(l => Math.abs(l.rx - rx) < LABEL_X_RANGE && Math.abs(l.y - labelY) < LABEL_H);
          if (!hit) break;
          // Stop label nudges toward the stop side (away from entry); profit labels nudge toward profit side
          const nudgeDown = isStopLevel ? isLong : !isLong;
          labelY = nudgeDown ? hit.y + LABEL_H : hit.y - LABEL_H;
          attempts++;
        }
        usedLabels.push({ rx, y: labelY });
      }
      const lw = ctx.measureText(label).width + 8;
      const PRICE_SCALE_W = 70;
      const labelX = (cw > 0 && rx + lw + 4 > cw - PRICE_SCALE_W) ? rx - lw - 4 : rx + 2;
      ctx.fillStyle = color + "dd";
      ctx.fillRect(labelX, labelY - 8, lw, LABEL_H);
      ctx.fillStyle = "#ffffff"; ctx.textAlign = "left";
      ctx.fillText(label, labelX + 4, labelY + 4);
    }
    ctx.restore();
  };

  // Vertical entry marker
  const entryY = series.priceToCoordinate(sig.price);
  if (entryY != null) {
    ctx.save();
    ctx.strokeStyle = "#ffffff55"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(lx, entryY - 30); ctx.lineTo(lx, entryY + 30); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawLevel(sig.tp2,    dirColor,        [8, 4], 1.5, `TP2 ${sig.tp2.toFixed(2)}`);
  drawLevel(sig.tp1,    dirColor + "bb", [5, 3], 1,   `TP1 ${sig.tp1.toFixed(2)}`);
  drawLevel(sig.price,  "#ffffffaa",     [],     1,   `E ${sig.price.toFixed(2)}`);
  drawLevel(safeSlPrice, "#ef5350",      [5, 3], 1,   `Stop ${safeSlPrice.toFixed(2)}`, true);
}


// ─────────────────────────────────────────────────────────────────────────────
export const CandlestickChart = forwardRef<ChartHandle, CandlestickChartProps>(
  function CandlestickChart({
    candles, height, showVolume = true,
    zoneOverlays, bandOverlays, zones,
    vectorData, showVector = false, extraVectors,
    entrySignals, confluenceSignals, tradeSegments = [],
    activeTool = "cursor",
    drawings = [], onAddDrawing, onUpdateDrawing,
    onCrosshairMove, onSignalClick, activeSignalTime,
    onDetailClick,
    onClearDrawings, onUndoDrawing,
    onVisibleRangeChange,
    theme = CHART_THEMES.motivewave,
    showLabels = true,
    backtestMode = false,
    intervalKey,
    candleFootprints, // FOOTPRINT-RENDER:
    activeSessionTime, // FOOTPRINT-RENDER:
    frozenImbalances, // FOOTPRINT-RULE:
  } = {} as CandlestickChartProps, ref) {
    const props = { onDetailClick };
    const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
    useEffect(() => { onVisibleRangeChangeRef.current = onVisibleRangeChange; }, [onVisibleRangeChange]);
    const wrapperRef    = useRef<HTMLDivElement>(null);
    const containerRef  = useRef<HTMLDivElement>(null);
    const bandCanvasRef = useRef<HTMLCanvasElement>(null);
    const chartRef      = useRef<IChartApi | null>(null);
    const candleSeriesRef  = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const volumeSeriesRef  = useRef<ISeriesApi<"Histogram"> | null>(null);
    const vectorSeriesRef    = useRef<ISeriesApi<"Line"> | null>(null);
    const extraVecSeriesRef  = useRef<ISeriesApi<"Line">[]>([]);
    const overlaySeriesRef   = useRef<ISeriesApi<"Line">[]>([]);
    const extraVectorsRef  = useRef<Array<{ label: string; color: string; data: Array<{ time: number; value: number }> }>>([]);
    const bandOverlaysRef  = useRef<BandOverlay[]>([]);
    const zonesRef         = useRef<ZoneBand[]>([]);
    const candleFootprintsRef    = useRef<Map<number, FootprintCandle>>(new Map()); // FOOTPRINT-RENDER:
    const activeSessionTimeRef   = useRef<number | undefined>(undefined); // FOOTPRINT-RENDER:
    const frozenImbalancesRef    = useRef<FrozenImbalanceZone[]>([]); // FOOTPRINT-RULE:
    const candlesRef       = useRef<CandleBar[]>([]);
    const rafIdRef         = useRef<number>(0);
    const prevCandleKeyRef = useRef<string>("");
    const prevLastBarRef   = useRef<string>(""); // key of last bar for update() fast path
    const prevIntervalKeyRef = useRef<string | undefined>(intervalKey); // detect interval switches
    const currentPriceLineRef = useRef<any>(null);
    const panRef         = useRef<{ lastX: number; lastY: number; mode: "pan" | "priceScale" } | null>(null);
    const priceOffsetRef = useRef<number>(0); // cumulative vertical pan in price units
    const priceScaleMultRef = useRef<number>(1.0); // price scale zoom multiplier (1 = default)
    const priceAxisDragRef = useRef<{ lastY: number } | null>(null); // dedicated price axis handle drag
    const [priceAxisHover, setPriceAxisHover] = useState(false);
    const timeAxisDragRef  = useRef<{ lastX: number } | null>(null); // dedicated time axis handle drag
    const [timeAxisHover, setTimeAxisHover] = useState(false);
    // Tracks the last rendered candle so updateLastBarClose() can call series.update() directly
    const lastCandleRef = useRef<CandleBar | null>(null);
    // Stable ref to drawAll so useImperativeHandle can call it without closure staleness
    const drawAllRef = useRef<() => void>(() => {});

    const onCrosshairMoveRef = useRef(onCrosshairMove);
    useEffect(() => { onCrosshairMoveRef.current = onCrosshairMove; }, [onCrosshairMove]);

    // Candle hover tooltip — state drives a DOM div so we avoid canvas timing issues
    const [hoverTooltip, setHoverTooltip] = useState<{ x: number; y: number; time: number; open: number; high: number; low: number; close: number } | null>(null);
    const onSignalClickRef = useRef(onSignalClick);
    useEffect(() => { onSignalClickRef.current = onSignalClick; }, [onSignalClick]);
    const hoverTooltipRef = useRef(hoverTooltip);
    useEffect(() => { hoverTooltipRef.current = hoverTooltip; }, [hoverTooltip]);
    // Populated each draw frame — {x,y} screen coords + signal info for click hit-testing
    const markerHitsRef = useRef<Array<{ x: number; y: number; info: SignalClickInfo }>>([]);

    // Refs for canvas callbacks to always see latest values
    const drawingsRef        = useRef<Drawing[]>(drawings);
    const activeToolRef      = useRef<DrawingTool>(activeTool);
    const entrySignalsRef       = useRef(entrySignals ?? []);
    const confluenceSignalsRef  = useRef(confluenceSignals ?? []);
    const tradeSegmentsRef         = useRef(tradeSegments);
    const themeRef           = useRef(theme);
    const showLabelsRef      = useRef(showLabels);
    const backtestModeRef    = useRef(backtestMode ?? false);
    const activeSignalTimeRef = useRef<number | undefined>(activeSignalTime);
    // Tracks the current live price so the canvas overlay can draw the right-edge arrow
    const livePriceRef       = useRef<{ price: number; isUp: boolean } | null>(null);
    useEffect(() => { drawingsRef.current = drawings; }, [drawings]);
    useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
    useEffect(() => { entrySignalsRef.current = entrySignals ?? []; }, [entrySignals]);
    useEffect(() => { confluenceSignalsRef.current = confluenceSignals ?? []; }, [confluenceSignals]);
    useEffect(() => { tradeSegmentsRef.current = tradeSegments; }, [tradeSegments]);
    useEffect(() => { themeRef.current = theme; }, [theme]);
    useEffect(() => { showLabelsRef.current = showLabels; }, [showLabels]);
    useEffect(() => { backtestModeRef.current = backtestMode; }, [backtestMode]);
    useEffect(() => { activeSignalTimeRef.current = activeSignalTime; }, [activeSignalTime]);

    // ── Edit-drag state (selection + move/resize) ───────────────────────────
    const selectedIdRef = useRef<string | null>(null);
    const editDragRef   = useRef<{
      mode: RectHit;
      startX: number; startY: number;
      origDrawing: RectDrawing;
    } | null>(null);
    const onUpdateDrawingRef  = useRef(onUpdateDrawing);
    useEffect(() => { onUpdateDrawingRef.current = onUpdateDrawing; }, [onUpdateDrawing]);

    // Pending drawing state (ref-only — no React re-renders on mouse move)
    const pendingDrawRef = useRef<{ x1: number; y1: number; x2: number; y2: number; t1: number; p1: number; } | null>(null);

    // Drag zoom (always-on in cursor mode)
    const [dragState, setDragState] = useState<{
      active: boolean; startX: number; startY: number; curX: number; curY: number;
    } | null>(null);

    // Right-click context menu
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    useImperativeHandle(ref, () => ({
      scrollToTime(ts: number, intervalSec = 300, paddingCandles = 10) {
        if (!chartRef.current) return;
        // setVisibleRange(timestamp) silently fails for future timestamps (no bars = no bar index).
        // Convert to a logical bar index and use setVisibleLogicalRange, which supports
        // indices beyond the series length (shows empty future space).
        const bars = [...candlesRef.current].sort((a, b) => a.time - b.time);
        if (bars.length >= 2) {
          const lastIdx  = bars.length - 1;
          const lastTime = bars[lastIdx].time;
          const ivSec    = Math.max(1, bars[lastIdx].time - bars[lastIdx - 1].time);
          // centerIdx may be fractional or > lastIdx (future)
          const centerIdx = lastIdx + (ts - lastTime) / ivSec;
          chartRef.current.timeScale().setVisibleLogicalRange({
            from: centerIdx - paddingCandles,
            to:   centerIdx + paddingCandles,
          });
        } else {
          // No candle data yet — fall back to timestamp range
          const half = paddingCandles * intervalSec;
          chartRef.current.timeScale().setVisibleRange({
            from: (ts - half) as any,
            to:   (ts + half + intervalSec) as any,
          });
        }
      },
      resetZoom() {
        priceOffsetRef.current    = 0;
        priceScaleMultRef.current = 1.0;
        candleSeriesRef.current?.applyOptions({ autoscaleInfoProvider: undefined });
        vectorSeriesRef.current?.applyOptions({ autoscaleInfoProvider: undefined });
        chartRef.current?.timeScale().fitContent();
      },
      setAutoScale(enabled: boolean) {
        chartRef.current?.priceScale("right").applyOptions({ autoScale: enabled });
      },
      setVisibleLogicalRange(from: number, to: number) {
        chartRef.current?.timeScale().setVisibleLogicalRange({ from, to });
      },
      updateLastBarClose(price: number, bucketSec?: number) {
        const series = candleSeriesRef.current;
        const last   = lastCandleRef.current;
        if (!series || !last) return;

        // ── New bucket: open a fresh bar ────────────────────────────────────
        if (bucketSec !== undefined && bucketSec > last.time) {
          const newBar: CandleBar = {
            time: bucketSec, open: last.close,
            high: price, low: price, close: price, volume: 0, rth: last.rth,
          };
          lastCandleRef.current = newBar;
          livePriceRef.current  = { price, isUp: true };
          const col = themeRef.current.up;
          if (currentPriceLineRef.current) {
            try { currentPriceLineRef.current.applyOptions({ price, color: col }); } catch {}
          }
          try { series.update({ time: bucketSec as any, open: newBar.open, high: price, low: price, close: price }); } catch {}
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = requestAnimationFrame(drawAllRef.current);
          return;
        }

        // ── Same bucket: accumulate high/low ────────────────────────────────
        const updated: CandleBar = {
          ...last,
          high:  Math.max(last.high, price),
          low:   Math.min(last.low,  price),
          close: price,
        };
        lastCandleRef.current = updated;
        // Update canvas overlay arrow (drawn by drawAll)
        livePriceRef.current = { price, isUp: price >= updated.open };
        // Update Y-axis price label directly — no React re-render needed
        const priceColor = price >= updated.open ? themeRef.current.up : themeRef.current.down;
        if (currentPriceLineRef.current) {
          try { currentPriceLineRef.current.applyOptions({ price, color: priceColor }); } catch {}
        } else if (candleSeriesRef.current) {
          // Price line not yet created (ticks arrived before candles loaded) — create it now
          try {
            currentPriceLineRef.current = candleSeriesRef.current.createPriceLine({
              price, color: priceColor,
              lineWidth: 2, lineStyle: LineStyle.Dashed,
              axisLabelVisible: true, title: "",
            });
          } catch {}
        }
        // Push new OHLCV to chart series directly (O(1) — doesn't touch historical data)
        try {
          series.update({
            time:  updated.time as any,
            open:  updated.open,
            high:  updated.high,
            low:   updated.low,
            close: price,
          });
        } catch {}
        // Redraw canvas overlay (arrow + bands) on the next animation frame
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = requestAnimationFrame(drawAllRef.current);
      },
    }));

    // ── Vertical pan helper — shifts the autoscale range by priceOffsetRef ──
    const applyVerticalOffset = useCallback(() => {
      const offset = priceOffsetRef.current;
      const mult   = priceScaleMultRef.current;
      // Provider is called by lightweight-charts on each render; captures the ref
      // *objects* so it always reads the latest .current values.
      const provider = (original: () => any) => {
        const res = original?.();
        if (!res || res.priceRange == null) return res;
        const centre   = (res.priceRange.minValue + res.priceRange.maxValue) / 2 + offset;
        const halfSpan = (res.priceRange.maxValue - res.priceRange.minValue) / 2 * mult;
        return { priceRange: { minValue: centre - halfSpan, maxValue: centre + halfSpan } };
      };
      candleSeriesRef.current?.applyOptions({ autoscaleInfoProvider: provider as any });
      vectorSeriesRef.current?.applyOptions({ autoscaleInfoProvider: provider as any });
    }, []);

    const applyVerticalOffsetRef = useRef(applyVerticalOffset);
    useEffect(() => { applyVerticalOffsetRef.current = applyVerticalOffset; }, [applyVerticalOffset]);

    // ── Drag zoom (always-on when in cursor mode) ───────────────────────────
    // Drag state is kept in a ref (no re-renders on every mousemove), plus a
    // separate display-only state for the selection rectangle. Global window
    // listeners are registered once so the drag works even if the mouse leaves
    // the overlay div mid-drag (the old onMouseLeave approach caused early zooms).
    const dragAnchorRef = useRef<{ startX: number; startY: number; rect: DOMRect } | null>(null);

    const handleDragStart = useCallback((e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;

      // Hit-test signal markers first (12px radius)
      const HIT_R = 14;
      for (const hit of markerHitsRef.current) {
        if (Math.abs(hit.x - px) <= HIT_R && Math.abs(hit.y - py) <= HIT_R) {
          onSignalClickRef.current?.(hit.info);
          return;
        }
      }

      // Hit-test all RectDrawings — topmost first
      const chart = chartRef.current, series = candleSeriesRef.current;
      if (chart && series) {
        const rects = [...drawingsRef.current].reverse().filter(d => d.type === "rectangle") as RectDrawing[];
        for (const d of rects) {
          const hit = hitTestRect(d, px, py, chart, series, rect.width);
          if (hit) {
            selectedIdRef.current = d.id;
            editDragRef.current = { mode: hit, startX: px, startY: py, origDrawing: d };
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = requestAnimationFrame(drawAllRef.current);
            return; // skip zoom-box
          }
        }
      }
      // Click on empty area — deselect
      if (selectedIdRef.current !== null) {
        selectedIdRef.current = null;
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = requestAnimationFrame(drawAllRef.current);
      }
      if (e.ctrlKey) {
        // Ctrl+drag = zoom box
        dragAnchorRef.current = { startX: px, startY: py, rect };
        setDragState({ active: true, startX: px, startY: py, curX: px, curY: py });
      } else if (e.shiftKey) {
        // Shift+drag = scale price axis
        panRef.current = { lastX: e.clientX, lastY: e.clientY, mode: "priceScale" };
        document.body.style.cursor = "ns-resize";
      } else {
        // Plain drag = pan
        panRef.current = { lastX: e.clientX, lastY: e.clientY, mode: "pan" };
        document.body.style.cursor = "grabbing";
      }
    }, []);

    // Global mousemove / mouseup — registered once, use the anchor ref so there
    // are no stale-closure issues and no re-subscriptions on state changes.
    useEffect(() => {
      const redraw = () => {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = requestAnimationFrame(drawAllRef.current);
      };
      const onMove = (e: MouseEvent) => {
        // ── Edit drag: move or resize a RectDrawing ──────────────────────────
        const ed = editDragRef.current;
        if (ed) {
          const chart = chartRef.current, series = candleSeriesRef.current, container = containerRef.current;
          if (!chart || !series || !container) return;
          const cr = container.getBoundingClientRect();
          const px = e.clientX - cr.left, py = e.clientY - cr.top;
          const dx = px - ed.startX, dy = py - ed.startY;
          const ts = chart.timeScale();
          const o  = ed.origDrawing;
          const m  = ed.mode;
          const ox1 = ts.timeToCoordinate(o.t1 as any) ?? 0;
          const ox2 = ts.timeToCoordinate(o.t2 as any) ?? cr.width;
          const oy1 = series.priceToCoordinate(o.p1) ?? 0;
          const oy2 = series.priceToCoordinate(o.p2) ?? cr.height;
          const nx1 = ox1 + (m==="move"||m==="tl"||m==="bl"||m==="left"   ? dx : 0);
          const nx2 = ox2 + (m==="move"||m==="tr"||m==="br"||m==="right"  ? dx : 0);
          const ny1 = oy1 + (m==="move"||m==="tl"||m==="tr"||m==="top"    ? dy : 0);
          const ny2 = oy2 + (m==="move"||m==="bl"||m==="br"||m==="bottom" ? dy : 0);
          const newT1 = Number(ts.coordinateToTime(nx1) ?? o.t1);
          const newT2 = Number(ts.coordinateToTime(nx2) ?? o.t2);
          const newP1 = series.coordinateToPrice(ny1) ?? o.p1;
          const newP2 = series.coordinateToPrice(ny2) ?? o.p2;
          drawingsRef.current = drawingsRef.current.map(d =>
            d.id === o.id ? { ...o, t1: newT1, t2: newT2, p1: newP1, p2: newP2 } as Drawing : d
          );
          redraw();
          return;
        }
        // ── Price-axis handle drag ────────────────────────────────────────────
        if (priceAxisDragRef.current) {
          const dy = e.clientY - priceAxisDragRef.current.lastY;
          priceAxisDragRef.current = { lastY: e.clientY };
          const factor = 1 + dy / (containerRef.current?.getBoundingClientRect().height || 600) * 2;
          priceScaleMultRef.current = Math.max(0.05, Math.min(20, priceScaleMultRef.current * factor));
          applyVerticalOffsetRef.current();
          return;
        }
        // ── Time-axis handle drag ─────────────────────────────────────────────
        if (timeAxisDragRef.current) {
          const dx = e.clientX - timeAxisDragRef.current.lastX;
          timeAxisDragRef.current = { lastX: e.clientX };
          const chart = chartRef.current;
          if (chart) {
            const range = chart.timeScale().getVisibleLogicalRange();
            if (range) {
              const cw = containerRef.current?.getBoundingClientRect().width || 800;
              // drag right = zoom out (more candles), drag left = zoom in (fewer)
              const factor = 1 + dx / cw * 3;
              const newSize = Math.max(5, Math.min(1000, (range.to - range.from) * factor));
              chart.timeScale().setVisibleLogicalRange({ from: range.to - newSize, to: range.to });
            }
          }
          return;
        }
        // ── Pan / Price-scale drag ────────────────────────────────────────────
        if (panRef.current) {
          const dx = e.clientX - panRef.current.lastX;
          const dy = e.clientY - panRef.current.lastY;
          const mode = panRef.current.mode;
          panRef.current = { lastX: e.clientX, lastY: e.clientY, mode };
          const chart = chartRef.current;
          if (chart) {
            if (mode === "priceScale") {
              // Shift+drag: scale Y axis — drag up = zoom in (tighter), down = zoom out (wider)
              const factor = 1 + dy / (containerRef.current?.getBoundingClientRect().height || 600) * 2;
              priceScaleMultRef.current = Math.max(0.05, Math.min(20, priceScaleMultRef.current * factor));
              applyVerticalOffsetRef.current();
            } else {
              // Plain drag: pan horizontally + vertically
              const ts = chart.timeScale();
              const range = ts.getVisibleLogicalRange();
              if (range) {
                const cw = containerRef.current?.getBoundingClientRect().width || 800;
                const barsVisible = range.to - range.from;
                const shift = -dx / cw * barsVisible;
                ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
              }
              const ch = containerRef.current?.getBoundingClientRect().height || 600;
              const series = candleSeriesRef.current;
              if (series && ch > 0) {
                const midY = ch / 2;
                const p1 = series.coordinateToPrice(midY);
                const p2 = series.coordinateToPrice(midY - dy);
                if (p1 != null && p2 != null) priceOffsetRef.current += (p2 - p1);
                applyVerticalOffsetRef.current();
              }
            }
          }
          return;
        }
        // ── Zoom-box drag ────────────────────────────────────────────────────
        if (!dragAnchorRef.current) return;
        const { rect, startX, startY } = dragAnchorRef.current;
        const curX = e.clientX - rect.left, curY = e.clientY - rect.top;
        setDragState({ active: true, startX, startY, curX, curY });
      };
      const onUp = (e: MouseEvent) => {
        // ── Commit edit drag ─────────────────────────────────────────────────
        const ed = editDragRef.current;
        if (ed) {
          editDragRef.current = null;
          const updated = drawingsRef.current.find(d => d.id === ed.origDrawing.id);
          if (updated) onUpdateDrawingRef.current?.(updated);
          redraw();
          return;
        }
        // ── Price-axis handle release ─────────────────────────────────────────
        if (priceAxisDragRef.current) {
          priceAxisDragRef.current = null;
          document.body.style.cursor = "";
          return;
        }
        // ── Time-axis handle release ──────────────────────────────────────────
        if (timeAxisDragRef.current) {
          timeAxisDragRef.current = null;
          document.body.style.cursor = "";
          return;
        }
        // ── Pan release ──────────────────────────────────────────────────────
        if (panRef.current) {
          panRef.current = null;
          document.body.style.cursor = "";
          return;
        }
        // ── Commit zoom-box ──────────────────────────────────────────────────
        const anchor = dragAnchorRef.current;
        if (!anchor) return;
        dragAnchorRef.current = null;
        if (chartRef.current) {
          const curX = e.clientX - anchor.rect.left;
          const lx = Math.min(anchor.startX, curX);
          const rx = Math.max(anchor.startX, curX);
          if (rx - lx > 10) {
            const ts = chartRef.current.timeScale();
            const from = ts.coordinateToTime(lx), to = ts.coordinateToTime(rx);
            if (from != null && to != null) ts.setVisibleRange({ from, to });
          }
        }
        setDragState(null);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          editDragRef.current = null;
          dragAnchorRef.current = null;
          panRef.current = null;
          priceAxisDragRef.current = null;
          timeAxisDragRef.current = null;
          document.body.style.cursor = "";
          setDragState(null);
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup",   onUp);
      window.addEventListener("keydown",   onKey);
      return () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup",   onUp);
        window.removeEventListener("keydown",   onKey);
      };
    }, []); // runs once — anchor ref holds the mutable state

    // ── Chart init ──────────────────────────────────────────────────────────
    // useLayoutEffect (not useEffect) — DOM dimensions are 0 at useEffect time
    useLayoutEffect(() => {
      if (!containerRef.current) return;
      const t = themeRef.current;
      const actualHeight = height ?? containerRef.current.offsetHeight ?? 500;

      const chart = createChart(containerRef.current, {
        width: containerRef.current.offsetWidth,
        height: actualHeight,
        layout: {
          background: { type: ColorType.Solid, color: t.bg },
          textColor: t.axisText,
          fontFamily: "'Trebuchet MS', 'Consolas', monospace",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: t.grid },
          horzLines: { color: t.grid },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "rgba(255,255,255,0.55)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#1e3050", labelVisible: true },
          horzLine: { color: "rgba(255,255,255,0.55)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#1e3050", labelVisible: true },
        },
        localization: {
          // Display timestamps in local timezone (not UTC)
          timeFormatter: (t: number) => new Date(t * 1000).toLocaleString(undefined, {
            month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: false,
          }),
        },
        timeScale: {
          borderColor: t.axisBorder, timeVisible: true, secondsVisible: false,
          fixLeftEdge: false, fixRightEdge: false, rightOffset: 30, barSpacing: 6, minBarSpacing: 1.0,
          tickMarkFormatter: (time: number, type: TickMarkType) => {
            const d = new Date(time * 1000);
            const et = { timeZone: "America/New_York" };
            if (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds)
              return d.toLocaleTimeString("en-US", { ...et, hour: "2-digit", minute: "2-digit", hour12: false });
            if (type === TickMarkType.DayOfMonth)
              return d.toLocaleDateString("en-US", { ...et, weekday: "short", month: "short", day: "numeric" });
            if (type === TickMarkType.Month)
              return d.toLocaleDateString("en-US", { ...et, month: "short", year: "2-digit" });
            return d.getFullYear().toString();
          },
        },
        rightPriceScale: {
          borderColor: t.axisBorder,
          scaleMargins: showVolume ? { top: 0.04, bottom: 0.20 } : { top: 0.04, bottom: 0.04 },
          textColor: t.axisText,
        },
        handleScale: { axisPressedMouseMove: { time:true, price:true }, axisDoubleClickReset: { time:true, price:true }, mouseWheel:false, pinch:false },
        // mouseWheel disabled here — all wheel events are handled by the wrapper-level listener below
        // so they work regardless of which tool overlay is active.
        handleScroll: { mouseWheel:false, pressedMouseMove:true, horzTouchDrag:true, vertTouchDrag:false },
      });

      chartRef.current = chart;

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: t.up, downColor: t.down, borderVisible: false,
        wickUpColor: t.wickUp, wickDownColor: t.wickDown,
        // Disable built-in last-value label and price line — we manage these
        // ourselves via createPriceLine so they don't appear twice on the Y-axis.
        lastValueVisible: false, priceLineVisible: false,
      });
      candleSeriesRef.current = candleSeries;

      if (showVolume) {
        const volumeSeries = chart.addSeries(HistogramSeries, {
          color: t.up + "88", priceFormat: { type: "volume" }, priceScaleId: "volume",
        });
        chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        volumeSeriesRef.current = volumeSeries;
      }

      const vectorSeries = chart.addSeries(LineSeries, {
        color: t.vectorLine, lineWidth: 2, lastValueVisible: false,
        priceLineVisible: false, crosshairMarkerVisible: false, title: "Vector",
        autoscaleInfoProvider: () => null, // don't let vector lines affect Y-axis scale
      });
      vectorSeriesRef.current = vectorSeries;

      extraVecSeriesRef.current = []; // extra vectors are now canvas-rendered

      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.seriesData || param.point == null) {
          setHoverTooltip(null);
          onCrosshairMoveRef.current?.(null);
          return;
        }
        const cd = param.seriesData.get(candleSeries) as CandlestickData | undefined;
        const vd = volumeSeriesRef.current ? param.seriesData.get(volumeSeriesRef.current) as HistogramData | undefined : undefined;
        if (!cd) {
          setHoverTooltip(null);
          onCrosshairMoveRef.current?.(null);
          return;
        }
        setHoverTooltip({ x: param.point.x, y: param.point.y, time: Number(param.time), open: cd.open, high: cd.high, low: cd.low, close: cd.close });
        onCrosshairMoveRef.current?.({ time:Number(param.time), open:cd.open, high:cd.high, low:cd.low, close:cd.close, volume:vd?.value });
      });

      const ro = new ResizeObserver(() => {
        if (containerRef.current) chart.applyOptions({ width: containerRef.current.offsetWidth, height: height ?? containerRef.current.offsetHeight ?? 500 });
      });
      ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
        chart.remove();
        chartRef.current = null; candleSeriesRef.current = null;
        volumeSeriesRef.current = null; vectorSeriesRef.current = null;
        extraVecSeriesRef.current = [];
        overlaySeriesRef.current = [];
        currentPriceLineRef.current = null;
      };
    }, [height, showVolume]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Wrapper-level wheel handler ────────────────────────────────────────
    // Registered here (not on the overlay divs) so it fires regardless of
    // which tool overlay is active. passive:false lets us call preventDefault.
    //   plain scroll  → pan left/right through time
    //   Ctrl + scroll → zoom in/out on the time scale
    useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        const chart = chartRef.current;
        if (!chart) return;
        e.preventDefault();
        const ts    = chart.timeScale();
        const range = ts.getVisibleLogicalRange();
        if (!range) return;
        const barsVisible = range.to - range.from;
        if (e.shiftKey) {
          // Shift+scroll = zoom price axis (Y scale)
          const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
          priceScaleMultRef.current = Math.max(0.05, Math.min(20, priceScaleMultRef.current * factor));
          applyVerticalOffsetRef.current();
        } else if (e.ctrlKey) {
          // Ctrl+scroll = zoom time axis (X scale)
          const centre = (range.from + range.to) / 2;
          const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
          const half   = (barsVisible * factor) / 2;
          ts.setVisibleLogicalRange({ from: centre - half, to: centre + half });
        } else {
          // Plain scroll = pan left / right
          const shift = (e.deltaY !== 0 ? e.deltaY : e.deltaX) / (el.offsetWidth || 800) * barsVisible * 0.6;
          ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
        }
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    }, []); // refs only — no deps needed

    // ── Apply theme changes without recreating chart ────────────────────────
    useEffect(() => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: theme.bg }, textColor: theme.axisText },
        grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "rgba(255,255,255,0.55)", style: LineStyle.Dashed, labelBackgroundColor: "#1e3050", labelVisible: true },
          horzLine: { color: "rgba(255,255,255,0.55)", style: LineStyle.Dashed, labelBackgroundColor: "#1e3050", labelVisible: true },
        },
        timeScale: { borderColor: theme.axisBorder },
        rightPriceScale: { borderColor: theme.axisBorder, textColor: theme.axisText },
      });
      candleSeriesRef.current?.applyOptions({ upColor: theme.up, downColor: theme.down, wickUpColor: theme.wickUp, wickDownColor: theme.wickDown });
      vectorSeriesRef.current?.applyOptions({ color: theme.vectorLine });
    }, [theme]);

    // ── Axis scale lock (disable when using a drawing tool) ─────────────────
    useEffect(() => {
      if (!chartRef.current) return;
      // Only allow axis drag-to-resize when cursor tool is active (not drawing)
      chartRef.current.applyOptions({
        handleScale: {
          axisPressedMouseMove: activeTool === "cursor" ? { time:true, price:true } : { time:false, price:false },
        },
      });
    }, [activeTool]);

    // ── Candle + volume data ────────────────────────────────────────────────
    useEffect(() => {
      if (!candleSeriesRef.current || !chartRef.current) return;
      if (!candles.length) {
        candleSeriesRef.current.setData([]); volumeSeriesRef.current?.setData([]);
        prevCandleKeyRef.current = ""; prevLastBarRef.current = ""; return;
      }

      const sorted = [...candles].sort((a,b) => a.time-b.time);
      const last = sorted[sorted.length - 1];
      // Structural key: first/last timestamp + count — changes when bars are added/removed
      const structKey = `${sorted[0].time}-${last.time}-${sorted.length}`;
      // Last-bar key: encodes the live OHLCV so we detect tick-level changes
      const lastBarKey = `${last.time}:${last.open}:${last.high}:${last.low}:${last.close}`;

      const structChanged = structKey !== prevCandleKeyRef.current;
      const wasFirstLoad = prevCandleKeyRef.current === "";

      prevCandleKeyRef.current = structKey;
      prevLastBarRef.current = lastBarKey;

      const hasETH = sorted.some(c => c.rth === true || c.rth === false);
      const vecMap = new Map<number, number>();
      if (vectorData) for (const v of vectorData) vecMap.set(v.time, v.value);
      const useVec = showVector && vecMap.size > 0;
      const t = themeRef.current;

      function mapCandle(c: CandleBar): CandlestickData {
        const isUp = c.close >= c.open, isETH = hasETH && c.rth === false;
        if (useVec) {
          const lb = vecMap.get(c.time), above = lb == null || c.close >= lb;
          if (isETH) return { time:c.time as any, open:c.open, high:c.high, low:c.low, close:c.close,
            color: above ? (isUp ? t.upEth : t.downEth) : (isUp ? t.vecBelowUp+"88" : t.vecBelowDown+"88"),
            wickColor: above ? (isUp ? t.upEth : t.downEth) : (isUp ? t.vecBelowUp+"88" : t.vecBelowDown+"88") };
          return { time:c.time as any, open:c.open, high:c.high, low:c.low, close:c.close,
            color: above ? (isUp ? t.vecAboveUp : t.vecAboveDown) : (isUp ? t.vecBelowUp : t.vecBelowDown),
            wickColor: above ? (isUp ? t.wickUp : t.wickDown) : (isUp ? t.vecBelowUp : t.vecBelowDown) };
        }
        if (isETH) return { time:c.time as any, open:c.open, high:c.high, low:c.low, close:c.close,
          color: isUp ? t.upEth : t.downEth, wickColor: isUp ? t.upEth : t.downEth };
        return { time:c.time as any, open:c.open, high:c.high, low:c.low, close:c.close };
      }

      // ── Fast path: no structural change — update only the last bar ────────────
      // Key fix: merge `last` (from React state / HTTP poll) with whatever
      // updateLastBarClose() has accumulated from WS ticks.  Without this merge,
      // every HTTP-poll re-render (250ms) resets the chart to the stale liveCandles
      // close, causing the visible "hold a price and then jump" stutter.
      if (!structChanged) {
        const prevRef = lastCandleRef.current;
        // If lastCandleRef already has tick data for this same bar, preserve it.
        const activeLast: CandleBar = (prevRef && prevRef.time === last.time) ? {
          ...last,
          high:  Math.max(last.high,  prevRef.high),
          low:   Math.min(last.low,   prevRef.low),
          close: prevRef.close,   // tick close is more current than HTTP-poll close
        } : last;
        lastCandleRef.current = activeLast;
        livePriceRef.current = { price: activeLast.close, isUp: activeLast.close >= activeLast.open };
        try {
          candleSeriesRef.current.update(mapCandle(activeLast));
          if (volumeSeriesRef.current) {
            const isUp = activeLast.close >= activeLast.open, isETH = hasETH && activeLast.rth === false;
            const vc = isETH ? (isUp ? t.upEth : t.downEth) : (isUp ? t.up+"88" : t.down+"88");
            volumeSeriesRef.current.update({ time: activeLast.time as any, value: activeLast.volume ?? 0, color: vc });
          }
          return;
        } catch {
          // series.update() can throw if time ordering is violated — fall through to setData
        }
      }

      // ── Full reload: reset refs so the tick path starts fresh after setData ──
      lastCandleRef.current = last;
      livePriceRef.current = { price: last.close, isUp: last.close >= last.open };

      // ── Full reload: setData ──────────────────────────────────────────────
      const candleData: (CandlestickData|WhitespaceData)[] = [];
      const volData: (HistogramData|WhitespaceData)[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];
        candleData.push(mapCandle(c));
        const isUp = c.close >= c.open, isETH = hasETH && c.rth === false;
        const vc = isETH ? (isUp ? t.upEth : t.downEth) : (isUp ? t.up+"88" : t.down+"88");
        volData.push({ time:c.time as any, value:c.volume ?? 0, color: vc });
      }

      candleSeriesRef.current.setData(candleData);
      volumeSeriesRef.current?.setData(volData as HistogramData[]);
      if (structChanged) {
        const ts = chartRef.current.timeScale();
        const total = sorted.length;
        const VIEW_CANDLES = 80;
        // Detect interval or lookback change (intervalKey encodes both) → reset zoom to last 80 bars
        const intervalChanged = prevIntervalKeyRef.current !== intervalKey;
        prevIntervalKeyRef.current = intervalKey;
        if (wasFirstLoad || intervalChanged) {
          // Initial load, interval switch, or lookback change: zoom to show the last ~80 candles
          ts.setVisibleLogicalRange({ from: total - VIEW_CANDLES, to: total + 5 });
        } else {
          // New bar added: follow live price only if the user is already near the right edge.
          // Also reset zoom if the current visible range is invalid for the new data (e.g. interval
          // switch: 1m→15m causes the old logical range {from:155000, to:155080} to be way past
          // the end of the 15m data, making lw-charts zoom-to-fit all history as tiny dots).
          const range = ts.getVisibleLogicalRange();
          if (!range || range.from >= total) {
            // Range is beyond the new data entirely — reset to last 80 bars
            ts.setVisibleLogicalRange({ from: total - VIEW_CANDLES, to: total + 5 });
          } else if (range.to >= total - 3) {
            ts.scrollToRealTime();
          }
          // else: user has intentionally scrolled to view history — leave range as-is
        }
      }
    }, [candles, vectorData, showVector, theme]);

    // ── Current price tag on Y axis ──────────────────────────────────────────
    useEffect(() => {
      const series = candleSeriesRef.current;
      if (!series) return;
      if (!candles.length) {
        if (currentPriceLineRef.current) {
          try { series.removePriceLine(currentPriceLineRef.current); } catch {}
          currentPriceLineRef.current = null;
        }
        return;
      }
      const sorted = [...candles].sort((a, b) => a.time - b.time);
      const last = sorted[sorted.length - 1];
      const color = last.close >= last.open ? themeRef.current.up : themeRef.current.down;
      if (currentPriceLineRef.current) {
        currentPriceLineRef.current.applyOptions({ price: last.close, color });
      } else {
        currentPriceLineRef.current = series.createPriceLine({
          price: last.close, color,
          lineWidth: 2, lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title: "",
        });
      }
    }, [candles]);

    // ── Vector line ─────────────────────────────────────────────────────────
    useEffect(() => {
      if (!vectorSeriesRef.current) return;
      if (!showVector || !vectorData?.length) { vectorSeriesRef.current.setData([]); return; }
      const sorted = [...vectorData].sort((a,b) => a.time-b.time);
      const deduped: LineData[] = [];
      for (const d of sorted) {
        if (deduped.length && (deduped[deduped.length-1].time as any) === d.time)
          deduped[deduped.length-1].value = d.value;
        else deduped.push({ time: d.time as any, value: d.value });
      }
      vectorSeriesRef.current.setData(deduped);
    }, [vectorData, showVector]);

    // ── Extra vector lines (multi-interval) ─────────────────────────────────
    // ── Extra vectors: sync to ref + redraw (canvas rendering, no LineSeries) ──
    // ── Zone overlays ───────────────────────────────────────────────────────
    useEffect(() => {
      const chart = chartRef.current;
      if (!chart) return;
      for (const s of overlaySeriesRef.current) { try { chart.removeSeries(s); } catch {} }
      overlaySeriesRef.current = [];
      if (!zoneOverlays?.length) return;
      for (const ov of zoneOverlays) {
        if (!ov.data.length) continue;
        const s = chart.addSeries(LineSeries, {
          color: ov.color, lineWidth: ov.lineWidth as any,
          lineStyle: (ov.lineStyle ?? LineStyle.Solid) as any,
          lastValueVisible: false, priceLineVisible: false,
          crosshairMarkerVisible: false, title: ov.title ?? "",
        });
        // Deduplicate consecutive identical timestamps before passing to lightweight-charts
        const dedupedOv = ov.data
          .sort((a, b) => a.time - b.time)
          .filter((d, i, arr) => i === 0 || d.time !== arr[i - 1].time);
        s.setData(dedupedOv.map(d => ({ time: d.time as any, value: d.value })));
        overlaySeriesRef.current.push(s);
      }
    }, [zoneOverlays]);


    // ── Main canvas: bands + signals + trade segments + drawings ────────────
    const drawAll = useCallback(() => {
      const canvas = bandCanvasRef.current, chart = chartRef.current, series = candleSeriesRef.current;
      if (!canvas || !chart || !series) {
        if (canvas) { const ctx = canvas.getContext("2d"); ctx?.clearRect(0,0,canvas.width,canvas.height); }
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const container = canvas.parentElement;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      const cw = cr.width, ch = cr.height;
      if (canvas.width !== Math.round(cw*dpr) || canvas.height !== Math.round(ch*dpr)) {
        canvas.width = Math.round(cw*dpr); canvas.height = Math.round(ch*dpr);
        canvas.style.width = cw+"px"; canvas.style.height = ch+"px";
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.clearRect(0,0,cw,ch);
      markerHitsRef.current = []; // reset click targets each frame

      const ts = chart.timeScale();
      const clipBottom = ch - 28;

      // ── Band overlays ─────────────────────────────────────────────────
      ctx.save(); ctx.beginPath(); ctx.rect(0,0,cw,clipBottom); ctx.clip();
      for (const band of bandOverlaysRef.current) {
        // Convert prices → y coords; if outside visible range, clamp to edges so zone is still visible
        const rawTy = series.priceToCoordinate(band.topPrice);
        const rawBy = series.priceToCoordinate(band.bottomPrice);
        // priceToCoordinate can return null if scale not ready; fall back to edges
        const ty = rawTy ?? (band.topPrice > (series.priceToCoordinate(0) ?? 0) ? 0 : clipBottom);
        const by_ = rawBy ?? (band.bottomPrice < 0 ? clipBottom : 0);
        // Sentinel values: fromTime=0 means left edge, toTime>=9e9 means right edge
        const lx = band.fromTime === 0
          ? 0
          : (ts.timeToCoordinate(band.fromTime as any) ?? 0);
        const rx = band.toTime >= 9_000_000_000
          ? cw
          : (ts.timeToCoordinate(band.toTime as any) ?? cw);
        const x=Math.min(lx,rx), w=Math.abs(rx-lx);
        const y=Math.min(ty,by_), h=Math.abs(by_-ty);
        if (w>0&&h>0) { ctx.fillStyle=band.fillColor; ctx.fillRect(x,y,w,h); }
      }
      ctx.restore();

      // ── Zone rectangles: anchored to zone.fromTime → zone.toTime ────────────
      {
        // Build a pixel-density estimator from the two rightmost visible bars.
        // This lets us convert ANY unix timestamp → canvas X coordinate even when
        // timeToCoordinate() returns null (bar outside visible range or future).
        let pxPerSec = 0, refX = 0, refT = 0;
        {
          const sorted = [...candlesRef.current].sort((a, b) => a.time - b.time);
          for (let si = sorted.length - 1; si > 0; si--) {
            const cx1 = ts.timeToCoordinate(sorted[si - 1].time as any) as number | null;
            const cx2 = ts.timeToCoordinate(sorted[si].time as any)     as number | null;
            if (cx1 !== null && cx2 !== null && sorted[si].time !== sorted[si - 1].time) {
              pxPerSec = (cx2 - cx1) / (sorted[si].time - sorted[si - 1].time);
              refX = cx2; refT = sorted[si].time;
              break;
            }
          }
        }
        // estX: try timeToCoordinate first; fall back to linear pixel-density estimate.
        const estX = (t: number): number => {
          const c = ts.timeToCoordinate(t as any) as number | null;
          return c !== null ? c : (pxPerSec !== 0 ? refX + (t - refT) * pxPerSec : -1);
        };

        // Default session window (today's RTH) — used when zone has no fromTime/toTime
        const nowD = new Date();
        const dow = nowD.getUTCDay();
        const rollback = dow === 0 ? 2 : dow === 6 ? 1 : 0;
        const dayStartMs = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() - rollback);
        const openTs  = Math.floor(dayStartMs / 1000) + 13 * 3600 + 30 * 60; // 9:30 AM ET
        const closeTs = Math.floor(dayStartMs / 1000) + 20 * 3600;            // 4:00 PM ET
        const xStart  = estX(openTs);
        const xEnd    = estX(closeTs);

        // Render all zones — largest zones first so narrow entry-level zones draw on top.
        if (zonesRef.current.length > 0) {
          const sortedZones = [...zonesRef.current].sort(
            (a, b) => Math.abs(b.topPrice - b.bottomPrice) - Math.abs(a.topPrice - a.bottomPrice)
          );
          for (const zone of sortedZones) {
            // Left edge: use zone.fromTime when set; fall back to today's session open.
            const rawLeft = zone.fromTime ? estX(zone.fromTime) : (xStart >= 0 ? xStart : 0);
            const zLeft   = Math.max(0, rawLeft < 0 ? (xStart >= 0 ? xStart : 0) : rawLeft);

            // Right edge: use zone.toTime when set; fall back to today's RTH close.
            const toT     = zone.toTime || closeTs;
            const rawRight = estX(toT);
            const zRight   = rawRight >= 0 ? Math.min(cw, rawRight)
                                           : (xEnd >= 0 ? Math.min(cw, xEnd) : cw);

            const zoneW = zRight - zLeft;
            if (zLeft >= cw || zRight <= 0 || zoneW <= 0) continue;

            const rawYt = series.priceToCoordinate(zone.topPrice);
            const rawYb = series.priceToCoordinate(zone.bottomPrice);
            if (rawYt === null || rawYb === null) continue;
            const zy  = Math.max(0, Math.min(rawYt, rawYb));
            const zyb = Math.min(clipBottom, Math.max(rawYt, rawYb));
            const zrh = zyb - zy;
            if (zrh < 1) continue;

            // Derive fill/border/label colors from zone.color.
            // Priority: rgba string (from parsed zones + old Milk zones) → #hex → label keywords.
            let fillColor: string, borderColor: string, labelBgColor: string;
            const rgbaM = zone.color?.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
            if (rgbaM) {
              const [, r, g, b, aStr] = rgbaM;
              const srcAlpha  = aStr ? parseFloat(aStr) : 0.07;
              // Wide zones (>50 pts) are structural backgrounds — render nearly invisible
              // so they don't obscure candles; the border line carries the visual weight.
              const priceDelta = Math.abs(zone.topPrice - zone.bottomPrice);
              const fillAlpha  = priceDelta > 50 ? Math.min(srcAlpha, 0.04) : Math.min(srcAlpha, 0.09);
              fillColor    = `rgba(${r},${g},${b},${fillAlpha})`;
              borderColor  = `rgba(${r},${g},${b},0.88)`;
              labelBgColor = `rgba(${r},${g},${b},0.62)`;
            } else if (zone.color && /^#[0-9a-f]{6}$/i.test(zone.color)) {
              fillColor    = hexToRgba(zone.color, 0.12);
              borderColor  = hexToRgba(zone.color, 0.90);
              labelBgColor = hexToRgba(zone.color, 0.65);
            } else {
              const lbl = (zone.label ?? "").toLowerCase();
              const isSupport = lbl.includes("support") || lbl.includes("buy");
              const isResist  = lbl.includes("resist")  || lbl.includes("sell");
              fillColor    = isSupport ? "rgba(38,200,122,0.12)" : isResist ? "rgba(239,68,68,0.12)" : "rgba(200,180,50,0.12)";
              borderColor  = isSupport ? "rgba(60,200,100,0.85)" : isResist ? "rgba(220,60,60,0.85)" : "rgba(200,180,50,0.85)";
              labelBgColor = isSupport ? "rgba(30,120,60,0.80)"  : isResist ? "rgba(150,40,40,0.80)" : "rgba(140,120,30,0.80)";
            }

            ctx.save();
            // Fill first, then border on top
            ctx.fillStyle = fillColor;
            ctx.fillRect(zLeft, zy, zoneW, zrh);
            ctx.strokeStyle = borderColor; ctx.lineWidth = 1;
            ctx.strokeRect(zLeft, zy, zoneW, zrh);
            if (showLabelsRef.current) {
              // Price labels (top & bottom right corners)
              ctx.font = "bold 10px 'Trebuchet MS', monospace";
              ctx.textAlign = "right";
              const topLabel = zone.topPrice.toFixed(2);
              const topLabelW = ctx.measureText(topLabel).width + 6;
              ctx.fillStyle = labelBgColor;
              ctx.fillRect(zLeft + zoneW - topLabelW, zy, topLabelW, 14);
              ctx.fillStyle = "#ffffff";
              ctx.fillText(topLabel, zLeft + zoneW - 2, zy + 10);
              const botLabel = zone.bottomPrice.toFixed(2);
              const botLabelW = ctx.measureText(botLabel).width + 6;
              ctx.fillStyle = labelBgColor;
              ctx.fillRect(zLeft + zoneW - botLabelW, zyb - 14, botLabelW, 14);
              ctx.fillStyle = "#ffffff";
              ctx.fillText(botLabel, zLeft + zoneW - 2, zyb - 4);
              // Zone name label — centred in the box if it's tall enough
              if (zone.label && zrh > 18) {
                ctx.font = "bold 11px 'Trebuchet MS', sans-serif";
                ctx.textAlign = "left";
                ctx.fillStyle = borderColor;
                ctx.save();
                ctx.beginPath();
                ctx.rect(zLeft + 3, zy, zoneW - 6, zrh);
                ctx.clip();
                ctx.fillText(zone.label, zLeft + 4, zy + Math.min(zrh / 2 + 4, zrh - 4));
                ctx.restore();
              }
            }
            ctx.restore();
          }

          // ── Gap fills between today-only zones (no fromTime/toTime) ──────
          if (xStart !== null && xEnd !== null) {
            const ZONE_W = Math.max(4, xEnd - xStart);
            const dayZones = [...zonesRef.current].filter(z => !z.fromTime && !z.toTime).sort((a, b) => b.topPrice - a.topPrice);
            for (let gi = 0; gi + 1 < dayZones.length; gi++) {
              const gapTop = dayZones[gi].bottomPrice;
              const gapBot = dayZones[gi + 1].topPrice;
              if (gapTop <= gapBot) continue; // no gap (overlapping or touching)
              const gyT = series.priceToCoordinate(gapTop);
              const gyB = series.priceToCoordinate(gapBot);
              if (gyT === null || gyB === null) continue;
              const gy  = Math.max(0, Math.min(gyT, gyB));
              const gyb = Math.min(clipBottom, Math.max(gyT, gyB));
              const grh = gyb - gy;
              if (grh < 1) continue;
              ctx.save();
              ctx.strokeStyle = "rgba(160,160,160,0.45)";
              ctx.lineWidth = 1;
              ctx.setLineDash([4, 3]);
              ctx.strokeRect(xStart, gy, ZONE_W, grh);
              ctx.setLineDash([]);
              ctx.restore();
            }
          }
        }
      }

      // ── Footprint rendering: layers 2-5 (below signals for correct z-order) ─── IMBALANCE-FIX: rendering order per spec Part 5
      {
        const fpMap = candleFootprintsRef.current; // IMBALANCE-FIX:
        if (fpMap.size > 0) { // IMBALANCE-FIX:
          // Detect bar width for column sizing
          let barW = 8; // FOOTPRINT-SIZE-FIX:
          const visCan2: typeof candlesRef.current = []; // FOOTPRINT-SIZE-FIX:
          for (const c of candlesRef.current) { // FOOTPRINT-SIZE-FIX:
            const x = ts.timeToCoordinate(c.time as any); // FOOTPRINT-SIZE-FIX:
            if (x !== null && (x as number) >= 0 && (x as number) <= cw) { visCan2.push(c); if (visCan2.length >= 2) break; } // FOOTPRINT-SIZE-FIX:
          } // FOOTPRINT-SIZE-FIX:
          if (visCan2.length >= 2) { // FOOTPRINT-SIZE-FIX:
            const xa = ts.timeToCoordinate(visCan2[0].time as any); // FOOTPRINT-SIZE-FIX:
            const xb = ts.timeToCoordinate(visCan2[1].time as any); // FOOTPRINT-SIZE-FIX:
            if (xa !== null && xb !== null) barW = Math.max(4, Math.abs((xb as number) - (xa as number))); // FOOTPRINT-SIZE-FIX:
          } // FOOTPRINT-SIZE-FIX:
          const fmtVol = (v: number): string => { // FOOTPRINT-SIZE-FIX:
            if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M"; // FOOTPRINT-SIZE-FIX:
            if (v >= 1_000) return Math.round(v / 1_000) + "k"; // FOOTPRINT-SIZE-FIX:
            return String(Math.round(v)); // FOOTPRINT-SIZE-FIX:
          }; // FOOTPRINT-SIZE-FIX:



          // ── Footprint ladders + imbalance zones ──────────────────────────────
          // Each session ladder is ANCHORED to its first candle's x-position.
          // It only renders when that candle is within the viewport.
          // As you pan/zoom, each ladder moves with its candle and can disappear.
          const C_TOT    = 175;
          const C_LEFT   = 120, C_RIGHT = 55;
          const MIN_ROW_H = 16;

          const allAggsFp = [...fpMap.values()]
            .filter(a => a.symbol === "RTH" || a.symbol === "ETH");

          // ── Step 1: Imbalance zones from ALL sessions (drawn before ladders) ──
          // Current-session zones at full opacity, historical at 28%.
          // Merge logic removed — will be re-added once zone invalidation rules are known.
          {
            const zX1 = cw - 62;
            if (zX1 > 0) {
              ctx.save();
              ctx.beginPath(); ctx.rect(0, 0, zX1, clipBottom); ctx.clip();

              // Pre-sort candles once for binary-search mitigation check
              const sortedCans = [...candlesRef.current].sort((a, b) => a.time - b.time);

              for (const zfp of [...allAggsFp].sort((a, b) => a.time - b.time)) {
                if (zfp.time === activeSessionTimeRef.current) continue; // FOOTPRINT-RENDER: skip zones for active (incomplete) session — ladder still renders below
                const xfR2 = ts.timeToCoordinate(zfp.time as any);
                const isCurZ = xfR2 !== null && (xfR2 as number) >= 0 && (xfR2 as number) <= cw;
                const aM = isCurZ ? 1.0 : 0.28;

                // For historical sessions: find first candle index after this session
                // RTH sessions run ~6.5h (23400s); ETH ~17h (61200s). Use 25000s as cutoff.
                const postSessionStart = zfp.time + 25000;
                // Binary search: find first candle index >= postSessionStart
                let bsLo = 0, bsHi = sortedCans.length;
                while (bsLo < bsHi) {
                  const bsMid = (bsLo + bsHi) >> 1;
                  if (sortedCans[bsMid].time < postSessionStart) bsLo = bsMid + 1;
                  else bsHi = bsMid;
                }
                const postStart = bsLo; // index of first candle strictly after this session

                for (const cl of zfp.imbalances) {
                  if (!cl.stacked) continue; // only strong (stacked) imbalances shown as zones
                  const lo  = Math.min(cl.startPrice, cl.endPrice);
                  const hi  = Math.max(cl.startPrice, cl.endPrice);
                  const buy = cl.direction === "buy";

                  // Mitigation: skip historical zones whose midPrice has been closed through
                  if (!isCurZ) {
                    const midPrice = (lo + hi) / 2;
                    let mitigated = false;
                    for (let mi = postStart; mi < sortedCans.length; mi++) {
                      const mc = sortedCans[mi];
                      if (buy ? mc.close < midPrice : mc.close > midPrice) { mitigated = true; break; }
                    }
                    if (mitigated) continue;
                  }

                  const tyR = series.priceToCoordinate(hi + 0.5);
                  const byR = series.priceToCoordinate(lo - 0.5);
                  if (tyR === null || byR === null) continue;
                  const zt = tyR as number;
                  const zh = Math.max(2, (byR as number) - zt);

                  // Tier-based opacity: tier1=base, tier2=+40%, tier3=+80% of base fill
                  const tierMult = cl.strengthTier === 3 ? 1.8 : cl.strengthTier === 2 ? 1.4 : 1.0;
                  const fillA  = Math.min(0.45, 0.18 * aM * tierMult);
                  const lineA  = Math.min(1.0,  0.75 * aM * tierMult);
                  ctx.fillStyle = buy
                    ? `rgba(34,197,94,${fillA.toFixed(3)})`
                    : `rgba(239,68,68,${fillA.toFixed(3)})`;
                  ctx.fillRect(0, zt, zX1, zh);
                  ctx.strokeStyle = buy
                    ? `rgba(74,222,128,${lineA.toFixed(3)})`
                    : `rgba(248,113,113,${lineA.toFixed(3)})`;
                  ctx.lineWidth = cl.strengthTier === 3 ? 1.5 : 1; ctx.setLineDash([]);
                  ctx.beginPath(); ctx.moveTo(0, zt);      ctx.lineTo(zX1, zt);      ctx.stroke();
                  ctx.beginPath(); ctx.moveTo(0, zt + zh); ctx.lineTo(zX1, zt + zh); ctx.stroke();
                }
              }

              ctx.restore();
            }
          }

          // ── Step 2: Session ladders — anchored to each session's first candle ─
          const renderFpLadder = (fp: FootprintCandle, xFirst: number) => {
            if (fp.levels.length < 1 || fp.high <= fp.low) return;
            const xL   = xFirst;
            const xDiv = xL + C_LEFT;
            const xR   = xDiv + C_RIGHT;

            const lvSorted = [...fp.levels].sort((a, b) => b.price - a.price);
            const stkBuyFp  = new Set<number>();
            const stkSellFp = new Set<number>();
            const inVAFp    = new Set<number>();
            for (const lv of lvSorted)
              if (lv.price >= fp.val - 0.5 && lv.price <= fp.vah + 0.5) inVAFp.add(lv.price);
            for (const cl of fp.imbalances) {
              if (!cl.stacked) continue;
              const lo = Math.min(cl.startPrice, cl.endPrice);
              const hi = Math.max(cl.startPrice, cl.endPrice);
              for (const lv of lvSorted)
                if (lv.price >= lo - 0.5 && lv.price <= hi + 0.5)
                  (cl.direction === "buy" ? stkBuyFp : stkSellFp).add(lv.price);
            }

            const visible = lvSorted.filter(lv => {
              const yr = series.priceToCoordinate(lv.price);
              if (yr === null) return false;
              const y = yr as number;
              return y >= -MIN_ROW_H && y <= clipBottom + MIN_ROW_H;
            });
            if (visible.length === 0) return;

            let pixPerLevel = MIN_ROW_H;
            if (visible.length >= 2) {
              const ya = series.priceToCoordinate(visible[0].price) as number;
              const yb = series.priceToCoordinate(visible[1].price) as number;
              pixPerLevel = Math.max(0.5, Math.abs(yb - ya));
            }
            const skip     = Math.max(1, Math.ceil(MIN_ROW_H / pixPerLevel));
            const displayH = pixPerLevel * skip;
            const rows     = visible.filter((lv, i) => i % skip === 0 || lv.price === fp.poc);

            ctx.save();
            ctx.beginPath(); ctx.rect(xL, 0, C_TOT, clipBottom); ctx.clip();

            // Session header
            {
              const topY  = (series.priceToCoordinate(rows[0].price) as number) - displayH / 2;
              ctx.fillStyle = "rgba(6, 9, 18, 0.97)";
              ctx.fillRect(xL, topY - 14, C_TOT, 14);
              ctx.font = "bold 8px 'Trebuchet MS',monospace";
              ctx.textBaseline = "middle"; ctx.textAlign = "center";
              ctx.fillStyle = fp.symbol === "RTH" ? "#5b7fa8" : "#8070a8";
              ctx.fillText(fp.symbol, xL + C_TOT / 2, topY - 7);
            }

            for (const lv of rows) {
              const yr = series.priceToCoordinate(lv.price);
              if (yr === null) continue;
              const cy   = yr as number;
              const rTop = cy - displayH / 2;
              const rH   = displayH;

              const isPoc  = lv.price === fp.poc;
              const isStkB = stkBuyFp.has(lv.price);
              const isStkS = stkSellFp.has(lv.price);
              const isBuy  = lv.imbalance === "buy";
              const isSell = lv.imbalance === "sell";
              const isVA   = inVAFp.has(lv.price);

              // Background — nearly-black dark tints; color is in text & stripe
              const bg = isStkS ? "rgba(26, 5, 5, 0.95)"
                : isStkB        ? "rgba(4, 20, 9, 0.95)"
                : isSell        ? "rgba(18, 4, 4, 0.95)"
                : isBuy         ? "rgba(3, 14, 7, 0.95)"
                : isVA          ? "rgba(9, 14, 28, 0.95)"
                :                  "rgba(7, 10, 20, 0.95)";
              ctx.fillStyle = bg;
              ctx.fillRect(xL, rTop, C_TOT, rH);

              // 2px left accent stripe
              const stripe = isStkS ? "#b91c1c"
                : isStkB            ? "#15803d"
                : isSell            ? "#6b1515"
                : isBuy             ? "#0f5c2a"
                : isPoc             ? "#92400e"
                : null;
              if (stripe) { ctx.fillStyle = stripe; ctx.fillRect(xL, rTop, 2, rH); }

              // Column divider + row separator
              ctx.fillStyle = "rgba(255,255,255,0.05)";
              ctx.fillRect(xDiv, rTop, 1, rH);
              ctx.fillStyle = "rgba(255,255,255,0.03)";
              ctx.fillRect(xL, rTop + rH - 1, C_TOT, 1);

              // POC — thin amber top/bottom rule
              if (isPoc) {
                ctx.strokeStyle = "#92400e";
                ctx.lineWidth = 1; ctx.setLineDash([]);
                ctx.beginPath(); ctx.moveTo(xL, rTop + 0.5); ctx.lineTo(xL + C_TOT, rTop + 0.5); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(xL, rTop + rH - 0.5); ctx.lineTo(xL + C_TOT, rTop + rH - 0.5); ctx.stroke();
              }

              if (rH < 8) continue;

              const fs = Math.min(12, Math.max(9, rH * 0.52));
              const tY = rTop + rH / 2;
              ctx.textBaseline = "middle";
              ctx.font = `${isStkB || isStkS ? "bold" : "normal"} ${fs}px 'Trebuchet MS',monospace`;

              // Text: colored for imbalance levels, dim gray for plain rows
              const tc = isStkS ? "#ef4444"
                : isStkB        ? "#22c55e"
                : isSell        ? "#f87171"
                : isBuy         ? "#4ade80"
                :                  "rgba(128, 140, 160, 0.88)";
              ctx.fillStyle = tc;
              ctx.textAlign = "left";
              ctx.fillText(`${fmtVol(lv.bidVol)} × ${fmtVol(lv.askVol)}`, xL + 7, tY);
              ctx.textAlign = "center";
              ctx.fillText(fmtVol(lv.bidVol + lv.askVol), xDiv + C_RIGHT / 2, tY);
            }

            // Outer border
            if (rows.length > 0) {
              const t0 = (series.priceToCoordinate(rows[0].price) as number) - displayH / 2;
              const t1 = (series.priceToCoordinate(rows[rows.length - 1].price) as number) + displayH / 2;
              ctx.strokeStyle = "rgba(60, 80, 120, 0.25)";
              ctx.lineWidth = 1; ctx.setLineDash([]);
              ctx.strokeRect(xL, t0, C_TOT, t1 - t0);
            }
            ctx.restore();

            // VAH / VAL guide lines — subtle, outside the ladder column
            ctx.save();
            ctx.font = "bold 8px 'Trebuchet MS',monospace";
            ctx.textBaseline = "middle";
            const drawHL = (price: number, lbl: string, col: string) => {
              const vy = series.priceToCoordinate(price);
              if (vy === null) return;
              const y = vy as number;
              if (y < 0 || y > clipBottom) return;
              ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
              ctx.beginPath(); ctx.moveTo(xL, y); ctx.lineTo(xR, y); ctx.stroke();
              ctx.setLineDash([]);
              ctx.fillStyle = col; ctx.textAlign = "right";
              ctx.fillText(lbl, xL - 3, y);
            };
            drawHL(fp.vah, "VAH", "rgba(74,222,128,0.45)");
            drawHL(fp.val, "VAL", "rgba(248,113,113,0.45)");
            ctx.restore();
          }; // end renderFpLadder

          // Draw each session's ladder anchored at its first candle
          // Visibility: first candle must be within [0, cw]
          for (const fp of allAggsFp) {
            const xfR = ts.timeToCoordinate(fp.time as any);
            if (xfR === null) continue;
            const xf = xfR as number;
            if (xf < 0 || xf > cw) continue; // first candle off-screen — ladder hidden
            renderFpLadder(fp, xf);
          }
        } // IMBALANCE-FIX: end fpMap.size > 0
      } // IMBALANCE-FIX: end footprint rendering block


      // ── Vector entry arrows (upward arrow with stem, below candle) ──────
      for (const sig of entrySignalsRef.current) {
        const sx = ts.timeToCoordinate(sig.time as any), sy = series.priceToCoordinate(sig.price);
        if (sx == null || sy == null) continue;
        const base = sy + 32; // bottom of stem
        const tip  = sy + 10; // arrowhead tip
        ctx.save();
        ctx.strokeStyle = themeRef.current.vectorLine;
        ctx.fillStyle   = themeRef.current.vectorLine;
        ctx.lineWidth   = 1.5;
        // Stem
        ctx.beginPath(); ctx.moveTo(sx, base); ctx.lineTo(sx, tip + 7); ctx.stroke();
        // Arrowhead pointing up
        ctx.beginPath();
        ctx.moveTo(sx,      tip);
        ctx.lineTo(sx - 5,  tip + 9);
        ctx.lineTo(sx + 5,  tip + 9);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // ── Confluence signal circles + MC TP/SL levels ───────────────────────
      // Shared label tracker prevents multiple signals' text boxes from overlapping
      const usedLabels: Array<{ rx: number; y: number }> = [];
      // Signals can be tagged with a finer interval than the displayed bars
      // (e.g. a 5m signal on the 15m/60m chart) — their exact bar time then has
      // no coordinate on this time scale. Snap those to the displayed bar that
      // CONTAINS the signal time, else they silently vanish from coarser charts.
      const dispTimes = [...candlesRef.current].map(c => c.time).sort((a, b) => a - b);
      let dispIntervalSec = Infinity;
      for (let i = 1; i < Math.min(dispTimes.length, 50); i++) {
        const d = dispTimes[i] - dispTimes[i - 1];
        if (d > 0 && d < dispIntervalSec) dispIntervalSec = d;
      }
      const snapToDisplayedBar = (t: number): number | null => {
        let lo = 0, hi = dispTimes.length - 1, best = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (dispTimes[m] <= t) { best = m; lo = m + 1; } else hi = m - 1; }
        if (best < 0) return null;
        const bt = dispTimes[best];
        return isFinite(dispIntervalSec) && t - bt < dispIntervalSec ? bt : null;
      };
      for (const sig of confluenceSignalsRef.current) {
        const rl = (sig as any).riskLevel as string | undefined;
        const st = sig.signalType as string | undefined;
        // In backtest mode all dots are uniform; otherwise fade risky/riskiest
        const segAlpha = backtestModeRef.current ? 1.0 : (rl === "risky" ? 0.6 : rl === "riskiest" ? 0.35 : 1.0);
        // Circle radius: backtest=9 always; else safe=9, risky=7, riskiest=5
        const circleR  = backtestModeRef.current ? 9 : (rl === "risky" ? 7 : rl === "riskiest" ? 5 : 9);

        let sx = ts.timeToCoordinate(sig.time as any);
        if (sx == null) {
          const snapped = snapToDisplayedBar(sig.time as number);
          if (snapped != null) sx = ts.timeToCoordinate(snapped as any);
        }
        const sy = series.priceToCoordinate(sig.price);
        if (sx == null || sy == null) continue;
        const isLong = sig.direction === "Long";
        const cy = isLong ? sy + 22 : sy - 22;

        // ── When this signal is active: draw the pattern indicator + TP/SL ──
        if (activeSignalTimeRef.current === sig.time) {
          ctx.save();
          ctx.globalAlpha = segAlpha;

          // Pattern indicator: the visual "changed vector" for tabletop signals
          const pfromX = sig.patternFromTime != null
            ? ts.timeToCoordinate(sig.patternFromTime as any) : null;
          const ptoX = sx;

          if (pfromX != null && pfromX < ptoX) {
            if (st === "pure_tabletop") {
              // Horizontal dashed line at the flat vector level — the "tabletop" shelf
              const lineY = series.priceToCoordinate(sig.price);
              if (lineY != null) {
                ctx.strokeStyle = isLong ? "rgba(245,158,11,0.8)" : "rgba(139,92,246,0.8)";
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(pfromX, lineY);
                ctx.lineTo(ptoX, lineY);
                ctx.stroke();
                ctx.setLineDash([]);
              }
            } else if (st === "side_tabletop" && sig.rangeHigh != null && sig.rangeLow != null) {
              // Range channel box: green upper half, red lower half — like vectorexitstrat
              const rMid = (sig.rangeHigh + sig.rangeLow) / 2;
              const topY = series.priceToCoordinate(sig.rangeHigh);
              const midY = series.priceToCoordinate(rMid);
              const botY = series.priceToCoordinate(sig.rangeLow);
              if (topY != null && midY != null && botY != null) {
                const w = ptoX - pfromX;
                ctx.fillStyle = "rgba(34,197,94,0.18)";
                ctx.fillRect(pfromX, topY, w, midY - topY);
                ctx.fillStyle = "rgba(239,68,68,0.18)";
                ctx.fillRect(pfromX, midY, w, botY - midY);
                ctx.strokeStyle = "rgba(255,255,255,0.55)";
                ctx.lineWidth = 1;
                ctx.strokeRect(pfromX, topY, w, botY - topY);
                ctx.strokeStyle = "rgba(255,255,255,0.25)";
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(pfromX, midY);
                ctx.lineTo(ptoX, midY);
                ctx.stroke();
                ctx.setLineDash([]);
              }
            }
          }

          renderConfluenceSegment(ctx, sig, chart, series, showLabelsRef.current, cw, usedLabels);
          ctx.restore();
        }

        ctx.save();
        ctx.globalAlpha = segAlpha;

        if (st === "pure_tabletop") {
          // Square marker — amber (long) / purple (short)
          const fillClr = isLong ? "rgba(245,158,11,0.92)" : "rgba(139,92,246,0.92)";
          const ringClr = isLong ? "rgba(120,53,15,0.7)"   : "rgba(46,16,101,0.7)";
          ctx.fillStyle   = fillClr;
          ctx.strokeStyle = ringClr;
          ctx.lineWidth   = 1.5;
          ctx.fillRect(sx - circleR, cy - circleR, circleR * 2, circleR * 2);
          ctx.strokeRect(sx - circleR, cy - circleR, circleR * 2, circleR * 2);
        } else if (st === "side_tabletop") {
          // Circle marker same as default — renders identically to normal confluence signals
          const fillClr = isLong ? "rgba(38,200,122,0.92)"  : "rgba(239,83,80,0.92)";
          const ringClr = isLong ? "rgba(0,60,30,0.7)"      : "rgba(80,0,0,0.7)";
          ctx.beginPath();
          ctx.arc(sx, cy, circleR, 0, Math.PI * 2);
          ctx.fillStyle   = fillClr;
          ctx.strokeStyle = ringClr;
          ctx.lineWidth   = 1.5;
          ctx.fill();
          ctx.stroke();
        } else {
          // Default: circle (confluence marker, or backtest outcome marker)
          let fillClr: string;
          let ringClr: string;
          if (backtestModeRef.current) {
            const oc = (sig as any).outcome as string | undefined;
            const isWin  = oc === "win_tp1" || oc === "win_tp2" || oc === "win_trailer";
            const isOpen = oc === "open";
            fillClr = isWin ? "rgba(38,200,122,0.92)" : isOpen ? "rgba(100,110,120,0.7)" : "rgba(239,83,80,0.92)";
            ringClr = isWin ? "rgba(0,60,30,0.7)"     : isOpen ? "rgba(40,50,60,0.6)"   : "rgba(80,0,0,0.7)";
          } else {
            fillClr = isLong ? "rgba(38,200,122,0.92)" : "rgba(239,83,80,0.92)";
            ringClr = isLong ? "rgba(0,60,30,0.7)"     : "rgba(80,0,0,0.7)";
          }
          ctx.beginPath();
          ctx.arc(sx, cy, circleR, 0, Math.PI * 2);
          ctx.fillStyle   = fillClr;
          ctx.strokeStyle = ringClr;
          ctx.lineWidth   = 1.5;
          ctx.fill();
          ctx.stroke();
        }

        // Text inside marker (▲/▼ normally; L/S in backtest mode)
        if (circleR >= 7) {
          ctx.fillStyle = "#fff";
          ctx.font = `bold ${circleR > 7 ? 10 : 8}px 'Trebuchet MS', monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(backtestModeRef.current ? (isLong ? "L" : "S") : (isLong ? "▲" : "▼"), sx, cy);
        }
        ctx.restore();
        markerHitsRef.current.push({ x: sx, y: cy, info: { type: "confluence", time: sig.time, direction: sig.direction, price: sig.price, tp1: sig.tp1, tp2: sig.tp2, sl: sig.sl, riskLevel: rl, signalType: st, confirmations: sig.confirmations, reclassifyReason: sig.reclassifyReason } });
      }

      // ── Trade segments (TP/Stop lines with exact start/end) ───────────
      for (const seg of tradeSegmentsRef.current) {
        renderTradeSegment(ctx, seg, chart, series, cw, showLabelsRef.current);
      }

      // ── Completed drawings ────────────────────────────────────────────
      for (const d of drawingsRef.current) renderDrawing(ctx, d, chart, series, cw, ch, selectedIdRef.current);

      // ── Pending drawing preview ───────────────────────────────────────
      const pd = pendingDrawRef.current;
      if (pd && activeToolRef.current !== "cursor") {
        ctx.save(); ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 1.5; ctx.setLineDash([4,3]); ctx.globalAlpha = 0.85;
        if (activeToolRef.current === "rectangle") {
          const rx=Math.min(pd.x1,pd.x2),ry=Math.min(pd.y1,pd.y2),rw=Math.abs(pd.x2-pd.x1),rh=Math.abs(pd.y2-pd.y1);
          ctx.strokeRect(rx,ry,rw,rh); ctx.fillStyle="#3b82f620"; ctx.fillRect(rx,ry,rw,rh);
        } else if (activeToolRef.current === "fibonacci") {
          const price2 = series.coordinateToPrice(pd.y2) ?? pd.p1;
          FIB_LEVELS.forEach((lvl, i) => {
            const py = series.priceToCoordinate(pd.p1 + (price2-pd.p1)*lvl);
            if (py==null) return;
            ctx.strokeStyle=FIB_COLORS[i];
            ctx.beginPath(); ctx.moveTo(Math.min(pd.x1,pd.x2),py); ctx.lineTo(Math.max(pd.x1,pd.x2),py); ctx.stroke();
          });
        } else {
          ctx.beginPath(); ctx.moveTo(pd.x1,pd.y1); ctx.lineTo(pd.x2,pd.y2); ctx.stroke();
        }
        ctx.restore();
      }

      // ── Live price arrow — right-edge marker that tracks the current price ──
      // The canvas draws only the horizontal line + arrow pointing INTO the Y-axis.
      // ── Secondary (extra) vectors drawn on canvas ─────────────────────────
      // Rendered here instead of as LineSeries so foreign-interval timestamps
      // don't get added to the shared time axis (which would create gaps between candles).
      // timeToCoordinate() interpolates for any timestamp, giving correct x positions.
      {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, cw, clipBottom); ctx.clip();
        for (const ev of extraVectorsRef.current) {
          if (!ev.data.length) continue;
          const sorted = ev.data; // already sorted by market.tsx

          // Detect native bar interval so we can break the path at session boundaries.
          // Overnight/weekend gaps in the vector data appear as massive gaps (>3× interval)
          // that would otherwise draw a diagonal line squished into the chart's gap pixel.
          let nativeInterval = Infinity;
          for (let k = 1; k < Math.min(sorted.length, 50); k++) {
            const g = sorted[k].time - sorted[k - 1].time;
            if (g > 0) nativeInterval = Math.min(nativeInterval, g);
          }
          if (!isFinite(nativeInterval)) nativeInterval = 60;
          const breakThreshold = nativeInterval * 3;

          ctx.beginPath();
          ctx.strokeStyle = ev.color;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.85;
          let started = false;
          for (let k = 0; k < sorted.length; k++) {
            const pt = sorted[k];
            // Break path at session/overnight boundaries
            if (k > 0 && pt.time - sorted[k - 1].time > breakThreshold) started = false;
            const x = ts.timeToCoordinate(pt.time as any);
            const y = series.priceToCoordinate(pt.value);
            if (x === null || y === null) { started = false; continue; }
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          // Label at the right end
          const last = sorted[sorted.length - 1];
          const lx = ts.timeToCoordinate(last.time as any);
          const ly = series.priceToCoordinate(last.value);
          if (lx !== null && ly !== null) {
            ctx.font = "bold 10px 'Trebuchet MS', monospace";
            ctx.textAlign = "left";
            ctx.globalAlpha = 1;
            ctx.fillStyle = ev.color;
            ctx.fillText(`Vec ${ev.label}`, lx + 4, ly - 4);
          }
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // ── Footprint rendering moved above signals — see insertion point before vector arrows ──

      // The actual price label on the Y-axis is rendered natively by createPriceLine
      // (axisLabelVisible:true) so we must NOT draw any box here — doing so covers it.
      const lp = livePriceRef.current;
      if (lp) {
        const y = series.priceToCoordinate(lp.price);
        if (y != null && y > 10 && y < clipBottom - 10) {
          const t = themeRef.current;
          const color = lp.isUp ? t.up : t.down;
          ctx.save();
          // Solid horizontal line from left edge up to (but NOT into) the price scale
          ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9;
          ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw - 66, y); ctx.stroke();
          // Right-pointing triangle at the price scale boundary — acts as an arrow indicator
          const ax = cw - 66;
          ctx.fillStyle = color; ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.moveTo(ax,      y - 6);
          ctx.lineTo(ax + 10, y);
          ctx.lineTo(ax,      y + 6);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
    }, []);
    // Keep ref in sync so updateLastBarClose() can schedule a redraw without a stale closure
    drawAllRef.current = drawAll;

    // Extra vectors: sync to ref + schedule redraw (canvas rendering — no LineSeries)
    useEffect(() => {
      extraVectorsRef.current = (extraVectors ?? []).map(ev => ({
        ...ev,
        data: [...ev.data].sort((a, b) => a.time - b.time),
      }));
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(drawAll);
    }, [extraVectors, drawAll]);

    // Sync per-candle footprint data to ref and redraw // FOOTPRINT-RENDER:
    useEffect(() => { // FOOTPRINT-RENDER:
      candleFootprintsRef.current = candleFootprints ?? new Map(); // FOOTPRINT-RENDER:
      cancelAnimationFrame(rafIdRef.current); // FOOTPRINT-RENDER:
      rafIdRef.current = requestAnimationFrame(drawAll); // FOOTPRINT-RENDER:
    }, [candleFootprints, drawAll]); // FOOTPRINT-RENDER:

    // Sync active session anchor so zone-draw loop can skip it // FOOTPRINT-RENDER:
    useEffect(() => { // FOOTPRINT-RENDER:
      activeSessionTimeRef.current = activeSessionTime; // FOOTPRINT-RENDER:
    }, [activeSessionTime]); // FOOTPRINT-RENDER: no redraw needed — drawAll reads ref each frame

    // Sync frozen imbalance zones to ref and redraw // FOOTPRINT-RULE:
    useEffect(() => { // FOOTPRINT-RULE:
      frozenImbalancesRef.current = frozenImbalances ?? []; // FOOTPRINT-RULE:
      cancelAnimationFrame(rafIdRef.current); // FOOTPRINT-RULE:
      rafIdRef.current = requestAnimationFrame(drawAll); // FOOTPRINT-RULE:
    }, [frozenImbalances, drawAll]); // FOOTPRINT-RULE:

    // Sync band data to ref and force immediate redraw whenever the overlay data changes
    useEffect(() => {
      bandOverlaysRef.current = bandOverlays || [];
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(drawAll);
    }, [bandOverlays, drawAll]);

    // Sync zone data to ref and redraw
    useEffect(() => {
      zonesRef.current = zones || [];
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(drawAll);
    }, [zones, drawAll]);

    // Redraw when showLabels changes
    useEffect(() => {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(drawAll);
    }, [showLabels, drawAll]);

    // Keep candles ref in sync
    useEffect(() => { candlesRef.current = candles || []; }, [candles]);

    // Subscribe to chart pan/zoom — redraw overlay + notify parent of range change
    useEffect(() => {
      const chart = chartRef.current; if (!chart) return;
      const schedule = () => {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = requestAnimationFrame(drawAll);
        const r = chart.timeScale().getVisibleLogicalRange();
        if (r) onVisibleRangeChangeRef.current?.(r.from, r.to);
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
      return () => {
        cancelAnimationFrame(rafIdRef.current);
        try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule); } catch {}
      };
    }, [drawAll]);

    // Redraw when any overlay data changes — single effect, single scheduled frame
    useEffect(() => {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(drawAll);
    }, [drawings, tradeSegments, entrySignals, confluenceSignals, candles, zoneOverlays, activeSignalTime, drawAll]);

    // ── Drawing mouse handlers ──────────────────────────────────────────────
    const getChartCoords = useCallback((e: React.MouseEvent) => {
      const chart = chartRef.current, series = candleSeriesRef.current;
      if (!chart||!series) return null;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX-rect.left, y = e.clientY-rect.top;
      const time = chart.timeScale().coordinateToTime(x), price = series.coordinateToPrice(y);
      if (time==null||price==null) return null;
      return { x, y, time: Number(time), price };
    }, []);

    const scheduleDraw = useCallback(() => {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(drawAll);
    }, [drawAll]);

    const handleDrawMouseDown = useCallback((e: React.MouseEvent) => {
      if (activeTool === "cursor") return;
      // ── Detail tool: report candle info on click ────────────────────────
      if (activeTool === "detail") {
        const coords = getChartCoords(e);
        if (coords) {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          (props as any).onDetailClick?.({ ...coords, x: e.clientX - rect.left, y: e.clientY - rect.top });
        }
        return;
      }
      // ── Pan tool: start dragging to scroll the time axis ───────────────
      if (activeTool === "pan") {
        panRef.current = { lastX: e.clientX, lastY: e.clientY, mode: "pan" };
        return;
      }
      const coords = getChartCoords(e); if (!coords) return;
      if (activeTool === "hline") {
        onAddDrawing?.({ id:uid(), type:"hline", price:coords.price, color:"#3b82f6", style:"solid" }); return;
      }
      if (activeTool === "vline") {
        onAddDrawing?.({ id:uid(), type:"line", t1:coords.time, p1:coords.price+99999, t2:coords.time, p2:coords.price-99999, color:"#3b82f6" }); return;
      }
      pendingDrawRef.current = { x1:coords.x, y1:coords.y, x2:coords.x, y2:coords.y, t1:coords.time, p1:coords.price };
      scheduleDraw();
    }, [activeTool, getChartCoords, onAddDrawing, scheduleDraw]);

    const handleDrawMouseMove = useCallback((e: React.MouseEvent) => {
      // ── Pan tool: scroll chart left/right and up/down ──────────────────
      if (activeTool === "pan" && panRef.current) {
        const dx = e.clientX - panRef.current.lastX;
        const dy = e.clientY - panRef.current.lastY;
        panRef.current = { lastX: e.clientX, lastY: e.clientY, mode: "pan" };
        const chart = chartRef.current;
        if (chart) {
          const ts = chart.timeScale();
          const range = ts.getVisibleLogicalRange();
          if (range) {
            const cw = (e.currentTarget as HTMLElement).getBoundingClientRect().width;
            const barsVisible = range.to - range.from;
            const shift = -dx / (cw || 800) * barsVisible;
            ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
          }
          // Vertical pan: accumulate offset and apply
          const ch = (e.currentTarget as HTMLElement).getBoundingClientRect().height;
          const series = candleSeriesRef.current;
          if (series && ch > 0) {
            const yFrac = -dy / ch;
            const range2 = chart.priceScale("right");
            // Use autoscaleInfoProvider offset approach
            priceOffsetRef.current += yFrac * 50; // 50 price-unit feel; tuned below
            // Recompute a real price delta from coordinate space
            const midY = ch / 2;
            const p1 = series.coordinateToPrice(midY);
            const p2 = series.coordinateToPrice(midY - dy);
            if (p1 != null && p2 != null) {
              priceOffsetRef.current = (priceOffsetRef.current - yFrac * 50) + (p2 - p1);
            }
            applyVerticalOffset();
          }
        }
        return;
      }
      if (!pendingDrawRef.current) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      pendingDrawRef.current = { ...pendingDrawRef.current, x2:e.clientX-rect.left, y2:e.clientY-rect.top };
      scheduleDraw();
    }, [scheduleDraw]);

    const handleDrawMouseUp = useCallback((e: React.MouseEvent) => {
      // ── Pan tool: release drag ─────────────────────────────────────────
      if (activeTool === "pan") {
        panRef.current = null;
        return;
      }
      if (!pendingDrawRef.current) return;
      const coords = getChartCoords(e);
      const { t1, p1 } = pendingDrawRef.current;
      pendingDrawRef.current = null;
      if (coords) {
        if (activeTool === "line") onAddDrawing?.({ id:uid(), type:"line", t1, p1, t2:coords.time, p2:coords.price, color:"#3b82f6" });
        else if (activeTool === "rectangle") onAddDrawing?.({ id:uid(), type:"rectangle", t1, p1, t2:coords.time, p2:coords.price, color:"#3b82f6" });
        else if (activeTool === "fibonacci") onAddDrawing?.({ id:uid(), type:"fibonacci", t1, p1, t2:coords.time, p2:coords.price });
      }
      scheduleDraw();
    }, [activeTool, getChartCoords, onAddDrawing, scheduleDraw]);

    // Context menu: close when user clicks elsewhere
    useEffect(() => {
      if (!contextMenu) return;
      const h = (e: MouseEvent) => {
        // The menu itself calls stopPropagation, so this only fires for outside clicks
        setContextMenu(null);
      };
      window.addEventListener("mousedown", h);
      return () => window.removeEventListener("mousedown", h);
    }, [contextMenu]);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const HIT_R = 14;
      for (const hit of markerHitsRef.current) {
        if (Math.abs(hit.x - px) <= HIT_R && Math.abs(hit.y - py) <= HIT_R) {
          onSignalClickRef.current?.(hit.info);
          return;
        }
      }
      setContextMenu({ x: e.clientX, y: e.clientY });
    }, []);

    const fillParent = height == null;
    const isDrawing = activeTool !== "cursor";
    const drawCursor = activeTool==="line"||activeTool==="fibonacci" ? "crosshair" : activeTool==="hline" ? "ns-resize" : activeTool==="vline" ? "ew-resize" : "crosshair";
    const selRect = dragState?.active ? { left:Math.min(dragState.startX,dragState.curX), top:Math.min(dragState.startY,dragState.curY), width:Math.abs(dragState.curX-dragState.startX), height:Math.abs(dragState.curY-dragState.startY) } : null;

    return (
      <div ref={wrapperRef} style={{ width:"100%", height:fillParent?"100%":height, position:"relative", display:fillParent?"flex":"block", flexDirection:"column" }} data-testid="candlestick-chart">
        <div ref={containerRef} style={{ width:"100%", flex:fillParent?"1 1 0":undefined, height:fillParent?undefined:height }} />
        <canvas ref={bandCanvasRef} style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", pointerEvents:"none", zIndex:1 }} />
        {/* Candle hover tooltip */}
        {hoverTooltip && (() => {
          const hov = hoverTooltip;
          const isUp = hov.close >= hov.open;
          const clr  = isUp ? "#26c87a" : "#ef5350";
          const timeStr = new Date(hov.time * 1000).toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            hour12: false, timeZone: "America/New_York",
          }) + " ET";
          // Position: prefer right of cursor, flip left if near right edge
          const W = 190, H = 54;
          const raw = wrapperRef.current?.getBoundingClientRect();
          const maxX = (raw?.width ?? 600) - 70; // keep clear of price scale
          let tx = hov.x + 14;
          let ty = hov.y - H - 8;
          if (tx + W > maxX) tx = hov.x - W - 10;
          if (ty < 4) ty = hov.y + 12;
          return (
            <div style={{
              position: "absolute", left: tx, top: ty, zIndex: 20,
              background: "rgba(4,9,18,0.93)", border: `1px solid ${clr}55`,
              borderRadius: 4, padding: "5px 9px", pointerEvents: "none",
              fontFamily: "'Trebuchet MS', monospace", minWidth: W,
            }}>
              <div style={{ fontSize: 10, color: "#6a8aaa", marginBottom: 3 }}>{timeStr}</div>
              <div style={{ fontSize: 11, display: "flex", gap: 10 }}>
                <span style={{ color: "#8faac0" }}>O <span style={{ color: "#e2e8f0" }}>{hov.open.toFixed(2)}</span></span>
                <span style={{ color: "#8faac0" }}>H <span style={{ color: "#26c87a" }}>{hov.high.toFixed(2)}</span></span>
                <span style={{ color: "#8faac0" }}>L <span style={{ color: "#ef5350" }}>{hov.low.toFixed(2)}</span></span>
                <span style={{ color: "#8faac0" }}>C <span style={{ color: clr, fontWeight: 700 }}>{hov.close.toFixed(2)}</span></span>
              </div>
            </div>
          );
        })()}
        {/* Cover TV watermark + replace with SV */}
        <div style={{ position:"absolute", bottom:36, left:8, zIndex:10, pointerEvents:"none", display:"flex", alignItems:"center", gap:0 }}>
          <div style={{ width:40, height:22, background:"#05080d" }} />
          <span style={{ position:"absolute", left:0, fontSize:14, fontWeight:900, color:"#3a4a5c", letterSpacing:"-0.02em", fontFamily:"sans-serif", userSelect:"none" }}>SV</span>
        </div>
        {isDrawing && (
          <div style={{ position:"absolute", top:0, left:0, width:"calc(100% - 65px)", height:"calc(100% - 35px)", cursor: activeTool === "pan" ? (panRef.current ? "grabbing" : "grab") : activeTool === "detail" ? "default" : drawCursor, zIndex:5 }}
            onMouseDown={handleDrawMouseDown} onMouseMove={handleDrawMouseMove} onMouseUp={handleDrawMouseUp}
            onMouseLeave={() => { pendingDrawRef.current = null; panRef.current = null; scheduleDraw(); }} />
        )}
        {/* Drag-box zoom overlay — cursor mode only */}
        {activeTool === "cursor" && (
          <div
            data-testid="drag-zoom-overlay"
            style={{ position:"absolute", top:0, left:0,
              width:"calc(100% - 65px)", height:"calc(100% - 35px)",
              cursor:"grab", zIndex:5 }}
            onMouseDown={handleDragStart}
            onContextMenu={handleContextMenu}
          >
            {selRect && selRect.width > 2 && (
              <div data-testid="drag-zoom-selection" style={{ position:"absolute", left:selRect.left, top:selRect.top, width:selRect.width, height:selRect.height, border:"1.5px solid rgba(59,130,246,0.8)", backgroundColor:"rgba(59,130,246,0.08)", borderRadius:2, pointerEvents:"none" }} />
            )}
          </div>
        )}


        {/* ── Price axis drag handle ─────────────────────────────────────────
             Sits over the right price scale strip. Drag up = zoom in, drag down = zoom out.
             Double-click resets to auto scale. ──────────────────────────────────────────── */}
        <div
          style={{
            position: "absolute", top: 0, right: 0,
            width: 65, height: "calc(100% - 35px)",
            cursor: priceAxisDragRef.current ? "ns-resize" : priceAxisHover ? "ns-resize" : "default",
            zIndex: 6,
            background: priceAxisHover ? "rgba(26,114,212,0.06)" : "transparent",
            transition: "background 0.15s",
            borderLeft: priceAxisHover ? "1px solid rgba(26,114,212,0.25)" : "1px solid transparent",
          }}
          onMouseEnter={() => setPriceAxisHover(true)}
          onMouseLeave={() => { setPriceAxisHover(false); }}
          onMouseDown={e => {
            if (e.button !== 0) return;
            e.preventDefault();
            priceAxisDragRef.current = { lastY: e.clientY };
            document.body.style.cursor = "ns-resize";
          }}
          onDoubleClick={() => {
            priceScaleMultRef.current = 1.0;
            priceOffsetRef.current = 0;
            applyVerticalOffsetRef.current();
          }}
        >
          {/* Drag hint — small arrows shown on hover */}
          {priceAxisHover && (
            <div style={{
              position: "absolute", top: "50%", left: "50%",
              transform: "translate(-50%, -50%)",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              pointerEvents: "none", opacity: 0.55,
              color: "#1a72d4", fontSize: 11, fontFamily: "monospace", userSelect: "none",
            }}>
              <span>▲</span>
              <span style={{ fontSize: 9, color: "#4a6a90" }}>scale</span>
              <span>▼</span>
            </div>
          )}
        </div>

        {/* ── Time axis drag handle ──────────────────────────────────────────
             Sits over the bottom time scale strip. Drag right = zoom out, drag left = zoom in.
             Double-click resets to fit all. ─────────────────────────────────────────────── */}
        <div
          style={{
            position: "absolute", bottom: 0, left: 0,
            width: "calc(100% - 65px)", height: 35,
            cursor: timeAxisDragRef.current ? "ew-resize" : timeAxisHover ? "ew-resize" : "default",
            zIndex: 6,
            background: timeAxisHover ? "rgba(26,114,212,0.06)" : "transparent",
            transition: "background 0.15s",
            borderTop: timeAxisHover ? "1px solid rgba(26,114,212,0.25)" : "1px solid transparent",
          }}
          onMouseEnter={() => setTimeAxisHover(true)}
          onMouseLeave={() => setTimeAxisHover(false)}
          onMouseDown={e => {
            if (e.button !== 0) return;
            e.preventDefault();
            timeAxisDragRef.current = { lastX: e.clientX };
            document.body.style.cursor = "ew-resize";
          }}
          onDoubleClick={() => {
            chartRef.current?.timeScale().fitContent();
          }}
        >
          {timeAxisHover && (
            <div style={{
              position: "absolute", top: "50%", left: "50%",
              transform: "translate(-50%, -50%)",
              display: "flex", alignItems: "center", gap: 3,
              pointerEvents: "none", opacity: 0.55,
              color: "#1a72d4", fontSize: 11, fontFamily: "monospace", userSelect: "none",
            }}>
              <span>◀</span>
              <span style={{ fontSize: 9, color: "#4a6a90" }}>scale</span>
              <span>▶</span>
            </div>
          )}
        </div>

        {/* Right-click context menu */}
        {contextMenu && (
          <div
            style={{ position:"fixed", left:contextMenu.x, top:contextMenu.y, zIndex:300,
              background:"#0d1829", border:"1px solid #142033", borderRadius:6,
              padding:"4px 0", minWidth:190, boxShadow:"0 8px 32px rgba(0,0,0,0.65)",
              fontFamily:"'Trebuchet MS', monospace" }}
            onMouseDown={e => e.stopPropagation()}
          >
            {[
              { label: "Fit All",          action: () => { chartRef.current?.timeScale().fitContent(); setContextMenu(null); } },
              { label: "Reset Price Scale", action: () => { chartRef.current?.priceScale("right").applyOptions({ autoScale: true }); setContextMenu(null); } },
              null, // separator
              { label: "Undo Drawing",     action: () => { onUndoDrawing?.(); setContextMenu(null); } },
              { label: "Clear All Drawings", action: () => { onClearDrawings?.(); setContextMenu(null); } },
            ].map((item, i) =>
              item === null ? (
                <div key={i} style={{ height:1, background:"#142033", margin:"4px 0" }} />
              ) : (
                <button key={item.label} onClick={item.action}
                  style={{ display:"block", width:"100%", padding:"7px 16px", textAlign:"left",
                    background:"transparent", border:"none", color:"#b8c8d8", fontSize:12,
                    cursor:"pointer", fontFamily:"'Trebuchet MS', monospace" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#1a2d42")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >{item.label}</button>
              )
            )}
          </div>
        )}
      </div>
    );
  }
);
