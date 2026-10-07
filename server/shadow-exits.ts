/**
 * SHADOW EXITS (2026-10-01 — user-approved R5 + the exit-MC candidates; RECORD ONLY).
 *
 * For every fire in signal_history, record how a small set of ALTERNATIVE SINGLE exits would have
 * resolved on the real 1m path, next to a re-walk of the shipped bracket, so a candidate can be
 * judged at ~150 clean trades WITHOUT touching the live exits. Nothing here places, sizes, moves
 * or cancels an order, and nothing here writes signal_history — the only table written is
 * signal_shadow_exits (DDL in server/db.ts).
 *
 * SCORING (TP1-only; the same touch rules as shared/outcome-resolver.ts walkOutcomeCanonical and
 * scripts/analysis/exit-monte-carlo.ts, which validated 978/978 against the canonical outcomes):
 *   • the walk starts at the first 1m bar with time >= entryTs (fire bar time + interval); an exit
 *     stamps at bar.time + 60; bars whose close-time is beyond the data horizon are never read;
 *   • stop and target touched in the SAME 1m bar = stop first;
 *   • the INITIAL stop and the target fill AT the level (gap-through included — canonical);
 *   • a MOVED stop (breakeven / trail) acts from the NEXT bar and fills at the bar's OPEN when the
 *     bar opens through it (conservative — exit-MC convention);
 *   • time stop: no touch within N minutes → flat at the close of the last bar that started before
 *     entryTs + N min; Apex mode: flat at the close of the last bar before 16:55 ET of the entry's
 *     session day (Globex day key — post-18:00 ET bars belong to the next day);
 *   • two modes: "carry" (the live record contract — rides overnight until TP/SL) and "apex1655".
 *
 * OUTCOME VOCABULARY: win_tp1 (target filled) · loss (initial stop filled) · open (not resolved
 * yet) · closed (a market/moved-stop exit: time stop, Apex flat, breakeven or trail stop — the
 * sign lives in `points`, the cause in `exit_reason`). The summary counts a WIN as points > 0.
 *
 * THREAD: resolvePending() is called (fire-and-forget) from catchup.ts computeCatchup, which runs
 * in the live-engine WORKER thread (inline main-thread fallback only while the worker is down).
 * It is NOT part of the worker's serialized request chain once the catch-up reply is posted, and
 * it yields (setImmediate) every CHUNK_BUDGET_MS so neither thread is held for more than ~100 ms.
 * IMPORT DISCIPLINE: this module imports ONLY ./db and pure @shared/* (it loads in the worker).
 */
import { db } from "./db";
import { INTERVAL_SEC, type Interval } from "@shared/fact-engine";
import { isRTH, etWallClock } from "@shared/firing/session";
import { sessionDayKey, etWallToEpoch } from "@shared/yellowbox-core";

const SYMBOL = "MES";
const TICK = 0.25;
const EPS = 1e-9;
export const FRICTION_PTS = 1.0;
/** Fires older than this are not resolved (the summary's default window is 90 days). */
export const SHADOW_LOOKBACK_SEC = Number(process.env.SHADOW_EXITS_LOOKBACK_DAYS ?? 92) * 86400;
/** Per-pass bound — newest pending fires first. */
export const SHADOW_MAX_ROWS_PER_PASS = 400;
/** A carry walk that is still untouched this long after entry (with data beyond) is recorded as a
 *  FINAL open ("horizon") — the exit-MC MAX_HOLD. */
export const SHADOW_MAX_HOLD_SEC = 40 * 86400;
/** Cooperative yield budget per synchronous chunk. */
export const CHUNK_BUDGET_MS = 80;
/** Hour-scaled stop: trailing window + minimum sample count of that ET hour's 60-minute ranges. */
export const HOUR_STOP_LOOKBACK_SEC = 60 * 86400;
export const HOUR_STOP_MIN_SAMPLES = 10;
/** A fire with no 1m bar within this long of its entry is a data hole; once the hole is older
 *  than NO_DATA_FINAL_AFTER_SEC (gap-heal had its chance) it is recorded as a final open. */
const NO_DATA_WINDOW_SEC = 75 * 60; // spans the 17:00–18:00 ET halt
const NO_DATA_FINAL_AFTER_SEC = 86400;

export type ShadowMode = "carry" | "apex1655";
export const SHADOW_MODES: ShadowMode[] = ["carry", "apex1655"];
export type ShadowOutcome = "win_tp1" | "loss" | "open" | "closed";
export type ShadowExitReason = "tp" | "sl" | "be" | "trail" | "time" | "apex_flat" | "horizon" | "no-data" | "bad-levels" | null;
/** exit_reason values that make an "open" row FINAL (never re-walked). */
export const FINAL_OPEN_REASONS = ["horizon", "no-data", "bad-levels"] as const;

export interface ShadowVariant {
  id: string;
  /** Target distance in points; "shipped" = the row's own tp1 distance; null = no fixed target. */
  tp: number | "shipped" | null;
  /** Initial stop distance in points; "shipped" = the row's own sl distance. */
  sl: number | "shipped";
  /** Breakeven: once MFE >= beAt pts, the stop moves to entry (acts from the next bar). */
  beAt?: number;
  /** Trail: once MFE >= m pts, the stop trails g pts behind the best price (from the next bar). */
  trail?: { m: number; g: number };
  /** Time stop: flat at market after this many minutes if neither level touched. */
  timeStopMin?: number;
  /** ETH fires only: initial stop = mult × trailing-60-day median 60-minute range of the entry's
   *  ET hour (target = shipped). RTH fires keep the shipped bracket as-is. */
  ethHourStopMult?: number;
}

/** THE variant list (exit-MC 2026-10-01 held-out survivors + the approved R5 hour-scaled stop).
 *  Every variant is recorded for EVERY interval; the id's interval names the sleeve it was
 *  selected on (judge it there — the other intervals are context). "shipped" is the baseline the
 *  summary compares against on the SAME rows (re-walked here so the Apex mode exists for it). */
export const SHADOW_VARIANTS: ShadowVariant[] = [
  { id: "shipped", tp: "shipped", sl: "shipped" },
  { id: "mc-1m-be9-tp10-sl11", tp: 10, sl: 11, beAt: 9 },
  { id: "mc-5m-trail-m18-g3-sl12", tp: null, sl: 12, trail: { m: 18, g: 3 } },
  { id: "mc-15m-time240-tp30-sl22", tp: 30, sl: 22, timeStopMin: 240 },
  { id: "mc-60m-time240-tp30-sl18", tp: 30, sl: 18, timeStopMin: 240 },
  { id: "eth-hourstop-1.5x", tp: "shipped", sl: "shipped", ethHourStopMult: 1.5 },
  { id: "eth-hourstop-2x", tp: "shipped", sl: "shipped", ethHourStopMult: 2 },
];
export const BASELINE_VARIANT = "shipped";

// ───────────────────────────── PURE WALKER ─────────────────────────────

export interface ShadowBar { time: number; open: number; high: number; low: number; close: number }

export interface ShadowWalkArgs {
  bars: ShadowBar[];            // 1m, ascending
  entryTs: number;
  entry: number;
  isLong: boolean;
  tpDist: number | null;        // null = no fixed target
  slDist: number;
  beAt?: number;
  trail?: { m: number; g: number };
  timeStopMin?: number;
  /** Apex flat time (16:55 ET of the entry's session day); null/undefined = carry. */
  apexCutTs?: number | null;
  /** Data horizon — bars with time + 60 > this are never read. */
  coveredThroughTs: number;
  maxHoldSec?: number;
}

export interface ShadowWalkResult {
  outcome: ShadowOutcome;
  exitReason: ShadowExitReason;
  exitTs: number | null;
  exitPrice: number | null;
  points: number | null;
  mae: number;
  mfe: number;
  tpPrice: number | null;
  slPrice: number;
}

const rnd2 = (v: number): number => Math.round(v * 100) / 100;

function lowerBound(bars: ShadowBar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].time < t) lo = m + 1; else hi = m; }
  return lo;
}

/** One exit variant, one mode, one fire — bar by bar over the real 1m path. */
export function walkShadowExit(a: ShadowWalkArgs): ShadowWalkResult {
  const { bars, entryTs, entry, isLong, coveredThroughTs } = a;
  const dir = isLong ? 1 : -1;
  const tpPrice = a.tpDist == null ? null : entry + dir * a.tpDist;
  const slPrice = entry - dir * a.slDist;
  let stop = slPrice;
  let stopKind: "sl" | "be" | "trail" = "sl";
  let mae = 0, mfe = 0;
  let lastClose = entry, lastCloseTs = entryTs, walked = 0;
  const timeLim = a.timeStopMin != null && a.timeStopMin > 0 ? entryTs + a.timeStopMin * 60 : Infinity;
  const apexLim = a.apexCutTs != null ? a.apexCutTs : Infinity;
  const cutLim = Math.min(timeLim, apexLim);
  const cutReason: ShadowExitReason = apexLim <= timeLim ? "apex_flat" : "time";
  const holdLim = a.maxHoldSec != null && a.maxHoldSec > 0 ? entryTs + a.maxHoldSec : Infinity;

  const done = (outcome: ShadowOutcome, exitReason: ShadowExitReason, exitPrice: number | null, exitTs: number | null): ShadowWalkResult => ({
    outcome, exitReason, exitTs, exitPrice: exitPrice == null ? null : rnd2(exitPrice),
    points: exitPrice == null ? null : rnd2(dir * (exitPrice - entry)),
    mae: rnd2(mae), mfe: rnd2(mfe), tpPrice: tpPrice == null ? null : rnd2(tpPrice), slPrice: rnd2(slPrice),
  });
  const flat = (): ShadowWalkResult => walked === 0
    ? done("closed", cutReason, entry, entryTs)
    : done("closed", cutReason, lastClose, lastCloseTs);

  for (let j = lowerBound(bars, entryTs); j < bars.length; j++) {
    const b = bars[j];
    if (b.time + 60 > coveredThroughTs) break;            // never read beyond the data horizon
    if (b.time >= cutLim) return flat();                    // time stop / Apex flat reached
    if (b.time >= holdLim) return done("open", "horizon", null, null);
    if (isLong) { mae = Math.max(mae, entry - b.low); mfe = Math.max(mfe, b.high - entry); }
    else { mae = Math.max(mae, b.high - entry); mfe = Math.max(mfe, entry - b.low); }

    // Stop FIRST (same-bar stop + target = stop).
    const slHit = isLong ? b.low <= stop + EPS : b.high >= stop - EPS;
    if (slHit) {
      if (stopKind === "sl") return done("loss", "sl", stop, b.time + 60);
      const fill = isLong ? Math.min(stop, b.open) : Math.max(stop, b.open); // gapped through a moved stop → the open
      return done("closed", stopKind, fill, b.time + 60);
    }
    if (tpPrice != null && (isLong ? b.high >= tpPrice - EPS : b.low <= tpPrice + EPS)) {
      return done("win_tp1", "tp", tpPrice, b.time + 60);
    }
    lastClose = b.close; lastCloseTs = b.time + 60; walked++;

    // Stop moves act from the NEXT bar.
    if (a.beAt != null && mfe >= a.beAt - EPS) {
      if (isLong ? entry > stop : entry < stop) { stop = entry; stopKind = "be"; }
    }
    if (a.trail && mfe >= a.trail.m - EPS) {
      const t = entry + dir * (mfe - a.trail.g);
      if (isLong ? t > stop : t < stop) { stop = t; stopKind = "trail"; }
    }
  }
  if (cutLim <= coveredThroughTs) return flat();
  return done("open", null, null, null);
}

// ───────────────────────────── HOUR-SCALED STOP ─────────────────────────────

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function etHourOf(ts: number): number { return Math.floor(etWallClock(ts).mins / 60); }

/** Median 60-minute range (high − low) of the ET hour containing `entryTs`, over the trailing
 *  60 days STRICTLY before that hour (no lookahead). Native 60m bars first; when they carry fewer
 *  than HOUR_STOP_MIN_SAMPLES samples, the hours are rebuilt from 1m bars. null = not enough data. */
export function hourMedianRange(entryTs: number, cache?: Map<number, number | null>): { median: number | null; samples: number; hour: number } {
  const hs = Math.floor(entryTs / 3600) * 3600;
  const hour = etHourOf(hs);
  const hit = cache?.get(hs);
  const from = hs - HOUR_STOP_LOOKBACK_SEC;
  const client = db.$client;
  let ranges: number[] = [];
  if (hit !== undefined) return { median: hit, samples: -1, hour };
  const r60 = client.prepare(
    `SELECT timestamp, high, low FROM cached_candles WHERE symbol=? AND resolution='60' AND timestamp>=? AND timestamp<?`,
  ).all(SYMBOL, from, hs) as Array<{ timestamp: number; high: number; low: number }>;
  for (const r of r60) if (etHourOf(r.timestamp) === hour && r.high >= r.low) ranges.push(r.high - r.low);
  if (ranges.length < HOUR_STOP_MIN_SAMPLES) {
    // Fallback: rebuild that ET hour from 1m bars, one small range read per prior day (± 1 h for a
    // DST shift) instead of 60 days of 1m in one read (~170 ms measured).
    const q1 = client.prepare(
      `SELECT timestamp, high, low FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<?`);
    const agg = new Map<number, { hi: number; lo: number }>();
    for (let d = 1; d <= Math.round(HOUR_STOP_LOOKBACK_SEC / 86400); d++) {
      const base = hs - d * 86400;
      const r1 = q1.all(SYMBOL, Math.max(from, base - 3600), Math.min(hs, base + 7200)) as Array<{ timestamp: number; high: number; low: number }>;
      for (const r of r1) {
        const h = Math.floor(r.timestamp / 3600) * 3600;
        if (etHourOf(h) !== hour) continue;
        const g = agg.get(h);
        if (!g) agg.set(h, { hi: r.high, lo: r.low });
        else { if (r.high > g.hi) g.hi = r.high; if (r.low < g.lo) g.lo = r.low; }
      }
    }
    if (agg.size > ranges.length) ranges = [...agg.values()].map(g => g.hi - g.lo);
  }
  const med = ranges.length >= HOUR_STOP_MIN_SAMPLES ? median(ranges) : null;
  cache?.set(hs, med);
  return { median: med, samples: ranges.length, hour };
}

/** Initial stop distance of an ETH hour-scaled variant (tick-rounded, >= 1 tick). */
export function hourScaledStopDist(med: number, mult: number): number {
  return Math.max(TICK, Math.round((mult * med) / TICK) * TICK);
}

// ───────────────────────────── PENDING RESOLVER ─────────────────────────────

interface FireRow { interval: string; timestamp: number; direction: string; entry: number; tp1: number; sl: number }
interface StoredRow { variant: string; mode: string; outcome: string; exit_reason: string | null; exit_ts: number | null; exit_price: number | null; points: number | null; mae: number | null; mfe: number | null; tp_price: number | null; sl_price: number | null; ref_entry: number; ref_tp1: number; ref_sl: number }

export interface ShadowPassStats {
  ran: boolean; candidates: number; firesWalked: number; rowsWritten: number;
  noData: number; tookMs: number; chunks: number; error?: string;
}

let running = false;
const yieldTick = (): Promise<void> => new Promise<void>(r => setImmediate(r));
const apexCache = new Map<string, number>();
export function apexCutOf(entryTs: number): number {
  const k = sessionDayKey(entryTs);
  let v = apexCache.get(k);
  if (v === undefined) { v = etWallToEpoch(k, 16, 55); if (apexCache.size > 5000) apexCache.clear(); apexCache.set(k, v); }
  return v;
}

const variantIn = (): string => SHADOW_VARIANTS.map(() => "?").join(",");
const isFinal = (outcome: string, reason: string | null): boolean =>
  outcome !== "open" || (reason != null && (FINAL_OPEN_REASONS as readonly string[]).includes(reason));

/** Resolve the newest ≤ SHADOW_MAX_ROWS_PER_PASS fires that lack a FINAL row for every
 *  variant × mode (at their CURRENT shipped levels). Idempotent: final rows are never rewritten,
 *  and a row whose recomputed values equal the stored ones is not written. Never throws. */
export async function resolvePending(nowSec: number, opts: { limit?: number; budgetMs?: number } = {}): Promise<ShadowPassStats> {
  const t0 = Date.now();
  const stats: ShadowPassStats = { ran: false, candidates: 0, firesWalked: 0, rowsWritten: 0, noData: 0, tookMs: 0, chunks: 1 };
  if (running) return { ...stats, error: "already running" };
  running = true;
  try {
    stats.ran = true;
    const client = db.$client;
    const limit = Math.max(1, Math.min(opts.limit ?? SHADOW_MAX_ROWS_PER_PASS, SHADOW_MAX_ROWS_PER_PASS));
    const budget = opts.budgetMs ?? CHUNK_BUDGET_MS;
    const ids = SHADOW_VARIANTS.map(v => v.id);
    const need = SHADOW_VARIANTS.length * SHADOW_MODES.length;
    const fires = client.prepare(
      `SELECT s.interval, s.timestamp, s.direction, s.entry, s.tp1, s.sl FROM signal_history s
        WHERE s.symbol=? AND s.timestamp>=? AND s.timestamp<=?
          AND s.entry IS NOT NULL AND s.tp1 IS NOT NULL AND s.sl IS NOT NULL
          AND (SELECT COUNT(*) FROM signal_shadow_exits x
                WHERE x.symbol=s.symbol AND x.interval=s.interval AND x.timestamp=s.timestamp AND x.direction=s.direction
                  AND x.variant IN (${variantIn()})
                  AND x.ref_entry=s.entry AND x.ref_tp1=s.tp1 AND x.ref_sl=s.sl
                  AND (x.outcome<>'open' OR x.exit_reason IN ('horizon','no-data','bad-levels'))) < ?
        ORDER BY s.timestamp DESC LIMIT ?`,
    ).all(SYMBOL, nowSec - SHADOW_LOOKBACK_SEC, nowSec, ...ids, need, limit) as FireRow[];
    stats.candidates = fires.length;
    if (!fires.length) return stats;

    const lastBar = client.prepare(`SELECT MAX(timestamp) AS t FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp<=?`)
      .get(SYMBOL, nowSec) as { t: number | null } | undefined;
    // Conservative horizon (resolveStuckRows convention): the newest 1m bar may still be forming.
    const covered = Math.min(lastBar?.t ?? 0, nowSec);
    const barsQ = client.prepare(
      `SELECT timestamp AS time, open, high, low, close FROM cached_candles
        WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<? ORDER BY timestamp`);
    const firstBarQ = client.prepare(
      `SELECT timestamp FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<? LIMIT 1`);
    const storedQ = client.prepare(
      `SELECT variant, mode, outcome, exit_reason, exit_ts, exit_price, points, mae, mfe, tp_price, sl_price, ref_entry, ref_tp1, ref_sl
         FROM signal_shadow_exits WHERE symbol=? AND interval=? AND timestamp=? AND direction=?`);
    const upsert = client.prepare(
      `INSERT INTO signal_shadow_exits (symbol, interval, timestamp, direction, variant, mode, session, ref_entry, ref_tp1, ref_sl,
         tp_price, sl_price, outcome, exit_reason, exit_ts, exit_price, points, mae, mfe, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(symbol, interval, timestamp, direction, variant, mode) DO UPDATE SET
         session=excluded.session, ref_entry=excluded.ref_entry, ref_tp1=excluded.ref_tp1, ref_sl=excluded.ref_sl,
         tp_price=excluded.tp_price, sl_price=excluded.sl_price, outcome=excluded.outcome, exit_reason=excluded.exit_reason,
         exit_ts=excluded.exit_ts, exit_price=excluded.exit_price, points=excluded.points, mae=excluded.mae, mfe=excluded.mfe,
         updated_at=excluded.updated_at`);
    const hourCache = new Map<number, number | null>();
    let chunkStart = Date.now();

    for (const f of fires) {
      if (Date.now() - chunkStart >= budget) { await yieldTick(); stats.chunks++; chunkStart = Date.now(); }
      const ivSec = INTERVAL_SEC[f.interval as Interval];
      if (!ivSec) continue;
      const entryTs = f.timestamp + ivSec;
      const isLong = String(f.direction ?? "").toLowerCase().startsWith("l");
      const dir = isLong ? 1 : -1;
      const shipTp = dir * (f.tp1 - f.entry), shipSl = dir * (f.entry - f.sl);
      const session = isRTH(f.timestamp) ? "RTH" : "ETH";
      const storedRows = storedQ.all(SYMBOL, f.interval, f.timestamp, f.direction) as StoredRow[];
      const stored = new Map(storedRows.map(r => [`${r.variant}|${r.mode}`, r]));
      const sameRefs = (r: StoredRow): boolean => r.ref_entry === f.entry && r.ref_tp1 === f.tp1 && r.ref_sl === f.sl;

      type Out = { v: ShadowVariant; mode: ShadowMode; res: ShadowWalkResult };
      const outs: Out[] = [];
      const finalOpen = (reason: ShadowExitReason, slP: number, tpP: number | null): ShadowWalkResult =>
        ({ outcome: "open", exitReason: reason, exitTs: null, exitPrice: null, points: null, mae: 0, mfe: 0, tpPrice: tpP, slPrice: slP });

      if (!(shipTp > 0 && shipSl > 0)) {
        for (const v of SHADOW_VARIANTS) for (const mode of SHADOW_MODES) outs.push({ v, mode, res: finalOpen("bad-levels", f.sl, f.tp1) });
      } else {
        // Data-hole guard (resolveStuckRows coverage-guard analogue): no 1m bar near the entry.
        const near = firstBarQ.get(SYMBOL, entryTs, entryTs + NO_DATA_WINDOW_SEC);
        if (!near && entryTs + NO_DATA_WINDOW_SEC <= covered) {
          stats.noData++;
          if (covered - entryTs < NO_DATA_FINAL_AFTER_SEC) continue; // let gap-heal fill it first
          for (const v of SHADOW_VARIANTS) for (const mode of SHADOW_MODES) outs.push({ v, mode, res: finalOpen("no-data", f.sl, f.tp1) });
        } else {
          // Path: grow the window (1 → 4 → 16 → 41 days) only while some variant is still open (41 > the
          // 40-day max hold, so a horizon verdict needs a real bar past it).
          const apexCut = apexCutOf(entryTs);
          const levels = SHADOW_VARIANTS.map(v => {
            let tpDist: number | null = v.tp === "shipped" ? shipTp : v.tp;
            let slDist: number | null = v.sl === "shipped" ? shipSl : v.sl;
            if (v.ethHourStopMult != null && session === "ETH") {
              const hm = hourMedianRange(entryTs, hourCache);
              slDist = hm.median == null ? null : hourScaledStopDist(hm.median, v.ethHourStopMult);
              tpDist = shipTp;
            }
            return { v, tpDist, slDist };
          });
          for (const spanDays of [1, 4, 16, 41]) {
            // A long-open carry trade reads up to 41 days of 1m (~120 ms measured) — yield first when
            // this slice is already spent, so one slice stays ≈ budget + one load.
            if (spanDays > 1 && Date.now() - chunkStart >= budget) { await yieldTick(); stats.chunks++; chunkStart = Date.now(); }
            const toTs = Math.min(entryTs + spanDays * 86400, covered + 60);
            const bars = barsQ.all(SYMBOL, entryTs, toTs) as ShadowBar[];
            outs.length = 0;
            let anyOpen = false;
            for (const L of levels) {
              for (const mode of SHADOW_MODES) {
                if (L.slDist == null) { outs.push({ v: L.v, mode, res: finalOpen("no-data", f.sl, f.tp1) }); continue; }
                const res = walkShadowExit({
                  bars, entryTs, entry: f.entry, isLong, tpDist: L.tpDist, slDist: L.slDist,
                  beAt: L.v.beAt, trail: L.v.trail, timeStopMin: L.v.timeStopMin,
                  apexCutTs: mode === "apex1655" ? apexCut : null,
                  coveredThroughTs: Math.min(covered, toTs), maxHoldSec: SHADOW_MAX_HOLD_SEC,
                });
                if (res.outcome === "open" && res.exitReason == null) anyOpen = true;
                outs.push({ v: L.v, mode, res });
              }
            }
            if (!anyOpen || toTs >= covered) break;
          }
        }
      }

      stats.firesWalked++;
      const nowIso = new Date().toISOString();
      const writes = outs.filter(o => {
        const s = stored.get(`${o.v.id}|${o.mode}`);
        if (!s || !sameRefs(s)) return true;
        if (isFinal(s.outcome, s.exit_reason)) return false;          // first final verdict is permanent
        const r = o.res;
        return !(s.outcome === r.outcome && s.exit_reason === r.exitReason && s.exit_ts === r.exitTs && s.exit_price === r.exitPrice
          && s.points === r.points && s.mae === r.mae && s.mfe === r.mfe && s.tp_price === r.tpPrice && s.sl_price === r.slPrice);
      });
      if (writes.length) {
        const tx = client.transaction((rows: Out[]) => {
          for (const o of rows) {
            const r = o.res;
            upsert.run(SYMBOL, f.interval, f.timestamp, f.direction, o.v.id, o.mode, session, f.entry, f.tp1, f.sl,
              r.tpPrice, r.slPrice, r.outcome, r.exitReason, r.exitTs, r.exitPrice, r.points, r.mae, r.mfe, nowIso);
          }
        });
        tx(writes);
        stats.rowsWritten += writes.length;
      }
    }
    return stats;
  } catch (e: any) {
    stats.error = e?.message ?? String(e);
    console.error(`[shadow-exits] pass failed: ${stats.error}`);
    return stats;
  } finally {
    running = false;
    stats.tookMs = Date.now() - t0;
    if (stats.rowsWritten) {
      console.log(`[shadow-exits] ${stats.firesWalked}/${stats.candidates} fires walked, ${stats.rowsWritten} rows written` +
        `${stats.noData ? `, ${stats.noData} data-hole fires` : ""} (${stats.tookMs}ms, ${stats.chunks} chunk(s))`);
    }
  }
}

// ───────────────────────────── SUMMARY ─────────────────────────────

export interface ShadowSummaryRow {
  interval: string; variant: string; mode: ShadowMode;
  n: number; wins: number; winPct: number | null; grossPts: number; netPts: number; netPerTrade: number | null;
  shipped: { wins: number; winPct: number | null; netPts: number; netPerTrade: number | null };
  deltaNetPts: number; open: number; judgeable: boolean;
}
export const JUDGEABLE_N = 150;

/** Per interval × variant × mode over fires in the window: n resolved (variant AND the shipped
 *  re-walk both closed on the same fire + mode, at the fire's CURRENT levels), wins (points > 0),
 *  net = gross − FRICTION_PTS × n, the shipped exit on exactly those rows, and judgeable (n ≥ 150).
 *  Orphans (fires since removed from signal_history or re-levelled) are ignored. */
export function shadowSummary(q: { nowSec: number; days?: number; fromTs?: number; session?: "ETH" | "RTH" | null }): {
  window: { fromTs: number; toTs: number; days: number; session: string };
  frictionPts: number; judgeableN: number; variants: ShadowVariant[]; rows: ShadowSummaryRow[];
} {
  const days = Math.max(1, Math.min(400, Math.floor(q.days ?? 90)));
  const fromTs = Math.max(q.nowSec - days * 86400, q.fromTs ?? 0);
  const client = db.$client;
  const ids = SHADOW_VARIANTS.map(v => v.id);
  const sessClause = q.session ? ` AND v.session=?` : "";
  const sessArgs = q.session ? [q.session] : [];
  const closed = client.prepare(
    `SELECT v.interval, v.variant, v.mode, COUNT(*) AS n,
            SUM(CASE WHEN v.points>0 THEN 1 ELSE 0 END) AS wins, SUM(v.points) AS pts,
            SUM(CASE WHEN b.points>0 THEN 1 ELSE 0 END) AS bwins, SUM(b.points) AS bpts
       FROM signal_shadow_exits v
       JOIN signal_shadow_exits b ON b.symbol=v.symbol AND b.interval=v.interval AND b.timestamp=v.timestamp
            AND b.direction=v.direction AND b.mode=v.mode AND b.variant=?
            AND b.ref_entry=v.ref_entry AND b.ref_tp1=v.ref_tp1 AND b.ref_sl=v.ref_sl
       JOIN signal_history s ON s.symbol=v.symbol AND s.interval=v.interval AND s.timestamp=v.timestamp
            AND s.direction=v.direction AND s.entry=v.ref_entry AND s.tp1=v.ref_tp1 AND s.sl=v.ref_sl
      WHERE v.symbol=? AND v.timestamp>=? AND v.timestamp<=? AND v.variant IN (${variantIn()})
        AND v.outcome<>'open' AND b.outcome<>'open' AND v.points IS NOT NULL AND b.points IS NOT NULL${sessClause}
      GROUP BY v.interval, v.variant, v.mode`,
  ).all(BASELINE_VARIANT, SYMBOL, fromTs, q.nowSec, ...ids, ...sessArgs) as Array<{ interval: string; variant: string; mode: ShadowMode; n: number; wins: number; pts: number; bwins: number; bpts: number }>;
  const opens = client.prepare(
    `SELECT v.interval, v.variant, v.mode, COUNT(*) AS n FROM signal_shadow_exits v
       JOIN signal_history s ON s.symbol=v.symbol AND s.interval=v.interval AND s.timestamp=v.timestamp
            AND s.direction=v.direction AND s.entry=v.ref_entry AND s.tp1=v.ref_tp1 AND s.sl=v.ref_sl
      WHERE v.symbol=? AND v.timestamp>=? AND v.timestamp<=? AND v.variant IN (${variantIn()}) AND v.outcome='open'${sessClause}
      GROUP BY v.interval, v.variant, v.mode`,
  ).all(SYMBOL, fromTs, q.nowSec, ...ids, ...sessArgs) as Array<{ interval: string; variant: string; mode: ShadowMode; n: number }>;
  const openBy = new Map(opens.map(o => [`${o.interval}|${o.variant}|${o.mode}`, o.n]));
  const keys = new Set<string>([...closed.map(c => `${c.interval}|${c.variant}|${c.mode}`), ...openBy.keys()]);
  const byKey = new Map(closed.map(c => [`${c.interval}|${c.variant}|${c.mode}`, c]));
  const ivOrder = ["1m", "5m", "15m", "60m"];
  const rows: ShadowSummaryRow[] = [...keys].map(k => {
    const [interval, variant, mode] = k.split("|") as [string, string, ShadowMode];
    const c = byKey.get(k);
    const n = c?.n ?? 0, wins = c?.wins ?? 0, gross = c?.pts ?? 0, bgross = c?.bpts ?? 0, bwins = c?.bwins ?? 0;
    const net = rnd2(gross - FRICTION_PTS * n), bnet = rnd2(bgross - FRICTION_PTS * n);
    return {
      interval, variant, mode, n, wins,
      winPct: n ? rnd2((100 * wins) / n) : null,
      grossPts: rnd2(gross), netPts: net, netPerTrade: n ? rnd2(net / n) : null,
      shipped: { wins: bwins, winPct: n ? rnd2((100 * bwins) / n) : null, netPts: bnet, netPerTrade: n ? rnd2(bnet / n) : null },
      deltaNetPts: rnd2(net - bnet), open: openBy.get(k) ?? 0, judgeable: n >= JUDGEABLE_N,
    };
  }).sort((p, q2) =>
    (ivOrder.indexOf(p.interval) - ivOrder.indexOf(q2.interval)) ||
    (ids.indexOf(p.variant) - ids.indexOf(q2.variant)) ||
    (SHADOW_MODES.indexOf(p.mode) - SHADOW_MODES.indexOf(q2.mode)));
  return {
    window: { fromTs, toTs: q.nowSec, days, session: q.session ?? "all" },
    frictionPts: FRICTION_PTS, judgeableN: JUDGEABLE_N, variants: SHADOW_VARIANTS, rows,
  };
}
