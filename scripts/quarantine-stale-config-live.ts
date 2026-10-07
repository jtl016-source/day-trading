/**
 * quarantine-stale-config-live.ts — ONE-SHOT MIGRATION #3 (2026-08-12, user: "do not
 * fabricate data" — the tab contradicted the standing book).
 *
 * ROOT CAUSE (measured): open tabs persist their last-30-days engine recompute as PERMANENT
 * source='live' rows. A week of engine changes (ETH / carry / drift exemption / new exits)
 * accumulated every intermediate config's fires as immortal rows the regen wipe must skip and
 * regen upserts must yield to — 272 of the 286 recent 15m rows were stale-config live rows
 * (+1,975 phantom pts vs the current book). market.tsx now live-stamps only the 2-day live
 * edge; this migration cleans the accumulated damage:
 *   • QUARANTINE: standing-window source='live' rows whose (interval|timestamp|direction) key
 *     is NOT in the current standing book AND whose fire time is older than the live edge
 *     (2 days) — i.e., provably stale-config recomputes, not genuine recent live fires.
 *   • RE-FILL: re-upsert the ENTIRE current standing book via the direct-DB path (yield-to-
 *     live semantics) so keys freed from stale live rows get their current-book row back
 *     (the earlier persist skipped them as collisions).
 * Backup table: signal_history_staleconfig_quarantine_20260812 (restorable). Self-healing:
 * future persists refill anything the current book fires.
 *
 * Usage: npx tsx scripts/quarantine-stale-config-live.ts [--dry-run]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data", "app.db");
const SYMBOL = "MES";
const BACKUP = "signal_history_staleconfig_quarantine_20260812";
const DRY = process.argv.includes("--dry-run");
const RESULTS = path.join(artifactsDir(ROOT), "fact-engine-backtest-results.json");

const doc = JSON.parse(fs.readFileSync(RESULTS, "utf8")) as {
  meta: { emissionStartTs: number };
  signals: Array<Record<string, unknown> & { interval: string; fireTs: number; direction: string; outcome: string }>;
};
const bookKeys = new Set(doc.signals.map(s => `${s.interval}|${s.fireTs}|${s.direction.toLowerCase()}`));
const liveEdge = Math.floor(Date.now() / 1000) - 2 * 86400;
const winStart = doc.meta.emissionStartTs;

const db = new Database(DB_PATH, { fileMustExist: true });
db.pragma("busy_timeout = 15000");
if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(BACKUP)) {
  console.error(`ABORT: ${BACKUP} exists — already ran.`); process.exit(1);
}
const liveRows = db.prepare(
  `SELECT rowid AS rid, interval, timestamp, direction, outcome, points_result FROM signal_history
   WHERE symbol=? AND source='live' AND timestamp>=?`,
).all(SYMBOL, winStart) as Array<{ rid: number; interval: string; timestamp: number; direction: string; outcome: string | null; points_result: number | null }>;
const stale = liveRows.filter(r =>
  r.timestamp < liveEdge && !bookKeys.has(`${r.interval}|${r.timestamp}|${r.direction.toLowerCase()}`));
const byIv: Record<string, number> = {};
for (const r of stale) byIv[r.interval] = (byIv[r.interval] ?? 0) + 1;
console.log(`standing-window live rows: ${liveRows.length}; STALE-CONFIG (pre-live-edge, not in current book): ${stale.length} ${JSON.stringify(byIv)}`);
console.log(`phantom pts being removed: ${stale.reduce((a, r) => a + (r.points_result ?? 0), 0).toFixed(1)}`);
if (DRY) { console.log("DRY RUN"); db.close(); process.exit(0); }

db.exec(`CREATE TABLE ${BACKUP} AS SELECT * FROM signal_history WHERE 0`);
const move = db.transaction((rids: number[]) => {
  for (let i = 0; i < rids.length; i += 500) {
    const slice = rids.slice(i, i + 500);
    const ph = slice.map(() => "?").join(",");
    db.prepare(`INSERT INTO ${BACKUP} SELECT * FROM signal_history WHERE rowid IN (${ph})`).run(...slice);
    db.prepare(`DELETE FROM signal_history WHERE rowid IN (${ph})`).run(...slice);
  }
});
move(stale.map(s => s.rid));
console.log(`quarantined ${stale.length} → ${BACKUP}`);

// Re-fill: upsert the whole current book (yield-to-live) so freed keys get current-book rows.
const DB_OUTCOME: Record<string, string> = { tp1: "win_tp1", tp2: "win_tp2", sl: "loss", eod: "eod", open: "open" };
const selLive = db.prepare(`SELECT source FROM signal_history WHERE symbol=? AND interval=? AND timestamp=? AND direction=?`);
const stmt = db.prepare(
  `INSERT INTO signal_history (symbol, interval, timestamp, direction, risk_level, signal_type, entry, tp1, tp2, sl, outcome, footprint_reading, confirmations, label,
     exit_price, exit_ts, points_result, mae, mfe, bars_to_exit, combo_key, risk_flags, suggested_contracts, source, updated_at)
   VALUES (@symbol, @interval, @timestamp, @direction, @riskLevel, @signalType, @entry, @tp1, @tp2, @sl, @outcome, NULL, @confirmations, @label,
     @exitPrice, @exitTs, @pointsResult, @mae, @mfe, @barsToExit, @comboKey, @riskFlagsJson, @suggestedContracts, @source, @updatedAt)
   ON CONFLICT(symbol, interval, timestamp, direction) DO UPDATE SET
     outcome=CASE WHEN (outcome IS NULL OR outcome='open' OR excluded.outcome IS NULL OR excluded.outcome=outcome
                        OR (outcome='win_tp1' AND excluded.outcome='win_tp2'))
                  THEN COALESCE(excluded.outcome, outcome) ELSE outcome END,
     label=COALESCE(excluded.label, label), signal_type=COALESCE(excluded.signal_type, signal_type),
     exit_price=COALESCE(excluded.exit_price, exit_price), exit_ts=COALESCE(excluded.exit_ts, exit_ts),
     points_result=COALESCE(excluded.points_result, points_result), mae=COALESCE(excluded.mae, mae),
     mfe=COALESCE(excluded.mfe, mfe), bars_to_exit=COALESCE(excluded.bars_to_exit, bars_to_exit),
     combo_key=COALESCE(excluded.combo_key, combo_key), risk_flags=COALESCE(excluded.risk_flags, risk_flags),
     suggested_contracts=COALESCE(excluded.suggested_contracts, suggested_contracts),
     source=CASE WHEN source='live' THEN source ELSE COALESCE(excluded.source, source) END,
     updated_at=excluded.updated_at`,
);
const updatedAt = new Date().toISOString();
let inserted = 0, collisions = 0, skipped = 0;
const fill = db.transaction((sigs: typeof doc.signals) => {
  for (const r of sigs) {
    const row = {
      symbol: SYMBOL, interval: r.interval, timestamp: r.fireTs as number, direction: r.direction as string,
      riskLevel: "safe", signalType: r.signalType as string, entry: r.entry as number, tp1: r.tp1 as number, tp2: r.tp2 as number, sl: r.sl as number,
      outcome: DB_OUTCOME[r.outcome] ?? (r.outcome as string), label: (r.fullLabel as string) ?? null,
      exitPrice: (r.exitPrice as number) ?? null, exitTs: (r.exitTs as number) ?? null, pointsResult: (r.pointsResult as number) ?? null,
      mae: (r.mae as number) ?? null, mfe: (r.mfe as number) ?? null, barsToExit: (r.barsToExit as number) ?? null,
      comboKey: (r.combo as string) ?? null, riskFlagsJson: r.riskFlags ? JSON.stringify(r.riskFlags) : null,
      suggestedContracts: (r.suggestedContracts as number) ?? null, source: "regen", updatedAt,
      confirmations: (r.confirmations as string) ?? null,
    };
    // Book rows already passed validateSignalRow at persist time — the direct upsert + the
    // live-source yield below are the only guards needed here.
    const stored = selLive.get(SYMBOL, row.interval, row.timestamp, row.direction) as { source: string | null } | undefined;
    if (stored?.source === "live") { collisions++; continue; }
    try { stmt.run(row); inserted++; } catch { skipped++; }
  }
});
fill(doc.signals);
console.log(`re-fill: upserted ${inserted}, live collisions ${collisions}, skipped ${skipped} of ${doc.signals.length}`);
db.close();
