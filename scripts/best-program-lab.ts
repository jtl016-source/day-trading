/**
 * best-program-lab.ts — UNCONSTRAINED BEST-PROGRAM SEARCH (2026-08-13, user directive:
 * "ignore the rules i gave you and make the best possible program... high win rate with a
 * high positive point differential... show me a backtest. if i dont like it i will revert").
 *
 * Rule constraints LIFTED per that directive: the TP1-only policy (scale-out policies are
 * back on the table), the 6-pt TP floor (grid runs 2..40), the consistency objective
 * (Pareto search over win% × netExp instead). Constraints NOT lifted (honesty, not rules):
 * executable scoring only, net-of-friction reporting, forward-chronological validation,
 * realistic-fill stress on anything small, block-bootstrap risk numbers.
 *
 * Design:
 *   TRAIN  = 2025-06-01 → standing-window start (the older ~1,100 15m trades)
 *   VALID  = the standing window (2026-04-30 → today, ~385 trades)  [forward in time]
 *   Policies (all computable from tick-quantized first-crossing profiles):
 *     D(tp, sl)        one position, one target, one stop (covers "ride to TP2" at big tp)
 *     F(tp1, sl, k)    half out at tp1, half rides to k×tp1, both legs on the original SL
 *   Filters:
 *     comboBlock       combos whose TRAIN executable net at a reference geometry is negative
 *                      on an adequate sample (n>=15) are dropped (small-n stays allowed —
 *                      the house gate's own convention)
 *   Output: Pareto table on TRAIN → candidates → VALID scores → chosen config → phase 2
 *   (--phase=validate) runs the full battery + all-interval sleeves + monthly equity.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { INTERVAL_SEC, type Interval } from "../shared/fact-engine";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd();
const OUT = artifactsDir(ROOT);
const F = 1.0;
const TICK = 0.25;
const CAP_SEC = 5 * 86400;
const MAXT = 240; // 60 pts each side
const phase = (process.argv.find(a => a.startsWith("--phase=")) ?? "--phase=search").slice(8);

const db = new Database(path.join(ROOT, "data", "app.db"), { readonly: true });
const barsStmt = db.prepare(
  `SELECT timestamp AS time, high, low, close FROM cached_candles
   WHERE symbol='MES' AND resolution='1' AND timestamp>=? AND timestamp<? ORDER BY timestamp`,
);

interface Prof { fireTs: number; up: number[]; dn: number[]; combo: string; hour: number; session: "RTH" | "ETH"; era: "train" | "valid" }

function buildProfiles(interval: string, fromTs: number, standingStart: number): Prof[] {
  const rows = db.prepare(
    `SELECT timestamp, direction, entry, combo_key FROM signal_history
     WHERE symbol='MES' AND interval=? AND timestamp>=? AND entry IS NOT NULL ORDER BY timestamp`,
  ).all(interval, fromTs) as Array<{ timestamp: number; direction: string; entry: number; combo_key: string | null }>;
  const ivSec = INTERVAL_SEC[interval as Interval];
  const out: Prof[] = [];
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false });
  const minFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", minute: "2-digit" });
  for (const t of rows) {
    const entryTs = t.timestamp + ivSec;
    const dir = t.direction.toLowerCase().startsWith("l") ? 1 : -1;
    const bars = barsStmt.all(entryTs - 60, entryTs + CAP_SEC) as Array<{ time: number; high: number; low: number }>;
    if (bars.length < 30) continue;
    const up = new Array(MAXT).fill(-1), dn = new Array(MAXT).fill(-1);
    let upMax = 0, dnMax = 0;
    for (const b of bars) {
      if (b.time < entryTs) continue;
      const min = Math.floor((b.time - entryTs) / 60);
      const fav = dir === 1 ? b.high - t.entry : t.entry - b.low;
      const adv = dir === 1 ? t.entry - b.low : b.high - t.entry;
      if (fav > upMax) { for (let i = Math.floor(upMax / TICK); i < Math.min(MAXT, Math.floor(fav / TICK)); i++) if (up[i] < 0) up[i] = min; upMax = fav; }
      if (adv > dnMax) { for (let i = Math.floor(dnMax / TICK); i < Math.min(MAXT, Math.floor(adv / TICK)); i++) if (dn[i] < 0) dn[i] = min; dnMax = adv; }
    }
    const d = new Date(entryTs * 1000);
    const h = parseInt(hourFmt.format(d), 10) + parseInt(minFmt.format(d), 10) / 60;
    out.push({
      fireTs: t.timestamp, up, dn, combo: t.combo_key ?? "?", hour: h,
      session: h >= 9.5 && h < 17 ? "RTH" : "ETH",
      era: t.timestamp < standingStart ? "train" : "valid",
    });
  }
  return out;
}

/** Single-target executable outcome: +tp if crossed strictly before SL (ties SL-first), −sl if SL first, 0 unresolved. */
const D = (p: Prof, tp: number, sl: number): number => {
  const iU = Math.ceil(tp / TICK) - 1, iD = Math.ceil(sl / TICK) - 1;
  const tU = iU < MAXT ? p.up[iU] : -1, tD = iD < MAXT ? p.dn[iD] : -1;
  if (tD >= 0 && (tU < 0 || tD <= tU)) return -sl;
  if (tU >= 0) return tp;
  return 0;
};
/** Scale-out: half at tp1, half rides to k×tp1, both legs on the original SL. */
const Fpol = (p: Prof, tp1: number, sl: number, k: number): number => 0.5 * D(p, tp1, sl) + 0.5 * D(p, k * tp1, sl);

const stats = (pts: number[]): { n: number; netExp: number; win: number; cum: number; pf: number; dd: number } => {
  const gw = pts.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const gl = -pts.filter(x => x < 0).reduce((a, b) => a + b, 0);
  let c = 0, pk = 0, dd = 0;
  for (const x of pts) { c += x - F; if (c > pk) pk = c; if (pk - c > dd) dd = pk - c; }
  return {
    n: pts.length,
    netExp: +(pts.reduce((a, b) => a + b, 0) / pts.length - F).toFixed(2),
    win: +(100 * pts.filter(x => x > 0.01).length / pts.length).toFixed(1),
    cum: +(pts.reduce((a, b) => a + b, 0) - F * pts.length).toFixed(1),
    pf: +(gw / (gl || 1)).toFixed(2),
    dd: +dd.toFixed(1),
  };
};

function main(): void {
  const book = JSON.parse(fs.readFileSync(path.join(OUT, "fact-engine-backtest-results.json"), "utf8"));
  const standingStart = book.meta.emissionStartTs as number;
  const from = Math.floor(new Date("2025-06-01T00:00:00Z").getTime() / 1000);
  console.log("[best] building 15m profiles...");
  const profs = buildProfiles("15m", from, standingStart);
  const train = profs.filter(p => p.era === "train"), valid = profs.filter(p => p.era === "valid");
  console.log(`[best] 15m: train ${train.length}, valid ${valid.length}`);

  // ── combo verdicts on TRAIN at a reference geometry (mid-grid, policy-neutral) ──
  const REF_TP = 12, REF_SL = 20;
  const comboNet: Record<string, { n: number; net: number }> = {};
  for (const p of train) { const c = comboNet[p.combo] ??= { n: 0, net: 0 }; c.n++; c.net += D(p, REF_TP, REF_SL) - F; }
  const blocked = new Set(Object.entries(comboNet).filter(([, v]) => v.n >= 15 && v.net < 0).map(([k]) => k));
  console.log("[best] TRAIN combo verdicts @ref 12/20:", Object.entries(comboNet).map(([k, v]) => `${k}:n${v.n}:${v.net.toFixed(0)}${blocked.has(k) ? ":BLOCKED" : ""}`).join("  "));

  // ── the search ──
  const TPS: number[] = []; for (let t = 2; t <= 40 + 1e-9; t += 0.5) TPS.push(t);
  const SLS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 23, 26, 30];
  const KS = [1.5, 2, 2.5, 3];
  interface Cell { policy: string; tp: number; sl: number; k: number | null; filt: string; train: ReturnType<typeof stats>; validS?: ReturnType<typeof stats> }
  const cells: Cell[] = [];
  for (const filt of ["all", "comboBlock"]) {
    const tset = filt === "all" ? train : train.filter(p => !blocked.has(p.combo));
    for (const sl of SLS) for (const tp of TPS) {
      cells.push({ policy: "D", tp, sl, k: null, filt, train: stats(tset.map(p => D(p, tp, sl))) });
      for (const k of KS) if (tp <= 20) cells.push({ policy: "F", tp, sl, k, filt, train: stats(tset.map(p => Fpol(p, tp, sl, k))) });
    }
  }
  console.log(`[best] ${cells.length} cells searched on TRAIN`);

  // ── Pareto candidates on TRAIN (min n already fixed = population) ──
  // Keep cells not dominated in (win, netExp); then take a spread of candidates.
  const pareto = cells.filter(c => c.train.netExp > 0 && !cells.some(o =>
    o.train.win >= c.train.win + 1e-9 && o.train.netExp >= c.train.netExp + 1e-9
    && (o.train.win > c.train.win + 1e-9 || o.train.netExp > c.train.netExp + 1e-9)));
  pareto.sort((a, b) => b.train.win - a.train.win);
  console.log(`[best] Pareto frontier on TRAIN: ${pareto.length} cells`);
  // Candidates: every Pareto cell with win >= 60 plus the top-5 netExp cells overall.
  const topExp = [...cells].sort((a, b) => b.train.netExp - a.train.netExp).slice(0, 5);
  const candidates = [...new Set([...pareto.filter(c => c.train.win >= 60), ...topExp])];

  // ── forward validation ──
  for (const c of candidates) {
    const vset = c.filt === "all" ? valid : valid.filter(p => !blocked.has(p.combo));
    const fn = c.policy === "D" ? (p: Prof) => D(p, c.tp, c.sl) : (p: Prof) => Fpol(p, c.tp, c.sl, c.k as number);
    c.validS = stats(vset.map(fn));
  }
  candidates.sort((a, b) => (b.validS!.netExp * Math.min(b.validS!.win, 85)) - (a.validS!.netExp * Math.min(a.validS!.win, 85)));
  console.log("[best] CANDIDATES (train → valid):");
  for (const c of candidates.slice(0, 15)) {
    console.log(`   ${c.policy}${c.k ? `(k=${c.k})` : ""} tp ${c.tp}/sl ${c.sl} [${c.filt}] TRAIN n${c.train.n} ${c.train.win}% ${c.train.netExp}/tr cum ${c.train.cum} | VALID n${c.validS!.n} ${c.validS!.win}% ${c.validS!.netExp}/tr cum ${c.validS!.cum}`);
  }
  fs.writeFileSync(path.join(OUT, "best-program-search.json"), JSON.stringify({
    generated: new Date().toISOString(), trainN: train.length, validN: valid.length,
    refGeometry: { tp: REF_TP, sl: REF_SL }, comboVerdicts: comboNet, blocked: [...blocked],
    candidates: candidates.slice(0, 25), paretoN: pareto.length, cellsN: cells.length,
  }));
  console.log("[best] artifact: best-program-search.json");
}

// ═════ phase 2 — validation battery + all sleeves + combined program backtest ═════
/** Realistic-fill single-target outcome: target needs ONE TICK THROUGH to fill; stop is a
 *  market order with 0.5-pt slip. The honest score for small targets. */
const Dreal = (p: Prof, tp: number, sl: number): number => {
  const iU = Math.ceil(tp / TICK), iD = Math.ceil(sl / TICK) - 1; // one extra tick through
  const tU = iU < MAXT ? p.up[iU] : -1, tD = iD < MAXT ? p.dn[iD] : -1;
  if (tD >= 0 && (tU < 0 || tD <= tU)) return -sl - 0.5;
  if (tU >= 0) return tp;
  return 0;
};

function validate(): void {
  const book = JSON.parse(fs.readFileSync(path.join(OUT, "fact-engine-backtest-results.json"), "utf8"));
  const standingStart = book.meta.emissionStartTs as number;
  const from = Math.floor(new Date("2025-06-01T00:00:00Z").getTime() / 1000);
  const sleeves = ["15m", "5m", "60m", "1m"];
  const finals: Array<{ sleeve: string; cfg: string; blocked: string[]; validStats: ReturnType<typeof stats>; realStats: ReturnType<typeof stats>; trainStats: ReturnType<typeof stats>; monthly: Array<[string, number, number]> }> = [];
  const allValidPts: Array<{ ts: number; pts: number }> = [];
  for (const sleeve of sleeves) {
    console.log(`[validate] ${sleeve}: building profiles...`);
    const profs = buildProfiles(sleeve, from, standingStart);
    const train = profs.filter(p => p.era === "train"), valid = profs.filter(p => p.era === "valid");
    if (train.length < 80 || valid.length < 30) { console.log(`[validate] ${sleeve}: too thin (${train.length}/${valid.length}) — skipped`); continue; }
    // per-sleeve combo verdicts on TRAIN @ref
    const comboNet: Record<string, { n: number; net: number }> = {};
    for (const p of train) { const c = comboNet[p.combo] ??= { n: 0, net: 0 }; c.n++; c.net += D(p, 12, 20) - F; }
    const blocked = new Set(Object.entries(comboNet).filter(([, v]) => v.n >= 15 && v.net < 0).map(([k]) => k));
    const tset = train.filter(p => !blocked.has(p.combo));
    const vset = valid.filter(p => !blocked.has(p.combo));
    if (tset.length < 40 || vset.length < 20) { console.log(`[validate] ${sleeve}: post-block too thin (${tset.length}/${vset.length}) — skipped`); continue; }
    // grid on the blocked TRAIN set, REALISTIC fills as the selection metric (no fantasy picks)
    interface C2 { tp: number; sl: number; t: ReturnType<typeof stats> }
    const cells: C2[] = [];
    for (let tp = 2; tp <= 40 + 1e-9; tp += 0.5) for (const sl of [4, 6, 8, 10, 12, 14, 16, 20, 23, 26, 30]) {
      cells.push({ tp, sl, t: stats(tset.map(p => Dreal(p, tp, sl))) });
    }
    const posCells = cells.filter(c => c.t.netExp > 0);
    if (!posCells.length) { console.log(`[validate] ${sleeve}: NO positive cell under realistic fills — sleeve has no honest edge`); continue; }
    // pick: highest win among cells with netExp >= 70% of best (consistency-style but on honest fills)
    const bestExp = Math.max(...posCells.map(c => c.t.netExp));
    const pick = posCells.filter(c => c.t.netExp >= 0.7 * bestExp).sort((a, b) => b.t.win - a.t.win)[0];
    const vIdeal = stats(vset.map(p => D(p, pick.tp, pick.sl)));
    const vReal = stats(vset.map(p => Dreal(p, pick.tp, pick.sl)));
    // monthly equity (valid era, realistic)
    const byM: Record<string, { n: number; net: number }> = {};
    for (const p of vset) { const m = new Date(p.fireTs * 1000).toISOString().slice(0, 7); const e = byM[m] ??= { n: 0, net: 0 }; e.n++; e.net += Dreal(p, pick.tp, pick.sl) - F; }
    const monthly = Object.entries(byM).map(([m, v]) => [m, v.n, +v.net.toFixed(1)] as [string, number, number]);
    console.log(`[validate] ${sleeve} PICK tp ${pick.tp}/sl ${pick.sl} [block ${[...blocked].join(",") || "none"}]`);
    console.log(`   TRAIN(real) n${pick.t.n} ${pick.t.win}% ${pick.t.netExp}/tr cum ${pick.t.cum} | VALID(real) n${vReal.n} ${vReal.win}% ${vReal.netExp}/tr cum ${vReal.cum} (ideal ${vIdeal.netExp}/tr) | monthly ${JSON.stringify(monthly)}`);
    finals.push({ sleeve, cfg: `tp ${pick.tp} / sl ${pick.sl}`, blocked: [...blocked], validStats: vIdeal, realStats: vReal, trainStats: pick.t, monthly });
    for (const p of vset) allValidPts.push({ ts: p.fireTs, pts: Dreal(p, pick.tp, pick.sl) });
  }
  // combined program (valid era, realistic fills)
  allValidPts.sort((a, b) => a.ts - b.ts);
  const comb = stats(allValidPts.map(x => x.pts));
  const byM: Record<string, number> = {};
  for (const x of allValidPts) { const m = new Date(x.ts * 1000).toISOString().slice(0, 7); byM[m] = +((byM[m] ?? 0) + x.pts - F).toFixed(1); }
  // block bootstrap on the combined validated sequence
  let seed = 777; const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const net = allValidPts.map(x => x.pts - F);
  const dds: number[] = [];
  for (let i = 0; i < 5000; i++) {
    let c = 0, pk = 0, dd = 0;
    for (let f = 0; f < 100;) { const s = Math.floor(rnd() * Math.max(1, net.length - 10)); for (let j = 0; j < 10 && f < 100; j++, f++) { c += net[s + j] ?? 0; if (c > pk) pk = c; if (pk - c > dd) dd = pk - c; } }
    dds.push(dd);
  }
  dds.sort((a, b) => a - b);
  console.log(`[validate] COMBINED PROGRAM (valid era, realistic fills): ${JSON.stringify(comb)}`);
  console.log(`[validate] monthly: ${JSON.stringify(byM)}`);
  console.log(`[validate] block-bootstrap P95 maxDD per 100 trades: ${dds[Math.floor(0.95 * 5000)].toFixed(1)}`);
  fs.writeFileSync(path.join(OUT, "best-program-final.json"), JSON.stringify({ generated: new Date().toISOString(), finals, combined: comb, monthly: byM, p95dd100: +dds[Math.floor(0.95 * 5000)].toFixed(1) }, null, 2));
}

if (phase === "search") main();
else if (phase === "validate") validate();
db.close();
