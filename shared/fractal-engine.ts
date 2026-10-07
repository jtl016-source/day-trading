// shared/fractal-engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// FRACTAL-PROBABILITY ENGINE — mechanical implementations of the fractal concepts
// the user studied (Bill Williams / Investopedia / LuxAlgo / PrimeXBT / MondFX /
// StockManiacs / LightningChart):
//   1. Williams Fractal        — 5-bar pivot (configurable wings), STRICT comparison
//   2. Fractal breakout        — close beyond the most recent CONFIRMED opposing fractal
//   3. Fractal Chaos Bands     — stepped lines tracking the latest confirmed fractal
//                                high (upper) / low (lower); flat bands = CHOP
//   4. Fractal Chaos Oscillator— FCO = net close change / sum of absolute close
//                                changes over a window, range [-1, +1]
//
// PURE + STANDALONE: imports only shared/firing/types (types only). No DB, no DOM,
// no session/calendar logic — unit-testable on synthetic bars, safe in browser+Node.
//
// NO LOOKAHEAD, by construction: a fractal pivot at bar p needs WINGS strictly-lower
// highs (or strictly-higher lows) on EACH side, so it is only CONFIRMED once the bar
// at p + WINGS has CLOSED — it becomes usable WINGS bars late. Every per-bar output
// (bands, breakouts, chop, FCO) at bar i reads only bars <= i. Verified by a
// truncation test in shared/fractal-engine.test.ts.
//
// These outputs feed shared/fact-engine.ts as CORROBORATOR-ONLY facts (never
// drivers): they confirm signals the user's existing strategies produce, they do
// not fire on their own.
// ─────────────────────────────────────────────────────────────────────────────

import type { FiringCandle } from "./firing/types";

// ─────────────────────────── NAMED CONSTANTS ────────────────────────────────

export const FRACTAL_CONST = {
  /** Williams fractal wings: a pivot high needs this many STRICTLY lower highs on
   *  EACH side (ties = no pivot — same convention as the ICT engine's swings). */
  WINGS: 2,
  /** Fractal Chaos Oscillator window in CLOSES (5 closes = 4 close-to-close moves —
   *  matches the LightningChart worked example: [100,102,101,105,107] -> 7/9 ≈ 0.78). */
  FCO_WINDOW: 5,
  /** |FCO| at or above this = the tape is TRENDING in the sign's direction. */
  FCO_TREND_MIN: 0.6,
  /** |FCO| at or below this = CHOP (price going nowhere relative to its churn). */
  FCO_CHOP_MAX: 0.25,
  /** Chaos-band CHOP: BOTH bands moved less than this many points over the last
   *  FCB_FLAT_BARS bars (band "slope" ≈ 0) while the close is still INSIDE the bands. */
  FCB_FLAT_PTS: 0.5,
  FCB_FLAT_BARS: 10,
  /** fact-engine corroboration recency: a fractal breakout counts as an agreeing
   *  fact for this many bars after the breakout bar (inclusive of the bar itself). */
  BREAKOUT_RECENT_BARS: 5,
} as const;

export interface FractalSettings {
  WINGS: number;
  FCO_WINDOW: number;
  FCO_TREND_MIN: number;
  FCO_CHOP_MAX: number;
  FCB_FLAT_PTS: number;
  FCB_FLAT_BARS: number;
}
export const FRACTAL_DEFAULTS: FractalSettings = {
  WINGS: FRACTAL_CONST.WINGS,
  FCO_WINDOW: FRACTAL_CONST.FCO_WINDOW,
  FCO_TREND_MIN: FRACTAL_CONST.FCO_TREND_MIN,
  FCO_CHOP_MAX: FRACTAL_CONST.FCO_CHOP_MAX,
  FCB_FLAT_PTS: FRACTAL_CONST.FCB_FLAT_PTS,
  FCB_FLAT_BARS: FRACTAL_CONST.FCB_FLAT_BARS,
};

// ─────────────────────────────── TYPES ──────────────────────────────────────

export interface FractalPivot {
  /** Bar index of the pivot itself. */
  idx: number;
  time: number;
  /** The pivot price: bar high for an up-fractal, bar low for a down-fractal. */
  price: number;
  /** Bar index at whose CLOSE the pivot becomes knowable (= idx + WINGS).
   *  CRITICAL no-lookahead rule: nothing may consume the pivot before this bar. */
  confirmedIdx: number;
}

export interface FractalEvent {
  /** Bar index of the event (the bar whose CLOSE triggered it). */
  idx: number;
  direction: "Long" | "Short";
  /** The fractal level that was broken. */
  level: number;
}

export interface FractalSeries {
  /** Chaos-band upper line per bar: price of the most recent CONFIRMED up-fractal
   *  as of that bar's close (null until the first confirmation). Stepped. */
  upper: Array<number | null>;
  /** Chaos-band lower line per bar (most recent confirmed down-fractal low). */
  lower: Array<number | null>;
  /** Williams-fractal BREAKOUTS: close beyond the most recent confirmed opposing
   *  fractal level. The level is CONSUMED by its breakout — the next breakout in
   *  that direction needs a NEW confirmed fractal (Bill Williams' trigger). */
  breakouts: FractalEvent[];
  /** Chaos-BAND breaks: the close crossed outside a band this bar (transition —
   *  the previous bar's close was not outside its band). Bands are NOT consumed. */
  bandBreaks: FractalEvent[];
  /** CHOP state per bar: both bands flat (moved < FCB_FLAT_PTS over the last
   *  FCB_FLAT_BARS bars) AND the close still INSIDE the bands. A close outside a
   *  flat band is a breakout, not chop — chop requires price boxed in. */
  chopFCB: boolean[];
  /** Fractal Chaos Oscillator per bar (NaN until FCO_WINDOW closes exist). */
  fco: number[];
}

// ─────────────────────────────── DETECTORS ──────────────────────────────────

/** Williams fractals: STRICTLY higher high (up-fractal, at the bar's HIGH — acts as
 *  resistance / a short-side liquidity pool) or strictly lower low (down-fractal, at
 *  the LOW) than WINGS bars on each side. Returned in pivot-index order. */
export function findFractals(
  candles: FiringCandle[],
  wings: number = FRACTAL_DEFAULTS.WINGS,
): { up: FractalPivot[]; down: FractalPivot[] } {
  const up: FractalPivot[] = [];
  const down: FractalPivot[] = [];
  for (let p = wings; p < candles.length - wings; p++) {
    let isUp = true, isDown = true;
    for (let k = 1; k <= wings && (isUp || isDown); k++) {
      if (!(candles[p].high > candles[p - k].high && candles[p].high > candles[p + k].high)) isUp = false;
      if (!(candles[p].low < candles[p - k].low && candles[p].low < candles[p + k].low)) isDown = false;
    }
    if (isUp) up.push({ idx: p, time: candles[p].time, price: candles[p].high, confirmedIdx: p + wings });
    if (isDown) down.push({ idx: p, time: candles[p].time, price: candles[p].low, confirmedIdx: p + wings });
  }
  return { up, down };
}

/** Fractal Chaos Oscillator at close index i over `window` CLOSES:
 *     FCO = (close_i − close_{i−window+1}) / Σ |close_k − close_{k−1}|
 *  Net directional progress divided by total churn — range [−1, +1]. A dead-flat
 *  window (zero churn) returns 0 (no progress, no trend). NaN until warm. */
export function fcoAt(
  closes: number[],
  i: number,
  window: number = FRACTAL_DEFAULTS.FCO_WINDOW,
): number {
  const start = i - window + 1;
  if (start < 0 || i >= closes.length) return NaN;
  const net = closes[i] - closes[start];
  let churn = 0;
  for (let k = start + 1; k <= i; k++) churn += Math.abs(closes[k] - closes[k - 1]);
  return churn === 0 ? 0 : net / churn;
}

/** One forward pass producing every per-bar fractal output. All state at bar i is a
 *  function of bars <= i only (fractals apply at their confirmedIdx, never earlier). */
export function computeFractalSeries(
  candles: FiringCandle[],
  settings: Partial<FractalSettings> = {},
): FractalSeries {
  const s: FractalSettings = { ...FRACTAL_DEFAULTS, ...settings };
  const n = candles.length;
  const { up, down } = findFractals(candles, s.WINGS);
  const closes = candles.map(c => c.close);

  const upper: Array<number | null> = new Array(n).fill(null);
  const lower: Array<number | null> = new Array(n).fill(null);
  const breakouts: FractalEvent[] = [];
  const bandBreaks: FractalEvent[] = [];
  const chopFCB: boolean[] = new Array(n).fill(false);
  const fco: number[] = new Array(n).fill(NaN);

  let ui = 0, di = 0;                       // cursors into up/down pivot lists
  let bandUp: number | null = null;         // chaos bands (never consumed)
  let bandDown: number | null = null;
  let activeUp: number | null = null;       // breakout levels (consumed on break)
  let activeDown: number | null = null;

  for (let i = 0; i < n; i++) {
    // (a) fractals CONFIRMED at this bar (pivot p = i - WINGS) become usable NOW.
    while (ui < up.length && up[ui].confirmedIdx === i) { bandUp = up[ui].price; activeUp = up[ui].price; ui++; }
    while (di < down.length && down[di].confirmedIdx === i) { bandDown = down[di].price; activeDown = down[di].price; di++; }
    upper[i] = bandUp;
    lower[i] = bandDown;
    const close = closes[i];

    // (b) Williams breakout: close beyond the active opposing fractal level.
    //     The level is consumed — one trigger per fractal (Bill Williams' rule).
    if (activeUp != null && close > activeUp) { breakouts.push({ idx: i, direction: "Long", level: activeUp }); activeUp = null; }
    if (activeDown != null && close < activeDown) { breakouts.push({ idx: i, direction: "Short", level: activeDown }); activeDown = null; }

    // (c) Chaos-band break: TRANSITION of the close to outside a band (the previous
    //     bar's close was not outside its own band value). Bands are not consumed.
    if (i > 0) {
      const prevUp = upper[i - 1], prevDown = lower[i - 1];
      if (bandUp != null && close > bandUp && !(prevUp != null && closes[i - 1] > prevUp)) {
        bandBreaks.push({ idx: i, direction: "Long", level: bandUp });
      }
      if (bandDown != null && close < bandDown && !(prevDown != null && closes[i - 1] < prevDown)) {
        bandBreaks.push({ idx: i, direction: "Short", level: bandDown });
      }
    }

    // (d) CHOP: both bands essentially unmoved over the last FCB_FLAT_BARS bars AND
    //     the close boxed INSIDE them. A close outside a flat band is a breakout —
    //     it must not read as chop, so the inside test is part of the state.
    const j = i - s.FCB_FLAT_BARS;
    if (j >= 0 && bandUp != null && bandDown != null && upper[j] != null && lower[j] != null) {
      const flat = Math.abs(bandUp - (upper[j] as number)) <= s.FCB_FLAT_PTS
        && Math.abs(bandDown - (lower[j] as number)) <= s.FCB_FLAT_PTS;
      chopFCB[i] = flat && close <= bandUp && close >= bandDown;
    }

    // (e) Fractal Chaos Oscillator.
    fco[i] = fcoAt(closes, i, s.FCO_WINDOW);
  }

  return { upper, lower, breakouts, bandBreaks, chopFCB, fco };
}
