/**
 * SERVER-SIDE LIVE ENGINE (2026-08-13, user directive: "auto trade all intervals — I can't
 * have missed signals... use my computer and fix this problem").
 *
 * WHY: live signal firing + auto-execution lived ONLY in the browser (market.tsx). Any stale
 * or closed tab meant missed orders, surfacing later as catch-up backfills — recorded trades
 * that never happened. This loop makes the SERVER the primary firing + order authority:
 * signals fire at every bar close for all four intervals whether or not a browser is open.
 *
 * HOW (all machinery reused, nothing re-derived):
 *   • inputs — buildLiveEngineContext() from ./catchup (the parity-locked pipeline proven
 *     equal to market.tsx and the harness by scripts/fact-engine-parity.test.ts);
 *   • firing — runEngineForInterval() per interval whose bar boundary just passed (grace
 *     LATENCY_GRACE_SEC for bar finalization). LATE BARS (corrected 2026-09-18): this header
 *     used to claim "late-arriving bars are swept by the NEXT tick" — FALSE for any lag > 2
 *     bars: lastRunBoundary[iv] was stamped BEFORE the pass even when the DB lacked the
 *     just-closed bar, so the boundary was consumed by a pass that never saw its bar and the
 *     next evaluation came a full bar later — outside the 2-bar freshness window. Now a
 *     boundary is only marked done once a pass ran with the DB's newest 1m bar >= boundary − 60
 *     (or after BOUNDARY_GIVE_UP_SEC); until then every 10s tick re-checks, and a pass re-runs
 *     only when a new 1m bar has actually landed (see "NOTHING-CHANGED SKIP" below);
 *   • persistence — the guarded POST /api/signals/history with source='live' (the server
 *     engine IS a live authority; collisions with tab-fired rows resolve by first-writer,
 *     both writing identical engine output). 2026-09-24: every NEW fire passes the shared
 *     admission rule (server/fire-admission.ts — COOLDOWN_BARS vs any stored same-interval
 *     row, one open trade per direction) here AND at the route; a refused fire is neither
 *     persisted nor ordered. The replay itself is seeded with the stored fires (priorFires);
 *   • orders — the SAME gates as the client path (armed, interval enabled, risk, direction,
 *     TP1-only bracket, freshness ≤ 2 bar widths; the daily loss stop already suppresses
 *     fires inside the engine input) via broadcastOrderCommand, deduped through
 *     trade-state.tryClaimOrder — ONE order per signal across every path, ever.
 *
 * The 10-minute catch-up pass stays as the safety net; its backfill count should now sit at
 * ~zero (visible in the daily digest's catchup line).
 *
 * ENGINE PASS OFF THE MAIN THREAD (2026-09-18, user: "the chart is having trouble staying live
 * / is laggy"). MEASURED: lastStatus.tookMs 5,900–9,800 ms EVERY MINUTE (7,402 ms with 0 fires),
 * nearly all synchronous main-thread CPU — profiled in a worker the same day: runEngineForInterval
 * 1m 8.2 s / 5m 3.3 s / 15m 1.2 s / 60m 0.3 s over the 90-day window, context build 1.9 s. While
 * a pass ran, the in-memory /api/live/bar route took 5.05 s and MotiveWave ticks + WS broadcasts
 * queued behind it — the chart froze for seconds every minute. Now:
 *   • COMPUTE (context build + engine runs + freshness filter) runs in a long-lived
 *     worker_threads Worker (server/live-engine-worker.ts → computeLivePass). The main thread
 *     sends {due, sinceTs} and gets back only the FRESH fires + a ~7h 1m tail.
 *   • EVERYTHING THAT TOUCHES MAIN-THREAD STATE STAYS HERE, unchanged: DB-absence check, the
 *     persist POST, placeOrder + all gates + tryClaimOrder, ordersForClaimedOnly, lateEntryScan,
 *     refreshCurrentTradeFromBars, sweepUnconfirmedActives, status/counters.
 *   • INLINE FALLBACK: the production bundle (script/build.ts → dist/index.cjs) has no separate
 *     worker file and an empty import.meta.url; whenever the worker cannot be constructed,
 *     errors, or exits, the pass runs computeLivePass() on this thread — the SAME function the
 *     worker runs, so the two modes cannot drift. Logged once; recreated lazily with backoff.
 *     (2026-09-18 review: NEVER because of the watchdog, and the 13–33 s CATCH-UP replays run
 *     inline only while the worker is UNAVAILABLE — bundled build / repeated failure.)
 *   • WATCHDOG: no reply in WATCHDOG_MS → terminate + recreate, the pass is marked failed —
 *     UNLESS the main-loop heartbeat shows THIS thread was the one suspended/stalled (lid close
 *     → Modern Standby: the wall-clock timer fired on resume and killed a healthy worker,
 *     2026-09-18 13:33): then the window is re-armed (≤ 3×), the stale result is discarded
 *     cleanly, requests queued behind a genuinely hung one are re-posted to the fresh worker,
 *     and passes are withheld after a resume until the 1m tape is current (RESUME SKIP in tick).
 *   • WORKER HEAP: resourceLimits does NOT cap the worker under `npm run dev` (the process-global
 *     --max-old-space-size wins) — the worker gc()s after every reply; /api/live-engine/status
 *     reports its heap (worker.memory) and the main isolate's (mainMemory).
 *   • NOTHING-CHANGED SKIP: MAX(1m timestamp) is read (sub-ms) each due tick; when it equals the
 *     value the previous completed pass saw AND every due interval was already evaluated against
 *     it, no pass runs (closed market, quiet minutes, late-bar re-checks cost one indexed read).
 *   • CONTRACT GUARD: while isMwOffContract(), refreshCurrentTradeFromBars is NOT called (tracked
 *     actives are MotiveWave-basis brackets, the DB bars are Yahoo front-month basis ~66 pts away
 *     — it booked a phantom tp1_hit + phantom P&L into the persisted Apex guard tracker on
 *     2026-09-17) and 1m/5m are dropped from the due set (under Yahoo's ~10-minute lag they can
 *     never meet the 2-bar freshness window; the 10-min catch-up pass records them).
 */
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { INTERVAL_SEC, type Interval, type FactSignal } from "@shared/fact-engine";
import type { LiveCandle } from "@shared/live-adapter";
import { catchupRunning, computeCatchup, setCatchupComputeDelegate, isTransientFetchMessage, type CatchupCompute } from "./catchup";
import { computeLivePass, type LivePassCompute, type WorkerRequest, type WorkerReply, type WorkerMemSample } from "./live-engine-worker";
import { db } from "./db";
import { tradeSettings, tryClaimOrder, setCurrentTrade, positionGateReason, oppositeDirectionGateReason, refreshCurrentTradeFromBars, sweepUnconfirmedActives, netContractsGateReason, apexGuardReason, getActiveTrades, orderHoursGateReason } from "./trade-state";
import { broadcastOrderCommand, orderContractGateReason } from "./live-bars";
import { notifyTradeEvent } from "./trade-notify";
import { isMwOffContract } from "./contract-guard";
import { admitFires, describeRejections } from "./fire-admission";

const SYMBOL = "MES";
const INTERVALS: Interval[] = ["1m", "5m", "15m", "60m"];
/** Seconds after a bar boundary before we evaluate it (bar finalization latency). */
const LATENCY_GRACE_SEC = 3;
const TICK_MS = 10_000;
/** A boundary whose just-closed 1m bar never reaches the DB is abandoned after this long (the
 *  next boundary of a coarser interval supersedes it anyway; the 10-min catch-up records it). */
const BOUNDARY_GIVE_UP_SEC = 300;
/** After a FAILED pass the same boundary stays due — do not hammer it every 10s tick. */
const FAILED_PASS_BACKOFF_MS = 30_000;
/** PROPORTIONAL BACKOFF (2026-09-18 adversarial review): the FIRST transient self-fetch failure
 *  of a boundary (catchup.ts getJson already retried it 3×: "… [transient-fetch]") waits only
 *  this long — the flat 30 s pushed the 1m retry past its 2-bar freshness window (pass at
 *  boundary+3 s, fail ≈ +5 s, retry tick ≈ +43 s, result ≈ +53 s of the 60 s left) and the fire
 *  was lost to the 10-min catch-up. A SECOND transient failure of the same boundary, and every
 *  non-transient failure, keeps the full FAILED_PASS_BACKOFF_MS. */
const TRANSIENT_FAIL_BACKOFF_MS = 5_000;
/** Served windows were behind the DB (server/cache.ts TTL.continuous = 5s) → go again after it lapses. */
const STALE_SERVE_RETRY_MS = 6_000;
/** Worker pass watchdog: no reply in this long → terminate + recreate, pass marked failed.
 *  (LIVE_ENGINE_WATCHDOG_MS exists for the verification harness only — floor 5 s.) */
const WATCHDOG_MS = Math.max(5_000, Number(process.env.LIVE_ENGINE_WATCHDOG_MS) || 90_000);
/** MAIN-LOOP HEARTBEAT (2026-09-18 — see the WATCHDOG/STANDBY block below). */
const HEARTBEAT_MS = 1_000;
/** A beat this late = the main loop ITSELF was suspended/stalled (not the worker). */
const LOOP_STALL_GAP_MS = 5_000;
/** Fewer beats than this fraction of the watchdog window = the main loop lost > ~20 % of it. */
const WATCHDOG_MIN_BEAT_FRACTION = 0.8;
/** Bounded: a request is re-armed at most this many times, then the watchdog terminates for real. */
const WATCHDOG_MAX_REARMS = 3;
/** A beat gap this long is a SUSPEND (Modern Standby / lid close), not a busy main thread. */
const SUSPEND_GAP_MS = 30_000;
/** Worker (re)construction backoff after an error/exit: 30s, 60s, 120s … capped at 10 min. */
const WORKER_BACKOFF_BASE_MS = 30_000;
const WORKER_BACKOFF_MAX_MS = 10 * 60_000;
/** The 1m tail handed back by the compute half: lateEntryScan looks back ≤ 6h (its hard cap),
 *  refreshCurrentTradeFromBars needs every bar since the OLDEST active trade's firedAt
 *  (carry-overnight actives can be older than 7h — sinceTs is widened to cover them). */
const TAIL_LOOKBACK_SEC = 7 * 3600;

export interface LiveEngineStatus {
  at: string;
  ok: boolean;
  error?: string;
  ranIntervals: string[];
  fires: number;
  persisted: number;
  ordersPlaced: number;
  ordersSkipped: string[]; // reasons, capped
  /** FIRE ADMISSION (2026-09-24): new fires refused (cooldown vs a stored same-interval row, or
   *  a same-direction stored trade still open) — never persisted, never ordered. */
  admissionRejected: number;
  tookMs: number;
  // ── 2026-09-18 (engine pass off the main thread) ──
  /** How THIS pass computed: the worker thread, or today's inline path (fallback). */
  mode: "worker" | "inline";
  /** Compute-half wall ms (context build + engine runs) as measured where it ran. */
  workerMs: number | null;
  /** Main-thread ms actually spent BY THIS MODULE in the pass (sync segments; in inline mode
   *  the whole compute). Does NOT include the main thread serving the worker's four
   *  cached-continuous fetches — loopMaxLagMs is the honest whole-picture number. */
  mainMs: number;
  /** Worst event-loop stall observed on the main thread while the pass was in flight — the
   *  number the chart actually feels (includes the route handlers serving the worker). */
  loopMaxLagMs: number;
  /** MAX(1m timestamp) read before the pass — the value this pass is recorded against. */
  newest1m: number | null;
  /** Newest 1m bar the compute half was actually SERVED. Behind newest1m = the served window
   *  predates the bar (the 5s cached-continuous response cache) or the serve-time filters
   *  dropped it (flat bar) — see the STALE-SERVE RETRY in tick(). */
  servedNewest1m: number | null;
  /** MW was off-contract at the end of the pass → refreshCurrentTradeFromBars was skipped. */
  offContract: boolean;
  /** The engine clock (ctx.nowSec) the compute half ran under; null when it never completed. */
  evalNowSec: number | null;
  /** 2026-09-18: set when the pass was DISCARDED, not failed — its request crossed a main-loop
   *  suspend/stall (watchdog re-armed), so its engine clock predates the stall and nothing it
   *  found may be persisted or ordered. ok stays true: no backoff, nothing recorded as evaluated. */
  skipped?: string;
}
let lastStatus: LiveEngineStatus | null = null;
export function liveEngineStatus(): LiveEngineStatus | null { return lastStatus; }
let liveFiredTotal = 0, liveOrderedTotal = 0;
export function liveEngineCounters(): { fired: number; ordered: number } { return { fired: liveFiredTotal, ordered: liveOrderedTotal }; }

let running = false;
/** interval → last bar boundary marked DONE. (2026-09-18: "done" = a pass ran with the DB's
 *  newest 1m bar >= boundary − 60, or the boundary aged past BOUNDARY_GIVE_UP_SEC — it is NO
 *  LONGER stamped before the pass; see the header's LATE BARS note.) */
const lastRunBoundary: Record<string, number> = {};

/** Bar boundary due for an interval: the most recent CLOSED bar's close time, once grace passed. */
function dueBoundary(iv: Interval, nowSec: number): number | null {
  const sec = INTERVAL_SEC[iv];
  const boundary = Math.floor((nowSec - LATENCY_GRACE_SEC) / sec) * sec; // close time of last closed bar
  if ((lastRunBoundary[iv] ?? 0) >= boundary) return null;
  return boundary;
}

// ═════ NOTHING-CHANGED SKIP + HONEST BOUNDARY BOOKKEEPING (2026-09-18) ═════
// What each interval was last evaluated against: the newest 1m timestamp the pass was
// recorded under (read on THIS thread BEFORE the pass — the compute half's fetch can only see
// that bar or newer, so the recorded value is a safe lower bound; never the served tail's
// last time, which is filtered and could mislead), the boundary it ran for, the engine clock.
interface Evaluated { newest1m: number; boundary: number; evalNowSec: number }
const evaluated: Partial<Record<Interval, Evaluated>> = {};
/** MAX(1m timestamp) seen by the previous COMPLETED pass (null until one completes). */
let lastPassNewest1m: number | null = null;
let skippedNoNewBar = 0, skippedBackoff = 0;
let nextPassNotBeforeMs = 0; // failed-pass backoff / stale-serve retry delay
let staleServeMinute = 0, staleServeRetries = 0; // STALE-SERVE RETRY (see tick) — once per minute

let newest1mStmt: ReturnType<typeof db.$client.prepare> | null = null;
/** Newest stored 1m bar time — one seek on the UNIQUE(symbol,resolution,timestamp) index
 *  (sub-ms). null = unreadable/empty → callers fail OPEN to the pre-2026-09-18 behavior
 *  (never skip; boundaries are marked done after the pass). */
function readNewest1m(): number | null {
  try {
    const stmt = newest1mStmt ??= db.$client.prepare(`SELECT MAX(timestamp) AS t FROM cached_candles WHERE symbol=? AND resolution='1'`);
    const r = stmt.get(SYMBOL) as { t: number | null } | undefined;
    return typeof r?.t === "number" ? r.t : null;
  } catch { return null; }
}

/** True when a pass for (iv, boundary) cannot see anything the last evaluation did not:
 *  same newest 1m bar AND either the same boundary, or — at a LATER boundary — the iv-bucket
 *  holding that newest 1m bar had already closed by the evaluation's clock (so no bar of this
 *  interval was still forming when it was judged). Conservative on purpose: the engine is a
 *  function of the data, and freshness only shrinks as the clock advances. */
function coveredBy(iv: Interval, boundary: number, newest1m: number): boolean {
  const ev = evaluated[iv];
  if (!ev || ev.newest1m !== newest1m) return false;
  if (ev.boundary === boundary) return true;
  const ivSec = INTERVAL_SEC[iv];
  return ev.evalNowSec >= Math.floor(newest1m / ivSec) * ivSec + ivSec;
}

/** Mark boundaries done. `evaluatedOk` = a pass just completed for them (or an earlier one
 *  covers them): done when the newest 1m bar covers the boundary's last minute
 *  (>= boundary − 60; null = unknown → old behavior, done). Regardless: done once the
 *  boundary is BOUNDARY_GIVE_UP_SEC old — which also bounds retries of a FAILING pass. */
function settleBoundaries(dueB: Partial<Record<Interval, number>>, newest1m: number | null, nowSec: number, evaluatedOk: boolean): void {
  for (const iv of INTERVALS) {
    const b = dueB[iv];
    if (b == null) continue;
    const barCovered = evaluatedOk && (newest1m == null || newest1m >= b - 60);
    if (barCovered || nowSec - b >= BOUNDARY_GIVE_UP_SEC) lastRunBoundary[iv] = Math.max(lastRunBoundary[iv] ?? 0, b);
  }
}

// ═════ WORKER LIFECYCLE (2026-09-18) ═════
// tsx BOOTSTRAP — VERIFIED 2026-09-18 on Node 24.18 + tsx 4.20.5: Workers DO inherit the tsx
// flags in process.execArgv, but tsx's loader deliberately skips registration off the main
// thread (its isMainThread guard), so `new Worker(new URL("./live-engine-worker.ts", …))`
// falls to Node's native type-stripping: no "@shared/*" path aliases, no extensionless
// imports ("Cannot find package '@shared/fact-engine'"). Registering tsx EXPLICITLY inside
// the worker (tsx/esm/api register()) before importing the entry works — aliases included.
// CJS eval so it does not depend on module-syntax detection for eval'd workers.
const WORKER_BOOT = `
const { workerData } = require("node:worker_threads");
require(workerData.tsxApi).register();
import(workerData.entry).catch(e => { setImmediate(() => { throw e; }); });
`;

/** Worker infrastructure failure (construct/error/exit/watchdog) — NOT an engine error.
 *  `watchdog` = raised by the WATCHDOG path (the hung request itself, or one that was queued
 *  behind it and could not be re-posted): callers must NEVER answer it with inline compute. */
class WorkerInfraError extends Error {
  readonly watchdog: boolean;
  constructor(msg: string, watchdog = false) { super(msg); this.watchdog = watchdog; }
}
/** A pass that must be DISCARDED, not failed (2026-09-18 — see LiveEngineStatus.skipped). */
class PassSkipped extends Error {}

let worker: Worker | null = null;
let workerReady = false;
let workerSpawnedAtMs = 0;
let workerEverStarted = false;
let workerRestarts = 0;
let workerFailStreak = 0;
let workerRetryAtMs = 0;
let workerDisabled: string | null = null; // permanent for this process (bundled build / tsx absent)
let workerLastError: string | null = null;
let lastLoggedWorkerIssue = "";
let reqSeq = 0;
// Worker heap as the worker itself reports it (2026-09-18 heap-cap verification — see ensureWorker).
let workerGc: boolean | null = null; // explicit gc() obtained inside the worker? (null = not reported yet)
let workerMemAtReply: WorkerMemSample | null = null;  // with the newest reply — BEFORE its collect
let workerMemAfterGc: WorkerMemSample | null = null;  // right after the collect that followed it
let workerGcMs: number | null = null, workerMemAt: string | null = null;

type WorkerBody = { type: "pass"; due: Interval[]; sinceTs: number } | { type: "catchup" };
/** Caller-visible side channel of one request: how often the watchdog RE-ARMED it (> 0 = the
 *  request crossed a main-loop suspend/stall — a live pass result is then too old to act on). */
interface WorkerCallMeta { rearms: number }
interface InflightRequest {
  body: WorkerBody; // kept so a request queued behind a hung one can be RE-POSTED to the fresh worker
  resolve: (r: unknown) => void; reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  armedAtMs: number; beatsAtArm: number; rearms: number;
  meta?: WorkerCallMeta;
}
/** Requests awaiting a worker reply. Normally ONE (the live pass is single-flight); the 10-min
 *  catch-up does not consult the live engine's `running` flag, so its compute request can queue
 *  behind an in-flight live pass — the worker runs them strictly one after the other. */
const inflight = new Map<number, InflightRequest>();
function rejectAllInflight(err: Error): void {
  for (const [id, p] of inflight) { inflight.delete(id); clearTimeout(p.timer); p.reject(err); }
}

// ═════ MAIN-LOOP HEARTBEAT — the watchdog's alibi (2026-09-18 adversarial review) ═════
// INCIDENT: the watchdog is a main-thread setTimeout, i.e. it measures WALL time. This laptop
// enters Modern Standby when the lid closes (System log 2026-09-18: 12:00:12→12:16:59 and
// 13:25:37→13:32:58). The 13:25:08 pass was mid-fetch when the machine slept; at 13:33:17 the
// very first loop turn after resume ran the overdue timer — "worker pass request #4 hung > 90s
// — worker terminated + recreated" (tookMs 488531) — before the worker could receive one byte
// of the 1m window the main thread had been "serving" for 478 s. A HEALTHY worker was killed
// (15.6 s re-boot), rejectAllInflight pushed the queued catch-up onto the INLINE path
// ("(33138ms, compute inline)" — 33 s of synchronous engine replays on the main thread right as
// the lid opened), and the next two passes died with "fetch failed".
// A ~1 s beat proves whether the MAIN LOOP itself ran during a watchdog window. Both tells are
// needed: on resume the overdue beat usually runs FIRST in the same timers phase (earlier
// expiry), so "gap since the last beat" is already healed when the watchdog callback looks —
// the beat records the stall it found (lastStallEndMs) and the beat COUNT per window catches a
// loop that was starved in slices no single gap shows.
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let beatCount = 0, lastBeatMs = Date.now();
let stallCount = 0, lastStallEndMs = 0, lastStallGapMs = 0;
let suspendCount = 0, lastSuspendGapMs = 0;
/** > 0 while the RESUME SKIP (see tick) is active: when the last detected suspend ended. */
let resumeAtMs = 0, lastResumeAtMs = 0;
let watchdogRearms = 0, watchdogTerminations = 0, watchdogRequeued = 0;
let skippedStalePass = 0, skippedResumeStale = 0;

/** Called by the beat AND by every consumer before it judges (tick, watchdog) — detection must
 *  not depend on which overdue timer the loop happens to run first after a resume. */
function noteLoopProgress(isBeat: boolean): void {
  const now = Date.now();
  const gap = now - lastBeatMs;
  if (gap > LOOP_STALL_GAP_MS) {
    stallCount++; lastStallEndMs = now; lastStallGapMs = gap;
    if (gap >= SUSPEND_GAP_MS) {
      suspendCount++; lastSuspendGapMs = gap; resumeAtMs = lastResumeAtMs = now;
      console.warn(`[live-engine] main loop did not run for ${Math.round(gap / 1000)}s (standby / lid close — or a very long synchronous block) — in-flight worker requests are re-armed, not killed; stale passes are skipped until the 1m tape is current again`);
    }
  }
  lastBeatMs = now;
  if (isBeat) beatCount++;
}
function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  lastBeatMs = Date.now(); // boot time before the first beat is not a stall
  heartbeatTimer = setInterval(() => noteLoopProgress(true), HEARTBEAT_MS);
  heartbeatTimer.unref(); // never the reason the process stays alive
}

function logWorkerIssueOnce(issue: string, tail: string): void {
  if (issue === lastLoggedWorkerIssue) return; // same reason again → stay quiet
  lastLoggedWorkerIssue = issue;
  console.warn(`[live-engine] worker unavailable (${issue}) — passes run INLINE on the main thread (pre-2026-09-18 behavior)${tail}`);
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerDisabled || Date.now() < workerRetryAtMs) return null;
  let entry: string, tsxApi: string;
  try {
    // esbuild's cjs bundle leaves import.meta empty and ships no separate worker file.
    const selfUrl = import.meta.url;
    if (!selfUrl) throw new Error("bundled build — no module URL, no separate worker file");
    entry = new URL("./live-engine-worker.ts", selfUrl).href;
    tsxApi = createRequire(selfUrl).resolve("tsx/esm/api");
  } catch (e) {
    workerDisabled = (e as Error).message;
    logWorkerIssueOnce(workerDisabled, " — permanent for this process");
    return null;
  }
  try {
    // HEAP CAP (2026-09-18, measured): a full four-interval pass peaks at ~450 MB RSS and drops to
    // ~15 MB used after a GC — but with V8's default multi-GB limit the worker never felt any
    // pressure to collect, and the server process sat at 3.0 GB on a 16 GB machine that had
    // 0.4 GB free (paging = every request slow, the exact "laggy" being fixed).
    // CORRECTED THE SAME DAY (adversarial review): resourceLimits is NOT the cap under
    // `npm run dev`. The dev script sets NODE_OPTIONS=--max-old-space-size=2048 (it has to — that
    // is what caps the MAIN isolate), V8 flags are process-global, and they BEAT per-isolate
    // ResourceConstraints: measured on this machine (Node 24.18) a worker created with these very
    // limits reports heap_size_limit 864 MB without the flag and 2144 MB with it. The effective
    // bound is the worker's own explicit gc() after EVERY reply (live-engine-worker.ts) — heap
    // back to single-digit MB between passes whatever the limit says. resourceLimits stays: it
    // still bounds the no-flag case (tsx run directly, scripts), where an OOM only costs a logged
    // inline finish of that one pass. VERIFY AT RUNTIME: GET /api/live-engine/status → worker.memory
    // (heapLimitMb shows which regime is in force; afterGc.heapUsedMb is the number that matters).
    const w = new Worker(WORKER_BOOT, {
      eval: true, name: "live-engine", workerData: { role: "live-engine", entry, tsxApi },
      resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64 },
    });
    w.on("message", (m: WorkerReply) => onWorkerMessage(w, m));
    w.on("error", e => onWorkerDown(w, `error: ${(e as Error)?.message ?? String(e)}`));
    w.on("exit", code => onWorkerDown(w, `exit ${code}`));
    w.unref(); // never the reason the process stays alive
    if (workerEverStarted) workerRestarts++;
    workerEverStarted = true;
    workerReady = false;
    workerSpawnedAtMs = Date.now();
    worker = w;
    return w;
  } catch (e) {
    onWorkerDown(null, `construct failed: ${(e as Error).message}`);
    return null;
  }
}

function onWorkerMessage(w: Worker, msg: WorkerReply): void {
  if (w !== worker) return; // stale instance (terminated by the watchdog)
  if (msg.type === "ready") {
    workerReady = true;
    lastLoggedWorkerIssue = "";
    workerGc = msg.gc ?? null;
    if (msg.mem) { workerMemAfterGc = msg.mem; workerMemAt = new Date().toISOString(); }
    console.log(`[live-engine] compute worker up in ${Date.now() - workerSpawnedAtMs}ms — engine passes run off the main thread${workerRestarts ? ` (restart #${workerRestarts})` : ""}${msg.mem ? ` (heap limit ${msg.mem.heapLimitMb} MB, explicit gc ${msg.gc ? "ON" : "UNAVAILABLE"})` : ""}`);
    return;
  }
  if (msg.type === "mem") { // post-collect heap, sent right after each reply (observability only)
    workerGc = msg.gc; workerGcMs = msg.gcMs; workerMemAfterGc = msg.mem; workerMemAt = new Date().toISOString();
    return;
  }
  if (msg.type !== "result" && msg.type !== "catchup-result") return;
  if (msg.mem) workerMemAtReply = msg.mem;
  const p = inflight.get(msg.id);
  if (!p) return; // late reply to an abandoned request
  inflight.delete(msg.id); clearTimeout(p.timer);
  if (msg.ok) {
    workerFailStreak = 0;
    if (msg.type === "result") {
      const { type: _type, id: _id, ok: _ok, mem: _mem, ...compute } = msg;
      p.resolve(compute);
    } else {
      p.resolve(msg.compute);
    }
  } else {
    // ENGINE-level failure (HTTP 5xx from a served window, "no cached days"…) — the inline
    // path would fail the same way; no fallback, the pass is simply failed like before.
    p.reject(new Error(msg.error));
  }
}

function onWorkerDown(w: Worker | null, reason: string): void {
  if (w !== null && w !== worker) return; // already replaced / detached by the watchdog
  worker = null; workerReady = false;
  workerFailStreak++;
  const backoff = Math.min(WORKER_BACKOFF_MAX_MS, WORKER_BACKOFF_BASE_MS * 2 ** (workerFailStreak - 1));
  workerRetryAtMs = Date.now() + backoff;
  workerLastError = reason;
  logWorkerIssueOnce(reason, `; next worker attempt in ${Math.round(backoff / 1000)}s`);
  rejectAllInflight(new WorkerInfraError(reason));
}

function armWatchdog(id: number, p: InflightRequest): void {
  p.armedAtMs = Date.now(); p.beatsAtArm = beatCount;
  p.timer = setTimeout(() => onWatchdog(id), WATCHDOG_MS);
}

/** WATCHDOG (rewritten 2026-09-18 — see the MAIN-LOOP HEARTBEAT block for the incident).
 *  (a) The window only counts if the MAIN LOOP ran through it: a recorded stall/suspend inside
 *      the window, or fewer than WATCHDOG_MIN_BEAT_FRACTION of its beats, means this thread was
 *      the one that stopped (it also SERVES the worker's fetches, so the worker could not have
 *      progressed either) → RE-ARM a full window, at most WATCHDOG_MAX_REARMS times per request.
 *  (b) A genuine hang still terminates + recreates at once (a hung request is not a broken
 *      worker build — no backoff) and fails THAT request. Requests QUEUED behind it never
 *      started — they are RE-POSTED to the fresh worker under a fresh window; if no worker can be
 *      constructed they fail with watchdog=true so NO caller answers with inline compute (the
 *      catch-up simply retries on its next schedule). Inline stays for "worker unavailable"
 *      only — never 13–33 s of main-thread engine replays because of a watchdog. */
function onWatchdog(id: number): void {
  const p = inflight.get(id);
  if (!p) return;
  noteLoopProgress(false); // the overdue beat may not have run yet in this timers phase
  const beats = beatCount - p.beatsAtArm;
  const minBeats = Math.floor((WATCHDOG_MS / HEARTBEAT_MS) * WATCHDOG_MIN_BEAT_FRACTION);
  const loopStalled = lastStallEndMs >= p.armedAtMs || beats < minBeats;
  if (loopStalled && p.rearms < WATCHDOG_MAX_REARMS) {
    p.rearms++; watchdogRearms++;
    if (p.meta) p.meta.rearms = p.rearms;
    console.warn(`[live-engine] watchdog: ${p.body.type} request #${id} — the MAIN LOOP was suspended/stalled inside the ${WATCHDOG_MS / 1000}s window (${beats}/${Math.round(WATCHDOG_MS / HEARTBEAT_MS)} beats${lastStallEndMs >= p.armedAtMs ? `, ${Math.round(lastStallGapMs / 1000)}s gap` : ""}) — worker NOT terminated, window re-armed (${p.rearms}/${WATCHDOG_MAX_REARMS})`);
    armWatchdog(id, p);
    return;
  }
  inflight.delete(id);
  // Detach FIRST so terminate()'s 'exit' event is a no-op, then recreate immediately.
  const hung = worker; worker = null; workerReady = false;
  void hung?.terminate();
  watchdogTerminations++;
  workerLastError = `watchdog: no reply in ${WATCHDOG_MS / 1000}s${p.rearms ? ` (after ${p.rearms} re-arm(s))` : ""}`;
  const fresh = ensureWorker();
  let requeued = 0, failed = 0;
  for (const [qid, q] of inflight) {
    clearTimeout(q.timer);
    if (fresh) {
      try {
        const req: WorkerRequest = { ...q.body, id: qid };
        fresh.postMessage(req); // buffered by the port until the new worker's listener attaches
        armWatchdog(qid, q);
        requeued++;
        continue;
      } catch { /* fall through → fail it */ }
    }
    inflight.delete(qid); failed++;
    q.reject(new WorkerInfraError("worker terminated by the watchdog while this request was queued — no worker to re-post to", true));
  }
  watchdogRequeued += requeued;
  console.warn(`[live-engine] worker ${p.body.type} request #${id} hung > ${WATCHDOG_MS / 1000}s — worker terminated + recreated, ${p.body.type} marked failed${requeued || failed ? ` (queued behind it: ${requeued} re-posted to the new worker, ${failed} failed — none run inline)` : ""}`);
  p.reject(new WorkerInfraError(workerLastError, true));
}

/** Post one request to the worker and await its reply, under the WATCHDOG. */
function callWorker<T>(w: Worker, body: WorkerBody, meta?: WorkerCallMeta): Promise<T> {
  ensureHeartbeat();
  return new Promise<T>((resolve, reject) => {
    const id = ++reqSeq;
    const p: InflightRequest = {
      body, resolve: resolve as (r: unknown) => void, reject, meta,
      timer: undefined as unknown as ReturnType<typeof setTimeout>, armedAtMs: 0, beatsAtArm: 0, rearms: 0,
    };
    armWatchdog(id, p);
    inflight.set(id, p);
    try {
      const req: WorkerRequest = { ...body, id };
      w.postMessage(req); // buffered by the port until the worker's listener attaches
    } catch (e) {
      inflight.delete(id); clearTimeout(p.timer);
      reject(new WorkerInfraError(`postMessage failed: ${(e as Error).message}`));
    }
  });
}

/** INLINE-CATCH-UP POLICY (2026-09-18 adversarial review): ~13–33 s of synchronous engine replays
 *  belong on the main thread ONLY when the worker is UNAVAILABLE — the bundled build
 *  (workerDisabled) or REPEATED failure (it died again without one good reply in between). */
function workerUnavailable(): boolean { return workerDisabled != null || workerFailStreak >= 2; }

/** CATCH-UP COMPUTE DELEGATE (registered with catchup.ts in startLiveEngine): the 10-min pass's
 *  ~13 s of engine replays run in the same worker. INLINE computeCatchup() only while the worker
 *  is UNAVAILABLE (see workerUnavailable). 2026-09-18: a request that was merely QUEUED behind a
 *  watchdog-killed live pass used to land here as a plain infra error and ran inline —
 *  "(33138ms, compute inline)" on the main thread right as the lid opened. Now the watchdog
 *  re-posts it to the fresh worker; and a worker that died ONCE mid-request (or is in its first
 *  30 s re-create backoff) FAILS this catch-up instead — the next scheduled one retries, which
 *  is what already happened for a watchdog timeout or an engine-level error. */
async function catchupComputeViaWorker(): Promise<CatchupCompute> {
  const w = ensureWorker();
  if (!w) {
    if (workerUnavailable()) return { ...(await computeCatchup()), computeMode: "inline" };
    throw new Error(`compute worker restarting (${workerLastError ?? "unknown"}) — catch-up deferred to its next schedule, not run inline`);
  }
  try {
    return { ...(await callWorker<CatchupCompute>(w, { type: "catchup" })), computeMode: "worker" };
  } catch (e) {
    if (e instanceof WorkerInfraError && !e.watchdog && workerUnavailable()) return { ...(await computeCatchup()), computeMode: "inline" };
    throw e;
  }
}

async function pass(due: Interval[], newest1m: number | null): Promise<LiveEngineStatus> {
  const at = new Date().toISOString();
  const t0 = Date.now();
  const status: LiveEngineStatus = {
    at, ok: false, ranIntervals: due, fires: 0, persisted: 0, ordersPlaced: 0, ordersSkipped: [], admissionRejected: 0, tookMs: 0,
    mode: "inline", workerMs: null, mainMs: 0, loopMaxLagMs: 0, newest1m, servedNewest1m: null, offContract: false, evalNowSec: null,
  };
  // Main-thread stopwatch: only the synchronous segments THIS module runs (paused across awaits).
  let segStart = performance.now(), segOpen = true;
  const pauseMain = (): void => { if (segOpen) { status.mainMs += performance.now() - segStart; segOpen = false; } };
  const resumeMain = (): void => { segStart = performance.now(); segOpen = true; };
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  try {
    // 1m tail floor: 7h, widened to the oldest tracked active (carry-overnight positions).
    let sinceTs = Math.floor(Date.now() / 1000) - TAIL_LOOKBACK_SEC;
    for (const t of getActiveTrades()) sinceTs = Math.min(sinceTs, t.firedAt - 60);

    // ── COMPUTE HALF: worker when available, else today's inline path (same function) ──
    const inline = async (): Promise<LivePassCompute> => {
      status.mode = "inline";
      resumeMain(); // inline = the whole compute is main-thread time (incl. self-served fetches)
      try { return await computeLivePass(due, sinceTs, { yieldBetweenIntervals: true }); }
      finally { pauseMain(); }
    };
    const w = ensureWorker();
    pauseMain();
    let r: LivePassCompute;
    if (w) {
      status.mode = "worker";
      const meta: WorkerCallMeta = { rearms: 0 };
      try {
        r = await callWorker<LivePassCompute>(w, { type: "pass", due, sinceTs }, meta);
        // STALE AFTER A SUSPEND/STALL (2026-09-18): the watchdog re-armed this request, so the
        // reply is older than WATCHDOG_MS — and its engine clock (ctx.nowSec, stamped BEFORE the
        // stall) is what "fresh" was judged against. Before today such a pass was always killed
        // at WATCHDOG_MS, never acted on; acting on it now would persist + ORDER fires that are
        // minutes old at a price the market left long ago. Boundaries that old cannot produce a
        // fresh fire — DISCARD cleanly (no failure, no backoff); the next tick judges the
        // current boundaries on the current clock and the 10-min catch-up records the rest.
        if (meta.rearms > 0) throw new PassSkipped(`result discarded — the request crossed a main-loop suspend/stall (watchdog re-armed ${meta.rearms}×, reply after ${Math.round((Date.now() - t0) / 1000)}s): its engine clock predates it`);
      } catch (e) {
        if (e instanceof PassSkipped) throw e;
        // Worker died / errored mid-pass → finish THIS pass inline. A watchdog timeout already
        // burned WATCHDOG_MS — no inline retry, the pass is failed (its boundary stays due).
        if (e instanceof WorkerInfraError) { if (!e.watchdog) r = await inline(); else throw e; }
        // An engine-level error from a request that crossed a suspend is the suspend's doing
        // (sockets reset under it: "fetch failed") — skipped like its result would have been.
        else if (meta.rearms > 0) throw new PassSkipped(`errored after a main-loop suspend/stall (watchdog re-armed ${meta.rearms}×): ${(e as Error)?.message ?? String(e)}`);
        else throw e;
      }
    } else {
      r = await inline();
    }
    resumeMain();
    status.workerMs = r.workerMs;
    status.evalNowSec = r.nowSec;
    status.servedNewest1m = r.last1mTime;

    // ── MAIN-THREAD HALF — everything below touches main-thread state, exactly as before ──
    // TOUCH-ACCURATE GATE CLEARING (2026-08-14): resolve open positions against the real
    // tape every pass — gates open the moment TP/SL actually traded, observed or not.
    // CONTRACT GUARD (2026-09-18): NOT while MW is off-contract — tracked actives are
    // MotiveWave-basis brackets and these bars are Yahoo front-month basis (~66 pts away):
    // on 2026-09-17 this walk booked a phantom tp1_hit + phantom P&L into the persisted Apex
    // guard tracker. MW's own events (reconcileTradeState) stay the truth meanwhile.
    status.offContract = isMwOffContract();
    if (!status.offContract) refreshCurrentTradeFromBars(r.tail1m);
    // PHANTOM SWEEP (2026-08-14): drop actives never fill-confirmed by MW within the TTL.
    sweepUnconfirmedActives();

    const passRejections: Parameters<typeof describeRejections>[0] = []; // logged ONCE per pass
    for (const iv of due) {
      const ivSec = INTERVAL_SEC[iv];
      // Fresh = within the last 2 bar widths (same window the client uses) AND today —
      // filtered inside computeLivePass with the engine's own clock (r.nowSec / r.todayKey).
      const fresh = r.freshByIv[iv];
      if (!fresh?.length) continue;

      // DB-absence check (natural key) — bars already persisted (by a tab or a prior tick)
      // are not "new"; their orders were already claimed or deliberately not placed.
      const dbKeys = new Set((db.$client
        .prepare(`SELECT interval, timestamp, direction FROM signal_history WHERE symbol=? AND timestamp>=?`)
        .all(SYMBOL, r.nowSec - 3 * ivSec) as Array<{ interval: string; timestamp: number; direction: string }>)
        .map(row => `${row.interval}|${row.timestamp}|${row.direction}`));
      const absent = fresh.filter(s => !dbKeys.has(`${s.interval}|${s.time}|${s.direction}`));
      if (!absent.length) { ordersForClaimedOnly(fresh, iv, status); continue; }

      // ── FIRE ADMISSION (2026-09-24): the POST route's rule, checked here first so a refused
      // fire is neither persisted NOR ordered — a stored same-interval row within COOLDOWN_BARS
      // (either side, either direction; e.g. the catch-up's phase of the same setup) or a
      // same-direction stored trade still open at this entry. Logged once per interval pass.
      const adm = admitFires(absent.map(s => ({
        symbol: SYMBOL, interval: s.interval, timestamp: s.time, direction: s.direction,
        outcome: s.eodClose ? "eod" : s.outcome, exitTs: s.exitTs ?? null, sig: s,
      })));
      if (adm.rejected.length) {
        status.admissionRejected += adm.rejected.length;
        passRejections.push(...adm.rejected);
      }
      let newFires = adm.admitted.map(a => a.sig);
      status.fires += newFires.length;
      if (!newFires.length) {
        // Every absent fire refused — the stored fresh ones still get their claimed-only path.
        const stored = fresh.filter(s => dbKeys.has(`${s.interval}|${s.time}|${s.direction}`));
        if (stored.length) ordersForClaimedOnly(stored, iv, status);
        continue;
      }

      // ── persist (source='live' — the server engine is a live authority) ──
      const rows = newFires.map(s => ({
        symbol: SYMBOL, interval: s.interval, timestamp: s.time, direction: s.direction,
        riskLevel: "safe", signalType: s.signalType, entry: s.price, tp1: s.tp1, tp2: s.tp2, sl: s.sl,
        outcome: s.eodClose ? "eod" : s.outcome,
        label: s.label,
        ...(s.confirmations ? { confirmations: s.confirmations } : {}),
        exitPrice: s.exitPrice ?? null, exitTs: s.exitTs ?? null, pointsResult: s.pointsResult ?? null,
        mae: s.mae ?? null, mfe: s.mfe ?? null, barsToExit: s.barsToExit ?? null,
        comboKey: s.comboKey ?? null, riskFlags: s.riskFlags ?? null,
        suggestedContracts: s.suggestedContracts ?? null,
        shadowTags: s.shadowTags ?? null, // SHADOW TAGS (2026-10-01): record-only, stored as JSON by writeSignalRows
        source: "live",
      }));
      pauseMain();
      try {
        const res = await fetch(`http://127.0.0.1:${process.env.PORT || "3000"}/api/signals/history`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signals: rows }),
        });
        if (res.ok) {
          const j = await res.json() as { inserted: number; admissionKeys?: Array<{ interval: string; timestamp: number; direction: string }> };
          status.persisted += j.inserted ?? 0;
          // The ROUTE's admission is authoritative (another writer may have landed a row since
          // the check above): a fire it refused is not ordered either.
          if (j.admissionKeys?.length) {
            const refused = new Set(j.admissionKeys.map(k => `${k.interval}|${k.timestamp}|${k.direction}`));
            const before = newFires.length;
            newFires = newFires.filter(s => !refused.has(`${s.interval}|${s.time}|${s.direction}`));
            status.admissionRejected += before - newFires.length;
            status.fires -= before - newFires.length;
          }
        }
      } catch (e) { console.warn(`[live-engine] persist failed: ${(e as Error).message}`); }
      resumeMain();

      // ── orders ──
      for (const s of newFires) placeOrder(s, iv, status, r.lastPx);
    }
    if (passRejections.length) console.log(`[live-engine] fire admission (${due.join(",")}): ${describeRejections(passRejections)}`);
    // LATE ENTRY AT LEVEL (2026-08-20 user directive): signals that missed the fresh-fire
    // window (catch-up backfills, missed boundaries) fire when price RETURNS to their entry
    // and the bracket is still untouched. See tradeSettings.lateEntryEnabled docs.
    lateEntryScan(r, status);
    status.ok = true;
    liveFiredTotal += status.fires;
    liveOrderedTotal += status.ordersPlaced;
    if (status.fires || status.ordersPlaced) {
      console.log(`[live-engine] ${due.join(",")}: ${status.fires} fire(s), ${status.persisted} persisted, ${status.ordersPlaced} order(s)${status.admissionRejected ? `, ${status.admissionRejected} refused by admission` : ""}${status.ordersSkipped.length ? ` — skipped: ${status.ordersSkipped.join("; ")}` : ""}`);
    }
  } catch (e) {
    if (e instanceof PassSkipped) {
      // Not a failure (see LiveEngineStatus.skipped): nothing persisted, nothing ordered.
      status.ok = true; status.skipped = e.message; skippedStalePass++;
      console.log(`[live-engine] pass ${due.join(",")} skipped: ${e.message}`);
      sweepUnconfirmedActives(); // the PHANTOM SWEEP keeps its ~1/min cadence like every other skip path
    } else {
      status.error = (e as Error).message;
      console.warn(`[live-engine] pass failed: ${status.error}`);
    }
  }
  pauseMain();
  // The lag sampler is a 20ms timer: a synchronous block that ended THIS turn (the inline path's
  // last engine run) is only observed once the loop reaches its timers phase again — disabling
  // in the same turn reported 131 ms for a multi-second inline block (measured 2026-09-18).
  await new Promise<void>(r => setTimeout(r, 30));
  lag.disable();
  status.loopMaxLagMs = Math.round(lag.max / 1e6);
  status.mainMs = Math.round(status.mainMs);
  status.tookMs = Date.now() - t0;
  lastStatus = status;
  return status;
}

/** 15:15–17:00 ET: the engine's own no-new-signals window near the RTH close — late entries
 *  respect the same wall (a late fill at 15:40 carries the same close risk the rule exists
 *  for). ETH (18:00+) and the rest of RTH are allowed. */
function inCloseCutoff(nowSec: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(nowSec * 1000));
  const get = (k: string): number => Number(parts.find(p => p.type === k)?.value ?? "0");
  const mins = get("hour") * 60 + get("minute");
  return mins >= 15 * 60 + 15 && mins < 17 * 60;
}

/** LATE ENTRY AT LEVEL (2026-08-20, user: "im losing a lot of points because of the catch up
 *  signals... if it comes back to the same price level and the signal still shows that it
 *  will hit, make the trade"). Recent DB rows outside the fresh-fire window whose bracket has
 *  NOT been touched since their entry bar become resting intents: when the live price is back
 *  within lateEntryTolerancePts of the original entry, the order fires with the ORIGINAL
 *  TP/SL. placeOrder applies every gate + the claim registry (one order per signal, ever —
 *  a row that already ordered can never re-fire). */
function lateEntryScan(ctx: { nowSec: number; lastPx: number | null; tail1m: LiveCandle[] }, status: LiveEngineStatus): void {
  if (!tradeSettings.lateEntryEnabled || !tradeSettings.enabled) return;
  // 2026-09-18 (compute half moved off-thread): `tail1m` = the served 1m bars since
  // min(now − 7h, oldest active − 60s) instead of the whole 90-day window. Identical result:
  // candidates are ≤ 6h old (hard cap below) and the viability walk only reads bars at/after
  // each candidate's entry bar. lastPx is still the newest bar of the FULL window (null ⇔ the
  // window was empty — the old `!bars.length` exit).
  const bars = ctx.tail1m;
  if (ctx.lastPx == null) return;
  const lastPx = ctx.lastPx;
  if (!Number.isFinite(lastPx) || inCloseCutoff(ctx.nowSec)) return;
  const tol = Math.max(0.25, Number(tradeSettings.lateEntryTolerancePts) || 1.0);
  const maxAgeSec = Math.min(Math.max(30, Number(tradeSettings.lateEntryMaxAgeMin) || 360), 360) * 60;
  const rows = db.$client.prepare(
    `SELECT interval, timestamp, direction, entry, tp1, tp2, sl, signal_type FROM signal_history
     WHERE symbol=? AND timestamp>=? AND (outcome IS NULL OR outcome='open')
       AND entry IS NOT NULL AND tp1 IS NOT NULL AND sl IS NOT NULL`,
  ).all(SYMBOL, ctx.nowSec - maxAgeSec) as Array<{
    interval: string; timestamp: number; direction: string; entry: number;
    tp1: number; tp2: number | null; sl: number; signal_type: string | null;
  }>;
  for (const r of rows) {
    const ivSec = INTERVAL_SEC[r.interval as Interval];
    if (!ivSec) continue;
    const entryTs = r.timestamp + ivSec; // engine entry = firing bar close
    if (ctx.nowSec - r.timestamp <= ivSec * 2) continue; // fresh window belongs to the normal path
    if (Math.abs(lastPx - r.entry) > tol) continue;      // price hasn't returned to the level
    // Viability: ANY touch of TP or SL since the entry bar kills the intent (TP touched =
    // the book's win already happened without us; SL touched = the book's loss — never chase).
    const isLong = r.direction.toLowerCase().startsWith("l");
    let dead = false;
    for (const b of bars) {
      if (b.time < entryTs) continue;
      if (isLong ? (b.high >= r.tp1 || b.low <= r.sl) : (b.low <= r.tp1 || b.high >= r.sl)) { dead = true; break; }
    }
    if (dead) continue;
    // RESTART SAFETY: order claims are in-memory — after a reboot an already-ordered signal
    // could re-fire. The PERSISTED actives list is the cross-restart truth: a tracked open
    // trade at this signal's entry/direction/interval means we're already in it.
    const already = getActiveTrades().some(t =>
      t.interval === r.interval && t.direction.toLowerCase()[0] === r.direction.toLowerCase()[0]
      && Math.abs(t.entry - r.entry) <= 0.26);
    if (already) continue;
    console.log(`[live-engine] LATE ENTRY candidate: ${r.direction} ${r.interval} @ ${r.entry} (fired ${Math.round((ctx.nowSec - r.timestamp) / 60)}min ago, px ${lastPx})`);
    placeOrder({
      interval: r.interval, time: r.timestamp, direction: r.direction,
      price: r.entry, tp1: r.tp1, tp2: r.tp2, sl: r.sl,
      signalType: r.signal_type ?? "fact-engine",
    } as unknown as FactSignal, r.interval as Interval, status, lastPx);
  }
}

/** A bar already persisted by a live tab may still need ITS order placed if the tab's POST
 *  beat this tick but the tab's own execution was blocked (e.g. stale client code). The
 *  claim registry makes retrying free: first claimant wins, everyone else no-ops. */
function ordersForClaimedOnly(fresh: FactSignal[], iv: Interval, status: LiveEngineStatus): void {
  for (const s of fresh) placeOrder(s, iv, status, null);
}

function placeOrder(s: FactSignal, iv: Interval, status: LiveEngineStatus, lastPx: number | null): void {
  const skip = (why: string): void => { if (status.ordersSkipped.length < 8) status.ordersSkipped.push(`${iv} ${s.direction}@${s.price}: ${why}`); };
  if (!tradeSettings.enabled) return skip("auto-trade disarmed");
  if (!tradeSettings.intervals.includes(iv)) return skip("interval not enabled");
  // ONE-POSITION GATE — a SETTING, default OFF (2026-08-14 user decision: "nothing
  // blocking any trades"; the netting/stacking consequences were stated and accepted).
  if (tradeSettings.positionGate) {
    const gate = positionGateReason(lastPx);
    if (gate) return skip(gate);
  }
  // SAME-DIRECTION-ONLY GATE — default ON (2026-08-14 user refinement: "if a long is active
  // and a short comes dont fire and vise versa"). Same-direction signals stack freely.
  if (tradeSettings.sameDirectionOnly) {
    const gate = oppositeDirectionGateReason(s.direction, lastPx);
    if (gate) return skip(gate);
  }
  const dir = (tradeSettings.direction ?? "both") as string;
  if (dir === "long" && s.direction !== "Long") return skip("direction filter");
  if (dir === "short" && s.direction !== "Short") return skip("direction filter");
  const contracts = Math.max(1, Math.floor(Number(tradeSettings.contracts ?? 1)));
  // ORDER-HOURS WINDOW (2026-08-20 ETH-study ship): the kill zones stay signal-only.
  {
    const hoursGate = orderHoursGateReason(Math.floor(Date.now() / 1000));
    if (hoursGate) return skip(hoursGate);
  }
  // CONTRACT GUARD (2026-09-17): MW on a different contract month than the feed — the bracket
  // would be worked 60+ pts from its own market. Signal row persists; no order.
  {
    const contractGate = orderContractGateReason();
    if (contractGate) return skip(contractGate);
  }
  // APEX GUARDS (2026-08-18 — after the 12:22 PM Rithmic auto-liquidation): total-exposure
  // cap + trailing-threshold order pause. ORDER-side only; the signal row persists above.
  {
    const capGate = netContractsGateReason(contracts, lastPx);
    if (capGate) return skip(capGate);
    const apexGate = apexGuardReason(lastPx);
    if (apexGate) return skip(apexGate);
  }
  // Single-tier "safe" rows pass the risk gate by construction; side-entries are opt-in like
  // the client path (takeSideEntries setting when present, default allow — signal passed the gate).
  const key = `${SYMBOL}|${iv}|${s.time}|${s.direction}`;
  if (!tryClaimOrder(key)) return; // someone (a tab, a prior tick) already owns this order
  // TP1-ONLY policy (2026-08-13): tp2 null forces tp1Only; the MW bracket's TP2 leg mirrors
  // TP1 and is inert — identical to the /api/trade/execute route's contract.
  const tp1Only = tradeSettings.tp1Only || s.tp2 == null;
  const tp2ForBracket = s.tp2 ?? s.tp1;
  const sent = broadcastOrderCommand({
    type: "order_command",
    symbol: tradeSettings.contractType ?? SYMBOL,
    direction: s.direction,
    interval: iv,
    riskLevel: "safe",
    price: s.price,
    tp1: s.tp1,
    tp2: tp2ForBracket,
    sl: s.sl,
    contracts,
    tp1Only,
  });
  if (!sent) {
    notifyTradeEvent({ type: "order_error", error: `order NOT placed — AutoTrader study not connected (${s.direction} ${SYMBOL} ${iv} @ ${s.price})` });
    return skip("AutoTrader study not connected");
  }
  setCurrentTrade({
    symbol: tradeSettings.contractType ?? SYMBOL, direction: s.direction as "Long" | "Short", interval: iv, riskLevel: "safe",
    entry: s.price, tp1: s.tp1, tp2: s.tp2, sl: s.sl, contracts, tp1Only,
    firedAt: Math.floor(Date.now() / 1000), status: "open",
  });
  status.ordersPlaced++;
  console.log(`[live-engine] ORDER ${s.direction} ${SYMBOL} ${iv} @ ${s.price} (tp ${s.tp1} / sl ${s.sl}, ${contracts}x, server-fired)`);
}

let tickCount = 0, skippedBusy = 0;
let lastWorkerMs: number | null = null, lastMainMs: number | null = null;
let offContractAtLastTick = false;
/** PROPORTIONAL BACKOFF bookkeeping: the boundary whose pass last failed TRANSIENTLY. */
let transientFailBoundary = 0;
/** RESUME SKIP upper bound — the same horizon after which a boundary is abandoned anyway. */
const RESUME_SKIP_MAX_MS = BOUNDARY_GIVE_UP_SEC * 1000;

/** One 10s tick: decide what is due, skip when nothing can have changed, else run ONE pass. */
function tick(): void {
  tickCount++;
  noteLoopProgress(false); // resume detection must not depend on the beat running before this overdue tick
  if (running || catchupRunning()) { skippedBusy++; return; } // never stack CPU passes
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  // CONTRACT GUARD (2026-09-18): while MotiveWave is off-contract the store is Yahoo-driven and
  // ~10 minutes behind — a 1m/5m fire can never sit inside its 2-bar freshness window, so those
  // passes were pure cost (the 1m one is the 8-second one). The 10-min catch-up pass records
  // them; 15m/60m still run (their windows are 30/120 min). Their boundaries are simply not
  // tracked meanwhile — dueBoundary only ever looks at the most recent one, nothing piles up.
  const offContract = offContractAtLastTick = isMwOffContract();
  const due: Interval[] = [];
  const dueB: Partial<Record<Interval, number>> = {};
  for (const iv of INTERVALS) {
    const b = dueBoundary(iv, nowSec);
    if (b == null) continue;
    if (offContract && (iv === "1m" || iv === "5m")) continue;
    due.push(iv); dueB[iv] = b;
  }
  if (!due.length) {
    // PHANTOM SWEEP still has to tick ~every minute even when no pass runs (off-contract
    // drops the per-minute pass) — a filter over a handful of records.
    sweepUnconfirmedActives();
    return;
  }

  // NOTHING-CHANGED SKIP: same newest 1m bar the previous completed pass saw AND every due
  // interval already evaluated against it → a pass could only recompute what it already knows.
  // A boundary whose bar is LATE stays due (not settled below) so this re-checks every tick
  // and the pass re-runs the moment the bar lands.
  const newest1m = readNewest1m();
  if (newest1m != null && newest1m === lastPassNewest1m && due.every(iv => coveredBy(iv, dueB[iv]!, newest1m))) {
    skippedNoNewBar++;
    settleBoundaries(dueB, newest1m, nowSec, true);
    sweepUnconfirmedActives();
    return;
  }
  // RESUME SKIP (2026-09-18 adversarial review): after a detected SUSPEND (beat gap ≥
  // SUSPEND_GAP_MS — lid close / Modern Standby) the store's newest 1m bar is as old as the
  // nap: the feed slept too. A pass right now is a STALE pass — a ~10 s worker run + four big
  // served windows landing on the main thread in the resume storm (2026-09-18 13:33–13:36:
  // two such passes died with "fetch failed"), judging boundaries that are minutes old and
  // cannot produce a fresh 1m fire. Withhold passes — cleanly: nothing failed, no backoff,
  // nothing settled (the boundary stays due, dueBoundary only ever tracks the newest one) —
  // until the last CLOSED 1m bar is in the store again (the same "bar covered" test
  // settleBoundaries uses), bounded by RESUME_SKIP_MAX_MS so a feed that never comes back
  // cannot suppress the engine past the ordinary give-up horizon. Unreadable store → fail OPEN.
  if (resumeAtMs) {
    const lastClosed1m = Math.floor((nowSec - LATENCY_GRACE_SEC) / 60) * 60 - 60;
    if (newest1m == null || newest1m >= lastClosed1m || nowMs - resumeAtMs >= RESUME_SKIP_MAX_MS) resumeAtMs = 0;
    else { skippedResumeStale++; sweepUnconfirmedActives(); return; }
  }
  if (nowMs < nextPassNotBeforeMs) { skippedBackoff++; return; } // last pass FAILED (or was served stale windows) — brief wait, boundary stays due

  running = true;
  pass(due, newest1m)
    .then(st => {
      lastWorkerMs = st.workerMs; lastMainMs = st.mainMs;
      const doneSec = Math.floor(Date.now() / 1000);
      if (st.skipped) {
        // DISCARDED, not failed (the request crossed a suspend/stall — see pass): no backoff,
        // nothing recorded as evaluated; only boundaries past the give-up horizon are settled.
        nextPassNotBeforeMs = 0;
        settleBoundaries(dueB, newest1m, doneSec, false);
        return;
      }
      if (st.ok) {
        nextPassNotBeforeMs = 0;
        // STALE-SERVE RETRY: the pass is only "evaluated against newest1m" if the windows it
        // was SERVED actually reached that bar. cached-continuous bodies are cached for 5s and
        // mw-reader's finalizeBar1m persists WITHOUT cacheInvalidate — a body cached a second
        // before the bar landed can be handed to the pass at boundary+3s, which then judges the
        // boundary without its bar (the same "pass ran without its bar" class as the late-bar
        // bug above). Served behind the DB → record NOTHING and go again once the 5s TTL has
        // lapsed; ONCE per minute, because a legitimately filtered newest bar (flat H==L) is
        // served-behind forever and must not become a pass storm.
        const minute = Math.floor((nowSec - LATENCY_GRACE_SEC) / 60) * 60;
        if (newest1m != null && st.servedNewest1m != null && st.servedNewest1m < newest1m && staleServeMinute !== minute) {
          staleServeMinute = minute; staleServeRetries++;
          nextPassNotBeforeMs = Date.now() + STALE_SERVE_RETRY_MS;
          settleBoundaries(dueB, newest1m, doneSec, false); // give-up only
          return;
        }
        lastPassNewest1m = newest1m;
        if (newest1m != null) {
          for (const iv of due) evaluated[iv] = { newest1m, boundary: dueB[iv]!, evalNowSec: st.evalNowSec ?? nowSec };
        }
      } else {
        // PROPORTIONAL BACKOFF (2026-09-18): the FIRST transient self-fetch failure of a
        // boundary retries on the next tick (see TRANSIENT_FAIL_BACKOFF_MS); a repeat for the
        // same boundary — or any other failure — keeps the full 30 s.
        const boundary = Math.max(...due.map(iv => dueB[iv] ?? 0));
        const firstTransient = isTransientFetchMessage(st.error) && transientFailBoundary !== boundary;
        if (firstTransient) transientFailBoundary = boundary;
        nextPassNotBeforeMs = Date.now() + (firstTransient ? TRANSIENT_FAIL_BACKOFF_MS : FAILED_PASS_BACKOFF_MS);
      }
      settleBoundaries(dueB, newest1m, doneSec, st.ok);
    })
    .catch(e => { console.warn(`[live-engine] tick bookkeeping failed: ${(e as Error).message}`); })
    .finally(() => { running = false; });
}

export function startLiveEngine(app?: import("express").Express): void {
  console.log(`[live-engine] started — bar-close firing for ${INTERVALS.join(", ")} (grace ${LATENCY_GRACE_SEC}s, tick ${TICK_MS / 1000}s)`);
  if (app) {
    // Observability: the loop's actual state — ticks, last pass, boundaries, lifetime counters.
    // 2026-09-18 additions: mode / lastWorkerMs / lastMainMs / skippedNoNewBar / workerRestarts
    // (+ worker detail, the skip/backoff state) — the tell for "is the pass still on my thread?".
    app.get("/api/live-engine/status", (_req, res) => {
      res.set("Cache-Control", "no-store");
      const mb = (n: number): number => Math.round(n / 1048576);
      const mm = process.memoryUsage();
      res.json({
        tickCount, skippedBusy, running, lastRunBoundary, lastStatus, counters: liveEngineCounters(),
        // How the most recent pass computed; before the first pass, what the next one would use.
        mode: lastStatus?.mode ?? (worker ? "worker" : "inline"),
        lastWorkerMs, lastMainMs, skippedNoNewBar, workerRestarts,
        skippedBackoff, staleServeRetries, lastPassNewest1m, evaluated, offContract: offContractAtLastTick,
        worker: {
          alive: worker != null, ready: workerReady, restarts: workerRestarts, failStreak: workerFailStreak,
          disabled: workerDisabled, lastError: workerLastError,
          retryInSec: worker || workerDisabled ? 0 : Math.max(0, Math.round((workerRetryAtMs - Date.now()) / 1000)),
          inflight: inflight.size,
          // HEAP-CAP VERIFICATION (2026-09-18): the WORKER's own isolate, as it reports it.
          // heapLimitMb 864 = resourceLimits in force; 2144 = the process-global
          // --max-old-space-size=2048 overrode it (npm run dev) — then afterGc.heapUsedMb
          // (single-digit/low-double-digit MB between passes) is the proof the cap holds.
          memory: { gc: workerGc, gcMs: workerGcMs, atReply: workerMemAtReply, afterGc: workerMemAfterGc, at: workerMemAt },
        },
        // The MAIN isolate (what NODE_OPTIONS=--max-old-space-size=2048 caps). rss = whole process.
        mainMemory: {
          rssMb: mb(mm.rss), heapUsedMb: mb(mm.heapUsed), heapTotalMb: mb(mm.heapTotal),
          externalMb: mb(mm.external), arrayBuffersMb: mb(mm.arrayBuffers),
          heapLimitMb: mb(getHeapStatistics().heap_size_limit),
        },
        // 2026-09-18 watchdog/standby: the main-loop heartbeat, the watchdog's decisions, the skips.
        loop: {
          beats: beatCount, lastBeatAgeMs: Date.now() - lastBeatMs, stalls: stallCount, lastStallGapMs,
          lastStallAt: lastStallEndMs ? new Date(lastStallEndMs).toISOString() : null,
          suspends: suspendCount, lastSuspendGapMs,
          lastResumeAt: lastResumeAtMs ? new Date(lastResumeAtMs).toISOString() : null,
          resumeSkipActive: resumeAtMs > 0, skippedResumeStale, skippedStalePass,
        },
        watchdog: { ms: WATCHDOG_MS, maxRearms: WATCHDOG_MAX_REARMS, rearms: watchdogRearms, terminations: watchdogTerminations, requeued: watchdogRequeued },
      });
    });
  }
  // Warm the worker shortly after boot (tsx compile + its own DB handle ≈ 1s) so the first pass
  // does not pay for it; a pass that arrives earlier just has its message buffered by the port.
  setTimeout(() => { ensureWorker(); }, 3_000);
  // The 10-min catch-up pass shares the worker for ITS engine replays (see catchupComputeViaWorker).
  setCatchupComputeDelegate(catchupComputeViaWorker);
  ensureHeartbeat(); // the watchdog's alibi + suspend detection (see MAIN-LOOP HEARTBEAT)
  setInterval(tick, TICK_MS);
}
