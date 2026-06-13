// ── Portfolio persistence (JSON) ─────────────────────────────────────────────
// Isolated from the futures sqlite schema — a single JSON file under /data so the
// trading DB is never touched. Synchronous read/write is fine for this tiny file.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { PortfolioStore, Holding } from "./types";

const FILE = join(process.cwd(), "data", "portfolio.json");

const DEFAULTS: PortfolioStore = {
  watchlist: [],
  holdings: [],
  followedPoliticians: [],
  coreTargetPct: 70,
  coreEtf: "VTI",
};

let cache: PortfolioStore | null = null;

function load(): PortfolioStore {
  if (cache) return cache;
  try {
    if (existsSync(FILE)) {
      cache = { ...DEFAULTS, ...JSON.parse(readFileSync(FILE, "utf8")) };
    } else cache = { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

function persist(): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("[portfolio/store] failed to persist:", (e as Error).message);
  }
}

export const store = {
  get: (): PortfolioStore => ({ ...load() }),

  // ── watchlist ──
  getWatchlist: (): string[] => [...load().watchlist],
  addWatch: (ticker: string): string[] => {
    const s = load(); const t = ticker.toUpperCase().trim();
    if (t && !s.watchlist.includes(t)) { s.watchlist.push(t); persist(); }
    return [...s.watchlist];
  },
  removeWatch: (ticker: string): string[] => {
    const s = load(); s.watchlist = s.watchlist.filter((w) => w !== ticker.toUpperCase().trim());
    persist(); return [...s.watchlist];
  },

  // ── holdings ──
  getHoldings: (): Holding[] => [...load().holdings],
  upsertHolding: (h: Holding): Holding[] => {
    const s = load(); const t = h.ticker.toUpperCase().trim();
    const next: Holding = { ...h, ticker: t };
    const i = s.holdings.findIndex((x) => x.ticker === t);
    if (i >= 0) s.holdings[i] = next; else s.holdings.push(next);
    persist(); return [...s.holdings];
  },
  removeHolding: (ticker: string): Holding[] => {
    const s = load(); s.holdings = s.holdings.filter((x) => x.ticker !== ticker.toUpperCase().trim());
    persist(); return [...s.holdings];
  },

  // ── settings ──
  setCoreTarget: (pct: number, etf?: string): PortfolioStore => {
    const s = load(); s.coreTargetPct = Math.max(0, Math.min(100, pct)); if (etf) s.coreEtf = etf.toUpperCase();
    persist(); return { ...s };
  },

  // ── followed politicians ──
  toggleFollow: (politician: string): string[] => {
    const s = load(); const p = politician.trim();
    s.followedPoliticians = s.followedPoliticians.includes(p)
      ? s.followedPoliticians.filter((x) => x !== p) : [...s.followedPoliticians, p];
    persist(); return [...s.followedPoliticians];
  },

  /** All tickers referenced anywhere (for batch quote fetches). */
  allTickers: (): string[] => {
    const s = load();
    return [...new Set([...s.watchlist, ...s.holdings.map((h) => h.ticker)])];
  },
};
