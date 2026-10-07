/**
 * SHADOW SCALPS (2026-10-06 — RECORD ONLY; docs/scalping-research-2026-10-06.md §4 + §7,
 * docs/shadow-scalps-README.md).
 *
 * Two small-target candidates are recorded on the real 1m bars after every RTH session, so the kill /
 * promotion rules can be applied to a FORWARD sample without trading anything. There is NO random-entry
 * control (owner decision 2026-10-07): the promotion bar is the bracket's break-even arithmetic (6/8 at
 * 1.0 pt → 64.3 % win) plus the robustness checks; legacy "null-S1"/"null-S2" rows are purged at boot.
 *   S1  ORB-30 breakout (first 1m close beyond the 09:30–10:00 ET range, ≤ 1 Long + ≤ 1 Short/day,
 *       signals until 12:00 ET);
 *   S2  yellow-box edge fade — a resting LIMIT at the day box top (Short) / bottom (Long), armed only
 *       while price is within 2 pts of the edge; plus the bar-close variant ("close") for comparison.
 * Every trade is walked for three bracket cells (decision 6/8, learning 4/6 and 5/8) under three
 * fill models (optimistic / standard / pessimistic). Points are stored GROSS; friction (0.7 / 1.0 /
 * 1.5 pt) is applied only in the summary.
 *
 * NEVER an order, never an alert, never an engine input: nothing here imports the engine, the order
 * channel or the notifier, and the ONLY table this module writes is `shadow_scalps` (DDL in
 * server/db.ts). The day-zone source (server/yellowbox.ts getYellowboxDayZones — the function behind
 * GET /api/yellowbox/day-zones, which the engine's catch-up fetches) is called through a CACHE-ONLY
 * handle (cacheOnlySqlite): S2 reads a day box ONLY when that day is already frozen in
 * yellowbox_day_zones at the current YB_CACHE_VER + mwml import hash. Every statement outside that
 * warm path (the cold path's 130-day 5m/60m bar loads, its cache INSERTs) is refused, so this module
 * never runs the 330–670 ms cold derivation and never writes the yellowbox cache. A day whose box is
 * not frozen yet records S1 now and S2 later (zone_state "pending" → the
 * throttled retry in shadowScalpsTick, after the catch-up or a chart has frozen the row).
 *
 * TIME: every wall-clock boundary is etWallToEpoch(dayKey, h, m) (Intl America/New_York — DST-safe,
 * never a UTC offset). A "session" is an ET calendar weekday; only its RTH 1m bars are read.
 *
 * MAIN THREAD: one session = one synchronous chunk (one indexed bar read, one cache-only day-zone
 * lookup, a few thousand array steps, one DELETE + INSERT transaction); multi-day runs yield with
 * setImmediate between sessions; a throw in one session is caught and never aborts the rest.
 */
import { db } from "./db";
import { getYellowboxDayZones } from "./yellowbox";
import { etWallToEpoch, weekdayOfKey, YB_CACHE_VER } from "@shared/yellowbox-core";

// ───────────────────────────── FIXED CONSTANTS (pre-registered 2026-10-06) ─────────────────────────────

export const SYMBOL = "MES";
export const TICK = 0.25;
const EPS = 1e-9;

export type FillModel = "optimistic" | "standard" | "pessimistic";
export const FILL_MODELS: FillModel[] = ["optimistic", "standard", "pessimistic"];

export interface Cell { id: string; tp: number; sl: number; decision: boolean }
/** Decision cell TP 6 / SL 8; learning cells TP 4 / SL 6 and TP 5 / SL 8. FIXED — never tuned. */
export const CELLS: Cell[] = [
  { id: "6/8", tp: 6, sl: 8, decision: true },
  { id: "4/6", tp: 4, sl: 6, decision: false },
  { id: "5/8", tp: 5, sl: 8, decision: false },
];
export const DECISION_CELL = "6/8";
export const FRICTIONS = [0.7, 1.0, 1.5];

export type Strategy = "S1" | "S2";
export type Variant = "orb30" | "limit" | "close";
export type Era = "backfill" | "live";
export type Outcome = "win" | "loss" | "flat";

/** S2: a fade limit rests at an edge only while the previous bar came within this many points. */
export const ARM_DIST_PTS = 2;
/** Boot backfill depth (sessions with RTH 1m bars). */
export const BACKFILL_SESSIONS = 90;
/** Nightly slot: weekdays from 17:30 ET (after the 17:20 session-review slot). */
export const NIGHTLY_ET_MINS = 17 * 60 + 30;
/** Deferred-S2 / failed-session retry: at most one pass per this many seconds, this many sessions per
 *  pass (each one a normal ≤ ~15 ms chunk). The catch-up only runs while the market is open, so the
 *  just-finished day's box is usually frozen by its first pass after the 18:00 ET Globex reopen. */
export const RETRY_EVERY_SEC = 10 * 60;
export const RETRY_MAX_PER_PASS = 10;
/** A session that THREW (e.g. SQLITE_BUSY) is retried at most this many times per process. */
export const RETRY_MAX_ATTEMPTS = 6;
/** S1 range needs at least this many of the 30 range bars (data-hole guard, not a strategy rule). */
export const ORB_MIN_RANGE_BARS = 25;
/** A market entry needs a next bar within this many seconds of the signal bar. */
export const ENTRY_MAX_GAP_SEC = 300;
/** DATA GUARD: an RTH open-vs-previous-close jump this large is a contract-roll cliff / bad print
 *  (the 2026-09-14 +67.25 seam) — the session is not recorded. */
export const ROLL_JUMP_PTS = 30;

/** Kill / promotion rules — counted on era = "live" rows ONLY, pessimistic fills, 1.0-pt friction.
 *  OWNER DECISION 2026-10-07: no random-entry control. Without a control the promotion bar is the
 *  bracket's break-even arithmetic (6/8 at 1.0 pt: +5 / −9 net → 9/14 = 64.3 % win to break even; the
 *  pessimistic 1-tick stop slip makes it 9.25/14.25 = 64.9 %) plus the robustness checks: net ≥ +0.3,
 *  both halves > 0, and still > 0 with the best 3 session days removed. */
export const RULES = {
  killMinN: 100,
  killNetBelow: -0.3,
  promoteMinN: 300,
  promoteNetAtLeast: 0.3,
  dropBestDays: 3,
  decisionModel: "pessimistic" as FillModel,
  decisionFriction: 1.0,
};

// ───────────────────────────── SESSION CLOCK (DST-safe) ─────────────────────────────

export interface SessionClock {
  dayKey: string;
  rthOpen: number;   // 09:30 ET
  orbEnd: number;    // 10:00 ET — first bar after the opening range
  noon: number;      // 12:00 ET — S1 signal cutoff (signal bar must START before it)
  flat: number;      // 16:55 ET — every open trade is flattened here
  close: number;     // 17:00 ET — the session counts as finished from here
}

export function sessionClock(dayKey: string): SessionClock {
  return {
    dayKey,
    rthOpen: etWallToEpoch(dayKey, 9, 30),
    orbEnd: etWallToEpoch(dayKey, 10, 0),
    noon: etWallToEpoch(dayKey, 12, 0),
    flat: etWallToEpoch(dayKey, 16, 55),
    close: etWallToEpoch(dayKey, 17, 0),
  };
}

const ET_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
/** ET calendar date (YYYY-MM-DD) of a unix-seconds instant. */
export function etDateKey(tsSec: number): string {
  return ET_DATE_FMT.format(new Date(tsSec * 1000));
}
function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isWeekdayKey = (key: string): boolean => { const wd = weekdayOfKey(key); return wd >= 1 && wd <= 5; };

// ───────────────────────────── PURE SIMULATION ─────────────────────────────

export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface DayZoneLevels { top: number; bottom: number }
/**
 * Where a day's S2 box came from (stored per row as zone_state):
 *   cached  — the frozen yellowbox_day_zones row at the current YB_CACHE_VER + mwml import hash (the
 *             exact box GET /api/yellowbox/day-zones serves for that day); S2 rows recorded from it;
 *   pending — no frozen current row yet → S2 deferred, the day is retried later;
 *   none    — the source has a frozen answer with no usable box → no S2 for that day.
 */
export type ZoneState = "cached" | "pending" | "none";
export interface ZoneLookup { state: ZoneState; zone: DayZoneLevels | null; note?: string }
/** Test seam: a plain box (→ cached), null (→ none) or a full lookup. */
export type ZoneFor = (dayKey: string) => DayZoneLevels | ZoneLookup | null;

export function normalizeZone(v: DayZoneLevels | ZoneLookup | null | undefined): ZoneLookup {
  if (v == null) return { state: "none", zone: null };
  if ("state" in v) return { state: v.state, zone: v.zone ?? null, ...(v.note ? { note: v.note } : {}) };
  return { state: "cached", zone: v };
}

export interface TradeRow {
  strategy: Strategy;
  variant: Variant;
  direction: "Long" | "Short";
  signalTs: number;          // signal bar (S1 / close) or limit fill bar (S2 limit)
  seq: number;               // always 0 (the column once held the retired random-control draw index)
  cell: string;
  tp: number;
  sl: number;
  fillModel: FillModel;
  level: number | null;      // S1: range high/low broken; S2: the edge
  entryTs: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  outcome: Outcome;
  exitTs: number;
  exitPrice: number;
  points: number;            // GROSS points (friction is applied in the summary only)
  minutesHeld: number;
}

export interface SessionSim {
  trades: TradeRow[];
  /** Why a strategy produced nothing (data guards / missing levels) — informational. */
  notes: string[];
  /** Set when the WHOLE session is unusable (data guard) — no rows are recorded for it. */
  rejected: string | null;
  orb: { high: number; low: number; bars: number } | null;
  zone: DayZoneLevels | null;
}

const rnd2 = (v: number): number => Math.round(v * 100) / 100;
const dirName = (d: 1 | -1): "Long" | "Short" => (d > 0 ? "Long" : "Short");

/** First index with bars[i].time >= t (bars ascending). */
function lowerBound(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].time < t) lo = m + 1; else hi = m; }
  return lo;
}

export interface WalkResult { outcome: Outcome; exitTs: number; exitPrice: number }

/**
 * The bracket walk. `bars` hold only the session's RTH bars that START before 16:55 ET, so running
 * off the end of the array IS the 16:55 flat (exit at the close of the last bar walked, i.e. the
 * 16:54 bar = the 16:55:00 price; on a short session, the session's last bar).
 *   • stop and target touched in the SAME bar = loss;
 *   • stop fills AT the level (optimistic / standard) or 1 tick worse (pessimistic);
 *   • target fills AT the level on a touch (optimistic / standard); pessimistic needs a 1-tick
 *     trade-through (and still fills at the level).
 * `fallback` = the flat price/time when no bar is walked at all (an entry in the last bar).
 */
export function walkBracket(
  bars: Bar[], startIdx: number, entry: number, dir: 1 | -1, tp: number, sl: number,
  model: FillModel, fallback: { price: number; ts: number },
): WalkResult {
  const tpPx = entry + dir * tp;
  const slPx = entry - dir * sl;
  const tpThr = model === "pessimistic" ? TICK : 0;
  const slSlip = model === "pessimistic" ? TICK : 0;
  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i];
    const hitSL = dir > 0 ? b.low <= slPx + EPS : b.high >= slPx - EPS;
    const hitTP = dir > 0 ? b.high >= tpPx + tpThr - EPS : b.low <= tpPx - tpThr + EPS;
    if (hitSL) return { outcome: "loss", exitTs: b.time + 60, exitPrice: slPx - dir * slSlip };
    if (hitTP) return { outcome: "win", exitTs: b.time + 60, exitPrice: tpPx };
  }
  if (startIdx < bars.length) {
    const last = bars[bars.length - 1];
    return { outcome: "flat", exitTs: last.time + 60, exitPrice: last.close };
  }
  return { outcome: "flat", exitTs: fallback.ts, exitPrice: fallback.price };
}

/** Market-style entry off a COMPLETED signal bar i: optimistic = the signal bar's close (at its
 *  close time); standard = the next bar's open; pessimistic = the next bar's open + 1 tick against.
 *  null when no next bar exists within ENTRY_MAX_GAP_SEC (every model is skipped together, so the
 *  three models always describe the same signals). */
export function marketEntry(bars: Bar[], i: number, dir: 1 | -1, model: FillModel): { entry: number; entryTs: number; startIdx: number } | null {
  const sig = bars[i];
  const next = bars[i + 1];
  if (!sig || !next || next.time - sig.time > ENTRY_MAX_GAP_SEC) return null;
  if (model === "optimistic") return { entry: sig.close, entryTs: sig.time + 60, startIdx: i + 1 };
  const px = model === "pessimistic" ? next.open + dir * TICK : next.open;
  return { entry: px, entryTs: next.time, startIdx: i + 1 };
}

function makeRow(
  base: { strategy: Strategy; variant: Variant; dir: 1 | -1; signalTs: number; seq: number; level: number | null },
  cell: Cell, model: FillModel, entry: number, entryTs: number, w: WalkResult,
): TradeRow {
  const dir = base.dir;
  return {
    strategy: base.strategy, variant: base.variant, direction: dirName(dir), signalTs: base.signalTs,
    seq: base.seq, cell: cell.id, tp: cell.tp, sl: cell.sl, fillModel: model, level: base.level,
    entryTs, entryPrice: rnd2(entry), tpPrice: rnd2(entry + dir * cell.tp), slPrice: rnd2(entry - dir * cell.sl),
    outcome: w.outcome, exitTs: w.exitTs, exitPrice: rnd2(w.exitPrice),
    points: rnd2(dir * (w.exitPrice - entry)), minutesHeld: Math.max(0, Math.round((w.exitTs - entryTs) / 60)),
  };
}

/** Market entry + walk for every cell × model (S1 and the S2 close variant). */
function marketTrades(bars: Bar[], i: number, base: { strategy: Strategy; variant: Variant; dir: 1 | -1; seq: number; level: number | null }): TradeRow[] {
  const out: TradeRow[] = [];
  for (const model of FILL_MODELS) {
    const e = marketEntry(bars, i, base.dir, model);
    if (!e) return [];
    for (const cell of CELLS) {
      const w = walkBracket(bars, e.startIdx, e.entry, base.dir, cell.tp, cell.sl, model, { price: bars[i].close, ts: bars[i].time + 60 });
      out.push(makeRow({ ...base, signalTs: bars[i].time }, cell, model, e.entry, e.entryTs, w));
    }
  }
  return out;
}

/** Sanitize + order the session's bars: valid OHLC, 60-aligned, RTH [09:30, 16:55) only, unique. */
export function prepareBars(raw: Bar[], clk: SessionClock): Bar[] {
  const seen = new Set<number>();
  return raw
    .filter(b => b && Number.isFinite(b.time) && b.time % 60 === 0 && b.time >= clk.rthOpen && b.time < clk.flat
      && [b.open, b.high, b.low, b.close].every(v => Number.isFinite(v) && v > 0)
      && b.high >= b.low && b.open <= b.high + EPS && b.open >= b.low - EPS && b.close <= b.high + EPS && b.close >= b.low - EPS)
    .sort((a, b) => a.time - b.time)
    .filter(b => (seen.has(b.time) ? false : (seen.add(b.time), true)));
}

/**
 * Simulate one finished RTH session. Pure: bars (any order, any span — re-filtered to RTH
 * [09:30, 16:55)) + the day's yellow box → every S1 / S2 trade row.
 */
export function simulateSession(dayKey: string, rawBars: Bar[], zone: DayZoneLevels | null): SessionSim {
  const clk = sessionClock(dayKey);
  const bars = prepareBars(rawBars, clk);
  const trades: TradeRow[] = [];
  const notes: string[] = [];
  const sim: SessionSim = { trades, notes, rejected: null, orb: null, zone: null };
  if (!bars.length) { notes.push("no-bars"); sim.rejected = "no-bars"; return sim; }
  for (let i = 1; i < bars.length; i++) {
    if (Math.abs(bars[i].open - bars[i - 1].close) >= ROLL_JUMP_PTS) {
      notes.push(`roll-jump ${bars[i].time} (${rnd2(bars[i].open - bars[i - 1].close)} pts) — session not recorded`);
      sim.rejected = "roll-jump";
      return sim;
    }
  }

  // ── S1 ORB-30 ──
  const rangeBars = bars.filter(b => b.time >= clk.rthOpen && b.time < clk.orbEnd);
  if (rangeBars.length < ORB_MIN_RANGE_BARS) {
    notes.push(`S1: opening range incomplete (${rangeBars.length}/30 bars)`);
  } else {
    let hi = -Infinity, lo = Infinity;
    for (const b of rangeBars) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
    sim.orb = { high: hi, low: lo, bars: rangeBars.length };
    let didL = false, didS = false;
    for (let i = lowerBound(bars, clk.orbEnd); i < bars.length && bars[i].time < clk.noon; i++) {
      const b = bars[i];
      if (!didL && b.close > hi + EPS) {
        didL = true; // the side is consumed by its first close beyond the range, entry or not
        const t = marketTrades(bars, i, { strategy: "S1", variant: "orb30", dir: 1, seq: 0, level: hi });
        if (!t.length) notes.push(`S1 Long signal ${b.time}: no next bar — no entry`);
        trades.push(...t);
      } else if (!didS && b.close < lo - EPS) {
        didS = true;
        const t = marketTrades(bars, i, { strategy: "S1", variant: "orb30", dir: -1, seq: 0, level: lo });
        if (!t.length) notes.push(`S1 Short signal ${b.time}: no next bar — no entry`);
        trades.push(...t);
      }
    }
  }

  // ── S2 yellow-box edge fade ──
  // The day box is a derived statistic (2-decimal, e.g. 7670.71) — an order can only rest at a TICK
  // price, so each edge is snapped to the NEAREST tick (7670.75) and every S2 rule uses that price.
  const snap = (p: number): number => Math.round(p / TICK) * TICK;
  if (!zone || !Number.isFinite(zone.top) || !Number.isFinite(zone.bottom) || snap(zone.top) <= snap(zone.bottom)) {
    notes.push("S2: no day yellow box");
    return sim;
  }
  const T = snap(zone.top), B = snap(zone.bottom);
  sim.zone = { top: T, bottom: B };
  // A limit can rest during bar j only when bar j−1 is the CONTIGUOUS previous minute (the order is
  // placed off a completed bar) and that bar sat on the INSIDE of the edge within ARM_DIST_PTS.
  const contiguous = (j: number): boolean => j > 0 && bars[j].time - bars[j - 1].time === 60;
  const armedTop = (j: number): boolean => contiguous(j) && bars[j - 1].close < T - EPS && bars[j - 1].high >= T - ARM_DIST_PTS - EPS;
  const armedBot = (j: number): boolean => contiguous(j) && bars[j - 1].close > B + EPS && bars[j - 1].low <= B + ARM_DIST_PTS + EPS;

  for (const cell of CELLS) {
    for (const model of FILL_MODELS) {
      // (a) RESTING LIMIT — one open trade per direction at a time; re-arms after the exit.
      const openUntil = { [1]: -Infinity, [-1]: -Infinity } as Record<string, number>;
      for (let j = 1; j < bars.length; j++) {
        const b = bars[j];
        for (const dir of [-1, 1] as Array<1 | -1>) {
          if (openUntil[dir] > b.time) continue;
          const level = dir < 0 ? T : B;
          if (!(dir < 0 ? armedTop(j) : armedBot(j))) continue;
          const through = model === "optimistic" ? 0 : TICK; // touch vs 1-tick trade-through
          const filled = dir < 0 ? b.high >= level + through - EPS : b.low <= level - through + EPS;
          if (!filled) continue;
          const entry = model === "pessimistic" ? level + dir * TICK : level; // 1 tick worse
          const slPx = entry - dir * cell.sl;
          // FILL BAR: the fill is the FIRST print at the level, so a stop beyond it reached inside the
          // same bar was reached AFTER the fill — checked here (stop only; the target is never scored
          // in the fill bar because its low/high may precede the fill). The walk starts next bar.
          const stopInFillBar = dir < 0 ? b.high >= slPx - EPS : b.low <= slPx + EPS;
          const w: WalkResult = stopInFillBar
            ? { outcome: "loss", exitTs: b.time + 60, exitPrice: slPx - dir * (model === "pessimistic" ? TICK : 0) }
            : walkBracket(bars, j + 1, entry, dir, cell.tp, cell.sl, model, { price: b.close, ts: b.time + 60 });
          trades.push(makeRow({ strategy: "S2", variant: "limit", dir, signalTs: b.time, seq: 0, level }, cell, model, entry, b.time, w));
          openUntil[dir] = w.exitTs;
        }
      }
      // (b) BAR-CLOSE variant — wick THROUGH the edge (beyond it by ≥ 1 tick; an exact touch is not a
      //     wick through), close back inside → market entry next bar.
      const openUntilC = { [1]: -Infinity, [-1]: -Infinity } as Record<string, number>;
      for (let j = 1; j < bars.length; j++) {
        const b = bars[j], p = bars[j - 1];
        if (!contiguous(j)) continue;
        for (const dir of [-1, 1] as Array<1 | -1>) {
          if (openUntilC[dir] > b.time) continue;
          const sig = dir < 0
            ? p.close < T - EPS && b.high >= T + TICK - EPS && b.close < T - EPS
            : p.close > B + EPS && b.low <= B - TICK + EPS && b.close > B + EPS;
          if (!sig) continue;
          const e = marketEntry(bars, j, dir, model);
          if (!e) continue;
          const w = walkBracket(bars, e.startIdx, e.entry, dir, cell.tp, cell.sl, model, { price: b.close, ts: b.time + 60 });
          trades.push(makeRow({ strategy: "S2", variant: "close", dir, signalTs: b.time, seq: 0, level: dir < 0 ? T : B }, cell, model, e.entry, e.entryTs, w));
          openUntilC[dir] = w.exitTs;
        }
      }
    }
  }
  return sim;
}

// ───────────────────────────── DB: SOURCES ─────────────────────────────

interface SqliteLike {
  prepare(sql: string): { all: (...a: any[]) => any[]; get: (...a: any[]) => any; run: (...a: any[]) => any };
}

/** Thrown by cacheOnlySqlite when getYellowboxDayZones leaves its warm path (the day is not frozen). */
export class ColdZoneCacheError extends Error {
  constructor(sql: string) { super(`yellowbox day-zone cache is cold (refused: ${sql.replace(/\s+/g, " ").trim().slice(0, 60)}…)`); this.name = "ColdZoneCacheError"; }
}

/**
 * A FAIL-CLOSED handle for getYellowboxDayZones: it may only prepare the warm path's reads — SELECTs
 * on yellowbox_day_zones and the one-row `… LIMIT 1` bar-existence probe on cached_candles. Anything
 * else (the cold path's unbounded 5m/60m bar loads, its INSERTs, any statement added to yellowbox.ts
 * later) throws ColdZoneCacheError at prepare time, before any work; every .run() throws too. So a
 * call either returns frozen cache rows in a few ms or aborts — it never derives a box and never
 * writes. (Replaces the old no-write wrapper, which let the 330–670 ms cold derivation run.)
 */
export function cacheOnlySqlite(c: SqliteLike): SqliteLike {
  return {
    prepare(sql: string) {
      const s = sql.replace(/\s+/g, " ").trim();
      const warmRead = /^SELECT\b/i.test(s) && (
        /\bFROM yellowbox_day_zones\b/i.test(s) ||
        (/\bFROM cached_candles\b/i.test(s) && /\bLIMIT 1$/i.test(s)));
      if (!warmRead) throw new ColdZoneCacheError(sql);
      const st = c.prepare(sql);
      return {
        all: (...a: any[]) => st.all(...a),
        get: (...a: any[]) => st.get(...a),
        run: () => { throw new ColdZoneCacheError(sql); },
      };
    },
  };
}

/** Cheap pre-check (one primary-key read): is there a yellowbox_day_zones row for the day at the
 *  current YB_CACHE_VER? Without one the day cannot be warm, so the source is not even called. */
export function zoneRowAtCurrentVer(dayKey: string): boolean {
  const r = db.$client.prepare(`SELECT ver FROM yellowbox_day_zones WHERE symbol=? AND day_key=?`).get(SYMBOL, dayKey) as { ver?: number | null } | undefined;
  return !!r && r.ver === YB_CACHE_VER;
}

/** The day's yellow box from the server's day-zone source (getYellowboxDayZones — the function behind
 *  GET /api/yellowbox/day-zones that the engine's catch-up reads), FROZEN CACHE ONLY. The returned
 *  box is the exact row that route serves for the day (the source also re-validates the mwml import
 *  hash; a stale hash takes the cold path → refused → "pending"). */
export function serverDayZone(dayKey: string, nowSec: number): ZoneLookup {
  if (!zoneRowAtCurrentVer(dayKey)) return { state: "pending", zone: null, note: "day box not frozen in yellowbox_day_zones at the current YB_CACHE_VER" };
  const clk = sessionClock(dayKey);
  let r: ReturnType<typeof getYellowboxDayZones>;
  try {
    r = getYellowboxDayZones(cacheOnlySqlite(db.$client as unknown as SqliteLike), SYMBOL, clk.rthOpen, clk.rthOpen + 60, nowSec);
  } catch (e: any) {
    if (e instanceof ColdZoneCacheError) return { state: "pending", zone: null, note: "frozen day box is stale (mwml import hash) or the session is not complete" };
    throw e;
  }
  const z = (r?.days ?? []).find(d => d.dayKeyET === dayKey);
  if (!z || !Number.isFinite(z.boxTop) || !Number.isFinite(z.boxBottom) || z.boxTop <= z.boxBottom) return { state: "none", zone: null, note: "frozen day has no usable box" };
  return { state: "cached", zone: { top: z.boxTop, bottom: z.boxBottom } };
}

function loadSessionBars(clk: SessionClock, nowSec: number): Bar[] {
  return db.$client.prepare(
    `SELECT timestamp AS time, open, high, low, close FROM cached_candles
      WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<? AND timestamp+60<=?
      ORDER BY timestamp`,
  ).all(SYMBOL, clk.rthOpen, clk.flat, nowSec) as Bar[];
}

function hasRthBars(clk: SessionClock): boolean {
  return !!db.$client.prepare(
    `SELECT 1 FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<? LIMIT 1`,
  ).get(SYMBOL, clk.rthOpen, clk.close);
}

// ───────────────────────────── DB: RECORD ─────────────────────────────

export interface RecordResult {
  dayKey: string; era: Era | null; rows: number; skipped?: string; notes: string[]; tookMs: number;
  /** The S2 box source state stored on the day's rows (null when nothing was recorded). */
  zoneState: ZoneState | null;
}

/**
 * Record one FINISHED session (idempotent: the day's rows are replaced in one transaction). `era` is
 * the tag for a day with no rows yet; a day that already has rows KEEPS its era (a backfilled day
 * re-run by the nightly job stays "backfill"). The S2 box comes from the FROZEN day-zone cache only
 * (serverDayZone); a day without one records S1 with zone_state "pending" and is re-run by
 * the retry pass once the box is frozen. `zoneFor` / `nowSec` are test seams.
 */
export function recordSession(dayKey: string, era: Era, opts: { nowSec?: number; zoneFor?: ZoneFor } = {}): RecordResult {
  const t0 = Date.now();
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const res: RecordResult = { dayKey, era: null, rows: 0, notes: [], tookMs: 0, zoneState: null };
  const done = (skipped?: string): RecordResult => { if (skipped) res.skipped = skipped; res.tookMs = Date.now() - t0; return res; };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return done("bad-day-key");
  if (!isWeekdayKey(dayKey)) return done("weekend");
  const clk = sessionClock(dayKey);
  if (nowSec < clk.close) return done("session-not-finished");
  const bars = loadSessionBars(clk, nowSec);
  if (!bars.length) return done("no-bars");
  let look: ZoneLookup;
  try { look = normalizeZone((opts.zoneFor ?? ((k: string) => serverDayZone(k, nowSec)))(dayKey)); }
  catch (e: any) {
    look = { state: "pending", zone: null };
    res.notes.push(`S2: day-zone source failed (${e?.message ?? e}) — S2 deferred`);
  }
  const sim = simulateSession(dayKey, bars, look.state === "cached" ? look.zone : null);
  const zoneState: ZoneState = look.state === "pending" ? "pending" : sim.zone ? "cached" : "none";
  if (zoneState === "pending") {
    res.notes.push(...sim.notes.filter(n => n !== "S2: no day yellow box"));
    res.notes.push(`S2: deferred — ${look.note ?? "day box not frozen in the yellowbox cache yet"}`);
  } else {
    res.notes.push(...sim.notes);
  }
  const client = db.$client;
  const prior = client.prepare(`SELECT era FROM shadow_scalps WHERE symbol=? AND day_key=? LIMIT 1`).get(SYMBOL, dayKey) as { era?: string } | undefined;
  const useEra: Era = prior?.era === "backfill" || prior?.era === "live" ? (prior.era as Era) : era;
  res.era = useEra;
  const del = client.prepare(`DELETE FROM shadow_scalps WHERE symbol=? AND day_key=?`);
  if (sim.rejected) { del.run(SYMBOL, dayKey); retryMem.delete(dayKey); return done(sim.rejected); } // replace = remove the unusable day
  const ins = client.prepare(
    `INSERT INTO shadow_scalps (symbol, day_key, era, strategy, variant, direction, signal_ts, seq, cell, tp, sl,
       fill_model, level, entry_ts, entry_price, tp_price, sl_price, outcome, exit_ts, exit_price, points,
       minutes_held, run_at, zone_state, zone_top, zone_bottom)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const runAt = Math.floor(Date.now() / 1000);
  // The RAW box the rows were built from (S2 `level` holds the tick-snapped edge actually faded).
  const zTop = zoneState === "cached" && look.zone ? look.zone.top : null;
  const zBot = zoneState === "cached" && look.zone ? look.zone.bottom : null;
  client.transaction((rows: TradeRow[]) => {
    del.run(SYMBOL, dayKey);
    for (const r of rows) {
      ins.run(SYMBOL, dayKey, useEra, r.strategy, r.variant, r.direction, r.signalTs, r.seq, r.cell, r.tp, r.sl,
        r.fillModel, r.level, r.entryTs, r.entryPrice, r.tpPrice, r.slPrice, r.outcome, r.exitTs, r.exitPrice,
        r.points, r.minutesHeld, runAt, zoneState, zTop, zBot);
    }
  })(sim.trades);
  res.rows = sim.trades.length;
  res.zoneState = zoneState;
  // A pending day with NO rows (e.g. an incomplete opening range) leaves nothing in the table to find
  // it by — remember it in memory so the retry pass still picks it up. Otherwise the day is settled.
  if (zoneState === "pending" && !sim.trades.length) {
    const m = retryMem.get(dayKey);
    retryMem.set(dayKey, { era: useEra, attempts: m?.attempts ?? 0, reason: "pending-no-rows" });
  } else {
    retryMem.delete(dayKey);
  }
  return done();
}

// ───────────────────────────── JOB (boot backfill / catch-up + nightly) ─────────────────────────────

export interface RunStatus {
  at: string; trigger: "boot-backfill" | "boot-catchup" | "nightly" | "retry" | "manual"; era: Era;
  days: string[]; rows: number; skipped: Array<{ dayKey: string; reason: string }>;
  /** Recorded days whose S2 is still deferred (box not frozen yet). */
  s2Pending: string[];
  maxChunkMs: number; tookMs: number; error?: string;
}
let running = false;
let lastRun: RunStatus | null = null;
let bootStarted = false;
let lastNightlyKey: string | null = null;
let lastRetrySec = 0;
/** Days the table cannot point the retry pass at: a session that THREW (rolled back, no rows) and a
 *  pending day that produced no rows. In-memory — a restart's boot catch-up covers the newest days. */
const retryMem = new Map<string, { era: Era; attempts: number; reason: string }>();

export function shadowScalpsRunning(): boolean { return running; }
export function shadowScalpsLastRun(): RunStatus | null { return lastRun; }

const yieldTurn = (): Promise<void> => new Promise(r => setImmediate(r));

/** The most recent FINISHED weekday sessions that have RTH 1m bars, ascending; only days strictly
 *  after `afterKey` when given. Walks back ≤ 200 calendar days. */
export function finishedSessions(max: number, nowSec: number, afterKey?: string): string[] {
  const out: string[] = [];
  let key = etDateKey(nowSec);
  if (nowSec < sessionClock(key).close) key = addDays(key, -1);
  for (let walked = 0; walked < 200 && out.length < max; walked++, key = addDays(key, -1)) {
    if (afterKey && key <= afterKey) break;
    if (!isWeekdayKey(key)) continue;
    if (hasRthBars(sessionClock(key))) out.push(key);
  }
  return out.reverse();
}

/** Record several sessions, one per setImmediate turn (no chunk holds the thread for more than one
 *  session's work). A session that THROWS (e.g. SQLITE_BUSY past the busy_timeout while another
 *  writer holds the lock — its transaction rolls back) is logged as skipped "error: …", remembered for
 *  the retry pass, and never aborts the remaining sessions. `eraFor` overrides `era` per day. */
export async function runSessions(days: string[], era: Era, trigger: RunStatus["trigger"], opts: { nowSec?: number; zoneFor?: ZoneFor; eraFor?: Map<string, Era> } = {}): Promise<RunStatus> {
  const t0 = Date.now();
  const st: RunStatus = { at: new Date().toISOString(), trigger, era, days: [], rows: 0, skipped: [], s2Pending: [], maxChunkMs: 0, tookMs: 0 };
  if (running) { st.error = "already running"; return st; }
  running = true;
  const errors: string[] = [];
  try {
    for (const d of days) {
      await yieldTurn();
      const dayEra = opts.eraFor?.get(d) ?? era;
      const c0 = Date.now();
      try {
        const r = recordSession(d, dayEra, opts);
        st.maxChunkMs = Math.max(st.maxChunkMs, r.tookMs);
        if (r.skipped) st.skipped.push({ dayKey: d, reason: r.skipped });
        else { st.days.push(d); st.rows += r.rows; if (r.zoneState === "pending") st.s2Pending.push(d); }
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        st.maxChunkMs = Math.max(st.maxChunkMs, Date.now() - c0);
        st.skipped.push({ dayKey: d, reason: `error: ${msg}` });
        errors.push(`${d}: ${msg}`);
        const m = retryMem.get(d);
        retryMem.set(d, { era: dayEra, attempts: (m?.attempts ?? 0) + 1, reason: `error: ${msg}` });
        console.error(`[shadow-scalps] ${trigger}: session ${d} failed (${msg}) — will retry`);
      }
    }
  } finally {
    running = false;
    if (errors.length) st.error = `${errors.length} session(s) failed: ${errors.slice(0, 3).join("; ")}`;
    st.tookMs = Date.now() - t0;
    lastRun = st;
    console.log(`[shadow-scalps] ${trigger}: ${st.days.length} session(s) recorded (${trigger === "retry" ? "eras kept" : era}), ${st.rows} rows` +
      `${st.s2Pending.length ? `, S2 deferred on ${st.s2Pending.length} (box not frozen yet)` : ""}` +
      `${st.skipped.length ? `, ${st.skipped.length} skipped` : ""}, max chunk ${st.maxChunkMs}ms, ${st.tookMs}ms total${st.error ? ` — ERROR ${st.error}` : ""}`);
  }
  return st;
}

/** Days whose S2 is deferred in the table (zone_state "pending"), newest first, with their era. */
export function pendingS2Days(): Array<{ dayKey: string; era: Era }> {
  return db.$client.prepare(
    `SELECT day_key AS dayKey, MIN(era) AS era FROM shadow_scalps WHERE symbol=? AND zone_state='pending'
      GROUP BY day_key ORDER BY day_key DESC`,
  ).all(SYMBOL) as Array<{ dayKey: string; era: Era }>;
}

/**
 * The retry pass's work list (synchronous, cheap): pending days whose box may now be frozen (a
 * yellowbox_day_zones row at the current YB_CACHE_VER exists — one primary-key read each; days
 * without one are skipped without touching the source), plus in-memory days (a session that threw,
 * a pending day with no rows). At most RETRY_MAX_PER_PASS, newest first. `anyZone` (test seam with a
 * stubbed zone source) skips the cache-row pre-check.
 */
export function retryCandidates(anyZone = false): Array<{ dayKey: string; era: Era }> {
  const out: Array<{ dayKey: string; era: Era }> = [];
  const seen = new Set<string>();
  for (const [dayKey, m] of [...retryMem.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    if (out.length >= RETRY_MAX_PER_PASS) break;
    if (m.reason.startsWith("error") && m.attempts >= RETRY_MAX_ATTEMPTS) continue;
    if (m.reason === "pending-no-rows" && !anyZone && !zoneRowAtCurrentVer(dayKey)) continue;
    out.push({ dayKey, era: m.era }); seen.add(dayKey);
  }
  for (const p of pendingS2Days()) {
    if (out.length >= RETRY_MAX_PER_PASS) break;
    if (seen.has(p.dayKey)) continue;
    if (!anyZone && !zoneRowAtCurrentVer(p.dayKey)) continue;
    out.push(p); seen.add(p.dayKey);
  }
  return out;
}

/** Re-run the retry candidates (each one an ordinary idempotent recordSession; eras are kept). */
export async function retryDeferred(nowSec = Math.floor(Date.now() / 1000), opts: { zoneFor?: ZoneFor } = {}): Promise<RunStatus | null> {
  const cands = retryCandidates(!!opts.zoneFor);
  if (!cands.length) return null;
  return runSessions(cands.map(c => c.dayKey).reverse(), "live", "retry", { nowSec, ...opts, eraFor: new Map(cands.map(c => [c.dayKey, c.era])) });
}

/** Rows per DELETE statement of the legacy-control purge (one statement per event-loop turn). */
export const LEGACY_NULL_PURGE_CHUNK = 2000;

/**
 * OWNER DECISION 2026-10-07 — no random-entry control anywhere in the shadow scalps. The recorder no
 * longer writes "null-S1" / "null-S2" rows; this removes the ones recorded before the decision.
 * Idempotent (DELETE … WHERE strategy LIKE 'null-%'; a table without such rows is a no-op that logs
 * nothing) and logged ONCE when it removed rows. Run at boot, before the boot backfill / catch-up.
 * MAIN THREAD: the backfill left ~28k such rows under four indexes, so the DELETE runs in chunks of
 * LEGACY_NULL_PURGE_CHUNK ids with a setImmediate between statements (never one long block).
 */
export async function purgeLegacyNullRows(chunk = LEGACY_NULL_PURGE_CHUNK): Promise<{ deleted: number; maxChunkMs: number; tookMs: number }> {
  const t0 = Date.now();
  const del = db.$client.prepare(`DELETE FROM shadow_scalps WHERE id IN (SELECT id FROM shadow_scalps WHERE strategy LIKE 'null-%' LIMIT ?)`);
  let deleted = 0, maxChunkMs = 0;
  for (;;) {
    const c0 = Date.now();
    const n = Number(del.run(chunk).changes ?? 0);
    maxChunkMs = Math.max(maxChunkMs, Date.now() - c0);
    deleted += n;
    if (n < chunk) break;
    await yieldTurn();
  }
  const tookMs = Date.now() - t0;
  if (deleted > 0) {
    console.log(`[shadow-scalps] removed ${deleted} legacy random-control rows (null-S1 / null-S2) — owner decision 2026-10-07: no random-entry control; max chunk ${maxChunkMs}ms, ${tookMs}ms total`);
  }
  return { deleted, maxChunkMs, tookMs };
}

/** BOOT: first purge the legacy random-control rows (purgeLegacyNullRows). Then an empty table →
 *  backfill the last BACKFILL_SESSIONS finished sessions as era "backfill" (the strategies were fixed
 *  before any of these were scored forward). Otherwise → record every finished weekday session after
 *  the newest recorded day as era "live" (missed while down). */
export async function bootShadowScalps(nowSec = Math.floor(Date.now() / 1000), opts: { zoneFor?: ZoneFor } = {}): Promise<RunStatus> {
  // Hold `running` during the purge so the tick backs off; released before runSessions takes it. A
  // failed purge (e.g. SQLITE_BUSY) is logged and retried on the next boot — the summary and digest
  // read only S1 / S2 rows in SQL, so leftover control rows are never shown or counted meanwhile.
  if (!running) {
    running = true;
    try { await purgeLegacyNullRows(); }
    catch (e: any) { console.error(`[shadow-scalps] legacy random-control purge failed (${e?.message ?? e}) — retried on the next boot`); }
    finally { running = false; }
  }
  const newest = db.$client.prepare(`SELECT MAX(day_key) AS k FROM shadow_scalps WHERE symbol=?`).get(SYMBOL) as { k?: string | null } | undefined;
  const todayKey = etDateKey(nowSec);
  let st: RunStatus;
  if (!newest?.k) {
    st = await runSessions(finishedSessions(BACKFILL_SESSIONS, nowSec), "backfill", "boot-backfill", { nowSec, ...opts });
  } else {
    st = await runSessions(finishedSessions(BACKFILL_SESSIONS, nowSec, newest.k), "live", "boot-catchup", { nowSec, ...opts });
  }
  // Today already handled at boot (server started after the close) → the nightly slot need not redo it.
  if (st.days.includes(todayKey)) lastNightlyKey = todayKey;
  return st;
}

/** Called from the scheduler tick (after its boot-quiet window): the one-time boot run, then the
 *  nightly slot — weekdays ≥ 17:30 ET, once per ET date, era "live" (an already-recorded day keeps
 *  its era) — then, at most every RETRY_EVERY_SEC, the retry pass (deferred S2 days whose box has
 *  been frozen since, sessions that threw). `et` = the scheduler's ET wall clock (Intl). */
export function shadowScalpsTick(et: { dateKey: string; mins: number }, nowSec = Math.floor(Date.now() / 1000), opts: { zoneFor?: ZoneFor } = {}): "boot" | "nightly" | "retry" | null {
  if (running) return null;
  if (!bootStarted) {
    bootStarted = true;
    lastRetrySec = nowSec; // the boot run itself is the first attempt
    bootShadowScalps(nowSec, opts).catch((e: any) => console.error(`[shadow-scalps] boot run failed: ${e?.message ?? e}`));
    return "boot";
  }
  if (isWeekdayKey(et.dateKey) && et.mins >= NIGHTLY_ET_MINS && lastNightlyKey !== et.dateKey) {
    lastNightlyKey = et.dateKey; // claim the day BEFORE the async run (no double fire)
    runSessions([et.dateKey], "live", "nightly", { nowSec, ...opts }).catch((e: any) => console.error(`[shadow-scalps] nightly run failed: ${e?.message ?? e}`));
    return "nightly";
  }
  if (nowSec - lastRetrySec >= RETRY_EVERY_SEC) {
    lastRetrySec = nowSec;
    if (!retryCandidates(!!opts.zoneFor).length) return null;
    retryDeferred(nowSec, opts).catch((e: any) => console.error(`[shadow-scalps] retry run failed: ${e?.message ?? e}`));
    return "retry";
  }
  return null;
}

/** Test seam: reset the in-memory job state. */
export function _resetShadowScalpsJobForTests(): void { running = false; lastRun = null; bootStarted = false; lastNightlyKey = null; lastRetrySec = 0; retryMem.clear(); }
/** Test seam: the in-memory retry entries. */
export function _retryMemForTests(): Array<{ dayKey: string; era: Era; attempts: number; reason: string }> {
  return [...retryMem.entries()].map(([dayKey, m]) => ({ dayKey, ...m }));
}

// ───────────────────────────── SUMMARY ─────────────────────────────

export interface SummaryInputRow {
  id: number; dayKey: string; era: Era; strategy: Strategy; variant: Variant; cell: string;
  fillModel: FillModel; entryTs: number; points: number;
  /** Day box provenance (zone_state) — only the summary/digest reads carry it. */
  zoneState?: ZoneState | string | null;
}

export interface Stats {
  n: number; wins: number; winPct: number | null; netPerTrade: number | null; netPts: number;
  pf: number | null; maxDD: number;
  halves: { h1: { n: number; netPerTrade: number | null }; h2: { n: number; netPerTrade: number | null }; splitDay: string | null };
  dropBest3NetPerTrade: number | null;
  sd: number | null;
  /** Unrounded net/trade — the kill / promotion thresholds compare THIS (no rounding at the edge). */
  netPerTradeRaw: number | null;
}

/** Net stats of trades already ordered by (entryTs, id). `splitDay` = first day of the second half. */
export function computeStats(trades: SummaryInputRow[], friction: number, splitDay: string | null): Stats {
  const n = trades.length;
  const nets = trades.map(t => t.points - friction);
  let sum = 0, wins = 0, gp = 0, gl = 0, cum = 0, peak = 0, dd = 0;
  for (const v of nets) {
    sum += v;
    if (v > EPS) { wins++; gp += v; } else if (v < -EPS) gl += -v;
    cum += v; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
  }
  const mean = n ? sum / n : null;
  let sd: number | null = null;
  if (n >= 2) { const m = sum / n; let ss = 0; for (const v of nets) ss += (v - m) ** 2; sd = Math.sqrt(ss / (n - 1)); }
  // Plain loops (no per-row closures): this runs once per summary group on the main thread.
  const h1 = { n: 0, s: 0 }, h2 = { n: 0, s: 0 };
  const byDay = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = trades[i].dayKey;
    const h = splitDay != null && k < splitDay ? h1 : h2; h.n++; h.s += nets[i];
    byDay.set(k, (byDay.get(k) ?? 0) + nets[i]);
  }
  const best = new Set([...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, RULES.dropBestDays).map(e => e[0]));
  let dn = 0, ds = 0;
  for (let i = 0; i < n; i++) if (!best.has(trades[i].dayKey)) { dn++; ds += nets[i]; }
  return {
    n, wins, winPct: n ? rnd2((100 * wins) / n) : null,
    netPerTrade: mean == null ? null : rnd2(mean), netPts: rnd2(sum),
    pf: gl > EPS ? rnd2(gp / gl) : null, maxDD: rnd2(dd),
    halves: {
      h1: { n: h1.n, netPerTrade: h1.n ? rnd2(h1.s / h1.n) : null },
      h2: { n: h2.n, netPerTrade: h2.n ? rnd2(h2.s / h2.n) : null },
      splitDay,
    },
    dropBest3NetPerTrade: dn ? rnd2(ds / dn) : null,
    sd: sd == null ? null : rnd2(sd),
    netPerTradeRaw: mean,
  };
}

export interface SummaryRow {
  strategy: Strategy; variant: Variant; cell: string; decisionCell: boolean; fillModel: FillModel;
  stats: Stats;
  netPerTradeByFriction: Record<string, number | null>;
  kill: boolean;
  /** The live-only promotion checks of this strategy × variant × cell (they are defined at pessimistic
   *  fills + 1.0-pt friction, so every fill-model row of the cell carries the same flags). */
  promotion: Decision["promotion"] | null;
}
export interface Decision {
  strategy: "S1" | "S2"; variant: Variant; cell: string; decisionCell: boolean;
  liveN: number; netPerTrade: number | null; h1: number | null; h2: number | null;
  dropBest3NetPerTrade: number | null;
  kill: boolean;
  promotion: { nOk: boolean; netOk: boolean; halvesOk: boolean; dropBest3Ok: boolean; all: boolean };
  verdict: "KEEP" | "KILL";
}

const splitDayOf = (days: string[]): string | null => (days.length ? days[Math.floor(days.length / 2)] : null);
const keyOf = (s: string, v: string, c: string, m: string): string => `${s}|${v}|${c}|${m}`;

// MAIN-THREAD HYGIENE (verifier 2026-10-06): the table grows ~350 rows per session (31k after the
// backfill), so the summary and the digest never read + aggregate it in one synchronous block. The
// aggregation is written ONCE as a generator that `yield`s between chunks of work; runSync ignores the
// yields (the pure API the tests exercise), runAsync gives the event loop a turn whenever a slice has
// run SLICE_MS. Reads are keyset-paged by id, one page per turn.
type Steps<T> = Generator<void, T, unknown>;
export const SUMMARY_PAGE = 4000;
const GROUP_CHUNK = 4000;
const SLICE_MS = 8;

function runSync<T>(gen: Steps<T>): T {
  for (;;) { const r = gen.next(); if (r.done) return r.value; }
}
async function runAsync<T>(gen: Steps<T>): Promise<T> {
  let t = Date.now();
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    if (Date.now() - t >= SLICE_MS) { await yieldTurn(); t = Date.now(); }
  }
}

function* groupRowsGen(rows: SummaryInputRow[]): Steps<Map<string, SummaryInputRow[]>> {
  const g = new Map<string, SummaryInputRow[]>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const k = keyOf(r.strategy, r.variant, r.cell, r.fillModel);
    let a = g.get(k); if (!a) { a = []; g.set(k, a); } a.push(r);
    if (i % GROUP_CHUNK === GROUP_CHUNK - 1) yield;
  }
  // Groups must be in (entry_ts, id) order for maxDD; sort only the ones that are not.
  const cmp = (x: SummaryInputRow, y: SummaryInputRow): number => (x.entryTs - y.entryTs) || (x.id - y.id);
  for (const a of g.values()) {
    let sorted = true;
    for (let i = 1; i < a.length; i++) if (cmp(a[i - 1], a[i]) > 0) { sorted = false; break; }
    if (!sorted) { a.sort(cmp); yield; }
  }
  return g;
}

const STRAT_ORDER = ["S1", "S2"];
const VAR_ORDER = ["orb30", "limit", "close"];
/** Defence in depth: only S1 / S2 rows ever reach the summary / digest (legacy control rows that
 *  survive until the boot purge are ignored — SQL filter in rowFilter, and this one for pure callers). */
const isStrategyRow = (r: { strategy: string }): boolean => r.strategy === "S1" || r.strategy === "S2";

function* computeDecisionsGen(allRows: SummaryInputRow[]): Steps<Decision[]> {
  const live: SummaryInputRow[] = [];
  const daySet = new Set<string>();
  for (let i = 0; i < allRows.length; i++) {
    const r = allRows[i];
    if (i % GROUP_CHUNK === GROUP_CHUNK - 1) yield;
    if (r.era !== "live" || !isStrategyRow(r)) continue;
    daySet.add(r.dayKey);
    if (r.fillModel === RULES.decisionModel) live.push(r);
  }
  const split = splitDayOf([...daySet].sort());
  const g = yield* groupRowsGen(live);
  const out: Decision[] = [];
  for (const [strategy, variant] of [["S1", "orb30"], ["S2", "limit"], ["S2", "close"]] as Array<["S1" | "S2", Variant]>) {
    for (const cell of CELLS) {
      const trades = g.get(keyOf(strategy, variant, cell.id, RULES.decisionModel)) ?? [];
      const s = computeStats(trades, RULES.decisionFriction, split);
      const net = s.netPerTrade;
      const raw = s.netPerTradeRaw;
      const kill = s.n >= RULES.killMinN && raw != null && raw < RULES.killNetBelow - EPS;
      const promotion = {
        nOk: s.n >= RULES.promoteMinN,
        netOk: raw != null && raw >= RULES.promoteNetAtLeast - EPS,
        halvesOk: (s.halves.h1.netPerTrade ?? -1) > 0 && (s.halves.h2.netPerTrade ?? -1) > 0,
        dropBest3Ok: (s.dropBest3NetPerTrade ?? -1) > 0,
        all: false,
      };
      promotion.all = promotion.nOk && promotion.netOk && promotion.halvesOk && promotion.dropBest3Ok;
      out.push({
        strategy, variant, cell: cell.id, decisionCell: cell.id === DECISION_CELL,
        liveN: s.n, netPerTrade: net, h1: s.halves.h1.netPerTrade, h2: s.halves.h2.netPerTrade,
        dropBest3NetPerTrade: s.dropBest3NetPerTrade,
        kill, promotion, verdict: kill ? "KILL" : "KEEP",
      });
      yield;
    }
  }
  return out;
}

/** The kill / promotion verdicts — era "live" rows ONLY, pessimistic fills, 1.0-pt friction. */
export function computeDecisions(allRows: SummaryInputRow[]): Decision[] {
  return runSync(computeDecisionsGen(allRows));
}

export interface ZoneStates { cached: number; pending: number; none: number; pendingDays: string[] }
export interface SummaryBody {
  era: "live" | "all"; frictionPts: number; frictionsShown: number[];
  sessions: {
    count: number; first: string | null; last: string | null; halvesSplitDay: string | null;
    byEra: { backfill: number; live: number };
  };
  rows: SummaryRow[]; decisions: Decision[];
  /** Per-day S2 box provenance of the displayed rows (rows without zoneState count as "none"). */
  zoneStates: ZoneStates;
}

/** Per-day zone states of a row set (a day is "pending" if any of its rows is). */
function zoneStatesOf(rows: Array<{ dayKey: string; zoneState?: string | null }>): ZoneStates {
  const byDay = new Map<string, string>();
  for (const r of rows) {
    const st = r.zoneState ?? "none";
    const prev = byDay.get(r.dayKey);
    if (prev !== "pending") byDay.set(r.dayKey, st === "pending" ? "pending" : (prev ?? st));
  }
  const out: ZoneStates = { cached: 0, pending: 0, none: 0, pendingDays: [] };
  for (const [d, st] of byDay) {
    if (st === "cached") out.cached++;
    else if (st === "pending") { out.pending++; out.pendingDays.push(d); }
    else out.none++;
  }
  out.pendingDays.sort();
  return out;
}

function* summarizeGen(allRows: SummaryInputRow[], q: { era: "live" | "all"; friction: number }, byEraDays?: { backfill: number; live: number }): Steps<SummaryBody> {
  const rows: SummaryInputRow[] = [];
  const daySet = new Set<string>();
  const eraDaySets = { backfill: new Set<string>(), live: new Set<string>() };
  for (let i = 0; i < allRows.length; i++) {
    const r = allRows[i];
    if (i % GROUP_CHUNK === GROUP_CHUNK - 1) yield;
    if (!isStrategyRow(r)) continue;
    if (r.era === "backfill" || r.era === "live") eraDaySets[r.era].add(r.dayKey);
    if (q.era === "live" && r.era !== "live") continue;
    rows.push(r); daySet.add(r.dayKey);
  }
  const days = [...daySet].sort();
  const split = splitDayOf(days);
  const zoneStates = zoneStatesOf(rows);
  yield;
  const g = yield* groupRowsGen(rows);
  const decisions = yield* computeDecisionsGen(allRows);
  const decOf = new Map(decisions.map(d => [`${d.strategy}|${d.variant}|${d.cell}`, d]));
  const out: SummaryRow[] = [];
  for (const [k, trades] of g) {
    const [strategy, variant, cell, fillModel] = k.split("|") as [Strategy, Variant, string, FillModel];
    const byF: Record<string, number | null> = {};
    for (const f of FRICTIONS) byF[f.toFixed(1)] = trades.length ? rnd2(trades.reduce((s, r) => s + r.points - f, 0) / trades.length) : null;
    out.push({
      strategy, variant, cell, decisionCell: cell === DECISION_CELL, fillModel,
      stats: computeStats(trades, q.friction, split),
      netPerTradeByFriction: byF,
      kill: decOf.get(`${strategy}|${variant}|${cell}`)?.kill ?? false,
      promotion: decOf.get(`${strategy}|${variant}|${cell}`)?.promotion ?? null,
    });
    yield;
  }
  out.sort((a, b) =>
    (STRAT_ORDER.indexOf(a.strategy) - STRAT_ORDER.indexOf(b.strategy)) ||
    (VAR_ORDER.indexOf(a.variant) - VAR_ORDER.indexOf(b.variant)) ||
    (CELLS.findIndex(c => c.id === a.cell) - CELLS.findIndex(c => c.id === b.cell)) ||
    (FILL_MODELS.indexOf(a.fillModel) - FILL_MODELS.indexOf(b.fillModel)));
  return {
    era: q.era, frictionPts: q.friction, frictionsShown: FRICTIONS,
    sessions: {
      count: days.length, first: days[0] ?? null, last: days[days.length - 1] ?? null, halvesSplitDay: split,
      byEra: byEraDays ?? { backfill: eraDaySets.backfill.size, live: eraDaySets.live.size },
    },
    rows: out, decisions, zoneStates,
  };
}

/** Pure summary over stored rows (`era` filters the display rows; decisions are always live-only, so
 *  passing only the live rows for era=live gives the same body; `byEraDays` overrides the per-era
 *  session counts when the caller did not load every era). */
export function summarizeRows(allRows: SummaryInputRow[], q: { era: "live" | "all"; friction: number }, byEraDays?: { backfill: number; live: number }): SummaryBody {
  return runSync(summarizeGen(allRows, q, byEraDays));
}
/** The same summary, yielding the event loop every SLICE_MS (what the route and the digest use). */
export function summarizeRowsAsync(allRows: SummaryInputRow[], q: { era: "live" | "all"; friction: number }, byEraDays?: { backfill: number; live: number }): Promise<SummaryBody> {
  return runAsync(summarizeGen(allRows, q, byEraDays));
}

const SUMMARY_COLS = "id, day_key AS dayKey, era, strategy, variant, cell, fill_model AS fillModel, entry_ts AS entryTs, points, zone_state AS zoneState";
function rowFilter(f: { era?: Era; fillModel?: FillModel }): { where: string; args: any[] } {
  // strategy IN ('S1','S2'): legacy random-control rows (purged at boot) are never read.
  const where = ["symbol=?", "strategy IN ('S1','S2')"]; const args: any[] = [SYMBOL];
  if (f.era) { where.push("era=?"); args.push(f.era); }
  if (f.fillModel) { where.push("fill_model=?"); args.push(f.fillModel); }
  return { where: where.join(" AND "), args };
}

/** Summary rows, filtered IN SQL (the digest reads live + pessimistic only — the rules' rows). One
 *  synchronous read, for tests and small reads; the route and the digest use readRowsPaged. */
export function readRows(f: { era?: Era; fillModel?: FillModel } = {}): SummaryInputRow[] {
  const { where, args } = rowFilter(f);
  return db.$client.prepare(`SELECT ${SUMMARY_COLS} FROM shadow_scalps WHERE ${where} ORDER BY entry_ts, id`).all(...args) as SummaryInputRow[];
}

/** The same rows read in id-keyset pages of SUMMARY_PAGE, one page per event-loop turn. Re-reads (up
 *  to 3 attempts) when a recorder chunk changed the table between pages (a day replaced mid-read would
 *  otherwise appear twice). `onPage` is a test seam. */
export async function readRowsPaged(f: { era?: Era; fillModel?: FillModel } = {}, onPage?: (n: number) => void, pageSize = SUMMARY_PAGE): Promise<SummaryInputRow[]> {
  const { where, args } = rowFilter(f);
  const st = db.$client.prepare(`SELECT ${SUMMARY_COLS} FROM shadow_scalps WHERE ${where} AND id > ? ORDER BY id LIMIT ?`);
  for (let attempt = 0; ; attempt++) {
    const ver = tableVersion();
    const out: SummaryInputRow[] = [];
    let last = 0;
    for (;;) {
      const page = st.all(...args, last, pageSize) as SummaryInputRow[];
      for (const r of page) out.push(r);
      onPage?.(page.length);
      if (page.length < pageSize) break;
      last = page[page.length - 1].id;
      await yieldTurn();
    }
    if (tableVersion() === ver || attempt >= 2) return out;
  }
}

/** Per-day S2 box provenance: how many recorded days per zone_state, and the pending days. */
export function zoneStateSummary(era?: Era): ZoneStates {
  const rows = db.$client.prepare(
    `SELECT DISTINCT day_key AS dayKey, zone_state AS zoneState FROM shadow_scalps WHERE symbol=?${era ? " AND era=?" : ""}`,
  ).all(...(era ? [SYMBOL, era] : [SYMBOL])) as Array<{ dayKey: string; zoneState: string | null }>;
  return zoneStatesOf(rows);
}

/** Table version — changes on every replace (new ids) and every delete (count). Index-only reads. */
export function tableVersion(): string {
  const v = db.$client.prepare(`SELECT COUNT(*) AS n, MAX(id) AS mx FROM shadow_scalps WHERE symbol=?`).get(SYMBOL) as { n: number; mx: number | null };
  return `${v.n}|${v.mx ?? 0}`;
}
type MemoBody = SummaryBody & { lastRunAt: string | null };
const summaryMemo = new Map<string, { ver: string; body: MemoBody }>();
const summaryInflight = new Map<string, Promise<{ ver: string; body: MemoBody }>>();

async function computeSummaryBody(q: { era: "live" | "all"; friction: number }): Promise<{ ver: string; body: MemoBody }> {
  const ver = tableVersion();
  const rows = await readRowsPaged(q.era === "live" ? { era: "live" } : {});
  // era=live did not load the backfill rows: count their days with one index read.
  const byEra = q.era === "live"
    ? {
        backfill: (db.$client.prepare(`SELECT COUNT(DISTINCT day_key) AS n FROM shadow_scalps WHERE symbol=? AND era='backfill' AND strategy IN ('S1','S2')`).get(SYMBOL) as { n: number }).n,
        live: new Set(rows.map(r => r.dayKey)).size,
      }
    : undefined;
  const lastRow = db.$client.prepare(`SELECT run_at AS t FROM shadow_scalps WHERE id=(SELECT MAX(id) FROM shadow_scalps WHERE symbol=?)`).get(SYMBOL) as { t?: number | null } | undefined;
  const body = await summarizeRowsAsync(rows, q, byEra);
  return { ver, body: { ...body, lastRunAt: lastRow?.t ? new Date(lastRow.t * 1000).toISOString() : null } };
}

/** GET /api/signals/shadow-scalps/summary body. Paged read + yielding aggregation (no long block on the
 *  server thread); era=live reads only live rows; memoized per era × friction × table version, and
 *  concurrent requests share one computation. */
export async function shadowScalpsSummary(q: { era: "live" | "all"; friction: number }) {
  const mkey = `${q.era}|${q.friction}`;
  let memo = summaryMemo.get(mkey);
  if (!memo || memo.ver !== tableVersion()) {
    let p = summaryInflight.get(mkey);
    if (!p) {
      p = computeSummaryBody(q).finally(() => summaryInflight.delete(mkey));
      summaryInflight.set(mkey, p);
    }
    memo = await p;
    if (summaryMemo.size > 20) summaryMemo.clear();
    summaryMemo.set(mkey, memo);
  }
  return {
    ...memo.body,
    lastJob: lastRun,
    cells: CELLS, decisionCell: DECISION_CELL, rules: RULES,
    note: "RECORD ONLY — no orders, alerts or engine inputs. Points are gross in storage; friction applied here. Kill/promotion use era=live rows only (pessimistic fills, 1.0-pt friction). No random-entry control (owner decision 2026-10-07): promotion = n >= 300, net >= +0.3/trade (above the 6/8 bracket's 64.3 % break-even win rate at 1.0 pt), both halves > 0, and > 0 without the best 3 days. S2 rows come only from a day box frozen in the yellowbox cache; zoneStates.pendingDays have S1 only so far.",
  };
}

const fmtNet = (v: number | null): string => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
const NO_ROWS_LINE = "Shadow scalps: no rows yet (the boot backfill runs after the scheduler's boot-quiet window)";

function digestLineOf(dec: Decision[], pend: number): string {
  const part = (strategy: "S1" | "S2", variant: Variant): string => {
    const d = dec.find(x => x.strategy === strategy && x.variant === variant && x.cell === DECISION_CELL);
    if (!d) return `${strategy} unavailable`;
    return `${strategy} live n=${d.liveN}/${RULES.promoteMinN} net ${fmtNet(d.netPerTrade)}/tr (pess, 1.0) [${d.verdict}]${d.promotion.all ? " — PROMOTION BAR MET (SIM hand-trading review next)" : ""}`;
  };
  return `Shadow scalps: ${part("S1", "orb30")}; ${part("S2", "limit")}${pend > 0 ? ` (S2 box pending on ${pend} live day${pend === 1 ? "" : "s"})` : ""}`;
}

/** Digest line: "Shadow scalps: S1 live n=…/300 net …/tr (pess, 1.0) [KEEP|KILL]; S2 …" (decision
 *  cell 6/8; S2 = the resting-limit variant, the hypothesis under test). Pure / synchronous form:
 *  `rows` = live + pessimistic rows (default: one sync read), `s2PendingLiveDays` appends the
 *  deferred-box count (default: from the rows' zone states). The scheduler uses the async form. */
export function shadowScalpsDigestLine(rows?: SummaryInputRow[], s2PendingLiveDays?: number): string {
  const live = rows ?? readRows({ era: "live", fillModel: RULES.decisionModel });
  const anyRows = rows ? rows.length > 0 : !!db.$client.prepare(`SELECT 1 FROM shadow_scalps WHERE symbol=? LIMIT 1`).get(SYMBOL);
  if (!anyRows) return NO_ROWS_LINE;
  const pend = s2PendingLiveDays ?? zoneStatesOf(live.filter(r => r.era === "live")).pending;
  return digestLineOf(computeDecisions(live), pend);
}

/** The digest line for the 8:30 digest: paged read of live + pessimistic rows, yielding aggregation. */
export async function shadowScalpsDigestLineAsync(): Promise<string> {
  if (!db.$client.prepare(`SELECT 1 FROM shadow_scalps WHERE symbol=? LIMIT 1`).get(SYMBOL)) return NO_ROWS_LINE;
  const live = await readRowsPaged({ era: "live", fillModel: RULES.decisionModel });
  const dec = await runAsync(computeDecisionsGen(live));
  return digestLineOf(dec, zoneStatesOf(live).pending);
}
