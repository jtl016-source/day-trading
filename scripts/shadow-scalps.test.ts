// scripts/shadow-scalps.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// SHADOW SCALPS (2026-10-06, record-only) — server/shadow-scalps.ts + server/shadow-scalps-routes.ts.
// Temp SQLite via DB_PATH (the live data/app.db is never opened). No framework — plain asserts:
//   npx tsx scripts/shadow-scalps.test.ts   (exit 0 = all pass)
//
//   C  DST-safe ET session clock (EDT + EST + both 2026 transition weeks; never a UTC offset)
//   W  bracket walk: both-touched = loss, touch vs trade-through target, 1-tick-worse stop, 16:55 flat
//   S1 ORB-30: range = 09:30–09:59 bars only, first CLOSE beyond, one Long + one Short, noon cutoff,
//      entry per fill model, incomplete range guard, EST day built from raw UTC stamps
//   S2 limit fade: arming (within 2 pts, inside), touch vs trade-through vs 1-tick-worse fills, the
//      fill-bar stop, one open per direction + re-arm, the bar-close variant
//   N  NO random-entry control (owner decision 2026-10-07): only S1 / S2 rows are simulated or
//      recorded; the boot purge removes legacy "null-%" rows once (chunked, idempotent, logged once);
//      reads, summary, decisions and digest ignore any leftover control rows
//   D  DB: idempotent re-run, era tagging + preservation, boot backfill / catch-up, nightly slot,
//      FROZEN-CACHE-ONLY day box (cold path refused, deferred S2 + retry pass, zone provenance),
//      per-session error isolation + retry,
//      unfinished/weekend refusal, roll-jump guard; paged reads + yielding summary/digest
//   M  summary math: stats, halves, PF, maxDD, drop-best-3, kill + promotion logic (live only; no
//      control: n ≥ 300, net ≥ +0.3, both halves, drop-best-3), no null / z / p fields, SQL-filtered reads,
//      route query parsing, digest line
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}
const near = (a: number | null | undefined, b: number, tol = 1e-6): boolean => a != null && Math.abs(a - b) <= tol;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-scalps-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.BAXTER_ARTIFACTS_DIR = tmp;
  // Dynamic imports AFTER DB_PATH is set (static imports would open the real DB first).
  const ss = await import("../server/shadow-scalps");
  const routes = await import("../server/shadow-scalps-routes");
  const { db } = await import("../server/db");
  const { etWallToEpoch, YB_CACHE_VER } = await import("@shared/yellowbox-core");
  const client = (db as any).$client as import("better-sqlite3").Database;
  type Bar = import("../server/shadow-scalps").Bar;
  type TradeRow = import("../server/shadow-scalps").TradeRow;
  type SIR = import("../server/shadow-scalps").SummaryInputRow;

  // ── fixture builder: flat 1m bars 09:30..16:59 ET at a price schedule, plus explicit overrides ──
  const T = (day: string, hm: string): number => { const [h, m] = hm.split(":").map(Number); return etWallToEpoch(day, h, m); };
  function buildDay(day: string, schedule: Array<[string, number]>, overrides: Record<string, [number, number, number, number]> = {}, opts: { from?: string; to?: string } = {}): Bar[] {
    const from = T(day, opts.from ?? "09:30"), to = T(day, opts.to ?? "16:59");
    const sched = schedule.map(([hm, p]) => [T(day, hm), p] as [number, number]).sort((a, b) => a[0] - b[0]);
    const ov = new Map(Object.entries(overrides).map(([hm, v]) => [T(day, hm), v]));
    const out: Bar[] = [];
    for (let t = from; t <= to; t += 60) {
      let p = sched[0][1];
      for (const [st, sp] of sched) if (st <= t) p = sp;
      const o = ov.get(t);
      out.push(o ? { time: t, open: o[0], high: o[1], low: o[2], close: o[3] } : { time: t, open: p, high: p, low: p, close: p });
    }
    return out;
  }
  const insBar = client.prepare(`INSERT OR REPLACE INTO cached_candles (symbol, resolution, timestamp, open, high, low, close, volume) VALUES ('MES','1',?,?,?,?,?,100)`);
  const storeBars = (bars: Bar[]) => client.transaction((bs: Bar[]) => { for (const b of bs) insBar.run(b.time, b.open, b.high, b.low, b.close); })(bars);
  const pick = (rows: TradeRow[], f: Partial<TradeRow>) => rows.filter(r => Object.entries(f).every(([k, v]) => (r as any)[k] === v));

  // ───────────────────────────── C: session clock ─────────────────────────────
  console.log("── C  DST-safe ET session clock ──");
  {
    const s = ss.sessionClock("2026-07-15"); // EDT
    assert(s.rthOpen === Date.UTC(2026, 6, 15, 13, 30) / 1000, "EDT 09:30 ET = 13:30Z");
    assert(s.orbEnd === Date.UTC(2026, 6, 15, 14, 0) / 1000 && s.noon === Date.UTC(2026, 6, 15, 16, 0) / 1000, "EDT 10:00 / 12:00 ET = 14:00Z / 16:00Z");
    assert(s.flat === Date.UTC(2026, 6, 15, 20, 55) / 1000 && s.close === Date.UTC(2026, 6, 15, 21, 0) / 1000, "EDT 16:55 / 17:00 ET = 20:55Z / 21:00Z");
    const w = ss.sessionClock("2026-11-10"); // EST
    assert(w.rthOpen === Date.UTC(2026, 10, 10, 14, 30) / 1000 && w.flat === Date.UTC(2026, 10, 10, 21, 55) / 1000, "EST 09:30 / 16:55 ET = 14:30Z / 21:55Z");
    assert(ss.sessionClock("2026-11-02").rthOpen === Date.UTC(2026, 10, 2, 14, 30) / 1000, "Monday after the Nov 1 fall-back = EST");
    assert(ss.sessionClock("2026-10-30").rthOpen === Date.UTC(2026, 9, 30, 13, 30) / 1000, "Friday before the fall-back = EDT");
    assert(ss.sessionClock("2026-03-09").rthOpen === Date.UTC(2026, 2, 9, 13, 30) / 1000 && ss.sessionClock("2026-03-06").rthOpen === Date.UTC(2026, 2, 6, 14, 30) / 1000, "spring-forward week: Fri 03-06 EST, Mon 03-09 EDT");
    assert(ss.etDateKey(Date.UTC(2026, 9, 7, 3, 30) / 1000) === "2026-10-06", "etDateKey: 23:30 ET 10-06 (03:30Z 10-07) is still 10-06");
  }

  // ───────────────────────────── W: bracket walk ─────────────────────────────
  console.log("── W  bracket walk ──");
  {
    const t0 = T("2026-07-15", "10:00");
    const b = (i: number, o: number, h: number, l: number, c: number): Bar => ({ time: t0 + 60 * i, open: o, high: h, low: l, close: c });
    const fb = { price: 0, ts: 0 };
    // Long @100, TP 6 → 106, SL 8 → 92
    let w = ss.walkBracket([b(0, 100, 106, 92, 100)], 0, 100, 1, 6, 8, "optimistic", fb);
    assert(w.outcome === "loss" && w.exitPrice === 92, "both touched in one bar = LOSS (even optimistic), stop at the level");
    w = ss.walkBracket([b(0, 100, 106, 92, 100)], 0, 100, 1, 6, 8, "pessimistic", fb);
    assert(w.outcome === "loss" && w.exitPrice === 91.75, "pessimistic stop fills 1 tick worse (Long 92 → 91.75)");
    w = ss.walkBracket([b(0, 100, 108, 100, 107)], 0, 100, -1, 6, 8, "pessimistic", fb);
    assert(w.outcome === "loss" && w.exitPrice === 108.25, "Short pessimistic stop 108 → 108.25");
    const touch = [b(0, 100, 106, 99, 105), b(1, 105, 105, 104, 104)];
    w = ss.walkBracket(touch, 0, 100, 1, 6, 8, "standard", fb);
    assert(w.outcome === "win" && w.exitPrice === 106 && w.exitTs === t0 + 60, "standard: exact TOUCH of the target fills at the level");
    w = ss.walkBracket(touch, 0, 100, 1, 6, 8, "optimistic", fb);
    assert(w.outcome === "win" && w.exitPrice === 106, "optimistic: touch fills");
    w = ss.walkBracket(touch, 0, 100, 1, 6, 8, "pessimistic", fb);
    assert(w.outcome === "flat" && w.exitPrice === 104 && w.exitTs === t0 + 120, "pessimistic: a touch is NOT a fill → runs to the end (flat at the last close)");
    w = ss.walkBracket([b(0, 100, 106.25, 99, 106)], 0, 100, 1, 6, 8, "pessimistic", fb);
    assert(w.outcome === "win" && w.exitPrice === 106, "pessimistic: a 1-tick trade-through fills AT the level");
    w = ss.walkBracket([b(0, 100, 101, 93.75, 94)], 0, 100, -1, 6, 8, "pessimistic", fb);
    assert(w.outcome === "win" && w.exitPrice === 94, "Short pessimistic target 94 needs 93.75 → filled at 94");
    w = ss.walkBracket([], 0, 100, 1, 6, 8, "standard", { price: 101.5, ts: 777 });
    assert(w.outcome === "flat" && w.exitPrice === 101.5 && w.exitTs === 777, "nothing to walk → flat at the fallback (entry in the last bar)");
  }

  // ───────────────────────────── S1: ORB-30 ─────────────────────────────
  console.log("── S1 ORB-30 ──");
  const D1 = "2026-07-15";
  const d1Bars = buildDay(D1, [["09:30", 100], ["10:11", 106.25], ["11:01", 93.75], ["11:45", 108], ["12:30", 100]], {
    "09:45": [100, 105, 100, 100],
    "09:50": [100, 100, 95, 100],
    "10:00": [100, 104, 96, 100],
    "10:05": [100, 106, 100, 105],     // close == range high → NOT a breakout
    "10:10": [100, 106.5, 100, 106],   // first close above 105 → Long
    "11:00": [106.25, 106.25, 94, 94], // first close below 95 → Short
  });
  {
    const sim = ss.simulateSession(D1, d1Bars, null);
    assert(sim.orb?.high === 105 && sim.orb?.low === 95 && sim.orb?.bars === 30, "range = high/low of the 30 bars 09:30–09:59 (105 / 95)");
    const s1 = pick(sim.trades, { strategy: "S1" });
    assert(s1.length === 2 * 3 * 3, `exactly one Long + one Short × 3 cells × 3 fill models (${s1.length})`);
    const L = pick(s1, { direction: "Long", cell: "6/8" }), S = pick(s1, { direction: "Short", cell: "6/8" });
    assert(L.length === 3 && L.every(r => r.signalTs === T(D1, "10:10")), "Long signal = the first CLOSE beyond the high (10:10), not the 10:05 wick/equal close");
    assert(S.length === 3 && S.every(r => r.signalTs === T(D1, "11:00")), "Short signal = 11:00; later closes beyond (11:01..) never fire a second Short");
    const e = (rows: TradeRow[], m: string) => rows.find(r => r.fillModel === m)!;
    assert(e(L, "optimistic").entryPrice === 106 && e(L, "optimistic").entryTs === T(D1, "10:11"), "optimistic entry = the signal bar's close (at its close time)");
    assert(e(L, "standard").entryPrice === 106.25 && e(L, "standard").entryTs === T(D1, "10:11"), "standard entry = next bar's open");
    assert(e(L, "pessimistic").entryPrice === 106.5, "pessimistic Long = next open + 1 tick");
    assert(e(S, "pessimistic").entryPrice === 93.5 && e(S, "standard").entryPrice === 93.75 && e(S, "optimistic").entryPrice === 94, "Short entries: opt 94 (close) / std 93.75 (open) / pess 93.5 (1 tick against)");
    assert(e(L, "standard").level === 105 && e(S, "standard").level === 95, "level = the range edge broken");
    // Short std 93.75, TP 6 → 87.75, SL 8 → 101.75; 11:45 price 108 → stop
    assert(e(S, "standard").outcome === "loss" && e(S, "standard").exitPrice === 101.75 && e(S, "standard").points === -8, "Short stopped on the 11:45 jump to 108 (−8 gross)");
    // Long std 106.25: 11:00 bar low 94 ≤ 98.25 → stop
    assert(e(L, "standard").outcome === "loss" && e(L, "standard").exitTs === T(D1, "11:01"), "Long stopped in the 11:00 bar (exit stamped at its close)");
  }
  {
    // Range boundary: a pre-09:30 bar and the 10:00 bar never enter the range.
    const D2 = "2026-07-16";
    const bars = buildDay(D2, [["09:30", 100]], { "09:40": [100, 101, 100, 100], "09:41": [100, 100, 99, 100], "10:00": [100, 103, 100, 100], "10:30": [100, 102, 100, 102] });
    bars.unshift({ time: T(D2, "09:29"), open: 100, high: 300, low: 1, close: 100 });
    const s1 = pick(ss.simulateSession(D2, bars, null).trades, { strategy: "S1", cell: "6/8", fillModel: "standard" });
    assert(s1.length === 1 && s1[0].direction === "Long" && s1[0].signalTs === T(D2, "10:30"), "09:29 and 10:00 bars are outside the range (close 102 > 101 fires at 10:30)");
  }
  {
    const D3 = "2026-07-17";
    const at12 = buildDay(D3, [["09:30", 100], ["12:01", 103]], { "09:40": [100, 101, 99, 100], "12:00": [100, 103, 100, 103] });
    assert(pick(ss.simulateSession(D3, at12, null).trades, { strategy: "S1" }).length === 0, "noon cutoff: a first breakout on the 12:00 bar never fires");
    const at1159 = buildDay(D3, [["09:30", 100], ["12:00", 103]], { "09:40": [100, 101, 99, 100], "11:59": [100, 103, 100, 103] });
    const r = pick(ss.simulateSession(D3, at1159, null).trades, { strategy: "S1", cell: "6/8", fillModel: "standard" });
    assert(r.length === 1 && r[0].signalTs === T(D3, "11:59") && r[0].entryTs === T(D3, "12:00"), "the 11:59 bar still fires (entry 12:00 open)");
  }
  {
    const D4 = "2026-07-20";
    const holed = buildDay(D4, [["09:30", 100], ["10:30", 110]], {}, { from: "09:40" });
    const sim = ss.simulateSession(D4, holed, null);
    assert(sim.trades.length === 0 && sim.notes.some(n => n.includes("opening range incomplete")),
      "incomplete opening range (20/30 bars) → no S1 rows (and nothing else without a box), noted");
  }
  {
    // EST day from RAW UTC stamps: a decoy at 13:30Z (08:30 ET) must not enter the range.
    const D5 = "2026-11-10";
    const open = Date.UTC(2026, 10, 10, 14, 30) / 1000;
    const bars: Bar[] = [{ time: Date.UTC(2026, 10, 10, 13, 30) / 1000, open: 100, high: 999, low: 100, close: 100 }];
    for (let i = 0; i < 7 * 60 + 25; i++) {
      const t = open + 60 * i;
      const p = i < 30 ? 100 : i === 40 ? 102 : 100;
      bars.push({ time: t, open: p, high: i === 10 ? 101 : p, low: i === 11 ? 99 : p, close: p });
    }
    const r = pick(ss.simulateSession(D5, bars, null).trades, { strategy: "S1", cell: "6/8", fillModel: "standard" });
    assert(r.length === 1 && r[0].direction === "Long" && r[0].signalTs === open + 40 * 60, "EST day: range starts 14:30Z (a UTC-offset bug would include the 999 decoy and fire nothing)");
    const last = bars.filter(b => b.time < Date.UTC(2026, 10, 10, 21, 55) / 1000).pop()!;
    assert(r[0].outcome === "flat" && r[0].exitTs === Date.UTC(2026, 10, 10, 21, 55) / 1000 && r[0].exitPrice === last.close, "EST 16:55 flat = 21:55Z at the 16:54 bar's close");
  }
  {
    // 16:55 flat: a 16:55+ spike is never walked.
    const D6 = "2026-07-21";
    const bars = buildDay(D6, [["09:30", 100], ["10:11", 101.5], ["16:00", 102]], { "09:40": [100, 101, 99, 100], "10:10": [100, 101.25, 100, 101.25], "16:54": [102, 102.5, 102, 102.5], "16:55": [102.5, 140, 60, 102.5] });
    const r = pick(ss.simulateSession(D6, bars, null).trades, { strategy: "S1", cell: "6/8" });
    assert(r.length === 3 && r.every(x => x.outcome === "flat" && x.exitTs === T(D6, "16:55") && x.exitPrice === 102.5), "16:55 flat at the 16:54 bar's close; the 16:55 bar (TP and SL spike) is never read");
    assert(r.find(x => x.fillModel === "standard")!.points === 1 && r.find(x => x.fillModel === "standard")!.minutesHeld === Math.round((T(D6, "16:55") - T(D6, "10:11")) / 60), "flat points = close − entry (gross); minutes held");
  }

  // ───────────────────────────── S2: yellow-box edge fade ─────────────────────────────
  console.log("── S2 yellow-box limit fade ──");
  const Z = { top: 110, bottom: 90 };
  const D7 = "2026-07-22";
  const d7Bars = buildDay(D7, [["09:30", 100], ["10:03", 100]], {
    "10:00": [107, 108.5, 107, 108],      // high within 2 of 110, close inside → arms 10:01
    "10:01": [108, 110, 107.75, 109],     // exact touch of 110
    "10:02": [109, 110.25, 108.5, 109],   // 1-tick trade-through
  });
  {
    const sim = ss.simulateSession(D7, d7Bars, Z);
    const lim = pick(sim.trades, { strategy: "S2", variant: "limit", cell: "6/8" });
    const by = (m: string) => lim.filter(r => r.fillModel === m);
    assert(by("optimistic").length === 1 && by("optimistic")[0].signalTs === T(D7, "10:01") && by("optimistic")[0].entryPrice === 110, "optimistic: a TOUCH of the edge fills at the level (10:01)");
    assert(by("standard").length === 1 && by("standard")[0].signalTs === T(D7, "10:02") && by("standard")[0].entryPrice === 110, "standard: needs a 1-tick trade-through → fills at 110 on 10:02, not the 10:01 touch");
    assert(by("pessimistic").length === 1 && by("pessimistic")[0].signalTs === T(D7, "10:02") && by("pessimistic")[0].entryPrice === 109.75, "pessimistic: trade-through AND 1 tick worse (Short 109.75)");
    assert(lim.every(r => r.direction === "Short" && r.level === 110), "top edge = Short");
    assert(by("standard")[0].outcome === "win" && by("standard")[0].exitPrice === 104 && by("standard")[0].points === 6, "walk starts the bar AFTER the fill (10:03 at 100 → TP 104)");
    assert(by("optimistic")[0].entryTs === T(D7, "10:01"), "limit entry_ts = the fill bar");
    const cls = pick(sim.trades, { strategy: "S2", variant: "close", cell: "6/8", fillModel: "standard" });
    assert(cls.length === 1 && cls[0].signalTs === T(D7, "10:02") && cls[0].entryPrice === 100 && cls[0].entryTs === T(D7, "10:03"),
      "close variant: the 10:01 exact TOUCH is not a wick through; 10:02 (110.25 through, close back inside) → next open (100)");
    assert(pick(sim.trades, { strategy: "S2", direction: "Long" }).length === 0, "no Long without the bottom edge in reach");
    const offGrid = ss.simulateSession(D7, d7Bars, { top: 109.9, bottom: 90.12 });
    assert(offGrid.zone?.top === 110 && offGrid.zone?.bottom === 90 && JSON.stringify(offGrid.trades) === JSON.stringify(sim.trades),
      "an off-grid box (109.9 / 90.12) is snapped to the nearest tick (110 / 90) — limits rest at tick prices only");
  }
  {
    // Not armed (prev high 107.75 < 108): the touch bar fills nothing; a later armed bar does.
    const D8 = "2026-07-23";
    const bars = buildDay(D8, [["09:30", 100]], {
      "10:00": [107.5, 107.75, 107.5, 107.5],
      "10:01": [107.5, 110.5, 107.5, 108],
    });
    const sim = ss.simulateSession(D8, bars, Z);
    const at1001 = sim.trades.filter(r => r.strategy === "S2" && r.variant === "limit" && r.signalTs === T(D8, "10:01"));
    assert(at1001.length === 0, "limit NOT armed when the previous bar was > 2 pts from the edge → no fill on the 10:01 trade-through");
    assert(pick(sim.trades, { strategy: "S2", variant: "close", fillModel: "standard", cell: "6/8" }).length === 1, "…while the bar-close variant still records the 10:01 wick-and-close-back");
    // Price above the edge: not armed (a sell limit below the market is not a resting fade).
    const bars2 = buildDay(D8, [["09:30", 100], ["10:00", 111]], { "10:01": [111, 112, 110.5, 111] });
    assert(pick(ss.simulateSession(D8, bars2, Z).trades, { strategy: "S2", variant: "limit", direction: "Short" }).length === 0, "previous close above the top edge → never armed");
  }
  {
    // Fill-bar stop + one open per direction + re-arm after exit; bottom edge Long.
    const D9 = "2026-07-24";
    const bars = buildDay(D9, [["09:30", 100], ["13:00", 92], ["15:10", 100]], {
      "13:01": [92, 92.5, 89.75, 91],        // Long fill at 90 (armed by 13:00 at 92)
      "13:02": [91, 91.5, 90.5, 91],         // still within reach but the Long is open → no 2nd fill
      "13:03": [91, 91.5, 89.5, 91],         // trade-through again while open → no 2nd fill
      "13:10": [92, 96.25, 92, 92],          // TP 96 (std) / 96.25 → pess TP 96.25 needs 96.5: not yet
      "13:11": [92, 92, 92, 92],
      "13:20": [92, 92, 89.5, 91],           // re-armed after the std/opt exit → 2nd Long fills (std/opt)
    });
    const sim = ss.simulateSession(D9, bars, Z);
    const std = pick(sim.trades, { strategy: "S2", variant: "limit", cell: "6/8", fillModel: "standard", direction: "Long" });
    assert(std.length >= 2 && std[0].signalTs === T(D9, "13:01") && std[0].entryPrice === 90 && std[0].outcome === "win" && std[0].exitTs === T(D9, "13:11"),
      "bottom edge Long fills at 90, wins at 96 on 13:10");
    assert(!std.some(r => r.signalTs === T(D9, "13:02") || r.signalTs === T(D9, "13:03")), "one open trade per direction: no second Long while the first is open");
    assert(std[1].signalTs === T(D9, "13:20"), "re-armed after the exit → the 13:20 trade-through fills a new Long");
    const pess = pick(sim.trades, { strategy: "S2", variant: "limit", cell: "6/8", fillModel: "pessimistic", direction: "Long" });
    assert(pess.length === 1 && pess[0].entryPrice === 90.25 && pess[0].tpPrice === 96.25 && pess[0].outcome === "win" && pess[0].exitTs === T(D9, "15:11"),
      "pessimistic Long fills 1 tick worse (90.25); the 13:10 touch of 96.25 is not a fill — the 15:10 trade-through is");
    // Fill-bar stop
    const D10 = "2026-07-27";
    const b10 = buildDay(D10, [["09:30", 100], ["15:01", 118], ["15:10", 100]], {
      "15:00": [108, 108.5, 108, 108.5],
      "15:01": [108.5, 118.5, 108.5, 118],
    });
    const fbs = pick(ss.simulateSession(D10, b10, Z).trades, { strategy: "S2", variant: "limit", cell: "6/8", direction: "Short" });
    const fm = (m: string) => fbs.find(r => r.fillModel === m)!;
    assert(fbs.length === 3 && fbs.every(r => r.signalTs === T(D10, "15:01") && r.outcome === "loss" && r.exitTs === T(D10, "15:02")), "a stop reached INSIDE the fill bar (high 118.5) is a loss in that bar, every model");
    assert(fm("standard").points === -8 && fm("pessimistic").points === -8.25 && fm("pessimistic").exitPrice === 118, "fill-bar stop: std −8; pess entry 109.75, stop 117.75 → fills 118 (−8.25)");
  }

  // ───────────────────────────── N: no random-entry control ─────────────────────────────
  console.log("── N  no random-entry control (owner decision 2026-10-07) ──");
  {
    const sims = [ss.simulateSession(D7, d7Bars, Z), ss.simulateSession(D1, d1Bars, Z), ss.simulateSession(D1, d1Bars, null)];
    const all = sims.flatMap(x => x.trades);
    assert(all.length > 0 && all.every(r => r.strategy === "S1" || r.strategy === "S2"), `simulation produces only S1 / S2 rows (${new Set(all.map(r => r.strategy)).size} strategies over ${all.length} rows)`);
    assert(all.every(r => r.variant === "orb30" || r.variant === "limit" || r.variant === "close") && all.every(r => r.seq === 0), "no 'random' variant and no draw index (seq always 0)");
    const d7 = sims[0].trades;
    assert(d7.length === pick(d7, { strategy: "S1" }).length + pick(d7, { strategy: "S2" }).length, "every D7 row is a strategy row (no control rows next to them)");
    assert((ss as any).NULL_PER_SESSION === undefined && (ss as any).seededRng === undefined && (ss as any).welchZ === undefined && (ss as any).normalUpperP === undefined,
      "the control generator (NULL_PER_SESSION, seededRng) and its Welch z / p are gone from the module");
    assert(!("eligibleMinutes" in sims[0]), "no control eligible-minute bookkeeping on the simulation result");
  }

  // ───────────────────────────── D: DB ─────────────────────────────
  console.log("── D  DB recorder ──");
  const zoneFor = (_k: string) => Z;
  const rowsOf = (day: string) => client.prepare(`SELECT * FROM shadow_scalps WHERE day_key=? ORDER BY strategy, variant, direction, signal_ts, seq, cell, fill_model`).all(day) as any[];
  const strip = (rs: any[]) => JSON.stringify(rs.map(({ id, run_at, ...rest }) => rest));
  const AFTER = (day: string) => ss.sessionClock(day).close + 3600;
  {
    storeBars(d1Bars);
    storeBars(d7Bars);
    assert(ss.recordSession(D7, "live", { nowSec: ss.sessionClock(D7).close - 60, zoneFor }).skipped === "session-not-finished", "an unfinished session is refused");
    assert(ss.recordSession("2026-07-25", "live", { nowSec: AFTER("2026-07-25"), zoneFor }).skipped === "weekend", "a weekend day is refused");
    assert(ss.recordSession("2026-07-28", "live", { nowSec: AFTER("2026-07-28"), zoneFor }).skipped === "no-bars", "a weekday without bars records nothing");
    assert(ss.recordSession(D7, "live", { nowSec: AFTER(D7), zoneFor: () => { throw new Error("boom"); } }).notes.some(n => n.includes("day-zone source failed")) && rowsOf(D7).every(r => r.strategy !== "S2"),
      "a failing day-zone source → S1 still recorded, S2 skipped and noted");
    client.exec(`DELETE FROM shadow_scalps`);
    const r1 = ss.recordSession(D7, "backfill", { nowSec: AFTER(D7), zoneFor });
    const first = rowsOf(D7);
    assert(r1.rows > 0 && first.length === r1.rows && first.every(r => r.era === "backfill"), `recorded ${r1.rows} rows tagged era=backfill`);
    const sim = ss.simulateSession(D7, d7Bars, Z);
    assert(first.length === sim.trades.length, "DB rows == the pure simulation's trades");
    const r2 = ss.recordSession(D7, "live", { nowSec: AFTER(D7), zoneFor });
    const second = rowsOf(D7);
    assert(strip(second) === strip(first) && r2.era === "backfill", "idempotent re-run: identical rows replaced, and a backfilled day KEEPS era=backfill");
    // re-run after the data changed: the day's rows are REPLACED, never accumulated
    insBar.run(T(D7, "10:02"), 109, 109.5, 108.5, 109); // the trade-through bar loses its trade-through
    ss.recordSession(D7, "live", { nowSec: AFTER(D7), zoneFor });
    const third = rowsOf(D7);
    assert(!third.some(r => r.strategy === "S2" && r.variant === "limit" && r.fill_model === "standard" && r.signal_ts === T(D7, "10:02")) && third.length < first.length + 1,
      "re-run after a bar change replaces the day's rows (the 10:02 standard fill is gone)");
    insBar.run(T(D7, "10:02"), 109, 110.25, 108.5, 109);
    const r3 = ss.recordSession(D1, "live", { nowSec: AFTER(D1), zoneFor: () => null });
    assert(r3.era === "live" && rowsOf(D1).every(r => r.era === "live") && r3.notes.includes("S2: no day yellow box"), "a new day tagged era=live; no box → no S2, noted");
    // forming-bar guard: a bar whose close is after nowSec is not read
    const unique = client.prepare(`SELECT COUNT(*) n FROM (SELECT DISTINCT symbol, day_key, strategy, variant, direction, signal_ts, seq, cell, fill_model FROM shadow_scalps)`).get() as { n: number };
    const total = client.prepare(`SELECT COUNT(*) n FROM shadow_scalps`).get() as { n: number };
    assert(unique.n === total.n, "natural key unique across all rows");
  }
  {
    // Roll-jump guard: a ≥ 30-pt open-vs-prev-close jump → the session is not recorded (rows removed).
    const DJ = "2026-07-29";
    storeBars(buildDay(DJ, [["09:30", 100], ["11:31", 167.25]], { "09:40": [100, 101, 99, 100] }));
    const r = ss.recordSession(DJ, "live", { nowSec: AFTER(DJ), zoneFor });
    assert(r.rows === 0 && r.skipped === "roll-jump" && rowsOf(DJ).length === 0 && r.notes.some(n => n.startsWith("roll-jump")), "roll-jump session: skipped, 0 rows, noted");
  }
  {
    // Boot: empty table → backfill (era backfill); then catch-up of later sessions (era live).
    client.exec(`DELETE FROM shadow_scalps`);
    ss._resetShadowScalpsJobForTests();
    const now1 = AFTER("2026-07-24");
    const st = await ss.bootShadowScalps(now1, { zoneFor });
    // bars exist for 07-15 (D1), 07-22 (D7) — 07-29 is in the future at now1
    assert(st.trigger === "boot-backfill" && st.era === "backfill" && JSON.stringify(st.days) === JSON.stringify([D1, D7]), `boot on an empty table backfills the finished sessions with bars (${st.days.join(",")})`);
    assert((client.prepare(`SELECT COUNT(DISTINCT era) n, MIN(era) e FROM shadow_scalps`).get() as any).e === "backfill", "every backfill row is era=backfill");
    assert(st.maxChunkMs < 200, `per-session chunk well under 200 ms (${st.maxChunkMs} ms)`);
    const D11 = "2026-07-30";
    storeBars(buildDay(D11, [["09:30", 100]], { "09:40": [100, 101, 99, 100], "10:30": [100, 102, 100, 102] }));
    ss._resetShadowScalpsJobForTests();
    const st2 = await ss.bootShadowScalps(AFTER(D11), { zoneFor });
    assert(st2.trigger === "boot-catchup" && st2.era === "live" && JSON.stringify(st2.days) === JSON.stringify(["2026-07-29", D11].filter(k => k === D11)) && st2.skipped.some(s => s.dayKey === "2026-07-29"),
      "boot with rows → catch-up of the sessions after the newest recorded day only, era=live (the roll-jump day skipped)");
    assert(rowsOf(D11).every(r => r.era === "live") && rowsOf(D7).every(r => r.era === "backfill"), "catch-up rows live, backfill rows untouched");
  }
  {
    // Nightly slot via the scheduler tick.
    ss._resetShadowScalpsJobForTests();
    const D12 = "2026-07-31"; // Friday
    storeBars(buildDay(D12, [["09:30", 100]], { "09:40": [100, 101, 99, 100], "10:30": [100, 100, 98, 98] }));
    const nowBoot = T(D12, "16:00");
    assert(ss.shadowScalpsTick({ dateKey: D12, mins: 16 * 60 }, nowBoot, { zoneFor }) === "boot", "first tick = the boot run");
    while (ss.shadowScalpsRunning()) await new Promise(r => setImmediate(r));
    assert(ss.shadowScalpsTick({ dateKey: D12, mins: 17 * 60 + 29 }, T(D12, "17:29"), { zoneFor }) === null, "17:29 ET: not yet");
    assert(ss.shadowScalpsTick({ dateKey: D12, mins: 17 * 60 + 30 }, T(D12, "17:30"), { zoneFor }) === "nightly", "17:30 ET weekday: the nightly run fires");
    while (ss.shadowScalpsRunning()) await new Promise(r => setImmediate(r));
    assert(ss.shadowScalpsLastRun()?.trigger === "nightly" && rowsOf(D12).length > 0 && rowsOf(D12).every(r => r.era === "live"), "nightly recorded the finished session as era=live");
    assert(ss.shadowScalpsTick({ dateKey: D12, mins: 17 * 60 + 45 }, T(D12, "17:45")) === null, "once per ET date");
    assert(ss.shadowScalpsTick({ dateKey: "2026-08-01", mins: 18 * 60 }, T("2026-08-01", "18:00")) === null, "never on a Saturday");
  }
  {
    // LEGACY CONTROL PURGE (owner decision 2026-10-07): rows recorded before the decision are removed
    // once at boot — chunked, idempotent, logged once — and never read meanwhile.
    ss._resetShadowScalpsJobForTests();
    const legacyFrom = (day: string) => client.prepare(
      `INSERT INTO shadow_scalps (symbol, day_key, era, strategy, variant, direction, signal_ts, seq, cell, tp, sl, fill_model, level, entry_ts, entry_price,
         tp_price, sl_price, outcome, exit_ts, exit_price, points, minutes_held, run_at, zone_state, zone_top, zone_bottom)
       SELECT symbol, day_key, era, 'null-' || strategy, 'random', direction, signal_ts, id, cell, tp, sl, fill_model, NULL, entry_ts, entry_price,
         tp_price, sl_price, outcome, exit_ts, exit_price, points + 50, minutes_held, run_at, zone_state, zone_top, zone_bottom
         FROM shadow_scalps WHERE day_key=? AND strategy IN ('S1','S2')`).run(day).changes;
    const strategyRowsBefore = strip(client.prepare(`SELECT * FROM shadow_scalps WHERE strategy IN ('S1','S2') ORDER BY id`).all() as any[]);
    const planted = legacyFrom(D7) + legacyFrom("2026-07-30");
    const nullCount = () => (client.prepare(`SELECT COUNT(*) n FROM shadow_scalps WHERE strategy LIKE 'null-%'`).get() as { n: number }).n;
    assert(planted > 20 && nullCount() === planted, `planted ${planted} legacy null-S1 / null-S2 rows`);
    // Before the purge: every read path ignores them.
    assert(ss.readRows().every(r => r.strategy === "S1" || r.strategy === "S2") && ss.readRows().length === (client.prepare(`SELECT COUNT(*) n FROM shadow_scalps WHERE strategy IN ('S1','S2')`).get() as any).n,
      "readRows (route + digest source) filters legacy control rows out in SQL");
    const pagedPre = await ss.readRowsPaged({}, undefined, 50);
    assert(pagedPre.every(r => r.strategy === "S1" || r.strategy === "S2"), "readRowsPaged filters them too");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => { logs.push(a.join(" ")); };
    let pr: { deleted: number; maxChunkMs: number };
    try { pr = await ss.purgeLegacyNullRows(7); }
    finally { console.log = origLog; }
    assert(pr.deleted === planted && nullCount() === 0, `purge removes every legacy row across ${Math.ceil(planted / 7)} chunked statements (${pr.deleted})`);
    assert(logs.filter(l => l.includes("legacy random-control rows")).length === 1 && logs.some(l => l.includes(`removed ${planted} legacy`)), "logged exactly once, with the count");
    assert(strip(client.prepare(`SELECT * FROM shadow_scalps WHERE strategy IN ('S1','S2') ORDER BY id`).all() as any[]) === strategyRowsBefore, "S1 / S2 rows untouched by the purge");
    // Through the boot path: plant again, boot → purged before the catch-up; a second boot is a silent no-op.
    const planted2 = legacyFrom(D7);
    logs.length = 0;
    console.log = (...a: any[]) => { logs.push(a.join(" ")); };
    try {
      await ss.bootShadowScalps(AFTER("2026-07-31"), { zoneFor });
      assert(nullCount() === 0 && logs.filter(l => l.includes("legacy random-control rows")).length === 1 && logs.some(l => l.includes(`removed ${planted2} legacy`)),
        "bootShadowScalps purges the legacy rows first (one log line)");
      logs.length = 0;
      ss._resetShadowScalpsJobForTests();
      await ss.bootShadowScalps(AFTER("2026-07-31"), { zoneFor });
      assert(nullCount() === 0 && !logs.some(l => l.includes("legacy random-control rows")), "idempotent: a boot with no legacy rows deletes nothing and logs nothing");
    } finally { console.log = origLog; }
    assert(!ss.shadowScalpsRunning(), "the purge releases the running flag");
    assert(client.prepare(`SELECT COUNT(*) n FROM shadow_scalps WHERE strategy NOT IN ('S1','S2')`).get() && (client.prepare(`SELECT COUNT(*) n FROM shadow_scalps WHERE strategy NOT IN ('S1','S2')`).get() as any).n === 0,
      "the table holds only S1 / S2 rows afterwards");
  }
  // Day-zone source: FROZEN CACHE ONLY (verifier 2026-10-06: the old no-write wrapper let the yellowbox
  // cold path — 130 d of 5m+60m bars + 45-day profiles, 330–670 ms on the live data — run on every
  // uncached day). Days before any mwml figure have an empty eligible set → import hash = FNV-1a("") =
  // 811c9dc5, so a hand-written row is a valid frozen row for 2015 keys.
  const ybCount = () => (client.prepare(`SELECT COUNT(*) n FROM yellowbox_day_zones`).get() as { n: number }).n;
  const freeze = (k: string, top: number | null, bottom: number | null, o: { ver?: number; hash?: string; traded?: number } = {}) => {
    const c = ss.sessionClock(k);
    client.prepare(`INSERT OR REPLACE INTO yellowbox_day_zones (symbol, day_key, traded, session_start, session_end, settle, box_top, box_bottom, ver, bands, import_hash)
      VALUES ('MES', ?, ?, ?, ?, 2000, ?, ?, ?, '[]', ?)`).run(k, o.traded ?? 1, c.rthOpen - 15.5 * 3600, c.close, top, bottom, o.ver ?? YB_CACHE_VER, o.hash ?? "811c9dc5");
  };
  /** Every SQL text that actually reached the DB handle while fn ran. */
  const sqlSeen = <R>(fn: () => R): { out: R; sql: string[] } => {
    const orig = client.prepare.bind(client); const sql: string[] = [];
    (client as any).prepare = (s: string) => { sql.push(s.replace(/\s+/g, " ").trim()); return orig(s); };
    try { return { out: fn(), sql }; } finally { (client as any).prepare = orig; }
  };
  const coldLoad = (sql: string[]) => sql.some(s => /FROM cached_candles/i.test(s) && !/LIMIT 1$/i.test(s) && /resolution=\?/i.test(s));
  {
    const wrapped = ss.cacheOnlySqlite(client as any);
    let threw = "";
    try { wrapped.prepare(`INSERT INTO yellowbox_day_zones (symbol, day_key, traded, ver) VALUES ('MES','2015-01-01',1,1)`).run(); } catch (e: any) { threw = e?.name ?? ""; }
    assert(threw === "ColdZoneCacheError" && ybCount() === 0, "cacheOnlySqlite: an INSERT is refused at prepare (nothing written)");
    threw = "";
    try { wrapped.prepare(`SELECT timestamp t, open o, high h, low l, close c, volume v
       FROM cached_candles
      WHERE symbol=? AND resolution=? AND timestamp>=? AND timestamp<=?
      ORDER BY timestamp`); } catch (e: any) { threw = e?.name ?? ""; }
    assert(threw === "ColdZoneCacheError", "cacheOnlySqlite: the cold path's unbounded bar load (yellowbox.ts loadBars SQL) is refused");
    const ok = wrapped.prepare(`SELECT 1 FROM cached_candles WHERE symbol=? AND resolution IN ('1','5') AND timestamp>=? AND timestamp<=? LIMIT 1`);
    threw = "";
    try { ok.run(); } catch (e: any) { threw = e?.name ?? ""; }
    assert(typeof ok.get === "function" && threw === "ColdZoneCacheError", "cacheOnlySqlite: the warm path's LIMIT-1 probe is allowed; .run() on anything throws");

    const NOW = Math.floor(Date.now() / 1000);
    const K = "2015-01-06";
    freeze(K, 2010.5, 1990.25);
    const warm = sqlSeen(() => ss.serverDayZone(K, NOW));
    assert(warm.out.state === "cached" && warm.out.zone?.top === 2010.5 && warm.out.zone?.bottom === 1990.25,
      "serverDayZone: a frozen current row → state cached, the raw box getYellowboxDayZones serves");
    assert(!coldLoad(warm.sql), "…and the warm read loads no 5m/60m bars");
    const before = ybCount();
    const none = sqlSeen(() => ss.serverDayZone("2015-01-07", NOW));
    assert(none.out.state === "pending" && none.out.zone === null && ybCount() === before && !none.sql.some(s => /yellowbox_day_zones/.test(s) && /^SELECT \*/.test(s)),
      "no cache row → pending WITHOUT calling the source (one primary-key read), nothing written");
    freeze("2015-01-08", 2010, 1990, { ver: YB_CACHE_VER - 1 });
    assert(ss.serverDayZone("2015-01-08", NOW).state === "pending", "a row from an older YB_CACHE_VER → pending (a version bump never triggers the cold derivation here)");
    freeze("2015-01-09", 2010, 1990, { hash: "deadbeef" });
    const stale = sqlSeen(() => ss.serverDayZone("2015-01-09", NOW));
    const row9 = client.prepare(`SELECT import_hash h, box_top t FROM yellowbox_day_zones WHERE day_key='2015-01-09'`).get() as { h: string; t: number };
    assert(stale.out.state === "pending" && !coldLoad(stale.sql) && row9.h === "deadbeef" && row9.t === 2010,
      "a current-ver row with a STALE mwml import hash → the source's cold path is refused before any bar load → pending, row untouched");
    freeze("2015-01-12", null, null);
    assert(ss.serverDayZone("2015-01-12", NOW).state === "none", "a frozen day without a usable box → state none");
    client.exec(`DELETE FROM yellowbox_day_zones`);
  }
  const s2Day = (day: string, extra: Record<string, [number, number, number, number]> = {}, from?: string) => buildDay(day, [["09:30", 100], ["10:03", 100]], {
    "09:40": [100, 101, 99, 100],
    "10:00": [107, 108.5, 107, 108], "10:01": [108, 110, 107.75, 109], "10:02": [109, 110.25, 108.5, 109], ...extra,
  }, from ? { from } : {});
  const noZone = (rs: any[]) => JSON.stringify(rs.map(({ id, run_at, zone_state, zone_top, zone_bottom, ...rest }) => rest));
  {
    // DEFERRED S2, end to end through the REAL source (no zoneFor seam).
    ss._resetShadowScalpsJobForTests();
    const DK = "2015-01-13";
    storeBars(s2Day(DK));
    const cold = sqlSeen(() => ss.recordSession(DK, "backfill", { nowSec: AFTER(DK) }));
    const r1 = cold.out; const rows1 = rowsOf(DK);
    assert(r1.zoneState === "pending" && r1.rows > 0 && rows1.length === r1.rows && rows1.every(r => r.zone_state === "pending" && r.zone_top === null && r.zone_bottom === null)
      && rows1.every(r => r.strategy === "S1"),
      "box not frozen → S1 recorded now, S2 deferred, every row zone_state=pending (no control rows)");
    assert(!coldLoad(cold.sql) && ybCount() === 0 && r1.notes.some(n => n.startsWith("S2: deferred")) && !r1.notes.includes("S2: no day yellow box"),
      "…with no 5m/60m bar load (the cold derivation never runs) and no yellowbox cache write; noted as deferred");
    assert(ss.pendingS2Days().some(p => p.dayKey === DK && p.era === "backfill"), "pendingS2Days lists the day with its era");
    assert(!ss.retryCandidates().some(c => c.dayKey === DK), "retry pre-check: no frozen row at the current version → not a candidate (source not called)");
    freeze(DK, 109.9, 90.12);
    assert(ss.retryCandidates().some(c => c.dayKey === DK), "once a chart / the catch-up has frozen the box, the day becomes a retry candidate");
    const st = await ss.retryDeferred(AFTER(DK));
    const rows2 = rowsOf(DK);
    assert(st != null && st.trigger === "retry" && st.days.includes(DK) && st.s2Pending.length === 0, "the retry pass re-records the day");
    assert(rows2.every(r => r.zone_state === "cached" && r.zone_top === 109.9 && r.zone_bottom === 90.12 && r.era === "backfill"),
      "rows now zone_state=cached carrying the RAW frozen box (109.9 / 90.12); era kept");
    assert(rows2.some(r => r.strategy === "S2" && r.variant === "limit" && r.level === 110) && rows2.every(r => r.strategy === "S1" || r.strategy === "S2"),
      "S2 recorded from the frozen box (S2 level = the tick-snapped edge 110); no control rows");
    const s1 = (rs: any[]) => rs.filter(r => r.strategy === "S1");
    assert(noZone(s1(rows2)) === noZone(s1(rows1)), "S1 rows identical between the deferred and the completed run");
    assert(!ss.pendingS2Days().some(p => p.dayKey === DK) && !ss.retryCandidates(true).some(c => c.dayKey === DK), "nothing pending for the day afterwards");
    const rows3 = (ss.recordSession(DK, "live", { nowSec: AFTER(DK) }), rowsOf(DK));
    assert(strip(rows3) === strip(rows2), "idempotent: a re-run against the same frozen box replaces the day with identical rows");

    // A pending day with NO rows (incomplete opening range, box not frozen) is remembered in memory.
    const DZ = "2015-01-16";
    storeBars(s2Day(DZ, {}, "09:45"));
    const rz = ss.recordSession(DZ, "live", { nowSec: AFTER(DZ) });
    assert(rz.rows === 0 && rz.zoneState === "pending" && ss._retryMemForTests().some(m => m.dayKey === DZ && m.reason === "pending-no-rows"),
      "a pending day with zero rows is kept in the in-memory retry set");
    assert(!ss.retryCandidates().some(c => c.dayKey === DZ), "…not retried until its box is frozen");
    freeze(DZ, 110, 90);
    const stz = await ss.retryDeferred(AFTER(DZ));
    assert(stz != null && stz.days.includes(DZ) && rowsOf(DZ).some(r => r.strategy === "S2") && rowsOf(DZ).every(r => r.era === "live" && r.zone_state === "cached")
      && !ss._retryMemForTests().some(m => m.dayKey === DZ), "…then recorded (era from the memory entry) and dropped from the set");
    client.exec(`DELETE FROM yellowbox_day_zones`);
  }
  {
    // Retry cadence through the scheduler tick (zoneFor seam: pending first, frozen later).
    ss._resetShadowScalpsJobForTests();
    const DP = "2015-01-20";
    storeBars(s2Day(DP));
    let frozen = false;
    const zf = (_k: string) => (frozen ? Z : { state: "pending" as const, zone: null });
    const base = AFTER(DP);
    const et = { dateKey: DP, mins: 12 * 60 }; // midday: never the nightly slot
    assert(ss.shadowScalpsTick(et, base, { zoneFor: zf }) === "boot", "first tick = boot");
    while (ss.shadowScalpsRunning()) await new Promise(r => setImmediate(r));
    ss.recordSession(DP, "live", { nowSec: base, zoneFor: zf });
    assert(rowsOf(DP).every(r => r.zone_state === "pending"), "day recorded with S2 pending");
    frozen = true;
    assert(ss.shadowScalpsTick(et, base + ss.RETRY_EVERY_SEC - 1, { zoneFor: zf }) === null, "retry throttled: not before RETRY_EVERY_SEC since the last attempt");
    assert(ss.shadowScalpsTick(et, base + ss.RETRY_EVERY_SEC, { zoneFor: zf }) === "retry", "retry pass fires after RETRY_EVERY_SEC");
    while (ss.shadowScalpsRunning()) await new Promise(r => setImmediate(r));
    assert(rowsOf(DP).every(r => r.zone_state === "cached") && rowsOf(DP).some(r => r.strategy === "S2") && ss.shadowScalpsLastRun()?.trigger === "retry",
      "…and completes the deferred S2");
    assert(ss.shadowScalpsTick(et, base + 2 * ss.RETRY_EVERY_SEC, { zoneFor: zf }) === null, "nothing left to retry → no run");
  }
  {
    // ROBUSTNESS: a session that throws (SQLITE_BUSY past the busy_timeout) never aborts the run.
    ss._resetShadowScalpsJobForTests();
    const EA = "2015-01-21", EB = "2015-01-22";
    storeBars(s2Day(EA)); storeBars(s2Day(EB));
    const origTx = client.transaction.bind(client);
    let calls = 0; let failAll = false;
    (client as any).transaction = (fn: any) => { calls++; if (failAll || calls === 1) throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" }); return origTx(fn); };
    let st: Awaited<ReturnType<typeof ss.runSessions>>;
    try { st = await ss.runSessions([EA, EB], "live", "manual", { nowSec: AFTER(EB), zoneFor }); }
    finally { (client as any).transaction = origTx; }
    assert(st.skipped.some(s => s.dayKey === EA && s.reason.startsWith("error: SQLITE_BUSY")) && st.days.includes(EB) && rowsOf(EB).length > 0 && rowsOf(EA).length === 0
      && (st.error ?? "").startsWith("1 session(s) failed"), "a throwing session is skipped as error, the next session is still recorded, the run reports it");
    assert(ss._retryMemForTests().some(m => m.dayKey === EA && m.attempts === 1 && m.reason.startsWith("error")), "…and the failed day is remembered for the retry pass");
    const st2 = await ss.retryDeferred(AFTER(EB), { zoneFor });
    assert(st2 != null && st2.days.includes(EA) && rowsOf(EA).length > 0 && !ss._retryMemForTests().some(m => m.dayKey === EA), "the retry pass records it and clears the entry");
    failAll = true;
    (client as any).transaction = (fn: any) => { if (failAll) throw new Error("SQLITE_BUSY: database is locked"); return origTx(fn); };
    try { for (let i = 0; i < ss.RETRY_MAX_ATTEMPTS; i++) await ss.runSessions([EA], "live", "manual", { nowSec: AFTER(EA), zoneFor }); }
    finally { (client as any).transaction = origTx; }
    assert(rowsOf(EA).length > 0, "a failed re-run rolls back — the day's previous rows survive");
    assert(ss._retryMemForTests().some(m => m.dayKey === EA && m.attempts === ss.RETRY_MAX_ATTEMPTS) && !ss.retryCandidates(true).some(c => c.dayKey === EA),
      `after ${ss.RETRY_MAX_ATTEMPTS} failures the day is no longer retried in this process`);
  }

  // ───────────────────────────── M: summary math ─────────────────────────────
  console.log("── M  summary math, kill / promotion ──");
  {
    let id = 0;
    const mk = (dayKey: string, points: number, o: Partial<SIR> = {}): SIR => ({
      id: ++id, dayKey, era: "live", strategy: "S1", variant: "orb30", cell: "6/8", fillModel: "pessimistic", entryTs: 1_000_000 + id * 60, points, ...o,
    });
    // stats: points 7, −9, 7, −1 (friction 1 → 6, −10, 6, −2) over days a,a,b,b
    const tr = [mk("2026-08-03", 7), mk("2026-08-03", -9), mk("2026-08-04", 7), mk("2026-08-04", -1)];
    const s = ss.computeStats(tr, 1.0, "2026-08-04");
    assert(s.n === 4 && s.wins === 2 && s.winPct === 50 && s.netPts === 0 && s.netPerTrade === 0, "n / wins / win % / net (net of friction)");
    assert(near(s.pf, 1) && s.maxDD === 10, "PF = 12/12 = 1; maxDD by trade sequence = 10 (6 → −4)");
    assert(s.halves.h1.n === 2 && s.halves.h1.netPerTrade === -2 && s.halves.h2.netPerTrade === 2, "halves split by session day (H1 −2/tr, H2 +2/tr)");
    assert(s.dropBest3NetPerTrade === null, "drop-best-3 with only 2 days → nothing left (null)");
    const s7 = ss.computeStats(tr, 0.7, "2026-08-04"), s15 = ss.computeStats(tr, 1.5, "2026-08-04");
    assert(s7.netPerTrade === 0.3 && s15.netPerTrade === -0.5, "friction is applied at summary time (0.7 → +0.3, 1.5 → −0.5 per trade)");

    // KILL: live n ≥ 100 and pessimistic 1.0 net < −0.3 — backfill rows never count.
    const days = (n: number) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(2026, 7, 3) + i * 86400000); return d.toISOString().slice(0, 10); });
    const dk = days(150);
    const killSet = (n: number, pts: number, era: "live" | "backfill" = "live") => Array.from({ length: n }, (_, i) => mk(dk[i % dk.length], pts, { era }));
    let dec = ss.computeDecisions(killSet(100, 0.5)); // net −0.5
    const d68 = (d: typeof dec) => d.find(x => x.strategy === "S1" && x.variant === "orb30" && x.cell === "6/8")!;
    assert(d68(dec).kill && d68(dec).verdict === "KILL" && d68(dec).liveN === 100, "kill at live n = 100 with net −0.5");
    dec = ss.computeDecisions(killSet(99, 0.5));
    assert(!d68(dec).kill && d68(dec).verdict === "KEEP", "n = 99 → not yet");
    dec = ss.computeDecisions(killSet(100, 0.7));
    assert(!d68(dec).kill, "net exactly −0.3 is not below −0.3 → KEEP");
    dec = ss.computeDecisions([...killSet(100, 0.5, "backfill"), ...killSet(10, 0.5)]);
    assert(!d68(dec).kill && d68(dec).liveN === 10, "backfill rows never count toward the kill rule");
    dec = ss.computeDecisions(killSet(100, 0.5).map(r => ({ ...r, fillModel: "standard" as const })));
    assert(d68(dec).liveN === 0 && !d68(dec).kill, "the rules read pessimistic fills only");

    // PROMOTION (owner decision 2026-10-07 — no random-entry control): n ≥ 300, net ≥ +0.3 (pess 1.0),
    // both halves > 0, net > 0 without the best 3 session days. Nothing else.
    const promo = (pointsAt: (i: number) => number) => Array.from({ length: 300 }, (_, i) => mk(dk[Math.floor(i / 2)], pointsAt(i)));
    const good = promo(i => (i % 4 === 3 ? -8 : 6)); // 75 % at +6 gross, 25 % at −8 → gross +2.5, net +1.5
    dec = ss.computeDecisions(good);
    let p = d68(dec).promotion;
    assert(p.nOk && p.netOk && p.halvesOk && p.dropBest3Ok && p.all, `strategy rows alone meet the bar — no control needed (net ${d68(dec).netPerTrade})`);
    assert(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["all", "dropBest3Ok", "halvesOk", "nOk", "netOk"]), `promotion checks are exactly n / net / halves / drop-best-3 (+ all): ${Object.keys(p).join(",")}`);
    assert(["nullNetPerTrade", "z", "p"].every(k => !(k in d68(dec))), "decisions carry no null net / z / p");
    assert(!("promoteAlpha" in ss.RULES), "RULES has no control alpha");
    // Legacy control rows handed to the pure API change nothing (they used to gate beatsNull).
    const legacyNulls = Array.from({ length: 300 }, (_, i) => mk(dk[Math.floor(i / 2)], 9, { strategy: "null-S1" as any, variant: "random" as any }));
    dec = ss.computeDecisions([...good, ...legacyNulls]);
    assert(d68(dec).promotion.all && d68(dec).liveN === 300 && d68(dec).netPerTrade === 1.5, "legacy control rows (even ones 'better' than the strategy) neither block nor count");
    dec = ss.computeDecisions(good.slice(0, 299));
    assert(!d68(dec).promotion.nOk && !d68(dec).promotion.all, "n = 299 → not promotable");
    // Net threshold at the edge: gross 1.3 → net +0.3 exactly passes; 1.29 → +0.29 fails.
    const flat = (g: number) => promo(i => g + (i % 2 ? 10 : -10));
    dec = ss.computeDecisions(flat(1.3));
    p = d68(dec).promotion;
    assert(p.netOk && p.halvesOk && p.dropBest3Ok && p.all, `net exactly +0.30/trade passes (${d68(dec).netPerTrade})`);
    dec = ss.computeDecisions(flat(1.29));
    assert(!d68(dec).promotion.netOk && !d68(dec).promotion.all, `net +0.29/trade fails (${d68(dec).netPerTrade})`);
    const firstHalfBad = promo(i => (i < 150 ? (i % 2 ? 6 : -8) : 6));
    dec = ss.computeDecisions(firstHalfBad);
    p = d68(dec).promotion;
    assert(p.netOk && !p.halvesOk && !p.all, "a negative first half fails the both-halves check");
    const carried = Array.from({ length: 300 }, (_, i) => mk(dk[Math.floor(i / 2)], i < 6 ? 400 : (i % 2 ? 6 : -8)));
    dec = ss.computeDecisions(carried);
    p = d68(dec).promotion;
    assert(p.netOk && !p.dropBest3Ok && !p.all, "carried by its best 3 days → fails drop-best-3");
    dec = ss.computeDecisions(good.map(r => ({ ...r, era: "backfill" as const })));
    assert(d68(dec).liveN === 0 && !d68(dec).promotion.all, "backfill rows can never satisfy the promotion bar");
    // Break-even arithmetic of the decision bracket (6/8, pessimistic stop 1 tick worse, 1.0 pt):
    // win +6 → +5 net, loss −8.25 → −9.25 net → break-even 9.25/14.25 = 64.9 % (64.3 % without the
    // slip). 64 % → −0.13/tr, 65 % → +0.0125 (> 0 but far below +0.3); the +0.3 bar needs ≥ 67.0 %.
    const wr = (wins: number) => Array.from({ length: 400 }, (_, i) => mk(dk[i % 150], i % 100 < wins ? 6 : -8.25));
    const be65 = d68(ss.computeDecisions(wr(65))), be64 = d68(ss.computeDecisions(wr(64))), be67 = d68(ss.computeDecisions(wr(67))), be68 = d68(ss.computeDecisions(wr(68)));
    assert(be64.netPerTrade === -0.13 && !be64.kill && be65.netPerTrade === 0.01 && !be65.promotion.netOk && be67.netPerTrade === 0.3 && !be67.promotion.netOk && be68.promotion.netOk,
      `6/8 break-even: 64 % → ${be64.netPerTrade}, 65 % → ${be65.netPerTrade}, 67 % → ${be67.netPerTrade} (0.2975 raw, below +0.3), 68 % → ${be68.netPerTrade}/tr (clears +0.3)`);

    // summarizeRows: era filter, friction table, kill flag on rows; legacy control rows ignored.
    const mixed = [...killSet(100, 0.5), ...killSet(5, 9, "backfill"), ...Array.from({ length: 20 }, (_, i) => mk(dk[i], 1, { strategy: "null-S1" as any, variant: "random" as any }))];
    const sumLive = ss.summarizeRows(mixed, { era: "live", friction: 1.0 });
    const row = sumLive.rows.find(r => r.strategy === "S1" && r.cell === "6/8" && r.fillModel === "pessimistic")!;
    assert(row.stats.n === 100 && row.netPerTradeByFriction["0.7"] === -0.2 && row.netPerTradeByFriction["1.0"] === -0.5 && row.netPerTradeByFriction["1.5"] === -1, "row: n live-only; net/trade at 0.7 / 1.0 / 1.5");
    assert(row.kill === true && ["nullNetPerTrade", "nullN", "minusNull", "z", "p"].every(k => !(k in row)), "row: kill flag; no null net / null n / strategy − null / z / p keys");
    const stdRow = sumLive.rows.find(r => r.strategy === "S1" && r.cell === "6/8" && r.fillModel === "standard");
    assert(row.promotion != null && row.promotion.nOk === false && row.promotion.all === false && stdRow === undefined,
      "row: promotion flags carried per strategy row");
    assert(sumLive.rows.every(r => r.strategy === "S1" || r.strategy === "S2") && sumLive.sessions.count === 100, "legacy control rows never become summary rows or add sessions");
    const promoRows = ss.summarizeRows([...good, ...good.map((r, i) => ({ ...r, id: 700000 + i, fillModel: "standard" as const }))], { era: "live", friction: 1.0 });
    const pr = promoRows.rows.filter(r => r.strategy === "S1" && r.cell === "6/8");
    assert(pr.length === 2 && pr.every(r => r.promotion?.all === true && r.kill === false), "row: a promoted cell flags promotion.all on every fill-model row of that cell");
    const sumAll = ss.summarizeRows(mixed, { era: "all", friction: 1.0 });
    assert(sumAll.rows.find(r => r.strategy === "S1" && r.cell === "6/8" && r.fillModel === "pessimistic")!.stats.n === 105 && sumAll.sessions.byEra.backfill === 5, "era=all includes backfill rows in the display");
    assert(d68(sumAll.decisions).liveN === 100, "…but the decisions stay live-only");

    // route parsing + digest line
    const pq = routes.parseShadowScalpsQuery;
    assert(JSON.stringify(pq({})) === JSON.stringify({ era: "live", friction: 1 }), "route defaults: era=live, friction=1.0");
    assert(JSON.stringify(pq({ era: "all", friction: "1.5" })) === JSON.stringify({ era: "all", friction: 1.5 }), "route: era=all friction=1.5");
    assert("error" in pq({ era: "backfill" }) && "error" in pq({ friction: "x" }) && "error" in pq({ friction: "-1" }), "route: bad era / friction → 400");
    const line = ss.shadowScalpsDigestLine(killSet(100, 0.5));
    assert(/^Shadow scalps: S1 live n=100\/300 net -0\.50\/tr \(pess, 1\.0\) \[KILL\]; S2 live n=0\/300 net —\/tr \(pess, 1\.0\) \[KEEP\]$/.test(line), `digest line format: "${line}"`);
    assert(ss.shadowScalpsDigestLine([]).startsWith("Shadow scalps: no rows yet"), "digest line with an empty table");
    assert(ss.shadowScalpsDigestLine(killSet(100, 0.5), 2).endsWith("[KEEP] (S2 box pending on 2 live days)"), "digest line flags live days whose S2 box is still pending");
    const promoLine = ss.shadowScalpsDigestLine(good);
    assert(promoLine.includes("PROMOTION BAR MET") && ![line, promoLine].some(l => /random|control|null|beats|p </i.test(l)), `digest line has no random / control wording ("${promoLine}")`);
    const body = await ss.shadowScalpsSummary({ era: "all", friction: 1.0 });
    assert(body.sessions.count > 0 && typeof body.lastRunAt === "string" && body.rows.length > 0 && body.decisions.length === 9, "DB summary: sessions covered, last run time, rows, 9 decisions (S1 + S2 limit + S2 close × 3 cells)");
    const bodyJson = JSON.stringify(body);
    assert(!/"(nullNetPerTrade|nullN|minusNull|z|p|beatsNullOk|promoteAlpha)":/.test(bodyJson) && !/null-S[12]|"random"/.test(bodyJson), "route body has no null / z / p / beats-null / alpha keys and no control rows");
    const dbRows = ss.readRows();
    const fresh = ss.summarizeRows(dbRows, { era: "all", friction: 1.0 });
    assert(JSON.stringify(body.rows) === JSON.stringify(fresh.rows) && JSON.stringify(body.decisions) === JSON.stringify(fresh.decisions), "DB summary == the pure summary over every stored row");
    const liveBody = await ss.shadowScalpsSummary({ era: "live", friction: 1.0 });
    const liveFresh = ss.summarizeRows(dbRows, { era: "live", friction: 1.0 });
    assert(JSON.stringify(liveBody.rows) === JSON.stringify(liveFresh.rows) && JSON.stringify(liveBody.decisions) === JSON.stringify(liveFresh.decisions)
      && JSON.stringify(liveBody.sessions) === JSON.stringify(liveFresh.sessions), "era=live reads only live rows in SQL yet gives the same body (incl. per-era day counts)");
    const zs = ss.zoneStateSummary();
    const distinctDays = (client.prepare(`SELECT COUNT(DISTINCT day_key) n FROM shadow_scalps`).get() as { n: number }).n;
    assert(body.zoneStates && zs.cached + zs.pending + zs.none === distinctDays && zs.pending === zs.pendingDays.length, "summary carries per-day zone states (cached / pending / none)");
    const digestRows = ss.readRows({ era: "live", fillModel: "pessimistic" });
    assert(digestRows.every(r => r.era === "live" && r.fillModel === "pessimistic") && ss.shadowScalpsDigestLine() === ss.shadowScalpsDigestLine(digestRows, ss.zoneStateSummary("live").pending),
      "the digest reads only live + pessimistic rows (same line as from those rows)");
    const again = await ss.shadowScalpsSummary({ era: "all", friction: 1.0 });
    assert(JSON.stringify(again.rows) === JSON.stringify(body.rows), "summary memoized per table version (stable re-read)");
    const [c1, c2] = await Promise.all([ss.shadowScalpsSummary({ era: "all", friction: 0.7 }), ss.shadowScalpsSummary({ era: "all", friction: 0.7 })]);
    assert(JSON.stringify(c1.rows) === JSON.stringify(c2.rows) && c1.frictionPts === 0.7, "concurrent requests share one computation (same body)");

    // MAIN-THREAD HYGIENE: paged reads + the yielding aggregate give the same answers as the sync forms.
    const byId = (rs: SIR[]) => JSON.stringify([...rs].sort((a, b) => a.id - b.id));
    let pages = 0;
    const paged = await ss.readRowsPaged({}, () => { pages++; }, 40);
    assert(dbRows.length > 120 && pages === Math.floor(dbRows.length / 40) + 1 && byId(paged) === byId(dbRows), `keyset-paged read (${pages} pages of 40) == the one-shot read (${dbRows.length} rows)`);
    const pagedLive = await ss.readRowsPaged({ era: "live", fillModel: "pessimistic" }, undefined, 20);
    assert(byId(pagedLive) === byId(digestRows), "paged read honours the era + fill-model filter");
    // A recorder chunk replacing a day between two pages → the read restarts (no duplicated day).
    let first = true;
    const racy = await ss.readRowsPaged({}, () => {
      if (first) { first = false; ss.recordSession("2015-01-13", "live", { nowSec: AFTER("2015-01-13"), zoneFor }); }
    }, 40);
    const keyN = (r: SIR) => `${r.dayKey}|${r.strategy}|${r.variant}|${r.cell}|${r.fillModel}|${r.entryTs}|${r.id}`;
    const now = ss.readRows();
    assert(racy.length === now.length && new Set(racy.map(keyN)).size === racy.length && byId(racy) === byId(now),
      "a day replaced mid-read → the paged read restarts and returns the table as it is now (no duplicate rows)");
    const sAsync = await ss.summarizeRowsAsync(now, { era: "all", friction: 1.0 });
    assert(JSON.stringify(sAsync) === JSON.stringify(ss.summarizeRows(now, { era: "all", friction: 1.0 })), "summarizeRowsAsync == summarizeRows");
    assert(await ss.shadowScalpsDigestLineAsync() === ss.shadowScalpsDigestLine(), "async digest line == sync digest line");
    const live2 = await ss.shadowScalpsSummary({ era: "all", friction: 1.0 });
    assert(JSON.stringify(live2.rows) === JSON.stringify(ss.summarizeRows(now, { era: "all", friction: 1.0 }).rows), "a table change invalidates the memo (the replaced day is reflected)");
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
