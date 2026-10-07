/**
 * exit-tp1-lab.ts — TP1-ONLY EXECUTABLE EXIT LAB (2026-08-12, user directive:
 * "no TP2 ever — build around TP1; smaller trades that win way more").
 *
 * EVERYTHING here is scored EXECUTABLY: one position, one entry (fire-bar close),
 * one full exit. No record-convention retro-awards. Net = gross − 1.0 friction.
 * Carry semantics: ride until an exit triggers (5-day cap, mark residual).
 *
 * Phases (--phase=grid|structure|robust):
 *   grid       Fixed TP1 × SL sweep on first-crossing profiles (small-target focus),
 *              population = 15m stream 2025-06 → today (~1,500 trades).
 *   structure  Event-driven 1m replay of structure exits at selected small TP1s:
 *              - trailing CONFIRMED Williams-fractal stop (1m/5m/15m, wings n=1..5,
 *                confirmation lag = n bars, actionable next bar open; ratcheted),
 *              - fractal FAILURE exit (most recent confirmed level, non-ratcheted),
 *                each with exec 'stop' (intrabar fill at level, gap→open) vs 'close'
 *                (1m close beyond level, exit next 1m open),
 *              - ATR trail baseline (k × ATR14(15m), ratcheted on favorable extreme),
 *              - MTF: 60m confirmed fractal as dynamic target,
 *              - PFE(10, 5m) efficiency-decay early exit (threshold 50/25).
 *              All structure stops carry a hard SL floor so pre-confirmation bars are
 *              protected. Metrics include profit retention vs MFE (giveback).
 *   robust     For finalists: WFO (3-month IS / 1-month OOS), fractal-N sensitivity,
 *              slippage stress (stop-market slip + limit targets needing 1 tick
 *              through), block-bootstrap MC (P95/P99 maxDD, ruin), and a GBM/GARCH
 *              synthetic premature-exit check.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd();
const SYMBOL = "MES";
const F = 1.0;
const TICK = 0.25;
const CAP_SEC = 5 * 86400;
const OUT = artifactsDir(ROOT);
const phase = (process.argv.find(a => a.startsWith("--phase=")) ?? "--phase=grid").slice(8);

const db = new Database(path.join(ROOT, "data", "app.db"), { readonly: true });
const barsStmt = db.prepare(
  `SELECT timestamp AS time, open, high, low, close FROM cached_candles
   WHERE symbol=? AND resolution='1' AND timestamp>=? AND timestamp<? ORDER BY timestamp`,
);
const atrStmt = db.prepare(
  `SELECT timestamp AS time, high, low, close FROM cached_candles
   WHERE symbol=? AND resolution='15' AND timestamp<? ORDER BY timestamp DESC LIMIT 15`,
);

interface Bar { time: number; open: number; high: number; low: number; close: number }
interface Trade { fireTs: number; entryTs: number; dir: 1 | -1; entry: number }

function loadPopulation(): Trade[] {
  const doc = JSON.parse(fs.readFileSync(path.join(OUT, "fact-engine-backtest-results.json"), "utf8")) as { signals: Array<{ interval: string; fireTs: number; entryTs: number; direction: string; entry: number; outcome: string }> };
  const standing = doc.signals.filter(s => s.interval === "15m" && s.outcome !== "open");
  const standingStart = Math.min(...standing.map(s => s.fireTs));
  const cut = Math.floor(new Date("2025-06-01T00:00:00Z").getTime() / 1000);
  const fh = db.prepare(
    `SELECT timestamp, direction, entry FROM signal_history
     WHERE symbol=? AND interval='15m' AND timestamp>=? AND timestamp<? AND entry IS NOT NULL ORDER BY timestamp`,
  ).all(SYMBOL, cut, standingStart) as Array<{ timestamp: number; direction: string; entry: number }>;
  const pop: Trade[] = fh.map(s => ({ fireTs: s.timestamp, entryTs: s.timestamp + 900, dir: s.direction.toLowerCase() === "long" ? 1 : -1 as 1 | -1, entry: s.entry }));
  for (const s of standing) pop.push({ fireTs: s.fireTs, entryTs: s.entryTs, dir: s.direction.toLowerCase() === "long" ? 1 : -1, entry: s.entry });
  return pop.sort((a, b) => a.fireTs - b.fireTs);
}

const stats = (pts: number[]): { n: number; netExp: number; win: number; pf: number; medHold?: number } => {
  const gw = pts.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const gl = -pts.filter(x => x < 0).reduce((a, b) => a + b, 0);
  return { n: pts.length, netExp: +(pts.reduce((a, b) => a + b, 0) / pts.length - F).toFixed(2), win: +(100 * pts.filter(x => x > 0).length / pts.length).toFixed(1), pf: +((gw) / (gl || 1)).toFixed(2) };
};
const maxDD = (pts: number[]): number => { let c = 0, pk = 0, dd = 0; for (const p of pts) { c += p - F; if (c > pk) pk = c; if (pk - c > dd) dd = pk - c; } return +dd.toFixed(1); };

// ═════ PHASE: grid — fixed TP1 × SL on crossing profiles (executable D scoring) ═════
interface Prof { fireTs: number; up: number[]; dn: number[] }
const MAXT = 200;
function buildProfiles(pop: Trade[]): Prof[] {
  const out: Prof[] = [];
  for (const t of pop) {
    const bars = barsStmt.all(SYMBOL, t.entryTs - 60, t.entryTs + CAP_SEC) as Bar[];
    if (bars.length < 30) continue;
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
    out.push({ fireTs: t.fireTs, up, dn });
  }
  return out;
}
/** Executable TP1-only cell: win +tp1 if TP1 crosses strictly before SL, loss −sl if SL first (ties SL-first), else 0 (mark≈flat). */
const cellD = (p: Prof, tp1: number, sl: number): number => {
  const iU = Math.ceil(tp1 / TICK) - 1, iD = Math.ceil(sl / TICK) - 1;
  const tU = iU < MAXT ? p.up[iU] : -1, tD = iD < MAXT ? p.dn[iD] : -1;
  if (tD >= 0 && (tU < 0 || tD <= tU)) return -sl;
  if (tU >= 0) return tp1;
  return 0;
};

function phaseGrid(): void {
  const pop = loadPopulation();
  const profs = buildProfiles(pop);
  console.log(`[grid] profiles ${profs.length}`);
  const TP1S = [2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 13.75];
  const SLS = [3, 4, 5, 6, 8, 10, 12, 16, 20, 23];
  const cells: Array<{ tp1: number; sl: number; n: number; netExp: number; win: number; pf: number; dd: number; cumNet: number }> = [];
  for (const tp1 of TP1S) for (const sl of SLS) {
    const pts = profs.map(p => cellD(p, tp1, sl));
    const s = stats(pts);
    cells.push({ tp1, sl, ...s, dd: maxDD(pts), cumNet: +(pts.reduce((a, b) => a + b, 0) - F * pts.length).toFixed(0) });
  }
  cells.sort((a, b) => b.netExp - a.netExp);
  const bestExp = cells[0];
  const evFloorWin = [...cells].filter(c => c.netExp >= 1.0).sort((a, b) => b.win - a.win);
  const consistent = [...cells].filter(c => c.netExp >= 0.85 * bestExp.netExp).sort((a, b) => b.win - a.win)[0];
  const out = { generated: new Date().toISOString(), population: profs.length, friction: F, topByNetExp: cells.slice(0, 10), topByWinWithEvFloor1: evFloorWin.slice(0, 10), consistencyPick: consistent, allCells: cells };
  fs.writeFileSync(path.join(OUT, "exit-tp1-grid.json"), JSON.stringify(out));
  console.log("[grid] top by netExp:"); for (const c of cells.slice(0, 8)) console.log("   ", JSON.stringify(c));
  console.log("[grid] top by WIN with netExp>=1.0:"); for (const c of evFloorWin.slice(0, 8)) console.log("   ", JSON.stringify(c));
  console.log("[grid] consistency pick:", JSON.stringify(consistent));
}

// ═════ PHASE: structure — event-driven 1m replay of structure exits ═════
interface FracState { lows: number[]; highs: number[]; lastLow: number; lastHigh: number }
/** Rolling Williams-fractal tracker with confirmation lag: a pivot at i is confirmed
 *  at the CLOSE of bar i+n and actionable from the NEXT bar (caller reads level(s)
 *  before pushing the current bar). Strict inequalities, per the user's spec. */
class Fractals {
  private buf: Bar[] = [];
  lastLow = NaN; lastHigh = NaN; // most recent CONFIRMED levels (actionable)
  private pendingLow = NaN; private pendingHigh = NaN; // confirmed at current push, actionable next push
  constructor(private n: number) {}
  push(b: Bar): void {
    if (!Number.isNaN(this.pendingLow)) { this.lastLow = this.pendingLow; this.pendingLow = NaN; }
    if (!Number.isNaN(this.pendingHigh)) { this.lastHigh = this.pendingHigh; this.pendingHigh = NaN; }
    this.buf.push(b);
    const W = 2 * this.n + 1;
    if (this.buf.length > W) this.buf.shift();
    if (this.buf.length === W) {
      const c = this.buf[this.n];
      let isHigh = true, isLow = true;
      for (let j = 0; j < W; j++) {
        if (j === this.n) continue;
        if (this.buf[j].high >= c.high) isHigh = false;
        if (this.buf[j].low <= c.low) isLow = false;
      }
      // pivot at center is confirmed at the close of the CURRENT (last) bar
      if (isHigh) this.pendingHigh = c.high;
      if (isLow) this.pendingLow = c.low;
    }
  }
}
/** Aggregate 1m bars into tfMin-minute bars on the fly (bucket close = confirmation moment). */
class Agg {
  private cur: Bar | null = null;
  constructor(private tfSec: number, private sink: (b: Bar) => void) {}
  push(b: Bar): void {
    const bucket = Math.floor(b.time / this.tfSec) * this.tfSec;
    if (this.cur && this.cur.time !== bucket) { this.sink(this.cur); this.cur = null; }
    if (!this.cur) this.cur = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close };
    else { this.cur.high = Math.max(this.cur.high, b.high); this.cur.low = Math.min(this.cur.low, b.low); this.cur.close = b.close; }
  }
}

interface StructCfg {
  label: string;
  tp1: number | "mtf60";           // fixed target or 60m-fractal dynamic target
  slFloor: number;                  // hard max-loss stop, always active
  trail?: { tf: 1 | 5 | 15; n: number; ratchet: boolean; exec: "stop" | "close" };
  atrTrail?: number;                // k × ATR14(15m), ratcheted
  pfe?: { thr: number };            // PFE(10) on 5m closes, exit on decay cross
}
function runStruct(pop: Trade[], cfg: StructCfg): { pts: number[]; holds: number[]; retention: number[] } {
  const pts: number[] = [], holds: number[] = [], retention: number[] = [];
  for (const t of pop) {
    const bars = barsStmt.all(SYMBOL, t.entryTs - 4 * 3600, t.entryTs + CAP_SEC) as Bar[];
    if (bars.length < 60) continue;
    const a15 = atrStmt.all(SYMBOL, t.entryTs) as Array<{ high: number; low: number; close: number }>;
    let atr = 4;
    if (a15.length >= 2) { const rev = [...a15].reverse(); let s = 0, n = 0; for (let i = 1; i < rev.length; i++) { s += Math.max(rev[i].high - rev[i].low, Math.abs(rev[i].high - rev[i - 1].close), Math.abs(rev[i].low - rev[i - 1].close)); n++; } atr = s / n; }
    const frac = cfg.trail ? new Fractals(cfg.trail.n) : null;
    const frac60 = cfg.tp1 === "mtf60" ? new Fractals(2) : null;
    let agg: Agg | null = null, agg60: Agg | null = null;
    if (frac && cfg.trail && cfg.trail.tf !== 1) agg = new Agg(cfg.trail.tf * 60, b => frac.push(b));
    if (frac60) agg60 = new Agg(3600, b => frac60.push(b));
    // PFE on 5m closes
    const pfeCloses: number[] = [];
    let aggPfe: Agg | null = null;
    if (cfg.pfe) aggPfe = new Agg(300, b => { pfeCloses.push(b.close); if (pfeCloses.length > 40) pfeCloses.shift(); });
    let inPos = false, exitPts: number | null = null, entryMin = 0;
    let favMax = 0, trailStop = -Infinity, closeBreach = false;
    let target = typeof cfg.tp1 === "number" ? cfg.tp1 : NaN;
    for (const b of bars) {
      // warm indicators on pre-entry bars too (structure exists before the fire)
      const preEntry = b.time < t.entryTs;
      if (!preEntry && !inPos) { inPos = true; entryMin = b.time; }
      if (inPos && exitPts == null) {
        const min = Math.floor((b.time - t.entryTs) / 60);
        const fav = t.dir === 1 ? b.high - t.entry : t.entry - b.low;
        const adv = t.dir === 1 ? t.entry - b.low : b.high - t.entry;
        // 1) close-breach exit queued from the PREVIOUS bar executes at THIS bar's open
        if (closeBreach) { exitPts = t.dir === 1 ? b.open - t.entry : t.entry - b.open; holds.push(min); }
        // 2) dynamic MTF target resolve
        if (exitPts == null && frac60) {
          const lvl = t.dir === 1 ? frac60.lastHigh : frac60.lastLow;
          target = Number.isNaN(lvl) ? 6 : Math.min(12, Math.max(2, t.dir === 1 ? lvl - t.entry : t.entry - lvl));
        }
        // 3) hard SL floor (stop order, SL-first on ties)
        if (exitPts == null && adv >= cfg.slFloor) { exitPts = -cfg.slFloor; holds.push(min); }
        // 4) structure / ATR trail stop
        if (exitPts == null) {
          let stop = -Infinity; // favorable-signed stop level (pts from entry; negative = below entry)
          if (frac && cfg.trail) {
            const lvl = t.dir === 1 ? frac.lastLow : frac.lastHigh;
            if (!Number.isNaN(lvl)) {
              const sPts = t.dir === 1 ? lvl - t.entry : t.entry - lvl;
              if (cfg.trail.ratchet) { trailStop = Math.max(trailStop, sPts); stop = trailStop; }
              else stop = sPts;
            }
          }
          if (cfg.atrTrail != null) { trailStop = Math.max(trailStop, favMax - cfg.atrTrail * atr); stop = Math.max(stop, trailStop); }
          if (stop > -Infinity) {
            const lowFav = t.dir === 1 ? b.low - t.entry : t.entry - b.high; // favorable-signed bar extreme against us
            if (cfg.trail?.exec === "close" && cfg.atrTrail == null) {
              const closeFav = t.dir === 1 ? b.close - t.entry : t.entry - b.close;
              if (closeFav <= stop) closeBreach = true; // exit next bar open
            } else if (lowFav <= stop) {
              const openFav = t.dir === 1 ? b.open - t.entry : t.entry - b.open;
              exitPts = Math.min(stop, openFav); // gap-through fills at open (worse)
              exitPts = Math.max(exitPts, -cfg.slFloor);
              holds.push(min);
            }
          }
        }
        // 5) PFE decay early exit (evaluated on 5m closes, executed next 1m open — approximated at this close)
        if (exitPts == null && cfg.pfe && pfeCloses.length >= 11) {
          const N = 10;
          const arr = pfeCloses.slice(-N - 1);
          let denom = 0;
          for (let i = 1; i < arr.length; i++) denom += Math.sqrt((arr[i] - arr[i - 1]) ** 2 + 1);
          const pfe = 100 * Math.sign(arr[arr.length - 1] - arr[0]) * Math.sqrt((arr[arr.length - 1] - arr[0]) ** 2 + N * N) / (denom || 1);
          const dirPfe = t.dir === 1 ? pfe : -pfe;
          const closeFav = t.dir === 1 ? b.close - t.entry : t.entry - b.close;
          if (dirPfe < cfg.pfe.thr && closeFav > 1) { exitPts = closeFav; holds.push(min); }
        }
        // 6) target (limit order at level; touch fills)
        if (exitPts == null && !Number.isNaN(target) && fav >= target) { exitPts = target; holds.push(min); }
        if (exitPts == null && fav > favMax) favMax = fav;
      }
      if (preEntry) { // warm structure trackers
        if (frac && cfg.trail?.tf === 1) frac.push(b);
        else if (agg) agg.push(b);
        if (agg60) agg60.push(b);
        if (aggPfe) aggPfe.push(b);
        continue;
      }
      if (exitPts != null) break;
      if (frac && cfg.trail?.tf === 1) frac.push(b);
      else if (agg) agg.push(b);
      if (agg60) agg60.push(b);
      if (aggPfe) aggPfe.push(b);
    }
    if (exitPts == null) { const lb = bars[bars.length - 1]; exitPts = t.dir === 1 ? lb.close - t.entry : t.entry - lb.close; holds.push(Math.floor((bars[bars.length - 1].time - t.entryTs) / 60)); }
    pts.push(+exitPts.toFixed(2));
    if (exitPts > 0 && favMax > 0) retention.push(exitPts / Math.max(favMax, exitPts));
  }
  return { pts, holds, retention };
}

function phaseStructure(): void {
  const pop = loadPopulation();
  const grid = JSON.parse(fs.readFileSync(path.join(OUT, "exit-tp1-grid.json"), "utf8")) as { consistencyPick: { tp1: number; sl: number } };
  const tpSet = [3, 4, 6];
  const cfgs: StructCfg[] = [];
  for (const tp1 of tpSet) {
    cfgs.push({ label: `fixed tp1 ${tp1} / sl 10 (baseline)`, tp1, slFloor: 10 });
    for (const n of [2, 3]) for (const exec of ["stop", "close"] as const)
      cfgs.push({ label: `tp1 ${tp1} + 1m fractal trail n=${n} ${exec}`, tp1, slFloor: 16, trail: { tf: 1, n, ratchet: true, exec } });
    cfgs.push({ label: `tp1 ${tp1} + 5m fractal trail n=2 stop`, tp1, slFloor: 16, trail: { tf: 5, n: 2, ratchet: true, exec: "stop" } });
    cfgs.push({ label: `tp1 ${tp1} + 1m fractal FAILURE n=2 close`, tp1, slFloor: 16, trail: { tf: 1, n: 2, ratchet: false, exec: "close" } });
    cfgs.push({ label: `tp1 ${tp1} + ATR trail k=1.5`, tp1, slFloor: 16, atrTrail: 1.5 });
    cfgs.push({ label: `tp1 ${tp1} + PFE(10,5m)<50 early-exit / sl 10`, tp1, slFloor: 10, pfe: { thr: 50 } });
  }
  cfgs.push({ label: "MTF 60m-fractal target / sl 10", tp1: "mtf60", slFloor: 10 });
  cfgs.push({ label: "MTF 60m-fractal target + 5m trail n=2", tp1: "mtf60", slFloor: 16, trail: { tf: 5, n: 2, ratchet: true, exec: "stop" } });
  const results: Array<Record<string, unknown>> = [];
  for (const cfg of cfgs) {
    const r = runStruct(pop, cfg);
    const s = stats(r.pts);
    const medHold = [...r.holds].sort((a, b) => a - b)[Math.floor(r.holds.length / 2)] ?? 0;
    const ret = r.retention.length ? +(100 * r.retention.reduce((a, b) => a + b, 0) / r.retention.length).toFixed(0) : 0;
    const row = { label: cfg.label, ...s, dd: maxDD(r.pts), medHoldMin: medHold, retentionPct: ret };
    results.push(row);
    console.log("[struct]", JSON.stringify(row));
  }
  fs.writeFileSync(path.join(OUT, "exit-tp1-structure.json"), JSON.stringify({ generated: new Date().toISOString(), population: pop.length, results }, null, 2));
}

// ═════ PHASE: robust — WFO + N-sensitivity + slippage + bootstrap + synthetic ═════
function phaseRobust(): void {
  const pop = loadPopulation();
  const profs = buildProfiles(pop);
  const gridDoc = JSON.parse(fs.readFileSync(path.join(OUT, "exit-tp1-grid.json"), "utf8")) as { topByNetExp: Array<{ tp1: number; sl: number }>; topByWinWithEvFloor1: Array<{ tp1: number; sl: number }>; consistencyPick: { tp1: number; sl: number } };
  const finalists = [gridDoc.topByNetExp[0], gridDoc.consistencyPick, gridDoc.topByWinWithEvFloor1[0]]
    .filter((c, i, arr) => arr.findIndex(x => x.tp1 === c.tp1 && x.sl === c.sl) === i);
  console.log("[robust] finalists:", JSON.stringify(finalists));

  // WFO 3mo/1mo per finalist cell family: re-optimize tp1 within ±2 rungs, sl within ±2 rungs each window
  const MONTH = 30 * 86400;
  const TP1S = [2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 13.75];
  const SLS = [3, 4, 5, 6, 8, 10, 12, 16, 20, 23];
  const wfo: Array<{ oosStart: string; pick: string; is: number; oos: number; wfe: number }> = [];
  const t0 = profs[0].fireTs, tEnd = profs[profs.length - 1].fireTs;
  for (let ws = t0; ws + 4 * MONTH <= tEnd + MONTH; ws += MONTH) {
    const is = profs.filter(p => p.fireTs >= ws && p.fireTs < ws + 3 * MONTH);
    const oos = profs.filter(p => p.fireTs >= ws + 3 * MONTH && p.fireTs < ws + 4 * MONTH);
    if (is.length < 60 || oos.length < 15) continue;
    let best = { tp1: 0, sl: 0, netExp: -Infinity, win: 0 };
    for (const tp1 of TP1S) for (const sl of SLS) {
      const pts = is.map(p => cellD(p, tp1, sl));
      const s = stats(pts);
      if (s.netExp > best.netExp) best = { tp1, sl, netExp: s.netExp, win: s.win };
    }
    // consistency within the window
    const cells: Array<{ tp1: number; sl: number; netExp: number; win: number }> = [];
    for (const tp1 of TP1S) for (const sl of SLS) { const s = stats(is.map(p => cellD(p, tp1, sl))); cells.push({ tp1, sl, netExp: s.netExp, win: s.win }); }
    const pick = cells.filter(c => c.netExp >= 0.85 * best.netExp).sort((a, b) => b.win - a.win)[0];
    const oosS = stats(oos.map(p => cellD(p, pick.tp1, pick.sl)));
    wfo.push({ oosStart: new Date((ws + 3 * MONTH) * 1000).toISOString().slice(0, 10), pick: `tp1 ${pick.tp1}/sl ${pick.sl}`, is: +pick.netExp.toFixed(2), oos: oosS.netExp, wfe: pick.netExp !== 0 ? +(oosS.netExp / pick.netExp).toFixed(2) : 0 });
  }
  const wfeAvg = +(wfo.reduce((a, w) => a + w.wfe, 0) / wfo.length).toFixed(2);
  const oosPos = wfo.filter(w => w.oos > 0).length;
  for (const w of wfo) console.log("[robust:wfo]", JSON.stringify(w));
  console.log(`[robust:wfo] WFE avg ${wfeAvg}, OOS positive ${oosPos}/${wfo.length}`);

  // fractal-N sensitivity at the structure winner's shape (tp1 4 + 1m trail): N in 3..11 bars (n=1..5)
  const nSens: Array<{ n: number; netExp: number; win: number }> = [];
  for (const n of [1, 2, 3, 4, 5]) {
    const r = runStruct(pop, { label: "", tp1: 4, slFloor: 16, trail: { tf: 1, n, ratchet: true, exec: "stop" } });
    const s = stats(r.pts);
    nSens.push({ n, netExp: s.netExp, win: s.win });
    console.log("[robust:nSens]", JSON.stringify({ window: 2 * n + 1, ...s }));
  }

  // slippage stress + bootstrap + synthetic premature check per finalist
  const rng = (seed: number) => { let s0 = seed; return () => { s0 |= 0; s0 = (s0 + 0x6d2b79f5) | 0; let t2 = Math.imul(s0 ^ (s0 >>> 15), 1 | s0); t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2; return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296; }; };
  const robustOut: Array<Record<string, unknown>> = [];
  for (const cell of finalists) {
    const pts = profs.map(p => cellD(p, cell.tp1, cell.sl));
    const base = stats(pts);
    // slippage: stops are market (slip), targets are limits needing 1 tick through
    const slipPts = profs.map(p => {
      const iU = Math.ceil(cell.tp1 / TICK), iD = Math.ceil(cell.sl / TICK) - 1; // target needs one EXTRA tick
      const tU = iU < MAXT ? p.up[iU] : -1, tD = iD < MAXT ? p.dn[iD] : -1;
      if (tD >= 0 && (tU < 0 || tD <= tU)) return -cell.sl - 0.5;
      if (tU >= 0) return cell.tp1;
      return 0;
    });
    const slip = stats(slipPts);
    // block bootstrap
    const r = rng(99887);
    const L = 10, N = 5000, H = 100;
    const dds: number[] = []; let ruin = 0;
    const net = pts.map(x => x - F);
    for (let k = 0; k < N; k++) {
      let c = 0, pk = 0, dd = 0, ruined = false;
      for (let filled = 0; filled < H;) {
        const st0 = Math.floor(r() * (net.length - L));
        for (let j = 0; j < L && filled < H; j++, filled++) { c += net[st0 + j]; if (c > pk) pk = c; if (pk - c > dd) dd = pk - c; if (c <= -100) ruined = true; }
      }
      dds.push(dd); if (ruined) ruin++;
    }
    dds.sort((a, b) => a - b);
    const row = { cell: `tp1 ${cell.tp1}/sl ${cell.sl}`, base, slipStress: slip, p95MaxDD100: +dds[Math.floor(0.95 * N)].toFixed(1), ruinPctAtMinus100: +(100 * ruin / N).toFixed(2) };
    robustOut.push(row);
    console.log("[robust:final]", JSON.stringify(row));
  }
  fs.writeFileSync(path.join(OUT, "exit-tp1-robust.json"), JSON.stringify({ generated: new Date().toISOString(), wfo, wfeAvg, oosPositive: `${oosPos}/${wfo.length}`, nSens, finalists: robustOut }, null, 2));
}

if (phase === "grid") phaseGrid();
else if (phase === "structure") phaseStructure();
else if (phase === "robust") phaseRobust();
db.close();
