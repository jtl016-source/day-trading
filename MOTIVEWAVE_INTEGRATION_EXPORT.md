# MotiveWave Data Integration — Complete Export for Claude Applications

> **PURPOSE**: This document contains every file, pattern, and explanation needed for another
> Claude application to understand and replicate the MotiveWave → Node.js → PostgreSQL → React
> data pipeline used in this project. It also explains exactly how to replace Polygon.io
> with MotiveWave as the primary historical + live data source.

---

## Table of Contents

1. [Architecture Overview](#architecture)
2. [How MotiveWave Stores Data on Disk](#mw-disk-format)
3. [Complete Source: server/mw-reader.ts](#mw-reader)
4. [Complete Source: server/live-bars.ts](#live-bars)
5. [Complete Source: server/db.ts](#db)
6. [Complete Source: shared/schema.ts](#schema)
7. [Relevant Routes from server/routes.ts](#routes)
8. [Client-Side Integration (market.tsx key sections)](#client)
9. [Environment Variables](#env)
10. [How to Replace Polygon.io with MotiveWave](#replace-polygon)
11. [Feed Staleness Detection](#staleness)
12. [Verification Checklist](#verify)

---

<a name="architecture"></a>
## 1. Architecture Overview

```
MotiveWave (Windows desktop app, connected to Rithmic sim feed)
  │
  ├─ Writes .bar_data1 files every completed minute
  │   Binary: 86-byte header + N × 30-byte OHLCV records
  │   Location: %APPDATA%\MotiveWave\historical_data\RITHMIC\MESM6.CME\
  │
  └─ Writes .tick_data files continuously (every trade)
      Binary: 86-byte header + N × 45-byte bid/ask records
      Location: same directory as bar files

Node.js Server (server/mw-reader.ts)
  │
  ├─ STARTUP: loadAll() — parse all .bar_data1 files → DELETE old DB rows → INSERT validated bars
  │
  ├─ CONTINUOUS (fs.watch + 1s poll):
  │   onTickFileChange() → readLastTickRecord() → applyTick(symbol, price)
  │     applyTick() → updates inProgressBar1m + inProgressBar5m maps in memory
  │               → _broadcast({ type:"bar", resolution:"1"|"5", bar:{...complete:false} })
  │
  ├─ CONTINUOUS (1s poll):
  │   pollChanged() → if .bar_data1 file mtime changed → parse → upsert completed bars to DB
  │
  └─ EVERY 15s:
      stale monitor → if no tick in >60s → _broadcast({ type:"feedStatus", status:"stale" })

PostgreSQL (Neon serverless Postgres)
  └─ cached_candles table: (symbol, resolution "1"/"5"/"60", timestamp unix_sec, OHLCV)
      UNIQUE constraint on (symbol, resolution, timestamp)

server/live-bars.ts
  └─ WebSocket server at ws://host/ws/live-bars
      noServer mode — manually handles upgrades to avoid conflict with Vite HMR
      setMWBroadcast(broadcast) — mw-reader calls this to send ticks to all browsers

Browser Client (React, market.tsx)
  ├─ useQuery /api/data/cached-continuous/MES/1m?from=X&to=Y
  │   → baseCandles[] (historical, from DB, validated, sorted)
  │
  ├─ WebSocket /ws/live-bars → onmessage({ type:"bar" }) → setLiveCandles()
  │
  ├─ setInterval 1s → GET /api/live/bar/MES?res=1 → setLiveCandles() (fallback)
  │
  └─ windowedCandles = binary-search merge(baseCandles, liveCandles) → CandlestickChart
```

**Update latency (tick to visible chart pixel): ~5–16ms**
- fs.watch fires within 1ms of MW writing a tick
- WebSocket delivery on localhost: <1ms
- React re-render + lightweight-charts series.update(): one animation frame (~16ms)

---

<a name="mw-disk-format"></a>
## 2. How MotiveWave Stores Data on Disk

### Directory Structure
```
%APPDATA%\MotiveWave\historical_data\
  RITHMIC\               ← broker name (Rithmic for futures)
    MESM6.CME\           ← instrument (MES June 2026 on CME)
      1749600000000.bar_data1   ← filename = epoch_ms of first bar
      1749600000000.tick_data   ← same epoch, tick-level data
      1749686400000.bar_data1   ← next day's file
      ...
```

When you change contracts (e.g. Sep rollover), the `dir` name changes to `MESH6.CME` → `MESU6.CME`.
The `MW_INSTRUMENTS` array in mw-reader.ts must be updated each rollover.

### `.bar_data1` Binary Format
```
Offset  Size  Type       Field
0       86    bytes      Header (skip — contains metadata, not needed)
86      2     uint16BE   seq: bar sequence number (minutes since file epoch)
88      4     float32BE  open
92      4     float32BE  high
96      4     float32BE  low
100     4     float32BE  close
104     4     float32BE  volume
108     8     bytes      unknown (skip)
= 30 bytes per record

bar_time_sec = (filename_epoch_ms + seq * 60_000) / 1000
```

### `.tick_data` Binary Format
```
Offset  Size  Type       Field
0       86    bytes      Header (skip)
86      3     bytes      unknown
89      4     float32BE  ask price   (TICK_ASK_OFF = 3 from record start)
93      3     bytes      unknown
96      4     float32BE  bid price   (TICK_BID_OFF = 12 from record start)
97+     ...   bytes      unknown
= 45 bytes per record

mid_price = (ask + bid) / 2
```

The server reads ONLY the last 45 bytes of the current tick file on each fs.watch event.
This is O(1) regardless of file size.

---

<a name="mw-reader"></a>
## 3. Complete Source: server/mw-reader.ts

```typescript
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
import { sql, eq } from "drizzle-orm";
import { type Express }    from "express";
import { type Server as HttpServer } from "http";

// ── Config ────────────────────────────────────────────────────────────────────

const MW_DATA_ROOT = path.join(
  process.env.USERPROFILE ?? "C:\\Users\\jacks",
  "AppData", "Roaming", "MotiveWave", "historical_data", "RITHMIC",
);

// Map: the "logical" symbol stored in the DB → subdirectory name.
// The logical symbol strips the contract month so queries always work
// regardless of which expiry MW is recording.
// UPDATE THIS ARRAY ON CONTRACT ROLLOVER (e.g. MESM6 → MESU6 in June)
const MW_INSTRUMENTS: { symbol: string; dir: string }[] = [
  { symbol: "MES", dir: "MESM6.CME" },
];

const HEADER_SIZE  = 86;
const RECORD_SIZE  = 30;
const POLL_INTERVAL_MS = 1_000;

// ── Tick-file constants ───────────────────────────────────────────────────────
const TICK_HEADER  = 86;
const TICK_RECORD  = 45;
const TICK_ASK_OFF = 3;   // float32BE: ask price (offset from record start)
const TICK_BID_OFF = 12;  // float32BE: bid price

// ── Live price cache (tick-level, for HTTP poll + WebSocket) ─────────────────

const latestBar5       = new Map<string, MinBar>();
const inProgressBar1m  = new Map<string, MinBar>(); // current forming 1-min bar
const inProgressBar5m  = new Map<string, MinBar>(); // current forming 5-min bar
const lastTickPrice    = new Map<string, number>();  // last seen ask price per symbol
const lastTickAt       = new Map<string, number>();  // symbol → Date.now() of last tick received
const prevFeedStatus   = new Map<string, string>();  // symbol → last broadcast feed status

// Track current active tick file per instrument
const activeTickFile  = new Map<string, string>();   // instrDir → absolute file path
const activeTickSize  = new Map<string, number>();   // instrDir → last known file size

/** Returns the in-progress 5-min bar if available, else the last completed 5-min bar. */
export function getLatestBar(symbol: string): (MinBar & { symbol: string }) | null {
  const sym = symbol.toUpperCase();
  const b = inProgressBar5m.get(sym) ?? latestBar5.get(sym);
  if (!b) return null;
  return { ...b, symbol: sym };
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
 * Returns absolute path, or null if none found.
 */
function findActiveTickFile(instrDir: string): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(instrDir); } catch { return null; }
  const tickFiles = entries.filter(f => f.endsWith(".tick_data")).sort();
  if (!tickFiles.length) return null;
  for (let i = tickFiles.length - 1; i >= 0; i--) {
    const fp = path.join(instrDir, tickFiles[i]);
    try {
      const st = fs.statSync(fp);
      if (st.size > TICK_HEADER + TICK_RECORD) return fp;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Read the ask+bid price from the LAST record of a tick file.
 * Reads only 45 bytes regardless of file size — O(1).
 * Returns mid-price or null if invalid.
 */
function readLastTickRecord(filePath: string): number | null {
  let fileSize: number;
  try { fileSize = fs.statSync(filePath).size; } catch { return null; }
  const nRec = Math.floor((fileSize - TICK_HEADER) / TICK_RECORD);
  if (nRec < 1) return null;
  const seekPos = TICK_HEADER + (nRec - 1) * TICK_RECORD;
  const small = Buffer.allocUnsafe(TICK_RECORD);
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, small, 0, TICK_RECORD, seekPos);
    fs.closeSync(fd);
  } catch { return null; }
  const ask = small.readFloatBE(TICK_ASK_OFF);
  const bid = small.readFloatBE(TICK_BID_OFF);
  if (!isFinite(ask) || ask <= 0 || ask > 1e7) return null;
  if (!isFinite(bid) || bid <= 0 || bid > 1e7) return null;
  return (ask + bid) / 2;
}

/** Update both the in-progress 1-min and 5-min bars with a new tick price and broadcast both. */
function applyTick(symbol: string, price: number) {
  const nowSec    = Math.floor(Date.now() / 1000);
  const bucket1m  = Math.floor(nowSec / 60)  * 60;
  const bucket5m  = Math.floor(nowSec / 300) * 300;
  const sym = symbol.toUpperCase();
  const ts = new Date(nowSec * 1000).toISOString().replace("T", " ").replace("Z", " UTC");
  console.log(`[mw-tick] ${ts} ${sym} price=${price.toFixed(2)}`);
  lastTickAt.set(sym, Date.now());

  // ── 1-min in-progress bar ────────────────────────────────────────────────
  const prev1m = inProgressBar1m.get(sym);
  if (prev1m && prev1m.timeSec === bucket1m) {
    prev1m.close = price;
    if (price > prev1m.high) prev1m.high = price;
    if (price < prev1m.low)  prev1m.low  = price;
  } else {
    inProgressBar1m.set(sym, {
      timeSec: bucket1m,
      open:   prev1m?.close ?? price,
      high:   price,
      low:    price,
      close:  price,
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
    inProgressBar5m.set(sym, {
      timeSec: bucket5m,
      open:   prev5m?.close ?? latestBar5.get(sym)?.close ?? price,
      high:   price,
      low:    price,
      close:  price,
      volume: 0,
    });
  }

  if (!_broadcast) return;
  const bar1m = inProgressBar1m.get(sym)!;
  const bar5m = inProgressBar5m.get(sym)!;
  _broadcast({ type: "bar", resolution: "1",  bar: { symbol: sym, time: bar1m.timeSec, open: bar1m.open, high: bar1m.high, low: bar1m.low, close: bar1m.close, volume: bar1m.volume, complete: false } });
  _broadcast({ type: "bar", resolution: "5",  bar: { symbol: sym, time: bar5m.timeSec, open: bar5m.open, high: bar5m.high, low: bar5m.low, close: bar5m.close, volume: bar5m.volume, complete: false } });
}

/**
 * Called on every fs.watch event for the instrument directory.
 */
function onTickFileChange(symbol: string, instrDir: string, changedFilename: string | null) {
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

  let newSize: number;
  try { newSize = fs.statSync(fp).size; } catch { return; }
  const prevSize = activeTickSize.get(instrDir) ?? 0;
  if (newSize <= prevSize) return; // no new data
  activeTickSize.set(instrDir, newSize);

  const price = readLastTickRecord(fp);
  if (price === null) return;
  const sym = symbol.toUpperCase();
  if (price === lastTickPrice.get(sym)) return; // price unchanged
  lastTickPrice.set(sym, price);
  applyTick(sym, price);
}

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

    // Reject NaN/Infinity, zero/negative prices, corrupt records.
    // Upper bound: no futures contract should ever exceed $1,000,000.
    // Ratio guard: high > low*2 means 100%+ intrabar move — impossible.
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

  // Deduplicate by timeSec — later files take precedence
  const minMap = new Map<number, MinBar>();
  for (const b of allMin) minMap.set(b.timeSec, b);
  const bars1 = Array.from(minMap.values()).sort((a, b) => a.timeSec - b.timeSec);
  const bars5  = aggregate(bars1, 5);
  const bars60 = aggregate(bars1, 60);

  if (!bars1.length) {
    console.log(`[mw-reader] No valid bars parsed for ${symbol} — skipping DB write`);
    return;
  }

  // Parse succeeded: wipe stale/corrupt rows, then insert clean validated data
  await db.delete(cachedCandles).where(eq(cachedCandles.symbol, symbol));
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

    const latest = bars5[bars5.length - 1];
    if (latest) latestBar5.set(symbol, latest);

    if (_broadcast) {
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

/** Reload all instruments from disk into the DB — triggered via HTTP endpoint. */
export async function reloadAll() {
  for (const { symbol, dir } of MW_INSTRUMENTS) {
    const instrDir = path.join(MW_DATA_ROOT, dir);
    if (!fs.existsSync(instrDir)) {
      console.log(`[mw-reader] reloadAll: directory not found: ${instrDir}`);
      continue;
    }
    console.log(`[mw-reader] reloadAll: loading ${symbol}…`);
    await loadAll(symbol, instrDir);
  }
}

// ── Public setup function ─────────────────────────────────────────────────────

export function setupMWReader(_httpServer: HttpServer, _app: Express) {
  console.log("[mw-reader] Starting — data root:", MW_DATA_ROOT);

  (async () => {
    for (const { symbol, dir } of MW_INSTRUMENTS) {
      const instrDir = path.join(MW_DATA_ROOT, dir);

      if (!fs.existsSync(instrDir)) {
        console.log(`[mw-reader] Directory not found: ${instrDir}`);
        continue;
      }

      try {
        await loadAll(symbol, instrDir);
      } catch (err: any) {
        console.error(`[mw-reader] Initial load failed for ${symbol}:`, err.message);
      }

      const initialTickFile = findActiveTickFile(instrDir);
      if (initialTickFile) {
        activeTickFile.set(instrDir, initialTickFile);
        try { activeTickSize.set(instrDir, fs.statSync(initialTickFile).size); } catch {}
        console.log(`[mw-reader] Active tick file: ${path.basename(initialTickFile)}`);
      }

      setInterval(async () => {
        try {
          await pollChanged(symbol, instrDir);
        } catch (err: any) {
          console.error(`[mw-reader] Poll error for ${symbol}:`, err.message);
        }
      }, POLL_INTERVAL_MS);

      try {
        const watcher = fs.watch(instrDir, { persistent: true }, (_event, filename) => {
          try { onTickFileChange(symbol, instrDir, filename); } catch { /* silent */ }
        });
        watcher.on("error", () => {
          console.warn(`[mw-reader] fs.watch error for ${instrDir} — falling back to 1s poll`);
        });
        console.log(`[mw-reader] fs.watch active on ${instrDir}`);
      } catch {
        console.warn(`[mw-reader] fs.watch unavailable — using 1s poll fallback only`);
      }

      setInterval(() => {
        try { fallbackTickPoll(symbol, instrDir); } catch { /* silent */ }
      }, 1_000);
    }

    // Feed staleness monitor — broadcasts status changes to connected clients.
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
```

---

<a name="live-bars"></a>
## 4. Complete Source: server/live-bars.ts

```typescript
/**
 * Live bar relay — receives OHLCV pushes from the MotiveWave Java study
 * and broadcasts them to all connected browser clients via WebSocket.
 *
 * WebSocket path: /ws/live-bars  (shares the main HTTP server, no extra port)
 */

import { type Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { type Express } from "express";
import { db } from "./db";
import { cachedCandles } from "@shared/schema";
import { sql } from "drizzle-orm";
import { setMWBroadcast } from "./mw-reader";

interface LiveBar {
  symbol:   string;
  time:     number;   // unix seconds
  open:     number;
  high:     number;
  low:      number;
  close:    number;
  volume:   number;
  complete: boolean;  // true = bar is closed, false = still forming
}

let wss: WebSocketServer | null = null;
const WS_PATH = "/ws/live-bars";

export function setupLiveBars(httpServer: HttpServer, app: Express) {
  // noServer mode — manually handle upgrades only for our path.
  // Prevents conflicts with Vite's HMR WebSocket which shares the same httpServer.
  wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = request.url?.split("?")[0];
    if (pathname !== WS_PATH) return; // leave other paths (Vite HMR) alone
    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit("connection", ws, request);
    });
  });

  // Give the mw-reader access to the broadcast function
  setMWBroadcast(broadcast);

  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.send(JSON.stringify({ type: "connected" }));
    console.log(`[live-bars] client connected (total: ${wss!.clients.size})`);
  });

  wss.on("error", (err) => {
    console.error("[live-bars] WebSocket server error:", err.message);
  });

  // REST endpoint — called by MotiveWave Java study on every bar update
  // (alternative to file-based approach; not primary in this app)
  app.post("/api/live-bars", async (req, res) => {
    const bar = req.body as LiveBar;
    if (!bar || !bar.symbol || !bar.time) {
      res.status(400).json({ error: "invalid bar" });
      return;
    }

    broadcast({ type: "bar", bar });

    if (bar.complete) {
      try {
        const resolution = "5";
        await db.execute(sql`
          INSERT INTO cached_candles (symbol, resolution, timestamp, open, high, low, close, volume)
          VALUES (
            ${bar.symbol.toUpperCase()},
            ${resolution},
            ${bar.time},
            ${bar.open},
            ${bar.high},
            ${bar.low},
            ${bar.close},
            ${bar.volume}
          )
          ON CONFLICT (symbol, resolution, timestamp) DO UPDATE SET
            open   = EXCLUDED.open,
            high   = EXCLUDED.high,
            low    = EXCLUDED.low,
            close  = EXCLUDED.close,
            volume = EXCLUDED.volume
        `);
      } catch (_) {
        // Non-fatal
      }
    }

    res.json({ ok: true });
  });

  app.get("/api/live-bars/status", (_req, res) => {
    res.json({
      connected: wss ? wss.clients.size : 0,
      wsPath: WS_PATH,
      status: "ok",
    });
  });
}

export function broadcast(msg: object) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}
```

---

<a name="db"></a>
## 5. Complete Source: server/db.ts

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
```

---

<a name="schema"></a>
## 6. Complete Source: shared/schema.ts (cachedCandles table)

```typescript
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, bigint, doublePrecision, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

// THE KEY TABLE — all candle data stored here
export const cachedCandles = pgTable("cached_candles", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  resolution: varchar("resolution", { length: 10 }).notNull(), // "1", "5", "60"
  timestamp: bigint("timestamp", { mode: "number" }).notNull(), // Unix seconds
  open: doublePrecision("open").notNull(),
  high: doublePrecision("high").notNull(),
  low: doublePrecision("low").notNull(),
  close: doublePrecision("close").notNull(),
  volume: bigint("volume", { mode: "number" }).notNull().default(0),
}, (t) => [
  unique().on(t.symbol, t.resolution, t.timestamp), // prevents duplicates
]);

export const downloadStatus = pgTable("download_status", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("none"),
  barCount: integer("bar_count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  unique().on(t.symbol, t.year, t.month),
]);

export type CachedCandle = typeof cachedCandles.$inferSelect;
export type DownloadStatus = typeof downloadStatus.$inferSelect;
```

---

<a name="routes"></a>
## 7. Relevant Routes from server/routes.ts

These are the routes that serve MW data to the client. Include these in your `registerRoutes` function:

```typescript
import { getLatestBar, getLatestBar1m, reloadAll } from "./mw-reader";

// ── MW Admin ──────────────────────────────────────────────────────────────────

// Force-reload all MW bar files from disk (call after restart or MW data update)
app.post("/api/admin/reload-mw", async (_req, res) => {
  try {
    await reloadAll();
    res.json({ ok: true, message: "MW data reloaded" });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Live Data ─────────────────────────────────────────────────────────────────

// Latest live bar for futures — ?res=1 for 1-min, default 5-min
// Called every 1s by client as fallback to WebSocket
app.get("/api/live/bar/:symbol", (req, res) => {
  const sym = req.params.symbol.toUpperCase().replace(/[A-Z]\d+$/, "").replace("=F", "");
  const resolution = req.query.res === "1" ? "1" : "5";
  const bar = resolution === "1" ? getLatestBar1m(sym) : getLatestBar(sym);
  res.json({ bar }); // bar is null if MW not running
});

// ── Historical Candles from DB ────────────────────────────────────────────────

// Main historical data endpoint — serves from cachedCandles table
// interval: "1m", "5m", "15m", "60m"
app.get("/api/data/cached-continuous/:symbol/:interval", async (req, res) => {
  const { symbol, interval } = req.params;
  const sym = symbol.toUpperCase();
  const resolution = interval === "60m" ? "60" : interval === "1m" ? "1" : "5";
  const { from, to } = req.query;
  try {
    const conditions = [
      eq(cachedCandles.symbol, sym),
      eq(cachedCandles.resolution, resolution),
    ];
    if (from) conditions.push(gte(cachedCandles.timestamp, Number(from)));
    if (to) conditions.push(lte(cachedCandles.timestamp, Number(to)));

    const rows = await db.select().from(cachedCandles)
      .where(and(...conditions))
      .orderBy(asc(cachedCandles.timestamp));

    if (rows.length === 0) {
      res.json({ symbol: sym, interval, candles: [], source: "none" });
      return;
    }

    const candles = rows.map(r => ({
      time: r.timestamp,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      rth: isRTH(r.timestamp), // see isRTH() function below
    }));

    res.json({ symbol: sym, interval, candles, source: "cached" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// RTH helper — determines if a timestamp is within Regular Trading Hours
function isRTH(timestampSec: number): boolean {
  const d = new Date(timestampSec * 1000);
  const dayOfWeek = d.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const utcMins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMins >= 13 * 60 + 30 && utcMins < 21 * 60; // 9:30 AM–4:00 PM ET approx
}
```

---

<a name="client"></a>
## 8. Client-Side Integration (market.tsx key sections)

### Types
```typescript
interface CandleBar {
  time: number; open: number; high: number; low: number; close: number;
  volume?: number; rth?: boolean;
}
```

### State
```typescript
const [liveCandles, setLiveCandles] = useState<CandleBar[]>([]);
const [liveStatus, setLiveStatus]   = useState<"disconnected"|"connecting"|"live">("disconnected");
const [mwFeedStale, setMwFeedStale] = useState<"live"|"stale"|"unknown">("unknown");
```

### Detect Futures (use MW) vs Stocks (use MarketData.app)
```typescript
const isFutures = useMemo(() => {
  const sel = selectedSymbol.toUpperCase();
  return symbolsData?.futures?.some(f => sel === f.symbol || sel.startsWith(f.symbol)) ?? false;
}, [symbolsData, selectedSymbol]);
```

### WebSocket — receives live bar ticks from server
```typescript
useEffect(() => {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    setLiveStatus("connecting");
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/live-bars`);
    ws.onopen = () => setLiveStatus("live");

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        // MW feed health status
        if (msg.type === "feedStatus") {
          const sym = msg.symbol?.toUpperCase().replace(/[A-Z]\d+$/, "").replace("=F","");
          const sel = selectedSymbol.toUpperCase().replace(/[A-Z]\d+$/, "").replace("=F","");
          if (sym && sel && sym.startsWith(sel.substring(0, 2))) {
            setMwFeedStale(msg.status); // "live" | "stale" | "unknown"
          }
          return;
        }

        if (msg.type !== "bar") return;
        const raw = msg.bar;

        // Only process bars for the currently selected symbol
        const sym = raw.symbol?.toUpperCase().replace(/[A-Z]\d+$/, "").replace("=F","");
        const sel = selectedSymbol.toUpperCase().replace(/[A-Z]\d+$/, "").replace("=F","");
        if (!sym || !sel || !sym.startsWith(sel.substring(0, 2))) return;

        // Filter by resolution matching the current chart interval
        const wantRes = interval === "1m" ? "1" : interval === "60m" ? "60" : "5";
        if (msg.resolution && msg.resolution !== wantRes) return;

        // For 15m: server sends 5m bars, client buckets them to 15m
        const bucketSec = interval === "15m" ? Math.floor(raw.time / 900) * 900 : raw.time;
        const bar: CandleBar = {
          time: bucketSec, open: raw.open, high: raw.high,
          low: raw.low, close: raw.close, volume: raw.volume, rth: isRTH(bucketSec)
        };

        setLiveCandles(prev => {
          const idx = prev.findIndex(c => c.time === bar.time);
          if (idx >= 0) {
            // Merge: keep original open, track high/low, update close
            const merged = {
              ...bar,
              open: prev[idx].open,
              high: Math.max(prev[idx].high, bar.high),
              low:  Math.min(prev[idx].low,  bar.low),
            };
            const next = [...prev]; next[idx] = merged; return next;
          }
          return [...prev, bar];
        });
      } catch {}
    };

    ws.onclose = () => { setLiveStatus("disconnected"); reconnectTimer = setTimeout(connect, 2000); };
    ws.onerror = () => ws?.close();

    // Keepalive ping every 10s
    const pingId = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 10_000);
    ws.addEventListener("close", () => clearInterval(pingId));
  }

  connect();
  return () => { if (reconnectTimer) clearTimeout(reconnectTimer); ws?.close(); };
}, [selectedSymbol]); // re-connect when symbol changes
```

### HTTP Poll — 1s fallback for futures live bar
```typescript
useEffect(() => {
  if (!isFutures) return;
  const sym = selectedSymbol.toUpperCase().replace(/[A-Z]\d+$/, "").replace("=F", "");

  const poll = async () => {
    const resParam = interval === "1m" ? "?res=1" : "";
    try {
      const r = await fetch(`/api/live/bar/${sym}${resParam}`);
      if (!r.ok) return;
      const { bar } = await r.json();
      if (!bar) return;
      const liveBar: CandleBar = {
        time: bar.timeSec, open: bar.open, high: bar.high,
        low: bar.low, close: bar.close, volume: bar.volume
      };
      setLiveCandles(prev => {
        const idx = prev.findIndex(c => c.time === liveBar.time);
        if (idx >= 0) {
          if (prev[idx].close === liveBar.close) return prev; // no change
          const next = [...prev]; next[idx] = liveBar; return next;
        }
        return [...prev, liveBar];
      });
    } catch {}
  };

  poll();
  const id = setInterval(poll, 1_000);
  return () => clearInterval(id);
}, [selectedSymbol, isFutures, interval]);
```

### Load Historical Data from DB
```typescript
const { data: rawCandleData } = useQuery({
  queryKey: ["/api/data/cached-continuous", selectedSymbol, fetchInterval, fromTs, toTs],
  queryFn: async () => {
    const r = await fetch(`/api/data/cached-continuous/${selectedSymbol}/${fetchInterval}?from=${fromTs}&to=${toTs}`);
    if (!r.ok) throw new Error("Failed");
    return r.json();
  },
  staleTime: 60_000,
});
// fetchInterval: "1m" | "5m" | "60m"  (15m uses 5m data, bucketed client-side)
```

### Merge Historical + Live (key pattern)
```typescript
const baseCandles = useMemo(() => {
  const MIN_PRICE = 1;    // rejects corrupt near-zero values
  const MAX_PRICE = 9e13;
  return (rawCandleData?.candles ?? [])
    .filter(c =>
      isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close) &&
      c.open >= MIN_PRICE && c.high >= MIN_PRICE && c.low >= MIN_PRICE && c.close >= MIN_PRICE &&
      c.open < MAX_PRICE && c.high < MAX_PRICE && c.low < MAX_PRICE && c.close < MAX_PRICE &&
      c.high >= c.low)
    .sort((a, b) => a.time - b.time);
}, [rawCandleData]);

// Merge live bars into historical using binary search — O(log n) per live bar
const windowedCandles = useMemo(() => {
  if (!liveCandles.length) return baseCandles;
  const result = [...baseCandles];
  for (const live of liveCandles) {
    let lo = 0, hi = result.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (result[mid].time < live.time) lo = mid + 1; else hi = mid; }
    if (lo < result.length && result[lo].time === live.time) result[lo] = live; // update
    else result.splice(lo, 0, live); // insert
  }
  return result;
}, [baseCandles, liveCandles]);

// windowedCandles → pass to <CandlestickChart candles={windowedCandles} />
```

---

<a name="env"></a>
## 9. Environment Variables

```bash
# Required
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Optional — MW data needs NONE of these
PORT=5000                     # default 5000
SESSION_SECRET=...            # Express session (any random string)
MASSIVE_API_CODE=...          # Polygon.io — only used for historical stock downloads
LIVE_DATA=...                 # MarketData.app Bearer token — only for SPY/ETF live candles
LIVE_NEWS=...                 # GNews.io — only for news articles
```

**MotiveWave requires zero API keys.** It reads files directly from the local filesystem.

---

<a name="replace-polygon"></a>
## 10. How to Replace Polygon.io with MotiveWave

### What Polygon.io Does in This App
- **Only one thing**: `POST /api/data/download` — fetches historical 5m/60m bars for a symbol/month, stores in `cachedCandles`
- MES futures **already bypass Polygon** entirely and use MotiveWave

### Step-by-Step Replacement

**Step 1 — Add instruments to MW_INSTRUMENTS in mw-reader.ts**

Open a chart for each symbol in MotiveWave first — MW must be recording the instrument.
Then add it to the array:

```typescript
const MW_INSTRUMENTS = [
  { symbol: "MES",  dir: "MESM6.CME"  },  // Micro E-mini S&P, Rithmic feed
  { symbol: "ES",   dir: "ESM6.CME"   },  // E-mini S&P
  { symbol: "NQ",   dir: "NQM6.CME"   },  // Nasdaq futures
  // For stocks/ETFs the path is NOT under RITHMIC — check Step 3
];
```

**Step 2 — Verify the actual directory name**

Open Windows Explorer: `%APPDATA%\MotiveWave\historical_data\`
You'll see subdirectories named by broker: `RITHMIC\`, `TD_AMERITRADE\`, `IBKR\`, etc.
Inside each broker folder are instrument folders like `MESM6.CME`, `SPY.NASDAQ`, `AAPL.NASDAQ`.

**Step 3 — For stocks/ETFs, use a separate data root**

Stocks are stored under a different broker path. Add a second reader instance:

```typescript
const MW_STOCK_ROOT = path.join(
  process.env.USERPROFILE ?? "C:\\Users\\jacks",
  "AppData", "Roaming", "MotiveWave", "historical_data", "TD_AMERITRADE", // or IBKR
);

const MW_STOCK_INSTRUMENTS = [
  { symbol: "SPY", dir: "SPY.ARCA" },
  { symbol: "QQQ", dir: "QQQ.NASDAQ" },
];
```

Or: make `MW_DATA_ROOT` configurable per instrument.

**Step 4 — Register the symbol as "futures" in the client**

The client uses the `futures` list from `/api/market/symbols` to decide whether to use
the MW live relay or MarketData.app. Add your MW-sourced symbols to that list:

```typescript
// In routes.ts POPULAR_SYMBOLS:
futures: [
  { symbol: "MES",  name: "Micro E-mini S&P 500 (Live)" },
  { symbol: "SPY",  name: "SPDR S&P 500 ETF (MW Live)" }, // add if pulling from MW
],
```

**Step 5 — Remove Polygon.io** (optional)

Delete or comment out `POST /api/data/download` in routes.ts and remove `MASSIVE_API_CODE` from .env.

### History Depth Comparison

| Source | 1m Depth | 5m/60m Depth | Live |
|---|---|---|---|
| **Polygon.io** | Not available | Years | No |
| **MotiveWave** | 30–90 days (what's on disk) | Same | Yes (sub-second) |
| **MarketData.app** | Limited | ~2 years | Yes (~200ms) |

**Recommended hybrid**: Use Polygon.io for one-time bulk historical downloads (years of 5m data).
Then use MotiveWave for all live data and recent 1m history.
The `cachedCandles` table stores everything together — the chart doesn't care which source wrote it.

---

<a name="staleness"></a>
## 11. Feed Staleness Detection

Rithmic's sim feed sometimes silently stops sending heartbeats. MW's UI stays green but ticks stop.
The server detects this and warns the user:

```
Server side (mw-reader.ts):
  lastTickAt.set(sym, Date.now())  ← on every applyTick()
  Every 15s: if Date.now() - lastTickAt > 60_000:
    broadcast({ type: "feedStatus", symbol: "MES", status: "stale", secondsSinceTick: 75 })
  When ticks resume:
    broadcast({ type: "feedStatus", symbol: "MES", status: "live", secondsSinceTick: 1 })

Client side (market.tsx):
  ws.onmessage → if msg.type === "feedStatus" → setMwFeedStale(msg.status)
  UI badge: green "LIVE" → orange "MW STALE"

Fix: In MotiveWave → File → Disconnect → File → Connect
```

---

<a name="verify"></a>
## 12. Verification Checklist

After setting up in a new project:

```bash
# 1. Check MW files are readable
ls "%APPDATA%\MotiveWave\historical_data\RITHMIC\MESM6.CME\"
# Should see: *.bar_data1, *.tick_data files

# 2. Start server, watch for successful load
npm run dev
# Expect: "[mw-reader] Loaded N files → X 1-min, Y 5-min, Z 60-min bars for MES"
# Expect: "[mw-reader] Active tick file: 1775073600000.tick_data"
# Expect: "[mw-reader] fs.watch active on ..."

# 3. Verify live bar endpoint
curl http://localhost:5000/api/live/bar/MES
# Expect: {"bar":{"timeSec":...,"open":...,"high":...,"low":...,"close":...,"symbol":"MES"}}

# 4. Verify historical data
curl "http://localhost:5000/api/data/cached-continuous/MES/1m?from=1774900000&to=1775073600"
# Expect: {"candles":[{time:...,open:...,high:...,low:...,close:...},...],"source":"cached"}

# 5. Verify WebSocket
# Browser devtools → Network → WS → /ws/live-bars
# Expect: {"type":"bar","resolution":"1","bar":{"symbol":"MES","close":6618,...}} every ~1s

# 6. Verify stale detection
# Disconnect MW from Rithmic → wait 75 seconds
# Expect: {"type":"feedStatus","symbol":"MES","status":"stale","secondsSinceTick":75}
# UI badge should turn orange

# 7. Verify chart shows live price
# Open localhost:5000 → select MES → 1m interval
# Chart should auto-scroll to right edge showing recent 1m candles
# Rightmost candle close price should match curl output from step 3
```

---

## Dependencies Required (package.json)

```json
{
  "dependencies": {
    "drizzle-orm": "^0.39.3",
    "pg": "^8.16.3",
    "ws": "^8.18.0",
    "express": "^5.0.1"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.8",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3"
  }
}
```

No external API keys or subscriptions needed for MotiveWave data.
MotiveWave itself requires a license + a broker connection (Rithmic, IBKR, TD Ameritrade, etc.).
