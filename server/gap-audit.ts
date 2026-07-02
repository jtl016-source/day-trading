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

interface Range { fromTs: number; toTs: number; deep?: boolean }

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

  dispatchNext(study);
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

/** Called by live-bars on `backfill_done` (and after a final:true bulk batch). */
export function onBackfillDone(
  id: string,
  count: number,
  earliestAvailableMs: number,
  _source: string,
) {
  const study = inflightById.get(id);
  if (!study) return;
  const range = study.inflight?.range;
  inflightById.delete(id);
  study.inflight = undefined;
  if (!range) { dispatchNext(study); return; }

  const { symbol, resolution } = study;

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
