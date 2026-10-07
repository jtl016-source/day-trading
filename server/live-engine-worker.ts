/**
 * LIVE-ENGINE COMPUTE — OFF THE MAIN THREAD (2026-09-18, user: "the chart is having trouble
 * staying live / is laggy").
 *
 * MEASURED: server/live-engine.ts ran pass(due) on every bar boundary — the 1m boundary means
 * EVERY MINUTE — and lastStatus.tookMs sat at 5,900–9,800 ms (7,402 ms with 0 fires), almost all
 * of it SYNCHRONOUS main-thread work: JSON.parse of four 90-day served windows (the 1m one is
 * ~8.8 MB), JSON.parse of ~11.7 MB of footprint rows, resolveStuckRows, then one
 * runEngineForInterval() per due interval. PROFILED the same day (inside a worker, 102k 1m
 * bars): context build 1.9 s; runEngineForInterval 1m 8.2 s / 5m 3.3 s / 15m 1.2 s / 60m 0.3 s
 * — the ENGINE RUN is the block, not the parsing. While a pass ran, a pure in-memory route
 * (/api/live/bar) took 5.05 s and MotiveWave ticks + /ws/live-bars broadcasts queued behind it:
 * the live chart froze for several seconds every minute. Harness result after the move: main
 * thread 1 ms per pass, worst event-loop stall ~100 ms (vs 5.8–9.8 s inline).
 *
 * ALSO SERVED HERE (same day): the 10-min catch-up pass's compute half ({type:"catchup"} →
 * catchup.ts computeCatchup) — ~13 s of engine replays that were an 8-second freeze every 10 min.
 *
 * THIS FILE is both halves of the fix's compute side:
 *   • computeLivePass() — the ONE implementation of "build the parity-locked context, run the
 *     engine for each due interval, keep only FRESH fires". server/live-engine.ts calls it
 *     directly for its INLINE fallback (production cjs bundle, worker down) and the worker
 *     below calls the very same function — the two modes cannot drift.
 *   • the worker_threads message loop (bottom) — active ONLY when this module is loaded as the
 *     live-engine worker (workerData.role === "live-engine"); importing it on the main thread
 *     is side-effect free.
 *
 * WHAT STAYS ON THE MAIN THREAD (unchanged, in server/live-engine.ts): the DB-absence check,
 * the persist POST, placeOrder + every gate + tryClaimOrder, ordersForClaimedOnly,
 * lateEntryScan, refreshCurrentTradeFromBars, sweepUnconfirmedActives, status/counters —
 * everything that reads or writes main-thread state (trade-state, the order-claim registry,
 * the AutoTrader socket).
 *
 * IMPORT DISCIPLINE (checked 2026-09-18): this module may import ONLY ./catchup and pure
 * @shared/* modules. catchup.ts's transitive graph is ./db + pure shared code — no timers, no
 * servers, no file watchers. NEVER import ./live-engine, ./live-bars, ./trade-state,
 * ./mw-reader, ./contract-guard or ./routes from here: their module bodies start sockets,
 * intervals and hydration that must exist exactly once per process.
 *
 * HEAP (2026-09-18 adversarial review): the spawn-time resourceLimits (768 MB old-gen) do NOT
 * bind under `npm run dev` — NODE_OPTIONS=--max-old-space-size=2048 is process-global and wins
 * (heap_size_limit measured 864 MB without the flag, 2144 MB with it). The worker therefore
 * COLLECTS EXPLICITLY after every reply (pass and catch-up) and reports its own heap with each
 * reply + after each collect — see the message loop at the bottom and
 * GET /api/live-engine/status → worker.memory. Harness, under the flag, full four-interval pass:
 * heapUsed 152 MB at reply → 16 MB after a 140 ms gc() that runs AFTER the reply was posted.
 *
 * DB NOTE: ./db opens this thread's OWN better-sqlite3 connection (WAL + busy_timeout 5000;
 * its DDL is idempotent — the same thing every scripts/*.ts process already does against the
 * live file). resolveStuckRows therefore WRITES signal_history from the worker's connection.
 * That is acceptable: WAL lets the main thread keep reading, busy_timeout absorbs a colliding
 * write lock, and the UPDATE repeats its transition matrix in its own WHERE clause, so a
 * concurrent main-thread write (live tab POST, catch-up pass) still wins exactly as before.
 */
import { parentPort, workerData } from "node:worker_threads";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { INTERVAL_SEC, type Interval, type FactSignal } from "@shared/fact-engine";
import { sessionDayKey } from "@shared/yellowbox-core";
import type { LiveCandle } from "@shared/live-adapter";
import { buildLiveEngineContext, runEngineForInterval, computeCatchup, type CatchupCompute } from "./catchup";

/** main → worker */
export interface LivePassRequest { type: "pass"; id: number; due: Interval[]; sinceTs: number }
/** main → worker: the 10-min catch-up pass's compute half (catchup.ts computeCatchup) — the same
 *  ~13 s of engine replays, off the main thread for the same reason. */
export interface CatchupRequest { type: "catchup"; id: number }
export type WorkerRequest = LivePassRequest | CatchupRequest;

/** The compute half of one live-engine pass — everything the main thread needs to finish it. */
export interface LivePassCompute {
  /** ctx.nowSec — the engine's clock for this pass (freshness + DB-absence windows key off it). */
  nowSec: number;
  todayKey: string;
  /** Per due interval: fires that are TODAY and within 2 bar widths of nowSec (the exact
   *  filter the main thread applied before 2026-09-18). Intervals with none are omitted. */
  freshByIv: Partial<Record<Interval, FactSignal[]>>;
  /** Close of the newest served 1m bar (null when the window is empty) — the order gates' price. */
  lastPx: number | null;
  /** Open time of that same newest served 1m bar — lets the main thread tell a pass that was
   *  served windows OLDER than the DB's newest bar (5s response cache) from one that saw it. */
  last1mTime: number | null;
  /** Served 1m candles with time >= sinceTs — all refreshCurrentTradeFromBars and lateEntryScan
   *  ever read (they skip bars before firedAt / the entry bar). ~420 bars instead of ~130k. */
  tail1m: LiveCandle[];
  stuck: { checked: number; resolved: number; keys: string[] };
  /** Wall-clock ms spent in this function (context build + engine runs). */
  workerMs: number;
}

/** THIS isolate's heap (2026-09-18 heap-cap verification): process.memoryUsage().heapUsed/heapTotal
 *  and v8.getHeapStatistics() are PER-ISOLATE inside a worker; rss is the WHOLE process (context
 *  only). heapLimitMb = v8 heap_size_limit — the number that tells whether resourceLimits took
 *  (864) or the process-global --max-old-space-size overrode it (2144). */
export interface WorkerMemSample { heapUsedMb: number; heapTotalMb: number; heapLimitMb: number; externalMb: number; rssMb: number }

/** worker → main. `mem` = this isolate's heap AT REPLY TIME (before the explicit collect — the
 *  pass's garbage still counted); the post-collect number follows in a separate {type:"mem"}. */
export type LivePassReply =
  | ({ type: "result"; id: number; ok: true; mem?: WorkerMemSample } & LivePassCompute)
  | { type: "result"; id: number; ok: false; error: string; workerMs: number; mem?: WorkerMemSample };
export type CatchupReply =
  | { type: "catchup-result"; id: number; ok: true; compute: CatchupCompute; workerMs: number; mem?: WorkerMemSample }
  | { type: "catchup-result"; id: number; ok: false; error: string; workerMs: number; mem?: WorkerMemSample };
/** Sent right AFTER each reply, once the explicit gc() ran (gcMs = its cost, on the worker thread). */
export interface WorkerMemReport { type: "mem"; id: number; gc: boolean; gcMs: number; mem: WorkerMemSample }
export type WorkerReply = LivePassReply | CatchupReply | WorkerMemReport | { type: "ready"; gc?: boolean; mem?: WorkerMemSample };

/** Gap between the four served-window fetches (see buildLiveEngineContext's option). */
export const LIVE_PASS_FETCH_GAP_MS = 100;

const yieldLoop = (): Promise<void> => new Promise<void>(r => setImmediate(r));

/**
 * Build the context, run the engine for each due interval, keep the fresh fires.
 * `yieldBetweenIntervals` is for the INLINE (main-thread) caller only: the engine runs are
 * synchronous CPU, so a setImmediate between them lets queued ticks/broadcasts drain. The
 * engine input (ctx) is fixed before the first run, so yielding cannot change any result.
 */
export async function computeLivePass(
  due: Interval[], sinceTs: number, opts: { yieldBetweenIntervals?: boolean } = {},
): Promise<LivePassCompute> {
  const t0 = Date.now();
  // 2026-09-24: the context carries this interval's STORED fires (ctx.priorsByIv, read from this
  // thread's own DB connection) and runEngineForInterval seeds them as the engine's priorFires —
  // the replay honours the cooldown/open state other writers already committed. Engine settings
  // are FACT_ENGINE_DEFAULTS (COOLDOWN_BARS 10, ONE_OPEN_PER_DIRECTION, YB_BREAK_EVENT_BARS 3) —
  // the same module instance as the main thread's, no copy here.
  const ctx = await buildLiveEngineContext({ sequentialFetchGapMs: LIVE_PASS_FETCH_GAP_MS });
  const freshByIv: Partial<Record<Interval, FactSignal[]>> = {};
  for (const iv of due) {
    const ivSec = INTERVAL_SEC[iv];
    const fired = runEngineForInterval(ctx, iv);
    // Fresh = within the last 2 bar widths (same window the client uses) AND today.
    const fresh = fired.filter(s =>
      sessionDayKey(s.time) === ctx.todayKey && ctx.nowSec - s.time <= ivSec * 2);
    if (fresh.length) freshByIv[iv] = fresh;
    if (opts.yieldBetweenIntervals) await yieldLoop();
  }
  const bars = ctx.served1m.candles;
  return {
    nowSec: ctx.nowSec,
    todayKey: ctx.todayKey,
    freshByIv,
    lastPx: bars.length ? bars[bars.length - 1].close : null,
    last1mTime: bars.length ? bars[bars.length - 1].time : null,
    tail1m: bars.filter(b => b.time >= sinceTs),
    stuck: ctx.stuck,
    workerMs: Date.now() - t0,
  };
}

// ── worker message loop — ONLY when spawned by server/live-engine.ts ─────────────────────────
// Live passes are single-flight on the MAIN thread (its `running` flag + catchupRunning()), but
// the catch-up pass does not consult that flag, so a {type:"catchup"} can arrive while a pass
// is computing: requests are CHAINED — never two context builds at once in this thread.
if (parentPort && (workerData as { role?: string } | null)?.role === "live-engine") {
  const port = parentPort;

  // EXPLICIT COLLECT AFTER EVERY REPLY (2026-09-18 adversarial review — the heap cap was INEFFECTIVE).
  // The main thread spawns this worker with resourceLimits.maxOldGenerationSizeMb 768, but the dev
  // script now ALSO sets NODE_OPTIONS=--max-old-space-size=2048 (needed to cap the MAIN isolate),
  // and V8 flags are process-global and beat per-isolate ResourceConstraints. MEASURED on this
  // machine (Node 24.18): this worker's heap_size_limit is 864 MB without the flag and 2144 MB
  // with it — so the worker could again grow to ~2 GB before V8 felt any pressure to collect (the
  // 16 GB PC had 0.4 GB free with the server at 3 GB; paging WAS the lag). A full four-interval
  // pass needs ~450 MB RSS and ~15 MB stays live afterwards, so the honest bound is not a limit
  // but a collect: gc() is obtained once (expose-gc flipped at runtime, `gc` read out of a fresh
  // context — verified inside a worker under the 2048 flag: heapUsed 185 MB → 6 MB in 9–31 ms)
  // and runs after EVERY reply, pass and catch-up alike. It runs AFTER postMessage (the reply is
  // already serialized to the main thread — a fresh fire is never delayed by it) and from OUTSIDE
  // the handler's frame, so the context/served windows/reply are unreachable when it collects.
  // Guarded: if gc cannot be obtained the worker behaves exactly as before (gc:false in status).
  let gc: (() => void) | null = null;
  try {
    setFlagsFromString("--expose-gc");
    const g: unknown = runInNewContext("gc");
    if (typeof g === "function") gc = g as () => void;
  } catch { gc = null; }
  const mb = (n: number): number => Math.round(n / 1048576);
  const memNow = (): WorkerMemSample => {
    const m = process.memoryUsage();
    return { heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), heapLimitMb: mb(getHeapStatistics().heap_size_limit), externalMb: mb(m.external), rssMb: mb(m.rss) };
  };

  /** Compute + post ONE reply. Everything it allocates dies with this frame (see collect below). */
  const handle = async (msg: WorkerRequest): Promise<void> => {
    const t0 = Date.now();
    let reply: LivePassReply | CatchupReply;
    if (msg.type === "pass") {
      try {
        reply = { type: "result", id: msg.id, ok: true, ...(await computeLivePass(msg.due, msg.sinceTs)) };
      } catch (e) {
        reply = { type: "result", id: msg.id, ok: false, error: (e as Error)?.message ?? String(e), workerMs: Date.now() - t0 };
      }
    } else {
      try {
        // Same sequential served-window fetch as the live pass — the main thread serves them.
        const compute = await computeCatchup({ sequentialFetchGapMs: LIVE_PASS_FETCH_GAP_MS });
        reply = { type: "catchup-result", id: msg.id, ok: true, compute, workerMs: Date.now() - t0 };
      } catch (e) {
        reply = { type: "catchup-result", id: msg.id, ok: false, error: (e as Error)?.message ?? String(e), workerMs: Date.now() - t0 };
      }
    }
    try { reply.mem = memNow(); } catch { /* observability only */ }
    port.postMessage(reply);
  };
  const collect = (id: number): void => {
    try {
      const t = Date.now();
      if (gc) gc();
      const report: WorkerMemReport = { type: "mem", id, gc: gc != null, gcMs: Date.now() - t, mem: memNow() };
      port.postMessage(report);
    } catch { /* never let observability break the chain */ }
  };

  let chain: Promise<void> = Promise.resolve();
  port.on("message", (msg: WorkerRequest) => {
    if (!msg || (msg.type !== "pass" && msg.type !== "catchup")) return;
    chain = chain.then(() => handle(msg)).then(() => collect(msg.id), () => collect(msg.id));
  });
  let bootMem: WorkerMemSample | undefined;
  try { bootMem = memNow(); } catch { bootMem = undefined; }
  port.postMessage({ type: "ready", gc: gc != null, mem: bootMem });
}
