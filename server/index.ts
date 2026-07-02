import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupLiveBars, broadcast } from "./live-bars";
import { setupMWReader } from "./mw-reader";
import { serveStatic } from "./static";
import { createServer } from "http";
import { strategyGuard } from "./strategy-guard";
import { initFootprintEngine } from "./footprint-engine"; // FOOTPRINT-STRATEGY:
import { setupCsvWatch } from "./csv-watch"; // MW-SYNC: optional CSV export fallback

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
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
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
  setupLiveBars(httpServer, app);
  initFootprintEngine(broadcast); // FOOTPRINT-STRATEGY: wire broadcast so footprint_candle messages reach clients
  setupMWReader(httpServer, app);
  setupCsvWatch(); // MW-SYNC: no-op unless MW_EXPORT_DIR is set

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
  const port = parseInt(process.env.PORT || "5000", 10);
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
