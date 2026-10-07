/**
 * SHADOW EXITS — read-only summary route (2026-10-01). See server/shadow-exits.ts.
 *
 *   GET /api/signals/shadow-exits/summary?days=90[&session=eth|rth][&from=YYYY-MM-DD]
 *     → per interval × variant × mode: n, wins, win %, net pts (−1.0 friction/trade), the shipped
 *       exit on the SAME rows, delta, still-open count, judgeable (n ≥ 150).
 *
 * The aggregate is one grouped SQLite read on the main thread; the serialized body is cached for
 * 60 s per query so a polling UI costs one read a minute (main-thread hygiene, 2026-09-18).
 */
import type { Express } from "express";
import { shadowSummary } from "./shadow-exits";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; body: string }>();

export function parseSummaryQuery(q: Record<string, unknown>, nowSec: number): { nowSec: number; days: number; fromTs?: number; session: "ETH" | "RTH" | null } | { error: string } {
  const daysRaw = q.days == null || q.days === "" ? 90 : Number(q.days);
  if (!Number.isFinite(daysRaw) || daysRaw < 1) return { error: "days must be a positive number" };
  const days = Math.min(400, Math.floor(daysRaw));
  const sRaw = String(q.session ?? "").toLowerCase();
  const session = sRaw === "eth" ? "ETH" : sRaw === "rth" ? "RTH" : sRaw === "" || sRaw === "all" ? null : undefined;
  if (session === undefined) return { error: "session must be eth, rth or all" };
  let fromTs: number | undefined;
  if (q.from != null && q.from !== "") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(q.from));
    if (!m) return { error: "from must be YYYY-MM-DD" };
    fromTs = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000;
  }
  return { nowSec, days, fromTs, session };
}

export function registerShadowExitRoutes(app: Express): void {
  app.get("/api/signals/shadow-exits/summary", (req, res) => {
    const parsed = parseSummaryQuery(req.query as Record<string, unknown>, Math.floor(Date.now() / 1000));
    if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const key = `${parsed.days}|${parsed.fromTs ?? ""}|${parsed.session ?? ""}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) { res.type("application/json").send(hit.body); return; }
    try {
      const body = JSON.stringify(shadowSummary(parsed));
      if (cache.size > 50) cache.clear();
      cache.set(key, { at: Date.now(), body });
      res.type("application/json").send(body);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
}
