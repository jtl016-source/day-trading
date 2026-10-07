/**
 * uniform-live-revalue.ts — UNIFORM CURRENT-RULES SERVING (2026-08-12, user-chosen policy).
 *
 * The Signals tab previously kept pre-edge live rows AS-TRADED (resolved under the exit
 * config active when each fired). The user chose uniform valuation instead: every pre-edge
 * row must carry the CURRENT standing book's values, so the tab always agrees with the
 * backtests/reports. Provenance is preserved two ways:
 *   - source='live' stays on the row (the fire genuinely happened live);
 *   - the ORIGINAL as-traded values are copied once into signal_history_astraded_backup
 *     before first modification (idempotent: a row already backed up is never re-backed-up,
 *     so the backup always holds the true as-traded originals, not intermediate states).
 *
 * Re-run after every regen that refreshes fact-engine-backtest-results.json (weekly regen,
 * manual re-derivations). Rows at the live edge (≤ LIVE_EDGE_DAYS) are NEVER touched — that
 * zone belongs to the live infrastructure. integrity-check.ts V2b enforces the result.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd();
const SYMBOL = "MES";
const LIVE_EDGE_DAYS = 2;
const BACKUP = "signal_history_astraded_backup";
const DRY = process.argv.includes("--dry");

const db = new Database(path.join(ROOT, "data", "app.db"));
const doc = JSON.parse(fs.readFileSync(path.join(artifactsDir(ROOT), "fact-engine-backtest-results.json"), "utf8")) as {
  meta: { generatedAt?: string };
  signals: Array<{
    interval: string; fireTs: number; direction: string; outcome: string; pointsResult: number | null;
    entry: number; tp1: number; tp2: number; sl: number; exitPrice: number | null; exitTs: number | null;
    mae: number | null; mfe: number | null; barsToExit: number | null; fullLabel: string; confirmations: string;
    signalType: string; combo: string | null; riskFlags: string[] | null; suggestedContracts: number | null;
  }>;
};
const DB_OUTCOME: Record<string, string> = { tp1: "win_tp1", tp2: "win_tp2", sl: "loss", eod: "eod", open: "open" };
const book = new Map(doc.signals.map(s => [`${s.interval}|${s.fireTs}|${s.direction.toLowerCase()}`, s]));

const now = Math.floor(Date.now() / 1000);
const liveEdge = now - LIVE_EDGE_DAYS * 86400;
const rows = db.prepare(
  `SELECT id, interval, timestamp, direction, outcome, points_result, entry, tp1, tp2, sl
   FROM signal_history WHERE symbol=? AND source='live' AND timestamp < ?`,
).all(SYMBOL, liveEdge) as Array<{ id: number; interval: string; timestamp: number; direction: string; outcome: string | null; points_result: number | null; entry: number | null; tp1: number | null; tp2: number | null; sl: number | null }>;

const neq = (a: number | null, b: number | null): boolean =>
  (a == null) !== (b == null) || (a != null && b != null && Math.abs(a - b) > 0.011);
const targets: Array<{ id: number; s: (typeof doc.signals)[number]; oldOc: string | null; oldPts: number | null }> = [];
for (const r of rows) {
  const s = book.get(`${r.interval}|${r.timestamp}|${r.direction.toLowerCase()}`);
  if (!s) continue; // pre-edge live rows not in the book are integrity-check V2's business, not ours
  const oc = DB_OUTCOME[s.outcome] ?? s.outcome;
  if (oc !== (r.outcome ?? "open") || neq(s.pointsResult, r.points_result)
    || neq(s.entry, r.entry) || neq(s.tp1, r.tp1) || neq(s.tp2, r.tp2) || neq(s.sl, r.sl)) {
    targets.push({ id: r.id, s, oldOc: r.outcome, oldPts: r.points_result });
  }
}
const byIv: Record<string, number> = {};
for (const t of targets) byIv[t.s.interval] = (byIv[t.s.interval] ?? 0) + 1;
const ptsDelta = targets.reduce((a, t) => a + ((t.s.pointsResult ?? 0) - (t.oldPts ?? 0)), 0);
console.log(`[uniform] pre-edge live rows: ${rows.length}; re-valuing ${targets.length} ${JSON.stringify(byIv)}; as-traded→book pts delta ${ptsDelta >= 0 ? "+" : ""}${ptsDelta.toFixed(1)}`);
if (DRY) { console.log("[uniform] DRY RUN — no writes"); db.close(); process.exit(0); }

db.exec(`CREATE TABLE IF NOT EXISTS ${BACKUP} AS SELECT * FROM signal_history WHERE 0`);
const backup = db.prepare(`INSERT INTO ${BACKUP} SELECT * FROM signal_history WHERE id=? AND id NOT IN (SELECT id FROM ${BACKUP})`);
const upd = db.prepare(
  `UPDATE signal_history SET outcome=?, points_result=?, entry=?, tp1=?, tp2=?, sl=?,
     exit_price=?, exit_ts=?, mae=?, mfe=?, bars_to_exit=?, label=?, confirmations=?,
     signal_type=?, combo_key=?, risk_flags=?, suggested_contracts=?, updated_at=? WHERE id=?`,
);
const updatedAt = new Date().toISOString();
let backed = 0, changed = 0;
const run = db.transaction(() => {
  for (const t of targets) {
    backed += backup.run(t.id).changes;
    const s = t.s;
    changed += upd.run(
      DB_OUTCOME[s.outcome] ?? s.outcome, s.pointsResult, s.entry, s.tp1, s.tp2, s.sl,
      s.exitPrice, s.exitTs, s.mae, s.mfe, s.barsToExit, s.fullLabel, s.confirmations,
      s.signalType, s.combo, s.riskFlags ? JSON.stringify(s.riskFlags) : null, s.suggestedContracts,
      updatedAt, t.id,
    ).changes;
  }
});
run();
console.log(`[uniform] backed up ${backed} as-traded originals → ${BACKUP}; re-valued ${changed} rows to book (${doc.meta.generatedAt ?? "?"})`);
db.close();
