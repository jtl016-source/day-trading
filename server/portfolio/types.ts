// ── Portfolio module shared types ────────────────────────────────────────────
// Fully isolated from the futures engine. Nothing here imports from the trading
// signal / candle / auto-trader code paths.

export interface Fundamentals {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  // quality
  roe: number | null;
  roic: number | null;
  grossMargin: number | null;
  grossMarginStability: number | null; // 1 - coefficient of variation of 5y gross margin
  debtToEquity: number | null;
  interestCoverage: number | null;
  fcfPositiveYears: number; // count of last 5y with positive FCF
  earningsVariability: number | null; // std dev of YoY EPS growth (lower = steadier)
  // valuation
  pe: number | null;
  evToEbitda: number | null;
  pToFcf: number | null;
  pToBook: number | null;
  fcfYield: number | null;
  // growth
  revenueCagr5y: number | null;
  epsCagr5y: number | null;
  // momentum / regime
  return12m1m: number | null; // trailing 12-month return excluding the most recent month
  above200dma: boolean | null;
  volatility252d: number | null; // annualized std dev of daily returns
  dataStale: boolean;
}

export interface CongressTrade {
  politician: string;
  party: string;        // "Democrat" | "Republican" | "Independent" | ""
  chamber: "senate" | "house";
  ticker: string;
  type: "buy" | "sell";
  amountRange: string;  // e.g. "$15,001 - $50,000"
  amountMid: number;    // midpoint of the range for ranking
  transactionDate: string; // ISO date
  disclosureDate: string;  // ISO date
  lagDays: number;
}

export interface CongressLeader {
  politician: string;
  party: string;
  chamber: "senate" | "house";
  buys: number;
  sells: number;
  topTickers: { ticker: string; count: number }[];
  convictionTickers: string[]; // bought same ticker ≥2x in 90d
  estNotional: number;         // sum of amount midpoints (buys)
}

export interface FundHolding {
  ticker: string;
  name: string;
  shares: number;
  marketValue: number;
  weight: number;      // % of portfolio
  change: "new" | "add" | "trim" | "exit" | "hold";
  changePct: number | null; // QoQ share change %
}

export interface SuperinvestorFund {
  cik: string;
  manager: string;
  fund: string;
  portfolioValue: number;
  asOf: string;          // report date
  topHoldings: FundHolding[];
  newBuys: FundHolding[];
  exits: FundHolding[];
  dataStale: boolean;
}

export interface ConsensusRow {
  ticker: string;
  holders: number;       // # tracked funds holding it
  adders: number;        // # that ADDED last quarter
  funds: string[];       // manager names
}

export interface InsiderBuy {
  ticker: string;
  insider: string;
  title: string;
  type: string;          // "P-Purchase"
  shares: number;
  price: number;
  value: number;
  date: string;
}

export interface Quote {
  ticker: string;
  price: number;
  changesPercentage: number;
  marketCap: number | null;
  name: string;
}

// ── Confluence score ─────────────────────────────────────────────────────────
export type Pillar = "quality" | "value" | "momentum" | "smartMoney" | "congressInsider";

export interface ScoreBreakdown {
  ticker: string;
  total: number;            // 0–100
  grade: "A" | "B" | "C" | "D" | "F";
  pillars: Record<Pillar, { score: number; max: number; metrics: Record<string, number | string | null> }>;
  flags: string[];
  dataStale: boolean;
  asOf: number;             // unix ms
}

// ── Persistence ──────────────────────────────────────────────────────────────
export interface Holding {
  ticker: string;
  shares: number;
  costBasis: number;        // per-share avg cost
  isCore?: boolean;         // core index ETF vs satellite pick
  note?: string;
}

export interface PortfolioStore {
  watchlist: string[];
  holdings: Holding[];
  followedPoliticians: string[];
  coreTargetPct: number;    // default 70
  coreEtf: string;          // default "VTI"
}
