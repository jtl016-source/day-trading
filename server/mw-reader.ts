/**
 * MotiveWave binary bar-file reader.
 *
 * Reads .bar_data1 (1-minute OHLCV) files written by MotiveWave into its
 * local historical_data cache, aggregates them to 5-min and 60-min bars,
 * upserts into cached_candles so the existing chart data flow works unchanged,
 * and polls every 2 s to broadcast live updates via the shared WebSocket.
 *
 * File format (confirmed via hex analysis of actual MESH6/MESM6.CME bar files):
 *   Header : 48 bytes  (skipped)
 *   Records: 30 bytes each
 *     [0..3]   float32BE — open
 *     [4..7]   float32BE — high
 *     [8..11]  float32BE — low
 *     [12..15] float32BE — close
 *     [16..19] float32BE — volume
 *     [20..27] 8 bytes   — unknown (zeroes, ignored)
 *     [28..29] uint16BE  — minuteOffset (minutes since file epoch → bar timestamp)
 *   bar_time_sec = floor(filename_ms / 1000) + minuteOffset * 60
 */

import fs   from "fs";
import path from "path";
import { db } from "./db";
import { cachedCandles } from "@shared/schema";
import { normalizeSymbol } from "@shared/symbol";
import { isSaneBarTime, validateBar } from "@shared/bar-time";
import { sql } from "drizzle-orm";
import { type Express }    from "express";
import { type Server as HttpServer } from "http";

// ── Config ────────────────────────────────────────────────────────────────────

// Tick-size sanity check for applyTick — rejects ticks that deviate too many
// points from the last known good price (catches corrupt tick-file bytes).
const TICK_SIZE              = 0.25;   // MES/ES minimum tick = 0.25 index points
const DEFAULT_TICK_SIZE      = 0.25;
// 200 ticks = 50 pts. Disk-path ticks are sampled once per file-change event (every few seconds),
// so a legitimate price move between samples is small (a 40-pt sell-off over 15m is ~0.04 pts/sec).
// The corrupt byte-scan case we saw was 53 pts (212 ticks) — this threshold rejects it while
// allowing genuine intra-session moves. Session opens (>30 min silence) bypass this entirely.
const MAX_TICK_DEVIATION     = 200;
const DEFAULT_MAX_TICK_DEVIATION = 200;

// MW-SYNC (v2 architecture change, 2026-07-09): MotiveWave is now the SINGLE SOURCE OF TRUTH
// for chart candles via the server-driven getBars backfill protocol (see live-bars.ts / gap-audit.ts).
// The disk-file reconstruction (.bar_data1 bulk load + .tick_data fs.watch/poll → bulkUpsert) was the
// "phantom factory" behind this week's glitch classes (phantom bars, stale opens, splice corruption,
// frozen intervals). It is DISABLED here so it no longer WRITES to the DB. What stays live:
//   - notifyExternalTick (TickRelay WS tick path): provides the live forming bar + provisional
//     completed bars that MW's authoritative backfill later overwrites via onConflictDoUpdate.
//   - setMWBroadcast / setTickRelayConnected / getMemBars / getLatestBar* exports (routes.ts fallback).
// One-line revertible: flip to true to restore disk ingestion. getMemBars may return empty/stale after
// this demotion (acceptable per the plan) but must never throw.
const DISK_INGEST_ENABLED = false;

// TODO: make configurable for distribution (e.g. via MW_DATA_ROOT env var)
const MW_DATA_ROOT = process.env.MW_DATA_ROOT ?? path.join(
  process.env.USERPROFILE ?? "C:\\Users\\jacks",
  "AppData", "Roaming", "MotiveWave", "historical_data", "RITHMIC",
);

// Map: logical symbol → (a) regex to match ALL contract-month directories,
//                        (b) activeDir = COLD-START FALLBACK ONLY.
// The live directory is now chosen dynamically by pickActiveDir() (newest-written contract),
// so the quarterly roll no longer breaks the feed. Historical data is still merged across all
// matching expiry dirs (MESH6, MESM6, …) by loadMultiDir().
const MW_INSTRUMENTS: { symbol: string; dirPattern: RegExp; activeDir: string }[] = [
  { symbol: "MES", dirPattern: /^MES[A-Z]\d+\.CME$/, activeDir: "MESM6.CME" },
];

/** Return all subdirectories under MW_DATA_ROOT whose names match pattern.
 *  Only returns dirs that have at least one .tick_data file — MW writes tick files only
 *  for contracts it is actively tracking (current or recently expired front-month).
 *  This naturally excludes deferred contracts like MESU6 whose prices differ from the
 *  active front-month by the forward roll premium, which would corrupt merged bar data. */
function getContractDirs(pattern: RegExp): string[] {
  try {
    return fs.readdirSync(MW_DATA_ROOT)
      .filter(d => pattern.test(d))
      .map(d => path.join(MW_DATA_ROOT, d))
      .filter(d => {
        try {
          if (!fs.statSync(d).isDirectory()) return false;
          // Must have at least one tick file — signals this was/is an active contract
          return fs.readdirSync(d).some(f => f.endsWith(".tick_data"));
        } catch { return false; }
      });
  } catch { return []; }
}

/**
 * Pick the active contract directory dynamically: the matching dir whose most recent
 * .tick_data / .bar_data1 file has the newest mtime — i.e. the contract MotiveWave is
 * currently writing. Roll-proof: no hardcoded contract month.
 */
function pickActiveDir(pattern: RegExp): string | null {
  const dirs = getContractDirs(pattern);
  let best: string | null = null;
  let bestMtime = -1;
  for (const d of dirs) {
    try {
      const files = fs.readdirSync(d).filter(f => f.endsWith(".tick_data") || f.endsWith(".bar_data1"));
      for (const f of files) {
        const m = fs.statSync(path.join(d, f)).mtimeMs;
        if (m > bestMtime) { bestMtime = m; best = d; }
      }
    } catch { /* skip unreadable dir */ }
  }
  return best;
}

/**
 * Load all bar files from multiple contract directories, merge by timestamp
 * (preferring the bar with higher volume = front-month contract), then
 * wipe + re-insert the DB rows for `symbol`.
 */
// How far back to read tick files for gap-filling.
// Bar files are sparse (weekly summaries, ~15 bars/file). Tick files contain the actual
// minute-by-minute trading data. MW keeps ~9 months of hourly tick files per contract.
// 300 days × 24 files/day × both contracts = ~14k files — reads in ~60s on first load.
const TICK_HISTORY_MS = 300 * 24 * 3600 * 1000;

// DST-safe CME futures trading-day key for a bar timestamp. The session runs 6:00 PM ET (prior
// calendar day) through 5:00 PM ET the "labeled" day — matches the ETH/RTH convention used
// elsewhere in the app (see CLAUDE.md). Needed so per-day volume comparison during contract-roll
// merging (below) buckets bars the same way CME's trading day does, not by naive UTC calendar day
// (which would split one overnight session across two different "days"). Must use
// Intl.DateTimeFormat("America/New_York") — NEVER a hardcoded UTC offset (DST shifts it by 1h).
const _sessionDayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23",
});
function sessionDayKey(timestampSec: number): string {
  const parts = _sessionDayFmt.formatToParts(new Date(timestampSec * 1000));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "0";
  const y = +get("year"), mo = +get("month"), d = +get("day"), h = +get("hour");
  // Bars at/after 6:00 PM ET belong to the NEXT session day (the overnight leading into
  // tomorrow's RTH open) — compute via UTC date math so month/year rollovers are automatic.
  const dayUtc = h >= 18 ? new Date(Date.UTC(y, mo - 1, d + 1)) : new Date(Date.UTC(y, mo - 1, d));
  return `${dayUtc.getUTCFullYear()}-${String(dayUtc.getUTCMonth() + 1).padStart(2, "0")}-${String(dayUtc.getUTCDate()).padStart(2, "0")}`;
}

async function loadMultiDir(symbol: string, instrDirs: string[]) {
  // ── Step 1: Load all bar_data1 files (authoritative OHLCV), GROUPED BY CONTRACT DIR ──
  // Kept per-directory (not flattened) so Step 1b can pick one front-month contract per
  // trading day using each contract's TOTAL daily volume.
  const perDirBars: MinBar[][] = [];
  let totalBarFiles = 0;

  for (const instrDir of instrDirs) {
    const files = getBarFiles(instrDir);
    totalBarFiles += files.length;
    const dirBars: MinBar[] = [];
    for (const fp of files) {
      dirBars.push(...parseBarFile(fp));
      try { fileMTimes.set(fp, fs.statSync(fp).mtimeMs); } catch {}
    }
    perDirBars.push(dirBars);
    console.log(`[mw-reader] Scanned ${path.basename(instrDir)}: ${files.length} bar files`);
  }

  // ── Step 1b: CONTRACT ROLL — pick ONE front-month contract per trading day ─────────
  // Previously this deduped per-MINUTE ("prefer highest volume") — during roll week the
  // front-month and next-month contracts often have close volume, so the "winner" could
  // flip back and forth minute-to-minute between two contracts trading at different price
  // levels (normal contango/backwardation), producing jagged, self-contradictory candles.
  // Comparing each contract's TOTAL volume for the whole trading day is stable — CME
  // front-month status doesn't flip mid-session — so this reliably tracks the real front
  // month. Splice is UNADJUSTED (raw prices): there may be a visible price step on the
  // actual roll day, matching an unadjusted continuous-contract view (by design).
  const dayVolumeByDir = new Map<string, number[]>(); // sessionDay → volume per dirIdx
  perDirBars.forEach((bars, dirIdx) => {
    for (const b of bars) {
      const day = sessionDayKey(b.timeSec);
      let vols = dayVolumeByDir.get(day);
      if (!vols) { vols = new Array(perDirBars.length).fill(0); dayVolumeByDir.set(day, vols); }
      vols[dirIdx] += b.volume;
    }
  });
  const dayWinnerDir = new Map<string, number>();
  for (const [day, vols] of dayVolumeByDir) {
    let bestIdx = 0, bestVol = -1;
    for (let i = 0; i < vols.length; i++) if (vols[i] > bestVol) { bestVol = vols[i]; bestIdx = i; }
    dayWinnerDir.set(day, bestIdx);
  }
  const allMin: MinBar[] = [];
  perDirBars.forEach((bars, dirIdx) => {
    for (const b of bars) {
      if (dayWinnerDir.get(sessionDayKey(b.timeSec)) === dirIdx) allMin.push(b);
    }
  });

  allMin.sort((a, b) => a.timeSec - b.timeSec);
  const minMap = new Map<number, MinBar>();
  for (const b of allMin) minMap.set(b.timeSec, b); // each day now has exactly one contract — no volume race needed

  // ── Step 2: Detect and log intraday gaps (no synthetic fill) ─────────────
  // Only warn for genuine intraday gaps (> 2 min and < 55 min).
  // Excludes: overnight/weekend (> 4h), CME daily maintenance window (~61 min).
  {
    const sortedTimes = Array.from(minMap.keys()).sort((a, b) => a - b);
    for (let i = 1; i < sortedTimes.length; i++) {
      const delta = sortedTimes[i] - sortedTimes[i - 1];
      if (delta > 120 && delta < 55 * 60) {
        const ts = new Date(sortedTimes[i - 1] * 1000).toISOString();
        console.warn(`[MW-READER] Gap at ${ts}: no bar data available, skipped`);
      }
    }
  }

  // ── Step 3: Aggregate and write to DB ──────────────────────────────────────
  // Strip future-dated bars: sparse contract bar files (MESU6, etc.) sometimes contain
  // placeholder bars for the remainder of the contract life. Cap at current time + 1h
  // to avoid pushing the chart's default view into an empty future region.
  const nowSec = Math.floor(Date.now() / 1000) + 3600;
  const bars1 = Array.from(minMap.values())
    .filter(b => b.timeSec <= nowSec)
    .sort((a, b) => a.timeSec - b.timeSec);
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

    // 60m alignment cleanup: 60m bars are standardized on :00 top-of-hour (Yahoo's alignment
    // and the deep-history source; matches serving filter `timestamp % 3600 === 0`). Purge any
    // stale :30-boundary rows (timestamp % 3600 === 1800) left over from the prior :30 alignment
    // so the 60m series stays single-aligned (no offset/duplicate bars). Yahoo :00 bars are kept.
    await db.$client.prepare(
      `DELETE FROM cached_candles WHERE symbol = ? AND resolution = '60' AND (timestamp % 3600) = 1800`
    ).run(symbol.toUpperCase());
  } catch (e: any) {
    console.warn(`[mw-reader] DB write failed (quota?): ${e.message} — in-memory bars still available`);
  }

  console.log(
    `[mw-reader] ${symbol}: ${totalBarFiles} bar files → ` +
    `${bars1.length} 1-min, ${bars5.length} 5-min, ${bars60.length} 60-min bars`,
  );
}

// bar_data1 format: 48-byte header, then 30-byte records
// Each record: open(f32) high(f32) low(f32) close(f32) vol(f32) 8-padding minuteOffset(u16)
// minuteOffset = minutes since file epoch — used to compute the bar's exact timestamp.
const HEADER_SIZE  = 48;
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

  // Cap elapsed time to [60s, 3600s] — prevents future-dated ticks for the current hour's file.
  // Old files: Date.now() - fileMs > 3_600_000 → clamp to full hour (correct).
  // Current file: elapsed < 3_600_000 → distribute only across the portion of the hour that has passed.
  const elapsedMs = Math.max(60_000, Math.min(3_600_000, Date.now() - fileMs));

  for (let i = 0; i < totalRecords; i++) {
    const price = buf.readFloatBE(TICK_HEADER + i * TICK_RECORD + TICK_ASK_OFF);
    if (!isFinite(price) || price < 400 || price > 50_000) continue;

    // Distribute ticks proportionally across the elapsed portion of the file window
    const tickMs     = fileMs + Math.floor((i / totalRecords) * elapsedMs);
    const bucketSec  = Math.floor(tickMs / 60_000) * 60;
    if (!isSaneBarTime(bucketSec)) continue; // skip bars from a garbage-named tick file

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
const inProgressBar60m = new Map<string, MinBar>(); // current forming 60-min bar
const lastTickPrice      = new Map<string, number>();  // last seen ask price per symbol
const lastTickAt         = new Map<string, number>();  // symbol → Date.now() of last tick received
const prevFeedStatus     = new Map<string, string>();  // symbol → last broadcast feed status
const lastExternalTickMs     = new Map<string, number>();  // symbol → last tick from TickRelay WebSocket
const lastFormingBroadcastMs = new Map<string, number>();  // symbol → last forming-bar broadcast time

// TickRelay connection state — true while MW study WS is open; disk polling suppressed during this time
let tickRelayConnected = false;

export function setTickRelayConnected(connected: boolean): void {
  if (tickRelayConnected === connected) return;
  tickRelayConnected = connected;
  console.log(`[mw-reader] tickRelayConnected → ${connected}`);
  if (connected) {
    // Wipe bars seeded by disk polling so the next TickRelay tick opens a fresh bar
    // with the correct live price as open (not a stale disk-read price from hours ago).
    inProgressBar1m.clear();
    inProgressBar5m.clear();
    inProgressBar60m.clear();
    console.log("[mw-reader] Cleared in-progress bars — TickRelay is now authoritative");
  }
}

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
function readLastTickRecord(filePath: string, hint?: number): number | null {
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

  // Collect every plausible MES-range float in the tail (scanning from the end = newest first).
  const candidates: number[] = [];
  for (let i = scanSize - 4; i >= 0; i--) {
    const v = buf.readFloatBE(i);
    if (isFinite(v) && v >= 400 && v <= 50_000) candidates.push(v);
  }
  if (!candidates.length) return null;

  // With a reference price, return the candidate CLOSEST to it. Corrupt byte patterns produce
  // in-range floats that are far from the true price (e.g. 7524 when price is 7577); closest-to-
  // hint rejects those while still tracking real movement (consecutive ticks are near each other).
  if (hint && hint > 0) {
    let best = candidates[0], bestDiff = Math.abs(candidates[0] - hint);
    for (const c of candidates) {
      const d = Math.abs(c - hint);
      if (d < bestDiff) { best = c; bestDiff = d; }
    }
    // If even the best candidate is >40 pts from the reference, the entire tail is corrupt.
    // Return null — no update is safer than a wrong wick. TickRelay continues providing
    // accurate prices, and the next real file change will supply a fresh (closer) candidate.
    if (bestDiff > 40) return null;
    return best;
  }
  return candidates[0]; // no reference yet — newest in-range float wins
}

/** Update both the in-progress 1-min and 5-min bars with a new tick price and broadcast both. */
function applyTick(symbol: string, price: number) {
  const sym = symbol.toUpperCase();

  // Sanity check: reject ticks that deviate more than MAX_TICK_DEVIATION ticks from reference.
  // Bypass for first tick after a long session gap (>30 min) — allows legitimate gap opens.
  const refBar = inProgressBar1m.get(sym) ?? latestBar5.get(sym);
  const msSinceLastTick = Date.now() - (lastTickAt.get(sym) ?? 0);
  if (refBar && refBar.close > 0 && msSinceLastTick < 1_800_000) {
    const deviationTicks = Math.abs(price - refBar.close) / TICK_SIZE;
    if (deviationTicks > MAX_TICK_DEVIATION) {
      console.warn(`[mw-tick] ${sym} rejected suspicious price ${price.toFixed(2)} (ref ${refBar.close.toFixed(2)}, deviation ${deviationTicks.toFixed(1)} ticks)`);
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
    prev1m.volume += 1; // tick count as volume proxy (see notifyExternalTick) — v0 bars get ghost-rejected at persist
  } else {
    // CANDLE FIX: only chain prev close as open when consecutive buckets — gap means self-seed
    const is1mContiguous = prev1m != null && (bucket1m - prev1m.timeSec <= 60);
    inProgressBar1m.set(sym, {
      timeSec: bucket1m,
      open:  is1mContiguous ? prev1m.close : price, // CANDLE FIX: gap-safe open
      high:  price,
      low:   price,
      close: price,
      volume: 1, // tick count
    });
  }

  // ── 5-min in-progress bar ────────────────────────────────────────────────
  const prev5m = inProgressBar5m.get(sym);
  if (prev5m && prev5m.timeSec === bucket5m) {
    prev5m.close = price;
    if (price > prev5m.high) prev5m.high = price;
    if (price < prev5m.low)  prev5m.low  = price;
    prev5m.volume += 1; // tick count
  } else {
    // CANDLE FIX: only chain prev close as open when consecutive buckets — gap means self-seed
    const is5mContiguous = prev5m != null && (bucket5m - prev5m.timeSec <= 300);
    inProgressBar5m.set(sym, {
      timeSec: bucket5m,
      open:  is5mContiguous ? prev5m.close : price, // CANDLE FIX: gap-safe open
      high:  price,
      low:   price,
      close: price,
      volume: 1, // tick count
    });
  }

  // ── 60-min in-progress bar ────────────────────────────────────────────────
  // Use the RTH-aligned :30 bucket so the live forming bar matches Yahoo/LiveBarRelay timestamps.
  const bucket60m = agg60mBucket(nowSec);
  const prev60m = inProgressBar60m.get(sym);
  if (prev60m && prev60m.timeSec === bucket60m) {
    prev60m.close = price;
    if (price > prev60m.high) prev60m.high = price;
    if (price < prev60m.low)  prev60m.low  = price;
    prev60m.volume += 1; // tick count
  } else {
    const is60mContiguous = prev60m != null && (bucket60m - prev60m.timeSec <= 3600);
    inProgressBar60m.set(sym, { timeSec: bucket60m, open: is60mContiguous ? prev60m.close : price, high: price, low: price, close: price, volume: 1 }); // tick count
  }

  if (!_broadcast) return;
  const bar1m  = inProgressBar1m.get(sym)!;
  const bar5m  = inProgressBar5m.get(sym)!;
  const bar60m = inProgressBar60m.get(sym)!;
  // Broadcast all resolutions so 1m, 5m, and 60m chart tabs all update immediately
  _broadcast({ type: "bar", resolution: "1",  bar: { symbol: sym, time: bar1m.timeSec,  open: bar1m.open,  high: bar1m.high,  low: bar1m.low,  close: bar1m.close,  volume: bar1m.volume,  complete: false } });
  _broadcast({ type: "bar", resolution: "5",  bar: { symbol: sym, time: bar5m.timeSec,  open: bar5m.open,  high: bar5m.high,  low: bar5m.low,  close: bar5m.close,  volume: bar5m.volume,  complete: false } });
  _broadcast({ type: "bar", resolution: "60", bar: { symbol: sym, time: bar60m.timeSec, open: bar60m.open, high: bar60m.high, low: bar60m.low, close: bar60m.close, volume: bar60m.volume, complete: false } });
  // Lightweight tick broadcast — just the raw price, no OHLCV.
  // Client uses this for the direct series.update() fast path (bypasses React state).
  _broadcast({ type: "tick", symbol: sym, price });
}

/**
 * Called on every fs.watch event for the instrument directory.
 * Reads only the last 45 bytes of the active tick file — sub-millisecond.
 */
function onTickFileChange(symbol: string, instrDir: string, changedFilename: string | null) {
  // MW-SYNC: disk tick reconstruction is disabled — live prices come from the TickRelay WS
  // (notifyExternalTick) and history from MW's server-driven backfill. This path used to feed
  // applyTick → bulkUpsert, writing provisional/phantom bars from stale disk bytes.
  if (!DISK_INGEST_ENABLED) return;
  // TickRelay WebSocket is active — its prices are authoritative; skip disk reads.
  if (tickRelayConnected) return;
  const sym0 = symbol.toUpperCase();
  // Secondary guard: if a TickRelay tick arrived within the last 5 s, the flag may have
  // been briefly flipped false by the close-handler bug — don't let a stale disk read
  // corrupt the live price during that window.
  if (Date.now() - (lastExternalTickMs.get(sym0) ?? 0) < 5_000) return;

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

  const symHint = normalizeSymbol(symbol);
  const price = readLastTickRecord(fp, lastTickPrice.get(symHint) ?? latestBar5.get(symHint)?.close);
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
  const sym = symbol.toUpperCase();
  const prev = latestBar5.get(sym);
  // Reject bars whose open jumps >2% from the previous bar's close within a 30-min window.
  // Catches corrupt LiveBarRelay bars (e.g. O=7280 when prev.close=7439) that pass the
  // body-anomaly check because their mid is close to correct.
  if (prev && prev.close > 0 && prev.timeSec > 0) {
    const gapSec = bar.timeSec - prev.timeSec;
    const openDev = Math.abs(bar.open - prev.close) / prev.close;
    if (gapSec < 1800 && openDev > 0.02) {
      console.warn(`[mw-tick] ${sym} rejected corrupt 5m bar: open=${bar.open.toFixed(2)} vs prev.close=${prev.close.toFixed(2)} (${(openDev*100).toFixed(1)}% gap=${gapSec}s)`);
      return;
    }
  }
  bulkUpsert(symbol, "5", [bar]).catch(() => {});
}

/**
 * Called by live-bars.ts whenever a live tick arrives from the TickRelay WebSocket study.
 * Updates internal bar state (so /api/live/bar stays accurate) and marks the feed as fresh
 * so the 16ms disk heartbeat stays suppressed while TickRelay is active.
 */
export function notifyExternalTick(symbol: string, price: number) {
  // Canonical symbol so keys match the disk reader and the client.
  const sym = normalizeSymbol(symbol);
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
    // volume===0 marks a BOOT-SEEDED bar (stale tick-file price) that has never received a real
    // tick — RESEED it wholesale at this tick's price instead of merely updating close. Merely
    // updating left the stale seed as open/high, persisting phantom-open bars (e.g. the 07-08
    // 19:42Z 1m bar that opened 35pt above the market at the old 7559.25 seed price).
    if (prev1m.volume === 0) {
      prev1m.open = price; prev1m.high = price; prev1m.low = price; prev1m.close = price;
      prev1m.volume = 1;
    } else {
      prev1m.close = price;
      if (prev1m.high < price) prev1m.high = price;
      if (prev1m.low  > price) prev1m.low  = price;
      // Tick count as volume proxy (same convention as the tick-file parser). Without this the
      // completed bar carries volume 0 and bulkUpsert's validateBar ghost-guard rejects it — the
      // exact bug that froze 1m DB persistence while ticks were flowing fine. Real MW volume
      // overwrites via onConflictDoUpdate when a bar-file flush covers this bucket.
      prev1m.volume += 1;
    }
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
    inProgressBar1m.set(sym, { timeSec: bucket1m, open: is1mContiguous ? prev1m.close : price, high: price, low: price, close: price, volume: 1 }); // volume = tick count (see above)
  }

  const prev5m = inProgressBar5m.get(sym);
  if (prev5m && prev5m.timeSec === bucket5m) {
    if (prev5m.volume === 0) {
      // Boot-seeded bar (stale price, no real tick yet) — reseed at this tick. See 1m note.
      prev5m.open = price; prev5m.high = price; prev5m.low = price; prev5m.close = price;
      prev5m.volume = 1;
    } else {
      prev5m.close = price;
      if (price > prev5m.high) prev5m.high = price;
      if (price < prev5m.low)  prev5m.low  = price;
      prev5m.volume += 1; // tick count as volume proxy — see 1m note above
    }
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
    inProgressBar5m.set(sym, { timeSec: bucket5m, open: is5mContiguous ? prev5m.close : price, high: price, low: price, close: price, volume: 1 }); // volume = tick count
  }

  // ── 60-min in-progress bar ────────────────────────────────────────────────
  // RTH-aligned :30 bucket — matches Yahoo Finance and LiveBarRelay timestamps.
  const bucket60m = agg60mBucket(nowSec);
  const prev60m = inProgressBar60m.get(sym);
  if (prev60m && prev60m.timeSec === bucket60m) {
    if (prev60m.volume === 0) {
      // Boot-seeded bar (stale price, no real tick yet) — reseed at this tick. See 1m note.
      prev60m.open = price; prev60m.high = price; prev60m.low = price; prev60m.close = price;
      prev60m.volume = 1;
    } else {
      prev60m.close = price;
      if (price > prev60m.high) prev60m.high = price;
      if (price < prev60m.low)  prev60m.low  = price;
      prev60m.volume += 1; // tick count as volume proxy — see 1m note above
    }
  } else {
    if (prev60m && prev60m.timeSec > 0 && prev60m.open > 0) {
      bulkUpsert(sym, "60", [prev60m]).catch(() => {});
      if (_broadcast) {
        _broadcast({ type: "bar", resolution: "60", bar: { symbol: sym, time: prev60m.timeSec, open: prev60m.open, high: prev60m.high, low: prev60m.low, close: prev60m.close, volume: prev60m.volume, complete: true } });
      }
    }
    const is60mContiguous = prev60m != null && (bucket60m - prev60m.timeSec <= 3600);
    inProgressBar60m.set(sym, { timeSec: bucket60m, open: is60mContiguous ? prev60m.close : price, high: price, low: price, close: price, volume: 1 }); // volume = tick count
  }

  // Broadcast the forming bars so the browser's liveCandles stays in sync (for signal computation).
  // Throttled to once per second — the tick fast path already handles the Y-axis in real time.
  if (_broadcast) {
    const now = Date.now();
    if (now - (lastFormingBroadcastMs.get(sym) ?? 0) >= 1_000) {
      lastFormingBroadcastMs.set(sym, now);
      const cur5m = inProgressBar5m.get(sym)!;
      _broadcast({ type: "bar", resolution: "5",  bar: { symbol: sym, time: cur5m.timeSec, open: cur5m.open, high: cur5m.high, low: cur5m.low, close: cur5m.close, volume: cur5m.volume, complete: false } });
      const cur1m = inProgressBar1m.get(sym)!;
      _broadcast({ type: "bar", resolution: "1",  bar: { symbol: sym, time: cur1m.timeSec, open: cur1m.open, high: cur1m.high, low: cur1m.low, close: cur1m.close, volume: cur1m.volume, complete: false } });
      const cur60m = inProgressBar60m.get(sym);
      if (cur60m) {
        _broadcast({ type: "bar", resolution: "60", bar: { symbol: sym, time: cur60m.timeSec, open: cur60m.open, high: cur60m.high, low: cur60m.low, close: cur60m.close, volume: cur60m.volume, complete: false } });
      }
    }
  }

  // FOOTPRINT-MIDTRADE: check for mid-trade delta divergence on each external tick
  _checkMidTradeDivergence?.(sym, price); // FOOTPRINT-MIDTRADE:
}

// ── Broadcast hook (set by live-bars.ts after WebSocket server is up) ─────────

let _broadcast: ((msg: object) => void) | null = null;

export function setMWBroadcast(fn: (msg: object) => void) {
  _broadcast = fn;
}

// Pre-resolve footprint engine import so notifyExternalTick never creates a
// dynamic-import Promise microtask on every MW tick (same pattern as live-bars.ts _fpAddBar).
let _checkMidTradeDivergence: ((sym: string, price: number) => void) | null = null;
import("./footprint-engine").then(m => { _checkMidTradeDivergence = (m as any).checkMidTradeDivergence ?? null; }).catch(() => {});

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
    const open      = buf.readFloatBE(o);
    const high      = buf.readFloatBE(o + 4);
    const low       = buf.readFloatBE(o + 8);
    const close     = buf.readFloatBE(o + 12);
    const vol       = buf.readFloatBE(o + 16);
    const minuteOff = buf.readUInt16BE(o + 28);

    // Reject NaN/Infinity, zero/negative prices, and corrupt records.
    // Lower bound 100: futures prices (ES ~5000, MES ~5000) are never below $100.
    // Ratio guard: high > low*2 means a 100%+ intrabar move — impossible in normal markets.
    if (
      !isFinite(open) || !isFinite(high) || !isFinite(low) || !isFinite(close) ||
      open < 100 || high < low || low < 100 ||
      low > open || low > close || high < open || high < close ||
      open > 1e6 || high > 1e6 || low > 1e6 || close > 1e6 ||
      high > low * 2
    ) continue;

    // minuteOff is the minute-of-week offset from the file's epoch timestamp.
    const timeSec = Math.floor(fileMs / 1000) + minuteOff * 60;
    if (!isSaneBarTime(timeSec)) continue; // drop corrupt/future-dated bars (bad filename or seq)

    bars.push({
      timeSec,
      open, high, low, close,
      volume: (vol > 0 && vol < 1e9) ? Math.round(vol) : 0,
    });
  }

  return bars;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

// 60m bars align to :00 top-of-hour. This is Yahoo's ES=F 60m alignment (empirically
// verified — Yahoo returns bars at 22:00, 23:00, 00:00 … UTC, NOT :30) and it's where the
// deep 2-year history lives, so the live/aggregated MW bars must match it. It also matches
// the serving filter `timestamp % 3600 === 0` in routes.ts and client get60mBucket().
// (A prior version offset by :30 on the mistaken belief Yahoo used :30 — that produced MW
// bars the serving filter silently dropped. Standardized on :00 per user decision.)
function agg60mBucket(timeSec: number): number {
  return Math.floor(timeSec / 3600) * 3600;
}

function aggregate(minBars: MinBar[], periodMin: number): MinBar[] {
  const pSec = periodMin * 60;
  const map  = new Map<number, MinBar>();

  for (const b of minBars) {
    const t  = periodMin === 60 ? agg60mBucket(b.timeSec) : Math.floor(b.timeSec / pSec) * pSec;
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
  const nowSec = Math.floor(Date.now() / 1000);
  bars = bars.filter(b => isSaneBarTime(b.timeSec, nowSec)); // never persist future/corrupt-dated bars
  if (!bars.length) return;
  // Reject bars with prices outside a safe range — catches corrupt tick-file float32 misreads
  // (512, 8192, 14336, 47104, etc.) before they reach the DB and distort chart auto-scale.
  const resSec = (parseInt(resolution, 10) || 1) * 60;
  const clean = bars.filter(b => {
    // Ghost-bar (volume 0/null) + off-grid timestamp guards — neither existed in this
    // write path before, which is how off-grid V0 phantom rows got persisted from tick files.
    if (!validateBar(
      { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, time: b.timeSec },
      { resSec },
    )) return false;
    if (b.low < 1000 || b.high > 100_000) return false;
    if (b.open <= 0 || b.close <= 0) return false;
    if (b.high < b.low || b.high < b.open || b.high < b.close) return false;
    if (b.low > b.open || b.low > b.close) return false;
    if (b.high <= b.low) return false; // strict — rejects flat dot bars
    const range = b.high - b.low;
    if (range / b.close > 0.05) return false; // >5% H-L spread — impossible in normal MES
    // Reject doji-wick spikes: body <10% of range on a large bar (>1.5% spread).
    // A bad float32 byte in the MW binary creates an extreme wick while open/close stay near real price.
    if (range / b.close > 0.015 && Math.abs(b.open - b.close) / range < 0.10) return false;
    return true;
  });
  if (!clean.length) return;
  // Phantom-bar detection (same logic as client-side baseCandles second pass).
  // Catches corrupt bars where the bar's price level is wrong but body ratio is large
  // (so the doji-wick filter above misses it). Requires neighbor context, so must run
  // after the per-bar filter and after sorting by time.
  clean.sort((a, b) => a.timeSec - b.timeSec);
  const noPhantom: MinBar[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (i > 0 && i < clean.length - 1) {
      const pc = clean[i - 1].close, no = clean[i + 1].open;
      const surrounding = (pc + no) / 2;
      const mid = (clean[i].open + clean[i].close) / 2;
      if (surrounding > 0 && Math.abs(mid - surrounding) / surrounding > 0.015) {
        const dEnd = Math.abs(no - clean[i].close) / clean[i].close;
        const isClosePhantom = dEnd > 0.005;
        const gapDir = clean[i].open - pc;
        const barDir = clean[i].close - clean[i].open;
        const isOpenPhantom = Math.abs(gapDir) / pc > 0.01 && Math.sign(barDir) !== Math.sign(gapDir);
        if (isClosePhantom || isOpenPhantom) continue;
      }
    }
    noPhantom.push(clean[i]);
  }
  if (!noPhantom.length) return;
  // Body-anomaly detection: rejects bars whose mid-price deviates >2.5% from
  // a trimmed mean of ±10 neighbors. Catches the ~512-min recurring corrupt bars
  // that the phantom filter misses because their immediate neighbors are normal.
  const bodyClean: MinBar[] = [];
  for (let i = 0; i < noPhantom.length; i++) {
    const mid = (noPhantom[i].open + noPhantom[i].close) / 2;
    const lo = Math.max(0, i - 10), hi = Math.min(noPhantom.length, i + 11);
    const nbMids = noPhantom.slice(lo, hi)
      .filter((_, j) => lo + j !== i)
      .map(n => (n.open + n.close) / 2)
      .sort((a, b) => a - b);
    if (nbMids.length >= 4) {
      const trim = Math.floor(nbMids.length * 0.2);
      const trimmed = nbMids.slice(trim, nbMids.length - trim);
      const mean = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
      if (Math.abs(mid - mean) / mean > 0.025) continue;
    }
    bodyClean.push(noPhantom[i]);
  }
  const bodySkipped = noPhantom.length - bodyClean.length;
  if (bodySkipped > 0) console.log(`[mw-reader] bulkUpsert: rejected ${bodySkipped} body-anomaly bars for ${symbol} res=${resolution}`);
  if (!bodyClean.length) return;
  for (let i = 0; i < bodyClean.length; i += 500) {
    const values = bodyClean.slice(i, i + 500).map(b => ({
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
    // Yield to the macrotask queue between batches so HTTP requests are not starved
    // during bulk startup loads (better-sqlite3 is synchronous — without this yield
    // the event loop is blocked and the server becomes unresponsive until loading finishes).
    await new Promise(r => setImmediate(r));
  }
}

// ── File-change tracking ──────────────────────────────────────────────────────

const fileMTimes   = new Map<string, number>();
const fileBarCounts = new Map<string, number>(); // filePath → last-seen bar count (for tail upsert)

function getBarFiles(instrDir: string): string[] {
  try {
    return fs.readdirSync(instrDir)
      .filter(f => f.endsWith(".bar_data1"))
      .filter(f => {
        // Skip sparse weekly-summary files (< 10 000 bytes ≈ < 300 records).
        // MESM6 Jul–Nov 2025 files had only 3–370 records/week; those sparse bars create
        // false FVG detections in detectMilkZones (consecutive bars days apart = huge "imbalance").
        // Dense files (Dec 2025+) are 50k–200k bytes. Tick data covers Sep 2025+ gap.
        try { return fs.statSync(path.join(instrDir, f)).size >= 10_000; } catch { return false; }
      })
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

    // 1m: upsert only the new tail (the big DB win). Keep a 2-bar overlap so the last,
    // possibly still-forming, minute gets its final values.
    const prevCount = fileBarCounts.get(fp) ?? 0;
    fileBarCounts.set(fp, minBars.length);
    const startIdx = Math.max(0, Math.min(prevCount - 2, minBars.length - 1));
    const newMin = minBars.slice(startIdx);
    if (newMin.length) await bulkUpsert(symbol, "1", newMin);

    // 5m/60m: re-aggregate from the last ~130 minutes so each higher-TF bucket is rebuilt
    // from ALL of its 1m constituents (a partial bucket would otherwise overwrite a full one).
    const lastSec  = minBars[minBars.length - 1]?.timeSec ?? 0;
    const recent   = minBars.filter(b => b.timeSec >= lastSec - 130 * 60);
    const bars5  = aggregate(recent, 5);
    const bars60 = aggregate(recent, 60);
    if (bars5.length)  await bulkUpsert(symbol, "5",  bars5);
    if (bars60.length) await bulkUpsert(symbol, "60", bars60);

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

let _mwReaderStarted = false;

export function setupMWReader(_httpServer: HttpServer, _app: Express) {
  if (_mwReaderStarted) {
    console.log("[mw-reader] Already started — skipping duplicate init");
    return;
  }
  _mwReaderStarted = true;
  console.log("[mw-reader] Starting — data root:", MW_DATA_ROOT);

  (async () => {
    // One-time startup purge: corrupt rows with out-of-range timestamps (e.g. dated in the future)
    // pollute the cached-days list and push the chart's date window into empty future space — the
    // root cause of the "wrong dates + giant catch-up candle" display.
    try {
      const maxTs = Math.floor(Date.now() / 1000) + 36 * 3600;
      const info = db.$client.prepare(
        `DELETE FROM cached_candles WHERE timestamp > ? OR timestamp < 1262304000`
      ).run(maxTs);
      if (info.changes) console.log(`[mw-reader] purged ${info.changes} corrupt out-of-range candle rows`);
    } catch (e: any) { console.warn("[mw-reader] startup purge failed:", e.message); }

    for (const { symbol, dirPattern, activeDir } of MW_INSTRUMENTS) {
      // Dynamic: follow whichever contract MW is actively writing. activeDir is now only a
      // cold-start fallback for when no contract dir has any files yet.
      const instrDir = pickActiveDir(dirPattern) ?? path.join(MW_DATA_ROOT, activeDir);

      // Discover all contract dirs for historical merge
      const allContractDirs = getContractDirs(dirPattern);
      if (!allContractDirs.length) {
        console.log(`[mw-reader] No contract dirs found for ${symbol} (pattern ${dirPattern})`);
      }

      // Initial load from ALL contract dirs (merges history across expirations).
      // MW-SYNC: DISABLED — this .bar_data1 disk bulk load was the phantom factory. MW's
      // server-driven backfill (gap-audit → bulk_bars) is now the authoritative history source.
      if (DISK_INGEST_ENABLED && allContractDirs.length) {
        try {
          await loadMultiDir(symbol, allContractDirs);
        } catch (err: any) {
          console.error(`[mw-reader] Initial load failed for ${symbol}:`, err.message);
        }
      } else if (allContractDirs.length) {
        console.log(`[mw-reader] disk bulk load SKIPPED for ${symbol} (DISK_INGEST_ENABLED=false; MW backfill is authoritative)`);
      }

      const dirExists = fs.existsSync(instrDir);

      // Seed in-progress bars. Priority: bar files → DB → nothing.
      // This ensures getLatestBar() always returns a value as long as any historical data exists.
      const sym = symbol.toUpperCase();
      let seedBar = latestBar5.get(sym);
      if (!seedBar) {
        try {
          const nowSecGuard = Math.floor(Date.now() / 1000) + 36 * 3600;
          const rowArr = db.$client.prepare(
            `SELECT close FROM cached_candles WHERE symbol = ? AND resolution = '5' AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1`
          ).all(sym, nowSecGuard) as any[];
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
        const bucket1m  = Math.floor(nowSec / 60)   * 60;
        const bucket5m  = Math.floor(nowSec / 300)  * 300;
        const bucket60m = Math.floor(nowSec / 3600) * 3600;
        // CANDLE FIX: only use seed bar close as open when bar is fresh; stale bar → let first tick self-seed
        const seedAgeMs = Date.now() - (seedBar.timeSec + 300) * 1000;
        if (seedAgeMs < 300_000) {
          // CANDLE FIX: bar just completed — safe to chain its close as the next bar's open
          inProgressBar1m.set(sym,  { timeSec: bucket1m,  open: seedBar.close, high: seedBar.close, low: seedBar.close, close: seedBar.close, volume: 0 });
          inProgressBar5m.set(sym,  { timeSec: bucket5m,  open: seedBar.close, high: seedBar.close, low: seedBar.close, close: seedBar.close, volume: 0 });
          inProgressBar60m.set(sym, { timeSec: bucket60m, open: seedBar.close, high: seedBar.close, low: seedBar.close, close: seedBar.close, volume: 0 });
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
          const tickPrice = readLastTickRecord(initialTickFile, latestBar5.get(sym)?.close);
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
              const open       = lastClose ?? tickPrice;
              const bucket60mT = Math.floor(nowSec / 3600) * 3600;
              inProgressBar1m.set(sym,  { timeSec: bucket1m,   open, high: Math.max(open, tickPrice), low: Math.min(open, tickPrice), close: tickPrice, volume: 0 });
              inProgressBar5m.set(sym,  { timeSec: bucket5m,   open, high: Math.max(open, tickPrice), low: Math.min(open, tickPrice), close: tickPrice, volume: 0 });
              inProgressBar60m.set(sym, { timeSec: bucket60mT, open, high: Math.max(open, tickPrice), low: Math.min(open, tickPrice), close: tickPrice, volume: 0 });
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

      // Bar-file polling (1 s) — updates completed 5-min/60-min bars in DB.
      // MW-SYNC: DISABLED — this disk bar-file poll wrote provisional/phantom bars into the DB.
      // MW's authoritative bulk_bars backfill supersedes it.
      if (DISK_INGEST_ENABLED) {
        setInterval(async () => {
          try {
            await pollChanged(symbol, instrDir);
          } catch (err: any) {
            console.error(`[mw-reader] Poll error for ${symbol}:`, err.message);
          }
        }, POLL_INTERVAL_MS);
      }

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

      // 100ms fallback poll — catches ticks fs.watch may have missed.
      // 16ms (60fps) caused 60 fs.statSync/sec saturating the Node event loop.
      // 100ms (10fps) is imperceptible latency for a disk-file fallback while
      // leaving room for TickRelay WS messages to be processed without delay.
      setInterval(() => {
        try { fallbackTickPoll(symbol, instrDir); } catch { /* silent */ }
      }, 100);

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

      // REMOVED: the 16ms heartbeat that re-applied the last known price via _broadcast().
      // It was the primary source of "ghost candles": when the feed went quiet (after hours,
      // ETH, or a frozen Rithmic sim) it kept opening flat O=H=L=C bars every bucket with no
      // real trades. It also set lastTickAt = Date.now() indirectly, so the stale-feed
      // detector below never fired. Real ticks still arrive via fs.watch + the 16ms
      // fallback poll (which only applies a price when the tick FILE actually grows) and via
      // the 1s bar-file poll, so the live price still updates without synthesizing fake candles.

      // 1s bar-state heartbeat — updates in-progress OHLCV bars and broadcasts them.
      // 1s cadence matches notifyExternalTick's forming-bar throttle so disk mode and
      // TickRelay mode behave consistently for the React signal-computation chain.
      // MW-SYNC: DISABLED — applyTick synthesizes bars from the last disk price and writes them
      // via bulkUpsert when the feed goes quiet (a phantom-bar source). Live bars now come from
      // notifyExternalTick (TickRelay WS) and history from MW backfill.
      if (DISK_INGEST_ENABLED) {
        setInterval(() => {
          const sym = symbol.toUpperCase();
          const p   = lastTickPrice.get(sym);
          if (p === undefined) return;
          if (Date.now() - (lastExternalTickMs.get(sym) ?? 0) < 5_000) return;
          try { applyTick(sym, p); } catch { /* silent */ }
        }, 1_000);
      }
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
