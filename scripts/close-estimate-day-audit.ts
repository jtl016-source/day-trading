// scripts/close-estimate-day-audit.ts
// ─────────────────────────────────────────────────────────────────────────────
// RETRO DAY AUDIT: for given session days, list every fired 15m row in signal_history
// (live + regen — i.e. what ACTUALLY fired, including live-defect fires absent from the
// standing regen book) and compute the close-estimate zone at each fire (walk-forward via
// the SAME shared computeCloseEstimate over sliced 5m bars). Marks which fires each rule
// would have suppressed: R1 (afternoon away-from-zone chase), R3 (R1 + zone width ≤ 10).
// ANALYSIS ONLY — read-only DB, console output, no artifact.
//
// Run: npx tsx scripts/close-estimate-day-audit.ts 2026-08-05 2026-08-06 2026-08-07
// ─────────────────────────────────────────────────────────────────────────────
import * as path from "path";
import Database from "better-sqlite3";
import { computeCloseEstimate } from "../shared/close-estimate-core";
import { filterYbBars, sessionDayKey, type Bar } from "../shared/yellowbox-core";
import { etWallClock } from "../shared/firing/session";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data", "app.db");
const SYMBOL = "MES";
const AFTERNOON_MIN = 14 * 60;
const TIGHT_PTS = 10;

const days = process.argv.slice(2);
if (!days.length) { console.error("usage: tsx scripts/close-estimate-day-audit.ts YYYY-MM-DD ..."); process.exit(1); }

let db: Database.Database;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch { db = new Database(DB_PATH, { fileMustExist: true }); } // WAL readonly needs -shm; no writes issued

interface SigRow {
  timestamp: number; interval: string; direction: string; entry: number;
  outcome: string | null; points_result: number | null; source: string | null; label: string | null; combo_key: string | null;
}
const sigs = db.prepare(
  `SELECT timestamp, interval, direction, entry, outcome, points_result, source, label, combo_key
     FROM signal_history ORDER BY timestamp`,
).all() as SigRow[];

const wanted = sigs.filter((r) => days.includes(sessionDayKey(r.timestamp)));
const firstTs = wanted.length ? Math.min(...wanted.map((r) => r.timestamp)) : 0;
const bars5: Bar[] = wanted.length ? filterYbBars(db.prepare(
  `SELECT timestamp t, open o, high h, low l, close c, COALESCE(volume,0) v
     FROM cached_candles WHERE symbol=? AND resolution='5' AND timestamp>=? ORDER BY timestamp`,
).all(SYMBOL, firstTs - 130 * 86400) as Bar[], "5") : [];
db.close();

const etHm = (ts: number): string => {
  const { mins } = etWallClock(ts);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
};

for (const day of days) {
  const rows = wanted.filter((r) => sessionDayKey(r.timestamp) === day);
  const rows15 = rows.filter((r) => r.interval === "15m" || r.interval === "15");
  const dayPts = rows.reduce((s, r) => s + (r.points_result ?? 0), 0);
  const pts15 = rows15.reduce((s, r) => s + (r.points_result ?? 0), 0);
  console.log(`\n== ${day} — all-interval fired: n=${rows.length} pts ${dayPts.toFixed(2)} | 15m: n=${rows15.length} pts ${pts15.toFixed(2)}`);
  let savedR1 = 0, savedR3 = 0;
  for (const r of rows15) {
    const cut = bars5.filter((b) => b.t + 300 <= r.timestamp);
    const est = computeCloseEstimate(cut);
    const zoneOk = est && est.day.dayKey === day;
    const zBot = zoneOk ? Math.min(est.day.estCloseHigh, est.day.estCloseLow) : NaN;
    const zTop = zoneOk ? Math.max(est.day.estCloseHigh, est.day.estCloseLow) : NaN;
    const width = zoneOk ? +(zTop - zBot).toFixed(2) : NaN;
    const mins = etWallClock(r.timestamp).mins;
    const afternoon = mins >= AFTERNOON_MIN;
    const away = zoneOk && ((r.direction === "Long" && r.entry > zTop) || (r.direction === "Short" && r.entry < zBot));
    const r1 = afternoon && away;
    const r3 = r1 && width <= TIGHT_PTS;
    if (r1) savedR1 += -(r.points_result ?? 0);
    if (r3) savedR3 += -(r.points_result ?? 0);
    console.log(
      `  ${etHm(r.timestamp)}ET ${r.direction.padEnd(5)} e${r.entry.toFixed(2)} ` +
      `${String(r.outcome ?? "?").padEnd(7)} ${String(r.points_result ?? "·").padStart(7)} src=${String(r.source ?? "regen").padEnd(7)} ${String(r.combo_key ?? "").padEnd(11)} ` +
      (zoneOk ? `zone ${zBot.toFixed(2)}–${zTop.toFixed(2)} (w${width}) ${away ? (r.direction === "Long" ? "ABOVE→chasing" : "BELOW→chasing") : "ok"}` : "zone n/a") +
      `${afternoon ? "" : " [pre-14:00 — rules don't apply]"}${r3 ? "  ◄ R3 SUPPRESSED" : r1 ? "  ◄ R1 suppressed" : ""}`,
    );
  }
  console.log(`  → points a suppression would have saved: R1 (any chase) ${savedR1 >= 0 ? "+" : ""}${savedR1.toFixed(2)} | R3 (tight only) ${savedR3 >= 0 ? "+" : ""}${savedR3.toFixed(2)}`);
}
