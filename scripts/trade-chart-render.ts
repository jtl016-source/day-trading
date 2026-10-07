// scripts/trade-chart-render.ts
// ─────────────────────────────────────────────────────────────────────────────
// Per-trade chart PNG renderer (app/terminal-styled, pure JS raster) — a GENERIC
// adaptation of `renderTradePng` in scripts/fact-engine-backtest.ts. Copied, not
// imported: that script executes its whole run at module load and cannot be
// imported (the same copy-don't-import rule as scripts/png-canvas.ts, see
// LEARNINGS). fact-engine-backtest.ts is deliberately untouched.
//
// Additions over the original: a SIGNAL marker at the setup bar (ICT limit trades
// fill bars later), and labeled ICT STRUCTURE overlays — order-block / breaker /
// mitigation zones, FVG gap bands, the OTE retracement zone, and swept-level
// lines — supplied by the caller as generic zones/lines.
//
// All x-mapping is BAR-INDEX based within the window (the terminal-chart lesson:
// never linear-time extrapolation across session gaps).
// ─────────────────────────────────────────────────────────────────────────────

import { Raster, encodePNG, textWidth, type RGB } from "./png-canvas";
import { etParts } from "../shared/yellowbox-core";
import { isRTH } from "../shared/firing/session";
import type { FiringCandle } from "../shared/firing/types";

const TCOL = {
  bg: [5, 8, 13] as RGB,          // terminal theme
  up: [38, 166, 154] as RGB,      // #26a69a
  dn: [239, 83, 80] as RGB,       // #ef5350
  upDim: [22, 88, 82] as RGB,     // dim ETH variants
  dnDim: [124, 46, 44] as RGB,
  text: [200, 205, 215] as RGB,
  dim: [120, 128, 140] as RGB,
  grid: [36, 42, 52] as RGB,
  entry: [235, 235, 235] as RGB,
  tp: [16, 185, 129] as RGB,
  sl: [244, 63, 94] as RGB,
  gold: [245, 217, 10] as RGB,
  rth: [96, 165, 250] as RGB,
  zoneGold: [245, 217, 10] as RGB,
  zoneBlue: [96, 165, 250] as RGB,
  zonePurple: [167, 139, 250] as RGB,
};

/** A shaded structure rectangle (order block, FVG band, OTE zone…). */
export interface ChartZone {
  top: number;
  bottom: number;
  /** Bar OPEN time where the structure was born (rectangle starts there). */
  fromTs: number;
  color: "gold" | "blue" | "purple";
  label: string;
}
/** A dashed horizontal marker line (e.g. the swept liquidity level). */
export interface ChartLine {
  price: number;
  label: string;
}

export interface TradeChartInput {
  /** Full candle array of the trade's interval (window is sliced internally). */
  candles: FiringCandle[];
  /** candles.map(c => c.time) — passed in so callers can reuse one array. */
  ivTimes: number[];
  barSec: number;
  interval: string;
  direction: "Long" | "Short";
  /** Signal (setup) bar OPEN time — the window anchor + SIGNAL marker. */
  fireTs: number;
  /** Fill moment (entry). For market entries this is the signal bar's close. */
  entryTs: number;
  exitTs: number | null;
  entry: number;
  tp1: number;
  tp2: number;
  sl: number;
  exitPrice: number | null;
  pointsResult: number | null;
  dateET: string;
  timeET: string;
  /** e.g. "ICT ORDER BLOCK — UNICORN". */
  titleType: string;
  /** e.g. "WIN AT TARGET 2". */
  outcomeText: string;
  why: string;
  zones?: ChartZone[];
  lines?: ChartLine[];
}

function asOfIndex(times: number[], t: number): number {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

function drawArrowSimple(r: Raster, x: number, y: number, up: boolean, col: RGB): void {
  for (let k = 0; k < 5; k++) {
    const w = k;
    const yy = up ? y + k : y - k;
    r.hLine(x - w, x + w, yy, col, 1);
  }
}

const zoneRgb = (c: ChartZone["color"]): RGB =>
  c === "gold" ? TCOL.zoneGold : c === "blue" ? TCOL.zoneBlue : TCOL.zonePurple;

/** Render one 800×450 trade chart PNG. Window: ~70 bars before the SIGNAL bar →
 *  ~40 bars after the exit bar (clamped to data). */
export function renderTradeChart(inp: TradeChartInput): Buffer {
  const W = 800, H = 450;
  const r = new Raster(W, H, TCOL.bg);
  const { candles, ivTimes, barSec } = inp;

  let iFire = asOfIndex(ivTimes, inp.fireTs);
  if (iFire < 0) iFire = 0;
  let iFill = asOfIndex(ivTimes, inp.entryTs);
  if (iFill < iFire) iFill = iFire;
  const iExit = inp.exitTs != null ? Math.max(iFill, asOfIndex(ivTimes, inp.exitTs)) : iFill;
  const i0 = Math.max(0, iFire - 70);
  const i1 = Math.min(candles.length - 1, iExit + 40);
  const win = candles.slice(i0, i1 + 1);

  // Price range: window extremes + every trade level + structure edges (all visible).
  let lo = Infinity, hi = -Infinity;
  for (const c of win) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
  for (const v of [inp.entry, inp.tp1, inp.tp2, inp.sl]) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const z of inp.zones ?? []) { lo = Math.min(lo, z.bottom); hi = Math.max(hi, z.top); }
  for (const ln of inp.lines ?? []) { lo = Math.min(lo, ln.price); hi = Math.max(hi, ln.price); }
  if (!isFinite(lo) || hi <= lo) { lo = inp.entry - 10; hi = inp.entry + 10; }
  const padP = (hi - lo) * 0.05; lo -= padP; hi += padP;

  const x0 = 10, x1 = 736, y0 = 44, y1 = 384;
  const n = Math.max(1, win.length);
  const xw = (x1 - x0) / n;
  const xOf = (i: number): number => Math.round(x0 + (i + 0.5) * xw);
  const py = (p: number): number => y1 - ((p - lo) / (hi - lo)) * (y1 - y0);
  const pyC = (p: number): number => Math.max(y0, Math.min(y1, py(p)));

  // Grid + price labels (right).
  for (let g = 0; g <= 5; g++) {
    const p = lo + ((hi - lo) * g) / 5;
    const y = Math.round(py(p));
    r.hLine(x0, x1, y, TCOL.grid, 1, 3, 5);
    r.text(x1 + 6, y - 3, p.toFixed(1), TCOL.dim, 1);
  }

  // ICT structure zones (shaded rectangles from birth bar through the exit, labeled).
  const zoneEndIdx = Math.min(win.length - 1, iExit - i0 + 5);
  for (const z of inp.zones ?? []) {
    let zi = asOfIndex(ivTimes, z.fromTs) - i0;
    if (zi < 0) zi = 0;
    if (zi > win.length - 1) continue;
    const zx0 = xOf(zi) - Math.floor(xw / 2);
    const zx1 = xOf(zoneEndIdx) + Math.floor(xw / 2);
    const col = zoneRgb(z.color);
    const yT = pyC(z.top), yB = pyC(z.bottom);
    if (yB > yT) r.fillRect(zx0, yT, Math.max(2, zx1 - zx0), yB - yT, col, 0.13);
    if (py(z.top) >= y0 && py(z.top) <= y1) r.hLine(zx0, zx1, Math.round(py(z.top)), col, 0.6);
    if (py(z.bottom) >= y0 && py(z.bottom) <= y1) r.hLine(zx0, zx1, Math.round(py(z.bottom)), col, 0.6);
    r.text(Math.max(x0 + 2, zx0 + 2), Math.max(y0 + 2, Math.min(y1 - 8, yT + 2)), z.label, col, 1, 0.9);
  }

  // Swept-level / marker lines (dashed gold, labeled).
  for (const ln of inp.lines ?? []) {
    const y = Math.round(py(ln.price));
    if (y < y0 - 8 || y > y1 + 8) continue;
    r.hLine(x0, x1, y, TCOL.gold, 0.8, 6, 4);
    r.text(x1 - textWidth(ln.label) - 4, y - 9, ln.label, TCOL.gold, 1, 0.9);
  }

  // RTH-open markers (ETH→RTH transition at bar CLOSE, matching the engine's session-at-close).
  for (let k = 1; k < win.length; k++) {
    if (isRTH(win[k].time + barSec) && !isRTH(win[k - 1].time + barSec)) {
      const x = xOf(k);
      r.vLine(x, y0, y1, TCOL.rth, 0.45, 4, 4);
      r.text(x + 3, y0 + 2, "RTH", TCOL.rth, 1, 0.8);
    }
  }

  // Candles — ETH bars use the dim variants (terminal convention).
  for (let k = 0; k < win.length; k++) {
    const c = win[k];
    const rth = isRTH(c.time + barSec);
    const col = c.close >= c.open ? (rth ? TCOL.up : TCOL.upDim) : (rth ? TCOL.dn : TCOL.dnDim);
    const cx = xOf(k);
    r.vLine(cx, Math.round(py(c.high)), Math.round(py(c.low)), col, 0.95);
    const bTop = py(Math.max(c.open, c.close)), bBot = py(Math.min(c.open, c.close));
    const bw = Math.max(1, Math.floor(xw) - 2);
    r.fillRect(cx - Math.floor(bw / 2), bTop, bw, Math.max(1, bBot - bTop), col);
  }

  // Trade levels: solid entry, dashed TP1/TP2/SL — full width with left tags.
  const level = (p: number, col: RGB, tag: string, dash: number): void => {
    const y = Math.round(py(p));
    if (y < y0 - 8 || y > y1 + 8) return;
    r.hLine(x0, x1, y, col, 0.9, dash, dash ? 3 : 0);
    r.text(x0 + 4, y - 9, `${tag} ${p.toFixed(2)}`, col, 1, 0.9);
  };
  level(inp.tp2, TCOL.tp, "TP2", 2);
  level(inp.tp1, TCOL.tp, "TP1", 5);
  level(inp.sl, TCOL.sl, "SL", 5);
  level(inp.entry, TCOL.entry, "ENTRY", 0);

  // SIGNAL marker at the setup bar (limit trades fill later — show both moments).
  {
    const xS = xOf(iFire - i0);
    r.vLine(xS, y0, y1, TCOL.dim, 0.55, 3, 5);
    r.text(Math.min(xS + 3, x1 - 40), y1 - 10, "SIGNAL", TCOL.dim, 1, 0.9);
  }

  // Entry arrow at the FILL bar + exit marker.
  const xE = xOf(iFill - i0);
  const yE = Math.round(py(inp.entry));
  drawArrowSimple(r, xE, inp.direction === "Long" ? yE + 7 : yE - 7, inp.direction === "Long", inp.direction === "Long" ? TCOL.tp : TCOL.sl);
  if (inp.exitTs != null && inp.exitPrice != null && iExit >= i0) {
    const xX = xOf(Math.min(win.length - 1, iExit - i0));
    const yX = Math.round(py(inp.exitPrice));
    for (let d = -4; d <= 4; d++) { r.set(xX + d, yX + d, TCOL.entry, 1); r.set(xX + d, yX - d, TCOL.entry, 1); }
    const pnl = inp.pointsResult == null ? "" : `${inp.pointsResult >= 0 ? "+" : ""}${inp.pointsResult.toFixed(2)}`;
    r.text(Math.min(xX + 8, x1 - 60), Math.max(y0 + 2, Math.min(y1 - 8, yX - 12)), `EXIT ${pnl}`, TCOL.entry, 1, 0.9);
  }

  // Title (two lines) + date labels + footer (WHY IT FIRED).
  const pnlStr = inp.pointsResult == null ? "OPEN" : `${inp.pointsResult >= 0 ? "+" : ""}${inp.pointsResult.toFixed(2)} PTS`;
  r.text(10, 6, `${inp.dateET} ${inp.timeET} ET  ${inp.interval.toUpperCase()}  ${inp.direction.toUpperCase()}  ${pnlStr}`, TCOL.text, 2);
  r.text(10, 28, `${inp.titleType.toUpperCase()}  |  ${inp.outcomeText}`, TCOL.dim, 1);
  for (let g = 0; g <= 3; g++) {
    const i = Math.min(win.length - 1, Math.round(((win.length - 1) * g) / 3));
    if (i < 0) continue;
    const p = etParts(win[i].time);
    const lbl = `${String(p.mo).padStart(2, "0")}/${String(p.d).padStart(2, "0")} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
    const x = Math.max(x0, Math.min(x1 - textWidth(lbl), xOf(i) - Math.floor(textWidth(lbl) / 2)));
    r.text(x, y1 + 6, lbl, TCOL.dim, 1);
  }
  const why = `WHY: ${inp.why}`.toUpperCase();
  const line1 = why.slice(0, 128);
  const line2 = why.length > 128 ? why.slice(128, 253) + (why.length > 253 ? "…" : "") : "";
  r.text(10, 404, line1, TCOL.dim, 1);
  if (line2) r.text(10, 415, line2, TCOL.dim, 1);
  return encodePNG(r);
}
