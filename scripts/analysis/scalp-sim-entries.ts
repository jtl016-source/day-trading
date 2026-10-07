/**
 * scripts/analysis/scalp-sim-entries.ts — ANALYSIS ONLY (read-only DB, no persistence, never touches :3000).
 *
 * Scalp-style entries (3-5 pt targets, 4-8 pt stops) simulated on the owner's own MES 1m bars,
 * yellow-box day zones and 5m footprint rows. Definitions: C:\BaxterSandbox\analysis\scalping\sim-entries\README.md
 *
 * Strategies: (a) vector pullback, (b) yellow-box edge fade + break-retest, (c) 5m footprint stacked-
 * imbalance continuation (two-sided rows only — see README data defect), (d) session-VWAP band mean
 * reversion, (e) opening-range breakout (15/30 min), (f) first pullback after the 09:30 open.
 * Nulls: random time+direction, and coin-flip direction on each strategy's own entry bars.
 *
 * Run (repo root):  npx tsx scripts/analysis/scalp-sim-entries.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { etWallToEpoch, sessionDayKey } from "../../shared/yellowbox-core";

const DB_PATH = path.resolve("data/app.db");
const OUT = "C:\\BaxterSandbox\\analysis\\scalping\\sim-entries";
fs.mkdirSync(OUT, { recursive: true });
const WIN_FROM = "2026-07-06", WIN_TO = "2026-10-05";
const LOOKBACK_FROM = "2026-06-01";
const TPS = [3, 4, 5], SLS = [4, 5, 6, 7, 8];
const FRICTIONS = [1.0, 1.5];
const HEAD_TP = 4, HEAD_SL = 6;
const TICK = 0.25;
const RTH_OPEN = 570, RTH_CLOSE = 1020, ENTRY_CUTOFF = 1005, FLAT_AT = 1015; // ET minutes

type Mode = "std" | "pess" | "opt";
type Sess = "RTH" | "ALL";

// ───────────────────────── RNG ─────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r2 = (x: number): number => Math.round(x * 100) / 100;

// ───────────────────────── ET minute-of-day, cached per UTC hour ─────────────────────────
const ET_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
const hourCache = new Map<number, { h: number; wd: string }>();
function etInfo(t: number): { min: number; wd: string } {
  const hb = Math.floor(t / 3600);
  let c = hourCache.get(hb);
  if (!c) {
    const parts = ET_FMT.formatToParts(new Date(hb * 3600 * 1000));
    const g = (k: string): string => parts.find(p => p.type === k)?.value ?? "0";
    c = { h: +g("hour") % 24, wd: g("weekday") };
    hourCache.set(hb, c);
  }
  return { min: c.h * 60 + Math.floor((t % 3600) / 60), wd: c.wd };
}

// ───────────────────────── LOAD ─────────────────────────
interface B { t: number; o: number; h: number; l: number; c: number; v: number; min: number; key: string; rth: boolean }
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const fromTs = etWallToEpoch(LOOKBACK_FROM, 0, 0);
const raw = db.prepare(`SELECT timestamp t, open o, high h, low l, close c, volume v FROM cached_candles WHERE symbol='MES' AND resolution='1' AND timestamp>=? ORDER BY timestamp`).all(fromTs) as Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
const stage: typeof raw = [];
let dropSpike = 0, dropClosed = 0, dropBad = 0;
for (const r of raw) {
  if (r.t % 60 !== 0 || !(r.h >= r.l) || r.o > r.h || r.o < r.l || r.c > r.h || r.c < r.l || r.c <= 0) { dropBad++; continue; }
  if ((r.h - r.l) / r.c > 0.025) { dropSpike++; continue; }
  const { min, wd } = etInfo(r.t);
  if (min >= 1020 && min < 1080) { dropClosed++; continue; }
  if (wd === "Sat" || (wd === "Sun" && min < 1080) || (wd === "Fri" && min >= 1020)) { dropClosed++; continue; }
  stage.push(r);
}
const bars: B[] = [];
let dropIso = 0, openSpikeFixed = 0;
// Contract-roll day: the stored series switches Sep->Dec at 11:31 ET on 2026-09-14 (+67.25 pt step,
// see results.json jumps). No entries on that session day.
const EXCLUDE_KEYS = new Set(["2026-09-14"]);
for (let i = 0; i < stage.length; i++) {
  const r = stage[i];
  const prev = bars.length ? bars[bars.length - 1].c : null;
  const next = i + 1 < stage.length ? stage[i + 1].c : null;
  if (prev !== null && next !== null && Math.abs(r.c - prev) / prev > 0.0025 && Math.abs(r.c - next) / next > 0.0025) { dropIso++; continue; }
  if (prev !== null && Math.abs(r.o - prev) >= 10 && Math.abs(r.o - r.c) >= 10 && Math.abs(r.c - prev) < 5) {
    // single bad opening print (e.g. 2026-09-24 13:29 ET: O 7781 vs prev close 7766 / close 7766.25)
    const hi0 = Math.max(prev, r.c), lo0 = Math.min(prev, r.c);
    r.o = prev;
    if (r.h - hi0 >= 10) r.h = hi0; else r.h = Math.max(r.h, hi0);
    if (lo0 - r.l >= 10) r.l = lo0; else r.l = Math.min(r.l, lo0);
    openSpikeFixed++;
  }
  const { min } = etInfo(r.t);
  bars.push({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v ?? 0, min, key: sessionDayKey(r.t), rth: min >= RTH_OPEN && min < RTH_CLOSE });
}
const N = bars.length;
console.log(`[load] 1m raw ${raw.length} kept ${N} (bad ${dropBad}, spike ${dropSpike}, closed ${dropClosed}, isolated ${dropIso}, open-spike repaired ${openSpikeFixed})`);

// Window days + halves
const winKeys = [...new Set(bars.filter(b => b.key >= WIN_FROM && b.key <= WIN_TO && !EXCLUDE_KEYS.has(b.key)).map(b => b.key))].sort();
const midKey = winKeys[Math.floor(winKeys.length / 2)];
const half = (k: string): "H1" | "H2" => (k < midKey ? "H1" : "H2");
const rthDays = new Set(bars.filter(b => b.key >= WIN_FROM && b.key <= WIN_TO && b.rth && !EXCLUDE_KEYS.has(b.key)).map(b => b.key));
console.log(`[load] window ${winKeys[0]}..${winKeys[winKeys.length - 1]} days ${winKeys.length} (RTH days ${rthDays.size}); H2 starts ${midKey}`);
const inWin = (k: string): boolean => k >= WIN_FROM && k <= WIN_TO && !EXCLUDE_KEYS.has(k);

// Data sanity: large consecutive jumps within the window (roll contamination / gaps)
const jumps: Array<{ t: string; prevC: number; o: number; jump: number }> = [];
for (let i = 1; i < N; i++) {
  if (!inWin(bars[i].key)) continue;
  const j = bars[i].o - bars[i - 1].c;
  if (Math.abs(j) >= 15 && bars[i].key === bars[i - 1].key) jumps.push({ t: new Date(bars[i].t * 1000).toISOString(), prevC: bars[i - 1].c, o: bars[i].o, jump: r2(j) });
}
console.log(`[sanity] intra-session 1m open-vs-prev-close jumps >= 15 pts in window: ${jumps.length}`, jumps.slice(0, 10));

// 1m bar-range distribution (what a 3-5 pt bracket lives inside)
function q(xs: number[], p: number): number { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; }
const rangeStats: Record<string, unknown> = {};
for (const lbl of ["RTH", "ETH"] as const) {
  const rs = bars.filter(b => inWin(b.key) && (lbl === "RTH" ? b.rth : !b.rth)).map(b => b.h - b.l);
  rangeStats[lbl] = {
    n: rs.length, p25: q(rs, 0.25), median: q(rs, 0.5), p75: q(rs, 0.75), p90: q(rs, 0.9),
    pctGE3: r2(100 * rs.filter(x => x >= 3).length / rs.length), pctGE4: r2(100 * rs.filter(x => x >= 4).length / rs.length),
    pctGE7: r2(100 * rs.filter(x => x >= 7).length / rs.length), pctGE10: r2(100 * rs.filter(x => x >= 10).length / rs.length),
  };
}
// first 30 RTH minutes separately
{
  const rs = bars.filter(b => inWin(b.key) && b.min >= RTH_OPEN && b.min < RTH_OPEN + 30).map(b => b.h - b.l);
  rangeStats["RTH_first30"] = { n: rs.length, median: q(rs, 0.5), p75: q(rs, 0.75), pctGE7: r2(100 * rs.filter(x => x >= 7).length / rs.length), pctGE10: r2(100 * rs.filter(x => x >= 10).length / rs.length) };
}
console.log("[ranges] 1m H-L", JSON.stringify(rangeStats));

// ───────────────────────── SIM ─────────────────────────
interface Res { exitIdx: number; gross: number; ambiguous: boolean; entryBar: boolean; flat: boolean; win: boolean }
function sim(ei: number, dir: 1 | -1, tp: number, sl: number, mode: Mode): Res {
  const e = bars[ei].o, key = bars[ei].key;
  const tpPx = e + dir * tp, slPx = e - dir * sl;
  const thr = mode === "pess" ? TICK : 0;
  for (let i = ei; i < N; i++) {
    const b = bars[i];
    if (b.key !== key || b.min >= FLAT_AT && b.min < 1080) {
      const x = bars[i - 1].c; // flat at the close of the last bar before 16:55 / session end
      const g = dir * (x - e);
      return { exitIdx: i - 1, gross: g, ambiguous: false, entryBar: i - 1 === ei, flat: true, win: g > 0 };
    }
    const hitSL = dir > 0 ? b.l <= slPx : b.h >= slPx;
    const hitTP = dir > 0 ? b.h >= tpPx + thr : b.l <= tpPx - thr;
    if (hitSL && hitTP && mode === "opt") return { exitIdx: i, gross: tp, ambiguous: true, entryBar: i === ei, flat: false, win: true };
    if (hitSL) {
      let fill = slPx;
      if (i > ei && (dir > 0 ? b.o < slPx : b.o > slPx)) fill = b.o; // gap through the stop
      return { exitIdx: i, gross: dir * (fill - e), ambiguous: hitTP, entryBar: i === ei, flat: false, win: false };
    }
    if (hitTP) return { exitIdx: i, gross: tp, ambiguous: false, entryBar: i === ei, flat: false, win: true };
  }
  const x = bars[N - 1].c; const g = dir * (x - e);
  return { exitIdx: N - 1, gross: g, ambiguous: false, entryBar: false, flat: true, win: g > 0 };
}

interface Sig { i: number; dir: 1 | -1 }   // i = signal bar index (completed bar); entry = i+1 open
function entryOk(s: Sig, sess: Sess): boolean {
  const a = bars[s.i], b = bars[s.i + 1];
  if (!b || b.key !== a.key || b.t - a.t > 120) return false;
  if (!inWin(b.key)) return false;
  if (b.min >= ENTRY_CUTOFF && b.min < 1080) return false;
  if (sess === "RTH" && !(a.min >= RTH_OPEN && a.min < ENTRY_CUTOFF && b.min >= RTH_OPEN)) return false;
  return true;
}
interface Trade { ei: number; dir: 1 | -1; r: Res }
function runCell(sigs: Sig[], sess: Sess, tp: number, sl: number, mode: Mode, block = true): Trade[] {
  const out: Trade[] = [];
  let busyUntil = -1;
  for (const s of sigs) {
    if (!entryOk(s, sess)) continue;
    const ei = s.i + 1;
    if (block && ei <= busyUntil) continue;
    const r = sim(ei, s.dir, tp, sl, mode);
    out.push({ ei, dir: s.dir, r });
    busyUntil = r.exitIdx;
  }
  return out;
}
interface Met { sd: number; n: number; tpd: number; win: number; net: number; pf: number; maxDD: number; cum: number; t: number; h1n: number; h1: number; h2n: number; h2: number; amb: number; entryBar: number; medHoldMin: number; flat: number }
function metrics(tr: Trade[], fr: number, sess: Sess): Met {
  const days = sess === "RTH" ? rthDays.size : winKeys.length;
  const nets = tr.map(x => x.r.gross - fr);
  const n = nets.length;
  if (!n) return { sd: 0, n: 0, tpd: 0, win: 0, net: 0, pf: 0, maxDD: 0, cum: 0, t: 0, h1n: 0, h1: 0, h2n: 0, h2: 0, amb: 0, entryBar: 0, medHoldMin: 0, flat: 0 };
  const mean = nets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const pos = nets.filter(x => x > 0).reduce((a, b) => a + b, 0), neg = -nets.filter(x => x < 0).reduce((a, b) => a + b, 0);
  const order = tr.map((x, k) => ({ t: bars[x.r.exitIdx].t, v: nets[k] })).sort((a, b) => a.t - b.t);
  let cum = 0, peak = 0, dd = 0;
  for (const o of order) { cum += o.v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const h1 = tr.map((x, k) => ({ h: half(bars[x.ei].key), v: nets[k] }));
  const H = (h: string): number[] => h1.filter(x => x.h === h).map(x => x.v);
  const avg = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const holds = tr.map(x => (bars[x.r.exitIdx].t - bars[x.ei].t) / 60 + 1).sort((a, b) => a - b);
  return {
    sd: r2(sd), n, tpd: r2(n / days), win: r2(100 * nets.filter(x => x > 0).length / n), net: r2(mean), pf: neg ? r2(pos / neg) : 99,
    maxDD: r2(dd), cum: r2(cum), t: sd ? r2(mean / (sd / Math.sqrt(n))) : 0,
    h1n: H("H1").length, h1: r2(avg(H("H1"))), h2n: H("H2").length, h2: r2(avg(H("H2"))),
    amb: r2(100 * tr.filter(x => x.r.ambiguous).length / n), entryBar: r2(100 * tr.filter(x => x.r.entryBar).length / n),
    medHoldMin: holds[Math.floor(holds.length / 2)], flat: tr.filter(x => x.r.flat).length,
  };
}

// ───────────────────────── INDICATORS ─────────────────────────
// Vector = Highest(Lowest(low,20),20) over the continuous 1m series (ETH bars included, like the chart).
const lowest = new Float64Array(N), vec = new Float64Array(N);
for (let i = 0; i < N; i++) { let m = Infinity; for (let k = Math.max(0, i - 19); k <= i; k++) m = Math.min(m, bars[k].l); lowest[i] = m; }
for (let i = 0; i < N; i++) { let m = -Infinity; for (let k = Math.max(0, i - 19); k <= i; k++) m = Math.max(m, lowest[k]); vec[i] = m; }

// Session VWAP (anchor RTH 09:30, or Globex 18:00) + volume-weighted sigma
function vwapSeries(anchor: "RTH" | "GLOBEX"): { vw: Float64Array; sd: Float64Array; nb: Int32Array } {
  const vw = new Float64Array(N).fill(NaN), sd = new Float64Array(N).fill(NaN), nb = new Int32Array(N);
  let key = "", pv = 0, vv = 0, p2 = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    const b = bars[i];
    if (anchor === "RTH" && !b.rth) { key = ""; continue; }
    if (b.key !== key) { key = b.key; pv = 0; vv = 0; p2 = 0; cnt = 0; }
    const tp = (b.h + b.l + b.c) / 3, v = Math.max(1, b.v);
    pv += tp * v; vv += v; p2 += tp * tp * v; cnt++;
    const m = pv / vv; vw[i] = m; sd[i] = Math.sqrt(Math.max(0, p2 / vv - m * m)); nb[i] = cnt;
  }
  return { vw, sd, nb };
}

// Yellow-box zones per session day
const ybRows = db.prepare(`SELECT day_key, box_top, box_bottom, init_res, init_sup FROM yellowbox_day_zones WHERE symbol='MES' AND traded=1 AND ver=5`).all() as Array<{ day_key: string; box_top: number; box_bottom: number; init_res: number; init_sup: number }>;
const yb = new Map(ybRows.map(r => [r.day_key, r]));
console.log(`[yb] zone days in window: ${winKeys.filter(k => yb.has(k)).length}/${winKeys.length}`);

// ───────────────────────── STRATEGY SIGNALS ─────────────────────────
const strategies: Record<string, { sigs: Sig[]; sessions: Sess[]; note: string }> = {};
const add = (name: string, sigs: Sig[], sessions: Sess[], note: string): void => { strategies[name] = { sigs, sessions, note }; };

// (a) vector pullback
for (const X of [1, 2, 3]) {
  const s: Sig[] = [];
  for (let i = 30; i < N - 1; i++) {
    const c1 = bars[i - 1].c, c0 = bars[i].c;
    if (bars[i].key !== bars[i - 10].key) continue;
    const rising = vec[i] > vec[i - 5], falling = vec[i] < vec[i - 5];
    let mx = -Infinity, mn = Infinity;
    for (let k = i - 10; k <= i - 2; k++) { mx = Math.max(mx, bars[k].c - vec[k]); mn = Math.min(mn, bars[k].c - vec[k]); }
    if (rising && c1 - vec[i - 1] >= 0 && c1 - vec[i - 1] <= X && c0 > c1 && c0 > vec[i] && mx >= X + 2) s.push({ i, dir: 1 });
    else if (falling && vec[i - 1] - c1 >= 0 && vec[i - 1] - c1 <= X && c0 < c1 && c0 < vec[i] && mn <= -(X + 2)) s.push({ i, dir: -1 });
  }
  add(`a_vecPullback_X${X}`, s, ["RTH", "ALL"], `1m close within ${X} pt of a rising (falling) vector after being >= ${X + 2} pt away in the prior 10 bars, then a higher (lower) close beyond the vector`);
}

// (b) yellow-box fade + break-retest
function levelsFor(key: string, set: "edges" | "L4"): number[] {
  const z = yb.get(key); if (!z) return [];
  return set === "edges" ? [z.box_top, z.box_bottom] : [z.box_top, z.box_bottom, z.init_res, z.init_sup];
}
for (const set of ["edges", "L4"] as const) {
  const fade: Sig[] = [], br: Sig[] = [];
  const armed = new Map<number, { dir: 1 | -1; since: number }>(); // level -> armed retest
  let curKey = "";
  for (let i = 1; i < N - 1; i++) {
    const b = bars[i], p = bars[i - 1];
    if (b.key !== curKey) { curKey = b.key; armed.clear(); }
    if (p.key !== b.key) continue;
    const L = levelsFor(b.key, set);
    let fired = false;
    for (const lv of L) {
      if (!fired && p.c < lv && b.h >= lv && b.c < lv) { fade.push({ i, dir: -1 }); fired = true; }
      else if (!fired && p.c > lv && b.l <= lv && b.c > lv) { fade.push({ i, dir: 1 }); fired = true; }
    }
    let fired2 = false;
    for (const lv of L) {
      const a = armed.get(lv);
      if (a) {
        if (i - a.since > 30 || (a.dir > 0 ? b.c < lv - 2 : b.c > lv + 2)) armed.delete(lv);
        else if (i > a.since && !fired2 && (a.dir > 0 ? b.l <= lv + 1 && b.c > lv : b.h >= lv - 1 && b.c < lv)) { br.push({ i, dir: a.dir }); armed.delete(lv); fired2 = true; continue; }
      }
      if (p.c <= lv && b.c > lv) armed.set(lv, { dir: 1, since: i });
      else if (p.c >= lv && b.c < lv) armed.set(lv, { dir: -1, since: i });
    }
  }
  add(`b_ybFade_${set}`, fade, ["RTH", "ALL"], `bar wicks through a yellow-box ${set === "edges" ? "edge (box top/bottom)" : "level (box top/bottom + initRes/initSup)"} approached from the other side and closes back inside -> fade`);
  add(`b_ybBreakRetest_${set}`, br, ["RTH", "ALL"], `close through a ${set} level, then within 30 bars a bar dips back to within 1 pt of it and closes on the break side -> continuation`);
}

// (d) VWAP bands
for (const anchor of ["RTH", "GLOBEX"] as const) {
  const { vw, sd, nb } = vwapSeries(anchor);
  for (const k of [1, 2]) {
    const re: Sig[] = [], touch: Sig[] = [];
    for (let i = 1; i < N - 1; i++) {
      if (isNaN(vw[i]) || isNaN(vw[i - 1]) || nb[i] < 15 || bars[i].key !== bars[i - 1].key) continue;
      const up1 = vw[i - 1] + k * sd[i - 1], dn1 = vw[i - 1] - k * sd[i - 1];
      const up0 = vw[i] + k * sd[i], dn0 = vw[i] - k * sd[i];
      if (bars[i - 1].c > up1 && bars[i].c <= up0) re.push({ i, dir: -1 });
      else if (bars[i - 1].c < dn1 && bars[i].c >= dn0) re.push({ i, dir: 1 });
      if (bars[i - 1].c <= up1 && bars[i].c > up0) touch.push({ i, dir: -1 });
      else if (bars[i - 1].c >= dn1 && bars[i].c < dn0) touch.push({ i, dir: 1 });
    }
    const sessions: Sess[] = anchor === "RTH" ? ["RTH"] : ["ALL"];
    add(`d_vwapReentry_${anchor}_${k}sd`, re, sessions, `${anchor}-anchored VWAP: close back inside the ±${k}σ band after a close outside -> fade toward VWAP`);
    add(`d_vwapFirstClose_${anchor}_${k}sd`, touch, sessions, `${anchor}-anchored VWAP: first close outside ±${k}σ -> fade immediately`);
  }
}

// (e) opening range breakout + (f) first pullback — RTH by construction
const dayFirstRth = new Map<string, number>();
for (let i = 0; i < N; i++) if (bars[i].min === RTH_OPEN && !dayFirstRth.has(bars[i].key)) dayFirstRth.set(bars[i].key, i);
for (const orMin of [15, 30]) {
  const s: Sig[] = [];
  for (const [key, i0] of dayFirstRth) {
    let hi = -Infinity, lo = Infinity, i = i0;
    for (; i < N && bars[i].key === key && bars[i].min < RTH_OPEN + orMin; i++) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); }
    let didL = false, didS = false;
    for (; i < N - 1 && bars[i].key === key && bars[i].min < 720; i++) {
      if (!didL && bars[i].c > hi) { s.push({ i, dir: 1 }); didL = true; }
      else if (!didS && bars[i].c < lo) { s.push({ i, dir: -1 }); didS = true; }
    }
  }
  s.sort((a, b) => a.i - b.i);
  add(`e_ORB_${orMin}m`, s, ["RTH"], `first 1m close beyond the ${orMin}-min opening range (each side at most once per day, until 12:00 ET)`);
}
for (const D of [5, 8]) {
  const s: Sig[] = [];
  for (const [key, i0] of dayFirstRth) {
    const O = bars[i0].o; let hod = -Infinity, lod = Infinity, dir: 0 | 1 | -1 = 0, pulled = false;
    for (let i = i0; i < N - 1 && bars[i].key === key && bars[i].min < 660; i++) {
      const b = bars[i]; hod = Math.max(hod, b.h); lod = Math.min(lod, b.l);
      if (dir === 0) { if (hod - O >= D) dir = 1; else if (O - lod >= D) dir = -1; continue; }
      if (!pulled) {
        if (dir > 0 && b.c < b.o && hod - b.l >= 2) pulled = true;
        else if (dir < 0 && b.c > b.o && b.h - lod >= 2) pulled = true;
        continue;
      }
      const p = bars[i - 1];
      if (dir > 0 && b.c > p.h) { s.push({ i, dir: 1 }); break; }
      if (dir < 0 && b.c < p.l) { s.push({ i, dir: -1 }); break; }
    }
  }
  s.sort((a, b) => a.i - b.i);
  add(`f_firstPullback_D${D}`, s, ["RTH"], `after a >= ${D}-pt impulse from the 09:30 open, the first counter-colour bar retracing >= 2 pt, then the first close beyond the prior bar's extreme -> with the impulse (1/day, until 11:00 ET)`);
}

// (c) footprint stacked-imbalance continuation (two-sided rows only)
const fpRows = db.prepare(`SELECT time, data FROM footprint_candles WHERE symbol='MES' AND interval='5m' AND complete=1 ORDER BY time`).all() as Array<{ time: number; data: string }>;
const c5 = new Map((db.prepare(`SELECT timestamp t, open o, close c FROM cached_candles WHERE symbol='MES' AND resolution='5' AND timestamp>=?`).all(fpRows[0]?.time ?? 0) as Array<{ t: number; o: number; c: number }>).map(r => [r.t, r]));
const idxByT = new Map<number, number>(); bars.forEach((b, i) => idxByT.set(b.t, i));
const fpSigs: Sig[] = [], fpDefect = { rows: fpRows.length, askZero: 0, bidZero: 0, twoSided: 0, twoSidedDays: new Set<string>(), stackedSellInWindow: 0, stackedBuyInWindow: 0 };
for (const r of fpRows) {
  let d: { totalBidVol?: number; totalAskVol?: number; imbalances?: Array<{ direction: "buy" | "sell"; levelCount: number }> };
  try { d = JSON.parse(r.data); } catch { continue; }
  const a = d.totalAskVol ?? 0, bv = d.totalBidVol ?? 0;
  const im = (d.imbalances ?? []).filter(x => x.levelCount >= 3);
  if (inWin(sessionDayKey(r.time))) { fpDefect.stackedSellInWindow += im.filter(x => x.direction === "sell").length; fpDefect.stackedBuyInWindow += im.filter(x => x.direction === "buy").length; }
  if (a === 0) { fpDefect.askZero++; continue; }
  if (bv === 0) { fpDefect.bidZero++; continue; }
  fpDefect.twoSided++; fpDefect.twoSidedDays.add(sessionDayKey(r.time));
  const buy = im.filter(x => x.direction === "buy").length, sell = im.filter(x => x.direction === "sell").length;
  const bar5 = c5.get(r.time); if (!bar5) continue;
  const lastIdx = idxByT.get(r.time + 240); if (lastIdx === undefined) continue;
  if (buy > 0 && sell === 0 && bar5.c > bar5.o && a > bv) fpSigs.push({ i: lastIdx, dir: 1 });
  else if (sell > 0 && buy === 0 && bar5.c < bar5.o && bv > a) fpSigs.push({ i: lastIdx, dir: -1 });
}
console.log(`[fp] rows ${fpDefect.rows}: askVol=0 ${fpDefect.askZero}, bidVol=0 ${fpDefect.bidZero}, two-sided ${fpDefect.twoSided} on ${fpDefect.twoSidedDays.size} days; in-window stacked(>=3) sell ${fpDefect.stackedSellInWindow} buy ${fpDefect.stackedBuyInWindow}; signals ${fpSigs.length}`);

// ───────────────────────── RUN GRID ─────────────────────────
interface Row { strat: string; sess: Sess; mode: Mode; fr: number; tp: number; sl: number; m: Met }
const rows: Row[] = [];
const run = (name: string, sigs: Sig[], sessions: Sess[], winOverride = false): void => {
  for (const sess of sessions) for (const mode of ["std", "pess", "opt"] as Mode[]) for (const tp of TPS) for (const sl of SLS) {
    const tr = winOverride ? runCellFp(sigs, sess, tp, sl, mode) : runCell(sigs, sess, tp, sl, mode);
    for (const fr of FRICTIONS) rows.push({ strat: name, sess, mode, fr, tp, sl, m: metrics(tr, fr, sess) });
  }
};
// footprint runs outside the window (its own dates)
function runCellFp(sigs: Sig[], sess: Sess, tp: number, sl: number, mode: Mode): Trade[] {
  const out: Trade[] = []; let busy = -1;
  for (const s of sigs) {
    const a = bars[s.i], b = bars[s.i + 1];
    if (!b || b.key !== a.key || b.t - a.t > 120 || (b.min >= ENTRY_CUTOFF && b.min < 1080)) continue;
    if (sess === "RTH" && !(a.min >= RTH_OPEN && a.min < ENTRY_CUTOFF)) continue;
    if (s.i + 1 <= busy) continue;
    const r = sim(s.i + 1, s.dir, tp, sl, mode); out.push({ ei: s.i + 1, dir: s.dir, r }); busy = r.exitIdx;
  }
  return out;
}
for (const [name, st] of Object.entries(strategies)) run(name, st.sigs, st.sessions);
run("c_fpStackedCont_2sided", fpSigs, ["RTH", "ALL"], true);
console.log(`[grid] rows ${rows.length}`);

// ───────────────────────── NULLS ─────────────────────────
// (1) random time + random direction, per session, per cell, no blocking
const nullRows: Array<{ sess: Sess; mode: Mode; fr: number; tp: number; sl: number; n: number; win: number; net: number; se: number; amb: number; entryBar: number }> = [];
for (const sess of ["RTH", "ALL"] as Sess[]) {
  const elig: number[] = [];
  for (let i = 0; i < N - 1; i++) if (entryOk({ i, dir: 1 }, sess)) elig.push(i);
  const rnd = mulberry32(sess === "RTH" ? 11 : 22);
  const picks = Array.from({ length: 30000 }, () => ({ i: elig[Math.floor(rnd() * elig.length)], dir: (rnd() < 0.5 ? 1 : -1) as 1 | -1 }));
  for (const mode of ["std", "pess", "opt"] as Mode[]) for (const tp of TPS) for (const sl of SLS) {
    const rs = picks.map(p => sim(p.i + 1, p.dir, tp, sl, mode));
    for (const fr of FRICTIONS) {
      const nets = rs.map(r => r.gross - fr); const n = nets.length; const mean = nets.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
      nullRows.push({ sess, mode, fr, tp, sl, n, win: r2(100 * nets.filter(x => x > 0).length / n), net: r2(mean), se: r2(sd / Math.sqrt(n)), amb: r2(100 * rs.filter(r => r.ambiguous).length / n), entryBar: r2(100 * rs.filter(r => r.entryBar).length / n) });
    }
  }
}
// (2) coin-flip direction on each strategy's own (admitted) entry bars — headline cell + std/pess, F=1.0
const coinflip: Record<string, Record<string, { stratNet: number; flipNet: number; flipSE: number; invertedNet: number; n: number }>> = {};
for (const [name, st] of [...Object.entries(strategies), ["c_fpStackedCont_2sided", { sigs: fpSigs, sessions: ["RTH", "ALL"] as Sess[], note: "" }] as const]) {
  coinflip[name] = {};
  for (const sess of st.sessions) for (const mode of ["std", "pess"] as Mode[]) {
    const tr = name.startsWith("c_") ? runCellFp(st.sigs, sess, HEAD_TP, HEAD_SL, mode) : runCell(st.sigs, sess, HEAD_TP, HEAD_SL, mode);
    if (!tr.length) continue;
    const seeds: number[] = [];
    for (let sd = 0; sd < 20; sd++) {
      const rnd = mulberry32(1000 + sd);
      const g = tr.map(t => sim(t.ei, rnd() < 0.5 ? 1 : -1, HEAD_TP, HEAD_SL, mode).gross - 1.0);
      seeds.push(g.reduce((a, b) => a + b, 0) / g.length);
    }
    const inv = tr.map(t => sim(t.ei, (-t.dir) as 1 | -1, HEAD_TP, HEAD_SL, mode).gross - 1.0);
    const m = seeds.reduce((a, b) => a + b, 0) / seeds.length;
    const sdv = Math.sqrt(seeds.reduce((a, b) => a + (b - m) ** 2, 0) / (seeds.length - 1));
    coinflip[name][`${sess}_${mode}`] = { stratNet: r2(tr.reduce((a, t) => a + t.r.gross - 1.0, 0) / tr.length), flipNet: r2(m), flipSE: r2(sdv), invertedNet: r2(inv.reduce((a, b) => a + b, 0) / inv.length), n: tr.length };
  }
}

// ───────────────────────── REPORT ─────────────────────────
const csvHead = "strategy,session,scoring,friction,tp,sl,n,tradesPerDay,winPct,netPerTrade,pf,maxDD,cumNet,t,h1n,h1Net,h2n,h2Net,ambiguousPct,entryBarPct,medHoldMin,flattened";
fs.writeFileSync(path.join(OUT, "grid.csv"), [csvHead, ...rows.map(r => [r.strat, r.sess, r.mode, r.fr, r.tp, r.sl, r.m.n, r.m.tpd, r.m.win, r.m.net, r.m.pf, r.m.maxDD, r.m.cum, r.m.t, r.m.h1n, r.m.h1, r.m.h2n, r.m.h2, r.m.amb, r.m.entryBar, r.m.medHoldMin, r.m.flat].join(","))].join("\n"));
fs.writeFileSync(path.join(OUT, "null.csv"), ["session,scoring,friction,tp,sl,n,winPct,netPerTrade,se,ambiguousPct,entryBarPct", ...nullRows.map(r => [r.sess, r.mode, r.fr, r.tp, r.sl, r.n, r.win, r.net, r.se, r.amb, r.entryBar].join(","))].join("\n"));

const lines: string[] = [];
const P = (s: string): void => { lines.push(s); console.log(s); };
const nullOf = (sess: Sess, mode: Mode, fr: number, tp: number, sl: number) => nullRows.find(x => x.sess === sess && x.mode === mode && x.fr === fr && x.tp === tp && x.sl === sl)!;
P(`\n=== HEADLINE CELL TP ${HEAD_TP} / SL ${HEAD_SL} (pre-registered) — window ${winKeys[0]}..${winKeys[winKeys.length - 1]} ===`);
P("strategy | sess | scoring | F | n | tr/day | win% | net/tr | PF | maxDD | t | H1 n/net | H2 n/net | amb% | entryBar% | medHold | null net | t vs null");
const headline: Array<Row & { nullNet: number | null; tVsNull: number | null }> = [];
for (const r of rows) if (r.tp === HEAD_TP && r.sl === HEAD_SL && r.mode !== "opt") {
  const nl = nullOf(r.sess, r.mode, r.fr, r.tp, r.sl);
  const tv = r.m.n && r.m.sd ? r2((r.m.net - nl.net) / (r.m.sd / Math.sqrt(r.m.n))) : null;
  headline.push({ ...r, nullNet: nl.net, tVsNull: tv });
  P(`${r.strat} | ${r.sess} | ${r.mode} | ${r.fr} | ${r.m.n} | ${r.m.tpd} | ${r.m.win} | ${r.m.net} | ${r.m.pf} | ${r.m.maxDD} | ${r.m.t} | ${r.m.h1n}/${r.m.h1} | ${r.m.h2n}/${r.m.h2} | ${r.m.amb} | ${r.m.entryBar} | ${r.m.medHoldMin} | ${nl.net} | ${tv}`);
}

// Manual-reaction sensitivity: enter one bar LATER (open of signal+2), headline cell, std, F1.0
P(`
=== LATE ENTRY (+1 bar, ~60 s manual reaction) vs on-time, TP4/SL6 std F1.0 ===`);
const lateRows: Array<Record<string, unknown>> = [];
for (const [name, st] of Object.entries(strategies)) for (const sess of st.sessions) {
  const on = metrics(runCell(st.sigs, sess, HEAD_TP, HEAD_SL, "std"), 1.0, sess);
  const lt = metrics(runCell(st.sigs.map(x => ({ i: x.i + 1, dir: x.dir })), sess, HEAD_TP, HEAD_SL, "std"), 1.0, sess);
  lateRows.push({ strat: name, sess, onNet: on.net, onN: on.n, lateNet: lt.net, lateN: lt.n, lateWin: lt.win });
  P(`${name} ${sess}: on-time ${on.net} (n ${on.n}) -> late ${lt.net} (n ${lt.n}, win ${lt.win}%)`);
}

// Vector validation against the engine's own 1m vector (signals-3mo.json status.vector.1m)
let vecCheck: Record<string, unknown> = {};
try {
  const ds = JSON.parse(fs.readFileSync("C:/BaxterSandbox/analysis/signals-3mo.json", "utf8")) as { rows: Array<{ status?: { vector?: Record<string, { value: number; barTime: number } | null> } }> };
  const diffs: number[] = [];
  for (const row of ds.rows) {
    const v = row.status?.vector?.["1m"]; if (!v || v.value == null || !v.barTime) continue;
    const k = idxByT.get(v.barTime); if (k === undefined) continue;
    diffs.push(Math.abs(vec[k] - v.value));
  }
  diffs.sort((a, b) => a - b);
  vecCheck = { n: diffs.length, exactPct: r2(100 * diffs.filter(d => d < 0.01).length / diffs.length), within1Pct: r2(100 * diffs.filter(d => d <= 1).length / diffs.length), median: diffs[Math.floor(diffs.length / 2)], p90: diffs[Math.floor(diffs.length * 0.9)] };
} catch (e) { vecCheck = { error: String(e) }; }
P(`
[vector check vs engine status.vector.1m] ${JSON.stringify(vecCheck)}`);
P(`\n=== BEST CELL PER STRATEGY×SESSION (IN-SAMPLE PICK, std, F=1.0) and positive-cell counts ===`);
const best: Array<Record<string, unknown>> = [];
for (const name of [...Object.keys(strategies), "c_fpStackedCont_2sided"]) for (const sess of ["RTH", "ALL"] as Sess[]) {
  const cells = rows.filter(r => r.strat === name && r.sess === sess && r.mode === "std" && r.fr === 1.0 && r.m.n > 0);
  if (!cells.length) continue;
  const b = cells.reduce((a, c) => (c.m.net > a.m.net ? c : a));
  const pess = rows.find(r => r.strat === name && r.sess === sess && r.mode === "pess" && r.fr === 1.0 && r.tp === b.tp && r.sl === b.sl)!;
  const pos = (mode: Mode, fr: number): number => rows.filter(r => r.strat === name && r.sess === sess && r.mode === mode && r.fr === fr && r.m.net > 0).length;
  const rec = { strat: name, sess, tp: b.tp, sl: b.sl, n: b.m.n, tpd: b.m.tpd, win: b.m.win, net: b.m.net, pf: b.m.pf, maxDD: b.m.maxDD, t: b.m.t, h1: b.m.h1, h2: b.m.h2, pessNet: pess.m.net, pessWin: pess.m.win, posCells_std_F1: pos("std", 1.0), posCells_pess_F1: pos("pess", 1.0), posCells_std_F15: pos("std", 1.5), posCells_opt_F1: pos("opt", 1.0) };
  best.push(rec);
  P(`${name} | ${sess} | best TP${b.tp}/SL${b.sl} n ${b.m.n} (${b.m.tpd}/day) win ${b.m.win}% net ${b.m.net} PF ${b.m.pf} DD ${b.m.maxDD} t ${b.m.t} H1 ${b.m.h1} H2 ${b.m.h2} | pess net ${pess.m.net} | positive cells of 15: std/F1 ${rec.posCells_std_F1}, pess/F1 ${rec.posCells_pess_F1}, std/F1.5 ${rec.posCells_std_F15}, opt/F1 ${rec.posCells_opt_F1}`);
}
P(`\n=== RANDOM-ENTRY NULL (30,000 random bar+direction, no blocking) ===`);
for (const sess of ["RTH", "ALL"] as Sess[]) for (const mode of ["std", "pess", "opt"] as Mode[]) {
  const cells = nullRows.filter(x => x.sess === sess && x.mode === mode && x.fr === 1.0);
  P(`${sess} ${mode} F1.0: ` + cells.map(c => `${c.tp}/${c.sl}: win ${c.win}% net ${c.net}±${c.se} amb ${c.amb}%`).join(" ; "));
}
P(`\n=== COIN-FLIP DIRECTION ON OWN ENTRY BARS (TP4/SL6, F1.0) ===`);
for (const [name, v] of Object.entries(coinflip)) for (const [k, x] of Object.entries(v)) P(`${name} ${k}: strategy ${x.stratNet} vs coin-flip ${x.flipNet}±${x.flipSE} vs inverted ${x.invertedNet} (n ${x.n})`);

// optimistic-vs-standard spread on the headline cell (what 1m cannot settle)
P(`\n=== 1m RESOLUTION LIMIT: headline cell OPT − STD and STD − PESS net/trade (F1.0) ===`);
const resLimit: Array<Record<string, unknown>> = [];
for (const name of [...Object.keys(strategies), "c_fpStackedCont_2sided"]) for (const sess of ["RTH", "ALL"] as Sess[]) {
  const g = (mode: Mode) => rows.find(r => r.strat === name && r.sess === sess && r.mode === mode && r.fr === 1.0 && r.tp === HEAD_TP && r.sl === HEAD_SL);
  const o = g("opt"), s = g("std"), p = g("pess"); if (!o || !s || !p || !s.m.n) continue;
  resLimit.push({ strat: name, sess, opt: o.m.net, std: s.m.net, pess: p.m.net, amb: s.m.amb, entryBar: s.m.entryBar });
  P(`${name} ${sess}: opt ${o.m.net} std ${s.m.net} pess ${p.m.net} | ambiguous ${s.m.amb}% entry-bar-decided ${s.m.entryBar}%`);
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({
  generated: new Date().toISOString(), window: { from: winKeys[0], to: winKeys[winKeys.length - 1], days: winKeys.length, rthDays: rthDays.size, h2Start: midKey },
  load: { raw: raw.length, kept: N, dropBad, dropSpike, dropClosed, dropIso }, jumps, rangeStats,
  footprintDefect: { ...fpDefect, twoSidedDays: [...fpDefect.twoSidedDays].sort(), signals: fpSigs.length },
  strategies: Object.fromEntries(Object.entries(strategies).map(([k, v]) => [k, { note: v.note, rawSignals: v.sigs.length, sessions: v.sessions }])),
  headline, best, nullRows, coinflip, resLimit, lateRows, vecCheck, openSpikeFixed, excludedKeys: [...EXCLUDE_KEYS],
}, null, 1));
fs.writeFileSync(path.join(OUT, "summary.txt"), lines.join("\n"));
console.log(`\n[done] -> ${OUT}`);
