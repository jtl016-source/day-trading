// ── 1-month strategy-combination backtest → Excel workbook ────────────────────
// Runs the SHARED signal engine (client/src/lib/signal-engine.ts — the exact
// code path the Backtest page, Market chart and Signals tab use) over 1 month
// of MES=F data on the 5m and 15m intervals, once for every possible
// combination of the four composable strategy components:
//
//   V — Vector        (HL20 primary vector hard gate + slope)
//   Z — Milk Zones    (zone test-and-hold confirmation, required when enabled)
//   B — Candle Body   (bullish close for Longs / bearish close for Shorts)
//   F — Footprint     (proxy delta agreement + divergence veto + exit adjustments)
//
// 15 sheets = 4 solo strategies + 11 multi-strategy combos, plus a
// "Program (Backtest)" sheet that reproduces the app's Backtest page exactly
// (zone acts as a tier upgrade for Longs / hard gate for Shorts, everything
// else enabled), a Summary sheet and a README sheet.
//
// Always-on risk filters (all sheets, mirroring the backtest): 10-bar cooldown,
// HOD long suppression (5 pts), 60m declining-vector long veto, CME settlement
// break skip, day-trade session-close exits. Exit profile: "safe" (Tight) —
// the Backtest page default. P&L assumes 1 MES contract ($5/pt).
//
// Usage: npx tsx scripts/generate-backtest-xlsx.ts [output.xlsx]

import ExcelJS from "exceljs";
import YahooFinance from "yahoo-finance2";
import {
  EXIT_STRATEGY_PROFILES,
  aggregateToInterval,
  detectMilkZones,
  computeEngineSignals,
  isRTH,
  type EngineCandle,
  type EngineGates,
  type EngineSignal,
  type EngineSession,
} from "../client/src/lib/signal-engine";

const SYMBOL      = "MES=F";
const DOLLARS_PER_PT = 5;         // MES micro contract
const MONTH_DAYS  = 30;
const WARMUP_DAYS = 2;            // extra lead-in so vector/zones/cooldown are warm at month start
const EXIT_PROFILE = EXIT_STRATEGY_PROFILES.safe; // Backtest page default ("Tight")

// ── Strategy components ───────────────────────────────────────────────────────
interface Component { code: string; name: string }
const COMPONENTS: Component[] = [
  { code: "V", name: "Vector" },
  { code: "Z", name: "Milk Zones" },
  { code: "B", name: "Candle Body" },
  { code: "F", name: "Footprint" },
];

function gatesFor(codes: Set<string>): EngineGates {
  return {
    vector:    codes.has("V"),
    zone:      codes.has("Z") ? "required" : "off",
    body:      codes.has("B"),
    footprint: codes.has("F"),
  };
}

/** All non-empty subsets of COMPONENTS, solos first, then by size. */
function allCombos(): Array<{ codes: string[]; label: string }> {
  const combos: Array<{ codes: string[]; label: string }> = [];
  const n = COMPONENTS.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const codes = COMPONENTS.filter((_, i) => mask & (1 << i)).map(c => c.code);
    combos.push({ codes, label: codes.join("+") });
  }
  combos.sort((a, b) => a.codes.length - b.codes.length || a.label.localeCompare(b.label));
  return combos;
}

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
  // Drop the live forming bar (unaligned timestamp) so results are stable
  candles.sort((a, b) => a.time - b.time);
  while (candles.length && candles[candles.length - 1].time % 300 !== 0) candles.pop();
  return candles;
}

// ── Row building ──────────────────────────────────────────────────────────────
interface TradeRow {
  signal: EngineSignal;
  interval: "5m" | "15m";
}

function pnlPts(s: EngineSignal): number | null {
  if (s.outcome === "win_tp1" || s.outcome === "win_trailer") return Math.abs(s.tp1 - s.price);
  if (s.outcome === "win_tp2") return Math.abs(s.tp2 - s.price);
  if (s.outcome === "loss")    return -Math.abs(s.sl - s.price);
  return null; // open
}

const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });

function outcomeLabel(o: EngineSignal["outcome"]): string {
  return o === "win_tp2" ? "Win (TP2)" : o === "win_tp1" ? "Win (TP1)" : o === "win_trailer" ? "Win (Trail)" : o === "loss" ? "Loss" : "Open";
}

// ── Sheet writers ─────────────────────────────────────────────────────────────
const HEADER = ["Date (ET)", "Time (ET)", "Interval", "Session", "Direction", "Tier", "Entry", "TP1", "TP2", "SL", "Outcome", "P&L (pts)", "P&L ($, 1 MES)", "Zone Confirmed"];

function writeTradeSheet(wb: ExcelJS.Workbook, name: string, description: string, rows: TradeRow[]) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.addRow([description]);
  ws.getRow(1).font = { bold: true, size: 11 };
  ws.mergeCells(1, 1, 1, HEADER.length);
  ws.addRow([]);
  const hr = ws.addRow(HEADER);
  hr.font = { bold: true };
  hr.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.border = { bottom: { style: "thin" } };
  });

  rows.sort((a, b) => a.signal.time - b.signal.time);
  let wins = 0, losses = 0, open = 0, tp1 = 0, tp2 = 0, totalPts = 0;
  for (const { signal: s, interval } of rows) {
    const pts = pnlPts(s);
    if (s.outcome === "loss") losses++;
    else if (s.outcome === "open") open++;
    else { wins++; if (s.outcome === "win_tp2") tp2++; else tp1++; }
    if (pts != null) totalPts += pts;
    const r = ws.addRow([
      fmtDate(s.time), fmtTime(s.time), interval, s.session.toUpperCase(),
      s.direction, s.tier === "safe" ? "Safe" : "Risky",
      s.price, +s.tp1.toFixed(2), +s.tp2.toFixed(2), +s.sl.toFixed(2),
      outcomeLabel(s.outcome),
      pts != null ? +pts.toFixed(2) : "—",
      pts != null ? +(pts * DOLLARS_PER_PT).toFixed(2) : "—",
      s.milkOk ? "Yes" : "No",
    ]);
    const oc = r.getCell(11);
    oc.font = { color: { argb: s.outcome === "loss" ? "FFDC2626" : s.outcome === "open" ? "FF6B7280" : "FF16A34A" }, bold: true };
  }

  ws.addRow([]);
  const closed = wins + losses;
  const sum = ws.addRow([
    "TOTALS", "", "", "", "", "",
    "", "", "", "",
    `${wins}W / ${losses}L / ${open} open`,
    +totalPts.toFixed(2),
    +(totalPts * DOLLARS_PER_PT).toFixed(2),
    closed ? `${((wins / closed) * 100).toFixed(1)}% WR` : "—",
  ]);
  sum.font = { bold: true };

  ws.columns.forEach((col, i) => { col.width = i === 0 ? 14 : i === 10 ? 12 : 11; });
  ws.views = [{ state: "frozen", ySplit: 3 }];
  return { wins, losses, open, tp1, tp2, totalPts, count: rows.length };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const outPath = process.argv[2] ?? "backtests/MES-1month-5m-15m-strategy-combos.xlsx";
  console.log(`Fetching ${MONTH_DAYS + WARMUP_DAYS} days of ${SYMBOL} 5m data from Yahoo Finance…`);
  const bars5m = await fetchCandles();
  if (bars5m.length < 500) throw new Error(`Not enough data (${bars5m.length} bars)`);
  const bars15m = aggregateToInterval(bars5m, 900);
  const nowSec = Math.floor(Date.now() / 1000);
  const lastBar = bars5m[bars5m.length - 1].time;
  const cutoff = lastBar - MONTH_DAYS * 86400; // report exactly the trailing month; earlier bars are warm-up
  console.log(`  ${bars5m.length} 5m bars, ${bars15m.length} 15m bars · ${fmtDate(bars5m[0].time)} → ${fmtDate(lastBar)} · report window starts ${fmtDate(cutoff)}`);

  const zones5m  = detectMilkZones(bars5m);
  const zones15m = detectMilkZones(bars15m);
  console.log(`  zones: ${zones5m.length} (5m) · ${zones15m.length} (15m)`);

  const runCombo = (gates: EngineGates): TradeRow[] => {
    const rows: TradeRow[] = [];
    for (const [interval, bars, zones] of [["5m", bars5m, zones5m], ["15m", bars15m, zones15m]] as const) {
      for (const session of ["rth", "eth"] as EngineSession[]) {
        for (const s of computeEngineSignals(bars, zones, EXIT_PROFILE, session, gates, nowSec)) {
          if (s.time < cutoff) continue; // warm-up period — not reported
          rows.push({ signal: s, interval });
        }
      }
    }
    return rows;
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = "Milk Yellow Box Strategy Viewer";
  wb.created = new Date();

  // README first
  const readme = wb.addWorksheet("README");
  const readmeLines = [
    ["1-Month Strategy Combination Backtest — MES (Micro E-mini S&P 500)"],
    [""],
    [`Data: Yahoo Finance ${SYMBOL}, 5m bars (15m aggregated from 5m exactly like the app), ${fmtDate(cutoff)} → ${fmtDate(lastBar)}.`],
    [`Engine: client/src/lib/signal-engine.ts — the SAME code the Backtest page, Market chart and Signals tab run.`],
    [`Exit profile: "Tight" (Backtest page default) — RTH: TP1 ${EXIT_PROFILE.rth.tp1Safe}/${EXIT_PROFILE.rth.tp1} pts (safe/risky), TP2 ${EXIT_PROFILE.rth.tp2} pts, SL ${EXIT_PROFILE.rth.sl} pts · ETH: TP1 ${EXIT_PROFILE.eth.tp1Safe}/${EXIT_PROFILE.eth.tp1}, TP2 ${EXIT_PROFILE.eth.tp2}, SL ${EXIT_PROFILE.eth.sl}.`],
    ["P&L assumes 1 MES contract at $5/point. Open trades excluded from P&L and win rate."],
    [""],
    ["Strategy components:"],
    ["  V — Vector: close above (Long) / below (Short) the HL20 vector with agreeing slope."],
    ["  Z — Milk Zones: candle tested a zone and held (±2 pts) — REQUIRED for entry when enabled."],
    ["  B — Candle Body: bullish close required for Longs, bearish close for Shorts."],
    ["  F — Footprint: proxy footprint delta must agree; divergence veto; POC/TP exit adjustments."],
    [""],
    ["Sheets: one per strategy combination (4 solo + 11 combos = every possible combination),"],
    ["plus 'Program (Backtest)' — the app's exact Backtest page rules, where the zone is a tier"],
    ["upgrade for Longs (Safe vs Risky) and a hard gate for Shorts, with V+B+F all enabled."],
    [""],
    ["Always-on risk filters on every sheet (identical to the app's backtest):"],
    ["  · 10-bar signal cooldown per direction"],
    ["  · Long suppression within 5 pts of the pre-bar high-of-day"],
    ["  · Long veto while the 60m vector is declining"],
    ["  · No signals during the CME settlement break (4:30–6:00 pm ET)"],
    ["  · Day-trade exits: positions resolve by session settle (TP1/TP2/SL walk-forward)"],
    [""],
    ["Tier: Safe = zone-confirmed entry · Risky = no zone confirmation."],
    ["Session: RTH = 9:30am–4pm ET · ETH = overnight (each computed exactly like the Backtest page's session modes)."],
    [""],
    ["Note: combos that include Footprint (F) produce the same trades whether or not Candle Body (B)"],
    ["is also enabled (e.g. V+F = V+B+F) — the proxy footprint is built from the candle's OHLCV, so its"],
    ["delta-agreement gate already implies the body direction. Both sheets are still included for completeness."],
  ];
  for (const l of readmeLines) readme.addRow(l);
  readme.getRow(1).font = { bold: true, size: 14 };
  readme.getColumn(1).width = 130;

  // Summary placeholder (filled after all sheets are computed)
  const summary = wb.addWorksheet("Summary");

  interface SummaryRow { sheet: string; strategies: string; interval: string; count: number; wins: number; losses: number; open: number; tp1: number; tp2: number; pts: number }
  const summaryRows: SummaryRow[] = [];

  const addComboSheet = (sheetName: string, label: string, description: string, gates: EngineGates) => {
    const rows = runCombo(gates);
    writeTradeSheet(wb, sheetName, description, rows);
    for (const interval of ["5m", "15m"] as const) {
      const sub = rows.filter(r => r.interval === interval);
      let wins = 0, losses = 0, open = 0, tp1 = 0, tp2 = 0, pts = 0;
      for (const { signal: s } of sub) {
        const p = pnlPts(s);
        if (s.outcome === "loss") losses++;
        else if (s.outcome === "open") open++;
        else { wins++; if (s.outcome === "win_tp2") tp2++; else tp1++; }
        if (p != null) pts += p;
      }
      summaryRows.push({ sheet: sheetName, strategies: label, interval, count: sub.length, wins, losses, open, tp1, tp2, pts });
    }
  };

  // Program sheet — exact Backtest page semantics (default gates)
  addComboSheet(
    "Program (Backtest)",
    "Program strategy (V+B+F, zones as tier)",
    "PROGRAM STRATEGY — exact Backtest page rules: vector + body + footprint gates; Milk zone upgrades Longs to Safe and hard-gates Shorts.",
    {},
  );

  // Every combination of the 4 components
  const nameByCode: Record<string, string> = Object.fromEntries(COMPONENTS.map(c => [c.code, c.name]));
  for (const combo of allCombos()) {
    const names = combo.codes.map(c => nameByCode[c]).join(" + ");
    const solo = combo.codes.length === 1;
    const sheetName = solo ? `Solo ${nameByCode[combo.codes[0]]}` : `Combo ${combo.label}`;
    addComboSheet(
      sheetName,
      names,
      `${solo ? "SOLO STRATEGY" : "STRATEGY COMBO"}: ${names} — enabled components are required entry gates; all baseline risk filters apply (see README).`,
      gatesFor(new Set(combo.codes)),
    );
    console.log(`  sheet done: ${sheetName}`);
  }

  // Fill Summary
  summary.addRow([`Summary — ${SYMBOL} · ${fmtDate(cutoff)} → ${fmtDate(lastBar)} · 5m & 15m · exit profile "Tight" · $5/pt (1 MES)`]);
  summary.getRow(1).font = { bold: true, size: 12 };
  summary.mergeCells(1, 1, 1, 11);
  summary.addRow([]);
  const sh = summary.addRow(["Sheet", "Strategies", "Interval", "Trades", "Wins", "Losses", "Open", "TP1 Hits", "TP2 Hits", "Win Rate", "P&L (pts)", "P&L ($)"]);
  sh.font = { bold: true };
  sh.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });
  for (const r of summaryRows) {
    const closed = r.wins + r.losses;
    const row = summary.addRow([
      r.sheet, r.strategies, r.interval, r.count, r.wins, r.losses, r.open, r.tp1, r.tp2,
      closed ? `${((r.wins / closed) * 100).toFixed(1)}%` : "—",
      +r.pts.toFixed(2), +(r.pts * DOLLARS_PER_PT).toFixed(2),
    ]);
    row.getCell(12).font = { bold: true, color: { argb: r.pts >= 0 ? "FF16A34A" : "FFDC2626" } };
  }
  summary.columns.forEach((col, i) => { col.width = i === 0 ? 22 : i === 1 ? 36 : 10; });
  summary.views = [{ state: "frozen", ySplit: 3 }];

  const fs = await import("fs");
  const path = await import("path");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  console.log(`\nWrote ${outPath}`);
  console.log(`Sheets: README, Summary, Program (Backtest), ${allCombos().length} combination sheets`);
}

main().catch(err => { console.error(err); process.exit(1); });
