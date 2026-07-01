// multifractal.ts — Rank 3: MFDFA singularity-spectrum WIDTH risk gauge (DISPLAY ONLY).
//
// Multifractal Detrended Fluctuation Analysis. Computes the generalized Hurst exponent h(q)
// across a range of moments q, then the singularity spectrum f(α) via Legendre transform.
// The WIDTH Δα = α_max − α_min measures how "multifractal" (erratic / heterogeneous) recent
// price action is: a wide spectrum = many interleaved scaling behaviors = high stress = a
// market where size should be reduced. A narrow spectrum = near-monofractal = calmer.
//
// This is a RISK gauge, never a trade trigger. Closed bars only. Lightweight TS twin of the
// Python MFDFA module (scripts/regime_layer). Cheap enough for ~150-bar windows on demand.

export interface MfdfaResult {
  q: number[];
  hq: number[];      // generalized Hurst exponent per q
  alpha: number[];   // singularity strength α(q)
  falpha: number[];  // singularity spectrum f(α)
  width: number;     // Δα = max(α) − min(α)
  hMin: number;      // h(q) at most positive q (small fluctuations)
  hMax: number;      // h(q) at most negative q (large fluctuations)
}

export interface MfdfaOpts { qs?: number[]; minScale?: number; maxScale?: number; nScales?: number; order?: number; }

function olsSlope(x: number[], y: number[]): number {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

function olsDetrendVar(seg: number[], order: number): number {
  // order-1 (linear) detrend variance = SSE/s. (order kept for API symmetry; only 1 used.)
  const s = seg.length;
  const t: number[] = []; for (let k = 0; k < s; k++) t.push(k);
  const slope = olsSlope(t, seg);
  // intercept
  let mt = 0, my = 0; for (let k = 0; k < s; k++) { mt += t[k]; my += seg[k]; } mt /= s; my /= s;
  const intercept = my - slope * mt;
  let sse = 0; for (let k = 0; k < s; k++) { const r = seg[k] - (slope * t[k] + intercept); sse += r * r; }
  return sse / s;
}

function buildScales(n: number, minScale: number, maxScale: number, nScales: number): number[] {
  if (!maxScale || maxScale > Math.floor(n / 4)) maxScale = Math.max(minScale + 1, Math.floor(n / 4));
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

const DEFAULT_QS = (() => { const a: number[] = []; for (let q = -5; q <= 5; q += 0.5) a.push(q); return a; })();

/** MFDFA on a RETURNS series (pass log-returns, not prices). NaN-safe; returns null if too short. */
export function mfdfa(returns: number[], opts: MfdfaOpts = {}): MfdfaResult | null {
  const qs = opts.qs ?? DEFAULT_QS;
  const order = opts.order ?? 1;
  const minScale = opts.minScale ?? 8;
  const nScales = opts.nScales ?? 12;
  const data = returns.filter(v => Number.isFinite(v));
  const n = data.length;
  if (n < minScale * 4) return null;

  // Profile Y = cumulative sum of mean-centered series.
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const Y = new Array<number>(n); let acc = 0;
  for (let i = 0; i < n; i++) { acc += data[i] - mean; Y[i] = acc; }

  const scales = buildScales(n, minScale, opts.maxScale ?? 0, nScales);
  if (scales.length < 3) return null;

  // F2[scaleIndex] = array of per-segment squared fluctuations (variances).
  const F2perScale: number[][] = [];
  for (const s of scales) {
    const ns = Math.floor(n / s);
    if (ns < 1) continue;
    const vars: number[] = [];
    for (const start of [0, n - ns * s]) {       // forward + backward passes
      for (let v = 0; v < ns; v++) {
        const seg = Y.slice(start + v * s, start + (v + 1) * s);
        const fv = olsDetrendVar(seg, order);
        if (fv > 0) vars.push(fv);
      }
    }
    if (vars.length >= 2) F2perScale.push(vars);
    else F2perScale.push([]);
  }
  const usableScales: number[] = [];
  const usableF2: number[][] = [];
  for (let i = 0; i < scales.length; i++) if (F2perScale[i] && F2perScale[i].length >= 2) { usableScales.push(scales[i]); usableF2.push(F2perScale[i]); }
  if (usableScales.length < 3) return null;
  const logS = usableScales.map(s => Math.log(s));

  // h(q) for each q.
  const hq: number[] = [];
  for (const q of qs) {
    const logFq: number[] = [];
    for (let i = 0; i < usableScales.length; i++) {
      const vars = usableF2[i];
      let Fq: number;
      if (Math.abs(q) < 1e-6) {
        // q → 0 limit: logarithmic averaging.
        let s = 0; for (const v of vars) s += Math.log(v); s /= vars.length;
        Fq = Math.exp(0.5 * s);
      } else {
        let s = 0; for (const v of vars) s += Math.pow(v, q / 2); s /= vars.length;
        Fq = Math.pow(s, 1 / q);
      }
      logFq.push(Math.log(Fq));
    }
    hq.push(olsSlope(logS, logFq));
  }

  // Mass exponent τ(q) = q·h(q) − 1; α = dτ/dq; f(α) = q·α − τ.
  const tau = qs.map((q, i) => q * hq[i] - 1);
  const alpha: number[] = []; const falpha: number[] = [];
  for (let i = 0; i < qs.length; i++) {
    let a: number;
    if (i === 0) a = (tau[1] - tau[0]) / (qs[1] - qs[0]);
    else if (i === qs.length - 1) a = (tau[i] - tau[i - 1]) / (qs[i] - qs[i - 1]);
    else a = (tau[i + 1] - tau[i - 1]) / (qs[i + 1] - qs[i - 1]);
    alpha.push(a);
    falpha.push(qs[i] * a - tau[i]);
  }
  const width = Math.max(...alpha) - Math.min(...alpha);
  // h(q) decreases with q for multifractals: hMax at q<0 (large events), hMin at q>0 (small).
  const hMin = hq[hq.length - 1];
  const hMax = hq[0];
  return { q: qs, hq, alpha, falpha, width, hMin, hMax };
}

/** Δα of the latest window plus a percentile stress score vs trailing rolling windows. */
export function multifractalStress(closes: number[], window = 150, opts: MfdfaOpts = {}):
  { width: number; stress: number; spectrum: MfdfaResult } | null {
  if (closes.length < window + 1) return null;
  const toReturns = (lo: number, hi: number) => {
    const r: number[] = [];
    for (let i = lo + 1; i <= hi; i++) r.push(Math.log(closes[i] / closes[i - 1]));
    return r;
  };
  const last = closes.length - 1;
  const spectrum = mfdfa(toReturns(last - window, last), { ...opts });
  if (!spectrum) return null;

  // Stress = percentile of current Δα vs trailing rolling windows (a-priori, leakage-free).
  const widths: number[] = [];
  const STEP = Math.max(8, Math.floor(window / 6));
  for (let end = last; end - window >= 0 && widths.length < 24; end -= STEP) {
    const m = mfdfa(toReturns(end - window, end), { ...opts });
    if (m) widths.push(m.width);
  }
  let stress = 0.5;
  if (widths.length >= 4) {
    const below = widths.filter(w => w <= spectrum.width).length;
    stress = below / widths.length;
  }
  return { width: spectrum.width, stress, spectrum };
}
