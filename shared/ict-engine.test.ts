// shared/ict-engine.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Offline unit harness for the ICT engine. NO test framework — plain asserts,
// run with:  npx tsx shared/ict-engine.test.ts   (exit 0 = all pass)
//
// Covers, on synthetic fixtures with hand-computed expectations:
//   S1  findSwings fractal pivots (strict, N each side)
//   S2  rollingMedianPrev windows
//   OB1 high-probability order block (sweep + structure shift) — exact levels
//   OB2 the same fixture is NOT a mitigation block (mutually exclusive)
//   MI1 mitigation block when the sweep is missing — exact levels
//   MS1 MSS + OTE entry at the 62% retracement of the sweep→displacement leg
//   FV1 fair value gap — entry at the shallower 50%, invalidation at the deeper
//   CE1 wick-reversal — entry at the wick's 50%, stop beyond the extreme
//   SW1 turtle soup, same-candle close-back on a caller level — range targets
//   SW2 turtle soup, NEXT-candle close-back (sweep extreme spans both bars)
//   BR1 breaker after a failed high-probability OB — flip direction levels
//   BR2 breaker flagged as Unicorn when an overlapping FVG exists
//   CD1 cooldown: setups within COOLDOWN_BARS are suppressed, later ones fire
//   NL1/NL2 NO LOOKAHEAD: truncating future bars never changes earlier setups
// ─────────────────────────────────────────────────────────────────────────────
import {
  runIctEngine, findSwings, rollingMedianPrev, ICT_CONST,
  type IctSetup, type LiquidityLevel,
} from "./ict-engine";
import type { FiringCandle } from "./firing/types";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}
const approx = (a: number | undefined, b: number, tol = 0.011): boolean =>
  a !== undefined && Math.abs(a - b) <= tol;

const M5 = 300;
const T0 = 1_700_000_000; // arbitrary epoch anchor; engine is calendar-agnostic
const t = (i: number): number => T0 + i * M5;
function C(i: number, o: number, h: number, l: number, c: number): FiringCandle {
  return { time: t(i), open: o, high: h, low: l, close: c, volume: 100 };
}
/** 25 warmup bars oscillating around 100: body 0.6, range 1.0, equal highs/lows (no pivots). */
function warmup(): FiringCandle[] {
  const out: FiringCandle[] = [];
  for (let i = 0; i < 25; i++) {
    out.push(i % 2 === 0 ? C(i, 100, 100.8, 99.8, 100.6) : C(i, 100.6, 100.8, 99.8, 100));
  }
  return out;
}
function run(candles: FiringCandle[], strategies?: Parameters<typeof runIctEngine>[0]["strategies"], levels?: LiquidityLevel[]): IctSetup[] {
  return runIctEngine({ candles, interval: "5m", barSec: M5, strategies, levels });
}

// ═══ S1/S2: primitives ═══════════════════════════════════════════════════════
console.log("── primitives ──");
{
  const bars = [C(0, 10, 11, 9, 10), C(1, 10, 12, 9.5, 11), C(2, 11, 15, 10.5, 14), C(3, 14, 13.5, 12, 13), C(4, 13, 12.8, 8, 9), C(5, 9, 10, 8.5, 9.5), C(6, 9.5, 11, 9, 10.5)];
  const { highs, lows } = findSwings(bars, 2);
  assert(highs.length === 1 && highs[0].idx === 2 && highs[0].price === 15, "S1a pivot high at the strict 2-side fractal");
  assert(lows.length === 1 && lows[0].idx === 4 && lows[0].price === 8, "S1b pivot low at the strict 2-side fractal");
}
{
  const vals = [1, 2, 3, 4, 5, 100];
  const med = rollingMedianPrev(vals, 4);
  assert(isNaN(med[3]) && med[4] === 2.5 && med[5] === 3.5, "S2 rolling median covers the PREVIOUS window only");
}

// ═══ OB fixture (shared by OB1/OB2/MS1/BR1/NL1) ═══════════════════════════════
function obFixture(withSweep = true): FiringCandle[] {
  const b = warmup();
  b.push(C(25, 100.5, 105, 100.3, 101.3));    // swing-high candle (pivot @25 = 105, confirmed @27)
  b.push(C(26, 101.2, 102, 100.6, 100.8));
  b.push(C(27, 100.8, 101.5, 100, 100.4));
  b.push(C(28, 100.4, 100.9, 97, 100));       // swing-low candle (pivot @28 = 97, confirmed @30)
  b.push(C(29, 100, 100.7, 98.5, 99.3));      // bodies kept < displacement threshold on purpose
  b.push(C(30, 99.3, 99.8, 98, 98.7));
  b.push(withSweep
    ? C(31, 98.7, 98.8, 96.5, 98.2)           // SWEEP: wick under 97, close back above
    : C(31, 98.7, 98.8, 97.2, 98.2));         // variant: no sweep
  b.push(C(32, 98.5, 98.7, 97.9, 98.1));      // OB candle (down)
  b.push(C(33, 98.2, 106.6, 98.1, 106.2));    // displacement up, closes through the 105 swing high
  return b;
}

console.log("── ICT-OB / ICT-MITIGATION ──");
{
  const setups = run(obFixture(true), ["ICT-OB"]);
  assert(setups.length === 1, "OB1a exactly one order-block setup in the fixture");
  const s = setups[0];
  assert(s.strategy === "ICT-OB" && s.direction === "Long" && s.setupIdx === 33, "OB1b fires on the displacement bar, long");
  assert(approx(s.entry, 98.5), "OB1c entry = the OB candle's open (change in state of delivery)");
  assert(approx(s.stop, 97.65), "OB1d stop = 1 tick below the OB candle's low");
  assert(approx(s.tp1, 100.2) && approx(s.tp2, 101.9), "OB1e no pool in view -> TP1 = 2R, TP2 = 4R");
  assert(s.entryKind === "limit" && s.refs.sweptLevel === 97 && s.refs.brokenSwing === 105, "OB1f refs record the swept level and the broken swing");
}
{
  const asMit = run(obFixture(true), ["ICT-MITIGATION"]);
  assert(asMit.length === 0, "OB2 a fully-qualified OB is NOT also a mitigation block");
}
{
  const noOb = run(obFixture(false), ["ICT-OB"]);
  const mit = run(obFixture(false), ["ICT-MITIGATION"]);
  assert(noOb.length === 0, "MI1a without the sweep the high-probability OB does not fire");
  assert(mit.length === 1 && mit[0].setupIdx === 33 && approx(mit[0].entry, 98.5) && approx(mit[0].stop, 97.65),
    "MI1b ...but the mitigation block does, with identical OB geometry");
  assert(mit[0].refs.hadMss === 1 && mit[0].refs.hadSweep === 0, "MI1c refs say which qualifier was missing");
}

console.log("── ICT-MSS ──");
{
  const setups = run(obFixture(true), ["ICT-MSS"]);
  assert(setups.length === 1 && setups[0].setupIdx === 33 && setups[0].direction === "Long", "MS1a MSS fires on the displacement bar");
  const s = setups[0];
  const legLo = 96.5, legHi = 106.6;
  const entry = legHi - ICT_CONST.OTE_MIN_RETRACE * (legHi - legLo);
  assert(approx(s.entry, Math.round(entry * 100) / 100), "MS1b entry = 62% retracement of the sweep->displacement leg");
  assert(approx(s.stop, legLo - 0.25), "MS1c stop = 1 tick beyond the leg origin");
  const risk = entry - (legLo - 0.25);
  assert(approx(s.tp1, Math.round((entry + 2 * risk) * 100) / 100), "MS1d TP1 = 2R with no pool in view");
}

console.log("── ICT-FVG ──");
{
  const b = warmup();
  b.push(C(25, 99.6, 100, 99.4, 99.8));       // c1
  b.push(C(26, 99.8, 104.5, 99.7, 104.4));    // c2 displacement up
  b.push(C(27, 104.4, 105, 101, 104.8));      // c3 -> gap [100, 101]
  const setups = run(b, ["ICT-FVG"]);
  assert(setups.length === 1 && setups[0].setupIdx === 27 && setups[0].direction === "Long", "FV1a bullish FVG detected on candle 3");
  const s = setups[0];
  // gap C.E. = (100+101)/2 = 100.5 ; impulse 50% (c2.high->c1.low) = (104.5+99.4)/2 = 101.95
  assert(approx(s.entry, 101.95), "FV1b entry = the SHALLOWER of gap-C.E. and impulse-50% (offered first)");
  assert(approx(s.invalidBeyond ?? NaN, 100.5), "FV1c invalidation = the DEEPER of the two 50% levels");
  assert(approx(s.stop, 99.15), "FV1d stop = 1 tick beyond candle 1's low");
  const risk = 101.95 - 99.15;
  assert(approx(s.tp1, Math.round((101.95 + 2 * risk) * 100) / 100), "FV1e TP1 = 2R with no pool in view");
}

console.log("── ICT-CE ──");
{
  const b = warmup();
  b.push(C(25, 99.9, 100.5, 94, 100.2)); // huge lower wick at a fresh 20-bar low
  const setups = run(b, ["ICT-CE"]);
  assert(setups.length === 1 && setups[0].direction === "Long" && setups[0].setupIdx === 25, "CE1a wick-reversal long fires");
  const s = setups[0];
  assert(approx(s.entry, (94 + 99.9) / 2), "CE1b entry = 50% of the wick (consequent encroachment)");
  assert(approx(s.stop, 93.75), "CE1c stop = 1 tick beyond the wick extreme");
}
{
  const b = warmup();
  b.push(C(25, 99.9, 100.5, 98.9, 100.2)); // wick 1.0 pts — fails the 1.5x median-range bar
  assert(run(b, ["ICT-CE"]).length === 0, "CE1d ordinary wick does not fire");
}

console.log("── ICT-SWEEP ──");
function sweepBase(): FiringCandle[] {
  const b = warmup();
  b.push(C(25, 100.6, 101.4, 100.4, 101.2));
  b.push(C(26, 101.2, 102, 101, 101.8));
  b.push(C(27, 101.8, 102.6, 101.6, 102.4));
  b.push(C(28, 102.4, 103.2, 102.2, 103));
  return b;
}
const PDH: LiquidityLevel = { price: 104, opposite: 96, kind: "prior-day high", isHigh: true, activeFromTs: t(0), activeToTs: t(60) };
{
  const b = sweepBase();
  b.push(C(29, 103, 104.5, 101.8, 101.9)); // wick over 104, same candle closes back below with displacement
  const setups = run(b, ["ICT-SWEEP"], [PDH]);
  assert(setups.length === 1 && setups[0].setupIdx === 29 && setups[0].direction === "Short", "SW1a same-candle turtle soup short");
  const s = setups[0];
  assert(s.entryKind === "market" && approx(s.entry, 101.9), "SW1b entry at the confirming candle's close");
  assert(approx(s.stop, 104.75), "SW1c stop = 1 tick beyond the sweep extreme");
  assert(approx(s.tp1, 100) && approx(s.tp2, 96), "SW1d TP1 = range midpoint (closer than 2R), TP2 = opposite side of the range");
}
{
  const b = sweepBase();
  b.push(C(29, 103, 104.5, 102.8, 104.2)); // wick over 104 but CLOSES above -> pending
  b.push(C(30, 104.2, 104.6, 101.5, 101.9)); // next candle closes back below with displacement
  const setups = run(b, ["ICT-SWEEP"], [PDH]);
  assert(setups.length === 1 && setups[0].setupIdx === 30, "SW2a next-candle close-back fires on the confirming candle");
  assert(approx(setups[0].stop, 104.85), "SW2b sweep extreme spans BOTH candles (104.6 + 1 tick)");
}
{
  const b = sweepBase();
  b.push(C(29, 103, 104.5, 101.8, 101.9));
  assert(run(b, ["ICT-SWEEP"]).length === 0, "SW3 no active level, no young-swing candidates -> no turtle soup");
}

console.log("── ICT-BREAKER / Unicorn ──");
{
  const b = obFixture(true); // OB emitted @33, zone low 97.9 / high 98.7 / open 98.5
  b.push(C(34, 106.2, 106.4, 103.8, 104));
  b.push(C(35, 104, 104.2, 100.8, 101));
  b.push(C(36, 101, 101.2, 97.3, 97.5)); // close < 97.9 -> the OB FAILS here
  const setups = run(b, ["ICT-OB", "ICT-BREAKER"]);
  const br = setups.filter(s => s.strategy === "ICT-BREAKER");
  assert(br.length === 1 && br[0].setupIdx === 36 && br[0].direction === "Short", "BR1a breaker fires on the failure bar, flipped short");
  assert(approx(br[0].entry, 98.5) && approx(br[0].stop, 98.95), "BR1b entry back at the failed block's open, stop 1 tick above its high");
  assert(approx(br[0].tp1, 97.6) && approx(br[0].tp2, 96.5), "BR1c TP1 = 2R cap, TP2 = the resting pool below (96.5 swing)");
  assert(br[0].unicorn === false, "BR1d no overlapping FVG -> not a unicorn");
}
{
  const b = obFixture(true);
  b.push(C(34, 106.2, 106.4, 103.8, 104));
  b.push(C(35, 104, 104.2, 100, 100.2));   // c1 of the bearish FVG (low 100)
  b.push(C(36, 100.2, 100.3, 98.2, 98.4)); // c2 displacement down (close stays above 97.9)
  b.push(C(37, 98.3, 98.5, 97.95, 98.1));  // c3 -> bearish gap [98.5, 100] overlapping the OB zone
  b.push(C(38, 98, 98.2, 97.3, 97.5));     // OB failure bar
  const setups = run(b, ["ICT-OB", "ICT-BREAKER"]);
  const br = setups.filter(s => s.strategy === "ICT-BREAKER");
  assert(br.length === 1 && br[0].setupIdx === 38 && br[0].unicorn === true, "BR2 breaker overlapping a same-direction FVG is flagged Unicorn");
}

console.log("── cooldown ──");
{
  const b = warmup();
  b.push(C(25, 100, 100.2, 99.4, 99.6));   // OB candle 1
  b.push(C(26, 99.6, 101.7, 99.5, 101.5)); // displacement -> mitigation setup
  b.push(C(27, 101.5, 101.6, 101, 101.1)); // OB candle 2
  b.push(C(28, 101.1, 103.6, 101, 103.4)); // displacement 2 bars later -> SUPPRESSED (cooldown 4)
  b.push(C(29, 103.4, 103.5, 102.9, 103));  // OB candle 3
  b.push(C(30, 103, 105.6, 102.9, 105.4)); // displacement 4 bars after the first -> fires
  const setups = run(b, ["ICT-MITIGATION"]);
  assert(setups.length === 2 && setups[0].setupIdx === 26 && setups[1].setupIdx === 30,
    "CD1 second setup inside the 4-bar cooldown is suppressed; the one at +4 fires");
}

console.log("── no lookahead ──");
{
  const full = obFixture(true);
  const setupsFull = run(full).filter(s => s.setupIdx <= 30);
  const setupsCut = run(full.slice(0, 31)).filter(s => s.setupIdx <= 30);
  assert(JSON.stringify(setupsFull) === JSON.stringify(setupsCut), "NL1 truncating after bar 30 changes nothing before it");
  const upTo33Full = run(full).filter(s => s.setupIdx <= 33);
  const upTo33Cut = run(full.slice(0, 34)).filter(s => s.setupIdx <= 33);
  assert(JSON.stringify(upTo33Full) === JSON.stringify(upTo33Cut), "NL1b the displacement-bar setups are identical with zero future bars");
}
{
  const b = sweepBase();
  b.push(C(29, 103, 104.5, 102.8, 104.2));
  b.push(C(30, 104.2, 104.6, 101.5, 101.9));
  b.push(C(31, 101.9, 102.4, 101.2, 102.2));
  const full = run(b, undefined, [PDH]);
  const cut = run(b.slice(0, 31), undefined, [PDH]);
  assert(JSON.stringify(full.filter(s => s.setupIdx <= 30)) === JSON.stringify(cut.filter(s => s.setupIdx <= 30)),
    "NL2 lookahead-free with caller levels and pending sweeps too");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error("FAILURES:", failures); process.exit(1); }
