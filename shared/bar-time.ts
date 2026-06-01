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
