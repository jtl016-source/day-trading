// scripts/risk-factor-analysis.ts
// ═════════════════════════════════════════════════════════════════════════════
// POST-HOC RISK-FACTOR ANALYSIS (mission 2026-07-30) — ANALYSIS ONLY.
// Computes 7 proposed risk factors + an A/B/C rating over backtest trades and
// reports win% / expectancy / PF per factor state. NOTHING here touches the live
// engine, the gate file, or the standing results schema.
//
// Inputs:
//   • fact-engine-backtest-results.json — the standing GATED 3-month set (primary).
//   • An UNGATED baseline recomputed via the harness's own exported loadData/
//     enginePass (gate off, neutral config, provisional exits — the literal
//     PHASE-B construction), resolved with a local mirror of the harness walkExit.
//   • DB bars (via loadData) for fractal chop state + daily ranges.
//   • GET /api/yellowbox/day-zones (live server) for the yellowbox stack +
//     persistent bands (roomQuality). Falls back to the harness ybByKey
//     box/init levels (no bands) when the server is down — flagged in meta.
//
// Output: risk-factor-analysis.json (repo root) — separate analysis file with
// per-trade riskFactors + each trade's OWN COMBO TRACK RECORD (held-out basis
// from shared/quality-gate.ts AND realized in-window basis, labeled), + aggregate
// tables. The standing fact-engine-backtest-results.json is never modified.
//
// Run:  npx tsx scripts/risk-factor-analysis.ts          (dev server optional)
//       npx tsx scripts/risk-factor-analysis.ts --spot   (also print 5 hand-check trades)
// ═════════════════════════════════════════════════════════════════════════════
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsDir } from "../shared/artifacts-dir"; // BAXTER_ARTIFACTS_DIR (2026-08-02)
import { loadData, enginePass, INTERVALS, type Loaded } from "./fact-engine-backtest";
import type { Interval, FactSignal } from "../shared/fact-engine";
import { QUALITY_GATE, comboKeyOf, type QualityGateData, type GateClassStat } from "../shared/quality-gate";
import { computeFractalSeries, FRACTAL_CONST, type FractalSeries } from "../shared/fractal-engine";
import { etParts, etWallToEpoch, sessionDayKey, weekdayOfKey, WEEKDAY_NAMES, median, rnd2 } from "../shared/yellowbox-core";
import type { FiringCandle } from "../shared/firing/types";

// ─────────────────────────── THRESHOLD CONSTANTS ────────────────────────────
// Every tier boundary used below, in one place (mission requirement).
export const RISK_THRESHOLDS = {
  /** comboTier "proven": held-out PF >= this AND adequate n (gate's own judgment
   *  thresholds: n>=20 at @interval scope, n>=15 at all-interval scope) AND not
   *  a carried-forward lowConfidence verdict. */
  COMBO_PROVEN_PF: 1.3,
  /** comboTier "passing": held-out PF in [1.05, 1.3) with adequate n. Below 1.05
   *  with adequate n = "blocked-losing" (only reachable in the ungated baseline —
   *  the gate excludes those combos from the gated set). Absent / thin /
   *  lowConfidence = "unproven-thin". */
  COMBO_PASSING_PF: 1.05,
  COMBO_MIN_N_AT_INTERVAL: 20,
  COMBO_MIN_N_ALL_INTERVAL: 15,
  /** chopState: |FCO| <= this at the fire bar (FRACTAL_CONST.FCO_CHOP_MAX)... */
  CHOP_FCO_MAX: FRACTAL_CONST.FCO_CHOP_MAX, // 0.25
  /** ...OR the fractal chaos bands read flat at the fire bar (chopFCB). */
  /** timeRisk: entry within this many minutes BEFORE the 15:15 ET no-new-signals
   *  cutoff (i.e. entry ET wall-clock in [14:30, 15:15)). */
  TIME_RISK_MIN_BEFORE_1515: 45,
  /** roomQuality tiers on (distance to nearest opposing yellowbox level or
   *  persistent band) / TP1 distance: <1 / 1..2 / >=2. No opposing obstacle at
   *  all counts as the >=2 (clear) tier. Obstacles = the engine's own day-zone
   *  levels (boxTop/boxBottom/initRes/initSup) on the opposing side, plus
   *  persistent bands: a band wholly beyond entry counts at its NEAR edge; a band
   *  the entry sits INSIDE counts at its FAR edge (the edge the trade must exit
   *  through — "inside the current auction band" is not zero room). */
  ROOM_TIER_LOW: 1.0,
  ROOM_TIER_HIGH: 2.0,
  /** rewardRisk = TP1dist/SLdist tiers: <0.7 / 0.7..1.2 / >1.2. */
  RR_LOW: 0.7,
  RR_HIGH: 1.2,
  /** regimeDrift = entry session-day realized range / median session-day range of
   *  the calibration window (WINDOW_START_KEY..present, unfinished day excluded
   *  from the median). Extreme = <0.6 or >1.6. */
  REGIME_LOW: 0.6,
  REGIME_HIGH: 1.6,
  /** Statistical honesty: aggregate cells with n < this are flagged THIN. */
  THIN_CELL_N: 30,
} as const;
const T = RISK_THRESHOLDS;

// Rating (documented in the mission):
//   A = comboTier "proven" AND zero elevated factors
//   C = comboTier "unproven-thin"/"blocked-losing" OR >=3 elevated factors
//   B = everything else (1-2 elevated, or "passing" combo with 0 elevated)
// Elevated factors: chopState; timeRisk; roomTier "<1"; rewardRisk<0.7 while the
// combo is NOT proven/passing (unproven-thin or blocked-losing); regime extreme.

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const ARTIFACTS_DIR = artifactsDir(ROOT); // BAXTER_ARTIFACTS_DIR (2026-08-02)
const RESULTS_JSON = path.join(ARTIFACTS_DIR, "fact-engine-backtest-results.json");
const OUT_JSON = path.join(ARTIFACTS_DIR, "risk-factor-analysis.json");
const BASE_URL = process.env.RFA_BASE_URL ?? "http://127.0.0.1:3000";
const SPOT = process.argv.includes("--spot");
const INTERVAL_SEC: Record<Interval, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };
const WINDOW_START_KEY = "2026-04-15"; // mirrors the harness's reporting window

// ─────────────────────────────── TYPES ──────────────────────────────────────
type Outcome = "tp1" | "tp2" | "sl" | "eod" | "open";
interface TradeLite {
  fireTs: number; entryTs: number; interval: Interval; direction: "Long" | "Short";
  entry: number; tp1: number; sl: number;
  outcome: Outcome; pointsResult: number | null;
  dateET: string; timeET: string; weekday: string; sessionDay: string;
  combo: string; signalType: string;
}
interface ComboRecord {
  comboKey: string;
  /** Which quality-gate granularity supplied the held-out verdict. */
  comboVerdictScope: "interval" | "all" | "none";
  comboTier: "proven" | "passing" | "unproven-thin" | "blocked-losing";
  /** HELD-OUT basis — shared/quality-gate.ts comboClasses (walk-forward verdict). */
  heldOutN: number | null; heldOutWinPct: number | null; heldOutPF: number | null; heldOutExpectancy: number | null;
  /** REALIZED basis — this combo@interval's closed trades inside the SAME dataset
   *  the trade belongs to (realizedBasis says which). */
  realizedN: number; realizedWinPct: number | null; realizedPF: number | null; realizedExpectancy: number | null;
  realizedBasis: "gated-3mo-window" | "ungated-baseline";
}
interface RiskFactors {
  comboStrength: ComboRecord["comboTier"];
  footprintPresent: boolean;
  chopState: boolean | null; fcoAtEntry: number | null; chaosBandsFlat: boolean | null;
  timeRisk: boolean; isTuesday: boolean;
  roomRatio: number | null; roomTier: "<1" | "1-2" | ">=2" | "n/a";
  rewardRisk: number; rrTier: "<0.7" | "0.7-1.2" | ">1.2";
  regimeDrift: number | null; regimeTier: "<0.6" | "0.6-1.6" | ">1.6" | "n/a"; regimePartialDay: boolean;
}
interface AnalyzedTrade extends TradeLite, ComboRecord {
  riskFactors: RiskFactors;
  elevated: string[]; elevatedCount: number;
  rating: "A" | "B" | "C";
}
interface DayZoneLite { boxTop: number; boxBottom: number; initRes: number; initSup: number; bands: Array<{ top: number; bottom: number }> }

// ─────────────────────── harness walkExit mirror (ungated) ──────────────────
// Byte-for-byte the semantics of scripts/fact-engine-backtest.ts walkExit: 1m walk
// from entryTs, SL checked before TP2 before TP1 on each bar, exit AT the level,
// EOD = last 1m close before the 17:00 ET settle once the session has finished.
function lowerBound(a: number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function walkExitMirror(
  entryTs: number, entry: number, isLong: boolean, tp1: number, tp2: number, sl: number,
  c1m: FiringCandle[], t1m: number[], lastDataTs: number, nowSec: number,
): { outcome: Outcome; exitPrice: number | null } {
  const settleTs = etWallToEpoch(sessionDayKey(entryTs), 17, 0);
  let outcome: Outcome = "open"; let exitPrice: number | null = null;
  let lastClose = entry;
  for (let j = lowerBound(t1m, entryTs); j < c1m.length; j++) {
    const b = c1m[j];
    if (b.time >= settleTs) break;
    if (isLong) {
      if (b.low <= sl) { outcome = "sl"; exitPrice = sl; break; }
      if (b.high >= tp2) { outcome = "tp2"; exitPrice = tp2; break; }
      if (b.high >= tp1) { outcome = "tp1"; exitPrice = tp1; break; }
    } else {
      if (b.high >= sl) { outcome = "sl"; exitPrice = sl; break; }
      if (b.low <= tp2) { outcome = "tp2"; exitPrice = tp2; break; }
      if (b.low <= tp1) { outcome = "tp1"; exitPrice = tp1; break; }
    }
    lastClose = b.close;
  }
  if (outcome === "open" && settleTs <= Math.min(lastDataTs, nowSec)) { outcome = "eod"; exitPrice = lastClose; }
  return { outcome, exitPrice };
}

// ───────────────────────────── metrics helper ───────────────────────────────
interface Cell { n: number; closed: number; wins: number; winPct: number | null; expectancy: number | null; pf: number | null; cumPts: number; thin: boolean }
function cellOf(rows: TradeLite[]): Cell {
  const closedRows = rows.filter(r => r.outcome !== "open" && r.pointsResult != null);
  const wins = closedRows.filter(r => r.outcome === "tp1" || r.outcome === "tp2").length;
  const pts = closedRows.map(r => r.pointsResult as number);
  const gw = pts.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const gl = pts.filter(v => v < 0).reduce((a, b) => a + b, 0);
  const cum = pts.reduce((a, b) => a + b, 0);
  const closed = closedRows.length;
  return {
    n: rows.length, closed, wins,
    winPct: closed ? rnd2(100 * wins / closed) : null,
    expectancy: closed ? rnd2(cum / closed) : null,
    pf: gl < 0 ? rnd2(gw / -gl) : (gw > 0 ? 999 : null),
    cumPts: rnd2(cum),
    thin: closed < T.THIN_CELL_N,
  };
}

// ─────────────────────────────── main ───────────────────────────────────────
async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);

  // 1) Standing GATED set (primary) — consumed, never modified.
  const results = JSON.parse(fs.readFileSync(RESULTS_JSON, "utf-8")) as {
    meta: { generatedAt: string; windowFromKey: string; windowToKey: string };
    signals: Array<Record<string, unknown>>;
  };
  const gated: TradeLite[] = results.signals.map(r => ({
    fireTs: r.fireTs as number, entryTs: r.entryTs as number,
    interval: r.interval as Interval, direction: r.direction as "Long" | "Short",
    entry: r.entry as number, tp1: r.tp1 as number, sl: r.sl as number,
    outcome: r.outcome as Outcome, pointsResult: (r.pointsResult ?? null) as number | null,
    dateET: r.dateET as string, timeET: r.timeET as string, weekday: r.weekday as string,
    sessionDay: (r.sessionDay ?? r.dateET) as string,
    combo: (r.combo ?? "") as string, signalType: r.signalType as string,
  }));
  console.log(`[rfa] gated set: ${gated.length} trades from ${RESULTS_JSON} (generated ${results.meta.generatedAt})`);

  // 2) Harness data + UNGATED baseline (PHASE-B construction, provisional exits).
  const L: Loaded = loadData();
  const neutralGate: QualityGateData = {
    generatedAt: "", source: "risk-factor-analysis ungated baseline (provisional exits)",
    rule: { ...QUALITY_GATE.rule }, multiFact: { n: 0, pf: 0, expectancy: 0 },
    classes: {}, exitByClass: {},
  };
  const ungatedByIv = enginePass(L, { gate: false, gateData: neutralGate, label: "UNGATED(rfa)" }, nowSec);
  const ungated: TradeLite[] = [];
  for (const iv of INTERVALS) {
    for (const s of ungatedByIv[iv] as FactSignal[]) {
      const entryTs = s.time + INTERVAL_SEC[iv];
      const isLong = s.direction === "Long";
      const w = walkExitMirror(entryTs, s.price, isLong, s.tp1, s.tp2, s.sl, L.c1m, L.t1m, L.lastDataTs, nowSec);
      const p = etParts(entryTs);
      const pad = (x: number): string => String(x).padStart(2, "0");
      const dateET = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
      ungated.push({
        fireTs: s.time, entryTs, interval: iv, direction: s.direction,
        entry: rnd2(s.price), tp1: rnd2(s.tp1), sl: rnd2(s.sl),
        outcome: w.outcome,
        pointsResult: w.exitPrice == null ? null : rnd2((w.exitPrice - s.price) * (isLong ? 1 : -1)),
        dateET, timeET: `${pad(p.hh)}:${pad(p.mm)}`,
        weekday: WEEKDAY_NAMES[weekdayOfKey(dateET)],
        sessionDay: sessionDayKey(entryTs),
        combo: comboKeyOf(s.facts), signalType: s.signalType,
      });
    }
  }
  ungated.sort((a, b) => a.entryTs - b.entryTs);
  console.log(`[rfa] ungated baseline: ${ungated.length} trades (recomputed, provisional exits)`);

  // 3) Fractal series per interval on the SAME engine-input candle arrays.
  const frByIv = {} as Record<Interval, FractalSeries>;
  const idxByIv = {} as Record<Interval, Map<number, number>>;
  for (const iv of INTERVALS) {
    frByIv[iv] = computeFractalSeries(L.candlesByIv[iv]);
    const m = new Map<number, number>();
    L.candlesByIv[iv].forEach((c, i) => m.set(c.time, i));
    idxByIv[iv] = m;
  }

  // 4) Day-zone obstacles: live endpoint (box/init + persistent bands); fallback ybByKey.
  const zonesByDay = new Map<string, DayZoneLite>();
  let bandsSource = "live /api/yellowbox/day-zones (yellowbox stack + persistent bands)";
  try {
    const fromTs = etWallToEpoch(WINDOW_START_KEY, 0, 0) - 2 * 86400;
    const dz = await (await fetch(`${BASE_URL}/api/yellowbox/day-zones?symbol=MES&fromTs=${fromTs}&toTs=${nowSec + 3600}`)).json() as {
      days: Array<{ dayKeyET: string; boxTop: number; boxBottom: number; initRes: number; initSup: number; bands?: Array<{ top: number; bottom: number }> }>;
    };
    for (const d of dz.days ?? []) {
      zonesByDay.set(d.dayKeyET, {
        boxTop: d.boxTop, boxBottom: d.boxBottom, initRes: d.initRes, initSup: d.initSup,
        bands: (d.bands ?? []).map(b => ({ top: b.top, bottom: b.bottom })),
      });
    }
    console.log(`[rfa] day-zones from live server: ${zonesByDay.size} days (with persistent bands)`);
  } catch {
    bandsSource = "FALLBACK harness ybByKey (box/init levels only — NO persistent bands; server unreachable)";
    for (const [k, r] of L.ybByKey) {
      zonesByDay.set(k, { boxTop: r.box_top, boxBottom: r.box_bottom, initRes: r.init_res, initSup: r.init_sup, bands: [] });
    }
    console.warn(`[rfa] WARNING: ${bandsSource}`);
  }

  // 5) Daily ranges for regimeDrift (full Globex session day, DayAgg h-l).
  const rangeByDay = new Map<string, number>();
  for (const d of L.days) rangeByDay.set(d.key, d.h - d.l);
  const lastKey = L.days[L.days.length - 1]?.key ?? "";
  const lastUnfinished = lastKey !== "" && etWallToEpoch(lastKey, 17, 0) > nowSec;
  const windowRanges = L.days
    .filter(d => d.key >= WINDOW_START_KEY && !(lastUnfinished && d.key === lastKey))
    .map(d => d.h - d.l);
  const medianRange = median(windowRanges);
  console.log(`[rfa] regime baseline: median session-day range ${medianRange.toFixed(2)} over ${windowRanges.length} window days${lastUnfinished ? ` (unfinished ${lastKey} excluded from the median)` : ""}`);

  // 6) Realized per-combo stats within each dataset (combo@interval, closed trades).
  const realizedOf = (rows: TradeLite[]): Map<string, Cell> => {
    const by = new Map<string, TradeLite[]>();
    for (const r of rows) {
      const k = `${r.combo}@${r.interval}`;
      let a = by.get(k); if (!a) { a = []; by.set(k, a); }
      a.push(r);
    }
    return new Map([...by.entries()].map(([k, v]) => [k, cellOf(v)]));
  };
  const realizedGated = realizedOf(gated);
  const realizedUngated = realizedOf(ungated);

  // 7) Per-trade analysis.
  const comboRecordOf = (combo: string, iv: Interval, basis: "gated-3mo-window" | "ungated-baseline"): ComboRecord => {
    const cc = QUALITY_GATE.comboClasses ?? {};
    const atIv: GateClassStat | undefined = cc[`${combo}@${iv}`];
    const all: GateClassStat | undefined = cc[combo];
    const entry = atIv ?? all;
    const scope: ComboRecord["comboVerdictScope"] = atIv ? "interval" : all ? "all" : "none";
    const minN = scope === "interval" ? T.COMBO_MIN_N_AT_INTERVAL : T.COMBO_MIN_N_ALL_INTERVAL;
    let tier: ComboRecord["comboTier"];
    if (!entry || entry.lowConfidence || entry.n < minN) tier = "unproven-thin";
    else if (entry.pf >= T.COMBO_PROVEN_PF) tier = "proven";
    else if (entry.pf >= T.COMBO_PASSING_PF) tier = "passing";
    else tier = "blocked-losing";
    const realized = (basis === "gated-3mo-window" ? realizedGated : realizedUngated).get(`${combo}@${iv}`);
    return {
      comboKey: combo, comboVerdictScope: scope, comboTier: tier,
      heldOutN: entry ? entry.n : null,
      heldOutWinPct: entry ? rnd2(100 * entry.winRate) : null,
      heldOutPF: entry ? entry.pf : null,
      heldOutExpectancy: entry ? entry.expectancy : null,
      realizedN: realized?.closed ?? 0,
      realizedWinPct: realized?.winPct ?? null,
      realizedPF: realized?.pf ?? null,
      realizedExpectancy: realized?.expectancy ?? null,
      realizedBasis: basis,
    };
  };

  const analyze = (r: TradeLite, basis: "gated-3mo-window" | "ungated-baseline"): AnalyzedTrade => {
    const rec = comboRecordOf(r.combo, r.interval, basis);
    // chopState at the FIRE bar on the primary-interval engine candles.
    const i = idxByIv[r.interval].get(r.fireTs);
    const fr = frByIv[r.interval];
    const fco = i != null && Number.isFinite(fr.fco[i]) ? rnd2(fr.fco[i]) : null;
    const flat = i != null ? fr.chopFCB[i] : null;
    const chop = i == null ? null : ((fco != null && Math.abs(fco) <= T.CHOP_FCO_MAX) || flat === true);
    // timeRisk: entry ET wall clock within 45 min BEFORE 15:15.
    const p = etParts(r.entryTs);
    const etMins = p.hh * 60 + p.mm;
    const timeRisk = etMins >= (15 * 60 + 15) - T.TIME_RISK_MIN_BEFORE_1515 && etMins < 15 * 60 + 15;
    const isTuesday = r.weekday === "TUE";
    // roomQuality: nearest OPPOSING yellowbox level / persistent band vs TP1 distance.
    const z = zonesByDay.get(r.sessionDay);
    const tp1Dist = Math.abs(r.tp1 - r.entry);
    let roomRatio: number | null = null;
    let roomTier: RiskFactors["roomTier"] = "n/a";
    if (z && tp1Dist > 0) {
      const dists: number[] = [];
      const levels = [z.boxTop, z.boxBottom, z.initRes, z.initSup];
      if (r.direction === "Long") {
        for (const lv of levels) if (lv > r.entry) dists.push(lv - r.entry);
        for (const b of z.bands) {
          if (b.bottom > r.entry) dists.push(b.bottom - r.entry);        // band ahead: near edge
          else if (b.top > r.entry) dists.push(b.top - r.entry);         // inside: far edge
        }
      } else {
        for (const lv of levels) if (lv < r.entry) dists.push(r.entry - lv);
        for (const b of z.bands) {
          if (b.top < r.entry) dists.push(r.entry - b.top);              // band ahead: near edge
          else if (b.bottom < r.entry) dists.push(r.entry - b.bottom);   // inside: far edge
        }
      }
      if (dists.length) {
        roomRatio = rnd2(Math.min(...dists) / tp1Dist);
        roomTier = roomRatio < T.ROOM_TIER_LOW ? "<1" : roomRatio < T.ROOM_TIER_HIGH ? "1-2" : ">=2";
      } else { roomRatio = null; roomTier = ">=2"; } // no opposing obstacle = clear
    }
    // rewardRisk from the row's ACTUAL exits.
    const slDist = Math.abs(r.entry - r.sl);
    const rr = rnd2(tp1Dist / Math.max(slDist, 1e-9));
    const rrTier: RiskFactors["rrTier"] = rr < T.RR_LOW ? "<0.7" : rr <= T.RR_HIGH ? "0.7-1.2" : ">1.2";
    // regimeDrift.
    const dayRange = rangeByDay.get(r.sessionDay);
    const regimePartialDay = lastUnfinished && r.sessionDay === lastKey;
    const drift = dayRange != null && medianRange > 0 ? rnd2(dayRange / medianRange) : null;
    const regimeTier: RiskFactors["regimeTier"] = drift == null ? "n/a"
      : drift < T.REGIME_LOW ? "<0.6" : drift <= T.REGIME_HIGH ? "0.6-1.6" : ">1.6";

    const rf: RiskFactors = {
      comboStrength: rec.comboTier, footprintPresent: r.combo.split("+").includes("FP"),
      chopState: chop, fcoAtEntry: fco, chaosBandsFlat: flat,
      timeRisk, isTuesday,
      roomRatio, roomTier, rewardRisk: rr, rrTier,
      regimeDrift: drift, regimeTier, regimePartialDay,
    };
    const elevated: string[] = [];
    if (rf.chopState === true) elevated.push("chop");
    if (rf.timeRisk) elevated.push("timeRisk");
    if (rf.roomTier === "<1") elevated.push("roomQuality<1");
    if (rf.rrTier === "<0.7" && (rec.comboTier === "unproven-thin" || rec.comboTier === "blocked-losing")) elevated.push("rewardRisk<0.7@unproven");
    if (rf.regimeTier === "<0.6" || rf.regimeTier === ">1.6") elevated.push("regimeExtreme");
    const rating: AnalyzedTrade["rating"] =
      (rec.comboTier === "unproven-thin" || rec.comboTier === "blocked-losing" || elevated.length >= 3) ? "C"
        : (rec.comboTier === "proven" && elevated.length === 0) ? "A" : "B";
    return { ...r, ...rec, riskFactors: rf, elevated, elevatedCount: elevated.length, rating };
  };

  const gatedA = gated.map(r => analyze(r, "gated-3mo-window"));
  const ungatedA = ungated.map(r => analyze(r, "ungated-baseline"));

  // 8) Aggregate tables.
  const fmt = (c: Cell): string =>
    `n=${String(c.closed).padStart(4)}  win%=${c.winPct == null ? "  n/a" : c.winPct.toFixed(1).padStart(5)}  exp=${c.expectancy == null ? "  n/a" : c.expectancy.toFixed(2).padStart(6)}  PF=${c.pf == null ? " n/a" : c.pf.toFixed(2).padStart(5)}  cum=${c.cumPts.toFixed(1).padStart(8)}${c.thin ? "  [THIN n<30]" : ""}`;
  const table = (title: string, rows: AnalyzedTrade[], states: Array<[string, (t: AnalyzedTrade) => boolean]>): Record<string, Cell> => {
    console.log(`\n  ── ${title} ──`);
    const out: Record<string, Cell> = {};
    for (const [name, pred] of states) {
      const c = cellOf(rows.filter(pred));
      out[name] = c;
      console.log(`    ${name.padEnd(24)} ${fmt(c)}`);
    }
    return out;
  };
  const aggOf = (label: string, rows: AnalyzedTrade[]): Record<string, Record<string, Cell>> => {
    console.log(`\n═══ ${label} (${rows.length} trades) ═══`);
    const agg: Record<string, Record<string, Cell>> = {};
    agg.comboStrength = table("1. comboStrength (held-out tier)", rows, [
      ["proven (PF>=1.3)", t => t.comboTier === "proven"],
      ["passing (1.05-1.3)", t => t.comboTier === "passing"],
      ["unproven-thin", t => t.comboTier === "unproven-thin"],
      ["blocked-losing (<1.05)", t => t.comboTier === "blocked-losing"],
    ]);
    agg.footprint = table("2. footprintPresent", rows, [
      ["FP present", t => t.riskFactors.footprintPresent],
      ["FP absent", t => !t.riskFactors.footprintPresent],
    ]);
    agg.chop = table("3. chopState at entry", rows, [
      ["chop (|FCO|<=0.25 or flat)", t => t.riskFactors.chopState === true],
      ["clear", t => t.riskFactors.chopState === false],
      ["n/a (bar not found)", t => t.riskFactors.chopState === null],
    ]);
    agg.timeRisk = table("4a. timeRisk (entry 14:30-15:15 ET)", rows, [
      ["within 45min of 15:15", t => t.riskFactors.timeRisk],
      ["earlier", t => !t.riskFactors.timeRisk],
    ]);
    agg.weekday = table("4b. weekday", rows, [
      ["MON", t => t.weekday === "MON"], ["TUE", t => t.weekday === "TUE"],
      ["WED", t => t.weekday === "WED"], ["THU", t => t.weekday === "THU"],
      ["FRI", t => t.weekday === "FRI"],
      ["Tuesday vs rest: TUE", t => t.riskFactors.isTuesday],
      ["Tuesday vs rest: rest", t => !t.riskFactors.isTuesday],
    ]);
    agg.room = table("5. roomQuality (obstacle dist / TP1 dist)", rows, [
      ["<1 (obstacle before TP1)", t => t.riskFactors.roomTier === "<1"],
      ["1-2", t => t.riskFactors.roomTier === "1-2"],
      [">=2 or clear", t => t.riskFactors.roomTier === ">=2"],
      ["n/a (no day zone)", t => t.riskFactors.roomTier === "n/a"],
    ]);
    agg.rewardRisk = table("6. rewardRisk (TP1/SL)", rows, [
      ["<0.7", t => t.riskFactors.rrTier === "<0.7"],
      ["0.7-1.2", t => t.riskFactors.rrTier === "0.7-1.2"],
      [">1.2", t => t.riskFactors.rrTier === ">1.2"],
    ]);
    agg.regime = table("7. regimeDrift (day range / median)", rows, [
      ["<0.6 (dead tape)", t => t.riskFactors.regimeTier === "<0.6"],
      ["0.6-1.6 (normal)", t => t.riskFactors.regimeTier === "0.6-1.6"],
      [">1.6 (wild tape)", t => t.riskFactors.regimeTier === ">1.6"],
      ["n/a", t => t.riskFactors.regimeTier === "n/a"],
    ]);
    agg.rating = table("RATING", rows, [
      ["A", t => t.rating === "A"], ["B", t => t.rating === "B"], ["C", t => t.rating === "C"],
    ]);
    return agg;
  };
  const aggGated = aggOf("GATED 3-MONTH SET (primary — the standing 724)", gatedA);
  const aggUngated = aggOf("UNGATED BASELINE (statistical power only — NOT tradeable; provisional exits)", ungatedA);

  // 9) Counterfactuals on the GATED set.
  const actual = cellOf(gatedA);
  const onlyA = cellOf(gatedA.filter(t => t.rating === "A"));
  const aPlusB = cellOf(gatedA.filter(t => t.rating !== "C"));
  console.log(`\n═══ COUNTERFACTUALS (gated set) ═══`);
  console.log(`  ACTUAL (all gated):   ${fmt(actual)}`);
  console.log(`  ONLY A:               ${fmt(onlyA)}`);
  console.log(`  A + B:                ${fmt(aPlusB)}`);

  // 10) Top-10 most-traded combos (gated set): held-out vs realized side by side.
  const comboCount = new Map<string, AnalyzedTrade[]>();
  for (const t of gatedA) {
    const k = `${t.comboKey}@${t.interval}`;
    let a = comboCount.get(k); if (!a) { a = []; comboCount.set(k, a); }
    a.push(t);
  }
  const top10 = [...comboCount.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  console.log(`\n═══ TOP-10 MOST-TRADED COMBOS (gated set) — held-out verdict vs realized window ═══`);
  console.log(`  ${"combo@iv".padEnd(20)} ${"tier".padEnd(14)} ${"heldOut n/win%/PF/exp".padEnd(26)} realized n/win%/PF/exp`);
  const top10Json: Array<Record<string, unknown>> = [];
  for (const [k, list] of top10) {
    const t = list[0];
    const ho = t.heldOutN == null ? "(no verdict)" : `${t.heldOutN}/${t.heldOutWinPct}%/${t.heldOutPF}/${t.heldOutExpectancy}`;
    const re = `${t.realizedN}/${t.realizedWinPct}%/${t.realizedPF}/${t.realizedExpectancy}`;
    const tinyPerfect = (t.realizedWinPct === 100 || t.heldOutWinPct === 100) && Math.min(t.realizedN, t.heldOutN ?? Infinity) < 20;
    console.log(`  ${k.padEnd(20)} ${t.comboTier.padEnd(14)} ${ho.padEnd(26)} ${re}${tinyPerfect ? "   <-- 100% on tiny n: PROMISING, UNPROVEN" : ""}`);
    top10Json.push({
      comboAtInterval: k, tier: t.comboTier,
      heldOut: { n: t.heldOutN, winPct: t.heldOutWinPct, pf: t.heldOutPF, expectancy: t.heldOutExpectancy },
      realized: { n: t.realizedN, winPct: t.realizedWinPct, pf: t.realizedPF, expectancy: t.realizedExpectancy },
      flag: tinyPerfect ? "promising-unproven (100% on tiny n)" : undefined,
    });
  }

  // 11) Spot-check: 5 trades with every raw factor input, for hand verification.
  if (SPOT) {
    const picks = [0, Math.floor(gatedA.length * 0.2), Math.floor(gatedA.length * 0.5), Math.floor(gatedA.length * 0.75), gatedA.length - 1]
      .map(i => gatedA[i]);
    console.log(`\n═══ SPOT-CHECK (5 gated trades — raw inputs) ═══`);
    for (const t of picks) {
      const z = zonesByDay.get(t.sessionDay);
      const i = idxByIv[t.interval].get(t.fireTs);
      console.log(`  ${t.dateET} ${t.timeET} ET  ${t.interval} ${t.direction}  combo=${t.comboKey}  entry=${t.entry} tp1=${t.tp1} sl=${t.sl} outcome=${t.outcome} pts=${t.pointsResult}`);
      console.log(`    combo: scope=${t.comboVerdictScope} tier=${t.comboTier} heldOut n/win/PF/exp=${t.heldOutN}/${t.heldOutWinPct}/${t.heldOutPF}/${t.heldOutExpectancy} realized=${t.realizedN}/${t.realizedWinPct}/${t.realizedPF}/${t.realizedExpectancy}`);
      console.log(`    chop: barIdx=${i} fco=${t.riskFactors.fcoAtEntry} bandsFlat=${t.riskFactors.chaosBandsFlat} -> chop=${t.riskFactors.chopState}`);
      console.log(`    time: entry ET=${t.timeET} timeRisk=${t.riskFactors.timeRisk} weekday=${t.weekday}`);
      console.log(`    room: zones=${z ? `top=${z.boxTop} bot=${z.boxBottom} iR=${z.initRes} iS=${z.initSup} bands=${z.bands.map(b => `[${b.bottom},${b.top}]`).join("")}` : "(none)"} tp1Dist=${rnd2(Math.abs(t.tp1 - t.entry))} -> ratio=${t.riskFactors.roomRatio} tier=${t.riskFactors.roomTier}`);
      console.log(`    rr: tp1Dist=${rnd2(Math.abs(t.tp1 - t.entry))} slDist=${rnd2(Math.abs(t.entry - t.sl))} -> ${t.riskFactors.rewardRisk} (${t.riskFactors.rrTier})`);
      console.log(`    regime: dayRange=${rangeByDay.get(t.sessionDay)?.toFixed(2)} median=${medianRange.toFixed(2)} -> ${t.riskFactors.regimeDrift} (${t.riskFactors.regimeTier})${t.riskFactors.regimePartialDay ? " PARTIAL DAY" : ""}`);
      console.log(`    elevated=[${t.elevated.join(",")}] -> rating=${t.rating}`);
    }
  }

  // 12) Emit the analysis JSON (separate file — standing results untouched).
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      source: "scripts/risk-factor-analysis.ts (post-hoc, analysis-only)",
      gatedSource: { file: "fact-engine-backtest-results.json", generatedAt: results.meta.generatedAt, trades: gatedA.length },
      ungatedBaseline: {
        note: "recomputed via harness loadData/enginePass, gate OFF, provisional exits — statistical power only, NOT a tradeable set",
        trades: ungatedA.length,
      },
      window: { from: results.meta.windowFromKey, to: results.meta.windowToKey },
      bandsSource,
      regimeBaseline: { medianSessionDayRange: rnd2(medianRange), nDays: windowRanges.length },
      thresholds: RISK_THRESHOLDS,
      ratingRule: "A = proven combo AND 0 elevated; C = unproven-thin/blocked-losing combo OR >=3 elevated; B = else. Elevated: chop, timeRisk, roomTier<1, rewardRisk<0.7 while combo not proven/passing, regime extreme.",
    },
    aggregates: {
      gated: aggGated, ungated: aggUngated,
      counterfactuals: { actual, onlyA, aPlusB },
      top10Combos: top10Json,
    },
    trades: { gated: gatedA, ungated: ungatedA },
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1));
  console.log(`\n[rfa] wrote ${OUT_JSON} (${(fs.statSync(OUT_JSON).size / 1e6).toFixed(1)} MB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
