/**
 * gate-bar-menu-by-interval.ts — PER-INTERVAL DETAIL for the gate-bar menu (2026-07-31,
 * follow-up to scripts/gate-bar-menu.ts; analysis-only, data-only — writes
 * gate-bar-menu-by-interval.json, untracked; no gate file write, no persist).
 *
 * Same 7-rung ladder, same held-out re-thresholding (lowConfidence carries, absent never
 * blocks, >=3-fact override retained and still subject to combo verdicts), same
 * cooldown-faithful gated engine pass (harness enginePass), same canonical 1m outcome walk
 * (harness resolveSignal), EXITS HELD at the shipped calibration — this script simply GROUPS
 * each rung's resolved trade set by interval (1m/5m/15m/60m) so each interval can be charted
 * separately. It is a group-by, not a re-derivation: the rung logic is copied VERBATIM from
 * gate-bar-menu.ts (that module runs its main() on import, so it cannot be imported).
 * Max drawdown is chronological WITHIN each interval (rows sorted by entryTs into metricsOf,
 * which walks rows in order). Trades/day uses the same window trading-day denominator for
 * every interval (distinct session-day keys carrying 5m bars in the window).
 *
 * liveBar: at the CURRENTLY LIVE bar (PF>=1.5 & EXP>3 — shared/quality-gate.ts GATE_RULE),
 * the per-interval allowed classes ("<signalType>@<interval>") and combos, with their
 * HELD-OUT n / PF / expectancy. Combos are resolved exactly the way the live gate consults
 * them: the "<combo>@<interval>" verdict wins if present, else the all-interval "<combo>"
 * fallback applies (scope says which). Intervals with NO allowed class can still trade via
 * the >=3-counted-fact override — subject to these same combo verdicts.
 *
 * Usage: npx tsx scripts/gate-bar-menu-by-interval.ts
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
const OUT = path.join(ARTIFACTS_DIR, "gate-bar-menu-by-interval.json");
const MENU_JSON = path.join(ARTIFACTS_DIR, "gate-bar-menu.json");

// ── The ladder + gate-at-bar machinery, verbatim from scripts/gate-bar-menu.ts ──
interface Rung { minPf: number; minExp: number; tag?: "current" | "recommended" | "live" }
const LADDER: Rung[] = [
  { minPf: 1.05, minExp: 0.1 },
  { minPf: 1.2,  minExp: 1 },
  { minPf: 1.3,  minExp: 2 },
  { minPf: 1.4,  minExp: 2.5 },
  { minPf: 1.5,  minExp: 3, tag: "live" }, // USER-CHOSEN 2026-07-31 — the shipped GATE_RULE
  { minPf: 1.75, minExp: 4 },
  { minPf: 2.0,  minExp: 5 },
];
const LIVE_BAR = { minPf: 1.5, minExp: 3 };

const rnd2 = (v: number): number => Math.round(v * 100) / 100;

/** Re-threshold a stored held-out verdict at the rung's bar. lowConfidence rows (THIN →
 *  carried-forward verdict) are returned UNCHANGED — thin data never flips a verdict. */
function rethreshold(c: GateClassStat, minPf: number, minExp: number): GateClassStat {
  if (c.lowConfidence) return { ...c };
  const allowed = c.pf >= minPf && c.expectancy > minExp;
  return {
    ...c, allowed,
    // PER-INTERVAL GATE BARS (2026-07-31): a rung applies ONE bar uniformly, so a fallback
    // combo's per-consulting-interval map rebuilds uniform at the rung's verdict.
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
    rule: {
      ...QUALITY_GATE.rule,
      perInterval: Object.fromEntries(Object.keys(QUALITY_GATE.rule.perInterval).map(iv => [iv, { MIN_PF: minPf, MIN_EXPECTANCY_PTS: minExp }])),
    },
    classes,
    comboClasses,
    // exitByClass / exitByCombo: SHIPPED calibration, unchanged — the gate is the only variable.
  };
}

// ── Per-interval stat block ──
interface IvStats {
  trades: number;
  tradesPerDay: number;
  winPct: number;
  expPerTrade: number;
  pf: number;
  cumPts: number;
  /** NET-of-friction (2026-08-02, reporting-only — FRICTION_PTS_PER_TRADE per closed trade). */
  netExpPerTrade: number;
  netPf: number;
  netCumPts: number;
  maxDrawdown: number; // chronological within THIS interval's trade sequence
  outcomePct: { tp2: number; tp1: number; loss: number; eod: number };
}

function ivStatsOf(rows: SigRow[], tradingDays: number): IvStats {
  // rows arrive pre-sorted by entryTs → metricsOf's running-sum maxDD is chronological.
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

// ── liveBar detail: allowed classes + combos PER INTERVAL at the shipped 1.5/3 bar ──
interface AllowedEntry {
  name: string;          // internal key (class: "<signalType>@<iv>"; combo: fact-family key)
  heldOutN: number;
  heldOutPf: number;
  heldOutExp: number;
  lowConfidence?: boolean;
  /** combos only: which verdict granularity governs at this interval */
  scope?: "interval-specific" | "all-interval";
}

function liveBarDetail(gate: QualityGateData): Record<Interval, { classes: AllowedEntry[]; combos: AllowedEntry[] }> {
  const out = {} as Record<Interval, { classes: AllowedEntry[]; combos: AllowedEntry[] }>;
  const comboBases = new Set<string>();
  for (const k of Object.keys(gate.comboClasses ?? {})) comboBases.add(k.split("@")[0]);
  for (const iv of INTERVALS) {
    const classes: AllowedEntry[] = [];
    for (const [k, c] of Object.entries(gate.classes)) {
      if (k.endsWith(`@${iv}`) && c.allowed) {
        classes.push({ name: k, heldOutN: c.n, heldOutPf: rnd2(c.pf), heldOutExp: rnd2(c.expectancy), ...(c.lowConfidence ? { lowConfidence: true } : {}) });
      }
    }
    const combos: AllowedEntry[] = [];
    for (const base of [...comboBases].sort()) {
      // EXACTLY the live lookup order (comboGateAllows): "<combo>@<iv>" first, else "<combo>"
      // — whose verdict is per CONSULTING interval (allowedByInterval, 2026-07-31).
      const specific = (gate.comboClasses ?? {})[`${base}@${iv}`];
      const eff = specific ?? (gate.comboClasses ?? {})[base];
      const effAllowed = specific ? specific.allowed : (eff?.allowedByInterval?.[iv] ?? eff?.allowed);
      if (!eff || !effAllowed) continue;
      combos.push({
        name: base,
        heldOutN: eff.n, heldOutPf: rnd2(eff.pf), heldOutExp: rnd2(eff.expectancy),
        ...(eff.lowConfidence ? { lowConfidence: true } : {}),
        scope: specific ? "interval-specific" : "all-interval",
      });
    }
    classes.sort((a, b) => a.name.localeCompare(b.name));
    out[iv] = { classes, combos };
  }
  return out;
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
  console.log(`[menu-iv] window ${WINDOW_START_KEY}..now — ${tradingDays} trading days`);

  const rungsOut: Array<Record<string, unknown>> = [];
  for (const rung of LADDER) {
    const label = `PF>=${rung.minPf} & EXP>${rung.minExp}`;
    const gate = gateAtBar(rung.minPf, rung.minExp);
    const byIvSigs = enginePass(L, { gate: true, gateData: gate, label: `MENU-IV(${label})` }, nowSec);

    const byInterval = {} as Record<Interval, IvStats>;
    let total = 0;
    for (const iv of INTERVALS) {
      const rows: SigRow[] = byIvSigs[iv].map(sig => resolveSignal(sig, L, nowSec, calibratedClasses));
      rows.sort((a, b) => a.entryTs - b.entryTs); // chronological → maxDD is sequence-faithful
      byInterval[iv] = ivStatsOf(rows, tradingDays);
      total += rows.length;
      const s = byInterval[iv];
      console.log(`[menu-iv] ${label} ${iv.padStart(3)}: trades=${s.trades} (${s.tradesPerDay}/day) win=${s.winPct}% exp=${s.expPerTrade} PF=${s.pf} cum=${s.cumPts} | NET(-${FRICTION_PTS_PER_TRADE}/tr) exp=${s.netExpPerTrade} PF=${s.netPf} maxDD=${s.maxDrawdown} mix tp2/tp1/loss/eod=${s.outcomePct.tp2}/${s.outcomePct.tp1}/${s.outcomePct.loss}/${s.outcomePct.eod}%`);
    }
    console.log(`[menu-iv] ${label} TOTAL trades=${total}`);
    rungsOut.push({
      pf: rung.minPf,
      exp: rung.minExp,
      label,
      ...(rung.tag ? { tag: rung.tag } : {}),
      totalTrades: total,
      byInterval,
    });
  }

  // ── SELF-CHECK vs the standing menu (same machinery — deltas = live-edge growth only) ──
  let selfCheck = "gate-bar-menu.json not found — self-check skipped";
  try {
    const menu = JSON.parse(fs.readFileSync(MENU_JSON, "utf8")) as {
      generatedAt: string;
      rungs: Array<{ minPf: number; trades: number; perInterval: Record<Interval, number> }>;
    };
    const parts: string[] = [];
    for (const r of rungsOut as Array<{ pf: number; totalTrades: number; byInterval: Record<Interval, IvStats> }>) {
      const ref = menu.rungs.find(x => x.minPf === r.pf);
      if (!ref) continue;
      const ivDelta = INTERVALS.map(iv => `${iv}:${r.byInterval[iv].trades - (ref.perInterval[iv] ?? 0)}`).join(" ");
      parts.push(`${r.pf}: total ${r.totalTrades} vs menu ${ref.trades} (Δ${r.totalTrades - ref.trades}; ${ivDelta})`);
    }
    selfCheck = `vs gate-bar-menu.json ${menu.generatedAt} — ${parts.join(" | ")} — deltas = bars/live-edge growth since that run (same gate, same exits, same machinery)`;
    console.log(`\n[menu-iv] SELF-CHECK: ${selfCheck}`);
  } catch { console.log(`[menu-iv] self-check skipped (${MENU_JSON} unreadable)`); }

  const liveGate = gateAtBar(LIVE_BAR.minPf, LIVE_BAR.minExp);
  const doc = {
    generatedAt: new Date().toISOString(),
    symbol: "MES",
    window: { from: WINDOW_START_KEY, toTs: L.lastDataTs, tradingDays },
    methodology:
      "Per-interval group-by of the gate-bar menu (scripts/gate-bar-menu.ts): each rung re-applies PF>=MIN_PF & EXP>MIN_EXP to the SHIPPED gate's " +
      "stored HELD-OUT walk-forward metrics per class and per combo (lowConfidence/THIN entries keep their carried verdict at every rung; absent = never " +
      "blocked; >=3-fact override retained and still subject to combo verdicts), runs the full gated engine pass (cooldown-faithful) with EXITS HELD at " +
      "the shipped full-window calibration, resolves trades on the canonical 1m walk, then splits the rung's trade set by interval. maxDrawdown is " +
      "chronological WITHIN the interval; tradesPerDay shares the window trading-day denominator; outcome % are of CLOSED trades in that interval. " +
      "liveBar lists, at the shipped 1.5/3 bar, each interval's allowed classes and combos with HELD-OUT n/PF/expectancy — combo verdicts resolved " +
      "<combo>@<interval> first then the all-interval fallback (scope field). Intervals with no allowed class trade only via the >=3-counted-fact " +
      "override, still subject to combo verdicts.",
    selfCheck,
    rungs: rungsOut,
    liveBar: {
      pf: LIVE_BAR.minPf,
      exp: LIVE_BAR.minExp,
      multiFactOverride: { minCountedFacts: QUALITY_GATE.rule.MIN_FACTS_OVERRIDE, note: "fires on any interval even without an allowed class; combo verdicts still apply" },
      perInterval: liveBarDetail(liveGate),
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.log(`\n[menu-iv] wrote ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
