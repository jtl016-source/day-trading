/**
 * INTRADAY CATCH-UP PASS (SCHEDULER 2026-08-02).
 *
 * Live signal persistence depends on an open browser tab being on the right interval at the
 * right moment — a closed laptop misses fires. This job re-runs the SHARED fact engine over
 * TODAY's healed bars using the PARITY-LOCKED live construction (the literal code path
 * scripts/fact-engine-parity.test.ts proves equal to both market.tsx and the backtest harness):
 *
 *   • candles come from the server's OWN /api/data/cached-continuous serving path (self-fetch —
 *     the same bytes a browser receives, cap/seam behavior included),
 *   • inputs built with @shared/live-adapter (buildBaseCandles / normalizeServed15m /
 *     deriveEngineSlices / buildFootprintMap) + /api/yellowbox/day-zones +
 *     /api/risk/combo-stats dayRangeMedian + real 5m footprint rows,
 *   • engine = @shared/fact-engine runFactEngine with the live defaults (gate ON, imported
 *     QUALITY_GATE, ZONE_REACTION_PTS 2.0, YELLOWBOX_SOLO false).
 *
 * Fires on TODAY's ET session day missing from signal_history are back-filled through the
 * guarded POST /api/signals/history with source='catchup':
 *   • catchup is REGEN-CLASS: the next --persist wipe (source IS NULL OR source<>'live')
 *     replaces catchup rows with the standing regen set — by design, they are stopgap rows.
 *   • live rows are NEVER touched: a stored source='live' row collides any non-live write
 *     (dropped whole) — the route enforces it; we only POST keys absent from the DB anyway.
 *   • outcome/exit fields ride the same canonical-resolver walk the engine performs
 *     (walkForward → shared/outcome-resolver), so a back-filled row carries the same record a
 *     live tab would have written.
 *
 * MISSED SESSION DAYS (2026-10-07, bottom of this file): whole session days the computer was off
 * for are back-filled the same way, one day per compute request, once their 1m bars are healed
 * (runMissedDayPass / runMissedDaysStep; docs/catchup-missed-days-README.md).
 */
import { db } from "./db";
import {
  buildBaseCandles, normalizeServed15m, deriveEngineSlices, buildFootprintMap, type LiveCandle,
} from "@shared/live-adapter";
import { runFactEngine, INTERVAL_SEC, FACT_ENGINE_DEFAULTS, type Interval, type FactSignal, type FpImbalanceZone, type FactEngineInput, type PriorFire } from "@shared/fact-engine";
import { etSessionDayBucket, rthSettleOfDay } from "@shared/firing/session";
import { sessionDayKey } from "@shared/yellowbox-core";
import { walkOutcomeCanonical, isOutcomeTransitionAllowed } from "@shared/outcome-resolver";
import { admitFires, describeRejections, OPEN_LOOKBACK_SEC, type AdmissionRejection } from "./fire-admission";
import { priorsFromRows } from "@shared/engine-seed"; // B5 (2026-09-25): ONE row→PriorFire mapping (server writers + the tab's /api/signals/prior-fires)
import { resolvePending as resolvePendingShadowExits } from "./shadow-exits"; // SHADOW EXITS (2026-10-01): record-only alternative exits

const SYMBOL = "MES";
const INTERVALS: Interval[] = ["1m", "5m", "15m", "60m"];
/** market.tsx windowSize_v4 default — the same context window a live tab computes over. */
const WINDOW_SIZE_DAYS = Number(process.env.CATCHUP_WINDOW_DAYS ?? 90);
const BASE_URL = `http://127.0.0.1:${process.env.PORT || "3000"}`;

export interface CatchupStatus {
  at: string;                 // ISO time of the pass
  trigger: "scheduled" | "manual";
  ok: boolean;
  error?: string;
  sessionDay?: string;        // ET session-day key examined
  engineFires?: number;       // today's gate-passing fires per the replay
  dbRows?: number;            // today's rows already in signal_history
  missing?: number;           // fires absent from the DB (what we back-filled)
  inserted?: number;          // route-confirmed inserts
  skipped?: number;           // route-side validation skips
  collisions?: number;        // live-row collisions (never touched — by design)
  /** FIRE ADMISSION (2026-09-24): replay fires refused before posting — a same-interval stored
   *  row within COOLDOWN_BARS bars, or a same-direction stored row still open at the entry. */
  admissionRejected?: number;
  admissionKeys?: string[];
  backfilledKeys?: string[];  // "interval|fireTs|direction" of the posted rows
  // DAILY LOSS STOP (2026-08-02 fix): the pass's day-P&L reading + whether the stop was
  // treated as tripped (engine then fires NOTHING for the current session — no re-posting
  // of fires the live engine suppressed).
  dayPnlPts?: number;
  lossStopTripped?: boolean;
  // STUCK-OPEN RESOLVER (2026-08-07): rows whose outcome this pass resolved from 1m bars.
  outcomesChecked?: number;
  outcomesResolved?: number;
  outcomeKeys?: string[];
  tookMs?: number;
  /** 2026-09-18: where the engine replays ran — "worker" = off the main thread. */
  computeMode?: "worker" | "inline";
}

let running = false;
export function catchupRunning(): boolean { return running; }

// market.tsx dateToTs (VERBATIM: UTC midnight of the day string) — same as the parity test.
function dateToTs(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Math.floor(new Date(Date.UTC(y, m - 1, d, 0)).getTime() / 1000);
}

/**
 * SELF-FETCH WITH TRANSIENT RETRY (2026-09-18 adversarial review). INCIDENT: a live pass makes ~7
 * self-fetches (cached-days, four served windows, day-zones, combo-stats) and this helper had NO
 * retry — one ECONNRESET / undici "fetch failed" on any of them failed the WHOLE pass. Durable log
 * 2026-09-18: "[live-engine] pass failed: fetch failed" at 13:35:17, 13:36:32, 13:58:21, 14:01:03,
 * each right after the main thread took 5.5–27 s to answer the 1m window (it SERVES these fetches,
 * so any stall on it resets/times out the caller's socket). live-engine's 30 s failed-pass backoff
 * then pushed the 1m retry past its 2-bar freshness window — the fire was lost to the 10-min
 * catch-up. NOW: a NETWORK-level failure (fetch() rejection — ECONNRESET / ECONNREFUSED / socket
 * closed — a reset while the body is still streaming, or a 502/503/504) is retried up to 2 more
 * times after 250 ms then 750 ms. UNCHANGED: every other HTTP status (4xx, 500…) and a JSON parse
 * error throw IMMEDIATELY with the same messages as before — those are answers, not weather.
 * An error that survives the retries carries TRANSIENT_FETCH_TAG so live-engine.ts can tell it
 * (across the worker boundary only the message string travels) and back off proportionally.
 */
const GETJSON_RETRY_DELAYS_MS = [250, 750];
export const TRANSIENT_FETCH_TAG = "[transient-fetch]";
export function isTransientFetchMessage(msg: string | null | undefined): boolean {
  return typeof msg === "string" && msg.includes(TRANSIENT_FETCH_TAG);
}
/** Exported for the retry harness only (flaky-stub verification) — not a public serving API. */
export async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null, body = "", transient = "";
    try {
      res = await fetch(url);
      if (res.status >= 502 && res.status <= 504) {
        transient = `HTTP ${res.status}`;
        try { await res.body?.cancel(); } catch { /* socket already gone */ }
      } else if (res.ok) {
        body = await res.text(); // inside the try: a reset mid-body (8.8 MB 1m window) is network weather too
      }
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const code = err?.cause?.code ?? err?.cause?.message;
      transient = `${err?.message ?? String(e)}${code ? ` (${code})` : ""}`;
    }
    if (!transient) {
      if (!res || !res.ok) throw new Error(`${url} → HTTP ${res?.status}`); // 4xx / 500 / 501…: immediately, as before
      return JSON.parse(body) as T;                                         // parse error: immediately, as before
    }
    if (attempt >= GETJSON_RETRY_DELAYS_MS.length) {
      throw new Error(`${url} → ${transient} ${TRANSIENT_FETCH_TAG} (${attempt + 1} attempts)`);
    }
    await new Promise<void>(r => setTimeout(r, GETJSON_RETRY_DELAYS_MS[attempt]));
  }
}
/** The production fetcher behind buildLiveEngineContext (BuildContextOptions.fetchJson overrides it in tests). */
function getJsonHttp<T>(url: string): Promise<T> { return getJson<T>(url); }

const yieldLoop = (): Promise<void> => new Promise<void>(r => setImmediate(r));

/**
 * DAILY LOSS STOP input (2026-08-02 fix — flagged by the risk-controls mission): the live
 * adapter (market.tsx) hands the engine `dayPnlPts` = the CURRENT Globex session day's CLOSED
 * signal points (all four intervals) + the open-trade mark against the latest price, STICKY
 * once tripped (the engine then fires nothing for the current session). A catch-up replay
 * without this input could re-post fires the live engine suppressed on a tripped day.
 *
 * Server-side mirror of the same contract: closed points + open mark from signal_history rows
 * of the current session bucket (the endpoint the adapter fetches serves these same rows),
 * latest price = last served 1m close (the adapter's lastPriceRef equivalent). STICKINESS is
 * replayed as the running minimum of the chronological (exit-ts-ordered) CLOSED-points sum —
 * the open-mark component of historical 60s snapshots is not reconstructable offline, so a
 * trip that only ever existed in an open-trade mark can be missed (documented approximation;
 * closed-points cumulative is the same basis the backtest harness's as-traded stop uses).
 * RULE REMOVED 2026-08-17 (user directive: "take away the rule for the funded accounts" —
 * the −80 stop tripped at 9:35 AM ET when the overnight ETH Long losses closed at the open,
 * suppressing the entire RTH session; funded accounts carry the prop firm's own daily limits,
 * so the engine-level stop is retired). Default threshold is now 0 = disabled; the machinery
 * stays intact and CATCHUP_DAILY_LOSS_STOP_PTS re-enables it at any value without a code
 * change (the old default lives in shared/fact-engine.ts DAILY_LOSS_STOP_DEFAULT_PTS).
 */
function computeDayLossStop(nowSec: number, lastPrice: number | null): {
  dayPnlPts: number; effectiveDayPnl: number; tripped: boolean; stopPts: number;
} {
  const envStop = Number(process.env.CATCHUP_DAILY_LOSS_STOP_PTS ?? NaN);
  const stopPts = Number.isFinite(envStop) && envStop >= 0 ? envStop : 0; // removed 2026-08-17 (was DAILY_LOSS_STOP_DEFAULT_PTS)
  const bucket = etSessionDayBucket(nowSec);
  const CLOSED = new Set(["win_tp1", "win_tp2", "loss", "eod"]);
  const rows = db.$client
    .prepare(`SELECT timestamp, outcome, points_result, entry, direction, exit_ts
                FROM signal_history WHERE symbol=? AND timestamp>=?`)
    .all(SYMBOL, nowSec - 2 * 86400) as Array<{
      timestamp: number; outcome: string | null; points_result: number | null;
      entry: number | null; direction: string | null; exit_ts: number | null;
    }>;
  let closedPts = 0, openMark = 0;
  const closedSeq: Array<{ ts: number; pts: number }> = [];
  for (const r of rows) {
    if (etSessionDayBucket(r.timestamp) !== bucket) continue;
    const oc = r.outcome ?? "open";
    if (CLOSED.has(oc)) {
      if (typeof r.points_result === "number" && Number.isFinite(r.points_result)) {
        closedPts += r.points_result;
        closedSeq.push({ ts: r.exit_ts ?? r.timestamp, pts: r.points_result });
      }
    } else if (oc === "open" && lastPrice != null && typeof r.entry === "number" && Number.isFinite(r.entry)) {
      openMark += (lastPrice - r.entry) * (String(r.direction ?? "").toLowerCase().startsWith("l") ? 1 : -1);
    }
  }
  const total = Math.round((closedPts + openMark) * 100) / 100;
  closedSeq.sort((a, b) => a.ts - b.ts);
  let run = 0, runMin = 0;
  for (const c of closedSeq) { run += c.pts; if (run < runMin) runMin = run; }
  const tripped = stopPts > 0 && (total <= -stopPts || runMin <= -stopPts);
  // Adapter parity: once tripped the engine input is pinned at/below the threshold so a
  // recovery can never read as un-tripped (market.tsx effectiveDayPnl).
  const effectiveDayPnl = tripped ? Math.min(total, -stopPts) : total;
  return { dayPnlPts: total, effectiveDayPnl, tripped, stopPts };
}

/**
 * STUCK-OPEN OUTCOME RESOLVER (2026-08-07 — journal [same-day-drift] follow-through).
 *
 * WHY: live-fired rows the healed-bar replay cannot reproduce ("dbOnly" fires — forming-bar
 * fires, live-only inputs) have NO owner to resolve their outcomes: a live tab only re-posts
 * outcomes for signals ITS OWN engine re-fires, and this catch-up pass only inserts MISSING
 * rows. Result observed 2026-08-05→07: five 15m rows whose stops were touched on the tape sat
 * "open" for days, understating day P&L (the daily loss stop reads closed points) and the
 * ledger. This pass now walks every open-ish row through the CANONICAL resolver
 * (shared/outcome-resolver walkOutcomeCanonical — first touch decides, SL-first ties,
 * win_tp1→win_tp2 upgrade watch) over the served 1m bars.
 *
 * WRITE DISCIPLINE (live-permanence respected — precedent: scripts/outcome-sweep-repair.ts,
 * the resolver module's documented "persisted-row corrector" consumer):
 *   • outcome + exit fields ONLY — source/entry/tp/sl/label are NEVER touched, so a live
 *     row's identity stays permanent; completing an open outcome is the row's natural
 *     lifecycle, not a collision.
 *   • the transition matrix is enforced in code AND repeated in the UPDATE's WHERE clause
 *     (open/NULL → anything; win_tp1 → win_tp2 only) — a concurrent live-tab write wins.
 *   • coverage guard (2026-07-31 lesson): rows whose fire bar predates the 1m data are
 *     SKIPPED — never resolve against bars that don't cover the trade.
 *   • TP1-ONLY (2026-09-24 review, journal signal-volume-pipeline-5): under the policy the walk
 *     can never return win_tp2, so the win_tp1 → win_tp2 "upgrade watch" is dead — it re-walked
 *     every closed winner of 14 days on every pass and its count was logged as the denominator
 *     ("resolved 13/595 stuck-open rows" with 2–10 rows really open). With TP1_ONLY only
 *     NULL/'open' rows are walked, so `checked` is the real open-row count; the legacy watch
 *     returns only if the policy flag is turned off.
 */
export function resolveStuckRows(bars1m: LiveCandle[], nowSec: number, tp1Only: boolean = FACT_ENGINE_DEFAULTS.TP1_ONLY): {
  checked: number; resolved: number; keys: string[];
} {
  const rnd2 = (v: number): number => Math.round(v * 100) / 100;
  const rows = db.$client
    .prepare(`SELECT id, interval, timestamp, direction, entry, tp1, tp2, sl, outcome
                FROM signal_history
               WHERE symbol=? AND timestamp>=? AND timestamp<=?
                 AND (outcome IS NULL OR outcome='open'${tp1Only ? "" : " OR outcome='win_tp1'"})`)
    .all(SYMBOL, nowSec - OPEN_LOOKBACK_SEC, nowSec) as Array<{
      id: number; interval: string; timestamp: number; direction: string;
      entry: number | null; tp1: number | null; tp2: number | null; sl: number | null;
      outcome: string | null;
    }>;
  let resolved = 0;
  const keys: string[] = [];
  if (!rows.length || !bars1m.length) return { checked: rows.length, resolved, keys };
  const lastBar = bars1m[bars1m.length - 1];
  // Conservative horizon: the last served 1m bar may still be forming — do not count its
  // close-time as covered (an eod/final verdict needs settle <= coveredThroughTs).
  const coveredThroughTs = Math.min(lastBar.time, nowSec);
  const upd = db.$client.prepare(
    `UPDATE signal_history
        SET outcome=?, exit_price=?, exit_ts=?, points_result=?, mae=?, mfe=?, bars_to_exit=?, updated_at=?
      WHERE id=? AND (outcome IS NULL OR outcome='open' OR (outcome='win_tp1' AND ?='win_tp2'))`);
  for (const r of rows) {
    const ivSec = INTERVAL_SEC[r.interval as Interval];
    if (!ivSec) continue;
    // TP1-ONLY (2026-08-13): tp2 is legitimately NULL on post-policy rows — only entry/tp1/sl
    // are required; the resolver never evaluates tp2 under the policy.
    if (!(typeof r.entry === "number" && typeof r.tp1 === "number" && typeof r.sl === "number")) continue;
    if (bars1m[0].time > r.timestamp) continue; // coverage guard — 1m data must span the fire bar
    // Settle of the entry's session day — same advance rule as the engine's walkForward
    // (a fire at/after its own day's settle resolves against the NEXT session's settle).
    let settleTs = rthSettleOfDay(r.timestamp);
    if (r.timestamp >= settleTs) {
      for (let d = 1; d <= 4; d++) { settleTs = rthSettleOfDay(r.timestamp + d * 86400); if (settleTs > r.timestamp) break; }
    }
    const isLong = String(r.direction ?? "").toLowerCase().startsWith("l");
    const w = walkOutcomeCanonical({
      bars: bars1m, entryTs: r.timestamp + ivSec, entry: r.entry, tp1: r.tp1, tp2: r.tp2, sl: r.sl,
      isLong, settleTs, barSec: 60, coveredThroughTs,
      tp1Only,
    });
    const stored = r.outcome ?? "open";
    if (w.outcome === "open" || w.outcome === stored) continue;         // nothing to write
    if (!isOutcomeTransitionAllowed(r.outcome, w.outcome)) continue;    // matrix says no (win_tp1 stays)
    const exitPrice = w.exitPrice as number, exitTs = w.exitTs as number;
    const pts = rnd2((exitPrice - r.entry) * (isLong ? 1 : -1));
    const res = upd.run(
      w.outcome, rnd2(exitPrice), exitTs, pts, rnd2(w.mae), rnd2(w.mfe),
      rnd2((exitTs - (r.timestamp + ivSec)) / ivSec), new Date().toISOString(),
      r.id, w.outcome,
    );
    if (res.changes > 0) {
      resolved++;
      keys.push(`${r.interval}|${r.timestamp}|${r.direction}:${stored}→${w.outcome}${pts >= 0 ? "+" : ""}${pts}`);
    }
  }
  return { checked: rows.length, resolved, keys };
}

/** SHARED LIVE-ENGINE CONTEXT (2026-08-13 server-side live engine): the parity-locked input
 *  pipeline extracted for reuse by BOTH the 10-min catch-up pass and server/live-engine.ts's
 *  per-bar-close loop. Everything here is byte-identical to the pre-extraction catch-up
 *  behavior — same fetches, same stuck-open resolve ordering, same loss-stop snapshot. */
export interface ServedCandles { candles: LiveCandle[]; resolution?: string }
export interface LiveEngineContext {
  nowSec: number;
  todayKey: string;
  servedByIv: Record<Interval, ServedCandles>;
  served1m: ServedCandles;
  feDayZones: Array<{ dayKeyET: string; sessionStartTs: number; sessionEndTs: number; boxTop: number; boxBottom: number; initRes: number; initSup: number }>;
  medianDayRange: number;
  fpByTime: Map<number, { imbalances: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> }>;
  dayLoss: { dayPnlPts: number; effectiveDayPnl: number; tripped: boolean; stopPts: number };
  stuck: { checked: number; resolved: number; keys: string[] };
  /** CROSS-WRITER SEED (2026-09-24): per interval, the fires already STORED in signal_history
   *  (any writer) — handed to runFactEngine as `priorFires` so this replay honours the cooldown
   *  cursor and the one-open-per-direction state other writers already committed to. Absent =
   *  no seeding (pre-2026-09-24 behaviour). */
  priorsByIv?: Partial<Record<Interval, PriorFire[]>>;
}

/** How far back stored fires seed the replay's cooldown/open state: the last ~2 Globex sessions
 *  in full, plus any row still open (NULL/'open') within the stuck-open horizon — an open
 *  bracket of any age blocks same-direction fires, a closed one older than this cannot. */
export const PRIOR_FIRE_LOOKBACK_SEC = 3 * 86400;

/** Stored fires per interval for the engine's `priorFires` input (read-only). entry/tp1/sl that
 *  are NULL become NaN — the engine then uses that prior for the cooldown only. */
export function loadPriorFires(nowSec: number, symbol: string = SYMBOL, fromTs?: number): Partial<Record<Interval, PriorFire[]>> {
  // MISSED SESSION DAYS (2026-10-07): a missed-day replay passes `fromTs` = its session start −
  // PRIOR_FIRE_LOOKBACK_SEC so the stored rows of the days BEFORE it seed the engine too. Absent
  // (every other caller, incl. GET /api/signals/prior-fires) = the unchanged 3-day lookback.
  const closedFrom = typeof fromTs === "number" && Number.isFinite(fromTs)
    ? Math.min(nowSec - PRIOR_FIRE_LOOKBACK_SEC, fromTs) : nowSec - PRIOR_FIRE_LOOKBACK_SEC;
  const rows = db.$client
    .prepare(`SELECT interval, timestamp, direction, entry, tp1, sl FROM signal_history
               WHERE symbol=? AND timestamp<=?
                 AND (timestamp>=? OR ((outcome IS NULL OR outcome='open') AND timestamp>=?))
               ORDER BY timestamp`)
    .all(symbol, nowSec, closedFrom, nowSec - OPEN_LOOKBACK_SEC) as Array<{
      interval: string; timestamp: number; direction: string; entry: number | null; tp1: number | null; sl: number | null;
    }>;
  // Mapping shared with the browser tab (shared/engine-seed.ts) — the tab reads THIS function's
  // output through GET /api/signals/prior-fires, so every writer seeds from the same fires.
  return priorsFromRows(rows);
}

/** OPTIONAL build knobs (2026-09-18 — "chart laggy / trouble staying live"). The DEFAULT ({}) is
 *  byte-identical to the pre-option behavior, so the 10-min catch-up pass and the parity test
 *  are untouched. */
export interface BuildContextOptions {
  /** When set (>= 0): fetch the four served windows ONE AT A TIME with this many ms of idle
   *  between them, instead of Promise.all. WHY: the windows are served by the MAIN thread (the
   *  1m 90-day response is ~8.8 MB — a synchronous SQLite read + filter chain + stringify); four
   *  simultaneous requests run back-to-back as one multi-second block with no I/O poll between
   *  them, so MotiveWave ticks and /ws/live-bars broadcasts queue behind the whole batch.
   *  Sequential + a gap turns that into four short blocks with a drain window after each.
   *  WHAT is fetched and HOW the results are used is unchanged — same URLs, same order
   *  (1m, 5m, 15m, 60m), same destructuring. Used by the live-engine pass (worker + inline). */
  sequentialFetchGapMs?: number;
  /** TEST SEAM (2026-09-25, B5): replaces the HTTP fetcher (getJson against the running
   *  server) so the context build — including the stuck-open resolve and the priorFires seed
   *  read — is exercised against a temp DB without a server. Production never passes it. */
  fetchJson?: <T>(url: string) => Promise<T>;
  /** MISSED SESSION DAYS (2026-10-07): widen the priorFires seed back to this ts (a missed-day
   *  replay: its session start − PRIOR_FIRE_LOOKBACK_SEC). Absent = the 3-day default. */
  priorFromTs?: number;
}

export async function buildLiveEngineContext(opts: BuildContextOptions = {}): Promise<LiveEngineContext> {
  const getJson: <T>(url: string) => Promise<T> = opts.fetchJson ?? getJsonHttp;
  const nowSec = Math.floor(Date.now() / 1000);
  const todayKey = sessionDayKey(nowSec);

  // ── Window + served candles (the REAL serving path — parity with a live tab) ──
  const daysResp = await getJson<{ days: Array<{ date: string }> }>(`${BASE_URL}/api/data/cached-days/${SYMBOL}`);
  const todayStr = new Date().toISOString().split("T")[0];
  const sortedDays = [...(daysResp.days ?? [])].filter(d => d.date <= todayStr).sort((a, b) => a.date.localeCompare(b.date));
  if (!sortedDays.length) throw new Error("no cached days");
  const windowedDays = sortedDays.slice(Math.max(0, sortedDays.length - WINDOW_SIZE_DAYS));
  const fromTs = dateToTs(windowedDays[0].date);
  const toTs = nowSec + 3600; // market.tsx stableToTs/toTs (parity test line 109)

  const cc = (iv: string): Promise<ServedCandles> =>
    getJson<ServedCandles>(`${BASE_URL}/api/data/cached-continuous/${SYMBOL}/${iv}?from=${fromTs}&to=${toTs}`);
  let served1m: ServedCandles, served5m: ServedCandles, served15m: ServedCandles, served60m: ServedCandles;
  const gapMs = opts.sequentialFetchGapMs;
  if (gapMs != null && gapMs >= 0) {
    // SEQUENTIAL (2026-09-18, live-engine pass only — see BuildContextOptions): one window at a
    // time, idle gap between, so the serving thread drains ticks between responses.
    const gap = (): Promise<void> => new Promise<void>(r => setTimeout(r, gapMs));
    served1m = await cc("1m"); await gap();
    served5m = await cc("5m"); await gap();
    served15m = await cc("15m"); await gap();
    served60m = await cc("60m");
  } else {
    [served1m, served5m, served15m, served60m] = await Promise.all([cc("1m"), cc("5m"), cc("15m"), cc("60m")]);
  }
  const servedByIv: Record<Interval, ServedCandles> = { "1m": served1m, "5m": served5m, "15m": served15m, "60m": served60m };

  const dz = await getJson<{ days: Array<{ dayKeyET: string; sessionStartTs: number; sessionEndTs: number; boxTop: number; boxBottom: number; initRes: number; initSup: number }> }>(
    `${BASE_URL}/api/yellowbox/day-zones?symbol=${SYMBOL}&fromTs=${fromTs}&toTs=${toTs}`);
  const feDayZones = (dz.days ?? []).map(d => ({
    dayKeyET: d.dayKeyET, sessionStartTs: d.sessionStartTs, sessionEndTs: d.sessionEndTs,
    boxTop: d.boxTop, boxBottom: d.boxBottom, initRes: d.initRes, initSup: d.initSup,
  }));

  const riskStats = await getJson<{ medianDayRange: number }>(`${BASE_URL}/api/risk/combo-stats`);

  // Footprint: REAL complete 5m rows (in-process read of the same table the parity test reads).
  const fpRows = db.$client
    .prepare(`SELECT time, data FROM footprint_candles WHERE symbol=? AND interval='5m' AND complete=1`)
    .all(SYMBOL) as Array<{ time: number; data: string }>;
  const fpByTime = new Map<number, { imbalances: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> }>();
  for (const r of fpRows) {
    try {
      const d = JSON.parse(r.data) as { imbalances?: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> };
      if (d.imbalances?.length) fpByTime.set(r.time, { imbalances: d.imbalances });
    } catch { /* malformed row — no fact */ }
  }

  // STUCK-OPEN RESOLVER (2026-08-07): resolve open-ish rows from the served 1m bars BEFORE
  // the loss-stop snapshot, so freshly closed losses count toward dayPnl/trip immediately.
  const stuck = resolveStuckRows(served1m.candles, nowSec);
  if (stuck.resolved) {
    console.log(`[catchup] resolved ${stuck.resolved} of ${stuck.checked} open row(s): ${stuck.keys.join(", ")}`);
  }

  // DAILY LOSS STOP (2026-08-02 fix): one snapshot per pass, handed to every interval's
  // engine run — the engine itself suppresses all current-session fires when tripped.
  const lastPrice = served1m.candles.length ? served1m.candles[served1m.candles.length - 1].close : null;
  const dayLoss = computeDayLossStop(nowSec, lastPrice);

  // CROSS-WRITER SEED (2026-09-24): read AFTER the stuck-open resolve (the engine walks each
  // stored bracket itself; the stored outcome is not needed, only the fire + its levels).
  const priorsByIv = loadPriorFires(nowSec, SYMBOL, opts.priorFromTs);

  return { nowSec, todayKey, servedByIv, served1m, feDayZones, medianDayRange: riskStats.medianDayRange, fpByTime, dayLoss, stuck, priorsByIv };
}

/** One interval's engine INPUT over a built context (live defaults — parity test lines 156-193).
 *  null = the primary slice is missing (no fires possible). Exported so the wiring (settings =
 *  FACT_ENGINE_DEFAULTS for COOLDOWN_BARS / ONE_OPEN_PER_DIRECTION / YB_BREAK_EVENT_BARS, the
 *  priorFires seed) is testable without a server. */
export function engineInputForInterval(ctx: LiveEngineContext, iv: Interval): FactEngineInput | null {
  const raw = ctx.servedByIv[iv];
  const candleData: LiveCandle[] = iv === "15m" ? normalizeServed15m(raw.candles, raw.resolution) : raw.candles;
  const windowedCandles = buildBaseCandles(candleData, /*showETH*/ true, ctx.nowSec);
  const { slices } = deriveEngineSlices({
    interval: iv,
    windowedCandles,
    raw1mCandles: iv !== "1m" ? ctx.served1m.candles : undefined,
    rawCandles: raw.candles,
    raw60mCandles: iv !== "60m" ? ctx.servedByIv["60m"].candles : undefined,
  });
  if (!slices.some(sl => sl.interval === iv)) return null;
  // Footprint zones exist for 5m/15m primaries only (5m-based footprint — market.tsx rule).
  const footprintByTime: Map<number, FpImbalanceZone[]> = (iv === "5m" || iv === "15m")
    ? buildFootprintMap(windowedCandles, t => ctx.fpByTime.get(t))
    : new Map();

  return {
    primary: iv,
    slices,
    zones: [], // no uploaded milk zones (live default state)
    dayZones: ctx.feDayZones,
    footprintByTime,
    // ONLY these two overrides — COOLDOWN_BARS (10), ONE_OPEN_PER_DIRECTION (true) and
    // YB_BREAK_EVENT_BARS (3) come from FACT_ENGINE_DEFAULTS, never a copy (2026-09-24 B5).
    settings: { ZONE_REACTION_PTS: 2.0, YELLOWBOX_SOLO: false },
    nowSec: ctx.nowSec,
    qualityGateEnabled: true,
    // gateData omitted — imported QUALITY_GATE, same as market.tsx
    // ict/fractal/fractalGeo omitted — default ON, same as the live toggles' defaults
    // deadTapeSuppressEnabled omitted — engine default ON == the live toggle's default
    dayRangeMedian: ctx.medianDayRange > 0 ? ctx.medianDayRange : undefined,
    // FAIL-CLOSED (2026-08-07, journal [same-day-drift]): a missing median means the
    // replay fires NOTHING (mirrors the live tab's contract — better a silent pass than
    // back-filling rows the dead-tape gate never judged).
    deadTapeFailClosed: true,
    // DAILY LOSS STOP (2026-08-02 fix): same inputs the live adapter hands the engine —
    // sticky-pinned day P&L + the active stop threshold (0 = disabled).
    dayPnlPts: ctx.dayLoss.effectiveDayPnl,
    dailyLossStopPts: ctx.dayLoss.stopPts,
    // CROSS-WRITER SEED (2026-09-24): this interval's stored fires (catch-up, live engine,
    // tabs, regen) act as this replay's own earlier fires — cooldown cursor + open brackets.
    // The persist-time admission (server/fire-admission.ts) still guards the rows a replay
    // produces BEFORE a stored fire (priors cannot block earlier bars — no lookahead).
    ...(ctx.priorsByIv?.[iv]?.length ? { priorFires: ctx.priorsByIv[iv] } : {}),
  };
}

/** One interval's engine replay over a built context. */
export function runEngineForInterval(ctx: LiveEngineContext, iv: Interval): FactSignal[] {
  const input = engineInputForInterval(ctx, iv);
  return input ? runFactEngine(input) : [];
}

/** COMPUTE HALF of the catch-up pass (2026-09-18 — "chart laggy / trouble staying live"): the
 *  context build + the four engine replays, extracted VERBATIM from runCatchupPass so it can run
 *  either here (default — behavior unchanged) or inside the live-engine worker thread. MEASURED
 *  the same day: the four replays are ~13 s of synchronous CPU (1m 8.2 s / 5m 3.3 s / 15m 1.2 s
 *  / 60m 0.3 s) — on the main thread that was an 8-second chart freeze every 10 minutes, the
 *  yieldLoop between intervals notwithstanding. Everything that WRITES through main-thread
 *  routes (the DB diff + the guarded backfill POST) stays in runCatchupPass. */
export interface CatchupCompute {
  nowSec: number;
  todayKey: string;
  dayLoss: LiveEngineContext["dayLoss"];
  stuck: LiveEngineContext["stuck"];
  todaysFires: FactSignal[];
  /** Where the compute ran (set by the delegate; absent = inline default). */
  computeMode?: "worker" | "inline";
  /** MISSED SESSION DAYS (2026-10-07): set when this compute replayed a PAST session day (then
   *  `todayKey` = that day and `todaysFires` = that day's fires). Absent = the normal today pass. */
  missedDay?: string;
}
export interface CatchupComputeOptions extends BuildContextOptions {
  /** Replay this past session day instead of today (tests / inline). The worker path carries it
   *  through app_settings `catchup_missed_job` instead — see computeMissedDayViaDelegate. */
  missedDay?: string;
}
export async function computeCatchup(opts: CatchupComputeOptions = {}): Promise<CatchupCompute> {
  // MISSED SESSION DAYS (2026-10-07): the worker's {type:"catchup"} message carries no argument, so
  // the main thread hands the day over in app_settings right before the request (one day per
  // request). No job (every normal pass) = the unchanged today replay below.
  const missedDay = opts.missedDay ?? readMissedDayJob(Math.floor(Date.now() / 1000));
  if (missedDay) return computeMissedDay(missedDay, opts);
  const ctx = await buildLiveEngineContext(opts);
  const { nowSec, todayKey, dayLoss, stuck } = ctx;

  // ── Engine replay per primary interval (live defaults — parity test lines 156-193) ──
  const todaysFires: FactSignal[] = [];
  for (const iv of INTERVALS) {
    const fired = runEngineForInterval(ctx, iv);
    for (const s of fired) if (sessionDayKey(s.time) === todayKey) todaysFires.push(s);
    await yieldLoop(); // the pass is synchronous CPU — let live requests breathe between intervals
  }
  // SHADOW EXITS (2026-10-01): after this pass's stuck-row resolve + replays, record alternative
  // exits for pending fires. FIRE-AND-FORGET on purpose: in the worker the catch-up reply is posted
  // without waiting, so the serialized request chain (the per-bar live pass = the order path) never
  // queues behind it; the job self-chunks (≤ ~100 ms per slice), caps 400 fires, never throws, and
  // skips when a previous run is still going. NOT in buildLiveEngineContext — that also feeds the
  // per-bar live pass.
  void resolvePendingShadowExits(nowSec);
  return { nowSec, todayKey, dayLoss, stuck, todaysFires };
}

/** Optional off-thread runner for computeCatchup — registered by server/live-engine.ts (which
 *  owns the worker; registering from there keeps this module free of any worker/import cycle).
 *  The delegate owns its own fallback: it must resolve with an INLINE computeCatchup() when the
 *  worker is unavailable, so an unregistered or broken delegate can never stop the safety net. */
let computeDelegate: (() => Promise<CatchupCompute>) | null = null;
export function setCatchupComputeDelegate(fn: (() => Promise<CatchupCompute>) | null): void { computeDelegate = fn; }

/** Route answer of POST /api/signals/history (the fields the catch-up reads). */
export interface BackfillPostResult {
  inserted: number; skipped: number; collisions?: number;
  admissionRejected?: number;
  admissionKeys?: Array<{ interval: string; timestamp: number; direction: string; reason: string }>;
}
/** Writes the back-fill rows. Production = the guarded POST route (HTTP to this same server);
 *  tests pass server/fire-admission.ts writeSignalRows (the route's write core) instead. */
export type BackfillPoster = (rows: Array<Record<string, unknown>>) => Promise<BackfillPostResult>;

async function postBackfillHttp(rows: Array<Record<string, unknown>>): Promise<BackfillPostResult> {
  const res = await fetch(`${BASE_URL}/api/signals/history`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signals: rows }),
  });
  if (!res.ok) throw new Error(`backfill POST → HTTP ${res.status}`);
  return await res.json() as BackfillPostResult;
}

interface BackfillOutcome {
  dbRows: number; missing: number; inserted: number; skipped: number; collisions: number;
  admissionRejected: number; admissionKeys: string[]; backfilledKeys: string[];
  localRejected: Array<AdmissionRejection<{ symbol: string; interval: string; timestamp: number; direction: string }>>;
  routeRejected: number;
}

/** DIFF + ADMISSION + GUARDED POST for ONE session day's replay fires (extracted VERBATIM from
 *  runCatchupPass on 2026-10-07 so the missed-day pass uses the identical semantics). Stored rows
 *  of `dayKey` (any source) are read from `rowsFromTs` on; only absent natural keys are posted,
 *  after the same admission the route enforces; every row is source='catchup'. */
async function backfillSessionFires(
  dayKey: string, fires: FactSignal[], rowsFromTs: number, post: BackfillPoster,
): Promise<BackfillOutcome> {
  // ── Diff against signal_history (natural key symbol|interval|timestamp|direction) ──
  const dbRows = db.$client
    .prepare(`SELECT interval, timestamp, direction FROM signal_history WHERE symbol=? AND timestamp>=?`)
    .all(SYMBOL, rowsFromTs) as Array<{ interval: string; timestamp: number; direction: string }>;
  const dbDay = dbRows.filter(r => sessionDayKey(r.timestamp) === dayKey);
  const dbKeys = new Set(dbDay.map(r => `${r.interval}|${r.timestamp}|${r.direction}`));
  const missingAll = fires.filter(s => !dbKeys.has(`${s.interval}|${s.time}|${s.direction}`));
  // FIRE ADMISSION (2026-09-24): the same rule the POST route enforces (server/fire-admission.ts)
  // applied here first, so the pass reports honestly what it refused and never posts a fire
  // that sits within COOLDOWN_BARS of a stored row (either side, either direction) or while a
  // same-direction stored trade is still open — the cross-writer union class.
  const adm = admitFires(missingAll.map(s => ({
    symbol: SYMBOL, interval: s.interval, timestamp: s.time, direction: s.direction,
    outcome: s.eodClose ? "eod" : s.outcome, exitTs: s.exitTs ?? null, sig: s,
  })));
  const missing = adm.admitted.map(a => a.sig);
  const admissionKeys = adm.rejected.map(r => `${r.row.interval}|${r.row.timestamp}|${r.row.direction}:${r.reason}`);

  let inserted = 0, skipped = 0, collisions = 0, routeRejected = 0;
  const backfilledKeys = missing.map(s => `${s.interval}|${s.time}|${s.direction}`);
  if (missing.length) {
    // Same FactSignal→row mapping market.tsx and --persist use (riskLevel single-tier "safe";
    // engine outcome is already DB vocabulary; eodClose persists as "eod").
    const rows = missing.map(s => ({
      symbol: SYMBOL, interval: s.interval, timestamp: s.time, direction: s.direction,
      riskLevel: "safe", signalType: s.signalType, entry: s.price, tp1: s.tp1, tp2: s.tp2, sl: s.sl,
      outcome: s.eodClose ? "eod" : s.outcome,
      label: s.label,
      ...(s.confirmations ? { confirmations: s.confirmations } : {}),
      exitPrice: s.exitPrice ?? null, exitTs: s.exitTs ?? null, pointsResult: s.pointsResult ?? null,
      mae: s.mae ?? null, mfe: s.mfe ?? null, barsToExit: s.barsToExit ?? null,
      comboKey: s.comboKey ?? null, riskFlags: s.riskFlags ?? null,
      // POSITION SIZING (2026-08-02): combo-tier suggested size rides along like live rows.
      suggestedContracts: s.suggestedContracts ?? null,
      shadowTags: s.shadowTags ?? null, // SHADOW TAGS (2026-10-01): record-only, stored as JSON by writeSignalRows
      source: "catchup", // regen-class provenance (route accepts the third literal; wipe replaces it)
    }));
    const j = await post(rows);
    inserted = j.inserted; skipped = j.skipped; collisions = j.collisions ?? 0;
    // A concurrent writer can land between this pre-check and the route's own check — the
    // route's verdict is the one that counts.
    routeRejected = j.admissionRejected ?? 0;
    for (const k of j.admissionKeys ?? []) admissionKeys.push(`${k.interval}|${k.timestamp}|${k.direction}:${k.reason}`);
  }
  return {
    dbRows: dbDay.length, missing: missing.length, inserted, skipped, collisions,
    admissionRejected: adm.rejected.length + routeRejected, admissionKeys, backfilledKeys,
    localRejected: adm.rejected, routeRejected,
  };
}

export async function runCatchupPass(trigger: "scheduled" | "manual"): Promise<CatchupStatus> {
  const at = new Date().toISOString();
  if (running) return { at, trigger, ok: false, error: "catch-up pass already running" };
  running = true;
  const t0 = Date.now();
  try {
    // MISSED SESSION DAYS (2026-10-07): never leave a missed-day job behind for a today compute
    // (`running` makes this pass the only consumer of the key right now).
    clearMissedDayJob();
    const computed = await (computeDelegate ?? computeCatchup)();
    if (computed.missedDay) throw new Error(`compute answered missed day ${computed.missedDay} for a today pass (stale job) — retried next pass`);
    const { nowSec, todayKey, dayLoss, stuck, todaysFires } = computed;

    const b = await backfillSessionFires(todayKey, todaysFires, nowSec - 3 * 86400, postBackfillHttp);
    const { inserted, skipped, collisions, backfilledKeys, admissionRejected, admissionKeys, routeRejected } = b;

    // MISSED SESSION DAYS (2026-10-07): queue any session day missed since the previous good pass
    // (runMissedDayPass back-fills it) and move the coverage anchor up to this pass.
    try { noteRegularCatchupOk(nowSec); }
    catch (e: any) { console.error(`[catchup] missed-day bookkeeping failed: ${e?.message ?? e}`); }

    const tookMs = Date.now() - t0;
    const status: CatchupStatus = {
      at, trigger, ok: true, sessionDay: todayKey,
      engineFires: todaysFires.length, dbRows: b.dbRows,
      missing: b.missing, inserted, skipped, collisions, backfilledKeys,
      admissionRejected, admissionKeys,
      dayPnlPts: dayLoss.dayPnlPts, lossStopTripped: dayLoss.tripped,
      outcomesChecked: stuck.checked, outcomesResolved: stuck.resolved, outcomeKeys: stuck.keys,
      tookMs, computeMode: computed.computeMode ?? "inline",
    };
    console.log(
      `[catchup] ${trigger} pass ${todayKey}: engine ${todaysFires.length} fires today, db ${b.dbRows} rows, ` +
      `missing ${b.missing} → inserted ${inserted}, skipped ${skipped}, collisions ${collisions}; ` +
      (admissionRejected ? `admission ${b.localRejected.length ? describeRejections(b.localRejected) : "0 rejected"}${routeRejected ? ` + ${routeRejected} at the route` : ""}; ` : "") +
      `outcomes resolved ${stuck.resolved}/${stuck.checked} open; ` +
      `dayPnl ${dayLoss.dayPnlPts >= 0 ? "+" : ""}${dayLoss.dayPnlPts} pts vs stop ${dayLoss.stopPts}` +
      (dayLoss.tripped ? " — LOSS STOP TRIPPED (current-session fires suppressed by the engine)" : "") +
      ` (${tookMs}ms, compute ${computed.computeMode ?? "inline"})` +
      (backfilledKeys.length ? ` keys: ${backfilledKeys.join(", ")}` : ""),
    );
    return status;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[catchup] ${trigger} pass FAILED: ${msg}`);
    return { at, trigger, ok: false, error: msg, tookMs: Date.now() - t0 };
  } finally {
    running = false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// MISSED SESSION DAYS (2026-10-07 — owner: "if i turn off my computer … if there was a candle that
// shouldve had a signal, i want this so i can see if the program is still running correctly").
//
// The today pass above only back-fills fires whose session day is TODAY, so a laptop that was off
// for one or more whole sessions left those days empty in signal_history / the Signals tab forever
// (the Sunday regen that used to re-baseline them is dormant). This section finds those days and
// back-fills them with the SAME replay + admission + guarded POST + source='catchup' semantics:
//
//   • DETECTION: ET weekday sessions (CME special closures excluded) between the coverage ANCHOR —
//     the last successful today pass (seeded from app_settings scheduler_last_catchup on first use)
//     — and today. The anchor's own day counts when the anchor pass ran more than
//     MISSED_TAIL_GRACE_SEC before that session's close. Only the last MAX_MISSED_SESSIONS session
//     days before today are RECOVERABLE (Yahoo/gap-heal serve ~7 days of 1m bars); older missed
//     days are REPORTED as not recoverable, never faked.
//   • BARS FIRST: a day is replayed only when cached_candles holds ≥ MISSED_MIN_COVERAGE of its
//     session minutes at 1m; otherwise it is deferred ("bars not healed yet") and retried on the
//     next step (gap-heal runs every 10 min). Strict chronological order: later days wait for an
//     unhealed older one for MISSED_DEFER_BEFORE_SKIP attempts, then go ahead without it.
//   • ONE DAY PER COMPUTE REQUEST: the day rides to the worker in app_settings `catchup_missed_job`
//     (the worker's {type:"catchup"} message carries no argument); the replay seeds the engine with
//     the stored rows of the days BEFORE it (priorFires from session start − 3 days) and keeps only
//     that day's fires; outcomes are the engine's canonical-resolver walk on the healed 1m bars.
//   • IDEMPOTENT: only natural keys absent from signal_history are posted; live rows are never
//     touched (the route's collision guard + we never post an existing key); a finished day is
//     recorded in `done` and never re-queued.
//   • STATE: app_settings `catchup_missed_days` (anchor, pending, deferred, done, unrecoverable).
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Session days back from today that the 1m store can still heal (Yahoo 1m depth ≈ 7 days). */
export const MAX_MISSED_SESSIONS = 7;
/** A missed day is replayed only when the 1m store covers this share of its session minutes. */
export const MISSED_MIN_COVERAGE = 0.9;
/** The anchor pass's own day counts as missed only if that pass ran more than this before its close
 *  (the 10-min cadence always leaves ≤ 10 min uncovered at a session's end — not a missed day). */
export const MISSED_TAIL_GRACE_SEC = 15 * 60;
/** Deferred attempts on the OLDEST pending day before later (healed) days stop waiting for it. */
export const MISSED_DEFER_BEFORE_SKIP = 6;
export const MISSED_STATE_KEY = "catchup_missed_days";
export const MISSED_JOB_KEY = "catchup_missed_job";
const MISSED_JOB_TTL_SEC = 15 * 60;
const MISSED_KEEP = 40;            // done / unrecoverable entries kept in the state
const MISSED_SCAN_MAX_DAYS = 400;  // detection never walks further back than this

/** CME equity-index futures (ES/MES) special sessions: "closed" = no session that day, a number =
 *  the early halt in ET minutes after midnight (780 = 13:00, 795 = 13:15, 615 = 10:15). The 2026
 *  store confirms the past ones (1m counts 1135–1140 on the 13:00 halts, 953 on 2026-04-03). An
 *  UNLISTED holiday is never faked: it fails the coverage check, waits, and ages out as "beyond the
 *  7-day bar depth" (reported). Extend this table every year (docs/catchup-missed-days-README.md). */
export const CME_EQUITY_SPECIAL_SESSIONS: Readonly<Record<string, "closed" | number>> = {
  "2026-01-01": "closed", "2026-01-19": 780, "2026-02-16": 780, "2026-04-03": 615,
  "2026-05-25": 780, "2026-06-19": 780, "2026-07-03": 780, "2026-09-07": 780,
  "2026-11-26": 780, "2026-11-27": 795, "2026-12-24": 795, "2026-12-25": "closed",
  "2027-01-01": "closed", "2027-01-18": 780, "2027-02-15": 780, "2027-03-26": "closed",
  "2027-05-31": 780, "2027-06-18": 780, "2027-07-05": 780, "2027-09-06": 780,
  "2027-11-25": 780, "2027-11-26": 795, "2027-12-24": "closed",
};

const _etHmFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
/** Unix seconds of ET wall clock h:m on calendar date `dateKey` (DST-safe: EDT tried, verified via Intl, else EST). */
export function etWallToUtcSec(dateKey: string, h: number, m: number): number {
  const [y, mo, d] = dateKey.split("-").map(Number);
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off, m) / 1000;
    const p = Object.fromEntries(_etHmFmt.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
    if (Number(p.hour) % 24 === h && Number(p.minute) === m) return t;
  }
  return Date.UTC(y, mo - 1, d, h + 5, m) / 1000;
}
/** Calendar-day arithmetic on a YYYY-MM-DD key (UTC-anchored, timezone-independent). */
export function addDaysKey(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** A Globex session day the market actually trades (Mon–Fri, not a listed full closure). */
export function isSessionDay(key: string): boolean {
  const wd = new Date(`${key}T00:00:00Z`).getUTCDay();
  return wd >= 1 && wd <= 5 && CME_EQUITY_SPECIAL_SESSIONS[key] !== "closed";
}
/** [18:00 ET the evening before, 17:00 ET (or the listed early halt)) of session day `key`. */
export function sessionBounds(key: string): { startSec: number; endSec: number; minutes: number } {
  const startSec = etWallToUtcSec(addDaysKey(key, -1), 18, 0);
  const special = CME_EQUITY_SPECIAL_SESSIONS[key];
  const closeMins = typeof special === "number" ? special : 17 * 60;
  const endSec = etWallToUtcSec(key, Math.floor(closeMins / 60), closeMins % 60);
  return { startSec, endSec, minutes: Math.max(0, Math.round((endSec - startSec) / 60)) };
}
/** The `n` session days immediately before `todayKey`, newest first. */
export function previousSessionDays(todayKey: string, n: number): string[] {
  const out: string[] = [];
  for (let d = addDaysKey(todayKey, -1), i = 0; out.length < n && i < 60; d = addDaysKey(d, -1), i++) {
    if (isSessionDay(d)) out.push(d);
  }
  return out;
}
/** 1m bars stored for a session day vs its session minutes. */
export function sessionCoverage(key: string): { bars: number; minutes: number; pct: number } {
  const { startSec, endSec, minutes } = sessionBounds(key);
  const r = db.$client
    .prepare(`SELECT COUNT(*) AS n FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<?`)
    .get(SYMBOL, startSec, endSec) as { n: number } | undefined;
  const bars = r?.n ?? 0;
  return { bars, minutes, pct: minutes > 0 ? bars / minutes : 0 };
}

/** Session days missed between the coverage anchor and today (today itself = the today pass). */
export function missedSessionDays(anchorSec: number, nowSec: number): { recoverable: string[]; beyondDepth: string[] } {
  const today = sessionDayKey(nowSec);
  const anchorDay = sessionDayKey(anchorSec);
  const recoverable: string[] = [], beyondDepth: string[] = [];
  if (!(anchorDay < today)) return { recoverable, beyondDepth };
  const floor = addDaysKey(today, -MISSED_SCAN_MAX_DAYS);
  const depth = new Set(previousSessionDays(today, MAX_MISSED_SESSIONS));
  for (let d = anchorDay < floor ? floor : anchorDay; d < today; d = addDaysKey(d, 1)) {
    if (!isSessionDay(d)) continue;
    if (d === anchorDay && sessionBounds(d).endSec - anchorSec <= MISSED_TAIL_GRACE_SEC) continue;
    (depth.has(d) ? recoverable : beyondDepth).push(d);
  }
  return { recoverable, beyondDepth };
}

export interface MissedDayDone {
  day: string; at: string; trigger: string;
  engineFires: number; dbRows: number; missing: number; inserted: number; skipped: number; collisions: number;
  admissionRejected: number; keys: string[]; admissionKeys: string[];
  coveragePct: number; computeMode?: string; tookMs: number;
}
export interface MissedDaysState {
  v: 1;
  /** Unix sec: catch-up coverage is known up to here (last good today pass, or today's session start after a detection). */
  anchorAt: number;
  /** Recoverable missed session days still to back-fill, chronological. */
  pending: string[];
  deferred: Record<string, { reason: string; coveragePct: number; attempts: number; lastAt: string }>;
  done: MissedDayDone[];
  unrecoverable: Array<{ day: string; at: string; reason: string }>;
  lastError?: { at: string; day?: string; error: string };
}

function readAppSetting(key: string): string | null {
  try {
    const r = db.$client.prepare(`SELECT value FROM app_settings WHERE key=?`).get(key) as { value?: string } | undefined;
    return r?.value ?? null;
  } catch { return null; }
}
function writeAppSetting(key: string, value: string): void {
  db.$client.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, value);
}
/** The stored state, or null when it was never written / is unreadable (read-only). */
export function getMissedDaysState(): MissedDaysState | null {
  const raw = readAppSetting(MISSED_STATE_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as MissedDaysState;
    if (s?.v !== 1 || !Number.isFinite(s.anchorAt) || !Array.isArray(s.pending)) return null;
    s.deferred ??= {}; s.done ??= []; s.unrecoverable ??= [];
    return s;
  } catch { return null; }
}
function loadMissedState(nowSec: number): MissedDaysState {
  const s = getMissedDaysState();
  if (s) return s;
  // FIRST USE: seed the anchor from the scheduler's last RECORDED pass — successful or failed. A
  // failed pass still proves the server was alive at that moment, and the days after it are the
  // missed ones (its own day is re-examined by the 15-min-before-close rule + the idempotent
  // diff). Requiring ok:true here (review 2026-10-07) would let one transient fetch error on the
  // last pass before a shutdown hide the whole outage. Without any record, start at now — a
  // fresh install never invents missed days it cannot know about.
  let anchorAt = nowSec;
  try {
    const last = JSON.parse(readAppSetting("scheduler_last_catchup") ?? "null") as { at?: string; ok?: boolean } | null;
    const t = last?.at ? Math.floor(Date.parse(last.at) / 1000) : NaN;
    if (Number.isFinite(t) && t <= nowSec) anchorAt = t;
  } catch { /* unreadable → now */ }
  return { v: 1, anchorAt, pending: [], deferred: {}, done: [], unrecoverable: [] };
}
function saveMissedState(s: MissedDaysState): void {
  if (s.done.length > MISSED_KEEP) s.done = s.done.slice(-MISSED_KEEP);
  if (s.unrecoverable.length > MISSED_KEEP) s.unrecoverable = s.unrecoverable.slice(-MISSED_KEEP);
  writeAppSetting(MISSED_STATE_KEY, JSON.stringify(s));
}

/** Detect + classify every session day before today: new missed days are queued (recoverable) or
 *  reported (beyond the depth); pending days that aged out of the depth become unrecoverable; the
 *  anchor moves to today's session start. Writes the state only when something changed. Callers
 *  hold the catch-up `running` flag (or are the scheduler tick while no pass runs). */
export function refreshMissedDays(nowSec: number): MissedDaysState {
  const s = loadMissedState(nowSec);
  const before = JSON.stringify(s);
  const atIso = new Date(nowSec * 1000).toISOString();
  const today = sessionDayKey(nowSec);
  const { recoverable, beyondDepth } = missedSessionDays(s.anchorAt, nowSec);
  const known = new Set<string>([...s.pending, ...s.done.map(d => d.day), ...s.unrecoverable.map(u => u.day)]);
  for (const d of recoverable) if (!known.has(d)) { s.pending.push(d); known.add(d); }
  for (const d of beyondDepth) if (!known.has(d)) { s.unrecoverable.push({ day: d, at: atIso, reason: "beyond-depth" }); known.add(d); }
  const depth = new Set(previousSessionDays(today, MAX_MISSED_SESSIONS));
  const keep: string[] = [];
  for (const d of s.pending) {
    if (depth.has(d)) { keep.push(d); continue; }
    const def = s.deferred[d];
    s.unrecoverable.push({ day: d, at: atIso, reason: def ? `bars never healed (${def.coveragePct}% of the session at 1m)` : "beyond-depth" });
    delete s.deferred[d];
  }
  s.pending = [...new Set(keep)].sort();
  for (const d of Object.keys(s.deferred)) if (!s.pending.includes(d)) delete s.deferred[d];
  s.anchorAt = Math.max(s.anchorAt, sessionBounds(today).startSec);
  if (JSON.stringify(s) !== before || getMissedDaysState() == null) saveMissedState(s);
  return s;
}

/** Called by runCatchupPass after a GOOD today pass: detect against the previous anchor first,
 *  then move the anchor to this pass. */
export function noteRegularCatchupOk(nowSec: number): void {
  const s = refreshMissedDays(nowSec);
  if (nowSec > s.anchorAt) { s.anchorAt = nowSec; saveMissedState(s); }
}

/** Pending recoverable days after a detection pass (the scheduler's "is there work?" check). */
export function missedDaysPendingCount(nowSec: number = Math.floor(Date.now() / 1000)): number {
  return refreshMissedDays(nowSec).pending.length;
}

/** The day a missed-day compute request asked for (worker side), or null. Expired jobs are ignored. */
export function readMissedDayJob(nowSec: number): string | null {
  const raw = readAppSetting(MISSED_JOB_KEY);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { day?: string; at?: number };
    if (typeof j?.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(j.day)) return null;
    if (!Number.isFinite(j.at) || nowSec - (j.at as number) > MISSED_JOB_TTL_SEC) return null;
    return j.day;
  } catch { return null; }
}
export function clearMissedDayJob(): void {
  try { db.$client.prepare(`DELETE FROM app_settings WHERE key=?`).run(MISSED_JOB_KEY); } catch { /* best effort — the TTL expires it */ }
}

/** COMPUTE HALF for one missed day (runs in the worker via the job key, or inline): the parity
 *  context with the priorFires seed widened back to the day's session start − 3 days, the four
 *  replays, and only that day's fires kept. No shadow-exit job (the today pass owns it). */
async function computeMissedDay(day: string, opts: BuildContextOptions): Promise<CatchupCompute> {
  const { startSec } = sessionBounds(day);
  const ctx = await buildLiveEngineContext({ ...opts, priorFromTs: startSec - PRIOR_FIRE_LOOKBACK_SEC });
  const fires: FactSignal[] = [];
  for (const iv of INTERVALS) {
    for (const s of runEngineForInterval(ctx, iv)) if (sessionDayKey(s.time) === day) fires.push(s);
    await yieldLoop();
  }
  return { nowSec: ctx.nowSec, todayKey: day, dayLoss: ctx.dayLoss, stuck: ctx.stuck, todaysFires: fires, missedDay: day };
}

async function computeMissedDayViaDelegate(day: string): Promise<CatchupCompute> {
  writeAppSetting(MISSED_JOB_KEY, JSON.stringify({ day, at: Math.floor(Date.now() / 1000) }));
  try { return await (computeDelegate ?? computeCatchup)(); }
  finally { clearMissedDayJob(); }
}

export interface MissedDayDeps {
  /** Test clock (unix sec). */
  nowSec?: number;
  /** Replaces the worker/inline compute for one day (tests). */
  compute?: (day: string) => Promise<CatchupCompute>;
  /** Replaces the HTTP POST (tests pass writeSignalRows). */
  post?: BackfillPoster;
}
export interface MissedDayPassResult {
  at: string; trigger: string; ok: boolean; error?: string;
  /** true = another catch-up pass held the flag; nothing was examined. */
  busy?: boolean;
  /** The day back-filled by this pass (null = nothing was ready). */
  day: string | null;
  deferred: Array<{ day: string; coveragePct: number; attempts: number }>;
  pendingAfter: number;
  result?: MissedDayDone;
}

/** ONE missed session day per call (the oldest ready one): coverage check → one compute request →
 *  diff + admission + guarded POST (source='catchup') → state. Shares the catch-up `running` flag,
 *  so it never overlaps the today pass (and the live engine skips its tick while it runs, exactly as
 *  it does for the today pass). */
export async function runMissedDayPass(trigger: "boot" | "scheduled" | "manual", deps: MissedDayDeps = {}): Promise<MissedDayPassResult> {
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const at = new Date(nowSec * 1000).toISOString();
  if (running) return { at, trigger, ok: false, busy: true, error: "catch-up pass already running", day: null, deferred: [], pendingAfter: -1 };
  running = true;
  const t0 = Date.now();
  let day: string | null = null;
  const deferred: MissedDayPassResult["deferred"] = [];
  try {
    const s = refreshMissedDays(nowSec);
    let coveragePct = 0;
    for (const d of s.pending) { // chronological
      const cov = sessionCoverage(d);
      if (cov.pct >= MISSED_MIN_COVERAGE) { day = d; coveragePct = Math.round(cov.pct * 1000) / 10; break; }
      const attempts = (s.deferred[d]?.attempts ?? 0) + 1;
      const pct = Math.round(cov.pct * 1000) / 10;
      s.deferred[d] = { reason: "bars not healed yet", coveragePct: pct, attempts, lastAt: at };
      deferred.push({ day: d, coveragePct: pct, attempts });
      if (attempts < MISSED_DEFER_BEFORE_SKIP) break; // later days wait (chronological seeding)
    }
    saveMissedState(s);
    if (deferred.length) {
      console.log(`[catchup] missed-day ${trigger}: deferred ${deferred.map(x => `${x.day} (${x.coveragePct}% of the session at 1m, attempt ${x.attempts})`).join(", ")} — bars not healed yet, retried on the next step`);
    }
    if (!day) return { at, trigger, ok: true, day: null, deferred, pendingAfter: s.pending.length };

    const computed = await (deps.compute ?? computeMissedDayViaDelegate)(day);
    if (computed.missedDay !== day) throw new Error(`compute answered ${computed.missedDay ? `missed day ${computed.missedDay}` : "a today pass"} instead of missed day ${day}`);
    const fires = computed.todaysFires.filter(f => sessionDayKey(f.time) === day);
    const b = await backfillSessionFires(day, fires, sessionBounds(day).startSec - 86400, deps.post ?? postBackfillHttp);

    const tookMs = Date.now() - t0;
    const result: MissedDayDone = {
      day, at, trigger, engineFires: fires.length, dbRows: b.dbRows, missing: b.missing,
      inserted: b.inserted, skipped: b.skipped, collisions: b.collisions,
      admissionRejected: b.admissionRejected, keys: b.backfilledKeys, admissionKeys: b.admissionKeys,
      coveragePct, computeMode: computed.computeMode ?? (deps.compute ? "test" : "inline"), tookMs,
    };
    const s2 = loadMissedState(nowSec); // re-read: nothing else writes it while `running`, but never clobber
    s2.pending = s2.pending.filter(d => d !== day);
    delete s2.deferred[day];
    s2.done.push(result);
    delete s2.lastError;
    saveMissedState(s2);
    console.log(
      `[catchup] missed-day ${trigger} pass ${day}: engine ${fires.length} fires, db ${b.dbRows} rows, missing ${b.missing} → ` +
      `inserted ${b.inserted}, skipped ${b.skipped}, collisions ${b.collisions}` +
      (b.admissionRejected ? `; admission ${b.localRejected.length ? describeRejections(b.localRejected) : "0 rejected"}${b.routeRejected ? ` + ${b.routeRejected} at the route` : ""}` : "") +
      `; 1m coverage ${coveragePct}%; ${s2.pending.length} day(s) still pending (${tookMs}ms, compute ${result.computeMode})` +
      (b.backfilledKeys.length ? ` keys: ${b.backfilledKeys.join(", ")}` : ""),
    );
    return { at, trigger, ok: true, day, deferred, pendingAfter: s2.pending.length, result };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[catchup] missed-day ${trigger} pass${day ? ` ${day}` : ""} FAILED: ${msg} — the day stays queued`);
    try { const s3 = loadMissedState(nowSec); s3.lastError = { at, ...(day ? { day } : {}), error: msg }; saveMissedState(s3); } catch { /* state write best effort */ }
    return { at, trigger, ok: false, error: msg, day, deferred, pendingAfter: -1 };
  } finally {
    running = false;
  }
}

/** Up to `maxDays` missed days, one compute request each, with `gapMs` idle between them (the live
 *  engine's 10 s tick gets the CPU and the flag back in every gap). Stops when nothing is ready. */
export async function runMissedDaysStep(opts: { trigger: "boot" | "scheduled" | "manual"; maxDays: number; gapMs?: number; deps?: MissedDayDeps }): Promise<MissedDayPassResult[]> {
  const gapMs = opts.gapMs ?? 20_000;
  const sleep = (): Promise<void> => new Promise<void>(r => setTimeout(r, gapMs));
  const out: MissedDayPassResult[] = [];
  let busy = 0;
  while (out.length < Math.max(1, opts.maxDays)) {
    const r = await runMissedDayPass(opts.trigger, opts.deps);
    if (r.busy) { if (++busy > 3) break; await sleep(); continue; }
    out.push(r);
    if (!r.ok || !r.day || r.pendingAfter <= 0) break;
    if (out.length < opts.maxDays) await sleep();
  }
  return out;
}

/** DAILY DIGEST line (null = nothing to say): missed days back-filled in the last `windowSec`, days
 *  that aged beyond the bar depth, and days still waiting for bars. Read-only. */
export function missedDaysDigestLine(nowSec: number = Math.floor(Date.now() / 1000), windowSec: number = 86400): string | null {
  const s = getMissedDaysState();
  if (!s) return null;
  const since = nowSec - windowSec;
  const inWin = (iso: string): boolean => { const t = Date.parse(iso) / 1000; return Number.isFinite(t) && t >= since && t <= nowSec + 60; };
  const done = s.done.filter(d => inWin(d.at));
  const unrec = s.unrecoverable.filter(u => inWin(u.at));
  const waiting = s.pending.filter(d => s.deferred[d]);
  const queued = s.pending.filter(d => !s.deferred[d]);
  if (!done.length && !unrec.length && !s.pending.length) return null;
  const fires = done.reduce((a, d) => a + (d.inserted || 0), 0);
  let line = `Catch-up: back-filled ${done.length} missed session day(s)` + (done.length ? `: ${done.map(d => d.day).join(", ")} (${fires} fires)` : "");
  if (unrec.length) line += `; ${unrec.length} day(s) beyond the ${MAX_MISSED_SESSIONS}-day bar depth not recoverable (${unrec.map(u => u.day).join(", ")})`;
  if (waiting.length) line += `; ${waiting.length} day(s) waiting for healed 1m bars (${waiting.map(d => `${d} ${s.deferred[d].coveragePct}%`).join(", ")})`;
  if (queued.length) line += `; ${queued.length} day(s) queued (${queued.join(", ")})`;
  if (unrec.length || waiting.length) line += " ⚠️";
  return line;
}
