// scripts/ledger-stats.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// FORWARD-VALIDATION LEDGER unit tests (pure — no DB, no fs, no server).
// Covers:
//   1. outcome normalization across every vocabulary in the system
//   2. the strict live-era source gate (live/catchup in; regen/NULL/undefined out)
//   3. deriveExpectation aggregation (win rate, expectancy, PF incl. the 999 cap,
//      per-trade std, daily-net mean/std, per-interval split, degenerate docs)
//   4. cold start: COLLECTING below 30 closed, never a fake verdict
//   5-8. verdict thresholds: OK / WATCH / ALERT-on-rolling-PF<1 / ALERT-on-2σ-breach
//   9. rolling 30-trade window correctness (+ ts-sort independence)
//  10. cumulative live-vs-expected curve math (expected = exp·n, lower2 = exp·n − 2σ√n)
//  11-14. daily-net grouping, open handling, eod/win semantics, status summary
// Run: tsx scripts/ledger-stats.test.ts
// ─────────────────────────────────────────────────────────────────────────────
import {
  normalizeLedgerOutcome, isLiveEraSource, deriveExpectation, computeLedger,
  summarizeLedgerStatus, verdictWords, etDateKey,
  MIN_CLOSED_FOR_VERDICT, ROLLING_WINDOW, PF_CAP,
  type LedgerTradeRow, type BacktestExpectation,
} from "../shared/ledger-stats";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}
function approx(a: number | null | undefined, b: number, eps = 1e-9): boolean {
  return a != null && Number.isFinite(a) && Math.abs(a - b) <= eps;
}

const T0 = 1750000000; // 2025-06 — arbitrary fixed base (epoch seconds)
const DAY = 86400;
let seq = 0;
function row(outcome: string | null, points: number | null, over?: Partial<LedgerTradeRow>): LedgerTradeRow {
  return { ts: T0 + (seq++) * 600, interval: "15m", outcome, points, source: "live", ...over };
}
function rows(points: number[], over?: Partial<LedgerTradeRow>): LedgerTradeRow[] {
  return points.map(p => row(p >= 0 ? "win_tp1" : "loss", p, over));
}
function mkExp(over?: Partial<BacktestExpectation>): BacktestExpectation {
  return {
    generatedAt: null, windowFromKey: null, windowToKey: null, trades: 100,
    expWinRate: 60, expExpectancy: 5, expPF: 2, perTradeStd: 20,
    dailyNetMean: 25, dailyNetStd: 30, tradesPerDay: 5, perInterval: {},
    ...over,
  };
}

// ── 1. outcome normalization ─────────────────────────────────────────────────
console.log("\n[1] outcome normalization");
for (const [raw, want] of [
  ["win_tp1", "win_tp1"], ["tp1", "win_tp1"], ["win", "win_tp1"], ["target", "win_tp1"],
  ["win_tp2", "win_tp2"], ["tp2", "win_tp2"],
  ["loss", "loss"], ["sl", "loss"], ["stopped", "loss"], ["stop", "loss"],
  ["eod", "eod"],
  ["open", "open"], ["filled", "open"], ["", "open"], ["garbage", "open"],
] as const) {
  assert(normalizeLedgerOutcome(raw) === want, `"${raw}" → ${want}`);
}
assert(normalizeLedgerOutcome(null) === "open", "null → open");
assert(normalizeLedgerOutcome(undefined) === "open", "undefined → open");
assert(normalizeLedgerOutcome("WIN_TP1") === "win_tp1", "case-insensitive WIN_TP1");

// ── 2. live-era source gate ──────────────────────────────────────────────────
console.log("\n[2] live-era source gate");
assert(isLiveEraSource("live"), "live is live-era");
assert(isLiveEraSource("catchup"), "catchup is live-era");
assert(!isLiveEraSource("regen"), "regen excluded");
assert(!isLiveEraSource(null), "NULL (legacy) excluded");
assert(!isLiveEraSource(undefined), "undefined excluded");
assert(!isLiveEraSource("LIVE"), "gate is strict lowercase (DB writes lowercase)");
{
  seq = 0;
  const mixed = [
    ...rows([10, 10, -5]),                          // 3 live
    ...rows([100, 100], { source: "regen" }),       // model rows — must not count
    ...rows([100], { source: null }),               // legacy NULL — must not count
    ...rows([7], { source: "catchup" }),            // catchup — counts
  ];
  const r = computeLedger(mixed, mkExp());
  assert(r.liveTradesTotal === 4, "regen/NULL rows never enter the ledger (3 live + 1 catchup)");
  assert(approx(r.liveNetPts, 10 + 10 - 5 + 7), "net over live-era rows only");
}

// ── 3. deriveExpectation ─────────────────────────────────────────────────────
console.log("\n[3] deriveExpectation");
{
  const doc = {
    meta: { generatedAt: "2026-08-01T18:03:13Z", windowFromKey: "2026-04-15", windowToKey: "2026-07-31" },
    signals: [
      ...[1, 2, 3, 4].map(i => ({ fireTs: T0 + i, dateET: "2026-07-01", interval: "1m", outcome: "tp1", pointsResult: 10 })),
      ...[5, 6].map(i => ({ fireTs: T0 + i, dateET: "2026-07-01", interval: "5m", outcome: "tp2", pointsResult: 20 })),
      ...[7, 8, 9].map(i => ({ fireTs: T0 + i, dateET: "2026-07-02", interval: "1m", outcome: "sl", pointsResult: -10 })),
      { fireTs: T0 + 10, dateET: "2026-07-02", interval: "5m", outcome: "eod", pointsResult: 2 },
      { fireTs: T0 + 11, dateET: "2026-07-02", interval: "1m", outcome: "open", pointsResult: null },   // open → excluded
      { fireTs: T0 + 12, dateET: "2026-07-02", interval: "1m", outcome: "tp1", pointsResult: null },    // no points → excluded
    ],
  };
  const e = deriveExpectation(doc)!;
  assert(e !== null, "expectation derived");
  assert(e.trades === 10, "10 closed trades (open + null-points excluded)");
  assert(approx(e.expWinRate, 60), "win rate 60% = wins/(wins+losses+eod)");
  assert(approx(e.expExpectancy, 5.2), "expectancy 5.2 pts (net 52 / 10)");
  assert(approx(e.expPF, 82 / 30), "PF 82/30");
  assert(approx(e.perTradeStd, Math.sqrt(1233.6 / 10)), "per-trade std (population)");
  assert(approx(e.dailyNetMean, 26), "daily net mean (80, −28)");
  assert(approx(e.dailyNetStd, 54), "daily net std (population)");
  assert(approx(e.tradesPerDay, 5), "trades/day = 10 closed / 2 days");
  assert(e.perInterval["1m"].trades === 7 && e.perInterval["5m"].trades === 3, "per-interval split 7/3");
  assert(approx(e.perInterval["1m"].winRate, 400 / 7), "1m win rate 4/7");
  assert(e.perInterval["5m"].pf === PF_CAP, "no-loss interval PF capped at 999");
  assert(e.generatedAt === "2026-08-01T18:03:13Z" && e.windowFromKey === "2026-04-15", "meta passthrough");
  assert(deriveExpectation({ signals: [] }) === null, "empty doc → null");
  assert(deriveExpectation({ signals: [{ outcome: "open", pointsResult: null }] }) === null, "only-open doc → null");
  assert(deriveExpectation(null) === null, "null doc → null");
}

// ── 4. cold start ────────────────────────────────────────────────────────────
console.log("\n[4] cold start");
{
  seq = 0;
  const r = computeLedger(rows([10, 10, 10, -5, -5, 10, 10, 10, -5, 10]), mkExp());
  assert(r.verdict === "COLLECTING", "10 closed → COLLECTING");
  assert(r.collecting !== null && r.collecting.closed === 10 && r.collecting.needed === MIN_CLOSED_FOR_VERDICT, "collecting 10/30 reported");
  assert(r.rolling30 === null, "no rolling stats below the window");
  assert(r.rolling30PFSeries.length === 0, "no sparkline below the window");
  assert(r.verdictReason.includes("10 of 30"), "reason states the honest count");
  const s = summarizeLedgerStatus(r);
  assert(s.verdict === "COLLECTING" && s.rolling30PF === null && s.liveTrades === 10, "status mirrors COLLECTING");
  seq = 0;
  const r29 = computeLedger(rows(Array(29).fill(5)), mkExp());
  assert(r29.verdict === "COLLECTING", "29 closed → still COLLECTING");
  seq = 0;
  const r30 = computeLedger(rows(Array(30).fill(5)), mkExp());
  assert(r30.verdict !== "COLLECTING", "30 closed → a real verdict");
}

// ── 5. OK ────────────────────────────────────────────────────────────────────
console.log("\n[5] verdict OK");
{
  seq = 0;
  const pts = [...Array(20).fill(10), ...Array(10).fill(-5)];
  const r = computeLedger(rows(pts), mkExp()); // pf 200/50 = 4 ≥ expPF 2; cum 150 = expected 150
  assert(r.verdict === "OK", "rolling PF 4.0 ≥ backtest 2.0 and inside the band → OK");
  assert(approx(r.rolling30?.pf, 4), "rolling PF 4.0");
  assert(r.verdictReason.toLowerCase().includes("tracking"), "OK reason says tracking");
  assert(verdictWords(r.verdict) === "ON TRACK", "OK wording");
}

// ── 6. WATCH ─────────────────────────────────────────────────────────────────
console.log("\n[6] verdict WATCH");
{
  seq = 0;
  const pts = [...Array(15).fill(10), ...Array(15).fill(-8)];
  const r = computeLedger(rows(pts), mkExp()); // pf 150/120=1.25 ∈ [1, 2); cum 30 > 150−2·20·√30 ≈ −69
  assert(r.verdict === "WATCH", "PF 1.25 below backtest 2.0 but ≥1.0 and inside band → WATCH");
  assert(approx(r.rolling30?.pf, 1.25), "rolling PF 1.25");
  assert(r.verdictReason.includes("1.25") && r.verdictReason.includes("2.00"), "WATCH reason quotes both PFs");
  assert(verdictWords(r.verdict) === "WATCH", "WATCH wording");
}

// ── 7. ALERT on rolling PF < 1.0 ─────────────────────────────────────────────
console.log("\n[7] ALERT — rolling PF");
{
  seq = 0;
  const pts = [...Array(10).fill(10), ...Array(20).fill(-10)];
  // huge σ so the band cannot breach — isolates the PF clause
  const r = computeLedger(rows(pts), mkExp({ perTradeStd: 100 }));
  assert(r.verdict === "ALERT", "rolling PF 0.5 < 1.0 → ALERT");
  assert(approx(r.rolling30?.pf, 0.5), "rolling PF 0.5");
  assert(r.verdictReason.includes("net losers"), "reason names the losing window");
  assert(!r.verdictReason.includes("2-sigma"), "band clause not blamed when it held");
  assert(verdictWords(r.verdict) === "OFF TRACK", "ALERT wording");
  // no backtest baseline at all: PF<1 still alerts
  seq = 0;
  const rNoExp = computeLedger(rows(pts), null);
  assert(rNoExp.verdict === "ALERT", "PF<1 alerts even with no expectation on file");
}

// ── 8. ALERT on 2σ band breach (PF fine) ─────────────────────────────────────
console.log("\n[8] ALERT — 2σ band breach");
{
  seq = 0;
  const pts = [...Array(15).fill(10), ...Array(15).fill(-8)]; // pf 1.25 (fine)
  const r = computeLedger(rows(pts), mkExp({ expExpectancy: 50, perTradeStd: 1 }));
  // expected 1500, lower2 = 1500 − 2·1·√30 ≈ 1489; live 30 → deep breach
  assert(r.verdict === "ALERT", "cum below expected − 2σ√n → ALERT");
  assert(r.verdictReason.includes("2-sigma"), "reason names the band");
  const last = r.cumulative[r.cumulative.length - 1];
  assert(approx(last.expected, 1500), "expected = exp × n");
  assert(approx(last.lower2, 1500 - 2 * 1 * Math.sqrt(30)), "lower2 = expected − 2σ√n");
}

// ── 9. rolling window correctness ────────────────────────────────────────────
console.log("\n[9] rolling window");
{
  seq = 0;
  const pts = [...Array(5).fill(100), ...Array(10).fill(10), ...Array(20).fill(-5)];
  const ordered = rows(pts);
  const r = computeLedger(ordered, mkExp());
  assert(r.rolling30PFSeries.length === 35 - ROLLING_WINDOW + 1, "series length n−29");
  assert(approx(r.rolling30PFSeries[0].pf, (500 + 100) / 75), "first window (trades 1..30) PF 8.0");
  assert(approx(r.rolling30?.pf, 1.0), "last window (trades 6..35) PF 1.0 — early wins aged out");
  // order independence: same rows presented reversed must sort by ts and match
  const rRev = computeLedger([...ordered].reverse(), mkExp());
  assert(approx(rRev.rolling30?.pf, 1.0) && rRev.rolling30PFSeries.length === r.rolling30PFSeries.length, "row order does not matter (ts sort)");
}

// ── 10. cumulative curve math ────────────────────────────────────────────────
console.log("\n[10] cumulative curve");
{
  seq = 0;
  const r = computeLedger(rows([10, -5, 20]), mkExp({ expExpectancy: 5, perTradeStd: 10 }));
  assert(r.cumulative.length === 3, "one point per closed trade");
  assert(approx(r.cumulative[0].live, 10) && approx(r.cumulative[1].live, 5) && approx(r.cumulative[2].live, 25), "live cum 10/5/25");
  assert(approx(r.cumulative[1].expected, 10), "expected[2] = 10");
  assert(approx(r.cumulative[1].lower2, 10 - 2 * 10 * Math.sqrt(2)), "lower2[2] = 10 − 20√2");
  seq = 0;
  const rNull = computeLedger(rows([10, -5]), null);
  assert(rNull.cumulative[0].expected === null && rNull.cumulative[0].lower2 === null, "no expectation → null expected/band");
}

// ── 11. daily net grouping ───────────────────────────────────────────────────
console.log("\n[11] daily net");
{
  const rws: LedgerTradeRow[] = [
    { ts: T0, interval: "15m", outcome: "win_tp1", points: 10, source: "live" },
    { ts: T0 + 300, interval: "15m", outcome: "loss", points: -4, source: "live" },
    { ts: T0 + 2 * DAY, interval: "15m", outcome: "win_tp2", points: 20, source: "live" },
  ];
  const r = computeLedger(rws, mkExp());
  assert(r.dailyNet.length === 2, "two ET days");
  assert(r.dailyNet[0].date === etDateKey(T0) && approx(r.dailyNet[0].net, 6) && r.dailyNet[0].trades === 2, "day 1 net +6 over 2 trades");
  assert(r.dailyNet[1].date === etDateKey(T0 + 2 * DAY) && approx(r.dailyNet[1].net, 20), "day 2 net +20");
}

// ── 12. open / unresolved handling ───────────────────────────────────────────
console.log("\n[12] open handling");
{
  seq = 0;
  const mixed = [
    ...rows([10, -5]),
    row("open", null), row("filled", null), row(null, null),
    row("win_tp1", null), // resolved outcome but NO points → unresolved for math
  ];
  const r = computeLedger(mixed, mkExp());
  assert(r.liveClosed === 2 && r.liveOpen === 4, "2 closed, 4 open/unresolved");
  assert(r.liveTradesTotal === 6, "total counts everything live-era");
  assert(approx(r.liveNetPts, 5), "net over closed only");
}

// ── 13. win/eod semantics ────────────────────────────────────────────────────
console.log("\n[13] win/eod semantics");
{
  seq = 0;
  const r = computeLedger([row("win_tp2", 20), row("eod", 1), row("loss", -10)], mkExp());
  assert(r.liveClosed === 3 && r.liveWins === 1, "tp2 is a win; eod closed but not a win");
  assert(approx(r.liveWinRate, 100 / 3), "win rate = wins/(wins+losses+eod)");
  assert(approx(r.livePF, 21 / 10), "PF counts eod points in gross win");
}

// ── 14. status summary shape ─────────────────────────────────────────────────
console.log("\n[14] status summary");
{
  seq = 0;
  const r = computeLedger(rows(Array(30).fill(5)), mkExp(), { nowMs: 1754000000000 });
  const s = summarizeLedgerStatus(r);
  assert(s.verdict === r.verdict && s.rolling30PF === r.rolling30?.pf, "status mirrors the report");
  assert(s.liveTrades === 30 && s.liveClosed === 30, "status counts");
  assert(s.asOf === new Date(1754000000000).toISOString(), "asOf honors nowMs");
  assert(r.rolling30?.pf === PF_CAP, "all-win window PF capped at 999");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
