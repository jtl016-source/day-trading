/**
 * server/yahoo-live.ts — continuous Yahoo ES=F 1m live-poll FALLBACK while NO MotiveWave
 * study connection exists (MW closed → no TickRelay/LiveBarRelay feed → no advancing bars
 * → the engine can never fire truly live signals).
 *
 * MODEL
 *   • Poll Yahoo's chart API for ES=F 1m every ~60s (jittered ±10s, single-flight).
 *   • Store under the MES continuous key through the EXACT same guards as the startup
 *     yahooBackfillSymbol path + scripts/yahoo-backfill-1m.ts:
 *       validateBar({resSec:60})  — off-grid timestamps, ghost (V=0) bars, malformed OHLC
 *       isSessionOpen             — drops maintenance-hour / weekend-closed prints
 *       forming-bar exclusion     — Yahoo appends the current FORMING bar; require t+60 <= now
 *       INSERT ... ON CONFLICT DO NOTHING — MW-official rows always win
 *       db.ts trg_cached_candles_grid_guard stays as the backstop (rejects must NOT grow)
 *   • Derive 5m/15m/60m incrementally from the new 1m (deriveRange), then notify the
 *     /ws/live-bars broadcast path with the SAME message shapes the MW tick path uses
 *     ({type:"bar", resolution, bar} + {type:"tick"}) so connected clients see candles
 *     advance ~1 min behind real time and the hidden engine evaluates new closed bars.
 *   • YIELD TO MW: the moment any MW study connection exists (the same connection state the
 *     gap-audit watchdog consults + the TickRelay flag), polling stops — checked at cycle
 *     start AND re-checked after the fetch, before any write. MW is authoritative; the
 *     watchdog/reconcile flow heals Yahoo-provisional rows later.
 *
 * SCOPE: MES only — MES is the derived-resolution symbol (derive-bars) and the only symbol
 * the engine/UI trades. ES rows keep coming from the startup backfill.
 *
 * TESTABILITY: runPollCycle() takes an injected CycleDeps so the yield-to-MW state machine
 * is unit-tested without a real MW connection (scripts/yahoo-live-fallback.test.ts). The
 * default (real) deps are wired lazily inside startYahooLiveFallback() so importing this
 * module for tests never touches live-bars/mw-reader.
 */
import { db } from "./db";
import { cachedCandles } from "@shared/schema";
import { validateBar } from "@shared/bar-time";
import { isSessionOpen } from "./gap-audit";
import { deriveRange } from "./derive-bars";
import { cacheInvalidate } from "./cache";
import { isMwOffContract, liveTicksCovered } from "./contract-guard"; // CONTRACT GUARD (2026-09-17/18): MW on the wrong month is NOT authoritative; its translated ticks may still own the live price

const SYMBOL = "MES";          // storage key (continuous micro contract — same price as ES)
const YAHOO_TICKER = "ES=F";   // Yahoo continuous ES future (same convention as toYahooSymbol)
const POLL_BASE_MS = 60_000;   // base cadence — respects Yahoo rate limits (1 req/min)
const POLL_JITTER_MS = 10_000; // ± jitter so restarts don't phase-lock on the minute boundary
const LOOKBACK_MIN_SEC = 90 * 60;              // steady-state heal window per poll
const LOOKBACK_MAX_SEC = Math.floor(6.5 * 86_400); // Yahoo 1m per-request cap (~7d) with margin
const FRESH_SEC = 5 * 60;      // last OK cycle within this → fallback counts as delivering
export const MAX_PER_BAR_BROADCAST = 10; // more new 1m bars than this in one cycle → one ranged data_updated instead

export interface YahooQuote1m {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface CycleDeps {
  /** True when ANY MW study connection exists (gap-audit hello registry ∪ TickRelay flag). */
  isMwActive: () => boolean;
  nowSec: () => number;
  /** Lookback span for this cycle's fetch window (seconds). */
  lookbackSec: () => number;
  fetch1m: (fromSec: number, toSec: number) => Promise<YahooQuote1m[]>;
  /** Insert clean rows (ON CONFLICT DO NOTHING). Returns the timestamps that were NEW. */
  writeBars: (rows: YahooQuote1m[]) => Promise<number[]>;
  /** deriveRange(SYMBOL, lo, hi) — recompute 5m/15m/60m buckets containing [lo..hi] 1m. */
  deriveWindow: (loTs: number, hiTs: number) => void;
  /** Read stored bars for a resolution in [fromTs..toTs] (post-derive). */
  readBars: (resolution: string, fromTs: number, toTs: number) => YahooQuote1m[];
  broadcastMsg: (msg: object) => void;
  invalidateCache: () => void;
  /** CONTRACT GUARD (2026-09-17): true while MW's ticks — translated onto the front month —
   *  already drive the live price. Yahoo's chart feed is ~10 min DELAYED, so its still-open
   *  coarse (5m/15m/60m) bucket would merge a ten-minute-old close into the client's forming
   *  candle every cycle; those forming buckets are skipped while true (closed bars still
   *  broadcast; reconcile() delivers the rest). Optional: absent → legacy behaviour. */
  liveTicksCovered?: () => boolean;
}

export interface CycleResult {
  skipped?: "mw-active" | "mw-active-mid-cycle" | "session-closed" | "empty-fetch";
  fetched: number;
  clean: number;
  inserted: number;
  broadcast: number;
  drops: { forming: number; session: number; invalid: number; dup: number };
}

/**
 * The write guard — IDENTICAL semantics to the repaired startup path and
 * scripts/yahoo-backfill-1m.ts: forming-bar exclusion, closed-session drop,
 * validateBar({resSec:60}), duplicate collapse, ascending sort.
 */
export function filterCleanBars(
  raw: YahooQuote1m[],
  nowSec: number,
): { clean: YahooQuote1m[]; drops: CycleResult["drops"] } {
  const drops = { forming: 0, session: 0, invalid: 0, dup: 0 };
  const seen = new Set<number>();
  const clean: YahooQuote1m[] = [];
  for (const q of raw) {
    if (q.time + 60 > nowSec) { drops.forming++; continue; }   // 1m bucket not closed yet
    if (!isSessionOpen(q.time)) { drops.session++; continue; } // maintenance hour / weekend
    if (!validateBar(
      { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume, time: q.time },
      { resSec: 60 },
    )) { drops.invalid++; continue; }                          // off-grid / ghost V0 / malformed
    if (seen.has(q.time)) { drops.dup++; continue; }           // duplicate across chunk edges
    seen.add(q.time);
    clean.push(q);
  }
  clean.sort((a, b) => a.time - b.time);
  return { clean, drops };
}

export type FeedStatus = "mw-live" | "yahoo-fallback" | "stale";

/** Pure feed-status decision (unit-tested): MW connection wins; else fallback-if-fresh. */
export function decideFeedStatus(mwActive: boolean, lastOkAgeSec: number | null): FeedStatus {
  if (mwActive) return "mw-live";
  if (lastOkAgeSec != null && lastOkAgeSec <= FRESH_SEC) return "yahoo-fallback";
  return "stale";
}

/**
 * One poll cycle. Yield-to-MW contract:
 *   (1) MW active at cycle start  → skip entirely (no Yahoo request).
 *   (2) MW connects mid-cycle     → re-checked after the fetch; NOTHING is written.
 * Both paths are asserted by scripts/yahoo-live-fallback.test.ts.
 */
export async function runPollCycle(deps: CycleDeps): Promise<CycleResult> {
  const zero: CycleResult = {
    fetched: 0, clean: 0, inserted: 0, broadcast: 0,
    drops: { forming: 0, session: 0, invalid: 0, dup: 0 },
  };
  if (deps.isMwActive()) return { ...zero, skipped: "mw-active" };

  const now = deps.nowSec();
  const from = now - Math.max(60, deps.lookbackSec());

  // Skip the Yahoo request entirely when the whole window is closed-session (weekend /
  // maintenance) — no closed 1m bucket in [from..now] could pass the guards anyway.
  let anyOpen = false;
  for (let t = Math.ceil(from / 60) * 60; t + 60 <= now; t += 60) {
    if (isSessionOpen(t)) { anyOpen = true; break; }
  }
  if (!anyOpen) return { ...zero, skipped: "session-closed" };

  const raw = await deps.fetch1m(from, now);
  if (raw.length === 0) return { ...zero, skipped: "empty-fetch" };

  const { clean, drops } = filterCleanBars(raw, deps.nowSec());
  if (clean.length === 0) return { ...zero, fetched: raw.length, drops };

  // MW may have connected while the fetch was in flight — MW is authoritative, never
  // write behind it. (The reconcile flow would heal it anyway; cleaner to not race.)
  if (deps.isMwActive()) {
    return { ...zero, skipped: "mw-active-mid-cycle", fetched: raw.length, clean: clean.length, drops };
  }

  const newTs = await deps.writeBars(clean);
  if (newTs.length === 0) return { ...zero, fetched: raw.length, clean: clean.length, drops };

  let lo = Infinity, hi = -Infinity;
  for (const t of newTs) { if (t < lo) lo = t; if (t > hi) hi = t; }

  // Incremental derive: recompute the 5m/15m/60m buckets the new 1m composes.
  deps.deriveWindow(lo, hi);

  // Broadcast — same message shapes as the MW tick path (mw-reader notifyExternalTick):
  //   • each NEW 1m bar as {type:"bar", resolution:"1", complete:true} (forming excluded above)
  //   • affected derived buckets per resolution; complete once the bucket's last 1m closed
  //   • one {type:"tick"} with the newest close so the price HUD / fast path advances
  // BURST GUARD (2026-09-18): after an outage the lookback reaches back up to ~6.5 days and
  // newTs spans hours — the per-bar path then emitted up to ~12k separate JSON.stringify+send
  // calls in one synchronous loop (and as many React state updates per client). Beyond a
  // handful of bars, one RANGED data_updated does the same job: clients re-merge from lo.
  if (newTs.length > MAX_PER_BAR_BROADCAST) {
    deps.broadcastMsg({ type: "data_updated", symbol: SYMBOL, fromTs: lo });
    deps.broadcastMsg({ type: "bar_persisted", symbol: SYMBOL });
    deps.invalidateCache();
    return { fetched: raw.length, clean: clean.length, inserted: newTs.length, broadcast: 1, drops };
  }

  let broadcastCount = 0;
  const newSet = new Set(newTs);
  const closedEnd = hi + 60; // end of the newest closed 1m bucket
  for (const b of clean) {
    if (!newSet.has(b.time)) continue;
    deps.broadcastMsg({
      type: "bar", resolution: "1",
      bar: { symbol: SYMBOL, time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, complete: true },
    });
    broadcastCount++;
  }
  const ticksCovered = deps.liveTicksCovered?.() === true;
  for (const { res, step } of [{ res: "5", step: 300 }, { res: "15", step: 900 }, { res: "60", step: 3600 }]) {
    const bLo = Math.floor(lo / step) * step;
    const bHi = Math.floor(hi / step) * step;
    for (const row of deps.readBars(res, bLo, bHi)) {
      const complete = row.time + step <= closedEnd;
      // While MW's translated ticks drive the live candle, Yahoo's still-OPEN coarse bucket
      // (its close is ~10 min old) must not be broadcast: on a 15m/60m chart it lands on the
      // client's CURRENT bucket and its stale close/high/low merge into the forming candle
      // (a once-a-minute backward flicker). reconcile() delivers it once it is closed.
      if (!complete && ticksCovered) continue;
      deps.broadcastMsg({
        type: "bar", resolution: res,
        bar: {
          symbol: SYMBOL, time: row.time, open: row.open, high: row.high, low: row.low,
          close: row.close, volume: row.volume, complete,
        },
      });
      broadcastCount++;
    }
  }
  // (No {type:"tick"} — 2026-09-17: Yahoo's CME chart feed is ~10 min delayed, so its "tick" was
  //  a ten-minute-old print that clients painted into the live forming candle. The bars above
  //  carry the price; the iPhone WebView had no age guard at all.)
  deps.broadcastMsg({ type: "bar_persisted", symbol: SYMBOL });
  deps.invalidateCache();

  return { fetched: raw.length, clean: clean.length, inserted: newTs.length, broadcast: broadcastCount, drops };
}

// ── Poller state (exposed via getYahooLiveStatus / GET /api/mw/sync-status) ──────────────
const state = {
  started: false,
  lastCycleAt: 0,        // epoch sec — any completed cycle
  lastOkAt: 0,           // epoch sec — cycle that fetched OK / skipped for a healthy reason
  lastNewBarTs: 0,       // newest 1m bar timestamp written by the poller
  lastInserted: 0,
  totalInserted: 0,
  cycles: 0,
  lastSkip: null as CycleResult["skipped"] | null,
  lastError: null as string | null,
  yieldingToMw: false,
};

let isMwActiveReal: () => boolean = () => false; // wired in startYahooLiveFallback

export function getYahooLiveStatus() {
  const now = Math.floor(Date.now() / 1000);
  const lastOkAge = state.lastOkAt > 0 ? now - state.lastOkAt : null;
  return {
    feed_status: decideFeedStatus(isMwActiveReal(), lastOkAge) as FeedStatus,
    yahooLive: {
      started: state.started,
      yieldingToMw: state.yieldingToMw,
      cycles: state.cycles,
      lastCycleAt: state.lastCycleAt || null,
      lastOkAgeSec: lastOkAge,
      lastNewBarTs: state.lastNewBarTs || null,
      lastInserted: state.lastInserted,
      totalInserted: state.totalInserted,
      lastSkip: state.lastSkip,
      lastError: state.lastError,
    },
  };
}

// ── Real deps + timer loop ───────────────────────────────────────────────────────────────
let inFlight = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let realDeps: CycleDeps | null = null;

async function writeBarsReal(rows: YahooQuote1m[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const lo = rows[0].time, hi = rows[rows.length - 1].time;
  const existing = new Set<number>(
    (db.$client.prepare(
      `SELECT timestamp FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp BETWEEN ? AND ?`,
    ).all(SYMBOL, lo, hi) as { timestamp: number }[]).map(r => r.timestamp),
  );
  const fresh = rows.filter(r => !existing.has(r.time));
  if (fresh.length === 0) return [];
  for (let i = 0; i < fresh.length; i += 500) {
    await db.insert(cachedCandles).values(fresh.slice(i, i + 500).map(q => ({
      symbol: SYMBOL, resolution: "1",
      timestamp: q.time, open: q.open, high: q.high, low: q.low, close: q.close,
      volume: Math.round(q.volume),
    }))).onConflictDoNothing();
  }
  return fresh.map(r => r.time);
}

function readBarsReal(resolution: string, fromTs: number, toTs: number): YahooQuote1m[] {
  return db.$client.prepare(
    `SELECT timestamp, open, high, low, close, volume FROM cached_candles
     WHERE symbol=? AND resolution=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`,
  ).all(SYMBOL, resolution, fromTs, toTs).map((r: any) => ({
    time: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}

function lookbackSecReal(): number {
  // Self-healing window: reach back to the newest stored 1m bar (+5 min margin) so a poller
  // outage / server downtime up to Yahoo's ~7d request cap heals itself in one fetch;
  // steady-state stays at the 90-min floor.
  const now = Math.floor(Date.now() / 1000);
  let newest = state.lastNewBarTs;
  if (!newest) {
    try {
      const row = db.$client.prepare(
        `SELECT MAX(timestamp) mx FROM cached_candles WHERE symbol=? AND resolution='1'`,
      ).get(SYMBOL) as { mx: number | null };
      newest = row?.mx ?? 0;
    } catch { newest = 0; }
  }
  if (!newest) return LOOKBACK_MIN_SEC;
  return Math.min(LOOKBACK_MAX_SEC, Math.max(LOOKBACK_MIN_SEC, now - newest + 300));
}

function scheduleNext(delayMs?: number) {
  const delay = delayMs ?? (POLL_BASE_MS + Math.floor((Math.random() * 2 - 1) * POLL_JITTER_MS));
  timer = setTimeout(tick, Math.max(1_000, delay));
  (timer as any).unref?.();
}

async function tick() {
  if (inFlight) { scheduleNext(); return; } // single-flight
  inFlight = true;
  try {
    const r = await runPollCycle(realDeps!);
    const now = Math.floor(Date.now() / 1000);
    state.cycles++;
    state.lastCycleAt = now;
    state.lastSkip = r.skipped ?? null;
    state.lastError = null;
    const yielding = r.skipped === "mw-active" || r.skipped === "mw-active-mid-cycle";
    if (yielding !== state.yieldingToMw) {
      state.yieldingToMw = yielding;
      console.log(yielding
        ? "[yahoo-live] MW study connected — yielding (polling paused, MW is authoritative)"
        : "[yahoo-live] no MW study connection — fallback polling active");
    }
    if (!yielding) {
      // Any non-MW cycle that ran to a decision is a healthy poll (session-closed and
      // empty-fetch included — Yahoo answered / there was nothing to ask for).
      state.lastOkAt = now;
    }
    if (r.inserted > 0) {
      state.lastInserted = r.inserted;
      state.totalInserted += r.inserted;
      state.lastNewBarTs = now; // refined below by the real newest bar
      console.log(`[yahoo-live] +${r.inserted} 1m bars (fetched ${r.fetched}, clean ${r.clean}, broadcast ${r.broadcast}; dropped forming ${r.drops.forming} / closed-session ${r.drops.session} / invalid ${r.drops.invalid})`);
      try {
        const row = db.$client.prepare(
          `SELECT MAX(timestamp) mx FROM cached_candles WHERE symbol=? AND resolution='1'`,
        ).get(SYMBOL) as { mx: number | null };
        if (row?.mx) state.lastNewBarTs = row.mx;
      } catch { /* non-fatal */ }
    }
  } catch (e: any) {
    state.lastError = e?.message ?? String(e);
    state.lastCycleAt = Math.floor(Date.now() / 1000);
    console.error(`[yahoo-live] poll cycle failed: ${state.lastError}`);
  } finally {
    inFlight = false;
    scheduleNext();
  }
}

/**
 * Arm the fallback poller. Called once at server startup (routes.ts). The heavy/live
 * modules (yahoo-finance2, live-bars broadcast, mw-reader flag) are imported HERE, not at
 * module top, so unit tests importing the pure cycle logic never touch them.
 */
export async function startYahooLiveFallback(): Promise<void> {
  if (state.started) return;
  state.started = true;

  const [{ default: YahooFinance }, liveBars, gapAudit, mwReader] = await Promise.all([
    import("yahoo-finance2"),
    import("./live-bars"),
    import("./gap-audit"),
    import("./mw-reader"),
  ]);
  const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

  // 2026-08-10: a connected-but-SILENT MW (wedged after a wifi drop — socket open, zero ticks,
  // stale audits) starved this fallback for the whole RTH morning: connection state alone is
  // NOT liveness. MW counts as active only while a socket is open AND a TickRelay tick arrived
  // within the last 3 minutes. Closed sessions are unaffected — the cycle's own session guard
  // skips writes regardless of this check.
  // CONTRACT GUARD (2026-09-17): liveness is still not AGREEMENT — a live MW chart on the
  // wrong contract month (Sep while Yahoo's ES=F had rolled to Dec) interleaved ±67-pt prints
  // into the store for three sessions. While the guard says off-contract, MW counts as absent
  // here so this poll writes + broadcasts the canonical front-month series instead.
  isMwActiveReal = () =>
    (gapAudit.anyStudyConnected() || mwReader.isTickRelayConnected()) &&
    mwReader.msSinceAnyExternalTick() < 3 * 60_000 &&
    !isMwOffContract();

  realDeps = {
    isMwActive: isMwActiveReal,
    nowSec: () => Math.floor(Date.now() / 1000),
    lookbackSec: lookbackSecReal,
    fetch1m: async (fromSec, toSec) => {
      const result = await yahooFinance.chart(YAHOO_TICKER, {
        period1: new Date(fromSec * 1000),
        period2: new Date(toSec * 1000),
        interval: "1m" as any,
      });
      return (result.quotes ?? [])
        .filter((q: any) => q.open != null && q.close != null && q.high != null && q.low != null)
        .map((q: any) => ({
          time: Math.floor(new Date(q.date).getTime() / 1000),
          open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0,
        }));
    },
    writeBars: writeBarsReal,
    deriveWindow: (lo, hi) => { deriveRange(SYMBOL, lo, hi); },
    readBars: readBarsReal,
    broadcastMsg: liveBars.broadcast,
    invalidateCache: () => cacheInvalidate(SYMBOL),
    liveTicksCovered,
  };

  console.log(`[yahoo-live] fallback poller armed (${YAHOO_TICKER} 1m → ${SYMBOL}, ~${POLL_BASE_MS / 1000}s jittered cadence; yields to MW)`);
  scheduleNext(5_000); // first cycle shortly after boot (startup backfill runs independently)
}
