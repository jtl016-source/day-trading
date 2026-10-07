/**
 * bestprogram-apply.ts — BEST-PROGRAM SHIP, data layer (2026-08-13; pairs with
 * bestprogram-gate-patch.ts — run AFTER it, with the SERVER STOPPED).
 *
 *   1. BACKUP: full signal_history copy → signal_history_pre_bestprogram_backup (abort if
 *      it exists — one immutable pre-ship record).
 *   2. STANDING 15m: delete blocked-combo rows (they live on in the backup); re-walk every
 *      surviving standing 15m row at the shipped geometry (TP = entry ± 10.5,
 *      SL = entry ∓ 26, tp2 null) from real 1m bars via the canonical resolver
 *      (tp1Only + carry, extending windows — no artificial horizon).
 *   3. BOOK: rebuild fact-engine-backtest-results.json signals from the post-ship DB
 *      standing window (all intervals) so the serving identity (V1) holds; old book
 *      backed up as fact-engine-backtest-results.pre-bestprogram.json.
 *   4. ALARM CALIBRATION: block-bootstrap P95 maxDD per 100 trades on the post-ship
 *      combined standing record — printed for the scheduler envelope.
 *
 * 1m/5m/60m are deliberately UNTOUCHED (final certification: the 1m block list is
 * era-anti-persistent across bases; 5m/60m have positive honest standing records).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { walkOutcomeCanonical } from "../shared/outcome-resolver";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd();
const OUT = artifactsDir(ROOT);
const BACKUP = "signal_history_pre_bestprogram_backup";
const BLOCKED = new Set(["Fr+YB", "Vec+YB", "Fr+Vec+YB", "ICT+YB", "Fr+ICT+YB", "FG+Fr+Vec+YB"]);
const TP = 10.5, SL = 26;
const nowSec = Math.floor(Date.now() / 1000);

const db = new Database(path.join(ROOT, "data", "app.db"));
db.pragma("journal_mode = WAL");
const barsStmt = db.prepare(
  `SELECT timestamp AS time, high, low, close FROM cached_candles
   WHERE symbol='MES' AND resolution='1' AND timestamp>=? AND timestamp<? ORDER BY timestamp`,
);

const bookPath = path.join(OUT, "fact-engine-backtest-results.json");
const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
const standingStart = book.meta.emissionStartTs as number;

// ── 1. backup ──
if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(BACKUP)) {
  console.error(`ABORT: ${BACKUP} exists`); process.exit(1);
}
db.exec(`CREATE TABLE ${BACKUP} AS SELECT * FROM signal_history`);
console.log(`[apply] backup ${BACKUP} created`);

// ── 2. standing 15m: delete blocked, re-walk survivors at 10.5/26 ──
const del = db.prepare(
  `DELETE FROM signal_history WHERE symbol='MES' AND interval='15m' AND timestamp>=? AND combo_key IN (${[...BLOCKED].map(() => "?").join(",")})`,
).run(standingStart, ...BLOCKED);
console.log(`[apply] removed ${del.changes} blocked-combo standing 15m rows (preserved in backup)`);

const rows = db.prepare(
  `SELECT id, timestamp, direction, entry FROM signal_history
   WHERE symbol='MES' AND interval='15m' AND timestamp>=? AND entry IS NOT NULL`,
).all(standingStart) as Array<{ id: number; timestamp: number; direction: string; entry: number }>;
const upd = db.prepare(
  `UPDATE signal_history SET tp1=?, tp2=NULL, sl=?, outcome=?, points_result=?, exit_price=?, exit_ts=?, mae=?, mfe=?, bars_to_exit=?, updated_at=? WHERE id=?`,
);
const updatedAt = new Date().toISOString();
const rnd2 = (v: number): number => Math.round(v * 100) / 100;
let rewalked = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    const isLong = r.direction.toLowerCase().startsWith("l");
    const entryTs = r.timestamp + 900;
    const tp1 = isLong ? r.entry + TP : r.entry - TP;
    const sl = isLong ? r.entry - SL : r.entry + SL;
    let w = null as ReturnType<typeof walkOutcomeCanonical> | null;
    for (const win of [5 * 86400, 20 * 86400, nowSec - entryTs + 86400]) {
      const bars = barsStmt.all(entryTs - 60, Math.min(entryTs + win, nowSec + 3600)) as Array<{ time: number; high: number; low: number; close: number }>;
      if (bars.length < 2) break;
      w = walkOutcomeCanonical({ bars, entryTs, entry: r.entry, tp1, tp2: null, sl, isLong, settleTs: 0, barSec: 60, coveredThroughTs: nowSec, tp1Only: true });
      const covered = bars[bars.length - 1].time + 60;
      if (!(w.outcome === "open" && covered < nowSec - 3600 && win !== nowSec - entryTs + 86400)) break;
    }
    if (!w) continue;
    const pts = w.exitPrice == null ? null : rnd2((w.exitPrice - r.entry) * (isLong ? 1 : -1));
    upd.run(rnd2(tp1), rnd2(sl), w.outcome, pts, w.exitPrice == null ? null : rnd2(w.exitPrice), w.exitTs,
      rnd2(w.mae), rnd2(w.mfe), w.exitTs == null ? null : Math.round(((w.exitTs - entryTs) / 900) * 100) / 100, updatedAt, r.id);
    rewalked++;
  }
});
tx();
console.log(`[apply] re-walked ${rewalked} surviving standing 15m rows at TP ${TP}/SL ${SL}`);

// ── 3. rebuild the book from the DB standing window ──
fs.writeFileSync(bookPath.replace(/\.json$/, ".pre-bestprogram.json"), JSON.stringify(book));
const OC: Record<string, string> = { win_tp1: "tp1", win_tp2: "tp2", loss: "sl", eod: "eod", open: "open" };
const dbRows = db.prepare(
  `SELECT * FROM signal_history WHERE symbol='MES' AND timestamp>=? ORDER BY timestamp`,
).all(standingStart) as Array<Record<string, unknown>>;
const IVS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };
const etTime = (ts: number | null): string => ts == null ? "" : new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts * 1000));
const etDate = (ts: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts * 1000));
book.signals = dbRows.map(r => {
  const ivSec = IVS[r.interval as string] ?? 60;
  const fireTs = r.timestamp as number;
  return {
    fireTs, entryTs: fireTs + ivSec, dateET: etDate(fireTs), timeET: etTime(fireTs),
    interval: r.interval, direction: r.direction,
    signalType: r.signal_type ?? "fact-engine",
    fullLabel: r.label ?? "", exitStrategy: `TP ${Math.abs((r.tp1 as number) - (r.entry as number)).toFixed(2)} @ ${(r.tp1 as number).toFixed(2)} (TP1-only), SL @ ${(r.sl as number).toFixed(2)}`,
    entry: r.entry, tp1: r.tp1, tp2: null, sl: r.sl,
    outcome: OC[(r.outcome as string) ?? "open"] ?? r.outcome,
    engineOutcome: OC[(r.outcome as string) ?? "open"] ?? r.outcome,
    exitPrice: r.exit_price, exitTs: r.exit_ts, exitTimeET: etTime(r.exit_ts as number | null),
    pointsResult: r.points_result, mae: r.mae, mfe: r.mfe, barsToExit: r.bars_to_exit,
    comboKey: r.combo_key, confirmations: r.confirmations, riskFlags: r.risk_flags ? JSON.parse(r.risk_flags as string) : [],
    suggestedContracts: r.suggested_contracts ?? 1,
    session: "", why: "", anchor: "", yellowboxContext: "", distFromSettle: null,
    year: new Date(fireTs * 1000).getUTCFullYear(), confidence: null,
  };
});
book.meta.bestProgramShip = {
  at: updatedAt,
  note: "15m: six combo blocks (Fr+YB, Vec+YB, Fr+Vec+YB, ICT+YB, Fr+ICT+YB, FG+Fr+Vec+YB) + exits TP 10.5/SL 26 (best-program lab, user-approved). 1m/5m/60m unchanged (1m block list failed cross-basis certification; 5m/60m standing records positive). Book rebuilt from the DB standing window.",
};
fs.writeFileSync(bookPath, JSON.stringify(book));
console.log(`[apply] book rebuilt from DB: ${book.signals.length} standing signals`);

// ── 4. alarm calibration on the post-ship combined standing record ──
const closed = dbRows.filter(r => r.outcome === "win_tp1" || r.outcome === "loss");
const net = closed.map(r => ((r.points_result as number) ?? 0) - 1.0);
let seed = 4242; const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const dds: number[] = [];
for (let i = 0; i < 5000; i++) {
  let c = 0, pk = 0, dd = 0;
  for (let f = 0; f < 100;) { const s = Math.floor(rnd() * Math.max(1, net.length - 10)); for (let j = 0; j < 10 && f < 100; j++, f++) { c += net[s + j] ?? 0; if (c > pk) pk = c; if (pk - c > dd) dd = pk - c; } }
  dds.push(dd);
}
dds.sort((a, b) => a - b);
const win = 100 * closed.filter(r => r.outcome === "win_tp1").length / closed.length;
const p95 = dds[Math.floor(0.95 * 5000)];
console.log(`[apply] post-ship combined standing: ${closed.length} closed, win ${win.toFixed(1)}%, net cum ${net.reduce((a, b) => a + b, 0).toFixed(1)}, bootstrap P95 DD/100 ${p95.toFixed(1)}`);
console.log(`[apply] suggested alarm envelope: DD <= ${Math.round(p95 * 1.15)}, win >= ${Math.round(win - 12)}`);
db.close();
console.log("[apply] DONE — run integrity-check + tests next.");
