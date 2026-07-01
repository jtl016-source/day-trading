// shared/firing/session.ts
// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL session / time helpers — extracted VERBATIM from market.tsx.
// Pure functions of a unix-seconds timestamp. Safe in both browser and Node
// (uses Intl.DateTimeFormat, available in every modern runtime).
//
// STATUS: extraction slice 1 (foundation). Faithful copy — no behavior change.
// The RTH/ETH definition here MUST stay identical to CLAUDE.md's canonical rule:
//   RTH = Mon–Fri 9:30 AM – 5:00 PM ET; settlement break 4:30–6:00 PM ET.
// ─────────────────────────────────────────────────────────────────────────────

// Reuse single Intl formatters — creating one per call is very expensive in hot loops.
const _rthWeekdayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
const _etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
});

/** RTH — Mon–Fri, 9:30 AM – 5:00 PM ET (DST-safe via Intl, per CLAUDE.md). */
export function isRTH(timestampSec: number): boolean {
  const parts = _rthWeekdayFmt.formatToParts(new Date(timestampSec * 1000));
  const wd = parts.find(p => p.type === "weekday")?.value ?? "";
  if (wd === "Sat" || wd === "Sun") return false;
  const h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 17 * 60; // 9:30 AM – 5:00 PM ET
}

/** CME ES/MES settlement break: 4:30pm–6:00pm ET — no signals should fire here. */
export function isMarketBreak(timestampSec: number): boolean {
  const d = new Date(timestampSec * 1000);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return false;
  const et = _etFmt.format(d);
  const col = et.indexOf(":");
  const etMins = parseInt(et.slice(0, col)) * 60 + parseInt(et.slice(col + 1));
  return etMins >= 16 * 60 + 30 && etMins < 18 * 60;
}

/** User rule: no signals at or after 3:15 PM ET — too risky into the RTH close. */
export function isAfter315ET(timestampSec: number): boolean {
  const et = _etFmt.format(new Date(timestampSec * 1000));
  const col = et.indexOf(":");
  const etMins = parseInt(et.slice(0, col)) * 60 + parseInt(et.slice(col + 1));
  return etMins >= 15 * 60 + 15; // 3:15 PM ET
}

/** Unix ts of 21:00 UTC (RTH close) on the same calendar day as `ts`. */
export function rthCloseOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 21 * 3600;
}
/** Unix ts of 20:30 UTC (4:30 PM EDT / CME settlement) on the same calendar day as `ts`. */
export function rthSettleOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 20 * 3600 + 30 * 60;
}
/** Unix ts of 13:30 UTC (9:30 AM ET / RTH open) on the same calendar day as `ts`. */
export function rthOpenOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 13 * 3600 + 30 * 60;
}
