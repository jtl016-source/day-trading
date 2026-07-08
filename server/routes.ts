import type { Express } from "express";
import type { Server } from "http";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { cacheGet, cacheSet, cacheInvalidate, cacheFlushAll, TTL } from "./cache";
import { XMLParser } from "fast-xml-parser";
import YahooFinance from "yahoo-finance2";
import { db } from "./db";
import { cachedCandles, downloadStatus, newsArticles, appSettings, signalHistory, discordMessages, discordSignals, tradeJournal } from "@shared/schema";
import { normalizeSymbol } from "@shared/symbol";
import { eq, and, sql, gte, lte, asc, desc } from "drizzle-orm";
import { getLatestBar, getLatestBar1m, getLastTickPrice, reloadAll, getMemBars } from "./mw-reader";
import { reconnectMWStudies } from "./live-bars";
import { broadcastOrderCommand, isOrderCommandSocketOpen, getMWSyncStatus, broadcast } from "./live-bars";
import { parseMWML, parseScreenshot, parsePDF } from "./zone-parser";
import { startDiscordReader, stopDiscordReader, getDiscordReaderStatus, deepBackReadAll, reparseAllZones } from "./discord-reader";
import { tradeSettings, pushTokens, getCurrentTrade, setCurrentTrade, clearCurrentTrade } from "./trade-state";
import { parseZonesFromMessage } from "./discord-zone-parser";
import { learner } from "./discord-learner";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// Discord webhook — loaded from DB at startup so signals work before client reconnects.
// Uses the already-imported db/appSettings/eq (better-sqlite3 `.all()` is synchronous) so this
// stays a plain top-level statement — no top-level `await`, which esbuild's cjs bundle rejects.
let memDiscordWebhook = "";
try {
  const rows = db.select().from(appSettings).where(eq(appSettings.key, "discord_webhook")).all() as any[];
  if (rows[0]?.value) { memDiscordWebhook = rows[0].value; console.log("[discord] Loaded webhook from DB"); }
} catch { /* non-fatal */ }

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
    { symbol: "MES",  name: "Micro E-mini S&P 500 (Live)" },
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

// ET (America/New_York) UTC offset, memoized per UTC-day. An Intl call PER candle is the
// dominant cost when building a continuous-candle response (thousands of bars → seconds of
// CPU, which timed out mobile clients). We do one Intl lookup per calendar day, cache it, then
// derive ET hour/minute/weekday with pure arithmetic. Offsets only change twice a year, so a
// per-day granularity is exact except across the ~02:00 DST switch (irrelevant to RTH hours).
const _etTzFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
const _etOffCache = new Map<number, number>(); // utcDay → offset MINUTES (EST=-300, EDT=-240)
function etOffsetMin(timestampSec: number): number {
  const day = Math.floor(timestampSec / 86400);
  let off = _etOffCache.get(day);
  if (off === undefined) {
    const tz = _etTzFmt.formatToParts(new Date(timestampSec * 1000)).find(p => p.type === "timeZoneName")?.value;
    off = tz === "EST" ? -300 : -240;
    if (_etOffCache.size > 4000) _etOffCache.clear(); // bound memory
    _etOffCache.set(day, off);
  }
  return off;
}

/**
 * Determine if a UTC timestamp is within Regular Trading Hours (RTH): Mon–Fri 9:30 AM – 4:00 PM ET.
 * DST-correct via the memoized ET offset, ~200x cheaper than an Intl call per candle.
 */
function isRTH(timestampSec: number): boolean {
  const etSec = timestampSec + etOffsetMin(timestampSec) * 60;
  const etDow = ((Math.floor(etSec / 86400) % 7) + 4) % 7; // 0=Sun; 1970-01-01 (epoch) was a Thursday
  if (etDow === 0 || etDow === 6) return false;
  const etMin = ((Math.floor(etSec / 60) % 1440) + 1440) % 1440;
  return etMin >= 9 * 60 + 30 && etMin < 17 * 60; // 9:30 AM – 5:00 PM ET
}

// CME ES/MES is CLOSED on the weekend (Fri 5:00 PM ET → Sun 6:00 PM ET) and during the daily
// 5:00–6:00 PM ET maintenance halt. Any bar timestamped inside those windows is phantom/corrupt
// (e.g. Yahoo returns a handful of low-volume Saturday bars) and must never reach the chart — a
// single isolated closed-session bar surrounded by gaps renders as a "thin vertical line" spike.
function isMarketClosed(timestampSec: number): boolean {
  const etSec = timestampSec + etOffsetMin(timestampSec) * 60;
  const etDow = ((Math.floor(etSec / 86400) % 7) + 4) % 7; // 0=Sun … 6=Sat
  const etMin = ((Math.floor(etSec / 60) % 1440) + 1440) % 1440;
  if (etDow === 6) return true;                 // Saturday — fully closed
  if (etDow === 5) return etMin >= 17 * 60;     // Friday after 5:00 PM ET
  if (etDow === 0) return etMin < 18 * 60;      // Sunday before 6:00 PM ET
  return etMin >= 17 * 60 && etMin < 18 * 60;   // Mon–Thu daily maintenance halt
}

/**
 * Minimal bar shape the spike filters operate on. Generic so both the DB-row path
 * (mapped candles) and the in-memory MinBar path can share the same logic — the
 * only fields that matter for spike detection are OHLC + volume + time.
 */
type SpikeBar = { open: number; high: number; low: number; close: number; volume: number | null; time: number };

/**
 * Drop a bar whose price track is displaced from its neighbours — a candle that jumped
 * away and came right back. `isSpikeBar` (H-L range vs close) can't see this: a 20pt
 * displaced body on a ~7500 instrument is only ~0.27%, nowhere near the 0.5-2.5% range
 * thresholds, so it passes. A real move never fully retraces to its neighbours in one bar.
 * Compared to `dropWickSpikes` this catches a displaced whole PRICE LEVEL (not a lone wick,
 * which `dropWickSpikes` handles).
 *
 * TWO mechanisms, in order:
 *
 * (1) WINDOWED-MAJORITY CLUSTERING (primary). A naive single-pass "is my body above BOTH
 *     immediate neighbours" test fails on the DENSE INTERLEAVED-PHANTOM pattern documented
 *     on 2026-03-17: a wrong-contract feed bleeds in on alternating-ish minutes, producing
 *     two interwoven price series ~90-100pt apart (real ~6744-53, phantom ~6798-6853). With
 *     pairwise comparison the phantoms SHIELD EACH OTHER — a phantom whose immediate neighbour
 *     is also a phantom looks "consistent" and survives, and worse, once a phantom survives it
 *     can make the adjacent REAL bar look like the outlier and get it dropped instead. Pure
 *     neighbour comparison can't resolve this because it trusts a single neighbour's implicit
 *     classification. Instead, for each low-confidence candidate we take a window of nearby
 *     bars, cluster their CLOSE prices into price tracks (within `clusterTol`), and find the
 *     majority track. A bar off the dominant track whose OWN cluster is a tiny minority (a
 *     lone/near-lone print) is the phantom — regardless of what its immediate neighbour is.
 *     The dominant track is picked by TOTAL VOLUME (not count): real bars trade, phantoms are
 *     thin single prints, so several interleaved phantom RUNS (2026-03-19) still can't out-vote
 *     the real track. Bars proven ON the dominant-volume track are marked CONFIRMED so the
 *     pairwise cleanup can't later re-drop them (protects real high-volume run bars).
 *
 * (2) PAIRWISE DISPLACED-BODY (secondary cleanup, multi-pass). The original test: a body
 *     wholly above/below both surviving neighbour closes. Catches the sparse-region displaced
 *     body the windowed pass skips for lack of context, plus the 2026-07-02T11:40Z V743 case.
 *     Skips CONFIRMED bars. Runs on the survivors of pass (1); multi-pass so newly-isolated
 *     bars get re-judged.
 */
function dropIsolatedSpikes<T extends SpikeBar>(bars: T[]): T[] {
  if (bars.length < 3) return bars;

  const VOL_HARD_FLOOR = 500;   // at/above this a bar is a real move — never a low-vol phantom
  const WINDOW = 9;             // bars considered around the candidate (±4)
  const HALF = Math.floor(WINDOW / 2);

  // Two closes belong to the same price track if within this tolerance. Consecutive real
  // 1m/5m bars drift a few points; a wrong-contract phantom sits ~90-100pt away. Scale with
  // price (0.15% ≈ 10pt at 6750) but floor at 12pt so ordinary volatility never splits a
  // continuous trend into separate clusters.
  const clusterTol = (px: number) => Math.max(12, px * 0.0015);

  const isKept = new Array(bars.length).fill(true);
  // Bars the windowed pass proves are on the dominant-volume track — the pairwise cleanup must
  // not second-guess these (protects real high-volume run bars whose neighbours got thinned).
  const confirmed = new Array(bars.length).fill(false);

  // A large TIME gap means bars across it are legitimately at a different level (session
  // reopen, weekend) — don't let the far side vote on this candidate. Infer the bar interval
  // from the minimum array-adjacent dt, treat > 4x that as a boundary the window won't cross.
  let minDt = Infinity;
  for (let i = 1; i < bars.length; i++) {
    const dt = bars[i].time - bars[i - 1].time;
    if (dt > 0 && dt < minDt) minDt = dt;
  }
  if (!isFinite(minDt) || minDt <= 0) minDt = 60;
  const GAP_DT = minDt * 4;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const vol = b.volume ?? 0;
    // NOTE: no high-volume skip here. High-vol bars ARE evaluated so a genuine high-vol run bar
    // gets CONFIRMED on the anchor track (protecting it from the pairwise cleanup); a high-vol
    // bar that is a lone singleton far off the dominant track is still a phantom (wrong-contract
    // bleed can carry real-looking volume).

    // Gather window neighbours: array-adjacent, still-kept, not across a time gap from i.
    const win: T[] = [];
    for (let j = i - 1, steps = 0; j >= 0 && steps < HALF + 2; j--) {
      if (!isKept[j]) continue;
      if (bars[j + 1].time - bars[j].time > GAP_DT) break; // time gap between j and j+1
      win.push(bars[j]);
      steps++;
    }
    for (let j = i + 1, steps = 0; j < bars.length && steps < HALF + 2; j++) {
      if (bars[j].time - bars[j - 1].time > GAP_DT) break;
      win.push(bars[j]);
      steps++;
    }
    if (win.length < 4) continue; // too little context (sparse/thin region) — leave to pass (2)

    // Cluster candidate + neighbour closes greedily. Each cluster tracks count (n), close-sum
    // (its centre), and total VOLUME. The real price track is the one carrying the most VOLUME
    // — a far more reliable anchor than bare count when several phantom RUNS interleave with the
    // real track (2026-03-19: a ~6583 real track vol 28-32 interwoven with ~6634 and ~6686
    // phantom runs of vol 2-17 — no cluster is a count-majority, but the real one dominates vol).
    const tol = clusterTol(b.close);
    const clusters: { sum: number; n: number; vol: number }[] = [];
    const place = (px: number, v: number) => {
      for (const c of clusters) {
        if (Math.abs(px - c.sum / c.n) <= tol) { c.sum += px; c.n++; c.vol += v; return c; }
      }
      const c = { sum: px, n: 1, vol: v };
      clusters.push(c);
      return c;
    };
    const ownCluster = place(b.close, vol);
    for (const n of win) place(n.close, n.volume ?? 0);

    const total = win.length + 1;
    let anchor = clusters[0];
    for (const c of clusters) if (c.vol > anchor.vol) anchor = c;
    // Candidate is ON the dominant-volume track — confirm it real so the pairwise cleanup below
    // can't later drop it. This protects a genuine high-volume RUN bar whose immediate
    // neighbours were thinned by isSpikeBar (2026-02-20T15:03 MES 1m V11838, mid-rally: its body
    // sits above the two surviving neighbour closes and the naive pairwise test would flag it,
    // but the window shows it's squarely on the dominant-volume track).
    if (ownCluster === anchor || Math.abs(b.close - anchor.sum / anchor.n) <= tol) {
      confirmed[i] = true;
      continue;
    }

    // Off the dominant track. Two PHANTOM signatures — drop on either:
    //  (i)  own cluster is a tiny minority (lone/near-lone print) — catches interleaved phantoms
    //       AND a lone high-vol wrong-contract print (a real fast move is never this isolated
    //       against a full window of the dominant track), OR
    //  (ii) own cluster carries far less volume than the anchor AND the candidate is ABSOLUTELY
    //       thin (vol < floor) — a systematically-thin displaced run. The ABSOLUTE floor is
    //       load-bearing: without it a legit price level sitting just before a giant-volume
    //       news/settlement bar (which becomes the anchor) would be misread as a phantom run.
    const VOL_ABS_FLOOR = 100;
    const anchorMedVol = anchor.vol / anchor.n;
    const tinyCluster = ownCluster.n <= Math.max(1, Math.floor(total / 3));
    const thinDisplaced = vol < VOL_ABS_FLOOR && ownCluster.vol < 0.5 * anchor.vol && vol < 0.5 * anchorMedVol;
    if (tinyCluster || thinDisplaced) {
      isKept[i] = false;
    }
  }

  // (2) Pairwise displaced-body cleanup on the survivors — multi-pass, early-stop.
  let cur = bars.filter((_, i) => isKept[i]);
  const confirmedSet = new WeakSet<object>(bars.filter((_, i) => confirmed[i]) as object[]);
  for (let pass = 0; pass < 4; pass++) {
    const kept: T[] = [];
    let dropped = 0;
    for (let i = 0; i < cur.length; i++) {
      const b = cur[i];
      const prev = kept.length ? kept[kept.length - 1] : undefined;
      const next = cur[i + 1];
      // Skip bars the windowed pass confirmed on the dominant-volume track — never re-drop them.
      if (prev && next && !confirmedSet.has(b as object)) {
        const lo = Math.min(prev.close, next.close);
        const hi = Math.max(prev.close, next.close);
        // Tolerance scales with price — 0.1% or 8pt, whichever is larger.
        const tol = Math.max(8, b.close * 0.001);
        const bodyLow = Math.min(b.open, b.close);
        const bodyHigh = Math.max(b.open, b.close);
        // Entire body sits above both neighbour closes, or below both.
        if (bodyLow > hi + tol || bodyHigh < lo - tol) { dropped++; continue; }
      }
      kept.push(b);
    }
    cur = kept;
    if (dropped === 0) break;
  }
  return cur;
}

/**
 * Drop a low-volume LONE-WICK spike: a bar whose HIGH or LOW pokes out beyond a local
 * high/low envelope built from its temporal neighbours, when volume says it can't be a
 * real move. This is the primary glitch filter — the concrete case it targets is the
 * 2026-07-02T11:40Z MES 5m bar `O7561.5 H7563.5 L7560.75 C7563` sitting among ~7546-47
 * bars: a ~15pt displaced spike that `isSpikeBar` misses (range/close ≈ 0.037%) and
 * `dropIsolatedSpikes` misses too (its BODY overlaps the neighbours, only the wick pokes).
 *
 * Discriminator is VOLUME — true glitches are near-zero volume; real news/settlement
 * moves are V400+. We NEVER drop a bar on displacement alone.
 *
 * Envelope is TWO-SIDED with NO interval/adjacency gating: up to 3 already-kept bars
 * before + up to 3 raw bars after. An earlier version gated neighbours to within ~3x the
 * inferred bar interval to avoid flagging real session-gap/weekend-reopen bars — but that
 * also let deep-overnight / holiday phantoms through, because the DB has GENUINE gaps in
 * low-liquidity periods so their neighbours were "too far" and never compared. Union of
 * both: no time gating, but volume is the guard against dropping a legitimate reopen.
 *
 * Two independent drop tests per low-poke candidate:
 *   (1) relative/absolute low volume + extreme pokes out of the envelope, OR
 *   (2) "lone wick" — the extreme pokes out but the BODY stays inside the envelope
 *       (a spike that returned), dropped regardless of the relative-volume test, UNLESS
 *       volume clears a hard floor that guarantees a real move.
 *
 * Multi-pass: interleaved phantoms shield each other on pass 1 and only become isolated
 * once the outer ones are gone. Iterate a few passes, stop early when a pass drops nothing.
 */
function dropWickSpikes<T extends SpikeBar>(bars: T[]): T[] {
  if (bars.length < 3) return bars;

  const VOL_ABS_FLOOR = 100;        // volume below this is "low" on its own
  const VOL_REL_FRAC = 0.15;        // ...or below 15% of the local median volume
  const VOL_HARD_FLOOR = 500;       // volume at/above this is ALWAYS a real move — never dropped
  const LONE_WICK_HARD_FLOOR = 500; // lone-wick test is skipped above this volume too

  const median = (xs: number[]): number => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  let cur = bars;
  for (let pass = 0; pass < 4; pass++) {
    const kept: T[] = [];
    let dropped = 0;

    for (let i = 0; i < cur.length; i++) {
      const b = cur[i];
      const vol = b.volume ?? 0;

      // High-volume bars are always real moves — never candidates.
      if (vol >= VOL_HARD_FLOOR) { kept.push(b); continue; }

      // Neighbour envelope: up to 3 already-kept before + up to 3 raw after. No time gating.
      const before = kept.slice(-3);
      const after = cur.slice(i + 1, i + 4);
      const neigh = [...before, ...after];
      if (neigh.length < 2) { kept.push(b); continue; }

      const envHigh = Math.max(...neigh.map(n => n.high));
      const envLow = Math.min(...neigh.map(n => n.low));
      // Tighter tolerance for already-low-volume candidates (<100). A 2026-07-02 audit found
      // ~100 isolated single-print glitches (volume 2-97, median ~15-20, scattered across 9
      // months of history) whose poke was 6-8pt — just under the flat 8pt floor, so they slipped
      // through. A real MES print is never the ONLY trade in a whole bucket while ALSO displaced
      // several points from neighbours, so tightening here is low-risk. Unchanged for vol>=100.
      const tol = vol < 100 ? Math.max(5, b.close * 0.0007) : Math.max(8, b.close * 0.001);

      const pokesHigh = b.high > envHigh + tol;
      const pokesLow = b.low < envLow - tol;
      if (!pokesHigh && !pokesLow) { kept.push(b); continue; }

      // Volume context.
      const medVol = median(neigh.map(n => n.volume ?? 0));
      const lowVol = vol < VOL_ABS_FLOOR || (medVol > 0 && vol < VOL_REL_FRAC * medVol);

      // Test (2) — lone wick: extreme pokes but the BODY stays inside the envelope.
      const bodyLow = Math.min(b.open, b.close);
      const bodyHigh = Math.max(b.open, b.close);
      const bodyInside = bodyLow >= envLow - tol && bodyHigh <= envHigh + tol;
      const loneWick = bodyInside && vol < LONE_WICK_HARD_FLOOR;

      // Test (1) — displaced extreme with genuinely low volume.
      if ((lowVol && (pokesHigh || pokesLow)) || loneWick) {
        dropped++;
        continue;
      }
      kept.push(b);
    }

    cur = kept;
    if (dropped === 0) break;
  }
  return cur;
}

/**
 * Drop any COMPLETED bar with volume 0/null outright — no poke/envelope test needed.
 * MES is a heavily-traded micro future; a genuinely completed bar with zero contracts
 * traded across the whole bucket is never real market data (it's a placeholder written
 * while a data source was catching up, e.g. during a resync gap). `dropWickSpikes` only
 * catches a zero-volume bar when it POKES relative to its neighbours — but most zero-vol
 * bars sit in multi-bar RUNS where every neighbour is ALSO zero-vol, so nothing pokes and
 * they all sail through undetected (found via a 2026-07-02 audit: 1,338 such 1m bars
 * across 272 runs, only ~60 of which happened to poke and get caught). Exempts the LAST
 * bar in the array — that's always the current forming/most-recent bar, which can
 * legitimately show volume 0 for a moment before the next tick/relay update lands.
 */
function dropCompletedGhostBars<T extends SpikeBar>(bars: T[]): T[] {
  if (bars.length < 2) return bars;
  const lastIdx = bars.length - 1;
  return bars.filter((b, i) => i === lastIdx || (b.volume != null && b.volume !== 0));
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

// ── Yahoo Finance backfill ───────────────────────────────────────────────────
// Maps short internal symbols to Yahoo Finance continuous-contract tickers.
function toYahooSymbol(sym: string): string {
  const MAP: Record<string, string> = {
    // Micro contracts → use the standard contract for Yahoo Finance (same price, 1/10 size)
    MES: "ES=F", MNQ: "NQ=F", MYM: "YM=F", M2K: "RTY=F", MCL: "CL=F", MGC: "GC=F",
    // Standard contracts
    ES: "ES=F", NQ: "NQ=F", YM: "YM=F", RTY: "RTY=F", CL: "CL=F", GC: "GC=F",
  };
  return MAP[sym.toUpperCase()] ?? sym;
}

// Fetches up to 720 days of 60m bars + 59 days of 5m/15m bars from Yahoo Finance
// Upserts into cached_candles. Default `overwrite=false` → ON CONFLICT DO NOTHING (auto-startup
// run never clobbers live MW relay data). `overwrite=true` → ON CONFLICT DO UPDATE so Yahoo becomes
// authoritative for its available range (60d for 5m/15m, ~720d for 60m) — used to repair corrupt /
// wrong-contract bars. Returns total bars fetched + written.
async function yahooBackfillSymbol(symbol: string, overwrite = false): Promise<number> {
  const ySym  = toYahooSymbol(symbol);
  const now   = new Date();
  const nowMs = now.getTime();
  let totalInserted = 0;
  const upsert = async (vals: any[]) => {
    for (let i = 0; i < vals.length; i += 500) {
      const chunk = vals.slice(i, i + 500);
      if (overwrite) {
        await db.insert(cachedCandles).values(chunk).onConflictDoUpdate({
          target: [cachedCandles.symbol, cachedCandles.resolution, cachedCandles.timestamp],
          set: { open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close`, volume: sql`excluded.volume` },
        });
      } else {
        await db.insert(cachedCandles).values(chunk).onConflictDoNothing();
      }
    }
  };

  const CHUNK_DAYS = 240;
  const MAX_DAYS   = 720;

  // Helper: fetch with logging so failures are visible in the server console.
  async function fetchLogged(sym: string, from: Date, to: Date, interval: string): Promise<any[]> {
    try {
      const bars = await fetchChunk(sym, from, to, interval);
      console.log(`[yahoo-backfill] ${symbol} ${interval} ${from.toISOString().slice(0,10)}→${to.toISOString().slice(0,10)}: ${bars.length} bars`);
      return bars;
    } catch (e: any) {
      console.error(`[yahoo-backfill] ${symbol} ${interval} fetch error: ${e?.message}`);
      return [];
    }
  }

  // 60m – fetch up to 720 days in 240-day chunks (newest → oldest)
  for (let offset = 0; offset < MAX_DAYS; offset += CHUNK_DAYS) {
    const chunkTo   = new Date(nowMs - offset * 86_400_000);
    const chunkFrom = new Date(nowMs - Math.min(offset + CHUNK_DAYS, MAX_DAYS) * 86_400_000);
    const bars = await fetchLogged(ySym, chunkFrom, chunkTo, "60m");
    if (bars.length) {
      const vals = bars.map((b: any) => ({
        symbol, resolution: "60",
        timestamp: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0,
      }));
      await upsert(vals);
      totalInserted += bars.length;
    }
  }

  // 5m and 15m – last 59 days (Yahoo's intraday limit for both)
  for (const { res, yInterval } of [{ res: "5", yInterval: "5m" }, { res: "15", yInterval: "15m" }]) {
    const fromTs = new Date(nowMs - 59 * 86_400_000);
    const bars   = await fetchLogged(ySym, fromTs, now, yInterval);
    if (bars.length) {
      const vals = bars.map((b: any) => ({
        symbol, resolution: res,
        timestamp: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0,
      }));
      await upsert(vals);
      totalInserted += bars.length;
    }
  }

  if (totalInserted > 0) cacheInvalidate(symbol);
  return totalInserted;
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

  // Dump raw bytes of the last tick record so we can verify the binary format
  app.get("/api/admin/tick-debug", (_req, res) => {
    const instrDir = path.join(
      process.env.USERPROFILE ?? "C:\\Users\\jacks",
      "AppData", "Roaming", "MotiveWave", "historical_data", "RITHMIC", "MESM6.CME"
    );
    let entries: string[];
    try { entries = fs.readdirSync(instrDir); } catch (e: any) { res.json({ error: e.message }); return; }
    const tickFiles = entries.filter(f => f.endsWith(".tick_data")).sort().slice(-5);
    const results = tickFiles.map(f => {
      const fp = path.join(instrDir, f);
      try {
        const st = fs.statSync(fp);
        const HEADER = 86, RECORD = 45;
        const nRec = Math.floor((st.size - HEADER) / RECORD);
        if (nRec < 1) return { file: f, size: st.size, mtime: st.mtime, error: "no complete records" };
        const buf = Buffer.allocUnsafe(RECORD);
        const fd = fs.openSync(fp, "r");
        fs.readSync(fd, buf, 0, RECORD, HEADER + (nRec - 1) * RECORD);
        fs.closeSync(fd);
        // Interpret every possible 4-byte float32BE and 8-byte float64BE in the record
        const floats: Record<string, number> = {};
        for (let i = 0; i <= RECORD - 4; i++) floats[`f32_off${i}`] = buf.readFloatBE(i);
        const doubles: Record<string, number> = {};
        for (let i = 0; i <= RECORD - 8; i++) doubles[`f64_off${i}`] = buf.readDoubleBE(i);
        return { file: f, size: st.size, mtime: st.mtime, nRec, hex: buf.toString("hex"), floats, doubles };
      } catch (e: any) { return { file: f, error: e.message }; }
    });
    res.json(results);
  });

  // Force-reload all MW bar files from disk into the DB.
  // Blocks until reload completes (same as PC) so data is guaranteed fresh when the
  // client's query invalidation refetches. Hard-capped at 45s so the spinner always stops.
  app.post("/api/admin/reload-mw", async (_req, res) => {
    // 1. Re-read MW bar/tick files from disk → upsert into DB.
    try {
      const TIMEOUT_MS = 45_000;
      const deadline = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)
      );
      await Promise.race([reloadAll(), deadline]);
    } catch (err: any) {
      if (err.message !== "timeout") {
        console.error("[reload-mw] reload error:", err.message);
      }
    }
    cacheFlushAll(); // flush AFTER reload so the client's refetch gets fresh DB data

    // 2. Terminate connected MW study WS connections.
    //    Studies reconnect automatically and re-send a full bulk_bars dump on reconnect,
    //    which gives the browser the exact data MW is currently showing.
    reconnectMWStudies();

    res.json({ ok: true, message: "MW data reloaded" });
  });

  // Live candles for stocks/ETFs from MarketData.app — called every 5s by the client
  // Returns the last N 5-min candles including the currently forming one
  app.get("/api/live/candles/:symbol", async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    const resolution = (req.query.res as string) || "5";
    const mdRes = resolution === "1" ? "1" : resolution === "60" ? "H" : "5";
    try {
      // Fetch last 2 hours of candles so the current forming candle is included
      const now = Math.floor(Date.now() / 1000);
      const from = now - 2 * 3600;
      const data = await mdFetch(`/stocks/candles/${mdRes}/${sym}/?from=${from}&to=${now}`);
      if (!data || data.s !== "ok" || !data.t?.length) {
        res.json({ candles: [] });
        return;
      }
      const candles = data.t.map((t: number, i: number) => ({
        time: t,
        open:   data.o[i],
        high:   data.h[i],
        low:    data.l[i],
        close:  data.c[i],
        volume: data.v?.[i] ?? 0,
        rth:    isRTH(t),
      }));
      res.json({ candles });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Latest live bar for futures — ?res=1 for 1-min, default 5-min
  app.get("/api/live/bar/:symbol", (req, res) => {
    const sym = normalizeSymbol(req.params.symbol);
    const resolution = req.query.res === "1" ? "1" : "5";
    const bar = resolution === "1" ? getLatestBar1m(sym) : getLatestBar(sym);
    const price = getLastTickPrice(sym);
    res.json({ bar, price });
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

  // ── MW live candle export ─────────────────────────────────────────────────
  // Summary: what symbols/resolutions are in cached_candles with bar counts
  app.get("/api/data/mw-summary", async (_req, res) => {
    try {
      const rows = db.$client.prepare(`
        SELECT symbol, resolution,
               COUNT(*) AS bar_count,
               MIN(timestamp) AS first_bar,
               MAX(timestamp) AS last_bar
        FROM cached_candles
        GROUP BY symbol, resolution
        ORDER BY symbol, resolution
      `).all();
      res.json({ rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // CSV download for a symbol + resolution from cached_candles
  app.get("/api/data/mw-export/:symbol/:resolution", async (req, res) => {
    try {
      const sym = req.params.symbol.toUpperCase();
      const resolution = req.params.resolution;
      const rows = await db
        .select()
        .from(cachedCandles)
        .where(and(eq(cachedCandles.symbol, sym), eq(cachedCandles.resolution, resolution)))
        .orderBy(asc(cachedCandles.timestamp));
      if (!rows.length) { res.status(404).json({ error: "No data found" }); return; }
      const lines = [
        "timestamp,datetime_utc,open,high,low,close,volume",
        ...rows.map(r =>
          `${r.timestamp},${new Date(r.timestamp * 1000).toISOString()},${r.open},${r.high},${r.low},${r.close},${r.volume}`
        ),
      ];
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${sym}_${resolution}m_mw.csv"`);
      res.send(lines.join("\n"));
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
        set: { status: "downloading", barCount: 0, updatedAt: new Date().toISOString() },
      });

      let totalInserted = 0;

      for (const res of resolutions) {
        const multiplier = res === "5" ? 5 : 60;
        const timespan = "minute";

        let allResults: any[] = [];
        let nextUrl: string | null = `${POLYGON_BASE}/v2/aggs/ticker/${sym}/range/${multiplier}/${timespan}/${startDate}/${endDate}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;

        while (nextUrl) {
          const resp: Response = await fetch(nextUrl);
          if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Polygon API error ${resp.status}: ${text}`);
          }
          const data: any = await resp.json();
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
        set: { status: "done", barCount: totalInserted, updatedAt: new Date().toISOString() },
      });

      res.json({ success: true, symbol: sym, year, month, bars: totalInserted });
    } catch (err: any) {
      await db.insert(downloadStatus).values({
        symbol: sym, year, month, status: "error", barCount: 0,
      }).onConflictDoUpdate({
        target: [downloadStatus.symbol, downloadStatus.year, downloadStatus.month],
        set: { status: "error", barCount: 0, updatedAt: new Date().toISOString() },
      });
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data/candles/:symbol/:resolution", async (req, res) => {
    const { symbol, resolution } = req.params;
    const { from, to } = req.query;
    const sym = symbol.toUpperCase();
    const cacheKey = `${sym}:candles:${resolution}:${from ?? ""}:${to ?? ""}`;
    const cached = cacheGet<object>(cacheKey);
    if (cached) { res.json(cached); return; }
    try {
      let query = db.select().from(cachedCandles)
        .where(and(
          eq(cachedCandles.symbol, sym),
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
      const result = { symbol: sym, resolution, candles };
      cacheSet(cacheKey, result, TTL.candles);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data/daily-summary/:symbol", async (req, res) => {
    const { symbol } = req.params;
    const sym = symbol.toUpperCase();
    const cacheKey = `${sym}:daily-summary`;
    const cached = cacheGet<object>(cacheKey);
    if (cached) { res.json(cached); return; }
    try {
      const rows = db.$client.prepare(`
        SELECT
          DATE(datetime(timestamp, 'unixepoch')) as date,
          COUNT(*) as bars,
          MIN(open) as day_open,
          MAX(high) as high,
          MIN(low) as low,
          SUM(volume) as volume
        FROM cached_candles
        WHERE symbol = ? AND resolution = '5'
          AND timestamp BETWEEN 1262304000 AND ?
        GROUP BY DATE(datetime(timestamp, 'unixepoch'))
        ORDER BY date DESC
        LIMIT 2000
      `).all(sym, Math.floor(Date.now() / 1000) + 36 * 3600);
      const result = { symbol: sym, days: rows };
      cacheSet(cacheKey, result, TTL.days);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data/cached-continuous/:symbol/:interval", async (req, res) => {
    const { symbol, interval } = req.params;
    const sym = normalizeSymbol(symbol);
    const resolution = interval === "60m" ? "60" : interval === "1m" ? "1" : "5";
    const fromN = req.query.from ? Number(req.query.from) : 0;
    // Never serve bars dated in the future (corrupt rows) — clamp the upper bound.
    const maxTs = Math.floor(Date.now() / 1000) + 36 * 3600;
    const toN   = Math.min(req.query.to ? Number(req.query.to) : Infinity, maxTs);

    const cacheKey = `${sym}:continuous:${interval}:${fromN}:${isFinite(toN) ? Math.round(toN / 3600) : "inf"}`;
    const cached = cacheGet<object>(cacheKey);
    if (cached) { res.json(cached); return; }

    // Max H-L spread (fraction of close) before a bar is treated as a corrupt spike.
    // Float32 corruptions are typically 10x+ off from real price (e.g. 512 or 8192 instead of ~5800).
    // Thresholds are raised to allow real news-event bars (1m flash crashes, 60m trend days).
    const spikeThreshold = interval === "1m" ? 0.025 : interval === "5m" ? 0.040 : interval === "15m" ? 0.050 : 0.070;
    function isSpikeBar(o: number, h: number, l: number, c: number): boolean {
      // Malformed OHLCV (impossible values)
      if (h < l || o > h || o < l || c > h || c < l || c <= 0) return true;
      const range = h - l;
      // Large absolute range
      if (range / c > spikeThreshold) return true;
      // Gap-bar artifact: O≈H and L≈C (bearish session gap) or O≈L and H≈C (bullish session gap).
      // These bars span an overnight gap — they appear as tall full-body bars and corrupt
      // Lowest(low,20). Only flag when the range is GENUINELY LARGE (a real gap). The old
      // `> 0.001` (0.1%) gate dropped legitimate strong directional candles — e.g. a ~12pt
      // 15m breakout that opens at its low and closes at its high (a normal marubozu). Gate
      // on half the spike threshold so only abnormally tall full-body bars are rejected.
      if (range / c > spikeThreshold * 0.5) {
        if ((Math.abs(o - h) < 0.5 && Math.abs(l - c) < 0.5) ||
            (Math.abs(o - l) < 0.5 && Math.abs(h - c) < 0.5)) return true;
      }
      return false;
    }

    // Helper: convert MinBar[] to the candle shape the client expects
    function memBarsToCandles(bars: { timeSec: number; open: number; high: number; low: number; close: number; volume: number }[]) {
      return dropWickSpikes(dropIsolatedSpikes(dropCompletedGhostBars(bars
        .filter(b => (!fromN || b.timeSec >= fromN) && (!isFinite(toN) || b.timeSec <= toN))
        .filter(b => !(b.high === b.low)) // flat zero-range = no-body "dash" bar
        .filter(b => !isSpikeBar(b.open, b.high, b.low, b.close))
        .filter(b => !isMarketClosed(b.timeSec))
        .map(b => ({ time: b.timeSec, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, rth: isRTH(b.timeSec) })))));
    }

    try {
      // For 15m: try "15" first, fall back to "5"
      const resolutionsToTry = interval === "15m" ? ["15", "5"] : [resolution];
      let rows: { symbol: string; resolution: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number | null }[] = [];
      let usedRes = resolution;

      for (const r of resolutionsToTry) {
        const conditions = [
          eq(cachedCandles.symbol, sym),
          eq(cachedCandles.resolution, r),
          ...(fromN ? [gte(cachedCandles.timestamp, fromN)] : []),
          ...(isFinite(toN) ? [lte(cachedCandles.timestamp, toN)] : []),
        ];
        rows = await db.select().from(cachedCandles)
          .where(and(...conditions))
          .orderBy(asc(cachedCandles.timestamp));
        if (rows.length > 0) { usedRes = r; break; }
      }

      if (rows.length > 0) {
        // Real bars sit exactly on the resolution boundary (e.g. 5m → timestamp % 300 === 0). Bars
        // at odd seconds are foreign-source artifacts — typically a zero-range / volume-0 single
        // print that renders as a "no-body dash" candle. Drop anything off the bucket grid.
        const resSec = (parseInt(usedRes, 10) || 5) * 60;
        // dropWickSpikes runs BEFORE any 15m aggregation so a glitchy 5m wick can't corrupt the
        // aggregated 15m high/low.
        let candles = dropWickSpikes(dropIsolatedSpikes(dropCompletedGhostBars(rows
          .filter(r => r.timestamp % resSec === 0)
          .filter(r => !(r.high === r.low)) // flat zero-range = no-body "dash" bar (drop regardless of volume — no real MES bar is perfectly flat)
          .filter(r => !isSpikeBar(r.open, r.high, r.low, r.close))
          .filter(r => !isMarketClosed(r.timestamp))
          .map(r => ({ time: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, rth: isRTH(r.timestamp) })))));

        // 15m fallback: when native 15m bars are absent and we fell back to 5m rows, the client
        // receives raw 5m bars for a 15m chart request. Its `isAligned` filter would keep ONLY
        // bars sitting on 15m boundaries (the first 5m sub-bar of each 15m period), not proper
        // aggregated 15m OHLCV. Aggregate server-side so the chart sees correct 15m bars.
        if (interval === "15m" && usedRes === "5") {
          const agg = new Map<number, typeof candles[0]>();
          for (const c of candles) {
            const t = Math.floor(c.time / 900) * 900;
            const ex = agg.get(t);
            if (!ex) { agg.set(t, { ...c, time: t }); }
            else {
              ex.high   = Math.max(ex.high, c.high);
              ex.low    = Math.min(ex.low,  c.low);
              ex.close  = c.close;
              ex.volume = (ex.volume ?? 0) + (c.volume ?? 0);
              if (!ex.rth && c.rth) ex.rth = c.rth;
            }
          }
          candles = [...agg.values()].sort((a, b) => a.time - b.time);
        }

        const result = { symbol: sym, interval, candles, source: "cached", resolution: usedRes };
        cacheSet(cacheKey, result, TTL.continuous);
        res.json(result);
        return;
      }

      // DB empty — try in-memory MW bars before giving up
      const memRes = interval === "15m" ? ["5"] : [resolution];
      for (const r of memRes) {
        let memCandles = memBarsToCandles(getMemBars(sym, r));
        // Same 15m fallback aggregation for the memory path
        if (memCandles.length > 0 && interval === "15m" && r === "5") {
          const agg = new Map<number, typeof memCandles[0]>();
          for (const c of memCandles) {
            const t = Math.floor(c.time / 900) * 900;
            const ex = agg.get(t);
            if (!ex) { agg.set(t, { ...c, time: t }); }
            else {
              ex.high   = Math.max(ex.high, c.high);
              ex.low    = Math.min(ex.low,  c.low);
              ex.close  = c.close;
              ex.volume = (ex.volume ?? 0) + (c.volume ?? 0);
              if (!ex.rth && c.rth) ex.rth = c.rth;
            }
          }
          memCandles = [...agg.values()].sort((a, b) => a.time - b.time);
        }
        if (memCandles.length > 0) {
          res.json({ symbol: sym, interval, candles: memCandles, source: "memory", resolution: r });
          return;
        }
      }

      // No futures data anywhere
      const isFuturesSym = /^(ES|NQ|YM|CL|GC|SI|NG|MES|MNQ|RTY)[A-Z]?\d*$/i.test(sym) || sym.endsWith("=F");
      if (isFuturesSym) { res.json({ symbol: sym, interval, candles: [], source: "none" }); return; }

      const yahooInterval = interval === "60m" ? "60m" : "15m";
      const yahooCandles = await fetchContinuousHistory(sym, yahooInterval).catch(() => []);
      res.json({ symbol: sym, interval, candles: yahooCandles, source: yahooCandles.length > 0 ? "yahoo" : "none" });
    } catch (err: any) {
      // DB quota / connection failure — serve from in-memory MW bars
      const memRes = interval === "15m" ? ["5"] : [resolution];
      for (const r of memRes) {
        const memCandles = memBarsToCandles(getMemBars(sym, r));
        if (memCandles.length > 0) {
          res.json({ symbol: sym, interval, candles: memCandles, source: "memory", resolution: r });
          return;
        }
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/data/cached-days/:symbol", async (req, res) => {
    const { symbol } = req.params;
    const sym = symbol.toUpperCase();

    // Build days from in-memory 5m bars — used as primary source when DB is unavailable
    function daysFromMem() {
      const bars = getMemBars(sym, "5");
      if (!bars.length) return null;
      const dayMap = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
      for (const b of bars) {
        const date = new Date(b.timeSec * 1000).toISOString().split("T")[0];
        const ex = dayMap.get(date);
        if (!ex) { dayMap.set(date, { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }); }
        else { ex.high = Math.max(ex.high, b.high); ex.low = Math.min(ex.low, b.low); ex.close = b.close; ex.volume += b.volume; }
      }
      return [...dayMap.entries()].map(([date, d]) => ({ date, ...d })).sort((a, b) => a.date.localeCompare(b.date));
    }

    try {
      const resultRows = db.$client.prepare(`
        SELECT
          DATE(datetime(timestamp, 'unixepoch')) as date,
          MIN(CASE WHEN timestamp = day_min THEN open END) as open,
          MAX(high) as high,
          MIN(low) as low,
          MIN(CASE WHEN timestamp = day_max THEN close END) as close,
          SUM(volume) as volume
        FROM (
          SELECT *,
            MIN(timestamp) OVER (PARTITION BY DATE(datetime(timestamp, 'unixepoch'))) as day_min,
            MAX(timestamp) OVER (PARTITION BY DATE(datetime(timestamp, 'unixepoch'))) as day_max
          FROM cached_candles
          WHERE symbol = ? AND resolution IN ('5', '15', '60')
        )
        GROUP BY DATE(datetime(timestamp, 'unixepoch'))
        ORDER BY date DESC
      `).all(sym) as any[];

      if (resultRows.length > 0) {
        const days = resultRows.map(r => ({
          date: typeof r.date === 'string' ? r.date.split('T')[0] : new Date(r.date).toISOString().split('T')[0],
          open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
        }));
        res.json({ symbol: sym, days });
        return;
      }
      // DB empty — fall back to memory
      const memDays = daysFromMem();
      res.json({ symbol: sym, days: memDays ?? [] });
    } catch (err: any) {
      // DB quota / connection error — serve from memory
      const memDays = daysFromMem();
      if (memDays?.length) { res.json({ symbol: sym, days: memDays }); return; }
      res.status(500).json({ error: err.message });
    }
  });


  // ── Full dataset export: all candles + signals for a symbol (JSON) ──────────
  // DATA PAGE FIX: Single-file snapshot that can be re-imported to restore exact
  // chart + signal state. Keyed by symbol+resolution so the import can reconstruct
  // the data store precisely. Signals are included so re-import re-locks all levels.
  app.get("/api/data/export-full/:symbol", async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    try {
      // Fetch all resolutions for this symbol
      const candles = await db.select().from(cachedCandles)
        .where(eq(cachedCandles.symbol, sym))
        .orderBy(asc(cachedCandles.timestamp));

      // Fetch all stored signals for this symbol (all intervals)
      const signals = await db.select().from(signalHistory)
        .where(eq(signalHistory.symbol, sym));

      const exportData = {
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        symbol: sym,
        candles: candles.map(c => ({
          symbol:    c.symbol,
          interval:  c.resolution === "1" ? "1m" : c.resolution === "5" ? "5m" : c.resolution === "60" ? "60m" : `${c.resolution}m`,
          resolution: c.resolution,
          timestamp: c.timestamp,
          open:      c.open,
          high:      c.high,
          low:       c.low,
          close:     c.close,
          volume:    c.volume,
        })),
        signals: signals.map(s => ({
          symbol:      s.symbol,
          interval:    s.interval,
          timestamp:   s.timestamp,
          direction:   s.direction,
          riskLevel:   s.riskLevel,
          signalType:  s.signalType,
          entry:       s.entry,
          tp1:         s.tp1,
          tp2:         s.tp2,
          sl:          s.sl,
          outcome:     s.outcome,
          patternBars: s.patternBars,
          status:      s.outcome ?? "active",
        })),
      };

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${sym}_full_export.json"`);
      res.json(exportData);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Full dataset import: restore candles + signals from a prior export ───────
  // DATA PAGE FIX: Re-upload an export file to restore exact chart + signal state.
  // Uses onConflictDoNothing so existing data is never overwritten — new candles
  // are APPENDED, matching the "never replace, always append" requirement.
  app.post("/api/data/import-full", async (req, res) => {
    try {
      const body = req.body as {
        exportVersion?: number;
        symbol?: string;
        candles?: Array<{
          symbol: string; resolution: string; timestamp: number;
          open: number; high: number; low: number; close: number; volume?: number;
        }>;
        signals?: Array<{
          symbol: string; interval: string; timestamp: number; direction: string;
          riskLevel: string; signalType?: string; entry: number;
          tp1: number; tp2: number; sl: number; outcome?: string; patternBars?: number;
        }>;
      };

      if (!body?.candles || !Array.isArray(body.candles)) {
        res.status(400).json({ error: "Invalid export file: missing candles array" });
        return;
      }

      let candlesInserted = 0, signalsInserted = 0;
      const CHUNK = 500;

      // Validate + insert candles — APPEND only (onConflictDoNothing)
      const validCandles = body.candles.filter(c =>
        c.symbol && c.timestamp > 0 && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 &&
        c.high >= c.low && Number.isFinite(c.open) && Number.isFinite(c.close)
      );
      for (let i = 0; i < validCandles.length; i += CHUNK) {
        const chunk = validCandles.slice(i, i + CHUNK);
        const values = chunk.map(c => ({
          symbol:     c.symbol.toUpperCase(),
          resolution: c.resolution.replace("m", ""),
          timestamp:  c.timestamp,
          open:       c.open,
          high:       c.high,
          low:        c.low,
          close:      c.close,
          volume:     c.volume ?? 0,
        }));
        await db.insert(cachedCandles).values(values).onConflictDoNothing();
        candlesInserted += chunk.length;
      }

      // Validate + insert signals — onConflictDoNothing (never overwrite stored locks)
      if (Array.isArray(body.signals)) {
        const validSignals = body.signals.filter(s =>
          s.symbol && s.interval && s.timestamp > 0 && s.direction &&
          s.entry > 0 && s.tp1 > 0 && s.tp2 > 0 && s.sl > 0
        );
        for (let i = 0; i < validSignals.length; i += CHUNK) {
          const chunk = validSignals.slice(i, i + CHUNK);
          const values = chunk.map(s => ({
            symbol:      s.symbol.toUpperCase(),
            interval:    s.interval,
            timestamp:   s.timestamp,
            direction:   s.direction,
            riskLevel:   s.riskLevel ?? "safe",
            signalType:  s.signalType ?? null,
            entry:       s.entry,
            tp1:         s.tp1,
            tp2:         s.tp2,
            sl:          s.sl,
            outcome:     s.outcome ?? null,
            patternBars: s.patternBars ?? null,
            updatedAt:   new Date().toISOString(),
          }));
          await db.insert(signalHistory).values(values).onConflictDoNothing();
          signalsInserted += chunk.length;
        }
      }

      res.json({ ok: true, candlesInserted, signalsInserted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── MW CSV import helpers ─────────────────────────────────────────────────
  function parseMWVolume(s: string): number {
    const t = s.trim();
    if (t.toUpperCase().endsWith("K")) return Math.round(parseFloat(t) * 1000);
    if (t.toUpperCase().endsWith("M")) return Math.round(parseFloat(t) * 1_000_000);
    return parseInt(t) || 0;
  }

  function parseMWCsvText(csvText: string, symbolOverride: string): {
    symbol: string; resolution: string;
    bars: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>;
  } {
    const lines = csvText.trim().split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error("CSV too short");

    const header = lines[0].split(",").map(h => h.trim().toLowerCase());
    const isUnixFmt = header[0] === "timestamp"; // HistoryDumper format
    const bars: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map(c => c.trim());
      if (cols.length < 5) continue;
      let ts: number;
      if (isUnixFmt) {
        ts = parseInt(cols[0]);
      } else {
        // MW manual export: "DD/MM/YYYY HH:MM:SS"
        const parts = cols[0].trim().split(" ");
        if (parts.length < 2) continue;
        const [day, month, year] = parts[0].split("/");
        const time = parts[1];
        const mNum = parseInt(month);
        const etOff = (mNum >= 3 && mNum <= 11) ? -4 : -5;
        const sign = etOff < 0 ? "-" : "+";
        const absOff = String(Math.abs(etOff)).padStart(2, "0");
        const iso = `${year}-${month.padStart(2,"0")}-${day.padStart(2,"0")}T${time}${sign}${absOff}:00`;
        ts = Math.floor(new Date(iso).getTime() / 1000);
      }
      if (!ts || isNaN(ts) || ts <= 0) continue;
      const o = parseFloat(cols[1]), h = parseFloat(cols[2]);
      const l = parseFloat(cols[3]), c = parseFloat(cols[4]);
      const v = isUnixFmt ? (parseInt(cols[5]) || 0) : parseMWVolume(cols[5] ?? "0");
      if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c) || h < l || o <= 0) continue;
      bars.push({ timestamp: ts, open: o, high: h, low: l, close: c, volume: v });
    }

    if (bars.length < 2) throw new Error("Not enough valid bars after parsing");
    bars.sort((a, b) => a.timestamp - b.timestamp);

    // Infer resolution from smallest delta between consecutive bars
    const deltas: number[] = [];
    for (let i = 1; i < Math.min(bars.length, 20); i++) {
      const d = bars[i].timestamp - bars[i - 1].timestamp;
      if (d > 0) deltas.push(d);
    }
    const minDelta = Math.min(...deltas);
    let resolution = "5";
    if (minDelta <= 65) resolution = "1";
    else if (minDelta <= 310) resolution = "5";
    else if (minDelta <= 920) resolution = "15";
    else resolution = "60";

    return { symbol: symbolOverride, resolution, bars };
  }

  // POST /api/data/import-csv — upload MW CSV text (manual export or HistoryDumper output)
  app.post("/api/data/import-csv", async (req, res) => {
    try {
      const { csv, symbol } = req.body as { csv: string; symbol: string };
      if (!csv || !symbol) { res.status(400).json({ error: "csv and symbol required" }); return; }

      const sym = symbol.replace(/[HMUZ]\d{1,2}$/, "").toUpperCase(); // strip contract month
      const { resolution, bars } = parseMWCsvText(csv, sym);

      const CHUNK = 500;
      let inserted = 0;
      for (let i = 0; i < bars.length; i += CHUNK) {
        const chunk = bars.slice(i, i + CHUNK);
        const rows = chunk.map(b => ({
          symbol: sym, resolution,
          timestamp: b.timestamp,
          open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
        }));
        await db.insert(cachedCandles).values(rows).onConflictDoUpdate({
          target: [cachedCandles.symbol, cachedCandles.resolution, cachedCandles.timestamp],
          set: { open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close`, volume: sql`excluded.volume` },
        });
        inserted += chunk.length;
      }

      res.json({ success: true, symbol: sym, resolution, bars: inserted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/data/import-mw-dump — read CSV written by HistoryDumper study from disk
  app.post("/api/data/import-mw-dump", async (req, res) => {
    try {
      const { symbol } = req.body as { symbol: string };
      if (!symbol) { res.status(400).json({ error: "symbol required" }); return; }

      const sym = symbol.replace(/[HMUZ]\d{1,2}$/, "").toUpperCase();
      const mwExtDir = path.join(process.env.USERPROFILE ?? "C:\\Users\\jacks", "MotiveWave Extensions");

      // Find any dump file for this symbol (any resolution)
      const files = fs.existsSync(mwExtDir)
        ? fs.readdirSync(mwExtDir).filter(f => f.startsWith(`dump_${symbol}`) && f.endsWith(".csv"))
        : [];

      if (files.length === 0) {
        res.status(404).json({ error: `No dump file found for ${symbol} in ${mwExtDir}. Apply the HistoryDumper study to a MW chart first.` });
        return;
      }

      let totalInserted = 0;
      const results: Array<{ file: string; bars: number; resolution: string }> = [];

      for (const file of files) {
        const csvText = fs.readFileSync(path.join(mwExtDir, file), "utf-8");
        const { resolution, bars } = parseMWCsvText(csvText, sym);
        const CHUNK = 500;
        for (let i = 0; i < bars.length; i += CHUNK) {
          const chunk = bars.slice(i, i + CHUNK);
          const rows = chunk.map(b => ({
            symbol: sym, resolution,
            timestamp: b.timestamp,
            open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
          }));
          await db.insert(cachedCandles).values(rows).onConflictDoUpdate({
            target: [cachedCandles.symbol, cachedCandles.resolution, cachedCandles.timestamp],
            set: { open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close`, volume: sql`excluded.volume` },
          });
        }
        totalInserted += bars.length;
        results.push({ file, bars: bars.length, resolution });
      }

      res.json({ success: true, symbol: sym, totalBars: totalInserted, files: results });
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

  const GNEWS_KEY = process.env.LIVE_NEWS;
  const GNEWS_BASE = "https://gnews.io/api/v4";

  const NEWS_CATEGORIES = [
    { category: "fed_policy", query: '"federal reserve" OR "interest rate" OR "rate cut" OR "rate hike" OR "FOMC"', label: "Fed & Monetary Policy" },
    { category: "market_crash", query: '"stock market crash" OR "market selloff" OR "bear market" OR "market correction"', label: "Market Crashes & Corrections" },
    { category: "market_rally", query: '"stock market rally" OR "bull market" OR "record high" OR "market surge"', label: "Market Rallies" },
    { category: "inflation", query: '"inflation" OR "CPI" OR "consumer price" OR "price index"', label: "Inflation & CPI" },
    { category: "geopolitical", query: '"trade war" OR "tariff" OR "sanctions" OR "geopolitical" OR "war"', label: "Geopolitical Events" },
    { category: "earnings", query: '"earnings report" OR "earnings miss" OR "earnings beat" OR "revenue guidance"', label: "Earnings & Corporate" },
    { category: "recession", query: '"recession" OR "GDP" OR "unemployment" OR "jobs report" OR "economic slowdown"', label: "Recession & Economy" },
    { category: "crypto", query: '"bitcoin" OR "crypto crash" OR "cryptocurrency" OR "ethereum"', label: "Crypto Markets" },
  ];

  app.get("/api/news/categories", (_req, res) => {
    res.json(NEWS_CATEGORIES.map((c) => ({ category: c.category, label: c.label })));
  });

  app.get("/api/news/articles", async (req, res) => {
    try {
      const category = req.query.category as string | undefined;
      const limit = Math.min(Number(req.query.limit) || 100, 500);

      let query = db.select().from(newsArticles).orderBy(desc(newsArticles.publishedAt)).limit(limit);
      if (category && category !== "all") {
        query = query.where(eq(newsArticles.category, category)) as any;
      }

      const articles = await query;
      res.json({ articles, total: articles.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Scrolling news ticker — free RSS aggregation (no API key) ───────────────
  // Pulls market-relevant headlines from named sources, upserts into news_articles
  // (so it survives feed outages), and returns the newest N. Cached 10 min.
  const RSS_FEEDS: { name: string; url: string }[] = [
    { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
    { name: "NYT Business",   url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml" },
    { name: "NYT Economy",    url: "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml" },
    { name: "WSJ Markets",    url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
    { name: "CNBC",           url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258" },
    { name: "MarketWatch",    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
    { name: "Reuters",        url: "https://news.google.com/rss/search?q=when:1d+site:reuters.com+markets&hl=en-US&gl=US&ceid=US:en" },
    { name: "Morning Brew",   url: "https://news.google.com/rss/search?q=site:morningbrew.com+when:3d&hl=en-US&gl=US&ceid=US:en" },
    { name: "Berkshire Hathaway", url: "https://news.google.com/rss/search?q=%22Berkshire+Hathaway%22+when:7d&hl=en-US&gl=US&ceid=US:en" },
  ];
  const _rssParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: true });
  const _txt = (v: any): string => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") return _txt(v["#text"] ?? v["@_href"] ?? "");
    return String(v);
  };
  const _clean = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

  app.get("/api/news/ticker", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const cacheKey = "news:ticker";
    const cached = cacheGet<object>(cacheKey);
    if (cached) { res.json(cached); return; }

    const serveFromDb = async () => {
      const rows = await db.select().from(newsArticles).orderBy(desc(newsArticles.publishedAt)).limit(limit);
      return { articles: rows };
    };

    try {
      const collected: { title: string; url: string; source: string; publishedAt: string }[] = [];
      await Promise.allSettled(RSS_FEEDS.map(async (feed) => {
        try {
          const r = await fetch(feed.url, {
            headers: { "User-Agent": "Mozilla/5.0 (BaxterTerminal news ticker)" },
            signal: AbortSignal.timeout(7000),
          });
          if (!r.ok) return;
          const doc: any = _rssParser.parse(await r.text());
          const rawItems = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
          const items = Array.isArray(rawItems) ? rawItems : [rawItems];
          for (const it of items.slice(0, 12)) {
            const title = _clean(_txt(it?.title));
            const url = _txt(it?.link?.["@_href"] ?? it?.link);
            if (!title || !url) continue;
            const src = it?.source ? _clean(_txt(it.source)) || feed.name : feed.name;
            const pub = it?.pubDate ?? it?.published ?? it?.updated ?? null;
            const d = pub ? new Date(pub) : new Date();
            collected.push({
              title, url: url.trim(), source: src,
              publishedAt: isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(),
            });
          }
        } catch { /* skip this feed */ }
      }));

      // Upsert (url is unique) so the ticker survives a later feed outage.
      for (const a of collected) {
        try {
          await db.insert(newsArticles).values({
            title: a.title, description: null, content: null, url: a.url,
            source: a.source, imageUrl: null, publishedAt: a.publishedAt,
            category: "ticker", searchQuery: "rss",
          }).onConflictDoNothing();
        } catch { /* ignore single-row failure */ }
      }

      const result = await serveFromDb();
      cacheSet(cacheKey, result, 600); // 10 min
      res.json(result);
    } catch (err: any) {
      // Feed/network failure → serve whatever's already stored.
      try { res.json(await serveFromDb()); }
      catch { res.status(500).json({ error: err?.message ?? String(err) }); }
    }
  });

  app.post("/api/news/fetch", async (req, res) => {
    if (!GNEWS_KEY) {
      return res.status(400).json({ error: "LIVE_NEWS API key not configured" });
    }

    try {
      const { categories: reqCategories } = req.body;
      const categoriesToFetch = reqCategories
        ? NEWS_CATEGORIES.filter((c) => reqCategories.includes(c.category))
        : NEWS_CATEGORIES;

      let totalInserted = 0;
      const errors: string[] = [];

      for (const cat of categoriesToFetch) {
        try {
          const url = `${GNEWS_BASE}/search?q=${encodeURIComponent(cat.query)}&lang=en&max=10&sortby=relevance&apikey=${GNEWS_KEY}`;
          const resp = await fetch(url);
          if (!resp.ok) {
            errors.push(`${cat.category}: HTTP ${resp.status}`);
            continue;
          }
          const data = await resp.json();
          if (!data.articles?.length) continue;

          for (const article of data.articles) {
            try {
              await db.insert(newsArticles).values({
                title: article.title,
                description: article.description || null,
                content: article.content || null,
                url: article.url,
                source: article.source?.name || null,
                imageUrl: article.image || null,
                publishedAt: new Date(article.publishedAt).toISOString(),
                category: cat.category,
                searchQuery: cat.query.slice(0, 200),
              }).onConflictDoNothing();
              totalInserted++;
            } catch {}
          }

          await new Promise((r) => setTimeout(r, 250));
        } catch (err: any) {
          errors.push(`${cat.category}: ${err.message}`);
        }
      }

      res.json({ success: true, inserted: totalInserted, errors: errors.length > 0 ? errors : undefined });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/news/fetch-historical", async (req, res) => {
    if (!GNEWS_KEY) {
      return res.status(400).json({ error: "LIVE_NEWS API key not configured" });
    }

    try {
      const { fromDate, toDate } = req.body;

      const historicalQueries = [
        { category: "fed_policy", query: '"federal reserve" OR "interest rate cut" OR "FOMC decision"' },
        { category: "market_crash", query: '"stock market crash" OR "market selloff" OR "bear market"' },
        { category: "market_rally", query: '"stock market rally" OR "record high" OR "bull run"' },
        { category: "inflation", query: '"inflation rate" OR "CPI report" OR "consumer prices"' },
        { category: "geopolitical", query: '"trade war" OR "tariff" OR "sanctions"' },
        { category: "recession", query: '"recession" OR "GDP report" OR "jobs report"' },
      ];

      let totalInserted = 0;
      const errors: string[] = [];

      for (const cat of historicalQueries) {
        try {
          let url = `${GNEWS_BASE}/search?q=${encodeURIComponent(cat.query)}&lang=en&max=10&sortby=relevance&apikey=${GNEWS_KEY}`;
          if (fromDate) url += `&from=${fromDate}`;
          if (toDate) url += `&to=${toDate}`;

          const resp = await fetch(url);
          if (!resp.ok) {
            errors.push(`${cat.category}: HTTP ${resp.status}`);
            continue;
          }
          const data = await resp.json();
          if (!data.articles?.length) continue;

          for (const article of data.articles) {
            try {
              await db.insert(newsArticles).values({
                title: article.title,
                description: article.description || null,
                content: article.content || null,
                url: article.url,
                source: article.source?.name || null,
                imageUrl: article.image || null,
                publishedAt: new Date(article.publishedAt).toISOString(),
                category: cat.category,
                searchQuery: cat.query.slice(0, 200),
              }).onConflictDoNothing();
              totalInserted++;
            } catch {}
          }

          await new Promise((r) => setTimeout(r, 250));
        } catch (err: any) {
          errors.push(`${cat.category}: ${err.message}`);
        }
      }

      res.json({ success: true, inserted: totalInserted, errors: errors.length > 0 ? errors : undefined });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Zone file upload — parses .mwml or screenshot and returns zone bands ──────
  app.post("/api/zones/parse", async (req, res) => {
    try {
      const { filename, data, mediaType, visibleHigh, visibleLow } = req.body as {
        filename:    string;
        data:        string;   // base64
        mediaType:   string;
        visibleHigh?: number;
        visibleLow?:  number;
      };
      if (!filename || !data) { res.status(400).json({ error: "filename and data required" }); return; }

      const ext = filename.split(".").pop()?.toLowerCase() ?? "";
      let zones;

      if (ext === "mwml" || ext === "xml") {
        const xml = Buffer.from(data, "base64").toString("utf-8");
        console.log(`[zone-parser] parsing ${filename} (${xml.length} chars)`);
        console.log(`[zone-parser] XML preview: ${xml.slice(0, 400).replace(/\n/g, " ")}`);
        zones = parseMWML(xml);
        console.log(`[zone-parser] found ${zones.length} zones`);
        if (zones.length > 0) console.log("[zone-parser] first zone:", JSON.stringify(zones[0]));
        // Return xmlSnippet for client-side debugging when nothing is found
        if (zones.length === 0) {
          res.json({ zones, count: 0, xmlSnippet: xml.slice(0, 800) });
          return;
        }
      } else if (["png","jpg","jpeg","webp","gif"].includes(ext)) {
        const mime = ext === "jpg" ? "image/jpeg"
                   : ext === "gif" ? "image/gif"
                   : ext === "webp" ? "image/webp"
                   : "image/png";
        zones = await parseScreenshot(data, mime as any, visibleHigh, visibleLow);
      } else if (ext === "pdf") {
        zones = await parsePDF(data, visibleHigh, visibleLow);
      } else {
        res.status(400).json({ error: "Unsupported file type. Use .mwml, .xml, .png, .jpg, .webp, or .pdf" });
        return;
      }

      res.json({ zones, count: zones.length });
    } catch (err: any) {
      const msg = err?.message ?? String(err) ?? "unknown error";
      console.error("[zone-parser]", msg);
      res.status(500).json({ error: msg });
    }
  });

  // ── AI Trade Learning System ──────────────────────────────────────────────────

  const LEARNINGS_PATH = path.join(process.cwd(), "LEARNINGS.md");

  // GET /api/learnings — return full LEARNINGS.md content
  app.get("/api/learnings", (_req, res) => {
    try {
      const content = fs.existsSync(LEARNINGS_PATH)
        ? fs.readFileSync(LEARNINGS_PATH, "utf-8")
        : "";
      res.json({ content });
    } catch {
      res.json({ content: "" });
    }
  });

  // POST /api/learnings/append — append a new dated trade-lesson entry
  app.post("/api/learnings/append", (req, res) => {
    const { entry } = req.body as { entry?: string };
    if (!entry?.trim()) { res.status(400).json({ error: "entry required" }); return; }
    try {
      const existing = fs.existsSync(LEARNINGS_PATH)
        ? fs.readFileSync(LEARNINGS_PATH, "utf-8")
        : "";
      const date  = new Date().toISOString().slice(0, 10);
      const block = `\n**${date} — AI Trade Analysis**\n${entry.trim()}\n`;
      // Insert into the Session Log section if it exists, else append at end
      const updated = existing.includes("## Session Log")
        ? existing.replace("## Session Log", `## Session Log\n${block}`)
        : existing + "\n" + block;
      fs.writeFileSync(LEARNINGS_PATH, updated, "utf-8");
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/ai/teach-signal — Claude analyzes a single annotated bad trade and returns a lesson
  app.post("/api/ai/teach-signal", async (req, res) => {
    const { signal, note } = req.body as {
      signal: {
        time: number; direction: string; riskLevel: string; interval: string;
        price: number; tp1: number; sl: number; outcome: string;
        milkOk: boolean; bodyOk: boolean; secondaryVecOk: boolean;
        rth: boolean; reclassifyReason?: string;
      };
      note: string;
    };
    if (!note?.trim()) { res.status(400).json({ error: "note required" }); return; }

    const existing = fs.existsSync(LEARNINGS_PATH)
      ? fs.readFileSync(LEARNINGS_PATH, "utf-8")
      : "";

    const timeLabel = new Date(signal.time * 1000).toLocaleString("en-US", {
      timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const confirmations = [
      "Primary Vector ✓",
      signal.milkOk          ? "Milk Zone ✓"       : "Milk Zone ✗",
      signal.bodyOk          ? "Bullish Body ✓"     : "Bullish Body ✗",
      signal.secondaryVecOk  ? "Secondary TF Vec ✓" : "Secondary TF Vec ✗",
    ].join(" | ");

    const prompt = [
      `You are a professional day-trading coach for the Milk Yellow Box + Vector strategy on ES/MES futures.`,
      ``,
      `A trader just marked the following signal as a bad trade and explained why. Analyze it and generate ONE specific, actionable learning rule.`,
      ``,
      `TRADE:`,
      `- Time: ${timeLabel} ET (${signal.rth ? "RTH" : "ETH"})`,
      `- Direction: ${signal.direction} | Interval: ${signal.interval} | Risk level: ${signal.riskLevel}`,
      `- Entry: ${signal.price.toFixed(2)} | TP1: ${signal.tp1.toFixed(2)} | Stop: ${signal.sl.toFixed(2)}`,
      `- Stop distance: ${Math.abs(signal.sl - signal.price).toFixed(2)} pts`,
      `- Outcome: ${signal.outcome}`,
      `- Confirmations: ${confirmations}`,
      signal.reclassifyReason ? `- Reclassify warning: ${signal.reclassifyReason}` : "",
      ``,
      `TRADER'S NOTE: "${note.trim()}"`,
      ``,
      existing.trim()
        ? `EXISTING LEARNINGS (do NOT repeat or contradict these):\n${existing.slice(0, 2000)}\n`
        : "",
      `Based on this single trade and the trader's note, return EXACTLY ONE learning in this format:`,
      `- **[Short pattern name]**: [one sentence — what happened and why it fails]`,
      `  - Action: [concrete rule — specific enough to code into a filter, e.g. "Skip ${signal.riskLevel} signals in the first 15 min of RTH when body confirmation is absent"]`,
      `  - Confidence: low (single observation — needs more data to confirm)`,
      ``,
      `Start directly with the bullet. No preamble.`,
    ].filter(Boolean).join("\n");

    try {
      const anthropic = new Anthropic();
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      });
      const lesson = (message.content[0] as { type: string; text: string }).text?.trim() ?? "";

      // Auto-save lesson to LEARNINGS.md
      const date    = new Date().toISOString().slice(0, 10);
      const block   = `\n**${date} — Taught by User**\n${lesson}\n`;
      const updated = existing.includes("## Session Log")
        ? existing.replace("## Session Log", `## Session Log\n${block}`)
        : existing + "\n" + block;
      fs.writeFileSync(LEARNINGS_PATH, updated, "utf-8");

      res.json({ lesson });
    } catch (err: any) {
      console.error("[teach-signal]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/ai/analyze-trades — Claude AI analyzes signal performance and returns lessons
  app.post("/api/ai/analyze-trades", async (req, res) => {
    const body = req.body as {
      symbol:       string;
      interval:     string;
      riskLevel:    string;
      totalSignals: number;
      decidedCount: number;
      winRate:      number | null;
      totalPts:     number;
      bySession:    { rth: { wins: number; total: number }; eth: { wins: number; total: number } };
      byDirection:  { long: { wins: number; total: number }; short: { wins: number; total: number } };
      byConfluence: { two: { wins: number; total: number }; one: { wins: number; total: number } };
      byHour:       Array<{ label: string; wins: number; total: number }>;
      badTrades:    Array<{ time: number; conditions: string; reason: string }>;
      recentWinRate: number | null;
      existingLessons: string;
    };

    const wr  = (w: number, t: number) => t > 0 ? `${Math.round(w/t*100)}% (${w}/${t})` : "n/a";
    const lines: string[] = [
      `You are a professional day-trading coach analyzing performance data for the Milk Yellow Box + Vector strategy on ${body.symbol} ${body.interval} futures.`,
      ``,
      `STRATEGY: Signals fire when price enters a zone (FVG/Order Block/Structural) aligned with the Vector line direction. Three risk tiers: safe (body confirmation + 3 most recent zones), risky (body confirmation, up to 5 zones), riskiest (vector direction only).`,
      ``,
      `PERFORMANCE SUMMARY (${body.riskLevel} tier, ${body.symbol} ${body.interval}):`,
      `- Total signals: ${body.totalSignals} | Decided: ${body.decidedCount} | Win rate: ${body.winRate != null ? body.winRate + "%" : "n/a"} | Total pts: ${body.totalPts.toFixed(1)}`,
      `- RTH session: ${wr(body.bySession.rth.wins, body.bySession.rth.total)}`,
      `- ETH session: ${wr(body.bySession.eth.wins, body.bySession.eth.total)}`,
      `- Long signals: ${wr(body.byDirection.long.wins, body.byDirection.long.total)}`,
      `- Short signals: ${wr(body.byDirection.short.wins, body.byDirection.short.total)}`,
      `- 2/2 confluence: ${wr(body.byConfluence.two.wins, body.byConfluence.two.total)}`,
      `- 1/2 confluence: ${wr(body.byConfluence.one.wins, body.byConfluence.one.total)}`,
      `- Recent (last 20): ${body.recentWinRate != null ? body.recentWinRate + "%" : "n/a"}`,
      ``,
      `WIN RATE BY HOUR (ET):`,
      ...body.byHour.map(h => `  ${h.label}: ${wr(h.wins, h.total)}`),
      ``,
    ];

    if (body.badTrades.length > 0) {
      lines.push(`USER-MARKED BAD TRADES (${body.badTrades.length} trades the user identified as mistakes):`);
      for (const bt of body.badTrades.slice(0, 20)) {
        lines.push(`  - ${bt.conditions} | Reason: "${bt.reason || "no reason given"}"`);
      }
      lines.push(``);
    }

    if (body.existingLessons.trim()) {
      lines.push(`EXISTING LEARNINGS (do NOT repeat these):`);
      lines.push(body.existingLessons);
      lines.push(``);
    }

    lines.push(
      `Based on this data, identify the 3–5 most impactful patterns for improving trade selection. Focus only on patterns supported by the numbers above. Be specific about which conditions to avoid or require.`,
      ``,
      `Format your response as EXACTLY this structure (for writing to LEARNINGS.md):`,
      `- **[Pattern name]**: [1 sentence description of the pattern and the data behind it]`,
      `  - Action: [specific rule to apply — e.g., "Skip signals in first 30 min of RTH (9:30–10am ET)"]`,
      `  - Confidence: [high / medium / low based on sample size]`,
      ``,
      `Do not include introductory text. Start directly with the first bullet point.`,
    );

    try {
      const anthropic = new Anthropic();
      const message = await anthropic.messages.create({
        model:      "claude-opus-4-6",
        max_tokens: 1200,
        messages:   [{ role: "user", content: lines.join("\n") }],
      });
      const text = (message.content[0] as { type: string; text: string }).text ?? "";
      res.json({ lessons: text });
    } catch (err: any) {
      console.error("[ai-analyze]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── ML: signal classifier (Section 4) ────────────────────────────────────
  // All ML commands delegate to ml/signal_classifier.py via child_process.
  const { execFile } = await import("child_process");
  const ML_SCRIPT    = path.join(process.cwd(), "ml", "signal_classifier.py");
  const ZONE_SCRIPT  = path.join(process.cwd(), "ml", "zone_classifier.py");

  function runPython(script: string, args: string[]): Promise<any> {
    return new Promise((resolve) => {
      execFile("python", [script, ...args], { timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) { resolve({ error: stderr || err.message }); return; }
        try { resolve(JSON.parse(stdout.trim())); }
        catch { resolve({ error: "invalid JSON from python: " + stdout.slice(0, 200) }); }
      });
    });
  }

  // Log a new signal's features for future training
  app.post("/api/ml/log-signal", async (req, res) => {
    const result = await runPython(ML_SCRIPT, ["log", JSON.stringify(req.body)]);
    res.json(result);
  });

  // Label a signal as good (1) or bad (0)
  app.post("/api/ml/label", async (req, res) => {
    const { id, outcome } = req.body as { id: number; outcome: string };
    if (id == null || outcome == null) { res.status(400).json({ error: "id and outcome required" }); return; }
    const result = await runPython(ML_SCRIPT, ["label", String(id), outcome]);
    res.json(result);
  });

  // Get ML prediction score for a candidate signal
  app.post("/api/ml/predict", async (req, res) => {
    const result = await runPython(ML_SCRIPT, ["predict", JSON.stringify(req.body)]);
    res.json(result);
  });

  // Retrain the classifier with all labeled signals
  app.post("/api/ml/retrain", async (req, res) => {
    const result = await runPython(ML_SCRIPT, ["retrain"]);
    res.json(result);
  });

  // Stats: labeled/unlabeled counts
  app.get("/api/ml/stats", async (req, res) => {
    const result = await runPython(ML_SCRIPT, ["stats"]);
    res.json(result);
  });

  // ── ML: zone classifier (Section 6) ──────────────────────────────────────

  // Extract zones from .mwml files
  app.post("/api/ml/zones/extract", async (req, res) => {
    const dir = (req.body as any).dir ?? "C:/Users/jacks/Downloads";
    const result = await runPython(ZONE_SCRIPT, ["extract", dir]);
    res.json(result);
  });

  // Enrich zones with DB features + labels
  app.post("/api/ml/zones/features", async (req, res) => {
    const symbol = (req.body as any).symbol ?? "MES";
    const result = await runPython(ZONE_SCRIPT, ["features", symbol]);
    res.json(result);
  });

  // Train zone classifier
  app.post("/api/ml/zones/train", async (req, res) => {
    const result = await runPython(ZONE_SCRIPT, ["train"]);
    res.json(result);
  });

  // Zone classifier stats
  app.get("/api/ml/zones/stats", async (req, res) => {
    const result = await runPython(ZONE_SCRIPT, ["stats"]);
    res.json(result);
  });

  // Return ML-scored strong zones for chart overlay
  // Returns {zones: [{from_ts, to_ts, top, bottom, is_bull, score}]}
  app.get("/api/ml/zones/strong", async (req, res) => {
    const minScore = req.query.min_score ?? "0.60";
    const fromTs   = req.query.from_ts   ?? "0";
    const toTs     = req.query.to_ts     ?? "9999999999";
    const result = await runPython(ZONE_SCRIPT, ["strong", String(minScore), String(fromTs), String(toTs)]);
    res.json(result);
  });

  // ── Strategy config (exit_strategy_calibration.json) ────────────────────────
  const STRATEGY_CONFIG_PATH = path.join(process.cwd(), "exit_strategy_calibration.json");

  // GET /api/strategy/config — return current exit strategy calibration
  app.get("/api/strategy/config", (_req, res) => {
    try {
      const data = fs.existsSync(STRATEGY_CONFIG_PATH)
        ? JSON.parse(fs.readFileSync(STRATEGY_CONFIG_PATH, "utf-8"))
        : {};
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/strategy/config — save updated exit strategy parameters
  app.put("/api/strategy/config", (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object") {
        res.status(400).json({ error: "body must be a JSON object" });
        return;
      }
      fs.writeFileSync(STRATEGY_CONFIG_PATH, JSON.stringify(body, null, 2), "utf-8");
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/monte-carlo/calibrate — run exit_strategy.py calibrate for a symbol
  app.post("/api/monte-carlo/calibrate", async (req, res) => {
    const { symbol = "MES", resolution = "5" } = req.body as { symbol?: string; resolution?: string };
    const scriptPath = path.join(process.cwd(), "exit_strategy.py");
    if (!fs.existsSync(scriptPath)) {
      res.status(404).json({ error: "exit_strategy.py not found in project root" });
      return;
    }
    const result = await runPython(scriptPath, ["calibrate", "--symbol", symbol, "--resolution", resolution]);
    res.json(result);
  });

  // ── Discord Alert routes ──────────────────────────────────────────────────

  // GET /api/discord/settings — return saved webhook URL
  app.get("/api/discord/settings", async (_req, res) => {
    let webhook = memDiscordWebhook;
    try {
      const rows = await db.select().from(appSettings).where(eq(appSettings.key, "discord_webhook"));
      webhook = rows[0]?.value ?? memDiscordWebhook;
      if (webhook) memDiscordWebhook = webhook;
    } catch { /* DB unavailable — use in-memory store */ }
    res.json({ webhook });
  });

  // POST /api/discord/settings — save webhook URL
  app.post("/api/discord/settings", async (req, res) => {
    const { webhook } = req.body as { webhook?: string };
    const cleaned = (webhook ?? "").trim();
    if (!cleaned) {
      res.status(400).json({ error: "Webhook URL is required." });
      return;
    }
    memDiscordWebhook = cleaned;
    try {
      await db.insert(appSettings)
        .values({ key: "discord_webhook", value: cleaned })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: cleaned } });
    } catch { /* DB unavailable — in-memory store is the fallback */ }
    res.json({ ok: true, webhook: cleaned });
  });

  // DELETE /api/discord/settings — remove saved webhook
  app.delete("/api/discord/settings", async (_req, res) => {
    memDiscordWebhook = "";
    try {
      await db.delete(appSettings).where(eq(appSettings.key, "discord_webhook"));
    } catch { /* ignore */ }
    res.json({ ok: true });
  });

  // POST /api/discord/send — send a signal alert to Discord
  app.post("/api/discord/send", async (req, res) => {
    const webhook = memDiscordWebhook || await (async () => {
      try {
        const rows = await db.select().from(appSettings).where(eq(appSettings.key, "discord_webhook"));
        return rows[0]?.value ?? "";
      } catch { return ""; }
    })();
    if (!webhook) {
      res.status(400).json({ error: "No Discord webhook configured." });
      return;
    }
    const { direction, interval, riskLevel, price, tp1, tp2, sl, symbol } = req.body as {
      direction: string; interval: string; riskLevel: string;
      price: number; tp1: number; tp2: number; sl: number; symbol: string;
    };
    const arrow = direction === "Long" ? "▲" : "▼";
    const rl    = (riskLevel ?? "").toUpperCase();
    const content = `${arrow} **${direction.toUpperCase()} ${symbol ?? "MES"} ${interval}** | Risk: ${rl}\nEntry: \`${Number(price).toFixed(2)}\`  TP1: \`${Number(tp1).toFixed(2)}\`  TP2: \`${Number(tp2).toFixed(2)}\`  SL: \`${Number(sl).toFixed(2)}\``;
    try {
      const r = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!r.ok) { res.status(502).json({ error: `Discord returned ${r.status}` }); return; }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/discord/test — send a test message to verify the webhook works
  app.post("/api/discord/test", async (req, res) => {
    const webhook = ((req.body as any)?.webhook || memDiscordWebhook)?.trim();
    if (!webhook) { res.status(400).json({ error: "No webhook URL provided." }); return; }
    try {
      const r = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "✅ **Milks Yellow Box** — Discord alerts are working! You'll see signal notifications here when they fire." }),
      });
      if (!r.ok) { res.status(502).json({ error: `Discord returned ${r.status} — check the webhook URL is valid` }); return; }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Auto Trade routes ─────────────────────────────────────────────────────

  // GET /api/trade/status — is AutoTrader Java study connected?
  // no-store: this is polled every few seconds — an ETag/304 makes clients that gate on res.ok
  // skip the update and show a stale "disconnected" even though the study is connected.
  app.get("/api/trade/status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ connected: isOrderCommandSocketOpen() });
  });

  // GET /api/trade/current — returns the active trade (with live price auto-status) or null
  app.get("/api/trade/current", (_req, res) => {
    res.set("Cache-Control", "no-store"); // polled — never serve a 304 (see /status note)
    let trade = getCurrentTrade();
    if (trade && trade.status === 'open') {
      const livePrice = getLastTickPrice(trade.symbol);
      if (livePrice != null && livePrice > 0) {
        const isLong = trade.direction === 'Long';
        let newStatus: 'open' | 'tp1_hit' | 'tp2_hit' | 'sl_hit' = trade.status;
        if (isLong) {
          if (livePrice >= trade.tp2)      newStatus = 'tp2_hit';
          else if (livePrice >= trade.tp1) newStatus = 'tp1_hit';
          else if (livePrice <= trade.sl)  newStatus = 'sl_hit';
        } else {
          if (livePrice <= trade.tp2)      newStatus = 'tp2_hit';
          else if (livePrice <= trade.tp1) newStatus = 'tp1_hit';
          else if (livePrice >= trade.sl)  newStatus = 'sl_hit';
        }
        if (newStatus !== trade.status) {
          setCurrentTrade({ ...trade, status: newStatus });
          trade = getCurrentTrade();
        }
      }
    }
    res.json({ trade });
  });

  // POST /api/trade/current/clear — clears the active trade
  app.post("/api/trade/current/clear", (_req, res) => {
    clearCurrentTrade();
    res.json({ ok: true });
  });

  app.get("/api/mw/sync-status", (_req, res) => {
    res.json(getMWSyncStatus());
  });

  // GET /api/trade/settings — current auto-trade config
  app.get("/api/trade/settings", (_req, res) => {
    res.json(tradeSettings);
  });

  // POST /api/trade/settings — update full config (persisted in-memory until server restart)
  app.post("/api/trade/settings", (req, res) => {
    const body = req.body as Partial<typeof tradeSettings>;
    const prevEnabled = tradeSettings.enabled;
    if (typeof body.enabled === "boolean") tradeSettings.enabled = body.enabled;
    if (typeof body.contracts === "number" && body.contracts >= 1) tradeSettings.contracts = Math.floor(body.contracts);
    if (typeof body.tp1Only === "boolean") tradeSettings.tp1Only = body.tp1Only;
    if (body.direction === "both" || body.direction === "long" || body.direction === "short") tradeSettings.direction = body.direction;
    if (body.contractType === "MES" || body.contractType === "ES") tradeSettings.contractType = body.contractType;
    if (Array.isArray(body.riskLevels)) tradeSettings.riskLevels = body.riskLevels;
    if (Array.isArray(body.intervals)) tradeSettings.intervals = body.intervals;
    if (['current','tight','standard','wide'].includes(body.exitStrategy as string)) tradeSettings.exitStrategy = body.exitStrategy as typeof tradeSettings.exitStrategy;
    // Broadcast the FULL auto-trade config so the (hidden) MarketPage engine and any other
    // clients mirror it live — this is how the terminal drives which interval/tiers auto-trade
    // (the engine fires on these, not on its own stale client-side filters). Always broadcast
    // so interval/direction/tier changes propagate, not just enable/disable.
    void prevEnabled;
    broadcast({
      type: "auto_trade_state",
      enabled: tradeSettings.enabled,
      intervals: tradeSettings.intervals,
      riskLevels: tradeSettings.riskLevels,
      direction: tradeSettings.direction,
      contracts: tradeSettings.contracts,
      contractType: tradeSettings.contractType,
      tp1Only: tradeSettings.tp1Only,
    });
    res.json({ ok: true, settings: tradeSettings });
  });

  // POST /api/push-token — register an Expo push token from the mobile app
  app.post("/api/push-token", (req, res) => {
    const { token } = req.body as { token?: string; platform?: string };
    if (typeof token === "string" && token.startsWith("ExponentPushToken[")) {
      pushTokens.add(token);
      res.json({ ok: true, registered: pushTokens.size });
    } else {
      res.status(400).json({ error: "Invalid push token format" });
    }
  });

  // POST /api/trade/reset-flag — unstick tradeInProgress on the Java side
  app.post("/api/trade/reset-flag", (_req, res) => {
    const sent = broadcastOrderCommand({ type: "reset_flag" });
    if (!sent) {
      res.status(503).json({ error: "AutoTrader not connected" });
      return;
    }
    res.json({ ok: true });
  });

  // POST /api/trade/execute — place an order from a fired signal
  app.post("/api/trade/execute", (req, res) => {
    const { symbol, direction, interval, riskLevel, price, tp1, tp2, sl, contracts, tp1Only, useTrailer, trailingOffset } = req.body as {
      symbol: string; direction: string; interval: string; riskLevel: string;
      price: number; tp1: number; tp2: number; sl: number; contracts?: number; tp1Only?: boolean;
      useTrailer?: boolean; trailingOffset?: number;
    };
    if (!direction || !price || !sl) {
      res.status(400).json({ error: "Missing required fields: direction, price, sl" });
      return;
    }
    if (!tp1 || !tp2 || tp1 === price || tp2 === price) {
      res.status(400).json({ error: `Invalid TP levels: tp1=${tp1} tp2=${tp2} entry=${price} — order rejected` });
      return;
    }
    // Contract count is the user's AUTHORITATIVE setting (tradeSettings.contracts, kept in sync
    // by both the terminal AutoTrader card and the classic page). Use it directly rather than
    // whatever the firing client sent — that eliminates any "fired the wrong amount" race where
    // the engine's in-memory value lagged a just-changed setting.
    const orderContracts = Math.max(1, Math.floor(Number(tradeSettings.contracts ?? contracts ?? 1)));
    const sent = broadcastOrderCommand({
      type: "order_command",
      symbol: symbol ?? "MES",
      direction,
      interval,
      riskLevel,
      price: Number(price),
      tp1: Number(tp1),
      tp2: Number(tp2),
      sl: Number(sl),
      contracts: orderContracts,
      tp1Only: tp1Only === true,
      useTrailer: useTrailer === true,
      trailingOffset: Number(trailingOffset ?? 2),
    });
    if (!sent) {
      res.status(503).json({ error: "AutoTrader study not connected. Load it on a chart in MotiveWave." });
      return;
    }
    setCurrentTrade({
      symbol: symbol ?? "MES",
      direction: direction as 'Long' | 'Short',
      interval,
      riskLevel,
      entry: Number(price),
      tp1: Number(tp1),
      tp2: Number(tp2),
      sl: Number(sl),
      contracts: orderContracts,
      tp1Only: tp1Only === true,
      firedAt: Math.floor(Date.now() / 1000),
      status: 'open',
    });
    // Notify all clients (incl. the terminal) so they can show a visible "order placed" toast —
    // the engine's own toast renders in the hidden MarketPage and is never seen on the terminal.
    broadcast({
      type: "auto_trade_fired",
      symbol: symbol ?? "MES",
      direction,
      interval,
      price: Number(price),
      contracts: orderContracts,
    });
    res.json({ ok: true });
  });

  // Auto-start discord reader from saved settings
  try {
    const [tokenRow] = await db.select().from(appSettings).where(eq(appSettings.key, "discord_reader_token"));
    const [guildRow] = await db.select().from(appSettings).where(eq(appSettings.key, "discord_reader_guild"));
    if (tokenRow?.value && guildRow?.value) {
      startDiscordReader(tokenRow.value, guildRow.value).catch((e) =>
        console.warn("[discord-reader] Auto-start failed:", e.message)
      );
      console.log("[discord-reader] Auto-started from saved settings");
    }
  } catch { /* non-fatal */ }

  // ── Discord Reader routes ─────────────────────────────────────────────────

  // GET /api/discord-reader/settings — status + channel list (token never sent to browser)
  app.get("/api/discord-reader/settings", (_req, res) => {
    const st = getDiscordReaderStatus();
    res.json({ running: st.running, guildId: st.guildId, guildName: st.guildName, channels: st.channels });
  });

  // POST /api/discord-reader/settings — save token + guild ID, (re)start reader
  app.post("/api/discord-reader/settings", async (req, res) => {
    const { token: t, guildId } = req.body as { token?: string; guildId?: string };
    if (!guildId?.trim()) { res.status(400).json({ error: "Server (guild) ID is required." }); return; }
    // Strip surrounding quotes users sometimes accidentally paste with the token
    const cleanToken = t?.trim().replace(/^["']+|["']+$/g, "");
    const cleanGuild = guildId.trim().replace(/^["']+|["']+$/g, "");
    try {
      await db.insert(appSettings).values({ key: "discord_reader_guild", value: cleanGuild })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: cleanGuild } });
      if (cleanToken) {
        await db.insert(appSettings).values({ key: "discord_reader_token", value: cleanToken })
          .onConflictDoUpdate({ target: appSettings.key, set: { value: cleanToken } });
      }
      const [tokenRow] = await db.select().from(appSettings).where(eq(appSettings.key, "discord_reader_token"));
      const activeToken = cleanToken || tokenRow?.value;
      if (!activeToken) { res.status(400).json({ error: "No token provided and none saved." }); return; }
      await startDiscordReader(activeToken, cleanGuild);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/discord-reader/settings — clear config, stop reader
  app.delete("/api/discord-reader/settings", async (_req, res) => {
    stopDiscordReader();
    try {
      await db.delete(appSettings).where(eq(appSettings.key, "discord_reader_token"));
      await db.delete(appSettings).where(eq(appSettings.key, "discord_reader_guild"));
    } catch {}
    res.json({ ok: true });
  });

  // GET /api/discord-reader/messages — paginated message history (newest first)
  // ?limit=100&before=<postedAt unix>&channel_id=<id>
  app.get("/api/discord-reader/messages", async (req, res) => {
    const limit     = Math.min(Number(req.query.limit) || 100, 500);
    const beforeTs  = req.query.before     ? Number(req.query.before) : undefined;
    const channelId = req.query.channel_id as string | undefined;
    try {
      const conditions = [];
      if (beforeTs)  conditions.push(lte(discordMessages.postedAt, beforeTs - 1));
      if (channelId) conditions.push(eq(discordMessages.channelId, channelId));
      const msgs = await db.select().from(discordMessages)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(discordMessages.postedAt))
        .limit(limit);
      res.json({ messages: msgs, hasMore: msgs.length === limit });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/discord-reader/test — verify token + guild ID work
  app.post("/api/discord-reader/test", async (req, res) => {
    const { token: t, guildId } = req.body as { token?: string; guildId?: string };
    if (!guildId?.trim()) { res.status(400).json({ error: "guildId required" }); return; }
    const cleanToken = t?.trim().replace(/^["']+|["']+$/g, "");
    const cleanGuild = guildId.trim().replace(/^["']+|["']+$/g, "");
    try {
      const [tokenRow] = await db.select().from(appSettings).where(eq(appSettings.key, "discord_reader_token"));
      const activeToken = cleanToken || tokenRow?.value;
      if (!activeToken) { res.status(400).json({ error: "No token available — paste one in settings." }); return; }
      const r = await fetch(`https://discord.com/api/v9/guilds/${cleanGuild}`, {
        headers: { Authorization: activeToken },
      });
      if (!r.ok) {
        res.status(502).json({ error: `Discord returned ${r.status} — check your token and server ID` });
        return;
      }
      const data = await r.json();
      res.json({ ok: true, guildName: data.name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Discord signal + learner routes ──────────────────────────────────────

  // GET /api/discord-reader/signals — list parsed signals (newest first, optional ?limit=)
  app.get("/api/discord-reader/signals", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    try {
      const rows = await db.select().from(discordSignals)
        .orderBy(desc(discordSignals.createdAt))
        .limit(limit);
      res.json({ signals: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/discord-reader/signals/:id/outcome — record result of a signal
  // body: { outcome: "tp1_hit" | "tp2_hit" | "tp3_hit" | "sl_hit" | "manual_close" }
  app.post("/api/discord-reader/signals/:id/outcome", async (req, res) => {
    const id      = Number(req.params.id);
    const outcome = (req.body as any)?.outcome as string | undefined;
    const VALID   = ["tp1_hit","tp2_hit","tp3_hit","sl_hit","manual_close"];
    if (!outcome || !VALID.includes(outcome)) {
      res.status(400).json({ error: `outcome must be one of: ${VALID.join(", ")}` });
      return;
    }
    try {
      db.$client.prepare(`UPDATE discord_signals SET outcome=? WHERE id=?`).run(outcome, id);
      await learner.onOutcome(); // recompute stats
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/discord-reader/stats — author and channel win-rate summary
  app.get("/api/discord-reader/stats", (_req, res) => {
    res.json(learner.summary());
  });

  // POST /api/discord-reader/auto-trade — enable / disable auto-execution
  // body: { enabled: boolean }
  app.post("/api/discord-reader/auto-trade", (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled (boolean) required" });
      return;
    }
    tradeSettings.enabled = enabled;
    console.log(`[discord-reader] auto-trade ${enabled ? "ENABLED" : "DISABLED"}`);
    res.json({ ok: true, autoTrade: enabled });
  });

  // GET /api/discord-reader/auto-trade — current status
  app.get("/api/discord-reader/auto-trade", (_req, res) => {
    res.json({ autoTrade: tradeSettings.enabled });
  });

  // GET /api/discord-reader/message-count — total messages + per-channel breakdown
  app.get("/api/discord-reader/message-count", (_req, res) => {
    try {
      const row = db.$client.prepare(`SELECT COUNT(*) as n FROM discord_messages`).get() as any;
      res.json({ total: row.n });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/discord-reader/full-history — fetch ALL historical messages from every channel
  app.post("/api/discord-reader/full-history", async (_req, res) => {
    // Respond immediately; run in background
    res.json({ ok: true, message: "Deep backread started in background" });
    deepBackReadAll().catch(e => console.error("[discord-reader] deep backread error:", e.message));
  });

  // POST /api/discord-reader/reparse-zones — re-parse zones from all stored messages
  app.post("/api/discord-reader/reparse-zones", (_req, res) => {
    try {
      const n = reparseAllZones();
      console.log(`[discord-reader] zone re-parse: ${n} zones written`);
      res.json({ ok: true, zonesWritten: n });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/discord-zones — zone levels extracted from Discord messages
  app.get("/api/discord-zones", (req, res) => {
    const fromTs = req.query.from_ts ? Number(req.query.from_ts) : 0;
    const toTs   = req.query.to_ts   ? Number(req.query.to_ts)   : 9_999_999_999;
    const symbol = (req.query.symbol as string | undefined)?.toUpperCase() ?? "MES";
    try {
      const rows = db.$client.prepare(`
        SELECT id, message_id, channel_name, author_name, posted_at,
               zone_type, label_raw, top, bottom, is_bull, symbol, raw
        FROM discord_zones
        WHERE symbol = ? AND posted_at >= ? AND posted_at <= ?
        ORDER BY posted_at ASC
      `).all(symbol, fromTs, toTs) as any[];
      res.json({ zones: rows.map(z => ({ ...z, is_bull: z.is_bull === 1 })) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/discord-zones/paste — parse pasted Milk pre-market text into zones for today
  app.post("/api/discord-zones/paste", (req, res) => {
    const { text, symbol, channel } = req.body as { text?: string; symbol?: string; channel?: string };
    if (!text?.trim()) { res.status(400).json({ error: "text is required" }); return; }
    const sym      = (symbol ?? "MES").toUpperCase();
    const postedAt = Math.floor(Date.now() / 1000);
    const msgId    = `paste_${postedAt}`;
    const channelName = channel ?? "manual-paste";
    try {
      const zones = parseZonesFromMessage({
        messageId:   msgId,
        text:        text.trim(),
        authorName:  "manual-paste",
        channelName,
        postedAt,
      }).map(z => ({ ...z, symbol: sym }));
      const stmt = db.$client.prepare(`
        INSERT OR REPLACE INTO discord_zones
          (message_id, channel_name, author_name, posted_at, zone_type, label_raw, top, bottom, is_bull, symbol, raw)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const z of zones) {
        stmt.run(z.messageId, z.channelName, z.authorName, z.postedAt,
          z.zoneType, z.labelRaw, z.top, z.bottom, z.isBull ? 1 : 0, z.symbol, z.raw);
      }
      res.json({ ok: true, zonesFound: zones.length, zones });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // DELETE /api/discord-zones/paste — clear all manual-paste zones for today
  app.delete("/api/discord-zones/paste", (req, res) => {
    const sym = ((req.query.symbol as string | undefined) ?? "MES").toUpperCase();
    const todayStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
    try {
      const r = db.$client.prepare(`
        DELETE FROM discord_zones
        WHERE symbol = ? AND author_name = 'manual-paste' AND posted_at >= ?
      `).run(sym, todayStart);
      res.json({ ok: true, deleted: (r as any).changes ?? 0 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Tables are created in db.ts on startup — no need to recreate here

  // Strip contract codes so "MES1!", "MESM6", "MES" all normalize to "MES".
  // Removes non-letter chars, then strips a trailing month-code letter (H/M/U/Z).
  function normalizeSignalSymbol(raw: string): string {
    return raw.replace(/[^A-Za-z]/g, '').replace(/[HMUZ]$/i, '').toUpperCase();
  }

  // GET /api/signals/history/:symbol/:interval — load persisted signal locks
  app.get("/api/signals/history/:symbol/:interval", async (req, res) => {
    const sym = normalizeSignalSymbol(req.params.symbol);
    const iv  = req.params.interval;
    try {
      // Never return FUTURE-dated rows — corrupt signals stamped days ahead (e.g. Jun 17 when
      // it's the 9th) otherwise pollute every client. Cap at now + 1h (clock-skew tolerance).
      const maxTs = Math.floor(Date.now() / 1000) + 3600;
      const rows = await db.select().from(signalHistory)
        .where(and(
          eq(signalHistory.symbol, sym),
          eq(signalHistory.interval, iv),
          lte(signalHistory.timestamp, maxTs),
        ));
      res.json({ signals: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/signals/history — bulk upsert signal records
  app.post("/api/signals/history", async (req, res) => {
    const { signals } = req.body as {
      signals: Array<{
        symbol: string; interval: string; timestamp: number; direction: string;
        riskLevel: string; signalType?: string; entry: number;
        tp1: number; tp2: number; sl: number; outcome?: string; patternBars?: number;
        footprintReading?: string; // FOOTPRINT-STRATEGY: JSON FootprintReading
        confirmations?: string; // PARITY: JSON {milkOk, milkPts, vecOk, secondaryVecOk}
      }>;
    };
    if (!Array.isArray(signals) || !signals.length) {
      res.json({ ok: true, inserted: 0 });
      return;
    }
    try {
      const values = signals.map(s => ({
        symbol:           normalizeSignalSymbol(s.symbol),
        interval:         s.interval,
        timestamp:        s.timestamp,
        direction:        s.direction,
        riskLevel:        s.riskLevel,
        signalType:       s.signalType ?? null,
        entry:            s.entry,
        tp1:              s.tp1,
        tp2:              s.tp2,
        sl:               s.sl,
        outcome:          s.outcome ?? null,
        patternBars:      s.patternBars ?? null,
        footprintReading: s.footprintReading ?? null, // FOOTPRINT-STRATEGY:
        confirmations:    s.confirmations ?? null, // PARITY: confirmation breakdown for iPhone chips
        updatedAt:        new Date().toISOString(),
      }));
      await db.insert(signalHistory).values(values).onConflictDoUpdate({
        target: [signalHistory.symbol, signalHistory.interval, signalHistory.timestamp, signalHistory.direction],
        set: {
          riskLevel:        sql`excluded.risk_level`,
          outcome:          sql`excluded.outcome`,
          footprintReading: sql`excluded.footprint_reading`, // FOOTPRINT-STRATEGY:
          confirmations:    sql`excluded.confirmations`, // PARITY:
          updatedAt:        new Date().toISOString(),
        },
      });
      // Push signal_new to all connected clients so iPhone refetches immediately
      // instead of waiting for the next bar_complete (up to 15 minutes on a 15m chart).
      const seen = new Set<string>();
      for (const v of values) {
        const key = `${v.symbol}|${v.interval}`;
        if (!seen.has(key)) { seen.add(key); broadcast({ type: "signal_new", symbol: v.symbol, interval: v.interval }); }
      }
      res.json({ ok: true, inserted: values.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Live Edits — Claude-powered in-app code editor ───────────────────────
  // POST /api/live-edit  body: { prompt: string, files?: string[] }
  // Reads source files, asks Claude to return search/replace edits, applies them to disk.
  const EDITABLE_DIRS = [
    path.join(process.cwd(), "client", "src"),
    path.join(process.cwd(), "server"),
    path.join(process.cwd(), "shared"),
  ];

  app.post("/api/live-edit", async (req, res) => {
    try {
      const { prompt: userPrompt, files: reqFiles } = req.body ?? {} as { prompt?: string; files?: string[] };
      if (!userPrompt?.trim()) { res.status(400).json({ error: "prompt required" }); return; }

      const editableDirs = EDITABLE_DIRS.map(d => path.resolve(d));

      const defaultFiles = ["shared/schema.ts"];
      const filesToRead = (reqFiles && reqFiles.length ? reqFiles : defaultFiles)
        .filter((f: string) => {
          const abs = path.resolve(process.cwd(), f);
          return editableDirs.some(d => abs.startsWith(d)) && fs.existsSync(abs);
        });

      const fileContents: string[] = [];
      for (const f of filesToRead) {
        // Send the FULL file — no truncation. Claude needs the exact text to generate matching search strings.
        const raw = fs.readFileSync(path.resolve(process.cwd(), f), "utf-8");
        fileContents.push(`=== FILE: ${f} ===\n${raw}`);
      }

      const systemPrompt = `You are a code editor for a React/TypeScript/Express trading app.
Return ONLY a raw JSON object — absolutely no markdown, no code fences, no prose before or after.

{
  "edits": [
    { "file": "relative/path/to/file", "search": "exact verbatim substring", "replace": "new content" }
  ],
  "explanation": "plain English: what the app now does differently (not technical, for a non-developer)"
}

Critical rules:
- "search" must be a verbatim substring that exists in the file EXACTLY as shown — copy it character for character
- Keep search strings 20-100 chars, long enough to be unique in the file
- Multiple changes = multiple edit objects
- Deletion = empty string for replace
- Never wrap the JSON in code fences or add any text outside the JSON object
- NEVER modify the DrawingTool type definition — it is a shared contract used across many files and changing it breaks the app`;

      const anthropic = new Anthropic();
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: fileContents.length
            ? `Source files:\n\n${fileContents.join("\n\n")}\n\n---\nEdit request: ${userPrompt.trim()}`
            : `Edit request: ${userPrompt.trim()}\n\nNo file context was provided. Infer the correct file path from the edit description.`,
        }],
      });

      const rawText = (message.content.find((b: any) => b.type === "text") as any)?.text ?? "";

      // JSON extraction — string-aware depth counter so {} inside Claude's search strings
      // (which contain real code) never confuse the parser
      function extractJsonObject(text: string): string | null {
        // 1. Direct parse — fastest path when Claude returns clean JSON
        try { JSON.parse(text.trim()); return text.trim(); } catch {}
        // 2. Strip ```json … ``` fences
        const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
        try { JSON.parse(stripped); return stripped; } catch {}
        // 3. String-aware brace scanner: tracks whether we're inside a JSON string so that
        //    { and } characters inside "search" values don't throw off the depth count
        for (let i = 0; i < text.length; i++) {
          if (text[i] !== "{") continue;
          let depth = 0, inStr = false, esc = false;
          for (let j = i; j < text.length; j++) {
            const c = text[j];
            if (esc)          { esc = false; continue; }
            if (c === "\\" && inStr) { esc = true;  continue; }
            if (c === '"')    { inStr = !inStr; continue; }
            if (inStr)        continue;
            if (c === "{")    depth++;
            else if (c === "}") {
              depth--;
              if (depth === 0) {
                const candidate = text.slice(i, j + 1);
                try { JSON.parse(candidate); return candidate; } catch {}
                break; // this start position didn't work; try next {
              }
            }
          }
        }
        return null;
      }

      const jsonStr = extractJsonObject(rawText);
      if (!jsonStr) {
        res.status(500).json({ error: `Claude didn't return valid JSON. Response was: "${rawText.slice(0, 300)}"` });
        return;
      }

      let parsed: { edits: Array<{ file: string; search: string; replace: string }>; explanation: string };
      try { parsed = JSON.parse(jsonStr); }
      catch (e: any) {
        res.status(500).json({ error: `Failed to parse response: ${(e as Error).message}` });
        return;
      }

      const applied: string[] = [];
      const errors:  string[] = [];

      for (const edit of (parsed.edits ?? [])) {
        const abs = path.resolve(process.cwd(), edit.file);
        if (!editableDirs.some(d => abs.startsWith(d))) {
          errors.push(`Blocked: "${edit.file}" is outside allowed directories`); continue;
        }
        if (!fs.existsSync(abs)) { errors.push(`File not found: ${edit.file}`); continue; }
        // Normalize line endings so Windows CRLF files match LF search strings from Claude
        const content = fs.readFileSync(abs, "utf-8").replace(/\r\n/g, "\n");
        const search  = edit.search.replace(/\r\n/g, "\n");
        const replace = edit.replace.replace(/\r\n/g, "\n");
        if (!content.includes(search)) {
          const preview = search.slice(0, 60).replace(/\n/g, "↵");
          errors.push(`Text not found in ${edit.file}: "${preview}…" — rephrase your request or be more specific`); continue;
        }
        const updated = content.replace(search, replace);
        // Guard: never silently break the DrawingTool type contract
        if (edit.file.includes("CandlestickChart")) {
          const dtLine = 'export type DrawingTool =';
          const origDt = content.split("\n").find(l => l.includes(dtLine)) ?? "";
          const newDt  = updated.split("\n").find(l => l.includes(dtLine)) ?? "";
          const required = ['"cursor"', '"pan"', '"detail"'];
          const missing = required.filter(v => origDt.includes(v) && !newDt.includes(v));
          if (missing.length) {
            errors.push(`Blocked: edit removes ${missing.join(", ")} from DrawingTool — those values are used throughout the app`); continue;
          }
        }
        fs.writeFileSync(abs, updated, "utf-8");
        applied.push(edit.file);
      }

      res.json({ ok: true, explanation: parsed.explanation ?? "Done", applied, errors: errors.length ? errors : undefined });

    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // ── Strategy Guard routes ─────────────────────────────────────────────────
  app.get("/api/strategies", (_req, res) => {
    const { strategyGuard } = require("./strategy-guard");
    res.json({ strategies: strategyGuard.getAll(), status: strategyGuard.getStatus() });
  });

  app.post("/api/strategies/check-mention", (req, res) => {
    const { detectStrategyMention } = require("./strategy-aware-middleware");
    const { prompt } = req.body ?? {};
    if (!prompt) return res.json({ triggered: false, matchedStrategies: [] });
    res.json(detectStrategyMention(String(prompt)));
  });

  app.post("/api/strategies/:id/update", (req, res) => {
    const { strategyGuard } = require("./strategy-guard");
    const { id } = req.params;
    const { content } = req.body ?? {};
    if (!content) return res.status(400).json({ ok: false, error: "Missing content" });
    const result = strategyGuard.authorizedUpdate(id, content);
    res.json(result);
  });

  // ── Signal label routes (ML training data from user feedback) ────────────────
  // POST /api/signals/label — save user feedback on a single signal
  app.post("/api/signals/label", (req, res) => {
    const { key, time, direction, riskLevel, outcome, isBad, reason, note } = req.body as {
      key: string; time: number; direction: string; riskLevel: string;
      outcome?: string; isBad?: boolean; reason?: string; note?: string;
    };
    if (!key || !time || !direction || !riskLevel) {
      res.status(400).json({ error: "Missing required fields" }); return;
    }
    try {
      db.$client.prepare(`
        INSERT OR REPLACE INTO signal_labels
          (signal_key, signal_time, direction, risk_level, outcome, is_bad, reason, note, labeled_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'))
      `).run(key, time, direction, riskLevel, outcome ?? 'Open', isBad ? 1 : 0, reason ?? null, note ?? null);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/signals/labels — return all saved labels (for ML training)
  app.get("/api/signals/labels", (_req, res) => {
    try {
      const rows = db.$client.prepare(
        `SELECT * FROM signal_labels ORDER BY labeled_at DESC`
      ).all();
      res.json({ labels: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/signals/win-rates — data-driven win rates by (riskLevel, direction) from labeled signals
  app.get("/api/signals/win-rates", (_req, res) => {
    try {
      const rows = db.$client.prepare(`
        SELECT risk_level, direction,
               COUNT(*) as total,
               SUM(CASE WHEN outcome IN ('TP1','TP2','Win') AND is_bad=0 THEN 1 ELSE 0 END) as wins
        FROM signal_labels
        WHERE outcome != 'Open'
        GROUP BY risk_level, direction
      `).all() as { risk_level: string; direction: string; total: number; wins: number }[];
      const winRates: Record<string, { winRate: number; sampleCount: number }> = {};
      for (const r of rows) {
        winRates[`${r.risk_level}:${r.direction}`] = {
          winRate: r.total > 0 ? r.wins / r.total : 0,
          sampleCount: r.total,
        };
      }
      res.json({ winRates });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Learning engine routes ─────────────────────────────────────────────────
  app.post("/api/learn/backfill", async (_req, res) => {
    try {
      const { backfillSignals } = await import("./learn-engine");
      const result = await backfillSignals();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  app.post("/api/learn/run", async (_req, res) => {
    try {
      const { runLearningSession } = await import("./learn-engine");
      const log = await runLearningSession();
      res.json(log);
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  app.get("/api/learn/last", async (_req, res) => {
    try {
      const { learningSessions } = await import("@shared/schema");
      const row = db.select().from(learningSessions).orderBy(desc(learningSessions.id)).limit(1).get() as any;
      if (!row) return res.json(null);
      res.json({ ...row, summary: row.summary ? JSON.parse(row.summary) : null });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  app.get("/api/learn/history", async (_req, res) => {
    try {
      const { learningSessions } = await import("@shared/schema");
      const rows = db.select().from(learningSessions).orderBy(desc(learningSessions.id)).limit(20).all() as any[];
      res.json(rows.map((r: any) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null })));
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // ── Footprint API ─────────────────────────────────────────────────────────── // FOOTPRINT-STRATEGY:
  app.get("/api/footprint/history/:symbol/:interval", async (req, res) => { // FOOTPRINT-STRATEGY:
    try { // FOOTPRINT-STRATEGY:
      const { getAllCandles, getActivePreview, loadPersistedCandles } = await import("./footprint-engine"); // FOOTPRINT-STRATEGY:
      const sym = req.params.symbol.toUpperCase(); // FOOTPRINT-STRATEGY:
      const iv  = req.params.interval; // FOOTPRINT-STRATEGY:
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? ""), 10) || 600, 1), 5000); // FOOTPRINT-STRATEGY:
      // Merge DB-persisted history (older sessions, survives restarts + the 50-cap) with the live
      // in-memory tail (recent candles) and the current forming preview. In-memory wins on time
      // collisions because it's fresher; dedupe by time, then sort ascending. // FOOTPRINT-STRATEGY:
      const byTime = new Map<number, any>(); // FOOTPRINT-STRATEGY:
      for (const c of loadPersistedCandles(sym, iv, limit)) byTime.set(c.time, c); // FOOTPRINT-STRATEGY:
      for (const c of getAllCandles(sym, iv)) byTime.set(c.time, c); // FOOTPRINT-STRATEGY:
      const preview = getActivePreview(sym, iv); // FOOTPRINT-STRATEGY: current in-progress bucket
      if (preview) byTime.set(preview.time, preview); // FOOTPRINT-STRATEGY:
      const result = [...byTime.values()].sort((a, b) => a.time - b.time); // FOOTPRINT-STRATEGY:
      res.json(result); // FOOTPRINT-STRATEGY:
    } catch (err: any) { // FOOTPRINT-STRATEGY:
      res.status(500).json({ error: err.message }); // FOOTPRINT-STRATEGY:
    } // FOOTPRINT-STRATEGY:
  }); // FOOTPRINT-STRATEGY:

  app.get("/api/footprint/latest/:symbol/:interval", async (req, res) => { // FOOTPRINT-STRATEGY:
    try { // FOOTPRINT-STRATEGY:
      const { getLatestCandle } = await import("./footprint-engine"); // FOOTPRINT-STRATEGY:
      const candle = getLatestCandle(req.params.symbol.toUpperCase(), req.params.interval); // FOOTPRINT-STRATEGY:
      res.json(candle ?? null); // FOOTPRINT-STRATEGY:
    } catch (err: any) { // FOOTPRINT-STRATEGY:
      res.status(500).json({ error: err.message }); // FOOTPRINT-STRATEGY:
    } // FOOTPRINT-STRATEGY:
  }); // FOOTPRINT-STRATEGY:

  app.get("/api/footprint/candle/:symbol/:interval/:timestamp", async (req, res) => { // FOOTPRINT-STRATEGY:
    try { // FOOTPRINT-STRATEGY:
      const { getAllCandles } = await import("./footprint-engine"); // FOOTPRINT-STRATEGY:
      const ts = parseInt(req.params.timestamp, 10); // FOOTPRINT-STRATEGY:
      const candles = getAllCandles(req.params.symbol.toUpperCase(), req.params.interval); // FOOTPRINT-STRATEGY:
      const candle = candles.find(c => c.time === ts) ?? null; // FOOTPRINT-STRATEGY:
      res.json(candle); // FOOTPRINT-STRATEGY:
    } catch (err: any) { // FOOTPRINT-STRATEGY:
      res.status(500).json({ error: err.message }); // FOOTPRINT-STRATEGY:
    } // FOOTPRINT-STRATEGY:
  }); // FOOTPRINT-STRATEGY:

  // ── Strategy Proposals API ─────────────────────────────────────────────── // SELF-LEARNING:
  app.get("/api/learn/proposals", async (_req, res) => { // SELF-LEARNING:
    try { // SELF-LEARNING:
      const { strategyProposals } = await import("@shared/schema"); // SELF-LEARNING:
      const rows = db.select().from(strategyProposals).orderBy(desc(strategyProposals.id)).all(); // SELF-LEARNING:
      res.json(rows); // SELF-LEARNING:
    } catch (err: any) { res.status(500).json({ error: err.message }); } // SELF-LEARNING:
  }); // SELF-LEARNING:

  app.post("/api/learn/proposals/generate", async (_req, res) => { // SELF-LEARNING:
    try { // SELF-LEARNING:
      const { runLearningSession, generateStrategyProposals } = await import("./learn-engine"); // SELF-LEARNING:
      const { strategyProposals: spTable } = await import("@shared/schema"); // SELF-LEARNING:
      const log = await runLearningSession(); // SELF-LEARNING:
      const proposals = generateStrategyProposals(log); // SELF-LEARNING:
      for (const p of proposals) { // SELF-LEARNING:
        db.insert(spTable).values({ // SELF-LEARNING:
          strategyId: p.strategyId, ruleKey: p.ruleKey, // SELF-LEARNING:
          proposedChange: p.proposedChange, rationale: p.rationale, // SELF-LEARNING:
          samplesUsed: p.samplesUsed, confidence: p.confidence, // SELF-LEARNING:
          currentValue: p.currentValue, proposedValue: p.proposedValue, // SELF-LEARNING:
          status: "pending", // SELF-LEARNING:
        }).onConflictDoNothing().run(); // SELF-LEARNING:
      } // SELF-LEARNING:
      res.json({ generated: proposals.length, proposals }); // SELF-LEARNING:
    } catch (err: any) { res.status(500).json({ error: err.message }); } // SELF-LEARNING:
  }); // SELF-LEARNING:

  app.post("/api/learn/proposals/:id/approve", async (req, res) => { // SELF-LEARNING:
    try { // SELF-LEARNING:
      const id = parseInt(req.params.id, 10); // SELF-LEARNING:
      const { strategyProposals: spTable } = await import("@shared/schema"); // SELF-LEARNING:
      const row = db.select().from(spTable).where(eq(spTable.id, id)).get() as any; // SELF-LEARNING:
      if (!row) { res.status(404).json({ error: "Not found" }); return; } // SELF-LEARNING:
      // Wire to strategyGuard.authorizedUpdate if strategy JSON exists
      try { // SELF-LEARNING:
        const { strategyGuard: guard } = await import("./strategy-guard"); // SELF-LEARNING:
        const stratPath = `strategies/${row.strategyId}/strategy.json`; // SELF-LEARNING:
        const fs = await import("fs"); // SELF-LEARNING:
        if (fs.existsSync(stratPath)) { // SELF-LEARNING:
          const current = JSON.parse(fs.readFileSync(stratPath, "utf8")); // SELF-LEARNING:
          current[row.ruleKey] = row.proposedValue; // SELF-LEARNING:
          current.updatedAt = new Date().toISOString(); // SELF-LEARNING:
          guard.authorizedUpdate(row.strategyId, current); // SELF-LEARNING:
        } // SELF-LEARNING:
      } catch {} // SELF-LEARNING: guard update best-effort — proposal still approved even if file write fails
      db.$client.prepare(`UPDATE strategy_proposals SET status='approved', reviewed_at=datetime('now') WHERE id=?`).run(id); // SELF-LEARNING:
      res.json({ ok: true }); // SELF-LEARNING:
    } catch (err: any) { res.status(500).json({ error: err.message }); } // SELF-LEARNING:
  }); // SELF-LEARNING:

  app.post("/api/learn/proposals/:id/reject", async (req, res) => { // SELF-LEARNING:
    try { // SELF-LEARNING:
      const id = parseInt(req.params.id, 10); // SELF-LEARNING:
      db.$client.prepare(`UPDATE strategy_proposals SET status='rejected', reviewed_at=datetime('now') WHERE id=?`).run(id); // SELF-LEARNING:
      res.json({ ok: true }); // SELF-LEARNING:
    } catch (err: any) { res.status(500).json({ error: err.message }); } // SELF-LEARNING:
  }); // SELF-LEARNING:

  // POST /api/learn/adjustments — accept backtest signal adjustments and store notes for learning
  app.post("/api/learn/adjustments", async (req, res) => {
    try {
      const { adjustments } = req.body as { adjustments: Array<{ time: number; direction: string; price: number; tier: string; outcome: string; note: string; noteType: string; symbol: string; interval: string }> };
      if (!Array.isArray(adjustments) || adjustments.length === 0) {
        res.json({ ok: true, stored: 0 });
        return;
      }
      // Append to LEARNINGS.md so the learn engine picks up the patterns
      const fs = await import("fs");
      const path = await import("path");
      const learningsPath = path.join(process.cwd(), "LEARNINGS.md");
      const today = new Date().toISOString().slice(0, 10);
      const lines: string[] = [`\n## [${today}] — Backtest Adjustments (${adjustments.length} signals)\n`];
      // Group by noteType
      const misses  = adjustments.filter(a => a.noteType === "miss");
      const caution = adjustments.filter(a => a.noteType === "caution");
      if (misses.length) {
        lines.push(`**Missed / Stopped Out (${misses.length})**`);
        const counts: Record<string, number> = {};
        misses.forEach(a => { counts[a.note] = (counts[a.note] ?? 0) + 1; });
        Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([note, cnt]) => {
          lines.push(`- ${note} (×${cnt})`);
        });
      }
      if (caution.length) {
        lines.push(`**Caution / Partial (${caution.length})**`);
        const counts: Record<string, number> = {};
        caution.forEach(a => { counts[a.note] = (counts[a.note] ?? 0) + 1; });
        Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([note, cnt]) => {
          lines.push(`- ${note} (×${cnt})`);
        });
      }
      lines.push("");
      const existing = fs.existsSync(learningsPath) ? fs.readFileSync(learningsPath, "utf8") : "";
      fs.writeFileSync(learningsPath, existing + lines.join("\n"), "utf8");
      res.json({ ok: true, stored: adjustments.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Trade Journal ───────────────────────────────────────────────────────────
  app.get("/api/journal", (_req, res) => {
    const entries = db.select().from(tradeJournal).orderBy(desc(tradeJournal.timestamp)).all();
    res.json(entries);
  });

  app.get("/api/journal/stats", (_req, res) => {
    const entries = db.select().from(tradeJournal).orderBy(asc(tradeJournal.timestamp)).all() as any[];
    const closed  = entries.filter((e: any) => e.outcome && e.outcome !== "open");
    const wins    = closed.filter((e: any) => (e.outcome as string).startsWith("win"));
    const losses  = closed.filter((e: any) => e.outcome === "loss");
    const byEmotion: Record<string, { count: number; wins: number; losses: number }> = {};
    for (const e of closed) {
      const em = (e.emotion_state ?? "calm") as string;
      if (!byEmotion[em]) byEmotion[em] = { count: 0, wins: 0, losses: 0 };
      byEmotion[em].count++;
      if ((e.outcome as string).startsWith("win")) byEmotion[em].wins++;
      if (e.outcome === "loss") byEmotion[em].losses++;
    }
    const byPlan: Record<string, { count: number; wins: number }> = {};
    for (const e of closed) {
      const k = e.followed_plan ? "followed" : "deviated";
      if (!byPlan[k]) byPlan[k] = { count: 0, wins: 0 };
      byPlan[k].count++;
      if ((e.outcome as string).startsWith("win")) byPlan[k].wins++;
    }
    const totalPnl = entries.reduce((acc: number, e: any) => acc + (e.pnl_dollars ?? 0), 0);
    res.json({
      total:           entries.length,
      closed:          closed.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         closed.length > 0 ? wins.length / closed.length : 0,
      totalPnlDollars: totalPnl,
      byEmotion,
      byPlan,
    });
  });

  app.post("/api/journal", (req, res) => {
    const { timestamp, symbol, direction, signalId, entryPrice, exitPrice, outcome, pnlPts, pnlDollars, riskLevel, followedPlan, emotionState, setupType, notes, errorMade } = req.body;
    if (!timestamp || !direction || entryPrice == null) {
      res.status(400).json({ error: "timestamp, direction, entryPrice are required" }); return;
    }
    const entry = db.insert(tradeJournal).values({
      timestamp:    parseInt(String(timestamp)),
      symbol:       symbol ?? "MES",
      direction,
      signalId:     signalId != null ? parseInt(String(signalId)) : null,
      entryPrice:   parseFloat(String(entryPrice)),
      exitPrice:    exitPrice != null ? parseFloat(String(exitPrice)) : null,
      outcome:      outcome ?? null,
      pnlPts:       pnlPts != null ? parseFloat(String(pnlPts)) : null,
      pnlDollars:   pnlDollars != null ? parseFloat(String(pnlDollars)) : null,
      riskLevel:    riskLevel ?? "safe",
      followedPlan: followedPlan ? 1 : 0,
      emotionState: emotionState ?? "calm",
      setupType:    setupType ?? null,
      notes:        notes ?? null,
      errorMade:    errorMade ?? null,
    }).returning().get();
    res.json(entry);
  });

  app.put("/api/journal/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { exitPrice, outcome, pnlPts, pnlDollars, followedPlan, emotionState, notes, errorMade, setupType } = req.body;
    const patch: Record<string, any> = {};
    if (exitPrice   !== undefined) patch.exitPrice   = exitPrice != null ? parseFloat(String(exitPrice)) : null;
    if (outcome     !== undefined) patch.outcome     = outcome;
    if (pnlPts      !== undefined) patch.pnlPts      = pnlPts != null ? parseFloat(String(pnlPts)) : null;
    if (pnlDollars  !== undefined) patch.pnlDollars  = pnlDollars != null ? parseFloat(String(pnlDollars)) : null;
    if (followedPlan!== undefined) patch.followedPlan= followedPlan ? 1 : 0;
    if (emotionState!== undefined) patch.emotionState= emotionState;
    if (notes       !== undefined) patch.notes       = notes;
    if (errorMade   !== undefined) patch.errorMade   = errorMade;
    if (setupType   !== undefined) patch.setupType   = setupType;
    if (Object.keys(patch).length) db.update(tradeJournal).set(patch).where(eq(tradeJournal.id, id)).run();
    res.json({ success: true });
  });

  app.delete("/api/journal/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.delete(tradeJournal).where(eq(tradeJournal.id, id)).run();
    res.json({ success: true });
  });

  app.get("/api/footprint/reading/:signalId", async (req, res) => { // FOOTPRINT-STRATEGY:
    try { // FOOTPRINT-STRATEGY:
      const id = parseInt(req.params.signalId, 10); // FOOTPRINT-STRATEGY:
      const row = db.select({ footprintReading: signalHistory.footprintReading }) // FOOTPRINT-STRATEGY:
        .from(signalHistory).where(eq(signalHistory.id, id)).get() as any; // FOOTPRINT-STRATEGY:
      if (!row) { res.status(404).json(null); return; } // FOOTPRINT-STRATEGY:
      res.json(row.footprintReading ? JSON.parse(row.footprintReading) : null); // FOOTPRINT-STRATEGY:
    } catch (err: any) { // FOOTPRINT-STRATEGY:
      res.status(500).json({ error: err.message }); // FOOTPRINT-STRATEGY:
    } // FOOTPRINT-STRATEGY:
  }); // FOOTPRINT-STRATEGY:

  // GET /api/mc-calibration — return exit_strategy_calibration.json for the MC tab
  app.get("/api/mc-calibration", (_req, res) => {
    const candidates = [
      path.join(process.cwd(), "exit_strategy_calibration.json"),
      path.join(__dirname, "..", "exit_strategy_calibration.json"),
      path.join(__dirname, "exit_strategy_calibration.json"),
    ];
    const filePath = candidates.find(p => fs.existsSync(p));
    if (!filePath) {
      return res.json(null);
    }
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to parse calibration: " + e.message });
    }
  });

  // On-demand Yahoo Finance historical backfill.
  // POST /api/data/yahoo-backfill  body: { symbol: "MES" }
  // Returns { ok, symbol, inserted }.  Uses ON CONFLICT DO NOTHING so MW data is never overwritten.
  app.post("/api/data/yahoo-backfill", async (req, res) => {
    const sym = ((req.body?.symbol as string) || "MES").toUpperCase();
    const overwrite = req.body?.overwrite === true; // true → Yahoo overwrites existing bars (repair)
    try {
      const inserted = await yahooBackfillSymbol(sym, overwrite);
      res.json({ ok: true, symbol: sym, overwrite, inserted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Auto-run Yahoo backfill for MES and ES on every server startup.
  // Runs in the background — does not block server ready.
  // ON CONFLICT DO NOTHING means re-running is cheap once the DB is populated.
  for (const sym of ["MES", "ES"]) {
    yahooBackfillSymbol(sym)
      .then(n => { if (n > 0) console.log(`[yahoo-backfill] ${sym}: +${n} bars`); })
      .catch(err => console.error(`[yahoo-backfill] ${sym} error:`, err?.message ?? err));
  }

  return httpServer;
}
