/**
 * scripts/analysis/build-signal-dataset.ts — ANALYSIS ONLY (read-only DB, no persistence).
 *
 * Builds a per-signal research dataset for the 2026-06-24 .. present reporting window:
 *   • replays the CURRENT engine (shared/fact-engine.ts runFactEngine, current defaults)
 *     through the SAME loader + engine-pass code as scripts/fact-engine-backtest.ts
 *     (imported: loadData / enginePass — serving-path mirror, live scrubber window, yellowbox
 *     day-zones, 5m footprint map, dead-tape baseline), once UNGATED and once GATED, both under
 *     the SHIPPED shared/quality-gate.ts data (so tp1/sl are the shipped calibrated exits);
 *   • for every fire: identity, gate verdict, a STRATEGY-STATUS block for every strategy
 *     (filled whether or not the strategy was a counted fact), the 1m PATH from entry
 *     (MFE/MAE/MTM at horizons, first-crossing minutes, outcomes under carry-overnight /
 *     session-bounded / Apex 16:55 flat), and the signal_history join;
 *   • live-book-30d.json: every signal_history row of the last 30 days joined to the same
 *     status + path blocks.
 *
 * Outputs (only) to C:\BaxterSandbox\analysis\ — never touches data/app.db (readonly handle),
 * signal_history, shared/quality-gate.ts or C:\BaxterData.
 *
 * Run (repo root):  npx tsx scripts/analysis/build-signal-dataset.ts
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadData, enginePass, INTERVALS, type Loaded } from "../fact-engine-backtest";
import {
  INTERVAL_SEC, FACT_ENGINE_DEFAULTS, vectorStateAt,
  type Interval, type FactSignal, type Fact,
} from "../../shared/fact-engine";
import { QUALITY_GATE, qualityGateAllows, comboGateAllows, comboKeyOf, classKey } from "../../shared/quality-gate";
import { deriveEngineSlices } from "../../shared/live-adapter";
import { computeFractalSeries, findFractals, FRACTAL_DEFAULTS } from "../../shared/fractal-engine";
import { computeFractalGeometrySeries, FG_CONST, type FgDir } from "../../shared/fractal-geometry";
import { runIctEngine, deriveSessionLevels, killZoneOf, ICT_CONST, type IctStrategy } from "../../shared/ict-engine";
import { walkOutcomeCanonical } from "../../shared/outcome-resolver";
import { computeCloseEstimate, type CloseEstimate } from "../../shared/close-estimate-core";
import {
  etParts, etWallToEpoch, sessionDayKey, weekdayOfKey, WEEKDAY_NAMES, filterYbBars, type Bar,
  buildSessionDays, computeCoreZones, rnd2, type DayAgg,
} from "../../shared/yellowbox-core";
import { etWallClock, etSessionDayBucket } from "../../shared/firing/session";
import { computeVectorLine } from "../../shared/firing/vector";
import { VEC_LENGTH } from "../../shared/firing/constants";
import type { FiringCandle } from "../../shared/firing/types";

const t0 = Date.now();
const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data", "app.db");
const OUT_DIR = "C:\\BaxterSandbox\\analysis";
const SYMBOL = "MES";
const REPORT_FROM_KEY = "2026-06-24";
const HALF2_FROM_KEY = "2026-08-13";
const FRICTION_PTS = 1.0;
const HORIZONS_MIN = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 240];
const LEVELS = [2, 4, 6, 8, 10, 12.5, 15, 17.5, 20, 22.5, 25, 30];
const CROSS_MAX_SESSIONS = 5;
const LIVE_BOOK_DAYS = 30;
const CLOSE_EST_LOOKBACK_DAYS = 130; // server/close-estimate.ts LOOKBACK_CAL_DAYS

const r2 = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const pad = (n: number): string => String(n).padStart(2, "0");
function lowerBound(a: number[], t: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; }
  return lo;
}
function asOfIndex(a: number[], t: number): number {
  let lo = 0, hi = a.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
const fmtEt = (t: number): string => { const p = etParts(t); return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`; };
const _wallCache = new Map<string, number>();
function wall(dayKey: string, hh: number, mm: number): number {
  const k = `${dayKey}|${hh}|${mm}`;
  let v = _wallCache.get(k);
  if (v === undefined) { v = etWallToEpoch(dayKey, hh, mm); _wallCache.set(k, v); }
  return v;
}

// ═══════════════════════════════ READ-ONLY DB ═══════════════════════════════
// Strict readonly. loadData() (harness) opens its own handle readonly first and only falls back
// when readonly fails; this open proves readonly works right now, so its fallback is not taken.
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ═══════════════════════════════ ENGINE PASSES ══════════════════════════════
console.log(`[ds] loading data via the harness loader (scripts/fact-engine-backtest.ts loadData)`);
const L: Loaded = loadData();
const nowSec = Math.floor(Date.now() / 1000);
const reportFromTs = etWallToEpoch(REPORT_FROM_KEY, 0, 0);

// ═══════════════════════════════ DAY-ZONE REPAIR (v2, 2026-10-01) ════════════
// The harness computes UNCACHED day zones (today, any day the server has not frozen yet) from
// the CHART chain (buildBaseCandles → isolation filter), but the server — which is what the
// live engine actually receives — builds them from RAW cached_candles through filterYbBars only
// (server/yellowbox.ts loadBars). Recompute those keys exactly like the server and patch them
// into L.dayZones BEFORE the engine passes. The same recompute is validated against every
// cached zone in the report window (must match to the cent).
interface YbRecompute { boxTop: number; boxBottom: number; initRes: number; initSup: number }
const zoneRecomputeByKey = new Map<string, YbRecompute>(); // server-style recompute on TODAY's bars, every key in window
const zoneRepair: { recomputed: Record<string, { harness: YbRecompute; server: YbRecompute }>; validation: { cachedCompared: number; maxAbsDiff: number; mismatches: string[] } } =
  { recomputed: {}, validation: { cachedCompared: 0, maxAbsDiff: 0, mismatches: [] } };
{
  const YB_LOOKBACK_SEC = 130 * 86400, YB_MIN_DAY_BARS = 60; // server/yellowbox.ts LOOKBACK_SEC / MIN_DAY_BARS
  const cachedKeys = (db.prepare(`SELECT day_key FROM yellowbox_day_zones WHERE symbol=? AND traded=1 AND day_key>=? ORDER BY day_key`)
    .all(SYMBOL, REPORT_FROM_KEY) as Array<{ day_key: string }>).map(r => r.day_key);
  const targetKeys = [...new Set([...cachedKeys, ...L.computedYbKeys])].sort();
  const loadFrom = etWallToEpoch(targetKeys[0], 0, 0) - 86400 - YB_LOOKBACK_SEC;
  const loadYb = (res: string): Bar[] => filterYbBars(db.prepare(
    `SELECT timestamp t, open o, high h, low l, close c, volume v FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp`,
  ).all(SYMBOL, res, loadFrom, nowSec) as Bar[], res);
  const { dayMap } = buildSessionDays(loadYb("5"));
  const trading: DayAgg[] = [...dayMap.values()]
    .filter(d => d.weekday >= 1 && d.weekday <= 5 && d.bars >= YB_MIN_DAY_BARS)
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  for (let k = 1; k < trading.length; k++) trading[k].prevClose = trading[k - 1].c;
  const keysAll = trading.map(d => d.key);
  const withPrev = trading.filter(d => d.prevClose !== null);
  const withPrevKeys = withPrev.map(d => d.key);
  const day60 = new Map<string, Bar[]>();
  for (const b of loadYb("60")) { const k = sessionDayKey(b.t); let a = day60.get(k); if (!a) { a = []; day60.set(k, a); } a.push(b); }
  const lbStr = (a: string[], k: string): number => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < k) lo = m + 1; else hi = m; } return lo; };
  const serverZone = (k: string): YbRecompute | null => {
    const idxAll = lbStr(keysAll, k);
    if (idxAll === 0) return null;
    const anchor = trading[idxAll - 1].c;
    const idxPrev = lbStr(withPrevKeys, k);
    const last50 = withPrev.slice(Math.max(0, idxPrev - 50), idxPrev);
    if (last50.length < 10) return null;
    const core = computeCoreZones(last50, day60, anchor);
    return { boxTop: rnd2(core.ybTop), boxBottom: rnd2(core.ybBottom), initRes: rnd2(core.initRes), initSup: rnd2(core.initSup) };
  };
  // Validate the recompute against the server's own frozen zones.
  const cachedRows = db.prepare(`SELECT day_key, box_top, box_bottom, init_res, init_sup FROM yellowbox_day_zones WHERE symbol=? AND traded=1 AND day_key>=?`)
    .all(SYMBOL, REPORT_FROM_KEY) as Array<{ day_key: string; box_top: number; box_bottom: number; init_res: number; init_sup: number }>;
  for (const r of cachedRows) {
    const z = serverZone(r.day_key);
    if (z) zoneRecomputeByKey.set(r.day_key, z);
    if (!z) { zoneRepair.validation.mismatches.push(`${r.day_key}: no recompute`); continue; }
    const d = Math.max(Math.abs(z.boxTop - r.box_top), Math.abs(z.boxBottom - r.box_bottom), Math.abs(z.initRes - r.init_res), Math.abs(z.initSup - r.init_sup));
    zoneRepair.validation.cachedCompared++;
    if (d > zoneRepair.validation.maxAbsDiff) zoneRepair.validation.maxAbsDiff = r2(d) ?? 0;
    if (d > 0.011) zoneRepair.validation.mismatches.push(`${r.day_key}: max|diff| ${d.toFixed(2)}`);
  }
  // Patch the harness-computed keys.
  const computedSet = new Set(L.computedYbKeys);
  for (const dz of L.dayZones) {
    if (!computedSet.has(dz.dayKeyET)) continue;
    const z = serverZone(dz.dayKeyET);
    if (!z) continue;
    zoneRepair.recomputed[dz.dayKeyET] = { harness: { boxTop: dz.boxTop, boxBottom: dz.boxBottom, initRes: dz.initRes, initSup: dz.initSup }, server: z };
    dz.boxTop = z.boxTop; dz.boxBottom = z.boxBottom; dz.initRes = z.initRes; dz.initSup = z.initSup;
    const yr = L.ybByKey.get(dz.dayKeyET);
    if (yr) { yr.box_top = z.boxTop; yr.box_bottom = z.boxBottom; yr.init_res = z.initRes; yr.init_sup = z.initSup; }
  }
  console.log(`[ds] day-zone repair: validated server-style recompute on ${zoneRepair.validation.cachedCompared} cached zones (max |diff| ${zoneRepair.validation.maxAbsDiff}, mismatches ${zoneRepair.validation.mismatches.length}); patched ${Object.keys(zoneRepair.recomputed).length} harness-computed key(s): ${JSON.stringify(zoneRepair.recomputed)}`);
  if (zoneRepair.validation.mismatches.length) console.warn(`[ds] NOTE cached zones that differ from a recompute on CURRENT bars (frozen before a later backfill/repair; the engine uses the cached box): ${zoneRepair.validation.mismatches.slice(0, 10).join(" | ")}`);
}
const computedZoneKeys = new Set(L.computedYbKeys);
// UNGATED with the SHIPPED gate data → class/combo gates off, shipped calibrated exits ON.
const ungatedByIv = enginePass(L, { gate: false, gateData: QUALITY_GATE, label: "UNGATED(shipped exits)" }, nowSec);
const gatedByIv = enginePass(L, { gate: true, gateData: QUALITY_GATE, label: "GATED(shipped gate+exits)" }, nowSec);
console.log(`[ds] engine passes done  ${elapsed()}`);

// ═══════════════════════════════ PER-INTERVAL CONTEXT ═══════════════════════
interface SliceCtx { iv: Interval; candles: FiringCandle[]; times: number[]; vec: Array<number | null>; vecByTime: Map<number, number>; barSec: number }
interface IctEv { kind: "sweep" | "ob" | "breaker" | "fvg"; direction: "Long" | "Short"; level: number }
interface IvCtx {
  iv: Interval; barSec: number;
  pc: FiringCandle[]; times: number[]; vec: Array<number | null>; vecByTime: Map<number, number>;
  slices: SliceCtx[];
  fr: ReturnType<typeof computeFractalSeries>;
  lastConfUp: Int32Array; lastConfDown: Int32Array; // pivot idx (−1 none) of the latest CONFIRMED fractal as of bar i
  frPivotUp: Map<number, number>; frPivotDown: Map<number, number>;
  lastLongBk: Array<{ idx: number; level: number } | null>; lastShortBk: Array<{ idx: number; level: number } | null>;
  fg: ReturnType<typeof computeFractalGeometrySeries>;
  ict: Map<number, IctEv[]>;
  sdHi: Float64Array; sdLo: Float64Array; sdOpen: Float64Array;
  ybSide: Array<"above" | "below" | "inside" | null>; ybBreakIdx: Float64Array;
}

const dzSorted = [...L.dayZones].sort((a, b) => a.sessionStartTs - b.sessionStartTs);
const dzStarts = dzSorted.map(z => z.sessionStartTs);
function dayZoneAt(t: number): (typeof dzSorted)[number] | null {
  const idx = asOfIndex(dzStarts, t);
  if (idx < 0) return null;
  const z = dzSorted[idx];
  return t >= z.sessionStartTs && t <= z.sessionEndTs ? z : null;
}

function buildCtx(iv: Interval): IvCtx {
  const { slices } = deriveEngineSlices({
    interval: iv,
    windowedCandles: L.candlesByIv[iv],
    raw1mCandles: iv !== "1m" ? L.servedByIv["1m"] : undefined,
    rawCandles: L.servedByIv[iv],
    raw60mCandles: iv !== "60m" ? L.servedByIv["60m"] : undefined,
  });
  const sctx: SliceCtx[] = slices.map(sl => {
    const candles = sl.candles as FiringCandle[];
    const vecByTime = new Map((sl.vector ?? []).map(v => [v.time, v.value]));
    return {
      iv: sl.interval, candles, times: candles.map(c => c.time),
      vec: candles.map(c => vecByTime.get(c.time) ?? null), vecByTime, barSec: INTERVAL_SEC[sl.interval],
    };
  });
  const prim = sctx.find(s => s.iv === iv)!;
  const pc = prim.candles;
  const n = pc.length;
  const barSec = INTERVAL_SEC[iv];

  const fr = computeFractalSeries(pc);
  const { up, down } = findFractals(pc);
  const lastConfUp = new Int32Array(n).fill(-1), lastConfDown = new Int32Array(n).fill(-1);
  const frPivotUp = new Map<number, number>(), frPivotDown = new Map<number, number>();
  for (const p of up) frPivotUp.set(p.idx, p.price);
  for (const p of down) frPivotDown.set(p.idx, p.price);
  { let k = 0, cur = -1; for (let i = 0; i < n; i++) { while (k < up.length && up[k].confirmedIdx <= i) cur = up[k++].idx; lastConfUp[i] = cur; } }
  { let k = 0, cur = -1; for (let i = 0; i < n; i++) { while (k < down.length && down[k].confirmedIdx <= i) cur = down[k++].idx; lastConfDown[i] = cur; } }
  const lastLongBk: IvCtx["lastLongBk"] = new Array(n).fill(null), lastShortBk: IvCtx["lastShortBk"] = new Array(n).fill(null);
  { let k = 0; let lb: { idx: number; level: number } | null = null, sb: { idx: number; level: number } | null = null;
    for (let i = 0; i < n; i++) {
      while (k < fr.breakouts.length && fr.breakouts[k].idx <= i) { const e = fr.breakouts[k++]; if (e.direction === "Long") lb = { idx: e.idx, level: e.level }; else sb = { idx: e.idx, level: e.level }; }
      lastLongBk[i] = lb; lastShortBk[i] = sb;
    } }
  const fg = computeFractalGeometrySeries(pc, pc.map(c => prim.vecByTime.get(c.time) ?? null), barSec);

  // ICT events — VERBATIM copy of runFactEngine's precompute (same detectors, same retest rule).
  const ict = new Map<number, IctEv[]>();
  if (pc.length > ICT_CONST.MIN_WARMUP_BARS) {
    const pushEv = (b: number, ev: IctEv): void => { let a = ict.get(b); if (!a) { a = []; ict.set(b, a); } a.push(ev); };
    const strategies: IctStrategy[] = ["ICT-SWEEP", "ICT-OB", "ICT-BREAKER", "ICT-FVG"];
    const setups = runIctEngine({ candles: pc, interval: iv, barSec, levels: deriveSessionLevels(pc), strategies });
    for (const su of setups) {
      if (su.strategy === "ICT-SWEEP") { pushEv(su.setupIdx, { kind: "sweep", direction: su.direction, level: su.refs.sweptLevel ?? su.entry }); continue; }
      const kind = su.strategy === "ICT-OB" ? "ob" as const : su.strategy === "ICT-BREAKER" ? "breaker" as const : "fvg" as const;
      const isLong = su.direction === "Long";
      const end = Math.min(pc.length - 1, su.setupIdx + ICT_CONST.RETEST_WINDOW_BARS);
      for (let j = su.setupIdx + 1; j <= end; j++) {
        const b = pc[j];
        if (isLong) {
          if (b.close < su.stop) break;
          if (su.invalidBeyond != null && b.close < su.invalidBeyond) break;
          if (b.low <= su.entry && b.close > su.entry) { pushEv(j, { kind, direction: "Long", level: su.entry }); break; }
        } else {
          if (b.close > su.stop) break;
          if (su.invalidBeyond != null && b.close > su.invalidBeyond) break;
          if (b.high >= su.entry && b.close < su.entry) { pushEv(j, { kind, direction: "Short", level: su.entry }); break; }
        }
      }
    }
  }

  // Session-day running range + YB break-event state (engine semantics, folded over every closed bar).
  const sdHi = new Float64Array(n), sdLo = new Float64Array(n), sdOpen = new Float64Array(n);
  const ybSide: IvCtx["ybSide"] = new Array(n).fill(null);
  const ybBreakIdx = new Float64Array(n).fill(-Infinity);
  let bucket = NaN, hi = -Infinity, lo = Infinity, op = NaN;
  let side: "above" | "below" | "inside" | null = null, zoneStart = NaN, breakIdx = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = pc[i];
    const b = etSessionDayBucket(c.time);
    if (b !== bucket) { bucket = b; hi = -Infinity; lo = Infinity; op = c.open; }
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
    sdHi[i] = hi; sdLo[i] = lo; sdOpen[i] = op;
    if (c.complete !== false) {
      const dz = dayZoneAt(c.time);
      if (!dz) { side = null; zoneStart = NaN; }
      else {
        if (dz.sessionStartTs !== zoneStart) { zoneStart = dz.sessionStartTs; side = null; }
        const s2 = c.close > dz.boxTop ? "above" : c.close < dz.boxBottom ? "below" : "inside";
        if (s2 !== "inside" && s2 !== side) breakIdx = i;
        side = s2;
      }
    }
    ybSide[i] = side; ybBreakIdx[i] = breakIdx;
  }
  console.log(`[ds] ctx ${iv}: ${n} primary bars, slices ${sctx.map(s => `${s.iv}=${s.candles.length}`).join(" ")}, ict events ${ict.size}  ${elapsed()}`);
  return {
    iv, barSec, pc, times: prim.times, vec: prim.vec, vecByTime: prim.vecByTime, slices: sctx,
    fr, lastConfUp, lastConfDown, frPivotUp, frPivotDown, lastLongBk, lastShortBk, fg, ict,
    sdHi, sdLo, sdOpen, ybSide, ybBreakIdx,
  };
}
const CTX = {} as Record<Interval, IvCtx>;
for (const iv of INTERVALS) CTX[iv] = buildCtx(iv);

// ═══════════════════════════════ RAW (SERVED) CONTEXT (v2) ═══════════════════
// The engine's slices come from the client chart chain (buildBaseCandles / filterCandlesForVector),
// whose ISOLATION filter drops ~3-5% of real bars, concentrated inside fast moves. status.vector /
// status.day reproduce that ENGINE view on purpose; these RAW blocks give the same quantities on the
// server-served bars (grid / flat / spike / market-closed filters only — what /api/data/cached-continuous
// serves and what server/catchup.ts resolves outcomes on), plus a per-row count of served bars the
// engine never saw inside its vector dependency span.
const VEC_SPAN = 2 * VEC_LENGTH - 1; // Highest(Lowest(low,20),20) depends on the last 39 bars
interface RawCtx { iv: Interval; barSec: number; candles: FiringCandle[]; times: number[]; vec: number[]; sdHi: Float64Array; sdLo: Float64Array; sdOpen: Float64Array }
const RAW = {} as Record<Interval, RawCtx>;
for (const iv of INTERVALS) {
  const candles = L.servedByIv[iv] as unknown as FiringCandle[];
  const n = candles.length;
  const vl = computeVectorLine(candles);
  const sdHi = new Float64Array(n), sdLo = new Float64Array(n), sdOpen = new Float64Array(n);
  let bucket = NaN, hi = -Infinity, lo = Infinity, op = NaN;
  for (let k = 0; k < n; k++) {
    const c = candles[k]; const b = etSessionDayBucket(c.time);
    if (b !== bucket) { bucket = b; hi = -Infinity; lo = Infinity; op = c.open; }
    if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low;
    sdHi[k] = hi; sdLo[k] = lo; sdOpen[k] = op;
  }
  RAW[iv] = { iv, barSec: INTERVAL_SEC[iv], candles, times: candles.map(c => c.time), vec: vl.map(v => v.value), sdHi, sdLo, sdOpen };
}
const sliceTimeSets = new Map<string, Set<number>>();
const sliceSet = (primary: Interval, sl: SliceCtx): Set<number> => {
  const k = `${primary}|${sl.iv}`;
  let s = sliceTimeSets.get(k);
  if (!s) { s = new Set(sl.times); sliceTimeSets.set(k, s); }
  return s;
};
{
  const msg: string[] = [];
  for (const iv of INTERVALS) {
    const prim = CTX[iv].slices.find(s => s.iv === iv)!;
    const set = sliceSet(iv, prim);
    const inWin = RAW[iv].times.filter(t => t >= reportFromTs);
    const miss = inWin.filter(t => !set.has(t)).length;
    msg.push(`${iv} primary: ${miss}/${inWin.length} served bars absent (${((100 * miss) / Math.max(1, inWin.length)).toFixed(1)}%)`);
  }
  console.log(`[ds] engine-input gaps vs served bars in window: ${msg.join("; ")}`);
}

// ═══════════════════════════════ FOOTPRINT + 5m (close-estimate) ═════════════
interface FpRow { t: number; delta: number | null; buyStacks: number; sellStacks: number; stackDelta: number; dirs: string }
const fpRows: FpRow[] = [];
for (const r of db.prepare(`SELECT time, data FROM footprint_candles WHERE symbol=? AND interval='5m' AND complete=1 ORDER BY time`).iterate(SYMBOL) as IterableIterator<{ time: number; data: string }>) {
  try {
    const d = JSON.parse(r.data) as { totalBidVol?: number; totalAskVol?: number; imbalances?: Array<{ direction: "buy" | "sell"; levelCount: number; totalDelta?: number }> };
    const st = (d.imbalances ?? []).filter(im => im.levelCount >= 2);
    fpRows.push({
      t: r.time,
      delta: d.totalAskVol != null && d.totalBidVol != null ? d.totalAskVol - d.totalBidVol : null,
      buyStacks: st.filter(x => x.direction === "buy").length,
      sellStacks: st.filter(x => x.direction === "sell").length,
      stackDelta: st.reduce((a, x) => a + (x.totalDelta ?? 0), 0),
      dirs: st.map(x => x.direction).join(","),
    });
  } catch { /* malformed row */ }
}
const fpTimes = fpRows.map(r => r.t);
console.log(`[ds] footprint rows (5m complete): ${fpRows.length}`);

const ceFrom = etWallToEpoch(REPORT_FROM_KEY, 0, 0) - (CLOSE_EST_LOOKBACK_DAYS + 5) * 86400;
const bars5 = filterYbBars(db.prepare(
  `SELECT timestamp t, open o, high h, low l, close c, volume v FROM cached_candles WHERE symbol=? AND resolution='5' AND timestamp>=? ORDER BY timestamp`,
).all(SYMBOL, ceFrom) as Bar[], "5");
const bars5T = bars5.map(b => b.t);
const ceCache = new Map<number, CloseEstimate | null>();
function closeEstAt(entryTs: number): CloseEstimate | null {
  const hiIdx = asOfIndex(bars5T, entryTs - 300); // last 5m bar CLOSED by the entry moment
  if (hiIdx < 0) return null;
  if (ceCache.has(hiIdx)) return ceCache.get(hiIdx)!;
  const loIdx = lowerBound(bars5T, bars5T[hiIdx] + 300 - CLOSE_EST_LOOKBACK_DAYS * 86400);
  const est = computeCloseEstimate(bars5.slice(loIdx, hiIdx + 1));
  ceCache.set(hiIdx, est);
  return est;
}

// ═══════════════════════════════ STRATEGY STATUS ═════════════════════════════
const S = FACT_ENGINE_DEFAULTS;
const dirSign = (d: "Long" | "Short"): 1 | -1 => (d === "Long" ? 1 : -1);
const fgRecentDir = (arr: FgDir[], i: number): "Long" | "Short" | "both" | null => {
  let L1 = false, S1 = false;
  for (let k = 0; k < FG_CONST.RECENT_BARS && i - k >= 0; k++) { if (arr[i - k] === 1) L1 = true; if (arr[i - k] === -1) S1 = true; }
  return L1 && S1 ? "both" : L1 ? "Long" : S1 ? "Short" : null;
};
const alignOf = (dir: "Long" | "Short", v: "Long" | "Short" | "both" | null | undefined): number =>
  v == null ? 0 : v === "both" ? 0 : v === dir ? 1 : -1;

function strategyStatus(iv: Interval, i: number, entry: number, direction: "Long" | "Short", entryTs: number) {
  const C = CTX[iv];
  const c = C.pc[i];
  const closeTime = c.time + C.barSec;
  const sgn = dirSign(direction);

  // ── Yellowbox ──
  const dz = dayZoneAt(c.time);
  const side = C.ybSide[i];
  const bIdx = C.ybBreakIdx[i];
  const beyond = side === "above" || side === "below";
  const yellowbox = dz ? {
    position: entry > dz.boxTop ? "above" : entry < dz.boxBottom ? "below" : "inBox",
    boxTop: dz.boxTop, boxBottom: dz.boxBottom, initRes: dz.initRes, initSup: dz.initSup,
    boxHeight: r2(dz.boxTop - dz.boxBottom),
    distToTop: r2(entry - dz.boxTop), distToBottom: r2(entry - dz.boxBottom),
    distToInitRes: r2(entry - dz.initRes), distToInitSup: r2(entry - dz.initSup),
    barsSinceBreakEvent: beyond && Number.isFinite(bIdx) ? i - bIdx : null,
    breakEventActive: beyond && Number.isFinite(bIdx) && i - bIdx < S.YB_BREAK_EVENT_BARS,
    breakSide: beyond ? side : null,
    // Cached zones are FROZEN at compute time; if bars were backfilled/repaired afterwards the
    // cache no longer equals a recompute on today's bars (e.g. 2026-08-26..09-02, frozen during a
    // data gap with settle 7671.25 on every day). The engine (live and replay) used the cached box;
    // the recompute is reported for analysis only.
    recompute: (() => {
      const z = zoneRecomputeByKey.get(dz.dayKeyET) ?? zoneRepair.recomputed[dz.dayKeyET]?.server;
      if (!z) return null;
      const d = Math.max(Math.abs(z.boxTop - dz.boxTop), Math.abs(z.boxBottom - dz.boxBottom), Math.abs(z.initRes - dz.initRes), Math.abs(z.initSup - dz.initSup));
      return { ...z, maxAbsDiffVsUsed: r2(d), position: entry > z.boxTop ? "above" : entry < z.boxBottom ? "below" : "inBox" };
    })(),
    zoneSource: computedZoneKeys.has(dz.dayKeyET) ? (zoneRepair.recomputed[dz.dayKeyET] ? "computed-server-style-raw" : "computed-harness") : "cached",
  } : { position: "noBox", boxTop: null, boxBottom: null, initRes: null, initSup: null, boxHeight: null, distToTop: null, distToBottom: null, distToInitRes: null, distToInitSup: null, barsSinceBreakEvent: null, breakEventActive: false, breakSide: null, recompute: null, zoneSource: null };
  const ybDir: "Long" | "Short" | null = yellowbox.position === "above" ? "Long" : yellowbox.position === "below" ? "Short" : null;

  // ── Vector per interval (slices exactly as the engine saw them for this primary) ──
  const vector: Record<string, unknown> = {};
  const vecAlign: Record<string, number> = {};
  for (const sl of C.slices) {
    let j = sl.iv === iv ? i : asOfIndex(sl.times, closeTime - sl.barSec); // lookahead guard (B7)
    while (j >= 0 && sl.candles[j].complete === false) j--;
    const v = j >= 0 ? sl.vec[j] : null;
    if (j < 0 || v == null) { vector[sl.iv] = null; vecAlign[sl.iv] = 0; continue; }
    const v5 = j >= 5 ? sl.vec[j - 5] : null, v20 = j >= 20 ? sl.vec[j - 20] : null;
    const st = vectorStateAt(sl.candles, sl.vecByTime, j, S);
    const pv = entry > v ? "above" : entry < v ? "below" : "on";
    vector[sl.iv] = {
      value: r2(v), priceVsVector: pv, distance: r2(entry - v),
      slope5: v5 == null ? null : r2(v - v5), slope20: v20 == null ? null : r2(v - v20),
      barCloseVsVector: sl.candles[j].close > v ? "above" : sl.candles[j].close < v ? "below" : "on",
      sideEntry: st.sideEntryLong ? "Long" : st.sideEntryShort ? "Short" : null,
      heading: st.headingLong ? "Long" : st.headingShort ? "Short" : null,
      tabletop: st.tabletop ? r2(st.tabletopLevel) : null,
      barTime: sl.candles[j].time,
    };
    vecAlign[sl.iv] = pv === "above" ? sgn : pv === "below" ? -sgn : 0;
  }

  // ── RAW (served-bar) vector per interval + engine-input gap counts (v2) ──
  const vectorRaw: Record<string, unknown> = {};
  const vecAlignRaw: Record<string, number> = {};
  const engineInputGaps: Record<string, unknown> = {};
  for (const sl of C.slices) {
    const R = RAW[sl.iv];
    const jr = asOfIndex(R.times, closeTime - R.barSec); // served bar CLOSED by the fire close
    const set = sliceSet(iv, sl);
    let droppedSpan = 0, dropped20 = 0;
    for (let k = Math.max(0, jr - VEC_SPAN + 1); k <= jr; k++) {
      if (!set.has(R.times[k])) { droppedSpan++; if (k > jr - VEC_LENGTH) dropped20++; }
    }
    engineInputGaps[sl.iv] = jr < 0 ? null : { droppedInVecSpan39: droppedSpan, droppedInLast20: dropped20 };
    if (jr < VEC_SPAN - 1) { vectorRaw[sl.iv] = null; vecAlignRaw[sl.iv] = 0; continue; }
    const v = R.vec[jr];
    const engV = (vector[sl.iv] as { value?: number | null } | null)?.value ?? null;
    const pv = entry > v ? "above" : entry < v ? "below" : "on";
    vectorRaw[sl.iv] = {
      value: r2(v), priceVsVector: pv, distance: r2(entry - v),
      slope5: jr >= 5 ? r2(v - R.vec[jr - 5]) : null, slope20: jr >= 20 ? r2(v - R.vec[jr - 20]) : null,
      barCloseVsVector: R.candles[jr].close > v ? "above" : R.candles[jr].close < v ? "below" : "on",
      barTime: R.times[jr],
      diffVsEngine: engV == null ? null : r2(v - engV),
    };
    vecAlignRaw[sl.iv] = pv === "above" ? sgn : pv === "below" ? -sgn : 0;
  }
  const primGap = engineInputGaps[iv] as { droppedInVecSpan39: number; droppedInLast20: number } | null;

  // ── Fractal ──
  const fr = C.fr;
  const up = C.lastConfUp[i], dn = C.lastConfDown[i];
  const lastFr = up < 0 && dn < 0 ? null : up >= dn
    ? { type: "up", level: C.frPivotUp.get(up) ?? null, pivotBarsAgo: i - up }
    : { type: "down", level: C.frPivotDown.get(dn) ?? null, pivotBarsAgo: i - dn };
  const lb = C.lastLongBk[i], sb = C.lastShortBk[i];
  const longBkRecent = lb != null && i - lb.idx < S.FRACTAL_RECENT_BARS;
  const shortBkRecent = sb != null && i - sb.idx < S.FRACTAL_RECENT_BARS;
  const ub = fr.upper[i], lbnd = fr.lower[i];
  const fco = fr.fco[i];
  const fcoState = !Number.isFinite(fco) ? null : fco >= FRACTAL_DEFAULTS.FCO_TREND_MIN ? "trendUp" : fco <= -FRACTAL_DEFAULTS.FCO_TREND_MIN ? "trendDown" : Math.abs(fco) <= FRACTAL_DEFAULTS.FCO_CHOP_MAX ? "chop" : "neutral";
  const chop = fr.chopFCB[i] || (Number.isFinite(fco) && Math.abs(fco) <= FRACTAL_DEFAULTS.FCO_CHOP_MAX);
  const bandPos = ub != null && c.close > ub ? "aboveUpper" : lbnd != null && c.close < lbnd ? "belowLower" : (ub == null && lbnd == null ? null : "inside");
  const fractal = {
    lastConfirmed: lastFr,
    upperBand: r2(ub), lowerBand: r2(lbnd),
    distToUpper: ub == null ? null : r2(entry - ub), distToLower: lbnd == null ? null : r2(entry - lbnd),
    bandPosition: bandPos,
    lastLongBreakout: lb ? { barsAgo: i - lb.idx, level: lb.level } : null,
    lastShortBreakout: sb ? { barsAgo: i - sb.idx, level: sb.level } : null,
    breakoutRecent: (longBkRecent && shortBkRecent ? "both" : longBkRecent ? "Long" : shortBkRecent ? "Short" : null) as "Long" | "Short" | "both" | null,
    fco: Number.isFinite(fco) ? r2(fco) : null, fcoState, chopFCB: fr.chopFCB[i], chop,
  };
  const frDir = fractal.breakoutRecent ?? (bandPos === "aboveUpper" ? "Long" : bandPos === "belowLower" ? "Short" : null);
  const fcoDir = fcoState === "trendUp" ? "Long" : fcoState === "trendDown" ? "Short" : null;

  // ── Fractal geometry ──
  const fg = C.fg;
  const tape = fg.tape[i];
  const fractalGeometry = {
    reclaim: fgRecentDir(fg.reclaim, i), flatBounce: fgRecentDir(fg.flatBounce, i),
    compression: fgRecentDir(fg.compression, i), priorCloseCross: fgRecentDir(fg.priorCloseCross, i),
    waveRoom: tape && tape.state === "room" ? (tape.dir === 1 ? "Long" : "Short") : null,
    waveState: tape ? tape.state : null, waveDir: tape ? (tape.dir === 1 ? "Long" : "Short") : null,
    waveExtent: tape ? r2(tape.extent) : null, waveMedian: tape ? r2(tape.median) : null, waveP80: tape ? r2(tape.p80) : null,
    chaseExpect: fg.chase[i] === 1 ? "up" : fg.chase[i] === -1 ? "down" : null,
    eVec: r2(fg.eVec[i]), sVec: r2(fg.sVec[i]),
  };
  const fgAgreeN = ["reclaim", "flatBounce", "compression", "priorCloseCross", "waveRoom"]
    .reduce((a, k) => a + alignOf(direction, (fractalGeometry as Record<string, unknown>)[k] as "Long" | "Short" | "both" | null), 0);

  // ── ICT ──
  const atBar = (C.ict.get(i) ?? []).map(e => ({ ...e }));
  const recent: Array<IctEv & { barsAgo: number }> = [];
  for (let k = 0; k <= 10 && i - k >= 0; k++) for (const e of C.ict.get(i - k) ?? []) recent.push({ ...e, barsAgo: k });
  const ict = {
    killZone: killZoneOf(closeTime),
    atBar,
    sweep: atBar.find(e => e.kind === "sweep")?.direction ?? null,
    ob: atBar.find(e => e.kind === "ob")?.direction ?? null,
    fvg: atBar.find(e => e.kind === "fvg")?.direction ?? null,
    breaker: atBar.find(e => e.kind === "breaker")?.direction ?? null,
    recent10: recent,
  };
  const ictAlign = atBar.reduce((a, e) => a + (e.direction === direction ? 1 : -1), 0);

  // ── Footprint (latest complete 5m footprint bar CLOSED by the entry moment) ──
  const fi = asOfIndex(fpTimes, entryTs - 300);
  const fpr = fi >= 0 ? fpRows[fi] : null;
  const fpAgeMin = fpr ? (entryTs - (fpr.t + 300)) / 60 : null;
  const fpFresh = fpAgeMin != null && fpAgeMin <= 10;
  const footprint = {
    available: fpFresh,
    barTime: fpr?.t ?? null, ageMin: fpAgeMin,
    stackedDir: fpr && fpFresh ? (fpr.buyStacks && fpr.sellStacks ? "both" : fpr.buyStacks ? "buy" : fpr.sellStacks ? "sell" : "none") : null,
    buyStacks: fpFresh ? fpr!.buyStacks : null, sellStacks: fpFresh ? fpr!.sellStacks : null,
    delta: fpFresh ? fpr!.delta : null, stackDelta: fpFresh ? fpr!.stackDelta : null,
    engineFpAtBar: (iv === "5m" || iv === "15m") ? L.fpMap.has(c.time) : null,
  };
  const fpDir = footprint.stackedDir === "buy" ? "Long" : footprint.stackedDir === "sell" ? "Short" : null;

  // ── Close estimate (display-only tool; RTH-day projection) ──
  const ce = closeEstAt(entryTs);
  const sd = sessionDayKey(entryTs);
  let closeEstimate: Record<string, unknown>;
  if (ce && ce.day.dayKey === sd) {
    const lo = Math.min(ce.day.estCloseHigh, ce.day.estCloseLow), hi = Math.max(ce.day.estCloseHigh, ce.day.estCloseLow);
    closeEstimate = {
      applicable: true, bandLo: lo, bandHi: hi, width: r2(hi - lo),
      priceVsBand: entry > hi ? "above" : entry < lo ? "below" : "inside",
      distToBand: entry > hi ? r2(entry - hi) : entry < lo ? r2(entry - lo) : 0,
      rthOpen: ce.day.rthOpen, priceVsOpen: r2(entry - ce.day.rthOpen),
      hod: ce.day.hod, lod: ce.day.lod, adjHigh: ce.adjHigh, adjLow: ce.adjLow, tightWide: null as string | null,
    };
  } else {
    closeEstimate = { applicable: false, reason: ce ? "no RTH bars yet for this session day (ETH/pre-open)" : "insufficient history", bandLo: null, bandHi: null, width: null, priceVsBand: null, distToBand: null, rthOpen: null, priceVsOpen: null, hod: null, lod: null, adjHigh: ce?.adjHigh ?? null, adjLow: ce?.adjLow ?? null, tightWide: null };
  }
  // Mean-reversion reading: above the band favors Short, below favors Long.
  const ceDir = closeEstimate.priceVsBand === "above" ? "Short" : closeEstimate.priceVsBand === "below" ? "Long" : null;

  // ── Day range ──
  const rangeSoFar = C.sdHi[i] - C.sdLo[i];
  const day = {
    rangeSoFar: r2(rangeSoFar), median: L.dayRangeMedian,
    rangeVsMedian: L.dayRangeMedian > 0 ? r2(rangeSoFar / L.dayRangeMedian) : null,
    sessionOpen: r2(C.sdOpen[i]), driftSoFar: r2(c.close - C.sdOpen[i]),
    driftOverRange: rangeSoFar > 0 ? r2(Math.abs(c.close - C.sdOpen[i]) / rangeSoFar) : null,
    posInRange: rangeSoFar > 0 ? r2((c.close - C.sdLo[i]) / rangeSoFar) : null,
  };
  // RAW day block (served primary-interval bars up to the fire bar, same session-day bucket).
  const RP = RAW[iv];
  const jp = asOfIndex(RP.times, c.time);
  const rawRange = jp >= 0 ? RP.sdHi[jp] - RP.sdLo[jp] : NaN;
  const dayRaw = jp < 0 ? null : {
    rangeSoFar: r2(rawRange),
    rangeVsMedian: L.dayRangeMedian > 0 ? r2(rawRange / L.dayRangeMedian) : null,
    sessionOpen: r2(RP.sdOpen[jp]), driftSoFar: r2(RP.candles[jp].close - RP.sdOpen[jp]),
    driftOverRange: rawRange > 0 ? r2(Math.abs(RP.candles[jp].close - RP.sdOpen[jp]) / rawRange) : null,
    posInRange: rawRange > 0 ? r2((RP.candles[jp].close - RP.sdLo[jp]) / rawRange) : null,
    rangeDiffVsEngine: r2(rawRange - rangeSoFar),
    fireBarInServed: RP.times[jp] === c.time,
  };

  const align = {
    yellowbox: alignOf(direction, ybDir),
    vector1m: vecAlign["1m"] ?? 0, vector5m: vecAlign["5m"] ?? 0, vector15m: vecAlign["15m"] ?? 0, vector60m: vecAlign["60m"] ?? 0,
    fractal: alignOf(direction, frDir), fco: alignOf(direction, fcoDir),
    fractalGeometry: Math.sign(fgAgreeN), ict: Math.sign(ictAlign), footprint: alignOf(direction, fpDir),
    closeEstimate: alignOf(direction, ceDir),
  };
  const alignScore = Object.values(align).reduce((a, b) => a + b, 0);
  const alignRaw = { vector1m: vecAlignRaw["1m"] ?? 0, vector5m: vecAlignRaw["5m"] ?? 0, vector15m: vecAlignRaw["15m"] ?? 0, vector60m: vecAlignRaw["60m"] ?? 0 };
  const engineView = {
    primaryDroppedInVecSpan39: primGap?.droppedInVecSpan39 ?? null,
    primaryDroppedInLast20: primGap?.droppedInLast20 ?? null,
    anySliceDroppedInVecSpan: Object.values(engineInputGaps).some(g => g != null && (g as { droppedInVecSpan39: number }).droppedInVecSpan39 > 0),
    bySlice: engineInputGaps,
  };
  return { yellowbox, vector, vectorRaw, fractal, fractalGeometry, ict, footprint, closeEstimate, chop, day, dayRaw, align, alignScore, alignRaw, engineInputGaps: engineView };
}

// ═══════════════════════════════ PATH (1m) ═══════════════════════════════════
// v2 (2026-10-01 verifier fix): the path walks the SERVER-SERVED 1m bars (grid / flat / spike /
// market-closed filters only) — the same bars server/catchup.ts resolves the live book on
// (served1m.candles). L.c1m is the CHART chain (buildBaseCandles), whose isolation filter
// drops ~3.5% of real 1m bars, preferentially inside fast moves; walking it flipped outcomes
// and biased expectancy low. L.c1m is kept only for the harnessOutcomeChartChain audit column.
const c1m = L.servedByIv["1m"] as unknown as FiringCandle[];
const t1m = c1m.map(c => c.time);
{
  const chartSet = new Set(L.t1m);
  const inWin = t1m.filter(t => t >= reportFromTs);
  console.log(`[ds] path bars: served 1m ${inWin.length} in window; chart chain (L.c1m) lacks ${inWin.filter(t => !chartSet.has(t)).length} of them`);
}
const b1m = new Float64Array(c1m.length);
for (let k = 0; k < c1m.length; k++) b1m[k] = etSessionDayBucket(c1m[k].time);
const covered1m = Math.min(c1m[c1m.length - 1].time + 60, nowSec);

function pathFor(entryTs: number, entry: number, isLong: boolean, tp1: number, sl: number, barSec: number) {
  const sdKey = sessionDayKey(entryTs);
  const settleTs = wall(sdKey, 17, 0);
  const apexTs = wall(sdKey, 16, 55);
  const hz: Record<string, { mfe: number | null; mae: number | null; mtm: number | null } | null> = {};
  const fav: Record<string, number | null> = {}, adv: Record<string, number | null> = {};
  for (const lv of LEVELS) { fav[lv] = null; adv[lv] = null; }
  const bounds: Array<{ key: string; t: number }> = [
    ...HORIZONS_MIN.map(h => ({ key: `${h}m`, t: entryTs + h * 60 })),
    { key: "sessionClose", t: settleTs }, { key: "apex1655", t: apexTs },
  ].sort((a, b) => a.t - b.t);
  let bi = 0;
  let mfe = 0, mae = 0, last = entry;
  let sessions = 0, curB = NaN;
  for (let j = lowerBound(t1m, entryTs); j < c1m.length; j++) {
    const b = c1m[j];
    const e = b.time + 60;
    if (e > covered1m) break;
    while (bi < bounds.length && e > bounds[bi].t) { hz[bounds[bi].key] = { mfe: r2(mfe), mae: r2(mae), mtm: r2((last - entry) * (isLong ? 1 : -1)) }; bi++; }
    if (b1m[j] !== curB) { curB = b1m[j]; sessions++; if (sessions > CROSS_MAX_SESSIONS) break; }
    const f = isLong ? b.high - entry : entry - b.low;
    const a = isLong ? entry - b.low : b.high - entry;
    if (f > mfe) mfe = f;
    if (a > mae) mae = a;
    const minute = (e - entryTs) / 60;
    for (const lv of LEVELS) {
      if (fav[lv] == null && f >= lv) fav[lv] = minute;
      if (adv[lv] == null && a >= lv) adv[lv] = minute;
    }
    last = b.close;
  }
  // Boundaries not reached inside the walk: covered by data (walk ended on the session cap) → final state; else unknown.
  while (bi < bounds.length) {
    hz[bounds[bi].key] = bounds[bi].t <= covered1m ? { mfe: r2(mfe), mae: r2(mae), mtm: r2((last - entry) * (isLong ? 1 : -1)) } : null;
    bi++;
  }
  const crossWindowComplete = sessions > CROSS_MAX_SESSIONS;

  const walk = (carry: boolean, settle: number) => {
    const w = walkOutcomeCanonical({
      bars: c1m, entryTs, entry, tp1, tp2: null, sl, isLong, settleTs: settle, barSec: 60,
      coveredThroughTs: covered1m, carryOvernight: carry, tp1Only: FACT_ENGINE_DEFAULTS.TP1_ONLY,
    });
    const pts = w.exitPrice == null ? null : r2((w.exitPrice - entry) * (isLong ? 1 : -1));
    // Gap-aware fill (v2): the canonical resolver fills at the level even when the exit bar
    // OPENED beyond it (overnight/weekend/halt gap-through). A resting stop then fills at the
    // open (worse); a resting TP limit fills at the open (better). The canonical outcome CLASS
    // is unchanged — only the price.
    let gapThrough = false, exitPxGap: number | null = w.exitPrice;
    let gapMinutesBefore: number | null = null;
    if (w.exitTs != null && w.exitPrice != null && (w.outcome === "loss" || w.outcome === "win_tp1")) {
      const xj = lowerBound(t1m, w.exitTs - 60);
      if (xj < c1m.length && t1m[xj] === w.exitTs - 60) {
        const xb = c1m[xj];
        gapMinutesBefore = xj > 0 ? (xb.time - (t1m[xj - 1] + 60)) / 60 : null;
        const lvl = w.exitPrice;
        if (w.outcome === "loss" ? (isLong ? xb.open < lvl : xb.open > lvl) : (isLong ? xb.open > lvl : xb.open < lvl)) {
          gapThrough = true; exitPxGap = xb.open;
        }
      }
    }
    const ptsGap = exitPxGap == null ? null : r2((exitPxGap - entry) * (isLong ? 1 : -1));
    return {
      outcome: w.outcome, exitTs: w.exitTs, exitTimeET: w.exitTs == null ? null : fmtEt(w.exitTs),
      exitPrice: r2(w.exitPrice), points: pts, pointsNet: pts == null ? null : r2(pts - FRICTION_PTS),
      gapThrough, gapMinutesBeforeExitBar: gapMinutesBefore, exitPriceGapAware: r2(exitPxGap),
      pointsGapAware: ptsGap, pointsNetGapAware: ptsGap == null ? null : r2(ptsGap - FRICTION_PTS),
      minutesToExit: w.exitTs == null ? null : (w.exitTs - entryTs) / 60,
      barsToExit: w.exitTs == null ? null : r2((w.exitTs - entryTs) / barSec),
      mae: r2(w.mae), mfe: r2(w.mfe),
    };
  };
  return {
    horizons: hz, firstFavorableMin: fav, firstAdverseMin: adv, crossWindowComplete,
    outcomeCarry: walk(true, settleTs),
    outcomeSession: walk(false, settleTs),
    outcomeApex: walk(false, apexTs),
  };
}

// ═══════════════════════════════ signal_history JOIN ═════════════════════════
type ShRow = Record<string, unknown> & { id: number; interval: string; timestamp: number; direction: string; entry: number; tp1: number; sl: number; source: string | null; outcome: string | null; points_result: number | null };
const shAll = db.prepare(`SELECT * FROM signal_history WHERE symbol=? AND timestamp>=? ORDER BY timestamp`).all(SYMBOL, reportFromTs - 86400) as ShRow[];
const shByKey = new Map<string, ShRow>(shAll.map(r => [`${r.interval}|${r.timestamp}|${r.direction}`, r]));
console.log(`[ds] signal_history rows since window start: ${shAll.length}`);

// ═══════════════════════════════ BUILD ROWS ══════════════════════════════════
const keyOf = (s: FactSignal): string => `${s.interval}|${s.time}|${s.direction}`;
const gatedMap = new Map<string, FactSignal>();
for (const iv of INTERVALS) for (const s of gatedByIv[iv]) if (s.time >= reportFromTs) gatedMap.set(keyOf(s), s);
const ungatedMap = new Map<string, FactSignal>();
for (const iv of INTERVALS) for (const s of ungatedByIv[iv]) if (s.time >= reportFromTs) ungatedMap.set(keyOf(s), s);

function identity(sig: FactSignal, inUngated: boolean) {
  const iv = sig.interval;
  const barSec = INTERVAL_SEC[iv];
  const entryTs = sig.time + barSec;
  const p = etParts(entryTs);
  const dateET = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  const sdKey = sessionDayKey(entryTs);
  const counted = sig.facts.filter(f => f.counted);
  const combo = sig.comboKey ?? comboKeyOf(sig.facts);
  const classAllowed = qualityGateAllows(sig.signalType, iv, counted.length, QUALITY_GATE);
  const comboExempt = sig.signalType === "zone-reaction" || sig.signalType === "vector-side-entry";
  const comboAllowed = comboExempt || comboGateAllows(combo, iv, QUALITY_GATE);
  const cc = QUALITY_GATE.comboClasses ?? {};
  const comboVerdictScope = comboExempt ? "exempt" : cc[`${combo}@${iv}`] ? "combo@interval" : cc[combo] ? "combo(all-interval)" : "none(thin/absent→allowed)";
  const verdict = !classAllowed ? "class-blocked" : !comboAllowed ? "combo-blocked" : "allowed";
  const gated = gatedMap.has(keyOf(sig));
  const gateReason = gated ? "fired-in-gated-pass"
    : verdict !== "allowed" ? verdict
    : "allowed-but-not-fired-in-gated-pass (cooldown/one-open/HOD-LOD chain differs once blocked fires are removed)";
  let anchor = "default";
  try { anchor = (JSON.parse(sig.confirmations) as { anchor?: string }).anchor ?? "default"; } catch { /* default */ }
  const dz = dayZoneAt(sig.time);
  const ybFact = sig.facts.some(f => f.strategy === "yellowbox");
  const isLong = sig.direction === "Long";
  return {
    key: keyOf(sig),
    inUngated, gated,
    half: dateET < HALF2_FROM_KEY ? "H1" : "H2",
    fireTs: sig.time, entryTs, fireTimeUtc: new Date(sig.time * 1000).toISOString(),
    dateET, timeET: `${pad(p.hh)}:${pad(p.mm)}`, sessionDay: sdKey,
    weekday: WEEKDAY_NAMES[weekdayOfKey(dateET)],
    interval: iv, direction: sig.direction, session: sig.session,
    minutesSinceRthOpen: Math.round((entryTs - wall(sdKey, 9, 30)) / 60),
    minutesToSettle: Math.round((wall(sdKey, 17, 0) - entryTs) / 60),
    signalType: sig.signalType, comboKey: combo, countedFactCount: counted.length,
    driverKinds: [...new Set(sig.facts.filter(f => f.driver && f.counted).map(f => `${f.strategy}:${f.kind}`))].join(";"),
    confidence: sig.confidence,
    gateClassKey: classKey(sig.signalType, iv),
    gateClassAllowed: classAllowed, gateComboAllowed: comboAllowed, gateComboScope: comboVerdictScope,
    gateVerdict: verdict, gateReason,
    deadTape: (sig.riskFlags ?? []).includes("dead-tape"),
    riskFlags: (sig.riskFlags ?? []).join(";"),
    suggestedContracts: sig.suggestedContracts ?? null,
    entry: sig.price, tp1: sig.tp1, sl: sig.sl,
    tpDist: r2(Math.abs(sig.tp1 - sig.price)), slDist: r2(Math.abs(sig.sl - sig.price)),
    rr: r2(Math.abs(sig.tp1 - sig.price) / Math.max(0.25, Math.abs(sig.sl - sig.price))),
    exitAnchor: anchor,
    ybAnchorLevel: ybFact && dz ? (isLong ? dz.initRes : dz.initSup) : null,
    label: sig.label,
    // v2: engineOutcome/enginePoints are overwritten per row with the SERVED-bar carry walk of the
    // engine's bracket (== path.outcomeCarry, the catch-up resolver's view). The harness's own
    // value (walked on the isolation-filtered chart chain) is kept for audit only.
    engineOutcome: sig.outcome as string | null, enginePoints: (sig.pointsResult ?? null) as number | null,
    harnessOutcomeChartChain: sig.outcome, harnessPointsChartChain: sig.pointsResult ?? null,
    facts: sig.facts.map((f: Fact) => ({ strategy: f.strategy, kind: f.kind, direction: f.direction, counted: f.counted, driver: f.driver, interval: f.interval, primary: f.primary, level: f.level ?? null, label: f.label })),
  };
}

const rows: Array<Record<string, unknown>> = [];
const allSigs: Array<{ sig: FactSignal; inUngated: boolean }> = [];
for (const s of ungatedMap.values()) allSigs.push({ sig: s, inUngated: true });
let gatedOnly = 0;
for (const [k, s] of gatedMap) if (!ungatedMap.has(k)) { allSigs.push({ sig: s, inUngated: false }); gatedOnly++; }
allSigs.sort((a, b) => a.sig.time - b.sig.time || a.sig.interval.localeCompare(b.sig.interval));
console.log(`[ds] ungated fires in window: ${ungatedMap.size}; gated fires: ${gatedMap.size}; gated-only (not in ungated pass): ${gatedOnly}`);

const missingStatus: string[] = [];
for (const { sig, inUngated } of allSigs) {
  const id = identity(sig, inUngated);
  const C = CTX[sig.interval];
  const i = lowerBound(C.times, sig.time);
  const status = i < C.times.length && C.times[i] === sig.time
    ? strategyStatus(sig.interval, i, sig.price, sig.direction, id.entryTs)
    : (missingStatus.push(id.key), null);
  const pathRes = pathFor(id.entryTs, sig.price, sig.direction === "Long", sig.tp1, sig.sl, INTERVAL_SEC[sig.interval]);
  const sh = shByKey.get(id.key);
  rows.push({
    ...id,
    engineOutcome: pathRes.outcomeCarry.outcome, enginePoints: pathRes.outcomeCarry.points,
    status,
    path: pathRes,
    signalHistory: sh ? {
      exists: true, id: sh.id, source: sh.source, outcome: sh.outcome, points: sh.points_result,
      entry: sh.entry, tp1: sh.tp1, sl: sh.sl, signalType: sh.signal_type, comboKey: sh.combo_key,
      bracketMatches: Math.abs(sh.entry - sig.price) < 0.01 && Math.abs(sh.tp1 - sig.tp1) < 0.01 && Math.abs(sh.sl - sig.sl) < 0.01,
    } : { exists: false, id: null, source: null, outcome: null, points: null, entry: null, tp1: null, sl: null, signalType: null, comboKey: null, bracketMatches: null },
  });
}
// close-estimate tight/wide: relative to the dataset median band width (applicable rows only).
{
  const ws = rows.map(r => (r.status as { closeEstimate?: { width?: number | null } } | null)?.closeEstimate?.width).filter((w): w is number => typeof w === "number").sort((a, b) => a - b);
  const med = ws.length ? ws[Math.floor(ws.length / 2)] : null;
  for (const r of rows) {
    const ce = (r.status as { closeEstimate?: { width?: number | null; tightWide?: string | null } } | null)?.closeEstimate;
    if (ce && typeof ce.width === "number" && med != null) ce.tightWide = ce.width <= med ? "tight" : "wide";
  }
  console.log(`[ds] close-estimate median band width (tight/wide split): ${med}`);
}
console.log(`[ds] rows built: ${rows.length}  ${elapsed()}`);

// ═══════════════════════════════ LIVE BOOK 30d ═══════════════════════════════
const liveFrom = nowSec - LIVE_BOOK_DAYS * 86400;
const liveRows = db.prepare(`SELECT * FROM signal_history WHERE symbol=? AND timestamp>=? ORDER BY timestamp`).all(SYMBOL, liveFrom) as ShRow[];
const liveOut: Array<Record<string, unknown>> = [];
for (const r of liveRows) {
  const iv = r.interval as Interval;
  if (!INTERVAL_SEC[iv]) { liveOut.push({ ...r, status: null, path: null, note: "unknown interval" }); continue; }
  const barSec = INTERVAL_SEC[iv];
  const entryTs = r.timestamp + barSec;
  const dir = r.direction as "Long" | "Short";
  const C = CTX[iv];
  const i = lowerBound(C.times, r.timestamp);
  const onBar = i < C.times.length && C.times[i] === r.timestamp;
  const p = etParts(entryTs);
  const dateET = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  const k = `${iv}|${r.timestamp}|${dir}`;
  const ug = ungatedMap.get(k), gt = gatedMap.get(k);
  liveOut.push({
    ...r,
    entryTs, dateET, timeET: `${pad(p.hh)}:${pad(p.mm)}`, half: dateET < HALF2_FROM_KEY ? "H1" : "H2",
    session: etWallClock(entryTs).mins >= 570 && etWallClock(entryTs).mins < 1020 && etWallClock(entryTs).wd >= 1 && etWallClock(entryTs).wd <= 5 ? "RTH" : "ETH",
    onReplayBarGrid: onBar,
    replayUngatedFired: !!ug, replayGatedFired: !!gt,
    replayBracketMatches: ug ? Math.abs(ug.price - r.entry) < 0.01 && Math.abs(ug.tp1 - r.tp1) < 0.01 && Math.abs(ug.sl - r.sl) < 0.01 : null,
    replayFacts: ug ? ug.facts.map(f => ({ strategy: f.strategy, kind: f.kind, direction: f.direction, counted: f.counted, driver: f.driver, interval: f.interval, level: f.level ?? null, label: f.label })) : null,
    status: onBar ? strategyStatus(iv, i, r.entry, dir, entryTs) : null,
    path: pathFor(entryTs, r.entry, dir === "Long", r.tp1, r.sl, barSec),
  });
}
console.log(`[ds] live-book rows (last ${LIVE_BOOK_DAYS}d): ${liveOut.length}  ${elapsed()}`);

// ═══════════════════════════════ VALIDATION ══════════════════════════════════
const problems: string[] = [];
function scanNaN(o: unknown, where: string): void {
  if (typeof o === "number") { if (!Number.isFinite(o) && o !== Infinity && o !== -Infinity) problems.push(`NaN at ${where}`); else if (!Number.isFinite(o)) problems.push(`Infinity at ${where}`); return; }
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) scanNaN(v, `${where}.${k}`);
}
for (const r of rows) {
  const iv = r.interval as Interval;
  if ((r.fireTs as number) % INTERVAL_SEC[iv] !== 0) problems.push(`off-grid fireTs ${r.key}`);
  for (const f of ["entry", "tp1", "sl"]) if (!Number.isFinite(r[f] as number)) problems.push(`bad ${f} ${r.key}`);
  scanNaN(r.path, `${r.key}.path`);
  scanNaN(r.status, `${r.key}.status`);
}
for (const r of liveOut) scanNaN(r.path, `live ${r.id}.path`);
const countBy = (xs: Array<Record<string, unknown>>, f: (r: Record<string, unknown>) => string): Record<string, number> => {
  const o: Record<string, number> = {}; for (const r of xs) { const k = f(r); o[k] = (o[k] ?? 0) + 1; } return o;
};
// v2 diagnostics: chart-chain vs served-bar outcome flips, headline stats, live-book agreement.
type OC = { outcome: string | null; points: number | null; pointsNet: number | null; pointsNetGapAware: number | null; gapThrough: boolean };
const ocOf = (r: Record<string, unknown>): OC => (r.path as { outcomeCarry: OC }).outcomeCarry;
const flips: Record<string, number> = {};
for (const r of rows) {
  const a = r.harnessOutcomeChartChain as string, b = ocOf(r).outcome as string;
  if (a !== b) flips[`${a}->${b}`] = (flips[`${a}->${b}`] ?? 0) + 1;
}
function stats(xs: Array<Record<string, unknown>>, gapAware = false) {
  const closed = xs.filter(r => { const o = ocOf(r).outcome; return o === "win_tp1" || o === "loss"; });
  const pts = closed.map(r => (gapAware ? ocOf(r).pointsNetGapAware : ocOf(r).pointsNet) as number);
  const wins = closed.filter(r => ocOf(r).outcome === "win_tp1").length;
  const pos = pts.filter(p => p > 0).reduce((a, b) => a + b, 0), neg = -pts.filter(p => p < 0).reduce((a, b) => a + b, 0);
  return { n: closed.length, open: xs.length - closed.length, winPct: closed.length ? r2((100 * wins) / closed.length) : null, expNet: closed.length ? r2(pts.reduce((a, b) => a + b, 0) / closed.length) : null, pf: neg > 0 ? r2(pos / neg) : null };
}
const headline: Record<string, unknown> = {};
for (const [pop, f] of [["ungated", (r: Record<string, unknown>) => r.inUngated === true], ["gated", (r: Record<string, unknown>) => r.gated === true]] as const) {
  for (const h of ["H1", "H2"]) {
    const xs = rows.filter(r => f(r) && r.half === h);
    headline[`${pop}.${h}`] = { carry: stats(xs), carryGapAware: stats(xs, true) };
    for (const iv of INTERVALS) headline[`${pop}.${h}.${iv}`] = { carry: stats(xs.filter(r => r.interval === iv)), carryGapAware: stats(xs.filter(r => r.interval === iv), true) };
  }
}
const gapThroughRows = rows.filter(r => ocOf(r).gapThrough).length;
const liveAgree = { compared: 0, match: 0, mismatches: {} as Record<string, number> };
for (const r of liveOut) {
  const p = r.path as { outcomeCarry: OC } | null;
  if (!p || r.outcome == null) continue;
  liveAgree.compared++;
  if (r.outcome === p.outcomeCarry.outcome) liveAgree.match++;
  else { const k = `${r.outcome}->${p.outcomeCarry.outcome}`; liveAgree.mismatches[k] = (liveAgree.mismatches[k] ?? 0) + 1; }
}
const egRows = rows.filter(r => r.inUngated && r.status);
const engineGapSummary: Record<string, unknown> = {};
for (const iv of INTERVALS) {
  const xs = egRows.filter(r => r.interval === iv);
  const st = (r: Record<string, unknown>) => r.status as { engineInputGaps: { primaryDroppedInLast20: number | null; anySliceDroppedInVecSpan: boolean }; vectorRaw: Record<string, { diffVsEngine: number | null } | null>; dayRaw: { rangeDiffVsEngine: number | null } | null };
  engineGapSummary[iv] = {
    rows: xs.length,
    primaryLast20HasDropped: xs.filter(r => (st(r).engineInputGaps.primaryDroppedInLast20 ?? 0) > 0).length,
    anySliceVecSpanHasDropped: xs.filter(r => st(r).engineInputGaps.anySliceDroppedInVecSpan).length,
    anyVectorDiffGe5: xs.filter(r => Object.values(st(r).vectorRaw).some(v => v != null && Math.abs(v.diffVsEngine ?? 0) >= 5)).length,
    dayRangeDiffGe5: xs.filter(r => Math.abs(st(r).dayRaw?.rangeDiffVsEngine ?? 0) >= 5).length,
  };
}
const ybStale = rows.filter(r => { const y = (r.status as { yellowbox?: { recompute?: { maxAbsDiffVsUsed: number | null } | null } } | null)?.yellowbox?.recompute; return y != null && (y.maxAbsDiffVsUsed ?? 0) > 0.011; });
const ybStalePosFlip = ybStale.filter(r => { const y = (r.status as { yellowbox: { position: string; recompute: { position: string } } }).yellowbox; return y.position !== y.recompute.position; }).length;
console.log(`[ds] rows on a day whose cached zone differs from a current-bar recompute: ${ybStale.length} (position differs on ${ybStalePosFlip})`);
console.log(`[ds] outcome flips chart-chain -> served: ${JSON.stringify(flips)}; gap-through exits ${gapThroughRows}`);
console.log(`[ds] headline (carry, net): ${["ungated.H1", "ungated.H2", "gated.H1", "gated.H2"].map(k => `${k} ${JSON.stringify((headline[k] as { carry: unknown }).carry)} gapAware ${JSON.stringify((headline[k] as { carryGapAware: unknown }).carryGapAware)}`).join(" | ")}`);
console.log(`[ds] live-book stored outcome vs served carry walk: ${liveAgree.match}/${liveAgree.compared} match ${JSON.stringify(liveAgree.mismatches)}`);
console.log(`[ds] engine-input gaps (ungated rows): ${JSON.stringify(engineGapSummary)}`);
const perIvUngated = countBy(rows.filter(r => r.inUngated), r => r.interval as string);
const perIvGated = countBy(rows.filter(r => r.gated), r => r.interval as string);
console.log(`[ds] VALIDATION: ungated rows per interval ${JSON.stringify(perIvUngated)}; gated rows per interval ${JSON.stringify(perIvGated)}; problems ${problems.length}${problems.length ? " e.g. " + problems.slice(0, 5).join(" | ") : ""}; status missing ${missingStatus.length}`);

// ═══════════════════════════════ WRITE ═══════════════════════════════════════
fs.mkdirSync(OUT_DIR, { recursive: true });
function flatten(o: unknown, prefix: string, out: Record<string, unknown>): void {
  if (o === null || o === undefined) { if (prefix) out[prefix] = ""; return; }
  if (Array.isArray(o)) { out[prefix] = JSON.stringify(o); return; }
  if (typeof o === "object") { for (const [k, v] of Object.entries(o as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out); return; }
  out[prefix] = o;
}
function writeCsv(file: string, objs: Array<Record<string, unknown>>): string[] {
  const flats = objs.map(o => { const f: Record<string, unknown> = {}; flatten(o, "", f); return f; });
  const cols: string[] = []; const seen = new Set<string>();
  for (const f of flats) for (const k of Object.keys(f)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const esc = (v: unknown): string => {
    if (v === undefined || v === null) return "";
    const s = typeof v === "string" ? v : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const f of flats) lines.push(cols.map(c => esc(f[c])).join(","));
  fs.writeFileSync(file, lines.join("\n"));
  return cols;
}
const runtimeSec = Math.round((Date.now() - t0) / 1000);
const meta = {
  generatedAt: new Date().toISOString(), runtimeSec, symbol: SYMBOL,
  window: { from: REPORT_FROM_KEY, to: new Date(covered1m * 1000).toISOString(), halves: { H1: `${REPORT_FROM_KEY}..2026-08-12`, H2: `${HALF2_FROM_KEY}..present` } },
  engine: { settings: FACT_ENGINE_DEFAULTS, gateGeneratedAt: QUALITY_GATE.generatedAt, gateSource: QUALITY_GATE.source, ungatedPass: "qualityGateEnabled:false, gateData:QUALITY_GATE (shipped exits)", gatedPass: "qualityGateEnabled:true, gateData:QUALITY_GATE" },
  inputs: {
    dataSpan: L.dataSpan, dayRangeMedian: L.dayRangeMedian, dayRangeMedianDays: L.dayRangeMedianDays,
    footprintCoverage: L.fpCoverage, computedYbKeys: L.computedYbKeys.length, dayZones: L.dayZones.length,
  },
  counts: { rows: rows.length, ungated: ungatedMap.size, gated: gatedMap.size, gatedOnly, perIntervalUngated: perIvUngated, perIntervalGated: perIvGated, liveBook: liveOut.length },
  frictionPtsPerTrade: FRICTION_PTS, horizonsMin: HORIZONS_MIN, crossLevelsPts: LEVELS, crossMaxSessions: CROSS_MAX_SESSIONS,
  validation: { problems: problems.slice(0, 50), problemCount: problems.length, statusMissing: missingStatus },
  v2: {
    pathBars: "server-served 1m (L.servedByIv['1m']: grid/flat/spike/market-closed filters only — the catch-up resolver's bars); NOT the isolation-filtered chart chain",
    outcomeFlipsChartChainToServed: flips, gapThroughExits: gapThroughRows,
    headline, liveBookOutcomeAgreement: liveAgree,
    dayZoneRepair: zoneRepair, rowsOnStaleCachedZoneDays: ybStale.length, rowsStaleZonePositionDiffers: ybStalePosFlip,
    engineInputGapSummary: engineGapSummary,
  },
};
fs.writeFileSync(path.join(OUT_DIR, "signals-3mo.json"), JSON.stringify({ meta, rows }));
const csvCols = writeCsv(path.join(OUT_DIR, "signals-3mo.csv"), rows.map(r => { const { facts, ...rest } = r; return { ...rest, factsJson: JSON.stringify(facts) }; }));
fs.writeFileSync(path.join(OUT_DIR, "signals-3mo.columns.json"), JSON.stringify(csvCols, null, 1));
fs.writeFileSync(path.join(OUT_DIR, "live-book-30d.json"), JSON.stringify({ meta: { ...meta, liveFromTs: liveFrom }, rows: liveOut }));
console.log(`[ds] wrote ${OUT_DIR}\\signals-3mo.json/.csv (${rows.length} rows, ${csvCols.length} CSV columns) + live-book-30d.json (${liveOut.length})`);

// 10-row sample
const sample = rows.filter(r => r.inUngated).filter((_, k, a) => k % Math.max(1, Math.floor(a.length / 10)) === 0).slice(0, 10);
for (const r of sample) {
  const p = r.path as ReturnType<typeof pathFor>;
  const st = r.status as ReturnType<typeof strategyStatus> | null;
  console.log(`  ${r.dateET} ${r.timeET} ${r.interval} ${r.direction} ${r.session} ${r.signalType} ${r.comboKey} n=${r.countedFactCount} gated=${r.gated} e=${r.entry} tp=${r.tp1} sl=${r.sl} | carry=${p.outcomeCarry.outcome} ${p.outcomeCarry.points} sess=${p.outcomeSession.outcome} ${p.outcomeSession.points} apex=${p.outcomeApex.outcome} ${p.outcomeApex.points} | mfe30=${p.horizons["30m"]?.mfe} mae30=${p.horizons["30m"]?.mae} | yb=${st?.yellowbox.position} align=${st?.alignScore} sh=${(r.signalHistory as { exists: boolean; source: string | null }).exists ? (r.signalHistory as { source: string }).source : "-"}`);
}
db.close();
console.log(`[ds] DONE runtime ${elapsed()}`);
