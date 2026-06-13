import { type CandleBar, type ZoneBand } from "@/components/CandlestickChart";

// ── Constants ─────────────────────────────────────────────────────────────────
export const VEC_LENGTH = 20;

// ── MW color tokens (Midnight Glow theme — canonical source of truth) ─────────
// Deep navy + electric-blue glow. Used by all secondary pages' chrome.
export const MW = {
  bg:        "#060b14",
  panel:     "#0a1322",
  toolbar:   "#0b1626",
  border:    "#18293f",
  text:      "#cdd9ea",
  muted:     "#647fa6",
  accent:    "#2f9bff",
  accentHov: "#54b3ff",
  accent2:   "#38e0ff",
  glow:      "rgba(47,155,255,0.45)",
  up:        "#2196f3",
  down:      "#ef4444",
};

// ── DST-safe RTH helpers ──────────────────────────────────────────────────────
// Pre-built Intl formatters so we don't re-allocate on every call in hot loops.
const _nyTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
});
const _nyDayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short",
});

/** Returns true if the Unix timestamp (seconds) falls within RTH: Mon–Fri, 9:30am–5:00pm ET.
 *  Uses Intl.DateTimeFormat for correct DST handling (EDT = UTC-4, EST = UTC-5). */
export function isRTH(timestampSec: number): boolean {
  const d = new Date(timestampSec * 1000);
  const day = _nyDayFmt.format(d);
  if (day === "Sat" || day === "Sun") return false;
  const et = _nyTimeFmt.format(d);
  const col = et.indexOf(":");
  const etMins = parseInt(et.slice(0, col)) * 60 + parseInt(et.slice(col + 1));
  return etMins >= 9 * 60 + 30 && etMins < 17 * 60; // 9:30 AM – 5:00 PM ET
}

/** Returns the Unix timestamp of 21:00 UTC (RTH close) on the same calendar day as `ts`. */
export function rthCloseOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 21 * 3600;
}

/** Returns the Unix timestamp of 20:30 UTC (4:30 PM EDT / CME settlement) on the same calendar day as `ts`.
 *  Milk zones are scoped to the regular session and must end at market close (4:30 PM ET). */
export function rthSettleOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 20 * 3600 + 30 * 60;
}

/** Returns the Unix timestamp of 13:30 UTC (9:30 AM ET / RTH open) on the same calendar day as `ts`. */
export function rthOpenOfDay(ts: number): number {
  return Math.floor(ts / 86400) * 86400 + 13 * 3600 + 30 * 60;
}

// ── Vector computation ────────────────────────────────────────────────────────
// O(n) sliding-window min/max using monotonic deques — replaces O(n * VEC_LENGTH).
// Uses ALL bars (RTH + ETH): matches ThinkorSwim vectorexitstrat behaviour.
export function computeVectorLine(candles: CandleBar[]): Array<{ time: number; value: number }> {
  if (!candles.length) return [];
  const s = [...candles].sort((a, b) => a.time - b.time);
  const n = s.length;
  const lb = new Float64Array(n);

  // Pass 1: Lowest(low, VEC_LENGTH) via monotonic min-deque
  const dq1 = new Int32Array(n);
  let d1f = 0, d1b = 0;
  for (let i = 0; i < n; i++) {
    while (d1f < d1b && dq1[d1f] <= i - VEC_LENGTH) d1f++;
    while (d1f < d1b && s[dq1[d1b - 1]].low >= s[i].low) d1b--;
    dq1[d1b++] = i;
    lb[i] = s[dq1[d1f]].low;
  }

  // Pass 2: Highest(LowerBand, VEC_LENGTH) via monotonic max-deque
  const result: Array<{ time: number; value: number }> = new Array(n);
  const dq2 = new Int32Array(n);
  let d2f = 0, d2b = 0;
  for (let i = 0; i < n; i++) {
    while (d2f < d2b && dq2[d2f] <= i - VEC_LENGTH) d2f++;
    while (d2f < d2b && lb[dq2[d2b - 1]] <= lb[i]) d2b--;
    dq2[d2b++] = i;
    result[i] = { time: s[i].time, value: lb[dq2[d2f]] };
  }
  return result;
}

/** Map version for callers that need O(1) lookup by timestamp (backtest, timestamps page). */
export function computeVectorLineMap(candles: CandleBar[]): Map<number, number> {
  return new Map(computeVectorLine(candles).map(v => [v.time, v.value]));
}

// ── Zone detection ────────────────────────────────────────────────────────────
// historyBars: how many recent RTH bars to scan (0 = all). displayCap: max zones returned (0 = all).
export function detectMilkZones(candles: CandleBar[], historyBars = 234, displayCap = 60): ZoneBand[] {
  const rth = [...candles].sort((a, b) => a.time - b.time).filter(c => c.rth !== false);
  const zones: ZoneBand[] = [];

  const lastRthBarBefore430 = new Map<number, number>();
  for (const c of rth) {
    const secsIntoDay = c.time % 86400;
    if (secsIntoDay >= 20 * 3600 + 30 * 60) continue;
    const day = Math.floor(c.time / 86400);
    lastRthBarBefore430.set(day, c.time);
  }
  const sessionEndOf = (ts: number): number =>
    lastRthBarBefore430.get(Math.floor(ts / 86400)) ?? rthSettleOfDay(ts);

  const atrAt = (i: number): number => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - 13); j <= i; j++) {
      const b = rth[j], p = j > 0 ? rth[j - 1] : b;
      s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
      n++;
    }
    return n > 0 ? s / n : 2;
  };

  const startIdx = historyBars > 0 ? Math.max(0, rth.length - historyBars) : 0;
  for (let i = startIdx + 1; i < rth.length - 1; i++) {
    const prev = rth[i - 1], curr = rth[i], next = rth[i + 1];
    const atr  = atrAt(i);

    if (prev.high < next.low && next.low - prev.high >= 0.5)
      zones.push({ topPrice: next.low, bottomPrice: prev.high, color: "#22c55e", label: "IMBALANCE", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    if (prev.low > next.high && prev.low - next.high >= 0.5)
      zones.push({ topPrice: prev.low, bottomPrice: next.high, color: "#ef4444", label: "RESIST IMBALANCE", fromTime: curr.time, toTime: sessionEndOf(curr.time) });

    if (curr.close < curr.open) {
      let maxUp = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++) maxUp = Math.max(maxUp, rth[j].high - curr.high);
      if (maxUp >= atr * 1.5)
        zones.push({ topPrice: Math.max(curr.open, curr.close), bottomPrice: curr.low, color: "#3b82f6", label: "ABSORPTION", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    }
    if (curr.close > curr.open) {
      let maxDown = 0;
      for (let j = i + 1; j <= Math.min(rth.length - 1, i + 4); j++) maxDown = Math.max(maxDown, curr.low - rth[j].low);
      if (maxDown >= atr * 1.5)
        zones.push({ topPrice: curr.high, bottomPrice: Math.min(curr.open, curr.close), color: "#f97316", label: "RESISTIVE", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    }

    const LB = 3;
    let isHigh = true, isLow = true;
    for (let j = Math.max(0, i - LB); j < i; j++) {
      if (rth[j].high >= curr.high) isHigh = false;
      if (rth[j].low  <= curr.low)  isLow  = false;
    }
    for (let j = i + 1; j <= Math.min(rth.length - 1, i + LB); j++) {
      if (rth[j].high >= curr.high) isHigh = false;
      if (rth[j].low  <= curr.low)  isLow  = false;
    }
    const sz = Math.max(atr * 0.25, 1.5);
    if (isHigh)
      zones.push({ topPrice: curr.high + sz * 0.15, bottomPrice: curr.high - sz, color: "#f43f5e", label: "STRUCTURAL RESIST", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
    if (isLow)
      zones.push({ topPrice: curr.low + sz, bottomPrice: curr.low - sz * 0.15, color: "#14b8a6", label: "STRUCTURAL SUPPORT", fromTime: curr.time, toTime: sessionEndOf(curr.time) });
  }
  return displayCap > 0 ? zones.slice(-displayCap) : zones;
}

// ── Candle aggregation ────────────────────────────────────────────────────────
// FIX-3: 60m buckets are offset by 30 min so the RTH open bar (13:30 UTC EDT / 14:30 UTC EST)
// starts its own bucket instead of falling into the 13:00 UTC bucket.
// All downstream 60m bucket lookups must use get60mBucket() to stay aligned.
const AGG_60M_OFFSET = 30 * 60; // 1800 s

/** Bucket key for a given timestamp at 60m resolution (offset to :30 boundaries). */
export function get60mBucket(ts: number): number {
  return Math.floor((ts - AGG_60M_OFFSET) / 3600) * 3600 + AGG_60M_OFFSET;
}

export function aggToInterval(candles: CandleBar[], intervalSec: number): CandleBar[] {
  if (!candles.length) return [];
  const s = [...candles].sort((a, b) => a.time - b.time);
  const map = new Map<number, CandleBar>();
  for (const c of s) {
    const bucket = intervalSec === 3600
      ? get60mBucket(c.time)
      : Math.floor(c.time / intervalSec) * intervalSec;
    const ex = map.get(bucket);
    if (!ex) {
      map.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, rth: c.rth });
    } else {
      ex.high   = Math.max(ex.high, c.high);
      ex.low    = Math.min(ex.low,  c.low);
      ex.close  = c.close;
      ex.volume = (ex.volume ?? 0) + (c.volume ?? 0);
      if (!ex.rth && c.rth) ex.rth = c.rth;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

// ── Vector forward-fill ───────────────────────────────────────────────────────
// For each chart time T, emits the last vector value whose time ≤ T.
export function forwardFillVector(
  vec: Array<{ time: number; value: number }>,
  chartTimes: number[]
): Array<{ time: number; value: number }> {
  if (!vec.length || !chartTimes.length) return [];
  const sorted = [...vec].sort((a, b) => a.time - b.time);
  const result: Array<{ time: number; value: number }> = [];
  let vi = 0;
  for (const t of chartTimes) {
    while (vi + 1 < sorted.length && sorted[vi + 1].time <= t) vi++;
    if (sorted[vi] && sorted[vi].time <= t) result.push({ time: t, value: sorted[vi].value });
  }
  return result;
}
