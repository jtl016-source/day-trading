/**
 * GAP-HEAL FAILSAFE (2026-08-14, user: "i had to close my computer/lost wifi at a few
 * moments and now there are gaps in the market, make a fail safe to make sure there are
 * no incorrect gaps").
 *
 * Offline windows (PC asleep, wifi loss, MW closed) punch holes in cached_candles. Holes
 * are not cosmetic: the engine computes on served bars, so gaps degrade signals. The
 * existing machinery could already heal them — the MW study answers server-driven
 * backfills (gap-audit.ts) and yahoo covers ranges MW can't — but the audit ran ONLY when
 * a study connected, so gaps that appeared while connected (or healed-able later) stayed.
 *
 * This loop makes healing CONTINUOUS and layered:
 *   every HEAL_EVERY_MS (and on demand via POST /api/gaps/heal):
 *     1. per (MES × 1/5/15/60): session-aware audit (auditGaps — skips closed sessions and
 *        provider-unfillable ranges);
 *     2. MW study connected → dispatch the fills to it (authoritative source);
 *     3. no study for a gapped resolution → yahoo backfill fallback (1m base; the derive
 *        machinery heals coarse buckets from 1m);
 *     4. status recorded for GET /api/gaps/status and the daily digest — gaps that survive
 *        two consecutive passes are shouted, never silently tolerated.
 *
 * 2026-09-18 (user: "the chart is having trouble staying live / is laggy") — this loop was
 * itself a lag source: two unbounded ~4.5 s audits per pass (now ONE audit bounded to 7 days,
 * reused), a wrong-ticker heal (MES=F → ES=F), a forever-retry of minutes Yahoo never prints
 * (now retired as `yahoo_no_data`), a refetch-everything broadcast for a handful of healed
 * minutes (now per-bar), and a first pass stacked on boot (now +3 min).
 */
import type { Express } from "express";
import { auditGaps, requestGapSweep, getCompleteness, isSessionOpen, takeStudyDeclined } from "./gap-audit";
import { yahooBackfillSymbol } from "./routes";
import { db } from "./db";
import { validateBar } from "@shared/bar-time";
import { deriveForDeletedOneMin } from "./derive-bars";
import { cacheInvalidate } from "./cache";
import { broadcast } from "./live-bars";
import { isMwOffContract } from "./contract-guard"; // CONTRACT GUARD (2026-09-17): never ask a wrong-month chart to fill gaps

const SYMBOL = "MES";
const RESOLUTIONS = ["1", "5", "15", "60"];
const HEAL_EVERY_MS = 10 * 60_000;
// TAIL GRACE (2026-09-17): the newest minutes are not a gap yet — MW persists each minute as
// it closes, and while Yahoo is the writer (MW off-contract / closed) its CME chart feed runs
// ~10 min DELAYED. Auditing to the current minute made every pass find a 5–11-minute "gap"
// at the live edge, set needYahoo, and run the 26k-row symbol-wide backfill every 10 min
// (a synchronous better-sqlite3 hog that made the live WS feed feel laggy).
const TAIL_GRACE_SEC = 15 * 60;
// AUDIT WINDOW (2026-09-18 — event-loop stall fix): this loop heals RECENT holes (offline
// windows, feed hiccups). Yahoo serves ~7 days of 1m (the targeted heal clamps to now − 6 d),
// so auditing further back bought nothing here — and the unbounded audit read all ~2.46M MES
// 1m rows + walked every minute since Aug 2019: ~4.5 s of blocked event loop per call, twice
// per pass, every 10 minutes (measured). Whole-history coverage stays with gap-audit's
// hello / hourly / watchdog audits, which dispatch to the MW study (the only deep source).
const AUDIT_LOOKBACK_SEC = 7 * 86400;
// Same continuous ticker as yahoo-live (the canonical 1m writer) and the contract guard.
// 2026-09-18: this healer fetched chart/MES=F — Yahoo rolls each continuous ticker on its OWN
// schedule, so in roll week MES=F and ES=F can be different contract MONTHS, and ON CONFLICT
// DO NOTHING keeps whatever lands in a hole first: the exact Sep/Dec interleave of 09-17,
// re-created one healed minute at a time.
const YAHOO_TICKER = "ES=F";
// Small heals ride per-bar WS messages (the shape yahoo-live / the MW tick path already use);
// a data_updated makes every browser refetch its loaded history + rebuilds the day cache.
const MAX_PER_BAR_BROADCAST = 10;
// YAHOO-UNFILLABLE (2026-09-18): a few minutes are permanently absent from Yahoo's 1m feed
// (the 18:00 ET Globex-open minute, 00:00–00:09 ET, exchange-holiday halts the session
// classifier calls open). They were re-requested forever: consecutiveDirtyPasses climbed and
// the "gaps persist" warning + digest line fired every pass. A range Yahoo's answer COVERED
// (bars on both sides — or a closed session right before it) yet produced no bar for, on TWO
// passes ≥ 5 min apart, is recorded in unfillable_ranges (reason 'yahoo_no_data') so the audit
// stops re-requesting it. Never younger than 30 min: Yahoo's CME chart feed runs ~10 min late.
const UNFILLABLE_MIN_AGE_SEC = 30 * 60;
const UNFILLABLE_AFTER_PASSES = 2;
const UNFILLABLE_PASS_SPACING_SEC = 5 * 60;
const yahooMissAttempts = new Map<string, { n: number; lastAt: number; toTs: number }>(); // "from:to" → covered-but-empty passes (in-memory: a restart just re-counts)

export interface GapHealStatus {
  at: string;
  gapsFound: Record<string, number>;      // resolution → missing ranges at scan time
  healedVia: Record<string, string>;      // resolution → "mw" | "yahoo" | "clean"
  yahooInserted: number;
  consecutiveDirtyPasses: number;
  /** 1m ranges recorded as `yahoo_no_data` unfillable this pass (2026-09-18). */
  markedUnfillable?: number;
  error?: string;
}
let lastStatus: GapHealStatus | null = null;
let consecutiveDirty = 0;
export function gapHealStatus(): GapHealStatus | null { return lastStatus; }

let running = false;
export async function runGapHeal(trigger: "scheduled" | "manual"): Promise<GapHealStatus> {
  const status: GapHealStatus = { at: new Date().toISOString(), gapsFound: {}, healedVia: {}, yahooInserted: 0, consecutiveDirtyPasses: consecutiveDirty };
  if (running) { status.error = "already running"; return status; }
  running = true;
  try {
    let anyGap = false;
    let needYahooCoarse = false;
    let needYahoo1m = false;
    const nowS = Math.floor(Date.now() / 1000);
    const graceTs = nowS - TAIL_GRACE_SEC;
    const sinceTs = nowS - AUDIT_LOOKBACK_SEC;
    const settled = (g: { fromTs: number; toTs: number }) => g.fromTs < graceTs;
    // The resolution-'1' audit result is REUSED by the targeted 1m heal below (2026-09-18: it
    // was recomputed there — a second full audit per pass; nothing between the two touches 1m).
    let oneMinGaps: Array<{ fromTs: number; toTs: number }> = [];
    // STUDY-DECLINED (2026-09-23 — IBKR bridge F2): ranges the connected study refused by
    // POLICY (the bridge's contract-era floor / IB_BACKFILL_MAX_DAYS / serving disabled) since
    // the last pass. requestGapSweep still returns non-null for them (a study IS connected), so
    // without this they were never offered to Yahoo. 1m → the targeted Yahoo heal (only what
    // Yahoo's ~7-day 1m window can serve); coarse → the symbol-wide Yahoo pass.
    let declined1m: Array<{ fromTs: number; toTs: number }> = [];
    let declinedCoarse = 0;
    for (const res of RESOLUTIONS) {
      const d = takeStudyDeclined(SYMBOL, res);
      if (!d.length) continue;
      if (res === "1") declined1m = d.filter(r => r.toTs >= nowS - 6 * 86400 && r.fromTs < graceTs);
      else declinedCoarse += d.length;
      // (needYahoo1m stays the AUDIT verdict — ranges the study is filling are not also sent to Yahoo)
      if (res !== "1") needYahooCoarse = true;
    }
    if (declined1m.length || declinedCoarse) {
      console.log(`[gap-heal] ${SYMBOL}: the study DECLINED ${declined1m.length} recent 1m + ${declinedCoarse} coarse range(s) by policy → yahoo fallback`);
    }
    for (const res of RESOLUTIONS) {
      const gaps = auditGaps(SYMBOL, res, { sinceTs }).filter(settled);
      if (res === "1") oneMinGaps = gaps;
      status.gapsFound[res] = gaps.length;
      if (!gaps.length) { status.healedVia[res] = "clean"; continue; }
      anyGap = true;
      // CONTRACT GUARD: a study on the wrong contract month must not be the healer — its fills
      // would be the very interleave the repair removed. Yahoo (front month) fills instead.
      // (requestGapSweep also refuses by itself while off-contract; same bound as our audit.)
      const dispatched = isMwOffContract() ? null : requestGapSweep(SYMBOL, res, { sinceTs });
      if (dispatched != null) {
        status.healedVia[res] = "mw";
        console.log(`[gap-heal] ${SYMBOL}:${res} — ${gaps.length} missing range(s) dispatched to the MW study`);
      } else {
        status.healedVia[res] = "yahoo";
        if (res === "1") needYahoo1m = true; else needYahooCoarse = true;
        console.log(`[gap-heal] ${SYMBOL}:${res} — ${gaps.length} missing range(s), no study connected → yahoo fallback`);
      }
    }
    if (needYahooCoarse) {
      // Coarse resolutions ONLY: the symbol-wide yahoo pass (60m/5m/15m — it fetches NO 1m and
      // upserts ~26k rows synchronously). A 1m-only gap must never trigger it (2026-09-17: it
      // ran every 10 min for the Yahoo-lag tail and stalled the live feed).
      try { status.yahooInserted = await yahooBackfillSymbol(SYMBOL); }
      catch (e) { status.error = `yahoo fallback failed: ${(e as Error).message}`; }
    }
    if (needYahoo1m || declined1m.length) {
      // 1m gaps: TARGETED range fetch — yahooBackfillSymbol never touches 1m, which is how
      // the 2026-08-14 offline holes survived a 26k-bar "heal". Yahoo held every missing
      // minute; nobody was asking it for them.
      // Declined ranges the audit also found are deduped by the exact fromTs:toTs key.
      const heal1m = needYahoo1m ? [...oneMinGaps] : [];
      const seen1m = new Set(heal1m.map(r => `${r.fromTs}:${r.toTs}`));
      for (const r of declined1m) if (!seen1m.has(`${r.fromTs}:${r.toTs}`)) { seen1m.add(`${r.fromTs}:${r.toTs}`); heal1m.push(r); }
      if (heal1m.length) {
        try {
          const { inserted: healed, markedUnfillable } = await yahooHeal1mRanges(heal1m);
          status.yahooInserted += healed;
          if (markedUnfillable) status.markedUnfillable = markedUnfillable;
          if (healed) console.log(`[gap-heal] targeted yahoo 1m heal inserted ${healed} bars`);
        } catch (e) { status.error = `1m range heal failed: ${(e as Error).message}`; }
      }
    }
    consecutiveDirty = anyGap ? consecutiveDirty + 1 : 0;
    status.consecutiveDirtyPasses = consecutiveDirty;
    if (consecutiveDirty >= 2) {
      console.warn(`[gap-heal] ⚠️ gaps persist across ${consecutiveDirty} passes: ${JSON.stringify(status.gapsFound)} — check MW/LiveBarRelay and network`);
    }
  } catch (e) {
    status.error = (e as Error).message;
    console.warn(`[gap-heal] pass failed: ${status.error}`);
  } finally {
    running = false;
  }
  lastStatus = status;
  void trigger;
  return status;
}

/** TARGETED 1m RANGE HEAL (2026-08-14): fetch yahoo's 1m chart data for the exact missing
 *  spans (padded), write-guarded like every other ingest path, then re-derive the coarse
 *  buckets those minutes belong to and invalidate serving caches so open charts refresh.
 *  Yahoo serves ~7 days of 1m — offline-window holes are always inside that.
 *  2026-09-18: fetches ES=F (was MES=F — see YAHOO_TICKER), announces small heals as per-bar
 *  messages, and retires ranges Yahoo provably has no data for (see UNFILLABLE_*). */
async function yahooHeal1mRanges(ranges: Array<{ fromTs: number; toTs: number }>): Promise<{ inserted: number; markedUnfillable: number }> {
  const none = { inserted: 0, markedUnfillable: 0 };
  if (!ranges.length) return none;
  const now = Math.floor(Date.now() / 1000);
  let minFrom = Infinity, maxTo = -Infinity;
  for (const r of ranges) { if (r.fromTs < minFrom) minFrom = r.fromTs; if (r.toTs > maxTo) maxTo = r.toTs; }
  const lo = Math.max(minFrom - 300, now - 6 * 86400);
  const hi = Math.min(maxTo + 300, now);
  if (hi <= lo) return none;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_TICKER)}?period1=${lo}&period2=${hi}&interval=1m&includePrePost=true`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) throw new Error(`yahoo 1m chart HTTP ${resp.status}`);
  const j = await resp.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> } }> } };
  const r0 = j.chart?.result?.[0];
  const ts = r0?.timestamp ?? [];
  const q = r0?.indicators?.quote?.[0];
  if (!ts.length || !q) return none; // an empty answer proves nothing about any range
  const wanted = (t: number): boolean => ranges.some(g => t >= g.fromTs && t <= g.toTs);
  const ins = db.$client.prepare(
    `INSERT INTO cached_candles (symbol, resolution, timestamp, open, high, low, close, volume)
     VALUES ('MES', '1', ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol, resolution, timestamp) DO NOTHING`,
  );
  const insertedTs: number[] = [];
  const insertedBars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  // Span of the minutes Yahoo ACTUALLY printed (on-grid, non-null) — the coverage proof for the
  // unfillable accounting below. Independent of `wanted`: the ±5 min padding is what shows
  // Yahoo's feed on both sides of a hole.
  let firstPrinted = Infinity, lastPrinted = -Infinity;
  const tx = db.$client.transaction(() => {
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (t % 60 === 0 && q.open[i] != null && q.close[i] != null) {
        if (t < firstPrinted) firstPrinted = t;
        if (t > lastPrinted) lastPrinted = t;
      }
      if (!wanted(t) || !isSessionOpen(t)) continue;
      const bar = { open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0, time: t };
      if (bar.open == null || bar.close == null) continue; // yahoo null-minute
      if (!validateBar(bar, { resSec: 60 })) continue;      // the standard write guard
      const r = ins.run(t, bar.open, bar.high, bar.low, bar.close, bar.volume);
      if (r.changes > 0) { insertedTs.push(t); insertedBars.push(bar); }
    }
  });
  tx();
  if (insertedTs.length) {
    // Re-derive the 5m/15m/60m buckets containing the healed minutes (same helper the
    // reconcile path uses — it re-derives any bucket containing the given 1m timestamps).
    try { deriveForDeletedOneMin("MES", insertedTs); } catch { /* derive heal is best-effort */ }
    cacheInvalidate("MES");
    if (insertedBars.length <= MAX_PER_BAR_BROADCAST) {
      // SMALL HEAL (2026-09-18): per-bar messages — the same shapes yahoo-live and the MW tick
      // path emit — instead of data_updated, which made EVERY browser refetch its loaded range
      // and rebuilt the day cache for a handful of minutes. Charts that ignore an older `bar`
      // pick the rows up on their periodic reconcile; the engine page admits complete bars by
      // time, so it sees the healed minutes immediately.
      for (const b of insertedBars) {
        broadcast({ type: "bar", resolution: "1", bar: { symbol: SYMBOL, time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, complete: true } });
      }
      broadcastHealedCoarseBuckets(insertedTs);
      broadcast({ type: "bar_persisted", symbol: SYMBOL });
    } else {
      // Ranged: only the healed span changed — a bare data_updated made a scrolled-back tab
      // re-download its whole loaded history every heal pass.
      let minIns = Infinity;
      for (const t of insertedTs) if (t < minIns) minIns = t;
      broadcast({ type: "data_updated", symbol: "MES", fromTs: minIns });
    }
  }
  const markedUnfillable = noteYahooMisses(ranges, insertedTs, { now, lo, firstPrinted, lastPrinted });
  return { inserted: insertedTs.length, markedUnfillable };
}

/** Re-derived 5m/15m/60m buckets of a SMALL heal, as complete `bar` messages. Only buckets the
 *  1m store has fully passed (its newest minute is at/after the bucket's last minute) are sent:
 *  a still-open bucket — or one whose final minutes Yahoo's ~10-min-late feed has not delivered
 *  yet — is OLDER than the candle clients build from live ticks and must never overwrite it
 *  (yahoo-live's next cycle delivers it once it really is complete). */
function broadcastHealedCoarseBuckets(insertedTs: number[]): void {
  try {
    const edgeRow = db.$client.prepare(
      `SELECT MAX(timestamp) AS mx FROM cached_candles WHERE symbol=? AND resolution='1'`,
    ).get(SYMBOL) as { mx: number | null };
    if (edgeRow.mx == null) return;
    const storeEdge = edgeRow.mx + 60; // end of the newest stored 1m bucket
    const sel = db.$client.prepare(
      `SELECT timestamp AS time, open, high, low, close, volume FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp=?`,
    );
    for (const { res, step } of [{ res: "5", step: 300 }, { res: "15", step: 900 }, { res: "60", step: 3600 }]) {
      const buckets = new Set<number>();
      for (const t of insertedTs) buckets.add(Math.floor(t / step) * step);
      const nowS = Math.floor(Date.now() / 1000);
      for (const bt of buckets) {
        if (bt + step > storeEdge) continue;
        // A healed RUN only has to START ≥ 15 min ago — its younger minutes can sit inside the
        // 15m bucket that is forming right now, and a complete 5m sub-bar merges into a
        // 15m-from-5m display's CURRENT candle (its old close would overwrite the live one). A
        // 5m bucket that ended ≥ 15 min ago lies wholly in a previous 15m bucket.
        if (res === "5" && bt + step > nowS - 900) continue;
        const row = sel.get(SYMBOL, res, bt) as { time: number; open: number; high: number; low: number; close: number; volume: number } | undefined;
        if (!row) continue;
        broadcast({ type: "bar", resolution: res, bar: { symbol: SYMBOL, time: row.time, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, complete: true } });
      }
    }
  } catch { /* display nicety — the rows are stored either way; reconcile delivers them */ }
}

/** YAHOO-UNFILLABLE accounting (see UNFILLABLE_* above). Counts a pass against a range only
 *  when Yahoo's answer PROVES it covered the range and still printed nothing for it; the
 *  second such pass writes the unfillable row. Returns how many ranges were marked. */
function noteYahooMisses(
  ranges: Array<{ fromTs: number; toTs: number }>,
  insertedTs: number[],
  ctx: { now: number; lo: number; firstPrinted: number; lastPrinted: number },
): number {
  const { now, lo, firstPrinted, lastPrinted } = ctx;
  let marked = 0;
  for (const g of ranges) {
    const k = `${g.fromTs}:${g.toTs}`;
    if (insertedTs.some(t => t >= g.fromTs && t <= g.toTs)) { yahooMissAttempts.delete(k); continue; } // progress — the next audit re-cuts what is left
    if (now - g.toTs < UNFILLABLE_MIN_AGE_SEC) continue;   // Yahoo's feed may simply not be there yet
    if (g.fromTs < lo) continue;                           // (partly) older than the fetch window — never asked for all of it
    const coveredAfter = lastPrinted > g.toTs;             // its feed has moved PAST the hole
    const coveredBefore = firstPrinted < g.fromTs          // …and was printing before it,
      || !isSessionOpen(g.fromTs - 60);                    // or the hole opens a session (18:00 ET: nothing CAN precede it)
    if (!coveredAfter || !coveredBefore) continue;
    const prev = yahooMissAttempts.get(k);
    if (prev && now - prev.lastAt < UNFILLABLE_PASS_SPACING_SEC) continue; // two manual heals a second apart are one observation
    const n = (prev?.n ?? 0) + 1;
    if (n < UNFILLABLE_AFTER_PASSES) { yahooMissAttempts.set(k, { n, lastAt: now, toTs: g.toTs }); continue; }
    yahooMissAttempts.delete(k);
    try {
      const exists = db.$client.prepare(
        `SELECT 1 FROM unfillable_ranges WHERE symbol=? AND resolution='1' AND from_ts=? AND to_ts=? LIMIT 1`,
      ).get(SYMBOL, g.fromTs, g.toTs);
      if (!exists) {
        db.$client.prepare(
          `INSERT INTO unfillable_ranges (symbol, resolution, from_ts, to_ts, attempts, reason) VALUES (?,?,?,?,?,?)`,
        ).run(SYMBOL, "1", g.fromTs, g.toTs, n, "yahoo_no_data");
      }
      marked++;
      console.log(`[gap-heal] ${SYMBOL}:1 [${g.fromTs}..${g.toTs}] (${new Date(g.fromTs * 1000).toISOString()}..${new Date(g.toTs * 1000).toISOString()}) — Yahoo ${YAHOO_TICKER} covered it on ${n} passes and has no bar: marked unfillable (reason yahoo_no_data — binds the Yahoo path only; the MW study is still asked for it on its own audits)`);
    } catch (e) {
      console.warn(`[gap-heal] could not record unfillable range [${g.fromTs}..${g.toTs}]: ${(e as Error).message}`);
    }
  }
  // Ranges that healed / re-cut / aged out of the 7-day audit window never come back under
  // the same key — drop their counters so the map cannot grow without bound.
  for (const [k, v] of yahooMissAttempts) if (now - v.toTs > AUDIT_LOOKBACK_SEC + 86400) yahooMissAttempts.delete(k);
  return marked;
}

export function startGapHeal(app: Express): void {
  app.get("/api/gaps/status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    const completeness: Record<string, unknown> = {};
    for (const r of RESOLUTIONS) { try { completeness[r] = getCompleteness(SYMBOL, r); } catch { /* ignore */ } }
    res.json({ lastHeal: lastStatus, completeness });
  });
  app.post("/api/gaps/heal", async (_req, res) => {
    const s = await runGapHeal("manual");
    res.json(s);
  });
  // First pass after boot, then continuous. +3 min (was +45 s, 2026-09-18): at 45 s the pass
  // stacked on the startup Yahoo backfill + the live engine's first evaluation — boot already
  // saturates the event loop for >20 s, and that is exactly when every open chart reconnects.
  // Same quiet window the scheduler's jobs hold (BOOT_QUIET_MS).
  setTimeout(() => { void runGapHeal("scheduled"); }, 3 * 60_000);
  setInterval(() => { void runGapHeal("scheduled"); }, HEAL_EVERY_MS);
  console.log(`[gap-heal] failsafe started — session-aware audit + MW/yahoo heal every ${HEAL_EVERY_MS / 60000}min`);
}
