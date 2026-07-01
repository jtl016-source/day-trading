// footprint.ts — iPhone port of the PC's footprint analysis + session aggregation, so the
// phone draws the SAME footprint as the PC chart (session ladders + cluster imbalance zones).
//
// Verbatim ports of:
//   client/src/lib/footprint-analysis.ts  → buildProxyFootprintCandle + types + constants
//   client/src/components/terminal/footprintAggregate.ts → aggregateSessions (+ buildSession, isRthSec)
//
// The phone runs in PROXY mode (FOOTPRINT_DATA_CONFIRMED = false), exactly as it always has —
// real per-candle bid/ask from /api/footprint/history still UPGRADES sessions where it lines up.

export const MW_IMBALANCE_THRESHOLDS = { tier1: 4.0, tier2: 5.0, tier3: 6.0 } as const;
export const NET_THRESHOLDS = { tier1: 100, tier2: 200, tier3: 400 } as const;
export const PROXY_TIER2 = 2.0, PROXY_TIER3 = 2.5;
export const FOOTPRINT_DATA_CONFIRMED = false;          // proxy mode (matches the iPhone's data reality)
export const IMBALANCE_THRESHOLD = FOOTPRINT_DATA_CONFIRMED ? MW_IMBALANCE_THRESHOLDS.tier1 : 1.5;

export interface OHLCVBar { time: number; open: number; high: number; low: number; close: number; volume?: number; }
export interface PriceLevelData { price: number; bidVol: number; askVol: number; delta: number; net: number; imbalance: 'buy' | 'sell' | 'none'; }
export interface AbsorptionEvent { price: number; side: 'buy' | 'sell'; volume: number; priceHeld: boolean; }
export interface ImbalanceCluster { startPrice: number; endPrice: number; direction: 'buy' | 'sell'; levelCount: number; stacked: boolean; totalDelta: number; strengthTier: 1 | 2 | 3; }
export interface UnfinishedAuction { price: number; side: 'buy' | 'sell'; atExtreme: 'high' | 'low'; }
export interface FootprintCandle {
  symbol: string; interval: string; time: number;
  levels: PriceLevelData[]; totalBidVol: number; totalAskVol: number; candleDelta: number;
  poc: number; vah: number; val: number; high: number; low: number;
  absorption: AbsorptionEvent | null; imbalances: ImbalanceCluster[]; unfinishedAuction: UnfinishedAuction | null; complete: boolean;
}

// ── OHLCV proxy footprint (verbatim from footprint-analysis.ts buildProxyFootprintCandle) ──
export function buildProxyFootprintCandle(c: OHLCVBar): FootprintCandle {
  const vol  = c.volume ?? 100;
  const isUp = c.close >= c.open;
  const bodyBottom = Math.min(c.open, c.close);
  const bodyTop    = Math.max(c.open, c.close);

  const wLow  = Math.floor(c.low);
  const wHigh = Math.ceil(c.high);
  const allPrices: number[] = [];
  for (let wp = wLow; wp <= wHigh; wp++) allPrices.push(wp);
  if (!allPrices.length) allPrices.push(Math.round(c.low));

  const bodyTicks = Math.max(1, allPrices.filter(p => p >= bodyBottom - 0.5 && p <= bodyTop + 0.5).length);
  const wickTicks = Math.max(1, allPrices.length - bodyTicks);
  const volPerBodyTick = (vol * 0.70) / bodyTicks;
  const volPerWickTick = (vol * 0.30) / wickTicks;

  const levels: PriceLevelData[] = [];
  let poc = allPrices[0];
  let maxLvVol = 0;

  for (const price of allPrices) {
    const inBody = price >= bodyBottom - 0.5 && price <= bodyTop + 0.5;
    const lv = inBody ? volPerBodyTick : volPerWickTick;
    let bidVol: number, askVol: number;
    if (inBody) {
      const bodyRange = bodyTop - bodyBottom;
      const relPos = bodyRange > 0.5 ? (price - bodyBottom) / bodyRange : 0.5;
      if (isUp) { const askRatio = 0.75 - relPos * 0.20; askVol = lv * askRatio; bidVol = lv * (1 - askRatio); }
      else      { const bidRatio = 0.75 - (1 - relPos) * 0.20; bidVol = lv * bidRatio; askVol = lv * (1 - bidRatio); }
    } else if (price < bodyBottom) {
      if (isUp) { askVol = lv * 0.60; bidVol = lv * 0.40; } else { bidVol = lv * 0.70; askVol = lv * 0.30; }
    } else {
      if (isUp) { bidVol = lv * 0.70; askVol = lv * 0.30; } else { askVol = lv * 0.60; bidVol = lv * 0.40; }
    }
    const delta = askVol - bidVol;
    const buyRatio  = bidVol > 0 ? askVol / bidVol : askVol > 0 ? 999 : 1;
    const sellRatio = askVol > 0 ? bidVol / askVol : bidVol > 0 ? 999 : 1;
    const imbalance: 'buy' | 'sell' | 'none' =
      buyRatio >= IMBALANCE_THRESHOLD ? 'buy' : sellRatio >= IMBALANCE_THRESHOLD ? 'sell' : 'none';
    levels.push({ price, bidVol, askVol, delta, net: Math.abs(askVol - bidVol), imbalance });
    if (bidVol + askVol > maxLvVol) { maxLvVol = bidVol + askVol; poc = price; }
  }

  const totalVol = levels.reduce((s, l) => s + l.bidVol + l.askVol, 0);
  const target = totalVol * 0.70;
  let accum = 0, vah = poc, val = poc;
  let hi = levels.findIndex(l => Math.abs(l.price - poc) < 0.5); if (hi < 0) hi = 0;
  let lo = hi;
  while (accum < target && (hi < levels.length - 1 || lo > 0)) {
    const upV = hi < levels.length - 1 ? levels[hi + 1].bidVol + levels[hi + 1].askVol : 0;
    const dnV = lo > 0 ? levels[lo - 1].bidVol + levels[lo - 1].askVol : 0;
    if (upV >= dnV && hi < levels.length - 1) { hi++; accum += upV; vah = levels[hi].price; }
    else if (lo > 0)                           { lo--; accum += dnV; val = levels[lo].price; }
    else                                       { break; }
  }

  const avgLvVol = levels.length ? totalVol / levels.length : 1;
  let absorption: AbsorptionEvent | null = null;
  const topLv = levels[levels.length - 1];
  const botLv = levels[0];
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  if (isUp && upperWick >= 1.0 && topLv && topLv.bidVol >= avgLvVol * 1.5)
    absorption = { price: topLv.price, side: 'sell', volume: topLv.bidVol, priceHeld: true };
  else if (!isUp && lowerWick >= 1.0 && botLv && botLv.askVol >= avgLvVol * 1.5)
    absorption = { price: botLv.price, side: 'buy', volume: botLv.askVol, priceHeld: true };

  const imbalances: ImbalanceCluster[] = [];
  let csIdx = -1, csDir: 'buy' | 'sell' | null = null, csDelta = 0, csAsk = 0, csBid = 0;
  const flushCluster = (end: number) => {
    if (csIdx < 0 || csDir == null) return;
    const cnt = end - csIdx;
    const clRatio = csDir === 'buy' ? (csBid > 0 ? csAsk / csBid : 999) : (csAsk > 0 ? csBid / csAsk : 999);
    const clNet   = cnt > 0 ? Math.abs(csAsk - csBid) / cnt : 0;
    let strengthTier: 1 | 2 | 3 = 1;
    if (FOOTPRINT_DATA_CONFIRMED) {
      if (clRatio >= MW_IMBALANCE_THRESHOLDS.tier3 && clNet >= NET_THRESHOLDS.tier3) strengthTier = 3;
      else if (clRatio >= MW_IMBALANCE_THRESHOLDS.tier2 && clNet >= NET_THRESHOLDS.tier2) strengthTier = 2;
    } else {
      if (clRatio >= PROXY_TIER3 * IMBALANCE_THRESHOLD) strengthTier = 3;
      else if (clRatio >= PROXY_TIER2 * IMBALANCE_THRESHOLD) strengthTier = 2;
    }
    imbalances.push({ startPrice: levels[csIdx].price, endPrice: levels[end - 1].price,
      direction: csDir, levelCount: cnt, stacked: cnt >= 3, totalDelta: csDelta, strengthTier });
    csIdx = -1; csDir = null; csDelta = 0; csAsk = 0; csBid = 0;
  };
  for (let i = 0; i < levels.length; i++) {
    const lev = levels[i];
    if (lev.imbalance !== 'none') {
      if (lev.imbalance === csDir) { csDelta += lev.delta; csAsk += lev.askVol; csBid += lev.bidVol; }
      else { flushCluster(i); csIdx = i; csDir = lev.imbalance; csDelta = lev.delta; csAsk = lev.askVol; csBid = lev.bidVol; }
    } else { flushCluster(i); }
  }
  flushCluster(levels.length);

  let unfinishedAuction: UnfinishedAuction | null = null;
  const range = Math.max(c.high - c.low, 1.0);
  if (range > 2.0) {
    if (upperWick < 1.0)      unfinishedAuction = { price: c.high, side: 'buy',  atExtreme: 'high' };
    else if (lowerWick < 1.0) unfinishedAuction = { price: c.low,  side: 'sell', atExtreme: 'low'  };
  }

  const totalBidVol = levels.reduce((s, l) => s + l.bidVol, 0);
  const totalAskVol = levels.reduce((s, l) => s + l.askVol, 0);
  return {
    symbol: '', interval: '', time: c.time, levels, totalBidVol, totalAskVol,
    candleDelta: totalAskVol - totalBidVol, poc, vah, val, high: c.high, low: c.low,
    absorption, imbalances, unfinishedAuction, complete: true,
  };
}

// ── Session aggregation (verbatim from footprintAggregate.ts) ──────────────────
const _rthFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
function isRthSec(ts: number): boolean {
  const p = _rthFmt.formatToParts(new Date(ts * 1000));
  const wd = p.find((x) => x.type === 'weekday')?.value ?? '';
  if (wd === 'Sat' || wd === 'Sun') return false;
  const h = parseInt(p.find((x) => x.type === 'hour')?.value ?? '0', 10) % 24;
  const m = parseInt(p.find((x) => x.type === 'minute')?.value ?? '0', 10);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 17 * 60;
}

function buildSession(candles: FootprintCandle[], anchorTime: number, label: 'RTH' | 'ETH'): FootprintCandle | null {
  const combined = new Map<number, { bid: number; ask: number }>();
  for (const c of candles) {
    for (const lv of c.levels ?? []) {
      const e = combined.get(lv.price) ?? { bid: 0, ask: 0 };
      e.bid += lv.bidVol; e.ask += lv.askVol; combined.set(lv.price, e);
    }
  }
  if (combined.size === 0) return null;
  const prices = [...combined.keys()].sort((a, b) => a - b);
  let maxVol = 0, poc = prices[0];
  for (const [price, { bid, ask }] of combined) if (bid + ask > maxVol) { maxVol = bid + ask; poc = price; }
  const totalVol = prices.reduce((s, p) => s + combined.get(p)!.bid + combined.get(p)!.ask, 0);
  const pocIdx = prices.indexOf(poc);
  let lo = pocIdx, hi = pocIdx;
  let accVol = combined.get(poc)!.bid + combined.get(poc)!.ask;
  while (accVol < totalVol * 0.7) {
    const lv2 = lo > 0 ? combined.get(prices[lo - 1])!.bid + combined.get(prices[lo - 1])!.ask : 0;
    const hv2 = hi < prices.length - 1 ? combined.get(prices[hi + 1])!.bid + combined.get(prices[hi + 1])!.ask : 0;
    if (!lv2 && !hv2) break;
    if (lv2 >= hv2 && lo > 0) { lo--; accVol += lv2; }
    else if (hi < prices.length - 1) { hi++; accVol += hv2; }
    else break;
  }
  const levels: PriceLevelData[] = prices.map((price) => {
    const { bid, ask } = combined.get(price)!;
    const buyR = bid > 0 ? ask / bid : ask > 0 ? 999 : 1;
    const selR = ask > 0 ? bid / ask : bid > 0 ? 999 : 1;
    const imbalance: 'buy' | 'sell' | 'none' = buyR >= IMBALANCE_THRESHOLD ? 'buy' : selR >= IMBALANCE_THRESHOLD ? 'sell' : 'none';
    return { price, bidVol: bid, askVol: ask, delta: ask - bid, net: Math.abs(ask - bid), imbalance };
  });
  const imbalances: ImbalanceCluster[] = [];
  let csIdx = -1, csDir: 'buy' | 'sell' | null = null, csDelta = 0, csAsk2 = 0, csBid2 = 0;
  const flush = (end: number) => {
    if (csIdx < 0 || !csDir) return;
    const cnt = end - csIdx;
    const clRatio2 = csDir === 'buy' ? (csBid2 > 0 ? csAsk2 / csBid2 : 999) : (csAsk2 > 0 ? csBid2 / csAsk2 : 999);
    const clNet2 = cnt > 0 ? Math.abs(csAsk2 - csBid2) / cnt : 0;
    let strengthTier: 1 | 2 | 3 = 1;
    if (FOOTPRINT_DATA_CONFIRMED) {
      if (clRatio2 >= MW_IMBALANCE_THRESHOLDS.tier3 && clNet2 >= NET_THRESHOLDS.tier3) strengthTier = 3;
      else if (clRatio2 >= MW_IMBALANCE_THRESHOLDS.tier2 && clNet2 >= NET_THRESHOLDS.tier2) strengthTier = 2;
    } else {
      if (clRatio2 >= PROXY_TIER2 * IMBALANCE_THRESHOLD) strengthTier = clRatio2 >= PROXY_TIER3 * IMBALANCE_THRESHOLD ? 3 : 2;
    }
    imbalances.push({ startPrice: levels[csIdx].price, endPrice: levels[end - 1].price,
      direction: csDir, levelCount: cnt, stacked: cnt >= 3, totalDelta: csDelta, strengthTier });
    csIdx = -1; csDir = null; csDelta = 0; csAsk2 = 0; csBid2 = 0;
  };
  for (let i = 0; i < levels.length; i++) {
    const lev = levels[i];
    if (lev.imbalance !== 'none') {
      if (lev.imbalance === csDir) { csDelta += lev.delta; csAsk2 += lev.askVol; csBid2 += lev.bidVol; }
      else { flush(i); csIdx = i; csDir = lev.imbalance; csDelta = lev.delta; csAsk2 = lev.askVol; csBid2 = lev.bidVol; }
    } else flush(i);
  }
  flush(levels.length);
  return {
    symbol: label, interval: '', time: anchorTime, levels, poc,
    vah: prices[hi], val: prices[lo], high: prices[prices.length - 1], low: prices[0],
    totalBidVol: prices.reduce((s, p) => s + combined.get(p)!.bid, 0),
    totalAskVol: prices.reduce((s, p) => s + combined.get(p)!.ask, 0),
    candleDelta: 0, absorption: null, unfinishedAuction: null, complete: true, imbalances,
  };
}

/** Group per-candle footprints into RTH/ETH session aggregates (newest last), each anchored
 *  at its session's FIRST candle time so the on-chart ladder anchors to the session start. */
export function aggregateSessions(perCandle: FootprintCandle[], maxSessions = 40): FootprintCandle[] {
  const sorted = [...perCandle].filter((c) => c && Array.isArray(c.levels)).sort((a, b) => a.time - b.time);
  if (!sorted.length) return [];
  const sessions: { type: 'RTH' | 'ETH'; candles: FootprintCandle[] }[] = [];
  let prevIsRth: boolean | null = null;
  let cur: (typeof sessions)[0] | null = null;
  for (const c of sorted) {
    const rth = isRthSec(c.time);
    if (rth !== prevIsRth) { cur = { type: rth ? 'RTH' : 'ETH', candles: [] }; sessions.push(cur); prevIsRth = rth; }
    cur!.candles.push(c);
  }
  const out: FootprintCandle[] = [];
  for (const s of sessions.slice(-maxSessions)) {
    if (s.candles.length < 1) continue;
    const agg = buildSession(s.candles, s.candles[0].time, s.type);
    if (agg) out.push(agg);
  }
  return out;
}

/** Build session aggregates from display candles (proxy), upgraded with REAL per-candle
 *  footprint levels where their times line up (mirrors PC TerminalLiveChart.buildSessions). */
export function buildFootprintSessions(
  candles: OHLCVBar[],
  realByTime?: Map<number, FootprintCandle>,
): FootprintCandle[] {
  const valid = candles.filter((c) => c && c.high >= c.low);
  return aggregateSessions(
    valid.map((c) => realByTime?.get(c.time) ?? buildProxyFootprintCandle(c)),
  );
}
