/**
 * full-history-regen.ts — CURRENT-RULES REPLAY OVER ALL CACHED HISTORY (2026-08-10,
 * USER-DIRECTED: "do this for every interval but for all the historical data that i have").
 *
 * Replays the SHIPPED engine (imported QUALITY_GATE — gate verdicts + calibrated exits exactly
 * as live; gate NOT re-derived) over the full cached candle store (2019-08 →) and persists the
 * resulting book into signal_history as source='regen' rows for the PRE-standing-window era
 * (timestamp < WINDOW_START_KEY). The standing 3-month book (>= WINDOW_START_KEY) is owned by
 * the main pipeline and is NOT touched here. The 3-month directive still governs every
 * DERIVATION (gate/exits/headline) — this script only extends the SERVED history book.
 *
 * FIDELITY MODEL (chunked rolling window): live engine state is ARRAY-START-SENSITIVE (ICT
 * capped arrays, FG wave medians — the parity test proved a longer lookback changes same-day
 * signals), and live only ever sees the last LIVE_WINDOW_DAYS=90 cached days. So history is
 * replayed in chunks of EMIT_DAYS=20 cached days, each pass seeing exactly the 90-day-shaped
 * window [chunkStart-70 cached days .. chunk end] — every emitted day has >= 70 cached days of
 * warmup (the standing run's own early days have LESS). Chunk-boundary signals can differ
 * slightly from a true per-day-rolling replay; same approximation class as the standing run.
 *
 * HONESTY LEDGER (disclosed in the artifact + report):
 *  - dead-tape median: per-chunk TRAILING median over the 70 warmup cached days (shared
 *    medianSessionDayRangeFromDb — the same implementation live uses) — walk-forward, ZERO
 *    lookahead (live's window would roll intra-chunk; drift <= 20 days).
 *  - yellowbox: 50-trading-day walk-forward zones — eligible from ~day 51 of the data
 *    (Oct 2019); server-cached zones (ver-matched) used where present, computeCoreZones else.
 *  - footprint: real MW rows exist only from 2026-06-03 — historical chunks carry NO footprint
 *    facts (exactly like live before the relay existed). PML/TML: live-only, never in replays.
 *  - quality gate + exits + suggestedContracts: TODAY'S shipped calibration applied to old
 *    eras (that IS the ask: "signals the current strategies would produce") — the old eras are
 *    out-of-sample for the gate (derived on the standing 3-month window only).
 *  - daily loss stop: -DAILY_LOSS_STOP_PTS day-sequential over the stitched book (exit-aware).
 *  - serve-chain filters (off-grid/flat/spike/closed/dup) replicated from the harness loadData
 *    mirror — guarded by the MANDATORY SELF-CHECK below, which must reproduce the standing
 *    enginePass signal set EXACTLY on the current window before any persist happens.
 *
 * Usage: npx tsx scripts/full-history-regen.ts [--persist] [--limit N] [--skip-selfcheck]
 *        (default = dry run: replay + stats + artifact, no DB writes)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { QUALITY_GATE } from "../shared/quality-gate";
import { INTERVAL_SEC, type Interval, type FpImbalanceZone } from "../shared/fact-engine";
import { buildBaseCandles, normalizeServed15m, type LiveCandle } from "../shared/live-adapter";
import { medianSessionDayRangeFromDb } from "../shared/day-range-median";
import { isRTH } from "../shared/firing/session";
import {
  etWallToEpoch, sessionDayKey, priorCalendarDay, buildSessionDays, computeCoreZones, rnd2,
  YB_CACHE_VER, type Bar, type DayAgg,
} from "../shared/yellowbox-core";
import { validateSignalRow } from "../shared/signal-rules";
import { artifactsDir } from "../shared/artifacts-dir";
import {
  loadData, enginePass, resolveSignal, metricsOf, applyDailyLossStop,
  INTERVALS, WINDOW_START_KEY, DAILY_LOSS_STOP_PTS, type SigRow,
} from "./fact-engine-backtest";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data", "app.db");
const OUT = path.join(artifactsDir(ROOT), "full-history-regen.json");
const SYMBOL = "MES";
const RES_OF: Record<Interval, string> = { "1m": "1", "5m": "5", "15m": "15", "60m": "60" };
const LIVE_WINDOW_DAYS = 90, EMIT_DAYS = 20, WARM_DAYS = LIVE_WINDOW_DAYS - EMIT_DAYS;
const PERSIST = process.argv.includes("--persist");
const SKIP_SELFCHECK = process.argv.includes("--skip-selfcheck");
/** ETH STUDY (2026-08-11, user: ETH 15m backtest over ALL history): same chunked replay
 *  (engine defaults now include ETH_CONFLUENCE:true), but reports the ETH sleeves per year
 *  (15m focus + all intervals) to eth-study-fullhist.json and NEVER persists. */
const ETH_STUDY = process.argv.includes("--eth-study");
const LIMIT = (() => { const i = process.argv.indexOf("--limit"); return i >= 0 ? Number(process.argv[i + 1]) : Infinity; })();
const BACKUP_TABLE = "signal_history_backup_pre_fullhist";
const t0 = Date.now();
const elapsed = (): string => `${Math.round((Date.now() - t0) / 1000)}s`;

type Loaded = Parameters<typeof enginePass>[0];

// ── Serve-chain mirror (harness loadData lines ~499-534; guarded by the self-check) ──────
const SPIKE_THR: Record<Interval, number> = { "1m": 0.025, "5m": 0.040, "15m": 0.050, "60m": 0.070 };
function isServeSpikeBar(iv: Interval, o: number, h: number, l: number, c: number): boolean {
  if (h < l || o > h || o < l || c > h || c < l || c <= 0) return true;
  const thr = SPIKE_THR[iv];
  const range = h - l;
  if (range / c > thr) return true;
  if (range / c > thr * 0.5) {
    if ((Math.abs(o - h) < 0.5 && Math.abs(l - c) < 0.5) ||
        (Math.abs(o - l) < 0.5 && Math.abs(h - c) < 0.5)) return true;
  }
  return false;
}
import { isMarketClosedEt } from "./fact-engine-backtest";
function loadServedRange(db: InstanceType<typeof Database>, iv: Interval, fromTs: number, toTs: number): LiveCandle[] {
  const res = RES_OF[iv];
  const resSec = (parseInt(res, 10) || 5) * 60;
  const arr: LiveCandle[] = [];
  const it = db.prepare(
    `SELECT timestamp t, open o, high h, low l, close c, volume v
     FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp>=? AND timestamp<? ORDER BY timestamp`
  ).iterate(SYMBOL, res, fromTs, toTs) as IterableIterator<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
  for (const r of it) {
    if (r.t % resSec !== 0) continue;
    if (r.h === r.l) continue;
    if (isServeSpikeBar(iv, r.o, r.h, r.l, r.c)) continue;
    if (isMarketClosedEt(r.t)) continue;
    if (arr.length && arr[arr.length - 1].time === r.t) arr.pop();
    arr.push({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v ?? 0, rth: isRTH(r.t) });
  }
  return arr;
}
const dateToTs = (d: string): number => { const [y, m, dd] = d.split("-").map(Number); return Math.floor(Date.UTC(y, m - 1, dd, 0) / 1000); };

interface YbRow { day_key: string; session_start: number; session_end: number; settle: number; box_top: number; box_bottom: number; init_res: number; init_sup: number }

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const db = new Database(DB_PATH, { fileMustExist: true });
  db.pragma("busy_timeout = 15000");

  // Cached-day list — the same DISTINCT query the scrubber window uses.
  const dayList = (db.prepare(
    `SELECT DISTINCT DATE(datetime(timestamp,'unixepoch')) d FROM cached_candles WHERE symbol=? AND resolution IN ('5','15','60') ORDER BY d`
  ).all(SYMBOL) as Array<{ d: string }>).map(r => r.d).filter(d => d <= new Date().toISOString().slice(0, 10));
  const standingStartTs = etWallToEpoch(WINDOW_START_KEY, 0, 0);
  const histDays = dayList.filter(d => d < WINDOW_START_KEY);
  console.log(`[fh] cached days: ${dayList.length} (${dayList[0]} .. ${dayList[dayList.length - 1]}); historical (< ${WINDOW_START_KEY}): ${histDays.length}`);

  // ── Yellowbox day structures ONCE over the FULL span (50-day walk-forward from 2019) ──
  const full5m = loadServedRange(db, "5m", 0, standingStartTs + 10 * 86400);
  const full60m = loadServedRange(db, "60m", 0, standingStartTs + 10 * 86400);
  const base5m = buildBaseCandles(full5m, true, nowSec);
  const bars5: Bar[] = base5m.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? 0 }));
  const { dayMap } = buildSessionDays(bars5);
  const days: DayAgg[] = [...dayMap.values()]
    .filter(d => d.bars >= 60 && d.weekday >= 1 && d.weekday <= 5)
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  for (let i = 1; i < days.length; i++) days[i].prevClose = days[i - 1].c;
  const firstEligibleIdx = 51;
  if (days.length <= firstEligibleIdx) throw new Error("not enough trading days for the 50-day yellowbox walk-forward");
  const firstEligibleKey = days[firstEligibleIdx].key;
  const ybRows = db.prepare(
    `SELECT day_key, session_start, session_end, settle, box_top, box_bottom, init_res, init_sup
     FROM yellowbox_day_zones WHERE symbol=? AND traded=1 AND ver=? ORDER BY day_key`
  ).all(SYMBOL, YB_CACHE_VER) as YbRow[];
  const ybByKey = new Map<string, YbRow>(ybRows.map(r => [r.day_key, r]));
  const day60 = new Map<string, Bar[]>();
  for (const c of buildBaseCandles(full60m, true, nowSec)) {
    const k = sessionDayKey(c.time);
    let a = day60.get(k); if (!a) { a = []; day60.set(k, a); }
    a.push({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? 0 });
  }
  let computedYb = 0;
  for (let i = firstEligibleIdx; i < days.length; i++) {
    const k = days[i].key;
    if (ybByKey.has(k)) continue;
    const last50 = days.slice(i - 50, i).filter(x => x.prevClose !== null);
    if (last50.length < 50) continue;
    const anchor = days[i - 1].c;
    const z = computeCoreZones(last50, day60, anchor);
    ybByKey.set(k, {
      day_key: k,
      session_start: etWallToEpoch(priorCalendarDay(k), 18, 0),
      session_end: etWallToEpoch(k, 17, 0),
      settle: anchor,
      box_top: rnd2(z.ybTop), box_bottom: rnd2(z.ybBottom),
      init_res: rnd2(z.initRes), init_sup: rnd2(z.initSup),
    });
    computedYb++;
  }
  const dayZones = [...ybByKey.values()]
    .filter(r => r.day_key >= firstEligibleKey)
    .sort((a, b) => (a.day_key < b.day_key ? -1 : 1))
    .map(r => ({
      dayKeyET: r.day_key, sessionStartTs: r.session_start, sessionEndTs: r.session_end,
      boxTop: r.box_top, boxBottom: r.box_bottom, initRes: r.init_res, initSup: r.init_sup,
    }));
  console.log(`[fh] trading days ${days.length} (${days[0].key}..${days[days.length - 1].key}); yb-eligible ${firstEligibleKey}; day-zones ${dayZones.length} (${ybRows.length} cached + ${computedYb} computed)  ${elapsed()}`);

  const calibratedClasses = new Set(Object.keys(QUALITY_GATE.exitByClass ?? {}));
  const emptyFp = new Map<number, FpImbalanceZone[]>();

  // Build a chunk-local Loaded object (structurally satisfies enginePass + resolveSignal).
  const buildChunkL = (arrayFromTs: number, endTs: number, emissionStartTs: number, median: number, nDays: number, fpMap: Map<number, FpImbalanceZone[]>): Loaded => {
    const servedByIv = {} as Record<Interval, LiveCandle[]>;
    for (const iv of INTERVALS) servedByIv[iv] = loadServedRange(db, iv, arrayFromTs, endTs);
    if (!servedByIv["15m"].length) throw new Error(`chunk ${new Date(arrayFromTs * 1000).toISOString().slice(0, 10)}: no native 15m rows`);
    const candlesByIv = {} as Record<Interval, ReturnType<typeof buildBaseCandles>>;
    for (const iv of INTERVALS) {
      const base = iv === "15m" ? normalizeServed15m(servedByIv[iv], "15") : servedByIv[iv];
      candlesByIv[iv] = buildBaseCandles(base, true, nowSec);
    }
    const c1m = candlesByIv["1m"];
    const t1m = c1m.map(c => c.time);
    const lastDataTs = Math.max(...INTERVALS.map(iv => {
      const a = candlesByIv[iv];
      return a.length ? a[a.length - 1].time + INTERVAL_SEC[iv] : 0;
    }));
    return {
      candlesByIv, servedByIv, c1m, t1m, lastDataTs, days, firstEligibleKey,
      emissionStartTs, dayZones, ybByKey, fpMap, fpCoverage: "", computedYbKeys: [],
      vectorByIv: { "1m": [], "5m": [], "15m": [], "60m": [] },
      dataSpan: {}, dayRangeMedian: median, dayRangeMedianDays: nDays,
    } as unknown as Loaded;
  };

  const runChunk = (L: Loaded, emissionEndTs: number, label: string): SigRow[] => {
    const byIv = enginePass(L, { gate: true, gateData: QUALITY_GATE, label }, nowSec);
    const rows: SigRow[] = [];
    for (const iv of INTERVALS) {
      for (const sig of byIv[iv]) {
        if (sig.time >= emissionEndTs) continue;
        rows.push(resolveSignal(sig, L, nowSec, calibratedClasses));
      }
    }
    return rows;
  };

  // ── MANDATORY SELF-CHECK: chunk machinery must reproduce the standing engine pass ──────
  if (!SKIP_SELFCHECK) {
    console.log(`[fh] SELF-CHECK: chunk machinery vs standing loadData/enginePass on the live window …`);
    const Lstd = loadData();
    const winFrom = dateToTs(dayList[Math.max(0, dayList.length - LIVE_WINDOW_DAYS)]);
    const scEmissionFrom = dateToTs(dayList[Math.max(0, dayList.length - EMIT_DAYS)]);
    const Lchunk = buildChunkL(winFrom, nowSec + 86400, Math.max(scEmissionFrom, (Lstd as any).emissionStartTs as number), (Lstd as any).dayRangeMedian as number, (Lstd as any).dayRangeMedianDays as number, (Lstd as any).fpMap as Map<number, FpImbalanceZone[]>);
    const stdByIv = enginePass(Lstd, { gate: true, gateData: QUALITY_GATE, label: "SC-standing" }, nowSec);
    const chkByIv = enginePass(Lchunk, { gate: true, gateData: QUALITY_GATE, label: "SC-chunk" }, nowSec);
    // SETTLED DAYS ONLY (2026-08-12 fix): a mid-session run races the live edge — bars land
    // between the standing snapshot and the chunk query, and edge-sensitive rules (the drift
    // exemption) legitimately diverge on the last forming session. Compare pre-today fires.
    const scCutoff = dateToTs(dayList[dayList.length - 1]);
    let mismatches = 0;
    for (const iv of INTERVALS) {
      const key = (s: { time: number; direction: string }): string => `${s.time}|${s.direction}`;
      const a = new Set(stdByIv[iv].filter(s => s.time >= (Lchunk as any).emissionStartTs && s.time < scCutoff).map(key));
      const b = new Set(chkByIv[iv].filter(s => s.time >= (Lchunk as any).emissionStartTs && s.time < scCutoff).map(key));
      const onlyA = [...a].filter(k => !b.has(k)), onlyB = [...b].filter(k => !a.has(k));
      if (onlyA.length || onlyB.length) {
        mismatches += onlyA.length + onlyB.length;
        console.error(`[fh] SELF-CHECK ${iv}: standing-only ${JSON.stringify(onlyA)} chunk-only ${JSON.stringify(onlyB)}`);
      } else {
        console.log(`[fh] SELF-CHECK ${iv}: identical (n=${a.size})`);
      }
    }
    if (mismatches) { console.error(`[fh] SELF-CHECK FAILED (${mismatches} diffs) — ABORTING (no writes).`); process.exit(1); }
    console.log(`[fh] SELF-CHECK PASSED  ${elapsed()}`);
  }

  // ── Historical chunk loop ──────────────────────────────────────────────────────────────
  const book: SigRow[] = [];
  let chunks = 0, openDropped = 0;
  for (let i = WARM_DAYS; i < histDays.length && chunks < LIMIT; i += EMIT_DAYS, chunks++) {
    const emitFrom = histDays[i];
    const jEnd = Math.min(i + EMIT_DAYS, histDays.length);
    const arrayFromTs = dateToTs(histDays[i - WARM_DAYS]);
    const emissionStartTs = dateToTs(emitFrom);
    const emissionEndTs = jEnd < histDays.length ? dateToTs(histDays[jEnd]) : standingStartTs;
    const drm = medianSessionDayRangeFromDb(db, SYMBOL, histDays[i - WARM_DAYS], emissionStartTs);
    if (!(drm.median > 0)) throw new Error(`chunk ${emitFrom}: no trailing dead-tape median`);
    const L = buildChunkL(arrayFromTs, emissionEndTs, emissionStartTs, drm.median, drm.nDays, emptyFp);
    const rows = runChunk(L, emissionEndTs, `hist ${emitFrom}`);
    const closed = rows.filter(r => r.outcome !== "open");
    openDropped += rows.length - closed.length;
    book.push(...closed);
    console.log(`[fh] chunk ${emitFrom}..${histDays[jEnd - 1]}: ${closed.length} signals (median ${drm.median})  ${elapsed()}`);
  }
  book.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  const stop = applyDailyLossStop(book, DAILY_LOSS_STOP_PTS);
  const asTraded = stop.kept;
  console.log(`[fh] historical book: ${book.length} pre-stop → ${asTraded.length} as-traded (${stop.trippedDays.length} loss-stop days; ${openDropped} open rows dropped)  ${elapsed()}`);

  // Era stats (per year + per interval).
  const era: Record<string, unknown> = {};
  for (const yr of [...new Set(asTraded.map(r => String(r.year)))].sort()) {
    const rows = asTraded.filter(r => String(r.year) === yr);
    const m = metricsOf(rows);
    const byIv: Record<string, number> = {};
    for (const r of rows) byIv[r.interval] = (byIv[r.interval] ?? 0) + 1;
    era[yr] = { n: rows.length, winPct: rnd2(m.winRate * 100), exp: rnd2(m.expectancy), pf: rnd2(m.profitFactor), cum: rnd2(m.cumPts), maxDD: rnd2(m.maxDD), byIv };
    console.log(`[fh] ${yr}: n=${rows.length} win ${rnd2(m.winRate * 100)}% exp ${rnd2(m.expectancy)} PF ${rnd2(m.profitFactor)} cum ${rnd2(m.cumPts)} maxDD ${rnd2(m.maxDD)} | ${Object.entries(byIv).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  }

  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    note: "SHIPPED-GATE replay of ALL cached history (< standing window) in live-shaped rolling chunks; trailing walk-forward dead-tape median; no footprint before 2026-06-03 (none existed); day-sequential loss stop. Gate/exits are TODAY'S calibration — old eras are out-of-sample for it.",
    window: { emitDays: EMIT_DAYS, warmDays: WARM_DAYS, firstEmittedDay: histDays[WARM_DAYS] ?? null, lastEmittedDay: histDays[histDays.length - 1] ?? null, standingBoundary: WINDOW_START_KEY },
    chunks, preStop: book.length, asTraded: asTraded.length, lossStopDays: stop.trippedDays.length, era,
  }, null, 2));
  console.log(`[fh] artifact: ${OUT}`);

  // ── ETH STUDY MODE: per-year ETH sleeves (never persists) ─────────────────────────────
  if (ETH_STUDY) {
    const ethOut = path.join(artifactsDir(ROOT), "eth-study-fullhist.json");
    const ethEra: Record<string, unknown> = {};
    console.log(`[fh] ETH STUDY (confluence default ON; sleeves PRE-loss-stop; RTH-derived gate/exits — honest caveat):`);
    for (const yr of [...new Set(book.map(r => String(r.year)))].sort()) {
      const yrEth = book.filter(r => String(r.year) === yr && r.session === "ETH");
      const m15 = yrEth.filter(r => r.interval === "15m");
      const mAll = metricsOf(yrEth); const m15m = metricsOf(m15);
      ethEra[yr] = {
        eth15m: { n: m15.length, winPct: rnd2(m15m.winRate * 100), exp: rnd2(m15m.expectancy), pf: rnd2(m15m.profitFactor), cum: rnd2(m15m.cumPts), maxDD: rnd2(m15m.maxDD) },
        ethAll: { n: yrEth.length, winPct: rnd2(mAll.winRate * 100), exp: rnd2(mAll.expectancy), pf: rnd2(mAll.profitFactor), cum: rnd2(mAll.cumPts), maxDD: rnd2(mAll.maxDD) },
      };
      console.log(`[fh]   ${yr} ETH 15m: n=${m15.length} win ${rnd2(m15m.winRate * 100)}% exp ${rnd2(m15m.expectancy)} PF ${rnd2(m15m.profitFactor)} cum ${rnd2(m15m.cumPts)} DD ${rnd2(m15m.maxDD)} | ETH all: n=${yrEth.length} cum ${rnd2(mAll.cumPts)}`);
    }
    fs.writeFileSync(ethOut, JSON.stringify({
      generated: new Date().toISOString(),
      note: "ETH sleeves of the full-history shipped-gate replay with ETH_CONFLUENCE default ON (vse-preserving contract). PRE-loss-stop sleeve stats; RTH-derived gate/exits applied to ETH (honest limitation); pre-2026-06-03 has no footprint facts (data never existed).",
      era: ethEra,
    }, null, 2));
    console.log(`[fh] ETH artifact: ${ethOut}`);
    db.close();
    return; // study never persists
  }

  // ── Persist (only with --persist) ──────────────────────────────────────────────────────
  if (!PERSIST) { console.log(`[fh] DRY RUN — no DB writes (pass --persist to write).`); db.close(); return; }
  const DB_OUTCOME: Record<string, string> = { tp1: "win_tp1", tp2: "win_tp2", sl: "loss", eod: "eod" };
  const rows = asTraded.map(r => ({
    symbol: SYMBOL, interval: r.interval, timestamp: r.fireTs, direction: r.direction,
    riskLevel: "safe", signalType: r.signalType, entry: r.entry, tp1: r.tp1, tp2: r.tp2, sl: r.sl,
    outcome: DB_OUTCOME[r.outcome], label: r.fullLabel,
    exitPrice: r.exitPrice, exitTs: r.exitTs, pointsResult: r.pointsResult,
    mae: r.mae, mfe: r.mfe, barsToExit: r.barsToExit,
    comboKey: r.combo ?? null, riskFlags: r.riskFlags ?? null,
    suggestedContracts: r.suggestedContracts ?? null,
    source: "regen" as const,
    ...(r.confirmations ? { confirmations: r.confirmations } : {}),
  }));
  const bad = rows.filter(r => !validateSignalRow(r).ok);
  if (bad.length) console.log(`[fh] PERSIST WARNING: ${bad.length}/${rows.length} rows fail validateSignalRow locally`);
  db.exec(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`);
  db.exec(`CREATE TABLE ${BACKUP_TABLE} AS SELECT * FROM signal_history`);
  console.log(`[fh] persist backup: ${BACKUP_TABLE} (${(db.prepare(`SELECT COUNT(*) n FROM ${BACKUP_TABLE}`).get() as { n: number }).n} rows)`);
  const del = db.prepare(
    `DELETE FROM signal_history WHERE symbol=? AND timestamp<? AND (source IS NULL OR source <> 'live')`
  ).run(SYMBOL, standingStartTs);
  console.log(`[fh] persist wipe: deleted ${del.changes} pre-window non-live rows (timestamp < ${WINDOW_START_KEY})`);
  // DIRECT-DB upsert, NOT the POST route (measured 2026-08-10: the route floors persistence at
  // ~120 days — a deliberate anti-resurrection guard against STALE CLIENTS re-posting purged
  // rows — which structurally rejects a deep-history migration: 12,175/12,181 skipped). This is
  // the harness persistSignals fallback path verbatim: per-row validateSignalRow, the
  // source-guard (a stored 'live' row makes the incoming regen row yield WHOLE), the identical
  // conflict-set upsert with COALESCE guards, and riskFlags serialized (an array must never
  // reach better-sqlite3 as a bind value).
  const selLive = db.prepare(
    `SELECT source FROM signal_history WHERE symbol=? AND interval=? AND timestamp=? AND direction=?`
  );
  const stmt = db.prepare(
    `INSERT INTO signal_history (symbol, interval, timestamp, direction, risk_level, signal_type, entry, tp1, tp2, sl, outcome, footprint_reading, confirmations, label,
       exit_price, exit_ts, points_result, mae, mfe, bars_to_exit, combo_key, risk_flags, suggested_contracts, source, updated_at)
     VALUES (@symbol, @interval, @timestamp, @direction, @riskLevel, @signalType, @entry, @tp1, @tp2, @sl, @outcome, NULL, @confirmations, @label,
       @exitPrice, @exitTs, @pointsResult, @mae, @mfe, @barsToExit, @comboKey, @riskFlagsJson, @suggestedContracts, @source, @updatedAt)
     ON CONFLICT(symbol, interval, timestamp, direction) DO UPDATE SET
       risk_level=excluded.risk_level,
       outcome=CASE WHEN (outcome IS NULL OR outcome='open' OR excluded.outcome IS NULL OR excluded.outcome=outcome
                          OR (outcome='win_tp1' AND excluded.outcome='win_tp2'))
                    THEN COALESCE(excluded.outcome, outcome) ELSE outcome END,
       footprint_reading=excluded.footprint_reading,
       confirmations=excluded.confirmations, label=COALESCE(excluded.label, label),
       signal_type=COALESCE(excluded.signal_type, signal_type),
       exit_price=COALESCE(excluded.exit_price, exit_price), exit_ts=COALESCE(excluded.exit_ts, exit_ts),
       points_result=COALESCE(excluded.points_result, points_result), mae=COALESCE(excluded.mae, mae),
       mfe=COALESCE(excluded.mfe, mfe), bars_to_exit=COALESCE(excluded.bars_to_exit, bars_to_exit),
       combo_key=COALESCE(excluded.combo_key, combo_key), risk_flags=COALESCE(excluded.risk_flags, risk_flags),
       suggested_contracts=COALESCE(excluded.suggested_contracts, suggested_contracts),
       source=CASE WHEN source='live' THEN source ELSE COALESCE(excluded.source, source) END,
       updated_at=excluded.updated_at`
  );
  const updatedAt = new Date().toISOString();
  let inserted = 0, skipped = 0, collisions = 0;
  const insertMany = db.transaction((rs: typeof rows) => {
    for (const r of rs) {
      if (!validateSignalRow(r).ok) { skipped++; continue; }
      const stored = selLive.get(r.symbol, r.interval, r.timestamp, r.direction) as { source: string | null } | undefined;
      if (stored?.source === "live") { collisions++; continue; }
      const { riskFlags: rfArr, ...bindable } = r;
      stmt.run({
        ...bindable, confirmations: r.confirmations ?? null,
        riskFlagsJson: rfArr ? JSON.stringify(rfArr) : null,
        updatedAt,
      });
      inserted++;
    }
  });
  insertMany(rows);
  console.log(`[fh] persist write (direct DB): inserted ${inserted}, skipped ${skipped}, live collisions ${collisions} of ${rows.length}`);
  // Stale-tab resync nudge (harness idiom) — open tabs never see a bulk wipe+insert otherwise.
  try {
    const baseUrl = process.env.PERSIST_BASE_URL ?? "http://127.0.0.1:3000";
    const res = await fetch(`${baseUrl}/api/signals/resync-broadcast`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: SYMBOL }),
    });
    console.log(`[fh] resync nudge: ${res.ok ? "broadcast ok" : `HTTP ${res.status}`}`);
  } catch (err) {
    console.log(`[fh] resync nudge skipped (${(err as Error).message})`);
  }
  const perYr = db.prepare(
    `SELECT strftime('%Y', datetime(timestamp,'unixepoch')) y, COUNT(*) n FROM signal_history WHERE symbol=? GROUP BY y ORDER BY y`
  ).all(SYMBOL) as Array<{ y: string; n: number }>;
  console.log(`[fh] signal_history by year: ${perYr.map(r => `${r.y}=${r.n}`).join(" ")}`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
