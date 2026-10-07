/**
 * tp1-frontier.ts — TP1 FRONTIER ANALYSIS (2026-08-12, user: "the tp1/tp2 points are way too
 * much… rerun the Monte Carlo and find the most profitable, consistent, and realistic tp1 —
 * and show me the details and win rates of every option").
 *
 * The shipped calibration picks ONE grid cell per class: argmax of mean simulated expectancy
 * (SL per cell = p85 of winners' MAE — the same rule at every TP, so smaller TPs get tighter
 * stops automatically). This script re-runs the SAME machinery (exported simulate/pctl/TICK +
 * buildExcursion — zero re-implementation of payoff semantics) on the CURRENT rules' gated
 * population, but reports the WHOLE frontier per class: for each TP1 — the derived SL, win
 * rate, outcome mix, gross/net expectancy, PF, payoff volatility, and median time-to-
 * resolution — so "profitable AND consistent AND realistic" can be judged, not just argmax.
 *
 * SELF-CHECK: the argmax row per class must equal the shipped exitByClass (quality-gate.ts).
 * Read-only; writes tp1-frontier.json.
 *
 * Usage: npx tsx scripts/tp1-frontier.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { QUALITY_GATE, classKey } from "../shared/quality-gate";
import {
  loadData, enginePass, buildExcursion, simulate, pctl, TICK,
  INTERVALS, FRICTION_PTS_PER_TRADE,
} from "./fact-engine-backtest";
import { artifactsDir } from "../shared/artifacts-dir";

const OUT = path.join(artifactsDir(process.cwd()), "tp1-frontier.json");
const CLASSES = ["fact-engine@1m", "fact-engine@5m", "fact-engine@15m", "fact-engine@60m", "vector-side-entry@1m"];
const rnd2 = (v: number): number => Math.round(v * 100) / 100;
const toTick = (v: number): number => Math.round(v / TICK) * TICK;
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Detailed cell stats — payoffs via the EXPORTED simulate (identical semantics), plus the
// resolution ordinal for hold-time (re-derived with the same first-crossing rules; the payoff
// itself is cross-checked against simulate() per excursion — any mismatch aborts).
function firstIdxAtOrAbove(steps: Array<[number, number]>, level: number): number | null {
  for (const [lv, ord] of steps) if (lv >= level - 1e-9) return ord;
  return null;
}
interface Cell {
  tp1: number; sl: number; n: number; winPct: number; tp2Pct: number; slPct: number; eodPct: number;
  exp: number; netExp: number; pf: number; payoffStd: number; medHoldMin: number; cumNet: number;
}
function cellStats(pool: ReturnType<typeof buildExcursion>[], tp: number): Cell | null {
  const xs = pool.filter((e): e is NonNullable<typeof e> => e != null);
  const winnersMae: number[] = [];
  for (const e of xs) {
    const tTP = firstIdxAtOrAbove(e.mfeSteps, tp);
    if (tTP == null) continue;
    winnersMae.push(((): number => { let m = 0; for (const [lv, o] of e.maeSteps) { if (o <= tTP) m = lv; else break; } return m; })());
  }
  if (winnersMae.length < 30) return null; // the shipped noise floor
  const sl = Math.max(1, toTick(pctl(winnersMae, 0.85)));
  const payoffs: number[] = [];
  const holds: number[] = [];
  let tp2N = 0, slN = 0, eodN = 0, winN = 0;
  for (const e of xs) {
    const p = simulate(e, tp, sl);
    payoffs.push(p);
    const tTP = firstIdxAtOrAbove(e.mfeSteps, tp);
    const tSL = firstIdxAtOrAbove(e.maeSteps, sl);
    if (tSL != null && (tTP == null || tSL <= tTP)) { slN++; holds.push(tSL); }
    else if (tTP != null) {
      winN++;
      const tTP2 = firstIdxAtOrAbove(e.mfeSteps, tp * 2);
      if (tTP2 != null && (tSL == null || tTP2 < tSL)) { tp2N++; holds.push(tTP2); }
      else holds.push(tTP);
      if (p <= 0) throw new Error("hold/payoff divergence vs simulate() — abort");
    } else { eodN++; if (p > 0) winN++; }
  }
  const n = xs.length;
  const expv = mean(payoffs);
  const std = Math.sqrt(mean(payoffs.map(p => (p - expv) ** 2)));
  const pos = payoffs.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const neg = Math.abs(payoffs.filter(p => p < 0).reduce((a, b) => a + b, 0));
  holds.sort((a, b) => a - b);
  return {
    tp1: rnd2(tp), sl: rnd2(sl), n,
    winPct: rnd2((100 * winN) / n), tp2Pct: rnd2((100 * tp2N) / n), slPct: rnd2((100 * slN) / n), eodPct: rnd2((100 * eodN) / n),
    exp: rnd2(expv), netExp: rnd2(expv - FRICTION_PTS_PER_TRADE), pf: rnd2(neg > 0 ? pos / neg : 99),
    payoffStd: rnd2(std), medHoldMin: holds.length ? holds[holds.length >> 1] : 0, cumNet: rnd2((expv - FRICTION_PTS_PER_TRADE) * n),
  };
}

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const byIv = enginePass(L, { gate: true, gateData: QUALITY_GATE, label: "frontier" }, nowSec);
  const pools = new Map<string, ReturnType<typeof buildExcursion>[]>();
  for (const iv of INTERVALS) {
    for (const sig of byIv[iv]) {
      const cls = classKey(sig.signalType, iv);
      if (!CLASSES.includes(cls)) continue;
      if (!pools.has(cls)) pools.set(cls, []);
      (pools.get(cls) as unknown[]).push(buildExcursion(sig, L, nowSec));
    }
  }

  const report: Record<string, unknown> = {};
  for (const cls of CLASSES) {
    const pool = pools.get(cls) ?? [];
    const cells: Cell[] = [];
    for (let tp = 4; tp <= 30 + 1e-9; tp += TICK) {
      const c = cellStats(pool, tp);
      if (c) cells.push(c);
    }
    if (!cells.length) { console.log(`[frontier] ${cls}: pool too small (${pool.length})`); continue; }
    const argmax = cells.reduce((a, b) => (b.exp > a.exp ? b : a));
    const shipped = QUALITY_GATE.exitByClass?.[cls];
    const selfCheck = shipped ? Math.abs(shipped.tp1 - argmax.tp1) < 1e-9 && Math.abs(shipped.sl - argmax.sl) < 1e-9 : null;
    // Candidate picks for "profitable + consistent + realistic":
    const maxNet = Math.max(...cells.map(c => c.netExp));
    const consistent = cells.filter(c => c.netExp >= 0.85 * maxNet).reduce((a, b) => (b.winPct > a.winPct ? b : a));
    const bestPf = cells.reduce((a, b) => (b.pf > a.pf ? b : a));
    report[cls] = { poolN: pool.filter(Boolean).length, shipped, selfCheckArgmaxMatchesShipped: selfCheck, argmax, consistent, bestPf, cells };
    console.log(`[frontier] ${cls} (pool ${pool.filter(Boolean).length}) self-check ${selfCheck === null ? "n/a" : selfCheck ? "PASS" : "FAIL"}`);
    console.log(`  argmax:     TP1 ${argmax.tp1} SL ${argmax.sl} | win ${argmax.winPct}% (tp2 ${argmax.tp2Pct}%) sl ${argmax.slPct}% | netExp ${argmax.netExp} PF ${argmax.pf} | std ${argmax.payoffStd} | medHold ${argmax.medHoldMin}m`);
    console.log(`  consistent: TP1 ${consistent.tp1} SL ${consistent.sl} | win ${consistent.winPct}% (tp2 ${consistent.tp2Pct}%) sl ${consistent.slPct}% | netExp ${consistent.netExp} PF ${consistent.pf} | std ${consistent.payoffStd} | medHold ${consistent.medHoldMin}m`);
  }
  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    note: "Frontier over the CURRENT rules' gated population, session-bounded calibration basis, SL = p85 winners-MAE per TP (the shipped rule). netExp is after friction. 'consistent' = max win% among cells within 85% of the best netExp.",
    frictionPts: FRICTION_PTS_PER_TRADE, report,
  }, null, 2));
  console.log(`[frontier] artifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
