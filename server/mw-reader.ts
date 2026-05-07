/**
 * MotiveWave binary bar-file reader.
 *
 * Reads .bar_data1 (1-minute OHLCV) files written by MotiveWave into its
 * local historical_data cache, aggregates them to 5-min and 60-min bars,
 * upserts into cached_candles so the existing chart data flow works unchanged,
 * and polls every 2 s to broadcast live updates via the shared WebSocket.
 *
 * File format (confirmed via hex analysis of MESM6.CME files):
 *   Header : 86 bytes  (skipped)
 *   Records: 30 bytes each
 *     [0..1]   uint16BE — bar sequence number (minutes from file start)
 *     [2..5]   float32BE — open
 *     [6..9]   float32BE — high
 *     [10..13] float32BE — low
 *     [14..17] float32BE — close
 *     [18..21] float32BE — volume
 *     [22..29] 8 bytes   — unknown (ignored)
 *   bar_time_sec = (filename_ms + seq * 60_000) / 1000
 */

import fs   from "fs";
import path from "path";
import { db } from "./db";
import { cachedCandles } from "@shared/schema";
import { sql } from "drizzle-orm";
import { type Express }    from "express";
import { type Server as HttpServer } from "http";

// ── Config ────────────────────────────────────────────────────────────────────

const MW_DATA_ROOT = path.join(
  process.env.USERPROFILE ?? "C:\\Users\\jacks",
  "AppData", "Roaming", "MotiveWave", "historical_data", "RITHMIC",
);

// Map: logical symbol → (a) regex to match ALL contract-month directories,
//                        (b) the CURRENT active dir for live tick watching.
// Historical data is spread across multiple expiry dirs (MESH6, MESM6, …).
// loadMultiDir() merges them all; only the activeDir is watched for live ticks.
const MW_INSTRUMENTS: { symbol: string; dirPattern: RegExp; activeDir: string }[] = [
  { symbol: "MES", dirPattern: /^MES[A-Z]\d+\.CME$/, activeDir: "MESM6.CME" },
];

/** Return all subdirectories under MW_DATA_ROOT whose names match pattern. */
function getContractDirs(pattern: RegExp): string[] {
  try {
    return fs.readdirSync(MW_DATA_ROOT)
      .filter(d => pattern.test(d))
      .map(d => path.join(MW_DATA_ROOT, d))
      .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  } catch { return []; }
}

/**
 * Load all bar files from multiple contract directories, merge by timestamp
 * (preferring the bar with higher volume = front-month contract), then
 * wipe + re-insert the DB rows for `symbol`.
 */
// How far back to read tick files for intraday gap-filling.
// Bar files cover history densely (57+ bars/hr) up through the most recent weekly file.
// Tick files are only needed for the last ~1 week (the period after the latest dense bar file).
// 8 days × 24 files/day = ~192 files ≈ 125 MB — reads in < 2 s on any modern disk.
const TICK_HISTORY_MS = 8 * 24 * 3600 * 1000;

async function loadMultiDir(symbol: string, instrDirs: string[]) {
  // ── Step 1: Load all bar_data1 files (authoritative OHLCV) ─────────────────
  const allMin: MinBar[] = [];
  let totalBarFiles = 0;

  for (const instrDir of instrDirs) {
    const files = getBarFiles(instrDir);
    totalBarFiles += files.length;
    for (const fp of files) {
      allMin.push(...parseBarFile(fp));
      try { fileMTimes.set(fp, fs.statSync(fp).mtimeMs); } catch {}
    }
    console.log(`[mw-reader] Scanned ${path.basename(instrDir)}: ${files.length} bar files`);
  }

  // Deduplicate bar file entries: prefer highest volume (front-month wins)
  allMin.sort((a, b) => a.timeSec - b.timeSec);
  const minMap = new Map<number, MinBar>();
  for (const b of allMin) {
    const ex = minMap.get(b.timeSec);
    if (!ex || b.volume > ex.volume) minMap.set(b.timeSec, b);
  }

  // ── Step 2: Fill gaps with recent tick files ────────────────────────────────
  // Tick files have tick-level density (thousands of records/hour) but no per-tick
  // timestamps — we distribute them proportionally across the 1-hour file window.
  // Bar file data takes priority; tick data only fills minutes not already covered.
  const tickCutoffMs = Date.now() - TICK_HISTORY_MS;
  let totalTickFiles = 0;

  for (const instrDir of instrDirs) {
    const tickFiles = getTickFiles(instrDir, tickCutoffMs);
    totalTickFiles += tickFiles.length;
    for (const fp of tickFiles) {
      for (const b of parseTickFileAsBars(fp)) {
        if (!minMap.has(b.timeSec)) minMap.set(b.timeSec, b);
      }
    }
  }

  if (totalTickFiles > 0) {
    console.log(`[mw-reader] Loaded ${totalTickFiles} tick files for gap-filling`);
  }

  // ── Step 3: Aggregate and write to DB ──────────────────────────────────────
  const bars1 = Array.from(minMap.values()).sort((a, b) => a.timeSec - b.timeSec);
  const bars5  = aggregate(bars1, 5);
  const bars60 = aggregate(bars1, 60);

  if (!bars1.length) {
    console.log(`[mw-reader] No valid bars parsed for ${symbol} — skipping DB write`);
    return;
  }

  // Always cache in memory first — available instantly even if DB write fails
  memBarStore.set(`${symbol}:1`,  bars1);
  memBarStore.set(`${symbol}:5`,  bars5);
  memBarStore.set(`${symbol}:60`, bars60);

  if (bars5.length) latestBar5.set(symbol, bars5[bars5.length - 1]);

  try {
    // CATCH-UP CANDLE FIX: Do NOT delete existing rows before upserting.
    // bulkUpsert uses onConflictDoUpdate — it updates existing rows in-place.
    // Deleting first would destroy Polygon-downloaded historical candles that
    // MW bar files may not cover, causing massive time-gap "catch-up" bars on the chart.
    await bulkUpsert(symbol, "1",  bars1);
    await bulkUpsert(symbol, "5",  bars5);
    await bulkUpsert(symbol, "60", bars60);
  } catch (e: any) {
    console.warn(`[mw-reader] DB write failed (quota?): ${e.message} — in-memory bars still available`);
  }

  console.log(
    `[mw-reader] ${symbol}: ${totalBarFiles} bar files + ${totalTickFiles} tick files → ` +
    `${bars1.length} 1-min, ${bars5.length} 5-min, ${bars60.length} 60-min bars`,
  );
}

const HEADER_SIZE  = 86;
const RECORD_SIZE  = 30;
const POLL_INTERVAL_MS = 1_000;

// ── Tick-file constants ───────────────────────────────────────────────────────
const TICK_HEADER  = 86;
const TICK_RECORD  = 45;
const TICK_ASK_OFF = 3;   // float32BE: ask price offset from record start

/**
 * Return all .tick_data files in instrDir whose epoch-ms name is >= sinceMs.
 */
function getTickFiles(instrDir: string, sinceMs: number): string[] {
  try {
    return fs.readdirSync(instrDir)
      .filter(f => f.endsWith(".tick_data") && parseInt(f, 10) >= sinceMs)
      .sort()
      .map(f => path.join(instrDir, f));
  } catch { return []; }
}

/**
 * Reconstruct approximate 1-minute bars from a .tick_data file.
 * Tick files are named by their epoch-ms start time (1-hour windows).
 * Individual records don't carry timestamps, so we distribute them
 * proportionally across the 60-minute window — accurate enough for 1m/5m bars.
 */
function parseTickFileAsBars(filePath: string): MinBar[] {
  const fileMs = parseInt(path.basename(filePath).split(".")[0], 10);
  if (isNaN(fileMs)) return [];

  let buf: Buffer;
  try { buf = fs.readFileSync(filePath); } catch { return []; }

  const totalRecords = Math.floor((buf.length - TICK_HEADER) / TICK_RECORD);
  if (totalRecords < 2) return [];

  const minuteMap = new Map<number, MinBar>();

  for (let i = 0; i < totalRecords; i++) {
    const price = buf.readFloatBE(TICK_HEADER + i * TICK_RECORD + TICK_ASK_OFF);
    if (!isFinite(price) || price < 400 || price > 50_000) continue;

    // Distribute ticks proportionally across the 1-hour file window
    const tickMs     = fileMs + Math.floor((i / totalRecords) * 3_600_000);
    const bucketSec  = Math.floor(tickMs / 60_000) * 60;

    const ex = minuteMap.get(bucketSec);
    if (!ex) {
      minuteMap.set(bucketSec, {
        timeSec: bucketSec,
        open: price, high: price, low: price, close: price, volume: 1,
      });
    } else {
      // Reject corrupt outlier ticks: once 5+ ticks have anchored the bar,
      // any tick >5% away from the running close is a misread byte pattern (e.g. 8192, 49152).
      if (ex.volume >= 5 && Math.abs(price - ex.close) / ex.close > 0.05) continue;
      if (price > ex.high) ex.high = price;
      if (price < ex.low)  ex.low  = price;
      ex.close  = price;
      ex.volume += 1;
    }
  }

  // Final guard: discard bars where high/low spread > 5% — corrupt tick slipped through early.
  return Array.from(minuteMap.values())
    .filter(b => b.high > 0 && b.low > 0 && (b.high - b.low) / b.low < 0.05)
    .sort((a, b) => a.timeSec - b.timeSec);
}


// ── In-memory bar store — survives DB quota errors ───────────────────────────
// Keyed by `${symbol}:${resolution}` (resolution = "1" | "5" | "60")
// Populated by loadMultiDir on startup; served directly by the candle route
// as a fallback when the DB is unreachable.
const memBarStore = new Map<string, MinBar[]>();

export function getMemBars(symbol: string, resolution: string): MinBar[] {
  return memBarStore.get(`${symbol.toUpperCase()}:${resolution}`) ?? [];
}

// ── Live price cache (tick-level, for HTTP poll + WebSocket) ─────────────────

const latestBar5       = new Map<string, MinBar>();
const inProgressBar1m  = new Map<string, MinBar>(); // current forming 1-min bar
const inProgressBar5m  = new Map<string, MinBar>(); // current forming 5-min bar
const lastTickPrice      = new Map<string, number>();  // last seen ask price per symbol
const lastTickAt         = new Map<string, number>();  // symbol → Date.now() of last tick received
const prevFeedStatus     = new Map<string, string>();  // symbol → last broadcast feed status
const lastExternalTickMs     = new Map<string, number>();  // symbol → last tick from TickRelay WebSocket
const lastFormingBroadcastMs = new Map<string, number>();  // symbol → last forming-bar broadcast time

// Track current active tick file per instrument so we don't scan the directory on every event
const activeTickFile  = new Map<string, string>();   // instrDir → absolute file path
const activeTickSize  = new Map<string, number>();   // instrDir → last known file size

/** Returns the in-progress 5-min bar if available, else the last completed 5-min bar. */
export function getLatestBar(symbol: string): (MinBar & { symbol: string }) | null {
  const sym = symbol.toUpperCase();
  const b = inProgressBar5m.get(sym) ?? latestBar5.get(sym);
  if (!b) return null;
  return { ...b, symbol: sym };
}

/** Returns the most recent tick price — the true current market price. */
export function getLastTickPrice(symbol: string): number | null {
  return lastTickPrice.get(symbol.toUpperCase()) ?? null;
}

/** Returns the in-progress 1-min bar. */
export function getLatestBar1m(symbol: string): (MinBar & { symbol: string }) | null {
  const sym = symbol.toUpperCase();
  const b = inProgressBar1m.get(sym);
  if (!b) return null;
  return { ...b, symbol: sym };
}

/**
 * Find which tick file MW is currently writing.
 * Hourly files are named <epoch_ms>.tick_data — the largest-named file that
 * also has the most-recent mtime is the active one.
 * Returns absolute path, or null if none found.
 */
function findActiveTickFile(instrDir: string): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(instrDir); } catch { return null; }
  const tickFiles = entries.filter(f => f.endsWith(".tick_data")).sort();
  if (!tickFiles.length) return null;
  // Strategy: prefer the NEWEST file by epoch name that has at least one record.
  // If the newest file only has a header (MW just created it), fall back to the
  // previous file that has real data so we don't lose the last known price.
  const candidates = tickFiles.slice(-10);

  // Pass 1: find newest file WITH at least one readable record
  let bestWithRecords: string | null = null;
  let bestWithRecordsMtime = 0;
  // Pass 2: find newest file BY NAME (even if header-only) as a forward-pointer
  let newestByName: string | null = null;

  for (const f of candidates) {
    const fp = path.join(instrDir, f);
    try {
      const st = fs.statSync(fp);
      if (st.size > 0) {
        // Track the highest-named file regardless of content (MW may have just created it)
        newestByName = fp; // candidates are sorted ascending, last wins
        if (st.size >= 128 && st.mtimeMs > bestWithRecordsMtime) {
          bestWithRecordsMtime = st.mtimeMs;
          bestWithRecords = fp;
        }
      }
    } catch { /* skip */ }
  }

  // If the newest-named file is newer by name than our best-with-records file,
  // switch to it so we notice when MW writes the first record.
  if (newestByName && bestWithRecords && newestByName !== bestWithRecords) {
    return newestByName; // header-only but newest — readLastTickRecord will return null until first record
  }
  return bestWithRecords ?? newestByName;
}

/**
 * Read the current price from a tick file by scanning the last 512 bytes backwards.
 *
 * MotiveWave's tick record format and header size vary across versions and
 * between RTH/ETH sessions — fixed-offset parsing reliably fails. Instead we
 * read the tail of the file and scan backwards for the first big-endian float32
 * that falls in a valid MES price range (400–50 000). This is identical to the
 * approach used by the reference Python implementation (rithmic_feed.py) and
 * handles every known MW format without any assumptions about record layout.
 */
function readLastTickRecord(filePath: string): number | null {
  let fileSize: number;
  try { fileSize = fs.statSync(filePath).size; } catch { return null; }
  if (fileSize < 4) return null;

  const scanSize = Math.min(512, fileSize);
  const buf = Buffer.allocUnsafe(scanSize);
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, scanSize, fileSize - scanSize);
    fs.closeSync(fd);
  } catch { return null; }

  // Scan backwards — the most recent price is near the end of the file.
  for (let i = scanSize - 4; i >= 0; i--) {
    const v = buf.readFloatBE(i);
    if (isFinite(v) && v >= 400 && v <= 50_000) return v;
  }
  return null;
}

/** Update both the in-progress 1-min and 5-min bars with a new tick price and broadcast both. */
function applyTick(symbol: string, price: number) {
  const sym = symbol.toUpperCase();

  // Sanity check: reject ticks that deviate >15% from the last known good price.
  // Catches corrupt tick-file bytes (e.g. half the real price) from stale sessions.
  const refBar = inProgressBar1m.get(sym) ?? latestBar5.get(sym);
  if (refBar && refBar.close > 0) {
    const ratio = price / refBar.close;
    if (ratio < 0.85 || ratio > 1.15) {
      console.warn(`[mw-tick] ${sym} rejected suspicious price ${price.toFixed(2)} (ref ${refBar.close.toFixed(2)}, ratio ${ratio.toFixed(3)})`);
      return;
    }
  }

  // Price passed sanity check — record it as the last known good price
  const prevPrice = lastTickPrice.get(sym);
  lastTickPrice.set(sym, price);

  const nowSec    = Math.floor(Date.now() / 1000);
  const bucket1m  = Math.floor(nowSec / 60)  * 60;
  const bucket5m  = Math.floor(nowSec / 300) * 300;
  // Only log when the price actually changes (suppresses heartbeat spam)
  if (prevPrice === undefined || Math.abs(price - prevPrice) >= 0.01) {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
    console.log(`[mw-tick] ${ts} ${sym} price=${price.toFixed(2)}`);
  }
  lastTickAt.set(sym, Date.now());

  // ── 1-min in-progress bar ────────────────────────────────────────────────
  const prev1m = inProgressBar1m.get(sym);
  if (prev1m && prev1m.timeSec === bucket1m) {
    prev1m.close = price;
    if (price > prev1m.high) prev1m.high = price;
    if (price < prev1m.low)  prev1m.low  = price;
  } else {
    // CANDLE FIX: only chain prev close as open when consecutive buckets — gap means self-seed
    const is1mContiguous = prev1m != null && (bucket1m - prev1m.timeSec <= 60);
    inProgressBar1m.set(sym, {
      timeSec: bucket1m,
      open:  is1mContiguous ? prev1m.close : price, // CANDLE FIX: gap-safe open
      high:  price,
      low:   price,
      close: price,
      volume: 0,
    });
  }

  // ── 5-min in-progress bar ────────────────────────────────────────────────
  const prev5m = inProgressBar5m.get(sym);
  if (prev5m && prev5m.timeSec === bucket5m) {
    prev5m.close = price;
    if (price > prev5m.high) prev5m.high = price;
    if (price < prev5m.low)  prev5m.low  = price;
  } else {
    // CANDLE FIX: only chain prev close as open when consecutive buckets — gap means self-seed
    const is5mContiguous = prev5m != null && (bucket5m - prev5m.timeSec <= 300);
    inProgressBar5m.set(sym, {
      timeSec: bucket5m,
      open:  is5mContiguous ? prev5m.close : price, // CANDLE FIX: gap-safe open
      high:  price,
      low:   price,
      close: price,
      volume: 0,
    });
  }

  if (!_broadcast) return;
  const bar1m = inProgressBar1m.get(sym)!;
  const bar5m = inProgressBar5m.get(sym)!;
  // Broadcast both resolutions so all open chart tabs update immediately
  _broadcast({ type: "bar", resolution: "1",  bar: { symbol: sym, time: bar1m.timeSec, open: bar1m.open, high: bar1m.high, low: bar1m.low, close: bar1m.close, volume: bar1m.volume, complete: false } });
  _broadcast({ type: "bar", resolution: "5",  bar: { symbol: sym, time: bar5m.timeSec, open: bar5m.open, high: bar5m.high, low: bar5m.low, close: bar5m.close, volume: bar5m.volume, complete: false } });
  // Lightweight tick broadcast — just the raw price, no OHLCV.
  // Client uses this for the direct series.update() fast path (bypasses React state).
  _broadcast({ type: "tick", symbol: sym, price });
}

/**
 * Called on every fs.watch event for the instrument directory.
 * Reads only the last 45 bytes of the active tick file — sub-millisecond.
 */
function onTickFileChange(symbol: string, instrDir: string, changedFilename: string | null) {
  // TickRelay WebSocket is active — its prices are authoritative.
  // Suppress disk tick reads for 60 s after the last MW tick to prevent stale disk
  // prices from conflicting with live WebSocket data.
  const sym0 = symbol.toUpperCase();
  if (Date.now() - (lastExternalTickMs.get(sym0) ?? 0) < 60_000) return;

  // If the changed file is a new tick file (not the one we tracked), refresh active file
  let fp = activeTickFile.get(instrDir);

  if (!fp || (changedFilename && changedFilename.endsWith(".tick_data") && path.join(instrDir, changedFilename) > fp)) {
    const newFp = findActiveTickFile(instrDir);
    if (!newFp) return;
    if (newFp !== fp) {
      console.log(`[mw-reader] Active tick file → ${path.basename(newFp)}`);
      activeTickFile.set(instrDir, newFp);
      activeTickSize.set(instrDir, 0);
      fp = newFp;
    }
  }
  if (!fp) return;

  // Check file size grew (new records appended)
  let newSize: number;
  try { newSize = fs.statSync(fp).size; } catch { return; }
  const prevSize = activeTickSize.get(instrDir) ?? 0;
  if (newSize <= prevSize) return; // no new data
  activeTickSize.set(instrDir, newSize);

  const price = readLastTickRecord(fp);
  if (price === null) return;
  const sym = symbol.toUpperCase();
  applyTick(sym, price); // lastTickPrice is set inside applyTick after sanity check
}

/**
 * Fallback: 1-second interval poll in case fs.watch misses an event
 * (can happen on some Windows configurations).
 */
function fallbackTickPoll(symbol: string, instrDir: string) {
  onTickFileChange(symbol, instrDir, null);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MinBar {
  timeSec: number;
  open:    number;
  high:    number;
  low:     number;
  close:   number;
  volume:  number;
}

/** Persist a completed 5-min bar to the DB. Fire-and-forget. */
function persistCompletedBar5(symbol: string, bar: MinBar) {
  bulkUpsert(symbol, "5", [bar]).catch(() => {}); // FIX: removed erroneous bulkUpsert(..., "1") — 5m bars must not be written as 1m
}

/**
 * Called by live-bars.ts whenever a live tick arrives from the TickRelay WebSocket study.
 * Updates internal bar state (so /api/live/bar stays accurate) and marks the feed as fresh
 * so the 16ms disk heartbeat stays suppressed while TickRelay is active.
 */
export function notifyExternalTick(symbol: string, price: number) {
  // Normalize to logical symbol — strip contract month (MESM6→MES) and futures suffix (MES=F→MES)
  // so keys match what MW_INSTRUMENTS uses and the heartbeat suppression works correctly.
  const sym = symbol.toUpperCase().replace(/[A-Z]\d+$/, "").replace("=F", "");
  const refBar = inProgressBar1m.get(sym) ?? latestBar5.get(sym);
  if (refBar && refBar.close > 0) {
    const ratio = price / refBar.close;
    if (ratio < 0.70 || ratio > 1.30) return; // reject obviously corrupt prices
  }

  lastExternalTickMs.set(sym, Date.now());
  lastTickPrice.set(sym, price);
  lastTickAt.set(sym, Date.now());

  const nowSec   = Math.floor(Date.now() / 1000);
  const bucket1m = Math.floor(nowSec / 60)  * 60;
  const bucket5m = Math.floor(nowSec / 300) * 300;

  const prev1m = inProgressBar1m.get(sym);
  if (prev1m && prev1m.timeSec === bucket1m) {
    prev1m.close = price;
    if (prev1m.high < price) prev1m.high = price;
    if (prev1m.low  > price) prev1m.low  = price;
  } else {
    // Completed 1m bar — persist and broadcast
    if (prev1m && prev1m.timeSec > 0 && prev1m.open > 0) {
      bulkUpsert(sym, "1", [prev1m]).catch(() => {});
      if (_broadcast) {
        _broadcast({ type: "bar", resolution: "1", bar: { symbol: sym, time: prev1m.timeSec, open: prev1m.open, high: prev1m.high, low: prev1m.low, close: prev1m.close, volume: prev1m.volume, complete: true } });
      }
    }
    // CANDLE FIX: only chain prev close as open when consecutive buckets — gap means self-seed
    const is1mContiguous = prev1m != null && (bucket1m - prev1m.timeSec <= 60);
    inProgressBar1m.set(sym, { timeSec: bucket1m, open: is1mContiguous ? prev1m.close : price, high: price, low: price, close: price, volume: 0 }); // CANDLE FIX: gap-safe open
  }

  const prev5m = inProgressBar5m.get(sym);
  if (prev5m && prev5m.timeSec === bucket5m) {
    prev5m.close = price;
    if (price > prev5m.high) prev5m.high = price;
    if (price < prev5m.low)  prev5m.low  = price;
  } else {
    // Bucket rolled over — persist and broadcast the completed bar
    if (prev5m && prev5m.timeSec > 0 && prev5m.open > 0) {
      persistCompletedBar5(sym, prev5m);
      latestBar5.set(sym, prev5m);
      if (_broadcast) {
        // Only broadcast the 5m resolution — never send a 5m bar as resolution "1" because
        // the 1m chart would insert it at the 5m boundary and corrupt individual 1m candles.
        // The 1m completion is handled separately above (line ~487).
        _broadcast({ type: "bar", resolution: "5", bar: { symbol: sym, time: prev5m.timeSec, open: prev5m.open, high: prev5m.high, low: prev5m.low, close: prev5m.close, volume: prev5m.volume, complete: true } });
      }
    }
    // CANDLE FIX: only chain prev close as open when consecutive buckets — gap means self-seed
    const is5mContiguous = prev5m != null && (bucket5m - prev5m.timeSec <= 300);
    inProgressBar5m.set(sym, { timeSec: bucket5m, open: is5mContiguous ? prev5m.close : price, high: price, low: price, close: price, volume: 0 }); // CANDLE FIX: gap-safe open
  }

  // Broadcast the forming bars so the browser's liveCandles stays in sync (for signal computation).
  // Throttled to once per second — the tick fast path already handles the Y-axis in real time.
  if (_broadcast) {
    const now = Date.now();
    if (now - (lastFormingBroadcastMs.get(sym) ?? 0) >= 1_000) {
      lastFormingBroadcastMs.set(sym, now);
      const cur5m = inProgressBar5m.get(sym)!;
      _broadcast({ type: "bar", resolution: "5", bar: { symbol: sym, time: cur5m.timeSec, open: cur5m.open, high: cur5m.high, low: cur5m.low, close: cur5m.close, volume: cur5m.volume, complete: false } });
      const cur1m = inProgressBar1m.get(sym)!;
      _broadcast({ type: "bar", resolution: "1", bar: { symbol: sym, time: cur1m.timeSec, open: cur1m.open, high: cur1m.high, low: cur1m.low, close: cur1m.close, volume: cur1m.volume, complete: false } });
    }
  }

  // FOOTPRINT-MIDTRADE: check for mid-trade delta divergence on each external tick
  import("./footprint-engine").then(({ checkMidTradeDivergence }) => { // FOOTPRINT-MIDTRADE:
    checkMidTradeDivergence(sym, price); // FOOTPRINT-MIDTRADE:
  }).catch(() => {}); // FOOTPRINT-MIDTRADE:
}

// ── Broadcast hook (set by live-bars.ts after WebSocket server is up) ─────────

let _broadcast: ((msg: object) => void) | null = null;

export function setMWBroadcast(fn: (msg: object) => void) {
  _broadcast = fn;
}

// ── Binary parser ─────────────────────────────────────────────────────────────

function parseBarFile(filePath: string): MinBar[] {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return [];
  }

  // Filename is the epoch-ms of the first bar in the file
  const fileMs = parseInt(path.basename(filePath).split(".")[0], 10);
  if (isNaN(fileMs)) return [];

  const count = Math.floor((buf.length - HEADER_SIZE) / RECORD_SIZE);
  const bars: MinBar[] = [];

  for (let i = 0; i < count; i++) {
    const o = HEADER_SIZE + i * RECORD_SIZE;
    const seq  = buf.readUInt16BE(o);
    const open = buf.readFloatBE(o + 2);
    const high = buf.readFloatBE(o + 6);
    const low  = buf.readFloatBE(o + 10);
    const close= buf.readFloatBE(o + 14);
    const vol  = buf.readFloatBE(o + 18);

    // Reject NaN/Infinity, zero/negative prices, and corrupt records.
    // Upper bound: no futures contract should ever exceed $1,000,000.
    // Ratio guard: high > low*2 means a 100%+ intrabar move — impossible in normal markets.
    if (
      !isFinite(open) || !isFinite(high) || !isFinite(low) || !isFinite(close) ||
      open <= 0 || high < low || low <= 0 ||
      low > open || low > close || high < open || high < close ||
      open > 1e6 || high > 1e6 || low > 1e6 || close > 1e6 ||
      high > low * 2
    ) continue;

    bars.push({
      timeSec: Math.floor((fileMs + seq * 60_000) / 1000),
      open, high, low, close,
      volume: (vol > 0 && vol < 1e9) ? Math.round(vol) : 0,
    });
  }

  return bars;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

function aggregate(minBars: MinBar[], periodMin: number): MinBar[] {
  const pSec = periodMin * 60;
  const map  = new Map<number, MinBar>();

  for (const b of minBars) {
    const t  = Math.floor(b.timeSec / pSec) * pSec;
    const ex = map.get(t);
    if (!ex) {
      map.set(t, { ...b, timeSec: t });
    } else {
      if (b.high  > ex.high) ex.high = b.high;
      if (b.low   < ex.low)  ex.low  = b.low;
      ex.close  = b.close;
      ex.volume += b.volume;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.timeSec - b.timeSec);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/** Upsert — overwrites existing rows so corrupt DB data is always replaced */
async function bulkUpsert(symbol: string, resolution: string, bars: MinBar[]) {
  if (!bars.length) return;
  for (let i = 0; i < bars.length; i += 500) {
    const values = bars.slice(i, i + 500).map(b => ({
      symbol, resolution,
      timestamp: b.timeSec,
      open:   b.open,
      high:   b.high,
      low:    b.low,
      close:  b.close,
      volume: b.volume,
    }));
    await db.insert(cachedCandles)
      .values(values)
      .onConflictDoUpdate({
        target: [cachedCandles.symbol, cachedCandles.resolution, cachedCandles.timestamp],
        set: {
          open:   sql`EXCLUDED.open`,
          high:   sql`EXCLUDED.high`,
          low:    sql`EXCLUDED.low`,
          close:  sql`EXCLUDED.close`,
          volume: sql`EXCLUDED.volume`,
        },
      });
  }
}

// ── File-change tracking ──────────────────────────────────────────────────────

const fileMTimes = new Map<string, number>();

function getBarFiles(instrDir: string): string[] {
  try {
    return fs.readdirSync(instrDir)
      .filter(f => f.endsWith(".bar_data1"))
      .sort()
      .map(f => path.join(instrDir, f));
  } catch {
    return [];
  }
}

// ── Core processing ───────────────────────────────────────────────────────────

export async function loadAll(symbol: string, instrDir: string) {
  const files = getBarFiles(instrDir);
  if (!files.length) {
    console.log(`[mw-reader] No .bar_data1 files found in ${instrDir}`);
    return;
  }

  const allMin: MinBar[] = [];
  for (const fp of files) {
    allMin.push(...parseBarFile(fp));
    try {
      fileMTimes.set(fp, fs.statSync(fp).mtimeMs);
    } catch { /* ignore */ }
  }

  allMin.sort((a, b) => a.timeSec - b.timeSec);

  // Deduplicate by timeSec — later files take precedence (keep last occurrence per timestamp)
  const minMap = new Map<number, MinBar>();
  for (const b of allMin) minMap.set(b.timeSec, b);
  const bars1 = Array.from(minMap.values()).sort((a, b) => a.timeSec - b.timeSec);
  const bars5  = aggregate(bars1, 5);
  const bars60 = aggregate(bars1, 60);

  if (!bars1.length) {
    console.log(`[mw-reader] No valid bars parsed for ${symbol} — skipping DB write`);
    return;
  }

  // CATCH-UP CANDLE FIX: Do NOT delete existing rows before upserting.
  // bulkUpsert uses onConflictDoUpdate — it updates existing rows in-place.
  // Deleting first would destroy Polygon-downloaded historical candles that
  // MW bar files may not cover, causing massive time-gap "catch-up" bars on the chart.
  await bulkUpsert(symbol, "1",  bars1);
  await bulkUpsert(symbol, "5",  bars5);
  await bulkUpsert(symbol, "60", bars60);

  if (bars5.length) latestBar5.set(symbol, bars5[bars5.length - 1]);

  console.log(
    `[mw-reader] Loaded ${files.length} files → ` +
    `${bars1.length} 1-min, ${bars5.length} 5-min, ${bars60.length} 60-min bars for ${symbol}`,
  );
}

async function pollChanged(symbol: string, instrDir: string) {
  const files = getBarFiles(instrDir);

  for (const fp of files) {
    let mtime: number;
    try {
      mtime = fs.statSync(fp).mtimeMs;
    } catch {
      continue;
    }

    const prev = fileMTimes.get(fp) ?? 0;
    if (mtime <= prev) continue;

    fileMTimes.set(fp, mtime);

    const minBars = parseBarFile(fp);
    if (!minBars.length) continue;

    const bars5  = aggregate(minBars, 5);
    const bars60 = aggregate(minBars, 60);

    await bulkUpsert(symbol, "1",  minBars);
    await bulkUpsert(symbol, "5",  bars5);
    await bulkUpsert(symbol, "60", bars60);

    // Keep latest bar in memory for HTTP poll endpoint
    const latest = bars5[bars5.length - 1];
    if (latest) {
      latestBar5.set(symbol, latest);
      // Bar-file fallback: when the tick file hasn't delivered a fresh tick in > 60s,
      // use the most recent completed bar's close to keep the chart price moving.
      // Gives 1-minute accuracy instead of being permanently stuck on a stale tick.
      const sym = symbol.toUpperCase();
      const lastTick = lastTickAt.get(sym);
      const tickStaleSec = lastTick !== undefined ? (Date.now() - lastTick) / 1000 : Infinity;
      if (tickStaleSec > 60 && lastTickPrice.get(sym) !== latest.close) {
        lastTickPrice.set(sym, latest.close);
        console.log(`[mw-bar] ${sym} price from bar file: ${latest.close.toFixed(2)} (tick stale ${tickStaleSec.toFixed(0)}s)`);
      }
    }

    // Broadcast completed bars only when MW WebSocket is NOT actively feeding data.
    // If MW is live, notifyExternalTick() handles all browser updates; disk broadcasts
    // would create duplicate / conflicting candles.
    const mwActiveSec = (Date.now() - (lastExternalTickMs.get(symbol.toUpperCase()) ?? 0)) / 1000;
    if (_broadcast && mwActiveSec > 60) {
      const nowSec = Date.now() / 1000;
      const latest1m = minBars[minBars.length - 1];
      if (latest1m) {
        _broadcast({ type: "bar", resolution: "1", bar: { symbol, time: latest1m.timeSec, open: latest1m.open, high: latest1m.high, low: latest1m.low, close: latest1m.close, volume: latest1m.volume, complete: nowSec >= latest1m.timeSec + 60 } });
      }
      if (latest) {
        _broadcast({ type: "bar", resolution: "5", bar: { symbol, time: latest.timeSec, open: latest.open, high: latest.high, low: latest.low, close: latest.close, volume: latest.volume, complete: nowSec >= latest.timeSec + 300 } });
      }
    }
  }
}

/** Reload all instruments from disk into the DB — can be triggered via HTTP endpoint. */
export async function reloadAll() {
  for (const { symbol, dirPattern } of MW_INSTRUMENTS) {
    const dirs = getContractDirs(dirPattern);
    if (!dirs.length) {
      console.log(`[mw-reader] reloadAll: no contract dirs found for ${symbol} (pattern ${dirPattern})`);
      continue;
    }
    console.log(`[mw-reader] reloadAll: loading ${symbol} from ${dirs.length} dir(s)…`);
    await loadMultiDir(symbol, dirs);
  }
}

// ── Public setup function ─────────────────────────────────────────────────────

export function setupMWReader(_httpServer: HttpServer, _app: Express) {
  console.log("[mw-reader] Starting — data root:", MW_DATA_ROOT);

  (async () => {
    for (const { symbol, dirPattern, activeDir } of MW_INSTRUMENTS) {
      const instrDir = path.join(MW_DATA_ROOT, activeDir);

      // Discover all contract dirs for historical merge
      const allContractDirs = getContractDirs(dirPattern);
      if (!allContractDirs.length) {
        console.log(`[mw-reader] No contract dirs found for ${symbol} (pattern ${dirPattern})`);
      }

      // Initial load from ALL contract dirs (merges history across expirations)
      if (allContractDirs.length) {
        try {
          await loadMultiDir(symbol, allContractDirs);
        } catch (err: any) {
          console.error(`[mw-reader] Initial load failed for ${symbol}:`, err.message);
        }
      }

      const dirExists = fs.existsSync(instrDir);

      // Seed in-progress bars. Priority: bar files → DB → nothing.
      // This ensures getLatestBar() always returns a value as long as any historical data exists.
      const sym = symbol.toUpperCase();
      let seedBar = latestBar5.get(sym);
      if (!seedBar) {
        try {
          const rowArr = db.$client.prepare(
            `SELECT close FROM cached_candles WHERE symbol = ? AND resolution = '5' ORDER BY timestamp DESC LIMIT 1`
          ).all(sym) as any[];
          const row = rowArr[0];
          if (row && Number.isFinite(Number(row.close))) {
            const close = Number(row.close);
            seedBar = { timeSec: 0, open: close, high: close, low: close, close, volume: 0 };
            console.log(`[mw-reader] Seeded ${sym} from DB: ${close.toFixed(2)}`);
          }
        } catch { /* non-fatal */ }
      }
      if (seedBar) {
        const nowSec = Math.floor(Date.now() / 1000);
        const bucket1m = Math.floor(nowSec / 60) * 60;
        const bucket5m = Math.floor(nowSec / 300) * 300;
        // CANDLE FIX: only use seed bar close as open when bar is fresh; stale bar → let first tick self-seed
        const seedAgeMs = Date.now() - (seedBar.timeSec + 300) * 1000;
        if (seedAgeMs < 300_000) {
          // CANDLE FIX: bar just completed — safe to chain its close as the next bar's open
          inProgressBar1m.set(sym, { timeSec: bucket1m, open: seedBar.close, high: seedBar.close, low: seedBar.close, close: seedBar.close, volume: 0 });
          inProgressBar5m.set(sym, { timeSec: bucket5m, open: seedBar.close, high: seedBar.close, low: seedBar.close, close: seedBar.close, volume: 0 });
        } else {
          // CANDLE FIX: seed bar is stale — skip inProgressBar init so first tick self-seeds open+close from same price
          console.log(`[mw-reader] ${sym} seed bar is stale (${Math.round(seedAgeMs/60000)}m old) — skipping in-progress bar init. First tick will self-seed.`);
        }
        lastTickPrice.set(sym, seedBar.close); // CANDLE FIX: always record last known price regardless of age
      }
      if (!dirExists) continue; // skip tick-file / fs.watch setup if directory is absent

      // Locate the active tick file — with verbose diagnostics
      try {
        const allFiles = fs.readdirSync(instrDir);
        const tickFiles = allFiles.filter(f => f.endsWith(".tick_data"));
        const barFiles  = allFiles.filter(f => f.endsWith(".bar_data1"));
        console.log(`[mw-reader] ${instrDir} contains ${barFiles.length} bar files, ${tickFiles.length} tick files`);
        if (tickFiles.length > 0) {
          console.log(`[mw-reader] Tick files found: ${tickFiles.slice(-3).join(", ")}`);
        }
      } catch (e: any) {
        console.log(`[mw-reader] Could not list directory: ${e.message}`);
      }

      const initialTickFile = findActiveTickFile(instrDir);
      if (!initialTickFile) {
        console.log(`[mw-reader] No active tick file found — live price unavailable until MW writes one`);
      } else {
        activeTickFile.set(instrDir, initialTickFile);
        let initialSize = 0;
        try { initialSize = fs.statSync(initialTickFile).size; } catch {}
        activeTickSize.set(instrDir, initialSize);
        console.log(`[mw-reader] Active tick file: ${path.basename(initialTickFile)} (${initialSize} bytes)`);

        try {
          const tickStat = fs.statSync(initialTickFile);
          const ageMin = (Date.now() - tickStat.mtimeMs) / 60_000;
          const tickPrice = readLastTickRecord(initialTickFile);
          if (tickPrice !== null) {
            const nowSec = Math.floor(Date.now() / 1000);
            const bucket1m = Math.floor(nowSec / 60) * 60;
            const bucket5m = Math.floor(nowSec / 300) * 300;
            // Sanity-check the tick file price against the last known good bar close.
            // readLastTickRecord scans for any float32 in [400,50000] — corrupt bytes in the
            // file can return a plausible-looking but wrong value (e.g. 1339 when price is 6857).
            // If the tick deviates >15% from the last completed bar, reject it entirely.
            const lastClose = latestBar5.get(sym)?.close;
            const tickValid = !lastClose || (tickPrice / lastClose >= 0.85 && tickPrice / lastClose <= 1.15);
            if (!tickValid) {
              console.warn(`[mw-reader] Cold-start tick price ${tickPrice.toFixed(2)} rejected (last close ${lastClose?.toFixed(2)}, ratio ${(tickPrice / lastClose!).toFixed(3)}) — keeping bar close as seed`);
            } else {
              // Open = last completed bar's close (candle continuity). Tick price = current close.
              const open = lastClose ?? tickPrice;
              inProgressBar1m.set(sym, { timeSec: bucket1m, open, high: Math.max(open, tickPrice), low: Math.min(open, tickPrice), close: tickPrice, volume: 0 });
              inProgressBar5m.set(sym, { timeSec: bucket5m, open, high: Math.max(open, tickPrice), low: Math.min(open, tickPrice), close: tickPrice, volume: 0 });
              lastTickPrice.set(sym, tickPrice);
              console.log(`[mw-reader] Refined ${sym} seed to tick price: ${tickPrice.toFixed(2)} (open=${open.toFixed(2)}, file age: ${ageMin.toFixed(0)}m)`);
            }
          } else {
            console.log(`[mw-reader] readLastTickRecord returned null — keeping bar close as seed`);
          }
        } catch (e: any) {
          console.log(`[mw-reader] Tick file read error: ${e.message}`);
        }
      }

      // Bar-file polling (1 s) — updates completed 5-min/60-min bars in DB
      setInterval(async () => {
        try {
          await pollChanged(symbol, instrDir);
        } catch (err: any) {
          console.error(`[mw-reader] Poll error for ${symbol}:`, err.message);
        }
      }, POLL_INTERVAL_MS);

      // fs.watch — OS-level notification, fires within milliseconds of MW writing a tick
      try {
        const watcher = fs.watch(instrDir, { persistent: true }, (_event, filename) => {
          try { onTickFileChange(symbol, instrDir, filename); } catch { /* silent */ }
        });
        watcher.on("error", () => {
          console.warn(`[mw-reader] fs.watch error for ${instrDir} — falling back to 1s poll only`);
        });
        console.log(`[mw-reader] fs.watch active on ${instrDir}`);
      } catch {
        console.warn(`[mw-reader] fs.watch unavailable — using 1s poll fallback only`);
      }

      // 16ms fallback poll — catches any ticks that fs.watch may have missed
      setInterval(() => {
        try { fallbackTickPoll(symbol, instrDir); } catch { /* silent */ }
      }, 16);

      // 5s tick-file rescan — detects when MW creates a NEW tick file (new hour / new session).
      // The fallback poll only checks the currently tracked file; this catches rollovers.
      // Also logs tick file size so we can see if MW is actually writing anything.
      let _lastLoggedSize = -1;
      setInterval(() => {
        const newFp = findActiveTickFile(instrDir);
        if (newFp && newFp !== activeTickFile.get(instrDir)) {
          console.log(`[mw-reader] New tick file detected: ${path.basename(newFp)}`);
          activeTickFile.set(instrDir, newFp);
          activeTickSize.set(instrDir, 0);
          _lastLoggedSize = -1;
        }
        const fp = activeTickFile.get(instrDir);
        if (fp) {
          try {
            const sz = fs.statSync(fp).size;
            if (sz !== _lastLoggedSize) {
              console.log(`[mw-reader] Tick file size: ${sz} bytes (${path.basename(fp)})`);
              _lastLoggedSize = sz;
            }
          } catch { /* ignore */ }
        }
      }, 5_000);

      // 16ms heartbeat (~60fps) — re-runs applyTick with the last known price.
      // Suppressed when TickRelay WebSocket is active (notifyExternalTick was called
      // within the last 5 seconds) to prevent stale disk prices overriding live ticks.
      setInterval(() => {
        const sym = symbol.toUpperCase();
        const p   = lastTickPrice.get(sym);
        if (p === undefined) return;
        if (Date.now() - (lastExternalTickMs.get(sym) ?? 0) < 5_000) return;
        try { applyTick(sym, p); } catch { /* silent */ }
      }, 16);
    }

    // Feed staleness monitor — checks every 15 s and broadcasts status changes.
    // Rithmic sim silently stops sending heartbeats while MW stays "green";
    // this detects the freeze so the UI can warn the user.
    setInterval(() => {
      for (const { symbol } of MW_INSTRUMENTS) {
        const sym    = symbol.toUpperCase();
        const last   = lastTickAt.get(sym);
        const elapsed = last !== undefined ? Date.now() - last : Infinity;
        const status  = last === undefined ? "unknown"
                      : elapsed > 60_000   ? "stale"
                      :                      "live";
        if (status !== prevFeedStatus.get(sym) && _broadcast) {
          _broadcast({
            type:   "feedStatus",
            symbol: sym,
            status,
            secondsSinceTick: last !== undefined ? Math.floor(elapsed / 1000) : null,
          });
          prevFeedStatus.set(sym, status);
        }
      }
    }, 15_000);
  })();
}
