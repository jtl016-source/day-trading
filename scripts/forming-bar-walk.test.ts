// scripts/forming-bar-walk.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// FORMING HIGHER-TIMEFRAME BAR harness (2026-10-01, docs/signal-analysis-2026-10-01.md ticket 12b).
// NO test framework — plain asserts, run with:
//   npx tsx scripts/forming-bar-walk.test.ts   (exit 0 = all pass)
//
// FACT (read-only DB check 2026-10-01 16:18 ET): cached_candles holds the FORMING 5m/15m/60m bucket
// at all times — server/derive-bars.ts re-derives the bucket containing every just-completed 1m bar,
// so the newest 5m/15m/60m row is a partial aggregate until its last minute lands. The served
// windows hand it to the engine as a plain candle (no complete:false flag — that flag exists only on
// the browser tab's WS-merged forming bar).
//
// What this harness pins (each assertion FAILED on the pre-fix engine, mutation-checked):
//   W1  walkForward chooses the 1m slice whenever it reaches the newest CLOSED primary bar — a
//       forming bucket's future end never pushes the walk onto the coarse bars (where a bar spanning
//       TP and SL reads SL-first = loss while the 1m tape hit TP first = win_tp1).
//   W2  the forming primary bucket is never evaluated as a closed bar: no fire at its open time on
//       partial OHLC (the same bar fires once it has closed — the guard is the only difference).
//   W3  the canonical resolver never counts a forming bar (complete:false) — the walk ends there.
//   W4  resolveStuckRows (catch-up + live-engine passes) stays a 1m walk whose horizon excludes the
//       newest served 1m bar (temp SQLite via DB_PATH — the live app.db is never opened).
//   S   source scan: both engine walk sites take their edge from closedEdgeTs.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { FiringCandle, FiringZone, VectorPoint } from "../shared/firing/types";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

// July 2026 = EDT (UTC-4). et() converts an ET wall time to unix seconds (same fixture clock as
// shared/fact-engine.test.ts).
const et = (d: number, h: number, mi: number) => Date.UTC(2026, 6, d, h + 4, mi, 0) / 1000;
const M1 = 60, M5 = 300;
function C(time: number, open: number, high: number, low: number, close: number, extra: Partial<FiringCandle> = {}): FiringCandle {
  return { time, open, high, low, close, volume: 100, ...extra };
}
function vec(candles: FiringCandle[], value: number): VectorPoint[] { return candles.map(c => ({ time: c.time, value })); }
const SUPPORT: FiringZone = { topPrice: 100, bottomPrice: 98, color: "#22c55e", label: "support", fromTime: et(1, 0, 0) };

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forming-bar-walk-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.BAXTER_ARTIFACTS_DIR = tmp;
  // Dynamic imports AFTER DB_PATH is set (the catch-up module opens the DB at import).
  const fe = await import("../shared/fact-engine");
  const or = await import("../shared/outcome-resolver");
  const cu = await import("../server/catchup");
  const { db } = await import("../server/db");
  const client = (db as any).$client as import("better-sqlite3").Database;

  // ── Fixture: a 5m strong support-zone Long at 10:30 ET (entry 104.5; pinned exits TP1 +10 = 114.5,
  //    SL −5 = 99.5). The bar after it SPANS BOTH levels on 5m; the 1m tape inside it reaches TP1 in
  //    its FIRST minute and only then falls through SL. Coarse walk = loss, 1m walk = win_tp1. ──
  const F = et(7, 10, 30);
  const pre: FiringCandle[] = [];
  for (let k = 4; k >= 1; k--) pre.push(C(F - k * M5, 102, 102.5, 101.5, 102.2));
  const fireBar = C(F, 100.7, 104.7, 100.4, 104.5);            // wick touches 100, closes +4.5 → STRONG reaction
  const spanBar = C(F + M5, 104.5, 116, 99, 110);               // spans TP1 114.5 AND SL 99.5
  const quiet = (t: number) => C(t, 110, 110.5, 109.5, 110);     // never touches either level afterwards
  // 1m tape: covers the window from before the fire bar; minute 1 after entry prints 116 (TP first),
  // minute 2 prints 99 (SL after). Quiet 1m bars elsewhere.
  function oneMin(throughTs: number): FiringCandle[] {
    const out: FiringCandle[] = [];
    for (let t = F - 4 * M5; t + M1 <= throughTs; t += M1) {
      if (t === F + M5) out.push(C(t, 104.5, 116, 104.5, 115));
      else if (t === F + M5 + M1) out.push(C(t, 115, 115, 99, 100));
      else if (t >= F + M5) out.push(C(t, 110, 110.5, 109.5, 110));
      else if (t >= F) out.push(C(t, 100.7, 104.7, 100.4, 104.5));
      else out.push(C(t, 102, 102.5, 101.5, 102.2));
    }
    return out;
  }
  const input = (primary5m: FiringCandle[], c1m: FiringCandle[], nowSec: number): import("../shared/fact-engine").FactEngineInput => ({
    primary: "5m",
    slices: [
      { interval: "5m", candles: primary5m, vector: vec(primary5m, 90) }, // vector far away → no vector facts
      { interval: "1m", candles: c1m, vector: vec(c1m, 90) },
    ],
    zones: [SUPPORT],
    nowSec,
    exit: { DEFAULT_TP1_PTS: 10, DEFAULT_SL_PTS: 5 }, // pin geometry — regen-proof vs MC recalibration
    ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false, // mechanics fixture
    qualityGateEnabled: false,
  });

  console.log("── W1 walkForward: the 1m slice resolves even when the FORMING 5m bucket sits in the primary slice ──");
  {
    // Control: the primary ends at a COMPLETE bar; now = 30 s after its close; 1m reaches that close.
    const primary = [...pre, fireBar, spanBar];
    const now = F + 2 * M5 + 30;
    const sig = fe.runFactEngine(input(primary, oneMin(F + 2 * M5), now));
    assert(sig.length === 1 && sig[0].time === F && sig[0].direction === "Long", `control: exactly the 10:30 Long fires (got ${sig.length})`);
    assert(sig[0]?.outcome === "win_tp1" && sig[0]?.exitTs === F + M5 + M1,
      `control (no forming bucket): 1m walk → win_tp1 at the first minute's close (got ${sig[0]?.outcome} @${sig[0]?.exitTs})`);
  }
  {
    // THE BUG: a FORMING 5m bucket (2 minutes old, partial OHLC, no complete flag — exactly what
    // cached-continuous serves from derive-bars) is appended; now is inside it; 1m reaches the newest
    // CLOSED 5m bar's end (and one closed minute into the forming bucket).
    const forming = C(F + 2 * M5, 110, 110.5, 109.5, 110);
    const primary = [...pre, fireBar, spanBar, forming];
    const now = F + 2 * M5 + 2 * M1 + 5;
    const sig = fe.runFactEngine(input(primary, oneMin(F + 2 * M5 + M1), now));
    assert(sig.length === 1 && sig[0].time === F, `forming bucket present: still exactly the 10:30 Long (got ${sig.length})`);
    assert(sig[0]?.outcome === "win_tp1" && sig[0]?.exitTs === F + M5 + M1,
      `forming bucket present: the walk stays on the 1m tape → win_tp1 (pre-fix: coarse SL-first → loss, got ${sig[0]?.outcome})`);
    assert(fe.closedEdgeTs(primary, M5, now) === F + 2 * M5, "closedEdgeTs = the end of the newest CLOSED primary bar, not the forming bucket's future end");
    assert(fe.closedEdgeTs(primary, M5, F + 3 * M5) === F + 3 * M5, "…and once the bucket has closed its end is the edge");
    assert(fe.closedEdgeTs([], M5, now) === -Infinity, "no bars → -Infinity");
  }
  {
    // Honest fallback kept: when the 1m slice does NOT reach the newest closed primary bar (1m feed
    // stalled 2 bars ago while 5m bars kept landing), the coarse bars still resolve — same as before.
    const primary = [...pre, fireBar, spanBar, quiet(F + 2 * M5), quiet(F + 3 * M5)];
    const now = F + 4 * M5 + 30;
    const sig = fe.runFactEngine(input(primary, oneMin(F + M5), now)); // 1m stops BEFORE the spanning bar
    assert(sig[0]?.outcome === "loss", `1m slice short of the closed edge → coarse fallback unchanged (SL-first loss, got ${sig[0]?.outcome})`);
  }

  console.log("── W2 the forming primary bucket is never evaluated as a closed bar ──");
  {
    // 12 quiet bars after the fire (past the 10-bar cooldown; the first trade is closed), then a bar
    // shaped like a fresh STRONG reaction. As a CLOSED bar it fires; as the FORMING bucket (now inside
    // it) it must not — the pre-fix engine fired at its open time on partial OHLC.
    const base = [...pre, fireBar, spanBar];
    for (let k = 2; k <= 12; k++) base.push(quiet(F + k * M5));
    const reactionAt = F + 13 * M5;
    const reaction = C(reactionAt, 100.7, 104.7, 100.4, 104.5);
    const closedRun = fe.runFactEngine(input([...base, reaction], oneMin(reactionAt + M5), reactionAt + M5 + 30));
    assert(closedRun.length === 2 && closedRun[1].time === reactionAt, `control: the reaction bar FIRES once it has closed (got ${closedRun.length})`);
    const formingRun = fe.runFactEngine(input([...base, reaction], oneMin(reactionAt + 2 * M1), reactionAt + 2 * M1 + 5));
    assert(formingRun.length === 1 && formingRun[0].time === F,
      `the same bar as the FORMING bucket (now 2 min into it, no complete flag) does NOT fire (pre-fix: fired at its open time; got ${formingRun.length})`);
    // The tab's own flag keeps working too.
    const flagged = fe.runFactEngine(input([...base, { ...reaction, complete: false }], oneMin(reactionAt + 2 * M1), reactionAt + M5 + 30));
    assert(flagged.length === 1, "complete:false still excludes a bar even when the clock says it closed (tab contract unchanged)");
  }

  console.log("── W3 canonical resolver: a forming bar is never counted ──");
  {
    const ENTRY = et(7, 11, 0);
    const bars = [
      { time: ENTRY, high: 101, low: 99.5, close: 100.5 },
      { time: ENTRY + M1, high: 101, low: 99.5, close: 100.5 },
      { time: ENTRY + 2 * M1, high: 106, low: 100, close: 105.5, complete: false }, // forming: prints THROUGH TP1
    ];
    const w = or.walkOutcomeCanonical({ bars, entryTs: ENTRY, entry: 100, tp1: 105, tp2: null, sl: 95, isLong: true, settleTs: et(7, 17, 0), barSec: M1, coveredThroughTs: ENTRY + 10 * M1, tp1Only: true });
    assert(w.outcome === "open" && w.exitTs === null, `a TP1 print inside a complete:false bar is not a record — stays open (got ${w.outcome})`);
    assert(w.mfe === 1 && w.lastCloseTs === ENTRY + 2 * M1, "the walk ended AT the forming bar (its extremes untouched: mfe from the closed bars only)");
    const closed = or.walkOutcomeCanonical({ bars: bars.map(b => ({ ...b, complete: true })), entryTs: ENTRY, entry: 100, tp1: 105, tp2: null, sl: 95, isLong: true, settleTs: et(7, 17, 0), barSec: M1, coveredThroughTs: ENTRY + 10 * M1, tp1Only: true });
    assert(closed.outcome === "win_tp1" && closed.exitTs === ENTRY + 3 * M1, "the same bar once closed resolves win_tp1");
    const horizon = or.walkOutcomeCanonical({ bars: bars.map(b => ({ time: b.time, high: b.high, low: b.low, close: b.close })), entryTs: ENTRY, entry: 100, tp1: 105, tp2: null, sl: 95, isLong: true, settleTs: et(7, 17, 0), barSec: M1, coveredThroughTs: ENTRY + 2 * M1 + 30, tp1Only: true });
    assert(horizon.outcome === "open", "unchanged: the data horizon alone (bar close > coveredThroughTs) also keeps a forming-by-time bar out");
  }

  console.log("── W3b evaluateFormingBar one-open gate: the forming bar's extremes SO FAR still count (documented gate, not a record) ──");
  {
    // The tab flags its forming bar complete:false. The intra-candle one-open gate resolves the prior
    // bracket over the closed bars + the forming bar SO FAR (FormingBarInput.openTrades doc) — the new
    // resolver rule must not turn that gate blind to the forming bar.
    const t1 = et(7, 11, 30);
    const closed: FiringCandle[] = [];
    for (let k = 6; k >= 1; k--) closed.push(C(t1 - k * M5, 102, 102.5, 101.5, 102.2));
    const forming = C(t1, 100.7, 104.7, 100.4, 104.5, { complete: false }); // strong support reaction, flagged forming
    const fb = (openTrades?: Parameters<typeof fe.evaluateFormingBar>[0]["openTrades"]) =>
      fe.evaluateFormingBar({ interval: "5m", formingBar: forming, closedCandles: closed, zones: [SUPPORT], openTrades });
    const openLong = { entry: 102.2, tp1: 112.2, sl: 97.2, firedAt: t1 - 3 * M5 };
    assert(fb() !== null, "control: the flagged forming bar fires the intra-candle zone reaction");
    assert(fb({ Long: openLong }) === null, "an unresolved same-direction bracket still blocks the intra fire");
    assert(fb({ Long: { ...openLong, tp1: 104.0 } }) !== null, "a bracket whose TP1 only the FORMING bar (complete:false) has tagged does not block — its extremes so far count in this gate");
  }

  console.log("── W4 resolveStuckRows: 1m walk, newest served 1m bar excluded (temp DB) ──");
  {
    client.exec(`DELETE FROM signal_history`);
    const now = Math.floor(Date.now() / 1000);
    const t0 = now - (now % 300) - 6 * 3600; // a 15m fire 6 h ago
    client.prepare(
      `INSERT INTO signal_history (symbol, interval, timestamp, direction, risk_level, signal_type, entry, tp1, tp2, sl, outcome, exit_ts, source, updated_at)
       VALUES ('MES','15m',?,'Long','safe','fact-engine',7700,7710,NULL,7690,'open',NULL,'live','x')`).run(t0);
    const bars1m: Array<{ time: number; open: number; high: number; low: number; close: number }> = [];
    for (let t = t0 - 600; t <= now - 60; t += 60) bars1m.push({ time: t, open: 7700, high: 7701, low: 7699, close: 7700.25 });
    // TP touch ONLY inside the newest served 1m bar (which may still be forming) → not resolved.
    const last = bars1m[bars1m.length - 1];
    const touchLast = bars1m.map(b => b === last ? { ...b, high: 7711 } : b);
    const st1 = cu.resolveStuckRows(touchLast, now);
    assert(st1.checked === 1 && st1.resolved === 0, "a touch in the NEWEST served 1m bar is not counted (it may be forming)");
    // The same touch one bar earlier (a closed minute) resolves — on the 1m tape, at that minute's close.
    const prev = bars1m[bars1m.length - 2];
    const touchPrev = bars1m.map(b => b === prev ? { ...b, high: 7711 } : b);
    const st2 = cu.resolveStuckRows(touchPrev, now);
    const row = client.prepare(`SELECT outcome, exit_ts FROM signal_history WHERE timestamp=?`).get(t0) as { outcome: string; exit_ts: number };
    assert(st2.resolved === 1 && row.outcome === "win_tp1" && row.exit_ts === prev.time + 60,
      `a touch in a CLOSED minute resolves on the 1m walk at that minute's close (got ${row.outcome} @${row.exit_ts}, expected ${prev.time + 60})`);
  }

  console.log("── S source scan: both engine walk sites take their edge from closedEdgeTs ──");
  {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = fs.readFileSync(path.join(root, "shared/fact-engine.ts"), "utf8");
    const calls = src.match(/closedEdgeTs\(candles, barSec, (nowSec|horizon)\)/g) ?? [];
    assert(calls.length === 2, `walkForward + bracketExitTs both call closedEdgeTs (found ${calls.length})`);
    assert(!/candles\[candles\.length - 1\]\.time \+ barSec/.test(src), "no walk site measures the live edge from the LAST bar's end anymore");
    assert(/if \(closeTime > nowSec\) continue;/.test(src), "the bar-close loop skips a bar whose close lies after nowSec");
    const walker = fs.readFileSync(path.join(root, "shared/outcome-resolver.ts"), "utf8");
    assert(/if \(b\.complete === false\) break;/.test(walker), "the canonical resolver ends the walk at a complete:false bar");
  }
}

main()
  .catch(e => { failures.push(`threw: ${e?.stack ?? e}`); console.error(e); })
  .finally(() => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.error(failures.join("\n"));
    process.exit(failures.length ? 1 : 0);
  });
