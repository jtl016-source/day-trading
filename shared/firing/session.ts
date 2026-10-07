// shared/firing/session.ts
// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL session / time helpers — extracted VERBATIM from market.tsx.
// Pure functions of a unix-seconds timestamp. Safe in both browser and Node
// (uses Intl.DateTimeFormat, available in every modern runtime).
//
// The RTH/ETH definition here MUST stay identical to CLAUDE.md's canonical rule:
//   RTH = Mon–Fri 9:30 AM – 5:00 PM ET; settlement break 5:00–6:00 PM ET.
// (Updated 2026-07-13 with the new signal model: RTH close & settle moved 4:30 PM → 5:00 PM ET;
//  break window moved 4:30–6:00 → 5:00–6:00 PM ET; rthSettleOfDay is now DST-safe.)
// ─────────────────────────────────────────────────────────────────────────────

// ── FAST ET CLOCK (2026-07-30 perf) ──────────────────────────────────────────
// Cached UTC→ET offset per UTC-HOUR bucket. America/New_York DST transitions always land
// exactly on a whole UTC hour (2:00 AM local = 06:00 or 07:00 UTC), so the offset is constant
// within any UTC-hour bucket. Intl stays the single source of truth (NEVER hardcode offsets,
// per CLAUDE.md): each bucket is computed ONCE through the formatter below, then reused as
// pure arithmetic. This turns the per-row session checks (validateSignalRow over thousands of
// signal_history rows per GET, engine hot loops) from ~50–200µs Intl format calls into map
// lookups — the GET /api/signals/history read filter dropped from ~40ms to ~2ms per 2.6k rows.
const _etOffsetFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const _etOffsetByHour = new Map<number, number>();
function etOffsetSec(tsSec: number): number {
  const bucket = Math.floor(tsSec / 3600);
  let off = _etOffsetByHour.get(bucket);
  if (off === undefined) {
    const p = _etOffsetFmt.formatToParts(new Date(bucket * 3600 * 1000));
    const g = (t: string) => Number(p.find(x => x.type === t)?.value ?? 0);
    // hour12:false can yield "24" at midnight depending on the ICU hourCycle — normalize.
    const wallUtcSec = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) / 1000;
    off = wallUtcSec - bucket * 3600; // seconds to ADD to a UTC ts to get the ET wall clock
    if (_etOffsetByHour.size > 200_000) _etOffsetByHour.clear(); // ~23 years of hours — bound memory
    _etOffsetByHour.set(bucket, off);
  }
  return off;
}
/** ET wall clock of a unix-seconds ts: ET weekday (0=Sun..6=Sat) + minutes since ET midnight.
 *  DST-safe (offset resolved via Intl per UTC hour, see above). */
export function etWallClock(tsSec: number): { wd: number; mins: number } {
  const local = tsSec + etOffsetSec(tsSec);
  const day = Math.floor(local / 86400);
  return { wd: (day + 4) % 7, mins: Math.floor((local - day * 86400) / 60) }; // epoch day 0 = Thu(4)
}

// DST-safe ET calendar-day formatter — used to anchor session times to the correct wall clock.
const _etDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
// Hour verifier for etWallOfDay — hoisted to module scope (was constructed per call, ~ms-scale).
const _etHourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", hour12: false,
});
/** Unix seconds of a given ET wall-clock time (h:min) on the ET calendar day of `ts`.
 *  DST-safe: assumes EDT (UTC-4), verifies against the real ET hour, falls back to EST (UTC-5). */
function etWallOfDay(ts: number, h: number, min: number): number {
  const [y, mo, d] = _etDayFmt.format(new Date(ts * 1000)).split("-").map(Number);
  const edt = Date.UTC(y, mo - 1, d, h + 4, min, 0) / 1000; // try EDT
  const wallH = Number(_etHourFmt.format(new Date(edt * 1000)));
  return wallH === h ? edt : Date.UTC(y, mo - 1, d, h + 5, min, 0) / 1000; // else EST
}

/** Globex SESSION-DAY ordinal of a unix-seconds ts (fast, DST-safe via the cached ET offset).
 *  A session day starts at 6:00 PM ET the prior evening (CME reopen) — all bars from Sun 18:00
 *  ET through Mon 17:00 ET share Monday's bucket, etc. Used by the risk-display DEAD-TAPE flag
 *  to fold a running session-day realized range inside the engine loop (2026-07-30); the exact
 *  integer value is meaningless — only equality between two timestamps matters. */
export function etSessionDayBucket(tsSec: number): number {
  const local = tsSec + etOffsetSec(tsSec);
  return Math.floor((local - 18 * 3600) / 86400) + 1; // +1: post-18:00 bars belong to the NEXT ET day
}

/** RTH — Mon–Fri, 9:30 AM – 5:00 PM ET (DST-safe via the cached ET clock, per CLAUDE.md). */
export function isRTH(timestampSec: number): boolean {
  const { wd, mins } = etWallClock(timestampSec);
  if (wd === 0 || wd === 6) return false; // Sun/Sat (ET weekday, as before)
  return mins >= 9 * 60 + 30 && mins < 17 * 60; // 9:30 AM – 5:00 PM ET
}

/** CME ES/MES daily maintenance halt: 5:00pm–6:00pm ET — no signals should fire here. */
export function isMarketBreak(timestampSec: number): boolean {
  // UTC weekday check preserved VERBATIM from the original (it used getUTCDay, not ET weekday).
  const utcDay = (Math.floor(timestampSec / 86400) + 4) % 7; // epoch day 0 = Thu(4)
  if (utcDay === 0 || utcDay === 6) return false;
  const { mins } = etWallClock(timestampSec);
  return mins >= 17 * 60 && mins < 18 * 60; // 5:00–6:00 PM ET
}

/** User rule: no signals at or after 3:15 PM ET — too risky into the RTH close. */
export function isAfter315ET(timestampSec: number): boolean {
  return etWallClock(timestampSec).mins >= 15 * 60 + 15; // 3:15 PM ET
}

/** Unix ts of the 5:00 PM ET RTH close on the ET calendar day of `ts` (DST-safe). */
export function rthCloseOfDay(ts: number): number {
  return etWallOfDay(ts, 17, 0);
}
/** Unix ts of the 5:00 PM ET session settle / force-close on the ET calendar day of `ts`
 *  (DST-safe). Moved 4:30 PM → 5:00 PM ET with the new signal model; the walk-forward and all
 *  milk-zone session windows force-close here. */
export function rthSettleOfDay(ts: number): number {
  return etWallOfDay(ts, 17, 0);
}
/** Unix ts of the 9:30 AM ET RTH open on the ET calendar day of `ts` (DST-safe). */
export function rthOpenOfDay(ts: number): number {
  return etWallOfDay(ts, 9, 30);
}
