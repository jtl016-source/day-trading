// ── Portfolio REST routes — mounted under /api/portfolio/* ────────────────────
// Isolated module: imports nothing from the futures engine. Every handler is
// wrapped so a provider failure degrades to cached/empty + dataStale, never a 500.
import type { Express, Request, Response } from "express";
import { store } from "./store";
import { getQuotes } from "./quoteService";
import { getFundamentals } from "./fundamentalsService";
import { getRecentCongress, getCongressLeaders } from "./congressService";
import { getFundsSummary, getFund, getConsensus } from "./smartMoneyService";
import { getRecentInsiderBuys } from "./insiderService";
import { scoreStock, PORTFOLIO_WEIGHTS } from "./scoring";
import { fmpBudget, hasApiKey } from "./fmpClient";

const safe = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
  try { await fn(req, res); }
  catch (e) { res.json({ error: (e as Error).message, dataStale: true, data: null }); }
};

export function registerPortfolioRoutes(app: Express): void {
  // Health / budget (and a clear hint if the key is missing).
  app.get("/api/portfolio/health", (_req, res) => {
    res.json({ ok: true, hasApiKey: hasApiKey(), budget: fmpBudget(), weights: PORTFOLIO_WEIGHTS });
  });

  // ── Congress ──
  app.get("/api/portfolio/congress/recent", safe(async (_req, res) => {
    const followed = store.get().followedPoliticians;
    const { value, dataStale } = await getRecentCongress();
    res.json({ trades: value, followed, dataStale, asOf: Date.now() });
  }));
  app.get("/api/portfolio/congress/leaders", safe(async (_req, res) => {
    const { value, dataStale } = await getCongressLeaders();
    res.json({ leaders: value, dataStale, asOf: Date.now() });
  }));
  app.post("/api/portfolio/congress/follow", safe(async (req, res) => {
    const followed = store.toggleFollow(String(req.body?.politician ?? ""));
    res.json({ followed });
  }));

  // ── Smart money ──
  app.get("/api/portfolio/smartmoney/funds", safe(async (_req, res) => {
    const { value, dataStale } = await getFundsSummary();
    res.json({ funds: value, dataStale, asOf: Date.now() });
  }));
  app.get("/api/portfolio/smartmoney/fund/:cik", safe(async (req, res) => {
    const { value, dataStale } = await getFund(String(req.params.cik));
    res.json({ fund: value, dataStale, asOf: Date.now() });
  }));
  app.get("/api/portfolio/smartmoney/consensus", safe(async (_req, res) => {
    const { value, dataStale } = await getConsensus();
    res.json({ consensus: value, dataStale, asOf: Date.now() });
  }));

  // ── Insider ──
  app.get("/api/portfolio/insider/recent", safe(async (_req, res) => {
    const { value, dataStale } = await getRecentInsiderBuys();
    res.json({ buys: value, dataStale, asOf: Date.now() });
  }));

  // ── Score (single ticker, full breakdown) ──
  app.get("/api/portfolio/score/:ticker", safe(async (req, res) => {
    const breakdown = await scoreStock(String(req.params.ticker));
    res.json(breakdown);
  }));

  // ── Screener — score the tracked universe, sort, filter by pillar minimums ──
  app.get("/api/portfolio/screener", safe(async (req, res) => {
    const q = req.query as Record<string, string>;
    const universe = q.universe === "watchlist" ? store.getWatchlist()
      : q.universe === "holdings" ? store.getHoldings().map((h) => h.ticker)
      : store.allTickers();
    const rows = await Promise.all(universe.map((t) => scoreStock(t).catch(() => null)));
    const minOf = (k: string) => (q[k] ? parseFloat(q[k]) : -Infinity);
    let scored = rows.filter((r): r is NonNullable<typeof r> => !!r);
    scored = scored.filter((r) =>
      r.total >= minOf("minTotal") &&
      r.pillars.quality.score >= minOf("minQuality") &&
      r.pillars.value.score >= minOf("minValue") &&
      r.pillars.momentum.score >= minOf("minMomentum") &&
      r.pillars.smartMoney.score >= minOf("minSmartMoney") &&
      r.pillars.congressInsider.score >= minOf("minCongress"));
    scored.sort((a, b) => b.total - a.total);
    res.json({ rows: scored, dataStale: scored.some((r) => r.dataStale), asOf: Date.now() });
  }));

  // ── Watchlist ──
  app.get("/api/portfolio/watchlist", safe(async (_req, res) => { res.json({ watchlist: store.getWatchlist() }); }));
  app.post("/api/portfolio/watchlist", safe(async (req, res) => { res.json({ watchlist: store.addWatch(String(req.body?.ticker ?? "")) }); }));
  app.delete("/api/portfolio/watchlist", safe(async (req, res) => {
    const t = String(req.query.ticker ?? req.body?.ticker ?? "");
    res.json({ watchlist: store.removeWatch(t) });
  }));

  // ── Holdings (+ live values via batch quote) ──
  app.get("/api/portfolio/holdings", safe(async (_req, res) => {
    const holdings = store.getHoldings();
    const s = store.get();
    const { value: quotes, dataStale } = await getQuotes(holdings.map((h) => h.ticker));
    const enriched = holdings.map((h) => {
      const px = quotes[h.ticker]?.price ?? 0;
      const value = px * h.shares;
      const cost = h.costBasis * h.shares;
      return { ...h, price: px, value, cost, pl: value - cost, plPct: cost > 0 ? (value - cost) / cost * 100 : 0 };
    });
    const totalValue = enriched.reduce((a, h) => a + h.value, 0);
    const withWeight = enriched.map((h) => ({ ...h, weight: totalValue > 0 ? h.value / totalValue * 100 : 0 }));
    const coreValue = withWeight.filter((h) => h.isCore).reduce((a, h) => a + h.value, 0);
    res.json({
      holdings: withWeight, totalValue,
      corePct: totalValue > 0 ? coreValue / totalValue * 100 : 0,
      coreTargetPct: s.coreTargetPct, coreEtf: s.coreEtf,
      dataStale, asOf: Date.now(),
    });
  }));
  app.post("/api/portfolio/holdings", safe(async (req, res) => {
    const b = req.body ?? {};
    if (b.action === "delete") return void res.json({ holdings: store.removeHolding(String(b.ticker ?? "")) });
    if (b.action === "coreTarget") return void res.json({ store: store.setCoreTarget(Number(b.pct), b.etf) });
    res.json({ holdings: store.upsertHolding({
      ticker: String(b.ticker ?? ""), shares: Number(b.shares) || 0, costBasis: Number(b.costBasis) || 0,
      isCore: !!b.isCore, note: b.note ? String(b.note) : undefined,
    }) });
  }));

  console.log("[portfolio] routes mounted under /api/portfolio/*");
}
