/**
 * ict-backtest.ts — FULL-HISTORY walk-forward backtest of the seven ICT strategies
 * (shared/ict-engine.ts) + the ict-backtest.xlsx workbook (exceljs, pure JS).
 *
 * Usage:
 *   npx tsx scripts/ict-backtest.ts [--symbol MES] [--skip-xlsx] [--xlsx-only] [--smoke]
 *   (--xlsx-only: rebuild the workbook from the EXISTING results JSON — frozen trade set.
 *    --smoke: candles from 2026-06-01 only, for fast iteration.)
 *
 * ── WHAT ONE RUN DOES ────────────────────────────────────────────────────────
 *  PHASE A  Load MES candles (1m/5m/15m/60m) with the serving-path validity filters,
 *           build prior-day / Asia / London / NY session levels from 1m bars.
 *  PHASE B  runIctEngine per interval ∈ {5m, 15m, 60m} (1m skipped — quality lesson
 *           from the fact-engine backtest) → setups for all 7 strategies.
 *  PHASE C  Resolve every setup on 1m bars: limit fills inside the 30-bar retest
 *           window (fills AT the limit level; FVG gap-open invalidation), market
 *           entries at the signal close; exits SL-FIRST on same-bar ambiguity,
 *           TP2 before TP1, force-close at the 17:00 ET settle.
 *  PHASE D  Acceptance: one open trade per strategy per interval (no pyramiding) —
 *           fills that land while the same strategy@interval is in a trade are skipped.
 *  PHASE E  Combos: ICT+ICT (same interval, same direction, setups within 3 bars —
 *           the combo trade IS the later signal's trade) and ICT × existing engine
 *           (fact-engine-backtest-results.json, read-only, same 3-bar window).
 *  PHASE F  Workbook: README, All ICT Trades, one sheet per strategy (+ Unicorn),
 *           ICT+ICT combo sheets (n ≥ 15), ICT×existing combo sheets (n ≥ 15),
 *           Rare Combos rollup, Comparison (every class ranked by expectancy).
 *           Every sheet reports BOTH all-hours stats and the kill-zone-filtered
 *           variant (London + NY-AM entries) — kill zones are context, not a gate.
 *
 * Fidelity: the decision model is shared/ict-engine.ts (unit-tested, no-lookahead-
 * verified). No slippage/commission; fills AT the level; stop-first — documented
 * in the workbook README. NO synthetic data anywhere.
 */

import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsDir } from "../shared/artifacts-dir"; // BAXTER_ARTIFACTS_DIR (2026-08-02)
import {
  runIctEngine, ICT_STRATEGIES, ICT_DISPLAY, ICT_CONST,
  type IctSetup, type IctStrategy, type LiquidityLevel,
} from "../shared/ict-engine";
import type { FiringCandle } from "../shared/firing/types";
import { isRTH } from "../shared/firing/session";
import {
  etParts, etWallToEpoch, sessionDayKey, priorCalendarDay, weekdayOfKey, WEEKDAY_NAMES, rnd2,
} from "../shared/yellowbox-core";
import { displaySignalType, displayOutcome } from "../shared/signal-display";
import { renderTradeChart, type ChartZone, type ChartLine } from "./trade-chart-render";

// ============================= CLI =============================

let SYMBOL = "MES";
let SKIP_XLSX = false;
let XLSX_ONLY = false;
let SMOKE = false;
let CHARTS_ONLY = false; // render per-trade PNGs for the EXISTING results JSON (frozen trade set) + rebuild the workbook
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--symbol") SYMBOL = argv[++i] ?? "MES";
    else if (argv[i] === "--skip-xlsx") SKIP_XLSX = true;
    else if (argv[i] === "--xlsx-only") XLSX_ONLY = true;
    else if (argv[i] === "--smoke") SMOKE = true;
    else if (argv[i] === "--charts-only") CHARTS_ONLY = true;
  }
}

const t0 = Date.now();
const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
// BAXTER_ARTIFACTS_DIR (2026-08-02): artifacts (JSON/xlsx/chart PNGs) resolve here; the
// workbook's CHART links are relative (ict-trade-charts\...) so xlsx + charts stay together.
const ARTIFACTS_DIR = artifactsDir(ROOT);
const OUT_JSON = path.join(ARTIFACTS_DIR, "ict-backtest-results.json");
const OUT_XLSX = path.join(ARTIFACTS_DIR, "ict-backtest.xlsx");
const EXISTING_JSON = path.join(ARTIFACTS_DIR, "fact-engine-backtest-results.json");
const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

type Iv = "5m" | "15m" | "60m";
const INTERVALS: Iv[] = ["5m", "15m", "60m"];
const IV_SEC: Record<Iv, number> = { "5m": 300, "15m": 900, "60m": 3600 };
const RES_OF: Record<Iv | "1m", string> = { "1m": "1", "5m": "5", "15m": "15", "60m": "60" };
/** Combo sheets need at least this many trades; smaller combos roll into "Rare Combos". */
const COMBO_MIN_N = 15;
/** Per-sheet row cap (most recent kept) — keeps the workbook openable; stats cover shown rows. */
const SHEET_ROW_CAP = 50000;
/** The known-worst bad DB row (MES 5m, 2026-05-25 20:45Z phantom Memorial-Day bar). */
const KNOWN_BAD_BAR_TS = 1779741900;
/** Per-trade chart PNG coverage: trades whose ET date is on/after this key (the past month,
 *  per the user's spec 2026-06-15 -> present). Older rows show "—" in the CHART column. */
const CHART_FROM_KEY = "2026-06-15";
const CHART_DIR = "ict-trade-charts";

/** Short jargon-light codes for combo sheet names (31-char Excel limit). */
const ICT_SHORT: Record<IctStrategy, string> = {
  "ICT-OB": "OB", "ICT-FVG": "FVG", "ICT-BREAKER": "Breaker", "ICT-SWEEP": "Sweep",
  "ICT-MSS": "MSS-OTE", "ICT-CE": "Wick CE", "ICT-MITIGATION": "Mitigation",
};
const EXISTING_SHORT: Record<string, string> = {
  "fact-engine": "Confluence", "vector-side-entry": "Vector Side-Entry",
  "yellowbox-break": "Yellow Box", "zone-reaction": "Milk Zone",
};

// ==================== SESSION / VALIDITY FILTERS ====================
// Mirrors scripts/fact-engine-backtest.ts (which mirrors the serving path). Copied, not
// imported — that script executes its run at module load and cannot be imported.

const _closedCache = new Map<number, boolean>();
function isMarketClosedEt(t: number): boolean {
  const hb = Math.floor(t / 3600);
  const hit = _closedCache.get(hb);
  if (hit !== undefined) return hit;
  const p = etParts(t);
  const dow = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
  const mins = p.hh * 60 + p.mm;
  let closed: boolean;
  if (dow === 6) closed = true;
  else if (dow === 5) closed = mins >= 17 * 60;
  else if (dow === 0) closed = mins < 18 * 60;
  else closed = mins >= 17 * 60 && mins < 18 * 60;
  _closedCache.set(hb, closed);
  return closed;
}

function isValidBar(o: number, h: number, l: number, c: number): boolean {
  if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) return false;
  if (o < 1 || h < 1 || l < 1 || c < 1) return false;
  if (o >= 9e13 || h >= 9e13 || l >= 9e13 || c >= 9e13) return false;
  if (h <= l) return false;
  const range = h - l;
  if (range / c > 0.015 && Math.abs(o - c) / range < 0.10) return false;
  const bL = Math.min(o, c), bH = Math.max(o, c);
  if ((bL - l) / c > 0.015 || (h - bH) / c > 0.015) return false;
  return true;
}

// ==================== SMALL HELPERS ====================

function lowerBound(times: number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pad2 = (n: number): string => String(n).padStart(2, "0");
function fmtEt(t: number): string {
  const q = etParts(t);
  return `${q.y}-${pad2(q.mo)}-${pad2(q.d)} ${pad2(q.hh)}:${pad2(q.mm)}`;
}

/** Kill-zone classification of an entry timestamp (ET wall clock; mission-defined windows). */
function killZoneOf(ts: number): string {
  const p = etParts(ts);
  const mins = p.hh * 60 + p.mm;
  if (mins >= 0 && mins < 60) return "Midnight Open";           // 00:00–01:00 ET
  if (mins >= 2 * 60 && mins < 5 * 60) return "London";         // 02:00–05:00 ET
  if (mins >= 10 * 60 && mins < 11 * 60) return "NY-AM + Silver Bullet"; // 10:00–11:00 ⊂ NY-AM
  if (mins >= 8 * 60 + 30 && mins < 11 * 60) return "NY-AM";    // 08:30–11:00 ET
  return "—";
}
const isKz = (kz: string): boolean => kz === "London" || kz.startsWith("NY-AM");

// ==================== ROW / DOC TYPES ====================

type Outcome = "tp1" | "tp2" | "sl" | "eod" | "open";

interface TradeRow {
  seq: number;
  strategy: IctStrategy;
  interval: Iv;
  direction: "Long" | "Short";
  setupIdx: number;
  setupTime: number;        // signal bar OPEN (engine convention)
  signalTimeET: string;     // signal bar CLOSE, ET (when the setup became actionable)
  entryTs: number;
  dateET: string;
  timeET: string;
  weekday: string;
  session: "RTH" | "ETH";
  killZone: string;
  entry: number; sl: number; tp1: number; tp2: number;
  why: string;
  exitPlan: string;
  confluence: string;       // same-window partners (ICT + existing) — annotation only
  outcome: Outcome;
  exitPrice: number | null;
  exitTs: number | null;
  exitTimeET: string;
  pointsResult: number | null;
  mae: number;
  mfe: number;
  barsToFill: number;       // strategy-interval bars from signal close to fill
  barsToExit: number | null;
  unicorn: boolean;
  refs: Record<string, number>;
  /** Relative path of this trade's chart PNG (ict-trade-charts/<iv>/…), past-month trades only. */
  chartPath?: string;
}

interface ComboRow extends TradeRow { comboKey: string }

interface RunMeta {
  symbol: string;
  generatedAt: string;
  runtimeSec: number;
  smoke: boolean;
  dataSpan: Record<string, { n: number; from: string; to: string }>;
  lastDataTs: number;
  constants: typeof ICT_CONST;
  knownBadBarPresent: boolean;
  setupCounts: Record<string, number>;      // strategy@interval → setups emitted
  fillFailures: Record<string, { expired: number; invalid: number; blocked: number }>;
  strategyStats: Array<{
    strategy: IctStrategy; display: string; n: number; winRate: number; expectancy: number;
    pf: number; cumPts: number; kzN: number; kzWinRate: number; kzExpectancy: number; kzPf: number;
  }>;
  existingSource: string;
  existingMatched: number;
}

interface ResultsDoc {
  meta: RunMeta;
  trades: TradeRow[];
  combosIctIct: ComboRow[];
  combosIctExisting: ComboRow[];
}

// ==================== DATA LOADING (PHASE A) ====================

interface Loaded {
  candlesByIv: Record<Iv, FiringCandle[]>;
  c1m: FiringCandle[];
  t1m: number[];
  dataSpan: RunMeta["dataSpan"];
  lastDataTs: number;
  levels: LiquidityLevel[];
  knownBadBarPresent: boolean;
}

function loadData(): Loaded {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    db = new Database(DB_PATH, { fileMustExist: true }); // WAL readonly needs -shm; no writes issued
  }
  const fromTs = SMOKE ? etWallToEpoch("2026-06-01", 0, 0) : 0;

  const badRow = db.prepare(
    `SELECT timestamp FROM cached_candles WHERE symbol=? AND resolution='5' AND timestamp=?`
  ).get(SYMBOL, KNOWN_BAD_BAR_TS) as { timestamp: number } | undefined;
  const knownBadBarPresent = badRow !== undefined;
  console.log(`[ict-bt] known-bad bar (MES 5m 2026-05-25 20:45Z): ${knownBadBarPresent ? "STILL PRESENT (noted in README)" : "gone (repaired)"}`);

  const load = (res: string): FiringCandle[] => {
    const arr: FiringCandle[] = [];
    const it = db.prepare(
      `SELECT timestamp t, open o, high h, low l, close c, volume v
       FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp>=? ORDER BY timestamp`
    ).iterate(SYMBOL, res, fromTs) as IterableIterator<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
    for (const r of it) {
      if (!isValidBar(r.o, r.h, r.l, r.c)) continue;
      if (isMarketClosedEt(r.t)) continue;
      if (arr.length && arr[arr.length - 1].time === r.t) { arr[arr.length - 1] = { time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }; continue; }
      arr.push({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
    }
    return arr;
  };

  const candlesByIv = {} as Record<Iv, FiringCandle[]>;
  const dataSpan: RunMeta["dataSpan"] = {};
  const c1m = load(RES_OF["1m"]);
  dataSpan["1m"] = { n: c1m.length, from: new Date(c1m[0].time * 1000).toISOString().slice(0, 10), to: new Date(c1m[c1m.length - 1].time * 1000).toISOString().slice(0, 10) };
  for (const iv of INTERVALS) {
    candlesByIv[iv] = load(RES_OF[iv]);
    const a = candlesByIv[iv];
    dataSpan[iv] = { n: a.length, from: new Date(a[0].time * 1000).toISOString().slice(0, 10), to: new Date(a[a.length - 1].time * 1000).toISOString().slice(0, 10) };
    console.log(`[ict-bt] ${iv}: ${a.length} bars (${dataSpan[iv].from}..${dataSpan[iv].to})  ${elapsed()}`);
  }
  db.close();
  const t1m = c1m.map(c => c.time);
  const lastDataTs = Math.max(c1m[c1m.length - 1].time + 60, ...INTERVALS.map(iv => candlesByIv[iv][candlesByIv[iv].length - 1].time + IV_SEC[iv]));

  // ── Session levels from 1m bars (prior-day H/L, Asia, London, prior-day NY) ──
  interface DayWin { dayHi: number; dayLo: number; asiaHi: number; asiaLo: number; lonHi: number; lonLo: number; nyHi: number; nyLo: number; hasAsia: boolean; hasLon: boolean; hasNy: boolean }
  const dayMap = new Map<string, DayWin>();
  const boundsCache = new Map<string, { start: number; asiaEnd: number; lonEnd: number; end: number }>();
  const boundsOf = (k: string): { start: number; asiaEnd: number; lonEnd: number; end: number } => {
    let b = boundsCache.get(k);
    if (!b) {
      b = {
        start: etWallToEpoch(priorCalendarDay(k), 18, 0),
        asiaEnd: etWallToEpoch(k, 3, 0),
        lonEnd: etWallToEpoch(k, 8, 30),
        end: etWallToEpoch(k, 17, 0),
      };
      boundsCache.set(k, b);
    }
    return b;
  };
  for (const c of c1m) {
    const k = sessionDayKey(c.time);
    let d = dayMap.get(k);
    if (!d) { d = { dayHi: -Infinity, dayLo: Infinity, asiaHi: -Infinity, asiaLo: Infinity, lonHi: -Infinity, lonLo: Infinity, nyHi: -Infinity, nyLo: Infinity, hasAsia: false, hasLon: false, hasNy: false }; dayMap.set(k, d); }
    d.dayHi = Math.max(d.dayHi, c.high); d.dayLo = Math.min(d.dayLo, c.low);
    const b = boundsOf(k);
    if (c.time < b.asiaEnd) { d.asiaHi = Math.max(d.asiaHi, c.high); d.asiaLo = Math.min(d.asiaLo, c.low); d.hasAsia = true; }
    else if (c.time < b.lonEnd) { d.lonHi = Math.max(d.lonHi, c.high); d.lonLo = Math.min(d.lonLo, c.low); d.hasLon = true; }
    else { d.nyHi = Math.max(d.nyHi, c.high); d.nyLo = Math.min(d.nyLo, c.low); d.hasNy = true; }
  }
  const keys = [...dayMap.keys()].sort();
  const levels: LiquidityLevel[] = [];
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i], prev = dayMap.get(keys[i - 1])!, cur = dayMap.get(k)!;
    const b = boundsOf(k);
    // prior-day full-session high/low, active all of day k
    levels.push({ price: prev.dayHi, opposite: prev.dayLo, kind: "prior-day high", isHigh: true, activeFromTs: b.start, activeToTs: b.end });
    levels.push({ price: prev.dayLo, opposite: prev.dayHi, kind: "prior-day low", isHigh: false, activeFromTs: b.start, activeToTs: b.end });
    // prior-day NY session high/low (only when distinct from the day extremes)
    if (prev.hasNy && prev.nyHi < prev.dayHi) levels.push({ price: prev.nyHi, opposite: prev.nyLo, kind: "prior-day NY session high", isHigh: true, activeFromTs: b.start, activeToTs: b.end });
    if (prev.hasNy && prev.nyLo > prev.dayLo) levels.push({ price: prev.nyLo, opposite: prev.nyHi, kind: "prior-day NY session low", isHigh: false, activeFromTs: b.start, activeToTs: b.end });
    // today's Asia levels, active once Asia completes (03:00 ET)
    if (cur.hasAsia) {
      levels.push({ price: cur.asiaHi, opposite: cur.asiaLo, kind: "Asia session high", isHigh: true, activeFromTs: b.asiaEnd, activeToTs: b.end });
      levels.push({ price: cur.asiaLo, opposite: cur.asiaHi, kind: "Asia session low", isHigh: false, activeFromTs: b.asiaEnd, activeToTs: b.end });
    }
    // today's London levels, active once London completes (08:30 ET)
    if (cur.hasLon) {
      levels.push({ price: cur.lonHi, opposite: cur.lonLo, kind: "London session high", isHigh: true, activeFromTs: b.lonEnd, activeToTs: b.end });
      levels.push({ price: cur.lonLo, opposite: cur.lonHi, kind: "London session low", isHigh: false, activeFromTs: b.lonEnd, activeToTs: b.end });
    }
  }
  levels.sort((a, b) => a.activeFromTs - b.activeFromTs);
  console.log(`[ict-bt] session levels: ${levels.length} across ${keys.length} session days  ${elapsed()}`);

  return { candlesByIv, c1m, t1m, dataSpan, lastDataTs, levels, knownBadBarPresent };
}

// ==================== FILL + EXIT RESOLUTION (PHASE C) ====================

interface Resolved {
  entryTs: number; entry: number; fillIdx: number; barsToFill: number;
  outcome: Outcome; exitPrice: number | null; exitTs: number | null; mae: number; mfe: number;
}

/** Resolve a limit fill on 1m bars. Fills AT the limit level (pessimistic for entries:
 *  a gap-through open still fills at the level, never better). FVG setups die if a 1m
 *  bar OPENS beyond the invalidation level before the fill. */
function resolveFill(s: IctSetup, L: Loaded): { fill?: { entryTs: number; fillIdx: number }; fail?: "expired" | "invalid" } {
  if (s.entryKind === "market") {
    return { fill: { entryTs: s.barCloseTs, fillIdx: lowerBound(L.t1m, s.barCloseTs) } };
  }
  const windowEndTs = s.barCloseTs + ICT_CONST.RETEST_WINDOW_BARS * IV_SEC[s.interval as Iv];
  const isLong = s.direction === "Long";
  for (let j = lowerBound(L.t1m, s.barCloseTs); j < L.c1m.length; j++) {
    const b = L.c1m[j];
    if (b.time >= windowEndTs) return { fail: "expired" };
    if (s.invalidBeyond != null) {
      if (isLong ? b.open < s.invalidBeyond : b.open > s.invalidBeyond) return { fail: "invalid" };
    }
    if (isLong ? b.low <= s.entry : b.high >= s.entry) {
      return { fill: { entryTs: b.time, fillIdx: j } };
    }
  }
  return { fail: "expired" };
}

/** Walk the exit on 1m bars from the fill bar (inclusive): SL first on same-bar ambiguity,
 *  TP2 before TP1, force-close at the 17:00 ET settle of the entry's session day. */
function walkExit(s: IctSetup, entryTs: number, fillIdx: number, L: Loaded, nowSec: number): Omit<Resolved, "entryTs" | "entry" | "fillIdx" | "barsToFill"> {
  const isLong = s.direction === "Long";
  const entry = s.entry;
  const settleTs = etWallToEpoch(sessionDayKey(entryTs), 17, 0);
  let outcome: Outcome = "open";
  let exitPrice: number | null = null;
  let exitTs: number | null = null;
  let mae = 0, mfe = 0;
  let lastClose = entry, lastCloseTs = entryTs;
  for (let j = fillIdx; j < L.c1m.length; j++) {
    const b = L.c1m[j];
    if (b.time >= settleTs) break;
    if (isLong) { mae = Math.max(mae, entry - b.low); mfe = Math.max(mfe, b.high - entry); }
    else { mae = Math.max(mae, b.high - entry); mfe = Math.max(mfe, entry - b.low); }
    if (isLong) {
      if (b.low <= s.stop) { outcome = "sl"; exitPrice = s.stop; exitTs = b.time + 60; break; }
      if (b.high >= s.tp2) { outcome = "tp2"; exitPrice = s.tp2; exitTs = b.time + 60; break; }
      if (b.high >= s.tp1) { outcome = "tp1"; exitPrice = s.tp1; exitTs = b.time + 60; break; }
    } else {
      if (b.high >= s.stop) { outcome = "sl"; exitPrice = s.stop; exitTs = b.time + 60; break; }
      if (b.low <= s.tp2) { outcome = "tp2"; exitPrice = s.tp2; exitTs = b.time + 60; break; }
      if (b.low <= s.tp1) { outcome = "tp1"; exitPrice = s.tp1; exitTs = b.time + 60; break; }
    }
    lastClose = b.close; lastCloseTs = b.time + 60;
  }
  if (outcome === "open" && settleTs <= Math.min(L.lastDataTs, nowSec)) {
    outcome = "eod"; exitPrice = lastClose; exitTs = Math.min(settleTs, lastCloseTs);
  }
  return { outcome, exitPrice, exitTs, mae: rnd2(mae), mfe: rnd2(mfe) };
}

// ==================== METRICS ====================

interface Metrics {
  count: number; wins: number; tp1: number; tp2: number; losses: number; eod: number; open: number;
  winRate: number; expectancy: number; cumPts: number; profitFactor: number; maxDD: number;
  avgMae: number; avgMfe: number; avgBars: number;
}
function metricsOf(rows: TradeRow[]): Metrics {
  const tp1 = rows.filter(r => r.outcome === "tp1").length;
  const tp2 = rows.filter(r => r.outcome === "tp2").length;
  const losses = rows.filter(r => r.outcome === "sl").length;
  const eod = rows.filter(r => r.outcome === "eod").length;
  const open = rows.filter(r => r.outcome === "open").length;
  const closed = rows.length - open;
  const pts = rows.filter(r => r.pointsResult != null).map(r => r.pointsResult as number);
  const grossWin = pts.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const grossLoss = pts.filter(v => v < 0).reduce((a, b) => a + b, 0);
  const cum = pts.reduce((a, b) => a + b, 0);
  let peak = 0, run = 0, mdd = 0;
  for (const r of rows) {
    if (r.pointsResult == null) continue;
    run += r.pointsResult; peak = Math.max(peak, run); mdd = Math.max(mdd, peak - run);
  }
  const barsArr = rows.filter(r => r.barsToExit != null).map(r => r.barsToExit as number);
  return {
    count: rows.length, wins: tp1 + tp2, tp1, tp2, losses, eod, open,
    winRate: closed ? (tp1 + tp2) / closed : 0,
    expectancy: closed ? rnd2(cum / closed) : 0,
    cumPts: rnd2(cum),
    profitFactor: grossLoss < 0 ? rnd2(grossWin / -grossLoss) : (grossWin > 0 ? 999 : 0),
    maxDD: rnd2(mdd),
    avgMae: rnd2(mean(rows.map(r => r.mae))), avgMfe: rnd2(mean(rows.map(r => r.mfe))),
    avgBars: rnd2(mean(barsArr)),
  };
}

// ==================== PER-TRADE CHART PNGs ====================
// One app-styled chart per PAST-MONTH trade (dateET >= CHART_FROM_KEY) with the fired ICT
// structure drawn: OB/breaker/mitigation zone, FVG band, OTE zone, swept level. Rendered by
// scripts/trade-chart-render.ts; linked + embedded in-row on the All ICT Trades sheet.

function chartStructuresOf(t: TradeRow, candles: FiringCandle[]): { zones: ChartZone[]; lines: ChartLine[] } {
  const zones: ChartZone[] = [];
  const lines: ChartLine[] = [];
  const R = t.refs;
  const obFromTs = (): number => {
    const i = R.obIdx;
    return i != null && i >= 0 && i < candles.length ? candles[i].time : t.setupTime;
  };
  if (t.strategy === "ICT-OB" || t.strategy === "ICT-MITIGATION" || t.strategy === "ICT-BREAKER") {
    if (R.obHigh != null && R.obLow != null) {
      zones.push({
        top: R.obHigh, bottom: R.obLow, fromTs: obFromTs(), color: "gold",
        label: t.strategy === "ICT-OB" ? "ORDER BLOCK" : t.strategy === "ICT-BREAKER" ? (t.unicorn ? "BREAKER (UNICORN)" : "BREAKER") : "MITIGATION BLOCK",
      });
    }
    if (R.sweptLevel != null) lines.push({ price: R.sweptLevel, label: `SWEPT ${R.sweptLevel.toFixed(2)}` });
  } else if (t.strategy === "ICT-FVG") {
    if (R.gapLo != null && R.gapHi != null) {
      zones.push({ top: R.gapHi, bottom: R.gapLo, fromTs: t.setupTime, color: "blue", label: "FAIR VALUE GAP" });
    }
  } else if (t.strategy === "ICT-MSS") {
    if (R.legLo != null && R.legHi != null) {
      const leg = R.legHi - R.legLo;
      const zone: ChartZone = t.direction === "Long"
        ? { top: R.legHi - ICT_CONST.OTE_MIN_RETRACE * leg, bottom: R.legHi - ICT_CONST.OTE_MAX_RETRACE * leg, fromTs: t.setupTime, color: "purple", label: "OTE 62-79%" }
        : { top: R.legLo + ICT_CONST.OTE_MAX_RETRACE * leg, bottom: R.legLo + ICT_CONST.OTE_MIN_RETRACE * leg, fromTs: t.setupTime, color: "purple", label: "OTE 62-79%" };
      zones.push(zone);
    }
    if (R.sweptLevel != null) lines.push({ price: R.sweptLevel, label: `SWEPT ${R.sweptLevel.toFixed(2)}` });
  } else if (t.strategy === "ICT-SWEEP") {
    if (R.sweptLevel != null) lines.push({ price: R.sweptLevel, label: `SWEPT ${R.sweptLevel.toFixed(2)}` });
  } else if (t.strategy === "ICT-CE") {
    const wick = R.wickLow ?? R.wickHigh;
    if (wick != null) lines.push({ price: wick, label: `WICK ${wick.toFixed(2)}` });
  }
  return { zones, lines };
}

function renderAllTradeCharts(trades: TradeRow[], L: Loaded): void {
  const base = path.join(ROOT, CHART_DIR);
  for (const iv of INTERVALS) fs.mkdirSync(path.join(base, iv), { recursive: true });
  const ivTimes = {} as Record<Iv, number[]>;
  for (const iv of INTERVALS) ivTimes[iv] = L.candlesByIv[iv].map(c => c.time);
  const toRender = trades.filter(t => t.dateET >= CHART_FROM_KEY).length;
  console.log(`[ict-bt] trade charts: coverage ${CHART_FROM_KEY} -> present = ${toRender} of ${trades.length} trades`);
  let done = 0, total = 0;
  for (const t of trades) {
    if (t.dateET < CHART_FROM_KEY) { delete t.chartPath; continue; }
    const candles = L.candlesByIv[t.interval];
    const { zones, lines } = chartStructuresOf(t, candles);
    const buf = renderTradeChart({
      candles, ivTimes: ivTimes[t.interval], barSec: IV_SEC[t.interval], interval: t.interval,
      direction: t.direction, fireTs: t.setupTime, entryTs: t.entryTs, exitTs: t.exitTs,
      entry: t.entry, tp1: t.tp1, tp2: t.tp2, sl: t.sl,
      exitPrice: t.exitPrice, pointsResult: t.pointsResult,
      dateET: t.dateET, timeET: t.timeET,
      titleType: ICT_DISPLAY[t.strategy] + (t.unicorn ? " — Unicorn" : ""),
      outcomeText: OUTCOME_TXT[t.outcome],
      why: t.why, zones, lines,
    });
    const fname = `${t.dateET}_${t.timeET.replace(":", "")}_${t.direction}_${String(t.seq).padStart(6, "0")}.png`;
    const rel = `${CHART_DIR}/${t.interval}/${fname}`;
    fs.writeFileSync(path.join(ROOT, rel), buf);
    t.chartPath = rel;
    total += buf.length;
    if (++done % 250 === 0) console.log(`[ict-bt] trade charts: ${done}/${toRender}  ${elapsed()}`);
  }
  console.log(`[ict-bt] trade charts: ${done} PNGs, ${(total / 1e6).toFixed(1)} MB total  ${elapsed()}`);
}

// ==================== THE RUN (PHASES B..E) ====================

function runAll(): ResultsDoc {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();

  // ── PHASE B: engine per interval ──
  const setupsByIv = {} as Record<Iv, IctSetup[]>;
  const setupCounts: Record<string, number> = {};
  for (const iv of INTERVALS) {
    setupsByIv[iv] = runIctEngine({ candles: L.candlesByIv[iv], interval: iv, barSec: IV_SEC[iv], levels: L.levels });
    for (const s of setupsByIv[iv]) {
      const k = `${s.strategy}@${iv}`;
      setupCounts[k] = (setupCounts[k] ?? 0) + 1;
    }
    console.log(`[ict-bt] engine ${iv}: ${setupsByIv[iv].length} setups  ${elapsed()}`);
  }

  // ── PHASE C: fills + exits on 1m ──
  interface Cand { setup: IctSetup; res: Resolved }
  const candidates: Cand[] = [];
  const fillFailures: RunMeta["fillFailures"] = {};
  const failsOf = (k: string): { expired: number; invalid: number; blocked: number } => {
    let f = fillFailures[k];
    if (!f) { f = { expired: 0, invalid: 0, blocked: 0 }; fillFailures[k] = f; }
    return f;
  };
  for (const iv of INTERVALS) {
    for (const s of setupsByIv[iv]) {
      const k = `${s.strategy}@${iv}`;
      const fr = resolveFill(s, L);
      if (!fr.fill) { failsOf(k)[fr.fail!]++; continue; }
      const w = walkExit(s, fr.fill.entryTs, fr.fill.fillIdx, L, nowSec);
      candidates.push({
        setup: s,
        res: {
          entryTs: fr.fill.entryTs, entry: s.entry, fillIdx: fr.fill.fillIdx,
          barsToFill: rnd2((fr.fill.entryTs - s.barCloseTs) / IV_SEC[iv]),
          ...w,
        },
      });
    }
  }
  console.log(`[ict-bt] fills resolved: ${candidates.length} candidates  ${elapsed()}`);

  // ── PHASE D: one open trade per strategy per interval (accept chronologically by fill) ──
  candidates.sort((a, b) => a.res.entryTs - b.res.entryTs || a.setup.setupIdx - b.setup.setupIdx);
  const lastExit = new Map<string, number>();
  const trades: TradeRow[] = [];
  let seq = 0;
  for (const { setup: s, res } of candidates) {
    const k = `${s.strategy}@${s.interval}`;
    const le = lastExit.get(k);
    if (le !== undefined && res.entryTs < le) { failsOf(k).blocked++; continue; }
    lastExit.set(k, res.exitTs == null ? Infinity : res.exitTs);
    const p = etParts(res.entryTs);
    const dateET = `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
    trades.push({
      seq: seq++,
      strategy: s.strategy, interval: s.interval as Iv, direction: s.direction,
      setupIdx: s.setupIdx, setupTime: s.setupTime,
      signalTimeET: fmtEt(s.barCloseTs),
      entryTs: res.entryTs, dateET, timeET: `${pad2(p.hh)}:${pad2(p.mm)}`,
      weekday: WEEKDAY_NAMES[weekdayOfKey(dateET)],
      session: isRTH(res.entryTs) ? "RTH" : "ETH",
      killZone: killZoneOf(res.entryTs),
      entry: res.entry, sl: s.stop, tp1: s.tp1, tp2: s.tp2,
      why: s.why,
      exitPlan: `TP1 ${Math.abs(s.tp1 - s.entry).toFixed(2)} @ ${s.tp1.toFixed(2)} (${s.tp1Anchor}), SL ${Math.abs(s.stop - s.entry).toFixed(2)} @ ${s.stop.toFixed(2)} (${s.slAnchor}), TP2 ${Math.abs(s.tp2 - s.entry).toFixed(2)} @ ${s.tp2.toFixed(2)} (${s.tp2Anchor})`,
      confluence: "",
      outcome: res.outcome,
      exitPrice: res.exitPrice == null ? null : rnd2(res.exitPrice),
      exitTs: res.exitTs,
      exitTimeET: res.exitTs == null ? "" : fmtEt(res.exitTs),
      pointsResult: res.exitPrice == null ? null : rnd2((res.exitPrice - res.entry) * (s.direction === "Long" ? 1 : -1)),
      mae: res.mae, mfe: res.mfe,
      barsToFill: res.barsToFill,
      barsToExit: res.exitTs == null ? null : Math.round(((res.exitTs - res.entryTs) / IV_SEC[s.interval as Iv]) * 100) / 100,
      unicorn: s.unicorn === true,
      refs: s.refs,
    });
  }
  console.log(`[ict-bt] accepted trades: ${trades.length} (one open per strategy per interval)  ${elapsed()}`);

  // ── per-trade chart PNGs for the past-month coverage window (stamps chartPath) ──
  renderAllTradeCharts(trades, L);

  // ── PHASE E1: ICT+ICT combos (same interval + direction, setups within 3 bars, combo = the later trade) ──
  const combosIctIct: ComboRow[] = [];
  for (const iv of INTERVALS) {
    const ivTrades = trades.filter(t => t.interval === iv).sort((a, b) => a.setupIdx - b.setupIdx);
    for (let i = 0; i < ivTrades.length; i++) {
      const T = ivTrades[i];
      const partners: TradeRow[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const P = ivTrades[j];
        if (T.setupIdx - P.setupIdx > ICT_CONST.CONFLUENCE_WINDOW_BARS) break;
        if (P.direction === T.direction && P.strategy !== T.strategy) partners.push(P);
      }
      // same-bar partners sit earlier in the (stable-sorted) array, so each pair counts exactly once
      if (!partners.length) continue;
      const names = [...new Set([T.strategy, ...partners.map(p => p.strategy)])].sort();
      const comboKey = names.map(n => ICT_SHORT[n]).join(" + ");
      const conf = partners.map(p => `${ICT_DISPLAY[p.strategy]} (${p.setupIdx === T.setupIdx ? "same bar" : `${T.setupIdx - p.setupIdx} bar(s) earlier`})`).join("; ");
      if (!T.confluence.includes(conf)) T.confluence = T.confluence ? `${T.confluence}; ${conf}` : conf;
      combosIctIct.push({ ...T, confluence: conf, comboKey });
    }
  }
  console.log(`[ict-bt] ICT+ICT combo trades: ${combosIctIct.length}  ${elapsed()}`);

  // ── PHASE E2: ICT × existing engine (read-only from the fact-engine results JSON) ──
  const combosIctExisting: ComboRow[] = [];
  let existingSource = "fact-engine-backtest-results.json NOT FOUND — ICT × existing sheets skipped";
  let existingMatched = 0;
  if (fs.existsSync(EXISTING_JSON)) {
    const doc = JSON.parse(fs.readFileSync(EXISTING_JSON, "utf8")) as {
      meta?: { generatedAt?: string; gatedTotal?: number };
      signals: Array<{ fireTs: number; interval: string; direction: string; signalType: string }>;
    };
    existingSource = `fact-engine-backtest-results.json (generated ${doc.meta?.generatedAt ?? "?"}, ${doc.signals.length} quality-gated trades)`;
    const byGroup = new Map<string, number[]>();          // iv|dir|signalType → sorted fireTs
    for (const e of doc.signals) {
      if (!INTERVALS.includes(e.interval as Iv)) continue;
      const g = `${e.interval}|${e.direction}|${e.signalType}`;
      let a = byGroup.get(g); if (!a) { a = []; byGroup.set(g, a); }
      a.push(e.fireTs);
    }
    for (const a of byGroup.values()) a.sort((x, y) => x - y);
    for (const T of trades) {
      const win = ICT_CONST.CONFLUENCE_WINDOW_BARS * IV_SEC[T.interval];
      for (const [g, times] of byGroup) {
        const [iv, dir, st] = g.split("|");
        if (iv !== T.interval || dir !== T.direction) continue;
        // any existing fire within ±window of the ICT signal bar?
        let lo = 0, hi = times.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < T.setupTime - win) lo = mid + 1; else hi = mid; }
        if (lo < times.length && times[lo] <= T.setupTime + win) {
          existingMatched++;
          const short = EXISTING_SHORT[st] ?? st;
          const comboKey = `${ICT_SHORT[T.strategy]} × ${short}`;
          const conf = `${displaySignalType(st)} fired within ${ICT_CONST.CONFLUENCE_WINDOW_BARS} bars`;
          T.confluence = T.confluence ? `${T.confluence}; ${conf}` : conf;
          combosIctExisting.push({ ...T, confluence: conf, comboKey });
        }
      }
    }
    console.log(`[ict-bt] ICT × existing combo trades: ${combosIctExisting.length}  ${elapsed()}`);
  } else {
    console.log(`[ict-bt] !! ${EXISTING_JSON} not found — ICT × existing combos skipped`);
  }

  // ── strategy headline stats (solo + kill-zone-filtered) ──
  const strategyStats: RunMeta["strategyStats"] = [];
  for (const st of ICT_STRATEGIES) {
    const rows = trades.filter(t => t.strategy === st);
    if (!rows.length) { strategyStats.push({ strategy: st, display: ICT_DISPLAY[st], n: 0, winRate: 0, expectancy: 0, pf: 0, cumPts: 0, kzN: 0, kzWinRate: 0, kzExpectancy: 0, kzPf: 0 }); continue; }
    const m = metricsOf(rows);
    const kz = metricsOf(rows.filter(r => isKz(r.killZone)));
    strategyStats.push({
      strategy: st, display: ICT_DISPLAY[st], n: m.count, winRate: rnd2(m.winRate), expectancy: m.expectancy,
      pf: m.profitFactor, cumPts: m.cumPts, kzN: kz.count, kzWinRate: rnd2(kz.winRate), kzExpectancy: kz.expectancy, kzPf: kz.profitFactor,
    });
  }

  const meta: RunMeta = {
    symbol: SYMBOL,
    generatedAt: new Date().toISOString(),
    runtimeSec: rnd2((Date.now() - t0) / 1000),
    smoke: SMOKE,
    dataSpan: L.dataSpan,
    lastDataTs: L.lastDataTs,
    constants: ICT_CONST,
    knownBadBarPresent: L.knownBadBarPresent,
    setupCounts,
    fillFailures,
    strategyStats,
    existingSource,
    existingMatched,
  };
  return { meta, trades, combosIctIct, combosIctExisting };
}

// ==================== CONSOLE REPORT + SANITY ====================

function printReport(doc: ResultsDoc): void {
  const { meta, trades, combosIctIct, combosIctExisting } = doc;
  console.log(`\n=== ICT BACKTEST — ${meta.symbol} — ${trades.length} accepted trades ===`);
  console.log("strategy                        |     n |  win% |  expcy |    PF |  kz-n | kz-win% | kz-expcy | kz-PF");
  for (const s of meta.strategyStats) {
    console.log(
      `${s.display.padEnd(31)} | ${String(s.n).padStart(5)} | ${(s.winRate * 100).toFixed(1).padStart(5)} | ${s.expectancy.toFixed(2).padStart(6)} | ${s.pf.toFixed(2).padStart(5)}`
      + ` | ${String(s.kzN).padStart(5)} | ${(s.kzWinRate * 100).toFixed(1).padStart(7)} | ${s.kzExpectancy.toFixed(2).padStart(8)} | ${s.kzPf.toFixed(2).padStart(5)}`);
  }
  const comboAgg = (rows: ComboRow[], label: string): void => {
    const keys = [...new Set(rows.map(r => r.comboKey))];
    const stats = keys.map(k => ({ k, m: metricsOf(rows.filter(r => r.comboKey === k)) }))
      .sort((a, b) => b.m.expectancy - a.m.expectancy);
    console.log(`\n--- ${label} (${keys.length} distinct combos) ---`);
    for (const { k, m } of stats) {
      console.log(`${k.padEnd(38)} | n=${String(m.count).padStart(4)} | win% ${(m.winRate * 100).toFixed(1).padStart(5)} | expcy ${m.expectancy.toFixed(2).padStart(6)} | PF ${m.profitFactor.toFixed(2)}`);
    }
  };
  comboAgg(combosIctIct, "ICT + ICT combos");
  comboAgg(combosIctExisting, "ICT × existing combos");

  // 3 random trades, full lifecycle, seeded (auditable — includes the engine's raw refs)
  let seedState = 20260715 >>> 0;
  const rand = (): number => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 2 ** 32; };
  console.log("\n--- 3 RANDOM TRADES (sanity audit) ---");
  for (let i = 0; i < 3 && trades.length; i++) {
    const tr = trades[Math.floor(rand() * trades.length)];
    console.log(`\n#${tr.seq} ${ICT_DISPLAY[tr.strategy]} ${tr.direction} @${tr.interval} — signal ${tr.signalTimeET} ET, filled ${tr.dateET} ${tr.timeET} ET (${tr.barsToFill} bars later)`);
    console.log(`  session ${tr.session}, kill zone ${tr.killZone}, weekday ${tr.weekday}${tr.unicorn ? ", UNICORN" : ""}`);
    console.log(`  WHY: ${tr.why}`);
    console.log(`  PLAN: ${tr.exitPlan}`);
    console.log(`  OUTCOME: ${displayOutcome(tr.outcome)} at ${tr.exitPrice ?? "—"} (${tr.exitTimeET || "still open"}), P&L ${tr.pointsResult ?? "—"} pts, MAE ${tr.mae}, MFE ${tr.mfe}, ${tr.barsToExit ?? "—"} bars`);
    console.log(`  CHART CONTEXT (engine refs): ${JSON.stringify(tr.refs)}`);
  }
}

// ==================== THE WORKBOOK (PHASE F) ====================

const FONT = { name: "Arial", size: 10 } as const;
const FONT_BOLD = { name: "Arial", size: 10, bold: true } as const;
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const SECTION_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
const FMT_COUNT = '#,##0;-#,##0;"-"';
const FMT_PTS = '+#,##0.00;(#,##0.00);"-"';
const FMT_PRICE = "0.00";
const FMT_PCT = '0.0%;-0.0%;"-"';
const FMT_NUM2 = '#,##0.00;(#,##0.00);"-"';
const FMT_PF = '0.00;-0.00;"-"';

const OUTCOME_TXT: Record<Outcome, string> = {
  tp1: displayOutcome("tp1"), tp2: displayOutcome("tp2"), sl: displayOutcome("sl"),
  eod: displayOutcome("eod"), open: displayOutcome("open"),
};

function colL(n: number): string {
  let s = "";
  while (n > 0) { const md = (n - 1) % 26; s = String.fromCharCode(65 + md) + s; n = (n - md - 1) / 26; }
  return s;
}

interface SheetOpts {
  title: string;
  note?: string;
  /** Add the CHART column (relative VIEW CHART hyperlink) + embed the PNG in-row for
   *  every charted trade (past-month coverage window). All ICT Trades only. */
  chartLinks?: boolean;
}
let LAST_EMBED_COUNT = 0; // reported by the All ICT Trades build

/** Trade sheet with a two-row stats header: ALL trades + the kill-zone-filtered variant.
 *  All stats are real COUNTIFS/SUMIFS formulas with cached results (Max DD = JS literal). */
function addTradeSheet(wb: ExcelJS.Workbook, name: string, rowsIn: TradeRow[], opts: SheetOpts): ExcelJS.Worksheet {
  let rows = rowsIn;
  let capNote = "";
  if (rows.length > SHEET_ROW_CAP) {
    capNote = ` SHOWING THE MOST RECENT ${SHEET_ROW_CAP.toLocaleString()} OF ${rows.length.toLocaleString()} TRADES (stats cover the SHOWN rows).`;
    rows = rows.slice(rows.length - SHEET_ROW_CAP);
  }
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 6 }] });
  const m = metricsOf(rows);
  const kzRows = rows.filter(r => isKz(r.killZone));
  const km = metricsOf(kzRows);

  const COLS: Array<{ h: string; w: number; fmt?: string; get: (r: TradeRow, i: number) => string | number | null }> = [
    { h: "#", w: 7, fmt: "0", get: (_r, i) => i + 1 },
    { h: "date ET", w: 11, get: r => r.dateET },
    { h: "time ET", w: 8, get: r => r.timeET },
    { h: "signal time ET", w: 16, get: r => r.signalTimeET },
    { h: "weekday", w: 9, get: r => r.weekday },
    { h: "session", w: 8, get: r => r.session },
    { h: "kill zone", w: 20, get: r => r.killZone },
    { h: "interval", w: 8, get: r => r.interval },
    { h: "strategy", w: 26, get: r => ICT_DISPLAY[r.strategy] + (r.unicorn ? " — Unicorn" : "") },
    { h: "direction", w: 9, get: r => r.direction },
    { h: "WHY IT FIRED", w: 90, get: r => r.why },
    { h: "agreeing with", w: 44, get: r => r.confluence || "—" },
    { h: "entry", w: 9, fmt: FMT_PRICE, get: r => r.entry },
    { h: "sl", w: 9, fmt: FMT_PRICE, get: r => r.sl },
    { h: "tp1", w: 9, fmt: FMT_PRICE, get: r => r.tp1 },
    { h: "tp2", w: 9, fmt: FMT_PRICE, get: r => r.tp2 },
    { h: "EXIT STRATEGY", w: 80, get: r => r.exitPlan },
    { h: "WON?", w: 22, get: r => OUTCOME_TXT[r.outcome] },
    { h: "P&L points", w: 11, fmt: FMT_PTS, get: r => r.pointsResult },
    { h: "MAE", w: 8, fmt: FMT_NUM2, get: r => r.mae },
    { h: "MFE", w: 8, fmt: FMT_NUM2, get: r => r.mfe },
    { h: "bars to fill", w: 10, fmt: "#,##0.00", get: r => r.barsToFill },
    { h: "bars to exit", w: 11, fmt: "#,##0.00", get: r => r.barsToExit },
  ];
  if (opts.chartLinks) COLS.push({ h: "CHART", w: 13, get: () => null }); // value set per-row below (HYPERLINK)
  ws.columns = COLS.map(c => ({ width: c.w }));

  const HEADER_ROW = 6;
  const dataFrom = HEADER_ROW + 1;
  const lastRow = HEADER_ROW + rows.length;
  const kzCol = "G", wonCol = "R", ptsCol = "S";
  const range = (c: string): string => `$${c}$${dataFrom}:$${c}$${Math.max(dataFrom, lastRow)}`;

  { // title
    const row = ws.getRow(1);
    const cell = row.getCell(1);
    cell.value = opts.title + capNote;
    cell.font = { name: "Arial", size: 12, bold: true };
    for (let i = 1; i <= COLS.length; i++) row.getCell(i).fill = SECTION_FILL;
  }
  { // stats labels
    const lr = ws.getRow(2);
    const labels = ["Trades", "Wins @T1", "Wins @T2", "Stopped out", "Session end", "Still open", "Win rate", "Expectancy pts", "Cum pts", "Profit factor", "Max DD pts*", "Scope"];
    labels.forEach((h, i) => {
      const cell = lr.getCell(1 + i);
      cell.value = h;
      cell.font = { ...FONT_BOLD, color: { argb: "FFFFFFFF" } };
      cell.fill = HEADER_FILL;
    });
  }
  const putRow = (rowNo: number, mm: Metrics, scope: string, kzOnly: boolean): void => {
    const vr = ws.getRow(rowNo);
    const put = (col: number, v: number | string, fmt?: string, formula?: string): void => {
      const cell = vr.getCell(col);
      cell.value = formula ? ({ formula, result: v } as ExcelJS.CellFormulaValue) : v;
      cell.font = FONT;
      if (fmt) cell.numFmt = fmt;
    };
    const hasRows = rows.length > 0;
    const closed = mm.count - mm.open;
    // formula fragments — ALL rows vs the two kill-zone texts ("London" + "NY-AM*")
    const cnt = (outTxt?: string): string => kzOnly
      ? `COUNTIFS(${range(kzCol)},"London"${outTxt ? `,${range(wonCol)},"${outTxt}"` : ""})+COUNTIFS(${range(kzCol)},"NY-AM*"${outTxt ? `,${range(wonCol)},"${outTxt}"` : ""})`
      : outTxt ? `COUNTIFS(${range(wonCol)},"${outTxt}")` : `COUNTIFS(${range("A")},">0")`;
    const sum = (crit?: string): string => kzOnly
      ? `SUMIFS(${range(ptsCol)},${range(kzCol)},"London"${crit ? `,${range(ptsCol)},"${crit}"` : ""})+SUMIFS(${range(ptsCol)},${range(kzCol)},"NY-AM*"${crit ? `,${range(ptsCol)},"${crit}"` : ""})`
      : crit ? `SUMIFS(${range(ptsCol)},${range(ptsCol)},"${crit}")` : `SUM(${range(ptsCol)})`;
    put(1, mm.count, FMT_COUNT, hasRows ? cnt() : undefined);
    put(2, mm.tp1, FMT_COUNT, hasRows ? cnt(OUTCOME_TXT.tp1) : undefined);
    put(3, mm.tp2, FMT_COUNT, hasRows ? cnt(OUTCOME_TXT.tp2) : undefined);
    put(4, mm.losses, FMT_COUNT, hasRows ? cnt(OUTCOME_TXT.sl) : undefined);
    put(5, mm.eod, FMT_COUNT, hasRows ? cnt(OUTCOME_TXT.eod) : undefined);
    put(6, mm.open, FMT_COUNT, hasRows ? cnt(OUTCOME_TXT.open) : undefined);
    put(7, mm.winRate, FMT_PCT, closed > 0 ? `(B${rowNo}+C${rowNo})/(A${rowNo}-F${rowNo})` : undefined);
    put(8, mm.expectancy, FMT_PTS, closed > 0 ? `I${rowNo}/(A${rowNo}-F${rowNo})` : undefined);
    put(9, mm.cumPts, FMT_PTS, hasRows ? sum() : undefined);
    const hasLoss = (kzOnly ? kzRows : rows).some(r => (r.pointsResult ?? 0) < 0);
    put(10, mm.profitFactor, FMT_PF, hasLoss ? `(${sum(">0")})/-(${sum("<0")})` : undefined);
    put(11, mm.maxDD, FMT_NUM2); // JS literal — sequencing not expressible in COUNTIFS/SUMIFS
    put(12, scope);
    vr.getCell(12).font = FONT_BOLD;
  };
  putRow(3, m, "ALL HOURS", false);
  putRow(4, km, "KILL ZONES ONLY (London + NY-AM)", true);
  { // note
    const cell = ws.getRow(5).getCell(1);
    cell.value = (opts.note ?? "") + "  * Max DD pts is JS-computed over the sheet's chronological closed-trade sequence — not expressible with COUNTIFS/SUMIFS. Row 4 repeats every stat for entries inside the London (02:00-05:00 ET) or NY-AM (08:30-11:00 ET) kill zones — reported for comparison, NOT a filter on the trade list.";
    cell.font = { ...FONT, italic: true };
  }
  { // column headers
    const hr = ws.getRow(HEADER_ROW);
    COLS.forEach((c, i) => {
      const cell = hr.getCell(i + 1);
      cell.value = c.h;
      cell.font = { ...FONT_BOLD, color: { argb: "FFFFFFFF" } };
      cell.fill = HEADER_FILL;
      cell.alignment = { vertical: "middle" };
    });
  }
  const chartColIdx = opts.chartLinks ? COLS.length : 0; // 1-based (CHART is the last column)
  let embeds = 0;
  rows.forEach((r, i) => {
    const row = ws.getRow(dataFrom + i);
    COLS.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = c.get(r, i);
      cell.font = FONT;
      if (c.fmt) cell.numFmt = c.fmt;
    });
    if (opts.chartLinks) {
      // CHART hyperlink — RELATIVE path (backslashes for Excel) so it resolves as long as the
      // ict-trade-charts folder sits next to the workbook. Rows before CHART_FROM_KEY show "—".
      const cell = row.getCell(chartColIdx);
      if (r.chartPath) {
        cell.value = {
          formula: `HYPERLINK("${r.chartPath.replace(/\//g, "\\")}","VIEW CHART")`,
          result: "VIEW CHART",
        } as ExcelJS.CellFormulaValue;
        cell.font = { ...FONT, color: { argb: "FF2E75B6" }, underline: true };
        // In-row embed: the PNG itself, in a tall row at the far right (past-month coverage).
        const abs = path.join(ROOT, r.chartPath);
        if (fs.existsSync(abs)) {
          const imgId = wb.addImage({ buffer: fs.readFileSync(abs) as unknown as ExcelJS.Buffer, extension: "png" });
          ws.addImage(imgId, { tl: { col: COLS.length + 0.2, row: dataFrom + i - 1 }, ext: { width: 800, height: 450 } });
          row.height = 342; // 450 px ≈ 342 pt — row sized to the image
          embeds++;
        }
      } else {
        cell.value = "—";
        cell.font = { ...FONT, color: { argb: "FF9AA4B2" } };
        cell.alignment = { horizontal: "center" };
      }
    }
  });
  if (opts.chartLinks) {
    LAST_EMBED_COUNT = embeds;
    console.log(`[ict-bt] ${name}: embedded ${embeds} in-row trade charts (${CHART_FROM_KEY} -> present)`);
  }
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: Math.max(HEADER_ROW, lastRow), column: COLS.length } };
  return ws;
}

/** Extra-tight strategy codes used only when a combo tab name would exceed Excel's 31 chars. */
const ICT_TIGHT: Record<string, string> = {
  OB: "OB", FVG: "FVG", Breaker: "Brkr", Sweep: "Swp", "MSS-OTE": "MSS", "Wick CE": "CE", Mitigation: "Mit",
};
function safeSheetName(name: string, used: Set<string>): string {
  let n = name;
  if (n.length > 31 && n.includes(" + ")) {
    n = n.split(" + ").map(p => ICT_TIGHT[p] ?? p).join("+"); // e.g. "Brkr+CE+FVG+Mit+MSS+OB+Swp"
  }
  n = n.slice(0, 31).replace(/[[\]*?/\\:]/g, "-").replace(/[\s.]+$/, "");
  let suffix = 2;
  const base = n;
  while (used.has(n)) n = `${base.slice(0, 31 - String(suffix).length - 1)} ${suffix++}`.replace(/[\s.]+$/, "");
  used.add(n);
  return n;
}

async function buildWorkbook(doc: ResultsDoc): Promise<void> {
  const { meta, trades, combosIctIct, combosIctExisting } = doc;
  const wb = new ExcelJS.Workbook();
  wb.creator = "ict-backtest";
  const used = new Set<string>();
  const orderedNames: string[] = [];
  /** Comparison rows: [display, kind, sheetName|null, rows] — sheet cells referenced when a sheet exists. */
  const comparison: Array<{ display: string; kind: string; sheet: string | null; rows: TradeRow[] }> = [];

  // ── 2: All ICT Trades ──
  {
    const n = safeSheetName("All ICT Trades", used);
    addTradeSheet(wb, n, trades, {
      title: `ALL ICT TRADES — ${meta.symbol} — every strategy, 5m/15m/60m, full history — walk-forward on 1m bars`,
      note: `Every accepted ICT trade (one open trade per strategy per interval; limit setups that never filled or were invalidated are not trades). Entries: limit fills AT the level inside a 30-bar retest window, or at the signal close for Liquidity Sweeps. Exits: stop-first on same-bar ambiguity, force-close at the 17:00 ET settle. The 'agreeing with' column lists same-window signals from other strategies and from the existing engine (annotation only — the trade itself is unchanged). CHART: trades from ${CHART_FROM_KEY} on have a VIEW CHART link AND the image embedded in-row at the far right (keep the ${CHART_DIR} folder next to this file); older rows show —.`,
      chartLinks: true,
    });
    orderedNames.push(n);
  }

  // ── 3+: one sheet per strategy solo (+ Unicorn if distinct) ──
  for (const st of ICT_STRATEGIES) {
    const rows = trades.filter(t => t.strategy === st);
    const n = safeSheetName(ICT_DISPLAY[st], used);
    addTradeSheet(wb, n, rows, {
      title: `${ICT_DISPLAY[st].toUpperCase()} — traded solo, every interval (5m/15m/60m), RTH + ETH`,
      note: rows.length ? "Subset of All ICT Trades (same fills, exits and acceptance rules)." : "No trades — the pattern's full mechanical conditions never lined up with a fill in this data.",
    });
    orderedNames.push(n);
    comparison.push({ display: ICT_DISPLAY[st], kind: "ICT solo", sheet: n, rows });
  }
  {
    const uniRows = trades.filter(t => t.unicorn);
    if (uniRows.length) {
      const n = safeSheetName("ICT Unicorn", used);
      addTradeSheet(wb, n, uniRows, {
        title: "ICT UNICORN — breaker trades whose zone overlaps a same-direction fair value gap (the article's higher-odds combination)",
        note: "Subset of the ICT Breaker sheet (every unicorn is a breaker; the flag marks the FVG overlap).",
      });
      orderedNames.push(n);
      comparison.push({ display: "ICT Unicorn (Breaker + Gap)", kind: "ICT solo", sheet: n, rows: uniRows });
    }
  }

  // ── ICT+ICT combo sheets (n >= COMBO_MIN_N), then ICT × existing, then Rare Combos ──
  const rare: ComboRow[] = [];
  const comboBlock = (rows: ComboRow[], kind: string, titleOf: (k: string) => string): void => {
    const keys = [...new Set(rows.map(r => r.comboKey))];
    keys.sort((a, b) => rows.filter(r => r.comboKey === b).length - rows.filter(r => r.comboKey === a).length);
    for (const k of keys) {
      const sub = rows.filter(r => r.comboKey === k);
      if (sub.length < COMBO_MIN_N) { rare.push(...sub); comparison.push({ display: k, kind: `${kind} (rare)`, sheet: null, rows: sub }); continue; }
      const n = safeSheetName(k, used);
      addTradeSheet(wb, n, sub, {
        title: titleOf(k),
        note: `Combo per the house rule: same direction within ${ICT_CONST.CONFLUENCE_WINDOW_BARS} bars on the same interval; the combo trade IS the later signal's trade (its entry, stops and targets). n >= ${COMBO_MIN_N} combos get their own sheet; smaller ones roll into Rare Combos.`,
      });
      orderedNames.push(n);
      comparison.push({ display: k, kind, sheet: n, rows: sub });
    }
  };
  comboBlock(combosIctIct, "ICT + ICT",
    k => `ICT COMBO: ${k} — two or more ICT strategies agreed (same direction, within ${ICT_CONST.CONFLUENCE_WINDOW_BARS} bars, same interval)`);
  comboBlock(combosIctExisting, "ICT × existing",
    k => `ICT × EXISTING ENGINE: ${k} — the ICT trade taken only when the existing engine fired the same direction within ${ICT_CONST.CONFLUENCE_WINDOW_BARS} bars (analysis pairing — no live engine changes)`);
  {
    const n = safeSheetName("Rare Combos", used);
    addTradeSheet(wb, n, rare, {
      title: `RARE COMBOS — every observed combination with fewer than ${COMBO_MIN_N} trades, pooled`,
      note: "Each row's 'agreeing with' column names its combo. Individual rare combos are listed (with their own stats) on the Comparison sheet.",
    });
    orderedNames.push(n);
  }

  // ── Comparison sheet: every solo strategy + combo class ranked by expectancy ──
  {
    const ws = wb.addWorksheet(safeSheetName("Comparison", used));
    orderedNames.push("Comparison");
    ws.columns = [{ width: 6 }, { width: 42 }, { width: 16 }, { width: 9 }, { width: 10 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 9 }, { width: 14 }, { width: 12 }];
    const tr = ws.getRow(1); const tc = tr.getCell(1);
    tc.value = "COMPARISON — every ICT strategy and combo class, ranked by expectancy (pts/trade). Formulas reference each class's own sheet; rare combos are JS-computed literals.";
    tc.font = { name: "Arial", size: 12, bold: true };
    for (let i = 1; i <= 12; i++) tr.getCell(i).fill = SECTION_FILL;
    const hr = ws.getRow(2);
    ["rank", "class", "kind", "n", "win rate", "expectancy pts", "profit factor", "cum pts", "max DD pts", "KZ n", "KZ expectancy", "KZ PF"].forEach((h, i) => {
      const cell = hr.getCell(i + 1);
      cell.value = h; cell.font = { ...FONT_BOLD, color: { argb: "FFFFFFFF" } }; cell.fill = HEADER_FILL;
    });
    const ranked = comparison
      .map(c => ({ ...c, m: metricsOf(c.rows), km: metricsOf(c.rows.filter(r => isKz(r.killZone))) }))
      // classes with a real sample (n >= COMBO_MIN_N) rank first; tiny rare combos below them
      .sort((a, b) => (a.m.count >= COMBO_MIN_N ? 0 : 1) - (b.m.count >= COMBO_MIN_N ? 0 : 1) || b.m.expectancy - a.m.expectancy);
    ranked.forEach((c, i) => {
      const row = ws.getRow(3 + i);
      const put = (col: number, v: number | string | null, fmt?: string, formula?: string): void => {
        const cell = row.getCell(col);
        cell.value = formula ? ({ formula, result: v ?? 0 } as ExcelJS.CellFormulaValue) : v;
        cell.font = FONT;
        if (fmt) cell.numFmt = fmt;
      };
      const sheetRef = (cellAddr: string): string | undefined => (c.sheet ? `'${c.sheet}'!${cellAddr}` : undefined);
      put(1, i + 1, "0");
      put(2, c.display);
      put(3, c.kind);
      put(4, c.m.count, FMT_COUNT, sheetRef("A3"));
      put(5, c.m.winRate, FMT_PCT, sheetRef("G3"));
      put(6, c.m.expectancy, FMT_PTS, sheetRef("H3"));
      put(7, c.m.profitFactor, FMT_PF, sheetRef("J3"));
      put(8, c.m.cumPts, FMT_PTS, sheetRef("I3"));
      put(9, c.m.maxDD, FMT_NUM2, sheetRef("K3"));
      put(10, c.km.count, FMT_COUNT, sheetRef("A4"));
      put(11, c.km.expectancy, FMT_PTS, sheetRef("H4"));
      put(12, c.km.profitFactor, FMT_PF, sheetRef("J4"));
    });
    ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: Math.max(2, 2 + ranked.length), column: 12 } };
    ws.views = [{ state: "frozen", ySplit: 2 }];
  }

  // ── Sheet 1: README (created last, ordered first) ──
  buildReadme(wb, doc, safeSheetName("README", used));
  const finalOrder = ["README", ...orderedNames];
  finalOrder.forEach((name, i) => {
    const ws = wb.getWorksheet(name);
    if (ws) (ws as ExcelJS.Worksheet & { orderNo: number }).orderNo = i; // undocumented but honored by exceljs
  });

  // EBUSY resilience: the canonical file may be OPEN IN EXCEL. Fall back to .new.xlsx.
  try {
    await wb.xlsx.writeFile(OUT_XLSX);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EPERM") throw e;
    const fallback = OUT_XLSX.replace(/\.xlsx$/i, ".new.xlsx");
    console.error(`[ict-bt] !! ${path.basename(OUT_XLSX)} is locked (open in Excel?) — writing ${path.basename(fallback)} instead. Close Excel and rename it over the old file.`);
    await wb.xlsx.writeFile(fallback);
  }
}

function buildReadme(wb: ExcelJS.Workbook, doc: ResultsDoc, name: string): void {
  const { meta, trades, combosIctIct, combosIctExisting } = doc;
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [{ width: 36 }, { width: 170 }];
  let rn = 1;
  const title = (t: string): void => {
    const row = ws.getRow(rn++);
    const cell = row.getCell(1);
    cell.value = t;
    cell.font = { name: "Arial", size: 12, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    row.getCell(2).fill = HEADER_FILL;
  };
  const kv = (k: string, v: string): void => {
    const row = ws.getRow(rn++);
    row.getCell(1).value = k; row.getCell(1).font = FONT_BOLD; row.getCell(1).alignment = { vertical: "top" };
    row.getCell(2).value = v; row.getCell(2).font = FONT; row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  };
  const gap = (): void => { rn++; };
  const C = ICT_CONST;

  title("ICT STRATEGY BACKTEST — WHAT THIS WORKBOOK IS");
  kv("Source studied", "theicttrader.com (author Fadi Zeidan) — the five strategy articles: \"Introduction to ICT Trading\", \"Wicks Require Special Consideration\", \"Understanding Order Blocks\", \"Order Blocks, Breaker Blocks and Mitigation Blocks\", and \"ICT Balanced and Imbalanced Price Ranges\". The articles teach concepts; every rule below is the mechanical translation used here, with its exact thresholds.");
  kv("Generated", `${meta.generatedAt} by scripts/ict-backtest.ts (runtime ${meta.runtimeSec}s, symbol ${meta.symbol}${meta.smoke ? ", SMOKE RUN — partial data" : ""})`);
  kv("Decision model", "shared/ict-engine.ts — a standalone, unit-tested engine (42 tests incl. a no-lookahead truncation test). It is ANALYSIS ONLY: nothing here feeds the live signal engine.");
  kv("Scope", `Strategies run on 5m, 15m and 60m charts (1m is skipped — the prior fact-engine backtest showed 1m setups churn). Both market hours (RTH 9:30-17:00 ET) and overnight (ETH) are traded, with the session and kill-zone recorded per trade. Kill zones are CONTEXT: every sheet reports all-hours stats AND the London/NY-AM-only variant, but no trade is gated by them.`);
  kv("Headline", `${Object.values(meta.setupCounts).reduce((a, b) => a + b, 0).toLocaleString()} setups detected -> ${trades.length.toLocaleString()} accepted trades. ICT+ICT combo trades: ${combosIctIct.length.toLocaleString()}; ICT × existing-engine combo trades: ${combosIctExisting.length.toLocaleString()}.`);
  gap();

  title("THE SEVEN STRATEGIES — MECHANICAL RULES (exact thresholds)");
  kv("Shared building blocks", `Swing = fractal pivot: a high with ${C.SWING_N} strictly lower highs on EACH side (lows mirrored); a pivot is only usable ${C.SWING_N} bars later, once confirmed. Displacement = candle body > ${C.DISPLACEMENT_MULT}x the median body of the previous ${C.MEDIAN_LOOKBACK} bars (and > ${C.DISPLACEMENT_MIN_PTS} pts). Liquidity sweep = a wick trades beyond a resting level and the candle closes back on the original side.`);
  kv("ICT Order Block", `The last opposite-color candle before a displacement move that BOTH (a) swept a prior swing low/high within the preceding ${C.SWEEP_LOOKBACK_BARS} bars, AND (b) closed through the prior opposing swing (market structure shift). Entry: limit at the order-block candle's OPEN (the article's change-in-state-of-delivery level), first retest within ${C.RETEST_WINDOW_BARS} bars. Stop: 1 tick beyond the block's far extreme. Targets: TP1 = the CLOSER of the next opposing liquidity pool or ${C.TP_RR_CAP}R; TP2 = the pool itself (no pool in view -> TP1 ${C.TP_RR_CAP}R, TP2 ${C.TP2_FALLBACK_RR}R).`);
  kv("ICT Fair Value Gap", `Three-candle displacement gap (bullish: candle 1's high < candle 3's low, middle candle a displacement candle). Two 50% levels exist: the gap's own midpoint (consequent encroachment) and the 50% of the candle-2-high -> candle-1-low impulse (the wicks article's fib). Entry: limit at the SHALLOWER of the two (price reaches it first); the setup is INVALID if a 1-minute bar OPENS beyond the deeper one before the fill (price 'exceeded the 50%' without offering the entry). Stop: 1 tick beyond candle 1's extreme. Targets as Order Block.`);
  kv("ICT Breaker", `A high-probability Order Block that FAILS (a candle closes through its far side within ${C.OB_FAIL_WINDOW_BARS} bars of its birth) then gets retested from the other side. Trade the flip direction: limit back at the failed block's open, stop 1 tick beyond the block's far extreme in the new direction, targets as Order Block. Retest window ${C.RETEST_WINDOW_BARS} bars from the failure.`);
  kv("ICT Unicorn", `A Breaker whose zone overlaps a same-direction Fair Value Gap formed within ${C.UNICORN_FVG_LOOKBACK_BARS} bars — the article's higher-odds combination. Flagged on the Breaker trade and given its own sheet.`);
  kv("ICT Liquidity Sweep", `Turtle soup: a wick takes out a significant level — prior-day high/low, a completed session high/low (Asia 18:00-03:00, London 03:00-08:30, NY 08:30-17:00 ET), or a resting swing at least ${C.SWEEP_SWING_MIN_AGE_BARS} bars old — and the SAME or NEXT candle closes back beyond the level with displacement. Entry: market at that candle's close. Stop: 1 tick beyond the sweep extreme. TP2 = the opposite side of the swept range; TP1 = the CLOSER of the range midpoint or ${C.TP_RR_CAP}R.`);
  kv("ICT Structure Shift + OTE", `After a liquidity sweep (within ${C.SWEEP_LOOKBACK_BARS} bars), a displacement candle closes through the prior opposing swing. Entry: limit at the ${Math.round(C.OTE_MIN_RETRACE * 100)}% retracement of the sweep->displacement leg (the optimal-trade-entry zone is ${Math.round(C.OTE_MIN_RETRACE * 100)}-${Math.round(C.OTE_MAX_RETRACE * 100)}%; the limit sits at its shallow edge). Stop: 1 tick beyond the leg origin. Targets as Order Block.`);
  kv("ICT Wick Reversal (C.E.)", `A long-wick candle — wick >= ${C.CE_WICK_BODY_MULT}x its own body AND >= ${C.CE_WICK_RANGE_MULT}x the ${C.MEDIAN_LOOKBACK}-bar median range — at/near a pivot (a fresh ${C.CE_PIVOT_LOOKBACK_BARS}-bar extreme, or within ${C.CE_PIVOT_TOL_PTS} pts of a resting swing). Entry: limit at the wick's 50% (its consequent encroachment) on retest. Stop: 1 tick beyond the wick extreme (per the article, a breach of the C.E. by more than the remaining half invalidates the idea — the wick extreme IS that boundary). TP1 = ${C.TP_RR_CAP}R or the opposing swing, whichever is closer.`);
  kv("ICT Mitigation Block", `The article's LOWER-probability block: an order-block candle before a displacement move that is missing at least one of the two high-probability qualifiers (the sweep or the structure shift). Traded exactly like the Order Block so the data can judge it. Order Block and Mitigation Block are mutually exclusive by construction.`);
  gap();

  title("EXECUTION MODEL");
  kv("Signals vs trades", `The engine emits SETUPS at bar close. Limit setups become trades only if price retests the level within ${C.RETEST_WINDOW_BARS} bars (fills resolved on 1-minute bars, AT the limit level — a gap through the level still fills at the level, never better). Sweep entries are market orders at the signal close.`);
  kv("Exits", "Resolved on 1-minute bars: stop checked FIRST on same-bar ambiguity (never over-reports a win), TP2 before TP1, force-close at the 17:00 ET session settle. No overnight holds past the settle.");
  kv("One trade at a time", `Per strategy per interval: while a trade is open, new fills for that strategy on that interval are skipped (counted under 'blocked'). Signal cooldown inside the engine: ${C.COOLDOWN_BARS} bars per strategy per interval.`);
  kv("Costs", "No slippage, no commission. MAE/MFE for limit entries include the fill bar's full range (the pre-fill part of that minute is not separable at this resolution).");
  gap();

  title("COMBINATIONS");
  kv("ICT + ICT", `Two or more ICT strategies fire the SAME direction within ${C.CONFLUENCE_WINDOW_BARS} bars on the SAME interval -> a combo trade = the LATER signal's trade (its entry/stop/targets). Combos with >= ${COMBO_MIN_N} trades get their own sheet; the rest pool into Rare Combos (each still listed on the Comparison sheet).`);
  kv("ICT × existing engine", `${meta.existingSource}. An ICT trade whose signal bar sits within ${C.CONFLUENCE_WINDOW_BARS} bars of a same-direction, same-interval trade from the existing quality-gated engine becomes a pairing row (e.g. 'OB × Vector Side-Entry'). The row IS the ICT trade — these sheets measure how ICT setups perform WHEN the existing engine agrees. Analysis only; the live engine is untouched.`);
  gap();

  title("DATA & COVERAGE");
  for (const [iv, d] of Object.entries(meta.dataSpan)) {
    kv(`${iv} candles`, `${d.n.toLocaleString()} bars, ${d.from} .. ${d.to} (MotiveWave-authoritative, read-only; same validity filters as the serving path).`);
  }
  kv("Session levels", "Prior-day high/low, prior-day NY-session high/low (when distinct), and the current day's Asia (18:00-03:00 ET) and London (03:00-08:30 ET) session highs/lows, computed from 1-minute bars and armed only after the window completes — no lookahead.");
  kv("Kill zones (context columns)", "Midnight Open 00:00-01:00 ET, London 02:00-05:00 ET, NY-AM 08:30-11:00 ET, Silver Bullet 10:00-11:00 ET (inside NY-AM). The kill-zone stats row on every sheet counts London + NY-AM entries.");
  gap();

  title("TRADE CHARTS (one PNG per past-month trade)");
  kv("Coverage window", `Charts are rendered for trades dated ${CHART_FROM_KEY} -> present (the past month). Older rows keep all their data but show — in the CHART column.`);
  kv("What is drawn", "Candles on the trade's own interval (~70 bars before the signal to ~40 after the exit; overnight bars dim, RTH opens marked), the SIGNAL bar (dashed vertical), entry arrow at the FILL bar, solid entry line, dashed TP1/TP2/SL at THAT trade's levels, exit marker with P&L — plus the fired ICT STRUCTURE, labeled: the order-block / breaker / mitigation zone (gold), the fair-value-gap band (blue), the OTE 62-79% zone (purple), and the swept liquidity level (dashed gold 'SWEPT') or C.E. wick extreme where applicable.");
  kv("Folder requirement", `The VIEW CHART links are RELATIVE (${CHART_DIR}\\<interval>\\<date>_<time>_<direction>_<seq>.png). Keep the ${CHART_DIR} folder in the SAME folder as this workbook — move them together or the links stop resolving. The same past-month trades are ALSO embedded directly in tall rows at the far right of the All ICT Trades sheet, so those need no folder at all.`);
  kv("Known data caveat", meta.knownBadBarPresent
    ? "The known phantom bar (MES 5m 2026-05-25 20:45Z — a lone Memorial-Day bar ~400 pts above its era, no neighbors within 30 minutes) was STILL PRESENT in the DB at run time. It survives the validity filters; its isolation makes it lookback noise for at most a handful of 5m setups that day. A data-repair pass is expected to remove it; re-run this backtest afterwards for exact numbers."
    : "The known phantom bar (MES 5m 2026-05-25 20:45Z) was repaired/removed before this run.");
  gap();

  title("COLUMN GLOSSARY (trade sheets)");
  kv("date/time ET", "New York time of the ENTRY (the fill for limit setups, the signal close for sweeps).");
  kv("signal time ET", "When the setup was detected (its bar's close) — limit trades fill later; 'bars to fill' is the wait.");
  kv("session / kill zone", "RTH = 9:30-17:00 ET, ETH = overnight. Kill zone = which (if any) contained the entry.");
  kv("strategy", "Plain-English strategy name; breaker rows overlapping a gap say '— Unicorn'.");
  kv("WHY IT FIRED", "Plain-English sentence with the exact levels and multiples that satisfied the rules.");
  kv("agreeing with", "Same-window signals from other ICT strategies and/or the existing engine (annotation; on combo sheets it names the partner).");
  kv("entry / sl / tp1 / tp2", "The trade plan at signal time; EXIT STRATEGY spells out what each level is anchored to.");
  kv("WON?", `${OUTCOME_TXT.tp1} / ${OUTCOME_TXT.tp2} = target hit. ${OUTCOME_TXT.sl} = stop hit. ${OUTCOME_TXT.eod} = force-closed at the 17:00 ET settle (P&L can be + or -). ${OUTCOME_TXT.open} = session unfinished at run time (excluded from stats denominators).`);
  kv("MAE / MFE", "Worst / best excursion in points between entry and exit.");
  kv("bars to fill / bars to exit", "In bars of the trade's own interval (fractional — everything resolves on 1-minute bars).");
  gap();

  title("HONEST LIMITATIONS & JUDGMENT CALLS");
  kv("Stats vs formulas", "Sheet stats are REAL Excel formulas (COUNTIFS/SUMIFS with cached results) over each sheet's own rows — except Max DD (needs sequencing; JS literal, marked *). The Comparison sheet references each class sheet's stat cells.");
  kv("Mechanical translation", "The articles are discretionary; every threshold here (displacement 1.5x, swing N=2, 30-bar retest, 62% OTE, 2R cap...) is a documented named constant in shared/ict-engine.ts. Different constants would give different numbers — this workbook is one faithful, testable reading, not the only one.");
  kv("FVG two-50%s rule", "Where the gap's own midpoint and the impulse 50% disagree, entry = the shallower, invalidation = the deeper. This keeps every setup geometrically coherent and matches the article's 'price should not exceed the 50% level' warning.");
  kv("Liquidity memory", `Resting-liquidity tracking keeps the most recent ${C.LIQUIDITY_MEMORY_SWINGS} unswept swings per side; target pools use the nearest one beyond the entry (min ${C.MIN_POOL_DIST_PTS} pt away).`);
  kv("In-sample", "No parameters were fit to outcomes (all constants come from the articles or house convention), but strategy selection itself is informed by the same history. Treat combo rankings as descriptive, not predictive.");
  kv("Setup attrition", Object.entries(meta.fillFailures).filter(([, f]) => f.expired + f.invalid + f.blocked > 0).map(([k, f]) => `${k}: ${f.expired} expired, ${f.invalid} invalidated, ${f.blocked} blocked-while-open`).join("  •  ") || "none");
  gap();

  title("SHEET GUIDE (in order)");
  kv("All ICT Trades", "Every accepted ICT trade, all strategies and intervals — the master list.");
  kv("Per-strategy sheets", "The same trades split by strategy (plus ICT Unicorn, a subset of ICT Breaker).");
  kv("Combo sheets", "ICT+ICT agreements first, then ICT × existing-engine pairings — each a filtered copy of the master rows (the later/ICT signal's trade).");
  kv("Rare Combos", `Every combination under ${COMBO_MIN_N} trades, pooled (per-combo stats on the Comparison sheet).`);
  kv("Comparison", "Every class ranked by expectancy, with kill-zone columns alongside.");
}

// ==================== MAIN ====================

async function main(): Promise<void> {
  let doc: ResultsDoc;
  if (CHARTS_ONLY) {
    // Render per-trade charts for the EXISTING (frozen) trade set — no engine re-run, so the
    // published counts/stats stay exactly as backtested even though the live DB keeps growing.
    console.log(`[ict-bt] --charts-only: reading ${OUT_JSON}`);
    doc = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as ResultsDoc;
    const L = loadData();
    renderAllTradeCharts(doc.trades, L);
    fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 1)); // persist chartPath per row
    console.log(`[ict-bt] updated ${OUT_JSON} with chartPath  ${elapsed()}`);
  } else if (XLSX_ONLY) {
    console.log(`[ict-bt] --xlsx-only: reading ${OUT_JSON}`);
    doc = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as ResultsDoc;
  } else {
    doc = runAll();
    fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 1));
    console.log(`[ict-bt] wrote ${OUT_JSON} (${(fs.statSync(OUT_JSON).size / 1e6).toFixed(1)} MB)  ${elapsed()}`);
    printReport(doc);
  }
  if (!SKIP_XLSX) {
    await buildWorkbook(doc);
    const fallback = OUT_XLSX.replace(/\.xlsx$/i, ".new.xlsx");
    const wrote = fs.existsSync(fallback) && fs.statSync(fallback).mtimeMs > t0 ? fallback : OUT_XLSX;
    console.log(`[ict-bt] wrote ${wrote} (${(fs.statSync(wrote).size / 1e6).toFixed(2)} MB)  ${elapsed()}`);
  }
  const mem = process.memoryUsage();
  console.log(`[ict-bt] DONE  runtime ${elapsed()}  peakRSS ${(mem.rss / 1e9).toFixed(2)} GB`);
}

main().catch(e => { console.error(e); process.exit(1); });
