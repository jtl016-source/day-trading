// scripts/yahoo-live-fallback.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unit harness for the server/yahoo-live.ts fallback poller STATE MACHINE.
// NO test framework — plain asserts, run with:
//   npx tsx scripts/yahoo-live-fallback.test.ts   (exit 0 = all pass)
//
// Covers (no real MW connection needed — deps are injected):
//   • YIELD TO MW: cycle skipped entirely when MW is active (no Yahoo request)
//   • YIELD TO MW mid-cycle: MW connects while the fetch is in flight → NOTHING written
//   • Guard-chain parity with the startup yahooBackfillSymbol path / yahoo-backfill-1m.ts:
//     forming-bar exclusion, closed-session drop, validateBar (off-grid/ghost/malformed), dedup
//   • Normal cycle: write → deriveRange window → broadcast shapes (1m complete:true,
//     derived buckets complete iff their last 1m closed, tick, bar_persisted, cache invalidation)
//   • Nothing-new cycle: no derive, no broadcast
//   • Closed-session window (weekend): fetch skipped entirely
//   • decideFeedStatus: mw-live / yahoo-fallback / stale
// ─────────────────────────────────────────────────────────────────────────────
import {
  runPollCycle, filterCleanBars, decideFeedStatus, MAX_PER_BAR_BROADCAST,
  type CycleDeps, type YahooQuote1m,
} from "../server/yahoo-live";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

// Wed 2026-07-29 15:00:00Z = 10:00 ET / 09:00 CT — RTH, session open. Deterministic
// regardless of host TZ (isSessionOpen resolves America/Chicago via Intl).
const NOW = Math.floor(Date.UTC(2026, 6, 29, 15, 0, 0) / 1000);
const SAT = Math.floor(Date.UTC(2026, 7, 1, 15, 0, 0) / 1000);  // Sat — closed all day
const TUE_MAINT = Math.floor(Date.UTC(2026, 6, 28, 21, 30, 0) / 1000); // Tue 16:30 CT — maintenance hour

const q = (t: number, over: Partial<YahooQuote1m> = {}): YahooQuote1m => ({
  time: t, open: 6500, high: 6501, low: 6499, close: 6500.5, volume: 100, ...over,
});

interface Rec {
  fetchCalls: Array<{ from: number; to: number }>;
  written: YahooQuote1m[][];
  derived: Array<{ lo: number; hi: number }>;
  msgs: any[];
  invalidated: number;
}

function mkDeps(over: Partial<CycleDeps> = {}): { deps: CycleDeps; rec: Rec } {
  const rec: Rec = { fetchCalls: [], written: [], derived: [], msgs: [], invalidated: 0 };
  const deps: CycleDeps = {
    isMwActive: () => false,
    nowSec: () => NOW,
    lookbackSec: () => 30 * 60,
    fetch1m: async (from, to) => { rec.fetchCalls.push({ from, to }); return []; },
    writeBars: async rows => { rec.written.push(rows); return rows.map(r => r.time); },
    deriveWindow: (lo, hi) => { rec.derived.push({ lo, hi }); },
    // One synthetic derived row per bucket boundary inside [from..to].
    readBars: (res, from, to) => {
      const step = parseInt(res, 10) * 60;
      const rows: YahooQuote1m[] = [];
      for (let t = Math.ceil(from / step) * step; t <= to; t += step) rows.push(q(t));
      return rows;
    },
    broadcastMsg: m => { rec.msgs.push(m); },
    invalidateCache: () => { rec.invalidated++; },
    ...over,
  };
  return { deps, rec };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── filterCleanBars: guard-chain parity with the startup Yahoo path ──");
{
  const T = (m: number) => NOW - 30 * 60 + m * 60; // aligned minutes 14:30Z + m
  const raw: YahooQuote1m[] = [
    q(T(7)), q(T(1)), q(T(0)), q(T(2)), q(T(3)), q(T(4)), q(T(5)), q(T(6)), // 8 clean, unsorted
    q(T(1)),                                    // duplicate timestamp
    q(NOW - 30),                                // FORMING (t+60 > now) — Yahoo's appended live bar
    q(TUE_MAINT),                               // maintenance hour — closed session
    q(T(8), { volume: 0 }),                     // ghost V0
    q(T(9), { high: 6490 }),                    // malformed (high < low)
    q(T(10) + 30),                              // off-grid (not 60s-aligned)
  ];
  const { clean, drops } = filterCleanBars(raw, NOW);
  assert(clean.length === 8, "8 clean bars survive the guard chain");
  assert(drops.forming === 1, "forming bar excluded (t+60 > now)");
  assert(drops.session === 1, "maintenance-hour bar dropped by isSessionOpen");
  assert(drops.invalid === 3, "ghost V0 + malformed + off-grid dropped by validateBar");
  assert(drops.dup === 1, "duplicate timestamp collapsed");
  assert(clean.every((b, i) => i === 0 || b.time > clean[i - 1].time), "clean output sorted ascending");
  assert(clean[0].time === T(0) && clean[clean.length - 1].time === T(7), "sorted span = [T0..T7]");
}

console.log("── decideFeedStatus ──");
{
  assert(decideFeedStatus(true, null) === "mw-live", "MW active → mw-live (even with no poll history)");
  assert(decideFeedStatus(true, 10_000) === "mw-live", "MW active always wins over poller staleness");
  assert(decideFeedStatus(false, 60) === "yahoo-fallback", "fresh poll + no MW → yahoo-fallback");
  assert(decideFeedStatus(false, 3600) === "stale", "old poll + no MW → stale");
  assert(decideFeedStatus(false, null) === "stale", "never polled + no MW → stale");
}

async function main() {
  console.log("── runPollCycle: yields to MW at cycle start (no Yahoo request) ──");
  {
    const { deps, rec } = mkDeps({ isMwActive: () => true });
    const r = await runPollCycle(deps);
    assert(r.skipped === "mw-active", "cycle skipped as mw-active");
    assert(rec.fetchCalls.length === 0, "Yahoo was never queried");
    assert(rec.written.length === 0 && rec.msgs.length === 0, "nothing written, nothing broadcast");
  }

  console.log("── runPollCycle: MW connects MID-CYCLE (during fetch) → nothing written ──");
  {
    let calls = 0;
    const { deps, rec } = mkDeps({
      isMwActive: () => ++calls > 1, // false at cycle start, true on the post-fetch re-check
      fetch1m: async () => [q(NOW - 300), q(NOW - 240)],
    });
    const r = await runPollCycle(deps);
    assert(r.skipped === "mw-active-mid-cycle", "cycle aborted as mw-active-mid-cycle");
    assert(r.clean === 2, "bars were fetched+cleaned before the abort");
    assert(rec.written.length === 0, "writeBars never called — MW is authoritative");
    assert(rec.derived.length === 0 && rec.msgs.length === 0, "no derive, no broadcast");
  }

  console.log("── runPollCycle: closed-session window (Saturday) → fetch skipped ──");
  {
    const { deps, rec } = mkDeps({ nowSec: () => SAT });
    const r = await runPollCycle(deps);
    assert(r.skipped === "session-closed", "cycle skipped as session-closed");
    assert(rec.fetchCalls.length === 0, "Yahoo was never queried on a closed window");
  }

  console.log("── runPollCycle: normal cycle — write, derive, broadcast shapes ──");
  {
    // 8 closed 1m bars 14:30..14:37Z. closedEnd = 14:37+60 = 14:38Z.
    const T0 = NOW - 30 * 60;
    const raw = Array.from({ length: 8 }, (_, i) => q(T0 + i * 60, { high: 6510, close: 6500 + i }));
    const { deps, rec } = mkDeps({ fetch1m: async () => [...raw, q(NOW - 30)] });
    const r = await runPollCycle(deps);
    assert(r.skipped === undefined, "cycle ran to completion");
    assert(r.inserted === 8 && rec.written.length === 1 && rec.written[0].length === 8, "8 new 1m rows written");
    assert(rec.derived.length === 1 && rec.derived[0].lo === T0 && rec.derived[0].hi === T0 + 7 * 60,
      "deriveRange called once over exactly the new-1m span");

    const bars1 = rec.msgs.filter(m => m.type === "bar" && m.resolution === "1");
    assert(bars1.length === 8 && bars1.every(m => m.bar.complete === true && m.bar.symbol === "MES"),
      "each new 1m bar broadcast as MES resolution-1 complete:true");

    // 5m buckets 14:30 (ends 14:35 ≤ 14:38 → complete) and 14:35 (ends 14:40 > 14:38 → forming).
    const bars5 = rec.msgs.filter(m => m.type === "bar" && m.resolution === "5");
    assert(bars5.length === 2, "two affected 5m buckets broadcast");
    assert(bars5[0].bar.time === T0 && bars5[0].bar.complete === true, "closed 5m bucket flagged complete");
    assert(bars5[1].bar.time === T0 + 300 && bars5[1].bar.complete === false, "in-progress 5m bucket flagged forming");

    const bars15 = rec.msgs.filter(m => m.type === "bar" && m.resolution === "15");
    const bars60 = rec.msgs.filter(m => m.type === "bar" && m.resolution === "60");
    assert(bars15.length === 1 && bars15[0].bar.complete === false, "15m bucket broadcast as forming");
    assert(bars60.length === 1 && bars60[0].bar.complete === false, "60m bucket broadcast as forming");
    assert(r.broadcast === 8 + 2 + 1 + 1, "broadcast count = 1m + derived bucket messages");

    // 2026-09-18: the cycle no longer emits {type:"tick"} — Yahoo's CME chart feed is ~10 min
    // delayed, so its "tick" was a ten-minute-old print clients painted into the live candle.
    assert(rec.msgs.filter(m => m.type === "tick").length === 0, "no stale Yahoo tick is ever broadcast");
    assert(rec.msgs.some(m => m.type === "bar_persisted" && m.symbol === "MES"), "bar_persisted notification sent");
    assert(rec.invalidated === 1, "serving cache invalidated once");
  }

  console.log("── runPollCycle: MW translated ticks drive the live candle → Yahoo's still-OPEN coarse buckets are withheld ──");
  {
    // CONTRACT GUARD (2026-09-17/18): Yahoo's CME chart feed is ~10 min delayed; while MW's
    // translated ticks own the live price the cycle still writes + broadcasts CLOSED bars, but a
    // still-forming 5m/15m/60m bucket would merge a ten-minute-old close into the client's
    // CURRENT candle on a coarse chart — those are skipped (reconcile() delivers them once closed).
    const base = NOW - 22 * 60;
    const bars = Array.from({ length: 8 }, (_, i) => q(base - (base % 300) + i * 60));
    const mk = (covered: boolean) => mkDeps({ fetch1m: async () => bars, liveTicksCovered: () => covered });
    const a = mk(false), b = mk(true);
    const ra = await runPollCycle(a.deps), rb = await runPollCycle(b.deps);
    assert(ra.inserted === 8 && rb.inserted === 8, "both cycles write the new bars");
    const forming = (r: Rec) => r.msgs.filter(m => m.type === "bar" && m.bar.complete === false).length;
    const closed = (r: Rec) => r.msgs.filter(m => m.type === "bar" && m.bar.complete === true).length;
    assert(forming(a.rec) > 0, "legacy (MW absent): forming coarse buckets ARE broadcast");
    assert(forming(b.rec) === 0, "ticks covered: NO forming coarse bucket is broadcast");
    assert(closed(b.rec) === closed(a.rec) && closed(b.rec) >= 8, "closed bars are broadcast either way");
    assert(rb.broadcast === closed(b.rec), "broadcast count reflects only what was sent");
    assert(b.rec.msgs.some(m => m.type === "bar_persisted"), "bar_persisted still sent");
  }

  console.log("── runPollCycle: outage catch-up burst → ONE ranged data_updated, not thousands of bar messages ──");
  {
    const n = MAX_PER_BAR_BROADCAST + 5;
    const first = NOW - (n + 2) * 60;
    const bars = Array.from({ length: n }, (_, i) => q(first - (first % 60) + i * 60));
    const { deps, rec } = mkDeps({ fetch1m: async () => bars });
    const r = await runPollCycle(deps);
    assert(r.inserted === n, "all catch-up bars written");
    assert(rec.derived.length === 1, "derive still runs once over the span");
    assert(rec.msgs.filter(m => m.type === "bar").length === 0, "no per-bar broadcasts in a burst");
    const du = rec.msgs.filter(m => m.type === "data_updated");
    assert(du.length === 1 && du[0].symbol === "MES" && du[0].fromTs === bars[0].time, "one data_updated ranged from the oldest new bar");
    assert(rec.invalidated === 1 && rec.msgs.some(m => m.type === "bar_persisted"), "cache invalidated + bar_persisted sent");
  }

  console.log("── runPollCycle: overlap-only cycle (no new rows) → no derive, no broadcast ──");
  {
    const { deps, rec } = mkDeps({
      fetch1m: async () => [q(NOW - 300), q(NOW - 240)],
      writeBars: async () => [], // everything already stored (e.g. MW-official rows win)
    });
    const r = await runPollCycle(deps);
    assert(r.skipped === undefined && r.inserted === 0, "cycle completed with 0 inserted");
    assert(rec.derived.length === 0 && rec.msgs.length === 0 && rec.invalidated === 0,
      "no derive / broadcast / cache churn on a no-op cycle");
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.error("FAILURES:", failures); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
