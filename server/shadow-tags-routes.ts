/**
 * SHADOW TAGS — read-only scoring route (2026-10-01, docs/signal-analysis-2026-10-01.md §shadow).
 *
 *   GET /api/signals/shadow-tags/summary?days=90[&symbol=MES]
 *     → per tag × interval (plus an "all" interval row): the TAGGED fires and the UNTAGGED fires
 *       (evaluated rows without that tag), each RAW and DE-CLUSTERED: n (closed, scored), wins,
 *       win %, net pts (−1.0 pt friction per trade), net expectancy, still-open count;
 *       judgeable = de-clustered tagged n ≥ 40 (the analysis' decision bar for R1–R4).
 *
 * Population: signal_history rows with timestamp ≥ now − days. Rows whose shadow_tags is NULL
 * were written before the feature (not evaluated) — they are counted in `rows.legacy` and are in
 * neither the tagged nor the untagged group. '[]' = evaluated, no tag tripped.
 *
 * DE-CLUSTERED = the admission rule (server/fire-admission.ts, ONE_OPEN_PER_DIRECTION) replayed
 * as a time-ordered walk per symbol × interval over EVERY row in the window (legacy rows too —
 * they were real fires that held the slot): a row is kept only when no earlier KEPT same-direction
 * row on that interval is still open at its entry (the fire bar's close); an open row holds its
 * slot for at most OPEN_LOOKBACK_SEC (14 d, same horizon as admission). Kept rows are then
 * grouped by tag. RAW = every row, no walk. Cooldown is not replayed (admission already enforces
 * it on live/catch-up rows; regen rows are the engine's own spacing).
 *
 * Scoring: outcome win_tp1/win_tp2 = win; points = points_result, else the bracket distance
 * (win → |tp1 − entry|, loss → −|entry − sl|); 'eod' rows without points_result are 'unscored'.
 * NULL/'open' outcomes count as open (not scored). One grouped read on the main thread; the
 * serialized body is cached 60 s per query (main-thread hygiene, 2026-09-18).
 */
import type { Express } from "express";
import type BetterSqlite3 from "better-sqlite3";
import { db } from "./db";
import { OPEN_LOOKBACK_SEC } from "./fire-admission";
import { INTERVAL_SEC, SHADOW_TAG_IDS, type Interval } from "@shared/fact-engine";

export const SHADOW_TAG_FRICTION_PTS = 1.0;
export const SHADOW_TAG_JUDGEABLE_MIN_N = 40;
const INTERVALS: Interval[] = ["1m", "5m", "15m", "60m"];

export interface ShadowTagStats {
  n: number;              // closed + scored trades
  wins: number;
  winPct: number | null;  // 1 dp
  grossPts: number;
  netPts: number;         // gross − n × friction
  expPts: number | null;  // netPts / n (2 dp)
  open: number;           // still open (not scored)
}
export interface ShadowTagGroup { raw: ShadowTagStats; declustered: ShadowTagStats }
export interface ShadowTagRow {
  tag: string;
  interval: Interval | "all";
  tagged: ShadowTagGroup;
  untagged: ShadowTagGroup;
  judgeable: boolean;
}
export interface ShadowTagSummary {
  generatedAt: string;
  days: number;
  fromTs: number;
  symbol: string | null;
  frictionPts: number;
  judgeableMinN: number;
  rows: { total: number; evaluated: number; legacy: number; open: number; unscored: number; clustered: number };
  tags: ShadowTagRow[];
  /** Evaluated rows that tripped NO tag ('[]'), per interval + "all". */
  clean: Record<string, ShadowTagGroup>;
}

interface DbRow {
  symbol: string; interval: string; timestamp: number; direction: string; outcome: string | null;
  exit_ts: number | null; points_result: number | null; entry: number; tp1: number; sl: number; shadow_tags: string | null;
}
interface Scored {
  interval: string;
  tags: string[] | null;     // null = legacy (not evaluated)
  state: "closed" | "open" | "unscored";
  win: boolean;
  pts: number;
  kept: boolean;             // survives the de-cluster walk
}

function parseTags(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x: unknown): x is string => typeof x === "string") : null;
  } catch { return null; }
}

function scoreRow(r: DbRow): Pick<Scored, "state" | "win" | "pts"> {
  const o = r.outcome;
  if (o == null || o === "open") return { state: "open", win: false, pts: 0 };
  const win = o === "win_tp1" || o === "win_tp2";
  if (r.points_result != null && Number.isFinite(r.points_result)) return { state: "closed", win, pts: r.points_result };
  if (win && Number.isFinite(r.tp1) && Number.isFinite(r.entry)) return { state: "closed", win, pts: Math.abs(r.tp1 - r.entry) };
  if (o === "loss" && Number.isFinite(r.sl) && Number.isFinite(r.entry)) return { state: "closed", win: false, pts: -Math.abs(r.entry - r.sl) };
  return { state: "unscored", win, pts: 0 };
}

function emptyStats(): ShadowTagStats { return { n: 0, wins: 0, winPct: null, grossPts: 0, netPts: 0, expPts: null, open: 0 }; }
function addTo(st: ShadowTagStats, r: Scored): void {
  if (r.state === "open") { st.open++; return; }
  if (r.state !== "closed") return;
  st.n++; if (r.win) st.wins++;
  st.grossPts += r.pts;
}
function finish(st: ShadowTagStats): ShadowTagStats {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const net = st.grossPts - st.n * SHADOW_TAG_FRICTION_PTS;
  return {
    n: st.n, wins: st.wins,
    winPct: st.n ? Math.round((st.wins / st.n) * 1000) / 10 : null,
    grossPts: r2(st.grossPts), netPts: r2(net),
    expPts: st.n ? r2(net / st.n) : null,
    open: st.open,
  };
}
function group(rows: Scored[]): ShadowTagGroup {
  const raw = emptyStats(), dc = emptyStats();
  for (const r of rows) { addTo(raw, r); if (r.kept) addTo(dc, r); }
  return { raw: finish(raw), declustered: finish(dc) };
}

/** Pure w.r.t. the DB (one read). `client` defaults to the server connection. */
export function shadowTagSummary(opts: {
  nowSec: number; days: number; symbol?: string | null; client?: BetterSqlite3.Database;
}): ShadowTagSummary {
  const client = opts.client ?? db.$client;
  const fromTs = opts.nowSec - opts.days * 86400;
  const symbol = opts.symbol ? String(opts.symbol).toUpperCase() : null;
  const rows = client.prepare(
    `SELECT symbol, interval, timestamp, direction, outcome, exit_ts, points_result, entry, tp1, sl, shadow_tags
       FROM signal_history WHERE timestamp >= ?${symbol ? " AND symbol = ?" : ""}
      ORDER BY symbol, interval, timestamp, direction`,
  ).all(...(symbol ? [fromTs, symbol] : [fromTs])) as DbRow[];

  // De-cluster walk per symbol × interval (rows arrive time-ordered within each stream).
  const scored: Scored[] = [];
  let stream = "", openUntil: Record<string, number> = {};
  for (const r of rows) {
    const key = `${r.symbol}|${r.interval}`;
    if (key !== stream) { stream = key; openUntil = { L: -Infinity, S: -Infinity }; }
    const sc = scoreRow(r);
    const dir = String(r.direction ?? "").toLowerCase().startsWith("l") ? "L" : "S";
    const barSec = INTERVAL_SEC[r.interval as Interval] ?? 0;
    const entryTs = r.timestamp + barSec;
    const kept = !(openUntil[dir] > entryTs);
    if (kept) {
      const until = sc.state === "open"
        ? r.timestamp + OPEN_LOOKBACK_SEC
        : (r.exit_ts != null && Number.isFinite(r.exit_ts) ? r.exit_ts : entryTs);
      openUntil[dir] = until;
    }
    scored.push({ interval: r.interval, tags: parseTags(r.shadow_tags), ...sc, kept });
  }

  const evaluated = scored.filter(r => r.tags != null);
  const ivs: Array<Interval | "all"> = [...INTERVALS, "all"];
  const inIv = (r: Scored, iv: Interval | "all") => iv === "all" || r.interval === iv;
  const tags: ShadowTagRow[] = [];
  for (const tag of SHADOW_TAG_IDS) {
    for (const iv of ivs) {
      const pop = evaluated.filter(r => inIv(r, iv));
      const tagged = group(pop.filter(r => r.tags!.includes(tag)));
      const untagged = group(pop.filter(r => !r.tags!.includes(tag)));
      tags.push({ tag, interval: iv, tagged, untagged, judgeable: tagged.declustered.n >= SHADOW_TAG_JUDGEABLE_MIN_N });
    }
  }
  const clean: Record<string, ShadowTagGroup> = {};
  for (const iv of ivs) clean[iv] = group(evaluated.filter(r => inIv(r, iv) && r.tags!.length === 0));

  return {
    generatedAt: new Date(opts.nowSec * 1000).toISOString(),
    days: opts.days, fromTs, symbol,
    frictionPts: SHADOW_TAG_FRICTION_PTS,
    judgeableMinN: SHADOW_TAG_JUDGEABLE_MIN_N,
    rows: {
      total: scored.length,
      evaluated: evaluated.length,
      legacy: scored.length - evaluated.length,
      open: scored.filter(r => r.state === "open").length,
      unscored: scored.filter(r => r.state === "unscored").length,
      clustered: scored.filter(r => !r.kept).length,
    },
    tags, clean,
  };
}

export function parseShadowTagQuery(q: Record<string, unknown>, nowSec: number): { nowSec: number; days: number; symbol: string | null } | { error: string } {
  const daysRaw = q.days == null || q.days === "" ? 90 : Number(q.days);
  if (!Number.isFinite(daysRaw) || daysRaw < 1) return { error: "days must be a positive number" };
  const days = Math.min(400, Math.floor(daysRaw));
  const symRaw = q.symbol == null ? "" : String(q.symbol).trim();
  if (symRaw && !/^[A-Za-z0-9=!]{1,12}$/.test(symRaw)) return { error: "symbol must be 1-12 letters/digits" };
  return { nowSec, days, symbol: symRaw ? symRaw.toUpperCase() : null };
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; body: string }>();

export function registerShadowTagRoutes(app: Pick<Express, "get">, client?: BetterSqlite3.Database): void {
  app.get("/api/signals/shadow-tags/summary", (req, res) => {
    const parsed = parseShadowTagQuery(req.query as Record<string, unknown>, Math.floor(Date.now() / 1000));
    if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const key = `${parsed.days}|${parsed.symbol ?? ""}`;
    const hit = client ? undefined : cache.get(key); // an injected client (tests) never shares the cache
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) { res.type("application/json").send(hit.body); return; }
    try {
      const body = JSON.stringify(shadowTagSummary({ ...parsed, client }));
      if (!client) {
        if (cache.size > 50) cache.clear();
        cache.set(key, { at: Date.now(), body });
      }
      res.type("application/json").send(body);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
}
