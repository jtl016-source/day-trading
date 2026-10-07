// scripts/outcome-resolver.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unit harness for the CANONICAL trade-outcome resolver + the write-layer
// immutability matrix (shared/outcome-resolver.ts). NO test framework — plain
// asserts, run with:
//   npx tsx scripts/outcome-resolver.test.ts   (exit 0 = all pass)
//
// User-dictated semantics under test (2026-07-31, incl. the same-day correction):
//   • First touch decides, permanently (chronological 1m walk).
//   • TP1-then-SL           → win_tp1 LOCKED (a TP1 win can NEVER become a loss).
//   • TP1-then-TP2 (no SL)  → win_tp2.
//   • TP1-then-SL-then-TP2  → win_tp1 (USER CORRECTION: the SL touch ends the
//                             watch — a later TP2 does NOT upgrade).
//   • SL first              → loss locked.
//   • Same-bar TP+SL        → SL-first (conservative), both pre- and post-TP1.
//   • CARRY-OVERNIGHT (2026-08-11 user directive): NO session-end close — the walk
//     continues across the settle on later bars until TP or SL touches; untouched
//     at the data horizon → open. "eod" is never produced (vocab kept for history).
//   • Transition matrix: only (NULL|open)→*, win_tp1→win_tp2, identity, and
//     NULL-incoming no-ops are allowed; every other transition is rejected.
// ─────────────────────────────────────────────────────────────────────────────
import {
  walkOutcomeCanonical, isOutcomeTransitionAllowed,
  normalizeSignalSource, isLiveSourceCollision, effectiveSourceOnWrite,
  type CanonicalBar, type CanonicalWalkArgs,
} from "../shared/outcome-resolver";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

// 2026-07-29 is an EDT Wednesday. Entry 10:00 ET = 14:00 UTC; settle 17:00 ET = 21:00 UTC.
const ENTRY_TS = Math.floor(Date.parse("2026-07-29T14:00:00Z") / 1000);
const SETTLE_TS = Math.floor(Date.parse("2026-07-29T21:00:00Z") / 1000);
const M1 = 60;

/** 1m bar i minutes after entry, hugging `px` unless high/low widened. */
function B(i: number, px: number, opts: { high?: number; low?: number; close?: number } = {}): CanonicalBar {
  return { time: ENTRY_TS + i * M1, high: opts.high ?? px + 0.25, low: opts.low ?? px - 0.25, close: opts.close ?? px };
}

// Long fixture geometry: entry 100, TP1 105, TP2 110, SL 95.
const GEO = { entry: 100, tp1: 105, tp2: 110, sl: 95 };
function walkLong(bars: CanonicalBar[], covered = SETTLE_TS + 3600) {
  const a: CanonicalWalkArgs = {
    bars, entryTs: ENTRY_TS, entry: GEO.entry, tp1: GEO.tp1, tp2: GEO.tp2, sl: GEO.sl,
    isLong: true, settleTs: SETTLE_TS, barSec: M1, coveredThroughTs: covered,
  };
  return walkOutcomeCanonical(a);
}
function walkShort(bars: CanonicalBar[], covered = SETTLE_TS + 3600) {
  // Short mirror: entry 100, TP1 95, TP2 90, SL 105.
  const a: CanonicalWalkArgs = {
    bars, entryTs: ENTRY_TS, entry: 100, tp1: 95, tp2: 90, sl: 105,
    isLong: false, settleTs: SETTLE_TS, barSec: M1, coveredThroughTs: covered,
  };
  return walkOutcomeCanonical(a);
}

// ═══ 1. SL first → loss locked ═══
{
  const r = walkLong([B(0, 100), B(1, 97), B(2, 96, { low: 94.75 }), B(3, 106, { high: 106 })]);
  assert(r.outcome === "loss", "SL-first → loss (later TP1 touch irrelevant)");
  assert(r.exitPrice === 95 && r.exitTs === ENTRY_TS + 2 * M1 + M1, "loss exits AT the SL price on the touch bar close");
}

// ═══ 2. TP1 then SL → win_tp1 LOCKED (the reported false-record scenario) ═══
{
  const r = walkLong([B(0, 101), B(1, 99.5), B(2, 104, { high: 105.25 }), B(17, 99), B(19, 96, { low: 94.5 })]);
  assert(r.outcome === "win_tp1", "TP1-then-SL → win_tp1 locked (TP1 win can NEVER become a loss)");
  assert(r.exitPrice === 105 && r.exitTs === ENTRY_TS + 2 * M1 + M1, "win_tp1 exit = TP1 record at the TP1 touch bar");
  assert(r.tp1Ts === ENTRY_TS + 2 * M1, "tp1Ts stamps the first TP1-touch bar");
  assert(r.mfe === 5.25 && r.mae === 0.75, "win_tp1 MAE/MFE snapshot through the TP1 bar only (post-TP1 dips excluded)");
}

// ═══ 3. TP1 then TP2 with no SL between → win_tp2 ═══
{
  const r = walkLong([B(0, 101), B(2, 104, { high: 105.5 }), B(5, 107), B(8, 109, { high: 110.25 })]);
  assert(r.outcome === "win_tp2", "TP1-then-TP2 (no SL between) → win_tp2");
  assert(r.exitPrice === 110 && r.exitTs === ENTRY_TS + 8 * M1 + M1, "win_tp2 exits AT TP2 on the touch bar close");
}

// ═══ 4. TP1 then SL then TP2 → win_tp1 (USER CORRECTION: no upgrade after an SL touch) ═══
{
  const r = walkLong([B(0, 101), B(2, 104, { high: 105.25 }), B(10, 96, { low: 94.75 }), B(20, 109, { high: 110.5 })]);
  assert(r.outcome === "win_tp1", "TP1-then-SL-then-TP2 → win_tp1 (SL ends the watch; later TP2 does NOT upgrade)");
  assert(r.exitPrice === 105, "record stays the TP1 exit");
}

// ═══ 5. Same-bar TP1+SL on first touch → SL-first → loss ═══
{
  const r = walkLong([B(0, 100), B(3, 100, { high: 105.5, low: 94.5 })]);
  assert(r.outcome === "loss", "same-bar TP1+SL tie → SL-first → loss (conservative)");
}

// ═══ 6. Post-TP1 same-bar TP2+SL → SL-first → win_tp1 (no upgrade) ═══
{
  const r = walkLong([B(0, 101), B(2, 104, { high: 105.25 }), B(9, 100, { high: 110.5, low: 94.5 })]);
  assert(r.outcome === "win_tp1", "post-TP1 same-bar TP2+SL tie → SL-first → win_tp1 locked, no upgrade");
  assert(r.exitPrice === 105 && r.exitTs === ENTRY_TS + 2 * M1 + M1, "tie-ending watch keeps the TP1 record fields");
}

// ═══ 7. One SL-free bar reaching TP2 outright → win_tp2 ═══
{
  const r = walkLong([B(0, 100), B(4, 108, { high: 110.25, low: 99 })]);
  assert(r.outcome === "win_tp2", "single SL-free bar through TP2 → win_tp2 (path crossed TP1 first by construction)");
}

// ═══ 8. Neither touched — CARRY-OVERNIGHT: stays OPEN, resolves on later-session bars ═══
{
  const bars = [B(0, 100), B(30, 101), B(60, 99), B(120, 100, { close: 100.5 })];
  const done = walkLong(bars);
  assert(done.outcome === "open", "neither TP1 nor SL touched (data covers settle) → OPEN, not eod (carry-overnight)");
  assert(done.exitPrice === null && done.exitTs === null, "carry-overnight open: no exit recorded");
  // The SAME trade with a NEXT-SESSION bar touching TP1 resolves win_tp1 across the settle.
  const nextSessionBar: CanonicalBar = { time: SETTLE_TS + 3 * 3600, high: 105.5, low: 103, close: 105 };
  const carried = walkLong([...bars, nextSessionBar], SETTLE_TS + 4 * 3600);
  assert(carried.outcome === "win_tp1" && carried.exitTs === nextSessionBar.time + M1,
    "carry-overnight: a TP1 touch on a LATER session's bar resolves the trade");
  const live = walkLong(bars, ENTRY_TS + 121 * M1);
  assert(live.outcome === "open", "neither touched + session unfinished → open");
}

// ═══ 9. TP1 registers immediately; nothing after ═══
{
  const bars = [B(0, 101), B(2, 104, { high: 105.25 }), B(10, 103)];
  const live = walkLong(bars, ENTRY_TS + 11 * M1);
  assert(live.outcome === "win_tp1", "TP1 touched, session live → win_tp1 registers the moment it happens");
  const done = walkLong(bars);
  assert(done.outcome === "win_tp1", "TP1 touched, neither TP2 nor SL by settle → remains win_tp1");
}

// ═══ 10. Bars at/after the settle COUNT (carry-overnight) ═══
{
  const r = walkLong([B(0, 100), { time: SETTLE_TS, high: 106, low: 99, close: 105 }]);
  assert(r.outcome === "win_tp1", "a TP1 touch on a bar at/after settleTs RESOLVES (carry-overnight — settle is not a boundary)");
}

// ═══ 11. Short-direction mirrors ═══
{
  const a = walkShort([B(0, 99), B(2, 96, { low: 94.75 }), B(9, 103, { high: 105.5 })]);
  assert(a.outcome === "win_tp1" && a.exitPrice === 95, "SHORT TP1-then-SL → win_tp1 locked at 95");
  const b = walkShort([B(0, 100), B(1, 103, { high: 105.25 }), B(2, 92, { low: 89.5 })]);
  assert(b.outcome === "loss" && b.exitPrice === 105, "SHORT SL-first → loss at 105 (later TP2 irrelevant)");
  const c = walkShort([B(0, 99), B(2, 96, { low: 94.75 }), B(6, 91, { low: 89.75 })]);
  assert(c.outcome === "win_tp2" && c.exitPrice === 90, "SHORT TP1-then-TP2 (no SL between) → win_tp2 at 90");
}

// ═══ 12. Write-layer transition matrix ═══
{
  const ok = isOutcomeTransitionAllowed;
  for (const to of ["open", "win_tp1", "win_tp2", "loss", "eod"]) {
    assert(ok("open", to), `open → ${to} allowed (first registration)`);
    assert(ok(null, to), `NULL → ${to} allowed (first registration)`);
  }
  assert(ok("win_tp1", "win_tp2"), "win_tp1 → win_tp2 allowed (the ONLY upgrade)");
  for (const [from, to] of [
    ["win_tp1", "loss"], ["win_tp1", "eod"], ["win_tp1", "open"],
    ["win_tp2", "loss"], ["win_tp2", "win_tp1"], ["win_tp2", "open"], ["win_tp2", "eod"],
    ["loss", "win_tp1"], ["loss", "win_tp2"], ["loss", "open"], ["loss", "eod"],
    ["eod", "win_tp1"], ["eod", "loss"], ["eod", "open"], ["eod", "win_tp2"],
  ] as Array<[string, string]>) {
    assert(!ok(from, to), `${from} → ${to} REJECTED (locked record)`);
  }
  for (const same of ["open", "win_tp1", "win_tp2", "loss", "eod"]) {
    assert(ok(same, same), `${same} → ${same} identity allowed (exit-detail refinement)`);
    assert(ok(same, null), `${same} → NULL-incoming no-op allowed (COALESCE keeps stored)`);
  }
}

// ═══ 13. Source provenance — "live-fired records are permanent" (2026-07-31) ═══
{
  // Normalization: only the two known literals; everything else = NULL (regen-treated legacy).
  assert(normalizeSignalSource("live") === "live", "source 'live' normalizes to live");
  assert(normalizeSignalSource("regen") === "regen", "source 'regen' normalizes to regen");
  assert(normalizeSignalSource(undefined) === null, "absent source (legacy client) → NULL (regen-treated)");
  assert(normalizeSignalSource("LIVE") === null && normalizeSignalSource(1) === null && normalizeSignalSource("") === null,
    "garbage source values → NULL, never accidentally 'live'");

  // Collision rule: a stored live row hit by any NON-live write yields WHOLE.
  assert(isLiveSourceCollision("live", "regen"), "stored live vs regen write = COLLISION (regen yields)");
  assert(isLiveSourceCollision("live", null), "stored live vs legacy NULL write = COLLISION (NULL treated as regen)");
  assert(!isLiveSourceCollision("live", "live"), "live-path update to a live row is NOT a collision (outcome matrix governs)");
  assert(!isLiveSourceCollision("regen", "regen") && !isLiveSourceCollision("regen", null),
    "regen rows never collide — the wipe/upsert owns them");
  assert(!isLiveSourceCollision(null, "regen") && !isLiveSourceCollision(null, "live") && !isLiveSourceCollision(undefined, "regen"),
    "legacy NULL-source rows never collide (treated as regen)");

  // Write rule: source immutable once 'live'; a live write upgrades regen/NULL; NULL keeps stored.
  assert(effectiveSourceOnWrite("live", "regen") === "live", "IMMUTABLE: live row + regen write keeps source='live'");
  assert(effectiveSourceOnWrite("live", null) === "live", "IMMUTABLE: live row + legacy write keeps source='live'");
  assert(effectiveSourceOnWrite("live", "live") === "live", "live + live stays live");
  assert(effectiveSourceOnWrite("regen", "live") === "live", "a live fire UPGRADES a regen row to live (permanent thereafter)");
  assert(effectiveSourceOnWrite(null, "live") === "live", "a live fire upgrades a legacy row to live");
  assert(effectiveSourceOnWrite("regen", null) === "regen", "NULL-incoming keeps stored regen");
  assert(effectiveSourceOnWrite(null, "regen") === "regen", "regen write stamps a legacy row regen");
  assert(effectiveSourceOnWrite(null, null) === null, "legacy + legacy stays NULL");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
