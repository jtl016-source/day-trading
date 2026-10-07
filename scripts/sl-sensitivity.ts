/**
 * sl-sensitivity.ts — WHY THE STOP CAN'T JUST BE "TIGHT ENOUGH" (2026-08-12, user question).
 * Fixes TP1 (the 15m frontier knee, 13.75) and sweeps ABSOLUTE stop distances, reporting what
 * each stop does to the SAME 523-trade population: win rate, how many would-be winners the
 * stop kills first ("winners stopped"), expectancy, PF. Same primitives as the calibration.
 *
 * Usage: npx tsx scripts/sl-sensitivity.ts
 */
import { QUALITY_GATE, classKey } from "../shared/quality-gate";
import { loadData, enginePass, buildExcursion, simulate, INTERVALS, FRICTION_PTS_PER_TRADE } from "./fact-engine-backtest";

const TP = 13.75;
const rnd2 = (v: number): number => Math.round(v * 100) / 100;
function firstIdxAtOrAbove(steps: Array<[number, number]>, level: number): number | null {
  for (const [lv, ord] of steps) if (lv >= level - 1e-9) return ord;
  return null;
}

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const byIv = enginePass(L, { gate: true, gateData: QUALITY_GATE, label: "sl-sweep" }, nowSec);
  const pool = [];
  for (const iv of INTERVALS) for (const sig of byIv[iv]) {
    if (classKey(sig.signalType, iv) !== "fact-engine@15m") continue;
    const e = buildExcursion(sig, L, nowSec);
    if (e) pool.push(e);
  }
  console.log(`fact-engine@15m pool ${pool.length}, TP1 fixed at ${TP} (TP2 ${TP * 2}):`);
  console.log("  SL  | win%  | winners KILLED by the stop | netExp | PF");
  for (const sl of [4, 6, 8, 10, 12, 14, 17, 20, 23, 26, 30]) {
    const payoffs = pool.map(e => simulate(e, TP, sl));
    const n = pool.length;
    const wins = payoffs.filter(p => p > 0).length;
    // Winners killed: trades whose path DOES reach TP1 eventually, but this stop hits first.
    let killed = 0;
    for (const e of pool) {
      const tTP = firstIdxAtOrAbove(e.mfeSteps, TP);
      const tSL = firstIdxAtOrAbove(e.maeSteps, sl);
      if (tTP != null && tSL != null && tSL <= tTP) killed++;
    }
    const exp = payoffs.reduce((a, b) => a + b, 0) / n;
    const pos = payoffs.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const neg = Math.abs(payoffs.filter(p => p < 0).reduce((a, b) => a + b, 0));
    console.log(`  ${String(sl).padStart(3)} | ${rnd2((100 * wins) / n).toFixed(1)} | ${String(killed).padStart(3)} of ${pool.length} (${rnd2((100 * killed) / n)}%) | ${rnd2(exp - FRICTION_PTS_PER_TRADE).toFixed(2).padStart(6)} | ${rnd2(neg > 0 ? pos / neg : 99)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
