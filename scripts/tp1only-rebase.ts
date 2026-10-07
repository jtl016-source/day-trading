/**
 * tp1only-rebase.ts — THE PERMANENT WIPE + TP1-ONLY REBASE (2026-08-13, user directive:
 * "wipe all signals permanently right now and replace them with the new exit strategies.
 * make sure nothing is fabricated").
 *
 * What it does, in order (run with the SERVER STOPPED — this performs DDL):
 *   1. BACKUP: full copy of signal_history → signal_history_pre_tp1only_backup (created once;
 *      aborts if it already exists so the true pre-policy records can never be overwritten).
 *   2. REBUILD: drops and recreates signal_history from its own stored CREATE statement with
 *      exactly one change — tp2 loses NOT NULL (the TP1-only policy stores tp2 = NULL).
 *      All indexes are recreated from sqlite_master.
 *   3. REBASE: every backup row with usable levels (entry/tp1/sl/direction) is re-resolved
 *      from REAL 1m bars via the canonical resolver in tp1Only+carry mode — a resting limit
 *      at TP1 + stop at SL, first touch decides, SL-first ties, rides until touched. Exit
 *      fields (price/ts/points/mae/mfe/bars) all come from the actual walk. tp2 = NULL,
 *      source = 'regen'. Rows that cannot be re-scored honestly (missing levels or no 1m
 *      coverage) are NOT re-created — they exist only in the backup, counted in the report.
 *   4. BOOK: fact-engine-backtest-results.json signals are transformed with the SAME walk
 *      (byte-identical to the DB — integrity-check V1 must hold), tp2 nulled, exit strategy
 *      text rewritten; the ledger expectation self-derives from the transformed signals.
 *   5. ERA COUNTS: full-history-regen.json era.n patched to the new per-year row counts so
 *      integrity-check V4/W-era stays exact.
 *
 * The walk uses EXTENDING windows (5d → 20d → 80d → to-now) so every historical trade
 * resolves against as much real data as it needs — no artificial horizon, no fabricated
 * "open" labels on ancient rows.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { walkOutcomeCanonical } from "../shared/outcome-resolver";
import { INTERVAL_SEC, type Interval } from "../shared/fact-engine";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data", "app.db");
const BACKUP = "signal_history_pre_tp1only_backup";
const OUT = artifactsDir(ROOT);
const DRY = process.argv.includes("--dry");
const nowSec = Math.floor(Date.now() / 1000);

const db = new Database(DB_PATH, { fileMustExist: true });
db.pragma("journal_mode = WAL");

interface Bar { time: number; high: number; low: number; close: number }
const barsStmt = db.prepare(
  `SELECT timestamp AS time, high, low, close FROM cached_candles
   WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<? ORDER BY timestamp`,
);

interface WalkOut {
  outcome: "win_tp1" | "loss" | "open";
  exitPrice: number | null; exitTs: number | null; points: number | null;
  mae: number; mfe: number; barsToExit: number | null;
}
const rnd2 = (v: number): number => Math.round(v * 100) / 100;

function rewalk(symbol: string, ts: number, interval: string, direction: string, entry: number, tp1: number, sl: number): WalkOut | null {
  const ivSec = INTERVAL_SEC[interval as Interval];
  if (!ivSec) return null;
  const entryTs = ts + ivSec;
  const isLong = direction.toLowerCase().startsWith("l");
  const windows = [5 * 86400, 20 * 86400, 80 * 86400, nowSec - entryTs + 86400];
  for (const w of windows) {
    const bars = barsStmt.all(symbol, entryTs - 60, Math.min(entryTs + w, nowSec + 3600)) as Bar[];
    if (bars.length < 2) return null; // no 1m coverage — cannot re-score honestly
    const r = walkOutcomeCanonical({
      bars, entryTs, entry, tp1, tp2: null, sl, isLong,
      settleTs: 0, barSec: 60, coveredThroughTs: nowSec, tp1Only: true,
    });
    const lastCovered = bars[bars.length - 1].time + 60;
    if (r.outcome === "open" && lastCovered < nowSec - 3600 && w !== windows[windows.length - 1]) {
      continue; // unresolved within this window but more data exists — extend
    }
    const pts = r.exitPrice == null ? null : rnd2((r.exitPrice - entry) * (isLong ? 1 : -1));
    return {
      outcome: r.outcome as WalkOut["outcome"],
      exitPrice: r.exitPrice == null ? null : rnd2(r.exitPrice),
      exitTs: r.exitTs, points: pts, mae: rnd2(r.mae), mfe: rnd2(r.mfe),
      barsToExit: r.exitTs == null ? null : Math.round(((r.exitTs - entryTs) / ivSec) * 100) / 100,
    };
  }
  return null;
}

async function main(): Promise<void> {
  // ── 1. backup ──
  const hasBackup = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(BACKUP);
  if (hasBackup) { console.error(`ABORT: ${BACKUP} already exists — the pre-policy record is sacred. Remove it manually only if you know why.`); process.exit(1); }
  const total = (db.prepare(`SELECT COUNT(*) n FROM signal_history`).get() as { n: number }).n;
  console.log(`[rebase] signal_history rows: ${total}`);
  if (DRY) { console.log("[rebase] DRY RUN — stopping before any write"); db.close(); return; }
  db.exec(`CREATE TABLE ${BACKUP} AS SELECT * FROM signal_history`);
  const backed = (db.prepare(`SELECT COUNT(*) n FROM ${BACKUP}`).get() as { n: number }).n;
  if (backed !== total) { console.error(`ABORT: backup row count ${backed} != ${total}`); process.exit(1); }
  console.log(`[rebase] backed up ${backed} rows → ${BACKUP}`);

  // ── 2. rebuild with tp2 nullable ──
  const createSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='signal_history'`).get() as { sql: string }).sql;
  if (!/tp2 REAL NOT NULL/.test(createSql)) console.log("[rebase] note: tp2 already nullable in stored schema");
  const newCreate = createSql.replace(/tp2 REAL NOT NULL/, "tp2 REAL");
  const indexSqls = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='signal_history' AND sql IS NOT NULL`).all() as Array<{ sql: string }>).map(r => r.sql);
  db.exec(`DROP TABLE signal_history`);
  db.exec(newCreate);
  for (const s of indexSqls) db.exec(s);
  console.log(`[rebase] rebuilt signal_history (tp2 nullable), ${indexSqls.length} index(es) restored`);

  // ── 3. re-walk every backup row ──
  const rows = db.prepare(`SELECT * FROM ${BACKUP} ORDER BY timestamp`).all() as Array<Record<string, unknown>>;
  const cols = (db.prepare(`PRAGMA table_info(signal_history)`).all() as Array<{ name: string }>).map(c => c.name).filter(c => c !== "id");
  const ins = db.prepare(`INSERT INTO signal_history (${cols.join(",")}) VALUES (${cols.map(c => "@" + c).join(",")})`);
  const updatedAt = new Date().toISOString();
  let inserted = 0, skippedLevels = 0, skippedCoverage = 0;
  const transitions: Record<string, number> = {};
  const insertMany = db.transaction((batch: Array<Record<string, unknown>>) => { for (const b of batch) ins.run(b); });
  let batch: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const entry = r.entry as number | null, tp1 = r.tp1 as number | null, sl = r.sl as number | null;
    const dirOk = typeof r.direction === "string" && /^(long|short)$/i.test(r.direction as string);
    if (!(typeof entry === "number" && typeof tp1 === "number" && typeof sl === "number" && dirOk)) { skippedLevels++; continue; }
    const w = rewalk(r.symbol as string, r.timestamp as number, r.interval as string, r.direction as string, entry, tp1, sl);
    if (!w) { skippedCoverage++; continue; }
    const key = `${(r.outcome as string) ?? "NULL"}→${w.outcome}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
    const nr: Record<string, unknown> = {};
    for (const c of cols) nr[c] = (r as Record<string, unknown>)[c] ?? null;
    nr.tp2 = null;
    nr.outcome = w.outcome;
    nr.points_result = w.points;
    nr.exit_price = w.exitPrice;
    nr.exit_ts = w.exitTs;
    nr.mae = w.mae; nr.mfe = w.mfe; nr.bars_to_exit = w.barsToExit;
    nr.source = "regen";
    nr.updated_at = updatedAt;
    batch.push(nr);
    if (batch.length >= 2000) { insertMany(batch); inserted += batch.length; batch = []; console.log(`[rebase] inserted ${inserted}/${rows.length}...`); }
  }
  if (batch.length) { insertMany(batch); inserted += batch.length; }
  console.log(`[rebase] REBASED ${inserted} rows; skipped ${skippedLevels} (no levels) + ${skippedCoverage} (no 1m coverage) — those live ONLY in ${BACKUP}`);
  console.log(`[rebase] outcome transitions: ${JSON.stringify(transitions)}`);

  // ── 4. transform the standing book ──
  const bookPath = path.join(OUT, "fact-engine-backtest-results.json");
  const doc = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  fs.writeFileSync(bookPath.replace(/\.json$/, ".pre-tp1only.json"), JSON.stringify(doc)); // book backup
  const OC_DB_TO_BOOK: Record<string, string> = { win_tp1: "tp1", loss: "sl", open: "open" };
  const etTime = (ts: number | null): string => ts == null ? "" : new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts * 1000));
  let bookChanged = 0, bookSkipped = 0;
  for (const s of doc.signals) {
    const w = rewalk(doc.meta.symbol ?? "MES", s.fireTs, s.interval, s.direction, s.entry, s.tp1, s.sl);
    if (!w) { bookSkipped++; continue; }
    s.outcome = OC_DB_TO_BOOK[w.outcome];
    s.engineOutcome = s.outcome;
    s.pointsResult = w.points;
    s.exitPrice = w.exitPrice; s.exitTs = w.exitTs; s.exitTimeET = etTime(w.exitTs);
    s.mae = w.mae; s.mfe = w.mfe;
    s.barsToExit = w.exitTs == null ? null : Math.round(((w.exitTs - s.entryTs) / (INTERVAL_SEC[s.interval as Interval] ?? 60)) * 100) / 100;
    s.tp2 = null;
    const tp1d = Math.abs(s.tp1 - s.entry), sld = Math.abs(s.sl - s.entry);
    s.exitStrategy = `TP ${tp1d.toFixed(2)} @ ${s.tp1.toFixed(2)} (TP1-only), SL ${sld.toFixed(2)} @ ${s.sl.toFixed(2)}`;
    bookChanged++;
  }
  doc.meta.tp1OnlyRebase = { at: new Date().toISOString(), note: "TP1-ONLY EXECUTABLE POLICY — every outcome re-resolved from 1m bars as a resting TP1 limit + SL stop (OCO), carry until touch. win_tp2/eod vocab retired (tolerated, never produced)." };
  fs.writeFileSync(bookPath, JSON.stringify(doc));
  console.log(`[rebase] book transformed: ${bookChanged} signals re-scored, ${bookSkipped} unwalkable (left as-was)`);

  // ── 5. patch full-history era counts ──
  try {
    const fhPath = path.join(OUT, "full-history-regen.json");
    const fh = JSON.parse(fs.readFileSync(fhPath, "utf8"));
    const winStart = doc.meta.emissionStartTs as number;
    const byYr = db.prepare(
      `SELECT CAST(strftime('%Y', timestamp, 'unixepoch') AS TEXT) yr, COUNT(*) n
       FROM signal_history WHERE timestamp < ? GROUP BY yr`,
    ).all(winStart) as Array<{ yr: string; n: number }>;
    if (fh.era) {
      for (const { yr, n } of byYr) if (fh.era[yr]) fh.era[yr].n = n;
      fh.tp1OnlyRebase = doc.meta.tp1OnlyRebase;
      fs.writeFileSync(fhPath, JSON.stringify(fh));
      console.log(`[rebase] full-history era counts patched: ${JSON.stringify(byYr)}`);
    }
  } catch (e) { console.warn(`[rebase] era patch skipped: ${(e as Error).message}`); }

  // ── summary of the new serving truth ──
  const summary = db.prepare(
    `SELECT interval, COUNT(*) n,
            SUM(CASE WHEN outcome='win_tp1' THEN 1 ELSE 0 END) wins,
            SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) losses,
            SUM(CASE WHEN outcome='open' THEN 1 ELSE 0 END) opens,
            ROUND(SUM(COALESCE(points_result,0)), 1) gross
     FROM signal_history WHERE timestamp >= ? GROUP BY interval`,
  ).all(doc.meta.emissionStartTs) as Array<Record<string, unknown>>;
  console.log("[rebase] STANDING WINDOW BY INTERVAL (gross pts):");
  for (const s of summary) console.log("   ", JSON.stringify(s));
  db.close();
  console.log("[rebase] DONE — run integrity-check next.");
}

main().catch(e => { console.error(e); process.exit(2); });
