// probability.ts — the MERIDIAN fractal "probability concept" snapshot for the web terminal.
//
// This is the single read-model the Probability panel + Info tab consume. It wraps the
// individual fractal libs (hurst / ergodic / multifractal / hurstScaler) into ONE typed
// snapshot computed from the visible candles. DISPLAY ONLY — it never gates a signal or an
// auto-trade (the fractal layer is a regime FILTER / macro context, never a trigger; see the
// header notes in each underlying lib). The iPhone app computes the same numbers via
// DayTrading/lib/probability.ts — keep the two in agreement if either changes.

import { hurstAtPriceIndex, regimeLabel, REGIME_WIN_PROB, REGIME_PF, type Regime } from "@/lib/hurst";
import { longRunValueArea, valueAreaVerdict, type ValueArea } from "@/lib/ergodic";
import { multifractalStress } from "@/lib/multifractal";
import { scalerVerdict, scalerLadder } from "@/lib/hurstScaler";

export interface ProbCandle { time: number; o: number; h: number; l: number; c: number; }

export interface ProbProjection {
  sd: number; // recent per-bar log-return stdev
  levels: Array<{ horizon: number; up: number; dn: number }>; // Hurst-scaled expected range
}

export interface ProbabilitySnapshot {
  ready: boolean;             // false when there isn't enough history to compute H
  price: number;
  H: number | null;           // DFA-Hurst of recent log-returns
  regime: Regime;             // PERSISTENT / NEUTRAL / MEANREVERT / UNKNOWN
  winProb: number | null;     // historical win-rate for this regime (REGIME_WIN_PROB)
  pf: number | null;          // historical profit-factor for this regime (REGIME_PF)
  stress: number | null;      // multifractal stress percentile (0..1; higher = more turbulent than usual)
  valueArea: ValueArea | null;
  vaVerdict: { label: string; tone: "high" | "mid" | "low" } | null;
  scaler: { label: string; detail: string; tone: "tight" | "neutral" | "wide" } | null;
  scalerLadder: Array<{ horizon: number; mult: number }>;
  projection: ProbProjection | null;
  regimeStrip: Array<{ time: number; regime: Regime }>; // sampled regime over time (for the on-chart ribbon)
}

const EMPTY: ProbabilitySnapshot = {
  ready: false, price: 0, H: null, regime: "UNKNOWN", winProb: null, pf: null,
  stress: null, valueArea: null, vaVerdict: null, scaler: null, scalerLadder: [], projection: null,
  regimeStrip: [],
};

/** Stdev of the last `n` log-returns — recent realized per-bar volatility. */
function recentVol(closes: number[], n = 50): number {
  const r: number[] = [];
  for (let i = Math.max(1, closes.length - n); i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (!r.length) return 0.001;
  const mean = r.reduce((s, v) => s + v, 0) / r.length;
  return Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / r.length) || 0.001;
}

/**
 * Compute the probability snapshot from the (closed) candles currently loaded.
 * `ivSec` is unused for the numbers themselves but kept in the signature so callers pass the
 * chart interval (a future forecast-cone overlay needs it to place future-time points).
 */
export function computeProbabilitySnapshot(candles: ProbCandle[], _ivSec: number): ProbabilitySnapshot {
  if (!candles || candles.length < 30) return { ...EMPTY };
  const closes = candles.map((c) => c.c);
  const last = candles[candles.length - 1];
  const price = last.c;

  // Hurst needs window+1 closes (default window 100).
  const H = closes.length > 101 ? hurstAtPriceIndex(closes, closes.length - 1, 100) : NaN;
  if (!Number.isFinite(H)) {
    // Still surface the value area (it only needs ~30 bars) even without a Hurst read.
    const va = longRunValueArea(candles.map((c) => ({ h: c.h, l: c.l, c: c.c })));
    return {
      ...EMPTY, price,
      valueArea: va,
      vaVerdict: va ? valueAreaVerdict(va, price) : null,
    };
  }

  const regime = regimeLabel(H);
  const va = longRunValueArea(candles.map((c) => ({ h: c.h, l: c.l, c: c.c })));
  const ms = closes.length > 151 ? multifractalStress(closes, 150) : null;

  // Sampled regime over time → drives the on-chart regime ribbon. ~80 samples max so the
  // 80×DFA cost stays bounded; only recomputed when the bar set changes (caller memoizes).
  const regimeStrip: Array<{ time: number; regime: Regime }> = [];
  if (closes.length > 120) {
    const step = Math.max(3, Math.floor((closes.length - 100) / 80));
    for (let i = 100; i < closes.length; i += step) {
      const h = hurstAtPriceIndex(closes, i, 100);
      if (Number.isFinite(h)) regimeStrip.push({ time: candles[i].time, regime: regimeLabel(h) });
    }
  }

  // Hurst-scaled expected-range band: reach(τ) = price · σ · τ^H (fBm range scaling, not √τ).
  // Clamp H to a sane band so a degenerate estimate can't explode the projection.
  const Hc = Math.min(0.85, Math.max(0.15, H));
  const sd = recentVol(closes);
  const projection: ProbProjection = {
    sd,
    levels: [4, 8, 12].map((hz) => {
      const reach = price * sd * Math.pow(hz, Hc);
      return { horizon: hz, up: price + reach, dn: price - reach };
    }),
  };

  return {
    ready: true,
    price,
    H,
    regime,
    winProb: REGIME_WIN_PROB[regime],
    pf: REGIME_PF[regime],
    stress: ms ? ms.stress : null,
    valueArea: va,
    vaVerdict: va ? valueAreaVerdict(va, price) : null,
    scaler: scalerVerdict(H),
    scalerLadder: scalerLadder(H, [2, 4, 8, 12]),
    projection,
    regimeStrip,
  };
}
