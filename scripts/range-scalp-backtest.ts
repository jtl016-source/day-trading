/**
 * range-scalp-backtest.ts — DEAD-TAPE RANGE SCALP (2026-08-12, user: small accumulating
 * trades inside the dead-tape window — "10 points back and forth… fade it").
 *
 * Walk-forward simulation on the standing window's 1m serving-chain bars (loadData — the
 * same parity-locked candles the live engine sees):
 *   • ACTIVE only while the ENGINE's dead-tape rule suppresses (running session range <
 *     DEAD_TAPE_SUPPRESS_MULT × the served window median — the live gate's exact basis),
 *     and only once the session has ≥ MIN_RANGE points of room to oscillate in.
 *   • ENTRY: fade a touch of the running session extreme — LONG when a bar's low comes
 *     within EDGE_EPS of the session low-so-far, SHORT at the session high-so-far mirror.
 *     One open trade per side; re-entry only after resolution + COOLDOWN_BARS.
 *   • EXITS: range-scaled — TP = TP_FRAC × range-so-far (clamped [3, 12] pts),
 *     SL = SL_FRAC × range-so-far beyond the extreme (clamped [2.5, 9]). Resolved by the
 *     CANONICAL resolver under the live carry-overnight contract (a scalp that survives the
 *     tape clearing keeps its exits — honest trend-day cost).
 *   • Reported GROSS and NET of FRICTION_PTS_PER_TRADE — at 3-6 pt targets friction is the
 *     first-order question; grid results are IN-SAMPLE (flagged) — a survivor would need the
 *     usual corroborator ritual before going anywhere near live.
 *
 * Usage: npx tsx scripts/range-scalp-backtest.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEAD_TAPE_SUPPRESS_MULT } from "../shared/fact-engine";
import { walkOutcomeCanonical } from "../shared/outcome-resolver";
import { sessionDayKey, etWallToEpoch, priorCalendarDay, rnd2 } from "../shared/yellowbox-core";
import { loadData, FRICTION_PTS_PER_TRADE } from "./fact-engine-backtest";
import { artifactsDir } from "../shared/artifacts-dir";

const OUT = path.join(artifactsDir(process.cwd()), "range-scalp-backtest.json");
const MIN_RANGE = 15;      // need real oscillation room before fading edges
const COOLDOWN_BARS = 5;   // 1m bars after a resolution before the same side may re-enter
const EDGE_EPS = 1.0;      // "touch" = within this of the running extreme

interface Trade {
  day: string; side: "Long" | "Short"; entryTs: number; entry: number;
  tp: number; sl: number; outcome: string; pts: number | null; exitTs: number | null;
  rangeAtEntry: number;
}

function metrics(trades: Trade[]) {
  const closed = trades.filter(t => t.pts != null);
  const wins = closed.filter(t => (t.pts as number) > 0);
  const losses = closed.filter(t => (t.pts as number) < 0);
  const cum = closed.reduce((a, t) => a + (t.pts as number), 0);
  const gp = wins.reduce((a, t) => a + (t.pts as number), 0);
  const gl = Math.abs(losses.reduce((a, t) => a + (t.pts as number), 0));
  let run = 0, peak = 0, dd = 0;
  for (const t of closed) { run += t.pts as number; peak = Math.max(peak, run); dd = Math.max(dd, peak - run); }
  const netCum = cum - closed.length * FRICTION_PTS_PER_TRADE;
  return {
    n: closed.length, winPct: rnd2(closed.length ? (100 * wins.length) / closed.length : 0),
    exp: rnd2(closed.length ? cum / closed.length : 0), netExp: rnd2(closed.length ? netCum / closed.length : 0),
    pf: rnd2(gl > 0 ? gp / gl : gp > 0 ? 99 : 0), cum: rnd2(cum), netCum: rnd2(netCum), maxDD: rnd2(dd),
  };
}

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const c1m = L.c1m as Array<{ time: number; open: number; high: number; low: number; close: number }>;
  const median = L.dayRangeMedian;
  const thr = DEAD_TAPE_SUPPRESS_MULT * median;
  console.log(`[scalp] 1m bars ${c1m.length}; dead-tape threshold ${rnd2(thr)} (${DEAD_TAPE_SUPPRESS_MULT} × median ${median})`);

  const grid: Array<{ tpFrac: number; slFrac: number }> = [
    { tpFrac: 0.25, slFrac: 0.15 }, { tpFrac: 0.35, slFrac: 0.15 }, { tpFrac: 0.5, slFrac: 0.15 },
    { tpFrac: 0.25, slFrac: 0.25 }, { tpFrac: 0.35, slFrac: 0.25 }, { tpFrac: 0.5, slFrac: 0.25 },
  ];
  const results: Record<string, unknown>[] = [];

  for (const g of grid) {
    const trades: Trade[] = [];
    let day = "", hi = -Infinity, lo = Infinity;
    let openLongUntil = 0, openShortUntil = 0; // bar-time locks: open trade or cooldown window
    for (let i = 0; i < c1m.length; i++) {
      const b = c1m[i];
      const k = sessionDayKey(b.time);
      if (k !== day) { day = k; hi = -Infinity; lo = Infinity; }
      // Extremes BEFORE this bar decide the touch (the bar that EXTENDS the range is the
      // falling knife itself — fade only a RETEST of a previously-set extreme).
      const prevHi = hi, prevLo = lo;
      hi = Math.max(hi, b.high); lo = Math.min(lo, b.low);
      const range = prevHi > prevLo ? prevHi - prevLo : 0;
      if (range < MIN_RANGE || range >= thr) continue;   // active only inside dead tape, with room
      const tpPts = Math.min(12, Math.max(3, g.tpFrac * range));
      const slPts = Math.min(9, Math.max(2.5, g.slFrac * range));
      const entryTs = b.time + 60;
      // LONG: this bar RETESTS the standing session low (without making a materially new one).
      if (b.time >= openLongUntil && b.low <= prevLo + EDGE_EPS && b.low >= prevLo - 0.25) {
        const entry = b.close;
        const settleTs = etWallToEpoch(k, 17, 0) > entryTs ? etWallToEpoch(k, 17, 0) : etWallToEpoch(priorCalendarDay(k), 17, 0) + 86400;
        const w = walkOutcomeCanonical({
          bars: c1m, entryTs, entry, tp1: entry + tpPts, tp2: entry + tpPts, sl: prevLo - slPts,
          isLong: true, settleTs, barSec: 60, coveredThroughTs: Math.min(L.lastDataTs, nowSec),
        });
        const pts = w.outcome === "open" ? null : w.outcome === "loss" ? -(entry - (prevLo - slPts)) : tpPts;
        trades.push({ day: k, side: "Long", entryTs, entry, tp: entry + tpPts, sl: prevLo - slPts, outcome: w.outcome, pts: pts == null ? null : rnd2(pts), exitTs: w.exitTs, rangeAtEntry: rnd2(range) });
        openLongUntil = (w.exitTs ?? entryTs + 4 * 3600) + COOLDOWN_BARS * 60;
      }
      // SHORT mirror at the running high.
      if (b.time >= openShortUntil && b.high >= prevHi - EDGE_EPS && b.high <= prevHi + 0.25) {
        const entry = b.close;
        const settleTs = etWallToEpoch(k, 17, 0) > entryTs ? etWallToEpoch(k, 17, 0) : etWallToEpoch(priorCalendarDay(k), 17, 0) + 86400;
        const w = walkOutcomeCanonical({
          bars: c1m, entryTs, entry, tp1: entry - tpPts, tp2: entry - tpPts, sl: prevHi + slPts,
          isLong: false, settleTs, barSec: 60, coveredThroughTs: Math.min(L.lastDataTs, nowSec),
        });
        const pts = w.outcome === "open" ? null : w.outcome === "loss" ? -((prevHi + slPts) - entry) : tpPts;
        trades.push({ day: k, side: "Short", entryTs, entry, tp: entry - tpPts, sl: prevHi + slPts, outcome: w.outcome, pts: pts == null ? null : rnd2(pts), exitTs: w.exitTs, rangeAtEntry: rnd2(range) });
        openShortUntil = (w.exitTs ?? entryTs + 4 * 3600) + COOLDOWN_BARS * 60;
      }
    }
    const m = metrics(trades);
    const days = new Set(trades.map(t => t.day)).size;
    results.push({ ...g, ...m, activeDays: days, perDay: days ? rnd2(m.n / days) : 0 });
    console.log(`[scalp] tp ${g.tpFrac} sl ${g.slFrac}: n=${m.n} (${days} days, ${days ? rnd2(m.n / days) : 0}/day) win ${m.winPct}% exp ${m.exp} NET ${m.netExp} PF ${m.pf} cum ${m.cum} NET cum ${m.netCum} maxDD ${m.maxDD}`);
  }

  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    note: "IN-SAMPLE grid, standing 90d window, dead-tape-window-only entries, canonical carry resolution, friction NET reported. NOT a shippable verdict — a survivor needs the corroborator ritual (held-out validation) first.",
    threshold: rnd2(thr), median, minRange: MIN_RANGE, edgeEps: EDGE_EPS, cooldownBars: COOLDOWN_BARS,
    results,
  }, null, 2));
  console.log(`[scalp] artifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
