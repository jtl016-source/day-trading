// ── smartMoneyService — 13F holdings for tracked superinvestors (TTL 24h) ─────
// One expensive build (≈2 FMP calls per fund, concurrency-limited) is cached for
// 24h and powers BOTH the fund grid and the cross-fund consensus, so the daily
// budget cost is bounded by the number of tracked CIKs, not by how often it's viewed.
import { fmpGet, arr, num } from "./fmpClient";
import { swr, type SwrResult } from "./cache";
import { SUPERINVESTORS } from "./superinvestors";
import type { SuperinvestorFund, FundHolding, ConsensusRow } from "./types";

const TTL = 24 * 60 * 60 * 1000;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

function classify(h: any): FundHolding["change"] {
  if (h.isNew === true) return "new";
  if (h.isSoldOut === true) return "exit";
  const ch = num(h.changeInSharesNumberPercentage) ?? num(h.changeInSharesNumber);
  if (ch === null || ch === 0) return "hold";
  return ch > 0 ? "add" : "trim";
}

async function buildFund(s: { cik: string; manager: string; fund: string }): Promise<SuperinvestorFund> {
  const base: SuperinvestorFund = {
    cik: s.cik, manager: s.manager, fund: s.fund, portfolioValue: 0, asOf: "",
    topHoldings: [], newBuys: [], exits: [], dataStale: true,
  };
  try {
    const dates = arr<any>(await fmpGet<any[]>("/institutional-ownership/portfolio-date", { cik: s.cik, page: 0 }, { base: "v4" }));
    const latest = (dates[0]?.date as string) ?? "";
    if (!latest) return base;
    const rows = arr<any>(await fmpGet<any[]>("/institutional-ownership/portfolio-holdings", { cik: s.cik, date: latest, page: 0 }, { base: "v4" }));
    if (!rows.length) return { ...base, asOf: latest };

    const holdings: FundHolding[] = rows.map((h) => ({
      ticker: String(h.symbol ?? "").toUpperCase(),
      name: h.securityName ?? h.nameOfIssuer ?? h.symbol ?? "",
      shares: num(h.sharesNumber ?? h.shares) ?? 0,
      marketValue: num(h.marketValue) ?? 0,
      weight: num(h.weight) ?? 0,
      change: classify(h),
      changePct: num(h.changeInSharesNumberPercentage),
    })).filter((h) => h.ticker);

    const portfolioValue = holdings.reduce((a, h) => a + h.marketValue, 0);
    // FMP weight is sometimes 0–1, sometimes 0–100 — normalize to percent.
    const maxW = Math.max(0, ...holdings.map((h) => h.weight));
    if (maxW > 0 && maxW <= 1) holdings.forEach((h) => (h.weight = h.weight * 100));

    const byWeight = [...holdings].sort((a, b) => b.weight - a.weight);
    return {
      ...base,
      portfolioValue,
      asOf: latest,
      topHoldings: byWeight.slice(0, 10),
      newBuys: holdings.filter((h) => h.change === "new").sort((a, b) => b.marketValue - a.marketValue).slice(0, 8),
      exits: holdings.filter((h) => h.change === "exit").sort((a, b) => b.marketValue - a.marketValue).slice(0, 8),
      dataStale: false,
    };
  } catch {
    return base;
  }
}

export async function getAllFunds(): Promise<SwrResult<SuperinvestorFund[]>> {
  return swr<SuperinvestorFund[]>(
    "smartmoney:all",
    TTL,
    async () => mapLimit(SUPERINVESTORS, 4, buildFund),
    [],
  );
}

export async function getFund(cik: string): Promise<SwrResult<SuperinvestorFund | null>> {
  const { value, dataStale } = await getAllFunds();
  return { value: value.find((f) => f.cik === cik) ?? null, dataStale };
}

/** Fund list + lightweight summaries (no extra FMP calls beyond the cached build). */
export async function getFundsSummary(): Promise<SwrResult<Array<Pick<SuperinvestorFund, "cik" | "manager" | "fund" | "portfolioValue" | "asOf"> & { topTickers: string[] }>>> {
  const { value, dataStale } = await getAllFunds();
  return {
    value: value.map((f) => ({
      cik: f.cik, manager: f.manager, fund: f.fund, portfolioValue: f.portfolioValue,
      asOf: f.asOf, topTickers: f.topHoldings.slice(0, 5).map((h) => h.ticker),
    })),
    dataStale,
  };
}

/** Cross-fund ownership: how many tracked funds hold each ticker, and how many ADDED. */
export async function getConsensus(): Promise<SwrResult<ConsensusRow[]>> {
  const { value: funds, dataStale } = await getAllFunds();
  const map = new Map<string, ConsensusRow>();
  for (const f of funds) {
    for (const h of f.topHoldings) {
      let row = map.get(h.ticker);
      if (!row) { row = { ticker: h.ticker, holders: 0, adders: 0, funds: [] }; map.set(h.ticker, row); }
      row.holders++;
      row.funds.push(f.manager);
      if (h.change === "add" || h.change === "new") row.adders++;
    }
  }
  const rows = [...map.values()].sort((a, b) => b.holders - a.holders || b.adders - a.adders);
  return { value: rows, dataStale };
}

/** For scoring: ownership stats for a single ticker. */
export async function getOwnershipFor(ticker: string): Promise<SwrResult<{ holders: number; adders: number; topTenAnywhere: boolean }>> {
  const t = ticker.toUpperCase();
  const { value: funds, dataStale } = await getAllFunds();
  let holders = 0, adders = 0, topTenAnywhere = false;
  for (const f of funds) {
    const h = f.topHoldings.find((x) => x.ticker === t);
    if (h) { holders++; if (h.change === "add" || h.change === "new") adders++; topTenAnywhere = true; }
  }
  return { value: { holders, adders, topTenAnywhere }, dataStale };
}
