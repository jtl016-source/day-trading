// shared/firing/vector.ts
// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL vector math + zone bull/bear classifier — extracted VERBATIM from
// market.tsx. `computeVectorLine` is the O(n) monotonic-deque implementation of
// Highest(Lowest(low, VEC_LENGTH), VEC_LENGTH). Pure; no framework deps.
//
// STATUS: extraction slice 1 (foundation). Faithful copy — no behavior change.
// (There are 5+ copies of computeVectorLine across the client today; this is the
// designated single source of truth going forward.)
// ─────────────────────────────────────────────────────────────────────────────
import { VEC_LENGTH } from "./constants";
import type { FiringCandle, FiringZone, VectorPoint } from "./types";

/** Highest(Lowest(low, VEC_LENGTH), VEC_LENGTH) over ALL bars (RTH + ETH),
 *  matching ThinkorSwim vectorexitstrat behaviour. */
export function computeVectorLine(candles: FiringCandle[]): VectorPoint[] {
  if (!candles.length) return [];
  const s = [...candles].sort((a, b) => a.time - b.time);
  const n = s.length;
  const lb = new Float64Array(n);

  // Pass 1: Lowest(low, VEC_LENGTH) via monotonic min-deque
  const dq1 = new Int32Array(n);
  let d1f = 0, d1b = 0;
  for (let i = 0; i < n; i++) {
    while (d1f < d1b && dq1[d1f] <= i - VEC_LENGTH) d1f++;
    while (d1f < d1b && s[dq1[d1b - 1]].low >= s[i].low) d1b--;
    dq1[d1b++] = i;
    lb[i] = s[dq1[d1f]].low;
  }

  // Pass 2: Highest(LowerBand, VEC_LENGTH) via monotonic max-deque
  const result: VectorPoint[] = new Array(n);
  const dq2 = new Int32Array(n);
  let d2f = 0, d2b = 0;
  for (let i = 0; i < n; i++) {
    while (d2f < d2b && dq2[d2f] <= i - VEC_LENGTH) d2f++;
    while (d2f < d2b && lb[dq2[d2b - 1]] <= lb[i]) d2b--;
    dq2[d2b++] = i;
    result[i] = { time: s[i].time, value: lb[dq2[d2f]] };
  }
  return result;
}

/** Map form for O(1) time→vector lookups. */
export function computeVectorLineMap(candles: FiringCandle[]): Map<number, number> {
  return new Map(computeVectorLine(candles).map(v => [v.time, v.value]));
}

/** Label-aware bull/bear zone classifier — VERBATIM from allConfluenceSignals
 *  (market.tsx:2555). Label text is primary; hex/rgba color is the fallback.
 *  Bear keywords take priority over bull. */
export function classifyZoneBullish(z: FiringZone): boolean {
  if (z.label) {
    const l = z.label.toLowerCase();
    if (/sell|resist|bear|supply|absorb\s*buy|cap\s*session|ceiling|non.fair|iv.wall|iv.overflow|pivot(?!.*floor)|gex.wall.short|wall.short|short.median/i.test(l)) return false;
    if (/buy|demand|support|bull|absorb\s*sell|floor|gex.wall.long|wall.long|long.median|spy.floor|ovn.spy.floor/i.test(l)) return true;
  }
  const c = z.color.toLowerCase().trim();
  if (c === "#22c55e" || c === "#3b82f6" || c === "#14b8a6") return true;
  const m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) { const r = +m[1], g = +m[2], b = +m[3]; return g > r || (b > r && b > g); }
  return false;
}

/** Simpler color-only bull classifier — VERBATIM from computeBgSignals
 *  (market.tsx:414). Kept distinct: the background scanner intentionally ignores
 *  label text. Do NOT merge with classifyZoneBullish — they differ by design. */
export function classifyZoneBullishColorOnly(z: FiringZone): boolean {
  const c = z.color.toLowerCase().trim();
  if (c === "#22c55e" || c === "#3b82f6" || c === "#14b8a6") return true;
  const m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) { const r = +m[1], g = +m[2], b = +m[3]; return g > r || (b > r && b > g); }
  return false;
}
