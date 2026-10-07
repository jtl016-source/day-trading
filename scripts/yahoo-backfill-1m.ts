/**
 * scripts/yahoo-backfill-1m.ts — standalone Yahoo Finance 1-MINUTE backfill for a missed window.
 *
 * WHY THIS EXISTS (2026-07-29): when MotiveWave is closed for days, the server's auto-startup
 * `yahooBackfillSymbol` (server/routes.ts) refreshes only 5m/15m/60m — it never fetches 1m, but
 * 1m is the single source of truth (derive-bars.ts) AND what every backtest outcome walk and
 * 5m-from-1m engine slice consumes. This script fills a missed 1m window from Yahoo, then
 * re-derives 5m/15m/60m from the new 1m so all intervals stay internally consistent.
 *
 * WRITE-GUARD PARITY with the repaired server path (LEARNINGS 2026-07-15, forming-bar ghost bug):
 *   • validateBar({resSec:60})  — off-grid timestamps, ghost (V=0) bars, malformed OHLC, coarse spikes
 *   • isSessionOpen             — drops maintenance-hour (17:00 ET) and weekend-closed prints
 *   • forming-bar exclusion     — Yahoo appends the current FORMING bar stamped at regularMarketTime;
 *                                 we additionally require the 1m bucket to have CLOSED (t+60 <= now)
 *   • INSERT ... ON CONFLICT DO NOTHING — never clobbers MW-official rows
 *   • db.ts trigger trg_cached_candles_grid_guard stays as the backstop (report candle_write_rejects
 *     before/after — it must NOT grow; growth means this script's mapping is misaligned)
 *
 * Yahoo 1m limits: ~30 days back, ≤7 days per request → chunked ≤6.5-day spans.
 * Symbol mapping matches the server path: MES → ES=F (same price, 1/10 size), stored under MES.
 *
 * Usage:
 *   npx tsx scripts/yahoo-backfill-1m.ts [--symbol MES] [--from ISO|epochSec] [--to ISO|epochSec]
 *                                        [--dry] [--no-derive]
 *   --from default: 25 days ago; --to default: now. --dry fetches+filters and reports, writes nothing.
 */
import { db } from "../server/db";
import { validateBar } from "../shared/bar-time";
import { isSessionOpen } from "../server/gap-audit";
import { deriveRange } from "../server/derive-bars";
import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// Mirror of server/routes.ts toYahooSymbol (micro → standard contract, same price).
function toYahooSymbol(sym: string): string {
  const MAP: Record<string, string> = {
    MES: "ES=F", MNQ: "NQ=F", MYM: "YM=F", M2K: "RTY=F", MCL: "CL=F", MGC: "GC=F",
    ES: "ES=F", NQ: "NQ=F", YM: "YM=F", RTY: "RTY=F", CL: "CL=F", GC: "GC=F",
  };
  return MAP[sym.toUpperCase()] ?? sym;
}

function parseTs(v: string): number {
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`unparseable --from/--to value: ${v}`);
  return Math.floor(ms / 1000);
}

let SYMBOL = "MES";
let DRY = false;
let NO_DERIVE = false;
let FROM_TS = Math.floor(Date.now() / 1000) - 25 * 86400;
let TO_TS = Math.floor(Date.now() / 1000);
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--symbol") SYMBOL = (argv[++i] ?? "MES").toUpperCase();
    else if (argv[i] === "--from") FROM_TS = parseTs(argv[++i] ?? "");
    else if (argv[i] === "--to") TO_TS = parseTs(argv[++i] ?? "");
    else if (argv[i] === "--dry") DRY = true;
    else if (argv[i] === "--no-derive") NO_DERIVE = true;
  }
}

interface Q { time: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchChunk1m(ySym: string, period1: Date, period2: Date): Promise<Q[]> {
  const result = await yahooFinance.chart(ySym, { period1, period2, interval: "1m" as any });
  return (result.quotes ?? [])
    .filter((q: any) => q.open != null && q.close != null && q.high != null && q.low != null)
    .map((q: any) => ({
      time: Math.floor(new Date(q.date).getTime() / 1000),
      open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0,
    }));
}

async function main(): Promise<void> {
  const ySym = toYahooSymbol(SYMBOL);
  const nowSec = Math.floor(Date.now() / 1000);
  const sqlite = db.$client;
  sqlite.pragma("busy_timeout = 15000");

  const rejectsBefore = (sqlite.prepare(`SELECT COUNT(*) n FROM candle_write_rejects`).get() as { n: number }).n;
  console.log(`[y1m] ${SYMBOL} (Yahoo ${ySym}) 1m window ${new Date(FROM_TS * 1000).toISOString()} → ${new Date(TO_TS * 1000).toISOString()}${DRY ? "  [DRY RUN]" : ""}`);
  console.log(`[y1m] candle_write_rejects BEFORE: ${rejectsBefore}`);

  // ── fetch in ≤6.5-day chunks (Yahoo 1m per-request limit is 7 days) ──
  const CHUNK_SEC = Math.floor(6.5 * 86400);
  const all: Q[] = [];
  for (let a = FROM_TS; a < TO_TS; a += CHUNK_SEC) {
    const b = Math.min(a + CHUNK_SEC, TO_TS);
    try {
      const bars = await fetchChunk1m(ySym, new Date(a * 1000), new Date(b * 1000));
      console.log(`[y1m] chunk ${new Date(a * 1000).toISOString().slice(0, 16)} → ${new Date(b * 1000).toISOString().slice(0, 16)}: ${bars.length} bars`);
      all.push(...bars);
    } catch (e: any) {
      console.error(`[y1m] chunk fetch error: ${e?.message}`);
    }
  }

  // ── the write guard (identical semantics to the repaired yahooBackfillSymbol upsert) ──
  const drop = { window: 0, forming: 0, session: 0, invalid: 0 } as Record<string, number>;
  const seen = new Set<number>();
  const clean: Q[] = [];
  for (const q of all) {
    if (q.time < FROM_TS || q.time >= TO_TS) { drop.window++; continue; }
    if (q.time + 60 > nowSec) { drop.forming++; continue; }          // 1m bucket not closed yet
    if (!isSessionOpen(q.time)) { drop.session++; continue; }        // maintenance hour / weekend
    if (!validateBar({ open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume, time: q.time }, { resSec: 60 })) {
      drop.invalid++; continue;                                       // off-grid / ghost V0 / malformed
    }
    if (seen.has(q.time)) continue;                                   // duplicate timestamp across chunk edges
    seen.add(q.time);
    clean.push(q);
  }
  clean.sort((x, y) => x.time - y.time);
  console.log(`[y1m] fetched ${all.length} → clean ${clean.length} (dropped: window ${drop.window}, forming ${drop.forming}, closed-session ${drop.session}, invalid/ghost/off-grid ${drop.invalid})`);

  if (!clean.length) { console.log(`[y1m] nothing to write`); return; }

  if (DRY) {
    const first = clean[0], last = clean[clean.length - 1];
    console.log(`[y1m] DRY: would insert ${clean.length} rows ${new Date(first.time * 1000).toISOString()} .. ${new Date(last.time * 1000).toISOString()}`);
    return;
  }

  // ── insert (ON CONFLICT DO NOTHING — MW-official rows always win) ──
  const ins = sqlite.prepare(
    `INSERT INTO cached_candles (symbol, resolution, timestamp, open, high, low, close, volume)
     VALUES (?, '1', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, resolution, timestamp) DO NOTHING`,
  );
  let inserted = 0;
  const tx = sqlite.transaction((rows: Q[]) => {
    for (const q of rows) inserted += ins.run(SYMBOL, q.time, q.open, q.high, q.low, q.close, Math.round(q.volume)).changes;
  });
  tx(clean);
  console.log(`[y1m] inserted ${inserted} new 1m rows (${clean.length - inserted} already existed)`);

  const rejectsAfter = (sqlite.prepare(`SELECT COUNT(*) n FROM candle_write_rejects`).get() as { n: number }).n;
  console.log(`[y1m] candle_write_rejects AFTER: ${rejectsAfter}${rejectsAfter !== rejectsBefore ? "  *** GREW — mapping misaligned, investigate ***" : "  (unchanged — clean write)"}`);

  // ── per-UTC-day audit of the window ──
  const perDay = sqlite.prepare(
    `SELECT date(timestamp,'unixepoch') d, COUNT(*) n, MIN(timestamp) mn, MAX(timestamp) mx
     FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<? GROUP BY 1 ORDER BY 1`,
  ).all(SYMBOL, FROM_TS, TO_TS) as Array<{ d: string; n: number; mn: number; mx: number }>;
  for (const r of perDay) console.log(`[y1m]   ${r.d}: ${r.n} 1m bars (${new Date(r.mn * 1000).toISOString().slice(11, 16)}–${new Date(r.mx * 1000).toISOString().slice(11, 16)}Z)`);

  // ── derive 5m/15m/60m from the new 1m (upserts buckets that HAVE 1m; native rows in 1m gaps kept) ──
  if (!NO_DERIVE) {
    const res = deriveRange(SYMBOL, FROM_TS, TO_TS);
    console.log(`[y1m] deriveRange: ${Object.entries(res).map(([r, x]) => `${r}m→${x.written} buckets`).join("  ")}`);
  }
  console.log(`[y1m] DONE`);
}

main().catch(err => { console.error(err); process.exit(1); });
