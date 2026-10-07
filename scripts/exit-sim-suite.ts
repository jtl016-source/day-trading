/**
 * exit-sim-suite.ts — EXIT-STRATEGY SIMULATION SUITE (2026-08-12, user request:
 * "try these simulations for my exit strategy and tell me which were useful").
 *
 * Parts (run with --part=a|b|c|d, artifacts to <artifactsDir>/exit-sim-<part>.json):
 *   a  REAL-PATH FOUNDATION on 1m bars for every closed 15m book trade:
 *      - shipped-exit replay (must reproduce the book — reproduction rate reported),
 *      - first-crossing profiles (tick-quantized MFE/MAE first-touch times, reused by d),
 *      - time-decay grid (sim #3): time-stops, decay-to-breakeven, EV-per-minute-held,
 *      - slippage/latency matrix (sim #5, bar-level approximation — no order-book data),
 *      - TP1 near-miss rate (honest substitute for the Hawkes front-running question),
 *      - trailing-exit variants scored EXECUTABLY (chandelier k×ATR15m; hybrid TP+trail),
 *        feeding part c. NOTE: the book's win_tp1 record convention is slightly
 *        optimistic vs executable fills; trailing variants carry no such convention,
 *        which biases the comparison AGAINST trailing — stated in the report.
 *   b  SYNTHETIC PATHS (sim #1): GBM+jumps and GARCH(1,1) calibrated on the last 90d of
 *      1m returns; fixed vs trailing premature-stop sensitivity. Synthetic paths carry
 *      NO zone/vector structure — only RELATIVE exit sensitivity is meaningful.
 *   c  BLOCK-BOOTSTRAP MC (sim #2): L=10 contiguous-trade blocks, 5,000 resamples,
 *      100-trade horizon; P95 maxDD + P(ruin) per exit variant from part a.
 *   d  WALK-FORWARD (sim #4): rolling 3-month IS / 1-month OOS re-optimization of
 *      (TP1, SL=p85 winners'-MAE) on first-crossing profiles; WFE per window; plus an
 *      ATR-scaled dynamic variant. Uses the SAME session-bounded-free carry semantics
 *      as the record contract (profiles are capped at 5 trading days).
 *
 * All EVs reported NET of 1.0 pt/trade friction unless labeled gross. Seeded PRNG.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd();
const SYMBOL = "MES";
const FRICTION = 1.0;
const TICK = 0.25;
const CAP_SEC = 5 * 86400; // profile horizon per trade
const OUT_DIR = artifactsDir(ROOT);
const part = (process.argv.find(a => a.startsWith("--part=")) ?? "--part=a").slice(7);

const db = new Database(path.join(ROOT, "data", "app.db"), { readonly: true });
const barsStmt = db.prepare(
  `SELECT timestamp AS time, high, low, close FROM cached_candles
   WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<? ORDER BY timestamp`,
);
const bars15Stmt = db.prepare(
  `SELECT timestamp AS time, high, low, close FROM cached_candles
   WHERE symbol=? AND resolution='15' AND timestamp<? ORDER BY timestamp DESC LIMIT 15`,
);

interface Bar { time: number; high: number; low: number; close: number }
interface BookTrade {
  interval: string; fireTs: number; entryTs: number; direction: string; entry: number;
  tp1: number; tp2: number; sl: number; outcome: string; pointsResult: number | null;
}
const doc = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "fact-engine-backtest-results.json"), "utf8")) as { signals: BookTrade[] };
const trades = doc.signals
  .filter(s => s.interval === "15m" && s.outcome !== "open")
  .sort((a, b) => a.fireTs - b.fireTs);

function rng(seed: number): () => number {
  return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pctl = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/** Per-trade real-path profile: first-crossing times + minute marks + shipped replay. */
interface Profile {
  fireTs: number; dir: 1 | -1; entry: number; tp1d: number; sld: number;
  bookOutcome: string; bookPts: number | null;
  replayOutcome: string; replayPts: number; resolveMin: number; // minutes from entry to shipped resolution (cap if open)
  upCross: number[]; dnCross: number[]; // upCross[i] = minutes to first favorable excursion of (i+1)*TICK; -1 = never (within cap)
  marks: number[]; // favorable-signed (pts) close-mark every 5 min through min(resolveMin, 480)
  atr15: number;
}

function buildProfile(t: BookTrade): Profile | null {
  const dir = t.direction.toLowerCase() === "long" ? 1 : -1;
  const bars = barsStmt.all(SYMBOL, t.entryTs - 60, t.entryTs + CAP_SEC) as Bar[];
  if (bars.length < 30) return null;
  const a15 = bars15Stmt.all(SYMBOL, t.entryTs) as Bar[];
  let atr15 = 0;
  if (a15.length >= 2) {
    const rev = [...a15].reverse();
    let s = 0, n = 0;
    for (let i = 1; i < rev.length; i++) { s += Math.max(rev[i].high - rev[i].low, Math.abs(rev[i].high - rev[i - 1].close), Math.abs(rev[i].low - rev[i - 1].close)); n++; }
    atr15 = s / n;
  }
  const tp1d = Math.abs(t.tp1 - t.entry), sld = Math.abs(t.sl - t.entry);
  const MAXT = 200; // ticks tracked each side (50 pts)
  const upCross = new Array(MAXT).fill(-1), dnCross = new Array(MAXT).fill(-1);
  const marks: number[] = [];
  // shipped replay state (mirrors walkOutcomeCanonical, carry mode)
  let tp1Hit = false; let outcome = "open"; let pts = 0; let resolveMin = CAP_SEC / 60;
  let upMax = 0, dnMax = 0;
  for (const b of bars) {
    if (b.time < t.entryTs) continue;
    const min = Math.floor((b.time - t.entryTs) / 60);
    const fav = dir === 1 ? b.high - t.entry : t.entry - b.low;
    const adv = dir === 1 ? t.entry - b.low : b.high - t.entry;
    if (fav > upMax) { for (let i = Math.floor(upMax / TICK); i < Math.min(MAXT, Math.floor(fav / TICK)); i++) if (upCross[i] < 0) upCross[i] = min; upMax = fav; }
    if (adv > dnMax) { for (let i = Math.floor(dnMax / TICK); i < Math.min(MAXT, Math.floor(adv / TICK)); i++) if (dnCross[i] < 0) dnCross[i] = min; dnMax = adv; }
    if (outcome === "open") {
      const slTouch = adv >= sld, tp1Touch = fav >= tp1d, tp2Touch = fav >= 2 * tp1d;
      if (!tp1Hit) {
        if (slTouch) { outcome = "loss"; pts = -sld; resolveMin = min; }
        else if (tp2Touch) { outcome = "win_tp2"; pts = 2 * tp1d; resolveMin = min; }
        else if (tp1Touch) tp1Hit = true;
      } else {
        if (slTouch) { outcome = "win_tp1"; pts = tp1d; resolveMin = min; }
        else if (tp2Touch) { outcome = "win_tp2"; pts = 2 * tp1d; resolveMin = min; }
      }
      if (min % 5 === 0 && marks.length === min / 5 && min <= 480) marks.push(+( (dir === 1 ? b.close - t.entry : t.entry - b.close)).toFixed(2));
    }
    if (outcome !== "open" && min > 480) break;
  }
  if (outcome === "open" && tp1Hit) { outcome = "win_tp1"; pts = tp1d; } // watch never ended within cap
  else if (outcome === "open") { const lb = bars[bars.length - 1]; pts = dir === 1 ? lb.close - t.entry : t.entry - lb.close; }
  const OC: Record<string, string> = { tp1: "win_tp1", tp2: "win_tp2", sl: "loss", eod: "eod", open: "open" };
  return { fireTs: t.fireTs, dir: dir as 1 | -1, entry: t.entry, tp1d, sld, bookOutcome: OC[t.outcome] ?? t.outcome, bookPts: t.pointsResult, replayOutcome: outcome, replayPts: +pts.toFixed(2), resolveMin, upCross, dnCross, marks, atr15: +atr15.toFixed(2) };
}

/** Score a (tp1,sl) cell from a profile using resolver conventions (SL-first ties, tp2 = 2×tp1). */
function scoreCell(p: Profile, tp1: number, sl: number): { oc: string; pts: number } {
  const iUp = (x: number): number => { const i = Math.ceil(x / TICK) - 1; return i < p.upCross.length ? p.upCross[i] : -1; };
  const iDn = (x: number): number => { const i = Math.ceil(x / TICK) - 1; return i < p.dnCross.length ? p.dnCross[i] : -1; };
  const tU1 = iUp(tp1), tU2 = iUp(2 * tp1), tD = iDn(sl);
  const hitU1 = tU1 >= 0, hitU2 = tU2 >= 0, hitD = tD >= 0;
  if (hitD && (!hitU1 || tD <= tU1)) return { oc: "loss", pts: -sl };
  if (hitU2 && (!hitD || tU2 < tD)) return { oc: "win_tp2", pts: 2 * tp1 };
  if (hitU1) return { oc: "win_tp1", pts: tp1 };
  return { oc: "open", pts: 0 };
}

// ═════ PART A ═════
function partA(): void {
  const profiles: Profile[] = [];
  let noData = 0;
  for (const t of trades) { const p = buildProfile(t); if (p) profiles.push(p); else noData++; }
  const closedP = profiles.filter(p => p.replayOutcome !== "open");
  let repro = 0;
  for (const p of profiles) if (p.replayOutcome === p.bookOutcome) repro++;
  console.log(`[A] profiles ${profiles.length}/${trades.length} (noData ${noData}); shipped replay reproduces book outcome on ${repro}/${profiles.length} (${(100 * repro / profiles.length).toFixed(1)}%)`);

  // ── time-decay (sim #3) ──
  const stats = (arr: number[]): { n: number; ev: number; win: number } => ({ n: arr.length, ev: +(arr.reduce((a, b) => a + b, 0) / arr.length - FRICTION).toFixed(2), win: +(100 * arr.filter(x => x > 0).length / arr.length).toFixed(1) });
  const baseline = stats(closedP.map(p => p.replayPts));
  const timeStops: Record<string, { n: number; ev: number; win: number; cutPct: number }> = {};
  for (const T of [30, 60, 90, 120, 180, 240, 360, 480]) {
    let cut = 0;
    const outs = closedP.map(p => {
      if (p.resolveMin <= T) return p.replayPts;
      cut++;
      const mi = Math.min(Math.floor(T / 5), p.marks.length - 1);
      return mi >= 0 ? p.marks[mi] : 0;
    });
    timeStops[`${T}min`] = { ...stats(outs), cutPct: +(100 * cut / closedP.length).toFixed(1) };
  }
  const decayBE: Record<string, { n: number; ev: number; win: number }> = {};
  for (const M of [45, 90, 180]) {
    const outs = closedP.map(p => {
      const iU1 = Math.ceil(p.tp1d / TICK) - 1, tU1 = p.upCross[iU1] ?? -1;
      if (tU1 >= 0 && tU1 <= M) return p.replayPts;        // TP1 already banked before decay
      const tD = (() => { const i = Math.ceil(p.sld / TICK) - 1; return i < p.dnCross.length ? p.dnCross[i] : -1; })();
      if (tD >= 0 && tD <= M) return p.replayPts;           // resolved as loss before decay
      // still open at M: stop moves to entry (breakeven = first 1-tick adverse cross after M)
      const tBE = (() => { for (let i = 0; i < p.dnCross.length; i++) { const v = p.dnCross[i]; if (v > M) return v; if (v < 0) break; } return -1; })();
      const tTP = tU1 > M ? tU1 : -1;
      if (tTP >= 0 && (tBE < 0 || tTP < tBE)) return p.replayPts; // reached TP1 before any adverse tick
      return 0;                                                    // scratched at breakeven
    });
    decayBE[`be@${M}min`] = stats(outs);
  }
  // EV-per-minute-held: expected (final − mark) among trades still open at t
  const evPerMin: Array<{ min: number; openPct: number; remainingEV: number }> = [];
  for (const T of [15, 30, 45, 60, 90, 120, 180, 240, 360, 480]) {
    const open = closedP.filter(p => p.resolveMin > T && p.marks.length > Math.floor(T / 5));
    if (open.length < 15) break;
    const rem = open.reduce((a, p) => a + (p.replayPts - p.marks[Math.floor(T / 5)]), 0) / open.length;
    evPerMin.push({ min: T, openPct: +(100 * open.length / closedP.length).toFixed(1), remainingEV: +rem.toFixed(2) });
  }

  // ── near-miss (Hawkes substitute) ──
  const losses = closedP.filter(p => p.replayOutcome === "loss");
  const nearMiss: Record<string, number> = {};
  for (const k of [1, 2, 3, 4]) {
    const idx = (p: Profile): number => Math.ceil(p.tp1d / TICK) - 1 - k;
    const n = losses.filter(p => { const i = idx(p); return i >= 0 && p.upCross[i] >= 0; }).length;
    nearMiss[`within${k}tick`] = +(100 * n / losses.length).toFixed(1);
  }

  // ── slippage / latency matrix (sim #5, bar-level) ──
  const slipMatrix: Array<{ label: string; ev: number; win: number; dEv: number }> = [];
  const cellStats = (fn: (p: Profile) => number, label: string): void => {
    const outs = closedP.map(fn);
    const s = stats(outs);
    slipMatrix.push({ label, ev: s.ev, win: s.win, dEv: +(s.ev - baseline.ev).toFixed(2) });
  };
  for (const s of [0.25, 0.5, 1, 2]) cellStats(p => p.replayOutcome === "loss" ? p.replayPts - s : p.replayPts, `stop market-slip ${s}pt`);
  // limit-through: TP fills require price to trade 1 tick THROUGH the level
  cellStats(p => {
    const need = (x: number): number => { const i = Math.ceil(x / TICK); return i < p.upCross.length ? p.upCross[i] : -1; }; // one tick beyond
    const tD = (() => { const i = Math.ceil(p.sld / TICK) - 1; return i < p.dnCross.length ? p.dnCross[i] : -1; })();
    const tU1 = need(p.tp1d), tU2 = need(2 * p.tp1d);
    if (tD >= 0 && (tU1 < 0 || tD <= tU1)) return -p.sld;
    if (tU2 >= 0 && (tD < 0 || tU2 < tD)) return 2 * p.tp1d;
    if (tU1 >= 0) return p.tp1d;
    return p.marks.length ? p.marks[p.marks.length - 1] : 0;
  }, "targets as limits (1-tick through required)");
  cellStats(p => p.replayOutcome === "loss" ? p.replayPts - 0.5 : p.replayPts, "combined: stop slip 0.5"); // reference
  cellStats(p => {
    const slip = p.replayOutcome === "loss" ? 0.5 : 0;
    const need = (x: number): number => { const i = Math.ceil(x / TICK); return i < p.upCross.length ? p.upCross[i] : -1; };
    const tD = (() => { const i = Math.ceil(p.sld / TICK) - 1; return i < p.dnCross.length ? p.dnCross[i] : -1; })();
    const tU1 = need(p.tp1d), tU2 = need(2 * p.tp1d);
    if (tD >= 0 && (tU1 < 0 || tD <= tU1)) return -p.sld - 0.5;
    if (tU2 >= 0 && (tD < 0 || tU2 < tD)) return 2 * p.tp1d;
    if (tU1 >= 0) return p.tp1d;
    return (p.marks.length ? p.marks[p.marks.length - 1] : 0) - slip;
  }, "worst-case: limits-through + stop slip 0.5");

  // ── trailing variants on real paths (executable scoring) — feeds part c ──
  function trailOutcome(p: Profile, k: number, hybrid: boolean): number {
    const bars = barsStmt.all(SYMBOL, p.fireTs + 900 - 60, p.fireTs + 900 + CAP_SEC) as Bar[];
    const trailDist = k * (p.atr15 || p.sld / 2);
    let hi = -Infinity, stop = -Infinity, tp1Banked = false;
    for (const b of bars) {
      if (b.time < p.fireTs + 900) continue;
      const fav = p.dir === 1 ? b.high - p.entry : p.entry - b.low;
      const adv = p.dir === 1 ? p.entry - b.low : b.high - p.entry;
      if (hybrid && !tp1Banked) {
        if (adv >= p.sld) return -p.sld;               // fixed SL in phase 1
        if (fav >= 2 * p.tp1d) return 2 * p.tp1d;      // straight to TP2
        if (fav >= p.tp1d) { tp1Banked = true; hi = fav; stop = fav - trailDist; continue; }
      } else {
        // pure chandelier (or hybrid phase 2): stop from PREVIOUS bar's high (no look-ahead)
        if (stop > -Infinity && -adv <= stop) {         // favorable-signed low = -adv
          return Math.max(stop, -p.sld);
        }
        if (hybrid && fav >= 2 * p.tp1d) return 2 * p.tp1d;
        if (!hybrid && adv >= p.sld && stop === -Infinity) return -p.sld; // initial hard stop before trail arms
        if (fav > hi) { hi = fav; stop = Math.max(stop, hi - trailDist); }
      }
    }
    const lb = bars[bars.length - 1];
    return p.dir === 1 ? lb.close - p.entry : p.entry - lb.close; // unresolved: mark
  }
  const variants: Record<string, number[]> = { shipped: closedP.map(p => p.replayPts) };
  for (const [name, k, hy] of [["chandelier k=2", 2, false], ["chandelier k=3", 3, false], ["hybrid TP2+trail k=3", 3, true]] as Array<[string, number, boolean]>) {
    variants[name] = closedP.map(p => +trailOutcome(p, k, hy).toFixed(2));
  }
  const variantStats = Object.fromEntries(Object.entries(variants).map(([k2, v]) => [k2, stats(v)]));

  const out = {
    generated: new Date().toISOString(), trades: closedP.length, reproPct: +(100 * repro / profiles.length).toFixed(1),
    baseline, timeStops, decayBE, evPerMin, nearMissPctOfLosses: nearMiss, lossesN: losses.length,
    slipMatrix, variantStats,
    variants, // per-trade outcome arrays, chronological — part c consumes
    profilesMeta: closedP.map(p => ({ fireTs: p.fireTs, resolveMin: p.resolveMin })),
  };
  fs.writeFileSync(path.join(OUT_DIR, "exit-sim-a.json"), JSON.stringify(out));
  console.log("[A] baseline", JSON.stringify(baseline));
  console.log("[A] timeStops", JSON.stringify(timeStops));
  console.log("[A] decayBE", JSON.stringify(decayBE));
  console.log("[A] evPerMin", JSON.stringify(evPerMin));
  console.log("[A] nearMiss% of losses", JSON.stringify(nearMiss), "losses:", losses.length);
  console.log("[A] slippage:"); for (const r of slipMatrix) console.log("   ", r.label, "ev", r.ev, "(", r.dEv, ")");
  console.log("[A] variants", JSON.stringify(variantStats));
}

// ═════ PART B — synthetic paths (GBM+jumps, GARCH) ═════
function partB(): void {
  const now = Math.floor(Date.now() / 1000);
  const rets: Array<{ hour: number; r: number }> = [];
  {
    const bars = barsStmt.all(SYMBOL, now - 90 * 86400, now) as Bar[];
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].time - bars[i - 1].time > 120) continue; // session gap — not a 1m return
      const hour = new Date(bars[i].time * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false });
      rets.push({ hour: parseInt(hour, 10), r: bars[i].close - bars[i - 1].close });
    }
  }
  const all = rets.map(x => x.r);
  const sd = Math.sqrt(all.reduce((a, b) => a + b * b, 0) / all.length);
  const hourSd: number[] = [];
  for (let h = 0; h < 24; h++) {
    const hs = rets.filter(x => x.hour === h).map(x => x.r);
    hourSd[h] = hs.length > 200 ? Math.sqrt(hs.reduce((a, b) => a + b * b, 0) / hs.length) : sd;
  }
  const jumps = all.filter(r => Math.abs(r) > 4 * sd);
  const jumpProb = jumps.length / all.length;
  const jumpSd = jumps.length ? Math.sqrt(jumps.reduce((a, b) => a + b * b, 0) / jumps.length) : 8 * sd;
  // GARCH(1,1) small-grid pseudo-MLE with variance targeting
  let best = { a: 0.1, b: 0.85, ll: -Infinity };
  for (const a of [0.05, 0.08, 0.12, 0.16]) for (const b of [0.8, 0.84, 0.88, 0.92]) {
    if (a + b >= 0.995) continue;
    const w = sd * sd * (1 - a - b);
    let v = sd * sd, ll = 0;
    for (const x of all) { ll += -Math.log(v) - (x * x) / v; v = w + a * x * x + b * v; }
    if (ll > best.ll) best = { a, b, ll };
  }
  console.log(`[B] calib: 1m sd ${sd.toFixed(3)}pt, jumpProb ${(100 * jumpProb).toFixed(3)}%/min (sd ${jumpSd.toFixed(2)}), GARCH a=${best.a} b=${best.b}`);

  const HORIZON = 900, NPATH = 500;
  const r = rng(1234567);
  const gauss = (): number => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * v); };
  const aDoc = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "exit-sim-a.json"), "utf8")) as { profilesMeta: Array<{ fireTs: number }> };
  const byFire = new Map(trades.map(t => [t.fireTs, t]));
  const entries = aDoc.profilesMeta.map(m => byFire.get(m.fireTs)).filter(Boolean) as BookTrade[];

  function runModel(model: "gbm" | "garch"): Record<string, { ev: number; win: number; prematurePct: number }> {
    const res: Record<string, { pts: number[]; premature: number; trailN: number }> = {
      fixed: { pts: [], premature: 0, trailN: 0 }, trailK3: { pts: [], premature: 0, trailN: 0 },
    };
    for (const t of entries) {
      const tp1d = Math.abs(t.tp1 - t.entry), sld = Math.abs(t.sl - t.entry);
      const startHour = parseInt(new Date(t.entryTs * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }), 10);
      const trailDist = 3 * (sld / 2); // ATR proxy: sld≈p85 MAE ≈ 2×ATR15 on this stream
      for (let p = 0; p < NPATH; p++) {
        let x = 0, v = sd * sd;
        let fixedDone = 0; let tp1Hit = false;
        let hi = 0, stop = -Infinity, trailExit: number | null = null, trailMin = -1;
        let up = 0;
        const w = sd * sd * (1 - best.a - best.b);
        for (let m = 1; m <= HORIZON; m++) {
          let step: number;
          if (model === "gbm") {
            const hsd = hourSd[(startHour + Math.floor(m / 60)) % 24];
            step = hsd * gauss() + (r() < jumpProb ? jumpSd * gauss() : 0);
          } else {
            step = Math.sqrt(v) * gauss();
            v = w + best.a * step * step + best.b * v;
          }
          x += step;
          up = Math.max(up, x);
          if (!fixedDone) {
            if (x <= -sld && !tp1Hit) { res.fixed.pts.push(-sld); fixedDone = m; }
            else if (x >= 2 * tp1d) { res.fixed.pts.push(2 * tp1d); fixedDone = m; }
            else if (x >= tp1d) tp1Hit = true;
            else if (tp1Hit && x <= -sld) { res.fixed.pts.push(tp1d); fixedDone = m; }
          }
          if (trailExit == null) {
            if (stop > -Infinity && x <= stop) { trailExit = Math.max(stop, -sld); trailMin = m; }
            else if (x <= -sld && stop === -Infinity) { trailExit = -sld; trailMin = m; }
            else if (up - trailDist > stop) stop = up - trailDist;
          }
          if (fixedDone && trailExit != null) break;
        }
        if (!fixedDone) res.fixed.pts.push(tp1Hit ? tp1d : x);
        if (trailExit == null) { trailExit = x; trailMin = HORIZON; }
        res.trailK3.pts.push(trailExit);
        res.trailK3.trailN++;
        // premature: trail exited below TP1 while the path went on to reach TP1 later
        if (trailExit < tp1d && trailMin < HORIZON) {
          // re-scan not stored; approximate premature = exited < tp1d but max favorable up >= tp1d
          if (up >= tp1d) res.trailK3.premature++;
        }
      }
    }
    const s = (v: { pts: number[]; premature: number; trailN: number }): { ev: number; win: number; prematurePct: number } => ({
      ev: +(v.pts.reduce((a, b) => a + b, 0) / v.pts.length - FRICTION).toFixed(2),
      win: +(100 * v.pts.filter(x => x > 0).length / v.pts.length).toFixed(1),
      prematurePct: v.trailN ? +(100 * v.premature / v.trailN).toFixed(1) : 0,
    });
    return { fixed: s(res.fixed), trailK3: s(res.trailK3) };
  }
  const gbm = runModel("gbm"), garch = runModel("garch");
  const out = { generated: new Date().toISOString(), calib: { sd1m: +sd.toFixed(4), jumpProbPerMin: +jumpProb.toFixed(5), jumpSd: +jumpSd.toFixed(2), garch: { alpha: best.a, beta: best.b } }, nEntries: entries.length, nPathsPerEntry: NPATH, horizonMin: HORIZON, gbm, garch, note: "Synthetic paths have NO zone/vector/S-R structure — absolute EVs are meaningless; only the RELATIVE fixed-vs-trailing sensitivity is informative." };
  fs.writeFileSync(path.join(OUT_DIR, "exit-sim-b.json"), JSON.stringify(out));
  console.log("[B] GBM  ", JSON.stringify(gbm));
  console.log("[B] GARCH", JSON.stringify(garch));
}

// ═════ PART C — block-bootstrap MC over part-a variants ═════
function partC(): void {
  const aDoc = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "exit-sim-a.json"), "utf8")) as { variants: Record<string, number[]> };
  const N = 5000, H = 100, L = 10, RUIN = -200;
  const out: Record<string, { ev100: number; p95MaxDD: number; p99MaxDD: number; ruinPct: number }> = {};
  for (const [name, ptsGross] of Object.entries(aDoc.variants)) {
    const pts = ptsGross.map(x => x - FRICTION);
    const rr = rng(424242);
    const dds: number[] = [], finals: number[] = []; let ruin = 0;
    for (let k = 0; k < N; k++) {
      let c = 0, peak = 0, dd = 0, ruined = false;
      for (let filled = 0; filled < H;) {
        const start = Math.floor(rr() * (pts.length - L));
        for (let j = 0; j < L && filled < H; j++, filled++) {
          c += pts[start + j];
          if (c > peak) peak = c;
          if (peak - c > dd) dd = peak - c;
          if (c <= RUIN) ruined = true;
        }
      }
      dds.push(dd); finals.push(c); if (ruined) ruin++;
    }
    dds.sort((a, b) => a - b); finals.sort((a, b) => a - b);
    out[name] = { ev100: +(finals.reduce((a, b) => a + b, 0) / N).toFixed(1), p95MaxDD: +pctl(dds, 0.95).toFixed(1), p99MaxDD: +pctl(dds, 0.99).toFixed(1), ruinPct: +(100 * ruin / N).toFixed(2) };
  }
  fs.writeFileSync(path.join(OUT_DIR, "exit-sim-c.json"), JSON.stringify({ generated: new Date().toISOString(), nResamples: N, horizon: H, blockLen: L, ruinThresholdNetPts: RUIN, results: out }, null, 2));
  for (const [k, v] of Object.entries(out)) console.log("[C]", k, JSON.stringify(v));
}

// ═════ PART D — walk-forward exit optimization on first-crossing profiles ═════
function partD(): void {
  // Full-history rows live in the DB (the artifact stores only aggregates).
  const cut = Math.floor(new Date("2025-06-01T00:00:00Z").getTime() / 1000);
  const standingStart = trades[0].fireTs;
  const fhRows = db.prepare(
    `SELECT timestamp, direction, entry FROM signal_history
     WHERE symbol=? AND interval='15m' AND timestamp>=? AND timestamp<? AND entry IS NOT NULL ORDER BY timestamp`,
  ).all(SYMBOL, cut, standingStart) as Array<{ timestamp: number; direction: string; entry: number }>;
  const pop: Array<{ fireTs: number; entryTs: number; dir: 1 | -1; entry: number }> = [];
  for (const s of fhRows) pop.push({ fireTs: s.timestamp, entryTs: s.timestamp + 900, dir: s.direction.toLowerCase() === "long" ? 1 : -1, entry: s.entry });
  for (const t of trades) pop.push({ fireTs: t.fireTs, entryTs: t.entryTs, dir: t.direction.toLowerCase() === "long" ? 1 : -1, entry: t.entry });
  pop.sort((a, b) => a.fireTs - b.fireTs);
  console.log(`[D] population: ${pop.length} trades (${new Date(pop[0].fireTs * 1000).toISOString().slice(0, 10)} → ${new Date(pop[pop.length - 1].fireTs * 1000).toISOString().slice(0, 10)})`);

  // Build lightweight crossing profiles (up/dn first-cross minute arrays) + ATR15.
  interface P2 { fireTs: number; up: number[]; dn: number[]; atr15: number }
  const MAXT = 200;
  const profiles: P2[] = [];
  for (const t of pop) {
    const bars = barsStmt.all(SYMBOL, t.entryTs - 60, t.entryTs + CAP_SEC) as Bar[];
    if (bars.length < 30) continue;
    const a15 = bars15Stmt.all(SYMBOL, t.entryTs) as Bar[];
    let atr15 = 0;
    if (a15.length >= 2) { const rev = [...a15].reverse(); let s = 0, n = 0; for (let i = 1; i < rev.length; i++) { s += Math.max(rev[i].high - rev[i].low, Math.abs(rev[i].high - rev[i - 1].close), Math.abs(rev[i].low - rev[i - 1].close)); n++; } atr15 = s / n; }
    const up = new Array(MAXT).fill(-1), dn = new Array(MAXT).fill(-1);
    let upMax = 0, dnMax = 0;
    for (const b of bars) {
      if (b.time < t.entryTs) continue;
      const min = Math.floor((b.time - t.entryTs) / 60);
      const fav = t.dir === 1 ? b.high - t.entry : t.entry - b.low;
      const adv = t.dir === 1 ? t.entry - b.low : b.high - t.entry;
      if (fav > upMax) { for (let i = Math.floor(upMax / TICK); i < Math.min(MAXT, Math.floor(fav / TICK)); i++) if (up[i] < 0) up[i] = min; upMax = fav; }
      if (adv > dnMax) { for (let i = Math.floor(dnMax / TICK); i < Math.min(MAXT, Math.floor(adv / TICK)); i++) if (dn[i] < 0) dn[i] = min; dnMax = adv; }
    }
    profiles.push({ fireTs: t.fireTs, up, dn, atr15: atr15 || 4 });
  }
  console.log(`[D] profiles built: ${profiles.length}`);

  const score = (p: P2, tp1: number, sl: number): number => {
    const iU = Math.ceil(tp1 / TICK) - 1, iU2 = Math.ceil(2 * tp1 / TICK) - 1, iD = Math.ceil(sl / TICK) - 1;
    const tU1 = iU < MAXT ? p.up[iU] : -1, tU2 = iU2 < MAXT ? p.up[iU2] : -1, tD = iD < MAXT ? p.dn[iD] : -1;
    if (tD >= 0 && (tU1 < 0 || tD <= tU1)) return -sl;
    if (tU2 >= 0 && (tD < 0 || tU2 < tD)) return 2 * tp1;
    if (tU1 >= 0) return tp1;
    return 0;
  };
  const p85 = (arr: number[]): number => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(0.85 * s.length))] : 20; };
  const maeOfWinner = (p: P2, tp1: number): number => { // deepest adverse cross before TP1 time
    const iU = Math.ceil(tp1 / TICK) - 1; const tU1 = iU < MAXT ? p.up[iU] : -1;
    if (tU1 < 0) return -1;
    let mae = 0;
    for (let i = 0; i < MAXT; i++) { const v = p.dn[i]; if (v < 0) break; if (v <= tU1) mae = (i + 1) * TICK; else break; }
    return mae;
  };
  const GRID = [8, 9.25, 10.5, 11.75, 13, 13.75, 15.5, 17, 18.25, 19.5];
  function optimize(set: P2[], dynamic: boolean): { pick: { tp1: number | null; m: number | null; sl: number }; netExp: number } {
    let cells: Array<{ tp1: number | null; m: number | null; sl: number; netExp: number; win: number }> = [];
    if (!dynamic) {
      for (const tp1 of GRID) {
        const maes = set.map(p => maeOfWinner(p, tp1)).filter(x => x >= 0);
        const sl = Math.min(40, Math.max(tp1, p85(maes)));
        const pts = set.map(p => score(p, tp1, sl) - FRICTION);
        cells.push({ tp1, m: null, sl: +sl.toFixed(2), netExp: pts.reduce((a, b) => a + b, 0) / pts.length, win: pts.filter(x => x > 0).length / pts.length });
      }
    } else {
      for (const m of [1.5, 2, 2.5, 3, 3.5, 4]) {
        const outs = set.map(p => { const tp1 = Math.max(4, Math.round(m * p.atr15 / TICK) * TICK); const sl = Math.min(40, Math.max(tp1, 1.7 * tp1)); return score(p, tp1, sl) - FRICTION; });
        cells.push({ tp1: null, m, sl: 0, netExp: outs.reduce((a, b) => a + b, 0) / outs.length, win: outs.filter(x => x > 0).length / outs.length });
      }
    }
    const bestExp = Math.max(...cells.map(c => c.netExp));
    const eligible = cells.filter(c => c.netExp >= 0.85 * bestExp);
    const pick = eligible.reduce((a, b) => (b.win > a.win ? b : a), eligible[0]);
    return { pick: { tp1: pick.tp1, m: pick.m, sl: pick.sl }, netExp: pick.netExp };
  }
  const applyPick = (set: P2[], pick: { tp1: number | null; m: number | null; sl: number }): number => {
    const pts = set.map(p => {
      const tp1 = pick.tp1 ?? Math.max(4, Math.round((pick.m as number) * p.atr15 / TICK) * TICK);
      const sl = pick.tp1 != null ? pick.sl : Math.min(40, Math.max(tp1, 1.7 * tp1));
      return score(p, tp1, sl) - FRICTION;
    });
    return pts.reduce((a, b) => a + b, 0) / pts.length;
  };

  const MONTH = 30 * 86400;
  const t0 = profiles[0].fireTs;
  const windows: Array<{ oosStart: string; static: { pick: string; is: number; oos: number; wfe: number }; dynamic: { pick: string; is: number; oos: number; wfe: number }; nIS: number; nOOS: number }> = [];
  for (let ws = t0; ws + 4 * MONTH <= profiles[profiles.length - 1].fireTs + MONTH; ws += MONTH) {
    const is = profiles.filter(p => p.fireTs >= ws && p.fireTs < ws + 3 * MONTH);
    const oos = profiles.filter(p => p.fireTs >= ws + 3 * MONTH && p.fireTs < ws + 4 * MONTH);
    if (is.length < 60 || oos.length < 15) continue;
    const st = optimize(is, false), dy = optimize(is, true);
    const stO = applyPick(oos, st.pick), dyO = applyPick(oos, dy.pick);
    windows.push({
      oosStart: new Date((ws + 3 * MONTH) * 1000).toISOString().slice(0, 10),
      static: { pick: `tp1 ${st.pick.tp1}/sl ${st.pick.sl}`, is: +st.netExp.toFixed(2), oos: +stO.toFixed(2), wfe: +(stO / st.netExp).toFixed(2) },
      dynamic: { pick: `m=${st.pick.m ?? dy.pick.m}×ATR`, is: +dy.netExp.toFixed(2), oos: +dyO.toFixed(2), wfe: +(dyO / dy.netExp).toFixed(2) },
      nIS: is.length, nOOS: oos.length,
    });
  }
  // micro-scan around shipped TP1 (near-miss follow-up) on the standing-book slice
  const standing = profiles.filter(p => p.fireTs >= standingStart);
  const micro = [13.0, 13.25, 13.5, 13.75, 14.0].map(tp1 => {
    const pts = standing.map(p => score(p, tp1, 23) - FRICTION);
    return { tp1, netExp: +(pts.reduce((a, b) => a + b, 0) / pts.length).toFixed(3), win: +(100 * pts.filter(x => x > 0).length / pts.length).toFixed(1) };
  });
  const wfeAvg = (k: "static" | "dynamic"): number => +(windows.reduce((a, w) => a + w[k].wfe, 0) / windows.length).toFixed(2);
  const out = { generated: new Date().toISOString(), population: profiles.length, windows, wfeAvgStatic: wfeAvg("static"), wfeAvgDynamic: wfeAvg("dynamic"), microScanTp1: micro };
  fs.writeFileSync(path.join(OUT_DIR, "exit-sim-d.json"), JSON.stringify(out, null, 2));
  for (const w of windows) console.log("[D]", w.oosStart, "static", JSON.stringify(w.static), "dyn", JSON.stringify(w.dynamic));
  console.log("[D] WFE avg static", wfeAvg("static"), "dynamic", wfeAvg("dynamic"));
  console.log("[D] micro-scan", JSON.stringify(micro));
}

if (part === "a") partA();
else if (part === "b") partB();
else if (part === "c") partC();
else if (part === "d") partD();
db.close();
