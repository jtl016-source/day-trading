// ── Lightweight candle utilities for the Market/Signals data hook ─────────────
// Mirrors the per-bar sanity + aggregation logic in components/chart-view.tsx so
// the native wave chart and market stats use the same clean bars as the WebView.
// (chart-view.tsx keeps its own heavier multi-pass filter for full PC parity; this
// is the minimal subset the hook needs.)

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// Per-bar spike/wick sanity (PC Pass 1). Rejects corrupt/zero-price/doji-spike bars.
export function spikeBarOk(c: any): boolean {
  const MAX_PRICE = 9e13, MIN_PRICE = 1;
  const MAX_TS = Math.floor(Date.now() / 1000) + 36 * 3600;
  if (!c || !c.time) return false;
  if (c.time <= 1_262_304_000 || c.time > MAX_TS) return false;
  if (!Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)) return false;
  if (c.open < MIN_PRICE || c.high < MIN_PRICE || c.low < MIN_PRICE || c.close < MIN_PRICE) return false;
  if (c.open >= MAX_PRICE || c.high >= MAX_PRICE || c.low >= MAX_PRICE || c.close >= MAX_PRICE) return false;
  if (c.high <= c.low) return false;
  const range = c.high - c.low;
  if (range / c.close > 0.015 && Math.abs(c.open - c.close) / range < 0.10) return false; // doji-spike
  const bL = Math.min(c.open, c.close), bH = Math.max(c.open, c.close);
  if ((bL - c.low) / c.close > 0.015 || (c.high - bH) / c.close > 0.015) return false;     // wick > 1.5%
  return true;
}

export function dedupByTime<T extends { time: number }>(arr: T[]): T[] {
  const seen = new Set<number>();
  return arr.filter(b => { if (seen.has(b.time)) return false; seen.add(b.time); return true; });
}

// Aggregate 1m/5m bars up to a coarser interval. 60m aligns to :00 top-of-hour
// (matches get60mBucket / server agg60mBucket / Yahoo ES=F 60m alignment).
export function aggToInterval(bars: Candle[], intervalMin: number): Candle[] {
  if (intervalMin <= 1) return bars;
  const intervalSec = intervalMin * 60;
  const OFFSET = 0; // 60m at :00 top-of-hour (no :30 offset)
  const out: Candle[] = [];
  let bucket: Candle | null = null;
  for (const b of bars) {
    const bt = Math.floor((b.time - OFFSET) / intervalSec) * intervalSec + OFFSET;
    if (!bucket || bucket.time !== bt) {
      if (bucket) out.push(bucket);
      bucket = { time: bt, open: b.open, high: b.high, low: b.low, close: b.close, volume: (b.volume || 0) };
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low = Math.min(bucket.low, b.low);
      bucket.close = b.close;
      bucket.volume = (bucket.volume || 0) + (b.volume || 0);
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

// Wilder ATR-14 on the most recent bars (used for the Market stat row).
export function atr14(candles: Candle[]): number | null {
  if (candles.length < 15) return null;
  const slice = candles.slice(-120);
  const trs: number[] = [];
  let prevClose = slice[0].close;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
    prevClose = c.close;
  }
  if (trs.length < 14) return null;
  let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;  // seed = avg of first 14 TRs
  for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;  // Wilder smoothing
  return atr;
}
