// FOOTPRINT-STRATEGY: client-side pure analysis — no server imports, no broadcast

// FOOTPRINT-RULE: flag indicating whether real MW tick data is confirmed.
// When false, footprint ladder shows blank/zero instead of fake proxy values.
// Set to true ONLY when server confirms real bid/ask data from LiveBarRelay.
export let FOOTPRINT_DATA_CONFIRMED = false; // FOOTPRINT-RULE:

export function setFootprintDataConfirmed(confirmed: boolean): void { // FOOTPRINT-RULE:
  FOOTPRINT_DATA_CONFIRMED = confirmed; // FOOTPRINT-RULE:
  console.log(`[footprint] Data source confirmed: ${confirmed}`); // FOOTPRINT-RULE:
} // FOOTPRINT-RULE:

// MotiveWave Volume Imprint settings (from friend's screenshots)
// Tier 1: Imbalance %  400 → ratio 4.0x, Delta Filter 100
// Tier 2: Imbalance 2% 500 → ratio 5.0x, Delta Filter 100
// Tier 3: Imbalance 3% 600 → ratio 6.0x, Delta Filter 100
export const MW_IMBALANCE_THRESHOLDS = { tier1: 4.0, tier2: 5.0, tier3: 6.0 } as const;
// Net |ask-bid| bucketing for ML (applies to real tick data; proxy volumes are synthetic)
export const NET_THRESHOLDS = { tier1: 100, tier2: 200, tier3: 400 } as const;
// Proxy-mode tier ratios (synthetic volumes; real thresholds require real data)
export const PROXY_TIER2 = 2.0, PROXY_TIER3 = 2.5;

// FOOTPRINT-RULE: threshold depends on data source.
// Proxy (OHLCV approximation): 1.5 — fires on directional extremes
// Real tick data (MW LiveBarRelay): 4.0 — MW Imbalance % tier 1 (400%)
export const IMBALANCE_THRESHOLD = FOOTPRINT_DATA_CONFIRMED ? MW_IMBALANCE_THRESHOLDS.tier1 : 1.5; // FOOTPRINT-RULE:

export interface OHLCVBar {
  time:    number;
  open:    number;
  high:    number;
  low:     number;
  close:   number;
  volume?: number;
}

export interface PriceLevelData {
  price:     number;
  bidVol:    number;
  askVol:    number;
  delta:     number;
  net:       number; // |askVol - bidVol| — ML bucket key for zone strength
  imbalance: "buy" | "sell" | "none";
}

export interface AbsorptionEvent {
  price:     number;
  side:      "buy" | "sell";
  volume:    number;
  priceHeld: boolean;
}

export interface ImbalanceCluster {
  startPrice:   number;
  endPrice:     number;
  direction:    "buy" | "sell";
  levelCount:   number;
  stacked:      boolean;
  totalDelta:   number;
  strengthTier: 1 | 2 | 3; // 1=400%/net>100, 2=500%/net>200, 3=600%/net>400 (proxy: relative ratios)
}

export interface UnfinishedAuction {
  price:     number;
  side:      "buy" | "sell";
  atExtreme: "high" | "low";
}

// RULE 7 (2026-07-13): the candle-level delta FIELD is deleted — footprint contributes
// imbalance ZONES only; displays that show a net delta compute totalAskVol − totalBidVol.
export interface FootprintCandle {
  symbol:            string;
  interval:          string;
  time:              number;
  levels:            PriceLevelData[];
  totalBidVol:       number;
  totalAskVol:       number;
  poc:               number;
  vah:               number;
  val:               number;
  high:              number;
  low:               number;
  absorption:        AbsorptionEvent | null;
  imbalances:        ImbalanceCluster[];
  unfinishedAuction: UnfinishedAuction | null;
  complete:          boolean;
}

// ── (FootprintExitAdjustments / FootprintReading / analyzeFootprint / buildExitAdjustments
//    DELETED 2026-07-13) — RULE 7: no delta logic in any signal path. The delta-agreement gate,
//    divergence veto, trapped-traders read and POC-stop/TP exit adjustments were the retired
//    points model's footprint scoring; the fact engine consumes imbalance ZONES only.

// ── OHLCV proxy ───────────────────────────────────────────────────────────
// Synthesizes a FootprintCandle from OHLCV bar data using whole-number price
// buckets. Each integer price from Math.floor(low) to Math.ceil(high) gets
// one row. Volume is distributed by body/wick membership and directional bias.
export function buildProxyFootprintCandle(c: OHLCVBar): FootprintCandle { // FOOTPRINT-SIZE-FIX: whole-number buckets
  // FOOTPRINT-RULE: always synthesize proxy data from OHLCV so the column is visible.
  // FOOTPRINT_DATA_CONFIRMED only gates frozen zones and the imbalance threshold upgrade — not display.
  const vol  = c.volume ?? 100; // FOOTPRINT-SIZE-FIX:
  const isUp = c.close >= c.open; // FOOTPRINT-SIZE-FIX:
  const bodyBottom = Math.min(c.open, c.close); // FOOTPRINT-SIZE-FIX:
  const bodyTop    = Math.max(c.open, c.close); // FOOTPRINT-SIZE-FIX:

  // Whole-number price levels: floor(low) to ceil(high), step 1.0
  const wLow  = Math.floor(c.low);  // FOOTPRINT-SIZE-FIX:
  const wHigh = Math.ceil(c.high);  // FOOTPRINT-SIZE-FIX:
  const allPrices: number[] = []; // FOOTPRINT-SIZE-FIX:
  for (let wp = wLow; wp <= wHigh; wp++) allPrices.push(wp); // FOOTPRINT-SIZE-FIX:
  if (!allPrices.length) allPrices.push(Math.round(c.low)); // FOOTPRINT-SIZE-FIX: degenerate guard

  const bodyTicks = Math.max(1, allPrices.filter(p => p >= bodyBottom - 0.5 && p <= bodyTop + 0.5).length); // FOOTPRINT-SIZE-FIX:
  const wickTicks = Math.max(1, allPrices.length - bodyTicks); // FOOTPRINT-SIZE-FIX:
  const volPerBodyTick = (vol * 0.70) / bodyTicks; // FOOTPRINT-SIZE-FIX:
  const volPerWickTick = (vol * 0.30) / wickTicks; // FOOTPRINT-SIZE-FIX:

  const levels: PriceLevelData[] = []; // FOOTPRINT-SIZE-FIX:
  let poc = allPrices[0]; // FOOTPRINT-SIZE-FIX:
  let maxLvVol = 0; // FOOTPRINT-SIZE-FIX:

  for (const price of allPrices) { // FOOTPRINT-SIZE-FIX:
    const inBody = price >= bodyBottom - 0.5 && price <= bodyTop + 0.5; // FOOTPRINT-SIZE-FIX: 0.5 tolerance for whole numbers
    const lv = inBody ? volPerBodyTick : volPerWickTick; // FOOTPRINT-SIZE-FIX:
    let bidVol: number, askVol: number; // FOOTPRINT-SIZE-FIX:
    if (inBody) { // FOOTPRINT-SIZE-FIX:
      const bodyRange = bodyTop - bodyBottom; // FOOTPRINT-SIZE-FIX:
      const relPos = bodyRange > 0.5 ? (price - bodyBottom) / bodyRange : 0.5; // FOOTPRINT-SIZE-FIX: 0=bottom,1=top
      if (isUp) { // FOOTPRINT-SIZE-FIX:
        const askRatio = 0.75 - relPos * 0.20; // FOOTPRINT-SIZE-FIX: 0.75 at bottom → 0.55 at top
        askVol = lv * askRatio; bidVol = lv * (1 - askRatio); // FOOTPRINT-SIZE-FIX:
      } else { // FOOTPRINT-SIZE-FIX:
        const bidRatio = 0.75 - (1 - relPos) * 0.20; // FOOTPRINT-SIZE-FIX: 0.75 at top → 0.55 at bottom
        bidVol = lv * bidRatio; askVol = lv * (1 - bidRatio); // FOOTPRINT-SIZE-FIX:
      } // FOOTPRINT-SIZE-FIX:
    } else if (price < bodyBottom) { // FOOTPRINT-SIZE-FIX: lower wick
      if (isUp) { askVol = lv * 0.60; bidVol = lv * 0.40; } // FOOTPRINT-SIZE-FIX:
      else       { bidVol = lv * 0.70; askVol = lv * 0.30; } // FOOTPRINT-SIZE-FIX:
    } else { // FOOTPRINT-SIZE-FIX: upper wick
      if (isUp) { bidVol = lv * 0.70; askVol = lv * 0.30; } // FOOTPRINT-SIZE-FIX:
      else       { askVol = lv * 0.60; bidVol = lv * 0.40; } // FOOTPRINT-SIZE-FIX:
    } // FOOTPRINT-SIZE-FIX:
    const delta = askVol - bidVol; // FOOTPRINT-SIZE-FIX:
    const buyRatio  = bidVol > 0 ? askVol / bidVol : askVol > 0 ? 999 : 1; // FOOTPRINT-SIZE-FIX:
    const sellRatio = askVol > 0 ? bidVol / askVol : bidVol > 0 ? 999 : 1; // FOOTPRINT-SIZE-FIX:
    const imbalance: "buy" | "sell" | "none" = // FOOTPRINT-SIZE-FIX:
      buyRatio >= IMBALANCE_THRESHOLD ? "buy" : sellRatio >= IMBALANCE_THRESHOLD ? "sell" : "none"; // FOOTPRINT-RULE: threshold switches 1.5→3.0 when real data confirmed
    levels.push({ price, bidVol, askVol, delta, net: Math.abs(askVol - bidVol), imbalance }); // FOOTPRINT-SIZE-FIX:
    if (bidVol + askVol > maxLvVol) { maxLvVol = bidVol + askVol; poc = price; } // FOOTPRINT-SIZE-FIX:
  } // FOOTPRINT-SIZE-FIX:

  // VAH / VAL via value area (70% of total volume from POC outward)
  const totalVol = levels.reduce((s, l) => s + l.bidVol + l.askVol, 0);
  const target = totalVol * 0.70;
  let accum = 0, vah = poc, val = poc;
  let hi = levels.findIndex(l => Math.abs(l.price - poc) < 0.5); // FOOTPRINT-SIZE-FIX: tolerance 0.5 for whole numbers
  if (hi < 0) hi = 0;
  let lo = hi;
  while (accum < target && (hi < levels.length - 1 || lo > 0)) {
    const upV = hi < levels.length - 1 ? levels[hi + 1].bidVol + levels[hi + 1].askVol : 0;
    const dnV = lo > 0 ? levels[lo - 1].bidVol + levels[lo - 1].askVol : 0;
    if (upV >= dnV && hi < levels.length - 1) { hi++; accum += upV; vah = levels[hi].price; }
    else if (lo > 0)                           { lo--; accum += dnV; val = levels[lo].price; }
    else                                       { break; }
  }

  // Absorption: above-average volume at an extreme where price was rejected
  const avgLvVol = levels.length ? totalVol / levels.length : 1;
  let absorption: AbsorptionEvent | null = null;
  const topLv = levels[levels.length - 1];
  const botLv = levels[0];
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  if (isUp && upperWick >= 1.0 && topLv && topLv.bidVol >= avgLvVol * 1.5) // FOOTPRINT-SIZE-FIX: 1.0 whole point
    absorption = { price: topLv.price, side: "sell", volume: topLv.bidVol, priceHeld: true };
  else if (!isUp && lowerWick >= 1.0 && botLv && botLv.askVol >= avgLvVol * 1.5) // FOOTPRINT-SIZE-FIX:
    absorption = { price: botLv.price, side: "buy", volume: botLv.askVol, priceHeld: true };

  // Stacked imbalances: consecutive levels with same imbalance direction
  const imbalances: ImbalanceCluster[] = [];
  let csIdx = -1, csDir: "buy" | "sell" | null = null, csDelta = 0, csAsk = 0, csBid = 0; // FOOTPRINT-SIZE-FIX:
  const flushCluster = (end: number) => {
    if (csIdx < 0 || csDir == null) return;
    const cnt = end - csIdx;
    const clRatio = csDir === "buy" ? (csBid > 0 ? csAsk / csBid : 999) : (csAsk > 0 ? csBid / csAsk : 999); // FOOTPRINT-SIZE-FIX:
    const clNet   = cnt > 0 ? Math.abs(csAsk - csBid) / cnt : 0; // FOOTPRINT-SIZE-FIX: avg net per level
    let strengthTier: 1 | 2 | 3 = 1; // FOOTPRINT-SIZE-FIX:
    if (FOOTPRINT_DATA_CONFIRMED) { // FOOTPRINT-SIZE-FIX: real MW thresholds
      if (clRatio >= MW_IMBALANCE_THRESHOLDS.tier3 && clNet >= NET_THRESHOLDS.tier3) strengthTier = 3; // FOOTPRINT-SIZE-FIX:
      else if (clRatio >= MW_IMBALANCE_THRESHOLDS.tier2 && clNet >= NET_THRESHOLDS.tier2) strengthTier = 2; // FOOTPRINT-SIZE-FIX:
    } else { // FOOTPRINT-SIZE-FIX: proxy: classify by ratio relative to base threshold
      if (clRatio >= PROXY_TIER3 * IMBALANCE_THRESHOLD) strengthTier = 3; // FOOTPRINT-SIZE-FIX:
      else if (clRatio >= PROXY_TIER2 * IMBALANCE_THRESHOLD) strengthTier = 2; // FOOTPRINT-SIZE-FIX:
    } // FOOTPRINT-SIZE-FIX:
    imbalances.push({ startPrice: levels[csIdx].price, endPrice: levels[end - 1].price,
      direction: csDir, levelCount: cnt, stacked: cnt >= 3, totalDelta: csDelta, strengthTier }); // FOOTPRINT-SIZE-FIX:
    csIdx = -1; csDir = null; csDelta = 0; csAsk = 0; csBid = 0; // FOOTPRINT-SIZE-FIX:
  };
  for (let i = 0; i < levels.length; i++) {
    const lev = levels[i];
    if (lev.imbalance !== "none") {
      if (lev.imbalance === csDir) { csDelta += lev.delta; csAsk += lev.askVol; csBid += lev.bidVol; } // FOOTPRINT-SIZE-FIX:
      else { flushCluster(i); csIdx = i; csDir = lev.imbalance; csDelta = lev.delta; csAsk = lev.askVol; csBid = lev.bidVol; } // FOOTPRINT-SIZE-FIX:
    } else { flushCluster(i); }
  }
  flushCluster(levels.length);

  // Unfinished auction: price closed at or very near an extreme
  let unfinishedAuction: UnfinishedAuction | null = null;
  const range = Math.max(c.high - c.low, 1.0); // FOOTPRINT-SIZE-FIX: whole-number range
  if (range > 2.0) { // FOOTPRINT-SIZE-FIX: candle must span at least 2 whole points
    if (upperWick < 1.0)      unfinishedAuction = { price: c.high, side: "buy",  atExtreme: "high" }; // FOOTPRINT-SIZE-FIX:
    else if (lowerWick < 1.0) unfinishedAuction = { price: c.low,  side: "sell", atExtreme: "low"  }; // FOOTPRINT-SIZE-FIX:
  }

  const totalBidVol = levels.reduce((s, l) => s + l.bidVol, 0);
  const totalAskVol = levels.reduce((s, l) => s + l.askVol, 0);

  return {
    symbol: "", interval: "", time: c.time,
    levels, totalBidVol, totalAskVol,
    poc, vah, val, high: c.high, low: c.low,
    absorption, imbalances, unfinishedAuction, complete: true,
  };
}

// ── Session boundary helpers ─────────────────────────────────────────────────

// FOOTPRINT-RULE: RTH = Mon-Fri 13:30-21:00 UTC (9:30am-5:00pm ET). NOTE: UTC-based (EDT);
// approximate in EST. Only used by frozen-imbalance zones, which require real MW data.
export function getCurrentSessionType(nowSec: number): "rth" | "eth" { // FOOTPRINT-RULE:
  const d    = new Date(nowSec * 1000); // FOOTPRINT-RULE:
  const day  = d.getUTCDay(); // FOOTPRINT-RULE:
  if (day === 0 || day === 6) return "eth"; // FOOTPRINT-RULE:
  const mUTC = d.getUTCHours() * 60 + d.getUTCMinutes(); // FOOTPRINT-RULE:
  return (mUTC >= 13 * 60 + 30 && mUTC < 21 * 60) ? "rth" : "eth"; // FOOTPRINT-RULE: 9:30am–5:00pm ET
} // FOOTPRINT-RULE:

// FOOTPRINT-RULE: find start/end unix seconds of most recent completed session
// of the given type — walks backward up to 7 days.
export function getLastCompletedSession( // FOOTPRINT-RULE:
  nowSec: number, // FOOTPRINT-RULE:
  type: "rth" | "eth" // FOOTPRINT-RULE:
): { start: number; end: number } | null { // FOOTPRINT-RULE:
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) { // FOOTPRINT-RULE:
    const base = new Date((nowSec - dayOffset * 86400) * 1000); // FOOTPRINT-RULE:
    base.setUTCHours(0, 0, 0, 0); // FOOTPRINT-RULE:
    const dayOfWeek = base.getUTCDay(); // FOOTPRINT-RULE:
    const baseSec   = base.getTime() / 1000; // FOOTPRINT-RULE:

    if (type === "rth" && dayOfWeek >= 1 && dayOfWeek <= 5) { // FOOTPRINT-RULE:
      const rthStart = baseSec + 13 * 3600 + 30 * 60; // FOOTPRINT-RULE: 9:30 AM ET
      const rthEnd   = baseSec + 21 * 3600; // FOOTPRINT-RULE: 5:00 PM ET (moved from 4:30 PM)
      if (rthEnd < nowSec) return { start: rthStart, end: rthEnd }; // FOOTPRINT-RULE: session must be fully in the past
    } // FOOTPRINT-RULE:

    if (type === "eth" && dayOfWeek >= 1 && dayOfWeek <= 5) { // FOOTPRINT-RULE:
      // ETH ends at next trading day's 13:30 UTC — find the most recent 13:30 in the past
      const ethEnd   = baseSec + 13 * 3600 + 30 * 60; // FOOTPRINT-RULE:
      if (ethEnd < nowSec) { // FOOTPRINT-RULE:
        const ethStart = ethEnd - (16 * 3600 + 30 * 60); // FOOTPRINT-RULE: ETH runs 16.5h: prior day 21:00 (5pm ET) → next day 13:30
        return { start: ethStart, end: ethEnd }; // FOOTPRINT-RULE:
      } // FOOTPRINT-RULE:
    } // FOOTPRINT-RULE:
  } // FOOTPRINT-RULE:
  return null; // FOOTPRINT-RULE:
} // FOOTPRINT-RULE:

// ── Frozen imbalance zone types ──────────────────────────────────────────────

// FOOTPRINT-RULE: immutable zone from a completed session.
// Price levels NEVER change after session closes.
// Only mitigated/active fields update as new candles arrive.
export interface FrozenImbalanceZone { // FOOTPRINT-RULE:
  sessionType:  "rth" | "eth"; // FOOTPRINT-RULE:
  sessionStart: number;         // unix seconds — when session opened
  sessionEnd:   number;         // unix seconds — when session closed (ladder source)
  topPrice:     number;         // whole number — top of stacked cluster
  bottomPrice:  number;         // whole number — bottom of stacked cluster
  midPrice:     number;         // (top + bottom) / 2 — mitigation trigger
  direction:    "buy" | "sell"; // FOOTPRINT-RULE:
  levelCount:   number;         // >= 3 always (stacked only)
  totalDelta:   number;         // FOOTPRINT-RULE:
  mitigated:    boolean;        // true = price closed through midPrice
  mitigatedAt:  number | null;  // unix seconds of mitigating candle
  active:       boolean;        // false when mitigated
} // FOOTPRINT-RULE:

// CandleBar subset needed by frozen builders (matches FootprintLadder's CandleBar type)
interface CandleBar { time: number; open: number; high: number; low: number; close: number; volume?: number; rth?: boolean } // FOOTPRINT-RULE:

// FOOTPRINT-RULE: build frozen imbalances from a fully completed past session.
// Returns [] when session is not yet complete or data is not confirmed.
export function buildFrozenImbalances( // FOOTPRINT-RULE:
  candles: CandleBar[], // FOOTPRINT-RULE:
  sessionStart: number, // FOOTPRINT-RULE:
  sessionEnd:   number, // FOOTPRINT-RULE:
  sessionType:  "rth" | "eth" // FOOTPRINT-RULE:
): FrozenImbalanceZone[] { // FOOTPRINT-RULE:
  if (sessionEnd > Math.floor(Date.now() / 1000)) { // FOOTPRINT-RULE:
    console.warn("[footprint] PROHIBITED: attempted to freeze active session"); // FOOTPRINT-RULE:
    return []; // FOOTPRINT-RULE:
  } // FOOTPRINT-RULE:
  // FOOTPRINT-RULE: proxy data produces fake imbalances — only freeze confirmed real data
  if (!FOOTPRINT_DATA_CONFIRMED) return []; // FOOTPRINT-RULE:

  const sessionCandles = candles.filter(c => c.time >= sessionStart && c.time < sessionEnd); // FOOTPRINT-RULE:
  if (sessionCandles.length === 0) return []; // FOOTPRINT-RULE:

  // Build session-aggregate ladder using same logic as buildSessionLadder
  const acc = new Map<number, { bidVol: number; askVol: number }>(); // FOOTPRINT-RULE:
  for (const c of sessionCandles) { // FOOTPRINT-RULE:
    const fp = buildProxyFootprintCandle(c); // FOOTPRINT-RULE:
    for (const lv of fp.levels) { // FOOTPRINT-RULE:
      const rp = Math.round(lv.price); // FOOTPRINT-RULE:
      const ex = acc.get(rp) ?? { bidVol: 0, askVol: 0 }; // FOOTPRINT-RULE:
      ex.bidVol += lv.bidVol; ex.askVol += lv.askVol; // FOOTPRINT-RULE:
      acc.set(rp, ex); // FOOTPRINT-RULE:
    } // FOOTPRINT-RULE:
  } // FOOTPRINT-RULE:
  if (!acc.size) return []; // FOOTPRINT-RULE:

  // Build imbalance clusters from aggregate levels
  const sorted = [...acc.entries()].map(([price, { bidVol, askVol }]) => { // FOOTPRINT-RULE:
    const buyR = bidVol > 0 ? askVol / bidVol : 999; // FOOTPRINT-RULE:
    const selR = askVol > 0 ? bidVol / askVol : 999; // FOOTPRINT-RULE:
    return { price, bidVol, askVol, imbalance: buyR >= IMBALANCE_THRESHOLD ? "buy" as const : selR >= IMBALANCE_THRESHOLD ? "sell" as const : "none" as const }; // FOOTPRINT-RULE:
  }).sort((a, b) => a.price - b.price); // FOOTPRINT-RULE:

  const frozen: FrozenImbalanceZone[] = []; // FOOTPRINT-RULE:
  let csIdx = -1, csDir: "buy" | "sell" | null = null, csDelta = 0, csCount = 0; // FOOTPRINT-RULE:
  const flushCluster = (end: number) => { // FOOTPRINT-RULE:
    if (csIdx < 0 || !csDir) return; // FOOTPRINT-RULE:
    const cnt = end - csIdx; // FOOTPRINT-RULE:
    if (cnt >= 3) { // FOOTPRINT-RULE: stacked only
      frozen.push({ // FOOTPRINT-RULE:
        sessionType, sessionStart, sessionEnd, // FOOTPRINT-RULE:
        topPrice:    sorted[end - 1].price, // FOOTPRINT-RULE:
        bottomPrice: sorted[csIdx].price, // FOOTPRINT-RULE:
        midPrice:    (sorted[csIdx].price + sorted[end - 1].price) / 2, // FOOTPRINT-RULE:
        direction:   csDir, levelCount: cnt, totalDelta: csDelta, // FOOTPRINT-RULE:
        mitigated: false, mitigatedAt: null, active: true, // FOOTPRINT-RULE:
      }); // FOOTPRINT-RULE:
    } // FOOTPRINT-RULE:
    csIdx = -1; csDir = null; csDelta = 0; csCount = 0; // FOOTPRINT-RULE:
  }; // FOOTPRINT-RULE:
  for (let i = 0; i < sorted.length; i++) { // FOOTPRINT-RULE:
    const lv = sorted[i]; // FOOTPRINT-RULE:
    if (lv.imbalance !== "none") { // FOOTPRINT-RULE:
      if (lv.imbalance === csDir) { csDelta += lv.askVol - lv.bidVol; csCount++; } // FOOTPRINT-RULE:
      else { flushCluster(i); csIdx = i; csDir = lv.imbalance; csDelta = lv.askVol - lv.bidVol; csCount = 1; } // FOOTPRINT-RULE:
    } else flushCluster(i); // FOOTPRINT-RULE:
  } // FOOTPRINT-RULE:
  flushCluster(sorted.length); // FOOTPRINT-RULE:
  return frozen; // FOOTPRINT-RULE:
} // FOOTPRINT-RULE:

// FOOTPRINT-RULE: mitigation uses candle CLOSE only — wick touch ignored.
export function updateMitigation( // FOOTPRINT-RULE:
  zones: FrozenImbalanceZone[], // FOOTPRINT-RULE:
  candlesAfterSession: CandleBar[] // FOOTPRINT-RULE:
): FrozenImbalanceZone[] { // FOOTPRINT-RULE:
  const sorted2 = [...candlesAfterSession].sort((a, b) => a.time - b.time); // FOOTPRINT-RULE:
  return zones.map(zone => { // FOOTPRINT-RULE:
    if (zone.mitigated) return zone; // FOOTPRINT-RULE:
    for (const c of sorted2) { // FOOTPRINT-RULE:
      if (c.time < zone.sessionEnd) continue; // FOOTPRINT-RULE: only post-session candles
      // FOOTPRINT-RULE: close must breach midPrice — wick touch is NOT mitigation
      const longMitigated  = zone.direction === "buy"  && c.close < zone.midPrice; // FOOTPRINT-RULE:
      const shortMitigated = zone.direction === "sell" && c.close > zone.midPrice; // FOOTPRINT-RULE:
      if (longMitigated || shortMitigated) { // FOOTPRINT-RULE:
        return { ...zone, mitigated: true, mitigatedAt: c.time, active: false }; // FOOTPRINT-RULE:
      } // FOOTPRINT-RULE:
    } // FOOTPRINT-RULE:
    return zone; // FOOTPRINT-RULE:
  }); // FOOTPRINT-RULE:
} // FOOTPRINT-RULE:

export function buildCandleFootprints( // FOOTPRINT-RENDER:
  candles: OHLCVBar[] // FOOTPRINT-RENDER:
): Map<number, FootprintCandle> { // FOOTPRINT-RENDER:
  const map = new Map<number, FootprintCandle>(); // FOOTPRINT-RENDER:
  for (const c of candles) { // FOOTPRINT-RENDER:
    map.set(c.time, buildProxyFootprintCandle(c)); // FOOTPRINT-RENDER:
  } // FOOTPRINT-RENDER:
  return map; // FOOTPRINT-RENDER:
} // FOOTPRINT-RENDER:
