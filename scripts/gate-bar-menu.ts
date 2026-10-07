/**
 * gate-bar-menu.ts — THE GATE-BAR MENU (2026-07-31, user-approved mission Part 1; analysis-only).
 *
 * QUESTION IT ANSWERS: "what does the standing 3-month window look like at each candidate
 * quality-gate bar?" — a decision aid for choosing MIN_PF / MIN_EXPECTANCY_PTS. The 2026-07-31
 * canonical-outcome regen exposed that the 1.05/0.1 bar was tuned in the TP1-only world; under
 * canonical accounting even the ungated baseline clears it, so the bar's height is a USER
 * decision. This script computes the menu; it changes NOTHING (no gate file write, no persist).
 *
 * METHOD (held-out basis, carry-forward/THIN semantics unchanged):
 *   • The shipped shared/quality-gate.ts already stores each class's and combo's HELD-OUT
 *     walk-forward metrics (n / pf / expectancy) alongside its verdict. Each ladder rung
 *     re-applies the gate rule (PF >= MIN_PF AND expectancy > MIN_EXP) to those SAME stored
 *     held-out metrics — the walk-forward machinery is not re-run because its outputs are
 *     rung-independent; only the threshold moves.
 *   • lowConfidence entries (THIN held-out sample → verdict carried forward from the previous
 *     gate file) keep their verdict AT EVERY RUNG — thin data never flips a verdict, at any bar.
 *   • Absent classes/combos stay never-blocked ("no data" != "bad data") — engine semantics.
 *   • The >=3-fact override is retained (rule.MIN_FACTS_OVERRIDE untouched) and remains subject
 *     to combo verdicts, exactly as live (qualityGateAllows / comboGateAllows consult the same
 *     gateData object the rung builds).
 *   • Each rung then runs the FULL gated engine pass (harness enginePass — cooldown/HOD-LOD
 *     state faithful; a blocked fire frees its cooldown slot, so rungs are NOT mere filters of
 *     one superset) and resolves every trade through the canonical 1m walk (resolveSignal).
 *   • EXITS ARE HELD AT THE SHIPPED CALIBRATION (exitByClass/exitByCombo refit on the full
 *     window at the 1.05 bar): the menu isolates the GATE variable. The chosen bar's standing
 *     re-derivation (mission Part 3) re-runs the whole pipeline — including exit recalibration —
 *     at that bar; menu rows are a preview, not the final book.
 *
 * SELF-CHECK: the 1.05/0.1 rung uses the shipped gate verbatim, so it must reproduce the
 * standing headline (5,629 trades / exp +5.86 / PF 1.80 as of the 2026-07-31 regen) modulo
 * bars that arrived after that run's generatedAt (the DB keeps growing live).
 *
 * Usage: npx tsx scripts/gate-bar-menu.ts        → writes gate-bar-menu.json (untracked)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { QUALITY_GATE, type QualityGateData, type GateClassStat } from "../shared/quality-gate";
import { sessionDayKey } from "../shared/yellowbox-core";
import {
  loadData, enginePass, resolveSignal, metricsOf, INTERVALS, WINDOW_START_KEY,
  FRICTION_PTS_PER_TRADE,
  type SigRow,
} from "./fact-engine-backtest";
import { artifactsDir } from "../shared/artifacts-dir"; // BAXTER_ARTIFACTS_DIR (2026-08-02)
import type { Interval } from "../shared/fact-engine";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const ARTIFACTS_DIR = artifactsDir(ROOT);
const OUT = path.join(ARTIFACTS_DIR, "gate-bar-menu.json");
const STANDING_JSON = path.join(ARTIFACTS_DIR, "fact-engine-backtest-results.json");

interface Rung { minPf: number; minExp: number; tag?: "current" | "recommended" }
const LADDER: Rung[] = [
  { minPf: 1.05, minExp: 0.1, tag: "current" },
  { minPf: 1.2,  minExp: 1 },
  { minPf: 1.3,  minExp: 2 },
  { minPf: 1.4,  minExp: 2.5 },
  { minPf: 1.5,  minExp: 3, tag: "recommended" },
  { minPf: 1.75, minExp: 4 },
  { minPf: 2.0,  minExp: 5 },
];

const rnd2 = (v: number): number => Math.round(v * 100) / 100;

/** Re-threshold a stored held-out verdict at the rung's bar. lowConfidence rows (THIN →
 *  carried-forward verdict) are returned UNCHANGED — thin data never flips a verdict.
 *  PER-INTERVAL GATE BARS (2026-07-31): a rung applies its ONE bar uniformly at every
 *  interval, so an all-interval fallback combo's allowedByInterval map is rebuilt uniform. */
function rethreshold(c: GateClassStat, minPf: number, minExp: number): GateClassStat {
  if (c.lowConfidence) return { ...c };
  const allowed = c.pf >= minPf && c.expectancy > minExp;
  return {
    ...c, allowed,
    ...(c.allowedByInterval
      ? { allowedByInterval: Object.fromEntries(Object.keys(c.allowedByInterval).map(iv => [iv, allowed])) }
      : {}),
  };
}

function gateAtBar(minPf: number, minExp: number): QualityGateData {
  const classes: Record<string, GateClassStat> = {};
  for (const [k, c] of Object.entries(QUALITY_GATE.classes)) classes[k] = rethreshold(c, minPf, minExp);
  const comboClasses: Record<string, GateClassStat> = {};
  for (const [k, c] of Object.entries(QUALITY_GATE.comboClasses ?? {})) comboClasses[k] = rethreshold(c, minPf, minExp);
  return {
    ...QUALITY_GATE,
    // Every interval's bar set to the rung (the shipped GATE_RULE is per-interval since 2026-07-31).
    rule: {
      ...QUALITY_GATE.rule,
      perInterval: Object.fromEntries(Object.keys(QUALITY_GATE.rule.perInterval).map(iv => [iv, { MIN_PF: minPf, MIN_EXPECTANCY_PTS: minExp }])),
    },
    classes,
    comboClasses,
    // exitByClass / exitByCombo: SHIPPED calibration, unchanged — the gate is the only variable.
  };
}

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const calibratedClasses = new Set(Object.keys(QUALITY_GATE.exitByClass));

  // Trading-day denominator: distinct session-day keys carrying 5m bars inside the window
  // (18:00 ET roll — the same sessionDayKey the harness stamps on every SigRow).
  const dayKeys = new Set<string>();
  for (const c of L.candlesByIv["5m"]) {
    if (c.time >= L.emissionStartTs && c.time <= L.lastDataTs) dayKeys.add(sessionDayKey(c.time));
  }
  const tradingDays = dayKeys.size;
  console.log(`[menu] window ${WINDOW_START_KEY}..now — ${tradingDays} trading days  (classes ${Object.keys(QUALITY_GATE.classes).length}, combos ${Object.keys(QUALITY_GATE.comboClasses ?? {}).length} in the shipped gate)`);

  const rungsOut: Array<Record<string, unknown>> = [];
  const allowedDetail: Record<string, { classes: string[]; combos: string[] }> = {};

  for (const rung of LADDER) {
    const label = `PF>=${rung.minPf} & EXP>${rung.minExp}`;
    const gate = gateAtBar(rung.minPf, rung.minExp);
    const allowedClasses = Object.entries(gate.classes).filter(([, c]) => c.allowed).map(([k]) => k).sort();
    const allowedCombos = Object.entries(gate.comboClasses ?? {}).filter(([, c]) => c.allowed).map(([k]) => k).sort();
    console.log(`\n[menu] ── rung ${label}${rung.tag ? ` (${rung.tag})` : ""}: ${allowedClasses.length} classes + ${allowedCombos.length} combos allowed ──`);

    const byIv = enginePass(L, { gate: true, gateData: gate, label: `MENU(${label})` }, nowSec);
    const rows: SigRow[] = [];
    for (const iv of INTERVALS) for (const sig of byIv[iv]) rows.push(resolveSignal(sig, L, nowSec, calibratedClasses));
    rows.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));

    const m = metricsOf(rows);
    const closed = m.count - m.open;
    const nOf = (o: SigRow["outcome"]): number => rows.filter(r => r.outcome === o).length;
    const pct = (n: number): number => closed ? rnd2((n / closed) * 100) : 0;
    const perInterval: Record<Interval, number> = { "1m": 0, "5m": 0, "15m": 0, "60m": 0 };
    for (const r of rows) perInterval[r.interval]++;

    const out = {
      minPf: rung.minPf,
      minExp: rung.minExp,
      label,
      ...(rung.tag ? { tag: rung.tag } : {}),
      trades: m.count,
      tradesPerDay: tradingDays ? rnd2(m.count / tradingDays) : 0,
      winPct: rnd2(m.winRate * 100),
      expPerTrade: m.expectancy,
      pf: m.profitFactor,
      cumPts: m.cumPts,
      // NET-of-friction (2026-08-02, reporting-only — see FRICTION in the harness).
      netExpPerTrade: m.netExpectancy,
      netPf: m.netProfitFactor,
      netCumPts: m.netCumPts,
      maxDrawdown: m.maxDD,
      outcomePct: { tp2: pct(nOf("tp2")), tp1: pct(nOf("tp1")), loss: pct(nOf("sl")), eod: pct(nOf("eod")) },
      perInterval,
      allowedClasses: allowedClasses.length,
      allowedCombos: allowedCombos.length,
    };
    rungsOut.push(out);
    allowedDetail[label] = { classes: allowedClasses, combos: allowedCombos };
    console.log(`[menu] ${label}: trades=${out.trades} (${out.tradesPerDay}/day) win=${out.winPct}% exp=${out.expPerTrade} PF=${out.pf} cum=${out.cumPts} maxDD=${out.maxDrawdown} | NET(-${FRICTION_PTS_PER_TRADE}/tr) exp=${out.netExpPerTrade} PF=${out.netPf} cum=${out.netCumPts}`);
    console.log(`[menu]   mix tp2/tp1/loss/eod = ${out.outcomePct.tp2}/${out.outcomePct.tp1}/${out.outcomePct.loss}/${out.outcomePct.eod} %  per-iv 1m=${perInterval["1m"]} 5m=${perInterval["5m"]} 15m=${perInterval["15m"]} 60m=${perInterval["60m"]}`);
  }

  // ── SELF-CHECK vs the standing headline (rung 1 == the shipped gate verbatim) ──
  let standingNote = "standing JSON not found — self-check skipped";
  try {
    const meta = (JSON.parse(fs.readFileSync(STANDING_JSON, "utf8")) as { meta: { gatedTotal: number; generatedAt: string; beforeAfter: { after: { trades: number; expectancy: number; pf: number; cumPts: number } } } }).meta;
    const r0 = rungsOut[0] as { trades: number; expPerTrade: number; pf: number };
    standingNote = `standing run ${meta.generatedAt}: ${meta.gatedTotal} trades exp ${meta.beforeAfter.after.expectancy} PF ${meta.beforeAfter.after.pf}; ` +
      `menu 1.05-rung: ${r0.trades} trades exp ${r0.expPerTrade} PF ${r0.pf} — delta = bars/live-edge growth since the standing generatedAt (same gate, same exits, same machinery)`;
    console.log(`\n[menu] SELF-CHECK: ${standingNote}`);
  } catch { console.log(`[menu] self-check skipped (${STANDING_JSON} unreadable)`); }

  const doc = {
    generatedAt: new Date().toISOString(),
    symbol: "MES",
    window: { from: WINDOW_START_KEY, toTs: L.lastDataTs, tradingDays },
    methodology:
      "Each rung re-applies PF>=MIN_PF & EXP>MIN_EXP to the SHIPPED gate's stored HELD-OUT walk-forward metrics per class and per combo " +
      "(lowConfidence/THIN entries keep their carried verdict at every rung; absent = never blocked; >=3-fact override retained and still subject to combo verdicts), " +
      "then runs the full gated engine pass (cooldown-faithful) with EXITS HELD at the shipped full-window calibration and resolves trades on the canonical 1m walk. " +
      "The gate is the only variable — the chosen bar's standing re-derivation (incl. exit recalibration) supersedes its menu row.",
    selfCheck: standingNote,
    rungs: rungsOut,
    allowedDetail,
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.log(`\n[menu] wrote ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
