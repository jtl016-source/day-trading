/**
 * ROLL-MISMATCH REPAIR (2026-09-17). Companion to contract-guard.ts — the guard prevents a
 * repeat; this heals a window that two contract months already interleaved.
 *
 * MODEL: Yahoo's continuous ES=F is the canonical front-month series (it is what rolled first
 * and what the guard measures against). Over the repair window every stored MES 1m row is
 * OVERWRITTEN with Yahoo's 1m bar for that minute (write-guarded: validateBar + isSessionOpen),
 * stored 1m rows at minutes Yahoo lacks are deleted ONLY when they provably sit on the other
 * contract (≥ OFF_CONTRACT_MIN_PTS from the nearest Yahoo close within 10 min — otherwise
 * kept), then 5m/15m/60m are re-derived from the repaired 1m (derive-bars) and any surviving
 * NATIVE coarse row on the wrong contract (bucket with no 1m — derive can't rewrite it) is
 * deleted by the same nearest-close rule. Everything touched is copied to
 * cached_candles_roll_backup_<yyyymmdd> first (row-identity dedup, so re-runs never duplicate).
 *
 * AFTER the bars: the window's yellowbox_day_zones rows are dropped (LEARNINGS 2026-07-29:
 * same-batch cache rows are degenerate after any bulk backfill — recompute AFTER deriving so
 * cache == served bars), serving caches are flushed and data_updated is broadcast so open
 * charts refetch. Signal rows are NOT touched here — that is the missed-window runbook's
 * fe-bt --window-from step (the rows are regen-class and the wipe/repopulate is its contract).
 *
 * The window start auto-detects as the first minute (≤ 6.5 days back — Yahoo's 1m cap) where
 * the stored 1m close disagrees with Yahoo by ≥ OFF_CONTRACT_MIN_PTS; pass fromTs to override.
 * apply:false is a full dry run (same scan, no writes) — always look before applying.
 */
import { db } from "./db";
import { validateBar } from "@shared/bar-time";
import { sessionDayKey } from "@shared/yellowbox-core";
import { isSessionOpen } from "./gap-audit";
import { deriveRange, deriveForDeletedOneMin } from "./derive-bars";
import { cacheInvalidate } from "./cache";
import { invalidateDayCache } from "./day-cache";
import { broadcast } from "./live-bars";
import { OFF_CONTRACT_MIN_PTS, fetchYahooClosed1m } from "./contract-guard";

const SYMBOL = "MES";
const YAHOO_MAX_SEC = Math.floor(6.5 * 86_400);
const NEAREST_WINDOW_SEC = 10 * 60;   // an unpaired 1m row is judged against the nearest Yahoo close within this
const COARSE_NEAREST_SEC = 30 * 60;   // a native coarse row (no 1m in its bucket) likewise

interface Row1m { timestamp: number; open: number; high: number; low: number; close: number; volume: number }
interface YahooBar { time: number; open: number; high: number; low: number; close: number; volume: number }

export interface RollRepairReport {
  apply: boolean;
  fromTs: number | null;
  toTs: number;
  fromEt: string | null;
  autoDetected: boolean;
  yahooBars: number;
  stored1m: number;
  mismatched1m: number;      // stored minutes whose close differs from Yahoo by ≥ OFF_CONTRACT_MIN_PTS
  overwritten1m: number;     // Yahoo minutes written (apply) / that would be written (dry)
  deleted1m: number;         // off-contract orphan minutes Yahoo lacks (incl. closed-session prints)
  deletedClosedSession1m: number; // of those: maintenance-hour / weekend prints (never guard-legal)
  kept1mUnjudged: number;    // unpaired minutes with no Yahoo close nearby — left alone
  derived: Record<string, number>;
  deletedCoarse: Record<string, number>;
  zonesDropped: number;
  backupTable: string | null;
  backedUp: number;
  residualJumps: number;     // ≥30-pt open-vs-prev-close jumps left in the window's 1m (should be ~0)
  note?: string;
}

/** Full-window Yahoo 1m fetch (OHLCV) — chart API, closed minutes only. */
async function fetchYahoo1mOHLCV(fromSec: number, toSec: number): Promise<YahooBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/ES%3DF?period1=${fromSec}&period2=${toSec}&interval=1m&includePrePost=true`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) throw new Error(`yahoo 1m chart HTTP ${resp.status}`);
  const j = await resp.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open: Array<number | null>; high: Array<number | null>; low: Array<number | null>; close: Array<number | null>; volume: Array<number | null> }> } }> } };
  const r0 = j.chart?.result?.[0];
  const ts = r0?.timestamp ?? [];
  const q = r0?.indicators?.quote?.[0];
  if (!ts.length || !q) return [];
  const out: YahooBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    if (t % 60 !== 0 || t + 60 > toSec) continue;
    out.push({ time: t, open: q.open[i]!, high: q.high[i]!, low: q.low[i]!, close: q.close[i]!, volume: q.volume[i] ?? 0 });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function nearestClose(sortedTimes: number[], byTime: Map<number, number>, t: number, maxDist: number): number | null {
  // binary search for the insertion point, then look at both neighbours
  let lo = 0, hi = sortedTimes.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedTimes[m] < t) lo = m + 1; else hi = m; }
  let best: number | null = null, bestD = Infinity;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= sortedTimes.length) continue;
    const d = Math.abs(sortedTimes[i] - t);
    if (d <= maxDist && d < bestD) { bestD = d; best = byTime.get(sortedTimes[i]) ?? null; }
  }
  return best;
}

function countJumps(fromTs: number, toTs: number): number {
  const rows = db.$client.prepare(
    `SELECT timestamp t, open o, close c FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp BETWEEN ? AND ? ORDER BY timestamp`,
  ).all(SYMBOL, fromTs - 600, toTs) as Array<{ t: number; o: number; c: number }>;
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].t - rows[i - 1].t <= 900 && Math.abs(rows[i].o - rows[i - 1].c) >= 30) n++;
  }
  return n;
}

export async function repairRollMismatch(opts: { fromTs?: number; apply: boolean }): Promise<RollRepairReport> {
  const now = Math.floor(Date.now() / 1000);
  const toTs = now;
  const floor = now - YAHOO_MAX_SEC;
  const report: RollRepairReport = {
    apply: opts.apply, fromTs: null, toTs, fromEt: null, autoDetected: opts.fromTs == null,
    yahooBars: 0, stored1m: 0, mismatched1m: 0, overwritten1m: 0, deleted1m: 0, deletedClosedSession1m: 0, kept1mUnjudged: 0,
    derived: {}, deletedCoarse: {}, zonesDropped: 0, backupTable: null, backedUp: 0, residualJumps: 0,
  };

  // Reference series over the whole reachable span (auto-detect needs it all).
  const yahoo = await fetchYahoo1mOHLCV(floor, toTs);
  report.yahooBars = yahoo.length;
  if (!yahoo.length) { report.note = "yahoo returned no 1m bars"; return report; }
  const yByTime = new Map<number, YahooBar>();
  for (const b of yahoo) yByTime.set(b.time, b);
  const yCloseByTime = new Map<number, number>();
  for (const b of yahoo) yCloseByTime.set(b.time, b.close);
  const yTimes = yahoo.map(b => b.time);

  // Window start.
  let fromTs: number;
  if (opts.fromTs != null && Number.isFinite(opts.fromTs)) {
    fromTs = Math.max(floor, Math.floor(opts.fromTs / 60) * 60);
  } else {
    const stored = db.$client.prepare(
      `SELECT timestamp, close FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp BETWEEN ? AND ? ORDER BY timestamp`,
    ).all(SYMBOL, floor, toTs) as Array<{ timestamp: number; close: number }>;
    let first: number | null = null;
    for (const r of stored) {
      const y = yCloseByTime.get(r.timestamp);
      if (y != null && Math.abs(r.close - y) >= OFF_CONTRACT_MIN_PTS) { first = r.timestamp; break; }
    }
    if (first == null) { report.note = "no stored 1m minute disagrees with Yahoo by ≥ the off-contract threshold — nothing to repair"; return report; }
    fromTs = first;
  }
  report.fromTs = fromTs;
  report.fromEt = new Date(fromTs * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const yWindow = yahoo.filter(b => b.time >= fromTs);
  const stored1m = db.$client.prepare(
    `SELECT timestamp, open, high, low, close, volume FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp BETWEEN ? AND ? ORDER BY timestamp`,
  ).all(SYMBOL, fromTs, toTs) as Row1m[];
  report.stored1m = stored1m.length;

  // Yahoo minutes that pass the standard write guard — the ONLY minutes that get overwritten.
  // Yahoo's newest minute and its pre-halt minutes routinely arrive with volume 0 (its volume
  // lags the print), which the ghost guard rejects: such a minute must be JUDGED like an
  // unpaired one, never treated as "Yahoo has it" (the first pass left the 10:24 and the
  // 16:55–16:59 Sep prints standing that way). Yahoo's close is still a valid price
  // reference for the judgment even when the bar itself is unwritable.
  const writable = yWindow.filter(b => isSessionOpen(b.time) && validateBar(
    { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, time: b.time }, { resSec: 60 },
  ));
  const writableTimes = new Set(writable.map(b => b.time));

  // Classify stored minutes.
  const toDelete: number[] = [];
  for (const r of stored1m) {
    // A CLOSED-session print (maintenance hour / weekend) never passes any ingest guard —
    // yahoo-live, gap-heal and the backfill path all drop it — so one that is stored can only
    // be a wrong-month tick-built leftover (the 2026-09-15 17:39 ET V=24 Sep print that no
    // Yahoo neighbour existed to judge). Delete regardless of price.
    if (!isSessionOpen(r.timestamp)) { toDelete.push(r.timestamp); report.deletedClosedSession1m++; continue; }
    if (writableTimes.has(r.timestamp)) {
      const y = yCloseByTime.get(r.timestamp)!;
      if (Math.abs(r.close - y) >= OFF_CONTRACT_MIN_PTS) report.mismatched1m++;
      continue; // overwritten below
    }
    const near = nearestClose(yTimes, yCloseByTime, r.timestamp, NEAREST_WINDOW_SEC);
    if (near == null) { report.kept1mUnjudged++; continue; }
    if (Math.abs(r.close - near) >= OFF_CONTRACT_MIN_PTS) toDelete.push(r.timestamp);
    else report.kept1mUnjudged++;
  }
  report.overwritten1m = writable.length;
  report.deleted1m = toDelete.length;

  // Native coarse rows on the wrong contract: bucket has NO 1m constituent (derive can't fix it).
  const coarsePlan: Record<string, number[]> = { "5": [], "15": [], "60": [] };
  const stored1mAfter = new Set<number>();
  for (const r of stored1m) if (!toDelete.includes(r.timestamp)) stored1mAfter.add(r.timestamp);
  for (const t of writableTimes) stored1mAfter.add(t);
  for (const [res, sec] of [["5", 300], ["15", 900], ["60", 3600]] as Array<[string, number]>) {
    const rows = db.$client.prepare(
      `SELECT timestamp, close FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp BETWEEN ? AND ?`,
    ).all(SYMBOL, res, Math.floor(fromTs / sec) * sec, toTs) as Array<{ timestamp: number; close: number }>;
    for (const r of rows) {
      let hasOneMin = false;
      for (let t = r.timestamp; t < r.timestamp + sec; t += 60) if (stored1mAfter.has(t)) { hasOneMin = true; break; }
      if (hasOneMin) continue; // derive rewrites it from the repaired 1m
      const near = nearestClose(yTimes, yCloseByTime, r.timestamp + sec - 60, COARSE_NEAREST_SEC);
      if (near != null && Math.abs(r.close - near) >= OFF_CONTRACT_MIN_PTS) coarsePlan[res].push(r.timestamp);
    }
    report.deletedCoarse[res] = coarsePlan[res].length;
  }

  const dayKeyFrom = sessionDayKey(fromTs);
  report.zonesDropped = (db.$client.prepare(
    `SELECT COUNT(*) n FROM yellowbox_day_zones WHERE symbol=? AND day_key >= ?`,
  ).get(SYMBOL, dayKeyFrom) as { n: number }).n;

  if (!opts.apply) {
    report.residualJumps = countJumps(fromTs, toTs);
    report.note = "dry run — nothing written";
    return report;
  }

  // ── APPLY ──────────────────────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const backup = `cached_candles_roll_backup_${stamp}`;
  report.backupTable = backup;
  const tx = db.$client.transaction(() => {
    db.$client.exec(`CREATE TABLE IF NOT EXISTS ${backup} AS SELECT * FROM cached_candles WHERE 0`);
    const bk = db.$client.prepare(
      `INSERT INTO ${backup} SELECT c.* FROM cached_candles c
         WHERE c.symbol=? AND c.timestamp BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM ${backup} b WHERE b.symbol=c.symbol AND b.resolution=c.resolution AND b.timestamp=c.timestamp)`,
    ).run(SYMBOL, Math.floor(fromTs / 3600) * 3600, toTs);
    report.backedUp = bk.changes;

    const up = db.$client.prepare(
      `INSERT INTO cached_candles (symbol, resolution, timestamp, open, high, low, close, volume)
       VALUES (?, '1', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, resolution, timestamp) DO UPDATE SET
         open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`,
    );
    for (const b of writable) up.run(SYMBOL, b.time, b.open, b.high, b.low, b.close, Math.round(b.volume));
    const del1 = db.$client.prepare(`DELETE FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp=?`);
    for (const t of toDelete) del1.run(SYMBOL, t);
  });
  tx();

  // Re-derive the coarse buckets from the repaired 1m, then drop native coarse orphans.
  // Buckets that just lost their only 1m constituent (closed-session prints) must lose their
  // derived row too — deriveRange skips empty buckets by design (never-delete-native), so the
  // deleted-1m helper handles exactly that case.
  if (toDelete.length) { try { deriveForDeletedOneMin(SYMBOL, toDelete); } catch { /* best-effort */ } }
  const d = deriveRange(SYMBOL, fromTs, toTs);
  for (const [res, v] of Object.entries(d)) report.derived[res] = v.written;
  const delC = db.$client.prepare(`DELETE FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp=?`);
  const tx2 = db.$client.transaction(() => {
    for (const [res, list] of Object.entries(coarsePlan)) for (const t of list) delC.run(SYMBOL, res, t);
    db.$client.prepare(`DELETE FROM yellowbox_day_zones WHERE symbol=? AND day_key >= ?`).run(SYMBOL, dayKeyFrom);
  });
  tx2();

  cacheInvalidate(SYMBOL);
  invalidateDayCache(SYMBOL);
  broadcast({ type: "data_updated", symbol: SYMBOL, fromTs });
  report.residualJumps = countJumps(fromTs, toTs);
  console.log(`[roll-repair] ${SYMBOL} window ${report.fromEt} → now: overwrote ${report.overwritten1m} 1m from Yahoo (${report.mismatched1m} were on the other contract), deleted ${report.deleted1m} orphan 1m + ${JSON.stringify(report.deletedCoarse)} coarse, re-derived ${JSON.stringify(report.derived)}, dropped ${report.zonesDropped} yellowbox day rows, backup ${backup} (+${report.backedUp}); residual ≥30-pt jumps: ${report.residualJumps}`);
  return report;
}
