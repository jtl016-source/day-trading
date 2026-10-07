// ── 1m SCALP exit calibration ─────────────────────────────────────────────────
// Grid-searches the exits (and entry windows) of the program's 1m scalp
// component on the last ~28 days of 1m MES=F bars (Yahoo serves 1m data only
// for the trailing 30 days, 7 days per request, so the month is fetched in
// four UTC-midnight-aligned chunks).
//
// Overfit control mirrors scripts/optimize-signals.ts: TRAIN = first 19 days,
// TEST = last 9 days; configs are ranked on TRAIN only and must stay positive
// on TEST. Winners need ≥ MIN_TRAIN_CLOSED closed train trades.
//
// Ranking metric: PESSIMISTIC net points. The engine's walk-forward credits TP
// before SL when one bar spans both (see LEARNINGS 2026-08-05 cause 3); with
// 2-pt scalp targets on 1m bars that ambiguity is frequent, so every signal is
// re-walked here with "both in one bar = LOSS" and COST_PTS (commission + one
// tick of slippage, ≈ $3.75 on MES) is charged per closed trade. Optimistic
// (engine) numbers are reported alongside for reference.
//
// Run history:
//   2026-10-07 run 1 (exits only, kill zones vs all-RTH): kill zones win every
//     exit config but NOTHING validates net of costs (19 signals/day, ~0.45 pt
//     gross edge/trade < 0.75 pt cost).
//   2026-10-07 run 2 (+VWAP / body / cooldown / vector / footprint / max-range /
//     morning-only variants, 3,840 configs): 54 validate. Shipped winner =
//     am+vwap+cd10+r≤3, TP1 +4 / TP2 +6 / SL −4 (train +55 / test +24 / full +79
//     net, 63.7% WR, 124 trades); SL 3 and TP2 8 neighbours also validate.
//     Vector gate (V) and proxy footprint (F) hurt on 1m; afternoon window hurts.
//
// Usage: npx tsx scripts/calibrate-scalp.ts [--write-md]
import YahooFinance from "yahoo-finance2";
import { writeFileSync } from "node:fs";
import {
  aggregateToInterval,
  computeEngineSignals,
  detectIctZones,
  isRTH,
  rthSettleOfDay,
  OPTIMIZED_GATES,
  OPTIMIZED_EXITS_5M,
  OPTIMIZED_EXITS,
  SCALP_WINDOWS_UTC,
  type EngineCandle,
  type EngineGates,
  type EngineSignal,
  type ExitProfile,
} from "../client/src/lib/signal-engine";

const SYMBOL           = "MES=F";
const TOTAL_DAYS       = 28;
const TRAIN_DAYS       = 19;
const MIN_TRAIN_CLOSED = 30;
const COST_PTS         = 0.75;   // ≈ $2.50 commission RT + 1 tick slippage on MES

const TP1_GRID  = [1.5, 2, 2.5, 3, 4];
const TP2_MULTS = [1.5, 2.0];
const SL_GRID   = [2, 3, 4];
// Entry-filter variants. Run 1 (2026-10-07) showed the kill-zone window beats
// all-RTH in every exit config but NOTHING validated net of costs at ~19
// signals/day — so the scalp needs its own filters to cut frequency: VWAP
// side, body conviction, longer cooldown.
const WINDOWS: Array<{ key: string; gates: EngineGates }> = [];
const MORNING_ONLY: ReadonlyArray<readonly [number, number]> = [SCALP_WINDOWS_UTC[0]];
for (const win of ["kz", "am"] as const)
for (const vec of [false, true]) for (const fp of [false, true])
for (const vwap of [false, true]) for (const body of [0, 0.5]) for (const cd of [10, 20]) for (const maxR of [Infinity, 3]) {
  WINDOWS.push({
    key: `${win}${vec ? "+V" : ""}${fp ? "+F" : ""}${vwap ? "+vwap" : ""}${body ? `+body${body}` : ""}+cd${cd}${isFinite(maxR) ? `+r≤${maxR}` : ""}`,
    gates: { ...OPTIMIZED_GATES, vector: vec, footprint: fp, entryWindowsUtc: win === "kz" ? SCALP_WINDOWS_UTC : MORNING_ONLY,
             vwapSide: vwap, minBodyFrac: body, cooldownBars: cd, maxRangePts: maxR },
  });
}

// ── Data ──────────────────────────────────────────────────────────────────────
async function fetch1m(): Promise<EngineCandle[]> {
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const byTime = new Map<number, EngineCandle>();
  for (let k = TOTAL_DAYS; k > 0; k -= 7) {
    const from = new Date(todayUtc - k * 86400 * 1000);
    const to   = k - 7 > 0 ? new Date(todayUtc - (k - 7) * 86400 * 1000) : now;
    const r = await yf.chart(SYMBOL, { period1: from, period2: to, interval: "1m", includePrePost: true });
    for (const q of r.quotes) {
      if (q.open == null || q.high == null || q.low == null || q.close == null) continue;
      const time = Math.floor(new Date(q.date).getTime() / 1000);
      if (time % 60 !== 0) continue; // drop Yahoo's partial "now" bar
      byTime.set(time, { time, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0, rth: isRTH(time) });
    }
    console.log(`  chunk ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}: ${r.quotes.length} quotes`);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// ── Pessimistic re-walk ───────────────────────────────────────────────────────
type Walk = { outcome: "win_tp1" | "win_tp2" | "loss" | "open"; pts: number | null };
function pessimisticWalk(sorted: EngineCandle[], idxByTime: Map<number, number>, s: EngineSignal, nowSec: number): Walk {
  const i0 = idxByTime.get(s.time);
  if (i0 == null) return { outcome: "open", pts: null };
  const isLong = s.direction === "Long";
  let settle = rthSettleOfDay(s.time);
  for (let d = 0; s.time >= settle && d < 4; d++) settle = rthSettleOfDay(s.time + (d + 1) * 86400);
  const risk = Math.abs(s.price - s.sl);
  for (let j = i0 + 1; j < sorted.length; j++) {
    const f = sorted[j];
    if (f.time > settle) break;
    const hitTp1 = isLong ? f.high >= s.tp1 : f.low  <= s.tp1;
    const hitTp2 = isLong ? f.high >= s.tp2 : f.low  <= s.tp2;
    const hitSl  = isLong ? f.low  <= s.sl  : f.high >= s.sl;
    if (hitSl) return { outcome: "loss", pts: -risk };            // SL wins every tie
    if (hitTp2) return { outcome: "win_tp2", pts: Math.abs(s.tp2 - s.price) };
    if (hitTp1) return { outcome: "win_tp1", pts: Math.abs(s.tp1 - s.price) };
  }
  return nowSec > settle ? { outcome: "loss", pts: -risk } : { outcome: "open", pts: null };
}
function optimisticPts(s: EngineSignal): number | null {
  if (s.outcome === "win_tp1" || s.outcome === "win_trailer") return Math.abs(s.tp1 - s.price);
  if (s.outcome === "win_tp2") return Math.abs(s.tp2 - s.price);
  if (s.outcome === "loss")    return -Math.abs(s.sl - s.price);
  return null;
}

type Stats = { n: number; closed: number; wins: number; wr: number; optPts: number; pessPts: number; netPts: number; netLowCost: number; exp: number };
function stats(sigs: EngineSignal[], walks: Walk[]): Stats {
  let closed = 0, wins = 0, opt = 0, pess = 0;
  sigs.forEach((s, k) => {
    const o = optimisticPts(s); if (o != null) opt += o;
    const w = walks[k];
    if (w.pts == null) return;
    closed++; pess += w.pts; if (w.pts > 0) wins++;
  });
  const net = pess - closed * COST_PTS;
  return { n: sigs.length, closed, wins, wr: closed ? wins / closed * 100 : 0, optPts: opt, pessPts: pess, netPts: net, netLowCost: pess - closed * 0.5, exp: closed ? net / closed : 0 };
}

type Row = { window: string; tp1: number; tp2: number; sl: number; train: Stats; test: Stats; full: Stats };

async function main() {
  const writeMd = process.argv.includes("--write-md");
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`Fetching ${TOTAL_DAYS} days of 1m ${SYMBOL}…`);
  const bars1m = await fetch1m();
  console.log(`${bars1m.length} 1m bars, ${new Date(bars1m[0].time * 1000).toISOString()} → ${new Date(bars1m[bars1m.length - 1].time * 1000).toISOString()}`);
  const idxByTime = new Map(bars1m.map((c, i) => [c.time, i] as const));
  const zones1m = detectIctZones(bars1m);
  const trainEnd = bars1m[0].time + TRAIN_DAYS * 86400;
  const split = (sigs: EngineSignal[], walks: Walk[]) => {
    const tr: EngineSignal[] = [], te: EngineSignal[] = [], trW: Walk[] = [], teW: Walk[] = [];
    sigs.forEach((s, k) => { if (s.time < trainEnd) { tr.push(s); trW.push(walks[k]); } else { te.push(s); teW.push(walks[k]); } });
    return { train: stats(tr, trW), test: stats(te, teW), full: stats(sigs, walks) };
  };

  // Baseline: the existing 5m and 15m components over the same month (optimistic engine + pessimistic walk)
  console.log("\n── Baseline (existing components, same 28 days) ──");
  for (const [label, sec, exits] of [["5m", 300, OPTIMIZED_EXITS_5M], ["15m", 900, OPTIMIZED_EXITS]] as const) {
    const agg = aggregateToInterval(bars1m, sec);
    const idx = new Map(agg.map((c, i) => [c.time, i] as const));
    const sigs = computeEngineSignals(agg, detectIctZones(agg), exits, "rth", OPTIMIZED_GATES, nowSec);
    const walks = sigs.map(s => pessimisticWalk(agg, idx, s, nowSec));
    const { full } = split(sigs, walks);
    console.log(`  ${label.padEnd(4)} n=${full.n} closed=${full.closed} WR=${full.wr.toFixed(1)}% optimistic=${full.optPts.toFixed(1)} pessimistic=${full.pessPts.toFixed(1)} net=${full.netPts.toFixed(1)} pts`);
  }

  console.log(`\n── Grid: ${WINDOWS.length} windows × ${TP1_GRID.length} TP1 × ${TP2_MULTS.length} TP2 × ${SL_GRID.length} SL = ${WINDOWS.length * TP1_GRID.length * TP2_MULTS.length * SL_GRID.length} configs ──`);
  const rows: Row[] = [];
  for (const w of WINDOWS) for (const tp1 of TP1_GRID) for (const m of TP2_MULTS) for (const sl of SL_GRID) {
    const tp2 = +(tp1 * m).toFixed(2);
    const exits: ExitProfile = { rth: { tp1Safe: tp1, tp1, tp2, sl }, eth: { tp1Safe: tp1 * 0.6, tp1: tp1 * 0.6, tp2: tp2 * 0.6, sl: sl * 0.6 } };
    const sigs = computeEngineSignals(bars1m, zones1m, exits, "rth", w.gates, nowSec);
    const walks = sigs.map(s => pessimisticWalk(bars1m, idxByTime, s, nowSec));
    rows.push({ window: w.key, tp1, tp2, sl, ...split(sigs, walks) });
  }

  const eligible = rows.filter(r => r.train.closed >= MIN_TRAIN_CLOSED);
  const byTrainNet = [...eligible].sort((a, b) => b.train.netPts - a.train.netPts);
  const validated = byTrainNet.filter(r => r.train.netPts > 0 && r.test.netPts > 0);
  const fmt = (r: Row) =>
    `${r.window.padEnd(30)} TP1 ${String(r.tp1).padStart(3)} TP2 ${String(r.tp2).padStart(4)} SL ${String(r.sl).padStart(3)} │ ` +
    `train n=${String(r.train.closed).padStart(3)} WR ${r.train.wr.toFixed(1).padStart(5)}% net ${r.train.netPts.toFixed(1).padStart(7)} │ ` +
    `test n=${String(r.test.closed).padStart(3)} WR ${r.test.wr.toFixed(1).padStart(5)}% net ${r.test.netPts.toFixed(1).padStart(6)} │ ` +
    `full n=${String(r.full.closed).padStart(3)} WR ${r.full.wr.toFixed(1).padStart(5)}% opt ${r.full.optPts.toFixed(1).padStart(7)} pess ${r.full.pessPts.toFixed(1).padStart(7)} net ${r.full.netPts.toFixed(1).padStart(7)} net@0.5 ${r.full.netLowCost.toFixed(1).padStart(6)} exp ${r.full.exp.toFixed(2).padStart(5)}`;

  console.log(`\nEligible (≥${MIN_TRAIN_CLOSED} closed train trades): ${eligible.length}/${rows.length}; validated (train AND test net > 0): ${validated.length}`);
  console.log("\nTop 15 by TRAIN net (pessimistic, after costs):");
  byTrainNet.slice(0, 15).forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${fmt(r)}`));
  console.log("\nTop 10 VALIDATED (train-ranked, train & test net > 0):");
  validated.slice(0, 10).forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${fmt(r)}`));
  console.log("\nBest per filter variant (only variants whose best train net > 0):");
  for (const w of WINDOWS) {
    const r = validated.find(x => x.window === w.key) ?? byTrainNet.find(x => x.window === w.key);
    if (r && r.train.netPts > 0) console.log(`  ${validated.includes(r) ? "✓" : "✗"} ${fmt(r)}`);
  }
  console.log(`\nSignals/day sanity: top train config fires ${(byTrainNet[0].full.n / (TOTAL_DAYS * 5 / 7)).toFixed(1)} signals per trading day`);

  const rec = validated[0];
  if (rec) {
    console.log(`\nRECOMMENDED: window=${rec.window} TP1 +${rec.tp1} / TP2 +${rec.tp2} / SL −${rec.sl}`);
    // Parameter-neighborhood stability: same window & TP1/TP2, SL ±1 step
    const neigh = rows.filter(r => r.window === rec.window && r.tp1 === rec.tp1 && r.tp2 === rec.tp2);
    console.log("SL neighborhood (same window/TP1/TP2):");
    neigh.forEach(r => console.log(`   ${fmt(r)}`));
  } else {
    console.log("\nNO configuration validated — do not ship 1m exits from this run.");
  }

  if (writeMd) {
    const lines = [
      `# MES 1m scalp calibration — ${new Date().toISOString().slice(0, 10)}`, "",
      `Data: ${bars1m.length} 1m MES=F bars (Yahoo), ${new Date(bars1m[0].time * 1000).toISOString().slice(0, 10)} → ${new Date(bars1m[bars1m.length - 1].time * 1000).toISOString().slice(0, 10)}. Train = first ${TRAIN_DAYS} days, test = remainder. Pessimistic walk (SL wins any same-bar tie), cost ${COST_PTS} pt/trade.`, "",
      rec ? `**Recommended:** window=${rec.window} TP1 +${rec.tp1} / TP2 +${rec.tp2} / SL −${rec.sl}` : "**No configuration validated.**", "",
      "| # | window | TP1 | TP2 | SL | train closed | train WR | train net | test closed | test WR | test net | full closed | full WR | full optimistic | full pessimistic | full net | exp/trade |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...byTrainNet.slice(0, 25).map((r, i) => `| ${i + 1} | ${r.window} | ${r.tp1} | ${r.tp2} | ${r.sl} | ${r.train.closed} | ${r.train.wr.toFixed(1)}% | ${r.train.netPts.toFixed(1)} | ${r.test.closed} | ${r.test.wr.toFixed(1)}% | ${r.test.netPts.toFixed(1)} | ${r.full.closed} | ${r.full.wr.toFixed(1)}% | ${r.full.optPts.toFixed(1)} | ${r.full.pessPts.toFixed(1)} | ${r.full.netPts.toFixed(1)} | ${r.full.exp.toFixed(2)} |`),
    ];
    writeFileSync("backtests/MES-scalp-1m-calibration.md", lines.join("\n") + "\n");
    console.log("\nWrote backtests/MES-scalp-1m-calibration.md");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
