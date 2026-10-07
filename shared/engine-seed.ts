/**
 * ENGINE SEED (2026-09-25 — B5 follow-up of the 2026-09-24 "a million signals" review).
 *
 * The ONE mapping from stored signal_history fires to the fact engine's cross-writer seed
 * inputs, shared by every writer that replays the engine:
 *   • server/catchup.ts loadPriorFires → FactEngineInput.priorFires for the 10-min catch-up,
 *     the live engine (worker + inline fallback, via buildLiveEngineContext);
 *   • the browser tab (client/src/pages/market.tsx) → GET /api/signals/prior-fires (which IS
 *     loadPriorFires) → priorFires at all three of its runFactEngine call sites, and
 *     lastFireTime + openTrades for its evaluateFormingBar (intra-candle) call.
 * Plus the tab's ORDER-ADMISSION bookkeeping: a fire the persist route refused (cooldown /
 * open trade, server/fire-admission.ts) is never ordered by the tab.
 *
 * Pure: no DB, no fetch, no React — unit-tested in scripts/engine-seed.test.ts.
 */
import { INTERVAL_SEC, type Interval, type PriorFire, type OpenTradeBracket, type FactDirection } from "./fact-engine";

export type PriorsByInterval = Partial<Record<Interval, PriorFire[]>>;

const INTERVALS: Interval[] = ["1m", "5m", "15m", "60m"];

/** "Long"/"long"/"L…" → "Long", "Short"/"s…" → "Short", anything else → null (row skipped). */
export function directionOf(raw: unknown): FactDirection | null {
  const d = String(raw ?? "").toLowerCase();
  return d.startsWith("l") ? "Long" : d.startsWith("s") ? "Short" : null;
}

/** NULL / non-finite level → NaN: the engine then uses that prior for the COOLDOWN only (its
 *  bracket cannot be walked). JSON has no NaN, so the prior-fires endpoint's NaN arrives as null. */
const numOrNaN = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);

/** One stored row (signal_history shape: `timestamp`; or the endpoint's PriorFire shape: `time`)
 *  → PriorFire, or null when its time / direction is unusable. */
export function priorFireFromRow(r: {
  timestamp?: unknown; time?: unknown; direction?: unknown; entry?: unknown; tp1?: unknown; sl?: unknown;
} | null | undefined): PriorFire | null {
  if (!r) return null;
  const t = typeof r.timestamp === "number" ? r.timestamp : r.time;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  const direction = directionOf(r.direction);
  if (!direction) return null;
  return { time: t, direction, entry: numOrNaN(r.entry), tp1: numOrNaN(r.tp1), sl: numOrNaN(r.sl) };
}

/** signal_history rows → per-interval PriorFire lists (unknown intervals skipped, time-ordered). */
export function priorsFromRows(rows: ReadonlyArray<{
  interval: string; timestamp: number; direction: string; entry: number | null; tp1: number | null; sl: number | null;
}>): PriorsByInterval {
  const out: PriorsByInterval = {};
  for (const r of rows) {
    const iv = r.interval as Interval;
    if (!INTERVAL_SEC[iv]) continue;
    const pf = priorFireFromRow(r);
    if (!pf) continue;
    (out[iv] ??= []).push(pf);
  }
  for (const iv of INTERVALS) out[iv]?.sort((a, b) => a.time - b.time);
  return out;
}

/** GET /api/signals/prior-fires/:symbol body → PriorsByInterval, or null when the body is not
 *  that endpoint's answer (old server without the route → an HTML page / 404 JSON). */
export function parsePriorFiresResponse(body: unknown): PriorsByInterval | null {
  const priors = (body as { priors?: unknown } | null | undefined)?.priors;
  if (!priors || typeof priors !== "object" || Array.isArray(priors)) return null;
  const out: PriorsByInterval = {};
  for (const iv of INTERVALS) {
    const list = (priors as Record<string, unknown>)[iv];
    if (!Array.isArray(list)) continue;
    const fires = list.map(x => priorFireFromRow(x as Parameters<typeof priorFireFromRow>[0]))
      .filter((x): x is PriorFire => x !== null)
      .sort((a, b) => a.time - b.time);
    if (fires.length) out[iv] = fires;
  }
  return out;
}

const sameNum = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));
function samePriorList(a: PriorFire[] | undefined, b: PriorFire[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.time !== y.time || x.direction !== y.direction || !sameNum(x.entry, y.entry) || !sameNum(x.tp1, y.tp1) || !sameNum(x.sl, y.sl)) return false;
  }
  return true;
}

/** Identity-stable refresh: `prev` itself when nothing changed, otherwise a new object that
 *  REUSES every unchanged interval's array — so a poll that returns the same fires re-runs no
 *  engine memo, and a new 1m fire does not re-run the 5m/15m/60m passes. */
export function stablePriors(prev: PriorsByInterval, next: PriorsByInterval): PriorsByInterval {
  let changed = false;
  const out: PriorsByInterval = {};
  for (const iv of INTERVALS) {
    const p = prev[iv], n = next[iv];
    if (samePriorList(p, n)) { if (p) out[iv] = p; }
    else { changed = true; if (n) out[iv] = n; }
  }
  return changed ? out : prev;
}

/** Most recent fire time strictly before `before` across the given lists (−Infinity if none).
 *  A fire AT `before` (the forming bar's own fire) must never suppress itself. */
export function latestFireTimeBefore(lists: ReadonlyArray<ReadonlyArray<{ time: number }> | undefined>, before: number): number {
  let best = -Infinity;
  for (const list of lists) {
    if (!list) continue;
    for (const f of list) if (f.time < before && f.time > best) best = f.time;
  }
  return best;
}

/** evaluateFormingBar's `openTrades`: per direction, the LATEST fire strictly before `before`
 *  across the given lists, as its bracket. The engine resolves it itself (canonical resolver
 *  over closed bars + the forming bar); a resolved bracket simply does not block. Fires with a
 *  non-finite entry/tp1/sl are skipped (their bracket cannot be walked — cooldown-only, the same
 *  contract as runFactEngine's priorFires). */
export function openTradesBefore(
  lists: ReadonlyArray<ReadonlyArray<{ time: number; direction: string; entry: number; tp1: number; sl: number }> | undefined>,
  before: number,
): Partial<Record<FactDirection, OpenTradeBracket>> {
  const out: Partial<Record<FactDirection, OpenTradeBracket>> = {};
  for (const list of lists) {
    if (!list) continue;
    for (const f of list) {
      if (!(f.time < before)) continue;
      const dir = directionOf(f.direction);
      if (!dir) continue;
      if (!Number.isFinite(f.entry) || !Number.isFinite(f.tp1) || !Number.isFinite(f.sl)) continue;
      const cur = out[dir];
      if (!cur || f.time > cur.firedAt) out[dir] = { entry: f.entry, tp1: f.tp1, sl: f.sl, firedAt: f.time };
    }
  }
  return out;
}

// ═════ TAB ORDER ADMISSION ═════
// POST /api/signals/history answers `admissionKeys` = the NEW fires server/fire-admission.ts
// refused (cooldown / one-open-per-direction). The tab records a verdict per fire it posted and
// its auto-trader consults it before POST /api/trade/execute — a fire the route refused is not a
// stored signal and must never become an order.

/** Natural key without symbol — `${interval}|${timestamp}|${direction}` (fire-admission's form). */
export function admissionKey(interval: string, timestamp: number, direction: string): string {
  return `${interval}|${timestamp}|${direction}`;
}

export type PersistVerdict = "stored" | "refused" | "failed";

/** Keys the persist route refused, from its JSON body (missing / malformed → empty). */
export function refusedKeysFromPersistResponse(body: unknown): Set<string> {
  const out = new Set<string>();
  const list = (body as { admissionKeys?: unknown } | null | undefined)?.admissionKeys;
  if (!Array.isArray(list)) return out;
  for (const k of list) {
    const r = k as { interval?: unknown; timestamp?: unknown; direction?: unknown } | null;
    if (r && typeof r.interval === "string" && typeof r.timestamp === "number" && typeof r.direction === "string") {
      out.add(admissionKey(r.interval, r.timestamp, r.direction));
    }
  }
  return out;
}

/** Verdict for one posted key given the POST outcome. A non-OK HTTP answer, a network error
 *  (httpOk=false) or an `ok:false` body = "failed". */
export function persistVerdictFor(key: string, httpOk: boolean, body: unknown): PersistVerdict {
  if (!httpOk || (body as { ok?: unknown } | null | undefined)?.ok === false) return "failed";
  return refusedKeysFromPersistResponse(body).has(key) ? "refused" : "stored";
}

/** Why the tab must NOT order this fire (null = go ahead). `undefined` = this tab never posted
 *  the key (e.g. a display-only bg-scanner fire): the server's own gates decide. */
export function orderAdmissionBlockReason(verdict: PersistVerdict | undefined): string | null {
  if (verdict === "refused") return "refused by fire admission (cooldown / open trade on this interval) — not stored, not ordered";
  if (verdict === "failed") return "signal could not be stored — order withheld";
  return null;
}
