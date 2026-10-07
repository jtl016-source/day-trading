/**
 * yellowbox-backtest.ts — FULL-HISTORY standalone backtest of the Yellow Box strategy
 * using ONLY our auto-generated zones (shared core in ./yellowbox-core — NO imported mwml bands).
 *
 * Usage:
 *   npx tsx scripts/yellowbox-backtest.ts [--symbol MES] [--out yellowbox-backtest-results.json]
 *
 * Walk-forward, no lookahead:
 *   For every trading day D with 50 prior trading days of data: settle = prior day 17:00 ET close;
 *   zones = computeCoreZones(last50, day60, settle) — identical math to the renderer. All zone inputs
 *   come from bars strictly before D 09:30 ET (daily aggregates of days < D only).
 *
 * Strategy (mechanical, per Milk's guide):
 *   Confirmation interval C in {1m, 5m, 15m, 60m}; a candle QUALIFIES if its CLOSE time falls within
 *   RTH: closeTime in (09:30, 17:00] ET. NOTE 60m bars are :00-UTC-aligned, so the first eligible 60m
 *   candle is the one SPANNING the open (09:00-10:00 ET, evaluated at its 10:00 close) — documented choice.
 *   FIRST candle closing outside the yellow box -> LONG at close if close > box top, SHORT if < bottom.
 *   One trade/day/interval. Stop = opposite box edge. TP1 = init res (long) / init sup (short).
 *   Exits resolve on 1m bars; both-in-one-bar ambiguity counts SL FIRST (conservative). No hit by
 *   17:00 ET -> force-exit at the day's settle.
 *   Model A: full exit at TP1/SL/EOD. Model B: half exits at TP1, runner half targets max range with
 *   stop moved to entry (BE, checked before target within a bar — conservative); EOD applies.
 *   If the entry close is already at/beyond TP1 (gap-breakout candle), the TP1 unit fills immediately
 *   at market = entry (pnl 0) and the runner proceeds; counted separately.
 *   Skip days missing >20% of the expected 450 RTH 1m bars (covers half-days/holidays).
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  etParts, etWallToEpoch, sessionDayKey, isoUtc,
  rnd2, buildSessionDays, computeCoreZones, filterYbBars, isYbSpikeBar,
  YB_FORMULA, IRS_PCT_UP, IRS_PCT_DN, MR_PCT, MR_PCT_DN,
} from "./yellowbox-core";
import type { Bar, DayAgg, CoreZones } from "./yellowbox-core";

// ============================= CLI =============================

let SYMBOL = "MES";
let OUT_JSON = "yellowbox-backtest-results.json";
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--symbol") SYMBOL = argv[++i] ?? "MES";
    else if (argv[i] === "--out") OUT_JSON = argv[++i] ?? OUT_JSON;
  }
}

const t0 = Date.now();
const __dir = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dir, "..", "data", "app.db");

let db: InstanceType<typeof Database>;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch {
  db = new Database(DB_PATH, { fileMustExist: true }); // WAL readonly needs -shm; no writes issued
}

// ==================== UPFRONT LOAD (single snapshot) ====================
// One query per resolution for the WHOLE history — a consistent snapshot even if the live DB mutates.

function loadAll(resolution: string): Bar[] {
  return filterYbBars(db.prepare(
    `SELECT timestamp t, open o, high h, low l, close c, volume v
     FROM cached_candles WHERE symbol=? AND resolution=? ORDER BY timestamp`
  ).all(SYMBOL, resolution) as Bar[], resolution);
}

console.log(`[bt] loading ${SYMBOL} bars (single snapshot) ...`);
const bars5 = loadAll("5");
const bars15 = loadAll("15");
const bars60 = loadAll("60");
console.log(`[bt] 5m=${bars5.length}  15m=${bars15.length}  60m=${bars60.length}`);

// session-day aggregation (shared core) + prevClose chain over the FULL history
const { dayMap, dayBars: day5 } = buildSessionDays(bars5);
const days: DayAgg[] = [...dayMap.values()]
  .filter((d) => d.bars >= 60 && d.weekday >= 1 && d.weekday <= 5)
  .sort((a, b) => (a.key < b.key ? -1 : 1));
for (let i = 1; i < days.length; i++) days[i].prevClose = days[i - 1].c;
console.log(`[bt] trading days in DB: ${days.length}  (${days[0].key} .. ${days[days.length - 1].key})`);

function bucketByDay(bars: Bar[]): Map<string, Bar[]> {
  const m = new Map<string, Bar[]>();
  for (const b of bars) {
    const k = sessionDayKey(b.t);
    let arr = m.get(k);
    if (!arr) { arr = []; m.set(k, arr); }
    arr.push(b);
  }
  return m;
}
const day15 = bucketByDay(bars15);
const day60 = bucketByDay(bars60);

// RTH windows per session day (lazy, DST-safe)
const rthCache = new Map<string, [number, number]>();
function rthWindow(key: string): [number, number] {
  let w = rthCache.get(key);
  if (!w) { w = [etWallToEpoch(key, 9, 30), etWallToEpoch(key, 17, 0)]; rthCache.set(key, w); }
  return w;
}

// 1m: stream-iterate the whole table, keep ONLY RTH bars per session day (memory-friendly)
console.log(`[bt] streaming 1m bars (RTH-only retention) ...`);
const day1: Map<string, Bar[]> = new Map();
{
  const it = db.prepare(
    `SELECT timestamp t, open o, high h, low l, close c, volume v
     FROM cached_candles WHERE symbol=? AND resolution='1' ORDER BY timestamp`
  ).iterate(SYMBOL) as IterableIterator<Bar>;
  let n1 = 0, kept = 0;
  for (const b of it) {
    n1++;
    if (isYbSpikeBar("1", b.o, b.h, b.l, b.c)) continue;
    const k = sessionDayKey(b.t);
    const [rs, re] = rthWindow(k);
    if (b.t >= rs && b.t < re) {
      let arr = day1.get(k);
      if (!arr) { arr = []; day1.set(k, arr); }
      arr.push(b);
      kept++;
    }
  }
  console.log(`[bt] 1m scanned=${n1}  RTH kept=${kept}`);
}
db.close();

// ==================== STRATEGY TYPES ====================

interface Trade {
  date: string;
  interval: string;
  dir: "long" | "short";
  entryTime: number;      // close time of the confirmation candle
  entry: number;
  // model A
  exitReasonA: "tp1" | "sl" | "eod";
  exitPriceA: number;
  pnlA: number;
  entryBeyondTp1: boolean;
  // model B (only meaningful when TP1 filled)
  runnerReason: "maxrange" | "be" | "eod" | null;
  runnerPnl: number | null;
  pnlB: number;           // combined
  // zones snapshot
  ybBottom: number; ybTop: number; tp1: number; sl: number; runnerTarget: number; settle: number;
}

const INTERVALS: { name: string; sec: number }[] = [
  { name: "1m", sec: 60 },
  { name: "5m", sec: 300 },
  { name: "15m", sec: 900 },
  { name: "60m", sec: 3600 },
];

/** Confirmation candles for day/interval: bars whose CLOSE time is in (rthStart, rthEnd]. */
function confirmationBars(key: string, sec: number): Bar[] {
  const [rs, re] = rthWindow(key);
  let src: Bar[];
  if (sec === 60) src = day1.get(key) ?? [];        // already RTH-only (starts>=09:30 -> close in (09:30,17:00])
  else if (sec === 300) src = day5.get(key) ?? [];
  else if (sec === 900) src = day15.get(key) ?? [];
  else src = day60.get(key) ?? [];
  if (sec === 60) return src;
  return src.filter((b) => b.t + sec > rs && b.t + sec <= re);
}

/** Resolve one trade on 1m bars (SL-first-within-bar, BE-first for the runner). */
function resolveTrade(key: string, dir: "long" | "short", entry: number, entryTime: number,
  z: CoreZones, settle: number): Trade | null {
  const m1 = (day1.get(key) ?? []).filter((b) => b.t >= entryTime);
  const long = dir === "long";
  const sl = long ? z.ybBottom : z.ybTop;
  const tp1 = long ? z.initRes : z.initSup;
  const runnerTarget = long ? z.mrUp : z.mrDn;
  const hitSL = (b: Bar): boolean => (long ? b.l <= sl : b.h >= sl);
  const hitTP = (b: Bar, tp: number): boolean => (long ? b.h >= tp : b.l <= tp);
  const hitBE = (b: Bar): boolean => (long ? b.l <= entry : b.h >= entry);
  const sgn = long ? 1 : -1;

  const entryBeyondTp1 = long ? entry >= tp1 : entry <= tp1;
  let exitReasonA: Trade["exitReasonA"] = "eod";
  let exitPriceA = settle;
  let tp1Idx = -1; // index in m1 where TP1 filled (for the runner walk)

  if (entryBeyondTp1) {
    // TP1 limit is already through the market: fills immediately at market = entry (pnl 0)
    exitReasonA = "tp1"; exitPriceA = entry; tp1Idx = 0;
  } else {
    for (let i = 0; i < m1.length; i++) {
      const b = m1[i];
      if (hitSL(b)) { exitReasonA = "sl"; exitPriceA = sl; break; }        // SL first (conservative)
      if (hitTP(b, tp1)) { exitReasonA = "tp1"; exitPriceA = tp1; tp1Idx = i; break; }
    }
  }
  const pnlA = sgn * (exitPriceA - entry);

  // Model B runner (half unit) — only exists when TP1 filled
  let runnerReason: Trade["runnerReason"] = null;
  let runnerPnl: number | null = null;
  if (exitReasonA === "tp1") {
    runnerReason = "eod"; runnerPnl = sgn * (settle - entry);
    for (let i = Math.max(0, tp1Idx); i < m1.length; i++) {
      const b = m1[i];
      if (hitBE(b)) { runnerReason = "be"; runnerPnl = 0; break; }         // BE stop first (conservative)
      if (hitTP(b, runnerTarget)) { runnerReason = "maxrange"; runnerPnl = sgn * (runnerTarget - entry); break; }
    }
  }
  const pnlB = exitReasonA === "tp1" ? 0.5 * pnlA + 0.5 * (runnerPnl ?? 0) : pnlA;

  return {
    date: key, interval: "", dir, entryTime, entry,
    exitReasonA, exitPriceA, pnlA, entryBeyondTp1,
    runnerReason, runnerPnl, pnlB,
    ybBottom: rnd2(z.ybBottom), ybTop: rnd2(z.ybTop), tp1: rnd2(tp1), sl: rnd2(sl),
    runnerTarget: rnd2(runnerTarget), settle,
  };
}

// ==================== ENTRY SCAN (base + variant a) ====================

/**
 * Find the entry candle. Base mode: FIRST candle closing outside the box (a close already at/beyond
 * TP1 still trades; resolveTrade fills the TP1 unit at market = entry). skipDegenerate (variant a):
 * a break whose close is already at/beyond TP1 BURNS that side — no trade from it; only a later
 * OPPOSITE-side break may trade (first VALID break only, one per day; both sides burned -> no trade).
 */
function scanEntry(cbs: Bar[], z: CoreZones, skipDegenerate: boolean): { bar: Bar; dir: "long" | "short" } | null {
  let burnedLong = false, burnedShort = false;
  for (const b of cbs) {
    if (b.c > z.ybTop) {
      if (!skipDegenerate) return { bar: b, dir: "long" };
      if (b.c >= z.initRes) { if (burnedShort) return null; burnedLong = true; continue; }
      if (burnedLong) continue; // burned side: only the opposite side may still trade
      return { bar: b, dir: "long" };
    } else if (b.c < z.ybBottom) {
      if (!skipDegenerate) return { bar: b, dir: "short" };
      if (b.c <= z.initSup) { if (burnedLong) return null; burnedShort = true; continue; }
      if (burnedShort) continue;
      return { bar: b, dir: "short" };
    }
  }
  return null;
}

// ==================== WALK-FORWARD LOOP ====================

const MIN_60M_BARS = 500;            // >= ~10 60m bars/day across the 50-day window
const EXPECTED_RTH_1M = 450;         // 09:30-17:00 ET
const MIN_RTH_1M = Math.ceil(EXPECTED_RTH_1M * 0.8);

interface DayResult {
  key: string; zones: CoreZones; anchor: number; settle: number;
  openInside: boolean;                    // variant b filter: 09:30 ET RTH open printed inside the box
  trades: Map<string, Trade | null>;      // base
  tradesA: Map<string, Trade | null>;     // variant a: skip-degenerate
  tradesB: Map<string, Trade | null>;     // variant b: open-inside-box days (empty map when day filtered)
}
const dayResults: DayResult[] = [];
const skips: Record<string, Record<string, number>> = {}; // year -> reason -> count
function skip(key: string, reason: string): void {
  const y = key.slice(0, 4);
  skips[y] = skips[y] ?? {};
  skips[y][reason] = (skips[y][reason] ?? 0) + 1;
}

let firstTested = "", lastTested = "";
for (let i = 0; i < days.length; i++) {
  const d = days[i];
  if (i >= 1 && i % 200 === 0) console.log(`[bt] ... day ${i}/${days.length} (${d.key})  elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const last50 = days.slice(Math.max(0, i - 50), i).filter((x) => x.prevClose !== null);
  if (last50.length < 50) { skip(d.key, "insufficientHistory"); continue; }
  const anchor = days[i - 1].c;
  const m1 = day1.get(d.key) ?? [];
  if (m1.length < MIN_RTH_1M) { skip(d.key, "incomplete1m"); continue; }
  const z = computeCoreZones(last50, day60, anchor);
  if (z.n60 < MIN_60M_BARS) { skip(d.key, "insufficient60m"); continue; }

  const rthOpen = m1[0].o; // first RTH 1m bar's open = the 09:30 ET print
  const openInside = rthOpen >= z.ybBottom && rthOpen <= z.ybTop;
  const dr: DayResult = { key: d.key, zones: z, anchor, settle: d.c, openInside, trades: new Map(), tradesA: new Map(), tradesB: new Map() };
  for (const iv of INTERVALS) {
    const cbs = confirmationBars(d.key, iv.sec);
    const mk = (hit: { bar: Bar; dir: "long" | "short" } | null): Trade | null => {
      if (!hit) return null;
      const t = resolveTrade(d.key, hit.dir, hit.bar.c, hit.bar.t + iv.sec, z, d.c);
      if (t) t.interval = iv.name;
      return t;
    };
    const base = mk(scanEntry(cbs, z, false));
    dr.trades.set(iv.name, base);
    dr.tradesA.set(iv.name, mk(scanEntry(cbs, z, true)));           // variant a: skip-degenerate
    if (openInside) dr.tradesB.set(iv.name, base);                  // variant b: same base rule, filtered days
  }
  dayResults.push(dr);
  if (!firstTested) firstTested = d.key;
  lastTested = d.key;
}
console.log(`[bt] walk-forward done: ${dayResults.length} days tested (${firstTested} .. ${lastTested})  elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ==================== METRICS ====================

interface IntervalStats {
  interval: string;
  daysTested: number; trades: number; noSignalDays: number; noSignalPct: number;
  tp1Count: number; slCount: number; eodCount: number;
  tp1Rate: number; slRate: number; eodRate: number;
  entryBeyondTp1Count: number;
  avgWinPts: number; avgLossPts: number; expectancyPts: number; cumPts: number;
  profitFactor: number; maxDrawdownPts: number;
  longCount: number; longWinRate: number; shortCount: number; shortWinRate: number;
  medianEntryTimeET: string;
  // model B
  runnerMaxRangeCount: number; runnerBECount: number; runnerEodCount: number;
  runnerMaxRangeRate: number; runnerBERate: number;
  combinedExpectancyPts: number; combinedCumPts: number;
}

function collectTrades(getter: (dr: DayResult) => Map<string, Trade | null>, name: string,
  dayFilter?: (dr: DayResult) => boolean): { trades: Trade[]; daysTested: number } {
  const trades: Trade[] = [];
  let daysTested = 0;
  for (const dr of dayResults) {
    if (dayFilter && !dayFilter(dr)) continue;
    daysTested++;
    const t = getter(dr).get(name);
    if (t) trades.push(t);
  }
  return { trades, daysTested };
}

function computeStats(name: string, trades: Trade[], daysTested: number): { stats: IntervalStats; trades: Trade[] } {
  const noSignal = daysTested - trades.length;
  const wins = trades.filter((t) => t.pnlA > 0);
  const losses = trades.filter((t) => t.pnlA < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlA, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnlA, 0);
  const cum = trades.reduce((s, t) => s + t.pnlA, 0);
  let peak = 0, run = 0, mdd = 0;
  for (const t of trades) { run += t.pnlA; peak = Math.max(peak, run); mdd = Math.max(mdd, peak - run); }
  const longs = trades.filter((t) => t.dir === "long");
  const shorts = trades.filter((t) => t.dir === "short");
  const tp1C = trades.filter((t) => t.exitReasonA === "tp1").length;
  const slC = trades.filter((t) => t.exitReasonA === "sl").length;
  const eodC = trades.filter((t) => t.exitReasonA === "eod").length;
  // median entry time-of-day (ET minutes)
  const mins = trades.map((t) => { const p = etParts(t.entryTime); return p.hh * 60 + p.mm; }).sort((a, b) => a - b);
  const med = mins.length ? mins[Math.floor(mins.length / 2)] : 0;
  const medStr = `${String(Math.floor(med / 60)).padStart(2, "0")}:${String(med % 60).padStart(2, "0")}`;
  const rMax = trades.filter((t) => t.runnerReason === "maxrange").length;
  const rBE = trades.filter((t) => t.runnerReason === "be").length;
  const rEOD = trades.filter((t) => t.runnerReason === "eod").length;
  const cumB = trades.reduce((s, t) => s + t.pnlB, 0);
  const stats: IntervalStats = {
    interval: name,
    daysTested, trades: trades.length, noSignalDays: noSignal,
    noSignalPct: rnd2((noSignal / Math.max(1, daysTested)) * 100),
    tp1Count: tp1C, slCount: slC, eodCount: eodC,
    tp1Rate: rnd2((tp1C / Math.max(1, trades.length)) * 100),
    slRate: rnd2((slC / Math.max(1, trades.length)) * 100),
    eodRate: rnd2((eodC / Math.max(1, trades.length)) * 100),
    entryBeyondTp1Count: trades.filter((t) => t.entryBeyondTp1).length,
    avgWinPts: rnd2(grossWin / Math.max(1, wins.length)),
    avgLossPts: rnd2(grossLoss / Math.max(1, losses.length)),
    expectancyPts: rnd2(cum / Math.max(1, trades.length)),
    cumPts: rnd2(cum),
    profitFactor: rnd2(grossWin / Math.max(1e-9, -grossLoss)),
    maxDrawdownPts: rnd2(mdd),
    longCount: longs.length,
    longWinRate: rnd2((longs.filter((t) => t.pnlA > 0).length / Math.max(1, longs.length)) * 100),
    shortCount: shorts.length,
    shortWinRate: rnd2((shorts.filter((t) => t.pnlA > 0).length / Math.max(1, shorts.length)) * 100),
    medianEntryTimeET: medStr,
    runnerMaxRangeCount: rMax, runnerBECount: rBE, runnerEodCount: rEOD,
    runnerMaxRangeRate: rnd2((rMax / Math.max(1, tp1C)) * 100),
    runnerBERate: rnd2((rBE / Math.max(1, tp1C)) * 100),
    combinedExpectancyPts: rnd2(cumB / Math.max(1, trades.length)),
    combinedCumPts: rnd2(cumB),
  };
  return { stats, trades };
}

const perInterval: IntervalStats[] = [];
const tradesByInterval = new Map<string, Trade[]>();
for (const iv of INTERVALS) {
  const col = collectTrades((dr) => dr.trades, iv.name);
  const { stats, trades } = computeStats(iv.name, col.trades, col.daysTested);
  perInterval.push(stats);
  tradesByInterval.set(iv.name, trades);
}

// ==== FILTER VARIANTS (coordinator refinement) ====
// (a) SKIP-DEGENERATE: a break already at/beyond TP1 burns that side; only a later opposite-side
//     valid break may trade (first-valid-break-only, one/day).
// (b) OPEN-INSIDE-BOX: only days whose 09:30 ET RTH open prints inside the yellow box (base rule then).
const perIntervalA: IntervalStats[] = [];
const perIntervalB: IntervalStats[] = [];
const tradesByIntervalA = new Map<string, Trade[]>();
const tradesByIntervalB = new Map<string, Trade[]>();
for (const iv of INTERVALS) {
  const colA = collectTrades((dr) => dr.tradesA, iv.name);
  const sA = computeStats(iv.name, colA.trades, colA.daysTested);
  perIntervalA.push(sA.stats); tradesByIntervalA.set(iv.name, sA.trades);
  const colB = collectTrades((dr) => dr.tradesB, iv.name, (dr) => dr.openInside);
  const sB = computeStats(iv.name, colB.trades, colB.daysTested);
  perIntervalB.push(sB.stats); tradesByIntervalB.set(iv.name, sB.trades);
}
const openInsideDays = dayResults.filter((d) => d.openInside).length;
// overlap: % of days passing each filter (per interval for a; day-level for b; both = b-day AND a-valid-trade)
const overlap = {
  openInsideBoxDays: openInsideDays,
  openInsideBoxDaysPct: rnd2((openInsideDays / Math.max(1, dayResults.length)) * 100),
  perInterval: INTERVALS.map((iv) => {
    const aTradeDays = (tradesByIntervalA.get(iv.name) ?? []).length;
    const aDates = new Set((tradesByIntervalA.get(iv.name) ?? []).map((t) => t.date));
    const both = dayResults.filter((d) => d.openInside && aDates.has(d.key)).length;
    return {
      interval: iv.name,
      skipDegenerateValidTradeDaysPct: rnd2((aTradeDays / Math.max(1, dayResults.length)) * 100),
      bothFiltersPct: rnd2((both / Math.max(1, dayResults.length)) * 100),
    };
  }),
};

// per-year breakdown helper (Model A pnl)
function perYearOf(trades: Trade[]): { year: string; trades: number; winRatePct: number; cumPts: number }[] {
  const byYear = new Map<string, Trade[]>();
  for (const t of trades) {
    const y = t.date.slice(0, 4);
    let arr = byYear.get(y); if (!arr) { arr = []; byYear.set(y, arr); }
    arr.push(t);
  }
  return [...byYear.entries()].sort().map(([y, arr]) => ({
    year: y, trades: arr.length,
    winRatePct: rnd2((arr.filter((t) => t.pnlA > 0).length / arr.length) * 100),
    cumPts: rnd2(arr.reduce((s, t) => s + t.pnlA, 0)),
  }));
}
const trades5 = tradesByInterval.get("5m") ?? [];
const perYear5m = perYearOf(trades5);
// per-year 5m for whichever VARIANT has the better 5m Model-A profit factor
const pfA5 = perIntervalA.find((s) => s.interval === "5m")?.profitFactor ?? 0;
const pfB5 = perIntervalB.find((s) => s.interval === "5m")?.profitFactor ?? 0;
const bestVariantName = pfA5 >= pfB5 ? "skipDegenerate" : "openInsideBox";
const perYear5mBestVariant = perYearOf((pfA5 >= pfB5 ? tradesByIntervalA : tradesByIntervalB).get("5m") ?? []);

// ==================== SANITY: Jul-10 / Jul-13 2026 vs renderer ====================

interface SanityRow { date: string; ours: Record<string, number>; renderer: Record<string, number> | null; exactMatch: boolean | null }
const sanity: SanityRow[] = [];
for (const dk of ["2026-07-10", "2026-07-13"]) {
  const dr = dayResults.find((x) => x.key === dk);
  if (!dr) { sanity.push({ date: dk, ours: {}, renderer: null, exactMatch: null }); continue; }
  const z = dr.zones;
  const ours = {
    ybBottom: rnd2(z.ybBottom), ybTop: rnd2(z.ybTop),
    initRes: rnd2(z.initRes), initSup: rnd2(z.initSup),
    mrUp: rnd2(z.mrUp), mrDn: rnd2(z.mrDn), nrDn: rnd2(z.nrDn), mtUp: rnd2(z.mtUp),
  };
  let renderer: Record<string, number> | null = null;
  let exact: boolean | null = null;
  const jsonPath = path.resolve(__dir, "..", `yellowbox-${dk}.json`);
  if (fs.existsSync(jsonPath)) {
    const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
      volatility: { yellowBox: { bottom: number; top: number }; initialResistance: number; initialSupport: number;
        maxRangeDays: { up: number; dn: number }; normalRangeDays: { dn: number }; maxTrendUp: { level: number } };
    };
    renderer = {
      ybBottom: doc.volatility.yellowBox.bottom, ybTop: doc.volatility.yellowBox.top,
      initRes: doc.volatility.initialResistance, initSup: doc.volatility.initialSupport,
      mrUp: doc.volatility.maxRangeDays.up, mrDn: doc.volatility.maxRangeDays.dn,
      nrDn: doc.volatility.normalRangeDays.dn, mtUp: doc.volatility.maxTrendUp.level,
    };
    exact = Object.keys(ours).every((k) => ours[k as keyof typeof ours] === renderer![k]);
  }
  sanity.push({ date: dk, ours, renderer, exactMatch: exact });
}

// 3 random traded days (fixed-seed LCG for reproducibility) from the 5m interval
const spot: object[] = [];
{
  let x = 42 >>> 0;
  const rand = (): number => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
  const pool = [...trades5];
  for (let k = 0; k < 3 && pool.length; k++) {
    const idx = Math.floor(rand() * pool.length);
    const t = pool.splice(idx, 1)[0];
    const p = etParts(t.entryTime);
    spot.push({
      date: t.date, interval: t.interval, dir: t.dir,
      box: `${t.ybBottom}-${t.ybTop}`, tp1: t.tp1, sl: t.sl, runnerTarget: t.runnerTarget, settle: t.settle,
      entryCandleCloseET: `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`,
      entryTimeUtc: isoUtc(t.entryTime), entry: t.entry,
      modelA: { exit: t.exitReasonA, price: t.exitPriceA, pnl: rnd2(t.pnlA) },
      modelB: { runner: t.runnerReason, runnerPnl: t.runnerPnl === null ? null : rnd2(t.runnerPnl), combinedPnl: rnd2(t.pnlB) },
    });
  }
}

// ==================== REPORT ====================

const pad = (s: string | number, w: number): string => String(s).padStart(w);
console.log(`\n=== YELLOW BOX BACKTEST (${SYMBOL}) — ${firstTested} .. ${lastTested}, ${dayResults.length} days, formula ${YB_FORMULA} ===`);
console.log(`entry: first C-interval candle CLOSING outside box during RTH | stop: opposite edge | TP1: initRes(p${IRS_PCT_UP * 100})/initSup(p${IRS_PCT_DN * 100}) | runner: maxRange(p${MR_PCT * 100}/p${MR_PCT_DN * 100})`);
console.log(`\n--- 1. PER-INTERVAL (Model A: full unit to TP1/SL/EOD) ---`);
console.log(`iv   days  trades noSig%  tp1%   sl%   eod%  avgWin avgLoss  expcy  cumPts     PF   maxDD  L(cnt/win%)  S(cnt/win%)`);
for (const s of perInterval) {
  console.log(`${s.interval.padEnd(4)} ${pad(s.daysTested, 5)} ${pad(s.trades, 6)} ${pad(s.noSignalPct, 6)} ${pad(s.tp1Rate, 5)} ${pad(s.slRate, 5)} ${pad(s.eodRate, 5)} ${pad(s.avgWinPts, 7)} ${pad(s.avgLossPts, 7)} ${pad(s.expectancyPts, 6)} ${pad(s.cumPts, 8)} ${pad(s.profitFactor, 6)} ${pad(s.maxDrawdownPts, 7)}  ${pad(s.longCount, 5)}/${pad(s.longWinRate, 5)}  ${pad(s.shortCount, 5)}/${pad(s.shortWinRate, 5)}`);
}
console.log(`\n--- 2. MODEL B ADDENDUM (half at TP1 + runner half to max range, BE stop) ---`);
console.log(`iv   tp1Trades  runnerMaxRange%  runnerBE%  runnerEOD  combExpcy  combCum`);
for (const s of perInterval) {
  console.log(`${s.interval.padEnd(4)} ${pad(s.tp1Count, 9)} ${pad(s.runnerMaxRangeRate, 15)} ${pad(s.runnerBERate, 10)} ${pad(s.runnerEodCount, 9)} ${pad(s.combinedExpectancyPts, 10)} ${pad(s.combinedCumPts, 8)}`);
}
console.log(`\n--- 3. PER-YEAR (5m interval, Model A) ---`);
console.log(`year  trades  win%   cumPts`);
for (const y of perYear5m) console.log(`${y.year}  ${pad(y.trades, 6)} ${pad(y.winRatePct, 5)} ${pad(y.cumPts, 8)}`);
console.log(`\n--- 4. DISTRIBUTION NOTES ---`);
for (const s of perInterval) {
  console.log(`${s.interval.padEnd(4)} medianEntry ${s.medianEntryTimeET} ET | noSignal ${s.noSignalPct}% of days | first break: stopped ${s.slRate}% vs ran-to-TP1 ${s.tp1Rate}% (eod-flat ${s.eodRate}%) | entry-beyond-TP1 ${s.entryBeyondTp1Count}`);
}
const printIvTable = (title: string, rows: IntervalStats[]): void => {
  console.log(`\n--- ${title} ---`);
  console.log(`iv   days  trades noSig%  tp1%   sl%   eod%  avgWin avgLoss  expcy  cumPts     PF   maxDD  L(cnt/win%)  S(cnt/win%)`);
  for (const s of rows) {
    console.log(`${s.interval.padEnd(4)} ${pad(s.daysTested, 5)} ${pad(s.trades, 6)} ${pad(s.noSignalPct, 6)} ${pad(s.tp1Rate, 5)} ${pad(s.slRate, 5)} ${pad(s.eodRate, 5)} ${pad(s.avgWinPts, 7)} ${pad(s.avgLossPts, 7)} ${pad(s.expectancyPts, 6)} ${pad(s.cumPts, 8)} ${pad(s.profitFactor, 6)} ${pad(s.maxDrawdownPts, 7)}  ${pad(s.longCount, 5)}/${pad(s.longWinRate, 5)}  ${pad(s.shortCount, 5)}/${pad(s.shortWinRate, 5)}`);
  }
  console.log(`     modelB: ` + rows.map((s) => `${s.interval} combExpcy ${s.combinedExpectancyPts} combCum ${s.combinedCumPts} (runnerMax ${s.runnerMaxRangeRate}% BE ${s.runnerBERate}%)`).join(" | "));
};
printIvTable(`VARIANT (a) SKIP-DEGENERATE (break at/beyond TP1 burns its side; opposite-side valid break may still trade)`, perIntervalA);
printIvTable(`VARIANT (b) OPEN-INSIDE-BOX (only days whose 09:30 ET open prints inside the box)`, perIntervalB);
console.log(`\n--- VARIANT OVERLAP ---`);
console.log(`open-inside-box days: ${overlap.openInsideBoxDays}/${dayResults.length} (${overlap.openInsideBoxDaysPct}%)`);
for (const o of overlap.perInterval) console.log(`  ${o.interval.padEnd(4)} skip-degenerate valid-trade days ${o.skipDegenerateValidTradeDaysPct}% | both filters ${o.bothFiltersPct}%`);
console.log(`\n--- PER-YEAR (5m) FOR BEST-PF VARIANT: ${bestVariantName} (PF5m a=${pfA5} b=${pfB5}) ---`);
console.log(`year  trades  win%   cumPts`);
for (const y of perYear5mBestVariant) console.log(`${y.year}  ${pad(y.trades, 6)} ${pad(y.winRatePct, 5)} ${pad(y.cumPts, 8)}`);

console.log(`\n--- 5. SANITY (backtest zones vs current renderer JSON) ---`);
for (const s of sanity) {
  console.log(`${s.date}: ours=${JSON.stringify(s.ours)}`);
  console.log(`${" ".repeat(10)} renderer=${s.renderer ? JSON.stringify(s.renderer) : "json not found"}  EXACT=${s.exactMatch}`);
}
console.log(`\n--- SPOT-CHECK: 3 random 5m trades (seed 42) ---`);
for (const sp of spot) console.log("  " + JSON.stringify(sp));
console.log(`\n--- SKIPPED DAYS (by year) ---`);
for (const [y, r] of Object.entries(skips).sort()) console.log(`  ${y}: ${JSON.stringify(r)}`);

const runtimeSec = rnd2((Date.now() - t0) / 1000);
const outPath = path.resolve(process.cwd(), OUT_JSON);
fs.writeFileSync(outPath, JSON.stringify({
  symbol: SYMBOL,
  generatedAt: new Date().toISOString(),
  formula: YB_FORMULA,
  strategy: {
    entry: "first C-interval candle closing outside the yellow box during RTH (close time in (09:30,17:00] ET); long above / short below; one trade/day/interval",
    confirmation60mNote: "60m bars are :00-UTC-aligned; the first eligible 60m candle spans the open (09:00-10:00 ET) and is evaluated at its 10:00 close",
    stop: "opposite yellow-box edge", tp1: "init res (long) / init sup (short)",
    exitResolution: "1m bars; SL-first within-bar (conservative); EOD force-exit at day settle",
    modelB: "half at TP1, runner half targets max range with BE stop (BE-first within-bar); EOD applies",
    entryBeyondTp1: "TP1 unit fills at market=entry (pnl 0), runner proceeds",
    skipRule: `days with < ${MIN_RTH_1M}/${EXPECTED_RTH_1M} RTH 1m bars skipped`,
  },
  window: { firstTested, lastTested, daysTested: dayResults.length },
  runtimeSec,
  perInterval,
  perYear5m,
  variants: {
    skipDegenerate: {
      rule: "a break closing at/beyond TP1 burns that side (no trade); only a later opposite-side valid break may trade; first-valid-break-only, one/day",
      perInterval: perIntervalA,
    },
    openInsideBox: {
      rule: "only days whose 09:30 ET RTH open prints inside the yellow box (base entry rule applies on those days)",
      daysPassing: openInsideDays,
      daysPassingPct: overlap.openInsideBoxDaysPct,
      perInterval: perIntervalB,
    },
    overlap,
    perYear5mBestPF: { variant: bestVariantName, pf5m: { skipDegenerate: pfA5, openInsideBox: pfB5 }, rows: perYear5mBestVariant },
  },
  sanity,
  spotChecks: spot,
  skippedDaysByYear: skips,
}, null, 2));
console.log(`\n[bt] wrote ${outPath}  runtime ${runtimeSec}s`);
