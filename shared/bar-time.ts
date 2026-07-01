/**
 * Single source of truth for "is this bar timestamp sane?".
 * Rejects corrupt rows that have no business in the candle store:
 *   - non-finite / non-positive
 *   - before 2010-01-01 (1262304000)  → bad filename / parse
 *   - more than 36h in the future       → corrupt (allows clock skew + the forming bar)
 * `sec` is a UNIX timestamp in SECONDS.
 */
export function isSaneBarTime(sec: number, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  if (!Number.isFinite(sec) || sec <= 0) return false;
  if (sec < 1_262_304_000) return false;
  if (sec > nowSec + 36 * 3600) return false;
  return true;
}

/**
 * Canonical WRITE-TIME candle guard. Returns true only if the bar is safe to persist.
 * Applied by every ingestion path (persistBar / persistBulk / bulk_bars / mw-reader bulkUpsert)
 * right before the DB insert/upsert so malformed, off-grid, and "ghost" (V0) rows never enter the
 * candle store. This is the durable write-side complement to the read-time `dropWickSpikes` filter.
 *
 * Rules (mirrors the intended `validate_candle` logic):
 *   1. Reject null/undefined/non-finite O/H/L/C.
 *   2. Reject ghost bars: volume null/undefined/0.
 *   3. Reject corrupt prices: any O/H/L/C <= 0, or OHLC inconsistency (h<l, o/c outside [l,h]).
 *   4. Off-grid: timestamp not aligned to the resolution bucket (opts.resSec) — the source of the
 *      stray off-grid V0 rows.
 *   5. Coarse spike backstop: (high-low)/open beyond opts.maxDeviation (default 0.10). Deliberately
 *      GENEROUS — write-time drops are permanent, so precise per-interval spike removal is left to
 *      the reversible read-time filter; this only blocks gross float32 corruption.
 */
export function validateBar(
  b: { open?: number | null; high?: number | null; low?: number | null; close?: number | null; volume?: number | null; time?: number },
  opts: { resSec?: number; maxDeviation?: number } = {},
): boolean {
  const { open, high, low, close, volume } = b;
  // 1. presence + finiteness
  if (open == null || high == null || low == null || close == null) return false;
  if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return false;
  // 2. ghost bar — zero/absent volume
  if (volume == null || volume === 0) return false;
  // 3. corrupt / inconsistent prices
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return false;
  if (high < low || open > high || open < low || close > high || close < low) return false;
  // 4. off-grid timestamp (only when resolution + time provided)
  if (opts.resSec && opts.resSec > 0 && b.time != null && b.time % opts.resSec !== 0) return false;
  // 5. coarse spike backstop
  const maxDev = opts.maxDeviation ?? 0.10;
  if (Math.abs(high - low) / open > maxDev) return false;
  return true;
}
