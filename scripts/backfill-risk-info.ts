// scripts/backfill-risk-info.ts
// ═════════════════════════════════════════════════════════════════════════════
// ONE-TIME RISK-INFO BACKFILL (2026-07-30 risk-display mission).
//
// Fills the new signal_history.combo_key + risk_flags columns for EXISTING window rows from
// risk-factor-analysis.json (scripts/risk-factor-analysis.ts output), whose per-trade records
// are keyed by fireTs/interval/direction and carry the comboKey + the four proven factors.
//
// Flag mapping (analysis → the engine's RISK_FLAG_IDS, same deterministic order):
//   footprintPresent === false   → "no-footprint"
//   riskFactors.timeRisk         → "late-entry"
//   riskFactors.regimeTier "<0.6"→ "dead-tape"   (NOTE: analysis basis = the FINISHED day's
//                                  range; live rows use the running range at fire time)
//   riskFactors.roomTier "<1"    → "tight-room"  (NOTE: analysis basis includes persistent
//                                  bands; live rows use day-zone levels only)
//
// Safety: full table backup first (signal_history_backup_pre_risk_backfill), columns added
// idempotently, and ONLY rows whose combo_key IS NULL are touched (a live-engine-stamped row
// is never clobbered). Unmatched rows are reported and display gracefully with no risk info.
//
// Run:  npx tsx scripts/backfill-risk-info.ts [--dry-run]
// ═════════════════════════════════════════════════════════════════════════════
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsDir } from "../shared/artifacts-dir"; // BAXTER_ARTIFACTS_DIR (2026-08-02)

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
const RFA_JSON = path.join(artifactsDir(ROOT), "risk-factor-analysis.json"); // BAXTER_ARTIFACTS_DIR (2026-08-02)
const DRY = process.argv.includes("--dry-run");
const SYMBOL = "MES";

interface RfaTrade {
  fireTs: number; interval: string; direction: string;
  comboKey: string;
  riskFactors: { footprintPresent: boolean; timeRisk: boolean; regimeTier: string; roomTier: string };
}

function flagsOf(t: RfaTrade): string[] {
  const flags: string[] = [];
  if (!t.riskFactors.footprintPresent) flags.push("no-footprint");
  if (t.riskFactors.timeRisk) flags.push("late-entry");
  if (t.riskFactors.regimeTier === "<0.6") flags.push("dead-tape");
  if (t.riskFactors.roomTier === "<1") flags.push("tight-room");
  return flags;
}

function main(): void {
  const rfa = JSON.parse(fs.readFileSync(RFA_JSON, "utf-8")) as {
    meta: { generatedAt: string; gatedSource: { generatedAt: string; trades: number } };
    trades: { gated: RfaTrade[] };
  };
  const trades = rfa.trades.gated;
  console.log(`[backfill] analysis: ${trades.length} gated trades (analysis ${rfa.meta.generatedAt}, source regen ${rfa.meta.gatedSource.generatedAt})`);

  const byKey = new Map<string, RfaTrade>();
  for (const t of trades) byKey.set(`${t.fireTs}|${t.interval}|${t.direction}`, t);

  const db = new Database(DB_PATH, { fileMustExist: true });
  db.pragma("busy_timeout = 15000");

  // Columns (idempotent — same house pattern as server/db.ts; lets this run pre-restart).
  for (const col of ["combo_key TEXT", "risk_flags TEXT"]) {
    try { db.exec(`ALTER TABLE signal_history ADD COLUMN ${col}`); } catch { /* exists */ }
  }

  // Full backup (deterministic name, refreshed per run — mirrors the --persist pattern).
  if (!DRY) {
    db.exec(`DROP TABLE IF EXISTS signal_history_backup_pre_risk_backfill`);
    db.exec(`CREATE TABLE signal_history_backup_pre_risk_backfill AS SELECT * FROM signal_history`);
    const bk = db.prepare(`SELECT COUNT(*) n FROM signal_history_backup_pre_risk_backfill`).get() as { n: number };
    console.log(`[backfill] backup: signal_history_backup_pre_risk_backfill (${bk.n} rows)`);
  }

  const rows = db.prepare(
    `SELECT id, timestamp, interval, direction, combo_key FROM signal_history WHERE symbol=?`
  ).all(SYMBOL) as Array<{ id: number; timestamp: number; interval: string; direction: string; combo_key: string | null }>;

  const upd = db.prepare(`UPDATE signal_history SET combo_key=?, risk_flags=? WHERE id=?`);
  let matched = 0, alreadyHad = 0, unmatched = 0;
  const unmatchedByIv = new Map<string, number>();
  const flagCounts = new Map<string, number>();
  const tx = db.transaction(() => {
    for (const r of rows) {
      const t = byKey.get(`${r.timestamp}|${r.interval}|${r.direction}`);
      if (!t) { unmatched++; unmatchedByIv.set(r.interval, (unmatchedByIv.get(r.interval) ?? 0) + 1); continue; }
      if (r.combo_key != null) { alreadyHad++; continue; } // live-engine-stamped — never clobber
      const flags = flagsOf(t);
      for (const f of flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
      if (!DRY) upd.run(t.comboKey, JSON.stringify(flags), r.id);
      matched++;
    }
  });
  tx();

  const inDbKeys = new Set(rows.map(r => `${r.timestamp}|${r.interval}|${r.direction}`));
  const jsonNotInDb = trades.filter(t => !inDbKeys.has(`${t.fireTs}|${t.interval}|${t.direction}`)).length;

  console.log(`[backfill] DB rows (${SYMBOL}): ${rows.length}`);
  console.log(`[backfill] matched+filled: ${matched}${DRY ? " (DRY RUN — nothing written)" : ""}; already had combo_key: ${alreadyHad}`);
  console.log(`[backfill] unmatched DB rows (no analysis record — display gracefully): ${unmatched}` +
    (unmatched ? `  [${[...unmatchedByIv.entries()].map(([iv, n]) => `${iv}=${n}`).join(" ")}]` : ""));
  console.log(`[backfill] analysis trades not in DB: ${jsonNotInDb}`);
  console.log(`[backfill] flag distribution over filled rows: ${[...flagCounts.entries()].map(([f, n]) => `${f}=${n}`).join("  ") || "(none)"}`);

  if (!DRY) {
    const post = db.prepare(
      `SELECT COUNT(*) n, SUM(CASE WHEN combo_key IS NOT NULL THEN 1 ELSE 0 END) withCombo FROM signal_history WHERE symbol=?`
    ).get(SYMBOL) as { n: number; withCombo: number };
    console.log(`[backfill] post: ${post.withCombo}/${post.n} rows carry combo_key`);
    const sample = db.prepare(
      `SELECT timestamp, interval, direction, combo_key, risk_flags FROM signal_history WHERE symbol=? AND combo_key IS NOT NULL ORDER BY RANDOM() LIMIT 3`
    ).all(SYMBOL);
    console.log(`[backfill] sample rows: ${JSON.stringify(sample)}`);
  }
  db.close();
}

main();
