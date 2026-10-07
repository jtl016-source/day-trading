/**
 * scripts/analysis/exit-monte-carlo.ts — ANALYSIS ONLY (read-only DB, no persistence).
 *
 * Exit-strategy sweep + Monte Carlo on the 3-month ungated/gated engine fires.
 *
 * INPUT  C:\BaxterSandbox\analysis\signals-3mo.json (scripts/analysis/build-signal-dataset.ts):
 *        one row per engine fire 2026-06-24 .. 2026-10-01 with entry/entryTs/direction/half/
 *        sessionDay/shipped tp1+sl. The dataset's first-crossing profile is only sampled at 12
 *        levels (2..30), which cannot resolve a 1-pt TP/SL grid, a breakeven move or a trail —
 *        so every trade's FULL 1m path is re-walked here from the SAME loader the dataset used
 *        (scripts/fact-engine-backtest.ts loadData, readonly handle). The re-walk is VALIDATED
 *        against the dataset's own canonical outcomes (shipped exit, carry + Apex 16:55) first.
 *
 * Conventions (match shared/outcome-resolver.ts walkOutcomeCanonical):
 *   • walk starts at the bar whose time >= entryTs; a bar exits at bar.time+60;
 *   • stop and target touched in the SAME 1m bar = stop first (loss); fills at the level;
 *   • Apex mode: no bar at/after 16:55 ET of the entry's session day; flat at the close of the
 *     last bar before 16:55;
 *   • breakeven / trail stops move only for the NEXT bar and fill at the bar's OPEN when it gaps
 *     through the moved stop (bar-by-bar replay — LEARNINGS
 *     2026-08-12: crossing-array shortcuts silently mis-model a breakeven stop);
 *   • NET = gross − 1.0 pt/trade friction;
 *   • one-open-per-direction-per-interval admission is re-applied PER VARIANT (a longer hold can
 *     suppress later fires; fires the engine itself suppressed under the shipped exit cannot be
 *     recovered, so shorter-hold variants are slightly UNDER-counted).
 *
 * Outputs (only) to C:\BaxterSandbox\analysis\exit-mc\.
 * Run (repo root):  npx tsx scripts/analysis/exit-monte-carlo.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadData } from "../fact-engine-backtest";
import { etWallToEpoch, sessionDayKey } from "../../shared/yellowbox-core";

const t0 = Date.now();
const el = (): string => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const IN = "C:\\BaxterSandbox\\analysis\\signals-3mo.json";
const OUT = "C:\\BaxterSandbox\\analysis\\exit-mc";
fs.mkdirSync(OUT, { recursive: true });
const FRICTION = 1.0;
const TICK = 0.25;
const MAX_LV = 480; // level grid 0.25 .. 120 pts
const IVS = ["1m", "5m", "15m", "60m"] as const;
type Iv = (typeof IVS)[number];
const IV_SEC: Record<Iv, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };
const MAX_HOLD_SEC = 40 * 86400;
const MC_RESAMPLES = 5000, MC_BLOCK = 10, MC_HORIZON = 100;
const WF_RESAMPLES = 1000, WF_DD_CAP = 300, WF_MIN_N = 15;
const DAYSIM_RESAMPLES = 5000, DAYSIM_BLOCK = 5, DAYSIM_HORIZON = 250;
const APEX_DLL = 200, APEX_TRAIL = 500, PAYOUT_PTS_1MICRO = 520; // $2,600 / $5

// ───────────────────────────── RNG (reproducible) ─────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r2 = (x: number): number => Math.round(x * 100) / 100;
const pct = (sorted: number[], p: number): number => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1) + 1e-9)))] : NaN;

// ───────────────────────────── LOAD ─────────────────────────────
const ds = JSON.parse(fs.readFileSync(IN, "utf8")) as { meta: Record<string, unknown>; rows: Array<Record<string, any>> };
console.log(`[mc] dataset rows ${ds.rows.length} generatedAt ${(ds.meta as any).generatedAt}`);
const L = loadData();
const c1m = L.c1m;
const N1 = c1m.length;
const T = new Float64Array(N1), Op = new Float64Array(N1), Hi = new Float64Array(N1), Lo = new Float64Array(N1), Cl = new Float64Array(N1);
for (let k = 0; k < N1; k++) { T[k] = c1m[k].time; Op[k] = c1m[k].open; Hi[k] = c1m[k].high; Lo[k] = c1m[k].low; Cl[k] = c1m[k].close; }
const nowSec = Math.floor(Date.now() / 1000);
const covered = Math.min(T[N1 - 1] + 60, nowSec);
console.log(`[mc] 1m bars ${N1} through ${new Date(covered * 1000).toISOString()}  ${el()}`);
function lowerBound(t: number): number { let lo = 0, hi = N1; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; } return lo; }

// ATR14 (SMA of true range) per interval at the fire bar — from the engine's own interval candles.
const atrAt: Record<Iv, Map<number, number>> = { "1m": new Map(), "5m": new Map(), "15m": new Map(), "60m": new Map() };
for (const iv of IVS) {
  const cs = (L.candlesByIv as any)[iv] as Array<{ time: number; high: number; low: number; close: number }>;
  const tr: number[] = [];
  for (let k = 0; k < cs.length; k++) {
    const pc = k > 0 ? cs[k - 1].close : cs[k].close;
    tr.push(Math.max(cs[k].high - cs[k].low, Math.abs(cs[k].high - pc), Math.abs(cs[k].low - pc)));
    if (k >= 14) { let s = 0; for (let q = k - 13; q <= k; q++) s += tr[q]; atrAt[iv].set(cs[k].time, s / 14); }
  }
}

// ───────────────────────────── TRADES + PATH PROFILES ─────────────────────────────
interface Trade {
  i: number; key: string; iv: Iv; long: boolean; dir: number; entry: number; entryTs: number; fireTs: number;
  half: "H1" | "H2"; day: string; gated: boolean; ungated: boolean; type: "fe" | "vse"; session: string;
  tpDist: number; slDist: number; atr: number | null;
  s: number; len: number; dataEnded: boolean;         // path = c1m[s .. s+len)
  fav: Int32Array; adv: Int32Array; favCount: number; advCount: number;
  apexCut: number; apexReached: boolean;
  be: Int32Array;                                      // X=4..12 → first rel bar AFTER activation touching entry (−1 none)
  dsCarry: { outcome: string; points: number | null }; dsApex: { outcome: string; points: number | null };
}
const kOf = (d: number): number => Math.ceil(d / TICK - 1e-6);
const BE_X = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const trades: Trade[] = [];
for (const [i, r] of ds.rows.entries()) {
  const long = r.direction === "Long";
  const entry = r.entry as number, entryTs = r.entryTs as number;
  const s = lowerBound(entryTs);
  let e = s;
  while (e < N1 && T[e] + 60 <= covered && T[e] < entryTs + MAX_HOLD_SEC) e++;
  const len = e - s;
  const fav = new Int32Array(MAX_LV + 1).fill(-1), adv = new Int32Array(MAX_LV + 1).fill(-1);
  let favCount = 0, advCount = 0;
  for (let j = 0; j < len; j++) {
    const b = s + j;
    const f = long ? Hi[b] - entry : entry - Lo[b];
    const a = long ? entry - Lo[b] : Hi[b] - entry;
    const fk = Math.min(MAX_LV, Math.floor(f / TICK + 1e-6)), ak = Math.min(MAX_LV, Math.floor(a / TICK + 1e-6));
    while (favCount < fk) { favCount++; fav[favCount] = j; }
    while (advCount < ak) { advCount++; adv[advCount] = j; }
    if (favCount === MAX_LV && advCount === MAX_LV) break;
  }
  const apexTs = etWallToEpoch(sessionDayKey(entryTs), 16, 55);
  let apexCut = 0; while (apexCut < len && T[s + apexCut] < apexTs) apexCut++;
  const be = new Int32Array(BE_X.length).fill(-1);
  for (const [xi, X] of BE_X.entries()) {
    const kx = fav[kOf(X)];
    if (kx < 0) continue;
    for (let j = kx + 1; j < len; j++) { const b = s + j; const a = long ? entry - Lo[b] : Hi[b] - entry; if (a >= 0) { be[xi] = j; break; } }
  }
  const type = r.signalType === "vector-side-entry" ? "vse" : "fe";
  trades.push({
    i, key: r.key, iv: r.interval, long, dir: long ? 1 : -1, entry, entryTs, fireTs: r.fireTs, half: r.half, day: r.sessionDay,
    gated: !!r.gated, ungated: !!r.inUngated, type, session: r.session, tpDist: r.tpDist, slDist: r.slDist,
    atr: atrAt[r.interval as Iv].get(r.fireTs) ?? null,
    s, len, dataEnded: e >= N1 || T[e] + 60 > covered, fav, adv, favCount, advCount, apexCut, apexReached: apexTs <= covered, be,
    dsCarry: { outcome: r.path.outcomeCarry.outcome, points: r.path.outcomeCarry.points },
    dsApex: { outcome: r.path.outcomeApex.outcome, points: r.path.outcomeApex.points },
  });
}
console.log(`[mc] trades ${trades.length}, ATR available ${trades.filter(t => t.atr != null).length}  ${el()}`);

// ───────────────────────────── RESOLVER ─────────────────────────────
// Output slots (per mode 0=carry, 1=apex)
const outPts = [0, 0], outExit = [0, 0], outMae = [0, 0], outOpen = [false, false];
function maeUpTo(tr: Trade, j: number): number {
  let lo = 0, hi = tr.advCount; // largest k in [0,advCount] with adv[k] <= j (adv[0] treated as -inf)
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tr.adv[m] <= j) lo = m; else hi = m - 1; }
  return lo * TICK;
}
function relBefore(tr: Trade, ts: number): number { // number of path bars with time < ts
  let lo = 0, hi = tr.len; while (lo < hi) { const m = (lo + hi) >> 1; if (T[tr.s + m] < ts) lo = m + 1; else hi = m; } return lo;
}
/** Settle a natural exit (rel bar x, Infinity = none, gross pts px, stop distance for MAE cap) against
 *  an optional time stop and, for mode 1, the Apex 16:55 flat. */
function settle(tr: Trade, x: number, px: number, stopDist: number, timeCut: number, timeReached: boolean): void {
  for (let mode = 0; mode < 2; mode++) {
    let cut = timeCut, reached = timeReached;
    if (mode === 1 && tr.apexReached && tr.apexCut <= cut) { cut = tr.apexCut; reached = true; }
    if (x < cut && x !== Infinity) {
      outPts[mode] = px; outExit[mode] = T[tr.s + x] + 60; outMae[mode] = Math.min(maeUpTo(tr, x), stopDist); outOpen[mode] = false;
    } else if (cut !== Infinity && reached && cut <= tr.len) {
      if (cut === 0) { outPts[mode] = 0; outExit[mode] = tr.entryTs; outMae[mode] = 0; }
      else { const b = tr.s + cut - 1; outPts[mode] = tr.dir * (Cl[b] - tr.entry); outExit[mode] = T[b] + 60; outMae[mode] = Math.min(maeUpTo(tr, cut - 1), stopDist); }
      outOpen[mode] = false;
    } else {
      const b = tr.s + Math.max(0, tr.len - 1);
      outPts[mode] = tr.len ? tr.dir * (Cl[b] - tr.entry) : 0; outExit[mode] = Infinity; outMae[mode] = Math.min(maeUpTo(tr, tr.len), stopDist); outOpen[mode] = true;
    }
  }
}
function lvIdx(arr: Int32Array, d: number): number { const k = kOf(d); if (k < 1) return 0; if (k > MAX_LV) return Infinity; const v = arr[k]; return v < 0 ? Infinity : v; }

interface Variant { id: string; fam: "shipped" | "grid" | "be" | "time" | "trail" | "atr"; tp?: number; sl?: number; x?: number; n?: number; m?: number; g?: number; a?: number; b?: number }
function resolve(v: Variant, tr: Trade): void {
  let tp: number, sl: number;
  if (v.fam === "shipped") { tp = tr.tpDist; sl = tr.slDist; }
  else if (v.fam === "atr") {
    if (tr.atr == null) { outPts[0] = outPts[1] = NaN; return; }
    tp = Math.max(1, Math.round((v.a as number) * tr.atr / TICK) * TICK); sl = Math.max(1, Math.round((v.b as number) * tr.atr / TICK) * TICK);
  } else if (v.fam === "trail") { resolveTrail(v, tr); return; }
  else { tp = v.tp as number; sl = v.sl as number; }
  const iT = lvIdx(tr.fav, tp), iS = lvIdx(tr.adv, sl);
  let x: number, px: number;
  if (iS <= iT) { x = iS; px = -sl; } else { x = iT; px = tp; }
  if (v.fam === "be") {
    const xi = BE_X.indexOf(v.x as number);
    const kx = lvIdx(tr.fav, v.x as number);
    if (kx !== Infinity && kx < x) {          // activation strictly before the natural exit bar → stop at entry from kx+1
      const beT = tr.be[xi] < 0 ? Infinity : tr.be[xi];
      if (iS <= kx) { x = iS; px = -sl; }      // (cannot happen: x would be <= kx) — kept for clarity
      else if (beT <= iT) { x = beT; px = Math.min(0, tr.dir * (Op[tr.s + beT] - tr.entry)); }  // tie → stop first; a bar that OPENS through entry fills at its open
      else { x = iT; px = tp; }
    }
  }
  let timeCut = Infinity, timeReached = false;
  if (v.fam === "time") { const lim = tr.entryTs + (v.n as number) * 60; timeCut = relBefore(tr, lim); timeReached = lim <= covered; if (!timeReached) timeCut = Infinity; }
  settle(tr, x, px, sl, timeCut, timeReached);
}
function resolveTrail(v: Variant, tr: Trade): void {
  const sl = v.sl as number, m = v.m as number, g = v.g as number;
  let mfe = 0, x = Infinity, px = 0;
  for (let j = 0; j < tr.len; j++) {
    const b = tr.s + j;
    let stopOff = -sl;
    if (mfe >= m) stopOff = Math.max(stopOff, mfe - g);
    const a = tr.long ? tr.entry - Lo[b] : Hi[b] - tr.entry;
    if (a >= -stopOff) { x = j; px = stopOff > -sl ? Math.min(stopOff, tr.dir * (Op[b] - tr.entry)) : stopOff; break; } // a moved stop that the bar OPENS through fills at the open
    const f = tr.long ? Hi[b] - tr.entry : tr.entry - Lo[b];
    if (f > mfe) mfe = f;
  }
  settle(tr, x, px, sl, Infinity, false);
}

// ───────────────────────────── VARIANTS ─────────────────────────────
const variants: Variant[] = [{ id: "shipped", fam: "shipped" }];
for (let tp = 6; tp <= 30; tp++) for (let sl = 6; sl <= 30; sl++) variants.push({ id: `grid TP${tp}/SL${sl}`, fam: "grid", tp, sl });
for (const x of BE_X) for (let tp = 6; tp <= 30; tp++) if (x < tp) for (let sl = 6; sl <= 30; sl++) variants.push({ id: `be+${x} TP${tp}/SL${sl}`, fam: "be", x, tp, sl });
for (const n of [15, 30, 45, 60, 90, 120, 180, 240]) for (let tp = 6; tp <= 30; tp++) for (let sl = 6; sl <= 30; sl++) variants.push({ id: `time${n}m TP${tp}/SL${sl}`, fam: "time", n, tp, sl });
for (let m = 6; m <= 20; m++) for (let g = 3; g <= 10; g++) for (let sl = 6; sl <= 30; sl += 2) variants.push({ id: `trail m${m}/g${g} SL${sl}`, fam: "trail", m, g, sl });
const ATR_MULTS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3];
for (const a of ATR_MULTS) for (const b of ATR_MULTS) variants.push({ id: `atr TP${a}x/SL${b}x`, fam: "atr", a, b });
const V = variants.length;
console.log(`[mc] variants ${V}`);
function describe(v: Variant): string {
  switch (v.fam) {
    case "shipped": return "Shipped calibrated exit (per-trade tp1/sl from shared/quality-gate.ts, as fired)";
    case "grid": return `Fixed TP ${v.tp} pts / SL ${v.sl} pts (one bracket)`;
    case "be": return `TP ${v.tp} / SL ${v.sl}; once MFE >= ${v.x} pts the stop moves to entry (from the next 1m bar)`;
    case "time": return `TP ${v.tp} / SL ${v.sl}; if neither hit after ${v.n} min, exit at market`;
    case "trail": return `No fixed target; hard SL ${v.sl}; once MFE >= ${v.m} pts trail the stop ${v.g} pts behind the best price (updated each 1m bar)`;
    case "atr": return `TP ${v.a} x ATR14 / SL ${v.b} x ATR14 of the signal interval at fire time (rounded to tick)`;
  }
}

// ───────────────────────────── VALIDATION (shipped exit vs dataset canonical) ─────────────────────────────
{
  let ok = [0, 0], tot = [0, 0], bad: string[] = [];
  for (const tr of trades) {
    resolve(variants[0], tr);
    const ref = [tr.dsCarry, tr.dsApex];
    for (let mode = 0; mode < 2; mode++) {
      if (ref[mode].points == null) continue;
      tot[mode]++;
      if (!outOpen[mode] && Math.abs(outPts[mode] - (ref[mode].points as number)) < 0.02) ok[mode]++;
      else if (bad.length < 12) bad.push(`${tr.key} mode${mode} mine=${r2(outPts[mode])}${outOpen[mode] ? "(open)" : ""} ds=${ref[mode].outcome}/${ref[mode].points}`);
    }
  }
  const msg = `[mc] VALIDATION shipped exit re-walk vs dataset canonical: carry ${ok[0]}/${tot[0]}, apex ${ok[1]}/${tot[1]}`;
  console.log(msg); for (const b of bad) console.log("   mismatch " + b);
  fs.writeFileSync(path.join(OUT, "validation.txt"), [msg, ...bad].join("\n") + "\n");
}

// ───────────────────────────── SLEEVES ─────────────────────────────
// population (U ungated / G gated) × interval → chronological trade index list (admission domain)
const POPS = ["G", "U"] as const;
const TYPES = ["all", "fe", "vse"] as const;
const MODES = ["carry", "apex"] as const;
const domain: Record<string, number[]> = {};
for (const p of POPS) for (const iv of IVS) {
  domain[`${p}|${iv}`] = trades.filter(t => t.iv === iv && (p === "G" ? t.gated : t.ungated)).sort((a, b) => a.entryTs - b.entryTs || a.i - b.i).map(t => t.i);
}
const K = 17; // n, win%, grossExp, netExp, PF, totalNet, maxDD, nOpen, h1n, h1exp, h1PF, h1tot, h2n, h2exp, h2PF, h2tot, nDropped
const FIELDS = ["n", "winPct", "grossExp", "netExp", "PF", "totalNet", "maxDD", "nOpen", "h1n", "h1NetExp", "h1PF", "h1TotalNet", "h2n", "h2NetExp", "h2PF", "h2TotalNet", "admissionDropped"];
const sleeveKeys: string[] = [];
for (const p of POPS) for (const iv of IVS) for (const ty of TYPES) for (const mo of MODES) sleeveKeys.push(`${p}|${iv}|${ty}|${mo}`);
const store = new Map<string, Float64Array>(sleeveKeys.map(k => [k, new Float64Array(V * K).fill(NaN)]));

// per-variant evaluation: returns per (pop|iv|mode) admitted chronological trade lists
const ptsBuf = [new Float64Array(trades.length), new Float64Array(trades.length)];
const exitBuf = [new Float64Array(trades.length), new Float64Array(trades.length)];
const maeBuf = [new Float64Array(trades.length), new Float64Array(trades.length)];
const openBuf = [new Uint8Array(trades.length), new Uint8Array(trades.length)];
const resCache = new Map<number, Float64Array>();
function resolveAllCached(vi: number): void {
  let c = resCache.get(vi);
  if (!c) {
    resolveAll(variants[vi]);
    c = new Float64Array(trades.length * 8);
    for (let i = 0; i < trades.length; i++) for (let mo = 0; mo < 2; mo++) { c[i * 8 + mo * 4] = ptsBuf[mo][i]; c[i * 8 + mo * 4 + 1] = exitBuf[mo][i]; c[i * 8 + mo * 4 + 2] = maeBuf[mo][i]; c[i * 8 + mo * 4 + 3] = openBuf[mo][i]; }
    if (resCache.size < 6000) resCache.set(vi, c);
    return;
  }
  for (let i = 0; i < trades.length; i++) for (let mo = 0; mo < 2; mo++) { ptsBuf[mo][i] = c[i * 8 + mo * 4]; exitBuf[mo][i] = c[i * 8 + mo * 4 + 1]; maeBuf[mo][i] = c[i * 8 + mo * 4 + 2]; openBuf[mo][i] = c[i * 8 + mo * 4 + 3]; }
}
function resolveAll(v: Variant): void {
  for (const tr of trades) {
    resolve(v, tr);
    for (let mo = 0; mo < 2; mo++) { ptsBuf[mo][tr.i] = outPts[mo]; exitBuf[mo][tr.i] = outExit[mo]; maeBuf[mo][tr.i] = outMae[mo]; openBuf[mo][tr.i] = outOpen[mo] ? 1 : 0; }
  }
}
function admitted(dom: number[], mo: number): number[] {
  const last: Record<string, number> = { L: -Infinity, S: -Infinity };
  const out: number[] = [];
  for (const i of dom) {
    if (Number.isNaN(ptsBuf[mo][i])) continue; // ATR unavailable
    const tr = trades[i]; const d = tr.long ? "L" : "S";
    if (tr.entryTs < last[d]) continue;
    out.push(i); last[d] = exitBuf[mo][i];
  }
  return out;
}
interface Stats { n: number; winPct: number; grossExp: number; netExp: number; PF: number; totalNet: number; maxDD: number; nOpen: number }
function statsOf(idx: number[], mo: number): Stats {
  let n = 0, w = 0, g = 0, pos = 0, neg = 0, cum = 0, peak = 0, dd = 0, op = 0;
  for (const i of idx) {
    const p = ptsBuf[mo][i]; const net = p - FRICTION;
    n++; if (p > 0) w++; g += p; if (net > 0) pos += net; else neg -= net;
    cum += net; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
    if (openBuf[mo][i]) op++;
  }
  return { n, winPct: n ? (100 * w) / n : NaN, grossExp: n ? g / n : NaN, netExp: n ? (g - n * FRICTION) / n : NaN, PF: neg > 0 ? pos / neg : (pos > 0 ? Infinity : NaN), totalNet: g - n * FRICTION, maxDD: dd, nOpen: op };
}
function evalVariant(vi: number): void {
  const v = variants[vi];
  resolveAll(v);
  for (const p of POPS) for (const iv of IVS) for (let mo = 0; mo < 2; mo++) {
    const dom = domain[`${p}|${iv}`];
    const adm = admitted(dom, mo);
    const domValid = dom.filter(i => !Number.isNaN(ptsBuf[mo][i])).length;
    for (const ty of TYPES) {
      const sel = ty === "all" ? adm : adm.filter(i => trades[i].type === ty);
      const st = statsOf(sel, mo);
      const h1 = statsOf(sel.filter(i => trades[i].half === "H1"), mo), h2 = statsOf(sel.filter(i => trades[i].half === "H2"), mo);
      const domTy = ty === "all" ? domValid : dom.filter(i => trades[i].type === ty && !Number.isNaN(ptsBuf[mo][i])).length;
      const arr = store.get(`${p}|${iv}|${ty}|${MODES[mo]}`) as Float64Array;
      const vals = [st.n, st.winPct, st.grossExp, st.netExp, st.PF, st.totalNet, st.maxDD, st.nOpen, h1.n, h1.netExp, h1.PF, h1.totalNet, h2.n, h2.netExp, h2.PF, h2.totalNet, domTy - st.n];
      for (let k = 0; k < K; k++) arr[vi * K + k] = vals[k];
    }
  }
}
for (let vi = 0; vi < V; vi++) { evalVariant(vi); if (vi % 3000 === 0) console.log(`[mc]   evaluated ${vi}/${V}  ${el()}`); }
console.log(`[mc] all variants evaluated  ${el()}`);

// sleeve trade lists for a single variant (for MC)
function sleeveTrades(vi: number, p: string, iv: Iv, ty: string, mo: number): number[] {
  resolveAllCached(vi);
  const adm = admitted(domain[`${p}|${iv}`], mo);
  return ty === "all" ? adm : adm.filter(i => trades[i].type === ty);
}

// ───────────────────────────── MONTE CARLO PRIMITIVES ─────────────────────────────
function blockBootstrap(net: number[], R: number, seed: number) {
  const rng = mulberry32(seed); const n = net.length;
  const totals: number[] = [], dds: number[] = []; let ruin500 = 0, ruin250 = 0;
  if (n === 0) return null;
  for (let r = 0; r < R; r++) {
    let cum = 0, peak = 0, dd = 0, cnt = 0;
    while (cnt < MC_HORIZON) {
      const st = Math.floor(rng() * n);
      for (let q = 0; q < MC_BLOCK && cnt < MC_HORIZON; q++, cnt++) {
        cum += net[(st + q) % n]; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
      }
    }
    totals.push(cum); dds.push(dd); if (dd >= 500) ruin500++; if (dd >= 250) ruin250++;
  }
  totals.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  return { p5: pct(totals, 0.05), p50: pct(totals, 0.5), p95: pct(totals, 0.95), mean: totals.reduce((a, b) => a + b, 0) / R, ddP50: pct(dds, 0.5), ddP95: pct(dds, 0.95), pRuin500: ruin500 / R, pRuin250: ruin250 / R };
}
const allDays: string[] = (() => {
  const from = etWallToEpoch("2026-06-24", 0, 0) - 6 * 3600; // includes the 06-23 18:00 ETH open
  const set = new Set<string>();
  for (let k = lowerBound(from); k < N1; k++) set.add(sessionDayKey(T[k]));
  return [...set].filter(d => d >= "2026-06-24").sort();
})();
console.log(`[mc] session days in window: ${allDays.length} (${allDays[0]}..${allDays[allDays.length - 1]})`);
/** Apex day-sequence sim. Trades per day (chronological), gross pts + MAE (capped at the stop). */
function daySim(idx: number[], mo: number, micros: number, seed: number) {
  const byDay = new Map<string, Array<{ gross: number; mae: number }>>();
  for (const d of allDays) byDay.set(d, []);
  for (const i of [...idx].sort((a, b) => trades[a].entryTs - trades[b].entryTs)) { const tr = trades[i]; byDay.get(tr.day)?.push({ gross: ptsBuf[mo][i], mae: maeBuf[mo][i] }); }
  const days = allDays.map(d => byDay.get(d) as Array<{ gross: number; mae: number }>);
  const D = days.length; const rng = mulberry32(seed);
  const dll = APEX_DLL / micros, trail = APEX_TRAIL / micros, payout = PAYOUT_PTS_1MICRO / micros;
  let blown30 = 0, blown60 = 0, blownAny = 0, payN = 0, dllDays = 0, simDays = 0; const payDays: number[] = [];
  for (let r = 0; r < DAYSIM_RESAMPLES; r++) {
    let bal = 0, peakEod = 0, thr = -trail, best = -Infinity, blownDay = -1, payDay = -1, d = 0;
    while (d < DAYSIM_HORIZON && blownDay < 0) {
      const st = Math.floor(rng() * D);
      for (let q = 0; q < DAYSIM_BLOCK && d < DAYSIM_HORIZON && blownDay < 0; q++, d++) {
        const day = days[(st + q) % D]; let dp = 0; let stopped = false;
        for (const t of day) {
          if (stopped) break;
          const worst = dp - t.mae - FRICTION;          // day P&L at the trade's worst point
          const dllLevel = -dll, thrLevel = thr - bal;   // whichever level is higher is hit first
          if (worst <= Math.max(dllLevel, thrLevel)) {
            if (thrLevel >= dllLevel) { blownDay = d + 1; break; }
            dp = dllLevel; stopped = true; dllDays++; break;
          }
          dp += t.gross - FRICTION;
        }
        if (blownDay >= 0) break;
        bal += dp; simDays++;
        if (bal <= thr) { blownDay = d + 1; break; }
        if (dp > best) best = dp;
        if (bal > peakEod) peakEod = bal;
        thr = Math.min(peakEod - trail, 0);
        if (payDay < 0 && bal >= payout && best < 0.5 * bal) payDay = d + 1;
      }
    }
    if (blownDay > 0 && blownDay <= 30) blown30++;
    if (blownDay > 0 && blownDay <= 60) blown60++;
    if (blownDay > 0) blownAny++;
    if (payDay > 0 && (blownDay < 0 || payDay < blownDay)) { payN++; payDays.push(payDay); }
  }
  payDays.sort((a, b) => a - b);
  return { pBlown30: blown30 / DAYSIM_RESAMPLES, pBlown60: blown60 / DAYSIM_RESAMPLES, pBlown250: blownAny / DAYSIM_RESAMPLES, pPayout: payN / DAYSIM_RESAMPLES, payDaysMedian: payDays.length ? pct(payDays, 0.5) : NaN, payDaysMean: payDays.length ? payDays.reduce((a, b) => a + b, 0) / payDays.length : NaN, dllHitRate: simDays ? dllDays / simDays : 0 };
}

// ───────────────────────────── CSV WRITERS ─────────────────────────────
const fmt = (x: number): string => (x === Infinity ? "inf" : Number.isNaN(x) ? "" : String(r2(x)));
const csvEsc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
function writeCsv(file: string, header: string[], lines: string[][]): void {
  fs.writeFileSync(path.join(OUT, file), [header.join(","), ...lines.map(l => l.map(csvEsc).join(","))].join("\n") + "\n");
}
const PARAMS = ["tp", "sl", "x", "n", "m", "g", "a", "b"] as const;
function rowOf(vi: number, sk: string): string[] {
  const v = variants[vi]; const arr = store.get(sk) as Float64Array;
  return [v.id, v.fam, ...PARAMS.map(p => (v as any)[p] == null ? "" : String((v as any)[p])), ...FIELDS.map((_, k) => fmt(arr[vi * K + k]))];
}
const HEADER = ["variant", "family", ...PARAMS, ...FIELDS];
// Full grids for the all-type sleeves; per-type sleeves top 200 by net expectancy (n >= 10).
for (const sk of sleeveKeys) {
  const [p, iv, ty, mo] = sk.split("|");
  const arr = store.get(sk) as Float64Array;
  if (ty === "all") {
    writeCsv(`grid_${p === "G" ? "gated" : "ungated"}_${iv}_${ty}_${mo}.csv`, HEADER, variants.map((_, vi) => rowOf(vi, sk)));
  } else {
    const order = variants.map((_, vi) => vi).filter(vi => arr[vi * K] >= 10).sort((a, b) => arr[b * K + 3] - arr[a * K + 3]).slice(0, 200);
    if (variants.length && arr[0] >= 1) order.unshift(0);
    writeCsv(`top200_${p === "G" ? "gated" : "ungated"}_${iv}_${ty}_${mo}.csv`, HEADER, order.map(vi => rowOf(vi, sk)));
  }
}
console.log(`[mc] grid CSVs written  ${el()}`);
const get = (sk: string, vi: number, f: string): number => (store.get(sk) as Float64Array)[vi * K + FIELDS.indexOf(f)];

// ───────────────────────────── FAMILY BESTS (in-sample, per sleeve) ─────────────────────────────
const famRows: string[][] = [];
for (const sk of sleeveKeys) {
  const [p, iv, ty, mo] = sk.split("|");
  const nBase = get(sk, 0, "n");
  if (!(nBase >= 10)) continue;
  for (const fam of ["shipped", "grid", "be", "time", "trail", "atr"]) {
    let best = -1;
    for (let vi = 0; vi < V; vi++) if (variants[vi].fam === fam && get(sk, vi, "n") >= Math.max(10, 0.5 * nBase)) if (best < 0 || get(sk, vi, "netExp") > get(sk, best, "netExp")) best = vi;
    if (best >= 0) famRows.push([p, iv, ty, mo, ...rowOf(best, sk)]);
  }
}
writeCsv("family_best_insample.csv", ["pop", "interval", "type", "mode", ...HEADER], famRows);

// ───────────────────────────── WALK-FORWARD ─────────────────────────────
function h1Net(vi: number, p: string, iv: Iv, ty: string, mo: number): number[] {
  return sleeveTrades(vi, p, iv, ty, mo).filter(i => trades[i].half === "H1").map(i => ptsBuf[mo][i] - FRICTION);
}
interface WF { sleeve: string; fam: string; pick: number; h1n: number; h1exp: number; h1dd95: number; h2n: number; h2exp: number; h2PF: number; h2tot: number; baseH2n: number; baseH2exp: number; baseH2PF: number; baseH1exp: number; checked: number }
function walkForward(sk: string, fam: string | null): WF | null {
  const [p, iv, ty, mo] = sk.split("|"); const moi = MODES.indexOf(mo as any);
  const cands = variants.map((_, vi) => vi).filter(vi => (fam == null || variants[vi].fam === fam) && get(sk, vi, "h1n") >= WF_MIN_N && Number.isFinite(get(sk, vi, "h1NetExp")))
    .sort((a, b) => get(sk, b, "h1NetExp") - get(sk, a, "h1NetExp"));
  let checked = 0;
  for (const vi of cands.slice(0, 150)) {
    checked++;
    const net = h1Net(vi, p, iv as Iv, ty, moi);
    const bb = blockBootstrap(net, WF_RESAMPLES, 1000 + vi);
    if (!bb || bb.ddP95 > WF_DD_CAP) continue;
    return { sleeve: sk, fam: fam ?? "any", pick: vi, h1n: get(sk, vi, "h1n"), h1exp: get(sk, vi, "h1NetExp"), h1dd95: bb.ddP95, h2n: get(sk, vi, "h2n"), h2exp: get(sk, vi, "h2NetExp"), h2PF: get(sk, vi, "h2PF"), h2tot: get(sk, vi, "h2TotalNet"), baseH2n: get(sk, 0, "h2n"), baseH2exp: get(sk, 0, "h2NetExp"), baseH2PF: get(sk, 0, "h2PF"), baseH1exp: get(sk, 0, "h1NetExp"), checked };
  }
  return null;
}
const wfRows: string[][] = []; const wfMain = new Map<string, WF>(); const wfFam = new Map<string, number[]>();
for (const sk of sleeveKeys) {
  if (!(get(sk, 0, "h1n") >= WF_MIN_N)) continue;
  for (const fam of [null, "grid", "be", "time", "trail", "atr"]) {
    const w = walkForward(sk, fam);
    const [p, iv, ty, mo] = sk.split("|");
    if (!w) { wfRows.push([p, iv, ty, mo, fam ?? "any", "NONE PASSED (H1 n>=15 & P95 DD<=300)", "", "", "", "", "", "", "", "", "", "", ""]); continue; }
    if (fam == null) wfMain.set(sk, w); else { const l = wfFam.get(sk) ?? []; l.push(w.pick); wfFam.set(sk, l); }
    wfRows.push([p, iv, ty, mo, w.fam, variants[w.pick].id, fmt(w.h1n), fmt(w.h1exp), fmt(w.h1dd95), fmt(w.h2n), fmt(w.h2exp), fmt(w.h2PF), fmt(w.h2tot), fmt(w.baseH1exp), fmt(w.baseH2n), fmt(w.baseH2exp), fmt(w.baseH2PF)]);
  }
}
writeCsv("walk_forward.csv", ["pop", "interval", "type", "mode", "familyScope", "pickOnH1", "h1n", "h1NetExp", "h1P95DD_100tr", "h2n", "h2NetExp", "h2PF", "h2TotalNet", "shippedH1NetExp", "shippedH2n", "shippedH2NetExp", "shippedH2PF"], wfRows);
console.log(`[mc] walk-forward done  ${el()}`);

// ───────────────────────────── MONTE CARLO: top 15 per interval (gated, all types) ─────────────────────────────
interface McRow { iv: Iv; mo: string; vi: number; rankBy: string; st: Record<string, number>; bb: ReturnType<typeof blockBootstrap>; ds1: ReturnType<typeof daySim> | null; ds2: ReturnType<typeof daySim> | null }
const mcRows: McRow[] = [];
for (const iv of IVS) for (const mo of MODES) {
  const sk = `G|${iv}|all|${mo}`; const moi = MODES.indexOf(mo);
  const nBase = get(sk, 0, "n");
  const famCount: Record<string, number> = {};
  const ranked = variants.map((_, vi) => vi).filter(vi => vi > 0 && get(sk, vi, "n") >= Math.max(10, 0.5 * nBase)).sort((a, b) => get(sk, b, "totalNet") - get(sk, a, "totalNet"));
  const pick: number[] = [0];
  for (const vi of ranked) { const f = variants[vi].fam; if ((famCount[f] ?? 0) >= 5) continue; famCount[f] = (famCount[f] ?? 0) + 1; pick.push(vi); if (pick.length >= 16) break; }
  const wf = wfMain.get(sk); if (wf && !pick.includes(wf.pick)) pick.push(wf.pick);
  const wfF = wfFam.get(sk) ?? []; for (const vi of wfF) if (!pick.includes(vi)) pick.push(vi);
  for (const vi of pick) {
    const idx = sleeveTrades(vi, "G", iv, "all", moi);
    const net = idx.map(i => ptsBuf[moi][i] - FRICTION);
    const bb = blockBootstrap(net, MC_RESAMPLES, 7 + vi);
    const ds1 = mo === "apex" ? daySim(idx, moi, 1, 11 + vi) : null;
    const ds2 = mo === "apex" ? daySim(idx, moi, 2, 13 + vi) : null;
    const st: Record<string, number> = {}; for (const f of FIELDS) st[f] = get(sk, vi, f);
    mcRows.push({ iv, mo, vi, rankBy: vi === 0 ? "baseline" : (wf && vi === wf.pick ? (pick.indexOf(vi) <= 15 ? "top-totalNet + WF pick" : "walk-forward pick") : wfF.includes(vi) ? (pick.indexOf(vi) <= 15 ? "top-totalNet + WF family pick" : "WF family pick") : "top full-window totalNet"), st, bb, ds1, ds2 });
  }
  console.log(`[mc]   MC ${iv} ${mo}: ${pick.length} variants  ${el()}`);
}
writeCsv("monte_carlo_top15.csv",
  ["interval", "mode", "variant", "family", "selectedBy", "n", "winPct", "grossExp", "netExp", "PF", "totalNet", "realizedMaxDD", "h1n", "h1NetExp", "h1PF", "h2n", "h2NetExp", "h2PF",
    "mc100_P5", "mc100_P50", "mc100_P95", "mc100_mean", "mc100_DD_P50", "mc100_DD_P95", "P_ruin_DD500_1micro", "P_ruin_DD250_2micro",
    "apex1_P_blown_30d", "apex1_P_blown_60d", "apex1_P_blown_250d", "apex1_P_payout", "apex1_payout_days_median", "apex1_payout_days_mean", "apex1_DLL_hit_day_rate",
    "apex2_P_blown_30d", "apex2_P_blown_60d", "apex2_P_payout", "apex2_payout_days_median"],
  mcRows.map(m => [m.iv, m.mo, variants[m.vi].id, variants[m.vi].fam, m.rankBy, fmt(m.st.n), fmt(m.st.winPct), fmt(m.st.grossExp), fmt(m.st.netExp), fmt(m.st.PF), fmt(m.st.totalNet), fmt(m.st.maxDD),
    fmt(m.st.h1n), fmt(m.st.h1NetExp), fmt(m.st.h1PF), fmt(m.st.h2n), fmt(m.st.h2NetExp), fmt(m.st.h2PF),
    ...(m.bb ? [m.bb.p5, m.bb.p50, m.bb.p95, m.bb.mean, m.bb.ddP50, m.bb.ddP95, m.bb.pRuin500, m.bb.pRuin250].map(fmt) : ["", "", "", "", "", "", "", ""]),
    ...(m.ds1 ? [m.ds1.pBlown30, m.ds1.pBlown60, m.ds1.pBlown250, m.ds1.pPayout, m.ds1.payDaysMedian, m.ds1.payDaysMean, m.ds1.dllHitRate].map(fmt) : ["", "", "", "", "", "", ""]),
    ...(m.ds2 ? [m.ds2.pBlown30, m.ds2.pBlown60, m.ds2.pPayout, m.ds2.payDaysMedian].map(fmt) : ["", "", "", ""])]));

// ───────────────────────────── JSON + MARKDOWN SUMMARY ─────────────────────────────
const summary = {
  generatedAt: new Date().toISOString(), dataset: IN, datasetGeneratedAt: (ds.meta as any).generatedAt, variants: V, trades: trades.length,
  sessionDays: allDays.length, friction: FRICTION,
  baseline: Object.fromEntries(sleeveKeys.map(sk => [sk, Object.fromEntries(FIELDS.map(f => [f, r2(get(sk, 0, f))]))])),
  walkForward: [...wfMain.values()].map(w => ({ ...w, pickId: variants[w.pick].id, pickDesc: describe(variants[w.pick]) })),
  mc: mcRows.map(m => ({ iv: m.iv, mode: m.mo, id: variants[m.vi].id, desc: describe(variants[m.vi]), selectedBy: m.rankBy, stats: m.st, bootstrap: m.bb, apex1: m.ds1, apex2: m.ds2 })),
};
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));

const md: string[] = [];
const f2 = (x: number): string => fmt(x);
md.push(`# Exit-strategy sweep + Monte Carlo — MES engine fires 2026-06-24 .. 2026-10-01`, "");
md.push(`Generated ${summary.generatedAt} by \`scripts/analysis/exit-monte-carlo.ts\` from \`${IN}\` (dataset built ${summary.datasetGeneratedAt}).`);
md.push(`${trades.length} fires, ${V} single-exit variants, ${allDays.length} session days. NET = gross − ${FRICTION} pt/trade. Halves: H1 2026-06-24..08-12, H2 08-13..10-01. 1 MES = $5/pt.`, "");
md.push(`Validation: ${fs.readFileSync(path.join(OUT, "validation.txt"), "utf8").split("\n")[0].replace("[mc] ", "")}`, "");
md.push(`## Shipped exit baseline (per sleeve)`, "", `| pop | iv | type | mode | n | win% | gross/tr | NET/tr | PF | total NET | maxDD | H1 n / NET/tr / PF | H2 n / NET/tr / PF |`, `|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const sk of sleeveKeys) { const [p, iv, ty, mo] = sk.split("|"); if (!(get(sk, 0, "n") > 0)) continue; md.push(`| ${p} | ${iv} | ${ty} | ${mo} | ${f2(get(sk, 0, "n"))} | ${f2(get(sk, 0, "winPct"))} | ${f2(get(sk, 0, "grossExp"))} | ${f2(get(sk, 0, "netExp"))} | ${f2(get(sk, 0, "PF"))} | ${f2(get(sk, 0, "totalNet"))} | ${f2(get(sk, 0, "maxDD"))} | ${f2(get(sk, 0, "h1n"))} / ${f2(get(sk, 0, "h1NetExp"))} / ${f2(get(sk, 0, "h1PF"))} | ${f2(get(sk, 0, "h2n"))} / ${f2(get(sk, 0, "h2NetExp"))} / ${f2(get(sk, 0, "h2PF"))} |`); }
md.push("", `## Walk-forward (pick best NET/tr on H1 with H1 n>=${WF_MIN_N} and bootstrap P95 100-trade DD <= ${WF_DD_CAP}; report on H2)`, "", `| sleeve | family scope | pick | H1 n / NET/tr / P95DD | H2 n / NET/tr / PF / total | shipped H2 n / NET/tr / PF |`, `|---|---|---|---|---|---|`);
for (const r of wfRows) md.push(`| ${r.slice(0, 4).join("/")} | ${r[4]} | ${r[5]} | ${r[6]} / ${r[7]} / ${r[8]} | ${r[9]} / ${r[10]} / ${r[11]} / ${r[12]} | ${r[14]} / ${r[15]} / ${r[16]} |`);
md.push("", `## Monte Carlo — gated alerts (all signal types), per interval`, "", `Block bootstrap L=${MC_BLOCK}, ${MC_RESAMPLES} resamples, ${MC_HORIZON}-trade horizon. Apex day sim: ${DAYSIM_RESAMPLES} paths of 5-day blocks, DLL ${APEX_DLL} pts/micro (trading stops for the day), EOD trailing ${APEX_TRAIL} pts/micro (trails EOD balance, locks at start once the peak is +${APEX_TRAIL}), payout = +${PAYOUT_PTS_1MICRO} pts/micro with best day < 50 % of profit. Note: top-15 ranking is IN-SAMPLE (full window); use the H2 columns and the walk-forward table for honest selection.`, "");
for (const iv of IVS) for (const mo of MODES) {
  md.push(`### ${iv} — ${mo}`, "", `| variant | sel | n | win% | gross | NET/tr | PF | total | H1 NET/tr | H2 n / NET/tr / PF | MC100 P5/P50/P95 | DD P95 | P(DD>=500) | P(DD>=250) | ${mo === "apex" ? "P(blown 30d/60d) 1µ | P(payout) / median days 1µ | P(blown 30d/60d) 2µ |" : ""}`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|${mo === "apex" ? "---|---|---|" : ""}`);
  for (const m of mcRows.filter(x => x.iv === iv && x.mo === mo)) {
    const b = m.bb; const s = m.st;
    md.push(`| ${variants[m.vi].id} | ${m.rankBy} | ${f2(s.n)} | ${f2(s.winPct)} | ${f2(s.grossExp)} | ${f2(s.netExp)} | ${f2(s.PF)} | ${f2(s.totalNet)} | ${f2(s.h1NetExp)} | ${f2(s.h2n)} / ${f2(s.h2NetExp)} / ${f2(s.h2PF)} | ${b ? `${f2(b.p5)} / ${f2(b.p50)} / ${f2(b.p95)}` : ""} | ${b ? f2(b.ddP95) : ""} | ${b ? f2(b.pRuin500) : ""} | ${b ? f2(b.pRuin250) : ""} |${m.ds1 ? ` ${f2(m.ds1.pBlown30)} / ${f2(m.ds1.pBlown60)} | ${f2(m.ds1.pPayout)} / ${f2(m.ds1.payDaysMedian)} | ${f2((m.ds2 as any).pBlown30)} / ${f2((m.ds2 as any).pBlown60)} |` : ""}`);
  }
  md.push("");
}
md.push(`## Method notes`, "",
  `- Every trade's 1m path re-walked from scripts/fact-engine-backtest.ts loadData (readonly DB) — the dataset's 12 sampled crossing levels cannot resolve a 1-pt grid / breakeven / trail. Same-bar stop+target = stop. Breakeven & trail stops update for the next bar; a bar that opens through a moved stop fills at its open (fixed TP/SL fill at the level, as the canonical resolver does).`,
  `- One-open-per-direction-per-interval re-applied per variant (admissionDropped column). Fires the engine suppressed under the shipped exit are not in the dataset, so shorter-hold variants are slightly under-counted.`,
  `- Carry mode: trades still open at the data end are marked to the last close (nOpen column).`,
  `- ATR14 = SMA of true range over the signal interval's 14 engine candles ending at the fire bar (computed here; the dataset has no ATR field).`,
  `- Apex day sim treats concurrent Long+Short trades as independent (hand-trading one account nets them) and checks the trailing threshold / DLL against realized P&L plus each trade's MAE (capped at its stop).`,
  `- Apex's actual lock level is start + $100 (20 pts/micro); the sim locks at start (task spec) — a 20-pt difference.`);
fs.writeFileSync(path.join(OUT, "SUMMARY.md"), md.join("\n") + "\n");
console.log(`[mc] DONE  ${el()} → ${OUT}`);
