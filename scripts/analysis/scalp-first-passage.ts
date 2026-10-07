/**
 * scripts/analysis/scalp-first-passage.ts — ANALYSIS ONLY (readonly DB, no persistence, no project edits).
 *
 * RANDOM-ENTRY FIRST-PASSAGE BASELINE for small-target "scalp" brackets on MES 1m bars (RTH entries
 * 09:30–15:15 ET, flat by 16:54 ET close = Apex flat-by-4:59). For every 1m bar close in the window a
 * LONG and a SHORT are opened (the no-edge, symmetric baseline) with a fixed TP/SL grid; outcome is the
 * first barrier touched on subsequent bars (a bar touching BOTH barriers is scored as a LOSS — the
 * conservative bar-level convention; the ambiguity rate is reported). Net = gross − FRICTION (1.0 pt
 * all-in round trip, the project's standing assumption). Breakeven win rate = (SL + F) / (TP + SL).
 *
 * Also: sequential non-overlapping random-direction trades → trades/day and net pts/day ("every few
 * candles" throughput), and mean/median 1m RTH bar range for context.
 *
 * Run: npx tsx scripts/analysis/scalp-first-passage.ts   → C:\BaxterSandbox\analysis\scalping\first-passage.{json,md}
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

const DB_PATH = path.join(process.cwd(), "data", "app.db");
const OUT_DIR = "C:\\BaxterSandbox\\analysis\\scalping";
fs.mkdirSync(OUT_DIR, { recursive: true });
const FRICTION = 1.0;
const DAYS = Number(process.env.SCALP_DAYS ?? 92);
const ENTRY_FROM = 9 * 60 + 30, ENTRY_TO = 15 * 60 + 15, FLAT_AT = 16 * 60 + 54;
const TPS = [3, 4, 5];
const SLS = [3, 4, 5, 8, 10, 15, 25];
const EXTRA: Array<[number, number]> = [[4, 23], [6, 12], [10.5, 26], [12.25, 25]];

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function et(tsSec: number): { mins: number; day: string; wd: string } {
  const parts = fmt.formatToParts(new Date(tsSec * 1000));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const h = Number(g("hour")) % 24, m = Number(g("minute"));
  return { mins: h * 60 + m, day: `${g("year")}-${g("month")}-${g("day")}`, wd: g("weekday") };
}

const db = new Database(DB_PATH, { readonly: true });
const nowSec = Math.floor(Date.now() / 1000);
const fromSec = nowSec - DAYS * 86400;
const rows = db.prepare("SELECT timestamp ts, open, high, low, close FROM cached_candles WHERE symbol='MES' AND resolution='1' AND timestamp>=? ORDER BY timestamp").all(fromSec) as Array<{ ts: number; open: number; high: number; low: number; close: number }>;
db.close();

interface Bar { ts: number; o: number; h: number; l: number; c: number; mins: number; day: string }
const bars: Bar[] = [];
for (const r of rows) {
  const e = et(r.ts);
  if (e.wd === "Sat" || e.wd === "Sun") continue;
  bars.push({ ts: r.ts, o: r.open, h: r.high, l: r.low, c: r.close, mins: e.mins, day: e.day });
}
const byDay = new Map<string, Bar[]>();
for (const b of bars) { if (!byDay.has(b.day)) byDay.set(b.day, []); byDay.get(b.day)!.push(b); }
const days = [...byDay.keys()].sort();

const rthRanges: number[] = [];
for (const b of bars) if (b.mins >= ENTRY_FROM && b.mins < 16 * 60) rthRanges.push(b.h - b.l);
rthRanges.sort((a, b) => a - b);
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const med = (a: number[]) => a.length ? a[Math.floor(a.length / 2)] : NaN;

type Res = { win: boolean; flat: boolean; pts: number; nbars: number; ambig: boolean };
function resolve(dayBars: Bar[], i: number, dir: 1 | -1, tp: number, sl: number): Res | null {
  const entry = dayBars[i].c;
  const tpPx = entry + dir * tp, slPx = entry - dir * sl;
  for (let j = i + 1; j < dayBars.length; j++) {
    const b = dayBars[j];
    if (b.mins > FLAT_AT) break;
    const hitTp = dir === 1 ? b.h >= tpPx : b.l <= tpPx;
    const hitSl = dir === 1 ? b.l <= slPx : b.h >= slPx;
    if (hitTp && hitSl) return { win: false, flat: false, pts: -sl, nbars: j - i, ambig: true };
    if (hitTp) return { win: true, flat: false, pts: tp, nbars: j - i, ambig: false };
    if (hitSl) return { win: false, flat: false, pts: -sl, nbars: j - i, ambig: false };
    if (b.mins === FLAT_AT || j === dayBars.length - 1) return { win: false, flat: true, pts: dir * (b.c - entry), nbars: j - i, ambig: false };
  }
  return null;
}

interface Cell { tp: number; sl: number; n: number; wins: number; flats: number; ambig: number; gross: number; bars: number[]; breakevenWin: number; }
const grid: Array<[number, number]> = [];
for (const tp of TPS) for (const sl of SLS) grid.push([tp, sl]);
for (const x of EXTRA) grid.push(x);
const cells: Cell[] = grid.map(([tp, sl]) => ({ tp, sl, n: 0, wins: 0, flats: 0, ambig: 0, gross: 0, bars: [], breakevenWin: (sl + FRICTION) / (tp + sl) }));

for (const d of days) {
  const db_ = byDay.get(d)!;
  for (let i = 0; i < db_.length; i++) {
    const b = db_[i];
    if (b.mins < ENTRY_FROM || b.mins >= ENTRY_TO) continue;
    for (const cell of cells) {
      for (const dir of [1, -1] as const) {
        const r = resolve(db_, i, dir, cell.tp, cell.sl);
        if (!r) continue;
        cell.n++; if (r.win) cell.wins++; if (r.flat) cell.flats++; if (r.ambig) cell.ambig++;
        cell.gross += r.pts; cell.bars.push(r.nbars);
      }
    }
  }
}

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const seqOut: Array<{ tp: number; sl: number; tradesPerDay: number; netPtsPerDay: number; netPerTrade: number; winPct: number }> = [];
for (const [tp, sl] of [[3, 3], [3, 5], [4, 4], [5, 5], [3, 10], [5, 10]] as Array<[number, number]>) {
  const rng = mulberry32(20261006);
  let trades = 0, wins = 0, net = 0;
  for (const d of days) {
    const db_ = byDay.get(d)!;
    let i = 0;
    while (i < db_.length) {
      const b = db_[i];
      if (b.mins < ENTRY_FROM || b.mins >= ENTRY_TO) { i++; continue; }
      const dir: 1 | -1 = rng() < 0.5 ? 1 : -1;
      const r = resolve(db_, i, dir, tp, sl);
      if (!r) break;
      trades++; if (r.win) wins++; net += r.pts - FRICTION;
      i += r.nbars + 1;
    }
  }
  seqOut.push({ tp, sl, tradesPerDay: trades / days.length, netPtsPerDay: net / days.length, netPerTrade: net / Math.max(1, trades), winPct: 100 * wins / Math.max(1, trades) });
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const table = cells.map((c) => {
  const p = c.wins / c.n;
  const bs = c.bars.slice().sort((a, b) => a - b);
  const netPerTrade = c.gross / c.n - FRICTION;
  const needHalf = (c.sl + FRICTION + 0.5) / (c.tp + c.sl);
  return { tp: c.tp, sl: c.sl, n: c.n, winPct: r2(100 * p), flatPct: r2(100 * c.flats / c.n), ambigPct: r2(100 * c.ambig / c.n), grossPerTrade: r2(c.gross / c.n), netPerTrade: r2(netPerTrade), breakevenWinPct: r2(100 * c.breakevenWin), winPctForPlusHalf: r2(100 * needHalf), edgeGapPctPts: r2(100 * (c.breakevenWin - p)), medianBars: med(bs), meanBars: r2(mean(bs)) };
});

const out = {
  meta: { generated: new Date().toISOString(), db: DB_PATH, symbol: "MES", resolution: "1m", windowDays: DAYS, firstDay: days[0], lastDay: days[days.length - 1], sessionDays: days.length, bars: bars.length, friction: FRICTION, entryWindowET: "09:30–15:15", flatAtET: "16:54 close", convention: "both barriers in one bar = LOSS; every bar close opens a long AND a short (symmetric no-edge baseline)" },
  rthBarRange1m: { mean: r2(mean(rthRanges)), median: r2(med(rthRanges)), p25: r2(rthRanges[Math.floor(rthRanges.length * 0.25)]), p75: r2(rthRanges[Math.floor(rthRanges.length * 0.75)]), p90: r2(rthRanges[Math.floor(rthRanges.length * 0.9)]) },
  grid: table,
  sequentialRandomDirection: seqOut.map((s) => ({ ...s, tradesPerDay: r2(s.tradesPerDay), netPtsPerDay: r2(s.netPtsPerDay), netPerTrade: r2(s.netPerTrade), winPct: r2(s.winPct) })),
};
fs.writeFileSync(path.join(OUT_DIR, "first-passage.json"), JSON.stringify(out, null, 2));
const md: string[] = [];
md.push(`# MES 1m random-entry first-passage baseline (${out.meta.firstDay} → ${out.meta.lastDay}, ${days.length} sessions, ${bars.length} bars)`);
md.push(`Friction ${FRICTION} pt. Entries 09:30–15:15 ET at bar close, long AND short per bar. Flat at 16:54 ET close. Both-barriers-in-one-bar = loss.`);
md.push(`RTH 1m bar range: mean ${out.rthBarRange1m.mean} / median ${out.rthBarRange1m.median} / p75 ${out.rthBarRange1m.p75} / p90 ${out.rthBarRange1m.p90} pts\n`);
md.push(`| TP | SL | n | win% | flat% | ambig% | gross/tr | NET/tr | breakeven win% | win% for +0.5 net | gap (pct pts) | median bars | mean bars |`);
md.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const t of table) md.push(`| ${t.tp} | ${t.sl} | ${t.n} | ${t.winPct} | ${t.flatPct} | ${t.ambigPct} | ${t.grossPerTrade} | ${t.netPerTrade} | ${t.breakevenWinPct} | ${t.winPctForPlusHalf} | ${t.edgeGapPctPts} | ${t.medianBars} | ${t.meanBars} |`);
md.push(`\n## Sequential random-direction throughput ("every few candles")`);
md.push(`| TP | SL | trades/day | win% | net/trade | net pts/day |`);
md.push(`|---|---|---|---|---|---|`);
for (const s of out.sequentialRandomDirection) md.push(`| ${s.tp} | ${s.sl} | ${s.tradesPerDay} | ${s.winPct} | ${s.netPerTrade} | ${s.netPtsPerDay} |`);
fs.writeFileSync(path.join(OUT_DIR, "first-passage.md"), md.join("\n"));
console.log(md.join("\n"));
