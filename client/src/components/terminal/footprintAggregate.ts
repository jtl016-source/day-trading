// footprintAggregate.ts — group REAL per-candle MW footprints (from /api/footprint/history)
// into RTH/ETH session aggregates with POC / value-area / imbalance clusters. This is a port
// of market.tsx `buildAggregate`, except it sums the REAL per-candle `levels` (bid/ask) instead
// of the proxy `buildProxyFootprintCandle`. Each session aggregate is keyed by its first
// candle's time so the on-chart ladder anchors there (the "old" footprint behavior).
import {
  IMBALANCE_THRESHOLD, MW_IMBALANCE_THRESHOLDS, NET_THRESHOLDS, PROXY_TIER2, PROXY_TIER3,
  FOOTPRINT_DATA_CONFIRMED,
  type FootprintCandle, type PriceLevelData, type ImbalanceCluster,
} from "@/lib/footprint-analysis";

// DST-safe RTH check (09:30–16:00 ET, Mon–Fri) — used to split the session runs.
const _rthFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
function isRthSec(ts: number): boolean {
  const p = _rthFmt.formatToParts(new Date(ts * 1000));
  const wd = p.find((x) => x.type === "weekday")?.value ?? "";
  if (wd === "Sat" || wd === "Sun") return false;
  const h = parseInt(p.find((x) => x.type === "hour")?.value ?? "0", 10) % 24;
  const m = parseInt(p.find((x) => x.type === "minute")?.value ?? "0", 10);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 17 * 60; // 9:30 AM – 5:00 PM ET
}

// Build one session aggregate from the real per-candle footprints in that session.
function buildSession(candles: FootprintCandle[], anchorTime: number, label: "RTH" | "ETH"): FootprintCandle | null {
  const combined = new Map<number, { bid: number; ask: number }>();
  for (const c of candles) {
    for (const lv of c.levels ?? []) {
      const e = combined.get(lv.price) ?? { bid: 0, ask: 0 };
      e.bid += lv.bidVol; e.ask += lv.askVol;
      combined.set(lv.price, e);
    }
  }
  if (combined.size === 0) return null;

  const prices = [...combined.keys()].sort((a, b) => a - b);

  // POC = highest-volume price.
  let maxVol = 0, poc = prices[0];
  for (const [price, { bid, ask }] of combined) if (bid + ask > maxVol) { maxVol = bid + ask; poc = price; }

  // Value area = expand out from POC until 70% of total volume is enclosed.
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
    const imbalance: "buy" | "sell" | "none" =
      buyR >= IMBALANCE_THRESHOLD ? "buy" : selR >= IMBALANCE_THRESHOLD ? "sell" : "none";
    return { price, bidVol: bid, askVol: ask, delta: ask - bid, net: Math.abs(ask - bid), imbalance };
  });

  // Stacked imbalance clusters (consecutive same-direction levels).
  const imbalances: ImbalanceCluster[] = [];
  let csIdx = -1, csDir: "buy" | "sell" | null = null, csDelta = 0, csAsk2 = 0, csBid2 = 0;
  const flush = (end: number) => {
    if (csIdx < 0 || !csDir) return;
    const cnt = end - csIdx;
    const clRatio2 = csDir === "buy" ? (csBid2 > 0 ? csAsk2 / csBid2 : 999) : (csAsk2 > 0 ? csBid2 / csAsk2 : 999);
    const clNet2 = cnt > 0 ? Math.abs(csAsk2 - csBid2) / cnt : 0;
    let strengthTier: 1 | 2 | 3 = 1;
    if (FOOTPRINT_DATA_CONFIRMED) {
      if (clRatio2 >= MW_IMBALANCE_THRESHOLDS.tier3 && clNet2 >= NET_THRESHOLDS.tier3) strengthTier = 3;
      else if (clRatio2 >= MW_IMBALANCE_THRESHOLDS.tier2 && clNet2 >= NET_THRESHOLDS.tier2) strengthTier = 2;
    } else {
      if (clRatio2 >= PROXY_TIER2 * IMBALANCE_THRESHOLD) strengthTier = clRatio2 >= PROXY_TIER3 * IMBALANCE_THRESHOLD ? 3 : 2;
    }
    imbalances.push({
      startPrice: levels[csIdx].price, endPrice: levels[end - 1].price,
      direction: csDir, levelCount: cnt, stacked: cnt >= 3, totalDelta: csDelta, strengthTier,
    });
    csIdx = -1; csDir = null; csDelta = 0; csAsk2 = 0; csBid2 = 0;
  };
  for (let i = 0; i < levels.length; i++) {
    const lev = levels[i];
    if (lev.imbalance !== "none") {
      if (lev.imbalance === csDir) { csDelta += lev.delta; csAsk2 += lev.askVol; csBid2 += lev.bidVol; }
      else { flush(i); csIdx = i; csDir = lev.imbalance; csDelta = lev.delta; csAsk2 = lev.askVol; csBid2 = lev.bidVol; }
    } else flush(i);
  }
  flush(levels.length);

  return {
    symbol: label, interval: "", time: anchorTime, levels, poc,
    vah: prices[hi], val: prices[lo],
    high: prices[prices.length - 1], low: prices[0],
    totalBidVol: prices.reduce((s, p) => s + combined.get(p)!.bid, 0),
    totalAskVol: prices.reduce((s, p) => s + combined.get(p)!.ask, 0),
    candleDelta: 0, absorption: null, unfinishedAuction: null, complete: true, imbalances,
  };
}

/**
 * Group real per-candle footprints into RTH/ETH session aggregates (newest sessions last).
 * Each aggregate's `time` is its session's FIRST candle time so the on-chart ladder anchors
 * to the session start. Returns at most the last `maxSessions` sessions.
 */
export function aggregateSessions(perCandle: FootprintCandle[], maxSessions = 40): FootprintCandle[] {
  const sorted = [...perCandle].filter((c) => c && Array.isArray(c.levels)).sort((a, b) => a.time - b.time);
  if (!sorted.length) return [];

  const sessions: { type: "RTH" | "ETH"; candles: FootprintCandle[] }[] = [];
  let prevIsRth: boolean | null = null;
  let cur: (typeof sessions)[0] | null = null;
  for (const c of sorted) {
    const rth = isRthSec(c.time);
    if (rth !== prevIsRth) { cur = { type: rth ? "RTH" : "ETH", candles: [] }; sessions.push(cur); prevIsRth = rth; }
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
