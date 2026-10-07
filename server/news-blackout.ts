/**
 * SCHEDULED-NEWS BLACKOUT (2026-10-01, owner-approved R3 of docs/eth-trading-research-2026-10-01.md).
 *
 * 8:30 / 10:00 ET releases are jump events (NY Fed SR 917 / Liberty Street: ~40 % of the move is
 * informed drift in the 30 min BEFORE the print; our own 8:30 1m bar p90 = 20.75 pts ≈ a stop).
 * The approved rule, per ET calendar day, applied to every event on that day:
 *   08:30 print          → blackout 08:25–08:40 ET
 *   10:00 print          → blackout 09:55–10:05 ET
 *   FOMC statement 14:00 → blackout 13:55–14:30 ET (covers the 14:30 press-conference start)
 * Windows are half-open [from, to) in ET WALL time — converted to unix seconds through Intl per
 * calendar day (DST-safe; never a hard-coded UTC offset, per CLAUDE.md).
 *
 * WHAT IT GATES (live): ORDERS via trade-state.orderHoursGateReason() when
 * tradeSettings.newsBlackoutEnabled (default TRUE), and fire ALERTS (POST /api/discord/send →
 * {ok:true, muted:"news"}). Signals/records are NEVER suppressed — the engine-level
 * NEWS_BLACKOUT (fact-engine, Area C) is a separate research switch and stays OFF.
 *
 * SOURCE: data/news-calendar.json (official agency schedules — see its `sources`). Cached and
 * re-read only when the file's mtime changes (one statSync per call at most every 5 s), so an
 * edited calendar takes effect without a restart. A missing/corrupt file = no blackouts
 * (logged once, and shouted every morning by the digest's "News calendar:" line +
 * integrity-check N1 via newsCalendarHealth()). `window` [from, to] is the COMPLETE range —
 * every approved release in it is in events[]; days outside it report `covered:false` on
 * GET /api/news/blackouts even when a few already-published later events (e.g. a January FOMC,
 * up to `partialThrough`) still derive windows.
 */
import fs from "fs";
import path from "path";
import { isRTH } from "@shared/firing/session";
import { SIGNAL_INTERVAL_SEC } from "@shared/signal-rules";

export interface NewsEvent { date: string; timeET: string; event: string; source?: string; tier?: number; ref?: string }
export interface NewsCalendar {
  version?: number;
  window?: { from?: string; to?: string };
  events: NewsEvent[];
  [k: string]: unknown;
}
export interface BlackoutWindow {
  date: string;        // ET calendar day YYYY-MM-DD
  printET: string;     // "08:30" | "10:00" | "14:00"
  fromET: string;      // ET wall "HH:MM" (inclusive)
  toET: string;        // ET wall "HH:MM" (exclusive)
  fromSec: number;     // unix seconds
  toSec: number;       // unix seconds (exclusive)
  events: string[];    // event names printing at printET that day
  reason: string;      // "news blackout: CPI 08:30"
}

/** The approved rule (2026-10-01). FOMC only blacks out when an FOMC event prints at 14:00.
 *  AUTHORITATIVE: this literal is what the live gate applies. The calendar file's
 *  `blackoutRules` block is INFORMATIONAL (a human-readable copy) — deriveWindows never reads
 *  it, so editing the JSON's rules changes nothing live. calendarRulesMatch() compares the two;
 *  scripts/news-calendar-data.test.ts, newsCalendarHealth() (digest) and integrity-check N1
 *  flag any disagreement so the copy cannot silently drift from the rule in force. */
export const BLACKOUT_RULES: ReadonlyArray<Readonly<{ print: string; from: string; to: string; fomcOnly?: boolean }>> = [
  { print: "08:30", from: "08:25", to: "08:40" },
  { print: "10:00", from: "09:55", to: "10:05" },
  { print: "14:00", from: "13:55", to: "14:30", fomcOnly: true },
];
const RULES = BLACKOUT_RULES;
/** Print times the rule set knows. An event at any other time derives NO window. */
export const KNOWN_PRINT_TIMES: ReadonlySet<string> = new Set(BLACKOUT_RULES.map(r => r.print));

// ── calendar cache ─────────────────────────────────────────────────────────────
let _path = process.env.NEWS_CALENDAR_PATH
  ? path.resolve(process.env.NEWS_CALENDAR_PATH)
  : path.join(process.cwd(), "data", "news-calendar.json");
let _cal: NewsCalendar | null = null;
let _mtimeMs = -1;
let _lastStatMs = 0;
let _warned = false;
const STAT_EVERY_MS = 5_000;

/** TEST SEAM: point the loader at another calendar file (resets the cache). */
export function setNewsCalendarPath(p: string): void {
  _path = path.resolve(p); _cal = null; _mtimeMs = -1; _lastStatMs = 0; _warned = false;
}

/** The current calendar (cached; re-read when the file's mtime changes). null = unavailable. */
export function loadNewsCalendar(): NewsCalendar | null {
  const now = Date.now();
  if (_cal && now - _lastStatMs < STAT_EVERY_MS) return _cal;
  _lastStatMs = now;
  try {
    const st = fs.statSync(_path);
    if (_cal && st.mtimeMs === _mtimeMs) return _cal;
    const parsed = JSON.parse(fs.readFileSync(_path, "utf8")) as NewsCalendar;
    if (!parsed || !Array.isArray(parsed.events)) throw new Error("no events[]");
    _cal = parsed; _mtimeMs = st.mtimeMs; _warned = false;
    return _cal;
  } catch (e: any) {
    if (!_warned) { console.warn(`[news-blackout] calendar unavailable (${_path}): ${e?.message} — no news blackouts in force`); _warned = true; }
    _cal = null; _mtimeMs = -1;
    return null;
  }
}

// ── ET wall-clock helpers (Intl only) ──────────────────────────────────────────
const _etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function etParts(sec: number): { date: string; mins: number } {
  const p = _etFmt.formatToParts(new Date(sec * 1000));
  const g = (t: string): string => p.find(x => x.type === t)?.value ?? "00";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, mins: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
}
/** ET calendar day (YYYY-MM-DD) of a unix-seconds ts. */
export function etDateOf(sec: number): string { return etParts(sec).date; }

const hhmm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/** Unix seconds of ET wall time `HH:MM` on ET day `date` — DST-safe: try EDT (UTC-4) then EST
 *  (UTC-5) and keep the one Intl confirms. null for a malformed input. */
export function etWallToUnix(date: string, time: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  const tm = hhmm(time);
  if (!dm || tm == null) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  for (const off of [4, 5]) {
    const sec = Date.UTC(y, mo - 1, d, Math.floor(tm / 60) + off, tm % 60, 0) / 1000;
    const p = etParts(sec);
    if (p.date === date && p.mins === tm) return sec;
  }
  return null;
}

/** PURE derivation of one ET day's windows from a calendar (exported for tests). */
export function deriveWindows(cal: NewsCalendar | null, dateET: string): BlackoutWindow[] {
  if (!cal || !Array.isArray(cal.events)) return [];
  const todays = cal.events.filter(e => e && e.date === dateET);
  const out: BlackoutWindow[] = [];
  for (const r of RULES) {
    const names = todays
      .filter(e => hhmm(e.timeET) === hhmm(r.print))
      .filter(e => !r.fomcOnly || /fomc/i.test(String(e.event ?? "")))
      .map(e => String(e.event ?? "event"));
    if (!names.length) continue;
    const fromSec = etWallToUnix(dateET, r.from), toSec = etWallToUnix(dateET, r.to);
    if (fromSec == null || toSec == null) continue;
    const uniq = [...new Set(names)];
    out.push({
      date: dateET, printET: r.print, fromET: r.from, toET: r.to, fromSec, toSec, events: uniq,
      reason: `news blackout: ${uniq.join(" + ")} ${r.print}`,
    });
  }
  return out;
}

/** The ET day's blackout windows from the live calendar. */
export function windowsForDay(dateET: string): BlackoutWindow[] {
  return deriveWindows(loadNewsCalendar(), dateET);
}

/** Every window the calendar defines (small: ~25 days) — for client-side row badging. */
export function allWindows(): BlackoutWindow[] {
  const cal = loadNewsCalendar();
  if (!cal) return [];
  const days = [...new Set(cal.events.map(e => e?.date).filter((d): d is string => typeof d === "string"))].sort();
  return days.flatMap(d => deriveWindows(cal, d));
}

/** The window containing `sec`, or null. */
export function blackoutWindowAt(sec: number, cal: NewsCalendar | null = loadNewsCalendar()): BlackoutWindow | null {
  if (!Number.isFinite(sec)) return null;
  for (const w of deriveWindows(cal, etDateOf(sec))) if (sec >= w.fromSec && sec < w.toSec) return w;
  return null;
}

/** "news blackout: CPI 08:30" inside a window, else null. */
export function blackoutReason(nowSec: number): string | null {
  return blackoutWindowAt(nowSec)?.reason ?? null;
}

/** Does the calendar COMPLETELY cover ET day `dateET` — i.e. every approved release that could
 *  print that day is in events[]? `window` is the COMPLETE range [from, to] (2026-10-01 fix:
 *  window.to was 2027-01-31 while 8 of 9 January prints were unpublished, so January reported
 *  covered:true with only FOMC protected). Events after window.to (up to `partialThrough`) are
 *  real, already-published dates and still derive windows, but those days are NOT "covered".
 *  Days before window.from are not covered either. false = no complete schedule for the day. */
export function calendarCovers(dateET: string, cal: NewsCalendar | null = loadNewsCalendar()): boolean {
  const from = cal?.window?.from, to = cal?.window?.to;
  if (typeof to !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateET ?? ""))) return false;
  if (typeof from === "string" && dateET < from) return false;
  return dateET <= to;
}

/** Does the calendar file's informational `blackoutRules` block say exactly what the
 *  authoritative BLACKOUT_RULES literal applies? (order-insensitive; FOMC-only rule <=> a rule
 *  carrying `event: "FOMC"`). A missing block counts as a mismatch. */
export function calendarRulesMatch(cal: NewsCalendar | null): boolean {
  const br = (cal as { blackoutRules?: { rules?: unknown } } | null)?.blackoutRules?.rules;
  if (!Array.isArray(br)) return false;
  const key = (print: string, from: string, to: string, fomc: boolean): string => `${print}|${from}|${to}|${fomc ? "FOMC" : ""}`;
  const fileKeys = br.map((r: any) => key(String(r?.printTimeET ?? ""), String(r?.blackoutFromET ?? ""), String(r?.blackoutToET ?? ""),
    /fomc/i.test(String(r?.event ?? "")))).sort();
  const codeKeys = BLACKOUT_RULES.map(r => key(r.print, r.from, r.to, !!r.fomcOnly)).sort();
  return JSON.stringify(fileKeys) === JSON.stringify(codeKeys);
}

export interface NewsCalendarHealth {
  ok: boolean;
  problems: string[];          // each one is a reason the blackout may NOT protect upcoming days
  coveredThrough: string | null;
  daysLeft: number | null;     // calendar days from todayET to window.to (negative = expired)
  eventsNext30: number;
  next: { date: string; timeET: string; event: string } | null;
}
const _dayNum = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400_000;
const _isoPlus = (iso: string, days: number): string => new Date((_dayNum(iso) + days) * 86400_000).toISOString().slice(0, 10);
/** STALENESS / INTEGRITY ALARM for the shipped calendar (daily digest + integrity-check N1).
 *  The server fails OPEN on a bad calendar (no blackout), so these conditions must be shouted:
 *  missing/unreadable file, window.to in the past or within `warnDays`, no event in the next
 *  30 days, an event at a time the rule set does not know (it would derive no window), and the
 *  file's informational rules disagreeing with the authoritative literal. PURE given `cal`. */
export function newsCalendarHealth(todayET: string, cal: NewsCalendar | null = loadNewsCalendar(), warnDays = 14): NewsCalendarHealth {
  const problems: string[] = [];
  if (!cal || !Array.isArray(cal.events)) {
    return { ok: false, problems: [`calendar missing/unreadable (${_path}) — NO news blackout is in force`], coveredThrough: null, daysLeft: null, eventsNext30: 0, next: null };
  }
  const to = typeof cal.window?.to === "string" ? cal.window.to : null;
  const daysLeft = to ? Math.round(_dayNum(to) - _dayNum(todayET)) : null;
  if (!to || daysLeft == null || !Number.isFinite(daysLeft)) problems.push("calendar has no valid window.to — coverage unknown");
  else if (daysLeft < 0) problems.push(`calendar EXPIRED: covered through ${to} — no complete schedule for today; refresh data/news-calendar.json (docs/news-calendar-README.md)`);
  else if (daysLeft <= warnDays) problems.push(`calendar covered only through ${to} (${daysLeft} day(s) left) — refresh data/news-calendar.json`);
  const horizon = _isoPlus(todayET, 30);
  const upcoming = cal.events
    .filter(e => e && typeof e.date === "string" && e.date >= todayET && e.date <= horizon)
    .sort((a, b) => (a.date + a.timeET).localeCompare(b.date + b.timeET));
  if (!upcoming.length) problems.push(`no scheduled print in the next 30 days (${todayET}..${horizon}) — the calendar is stale or empty`);
  const unknownTimes = cal.events.filter(e => e && !KNOWN_PRINT_TIMES.has(String(e.timeET ?? "")));
  if (unknownTimes.length) problems.push(`${unknownTimes.length} event(s) at a time no rule covers (e.g. ${unknownTimes[0].date} "${unknownTimes[0].timeET}" ${unknownTimes[0].event}) — they derive NO blackout`);
  if (!calendarRulesMatch(cal)) problems.push("the file's blackoutRules block differs from the rule in force (server/news-blackout.ts BLACKOUT_RULES governs) — fix the file's copy");
  const n = upcoming[0];
  return { ok: problems.length === 0, problems, coveredThrough: to, daysLeft, eventsNext30: upcoming.length, next: n ? { date: n.date, timeET: n.timeET, event: n.event } : null };
}
/** One digest line ("News calendar: OK — ..." / "News calendar: ⚠️ ..."). */
export function newsCalendarDigestLine(todayET: string, cal?: NewsCalendar | null): string {
  const h = newsCalendarHealth(todayET, cal === undefined ? loadNewsCalendar() : cal);
  const nxt = h.next ? `next ${h.next.event} ${h.next.date} ${h.next.timeET} ET` : "no print in 30 d";
  return h.ok
    ? `News calendar: OK — covered through ${h.coveredThrough} (${h.daysLeft} d), ${h.eventsNext30} print(s) in 30 d, ${nxt}`
    : `News calendar: ⚠️ ${h.problems.join(" · ")}${h.next ? ` (${nxt})` : ""}`;
}

// ── ALERT MUTE DECISION (R2a + R3) ─────────────────────────────────────────────
/** Session of a fire, classified at the bar's CLOSE (timestamp + interval) exactly like the
 *  engine (fact-engine: `isRTH(closeTime)`) — America/New_York via shared/firing/session. */
export function fireCloseSec(timestampSec: number, interval: string | null | undefined): number {
  return timestampSec + intervalSecOf(interval);
}
/** Bar length of a signal interval label. The engine's closed set first (SIGNAL_INTERVAL_SEC),
 *  then "<n>m" / "<n>h" (e.g. "30m", "1h", "4H") — an unknown label used to fall back to 0
 *  (close = open), mis-classifying e.g. a "1h" 08:30 bar as ETH at its open. Unparseable = 0. */
export function intervalSecOf(interval: string | null | undefined): number {
  const k = String(interval ?? "").trim();
  const known = SIGNAL_INTERVAL_SEC[k];
  if (known) return known;
  const m = /^(\d{1,4})\s*([mhMH])$/.exec(k);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2].toLowerCase() === "h" ? n * 3600 : n * 60;
}
export function isEthFire(timestampSec: number, interval: string | null | undefined): boolean {
  return !isRTH(fireCloseSec(timestampSec, interval));
}

export type AlertMute = "eth" | "news" | null;
/** Should a fire's alert (Discord / push) be muted?
 *  - "eth":  the fire closes in the ETH session and ethAlertsEnabled is false (record only).
 *  - "news": the fire closes inside a scheduled-news blackout and newsBlackoutEnabled is true.
 *  ETH is checked first (every 08:30 window is pre-open, i.e. ETH). `timestampSec` null/absent
 *  (an alert without a bar time) is classified at `nowSec` as its close. */
export function alertMuteReason(
  input: { timestampSec?: number | null; interval?: string | null; nowSec?: number },
  settings: { ethAlertsEnabled?: boolean; newsBlackoutEnabled?: boolean },
  cal?: NewsCalendar | null,
): AlertMute {
  const ts = Number(input.timestampSec);
  const close = Number.isFinite(ts) && ts > 0
    ? fireCloseSec(ts, input.interval)
    : (input.nowSec ?? Math.floor(Date.now() / 1000));
  if (settings.ethAlertsEnabled !== true && !isRTH(close)) return "eth";
  if (settings.newsBlackoutEnabled !== false && blackoutWindowAt(close, cal === undefined ? loadNewsCalendar() : cal)) return "news";
  return null;
}
