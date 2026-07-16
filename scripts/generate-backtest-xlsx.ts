// ── 1-month strategy-combination backtest → Excel workbook ────────────────────
// Runs the SHARED signal engine (client/src/lib/signal-engine.ts — the exact
// code path the Backtest page, Market chart and Signals tab use) over 1 month
// of MES=F data on the 5m and 15m intervals, once for every possible
// combination of the five composable strategy components:
//
//   V — Vector          (HL20 primary vector hard gate + slope)
//   Y — Yellow Box      (per-day box centered on the day's OPEN; percentage-based
//                        support/resistance zones — the program's zone strategy)
//   I — ICT Zones       (Fair Value Gaps + Order Blocks + structural swing levels)
//   B — Candle Body     (bullish close for Longs / bearish close for Shorts)
//   F — Footprint       (proxy delta agreement + divergence veto + exit adjustments)
//
// 31 sheets = 5 solo strategies + 26 multi-strategy combos, plus a
// "Program (Backtest)" sheet that reproduces the app's Backtest page exactly
// (Yellow Box zones as tier upgrade for Longs / hard gate for Shorts, with
// V+B+F enabled), a Summary sheet, a Probability sheet (expectancy, Wilson
// confidence intervals, profit factor, max drawdown, bootstrap Monte Carlo EV)
// and a README sheet.
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
  computeYellowBoxZones,
  detectIctZones,
  computeEngineSignals,
  isRTH,
  type EngineCandle,
  type EngineGates,
  type EngineSignal,
  type EngineSession,
  type EngineZone,
} from "../client/src/lib/signal-engine";

const SYMBOL         = "MES=F";
const DOLLARS_PER_PT = 5;         // MES micro contract
const MONTH_DAYS     = 30;
const WARMUP_DAYS    = 2;         // extra lead-in so vector/zones/cooldown are warm at month start
const EXIT_PROFILE   = EXIT_STRATEGY_PROFILES.safe; // Backtest page default ("Tight")
const BOOT_ITERS     = 1000;      // bootstrap Monte Carlo resamples

// ── Strategy components ───────────────────────────────────────────────────────
interface Component { code: string; name: string }
const COMPONENTS: Component[] = [
  { code: "V", name: "Vector" },
  { code: "Y", name: "Yellow Box" },
  { code: "I", name: "ICT Zones" },
  { code: "B", name: "Candle Body" },
  { code: "F", name: "Footprint" },
];

/** All non-empty subsets of COMPONENTS, solos first, then by size. */
function allCombos(): Array<{ codes: string[]; label: string }> {
  const combos: Array<{ codes: string[]; label: string }> = [];
  const n = COMPONENTS.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const codes = COMPONENTS.filter((_, i) => mask & (1 << i)).map(c => c.code);
    combos.push({ codes, label: codes.join("+") });
  }
  const order = (c: { codes: string[] }) => c.codes.length;
  combos.sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label));
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

// ── Probability helpers ───────────────────────────────────────────────────────
/** Wilson score 95% confidence interval for a win rate. */
function wilson95(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = wins / n;
  const denom  = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half   = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Max drawdown (points) over the chronological cumulative P&L curve. */
function maxDrawdown(pnls: number[]): number {
  let peak = 0, cum = 0, dd = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

/** Bootstrap Monte Carlo: 90% interval for expectancy (mean pts/trade). */
function bootstrapEV(pnls: number[], iters = BOOT_ITERS): [number, number] {
  if (!pnls.length) return [0, 0];
  const means: number[] = [];
  for (let b = 0; b < iters; b++) {
    let sum = 0;
    for (let k = 0; k < pnls.length; k++) sum += pnls[Math.floor(Math.random() * pnls.length)];
    means.push(sum / pnls.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iters * 0.05)], means[Math.floor(iters * 0.95)]];
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
  let wins = 0, losses = 0, open = 0, totalPts = 0;
  for (const { signal: s, interval } of rows) {
    const pts = pnlPts(s);
    if (s.outcome === "loss") losses++;
    else if (s.outcome === "open") open++;
    else wins++;
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

  // Zone families per interval
  const yb5m   = computeYellowBoxZones(bars5m);
  const yb15m  = computeYellowBoxZones(bars15m);
  const ict5m  = detectIctZones(bars5m);
  const ict15m = detectIctZones(bars15m);
  console.log(`  Yellow Box zones: ${yb5m.length} (5m) · ${yb15m.length} (15m) — ICT zones: ${ict5m.length} (5m) · ${ict15m.length} (15m)`);

  const runCombo = (codes: Set<string>, programMode = false): TradeRow[] => {
    const rows: TradeRow[] = [];
    for (const [interval, bars, yb, ict] of [["5m", bars5m, yb5m, ict5m], ["15m", bars15m, yb15m, ict15m]] as const) {
      // Zone sets: each enabled zone family must confirm independently ("required").
      // Program mode: Yellow Box zones with "tier" semantics — the app's exact rules.
      const zoneSets: EngineZone[][] = [];
      if (programMode || codes.has("Y")) zoneSets.push(yb);
      if (codes.has("I")) zoneSets.push(ict);
      const gates: EngineGates = programMode ? {} : {
        vector:    codes.has("V"),
        zone:      zoneSets.length ? "required" : "off",
        body:      codes.has("B"),
        footprint: codes.has("F"),
      };
      const zones = zoneSets.length ? zoneSets : [[]];
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

  // ── README ──────────────────────────────────────────────────────────────────
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
    ["  Y — Yellow Box: the program's zone strategy. A fresh box is drawn EACH trading day, centered on the"],
    ["      day's OPENING price, width = average daily range (H−L) over the last 14 trading days. Support and"],
    ["      resistance zones start a percentage distance from the box edges: pct = max(|open − prevOpen| / open,"],
    ["      0.1%) × open; zone thickness = 30% of that distance. Entry requires a zone test-and-hold (±2 pts)."],
    ["  I — ICT Zones: Inner Circle Trader concepts — Fair Value Gaps (imbalances), Order Blocks (last opposing"],
    ["      candle before displacement) and structural swing highs/lows. Entry requires a zone test-and-hold."],
    ["  B — Candle Body: bullish close required for Longs, bearish close for Shorts."],
    ["  F — Footprint: proxy footprint delta must agree; divergence veto; POC/TP exit adjustments."],
    [""],
    ["Sheets: one per strategy combination (5 solo + 26 combos = every possible combination), plus"],
    ["'Program (Backtest)' — the app's exact Backtest page rules: Yellow Box zones upgrade Longs to Safe tier"],
    ["and hard-gate Shorts, with Vector + Body + Footprint enabled. When BOTH zone families are enabled in a"],
    ["combo (Y+I), each must confirm independently on the same candle."],
    [""],
    ["Probability sheet (statistical backing per combination, closed trades only):"],
    ["  · Win rate with Wilson 95% confidence interval — the plausible range of the true win rate given the"],
    ["    sample size; overlapping intervals between combos mean the difference may be noise."],
    ["  · Expectancy — average points won/lost per trade (the number that must be positive to trade it)."],
    ["  · Profit factor — gross win points ÷ gross loss points (>1.0 = net profitable)."],
    ["  · Max drawdown — worst peak-to-trough run of the cumulative P&L curve, in points."],
    [`  · Bootstrap Monte Carlo (${BOOT_ITERS} resamples) — 90% interval for expectancy; if the low end is above`],
    ["    zero the edge is statistically robust for this sample, not luck."],
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

  // Summary + Probability placeholders (filled after all sheets are computed)
  const summary     = wb.addWorksheet("Summary");
  const probability = wb.addWorksheet("Probability");

  interface ComboStats {
    sheet: string; strategies: string; interval: string;
    count: number; wins: number; losses: number; open: number; tp1: number; tp2: number;
    pnls: number[]; // chronological closed-trade P&Ls (pts)
  }
  const statRows: ComboStats[] = [];

  const addComboSheet = (sheetName: string, label: string, description: string, codes: Set<string>, programMode = false) => {
    const rows = runCombo(codes, programMode);
    writeTradeSheet(wb, sheetName, description, rows);
    for (const interval of ["5m", "15m"] as const) {
      const sub = rows.filter(r => r.interval === interval).sort((a, b) => a.signal.time - b.signal.time);
      const st: ComboStats = { sheet: sheetName, strategies: label, interval, count: sub.length, wins: 0, losses: 0, open: 0, tp1: 0, tp2: 0, pnls: [] };
      for (const { signal: s } of sub) {
        const p = pnlPts(s);
        if (s.outcome === "loss") st.losses++;
        else if (s.outcome === "open") st.open++;
        else { st.wins++; if (s.outcome === "win_tp2") st.tp2++; else st.tp1++; }
        if (p != null) st.pnls.push(p);
      }
      statRows.push(st);
    }
  };

  // Program sheet — exact Backtest page semantics (Yellow Box zones, tier mode)
  addComboSheet(
    "Program (Backtest)",
    "Program strategy (V+B+F, Yellow Box as tier)",
    "PROGRAM STRATEGY — exact Backtest page rules: vector + body + footprint gates; Yellow Box zone upgrades Longs to Safe and hard-gates Shorts.",
    new Set(),
    true,
  );

  // Every combination of the 5 components
  const nameByCode: Record<string, string> = Object.fromEntries(COMPONENTS.map(c => [c.code, c.name]));
  for (const combo of allCombos()) {
    const names = combo.codes.map(c => nameByCode[c]).join(" + ");
    const solo = combo.codes.length === 1;
    const sheetName = solo ? `Solo ${nameByCode[combo.codes[0]]}` : `Combo ${combo.label}`;
    addComboSheet(
      sheetName,
      names,
      `${solo ? "SOLO STRATEGY" : "STRATEGY COMBO"}: ${names} — enabled components are required entry gates; all baseline risk filters apply (see README).`,
      new Set(combo.codes),
    );
    console.log(`  sheet done: ${sheetName}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  summary.addRow([`Summary — ${SYMBOL} · ${fmtDate(cutoff)} → ${fmtDate(lastBar)} · 5m & 15m · exit profile "Tight" · $5/pt (1 MES)`]);
  summary.getRow(1).font = { bold: true, size: 12 };
  summary.mergeCells(1, 1, 1, 12);
  summary.addRow([]);
  const sh = summary.addRow(["Sheet", "Strategies", "Interval", "Trades", "Wins", "Losses", "Open", "TP1 Hits", "TP2 Hits", "Win Rate", "P&L (pts)", "P&L ($)"]);
  sh.font = { bold: true };
  sh.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });
  for (const r of statRows) {
    const closed = r.wins + r.losses;
    const pts = r.pnls.reduce((a, b) => a + b, 0);
    const row = summary.addRow([
      r.sheet, r.strategies, r.interval, r.count, r.wins, r.losses, r.open, r.tp1, r.tp2,
      closed ? `${((r.wins / closed) * 100).toFixed(1)}%` : "—",
      +pts.toFixed(2), +(pts * DOLLARS_PER_PT).toFixed(2),
    ]);
    row.getCell(12).font = { bold: true, color: { argb: pts >= 0 ? "FF16A34A" : "FFDC2626" } };
  }
  summary.columns.forEach((col, i) => { col.width = i === 0 ? 22 : i === 1 ? 40 : 10; });
  summary.views = [{ state: "frozen", ySplit: 3 }];

  // ── Probability ─────────────────────────────────────────────────────────────
  probability.addRow([`Probability & statistical backing — closed trades only · Wilson 95% CI on win rate · bootstrap Monte Carlo (${BOOT_ITERS} resamples) 90% interval on expectancy`]);
  probability.getRow(1).font = { bold: true, size: 12 };
  probability.mergeCells(1, 1, 1, 14);
  probability.addRow(["A combo's edge is statistically robust for this sample when the bootstrap EV low end is above 0. Overlapping win-rate CIs between combos = difference may be noise. Small samples (<30 closed trades) are marked."]);
  probability.mergeCells(2, 1, 2, 14);
  probability.getRow(2).font = { italic: true, size: 10 };
  probability.addRow([]);
  const ph = probability.addRow([
    "Sheet", "Strategies", "Interval", "Closed", "Win Rate", "WR 95% CI Low", "WR 95% CI High",
    "Expectancy (pts/trade)", "Avg Win (pts)", "Avg Loss (pts)", "Profit Factor",
    "Max Drawdown (pts)", "Bootstrap EV 5% (pts)", "Bootstrap EV 95% (pts)", "Sample Note",
  ]);
  ph.font = { bold: true };
  ph.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });
  for (const r of statRows) {
    const closed = r.pnls.length;
    if (!closed) {
      probability.addRow([r.sheet, r.strategies, r.interval, 0, "—", "—", "—", "—", "—", "—", "—", "—", "—", "—", "no closed trades"]);
      continue;
    }
    const winPnls  = r.pnls.filter(p => p > 0);
    const lossPnls = r.pnls.filter(p => p <= 0);
    const [ciLo, ciHi] = wilson95(r.wins, r.wins + r.losses);
    const expectancy = r.pnls.reduce((a, b) => a + b, 0) / closed;
    const avgWin  = winPnls.length  ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
    const avgLoss = lossPnls.length ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0;
    const grossWin  = winPnls.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    const dd = maxDrawdown(r.pnls);
    const [evLo, evHi] = bootstrapEV(r.pnls);
    const row = probability.addRow([
      r.sheet, r.strategies, r.interval, closed,
      `${((r.wins / (r.wins + r.losses)) * 100).toFixed(1)}%`,
      `${(ciLo * 100).toFixed(1)}%`, `${(ciHi * 100).toFixed(1)}%`,
      +expectancy.toFixed(3), +avgWin.toFixed(2), +avgLoss.toFixed(2),
      isFinite(pf) ? +pf.toFixed(2) : "∞",
      +dd.toFixed(2), +evLo.toFixed(3), +evHi.toFixed(3),
      closed < 30 ? "SMALL SAMPLE" : evLo > 0 ? "robust edge" : "not significant",
    ]);
    row.getCell(8).font  = { bold: true, color: { argb: expectancy >= 0 ? "FF16A34A" : "FFDC2626" } };
    row.getCell(15).font = { color: { argb: evLo > 0 ? "FF16A34A" : closed < 30 ? "FFB45309" : "FF6B7280" } };
  }
  probability.columns.forEach((col, i) => { col.width = i === 0 ? 22 : i === 1 ? 40 : 13; });
  probability.views = [{ state: "frozen", ySplit: 4 }];

  const fs = await import("fs");
  const path = await import("path");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  console.log(`\nWrote ${outPath}`);
  console.log(`Sheets: README, Summary, Probability, Program (Backtest), ${allCombos().length} combination sheets`);
}

main().catch(err => { console.error(err); process.exit(1); });
