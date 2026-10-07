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
import { deriveForDeletedOneMin } from "./derive-bars"; // 1M-DERIVE: heal 5m/15m/60m after phantom 1m reconcile-deletes
// CONTRACT GUARD (2026-09-18): a study whose chart sits on a different contract month than
// Yahoo's front month must never be ASKED for backfills (its fills would re-create the 09-17
// Sep/Dec interleave) and its answers must never drive reconcile-deletes (the thin expiring
// contract simply did not trade many minutes the canonical front-month rows cover). No import
// cycle: contract-guard statically imports only ./db (its live modules are lazy imports).
import { isMwOffContract } from "./contract-guard";

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

// 1M-DERIVE: for MES the higher resolutions (5m/15m/60m) are now COMPUTED from 1m (see
// derive-bars.ts) — 1m is the only backfill resolution that needs MW. A native backfill of a
// derived resolution would re-introduce the mutually-inconsistent per-chart history the 1m
// derivation exists to replace, so we skip audits/backfills for them. Their hellos are still
// accepted (harmless) and their sync_state.latest_ts still refreshes. Only MES is derived;
// ES and contract-keyed symbols keep native backfill on every resolution.
const isDerivedRes = (symbol: string, resolution: string) => symbol === "MES" && resolution !== "1";

interface Range { fromTs: number; toTs: number; deep?: boolean; reconcile?: boolean; /** already re-queued once after an unanswered dispatch (2026-09-23 F5) */ timedOut?: boolean }

/** auditGaps options (2026-09-18 — event-loop stall fix).
 *  sinceTs  — bound BOTH the row SELECT and the grid walk to [sinceTs..now]. Omitted = the
 *             whole history. The hello / hourly / watchdog audits own whole-history coverage,
 *             but no longer by walking it on every call — see PERIODIC AUDIT POLICY below.
 *  forStudy — the ranges will be dispatched to the MW study: Yahoo-specific
 *             `yahoo_no_data` unfillable markers (gap-heal's "Yahoo's 1m feed has no such
 *             minute" — the 18:00 ET Globex-open minute, 00:00–00:09 ET) are NOT skipped,
 *             because MotiveWave may well hold the minutes Yahoo's feed lacks. */
export interface AuditOpts { sinceTs?: number; forStudy?: boolean }

// ── Audit ───────────────────────────────────────────────────────────────────
// EVENT-LOOP STALL (measured 2026-09-17/18 — the "chart is laggy / can't stay live" review):
// the original audit SELECTed ALL ~2.46 MILLION MES 1m rows as objects, built a Set of them,
// then walked every grid minute from sync_state.earliest_ts (Aug 2019) to now probing the Set
// — ~4.5 s of fully blocked event loop PER CALL (no ticks, no WS frames, no HTTP), and
// gap-heal called it twice every 10 minutes. Three changes, same results:
//   1. `sinceTs` bounds the SELECT + the walk (gap-heal passes now − 7 d: ~10k rows, a few ms);
//   2. the still-FORMING bucket is never audited (end = last CLOSED bucket) — auditing up to
//      and including floor(now/step) guaranteed at least one "gap" during session hours;
//   3. the unbounded path is a sorted MERGE-WALK over plucked timestamps (no per-row object,
//      no 2.46M-entry Set, isSessionOpen only consulted for grid points that are actually
//      absent) — identical output to the Set lookup, a fraction of the time and garbage.
//
// SECOND STALL (2026-09-18, adversarial review of the fix above — measured on the live DB):
// the UNBOUNDED audit still froze the loop ~10 s. MES:1 = 2,461,771 rows → 105,270 session-open
// missing minutes → 28,792 runs, and unfillable_ranges holds 46,332 MES:1 rows (46,220
// `no_data`): the overlap test was a linear `unf.some()` PER RUN = ~670 MILLION callback
// invocations = 8.7 s, plus 1.7 s for the 2.46M-row pluck SELECT in one synchronous call.
// Reached by every non-derived study hello (armStudy), the hourly tick per connected study,
// the watchdog re-arm and getCompleteness — latent only because the MES:1 LiveBarRelay has not
// said hello since 09-15, and the watchdog's own log line tells the user to re-attach it. Fix:
//   4. the overlap test is a binary search over the unfillable rows COALESCED once into
//      disjoint sorted intervals — O(unf + runs·log unf), identical verdicts (unfillableMatcher);
//   5. the whole-history walk has an ASYNC variant (auditGapsAsync) that SELECTs + walks
//      WALK_CHUNK_STEPS grid steps per slice and yields to the event loop (setImmediate)
//      between slices — same output, no slice longer than a few tens of ms;
//   6. the periodic callers no longer walk the whole history every time (PERIODIC AUDIT
//      POLICY, above the dispatcher's periodicAudit).
// The sync signature stays for gap-heal's bounded call, requestGapSweep and getCompleteness.
const WALK_CHUNK_STEPS = 100_000; // grid steps per async slice (~69 days of 1m ≈ ≤68k rows)

interface AuditWindow { step: number; start: number; end: number }

/** Resolve the audited grid window [start..end] (both on-grid, end = last CLOSED bucket), or
 *  null when there is nothing to audit. Shared by the sync and async audits. */
function auditWindow(symbol: string, resolution: string, opts: AuditOpts): AuditWindow | null {
  // 1M-DERIVE: MES 5m/15m/60m are derived from 1m — never request native backfill for them.
  if (isDerivedRes(symbol, resolution)) return null;
  const step = intervalSec(resolution);

  const stateRow = db.$client.prepare(
    `SELECT earliest_ts FROM sync_state WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution) as { earliest_ts: number | null } | undefined;

  let start: number;
  if (stateRow?.earliest_ts != null) start = stateRow.earliest_ts;
  else {
    // MIN() is an index seek on (symbol, resolution, timestamp) — the old code read this off
    // the front of the full row list.
    const mn = db.$client.prepare(
      `SELECT MIN(timestamp) AS mn FROM cached_candles WHERE symbol=? AND resolution=?`,
    ).get(symbol, resolution) as { mn: number | null };
    start = mn.mn ?? (nowSec() - 7 * 86400);
  }
  start = Math.floor(start / step) * step;
  if (opts.sinceTs != null && Number.isFinite(opts.sinceTs)) {
    const since = Math.floor(opts.sinceTs / step) * step;
    if (since > start) start = since;
  }
  // Last CLOSED bucket — the bucket containing `now` is still forming and is not a gap.
  const end = Math.floor(nowSec() / step) * step - step;
  if (end <= start) return null;
  return { step, start, end };
}

/** Append the missing, session-open grid points of [from..to] (both on-grid) to `missing`:
 *  merge-walk the ascending stored timestamps against the grid. `cursor` = next grid point not
 *  yet accounted for; everything between it and the next ON-GRID stored row is absent from the
 *  store. A grid point's verdict depends only on its own row, so walking the window in
 *  consecutive slices (auditGapsAsync) appends exactly what one whole-window walk appends. */
function walkMissing(symbol: string, resolution: string, step: number, from: number, to: number, missing: number[]): void {
  // Rows before `from` / after `to` were never visited by the grid walk — bounding the
  // SELECT by both changes nothing in the unbounded case and is the whole win when bounded.
  const stored = db.$client.prepare(
    `SELECT timestamp FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp ASC`,
  ).pluck().all(symbol, resolution, from, to) as number[];

  let cursor = from;
  const sweepTo = (upto: number): void => {
    for (let t = cursor; t <= upto; t += step) if (isSessionOpen(t)) missing.push(t);
  };
  for (const ts of stored) {
    // An off-grid legacy row never satisfied a grid point under the old Set lookup either.
    if (ts < cursor || ts % step !== 0) continue;
    if (ts > cursor) sweepTo(ts - step);
    cursor = ts + step;
  }
  if (cursor <= to) sweepTo(to);
}

/** "Does [a..b] overlap ANY applicable unfillable range?" — the exact old predicate
 *  (`a <= u.to_ts && b >= u.from_ts` for some row u), answered in O(log unf) per call instead
 *  of O(unf): the rows are loaded ORDER BY from_ts and coalesced ONCE into disjoint intervals
 *  (merged only on true overlap, so their union is the same point set), whose `to` bounds are
 *  therefore ascending too — the first interval with to >= a is the only one that can still
 *  start at or before b. Rows that cannot touch the audited window [lo..hi] are never loaded
 *  (every run lies inside it). A malformed marker (to_ts < from_ts — none exist, no writer
 *  produces one) is not an interval, so it keeps the literal predicate. */
function unfillableMatcher(symbol: string, resolution: string, forStudy: boolean | undefined, lo: number, hi: number): (a: number, b: number) => boolean {
  // `yahoo_no_data` markers (written by gap-heal's targeted Yahoo 1m healer, 2026-09-18) only
  // bind the YAHOO path — an audit whose ranges go to the MW study (forStudy) still asks
  // MotiveWave for those minutes; MW's own zero-answer accounting (onBackfillDone → `no_data`)
  // retires them for everyone if it has nothing either.
  // .raw() = [from_ts, to_ts] tuples: 46k MES:1 rows load in ~15 ms instead of ~35 ms as objects.
  const rows = db.$client.prepare(
    (forStudy
      ? `SELECT from_ts, to_ts FROM unfillable_ranges WHERE symbol=? AND resolution=? AND COALESCE(reason,'') != 'yahoo_no_data'`
      : `SELECT from_ts, to_ts FROM unfillable_ranges WHERE symbol=? AND resolution=?`)
    + ` AND to_ts>=? AND from_ts<=? ORDER BY from_ts ASC`,
  ).raw().all(symbol, resolution, lo, hi) as [number, number][];

  const from: number[] = [];
  const to: number[] = [];
  const odd: [number, number][] = [];
  for (const u of rows) {
    if (u[1] < u[0]) { odd.push(u); continue; }
    const n = to.length;
    if (n > 0 && u[0] <= to[n - 1]) { if (u[1] > to[n - 1]) to[n - 1] = u[1]; }
    else { from.push(u[0]); to.push(u[1]); }
  }
  return (a: number, b: number): boolean => {
    let l = 0, h = to.length; // first interval whose `to` >= a
    while (l < h) { const m = (l + h) >>> 1; if (to[m] < a) l = m + 1; else h = m; }
    if (l < to.length && from[l] <= b) return true;
    return odd.length > 0 && odd.some(u => a <= u[1] && b >= u[0]);
  };
}

/** missing grid points → dispatchable ranges: group into runs, drop the unfillable ones,
 *  split the long ones. O(missing + unfillable) — a few ms even for MES:1's whole history. */
function rangesFromMissing(symbol: string, resolution: string, w: AuditWindow, missing: number[], opts: AuditOpts): Range[] {
  if (missing.length === 0) return [];
  const { step } = w;

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
  const overlapsUnfillable = unfillableMatcher(symbol, resolution, opts.forStudy, w.start, w.end);

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

/** Synchronous audit — ONE SELECT + one walk. Right for a BOUNDED window (gap-heal's 7 days,
 *  the periodic audits' few days: a few thousand rows, ~10 ms). Unbounded on MES:1 it is
 *  still a ~1 s synchronous read of 2.46M rows — only getCompleteness (an on-demand status
 *  route) does that; everything periodic goes through periodicAudit / auditGapsAsync. */
export function auditGaps(symbol: string, resolution: string, opts: AuditOpts = {}): Range[] {
  const w = auditWindow(symbol, resolution, opts);
  if (!w) return [];
  const missing: number[] = [];
  walkMissing(symbol, resolution, w.step, w.start, w.end, missing);
  return rangesFromMissing(symbol, resolution, w, missing, opts);
}

/** slices = walk slices; maxSliceMs = longest uninterrupted stretch (walk slices + the tail). */
export interface AuditWalkStats { slices: number; maxSliceMs: number; wallMs: number }

/** Same output as auditGaps, but the window is read + walked WALK_CHUNK_STEPS grid steps at a
 *  time with a setImmediate yield between slices, so ticks / WS frames / HTTP / order gates
 *  get the loop back every few tens of ms during a whole-history walk. A window that fits one
 *  slice never yields (the body runs synchronously up to the return). The store may change
 *  between slices: a row written behind the walk leaves a stale "missing" minute — a
 *  redundant, harmless backfill request (upsert); a row deleted behind it is the next audit's
 *  gap, exactly as if it had been deleted the moment after a synchronous walk. */
export async function auditGapsAsync(symbol: string, resolution: string, opts: AuditOpts = {}, stats?: AuditWalkStats): Promise<Range[]> {
  const w = auditWindow(symbol, resolution, opts);
  if (!w) return [];
  const t0 = Date.now();
  const missing: number[] = [];
  const span = w.step * WALK_CHUNK_STEPS;
  const yieldToLoop = () => new Promise<void>(resolve => setImmediate(resolve));
  let walked = 0;
  for (let from = w.start; from <= w.end; from += span) {
    if (walked++ > 0) await yieldToLoop();
    const s0 = Date.now();
    walkMissing(symbol, resolution, w.step, from, Math.min(w.end, from + span - w.step), missing);
    if (stats) { stats.slices++; stats.maxSliceMs = Math.max(stats.maxSliceMs, Date.now() - s0); }
  }
  // The tail is its own slice after a multi-slice walk (MES:1: 46k unfillable rows + 28k runs).
  if (walked > 1) await yieldToLoop();
  const s0 = Date.now();
  const out = rangesFromMissing(symbol, resolution, w, missing, opts);
  if (stats) { stats.maxSliceMs = Math.max(stats.maxSliceMs, Date.now() - s0); stats.wallMs = Date.now() - t0; }
  return out;
}

// ── Dispatcher state ─────────────────────────────────────────────────────────
interface StudySync {
  symbol: string;
  resolution: string;
  ws: WebSocket;
  queue: Range[];
  inflight?: { id: string; range: Range; /** epoch sec the request was sent (2026-09-23 F5: in-flight timeout) */ sentAt: number };
  /** CONTRACT GUARD (2026-09-18): `hello` arrived while MotiveWave was OFF-CONTRACT — the
   *  hello-time arming (first-ever stamp, full audit, deep probe, pending resync/reconcile,
   *  dispatch) is DEFERRED, not dropped: the hourly tick / watchdog / gap-heal sweep run it
   *  the moment the guard recovers, so nothing needs a reconnect to resume. */
  armPending?: boolean;
}
const studies = new Map<string, StudySync>();      // SYM:RES → sync state
const inflightById = new Map<string, StudySync>();  // backfill id → owning study
const zeroAttempts = new Map<string, number>();     // "SYM:RES:from:to" → count of empty responses
let idCounter = 0;

// ── STUDY-DECLINED RANGES (2026-09-23 — IBKR bridge post-build review F2) ──────────────────
// A study may refuse a range by POLICY (the IBKR bridge's contract-era floor, its
// IB_BACKFILL_MAX_DAYS bound, or IB_SERVE_BACKFILL=false): `backfill_done {count:0,
// declined:true, reason}`. That is NOT "the provider has no data": the old count===0 path
// marked such a range `no_data` in unfillable_ranges after two answers (both arrive within
// seconds) — permanently hiding it from every healer — and gap-heal never used Yahoo for it
// because requestGapSweep still returned non-null. Declined ranges are instead
//   • skipped by enqueue / dispatchNext for DECLINE_SKIP_SEC (no re-asking churn), and
//   • handed to gap-heal (takeStudyDeclined) for the Yahoo path.
// MotiveWave's studies never send `declined` — their path is unchanged.
const DECLINE_SKIP_SEC = 6 * 3600;
const DECLINED_MAX = 2000; // per SYM:RES, both lists — bounded however large an audit gets
interface DeclinedEntry { fromTs: number; toTs: number; until: number }
const studyDeclined = new Map<string, DeclinedEntry[]>();       // SYM:RES → live skip entries
const declinedPending = new Map<string, Map<string, Range>>();  // SYM:RES → ranges awaiting gap-heal's Yahoo path

function liveDeclined(k: string): DeclinedEntry[] {
  const list = studyDeclined.get(k);
  if (!list) return [];
  const now = nowSec();
  const live = list.filter(e => e.until > now);
  if (live.length !== list.length) { if (live.length) studyDeclined.set(k, live); else studyDeclined.delete(k); }
  return live;
}
function isDeclinedRange(k: string, r: Range): boolean {
  for (const e of liveDeclined(k)) if (r.fromTs <= e.toTs && r.toTs >= e.fromTs) return true;
  return false;
}
function queueDeclinedForHeal(k: string, r: Range): void {
  if (r.deep) return; // the [0..cap] provider probe is not a gap anyone can heal
  let m = declinedPending.get(k);
  if (!m) { m = new Map(); declinedPending.set(k, m); }
  const rk = `${r.fromTs}:${r.toTs}`;
  if (m.has(rk)) return;
  if (m.size >= DECLINED_MAX) { const first = m.keys().next().value; if (first !== undefined) m.delete(first); }
  m.set(rk, { fromTs: r.fromTs, toTs: r.toTs });
}
function noteDeclined(k: string, r: Range): void {
  if (r.deep) return; // the provider probe is asked once per first-ever sync — no skip entry needed
  const list = liveDeclined(k).slice();
  list.push({ fromTs: r.fromTs, toTs: r.toTs, until: nowSec() + DECLINE_SKIP_SEC });
  studyDeclined.set(k, list.length > DECLINED_MAX ? list.slice(-DECLINED_MAX) : list);
  queueDeclinedForHeal(k, r);
}

/** gap-heal (2026-09-23 F2): the ranges a study DECLINED by policy since the last call —
 *  returned and cleared. The skip entries stay until they expire (enqueue / dispatchNext keep
 *  re-offering skipped ranges here, so every heal pass sees what the study will not fill). */
export function takeStudyDeclined(symbol: string, resolution: string): Array<{ fromTs: number; toTs: number }> {
  const k = key(symbol, resolution);
  const m = declinedPending.get(k);
  if (!m || m.size === 0) return [];
  declinedPending.delete(k);
  return [...m.values()].map(r => ({ fromTs: r.fromTs, toTs: r.toTs }));
}

// IN-FLIGHT TIMEOUT (2026-09-23 F5): a dispatched range with no backfill_done wedged the
// study's whole queue until the socket dropped. The watchdog clears one older than this and
// re-queues it ONCE at the front (a second timeout drops it; the next audit re-finds the gap).
// The deep [0..cap] provider probe can legitimately take minutes on MotiveWave — own bound.
const INFLIGHT_TIMEOUT_SEC = 180;
const INFLIGHT_TIMEOUT_DEEP_SEC = 15 * 60;

// MW-RECONCILE: per in-flight backfill id, the set of bar timestamps (epoch seconds) MW
// actually RETURNED. live-bars feeds these via recordBackfillBars as bulk_bars arrive.
// We record what MW SENT (pre-validation), never the validated subset — so a real MW bar
// our validator happens to reject can never be reconcile-deleted as a "phantom".
const returnedByBackfill = new Map<string, Set<number>>();

// CONTRACT GUARD (2026-09-18): backfill ids that received at least one batch while MotiveWave
// was OFF-CONTRACT. live-bars DROPS those batches (never written) but still records their
// timestamps here — so without this taint, a guard that recovers between the last batch and
// `backfill_done` would let onBackfillDone treat a wrong-month answer as authoritative.
const taintedBackfills = new Set<string>();

/**
 * MW-RECONCILE: called by live-bars when a v2 bulk_bars batch tagged with `id` arrives.
 * Accumulates the timestamps MW returned for that backfill so onBackfillDone can delete
 * our rows in the requested range that MW did NOT return.
 */
export function recordBackfillBars(id: string, timestampsSec: number[]): void {
  if (!id || timestampsSec.length === 0) return;
  if (isMwOffContract()) taintedBackfills.add(id);
  let set = returnedByBackfill.get(id);
  if (!set) { set = new Set<number>(); returnedByBackfill.set(id, set); }
  for (const t of timestampsSec) set.add(t);
}

function upsertSyncState(symbol: string, resolution: string): boolean {
  const existing = db.$client.prepare(
    `SELECT symbol FROM sync_state WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution);
  // TWO single-aggregate reads, not `SELECT MIN(..), MAX(..)` (2026-09-18, measured on the live
  // DB): SQLite's min/max index seek only applies to a query with ONE aggregate — the combined
  // form scanned all 2.46M MES:1 index entries, ~260 ms of blocked event loop per call, and
  // this runs on every hello, hourly tick, watchdog re-arm AND every productive backfill_done.
  // Split: 0.15 ms, same values (NULLs included on an empty key).
  const mnRow = db.$client.prepare(
    `SELECT MIN(timestamp) AS mn FROM cached_candles WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution) as { mn: number | null };
  const mxRow = db.$client.prepare(
    `SELECT MAX(timestamp) AS mx FROM cached_candles WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution) as { mx: number | null };
  const bounds = { mn: mnRow.mn, mx: mxRow.mx };
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
  // CONTRACT GUARD (2026-09-18): gap ranges found while MW is off-contract are never queued
  // for it — Yahoo (front month) heals meanwhile, and every audit path re-runs on recovery.
  if (isMwOffContract()) return;
  if (ranges.length === 0) return;
  // Same dedupe (exact fromTs/toTs match against the queue, the in-flight range and the ranges
  // pushed earlier in this call), keyed instead of `queue.some()` per range (2026-09-18): today
  // MES:1's whole-history audit yields 6 ranges because ~46k `no_data` markers swallow the
  // rest, but one DELETE /api/data/unfillable turns it into ~28k — 28k × a 28k-deep queue was
  // the same quadratic stall as the overlap test, one operator click away.
  const rk = (r: Range) => `${r.fromTs}:${r.toTs}`;
  const seen = new Set<string>();
  for (const q of study.queue) seen.add(rk(q));
  if (study.inflight) seen.add(rk(study.inflight.range));
  const k = key(study.symbol, study.resolution);
  for (const r of ranges) {
    const id = rk(r);
    if (seen.has(id)) continue;
    seen.add(id);
    // STUDY-DECLINED (F2): the study refused this span by policy within the last 6 h — do not
    // re-ask it; gap-heal's Yahoo path gets it instead.
    if (isDeclinedRange(k, r)) { queueDeclinedForHeal(k, r); continue; }
    study.queue.push(r);
  }
}

function dispatchNext(study: StudySync) {
  // CONTRACT GUARD (2026-09-18): THE choke point — nothing is requested from a wrong-month
  // chart, whoever queued it (hello, hourly tick, watchdog, gap-heal sweep, operator
  // resync/reconcile, the next-in-queue chain after a backfill_done). The queue is RETAINED:
  // the hourly tick / watchdog / gap-heal sweep call back in here once the guard recovers.
  if (isMwOffContract()) return;
  if (study.inflight) return;
  const k = key(study.symbol, study.resolution);
  let range = study.queue.shift();
  // STUDY-DECLINED (F2): ranges queued before the study declined an overlapping span.
  while (range && isDeclinedRange(k, range)) { queueDeclinedForHeal(k, range); range = study.queue.shift(); }
  if (!range) return;
  if (study.ws.readyState !== WebSocket.OPEN) return;
  const id = `bf-${++idCounter}`;
  study.inflight = { id, range, sentAt: nowSec() };
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

// ── PERIODIC AUDIT POLICY (2026-09-18 — second event-loop stall, see the Audit header) ──────
// hello / the hourly tick / the watchdog re-arm used to walk the WHOLE history on every call.
// A range audited clean — or already dispatched — does not need re-walking every hour, so per
// (symbol, resolution):
//   • WHOLE-HISTORY audit (auditGapsAsync — sliced, yields to the loop) when this process has
//     no record of one whose findings reached a study (boot; or the findings were LOST: the
//     study dropped / re-helloed with ranges still queued or in flight — its queue dies with
//     it), when sync_state.last_audit_ts is absent, when the last one is ≥ 24 h old, or when
//     unfillable markers were DELETED since the last audit (DELETE /api/data/unfillable and
//     the full-resync route exist to make the next audit re-ask those ranges — detected by a
//     COUNT / MAX(id) fingerprint; AUTOINCREMENT ids are never reused);
//   • otherwise a BOUNDED synchronous audit from (last audit − 2 d safety margin), floored to
//     the UTC day so a long gap cut by the bound keeps ONE fromTs all day (the queue dedupe and
//     the per-range attempt accounting both key on the exact fromTs:toTs). A few thousand
//     rows, a few ms. Anything older that changes under us (reconcile / repair deletes) is
//     picked up by the next whole-history audit, ≤ 24 h later; gap-heal sweeps the newest 7
//     days every 10 minutes regardless.
// Whole-history walks are serialized on ONE chain — several studies saying hello together
// (every server boot) must not run their slices back-to-back inside one check phase.
const FULL_AUDIT_EVERY_SEC = 24 * 3600;
const PERIODIC_MARGIN_SEC = 2 * 86400;
interface FullAuditMark { atSec: number; unfCount: number; unfMaxId: number }
const lastFullAudit = new Map<string, FullAuditMark>(); // SYM:RES → last DELIVERED whole-history audit (this process)
const fullAuditPending = new Set<string>();             // SYM:RES with a whole-history walk queued / in flight
let fullAuditChain: Promise<void> = Promise.resolve();

/** sync_state.last_audit_ts — callers read it BEFORE upsertSyncState re-stamps it. */
function readLastAuditTs(symbol: string, resolution: string): number | null {
  const r = db.$client.prepare(
    `SELECT last_audit_ts FROM sync_state WHERE symbol=? AND resolution=?`,
  ).get(symbol, resolution) as { last_audit_ts: number | null } | undefined;
  return r?.last_audit_ts ?? null;
}

/** Fingerprint of the markers that bind a forStudy audit. `added` = rows with id > sinceId, so
 *  "rows were deleted since the mark" ⇔ mark.unfCount + added > n. ~5 ms on 46k rows. */
function unfillableFingerprint(symbol: string, resolution: string, sinceId: number): { n: number; mx: number; added: number } {
  return db.$client.prepare(
    `SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS mx, COALESCE(SUM(id > ?),0) AS added FROM unfillable_ranges WHERE symbol=? AND resolution=? AND COALESCE(reason,'') != 'yahoo_no_data'`,
  ).get(sinceId, symbol, resolution) as { n: number; mx: number; added: number };
}

/** A study's queue dies with its socket (and with the `hello` that replaces it): whatever a
 *  whole-history audit found and had not been filled yet is forgotten, so the next audit for
 *  this key must find it again — drop the mark. */
function forgetFullAuditIfWorkLost(k: string, s: StudySync): void {
  if (s.inflight || s.queue.length) lastFullAudit.delete(k);
}

/** The audit → enqueue → dispatch step of hello / hourly tick / watchdog re-arm. The caller has
 *  already stamped sync_state; `prevAuditTs` is last_audit_ts as it stood BEFORE that stamp.
 *  Bounded path: synchronous, same tick (throws to the caller's try/catch like the old inline
 *  audit). Whole-history path: queued on fullAuditChain; its findings go to whichever study is
 *  registered for the key when the walk lands (the socket that asked may have been replaced). */
function periodicAudit(study: StudySync, prevAuditTs: number | null): void {
  const { symbol, resolution } = study;
  // 1M-DERIVE: nothing to audit for MES 5m/15m/60m (auditGaps returned [] for them) — the
  // dispatch kick for a retained resync / reconcile queue is all the old sequence did here.
  if (isDerivedRes(symbol, resolution)) { dispatchNext(study); return; }
  const k = key(symbol, resolution);
  const mark = lastFullAudit.get(k);
  const fp = unfillableFingerprint(symbol, resolution, mark?.unfMaxId ?? 0);
  const markersCleared = !!mark && mark.unfCount + fp.added > fp.n;

  if (mark && prevAuditTs != null && !markersCleared && nowSec() - mark.atSec < FULL_AUDIT_EVERY_SEC) {
    mark.unfCount = fp.n; mark.unfMaxId = fp.mx;
    const sinceTs = Math.floor((Math.min(prevAuditTs, mark.atSec) - PERIODIC_MARGIN_SEC) / 86400) * 86400;
    enqueue(study, auditGaps(symbol, resolution, { sinceTs, forStudy: true }));
    dispatchNext(study);
    return;
  }

  if (fullAuditPending.has(k)) return; // one is already queued / walking — it delivers to the live study
  fullAuditPending.add(k);
  const why = !mark ? "first since boot / earlier findings lost"
    : prevAuditTs == null ? "no last_audit_ts"
    : markersCleared ? "unfillable markers were cleared"
    : "24 h since the last one";
  fullAuditChain = fullAuditChain.then(async () => {
    try {
      const asker = studies.get(k);
      // Nobody to hand findings to — skip the walk; the next hello / tick / recovery asks again.
      if (!asker || asker.ws.readyState !== WebSocket.OPEN || isMwOffContract()) return;
      const fp0 = unfillableFingerprint(symbol, resolution, 0); // BEFORE the walk: a marker cleared mid-walk costs one extra audit, never a missed re-ask
      const startedAt = nowSec();
      const stats: AuditWalkStats = { slices: 0, maxSliceMs: 0, wallMs: 0 };
      const ranges = await auditGapsAsync(symbol, resolution, { forStudy: true }, stats);
      const cur = studies.get(k);
      if (!cur || cur.ws.readyState !== WebSocket.OPEN || isMwOffContract()) {
        console.warn(`[gap-audit] ${k} whole-history audit finished (${ranges.length} range(s)) but no usable study is registered any more — not recorded; the next hello / tick re-audits`);
        return;
      }
      lastFullAudit.set(k, { atSec: startedAt, unfCount: fp0.n, unfMaxId: fp0.mx });
      enqueue(cur, ranges);
      dispatchNext(cur);
      console.log(`[gap-audit] ${k} whole-history audit (${why}) → ${ranges.length} range(s) · ${stats.slices} slices, ${stats.wallMs} ms wall, longest slice ${stats.maxSliceMs} ms`);
    } catch (e: any) {
      console.error(`[gap-audit] whole-history audit failed for ${k}: ${e?.message}`);
    } finally {
      fullAuditPending.delete(k);
    }
  });
}

/** Called by live-bars when a study sends `hello`. */
export function onStudyConnected(symbol: string, resolution: string, ws: WebSocket) {
  const k = key(symbol, resolution);
  const prior = studies.get(k);
  if (prior) forgetFullAuditIfWorkLost(k, prior); // a re-hello replaces the entry — its queue is dropped with it
  const study: StudySync = { symbol, resolution, ws, queue: [] };
  studies.set(k, study); // registration ALWAYS happens — anyStudyConnected / staleness stay truthful

  // CONTRACT GUARD (2026-09-18): a wrong-month chart is not audited against or asked for
  // anything. Deferred, not skipped — armStudy runs on recovery (see StudySync.armPending);
  // the sync_state stamp is deferred with it so `firstEver` (the deep-history probe) and
  // last_audit_ts ("an audit actually ran") both stay honest.
  if (isMwOffContract()) {
    study.armPending = true;
    console.warn(`[gap-audit] ${k} hello while MotiveWave is OFF-CONTRACT (contract guard) — audit/backfill dispatch deferred until it matches Yahoo's front month again`);
    return;
  }
  armStudy(study);
}

/** The hello-time arming sequence (stamp → deep probe → pending resync / reconcile → gap
 *  audit → dispatch). Split out of onStudyConnected 2026-09-18 so a hello that arrived
 *  while the contract guard was tripped can be armed later without a reconnect. */
function armStudy(study: StudySync) {
  const { symbol, resolution } = study;
  const k = key(symbol, resolution);
  study.armPending = false;

  const prevAuditTs = readLastAuditTs(symbol, resolution); // BEFORE the stamp below
  const firstEver = upsertSyncState(symbol, resolution);

  if (firstEver && !isDerivedRes(symbol, resolution)) {
    // Deep-history probe: ask for everything before the earliest bar we have so
    // we learn the provider's history cap (recorded via backfill_done). Skipped for MES
    // derived resolutions — their history comes from 1m derivation, not a native probe.
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

  // 1M-DERIVE phantom-heal: targeted reconcile ranges queued while this study was offline
  // (e.g. the ~106 15m/60m buckets whose 1m carries residual +60pt phantom prints). Prepend so
  // MW's authoritative answer overwrites/deletes those 1m prints ahead of the normal gap fills.
  const pend = reconcilePending.get(k);
  if (pend && pend.length) { reconcilePending.delete(k); study.queue.unshift(...pend); }

  // The gap audit (2026-09-18: periodicAudit — bounded, or a sliced whole-history walk that
  // lands later). It ran BEFORE the priority unshifts above; its ranges are APPENDED either
  // way, so the queue is the same [reconcile…, resync…, deep probe, audit…] — and the priority
  // work is dispatched now instead of waiting behind a whole-history walk.
  periodicAudit(study, prevAuditTs);
  dispatchNext(study);
}

/** GAP-HEAL FAILSAFE (2026-08-14, user: "i had to close my computer/lost wifi... make a fail
 *  safe so there are no incorrect gaps"): re-run the session-aware gap audit on an
 *  ALREADY-CONNECTED study and dispatch fills. The original design only audited on `hello`,
 *  so gaps that opened while connected — or became fillable later — sat forever. Returns
 *  the number of missing ranges found (0 = clean), or null when no study is connected for
 *  this (symbol, resolution) — the caller then falls back to the yahoo heal.
 *  2026-09-18: takes the caller's audit bound (`sinceTs`) — gap-heal sweeps every 10 minutes
 *  and the unbounded re-audit here was a THIRD full-history walk per pass (the hello / hourly
 *  / watchdog audits keep whole-history coverage). Off-contract = "no usable study" (null):
 *  the caller's Yahoo fallback heals, and no audit work is spent on a quarantined chart. */
export function requestGapSweep(symbol: string, resolution: string, opts: AuditOpts = {}): number | null {
  if (isMwOffContract()) return null;
  const study = studies.get(key(symbol, resolution));
  if (!study || study.ws.readyState !== WebSocket.OPEN) return null;
  if (study.armPending) armStudy(study); // hello arrived while the guard was tripped — arm it now
  const gaps = auditGaps(symbol, resolution, { ...opts, forStudy: true });
  if (gaps.length) {
    enqueue(study, gaps);
    dispatchNext(study);
  }
  return gaps.length;
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
  // CONTRACT GUARD (2026-09-18): off-contract counts as "study offline" — a reconcile sweep
  // answered by a wrong-month chart is the one operation that could DELETE canonical rows.
  // Parked in forceResyncPending (survives the reconnect that rolling the MW chart causes)
  // and re-armed on recovery.
  const off = isMwOffContract();
  if (study && study.ws.readyState === WebSocket.OPEN && !off) {
    enqueueFullResync(study);
    dispatchNext(study);
    return true;
  }
  forceResyncPending.add(k);
  if (study && off) study.armPending = true;
  return false;
}

// 1M-DERIVE phantom-heal: (SYM:RES) → reconcile ranges to run on the study's next `hello`.
const reconcilePending = new Map<string, Range[]>();

/**
 * 1M-DERIVE phantom-heal: normalize a set of raw ranges into grid-aligned, merged,
 * MAX_RANGE_BARS-chunked reconcile ranges for `resolution`. Merging collapses overlapping /
 * adjacent phantom buckets so we issue the fewest backfills.
 */
function buildReconcileRanges(resolution: string, ranges: { fromTs: number; toTs: number }[]): Range[] {
  const step = intervalSec(resolution);
  const aligned = ranges
    .map(r => ({ fromTs: Math.floor(r.fromTs / step) * step, toTs: Math.floor(r.toTs / step) * step }))
    .filter(r => r.toTs >= r.fromTs)
    .sort((a, b) => a.fromTs - b.fromTs);
  const merged: { fromTs: number; toTs: number }[] = [];
  for (const r of aligned) {
    const last = merged[merged.length - 1];
    if (last && r.fromTs <= last.toTs + step) { if (r.toTs > last.toTs) last.toTs = r.toTs; }
    else merged.push({ ...r });
  }
  const out: Range[] = [];
  for (const r of merged) {
    for (let s = r.fromTs; s <= r.toTs; s += step * MAX_RANGE_BARS) {
      out.push({ fromTs: s, toTs: Math.min(r.toTs, s + step * (MAX_RANGE_BARS - 1)), reconcile: true });
    }
  }
  return out;
}

/**
 * 1M-DERIVE phantom-heal: force-enqueue targeted reconcile backfills for (SYM:RES). When MW
 * answers each range (count>0), onBackfillDone → reconcileRange overwrites/deletes the phantom
 * rows MW omits, and the derivation hook re-derives the affected higher-TF buckets. Runs
 * immediately if the study is connected, else on its next `hello`. Returns whether it ran now.
 */
export function requestReconcile(symbol: string, resolution: string, ranges: { fromTs: number; toTs: number }[]): boolean {
  const built = buildReconcileRanges(resolution, ranges);
  if (built.length === 0) return false;
  const k = key(symbol, resolution);
  const study = studies.get(k);
  // CONTRACT GUARD (2026-09-18): same parking rule as requestFullResync — never queue a
  // reconcile (delete-capable) range on a wrong-month chart; run it on recovery instead.
  const off = isMwOffContract();
  if (study && study.ws.readyState === WebSocket.OPEN && !off) {
    study.queue.unshift(...built);
    dispatchNext(study);
    return true;
  }
  const pend = reconcilePending.get(k) ?? [];
  pend.push(...built);
  reconcilePending.set(k, pend);
  if (study && off) study.armPending = true;
  return false;
}

/** Called by live-bars on socket close. */
export function onStudyDisconnected(ws: WebSocket) {
  for (const [k, s] of studies) {
    if (s.ws === ws) {
      forgetFullAuditIfWorkLost(k, s); // un-filled audit findings die with this queue (2026-09-18)
      if (s.inflight) {
        inflightById.delete(s.inflight.id);
        // No backfill_done will ever arrive for it — drop its per-id accounting too.
        returnedByBackfill.delete(s.inflight.id);
        taintedBackfills.delete(s.inflight.id);
      }
      studies.delete(k);
    }
  }
}

/** YAHOO-FALLBACK: true when any hello-registered LiveBarRelay study socket is OPEN — the
 *  same connection state the audit watchdog consults (getAuditStaleness.studyConnected).
 *  yahoo-live.ts polls this (plus the TickRelay flag) to yield to MW immediately. */
export function anyStudyConnected(): boolean {
  for (const s of studies.values()) {
    if (s.ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
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

  // 1M-DERIVE: the reconcile just removed phantom 1m prints — re-derive the 5m/15m/60m buckets
  // that contained them so the derived rows heal (or, if a bucket lost ALL its 1m bars, its
  // derived row is deleted too). MES 1m only; other (SYM:RES) deletes don't feed derivation.
  if (symbol === "MES" && resolution === "1") {
    try {
      const { rederived, deleted: derDeleted } = deriveForDeletedOneMin(symbol, toDelete);
      if (rederived > 0 || derDeleted > 0) {
        console.log(`[gap-audit] 1M-DERIVE reconcile-heal ${symbol}: re-derived ${rederived} buckets, deleted ${derDeleted} now-empty derived rows`);
      }
    } catch (e: any) {
      console.error(`[gap-audit] 1M-DERIVE reconcile-heal ${symbol} failed: ${e?.message}`);
    }
  }
  return toDelete.length;
}

/** Called by live-bars on `backfill_done` (and after a final:true bulk batch). */
export function onBackfillDone(
  id: string,
  count: number,
  earliestAvailableMs: number,
  _source: string,
  declined = false,
) {
  // CONTRACT GUARD (2026-09-18): evaluated up-front so the taint entry never leaks.
  const wrongMonth = taintedBackfills.delete(id) || isMwOffContract();
  const study = inflightById.get(id);
  if (!study) { returnedByBackfill.delete(id); return; }
  const range = study.inflight?.range;
  inflightById.delete(id);
  study.inflight = undefined;
  if (!range) { returnedByBackfill.delete(id); dispatchNext(study); return; }

  const { symbol, resolution } = study;

  // STUDY-DECLINED (2026-09-23 F2): a POLICY refusal (the IBKR bridge's era floor / max-days /
  // serve switch) carries no data and says nothing about the provider — no reconcile, no
  // zero-answer / provider-cap accounting (which would mark the range `no_data` forever).
  // Skip it for DECLINE_SKIP_SEC and hand it to gap-heal's Yahoo path.
  if (declined) {
    returnedByBackfill.delete(id);
    noteDeclined(key(symbol, resolution), range);
    console.log(`[gap-audit] ${symbol}:${resolution} backfill ${id} [${range.fromTs}..${range.toTs}] DECLINED by the study (policy) — not marked unfillable; offered to gap-heal's Yahoo path, not re-asked for ${DECLINE_SKIP_SEC / 3600} h`);
    dispatchNext(study);
    return;
  }

  // CONTRACT GUARD (2026-09-18): this answer came (wholly or partly) from a chart on a
  // DIFFERENT contract month — a backfill that was already in flight when the guard tripped.
  // live-bars dropped its bars, so nothing about it may be believed:
  //   • NO reconcile — the thin expiring contract did not trade many minutes the canonical
  //     Yahoo front-month rows cover; "MW returned no bar here" would DELETE real rows;
  //   • NO attempt accounting — a 0-bar / never-closing answer from the wrong month must not
  //     walk the range toward `no_data` / `rejected_bars`, and a deep probe's
  //     earliestAvailableMs must not become the provider cap.
  // The range goes back to the FRONT of the queue untouched; dispatchNext is gated, so it is
  // re-asked only once MotiveWave agrees with the front month again.
  if (wrongMonth) {
    returnedByBackfill.delete(id);
    study.queue.unshift(range);
    console.warn(`[gap-audit] ${symbol}:${resolution} backfill ${id} [${range.fromTs}..${range.toTs}] answered while MotiveWave was OFF-CONTRACT — ignored (no reconcile, no attempt accounting); re-queued for after recovery`);
    dispatchNext(study); // no-op while still off-contract; resumes the chain if the guard just recovered
    return;
  }

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
    // Productive fill — but cap repeat attempts for the SAME range. MW can answer a range with
    // bars our validation rejects every time (v0 / off-grid filler bars MW synthesizes for thin
    // 2019-era minutes): the grid still sees gaps, the hourly re-audit re-requests, MW answers,
    // validation rejects — an infinite slow churn (observed as an endless parade of tiny 2019 1m
    // backfills). Three answered attempts without the gaps closing = permanently unfillable
    // (retryable-clearable via the existing /api/data/unfillable endpoint like no_data).
    const pk = `${symbol}:${resolution}:${range.fromTs}:${range.toTs}`;
    const n = (zeroAttempts.get(pk) ?? 0) + 1;
    zeroAttempts.set(pk, n);
    if (n >= 3) {
      db.$client.prepare(
        `INSERT INTO unfillable_ranges (symbol, resolution, from_ts, to_ts, attempts, reason) VALUES (?,?,?,?,?,?)`,
      ).run(symbol, resolution, range.fromTs, range.toTs, n, "rejected_bars");
      zeroAttempts.delete(pk);
      console.log(`[gap-audit] ${symbol}:${resolution} [${range.fromTs}..${range.toTs}] answered ${n}x without closing — marked unfillable (rejected_bars)`);
    }
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
  // Whole-history + synchronous ON PURPOSE (both routes answer in the same tick and nothing
  // polls them: /api/gaps/status is an operator probe, /api/data/gaps only a client fallback).
  // 2026-09-18: with the O(log unf) overlap this is ~1 s on MES:1 (the 2.46M-row read), was ~10 s.
  const gaps = auditGaps(symbol, resolution);
  const pct = expected > 0 ? Math.min(100, (stored.n / expected) * 100) : 100;
  return { stored: stored.n, expected, pct: Math.round(pct * 100) / 100, gaps };
}

// ── Hourly re-audit for connected studies ────────────────────────────────────
// Per-study try/catch: one throwing audit (e.g. transient SQLITE_BUSY while a bulk job holds the
// write lock) must not abort the tick for every other study — a silent hourly abort is exactly how
// last_audit_ts freezes while the server keeps running.
setInterval(() => {
  // CONTRACT GUARD (2026-09-18): no audit, no stamp, no dispatch for a wrong-month chart —
  // last_audit_ts going stale is the TRUTH while the guard is tripped (the watchdog below says
  // why, once an hour), and the skipped walk is event-loop time the live feed keeps.
  if (isMwOffContract()) return;
  for (const study of studies.values()) {
    if (study.ws.readyState !== WebSocket.OPEN) continue;
    try {
      if (study.armPending) { armStudy(study); continue; } // hello arrived while the guard was tripped
      const prevAuditTs = readLastAuditTs(study.symbol, study.resolution); // BEFORE the stamp
      upsertSyncState(study.symbol, study.resolution);
      periodicAudit(study, prevAuditTs); // 2026-09-18: bounded, or a sliced whole-history walk ≤ 1×/24 h
    } catch (e: any) {
      console.error(`[gap-audit] hourly re-audit failed for ${study.symbol}:${study.resolution}: ${e?.message}`);
    }
  }
}, 60 * 60 * 1000).unref?.();

// ── Audit staleness + watchdog ───────────────────────────────────────────────
// ROOT CAUSE of the 2026-07-13 22:15 ET freeze: audits are HELLO-GATED. last_audit_ts is stamped
// only on study hello, on a productive backfill, and by the hourly tick above — which iterates
// ONLY connected LiveBarRelay studies. When the study socket dropped that night and MW never
// re-sent `hello`, the `studies` map stayed empty, so the hourly tick had nothing to audit and
// nothing ever re-armed — while the separate TickRelay feed kept live bars flowing for ~19h, so
// the freeze was invisible. The watchdog below makes staleness loud and self-heals the
// connected-but-stale case; GET /api/mw/sync-status exposes getAuditStaleness().

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;       // check every 5 min
const STALE_CONNECTED_SEC = 30 * 60;              // study connected but no audit stamp in 30 min → re-arm
const STALE_ABSOLUTE_SEC = 6 * 3600;              // no audit stamp in 6 h regardless → log loudly
const staleLogAt = new Map<string, number>();     // SYM:RES → last loud-log epoch sec (1h throttle)

export interface AuditStaleness {
  symbol: string;
  resolution: string;
  lastAuditTs: number | null;
  staleSec: number | null;
  studyConnected: boolean;
  stale: boolean; // past the applicable threshold (30 min connected / 6 h regardless)
}

/** Per-(symbol,resolution) audit freshness — served by GET /api/mw/sync-status. */
export function getAuditStaleness(): AuditStaleness[] {
  const now = nowSec();
  const rows = db.$client.prepare(
    `SELECT symbol, resolution, last_audit_ts FROM sync_state ORDER BY symbol, resolution`,
  ).all() as { symbol: string; resolution: string; last_audit_ts: number | null }[];
  return rows.map(r => {
    const k = key(r.symbol, r.resolution);
    const study = studies.get(k);
    const connected = !!study && study.ws.readyState === WebSocket.OPEN;
    const staleSec = r.last_audit_ts != null ? now - r.last_audit_ts : null;
    const stale = staleSec == null
      ? true
      : (connected ? staleSec > STALE_CONNECTED_SEC : staleSec > STALE_ABSOLUTE_SEC);
    return { symbol: r.symbol, resolution: r.resolution, lastAuditTs: r.last_audit_ts, staleSec, studyConnected: connected, stale };
  });
}

setInterval(() => {
  try {
    const now = nowSec();
    // CONTRACT GUARD (2026-09-18): while MotiveWave is off-contract every audit/dispatch path
    // is paused ON PURPOSE. Say so once an hour instead of "re-arming" every 5 minutes, and the
    // moment the guard recovers resume by ourselves (≤ one watchdog tick, no reconnect
    // needed): arm the studies whose hello was deferred, and restart any retained queue.
    const off = isMwOffContract();
    if (off) {
      let connected = 0;
      for (const st of studies.values()) if (st.ws.readyState === WebSocket.OPEN) connected++;
      const last = staleLogAt.get("offcontract") ?? 0;
      if (connected > 0 && now - last >= 3600) {
        staleLogAt.set("offcontract", now);
        console.warn(`[gap-audit] WATCHDOG: audits + backfill dispatch PAUSED for ${connected} connected study(ies) — MotiveWave is OFF-CONTRACT (contract guard); Yahoo heals meanwhile, everything resumes automatically once MW matches the front month`);
      }
    } else {
      for (const st of studies.values()) {
        if (st.ws.readyState !== WebSocket.OPEN) continue;
        try {
          if (st.armPending) {
            console.log(`[gap-audit] ${key(st.symbol, st.resolution)} contract guard recovered — running the deferred hello audit now`);
            armStudy(st);
          } else if (st.inflight && now - st.inflight.sentAt > (st.inflight.range.deep ? INFLIGHT_TIMEOUT_DEEP_SEC : INFLIGHT_TIMEOUT_SEC)) {
            // IN-FLIGHT TIMEOUT (2026-09-23 F5): no backfill_done — the study lost the request
            // (an IB request that never answered, a study reloaded without a socket drop).
            const { id, range, sentAt } = st.inflight;
            inflightById.delete(id);
            returnedByBackfill.delete(id);
            taintedBackfills.delete(id);
            st.inflight = undefined;
            if (range.timedOut) {
              console.warn(`[gap-audit] ${key(st.symbol, st.resolution)} backfill ${id} [${range.fromTs}..${range.toTs}] unanswered for ${now - sentAt} s AGAIN — dropped (the next audit re-finds the gap)`);
            } else {
              range.timedOut = true;
              st.queue.unshift(range);
              console.warn(`[gap-audit] ${key(st.symbol, st.resolution)} backfill ${id} [${range.fromTs}..${range.toTs}] unanswered for ${now - sentAt} s — cleared and re-queued once at the front`);
            }
            dispatchNext(st);
          } else if (!st.inflight && st.queue.length) dispatchNext(st);
        } catch (e: any) {
          console.error(`[gap-audit] WATCHDOG resume failed for ${key(st.symbol, st.resolution)}: ${e?.message}`);
        }
      }
    }
    for (const s of getAuditStaleness()) {
      if (!s.stale) continue;
      const k = key(s.symbol, s.resolution);
      if (s.studyConnected) {
        if (off) continue; // paused by the contract guard (logged above) — nothing to re-arm
        // Study is here but the audit stamp is stale — the scheduler lost a beat (missed hello,
        // aborted tick). Log loudly and RE-ARM immediately: stamp + audit + dispatch.
        console.error(`[gap-audit] WATCHDOG: ${k} audit stale ${s.staleSec != null ? Math.round(s.staleSec / 60) : "∞"} min WITH a live study — re-arming audit now`);
        const study = studies.get(k);
        if (study) {
          try {
            // s.lastAuditTs is the pre-stamp value getAuditStaleness just read (2026-09-18).
            upsertSyncState(s.symbol, s.resolution);
            periodicAudit(study, s.lastAuditTs);
          } catch (e: any) {
            console.error(`[gap-audit] WATCHDOG re-arm failed for ${k}: ${e?.message}`);
          }
        }
      } else {
        // No study connection — can't audit, but say so loudly (1h throttle per key) instead of
        // freezing silently like on 2026-07-13.
        const last = staleLogAt.get(k) ?? 0;
        if (now - last >= 3600) {
          staleLogAt.set(k, now);
          const ageH = s.staleSec != null ? (s.staleSec / 3600).toFixed(1) : "∞";
          console.error(`[gap-audit] WATCHDOG: ${k} audit stale ${ageH}h and NO study connected — MW LiveBarRelay is not sending hello; gaps are not being audited`);
        }
      }
    }
  } catch (e: any) {
    console.error(`[gap-audit] WATCHDOG tick failed: ${e?.message}`);
  }
}, WATCHDOG_INTERVAL_MS).unref?.();
