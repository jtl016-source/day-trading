/**
 * option-b-simulation.ts — FULL pipeline at RAISED per-interval gate bars, SIMULATION ONLY
 * (2026-08-02 option-b mission). Mirrors the harness pipeline PHASE B → F at the option-b
 * bars with the gate derived ENTIRELY IN-MEMORY:
 *
 *   1. setGateBarsForAnalysis(raised bars) — the harness module GATE_RULE mutates so
 *      computeGateDataWalkForward judges every class / combo@interval / fallback-consulting
 *      verdict at the RAISED bars (THIN carry-forward from the SHIPPED gate, unchanged).
 *   2. PHASE B mirror: UNGATED pass → two-stage walk-forward gate derivation (dead-tape
 *      suppression ON — the current evidence base; friction audit captured).
 *   3. PHASE C mirror: gated pass at provisional exits → excursion profiles.
 *   4. PHASE D/D2 mirror: Monte-Carlo exit recalibration per class + per combo on the
 *      RESULTING population (same pooling ladders as the real pipeline).
 *   5. PHASE F mirror: final gated pass WITH the recalibrated exits, canonical 1m
 *      resolution, then the DAILY LOSS STOP day-sequential (as-traded semantics).
 *
 * NO PHASE E (shared/quality-gate.ts is NEVER written), NO persist, NO standing-artifact
 * overwrite — the only output is option-b-results.json in the artifacts dir, which also
 * embeds the comparison against the standing (option-a) as-traded set.
 *
 * Usage: npx tsx scripts/option-b-simulation.ts --bars "1m=2.25/6,5m=2.0/5,15m=2.0/5,60m=1.5/3"
 *        (every interval must be given as <iv>=<MIN_PF>/<MIN_EXP>; honors BAXTER_ARTIFACTS_DIR)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { QUALITY_GATE, type QualityGateData, type GateClassStat, type ClassExit, type GateBar } from "../shared/quality-gate";
import { sessionDayKey } from "../shared/yellowbox-core";
import { type Interval, type FactSignal } from "../shared/fact-engine";
import {
  loadData, enginePass, resolveSignal, metricsOf, applyDailyLossStop,
  computeGateDataWalkForward, buildExcursion, gridSearch, bootstrapCi,
  setGateBarsForAnalysis, getFrictionAudit, GATE_RULE,
  INTERVALS, WINDOW_START_KEY, FRICTION_PTS_PER_TRADE, DAILY_LOSS_STOP_PTS,
  THIN_N, COMBO_EXIT_MIN_OWN_N, COMBO_EXIT_MIN_POOLED_N,
  type SigRow, type Loaded, type Excursion,
} from "./fact-engine-backtest";
import { artifactsDir } from "../shared/artifacts-dir";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const ARTIFACTS_DIR = artifactsDir(ROOT);
const OUT = path.join(ARTIFACTS_DIR, "option-b-results.json");
const STANDING_JSON = path.join(ARTIFACTS_DIR, "fact-engine-backtest-results.json");

const rnd2 = (v: number): number => Math.round(v * 100) / 100;
const barTxt = (b: GateBar): string => `PF>=${b.MIN_PF} & EXP>${b.MIN_EXPECTANCY_PTS}`;

// ── CLI: --bars "1m=2.25/6,5m=2.0/5,15m=2.0/5,60m=1.5/3" (all four intervals required) ──
function parseBars(): Record<Interval, GateBar> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--bars");
  if (i < 0 || !argv[i + 1]) throw new Error(`--bars "<iv>=<PF>/<EXP>,..." is required (all four intervals)`);
  const out = {} as Record<Interval, GateBar>;
  for (const part of argv[i + 1].split(",")) {
    const m = /^\s*(1m|5m|15m|60m)=([\d.]+)\/([\d.]+)\s*$/.exec(part);
    if (!m) throw new Error(`bad --bars entry: "${part}" (want e.g. 1m=2.25/6)`);
    out[m[1] as Interval] = { MIN_PF: parseFloat(m[2]), MIN_EXPECTANCY_PTS: parseFloat(m[3]) };
  }
  for (const iv of INTERVALS) if (!out[iv]) throw new Error(`--bars is missing ${iv}`);
  return out;
}

interface IvStats {
  bar?: string;
  trades: number;
  tradesPerDay: number;
  winPct: number;
  expPerTrade: number;
  pf: number;
  cumPts: number;
  netExpPerTrade: number;
  netPf: number;
  netCumPts: number;
  maxDrawdown: number;
  outcomes: { tp2: number; tp1: number; loss: number; eod: number; open: number };
}
function statsOf(rows: SigRow[], tradingDays: number, bar?: string): IvStats {
  const m = metricsOf(rows);
  const nOf = (o: SigRow["outcome"]): number => rows.filter(r => r.outcome === o).length;
  return {
    ...(bar ? { bar } : {}),
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
    outcomes: { tp2: nOf("tp2"), tp1: nOf("tp1"), loss: nOf("sl"), eod: nOf("eod"), open: nOf("open") },
  };
}

const rowKey = (r: SigRow): string => `${r.fireTs}|${r.interval}|${r.direction}`;

async function main(): Promise<void> {
  const bars = parseBars();
  console.log(`[opt-b-sim] OPTION-B bars: ${INTERVALS.map(iv => `${iv} ${barTxt(bars[iv])}`).join(" | ")}`);
  const shippedBars: Record<string, GateBar> = JSON.parse(JSON.stringify(QUALITY_GATE.rule.perInterval)) as Record<string, GateBar>;
  setGateBarsForAnalysis(bars);

  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const windowToKey = new Date(L.lastDataTs * 1000).toISOString().slice(0, 10);
  const dayKeys = new Set<string>();
  for (const c of L.candlesByIv["5m"]) {
    if (c.time >= L.emissionStartTs && c.time <= L.lastDataTs) dayKeys.add(sessionDayKey(c.time));
  }
  const tradingDays = dayKeys.size;

  // ── PHASE B mirror: ungated pass → walk-forward gate derivation at the RAISED bars ──
  const neutralGate: QualityGateData = {
    generatedAt: "", source: "option-b baseline (provisional exits)",
    rule: JSON.parse(JSON.stringify(GATE_RULE)) as QualityGateData["rule"],
    multiFact: { n: 0, pf: 0, expectancy: 0 },
    classes: {}, exitByClass: {},
  };
  const ungatedByIv = enginePass(L, { gate: false, gateData: neutralGate, label: "OPT-B UNGATED" }, nowSec);
  const gateData = computeGateDataWalkForward(ungatedByIv, L, nowSec, new Date().toISOString(), windowToKey);
  const frictionAudit = getFrictionAudit();
  console.log(`[opt-b-sim] gate verdicts at the RAISED bars: ` +
    Object.entries(gateData.classes).map(([k, c]) => `${k}=${c.allowed ? "PASS" : "BLOCK"}${c.lowConfidence ? "(carry)" : ""}`).join(" "));

  // ── PHASE C mirror: gated pass at provisional exits → excursions ──
  const gatedByIv = enginePass(L, { gate: true, gateData, label: "OPT-B GATED(prov)" }, nowSec);
  const gatedSignals: FactSignal[] = INTERVALS.flatMap(iv => gatedByIv[iv]);
  const excursions: Excursion[] = [];
  for (const sig of gatedSignals) {
    const e = buildExcursion(sig, L, nowSec);
    if (e) excursions.push(e);
  }
  console.log(`[opt-b-sim] gated (provisional): ${gatedSignals.length} signals, ${excursions.length} excursion profiles`);

  // ── PHASE D mirror: per-class MC calibration on the resulting population ──
  const byClass = new Map<string, Excursion[]>();
  const byIvPool = new Map<Interval, Excursion[]>();
  for (const e of excursions) {
    let a = byClass.get(e.cls); if (!a) { a = []; byClass.set(e.cls, a); }
    a.push(e);
    let b = byIvPool.get(e.interval); if (!b) { b = []; byIvPool.set(e.interval, b); }
    b.push(e);
  }
  const exitByClass: Record<string, ClassExit> = {};
  for (const [cls, own] of [...byClass.entries()].sort()) {
    const iv = cls.split("@")[1] as Interval;
    let pool = own, poolName = `its own trades`;
    if (own.length < 100) {
      const ivPool = byIvPool.get(iv) ?? [];
      if (ivPool.length >= 100) { pool = ivPool; poolName = `all gated ${iv} trades`; }
      else if (own.length >= 30) { pool = own; poolName = `its own trades (small sample kept — interval-scale faithful)`; }
      else { pool = excursions; poolName = `all gated trades (class too small)`; }
    }
    const best = gridSearch(pool);
    if (!best) { console.log(`[opt-b-sim] MC ${cls}: no valid grid candidate — provisional exits kept`); continue; }
    const [ciLo, ciHi] = bootstrapCi(own, best.tp1, best.sl);
    exitByClass[cls] = { tp1: best.tp1, sl: best.sl, n: own.length, pool: poolName, ...(own.length < THIN_N ? { lowConfidence: true } : {}) };
    console.log(`[opt-b-sim] MC ${cls}: TP1 ${best.tp1} SL ${best.sl} (pool ${poolName}, n=${pool.length}, winners ${best.winnersN}) simExp ${best.exp} CI [${ciLo},${ciHi}]`);
  }
  gateData.exitByClass = exitByClass;

  // ── PHASE D2 mirror: per-combo MC calibration (structural classes exempt) ──
  const comboExc = excursions.filter(e => e.sigType !== "zone-reaction" && e.sigType !== "vector-side-entry" && e.combo.length > 0);
  const byComboIvExc = new Map<string, Excursion[]>();
  const byIvComboPool = new Map<Interval, Excursion[]>();
  for (const e of comboExc) {
    const k = `${e.combo}@${e.interval}`;
    let a = byComboIvExc.get(k); if (!a) { a = []; byComboIvExc.set(k, a); }
    a.push(e);
    let b = byIvComboPool.get(e.interval); if (!b) { b = []; byIvComboPool.set(e.interval, b); }
    b.push(e);
  }
  const exitByCombo: Record<string, ClassExit> = {};
  for (const [key, own] of [...byComboIvExc.entries()].sort()) {
    if (own.length < COMBO_EXIT_MIN_POOLED_N) continue; // class exits govern
    const iv = key.split("@")[1] as Interval;
    const pooled = own.length < COMBO_EXIT_MIN_OWN_N;
    const pool = pooled ? (byIvComboPool.get(iv) ?? own) : own;
    const poolName = pooled
      ? `same-interval allowed-combo trades (combo n=${own.length} in ${COMBO_EXIT_MIN_POOLED_N}..${COMBO_EXIT_MIN_OWN_N - 1})`
      : "its own trades";
    const best = gridSearch(pool);
    if (!best) { console.log(`[opt-b-sim] MC-COMBO ${key}: no valid grid candidate — class exits govern`); continue; }
    exitByCombo[key] = { tp1: best.tp1, sl: best.sl, n: own.length, pool: poolName, ...(own.length < THIN_N ? { lowConfidence: true } : {}) };
    console.log(`[opt-b-sim] MC-COMBO ${key}: TP1 ${best.tp1} SL ${best.sl} (pool ${poolName}, n=${pool.length}, winners ${best.winnersN}) simExp ${best.exp}`);
  }
  gateData.exitByCombo = exitByCombo;

  // ── PHASE F mirror: final gated pass with recalibrated exits + daily loss stop ──
  const finalByIv = enginePass(L, { gate: true, gateData, label: "OPT-B FINAL(calib)" }, nowSec);
  const calibratedClasses = new Set(Object.keys(exitByClass));
  const preStop: SigRow[] = [];
  for (const iv of INTERVALS) for (const sig of finalByIv[iv]) preStop.push(resolveSignal(sig, L, nowSec, calibratedClasses));
  preStop.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  const stop = applyDailyLossStop(preStop, DAILY_LOSS_STOP_PTS);
  const bRows = stop.kept;
  console.log(`[opt-b-sim] FINAL: ${preStop.length} pre-stop → ${bRows.length} as-traded (loss stop: ${stop.trippedDays.length} tripped day(s), ${stop.suppressed.length} suppressed)`);

  // ── Comparison vs the standing (option-a) as-traded set ──
  const standing = JSON.parse(fs.readFileSync(STANDING_JSON, "utf8")) as { meta?: Record<string, unknown>; signals: SigRow[] };
  const aRows = standing.signals;
  const aKeys = new Set(aRows.map(rowKey));
  const bKeys = new Set(bRows.map(rowKey));
  const dropped = aRows.filter(r => !bKeys.has(rowKey(r)));
  const gained = bRows.filter(r => !aKeys.has(rowKey(r)));
  const droppedM = metricsOf(dropped);
  const gainedM = metricsOf(gained);
  const biggestLost = [...dropped]
    .filter(r => r.pointsResult != null)
    .sort((x, y) => (y.pointsResult ?? 0) - (x.pointsResult ?? 0))
    .slice(0, 12)
    .map(r => ({ dateET: r.dateET, timeET: r.timeET, interval: r.interval, direction: r.direction, signalType: r.signalType, combo: r.combo, outcome: r.outcome, pointsResult: r.pointsResult }));

  // Verdict diffs vs the SHIPPED gate (classes + combos, incl. fallback per-interval maps).
  const verdictChanges: Array<{ key: string; kind: string; from: string; to: string; note?: string }> = [];
  const verdictTxt = (c: GateClassStat | undefined): string => {
    if (!c) return "absent";
    if (c.allowedByInterval) return INTERVALS.map(iv => `${iv}:${c.allowedByInterval![iv] ? "A" : "B"}`).join(" ");
    return c.allowed ? "ALLOW" : "BLOCK";
  };
  for (const [k, shipped] of Object.entries(QUALITY_GATE.classes)) {
    const now = gateData.classes[k];
    if (verdictTxt(shipped) !== verdictTxt(now)) verdictChanges.push({ key: k, kind: "class", from: verdictTxt(shipped), to: verdictTxt(now) });
  }
  for (const [k, shipped] of Object.entries(QUALITY_GATE.comboClasses ?? {})) {
    const now = (gateData.comboClasses ?? {})[k];
    if (verdictTxt(shipped) !== verdictTxt(now)) verdictChanges.push({ key: k, kind: k.includes("@") ? "combo" : "combo-fallback", from: verdictTxt(shipped), to: verdictTxt(now) });
  }
  for (const [k, now] of Object.entries(gateData.comboClasses ?? {})) {
    if (!(QUALITY_GATE.comboClasses ?? {})[k]) verdictChanges.push({ key: k, kind: k.includes("@") ? "combo" : "combo-fallback", from: "absent", to: verdictTxt(now), note: "new key on the raised-bar evidence base" });
  }

  const aStats = statsOf(aRows, tradingDays);
  const bStats = statsOf(bRows, tradingDays);
  const perInterval: Record<string, { a: IvStats; b: IvStats }> = {};
  for (const iv of INTERVALS) {
    perInterval[iv] = {
      a: statsOf(aRows.filter(r => r.interval === iv), tradingDays, barTxt(shippedBars[iv])),
      b: statsOf(bRows.filter(r => r.interval === iv), tradingDays, barTxt(bars[iv])),
    };
  }

  console.log(`[opt-b-sim] (a) live:      ${aStats.trades} tr (${aStats.tradesPerDay}/day) win ${aStats.winPct}% exp ${aStats.expPerTrade} (net ${aStats.netExpPerTrade}) PF ${aStats.pf} (net ${aStats.netPf}) cum ${aStats.cumPts} (net ${aStats.netCumPts}) DD ${aStats.maxDrawdown}`);
  console.log(`[opt-b-sim] (b) simulated: ${bStats.trades} tr (${bStats.tradesPerDay}/day) win ${bStats.winPct}% exp ${bStats.expPerTrade} (net ${bStats.netExpPerTrade}) PF ${bStats.pf} (net ${bStats.netPf}) cum ${bStats.cumPts} (net ${bStats.netCumPts}) DD ${bStats.maxDrawdown}`);
  for (const iv of INTERVALS) {
    const p = perInterval[iv];
    console.log(`[opt-b-sim]   ${iv.padStart(3)} a[${p.a.bar}]: ${p.a.trades} tr exp ${p.a.expPerTrade} PF ${p.a.pf} DD ${p.a.maxDrawdown} | b[${p.b.bar}]: ${p.b.trades} tr exp ${p.b.expPerTrade} PF ${p.b.pf} DD ${p.b.maxDrawdown}`);
  }
  console.log(`[opt-b-sim] dropped vs (a): ${dropped.length} trades (cum ${droppedM.cumPts} pts, win ${rnd2(droppedM.winRate * 100)}%) | gained: ${gained.length} (cum ${gainedM.cumPts} pts)`);
  console.log(`[opt-b-sim] verdict changes vs shipped: ${verdictChanges.length}`);
  for (const v of verdictChanges) console.log(`[opt-b-sim]   ${v.kind.padEnd(14)} ${v.key.padEnd(22)} ${v.from} → ${v.to}${v.note ? `  (${v.note})` : ""}`);
  console.log(`[opt-b-sim] friction audit at the raised bars: ${frictionAudit.length} gross-only survivor(s)` +
    (frictionAudit.length ? ` — ${frictionAudit.map(a => a.key).join(", ")}` : " (every allowed entry clears its bar net)"));

  const doc = {
    generatedAt: new Date().toISOString(),
    symbol: "MES",
    mode: "OPTION-B SIMULATION (analysis only — gate derived in-memory at raised bars; shared/quality-gate.ts untouched; nothing persisted)",
    window: { from: WINDOW_START_KEY, to: windowToKey, tradingDays },
    optionBBars: bars,
    shippedBars,
    frictionPtsPerTrade: FRICTION_PTS_PER_TRADE,
    dailyLossStopPts: DAILY_LOSS_STOP_PTS,
    lossStop: { trippedDays: stop.trippedDays, suppressed: stop.suppressed.length, preStopTrades: preStop.length },
    headline: { a: aStats, b: bStats },
    perInterval,
    comparison: {
      droppedVsA: { trades: dropped.length, cumPts: droppedM.cumPts, winPct: rnd2(droppedM.winRate * 100), wins: droppedM.wins, losses: droppedM.losses, eod: droppedM.eod },
      gainedVsA: { trades: gained.length, cumPts: gainedM.cumPts, winPct: rnd2(gainedM.winRate * 100) },
      biggestTradesLost: biggestLost,
      verdictChanges,
    },
    gate: {
      classes: gateData.classes,
      comboClasses: gateData.comboClasses,
      multiFact: gateData.multiFact,
      exitByClass,
      exitByCombo,
    },
    frictionAudit,
    aFrictionAudit: (standing.meta as { frictionAudit?: unknown } | undefined)?.frictionAudit ?? null,
    signals: bRows,
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.log(`[opt-b-sim] wrote ${OUT}`);
  // Guard rail, stated out loud: this script never touches shared/quality-gate.ts, never
  // persists, and never writes the standing results JSON/CSV/xlsx.
}

main().catch(err => { console.error(err); process.exit(1); });
