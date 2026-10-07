/**
 * CANDLE WINDOW (2026-09-24 — "the chart isn't loading correctly"): pure helpers that decide
 * which `from` the web chart pages ask /api/data/cached-continuous for. No React, no fetch —
 * unit-tested in scripts/cached-continuous-cap.test.ts.
 *
 * What went wrong: market.tsx (visible classic page AND the always-mounted hidden engine page)
 * derived `fromTs` from scrubber indices initialised to 0..59 and corrected only in an effect,
 * so the render in which /api/data/cached-days landed asked for the FIRST cached day
 * (2019-08-04 → 248 MB of 1m, twice), and before that a 730-day fallback (71 MB, twice).
 * Rules here:
 *   • resolveDayRange — an unsettled / stale scrubber window is the LAST `windowSize` days,
 *     never days[0..]: the first render already asks for the intended window.
 *   • windowStartTs — while cached-days is loading the window is 0 (= queries disabled); the
 *     fallback (cached-days failed / empty) is a short 10-day window.
 *   • cappedFromTs — every per-interval fetch is capped regardless of the scrubber:
 *     1m ≤ 14 d, 5m ≤ 90 d, 15m ≤ 400 d, 60m unlimited (the server enforces its own, looser
 *     caps — server/serve-window.ts — so a client-capped request is never re-clamped).
 *   • windowQueryPlan (C2) — ONE react-query key per URL: the main chart query, the vector
 *     secondaries and the background-signal windows are all keyed by windowQueryKey over the
 *     SAME per-resolution `from`, share WINDOW_QUERY_OPTIONS, and bg15m is derived from the 5m
 *     entry (bg15mFrom5m) instead of a second /5m fetch.
 */
import { agg5mTo15m, type LiveCandle } from "@shared/live-adapter";

export type CandleInterval = "1m" | "5m" | "15m" | "60m";

const HOUR = 3600;
const DAY = 86400;
const hourFloor = (t: number): number => Math.floor(t / HOUR) * HOUR;

/** Max calendar days a web chart fetch may span per interval. */
export const CLIENT_WINDOW_CAP_DAYS: Record<CandleInterval, number> = { "1m": 14, "5m": 90, "15m": 400, "60m": Infinity };

/** Window used only when cached-days failed or has no days for the symbol. */
export const FALLBACK_WINDOW_DAYS = 10;

/** The scrubber's effective day-index range. `settled` = the indices were set for the current
 *  (symbol, day count, window size). Unsettled or out-of-range indices → the default window
 *  (last `windowSize` days). null when there are no days. */
export function resolveDayRange(
  total: number, windowSize: number, startIdx: number, endIdx: number, settled: boolean,
): { start: number; end: number } | null {
  if (!(total > 0)) return null;
  const ws = Math.max(1, Math.floor(Number.isFinite(windowSize) ? windowSize : 1));
  const valid = settled && Number.isInteger(startIdx) && Number.isInteger(endIdx) &&
    startIdx >= 0 && endIdx >= startIdx && endIdx < total;
  if (valid) return { start: startIdx, end: endIdx };
  const end = total - 1;
  return { start: Math.max(0, end - ws + 1), end };
}

export type DaysState = "loading" | "ready" | "empty";

/** cached-days query → window state. Data present wins (a background refetch keeps "ready"). */
export function daysStateOf(q: { loading: boolean; error: boolean; count: number }): DaysState {
  if (q.count > 0) return "ready";
  if (q.loading && !q.error) return "loading";
  return "empty";
}

/** Window start (epoch sec) or 0 = not ready (every candle query stays disabled). */
export function windowStartTs(state: DaysState, firstDayTs: number | null, nowSec: number): number {
  if (state === "loading") return 0;
  if (state === "ready") return firstDayTs != null && firstDayTs > 0 ? firstDayTs : 0;
  return hourFloor(nowSec - FALLBACK_WINDOW_DAYS * DAY);
}

/** The interval's fetch `from`: the window start raised to (to − cap), hour-floored so the key
 *  and the server's hour-floored `from` agree. 0 (not ready) stays 0. */
export function cappedFromTs(fromTs: number, toTs: number, interval: CandleInterval): number {
  if (!(fromTs > 0)) return 0;
  const cap = CLIENT_WINDOW_CAP_DAYS[interval] ?? Infinity;
  if (!Number.isFinite(cap)) return fromTs;
  return Math.max(fromTs, hourFloor(toTs - cap * DAY));
}

/** Small UI hint when the scrubber window is wider than the interval's cap. */
export function windowCapHint(fromTs: number, toTs: number, interval: CandleInterval): string | null {
  if (!(fromTs > 0)) return null;
  if (cappedFromTs(fromTs, toTs, interval) === fromTs) return null;
  return `window capped to ${CLIENT_WINDOW_CAP_DAYS[interval]} days for ${interval}`;
}

/** Query string for the terminal's lazy deep-history load: `full=1` for 15m / 60m (the server
 *  honors it only there), otherwise the capped window requested explicitly. */
export function terminalDeepHistoryQuery(interval: string, nowSec: number): string {
  if (interval === "15m" || interval === "60m") return "full=1";
  const iv: CandleInterval = interval === "1m" ? "1m" : "5m";
  return `from=${hourFloor(nowSec - CLIENT_WINDOW_CAP_DAYS[iv] * DAY)}`;
}

// ═════ C2 (2026-09-24/25): ONE react-query entry per cached-continuous URL ═════

/** Query-key root of every cached-continuous window (refreshRangedFrom / invalidations match on it). */
export const CONTINUOUS_QUERY_ROOT = "/api/data/cached-continuous" as const;

/** [root, symbol, interval, from, to] — react-query hashes the key, so two observers of the same
 *  URL MUST build the identical tuple (no suffixes): then they share one fetch + one cache entry.
 *  refreshRangedFrom reads key[2..4] as interval / from / to. */
export type WindowQueryKey = readonly [typeof CONTINUOUS_QUERY_ROOT, string, CandleInterval, number, number];
export function windowQueryKey(symbol: string, interval: CandleInterval, from: number, to: number): WindowQueryKey {
  return [CONTINUOUS_QUERY_ROOT, symbol, interval, from, to] as const;
}

/** Shared observer options for EVERY window query. Observers of one key share one Query, and
 *  query-core applies each observer's options to it (the last one set wins), so a background
 *  observer with the default `retry: 3` silently changed the main chart query's fail-fast
 *  behaviour on the same key — identical options on every observer make that impossible.
 *  Fail fast: the chart shows candleError at once and the Refresh button / data_updated
 *  invalidations refetch; staleTime Infinity keeps instant interval switches from the cache. */
export const WINDOW_QUERY_OPTIONS = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

/** The main query's resolution for a view interval (the server serves 15m natively, falls back to 5m aggregation). */
export function fetchIntervalFor(viewInterval: string): CandleInterval {
  return viewInterval === "60m" ? "60m" : viewInterval === "1m" ? "1m" : viewInterval === "15m" ? "15m" : "5m";
}

export interface WindowQuery { key: WindowQueryKey; from: number; enabled: boolean }
export interface WindowQueryPlan {
  /** Per-resolution fetch `from` (cappedFromTs over the one window start) — ONE value per resolution. */
  froms: Record<CandleInterval, number>;
  fetchInterval: CandleInterval;
  main: WindowQuery;
  /** Shared 1m entry: the vector secondary (raw1m) and the background 1m pass (bg1m). */
  q1m: WindowQuery & { rawEnabled: boolean; bgEnabled: boolean };
  /** Shared 60m entry: the vector secondary (raw60m) and the background 60m pass (bg60m). */
  q60m: WindowQuery & { rawEnabled: boolean; bgEnabled: boolean };
  /** Background 5m entry — also the source of the derived background 15m bars. */
  q5m: WindowQuery;
  /** true = bg15m is agg5mTo15m over the q5m entry (every view but 15m, where the main query IS 15m). */
  bg15mFrom5m: boolean;
}

/** Every cached-continuous window query market.tsx runs, keyed so each URL has exactly one entry.
 *  Consumers gate their view of a shared entry by their own `rawEnabled` / `bgEnabled` (a
 *  disabled observer still READS the shared cache entry). */
export function windowQueryPlan(p: {
  symbol: string; viewInterval: string; showVector: boolean; fromTs: number; toTs: number;
}): WindowQueryPlan {
  const froms: Record<CandleInterval, number> = {
    "1m": cappedFromTs(p.fromTs, p.toTs, "1m"),
    "5m": cappedFromTs(p.fromTs, p.toTs, "5m"),
    "15m": cappedFromTs(p.fromTs, p.toTs, "15m"),
    "60m": cappedFromTs(p.fromTs, p.toTs, "60m"),
  };
  const ready = (iv: CandleInterval): boolean => froms[iv] > 0 && p.toTs > 0;
  const fetchInterval = fetchIntervalFor(p.viewInterval);
  const q = (iv: CandleInterval, enabled: boolean): WindowQuery =>
    ({ key: windowQueryKey(p.symbol, iv, froms[iv], p.toTs), from: froms[iv], enabled: enabled && ready(iv) });
  const raw1m = p.showVector && fetchInterval !== "1m";
  const bg1m = p.viewInterval !== "1m";
  const raw60m = p.showVector && fetchInterval !== "60m";
  const bg60m = p.viewInterval !== "60m";
  return {
    froms,
    fetchInterval,
    main: q(fetchInterval, true),
    q1m: { ...q("1m", raw1m || bg1m), rawEnabled: raw1m, bgEnabled: bg1m },
    q60m: { ...q("60m", raw60m || bg60m), rawEnabled: raw60m, bgEnabled: bg60m },
    q5m: q("5m", true),
    bg15mFrom5m: p.viewInterval !== "15m",
  };
}

/** Background 15m bars: agg5mTo15m over the shared 5m entry (undefined on the 15m view, where
 *  the main native-15m query feeds the 15m pass, and while the 5m entry is not loaded). */
export function bg15mFrom5mData<C extends LiveCandle>(
  viewInterval: string, bg5mData: { candles?: C[] } | undefined,
): { candles: C[] } | undefined {
  if (viewInterval === "15m" || !bg5mData) return undefined;
  return { ...bg5mData, candles: agg5mTo15m(bg5mData.candles ?? []) };
}
