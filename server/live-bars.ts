/**
 * Live bar relay — receives OHLCV pushes from the MotiveWave Java study
 * and broadcasts them to all connected browser clients via WebSocket.
 *
 * WebSocket paths:
 *   /ws/live-bars  — server → browser (chart updates)
 *   /ws/mw-feed    — MotiveWave study → server (tick/bar ingest)
 */

import { type Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { type Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { cachedCandles } from "@shared/schema";
import { normalizeSymbol } from "@shared/symbols";
import { setMWBroadcast, notifyExternalTick } from "./mw-reader";
import { onStudyConnected, onStudyDisconnected, onBackfillDone } from "./gap-audit";
import { detectAndHeal } from "./roll-heal";

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

// ── Browser WebSocket (server → browsers) ────────────────────────────────────
let wss: WebSocketServer | null = null;
const WS_PATH       = "/ws/live-bars";
const MW_WS_PATH    = "/ws/mw-feed";
const ORDER_WS_PATH = "/ws/order-commands";

// Track ALL AutoTrader Java study connections (MW loads one instance per chart)
const orderCommandSockets = new Set<WebSocket>();
// Keep a single reference for backward compat (points to most-recently connected socket)
let orderCommandSocket: WebSocket | null = null;

// Sync status — resets to "pending" on every server start, set to "done" after first bulk_bars completes
let mwSyncStatus: "pending" | "syncing" | "done" = "pending";
let mwSyncSymbol = "";
let mwSyncBarsReceived = 0;
let mwSyncStartedAt: number | null = null;

export function getMWSyncStatus() {
  return { status: mwSyncStatus, symbol: mwSyncSymbol, barsReceived: mwSyncBarsReceived, startedAt: mwSyncStartedAt };
}

// MW-SYNC: upgraded (v2) LiveBarRelay studies that completed the `hello` handshake.
// Keyed by "SYM:RES" — one study instance per MW chart. Cleaned up on socket close.
const studySockets = new Map<string, WebSocket>();

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
  const mwWss = new WebSocketServer({ noServer: true });

  // AutoTrader Java study — receives order commands from server
  const orderWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = request.url?.split("?")[0];

    if (pathname === WS_PATH) {
      wss!.handleUpgrade(request, socket, head, (ws) => {
        wss!.emit("connection", ws, request);
      });
    } else if (pathname === MW_WS_PATH) {
      mwWss.handleUpgrade(request, socket, head, (ws) => {
        mwWss.emit("connection", ws, request);
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
    orderCommandSocket = ws; // most-recently connected
    console.log(`[order-commands] AutoTrader study connected (total: ${orderCommandSockets.size})`);
    try { ws.send(JSON.stringify({ type: "connected" })); } catch {}
    ws.on("error", () => { orderCommandSockets.delete(ws); });
    ws.on("pong", () => {}); // keep-alive
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
      if (orderCommandSocket === ws) {
        // Point to another open socket if available
        orderCommandSocket = [...orderCommandSockets].find(s => s.readyState === WebSocket.OPEN) ?? null;
      }
      console.log(`[order-commands] AutoTrader study disconnected (remaining: ${orderCommandSockets.size})`);
    });
  });

  // Ping all AutoTrader connections every 10s to detect stale sockets
  setInterval(() => {
    orderCommandSockets.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch { orderCommandSockets.delete(ws); }
      } else {
        orderCommandSockets.delete(ws);
      }
    });
    // Keep orderCommandSocket pointing to a live socket
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
  mwWss.on("connection", (ws) => {
    console.log("[mw-feed] MotiveWave study connected");

    // Per-connection state. `helloSeen` marks a v2 study that will always tag its
    // bars with an explicit resolution; legacy studies (no hello) keep the old
    // timestamp-mod inference fallback.
    let helloSeen = false;
    let resWarned = false;
    const registeredKeys = new Set<string>();

    ws.on("error", () => {});

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string; symbol?: string; price?: number; time?: number;
          open?: number; high?: number; low?: number; close?: number;
          volume?: number; complete?: boolean;
        };

        if (msg.type === "tick") {
          const { symbol, price, time } = msg;
          if (!symbol || typeof price !== "number" || !isFinite(price) || price <= 0) return;
          broadcast({ type: "tick", symbol: symbol.toUpperCase(), price, time: time ?? Date.now() });
          // Keep mw-reader's internal bar state in sync and suppress its disk heartbeat
          notifyExternalTick(symbol, price);

        } else if (msg.type === "hello") {
          // MW-SYNC: v2 handshake — register the study socket and kick a gap audit.
          const hm = msg as any;
          const sym = normalizeSymbol(hm.symbol ?? "");
          const res = String(hm.resolution ?? "").replace("m", "");
          if (!sym || !res) return;
          helloSeen = true;
          const k = `${sym}:${res}`;
          registeredKeys.add(k);
          studySockets.set(k, ws);
          console.log(`[mw-feed] hello ${k} ver=${hm.ver ?? "?"} series=[${hm.seriesStartMs ?? "?"}..${hm.seriesEndMs ?? "?"}]`);
          onStudyConnected(sym, res, ws);

        } else if (msg.type === "backfill_done") {
          // MW-SYNC: study finished servicing a backfill request.
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
          // Resolution: explicit field is authoritative. For a v2 study (hello seen)
          // it is mandatory — drop untagged bars. Legacy studies fall back to the
          // timestamp-mod heuristic.
          let res = (msg as any).resolution as string | undefined;
          if (res) {
            res = res.replace("m", "");
          } else if (helloSeen) {
            if (!resWarned) {
              console.warn(`[mw-feed] bar without resolution from v2 study ${bar.symbol} — dropping`);
              resWarned = true;
            }
            return;
          } else {
            res = bar.time % 3600 === 0 ? "60" : bar.time % 300 === 0 ? "5" : "1";
          }

          // CATCH-UP CANDLE FIX: validate individual live bars before broadcasting/persisting.
          // A bar with bad OHLC (e.g. h < l, zero prices) would corrupt signals and chart.
          if (bar.high < bar.low || bar.open <= 0 || bar.close <= 0 ||
              !Number.isFinite(bar.open) || !Number.isFinite(bar.high) ||
              !Number.isFinite(bar.low)  || !Number.isFinite(bar.close)) {
            console.warn(`[mw-feed] bar: rejected invalid OHLC for ${bar.symbol} t=${bar.time}`);
            return;
          }

          broadcast({ type: "bar", resolution: res, bar });

          if (bar.complete) {
            persistBar(bar, res).then(() => {
              broadcast({ type: "data_updated", symbol: bar.symbol });
            }).catch(() => {});
          }

        } else if (msg.type === "footprint_bar") { // FOOTPRINT-STRATEGY:
          // Per-price-level bid/ask data from LiveBarRelay footprint accumulator // FOOTPRINT-STRATEGY:
          const fb = msg as any; // FOOTPRINT-STRATEGY:
          const fbSym = (fb.symbol as string | undefined)?.toUpperCase(); // FOOTPRINT-STRATEGY:
          const fbRes = (fb.resolution as string | undefined) ?? "5"; // FOOTPRINT-STRATEGY:
          const fbTime = fb.time as number | undefined; // FOOTPRINT-STRATEGY:
          const fbLevels = fb.levels as Array<{ price: number; b: number; a: number }> | undefined; // FOOTPRINT-STRATEGY:
          if (fbSym && fbTime && Array.isArray(fbLevels) && fbLevels.length > 0) { // FOOTPRINT-STRATEGY:
            const fpInterval = fbRes === "60" ? "60m" : fbRes === "15" ? "15m" : fbRes === "5" ? "5m" : "1m"; // FOOTPRINT-STRATEGY:
            try { // FOOTPRINT-STRATEGY:
              import("./footprint-engine").then(({ addBar: fpAddBar }) => { // FOOTPRINT-STRATEGY:
                fpAddBar(fbSym!, fpInterval, fbTime!, fbLevels!); // FOOTPRINT-STRATEGY:
              }).catch(() => {}); // FOOTPRINT-STRATEGY:
            } catch { /* skip silently */ } // FOOTPRINT-STRATEGY:
          } // FOOTPRINT-STRATEGY:

        } else if (msg.type === "bulk_bars") {
          // History dump / backfill batch from LiveBarRelay — batch upsert into cached_candles.
          // v2 batches carry id/seq/final; legacy batches (no id) still flow through the same path.
          const bulk = msg as any;
          const sym  = normalizeSymbol(bulk.symbol ?? "");
          const rawRes = (bulk.resolution as string | undefined) ?? "1";
          const res = rawRes.replace("m", "");
          const id  = bulk.id as string | undefined;
          const seq = typeof bulk.seq === "number" ? bulk.seq : 0;
          const bars = bulk.bars as Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> | undefined;
          if (!sym || !Array.isArray(bars) || bars.length === 0) return;

          // CATCH-UP CANDLE FIX: validate every bar before persisting.
          // Reject bars that are not interval-aligned or have corrupt OHLCV.
          // This prevents oversized "catch-up" bars created during reconnect gaps
          // from polluting the candle store and producing false signals.
          const intervalSec = parseInt(res, 10) * 60; // e.g. res="5" → 300s
          const validBars = bars.filter(b => {
            if (!b.t || !b.o || !b.h || !b.l || !b.c) return false;   // missing fields
            if (b.h < b.l || b.o <= 0 || b.c <= 0)   return false;   // invalid OHLC
            if (!Number.isFinite(b.o) || !Number.isFinite(b.h) ||
                !Number.isFinite(b.l) || !Number.isFinite(b.c))       return false; // NaN/Inf
            // Timestamp must be aligned to the declared resolution interval.
            // A catch-up bar covering multiple periods would have an unaligned timestamp
            // or would span an abnormally large range — both are rejected here.
            if (intervalSec > 0 && b.t % intervalSec !== 0)           return false; // not aligned
            return true;
          });
          const accepted = validBars.length;
          const rejected = bars.length - accepted;

          // MW-SYNC: counted-reject reply so the study/server can track batch health.
          if (id) {
            try { ws.send(JSON.stringify({ type: "bulk_report", id, seq, accepted, rejected })); } catch {}
          }
          if (rejected > bars.length * 0.02) {
            console.warn(`[mw-feed] bulk_bars: ${rejected}/${bars.length} rejected for ${sym} res=${res}`);
            broadcast({ type: "mw_sync_warning", symbol: sym, resolution: res, accepted, rejected });
          } else if (rejected > 0) {
            console.log(`[mw-feed] bulk_bars: skipped ${rejected} invalid/misaligned bars for ${sym} res=${res}`);
          }
          if (accepted === 0) return;

          // Track sync state
          if (mwSyncStatus === "pending") { mwSyncStatus = "syncing"; mwSyncStartedAt = Date.now(); }
          mwSyncSymbol = sym;
          mwSyncBarsReceived += accepted;
          broadcast({ type: "mw_sync_progress", symbol: sym, barsReceived: mwSyncBarsReceived });

          // MW-SYNC: heal continuous-contract roll re-adjustments BEFORE upserting the overlap.
          detectAndHeal(sym, res, validBars)
            .catch(() => null)
            .then(() => persistBulk(sym, res, validBars))
            .then(() => {
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
      // MW-SYNC: unregister this study's (SYM:RES) entries and stop its backfills.
      for (const k of registeredKeys) {
        if (studySockets.get(k) === ws) studySockets.delete(k);
      }
      onStudyDisconnected(ws);
      console.log("[mw-feed] MotiveWave study disconnected");
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
    broadcast({ type: "tick", symbol: symbol.toUpperCase(), price, time: time ?? Date.now() });
    notifyExternalTick(symbol, price);
    res.json({ ok: true });
  });

  app.get("/api/live-bars/status", (_req, res) => {
    res.json({
      browsers:  wss ? wss.clients.size : 0,
      mwClients: mwWss.clients.size,
      wsPath:    WS_PATH,
      mwWsPath:  MW_WS_PATH,
      status:    "ok",
    });
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
export async function persistBulk(
  symbol: string,
  resolution: string,
  bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>,
) {
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
