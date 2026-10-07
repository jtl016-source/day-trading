// shared/fact-engine.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Offline unit harness for the fact engine. NO test framework — plain asserts,
// run with:  npx tsx shared/fact-engine.test.ts   (exit 0 = all pass)
//
// Covers the original 17 behaviors (side-entry long/short mechanics, solo rules,
// confluence, room check, contradiction stalemate, cooldown, ETH solo, labels)
// PLUS the 2026-07-13 defect-fix suite:
//   B5  ETH rejects footprint facts
//   B6  ETH solo fires once per event (secondaries never enumerated in ETH)
//   B7  lookahead guard — secondary bar usable only once closed ≤ primary close
//   C9  secondary vector facts can never veto a primary side-entry driver
//   C10 tabletop does not count toward the ≥2-fact confluence tally
//   C11 heading does not count toward the tally
//   D13 cooldown is GLOBAL per interval (not per-direction)
//   D14 strong-zone touches are deduped into episodes
//   D15 same-bar TP+SL resolves SL-first
//   D16 session gates evaluated at bar CLOSE (15:15 rule)
//   D17 tabletop flatness tests ALL bars in the segment
// ─────────────────────────────────────────────────────────────────────────────
import {
  runFactEngine, vectorStateAt, detectZoneReaction, countZoneTouches, computeExit, decide,
  evaluateFormingBar, resolveClassExit, resolveExitCalibration, signalTypeOf,
  FACT_ENGINE_DEFAULTS, EXIT_CALIBRATION,
  suggestedContractsFor, DAILY_LOSS_STOP_DEFAULT_PTS, DEAD_TAPE_SUPPRESS_MULT,
  DEAD_TAPE_DIR_EXEMPT, setDeadTapeDirExemptForAnalysis,
  resolveEngineSettings, newFactEngineRunStats, isEthFractalTwoFactVeto, newsBlackoutAt, // 2026-10-01 shadow settings
  SHADOW_TAG_IDS, computeShadowTags, shadowRuleBlock, isBoxSideWrong, type ShadowRuleContext, // 2026-10-01 shadow rules/tags
  type Fact, type FactEngineInput, type FpImbalanceZone, type Interval,
} from "./fact-engine";
import { SIZE_BY_COMBO_TIER } from "./signal-display";
import { parsePriorFiresResponse, openTradesBefore, latestFireTimeBefore } from "./engine-seed"; // B5 tab adapter (2026-09-25)
import { QUALITY_GATE, qualityGateAllows, classKey, comboKeyOf, comboGateAllows, comboExitOverrideFor, type QualityGateData } from "./quality-gate";
import type { FiringCandle, FiringZone, VectorPoint } from "./firing/types";

const s = FACT_ENGINE_DEFAULTS;
let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
// July 2026 = EDT (UTC-4). et() converts an ET wall time to unix seconds.
const et = (d: number, h: number, mi: number) => Date.UTC(2026, 6, d, h + 4, mi, 0) / 1000;
const M5 = 300, M15 = 900;

function C(time: number, open: number, high: number, low: number, close: number): FiringCandle {
  return { time, open, high, low, close, volume: 100 };
}
/** Constant vector line across the given candles. */
function vec(candles: FiringCandle[], value: number): VectorPoint[] {
  return candles.map(c => ({ time: c.time, value }));
}
function vmap(points: VectorPoint[]): Map<number, number> {
  return new Map(points.map(p => [p.time, p.value]));
}
function F(partial: Partial<Fact> & Pick<Fact, "strategy" | "direction" | "kind">): Fact {
  return { weight: 1, driver: false, counted: true, interval: "5m", primary: true, label: partial.kind, ...partial } as Fact;
}
const SUPPORT: FiringZone = { topPrice: 100, bottomPrice: 98, color: "#22c55e", label: "support", fromTime: et(1, 0, 0) };
const RESIST: FiringZone = { topPrice: 122, bottomPrice: 120, color: "#ef4444", label: "resistance", fromTime: et(1, 0, 0) };

/** Long side-entry sequence on a constant vector at `v`: 4 shelf bars hugging v, then a breakout. */
function longSeBars(t0: number, step: number, v: number): FiringCandle[] {
  return [
    C(t0 + 0 * step, v - 0.5, v + 0.3, v - 1, v - 0.2),
    C(t0 + 1 * step, v - 0.2, v + 0.4, v - 0.8, v - 0.4),
    C(t0 + 2 * step, v - 0.4, v + 0.3, v - 0.9, v - 0.1),
    C(t0 + 3 * step, v - 0.1, v + 0.4, v - 0.7, v - 0.5), // shelf ends; close ≤ vector
    C(t0 + 4 * step, v - 0.3, v + 2.6, v - 0.4, v + 2.0), // breakout close > vector → SE↑ here
  ];
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── vectorStateAt: side-entry mechanics ──");
{
  const t0 = et(7, 10, 0);
  const bars = longSeBars(t0, M5, 100);
  const vm = vmap(vec(bars, 100));
  assert(vectorStateAt(bars, vm, 4, s).sideEntryLong === true, "LONG side-entry fires on the breakout candle itself");
  assert(vectorStateAt(bars, vm, 3, s).sideEntryLong === false, "no side-entry before the cross (still in shelf)");
  assert(vectorStateAt(bars, vm, 3, s).headingLong === true, "heading flag while sitting in the shelf");

  // No shelf → no side-entry: same cross but wildly trending bodies before it.
  const trend = [
    C(t0, 90, 91, 89, 90.5), C(t0 + M5, 92, 93, 91, 92.5), C(t0 + 2 * M5, 95, 96, 94, 95.5),
    C(t0 + 3 * M5, 97, 99.6, 96, 99.5), C(t0 + 4 * M5, 99.5, 102.6, 99, 102),
  ];
  const vmT = vmap(vec(trend, 100));
  assert(vectorStateAt(trend, vmT, 4, s).sideEntryLong === false, "cross WITHOUT a prior sideways shelf does not fire");
}
{
  // SHORT: shelf above vector, down-cross, then ≥2 consecutive bearish lower closes.
  const t0 = et(7, 10, 0), v = 100;
  const bars = [
    C(t0 + 0 * M5, v + 0.5, v + 1.2, v, v + 0.6),
    C(t0 + 1 * M5, v + 0.6, v + 1.3, v + 0.1, v + 0.4),
    C(t0 + 2 * M5, v + 0.4, v + 1.1, v, v + 0.5),      // shelf ends; close ≥ vector
    C(t0 + 3 * M5, v + 0.3, v + 0.6, v - 2.2, v - 2),  // down-cross bar c
    C(t0 + 4 * M5, v - 2, v - 1.8, v - 3.2, v - 3),    // bearish, lower close (confirm 1)
    C(t0 + 5 * M5, v - 3, v - 2.8, v - 4.4, v - 4),    // bearish, lower close (confirm 2)
  ];
  const vm = vmap(vec(bars, v));
  assert(vectorStateAt(bars, vm, 5, s).sideEntryShort === true, "SHORT fires after down-cross + 2 bearish lower closes");
  assert(vectorStateAt(bars, vm, 4, s).sideEntryShort === false, "SHORT does NOT fire with only 1 bearish close");
  assert(vectorStateAt(bars, vm, 3, s).sideEntryShort === false, "SHORT does NOT fire on the cross candle itself");
}

console.log("── D17: tabletop flatness over the whole segment ──");
{
  const t0 = et(7, 10, 0);
  const bars = [C(t0, 100, 101, 99, 100.5), C(t0 + M5, 100, 101, 99, 100.5), C(t0 + 2 * M5, 100, 101, 99, 100.5)];
  const flat = new Map([[bars[0].time, 100], [bars[1].time, 100.2], [bars[2].time, 100.1]]);
  assert(vectorStateAt(bars, flat, 2, s).tabletop === true, "flat 3-bar vector segment IS a tabletop");
  const bump = new Map([[bars[0].time, 100], [bars[1].time, 100.8], [bars[2].time, 100.3]]);
  assert(vectorStateAt(bars, bump, 2, s).tabletop === false, "endpoints-flat but mid-bar bump is NOT a tabletop (all bars tested)");
}

console.log("── zone reaction + D14 episode dedup ──");
{
  const bar = C(et(7, 10, 30), 100.2, 104.7, 100.4, 104.5); // wick to 100.4 touches top 100, closes +4.5
  const rx = detectZoneReaction(bar, SUPPORT, true, 0, s);
  assert(rx?.direction === "Long" && rx.strong === true, "wick touch + ≥2× move-away = STRONG Long reaction");
  const weak = detectZoneReaction(C(et(7, 10, 30), 100.2, 102.7, 100.4, 102.5), SUPPORT, true, 0, s);
  assert(weak?.direction === "Long" && weak.strong === false, "wick touch + ≥N move-away = normal reaction");
  const none = detectZoneReaction(C(et(7, 10, 30), 100.2, 101.4, 100.4, 101.2), SUPPORT, true, 0, s);
  assert(none === null, "touch with < N move-away is no reaction");
  const strongByTouches = detectZoneReaction(C(et(7, 10, 30), 100.2, 102.7, 100.4, 102.5), SUPPORT, true, 2, s);
  assert(strongByTouches?.strong === true, "≥2 prior touch EPISODES upgrade a normal reaction to strong");

  const t0 = et(7, 10, 0);
  const drift = [ // 3 CONSECUTIVE touching bars → ONE episode
    C(t0, 101, 102, 100.3, 101.5), C(t0 + M5, 101, 102, 100.2, 101.5), C(t0 + 2 * M5, 101, 102, 100.4, 101.5),
    C(t0 + 3 * M5, 103, 104, 102.5, 103.5), // fully away
  ];
  assert(countZoneTouches(drift, 4, SUPPORT, true, s) === 1, "D14: consecutive touching bars collapse to 1 episode");
  const twoEp = [
    C(t0, 101, 102, 100.3, 101.5),          // touch (episode 1)
    C(t0 + M5, 103, 104, 102.5, 103.5),     // fully away
    C(t0 + 2 * M5, 101, 102, 100.2, 101.5), // touch (episode 2)
    C(t0 + 3 * M5, 103, 104, 102.5, 103.5),
  ];
  assert(countZoneTouches(twoEp, 4, SUPPORT, true, s) === 2, "D14: away-then-retouch is a second episode");
}

console.log("── decide: solo / confluence / contradiction rules ──");
{
  const seP = F({ strategy: "vector", direction: "Long", kind: "side-entry", weight: 3, driver: true });
  const seS = F({ strategy: "vector", direction: "Short", kind: "side-entry", weight: 3, driver: true, primary: false, interval: "15m" });
  const fpL = F({ strategy: "footprint", direction: "Long", kind: "support", weight: 1 });
  const fpS = F({ strategy: "footprint", direction: "Short", kind: "resistance", weight: 1 });
  const zStrong = F({ strategy: "zone", direction: "Long", kind: "reaction", weight: 3, driver: true, strong: true });
  const zStrongS = F({ strategy: "zone", direction: "Short", kind: "reaction", weight: 3, driver: true, strong: true });
  const zNorm = F({ strategy: "zone", direction: "Long", kind: "reaction", weight: 2, driver: true });
  const tt = F({ strategy: "vector", direction: "Long", kind: "tabletop", counted: false, level: 100 });
  const hd = F({ strategy: "vector", direction: "Long", kind: "heading", counted: false });

  assert(decide([zStrong], [], true, s)?.direction === "Long", "solo STRONG zone reaction fires (RTH)");
  assert(decide([zNorm], [], true, s) === null, "solo NORMAL zone reaction does not fire");
  assert(decide([zStrong], [], false, s) === null, "strong zone does NOT fire solo in ETH (zones are RTH-only facts)");
  assert(decide([seP, fpL], [], true, s)?.direction === "Long", "2 agreeing counted facts with a driver fire");
  assert(decide([fpL, fpL], [], true, s) === null, "2 corroborations with NO driver do not fire");
  assert(decide([seP], [], true, s) === null, "RTH solo side-entry (1 counted fact) does not fire");
  assert(decide([seP], [], false, s)?.direction === "Long", "ETH primary side-entry fires SOLO");
  assert(decide([{ ...seS, direction: "Long" } as Fact], [], false, s) === null, "ETH SECONDARY side-entry can NOT fire solo");
  // C10 / C11 — notes don't count toward the tally:
  assert(decide([seP, tt], [], true, s) === null, "C10: side-entry + tabletop is still only 1 COUNTED fact → no fire");
  assert(decide([seP, hd], [], true, s) === null, "C11: side-entry + heading is still only 1 COUNTED fact → no fire");
  // C9 — secondaries never veto a primary driver:
  const c9 = decide([seP, fpL], [seS, fpS], true, s);
  assert(c9?.direction === "Long", "C9: opposing SECONDARY side-entry cannot veto/stalemate a primary driver");
  // …but a genuine non-vector contradiction still stalemates:
  assert(decide([seP, fpL], [zStrongS, fpS], true, s) === null, "heavy contradiction among primary/non-vector facts → stalemate fires NOTHING");
}

console.log("── computeExit: room check + anchoring ──");
{
  const zonesArr = [RESIST]; const bull = [false];
  const blockedEx = computeExit("Long", 118.5, zonesArr, bull, [], et(7, 11, 0), EXIT_CALIBRATION);
  assert(blockedEx.blocked === true, "opposing obstacle nearer than MIN_TP1 blocks the fire (no room)");
  const anchored = computeExit("Long", 114, zonesArr, bull, [], et(7, 11, 0), EXIT_CALIBRATION);
  assert(anchored.blocked === false && anchored.tp1 === 119 && anchored.anchor === "zone", "TP1 anchors 1pt short of a zone edge within reach");
  const ttAnchor = computeExit("Long", 100, [], [], [107], et(7, 11, 0), EXIT_CALIBRATION);
  assert(ttAnchor.tp1 === 106 && ttAnchor.anchor === "tabletop", "TP1 anchors 1pt short of a tabletop within reach");
  const free = computeExit("Long", 100, [], [], [], et(7, 11, 0), EXIT_CALIBRATION);
  assert(free.tp1 === 110 && free.sl === 95 && free.tp2 === 120, "no obstacle → default TP1 10 / SL 5 / TP2 2×TP1");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── runFactEngine end-to-end ──");

/** RTH fixture: quiet bars, then a STRONG support-zone reaction at bar index `at`. */
function strongZoneRun(opts: { fireBarEt: [number, number]; preBars?: number; postBars?: number; extraAfter?: (t: number, k: number) => FiringCandle }): { input: FactEngineInput; fireTime: number } {
  const [h, mi] = opts.fireBarEt;
  const fireTime = et(7, h, mi);
  const pre = opts.preBars ?? 4, post = opts.postBars ?? 4;
  const candles: FiringCandle[] = [];
  for (let k = pre; k >= 1; k--) candles.push(C(fireTime - k * M5, 102, 102.5, 101.5, 102.2));
  candles.push(C(fireTime, 100.7, 104.7, 100.4, 104.5)); // wick touches 100, closes +4.5 → STRONG
  for (let k = 1; k <= post; k++) candles.push(opts.extraAfter ? opts.extraAfter(fireTime + k * M5, k) : C(fireTime + k * M5, 104.5, 105, 104, 104.6));
  const input: FactEngineInput = {
    primary: "5m",
    slices: [{ interval: "5m", candles, vector: vec(candles, 90) }], // vector far away → no vector facts
    zones: [SUPPORT],
    nowSec: fireTime + 600, // keep walk-forward "open" unless bars decide it
    exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 }, // pin geometry — regen-proof vs MC recalibration
    ictEnabled: false, fractalEnabled: false, // mechanics fixture — corroborators tested separately
  };
  return { input, fireTime };
}

{
  // Solo strong zone fires + label lists the fact.
  const { input, fireTime } = strongZoneRun({ fireBarEt: [10, 30] });
  const sig = runFactEngine(input);
  assert(sig.length === 1 && sig[0].time === fireTime && sig[0].direction === "Long", "solo strong-zone reaction fires end-to-end (RTH)");
  assert(sig[0].signalType === "zone-reaction", "solo zone signalType = zone-reaction");
  assert(sig[0].label.includes("Zone(strong support @100.00"), "label names the exact fact — never generic");
}

{
  // D15: SL-first when one bar spans both SL and TP.
  const { input, fireTime } = strongZoneRun({
    fireBarEt: [10, 30], postBars: 1,
    extraAfter: (t) => C(t, 104.5, 116, 99, 110), // spans tp1 114.5 AND sl 99.5
  });
  const sig = runFactEngine(input);
  assert(sig.length === 1 && sig[0].outcome === "loss" && sig[0].toTime === fireTime + M5, "D15: bar spanning TP and SL resolves SL-FIRST (loss)");
}

{
  // D16: the 15:15 gate is evaluated at bar CLOSE. A 5m bar OPENING 15:10 closes at 15:15 → gated.
  const gated = strongZoneRun({ fireBarEt: [15, 10] });
  assert(runFactEngine(gated.input).length === 0, "D16: bar closing exactly 15:15 ET is suppressed (gate at close)");
  const ok = strongZoneRun({ fireBarEt: [15, 5] });
  assert(runFactEngine(ok.input).length === 1, "bar closing 15:10 ET still fires");
  // And the settlement break, at close: a bar opening 16:55 closes 17:00 → break/ETH → zone can't fire.
  const brk = strongZoneRun({ fireBarEt: [16, 55] });
  assert(runFactEngine(brk.input).length === 0, "bar closing at 17:00 ET (break) is suppressed at close-time");
}

{
  // D13: GLOBAL cooldown — a Short event 2 bars after a Long fire is suppressed; the identical
  // Short event COOLDOWN_BARS bars after it fires (2026-09-24: default 10, was 4).
  assert(s.COOLDOWN_BARS === 10, "COOLDOWN_BARS default is the documented 10 bars (2026-09-24, was 4)");
  const CD = s.COOLDOWN_BARS;
  const t0 = et(7, 10, 0);
  const candles: FiringCandle[] = [];
  for (let k = 4; k >= 1; k--) candles.push(C(t0 - k * M5, 102, 102.5, 101.5, 102.2));
  candles.push(C(t0, 100.7, 104.7, 100.4, 104.5));                    // i: STRONG Long (support)
  candles.push(C(t0 + 1 * M5, 104.5, 105, 104, 104.6));
  candles.push(C(t0 + 2 * M5, 117, 119.6, 115, 115.5));               // i+2: STRONG Short (resistance) — must be suppressed
  for (let k = 3; k < CD; k++) candles.push(C(t0 + k * M5, 115.5, 116, 115, 115.6));
  candles.push(C(t0 + CD * M5, 117, 119.6, 115, 115.5));              // i+CD: STRONG Short — fires
  candles.push(C(t0 + (CD + 1) * M5, 115.5, 116, 115, 115.4));
  const input: FactEngineInput = {
    primary: "5m",
    slices: [{ interval: "5m", candles, vector: vec(candles, 90) }],
    zones: [SUPPORT, RESIST],
    nowSec: t0 + (CD + 2) * M5,
    // Mechanics fixture: corroborators OFF (a trending-FCO fact would turn the solo zone
    // reactions into 2-fact fact-engine signals and hand the outcome to the live gate data).
    ictEnabled: false, fractalEnabled: false,
  };
  const sig = runFactEngine(input);
  assert(sig.length === 2, `D13: exactly 2 signals fire (got ${sig.length})`);
  assert(sig[0]?.direction === "Long" && sig[0]?.time === t0, "D13: first fire is the Long");
  assert(sig[1]?.direction === "Short" && sig[1]?.time === t0 + CD * M5, "D13: opposite-direction fire 2 bars later is SUPPRESSED by the GLOBAL cooldown; COOLDOWN_BARS later fires");
  // Legacy cadence reproducible: with COOLDOWN_BARS:4 the i+2 Short is still suppressed and the
  // later Short still fires (fillers carry no fact) — the old D13 contract, now opt-in.
  const legacy = runFactEngine({ ...input, settings: { COOLDOWN_BARS: 4 } });
  assert(legacy.length === 2 && legacy[1].time === t0 + CD * M5, "D13 legacy COOLDOWN_BARS:4 — i+2 still suppressed, the later Short fires");
  // Between 4 and COOLDOWN_BARS: a Short at i+6 fires under the legacy 4 but NOT under the default 10.
  const mid = candles.map(b => b.time === t0 + 6 * M5 ? C(b.time, 117, 119.6, 115, 115.5) : b);
  const midDefault = runFactEngine({ ...input, slices: [{ interval: "5m", candles: mid, vector: vec(mid, 90) }] });
  const midLegacy = runFactEngine({ ...input, slices: [{ interval: "5m", candles: mid, vector: vec(mid, 90) }], settings: { COOLDOWN_BARS: 4 } });
  assert(!midDefault.some(x => x.time === t0 + 6 * M5) && midLegacy.some(x => x.time === t0 + 6 * M5),
    "COOLDOWN_BARS 10: a fire 6 bars after the last is suppressed (legacy 4 allowed it)");
}

// ── ETH fixtures ─────────────────────────────────────────────────────────────
/** ETH long side-entry on the 5m primary at Tue 8 PM ET, with drift bars after.
 *  qualityGateEnabled:false — these fixtures test ENGINE MECHANICS; the live gate blocks the
 *  vector-side-entry@5m class (data-driven), which has its own test section below. */
function ethSeRun(extra?: Partial<FactEngineInput>): { input: FactEngineInput; seTime: number } {
  const t0 = et(7, 20, 0); // Tue 8 PM ET = ETH
  const bars = longSeBars(t0, M5, 100);
  const seTime = bars[4].time;
  for (let k = 5; k <= 14; k++) bars.push(C(t0 + k * M5, 102 + 0.1 * k, 102.6 + 0.1 * k, 101.6 + 0.1 * k, 102.2 + 0.1 * k)); // stays above vector, no re-cross
  const input: FactEngineInput = {
    primary: "5m",
    slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [],
    nowSec: seTime + 600,
    qualityGateEnabled: false,
    ...extra,
  };
  return { input, seTime };
}

{
  // ESCAPE HATCH (ETH_CONFLUENCE:false = the pre-2026-08-11 ETH-purity contract).
  const { input, seTime } = ethSeRun({ settings: { ETH_CONFLUENCE: false } });
  const sig = runFactEngine(input);
  assert(sig.length === 1 && sig[0].time === seTime, `B6: ETH solo side-entry fires ONCE on the event bar (got ${sig.length})`);
  assert(sig[0].signalType === "vector-side-entry" && sig[0].session === "ETH", "ETH solo carries signalType vector-side-entry");
}

{
  // B5 under the ESCAPE HATCH: with ETH_CONFLUENCE:false, footprint in ETH must NOT attach.
  const { input, seTime } = ethSeRun({ settings: { ETH_CONFLUENCE: false } });
  const fpMap = new Map<number, FpImbalanceZone[]>();
  for (const c of input.slices[0].candles) fpMap.set(c.time, [{ startPrice: 99, endPrice: 100, direction: "buy", levelCount: 3 }]);
  input.footprintByTime = fpMap;
  const sig = runFactEngine(input);
  assert(sig.length === 1 && sig[0].time === seTime, "B5: footprint data in ETH does not create extra fires");
  assert(sig[0].facts.every(f => f.strategy !== "footprint"), "B5: NO footprint fact attaches to an ETH signal");
  assert(sig[0].signalType === "vector-side-entry", "B5: ETH signalType never degrades from vector-side-entry");

  // …and footprint alone in ETH (no side-entry) fires nothing.
  const t0 = et(7, 21, 0);
  const quiet: FiringCandle[] = [];
  for (let k = 0; k < 10; k++) quiet.push(C(t0 + k * M5, 101, 101.5, 100.6, 101.2));
  const fpOnly = new Map<number, FpImbalanceZone[]>();
  for (const c of quiet) fpOnly.set(c.time, [{ startPrice: 99, endPrice: 100, direction: "buy", levelCount: 3 }]);
  const none = runFactEngine({ primary: "5m", slices: [{ interval: "5m", candles: quiet, vector: vec(quiet, 90) }], zones: [], footprintByTime: fpOnly, nowSec: t0 + 600, qualityGateEnabled: false });
  assert(none.length === 0, "B5: footprint-only ETH bars fire nothing");
}

{
  // ETH CONFLUENCE (2026-08-11 — the user repealed rule 3): with the DEFAULT setting the same
  // ETH side-entry + footprint scenario forms REAL confluence — the footprint fact attaches
  // and the type is fact-engine (the quality gate then judges it like any confluence signal;
  // gate OFF here isolates the enumeration contract itself).
  const { input } = ethSeRun();
  const fpMap = new Map<number, FpImbalanceZone[]>();
  for (const c of input.slices[0].candles) fpMap.set(c.time, [{ startPrice: 99, endPrice: 100, direction: "buy", levelCount: 3 }]);
  input.footprintByTime = fpMap;
  const sig = runFactEngine(input);
  assert(sig.length >= 1, "ETH-CONFLUENCE default: the ETH scenario still fires");
  assert(sig.some(x => x.facts.some(f => f.strategy === "footprint")), "ETH-CONFLUENCE default: a footprint fact attaches to an ETH signal");
  // VSE-PRESERVING contract (measured 2026-08-11 — see signalTypeOf): a PRIMARY side-entry in
  // ETH keeps its structural vse identity even with corroborators attached; only non-vse-driven
  // ETH confluence (e.g. the yellowbox-break case below) classifies fact-engine.
  assert(sig.some(x => x.signalType === "vector-side-entry" && x.session === "ETH" && x.facts.some(f => f.strategy !== "vector")),
    "ETH-CONFLUENCE default: a vse-driven ETH signal KEEPS type vector-side-entry with corroborators attached");
  // Footprint alone still never fires (corroborator-only is session-independent).
  const t0b = et(7, 21, 0);
  const quiet2: FiringCandle[] = [];
  for (let k = 0; k < 10; k++) quiet2.push(C(t0b + k * M5, 101, 101.5, 100.6, 101.2));
  const fpOnly2 = new Map<number, FpImbalanceZone[]>();
  for (const c of quiet2) fpOnly2.set(c.time, [{ startPrice: 99, endPrice: 100, direction: "buy", levelCount: 3 }]);
  const none2 = runFactEngine({ primary: "5m", slices: [{ interval: "5m", candles: quiet2, vector: vec(quiet2, 90) }], zones: [], footprintByTime: fpOnly2, nowSec: t0b + 600, qualityGateEnabled: false });
  assert(none2.length === 0, "ETH-CONFLUENCE default: footprint-only ETH bars still fire nothing (never solo)");
}

{
  // B6b: a SECONDARY-interval side-entry in ETH is never enumerated → can never fire solo.
  const t0 = et(7, 20, 0);
  const primaryBars: FiringCandle[] = [];
  for (let k = 0; k < 16; k++) primaryBars.push(C(t0 + k * M5, 101, 101.5, 100.6, 101.2)); // no primary facts (vector far)
  const secBars = longSeBars(t0 - 4 * M15, M15, 100); // 15m SE completes inside the window
  const sig = runFactEngine({
    primary: "5m",
    slices: [
      { interval: "5m", candles: primaryBars, vector: vec(primaryBars, 90) },
      { interval: "15m", candles: secBars, vector: vec(secBars, 100) },
    ],
    zones: [], nowSec: t0 + 3600, qualityGateEnabled: false,
  });
  assert(sig.length === 0, "B6: secondary side-entry in ETH is never a solo driver (fires nothing, no flood — gate OFF so the 0 is the enumeration rule, not the gate)");
}

{
  // B7: lookahead guard — a secondary 15m SE bar corroborates ONLY once it has CLOSED.
  // Secondary SE bar starts at S (closes S+900). Primary bars carry a footprint corroboration;
  // the first fire must be the primary bar CLOSING at S+900 (time S+600) — not earlier.
  const S = et(7, 11, 0);
  const secBars = longSeBars(S - 4 * M15, M15, 100); // SE bar = index 4, starts at S
  const primaryBars: FiringCandle[] = [];
  for (let k = -8; k <= 5; k++) {
    const t = S + k * M5;
    // rising closes so the firing bar always makes a new HOD (avoids HOD suppression)
    const px = 101 + (k + 8) * 0.4;
    primaryBars.push(C(t, px - 0.2, px + 0.2, px - 0.4, px));
  }
  const fpMap = new Map<number, FpImbalanceZone[]>();
  for (const c of primaryBars) fpMap.set(c.time, [{ startPrice: c.close - 1.5, endPrice: c.close - 0.5, direction: "buy", levelCount: 3 }]);
  const sig = runFactEngine({
    primary: "5m",
    slices: [
      { interval: "5m", candles: primaryBars, vector: vec(primaryBars, 90) },
      { interval: "15m", candles: secBars, vector: vec(secBars, 100) },
    ],
    zones: [], footprintByTime: fpMap, nowSec: S + 3600,
  });
  assert(sig.length > 0, "B7 fixture fires");
  assert(sig.length > 0 && sig[0].time === S + 2 * M5, `B7: secondary SE usable only after its bar CLOSES — first fire at S+600 (got ${sig[0] ? sig[0].time - S : "none"})`);
}

{
  // Confluence + label end-to-end: RTH side-entry + footprint = 2 counted facts → fires with both named.
  const t0 = et(7, 10, 0);
  const bars = longSeBars(t0, M5, 100);
  for (let k = 5; k <= 8; k++) bars.push(C(t0 + k * M5, 102.2, 102.8, 101.8, 102.4));
  const fpMap = new Map<number, FpImbalanceZone[]>();
  fpMap.set(bars[4].time, [{ startPrice: 99, endPrice: 100, direction: "buy", levelCount: 3 }]);
  const sig = runFactEngine({
    primary: "5m",
    slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [], footprintByTime: fpMap, nowSec: bars[4].time + 600,
  });
  assert(sig.length === 1 && sig[0].direction === "Long", "RTH confluence (SE + footprint) fires");
  assert(sig.length === 1 && sig[0].label.includes("Vector(SE↑") && sig[0].label.includes("Footprint(support @99.50"), `label lists EVERY fact (got "${sig[0]?.label}")`);
  assert(sig.length === 1 && sig[0].label.toLowerCase() !== "confluence", "label is never generic 'confluence'");

  // C10 end-to-end: WITHOUT the footprint fact the same SE+tabletop-only bar must NOT fire in RTH.
  const noFp = runFactEngine({
    primary: "5m",
    slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [], nowSec: bars[4].time + 600,
    ictEnabled: false, fractalEnabled: false, // isolate the C10/C11 rule (FCO would corroborate the breakout)
  });
  assert(noFp.length === 0, "C10/C11 end-to-end: RTH SE + tabletop/heading notes alone (1 counted fact) does not fire");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── Yellow Box: break facts / confluence / ETH / solo / TP anchor ──");
{
  // July 7 2026 (Tue) RTH session; box 90–110, initRes 118, initSup 82.
  const YBOX = { dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop: 110, boxBottom: 90, initRes: 118, initSup: 82 };
  // Quiet-inside-box run then a candle CLOSING above the box top → break↑. `fp` corroborates.
  function ybBreakRun(t0: number, withFp: boolean) {
    const candles: FiringCandle[] = [];
    for (let k = 4; k >= 1; k--) candles.push(C(t0 - k * M5, 105, 106, 104, 105)); // inside box, HOD ~106
    candles.push(C(t0, 108, 113.5, 107, 113));                                      // close 113 > 110 → break↑
    for (let k = 1; k <= 4; k++) candles.push(C(t0 + k * M5, 113, 114, 112, 113.2));
    const fp = new Map<number, FpImbalanceZone[]>();
    if (withFp) fp.set(t0, [{ startPrice: 111, endPrice: 112, direction: "buy", levelCount: 3 }]);
    return { candles, footprintByTime: withFp ? fp : undefined };
  }

  // Fires on outside close + counts toward confluence (yellowbox driver + footprint = 2 counted).
  // exit pinned 10/5 so the initRes-anchor assertions stay regen-proof vs MC recalibration.
  const PIN = { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 };
  const t0 = et(7, 10, 0);
  const { candles, footprintByTime } = ybBreakRun(t0, true);
  const sig = runFactEngine({ primary: "5m", slices: [{ interval: "5m", candles, vector: vec(candles, 80) }], zones: [], dayZones: [YBOX], footprintByTime, nowSec: t0 + 600, exit: PIN });
  assert(sig.length === 1 && sig[0].direction === "Long" && sig[0].time === t0, "yellowbox break↑ + footprint fires Long end-to-end (counts toward confluence)");
  assert(sig[0].label.includes("Yellowbox(break↑ @110.00)"), "label names the yellowbox fact exactly — Yellowbox(break↑ @110.00)");

  // TP anchor selection: initRes (118) anchors TP1 one buffer short → 117; anchor kind = yellowbox.
  assert(Math.abs(sig[0].tp1 - (118 - EXIT_CALIBRATION.TP_ANCHOR_BUFFER_PTS)) < 1e-9, "TP1 anchors 1pt short of initRes (117) when a yellowbox fact participates");
  assert(sig[0].confirmations.includes('"anchor":"yellowbox"'), "TP anchor kind recorded as yellowbox");

  // ESCAPE HATCH: with ETH_CONFLUENCE:false the same break at Tue 20:00 ET (ETH) enumerates
  // no yellowbox fact → no fire (the pre-2026-08-11 contract).
  const eth0 = et(7, 20, 0);
  const ethBox = { dayKeyET: "2026-07-08", sessionStartTs: et(7, 18, 0), sessionEndTs: et(8, 17, 0), boxTop: 110, boxBottom: 90, initRes: 118, initSup: 82 };
  const ethRun = ybBreakRun(eth0, true);
  const ethSig = runFactEngine({ primary: "5m", slices: [{ interval: "5m", candles: ethRun.candles, vector: vec(ethRun.candles, 80) }], zones: [], dayZones: [ethBox], footprintByTime: ethRun.footprintByTime, nowSec: eth0 + 600, qualityGateEnabled: false, settings: { ETH_CONFLUENCE: false } });
  assert(ethSig.length === 0, "yellowbox break in ETH does NOT enumerate/fire (yellowbox facts are RTH-only)");
  // DEFAULT (ETH confluence ON): the identical ETH break + footprint DOES form confluence.
  const ethSigOn = runFactEngine({ primary: "5m", slices: [{ interval: "5m", candles: ethRun.candles, vector: vec(ethRun.candles, 80) }], zones: [], dayZones: [ethBox], footprintByTime: ethRun.footprintByTime, nowSec: eth0 + 600, qualityGateEnabled: false });
  assert(ethSigOn.length >= 1 && ethSigOn.some(x => x.facts.some(f => f.strategy === "yellowbox")),
    "ETH-CONFLUENCE default: the same yellowbox break + footprint fires in ETH");

  // Solo ONLY when the flag is on: a lone yellowbox break (no corroboration).
  const solo0 = et(7, 11, 0);
  const soloRun = ybBreakRun(solo0, false);
  const soloBase = { primary: "5m" as Interval, slices: [{ interval: "5m" as Interval, candles: soloRun.candles, vector: vec(soloRun.candles, 80) }], zones: [], dayZones: [YBOX], nowSec: solo0 + 600, ictEnabled: false, fractalEnabled: false };
  assert(runFactEngine(soloBase).length === 0, "solo OFF (default): a lone yellowbox break does NOT fire");
  const soloSig = runFactEngine({ ...soloBase, settings: { YELLOWBOX_SOLO: true } });
  assert(soloSig.length === 1 && soloSig[0].signalType === "yellowbox-break" && soloSig[0].direction === "Long", "solo ON: a lone yellowbox break fires as signalType yellowbox-break");
  // Solo exit geometry: TP1 = initRes, SL = opposite box edge (boxBottom).
  assert(soloSig[0].tp1 === YBOX.initRes && soloSig[0].sl === YBOX.boxBottom, "solo yellowbox exit: TP1=initRes, SL=opposite box edge");

  // Secondary-interval yellowbox break can never veto a primary side-entry driver.
  const seP = F({ strategy: "vector", direction: "Long", kind: "side-entry", weight: 3, driver: true });
  const fpL = F({ strategy: "footprint", direction: "Long", kind: "support", weight: 1 });
  const ybSecShort = F({ strategy: "yellowbox", direction: "Short", kind: "break", weight: 2, driver: false, primary: false, interval: "15m" });
  assert(decide([seP, fpL], [ybSecShort], true, s)?.direction === "Long", "secondary yellowbox break cannot veto a primary side-entry");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── E3: same-strategy yellowbox facts count at most once per direction ──");
{
  // The 253-row fabrication class: a primary yellowbox break whose ONLY corroboration is the
  // SAME day-box break echoed on secondary intervals. Secondary yb breaks are label-notes
  // (counted:false) now, so primary+echo = 1 counted fact → NO fire (unless YELLOWBOX_SOLO).
  const YBOX = { dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop: 110, boxBottom: 90, initRes: 118, initSup: 82 };
  const t0 = et(7, 10, 0);
  const p: FiringCandle[] = [];
  for (let k = 8; k >= 1; k--) p.push(C(t0 - k * M5, 105, 106, 104, 105));   // inside box
  p.push(C(t0, 108, 113.5, 107, 113));                                       // 5m close 113 > 110 → primary break↑
  for (let k = 1; k <= 4; k++) p.push(C(t0 + k * M5, 113, 114, 112, 113.2));
  // 15m secondary whose CLOSED bar (ending ≤ the primary close) ALSO closes above the box.
  const sec: FiringCandle[] = [];
  for (let k = 6; k >= 2; k--) sec.push(C(t0 - k * M15, 105, 106, 104, 105));
  sec.push(C(t0 - M15, 108, 113.5, 107, 113)); // closes at t0 → usable, close 113 > 110
  sec.push(C(t0, 113, 114, 112, 113.2));
  const both = runFactEngine({
    primary: "5m",
    slices: [
      { interval: "5m", candles: p, vector: vec(p, 80) },
      { interval: "15m", candles: sec, vector: vec(sec, 80) },
    ],
    zones: [], dayZones: [YBOX], nowSec: t0 + 600,
    ictEnabled: false, fractalEnabled: false, // isolate the E3 echo rule (FCO would corroborate the break)
  });
  assert(both.length === 0, "E3: primary yb break + SECONDARY yb echo alone does NOT fire (echo is a label-note)");
  // decide-level: the secondary echo is uncounted, so the tally is 1 counted fact.
  const ybP = F({ strategy: "yellowbox", direction: "Long", kind: "break", weight: 2, driver: true });
  const ybS = F({ strategy: "yellowbox", direction: "Long", kind: "break", weight: 2, driver: false, counted: false, primary: false, interval: "15m" });
  assert(decide([ybP, ybS], [], true, s) === null, "E3: yb primary + uncounted yb secondary = 1 counted fact → decide fires nothing");
  // A REAL second strategy still confluences with the primary break.
  const fpL2 = F({ strategy: "footprint", direction: "Long", kind: "support", weight: 1 });
  assert(decide([ybP, ybS, fpL2], [], true, s)?.direction === "Long", "E3: yb break + a DIFFERENT strategy's fact still fires");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── evaluateFormingBar: the single intra-candle path (B1) ──");
{
  // Fixture: quiet closed RTH bars, then a FORMING bar with a strong support reaction.
  const mkClosed = (fireTime: number, n = 6): FiringCandle[] => {
    const out: FiringCandle[] = [];
    for (let k = n; k >= 1; k--) out.push(C(fireTime - k * M5, 102, 102.5, 101.5, 102.2));
    return out;
  };
  const strongForming = (fireTime: number) => C(fireTime, 100.7, 104.7, 100.4, 104.5); // wick 100.4 → close +4.5 = STRONG

  // 1) Fires on a strong zone reaction, RTH, with the engine's exact label/type/confidence.
  const t1 = et(7, 10, 30);
  const sig1 = evaluateFormingBar({ interval: "5m", formingBar: strongForming(t1), closedCandles: mkClosed(t1), zones: [SUPPORT] });
  assert(sig1 != null && sig1.direction === "Long" && sig1.time === t1, "forming-bar strong zone reaction fires");
  assert(sig1?.signalType === "zone-reaction", "forming-bar solo strong zone carries signalType zone-reaction");
  assert(sig1?.label.includes("Zone(strong support @100.00") === true, "forming-bar label lists the exact fact");
  assert(sig1?.confirmations.includes('"intraCandle":true') === true, "forming-bar confirmations tagged intraCandle");

  // 2) IDENTICAL to bar close: the engine run over the CLOSED version of the same bar agrees.
  // (Sloping vector — a flat one would add a tabletop label-note at bar close, which the intra
  //  path correctly never has because vector facts are bar-close-only.)
  const parityBars = [...mkClosed(t1), strongForming(t1)];
  const slopingVec: VectorPoint[] = parityBars.map((c, i) => ({ time: c.time, value: 90 - i * 0.6 }));
  const closedRun = runFactEngine({
    primary: "5m",
    slices: [{ interval: "5m", candles: parityBars, vector: slopingVec }],
    // The engine clock sits AT the bar close: a closed 5m bar at t1 has closed at t1 + M5 (2026-10-01,
    // ticket 12b — a bar whose close lies after nowSec is the forming bucket and is skipped).
    zones: [SUPPORT], nowSec: t1 + M5,
    // Parity is about the ZONE path: ICT/fractal facts are bar-close-only (like vector/yellowbox),
    // so the intra path never carries them — compare against a closed run without them.
    ictEnabled: false, fractalEnabled: false,
  });
  assert(closedRun.length === 1 && sig1 != null
    && closedRun[0].direction === sig1.direction && closedRun[0].tp1 === sig1.tp1
    && closedRun[0].tp2 === sig1.tp2 && closedRun[0].sl === sig1.sl
    && closedRun[0].label === sig1.label && closedRun[0].signalType === sig1.signalType
    && closedRun[0].confidence === sig1.confidence,
    "forming-bar signal is IDENTICAL (tp/sl/label/type/confidence) to the bar-close engine fire");

  // 3) 15:15 gate at the SCHEDULED close: a forming 5m bar opening 15:10 (closes 15:15) is gated.
  const tGate = et(7, 15, 10);
  assert(evaluateFormingBar({ interval: "5m", formingBar: strongForming(tGate), closedCandles: mkClosed(tGate), zones: [SUPPORT] }) === null,
    "forming bar whose SCHEDULED close is 15:15 ET is suppressed");
  const tOk = et(7, 15, 5);
  assert(evaluateFormingBar({ interval: "5m", formingBar: strongForming(tOk), closedCandles: mkClosed(tOk), zones: [SUPPORT] }) !== null,
    "forming bar closing 15:10 ET still fires");

  // 4) ETH forming bar never fires intra (zone reactions are RTH-only).
  const tEth = et(7, 20, 0);
  assert(evaluateFormingBar({ interval: "5m", formingBar: strongForming(tEth), closedCandles: mkClosed(tEth), zones: [SUPPORT] }) === null,
    "ETH forming bar fires nothing intra-candle");

  // 5) Cooldown honors lastFireTime — INCLUDING a previous intra fire.
  assert(evaluateFormingBar({ interval: "5m", formingBar: strongForming(t1), closedCandles: mkClosed(t1), zones: [SUPPORT], lastFireTime: t1 - 2 * M5 }) === null,
    "forming-bar fire inside the cooldown window is suppressed");
  assert(evaluateFormingBar({ interval: "5m", formingBar: strongForming(t1), closedCandles: mkClosed(t1), zones: [SUPPORT], lastFireTime: t1 - s.COOLDOWN_BARS * M5 }) !== null,
    "forming-bar fire exactly COOLDOWN_BARS after the last fire is allowed");

  // 6) A weak reaction alone does not fire; with real footprint corroboration it does.
  const weakForming = C(t1, 100.7, 102.9, 100.4, 102.5); // move-away 2.5 ≥ N but < 2×N → normal
  assert(evaluateFormingBar({ interval: "5m", formingBar: weakForming, closedCandles: mkClosed(t1), zones: [SUPPORT] }) === null,
    "weak forming-bar reaction alone (1 counted fact) does not fire");
  const withFp = evaluateFormingBar({
    interval: "5m", formingBar: weakForming, closedCandles: mkClosed(t1), zones: [SUPPORT],
    footprintZones: [{ startPrice: 101, endPrice: 102, direction: "buy", levelCount: 3 }],
    qualityGateEnabled: false, // mechanics fixture — the fact-engine@5m class verdict is the gate's own business
  });
  assert(withFp != null && withFp.signalType === "fact-engine", "weak reaction + real footprint corroboration fires as fact-engine");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── QUALITY GATE (shared/quality-gate.ts): the final firing filter ──");
// PER-INTERVAL GATE BARS (2026-07-31): the rule carries one bar per interval. Synthetic
// fixtures use a uniform permissive bar — verdicts in fixtures are hand-authored anyway
// (only MIN_FACTS_OVERRIDE is consulted at fire time; bars are derivation-time inputs).
const TEST_BAR = { MIN_PF: 1.05, MIN_EXPECTANCY_PTS: 0.1 };
const TEST_PER_INTERVAL = { "1m": TEST_BAR, "5m": TEST_BAR, "15m": TEST_BAR, "60m": TEST_BAR };
const synthGate = (over: Partial<QualityGateData>): QualityGateData => ({
  generatedAt: "test", source: "test",
  rule: { perInterval: TEST_PER_INTERVAL, MIN_FACTS_OVERRIDE: 3 },
  multiFact: { n: 0, pf: 0, expectancy: 0 },
  classes: {}, exitByClass: {},
  ...over,
});
{
  // Unit: blocked class / missing class / >=N-fact override.
  const g = synthGate({ classes: { "fact-engine@5m": { n: 500, pf: 0.9, expectancy: -0.2, winRate: 0.3, allowed: false } } });
  assert(qualityGateAllows("fact-engine", "5m", 2, g) === false, "gate: a blocked class is blocked");
  assert(qualityGateAllows("fact-engine", "15m", 2, g) === true, "gate: a class with NO data is never blocked (no data != bad data)");
  assert(qualityGateAllows("zone-reaction", "5m", 1, g) === true, "gate: zone-reaction (structural zero) passes through ungated");
  assert(qualityGateAllows("fact-engine", "5m", 3, g) === true, "gate: >=3 counted facts override a blocked class");

  // The REAL generated config: internal consistency (allowed == ITS interval's bar applied to
  // its own stats — PER-INTERVAL GATE BARS 2026-07-31). lowConfidence entries are EXEMPT:
  // their verdict is carried forward from the previous gate (thin held-out sample), not
  // derived from the window stats — thin never flips at ANY bar.
  const rule = QUALITY_GATE.rule;
  const barOf = (iv: string): { MIN_PF: number; MIN_EXPECTANCY_PTS: number } => rule.perInterval[iv];
  assert(["1m", "5m", "15m", "60m"].every(iv => barOf(iv) != null && barOf(iv).MIN_PF > 0),
    "generated config: a gate bar exists for every interval (per-interval rule shape)");
  const consistent = Object.entries(QUALITY_GATE.classes).every(([k, c]) => {
    const b = barOf(k.split("@")[1]);
    return c.lowConfidence === true || c.allowed === (c.pf >= b.MIN_PF && c.expectancy > b.MIN_EXPECTANCY_PTS);
  });
  assert(consistent, "generated config: class allowed flags are exactly ITS OWN interval's bar applied to its held-out stats (carried-forward thin classes exempt)");
  assert(Object.values(QUALITY_GATE.classes).every(c => c.lowConfidence !== true || typeof c.note === "string"),
    "generated config: every lowConfidence class documents its carried-forward verdict in a note");
  assert(!(classKey("zone-reaction", "5m") in QUALITY_GATE.classes), "generated config: zone-reaction has no class entry (structural zero stays ungated)");
  // COMBO GATE consistency (2026-07-29, per-interval bars 2026-07-31): "<combo>@<interval>"
  // verdicts use THAT interval's bar; all-interval fallback entries must carry an
  // allowedByInterval map consistent with each consulting interval's bar, with the summary
  // `allowed` = ANY interval passes. Carried entries only need map/summary self-consistency.
  const combosConsistent = Object.entries(QUALITY_GATE.comboClasses ?? {}).every(([k, c]) => {
    if (c.lowConfidence === true) {
      return !c.allowedByInterval || c.allowed === Object.values(c.allowedByInterval).some(Boolean);
    }
    if (k.includes("@")) {
      const b = barOf(k.slice(k.lastIndexOf("@") + 1));
      return c.allowedByInterval == null && c.allowed === (c.pf >= b.MIN_PF && c.expectancy > b.MIN_EXPECTANCY_PTS);
    }
    const map = c.allowedByInterval;
    if (!map) return false; // every generated fallback entry must carry the per-interval map
    const perIvOk = Object.entries(map).every(([iv, a]) => {
      const b = barOf(iv);
      return a === (c.pf >= b.MIN_PF && c.expectancy > b.MIN_EXPECTANCY_PTS);
    });
    return perIvOk && c.allowed === Object.values(map).some(Boolean);
  });
  assert(combosConsistent, "generated config: combo verdicts are exactly the per-interval bars applied to each combo's held-out stats (interval-specific at its bar; fallback per consulting interval via allowedByInterval; carried-forward exempt)");
  assert(Object.entries(QUALITY_GATE.comboClasses ?? {}).every(([k, c]) => k.includes("@") ? true : c.allowedByInterval != null || c.lowConfidence === true),
    "generated config: every non-carried all-interval fallback combo carries its allowedByInterval map");
  assert(Object.keys(QUALITY_GATE.comboClasses ?? {}).every(k => !k.startsWith("Zone")), "generated config: no Zone-family combo verdicts exist (structural zero — no uploaded milk-zone history)");
}
{
  // End-to-end wiring: the engine consults the gate. RTH SE+footprint confluence (fact-engine@5m).
  const mkConfluence = (): FactEngineInput => {
    const t0 = et(7, 10, 0);
    const bars = longSeBars(t0, M5, 100);
    for (let k = 5; k <= 8; k++) bars.push(C(t0 + k * M5, 102.2, 102.8, 101.8, 102.4));
    const fpMap = new Map<number, FpImbalanceZone[]>();
    fpMap.set(bars[4].time, [{ startPrice: 99, endPrice: 100, direction: "buy", levelCount: 3 }]);
    return { primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }], zones: [], footprintByTime: fpMap, nowSec: bars[4].time + 600, ictEnabled: false, fractalEnabled: false };
  };
  const blockFe5 = synthGate({ classes: { "fact-engine@5m": { n: 500, pf: 0.9, expectancy: -0.2, winRate: 0.3, allowed: false } } });
  assert(runFactEngine({ ...mkConfluence(), gateData: blockFe5 }).length === 0, "engine: a gate-blocked class emits NOTHING");
  assert(runFactEngine({ ...mkConfluence(), gateData: blockFe5, qualityGateEnabled: false }).length === 1, "engine: qualityGateEnabled:false restores the fire (escape hatch)");

  // Default-ON against the REAL generated config: ETH vse@5m fires iff the config allows it
  // (data-driven — this survives regeneration while proving the engine reads the checked-in file).
  const { input } = ethSeRun({ qualityGateEnabled: undefined });
  delete (input as { qualityGateEnabled?: boolean }).qualityGateEnabled;
  const expected = qualityGateAllows("vector-side-entry", "5m", 1) ? 1 : 0;
  assert(runFactEngine(input).length === expected, `engine default-ON consults the generated config (vse@5m -> ${expected} fires)`);
}
{
  // >=3-fact override end-to-end: SE↑ + yellowbox break↑ + footprint = 3 COUNTED facts fires
  // even when the class is blocked. Vector at 108, box top 109 (breakout close 110 > 109).
  const YB3 = { dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop: 109, boxBottom: 90, initRes: 125, initSup: 80 };
  const t0 = et(7, 10, 0);
  const bars = longSeBars(t0, M5, 108); // breakout bar closes 110 (> box top 109)
  for (let k = 5; k <= 8; k++) bars.push(C(t0 + k * M5, 110.2, 110.8, 109.8, 110.4));
  const fpMap = new Map<number, FpImbalanceZone[]>();
  fpMap.set(bars[4].time, [{ startPrice: 108, endPrice: 109, direction: "buy", levelCount: 3 }]);
  const blockFe5 = synthGate({ classes: { "fact-engine@5m": { n: 500, pf: 0.9, expectancy: -0.2, winRate: 0.3, allowed: false } } });
  const sig = runFactEngine({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 108) }],
    zones: [], dayZones: [YB3], footprintByTime: fpMap, nowSec: bars[4].time + 600, gateData: blockFe5,
    ictEnabled: false, fractalEnabled: false, // exact-count fixture (SE + yb + fp = 3)
  });
  assert(sig.length === 1 && sig[0].facts.filter(f => f.counted).length === 3, ">=3 counted agreeing facts fire through a blocked class (multi-fact override)");
}
{
  // Blocked signals must NOT consume cooldown (invisible signals can't suppress later allowed ones).
  // Gate blocks zone-reaction@5m; MIN_FACTS_OVERRIDE 2 lets a 2-fact confluence pass. A strong solo
  // reaction at t0 is blocked; a reaction+footprint confluence 2 bars later must STILL fire.
  const g = synthGate({
    rule: { perInterval: TEST_PER_INTERVAL, MIN_FACTS_OVERRIDE: 2 },
    classes: { "zone-reaction@5m": { n: 10, pf: 0.5, expectancy: -1, winRate: 0.2, allowed: false } },
  });
  const t0 = et(7, 10, 0);
  const bars: FiringCandle[] = [];
  for (let k = 4; k >= 1; k--) bars.push(C(t0 - k * M5, 102, 102.5, 101.5, 102.2));
  bars.push(C(t0, 100.7, 104.7, 100.4, 104.5));            // strong solo reaction — BLOCKED by gate
  bars.push(C(t0 + M5, 104.5, 104.6, 104, 104.1));
  bars.push(C(t0 + 2 * M5, 101, 105.4, 100.4, 105.2));     // reaction + footprint = 2 counted → passes
  bars.push(C(t0 + 3 * M5, 105.2, 105.5, 104.9, 105.1));
  const fpMap = new Map<number, FpImbalanceZone[]>();
  fpMap.set(t0 + 2 * M5, [{ startPrice: 104, endPrice: 105, direction: "buy", levelCount: 3 }]);
  const base: FactEngineInput = {
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 90) }],
    zones: [SUPPORT], footprintByTime: fpMap, nowSec: t0 + 2 * M5 + 600,
    exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 },
    ictEnabled: false, fractalEnabled: false, // exact fact-count fixture (gate override at 2)
  };
  const gated = runFactEngine({ ...base, gateData: g });
  assert(gated.length === 1 && gated[0].time === t0 + 2 * M5, "a gate-BLOCKED signal does not consume cooldown (later allowed signal still fires)");
  // Control: with nothing blocked, t0 fires and t0+2 IS cooldown-suppressed.
  const control = runFactEngine({ ...base, gateData: synthGate({}) });
  assert(control.length === 1 && control[0].time === t0, "control: when the first signal is allowed, the second is cooldown-suppressed as ever");
}
{
  // Forming-bar path consults the gate identically.
  const t1 = et(7, 10, 30);
  const closed: FiringCandle[] = [];
  for (let k = 6; k >= 1; k--) closed.push(C(t1 - k * M5, 102, 102.5, 101.5, 102.2));
  const forming = C(t1, 100.7, 104.7, 100.4, 104.5);
  const blockZr5 = synthGate({ classes: { "zone-reaction@5m": { n: 10, pf: 0.5, expectancy: -1, winRate: 0.2, allowed: false } } });
  assert(evaluateFormingBar({ interval: "5m", formingBar: forming, closedCandles: closed, zones: [SUPPORT], gateData: blockZr5 }) === null,
    "evaluateFormingBar: a gate-blocked class emits nothing intra-candle");
  assert(evaluateFormingBar({ interval: "5m", formingBar: forming, closedCandles: closed, zones: [SUPPORT], gateData: blockZr5, qualityGateEnabled: false }) !== null,
    "evaluateFormingBar: qualityGateEnabled:false restores the intra fire");
}

console.log("── Per-class Monte-Carlo exit overrides (resolveClassExit) ──");
{
  const g = synthGate({ exitByClass: { "fact-engine@5m": { tp1: 8, sl: 3.5, n: 1234, pool: "fact-engine@5m" } } });
  const base = { ...EXIT_CALIBRATION };
  const r1 = resolveClassExit("fact-engine", "5m", base, undefined, g);
  assert(r1.DEFAULT_TP1_PTS === 8 && r1.DEFAULT_SL_PTS === 3.5, "class override replaces DEFAULT_TP1/SL");
  assert(r1.TP2_MULT === base.TP2_MULT && r1.MIN_TP1_PTS === base.MIN_TP1_PTS, "override touches ONLY the default distances (TP2 stays 2x TP1, anchors untouched)");
  const r2 = resolveClassExit("fact-engine", "5m", base, { DEFAULT_TP1_PTS: 12 }, g);
  assert(r2.DEFAULT_TP1_PTS === 12 && r2.DEFAULT_SL_PTS === 3.5, "caller-explicit exit fields win over the calibration");
  const r3 = resolveClassExit("vector-side-entry", "5m", base, undefined, g);
  assert(r3.DEFAULT_TP1_PTS === base.DEFAULT_TP1_PTS && r3.DEFAULT_SL_PTS === base.DEFAULT_SL_PTS, "class without calibration falls back to the provisional defaults");

  // End-to-end: the engine applies the class exits (SE+footprint confluence, entry 102).
  const t0 = et(7, 10, 0);
  const bars = longSeBars(t0, M5, 100);
  for (let k = 5; k <= 8; k++) bars.push(C(t0 + k * M5, 102.2, 102.8, 101.8, 102.4));
  const fpMap = new Map<number, FpImbalanceZone[]>();
  fpMap.set(bars[4].time, [{ startPrice: 99, endPrice: 100, direction: "buy", levelCount: 3 }]);
  const sig = runFactEngine({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [], footprintByTime: fpMap, nowSec: bars[4].time + 600, gateData: g,
  });
  // TP1-ONLY policy (2026-08-13, default ON): the calibrated TP1/SL still apply; tp2 is NULL.
  assert(sig.length === 1 && sig[0].tp1 === 110 && sig[0].sl === 98.5 && sig[0].tp2 === null,
    `engine applies calibrated exits end-to-end under TP1-only: entry 102 -> TP 110 (+8), SL 98.5 (-3.5), tp2 null (got ${sig[0]?.tp1}/${sig[0]?.sl}/${sig[0]?.tp2})`);
  // Legacy-convention escape hatch (pre-policy fixtures): TP1_ONLY:false restores TP2 = 2x.
  const sigLegacy = runFactEngine({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [], footprintByTime: fpMap, nowSec: bars[4].time + 600, gateData: g,
    settings: { TP1_ONLY: false },
  });
  assert(sigLegacy.length === 1 && sigLegacy[0].tp2 === 118,
    `legacy hatch TP1_ONLY:false restores TP2 118 (2x) (got ${sigLegacy[0]?.tp2})`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── COMBO GATE (2026-07-29): only historically winning fact combinations ──");
{
  // Unit: comboKeyOf — canonical sorted family set over COUNTED, backtestable facts only.
  const facts: Fact[] = [
    F({ strategy: "yellowbox", direction: "Long", kind: "break", driver: true }),
    F({ strategy: "vector", direction: "Long", kind: "side-entry", driver: true }),
    F({ strategy: "vector", direction: "Long", kind: "tabletop", counted: false }),    // label-note — excluded
    F({ strategy: "fractal", direction: "Long", kind: "fco" }),
    F({ strategy: "fractal", direction: "Long", kind: "breakout" }),                   // same family — dedups
    F({ strategy: "moneyline", direction: "Long", kind: "pml", backtestable: false }), // live-only — excluded
  ];
  assert(comboKeyOf(facts) === "Fr+Vec+YB", `comboKeyOf: sorted + deduped over counted backtestable facts (got "${comboKeyOf(facts)}")`);
  assert(comboKeyOf(facts.filter(f => !f.counted)) === "", "comboKeyOf: label-notes alone yield an empty key (never gated)");

  // Unit: comboGateAllows — combo@interval precedence, all-interval fallback, absent = allowed.
  const g = synthGate({ comboClasses: {
    "Vec+YB": { n: 40, pf: 0.91, expectancy: -0.48, winRate: 0.25, allowed: false },
    "Vec+YB@5m": { n: 25, pf: 1.4, expectancy: 1.2, winRate: 0.6, allowed: true },
  } });
  assert(comboGateAllows("Vec+YB", "5m", g) === true, "comboGateAllows: combo@interval verdict wins over the all-interval fallback");
  assert(comboGateAllows("Vec+YB", "1m", g) === false, "comboGateAllows: intervals without their own verdict fall back to the all-interval combo (legacy summary allowed — back-compat)");
  assert(comboGateAllows("FG+Vec", "5m", g) === true, "comboGateAllows: an unjudged (thin/absent) combo is never blocked");
  assert(comboGateAllows("", "5m", g) === true, "comboGateAllows: empty combo key never blocks");
  assert(comboGateAllows("Vec+YB", "1m", synthGate({})) === true, "comboGateAllows: a config without comboClasses blocks nothing");

  // PER-INTERVAL GATE BARS (2026-07-31): an all-interval fallback verdict is evaluated at the
  // CONSULTING interval's bar (allowedByInterval) — the SAME held-out record can clear the 60m
  // bar (1.5/3) while failing the 1m bar (2.0/5).
  const gIv = synthGate({ comboClasses: {
    "Fr+YB": { n: 100, pf: 1.6, expectancy: 3.4, winRate: 0.55, allowed: true,
               allowedByInterval: { "1m": false, "5m": false, "15m": false, "60m": true } },
  } });
  assert(comboGateAllows("Fr+YB", "60m", gIv) === true, "per-interval bars: the fallback combo is ALLOWED consulted from 60m (its bar passes)");
  assert(comboGateAllows("Fr+YB", "1m", gIv) === false, "per-interval bars: the SAME fallback record is BLOCKED consulted from 1m (fails the stricter 1m bar)");
  assert(comboGateAllows("Fr+YB", "5m", gIv) === false, "per-interval bars: blocked consulted from 5m too (allowedByInterval wins over the summary allowed)");
  const gIv2 = synthGate({ comboClasses: {
    "Fr+YB@1m": { n: 25, pf: 2.4, expectancy: 6, winRate: 0.6, allowed: true },
    "Fr+YB": { n: 100, pf: 1.6, expectancy: 3.4, winRate: 0.55, allowed: true,
               allowedByInterval: { "1m": false, "5m": false, "15m": false, "60m": true } },
  } });
  assert(comboGateAllows("Fr+YB", "1m", gIv2) === true, "per-interval bars: an interval-specific verdict still wins over the fallback's per-interval map");
  // THIN carry at per-interval bars: a carried (lowConfidence) fallback keeps its carried
  // verdict at EVERY consulting interval — stats that would clear a bar never flip it.
  const gCarry = synthGate({ comboClasses: {
    "FG+ICT+YB": { n: 13, pf: 1.9, expectancy: 5.5, winRate: 0.54, allowed: false, lowConfidence: true,
                   allowedByInterval: { "1m": false, "5m": false, "15m": false, "60m": false } },
  } });
  for (const iv of ["1m", "5m", "15m", "60m"]) {
    assert(comboGateAllows("FG+ICT+YB", iv, gCarry) === false, `per-interval bars: carried THIN fallback stays BLOCKED consulted from ${iv} (thin never flips at any bar)`);
  }
}
{
  // End-to-end: SE↑ + primary yellowbox break↑ + footprint = 3 COUNTED facts (combo FP+Vec+YB).
  // The >=3-fact override bypasses the CLASS gate — but a BLOCKED COMBO suppresses it anyway
  // (the whole point: Fr+ICT+Vec+YB is a 4-fact historical loser).
  const YB3 = { dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop: 109, boxBottom: 90, initRes: 125, initSup: 80 };
  const mk3Fact = (): FactEngineInput => {
    const t0 = et(7, 10, 0);
    const bars = longSeBars(t0, M5, 108); // breakout bar closes 110 (> box top 109)
    for (let k = 5; k <= 8; k++) bars.push(C(t0 + k * M5, 110.2, 110.8, 109.8, 110.4));
    const fpMap = new Map<number, FpImbalanceZone[]>();
    fpMap.set(bars[4].time, [{ startPrice: 108, endPrice: 109, direction: "buy", levelCount: 3 }]);
    return {
      primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 108) }],
      zones: [], dayZones: [YB3], footprintByTime: fpMap, nowSec: bars[4].time + 600,
      ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false, // exact combo fixture (FP+Vec+YB)
    };
  };
  const blockedCls = { "fact-engine@5m": { n: 500, pf: 0.9, expectancy: -0.2, winRate: 0.3, allowed: false } };
  const loserCombo = synthGate({ classes: blockedCls, comboClasses: { "FP+Vec+YB": { n: 53, pf: 0.96, expectancy: -0.28, winRate: 0.4, allowed: false } } });
  assert(runFactEngine({ ...mk3Fact(), gateData: loserCombo }).length === 0,
    "a BLOCKED combo suppresses even a >=3-counted-fact signal (class-gate override does NOT bypass the combo gate)");
  assert(runFactEngine({ ...mk3Fact(), gateData: loserCombo, qualityGateEnabled: false }).length === 1,
    "qualityGateEnabled:false disables combo gating too (escape hatch)");
  const winnerCombo = synthGate({ classes: blockedCls, comboClasses: { "FP+Vec+YB@5m": { n: 73, pf: 2.71, expectancy: 4.23, winRate: 0.82, allowed: true } } });
  assert(runFactEngine({ ...mk3Fact(), gateData: winnerCombo }).length === 1,
    "an ALLOWED combo@interval fires through (winner combination passes)");
  const otherCombo = synthGate({ classes: blockedCls, comboClasses: { "Fr+ICT+Vec+YB": { n: 53, pf: 0.96, expectancy: -0.28, winRate: 0.4, allowed: false } } });
  assert(runFactEngine({ ...mk3Fact(), gateData: otherCombo }).length === 1,
    "a thin/absent combo falls through to the class verdict (here: >=3-fact override through the blocked class)");
  // Interval precedence end-to-end: all-interval BLOCKED but 5m ALLOWED → the 5m signal fires.
  const ivWins = synthGate({ classes: blockedCls, comboClasses: {
    "FP+Vec+YB": { n: 40, pf: 0.9, expectancy: -0.5, winRate: 0.3, allowed: false },
    "FP+Vec+YB@5m": { n: 25, pf: 1.4, expectancy: 1.2, winRate: 0.6, allowed: true },
  } });
  assert(runFactEngine({ ...mk3Fact(), gateData: ivWins }).length === 1,
    "engine consult honors combo@interval precedence over the all-interval fallback");
  // PER-INTERVAL GATE BARS end-to-end (2026-07-31): the fallback's allowedByInterval verdict
  // AT THE CONSULTING INTERVAL governs — and the >=3-fact override remains subject to it.
  const perIvBlock5m = synthGate({ classes: blockedCls, comboClasses: {
    "FP+Vec+YB": { n: 53, pf: 1.8, expectancy: 4.5, winRate: 0.6, allowed: true,
                   allowedByInterval: { "1m": true, "5m": false, "15m": true, "60m": true } },
  } });
  assert(runFactEngine({ ...mk3Fact(), gateData: perIvBlock5m }).length === 0,
    "engine: a fallback combo BLOCKED at the consulting (5m) bar suppresses even the >=3-fact override, though other intervals allow it");
  const perIvAllow5m = synthGate({ classes: blockedCls, comboClasses: {
    "FP+Vec+YB": { n: 53, pf: 1.8, expectancy: 4.5, winRate: 0.6, allowed: true,
                   allowedByInterval: { "1m": false, "5m": true, "15m": false, "60m": false } },
  } });
  assert(runFactEngine({ ...mk3Fact(), gateData: perIvAllow5m }).length === 1,
    "engine: the same fallback record ALLOWED at the consulting (5m) bar fires through");
}
{
  // EXEMPT: strong milk-zone solo (zone-reaction) fires despite a blocked "Zone" combo.
  const t0 = et(7, 10, 0);
  const bars: FiringCandle[] = [];
  for (let k = 4; k >= 1; k--) bars.push(C(t0 - k * M5, 102, 102.5, 101.5, 102.2));
  bars.push(C(t0, 100.7, 104.7, 100.4, 104.5)); // strong Long reaction off SUPPORT
  bars.push(C(t0 + M5, 104.5, 105, 104, 104.6));
  const blockZone = synthGate({ comboClasses: {
    "Zone": { n: 30, pf: 0.5, expectancy: -1, winRate: 0.2, allowed: false },
    "Zone@5m": { n: 30, pf: 0.5, expectancy: -1, winRate: 0.2, allowed: false },
  } });
  const sig = runFactEngine({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 90) }],
    zones: [SUPPORT], nowSec: t0 + 600, gateData: blockZone,
    ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false, // solo-zone fixture (the D13 lesson)
  });
  assert(sig.length === 1 && sig[0].signalType === "zone-reaction",
    "EXEMPT: strong milk-zone solo (zone-reaction) is never combo-gated (structural rule, zero data class)");
}
{
  // EXEMPT: ETH solo vector-side-entry fires despite a blocked "Vec" combo.
  const g = synthGate({
    classes: { "vector-side-entry@5m": { n: 100, pf: 1.5, expectancy: 1, winRate: 0.6, allowed: true } },
    comboClasses: { "Vec": { n: 30, pf: 0.5, expectancy: -1, winRate: 0.2, allowed: false }, "Vec@5m": { n: 30, pf: 0.5, expectancy: -1, winRate: 0.2, allowed: false } },
  });
  // ESCAPE HATCH mode isolates the structural vse exemption (default-ON would attach
  // corroborators and change the type to fact-engine, which IS combo-gated — by design).
  const { input, seTime } = ethSeRun({ qualityGateEnabled: true, gateData: g, settings: { ETH_CONFLUENCE: false } });
  const sig = runFactEngine(input);
  assert(sig.length === 1 && sig[0].time === seTime && sig[0].signalType === "vector-side-entry",
    "EXEMPT: ETH solo vector-side-entry is never combo-gated (structural rule, zero data class)");
}
{
  // Forming-bar path consults the combo gate identically (zone+footprint = combo FP+Zone).
  const t1 = et(7, 10, 30);
  const closed: FiringCandle[] = [];
  for (let k = 6; k >= 1; k--) closed.push(C(t1 - k * M5, 102, 102.5, 101.5, 102.2));
  const forming = C(t1, 100.7, 104.7, 100.4, 104.5);
  const fpz: FpImbalanceZone[] = [{ startPrice: 103.5, endPrice: 104.5, direction: "buy", levelCount: 3 }];
  const blockFpZone = synthGate({ comboClasses: { "FP+Zone": { n: 30, pf: 0.5, expectancy: -1, winRate: 0.2, allowed: false } } });
  assert(evaluateFormingBar({ interval: "5m", formingBar: forming, closedCandles: closed, zones: [SUPPORT], footprintZones: fpz, gateData: blockFpZone }) === null,
    "evaluateFormingBar: a combo-blocked confluence emits nothing intra-candle");
  assert(evaluateFormingBar({ interval: "5m", formingBar: forming, closedCandles: closed, zones: [SUPPORT], footprintZones: fpz, gateData: synthGate({}) }) !== null,
    "evaluateFormingBar control: the same confluence fires without a combo verdict");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── PER-COMBO EXITS (2026-07-29): winning combinations carry their own calibration ──");
{
  // Unit: comboExitOverrideFor — "<combo>@<interval>" keys ONLY (no all-interval fallback).
  const g = synthGate({
    exitByClass: { "fact-engine@5m": { tp1: 8, sl: 3.5, n: 63, pool: "its own trades" } },
    exitByCombo: { "FP+Vec@5m": { tp1: 12, sl: 6, n: 44, pool: "its own trades" } },
  });
  assert(comboExitOverrideFor("FP+Vec", "5m", g)?.tp1 === 12, "comboExitOverrideFor: combo@interval hit returns the combo exit");
  assert(comboExitOverrideFor("FP+Vec", "15m", g) === null, "comboExitOverrideFor: NO all-interval fallback (exit distances are interval-scale-sensitive)");
  assert(comboExitOverrideFor("Fr+YB", "5m", g) === null, "comboExitOverrideFor: uncalibrated combo returns null");
  assert(comboExitOverrideFor("", "5m", g) === null, "comboExitOverrideFor: empty combo key returns null");
  assert(comboExitOverrideFor("FP+Vec", "5m", synthGate({})) === null, "comboExitOverrideFor: a config without exitByCombo returns null");

  // Resolution ORDER: caller-explicit > combo exit > class exit > provisional.
  const base = { ...EXIT_CALIBRATION };
  const r1 = resolveExitCalibration("fact-engine", "5m", "FP+Vec", base, undefined, g);
  assert(r1.DEFAULT_TP1_PTS === 12 && r1.DEFAULT_SL_PTS === 6, "resolution: combo exit BEATS the class exit");
  assert(r1.TP2_MULT === base.TP2_MULT && r1.MIN_TP1_PTS === base.MIN_TP1_PTS && r1.TP_ANCHOR_BUFFER_PTS === base.TP_ANCHOR_BUFFER_PTS,
    "resolution: combo exit touches ONLY the default distances (TP2 mult + anchor geometry untouched)");
  const r2 = resolveExitCalibration("fact-engine", "5m", "Fr+YB", base, undefined, g);
  assert(r2.DEFAULT_TP1_PTS === 8 && r2.DEFAULT_SL_PTS === 3.5, "resolution: combo without its own exit falls back to the CLASS exit");
  const r3 = resolveExitCalibration("fact-engine", "15m", "Fr+YB", base, undefined, g);
  assert(r3.DEFAULT_TP1_PTS === base.DEFAULT_TP1_PTS && r3.DEFAULT_SL_PTS === base.DEFAULT_SL_PTS,
    "resolution: no combo AND no class calibration -> provisional defaults");
  const r4 = resolveExitCalibration("fact-engine", "5m", "FP+Vec", base, { DEFAULT_TP1_PTS: 9 }, g);
  assert(r4.DEFAULT_TP1_PTS === 9 && r4.DEFAULT_SL_PTS === 6, "resolution: caller-explicit fields WIN over the combo exit");
  const gVse = synthGate({ exitByCombo: { "Vec@5m": { tp1: 7, sl: 3, n: 99, pool: "x" } } });
  const r5 = resolveExitCalibration("vector-side-entry", "5m", "Vec", base, undefined, gVse);
  assert(r5.DEFAULT_TP1_PTS === base.DEFAULT_TP1_PTS, "EXEMPT: vector-side-entry never takes a combo exit (structural rule — class exits only)");
  const gZone = synthGate({ exitByCombo: { "Zone@5m": { tp1: 7, sl: 3, n: 99, pool: "x" } } });
  const r6 = resolveExitCalibration("zone-reaction", "5m", "Zone", base, undefined, gZone);
  assert(r6.DEFAULT_TP1_PTS === base.DEFAULT_TP1_PTS, "EXEMPT: zone-reaction never takes a combo exit (structural rule — class exits only)");
  const r7 = resolveClassExit("fact-engine", "5m", base, undefined, g);
  assert(r7.DEFAULT_TP1_PTS === 8 && r7.DEFAULT_SL_PTS === 3.5, "back-compat: resolveClassExit ignores exitByCombo entirely (class-only view)");
}
{
  // End-to-end: the SAME 3-fact FP+Vec+YB@5m fixture as the combo-gate suite (entry 110,
  // yellowbox initRes anchor at 125 → dist 15). The engine must apply the COMBO exits, and the
  // zone/yellowbox TP1 anchor priority must survive them.
  const YB3 = { dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop: 109, boxBottom: 90, initRes: 125, initSup: 80 };
  const mk3Fact = (): FactEngineInput => {
    const t0 = et(7, 10, 0);
    const bars = longSeBars(t0, M5, 108); // breakout bar closes 110 (> box top 109)
    for (let k = 5; k <= 8; k++) bars.push(C(t0 + k * M5, 110.2, 110.8, 109.8, 110.4));
    const fpMap = new Map<number, FpImbalanceZone[]>();
    fpMap.set(bars[4].time, [{ startPrice: 108, endPrice: 109, direction: "buy", levelCount: 3 }]);
    return {
      primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 108) }],
      zones: [], dayZones: [YB3], footprintByTime: fpMap, nowSec: bars[4].time + 600,
      ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false, // exact combo fixture (FP+Vec+YB)
    };
  };
  // Combo exit within the anchor's room (TP1 12 < anchor dist 15) → default-distance geometry
  // from the COMBO calibration: TP1 122 (+12), SL 104 (−6), TP2 134 (2×12).
  const comboExitG = synthGate({
    exitByClass: { "fact-engine@5m": { tp1: 8, sl: 3.5, n: 63, pool: "its own trades" } },
    exitByCombo: { "FP+Vec+YB@5m": { tp1: 12, sl: 6, n: 44, pool: "its own trades" } },
  });
  const sigC = runFactEngine({ ...mk3Fact(), gateData: comboExitG });
  // TP1-ONLY policy (2026-08-13, default ON): combo TP1/SL apply; tp2 is NULL.
  assert(sigC.length === 1 && sigC[0].tp1 === 122 && sigC[0].sl === 104 && sigC[0].tp2 === null,
    `engine applies COMBO exits end-to-end under TP1-only: entry 110 -> TP 122 (+12), SL 104 (-6), tp2 null (got ${sigC[0]?.tp1}/${sigC[0]?.sl}/${sigC[0]?.tp2})`);
  // Control: same config WITHOUT the combo entry → the class exit governs (TP1 118, SL 106.5).
  const classOnlyG = synthGate({ exitByClass: { "fact-engine@5m": { tp1: 8, sl: 3.5, n: 63, pool: "its own trades" } } });
  const sigK = runFactEngine({ ...mk3Fact(), gateData: classOnlyG });
  assert(sigK.length === 1 && sigK[0].tp1 === 118 && sigK[0].sl === 106.5,
    `control: without a combo entry the CLASS exit governs (TP1 118/SL 106.5; got ${sigK[0]?.tp1}/${sigK[0]?.sl})`);
  // Anchor priority intact: a WIDE combo TP1 (20 > anchor dist 15) still anchors TP1 to the
  // yellowbox initRes (125 − 1 buffer = 124) — the combo calibration only moves the DEFAULTS.
  const wideComboG = synthGate({ exitByCombo: { "FP+Vec+YB@5m": { tp1: 20, sl: 6, n: 44, pool: "its own trades" } } });
  const sigA = runFactEngine({ ...mk3Fact(), gateData: wideComboG });
  assert(sigA.length === 1 && sigA[0].tp1 === 124 && sigA[0].sl === 104,
    `anchor priority survives combo exits: yellowbox initRes anchors TP1 at 124, combo SL 104 (got ${sigA[0]?.tp1}/${sigA[0]?.sl})`);
  // 15m path: the identical fixture on the 15m primary with an allowed FP+Vec+YB@15m combo +
  // its own combo exit — the mission's "allowed 15m combo fires with the correct combo exit".
  const mk15 = (): FactEngineInput => {
    const t0 = et(7, 10, 0);
    const bars = longSeBars(t0, M15, 108);
    for (let k = 5; k <= 8; k++) bars.push(C(t0 + k * M15, 110.2, 110.8, 109.8, 110.4));
    const fpMap = new Map<number, FpImbalanceZone[]>();
    fpMap.set(bars[4].time, [{ startPrice: 108, endPrice: 109, direction: "buy", levelCount: 3 }]);
    return {
      primary: "15m", slices: [{ interval: "15m", candles: bars, vector: vec(bars, 108) }],
      zones: [], dayZones: [YB3], footprintByTime: fpMap, nowSec: bars[4].time + 3 * M15,
      ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false,
    };
  };
  const combo15G = synthGate({
    classes: { "fact-engine@15m": { n: 500, pf: 0.9, expectancy: -0.2, winRate: 0.3, allowed: false } }, // blocked class — 3 facts override it
    comboClasses: { "FP+Vec+YB@15m": { n: 40, pf: 2.24, expectancy: 3.1, winRate: 0.7, allowed: true } },
    exitByCombo: { "FP+Vec+YB@15m": { tp1: 13, sl: 7, n: 40, pool: "its own trades" } },
  });
  const sig15 = runFactEngine({ ...mk15(), gateData: combo15G });
  assert(sig15.length === 1 && sig15[0].tp1 === 123 && sig15[0].sl === 103 && sig15[0].interval === "15m",
    `15m: an ALLOWED combo fires WITH its combo exit (entry 110 -> TP1 123 (+13), SL 103 (-7); got ${sig15[0]?.tp1}/${sig15[0]?.sl})`);
  // Negative twin (mission assurance): the SAME 15m bar sequence with the combo BLOCKED stays
  // silent — 3 counted facts do NOT bypass the combo gate.
  const blocked15G = synthGate({
    classes: { "fact-engine@15m": { n: 500, pf: 0.9, expectancy: -0.2, winRate: 0.3, allowed: false } },
    comboClasses: { "FP+Vec+YB@15m": { n: 40, pf: 0.74, expectancy: -2.55, winRate: 0.33, allowed: false } },
    exitByCombo: { "FP+Vec+YB@15m": { tp1: 13, sl: 7, n: 40, pool: "its own trades" } },
  });
  assert(runFactEngine({ ...mk15(), gateData: blocked15G }).length === 0,
    "15m negative twin: the same sequence under a BLOCKED combo emits NOTHING (>=3 facts do not bypass)");
  // Forming-bar path applies combo exits identically (zone+footprint = combo FP+Zone).
  const t1 = et(7, 10, 30);
  const closed: FiringCandle[] = [];
  for (let k = 6; k >= 1; k--) closed.push(C(t1 - k * M5, 102, 102.5, 101.5, 102.2));
  const forming = C(t1, 100.7, 104.7, 100.4, 104.5); // strong Long reaction off SUPPORT, close 104.5
  const fpz: FpImbalanceZone[] = [{ startPrice: 103.5, endPrice: 104.5, direction: "buy", levelCount: 3 }];
  const fbG = synthGate({ exitByCombo: { "FP+Zone@5m": { tp1: 14, sl: 6.5, n: 40, pool: "its own trades" } } });
  const fb = evaluateFormingBar({ interval: "5m", formingBar: forming, closedCandles: closed, zones: [SUPPORT], footprintZones: fpz, gateData: fbG });
  assert(fb != null && fb.tp1 === 118.5 && fb.sl === 98,
    `evaluateFormingBar applies combo exits: entry 104.5 -> TP1 118.5 (+14), SL 98 (-6.5) (got ${fb?.tp1}/${fb?.sl})`);
}
{
  // Generated-config consistency for exitByCombo (regen writes it; synthetic configs may omit it):
  // every key is "<combo>@<interval>", never a structural-class combo ("Vec" solo = vse), and
  // never an exit for a combo the combo gate BLOCKS at that interval (dead config otherwise).
  const entries = Object.entries(QUALITY_GATE.exitByCombo ?? {});
  assert(entries.every(([k]) => k.includes("@")), "generated config: every exitByCombo key is combo@interval");
  assert(entries.every(([k]) => k.slice(0, k.lastIndexOf("@")) !== "Vec" && !k.startsWith("Zone@")),
    "generated config: no exitByCombo entries for structural classes (vse solo Vec / zone-reaction solo Zone)");
  assert(entries.every(([k]) => {
    const combo = k.slice(0, k.lastIndexOf("@")), iv = k.slice(k.lastIndexOf("@") + 1);
    return comboGateAllows(combo, iv, QUALITY_GATE);
  }), "generated config: every exitByCombo entry belongs to a combo the combo gate ALLOWS at that interval");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── ICT + FRACTAL CORROBORATORS (2026-07-15): facts, NOT strategies ──");
{
  // decide-level: the user's design rules on hand-made facts.
  const ybP = F({ strategy: "yellowbox", direction: "Long", kind: "break", weight: 2, driver: true });
  const ictL = F({ strategy: "ict", direction: "Long", kind: "sweep", weight: 1, label: "ICT Sweep(@100.00, NY-AM)" });
  const fracL = F({ strategy: "fractal", direction: "Long", kind: "breakout", weight: 1, label: "Fractal(breakout↑ @99.50)" });
  const bandL = F({ strategy: "fractal", direction: "Long", kind: "band", weight: 1 });

  // THE USER'S EXAMPLE (verbatim design): primary yellowbox break (driver, 1 fact) + one ICT
  // agreeing fact + one fractal agreeing fact = 3 agreeing facts → FIRES.
  const d = decide([ybP, ictL, fracL], [], true, s);
  assert(d?.direction === "Long" && d.facts.filter(f => f.counted).length === 3,
    "USER EXAMPLE: yellowbox driver + 1 ICT + 1 fractal = 3 agreeing facts → fires");
  assert(d != null && signalTypeOf(d.facts, true) === "fact-engine",
    "user example keeps signalType fact-engine (taxonomy unchanged — facts appear in the label only)");

  // HARD RULE 1: corroborators can NEVER fire without a core driver — even 3 of them.
  assert(decide([ictL, fracL, bandL], [], true, s) === null,
    "HARD RULE: ICT+fractal alone (3 counted facts, NO core driver) can NEVER fire");

  // Rule 4: opposing ICT/fractal facts weigh into the contradiction rule at their weight.
  const seP = F({ strategy: "vector", direction: "Long", kind: "side-entry", weight: 3, driver: true });
  const fpL = F({ strategy: "footprint", direction: "Long", kind: "support", weight: 1 });
  const ictS = F({ strategy: "ict", direction: "Short", kind: "breaker", weight: 1 });
  const fracS = F({ strategy: "fractal", direction: "Short", kind: "breakout", weight: 1 });
  const fcoS = F({ strategy: "fractal", direction: "Short", kind: "fco", weight: 1 });
  assert(decide([seP, fpL], [ictS], true, s)?.direction === "Long",
    "one opposing corroborator (weight 1) does not stalemate a weight-4 side (margin holds)");
  assert(decide([seP, fpL], [ictS, fracS, fcoS], true, s) === null,
    "rule 4: stacked opposing ICT/fractal facts (weight 3 vs 4) reach the margin → stalemate, nothing fires");

  // Rule 5 mechanics: chop contra weight suppresses a marginal breakout-driven side.
  assert(decide([ybP, fpL], [], true, s, { long: 2, short: 0 }) === null,
    "CHOP: contra weight 2 against a yellowbox-driven side (weight 3) → 1 < margin → suppressed");
  assert(decide([ybP, fpL], [], true, s)?.direction === "Long",
    "control: the same facts with no chop contra fire");
}

// The e2e fixture — a genuine everything-agrees bar (Tue Jul 7, fire 10:30 ET → NY-AM kill zone):
//   • bar 3  (ETH): spike low 95 → resting swing low (27 bars old at fire = sweepable liquidity)
//   • bar 20 (RTH): spike high 108 → Williams up-fractal, confirmed bar 22, unbroken until fire
//   • fire bar 30: wick to 94.5 sweeps the 95 low, closes 113 back above it WITH displacement
//     (ICT Sweep), close 113 > 110 box top (yellowbox DRIVER), close > 108 fractal (breakout↑),
//     and FCO(+1.00) trending — the full user example, end to end.
function deluxeRun(): { bars: FiringCandle[]; fire: number; ybox: { dayKeyET: string; sessionStartTs: number; sessionEndTs: number; boxTop: number; boxBottom: number; initRes: number; initSup: number } } {
  const fire = et(7, 10, 30);
  const t = (k: number) => fire - (30 - k) * M5; // bar 0 opens 8:00 ET
  const bars: FiringCandle[] = [];
  for (let k = 0; k < 30; k++) {
    if (k === 3) bars.push(C(t(k), 104.9, 105.5, 95, 105.1));        // spike low (swing-low liquidity)
    else if (k === 20) bars.push(C(t(k), 104.9, 108, 104.5, 105.1)); // spike high (up-fractal 108)
    else bars.push(C(t(k), 104.9, 105.5, 104.5, 105.1));             // quiet, inside the box
  }
  bars.push(C(t(30), 105, 113.5, 94.5, 113));                        // THE bar
  for (let k = 31; k <= 33; k++) bars.push(C(t(k), 113, 113.6, 112.6, 113.2));
  const ybox = { dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop: 110, boxBottom: 90, initRes: 118, initSup: 82 };
  return { bars, fire, ybox };
}
{
  const { bars, fire, ybox } = deluxeRun();
  const gAll = synthGate({});
  const mk = (over?: Partial<FactEngineInput>): FactEngineInput => ({
    primary: "5m",
    slices: [{ interval: "5m", candles: bars, vector: vec(bars, 80) }], // vector far — no vector facts
    zones: [], dayZones: [ybox], nowSec: fire + 600,
    exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 }, gateData: gAll,
    ...over,
  });

  const sig = runFactEngine(mk());
  assert(sig.length === 1 && sig[0].time === fire && sig[0].direction === "Long",
    "USER EXAMPLE e2e: yellowbox break + ICT sweep + fractal breakout fires ONCE on the bar");
  const counted = sig[0]?.facts.filter(f => f.counted) ?? [];
  assert(counted.length >= 3 && counted.some(f => f.strategy === "yellowbox" && f.driver)
    && counted.some(f => f.strategy === "ict") && counted.some(f => f.strategy === "fractal"),
    `USER EXAMPLE e2e: >=3 agreeing facts incl. the driver + ICT + fractal (got ${counted.length})`);
  assert(sig[0]?.signalType === "fact-engine", "e2e signalType stays fact-engine (no new taxonomy)");
  assert(sig[0]?.label.includes("Yellowbox(break↑ @110.00)") === true, "label names the driver");
  assert(sig[0]?.label.includes("ICT Sweep(@95.00, NY-AM)") === true,
    `label carries the explicit ICT fragment WITH the kill-zone flag (got "${sig[0]?.label}")`);
  assert(sig[0]?.label.includes("Fractal(breakout↑ @108.00)") === true, "label carries the explicit fractal fragment");
  assert(sig[0]?.label.includes("FCO(+1.00 trending)") === true, "label carries the FCO fragment");

  // HARD RULE 1 e2e: remove the yellowbox → sweep + breakout + FCO (3 counted, 0 drivers) = NOTHING.
  assert(runFactEngine(mk({ dayZones: [] })).length === 0,
    "HARD RULE e2e: ICT+fractal agreement WITHOUT a core driver fires NOTHING");

  // Toggles gate the enumeration (adapter passes the two new CONFIRMATION toggles here).
  const noIct = runFactEngine(mk({ ictEnabled: false }));
  assert(noIct.length === 1 && noIct[0].facts.every(f => f.strategy !== "ict"),
    "ictEnabled:false strips ICT facts (signal still fires on yellowbox + fractal)");
  const noFrac = runFactEngine(mk({ fractalEnabled: false }));
  assert(noFrac.length === 1 && noFrac[0].facts.every(f => f.strategy !== "fractal"),
    "fractalEnabled:false strips fractal facts (signal still fires on yellowbox + ICT)");
}

{
  // RULE 3 under the ESCAPE HATCH (ETH_CONFLUENCE:false): corroborators never enumerate in
  // ETH. The ETH side-entry bar has a strongly trending FCO — if fractal facts leaked, one
  // would attach here.
  const { input } = ethSeRun({ settings: { ETH_CONFLUENCE: false } }); // ict/fractal DEFAULT ON — that is the point
  const sig = runFactEngine(input);
  assert(sig.length === 1 && sig[0].facts.every(f => f.strategy !== "ict" && f.strategy !== "fractal"),
    "RULE 3: ETH signal carries ZERO ict/fractal facts (ETH stays pure solo vector side-entry)");
  assert(sig[0]?.signalType === "vector-side-entry", "RULE 3: ETH signalType untouched by the corroborators");
  // DEFAULT (2026-08-11): the same run now lets corroborators attach overnight.
  const on = runFactEngine(ethSeRun().input);
  assert(on.length >= 1 && on.some(x => x.facts.some(f => f.strategy === "ict" || f.strategy === "fractal")),
    "ETH-CONFLUENCE default: ict/fractal corroborators attach to ETH signals");
}

// CHOP e2e — flat chaos bands (112/104, both >10 bars old) + |FCO|=0.07, price boxed inside.
// The fire bar closes 110.2, just over the 110 box top: a breakout-type driver INTO chop.
function chopRun(): { bars: FiringCandle[]; fire: number; ybox: { dayKeyET: string; sessionStartTs: number; sessionEndTs: number; boxTop: number; boxBottom: number; initRes: number; initSup: number }; fp: Map<number, FpImbalanceZone[]> } {
  const fire = et(7, 10, 30);
  const t = (k: number) => fire - (24 - k) * M5; // bar 0 opens 8:30 ET
  const bars: FiringCandle[] = [];
  for (let k = 0; k < 24; k++) {
    if (k === 5) bars.push(C(t(k), 109.8, 112, 108.6, 108.9));      // up-fractal 112 (confirmed bar 7)
    else if (k === 8) bars.push(C(t(k), 108.9, 110, 104, 109.9));   // down-fractal 104 (confirmed bar 10)
    else if (k % 2 === 0) bars.push(C(t(k), 108.9, 110, 108.5, 109.9));
    else bars.push(C(t(k), 109.8, 110, 108.6, 108.9));              // period-2 churn — no new fractals (ties)
  }
  bars.push(C(t(24), 108.9, 110.5, 108.6, 110.2));                  // box-break↑ INTO chop
  for (let k = 25; k <= 27; k++) bars.push(C(t(k), 110.2, 110.6, 109.9, 110.3));
  const ybox = { dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop: 110, boxBottom: 90, initRes: 130, initSup: 70 };
  const fp = new Map<number, FpImbalanceZone[]>();
  fp.set(fire, [{ startPrice: 109, endPrice: 110, direction: "buy", levelCount: 3 }]);
  return { bars, fire, ybox, fp };
}
{
  const { bars, fire, ybox, fp } = chopRun();
  const gAll = synthGate({});
  const mk = (over?: Partial<FactEngineInput>): FactEngineInput => ({
    primary: "5m",
    slices: [{ interval: "5m", candles: bars, vector: vec(bars, 80) }],
    zones: [], dayZones: [ybox], footprintByTime: fp, nowSec: fire + 600,
    exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 }, gateData: gAll,
    ictEnabled: false, // isolate the fractal chop rule
    ...over,
  });

  // Yellowbox break (2) + footprint (1) = weight 3; chop contra = 2 (flat bands + low FCO)
  // → 1 < CONTRADICTION_MARGIN → suppressed. RULE 5, end to end.
  assert(runFactEngine(mk()).length === 0,
    "CHOP e2e: box-break + footprint INTO flat-band/low-FCO chop is SUPPRESSED (contra 2 vs weight 3)");
  assert(runFactEngine(mk({ settings: { CHOP_CONTRADICTS: false } })).length === 1,
    "CHOP e2e control: CHOP_CONTRADICTS:false restores the fire (isolates the rule)");
  assert(runFactEngine(mk({ fractalEnabled: false })).length === 1,
    "CHOP e2e control: fractalEnabled:false also restores it (chop is a fractal reading)");

  // Reversal-type drivers are UNTOUCHED by chop: the same chop bars with a milk-zone REACTION
  // driver instead of the box-break (no dayZones) still fire — chop argues against breakouts only.
  const RXZONE: FiringZone = { topPrice: 108, bottomPrice: 106, color: "#22c55e", label: "support", fromTime: et(7, 0, 0) };
  const zBars = [...bars];
  zBars[24] = C(fire, 108.9, 110.5, 107.9, 110.2); // wick 107.9 touches the 108 zone top, closes +2.2 away
  const zSig = runFactEngine(mk({ slices: [{ interval: "5m", candles: zBars, vector: vec(zBars, 80) }], zones: [RXZONE], dayZones: [] }));
  assert(zSig.length === 1 && zSig[0].facts.some(f => f.strategy === "zone"),
    "CHOP e2e: a zone-REACTION-driven signal in the same chop is NOT suppressed (rule targets breakout drivers)");
}

// ═════════════════════════════════════════════════════════════════════════════
// FRACTAL-GEOMETRY GUIDE corroborators (2026-07-15 study mission) — same contract as
// ICT/fractal: counted, never drivers, RTH-only; chase/exhaustion are CONTRA warnings.
console.log("── fractal-geometry corroborators: complete confluence, never drive ──");
{
  // 2 bars above the vector, 4-bar false break below, then the SE↑ breakout bar: the fire bar
  // is BOTH the side-entry driver AND an FG Reclaim event. In RTH a solo SE (1 counted fact)
  // cannot fire — the FG reclaim is the second agreeing fact that completes the confluence.
  const t0 = et(8, 10, 0);
  const pre = [C(t0 - 2 * M5, 100.2, 100.9, 99.9, 100.6), C(t0 - M5, 100.4, 100.8, 99.9, 100.3)];
  const bars = [...pre, ...longSeBars(t0, M5, 100)];
  const mkFg = (over: Partial<FactEngineInput> = {}): FactEngineInput => ({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [], dayZones: [], nowSec: t0 + 5 * M5 + 600,
    ictEnabled: false, fractalEnabled: false, // isolate the fractal-geometry family
    qualityGateEnabled: false, // confluence mechanics under test, not the (data-driven) gate
    ...over,
  });
  const fired = runFactEngine(mkFg());
  assert(fired.length === 1 && fired[0].direction === "Long"
    && fired[0].facts.some(f => f.strategy === "fractalGeo" && f.kind === "reclaim" && f.counted),
    "FG reclaim (a COUNTED kind) completes the ≥2-fact confluence for an RTH side-entry");
  assert(fired.length === 1 && fired[0].label.includes("FG Reclaim"),
    "composite label lists the FG fragment explicitly");
  assert(fired.length === 1
    && fired[0].facts.filter(f => f.strategy === "fractalGeo" && f.kind === "flat-bounce").every(f => !f.counted),
    "flat-bounce is a LABEL-NOTE (counted:false — below the window aggregate, per FG_COUNTED_KINDS)");
  assert(runFactEngine(mkFg({ fractalGeoEnabled: false })).length === 0,
    "fractalGeoEnabled:false strips FG facts (the same RTH solo SE no longer fires)");
}
{
  // FG facts ALONE (no core driver) can never fire: a reclaim bar with no shelf (no SE),
  // no zones, no yellowbox — even though reclaim(+flat-bounce) both count on the same side.
  const t0 = et(8, 11, 0);
  const bars = [
    C(t0, 100.4, 100.9, 99.8, 100.5),
    C(t0 + M5, 99.6, 99.9, 98.8, 99.2),       // false break below
    C(t0 + 2 * M5, 99.4, 101.9, 99.2, 101.6), // bullish reclaim close above the flat vector
  ];
  const sig = runFactEngine({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [], dayZones: [], nowSec: t0 + 3 * M5,
    ictEnabled: false, fractalEnabled: false,
  });
  assert(sig.length === 0, "FG corroborators alone (no driver) can NEVER fire a signal");
}
{
  // ETH purity: the identical SE+reclaim geometry at 20:00 ET fires the ETH solo side-entry
  // WITHOUT any fractal-geometry fact (FG readings are RTH-only).
  const t0 = et(8, 20, 0);
  const pre = [C(t0 - 2 * M5, 100.2, 100.9, 99.9, 100.6), C(t0 - M5, 100.4, 100.8, 99.9, 100.3)];
  const bars = [...pre, ...longSeBars(t0, M5, 100)];
  const sig = runFactEngine({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [], dayZones: [], nowSec: t0 + 5 * M5 + 600,
    ictEnabled: false, fractalEnabled: false, qualityGateEnabled: false, // gate blocks ETH solo SE@5m by data
    settings: { ETH_CONFLUENCE: false }, // escape hatch — the pre-2026-08-11 purity contract
  });
  assert(sig.length === 1 && sig[0].facts.every(f => f.strategy === "vector"),
    "ETH purity: no fractal-geometry fact ever enumerates outside RTH");
}

console.log("── fractal-geometry CONTRA: vector-chase + wave exhaustion ──");
{
  // Chase: vector adjusting DOWN (-0.05/bar) while price rallies +4.4 over 8 bars into a
  // yellowbox break (breakout driver, weight 2) + footprint support (1). Default contra (1)
  // leaves 3-1=2 ≥ margin → fires; W_FG_CONTRA:2 → 3-2=1 < margin → chase suppresses it;
  // FG_CONTRADICTS:false restores it.
  const fire = et(8, 12, 0);
  const t = (k: number) => fire - (11 - k) * M5;
  const bars: FiringCandle[] = [];
  for (let k = 0; k < 11; k++) { const px = 105.8 + 0.4 * k; bars.push(C(t(k), px - 0.3, px + 0.5, px - 0.6, px)); }
  bars.push(C(fire, 110.2, 111.6, 110.0, 111.2)); // closes over the 110 box top AND over the prior HOD (110.3) — no HOD-proximity suppression; low stays 9+ pts off the vector
  const vecPts: VectorPoint[] = bars.map((c, k) => ({ time: c.time, value: 100.8 - 0.05 * k }));
  const YB = { dayKeyET: "2026-07-08", sessionStartTs: et(7, 18, 0), sessionEndTs: et(8, 17, 0), boxTop: 110, boxBottom: 104, initRes: 116, initSup: 98 };
  const fp = new Map<number, FpImbalanceZone[]>([[fire, [{ startPrice: 109, endPrice: 109.5, direction: "buy", levelCount: 3 }]]]);
  const mkCh = (over: Partial<FactEngineInput> = {}): FactEngineInput => ({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vecPts }],
    zones: [], dayZones: [YB], footprintByTime: fp, nowSec: fire + 600,
    ictEnabled: false, fractalEnabled: false,
    qualityGateEnabled: false, // isolate the CONTRA rule (the 3-mo gate blocks fact-engine@5m at n=2 counted)
    ...over,
  });
  assert(runFactEngine(mkCh()).length === 1,
    "chase contra at DEFAULT weight 1 does not suppress a 3-weight breakout stack (3-1=2 ≥ margin)");
  assert(runFactEngine(mkCh({ settings: { W_FG_CONTRA: 2 } })).length === 0,
    "vector-chase divergence suppresses the breakout-driven long at W_FG_CONTRA:2 (3-2=1 < margin)");
  assert(runFactEngine(mkCh({ settings: { W_FG_CONTRA: 2, FG_CONTRADICTS: false } })).length === 1,
    "FG_CONTRADICTS:false escape hatch restores it (chase is a fractal-geometry reading)");
}
{
  // Exhaustion applies to EVERY driver type (unlike chop): 4 completed up-waves (extents
  // 4/5/6/7 vs the 100 vector), then an ~11-pt blow-off wave. A solo LONG zone reaction
  // (NORMAL strength, weight 2) near the top reads "buying an exhausted wave":
  // 2-1=1 < margin → suppressed. Fixture is deliberately disentangled: the cross bar (A)
  // carries the reclaim label-note but has no driver; the blow-off (B) never wick-touches
  // the zone (low beyond the whole band) so the zone's touch count stays <2 (reaction must
  // stay NORMAL — a strong reaction's weight 3 would beat a 1-point contra); the fire bar
  // closes ABOVE the prior HOD (110.6) so HOD proximity can't mask the exhaustion rule.
  // Starts at the 09:30 open so the fire bar (15 bars in) closes 10:50 — clear of the 15:15 cutoff.
  const day = 9;
  let tt = et(day, 9, 30);
  const bars: FiringCandle[] = [];
  const wave = (hi: number): void => {
    bars.push(C(tt, 100.5, 100.8, 100.2, 100.6)); tt += M5;  // cross above (base 100)
    bars.push(C(tt, 100.8, hi, 100.5, hi - 0.3)); tt += M5;  // extreme
    bars.push(C(tt, 100.4, 100.6, 99.0, 99.4)); tt += M5;    // close below → wave completes
  };
  wave(104); wave(105); wave(106); wave(107);
  bars.push(C(tt, 100.5, 100.8, 100.2, 100.6)); tt += M5;    // A: cross above (reclaim event fires HERE)
  bars.push(C(tt, 100.8, 110.6, 100.5, 110.2)); tt += M5;    // B: blow-off (low skips the zone band; its own
  bars.push(C(tt, 110.1, 110.4, 109.8, 110.0)); tt += M5;    //    zone read can't fire — normal solo never qualifies)
  const fire = tt;                                            // spacer bar: A's reclaim FG_RECENT_BARS(3) window
  bars.push(C(fire, 108.9, 111.0, 107.9, 110.8)); tt += M5;  //   expires before the fire bar (no counted FG fact left)
  const RXZONE: FiringZone = { topPrice: 108, bottomPrice: 105, color: "#22c55e", label: "support", fromTime: et(day, 0, 0) };
  // Footprint support completes the minimal qualifying stack: zone(2) + fp(1) = weight 3 with a
  // ZONE (non-breakout) driver. Every minimal qualifying stack weighs ≥3 and the margin is 2, so
  // the DEFAULT weight-1 exhaustion contra never suppresses alone (3-1=2 ≥ margin — deliberate,
  // conservative). W_FG_CONTRA:2 demonstrates the suppression AND its universality: chop/chase
  // never charge a zone-driven side; exhaustion does.
  const fpEx = new Map<number, FpImbalanceZone[]>([[fire, [{ startPrice: 109, endPrice: 109.5, direction: "buy", levelCount: 3 }]]]);
  const mkEx = (over: Partial<FactEngineInput> = {}): FactEngineInput => ({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [RXZONE], dayZones: [], footprintByTime: fpEx, nowSec: fire + 600,
    ictEnabled: false, fractalEnabled: false,
    qualityGateEnabled: false, // isolate the CONTRA rule (the 3-mo gate blocks fact-engine@5m at n=2 counted)
    ...over,
  });
  assert(runFactEngine(mkEx()).length === 1,
    "default weight-1 exhaustion contra does not suppress a 3-weight zone stack (3-1=2 ≥ margin — conservative default)");
  assert(runFactEngine(mkEx({ settings: { W_FG_CONTRA: 2 } })).length === 0,
    "wave exhaustion (≥p80 of prior extents) suppresses even a zone-REACTION-driven long at W_FG_CONTRA:2 (universal contra — chop/chase never touch zone drivers)");
  assert(runFactEngine(mkEx({ settings: { W_FG_CONTRA: 2, FG_CONTRADICTS: false } })).length === 1,
    "FG_CONTRADICTS:false control: the same zone reaction fires without the exhaustion rule");
}

console.log("── PML/TML live-only corroborators (backtestable:false, live edge only) ──");
{
  const t0 = et(8, 10, 0);
  const pre = [C(t0 - 2 * M5, 100.2, 100.9, 99.9, 100.6), C(t0 - M5, 100.4, 100.8, 99.9, 100.3)];
  const bars = [...pre, ...longSeBars(t0, M5, 100)];
  const fireClose = t0 + 5 * M5; // the SE bar's close time
  const base: FactEngineInput = {
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 100) }],
    zones: [], dayZones: [], ictEnabled: false, fractalEnabled: false,
    qualityGateEnabled: false, // moneyline mechanics under test, not the gate
    liveLevels: { pml: 95, tml: 101 },
    nowSec: fireClose, // live edge — the fire bar closes at "now"
  };
  const live = runFactEngine(base);
  const ml = live[0]?.facts.find(f => f.strategy === "moneyline");
  assert(live.length === 1 && !!ml && ml.backtestable === false && ml.kind === "pml" && ml.direction === "Long",
    "close above PML on the live edge attaches a moneyline fact marked backtestable:false");
  const hist = runFactEngine({ ...base, nowSec: fireClose + 86400 });
  assert(hist.length === 1 && !hist[0].facts.some(f => f.strategy === "moneyline"),
    "the SAME bar a day later (historical) gets NO moneyline fact — live-edge only");
  const noLl = runFactEngine({ ...base, liveLevels: undefined });
  assert(noLl.length === 1 && !noLl[0].facts.some(f => f.strategy === "moneyline"),
    "no liveLevels input (the backtest harness) ⇒ zero moneyline facts by construction");
}

console.log("── DEAD-TAPE SUPPRESSION (2026-08-02 — gate-level enforcement, escape hatch, graceful-absent) ──");
// These sections test the BASE suppression rule — the 2026-08-12 DIRECTIONALITY exemption
// (shipped default) is disabled here and tested in its OWN section further down.
setDeadTapeDirExemptForAnalysis(null);
{
  // strongZoneRun's session-day realized range at the fire bar is ~4.3 pts (104.7-100.4).
  // dayRangeMedian 1000 → threshold 600 → dead tape → SUPPRESSED; median 1 → threshold 0.6 →
  // active tape → fires; escape hatch OFF restores the fire; absent median = never computed.
  const { input } = strongZoneRun({ fireBarEt: [10, 30] });
  assert(runFactEngine({ ...input, dayRangeMedian: 1000 }).length === 0,
    `dead tape (range-so-far < ${DEAD_TAPE_SUPPRESS_MULT}x median) suppresses the fire — nothing exempt`);
  assert(runFactEngine({ ...input, dayRangeMedian: 1000, deadTapeSuppressEnabled: false }).length === 1,
    "deadTapeSuppressEnabled:false escape hatch restores the fire (flag-only display behavior)");
  assert(runFactEngine({ ...input, dayRangeMedian: 1 }).length === 1,
    "active tape (range-so-far >= threshold) fires normally");
  assert(runFactEngine({ ...input }).length === 1,
    "no dayRangeMedian input → suppression never computed (graceful — UNIT-FIXTURE default; every real adapter passes deadTapeFailClosed)");
  // FAIL-CLOSED (2026-08-07, journal [same-day-drift]): real adapters pass deadTapeFailClosed —
  // a missing/invalid median then emits NOTHING instead of firing ungated (2026-08-06's three
  // fires bypassed dead-tape exactly through the graceful path above).
  assert(runFactEngine({ ...input, deadTapeFailClosed: true }).length === 0,
    "deadTapeFailClosed + absent median → the engine emits NOTHING (fail-closed)");
  assert(runFactEngine({ ...input, deadTapeFailClosed: true, dayRangeMedian: 0 }).length === 0,
    "deadTapeFailClosed + invalid (0) median → fail-closed too");
  assert(runFactEngine({ ...input, deadTapeFailClosed: true, dayRangeMedian: 1 }).length === 1,
    "deadTapeFailClosed with a VALID median is a no-op (active tape fires normally)");
  assert(runFactEngine({ ...input, deadTapeFailClosed: true, deadTapeSuppressEnabled: false }).length === 1,
    "explicit deadTapeSuppressEnabled:false still bypasses fail-closed (deliberate escape hatch)");
}
{
  // ETH exempt-nothing proof: the overnight solo vector side-entry is suppressed too.
  const { input } = ethSeRun();
  assert(runFactEngine({ ...input, dayRangeMedian: 1000 }).length === 0,
    "dead tape suppresses even the ETH solo vector side-entry (the data killed everything)");
  assert(runFactEngine({ ...input, dayRangeMedian: 0.1 }).length === 1,
    "ETH solo fires again on active tape");
}

console.log("── DAILY LOSS STOP (2026-08-02 — engine-enforced, current session only, resumes next session) ──");
{
  const { input, fireTime } = strongZoneRun({ fireBarEt: [10, 30] });
  assert(runFactEngine({ ...input, dayPnlPts: -100, dailyLossStopPts: 80 }).length === 0,
    "dayPnl -100 <= -80: engine fires NOTHING for current-session bars");
  assert(runFactEngine({ ...input, dayPnlPts: -80, dailyLossStopPts: 80 }).length === 0,
    "exact threshold (-80 <= -80) trips the stop");
  assert(runFactEngine({ ...input, dayPnlPts: -50, dailyLossStopPts: 80 }).length === 1,
    "day loss above the threshold does not suppress");
  assert(runFactEngine({ ...input, dayPnlPts: -100 }).length === 1,
    "no dailyLossStopPts configured → no suppression");
  assert(runFactEngine({ ...input, dayPnlPts: -100, dailyLossStopPts: 0 }).length === 1,
    "dailyLossStopPts 0 = disabled");
  // RESUMES NEXT SESSION: same bars, but 'now' is the NEXT session day — the fire bar belongs
  // to a PRIOR (historical) session, which the live rule never touches.
  assert(runFactEngine({ ...input, dayPnlPts: -100, dailyLossStopPts: 80, nowSec: fireTime + 86400 }).length === 1,
    "next session: historical-session bars fire again (stop applies to the CURRENT session only)");
  assert(DAILY_LOSS_STOP_DEFAULT_PTS === 80,
    "default stop is the documented 80 pts (p95 losing day of the standing 444-trade config)");
}
{
  // Forming-bar path: same enforcement in evaluateFormingBar (the forming bar IS the current
  // session), same dead-tape predicate, same escape hatch.
  const t0 = et(9, 10, 30); // Thu 10:30 ET — RTH
  const closed = [
    C(t0 - 4 * M5, 102, 102.5, 101.5, 102.2), C(t0 - 3 * M5, 102, 102.5, 101.5, 102.1),
    C(t0 - 2 * M5, 102, 102.4, 101.6, 102.0), C(t0 - 1 * M5, 102, 102.3, 101.6, 102.2),
  ];
  const formingBar = C(t0, 100.7, 104.7, 100.4, 104.5); // strong support reaction
  const base = { interval: "5m" as Interval, formingBar, closedCandles: closed, zones: [SUPPORT] };
  assert(evaluateFormingBar(base) != null, "forming-bar fixture fires (baseline)");
  assert(evaluateFormingBar({ ...base, dayPnlPts: -100, dailyLossStopPts: 80 }) == null,
    "forming-bar path silent once the daily loss stop is tripped");
  assert(evaluateFormingBar({ ...base, dayPnlPts: -50, dailyLossStopPts: 80 }) != null,
    "forming-bar path unaffected above the threshold");
  assert(evaluateFormingBar({ ...base, dayRangeMedian: 1000 }) == null,
    "forming-bar path suppressed on dead tape");
  assert(evaluateFormingBar({ ...base, dayRangeMedian: 1000, deadTapeSuppressEnabled: false }) != null,
    "forming-bar dead-tape escape hatch restores the fire");
  // FAIL-CLOSED (2026-08-07) — forming-bar path mirrors the bar-close loop's contract.
  assert(evaluateFormingBar({ ...base, deadTapeFailClosed: true }) == null,
    "forming-bar fail-closed: absent median + deadTapeFailClosed → no fire");
  assert(evaluateFormingBar({ ...base, deadTapeFailClosed: true, dayRangeMedian: 1 }) != null,
    "forming-bar fail-closed is a no-op when the median is present (active tape)");
  assert(evaluateFormingBar({ ...base, deadTapeFailClosed: true, deadTapeSuppressEnabled: false }) != null,
    "forming-bar explicit escape hatch bypasses fail-closed");
}

console.log("── DEAD-TAPE DIRECTIONALITY EXEMPTION (2026-08-12 SHIPPED — quiet-TRENDING trades, quiet-CHOP stays dark) ──");
setDeadTapeDirExemptForAnalysis(DEAD_TAPE_DIR_EXEMPT); // restore the SHIPPED default for these + all later sections
{
  // The strongZoneRun fire bar closes far from its session open (drift/range well above 0.5):
  // a quiet-but-DIRECTIONAL tape — the shipped exemption fires it straight through dead tape.
  const { input } = strongZoneRun({ fireBarEt: [10, 30] });
  assert(runFactEngine({ ...input, dayRangeMedian: 1000 }).length === 1,
    "SHIPPED: quiet-but-TRENDING tape fires through dead tape (drift >= 0.5 x range-so-far)");
  // The ETH side-entry ramp is strongly directional too — same exemption overnight.
  const eth = ethSeRun();
  assert(runFactEngine({ ...eth.input, dayRangeMedian: 1000 }).length >= 1,
    "SHIPPED: the directional ETH ramp fires through dead tape as well");
  // Forming-bar mirror: the same strong-reaction forming bar that the BASE rule suppressed
  // (asserted in the disabled section above) fires under the shipped exemption.
  const t0 = et(9, 10, 30);
  const closed = [
    C(t0 - 4 * M5, 102, 102.5, 101.5, 102.2), C(t0 - 3 * M5, 102, 102.5, 101.5, 102.1),
    C(t0 - 2 * M5, 102, 102.4, 101.6, 102.0), C(t0 - 1 * M5, 102, 102.3, 101.6, 102.2),
  ];
  const formingBar = C(t0, 100.7, 104.7, 100.4, 104.5);
  assert(evaluateFormingBar({ interval: "5m" as Interval, formingBar, closedCandles: closed, zones: [SUPPORT], dayRangeMedian: 1000 }) != null,
    "SHIPPED forming-bar mirror: the directional session fires through dead tape intra-candle");
}

console.log("── POSITION SIZING (2026-08-02 — suggestedContracts from the combo tier, display/config-only) ──");
{
  const bar = { MIN_PF: 1.05, MIN_EXPECTANCY_PTS: 0.1 };
  const mkGd = (combos: QualityGateData["comboClasses"]): QualityGateData => ({
    generatedAt: "", source: "sizing test",
    rule: { perInterval: { "1m": bar, "5m": bar, "15m": bar, "60m": bar }, MIN_FACTS_OVERRIDE: 3 },
    multiFact: { n: 0, pf: 0, expectancy: 0 },
    classes: {}, exitByClass: {}, comboClasses: combos,
  });
  const proven = { n: 60, pf: 1.5, expectancy: 6, winRate: 0.62, allowed: true };
  const passing = { n: 60, pf: 1.1, expectancy: 1.2, winRate: 0.55, allowed: true };
  const thin = { n: 4, pf: 3.0, expectancy: 9, winRate: 0.75, allowed: true };
  // Helper-level derivation (mirrors the UI's comboTierOf + SIZE_BY_COMBO_TIER mapping).
  assert(suggestedContractsFor("Zone", "5m", mkGd({ "Zone@5m": proven })) === 2,
    "PROVEN combo@interval (PF >= 1.3, adequate n) → 2 contracts");
  assert(suggestedContractsFor("Zone", "5m", mkGd({ "Zone@5m": passing })) === 1,
    "PASSING combo (PF in [1.05,1.3)) → 1 contract");
  assert(suggestedContractsFor("Zone", "5m", mkGd({ "Zone@5m": thin })) === 1,
    "thin sample is UNPROVEN regardless of PF → 1 contract (small n is never praised)");
  assert(suggestedContractsFor("Zone", "5m", mkGd({ Zone: proven })) === 2,
    "all-interval fallback verdict tiers at its own scope threshold (n>=15)");
  assert(suggestedContractsFor("Zone", "5m", mkGd({})) === 1, "absent combo → unproven → 1 contract");
  assert(SIZE_BY_COMBO_TIER.proven === 2 && SIZE_BY_COMBO_TIER.passing === 1 && SIZE_BY_COMBO_TIER.unproven === 1 && SIZE_BY_COMBO_TIER.weak === 1,
    "SIZE_BY_COMBO_TIER mapping is the documented 2/1/1/1");
  // Emission-level: the engine stamps the SAME derivation on fired signals.
  const { input } = strongZoneRun({ fireBarEt: [10, 30] });
  const sigProven = runFactEngine({ ...input, gateData: mkGd({ "Zone@5m": proven }) });
  assert(sigProven.length === 1 && sigProven[0].suggestedContracts === 2,
    "emitted signal carries suggestedContracts 2 when its combo is PROVEN");
  const sigAbsent = runFactEngine({ ...input, gateData: mkGd({}) });
  assert(sigAbsent.length === 1 && sigAbsent[0].suggestedContracts === 1,
    "emitted signal carries suggestedContracts 1 when its combo is unproven/absent");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── A1 (2026-09-24): YELLOW-BOX BREAK = ONE-TIME EVENT (YB_BREAK_EVENT_BARS) ──");
{
  assert(s.YB_BREAK_EVENT_BARS === 3, "YB_BREAK_EVENT_BARS default is 3");
  // Box 90–110 (initRes 130 so no anchor/room interference). A break bar at t0 then 20 more
  // bars closing ABOVE the box (each a new high → never HOD-proximity suppressed), a close back
  // INSIDE (k=21), then a SECOND break (k=22..27).
  const YB = { dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop: 110, boxBottom: 90, initRes: 130, initSup: 70 };
  const t0 = et(7, 10, 0);
  const p: FiringCandle[] = [];
  for (let k = 4; k >= 1; k--) p.push(C(t0 - k * M5, 105, 106, 104, 105));          // inside the box
  for (let k = 0; k <= 20; k++) p.push(C(t0 + k * M5, 112.9 + 0.2 * k, 113.5 + 0.2 * k, 112.8 + 0.2 * k, 113.4 + 0.2 * k));
  p.push(C(t0 + 21 * M5, 116, 116.5, 107, 108));                                      // back INSIDE → re-arms
  for (let m = 0; m <= 5; m++) p.push(C(t0 + (22 + m) * M5, 117.6 + 0.2 * m, 118.1 + 0.2 * m, 117.5 + 0.2 * m, 118 + 0.2 * m));
  const lastT = p[p.length - 1].time;
  // Probe: YELLOWBOX_SOLO + no cooldown + rule OFF → every bar carrying a COUNTED primary
  // yellowbox fact fires, so the fire list IS the list of counted-break bars.
  const probe = (yb: number) => runFactEngine({
    primary: "5m", slices: [{ interval: "5m", candles: p, vector: vec(p, 80) }], zones: [], dayZones: [YB],
    nowSec: lastT + 600, qualityGateEnabled: false, ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false,
    settings: { YELLOWBOX_SOLO: true, COOLDOWN_BARS: 0, ONE_OPEN_PER_DIRECTION: false, YB_BREAK_EVENT_BARS: yb },
  });
  const ks = (sig: ReturnType<typeof runFactEngine>) => sig.map(x => Math.round((x.time - t0) / M5));
  const ev = probe(3);
  assert(JSON.stringify(ks(ev)) === JSON.stringify([0, 1, 2, 22, 23, 24]),
    `A1: break + 20 bars beyond → exactly ONE 3-bar window of counted break facts; re-entry + second break → a second window (got ${JSON.stringify(ks(ev))})`);
  assert(ev.every(x => x.facts.some(f => f.strategy === "yellowbox" && f.kind === "break" && f.counted && f.driver)),
    "A1: in-window facts keep the legacy counted DRIVER shape (kind break)");
  const legacy = probe(0);
  assert(legacy.length === 27 && ks(legacy)[20] === 20,
    `A1: YB_BREAK_EVENT_BARS:0 reproduces the legacy per-bar STATE (27 counted-break bars, got ${legacy.length})`);
  const ev1 = probe(1);
  assert(JSON.stringify(ks(ev1)) === JSON.stringify([0, 22]), "A1: YB_BREAK_EVENT_BARS:1 = only the break bar itself counts");

  // Late fire with its OWN driver (a primary side-entry + footprint at k=15, long after the
  // window): the yellowbox fact rides along as an UNCOUNTED "beyond box" note (still anchors
  // TP1 like before), and the 15m secondary echo is omitted outside ITS own 3-bar window.
  const kSE = 15;
  const vpts: VectorPoint[] = p.map(b => ({ time: b.time, value: 80 }));
  const lvl = p[4 + kSE - 1].close + 0.1;                         // shelf hugs v; prev close ≤ v; SE close > v
  for (let k = kSE - 4; k <= kSE; k++) vpts[4 + k] = { time: p[4 + k].time, value: lvl };
  const s15: FiringCandle[] = [];
  for (let b = 0; b + 2 < p.length; b += 3) {                       // 15m aggregate of the 5m bars (aligned at 09:40? no — build on :00/:15/:30/:45)
    const grp = p.slice(b, b + 3);
    s15.push(C(grp[0].time, grp[0].open, Math.max(...grp.map(g => g.high)), Math.min(...grp.map(g => g.low)), grp[2].close));
  }
  const fp = new Map<number, FpImbalanceZone[]>([[t0 + kSE * M5, [{ startPrice: 115, endPrice: 116, direction: "buy", levelCount: 3 }]]]);
  const lateRun = (yb: number) => runFactEngine({
    primary: "5m",
    slices: [{ interval: "5m", candles: p, vector: vpts }, { interval: "15m", candles: s15, vector: vec(s15, 80) }],
    zones: [], dayZones: [YB], footprintByTime: fp, nowSec: lastT + 600,
    qualityGateEnabled: false, ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false,
    exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 },
    settings: { ONE_OPEN_PER_DIRECTION: false, YB_BREAK_EVENT_BARS: yb },
  }).filter(x => x.time === t0 + kSE * M5);
  const lateEv = lateRun(3)[0], lateLeg = lateRun(0)[0];
  assert(lateEv != null && lateEv.label.includes("Yellowbox(beyond box ↑ @110.00)") && !lateEv.label.includes("break↑"),
    `A1: after the window the primary break is a "beyond box" NOTE and the 15m echo is omitted (label: ${lateEv?.label})`);
  assert(lateEv != null && lateEv.facts.filter(f => f.strategy === "yellowbox").every(f => !f.counted && !f.driver && f.kind === "beyond"),
    "A1: the beyond-box note is uncounted and never a driver");
  assert(lateEv != null && lateEv.comboKey === "FP+Vec", `A1: the note never enters the combo key (got ${lateEv?.comboKey})`);
  assert(lateLeg != null && lateLeg.label.includes("break↑ @110.00") && lateLeg.label.includes("15m break↑") && lateLeg.comboKey === "FP+Vec+YB",
    `A1: legacy (0) still counts the stale break + 15m echo at the same bar (label: ${lateLeg?.label})`);
  assert(lateEv != null && lateLeg != null && lateEv.tp1 === lateLeg.tp1 && lateEv.sl === lateLeg.sl,
    "A1: exit geometry unchanged — the note still selects the yellowbox TP1 anchor set");
  // Without its own driver the stale break can no longer complete confluence: FP alone + note.
  const fpOnly = new Map<number, FpImbalanceZone[]>([[t0 + 12 * M5, [{ startPrice: 115, endPrice: 115.4, direction: "buy", levelCount: 3 }]]]);
  const noDriver = (yb: number) => runFactEngine({
    primary: "5m", slices: [{ interval: "5m", candles: p, vector: vec(p, 80) }], zones: [], dayZones: [YB], footprintByTime: fpOnly,
    nowSec: lastT + 600, qualityGateEnabled: false, ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false,
    exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 }, settings: { ONE_OPEN_PER_DIRECTION: false, YB_BREAK_EVENT_BARS: yb },
  }).filter(x => x.time === t0 + 12 * M5);
  assert(noDriver(3).length === 0 && noDriver(0).length === 1,
    "A1: a stale box break + one corroborator 12 bars later no longer fires (legacy state did — the 2026-09-24 Fr+YB pattern)");
}

console.log("── A3 (2026-09-24): ONE OPEN TRADE PER DIRECTION + priorFires seed + forming openTrades ──");
{
  assert(s.ONE_OPEN_PER_DIRECTION === true, "ONE_OPEN_PER_DIRECTION default is ON");
  // Strong resistance reactions (solo Short drivers) at k=0,10,20,30 — exactly COOLDOWN_BARS
  // apart. Short #1 (entry 115.5, TP 105.5, SL 120.5) stays OPEN until the k=25 bar tags 105.
  const t0 = et(7, 10, 0);
  const SHORT = (t: number) => C(t, 117, 119.6, 115, 115.5);
  const FILL = (t: number) => C(t, 115.5, 116, 115, 115.6);
  const bars: FiringCandle[] = [];
  for (let k = 4; k >= 1; k--) bars.push(C(t0 - k * M5, 102, 102.5, 101.5, 102.2)); // day low 101.5 (no LOD proximity)
  for (let k = 0; k <= 32; k++) {
    const t = t0 + k * M5;
    bars.push(k % 10 === 0 ? SHORT(t) : k === 25 ? C(t, 115, 115.5, 105, 106) : FILL(t));
  }
  const base = (settings: Partial<typeof s>, extra?: Partial<FactEngineInput>): FactEngineInput => ({
    primary: "5m", slices: [{ interval: "5m", candles: bars, vector: vec(bars, 90) }], zones: [RESIST],
    nowSec: t0 + 33 * M5 + 600, exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 },
    qualityGateEnabled: false, ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false,
    settings, ...(extra ?? {}),
  });
  const ks = (sig: ReturnType<typeof runFactEngine>) => sig.map(x => Math.round((x.time - t0) / M5));
  const off = runFactEngine(base({ ONE_OPEN_PER_DIRECTION: false }));
  assert(JSON.stringify(ks(off)) === JSON.stringify([0, 10, 20, 30]), `A3 OFF reproduces the old clustered count: 4 stacked Shorts (got ${JSON.stringify(ks(off))})`);
  const on = runFactEngine(base({}));
  assert(JSON.stringify(ks(on)) === JSON.stringify([0, 30]),
    `A3 ON: Shorts at k=10/20 are blocked while #1 is open; the next fires only after it resolved at k=25 (got ${JSON.stringify(ks(on))})`);
  let oneAtATime = true;
  for (let q = 1; q < on.length; q++) {
    const prev = on[q - 1];
    if (prev.direction !== on[q].direction) continue;
    if (prev.exitTs == null || prev.exitTs > on[q].time + M5) oneAtATime = false;
  }
  assert(oneAtATime && on[0].outcome === "win_tp1", "A3 ON: at most one open Short at a time (each fire after the prior's exit)");
  // A blocked fire does NOT consume the cooldown: with #1 resolving at k=25, a Short event at
  // k=27 (17 bars after #1, 7 after the blocked k=20) fires — the blocked k=20 never moved the cursor.
  const bars27 = bars.map(b => b.time === t0 + 27 * M5 ? SHORT(b.time) : b.time === t0 + 30 * M5 ? FILL(b.time) : b);
  const on27 = runFactEngine({ ...base({}), slices: [{ interval: "5m", candles: bars27, vector: vec(bars27, 90) }] });
  assert(JSON.stringify(ks(on27)) === JSON.stringify([0, 27]), `A3: a rule-blocked fire does not consume the cooldown cursor (got ${JSON.stringify(ks(on27))})`);
  // Opposite direction is NOT blocked by an open Short (only the global cooldown applies).
  const barsL = bars.map(b => b.time === t0 + 10 * M5 ? C(b.time, 100.7, 104.7, 100.4, 104.5) : b);
  const onL = runFactEngine({ ...base({}), zones: [RESIST, SUPPORT], slices: [{ interval: "5m", candles: barsL, vector: vec(barsL, 90) }] });
  assert(onL.some(x => x.direction === "Long" && x.time === t0 + 10 * M5), "A3: an open Short never blocks a Long");

  // ── priorFires seeding (Area B wiring): a STORED fire acts exactly like the engine's own ──
  // Single Short event at k=10 only (other events flattened).
  const one = bars.map(b => (b.time === t0 || b.time === t0 + 20 * M5 || b.time === t0 + 30 * M5) ? FILL(b.time) : b);
  const seed = (priorFires: FactEngineInput["priorFires"], settings: Partial<typeof s> = {}) =>
    ks(runFactEngine({ ...base(settings), slices: [{ interval: "5m", candles: one, vector: vec(one, 90) }], priorFires }));
  assert(JSON.stringify(seed(undefined)) === JSON.stringify([10]), "A3 seed control: no priors → the k=10 Short fires");
  assert(JSON.stringify(seed([{ time: t0 + 5 * M5, direction: "Long", entry: 115.5, tp1: 125.5, sl: 110.5 }], { ONE_OPEN_PER_DIRECTION: false })) === "[]",
    "A3 seed: a stored fire 5 bars earlier (either direction) blocks via the GLOBAL cooldown cursor");
  assert(JSON.stringify(seed([{ time: t0, direction: "Long", entry: 115.5, tp1: 125.5, sl: 110.5 }], { ONE_OPEN_PER_DIRECTION: false })) === "[10]",
    "A3 seed: a stored fire exactly COOLDOWN_BARS earlier does not block");
  assert(JSON.stringify(seed([{ time: t0 + 12 * M5, direction: "Short", entry: 115.6, tp1: 105.6, sl: 120.6 }])) === "[10]",
    "A3 seed: a stored fire AFTER the bar never blocks it (no lookahead)");
  assert(JSON.stringify(seed([{ time: t0 + 10 * M5, direction: "Short", entry: 115.5, tp1: 105.5, sl: 120.5 }])) === "[10]",
    "A3 seed: a stored fire AT the evaluated bar is applied after it — the engine re-emits the fire it reproduces");
  const openShort = { time: t0, direction: "Short" as const, entry: 115.5, tp1: 105.5, sl: 120.5 };
  assert(JSON.stringify(seed([openShort])) === "[]",
    "A3 seed: a stored Short still OPEN (no TP/SL touch) blocks the k=10 Short (cooldown satisfied)");
  assert(JSON.stringify(seed([openShort], { ONE_OPEN_PER_DIRECTION: false })) === "[10]",
    "A3 seed: ONE_OPEN_PER_DIRECTION:false ignores the open stored trade");
  assert(JSON.stringify(seed([{ ...openShort, tp1: 115.2 }])) === "[10]",
    "A3 seed: a stored Short whose TP1 was touched before k=10 no longer blocks");
  assert(JSON.stringify(seed([{ ...openShort, direction: "Long", tp1: 125.5, sl: 105.5 }])) === "[10]",
    "A3 seed: an open stored LONG never blocks a Short");

  // ── forming-bar path: openTrades mirrors lastFireTime ──
  const t1 = et(7, 10, 30);
  const closed: FiringCandle[] = [];
  for (let k = 6; k >= 1; k--) closed.push(C(t1 - k * M5, 102, 102.5, 101.5, 102.2));
  const forming = C(t1, 100.7, 104.7, 100.4, 104.5); // strong support reaction (Long)
  const fb = (openTrades?: Parameters<typeof evaluateFormingBar>[0]["openTrades"], settings?: Partial<typeof s>) =>
    evaluateFormingBar({ interval: "5m", formingBar: forming, closedCandles: closed, zones: [SUPPORT], openTrades, settings });
  const openLong = { entry: 102.2, tp1: 112.2, sl: 97.2, firedAt: t1 - 3 * M5 };
  assert(fb() !== null, "A3 forming control: no openTrades → fires");
  assert(fb({ Long: openLong }) === null, "A3 forming: an unresolved same-direction bracket blocks the intra fire");
  assert(fb({ Long: openLong }, { ONE_OPEN_PER_DIRECTION: false }) !== null, "A3 forming: rule OFF ignores openTrades");
  assert(fb({ Long: { ...openLong, tp1: 104.0 } }) !== null, "A3 forming: a bracket whose TP1 the forming bar already tagged does not block");
  assert(fb({ Long: { ...openLong, tp1: 102.4 } }) !== null, "A3 forming: a bracket resolved on an earlier closed bar does not block");
  assert(fb({ Short: { entry: 102.2, tp1: 92.2, sl: 107.2, firedAt: t1 - 3 * M5 } }) !== null, "A3 forming: an open SHORT never blocks a Long");

  // ── B5 TAB ADAPTER (2026-09-25): the browser tab feeds the engine from GET
  // /api/signals/prior-fires through shared/engine-seed.ts — these pin that the adapter output,
  // exactly as market.tsx builds it, reaches the engine rules (each fails if the wiring is dropped).
  // The endpoint body goes through JSON (NaN levels arrive as null).
  const body = JSON.parse(JSON.stringify({ nowSec: t1, priors: { "5m": [
    { time: t1 - 3 * M5, direction: "Long", entry: 102.2, tp1: 112.2, sl: 97.2 },
    { time: t1, direction: "Long", entry: 104.5, tp1: 114.5, sl: 99.5 },           // the forming bar's own stored fire
    { time: t1 - 2 * M5, direction: "Short", entry: 102.2, tp1: null, sl: null },   // NULL levels → cooldown-only
  ] } }));
  const tabPriors = parsePriorFiresResponse(body)!;
  assert(!!tabPriors && tabPriors["5m"]?.length === 3 && tabPriors["5m"]![1].direction === "Short" && Number.isNaN(tabPriors["5m"]![1].tp1) && tabPriors["5m"]![2].time === t1, "B5 tab: prior-fires body parses (null level → NaN), time-ordered");
  const tabOpen = openTradesBefore([[], tabPriors["5m"], []], t1);
  assert(tabOpen.Long?.firedAt === t1 - 3 * M5 && tabOpen.Short === undefined,
    "B5 tab: openTrades = latest bracket per direction strictly BEFORE the forming bar (own-bar fire and NaN-level rows excluded)");
  assert(fb(tabOpen) === null, "B5 tab: a stored open Long from another writer blocks the tab's intra-candle Long (ONE_OPEN_PER_DIRECTION)");
  assert(fb(openTradesBefore([undefined, undefined, undefined], t1)) !== null, "B5 tab control: no stored fires → the intra fire happens");
  const engineOwn = [{ time: t1 - 4 * M5, direction: "Long", entry: 102.2, tp1: 102.4, sl: 97.2 }]; // resolved on a closed bar
  assert(fb(openTradesBefore([engineOwn, tabPriors["5m"]], t1)) === null,
    "B5 tab: the LATER stored open bracket wins over an older resolved one → blocked");
  assert(fb(openTradesBefore([[{ ...engineOwn[0], time: t1 - M5 }], tabPriors["5m"]], t1)) !== null,
    "B5 tab: a LATER resolved bracket (this run's own bar-close fire) supersedes the older open one → fires");
  // Cooldown via lastFireTime: a stored fire 2 bars back blocks, the same bar's own fire never does.
  const fbLast = (lastFireTime: number) => evaluateFormingBar({ interval: "5m", formingBar: forming, closedCandles: closed, zones: [SUPPORT], lastFireTime, settings: { ONE_OPEN_PER_DIRECTION: false } });
  const lastStored = latestFireTimeBefore([tabPriors["5m"]], t1);
  assert(lastStored === t1 - 2 * M5, "B5 tab: lastFireTime considers the stored fires strictly before the bar (either direction)");
  assert(fbLast(lastStored) === null, "B5 tab: the stored fire's cooldown blocks the tab's intra fire");
  assert(fbLast(latestFireTimeBefore([[{ time: t1 }]], t1)) !== null, "B5 tab: a stored fire AT the forming bar never suppresses itself");
  // Bar-close path: the parsed seed behaves exactly like the in-process one.
  const seedBody = JSON.parse(JSON.stringify({ priors: { "5m": [openShort] } }));
  assert(JSON.stringify(seed(parsePriorFiresResponse(seedBody)!["5m"])) === "[]" && JSON.stringify(seed(parsePriorFiresResponse({ priors: {} })!["5m"])) === "[10]",
    "B5 tab: the endpoint-parsed priorFires block the bar-close fire exactly like loadPriorFires' in-process seed");
}

// ═════════════════════════════════════════════════════════════════════════════
// 2026-10-01 SHADOW-TEST SETTINGS (docs/eth-trading-research-2026-10-01.md R3/R4):
// ETH_MIN_AGREEING_FACTS, ETH_VETO_FRACTAL_TWO_FACT, FactEngineInput.newsBlackouts + statsOut.
// All default to the previous behaviour — (a) pins that against a golden fire set captured
// from the pre-change engine; (b)–(d) each fail if their rule is removed.
// ═════════════════════════════════════════════════════════════════════════════
console.log("── shadow settings: ETH_MIN_AGREEING_FACTS / ETH fractal veto / news blackouts ──");
{
  // Deterministic random-walk 1m tape, Mon Jul 6 18:00 ET → Thu Jul 9 15:00 ET (halt skipped),
  // aggregated to 5m/15m/60m, with per-session yellow boxes (first Globex hour's range).
  const walk1m = (): FiringCandle[] => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const out: FiringCandle[] = []; let px = 6300; let drift = 0;
    const q = (x: number) => Math.round(x * 4) / 4;
    for (let t = et(6, 18, 0); t < et(9, 15, 0); t += 60) {
      const etm = (((t / 60 - 4 * 60) % 1440) + 1440) % 1440;
      if (etm >= 17 * 60 && etm < 18 * 60) continue;
      if (out.length % 90 === 0) drift = (rnd() - 0.5) * 0.6;
      const vol = etm >= 570 && etm < 1020 ? 1.6 : 0.7;
      const o = px; const c = o + drift + (rnd() - 0.5) * 2 * vol;
      const h = Math.max(o, c) + rnd() * vol; const l = Math.min(o, c) - rnd() * vol;
      out.push(C(t, q(o), q(h), q(l), q(c))); px = c;
    }
    return out;
  };
  const aggTo = (b: FiringCandle[], sec: number): FiringCandle[] => {
    const m = new Map<number, FiringCandle>();
    for (const x of b) {
      const k = Math.floor(x.time / sec) * sec; const a = m.get(k);
      if (!a) m.set(k, { ...x, time: k });
      else { a.high = Math.max(a.high, x.high); a.low = Math.min(a.low, x.low); a.close = x.close; }
    }
    return [...m.values()].sort((a, b) => a.time - b.time);
  };
  const w1 = walk1m(), w5 = aggTo(w1, 300), w15 = aggTo(w1, 900), w60 = aggTo(w1, 3600);
  const wBoxes = [6, 7, 8].map(d => {
    const s0 = et(d, 18, 0); const first = w1.filter(c => c.time >= s0 && c.time < s0 + 3600);
    const top = Math.max(...first.map(c => c.high)), bot = Math.min(...first.map(c => c.low));
    return { dayKeyET: `2026-07-0${d + 1}`, sessionStartTs: s0, sessionEndTs: et(d + 1, 17, 0), boxTop: top, boxBottom: bot, initRes: top + (top - bot), initSup: bot - (top - bot) };
  });
  const wInput = (primary: Interval, over?: Partial<FactEngineInput>): FactEngineInput => ({
    primary,
    slices: ([["1m", w1], ["5m", w5], ["15m", w15], ["60m", w60]] as Array<[Interval, FiringCandle[]]>)
      .map(([interval, candles]) => ({ interval, candles })),
    zones: [], dayZones: wBoxes, nowSec: et(9, 16, 0), qualityGateEnabled: false, // engine mechanics, not the live gate
    ...over,
  });
  const fp = (sig: ReturnType<typeof runFactEngine>) => sig.map(x =>
    `${x.time}|${x.interval}|${x.direction}|${x.price}|${x.tp1}|${x.sl}|${x.outcome}|${x.session}|${x.signalType}|${x.label}`).join("\n");
  const fnv = (str: string) => { let h = 0x811c9dc5; for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };

  // (a) DEFAULTS REPRODUCE THE PREVIOUS FIRE SET EXACTLY. GOLDEN = the pre-change engine's
  // output on this tape (captured 2026-10-01 from a copy of shared/fact-engine.ts with the three
  // rules stripped). If a LATER deliberate engine change moves the golden, re-capture it — but
  // only after confirming the delta is that change, never one of these three settings.
  const GOLDEN: Record<string, { n: number; eth: number; hash: string }> = { "1m": { n: 30, eth: 19, hash: "fb9c8132" }, "5m": { n: 20, eth: 15, hash: "5a510da1" } };
  for (const iv of ["1m", "5m"] as Interval[]) {
    const def = runFactEngine(wInput(iv));
    const explicit = runFactEngine(wInput(iv, {
      settings: { ETH_MIN_AGREEING_FACTS: 2, ETH_VETO_FRACTAL_TWO_FACT: false }, newsBlackouts: [], statsOut: newFactEngineRunStats(),
    }));
    assert(def.length === GOLDEN[iv].n && def.filter(x => x.session === "ETH").length === GOLDEN[iv].eth && fnv(fp(def)) === GOLDEN[iv].hash,
      `(a) ${iv}: DEFAULT settings reproduce the pre-change golden fire set exactly (n=${def.length}, hash ${fnv(fp(def))})`);
    assert(fp(explicit) === fp(def), `(a) ${iv}: explicit no-op values (ETH_MIN 2, veto off, [] blackouts, statsOut) == defaults`);
  }
  assert(FACT_ENGINE_DEFAULTS.ETH_MIN_AGREEING_FACTS === FACT_ENGINE_DEFAULTS.MIN_AGREEING_FACTS && FACT_ENGINE_DEFAULTS.ETH_VETO_FRACTAL_TWO_FACT === false,
    "(a) shipped defaults: ETH_MIN_AGREEING_FACTS = MIN_AGREEING_FACTS, fractal veto OFF");
  // The tape is MEANINGFUL for (b)/(c): it carries ETH two-family fractal fires, and turning
  // each rule on changes the fire set (otherwise (a) would prove nothing).
  const def5 = runFactEngine(wInput("5m"));
  assert(def5.some(x => x.session === "ETH" && comboKeyOf(x.facts).split("+").length === 2 && comboKeyOf(x.facts).includes("Fr")),
    "(a) tape check: the 5m default run contains ETH two-family fractal fires");
  assert(fp(runFactEngine(wInput("5m", { settings: { ETH_MIN_AGREEING_FACTS: 3 } }))) !== fp(def5)
    && fp(runFactEngine(wInput("5m", { settings: { ETH_VETO_FRACTAL_TWO_FACT: true } }))) !== fp(def5),
    "(a) tape check: enabling either ETH rule changes the 5m fire set");

  // ── (b) ETH_MIN_AGREEING_FACTS ──
  // decide(): the confluence path uses the ETH threshold only on ETH bars.
  const ybP = F({ strategy: "yellowbox", direction: "Long", kind: "break", weight: 2, driver: true });
  const fpL = F({ strategy: "footprint", direction: "Long", kind: "support", weight: 1 });
  const ictL = F({ strategy: "ict", direction: "Long", kind: "sweep", weight: 1 });
  const seP = F({ strategy: "vector", direction: "Long", kind: "side-entry", weight: 3, driver: true });
  const frL = F({ strategy: "fractal", direction: "Long", kind: "breakout", weight: 1 });
  const s3 = { ...s, ETH_MIN_AGREEING_FACTS: 3 };
  assert(decide([ybP, fpL], [], false, s)?.direction === "Long", "(b) decide control: ETH 2-fact confluence qualifies at the default");
  assert(decide([ybP, fpL], [], false, s3) === null, "(b) decide: ETH_MIN_AGREEING_FACTS=3 rejects an ETH 2-fact confluence");
  assert(decide([ybP, fpL], [], true, s3)?.direction === "Long", "(b) decide: ETH_MIN_AGREEING_FACTS=3 leaves an RTH 2-fact confluence alone");
  assert(decide([ybP, fpL, ictL], [], false, s3)?.direction === "Long", "(b) decide: an ETH 3-fact confluence still qualifies at 3");
  assert(decide([seP, frL], [], false, s3)?.direction === "Long",
    "(b) decide: SCOPE — the ETH solo PRIMARY side-entry rule is not the confluence path (unaffected)");

  // End to end: the ETH yellowbox break (Tue 20:00 ET) closes with FCO trending → exactly 2
  // counted facts {YB break, FCO}; the RTH twin (Tue 10:00 ET) the same.
  const brk = (t0: number, withFp = false, step = M5) => {
    const candles: FiringCandle[] = [];
    for (let k = 4; k >= 1; k--) candles.push(C(t0 - k * step, 105, 106, 104, 105));
    candles.push(C(t0, 108, 113.5, 107, 113));                                   // close 113 > 110 → break↑
    for (let k = 1; k <= 4; k++) candles.push(C(t0 + k * step, 113, 114, 112, 113.2));
    const fpm = new Map<number, FpImbalanceZone[]>();
    if (withFp) fpm.set(t0, [{ startPrice: 111, endPrice: 112, direction: "buy", levelCount: 3 }]);
    return { candles, fpm };
  };
  const ETH0 = et(7, 20, 0), RTH0 = et(7, 10, 0);
  const ethBox = { dayKeyET: "2026-07-08", sessionStartTs: et(7, 18, 0), sessionEndTs: et(8, 17, 0), boxTop: 110, boxBottom: 90, initRes: 118, initSup: 82 };
  const rthBox = { dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop: 110, boxBottom: 90, initRes: 118, initSup: 82 };
  const brkRun = (t0: number, box: typeof ethBox, over?: Partial<FactEngineInput>, withFp = false, primary: Interval = "5m", step = M5) => {
    const { candles, fpm } = brk(t0, withFp, step);
    return runFactEngine({
      primary, slices: [{ interval: primary, candles, vector: vec(candles, 80) }], zones: [], dayZones: [box],
      footprintByTime: withFp ? fpm : undefined, nowSec: t0 + 10 * step, qualityGateEnabled: false,
      ictEnabled: false, fractalGeoEnabled: false, exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 }, ...over,
    });
  };
  const countedOf = (x: { facts: Fact[] }) => x.facts.filter(f => f.counted).map(f => `${f.strategy}:${f.kind}`).sort().join("+");
  const ethDef = brkRun(ETH0, ethBox);
  assert(ethDef.length === 1 && ethDef[0].time === ETH0 && ethDef[0].session === "ETH" && countedOf(ethDef[0]) === "fractal:fco+yellowbox:break",
    `(b) e2e control: the ETH break fires by default with exactly {YB break, FCO} (got ${ethDef.map(countedOf).join(" | ")})`);
  const st3 = newFactEngineRunStats();
  assert(brkRun(ETH0, ethBox, { settings: { ETH_MIN_AGREEING_FACTS: 3 }, statsOut: st3 }).length === 0,
    "(b) e2e: ETH_MIN_AGREEING_FACTS=3 suppresses the 2-fact ETH fire");
  assert(st3.ethMinFactsSuppressed >= 1, `(b) statsOut counts the ETH_MIN rejections (got ${st3.ethMinFactsSuppressed})`);
  const rth3 = brkRun(RTH0, rthBox, { settings: { ETH_MIN_AGREEING_FACTS: 3 } });
  assert(rth3.length === 1 && rth3[0].session === "RTH" && countedOf(rth3[0]) === "fractal:fco+yellowbox:break",
    "(b) e2e: ETH_MIN_AGREEING_FACTS=3 does NOT suppress the identical 2-fact RTH fire");
  const eth3fp = brkRun(ETH0, ethBox, { settings: { ETH_MIN_AGREEING_FACTS: 3 } }, true);
  assert(eth3fp.length === 1 && eth3fp[0].facts.filter(f => f.counted).length === 3,
    "(b) e2e: a 3-fact ETH fire (YB + FP + FCO) still fires at ETH_MIN_AGREEING_FACTS=3");
  // Inheritance: MIN_AGREEING_FACTS alone moves BOTH sessions; an explicit ETH value wins.
  assert(resolveEngineSettings({ MIN_AGREEING_FACTS: 3 }).ETH_MIN_AGREEING_FACTS === 3
    && resolveEngineSettings({ MIN_AGREEING_FACTS: 3, ETH_MIN_AGREEING_FACTS: 2 }).ETH_MIN_AGREEING_FACTS === 2
    && resolveEngineSettings({}).ETH_MIN_AGREEING_FACTS === 2,
    "(b) inheritance: an un-named ETH_MIN_AGREEING_FACTS follows a MIN_AGREEING_FACTS override");
  assert(brkRun(ETH0, ethBox, { settings: { MIN_AGREEING_FACTS: 3 } }).length === 0
    && brkRun(ETH0, ethBox, { settings: { MIN_AGREEING_FACTS: 3, ETH_MIN_AGREEING_FACTS: 2 } }).length === 1,
    "(b) inheritance e2e: MIN_AGREEING_FACTS=3 alone also raises ETH; ETH_MIN_AGREEING_FACTS=2 keeps ETH at 2");

  // ── (c) ETH_VETO_FRACTAL_TWO_FACT ──
  const VETO = { ETH_VETO_FRACTAL_TWO_FACT: true };
  const stV = newFactEngineRunStats();
  assert(brkRun(ETH0, ethBox, { settings: VETO, statsOut: stV }).length === 0 && stV.ethFractalVetoSuppressed >= 1,
    "(c) veto: the ETH 5m {YB break, FCO} two-fact fire is suppressed and counted");
  const v1 = brkRun(ETH0, ethBox, { settings: VETO }, false, "1m", 60);
  const v1def = brkRun(ETH0, ethBox, {}, false, "1m", 60);
  assert(v1def.length === 1 && countedOf(v1def[0]) === "fractal:fco+yellowbox:break" && v1.length === 0,
    `(c) veto: the same two-fact fractal fire on the 1m primary is suppressed (default ${v1def.map(countedOf).join(" | ")})`);
  const v15def = brkRun(ETH0, ethBox, {}, false, "15m", M15);
  const v15 = brkRun(ETH0, ethBox, { settings: VETO }, false, "15m", M15);
  assert(v15def.length === 1 && countedOf(v15def[0]) === "fractal:fco+yellowbox:break" && fp(v15) === fp(v15def),
    `(c) veto: 15m is untouched (1m/5m only) (default ${v15def.map(countedOf).join(" | ")})`);
  const vRth = brkRun(RTH0, rthBox, { settings: VETO });
  assert(vRth.length === 1 && vRth[0].session === "RTH", "(c) veto: the identical RTH two-fact fractal fire is untouched");
  assert(brkRun(ETH0, ethBox, { settings: VETO }, true).length === 1, "(c) veto: a three-FAMILY ETH fire (YB + FP + FCO) is untouched");
  const noFr = brkRun(ETH0, ethBox, { settings: VETO, fractalEnabled: false }, true);
  assert(noFr.length === 1 && countedOf(noFr[0]) === "footprint:support+yellowbox:break",
    "(c) veto: a two-fact ETH fire WITHOUT a fractal fact (YB + FP) is untouched");
  // Family counting: {YB break, fractal breakout, FCO} is 3 counted facts but the Fr+YB combo.
  assert(isEthFractalTwoFactVeto([ybP, frL, F({ strategy: "fractal", direction: "Long", kind: "fco" })], false, "5m", { ...s, ...VETO }),
    "(c) veto predicate: YB + breakout + FCO (one Fr family) = a two-family Fr+YB combo → vetoed");
  assert(isEthFractalTwoFactVeto([seP, frL], false, "1m", { ...s, ...VETO }) && !isEthFractalTwoFactVeto([seP, frL], false, "1m", s)
    && !isEthFractalTwoFactVeto([seP, frL], true, "1m", { ...s, ...VETO }) && !isEthFractalTwoFactVeto([seP, frL, fpL], false, "1m", { ...s, ...VETO })
    && !isEthFractalTwoFactVeto([seP, F({ strategy: "fractalGeo", direction: "Long", kind: "reclaim" })], false, "1m", { ...s, ...VETO }),
    "(c) veto predicate: vse-driven Fr+Vec vetoed; off by default; RTH / 3-family / fractal-GEOMETRY never");
  // Silent like a gate block: the vetoed bar does NOT consume the cooldown — the next bar
  // (still inside the 3-bar break event, now with footprint = three families) fires instead.
  {
    const { candles } = brk(ETH0);
    const fpNext = new Map<number, FpImbalanceZone[]>([[ETH0 + M5, [{ startPrice: 112.2, endPrice: 112.8, direction: "buy", levelCount: 3 }]]]);
    const mk = (settings?: Partial<typeof s>) => runFactEngine({
      primary: "5m", slices: [{ interval: "5m", candles, vector: vec(candles, 80) }], zones: [], dayZones: [ethBox],
      footprintByTime: fpNext, nowSec: ETH0 + 50 * M5, qualityGateEnabled: false, ictEnabled: false, fractalGeoEnabled: false,
      exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 }, settings,
    }).map(x => (x.time - ETH0) / M5);
    assert(JSON.stringify(mk()) === "[0]" && JSON.stringify(mk(VETO)) === "[1]",
      `(c) veto is silent: no cooldown consumed — the next bar fires instead (default ${JSON.stringify(mk())}, veto ${JSON.stringify(mk(VETO))})`);
  }

  // ── (d) NEWS BLACKOUT WINDOWS ── (RTH 10:00 bar: close = entry = 10:05 ET)
  const close0 = RTH0 + M5;
  const bl = (windows: FactEngineInput["newsBlackouts"], statsOut?: ReturnType<typeof newFactEngineRunStats>) =>
    brkRun(RTH0, rthBox, { newsBlackouts: windows, statsOut });
  assert(bl(undefined).length === 1 && bl([]).length === 1, "(d) control: no windows → the RTH break fires");
  const stB = newFactEngineRunStats();
  assert(bl([{ fromSec: close0 - 600, toSec: close0 + 600, label: "ISM 10:00" }], stB).length === 0,
    "(d) a window containing the bar CLOSE suppresses the fire");
  assert(stB.newsBlackoutSuppressed === 1 && stB.newsBlackoutByLabel["ISM 10:00"] === 1,
    `(d) statsOut counts the blackout suppression by label (got ${JSON.stringify(stB)})`);
  assert(bl([{ fromSec: close0, toSec: close0 + 60, label: "x" }]).length === 0, "(d) half-open: fromSec == close is INSIDE");
  assert(bl([{ fromSec: close0 - 600, toSec: close0, label: "x" }]).length === 1, "(d) half-open: toSec == close is OUTSIDE");
  assert(bl([{ fromSec: RTH0 - 3600, toSec: RTH0 - 1800, label: "earlier" }, { fromSec: close0 + 3600, toSec: close0 + 7200, label: "later" }]).length === 1,
    "(d) windows that do not contain the close suppress nothing");
  assert(bl([{ fromSec: close0 + 600, toSec: close0 - 600, label: "inverted" }, { fromSec: Number.NaN, toSec: close0 + 1, label: "nan" }]).length === 1,
    "(d) malformed windows (inverted / non-finite) are ignored");
  assert(brkRun(ETH0, ethBox, { newsBlackouts: [{ fromSec: ETH0, toSec: ETH0 + 10 * M5, label: "x" }] }).length === 0,
    "(d) blackouts apply to ETH bars too");
  {
    // Silent: the blacked-out bar consumes no cooldown — the next (still-breaking) bar fires.
    // (ETH bar: the RTH HOD/LOD proximity rule would mask the next bar on the RTH twin.)
    const ethClose0 = ETH0 + M5;
    const ethRun = (newsBlackouts?: FactEngineInput["newsBlackouts"]) =>
      brkRun(ETH0, ethBox, { newsBlackouts, nowSec: ETH0 + 50 * M5 }).map(x => (x.time - ETH0) / M5);
    assert(JSON.stringify(ethRun()) === "[0]" && JSON.stringify(ethRun([{ fromSec: ethClose0, toSec: ethClose0 + 1, label: "x" }])) === "[1]",
      `(d) blackout is silent: no cooldown consumed — the next bar fires instead (got ${JSON.stringify(ethRun([{ fromSec: ethClose0, toSec: ethClose0 + 1, label: "x" }]))})`);
  }
  // Tape-level: a 1-second window at the close of every default RTH 5m fire — none of them
  // can be emitted any more and the suppressions are counted. (Not one count per window: a
  // removed fire frees the cooldown, so a substitute fire can shadow a LATER default fire
  // before it ever reaches the blackout check — the counter reports what this run removed.)
  const rthDef = def5.filter(x => x.session === "RTH");
  const winTape = rthDef.map(x => ({ fromSec: x.time + 300, toSec: x.time + 301, label: "print" }));
  const stT = newFactEngineRunStats();
  const tapeBl = runFactEngine(wInput("5m", { newsBlackouts: winTape, statsOut: stT }));
  assert(rthDef.length >= 2 && tapeBl.every(x => newsBlackoutAt(winTape, x.time + 300) == null),
    `(d) tape: no emitted fire closes inside a blackout window (${rthDef.length} RTH windows)`);
  assert(stT.newsBlackoutSuppressed >= 1 && stT.newsBlackoutSuppressed <= rthDef.length + tapeBl.length
    && stT.newsBlackoutByLabel["print"] === stT.newsBlackoutSuppressed,
    `(d) tape: statsOut counts the suppressed fires, by label (${stT.newsBlackoutSuppressed} of ${rthDef.length} windows)`);
  assert(fp(tapeBl.filter(x => x.session === "ETH" && x.time < rthDef[0].time)) === fp(def5.filter(x => x.session === "ETH" && x.time < rthDef[0].time)),
    "(d) tape: fires before the first blackout window are unchanged");

  // ═══════════════════════════════════════════════════════════════════════════
  // 2026-10-01 SHADOW RULES + SHADOW TAGS (docs/signal-analysis-2026-10-01.md R1–R4 + Set B cap):
  // REQUIRE_BOX_SIDE, MIN/MAX_SESSION_RANGE_FRAC, BLOCK_TIGHT_ROOM_INTERVALS,
  // MIN_TP1_PTS_BY_INTERVAL (all OFF) + FactSignal.shadowTags (record-only, always computed).
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("── shadow rules (R1–R4 + range cap) + record-only shadow tags ──");
  // (e) DEFAULTS: the settings are OFF and explicit no-op values reproduce the golden exactly.
  assert(FACT_ENGINE_DEFAULTS.REQUIRE_BOX_SIDE === false && FACT_ENGINE_DEFAULTS.MIN_SESSION_RANGE_FRAC === 0
    && FACT_ENGINE_DEFAULTS.MAX_SESSION_RANGE_FRAC === 0 && FACT_ENGINE_DEFAULTS.BLOCK_TIGHT_ROOM_INTERVALS.length === 0
    && Object.keys(FACT_ENGINE_DEFAULTS.MIN_TP1_PTS_BY_INTERVAL).length === 0,
    "(e) shipped defaults: every shadow-rule setting is OFF");
  const NOOP = { REQUIRE_BOX_SIDE: false, MIN_SESSION_RANGE_FRAC: 0, MAX_SESSION_RANGE_FRAC: 0, BLOCK_TIGHT_ROOM_INTERVALS: [] as Interval[], MIN_TP1_PTS_BY_INTERVAL: {} };
  for (const iv of ["1m", "5m"] as Interval[]) {
    const def = runFactEngine(wInput(iv));
    assert(fnv(fp(def)) === GOLDEN[iv].hash && fp(runFactEngine(wInput(iv, { settings: NOOP }))) === fp(def),
      `(e) ${iv}: explicit no-op shadow-rule values == defaults == golden`);
    assert(def.every(x => Array.isArray(x.shadowTags)), `(e) ${iv}: every fire carries a shadowTags array (record-only)`);
  }
  const MED = 40; // tape median for the range tags (dead-tape enforcement OFF so the range tags are reachable)
  const medOver = { dayRangeMedian: MED, deadTapeSuppressEnabled: false } as const;
  const keyOf = (x: { time: number; direction: string }) => `${x.time}|${x.direction}`;
  const tagsOf = (x: { shadowTags?: string[] }) => x.shadowTags ?? [];

  // (f) TAGS on fixtures — each predicate re-derived independently on the tape's fires.
  {
    const d1 = runFactEngine(wInput("1m", medOver)), d5 = runFactEngine(wInput("5m", medOver));
    const boxOf = (t: number) => wBoxes.find(z => t >= z.sessionStartTs && t <= z.sessionEndTs) ?? null;
    const boxWrong = (x: typeof d1[number]) => { const z = boxOf(x.time); return !!z && (x.direction === "Long" ? !(x.price > z.boxTop) : !(x.price < z.boxBottom)); };
    assert([...d1, ...d5].every(x => tagsOf(x).includes("box-side-wrong") === boxWrong(x)),
      "(f) box-side-wrong ⇔ Long not closing above / Short not closing below the session box");
    assert(d1.some(x => tagsOf(x).includes("box-side-wrong")) && d1.some(x => !tagsOf(x).includes("box-side-wrong")),
      "(f) tape check: the 1m run has box-side-wrong AND box-side fires");
    assert(d5.every(x => tagsOf(x).includes("tight-room@5m15m") === !!x.riskFlags?.includes("tight-room"))
      && d5.some(x => tagsOf(x).includes("tight-room@5m15m")),
      "(f) tight-room@5m15m ⇔ the 5m fire carries the tight-room risk flag (and the tape has some)");
    assert(d1.some(x => x.riskFlags?.includes("tight-room")) && d1.every(x => !tagsOf(x).includes("tight-room@5m15m")),
      "(f) tight-room@5m15m is NEVER stamped on 1m fires (1m tight-room fires exist on the tape)");
    assert(d1.some(x => tagsOf(x).includes("1m-anchor-under-12.25")) && d5.every(x => !tagsOf(x).includes("1m-anchor-under-12.25")),
      "(f) 1m-anchor-under-12.25 appears on 1m fires and never on 5m");
    assert(d1.some(x => tagsOf(x).includes("range-below-0.25med")) && d1.some(x => tagsOf(x).includes("range-above-1.0med"))
      && d1.every(x => !(tagsOf(x).includes("range-below-0.25med") && tagsOf(x).includes("range-above-1.0med"))),
      "(f) range tags: both occur on the 1m tape, never together");
    assert(runFactEngine(wInput("1m")).every(x => !tagsOf(x).some(t => t.startsWith("range-"))),
      "(f) range tags need a dead-tape median — none without one (not judged)");
    assert(d1.every(x => JSON.stringify(tagsOf(x)) === JSON.stringify(SHADOW_TAG_IDS.filter(t => tagsOf(x).includes(t)))),
      "(f) tags are emitted in the canonical SHADOW_TAG_IDS order");
    // Unit: the predicates at their boundaries.
    const dz = { dayKeyET: "x", sessionStartTs: 0, sessionEndTs: 1e12, boxTop: 110, boxBottom: 100, initRes: 120, initSup: 90 };
    assert(isBoxSideWrong("Long", 110, dz) && !isBoxSideWrong("Long", 110.25, dz) && isBoxSideWrong("Short", 100, dz)
      && !isBoxSideWrong("Short", 99.75, dz) && isBoxSideWrong("Long", 99, dz) && !isBoxSideWrong("Long", 99, null),
      "(f) isBoxSideWrong: strict beyond-the-box on the fire side; edge / inside / wrong side = wrong; no box = not judged");
    const ctx = (o: Partial<ShadowRuleContext>): ShadowRuleContext => ({ interval: "1m", direction: "Long", close: 111, dayZone: dz,
      dayRangeSoFar: 20, dayRangeMedian: 40, riskFlags: [], nearestObstacleDist: null, ...o });
    assert(JSON.stringify(computeShadowTags(ctx({}))) === "[]", "(f) a clean fire carries no tags");
    assert(JSON.stringify(computeShadowTags(ctx({ dayRangeSoFar: 9.99 }))) === '["range-below-0.25med"]'
      && JSON.stringify(computeShadowTags(ctx({ dayRangeSoFar: 10 }))) === "[]"
      && JSON.stringify(computeShadowTags(ctx({ dayRangeSoFar: 40.25 }))) === '["range-above-1.0med"]'
      && JSON.stringify(computeShadowTags(ctx({ dayRangeSoFar: 40 }))) === "[]",
      "(f) range tags: < 0.25× median / > 1.0× median (strict)");
    assert(JSON.stringify(computeShadowTags(ctx({ nearestObstacleDist: 12 }))) === '["1m-anchor-under-12.25"]'
      && JSON.stringify(computeShadowTags(ctx({ nearestObstacleDist: 12.25 }))) === "[]"
      && JSON.stringify(computeShadowTags(ctx({ interval: "5m", nearestObstacleDist: 5 }))) === "[]",
      "(f) 1m-anchor-under-12.25: 1m only, obstacle strictly nearer than 12.25");
    assert(JSON.stringify(computeShadowTags(ctx({ interval: "15m", riskFlags: ["tight-room"] }))) === '["tight-room@5m15m"]'
      && JSON.stringify(computeShadowTags(ctx({ interval: "60m", riskFlags: ["tight-room"] }))) === "[]",
      "(f) tight-room@5m15m: 5m/15m only");
    assert(shadowRuleBlock(s, ctx({ close: 105, dayRangeSoFar: 1, riskFlags: ["tight-room"], interval: "5m" })) === null,
      "(f) shadowRuleBlock: defaults never block, whatever the tags");
  }

  // (g) EACH SETTING ON BLOCKS EXACTLY ITS TAG'S FIRES (bar-close loop, engine re-run). For each:
  // the default run has tagged fires; the ON run has NONE (substitutes freed by the silent block
  // are judged too); everything before the first tagged default fire is unchanged and that fire is
  // gone; statsOut counts the rule; a setting on an interval it does not cover changes nothing.
  const cases: Array<{ name: string; tag: string; iv: Interval; settings: Partial<typeof s>; over?: Partial<FactEngineInput> }> = [
    { name: "REQUIRE_BOX_SIDE", tag: "box-side-wrong", iv: "1m", settings: { REQUIRE_BOX_SIDE: true } },
    { name: "REQUIRE_BOX_SIDE", tag: "box-side-wrong", iv: "5m", settings: { REQUIRE_BOX_SIDE: true } },
    { name: "MIN_SESSION_RANGE_FRAC", tag: "range-below-0.25med", iv: "1m", settings: { MIN_SESSION_RANGE_FRAC: 0.25 }, over: medOver },
    { name: "MAX_SESSION_RANGE_FRAC", tag: "range-above-1.0med", iv: "1m", settings: { MAX_SESSION_RANGE_FRAC: 1.0 }, over: medOver },
    { name: "BLOCK_TIGHT_ROOM_INTERVALS", tag: "tight-room@5m15m", iv: "5m", settings: { BLOCK_TIGHT_ROOM_INTERVALS: ["5m", "15m"] } },
    { name: "MIN_TP1_PTS_BY_INTERVAL", tag: "1m-anchor-under-12.25", iv: "1m", settings: { MIN_TP1_PTS_BY_INTERVAL: { "1m": 12.25 } } },
  ];
  for (const k of cases) {
    const def = runFactEngine(wInput(k.iv, k.over));
    const st = newFactEngineRunStats();
    const on = runFactEngine(wInput(k.iv, { ...k.over, settings: k.settings, statsOut: st }));
    const firstTagged = def.findIndex(x => tagsOf(x).includes(k.tag));
    assert(firstTagged >= 0 && on.every(x => !tagsOf(x).includes(k.tag)),
      `(g) ${k.name} @${k.iv}: default has '${k.tag}' fires, the ON run has none (n ${def.length} → ${on.length})`);
    assert(fp(on.slice(0, firstTagged)) === fp(def.slice(0, firstTagged)) && !on.some(x => keyOf(x) === keyOf(def[firstTagged])),
      `(g) ${k.name} @${k.iv}: fires before the first tagged fire unchanged; the tagged fire itself is gone`);
    assert((st.shadowRuleSuppressed?.[k.name] ?? 0) >= 1, `(g) ${k.name} @${k.iv}: statsOut.shadowRuleSuppressed counts it (${JSON.stringify(st.shadowRuleSuppressed)})`);
  }
  assert(fp(runFactEngine(wInput("1m", { settings: { BLOCK_TIGHT_ROOM_INTERVALS: ["5m", "15m"] } }))) === fp(runFactEngine(wInput("1m"))),
    "(g) BLOCK_TIGHT_ROOM_INTERVALS [5m,15m] leaves the 1m run (which HAS tight-room fires) unchanged");
  assert(fp(runFactEngine(wInput("5m", { settings: { MIN_TP1_PTS_BY_INTERVAL: { "1m": 12.25 } } }))) === fp(runFactEngine(wInput("5m"))),
    "(g) MIN_TP1_PTS_BY_INTERVAL {1m} leaves the 5m run unchanged");
  assert(fp(runFactEngine(wInput("1m", { ...medOver, settings: { MIN_SESSION_RANGE_FRAC: 1e-6, MAX_SESSION_RANGE_FRAC: 1e6 } }))) === fp(runFactEngine(wInput("1m", medOver))),
    "(g) range floor/cap that match nothing are byte-identical");
  assert(fp(runFactEngine(wInput("1m", { settings: { MIN_SESSION_RANGE_FRAC: 0.25, MAX_SESSION_RANGE_FRAC: 1.0 } }))) === fp(runFactEngine(wInput("1m"))),
    "(g) range floor/cap without a dead-tape median: not judged (no block)");
  {
    // SILENT: a blocked fire consumes no cooldown — the ON run fires INSIDE the cooldown window of
    // a removed default fire (impossible had the removed fire set the cursor).
    const def = runFactEngine(wInput("1m"));
    const on = runFactEngine(wInput("1m", { settings: { REQUIRE_BOX_SIDE: true } }));
    const onKeys = new Set(on.map(keyOf));
    const removed = def.filter(x => !onKeys.has(keyOf(x)));
    const inside = on.some(x => removed.some(r => x.time > r.time && x.time - r.time < s.COOLDOWN_BARS * 60));
    assert(removed.length >= 1 && inside, `(g) REQUIRE_BOX_SIDE is silent: a fire lands inside a removed fire's cooldown window (${removed.length} removed)`);
  }

  // (h) FORMING-BAR PATH: the same rules + tags on evaluateFormingBar (RTH strong zone reaction).
  {
    const tF = et(7, 10, 30);
    const closed: FiringCandle[] = [];
    for (let k = 6; k >= 1; k--) closed.push(C(tF - k * M5, 102, 102.5, 101.5, 102.2));
    const forming = C(tF, 100.7, 104.7, 100.4, 104.5); // close 104.5, session range 100.4..104.7 = 4.3
    const dzOf = (boxTop: number, initRes: number) => ({ dayKeyET: "2026-07-07", sessionStartTs: et(6, 18, 0), sessionEndTs: et(7, 17, 0), boxTop, boxBottom: 95, initRes, initSup: 85 });
    const fb = (o: Partial<Parameters<typeof evaluateFormingBar>[0]>) => evaluateFormingBar({
      interval: "5m", formingBar: forming, closedCandles: closed, zones: [SUPPORT], deadTapeSuppressEnabled: false, ...o,
    });
    const inside = fb({ dayZones: [dzOf(106, 140)] });
    const above = fb({ dayZones: [dzOf(103, 140)] });
    assert(inside != null && tagsOf(inside).includes("box-side-wrong") && above != null && !tagsOf(above).includes("box-side-wrong"),
      "(h) forming: a Long closing inside the box is tagged box-side-wrong; above the box is not");
    assert(fb({ dayZones: [dzOf(106, 140)], settings: { REQUIRE_BOX_SIDE: true } }) === null
      && fb({ dayZones: [dzOf(103, 140)], settings: { REQUIRE_BOX_SIDE: true } }) != null,
      "(h) forming: REQUIRE_BOX_SIDE blocks the inside-box Long, keeps the above-box Long");
    const lo = fb({ dayRangeMedian: 20 }), hi = fb({ dayRangeMedian: 4 });
    assert(lo != null && JSON.stringify(tagsOf(lo)) === '["range-below-0.25med"]' && hi != null && JSON.stringify(tagsOf(hi)) === '["range-above-1.0med"]',
      `(h) forming: range 4.3 vs median 20 → range-below; vs median 4 → range-above (${JSON.stringify(lo?.shadowTags)} / ${JSON.stringify(hi?.shadowTags)})`);
    assert(fb({ dayRangeMedian: 20, settings: { MIN_SESSION_RANGE_FRAC: 0.25 } }) === null && fb({ dayRangeMedian: 20, settings: { MIN_SESSION_RANGE_FRAC: 0.2 } }) != null
      && fb({ dayRangeMedian: 4, settings: { MAX_SESSION_RANGE_FRAC: 1.0 } }) === null && fb({ dayRangeMedian: 4, settings: { MAX_SESSION_RANGE_FRAC: 1.1 } }) != null,
      "(h) forming: MIN/MAX_SESSION_RANGE_FRAC block exactly across their thresholds");
    const tight = fb({ dayZones: [dzOf(103, 105)] }); // initRes 0.5 above the entry < TP1 distance
    assert(tight != null && !!tight.riskFlags?.includes("tight-room") && tagsOf(tight).includes("tight-room@5m15m"),
      "(h) forming: a 5m fire with tight room is tagged tight-room@5m15m");
    assert(fb({ dayZones: [dzOf(103, 105)], settings: { BLOCK_TIGHT_ROOM_INTERVALS: ["5m"] } }) === null
      && fb({ dayZones: [dzOf(103, 105)], settings: { BLOCK_TIGHT_ROOM_INTERVALS: ["15m"] } }) != null,
      "(h) forming: BLOCK_TIGHT_ROOM_INTERVALS blocks on a listed interval only");
    const NEAR_RES: FiringZone = { topPrice: 112, bottomPrice: 110, color: "#ef4444", label: "resistance", fromTime: et(1, 0, 0) };
    const near5 = fb({ zones: [SUPPORT, NEAR_RES] });
    assert(near5 != null && fb({ zones: [SUPPORT, NEAR_RES], settings: { MIN_TP1_PTS_BY_INTERVAL: { "5m": 6 } } }) === null
      && fb({ zones: [SUPPORT, NEAR_RES], settings: { MIN_TP1_PTS_BY_INTERVAL: { "1m": 12.25 } } }) != null,
      "(h) forming: MIN_TP1_PTS_BY_INTERVAL blocks a 5.5-pt obstacle at a 6-pt 5m floor; a 1m floor leaves 5m alone");
    const near1 = fb({ interval: "1m", zones: [SUPPORT, NEAR_RES] });
    assert(near1 != null && tagsOf(near1).includes("1m-anchor-under-12.25") && near5 != null && !tagsOf(near5).includes("1m-anchor-under-12.25")
      && fb({ interval: "1m", zones: [SUPPORT, NEAR_RES], settings: { MIN_TP1_PTS_BY_INTERVAL: { "1m": 12.25 } } }) === null,
      "(h) forming: a 1m fire 5.5 pts under an obstacle is tagged 1m-anchor-under-12.25 and blocked by the 1m 12.25 floor");
  }
}
// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
