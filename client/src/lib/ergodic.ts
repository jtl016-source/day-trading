// ergodic.ts — Rank 5: long-run value-area / ergodicity panel (READ-ONLY MACRO PANEL).
//
// EXPLICITLY out of scope as a trade filter (per the MERIDIAN spec). It exists only as a
// read-only macro context panel: where does the current price sit within its long-run
// distribution? The ergodicity idea: a single price path's TIME-average (what one trader
// actually experiences) need not equal the ENSEMBLE-average of all possible paths — so knowing
// where price sits in its realized long-run value area is context, never a signal.
//
// Builds a price histogram over a long lookback, finds the POC (most-traded price), the 70%
// value area (VAH/VAL), the median, and the current price's percentile within the realized range.

export interface ValueArea {
  poc: number;        // point of control (modal price)
  vah: number;        // value-area high (top of 70% band)
  val: number;        // value-area low (bottom of 70% band)
  median: number;
  hi: number;         // long-run high
  lo: number;         // long-run low
  pricePct: number;   // current price percentile within [lo, hi]  (0..1)
  inValueArea: boolean;
  bars: number;
}

export interface Candle { h: number; l: number; c: number; }

/**
 * Long-run value area over the last `lookback` closed bars. Each bar contributes its H..L range
 * spread across histogram bins (a volume-less TPO/market-profile approximation).
 */
export function longRunValueArea(candles: Candle[], lookback = 500, bins = 60): ValueArea | null {
  const n = candles.length;
  if (n < 30) return null;
  const slice = candles.slice(Math.max(0, n - lookback));
  let hi = -Infinity, lo = Infinity;
  for (const c of slice) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; }
  if (!(hi > lo)) return null;

  const binW = (hi - lo) / bins;
  const hist = new Array<number>(bins).fill(0);
  for (const c of slice) {
    const b0 = Math.max(0, Math.floor((c.l - lo) / binW));
    const b1 = Math.min(bins - 1, Math.floor((c.h - lo) / binW));
    for (let b = b0; b <= b1; b++) hist[b] += 1; // each bar adds 1 TPO to every price bin it spans
  }
  const total = hist.reduce((a, b) => a + b, 0) || 1;
  const binMid = (b: number) => lo + (b + 0.5) * binW;

  // POC = modal bin.
  let pocBin = 0; for (let b = 1; b < bins; b++) if (hist[b] > hist[pocBin]) pocBin = b;
  const poc = binMid(pocBin);

  // 70% value area: expand out from POC, always taking the heavier adjacent bin.
  let loB = pocBin, hiB = pocBin, acc = hist[pocBin];
  const target = 0.7 * total;
  while (acc < target && (loB > 0 || hiB < bins - 1)) {
    const down = loB > 0 ? hist[loB - 1] : -1;
    const up = hiB < bins - 1 ? hist[hiB + 1] : -1;
    if (up >= down) { hiB++; acc += hist[hiB]; } else { loB--; acc += hist[loB]; }
  }
  const vah = binMid(hiB), val = binMid(loB);

  // Median price by TPO mass.
  let cum = 0, medianBin = pocBin;
  for (let b = 0; b < bins; b++) { cum += hist[b]; if (cum >= total / 2) { medianBin = b; break; } }
  const median = binMid(medianBin);

  const cur = slice[slice.length - 1].c;
  const pricePct = Math.min(1, Math.max(0, (cur - lo) / (hi - lo)));
  return { poc, vah, val, median, hi, lo, pricePct, inValueArea: cur >= val && cur <= vah, bars: slice.length };
}

/** Plain-English read of where price sits in its long-run value area. */
export function valueAreaVerdict(va: ValueArea, price: number): { label: string; tone: "high" | "mid" | "low" } {
  if (price > va.vah) return { label: "ABOVE VALUE — extended high; mean-reversion risk", tone: "high" };
  if (price < va.val) return { label: "BELOW VALUE — extended low; mean-reversion risk", tone: "low" };
  return { label: "INSIDE VALUE — balanced / fair price", tone: "mid" };
}
