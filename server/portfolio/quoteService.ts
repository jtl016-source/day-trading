// ── quoteService — batch live quotes (TTL 1 min) ─────────────────────────────
import { fmpGet, arr, num } from "./fmpClient";
import { swr, type SwrResult } from "./cache";
import type { Quote } from "./types";

const TTL = 60_000; // 1 minute

/** Batch quotes for the given tickers (deduped, uppercased). */
export async function getQuotes(tickers: string[]): Promise<SwrResult<Record<string, Quote>>> {
  const syms = [...new Set(tickers.map((t) => t.toUpperCase().trim()).filter(Boolean))].sort();
  if (!syms.length) return { value: {}, dataStale: false };
  const key = `quotes:${syms.join(",")}`;
  return swr<Record<string, Quote>>(
    key,
    TTL,
    async () => {
      const raw = await fmpGet<any[]>(`/quote/${syms.join(",")}`);
      const out: Record<string, Quote> = {};
      for (const q of arr<any>(raw)) {
        const ticker = String(q.symbol ?? "").toUpperCase();
        if (!ticker) continue;
        out[ticker] = {
          ticker,
          price: num(q.price) ?? 0,
          changesPercentage: num(q.changesPercentage) ?? 0,
          marketCap: num(q.marketCap),
          name: q.name ?? ticker,
        };
      }
      return out;
    },
    {},
  );
}
