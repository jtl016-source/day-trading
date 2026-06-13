import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { registerPortfolioRoutes } from "./portfolio/routes"; // isolated portfolio research module
import { setupLiveBars, broadcast } from "./live-bars";
import { setupMWReader } from "./mw-reader";
import { serveStatic } from "./static";
import { createServer } from "http";
import { strategyGuard } from "./strategy-guard";
import { initFootprintEngine } from "./footprint-engine"; // FOOTPRINT-STRATEGY:

const app = express();
const httpServer = createServer(app);

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
  setupLiveBars(httpServer, app);
  initFootprintEngine(broadcast); // FOOTPRINT-STRATEGY: wire broadcast so footprint_candle messages reach clients
  setupMWReader(httpServer, app);

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
    },
  );

  // Graceful shutdown — release port before process exits so restarts don't hit EADDRINUSE
  const shutdown = () => {
    httpServer.closeAllConnections?.();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000); // Force-exit after 3s if connections hang
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);
})();
