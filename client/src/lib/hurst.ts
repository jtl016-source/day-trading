// 0.1 — Lightweight DFA-Hurst for the LIVE Node/TS matcher (Rank 1 core).
//
// NOT WIRED INTO ANYTHING YET. This is the future live twin of
// scripts/regime_layer/hurst_dfa.py and must agree with it within numerical tolerance
// (see scripts/regime_layer/parity_check.ts). It is a regime FILTER, never a trade trigger.
//
// A rolling Hurst is BACKWARD-LOOKING: effective lag ~= half the window. Never treat an H
// crossing as an entry — it confirms a regime that already began. Closed bars only.
//
// Regime thresholds are A-PRIORI (do not fit to data):
//   H >= 0.55 -> PERSISTENT | 0.45<H<0.55 -> NEUTRAL | H <= 0.45 -> MEANREVERT

export const PERSISTENT_TH = 0.55;
export const MEANREVERT_TH = 0.45;
export type Regime = "PERSISTENT" | "NEUTRAL" | "MEANREVERT" | "UNKNOWN";

// Win-rate and profit-factor stats measured on 6,916 real safe 15m MES signals (2024-2026).
// Source: scripts/regime_layer/reports/REPORT.md
// MEANREVERT+aligned (trade direction agrees with recent trend): 47.6% win, PF 1.97
export const REGIME_WIN_PROB: Record<Regime, number | null> = {
  PERSISTENT:  39.1,
  NEUTRAL:     41.4,
  MEANREVERT:  44.9,
  UNKNOWN:     null,
};
export const REGIME_PF: Record<Regime, number | null> = {
  PERSISTENT:  1.53,
  NEUTRAL:     1.57,
  MEANREVERT:  1.75,
  UNKNOWN:     null,
};

export interface DfaOpts { minScale?: number; maxScale?: number; nScales?: number; order?: number; }

// Ordinary least squares slope+intercept of y on x.
function olsSlopeIntercept(x: number[], y: number[]): [number, number] {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return [0, sy / n];
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return [slope, intercept];
}

function dfaScales(n: number, minScale: number, maxScale: number, nScales: number, order: number): number[] {
  if (!maxScale || maxScale > Math.floor(n / 4)) maxScale = Math.max(minScale + 1, Math.floor(n / 4));
  if (maxScale <= minScale) return [];
  const a = Math.log10(minScale), b = Math.log10(maxScale);
  const seen = new Set<number>();
  const out: number[] = [];
  for (let k = 0; k < nScales; k++) {
    const lin = a + (b - a) * (nScales === 1 ? 0 : k / (nScales - 1));
    const s = Math.floor(Math.pow(10, lin));
    if (s >= order + 2 && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  out.sort((p, q) => p - q);
  return out;
}

/** h(q=2) DFA exponent of series x (pass RETURNS, not prices). NaN if insufficient data. */
export function dfaHurst(x: number[], opts: DfaOpts = {}): number {
  const minScale = opts.minScale ?? 4;
  const nScales = opts.nScales ?? 12;
  const order = opts.order ?? 1; // linear detrend
  const data = x.filter((v) => Number.isFinite(v));
  const n = data.length;
  if (n < minScale * 4) return NaN;
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const Y = new Array<number>(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += data[i] - mean; Y[i] = acc; }

  const scales = dfaScales(n, minScale, opts.maxScale ?? 0, nScales, order);
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
        // order-1 detrend (linear least squares); matches numpy polyfit(order=1)
        const [slope, intercept] = olsSlopeIntercept(t, seg);
        let sse = 0;
        for (let k = 0; k < s; k++) { const r = seg[k] - (slope * t[k] + intercept); sse += r * r; }
        ms.push(sse / s);
      }
    }
    const f = Math.sqrt(ms.reduce((a, b) => a + b, 0) / ms.length);
    if (f > 0) { logS.push(Math.log(s)); logF.push(Math.log(f)); }
  }
  if (logS.length < 2) return NaN;
  return olsSlopeIntercept(logS, logF)[0];
}

export function regimeLabel(h: number): Regime {
  if (!Number.isFinite(h)) return "UNKNOWN";
  if (h >= PERSISTENT_TH) return "PERSISTENT";
  if (h <= MEANREVERT_TH) return "MEANREVERT";
  return "NEUTRAL";
}

/** DFA-Hurst of log-returns ending AT closed-bar idx (inclusive). No future bars used. */
export function hurstAtPriceIndex(closes: number[], idx: number, window = 100, opts: DfaOpts = {}): number {
  const lo = idx - window; // window+1 closes -> window returns
  if (lo < 0) return NaN;
  const rets: number[] = [];
  for (let i = lo + 1; i <= idx; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  return dfaHurst(rets, opts);
}
