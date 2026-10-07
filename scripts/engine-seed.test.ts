// scripts/engine-seed.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for shared/engine-seed.ts (2026-09-25, B5 follow-up) — the browser tab's
// cross-writer seed + order-admission bookkeeping. Pure: no DB, no server, no DOM.
//   1. row / endpoint mapping (directions, NULL levels → NaN, unknown intervals, ordering)
//   2. stablePriors identity (a same-content poll re-runs no engine memo)
//   3. latestFireTimeBefore / openTradesBefore (strictly-before, latest per direction, NaN skip)
//   4. order admission: refused keys from the POST answer → verdict → the auto-trader's gate
// The engine-level effect of the seed (cooldown / open-trade blocking) is pinned in
// shared/fact-engine.test.ts ("B5 tab" asserts); the server seed + order gate against a temp
// DB in scripts/fire-admission.test.ts.
// Run: npx tsx scripts/engine-seed.test.ts
// ─────────────────────────────────────────────────────────────────────────────
import {
  directionOf, priorFireFromRow, priorsFromRows, parsePriorFiresResponse, stablePriors,
  latestFireTimeBefore, openTradesBefore, admissionKey, refusedKeysFromPersistResponse,
  persistVerdictFor, orderAdmissionBlockReason, type PriorsByInterval,
} from "../shared/engine-seed";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

const T = 1790229300;

console.log("1. mapping");
assert(directionOf("Long") === "Long" && directionOf("long") === "Long" && directionOf("SHORT") === "Short" && directionOf("x") === null && directionOf(null) === null,
  "directionOf normalizes case, rejects garbage");
{
  const pf = priorFireFromRow({ timestamp: T, direction: "short", entry: 7700, tp1: null, sl: undefined });
  assert(!!pf && pf.time === T && pf.direction === "Short" && pf.entry === 7700 && Number.isNaN(pf.tp1) && Number.isNaN(pf.sl),
    "signal_history row → PriorFire (NULL levels → NaN = cooldown-only)");
  assert(priorFireFromRow({ time: T, direction: "Long", entry: 1, tp1: 2, sl: 0 })?.time === T, "endpoint shape (`time`) accepted");
  assert(priorFireFromRow({ timestamp: Number.NaN, direction: "Long" }) === null && priorFireFromRow({ timestamp: T, direction: "?" }) === null && priorFireFromRow(null) === null,
    "unusable time / direction → skipped");
}
{
  const p = priorsFromRows([
    { interval: "1m", timestamp: T + 120, direction: "Long", entry: 1, tp1: 2, sl: 0 },
    { interval: "1m", timestamp: T, direction: "Short", entry: 1, tp1: 0, sl: 2 },
    { interval: "10", timestamp: T, direction: "Long", entry: 1, tp1: 2, sl: 0 },  // stray 10-minute relay row
    { interval: "5m", timestamp: T, direction: "long", entry: 1, tp1: 2, sl: null },
  ]);
  assert(p["1m"]?.length === 2 && p["1m"]![0].time === T && p["1m"]![1].time === T + 120, "grouped per interval, time-ordered");
  assert(!("10" in p) && p["5m"]?.[0].direction === "Long" && Number.isNaN(p["5m"]![0].sl), "unknown interval skipped; 5m row mapped");
  // Round trip through JSON (the endpoint): NaN → null → NaN.
  const back = parsePriorFiresResponse(JSON.parse(JSON.stringify({ nowSec: T, priors: p })));
  assert(!!back && back["1m"]?.length === 2 && Number.isNaN(back["5m"]![0].sl) && back["5m"]![0].tp1 === 2,
    "parsePriorFiresResponse(JSON(priorsFromRows)) round-trips (NaN survives as null → NaN)");
}
assert(parsePriorFiresResponse("<!DOCTYPE html>") === null && parsePriorFiresResponse({ error: "x" }) === null && parsePriorFiresResponse(null) === null,
  "not the endpoint's answer (old server: SPA HTML / error JSON) → null = no seed");
assert(JSON.stringify(parsePriorFiresResponse({ priors: {} })) === "{}", "empty priors → {}");

console.log("2. stablePriors");
{
  const a: PriorsByInterval = { "1m": [{ time: T, direction: "Long", entry: 1, tp1: Number.NaN, sl: 0 }], "5m": [{ time: T, direction: "Short", entry: 1, tp1: 0, sl: 2 }] };
  const sameContent: PriorsByInterval = JSON.parse(JSON.stringify(a), (_k, v) => v === null ? Number.NaN : v);
  assert(stablePriors(a, sameContent) === a, "same content (NaN == NaN) → the previous object itself (no re-render)");
  const next: PriorsByInterval = { ...sameContent, "1m": [...sameContent["1m"]!, { time: T + 60, direction: "Short", entry: 1, tp1: 0, sl: 2 }] };
  const merged = stablePriors(a, next);
  assert(merged !== a && merged["5m"] === a["5m"] && merged["1m"] === next["1m"], "one interval changed → new object, unchanged interval keeps its array identity");
  const dropped = stablePriors(a, { "5m": sameContent["5m"] });
  assert(dropped !== a && dropped["1m"] === undefined && dropped["5m"] === a["5m"], "an interval that disappeared is dropped");
  const empty: PriorsByInterval = {};
  assert(stablePriors(empty, {}) === empty, "empty → empty keeps identity");
}

console.log("3. forming-bar inputs");
{
  const stored = [
    { time: T - 600, direction: "Long", entry: 10, tp1: 20, sl: 5 },
    { time: T - 300, direction: "Long", entry: 11, tp1: 21, sl: 6 },
    { time: T - 120, direction: "Short", entry: 12, tp1: Number.NaN, sl: 15 },
    { time: T, direction: "Short", entry: 12, tp1: 2, sl: 15 },
  ];
  assert(latestFireTimeBefore([stored], T) === T - 120, "latestFireTimeBefore: strictly before (the bar's own fire excluded), either direction");
  assert(latestFireTimeBefore([undefined, []], T) === -Infinity, "no fires → −Infinity");
  assert(latestFireTimeBefore([stored, [{ time: T - 60 }]], T) === T - 60, "max across lists");
  const ot = openTradesBefore([stored], T);
  assert(ot.Long?.firedAt === T - 300 && ot.Long.entry === 11 && ot.Long.tp1 === 21 && ot.Long.sl === 6, "openTradesBefore: latest Long bracket before the bar");
  assert(ot.Short === undefined, "NaN-level Short skipped; the bar's own Short excluded");
  const ot2 = openTradesBefore([stored, [{ time: T - 60, direction: "Short", entry: 13, tp1: 3, sl: 16 }]], T);
  assert(ot2.Short?.firedAt === T - 60 && ot2.Long?.firedAt === T - 300, "latest across lists per direction");
}

console.log("4. order admission");
{
  const k = admissionKey("1m", T, "Short");
  assert(k === `1m|${T}|Short`, "admissionKey = fire-admission's natural key form");
  const body = { ok: true, inserted: 1, admissionRejected: 1, admissionKeys: [{ symbol: "MES", interval: "1m", timestamp: T, direction: "Short", reason: "cooldown", blockedBy: "1m|x|Short" }] };
  assert(refusedKeysFromPersistResponse(body).has(k) && refusedKeysFromPersistResponse(body).size === 1, "refused keys read from the POST answer");
  assert(refusedKeysFromPersistResponse({ ok: true }).size === 0 && refusedKeysFromPersistResponse(null).size === 0, "old server answer (no admissionKeys) → nothing refused");
  assert(persistVerdictFor(k, true, body) === "refused", "refused key → 'refused'");
  assert(persistVerdictFor(admissionKey("1m", T + 600, "Short"), true, body) === "stored", "other key in the same POST → 'stored'");
  assert(persistVerdictFor(k, false, null) === "failed" && persistVerdictFor(k, true, { ok: false }) === "failed", "HTTP/network failure or ok:false → 'failed'");
  assert(orderAdmissionBlockReason("refused")?.includes("fire admission") === true, "refused → the auto-trader withholds the order");
  assert(orderAdmissionBlockReason("failed") !== null, "failed → withheld (a fire that could not be stored is not a signal of record)");
  assert(orderAdmissionBlockReason("stored") === null && orderAdmissionBlockReason(undefined) === null, "stored / never posted by this tab → go ahead (server gates decide)");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
