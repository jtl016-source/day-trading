/**
 * streak-validate.ts — CORROBORATOR-PROVING GATE for the 3-loss streak stop (2026-08-10).
 * Honest exit-aware comparison on the SHIPPED final pass: BEFORE = applyDailyLossStop only
 * (the standing as-traded rule), AFTER = applyRiskStops (loss stop + K=3 streak stop in one
 * day-sequential walk, streak counted only over trades CLOSED by each candidate's entry —
 * the real information set, unlike the menu filter which credited unclosed outcomes).
 * The rule ships ONLY if AFTER beats BEFORE. Read-only; console output only.
 *
 * Usage: npx tsx scripts/streak-validate.ts
 */
import { QUALITY_GATE } from "../shared/quality-gate";
import { STREAK_STOP_LOSSES } from "../shared/fact-engine";
import {
  loadData, enginePass, resolveSignal, metricsOf, applyDailyLossStop, applyRiskStops,
  INTERVALS, DAILY_LOSS_STOP_PTS, type SigRow,
} from "./fact-engine-backtest";

const rnd2 = (v: number): number => Math.round(v * 100) / 100;

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const calibratedClasses = new Set(Object.keys(QUALITY_GATE.exitByClass ?? {}));
  const byIv = enginePass(L, { gate: true, gateData: QUALITY_GATE, label: "streak-validate" }, nowSec);
  const preStop: SigRow[] = [];
  for (const iv of INTERVALS) for (const sig of byIv[iv]) preStop.push(resolveSignal(sig, L, nowSec, calibratedClasses));
  preStop.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));

  const before = applyDailyLossStop(preStop, DAILY_LOSS_STOP_PTS);
  const after = applyRiskStops(preStop, DAILY_LOSS_STOP_PTS, STREAK_STOP_LOSSES);
  // Reduction self-check: K=0 must reproduce applyDailyLossStop EXACTLY.
  const zero = applyRiskStops(preStop, DAILY_LOSS_STOP_PTS, 0);
  const key = (r: SigRow): string => `${r.interval}|${r.fireTs}|${r.direction}`;
  const sameAsBefore = zero.kept.length === before.kept.length
    && zero.kept.every((r, i) => key(r) === key(before.kept[i]));
  console.log(`self-check applyRiskStops(K=0) === applyDailyLossStop: ${sameAsBefore ? "PASS" : "FAIL"}`);

  const line = (tag: string, rows: SigRow[]): void => {
    const m = metricsOf(rows);
    console.log(`${tag}: n=${rows.length} win ${rnd2(m.winRate * 100)}% exp ${rnd2(m.expectancy)} (net ${rnd2(m.netExpectancy)}) PF ${rnd2(m.profitFactor)} cum ${rnd2(m.cumPts)} maxDD ${rnd2(m.maxDD)}`);
    for (const iv of INTERVALS) {
      const im = metricsOf(rows.filter(r => r.interval === iv));
      console.log(`   ${iv.padEnd(3)} n=${im.count} win ${rnd2(im.winRate * 100)}% exp ${rnd2(im.expectancy)} PF ${rnd2(im.profitFactor)} cum ${rnd2(im.cumPts)} maxDD ${rnd2(im.maxDD)}`);
    }
  };
  line("BEFORE (loss stop only — standing rule)", before.kept);
  line(`AFTER  (+ ${STREAK_STOP_LOSSES}-loss streak stop, honest exit-aware)`, after.kept);

  // Honest K sweep — every plausible threshold, same exit-aware information set.
  for (const K of [1, 2, 4]) {
    const v = applyRiskStops(preStop, DAILY_LOSS_STOP_PTS, K);
    const m = metricsOf(v.kept);
    console.log(`K=${K}: n=${v.kept.length} exp ${rnd2(m.expectancy)} PF ${rnd2(m.profitFactor)} cum ${rnd2(m.cumPts)} maxDD ${rnd2(m.maxDD)} | ${v.streakStops.length} streak stop(s), loss-stop days ${v.trippedDays.length}`);
  }

  const beforeKeys = new Set(before.kept.map(key));
  const removed = before.kept.filter(() => true).filter(r => !new Set(after.kept.map(key)).has(key(r)));
  const added = after.kept.filter(r => !beforeKeys.has(key(r)));
  const remW = removed.filter(r => (r.pointsResult ?? 0) > 0).length;
  const remL = removed.filter(r => (r.pointsResult ?? 0) < 0).length;
  const remPts = rnd2(removed.reduce((s, r) => s + (r.pointsResult ?? 0), 0));
  console.log(`delta: removed ${removed.length} (${remW}W/${remL}L, ${remPts >= 0 ? "+" : ""}${remPts} pts), added ${added.length} (loss-stop timing shifts)`);
  console.log(`streak stops: ${after.streakStops.length} interval-day(s) → ${after.streakStops.map(s => `${s.day}:${s.interval}`).join(", ") || "none"}`);
  console.log(`loss-stop days: before ${before.trippedDays.length} → after ${after.trippedDays.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
