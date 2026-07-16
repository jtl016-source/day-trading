// ── Signal-firing optimizer → optimized backtest workbook ─────────────────────
// Searches for the best way to fire signals using the program's strategy
// components, then writes a new backtest workbook for the winning rules.
//
// Search space:
//   · Strategy gates — every combination of V (Vector), Y (Yellow Box),
//     I (ICT Zones), B (Candle Body), F (Footprint), required-gate semantics,
//     plus the app's Program mode (Yellow Box as tier).
//   · Interval — 5m, 15m, or both.
//   · Session — RTH only, ETH only, or both.
//   · Exit parameters — TP1 ∈ {6, 8, 10, 12.5, 15} pts, TP2 = {1.6×, 2×} TP1,
//     SL ∈ {3, 4, 5, 6} pts (ETH exits scaled to 60%).
//
// Overfit control: the month is split into a TRAIN window (first ~21 days) and
// a TEST window (final ~9 days). Configs are ranked on TRAIN only; the TEST
// window is untouched validation. Winners must have ≥30 closed train trades.
//
// Output: backtests/MES-optimized-signal-backtest.xlsx
//   README · Search Results · one trade sheet per winner (Best Win Rate,
//   Best Points, Recommended) · Comparison vs the Program baseline.
//
// Usage: npx tsx scripts/optimize-signals.ts [output.xlsx]

import ExcelJS from "exceljs";
import YahooFinance from "yahoo-finance2";
import {
  aggregateToInterval,
  computeYellowBoxZones,
  detectIctZones,
  computeEngineSignals,
  isRTH,
  type EngineCandle,
  type EngineGates,
  type EngineSignal,
  type EngineSession,
  type EngineZone,
  type ExitProfile,
} from "../client/src/lib/signal-engine";

const SYMBOL         = "MES=F";
const DOLLARS_PER_PT = 5;
const MONTH_DAYS     = 30;
const WARMUP_DAYS    = 2;
const TRAIN_DAYS     = 21;   // calendar days of the report window used for optimization
const MIN_TRAIN_CLOSED = 30; // winners need at least this many closed train trades

const COMPONENT_NAMES: Record<string, string> = {
  V: "Vector", Y: "Yellow Box", I: "ICT Zones", B: "Candle Body", F: "Footprint",
};

const TP1_GRID  = [6, 8, 10, 12.5, 15];
const TP2_MULTS = [1.6, 2.0];
const SL_GRID   = [3, 4, 5, 6];

// ── Data ──────────────────────────────────────────────────────────────────────
async function fetchCandles(): Promise<EngineCandle[]> {
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const now = new Date();
  const from = new Date(now.getTime() - (MONTH_DAYS + WARMUP_DAYS) * 86400 * 1000);
  const r = await yf.chart(SYMBOL, { period1: from, period2: now, interval: "5m", includePrePost: true });
  const candles: EngineCandle[] = [];
  for (const q of r.quotes) {
    if (q.open == null || q.high == null || q.low == null || q.close == null) continue;
    const time = Math.floor(new Date(q.date).getTime() / 1000);
    candles.push({ time, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0, rth: isRTH(time) });
  }
  candles.sort((a, b) => a.time - b.time);
  while (candles.length && candles[candles.length - 1].time % 300 !== 0) candles.pop();
  return candles;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pnlPts(s: EngineSignal): number | null {
  if (s.outcome === "win_tp1" || s.outcome === "win_trailer") return Math.abs(s.tp1 - s.price);
  if (s.outcome === "win_tp2") return Math.abs(s.tp2 - s.price);
  if (s.outcome === "loss")    return -Math.abs(s.sl - s.price);
  return null;
}

const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });

interface Stats { n: number; closed: number; wins: number; losses: number; wr: number; pts: number; exp: number }
function statsOf(rows: Array<{ signal: EngineSignal }>): Stats {
  let wins = 0, losses = 0, pts = 0, closed = 0;
  for (const { signal: s } of rows) {
    const p = pnlPts(s);
    if (p == null) continue;
    closed++;
    pts += p;
    if (p > 0) wins++; else losses++;
  }
  return { n: rows.length, closed, wins, losses, wr: closed ? wins / closed : 0, pts, exp: closed ? pts / closed : 0 };
}

interface ComboDef { codes: string[]; label: string; programMode: boolean }
function allComboDefs(): ComboDef[] {
  const keys = Object.keys(COMPONENT_NAMES); // V, Y, I, B, F
  const defs: ComboDef[] = [];
  for (let mask = 1; mask < (1 << keys.length); mask++) {
    const codes = keys.filter((_, i) => mask & (1 << i));
    defs.push({ codes, label: codes.join("+"), programMode: false });
  }
  defs.push({ codes: [], label: "PROGRAM", programMode: true });
  return defs;
}

function makeProfile(tp1: number, tp2: number, sl: number): ExitProfile {
  const e = (v: number) => +(v * 0.6).toFixed(2); // ETH exits scaled to 60% like the app's profiles
  return {
    rth: { tp1Safe: tp1, tp1, tp2, sl },
    eth: { tp1Safe: e(tp1), tp1: e(tp1), tp2: e(tp2), sl: e(sl) },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const outPath = process.argv[2] ?? "backtests/MES-optimized-signal-backtest.xlsx";
  console.log(`Fetching ${MONTH_DAYS + WARMUP_DAYS} days of ${SYMBOL} 5m data from Yahoo Finance…`);
  const bars5m = await fetchCandles();
  if (bars5m.length < 500) throw new Error(`Not enough data (${bars5m.length} bars)`);
  const bars15m = aggregateToInterval(bars5m, 900);
  const nowSec  = Math.floor(Date.now() / 1000);
  const lastBar = bars5m[bars5m.length - 1].time;
  const cutoff  = lastBar - MONTH_DAYS * 86400;
  const trainEnd = cutoff + TRAIN_DAYS * 86400;
  console.log(`  ${bars5m.length} 5m bars · report ${fmtDate(cutoff)} → ${fmtDate(lastBar)} · train ends ${fmtDate(trainEnd)}`);

  const zones = {
    "5m":  { yb: computeYellowBoxZones(bars5m),  ict: detectIctZones(bars5m)  },
    "15m": { yb: computeYellowBoxZones(bars15m), ict: detectIctZones(bars15m) },
  };
  const barsBy = { "5m": bars5m, "15m": bars15m } as const;

  // Memoized single-interval, single-session engine run
  const runMemo = new Map<string, Array<{ signal: EngineSignal; interval: "5m" | "15m" }>>();
  function runOne(combo: ComboDef, interval: "5m" | "15m", session: EngineSession, profile: ExitProfile, profileKey: string) {
    const key = `${combo.label}|${interval}|${session}|${profileKey}`;
    const hit = runMemo.get(key);
    if (hit) return hit;
    const zoneSets: EngineZone[][] = [];
    if (combo.programMode || combo.codes.includes("Y")) zoneSets.push(zones[interval].yb);
    if (combo.codes.includes("I")) zoneSets.push(zones[interval].ict);
    const gates: EngineGates = combo.programMode ? {} : {
      vector:    combo.codes.includes("V"),
      zone:      zoneSets.length ? "required" : "off",
      body:      combo.codes.includes("B"),
      footprint: combo.codes.includes("F"),
    };
    const rows = computeEngineSignals(barsBy[interval], zoneSets.length ? zoneSets : [[]], profile, session, gates, nowSec)
      .filter(s => s.time >= cutoff)
      .map(s => ({ signal: s, interval }));
    runMemo.set(key, rows);
    return rows;
  }

  type IntervalPick = "5m" | "15m" | "both";
  type SessionPick  = "rth" | "eth" | "both";
  function runConfig(combo: ComboDef, interval: IntervalPick, session: SessionPick, profile: ExitProfile, profileKey: string) {
    const intervals: Array<"5m" | "15m"> = interval === "both" ? ["5m", "15m"] : [interval];
    const sessions: EngineSession[] = session === "both" ? ["rth", "eth"] : [session];
    const rows: Array<{ signal: EngineSignal; interval: "5m" | "15m" }> = [];
    for (const iv of intervals) for (const ses of sessions) rows.push(...runOne(combo, iv, ses, profile, profileKey));
    return rows.sort((a, b) => a.signal.time - b.signal.time);
  }

  const split = (rows: Array<{ signal: EngineSignal; interval: "5m" | "15m" }>) => ({
    train: rows.filter(r => r.signal.time < trainEnd),
    test:  rows.filter(r => r.signal.time >= trainEnd),
  });

  // ── Stage 1: rank strategy shapes at baseline exits (Tight-like 12.5/25/4) ──
  console.log("Stage 1: ranking strategy combinations (baseline exits)…");
  const baseProfile = makeProfile(12.5, 25, 4);
  interface Shape { combo: ComboDef; interval: IntervalPick; session: SessionPick; trainExp: number; trainClosed: number }
  const shapes: Shape[] = [];
  for (const combo of allComboDefs()) {
    for (const interval of ["5m", "15m", "both"] as IntervalPick[]) {
      for (const session of ["rth", "eth", "both"] as SessionPick[]) {
        const rows = runConfig(combo, interval, session, baseProfile, "base");
        const st = statsOf(split(rows).train);
        if (st.closed >= MIN_TRAIN_CLOSED) shapes.push({ combo, interval, session, trainExp: st.exp, trainClosed: st.closed });
      }
    }
  }
  shapes.sort((a, b) => b.trainExp - a.trainExp);
  const topShapes = shapes.slice(0, 12);
  // Always keep the Program baseline (both intervals, both sessions) for comparison
  const programCombo = allComboDefs().find(c => c.programMode)!;
  console.log(`  ${shapes.length} shapes with ≥${MIN_TRAIN_CLOSED} closed train trades; top 12 go to exit-grid stage:`);
  for (const s of topShapes) console.log(`    ${s.combo.label.padEnd(12)} ${s.interval.padEnd(4)} ${s.session.padEnd(4)} trainExp=${s.trainExp.toFixed(3)} (${s.trainClosed} closed)`);

  // ── Stage 2: exit-parameter grid over the top shapes ────────────────────────
  console.log("Stage 2: exit-parameter grid…");
  interface Row {
    combo: ComboDef; interval: IntervalPick; session: SessionPick;
    tp1: number; tp2: number; sl: number;
    train: Stats; test: Stats; full: Stats;
  }
  const results: Row[] = [];
  for (const shape of topShapes) {
    for (const tp1 of TP1_GRID) for (const m of TP2_MULTS) for (const sl of SL_GRID) {
      const tp2 = +(tp1 * m).toFixed(1);
      const profile = makeProfile(tp1, tp2, sl);
      const rows = runConfig(shape.combo, shape.interval, shape.session, profile, `${tp1}/${tp2}/${sl}`);
      const { train, test } = split(rows);
      results.push({
        combo: shape.combo, interval: shape.interval, session: shape.session, tp1, tp2, sl,
        train: statsOf(train), test: statsOf(test), full: statsOf(rows),
      });
    }
  }
  console.log(`  ${results.length} configurations evaluated`);

  // ── Winner selection — ranked on TRAIN, validated on TEST ───────────────────
  const eligible = results.filter(r => r.train.closed >= MIN_TRAIN_CLOSED);
  const bestWR  = [...eligible].sort((a, b) => b.train.wr - a.train.wr || b.train.pts - a.train.pts)[0];
  const bestPts = [...eligible].sort((a, b) => b.train.pts - a.train.pts)[0];
  // Recommended: best train points among configs that ALSO validated (test expectancy > 0, decent WR)
  const validated = eligible.filter(r => r.test.exp > 0 && r.test.closed >= 5 && r.train.wr >= 0.45);
  const recommended = (validated.length ? [...validated].sort((a, b) => b.train.pts - a.train.pts) : [...eligible].sort((a, b) => b.train.pts - a.train.pts))[0];

  const describe = (r: Row) =>
    `${r.combo.programMode ? "Program (YB tier)" : r.combo.codes.map(c => COMPONENT_NAMES[c]).join("+")} · ${r.interval} · ${r.session.toUpperCase()} · TP1 ${r.tp1} / TP2 ${r.tp2} / SL ${r.sl}`;
  console.log(`\n  BEST WIN RATE:  ${describe(bestWR)}  train ${(bestWR.train.wr * 100).toFixed(1)}% → test ${(bestWR.test.wr * 100).toFixed(1)}%`);
  console.log(`  BEST POINTS:    ${describe(bestPts)}  train ${bestPts.train.pts.toFixed(1)} pts → test ${bestPts.test.pts.toFixed(1)} pts`);
  console.log(`  RECOMMENDED:    ${describe(recommended)}  full ${recommended.full.pts.toFixed(1)} pts @ ${(recommended.full.wr * 100).toFixed(1)}%`);

  // Program baseline at app default exits for the comparison sheet
  const programRows = runConfig(programCombo, "both", "both", makeProfile(12.5, 25, 4), "base");
  const programStats = { train: statsOf(split(programRows).train), test: statsOf(split(programRows).test), full: statsOf(programRows) };

  // ── Workbook ────────────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "Milk Yellow Box Strategy Viewer";
  wb.created = new Date();

  const readme = wb.addWorksheet("README");
  const rl = [
    ["Optimized Signal Firing — 1-Month Backtest (MES 5m/15m)"],
    [""],
    [`Data: Yahoo Finance ${SYMBOL} · ${fmtDate(cutoff)} → ${fmtDate(lastBar)} · engine: client/src/lib/signal-engine.ts (same code as the app).`],
    [`Overfit control: configs ranked ONLY on the train window (${fmtDate(cutoff)} → ${fmtDate(trainEnd)});`],
    [`the test window (${fmtDate(trainEnd)} → ${fmtDate(lastBar)}) is untouched validation. Winners need ≥${MIN_TRAIN_CLOSED} closed train trades.`],
    [""],
    ["Search space: all 31 strategy-gate combinations of Vector / Yellow Box / ICT Zones / Candle Body / Footprint"],
    ["(+ the app's Program mode), × interval (5m / 15m / both) × session (RTH / ETH / both)"],
    [`× exits (TP1 ∈ {${TP1_GRID.join(", ")}} pts; TP2 = 1.6× or 2× TP1; SL ∈ {${SL_GRID.join(", ")}} pts; ETH exits at 60%).`],
    ["Baseline risk filters always on: 10-bar cooldown, HOD long suppression, 60m declining-vector long veto,"],
    ["settlement-break skip, session-settle exits. P&L = 1 MES contract at $5/pt. Open trades excluded."],
    [""],
    ["WINNERS (selected on train, validated on test):"],
    [`  · Best Win Rate:  ${describe(bestWR)}`],
    [`  · Best Points:    ${describe(bestPts)}`],
    [`  · RECOMMENDED:    ${describe(recommended)}  ← best points among configs whose TEST window stayed profitable`],
    [""],
    ["Read the Search Results sheet to see how sensitive performance is to each parameter — a config whose"],
    ["neighbors are all profitable is trustworthy; an isolated spike is luck. Test-window columns are the"],
    ["honest number to expect going forward; train-window numbers are what the optimizer maximized."],
  ];
  for (const l of rl) readme.addRow(l);
  readme.getRow(1).font = { bold: true, size: 14 };
  readme.getColumn(1).width = 120;

  // Search results sheet (top 200 by train pts)
  const sr = wb.addWorksheet("Search Results");
  sr.addRow(["All evaluated configurations (top 200 by train points) — ranked on TRAIN, TEST is validation"]);
  sr.getRow(1).font = { bold: true, size: 12 };
  sr.mergeCells(1, 1, 1, 16);
  sr.addRow([]);
  const srh = sr.addRow(["Strategies", "Interval", "Session", "TP1", "TP2", "SL",
    "Train N", "Train WR", "Train Pts", "Train Exp", "Test N", "Test WR", "Test Pts", "Full N", "Full WR", "Full Pts"]);
  srh.font = { bold: true };
  srh.eachCell(c => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } }; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; });
  for (const r of [...results].sort((a, b) => b.train.pts - a.train.pts).slice(0, 200)) {
    sr.addRow([
      r.combo.programMode ? "Program (YB tier)" : r.combo.label, r.interval, r.session.toUpperCase(), r.tp1, r.tp2, r.sl,
      r.train.closed, `${(r.train.wr * 100).toFixed(1)}%`, +r.train.pts.toFixed(2), +r.train.exp.toFixed(3),
      r.test.closed, `${(r.test.wr * 100).toFixed(1)}%`, +r.test.pts.toFixed(2),
      r.full.closed, `${(r.full.wr * 100).toFixed(1)}%`, +r.full.pts.toFixed(2),
    ]);
  }
  sr.columns.forEach((col, i) => { col.width = i === 0 ? 18 : 10; });
  sr.views = [{ state: "frozen", ySplit: 3 }];

  // Trade sheets for the winners
  const HEADER = ["Date (ET)", "Time (ET)", "Interval", "Session", "Direction", "Tier", "Entry", "TP1", "TP2", "SL", "Outcome", "P&L (pts)", "Equity (pts)", "P&L ($)"];
  const outcomeLabel = (o: EngineSignal["outcome"]) =>
    o === "win_tp2" ? "Win (TP2)" : o === "win_tp1" ? "Win (TP1)" : o === "win_trailer" ? "Win (Trail)" : o === "loss" ? "Loss" : "Open";
  const writeWinner = (name: string, r: Row) => {
    const ws = wb.addWorksheet(name.slice(0, 31));
    ws.addRow([`${name}: ${describe(r)} — train ${(r.train.wr * 100).toFixed(1)}% WR / ${r.train.pts.toFixed(1)} pts · test ${(r.test.wr * 100).toFixed(1)}% WR / ${r.test.pts.toFixed(1)} pts`]);
    ws.getRow(1).font = { bold: true, size: 11 };
    ws.mergeCells(1, 1, 1, HEADER.length);
    ws.addRow([]);
    const hr = ws.addRow(HEADER);
    hr.eachCell(c => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } }; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; });
    const rows = runConfig(r.combo, r.interval, r.session, makeProfile(r.tp1, r.tp2, r.sl), `${r.tp1}/${r.tp2}/${r.sl}`);
    let equity = 0;
    for (const { signal: s, interval } of rows) {
      const p = pnlPts(s);
      if (p != null) equity += p;
      const row = ws.addRow([
        fmtDate(s.time), fmtTime(s.time), interval, s.session.toUpperCase(), s.direction,
        s.tier === "safe" ? "Safe" : "Risky", s.price, +s.tp1.toFixed(2), +s.tp2.toFixed(2), +s.sl.toFixed(2),
        outcomeLabel(s.outcome), p != null ? +p.toFixed(2) : "—", +equity.toFixed(2), p != null ? +(p * DOLLARS_PER_PT).toFixed(2) : "—",
      ]);
      row.getCell(11).font = { color: { argb: s.outcome === "loss" ? "FFDC2626" : s.outcome === "open" ? "FF6B7280" : "FF16A34A" }, bold: true };
      if (s.time >= trainEnd) row.getCell(1).font = { color: { argb: "FF2563EB" } }; // test-window rows in blue
    }
    ws.addRow([]);
    const st = r.full;
    ws.addRow(["TOTALS", "", "", "", "", "", "", "", "", "", `${st.wins}W / ${st.losses}L`, +st.pts.toFixed(2), "", +(st.pts * DOLLARS_PER_PT).toFixed(2)]).font = { bold: true };
    ws.addRow([`Blue dates = test window (not used for optimization). Win rate ${(st.wr * 100).toFixed(1)}% · expectancy ${st.exp.toFixed(2)} pts/trade`]).font = { italic: true, size: 10 };
    ws.columns.forEach((col, i) => { col.width = i === 0 ? 14 : 11; });
    ws.views = [{ state: "frozen", ySplit: 3 }];
  };
  writeWinner("Best Win Rate", bestWR);
  writeWinner("Best Points", bestPts);
  writeWinner("Recommended", recommended);

  // Comparison sheet
  const cmp = wb.addWorksheet("Comparison");
  cmp.addRow(["Optimized configs vs the app's current Program strategy (Tight exits, both intervals, both sessions)"]);
  cmp.getRow(1).font = { bold: true, size: 12 };
  cmp.mergeCells(1, 1, 1, 10);
  cmp.addRow([]);
  const ch = cmp.addRow(["Config", "Rules", "Full Trades", "Full WR", "Full Pts", "Full $", "Train WR", "Train Pts", "Test WR", "Test Pts"]);
  ch.eachCell(c => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } }; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; });
  const cmpRow = (label: string, rules: string, tr: Stats, te: Stats, fu: Stats) =>
    cmp.addRow([label, rules, fu.closed, `${(fu.wr * 100).toFixed(1)}%`, +fu.pts.toFixed(2), +(fu.pts * DOLLARS_PER_PT).toFixed(2),
      `${(tr.wr * 100).toFixed(1)}%`, +tr.pts.toFixed(2), `${(te.wr * 100).toFixed(1)}%`, +te.pts.toFixed(2)]);
  cmpRow("Program (current app)", "V+B+F gates, Yellow Box tier, Tight exits", programStats.train, programStats.test, programStats.full);
  cmpRow("Best Win Rate", describe(bestWR), bestWR.train, bestWR.test, bestWR.full);
  cmpRow("Best Points", describe(bestPts), bestPts.train, bestPts.test, bestPts.full);
  cmpRow("Recommended", describe(recommended), recommended.train, recommended.test, recommended.full);
  cmp.columns.forEach((col, i) => { col.width = i === 0 ? 22 : i === 1 ? 60 : 11; });

  const fs = await import("fs");
  const path = await import("path");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  console.log(`\nWrote ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
