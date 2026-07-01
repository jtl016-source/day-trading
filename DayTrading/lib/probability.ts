// probability.ts — RN port of the MERIDIAN fractal "probability concept" math, used to feed
// the iPhone chart's display-only overlays (value area / fBm forecast cone / regime tint /
// target scaler). Faithful ports of client/src/lib/{hurst,ergodic,multifractal,fbm}.ts so the
// phone and PC compute the same numbers. DISPLAY ONLY — never gates a signal or auto-trade.

export type Regime = 'PERSISTENT' | 'NEUTRAL' | 'MEANREVERT' | 'UNKNOWN';
const PERSISTENT_TH = 0.55, MEANREVERT_TH = 0.45;

export interface Candle { time: number; open: number; high: number; low: number; close: number; }

function olsSlopeIntercept(x: number[], y: number[]): [number, number] {
  const n = x.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return [0, sy / n];
  const slope = (n * sxy - sx * sy) / denom;
  return [slope, (sy - slope * sx) / n];
}
const olsSlope = (x: number[], y: number[]) => olsSlopeIntercept(x, y)[0];

function dfaScales(n: number, minScale: number, maxScale: number, nScales: number, order: number): number[] {
  if (!maxScale || maxScale > Math.floor(n / 4)) maxScale = Math.max(minScale + 1, Math.floor(n / 4));
  if (maxScale <= minScale) return [];
  const a = Math.log10(minScale), b = Math.log10(maxScale);
  const seen = new Set<number>(); const out: number[] = [];
  for (let k = 0; k < nScales; k++) {
    const lin = a + (b - a) * (nScales === 1 ? 0 : k / (nScales - 1));
    const s = Math.floor(Math.pow(10, lin));
    if (s >= order + 2 && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.sort((p, q) => p - q);
}

export function dfaHurst(x: number[], minScale = 4, nScales = 12, order = 1): number {
  const data = x.filter((v) => Number.isFinite(v));
  const n = data.length;
  if (n < minScale * 4) return NaN;
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const Y = new Array<number>(n); let acc = 0;
  for (let i = 0; i < n; i++) { acc += data[i] - mean; Y[i] = acc; }
  const scales = dfaScales(n, minScale, 0, nScales, order);
  if (scales.length < 2) return NaN;
  const logS: number[] = [], logF: number[] = [];
  for (const s of scales) {
    const ns = Math.floor(n / s);
    if (ns < 1) continue;
    const t: number[] = []; for (let k = 0; k < s; k++) t.push(k);
    const ms: number[] = [];
    for (const start of [0, n - ns * s]) {
      for (let v = 0; v < ns; v++) {
        const seg = Y.slice(start + v * s, start + (v + 1) * s);
        const [slope, intercept] = olsSlopeIntercept(t, seg);
        let sse = 0; for (let k = 0; k < s; k++) { const r = seg[k] - (slope * t[k] + intercept); sse += r * r; }
        ms.push(sse / s);
      }
    }
    const f = Math.sqrt(ms.reduce((a, b) => a + b, 0) / ms.length);
    if (f > 0) { logS.push(Math.log(s)); logF.push(Math.log(f)); }
  }
  if (logS.length < 2) return NaN;
  return olsSlope(logS, logF);
}

export function regimeLabel(h: number): Regime {
  if (!Number.isFinite(h)) return 'UNKNOWN';
  if (h >= PERSISTENT_TH) return 'PERSISTENT';
  if (h <= MEANREVERT_TH) return 'MEANREVERT';
  return 'NEUTRAL';
}

export function hurstAtPriceIndex(closes: number[], idx: number, window = 100): number {
  const lo = idx - window;
  if (lo < 0) return NaN;
  const rets: number[] = [];
  for (let i = lo + 1; i <= idx; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  return dfaHurst(rets);
}

// ── MFDFA stress (Rank 3) ────────────────────────────────────────────────────
function olsDetrendVar(seg: number[]): number {
  const s = seg.length; const t: number[] = []; for (let k = 0; k < s; k++) t.push(k);
  const slope = olsSlope(t, seg);
  let mt = 0, my = 0; for (let k = 0; k < s; k++) { mt += t[k]; my += seg[k]; } mt /= s; my /= s;
  const intercept = my - slope * mt;
  let sse = 0; for (let k = 0; k < s; k++) { const r = seg[k] - (slope * t[k] + intercept); sse += r * r; }
  return sse / s;
}
function buildScales(n: number, minScale: number, nScales: number): number[] {
  let maxScale = Math.max(minScale + 1, Math.floor(n / 4));
  if (maxScale <= minScale) return [];
  const a = Math.log10(minScale), b = Math.log10(maxScale);
  const seen = new Set<number>(); const out: number[] = [];
  for (let k = 0; k < nScales; k++) {
    const lin = a + (b - a) * (nScales === 1 ? 0 : k / (nScales - 1));
    const s = Math.floor(Math.pow(10, lin));
    if (s >= 4 && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.sort((p, q) => p - q);
}
const QS = (() => { const a: number[] = []; for (let q = -5; q <= 5; q += 0.5) a.push(q); return a; })();

function mfdfaWidth(returns: number[], minScale = 8, nScales = 12): number | null {
  const data = returns.filter((v) => Number.isFinite(v));
  const n = data.length;
  if (n < minScale * 4) return null;
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const Y = new Array<number>(n); let acc = 0;
  for (let i = 0; i < n; i++) { acc += data[i] - mean; Y[i] = acc; }
  const scales = buildScales(n, minScale, nScales);
  if (scales.length < 3) return null;
  const usableScales: number[] = [], usableF2: number[][] = [];
  for (const s of scales) {
    const ns = Math.floor(n / s);
    if (ns < 1) continue;
    const vars: number[] = [];
    for (const start of [0, n - ns * s]) {
      for (let v = 0; v < ns; v++) {
        const fv = olsDetrendVar(Y.slice(start + v * s, start + (v + 1) * s));
        if (fv > 0) vars.push(fv);
      }
    }
    if (vars.length >= 2) { usableScales.push(s); usableF2.push(vars); }
  }
  if (usableScales.length < 3) return null;
  const logS = usableScales.map((s) => Math.log(s));
  const hq: number[] = [];
  for (const q of QS) {
    const logFq: number[] = [];
    for (let i = 0; i < usableScales.length; i++) {
      const vars = usableF2[i]; let Fq: number;
      if (Math.abs(q) < 1e-6) { let s = 0; for (const v of vars) s += Math.log(v); s /= vars.length; Fq = Math.exp(0.5 * s); }
      else { let s = 0; for (const v of vars) s += Math.pow(v, q / 2); s /= vars.length; Fq = Math.pow(s, 1 / q); }
      logFq.push(Math.log(Fq));
    }
    hq.push(olsSlope(logS, logFq));
  }
  const tau = QS.map((q, i) => q * hq[i] - 1);
  const alpha: number[] = [];
  for (let i = 0; i < QS.length; i++) {
    let a: number;
    if (i === 0) a = (tau[1] - tau[0]) / (QS[1] - QS[0]);
    else if (i === QS.length - 1) a = (tau[i] - tau[i - 1]) / (QS[i] - QS[i - 1]);
    else a = (tau[i + 1] - tau[i - 1]) / (QS[i + 1] - QS[i - 1]);
    alpha.push(a);
  }
  return Math.max(...alpha) - Math.min(...alpha);
}

function multifractalStress(closes: number[], window = 150): number {
  if (closes.length < window + 1) return 0.5;
  const toReturns = (lo: number, hi: number) => {
    const r: number[] = []; for (let i = lo + 1; i <= hi; i++) r.push(Math.log(closes[i] / closes[i - 1])); return r;
  };
  const last = closes.length - 1;
  const cur = mfdfaWidth(toReturns(last - window, last));
  if (cur == null) return 0.5;
  const widths: number[] = []; const STEP = Math.max(8, Math.floor(window / 6));
  for (let end = last; end - window >= 0 && widths.length < 24; end -= STEP) {
    const w = mfdfaWidth(toReturns(end - window, end)); if (w != null) widths.push(w);
  }
  if (widths.length < 4) return 0.5;
  return widths.filter((w) => w <= cur).length / widths.length;
}

// ── Value area (Rank 5) ──────────────────────────────────────────────────────
export interface ValueArea { poc: number; vah: number; val: number; }
export function longRunValueArea(candles: Candle[], lookback = 400, bins = 60): ValueArea | null {
  const n = candles.length;
  if (n < 30) return null;
  const slice = candles.slice(Math.max(0, n - lookback));
  let hi = -Infinity, lo = Infinity;
  for (const c of slice) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  if (!(hi > lo)) return null;
  const binW = (hi - lo) / bins;
  const hist = new Array<number>(bins).fill(0);
  for (const c of slice) {
    const b0 = Math.max(0, Math.floor((c.low - lo) / binW));
    const b1 = Math.min(bins - 1, Math.floor((c.high - lo) / binW));
    for (let b = b0; b <= b1; b++) hist[b] += 1;
  }
  const total = hist.reduce((a, b) => a + b, 0) || 1;
  const binMid = (b: number) => lo + (b + 0.5) * binW;
  let pocBin = 0; for (let b = 1; b < bins; b++) if (hist[b] > hist[pocBin]) pocBin = b;
  let loB = pocBin, hiB = pocBin, acc = hist[pocBin]; const target = 0.7 * total;
  while (acc < target && (loB > 0 || hiB < bins - 1)) {
    const down = loB > 0 ? hist[loB - 1] : -1, up = hiB < bins - 1 ? hist[hiB + 1] : -1;
    if (up >= down) { hiB++; acc += hist[hiB]; } else { loB--; acc += hist[loB]; }
  }
  return { poc: binMid(pocBin), vah: binMid(hiB), val: binMid(loB) };
}

// ── fBm path (Rank 4) ────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rng: () => number): number {
  let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function fbmPath(H: number, points = 64, seed = 12345): number[] {
  const levels = Math.ceil(Math.log2(Math.max(2, points - 1)));
  const N = Math.pow(2, levels);
  const x = new Array<number>(N + 1).fill(0);
  const rng = mulberry32(seed); let scale = 1; x[0] = 0; x[N] = gauss(rng); let stride = N;
  for (let lvl = 0; lvl < levels; lvl++) {
    const half = stride / 2; scale *= Math.pow(0.5, H);
    for (let i = half; i < N; i += stride) x[i] = (x[i - half] + x[i + half]) / 2 + scale * gauss(rng);
    for (let i = 0; i <= N; i += half) x[i] += scale * gauss(rng) * 0.5;
    stride = half;
  }
  const out: number[] = [];
  for (let i = 0; i < points; i++) out.push(x[Math.round((i / (points - 1)) * N)]);
  const min = Math.min(...out), max = Math.max(...out), rng2 = max - min || 1;
  return out.map((v) => (2 * (v - min)) / rng2 - 1);
}

// ── Combined compute for the chart overlays ──────────────────────────────────
export interface ProbFlags { valueArea: boolean; forecast: boolean; regime: boolean; scaler: boolean; }
export interface ProbPayload {
  valueArea: ValueArea | null;
  regimeStrip: Array<{ t: number; r: Regime }>;
  regimeNow: { regime: Regime; h: number; stress: number } | null;
  fbmPaths: Array<Array<{ t: number; p: number }>>;
  scaler: { tone: string; levels: Array<{ t: number; up: number; dn: number; horizon: number }> } | null;
}

export function computeProbabilityOverlays(candles: Candle[], ivSec: number, flags: ProbFlags): ProbPayload {
  const empty: ProbPayload = { valueArea: null, regimeStrip: [], regimeNow: null, fbmPaths: [], scaler: null };
  if (!candles.length) return empty;
  const closes = candles.map((c) => c.close);
  const lastBar = candles[candles.length - 1];
  const recentVol = (): number => {
    const r: number[] = [];
    for (let i = Math.max(1, closes.length - 50); i < closes.length; i++)
      if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
    if (!r.length) return 0.001;
    const mean = r.reduce((s, v) => s + v, 0) / r.length;
    return Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / r.length) || 0.001;
  };

  const out: ProbPayload = { ...empty };
  if (flags.valueArea) out.valueArea = longRunValueArea(candles, 400);

  const Hnow = closes.length > 101 ? hurstAtPriceIndex(closes, closes.length - 1, 100) : NaN;
  if (Number.isFinite(Hnow)) {
    const stress = flags.regime && closes.length > 151 ? multifractalStress(closes, 150) : 0.5;
    out.regimeNow = { regime: regimeLabel(Hnow), h: Hnow, stress };
  }

  if (flags.regime && closes.length > 120) {
    const step = Math.max(3, Math.floor((closes.length - 100) / 80));
    for (let i = 100; i < closes.length; i += step) {
      const h = hurstAtPriceIndex(closes, i, 100);
      if (Number.isFinite(h)) out.regimeStrip.push({ t: candles[i].time, r: regimeLabel(h) });
    }
  }

  const Hc = Math.min(0.85, Math.max(0.15, Hnow));
  if (flags.forecast && Number.isFinite(Hnow) && closes.length > 60) {
    const sd = recentVol(); const POINTS = 14; const amp = lastBar.close * sd * Math.pow(POINTS, Hc);
    for (let k = 0; k < 7; k++) {
      const raw = fbmPath(Hc, POINTS, 1009 + k * 97); const a0 = raw[0];
      const anchored = raw.map((v) => v - a0);
      const maxAbs = Math.max(1e-6, ...anchored.map((v) => Math.abs(v)));
      const pts: Array<{ t: number; p: number }> = [];
      for (let i = 0; i < POINTS; i++) pts.push({ t: lastBar.time + i * ivSec, p: lastBar.close + (anchored[i] / maxAbs) * amp });
      out.fbmPaths.push(pts);
    }
  }

  if (flags.scaler && Number.isFinite(Hnow) && closes.length > 60) {
    const sd = recentVol();
    const levels = [2, 4, 8, 12].map((hz) => {
      const reach = lastBar.close * sd * Math.pow(hz, Hc);
      return { t: lastBar.time + hz * ivSec, up: lastBar.close + reach, dn: lastBar.close - reach, horizon: hz };
    });
    out.scaler = { tone: Hnow <= 0.45 ? 'tight' : Hnow >= 0.55 ? 'wide' : 'neutral', levels };
  }
  return out;
}
