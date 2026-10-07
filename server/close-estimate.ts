// server/close-estimate.ts
// GET /api/close-estimate?symbol=MES — EOD close-estimate zone (display-only).
//
// Thin wrapper over the SINGLE shared derivation (@shared/close-estimate-core — the Fractal
// Exchange "END OF DAY CLOSE VALUES" method): loads ~130 calendar days of 5m cached_candles
// (≈60+ trading sessions), spike-filters them through the shared filterYbBars (a corrupt wick
// must never become "the HOD"), and projects today's estimates from the running RTH extremes.
// Recomputed per request behind a 60s cache — "IF NEW HOD or LOD FORMS, RERUN" falls out of
// recomputation. LIVE-ONLY display data: never persisted, never an engine/backtest input.
import type { Express } from "express";
import { filterYbBars, type Bar } from "@shared/yellowbox-core";
import { computeCloseEstimate, type CloseEstimate } from "@shared/close-estimate-core";

interface SqliteLike { prepare(sql: string): { all: (...args: unknown[]) => unknown[] } }

type CloseEstResponse = ({ skipped: null } & CloseEstimate) | { skipped: string };

const CACHE_MS = 60_000;
const LOOKBACK_CAL_DAYS = 130; // calendar days of 5m bars → ≥60 trading sessions
let cache: { at: number; key: string; res: CloseEstResponse } | null = null;

/** Wire GET /api/close-estimate into the express app. */
export function registerCloseEstimate(app: Express, sqlite: SqliteLike): void {
  app.get("/api/close-estimate", (req, res) => {
    try {
      const symbol = String(req.query.symbol ?? "MES");
      if (cache && cache.key === symbol && Date.now() - cache.at < CACHE_MS) {
        res.json(cache.res);
        return;
      }
      const fromTs = Math.floor(Date.now() / 1000) - LOOKBACK_CAL_DAYS * 86400;
      const rows = sqlite.prepare(
        `SELECT timestamp t, open o, high h, low l, close c, volume v
           FROM cached_candles
          WHERE symbol=? AND resolution='5' AND timestamp>=?
          ORDER BY timestamp`,
      ).all(symbol, fromTs) as Bar[];
      const est = computeCloseEstimate(filterYbBars(rows, "5"));
      const out: CloseEstResponse = est ? { skipped: null, ...est } : { skipped: "insufficient history" };
      cache = { at: Date.now(), key: symbol, res: out };
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
