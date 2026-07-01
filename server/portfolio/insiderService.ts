// ── insiderService — latest open-market insider BUYS ≥ $100k (TTL 1h) ─────────
// Insider purchases are the signal; sales are noise and are filtered out.
import { fmpGet, arr, num } from "./fmpClient";
import { swr, type SwrResult } from "./cache";
import type { InsiderBuy } from "./types";

const TTL = 60 * 60 * 1000; // 1h
const MIN_VALUE = 100_000;
const OFFICER_RE = /director|officer|chief|ceo|cfo|coo|president|chairman|vp|vice president/i;

export async function getRecentInsiderBuys(): Promise<SwrResult<InsiderBuy[]>> {
  return swr<InsiderBuy[]>(
    "insider:recent",
    TTL,
    async () => {
      // Pull a couple of pages of the latest feed (small, cached) for better coverage.
      const pages = await Promise.all([0, 1].map((p) =>
        fmpGet<any[]>("/insider-trading-rss-feed", { page: p }, { base: "v4" }).catch(() => [])));
      const rows = pages.flatMap((p) => arr<any>(p));
      const buys: InsiderBuy[] = [];
      for (const r of rows) {
        const type = String(r.transactionType ?? "");
        if (!/p-?purchase|^p$|purchase/i.test(type)) continue;       // open-market BUY only
        const title = String(r.typeOfOwner ?? r.reportingTitle ?? "");
        if (!OFFICER_RE.test(title)) continue;                        // officers/directors only
        const shares = num(r.securitiesTransacted ?? r.shares) ?? 0;
        const price = num(r.price) ?? 0;
        const value = shares * price;
        if (value < MIN_VALUE) continue;
        buys.push({
          ticker: String(r.symbol ?? "").toUpperCase(),
          insider: r.reportingName ?? r.name ?? "",
          title, type, shares, price, value,
          date: (r.transactionDate ?? r.date ?? "").slice(0, 10),
        });
      }
      return buys.filter((b) => b.ticker).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    },
    [],
  );
}

/** For scoring: recent insider buy stats for one ticker. */
export async function getInsiderFor(ticker: string): Promise<SwrResult<{ count: number; totalValue: number }>> {
  const t = ticker.toUpperCase();
  const { value, dataStale } = await getRecentInsiderBuys();
  const hits = value.filter((b) => b.ticker === t);
  return { value: { count: hits.length, totalValue: hits.reduce((a, b) => a + b.value, 0) }, dataStale };
}
