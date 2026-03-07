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

/**
 * Determine if a UTC timestamp is within Regular Trading Hours (RTH) for US markets.
 * RTH: 9:30 AM – 4:00 PM ET
 * ET = UTC-5 (EST) or UTC-4 (EDT). We approximate by checking UTC 13:30–21:00 (EST offset).
 */
function isRTH(timestampSec: number): boolean {
  const d = new Date(timestampSec * 1000);
  const dayOfWeek = d.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const utcMins = utcHour * 60 + utcMin;

  // Approximate both EDT (UTC-4: open=13:30, close=20:00) and EST (UTC-5: open=14:30, close=21:00)
  // Use 13:30 UTC (EDT open) to 21:00 UTC (EST close) to be inclusive
  const openUTC = 13 * 60 + 30; // 13:30 UTC = 9:30 AM EDT
  const closeUTC = 21 * 60;     // 21:00 UTC = 4:00 PM EST
  return utcMins >= openUTC && utcMins < closeUTC;
}

function mapQuotes(quotes: any[]): any[] {
  return quotes
    .filter((q: any) => q.open != null && q.close != null && q.high != null && q.low != null)
    .map((q: any) => {
      const timeSec = Math.floor(new Date(q.date).getTime() / 1000);
      return {
        time: timeSec,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume ?? 0,
        rth: isRTH(timeSec),
      };
    });
}

/** Fetch a single chart chunk from Yahoo Finance */
async function fetchChunk(symbol: string, period1: Date, period2: Date, interval: string): Promise<any[]> {
  try {
    const result = await yahooFinance.chart(symbol, {
      period1,
      period2,
      interval: interval as any,
    });
    return mapQuotes(result.quotes || []);
  } catch {
    return [];
  }
}

/** Fetch all available intraday data, respecting Yahoo Finance limits */
async function fetchContinuousHistory(symbol: string, interval: string): Promise<any[]> {
  const now = new Date();

  if (interval === "60m") {
    // 60m supports up to 730 days — fetch full 200-day range in one request
    const period1 = new Date(now);
    period1.setDate(period1.getDate() - 200);
    return fetchChunk(symbol, period1, now, "60m");
  }

  // 15m: Yahoo Finance only supports the most recent 60 days
  // We cannot go further back without a third-party data provider
  const period1 = new Date(now);
  period1.setDate(period1.getDate() - 59);
  return fetchChunk(symbol, period1, now, "15m");
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

  /** Today's intraday data with full ETH+RTH */
  app.get("/api/market/intraday/:symbol/:interval", async (req, res) => {
    const { symbol, interval } = req.params;
    const iv = interval === "60m" ? "60m" : "15m";
    try {
      const now = new Date();
      const start = new Date();
      start.setHours(0, 0, 0, 0);

      const result = await yahooFinance.chart(symbol, {
        period1: start,
        period2: now,
        interval: iv as any,
      });

      const candles = mapQuotes(result.quotes || []);

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

  /** Daily summary for past 200 trading days (for the timeline scrubber) */
  app.get("/api/market/historical-days/:symbol", async (req, res) => {
    const { symbol } = req.params;
    try {
      const now = new Date();
      const period1 = new Date(now);
      period1.setDate(period1.getDate() - 280);

      const result = await yahooFinance.chart(symbol, {
        period1,
        period2: now,
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

  /** Continuous 200-day intraday history — all ETH+RTH, no gaps between days */
  app.get("/api/market/historical-continuous/:symbol/:interval", async (req, res) => {
    const { symbol, interval } = req.params;
    const iv = interval === "60m" ? "60m" : "15m";
    try {
      const candles = await fetchContinuousHistory(symbol, iv);
      res.json({ symbol, interval: iv, candles });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return httpServer;
}
