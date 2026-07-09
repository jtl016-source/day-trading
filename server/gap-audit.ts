/**
 * Server-driven gap audit + backfill dispatcher.
 *
 * When an upgraded LiveBarRelay study connects (via a `hello` message) the
 * server walks the expected bar grid for that (symbol, resolution), finds
 * missing runs that fall inside CME Globex trading hours, and asks the study
 * to backfill them one range at a time. Ranges the provider cannot fill are
 * remembered in `unfillable_ranges` so we do not re-request them forever.
 *
 * All timestamps stored in the DB are epoch SECONDS (matching cached_candles);
 * the wire protocol (`backfill` / `backfill_done`) uses epoch MILLISECONDS.
 */
import { WebSocket } from "ws";
import { db } from "./db";

// ── CME Globex session (ES) ─────────────────────────────────────────────────
// Open Sun 17:00 CT → Fri 16:00 CT, with a daily 16:00–17:00 CT maintenance break.
// We resolve the America/Chicago wall clock via a single module-level Intl
// formatter (see LEARNINGS: avoid per-call Intl allocation) and cache the UTC
// offset per calendar day.
const CT_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});
const ctOffsetCache = new Map<number, number>(); // dayIndex → offset seconds (CT = UTC + offset)

function ctOffsetSec(tsSec: number): number {
  const day = Math.floor(tsSec / 86400);
  let off = ctOffsetCache.get(day);
  if (off === undefined) {
    const parts = CT_FMT.formatToParts(new Date(tsSec * 1000));
    const p: Record<string, string> = {};
    for (const x of parts) p[x.type] = x.value;
    const h = (+p.hour) % 24; // hour12:false can emit "24" at midnight
    const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second) / 1000;
    off = asIfUtc - tsSec;
    ctOffsetCache.set(day, off);
  }
  return off;
}

function ctWall(tsSec: number): { dow: number; hour: number } {
  const local = tsSec + ctOffsetSec(tsSec);
  const dow = ((Math.floor(local / 86400) % 7) + 7 + 4) % 7; // 0=Sun (1970-01-01 was Thu)
  const secOfDay = ((local % 86400) + 86400) % 86400;
  return { dow, hour: Math.floor(secOfDay / 3600) };
}

export function isSessionOpen(tsSec: number): boolean {
  const { dow, hour } = ctWall(tsSec);
  if (dow === 6) return false;        // Saturday: closed all day
  if (dow === 0) return hour >= 17;   // Sunday: opens 17:00 CT
  if (dow === 5) return hour < 16;    // Friday: closes 16:00 CT
  return hour !== 16;                 // Mon–Thu: 16:00–17:00 maintenance break
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const MAX_RANGE_BARS = 5000;
const nowSec = () => Math.floor(Date.now() / 1000);
const intervalSec = (resolution: string) => Math.max(1, parseInt(resolution, 10)) * 60;
const key = (symbol: string, resolution: string) => `${symbol}:${resolution}`;

interface Range { fromTs: number; toTs: number; deep?: boolean; reconcile?: boolean }

// ── Audit ───────────────────────────────────────────────────────────────────
export function auditGaps(symbol: string, resolution: string): Range[] {
  const step = intervalSec(resolution);
  const stored = db.$client.prepare(
    `SELECT timestamp FROM cached_candles WHERE symbol=? AND resolution=? ORDER BY timestamp ASC`,
  ).all(symbol, resolution) as { timestamp: number }[];

  const storedSet = new Set<number>();
  for (const r of stored) storedSet.add(r.timestamp);

  const stateRow = db.$client.prepare(
    `SELECT earliest_ts FROM sync_state WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution) as { earliest_ts: number | null } | undefined;

  const earliestStored = stored.length ? stored[0].timestamp : undefined;
  let start = stateRow?.earliest_ts ?? earliestStored ?? (nowSec() - 7 * 86400);
  start = Math.floor(start / step) * step;
  const end = Math.floor(nowSec() / step) * step;
  if (end <= start) return [];

  // Collect missing, session-open grid points.
  const missing: number[] = [];
  for (let t = start; t <= end; t += step) {
    if (!storedSet.has(t) && isSessionOpen(t)) missing.push(t);
  }
  if (missing.length === 0) return [];

  // Group into runs, merging holes separated by fewer than 2 bars.
  const runs: Range[] = [];
  let runStart = missing[0];
  let prev = missing[0];
  for (let i = 1; i < missing.length; i++) {
    const t = missing[i];
    if (t - prev <= step * 2) { prev = t; continue; }
    runs.push({ fromTs: runStart, toTs: prev });
    runStart = t; prev = t;
  }
  runs.push({ fromTs: runStart, toTs: prev });

  // Skip runs overlapping known-unfillable ranges.
  const unf = db.$client.prepare(
    `SELECT from_ts, to_ts FROM unfillable_ranges WHERE symbol=? AND resolution=?`,
  ).all(symbol, resolution) as { from_ts: number; to_ts: number }[];
  const overlapsUnfillable = (a: number, b: number) =>
    unf.some(u => a <= u.to_ts && b >= u.from_ts);

  // Split runs longer than MAX_RANGE_BARS.
  const out: Range[] = [];
  for (const r of runs) {
    if (overlapsUnfillable(r.fromTs, r.toTs)) continue;
    const span = (r.toTs - r.fromTs) / step + 1;
    if (span <= MAX_RANGE_BARS) { out.push(r); continue; }
    for (let s = r.fromTs; s <= r.toTs; s += step * MAX_RANGE_BARS) {
      out.push({ fromTs: s, toTs: Math.min(r.toTs, s + step * (MAX_RANGE_BARS - 1)) });
    }
  }
  return out;
}

// ── Dispatcher state ─────────────────────────────────────────────────────────
interface StudySync {
  symbol: string;
  resolution: string;
  ws: WebSocket;
  queue: Range[];
  inflight?: { id: string; range: Range };
}
const studies = new Map<string, StudySync>();      // SYM:RES → sync state
const inflightById = new Map<string, StudySync>();  // backfill id → owning study
const zeroAttempts = new Map<string, number>();     // "SYM:RES:from:to" → count of empty responses
let idCounter = 0;

// MW-RECONCILE: per in-flight backfill id, the set of bar timestamps (epoch seconds) MW
// actually RETURNED. live-bars feeds these via recordBackfillBars as bulk_bars arrive.
// We record what MW SENT (pre-validation), never the validated subset — so a real MW bar
// our validator happens to reject can never be reconcile-deleted as a "phantom".
const returnedByBackfill = new Map<string, Set<number>>();

/**
 * MW-RECONCILE: called by live-bars when a v2 bulk_bars batch tagged with `id` arrives.
 * Accumulates the timestamps MW returned for that backfill so onBackfillDone can delete
 * our rows in the requested range that MW did NOT return.
 */
export function recordBackfillBars(id: string, timestampsSec: number[]): void {
  if (!id || timestampsSec.length === 0) return;
  let set = returnedByBackfill.get(id);
  if (!set) { set = new Set<number>(); returnedByBackfill.set(id, set); }
  for (const t of timestampsSec) set.add(t);
}

function upsertSyncState(symbol: string, resolution: string): boolean {
  const existing = db.$client.prepare(
    `SELECT symbol FROM sync_state WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution);
  const bounds = db.$client.prepare(
    `SELECT MIN(timestamp) AS mn, MAX(timestamp) AS mx FROM cached_candles WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution) as { mn: number | null; mx: number | null };
  if (existing) {
    db.$client.prepare(
      `UPDATE sync_state SET latest_ts=?, last_audit_ts=? WHERE symbol=? AND resolution=?`,
    ).run(bounds.mx, nowSec(), symbol, resolution);
    return false;
  }
  db.$client.prepare(
    `INSERT INTO sync_state (symbol, resolution, earliest_ts, latest_ts, last_audit_ts) VALUES (?,?,?,?,?)`,
  ).run(symbol, resolution, bounds.mn, bounds.mx, nowSec());
  return true; // first-ever sync for this (symbol, resolution)
}

function enqueue(study: StudySync, ranges: Range[]) {
  for (const r of ranges) {
    const dup = study.queue.some(q => q.fromTs === r.fromTs && q.toTs === r.toTs)
      || (study.inflight && study.inflight.range.fromTs === r.fromTs && study.inflight.range.toTs === r.toTs);
    if (!dup) study.queue.push(r);
  }
}

function dispatchNext(study: StudySync) {
  if (study.inflight) return;
  const range = study.queue.shift();
  if (!range) return;
  if (study.ws.readyState !== WebSocket.OPEN) return;
  const id = `bf-${++idCounter}`;
  study.inflight = { id, range };
  inflightById.set(id, study);
  const fromMs = range.fromTs * 1000;
  const toMs = range.toTs * 1000;
  try {
    study.ws.send(JSON.stringify({ type: "backfill", id, fromMs, toMs }));
    console.log(`[gap-audit] ${study.symbol}:${study.resolution} → backfill ${id} [${range.fromTs}..${range.toTs}]${range.deep ? " (deep)" : ""}`);
  } catch {
    study.inflight = undefined;
    inflightById.delete(id);
  }
}

/** Called by live-bars when a study sends `hello`. */
export function onStudyConnected(symbol: string, resolution: string, ws: WebSocket) {
  const k = key(symbol, resolution);
  const study: StudySync = { symbol, resolution, ws, queue: [] };
  studies.set(k, study);

  const firstEver = upsertSyncState(symbol, resolution);
  enqueue(study, auditGaps(symbol, resolution));

  if (firstEver) {
    // Deep-history probe: ask for everything before the earliest bar we have so
    // we learn the provider's history cap (recorded via backfill_done).
    const earliest = db.$client.prepare(
      `SELECT MIN(timestamp) AS mn FROM cached_candles WHERE symbol=? AND resolution=?`,
    ).get(symbol, resolution) as { mn: number | null };
    const cap = earliest.mn ?? nowSec();
    study.queue.unshift({ fromTs: 0, toTs: cap, deep: true });
  }

  // MW-RECONCILE: if a full-history resync was requested for this (SYM:RES) while its study
  // was offline, run it now that the study is connected (reconciliation makes the whole
  // MW-covered range bar-for-bar identical: phantoms deleted, holes filled).
  if (forceResyncPending.delete(k)) enqueueFullResync(study);

  dispatchNext(study);
}

// MW-RECONCILE: (SYM:RES) marked for a one-time full-coverage resync on next `hello`.
const forceResyncPending = new Set<string>();

/**
 * MW-RECONCILE: build a chunked, reconcile-enabled sweep over the WHOLE MW-covered range
 * ([provider-earliest .. now]) and prepend it to the study's queue. Unlike the normal
 * gap audit (which requests only MISSING session-open runs and therefore skips over
 * closed-period phantoms), this walks the entire covered span so every chunk MW answers
 * (count>0) reconcile-deletes the phantom rows MW omits inside it — including the
 * closed-session "floating candles" between real bars. Chunked to MAX_RANGE_BARS.
 */
function enqueueFullResync(study: StudySync) {
  const step = intervalSec(study.resolution);
  const sr = db.$client.prepare(
    `SELECT earliest_ts FROM sync_state WHERE symbol=? AND resolution=?`,
  ).get(study.symbol, study.resolution) as { earliest_ts: number | null } | undefined;
  const stored = db.$client.prepare(
    `SELECT MIN(timestamp) AS mn FROM cached_candles WHERE symbol=? AND resolution=?`,
  ).get(study.symbol, study.resolution) as { mn: number | null };
  // Start at the provider cap if known, else our earliest stored bar (older is unfillable anyway).
  let start = sr?.earliest_ts ?? stored.mn ?? (nowSec() - 30 * 86400);
  start = Math.floor(start / step) * step;
  const end = Math.floor(nowSec() / step) * step;
  if (end <= start) return;

  const sweep: Range[] = [];
  for (let s = start; s <= end; s += step * MAX_RANGE_BARS) {
    sweep.push({ fromTs: s, toTs: Math.min(end, s + step * (MAX_RANGE_BARS - 1)), reconcile: true });
  }
  // Prepend so the reconciliation sweep runs ahead of the normal (post-audit) gap fills.
  study.queue.unshift(...sweep);
  console.log(`[gap-audit] FULL-RESYNC ${study.symbol}:${study.resolution} → ${sweep.length} reconcile chunks [${start}..${end}]`);
}

/**
 * MW-RECONCILE: request a one-time full-history reconciliation + backfill for (SYM:RES).
 * If the study is connected now, sweep immediately; otherwise remember it and sweep on the
 * study's next `hello`. Returns whether it ran immediately.
 */
export function requestFullResync(symbol: string, resolution: string): boolean {
  const k = key(symbol, resolution);
  const study = studies.get(k);
  if (study && study.ws.readyState === WebSocket.OPEN) {
    enqueueFullResync(study);
    dispatchNext(study);
    return true;
  }
  forceResyncPending.add(k);
  return false;
}

/** Called by live-bars on socket close. */
export function onStudyDisconnected(ws: WebSocket) {
  for (const [k, s] of studies) {
    if (s.ws === ws) {
      if (s.inflight) inflightById.delete(s.inflight.id);
      studies.delete(k);
    }
  }
}

/**
 * MW-RECONCILE: after MW answers a backfill for [a..b] on SYM:RES, DELETE our cached_candles
 * rows in [a..b] whose timestamp MW did NOT return — those are phantom bars (closed-period
 * "floating candles", identical-wick clusters) the pure-upsert backfill overwrote-but-never-
 * removed. MW's getBars is authoritative, so any timestamp inside a range MW answered for
 * which MW has no bar cannot be a real bar.
 *
 * SAFETY RULE (why this can never wipe real data):
 *   Reconcile ONLY when we can PROVE MW's answer is authoritative, and ONLY within the span MW
 *   actually returned — never the raw requested range. Concretely:
 *     (1) count > 0 — MW returned real bars, proving its chart is active and serving bars. But
 *         we clamp the deletion window to [min(returned)..max(returned)] (the span MW genuinely
 *         covered) and delete only timestamps INSIDE it that MW omitted. This defends against
 *         the study's `source:"chart"` degrade path (LiveBarRelay serviceBackfill step 2): when
 *         getBars returns nothing it falls back to the chart-loaded DataSeries slice, which may
 *         cover only PART of the requested range — clamping to the returned span means we never
 *         delete real DB bars outside what MW could actually see.
 *     (2) count === 0 — a 0-bar answer means "chart inactive / getBars unavailable" (MW studies
 *         only compute on an active, ticking chart), which is indistinguishable from a real
 *         closure without extra proof. We DO NOT reconcile a 0-bar range at all: with no returned
 *         bars there is no proven-covered span to clean, and treating the whole range as "MW has
 *         nothing here" could wipe a genuine overnight session an idle chart simply couldn't serve.
 *         (Always-closed phantoms are handled separately by the isMarketClosed direct cleanup.)
 *   The deep [0..cap] probe range is NEVER reconciled (it spans pre-history / provider cap).
 * Returns the number of rows deleted (logged by the caller).
 */
function reconcileRange(
  id: string,
  symbol: string,
  resolution: string,
  range: Range,
  count: number,
): number {
  if (range.deep) return 0;
  if (count <= 0) return 0; // safety rule (2): never reconcile a 0-bar (possibly-inactive) answer
  const returned = returnedByBackfill.get(id);
  if (!returned || returned.size === 0) return 0; // count>0 but no timestamps recorded — bail safe

  // Clamp the deletion window to the span MW ACTUALLY returned (safety rule (1)).
  let lo = Infinity, hi = -Infinity;
  for (const t of returned) { if (t < lo) lo = t; if (t > hi) hi = t; }
  // Intersect the returned span with the requested range so we never reach outside either.
  const from = Math.max(range.fromTs, lo);
  const to   = Math.min(range.toTs, hi);
  if (to < from) return 0;

  // Delete rows in the proven-covered span MW did not return. onConflictDoUpdate already healed
  // the ones it DID return; this removes the leftover phantoms at timestamps MW has no bar for.
  const rows = db.$client.prepare(
    `SELECT timestamp FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp>=? AND timestamp<=?`,
  ).all(symbol, resolution, from, to) as { timestamp: number }[];
  const toDelete: number[] = [];
  for (const r of rows) if (!returned.has(r.timestamp)) toDelete.push(r.timestamp);
  if (toDelete.length === 0) return 0;

  const del = db.$client.prepare(
    `DELETE FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp=?`,
  );
  const tx = db.$client.transaction((ts: number[]) => { for (const t of ts) del.run(symbol, resolution, t); });
  tx(toDelete);
  return toDelete.length;
}

/** Called by live-bars on `backfill_done` (and after a final:true bulk batch). */
export function onBackfillDone(
  id: string,
  count: number,
  earliestAvailableMs: number,
  _source: string,
) {
  const study = inflightById.get(id);
  if (!study) { returnedByBackfill.delete(id); return; }
  const range = study.inflight?.range;
  inflightById.delete(id);
  study.inflight = undefined;
  if (!range) { returnedByBackfill.delete(id); dispatchNext(study); return; }

  const { symbol, resolution } = study;

  // MW-RECONCILE: remove phantom rows MW did not return within the span it actually covered.
  try {
    const deleted = reconcileRange(id, symbol, resolution, range, count);
    if (deleted > 0) {
      console.log(`[gap-audit] RECONCILE ${symbol}:${resolution} deleted ${deleted} phantom rows within MW-returned span of [${range.fromTs}..${range.toTs}] (${new Date(range.fromTs * 1000).toISOString()}..${new Date(range.toTs * 1000).toISOString()}) — MW returned ${count} bars`);
    }
  } catch (e: any) {
    console.error(`[gap-audit] RECONCILE ${symbol}:${resolution} failed for [${range.fromTs}..${range.toTs}]: ${e?.message}`);
  } finally {
    returnedByBackfill.delete(id);
  }

  if (range.deep) {
    if (earliestAvailableMs > 0) {
      const capSec = Math.floor(earliestAvailableMs / 1000);
      // Everything before the provider's earliest bar is permanently unfillable.
      db.$client.prepare(
        `INSERT INTO unfillable_ranges (symbol, resolution, from_ts, to_ts, attempts, reason) VALUES (?,?,?,?,?,?)`,
      ).run(symbol, resolution, 0, capSec, 1, "provider_cap");
      db.$client.prepare(
        `UPDATE sync_state SET earliest_ts=? WHERE symbol=? AND resolution=?`,
      ).run(capSec, symbol, resolution);
    }
  } else if (count === 0) {
    const zk = `${symbol}:${resolution}:${range.fromTs}:${range.toTs}`;
    const n = (zeroAttempts.get(zk) ?? 0) + 1;
    zeroAttempts.set(zk, n);
    if (n >= 2) {
      db.$client.prepare(
        `INSERT INTO unfillable_ranges (symbol, resolution, from_ts, to_ts, attempts, reason) VALUES (?,?,?,?,?,?)`,
      ).run(symbol, resolution, range.fromTs, range.toTs, n, "no_data");
      zeroAttempts.delete(zk);
    } else {
      study.queue.push(range); // retry once more later
    }
  } else {
    // Refresh stored bounds after a productive fill.
    upsertSyncState(symbol, resolution);
  }

  dispatchNext(study);
}

/** Completeness summary for the Data page / routes. */
export function getCompleteness(symbol: string, resolution: string) {
  const step = intervalSec(resolution);
  const stored = db.$client.prepare(
    `SELECT COUNT(*) AS n, MIN(timestamp) AS mn FROM cached_candles WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution) as { n: number; mn: number | null };

  const stateRow = db.$client.prepare(
    `SELECT earliest_ts FROM sync_state WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution) as { earliest_ts: number | null } | undefined;

  const start = Math.floor((stateRow?.earliest_ts ?? stored.mn ?? nowSec()) / step) * step;
  const end = Math.floor(nowSec() / step) * step;
  let expected = 0;
  for (let t = start; t <= end && expected < 10_000_000; t += step) {
    if (isSessionOpen(t)) expected++;
  }
  const gaps = auditGaps(symbol, resolution);
  const pct = expected > 0 ? Math.min(100, (stored.n / expected) * 100) : 100;
  return { stored: stored.n, expected, pct: Math.round(pct * 100) / 100, gaps };
}

// ── Hourly re-audit for connected studies ────────────────────────────────────
setInterval(() => {
  for (const study of studies.values()) {
    if (study.ws.readyState !== WebSocket.OPEN) continue;
    upsertSyncState(study.symbol, study.resolution);
    enqueue(study, auditGaps(study.symbol, study.resolution));
    dispatchNext(study);
  }
}, 60 * 60 * 1000).unref?.();
