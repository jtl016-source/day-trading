// shared/live-adapter.ts
// ═════════════════════════════════════════════════════════════════════════════
// THE LIVE ADAPTER'S ENGINE-INPUT CONSTRUCTION — extracted VERBATIM from
// client/src/pages/market.tsx (2026-07-17) so the parity test
// (scripts/fact-engine-parity.test.ts) exercises the LITERAL functions the live
// chart uses to build runFactEngine's inputs. market.tsx imports these; any edit
// here changes the live chart AND the parity test together — construction drift
// between live and backtest is structurally impossible while both import this.
//
// Contents (all pure, framework-free):
//   • filterCandlesForVector — the secondary-slice candle filter (validity + isolation)
//   • buildBaseCandles       — the PRIMARY slice filter chain (timestamp sanity, validity,
//                              showETH gate, >20%-from-prev outlier, phantom-bar midpoint,
//                              isolation) = market.tsx's baseCandles memo
//   • normalizeServed15m     — the 15m candleData handling (native-15 alignment vs 5m→15m agg)
//   • computeVectorLine      — O(n) monotonic-deque Highest(Lowest(low,20),20)
//   • aggToInterval / agg5mTo15m — bucket aggregation helpers
//   • deriveEngineSlices     — the per-primary secondary-slice derivation feeding runFactEngine
//   • buildFootprintMap      — REAL-only footprint imbalance zones (C12: no proxy fabrication)
// ═════════════════════════════════════════════════════════════════════════════
import type { IntervalSlice, FpImbalanceZone, Interval as FeInterval } from "./fact-engine";

/** Structural candle shape (client CandleBar-compatible). */
export interface LiveCandle {
  time: number; open: number; high: number; low: number; close: number;
  volume?: number; rth?: boolean; complete?: boolean;
}

const VEC_LENGTH = 20;

// ── Candle sanity filter (secondary slices) ──────────────────────────────────
// Removes: zero/NaN values, doji-spike bars, extreme wick bars, and isolated bars
// that don't share price range with at least 7 of their nearest 50 neighbours.
export function filterCandlesForVector<T extends LiveCandle>(raw: T[]): T[] {
  if (!raw.length) return raw;
  const MIN_P = 1, MAX_P = 9e13;
  const pass = raw
    .filter(c => {
      if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) return false;
      if (c.open < MIN_P || c.high < MIN_P || c.low < MIN_P || c.close < MIN_P) return false;
      if (c.open >= MAX_P || c.high >= MAX_P || c.low >= MAX_P || c.close >= MAX_P) return false;
      if (c.high <= c.low) return false;
      const range = c.high - c.low;
      if (range / c.close > 0.015 && Math.abs(c.open - c.close) / range < 0.10) return false;
      const bL = Math.min(c.open, c.close), bH = Math.max(c.open, c.close);
      if ((bL - c.low) / c.close > 0.015 || (c.high - bH) / c.close > 0.015) return false;
      return true;
    })
    .sort((a, b) => a.time - b.time);
  const MIN_CONN = 7, CONN_WIN = 25;
  return pass.filter((c, i) => {
    let conn = 0;
    for (let j = Math.max(0, i - CONN_WIN); j <= Math.min(pass.length - 1, i + CONN_WIN); j++) {
      if (j === i) continue;
      if (pass[j].low <= c.high && pass[j].high >= c.low && ++conn >= MIN_CONN) break;
    }
    return conn >= MIN_CONN;
  });
}

// ── PRIMARY slice filter chain (market.tsx baseCandles memo) ─────────────────
export function buildBaseCandles<T extends LiveCandle>(
  raw: T[],
  showETH: boolean,
  nowSec: number = Math.floor(Date.now() / 1000),
): T[] {
  const MAX_PRICE = 9e13;
  // MIN_PRICE rejects corrupt near-zero values (e.g. 2e-19) that pass "> 0" but destroy Y-scale
  const MIN_PRICE = 1;
  const MAX_TS = nowSec + 36 * 3600; // reject future-dated corrupt bars
  const sorted = raw
    .filter(c => {
      if (c.time <= 1262304000 || c.time > MAX_TS) return false; // corrupt timestamp
      if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) return false;
      if (c.open < MIN_PRICE || c.high < MIN_PRICE || c.low < MIN_PRICE || c.close < MIN_PRICE) return false;
      if (c.open >= MAX_PRICE || c.high >= MAX_PRICE || c.low >= MAX_PRICE || c.close >= MAX_PRICE) return false;
      if (c.high <= c.low) return false; // strict — removes flat dot bars (open=close=high=low)
      if (!showETH && c.rth === false) return false;
      // Reject doji-wick spikes: body <10% of range on a bar with >1.5% spread.
      const range = c.high - c.low;
      if (range / c.close > 0.015 && Math.abs(c.open - c.close) / range < 0.10) return false;
      // Reject bars where any wick exceeds 1.5% of price — spike survives doji check when body is large
      const bL = Math.min(c.open, c.close), bH = Math.max(c.open, c.close);
      if ((bL - c.low) / c.close > 0.015 || (c.high - bH) / c.close > 0.015) return false;
      return true;
    })
    .sort((a, b) => a.time - b.time);
  // Neighbor-based outlier filter: reject bars where ANY OHLC value deviates >20%
  // from the previous bar's close.
  const result: T[] = [];
  for (const c of sorted) {
    if (result.length > 0) {
      const ref = result[result.length - 1].close;
      if (ref > 0 && (c.low / ref < 0.80 || c.high / ref > 1.20)) continue;
    }
    result.push(c);
  }
  // Second pass: phantom-bar detection (close-type / open-type midpoint inconsistency).
  const final: T[] = [];
  for (let i = 0; i < result.length; i++) {
    if (i > 0 && i < result.length - 1) {
      const pc = result[i - 1].close, no = result[i + 1].open;
      const surrounding = (pc + no) / 2;
      const mid = (result[i].open + result[i].close) / 2;
      if (surrounding > 0 && Math.abs(mid - surrounding) / surrounding > 0.015) {
        const dEnd = Math.abs(no - result[i].close) / result[i].close;
        const isClosePhantom = dEnd > 0.005;
        const gapDir = result[i].open - pc;
        const barDir = result[i].close - result[i].open;
        const isOpenPhantom = Math.abs(gapDir) / pc > 0.01 && Math.sign(barDir) !== Math.sign(gapDir);
        if (isClosePhantom || isOpenPhantom) continue;
      }
    }
    final.push(result[i]);
  }
  // Third pass: isolation filter — a bar must have [low,high] overlap with at least 7
  // of its nearest 50 neighbours.
  const MIN_CONN = 7, CONN_WIN = 25;
  return final.filter((c, i, arr) => {
    let conn = 0;
    for (let j = Math.max(0, i - CONN_WIN); j <= Math.min(arr.length - 1, i + CONN_WIN); j++) {
      if (j === i) continue;
      if (arr[j].low <= c.high && arr[j].high >= c.low && ++conn >= MIN_CONN) break;
    }
    return conn >= MIN_CONN;
  });
}

// ── 15m candleData normalization (market.tsx candleData memo) ────────────────
// The server serves NATIVE 15m bars (resolution "15") when available and only falls back to
// 5m aggregation. Native 15m: keep only 900-aligned bars (drops relay forming bars at raw
// timestamps). Fallback: clean then aggregate 5m→15m.
export function normalizeServed15m<T extends LiveCandle>(candles: T[], servedResolution: string | undefined): T[] {
  if (!candles.length) return candles;
  const isNative15m = servedResolution === "15";
  const clean = candles.filter(c => {
    if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) return false;
    if (c.high <= c.low) return false; // drops flat zero-range forming "dot" bars
    const range = c.high - c.low;
    if (range / c.close > 0.015 && Math.abs(c.open - c.close) / range < 0.10) return false;
    const bL = Math.min(c.open, c.close), bH = Math.max(c.open, c.close);
    if ((bL - c.low) / c.close > 0.015 || (c.high - bH) / c.close > 0.015) return false;
    return true;
  });
  if (isNative15m) return clean.filter(c => c.time % 900 === 0);
  return agg5mTo15m(clean);
}

// ── Vector computation — O(n) monotonic deques ───────────────────────────────
export function computeVectorLine(candles: LiveCandle[]): Array<{ time: number; value: number }> {
  if (!candles.length) return [];
  // All bars (RTH + ETH): matches ThinkorSwim vectorexitstrat behaviour.
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

// ── Aggregation helpers ──────────────────────────────────────────────────────
export function agg5mTo15m<T extends LiveCandle>(candles: T[]): T[] {
  if (!candles.length) return [];
  const s = [...candles].sort((a, b) => a.time - b.time);
  const result: T[] = [];
  let bucket: T | null = null, bucketStart = 0;
  const T15 = 15 * 60;
  for (const c of s) {
    const aligned = Math.floor(c.time / T15) * T15;
    if (bucket && bucketStart === aligned) {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume = (bucket.volume ?? 0) + (c.volume ?? 0);
      if (c.rth) bucket.rth = true;
    } else {
      if (bucket) result.push(bucket);
      bucketStart = aligned;
      bucket = { ...c, time: aligned };
    }
  }
  if (bucket) result.push(bucket);
  return result;
}

// Generic candle aggregation to any interval (e.g. 5m→15m, 5m→60m, 1m→5m)
// (VERBATIM market.tsx port: buckets are built from the base fields only — extra
// props like `complete` are deliberately NOT carried into aggregated bars.)
export function aggToInterval(candles: LiveCandle[], intervalSec: number): LiveCandle[] {
  if (!candles.length) return [];
  const s = [...candles].sort((a, b) => a.time - b.time);
  const map = new Map<number, LiveCandle>();
  for (const c of s) {
    const bucket = Math.floor(c.time / intervalSec) * intervalSec;
    const ex = map.get(bucket);
    if (!ex) {
      map.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, rth: c.rth });
    } else {
      ex.high = Math.max(ex.high, c.high);
      ex.low = Math.min(ex.low, c.low);
      ex.close = c.close;
      ex.volume = (ex.volume ?? 0) + (c.volume ?? 0);
      // If any bar in the bucket is RTH, promote the bucket to RTH.
      if (!ex.rth && c.rth) ex.rth = c.rth;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

// ── Engine slice derivation (market.tsx allConfluenceSignals memo) ───────────
export interface SliceSources {
  /** The chart's primary interval. */
  interval: FeInterval;
  /** The primary slice candles (windowedCandles: buildBaseCandles output + live merge). */
  windowedCandles: LiveCandle[];
  /** Dedicated native 1m fetch (undefined on the 1m chart). */
  raw1mCandles?: LiveCandle[];
  /** The primary fetch's RAW candles (pre-normalizeServed15m) — used on the 15m chart
   *  to identify a native-5m base for the 5m slice. */
  rawCandles?: LiveCandle[];
  /** Dedicated native 60m fetch (undefined on the 60m chart). */
  raw60mCandles?: LiveCandle[];
}

export function deriveEngineSlices(src: SliceSources): { slices: IntervalSlice[]; baseByIv: Record<FeInterval, LiveCandle[]> } {
  const { interval, windowedCandles } = src;
  const base1m: LiveCandle[] = interval === "1m" ? windowedCandles : filterCandlesForVector(src.raw1mCandles ?? []);
  // D18: on the 15m chart, rawCandles can be NATIVE 15m bars (server tries resolution
  // ["15","5"] — native 15m first). Identify the real spacing before treating it as a 5m base;
  // native-15m data must NOT masquerade as the 5m slice — derive true 5m from 1m instead.
  const rawBarSec = (() => {
    const cs = src.rawCandles ?? [];
    let min = Infinity;
    for (let i = 1; i < Math.min(cs.length, 50); i++) { const d = cs[i].time - cs[i - 1].time; if (d > 0 && d < min) min = d; }
    return min;
  })();
  const base5m: LiveCandle[] = interval === "5m" ? windowedCandles
    : interval === "15m" && rawBarSec === 300 ? filterCandlesForVector(src.rawCandles ?? [])
    : (base1m.length ? aggToInterval(base1m, 300) : []);
  const base15m: LiveCandle[] = interval === "15m" ? windowedCandles : (base5m.length ? aggToInterval(base5m, 900) : []);
  const base60m: LiveCandle[] = interval === "60m" ? windowedCandles
    : filterCandlesForVector(src.raw60mCandles ?? (base5m.length ? aggToInterval(base5m, 3600) : []));
  const baseByIv: Record<FeInterval, LiveCandle[]> = { "1m": base1m, "5m": base5m, "15m": base15m, "60m": base60m };

  const slices: IntervalSlice[] = (["1m", "5m", "15m", "60m"] as FeInterval[])
    .map(iv => ({ interval: iv, candles: baseByIv[iv] as unknown as IntervalSlice["candles"], vector: computeVectorLine(baseByIv[iv]) }))
    .filter(sl => sl.candles.length > 0);
  return { slices, baseByIv };
}

// ── Footprint imbalance zones (REAL MW clusters ONLY — C12) ──────────────────
// No footprint data for a candle ⇒ NO footprint fact. Proxy fabrication from OHLCV is gone.
export interface FootprintSource {
  imbalances: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }>;
}
export function buildFootprintMap(
  candles: LiveCandle[],
  getFp: (time: number) => FootprintSource | undefined,
): Map<number, FpImbalanceZone[]> {
  const footprintByTime = new Map<number, FpImbalanceZone[]>();
  for (const c of candles) {
    if (c.complete === false) continue;
    const fc = getFp(c.time);
    if (!fc) continue; // C12: absent real footprint → no footprint fact
    const zs = fc.imbalances
      .filter(im => im.levelCount >= 2)
      .map(im => ({ startPrice: im.startPrice, endPrice: im.endPrice, direction: im.direction, levelCount: im.levelCount }));
    if (zs.length) footprintByTime.set(c.time, zs);
  }
  return footprintByTime;
}
