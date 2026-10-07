/**
 * dead-tape-sweep.ts — DEAD-TAPE STRICTNESS SWEEP, SIMULATION ONLY (2026-08-10, user asks
 * "is 0.6 too strict?"). Runs the harness FINAL pass (SHIPPED quality gate, SHIPPED calibrated
 * exits — nothing re-derived) at several dead-tape multipliers via the analysis-only
 * setDeadTapeMultForAnalysis mutator, then the day-sequential DAILY LOSS STOP, and compares
 * as-traded results overall + per interval. The ONLY knob that moves between passes is the
 * dead-tape multiplier; 0 = suppression effectively off, 0.6 = shipped.
 *
 * NO gate write, NO persist, NO standing-artifact overwrite — output is dead-tape-sweep.json
 * in the artifacts dir plus a console table. Also reports, for each looser factor, the DELTA
 * trades vs shipped (the trades dead-tape currently suppresses) and their outcomes — the
 * actual question: are the suppressed trades good?
 *
 * Usage: npx tsx scripts/dead-tape-sweep.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { QUALITY_GATE } from "../shared/quality-gate";
import { setDeadTapeMultForAnalysis, DEAD_TAPE_SUPPRESS_MULT } from "../shared/fact-engine";
import {
  loadData, enginePass, resolveSignal, metricsOf, applyDailyLossStop,
  INTERVALS, DAILY_LOSS_STOP_PTS, FRICTION_PTS_PER_TRADE,
  type SigRow,
} from "./fact-engine-backtest";
import { artifactsDir } from "../shared/artifacts-dir";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const OUT = path.join(artifactsDir(ROOT), "dead-tape-sweep.json");

const FACTORS = [0, 0.3, 0.45, 0.6, 0.75]; // 0 = off · 0.6 = shipped
const rnd2 = (v: number): number => Math.round(v * 100) / 100;
const rowKey = (r: SigRow): string => `${r.interval}|${r.fireTs}|${r.direction}`;

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const calibratedClasses = new Set(Object.keys(QUALITY_GATE.exitByClass ?? {}));

  interface FactorResult {
    factor: number; shipped: boolean;
    preStop: number; asTraded: number; trippedDays: number;
    overall: ReturnType<typeof metricsOf> & { netExp: number; netCum: number };
    byInterval: Record<string, { n: number; winPct: number; exp: number; pf: number; cum: number; maxDD: number }>;
    addedVsShipped?: { n: number; wins: number; losses: number; eod: number; pts: number; byIv: Record<string, number> };
    rows?: SigRow[];
  }
  const results: FactorResult[] = [];
  let shippedRows: SigRow[] = [];

  for (const factor of FACTORS) {
    setDeadTapeMultForAnalysis(factor);
    const byIv = enginePass(L, { gate: true, gateData: QUALITY_GATE, label: `DT×${factor}` }, nowSec);
    const preStop: SigRow[] = [];
    for (const iv of INTERVALS) for (const sig of byIv[iv]) preStop.push(resolveSignal(sig, L, nowSec, calibratedClasses));
    preStop.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
    const stop = applyDailyLossStop(preStop, DAILY_LOSS_STOP_PTS);
    const rows = stop.kept;

    const m = metricsOf(rows);
    const byInterval: FactorResult["byInterval"] = {};
    for (const iv of INTERVALS) {
      const ivRows = rows.filter(r => r.interval === iv);
      const im = metricsOf(ivRows);
      byInterval[iv] = { n: ivRows.length, winPct: rnd2(im.winRate), exp: rnd2(im.expectancy), pf: rnd2(im.profitFactor), cum: rnd2(im.cumPts), maxDD: rnd2(im.maxDD) };
    }
    const res: FactorResult = {
      factor, shipped: factor === DEAD_TAPE_SUPPRESS_MULT,
      preStop: preStop.length, asTraded: rows.length, trippedDays: stop.trippedDays.length,
      overall: { ...m, netExp: rnd2(m.netExpectancy), netCum: rnd2(m.netCumPts) },
      byInterval, rows,
    };
    results.push(res);
    if (res.shipped) shippedRows = rows;
    console.log(`[dt-sweep] ×${factor}${res.shipped ? " (shipped)" : ""}: ${rows.length} as-traded, win ${rnd2(m.winRate)}%, exp ${rnd2(m.expectancy)}, PF ${rnd2(m.profitFactor)}, cum ${rnd2(m.cumPts)}, tripped ${stop.trippedDays.length}`);
  }
  setDeadTapeMultForAnalysis(DEAD_TAPE_SUPPRESS_MULT); // restore — module stays clean

  // Delta vs shipped: the trades each looser factor ADMITS that 0.6 suppresses.
  const shippedKeys = new Set(shippedRows.map(rowKey));
  for (const res of results) {
    if (res.shipped) { delete res.rows; continue; }
    const added = (res.rows ?? []).filter(r => !shippedKeys.has(rowKey(r)));
    const byIv: Record<string, number> = {};
    for (const r of added) byIv[r.interval] = (byIv[r.interval] ?? 0) + 1;
    res.addedVsShipped = {
      n: added.length,
      wins: added.filter(r => r.outcome === "tp1" || r.outcome === "tp2").length,
      losses: added.filter(r => r.outcome === "sl").length,
      eod: added.filter(r => r.outcome === "eod").length,
      pts: rnd2(added.reduce((s, r) => s + (r.pointsResult ?? 0), 0)),
      byIv,
    };
    delete res.rows;
  }

  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    note: "SIMULATED analysis only — shipped gate + shipped exits; only the dead-tape multiplier moves; daily loss stop applied day-sequentially; NET = exp − friction. addedVsShipped counts differ from asTraded deltas where loss-stop day dynamics shift.",
    shippedMult: DEAD_TAPE_SUPPRESS_MULT, factors: FACTORS, results,
  }, null, 2));

  console.log(`\nfactor | asTraded | win% | exp | netExp | PF | cum | 15m: n/win%/exp/PF/maxDD | added vs shipped (n, W/L/E, pts)`);
  for (const r of results) {
    const iv = r.byInterval["15m"];
    const a = r.addedVsShipped;
    console.log(
      `×${String(r.factor).padEnd(4)}${r.shipped ? "*" : " "}| ${String(r.asTraded).padStart(5)} | ${r.overall.winRate.toFixed(1)}% | ${r.overall.expectancy.toFixed(2)} | ${r.overall.netExp.toFixed(2)} | ${r.overall.profitFactor.toFixed(2)} | ${r.overall.cumPts.toFixed(0)} | ` +
      `${iv.n}/${iv.winPct}%/${iv.exp}/${iv.pf}/${iv.maxDD} | ` +
      (a ? `${a.n}, ${a.wins}W/${a.losses}L/${a.eod}E, ${a.pts >= 0 ? "+" : ""}${a.pts}` : "—"),
    );
  }
  console.log(`\nartifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
