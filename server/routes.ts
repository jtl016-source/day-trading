import type { Express } from "express";
import { createServer, type Server } from "http";
import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const POPULAR_SYMBOLS = {
  stocks: [
    { symbol: "AAPL", name: "Apple Inc." },
    { symbol: "MSFT", name: "Microsoft Corp." },
    { symbol: "GOOGL", name: "Alphabet Inc." },
    { symbol: "AMZN", name: "Amazon.com Inc." },
    { symbol: "TSLA", name: "Tesla Inc." },
    { symbol: "NVDA", name: "NVIDIA Corp." },
    { symbol: "META", name: "Meta Platforms" },
    { symbol: "NFLX", name: "Netflix Inc." },
    { symbol: "JPM", name: "JPMorgan Chase" },
    { symbol: "BAC", name: "Bank of America" },
  ],
  etfs: [
    { symbol: "SPY", name: "SPDR S&P 500 ETF" },
    { symbol: "QQQ", name: "Invesco QQQ Trust" },
    { symbol: "DIA", name: "SPDR Dow Jones ETF" },
    { symbol: "IWM", name: "iShares Russell 2000" },
    { symbol: "GLD", name: "SPDR Gold Shares" },
    { symbol: "TLT", name: "iShares 20+ Yr Treasury" },
    { symbol: "XLF", name: "Financial Select SPDR" },
    { symbol: "XLE", name: "Energy Select SPDR" },
  ],
  futures: [
    { symbol: "ES=F", name: "S&P 500 Futures" },
    { symbol: "NQ=F", name: "NASDAQ 100 Futures" },
    { symbol: "YM=F", name: "Dow Jones Futures" },
    { symbol: "CL=F", name: "Crude Oil Futures" },
    { symbol: "GC=F", name: "Gold Futures" },
    { symbol: "SI=F", name: "Silver Futures" },
    { symbol: "NG=F", name: "Natural Gas Futures" },
  ],
  indices: [
    { symbol: "^GSPC", name: "S&P 500 Index" },
    { symbol: "^IXIC", name: "NASDAQ Composite" },
    { symbol: "^DJI", name: "Dow Jones Industrial" },
    { symbol: "^VIX", name: "CBOE Volatility Index" },
    { symbol: "^RUT", name: "Russell 2000 Index" },
  ],
};

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayEnd(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/market/symbols", (_req, res) => {
    res.json(POPULAR_SYMBOLS);
  });

  app.get("/api/market/quote/:symbol", async (req, res) => {
    const { symbol } = req.params;
    try {
      const quote = await yahooFinance.quote(symbol);
      res.json(quote);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/market/intraday/:symbol/:interval", async (req, res) => {
    const { symbol, interval } = req.params;
    const iv = interval === "60m" ? "60m" : "15m";
    try {
      const result = await yahooFinance.chart(symbol, {
        period1: todayStart(),
        period2: todayEnd(),
        interval: iv as any,
      });
      const candles = (result.quotes || [])
        .filter((q: any) => q.open != null && q.close != null && q.high != null && q.low != null)
        .map((q: any) => ({
          time: Math.floor(new Date(q.date).getTime() / 1000),
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume,
        }));
      res.json({
        symbol,
        interval: iv,
        meta: {
          regularMarketPrice: result.meta?.regularMarketPrice,
          previousClose: result.meta?.previousClose ?? result.meta?.chartPreviousClose,
          currency: result.meta?.currency,
          exchangeName: result.meta?.exchangeName,
        },
        candles,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/market/historical-days/:symbol", async (req, res) => {
    const { symbol } = req.params;
    try {
      const result = await yahooFinance.chart(symbol, {
        period1: daysAgo(280),
        period2: new Date(),
        interval: "1d" as any,
      });
      const days = (result.quotes || [])
        .filter((q: any) => q.open != null && q.close != null)
        .map((q: any) => {
          const d = new Date(q.date);
          return {
            date: d.toISOString().split("T")[0],
            open: q.open,
            high: q.high,
            low: q.low,
            close: q.close,
            volume: q.volume,
          };
        })
        .slice(-200)
        .reverse();
      res.json({ symbol, days });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/market/day-detail/:symbol/:date/:interval", async (req, res) => {
    const { symbol, date, interval } = req.params;
    const iv = interval === "60m" ? "60m" : "15m";
    try {
      const [y, m, d] = date.split("-").map(Number);
      const start = new Date(y, m - 1, d, 0, 0, 0);
      const end = new Date(y, m - 1, d, 23, 59, 59);
      const result = await yahooFinance.chart(symbol, {
        period1: start,
        period2: end,
        interval: iv as any,
      });
      const candles = (result.quotes || [])
        .filter((q: any) => q.open != null && q.close != null && q.high != null && q.low != null)
        .map((q: any) => ({
          time: Math.floor(new Date(q.date).getTime() / 1000),
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume,
        }));
      res.json({ symbol, date, interval: iv, candles });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return httpServer;
}
