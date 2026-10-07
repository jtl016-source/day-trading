/**
 * option-b-menu.ts — RAISED per-interval gate-bar menu (2026-08-02 option-b mission,
 * ANALYSIS ONLY — writes option-b-menu.json to the artifacts dir; no gate-file write, no
 * persist, no standing-artifact overwrite, live server untouched).
 *
 * Extends the gate-bar-menu-by-interval.ts pattern to a PER-INTERVAL ladder of HIGHER bars:
 * for each interval, rungs = [the interval's CURRENT live bar] + every raised rung
 * (2.0/5, 2.25/6, 2.5/7, 3.0/8) STRICTLY ABOVE that current bar. A rung's gate is the
 * SHIPPED gate with ONLY the target interval's entries re-thresholded at the rung's bar —
 * every other interval keeps its CURRENT live bar and shipped verdicts (marginal ladder:
 * "what happens if I raise just this interval's bar?"). Re-thresholding is the standing
 * menu semantics: stored HELD-OUT n/PF/expectancy re-judged at the rung (lowConfidence /
 * THIN entries keep their carried verdict at EVERY rung — thin never flips; absent stays
 * never-blocked; >=3-fact override retained and still subject to combo verdicts). Fallback
 * combos re-threshold ONLY their allowedByInterval[target] entry (verdict at the CONSULTING
 * interval's bar). EXITS HELD at the shipped calibration — the bar is the only variable.
 *
 * EVIDENCE-BASE CAVEAT (documented, same class as the 2026-08-01 menu deltas): stored
 * held-out combo metrics were derived on the CURRENT bars' class-gated population; at raised
 * bars a full re-derivation would shift combo evidence bases (class verdicts change what the
 * combo gate sees). The menu is exits-held + evidence-held by design; the full option-b
 * simulation (scripts/option-b-simulation.ts) is the honest re-derivation.
 *
 * Each rung runs the FULL 4-interval cooldown-faithful engine pass (dead-tape suppression
 * ON — the current evidence base), resolves on the canonical 1m walk, then applies the
 * DAILY LOSS STOP day-sequentially across the whole book (as-traded semantics, matching the
 * standing headline) before reporting the target interval's stats + the total book.
 *
 * Usage: npx tsx scripts/option-b-menu.ts   (honors BAXTER_ARTIFACTS_DIR)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { QUALITY_GATE, type QualityGateData, type GateClassStat, type GateBar } from "../shared/quality-gate";
import { sessionDayKey } from "../shared/yellowbox-core";
import {
  loadData, enginePass, resolveSignal, metricsOf, applyDailyLossStop, INTERVALS,
  WINDOW_START_KEY, FRICTION_PTS_PER_TRADE, DAILY_LOSS_STOP_PTS,
  type SigRow, type Loaded,
} from "./fact-engine-backtest";
import { artifactsDir } from "../shared/artifacts-dir";
import type { Interval } from "../shared/fact-engine";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const ARTIFACTS_DIR = artifactsDir(ROOT);
const OUT = path.join(ARTIFACTS_DIR, "option-b-menu.json");
const STANDING_JSON = path.join(ARTIFACTS_DIR, "fact-engine-backtest-results.json");

const rnd2 = (v: number): number => Math.round(v * 100) / 100;

/** The raised ladder (mission spec). Per interval, rungs strictly above the current bar. */
const RAISED_LADDER: GateBar[] = [
  { MIN_PF: 2.0, MIN_EXPECTANCY_PTS: 5 },
  { MIN_PF: 2.25, MIN_EXPECTANCY_PTS: 6 },
  { MIN_PF: 2.5, MIN_EXPECTANCY_PTS: 7 },
  { MIN_PF: 3.0, MIN_EXPECTANCY_PTS: 8 },
];
const CURRENT_BARS: Record<string, GateBar> = QUALITY_GATE.rule.perInterval;
const barTxt = (b: GateBar): string => `PF>=${b.MIN_PF} & EXP>${b.MIN_EXPECTANCY_PTS}`;
const barAbove = (a: GateBar, cur: GateBar): boolean =>
  a.MIN_PF > cur.MIN_PF || a.MIN_EXPECTANCY_PTS > cur.MIN_EXPECTANCY_PTS;

/** Re-threshold one stored held-out verdict at a bar. Thin never flips at any bar. */
function rethresholdAt(c: GateClassStat, bar: GateBar): GateClassStat {
  if (c.lowConfidence) return { ...c };
  return { ...c, allowed: c.pf >= bar.MIN_PF && c.expectancy > bar.MIN_EXPECTANCY_PTS };
}

/** The SHIPPED gate with ONLY `iv`'s entries re-judged at `bar` (marginal ladder — other
 *  intervals keep their live bar + shipped verdicts). Exits stay the shipped calibration. */
function gateWithIvBar(iv: Interval, bar: GateBar): QualityGateData {
  const classes: Record<string, GateClassStat> = {};
  for (const [k, c] of Object.entries(QUALITY_GATE.classes)) {
    classes[k] = k.endsWith(`@${iv}`) ? rethresholdAt(c, bar) : { ...c };
  }
  const comboClasses: Record<string, GateClassStat> = {};
  for (const [k, c] of Object.entries(QUALITY_GATE.comboClasses ?? {})) {
    if (k.includes("@")) { comboClasses[k] = k.endsWith(`@${iv}`) ? rethresholdAt(c, bar) : { ...c }; continue; }
    // All-interval fallback: consulted from every interval at THAT interval's bar — only the
    // target interval's map entry re-judges; carried entries keep their carried map whole.
    if (c.lowConfidence) { comboClasses[k] = { ...c }; continue; }
    const map: Record<string, boolean> = {
      ...(c.allowedByInterval ?? Object.fromEntries(INTERVALS.map(x => [x, c.allowed]))),
    };
    map[iv] = c.pf >= bar.MIN_PF && c.expectancy > bar.MIN_EXPECTANCY_PTS;
    comboClasses[k] = { ...c, allowedByInterval: map, allowed: Object.values(map).some(Boolean) };
  }
  return {
    ...QUALITY_GATE,
    rule: {
      ...QUALITY_GATE.rule,
      perInterval: { ...QUALITY_GATE.rule.perInterval, [iv]: { ...bar } },
    },
    classes,
    comboClasses,
    // exitByClass / exitByCombo: SHIPPED calibration, unchanged — the bar is the only variable.
  };
}

// ── Stat blocks (gate-bar-menu-by-interval.ts shape + as-traded loss-stop context) ──
interface IvStats {
  trades: number;
  tradesPerDay: number;
  winPct: number;
  expPerTrade: number;
  pf: number;
  cumPts: number;
  netExpPerTrade: number;
  netPf: number;
  netCumPts: number;
  maxDrawdown: number; // chronological within THIS interval's as-traded sequence
  outcomePct: { tp2: number; tp1: number; loss: number; eod: number };
}

function ivStatsOf(rows: SigRow[], tradingDays: number): IvStats {
  const m = metricsOf(rows);
  const closed = m.count - m.open;
  const nOf = (o: SigRow["outcome"]): number => rows.filter(r => r.outcome === o).length;
  const pct = (n: number): number => closed ? rnd2((n / closed) * 100) : 0;
  return {
    trades: m.count,
    tradesPerDay: tradingDays ? rnd2(m.count / tradingDays) : 0,
    winPct: rnd2(m.winRate * 100),
    expPerTrade: m.expectancy,
    pf: m.profitFactor,
    cumPts: m.cumPts,
    netExpPerTrade: m.netExpectancy,
    netPf: m.netProfitFactor,
    netCumPts: m.netCumPts,
    maxDrawdown: m.maxDD,
    outcomePct: { tp2: pct(nOf("tp2")), tp1: pct(nOf("tp1")), loss: pct(nOf("sl")), eod: pct(nOf("eod")) },
  };
}

interface ConfigResult {
  asTraded: SigRow[];
  preStopTrades: number;
  lossStopSuppressed: number;
  trippedDays: string[];
}

function runConfig(L: Loaded, nowSec: number, gate: QualityGateData, label: string): ConfigResult {
  const byIv = enginePass(L, { gate: true, gateData: gate, label }, nowSec);
  const calibrated = new Set(Object.keys(QUALITY_GATE.exitByClass));
  const all: SigRow[] = [];
  for (const iv of INTERVALS) for (const sig of byIv[iv]) all.push(resolveSignal(sig, L, nowSec, calibrated));
  all.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  const stop = applyDailyLossStop(all, DAILY_LOSS_STOP_PTS);
  return {
    asTraded: stop.kept,
    preStopTrades: all.length,
    lossStopSuppressed: stop.suppressed.length,
    trippedDays: stop.trippedDays,
  };
}

interface RungRow {
  bar: GateBar;
  label: string;
  tag?: "current";
  targetInterval: IvStats;
  totalBook: IvStats & { trippedDays: number; lossStopSuppressed: number; preStopTrades: number };
  /** sweet-spot score = netExpPerTrade × winPct (target interval, as-traded); DD tiebreak. */
  score: number;
}

function statsForConfig(res: ConfigResult, iv: Interval, tradingDays: number): { target: IvStats; book: RungRow["totalBook"] } {
  const ivRows = res.asTraded.filter(r => r.interval === iv);
  const target = ivStatsOf(ivRows, tradingDays);
  const book = {
    ...ivStatsOf(res.asTraded, tradingDays),
    trippedDays: res.trippedDays.length,
    lossStopSuppressed: res.lossStopSuppressed,
    preStopTrades: res.preStopTrades,
  };
  return { target, book };
}

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();

  const dayKeys = new Set<string>();
  for (const c of L.candlesByIv["5m"]) {
    if (c.time >= L.emissionStartTs && c.time <= L.lastDataTs) dayKeys.add(sessionDayKey(c.time));
  }
  const tradingDays = dayKeys.size;
  console.log(`[opt-b-menu] window ${WINDOW_START_KEY}..now — ${tradingDays} trading days; artifacts → ${ARTIFACTS_DIR}`);
  console.log(`[opt-b-menu] current live bars: ${INTERVALS.map(iv => `${iv} ${barTxt(CURRENT_BARS[iv])}`).join(" | ")}`);

  // ── ONE pass at the current live config (shared "current" rung for all four intervals +
  //    the self-check vs the standing as-traded set) ──
  const curRes = runConfig(L, nowSec, QUALITY_GATE, "OPT-B(current)");
  const mCur = metricsOf(curRes.asTraded);
  let selfCheck = `current-config pass: ${mCur.count} as-traded trades exp ${mCur.expectancy} PF ${mCur.profitFactor} maxDD ${mCur.maxDD}`;
  try {
    const standing = JSON.parse(fs.readFileSync(STANDING_JSON, "utf8")) as { signals: SigRow[] };
    const mStand = metricsOf(standing.signals);
    selfCheck += ` vs standing JSON ${mStand.count}/${mStand.expectancy}/${mStand.profitFactor}/${mStand.maxDD} (Δtrades ${mCur.count - mStand.count} = live-edge growth since the standing run; same gate, same exits, same machinery)`;
  } catch { selfCheck += ` — standing JSON unreadable, cross-check skipped`; }
  console.log(`[opt-b-menu] SELF-CHECK: ${selfCheck}`);

  const perInterval: Record<string, { currentBar: string; rungs: RungRow[] }> = {};
  for (const iv of INTERVALS) {
    const rungs: RungRow[] = [];
    const cur = CURRENT_BARS[iv];
    const curStats = statsForConfig(curRes, iv, tradingDays);
    rungs.push({
      bar: { ...cur }, label: barTxt(cur), tag: "current",
      targetInterval: curStats.target, totalBook: curStats.book,
      score: rnd2(curStats.target.netExpPerTrade * curStats.target.winPct),
    });
    for (const bar of RAISED_LADDER) {
      if (!barAbove(bar, cur)) continue; // skip rungs at/below the interval's current bar
      const gate = gateWithIvBar(iv, bar);
      const res = runConfig(L, nowSec, gate, `OPT-B(${iv} ${barTxt(bar)})`);
      const s = statsForConfig(res, iv, tradingDays);
      rungs.push({
        bar: { ...bar }, label: barTxt(bar),
        targetInterval: s.target, totalBook: s.book,
        score: rnd2(s.target.netExpPerTrade * s.target.winPct),
      });
    }
    for (const r of rungs) {
      const t = r.targetInterval, b = r.totalBook;
      console.log(`[opt-b-menu] ${iv.padStart(3)} ${r.label.padEnd(20)}${r.tag ? " (current)" : "          "} → ${iv}: ${t.trades} tr (${t.tradesPerDay}/day) win ${t.winPct}% exp ${t.expPerTrade} (net ${t.netExpPerTrade}) PF ${t.pf} (net ${t.netPf}) cum ${t.cumPts} DD ${t.maxDrawdown} score ${r.score} | BOOK: ${b.trades} tr exp ${b.expPerTrade} PF ${b.pf} cum ${b.cumPts} DD ${b.maxDrawdown} (stop: ${b.trippedDays} days/${b.lossStopSuppressed} suppressed)`);
    }
    perInterval[iv] = { currentBar: barTxt(cur), rungs };
  }

  // ── Sweet-spot picks: max score (netExp × win%), lower maxDD tiebreak; thin flagged ──
  const picks: Record<string, { bar: GateBar; label: string; score: number; trades: number; thin: boolean; isCurrent: boolean }> = {};
  for (const iv of INTERVALS) {
    const rungs = perInterval[iv].rungs;
    let best = rungs[0];
    for (const r of rungs.slice(1)) {
      if (r.targetInterval.trades === 0) continue; // an empty interval can't be a sweet spot
      if (r.score > best.score + 1e-9 ||
          (Math.abs(r.score - best.score) <= 1e-9 && r.targetInterval.maxDrawdown < best.targetInterval.maxDrawdown)) {
        best = r;
      }
    }
    picks[iv] = {
      bar: best.bar, label: best.label, score: best.score,
      trades: best.targetInterval.trades,
      thin: best.targetInterval.trades < 15,
      isCurrent: best.tag === "current",
    };
    console.log(`[opt-b-menu] PICK ${iv}: ${best.label}${best.tag === "current" ? " (the current bar)" : ""} — score ${best.score} on ${best.targetInterval.trades} trades${picks[iv].thin ? " [THIN — treat with caution]" : ""}`);
  }

  const doc = {
    generatedAt: new Date().toISOString(),
    symbol: "MES",
    window: { from: WINDOW_START_KEY, toTs: L.lastDataTs, tradingDays },
    methodology:
      "RAISED per-interval gate-bar menu (option-b analysis, 2026-08-02): for each interval, rungs = the CURRENT live bar + every raised rung " +
      "(2.0/5, 2.25/6, 2.5/7, 3.0/8) strictly above it. A rung re-applies PF>=MIN_PF & EXP>MIN_EXPECTANCY to the SHIPPED gate's stored HELD-OUT " +
      "metrics for ONLY the target interval's classes / combo@interval verdicts / fallback-combo allowedByInterval entry (marginal ladder — other " +
      "intervals keep their live bars + shipped verdicts; lowConfidence/THIN entries keep their carried verdict at every rung; absent = never blocked; " +
      ">=3-fact override retained and still subject to combo verdicts). Full cooldown-faithful 4-interval engine pass per rung with dead-tape " +
      "suppression ON, EXITS HELD at the shipped calibration, canonical 1m resolution, then the DAILY LOSS STOP applied day-sequentially across the " +
      "whole book (as-traded). targetInterval = the rung's interval as-traded; totalBook = the whole 4-interval book under that one-interval change. " +
      "score = netExpPerTrade × winPct on the target interval (sweet-spot metric; maxDD tiebreak). EVIDENCE-BASE CAVEAT: stored held-out combo metrics " +
      "come from the CURRENT bars' class-gated population — the full option-b simulation re-derives them honestly.",
    frictionPtsPerTrade: FRICTION_PTS_PER_TRADE,
    dailyLossStopPts: DAILY_LOSS_STOP_PTS,
    selfCheck,
    perInterval,
    picks,
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.log(`\n[opt-b-menu] wrote ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
