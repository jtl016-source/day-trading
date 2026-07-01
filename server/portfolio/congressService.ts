// ── congressService — senate + house disclosures (TTL 1h, rolling 90 days) ────
import { fmpGet, arr } from "./fmpClient";
import { swr, type SwrResult } from "./cache";
import type { CongressTrade, CongressLeader } from "./types";

const TTL = 60 * 60 * 1000; // 1h
const WINDOW_DAYS = 90;

function amountMidpoint(range: string): number {
  const nums = String(range ?? "").replace(/[$,]/g, "").match(/\d+(\.\d+)?/g);
  if (!nums?.length) return 0;
  const lo = parseFloat(nums[0]);
  const hi = nums[1] ? parseFloat(nums[1]) : lo;
  return (lo + hi) / 2;
}

function daysBetween(a: string, b: string): number {
  const t1 = Date.parse(a), t2 = Date.parse(b);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
  return Math.max(0, Math.round((t2 - t1) / 86_400_000));
}

function normalize(row: any, chamber: "senate" | "house"): CongressTrade | null {
  const ticker = String(row.symbol ?? row.ticker ?? "").toUpperCase().trim();
  if (!ticker) return null;
  const rawType = String(row.type ?? row.transactionType ?? "").toLowerCase();
  const type: "buy" | "sell" = rawType.includes("purchase") || rawType.includes("buy") ? "buy" : "sell";
  const first = row.firstName ?? "";
  const last = row.lastName ?? "";
  const politician = (row.representative ?? row.senator ?? `${first} ${last}`).toString().trim() || row.office || "Unknown";
  const transactionDate = (row.transactionDate ?? row.date ?? "").slice(0, 10);
  const disclosureDate = (row.disclosureDate ?? row.dateRecieved ?? row.dateReceived ?? transactionDate).slice(0, 10);
  const amountRange = row.amount ?? row.amountRange ?? "";
  return {
    politician, party: row.party ?? "", chamber, ticker, type,
    amountRange, amountMid: amountMidpoint(amountRange),
    transactionDate, disclosureDate, lagDays: daysBetween(transactionDate, disclosureDate),
  };
}

async function fetchChamber(chamber: "senate" | "house"): Promise<CongressTrade[]> {
  // Newer "stable" latest endpoints; fall back to the v4 RSS feeds.
  const path = chamber === "senate" ? "/senate-latest" : "/house-latest";
  let rows: any[] = [];
  try {
    rows = arr<any>(await fmpGet<any[]>(path, { page: 0 }, { base: "stable" }));
  } catch {
    const feed = chamber === "senate" ? "/senate-trading-rss-feed" : "/house-disclosure-rss-feed";
    rows = arr<any>(await fmpGet<any[]>(feed, { page: 0 }, { base: "v4" }));
  }
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  return rows
    .map((r) => normalize(r, chamber))
    .filter((t): t is CongressTrade => !!t && Date.parse(t.transactionDate) >= cutoff);
}

export async function getRecentCongress(): Promise<SwrResult<CongressTrade[]>> {
  return swr<CongressTrade[]>(
    "congress:recent",
    TTL,
    async () => {
      const [s, h] = await Promise.all([fetchChamber("senate"), fetchChamber("house")]);
      return [...s, ...h].sort((a, b) => Date.parse(b.disclosureDate) - Date.parse(a.disclosureDate));
    },
    [],
  );
}

/** Per-politician aggregation over the 90-day window (conviction = same ticker bought ≥2x). */
export async function getCongressLeaders(): Promise<SwrResult<CongressLeader[]>> {
  const { value: trades, dataStale } = await getRecentCongress();
  const byPol = new Map<string, CongressLeader & { _buyByTicker: Map<string, number> }>();
  for (const t of trades) {
    let p = byPol.get(t.politician);
    if (!p) {
      p = { politician: t.politician, party: t.party, chamber: t.chamber, buys: 0, sells: 0,
            topTickers: [], convictionTickers: [], estNotional: 0, _buyByTicker: new Map() };
      byPol.set(t.politician, p);
    }
    if (t.party && !p.party) p.party = t.party;
    if (t.type === "buy") {
      p.buys++; p.estNotional += t.amountMid;
      p._buyByTicker.set(t.ticker, (p._buyByTicker.get(t.ticker) ?? 0) + 1);
    } else p.sells++;
  }
  const leaders = [...byPol.values()].map((p) => {
    const tickers = [...p._buyByTicker.entries()].sort((a, b) => b[1] - a[1]);
    p.topTickers = tickers.slice(0, 5).map(([ticker, count]) => ({ ticker, count }));
    p.convictionTickers = tickers.filter(([, c]) => c >= 2).map(([t]) => t);
    const { _buyByTicker, ...rest } = p;
    return rest as CongressLeader;
  }).sort((a, b) => (b.buys - b.sells) - (a.buys - a.sells) || b.estNotional - a.estNotional);
  return { value: leaders, dataStale };
}
