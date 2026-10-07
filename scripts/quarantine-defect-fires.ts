/**
 * quarantine-defect-fires.ts — ONE-SHOT MIGRATION #2 (2026-08-10, USER-DIRECTED follow-up to
 * quarantine-pre-riskcontrols-signals.ts).
 *
 * The 2026-08-03..2026-08-07 week ran with the deadTapeFailClosed gap (missing dead-tape
 * baseline let fires bypass the gate — fixed 2026-08-07; postmortem-documented): the tab's
 * remaining streak days (08-05 LLLLL −76, 08-07 LLLLLLL −113) are live rows the CURRENT
 * engine provably does not produce. Rule: source='live' rows on session days in the defect
 * window whose (interval|timestamp|direction) key is ABSENT from the standing results JSON
 * (the current-rules book) move to a backup table. SELF-HEALING: if a later regen's book DOES
 * fire one of these keys, --persist re-inserts it as a regen row with the replay outcome.
 * Restore path: INSERT INTO signal_history SELECT * FROM the backup table.
 *
 * Usage: npx tsx scripts/quarantine-defect-fires.ts [--dry-run]
 */
import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { sessionDayKey } from "../shared/yellowbox-core";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data", "app.db");
const SYMBOL = "MES";
// DOCUMENTED defect days ONLY (postmortem + day-audit + fail-closed lesson): 08-05 and 08-07
// are the 0%-days whose fires all bypassed the missing dead-tape baseline; 08-06's three
// fires are the documented "won by luck" bypasses. 08-03/08-04 live fires were LEGITIMATE
// (good-week fires under the then-current rules) and are absent from today's book only via
// gate-roll/forming-bar asymmetry — they STAY (as-lived record).
const FROM_DAY = "2026-08-05", TO_DAY = "2026-08-07";
const BACKUP_TABLE = "signal_history_defect_quarantine_20260810";
const RESULTS = path.join(artifactsDir(ROOT), "fact-engine-backtest-results.json");
const DRY = process.argv.includes("--dry-run");

const doc = JSON.parse(fs.readFileSync(RESULTS, "utf8")) as { signals: Array<{ interval: string; fireTs: number; direction: string }> };
const bookKeys = new Set(doc.signals.map(s => `${s.interval}|${s.fireTs}|${s.direction.toLowerCase()}`));
console.log(`standing book: ${doc.signals.length} signals (${RESULTS})`);

const db = new Database(DB_PATH, { fileMustExist: true });
db.pragma("journal_mode = WAL");
if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(BACKUP_TABLE)) {
  console.error(`ABORT: ${BACKUP_TABLE} already exists — migration already ran.`);
  process.exit(1);
}

const rows = db.prepare(
  `SELECT rowid AS rid, timestamp, interval, direction, outcome, points_result, source FROM signal_history WHERE symbol=? AND source='live'`,
).all(SYMBOL) as Array<{ rid: number; timestamp: number; interval: string; direction: string; outcome: string | null; points_result: number | null; source: string }>;

const targets = rows.filter(r => {
  const day = sessionDayKey(r.timestamp);
  if (day < FROM_DAY || day > TO_DAY) return false;
  return !bookKeys.has(`${r.interval}|${r.timestamp}|${r.direction.toLowerCase()}`);
});
console.log(`live rows in ${FROM_DAY}..${TO_DAY}: ${rows.filter(r => { const d = sessionDayKey(r.timestamp); return d >= FROM_DAY && d <= TO_DAY; }).length}; replay-unreproducible (defect-class): ${targets.length}`);
for (const t of targets) console.log(`  ${sessionDayKey(t.timestamp)} ${t.interval.padEnd(3)} ${t.direction.padEnd(5)} ts=${t.timestamp} ${t.outcome ?? "open"} ${t.points_result ?? ""}`);

if (DRY) { console.log("DRY RUN — nothing written."); db.close(); process.exit(0); }
if (!targets.length) { console.log("Nothing to quarantine."); db.close(); process.exit(0); }

db.exec(`CREATE TABLE ${BACKUP_TABLE} AS SELECT * FROM signal_history WHERE 0`);
const ph = targets.map(() => "?").join(",");
const move = db.transaction((rids: number[]) => {
  db.prepare(`INSERT INTO ${BACKUP_TABLE} SELECT * FROM signal_history WHERE rowid IN (${ph})`).run(...rids);
  db.prepare(`DELETE FROM signal_history WHERE rowid IN (${ph})`).run(...rids);
});
move(targets.map(t => t.rid));
console.log(`moved ${targets.length} rows → ${BACKUP_TABLE}`);
db.close();
