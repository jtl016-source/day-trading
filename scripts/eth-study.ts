/**
 * eth-study.ts — ETH-CONFLUENCE BACKTEST, standing window (2026-08-11, user directive:
 * "I want to see how it performs" after repealing the ETH-purity rule).
 *
 * Runs the standing loadData window twice — ETH_CONFLUENCE:false (the pre-repeal contract)
 * and the new default (ON) — resolves outcomes, and reports the ETH sleeves (15m focus per
 * the user's ask, all intervals for context) over the full window AND the past month.
 * HONESTY: gate verdicts + MC exits were derived on RTH-dominated populations — ETH
 * confluence rides RTH-calibrated judgments until weekly regens absorb ETH rows. Loss stop:
 * sleeve metrics are PRE-stop (the -80 stop acts on the whole book); the as-traded delta is
 * reported separately. Read-only; writes only eth-study-month.json.
 *
 * Usage: npx tsx scripts/eth-study.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { QUALITY_GATE } from "../shared/quality-gate";
import {
  loadData, enginePass, resolveSignal, metricsOf, applyDailyLossStop,
  INTERVALS, DAILY_LOSS_STOP_PTS, type SigRow,
} from "./fact-engine-backtest";
import { artifactsDir } from "../shared/artifacts-dir";

const rnd2 = (v: number): number => Math.round(v * 100) / 100;
const OUT = path.join(artifactsDir(process.cwd()), "eth-study-month.json");

function sleeve(rows: SigRow[]): Record<string, number> {
  const m = metricsOf(rows);
  return { n: rows.length, winPct: rnd2(m.winRate * 100), exp: rnd2(m.expectancy), pf: rnd2(m.profitFactor), cum: rnd2(m.cumPts), maxDD: rnd2(m.maxDD) };
}

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const monthStart = nowSec - 30 * 86400;
  const L = loadData();
  const calibrated = new Set(Object.keys(QUALITY_GATE.exitByClass ?? {}));

  const run = (label: string, ethConfluence: boolean): SigRow[] => {
    const byIv = enginePass(L, {
      gate: true, gateData: QUALITY_GATE, label,
      ...(ethConfluence ? {} : { settings: { ETH_CONFLUENCE: false } }),
    }, nowSec);
    const rows: SigRow[] = [];
    for (const iv of INTERVALS) for (const sig of byIv[iv]) rows.push(resolveSignal(sig, L, nowSec, calibrated));
    rows.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
    return rows.filter(r => r.outcome !== "open");
  };

  const before = run("ETH-OFF", false);
  const after = run("ETH-ON", true);

  const report: Record<string, unknown> = {
    generated: new Date().toISOString(),
    note: "SIMULATED — shipped gate + MC exits (RTH-derived) applied to ETH confluence; sleeve stats are PRE-loss-stop; asTraded blocks apply the -80 stop day-sequentially on the whole book.",
  };

  console.log("\n=== ETH-CONFLUENCE STUDY (standing window) ===");
  for (const [tag, winFrom] of [["fullWindow", 0], ["pastMonth", monthStart]] as const) {
    const b = before.filter(r => r.entryTs >= winFrom);
    const a = after.filter(r => r.entryTs >= winFrom);
    const blk: Record<string, unknown> = {};
    console.log(`\n── ${tag} ──`);
    for (const iv of [...INTERVALS, "*"]) {
      const rowsB = b.filter(r => r.session === "ETH" && (iv === "*" || r.interval === iv));
      const rowsA = a.filter(r => r.session === "ETH" && (iv === "*" || r.interval === iv));
      blk[iv === "*" ? "allIv" : iv] = { before: sleeve(rowsB), after: sleeve(rowsA) };
      const sa = sleeve(rowsA), sb = sleeve(rowsB);
      console.log(`  ETH ${iv === "*" ? "ALL" : iv.padEnd(3)}: before n=${sb.n} cum ${sb.cum} | AFTER n=${sa.n} win ${sa.winPct}% exp ${sa.exp} PF ${sa.pf} cum ${sa.cum} maxDD ${sa.maxDD}`);
    }
    // The 15m ETH trade list (the user's focus) — every new fire with outcome.
    const list15 = a.filter(r => r.session === "ETH" && r.interval === "15m").map(r => ({
      dateET: r.dateET, timeET: r.timeET, direction: r.direction, combo: r.combo ?? r.signalType,
      entry: r.entry, outcome: r.outcome, pts: r.pointsResult,
    }));
    blk["trades15mEth"] = list15;
    report[tag] = blk;
  }

  // Whole-book as-traded impact (RTH included): does adding ETH change the headline?
  const stopB = applyDailyLossStop(before, DAILY_LOSS_STOP_PTS);
  const stopA = applyDailyLossStop(after, DAILY_LOSS_STOP_PTS);
  report.asTraded = {
    before: { ...sleeve(stopB.kept), lossStopDays: stopB.trippedDays.length },
    after: { ...sleeve(stopA.kept), lossStopDays: stopA.trippedDays.length },
  };
  const wb = sleeve(stopB.kept), wa = sleeve(stopA.kept);
  console.log(`\nWHOLE BOOK as-traded: before n=${wb.n} exp ${wb.exp} PF ${wb.pf} cum ${wb.cum} DD ${wb.maxDD} (${stopB.trippedDays.length} stop-days)`);
  console.log(`                      after  n=${wa.n} exp ${wa.exp} PF ${wa.pf} cum ${wa.cum} DD ${wa.maxDD} (${stopA.trippedDays.length} stop-days)`);

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
