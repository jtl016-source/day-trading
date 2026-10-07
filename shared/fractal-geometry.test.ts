// shared/fractal-geometry.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Offline unit harness for the Fractal-Exchange-guide corroborators. NO test
// framework — plain asserts, run with:
//   npx tsx shared/fractal-geometry.test.ts   (exit 0 = all pass)
//
// Covers:
//   • RECLAIM (counter-trend reversal / Ghost / SideExitC / TableTopB) both sides,
//     rejection when the false break exceeds RECLAIM_MAX_BREAK bars
//   • FLAT-BOUNCE (SideExitB / TableTopA): flat gate, touch tolerance, body direction
//   • VECTOR CHASE divergence state (contradiction direction semantics)
//   • WAVE TAPE MEASURE: room vs exhausted vs neutral against prior wave extents,
//     silent until WAVE_MIN_SAMPLE completed same-direction waves
//   • COMPRESSION release: >=3 ascending pivot lows + range break, bearish mirror
//   • PRIOR-CLOSE (E/S VECTOR) day tracking: eVec = prior final close, sVec = prior
//     16:00 ET close; cross events (position-not-cross on the day's first reading)
//   • CRITICAL no-lookahead: full-run vs truncated-run prefixes byte-identical
// ─────────────────────────────────────────────────────────────────────────────
import { computeFractalGeometrySeries, FG_CONST } from "./fractal-geometry";
import type { FiringCandle } from "./firing/types";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

const M5 = 300;
// 2026-07-08 is an EDT Wednesday: 09:30 ET = 13:30 UTC. Fixture days are built from
// explicit UTC epochs so the ET day/16:00 logic is exercised for real.
const DAY1_0930 = Math.floor(Date.parse("2026-07-08T13:30:00Z") / 1000);

function C(i: number, open: number, high: number, low: number, close: number, t0 = DAY1_0930): FiringCandle {
  return { time: t0 + i * M5, open, high, low, close, volume: 100 };
}
/** Quiet bar hugging px. */
const Q = (i: number, px: number, t0 = DAY1_0930): FiringCandle => C(i, px - 0.1, px + 0.5, px - 0.5, px + 0.1, t0);
const flatVec = (n: number, v: number): (number | null)[] => new Array(n).fill(v);

// ═════════════════════════════════════════════════════════════════════════════
console.log("── RECLAIM: false break then body close back across the vector ──");
{
  // vector 100; above → 2 closes below → bullish body closes back above ⇒ reclaim +1
  const bars = [Q(0, 101), Q(1, 101), C(2, 100.5, 100.6, 98.5, 99), C(3, 99, 99.5, 98, 98.6), C(4, 98.8, 101.6, 98.6, 101.2)];
  const s = computeFractalGeometrySeries(bars, flatVec(5, 100), M5);
  assert(s.reclaim[4] === 1, "long reclaim fires on the bullish close back above the vector");
  assert(s.reclaim[3] === 0 && s.reclaim[2] === 0, "no reclaim while still below the vector");
}
{
  // Bearish mirror: below → 2 closes above → bearish body closes back below ⇒ -1
  const bars = [Q(0, 99), Q(1, 99), C(2, 99.5, 101.5, 99.4, 101), C(3, 101, 101.8, 100.6, 100.8), C(4, 101, 101.2, 98.4, 98.8)];
  const s = computeFractalGeometrySeries(bars, flatVec(5, 100), M5);
  assert(s.reclaim[4] === -1, "short reclaim fires on the bearish close back below the vector");
}
{
  // False break LONGER than RECLAIM_MAX_BREAK bars ⇒ no reclaim (that's a real breakdown).
  const n = FG_CONST.RECLAIM_MAX_BREAK + 3;
  const bars: FiringCandle[] = [Q(0, 101)];
  for (let i = 1; i <= FG_CONST.RECLAIM_MAX_BREAK + 1; i++) bars.push(C(i, 99, 99.4, 98, 98.8));
  bars.push(C(n - 1, 99, 101.5, 98.9, 101.2));
  const s = computeFractalGeometrySeries(bars, flatVec(n, 100), M5);
  assert(s.reclaim[n - 1] === 0, `no reclaim after ${FG_CONST.RECLAIM_MAX_BREAK + 1} bars below (beyond the SideExitC window)`);
}
{
  // Doji (close == open) close back above ⇒ no reclaim — the guide demands a green candle.
  const bars = [Q(0, 101), C(1, 99, 99.4, 98, 98.8), C(2, 101.2, 101.6, 98.9, 101.2)];
  const s = computeFractalGeometrySeries(bars, flatVec(3, 100), M5);
  assert(s.reclaim[2] === 0, "reclaim requires a directional body (doji rejected)");
}

console.log("── FLAT-BOUNCE: flat vector + touch + directional body ──");
{
  const n = FG_CONST.FLAT_LOOKBACK + 2;
  const bars: FiringCandle[] = [];
  for (let i = 0; i < n - 1; i++) bars.push(Q(i, 103));
  bars.push(C(n - 1, 102, 103.5, 100.8, 103.2)); // dips to 100.8 (within 2.0 of 100), closes 103.2 bullish
  const s = computeFractalGeometrySeries(bars, flatVec(n, 100), M5);
  assert(s.flatBounce[n - 1] === 1, "long flat-bounce: dip into the flat vector, bullish close away");
}
{
  // Vector NOT flat (drifts 3 pts over the lookback) ⇒ no bounce fact.
  const n = FG_CONST.FLAT_LOOKBACK + 2;
  const bars: FiringCandle[] = [];
  for (let i = 0; i < n - 1; i++) bars.push(Q(i, 103));
  bars.push(C(n - 1, 102, 103.5, 100.8, 103.2));
  const vec = bars.map((_, i) => 100 + i * (3 / n));
  const s = computeFractalGeometrySeries(bars, vec, M5);
  assert(s.flatBounce[n - 1] === 0, "no flat-bounce while the vector is still adjusting (not flat)");
}
{
  // Touch too far away (low stops 3 pts above the vector) ⇒ no bounce.
  const n = FG_CONST.FLAT_LOOKBACK + 2;
  const bars: FiringCandle[] = [];
  for (let i = 0; i < n - 1; i++) bars.push(Q(i, 105));
  bars.push(C(n - 1, 104, 105.5, 103.0, 105.2));
  const s = computeFractalGeometrySeries(bars, flatVec(n, 100), M5);
  assert(s.flatBounce[n - 1] === 0, "no flat-bounce without an actual touch of the vector");
}

console.log("── VECTOR CHASE: divergence between vector adjustment and price ──");
{
  // Vector rises 2 pts over CHASE_BARS while price falls 6 ⇒ chase +1 (price expected back UP).
  const n = FG_CONST.CHASE_BARS + 1;
  const bars: FiringCandle[] = [];
  for (let i = 0; i < n; i++) { const px = 106 - (6 * i) / (n - 1); bars.push(C(i, px + 0.2, px + 0.6, px - 0.6, px)); }
  const vec = bars.map((_, i) => 100 + (2 * i) / (n - 1));
  const s = computeFractalGeometrySeries(bars, vec, M5);
  assert(s.chase[n - 1] === 1, "chase +1: vector adjusting up while price falls (contradicts shorts)");
}
{
  // Aligned move (both up) ⇒ no chase.
  const n = FG_CONST.CHASE_BARS + 1;
  const bars: FiringCandle[] = [];
  for (let i = 0; i < n; i++) { const px = 101 + (6 * i) / (n - 1); bars.push(C(i, px - 0.2, px + 0.6, px - 0.6, px)); }
  const vec = bars.map((_, i) => 100 + (2 * i) / (n - 1));
  const s = computeFractalGeometrySeries(bars, vec, M5);
  assert(s.chase[n - 1] === 0, "no chase when vector and price move together");
}

console.log("── WAVE TAPE MEASURE: room / exhausted vs prior wave extents ──");
{
  // vector 100. Build 4 completed UP waves with extents ~4,5,6,7 (highs 104..107, each
  // ended by a close below 100), then a current up wave. Extent < median ⇒ room.
  const bars: FiringCandle[] = [];
  let i = 0;
  const wave = (hi: number): void => {
    bars.push(C(i++, 100.5, 100.8, 100.2, 100.6)); // cross above (base = 100)
    bars.push(C(i++, 100.8, hi, 100.5, hi - 0.3)); // extreme
    bars.push(C(i++, 100.4, 100.6, 99.0, 99.4));   // close below → wave completes
  };
  wave(104); wave(105); wave(106); wave(107);
  bars.push(C(i++, 100.4, 100.9, 100.2, 100.7));   // new up wave, extent ~0.9 < median
  const idxRoom = i - 1;
  bars.push(C(i++, 100.8, 112, 100.6, 111));       // blow-off: extent 12 ≥ p80 ⇒ exhausted
  const idxExh = i - 1;
  const s = computeFractalGeometrySeries(bars, flatVec(bars.length, 100), M5);
  assert(s.tape[idxRoom]?.state === "room" && s.tape[idxRoom]?.dir === 1, "small fresh up-wave reads room-to-run");
  assert(s.tape[idxExh]?.state === "exhausted", "12-pt up-wave beyond p80 of {4,5,6,7} reads exhausted");
  assert(s.tape[8] == null, "tape silent before WAVE_MIN_SAMPLE completed same-direction waves");
}

console.log("── COMPRESSION: shallowing pullbacks then range break ──");
{
  // Ascending pivot lows at 96, 97.5, 98.5 hugging under a 101 ceiling, then a body close over it.
  const bars: FiringCandle[] = [];
  let i = 0;
  const leg = (lo: number): void => {
    bars.push(C(i++, 100.2, 100.9, 99.8, 100.4));
    bars.push(C(i++, 100.2, 100.6, lo, lo + 0.4));      // pivot low candidate
    bars.push(C(i++, lo + 0.4, 100.8, lo + 0.2, 100.5));
  };
  // pad so i >= COMPRESS_SCAN_BARS at the break bar
  while (i < FG_CONST.COMPRESS_SCAN_BARS) bars.push(Q(i++, 100));
  leg(96); leg(97.5); leg(98.5);
  bars.push(C(i++, 100.4, 102.4, 100.2, 102.1));        // breaks the 10-bar high with a bullish body
  const idxBk = i - 1;
  const s = computeFractalGeometrySeries(bars, flatVec(bars.length, 95), M5);
  assert(s.compression[idxBk] === 1, "bullish compression release on the range break");
}
{
  // Descending pivot highs then breakdown ⇒ -1.
  const bars: FiringCandle[] = [];
  let i = 0;
  const leg = (hi: number): void => {
    bars.push(C(i++, 99.8, 100.2, 99.1, 99.6));
    bars.push(C(i++, 99.8, hi, 99.4, hi - 0.4));        // pivot high candidate
    bars.push(C(i++, hi - 0.4, hi - 0.2, 99.2, 99.5));
  };
  while (i < FG_CONST.COMPRESS_SCAN_BARS) bars.push(Q(i++, 100));
  leg(104); leg(102.5); leg(101.5);
  bars.push(C(i++, 99.6, 99.8, 97.6, 97.9));            // breaks the 10-bar low with a bearish body
  const idxBk = i - 1;
  const s = computeFractalGeometrySeries(bars, flatVec(bars.length, 105), M5);
  assert(s.compression[idxBk] === -1, "bearish compression release on the range breakdown");
}

console.log("── PRIOR-CLOSE (E/S) day tracking + cross events ──");
{
  // Day 1 (2026-07-08): bars until 16:00 ET close=100 exactly at 16:00, then 16:00→17:00
  // drift up to 102 (the final close). Day 2 (2026-07-09): expect eVec=102, sVec=100.
  const bars: FiringCandle[] = [];
  // Day 1: 09:30..16:00 ET — 78 5m bars; close time of bar k = 13:30Z + (k+1)*5m.
  // Bar with close time exactly 20:00Z (16:00 ET) is k=77.
  for (let k = 0; k <= 77; k++) bars.push(C(k, 100.2, 100.6, 99.6, 100));
  // 16:00→17:00 ET: 12 bars drifting to 102 (final close of the day).
  for (let k = 78; k <= 89; k++) bars.push(C(k, 101, 102.4, 100.8, 102));
  // Day 2 (starts 09:30 ET next day): inside the band, then cross above.
  const D2 = Math.floor(Date.parse("2026-07-09T13:30:00Z") / 1000);
  bars.push(C(0, 101, 101.4, 100.6, 101, D2));   // inside [100,102] — position, no event
  bars.push(C(1, 101, 101.6, 100.8, 101.2, D2)); // still inside
  bars.push(C(2, 101.4, 103, 101.2, 102.8, D2)); // closes above BOTH ⇒ cross +1
  bars.push(C(3, 102.8, 103.4, 102.2, 103.1, D2)); // stays above — no repeat event
  const s = computeFractalGeometrySeries(bars, flatVec(bars.length, 90), M5);
  const d2base = 90;
  assert(s.eVec[d2base] === 102 && s.sVec[d2base] === 100, "day 2 carries eVec=prior final close, sVec=prior 16:00 close");
  assert(s.priorCloseCross[d2base] === 0 && s.priorCloseCross[d2base + 1] === 0, "inside-the-band bars emit no cross");
  assert(s.priorCloseCross[d2base + 2] === 1, "close beyond BOTH prior closes fires the cross event");
  assert(s.priorCloseCross[d2base + 3] === 0, "staying beyond does not re-fire (event, not state)");
  assert(s.eVec[10] == null && s.sVec[10] == null, "day 1 has no prior-day closes committed (warmup)");
}
{
  // First reading of the day ALREADY above both ⇒ position, not a cross.
  const bars: FiringCandle[] = [];
  for (let k = 0; k <= 77; k++) bars.push(C(k, 100.2, 100.6, 99.6, 100));
  for (let k = 78; k <= 89; k++) bars.push(C(k, 101, 102.4, 100.8, 102));
  const D2 = Math.floor(Date.parse("2026-07-09T13:30:00Z") / 1000);
  bars.push(C(0, 103, 103.6, 102.6, 103.2, D2)); // gap open above both
  bars.push(C(1, 103.2, 103.8, 102.8, 103.5, D2));
  const s = computeFractalGeometrySeries(bars, flatVec(bars.length, 90), M5);
  assert(s.priorCloseCross[90] === 0 && s.priorCloseCross[91] === 0, "gap open beyond both closes is a POSITION, not a cross");
}

console.log("── CRITICAL: no lookahead (truncation test) ──");
{
  // Deterministic pseudo-random walk across two ET days; every truncated run must agree
  // with the full run on the shared prefix for EVERY series.
  const bars: FiringCandle[] = [];
  let px = 100, seed = 42;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 240; i++) {
    const o = px, d = (rnd() - 0.5) * 3;
    px = Math.max(90, Math.min(115, px + d));
    bars.push(C(i, o, Math.max(o, px) + rnd(), Math.min(o, px) - rnd(), px));
  }
  const vec = bars.map((_, i) => (i < 20 ? null : 98 + Math.sin(i / 25) * 3));
  const full = computeFractalGeometrySeries(bars, vec, M5);
  let clean = true;
  for (const cut of [60, 120, 200]) {
    const part = computeFractalGeometrySeries(bars.slice(0, cut), vec.slice(0, cut), M5);
    for (let i = 0; i < cut; i++) {
      if (part.reclaim[i] !== full.reclaim[i] || part.flatBounce[i] !== full.flatBounce[i]
        || part.compression[i] !== full.compression[i] || part.chase[i] !== full.chase[i]
        || part.priorCloseCross[i] !== full.priorCloseCross[i]
        || (part.tape[i]?.state ?? "-") !== (full.tape[i]?.state ?? "-")
        || part.eVec[i] !== full.eVec[i] || part.sVec[i] !== full.sVec[i]) { clean = false; break; }
    }
  }
  assert(clean, "truncated runs byte-identical on shared prefixes (no lookahead anywhere)");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error("FAILURES:", failures); process.exit(1); }
