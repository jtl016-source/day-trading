import { db } from "./db";
import { signalHistory, learningSessions, cachedCandles } from "@shared/schema";
import { desc, and, eq, sql } from "drizzle-orm";

export interface TradeLearning {
  signalId: number;
  time: number;
  direction: string;
  riskLevel: string;
  signalType: string;
  entry: number;
  tp1: number;
  tp2: number;
  sl: number;
  outcome: string;
  sessionBucket: string;
  whyWorkedOrFailed: string;
  couldHaveDoneBetter: string;
  watchNextTime: string;
  // FOOTPRINT-LEARN: order-flow metrics per signal
  footprintConfirmed:    boolean; // FOOTPRINT-LEARN:
  footprintPartial:      boolean; // FOOTPRINT-LEARN:
  footprintVetoed:       boolean; // FOOTPRINT-LEARN: should never appear — vetoed signals are suppressed before save
  absorptionDetected:    boolean; // FOOTPRINT-LEARN:
  stackedImbalance:      boolean; // FOOTPRINT-LEARN:
  trappedTraders:        boolean; // FOOTPRINT-LEARN:
  pocStopUsed:           boolean; // FOOTPRINT-LEARN:
  tp1WasAuctionLevel:    boolean; // FOOTPRINT-LEARN:
  tp2WasExtended:        boolean; // FOOTPRINT-LEARN:
  midTradeDivergence:    boolean; // FOOTPRINT-LEARN: set to false here; mid-trade alerts are ephemeral
  footprintFiredAlone:   boolean; // FOOTPRINT-LEARN: fp confirmed but no zone or secondary vec
  footprintDeltaValue:   number;  // FOOTPRINT-LEARN: raw candleDelta value at signal
  footprintWasDuringETH: boolean; // FOOTPRINT-LEARN: for ETH reliability analysis
  // VECTOR-LEARN: vector-specific metrics
  vectorTimeframesConfirmed: number; // VECTOR-LEARN: how many secondary intervals also confirmed
  vectorWasPrimary:          boolean; // VECTOR-LEARN: signal fired on primary timeframe vector only
  vectorSetupType:           string;  // VECTOR-LEARN: "side_entry" | "tested_tabletop" | "breakout" | "unknown"
  vectorShortTrade:          boolean; // VECTOR-LEARN: true when this was a short via vector — should require extra confirmation
  // PATTERN-LEARN: pattern-specific metrics
  patternFiredAlone:      boolean; // PATTERN-LEARN: pattern fired with no zone or vector co-confirmation
  patternConfidenceLevel: string;  // PATTERN-LEARN: "high" | "medium" | "low" | "none"
  patternOccurrences:     number;  // PATTERN-LEARN: how many historical instances of this pattern
  patternWinRate:         number;  // PATTERN-LEARN: historical win rate for this pattern
  patternWasDuringETH:    boolean; // PATTERN-LEARN: ETH pattern performance tracking
  // ZONE-LEARN: zone-specific metrics
  zoneType:          string;  // ZONE-LEARN: "support" | "resistance" | "none"
  candleBreakthrough: boolean; // ZONE-LEARN: candle broke through zone on close vs just touching
}

export interface LearningLog {
  runAt: string;
  signalCount: number;
  winRate: number;
  byTier: Record<string, { count: number; wins: number }>;
  byBucket: Record<string, { count: number; wins: number }>;
  trades: TradeLearning[];
  topInsight: string;
}

type SessionBucket = "pre-market" | "rth-open" | "mid-day" | "power-hour" | "ah";

function classifyBucket(timestampSec: number): SessionBucket {
  const d = new Date(timestampSec * 1000);
  const etFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const et = etFmt.format(d);
  const col = et.indexOf(":");
  const etMins = parseInt(et.slice(0, col)) * 60 + parseInt(et.slice(col + 1));
  if (etMins < 9 * 60 + 30) return "pre-market";
  if (etMins < 10 * 60 + 30) return "rth-open";
  if (etMins < 15 * 60) return "mid-day";
  if (etMins < 16 * 60) return "power-hour";
  return "ah";
}

// DST-safe RTH check (Mon–Fri 9:30 AM–4:00 PM ET). Replaces the old hardcoded 13:30–21:00 UTC
// windows, which were both an hour off in winter (EST) AND ended at 5 PM instead of 4 PM.
const _rthEtFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
function isRTHsec(timestampSec: number): boolean {
  const parts = _rthEtFmt.formatToParts(new Date(timestampSec * 1000));
  const wd = parts.find(p => p.type === "weekday")?.value ?? "";
  if (wd === "Sat" || wd === "Sun") return false;
  const h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 17 * 60; // 9:30 AM – 5:00 PM ET
}

function parseFp(trade: typeof signalHistory.$inferSelect): any | null {
  if (!trade.footprintReading) return null;
  try { return JSON.parse(trade.footprintReading); } catch { return null; }
}

function buildWhyWorked(trade: typeof signalHistory.$inferSelect): string {
  const parts: string[] = [];
  if (trade.riskLevel === "safe") parts.push("Milk zone confirmed entry");
  if (trade.riskLevel === "risky") parts.push("Secondary vector aligned");
  if (trade.signalType === "pure_tabletop") parts.push("Vector plateaued then broke out — momentum exhaustion resolved");
  if (trade.signalType === "side_tabletop") parts.push("Consolidation range breakout with measured move potential");
  const bucket = classifyBucket(trade.timestamp);
  if (bucket === "rth-open") parts.push("RTH open hour — highest institutional participation");
  if (bucket === "power-hour") parts.push("Power hour — directional follow-through common");
  // FOOTPRINT-LEARN: order-flow bonus signals
  const fp = parseFp(trade); // FOOTPRINT-LEARN:
  if (fp?.confirmed)         parts.push("Footprint confirmed: order flow aligned with direction"); // FOOTPRINT-LEARN:
  if (fp?.absorption)        parts.push("Absorption detected at zone boundary — institutional defense"); // FOOTPRINT-LEARN:
  if (fp?.stackedImbalance)  parts.push("Stacked imbalances present — aggressive directional volume"); // FOOTPRINT-LEARN:
  if (fp?.trappedTraders)    parts.push("Trapped traders provided forced-exit fuel for the move"); // FOOTPRINT-LEARN:
  if (fp?.unfinishedAuction) parts.push("Unfinished auction acted as magnet for TP target"); // FOOTPRINT-LEARN:
  if (fp?.exitAdjustments?.tp2Extension != null) parts.push("TP2 extended 20% for stacked imbalances — momentum carried further"); // FOOTPRINT-LEARN:
  if (fp?.exitAdjustments?.usePocStop)  parts.push("POC stop tightened risk; price never revisited POC"); // FOOTPRINT-LEARN:
  // VECTOR-LEARN: vector setup quality
  if (trade.signalType === "side_tabletop") parts.push("Side tabletop consolidation provided coiled energy for breakout"); // VECTOR-LEARN:
  // ZONE-LEARN: zone breakthrough confirmation
  if (trade.riskLevel === "safe") parts.push("Price closed inside zone on signal candle — full zone breakthrough"); // ZONE-LEARN:
  return parts.length > 0 ? parts.join("; ") : "Conditions aligned across multiple timeframes";
}

function buildWhyFailed(trade: typeof signalHistory.$inferSelect): string {
  const parts: string[] = [];
  if (trade.riskLevel === "riskiest") parts.push("No zone or secondary vector confirmation — low conviction entry");
  if (trade.riskLevel === "risky") parts.push("Missing Milk zone confirmation — overhead supply risk unquantified");
  const bucket = classifyBucket(trade.timestamp);
  if (bucket === "pre-market") parts.push("Pre-market: thin liquidity, wide spreads inflate stop risk");
  if (bucket === "ah") parts.push("After-hours: institutional players absent, moves less reliable");
  if (bucket === "mid-day") parts.push("Mid-day chop — vector signals less reliable during consolidation phase");
  // FOOTPRINT-LEARN: order-flow failure notes
  const fp = parseFp(trade); // FOOTPRINT-LEARN:
  if (fp?.partial)  parts.push("Footprint partial at entry — delta agreed but no absorption/imbalance/trap to confirm"); // FOOTPRINT-LEARN:
  if (!fp)          parts.push("No footprint data — order-flow confirmation unavailable for this session"); // FOOTPRINT-LEARN:
  if (fp?.candleDelta === 0) parts.push("Delta was exactly zero — no confirmed directional aggression at entry"); // FOOTPRINT-LEARN:
  // VECTOR-LEARN: vector failure notes
  if (trade.riskLevel === "risky" && trade.direction === "Short") parts.push("Short via vector only — vector is not strong confluence for shorts, extra confirmation required"); // VECTOR-LEARN:
  // ZONE-LEARN: zone failure notes
  if (trade.riskLevel === "riskiest") parts.push("Only one primary confirmation fired — insufficient for high-probability entry in trending conditions"); // ZONE-LEARN:
  return parts.length > 0 ? parts.join("; ") : "Entry lacked sufficient confluence to overcome noise";
}

function buildCouldHaveDoneBetter(trade: typeof signalHistory.$inferSelect): string {
  const fp = parseFp(trade);
  if (trade.riskLevel === "riskiest") return "Wait for Milk zone confirmation before entry — this was vector-only";
  if (trade.riskLevel === "risky" && trade.outcome === "loss" && trade.direction === "Short")
    return "Short via vector: always require zone or footprint co-confirmation — vector is not strong shorts confirmation";
  if (trade.riskLevel === "risky" && trade.outcome === "loss") return "Check 60m vector direction before entry; declining 60m overrides 5m setup";
  if (trade.outcome === "loss" && trade.signalType === "side_tabletop") return "Side tabletop entries benefit from waiting for the first pullback retest of breakout level";
  if (fp?.partial && trade.outcome === "loss") return "Footprint partial: wait for at least one bonus signal (absorption/imbalance/trap) before entering";
  if (!fp && trade.outcome === "loss") return "No footprint data available — ensure MotiveWave tick relay is active before taking live trades";
  if (isWinOutcome(trade.outcome)) return "No improvement needed — conditions were confirmed, execution was correct";
  return "Review 60m vector direction and Milk zone status before similar setups";
}

function buildWatchNextTime(trade: typeof signalHistory.$inferSelect): string {
  const bucket = classifyBucket(trade.timestamp);
  const fp = parseFp(trade);
  if (bucket === "rth-open") return "Watch for continuation vs fade — first 30 min often sets the day's bias direction";
  if (bucket === "power-hour") return "Power hour moves tend to extend past TP1 — consider partial at TP1, let remainder run to TP2";
  if (bucket === "mid-day") return "Mid-day signals often form chop — require 3+ vector intervals aligned before entry";
  if (fp?.stackedImbalance) return "Stacked imbalances often carry to TP2 — consider holding full position past TP1 when imbalances present";
  if (fp?.absorption) return "Absorption at zone is the strongest single confluence — watch for repeat absorption on retest for re-entry";
  if (trade.riskLevel === "safe") return "Safe signals near key levels (HOD/LOD) should still apply the 5-pt proximity check";
  return "Verify 60m vector slope before entry; it overrides all lower-interval setups";
}

function isWinOutcome(outcome: string | null | undefined): boolean {
  return !!outcome && outcome.startsWith("win");
}

export async function runLearningSession(symbol = "MES", interval = "5m"): Promise<LearningLog> {
  const signals = db
    .select()
    .from(signalHistory)
    .orderBy(desc(signalHistory.timestamp))
    .all() as (typeof signalHistory.$inferSelect)[];

  const closed = signals.filter((s) => s.outcome && s.outcome !== "open" && s.outcome !== "unknown");

  const byTier: Record<string, { count: number; wins: number }> = {};
  const byBucket: Record<string, { count: number; wins: number }> = {};

  const trades: TradeLearning[] = closed.map((s) => {
    const bucket = classifyBucket(s.timestamp);
    const isWin = isWinOutcome(s.outcome);

    if (!byTier[s.riskLevel]) byTier[s.riskLevel] = { count: 0, wins: 0 };
    byTier[s.riskLevel].count++;
    if (isWin) byTier[s.riskLevel].wins++;

    if (!byBucket[bucket]) byBucket[bucket] = { count: 0, wins: 0 };
    byBucket[bucket].count++;
    if (isWin) byBucket[bucket].wins++;

    const fp = parseFp(s); // FOOTPRINT-LEARN:
    return {
      signalId: s.id,
      time: s.timestamp,
      direction: s.direction,
      riskLevel: s.riskLevel,
      signalType: s.signalType ?? "confluence",
      entry: s.entry,
      tp1: s.tp1,
      tp2: s.tp2,
      sl: s.sl,
      outcome: s.outcome ?? "open",
      sessionBucket: bucket,
      whyWorkedOrFailed: isWinOutcome(s.outcome) ? buildWhyWorked(s) : buildWhyFailed(s),
      couldHaveDoneBetter: buildCouldHaveDoneBetter(s),
      watchNextTime: buildWatchNextTime(s),
      // FOOTPRINT-LEARN: order-flow fields from stored FootprintReading
      footprintConfirmed:    fp?.confirmed  ?? false, // FOOTPRINT-LEARN:
      footprintPartial:      fp?.partial    ?? false, // FOOTPRINT-LEARN:
      footprintVetoed:       fp?.vetoed     ?? false, // FOOTPRINT-LEARN:
      absorptionDetected:    !!fp?.absorption,        // FOOTPRINT-LEARN:
      stackedImbalance:      !!fp?.stackedImbalance,  // FOOTPRINT-LEARN:
      trappedTraders:        !!fp?.trappedTraders,    // FOOTPRINT-LEARN:
      pocStopUsed:           fp?.exitAdjustments?.usePocStop       ?? false, // FOOTPRINT-LEARN:
      tp1WasAuctionLevel:    fp?.exitAdjustments?.tp1Override      != null,  // FOOTPRINT-LEARN:
      tp2WasExtended:        fp?.exitAdjustments?.tp2Extension     != null,  // FOOTPRINT-LEARN:
      midTradeDivergence:    false, // FOOTPRINT-LEARN: ephemeral — not stored, only live alerts
      footprintFiredAlone:   (fp?.confirmed ?? false) && s.riskLevel === "risky", // FOOTPRINT-LEARN: risky + fp confirmed = likely standalone (no zone)
      footprintDeltaValue:   fp?.candleDelta ?? 0, // FOOTPRINT-LEARN:
      footprintWasDuringETH: !isRTHsec(s.timestamp), // FOOTPRINT-LEARN: ETH = anything outside RTH
      // VECTOR-LEARN: inferred from signal type and tier
      vectorTimeframesConfirmed: 0, // VECTOR-LEARN: not stored in DB row; would need a schema column to track
      vectorWasPrimary:    true, // VECTOR-LEARN: default — cannot derive from DB row without confirmations column
      vectorSetupType:     s.signalType === "side_tabletop" ? "tested_tabletop" : s.signalType === "pure_tabletop" ? "breakout" : "side_entry", // VECTOR-LEARN:
      vectorShortTrade:    s.direction === "Short", // VECTOR-LEARN:
      // PATTERN-LEARN: not yet tracked per signal; placeholders for future learn engine upgrade
      patternFiredAlone:      false, // PATTERN-LEARN: requires pattern tracking in signal save
      patternConfidenceLevel: "none", // PATTERN-LEARN:
      patternOccurrences:     0,     // PATTERN-LEARN:
      patternWinRate:         0,     // PATTERN-LEARN:
      patternWasDuringETH:    false, // PATTERN-LEARN:
      // ZONE-LEARN: zone type from signal data
      zoneType:          s.riskLevel === "safe" ? "support" : "none", // ZONE-LEARN: simplified — safe = zone confirmed
      candleBreakthrough: s.riskLevel === "safe", // ZONE-LEARN: safe signals require zone breakthrough
    };
  });

  const wins = closed.filter((s) => isWinOutcome(s.outcome)).length;
  const winRate = closed.length > 0 ? wins / closed.length : 0;

  // Pick top insight based on data
  let topInsight = "Insufficient closed signal data for pattern analysis.";
  const safeWr = byTier["safe"] ? byTier["safe"].wins / byTier["safe"].count : null;
  const riskyWr = byTier["risky"] ? byTier["risky"].wins / byTier["risky"].count : null;
  if (safeWr !== null && riskyWr !== null) {
    if (safeWr - riskyWr > 0.15) {
      topInsight = `Safe signals outperform Risky by ${((safeWr - riskyWr) * 100).toFixed(0)}pp — prioritize Milk zone confirmation.`;
    } else if (riskyWr - safeWr > 0.1) {
      topInsight = `Risky signals are outperforming Safe by ${((riskyWr - safeWr) * 100).toFixed(0)}pp — zone filter may be too restrictive for current conditions.`;
    } else {
      topInsight = `Safe and Risky tiers performing similarly (${(safeWr * 100).toFixed(0)}% vs ${(riskyWr * 100).toFixed(0)}%) — market structure is consistent.`;
    }
  }

  const log: LearningLog = {
    runAt: new Date().toISOString(),
    signalCount: closed.length,
    winRate,
    byTier,
    byBucket,
    trades,
    topInsight,
  };

  db.insert(learningSessions).values({
    symbol,
    interval,
    signalCount: closed.length,
    summary: JSON.stringify(log),
  }).run();

  return log;
}

// ── Strategy Proposal Generation ──────────────────────────────────────────────────────────────────

export interface StrategyProposal {
  strategyId:    string;      // e.g. "footprint", "vector", "milks-zones"
  ruleKey:       string;      // machine-readable rule identifier
  proposedChange: string;     // human-readable description of the proposed rule change
  rationale:     string;      // why the data supports this change
  samplesUsed:   number;      // how many closed trades informed this proposal
  confidence:    number;       // 0–1 confidence score
  currentValue:  string;      // what the rule currently says
  proposedValue: string;      // what the rule would say after the change
  status:        "pending" | "approved" | "rejected";
  createdAt:     string;
}

export function generateStrategyProposals(log: LearningLog): StrategyProposal[] {
  const proposals: StrategyProposal[] = [];
  const now = new Date().toISOString();
  const MIN_SAMPLES = 20;

  if (log.signalCount < MIN_SAMPLES) return proposals; // not enough data

  // ── Rule 1: If RISKIEST tier win rate < 35% over ≥20 samples → propose raising min confidence ──
  const riskiest = log.byTier["riskiest"];
  if (riskiest && riskiest.count >= MIN_SAMPLES) {
    const wr = riskiest.wins / riskiest.count;
    if (wr < 0.35) {
      proposals.push({
        strategyId: "milks-zones",
        ruleKey: "min_confidence_riskiest",
        proposedChange: "Suppress RISKIEST tier signals entirely — win rate below minimum threshold",
        rationale: `RISKIEST signals won ${(wr * 100).toFixed(0)}% of ${riskiest.count} trades — below 35% floor. These signals are statistically unprofitable.`,
        samplesUsed: riskiest.count,
        confidence: Math.min(0.95, 0.5 + (riskiest.count / 100)),
        currentValue: "RISKIEST signals fire when one primary confirmation present",
        proposedValue: "RISKIEST signals suppressed until win rate recovers above 40%",
        status: "pending",
        createdAt: now,
      });
    }
  }

  // ── Rule 2: If SAFE win rate > 80% over ≥20 samples → propose relaxing zone proximity tolerance ──
  const safe = log.byTier["safe"];
  if (safe && safe.count >= MIN_SAMPLES) {
    const wr = safe.wins / safe.count;
    if (wr > 0.80) {
      proposals.push({
        strategyId: "milks-zones",
        ruleKey: "zone_proximity_tolerance",
        proposedChange: "Widen zone proximity tolerance from 2 pts to 4 pts — safe signals are consistently profitable",
        rationale: `SAFE signals won ${(wr * 100).toFixed(0)}% of ${safe.count} trades. Relaxing entry tolerance captures more zone touches without adding risk.`,
        samplesUsed: safe.count,
        confidence: Math.min(0.9, 0.4 + (safe.count / 80)),
        currentValue: "Zone proximity: within 2 pts of zone boundary",
        proposedValue: "Zone proximity: within 4 pts of zone boundary",
        status: "pending",
        createdAt: now,
      });
    }
  }

  // ── Rule 3: If footprint-confirmed trades win significantly more than non-fp trades ──
  const fpTrades   = log.trades.filter(t => t.footprintConfirmed);
  const noFpTrades = log.trades.filter(t => !t.footprintConfirmed && !t.footprintPartial);
  if (fpTrades.length >= MIN_SAMPLES && noFpTrades.length >= MIN_SAMPLES) {
    const fpWr   = fpTrades.filter(t => t.outcome.startsWith("win")).length   / fpTrades.length;
    const noFpWr = noFpTrades.filter(t => t.outcome.startsWith("win")).length / noFpTrades.length;
    if (fpWr - noFpWr > 0.20) {
      proposals.push({
        strategyId: "footprint",
        ruleKey: "footprint_required_for_safe",
        proposedChange: "Require footprint confirmation to achieve SAFE tier — downgrade zone+vector without fp to RISKY",
        rationale: `Footprint-confirmed trades: ${(fpWr*100).toFixed(0)}% WR. Non-fp trades: ${(noFpWr*100).toFixed(0)}% WR. Gap of ${((fpWr-noFpWr)*100).toFixed(0)}pp justifies requiring fp for SAFE.`,
        samplesUsed: fpTrades.length + noFpTrades.length,
        confidence: Math.min(0.95, 0.45 + ((fpWr - noFpWr) * 1.5)),
        currentValue: "Zone + Vector → SAFE (fp optional — graceful fallback)",
        proposedValue: "Zone + Vector + Footprint FULL → SAFE; Zone + Vector only → RISKY",
        status: "pending",
        createdAt: now,
      });
    }
  }

  // ── Rule 4: If absorption detection correlates with significantly higher win rate ──
  const absorptionTrades = log.trades.filter(t => t.absorptionDetected);
  if (absorptionTrades.length >= MIN_SAMPLES) {
    const absWr = absorptionTrades.filter(t => t.outcome.startsWith("win")).length / absorptionTrades.length;
    if (absWr > 0.78) {
      proposals.push({
        strategyId: "footprint",
        ruleKey: "absorption_zone_bonus_weight",
        proposedChange: "Elevate absorption at zone boundary from bonus signal to required condition for SAFE tier",
        rationale: `Absorption-confirmed trades won ${(absWr*100).toFixed(0)}% of ${absorptionTrades.length} trades — well above SAFE tier threshold.`,
        samplesUsed: absorptionTrades.length,
        confidence: Math.min(0.90, absWr),
        currentValue: "Absorption: one of four bonus signals (any one satisfies Condition 2)",
        proposedValue: "Absorption at zone boundary required for SAFE tier when footprint data available",
        status: "pending",
        createdAt: now,
      });
    }
  }

  // ── Rule 5: If power-hour bucket consistently outperforms → propose reduced cooldown in that window ──
  const ph = log.byBucket["power-hour"];
  if (ph && ph.count >= MIN_SAMPLES) {
    const phWr = ph.wins / ph.count;
    if (phWr > 0.75) {
      proposals.push({
        strategyId: "vector",
        ruleKey: "power_hour_cooldown",
        proposedChange: "Reduce signal cooldown from 10 to 6 bars during power hour (15:00–16:00 ET)",
        rationale: `Power hour signals win ${(phWr*100).toFixed(0)}% of ${ph.count} trades — faster cycling would capture more profitable setups in this window.`,
        samplesUsed: ph.count,
        confidence: Math.min(0.85, 0.4 + (phWr * 0.6)),
        currentValue: "Cooldown: 10 RTH bars between signals in all sessions",
        proposedValue: "Cooldown: 6 RTH bars during power hour (15:00–16:00 ET only)",
        status: "pending",
        createdAt: now,
      });
    }
  }

  // ── Rule 6: If stacked-imbalance trades consistently reach TP2 → propose increasing TP2 extension ──
  const stackedTrades = log.trades.filter(t => t.stackedImbalance);
  if (stackedTrades.length >= MIN_SAMPLES) {
    const tp2Rate = stackedTrades.filter(t => t.outcome === "win_tp2").length / stackedTrades.length;
    if (tp2Rate > 0.60) {
      proposals.push({
        strategyId: "footprint",
        ruleKey: "stacked_imbalance_tp2_extension",
        proposedChange: "Increase stacked-imbalance TP2 extension from 20% to 30%",
        rationale: `${(tp2Rate*100).toFixed(0)}% of stacked-imbalance trades hit TP2 (${stackedTrades.length} samples). Higher extension captures more of the institutional move.`,
        samplesUsed: stackedTrades.length,
        confidence: Math.min(0.90, 0.4 + (tp2Rate * 0.7)),
        currentValue: "TP2 extension: +20% when stacked imbalances present",
        proposedValue: "TP2 extension: +30% when stacked imbalances present",
        status: "pending",
        createdAt: now,
      });
    }
  }

  return proposals;
}

// ── Backfill: compute signals for ALL cached_candles across every symbol+resolution ──────────────

const VEC_N = 20;

function computeVectorArr(lows: number[]): number[] {
  const n = lows.length;
  // Step 1: rolling min of lows over N bars
  const lowestLow = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let j = Math.max(0, i - VEC_N + 1); j <= i; j++) {
      if (lows[j] < m) m = lows[j];
    }
    lowestLow[i] = m;
  }
  // Step 2: rolling max of lowestLow over N bars
  const vector = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.max(0, i - VEC_N + 1); j <= i; j++) {
      if (lowestLow[j] > m) m = lowestLow[j];
    }
    vector[i] = m;
  }
  return vector;
}

/** Walk forward from signalIdx to find outcome against fixed TP/SL levels. */
function walkForwardServer(
  candles: { high: number; low: number }[],
  signalIdx: number,
  tp1: number, tp2: number, sl: number, isLong: boolean,
): "win_tp1" | "win_tp2" | "loss" | "open" {
  for (let j = signalIdx + 1; j < Math.min(signalIdx + 120, candles.length); j++) {
    const f = candles[j];
    if (isLong) {
      if (f.high >= tp2) return "win_tp2";
      if (f.high >= tp1) return "win_tp1";
      if (f.low  <= sl)  return "loss";
    } else {
      if (f.low  <= tp2) return "win_tp2";
      if (f.low  <= tp1) return "win_tp1";
      if (f.high >= sl)  return "loss";
    }
  }
  return "open";
}

/** Compute and persist signals for every symbol+resolution in cached_candles that isn't already in signal_history. */
export async function backfillSignals(): Promise<{ inserted: number; skipped: number }> {
  // Fixed exit params (risky tier: no zone info server-side)
  const TP1 = 8.0, TP2 = 16.0, SL = 5.0;
  const COOLDOWN = 10; // bars between signals

  // Get distinct symbol+resolution combos
  const combos = db.all(
    sql`SELECT DISTINCT symbol, resolution FROM cached_candles ORDER BY symbol, resolution`,
  ) as { symbol: string; resolution: string }[];

  let inserted = 0, skipped = 0;

  for (const { symbol, resolution } of combos) {
    const interval = resolution === "60" ? "60m" : resolution === "15" ? "15m" : resolution === "5" ? "5m" : "1m";

    const rows = db.select().from(cachedCandles)
      .where(and(eq(cachedCandles.symbol, symbol), eq(cachedCandles.resolution, resolution)))
      .orderBy(cachedCandles.timestamp)
      .all() as (typeof cachedCandles.$inferSelect)[];

    if (rows.length < VEC_N * 2) continue;

    const lows   = rows.map(r => r.low);
    const vector = computeVectorArr(lows);

    let lastSignalBar = -COOLDOWN;

    for (let i = VEC_N; i < rows.length - 1; i++) {
      const c    = rows[i];
      const lb   = vector[i];
      const prev = vector[i - 1];
      if (!lb || !prev || lb <= 0) continue;

      const rising   = lb >= prev;
      const falling  = lb <= prev;
      const isLong  = c.close > lb && rising;
      const isShort = c.close < lb && falling;
      if (!isLong && !isShort) continue;
      if (i - lastSignalBar < COOLDOWN) continue;

      // RTH filter: Mon–Fri 9:30 AM–4:00 PM ET (DST-safe)
      if (!isRTHsec(c.timestamp)) continue;

      lastSignalBar = i;

      const tp1 = isLong ? c.close + TP1 : c.close - TP1;
      const tp2 = isLong ? c.close + TP2 : c.close - TP2;
      const sl  = isLong ? c.close - SL  : c.close + SL;

      const outcome = walkForwardServer(rows, i, tp1, tp2, sl, isLong);
      if (outcome === "open") { skipped++; continue; } // skip incomplete — no outcome yet

      try {
        db.insert(signalHistory).values({
          symbol,
          interval,
          timestamp:   c.timestamp,
          direction:   isLong ? "Long" : "Short",
          riskLevel:   "risky", // no zone data server-side
          signalType:  "confluence",
          entry:       c.close,
          tp1, tp2, sl,
          outcome,
          updatedAt:   new Date().toISOString(),
        }).onConflictDoNothing().run();
        inserted++;
      } catch {
        skipped++;
      }
    }
  }

  return { inserted, skipped };
}
