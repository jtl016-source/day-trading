/**
 * Live bar relay — receives OHLCV pushes from the MotiveWave Java study
 * and broadcasts them to all connected browser clients via WebSocket.
 *
 * WebSocket paths:
 *   /ws/live-bars  — server → browser (chart updates)
 *   /ws/mw-feed    — MotiveWave study → server (tick/bar ingest)
 */

import { type Server as HttpServer, createServer as createHttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { type Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { cachedCandles } from "@shared/schema";
import { normalizeSymbol } from "@shared/symbol";
import { isSaneBarTime, validateBar } from "@shared/bar-time";
import { setMWBroadcast, notifyExternalTick, setTickRelayConnected } from "./mw-reader";
import { cacheInvalidate } from "./cache";
// MW-SYNC (v2): server-driven getBars backfill. gap-audit drives per-(SYM:RES) backfill
// requests on study `hello`; roll-heal reconciles continuous-contract roll re-adjustments
// against the overlap before v2 backfill bars overwrite existing rows.
import { onStudyConnected, onStudyDisconnected, onBackfillDone, recordBackfillBars } from "./gap-audit";
import { detectAndHeal } from "./roll-heal";
import { deriveRange } from "./derive-bars"; // 1M-DERIVE: re-derive 5m/15m/60m from freshly-backfilled 1m

// Pre-load the footprint engine once at startup so footprint_bar messages
// don't trigger module resolution on every received bar.
let _fpAddBar: ((sym: string, interval: string, time: number, levels: Array<{ price: number; b: number; a: number }>) => void) | null = null;
import("./footprint-engine").then(m => { _fpAddBar = m.addBar; }).catch(() => {});

interface LiveBar {
  symbol:   string;
  time:     number;   // unix seconds
  open:     number;
  high:     number;
  low:      number;
  close:    number;
  volume:   number;
  complete: boolean;
}

// Strip futures contract month codes (MESM6→MES, ESH6→ES, MESZ25→MES) so all
// data lands under the continuous-contract key regardless of MW chart's active contract.
function normalizeSym(s: string): string {
  return s.toUpperCase().replace(/[HMUZ]\d{1,2}$/, "").replace("=F", "");
}

// ── Browser WebSocket (server → browsers) ────────────────────────────────────
let wss: WebSocketServer | null = null;
let mwWss: WebSocketServer | null = null;

/** Terminate all connected MW study WebSocket connections.
 *  Studies reconnect automatically — on reconnect they send a fresh bulk_bars dump
 *  which the server persists and broadcasts as data_updated to browser clients. */
export function reconnectMWStudies() {
  if (!mwWss) return;
  for (const ws of mwWss.clients) {
    try { ws.terminate(); } catch { /* ignore */ }
  }
}
const WS_PATH       = "/ws/live-bars";
const MW_WS_PATH    = "/ws/mw-feed";
const ORDER_WS_PATH = "/ws/order-commands";

// Track ALL AutoTrader Java study connections (MW loads one instance per chart)
const orderCommandSockets = new Set<WebSocket>();
// Keep a single reference for backward compat (points to most-recently connected socket)
let orderCommandSocket: WebSocket | null = null;
// Per-socket liveness tracking — set to true on pong, false before each ping, terminate if still false next ping
const socketAlive = new Map<WebSocket, boolean>();

// Sync status — resets to "pending" on every server start, set to "done" after first bulk_bars completes
let mwSyncStatus: "pending" | "syncing" | "done" = "pending";
let mwSyncSymbol = "";
let mwSyncBarsReceived = 0;
let mwSyncStartedAt: number | null = null;

// Highest bar timestamp already persisted per `${symbol}:${resolution}`. The MW study
// re-dumps its ENTIRE history on every (re)connect, and it reconnects constantly — without
// this guard the server re-writes 80k+ bars per dump in a tight loop, blocking the
// synchronous SQLite event loop and making every HTTP request crawl (the root cause of the
// chart never loading). We only persist bars NEWER than the highest already seen, so the
// first dump writes everything and subsequent re-dumps of old bars become cheap no-ops.
const lastDumpMaxTs = new Map<string, number>();

// Throttle "bar without resolution" warnings — the study emits a forming bar every tick.
const noResWarnAt = new Map<string, number>();

// MW-SYNC (v2): upgraded LiveBarRelay studies that completed the `hello` handshake.
// Keyed by "SYM:RES" — one study instance per MW chart (1m/5m/15m/60m). The gap-audit
// dispatcher sends backfill requests through each study's socket; cleaned up on close.
const studySockets = new Map<string, WebSocket>();

export function getMWSyncStatus() {
  return { status: mwSyncStatus, symbol: mwSyncSymbol, barsReceived: mwSyncBarsReceived, startedAt: mwSyncStartedAt };
}

export function broadcastOrderCommand(cmd: object) {
  // Send to ONE open socket only — broadcasting to all would cause duplicate orders
  // since each AutoTrader instance processes commands independently.
  // Try orderCommandSocket first; if stale, find the next open one from the pool.
  const data = JSON.stringify(cmd);
  const candidates = orderCommandSocket?.readyState === WebSocket.OPEN
    ? [orderCommandSocket]
    : [...orderCommandSockets].filter(ws => ws.readyState === WebSocket.OPEN);
  for (const ws of candidates) {
    try { ws.send(data); return true; } catch { orderCommandSockets.delete(ws); }
  }
  return false;
}

export function isOrderCommandSocketOpen(): boolean {
  return [...orderCommandSockets].some(ws => ws.readyState === WebSocket.OPEN);
}

export function setupLiveBars(httpServer: HttpServer, app: Express) {
  // Browser clients — server pushes updates to these
  wss = new WebSocketServer({ noServer: true });

  // MotiveWave study — sends tick/bar messages to this
  mwWss = new WebSocketServer({ noServer: true });

  // AutoTrader Java study — receives order commands from server
  const orderWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = request.url?.split("?")[0];

    if (pathname === WS_PATH) {
      wss!.handleUpgrade(request, socket, head, (ws) => {
        wss!.emit("connection", ws, request);
      });
    } else if (pathname === MW_WS_PATH) {
      mwWss!.handleUpgrade(request, socket, head, (ws) => {
        mwWss!.emit("connection", ws, request);
      });
    } else if (pathname === ORDER_WS_PATH) {
      orderWss.handleUpgrade(request, socket, head, (ws) => {
        orderWss.emit("connection", ws, request);
      });
    }
    // Leave all other paths (Vite HMR, etc.) alone
  });

  // ── AutoTrader study connection ────────────────────────────────────────────
  // MW loads one AutoTrader instance per chart — track ALL of them so closing
  // one chart doesn't kill signal delivery to the remaining instances.
  orderWss.on("connection", (ws) => {
    orderCommandSockets.add(ws);
    socketAlive.set(ws, true);
    orderCommandSocket = ws; // most-recently connected
    console.log(`[order-commands] AutoTrader study connected (total: ${orderCommandSockets.size})`);
    try { ws.send(JSON.stringify({ type: "connected" })); } catch {}
    ws.on("error", () => { orderCommandSockets.delete(ws); socketAlive.delete(ws); });
    ws.on("pong", () => { socketAlive.set(ws, true); });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log("[order-commands] from AutoTrader:", msg);
        if (["order_ack","order_error","order_queued","order_status","order_filled","position_closed","flag_reset"].includes(msg.type)) {
          broadcast(msg);
        }
      } catch {}
    });
    ws.on("close", () => {
      orderCommandSockets.delete(ws);
      socketAlive.delete(ws);
      if (orderCommandSocket === ws) {
        orderCommandSocket = [...orderCommandSockets].find(s => s.readyState === WebSocket.OPEN) ?? null;
      }
      console.log(`[order-commands] AutoTrader study disconnected (remaining: ${orderCommandSockets.size})`);
    });
  });

  // Ping all AutoTrader connections every 10s; terminate any that miss a pong
  setInterval(() => {
    orderCommandSockets.forEach(ws => {
      if (ws.readyState !== WebSocket.OPEN) {
        orderCommandSockets.delete(ws);
        socketAlive.delete(ws);
        return;
      }
      if (!socketAlive.get(ws)) {
        console.log("[order-commands] ping timeout — terminating dead AutoTrader socket");
        ws.terminate();
        orderCommandSockets.delete(ws);
        socketAlive.delete(ws);
        return;
      }
      socketAlive.set(ws, false);
      try { ws.ping(); } catch { orderCommandSockets.delete(ws); socketAlive.delete(ws); }
    });
    if (!orderCommandSocket || orderCommandSocket.readyState !== WebSocket.OPEN) {
      orderCommandSocket = [...orderCommandSockets].find(s => s.readyState === WebSocket.OPEN) ?? null;
    }
  }, 10_000);

  orderWss.on("error", (err) => {
    console.error("[order-commands] WebSocket server error:", err.message);
  });

  // Give mw-reader access to the broadcast function (disk-file fallback path)
  setMWBroadcast(broadcast);

  // ── Browser client connections ─────────────────────────────────────────────
  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.send(JSON.stringify({ type: "connected" }));
    console.log(`[live-bars] browser connected (total: ${wss!.clients.size})`);
  });

  wss.on("error", (err) => {
    console.error("[live-bars] WebSocket server error:", err.message);
  });

  // ── MotiveWave study connection ────────────────────────────────────────────
  mwWss!.on("connection", (ws) => {
    console.log("[mw-feed] MotiveWave study connected");
    setTickRelayConnected(true);

    // MW-SYNC (v2): per-connection handshake state. `registeredKeys` tracks the SYM:RES
    // entries this socket owns so they can be unregistered on close. (The current `bar`
    // handler already requires an explicit resolution from both relays, so no separate
    // helloSeen gate is needed here — untagged bars are handled by that path.)
    const registeredKeys = new Set<string>();

    let mwIsAlive = true;
    ws.on("pong", () => { mwIsAlive = true; });
    const mwPingInterval = setInterval(() => {
      if (!mwIsAlive) {
        console.log("[mw-feed] ping timeout — terminating dead MW study connection");
        ws.terminate();
        return;
      }
      mwIsAlive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }, 15_000);

    ws.on("error", () => {});

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string; symbol?: string; price?: number; time?: number;
          open?: number; high?: number; low?: number; close?: number;
          volume?: number; complete?: boolean;
        };

        if (msg.type === "tick") {
          const { price, time } = msg;
          const symbol = normalizeSymbol(msg.symbol);
          if (!symbol || typeof price !== "number" || !isFinite(price) || price <= 0) return;
          broadcast({ type: "tick", symbol, price, time: time ?? Date.now() });
          // Keep mw-reader's internal bar state in sync and suppress its disk heartbeat
          notifyExternalTick(symbol, price);

        } else if (msg.type === "hello") {
          // MW-SYNC (v2): handshake — register the study socket for this (SYM:RES) and
          // kick a gap audit that drives server → study `backfill` requests.
          const hm = msg as any;
          const sym = normalizeSymbol(hm.symbol ?? "");
          const res = String(hm.resolution ?? "").replace("m", "");
          if (!sym || !res) return;
          const k = `${sym}:${res}`;
          registeredKeys.add(k);
          studySockets.set(k, ws);
          console.log(`[mw-feed] hello ${k} ver=${hm.ver ?? "?"} series=[${hm.seriesStartMs ?? "?"}..${hm.seriesEndMs ?? "?"}]`);
          onStudyConnected(sym, res, ws);

        } else if (msg.type === "backfill_done") {
          // MW-SYNC (v2): study finished servicing a backfill request. Advances the
          // gap-audit dispatcher (records provider cap / no-data, dispatches next range).
          const bd = msg as any;
          const id = bd.id as string | undefined;
          if (!id) return;
          const count = Number(bd.count) || 0;
          const earliestAvailableMs = Number(bd.earliestAvailableMs) || 0;
          const source = typeof bd.source === "string" ? bd.source : "feed";
          onBackfillDone(id, count, earliestAvailableMs, source);

        } else if (msg.type === "bar") {
          const bar = msg as LiveBar;
          if (!bar.symbol || !bar.time) return;
          bar.symbol = normalizeSymbol(bar.symbol);
          // Resolution MUST come from the study (both relays now send it). NEVER guess from the
          // timestamp: a 1m bar whose start lands on a 5m/60m boundary would be mislabeled,
          // corrupting higher-TF charts and leaving gaps on the 1m chart.
          const res = ((msg as any).resolution as string | undefined)?.replace("m", "") ?? "5";
          // Throttle this warning to once per 30s per symbol — the study sends a forming bar
          // without resolution on every tick, which otherwise floods the log (GBs/hour) and
          // wastes I/O. One warning is enough to surface the condition.
          if (!(msg as any).resolution) {
            const wkey = `nores:${bar.symbol}`;
            const nowMs = Date.now();
            if (nowMs - (noResWarnAt.get(wkey) ?? 0) > 30_000) {
              noResWarnAt.set(wkey, nowMs);
              console.warn(`[mw-feed] bar without resolution for ${bar.symbol} t=${bar.time} — defaulting to 5m (study should always send resolution)`);
            }
          }

          // CATCH-UP CANDLE FIX: validate individual live bars before broadcasting/persisting.
          // A bar with bad OHLC (e.g. h < l, zero prices) would corrupt signals and chart.
          if (bar.high < bar.low || bar.open <= 0 || bar.close <= 0 ||
              !Number.isFinite(bar.open) || !Number.isFinite(bar.high) ||
              !Number.isFinite(bar.low)  || !Number.isFinite(bar.close) ||
              !isSaneBarTime(bar.time)) {
            console.warn(`[mw-feed] bar: rejected invalid OHLC/time for ${bar.symbol} t=${bar.time}`);
            return;
          }

          broadcast({ type: "bar", resolution: res, bar });

          if (bar.complete) {
            persistBar(bar, res).then(() => {
              // Use a separate message type so the client can invalidate ONLY
              // background signal queries — not the main candle query — on each bar
              // completion. The completed bar is already in liveCandles via the WS
              // "bar" message above, so the main candle query doesn't need a refetch.
              cacheInvalidate(bar.symbol); // flush stale continuous-cache entries so next HTTP poll sees the new bar
              broadcast({ type: "bar_persisted", symbol: bar.symbol });
            }).catch(() => {});
          }

        } else if (msg.type === "footprint_bar") { // FOOTPRINT-STRATEGY:
          // Per-price-level bid/ask data from LiveBarRelay footprint accumulator // FOOTPRINT-STRATEGY:
          const fb = msg as any; // FOOTPRINT-STRATEGY:
          const fbSym = normalizeSymbol(fb.symbol); // FOOTPRINT-STRATEGY:
          const fbRes = (fb.resolution as string | undefined) ?? "5"; // FOOTPRINT-STRATEGY:
          const fbTime = fb.time as number | undefined; // FOOTPRINT-STRATEGY:
          const fbLevels = fb.levels as Array<{ price: number; b: number; a: number }> | undefined; // FOOTPRINT-STRATEGY:
          if (fbSym && fbTime && Array.isArray(fbLevels) && fbLevels.length > 0) { // FOOTPRINT-STRATEGY:
            const fpInterval = fbRes === "60" ? "60m" : fbRes === "15" ? "15m" : fbRes === "5" ? "5m" : "1m"; // FOOTPRINT-STRATEGY:
            try { _fpAddBar?.(fbSym!, fpInterval, fbTime!, fbLevels!); } catch { /* skip silently */ } // FOOTPRINT-STRATEGY:
          } // FOOTPRINT-STRATEGY:

        } else if (msg.type === "bulk_bars") {
          // History dump / backfill batch from LiveBarRelay — batch upsert into cached_candles.
          // v2 batches carry id/seq (server-requested backfill); legacy v1 dumps (no id) still
          // flow through the same path but keep the re-dump high-water guard.
          const bulk = msg as any;
          const sym  = normalizeSymbol(bulk.symbol) || undefined;
          const rawRes = (bulk.resolution as string | undefined) ?? "1";
          const res = rawRes.replace("m", "");
          const id  = typeof bulk.id === "string" && bulk.id.length > 0 ? bulk.id as string : undefined;
          const seq = typeof bulk.seq === "number" ? bulk.seq : 0;
          const isV2 = id !== undefined; // v2 server-driven backfill (authoritative, heals old rows)
          const bars = bulk.bars as Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> | undefined;
          if (!sym || !Array.isArray(bars) || bars.length === 0) {
            // Still ack an empty v2 batch so the study's seq accounting stays consistent.
            if (id) { try { ws.send(JSON.stringify({ type: "bulk_report", id, seq, accepted: 0, rejected: 0 })); } catch {} }
            return;
          }

          // ── Fast re-dump rejection (BEFORE expensive validation) ─────────────────────
          // The study re-dumps its full history constantly (LEGACY v1 path only). Compute the
          // batch's newest timestamp cheaply; if we already have everything up to it, drop the
          // batch immediately. SKIPPED for v2: gap-audit only requests ranges the DB is MISSING,
          // and v2 bars are authoritative — they must overwrite existing rows to heal history to
          // MW-identical values, so an "older than watermark" v2 bar must NOT be dropped here.
          if (!isV2) {
            const dumpKey = `${sym}:${res}`;
            if (!lastDumpMaxTs.has(dumpKey)) {
              let dbMax = 0;
              try {
                const row = db.$client.prepare(
                  `SELECT MAX(timestamp) AS mx FROM cached_candles WHERE symbol = ? AND resolution = ?`
                ).get(sym, res) as { mx: number | null } | undefined;
                dbMax = row?.mx ?? 0;
              } catch { /* DB unavailable — treat as 0 so we persist normally */ }
              lastDumpMaxTs.set(dumpKey, dbMax);
            }
            const wm = lastDumpMaxTs.get(dumpKey) ?? 0;
            // Cheap scan for the batch's max timestamp (handles ms or s without allocating).
            let rawMax = 0;
            for (const b of bars) { const t = b.t > 10_000_000_000 ? Math.floor(b.t / 1000) : b.t; if (t > rawMax) rawMax = t; }
            if (rawMax <= wm) return; // pure re-dump of known history — drop instantly
          }

          // Normalize timestamps: MW may send ms (13-digit) or s (10-digit) — always store as seconds.
          const normalizedBars = bars.map(b => ({
            ...b,
            t: b.t > 10_000_000_000 ? Math.floor(b.t / 1000) : b.t,
          }));

          // MW-RECONCILE: record the timestamps MW RETURNED for this backfill id (v2 only),
          // BEFORE validation/body-anomaly drops any. gap-audit's onBackfillDone reconcile-
          // deletes rows in the requested range MW did NOT return; recording the raw returned
          // set (not the validated subset) guarantees a real MW bar our guard happens to reject
          // is never treated as a phantom and deleted.
          if (isV2 && id) recordBackfillBars(id, normalizedBars.map(b => b.t));

          // CATCH-UP CANDLE FIX: validate every bar before persisting.
          // Reject bars that are not interval-aligned or have corrupt OHLCV.
          // This prevents oversized "catch-up" bars created during reconnect gaps
          // from polluting the candle store and producing false signals.
          const intervalSec = parseInt(res, 10) * 60; // e.g. res="5" → 300s
          const validBars = normalizedBars.filter(b => {
            if (!b.t || !b.o || !b.h || !b.l || !b.c) return false;   // missing fields
            if ((b as any).v == null || (b as any).v === 0) return false; // ghost bar — zero/absent volume
            if (!isSaneBarTime(b.t))                  return false;   // future/corrupt-dated
            if (b.h <= b.l || b.o <= 0 || b.c <= 0)  return false;   // invalid OHLC (h<=l rejects flat/no-range candles)
            if (!Number.isFinite(b.o) || !Number.isFinite(b.h) ||
                !Number.isFinite(b.l) || !Number.isFinite(b.c))       return false; // NaN/Inf
            if (b.l < 1000 || b.h > 100_000)                          return false; // corrupt float32 pattern (512, 47104, etc.)
            if ((b.h - b.l) / b.c > 0.05)                            return false; // >5% H-L spread impossible in MES
            // Timestamp must be aligned to the declared resolution interval.
            // A catch-up bar covering multiple periods would have an unaligned timestamp
            // or would span an abnormally large range — both are rejected here.
            if (intervalSec > 0 && b.t % intervalSec !== 0)           return false; // not aligned
            return true;
          });
          const skipped = normalizedBars.length - validBars.length;
          if (skipped > 0) console.log(`[mw-feed] bulk_bars: skipped ${skipped} invalid/misaligned bars for ${sym} res=${res}`);
          if (validBars.length === 0) return;

          // Body anomaly pass: detect bars where the whole bar is displaced >2.5% from
          // neighboring bars' mid-prices. MW float32 artifacts corrupt one bar every ~512
          // minutes; the body looks normal in isolation but is ~3-4% below real price.
          const sortedBatch = [...validBars].sort((a, b) => a.t - b.t);
          const cleanBars = sortedBatch.filter((b, i) => {
            const mid = (b.o + b.c) / 2;
            const lo = Math.max(0, i - 10), hi = Math.min(sortedBatch.length, i + 11);
            const nbMids = sortedBatch.slice(lo, hi)
              .filter((_, j) => lo + j !== i)
              .map(n => (n.o + n.c) / 2)
              .sort((a, b) => a - b);
            if (nbMids.length < 4) return true; // edge of batch — can't judge, keep
            const trim = Math.floor(nbMids.length * 0.2);
            const trimmed = nbMids.slice(trim, nbMids.length - trim);
            const mean = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
            return Math.abs(mid - mean) / mean <= 0.025;
          });
          const bodySkipped = sortedBatch.length - cleanBars.length;
          if (bodySkipped > 0) console.log(`[mw-feed] bulk_bars: rejected ${bodySkipped} body-anomaly bars for ${sym} res=${res}`);

          // MW-SYNC (v2): counted-reject reply so the study/server can track batch health.
          // accepted = bars that survived validation + body-anomaly; rejected = everything else.
          if (id) {
            const accepted = cleanBars.length;
            const rejected = bars.length - accepted;
            try { ws.send(JSON.stringify({ type: "bulk_report", id, seq, accepted, rejected })); } catch {}
          }

          // ── Re-dump guard: only persist bars NEWER than the high-water mark ──────────
          // The study re-dumps its full history on every reconnect (constantly). Persist
          // only bars we don't already have, so repeated dumps become near-instant no-ops
          // instead of re-writing 80k rows and starving the event loop. Initialize the
          // high-water mark lazily from the DB so even the first dump after a restart skips
          // already-stored bars (no startup flood).
          //
          // SKIPPED for v2: server-driven backfill bars are authoritative and OVERWRITE existing
          // rows (onConflictDoUpdate) — that is the mechanism that heals history to MW-identical.
          // gap-audit only requests missing ranges, so there is no re-dump flood to guard against.
          let toPersist: typeof cleanBars;
          if (isV2) {
            toPersist = cleanBars;
          } else {
            const dumpKey = `${sym}:${res}`;
            if (!lastDumpMaxTs.has(dumpKey)) {
              let dbMax = 0;
              try {
                const row = db.$client.prepare(
                  `SELECT MAX(timestamp) AS mx FROM cached_candles WHERE symbol = ? AND resolution = ?`
                ).get(sym, res) as { mx: number | null } | undefined;
                dbMax = row?.mx ?? 0;
              } catch { /* DB unavailable — treat as 0 so we persist normally */ }
              lastDumpMaxTs.set(dumpKey, dbMax);
            }
            const watermark = lastDumpMaxTs.get(dumpKey) ?? 0;
            toPersist = cleanBars.filter(b => b.t > watermark);
            // Advance the high-water mark to the newest bar seen in this batch.
            const batchMax = cleanBars.reduce((m, b) => (b.t > m ? b.t : m), watermark);
            if (batchMax > watermark) lastDumpMaxTs.set(dumpKey, batchMax);
          }
          if (toPersist.length === 0) return; // pure re-dump of known history — skip entirely

          // Track sync state
          if (mwSyncStatus === "pending") { mwSyncStatus = "syncing"; mwSyncStartedAt = Date.now(); }
          mwSyncSymbol = sym;
          mwSyncBarsReceived += toPersist.length;
          broadcast({ type: "mw_sync_progress", symbol: sym, barsReceived: mwSyncBarsReceived });

          // MW-SYNC (v2): heal continuous-contract roll re-adjustments BEFORE upserting the
          // overlap, so older stored bars are shifted by the roll δ instead of leaving a price
          // cliff. Legacy v1 dumps skip this (they only append newer bars, never heal old ones).
          const healThen = isV2
            ? detectAndHeal(sym, res, toPersist).catch(() => null)
            : Promise.resolve(null);
          healThen
            .then(() => persistBulk(sym, res, toPersist))
            .then(() => {
              // 1M-DERIVE: whenever MW backfills 1m bars, re-derive the 5m/15m/60m buckets they
              // compose (one batched pass over the message's 1m span, not per-bar). MES only —
              // deriving from ES/contract-keyed sparse 1m would clobber their native higher-TF rows.
              if (sym === "MES" && res === "1" && toPersist.length > 0) {
                let lo = Infinity, hi = -Infinity;
                for (const b of toPersist) { if (b.t < lo) lo = b.t; if (b.t > hi) hi = b.t; }
                try { deriveRange(sym, lo, hi); } catch (e: any) { console.error("[mw-feed] derive-after-1m-backfill error:", e?.message); }
              }
              mwSyncStatus = "done";
              broadcast({ type: "data_updated", symbol: sym });
              broadcast({ type: "mw_sync_done", symbol: sym, barsReceived: mwSyncBarsReceived });
            })
            .catch((e) => console.error("[mw-feed] bulk_bars persist error:", e.message));
        }
      } catch {
        // malformed JSON — ignore
      }
    });

    ws.on("close", () => {
      clearInterval(mwPingInterval);
      // MW-SYNC (v2): unregister this study's (SYM:RES) entries and stop its backfills.
      for (const k of registeredKeys) {
        if (studySockets.get(k) === ws) studySockets.delete(k);
      }
      onStudyDisconnected(ws);
      const remaining = mwWss!.clients.size;
      console.log(`[mw-feed] MotiveWave study disconnected (remaining: ${remaining})`);
      if (remaining === 0) setTickRelayConnected(false);
    });
  });

  mwWss.on("error", (err) => {
    console.error("[mw-feed] WebSocket server error:", err.message);
  });

  // ── REST endpoints — kept as fallback if WebSocket isn't available ─────────
  app.post("/api/live-bars", async (req, res) => {
    const bar = req.body as LiveBar;
    if (!bar || !bar.symbol || !bar.time) {
      res.status(400).json({ error: "invalid bar" });
      return;
    }
    broadcast({ type: "bar", bar });
    if (bar.complete) await persistBar(bar).catch(() => {});
    res.json({ ok: true });
  });

  app.post("/api/tick-price", (req, res) => {
    const { symbol, price, time } = req.body as { symbol?: string; price?: number; time?: number };
    if (!symbol || typeof price !== "number" || !isFinite(price) || price <= 0) {
      res.status(400).json({ error: "invalid tick" });
      return;
    }
    const nsym = normalizeSymbol(symbol);
    broadcast({ type: "tick", symbol: nsym, price, time: time ?? Date.now() });
    notifyExternalTick(nsym, price);
    res.json({ ok: true });
  });

  app.get("/api/live-bars/status", (_req, res) => {
    res.json({
      browsers:         wss ? wss.clients.size : 0,
      mwClients:        mwWss?.clients.size ?? 0,
      autoTraderCount:  orderCommandSockets.size,
      autoTraderOpen:   [...orderCommandSockets].filter(ws => ws.readyState === WebSocket.OPEN).length,
      wsPath:           WS_PATH,
      mwWsPath:         MW_WS_PATH,
      orderWsPath:      ORDER_WS_PATH,
      status:           "ok",
    });
  });

  // ── Port 5000 listener for MotiveWave studies ──────────────────────────────
  // All three MW studies (TickRelay, LiveBarRelay, AutoTrader) connect to localhost:5000.
  // This minimal server accepts only WebSocket upgrades and forwards them to the same
  // WSS instances as the main server — no duplicate connection logic needed.
  const mwServer5000 = createHttpServer();
  mwServer5000.on("upgrade", (request, socket, head) => {
    const pathname = request.url?.split("?")[0];
    if (pathname === MW_WS_PATH) {
      mwWss!.handleUpgrade(request, socket, head, (ws) => {
        mwWss!.emit("connection", ws, request);
      });
    } else if (pathname === ORDER_WS_PATH) {
      orderWss.handleUpgrade(request, socket, head, (ws) => {
        orderWss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });
  mwServer5000.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.warn("[live-bars] Port 5000 already in use — MW studies may not connect");
    } else {
      console.error("[live-bars] Port 5000 server error:", err.message);
    }
  });
  mwServer5000.listen(5000, "127.0.0.1", () => {
    console.log("[live-bars] MW study bridge listening on port 5000 (TickRelay + LiveBarRelay + AutoTrader)");
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function broadcast(msg: object) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch { /* client closed mid-send — ignore */ }
    }
  });
}

async function persistBar(bar: LiveBar, resolution = "5") {
  if (!isSaneBarTime(bar.time)) return; // never persist future/corrupt-dated bars
  const resSec = (parseInt(resolution, 10) || 5) * 60;
  // Write-time guard: rejects None/≤0/malformed OHLC, GHOST bars (volume 0/None), OFF-GRID
  // timestamps (the source of the stray off-grid V0 rows), and gross spikes. maxDeviation 0.05
  // keeps the prior stricter MES bound on this live path.
  if (!validateBar({ open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, time: bar.time }, { resSec, maxDeviation: 0.05 })) return;
  if (bar.low < 1000 || bar.high > 100_000) return; // corrupt float32 pattern (512, 47104, …)
  await db.insert(cachedCandles).values({
    symbol: bar.symbol.toUpperCase(),
    resolution,
    timestamp: bar.time,
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    volume: bar.volume,
  }).onConflictDoUpdate({
    target: [cachedCandles.symbol, cachedCandles.resolution, cachedCandles.timestamp],
    set: { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
  });
}

/** Batch-upsert bars from a LiveBarRelay history dump. */
async function persistBulk(
  symbol: string,
  resolution: string,
  bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>,
) {
  const nowSec = Math.floor(Date.now() / 1000);
  const resSec = (parseInt(resolution, 10) || 5) * 60;
  // Write-time guard: off-grid, ghost (V0), malformed/≤0, spike — plus MES float32 bounds + time sanity.
  bars = bars.filter(b =>
    isSaneBarTime(b.t, nowSec) &&
    validateBar({ open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, time: b.t }, { resSec, maxDeviation: 0.05 }) &&
    b.l >= 1000 && b.h <= 100_000);
  if (!bars.length) return;
  const CHUNK = 500;
  const sym = symbol.toUpperCase();
  for (let i = 0; i < bars.length; i += CHUNK) {
    const chunk = bars.slice(i, i + CHUNK);
    await db.insert(cachedCandles)
      .values(chunk.map(b => ({
        symbol: sym, resolution,
        timestamp: b.t,
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      })))
      .onConflictDoUpdate({
        target: [cachedCandles.symbol, cachedCandles.resolution, cachedCandles.timestamp],
        set: {
          open:   sql`excluded.open`,
          high:   sql`excluded.high`,
          low:    sql`excluded.low`,
          close:  sql`excluded.close`,
          volume: sql`excluded.volume`,
        },
      });
  }
  console.log(`[mw-feed] bulk_bars: persisted ${bars.length} bars for ${symbol} res=${resolution}`);
}
