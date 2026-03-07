import type { Express } from "express";
import { createServer, type Server } from "http";
import YahooFinance from "yahoo-finance2";
import { db } from "./db";
import { cachedCandles, downloadStatus } from "@shared/schema";
import { eq, and, sql, gte, lte, asc } from "drizzle-orm";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const MARKETDATA_BASE = "https://api.marketdata.app/v1";
const LIVE_DATA_KEY = process.env.LIVE_DATA;

async function mdFetch(path: string): Promise<any> {
  if (!LIVE_DATA_KEY) return null;
  const resp = await fetch(`${MARKETDATA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${LIVE_DATA_KEY}` },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function fetchMarketDataQuote(symbol: string): Promise<any | null> {
  const data = await mdFetch(`/stocks/quotes/${symbol}/?52week=true`);
  if (!data || data.s !== "ok") return null;
  const i = 0;
  return {
    symbol,
    regularMarketPrice: data.last?.[i],
    regularMarketChange: data.change?.[i],
    regularMarketChangePercent: data.changepct?.[i] != null ? data.changepct[i] * 100 : undefined,
    regularMarketVolume: data.volume?.[i],
    regularMarketDayHigh: data.high?.[i] ?? undefined,
    regularMarketDayLow: data.low?.[i] ?? undefined,
    regularMarketOpen: data.open?.[i] ?? undefined,
    regularMarketPreviousClose: data.prevClose?.[i] ?? undefined,
    bid: data.bid?.[i],
    ask: data.ask?.[i],
    bidSize: data.bidSize?.[i],
    askSize: data.askSize?.[i],
    fiftyTwoWeekHigh: data["52weekHigh"]?.[i],
    fiftyTwoWeekLow: data["52weekLow"]?.[i],
    regularMarketTime: data.updated?.[i] ? new Date(data.updated[i] * 1000).toISOString() : undefined,
    fullExchangeName: "MarketData.app",
    shortName: symbol,
    marketState: "REGULAR",
  };
}

async function fetchMarketDataCandles(symbol: string, resolution: string, from: Date, to: Date): Promise<any[]> {
  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);
  const data = await mdFetch(`/stocks/candles/${resolution}/${symbol}/?from=${fromTs}&to=${toTs}`);
  if (!data || data.s !== "ok" || !data.t) return [];
  const candles: any[] = [];
  for (let i = 0; i < data.t.length; i++) {
    if (data.o[i] == null || data.c[i] == null) continue;
    candles.push({
      time: data.t[i],
      open: data.o[i],
      high: data.h[i],
      low: data.l[i],
      close: data.c[i],
      volume: data.v?.[i] ?? 0,
      rth: isRTH(data.t[i]),
    });
  }
  return candles;
}

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
      if (LIVE_DATA_KEY && !symbol.endsWith("=F") && !symbol.startsWith("^")) {
        const mdQuote = await fetchMarketDataQuote(symbol);
        if (mdQuote) {
          res.json(mdQuote);
          return;
        }
      }
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
      const isFutures = symbol.endsWith("=F");
      const isIndex = symbol.startsWith("^");

      if (LIVE_DATA_KEY && !isFutures && !isIndex) {
        start.setHours(0, 0, 0, 0);
        const mdResolution = iv === "60m" ? "H" : "15";
        const mdCandles = await fetchMarketDataCandles(symbol, mdResolution, start, now);
        if (mdCandles.length > 0) {
          const mdQuote = await fetchMarketDataQuote(symbol);
          res.json({
            symbol,
            interval: iv,
            meta: {
              regularMarketPrice: mdQuote?.regularMarketPrice,
              previousClose: mdQuote?.regularMarketPreviousClose,
              currency: "USD",
              exchangeName: "MarketData.app",
            },
            candles: mdCandles,
          });
          return;
        }
      }

      if (isFutures) {
        start.setDate(start.getDate() - 1);
        start.setHours(17, 0, 0, 0);
      } else {
        start.setHours(0, 0, 0, 0);
      }

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

  const POLYGON_KEY = process.env.MASSIVE_API_CODE;
  const POLYGON_BASE = "https://api.polygon.io";

  app.get("/api/data/status/:symbol", async (req, res) => {
    const { symbol } = req.params;
    try {
      const rows = await db.select().from(downloadStatus).where(eq(downloadStatus.symbol, symbol.toUpperCase()));
      const totalBars = await db.select({ count: sql<number>`SUM(bar_count)` }).from(downloadStatus)
        .where(and(eq(downloadStatus.symbol, symbol.toUpperCase()), eq(downloadStatus.status, "done")));
      const totalDays = await db.select({ count: sql<number>`COUNT(DISTINCT DATE(to_timestamp(timestamp)))` })
        .from(cachedCandles)
        .where(and(eq(cachedCandles.symbol, symbol.toUpperCase()), eq(cachedCandles.resolution, "5")));
      res.json({
        symbol: symbol.toUpperCase(),
        months: rows,
        totalBars: Number(totalBars[0]?.count ?? 0),
        totalDays: Number(totalDays[0]?.count ?? 0),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data/verify-key", async (_req, res) => {
    if (!POLYGON_KEY) {
      res.json({ valid: false, message: "No API key configured" });
      return;
    }
    try {
      const resp = await fetch(`${POLYGON_BASE}/v2/aggs/ticker/AAPL/range/1/day/2024-01-02/2024-01-03?apiKey=${POLYGON_KEY}`);
      if (resp.ok) {
        res.json({ valid: true, message: "Polygon.io API key verified" });
      } else {
        res.json({ valid: false, message: `API returned ${resp.status}` });
      }
    } catch (err: any) {
      res.json({ valid: false, message: err.message });
    }
  });

  app.post("/api/data/download", async (req, res) => {
    const { symbol, year, month, resolution } = req.body;
    if (!POLYGON_KEY) {
      res.status(400).json({ error: "No Polygon.io API key configured" });
      return;
    }
    if (!symbol || year == null || month == null) {
      res.status(400).json({ error: "symbol, year, month required" });
      return;
    }

    const sym = symbol.toUpperCase();
    const resolutions = resolution ? [resolution] : ["5", "60"];
    const monthStr = String(month).padStart(2, "0");
    const startDate = `${year}-${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${monthStr}-${String(lastDay).padStart(2, "0")}`;

    try {
      await db.insert(downloadStatus).values({
        symbol: sym, year, month, status: "downloading", barCount: 0,
      }).onConflictDoUpdate({
        target: [downloadStatus.symbol, downloadStatus.year, downloadStatus.month],
        set: { status: "downloading", barCount: 0, updatedAt: new Date() },
      });

      let totalInserted = 0;

      for (const res of resolutions) {
        const multiplier = res === "5" ? 5 : 60;
        const timespan = "minute";

        let allResults: any[] = [];
        let nextUrl: string | null = `${POLYGON_BASE}/v2/aggs/ticker/${sym}/range/${multiplier}/${timespan}/${startDate}/${endDate}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;

        while (nextUrl) {
          const resp = await fetch(nextUrl);
          if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Polygon API error ${resp.status}: ${text}`);
          }
          const data = await resp.json();
          if (data.results && data.results.length > 0) {
            allResults = allResults.concat(data.results);
          }
          nextUrl = data.next_url ? `${data.next_url}&apiKey=${POLYGON_KEY}` : null;
        }

        if (allResults.length > 0) {
          const batchSize = 500;
          for (let i = 0; i < allResults.length; i += batchSize) {
            const batch = allResults.slice(i, i + batchSize);
            const values = batch.map((r: any) => ({
              symbol: sym,
              resolution: res,
              timestamp: Math.floor(r.t / 1000),
              open: r.o,
              high: r.h,
              low: r.l,
              close: r.c,
              volume: Math.round(r.v || 0),
            }));
            await db.insert(cachedCandles).values(values).onConflictDoNothing();
          }
          totalInserted += allResults.length;
        }
      }

      await db.insert(downloadStatus).values({
        symbol: sym, year, month, status: "done", barCount: totalInserted,
      }).onConflictDoUpdate({
        target: [downloadStatus.symbol, downloadStatus.year, downloadStatus.month],
        set: { status: "done", barCount: totalInserted, updatedAt: new Date() },
      });

      res.json({ success: true, symbol: sym, year, month, bars: totalInserted });
    } catch (err: any) {
      await db.insert(downloadStatus).values({
        symbol: sym, year, month, status: "error", barCount: 0,
      }).onConflictDoUpdate({
        target: [downloadStatus.symbol, downloadStatus.year, downloadStatus.month],
        set: { status: "error", barCount: 0, updatedAt: new Date() },
      });
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data/candles/:symbol/:resolution", async (req, res) => {
    const { symbol, resolution } = req.params;
    const { from, to } = req.query;
    try {
      let query = db.select().from(cachedCandles)
        .where(and(
          eq(cachedCandles.symbol, symbol.toUpperCase()),
          eq(cachedCandles.resolution, resolution),
          ...(from ? [gte(cachedCandles.timestamp, Number(from))] : []),
          ...(to ? [lte(cachedCandles.timestamp, Number(to))] : []),
        ))
        .orderBy(asc(cachedCandles.timestamp));

      const rows = await query;
      const candles = rows.map(r => ({
        time: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        rth: isRTH(r.timestamp),
      }));
      res.json({ symbol: symbol.toUpperCase(), resolution, candles });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data/daily-summary/:symbol", async (req, res) => {
    const { symbol } = req.params;
    try {
      const rows = await db.execute(sql`
        SELECT
          DATE(to_timestamp(timestamp)) as date,
          COUNT(*) as bars,
          MIN(open) as day_open,
          MAX(high) as high,
          MIN(low) as low,
          (array_agg(close ORDER BY timestamp DESC))[1] as close,
          (array_agg(open ORDER BY timestamp ASC))[1] as open,
          SUM(volume) as volume
        FROM cached_candles
        WHERE symbol = ${symbol.toUpperCase()} AND resolution = '5'
        GROUP BY DATE(to_timestamp(timestamp))
        ORDER BY date DESC
        LIMIT 2000
      `);
      res.json({ symbol: symbol.toUpperCase(), days: rows.rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data/cached-continuous/:symbol/:interval", async (req, res) => {
    const { symbol, interval } = req.params;
    const sym = symbol.toUpperCase();
    const resolution = interval === "60m" ? "60" : "5";
    const { from, to } = req.query;
    try {
      const conditions = [
        eq(cachedCandles.symbol, sym),
        eq(cachedCandles.resolution, resolution),
      ];
      if (from) conditions.push(gte(cachedCandles.timestamp, Number(from)));
      if (to) conditions.push(lte(cachedCandles.timestamp, Number(to)));

      const rows = await db.select().from(cachedCandles)
        .where(and(...conditions))
        .orderBy(asc(cachedCandles.timestamp));

      if (rows.length === 0) {
        res.json({ symbol: sym, interval, candles: [], source: "none" });
        return;
      }

      const candles = rows.map(r => ({
        time: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        rth: isRTH(r.timestamp),
      }));

      res.json({ symbol: sym, interval, candles, source: "cached" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data/cached-days/:symbol", async (req, res) => {
    const { symbol } = req.params;
    const sym = symbol.toUpperCase();
    try {
      const result = await db.execute(sql`
        SELECT
          DATE(to_timestamp(timestamp)) as date,
          (array_agg(open ORDER BY timestamp ASC))[1]::float as open,
          MAX(high)::float as high,
          MIN(low)::float as low,
          (array_agg(close ORDER BY timestamp DESC))[1]::float as close,
          SUM(volume)::bigint as volume
        FROM cached_candles
        WHERE symbol = ${sym} AND resolution = '60'
        GROUP BY DATE(to_timestamp(timestamp))
        ORDER BY date DESC
      `);

      const days = (result.rows as any[]).map(r => ({
        date: typeof r.date === 'string' ? r.date.split('T')[0] : new Date(r.date).toISOString().split('T')[0],
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      }));

      res.json({ symbol: sym, days });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/data/clear/:symbol", async (req, res) => {
    const { symbol } = req.params;
    try {
      await db.delete(cachedCandles).where(eq(cachedCandles.symbol, symbol.toUpperCase()));
      await db.delete(downloadStatus).where(eq(downloadStatus.symbol, symbol.toUpperCase()));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return httpServer;
}
