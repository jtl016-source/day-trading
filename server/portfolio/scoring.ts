// ── Confluence scoring engine ─────────────────────────────────────────────────
// Deterministic, transparent 0–100 score mirroring the weighted-tier philosophy of
// the futures signal engine. ALL weights live in PORTFOLIO_WEIGHTS so they're tunable
// in one place (the MC_EXIT-style config). Every sub-metric is surfaced in the
// breakdown so the UI transparency panel can show exactly how the number was built.
import { getFundamentals, getBenchmark12m1m } from "./fundamentalsService";
import { getOwnershipFor } from "./smartMoneyService";
import { getInsiderFor } from "./insiderService";
import { getRecentCongress } from "./congressService";
import type { ScoreBreakdown, Pillar } from "./types";

export const PORTFOLIO_WEIGHTS = {
  pillars: { quality: 30, value: 20, momentum: 20, smartMoney: 20, congressInsider: 10 },
  quality: { roe: 5, roic: 5, debtToEquity: 5, interestCoverage: 5, fcfConsistency: 5, marginStability: 5 },
  value: { pToFcf: 7, evToEbitda: 7, pe: 6, qualityGateFrac: 0.5, trapCapFrac: 0.5 },
  momentum: { max: 20, excessLo: -0.10, excessHi: 0.30 },
  smartMoney: { perHolder: 2, holderCap: 8, perAdder: 1.2, adderCap: 6, topTenBonus: 3, max: 20 },
  congressInsider: { congressMax: 6, insiderMax: 4, max: 10, multiPoliticianMult: 2 },
  thresholds: { crowdedHolders: 15, disclosureLagDays: 30 },
} as const;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
// higher-is-better ramp: 0 at lo, 1 at hi
const up = (v: number | null, lo: number, hi: number) => (v === null ? 0 : clamp01((v - lo) / (hi - lo)));
// lower-is-better ramp: 1 at lo (cheap/safe), 0 at hi (expensive/risky)
const down = (v: number | null, hi: number, lo: number) => (v === null || v <= 0 ? 0 : clamp01((hi - v) / (hi - lo)));

export async function scoreStock(tickerRaw: string): Promise<ScoreBreakdown> {
  const ticker = tickerRaw.toUpperCase().trim();
  const [f, own, ins, congress, bench] = await Promise.all([
    getFundamentals(ticker), getOwnershipFor(ticker), getInsiderFor(ticker), getRecentCongress(), getBenchmark12m1m(),
  ]);
  const fund = f.value;
  const W = PORTFOLIO_WEIGHTS;
  const flags: string[] = [];

  // ── QUALITY (30) ────────────────────────────────────────────────────────────
  const q = {
    roe: up(fund.roe, 0.05, 0.15) * W.quality.roe,
    roic: up(fund.roic, 0.04, 0.12) * W.quality.roic,
    debtToEquity: down(fund.debtToEquity, 1.5, 0.3) * W.quality.debtToEquity,
    interestCoverage: up(fund.interestCoverage, 1, 5) * W.quality.interestCoverage,
    fcfConsistency: (fund.fcfPositiveYears / 5) * W.quality.fcfConsistency,
    marginStability: (fund.grossMarginStability ?? 0) * W.quality.marginStability,
  };
  const qualityScore = Object.values(q).reduce((a, b) => a + b, 0);

  // ── VALUE (20) with value-trap guard ────────────────────────────────────────
  const vRaw = down(fund.pToFcf, 35, 10) * W.value.pToFcf
    + down(fund.evToEbitda, 20, 7) * W.value.evToEbitda
    + down(fund.pe, 40, 10) * W.value.pe;
  const qualityFrac = qualityScore / W.pillars.quality;
  let valueScore = vRaw;
  if (qualityFrac < W.value.qualityGateFrac) {
    const cap = W.pillars.value * W.value.trapCapFrac;
    if (vRaw > cap) { valueScore = cap; flags.push("VALUE_TRAP_GUARD"); }
  }

  // ── MOMENTUM (20) with 200-DMA regime filter ────────────────────────────────
  let momentumScore = 0;
  const excess = fund.return12m1m !== null && bench.value !== null ? fund.return12m1m - bench.value : null;
  if (fund.above200dma === false) {
    momentumScore = 0;
    flags.push("BELOW_200DMA");
  } else {
    momentumScore = up(excess, W.momentum.excessLo, W.momentum.excessHi) * W.momentum.max;
  }

  // ── SMART MONEY (20) — diminishing past 8 holders ────────────────────────────
  const smHolders = Math.min(own.value.holders, W.smartMoney.holderCap) * W.smartMoney.perHolder;
  const smAdders = Math.min(own.value.adders * W.smartMoney.perAdder, W.smartMoney.adderCap);
  const smTopTen = own.value.topTenAnywhere ? W.smartMoney.topTenBonus : 0;
  const smartMoneyScore = Math.min(W.smartMoney.max, smHolders + smAdders + smTopTen);
  if (own.value.holders > W.thresholds.crowdedHolders) flags.push("CROWDED");

  // ── CONGRESS + INSIDER (10) ──────────────────────────────────────────────────
  const tTrades = congress.value.filter((t) => t.ticker === ticker && t.type === "buy");
  const distinctPols = new Set(tTrades.map((t) => t.politician)).size;
  let congressRaw = 0;
  let newestLag = Infinity;
  for (const t of tTrades) {
    const ageDays = Math.max(0, (Date.now() - Date.parse(t.transactionDate)) / 86_400_000);
    newestLag = Math.min(newestLag, ageDays);
    const amountW = clamp01(Math.log10(Math.max(1, t.amountMid)) / Math.log10(1_000_000)); // ~$1 → $1M
    const recencyW = clamp01(1 - ageDays / 90);
    congressRaw += amountW * (0.5 + 0.5 * recencyW);
  }
  if (distinctPols >= 2) congressRaw *= W.congressInsider.multiPoliticianMult;
  const congressScore = Math.min(W.congressInsider.congressMax, congressRaw * 3);
  if (tTrades.length && Number.isFinite(newestLag) && newestLag > W.thresholds.disclosureLagDays) flags.push("DISCLOSURE_LAG");

  const insiderScore = Math.min(
    W.congressInsider.insiderMax,
    up(ins.value.totalValue, 100_000, 1_000_000) * W.congressInsider.insiderMax,
  );
  const congressInsiderScore = Math.min(W.congressInsider.max, congressScore + insiderScore);

  // ── Total + grade ─────────────────────────────────────────────────────────────
  const total = Math.round(qualityScore + valueScore + momentumScore + smartMoneyScore + congressInsiderScore);
  const grade: ScoreBreakdown["grade"] = total >= 80 ? "A" : total >= 65 ? "B" : total >= 50 ? "C" : total >= 35 ? "D" : "F";
  const dataStale = f.dataStale || own.dataStale || ins.dataStale || congress.dataStale || bench.dataStale;

  const pillars: ScoreBreakdown["pillars"] = {
    quality: { score: round1(qualityScore), max: W.pillars.quality, metrics: {
      roe: pct(fund.roe), roic: pct(fund.roic), debtToEquity: r2(fund.debtToEquity),
      interestCoverage: r2(fund.interestCoverage), fcfPositiveYears: fund.fcfPositiveYears,
      grossMarginStability: pct(fund.grossMarginStability),
    } },
    value: { score: round1(valueScore), max: W.pillars.value, metrics: {
      pe: r2(fund.pe), evToEbitda: r2(fund.evToEbitda), pToFcf: r2(fund.pToFcf),
      pToBook: r2(fund.pToBook), fcfYield: pct(fund.fcfYield), qualityGate: round1(qualityFrac * 100) + "%",
    } },
    momentum: { score: round1(momentumScore), max: W.pillars.momentum, metrics: {
      return12m1m: pct(fund.return12m1m), spy12m1m: pct(bench.value), excessVsSpy: pct(excess),
      above200dma: fund.above200dma === null ? "n/a" : String(fund.above200dma), volatility252d: pct(fund.volatility252d),
    } },
    smartMoney: { score: round1(smartMoneyScore), max: W.pillars.smartMoney, metrics: {
      superinvestorHolders: own.value.holders, addedLastQuarter: own.value.adders,
      topTenPositionSomewhere: String(own.value.topTenAnywhere),
    } },
    congressInsider: { score: round1(congressInsiderScore), max: W.pillars.congressInsider, metrics: {
      congressBuys: tTrades.length, distinctPoliticians: distinctPols,
      insiderBuyCount: ins.value.count, insiderBuyValue: Math.round(ins.value.totalValue),
    } },
  };

  return { ticker, total, grade, pillars, flags, dataStale, asOf: Date.now() };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
const pct = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10); // fraction → % with 1dp

export type { ScoreBreakdown, Pillar };
