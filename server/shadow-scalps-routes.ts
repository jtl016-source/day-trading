/**
 * SHADOW SCALPS — read-only summary route (2026-10-06). See server/shadow-scalps.ts and
 * docs/shadow-scalps-README.md.
 *
 *   GET /api/signals/shadow-scalps/summary?era=live|all&friction=1.0
 *     → per strategy × variant × cell × fill model: n, wins, win %, net/trade, PF, max drawdown (pts,
 *       by trade sequence), both halves of the recorded span, net/trade at 0.7 / 1.0 / 1.5 friction,
 *       drop-best-3, the kill flag; plus the live-only kill / promotion decisions, the sessions covered
 *       and the last run time. No random-entry control and no null / z / p fields (owner decision
 *       2026-10-07 — see docs/shadow-scalps-README.md).
 *
 * Defaults: era=live (the only era the rules count), friction=1.0 (the project standard). Paged SQLite
 * reads + an aggregate that yields the event loop every few ms (shadowScalpsSummary, memoized per table
 * version); the serialized body is also cached 60 s per query (main-thread hygiene).
 */
import type { Express } from "express";
import { shadowScalpsSummary } from "./shadow-scalps";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; body: string }>();

export function parseShadowScalpsQuery(q: Record<string, unknown>): { era: "live" | "all"; friction: number } | { error: string } {
  const eraRaw = String(q.era ?? "").toLowerCase();
  const era = eraRaw === "" || eraRaw === "live" ? "live" : eraRaw === "all" ? "all" : null;
  if (!era) return { error: "era must be live or all" };
  const fRaw = q.friction == null || q.friction === "" ? 1.0 : Number(q.friction);
  if (!Number.isFinite(fRaw) || fRaw < 0 || fRaw > 5) return { error: "friction must be a number of points between 0 and 5" };
  return { era, friction: Math.round(fRaw * 100) / 100 };
}

export function registerShadowScalpRoutes(app: Express): void {
  app.get("/api/signals/shadow-scalps/summary", async (req, res) => {
    const parsed = parseShadowScalpsQuery(req.query as Record<string, unknown>);
    if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const key = `${parsed.era}|${parsed.friction}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) { res.type("application/json").send(hit.body); return; }
    try {
      const body = JSON.stringify(await shadowScalpsSummary(parsed));
      if (cache.size > 50) cache.clear();
      cache.set(key, { at: Date.now(), body });
      res.type("application/json").send(body);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
}
