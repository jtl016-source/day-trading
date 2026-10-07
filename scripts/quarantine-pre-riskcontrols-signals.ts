/**
 * quarantine-pre-riskcontrols-signals.ts — ONE-SHOT MIGRATION (2026-08-10, USER-DIRECTED).
 *
 * The user asked the signals tab to show ONLY signals the CURRENT strategy set would produce.
 * Everything before the 2026-08-02 risk-controls ship (quality gate + dead-tape + daily loss
 * stop) was fired by an engine that no longer exists — those rows (source='live'/'catchup'/
 * NULL, i.e. anything that is NOT the regen book) are moved to a backup table, and a follow-up
 * `fact-engine-backtest.ts --persist` run fills the vacated keys with current-rules regen rows
 * (regen yields to live on collision, so the current-rules row for a quarantined key is NOT
 * yet in the table — the re-persist is REQUIRED, not optional).
 *
 * DELIBERATE EXCEPTION to the "live-fired records are permanent" doctrine (2026-07-31):
 * explicitly requested by the user in chat 2026-08-10. Post-2026-08-02 live rows are the true
 * current-era track record and are NOT touched. Idempotency: aborts if the backup table
 * already exists. Restore path: INSERT INTO signal_history SELECT * FROM the backup table.
 *
 * Usage: npx tsx scripts/quarantine-pre-riskcontrols-signals.ts [--dry-run]
 */
import * as path from "path";
import Database from "better-sqlite3";
import { sessionDayKey } from "../shared/yellowbox-core";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data", "app.db");
const SYMBOL = "MES";
const CUTOFF_DAY = "2026-08-02"; // first risk-controls session day — rows on/after stay
const BACKUP_TABLE = "signal_history_pre_rc_quarantine_20260810";
const DRY = process.argv.includes("--dry-run");

const db = new Database(DB_PATH, { fileMustExist: true });
db.pragma("journal_mode = WAL");

const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(BACKUP_TABLE);
if (tableExists) {
  console.error(`ABORT: backup table ${BACKUP_TABLE} already exists — migration already ran. Restore path: INSERT INTO signal_history SELECT * FROM ${BACKUP_TABLE};`);
  process.exit(1);
}

const rows = db.prepare(
  `SELECT rowid AS rid, timestamp, interval, source FROM signal_history WHERE symbol=?`,
).all(SYMBOL) as Array<{ rid: number; timestamp: number; interval: string; source: string | null }>;

const targets = rows.filter(r => (r.source ?? "") !== "regen" && sessionDayKey(r.timestamp) < CUTOFF_DAY);
const bySrc = new Map<string, number>();
const byIv = new Map<string, number>();
for (const r of targets) {
  const s = r.source ?? "NULL";
  bySrc.set(s, (bySrc.get(s) ?? 0) + 1);
  byIv.set(r.interval, (byIv.get(r.interval) ?? 0) + 1);
}
console.log(`signal_history ${SYMBOL}: ${rows.length} rows total; quarantining ${targets.length} non-regen rows before session day ${CUTOFF_DAY}`);
console.log(`  by source: ${[...bySrc.entries()].map(([k, n]) => `${k}=${n}`).join(" ") || "(none)"}`);
console.log(`  by interval: ${[...byIv.entries()].map(([k, n]) => `${k}=${n}`).join(" ") || "(none)"}`);

if (DRY) { console.log("DRY RUN — nothing written."); db.close(); process.exit(0); }
if (!targets.length) { console.log("Nothing to quarantine."); db.close(); process.exit(0); }

db.exec(`CREATE TABLE ${BACKUP_TABLE} AS SELECT * FROM signal_history WHERE 0`);
const CHUNK = 500;
const move = db.transaction((rids: number[]) => {
  for (let i = 0; i < rids.length; i += CHUNK) {
    const slice = rids.slice(i, i + CHUNK);
    const ph = slice.map(() => "?").join(",");
    db.prepare(`INSERT INTO ${BACKUP_TABLE} SELECT * FROM signal_history WHERE rowid IN (${ph})`).run(...slice);
    db.prepare(`DELETE FROM signal_history WHERE rowid IN (${ph})`).run(...slice);
  }
});
move(targets.map(t => t.rid));

const backed = db.prepare(`SELECT COUNT(*) n FROM ${BACKUP_TABLE}`).get() as { n: number };
const remain = db.prepare(`SELECT COUNT(*) n FROM signal_history WHERE symbol=?`).get(SYMBOL) as { n: number };
console.log(`moved ${backed.n} rows → ${BACKUP_TABLE}; signal_history ${SYMBOL} now ${remain.n} rows`);
console.log(`NEXT (required): npx tsx scripts/fact-engine-backtest.ts --persist  — regen fills the vacated pre-${CUTOFF_DAY} keys with current-rules rows.`);
db.close();
