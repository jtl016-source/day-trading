// shared/fractal-engine.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Offline unit harness for the fractal engine. NO test framework — plain asserts,
// run with:  npx tsx shared/fractal-engine.test.ts   (exit 0 = all pass)
//
// Covers:
//   • Williams fractal detection (strict comparison, ties rejected, wings config)
//   • CRITICAL no-lookahead: pivot at p confirmed only at p+WINGS (truncation test)
//   • Fractal breakout events (close beyond the level; level CONSUMED per break)
//   • Chaos bands (stepped values, band-break transitions fire once)
//   • CHOP state (flat bands + close inside; a band break negates chop)
//   • FCO — including the LightningChart worked example [100,102,101,105,107] → 7/9
// ─────────────────────────────────────────────────────────────────────────────
import {
  findFractals, computeFractalSeries, fcoAt, FRACTAL_DEFAULTS, FRACTAL_CONST,
} from "./fractal-engine";
import type { FiringCandle } from "./firing/types";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

const T0 = 1_750_000_000;
const M5 = 300;
function C(i: number, open: number, high: number, low: number, close: number): FiringCandle {
  return { time: T0 + i * M5, open, high, low, close, volume: 100 };
}
/** Quiet bar: tight body around `px`, high px+0.5, low px-0.5. */
const Q = (i: number, px: number): FiringCandle => C(i, px - 0.1, px + 0.5, px - 0.5, px + 0.1);

// ═════════════════════════════════════════════════════════════════════════════
console.log("── findFractals: Williams pivots, strict, configurable wings ──");
{
  // Up-fractal at idx 3 (high 105 vs 101.5/102.5 left, 102.5/101.5 right).
  const bars = [
    Q(0, 101), Q(1, 101), C(2, 101, 102.5, 100.5, 101.5),
    C(3, 102, 105, 101.5, 103),                      // pivot high 105
    C(4, 102, 102.5, 101, 101.5), Q(5, 101), Q(6, 101),
  ];
  const { up, down } = findFractals(bars, 2);
  assert(up.length === 1 && up[0].idx === 3 && up[0].price === 105, "up-fractal detected at the pivot high");
  assert(up[0].confirmedIdx === 5, "up-fractal confirmed exactly WINGS(2) bars after the pivot");
  assert(down.length === 0, "no down-fractal in an up-pivot-only fixture");
}
{
  // TIE on one wing: equal highs at idx 3 and idx 4 → NO fractal (strict comparison).
  const bars = [
    Q(0, 101), Q(1, 101), Q(2, 101),
    C(3, 102, 105, 101.5, 103),
    C(4, 102, 105, 101, 101.5),                       // equal high — kills strictness
    Q(5, 101), Q(6, 101),
  ];
  assert(findFractals(bars, 2).up.length === 0, "equal highs (tie) reject the pivot — strict comparison");
}
{
  // Down-fractal at idx 3 (low 95 vs neighbors ~100.5).
  const bars = [Q(0, 101), Q(1, 101), Q(2, 101), C(3, 100, 100.6, 95, 99.5), Q(4, 101), Q(5, 101), Q(6, 101)];
  const { down } = findFractals(bars, 2);
  assert(down.length === 1 && down[0].idx === 3 && down[0].price === 95 && down[0].confirmedIdx === 5,
    "down-fractal detected at the pivot low, confirmed 2 bars late");
}
{
  // Wings config: with wings=3 the same 2-wing pivot needs a 3rd lower bar each side.
  const bars = [
    Q(0, 101), Q(1, 101), Q(2, 101),
    C(3, 102, 105, 101.5, 103),
    Q(4, 101), Q(5, 101), C(6, 105.5, 106, 104, 105.5), // higher high 3 bars right — kills wings=3
  ];
  assert(findFractals(bars, 2).up.length === 1, "wings=2 sees the pivot");
  assert(findFractals(bars, 3).up.length === 0, "wings=3 requires 3 clear bars each side (config respected)");
}

console.log("── NO-LOOKAHEAD: truncation test (the critical rule) ──");
{
  // Pivot at idx 5; feed the array truncated to END at the pivot+1 → the fractal must
  // NOT exist yet; truncated at pivot+2 (its confirmation bar) → it exists. Then the
  // whole per-bar series must be PREFIX-STABLE: computing on a prefix gives the same
  // values as the same indices of the full run (nothing at bar i reads past i).
  const bars = [
    Q(0, 101), Q(1, 101), Q(2, 101), Q(3, 101), Q(4, 101),
    C(5, 102, 105, 101.5, 103),                        // pivot high 105
    Q(6, 101), Q(7, 101), Q(8, 101), Q(9, 101),
    C(10, 103, 106.5, 102.5, 106),                     // breaks above 105
    Q(11, 106), Q(12, 106),
  ];
  const upTo6 = findFractals(bars.slice(0, 7), 2).up;   // bars 0..6 — pivot+1 closed
  const upTo7 = findFractals(bars.slice(0, 8), 2).up;   // bars 0..7 — pivot+2 closed
  assert(upTo6.length === 0, "TRUNCATION: fractal NOT usable one bar after the pivot (2nd wing bar not closed)");
  assert(upTo7.length === 1 && upTo7[0].idx === 5, "TRUNCATION: fractal appears exactly when the 2nd bar past the pivot closes");

  const full = computeFractalSeries(bars);
  for (const cut of [7, 9, 11]) {
    const part = computeFractalSeries(bars.slice(0, cut));
    let stable = true;
    for (let i = 0; i < cut; i++) {
      if (part.upper[i] !== full.upper[i] || part.lower[i] !== full.lower[i]
        || part.chopFCB[i] !== full.chopFCB[i]
        || !(Number.isNaN(part.fco[i]) && Number.isNaN(full.fco[i]) || part.fco[i] === full.fco[i])) stable = false;
    }
    const evKey = (e: { idx: number; direction: string; level: number }) => `${e.idx}|${e.direction}|${e.level}`;
    if (part.breakouts.map(evKey).join(",") !== full.breakouts.filter(e => e.idx < cut).map(evKey).join(",")) stable = false;
    if (part.bandBreaks.map(evKey).join(",") !== full.bandBreaks.filter(e => e.idx < cut).map(evKey).join(",")) stable = false;
    assert(stable, `TRUNCATION: full-run prefix identical to a run truncated at bar ${cut} (no lookahead anywhere)`);
  }
  assert(full.upper[6] === null && full.upper[7] === 105, "band takes the fractal value AT its confirmation bar, not before");
}

console.log("── breakouts + chaos bands ──");
{
  const bars = [
    Q(0, 101), Q(1, 101), Q(2, 101), Q(3, 101), Q(4, 101),
    C(5, 102, 105, 101.5, 103),                        // up pivot 105 (confirmed at 7)
    Q(6, 101), Q(7, 101), Q(8, 101), Q(9, 101),
    C(10, 103, 106.5, 102.5, 106),                     // close 106 > 105 → breakout + band break
    Q(11, 106), Q(12, 106), Q(13, 106),
  ];
  const s = computeFractalSeries(bars);
  assert(s.breakouts.length === 1 && s.breakouts[0].idx === 10 && s.breakouts[0].direction === "Long" && s.breakouts[0].level === 105,
    "close above the confirmed up-fractal = ONE bullish breakout at that bar");
  assert(s.bandBreaks.some(e => e.idx === 10 && e.direction === "Long"), "the same close crosses the upper band → band-break event");
  assert(s.bandBreaks.filter(e => e.direction === "Long").length === 1, "band-break is a TRANSITION — bars 11+ above the band fire nothing new");
  assert(s.breakouts.filter(e => e.idx > 10).length === 0, "breakout level CONSUMED — no second breakout without a new fractal");
  assert(s.upper[10] === 105 && s.upper[13] === 105, "band value persists (stepped) after the break — bands are never consumed");
}
{
  // Short side: down pivot then close below it.
  const bars = [
    Q(0, 101), Q(1, 101), Q(2, 101), Q(3, 101), Q(4, 101),
    C(5, 100, 100.6, 95, 99.5),                        // down pivot 95 (confirmed at 7)
    Q(6, 99), Q(7, 99), Q(8, 99),
    C(9, 98, 98.5, 93.5, 94),                          // close 94 < 95 → bearish breakout
    Q(10, 94),
  ];
  const s = computeFractalSeries(bars);
  assert(s.breakouts.length === 1 && s.breakouts[0].idx === 9 && s.breakouts[0].direction === "Short" && s.breakouts[0].level === 95,
    "close below the confirmed down-fractal = bearish breakout");
}

console.log("── CHOP state (flat bands, close inside) ──");
{
  // Range: up pivot 105 at idx 5, down pivot 95 at idx 8, then a long flat stretch
  // inside 95..105 → chop turns true once both bands are ≥ FCB_FLAT_BARS old.
  const bars: FiringCandle[] = [
    Q(0, 101), Q(1, 101), Q(2, 101), Q(3, 101), Q(4, 101),
    C(5, 102, 105, 101.5, 103),                        // up pivot 105 (confirmed 7)
    Q(6, 101), Q(7, 101),
    C(8, 100, 100.6, 95, 99.5),                        // down pivot 95 (confirmed 10)
    Q(9, 100),
  ];
  for (let i = 10; i <= 24; i++) bars.push(Q(i, 100)); // boxed inside the bands
  const s = computeFractalSeries(bars);
  assert(s.chopFCB[9] === false, "chop needs BOTH bands at least FCB_FLAT_BARS old");
  assert(s.chopFCB[22] === true, "flat bands + close inside = CHOP");
  // A close OUTSIDE the flat band must not read as chop.
  const burst = [...bars.slice(0, 23), C(23, 100, 106.5, 99.9, 106), Q(24, 106)];
  const s2 = computeFractalSeries(burst);
  assert(s2.chopFCB[22] === true && s2.chopFCB[23] === false, "a close outside a flat band is a BREAKOUT, not chop");
  // Bands that MOVED by more than FCB_FLAT_PTS within the window are not flat.
  const shifted: FiringCandle[] = [...bars.slice(0, 15),
    C(15, 102, 107.5, 101.5, 103), // new up pivot 107.5 (confirmed 17) — band jumps 2.5 pts
    Q(16, 103), Q(17, 103)];
  for (let i = 18; i <= 24; i++) shifted.push(Q(i, 103));
  const s3 = computeFractalSeries(shifted);
  assert(s3.chopFCB[24] === false, "a band that jumped > FCB_FLAT_PTS within the window is NOT flat (no chop)");
}

console.log("── FCO: Fractal Chaos Oscillator ──");
{
  // THE WORKED EXAMPLE (LightningChart): closes [100,102,101,105,107]
  //   net = 107-100 = 7; churn = |2|+|−1|+|4|+|2| = 9; FCO = 7/9 ≈ 0.7778.
  const closes = [100, 102, 101, 105, 107];
  const v = fcoAt(closes, 4, 5);
  assert(Math.abs(v - 7 / 9) < 1e-12, `FCO worked example: [100,102,101,105,107] -> 7/9 (got ${v})`);
  assert(v >= FRACTAL_DEFAULTS.FCO_TREND_MIN, "worked example reads as TRENDING (≥ FCO_TREND_MIN 0.6), direction = sign(+)");

  assert(Number.isNaN(fcoAt(closes, 3, 5)), "FCO is NaN until a full window of closes exists");
  assert(fcoAt([100, 100, 100, 100, 100], 4, 5) === 0, "dead-flat window (zero churn) reads 0, not NaN/Infinity");

  // Chop: heavy churn, no net progress. [100,102,99,103,100.5]: net 0.5, churn 2+3+4+2.5=11.5 → 0.043.
  const chop = fcoAt([100, 102, 99, 103, 100.5], 4, 5);
  assert(Math.abs(chop) <= FRACTAL_DEFAULTS.FCO_CHOP_MAX, `churn without progress reads as CHOP (|FCO| ≤ 0.25, got ${chop.toFixed(3)})`);

  // Perfect one-way move reads exactly ±1.
  assert(fcoAt([100, 101, 102, 103, 104], 4, 5) === 1, "monotone rise reads exactly +1");
  assert(fcoAt([104, 103, 102, 101, 100], 4, 5) === -1, "monotone fall reads exactly -1");

  // Window is configurable: same series, window 3.
  const w3 = fcoAt([100, 102, 101], 2, 3);
  assert(Math.abs(w3 - 1 / 3) < 1e-12, "FCO window configurable (n=3: net 1 / churn 3)");

  // computeFractalSeries carries the same values per bar.
  const bars = [C(0, 100, 100.5, 99.5, 100), C(1, 100, 102.5, 99.9, 102), C(2, 102, 102.2, 100.8, 101),
    C(3, 101, 105.2, 100.9, 105), C(4, 105, 107.3, 104.8, 107)];
  const s = computeFractalSeries(bars);
  assert(Math.abs(s.fco[4] - 7 / 9) < 1e-12, "series FCO matches fcoAt on the same closes");
}

console.log("── constants sanity ──");
{
  assert(FRACTAL_CONST.WINGS === 2 && FRACTAL_CONST.FCO_WINDOW === 5, "default wings=2, FCO window=5 (the studied definitions)");
  assert(FRACTAL_CONST.FCO_TREND_MIN === 0.6 && FRACTAL_CONST.FCO_CHOP_MAX === 0.25, "trend/chop thresholds as specified");
  assert(FRACTAL_CONST.BREAKOUT_RECENT_BARS === 5, "fact-engine breakout recency window = 5 bars");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
