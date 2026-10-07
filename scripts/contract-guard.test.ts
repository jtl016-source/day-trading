// scripts/contract-guard.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unit harness for the server/contract-guard.ts verdict (pure assessPairs).
// NO test framework — plain asserts, run with:
//   npx tsx scripts/contract-guard.test.ts   (exit 0 = all pass)
//
// The 2026-09-17 incident: MW on the September contract, Yahoo ES=F on December, ~66.5-pt
// constant spread. The guard must trip on that signature, must NOT trip on a single bad
// print or a fast tape (non-constant diffs), and must recover once the MW chart is rolled.
// ─────────────────────────────────────────────────────────────────────────────
import {
  assessPairs, contractCode, contractParts, offsetFromDelta, rollVote, recentre, farVote,
  OFF_CONTRACT_MIN_PTS, OFF_CONTRACT_SPREAD_PTS, RECOVER_MAX_PTS, MIN_PAIRS, DECIDE_PAIRS, ROLL_VOTE_MARGIN_PTS, RECENTRE_MIN_PTS, RECENTRE_STREAK, FAST_TRIP_MIN_PTS,
  type PairSample,
} from "../server/contract-guard";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

const T0 = 1789653000; // 2026-09-17 09:50 ET
const mk = (diffs: number[], base = 7685): PairSample[] =>
  diffs.map((d, i) => ({ t: T0 + i * 60, yahoo: base + (i % 3) * 0.25, mw: base + (i % 3) * 0.25 + d }));

console.log("── trip on the roll-spread signature ──");
{
  const v = assessPairs(mk([-66.5, -66.25, -66.75, -66.5]), false);
  assert(v.offContract, "4 constant −66.5-pt minutes → off-contract");
  assert(v.delta != null && Math.abs(v.delta + 66.5) < 0.5, `delta ≈ −66.5 (got ${v.delta})`);
  assert(v.pairs === DECIDE_PAIRS, "decides on the newest DECIDE_PAIRS");
}
{
  const v = assessPairs(mk([-66.5, -66.25, -66.75]), false);
  assert(v.offContract, `exactly MIN_PAIRS (${MIN_PAIRS}) constant minutes → off-contract`);
}
{
  const v = assessPairs(mk([+40.25, +40.5, +40.25, +40.0]), false);
  assert(v.offContract, "positive constant spread (MW on the deferred month) → off-contract");
}

console.log("── never trip on noise ──");
{
  const v = assessPairs(mk([-66.5, -66.25]), false);
  assert(!v.offContract && v.pairs === 2, "fewer than MIN_PAIRS pairs → no verdict change (stays on)");
}
{
  const v = assessPairs(mk([0.25, -0.25, -66.5, 0.0]), false);
  assert(!v.offContract, "a single bad print among agreeing minutes → still on-contract");
}
{
  const v = assessPairs(mk([-12, -30, -55, -80]), false);
  assert(!v.offContract, `large but NON-constant diffs (spread > ${OFF_CONTRACT_SPREAD_PTS}) → not a roll → still on-contract`);
}
{
  const v = assessPairs(mk([-12, +12, -12, +12]), false);
  assert(!v.offContract, "sign-alternating diffs → not a roll → still on-contract");
}
{
  const v = assessPairs(mk([-(OFF_CONTRACT_MIN_PTS - 1), -(OFF_CONTRACT_MIN_PTS - 1), -(OFF_CONTRACT_MIN_PTS - 1)]), false);
  assert(!v.offContract, `constant offset just under OFF_CONTRACT_MIN_PTS (${OFF_CONTRACT_MIN_PTS}) → still on-contract`);
}
{
  const v = assessPairs(mk([0.5, -0.25, 0.75, 0.0]), false);
  assert(!v.offContract, "normal ES-vs-MES agreement → on-contract");
}

console.log("── recovery (hysteresis) ──");
{
  const v = assessPairs(mk([-66.5, -66.25, 0.25, 0.0]), true);
  assert(v.offContract, "only 2 of the newest 4 agree → stays off-contract");
}
{
  const v = assessPairs(mk([-66.5, 0.25, -0.25, 0.5, 0.0]), true);
  assert(!v.offContract, "newest 4 all within RECOVER_MAX_PTS → recovered (old −66.5 pair aged out)");
}
{
  const v = assessPairs(mk([RECOVER_MAX_PTS + 1, 0.25, 0.0, 0.5]), true);
  assert(v.offContract, `one of the newest 4 outside RECOVER_MAX_PTS (${RECOVER_MAX_PTS}) → still off-contract`);
}
{
  const v = assessPairs(mk([0.25, 0.0]), true);
  assert(v.offContract, "fewer than MIN_PAIRS pairs while off → stays off (no premature resume)");
}
{
  const v = assessPairs([], true);
  assert(v.offContract && v.pairs === 0, "no pairs at all while off (restored state) → stays off");
}

console.log("── ordering / pairing robustness ──");
{
  const shuffled = mk([-66.5, -66.25, -66.75, -66.5]).reverse();
  const v = assessPairs(shuffled, false);
  assert(v.offContract, "samples in any order → same verdict");
}
{
  // newest 4 agree, older 4 disagree → the older ones must not matter
  const v = assessPairs(mk([-66.5, -66.5, -66.5, -66.5, 0.0, 0.25, -0.25, 0.5]), false);
  assert(!v.offContract, "decision uses the NEWEST pairs only");
}

console.log("── contractCode: month code from the study's raw symbol ──");
{
  assert(contractCode("MESU6.CME") === "U6", "MESU6.CME → U6");
  assert(contractCode("MESU26") === "U6", "MESU26 → U6 (two-digit year folded)");
  assert(contractCode("mesz6") === "Z6", "lower-case MESZ6 → Z6");
  assert(contractCode("ESH7.CME") === "H7", "ESH7.CME → H7");
  assert(contractCode("MES") === null, "continuous MES → null");
  assert(contractCode("ES=F") === null, "Yahoo ES=F → null");
  assert(contractCode("") === null && contractCode(undefined) === null, "empty/undefined → null");
}

console.log("── offsetFromDelta: tick-rounded front-month offset ──");
{
  assert(offsetFromDelta(-66.5) === 66.5, "delta −66.5 (MW below Yahoo) → +66.5");
  assert(offsetFromDelta(66.4) === -66.5, "delta +66.4 → −66.5 (rounded to the 0.25 tick)");
  assert(offsetFromDelta(-66.6) === 66.5, "delta −66.6 → +66.5 (rounded to the 0.25 tick)");
  assert(offsetFromDelta(null) === 0, "no delta → 0");
  assert(offsetFromDelta(0.1) === 0, "sub-tick delta → 0");
}

console.log("── contractParts: root gate + continuous spellings + provider suffixes ──");
{
  const p1 = contractParts("MESU6");
  assert(!!p1 && p1.root === "MES" && p1.code === "U6", "MESU6 → root MES, code U6 (the confirmed MotiveWave/Rithmic spelling)");
  const p2 = contractParts("MESU6.CME.RITHMIC");
  assert(!!p2 && p2.root === "MES" && p2.code === "U6", "MESU6.CME.RITHMIC (getKey form) → MES / U6");
  const p3 = contractParts("ESZ6");
  assert(!!p3 && p3.root === "ES" && p3.code === "Z6", "ESZ6 → root ES (another instrument's relay must not read as an MES roll)");
  const p4 = contractParts("@MES");
  assert(!!p4 && p4.root === "MES" && p4.code === null, "@MES → root MES, no month code (continuous)");
  const p5 = contractParts("NQU6.CME");
  assert(!!p5 && p5.root === "NQ", "NQU6.CME → root NQ");
  assert(contractParts("") === null && contractParts(null) === null, "empty/null → null");
}

console.log("── recentre: the translation offset is FROZEN; re-centred only on sustained drift ──");
{
  const first = recentre(null, 66.5, 0);
  assert(first.offset === 66.5 && first.changed, "no offset yet → adopt the measured one");
  const wobble = recentre(66.5, 66.75, 0);
  assert(wobble.offset === 66.5 && !wobble.changed && wobble.streak === 0, "a one-tick wobble (< RECENTRE_MIN_PTS) never moves the offset");
  let streak = 0, off: number = 66.5, changes = 0;
  for (let i = 0; i < RECENTRE_STREAK - 1; i++) { const x = recentre(off, 66.5 + RECENTRE_MIN_PTS, streak); off = x.offset; streak = x.streak; if (x.changed) changes++; }
  assert(off === 66.5 && changes === 0 && streak === RECENTRE_STREAK - 1, "drift must persist: one short of the streak is not enough");
  const last = recentre(off, 66.5 + RECENTRE_MIN_PTS, streak);
  assert(last.changed && last.offset === 66.5 + RECENTRE_MIN_PTS && last.streak === 0, "the RECENTRE_STREAK-th consecutive drifted assessment re-centres");
  const broken = recentre(66.5, 66.5, RECENTRE_STREAK - 1);
  assert(!broken.changed && broken.streak === 0, "an agreeing assessment resets the streak");
  const forced = recentre(66.5, 67.0, 0, true);
  assert(forced.changed && forced.offset === 67.0, "first measurement after a restore adopts immediately (force)");
}

console.log("── farVote: ON-contract month-code change → is the new chart on the wrong month? (fast trip) ──");
{
  // User rolls MotiveWave to March while Yahoo's ES=F is still December: raw ticks ~+67 from Yahoo.
  assert(farVote(7767.25, 7700, 0) === 1, "a tick a roll-spread away from Yahoo votes");
  assert(farVote(7767.25, 7700, 39) === 40, "votes accumulate to the trip count");
  assert(farVote(7633.0, 7700, 3) === 4, "either direction counts (deferred OR expired month)");
  // Same-month chart (the normal roll day: MW and Yahoo both on the new front month).
  assert(farVote(7701.5, 7700, 12) === 0, "a tick near Yahoo resets the streak — the new chart is on the front month");
  assert(farVote(7700 + FAST_TRIP_MIN_PTS - 0.25, 7700, 0) === 0, "a fast tape inside Yahoo's lag (just under FAST_TRIP_MIN_PTS) does not vote");
  assert(farVote(7700 + FAST_TRIP_MIN_PTS, 7700, 0) === 1, "exactly FAST_TRIP_MIN_PTS away votes");
}

console.log("── rollVote: raw tick fits Yahoo better untranslated → the chart was rolled ──");
{
  // Off-contract on Sep (offset +66.5), Yahoo Dec ref 7700.
  assert(rollVote(7633.5, 66.5, 7700, 0) === 0, "a Sep tick (7633.5 → 7700 translated) is NOT a roll vote");
  assert(rollVote(7700.25, 66.5, 7700, 0) === 1, "a Dec-priced tick (7700.25 raw vs 7766.75 translated) votes");
  assert(rollVote(7700.25, 66.5, 7700, 5) === 6, "consecutive votes accumulate");
  assert(rollVote(7633.5, 66.5, 7700, 5) === 0, "one non-vote resets the streak");
  // Fast tape inside Yahoo's lag: MW moved +32 (Sep 7665.5 → 7732 translated) vs ref 7700 —
  // raw 7665.5 is 34.5 away, translated is 32 away → translated still closer → no vote.
  assert(rollVote(7665.5, 66.5, 7700, 0) === 0, "a 32-pt move inside the lag does not vote (translated still nearer)");
  // Exactly the midpoint minus the margin: raw must win by ≥ ROLL_VOTE_MARGIN_PTS.
  const mid = 7700 - 66.5 / 2; // 7666.75 — equidistant
  assert(rollVote(mid, 66.5, 7700, 0) === 0, "equidistant tick does not vote (margin)");
  // At mid + x: dRaw = 33.25 − x, dTranslated = 33.25 + x → raw wins by 2x; the vote needs 2x > margin.
  assert(rollVote(mid + ROLL_VOTE_MARGIN_PTS / 2 - 0.25, 66.5, 7700, 0) === 0, "inside the margin band still does not vote");
  assert(rollVote(mid + ROLL_VOTE_MARGIN_PTS / 2 + 0.25, 66.5, 7700, 0) === 1, "past the margin band votes");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
