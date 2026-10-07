/**
 * FIRE ADMISSION — the ONE persist-time choke point for new engine fires (2026-09-24, "a million
 * signals" review: journal signal-volume-pipeline-1/2, signal-volume-engine-4/9, regression-diff-3/4).
 *
 * WHY: three writers — the 10-min catch-up pass, the server live engine and a browser tab's
 * live-edge persist — each replay the fact engine over THEIR OWN data snapshot and persisted
 * whatever key was absent (exact natural key symbol|interval|timestamp|direction only). A
 * replay whose inputs differ by one bar (Yahoo backfill vs MW bars, a healed bar, a new median)
 * lands the same setup one bar over, so the DB held the UNION of every writer's phase: 37 of
 * 183 rows on 2026-09-24 sat closer than the engine's own cooldown to a same-interval row, and
 * the new ONE_OPEN_PER_DIRECTION rule would be defeated the same way.
 *
 * RULE (mirrors the engine, FACT_ENGINE_DEFAULTS — never a divergent copy): a NEW row
 * (no stored row with its natural key) from a live-path writer (source 'live' | 'catchup') is
 * admitted only when
 *   • COOLDOWN — no stored/admitted row on the same symbol+interval, EITHER direction (the
 *     engine's cursor is global), lies within COOLDOWN_BARS × barSec of it on EITHER side in
 *     time (a stored fire a few bars AFTER a replay's fire is the phase-shift class too; the
 *     engine's own spacing allows exactly COOLDOWN_BARS bars, so |Δt| < COOLDOWN × barSec
 *     rejects), and
 *   • ONE OPEN PER DIRECTION (when the setting is on) — no earlier same-direction row on that
 *     interval is still open at the fire's entry (the fire bar's CLOSE): outcome NULL/'open',
 *     or resolved with exit_ts after that close (the engine's `openUntil > closeTime`). Open
 *     rows older than OPEN_LOOKBACK_SEC are ignored — the stuck-open resolver walks 14 days,
 *     an older row that never resolved must not block forever.
 *     SYMMETRIC (2026-10-01, docs/signal-analysis-2026-10-01.md ticket 12a): ALSO no LATER stored
 *     same-direction row on that interval (within OPEN_LOOKBACK_SEC) at whose entry the candidate's
 *     OWN bracket (its walk record; no record = open) is still open — the replay twin that lands
 *     BEFORE the committed fire. The engine's priors seed cannot block earlier bars (no lookahead)
 *     and this check used to look backward only, so a catch-up/tab replay 11+ bars ahead of an
 *     ordered live fire was admitted: two open same-direction positions on one interval against
 *     the same target. The stored (ordered) row is the real trade; the earlier twin is refused.
 * Rows of one batch are admitted in time order and count as stored for the rows after them.
 * Writes to an EXISTING key (outcome updates, the tab's re-posts) are never admission-checked.
 * Regen (--persist, source 'regen') and legacy NULL-source writes are exempt: the standing
 * book is its own canonical replay and integrity-check V1 requires it byte-identical.
 *
 * ALSO HERE — the guarded upsert of POST /api/signals/history (moved verbatim from routes.ts so
 * it is testable against a temp DB), with the B2 provenance fix: on a natural-key conflict the
 * STORED row's `source` is kept (a tab re-post used to relabel catch-up rows 'live' forever)
 * and `updated_at` only moves when the row really changed (outcome transition or new label).
 */
import type BetterSqlite3 from "better-sqlite3";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { signalHistory } from "@shared/schema";
import { FACT_ENGINE_DEFAULTS, INTERVAL_SEC, type Interval } from "@shared/fact-engine";
import { isOutcomeTransitionAllowed, isLiveSourceCollision, type SignalSource } from "@shared/outcome-resolver";

/** Same horizon as catchup.ts resolveStuckRows — an open row older than this is never walked. */
export const OPEN_LOOKBACK_SEC = 14 * 86400;

/** Sources whose NEW rows go through admission (the live-path writers). */
export function admissionAppliesTo(source: string | null | undefined): boolean {
  return source === "live" || source === "catchup";
}

export interface AdmissionCandidate {
  symbol: string;
  interval: string;
  timestamp: number;
  direction: string;
  /** The fire's own record (engine walk) — lets later rows of the SAME batch see it as open/closed. */
  outcome?: string | null;
  exitTs?: number | null;
}
export type AdmissionReason = "cooldown" | "open";
export interface AdmissionRejection<T> { row: T; reason: AdmissionReason; blockedBy: string }
export interface AdmissionResult<T> { admitted: T[]; rejected: Array<AdmissionRejection<T>> }
export interface AdmissionOptions {
  /** Defaults to the server's own connection (db.$client). */
  client?: BetterSqlite3.Database;
  cooldownBars?: number;
  onePerDirection?: boolean;
}

const dirKey = (d: string | null | undefined): string => String(d ?? "").toLowerCase().startsWith("l") ? "L" : "S";
const naturalKey = (r: { interval: string; timestamp: number; direction: string }): string =>
  `${r.interval}|${r.timestamp}|${r.direction}`;

interface Known { ts: number; dir: string; key: string; outcome: string | null; exitTs: number | null }

/** Still open at `atTs` (the candidate's entry = its fire bar's close)? */
function openAt(k: Known, atTs: number): boolean {
  if (k.outcome == null || k.outcome === "open") return true;
  return k.exitTs != null && Number.isFinite(k.exitTs) && k.exitTs > atTs;
}
/** The CANDIDATE's own record (its engine walk) still open at `atTs`? No record = treated as open. */
function candidateOpenAt(r: AdmissionCandidate, atTs: number): boolean {
  if (r.outcome == null || r.outcome === "open") return true;
  return typeof r.exitTs === "number" && Number.isFinite(r.exitTs) && r.exitTs > atTs;
}

/**
 * Decide which NEW fires may be persisted. Pure w.r.t. the DB (reads only). Rows whose natural
 * key already exists in the DB (or earlier in the batch) are passed through as admitted — they
 * are updates, not new fires. Unknown intervals pass through (validateSignalRow owns them).
 */
export function admitFires<T extends AdmissionCandidate>(rows: T[], opts: AdmissionOptions = {}): AdmissionResult<T> {
  const client = opts.client ?? db.$client;
  const cooldownBars = opts.cooldownBars ?? FACT_ENGINE_DEFAULTS.COOLDOWN_BARS;
  const onePerDir = opts.onePerDirection ?? FACT_ENGINE_DEFAULTS.ONE_OPEN_PER_DIRECTION;
  const admitted: T[] = [];
  const rejected: Array<AdmissionRejection<T>> = [];
  if (!rows.length) return { admitted, rejected };

  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const g = `${r.symbol}|${r.interval}`;
    const arr = groups.get(g);
    if (arr) arr.push(r); else groups.set(g, [r]);
  }
  const sel = client.prepare(
    `SELECT timestamp, direction, outcome, exit_ts FROM signal_history
      WHERE symbol=? AND interval=? AND timestamp>=? AND timestamp<=?`);

  for (const group of groups.values()) {
    const { symbol, interval } = group[0];
    const ivSec = INTERVAL_SEC[interval as Interval];
    if (!ivSec) { admitted.push(...group); continue; }
    const cdSec = Math.max(0, cooldownBars) * ivSec;
    let minTs = Infinity, maxTs = -Infinity;
    for (const r of group) { if (r.timestamp < minTs) minTs = r.timestamp; if (r.timestamp > maxTs) maxTs = r.timestamp; }
    // Both sides of the batch: earlier rows for the cooldown + backward open check, LATER rows (up to
    // the open horizon) for the symmetric open check (2026-10-01).
    const stored = sel.all(symbol, interval, minTs - Math.max(cdSec, OPEN_LOOKBACK_SEC), maxTs + Math.max(cdSec, OPEN_LOOKBACK_SEC)) as Array<{
      timestamp: number; direction: string; outcome: string | null; exit_ts: number | null;
    }>;
    const known: Known[] = stored.map(s => ({
      ts: s.timestamp, dir: dirKey(s.direction), key: naturalKey({ interval, timestamp: s.timestamp, direction: s.direction }),
      outcome: s.outcome, exitTs: s.exit_ts,
    }));
    const knownKeys = new Set(known.map(k => k.key));
    const sorted = [...group].sort((a, b) => a.timestamp - b.timestamp);
    for (const r of sorted) {
      const key = naturalKey(r);
      if (knownKeys.has(key)) { admitted.push(r); continue; } // existing key → update, not a new fire
      const dir = dirKey(r.direction);
      const near = cdSec > 0 ? known.find(k => Math.abs(k.ts - r.timestamp) < cdSec) : undefined;
      if (near) { rejected.push({ row: r, reason: "cooldown", blockedBy: near.key }); continue; }
      if (onePerDir) {
        const entryTs = r.timestamp + ivSec; // entry = the fire bar's close (engine closeTime)
        const open = known.find(k => k.dir === dir && k.ts < r.timestamp && k.ts >= r.timestamp - OPEN_LOOKBACK_SEC && openAt(k, entryTs));
        if (open) { rejected.push({ row: r, reason: "open", blockedBy: open.key }); continue; }
        // SYMMETRIC (2026-10-01, ticket 12a): a LATER stored same-direction fire at whose entry THIS
        // candidate's own bracket is still open. The engine would have blocked that later fire had
        // this one been in its state; the stored one is the committed (ordered) trade, so the earlier
        // replay twin is the one refused — otherwise two open same-direction positions sit on one
        // interval against the same target (the priors seed cannot block earlier bars).
        const later = known.find(k => k.dir === dir && k.ts > r.timestamp && k.ts <= r.timestamp + OPEN_LOOKBACK_SEC && candidateOpenAt(r, k.ts + ivSec));
        if (later) { rejected.push({ row: r, reason: "open", blockedBy: later.key }); continue; }
      }
      admitted.push(r);
      known.push({
        ts: r.timestamp, dir, key,
        outcome: r.outcome ?? null,
        exitTs: typeof r.exitTs === "number" && Number.isFinite(r.exitTs) ? r.exitTs : null,
      });
      knownKeys.add(key);
    }
  }
  return { admitted, rejected };
}

/**
 * ORDER ADMISSION (2026-09-25, B5 follow-up): POST /api/trade/execute with a `fireTs` (the
 * browser tab's auto-trader) may order ONLY a fire that is STORED in signal_history — i.e. one
 * this module admitted (or one that already existed). WHY: the tab POSTs its fire to
 * /api/signals/history, admission may refuse it (cooldown / open trade — the phase-shifted twin
 * class), and 3 s later the tab's confirm timer used to POST the order anyway: the refused
 * twin became a real bracket. The server live engine orders in-process (never this route) and
 * only after its own persist, so it is untouched; test orders carry no fireTs.
 * Symbol-agnostic on purpose: the order's `symbol` is the CONTRACT type (MES/ES) while the row
 * is stored under the chart symbol. null = go ahead; a string = the refusal reason.
 */
export function orderSignalGateReason(
  k: { interval: string; fireTs: number; direction: string },
  client: BetterSqlite3.Database = db.$client,
): string | null {
  if (!Number.isFinite(k.fireTs)) return null; // no fire identity (test / manual orders) — other gates decide
  const hit = client.prepare(
    `SELECT 1 FROM signal_history WHERE timestamp=? AND interval=? AND direction=? LIMIT 1`,
  ).get(Math.floor(k.fireTs), String(k.interval ?? ""), String(k.direction ?? ""));
  if (hit) return null;
  return `signal ${k.interval} ${k.direction} @${Math.floor(k.fireTs)} is not a stored signal (refused by fire admission — cooldown / open trade — or never persisted)`;
}

/** One log-friendly line for a pass's rejections (callers log ONCE per pass, never per row). */
export function describeRejections<T extends AdmissionCandidate>(rejected: Array<AdmissionRejection<T>>, max = 6): string {
  const cd = rejected.filter(r => r.reason === "cooldown").length;
  const op = rejected.length - cd;
  const sample = rejected.slice(0, max).map(r => `${naturalKey(r.row)}(${r.reason}←${r.blockedBy.split("|").slice(1).join("|")})`);
  return `${rejected.length} rejected (cooldown ${cd}, open ${op})${sample.length ? `: ${sample.join(", ")}${rejected.length > max ? ", …" : ""}` : ""}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// GUARDED UPSERT — POST /api/signals/history's write core (moved from routes.ts 2026-09-24).
// ═════════════════════════════════════════════════════════════════════════════
export type SignalWriteRow = Omit<typeof signalHistory.$inferInsert, "shadowTags"> & {
  symbol: string; interval: string; timestamp: number; direction: string;
  source?: string | null;
  /** SHADOW TAGS (2026-10-01, record-only): the engine's FactSignal.shadowTags array, or an
   *  already-serialized JSON array string — normalized to the stored JSON string here. */
  shadowTags?: string[] | string | null;
};

/** SHADOW TAGS (2026-10-01): an array of strings serializes; a string must already parse to an
 *  array of strings; anything else → NULL (the upsert's COALESCE then keeps any stored value).
 *  Mirrors routes.ts normalizeRiskFlags. '[]' is a real value ("evaluated, no tag tripped"). */
export function normalizeShadowTags(raw: unknown): string | null {
  if (Array.isArray(raw) && raw.every(x => typeof x === "string")) return JSON.stringify(raw);
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p) && p.every((x: unknown) => typeof x === "string")) return JSON.stringify(p);
    } catch { /* fall through */ }
  }
  return null;
}
export interface SignalWriteResult {
  /** Rows written (fresh inserts + conflict updates). */
  accepted: SignalWriteRow[];
  /** The post-guard view of `accepted` (stored outcome/exit/source where the stored row stands) — what gets broadcast. */
  effective: SignalWriteRow[];
  /** Fresh natural keys among `accepted`. */
  freshInserts: number;
  collisionKeys: Array<{ symbol: string; interval: string; timestamp: number; direction: string }>;
  /** New fires refused by admitFires (cooldown / one-open-per-direction). */
  admissionRejected: Array<{ symbol: string; interval: string; timestamp: number; direction: string; reason: AdmissionReason; blockedBy: string }>;
}

export async function writeSignalRows(rawValues: SignalWriteRow[]): Promise<SignalWriteResult> {
  // SHADOW TAGS (2026-10-01): serialize once up front so every row object below (accepted /
  // effective / the insert) carries the stored JSON string form.
  const values: SignalWriteRow[] = rawValues.map(v => v.shadowTags === undefined ? v : { ...v, shadowTags: normalizeShadowTags(v.shadowTags) });
  // ── OUTCOME IMMUTABILITY GUARD (2026-07-31, first-touch semantics) ──────────────────
  // A recorded outcome is LOCKED: allowed transitions are ONLY (NULL|open) → anything and
  // win_tp1 → win_tp2 (identity rewrites pass for exit-detail refinement). Everything else
  // (win_tp1 → loss, loss → win, eod → ..., win_tp2 → ...) is REJECTED and logged loudly —
  // a TP1-hit trade can never be re-recorded as stopped-out by a later re-walk, a stale tab,
  // or a client whose bar data disagrees (the 2026-07-31 09:15 ET false-record root cause).
  // The upsert's SQL CASE below enforces the same matrix structurally; this pre-pass exists
  // to (a) log rejections with full detail and (b) let the signal_new broadcast carry the
  // EFFECTIVE (post-guard) values so no tab ever displays a rejected flip.
  const guardSel = db.$client.prepare(
    `SELECT outcome, exit_price, exit_ts, points_result, mae, mfe, bars_to_exit, source
       FROM signal_history WHERE symbol=? AND interval=? AND timestamp=? AND direction=?`,
  );
  // SOURCE-GUARD (2026-07-31, "live-fired records are permanent"): a stored source='live'
  // row hit by a NON-live write (regen --persist or a legacy NULL-source client) is a
  // COLLISION — the incoming row is dropped WHOLE (no field merged, nothing broadcast) and
  // reported back to the caller instead of overwriting. Live-path writes to live rows still
  // flow through the outcome matrix like any other write. Collisions are keyed so --persist
  // can print exactly which regen rows yielded to permanent live records.
  const accepted: SignalWriteRow[] = [];
  const effective: SignalWriteRow[] = [];
  const fresh: SignalWriteRow[] = [];
  const collisionKeys: SignalWriteResult["collisionKeys"] = [];
  for (const v of values) {
    const stored = guardSel.get(v.symbol, v.interval, v.timestamp, v.direction) as
      | { outcome: string | null; exit_price: number | null; exit_ts: number | null; points_result: number | null; mae: number | null; mfe: number | null; bars_to_exit: number | null; source: string | null }
      | undefined;
    if (!stored) { fresh.push(v); continue; } // fresh insert — admission below decides
    // 'catchup' is non-live for collision purposes (regen-class) — map it to the shared
    // enum's NULL so the helper's semantics apply unchanged (stored 'live' ⇒ collision).
    if (isLiveSourceCollision(stored.source, v.source === "catchup" ? null : (v.source as SignalSource))) {
      collisionKeys.push({ symbol: v.symbol, interval: v.interval, timestamp: v.timestamp, direction: v.direction });
      console.warn(
        `[signal-guard] LIVE-ROW COLLISION: ${v.symbol}/${v.interval} ts=${v.timestamp} ${v.direction} — ` +
        `stored source='live' row is permanent; incoming source=${v.source ?? "NULL(regen-treated)"} write dropped whole (reported, not merged).`,
      );
      continue;
    }
    const allowed = isOutcomeTransitionAllowed(stored.outcome, v.outcome);
    const realChange = allowed && v.outcome != null && v.outcome !== stored.outcome;
    // PROVENANCE (2026-09-24, B2): the stored row's source stands on every conflict write.
    if (realChange) { accepted.push(v); effective.push({ ...v, source: stored.source }); continue; } // allowed outcome change — the incoming record wins
    if (!allowed) {
      console.error(
        `[signal-guard] REJECTED outcome transition "${stored.outcome}" -> "${v.outcome}" for ` +
        `${v.symbol}/${v.interval} ts=${v.timestamp} ${v.direction} — outcomes are first-touch ` +
        `locked (only open→*, win_tp1→win_tp2 allowed); stored outcome + exit fields kept.`,
      );
    }
    // Identity/no-op or rejected: the stored record stands; incoming values only fill NULLs.
    accepted.push(v);
    effective.push({
      ...v,
      source: stored.source,
      outcome: stored.outcome,
      exitPrice: stored.exit_price ?? v.exitPrice, exitTs: stored.exit_ts ?? v.exitTs,
      pointsResult: stored.points_result ?? v.pointsResult,
      mae: stored.mae ?? v.mae, mfe: stored.mfe ?? v.mfe,
      barsToExit: stored.bars_to_exit ?? v.barsToExit,
    });
  }

  // ── FIRE ADMISSION (2026-09-24, B1): new keys from live-path writers only ──
  const toAdmit = fresh.filter(v => admissionAppliesTo(v.source));
  const adm = admitFires(toAdmit);
  const rejectedSet = new Set(adm.rejected.map(r => r.row));
  let freshInserts = 0;
  for (const v of fresh) {
    if (rejectedSet.has(v)) continue;
    accepted.push(v); effective.push(v); freshInserts++;
  }
  const admissionRejected = adm.rejected.map(r => ({
    symbol: r.row.symbol, interval: r.row.interval, timestamp: r.row.timestamp, direction: r.row.direction,
    reason: r.reason, blockedBy: r.blockedBy,
  }));
  if (adm.rejected.length) {
    console.log(`[fire-admission] POST /api/signals/history: ${describeRejections(adm.rejected)}`);
  }
  if (!accepted.length) return { accepted, effective, freshInserts, collisionKeys, admissionRejected };

  // The REAL-CHANGE predicate — a non-null incoming outcome that DIFFERS from the stored
  // one AND is allowed by the matrix (SQL mirror of isOutcomeTransitionAllowed; bare
  // column = the existing row inside SQLite's DO UPDATE; `excluded.*` = the incoming row;
  // `IS NOT` is SQLite's null-safe inequality). Identity/no-op posts and REJECTED
  // transitions both fall to the ELSE branches: outcome keeps the stored value and exit
  // fields become stored-wins (they only FILL when the stored field is NULL) — an open
  // tab whose bar data or levels disagree can neither flip a locked record NOR smear its
  // exit detail through an identity rewrite (observed live 2026-07-31 14:52 ET).
  const realChange = sql`(excluded.outcome IS NOT NULL AND excluded.outcome IS NOT outcome AND (outcome IS NULL OR outcome = 'open' OR (outcome = 'win_tp1' AND excluded.outcome = 'win_tp2')))`;
  const nowIso = new Date().toISOString();
  await db.insert(signalHistory).values(accepted as Array<typeof signalHistory.$inferInsert>).onConflictDoUpdate({
    target: [signalHistory.symbol, signalHistory.interval, signalHistory.timestamp, signalHistory.direction],
    set: {
      riskLevel:        sql`excluded.risk_level`,
      // OUTCOME-GUARD: locked unless the transition matrix allows the change.
      outcome:          sql`CASE WHEN ${realChange} THEN excluded.outcome ELSE outcome END`,
      footprintReading: sql`excluded.footprint_reading`, // FOOTPRINT-STRATEGY:
      confirmations:    sql`excluded.confirmations`, // PARITY:
      // E22 GUARD: an old client that omits `label` posts NULL — COALESCE keeps the stored
      // label instead of clobbering it (in SQLite DO UPDATE, bare `label` = the existing row).
      label:            sql`COALESCE(excluded.label, label)`, // FACT-ENGINE:
      // C3 GUARD (mirrors the label guard): the conflict-update previously omitted signal_type,
      // so a resolved-pass rewrite from an older client could never null it — and now can't.
      signalType:       sql`COALESCE(excluded.signal_type, signal_type)`, // SIGNAL-INTEGRITY:
      // EXIT-DETAIL GUARDS: on a real allowed outcome change the incoming record wins
      // (NULLs keep stored); otherwise the stored record is immutable — incoming values
      // only FILL stored NULLs. A rejected "loss" rewrite can smuggle in nothing.
      exitPrice:        sql`CASE WHEN ${realChange} THEN COALESCE(excluded.exit_price, exit_price) ELSE COALESCE(exit_price, excluded.exit_price) END`,
      exitTs:           sql`CASE WHEN ${realChange} THEN COALESCE(excluded.exit_ts, exit_ts) ELSE COALESCE(exit_ts, excluded.exit_ts) END`,
      pointsResult:     sql`CASE WHEN ${realChange} THEN COALESCE(excluded.points_result, points_result) ELSE COALESCE(points_result, excluded.points_result) END`,
      mae:              sql`CASE WHEN ${realChange} THEN COALESCE(excluded.mae, mae) ELSE COALESCE(mae, excluded.mae) END`,
      mfe:              sql`CASE WHEN ${realChange} THEN COALESCE(excluded.mfe, mfe) ELSE COALESCE(mfe, excluded.mfe) END`,
      barsToExit:       sql`CASE WHEN ${realChange} THEN COALESCE(excluded.bars_to_exit, bars_to_exit) ELSE COALESCE(bars_to_exit, excluded.bars_to_exit) END`,
      // RISK-DISPLAY GUARDS (2026-07-30, mirror the label guard): an old client posts NULL —
      // COALESCE keeps the stored combo key / risk flags (e.g. the analysis backfill values).
      comboKey:         sql`COALESCE(excluded.combo_key, combo_key)`,
      riskFlags:        sql`COALESCE(excluded.risk_flags, risk_flags)`,
      // POSITION SIZING (2026-08-02): same old-client NULL guard as comboKey/riskFlags.
      suggestedContracts: sql`COALESCE(excluded.suggested_contracts, suggested_contracts)`,
      // SHADOW TAGS (2026-10-01, record-only): same old-client NULL guard — a writer that does
      // not send tags (pre-feature tab, legacy client) never erases stored ones.
      shadowTags:       sql`COALESCE(excluded.shadow_tags, shadow_tags)`,
      // PROVENANCE (2026-09-24, B2 — replaces the 2026-07-31 "live write upgrades regen/NULL →
      // live" CASE): `source` is NOT in this SET, so a conflict write never changes it. A
      // tab re-posting its 2-day recompute relabelled 115 catch-up rows 'live' on 2026-09-24
      // (permanent, invisible to the digest). Live rows stay live (their collision rule above
      // is unchanged); catch-up/regen/NULL rows keep their provenance.
      // updated_at moves only when the row REALLY changed (allowed outcome transition or a new
      // label — the intra-candle → bar-close confirmation); an identical re-post leaves it.
      updatedAt:        sql`CASE WHEN ${realChange} OR (excluded.label IS NOT NULL AND excluded.label IS NOT label) THEN ${nowIso} ELSE updated_at END`,
    },
  });
  return { accepted, effective, freshInserts, collisionKeys, admissionRejected };
}
