// ── fundamentalsService — per-ticker quality/value/growth/momentum (TTL 24h) ──
// Consolidates ~5 FMP calls per ticker behind a 24h SWR cache so the daily budget
// is dominated by how many DISTINCT tickers you score, not how often you refresh.
import { fmpGet, arr, num } from "./fmpClient";
import { swr, type SwrResult } from "./cache";
import type { Fundamentals } from "./types";

const TTL = 24 * 60 * 60 * 1000; // 24h

// pick the first finite value across candidate keys (FMP renames fields across endpoints)
const pick = (obj: any, ...keys: string[]): number | null => {
  for (const k of keys) { const v = num(obj?.[k]); if (v !== null) return v; }
  return null;
};

function priceMetrics(closes: { date: string; close: number }[]): {
  ret12m1m: number | null; above200: boolean | null; vol252: number | null;
} {
  // closes are oldest→newest
  if (closes.length < 40) return { ret12m1m: null, above200: null, vol252: null };
  const px = closes.map((c) => c.close);
  const last = px[px.length - 1];

  // 200-day MA (use up to last 200 trading days)
  const ma200win = px.slice(-200);
  const above200 = ma200win.length >= 100 ? last > ma200win.reduce((a, b) => a + b, 0) / ma200win.length : null;

  // 12-1 momentum: price ~21 trading days ago vs ~252 trading days ago (skip the most recent month)
  const iRecent = px.length - 1 - 21;
  const iYearAgo = px.length - 1 - 252;
  const ret12m1m = iRecent >= 0 && iYearAgo >= 0 && px[iYearAgo] > 0 ? px[iRecent] / px[iYearAgo] - 1 : null;

  // 252-day annualized volatility
  const window = px.slice(-253);
  let vol252: number | null = null;
  if (window.length > 30) {
    const rets: number[] = [];
    for (let i = 1; i < window.length; i++) if (window[i - 1] > 0) rets.push(window[i] / window[i - 1] - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
    vol252 = Math.sqrt(variance) * Math.sqrt(252);
  }
  return { ret12m1m, above200, vol252 };
}

function stdev(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

export async function getFundamentals(tickerRaw: string): Promise<SwrResult<Fundamentals>> {
  const ticker = tickerRaw.toUpperCase().trim();
  const empty: Fundamentals = {
    ticker, name: ticker, sector: "", price: 0,
    roe: null, roic: null, grossMargin: null, grossMarginStability: null, debtToEquity: null,
    interestCoverage: null, fcfPositiveYears: 0, earningsVariability: null,
    pe: null, evToEbitda: null, pToFcf: null, pToBook: null, fcfYield: null,
    revenueCagr5y: null, epsCagr5y: null, return12m1m: null, above200dma: null, volatility252d: null,
    dataStale: true,
  };

  return swr<Fundamentals>(
    `fundamentals:${ticker}`,
    TTL,
    async () => {
      const [profile, keyMetrics, ratios, growth, hist] = await Promise.all([
        fmpGet<any[]>(`/profile/${ticker}`).catch(() => []),
        fmpGet<any[]>(`/key-metrics/${ticker}`, { period: "annual", limit: 6 }).catch(() => []),
        fmpGet<any[]>(`/ratios/${ticker}`, { period: "annual", limit: 6 }).catch(() => []),
        fmpGet<any[]>(`/financial-growth/${ticker}`, { period: "annual", limit: 6 }).catch(() => []),
        fmpGet<any>(`/historical-price-full/${ticker}`, { serietype: "line", timeseries: 320 }).catch(() => null),
      ]);

      const p = arr<any>(profile)[0] ?? {};
      const km = arr<any>(keyMetrics);   // [0] = most recent year
      const rt = arr<any>(ratios);
      const gr = arr<any>(growth);
      const km0 = km[0] ?? {}, rt0 = rt[0] ?? {}, gr0 = gr[0] ?? {};

      // price history (FMP returns newest→oldest; flip to oldest→newest)
      const histRows = arr<any>(hist?.historical)
        .map((r) => ({ date: r.date as string, close: num(r.close) ?? 0 }))
        .filter((r) => r.close > 0)
        .reverse();
      const pm = priceMetrics(histRows);

      const grossSeries = rt.map((r) => num(r.grossProfitMargin)).filter((x): x is number => x !== null);
      const grossMean = grossSeries.length ? grossSeries.reduce((a, b) => a + b, 0) / grossSeries.length : null;
      const grossSd = stdev(grossSeries);
      const grossMarginStability = grossMean && grossMean !== 0 && grossSd !== null
        ? Math.max(0, 1 - Math.abs(grossSd / grossMean)) : null;

      const epsGrowthSeries = gr.map((g) => num(g.epsgrowth)).filter((x): x is number => x !== null);
      const earningsVariability = stdev(epsGrowthSeries);

      const fcfPositiveYears = km.slice(0, 5).filter((m) => (pick(m, "freeCashFlowPerShare") ?? -1) > 0).length;

      return {
        ticker,
        name: p.companyName ?? ticker,
        sector: p.sector ?? "",
        price: num(p.price) ?? (histRows.length ? histRows[histRows.length - 1].close : 0),
        roe: pick(km0, "roe") ?? pick(rt0, "returnOnEquity"),
        roic: pick(km0, "roic"),
        grossMargin: pick(rt0, "grossProfitMargin"),
        grossMarginStability,
        debtToEquity: pick(km0, "debtToEquity") ?? pick(rt0, "debtEquityRatio"),
        interestCoverage: pick(rt0, "interestCoverage") ?? pick(km0, "interestCoverage"),
        fcfPositiveYears,
        earningsVariability,
        pe: pick(km0, "peRatio") ?? pick(rt0, "priceEarningsRatio"),
        evToEbitda: pick(km0, "enterpriseValueOverEBITDA"),
        pToFcf: pick(km0, "pfcfRatio", "priceToFreeCashFlowsRatio") ?? pick(rt0, "priceToFreeCashFlowsRatio"),
        pToBook: pick(km0, "pbRatio") ?? pick(rt0, "priceToBookRatio"),
        fcfYield: pick(km0, "freeCashFlowYield"),
        revenueCagr5y: pick(gr0, "fiveYRevenueGrowthPerShare"),
        epsCagr5y: pick(gr0, "fiveYNetIncomeGrowthPerShare"),
        return12m1m: pm.ret12m1m,
        above200dma: pm.above200,
        volatility252d: pm.vol252,
        dataStale: false,
      };
    },
    empty,
  );
}

/** SPY 12-1 momentum benchmark (cached 24h, shared across all scores). */
export async function getBenchmark12m1m(): Promise<SwrResult<number | null>> {
  return swr<number | null>(
    "benchmark:SPY:12m1m",
    TTL,
    async () => {
      const hist = await fmpGet<any>(`/historical-price-full/SPY`, { serietype: "line", timeseries: 320 });
      const rows = arr<any>(hist?.historical).map((r) => num(r.close) ?? 0).filter((c) => c > 0).reverse();
      return priceMetrics(rows.map((c, i) => ({ date: String(i), close: c }))).ret12m1m;
    },
    null,
  );
}
