// FOOTPRINT-STRATEGY: created by footprint integration — do not edit manually
import { db } from "./db";
import { signalHistory, footprintCandles } from "@shared/schema";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

// ── Broadcast reference (injected by index.ts) ─────────────────────────────
let _broadcast: ((msg: object) => void) | null = null;
export function initFootprintEngine(broadcastFn: (msg: object) => void): void {
  _broadcast = broadcastFn;
  hydrateFromDb(); // FOOTPRINT-STRATEGY: restore in-memory store from DB so history/signals work post-restart
  // Every 10s push in-progress snapshots so clients don't have to wait for a bucket rollover
  setInterval(() => {
    for (const [key, builder] of builders) {
      const preview = builder.snapshot();
      if (!preview) continue;
      const sep = key.indexOf("_");
      const sym = key.slice(0, sep);
      const iv  = key.slice(sep + 1);
      pushCandle(sym, iv, preview);
      broadcastFn({ type: "footprint_candle", symbol: sym, interval: iv, candle: preview });
    }
  }, 10_000);
}

/** Returns the in-progress (not yet closed) candle for the given symbol+interval, or null. */
export function getActivePreview(symbol: string, interval: string): FootprintCandle | null {
  const builder = builders.get(storeKey(symbol, interval));
  return builder?.snapshot() ?? null;
}

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface PriceLevelData {
  price:     number;
  bidVol:    number;
  askVol:    number;
  delta:     number;
  imbalance: "buy" | "sell" | "none";
}

export interface AbsorptionEvent {
  price:     number;
  side:      "buy" | "sell";
  volume:    number;
  priceHeld: boolean;
}

export interface ImbalanceCluster {
  startPrice: number;
  endPrice:   number;
  direction:  "buy" | "sell";
  levelCount: number;
  stacked:    boolean;
  totalDelta: number;
}

export interface UnfinishedAuction {
  price:     number;
  side:      "buy" | "sell";
  atExtreme: "high" | "low";
}

export interface FootprintCandle {
  symbol:           string;
  interval:         string;
  time:             number;
  levels:           PriceLevelData[];
  totalBidVol:      number;
  totalAskVol:      number;
  candleDelta:      number;
  poc:              number;
  vah:              number;
  val:              number;
  high:             number;
  low:              number;
  absorption:       AbsorptionEvent | null;
  imbalances:       ImbalanceCluster[];
  unfinishedAuction: UnfinishedAuction | null;
  complete:         boolean;
}

export interface FootprintExitAdjustments {
  usePocStop:      boolean;
  pocStopPrice:    number | null;
  tp1Override:     number | null;
  tp2Extension:    number | null;
  tightenTrailing: boolean;
}

export interface FootprintReading {
  confirmed:         boolean;
  partial:           boolean;
  vetoed:            boolean;
  vetoReason:        string | null;
  deltaAgrees:       boolean;
  divergence:        boolean;
  absorption:        AbsorptionEvent | null;
  stackedImbalance:  ImbalanceCluster | null;
  trappedTraders:    "long" | "short" | null;
  unfinishedAuction: UnfinishedAuction | null;
  poc:               number;
  candleDelta:       number;
  exitAdjustments:   FootprintExitAdjustments;
}

// ── In-memory candle store — last 50 per symbol+interval ──────────────────
const candleStore = new Map<string, FootprintCandle[]>();

function storeKey(symbol: string, interval: string): string {
  return `${symbol.toUpperCase()}_${interval}`;
}

function pushCandle(symbol: string, interval: string, candle: FootprintCandle): void {
  const key = storeKey(symbol, interval);
  const arr = candleStore.get(key) ?? [];
  // Dedupe by time: the 10s preview interval + every footprint_bar both push the CURRENT bucket,
  // and rollover pushes its finalized version. Replace the same-bucket entry instead of appending,
  // otherwise the 50-slot cap fills with repeats of one bucket (~15min of history, not ~4h of 5m).
  const last = arr[arr.length - 1];
  if (last && last.time === candle.time) {
    arr[arr.length - 1] = candle; // preview→preview refresh, or preview→complete on rollover
  } else {
    arr.push(candle);
    if (arr.length > 50) arr.shift();
  }
  candleStore.set(key, arr);
  persistCandle(candle); // FOOTPRINT-STRATEGY: durably write to DB so it survives restarts + the 50-cap
}

// ── DB persistence ─────────────────────────────────────────────────────────
// Every candle that flows through pushCandle (forming previews + finalized candles) is upserted
// keyed on (symbol, interval, time). Previews get overwritten by the complete candle when the
// bucket rolls; the last partial candle of a session is retained if MW disconnects before rollover.

function persistCandle(candle: FootprintCandle): void {
  try {
    db.insert(footprintCandles).values({
      symbol:   candle.symbol.toUpperCase(),
      interval: candle.interval,
      time:     candle.time,
      complete: candle.complete ? 1 : 0,
      data:     JSON.stringify(candle),
    }).onConflictDoUpdate({
      target: [footprintCandles.symbol, footprintCandles.interval, footprintCandles.time],
      set: {
        complete:  candle.complete ? 1 : 0,
        data:      JSON.stringify(candle),
        updatedAt: sql`(datetime('now'))`,
      },
    }).run();
  } catch { /* non-fatal — table may not exist yet on first boot */ }
}

/** Load persisted footprint candles for a symbol+interval, ascending by time (most recent `limit`). */
export function loadPersistedCandles(symbol: string, interval: string, limit = 600): FootprintCandle[] {
  try {
    const rows = db.select({ data: footprintCandles.data })
      .from(footprintCandles)
      .where(and(
        eq(footprintCandles.symbol, symbol.toUpperCase()),
        eq(footprintCandles.interval, interval),
      ))
      .orderBy(desc(footprintCandles.time))
      .limit(limit)
      .all() as { data: string }[];
    const out: FootprintCandle[] = [];
    for (const r of rows) {
      try { out.push(JSON.parse(r.data) as FootprintCandle); } catch { /* skip corrupt row */ }
    }
    return out.reverse(); // ascending by time
  } catch {
    return [];
  }
}

/** Warm the in-memory store from DB at startup so signal analysis works right after a restart. */
function hydrateFromDb(): void {
  try {
    const keys = db.selectDistinct({ symbol: footprintCandles.symbol, interval: footprintCandles.interval })
      .from(footprintCandles).all() as { symbol: string; interval: string }[];
    for (const { symbol, interval } of keys) {
      // Only seed COMPLETE candles so getLatestCandle/getPriorCandles aren't fed a stale preview.
      const recent = loadPersistedCandles(symbol, interval, 50).filter(c => c.complete);
      if (recent.length) candleStore.set(storeKey(symbol, interval), recent.slice(-50));
    }
    if (keys.length) console.log(`[footprint] hydrated ${keys.length} store(s) from DB`);
  } catch { /* table may not exist yet */ }
}

export function getLatestCandle(symbol: string, interval: string): FootprintCandle | null {
  const arr = candleStore.get(storeKey(symbol, interval));
  return arr && arr.length > 0 ? arr[arr.length - 1] : null;
}

export function getPriorCandles(symbol: string, interval: string, count: number): FootprintCandle[] {
  const arr = candleStore.get(storeKey(symbol, interval)) ?? [];
  const completed = arr.filter(c => c.complete);
  return completed.slice(-(count + 1), -1); // exclude the very last (current signal candle)
}

export function getAllCandles(symbol: string, interval: string): FootprintCandle[] {
  return candleStore.get(storeKey(symbol, interval)) ?? [];
}

// ── FootprintCandleBuilder ─────────────────────────────────────────────────

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "60m": 3600,
};

class FootprintCandleBuilder {
  private levelMap = new Map<number, { bidVol: number; askVol: number }>();
  private currentBucket = 0;
  private candleHigh = 0;
  private candleLow  = Infinity;
  private symbol: string;
  private interval: string;
  private intervalSec: number;

  onCandleComplete: (candle: FootprintCandle) => void = () => {};

  constructor(symbol: string, interval: string) {
    this.symbol      = symbol;
    this.interval    = interval;
    this.intervalSec = INTERVAL_SECONDS[interval] ?? 300;
  }

  addBar(time: number, levels: { price: number; b: number; a: number }[]): void {
    const bucket = Math.floor(time / this.intervalSec) * this.intervalSec;

    if (this.currentBucket !== 0 && bucket !== this.currentBucket) {
      // Bucket rolled — finalize previous candle
      const closed = this.closeCandle();
      pushCandle(this.symbol, this.interval, closed);
      this.onCandleComplete(closed);
      this.levelMap.clear();
      this.candleHigh = 0;
      this.candleLow  = Infinity;
    }
    this.currentBucket = bucket;

    for (const { price, b, a } of levels) {
      const existing = this.levelMap.get(price) ?? { bidVol: 0, askVol: 0 };
      existing.bidVol += b;
      existing.askVol += a;
      this.levelMap.set(price, existing);
      if (price > this.candleHigh) this.candleHigh = price;
      if (price < this.candleLow)  this.candleLow  = price;
    }
  }

  // Returns current accumulated data without closing the candle — used for live preview
  snapshot(): FootprintCandle | null {
    if (this.currentBucket === 0 || this.levelMap.size === 0) return null;
    return { ...this.closeCandle(), complete: false };
  }

  closeCandle(): FootprintCandle {
    const sortedPrices = Array.from(this.levelMap.keys()).sort((a, b) => a - b);
    let totalBid = 0;
    let totalAsk = 0;
    let pocPrice = sortedPrices[0] ?? 0;
    let pocVol   = 0;

    const levels: PriceLevelData[] = sortedPrices.map(price => {
      const { bidVol, askVol } = this.levelMap.get(price)!;
      const delta   = askVol - bidVol;
      const totalVol = bidVol + askVol;
      totalBid += bidVol;
      totalAsk += askVol;
      if (totalVol > pocVol) { pocVol = totalVol; pocPrice = price; }
      let imbalance: "buy" | "sell" | "none" = "none";
      if (askVol >= bidVol * 3 && bidVol > 0)  imbalance = "buy";
      if (bidVol >= askVol * 3 && askVol > 0)  imbalance = "sell";
      // Zero-vs-nonzero also counts as imbalance
      if (askVol > 0 && bidVol === 0) imbalance = "buy";
      if (bidVol > 0 && askVol === 0) imbalance = "sell";
      return { price, bidVol, askVol, delta, imbalance };
    });

    const candleDelta = totalAsk - totalBid;
    const totalVol    = totalBid + totalAsk;

    // ── VAH / VAL (70% value area from POC outward) ──────────────────────
    let vahIndex = sortedPrices.indexOf(pocPrice);
    let valIndex = vahIndex;
    let coveredVol = pocVol;
    const target70 = totalVol * 0.70;
    let lo = vahIndex - 1;
    let hi = vahIndex + 1;
    while (coveredVol < target70 && (lo >= 0 || hi < levels.length)) {
      const loVol = lo >= 0 ? levels[lo].bidVol + levels[lo].askVol : 0;
      const hiVol = hi < levels.length ? levels[hi].bidVol + levels[hi].askVol : 0;
      if (hiVol >= loVol && hi < levels.length) {
        coveredVol += hiVol; vahIndex = hi; hi++;
      } else if (lo >= 0) {
        coveredVol += loVol; valIndex = lo; lo--;
      } else {
        coveredVol += hiVol; vahIndex = hi; hi++;
      }
    }
    const vah = levels[vahIndex]?.price ?? pocPrice;
    const val = levels[valIndex]?.price ?? pocPrice;

    // ── Absorption detection ──────────────────────────────────────────────
    let absorption: AbsorptionEvent | null = null;
    if (levels.length > 0) {
      const avgVol = totalVol / levels.length;
      // Check candle high — bearish absorption (sellers absorbing buyers at top)
      const topLevel = levels[levels.length - 1];
      if (topLevel && topLevel.bidVol + topLevel.askVol >= avgVol * 1.5) {
        absorption = {
          price: topLevel.price,
          side: "sell",
          volume: topLevel.bidVol + topLevel.askVol,
          priceHeld: true,
        };
      }
      // Check candle low — bullish absorption (buyers absorbing sellers at bottom)
      const botLevel = levels[0];
      if (botLevel && botLevel.bidVol + botLevel.askVol >= avgVol * 1.5) {
        // Only replace if this is a stronger signal
        if (!absorption || (botLevel.bidVol + botLevel.askVol) > absorption.volume) {
          absorption = {
            price: botLevel.price,
            side: "buy",
            volume: botLevel.bidVol + botLevel.askVol,
            priceHeld: true,
          };
        }
      }
    }

    // ── Imbalance clusters ────────────────────────────────────────────────
    const imbalances: ImbalanceCluster[] = [];
    let clusterStart = -1;
    let clusterDir: "buy" | "sell" | null = null;
    let clusterDelta = 0;

    for (let i = 0; i < levels.length; i++) {
      const lv = levels[i];
      if (lv.imbalance !== "none") {
        if (clusterDir === null || clusterDir !== lv.imbalance) {
          // Close previous cluster
          if (clusterDir !== null && i > clusterStart) {
            const count = i - clusterStart;
            imbalances.push({
              startPrice: levels[clusterStart].price,
              endPrice:   levels[i - 1].price,
              direction:  clusterDir,
              levelCount: count,
              stacked:    count >= 3,
              totalDelta: clusterDelta,
            });
          }
          clusterStart = i;
          clusterDir   = lv.imbalance;
          clusterDelta = lv.delta;
        } else {
          clusterDelta += lv.delta;
        }
      } else {
        if (clusterDir !== null) {
          const count = i - clusterStart;
          imbalances.push({
            startPrice: levels[clusterStart].price,
            endPrice:   levels[i - 1].price,
            direction:  clusterDir,
            levelCount: count,
            stacked:    count >= 3,
            totalDelta: clusterDelta,
          });
          clusterDir   = null;
          clusterDelta = 0;
        }
      }
    }
    // Close trailing cluster
    if (clusterDir !== null && clusterStart >= 0) {
      const count = levels.length - clusterStart;
      imbalances.push({
        startPrice: levels[clusterStart].price,
        endPrice:   levels[levels.length - 1].price,
        direction:  clusterDir,
        levelCount: count,
        stacked:    count >= 3,
        totalDelta: clusterDelta,
      });
    }

    // ── Unfinished auction ────────────────────────────────────────────────
    let unfinishedAuction: UnfinishedAuction | null = null;
    if (levels.length > 0) {
      const top = levels[levels.length - 1];
      const bot = levels[0];
      if (top.bidVol === 0 && top.askVol > 0) {
        // Only ask volume at the high — buyers drove up but market didn't finish
        unfinishedAuction = { price: top.price, side: "buy", atExtreme: "high" };
      } else if (bot.askVol === 0 && bot.bidVol > 0) {
        // Only bid volume at the low — sellers drove down but market didn't finish
        unfinishedAuction = { price: bot.price, side: "sell", atExtreme: "low" };
      }
    }

    return {
      symbol:            this.symbol,
      interval:          this.interval,
      time:              this.currentBucket,
      levels,
      totalBidVol:       totalBid,
      totalAskVol:       totalAsk,
      candleDelta,
      poc:               pocPrice,
      vah,
      val,
      high:              this.candleHigh,
      low:               this.candleLow === Infinity ? 0 : this.candleLow,
      absorption,
      imbalances,
      unfinishedAuction,
      complete:          true,
    };
  }
}

// ── Builder registry — one per symbol+interval ────────────────────────────
const builders = new Map<string, FootprintCandleBuilder>();

function getBuilder(symbol: string, interval: string): FootprintCandleBuilder {
  const key = storeKey(symbol, interval);
  if (!builders.has(key)) {
    const b = new FootprintCandleBuilder(symbol, interval);
    b.onCandleComplete = (candle) => {
      if (_broadcast) _broadcast({ type: "footprint_candle", symbol, interval, candle });
    };
    builders.set(key, b);
  }
  return builders.get(key)!;
}

export function addBar(
  symbol: string,
  interval: string,
  time: number,
  levels: { price: number; b: number; a: number }[],
): void {
  const builder = getBuilder(symbol, interval);
  builder.addBar(time, levels);
  // Immediately broadcast a preview of the current candle so the client doesn't have
  // to wait for the next bucket to arrive before seeing any footprint data
  const preview = builder.snapshot();
  if (preview) {
    pushCandle(symbol, interval, preview); // upsert into store so history endpoint also reflects it
    if (_broadcast) _broadcast({ type: "footprint_candle", symbol, interval, candle: preview });
  }
}

// ── analyzeFootprint ───────────────────────────────────────────────────────

const TICK_SIZE = 0.25; // ES/MES tick size

export function analyzeFootprint(
  candle: FootprintCandle,
  direction: "Long" | "Short",
  priorCandles: FootprintCandle[],
  zonePrice: number,
): FootprintReading {
  const isLong = direction === "Long";

  // ── CONDITION 1: Delta agreement ────────────────────────────────────────
  const deltaAgrees = isLong ? candle.candleDelta >= 0 : candle.candleDelta <= 0;

  // ── CONDITION 2: Divergence check ───────────────────────────────────────
  let divergence = false;
  if (priorCandles.length >= 3) {
    const prior3 = priorCandles.slice(-3);
    if (isLong && candle.high >= Math.max(...prior3.map(c => c.high))) {
      // Price at or above prior highs — check if delta is lower than all 3
      divergence = prior3.every(pc => candle.candleDelta < pc.candleDelta);
    } else if (!isLong && candle.low <= Math.min(...prior3.map(c => c.low))) {
      // Price at or below prior lows — check if delta is higher (less negative) than all 3
      divergence = prior3.every(pc => candle.candleDelta > pc.candleDelta);
    }
  }

  if (divergence) {
    return {
      confirmed: false, partial: false, vetoed: true,
      vetoReason: "Delta divergence on signal candle — buyer/seller exhaustion detected",
      deltaAgrees, divergence,
      absorption: null, stackedImbalance: null,
      trappedTraders: null, unfinishedAuction: null,
      poc: candle.poc, candleDelta: candle.candleDelta,
      exitAdjustments: { usePocStop: false, pocStopPrice: null, tp1Override: null, tp2Extension: null, tightenTrailing: false },
    };
  }

  if (!deltaAgrees) {
    return {
      confirmed: false, partial: false, vetoed: false, vetoReason: null,
      deltaAgrees, divergence: false,
      absorption: null, stackedImbalance: null,
      trappedTraders: null, unfinishedAuction: null,
      poc: candle.poc, candleDelta: candle.candleDelta,
      exitAdjustments: buildExitAdjustments(candle, direction, null, null, null, zonePrice),
    };
  }

  // ── CONDITION 3: Bonus signals ───────────────────────────────────────────
  const ticksFromZone = 2 * TICK_SIZE;

  // a. Absorption at zone boundary
  let absorptionBonus: AbsorptionEvent | null = null;
  if (candle.absorption) {
    const zoneDist = Math.abs(candle.absorption.price - zonePrice);
    const sideMatch = isLong ? candle.absorption.side === "buy" : candle.absorption.side === "sell";
    if (zoneDist <= ticksFromZone && sideMatch) {
      absorptionBonus = candle.absorption;
    }
  }

  // b. Stacked imbalances in signal direction
  const stackedImbalance = candle.imbalances.find(
    cl => cl.stacked && cl.direction === (isLong ? "buy" : "sell")
  ) ?? null;

  // c. Trapped traders
  let trappedTraders: "long" | "short" | null = null;
  if (candle.levels.length > 0) {
    const avgBid = candle.totalBidVol / candle.levels.length;
    const avgAsk = candle.totalAskVol / candle.levels.length;
    if (isLong) {
      // Sellers trapped: heavy bid vol at the LOW that price bounced from
      const botLevel = candle.levels[0];
      if (botLevel && botLevel.bidVol >= avgBid * 3 && candle.candleDelta > 0) {
        trappedTraders = "short"; // trapped shorts at the low
      }
    } else {
      // Buyers trapped: heavy ask vol at the HIGH that price rejected from
      const topLevel = candle.levels[candle.levels.length - 1];
      if (topLevel && topLevel.askVol >= avgAsk * 3 && candle.candleDelta < 0) {
        trappedTraders = "long"; // trapped longs at the high
      }
    }
  }

  // d. Unfinished auction (current candle or prior 3)
  const allCandles = [...priorCandles.slice(-3), candle];
  const auctionSide = isLong ? "buy" : "sell";
  let foundAuction: UnfinishedAuction | null = null;
  for (const c of allCandles) {
    if (c.unfinishedAuction && c.unfinishedAuction.side === auctionSide) {
      foundAuction = c.unfinishedAuction;
    }
  }

  const hasBonus = absorptionBonus !== null || stackedImbalance !== null ||
                   trappedTraders !== null || foundAuction !== null;

  const confirmed = hasBonus;
  const partial   = !hasBonus;

  const exitAdj = buildExitAdjustments(candle, direction, stackedImbalance, foundAuction, absorptionBonus, zonePrice);

  return {
    confirmed, partial, vetoed: false, vetoReason: null,
    deltaAgrees, divergence: false,
    absorption: absorptionBonus,
    stackedImbalance,
    trappedTraders,
    unfinishedAuction: foundAuction,
    poc: candle.poc,
    candleDelta: candle.candleDelta,
    exitAdjustments: exitAdj,
  };
}

function buildExitAdjustments(
  candle: FootprintCandle,
  direction: "Long" | "Short",
  stackedImbalan: ImbalanceCluster | null,
  auction: UnfinishedAuction | null,
  _absorption: AbsorptionEvent | null,
  zonePrice: number,
): FootprintExitAdjustments {
  const isLong     = direction === "Long";
  const candleRange = Math.abs(candle.high - candle.low);

  // POC stop
  const pocDist    = Math.abs(candle.poc - zonePrice);
  const usePocStop = candleRange > 0 && (pocDist / candleRange) <= 0.60;

  // TP1 override from unfinished auction
  let tp1Override: number | null = null;
  if (auction) {
    if (isLong && auction.atExtreme === "high" && auction.price > zonePrice) {
      tp1Override = auction.price;
    } else if (!isLong && auction.atExtreme === "low" && auction.price < zonePrice) {
      tp1Override = auction.price;
    }
  }

  // TP2 extension from stacked imbalances
  const tp2Extension = stackedImbalan?.stacked ? 0.20 : null;

  return {
    usePocStop,
    pocStopPrice: usePocStop ? candle.poc : null,
    tp1Override,
    tp2Extension,
    tightenTrailing: false,
  };
}

// ── Mid-trade divergence monitoring ───────────────────────────────────────

export function checkMidTradeDivergence(symbol: string, _currentPrice: number): void {
  // Only check every 60s to avoid hammering the DB on every tick
  const now = Date.now();
  const lastCheck = _lastDivCheck.get(symbol) ?? 0;
  if (now - lastCheck < 60_000) return;
  _lastDivCheck.set(symbol, now);

  try {
    const openSignals = db
      .select()
      .from(signalHistory)
      .where(
        and(
          eq(signalHistory.symbol, symbol.toUpperCase()),
          or(isNull(signalHistory.outcome), eq(signalHistory.outcome, "open")),
        )
      )
      .all() as (typeof signalHistory.$inferSelect)[];

    for (const sig of openSignals) {
      const interval = sig.interval ?? "5m";
      const candle   = getLatestCandle(symbol, interval);
      if (!candle || !candle.complete) continue;
      const priors = getPriorCandles(symbol, interval, 3);
      if (priors.length < 3) continue;

      const isLong   = sig.direction === "Long";
      const avgPrior = priors.reduce((s, c) => s + c.candleDelta, 0) / priors.length;

      const midDivergence = isLong
        ? candle.candleDelta < avgPrior && candle.high > candle.low // bearish delta on long
        : candle.candleDelta > avgPrior && candle.high > candle.low; // bullish delta on short

      if (midDivergence && _broadcast) {
        _broadcast({
          type:     "footprint_alert",
          symbol,
          signalId: sig.id,
          alert:    "mid_trade_divergence",
          pocPrice: candle.poc,
          message:  `Delta divergence detected mid-trade — tighten trailing stop to POC (${candle.poc.toFixed(2)})`,
        });
      }
    }
  } catch { /* non-fatal — DB may not have signal_history yet */ }
}

const _lastDivCheck = new Map<string, number>();
