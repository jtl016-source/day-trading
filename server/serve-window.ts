/**
 * SERVE WINDOW (2026-09-24 — "the chart isn't loading correctly"): the PURE request-window clamp
 * for GET /api/data/cached-continuous and GET /api/yellowbox/day-zones.
 *
 * WHY: the store holds ~2.47M MES 1m rows back to 2019. The row cap (SERVE_ROW_CAP, 2026-07-12)
 * only ran when the request carried NO `from`, so any explicit deep `from` (the web page's
 * first-render window started at the FIRST cached day, 2019-08-04) read + filtered +
 * JSON.stringify'd the whole store on the single server thread: 248 MB / ~20 s per request,
 * twice per page load, with ticks, WS broadcasts and every poll frozen behind it. A negative
 * `from` took the same uncapped path.
 *
 * RULES (all pure — no DB, no clock; the route passes `nowSec`):
 *   • from: a finite number > 0, else "absent" (NaN, garbage, arrays, 0, negative → absent).
 *   • to:   a finite number > 0, else "absent" (= the future clamp); always ≤ now + 36 h
 *           (corrupt future-dated rows are never served). The SQL upper bound is `to` CEILED
 *           to the hour (toQ) — a SUPERSET of what the caller asked for, so every caller that
 *           shares a cache key receives at least its own bars (the old key rounded `to` while
 *           the query used the exact value: a gap-fill with to=now could be handed a body built
 *           for an earlier `to` in the same rounded hour and miss the newest minutes).
 *   • SPAN CAP per resolution (calendar days, measured back from min(to, now + 1 h)): `from` is
 *     raised to that floor even when given explicitly. `?full=1` lifts the span cap ONLY for
 *     15m / 60m (terminal deep history); it is ignored everywhere else.
 *   • ROW CAP (unchanged numbers) still bounds whatever the span cap leaves open (60m, 15m
 *     full=1). The route runs the OFFSET query only when `rowCapCheckNeeded` says the span could
 *     hold more rows than the cap — the hot short-window path pays nothing.
 *   • `from` is floored to the hour (the 2026-09-18 shared-body cache rule), AFTER clamping.
 *   • capped / servedFrom: echoed so clients can show "window capped"; servedFrom = the SQL
 *     lower bound actually used whenever a cap raised it.
 *   • The cache key is built from EXACTLY the SQL bounds (fromQ, toQ) plus the capped flag
 *     (it is part of the body) — two requests share a body iff they run the identical query.
 *
 * SPAN CAP NUMBERS: the chart-window task asked for 1m 14 d / 5m 90 d / 15m 400 d / 60m ∞.
 * 15m and 60m are exactly that. 1m and 5m are FLOORED at ENGINE_WINDOW_MIN_DAYS because the
 * server's own engines read candles through this very route: server/catchup.ts
 * buildLiveEngineContext (the 10-min catch-up pass AND the server live-engine — the order
 * placing path) self-fetches the last 90 CACHED days (= 105 calendar days on 2026-09-24) of
 * 1m / 5m / 15m / 60m, and its stuck-open resolver walks those 1m bars. A 14-day 1m cap would
 * silently truncate the engine's inputs and break parity with the backtest harness
 * (scripts/fact-engine-backtest.ts LIVE_WINDOW_DAYS = 90). The browser windows are capped
 * much tighter CLIENT-side (client/src/lib/candle-window.ts: 1m 14 d, 5m 90 d, 15m 400 d).
 */

export type ServeResolution = "1" | "5" | "15" | "60";

const HOUR = 3600;
const DAY = 86400;

/** Minimum span (calendar days) the 1m / 5m server caps must allow: the server engines'
 *  90-cached-day window is ~105 calendar days today and at most 90 × 7/5 = 126 even if the
 *  cached-days list only held weekdays; 150 leaves margin for holidays + CATCHUP_WINDOW_DAYS. */
export const ENGINE_WINDOW_MIN_DAYS = 150;

/** Requested per-resolution span caps (calendar days). */
export const REQUESTED_SPAN_CAP_DAYS: Record<ServeResolution, number> = { "1": 14, "5": 90, "15": 400, "60": Infinity };

/** Effective server span caps = requested, floored at the engine window. */
export const SERVE_SPAN_CAP_DAYS: Record<ServeResolution, number> = {
  "1": Math.max(REQUESTED_SPAN_CAP_DAYS["1"], ENGINE_WINDOW_MIN_DAYS),
  "5": Math.max(REQUESTED_SPAN_CAP_DAYS["5"], ENGINE_WINDOW_MIN_DAYS),
  "15": REQUESTED_SPAN_CAP_DAYS["15"],
  "60": REQUESTED_SPAN_CAP_DAYS["60"],
};

/** Row caps (the 2026-07-12 SERVE_CAP numbers, unchanged). Keyed by the ROW resolution the
 *  route has always used for the cap query ("5" for 15m — the 5m fallback rows). */
export const SERVE_ROW_CAP: Record<ServeResolution, number> = { "1": 250_000, "5": 500_000, "15": 200_000, "60": 60_000 };

/** Future clamp: never serve rows dated beyond now + 36 h. */
export const FUTURE_SLACK_SEC = 36 * HOUR;

/** Day-zones span cap (calendar days). The route's own default window was 730 d. */
export const DAY_ZONES_MAX_SPAN_DAYS = 400;

const hourFloor = (t: number): number => Math.floor(t / HOUR) * HOUR;
const hourCeil = (t: number): number => Math.ceil(t / HOUR) * HOUR;

/** A query-string epoch (seconds): finite and > 0, else null. Only strings / numbers count —
 *  a repeated param (Express hands an array) or an object is "absent". */
export function parseEpochParam(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `?full=1` (also "true"). */
export function isFullParam(raw: unknown): boolean {
  return raw === "1" || raw === "true" || raw === 1 || raw === true;
}

/** Span-cap resolution of a chart interval (15m has its own cap even though its rows may be 5m). */
export function spanResolutionOf(interval: string): ServeResolution {
  return interval === "1m" ? "1" : interval === "60m" ? "60" : interval === "15m" ? "15" : "5";
}

/** Row resolution — the route's long-standing mapping (15m and unknown intervals → "5"). */
export function rowResolutionOf(interval: string): ServeResolution {
  return interval === "60m" ? "60" : interval === "1m" ? "1" : "5";
}

export interface ServeWindow {
  interval: string;
  spanRes: ServeResolution;
  rowRes: ServeResolution;
  /** SQL lower bound (hour-aligned, or 0 = unbounded). */
  fromQ: number;
  /** SQL upper bound (hour-aligned, ≤ the future clamp). */
  toQ: number;
  /** A cap raised fromQ above what the caller asked for (absent `from` = "everything"). */
  capped: boolean;
  /** = fromQ whenever capped, else null. */
  servedFrom: number | null;
  /** `full=1` was honored (15m / 60m only). */
  full: boolean;
  /** The span cap applied (Infinity = none). */
  spanCapDays: number;
}

export function resolveServeWindow(
  q: { interval: string; from?: unknown; to?: unknown; full?: unknown },
  nowSec: number,
): ServeWindow {
  const interval = String(q.interval ?? "");
  const spanRes = spanResolutionOf(interval);
  const rowRes = rowResolutionOf(interval);
  const full = isFullParam(q.full) && (spanRes === "15" || spanRes === "60");
  const spanCapDays = full ? Infinity : SERVE_SPAN_CAP_DAYS[spanRes];

  const maxTsH = hourFloor(nowSec + FUTURE_SLACK_SEC);
  const toReq = parseEpochParam(q.to);
  const toClamped = Math.min(toReq ?? Infinity, nowSec + FUTURE_SLACK_SEC);
  const toQ = Math.min(hourCeil(toClamped), maxTsH);

  const fromReq = parseEpochParam(q.from);
  // The span is measured back from the END THAT CAN HOLD BARS: min(to, now + 1 h). A request
  // with no `to` (future clamp = now + 36 h) would otherwise lose 35 h of its window.
  const anchor = Math.min(toClamped, nowSec + HOUR);
  const capFloor = Number.isFinite(spanCapDays) ? hourFloor(anchor - spanCapDays * DAY) : 0;

  let from = fromReq ?? 0;
  let capped = false;
  if (capFloor > 0 && from < capFloor) { from = capFloor; capped = true; }
  const fromQ = from > 0 ? hourFloor(from) : 0;
  return { interval, spanRes, rowRes, fromQ, toQ, capped, servedFrom: capped ? fromQ : null, full, spanCapDays };
}

/** Bar seconds of the ROW resolution. */
function rowBarSec(w: ServeWindow): number {
  return (parseInt(w.rowRes, 10) || 5) * 60;
}

/** Could the window hold more rows than the row cap? Only then must the route run the
 *  OFFSET cap-row query (7–30 ms on the main thread). */
export function rowCapCheckNeeded(w: ServeWindow): boolean {
  if (w.fromQ <= 0) return true;
  return (w.toQ - w.fromQ) / rowBarSec(w) > SERVE_ROW_CAP[w.rowRes];
}

/** Raise the window to the row-cap floor (timestamp of the cap-th newest row), hour-floored —
 *  the pre-2026-09-24 no-`from` behaviour, now applied whatever the caller sent. */
export function applyRowCapFloor(w: ServeWindow, capRowTs: number | null | undefined): ServeWindow {
  if (capRowTs == null || !Number.isFinite(capRowTs) || capRowTs <= 0) return w;
  const floor = hourFloor(capRowTs);
  if (floor <= w.fromQ) return w;
  return { ...w, fromQ: floor, capped: true, servedFrom: floor };
}

/** Shared-body cache key: exactly the SQL bounds + the capped flag (echoed in the body). */
export function serveCacheKey(sym: string, w: ServeWindow): string {
  return `${sym}:continuous:${w.interval}:${w.fromQ}:${w.toQ}:${w.capped ? "c" : "u"}`;
}

export interface DayZonesWindow { fromTs: number; toTs: number; capped: boolean; servedFrom: number | null }

/** GET /api/yellowbox/day-zones window: to = a valid `toTs` or now; from = a valid `fromTs`
 *  (default: the old 730-day window), raised to toTs − DAY_ZONES_MAX_SPAN_DAYS. */
export function resolveDayZonesWindow(q: { fromTs?: unknown; toTs?: unknown }, nowSec: number): DayZonesWindow {
  const toTs = parseEpochParam(q.toTs) ?? nowSec;
  const fromReq = parseEpochParam(q.fromTs) ?? nowSec - 730 * DAY;
  const floor = toTs - DAY_ZONES_MAX_SPAN_DAYS * DAY;
  const capped = fromReq < floor;
  const fromTs = capped ? floor : fromReq;
  return { fromTs, toTs, capped, servedFrom: capped ? fromTs : null };
}
