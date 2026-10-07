// scripts/news-calendar-data.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SHIPPED CALENDAR ITSELF (2026-10-01 verifier fix). scripts/news-blackout.test.ts runs
// the blackout LOGIC against a fixture; until this file existed NO test opened the real
// data/news-calendar.json, so deleting, corrupting or mis-dating it passed every suite while
// the server failed OPEN (no blackout). This test loads the REAL file (read-only) and fails on:
//   - missing / unparseable / empty events[]
//   - a weekend date, a malformed date, a duplicate (date, event), a bad tier
//   - a timeET that no rule covers (it would derive NO window) or an event deriving no window
//   - a month inside the COMPLETE window missing a monthly tier-1 print (CPI, Employment
//     Situation, PCE), or the window missing FOMC / GDP advance entirely
//   - rows after window.to that are not FOMC (window = complete coverage, see the README)
//   - the file's informational blackoutRules differing from server/news-blackout.ts BLACKOUT_RULES
//   - window.to in the past, or no scheduled print in the next 30 days  ← DELIBERATE TIME BOMB:
//     the suite goes red when the calendar needs its refresh (docs/news-calendar-README.md).
// Run: npx tsx scripts/news-calendar-data.test.ts [optional/other-calendar.json for mutation checks]
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as path from "node:path";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

const MONTHLY_TIER1 = ["CPI", "Employment Situation", "PCE"];
const WINDOW_TIER1 = ["FOMC", "GDP advance"]; // not monthly: at least once inside the window
const ALL_TIER1 = new Set([...MONTHLY_TIER1, ...WINDOW_TIER1]);

async function main() {
  const calPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(process.cwd(), "data", "news-calendar.json");
  // Never let an inherited NEWS_CALENDAR_PATH redirect this test away from the file under test.
  process.env.NEWS_CALENDAR_PATH = calPath;
  const nb = await import("../server/news-blackout");
  nb.setNewsCalendarPath(calPath);
  console.log(`── calendar under test: ${calPath}`);

  let raw: any = null;
  try { raw = JSON.parse(fs.readFileSync(calPath, "utf8")); } catch (e: any) { /* asserted below */ }
  assert(raw != null, `file exists and parses as JSON (${calPath})`);
  const events: any[] = Array.isArray(raw?.events) ? raw.events : [];
  assert(events.length >= 1, `events[] is non-empty (got ${events.length})`);
  const cal = nb.loadNewsCalendar();
  assert(cal != null && cal.events.length === events.length, "the server loader reads the same file (not null, same event count)");

  const from: string = raw?.window?.from, to: string = raw?.window?.to;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  assert(iso.test(String(from)) && iso.test(String(to)) && from <= to, `window {from:${from}, to:${to}} is a valid range`);
  const partial: string = typeof raw?.partialThrough === "string" ? raw.partialThrough : to;
  assert(iso.test(String(partial)) && partial >= to, `partialThrough (${partial}) >= window.to`);

  console.log("── per-event shape ──");
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const tag = `${e?.date} ${e?.timeET} ${e?.event}`;
    if (!iso.test(String(e?.date))) { bad.push(`${tag}: malformed date`); continue; }
    const [y, m, d] = String(e.date).split("-").map(Number);
    const wd = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    if (wd === "Sat" || wd === "Sun") bad.push(`${tag}: falls on ${wd}`);
    if (!nb.KNOWN_PRINT_TIMES.has(String(e.timeET))) bad.push(`${tag}: timeET not one of ${[...nb.KNOWN_PRINT_TIMES].join("/")}`);
    if (e.tier !== 1 && e.tier !== 2) bad.push(`${tag}: tier ${e.tier}`);
    if (ALL_TIER1.has(String(e.event)) !== (e.tier === 1)) bad.push(`${tag}: tier ${e.tier} disagrees with the tier-1 list`);
    if (typeof e.event !== "string" || !e.event.trim()) bad.push(`${tag}: empty event name`);
    if (e.date < from || e.date > partial) bad.push(`${tag}: outside window..partialThrough`);
    if (e.date > to && e.event !== "FOMC") bad.push(`${tag}: non-FOMC row past the complete window`);
    const key = `${e.date}|${e.event}`;
    if (seen.has(key)) bad.push(`${tag}: duplicate`);
    seen.add(key);
    const w = nb.deriveWindows(cal, e.date);
    if (!w.some(x => x.printET === e.timeET && x.events.includes(e.event))) bad.push(`${tag}: derives NO blackout window`);
  }
  assert(bad.length === 0, `every event is a weekday, known print time, valid tier, unique, in range, and derives a window${bad.length ? ` — ${bad.slice(0, 5).join(" | ")}` : ""}`);

  console.log("── tier-1 completeness inside the COMPLETE window ──");
  const months: string[] = [];
  for (let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))]; `${y}-${String(m).padStart(2, "0")}` <= to.slice(0, 7); m === 12 ? (y++, m = 1) : m++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  assert(months.length >= 1, `window spans ${months.length} month(s): ${months.join(", ")}`);
  for (const mo of months) {
    const names = new Set(events.filter(e => String(e?.date).startsWith(mo) && e.date >= from && e.date <= to).map(e => e.event));
    const missing = MONTHLY_TIER1.filter(n => !names.has(n));
    assert(missing.length === 0, `${mo}: every monthly tier-1 print present (${MONTHLY_TIER1.join(", ")})${missing.length ? ` — MISSING ${missing.join(", ")}` : ""}`);
  }
  for (const n of WINDOW_TIER1) {
    assert(events.some(e => e.event === n && e.date >= from && e.date <= to), `${n} appears at least once inside the complete window`);
  }
  const pendingInWindow = (Array.isArray(raw?.pending) ? raw.pending : []).filter((p: any) => String(p?.month) <= to.slice(0, 7));
  assert(pendingInWindow.length === 0, `no pending[] (unpublished) release falls inside the complete window (got ${pendingInWindow.map((p: any) => `${p.month} ${p.event}`).join(", ") || "none"})`);

  console.log("── rules + coverage ──");
  assert(nb.calendarRulesMatch(cal), "the file's informational blackoutRules == server/news-blackout.ts BLACKOUT_RULES");
  {
    const fileRules = (raw?.blackoutRules?.rules ?? []).map((r: any) => `${r.printTimeET} ${r.blackoutFromET}-${r.blackoutToET}${r.event ? " " + r.event : ""}`).sort();
    const codeRules = nb.BLACKOUT_RULES.map(r => `${r.print} ${r.from}-${r.to}${r.fomcOnly ? " FOMC" : ""}`).sort();
    assert(JSON.stringify(fileRules) === JSON.stringify(codeRules), `rules literal-equal: file ${JSON.stringify(fileRules)} vs code ${JSON.stringify(codeRules)}`);
  }
  const dayAfter = (s: string): string => new Date(Date.parse(`${s}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  assert(nb.calendarCovers(to, cal) && !nb.calendarCovers(dayAfter(to), cal), `calendarCovers: true on window.to (${to}), false the day after (no partial month reported as covered)`);
  if (partial > to) assert(!nb.calendarCovers(partial, cal), `calendarCovers(partialThrough ${partial}) === false`);

  console.log("── freshness (deliberate time bomb: refresh the calendar when these fail) ──");
  const todayET = nb.etDateOf(Math.floor(Date.now() / 1000));
  assert(to >= todayET, `window.to (${to}) >= today ET (${todayET}) — otherwise the calendar has EXPIRED`);
  const h = nb.newsCalendarHealth(todayET, cal);
  assert(h.eventsNext30 >= 1, `at least one scheduled print in the next 30 days (got ${h.eventsNext30}${h.next ? `, next ${h.next.event} ${h.next.date}` : ""})`);
  assert(!h.problems.some(p => /missing|EXPIRED|no scheduled print|no rule covers|differs/.test(p)),
    `newsCalendarHealth has no hard problem (${h.problems.join(" | ") || "none"})`);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
