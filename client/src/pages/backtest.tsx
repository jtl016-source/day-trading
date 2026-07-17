import { useState, useCallback } from "react";
import { Link } from "wouter";
import {
  CandlestickChart,
  type CandleBar,
  type ZoneBand,
} from "@/components/CandlestickChart";
import {
  MILK_TOLERANCE,
  OPTIMIZED_GATES,
  OPTIMIZED_EXITS,
  OPTIMIZED_EXITS_5M,
  aggregateToInterval,
  detectIctZones,
  computeEngineSignals,
  isBullZone,
  type EngineSignal,
} from "@/lib/signal-engine";

// ── Theme ─────────────────────────────────────────────────────────────────────
const MW = {
  bg:      "#05080d",
  panel:   "#090d14",
  toolbar: "#0b1018",
  border:  "#111a26",
  text:    "#b8c8d8",
  muted:   "#4a6080",
  accent:  "#1a72d4",
};

// ── Constants ─────────────────────────────────────────────────────────────────
// EXIT_STRATEGY_PROFILES, MILK_TOLERANCE and all signal logic now live in
// @/lib/signal-engine — the single source of truth shared with the Market
// chart and the Signals tab.

// ── Types ─────────────────────────────────────────────────────────────────────
type TierKey    = "safe" | "risky";
type SessionKey = "rth" | "eth";
type Outcome = "win_tp1" | "win_tp2" | "win_trailer" | "loss" | "open";

interface BacktestSignal {
  time: number;
  direction: "Long" | "Short";
  price: number;
  tier: TierKey;
  outcome: Outcome;
  note: string;
  noteType: "good" | "caution" | "miss";
}

interface TierStat { count: number; winTp1: number; winTp2: number; loss: number; open: number }

interface BacktestResult {
  symbol: string; interval: string; exitStrategy: string;
  fromDate: string; toDate: string; totalBars: number;
  tiers: { safe: TierStat; risky: TierStat };
  signals: BacktestSignal[];
}

// ── Zone detection: ICT zones (shared engine, ZoneBand-compatible) ────────────
// FVG / Order Block / structural swing levels — the zones THE program strategy
// confirms against (ICT Zones + Candle Body, optimized 2026-07-16).
function detectMilkZones(candles: CandleBar[]): ZoneBand[] {
  return detectIctZones(candles) as ZoneBand[];
}

// ── Backtest engine ───────────────────────────────────────────────────────────
// Signal detection is delegated to computeEngineSignals (@/lib/signal-engine) —
// the exact same code path the Market chart and Signals tab use.
function runBacktest(
  candles: CandleBar[],
  milkZones: ZoneBand[],
  profile: { rth: { tp1Safe: number; tp1: number; tp2: number; sl: number }; eth: { tp1Safe: number; tp1: number; tp2: number; sl: number } },
  symbol: string, interval: string, exitStrategy: string, session: SessionKey,
): BacktestResult {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const isBullZ = isBullZone;

  const dayHLMap = new Map<string, { high: number; low: number }>();
  for (const c of sorted) {
    const d = new Date(c.time * 1000);
    const dk = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const cur = dayHLMap.get(dk) ?? { high: -Infinity, low: Infinity };
    dayHLMap.set(dk, { high: Math.max(cur.high, c.high), low: Math.min(cur.low, c.low) });
  }

  const tiers: BacktestResult["tiers"] = {
    safe:  { count: 0, winTp1: 0, winTp2: 0, loss: 0, open: 0 },
    risky: { count: 0, winTp1: 0, winTp2: 0, loss: 0, open: 0 },
  };
  const signals: BacktestSignal[] = [];

  const mkNote = (
    isLong: boolean, price: number, tier: TierKey,
    out: Outcome, time: number, tp1Price: number, tp2Price: number,
    fp60mVetoed?: boolean, fpVetoed?: boolean,
  ): { note: string; noteType: "good" | "caution" | "miss" } => {
    if (out === "win_tp2") return { note: "Clean hit — zone + vector held to full target", noteType: "good" };
    const utcH = new Date(time * 1000).getUTCHours();
    const d    = new Date(time * 1000);
    const dk   = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const dayHL = dayHLMap.get(dk) ?? { high: Infinity, low: 0 };

    if (out === "win_tp1") {
      const blocker = milkZones.find(z =>
        time >= (z.fromTime ?? 0) && time <= (z.toTime ?? Infinity) &&
        (isLong ? (!isBullZ(z) && z.bottomPrice > tp1Price && z.bottomPrice <= tp2Price)
                : ( isBullZ(z) && z.topPrice   < tp1Price && z.topPrice   >= tp2Price)));
      if (blocker) return {
        note: isLong ? `Resistance at ${blocker.bottomPrice.toFixed(2)} capped the run`
                     : `Support at ${blocker.topPrice.toFixed(2)} stopped the run`,
        noteType: "caution",
      };
      return { note: "Hit TP1 — stalled before full target", noteType: "caution" };
    }
    if (out === "loss") {
      if (fp60mVetoed) return { note: "60m vector declining — Long veto would have prevented this loss", noteType: "miss" };
      if (fpVetoed)    return { note: "Footprint delta divergence — proxy would have vetoed this entry", noteType: "miss" };
      if (isLong) {
        const res = milkZones.find(z => !isBullZ(z) && time >= (z.fromTime ?? 0) && time <= (z.toTime ?? Infinity) && z.bottomPrice > price && z.bottomPrice - price <= 5);
        if (res) return { note: `Resistance ${(res.bottomPrice - price).toFixed(1)}pts overhead`, noteType: "miss" };
        if (price >= dayHL.high - 3) return { note: "Entry near HOD — limited upside", noteType: "miss" };
        if (utcH >= 19) return { note: "Late session — expired near close", noteType: "caution" };
        if (tier !== "safe") return { note: "No zone confirmation — vector-only stopped out", noteType: "miss" };
        return { note: "Zone held but momentum failed", noteType: "miss" };
      } else {
        const sup = milkZones.find(z => isBullZ(z) && time >= (z.fromTime ?? 0) && time <= (z.toTime ?? Infinity) && z.topPrice < price && price - z.topPrice <= 5);
        if (sup) return { note: `Support ${(price - sup.topPrice).toFixed(1)}pts below — buyers defended`, noteType: "miss" };
        if (price <= dayHL.low + 3) return { note: "Entry near LOD — bounce risk", noteType: "miss" };
        if (utcH >= 19) return { note: "Late session — expired near close", noteType: "caution" };
        if (tier !== "safe") return { note: "No zone confirmation — vector-only stopped out", noteType: "miss" };
        return { note: "Zone held but momentum failed", noteType: "miss" };
      }
    }
    return { note: "Open — session not yet resolved", noteType: "caution" };
  };

  // ── Run the shared engine — the ONE signal code path for all pages ──────────
  // OPTIMIZED_GATES = ICT zone required + candle body; no vector/footprint gate.
  const engineSignals: EngineSignal[] = computeEngineSignals(sorted, milkZones, profile, session, OPTIMIZED_GATES);

  for (const s of engineSignals) {
    const out = s.outcome as Outcome;
    tiers[s.tier].count++;
    if (out === "win_tp1") tiers[s.tier].winTp1++;
    else if (out === "win_tp2") tiers[s.tier].winTp2++;
    else if (out === "loss") tiers[s.tier].loss++;
    else tiers[s.tier].open++;
    const { note, noteType } = mkNote(s.direction === "Long", s.price, s.tier, out, s.time, s.tp1, s.tp2);
    signals.push({ time: s.time, direction: s.direction, price: s.price, tier: s.tier, outcome: out, note, noteType });
  }

  const fromDate = sorted.length ? new Date(sorted[0].time * 1000).toLocaleDateString() : "—";
  const toDate   = sorted.length ? new Date(sorted[sorted.length - 1].time * 1000).toLocaleDateString() : "—";
  return { symbol, interval, exitStrategy, fromDate, toDate, totalBars: sorted.length, tiers, signals };
}

// ── Tip key: normalize numbers so the same pattern isn't re-saved with diff values ──
function tipKey(tip: string): string {
  return tip.replace(/\d+(\.\d+)?%?/g, "N").replace(/\s+/g, " ").trim();
}

// ── Tips generator — returns actionable tips only (no summary line) ─────────
function generateTips(result: BacktestResult): string[] {
  const tips: string[] = [];
  const all = result.signals;
  if (!all.length) return [];

  const safe  = all.filter(s => s.tier === "safe");
  const risky = all.filter(s => s.tier === "risky");

  const winRate = (arr: BacktestSignal[]) => {
    const closed = arr.filter(s => s.outcome !== "open");
    const wins   = closed.filter(s => s.outcome === "win_tp1" || s.outcome === "win_tp2").length;
    return closed.length > 0 ? wins / closed.length : 0;
  };

  const safeWR  = winRate(safe);
  const riskyWR = winRate(risky);

  if (safe.length > 0 && risky.length > 0 && safeWR > riskyWR + 0.15)
    tips.push(`Safe tier wins ${(safeWR * 100).toFixed(0)}% vs Risky ${(riskyWR * 100).toFixed(0)}% — filter to Safe only for best EV.`);

  if (safe.length > 0 && risky.length > 0 && riskyWR > safeWR + 0.15)
    tips.push(`Risky tier outperformed Safe (${(riskyWR * 100).toFixed(0)}% vs ${(safeWR * 100).toFixed(0)}%) — zone filter may be too restrictive for this period.`);

  const lateEntries = all.filter(s => {
    const h = new Date(s.time * 1000).getUTCHours();
    return h >= 19 && (s.outcome === "loss" || s.outcome === "open");
  });
  if (lateEntries.length >= 3)
    tips.push(`${lateEntries.length} entries after 3 PM ET expired as losses — avoid signals after 19:00 UTC.`);

  const earlyEntries = all.filter(s => {
    const h = new Date(s.time * 1000).getUTCHours();
    return h < 15 && (s.outcome === "win_tp1" || s.outcome === "win_tp2");
  });
  if (earlyEntries.length >= 3)
    tips.push(`${earlyEntries.length} of the best wins came before 11 AM ET — morning sessions show stronger momentum.`);

  const tp2Hits = all.filter(s => s.outcome === "win_tp2").length;
  const tp1Hits = all.filter(s => s.outcome === "win_tp1").length;
  if (tp2Hits > 0 && tp1Hits > tp2Hits * 2)
    tips.push(`TP1 hit ${tp1Hits}x but TP2 only ${tp2Hits}x — consider scaling out 50% at TP1 then trailing the rest.`);

  if (tp2Hits > tp1Hits && tp1Hits > 0)
    tips.push(`TP2 hit more often (${tp2Hits}x) than TP1 (${tp1Hits}x) — consider removing partial at TP1 and holding for full target.`);

  const missedLong  = all.filter(s => s.direction === "Long"  && s.outcome === "loss" && s.note.includes("HOD")).length;
  const missedShort = all.filter(s => s.direction === "Short" && s.outcome === "loss" && s.note.includes("LOD")).length;
  if (missedLong + missedShort >= 2)
    tips.push(`${missedLong + missedShort} losses entered near the day extreme (HOD/LOD) — check distance to day extreme before entry.`);

  const noZoneLosses = risky.filter(s => s.outcome === "loss").length;
  const noZoneTotal  = risky.length;
  if (noZoneTotal > 0 && noZoneLosses / noZoneTotal > 0.6)
    tips.push(`Risky (no zone) lost ${noZoneLosses}/${noZoneTotal} — require Milk zone confirmation to improve hit rate.`);

  if (noZoneTotal > 0 && noZoneLosses / noZoneTotal < 0.3)
    tips.push(`Risky (no zone) is performing well (${noZoneTotal - noZoneLosses}/${noZoneTotal} wins) — zone filter may be overly conservative.`);

  const resistanceCapped = all.filter(s => s.outcome === "win_tp1" && s.note.includes("Resistance")).length;
  if (resistanceCapped >= 2)
    tips.push(`${resistanceCapped} TP1 exits caused by overhead resistance — map opposing zones before entry to set realistic targets.`);

  const longWins  = all.filter(s => s.direction === "Long"  && (s.outcome === "win_tp1" || s.outcome === "win_tp2")).length;
  const shortWins = all.filter(s => s.direction === "Short" && (s.outcome === "win_tp1" || s.outcome === "win_tp2")).length;
  const longTotal  = all.filter(s => s.direction === "Long").length;
  const shortTotal = all.filter(s => s.direction === "Short").length;
  if (longTotal >= 5 && shortTotal >= 5) {
    const longWR  = longWins  / longTotal;
    const shortWR = shortWins / shortTotal;
    if (longWR > shortWR + 0.2)
      tips.push(`Long trades win ${(longWR * 100).toFixed(0)}% vs Short ${(shortWR * 100).toFixed(0)}% — bias toward longs in this period.`);
    else if (shortWR > longWR + 0.2)
      tips.push(`Short trades win ${(shortWR * 100).toFixed(0)}% vs Long ${(longWR * 100).toFixed(0)}% — bias toward shorts in this period.`);
  }

  const openCount = all.filter(s => s.outcome === "open").length;
  if (openCount > all.length * 0.2)
    tips.push(`${openCount} signals are still open — run backtest again after session closes for full results.`);

  return tips;
}

// ── Per-signal insight generator ─────────────────────────────────────────────
interface SignalInsight {
  time: number;
  direction: "Long" | "Short";
  price: number;
  outcome: Outcome;
  signal: string;       // "Long 5842.50 · Apr 15 · Safe"
  insight: string;      // what happened / why
  adjustment: string;   // what to do differently next time
}

function generateSignalInsights(
  result: BacktestResult,
  milkZones: ZoneBand[],
  exitProfile: { tp1Safe: number; tp1: number; tp2: number; sl: number },
): SignalInsight[] {
  const insights: SignalInsight[] = [];
  const isBullZ = (z: ZoneBand) => z.color === "#22c55e" || z.color === "#3b82f6" || z.color === "#14b8a6";

  const dayHLMap = new Map<string, { high: number; low: number }>();
  for (const s of result.signals) {
    const d  = new Date(s.time * 1000);
    const dk = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const cur = dayHLMap.get(dk) ?? { high: -Infinity, low: Infinity };
    dayHLMap.set(dk, { high: Math.max(cur.high, s.price), low: Math.min(cur.low, s.price) });
  }
  // rebuild with actual candle extremes included
  for (const s of result.signals) {
    const d  = new Date(s.time * 1000);
    const dk = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const cur = dayHLMap.get(dk)!;
    const tp2Price = s.direction === "Long" ? s.price + exitProfile.tp2 : s.price - exitProfile.tp2;
    dayHLMap.set(dk, { high: Math.max(cur.high, tp2Price), low: Math.min(cur.low, tp2Price) });
  }

  for (const s of result.signals) {
    const isLong   = s.direction === "Long";
    const tp1Price = isLong ? s.price + (s.tier === "safe" ? exitProfile.tp1Safe : exitProfile.tp1)
                            : s.price - (s.tier === "safe" ? exitProfile.tp1Safe : exitProfile.tp1);
    const tp2Price = isLong ? s.price + exitProfile.tp2 : s.price - exitProfile.tp2;
    const slPrice  = isLong ? s.price - exitProfile.sl  : s.price + exitProfile.sl;
    const d        = new Date(s.time * 1000);
    const dk       = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const dayHL    = dayHLMap.get(dk) ?? { high: Infinity, low: 0 };
    const utcH     = d.getUTCHours();
    const label    = `${s.direction} ${s.price.toFixed(2)} · ${fmtShortDate(s.time)} · ${s.tier === "safe" ? "Safe" : "Risky"}`;

    // ── Win TP2 — reinforce what worked ─────────────────────────────────────
    if (s.outcome === "win_tp2") {
      const zones = milkZones.filter(z =>
        isBullZ(z) === isLong &&
        s.time >= (z.fromTime ?? 0) && s.time <= (z.toTime ?? Infinity) &&
        Math.abs((isLong ? z.topPrice : z.bottomPrice) - s.price) <= 3);
      if (zones.length > 0) {
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: `Full target hit. ${zones[0].label} zone at ${(isLong ? zones[0].topPrice : zones[0].bottomPrice).toFixed(2)} provided the bounce.`,
          adjustment: "No change — zone + vector confluence with clean approach is the ideal setup. Replicate this.",
        });
      }
      continue;
    }

    // ── Win TP1 only — stalled before full target ────────────────────────────
    if (s.outcome === "win_tp1") {
      const blocker = milkZones.find(z =>
        s.time >= (z.fromTime ?? 0) && s.time <= (z.toTime ?? Infinity) &&
        (isLong ? (!isBullZ(z) && z.bottomPrice > tp1Price && z.bottomPrice <= tp2Price)
                : ( isBullZ(z) && z.topPrice   < tp1Price && z.topPrice   >= tp2Price)));
      if (blocker) {
        const dist = isLong ? (blocker.bottomPrice - s.price).toFixed(1) : (s.price - blocker.topPrice).toFixed(1);
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: `${blocker.label} zone at ${(isLong ? blocker.bottomPrice : blocker.topPrice).toFixed(2)} was ${dist}pts away — blocked the run to TP2.`,
          adjustment: `Before entry: map ${isLong ? "resistance" : "support"} zones between TP1 and TP2. When a zone sits inside the target range, set TP2 to just below/above it, or take the full position at TP1.`,
        });
      } else if (utcH >= 18) {
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: "Hit TP1 but session ended before TP2 could be reached.",
          adjustment: "For entries after 2 PM ET: target TP1 only — insufficient session time to reach TP2. Accept the partial.",
        });
      } else {
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: "Momentum stalled between TP1 and TP2 — no obvious structural blocker.",
          adjustment: "Scale out: take 50% at TP1 and trail the stop to breakeven. This locks profit while still giving the full target a chance.",
        });
      }
      continue;
    }

    // ── Loss ────────────────────────────────────────────────────────────────
    if (s.outcome === "loss") {
      // Near HOD/LOD
      const distHigh = Math.abs(dayHL.high - s.price);
      const distLow  = Math.abs(dayHL.low  - s.price);
      if (isLong && distHigh < 5) {
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: `Entry ${distHigh.toFixed(1)}pts from day high (${dayHL.high.toFixed(2)}) — limited room to the upside.`,
          adjustment: "Rule: skip Long entries within 5pts of the daily high. Wait for HOD to expand, or take Short instead if vector allows.",
        });
        continue;
      }
      if (!isLong && distLow < 5) {
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: `Entry ${distLow.toFixed(1)}pts from day low (${dayHL.low.toFixed(2)}) — bounce risk from LOD.`,
          adjustment: "Rule: skip Short entries within 5pts of the daily low. Buyers defend LOD aggressively. Wait for structure break below LOD before shorting.",
        });
        continue;
      }

      // Overhead resistance / support close to entry
      const blocker = milkZones.find(z =>
        s.time >= (z.fromTime ?? 0) && s.time <= (z.toTime ?? Infinity) &&
        (isLong ? (!isBullZ(z) && z.bottomPrice > s.price && z.bottomPrice - s.price <= exitProfile.sl * 1.5)
                : ( isBullZ(z) && z.topPrice < s.price && s.price - z.topPrice <= exitProfile.sl * 1.5)));
      if (blocker) {
        const dist = isLong ? (blocker.bottomPrice - s.price).toFixed(1) : (s.price - blocker.topPrice).toFixed(1);
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: `${isLong ? "Resistance" : "Support"} zone at ${(isLong ? blocker.bottomPrice : blocker.topPrice).toFixed(2)} was only ${dist}pts overhead — trade had no room before the first obstacle.`,
          adjustment: `Minimum clearance rule: ${isLong ? "resistance" : "support"} must be at least ${(exitProfile.sl * 2).toFixed(0)}pts from entry (2× SL). If not, skip or flip direction.`,
        });
        continue;
      }

      // Late session
      if (utcH >= 19) {
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: "Entry after 3 PM ET — session expired before target reached.",
          adjustment: "Hard rule: no new entries after 19:00 UTC. Existing positions can run; new signals should be skipped.",
        });
        continue;
      }

      // Risky tier (no zone)
      if (s.tier === "risky") {
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: "No Milk zone confirmation — vector-only signal. Without zone support, stopped out.",
          adjustment: `Strategy change: require a ${isLong ? "bullish" : "bearish"} Milk zone within ${MILK_TOLERANCE}pts of entry. This upgrades the signal to Safe tier and significantly improves win rate.`,
        });
        continue;
      }

      // Zone was there but failed
      const activeZone = milkZones.find(z =>
        isBullZ(z) === isLong &&
        s.time >= (z.fromTime ?? 0) && s.time <= (z.toTime ?? Infinity) &&
        Math.abs((isLong ? z.topPrice : z.bottomPrice) - s.price) <= 4);
      if (activeZone) {
        insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
          insight: `${activeZone.label} zone was active but price broke through — zone lost its strength.`,
          adjustment: "Add a body confirmation rule: candle close must be back above (Long) or below (Short) the zone top/bottom, not just touching it. A wick touch without close is a weaker setup.",
        });
        continue;
      }

      // Fallback
      insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
        insight: "No clear structural reason for the failure — momentum simply didn't follow through.",
        adjustment: "Check if the vector slope was flat at entry. A flat or declining vector on a Long entry weakens the signal; require a rising vector for full conviction.",
      });
      continue;
    }

    // ── Open ─────────────────────────────────────────────────────────────────
    if (s.outcome === "open") {
      insights.push({ time: s.time, direction: s.direction, price: s.price, outcome: s.outcome, signal: label,
        insight: "Position still open — session has not yet closed so win/loss is unresolved.",
        adjustment: "Manage manually: if price is between entry and TP1, consider moving stop to breakeven.",
      });
    }
  }

  return insights;
}

// ── Short date formatter for signal insights ──────────────────────────────────
function fmtShortDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

// ── Helper: format date ───────────────────────────────────────────────────────
function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) + " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });
}

// ── Monte Carlo grid search ───────────────────────────────────────────────────
// Block-bootstrap EV estimation across a TP1×SL grid.
// Returns per-tier optimal parameters plus the distribution stats for display.

interface MCParamRow {
  tp1: number; tp2: number; sl: number;
  wr: number; ev: number; evLow: number; evHigh: number; sampleN: number;
}

interface MCResult {
  safe:  { best: MCParamRow; grid: MCParamRow[] };
  risky: { best: MCParamRow; grid: MCParamRow[] };
}

const MC_TP1_RANGE  = [7.5, 10.0, 12.5, 15.0, 17.5, 20.0];
const MC_TP2_RATIO  = 2.0;  // TP2 = TP1 × ratio (computed from TP1)
const MC_SL_RANGE   = [2.5, 3.5, 4.0, 5.0, 6.0, 7.5];
const MC_BOOT_ITERS = 800;
const MC_BLOCK_SIZE = 5;    // block-bootstrap block length in signals

function runMonteCarlo(signals: BacktestSignal[]): MCResult {
  const byTier = (tier: TierKey) => signals.filter(s => s.tier === tier && s.outcome !== "open");

  function evaluateGrid(sigs: BacktestSignal[]): { best: MCParamRow; grid: MCParamRow[] } {
    const grid: MCParamRow[] = [];
    for (const tp1 of MC_TP1_RANGE) {
      for (const sl of MC_SL_RANGE) {
        const tp2 = tp1 * MC_TP2_RATIO;
        // Re-evaluate each signal under this TP/SL:
        // win_tp2 → +tp2, win_tp1 → +tp1, loss → -sl
        const pnls = sigs.map(s => {
          if (s.outcome === "win_tp2") return tp2;
          if (s.outcome === "win_tp1") return tp1;
          return -sl;
        });
        if (!pnls.length) continue;
        const wins = sigs.filter(s => s.outcome !== "loss").length;
        const wr = wins / sigs.length;
        const ev = pnls.reduce((a, b) => a + b, 0) / pnls.length;

        // Block bootstrap CI
        const boots: number[] = [];
        for (let b = 0; b < MC_BOOT_ITERS; b++) {
          let sum = 0, n = 0;
          while (n < pnls.length) {
            const start = Math.floor(Math.random() * pnls.length);
            for (let k = 0; k < MC_BLOCK_SIZE && n < pnls.length; k++, n++) {
              sum += pnls[(start + k) % pnls.length];
            }
          }
          boots.push(sum / pnls.length);
        }
        boots.sort((a, b) => a - b);
        grid.push({ tp1, tp2, sl, wr, ev, evLow: boots[Math.floor(MC_BOOT_ITERS * 0.05)], evHigh: boots[Math.floor(MC_BOOT_ITERS * 0.95)], sampleN: sigs.length });
      }
    }
    // Best = highest median EV (lower CI positive → reliable)
    const best = grid.slice().sort((a, b) => b.ev - a.ev)[0] ?? grid[0];
    return { best, grid: grid.sort((a, b) => b.ev - a.ev) };
  }

  return {
    safe:  evaluateGrid(byTier("safe")),
    risky: evaluateGrid(byTier("risky")),
  };
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function BacktestPage() {
  const [symbol, setSymbol]               = useState("MES");
  // THE program strategy fires on 15m — default the backtest to it
  const [interval, setInterval]           = useState<"1m"|"5m"|"15m"|"60m">("15m");
  const [enabledTiers, setEnabledTiers]   = useState<Set<TierKey>>(new Set(["safe", "risky"]));
  const [sessionMode, setSessionMode]     = useState<SessionKey>("rth");
  const [candles, setCandles]             = useState<CandleBar[]>([]);
  const [milkZones, setMilkZones]         = useState<ZoneBand[]>([]);
  const [result, setResult]               = useState<BacktestResult | null>(null);
  const [isLoading, setIsLoading]         = useState(false);
  const [loadError, setLoadError]         = useState("");
  const [mlState, setMlState]             = useState<"idle"|"saving"|"done">("idle");
  const [mcResult, setMcResult]           = useState<MCResult | null>(null);
  const [mcRunning, setMcRunning]         = useState(false);
  const [seenTipKeys, setSeenTipKeys]     = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("bt_seen_tip_keys") ?? "[]")); }
    catch { return new Set(); }
  });

  const intervalSec = interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : 3600;

  const tryFetch = async (sym: string, res: string): Promise<CandleBar[]> => {
    try {
      const r = await fetch(`/api/data/cached-continuous/${encodeURIComponent(sym)}/${res}?from=0`);
      if (!r.ok) return [];
      const data = await r.json();
      // Endpoint returns { candles: [...], symbol, interval, source } — not a raw array
      const candles = data?.candles ?? data;
      return Array.isArray(candles) ? candles : [];
    } catch { return []; }
  };

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError("");
    try {
      // Try every known resolution; pick the finest one that has data
      const RES_ORDER = ["1m", "5m", "15m", "60m"] as const;
      const RES_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };

      let raw: CandleBar[] = [];
      let foundResSec = intervalSec;

      for (const res of RES_ORDER) {
        const data = await tryFetch(symbol, res);
        if (data.length > 0) {
          // Prefer finest resolution that is ≤ target interval
          if (!raw.length || RES_SEC[res] < foundResSec) {
            raw = data;
            foundResSec = RES_SEC[res];
          }
        }
      }

      if (!raw.length) {
        throw new Error(`No data found for "${symbol}". Go to the Market page, select this symbol, and let it load — or import a CSV via the Data page.`);
      }

      // Aggregate up to target interval if the stored data is finer
      const bars = foundResSec < intervalSec
        ? aggregateToInterval(raw, intervalSec)
        : raw;

      setCandles(bars);
      const zones   = detectMilkZones(bars);
      setMilkZones(zones);
      // Fixed exits — part of the optimized strategy, calibrated per interval:
      // 5m = TP1 +4 / TP2 +8 / SL −4 · 15m = TP1 +8 / TP2 +16 / SL −4
      const exits   = interval === "5m" ? OPTIMIZED_EXITS_5M : OPTIMIZED_EXITS;
      const bt      = runBacktest(bars, zones, exits, symbol, interval, "optimized", sessionMode);
      setResult(bt);
    } catch (e: any) {
      setLoadError(e.message ?? "Failed to load");
    } finally {
      setIsLoading(false);
    }
  }, [symbol, interval, sessionMode, intervalSec]);

  const saveMl = async () => {
    if (!result || !hasNew) return;
    setMlState("saving");
    try {
      await fetch("/api/learn/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "backtest", result,
          patternTips: newPatternTips,
          signalInsights: newSignalInsights,
        }),
      });
      // Mark everything as seen
      const newKeys = [
        ...newPatternTips.map(tipKey),
        ...newSignalInsights.map(si => si.signal + "|" + si.adjustment),
      ];
      const updated = new Set([...seenTipKeys, ...newKeys]);
      const capped  = [...updated].slice(-500);
      setSeenTipKeys(new Set(capped));
      localStorage.setItem("bt_seen_tip_keys", JSON.stringify(capped));
      setMlState("done");
      setTimeout(() => setMlState("idle"), 3000);
    } catch {
      setMlState("idle");
    }
  };

  // ── Derived stats — exits are interval-calibrated (5m: 4/8/4 · others: 8/16/4) ──
  const exitProfile = (interval === "5m" ? OPTIMIZED_EXITS_5M : OPTIMIZED_EXITS)[sessionMode];
  const filteredSignals = result
    ? result.signals.filter(s => enabledTiers.has(s.tier))
    : [];

  const wins   = filteredSignals.filter(s => s.outcome === "win_tp1" || s.outcome === "win_tp2").length;
  const losses = filteredSignals.filter(s => s.outcome === "loss").length;
  const opens  = filteredSignals.filter(s => s.outcome === "open").length;
  const closed = wins + losses;
  const winPct = closed > 0 ? (wins / closed * 100) : 0;

  const pnlPts = filteredSignals.reduce((acc, s) => {
    const isSafe = s.tier === "safe";
    if (s.outcome === "win_tp1") return acc + (isSafe ? exitProfile.tp1Safe : exitProfile.tp1);
    if (s.outcome === "win_tp2") return acc + exitProfile.tp2;
    if (s.outcome === "loss")    return acc - exitProfile.sl;
    return acc;
  }, 0);
  const pnlDollars = pnlPts * 5; // MES: $5/pt

  // Pattern-level tips (aggregated, deduplicated by normalized key)
  const allPatternTips = result ? generateTips(result) : [];
  const newPatternTips = allPatternTips.filter(t => !seenTipKeys.has(tipKey(t)));

  // Signal-level insights (per-trade, deduplicated by exact string)
  const allSignalInsights = result
    ? generateSignalInsights(result, milkZones, exitProfile)
    : [];
  const newSignalInsights = allSignalInsights.filter(si => !seenTipKeys.has(si.signal + "|" + si.adjustment));

  const allNew = [...newPatternTips, ...newSignalInsights.map(si => si.signal + "|" + si.adjustment)];
  const hasNew = allNew.length > 0;

  // Summary line shown separately — never deduplicated
  const summary = result
    ? `${filteredSignals.length} signals · ${result.symbol} ${result.interval} · ${result.fromDate} – ${result.toDate}`
    : null;

  // ── Chart signals ───────────────────────────────────────────────────────────
  const chartSignals = filteredSignals.map(s => ({
    time:      s.time,
    price:     s.price,
    direction: s.direction,
    tp1:  s.direction === "Long" ? s.price + (s.tier === "safe" ? exitProfile.tp1Safe : exitProfile.tp1)
                                 : s.price - (s.tier === "safe" ? exitProfile.tp1Safe : exitProfile.tp1),
    tp2:  s.direction === "Long" ? s.price + exitProfile.tp2 : s.price - exitProfile.tp2,
    sl:   s.direction === "Long" ? s.price - exitProfile.sl  : s.price + exitProfile.sl,
    toTime:   s.time + 86400,
    riskLevel: s.tier as "safe" | "risky",
    outcome:   s.outcome,
  }));

  const toggleTier = (t: TierKey) => {
    setEnabledTiers(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  // ── Outcome badge ───────────────────────────────────────────────────────────
  const OutcomeBadge = ({ oc }: { oc: Outcome }) => {
    const cfg = oc === "win_tp2"     ? { bg: "#16422e", color: "#4ade80", label: "TP2 Win" }
              : oc === "win_tp1"     ? { bg: "#193a28", color: "#86efac", label: "TP1 Win" }
              : oc === "win_trailer" ? { bg: "#193a28", color: "#86efac", label: "Trail Win" }
              : oc === "loss"        ? { bg: "#3b1212", color: "#f87171", label: "Loss" }
              :                       { bg: "#1e2535", color: "#93a3b4", label: "Open" };
    return (
      <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: cfg.bg, color: cfg.color }}>
        {cfg.label}
      </span>
    );
  };

  const TierBadge = ({ tier }: { tier: TierKey }) => (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 3,
      background: tier === "safe" ? "#0d2a1a" : "#2a1e0d",
      color:      tier === "safe" ? "#4ade80"  : "#fbbf24",
    }}>
      {tier === "safe" ? "Safe" : "Risky"}
    </span>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: MW.bg, color: MW.text, fontFamily: "'Trebuchet MS', 'Roboto', sans-serif", overflow: "hidden" }}>

      {/* ── Toolbar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 12px", height: 44, background: MW.toolbar, borderBottom: `1px solid ${MW.border}`, flexShrink: 0 }}>
        <Link href="/">
          <button style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, cursor: "pointer", background: "transparent", border: `1px solid ${MW.border}`, color: MW.muted }}>
            ← Market
          </button>
        </Link>

        <div style={{ width: 1, height: 20, background: MW.border }} />

        <span style={{ fontSize: 13, fontWeight: 700, color: MW.text }}>Backtest</span>

        <div style={{ width: 1, height: 20, background: MW.border }} />

        {/* Symbol */}
        <input
          value={symbol}
          onChange={e => setSymbol(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === "Enter" && load()}
          placeholder="Symbol"
          style={{ width: 80, height: 28, padding: "0 8px", borderRadius: 4, background: MW.panel, border: `1px solid ${MW.border}`, color: MW.text, fontSize: 12 }}
        />

        {/* Interval */}
        <select
          value={interval}
          onChange={e => setInterval(e.target.value as any)}
          style={{ height: 28, padding: "0 6px", borderRadius: 4, background: MW.panel, border: `1px solid ${MW.border}`, color: MW.text, fontSize: 12 }}
        >
          <option value="1m">1m</option>
          <option value="5m">5m</option>
          <option value="15m">15m</option>
          <option value="60m">60m</option>
        </select>

        {/* Exit strategy — fixed by the optimized program strategy, per interval */}
        <span style={{ fontSize: 11, color: MW.muted, padding: "2px 8px", border: `1px solid ${MW.border}`, borderRadius: 4 }}>
          {interval === "5m" ? "Exits: TP1 +4 · TP2 +8 · SL −4 (optimized 5m)" : "Exits: TP1 +8 · TP2 +16 · SL −4 (optimized 15m)"}
        </span>

        {/* Session toggle — RTH / ETH */}
        <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${MW.border}` }}>
          {(["rth", "eth"] as SessionKey[]).map(s => {
            const active = sessionMode === s;
            return (
              <button key={s} onClick={() => setSessionMode(s)} style={{
                padding: "2px 12px", fontSize: 11, cursor: "pointer", border: "none",
                background: active ? (s === "rth" ? "#1a72d422" : "#7c3aed22") : "transparent",
                color: active ? (s === "rth" ? "#60a5fa" : "#a78bfa") : MW.muted,
                fontWeight: active ? 700 : 400,
                borderRight: s === "rth" ? `1px solid ${MW.border}` : "none",
              }}>
                {s.toUpperCase()}
              </button>
            );
          })}
        </div>

        {/* Tier toggles */}
        <div style={{ display: "flex", gap: 4 }}>
          {(["safe", "risky"] as TierKey[]).map(t => {
            const on  = enabledTiers.has(t);
            const col = t === "safe" ? "#26c87a" : "#f59e0b";
            return (
              <button key={t} onClick={() => toggleTier(t)} style={{
                padding: "2px 8px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                background: on ? col + "22" : "transparent",
                border: `1px solid ${on ? col : MW.border}`,
                color: on ? col : MW.muted,
              }}>
                {t === "safe" ? "Safe" : "Risky"}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1 }} />

        {loadError && <span style={{ fontSize: 11, color: "#f87171" }}>{loadError}</span>}

        <button
          onClick={load}
          disabled={isLoading}
          style={{
            padding: "4px 18px", borderRadius: 4, fontSize: 12, fontWeight: 700, cursor: isLoading ? "default" : "pointer",
            background: isLoading ? MW.border : "#1a72d4",
            border: "none", color: "#fff", opacity: isLoading ? 0.6 : 1,
          }}
        >
          {isLoading ? "Loading…" : "Load"}
        </button>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Chart */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {!result && !isLoading && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, pointerEvents: "none" }}>
              <span style={{ fontSize: 32, opacity: 0.15 }}>📊</span>
              <span style={{ fontSize: 13, color: MW.muted }}>Select symbol &amp; interval, then press Load</span>
            </div>
          )}
          <CandlestickChart
            candles={candles}
            backtestMode={true}
            confluenceSignals={chartSignals}
            showVector={false}
            showVolume={false}
            activeTool="cursor"
          />
        </div>

        {/* ── Side panel ── */}
        <div style={{ width: 340, background: MW.panel, borderLeft: `1px solid ${MW.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Stats */}
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${MW.border}`, flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
              {result ? `${result.symbol} ${result.interval} · ${result.fromDate} – ${result.toDate}` : "Results"}
            </div>

            {/* Win rate big number */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 36, fontWeight: 800, color: winPct >= 50 ? "#4ade80" : "#f87171", lineHeight: 1 }}>
                {result ? `${winPct.toFixed(0)}%` : "—"}
              </span>
              <span style={{ fontSize: 12, color: MW.muted, marginBottom: 4 }}>win rate</span>
            </div>

            {/* Counts row */}
            <div style={{ display: "flex", gap: 16, marginBottom: 10 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#4ade80" }}>{result ? wins : "—"}</div>
                <div style={{ fontSize: 10, color: MW.muted }}>Wins</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#f87171" }}>{result ? losses : "—"}</div>
                <div style={{ fontSize: 10, color: MW.muted }}>Losses</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: MW.muted }}>{result ? opens : "—"}</div>
                <div style={{ fontSize: 10, color: MW.muted }}>Open</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: MW.text }}>{result ? filteredSignals.length : "—"}</div>
                <div style={{ fontSize: 10, color: MW.muted }}>Total</div>
              </div>
            </div>

            {/* P&L */}
            {result && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: MW.muted }}>P&amp;L</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: pnlPts >= 0 ? "#4ade80" : "#f87171" }}>
                  {pnlPts >= 0 ? "+" : ""}{pnlPts.toFixed(1)} pts
                </span>
                <span style={{ fontSize: 12, color: pnlDollars >= 0 ? "#4ade80" : "#f87171", opacity: 0.7 }}>
                  ({pnlDollars >= 0 ? "+" : ""}${pnlDollars.toFixed(0)})
                </span>
              </div>
            )}

            {/* Per-tier breakdown */}
            {result && (
              <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                {(["safe", "risky"] as TierKey[]).map(t => {
                  if (!enabledTiers.has(t)) return null;
                  const st = result.tiers[t];
                  const w = st.winTp1 + st.winTp2;
                  const cl = w + st.loss;
                  const wr = cl > 0 ? (w / cl * 100).toFixed(0) : "—";
                  const col = t === "safe" ? "#4ade80" : "#fbbf24";
                  return (
                    <div key={t} style={{ flex: 1, padding: "6px 8px", borderRadius: 5, background: MW.bg, border: `1px solid ${MW.border}` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: col, marginBottom: 3 }}>{t === "safe" ? "Safe" : "Risky"}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: MW.text }}>{wr}%</div>
                      <div style={{ fontSize: 10, color: MW.muted }}>{w}W / {st.loss}L / {st.count}T</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Monte Carlo calibration ── */}
          {result && (
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${MW.border}`, flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Monte Carlo Calibration
                </span>
                <button
                  onClick={() => { setMcRunning(true); setTimeout(() => { setMcResult(runMonteCarlo(result.signals)); setMcRunning(false); }, 50); }}
                  disabled={mcRunning}
                  style={{ padding: "2px 10px", borderRadius: 3, fontSize: 10, fontWeight: 700, cursor: mcRunning ? "default" : "pointer", background: mcRunning ? MW.border : "#6d28d9", border: "none", color: "#fff", opacity: mcRunning ? 0.6 : 1 }}
                >
                  {mcRunning ? "Running…" : mcResult ? "Re-run" : "Calibrate"}
                </button>
              </div>
              {mcResult && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {(["safe", "risky"] as TierKey[]).map(tier => {
                    const r = mcResult[tier];
                    if (!r.grid.length) return null;
                    const top = r.grid.slice(0, 5);
                    const col = tier === "safe" ? "#4ade80" : "#fbbf24";
                    return (
                      <div key={tier} style={{ background: MW.bg, borderRadius: 4, padding: "6px 8px", border: `1px solid ${MW.border}` }}>
                        <div style={{ fontSize: 9, fontWeight: 800, color: col, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>
                          {tier === "safe" ? "Safe (FP-confirmed)" : "Risky (Zone+secondary)"} — {r.best.sampleN} signals
                        </div>
                        {/* Best row */}
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, padding: "3px 5px", borderRadius: 3, background: "rgba(109,40,217,0.12)", border: "1px solid rgba(109,40,217,0.3)" }}>
                          <span style={{ fontSize: 9, color: "#a78bfa", fontWeight: 700 }}>BEST</span>
                          <span style={{ fontSize: 10, color: MW.text }}>TP1 {r.best.tp1} · TP2 {r.best.tp2.toFixed(0)} · SL {r.best.sl}</span>
                          <span style={{ fontSize: 10, color: col, fontWeight: 700, marginLeft: "auto" }}>EV {r.best.ev.toFixed(1)} pts</span>
                        </div>
                        {/* WR and CI */}
                        <div style={{ fontSize: 9, color: MW.muted, marginBottom: 4 }}>
                          WR {(r.best.wr * 100).toFixed(0)}% · 90% CI [{r.best.evLow.toFixed(1)}, {r.best.evHigh.toFixed(1)}] pts
                        </div>
                        {/* Top 5 grid */}
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          {top.map((row, i) => (
                            <div key={i} style={{ display: "flex", gap: 4, fontSize: 9, color: i === 0 ? MW.text : MW.muted }}>
                              <span style={{ width: 12, color: i === 0 ? col : MW.muted }}>#{i + 1}</span>
                              <span>TP1={row.tp1} TP2={row.tp2.toFixed(0)} SL={row.sl}</span>
                              <span style={{ marginLeft: "auto", color: i === 0 ? col : MW.muted }}>EV {row.ev.toFixed(1)}</span>
                              <span style={{ color: MW.muted }}>{(row.wr * 100).toFixed(0)}%WR</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ fontSize: 9, color: MW.muted, fontStyle: "italic" }}>
                    800-iteration block bootstrap · block={MC_BLOCK_SIZE} signals · TP2 = 2× TP1
                  </div>
                </div>
              )}
              {!mcResult && (
                <div style={{ fontSize: 10, color: MW.muted }}>
                  Run backtest first, then click Calibrate to find optimal TP/SL via Monte Carlo.
                </div>
              )}
            </div>
          )}

          {/* Signal list */}
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            <div style={{ padding: "8px 14px 4px", fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Signals ({filteredSignals.length})
            </div>
            {filteredSignals.map((s, idx) => (
              <div key={idx} style={{ padding: "7px 14px", borderBottom: `1px solid ${MW.border}11`, background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 800, width: 18, height: 18, borderRadius: "50%",
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    background: s.direction === "Long" ? "rgba(38,200,122,0.18)" : "rgba(239,83,80,0.18)",
                    color: s.direction === "Long" ? "#4ade80" : "#f87171",
                  }}>
                    {s.direction === "Long" ? "L" : "S"}
                  </span>
                  <span style={{ fontSize: 11, color: MW.muted }}>{fmtTime(s.time)}</span>
                  <TierBadge tier={s.tier} />
                  <OutcomeBadge oc={s.outcome} />
                  <span style={{ fontSize: 11, color: MW.text, fontWeight: 600 }}>{s.price.toFixed(2)}</span>
                </div>
                <div style={{ fontSize: 10, color: s.noteType === "good" ? "#4ade80" : s.noteType === "caution" ? "#fbbf24" : "#f87171", paddingLeft: 24 }}>
                  {s.note}
                </div>
              </div>
            ))}
            {result && filteredSignals.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", color: MW.muted, fontSize: 12 }}>
                No signals match selected tiers
              </div>
            )}
          </div>

          {/* Tips & Save */}
          <div style={{ borderTop: `1px solid ${MW.border}`, padding: "12px 14px 10px", flexShrink: 0, overflowY: "auto", maxHeight: 380 }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Tips &amp; Adjustments
              </span>
              {result && <span style={{ fontSize: 10, color: MW.muted }}>{summary}</span>}
            </div>

            {!result ? (
              <div style={{ fontSize: 11, color: MW.muted, marginBottom: 10 }}>Load a backtest to generate tips</div>
            ) : !hasNew ? (
              <div style={{ fontSize: 11, color: MW.muted, fontStyle: "italic", marginBottom: 10 }}>
                {allPatternTips.length === 0 && allSignalInsights.length === 0
                  ? "No signals fired — adjust symbol or interval."
                  : "Nothing new — all learnings from this run have already been saved."}
              </div>
            ) : (
              <>
                {/* ── Pattern-level tips ── */}
                {newPatternTips.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                      Strategy Patterns
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {newPatternTips.map((tip, i) => (
                        <div key={i} style={{ fontSize: 11, color: MW.text, display: "flex", gap: 6, lineHeight: 1.4 }}>
                          <span style={{ color: "#60a5fa", flexShrink: 0, marginTop: 1 }}>◆</span>
                          <span>{tip}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Signal-level insights ── */}
                {newSignalInsights.length > 0 && (
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, color: MW.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                      Signal Adjustments
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {newSignalInsights.map((si, i) => {
                        const outcomeCol = si.outcome === "win_tp2" ? "#4ade80"
                          : si.outcome === "win_tp1" ? "#86efac"
                          : si.outcome === "loss"    ? "#f87171"
                          : MW.muted;
                        return (
                          <div key={i} style={{ padding: "7px 9px", borderRadius: 5, background: MW.bg, border: `1px solid ${MW.border}` }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: si.direction === "Long" ? "#4ade80" : "#f87171" }}>
                                {si.direction === "Long" ? "L" : "S"}
                              </span>
                              <span style={{ fontSize: 11, fontWeight: 600, color: MW.text }}>{si.signal}</span>
                              <span style={{ fontSize: 10, color: outcomeCol, marginLeft: "auto" }}>
                                {si.outcome === "win_tp2" ? "TP2 ✓" : si.outcome === "win_tp1" ? "TP1 ✓" : si.outcome === "loss" ? "Loss ✗" : "Open"}
                              </span>
                            </div>
                            <div style={{ fontSize: 10, color: MW.muted, lineHeight: 1.4, marginBottom: 4 }}>
                              {si.insight}
                            </div>
                            <div style={{ fontSize: 10, color: "#fbbf24", lineHeight: 1.4, display: "flex", gap: 5 }}>
                              <span style={{ flexShrink: 0 }}>→</span>
                              <span>{si.adjustment}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}

            <button
              onClick={saveMl}
              disabled={!result || !hasNew || mlState === "saving"}
              style={{
                width: "100%", marginTop: 10, padding: "7px 0", borderRadius: 4, fontSize: 12, fontWeight: 700,
                cursor: result && hasNew ? "pointer" : "default",
                background: mlState === "done" ? "#16422e" : (result && hasNew) ? "#1a72d4" : MW.border,
                border: "none",
                color: mlState === "done" ? "#4ade80" : "#fff",
                opacity: (!result || !hasNew) ? 0.45 : 1,
              }}
            >
              {mlState === "saving" ? "Saving…"
                : mlState === "done"   ? "✓ Saved to Machine Learning"
                : !hasNew && result    ? "Nothing new to save"
                : `Save to Machine Learning (${newPatternTips.length + newSignalInsights.length} new)`}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
