/**
 * deadtape-dir-sweep.ts — DEAD-TAPE DIRECTIONALITY EXEMPTION SWEEP (2026-08-12, user:
 * "block bad trades but still trade" — the journal's [dead-tape-trend-blindspot] hypothesis
 * finally measured). SIMULATION ONLY — shipped gate + shipped exits; the ONLY knob is the
 * analysis-only exemption: a quiet-tape bar trades anyway when the session's net drift so
 * far ≥ X × its range so far (quiet-TRENDING days trade; quiet-CHOP days stay suppressed).
 *
 * X grid: null (shipped — the self-check must reproduce the standing book EXACTLY),
 * 0.6 / 0.5 / 0.4 / 0.3 (strict → loose). Day-sequential loss stop applied; per-interval
 * sleeves + added-vs-shipped delta outcomes; NET of friction. Writes deadtape-dir-sweep.json.
 *
 * Usage: npx tsx scripts/deadtape-dir-sweep.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { QUALITY_GATE } from "../shared/quality-gate";
import { setDeadTapeDirExemptForAnalysis, DEAD_TAPE_DIR_EXEMPT } from "../shared/fact-engine";
import {
  loadData, enginePass, resolveSignal, metricsOf, applyDailyLossStop,
  INTERVALS, DAILY_LOSS_STOP_PTS, type SigRow,
} from "./fact-engine-backtest";
import { artifactsDir } from "../shared/artifacts-dir";

const OUT = path.join(artifactsDir(process.cwd()), "deadtape-dir-sweep.json");
const GRID: Array<number | null> = [null, 0.6, 0.5, 0.4, 0.3];
const rnd2 = (v: number): number => Math.round(v * 100) / 100;
const rowKey = (r: SigRow): string => `${r.interval}|${r.fireTs}|${r.direction}`;

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const calibrated = new Set(Object.keys(QUALITY_GATE.exitByClass ?? {}));
  const results: Record<string, unknown>[] = [];
  let shippedRows: SigRow[] = [];
  let shippedKeys = new Set<string>();

  for (const x of GRID) {
    setDeadTapeDirExemptForAnalysis(x);
    const byIv = enginePass(L, { gate: true, gateData: QUALITY_GATE, label: `dir=${x ?? "off"}` }, nowSec);
    const preStop: SigRow[] = [];
    for (const iv of INTERVALS) for (const sig of byIv[iv]) preStop.push(resolveSignal(sig, L, nowSec, calibrated));
    preStop.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
    const stop = applyDailyLossStop(preStop, DAILY_LOSS_STOP_PTS);
    const rows = stop.kept.filter(r => r.outcome !== "open");
    const m = metricsOf(rows);
    const byInterval: Record<string, unknown> = {};
    for (const iv of INTERVALS) {
      const im = metricsOf(rows.filter(r => r.interval === iv));
      byInterval[iv] = { n: im.count, winPct: rnd2(im.winRate * 100), exp: rnd2(im.expectancy), pf: rnd2(im.profitFactor), cum: rnd2(im.cumPts), maxDD: rnd2(im.maxDD) };
    }
    const res: Record<string, unknown> = {
      x, shipped: x === null,
      asTraded: rows.length, trippedDays: stop.trippedDays.length,
      winPct: rnd2(m.winRate * 100), exp: rnd2(m.expectancy), netExp: rnd2(m.netExpectancy),
      pf: rnd2(m.profitFactor), netPf: rnd2(m.netProfitFactor), cum: rnd2(m.cumPts), netCum: rnd2(m.netCumPts), maxDD: rnd2(m.maxDD),
      byInterval,
    };
    if (x === null) { shippedRows = rows; shippedKeys = new Set(rows.map(rowKey)); }
    else {
      const added = rows.filter(r => !shippedKeys.has(rowKey(r)));
      const w = added.filter(r => (r.pointsResult ?? 0) > 0).length;
      const l = added.filter(r => (r.pointsResult ?? 0) < 0).length;
      res.addedVsShipped = { n: added.length, wins: w, losses: l, pts: rnd2(added.reduce((s, r) => s + (r.pointsResult ?? 0), 0)) };
      const addedDays = new Set(added.map(r => r.sessionDay)).size;
      (res.addedVsShipped as Record<string, unknown>).days = addedDays;
    }
    results.push(res);
    console.log(`[dir-sweep] X=${x ?? "off(shipped)"}: n=${rows.length} win ${res.winPct}% exp ${res.exp} (net ${res.netExp}) PF ${res.pf} cum ${res.cum} (net ${res.netCum}) maxDD ${res.maxDD} tripped ${stop.trippedDays.length}` +
      (res.addedVsShipped ? ` | added ${(res.addedVsShipped as any).n} (${(res.addedVsShipped as any).wins}W/${(res.addedVsShipped as any).losses}L, ${(res.addedVsShipped as any).pts >= 0 ? "+" : ""}${(res.addedVsShipped as any).pts} pts over ${(res.addedVsShipped as any).days} days)` : ""));
  }
  setDeadTapeDirExemptForAnalysis(DEAD_TAPE_DIR_EXEMPT); // restore the SHIPPED default (2026-08-12)
  void shippedRows;

  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    note: "SIMULATED — shipped gate/exits; only the directionality exemption moves. X = min |session drift| / |range so far| for a quiet-tape bar to trade. Carry-overnight resolution (current record contract); open rows excluded.",
    grid: GRID, results,
  }, null, 2));
  console.log(`[dir-sweep] artifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
