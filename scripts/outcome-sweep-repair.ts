// scripts/outcome-sweep-repair.ts
// ═════════════════════════════════════════════════════════════════════════════
// PERSISTED-OUTCOME SWEEP + REPAIR under the CANONICAL resolver (2026-07-31).
//
// Re-walks EVERY persisted trade record — the signal_history window rows AND the
// standing deliverables (fact-engine-backtest-results.json / -signals.csv) — with
// shared/outcome-resolver.ts walkOutcomeCanonical over the harness's own 1m chain
// (loadData: the serving-mirror filter path the regen itself walks), then corrects
// any stored outcome that violates first-touch semantics:
//   • VIOLATION   — stored loss where the 1m walk shows TP1 touched first (the
//                   2026-07-31 09:15 ET false record), stored win where SL was
//                   first, stored eod where a level WAS touched, etc.
//   • UPGRADE     — stored win_tp1 where TP2 was later reached with NO SL touch
//                   in between (the new tp1 → tp2 watch; old walks broke at TP1).
//   • OPEN-RESOLVE— stored open whose session has since resolved.
//   • DETAIL-FIX  — outcome already correct but exit fields drifted from the 1m
//                   record (live rows resolved on coarse primary bars).
//
// Fire-time gating is UNTOUCHED: this never re-fires the engine, never re-derives
// gate verdicts, never adds/removes rows — outcomes/exit detail only.
//
// Usage:
//   npx tsx scripts/outcome-sweep-repair.ts            (dry-run — report only)
//   npx tsx scripts/outcome-sweep-repair.ts --apply    (backup + write corrections)
//
// Backups (refreshed per --apply run):
//   • DB:   signal_history_backup_pre_outcome_repair (full table copy)
//   • JSON: data/fact-engine-backtest-results.pre-outcome-repair.json
// ═════════════════════════════════════════════════════════════════════════════
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadData, writeCsv, metricsOf, type SigRow } from "./fact-engine-backtest";
import { walkOutcomeCanonical, type CanonicalOutcome } from "../shared/outcome-resolver";
import { INTERVAL_SEC, FACT_ENGINE_DEFAULTS, type Interval } from "../shared/fact-engine";
import { classKey } from "../shared/quality-gate";
import { etParts, etWallToEpoch, sessionDayKey, rnd2 } from "../shared/yellowbox-core";

const APPLY = process.argv.includes("--apply");
const DB_PATH = path.join(process.cwd(), "data", "app.db");
const OUT_JSON = path.join(process.cwd(), "fact-engine-backtest-results.json");
const JSON_BACKUP = path.join(process.cwd(), "data", "fact-engine-backtest-results.pre-outcome-repair.json");

const pad = (n: number): string => String(n).padStart(2, "0");
const fmtEt = (t: number): string => {
  const q = etParts(t);
  return `${q.y}-${pad(q.mo)}-${pad(q.d)} ${pad(q.hh)}:${pad(q.mm)}`;
};

interface CanonRecord {
  outcome: CanonicalOutcome;
  exitPrice: number | null; exitTs: number | null; pointsResult: number | null;
  mae: number; mfe: number; barsToExit: number | null;
}

function main(): void {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`[sweep] ${APPLY ? "APPLY" : "DRY-RUN"} @ ${new Date().toISOString()}`);
  const L = loadData();
  const covered = Math.min(L.lastDataTs, nowSec);

  // ── 1M-COVERAGE GUARD (left edge) ─────────────────────────────────────────
  // loadData's 1m chain is a ROLLING lookback — its left edge advances daily (today it
  // starts 2 days after the standing regen's). A trade whose entry PREDATES the 1m series
  // cannot be re-walked honestly (zero/partial bars fabricate "eod"/missed touches — the
  // Apr-17 dry-run artifact, hand-verified against raw cached_candles: stored values were
  // CORRECT there). Such rows are SKIPPED and their stored record stands.
  const c1mStartTs = L.c1m.length ? L.c1m[0].time : Infinity;
  const covers = (fireTs: number, interval: string): boolean =>
    c1mStartTs <= fireTs + (INTERVAL_SEC[interval as Interval] ?? 60);
  let skippedNoCoverage = 0;

  /** The canonical 1m record for a persisted trade (stored levels are the contract). */
  const canonOf = (fireTs: number, interval: string, direction: string, entry: number, tp1: number, tp2: number | null, sl: number): CanonRecord => {
    const ivSec = INTERVAL_SEC[interval as Interval] ?? 60;
    const entryTs = fireTs + ivSec;
    const settleTs = etWallToEpoch(sessionDayKey(entryTs), 17, 0);
    const isLong = direction.toLowerCase() === "long";
    // TP1-ONLY (2026-08-13): repairs score under the live policy; tp2 may be null post-policy.
    const w = walkOutcomeCanonical({ bars: L.c1m, entryTs, entry, tp1, tp2, sl, isLong, settleTs, barSec: 60, coveredThroughTs: covered, tp1Only: FACT_ENGINE_DEFAULTS.TP1_ONLY });
    return {
      outcome: w.outcome,
      exitPrice: w.exitPrice == null ? null : rnd2(w.exitPrice),
      exitTs: w.exitTs,
      pointsResult: w.exitPrice == null ? null : rnd2((w.exitPrice - entry) * (isLong ? 1 : -1)),
      mae: rnd2(w.mae), mfe: rnd2(w.mfe),
      barsToExit: w.exitTs == null ? null : Math.round(((w.exitTs - entryTs) / ivSec) * 100) / 100,
    };
  };

  const neq = (a: number | null, b: number | null): boolean =>
    (a == null) !== (b == null) || (a != null && b != null && Math.abs(a - b) > 0.005);

  // ════════════════ PART 1 — signal_history (the live record) ═══════════════
  const db = new Database(DB_PATH, { fileMustExist: true });
  db.pragma("busy_timeout = 15000");
  const winStart: number = (JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as { meta: { emissionStartTs: number } }).meta.emissionStartTs;
  const rows = db.prepare(
    `SELECT id, symbol, interval, timestamp, direction, entry, tp1, tp2, sl, outcome,
            exit_price, exit_ts, points_result, mae, mfe, bars_to_exit
       FROM signal_history WHERE symbol='MES' AND timestamp >= ? ORDER BY timestamp`,
  ).all(winStart) as Array<{
    id: number; symbol: string; interval: string; timestamp: number; direction: string;
    entry: number; tp1: number; tp2: number; sl: number; outcome: string | null;
    exit_price: number | null; exit_ts: number | null; points_result: number | null;
    mae: number | null; mfe: number | null; bars_to_exit: number | null;
  }>;
  const otherSym = (db.prepare(`SELECT COUNT(*) n FROM signal_history WHERE symbol<>'MES' AND timestamp >= ?`).get(winStart) as { n: number }).n;
  console.log(`[sweep] DB window rows (MES, ts>=${winStart}): ${rows.length}${otherSym ? `  (+${otherSym} non-MES rows skipped)` : ""}`);

  type Fix = {
    id: number; ts: number; et: string; interval: string; direction: string; cls: string;
    oldOutcome: string | null; newOutcome: string; oldPts: number | null; newPts: number | null;
    rec: CanonRecord;
  };
  const dbFixes: Fix[] = [];
  const cnt = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };
  const dbBefore: Record<string, number> = {}, dbAfter: Record<string, number> = {};
  for (const r of rows) {
    const stored = r.outcome ?? "open";
    cnt(dbBefore, stored);
    if (!covers(r.timestamp, r.interval)) {
      skippedNoCoverage++;
      cnt(dbAfter, stored);
      console.log(`  [SKIP no-1m-coverage] id=${r.id} ${fmtEt(r.timestamp)} ET ${r.interval} ${r.direction}: stored ${stored} stands (1m chain starts ${fmtEt(c1mStartTs)} ET)`);
      continue;
    }
    const rec = canonOf(r.timestamp, r.interval, r.direction, r.entry, r.tp1, r.tp2, r.sl);
    cnt(dbAfter, rec.outcome);
    let cls: string | null = null;
    if (stored !== rec.outcome) {
      if (stored === "win_tp1" && rec.outcome === "win_tp2") cls = "UPGRADE tp1->tp2";
      else if (stored === "open" && rec.outcome !== "open") cls = "OPEN-RESOLVE";
      else cls = "VIOLATION";
    } else if (stored !== "open" && (neq(r.exit_price, rec.exitPrice) || neq(r.points_result, rec.pointsResult) || (r.exit_ts ?? null) !== rec.exitTs)) {
      cls = "DETAIL-FIX";
    }
    if (cls) {
      dbFixes.push({
        id: r.id, ts: r.timestamp, et: fmtEt(r.timestamp), interval: r.interval, direction: r.direction, cls,
        oldOutcome: r.outcome, newOutcome: rec.outcome, oldPts: r.points_result, newPts: rec.pointsResult, rec,
      });
    }
  }
  console.log(`[sweep] DB outcome counts BEFORE: ${JSON.stringify(dbBefore)}`);
  console.log(`[sweep] DB outcome counts AFTER : ${JSON.stringify(dbAfter)}`);
  console.log(`[sweep] DB corrections needed: ${dbFixes.length}`);
  for (const f of dbFixes) {
    console.log(
      `  [${f.cls}] id=${f.id} ${f.et} ET ${f.interval} ${f.direction}: ` +
      `${f.oldOutcome ?? "NULL"} -> ${f.newOutcome}, pts ${f.oldPts ?? "-"} -> ${f.newPts ?? "-"}, ` +
      `exit ${f.rec.exitPrice ?? "-"} @ ${f.rec.exitTs ? fmtEt(f.rec.exitTs) : "-"} ET`,
    );
  }

  if (APPLY && dbFixes.length) {
    // Backup is create-once: a re-run must NEVER overwrite the original pre-repair snapshot.
    const bkExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='signal_history_backup_pre_outcome_repair'`).get();
    if (!bkExists) db.exec(`CREATE TABLE signal_history_backup_pre_outcome_repair AS SELECT * FROM signal_history`);
    const bk = (db.prepare(`SELECT COUNT(*) n FROM signal_history_backup_pre_outcome_repair`).get() as { n: number }).n;
    console.log(`[sweep] backup: signal_history_backup_pre_outcome_repair (${bk} rows${bkExists ? ", pre-existing — kept" : ""})`);
    const upd = db.prepare(
      `UPDATE signal_history SET outcome=@outcome, exit_price=@exitPrice, exit_ts=@exitTs,
              points_result=@pointsResult, mae=@mae, mfe=@mfe, bars_to_exit=@barsToExit, updated_at=@updatedAt
        WHERE id=@id`,
    );
    const updatedAt = new Date().toISOString();
    const tx = db.transaction((fs2: Fix[]) => {
      for (const f of fs2) upd.run({ id: f.id, outcome: f.newOutcome, ...f.rec, updatedAt });
    });
    tx(dbFixes);
    console.log(`[sweep] DB: ${dbFixes.length} rows corrected (direct write — canonical-resolver values; backup taken)`);
  }
  db.close();

  // ════════════════ PART 2 — the standing deliverables (JSON/CSV) ═══════════
  const doc = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as {
    meta: Record<string, unknown> & {
      beforeAfter: { after: { trades: number; expectancy: number; pf: number; cumPts: number; winRate: number } };
      fgFactStats: Array<{ kind: string; display: string; trades: number; winRatePct: number; expectancy: number }>;
      calibration: Array<{ cls: string; expAfter?: number; pfAfter?: number }>;
      comboCalibration: Array<{ key: string; nFinal?: number; expFinal?: number; pfFinal?: number }>;
    };
    signals: SigRow[];
    solo: { vector: SigRow[]; yellowbox: SigRow[]; footprint: SigRow[] };
  };

  // SANITY (byte-exact metric check BEFORE mutating): our metricsOf usage must reproduce the
  // standing headline from the standing rows — else abort (the risk-factor-analysis lesson).
  const m0 = metricsOf(doc.signals);
  const ba = doc.meta.beforeAfter.after;
  if (m0.count !== ba.trades || m0.expectancy !== ba.expectancy || m0.profitFactor !== ba.pf || m0.cumPts !== ba.cumPts) {
    throw new Error(`standing-headline sanity check FAILED: metricsOf(signals)=${JSON.stringify({ n: m0.count, exp: m0.expectancy, pf: m0.profitFactor, cum: m0.cumPts })} vs meta.beforeAfter.after=${JSON.stringify(ba)}`);
  }
  console.log(`[sweep] standing-headline sanity: metricsOf == beforeAfter.after (${m0.count} trades, exp ${m0.expectancy}, PF ${m0.profitFactor}) OK`);

  // Harness vocabulary mapping (JSON rows use tp1/tp2/sl/eod/open).
  const CANON_TO_HARNESS: Record<CanonicalOutcome, string> = { win_tp1: "tp1", win_tp2: "tp2", loss: "sl", eod: "eod", open: "open" };
  const jsonBefore: Record<string, number> = {}, jsonAfter: Record<string, number> = {};
  const jsonFixes: Array<{ where: string; et: string; interval: string; direction: string; cls: string; old: string; nw: string; oldPts: number | null; newPts: number | null }> = [];
  const sweepRows = (rowsArr: SigRow[], where: string, tally: boolean): number => {
    let changed = 0;
    for (const r of rowsArr) {
      if (!covers(r.fireTs, r.interval)) {
        skippedNoCoverage++;
        if (tally) { cnt(jsonBefore, r.outcome); cnt(jsonAfter, r.outcome); }
        continue; // stored record stands — see the 1M-COVERAGE GUARD note above
      }
      const rec = canonOf(r.fireTs, r.interval, r.direction, r.entry, r.tp1, r.tp2, r.sl);
      const nw = CANON_TO_HARNESS[rec.outcome];
      if (tally) { cnt(jsonBefore, r.outcome); cnt(jsonAfter, nw); }
      const detailDrift = r.outcome === nw && r.outcome !== "open" &&
        (neq(r.exitPrice, rec.exitPrice) || neq(r.pointsResult, rec.pointsResult) || (r.exitTs ?? null) !== rec.exitTs);
      if (r.outcome === nw && !detailDrift) continue;
      const cls = r.outcome === nw ? "DETAIL-FIX"
        : r.outcome === "tp1" && nw === "tp2" ? "UPGRADE tp1->tp2"
        : r.outcome === "open" && nw !== "open" ? "OPEN-RESOLVE"
        : "VIOLATION";
      jsonFixes.push({ where, et: `${r.dateET} ${r.timeET}`, interval: r.interval, direction: r.direction, cls, old: r.outcome, nw, oldPts: r.pointsResult, newPts: rec.pointsResult });
      r.outcome = nw as SigRow["outcome"];
      r.exitPrice = rec.exitPrice;
      r.exitTs = rec.exitTs;
      r.exitTimeET = rec.exitTs == null ? "" : fmtEt(rec.exitTs);
      r.pointsResult = rec.pointsResult;
      r.mae = rec.mae; r.mfe = rec.mfe;
      r.barsToExit = rec.barsToExit;
      changed++;
    }
    return changed;
  };
  const nSig = sweepRows(doc.signals, "signals", true);
  const nSoloV = sweepRows(doc.solo.vector, "solo.vector", false);
  const nSoloY = sweepRows(doc.solo.yellowbox, "solo.yellowbox", false);
  const nSoloF = sweepRows(doc.solo.footprint, "solo.footprint", false);
  console.log(`[sweep] JSON outcome counts BEFORE: ${JSON.stringify(jsonBefore)}`);
  console.log(`[sweep] JSON outcome counts AFTER : ${JSON.stringify(jsonAfter)}`);
  console.log(`[sweep] JSON corrections: signals=${nSig} soloV=${nSoloV} soloY=${nSoloY} soloF=${nSoloF}`);
  for (const f of jsonFixes.filter(x => x.where === "signals")) {
    console.log(`  [${f.cls}] ${f.et} ET ${f.interval} ${f.direction}: ${f.old} -> ${f.nw}, pts ${f.oldPts ?? "-"} -> ${f.newPts ?? "-"}`);
  }

  // Meta refresh — ONLY the blocks derived from doc.signals (gate verdicts / exits / diagnostic
  // passes are pinned fire-time decisions and are NOT re-derived here — see the header).
  const m1 = metricsOf(doc.signals);
  doc.meta.beforeAfter.after = { trades: m1.count, expectancy: m1.expectancy, pf: m1.profitFactor, cumPts: m1.cumPts, winRate: rnd2(m1.winRate * 100) };
  const FG_FRAGS: Record<string, string> = {
    "reclaim": "FG Reclaim", "flat-bounce": "FG FlatBounce", "compression": "FG Compression",
    "wave-room": "FG WaveRoom", "prior-close-cross": "FG PriorClose",
  };
  for (const s of doc.meta.fgFactStats) {
    const frag = FG_FRAGS[s.kind];
    if (!frag) continue;
    const own = doc.signals.filter(r => r.fullLabel.includes(frag));
    const m = metricsOf(own);
    s.trades = own.length; s.winRatePct = rnd2(m.winRate * 100); s.expectancy = m.expectancy;
  }
  for (const c of doc.meta.calibration) {
    const after = doc.signals.filter(r => classKey(r.signalType, r.interval) === c.cls);
    const mA = metricsOf(after);
    c.expAfter = mA.expectancy; c.pfAfter = mA.profitFactor;
  }
  for (const cc of doc.meta.comboCalibration) {
    const combo = cc.key.slice(0, cc.key.lastIndexOf("@")), iv = cc.key.slice(cc.key.lastIndexOf("@") + 1);
    const own = doc.signals.filter(r => (r as SigRow & { combo?: string }).combo === combo && r.interval === iv);
    const m = metricsOf(own);
    cc.nFinal = m.count; cc.expFinal = m.expectancy; cc.pfFinal = m.profitFactor;
  }
  console.log(`[sweep] headline: ${ba.trades} trades exp ${ba.expectancy} PF ${ba.pf} cum ${ba.cumPts} win% ${ba.winRate}  ->  ${m1.count} trades exp ${m1.expectancy} PF ${m1.profitFactor} cum ${m1.cumPts} win% ${rnd2(m1.winRate * 100)}`);

  if (APPLY) {
    // Create-once (same rule as the DB backup): keep the ORIGINAL pre-repair snapshot.
    if (!fs.existsSync(JSON_BACKUP)) fs.copyFileSync(OUT_JSON, JSON_BACKUP);
    console.log(`[sweep] backup: ${JSON_BACKUP}${fs.existsSync(JSON_BACKUP) ? "" : " (created)"}`);
    fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 1));
    console.log(`[sweep] wrote ${OUT_JSON} (${(fs.statSync(OUT_JSON).size / 1e6).toFixed(1)} MB)`);
    writeCsv(doc.signals);
    console.log(`[sweep] wrote fact-engine-backtest-signals.csv (${doc.signals.length} rows)`);
  }

  console.log(`[sweep] ${APPLY ? "APPLIED" : "DRY-RUN COMPLETE"} — db fixes ${dbFixes.length}, json fixes ${nSig + nSoloV + nSoloY + nSoloF}, skipped (no 1m coverage, stored stands) ${skippedNoCoverage}`);
}

main();
