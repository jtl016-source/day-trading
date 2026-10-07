/**
 * deadtape-frequency.ts — HOW OFTEN IS A DAY DEAD-QUIET? (2026-08-11, user question.)
 * Walk-forward per-day measurement mirroring the live rule: for each session day, threshold =
 * DEAD_TAPE_SUPPRESS_MULT × trailing median of the PRIOR 90 session days' ranges; the day is
 * "dead ALL day" when its full-session range never reaches the threshold (the running-range
 * rule then suppressed every bar). Also: when days cleared (share by 9:30 / by noon / later),
 * longest dead streaks, and the recent-regime rate. Read-only; console only.
 *
 * Usage: npx tsx scripts/deadtape-frequency.ts
 */
import Database from "better-sqlite3";
import * as path from "node:path";
import { DEAD_TAPE_SUPPRESS_MULT } from "../shared/fact-engine";
import { sessionDayKey } from "../shared/yellowbox-core";
import { etWallClock } from "../shared/firing/session";

const db = new Database(path.join(process.cwd(), "data", "app.db"), { readonly: true, fileMustExist: true });
const rows = db.prepare(
  `SELECT timestamp t, high h, low l FROM cached_candles WHERE symbol='MES' AND resolution='5' ORDER BY timestamp`
).all() as Array<{ t: number; h: number; l: number }>;
db.close();

interface Day { key: string; range: number; clearEtMins: number | null; bars: number }
const byDay = new Map<string, { hi: number; lo: number; bars: number; clearT: number | null; thr: number | null }>();
const order: string[] = [];
const ranges: number[] = [];
const trailing: number[] = [];

// First pass groups bars chronologically; the trailing median must be causal, so thresholds are
// assigned as each day STARTS (from the ranges of prior completed days).
let curKey = "";
let cur: { hi: number; lo: number; bars: number; clearT: number | null; thr: number | null } | null = null;
const days: Day[] = [];
const median = (a: number[]): number | null => {
  if (a.length < 20) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
for (const r of rows) {
  const k = sessionDayKey(r.t);
  if (k !== curKey) {
    if (cur && cur.bars >= 60) {
      days.push({ key: curKey, range: cur.hi - cur.lo, clearEtMins: cur.clearT, bars: cur.bars });
      ranges.push(cur.hi - cur.lo);
      if (ranges.length > 90) ranges.shift();
    }
    curKey = k;
    const med = median(ranges);
    cur = { hi: -Infinity, lo: Infinity, bars: 0, clearT: null, thr: med != null ? DEAD_TAPE_SUPPRESS_MULT * med : null };
  }
  if (!cur) continue;
  cur.hi = Math.max(cur.hi, r.h); cur.lo = Math.min(cur.lo, r.l); cur.bars++;
  if (cur.clearT == null && cur.thr != null && cur.hi - cur.lo >= cur.thr) {
    cur.clearT = etWallClock(r.t).mins;
  }
  void trailing;
}
if (cur && cur.bars >= 60) days.push({ key: curKey, range: cur.hi - cur.lo, clearEtMins: cur.clearT, bars: cur.bars });
void order;

const judged = days.filter(d => d.clearEtMins !== null || d.range > 0).filter((_, i) => i >= 30); // skip warmup
const yr = (k: string): string => k.slice(0, 4);
const years = [...new Set(judged.map(d => yr(d.key)))].sort();
console.log(`days judged: ${judged.length} (${judged[0]?.key} .. ${judged[judged.length - 1]?.key}); dead = full-day range < ${DEAD_TAPE_SUPPRESS_MULT} × trailing-90-session median`);
console.log(`\nyear | days | DEAD all day | cleared by 9:30 ET | by noon | after noon`);
const pct = (n: number, d: number): string => d ? `${Math.round((100 * n) / d)}%` : "—";
for (const y of years) {
  const ds = judged.filter(d => yr(d.key) === y);
  const dead = ds.filter(d => d.clearEtMins == null).length;
  const by930 = ds.filter(d => d.clearEtMins != null && d.clearEtMins <= 570).length;
  const byNoon = ds.filter(d => d.clearEtMins != null && d.clearEtMins > 570 && d.clearEtMins <= 720).length;
  const late = ds.filter(d => d.clearEtMins != null && d.clearEtMins > 720).length;
  console.log(`${y} | ${String(ds.length).padStart(4)} | ${pct(dead, ds.length).padStart(4)} (${dead}) | ${pct(by930, ds.length).padStart(4)} | ${pct(byNoon, ds.length).padStart(4)} | ${pct(late, ds.length).padStart(4)}`);
}
const last60 = judged.slice(-60);
const last20 = judged.slice(-20);
console.log(`\nlast 60 sessions: dead ${last60.filter(d => d.clearEtMins == null).length}/${last60.length}; last 20: dead ${last20.filter(d => d.clearEtMins == null).length}/${last20.length}`);
// Longest consecutive dead streaks.
let run = 0, best = 0, bestEnd = "";
for (const d of judged) {
  if (d.clearEtMins == null) { run++; if (run > best) { best = run; bestEnd = d.key; } } else run = 0;
}
console.log(`longest all-day-dead streak: ${best} sessions (ending ${bestEnd}); current streak: ${(() => { let c = 0; for (let i = judged.length - 1; i >= 0 && judged[i].clearEtMins == null; i--) c++; return c; })()}`);

// STREAK DISTRIBUTION (2026-08-11 follow-up: "is 2 in a row rare?") — count maximal runs.
const streaks: number[] = [];
run = 0;
for (const d of judged) {
  if (d.clearEtMins == null) run++;
  else { if (run > 0) streaks.push(run); run = 0; }
}
if (run > 0) streaks.push(run);
const dist = new Map<number, number>();
for (const s of streaks) dist.set(s, (dist.get(s) ?? 0) + 1);
const twoPlus = streaks.filter(s => s >= 2);
console.log(`\ndead-run distribution over ${judged.length} sessions: ` +
  [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([len, n]) => `${len}d×${n}`).join("  "));
console.log(`runs of 2+ : ${twoPlus.length} (one every ~${Math.round(judged.length / Math.max(1, twoPlus.length))} sessions ≈ every ${Math.round(judged.length / Math.max(1, twoPlus.length) / 21)} months)`);
const twoPlusEnds: string[] = [];
{
  let r = 0;
  for (let i = 0; i < judged.length; i++) {
    if (judged[i].clearEtMins == null) r++;
    else { if (r >= 2) twoPlusEnds.push(`${judged[i - 1].key}(${r})`); r = 0; }
  }
  if (r >= 2) twoPlusEnds.push(`${judged[judged.length - 1].key}(${r})`);
}
console.log(`2+ runs ended: ${twoPlusEnds.slice(-12).join(", ")}${twoPlusEnds.length > 12 ? " …(+earlier)" : ""}`);

// MONTH SEASONALITY — do dead days cluster (summer lull, holidays)?
const mDead = new Map<string, { n: number; dead: number }>();
for (const d of judged) {
  const m = d.key.slice(5, 7);
  const e = mDead.get(m) ?? { n: 0, dead: 0 };
  e.n++; if (d.clearEtMins == null) e.dead++;
  mDead.set(m, e);
}
console.log(`\ndead rate by month: ` + [...mDead.entries()].sort().map(([m, e]) => `${m}:${Math.round((100 * e.dead) / e.n)}%`).join(" "));
