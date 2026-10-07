// scripts/shadow-scalps-card.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-06 SHADOW SCALPS CARD — the pure helpers exported from
// client/src/components/terminal/ShadowScalpsCard.tsx (no DOM, no DB, no server, no React render).
// NO test framework — plain asserts:
//   npx tsx scripts/shadow-scalps-card.test.ts   (exit 0 = all pass)
//
//   T1  shadowStatus chip: RECORDING below the kill sample, KEEP at/above it, KILL on the flag,
//       PROMOTABLE on promotion.all; the route's killMinN overrides the default.
//   T2  number formatting: signed / plain / pct / PF (∞ when wins and no losses) / z+p / ago /
//       day keys — every null, undefined, NaN and Infinity → "—" (or "never").
//   T3  selectShadowRows on a hand-built route body: three strategies × decision cell at
//       pessimistic fills, learning cells only behind the toggle, decision joined by
//       strategy|variant|cell (live-only chip under era=all), placeholders for missing slots.
//   T4  null-safety: {enabled:false}, {}, null, undefined, rows not an array, rows with holes.
//   T5  sessionsLine / frictionTip / shadowQueryUrl.
//   T6  NO RANDOM-ENTRY CONTROL (owner decision 2026-10-07): the header has no RANDOM / Δ-vs-RANDOM
//       column, the grid has one track per header column, the footnote is exactly "Record only — no
//       orders, no alerts.", view rows carry no null / z / p fields, the tips never mention a control,
//       and the component source has no trace of the old control fields.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  shadowStatus, shadowStatusColor, shadowStatusTip, shadowEnabled, selectShadowRows,
  fmtSigned, fmtNum, fmtPct, fmtPF, fmtAgo, fmtDayKey, sessionsLine, frictionTip, shadowQueryUrl,
  SHADOW_STRATEGIES, SHADOW_KILL_MIN_N, SHADOW_DECISION_CELL, SHADOW_HEADER, SHADOW_GRID, SHADOW_FOOTNOTE,
  type ShadowSummary, type ShadowSummaryRow, type ShadowDecision, type ShadowStats,
} from "../client/src/components/terminal/ShadowScalpsCard";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

function stats(p: Partial<ShadowStats> & { n: number }): ShadowStats {
  return {
    wins: 0, winPct: null, netPerTrade: null, netPts: 0, pf: null, maxDD: 0,
    halves: { h1: { n: 0, netPerTrade: null }, h2: { n: 0, netPerTrade: null }, splitDay: null },
    dropBest3NetPerTrade: null, sd: null,
    ...p,
  };
}
function row(strategy: string, variant: string, cell: string, fillModel: string, s: Partial<ShadowStats> & { n: number }, extra: Partial<ShadowSummaryRow> = {}): ShadowSummaryRow {
  return {
    strategy, variant, cell, decisionCell: cell === "6/8", fillModel, stats: stats(s),
    netPerTradeByFriction: { "0.7": 0.5, "1.0": 0.2, "1.5": -0.3 },
    kill: false,
    ...extra,
  };
}
function decision(strategy: "S1" | "S2", variant: string, cell: string, liveN: number, kill: boolean, all: boolean): ShadowDecision {
  return {
    strategy, variant, cell, decisionCell: cell === "6/8", liveN, netPerTrade: 0.2, h1: 0.1, h2: 0.3,
    dropBest3NetPerTrade: 0.05, kill,
    promotion: { nOk: all, netOk: all, halvesOk: all, dropBest3Ok: all, all },
    verdict: kill ? "KILL" : "KEEP",
  };
}

console.log("── T1 status chip ──");
assert(shadowStatus({ liveN: 0, kill: false, promotable: false }) === "RECORDING", "n=0 → RECORDING");
assert(shadowStatus({ liveN: 99, kill: false, promotable: false }) === "RECORDING", "n=99 → RECORDING (below the kill sample)");
assert(shadowStatus({ liveN: 100, kill: false, promotable: false }) === "KEEP", "n=100 not killed → KEEP");
assert(shadowStatus({ liveN: 150, kill: true, promotable: false }) === "KILL", "kill flag → KILL");
assert(shadowStatus({ liveN: 320, kill: false, promotable: true }) === "PROMOTABLE", "promotion.all → PROMOTABLE");
assert(shadowStatus({ liveN: 320, kill: true, promotable: true }) === "PROMOTABLE", "promotable wins over kill if a body ever carried both (never by construction)");
assert(shadowStatus({ liveN: 40, kill: false, promotable: false }, 30) === "KEEP", "route killMinN=30 overrides the default 100");
assert(shadowStatus({ liveN: NaN, kill: false, promotable: false }) === "RECORDING", "NaN liveN → RECORDING, never a verdict");
assert(SHADOW_KILL_MIN_N === 100 && SHADOW_DECISION_CELL === "6/8", "defaults match the research plan (kill at 100, decision cell 6/8)");
assert(new Set(["RECORDING", "KEEP", "KILL", "PROMOTABLE"].map((s) => shadowStatusColor(s as any))).size === 4, "each status has its own color");
assert(/RECORDING|Recording/.test(shadowStatusTip("RECORDING", 37)) && shadowStatusTip("RECORDING", 37).includes("37 of 100"), "RECORDING tip counts n of killMinN");
assert(shadowStatusTip("RECORDING", 5, { killMinN: 50 }).includes("5 of 50"), "tip uses the route's killMinN");
assert(shadowStatusTip("PROMOTABLE", 300).includes("SIM"), "PROMOTABLE tip says the next step is SIM hand-trading, not an order");

console.log("── T2 formatting ──");
assert(fmtSigned(0.42) === "+0.42", "fmtSigned positive");
assert(fmtSigned(-1.3) === "−1.30", "fmtSigned negative uses a true minus sign");
assert(fmtSigned(0) === "0.00", "fmtSigned zero has no sign");
assert(fmtSigned(-0.001) === "0.00", "fmtSigned rounds-to-zero has no sign");
assert(fmtSigned(null) === "—" && fmtSigned(undefined) === "—" && fmtSigned(NaN) === "—" && fmtSigned(Infinity) === "—", "fmtSigned null/undefined/NaN/Infinity → —");
assert(fmtNum(12.5) === "12.50" && fmtNum(null) === "—" && fmtNum(NaN) === "—", "fmtNum");
assert(fmtPct(61.25) === "61.3%" && fmtPct(null) === "—", "fmtPct one decimal");
assert(fmtPF(1.237) === "1.24", "fmtPF value");
assert(fmtPF(null, true) === "∞", "fmtPF null with wins → ∞ (no losses)");
assert(fmtPF(null, false) === "—" && fmtPF(null) === "—", "fmtPF null without wins → —");
const NOW = Date.parse("2026-10-06T22:00:00Z");
assert(fmtAgo(null, NOW) === "never" && fmtAgo(undefined, NOW) === "never" && fmtAgo("garbage", NOW) === "never", "fmtAgo null/garbage → never");
assert(fmtAgo("2026-10-06T21:59:40Z", NOW) === "just now", "fmtAgo < 60 s");
assert(fmtAgo("2026-10-06T21:48:00Z", NOW) === "12 min ago", "fmtAgo minutes");
assert(fmtAgo("2026-10-06T19:00:00Z", NOW) === "3 h ago", "fmtAgo hours");
assert(fmtAgo("2026-10-03T22:00:00Z", NOW) === "3 d ago", "fmtAgo days");
assert(fmtAgo("2026-10-06T22:05:00Z", NOW) === "just now", "fmtAgo clock-skew future → just now, never negative");
assert(fmtDayKey("2026-09-16") === "Sep 16" && fmtDayKey("2026-10-06") === "Oct 6", "fmtDayKey");
assert(fmtDayKey(null) === "—" && fmtDayKey("weird") === "weird", "fmtDayKey null → —, unknown shape passed through");

console.log("── T3 selectShadowRows ──");
const body: ShadowSummary = {
  era: "all", frictionPts: 1.0, frictionsShown: [0.7, 1.0, 1.5],
  sessions: { count: 14, first: "2026-09-16", last: "2026-10-06", halvesSplitDay: "2026-09-26", byEra: { backfill: 90, live: 14 } },
  rows: [
    // S1 decision cell at every fill model — only pessimistic may be picked
    row("S1", "orb30", "6/8", "optimistic", { n: 500, netPerTrade: 2.0 }),
    row("S1", "orb30", "6/8", "standard", { n: 500, netPerTrade: 1.0 }),
    row("S1", "orb30", "6/8", "pessimistic", { n: 104, wins: 61, winPct: 58.65, netPerTrade: 0.21, pf: 1.09, maxDD: 31.5,
      halves: { h1: { n: 52, netPerTrade: -0.1 }, h2: { n: 52, netPerTrade: 0.52 }, splitDay: "2026-09-26" } }),
    row("S1", "orb30", "4/6", "pessimistic", { n: 104, netPerTrade: -0.4 }),
    row("S1", "orb30", "5/8", "pessimistic", { n: 104, netPerTrade: -0.1 }),
    row("S2", "limit", "6/8", "pessimistic", { n: 320, wins: 200, winPct: 62.5, netPerTrade: 0.35, pf: 1.3, maxDD: 20 }),
    row("S2", "close", "6/8", "pessimistic", { n: 310, wins: 170, winPct: 54.8, netPerTrade: -0.55, pf: 0.8, maxDD: 60 }, { kill: true }),
    // a stale body from an old server still carrying legacy control rows: never display rows
    row("null-S1", "random", "6/8", "pessimistic", { n: 2000, netPerTrade: -1.1 }, { kill: null }),
    row("null-S2", "random", "6/8", "pessimistic", { n: 2000, netPerTrade: -1.0 }, { kill: null }),
  ],
  decisions: [
    decision("S1", "orb30", "6/8", 37, false, false),   // live-only count differs from the era=all n
    decision("S1", "orb30", "4/6", 37, false, false),
    decision("S1", "orb30", "5/8", 37, false, false),
    decision("S2", "limit", "6/8", 320, false, true),
    decision("S2", "close", "6/8", 310, true, false),
  ],
  lastRunAt: "2026-10-06T21:35:00.000Z",
  cells: [{ id: "6/8", tp: 6, sl: 8, decision: true }, { id: "4/6", tp: 4, sl: 6, decision: false }, { id: "5/8", tp: 5, sl: 8, decision: false }],
  decisionCell: "6/8",
  rules: { killMinN: 100, killNetBelow: -0.3, promoteMinN: 300, promoteNetAtLeast: 0.3 },
  note: "RECORD ONLY",
};
assert(shadowEnabled(body), "a body with a rows array is enabled");
const dec = selectShadowRows(body);
assert(dec.length === 3, "decision-cell view has exactly three rows");
assert(dec.map((r) => r.label).join("|") === SHADOW_STRATEGIES.map((s) => s.label).join("|"), "rows follow the fixed strategy order S1 ORB-30, S2 [limit], S2 [close]");
assert(dec.every((r) => r.cell === "6/8" && r.decisionCell), "only the decision cell without the learning toggle");
assert(!dec.some((r) => r.strategy.startsWith("null-")), "legacy control rows in a stale body are never display rows");
const s1 = dec[0];
assert(s1.n === 104 && s1.winPct === 58.65 && s1.netPerTrade === 0.21 && s1.pf === 1.09 && s1.maxDD === 31.5, "S1 stats come from the PESSIMISTIC row, not optimistic/standard");
assert(s1.h1 === -0.1 && s1.h2 === 0.52 && s1.splitDay === "2026-09-26", "S1 halves + split day");
assert(["nullNet", "nullN", "minusNull", "z", "p"].every((k) => !(k in s1)), "view rows carry no random-control / Δ / z / p fields (owner decision 2026-10-07)");
assert(s1.liveN === 37 && s1.status === "RECORDING", "S1 chip uses the LIVE-ONLY decision count (37 < 100 → RECORDING) even though era=all shows n=104");
assert(dec[1].status === "PROMOTABLE" && dec[1].liveN === 320, "S2 [limit] promotion.all → PROMOTABLE");
assert(dec[2].status === "KILL" && dec[2].liveN === 310, "S2 [close] kill → KILL");
assert(dec[1].hasWins && dec[0].byFriction["1.5"] === -0.3, "hasWins + byFriction carried");
const learn = selectShadowRows(body, { showLearning: true });
assert(learn.length === 9, "learning toggle → 3 strategies × 3 cells");
assert(learn.slice(0, 3).map((r) => r.cell).join(",") === "6/8,4/6,5/8", "cells ordered decision cell first, then the route's learning cells");
assert(learn[1].n === 104 && learn[1].netPerTrade === -0.4 && !learn[1].decisionCell, "S1 4/6 learning row populated and flagged non-decision");
assert(learn[4].n === 0 && learn[4].status === "RECORDING" && learn[4].netPerTrade === null, "a slot the route has no row for → placeholder n=0 RECORDING");
// A decision missing for a slot → chip from the row's own kill flag + liveN 0
const noDec = selectShadowRows({ ...body, decisions: [] });
assert(noDec[2].status === "KILL" && noDec[2].liveN === 0, "no decisions array entry → the row's own kill flag still shows KILL");
assert(noDec[0].status === "RECORDING", "no decision → liveN 0 → RECORDING");
// Route-level killMinN override flows into the chip
const lowBar = selectShadowRows({ ...body, rules: { killMinN: 30 } });
assert(lowBar[0].status === "KEEP", "rules.killMinN=30 → S1 at liveN 37 is KEEP");

console.log("── T4 null-safety ──");
for (const [name, v] of [["{enabled:false}", { enabled: false }], ["{}", {}], ["null", null], ["undefined", undefined], ["rows:string", { rows: "nope" }], ["number", 42], ["array", []]] as Array<[string, any]>) {
  assert(shadowEnabled(v) === false, `shadowEnabled(${name}) is false`);
  const r = selectShadowRows(v);
  assert(r.length === 3 && r.every((x) => x.n === 0 && x.status === "RECORDING" && x.netPerTrade === null && x.winPct === null && x.pf === null), `selectShadowRows(${name}) → 3 placeholder RECORDING rows, no throw`);
  assert(sessionsLine(v) === "no sessions recorded yet", `sessionsLine(${name}) safe`);
}
assert(shadowEnabled({ enabled: false, rows: [] }) === false, "enabled:false wins even with a rows array");
assert(shadowEnabled({ rows: [] }) === true && selectShadowRows({ rows: [] }).length === 3, "empty rows → enabled, placeholders");
const holey = selectShadowRows({ rows: [null as any, { strategy: "S1", variant: "orb30", cell: "6/8", fillModel: "pessimistic" } as any], decisions: [undefined as any] });
assert(holey[0].n === 0 && holey[0].status === "RECORDING" && holey[0].maxDD === null, "a row with no stats object and a null decision → safe placeholder values");
const nanBody: ShadowSummary = { rows: [row("S1", "orb30", "6/8", "pessimistic", { n: 10, netPerTrade: NaN as any, winPct: Infinity as any, pf: NaN as any })] };
assert(selectShadowRows(nanBody)[0].netPerTrade === null && selectShadowRows(nanBody)[0].winPct === null && selectShadowRows(nanBody)[0].pf === null, "NaN / Infinity stats are nulled, never rendered as 'NaN'");

console.log("── T5 lines ──");
assert(sessionsLine(body) === "14 sessions · Sep 16 → Oct 6 · live 14 / backfill 90", "sessionsLine full");
assert(sessionsLine({ sessions: { count: 1, first: "2026-10-06", last: "2026-10-06", halvesSplitDay: null } }) === "1 session · Oct 6", "sessionsLine single session, no byEra");
assert(sessionsLine({ sessions: { count: 0, first: null, last: null, halvesSplitDay: null } }) === "no sessions recorded yet", "sessionsLine zero");
const ft = frictionTip({ "1.0": 0.2, "0.7": 0.5, "1.5": -0.3 }, 1.0);
assert(ft.includes("0.7 pt → +0.50 · 1.0 pt → +0.20 · 1.5 pt → −0.30") && ft.includes("Shown: 1.0 pt"), "frictionTip sorts by friction and marks the shown one");
assert(frictionTip({}, 1.5).includes("1.5-pt"), "frictionTip with no data still names the shown friction");
assert(shadowQueryUrl("live", 1.0) === "/api/signals/shadow-scalps/summary?era=live&friction=1.0", "default query url");
assert(shadowQueryUrl("all", 0.7) === "/api/signals/shadow-scalps/summary?era=all&friction=0.7", "era/friction toggles in the url");

console.log("── T6 no random-entry control (owner decision 2026-10-07) ──");
const labels = SHADOW_HEADER.map((h) => h.label);
assert(labels.join("|") === "STRATEGY|CELL|N|WIN %|NET/TR|PF|MAX DD|H1 / H2|STATUS", `header = the nine columns, no RANDOM / Δ vs RANDOM (${labels.join("|")})`);
assert(!SHADOW_HEADER.some((h) => /random|Δ|control|null|welch/i.test(`${h.label} ${h.title ?? ""}`)), "no header label or tooltip mentions a random control");
assert(SHADOW_GRID.trim().split(/\s+/).length === SHADOW_HEADER.length, `grid has one track per header column (${SHADOW_GRID.trim().split(/\s+/).length} vs ${SHADOW_HEADER.length})`);
assert(SHADOW_FOOTNOTE === "Record only — no orders, no alerts.", "footnote keeps the record-only sentence and drops the random-rows sentence");
assert((["RECORDING", "KEEP", "KILL", "PROMOTABLE"] as const).every((st) => !/random|control|null|p </i.test(shadowStatusTip(st, 120))), "status tips never mention a random control or a p-value");
assert(shadowStatusTip("PROMOTABLE", 300).includes("64.3 %") && shadowStatusTip("PROMOTABLE", 300).includes("best 3 days"), "PROMOTABLE tip states the break-even win rate and the drop-best-3 check");
const cardSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../client/src/components/terminal/ShadowScalpsCard.tsx"), "utf8");
assert(!/nullNetPerTrade|minusNull|nullN\b|nullNet\b|beatsNullOk|fmtZ|Random rows are the control/.test(cardSrc), "component source has no trace of the control fields, fmtZ or the random-rows footnote");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error(" - " + f); process.exit(1); }
