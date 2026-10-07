import "dotenv/config";
// SAFE STDIO (2026-09-18 outage): MUST stay the first project import — it moves every console
// write off the main thread so a launcher that stops draining our stdout pipe (ended preview
// session, closed window, QuickEdit selection) can no longer freeze the whole server at 0 % CPU.
import "./safe-stdio";
// ── WRONG-COPY BOOT GUARD (2026-08-05) ────────────────────────────────────────
// Twice, a server restart accidentally launched from a STALE copy of this project
// (a .claude/worktrees checkout) — old code, its own empty data/app.db ("my trades
// are gone"), and once with the public tunnel pointing at it UNGATED. The canonical
// checkout is the OneDrive project root; anything else must die loudly at boot.
{
  const cwd = process.cwd().replace(/\\/g, "/").toLowerCase();
  if (cwd.includes("/.claude/worktrees/") || !cwd.endsWith("/day trading iphone")) {
    // eslint-disable-next-line no-console
    console.error(
      `\n[FATAL] Refusing to start: wrong directory.\n` +
      `  cwd: ${process.cwd()}\n` +
      `  This is a stale copy/worktree — starting here serves OLD code and an EMPTY database.\n` +
      `  Start the server from the main project folder instead:\n` +
      `    cd "C:\\Users\\Jackson\\OneDrive\\day trading iphone" && npm run dev\n` +
      `  (or double-click "Start Trading Server" on the Desktop)\n`,
    );
    process.exit(1);
  }
}
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { registerPortfolioRoutes } from "./portfolio/routes"; // isolated portfolio research module
import { setupLiveBars, broadcast } from "./live-bars";
import { setupMWReader } from "./mw-reader";
import { serveStatic } from "./static";
import { createServer } from "http";
import { strategyGuard } from "./strategy-guard";
import { initFootprintEngine } from "./footprint-engine"; // FOOTPRINT-STRATEGY:
import { initScheduler } from "./scheduler"; // SCHEDULER (2026-08-02): catch-up / weekly regen / daily digest
import { startLiveEngine } from "./live-engine"; // SERVER-SIDE LIVE ENGINE (2026-08-13): bar-close firing + order authority
import { startGapHeal } from "./gap-heal"; // GAP-HEAL FAILSAFE (2026-08-14): continuous bar-store healing
import { getCachedDays } from "./day-cache"; // PERF (2026-07-30): prewarm the day aggregate at boot
import { registerIbkrRoutes, startIbkrBridge, configFromEnv as ibkrConfigFromEnv } from "./ibkr-bridge"; // IBKR BRIDGE (2026-09-23): IB Gateway in place of the MotiveWave studies — behind IB_ENABLED=true

const app = express();
const httpServer = createServer(app);
// Failsafe layer 2 (2026-08-05): separate loopback listener for the Cloudflare Tunnel —
// same app, bound only by CURRENT gated code. See the listen block at the bottom.
const publicEdgeServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      // LOG HYGIENE (2026-09-18 frozen-server incident): GET /api/live/bar/<SYM> is polled
      // 15–25 times per SECOND by the open clients — >90 % of everything this process wrote to
      // stdout was that one line. On Windows a stdout PIPE write is SYNCHRONOUS: when whatever
      // launched the server stops draining the pipe, the first write that finds the ~64 KB pipe
      // buffer full blocks the event loop FOREVER at 0 % CPU — no ticks, no WS, no HTTP
      // (reproduced 2026-09-18 on Node 24 / Win 11: a child whose stdout pipe is never read
      // wedges mid-console.log within ~80 KB of output; process.stdout._handle.setBlocking(false)
      // returns 0 and does NOT prevent it, so it is deliberately not used here). Less volume =
      // ~10× longer before an undrained pipe fills — a mitigation, not a cure: the cure is the
      // launcher (redirect stdout to a FILE, which can never block on a reader). The routine,
      // healthy poll is therefore not logged; a slow (≥ 250 ms) or failing (≥ 400) one still is
      // — that is the line that matters when the feed misbehaves.
      if (req.method === "GET" && res.statusCode < 400 && duration < 250 && path.startsWith("/api/live/bar/")) return;
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        // NEVER stringify large array payloads (candles/days/signals can be 10MB+) — doing so
        // re-serializes the whole response just for logging, flooding the log with GBs and
        // blocking the event loop, which starves other requests (the chart-won't-load bug).
        // Log a compact summary instead; only stringify small/plain bodies, capped at 200 chars.
        const r: any = capturedJsonResponse;
        let preview: string;
        if (Array.isArray(r?.candles))      preview = `{candles:${r.candles.length}}`;
        else if (Array.isArray(r?.days))    preview = `{days:${r.days.length}}`;
        else if (Array.isArray(r?.signals)) preview = `{signals:${r.signals.length}}`;
        else if (Array.isArray(r))          preview = `[${r.length} items]`;
        else { try { preview = JSON.stringify(r); } catch { preview = "[unserializable]"; } }
        if (preview.length > 200) preview = preview.slice(0, 200) + "…";
        logLine += ` :: ${preview}`;
      }

      log(logLine);
    }
  });

  next();
});

// Prevent unhandled async rejections from crashing the server process
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception (non-fatal):", err.message ?? err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection (non-fatal):", reason);
});

(async () => {
  await strategyGuard.init();
  await registerRoutes(httpServer, app);
  registerPortfolioRoutes(app); // /api/portfolio/* — isolated, no futures-engine coupling
  setupLiveBars(httpServer, app, [publicEdgeServer]); // public edge gets the same WS upgrade handling (gated)
  initFootprintEngine(broadcast); // FOOTPRINT-STRATEGY: wire broadcast so footprint_candle messages reach clients
  setupMWReader(httpServer, app);
  // IBKR BRIDGE (2026-09-23): the status route always exists ({enabled:false} by default); the
  // bridge itself — IB Gateway ticks/1m bars into the mw-feed path and brackets on the order
  // channel — starts ONLY with IB_ENABLED=true (docs/ibkr-setup.md). Off = nothing changes.
  registerIbkrRoutes(app);
  (await import("./shadow-exits-routes")).registerShadowExitRoutes(app); // SHADOW EXITS (2026-10-01): GET /api/signals/shadow-exits/summary (read-only)
  (await import("./shadow-tags-routes")).registerShadowTagRoutes(app); // SHADOW TAGS (2026-10-01): GET /api/signals/shadow-tags/summary (read-only)
  (await import("./shadow-scalps-routes")).registerShadowScalpRoutes(app); // SHADOW SCALPS (2026-10-06): GET /api/signals/shadow-scalps/summary (read-only)
  {
    const ibCfg = ibkrConfigFromEnv();
    if (ibCfg.enabled) {
      startIbkrBridge(app, ibCfg).catch((e: any) => console.error(`[ibkr] bridge failed to start: ${e?.message ?? e}`));
    } else {
      log("IBKR bridge disabled (IB_ENABLED not set) — MotiveWave studies remain the feed/order bridge", "ibkr");
    }
  }
  // SCHEDULER (2026-08-02): intraday catch-up (30min, session hours) + weekly regen (Sun 12:00
  // ET) + daily health digest (08:30 ET weekdays). Registered after all feeds are wired and
  // BEFORE the vite catch-all; jobs hold a 3-min boot-quiet window before first fire.
  initScheduler(app);
  // SERVER-SIDE LIVE ENGINE (2026-08-13, user directive "no missed signals"): fires signals +
  // places orders at every bar close for all four intervals, browser-independent. The client
  // path stays as a redundant no-op behind trade-state's order-claim registry.
  startLiveEngine(app);
  // GAP-HEAL FAILSAFE (2026-08-14, user: "no incorrect gaps"): continuous session-aware bar
  // auditing with MW-study + yahoo healing; offline windows can no longer leave holes.
  startGapHeal(app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "3000", 10);
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n[server] Port ${port} is already in use. Kill the old process and restart.\n  Run: npx kill-port ${port}\n`);
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
      // PERF (2026-07-30): prewarm the cached-days day aggregate for the primary symbol so the
      // one-time ~1.2s cold build happens at boot, not inside the first user request.
      setTimeout(() => {
        try { const n = getCachedDays("MES").length; log(`day-cache prewarmed: MES ${n} days`); }
        catch (e: any) { log(`day-cache prewarm failed: ${e?.message ?? e}`); }
      }, 2000);
    },
  );

  // ── PUBLIC-EDGE LISTENER (2026-08-05, failsafe layer 2) ─────────────────────
  // The Cloudflare Tunnel targets 127.0.0.1:3210 — NOT :3000 — so only THIS code
  // (which carries the API-key gate) can ever be publicly reachable. If a stale
  // copy of the project grabs :3000, the tunnel finds nothing on :3210 and the
  // domain serves 502 instead of an ungated trade API. Same app, same routes,
  // same WS upgrade handling (mirrored in setupLiveBars via publicEdgeServer).
  publicEdgeServer.listen({ port: 3210, host: "127.0.0.1" }, () => {
    log(`public-edge listener on 127.0.0.1:3210 (Cloudflare Tunnel target)`);
  });
  publicEdgeServer.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[public-edge] listener error: ${err.message} — the domain will be down until resolved`);
  });

  // Graceful shutdown — release port before process exits so restarts don't hit EADDRINUSE
  const shutdown = () => {
    httpServer.closeAllConnections?.();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000); // Force-exit after 3s if connections hang
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);
})();
