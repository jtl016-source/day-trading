/**
 * fact-engine-backtest.ts — 3-MONTH-WINDOW walk-forward backtest + DATA-DRIVEN QUALITY GATE +
 * MONTE-CARLO EXIT CALIBRATION + the quality-over-quantity Excel workbook (exceljs, pure JS).
 *
 * REPORTING WINDOW (user directive 2026-07-15, standing): backtests cover ONLY the LAST THREE
 * MONTHS of trades (WINDOW_START_KEY → today) — NOT full history. Lookback data BEFORE the
 * window is still loaded (50-day yellowbox derivation, vector warmup, ICT/fractal context),
 * but only trades ENTERED within the window count and report. Gate verdicts resting on n < 50
 * window trades are NOT judged on the thin sample: they CARRY FORWARD the previous
 * full-history verdict, flagged lowConfidence (statistical honesty over recency).
 *
 * ICT + FRACTAL CONFIRMATIONS (2026-07-15): the engine now enumerates corroborator-only facts
 * (ICT sweep/OB/breaker/FVG reactions; fractal breakout/band/FCO; chop-contradiction). This
 * harness feeds the engine EXACTLY like the live adapter (ictEnabled/fractalEnabled default
 * ON; levels derived inside the engine) and additionally runs:
 *   • a BEFORE pass — the OLD engine config (previous checked-in gate + exits, corroborators
 *     OFF) over the SAME window, for an apples-to-apples before/after comparison;
 *   • a CHOP-DIAGNOSTIC pass — final config with CHOP_CONTRADICTS:false — to count exactly
 *     how many signals the chop-contradiction rule suppressed.
 *
 * Usage:
 *   npx tsx scripts/fact-engine-backtest.ts [--symbol MES] [--skip-xlsx] [--xlsx-only] [--charts-only]
 *   (--charts-only: render per-trade PNGs + rebuild the workbook from the EXISTING results
 *    JSON — the trade set stays frozen; no engine re-run against the ever-growing live DB.)
 *
 * ── WHAT ONE RUN DOES (user directive 2026-07-14: "Quality over quantity — I don't need a
 *    million trades, I need trades that will win") ───────────────────────────────────────
 *  PHASE A  Load candles/footprint/yellowbox day-zones (identical serving-path filters).
 *  PHASE B  UNGATED engine pass per interval (qualityGateEnabled:false) → per-class stats
 *           (class = signalType × interval). Gate rule: PF >= 1.05 AND expectancy > 0.1 pts.
 *  PHASE C  GATED engine pass (in-memory gate, provisional 10/5 exits) → the quality-gated
 *           signal set + full-horizon MAE/MFE excursion profiles on 1m bars.
 *  PHASE D  MONTE-CARLO EXIT CALIBRATION per class: SL = p85 MAE of TP1-winners (user rule;
 *           winners' heat measured up to the FIRST TP1 touch — first touch locks the record);
 *           TP1 = grid search 4..30 pts maximizing expectancy against that SL under the
 *           CANONICAL payoff (2026-07-31: the sim models the win_tp1→win_tp2 upgrade watch —
 *           TP2 reached with no SL between pays 2×TP1; SL after TP1 locks +TP1); TP2 = 2×TP1
 *           (user rule). Pooling: own class if n>=100, else all gated same-interval signals
 *           if >=100, else own class if n>=30 (cross-interval pooling mixes excursion scales
 *           — documented judgment call), else all gated signals. Bootstrap (1,000 resamples)
 *           → 95% CI on the chosen exits' expectancy.
 *  PHASE E  Regenerate shared/quality-gate.ts (gate stats + calibrated exits, checked in —
 *           this is what the LIVE engine consults; runFactEngine/evaluateFormingBar read it).
 *  PHASE F  FINAL gated pass WITH calibrated exits → the workbook trade set (resolved on 1m).
 *  PHASE G  SOLO strategy backtests (analysis-only, NOT gated, NOT live): Vector side-entries
 *           alone (all sessions, per interval), Yellow Box box-breaks alone (5m RTH
 *           transitions), Footprint imbalance-zone touches alone (5m RTH, its coverage
 *           window), Milk Zone (structural zero — no uploaded-zone history).
 *  PHASE H  Monte-Carlo PNG charts (pure-JS raster, scripts/png-canvas.ts): per interval, a
 *           30-day overview (60m context candles + every gated signal) over a recent-bars
 *           detail panel with each signal's excursion envelope (TP band + p85-MAE allowance).
 *  PHASE I  The workbook (fact-engine-backtest.xlsx) — sheet order dictated by the user:
 *           README, All Trades, 1m, 5m, 15m, 60m, per-strategy sheets, solo sheets, Monte
 *           Carlo (methodology + calibration + percentiles + embedded PNGs + signal detail).
 *
 * NO INTERNAL JARGON in anything the user reads: signalType/outcome/strategy identifiers are
 * routed through shared/signal-display.ts (the same map the UI uses). Internal strings stay
 * unchanged in the DB/JSON/CSV.
 *
 * Fidelity: the decision model is shared/fact-engine.ts runFactEngine — the SAME module the
 * live chart calls, including the gate + per-class exits (live default ON). One continuous
 * engine pass per interval preserves cooldown/HOD-LOD state exactly like live.
 * Outcomes re-resolved on 1m bars via the CANONICAL resolver (shared/outcome-resolver.ts,
 * 2026-07-31): first touch decides permanently; tp1 → tp2 upgrade ONLY with no SL touch in
 * between; SL-first same-1m-bar ties; force-close at the 17:00 ET settle; gap-throughs fill
 * AT the level.
 */

import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runFactEngine, vectorStateAt, INTERVAL_SEC, FACT_ENGINE_DEFAULTS, EXIT_CALIBRATION,
  DAILY_LOSS_STOP_DEFAULT_PTS, DEAD_TAPE_SUPPRESS_MULT, maxConsecLossRun,
  type Interval, type FactSignal, type FpImbalanceZone, type FactEngineSettings,
} from "../shared/fact-engine";
import { artifactsDir } from "../shared/artifacts-dir"; // BAXTER_ARTIFACTS_DIR (2026-08-02)
import { QUALITY_GATE, classKey, comboKeyOf, type QualityGateData, type GateClassStat, type ClassExit, type GateBar } from "../shared/quality-gate";
import {
  displaySignalType, displayStrategyCombo, displayOutcome, SIGNAL_TYPE_GLOSSARY,
} from "../shared/signal-display";
import { computeVectorLine } from "../shared/firing/vector";
import { isRTH, isMarketBreak, isAfter315ET } from "../shared/firing/session";
import { validateSignalRow } from "../shared/signal-rules";
import { walkOutcomeCanonical } from "../shared/outcome-resolver";
import {
  buildBaseCandles, normalizeServed15m, deriveEngineSlices, type LiveCandle,
} from "../shared/live-adapter";
import { medianSessionDayRangeFromDb } from "../shared/day-range-median"; // RISK DISPLAY: dead-tape baseline (shared with the server)
import type { FiringCandle, VectorPoint } from "../shared/firing/types";
import {
  etParts, etWallToEpoch, sessionDayKey, priorCalendarDay, weekdayOfKey, WEEKDAY_NAMES,
  buildSessionDays, computeCoreZones, rnd2, YB_CACHE_VER, type Bar, type DayAgg,
} from "../shared/yellowbox-core";
import { Raster, encodePNG, textWidth, type RGB } from "./png-canvas";

// ============================= CLI =============================

let SYMBOL = "MES";
let SKIP_XLSX = false;
let XLSX_ONLY = false;
let CHARTS_ONLY = false; // render per-trade PNGs for the EXISTING results JSON (frozen trade set) + rebuild the workbook
let PERSIST = false;     // write the FINAL gated trade set into signal_history via the live guarded upsert path
/** WINDOW MODE (2026-07-29, missed-window backfill runbook): --window-from [--window-to] accept
 *  "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" ET WALL time and run ONLY the final pass over that window
 *  under the SHIPPED quality-gate.ts (gate verdicts + calibrated exits exactly as live) — the
 *  BEFORE/UNGATED passes, gate re-derivation, MC recalibration and the gate-file write are all
 *  skipped (a small window would produce garbage verdicts; the standing 3-month run owns those).
 *  Outputs land in *.window.json/csv so the standing deliverables are never clobbered; xlsx and
 *  per-trade charts are skipped. --persist still works and wipes/repopulates ONLY rows >= the
 *  window start. The standing 3-month default (WINDOW_START_KEY) is untouched. */
let WINDOW_FROM_OVR: string | null = null;
let WINDOW_TO_OVR: string | null = null;
/** SHADOW-RULE REPLAY FLAGS (2026-10-01, docs/signal-analysis-2026-10-01.md R1–R4 + Set B cap):
 *  engine settings layered onto EVERY engine pass of this run (all OFF unless a flag is given —
 *  no flag = byte-identical run). WINDOW MODE ONLY and never with --persist: a standing run
 *  regenerates shared/quality-gate.ts, and a shadow replay must never become the book. Outputs
 *  get a ".shadow-rules" suffix so neither the standing nor the plain window deliverables are
 *  clobbered.
 *    --require-box-side                 REQUIRE_BOX_SIDE = true
 *    --min-session-range-frac <x>       MIN_SESSION_RANGE_FRAC = x   (e.g. 0.25)
 *    --max-session-range-frac <x>       MAX_SESSION_RANGE_FRAC = x   (e.g. 1.0)
 *    --block-tight-room <iv,iv>         BLOCK_TIGHT_ROOM_INTERVALS   (e.g. 5m,15m)
 *    --min-tp1-by-interval <iv=x,...>   MIN_TP1_PTS_BY_INTERVAL      (e.g. 1m=12.25) */
const HARNESS_SHADOW_SETTINGS: Partial<FactEngineSettings> = {};
/** --strict-readonly (2026-10-01): open data/app.db with readonly:true ONLY — no read-write
 *  fallback (the fallback issues no writes, but a sandbox replay beside the armed live server
 *  must not even open a write handle). Implied by any shadow-rule flag. */
let STRICT_READONLY = false;
{
  const argv = process.argv.slice(2);
  const IVS = ["1m", "5m", "15m", "60m"];
  const num = (flag: string, raw: string | undefined): number => {
    const x = Number(raw);
    if (raw == null || !Number.isFinite(x) || x < 0) { console.error(`[fe-bt] ${flag} needs a non-negative number (got ${raw})`); process.exit(2); }
    return x;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--strict-readonly") STRICT_READONLY = true;
    else if (argv[i] === "--require-box-side") HARNESS_SHADOW_SETTINGS.REQUIRE_BOX_SIDE = true;
    else if (argv[i] === "--min-session-range-frac") HARNESS_SHADOW_SETTINGS.MIN_SESSION_RANGE_FRAC = num(argv[i], argv[++i]);
    else if (argv[i] === "--max-session-range-frac") HARNESS_SHADOW_SETTINGS.MAX_SESSION_RANGE_FRAC = num(argv[i], argv[++i]);
    else if (argv[i] === "--block-tight-room") {
      const list = String(argv[++i] ?? "").split(",").map(x => x.trim()).filter(Boolean);
      if (!list.length || list.some(x => !IVS.includes(x))) { console.error(`[fe-bt] --block-tight-room needs intervals from ${IVS.join(",")}`); process.exit(2); }
      HARNESS_SHADOW_SETTINGS.BLOCK_TIGHT_ROOM_INTERVALS = list as Interval[];
    } else if (argv[i] === "--min-tp1-by-interval") {
      const m: Partial<Record<Interval, number>> = {};
      for (const part of String(argv[++i] ?? "").split(",").map(x => x.trim()).filter(Boolean)) {
        const [iv, v] = part.split("=");
        if (!IVS.includes(iv)) { console.error(`[fe-bt] --min-tp1-by-interval: unknown interval '${iv}'`); process.exit(2); }
        m[iv as Interval] = num("--min-tp1-by-interval", v);
      }
      if (!Object.keys(m).length) { console.error(`[fe-bt] --min-tp1-by-interval needs iv=pts pairs (e.g. 1m=12.25)`); process.exit(2); }
      HARNESS_SHADOW_SETTINGS.MIN_TP1_PTS_BY_INTERVAL = m;
    }
  }
}
const SHADOW_RULES_ON = Object.keys(HARNESS_SHADOW_SETTINGS).length > 0;
if (SHADOW_RULES_ON) STRICT_READONLY = true;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--symbol") SYMBOL = argv[++i] ?? "MES";
    else if (argv[i] === "--skip-xlsx") SKIP_XLSX = true;
    else if (argv[i] === "--xlsx-only") XLSX_ONLY = true;
    else if (argv[i] === "--charts-only") CHARTS_ONLY = true;
    else if (argv[i] === "--persist") PERSIST = true;
    else if (argv[i] === "--window-from") WINDOW_FROM_OVR = argv[++i] ?? null;
    else if (argv[i] === "--window-to") WINDOW_TO_OVR = argv[++i] ?? null;
  }
}

const t0 = Date.now();
const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
// BAXTER_ARTIFACTS_DIR (2026-08-02, user-approved OUTPUT_DIR support): ALL artifact outputs
// (results JSON/CSV, workbook, trade-chart PNGs) resolve here; default = repo root exactly as
// before. The workbook's CHART hyperlinks are RELATIVE (trade-charts\...), so the xlsx and the
// trade-charts folder both resolving through ARTIFACTS_DIR keeps the links coherent wherever
// the dir points. The GENERATED GATE FILE is source code, NOT an artifact — it stays in shared/.
const ARTIFACTS_DIR = artifactsDir(ROOT);
if (ARTIFACTS_DIR !== ROOT) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
// Window mode writes suffixed outputs — the standing 3-month deliverables stay untouched.
const WIN_SUFFIX = (WINDOW_FROM_OVR ? ".window" : "") + (SHADOW_RULES_ON ? ".shadow-rules" : "");
if (SHADOW_RULES_ON) {
  if (!WINDOW_FROM_OVR || PERSIST || XLSX_ONLY || CHARTS_ONLY) {
    console.error("[fe-bt] shadow-rule flags need --window-from (a standing run rewrites shared/quality-gate.ts) and cannot be combined with --persist / --xlsx-only / --charts-only");
    process.exit(2);
  }
  console.log(`[fe-bt] SHADOW-RULE REPLAY: settings ${JSON.stringify(HARNESS_SHADOW_SETTINGS)} on every engine pass; outputs *${WIN_SUFFIX}.*`);
}
const OUT_JSON = path.join(ARTIFACTS_DIR, `fact-engine-backtest-results${WIN_SUFFIX}.json`);
const OUT_CSV = path.join(ARTIFACTS_DIR, `fact-engine-backtest-signals${WIN_SUFFIX}.csv`);
const OUT_XLSX = path.join(ARTIFACTS_DIR, "fact-engine-backtest.xlsx");
const GATE_FILE = path.join(ROOT, "shared", "quality-gate.ts");
const INTERVALS: Interval[] = ["1m", "5m", "15m", "60m"];
const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

/** PER-INTERVAL GATE BARS — USER-CHOSEN 2026-07-31 from the PER-INTERVAL gate-bar menu
 *  (scripts/gate-bar-menu-by-interval.ts → gate-bar-menu-by-interval.json): each interval's
 *  measured sweet spot replaces the single global 1.5/3 bar (itself user-chosen from the
 *  first menu earlier the same day; the original 1.05/0.1 had been tuned in the TP1-only
 *  accounting world and stopped selecting anything under canonical outcome semantics).
 *  A class/combo may fire only if its HELD-OUT half clears ITS OWN interval's bar;
 *  all-interval fallback COMBO verdicts are evaluated per CONSULTING interval
 *  (GateClassStat.allowedByInterval — comboGateAllows consults it first). Carried/THIN
 *  semantics unchanged: thin never flips; carried verdicts keep their carried allowed state
 *  at every bar. MIN_FACTS_OVERRIDE unchanged and global (>=3 counted facts fire on any
 *  interval, still subject to combo verdicts). */
const GATE_RULE: { perInterval: Record<Interval, GateBar>; MIN_FACTS_OVERRIDE: number } = {
  perInterval: {
    "1m":  { MIN_PF: 2.0,  MIN_EXPECTANCY_PTS: 5 },
    "5m":  { MIN_PF: 1.75, MIN_EXPECTANCY_PTS: 4 },
    "15m": { MIN_PF: 1.75, MIN_EXPECTANCY_PTS: 4 },
    "60m": { MIN_PF: 1.5,  MIN_EXPECTANCY_PTS: 3 },
  },
  MIN_FACTS_OVERRIDE: 3,
};
/** The gate bar governing one interval (classes + combo@interval verdicts are judged at the
 *  bar of THEIR OWN interval; fallback combos at the CONSULTING interval's). */
const gateBarOf = (iv: string): GateBar => GATE_RULE.perInterval[iv as Interval];
const gateBarTxt = (iv: string): string => {
  const b = gateBarOf(iv);
  return `PF>=${b.MIN_PF} & EXP>${b.MIN_EXPECTANCY_PTS}`;
};
const TICK = 0.25;
const toTick = (v: number): number => Math.round(v / TICK) * TICK;

/** FRICTION MODEL (2026-08-02, user-approved — REPORTING-ONLY). Named constants, to be
 *  settings-exposed later:
 *    pointsPerRoundTrip 0.5 = one tick (0.25) of slippage/spread allowance on EACH side of the
 *      round trip (entry + exit) — fills in the record are AT the level, so this prices the
 *      spread/queue reality the record ignores;
 *    commissionPerSideUsd 1.24 = typical all-in MES commission+fees per side;
 *    mesPointValueUsd 5 = MES $ per index point.
 *  Per-trade friction in POINTS = 0.5 + (2 × 1.24) / 5 = 0.996 pts per closed round trip.
 *  EVERY harness-reported stat now shows NET-of-friction alongside gross (headline,
 *  per-interval, per-class tables, workbook stat rows, gate-bar menus). THE GATE ITSELF STILL
 *  JUDGES GROSS POINTS — changing the verdict basis silently is out of scope (documented in
 *  the gate file header + workbook README); the FRICTION AUDIT table printed at derivation
 *  time shows which allowed classes/combos would FAIL their bar net-of-friction. */
export const FRICTION = {
  pointsPerRoundTrip: 0.5,
  commissionPerSideUsd: 1.24,
  mesPointValueUsd: 5,
} as const;
export const FRICTION_PTS_PER_TRADE =
  Math.round((FRICTION.pointsPerRoundTrip + (2 * FRICTION.commissionPerSideUsd) / FRICTION.mesPointValueUsd) * 1000) / 1000; // 0.996

/** DAILY LOSS STOP (2026-08-02): the harness simulates the live engine's rule DAY-SEQUENTIALLY
 *  (applyDailyLossStop) at the same default the live adapter uses. */
// RULE REMOVED 2026-08-17 (user directive — funded accounts; live paths no longer stop, so the
// as-traded replay must not either: live parity). 0 = applyDailyLossStop no-ops. The historic
// default survives as DAILY_LOSS_STOP_DEFAULT_PTS; restore by re-pointing this at it.
export const DAILY_LOSS_STOP_PTS = 0;
/** Per-trade chart coverage window (user scope change 2026-07-14): render chart PNGs ONLY for
 *  trades whose ET date is on/after this key. Older rows keep their data, "—" in CHART. */
const CHART_FROM_KEY = "2026-03-01";
/** REPORTING WINDOW (user directive 2026-07-15): only trades ENTERED on/after this ET day
 *  count and report — the last ~3 months. */
const WINDOW_START_KEY = "2026-04-15";
/** Candle-loading floor: enough runway before the window for the 50-trading-day yellowbox
 *  walk-forward, vector warmup and ICT/fractal context. Bars before WINDOW_START are
 *  lookback only — they never produce reported trades. */
const LOOKBACK_START_KEY = "2026-01-01";
/** Parse a window-mode override key ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm", ET wall time). */
function parseEtWindowKey(key: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(key);
  if (!m) throw new Error(`--window-from/--window-to must be YYYY-MM-DD[THH:mm] (ET wall time), got: ${key}`);
  return etWallToEpoch(m[1], m[2] ? parseInt(m[2], 10) : 0, m[3] ? parseInt(m[3], 10) : 0);
}
/** Emission ceiling (window mode); Infinity = "to the present" (the standing behavior). */
const WINDOW_END_TS: number = WINDOW_TO_OVR ? parseEtWindowKey(WINDOW_TO_OVR) : Infinity;
/** Gate verdicts / exit calibrations resting on fewer window trades than this are flagged
 *  lowConfidence; gate verdicts additionally CARRY FORWARD the previous full-history verdict
 *  instead of judging the thin sample. */
const THIN_N = 50;
/** COMBO GATE thin thresholds (2026-07-29): a combo@interval verdict needs >= this many
 *  held-out CLASS-GATED rows; thinner falls back to the all-interval combo, which needs
 *  >= COMBO_THIN_ALL_N; thinner still → NO verdict (the class gate alone governs — thin
 *  data never blocks). Previous-file combo verdicts that go thin CARRY FORWARD
 *  lowConfidence, mirroring the class semantics. */
const COMBO_THIN_IV_N = 20;
const COMBO_THIN_ALL_N = 15;
/** PER-COMBO exit calibration thresholds (mission 2026-07-29 — "5m/15m fire only their most
 *  optimized trades"): a gate-ALLOWED combo@interval with >= MIN_OWN of its own gated-window
 *  trades grid-searches its OWN exits; MIN_POOLED..MIN_OWN-1 pools with the same-interval
 *  allowed-combo (fact-engine) trades; fewer → no entry (the class exit governs). */
const COMBO_EXIT_MIN_OWN_N = 30;
const COMBO_EXIT_MIN_POOLED_N = 15;
/** The live scrubber window size (market.tsx windowSize_v4 default) — the engine's candle
 *  inputs mirror the live chart's loaded window (see the LIVE SCRUBBER WINDOW block in
 *  loadData). Change ONLY together with the client default. */
const LIVE_WINDOW_DAYS = 90;
/** Snapshot of the PREVIOUS checked-in gate (the file as imported at process start) — the
 *  carry-forward source for thin classes AND the config of the BEFORE (old-engine) pass.
 *  Deep-copied so nothing this run builds can alias into it. */
const OLD_GATE: QualityGateData = JSON.parse(JSON.stringify(QUALITY_GATE)) as QualityGateData;

// ==================== SESSION / VALIDITY FILTERS ====================
// Mirror of the serving path (routes.ts isMarketClosed + market.tsx filterCandlesForVector).

const _closedCache = new Map<number, boolean>();
function isMarketClosedEt(t: number): boolean {
  const hb = Math.floor(t / 3600);
  const hit = _closedCache.get(hb);
  if (hit !== undefined) return hit;
  const p = etParts(t);
  const dow = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
  const mins = p.hh * 60 + p.mm;
  let closed: boolean;
  if (dow === 6) closed = true;                       // Saturday
  else if (dow === 5) closed = mins >= 17 * 60;       // Friday after 5 PM ET
  else if (dow === 0) closed = mins < 18 * 60;        // Sunday before 6 PM ET
  else closed = mins >= 17 * 60 && mins < 18 * 60;    // daily maintenance halt
  _closedCache.set(hb, closed);
  return closed;
}

function isValidBar(o: number, h: number, l: number, c: number): boolean {
  if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) return false;
  if (o < 1 || h < 1 || l < 1 || c < 1) return false;
  if (o >= 9e13 || h >= 9e13 || l >= 9e13 || c >= 9e13) return false;
  if (h <= l) return false;
  const range = h - l;
  if (range / c > 0.015 && Math.abs(o - c) / range < 0.10) return false;
  const bL = Math.min(o, c), bH = Math.max(o, c);
  if ((bL - l) / c > 0.015 || (h - bH) / c > 0.015) return false;
  return true;
}

// ==================== ROW / META TYPES ====================

type Outcome = "tp1" | "tp2" | "sl" | "eod" | "open";
interface SigRow {
  fireTs: number;      // firing bar OPEN time (engine sig.time)
  entryTs: number;     // firing bar CLOSE = entry moment
  dateET: string;
  timeET: string;
  weekday: string;
  sessionDay: string;
  session: "RTH" | "ETH";
  interval: Interval;
  direction: "Long" | "Short";
  signalType: string;
  strategiesInvolved: string;
  factCount: number;
  fullLabel: string;
  why: string;             // plain-English "WHY IT FIRED" sentence
  exitStrategy: string;    // plain-English exit plan with basis
  anchor: string;          // TP1 anchor kind (zone/yellowbox/tabletop/default)
  // TP1-ONLY (2026-08-13): tp2 is NULL on engine fires (persisted as NULL — the policy's
  // "tp2 null everywhere"); solo diagnostic shells may still carry a number.
  entry: number; tp1: number; tp2: number | null; sl: number;
  outcome: Outcome;
  exitPrice: number | null;
  exitTs: number | null;
  exitTimeET: string;
  pointsResult: number | null;
  mae: number;
  mfe: number;
  barsToExit: number | null;
  yellowboxContext: "inside" | "above" | "below" | "none";
  distFromSettle: number | null;
  year: number;
  confidence: number;
  engineOutcome: string;
  chartPath?: string;  // relative path of this trade's chart PNG (trade-charts/<iv>/…)
  /** Engine confirmations JSON (anchor + corroboration metadata) — carried so --persist can
   *  write the SAME confirmations column the live adapter posts. Absent on solo analysis rows. */
  confirmations?: string;
  /** Canonical fact-family combo key (shared comboKeyOf) — per-combo reporting + the PHASE D2
   *  exit-calibration accounting. Absent on solo analysis rows. */
  combo?: string;
  /** RISK DISPLAY (2026-07-30): the engine's fire-time situational risk flags
   *  (shared/fact-engine computeRiskFlags) — carried into --persist + the results JSON. */
  riskFlags?: string[];
  /** POSITION SIZING (2026-08-02): the engine's combo-tier suggested contract count
   *  (display/config-only) — carried into --persist + the results JSON. */
  suggestedContracts?: number;
  /** SHADOW TAGS (2026-10-01, record-only): the engine's computeShadowTags output — written to
   *  the results JSON + the CSV's trailing shadowTags column ('|'-joined). Not persisted by
   *  --persist (regen rows keep shadow_tags NULL = not evaluated). */
  shadowTags?: string[];
}

interface CalibRow {
  cls: string;             // internal classKey
  display: string;         // user-facing class name
  n: number;               // class n in the gated set
  pool: string;            // which sample calibrated it
  poolN: number;
  oldTp1: number; oldSl: number;
  tp1: number; sl: number; tp2: number;
  winnersN: number;        // TP1-winners backing the p85 MAE
  simExp: number;          // grid-model expectancy at the chosen exits
  ciLo: number; ciHi: number; // bootstrap 95% CI on simExp (class's own signals)
  expBefore: number;       // realized expectancy, provisional exits (full walk)
  expAfter: number;        // realized expectancy, calibrated exits (full walk)
  pfBefore: number; pfAfter: number;
}

/** PER-COMBO exit calibration accounting (PHASE D2, mission 2026-07-29). */
interface ComboCalibRow {
  key: string;             // "<combo>@<interval>"
  n: number;               // the combo's own trades in the gated set
  pool: string;            // which sample calibrated it (own vs same-interval pooled)
  poolN: number;
  tp1: number; sl: number; tp2: number;
  winnersN: number;
  simExp: number;
  clsTp1: number | null;   // the class exit this combo previously inherited (fact-engine@iv)
  clsSl: number | null;
  /** Realized stats of this combo's FINAL rows under the combo exits (full walk). */
  nFinal: number; expFinal: number; pfFinal: number;
}

interface RunMeta {
  symbol: string;
  generatedAt: string;
  runtimeSec: number;
  dataSpan: Record<string, { n: number; from: string; to: string }>;
  emissionStart: string;
  emissionStartTs: number;
  lastDataTs: number;
  /** REPORTING WINDOW (directive 2026-07-15): only trades entered in [from, to] count. */
  windowFromKey: string;
  windowToKey: string;
  /** Old engine (previous gate+exits, no ICT/fractal) vs the new final run, SAME window.
   *  net* fields (2026-08-02) = after FRICTION_PTS_PER_TRADE per closed trade. */
  beforeAfter: {
    windowFrom: string; windowTo: string;
    before: { trades: number; expectancy: number; pf: number; cumPts: number; winRate: number; netExpectancy: number; netPf: number; netCumPts: number };
    after: { trades: number; expectancy: number; pf: number; cumPts: number; winRate: number; netExpectancy: number; netPf: number; netCumPts: number };
    newlyFiredTotal: number;
    newlyFiredWithCorroborators: number;
    droppedVsBefore: number;
    suppressedByChop: number;
    corroboratedTrades: number;
    corroboratedSharePct: number;
  };
  /** Per-fact-kind contribution of the FRACTAL-GEOMETRY guide corroborators (2026-07-15):
   *  how many final trades carry each FG fact + their outcomes. Label-fragment based. */
  fgFactStats: Array<{ kind: string; display: string; trades: number; winRatePct: number; expectancy: number }>;
  engineSettings: typeof FACT_ENGINE_DEFAULTS;
  provisionalExit: typeof EXIT_CALIBRATION;
  coverage: { milkZones: string; footprint: string; yellowbox: string };
  gateRule: typeof GATE_RULE;
  gateClasses: Record<string, GateClassStat>;
  /** COMBO GATE (2026-07-29): per fact-family-combination verdicts (held-out, class-gated). */
  comboClasses: Record<string, GateClassStat>;
  /** Measured combo-gate effect: FINAL vs a diagnostic pass with ONLY comboClasses removed. */
  comboEffect: {
    suppressedTrades: number;
    suppressedByCombo: Array<{ key: string; n: number }>;
    diag: { trades: number; expectancy: number; pf: number; cumPts: number };
  };
  multiFact: { n: number; pf: number; expectancy: number };
  ungatedTotal: number;
  gatedTotal: number;
  calibration: CalibRow[];
  /** PER-COMBO Monte-Carlo exits shipped as exitByCombo (PHASE D2); empty in window mode. */
  comboCalibration: ComboCalibRow[];
  percentiles: Record<string, { n: number; mae: number[]; mfe: number[] }>; // p50/75/85/90/95
  gatedPerInterval: Array<{ interval: Interval; primaryBars: number; signals: number; fireRatePct: number }>;
  tail30d: Record<string, { gated: number; byType: Record<string, number> }>;
  soloCounts: Record<string, number>;
  /** FRICTION MODEL (2026-08-02 — reporting-only; gate verdicts stay GROSS, documented). */
  friction: { pointsPerRoundTrip: number; commissionPerSideUsd: number; mesPointValueUsd: number; ptsPerTrade: number };
  /** Gate-ALLOWED classes/combos that would FAIL their bar net-of-friction (gross-only survivors). */
  frictionAudit: FrictionAuditRow[];
  /** DAILY LOSS STOP (2026-08-02): the day-sequential simulation applied to the FINAL set. */
  dailyLossStop: { stopPts: number; derivation: string; trippedDays: string[]; suppressedTrades: number };
  /** DEAD-TAPE SUPPRESSION (2026-08-02): measured effect vs a no-deadtape diagnostic pass. */
  deadTape: { mult: number; suppressedVsFinal: number; suppressedByInterval: Record<string, number> };
}

interface ResultsDoc {
  meta: RunMeta;
  signals: SigRow[];                        // FINAL quality-gated, MC-calibrated trade set
  solo: { vector: SigRow[]; yellowbox: SigRow[]; footprint: SigRow[] };
  pngs: Record<string, string>;             // interval -> base64 PNG (Monte Carlo sheet)
}

// ==================== SMALL HELPERS ====================

function lowerBound(times: number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
function asOfIndex(times: number[], t: number): number {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function pctl(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ==================== DATA LOADING (PHASE A) ====================

interface YbRow { day_key: string; session_start: number; session_end: number; settle: number; box_top: number; box_bottom: number; init_res: number; init_sup: number }
interface Loaded {
  candlesByIv: Record<Interval, FiringCandle[]>;
  /** Serving-path-mirror candles per interval (pre client primary chain) — the raw material
   *  deriveEngineSlices consumes for SECONDARY slices, exactly like the live adapter's
   *  raw1mData/raw60mData/rawCandleData fetches. */
  servedByIv: Record<Interval, LiveCandle[]>;
  vectorByIv: Record<Interval, VectorPoint[]>;
  dataSpan: RunMeta["dataSpan"];
  c1m: FiringCandle[];
  t1m: number[];
  lastDataTs: number;
  days: DayAgg[];
  firstEligibleKey: string;
  emissionStartTs: number;
  dayZones: Array<{ dayKeyET: string; sessionStartTs: number; sessionEndTs: number; boxTop: number; boxBottom: number; initRes: number; initSup: number }>;
  ybByKey: Map<string, YbRow>;
  fpMap: Map<number, FpImbalanceZone[]>;
  fpCoverage: string;
  computedYbKeys: string[];
  /** RISK DISPLAY (2026-07-30): the window median session-day range (dead-tape baseline),
   *  computed by the SHARED shared/day-range-median.ts implementation the server's
   *  GET /api/risk/combo-stats also uses — the parity test asserts both sides are equal. */
  dayRangeMedian: number;
  dayRangeMedianDays: number;
}

function loadData(): Loaded {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    if (STRICT_READONLY) throw e; // --strict-readonly / shadow-rule replay: never a write handle
    db = new Database(DB_PATH, { fileMustExist: true }); // WAL readonly needs -shm; no writes issued
  }

  const RES_OF: Record<Interval, string> = { "1m": "1", "5m": "5", "15m": "15", "60m": "60" };
  const lookbackFromTs = etWallToEpoch(LOOKBACK_START_KEY, 0, 0); // window lookback floor
  const nowSecLoad = Math.floor(Date.now() / 1000);

  // ── SERVING-PATH MIRROR (2026-07-17, live-adapter parity) ─────────────────────────────
  // The live chart's candles come from GET /api/data/cached-continuous, whose serve-time
  // chain (grid alignment, flat-bar drop, per-interval spike thresholds, market-closed,
  // rth flag) shapes every bar the adapter sees. The harness mirrors that chain here, then
  // builds engine inputs through the SAME @shared/live-adapter functions market.tsx uses
  // (buildBaseCandles / normalizeServed15m / deriveEngineSlices) — verified end-to-end by
  // scripts/fact-engine-parity.test.ts, which compares against the REAL running server.
  // MW-coverage guard: every lookback bar must be MW-authoritative (sync_state.earliest_ts
  // <= lookback floor) — the serving path's legacy heavy filters (dropWickSpikes/
  // dropIsolatedSpikes/dropCompletedGhostBars) only run on pre-coverage bars and are NOT
  // mirrored; the guard fails loudly if that assumption ever breaks.
  const SPIKE_THR: Record<Interval, number> = { "1m": 0.025, "5m": 0.040, "15m": 0.050, "60m": 0.070 };
  const isServeSpikeBar = (iv: Interval, o: number, h: number, l: number, c: number): boolean => {
    if (h < l || o > h || o < l || c > h || c < l || c <= 0) return true;
    const thr = SPIKE_THR[iv];
    const range = h - l;
    if (range / c > thr) return true;
    if (range / c > thr * 0.5) {
      if ((Math.abs(o - h) < 0.5 && Math.abs(l - c) < 0.5) ||
          (Math.abs(o - l) < 0.5 && Math.abs(h - c) < 0.5)) return true;
    }
    return false;
  };
  for (const iv of INTERVALS) {
    const cov = db.prepare(`SELECT earliest_ts FROM sync_state WHERE symbol=? AND resolution=?`)
      .get(SYMBOL, RES_OF[iv]) as { earliest_ts: number | null } | undefined;
    if ((cov?.earliest_ts ?? Infinity) > lookbackFromTs) {
      throw new Error(`MW coverage for ${SYMBOL}:${RES_OF[iv]} starts after the lookback floor ${LOOKBACK_START_KEY} — the serving path would apply its legacy heavy filters there, which this mirror does not implement`);
    }
  }
  const loadServed = (iv: Interval, res: string): LiveCandle[] => {
    const resSec = (parseInt(res, 10) || 5) * 60;
    const arr: LiveCandle[] = [];
    const it = db.prepare(
      `SELECT timestamp t, open o, high h, low l, close c, volume v
       FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp>=? ORDER BY timestamp`
    ).iterate(SYMBOL, res, lookbackFromTs) as IterableIterator<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
    for (const r of it) {
      if (r.t % resSec !== 0) continue;                       // off-grid artifact
      if (r.h === r.l) continue;                              // flat "dash" bar
      if (isServeSpikeBar(iv, r.o, r.h, r.l, r.c)) continue;  // per-interval spike thresholds
      if (isMarketClosedEt(r.t)) continue;
      if (arr.length && arr[arr.length - 1].time === r.t) arr.pop(); // last-wins on dup timestamps
      arr.push({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v ?? 0, rth: isRTH(r.t) });
    }
    return arr;
  };
  const servedFullByIv = {} as Record<Interval, LiveCandle[]>;
  for (const iv of INTERVALS) servedFullByIv[iv] = loadServed(iv, RES_OF[iv]);
  // The server serves native "15" when rows exist; the client then keeps 900-aligned bars
  // (normalizeServed15m). The 5m→15m serving fallback is not mirrored — assert native rows.
  if (!servedFullByIv["15m"].length) throw new Error("no native 15m rows — the serving 5m→15m fallback is not mirrored here");

  // ── LIVE SCRUBBER WINDOW (2026-07-17) ────────────────────────────────────────────────
  // The live engine sees candles from the scrubber's window: the LAST 90 entries of the
  // /api/data/cached-days list (DISTINCT UTC dates with any 5/15/60 row), fromTs = UTC
  // midnight of the window's first date (market.tsx windowSize_v4 default 90 + dateToTs).
  // Engine inputs MUST mirror that window: engine state is array-start-sensitive (ICT
  // capped level arrays, FG wave medians), so a longer lookback produces DIFFERENT signals
  // on the same day — found empirically by the parity test (widening the adapter window
  // changed its 1m signal set). The Jan-1 lookback below feeds ONLY the yellowbox day
  // structures (50-day walk-forward), never the engine slices.
  const dayRows = db.prepare(
    `SELECT DISTINCT DATE(datetime(timestamp,'unixepoch')) d FROM cached_candles WHERE symbol=? AND resolution IN ('5','15','60') ORDER BY d`
  ).all(SYMBOL) as Array<{ d: string }>;
  const todayStr = new Date().toISOString().split("T")[0];
  const dayList = dayRows.map(r => r.d).filter(d => d <= todayStr);
  const winStartDate = dayList[Math.max(0, dayList.length - LIVE_WINDOW_DAYS)];
  const [wy, wm, wd] = winStartDate.split("-").map(Number);
  const liveWindowFromTs = Math.floor(Date.UTC(wy, wm - 1, wd, 0) / 1000); // market.tsx dateToTs(date, 0)
  console.log(`[fe-bt] live scrubber window: last ${LIVE_WINDOW_DAYS} cached days -> from ${winStartDate} (UTC midnight)`);
  const sliceFromWin = (a: LiveCandle[]): LiveCandle[] => {
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].time < liveWindowFromTs) lo = mid + 1; else hi = mid; }
    return a.slice(lo);
  };
  const servedByIv = {} as Record<Interval, LiveCandle[]>;
  for (const iv of INTERVALS) servedByIv[iv] = sliceFromWin(servedFullByIv[iv]);

  // FULL-lookback client-chain arrays for the yellowbox day structures only.
  const full5m = buildBaseCandles(servedFullByIv["5m"], true, nowSecLoad) as FiringCandle[];
  const full60m = buildBaseCandles(servedFullByIv["60m"], true, nowSecLoad) as FiringCandle[];

  // Primary-role arrays = the client chain the live chart applies to its OWN interval:
  // (15m: normalizeServed15m first) → buildBaseCandles (showETH=true — the live default),
  // over the live-window served arrays.
  const candlesByIv = {} as Record<Interval, FiringCandle[]>;
  const dataSpan: RunMeta["dataSpan"] = {};
  for (const iv of INTERVALS) {
    const base = iv === "15m" ? normalizeServed15m(servedByIv[iv], "15") : servedByIv[iv];
    const arr = buildBaseCandles(base, true, nowSecLoad) as FiringCandle[];
    candlesByIv[iv] = arr;
    dataSpan[iv] = {
      n: arr.length,
      from: new Date(arr[0].time * 1000).toISOString().slice(0, 10),
      to: new Date(arr[arr.length - 1].time * 1000).toISOString().slice(0, 10),
    };
    console.log(`[fe-bt] ${iv}: served=${servedByIv[iv].length} primary-role=${arr.length} (${dataSpan[iv].from}..${dataSpan[iv].to})  ${elapsed()}`);
  }
  const c1m = candlesByIv["1m"];
  const t1m = c1m.map(c => c.time);
  const lastDataTs = Math.max(...INTERVALS.map(iv => candlesByIv[iv][candlesByIv[iv].length - 1].time + INTERVAL_SEC[iv]));

  // Guard: the live window must start comfortably before the reporting window so every
  // reported trade has full engine warmup (vector/fractal/FG windows).
  if (liveWindowFromTs > etWallToEpoch(WINDOW_START_KEY, 0, 0) - 5 * 86400) {
    console.warn(`[fe-bt] WARNING: live scrubber window starts ${winStartDate} — under 5 days of engine warmup before the reporting window ${WINDOW_START_KEY}`);
  }

  // Yellowbox day structures use the FULL Jan-1 lookback (50-day walk-forward), never the
  // live-window slices.
  const bars5: Bar[] = full5m.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? 0 }));
  const { dayMap } = buildSessionDays(bars5);
  const days: DayAgg[] = [...dayMap.values()]
    .filter(d => d.bars >= 60 && d.weekday >= 1 && d.weekday <= 5)
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  for (let i = 1; i < days.length; i++) days[i].prevClose = days[i - 1].c;
  const firstEligibleIdx = 51;
  if (days.length <= firstEligibleIdx) throw new Error(`only ${days.length} trading days loaded from ${LOOKBACK_START_KEY} — not enough for the 50-day yellowbox walk-forward`);
  const firstEligibleKey = days[firstEligibleIdx].key;
  // Emission = the REPORTING WINDOW start (or the yellowbox-eligibility day, whichever is
  // later — with the Jan-1 lookback floor the window start always wins in practice).
  const ybEligibleTs = etWallToEpoch(priorCalendarDay(firstEligibleKey), 18, 0);
  const windowStartTs = WINDOW_FROM_OVR ? parseEtWindowKey(WINDOW_FROM_OVR) : etWallToEpoch(WINDOW_START_KEY, 0, 0);
  const emissionStartTs = Math.max(ybEligibleTs, windowStartTs);
  console.log(`[fe-bt] trading days ${days.length} (${days[0].key}..${days[days.length - 1].key}); yb-eligible ${firstEligibleKey}; REPORTING WINDOW ${WINDOW_START_KEY} -> present`);

  const ybRows = db.prepare(
    `SELECT day_key, session_start, session_end, settle, box_top, box_bottom, init_res, init_sup
     FROM yellowbox_day_zones WHERE symbol=? AND traded=1 AND ver=? ORDER BY day_key`
  ).all(SYMBOL, YB_CACHE_VER) as YbRow[];
  const ybByKey = new Map<string, YbRow>(ybRows.map(r => [r.day_key, r]));
  const day60 = new Map<string, Bar[]>();
  for (const c of full60m) {
    const k = sessionDayKey(c.time);
    let a = day60.get(k); if (!a) { a = []; day60.set(k, a); }
    a.push({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? 0 });
  }
  const computedYbKeys: string[] = [];
  for (let i = firstEligibleIdx; i < days.length; i++) {
    const k = days[i].key;
    if (ybByKey.has(k)) continue;
    const last50 = days.slice(i - 50, i).filter(x => x.prevClose !== null);
    if (last50.length < 50) continue;
    const anchor = days[i - 1].c;
    const z = computeCoreZones(last50, day60, anchor);
    ybByKey.set(k, {
      day_key: k,
      session_start: etWallToEpoch(priorCalendarDay(k), 18, 0),
      session_end: etWallToEpoch(k, 17, 0),
      settle: anchor,
      box_top: rnd2(z.ybTop), box_bottom: rnd2(z.ybBottom),
      init_res: rnd2(z.initRes), init_sup: rnd2(z.initSup),
    });
    computedYbKeys.push(k);
  }
  const dayZones = [...ybByKey.values()]
    .filter(r => r.day_key >= firstEligibleKey)
    .sort((a, b) => (a.day_key < b.day_key ? -1 : 1))
    .map(r => ({
      dayKeyET: r.day_key, sessionStartTs: r.session_start, sessionEndTs: r.session_end,
      boxTop: r.box_top, boxBottom: r.box_bottom, initRes: r.init_res, initSup: r.init_sup,
    }));
  console.log(`[fe-bt] yellowbox day-zones: ${ybRows.length} cached + ${computedYbKeys.length} computed; ${dayZones.length} passed to engine (>= ${firstEligibleKey})`);

  const fpMap = new Map<number, FpImbalanceZone[]>();
  let fpFrom = Infinity, fpTo = -Infinity;
  const fpRows = db.prepare(
    `SELECT time, data FROM footprint_candles WHERE symbol=? AND interval='5m' AND complete=1 ORDER BY time`
  ).all(SYMBOL) as Array<{ time: number; data: string }>;
  for (const r of fpRows) {
    try {
      const d = JSON.parse(r.data) as { imbalances?: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> };
      const zs = (d.imbalances ?? []).filter(im => im.levelCount >= 2)
        .map(im => ({ startPrice: im.startPrice, endPrice: im.endPrice, direction: im.direction, levelCount: im.levelCount }));
      if (zs.length) { fpMap.set(r.time, zs); fpFrom = Math.min(fpFrom, r.time); fpTo = Math.max(fpTo, r.time); }
    } catch { /* malformed JSON row — no fact */ }
  }
  const fpCoverage = fpMap.size
    ? `5m interval only, ${new Date(fpFrom * 1000).toISOString().slice(0, 10)} .. ${new Date(fpTo * 1000).toISOString().slice(0, 10)} (${fpMap.size} bars with stacked imbalances of ${fpRows.length} complete footprint rows)`
    : "none in DB";
  console.log(`[fe-bt] footprint coverage: ${fpCoverage}`);

  // RISK DISPLAY (2026-07-30): dead-tape baseline through the SHARED implementation
  // (shared/day-range-median.ts) so this value and the server's /api/risk/combo-stats value
  // can never drift. Keyed to the standing WINDOW_START_KEY (the regime baseline is the
  // standing 3-month window even under --window-from overrides — mirrors the analysis).
  const drm = medianSessionDayRangeFromDb(db, SYMBOL, WINDOW_START_KEY, nowSecLoad);
  console.log(`[fe-bt] dead-tape baseline: median session-day range ${drm.median} over ${drm.nDays} window days`);
  db.close();

  const vectorByIv = {} as Record<Interval, VectorPoint[]>;
  for (const iv of INTERVALS) vectorByIv[iv] = computeVectorLine(candlesByIv[iv]);
  console.log(`[fe-bt] vectors computed  ${elapsed()}`);

  return { candlesByIv, servedByIv, vectorByIv, dataSpan, c1m, t1m, lastDataTs, days, firstEligibleKey, emissionStartTs, dayZones, ybByKey, fpMap, fpCoverage, computedYbKeys, dayRangeMedian: drm.median, dayRangeMedianDays: drm.nDays };
}

// ==================== ENGINE PASSES ====================

// gateData is REQUIRED: every pass must state its gate/exit config explicitly. Omitting it
// would fall back to the engine's IMPORTED shared/quality-gate.ts — i.e. the PREVIOUS run's
// calibrated exits would leak into this run's baseline (a self-referencing feedback loop that
// silently changed the gate verdicts between runs; caught 2026-07-14).
// ict/fractal MIRROR THE LIVE ADAPTER (default ON — market.tsx passes the two CONFIRMATION
// toggles, both default ON; levels derive inside the engine so the inputs are identical).
function enginePass(
  L: Loaded,
  opts: {
    gate: boolean; gateData: QualityGateData; label: string;
    ict?: boolean; fractal?: boolean; fractalGeo?: boolean; settings?: Partial<FactEngineSettings>;
    /** DEAD-TAPE SUPPRESSION (2026-08-02): engine default ON; false ONLY for the BEFORE pass
     *  (the old shipped engine had no suppression) and the DIAG(no-deadtape) measurement pass. */
    deadTape?: boolean;
  },
  nowSec: number,
): Record<Interval, FactSignal[]> {
  const out = {} as Record<Interval, FactSignal[]>;
  for (const primary of INTERVALS) {
    // LIVE-ADAPTER PARITY (2026-07-17): slices are built by the SAME deriveEngineSlices the
    // live chart uses — primary slice = the client primary chain (candlesByIv), secondaries
    // = the live ladder (native 1m/60m through filterCandlesForVector, 5m/15m aggregated
    // per the chart interval, D18 native-15m spacing detection) over the serving-mirror
    // arrays. Replaces the old native-per-interval slices, which diverged from what the
    // live engine actually sees (found by the parity test: aggregated-vs-native secondary
    // vectors flipped tabletop notes and 1m corroborators).
    const { slices } = deriveEngineSlices({
      interval: primary,
      windowedCandles: L.candlesByIv[primary],
      raw1mCandles: primary !== "1m" ? L.servedByIv["1m"] : undefined,
      rawCandles: L.servedByIv[primary],
      raw60mCandles: primary !== "60m" ? L.servedByIv["60m"] : undefined,
    });
    const fired = runFactEngine({
      primary,
      slices,
      zones: [],                                              // no uploaded milk-zone history
      dayZones: L.dayZones,
      // Real 5m footprint rows. LIVE PARITY (2026-07-29): market.tsx fetches the 5m footprint
      // history on BOTH the 5m and the 15m charts ("footprint runs on 5m base",
      // `interval === "15m" ? "5m" : interval`), so a 15m primary looks the 5m map up at its
      // 900-aligned bar times — identical to live's buildFootprintMap over 15m windowedCandles
      // (900 % 300 == 0; the engine only queries primary bar times). 1m/60m primaries get NONE
      // (feeding 5m zones into the 1m primary shifts firings — the parity test's own first bug).
      footprintByTime: primary === "5m" || primary === "15m" ? L.fpMap : undefined,
      // production defaults; the 2026-10-01 shadow-rule flags (window mode only) layer UNDER any
      // pass-specific override — no flag = {} = byte-identical.
      settings: SHADOW_RULES_ON ? { ...HARNESS_SHADOW_SETTINGS, ...(opts.settings ?? {}) } : (opts.settings ?? {}),
      nowSec,
      qualityGateEnabled: opts.gate,
      gateData: opts.gateData,
      ictEnabled: opts.ict !== false,
      fractalEnabled: opts.fractal !== false,
      fractalGeoEnabled: opts.fractalGeo !== false,
      // liveLevels DELIBERATELY never supplied: PML/TML are options-chain LIVE-ONLY levels
      // (backtestable:false facts) — no historical options data exists, so every backtest
      // excludes them by construction. See the README note.
      // RISK BASELINE (2026-07-30 display; 2026-08-02 dead-tape ENFORCEMENT baseline) — the
      // live adapter supplies the same value via GET /api/risk/combo-stats (parity-asserted).
      dayRangeMedian: L.dayRangeMedian,
      // DEAD-TAPE SUPPRESSION (2026-08-02): default ON like live; false only for BEFORE/DIAG.
      deadTapeSuppressEnabled: opts.deadTape !== false,
      // DAILY LOSS STOP: deliberately NOT an engine input here — the engine rule only ever
      // applies to the CURRENT session (nowSec's), which a backtest pass has no live P&L for;
      // the harness simulates the rule day-sequentially post-resolution (applyDailyLossStop).
    });
    out[primary] = fired.filter(s => s.time >= L.emissionStartTs && s.time <= WINDOW_END_TS);
    console.log(`[fe-bt] ${opts.label} ${primary}: ${out[primary].length} signals in window  ${elapsed()}`);
  }
  return out;
}

// ==================== EXIT WALK / SIGNAL RESOLUTION ====================

interface WalkResult {
  outcome: Outcome; exitPrice: number | null; exitTs: number | null;
  mae: number; mfe: number;
}
// CANONICAL RESOLVER DELEGATION (2026-07-31, shared/outcome-resolver.ts): first touch decides
// permanently; the ONLY upgrade is tp1 → tp2 when TP2 is reached with NO SL touch in between
// (an SL touch after TP1 locks the record at tp1 — its exit fields stay the TP1 record);
// same-1m-bar TP+SL resolves SL-first. CARRY-OVERNIGHT (2026-08-11): the canonical walk no
// longer stops at the settle — "eod" is never produced for new resolutions (vocab retained
// for historical rows); an untouched trade stays "open" until later data resolves it.
// The live engine's walkForward delegates to the SAME function — semantics cannot drift.
const CANON_TO_HARNESS: Record<string, Outcome> = { win_tp1: "tp1", win_tp2: "tp2", loss: "sl", eod: "eod", open: "open" };
function walkExit(
  entryTs: number, entry: number, isLong: boolean,
  tp1: number, tp2: number | null, sl: number,
  c1m: FiringCandle[], t1m: number[], lastDataTs: number, nowSec: number,
): WalkResult {
  const sessionDay = sessionDayKey(entryTs);
  const settleTs = etWallToEpoch(sessionDay, 17, 0);
  const w = walkOutcomeCanonical({
    bars: c1m, entryTs, entry, tp1, tp2, sl, isLong, settleTs, barSec: 60,
    coveredThroughTs: Math.min(lastDataTs, nowSec),
    // TP1-ONLY policy (2026-08-13): the harness scores what the live engine trades — single
    // source of truth is the engine default, so a future policy flip changes both together.
    tp1Only: FACT_ENGINE_DEFAULTS.TP1_ONLY,
  });
  return { outcome: CANON_TO_HARNESS[w.outcome], exitPrice: w.exitPrice, exitTs: w.exitTs, mae: w.mae, mfe: w.mfe };
}

/** Plain-English WHY IT FIRED sentence from the signal's facts (no jargon). */
function whyOf(sig: FactSignal): string {
  const levelIn = (label: string): string => {
    const m = /@([\d.]+)/.exec(label);
    return m ? ` ${m[1]}` : "";
  };
  const parts: string[] = [];
  for (const f of sig.facts.filter(f => f.counted)) {
    if (f.strategy === "vector" && f.kind === "side-entry") {
      parts.push(`${f.interval} side-entry ${f.direction === "Long" ? "long" : "short"}`);
    } else if (f.strategy === "zone") {
      parts.push(`${f.strong ? "strong " : ""}milk-zone ${f.direction === "Long" ? "support" : "resistance"} reaction${f.level != null ? ` at ${f.level.toFixed(2)}` : ""}`);
    } else if (f.strategy === "yellowbox") {
      parts.push(`${f.primary ? "" : `${f.interval} `}yellow box break ${f.direction === "Long" ? "above" : "below"}${levelIn(f.label)}`);
    } else if (f.strategy === "footprint") {
      parts.push(`footprint ${f.direction === "Long" ? "support" : "resistance"}${levelIn(f.label)}`);
    } else if (f.strategy === "ict") {
      // Confirmation facts (2026-07-15) — plain English, kill-zone note kept from the label.
      const kz = /, ([A-Za-z-]+)\)$/.exec(f.label)?.[1];
      const kzTxt = kz ? ` (${kz} kill zone)` : "";
      const what = f.kind === "sweep" ? "ICT liquidity-sweep reversal"
        : f.kind === "ob" ? "ICT order-block retest"
        : f.kind === "breaker" ? "ICT breaker-block retest"
        : "price reacting from an ICT fair value gap";
      parts.push(`${what}${f.level != null ? ` at ${f.level.toFixed(2)}` : ""}${kzTxt} confirming`);
    } else if (f.strategy === "fractal") {
      const what = f.kind === "breakout" ? `fractal breakout ${f.direction === "Long" ? "above" : "below"}${f.level != null ? ` ${f.level.toFixed(2)}` : ""}`
        : f.kind === "band" ? `close ${f.direction === "Long" ? "above" : "below"} the fractal chaos band${f.level != null ? ` at ${f.level.toFixed(2)}` : ""}`
        : `fractal chaos oscillator trending ${f.direction === "Long" ? "up" : "down"}`;
      parts.push(`${what} confirming`);
    } else {
      parts.push(f.label);
    }
  }
  const counted = sig.facts.filter(f => f.counted).length;
  let out = parts.join(" + ");
  if (counted >= 2) out += ` — ${counted} agreeing facts`;
  else if (sig.signalType === "vector-side-entry") out += " — overnight solo side-entry (ETH rule)";
  else if (sig.signalType === "zone-reaction") out += " — strong reaction fires alone (house rule)";
  else if (sig.signalType === "yellowbox-break") out += " — solo box-break (setting enabled)";
  const notes = sig.facts.filter(f => !f.counted);
  if (notes.length) {
    const noteTxt = notes.slice(0, 2).map(n =>
      n.kind === "tabletop" ? `${n.interval} vector tabletop${n.level != null ? ` ${n.level.toFixed(2)}` : ""}`
      : n.kind === "heading" ? `${n.interval} building toward a side-entry`
      : `${n.interval} yellow box note`).join(", ");
    out += `; context: ${noteTxt}`;
  }
  return out;
}

function exitStrategyOf(sig: FactSignal, anchor: string, calibrated: boolean): string {
  const d1 = Math.abs(sig.tp1 - sig.price), dSl = Math.abs(sig.sl - sig.price);
  const tpBasis = anchor === "zone" ? "at milk-zone edge"
    : anchor === "yellowbox" ? "at Yellow Box init level"
    : anchor === "tabletop" ? "at vector tabletop"
    : calibrated ? "MC p-optimal" : "house default";
  const slBasis = anchor === "yellowbox" && sig.signalType === "yellowbox-break" ? "opposite box edge"
    : calibrated ? "p85 MAE (MC)" : "house default";
  // TP1-ONLY (2026-08-13): tp2 is null on engine fires — one target, one stop. The TP2
  // segment only renders for legacy/diagnostic rows that still carry a number (this null
  // crashed the 2026-08-16 weekly regen: .toFixed on null).
  const tp2Part = sig.tp2 == null ? "TP1-only (no TP2)"
    : `TP2 ${Math.abs(sig.tp2 - sig.price).toFixed(2)} @ ${sig.tp2.toFixed(2)} (2x TP1)`;
  return `TP1 ${d1.toFixed(2)} @ ${sig.tp1.toFixed(2)} (${tpBasis}), SL ${dSl.toFixed(2)} @ ${sig.sl.toFixed(2)} (${slBasis}), ${tp2Part}`;
}

function resolveSignal(
  sig: FactSignal, L: Loaded, nowSec: number, calibratedClasses: Set<string>,
): SigRow {
  const barSec = INTERVAL_SEC[sig.interval];
  const entryTs = sig.time + barSec;
  const isLong = sig.direction === "Long";
  const entry = sig.price;
  const sessionDay = sessionDayKey(entryTs);
  const w = walkExit(entryTs, entry, isLong, sig.tp1, sig.tp2, sig.sl, L.c1m, L.t1m, L.lastDataTs, nowSec);
  const points = w.exitPrice == null ? null : rnd2((w.exitPrice - entry) * (isLong ? 1 : -1));

  const p = etParts(entryTs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const dateET = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  const timeET = `${pad(p.hh)}:${pad(p.mm)}`;
  const fmtEt = (t: number): string => {
    const q = etParts(t);
    return `${q.y}-${pad(q.mo)}-${pad(q.d)} ${pad(q.hh)}:${pad(q.mm)}`;
  };
  const yb = L.ybByKey.get(sessionDay);
  const inSession = yb != null && entryTs >= yb.session_start && entryTs <= yb.session_end;
  const yellowboxContext: SigRow["yellowboxContext"] = !yb || !inSession ? "none"
    : entry > yb.box_top ? "above" : entry < yb.box_bottom ? "below" : "inside";
  const strategies = [...new Set(sig.facts.map(f => f.strategy))];
  const order = ["vector", "zone", "yellowbox", "footprint", "ict", "fractal"];
  strategies.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  let anchor = "default";
  try { anchor = (JSON.parse(sig.confirmations) as { anchor?: string }).anchor ?? "default"; } catch { /* keep default */ }
  const calibrated = calibratedClasses.has(classKey(sig.signalType, sig.interval));

  return {
    fireTs: sig.time, entryTs, dateET, timeET,
    weekday: WEEKDAY_NAMES[weekdayOfKey(dateET)],
    sessionDay,
    session: sig.session, interval: sig.interval, direction: sig.direction,
    signalType: sig.signalType,
    strategiesInvolved: strategies.join(";"),
    factCount: sig.facts.filter(f => f.counted).length,
    fullLabel: sig.label,
    why: whyOf(sig),
    exitStrategy: exitStrategyOf(sig, anchor, calibrated),
    anchor,
    entry: rnd2(entry), tp1: rnd2(sig.tp1), tp2: sig.tp2 == null ? null : rnd2(sig.tp2), sl: rnd2(sig.sl),
    outcome: w.outcome, exitPrice: w.exitPrice == null ? null : rnd2(w.exitPrice), exitTs: w.exitTs,
    exitTimeET: w.exitTs == null ? "" : fmtEt(w.exitTs),
    pointsResult: points,
    mae: rnd2(w.mae), mfe: rnd2(w.mfe),
    barsToExit: w.exitTs == null ? null : Math.round(((w.exitTs - entryTs) / barSec) * 100) / 100,
    yellowboxContext,
    distFromSettle: yb && inSession ? rnd2(entry - yb.settle) : null,
    year: p.y,
    confidence: sig.confidence,
    engineOutcome: sig.outcome,
    confirmations: sig.confirmations,
    // RISK DISPLAY (2026-07-30): the engine now exposes its own fire-time comboKey — identical
    // to comboKeyOf(sig.facts) by construction; keep the derivation as the fallback for any
    // synthetic FactSignal fixture that omits it. riskFlags ride along for --persist + the JSON.
    combo: sig.comboKey ?? comboKeyOf(sig.facts),
    riskFlags: sig.riskFlags ?? [],
    shadowTags: sig.shadowTags ?? [], // SHADOW TAGS (2026-10-01): record-only, JSON + CSV
    // POSITION SIZING (2026-08-02): the engine's tier-derived suggested size rides along.
    ...(sig.suggestedContracts != null ? { suggestedContracts: sig.suggestedContracts } : {}),
  };
}

// ==================== METRICS ====================

interface Metrics {
  count: number; wins: number; losses: number; eod: number; open: number;
  winRate: number; avgWin: number; avgLoss: number; expectancy: number; cumPts: number;
  profitFactor: number; maxDD: number; avgMae: number; avgMfe: number; avgBars: number;
  /** NET-OF-FRICTION (2026-08-02, reporting-only): every CLOSED trade charged
   *  FRICTION_PTS_PER_TRADE (0.996 pts = 0.5 slippage/spread + 2×$1.24 commission at $5/pt).
   *  Gate verdicts stay GROSS (documented); these ride alongside everywhere stats print. */
  netExpectancy: number; netCumPts: number; netProfitFactor: number;
}
function metricsOf(rows: SigRow[]): Metrics {
  const wins = rows.filter(r => r.outcome === "tp1" || r.outcome === "tp2");
  const losses = rows.filter(r => r.outcome === "sl");
  const eod = rows.filter(r => r.outcome === "eod");
  const open = rows.filter(r => r.outcome === "open");
  const closed = rows.length - open.length;
  const pts = rows.filter(r => r.pointsResult != null).map(r => r.pointsResult as number);
  const grossWin = pts.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const grossLoss = pts.filter(v => v < 0).reduce((a, b) => a + b, 0);
  const cum = pts.reduce((a, b) => a + b, 0);
  // NET-of-friction: each closed trade pays FRICTION_PTS_PER_TRADE; the netted per-trade
  // values rebuild the win/loss buckets (a small gross winner can be a NET loser).
  const netPts = pts.map(v => v - FRICTION_PTS_PER_TRADE);
  const netWinSum = netPts.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const netLossSum = netPts.filter(v => v < 0).reduce((a, b) => a + b, 0);
  const netCum = netPts.reduce((a, b) => a + b, 0);
  let peak = 0, run = 0, mdd = 0;
  for (const r of rows) {
    if (r.pointsResult == null) continue;
    run += r.pointsResult; peak = Math.max(peak, run); mdd = Math.max(mdd, peak - run);
  }
  const avg = mean;
  const winPts = wins.map(r => r.pointsResult as number);
  const lossPts = losses.map(r => r.pointsResult as number);
  const barsArr = rows.filter(r => r.barsToExit != null).map(r => r.barsToExit as number);
  return {
    count: rows.length, wins: wins.length, losses: losses.length, eod: eod.length, open: open.length,
    winRate: closed ? wins.length / closed : 0,
    avgWin: rnd2(avg(winPts)), avgLoss: rnd2(avg(lossPts)),
    expectancy: closed ? rnd2(cum / closed) : 0,
    cumPts: rnd2(cum),
    profitFactor: grossLoss < 0 ? rnd2(grossWin / -grossLoss) : (grossWin > 0 ? 999 : 0),
    maxDD: rnd2(mdd),
    avgMae: rnd2(avg(rows.map(r => r.mae))), avgMfe: rnd2(avg(rows.map(r => r.mfe))),
    avgBars: rnd2(avg(barsArr)),
    netExpectancy: closed ? rnd2(netCum / closed) : 0,
    netCumPts: rnd2(netCum),
    netProfitFactor: netLossSum < 0 ? rnd2(netWinSum / -netLossSum) : (netWinSum > 0 ? 999 : 0),
  };
}

// ==================== DAILY LOSS STOP SIMULATION (2026-08-02) ====================
// DAY-SEQUENTIAL mirror of the live engine rule: per Globex session day (SigRow.sessionDay,
// 18:00 ET roll), walk the day's trades chronologically; before admitting each candidate,
// sum the REALIZED points of the day's already-admitted trades whose EXIT is at/before the
// candidate's entry; once that running sum <= -stopPts the day is TRIPPED and every later
// candidate that day is suppressed (sticky — exactly the live adapter's trip ref; suppressed
// trades never traded, so they contribute NOTHING to the running sum).
// HONESTY NOTE (documented): the live check additionally counts the OPEN-TRADE MARK at fire
// time (unrealizable here without tick data) — live can only trip EARLIER than this
// simulation, never later; the backtest is therefore the OPTIMISTIC bound of the rule.
export interface LossStopResult {
  kept: SigRow[];
  suppressed: SigRow[];
  trippedDays: string[];
}
export function applyDailyLossStop(rowsIn: SigRow[], stopPts: number): LossStopResult {
  if (!(stopPts > 0)) return { kept: [...rowsIn], suppressed: [], trippedDays: [] };
  const rows = [...rowsIn].sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  const kept: SigRow[] = [];
  const suppressed: SigRow[] = [];
  const trippedDays: string[] = [];
  const byDay = new Map<string, SigRow[]>();
  for (const r of rows) {
    let a = byDay.get(r.sessionDay); if (!a) { a = []; byDay.set(r.sessionDay, a); }
    a.push(r);
  }
  for (const [day, dayRows] of byDay) {
    const admitted: SigRow[] = [];
    let tripped = false;
    for (const r of dayRows) {
      if (tripped) { suppressed.push(r); continue; }
      const realizedBefore = admitted.reduce((sum, x) =>
        x.exitTs != null && x.exitTs <= r.entryTs && x.pointsResult != null ? sum + x.pointsResult : sum, 0);
      if (realizedBefore <= -stopPts) {
        tripped = true;
        trippedDays.push(day);
        suppressed.push(r);
        continue;
      }
      admitted.push(r);
      kept.push(r);
    }
  }
  kept.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  return { kept, suppressed, trippedDays };
}

// ==================== COMBINED RISK STOPS (2026-08-10: loss stop + streak stop) ====================
// ONE day-sequential walk applying BOTH as-traded risk rules exactly as the live engine sees
// them: the -stopPts DAILY LOSS STOP (realized closed points of admitted trades whose exit is
// at/before the candidate's entry — identical semantics to applyDailyLossStop above, same
// optimistic-bound honesty note) AND the K-consecutive-loss STREAK STOP per interval (among
// the day's ADMITTED trades of the candidate's interval CLOSED by the candidate's entry,
// exit-ordered via the SHARED maxConsecLossRun — the same helper the live adapter hands the
// engine; monotone ⇒ sticky). Combined in one walk because the rules interact: a trade
// suppressed by either rule never happened, so it can neither bleed the day P&L nor extend
// (nor reset!) a loss streak. streakLosses <= 0 reduces this EXACTLY to applyDailyLossStop.
export interface RiskStopsResult extends LossStopResult {
  streakStops: Array<{ day: string; interval: string }>;
}
export function applyRiskStops(rowsIn: SigRow[], stopPts: number, streakLosses: number): RiskStopsResult {
  const rows = [...rowsIn].sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  const kept: SigRow[] = [], suppressed: SigRow[] = [], trippedDays: string[] = [];
  const streakStops: Array<{ day: string; interval: string }> = [];
  const byDay = new Map<string, SigRow[]>();
  for (const r of rows) {
    let a = byDay.get(r.sessionDay); if (!a) { a = []; byDay.set(r.sessionDay, a); }
    a.push(r);
  }
  for (const [day, dayRows] of byDay) {
    const admitted: SigRow[] = [];
    let tripped = false;
    const streakTripped = new Set<string>();
    for (const r of dayRows) {
      if (tripped || streakTripped.has(r.interval)) { suppressed.push(r); continue; }
      const closedBefore = admitted.filter(x => x.exitTs != null && x.exitTs <= r.entryTs && x.pointsResult != null);
      if (stopPts > 0) {
        const realizedBefore = closedBefore.reduce((sum, x) => sum + (x.pointsResult as number), 0);
        if (realizedBefore <= -stopPts) { tripped = true; trippedDays.push(day); suppressed.push(r); continue; }
      }
      if (streakLosses > 0) {
        const run = maxConsecLossRun(closedBefore
          .filter(x => x.interval === r.interval)
          .map(x => ({ exitTs: x.exitTs as number, pointsResult: x.pointsResult as number })));
        if (run >= streakLosses) { streakTripped.add(r.interval); streakStops.push({ day, interval: r.interval }); suppressed.push(r); continue; }
      }
      admitted.push(r);
      kept.push(r);
    }
  }
  kept.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  return { kept, suppressed, trippedDays, streakStops };
}

// ==================== QUALITY GATE (PHASE B → gate data) ====================
// TWO-STAGE WALK-FORWARD (2026-07-17, replaces the provisional-exit derivation): judging a
// class's PF/expectancy at the provisional 10/5 exits punished classes whose calibrated exits
// are wide (the documented gate-vs-calibrated-exits tension — fact-engine@5m sat on the 1.05
// knife edge), while judging at exits calibrated on the SAME trades would be self-referential.
// Honest split: within the reporting window, derive MC exits per class on the FIRST HALF's
// trades only, then judge each class on the SECOND HALF's trades simulated under those exits —
// the exits never see the trades they are judged on. Gate rule itself is UNCHANGED
// (PF >= 1.05 AND expectancy > 0.1; >=3-fact override; n < THIN_N held-out trades → verdict
// carried forward from the previous gate file with lowConfidence).
// The SHIPPED exitByClass (written later in PHASE D) is still refit on the FULL window —
// future live trades are unseen data, so refitting on everything is sound; only the VERDICT
// must be held-out.

interface WfTuple { e: Excursion; entryTs: number; counted: number; combo: string }

/** FRICTION AUDIT (2026-08-02): every gate-ALLOWED class/combo whose HELD-OUT record would
 *  FAIL its own interval's bar once FRICTION_PTS_PER_TRADE is charged per simulated trade.
 *  The gate still judges GROSS (documented) — this table is how the user sees marginal ones.
 *  Populated by computeGateDataWalkForward; embedded in meta.frictionAudit + the README. */
export interface FrictionAuditRow {
  key: string;                       // class or combo key (fallback combos: "<combo> (at <iv>)")
  kind: "class" | "combo" | "combo-fallback";
  bar: string;                       // the bar it was judged at
  n: number;
  grossPf: number; grossExp: number;
  netPf: number; netExp: number;
  carried: boolean;                  // lowConfidence carried verdict — no fresh held-out basis
}
let FRICTION_AUDIT: FrictionAuditRow[] = [];

function computeGateDataWalkForward(
  ungatedByIv: Record<Interval, FactSignal[]>,
  L: Loaded,
  nowSec: number,
  generatedAt: string,
  windowTo: string,
): QualityGateData {
  FRICTION_AUDIT = []; // fresh audit per derivation
  // Excursion per ungated signal (skips unfinished sessions — same rule as calibration input).
  const tuples: WfTuple[] = [];
  let total = 0;
  for (const iv of INTERVALS) {
    for (const sig of ungatedByIv[iv]) {
      total++;
      const e = buildExcursion(sig, L, nowSec);
      if (!e) continue;
      tuples.push({
        e, entryTs: sig.time + INTERVAL_SEC[sig.interval],
        counted: sig.facts.filter(f => f.counted).length,
        combo: comboKeyOf(sig.facts), // the SHARED helper — engine + harness must never drift
      });
    }
  }
  // Split at the window's calendar midpoint (entry time decides the half).
  const splitTs = Math.floor((L.emissionStartTs + L.lastDataTs) / 2);
  const sp = etParts(splitTs);
  const splitKey = `${sp.y}-${String(sp.mo).padStart(2, "0")}-${String(sp.d).padStart(2, "0")}`;
  const train = tuples.filter(t => t.entryTs < splitTs);
  const test = tuples.filter(t => t.entryTs >= splitTs);
  console.log(`[fe-bt] walk-forward split @ ${splitKey}: train ${train.length} / held-out ${test.length} (of ${total} ungated, ${tuples.length} with finished sessions)`);

  const trainByClass = new Map<string, Excursion[]>();
  const trainByIvPool = new Map<Interval, Excursion[]>();
  for (const t of train) {
    let a = trainByClass.get(t.e.cls); if (!a) { a = []; trainByClass.set(t.e.cls, a); }
    a.push(t.e);
    let b = trainByIvPool.get(t.e.interval); if (!b) { b = []; trainByIvPool.set(t.e.interval, b); }
    b.push(t.e);
  }
  const testByClass = new Map<string, WfTuple[]>();
  for (const t of test) {
    let a = testByClass.get(t.e.cls); if (!a) { a = []; testByClass.set(t.e.cls, a); }
    a.push(t);
  }

  // Stage 1 — per-class exits from the FIRST half (same pooling ladder as PHASE D calibration).
  const allClasses = [...new Set([...trainByClass.keys(), ...testByClass.keys()])].sort();
  const wfExit = new Map<string, { tp1: number; sl: number; trainN: number; pool: string }>();
  for (const cls of allClasses) {
    const own = trainByClass.get(cls) ?? [];
    const iv = cls.split("@")[1] as Interval;
    let pool = own, poolName = "its own first-half trades";
    if (own.length < 100) {
      const ivPool = trainByIvPool.get(iv) ?? [];
      if (ivPool.length >= 100) { pool = ivPool; poolName = `all first-half ${iv} trades`; }
      else if (own.length >= 30) { pool = own; poolName = "its own first-half trades (small sample kept — interval-scale faithful)"; }
      else { pool = train.map(t => t.e); poolName = "all first-half trades (class too small)"; }
    }
    const best = gridSearch(pool);
    if (best) wfExit.set(cls, { tp1: best.tp1, sl: best.sl, trainN: own.length, pool: poolName });
    // no valid grid candidate → judged at the provisional exits below (noted per class)
  }

  // Stage 2 — held-out verdict: simulate each SECOND-half trade under the stage-1 exits.
  const provTp = EXIT_CALIBRATION.DEFAULT_TP1_PTS, provSl = EXIT_CALIBRATION.DEFAULT_SL_PTS;
  const simStats = (rows: WfTuple[], exitOf: (cls: string) => { tp1: number; sl: number }): { n: number; pf: number; exp: number; winRate: number; netPf: number; netExp: number } => {
    const res = rows.map(t => { const x = exitOf(t.e.cls); return simulate(t.e, x.tp1, x.sl); });
    const gw = res.filter(v => v > 0).reduce((a, b) => a + b, 0);
    const gl = res.filter(v => v < 0).reduce((a, b) => a + b, 0);
    // NET-of-friction (2026-08-02, FRICTION AUDIT only — verdicts stay GROSS, documented):
    // the same simulated trades charged FRICTION_PTS_PER_TRADE each.
    const net = res.map(v => v - FRICTION_PTS_PER_TRADE);
    const nw = net.filter(v => v > 0).reduce((a, b) => a + b, 0);
    const nl = net.filter(v => v < 0).reduce((a, b) => a + b, 0);
    return {
      n: res.length,
      pf: gl < 0 ? Math.round((gw / -gl) * 1000) / 1000 : (gw > 0 ? 999 : 0),
      exp: res.length ? Math.round((res.reduce((a, b) => a + b, 0) / res.length) * 1000) / 1000 : 0,
      winRate: res.length ? Math.round((res.filter(v => v > 0).length / res.length) * 1000) / 1000 : 0,
      netPf: nl < 0 ? Math.round((nw / -nl) * 1000) / 1000 : (nw > 0 ? 999 : 0),
      netExp: res.length ? Math.round((net.reduce((a, b) => a + b, 0) / res.length) * 1000) / 1000 : 0,
    };
  };
  const exitOf = (cls: string): { tp1: number; sl: number } => wfExit.get(cls) ?? { tp1: provTp, sl: provSl };

  const classes: Record<string, GateClassStat> = {};
  for (const cls of allClasses) {
    const testRows = testByClass.get(cls) ?? [];
    const m = simStats(testRows, exitOf);
    const wf = wfExit.get(cls);
    const clsIv = cls.split("@")[1];
    const clsBar = gateBarOf(clsIv);
    const exitTxt = wf
      ? `exits TP1 ${wf.tp1}/SL ${wf.sl} from the first half (${wf.trainN} own trades, pool: ${wf.pool})`
      : `provisional exits ${provTp}/${provSl} (first half had no valid grid candidate)`;
    const wfTxt = `walk-forward: ${exitTxt}; judged on the held-out second half ${splitKey}..${windowTo} (n=${m.n}) at the ${clsIv} bar (${gateBarTxt(clsIv)})`;
    const ruleAllowed = m.pf >= clsBar.MIN_PF && m.exp > clsBar.MIN_EXPECTANCY_PTS;
    // STATISTICAL HONESTY (user directive 2026-07-15, unchanged): fewer than THIN_N held-out
    // trades is too thin to judge — inherit the previous gate file's verdict (lowConfidence +
    // note); a class with no previous verdict keeps the held-out-rule result, flagged thin.
    let allowed = ruleAllowed;
    let lowConfidence = false;
    let note: string = wfTxt;
    if (m.n < THIN_N) {
      lowConfidence = true;
      const prev = OLD_GATE.classes[cls];
      if (prev) {
        allowed = prev.allowed;
        note = `carried forward (insufficient held-out sample, n=${m.n} < ${THIN_N}): previous gate verdict ${prev.allowed ? "ALLOWED" : "BLOCKED"} (n=${prev.n}, PF=${prev.pf}, expectancy=${prev.expectancy}); ${wfTxt}`;
      } else {
        note = `thin held-out sample (n=${m.n} < ${THIN_N}) with no previous verdict — held-out rule applied, treat with caution; ${wfTxt}`;
      }
    }
    classes[cls] = {
      n: m.n, pf: m.pf, expectancy: m.exp, winRate: m.winRate, allowed,
      ...(lowConfidence ? { lowConfidence } : {}), note,
    };
    // FRICTION AUDIT (2026-08-02): allowed class whose held-out sim FAILS its bar net-of-friction.
    if (allowed && !(m.netPf >= clsBar.MIN_PF && m.netExp > clsBar.MIN_EXPECTANCY_PTS)) {
      FRICTION_AUDIT.push({ key: cls, kind: "class", bar: gateBarTxt(clsIv), n: m.n, grossPf: m.pf, grossExp: m.exp, netPf: m.netPf, netExp: m.netExp, carried: lowConfidence });
    }
    console.log(`[fe-bt] WF ${cls}: ${wf ? `TP1 ${wf.tp1}/SL ${wf.sl} (train n=${wf.trainN})` : `prov ${provTp}/${provSl}`} → held-out n=${m.n} PF=${m.pf} exp=${m.exp} (net PF=${m.netPf} exp=${m.netExp}) → ${allowed ? "PASS" : "BLOCK"}${lowConfidence ? " (carried)" : ""}`);
  }

  // ── COMBO GATE derivation (2026-07-29) ────────────────────────────────────────────────
  // Verdicts per canonical fact-FAMILY combination, judged on the HELD-OUT half's rows that
  // the CLASS gate (just derived above) would admit live — the combo gate stacks ON TOP of
  // the class gate, so its evidence base is the class-gated population. RECURSION GUARD: the
  // rows come from the NEUTRAL ungated pass (same input as the class verdicts) filtered by
  // class verdict here — never from a pass that already consulted any combo verdicts.
  // Simulation uses the SAME stage-1 first-half class exits (exitOf) as the class verdicts.
  const clsGateAdmits = (t: WfTuple): boolean => {
    if (t.counted >= GATE_RULE.MIN_FACTS_OVERRIDE) return true; // multi-fact override fires live
    const c = classes[t.e.cls];
    return !c || c.allowed; // absent class = never blocked (no data != bad data)
  };
  const gatedTest = test.filter(t => clsGateAdmits(t) && t.combo.length > 0);
  const byComboIv = new Map<string, WfTuple[]>();
  const byComboAll = new Map<string, WfTuple[]>();
  for (const t of gatedTest) {
    const kIv = `${t.combo}@${t.e.interval}`;
    let a = byComboIv.get(kIv); if (!a) { a = []; byComboIv.set(kIv, a); }
    a.push(t);
    let b = byComboAll.get(t.combo); if (!b) { b = []; byComboAll.set(t.combo, b); }
    b.push(t);
  }
  const comboClasses: Record<string, GateClassStat> = {};
  const comboNote = (n: number): string =>
    `combo gate: judged on the held-out CLASS-GATED rows ${splitKey}..${windowTo} under the first-half class exits (n=${n})`;
  for (const [key, rows] of [...byComboIv.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (rows.length < COMBO_THIN_IV_N) continue; // thin at this granularity — fallback governs
    const m = simStats(rows, exitOf);
    const comboIv = key.slice(key.lastIndexOf("@") + 1);
    const b = gateBarOf(comboIv);
    const allowed = m.pf >= b.MIN_PF && m.exp > b.MIN_EXPECTANCY_PTS;
    comboClasses[key] = {
      n: m.n, pf: m.pf, expectancy: m.exp, winRate: m.winRate,
      allowed,
      note: `${comboNote(m.n)}; judged at the ${comboIv} bar (${gateBarTxt(comboIv)})`,
    };
    if (allowed && !(m.netPf >= b.MIN_PF && m.netExp > b.MIN_EXPECTANCY_PTS)) {
      FRICTION_AUDIT.push({ key, kind: "combo", bar: gateBarTxt(comboIv), n: m.n, grossPf: m.pf, grossExp: m.exp, netPf: m.netPf, netExp: m.netExp, carried: false });
    }
  }
  for (const [key, rows] of [...byComboAll.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (rows.length < COMBO_THIN_ALL_N) continue;
    const m = simStats(rows, exitOf);
    // PER-INTERVAL GATE BARS (2026-07-31): an all-interval fallback verdict cannot be a single
    // boolean any more — it is consulted from EVERY interval, each with its own bar. Emit the
    // per-consulting-interval verdict map; `allowed` stays as the ANY-interval summary (legacy
    // fallback only — comboGateAllows consults allowedByInterval first).
    const allowedByInterval: Record<string, boolean> = {};
    for (const iv of INTERVALS) {
      const b = gateBarOf(iv);
      allowedByInterval[iv] = m.pf >= b.MIN_PF && m.exp > b.MIN_EXPECTANCY_PTS;
      // FRICTION AUDIT: fallback verdicts are per CONSULTING interval — audit each allowed one.
      if (allowedByInterval[iv] && !(m.netPf >= b.MIN_PF && m.netExp > b.MIN_EXPECTANCY_PTS)) {
        FRICTION_AUDIT.push({ key: `${key} (at ${iv})`, kind: "combo-fallback", bar: gateBarTxt(iv), n: m.n, grossPf: m.pf, grossExp: m.exp, netPf: m.netPf, netExp: m.netExp, carried: false });
      }
    }
    comboClasses[key] = {
      n: m.n, pf: m.pf, expectancy: m.exp, winRate: m.winRate,
      allowed: Object.values(allowedByInterval).some(Boolean),
      allowedByInterval,
      note: `${comboNote(m.n)}; all-interval fallback granularity — verdict evaluated at the CONSULTING interval's bar (allowedByInterval; summary allowed = ANY interval's bar passes)`,
    };
  }
  // Carry-forward (mirrors the class semantics): previous-file combo verdicts whose key is
  // now too thin to re-judge keep their verdict, flagged lowConfidence. Thin never flips at
  // ANY bar: a carried fallback combo keeps its carried per-interval map (or replicates the
  // carried boolean at every interval for entries predating allowedByInterval).
  for (const [key, prev] of Object.entries(OLD_GATE.comboClasses ?? {})) {
    if (comboClasses[key]) continue;
    const rows = (key.includes("@") ? byComboIv.get(key) : byComboAll.get(key)) ?? [];
    const m = simStats(rows, exitOf);
    const isFallback = !key.includes("@");
    comboClasses[key] = {
      n: m.n, pf: m.pf, expectancy: m.exp, winRate: m.winRate,
      allowed: prev.allowed, lowConfidence: true,
      ...(isFallback
        ? { allowedByInterval: prev.allowedByInterval ?? Object.fromEntries(INTERVALS.map(iv => [iv, prev.allowed])) }
        : {}),
      note: `carried forward (insufficient held-out sample, n=${m.n} < ${key.includes("@") ? COMBO_THIN_IV_N : COMBO_THIN_ALL_N}): previous combo verdict ${prev.allowed ? "ALLOWED" : "BLOCKED"} (n=${prev.n}, PF=${prev.pf}, expectancy=${prev.expectancy}); ${comboNote(m.n)}`,
    };
  }
  for (const [key, c] of Object.entries(comboClasses).sort(([a], [b]) => a.localeCompare(b))) {
    const verdictTxt = c.allowedByInterval
      ? INTERVALS.map(iv => `${iv}:${c.allowedByInterval![iv] ? "PASS" : "BLOCK"}`).join(" ")
      : (c.allowed ? "PASS" : "BLOCK");
    console.log(`[fe-bt] COMBO ${key.padEnd(20)} n=${String(c.n).padEnd(5)} PF=${c.pf} exp=${c.expectancy} → ${verdictTxt}${c.lowConfidence ? " (carried)" : ""}`);
  }

  // ── FRICTION AUDIT TABLE (2026-08-02): allowed entries that fail their bar NET-of-friction.
  // The gate keeps judging GROSS (changing the verdict basis silently is out of scope — the
  // decision whether the bar should move to net accounting is the USER's); this table makes
  // every marginal survivor visible.
  if (FRICTION_AUDIT.length) {
    console.log(`\n[fe-bt] ═══ FRICTION AUDIT — ALLOWED but would FAIL their bar NET of ${FRICTION_PTS_PER_TRADE} pts/trade friction ═══`);
    for (const a of FRICTION_AUDIT) {
      console.log(`[fe-bt]   ${a.kind.padEnd(14)} ${a.key.padEnd(26)} bar[${a.bar}] n=${String(a.n).padEnd(5)} gross PF=${a.grossPf} exp=${a.grossExp} → NET PF=${a.netPf} exp=${a.netExp}${a.carried ? "  (carried verdict)" : ""}`);
    }
    console.log(`[fe-bt] ═══ ${FRICTION_AUDIT.length} allowed entr${FRICTION_AUDIT.length === 1 ? "y" : "ies"} are GROSS-only survivors (verdicts unchanged — gate judges gross, documented) ═══`);
  } else {
    console.log(`\n[fe-bt] FRICTION AUDIT: every allowed class/combo ALSO clears its bar net of ${FRICTION_PTS_PER_TRADE} pts/trade friction`);
  }

  // >=3-fact override pool, same held-out basis (informational — the override itself always fires).
  const mfRows = test.filter(t => t.counted >= GATE_RULE.MIN_FACTS_OVERRIDE);
  const mfM = simStats(mfRows, exitOf);
  return {
    generatedAt,
    source: `scripts/fact-engine-backtest.ts two-stage walk-forward (${WINDOW_START_KEY}..${windowTo}, split ${splitKey}: MC exits from the first half, verdicts from the held-out second half; ${total} ungated signals, symbol ${SYMBOL}, ICT+fractal confirmations ON)`,
    rule: { ...GATE_RULE },
    multiFact: { n: mfM.n, pf: mfM.pf, expectancy: mfM.exp },
    classes,
    exitByClass: {},
    comboClasses,
  };
}

// ==================== MONTE-CARLO EXIT CALIBRATION (PHASE D) ====================

interface Excursion {
  cls: string;
  interval: Interval;
  /** Canonical fact-family combo key (shared comboKeyOf) — the PER-COMBO exit calibration
   *  (PHASE D2) groups on this. */
  combo: string;
  /** signalType — the per-combo calibration excludes the structural classes
   *  (zone-reaction / vector-side-entry), mirroring the engine's exemption. */
  sigType: string;
  eodPts: number;
  mfeSteps: Array<[number, number]>; // [pts level, 1m-bar ordinal] — new favorable high-waters
  maeSteps: Array<[number, number]>;
  mfeMax: number; maeMax: number;
}

function buildExcursion(sig: FactSignal, L: Loaded, nowSec: number): Excursion | null {
  const barSec = INTERVAL_SEC[sig.interval];
  const entryTs = sig.time + barSec;
  const isLong = sig.direction === "Long";
  const entry = sig.price;
  const settleTs = etWallToEpoch(sessionDayKey(entryTs), 17, 0);
  if (settleTs > Math.min(L.lastDataTs, nowSec)) return null; // unfinished session — no calibration input
  // CALIBRATION STAYS INTRADAY-BOUNDED — a deliberate asymmetry with the CARRY-OVERNIGHT
  // resolver (2026-08-11): letting the MC grid see time-unbounded excursions degenerated
  // immediately (measured: median SL ballooned 15-30 → 90-112 pts, median hold 16h with a
  // 5-DAY p90, 186 concurrent open positions, 72% "tp2 by drift" — an untradeable fantasy
  // book the gate then rubber-stamped). The user's directive changes what happens to an
  // OPEN trade (it rides until TP/SL instead of force-closing at the settle); it does NOT
  // license re-optimizing the exits themselves into multi-day space. So exits keep being
  // derived from same-session excursions; the realized RECORD then carries overnight at
  // those exits (the eodPts leg is the intraday-approximation of un-crossed candidates —
  // documented imprecision, small at intraday-scale exit distances).
  const mfeSteps: Array<[number, number]> = [];
  const maeSteps: Array<[number, number]> = [];
  let mfeMax = 0, maeMax = 0, lastClose = entry, k = 0;
  for (let j = lowerBound(L.t1m, entryTs); j < L.c1m.length; j++, k++) {
    const b = L.c1m[j];
    if (b.time >= settleTs) break;
    const fav = isLong ? b.high - entry : entry - b.low;
    const adv = isLong ? entry - b.low : b.high - entry;
    if (fav > mfeMax) { mfeMax = fav; mfeSteps.push([fav, k]); }
    if (adv > maeMax) { maeMax = adv; maeSteps.push([adv, k]); }
    lastClose = b.close;
  }
  return {
    cls: classKey(sig.signalType, sig.interval), interval: sig.interval,
    combo: comboKeyOf(sig.facts), sigType: sig.signalType,
    eodPts: rnd2((lastClose - entry) * (isLong ? 1 : -1)),
    mfeSteps, maeSteps, mfeMax: rnd2(mfeMax), maeMax: rnd2(maeMax),
  };
}

function firstIdxAtOrAbove(steps: Array<[number, number]>, level: number): number | null {
  for (const [lv, ord] of steps) if (lv >= level - 1e-9) return ord;
  return null;
}
function maeAtOrBefore(steps: Array<[number, number]>, ord: number): number {
  let m = 0;
  for (const [lv, o] of steps) { if (o <= ord) m = lv; else break; }
  return m;
}
/** Path simulation over the excursion step functions under the CANONICAL resolver semantics
 *  (2026-07-31 alignment, shared/outcome-resolver.ts — the gate/exit machinery must model the
 *  SAME payoff the realized record books, or verdicts/exits are derived under dead semantics):
 *    • first touch decides: SL at-or-before the first TP1 touch (same-1m-bar tie = SL-first) → −sl;
 *    • TP1 first → the record locks at +tp AND the UPGRADE WATCH runs: reaching TP2 (= 2×tp,
 *      user rule) with NO SL touch in between pays +2×tp (win_tp2); an SL touch after TP1 ENDS
 *      the watch and the payoff stays +tp (exit at the TP1 record — post-TP1 heat can never
 *      turn the win into a loss, so the stop needs NO headroom for it);
 *    • same-ordinal TP2+SL resolves SL-first (no upgrade), mirroring resolver rule 4;
 *    • neither TP1 nor SL ever touched → the session-end close (eodPts). */
function simulate(e: Excursion, tp: number, sl: number): number {
  const tTP = firstIdxAtOrAbove(e.mfeSteps, tp);
  const tSL = firstIdxAtOrAbove(e.maeSteps, sl);
  if (tSL != null && (tTP == null || tSL <= tTP)) return -sl;       // SL first (incl. same-bar tie)
  if (tTP != null) {
    // TP1-ONLY policy (2026-08-13): calibration scores what the live engine trades — the
    // resting limit fills at TP1 and the trade is done. No retroactive TP2 upgrade, ever.
    if (FACT_ENGINE_DEFAULTS.TP1_ONLY) return tp;
    const tTP2 = firstIdxAtOrAbove(e.mfeSteps, tp * 2);             // TP2 = 2×TP1 (user rule)
    if (tTP2 != null && (tSL == null || tTP2 < tSL)) return tp * 2; // upgrade: TP2 with no SL between
    return tp;                                                      // win_tp1 locked forever
  }
  return e.eodPts;
}

interface GridBest { tp1: number; sl: number; exp: number; winnersN: number }
/** CONSISTENCY OBJECTIVE (2026-08-12, USER-APPROVED after the TP1-frontier analysis — "the
 *  tps are way too much; put in the new calibrated tps, the sl calibration is fine"):
 *  the old objective was pure argmax mean expectancy, which buys its last ~10% of expectancy
 *  with materially longer holds, lower win rates and higher payoff variance (measured:
 *  fe@15m argmax 18.25/24.75 = win 64.1%, hold 221m vs the knee 13.75/23 = win 68.1%, PF
 *  2.25, hold 170m). New rule: among grid cells whose NET expectancy (after
 *  FRICTION_PTS_PER_TRADE) is within 85% of the best net cell, pick the HIGHEST WIN RATE
 *  (ties → higher net). The SL rule per cell is unchanged: p85 of winners' MAE. */
function gridSearch(pool: Excursion[]): GridBest | null {
  interface Cell extends GridBest { net: number; winRate: number }
  const cells: Cell[] = [];
  // TP1-ONLY grid floor (2026-08-13): the user explicitly banned shipping tiny targets
  // ("dont ship the 4 point tp" — the 4/23 cell wins 92% but nets ~$2/contract after
  // realistic fills). Calibration may never pick below 6 points.
  for (let tp = 6; tp <= 30 + 1e-9; tp += TICK) {
    const winnersMae: number[] = [];
    for (const e of pool) {
      const tTP = firstIdxAtOrAbove(e.mfeSteps, tp);
      if (tTP == null) continue;
      winnersMae.push(maeAtOrBefore(e.maeSteps, tTP));
    }
    if (winnersMae.length < 30) continue; // p85 over fewer winners is noise
    const sl = Math.max(1, toTick(pctl(winnersMae, 0.85)));
    const payoffs = pool.map(e => simulate(e, tp, sl));
    const exp = mean(payoffs);
    const winRate = payoffs.filter(p => p > 0).length / Math.max(1, payoffs.length);
    cells.push({ tp1: rnd2(tp), sl: rnd2(sl), exp: rnd2(exp * 1000) / 1000, winnersN: winnersMae.length, net: exp - FRICTION_PTS_PER_TRADE, winRate });
  }
  if (!cells.length) return null;
  const maxNet = Math.max(...cells.map(c => c.net));
  // 2026-09-25: when EVERY cell nets negative (a losing class under the new engine rules) the old
  // `net >= 0.85 * maxNet` band lay ABOVE the best cell (0.85 x a negative number is larger), the
  // eligible set was empty and `reduce` threw "Reduce of empty array" — the whole run died. The
  // band is now "within 15 % of the best on the best cell's own side", and never empty.
  const band = maxNet - 0.15 * Math.abs(maxNet) - 1e-12;
  let eligible = cells.filter(c => c.net >= band);
  if (!eligible.length) eligible = [cells.reduce((a, b) => (b.net > a.net ? b : a))];
  const best = eligible.reduce((a, b) => (b.winRate > a.winRate + 1e-12 || (Math.abs(b.winRate - a.winRate) <= 1e-12 && b.net > a.net) ? b : a));
  return { tp1: best.tp1, sl: best.sl, exp: best.exp, winnersN: best.winnersN };
}

function bootstrapCi(own: Excursion[], tp: number, sl: number, iters = 1000): [number, number] {
  if (!own.length) return [0, 0];
  let seed = 42 >>> 0;
  const rand = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const res: number[] = own.map(e => simulate(e, tp, sl));
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let k = 0; k < res.length; k++) sum += res[Math.floor(rand() * res.length)];
    means.push(sum / res.length);
  }
  return [Math.round(pctl(means, 0.025) * 1000) / 1000, Math.round(pctl(means, 0.975) * 1000) / 1000];
}

// ==================== GENERATED FILE (PHASE E) ====================

function writeQualityGateFile(data: QualityGateData): void {
  const lines: string[] = [];
  const classLines = Object.entries(data.classes).map(([k, c]) =>
    `//   ${k.padEnd(24)} n=${String(c.n).padEnd(7)} PF=${c.pf.toFixed(3)}  expectancy=${(c.expectancy >= 0 ? "+" : "") + c.expectancy.toFixed(3)}  -> ${c.allowed ? "ALLOWED" : "BLOCKED"}${c.lowConfidence ? "  [LOW-CONF: carried forward]" : ""}`);
  const exitLines = Object.entries(data.exitByClass).map(([k, e]) =>
    `//   ${k.padEnd(24)} TP1=${e.tp1.toFixed(2)}  SL=${e.sl.toFixed(2)}  (pool: ${e.pool})${e.lowConfidence ? "  [LOW-CONF]" : ""}`);
  const comboLines = Object.entries(data.comboClasses ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => {
    const verdict = c.allowedByInterval
      ? Object.entries(c.allowedByInterval).map(([iv, a]) => `${iv}:${a ? "ALLOW" : "BLOCK"}`).join(" ")
      : (c.allowed ? "ALLOWED" : "BLOCKED");
    return `//   ${k.padEnd(24)} n=${String(c.n).padEnd(7)} PF=${c.pf.toFixed(3)}  expectancy=${(c.expectancy >= 0 ? "+" : "") + c.expectancy.toFixed(3)}  -> ${verdict}${c.lowConfidence ? "  [LOW-CONF: carried forward]" : ""}`;
  });
  const comboExitLines = Object.entries(data.exitByCombo ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, e]) =>
    `//   ${k.padEnd(24)} TP1=${e.tp1.toFixed(2)}  SL=${e.sl.toFixed(2)}  (n=${e.n}, pool: ${e.pool})${e.lowConfidence ? "  [LOW-CONF]" : ""}`);
  lines.push(
    `// shared/quality-gate.ts`,
    `// ═════════════════════════════════════════════════════════════════════════════`,
    `// GENERATED FILE — regenerated by \`npx tsx scripts/fact-engine-backtest.ts\` on every full`,
    `// backtest run. Hand edits to the DATA below will be overwritten; the interfaces and`,
    `// functions are part of the template in the harness (edit them THERE).`,
    `//`,
    `// THE QUALITY GATE (user directive 2026-07-14: "Quality over quantity — I don't need a`,
    `// million trades, I need trades that will win"). A setup CLASS is signalType × primary`,
    `// interval. Verdicts are TWO-STAGE WALK-FORWARD (2026-07-17): the reporting window (the`,
    `// last ~3 months — user directive 2026-07-15) is split at its calendar midpoint; per-class`,
    `// MC exits are derived on the FIRST half's trades only, and each class is judged on the`,
    `// HELD-OUT second half simulated under those exits (exits never see the trades they are`,
    `// judged on). A class may fire live ONLY if its held-out half clears ITS OWN interval's`,
    `// bar (PER-INTERVAL GATE BARS — user-chosen 2026-07-31 from the per-interval gate-bar`,
    `// menu, scripts/gate-bar-menu-by-interval.ts):`,
    ...Object.entries(data.rule.perInterval).map(([iv, b]) =>
      `//     ${iv.padEnd(4)} profit factor >= ${String(b.MIN_PF).padEnd(5)} AND expectancy > ${b.MIN_EXPECTANCY_PTS} pts per trade`),
    `// (Per-class n/pf/expectancy below are the HELD-OUT stats; each note records the`,
    `// first-half exits used. The exitByClass calibration shipped below is refit on the FULL`,
    `// window — future live trades are unseen data; only the verdict must be held-out.)`,
    `//`,
    `// VERDICT BASIS IS GROSS POINTS (2026-08-02 friction note): all pf/expectancy figures here`,
    `// are GROSS — no slippage or commission charged. The harness now REPORTS net-of-friction`,
    `// (~${FRICTION_PTS_PER_TRADE} pts/round trip: 0.5 pt = one tick each side + spread allowance, plus 2 x`,
    `// $${FRICTION.commissionPerSideUsd} commission at $${FRICTION.mesPointValueUsd}/pt) alongside gross everywhere, and prints a FRICTION AUDIT of`,
    `// allowed classes/combos that would FAIL their bar net-of-friction — but changing the`,
    `// VERDICT basis silently is out of scope; moving the bar to net accounting is a USER call.`,
    `// Overrides:`,
    `//   • >=${data.rule.MIN_FACTS_OVERRIDE} COUNTED agreeing facts fire on ANY interval/session (multi-fact pool:`,
    `//     n=${data.multiFact.n} PF=${data.multiFact.pf.toFixed(3)} expectancy=${data.multiFact.expectancy.toFixed(3)}).`,
    `//   • Classes with NO backtest data are NEVER blocked ("no data" != "bad data"):`,
    `//     zone-reaction (no uploaded milk-zone history exists — structural zero) and`,
    `//     yellowbox-break (solo box-breaks only exist behind the explicit YELLOWBOX_SOLO`,
    `//     opt-in, default off). Blocking them would dead-end user rule 5 (strong milk-zone`,
    `//     solo) and the YELLOWBOX_SOLO setting the moment they produce their first signal.`,
    `//   • Classes with FEWER THAN 50 HELD-OUT trades are too thin to judge: their verdict is`,
    `//     CARRIED FORWARD from the previous gate file and flagged lowConfidence`,
    `//     (statistical honesty — never silently block/allow on a thin sample).`,
    `//`,
    `// Generated ${data.generatedAt}`,
    `// Stats source: ${data.source}`,
    ...classLines,
    `// Monte-Carlo calibrated exits (SL = p85 MAE of TP1-winners; TP1 = expectancy-max grid 4..30;`,
    `// TP2 = 2 x TP1). Grid payoff models the CANONICAL outcome semantics (2026-07-31,`,
    `// shared/outcome-resolver.ts): first touch decides (same-bar tie = SL-first); a TP1 win`,
    `// pays 2 x TP1 when TP2 is reached with no SL touch in between (the upgrade watch) and`,
    `// stays +TP1 otherwise — SL after TP1 never turns the win into a loss.`,
    `// [LOW-CONF] = the class's own window sample was n < 50:`,
    ...(exitLines.length ? exitLines : ["//   (none)"]),
    `// COMBO GATE (2026-07-29: "only take the historically winning fact-combinations"): a`,
    `// signal's COUNTED fact families form a canonical combo key (comboKeyOf — Vec/YB/ICT/Fr/`,
    `// FG/FP/Zone); verdicts below are judged on the held-out half's CLASS-GATED rows under the`,
    `// first-half class exits, at the SAME per-interval bars. "combo@interval" verdicts (n>=20)`,
    `// use THAT interval's bar; the all-interval "combo" fallback (n>=15) is evaluated at the`,
    `// CONSULTING interval's bar — its allowedByInterval map holds the per-interval verdicts`,
    `// (the summary allowed = ANY interval's bar passes; carried entries keep their carried`,
    `// verdict at every interval). Absent at both granularities = never blocked.`,
    `// A blocked combo suppresses EVEN >=3-counted-fact signals (the class-gate override does`,
    `// NOT bypass the combo gate); zone-reaction + ETH solo vector-side-entry are exempt:`,
    ...(comboLines.length ? comboLines : ["//   (none)"]),
    `// PER-COMBO Monte-Carlo exits (mission 2026-07-29 — "5m and 15m fire only their most`,
    `// optimized, winning trades"): gate-ALLOWED combos with >=${COMBO_EXIT_MIN_OWN_N} of their own gated-window`,
    `// trades grid-search their OWN TP1 (4..30, SL = p85 MAE of TP1-winners, >=30-winners rule);`,
    `// ${COMBO_EXIT_MIN_POOLED_N}..${COMBO_EXIT_MIN_OWN_N - 1} own trades pool with the same-interval allowed-combo trades; fewer -> the`,
    `// class exit governs. Engine resolution: caller-explicit exit > combo exit > class exit >`,
    `// provisional (zone/yellowbox TP1 anchors keep priority inside computeExit; zone-reaction +`,
    `// vector-side-entry stay class-exited). [LOW-CONF] = own sample n < ${THIN_N}:`,
    ...(comboExitLines.length ? comboExitLines : ["//   (none — no combo reached the own-trades threshold)"]),
    `// ═════════════════════════════════════════════════════════════════════════════`,
    ``,
    `/** One interval's gate bar: PF >= MIN_PF AND expectancy > MIN_EXPECTANCY_PTS (pts/trade). */`,
    `export interface GateBar {`,
    `  MIN_PF: number;             // class must show profit factor >= this ...`,
    `  MIN_EXPECTANCY_PTS: number; // ... AND expectancy strictly > this (pts/trade)`,
    `}`,
    `export interface GateRule {`,
    `  /** PER-INTERVAL GATE BARS (user-chosen 2026-07-31 from the per-interval gate-bar menu,`,
    `   *  scripts/gate-bar-menu-by-interval.ts): every class and "<combo>@<interval>" verdict is`,
    `   *  judged at ITS OWN interval's bar; all-interval fallback combo verdicts are evaluated per`,
    `   *  CONSULTING interval (GateClassStat.allowedByInterval). */`,
    `  perInterval: Record<string, GateBar>;`,
    `  MIN_FACTS_OVERRIDE: number; // >= this many COUNTED facts bypasses the class gate`,
    `}`,
    `export interface GateClassStat {`,
    `  n: number;`,
    `  pf: number;`,
    `  expectancy: number;`,
    `  winRate: number;`,
    `  allowed: boolean;`,
    `  /** ALL-INTERVAL fallback combo entries only (PER-INTERVAL GATE BARS 2026-07-31): the`,
    `   *  verdict at EACH consulting interval's bar — comboGateAllows consults this map FIRST;`,
    `   *  the summary \`allowed\` (true when ANY interval's bar passes) is only the legacy`,
    `   *  fallback for configs predating this field. Carried (lowConfidence) entries replicate`,
    `   *  the carried verdict at every interval — thin data never flips at any bar. */`,
    `  allowedByInterval?: Record<string, boolean>;`,
    `  /** True when the verdict rests on a thin sample (n < 50 in the reporting window): the`,
    `   *  \`allowed\` flag is CARRIED FORWARD from the previous full-history verdict (see \`note\`)`,
    `   *  rather than judged on the thin window stats. */`,
    `  lowConfidence?: boolean;`,
    `  note?: string;`,
    `}`,
    `/** Monte-Carlo calibrated exit distances for one class (pts). TP2 stays 2 x TP1 (user rule);`,
    ` *  \`pool\` names the sample the calibration came from when the class itself had n < 100. */`,
    `export interface ClassExit {`,
    `  tp1: number;`,
    `  sl: number;`,
    `  n: number;`,
    `  pool: string;`,
    `  /** True when the class's own sample in the reporting window was n < 50 — the calibration`,
    `   *  rests on pooled/thin data; treat the exits with caution. */`,
    `  lowConfidence?: boolean;`,
    `}`,
    `export interface QualityGateData {`,
    `  generatedAt: string;`,
    `  source: string;`,
    `  rule: GateRule;`,
    `  multiFact: { n: number; pf: number; expectancy: number };`,
    `  classes: Record<string, GateClassStat>;`,
    `  exitByClass: Record<string, ClassExit>;`,
    `  /** COMBO GATE (2026-07-29): verdicts per canonical fact-FAMILY combination (comboKeyOf), at`,
    `   *  two granularities — "<combo>@<interval>" (needs n>=20 held-out class-gated rows) and`,
    `   *  "<combo>" all-interval fallback (needs n>=15). A combo key absent at BOTH granularities is`,
    `   *  never blocked (class gate alone governs — thin data blocks nothing). Optional so older`,
    `   *  synthetic/neutral configs stay valid. */`,
    `  comboClasses?: Record<string, GateClassStat>;`,
    `  /** PER-COMBO Monte-Carlo exits (2026-07-29 — "5m/15m fire only their most optimized trades"):`,
    `   *  calibrated TP1/SL for gate-ALLOWED fact combinations with enough of their own trades,`,
    `   *  keyed "<combo>@<interval>" ONLY (no all-interval fallback — exit distances are`,
    `   *  interval-scale-sensitive). Engine resolution priority: caller-explicit exit > combo exit >`,
    `   *  class exit > provisional; zone/yellowbox TP1 anchors keep their priority inside`,
    `   *  computeExit. zone-reaction + vector-side-entry are exempt (structural rules — class exits`,
    `   *  only). Optional so older synthetic/neutral configs stay valid. */`,
    `  exitByCombo?: Record<string, ClassExit>;`,
    `}`,
    ``,
    `export const QUALITY_GATE: QualityGateData = ${JSON.stringify(data, null, 2)};`,
    ``,
    `export function classKey(signalType: string, interval: string): string {`,
    `  return \`\${signalType}@\${interval}\`;`,
    `}`,
    ``,
    `/** The final firing filter. A blocked class emits NOTHING (not even a note).`,
    ` *  - >=3 counted agreeing facts always pass (any interval, any session);`,
    ` *  - a class absent from the stats map is never blocked (no data != bad data — this is what`,
    ` *    keeps zone-reaction and yellowbox-break, both structural zeros historically, alive). */`,
    `export function qualityGateAllows(`,
    `  signalType: string,`,
    `  interval: string,`,
    `  countedFacts: number,`,
    `  data: QualityGateData = QUALITY_GATE,`,
    `): boolean {`,
    `  if (countedFacts >= data.rule.MIN_FACTS_OVERRIDE) return true;`,
    `  const cls = data.classes[classKey(signalType, interval)];`,
    `  if (!cls) return true;`,
    `  return cls.allowed;`,
    `}`,
    ``,
    `// ── COMBO GATE (2026-07-29): only historically winning FACT COMBINATIONS may fire ────────────`,
    `/** Fact strategy → family code. The combo key is the sorted de-duplicated set of family codes`,
    ` *  over a signal's COUNTED facts (label-notes excluded — they are annotations, not evidence).`,
    ` *  backtestable:false facts (PML/TML live-only levels) are ALSO excluded: no backtest can ever`,
    ` *  judge a combo containing them, so live-only evidence must not move a signal into an`,
    ` *  unjudged combo class (it would silently bypass a blocked base combo). */`,
    `export const FACT_FAMILY: Record<string, string> = {`,
    `  vector: "Vec", yellowbox: "YB", ict: "ICT", fractal: "Fr",`,
    `  fractalGeo: "FG", footprint: "FP", zone: "Zone", moneyline: "ML",`,
    `};`,
    `/** Structural fact shape for combo-key computation (avoids importing the engine's Fact type —`,
    ` *  quality-gate.ts must stay import-free; fact-engine.ts imports THIS module). */`,
    `export interface ComboFactLike { strategy: string; counted: boolean; backtestable?: boolean }`,
    `/** Canonical combo key, e.g. "Fr+Vec+YB". Engine and harness MUST both use this helper —`,
    ` *  any drift in key construction silently desynchronizes live gating from the backtest. */`,
    `export function comboKeyOf(facts: ComboFactLike[]): string {`,
    `  const fams = new Set<string>();`,
    `  for (const f of facts) {`,
    `    if (!f.counted) continue;              // label-note facts never form the combo`,
    `    if (f.backtestable === false) continue; // live-only evidence (see FACT_FAMILY note)`,
    `    fams.add(FACT_FAMILY[f.strategy] ?? f.strategy);`,
    `  }`,
    `  return [...fams].sort().join("+");`,
    `}`,
    `/** The combo firing filter — consulted AFTER the class gate, and (unlike the class gate) it`,
    ` *  applies EVEN to >=3-counted-fact signals: the multi-fact override exists to admit rich`,
    ` *  confluence, but a combination that historically LOSES (e.g. Fr+ICT+Vec+YB, a 4-fact loser)`,
    ` *  must stay blocked regardless of fact count. Lookup: "<combo>@<interval>" first, then the`,
    ` *  all-interval "<combo>" — whose verdict is PER CONSULTING INTERVAL (allowedByInterval,`,
    ` *  per-interval gate bars 2026-07-31; the summary \`allowed\` covers older configs); absent at`,
    ` *  both granularities → allowed (thin data blocks nothing).`,
    ` *  Exemptions live in the engine: zone-reaction (strong milk-zone solo) and ETH solo`,
    ` *  vector-side-entry are structural rules with zero backtest data — never combo-gated. */`,
    `export function comboGateAllows(`,
    `  combo: string,`,
    `  interval: string,`,
    `  data: QualityGateData = QUALITY_GATE,`,
    `): boolean {`,
    `  const cc = data.comboClasses;`,
    `  if (!cc || !combo) return true;`,
    `  const atIv = cc[\`\${combo}@\${interval}\`];`,
    `  if (atIv) return atIv.allowed;`,
    `  const all = cc[combo];`,
    `  if (all) return all.allowedByInterval?.[interval] ?? all.allowed;`,
    `  return true;`,
    `}`,
    ``,
    `/** Monte-Carlo exit override for a class, or null to use the engine's provisional defaults. */`,
    `export function exitOverrideFor(`,
    `  signalType: string,`,
    `  interval: string,`,
    `  data: QualityGateData = QUALITY_GATE,`,
    `): ClassExit | null {`,
    `  return data.exitByClass[classKey(signalType, interval)] ?? null;`,
    `}`,
    ``,
    `/** PER-COMBO Monte-Carlo exit override ("<combo>@<interval>" only), or null when the combo has`,
    ` *  no calibration of its own — the class exit (exitOverrideFor) then governs. */`,
    `export function comboExitOverrideFor(`,
    `  combo: string,`,
    `  interval: string,`,
    `  data: QualityGateData = QUALITY_GATE,`,
    `): ClassExit | null {`,
    `  if (!combo) return null;`,
    `  return data.exitByCombo?.[\`\${combo}@\${interval}\`] ?? null;`,
    `}`,
    ``,
  );
  fs.writeFileSync(GATE_FILE, lines.join("\n"));
  console.log(`[fe-bt] regenerated ${GATE_FILE}  ${elapsed()}`);
}

// ==================== SOLO STRATEGY BACKTESTS (PHASE G — analysis only) ====================

function soloRowShell(
  entryTs: number, interval: Interval, direction: "Long" | "Short", entry: number,
  tp1: number, tp2: number, sl: number, signalType: string, strategy: string,
  fullLabel: string, why: string, exitStrategy: string, L: Loaded, nowSec: number,
): SigRow {
  const w = walkExit(entryTs, entry, direction === "Long", tp1, tp2, sl, L.c1m, L.t1m, L.lastDataTs, nowSec);
  const p = etParts(entryTs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const dateET = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  const sessionDay = sessionDayKey(entryTs);
  const yb = L.ybByKey.get(sessionDay);
  const inSession = yb != null && entryTs >= yb.session_start && entryTs <= yb.session_end;
  const fmtEt = (t: number): string => {
    const q = etParts(t);
    return `${q.y}-${pad(q.mo)}-${pad(q.d)} ${pad(q.hh)}:${pad(q.mm)}`;
  };
  return {
    fireTs: entryTs - INTERVAL_SEC[interval], entryTs, dateET,
    timeET: `${pad(p.hh)}:${pad(p.mm)}`,
    weekday: WEEKDAY_NAMES[weekdayOfKey(dateET)],
    sessionDay,
    session: isRTH(entryTs) ? "RTH" : "ETH",
    interval, direction, signalType,
    strategiesInvolved: strategy, factCount: 1,
    fullLabel, why, exitStrategy, anchor: "default",
    entry: rnd2(entry), tp1: rnd2(tp1), tp2: rnd2(tp2), sl: rnd2(sl),
    outcome: w.outcome, exitPrice: w.exitPrice == null ? null : rnd2(w.exitPrice), exitTs: w.exitTs,
    exitTimeET: w.exitTs == null ? "" : fmtEt(w.exitTs),
    pointsResult: w.exitPrice == null ? null : rnd2((w.exitPrice - entry) * (direction === "Long" ? 1 : -1)),
    mae: rnd2(w.mae), mfe: rnd2(w.mfe),
    barsToExit: w.exitTs == null ? null : Math.round(((w.exitTs - entryTs) / INTERVAL_SEC[interval]) * 100) / 100,
    yellowboxContext: !yb || !inSession ? "none" : entry > yb.box_top ? "above" : entry < yb.box_bottom ? "below" : "inside",
    distFromSettle: yb && inSession ? rnd2(entry - yb.settle) : null,
    year: p.y, confidence: 0, engineOutcome: "",
  };
}

/** Vector side-entries evaluated ALONE: every SE event, ANY session (RTH included — live needs
 *  confluence in RTH; this measures the raw strategy). Cooldown 4, 15:15 + break gates kept,
 *  fixed house exits 10/5/20 (uncalibrated — a common yardstick across the solo sheets). */
function soloVector(L: Loaded, nowSec: number): SigRow[] {
  const out: SigRow[] = [];
  for (const iv of INTERVALS) {
    const candles = L.candlesByIv[iv];
    const vecByTime = new Map(L.vectorByIv[iv].map(v => [v.time, v.value]));
    const barSec = INTERVAL_SEC[iv];
    let lastFire = -FACT_ENGINE_DEFAULTS.COOLDOWN_BARS - 1;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (c.time < L.emissionStartTs) continue;
      const closeTime = c.time + barSec;
      if (isMarketBreak(closeTime)) continue;
      const rth = isRTH(closeTime);
      if (rth && isAfter315ET(closeTime)) continue;
      if (vecByTime.get(c.time) == null) continue;
      const st = vectorStateAt(candles, vecByTime, i, FACT_ENGINE_DEFAULTS);
      const dir: "Long" | "Short" | null = st.sideEntryLong ? "Long" : st.sideEntryShort ? "Short" : null;
      if (!dir) continue;
      if (i - lastFire < FACT_ENGINE_DEFAULTS.COOLDOWN_BARS) continue;
      lastFire = i;
      const e = c.close;
      const tp1 = dir === "Long" ? e + 10 : e - 10;
      const tp2 = dir === "Long" ? e + 20 : e - 20;
      const sl = dir === "Long" ? e - 5 : e + 5;
      out.push(soloRowShell(closeTime, iv, dir, e, tp1, tp2, sl, "solo-vector", "vector",
        `Vector(${dir === "Long" ? "SE↑" : "SE↓"})`,
        `${iv} vector side-entry ${dir === "Long" ? "long" : "short"} — strategy evaluated alone (analysis only, not a live class)`,
        `TP1 10.00 (house default), SL 5.00 (house default), TP2 20.00 (2x TP1)`, L, nowSec));
    }
  }
  out.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  return out;
}

/** Yellow Box box-breaks evaluated ALONE (5m, RTH): the TRANSITION close from inside to outside
 *  the day's box. Exits = the strategy's own geometry (TP1 init level, SL opposite box edge). */
function soloYellowbox(L: Loaded, nowSec: number): SigRow[] {
  const out: SigRow[] = [];
  const dz = L.dayZones;
  const starts = dz.map(z => z.sessionStartTs);
  const zoneAt = (t: number): Loaded["dayZones"][number] | null => {
    const i = asOfIndex(starts, t);
    if (i < 0) return null;
    const z = dz[i];
    return t >= z.sessionStartTs && t <= z.sessionEndTs ? z : null;
  };
  const candles = L.candlesByIv["5m"];
  let lastFire = -FACT_ENGINE_DEFAULTS.COOLDOWN_BARS - 1;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (c.time < L.emissionStartTs) continue;
    const closeTime = c.time + 300;
    if (isMarketBreak(closeTime) || !isRTH(closeTime) || isAfter315ET(closeTime)) continue;
    const z = zoneAt(c.time);
    if (!z) continue;
    const prev = candles[i - 1];
    const prevInSession = prev.time >= z.sessionStartTs;
    const brokeUp = c.close > z.boxTop && (!prevInSession || prev.close <= z.boxTop);
    const brokeDn = c.close < z.boxBottom && (!prevInSession || prev.close >= z.boxBottom);
    if (!brokeUp && !brokeDn) continue;
    if (i - lastFire < FACT_ENGINE_DEFAULTS.COOLDOWN_BARS) continue;
    const dir: "Long" | "Short" = brokeUp ? "Long" : "Short";
    const e = c.close;
    const tp1 = dir === "Long" ? z.initRes : z.initSup;
    if ((dir === "Long" && tp1 <= e) || (dir === "Short" && tp1 >= e)) continue; // no room to the init level
    const d1 = Math.abs(tp1 - e);
    const tp2 = dir === "Long" ? e + d1 * 2 : e - d1 * 2;
    const sl = dir === "Long" ? z.boxBottom : z.boxTop;
    lastFire = i;
    out.push(soloRowShell(closeTime, "5m", dir, e, tp1, tp2, sl, "solo-yellowbox", "yellowbox",
      `Yellowbox(break${dir === "Long" ? "↑" : "↓"} @${(dir === "Long" ? z.boxTop : z.boxBottom).toFixed(2)})`,
      `5m close broke ${dir === "Long" ? "above" : "below"} the day's Yellow Box (${z.boxBottom.toFixed(2)}-${z.boxTop.toFixed(2)}) — strategy evaluated alone (analysis only)`,
      `TP1 ${d1.toFixed(2)} @ ${tp1.toFixed(2)} (Yellow Box init level), SL @ ${sl.toFixed(2)} (opposite box edge), TP2 ${(d1 * 2).toFixed(2)} (2x TP1)`, L, nowSec));
  }
  return out;
}

/** Footprint imbalance-zone touches evaluated ALONE (5m, RTH, its real coverage window):
 *  a bar whose close sits on/above a buy imbalance zone (support) or on/below a sell zone. */
function soloFootprint(L: Loaded, nowSec: number): SigRow[] {
  const out: SigRow[] = [];
  const candles = L.candlesByIv["5m"];
  let lastFire = -FACT_ENGINE_DEFAULTS.COOLDOWN_BARS - 1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.time < L.emissionStartTs) continue; // reporting window (2026-07-29: was missing — its siblings filter; invisible in the standing run since footprint data starts after the 3-mo window start, but window mode exposed pre-window rows)
    const zs = L.fpMap.get(c.time);
    if (!zs || !zs.length) continue;
    const closeTime = c.time + 300;
    if (isMarketBreak(closeTime) || !isRTH(closeTime) || isAfter315ET(closeTime)) continue;
    let long = false, short = false;
    let lvl = 0;
    for (const fz of zs) {
      const mid = (fz.startPrice + fz.endPrice) / 2;
      if (fz.direction === "buy" && mid <= c.close + 0.5) { long = true; lvl = mid; }
      else if (fz.direction === "sell" && mid >= c.close - 0.5) { short = true; lvl = mid; }
    }
    if (long === short) continue; // none or contradiction
    if (i - lastFire < FACT_ENGINE_DEFAULTS.COOLDOWN_BARS) continue;
    lastFire = i;
    const dir: "Long" | "Short" = long ? "Long" : "Short";
    const e = c.close;
    const tp1 = dir === "Long" ? e + 10 : e - 10;
    const tp2 = dir === "Long" ? e + 20 : e - 20;
    const sl = dir === "Long" ? e - 5 : e + 5;
    out.push(soloRowShell(closeTime, "5m", dir, e, tp1, tp2, sl, "solo-footprint", "footprint",
      `Footprint(${dir === "Long" ? "support" : "resistance"} @${lvl.toFixed(2)})`,
      `5m footprint imbalance ${dir === "Long" ? "support" : "resistance"} at ${lvl.toFixed(2)} — strategy evaluated alone (analysis only)`,
      `TP1 10.00 (house default), SL 5.00 (house default), TP2 20.00 (2x TP1)`, L, nowSec));
  }
  return out;
}

// ==================== MONTE-CARLO PNG CHARTS (PHASE H) ====================

const COL = {
  bg: [13, 17, 23] as RGB,
  text: [200, 205, 215] as RGB,
  dim: [130, 137, 150] as RGB,
  grid: [45, 51, 62] as RGB,
  up: [38, 166, 91] as RGB,
  dn: [239, 83, 80] as RGB,
  envUp: [16, 185, 129] as RGB,
  envDn: [244, 63, 94] as RGB,
  white: [235, 235, 235] as RGB,
  gold: [245, 217, 10] as RGB,
};

interface Panel { x0: number; y0: number; x1: number; y1: number; lo: number; hi: number; n: number }
function drawCandlePanel(
  r: Raster, x0: number, y0: number, x1: number, y1: number,
  candles: FiringCandle[], extraLevels: number[],
): Panel {
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
  for (const v of extraLevels) { if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  if (!isFinite(lo) || hi <= lo) { lo = 0; hi = 1; }
  const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
  const n = Math.max(1, candles.length);
  const py = (p: number): number => y1 - ((p - lo) / (hi - lo)) * (y1 - y0);
  const xw = (x1 - x0) / n;
  // grid + price labels
  for (let g = 0; g <= 5; g++) {
    const p = lo + ((hi - lo) * g) / 5;
    const y = Math.round(py(p));
    r.hLine(x0, x1, y, COL.grid, 1, 3, 5);
    r.text(x1 + 6, y - 3, p.toFixed(1), COL.dim, 1);
  }
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const cx = Math.round(x0 + i * xw + xw / 2);
    const col = c.close >= c.open ? COL.up : COL.dn;
    r.vLine(cx, Math.round(py(c.high)), Math.round(py(c.low)), col, 0.9);
    const bTop = py(Math.max(c.open, c.close)), bBot = py(Math.min(c.open, c.close));
    const bw = Math.max(1, Math.floor(xw) - 1);
    r.fillRect(cx - Math.floor(bw / 2), bTop, bw, Math.max(1, bBot - bTop), col);
  }
  // date labels (6 across)
  for (let g = 0; g <= 5; g++) {
    const i = Math.min(candles.length - 1, Math.round(((candles.length - 1) * g) / 5));
    if (i < 0) continue;
    const p = etParts(candles[i].time);
    const lbl = `${String(p.mo).padStart(2, "0")}/${String(p.d).padStart(2, "0")} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
    const x = Math.round(x0 + i * xw + xw / 2) - Math.floor(textWidth(lbl) / 2);
    r.text(Math.max(x0, Math.min(x1 - textWidth(lbl), x)), y1 + 6, lbl, COL.dim, 1);
  }
  return { x0, y0, x1, y1, lo, hi, n };
}
function panelY(p: Panel, price: number): number {
  return p.y1 - ((price - p.lo) / (p.hi - p.lo)) * (p.y1 - p.y0);
}
function drawArrowSimple(r: Raster, x: number, y: number, up: boolean, col: RGB): void {
  // 5-row triangle: apex at y, widening away from price.
  for (let k = 0; k < 5; k++) {
    const w = k;
    const yy = up ? y + k : y - k;
    r.hLine(x - w, x + w, yy, col, 1);
  }
}

function renderMcPng(
  iv: Interval, L: Loaded, rows: SigRow[], calibNote: string,
): Buffer {
  const W = 1400, H = 800;
  const r = new Raster(W, H, COL.bg);
  const winStart = L.lastDataTs - 30 * 86400;
  const title = `${iv.toUpperCase()} — QUALITY-GATED SIGNALS — LAST 30 DAYS (TOP, 60M CONTEXT) + RECENT DETAIL (BOTTOM, NATIVE ${iv.toUpperCase()} BARS)`;
  r.text(16, 12, title, COL.text, 2);
  r.text(16, 32, calibNote, COL.dim, 1);

  const ivRows = rows.filter(x => x.interval === iv && x.entryTs >= winStart);

  // ── TOP: 30-day overview on 60m context candles, every gated signal marked ──
  const ctx = L.candlesByIv["60m"].filter(c => c.time >= winStart);
  const pTop = drawCandlePanel(r, 60, 60, 1300, 360, ctx, ivRows.map(x => x.entry));
  const ctxTimes = ctx.map(c => c.time);
  for (const s of ivRows) {
    const i = asOfIndex(ctxTimes, s.fireTs);
    if (i < 0) continue;
    const x = Math.round(pTop.x0 + (i + 0.5) * ((pTop.x1 - pTop.x0) / pTop.n));
    const y = Math.round(panelY(pTop, s.entry));
    drawArrowSimple(r, x, s.direction === "Long" ? y + 6 : y - 6, s.direction === "Long", s.direction === "Long" ? COL.envUp : COL.envDn);
  }
  if (!ivRows.length) r.text(500, 200, "NO GATED SIGNALS IN THE LAST 30 DAYS", COL.dim, 2);
  r.text(60, 386, `${ivRows.length} GATED ${iv.toUpperCase()} SIGNALS IN THE LAST 30 DAYS (ARROW = ENTRY)`, COL.dim, 1);

  // ── BOTTOM: recent native bars with the full excursion envelope per signal ──
  const nDetail = 700;
  const native = L.candlesByIv[iv];
  const det = native.slice(Math.max(0, native.length - nDetail));
  const detStart = det.length ? det[0].time : 0;
  const detRows = rows.filter(x => x.interval === iv && x.fireTs >= detStart);
  const pBot = drawCandlePanel(r, 60, 420, 1300, 720, det,
    detRows.flatMap(x => [x.tp1, x.sl, x.entry]));
  const detTimes = det.map(c => c.time);
  const xOf = (i: number): number => Math.round(pBot.x0 + (i + 0.5) * ((pBot.x1 - pBot.x0) / pBot.n));
  for (const s of detRows) {
    const i0 = asOfIndex(detTimes, s.fireTs);
    if (i0 < 0) continue;
    const iExit = s.exitTs != null ? Math.max(i0 + 1, asOfIndex(detTimes, s.exitTs)) : Math.min(det.length - 1, i0 + 12);
    const xA = xOf(i0), xB = xOf(Math.min(det.length - 1, iExit));
    const yEntry = panelY(pBot, s.entry), yTp1 = panelY(pBot, s.tp1), ySl = panelY(pBot, s.sl), yTp2 = panelY(pBot, s.tp2);
    // Excursion envelope: how far we LET it run — TP band (to the calibrated TP1) and the
    // adverse allowance band (to the p85-MAE stop).
    r.fillRect(xA, Math.min(yEntry, yTp1), Math.max(2, xB - xA), Math.abs(yTp1 - yEntry), COL.envUp, 0.20);
    r.fillRect(xA, Math.min(yEntry, ySl), Math.max(2, xB - xA), Math.abs(ySl - yEntry), COL.envDn, 0.20);
    r.hLine(xA, xB, Math.round(yEntry), COL.white, 0.9, 4, 2);
    r.hLine(xA, xB, Math.round(yTp1), COL.envUp, 0.9);
    r.hLine(xA, xB, Math.round(ySl), COL.envDn, 0.9);
    if (yTp2 >= pBot.y0 && yTp2 <= pBot.y1) r.hLine(xA, xB, Math.round(yTp2), COL.envUp, 0.6, 2, 4);
    drawArrowSimple(r, xA, s.direction === "Long" ? Math.round(yEntry) + 6 : Math.round(yEntry) - 6, s.direction === "Long", s.direction === "Long" ? COL.envUp : COL.envDn);
  }
  if (!detRows.length) r.text(480, 560, "NO GATED SIGNALS IN THE DETAIL WINDOW", COL.dim, 2);
  const detSpan = det.length ? `${new Date(det[0].time * 1000).toISOString().slice(0, 10)} .. ${new Date(det[det.length - 1].time * 1000).toISOString().slice(0, 10)}` : "n/a";
  r.text(60, 745, `DETAIL: LAST ${det.length} NATIVE ${iv.toUpperCase()} BARS (${detSpan}) — ${detRows.length} SIGNALS`, COL.dim, 1);

  // Legend
  const ly = 758;
  r.fillRect(60, ly, 18, 10, COL.envUp, 0.35); r.text(84, ly + 1, "ROOM TO TP1 (MC-CALIBRATED TARGET BAND)", COL.text, 1);
  r.fillRect(420, ly, 18, 10, COL.envDn, 0.35); r.text(444, ly + 1, "ADVERSE ALLOWANCE (P85 MAE STOP BAND)", COL.text, 1);
  r.hLine(770, 788, ly + 5, COL.white, 0.9, 4, 2); r.text(796, ly + 1, "ENTRY", COL.text, 1);
  r.hLine(860, 878, ly + 5, COL.envUp, 0.6, 2, 4); r.text(886, ly + 1, "TP2 (2X TP1)", COL.text, 1);
  r.text(1000, ly + 1, "ARROW = ENTRY DIRECTION", COL.text, 1);
  return encodePNG(r);
}

// ==================== PER-TRADE CHART PNGs (PHASE H2) ====================
// One app-styled chart per gated trade (terminal theme), linked from the workbook's CHART
// column and embedded in-row for the most recent month on All Trades. Window: ~70 bars of the
// trade's own interval before entry -> ~40 bars after exit (clamped to data). ALL x-mapping is
// BAR-INDEX based within the window (the terminal-chart lesson: never linear-time extrapolation).

const TCOL = {
  bg: [5, 8, 13] as RGB,          // terminal theme
  up: [38, 166, 154] as RGB,      // #26a69a
  dn: [239, 83, 80] as RGB,       // #ef5350
  upDim: [22, 88, 82] as RGB,     // dim ETH variants
  dnDim: [124, 46, 44] as RGB,
  text: [200, 205, 215] as RGB,
  dim: [120, 128, 140] as RGB,
  grid: [36, 42, 52] as RGB,
  entry: [235, 235, 235] as RGB,
  tp: [16, 185, 129] as RGB,
  sl: [244, 63, 94] as RGB,
  gold: [245, 217, 10] as RGB,
  initRes: [239, 154, 154] as RGB,
  initSup: [165, 214, 167] as RGB,
  rth: [96, 165, 250] as RGB,
};

function renderTradePng(row: SigRow, L: Loaded, ivTimes: number[]): Buffer {
  const W = 800, H = 450;
  const r = new Raster(W, H, TCOL.bg);
  const candles = L.candlesByIv[row.interval];
  const barSec = INTERVAL_SEC[row.interval];

  // Window: 70 bars before the firing bar -> 40 bars after the exit bar (clamped).
  let iEntry = asOfIndex(ivTimes, row.fireTs);
  if (iEntry < 0) iEntry = 0;
  const iExit = row.exitTs != null ? Math.max(iEntry, asOfIndex(ivTimes, row.exitTs)) : iEntry;
  const i0 = Math.max(0, iEntry - 70);
  const i1 = Math.min(candles.length - 1, iExit + 40);
  const win = candles.slice(i0, i1 + 1);

  // Price range: window extremes + every trade level (entry/TP1/TP2/SL always visible).
  let lo = Infinity, hi = -Infinity;
  for (const c of win) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
  for (const v of [row.entry, row.tp1, row.tp2, row.sl]) { if (v == null) continue; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!isFinite(lo) || hi <= lo) { lo = row.entry - 10; hi = row.entry + 10; }
  const padP = (hi - lo) * 0.05; lo -= padP; hi += padP;

  const x0 = 10, x1 = 736, y0 = 44, y1 = 384;
  const n = Math.max(1, win.length);
  const xw = (x1 - x0) / n;
  const xOf = (i: number): number => Math.round(x0 + (i + 0.5) * xw);
  const py = (p: number): number => y1 - ((p - lo) / (hi - lo)) * (y1 - y0);
  const pyC = (p: number): number => Math.max(y0, Math.min(y1, py(p))); // clamped (bands)

  // Grid + price labels (right).
  for (let g = 0; g <= 5; g++) {
    const p = lo + ((hi - lo) * g) / 5;
    const y = Math.round(py(p));
    r.hLine(x0, x1, y, TCOL.grid, 1, 3, 5);
    r.text(x1 + 6, y - 3, p.toFixed(1), TCOL.dim, 1);
  }

  // Yellow Box band + init levels for the trade's session day (bar-index snapped, clamped).
  const yb = L.ybByKey.get(row.sessionDay);
  if (yb) {
    let sIdx = -1, eIdx = -1;
    for (let k = 0; k < win.length; k++) {
      const t = win[k].time;
      if (t >= yb.session_start && t <= yb.session_end) { if (sIdx < 0) sIdx = k; eIdx = k; }
    }
    if (sIdx >= 0) {
      const bx0 = xOf(sIdx) - Math.floor(xw / 2), bx1 = xOf(eIdx) + Math.floor(xw / 2);
      const yT = pyC(yb.box_top), yB = pyC(yb.box_bottom);
      if (yB > yT) r.fillRect(bx0, yT, bx1 - bx0, yB - yT, TCOL.gold, 0.07);
      if (py(yb.box_top) >= y0 && py(yb.box_top) <= y1) r.hLine(bx0, bx1, Math.round(py(yb.box_top)), TCOL.gold, 0.55);
      if (py(yb.box_bottom) >= y0 && py(yb.box_bottom) <= y1) r.hLine(bx0, bx1, Math.round(py(yb.box_bottom)), TCOL.gold, 0.55);
      if (py(yb.init_res) >= y0 && py(yb.init_res) <= y1) r.hLine(bx0, bx1, Math.round(py(yb.init_res)), TCOL.initRes, 0.7, 5, 3);
      if (py(yb.init_sup) >= y0 && py(yb.init_sup) <= y1) r.hLine(bx0, bx1, Math.round(py(yb.init_sup)), TCOL.initSup, 0.7, 5, 3);
    }
  }

  // RTH-open markers (ETH->RTH transition at bar CLOSE, matching the engine's session-at-close).
  for (let k = 1; k < win.length; k++) {
    if (isRTH(win[k].time + barSec) && !isRTH(win[k - 1].time + barSec)) {
      const x = xOf(k);
      r.vLine(x, y0, y1, TCOL.rth, 0.45, 4, 4);
      r.text(x + 3, y0 + 2, "RTH", TCOL.rth, 1, 0.8);
    }
  }

  // Candles — ETH bars use the dim variants (terminal convention).
  for (let k = 0; k < win.length; k++) {
    const c = win[k];
    const rth = isRTH(c.time + barSec);
    const col = c.close >= c.open ? (rth ? TCOL.up : TCOL.upDim) : (rth ? TCOL.dn : TCOL.dnDim);
    const cx = xOf(k);
    r.vLine(cx, Math.round(py(c.high)), Math.round(py(c.low)), col, 0.95);
    const bTop = py(Math.max(c.open, c.close)), bBot = py(Math.min(c.open, c.close));
    const bw = Math.max(1, Math.floor(xw) - 2);
    r.fillRect(cx - Math.floor(bw / 2), bTop, bw, Math.max(1, bBot - bTop), col);
  }

  // Trade levels: solid entry, dashed TP1/TP2/SL — full width with left tags.
  const level = (p: number, col: RGB, tag: string, dash: number): void => {
    const y = Math.round(py(p));
    if (y < y0 - 8 || y > y1 + 8) return;
    r.hLine(x0, x1, y, col, 0.9, dash, dash ? 3 : 0);
    r.text(x0 + 4, y - 9, `${tag} ${p.toFixed(2)}`, col, 1, 0.9);
  };
  if (row.tp2 != null) level(row.tp2, TCOL.tp, "TP2", 2); // TP1-only rows carry no TP2
  level(row.tp1, TCOL.tp, "TP1", 5);
  level(row.sl, TCOL.sl, "SL", 5);
  level(row.entry, TCOL.entry, "ENTRY", 0);

  // Entry arrow + exit marker.
  const xE = xOf(iEntry - i0);
  const yE = Math.round(py(row.entry));
  drawArrowSimple(r, xE, row.direction === "Long" ? yE + 7 : yE - 7, row.direction === "Long", row.direction === "Long" ? TCOL.tp : TCOL.sl);
  if (row.exitTs != null && row.exitPrice != null && iExit >= i0) {
    const xX = xOf(Math.min(win.length - 1, iExit - i0));
    const yX = Math.round(py(row.exitPrice));
    for (let d = -4; d <= 4; d++) { r.set(xX + d, yX + d, TCOL.entry, 1); r.set(xX + d, yX - d, TCOL.entry, 1); }
    const pnl = row.pointsResult == null ? "" : `${row.pointsResult >= 0 ? "+" : ""}${row.pointsResult.toFixed(2)}`;
    r.text(Math.min(xX + 8, x1 - 60), Math.max(y0 + 2, Math.min(y1 - 8, yX - 12)), `EXIT ${pnl}`, TCOL.entry, 1, 0.9);
  }

  // Title (two lines) + date labels + footer (WHY IT FIRED).
  const pnlStr = row.pointsResult == null ? "OPEN" : `${row.pointsResult >= 0 ? "+" : ""}${row.pointsResult.toFixed(2)} PTS`;
  r.text(10, 6, `${row.dateET} ${row.timeET} ET  ${row.interval.toUpperCase()}  ${row.direction.toUpperCase()}  ${pnlStr}`, TCOL.text, 2);
  r.text(10, 28, `${rowTypeDisplay(row.signalType).toUpperCase()}  |  ${OUTCOME_TXT[row.outcome]}`, TCOL.dim, 1);
  for (let g = 0; g <= 3; g++) {
    const i = Math.min(win.length - 1, Math.round(((win.length - 1) * g) / 3));
    if (i < 0) continue;
    const p = etParts(win[i].time);
    const lbl = `${String(p.mo).padStart(2, "0")}/${String(p.d).padStart(2, "0")} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
    const x = Math.max(x0, Math.min(x1 - textWidth(lbl), xOf(i) - Math.floor(textWidth(lbl) / 2)));
    r.text(x, y1 + 6, lbl, TCOL.dim, 1);
  }
  const why = `WHY: ${row.why}`.toUpperCase();
  const line1 = why.slice(0, 128);
  const line2 = why.length > 128 ? why.slice(128, 253) + (why.length > 253 ? "…" : "") : "";
  r.text(10, 404, line1, TCOL.dim, 1);
  if (line2) r.text(10, 415, line2, TCOL.dim, 1);
  return encodePNG(r);
}

/** Render one PNG per gated trade FROM THE COVERAGE WINDOW (dateET >= CHART_FROM_KEY) into
 *  trade-charts/<interval>/ and stamp row.chartPath. Older rows get chartPath cleared — their
 *  CHART cell renders "—" (user scope: charts for Mar 2026 -> present only). */
function renderAllTradeCharts(rows: SigRow[], L: Loaded): void {
  // BAXTER_ARTIFACTS_DIR (2026-08-02): charts live NEXT TO the workbook (relative links).
  const base = path.join(ARTIFACTS_DIR, "trade-charts");
  for (const iv of INTERVALS) fs.mkdirSync(path.join(base, iv), { recursive: true });
  const ivTimes = {} as Record<Interval, number[]>;
  for (const iv of INTERVALS) ivTimes[iv] = L.candlesByIv[iv].map(c => c.time);
  const toRender = rows.filter(r => r.dateET >= CHART_FROM_KEY).length;
  console.log(`[fe-bt] trade charts: coverage ${CHART_FROM_KEY} -> present = ${toRender} of ${rows.length} trades`);
  let total = 0, done = 0;
  const tStart = Date.now();
  rows.forEach((row, i) => {
    if (row.dateET < CHART_FROM_KEY) { delete row.chartPath; return; }
    const seq = String(i + 1).padStart(5, "0"); // matches the All Trades row number
    const fname = `${row.dateET}_${row.timeET.replace(":", "")}_${row.direction}_${seq}.png`;
    const rel = `trade-charts/${row.interval}/${fname}`;
    const buf = renderTradePng(row, L, ivTimes[row.interval]);
    fs.writeFileSync(path.join(ARTIFACTS_DIR, rel), buf);
    row.chartPath = rel;
    total += buf.length;
    if (++done % 100 === 0) console.log(`[fe-bt] trade charts: ${done}/${toRender} (${((Date.now() - tStart) / 1000).toFixed(0)}s)  ${elapsed()}`);
  });
  console.log(`[fe-bt] trade charts: ${done} PNGs, ${(total / 1e6).toFixed(1)} MB total  ${elapsed()}`);
}

// ==================== CONSOLE SUMMARY ====================

function printClassTable(label: string, rows: SigRow[]): void {
  console.log(`\n=== ${label} (${rows.length} signals) — NET = after ${FRICTION_PTS_PER_TRADE} pts/trade friction ===`);
  const line = (k: string, m: Metrics): void => {
    console.log(`  ${k.padEnd(26)} n=${String(m.count).padStart(6)} win%=${String(rnd2(m.winRate * 100)).padStart(5)} expcy=${String(m.expectancy).padStart(7)} cum=${String(m.cumPts).padStart(9)} PF=${String(m.profitFactor).padStart(6)} | NET expcy=${String(m.netExpectancy).padStart(7)} cum=${String(m.netCumPts).padStart(9)} PF=${String(m.netProfitFactor).padStart(6)}`);
  };
  const keys = [...new Set(rows.map(r => classKey(r.signalType, r.interval)))].sort();
  for (const k of keys) line(k, metricsOf(rows.filter(r => classKey(r.signalType, r.interval) === k)));
  line("TOTAL", metricsOf(rows));
}

// ==================== CSV ====================

const CSV_COLS = [
  "dateET", "timeET", "weekday", "session", "interval", "direction", "signalType",
  "strategiesInvolved", "factCount", "fullLabel", "why", "exitStrategy", "entry", "tp1", "tp2", "sl",
  "outcome", "exitPrice", "exitTimeET", "pointsResult", "netPointsResult", "MAE", "MFE", "barsToExit", "yellowboxContext", "distFromSettle",
  "shadowTags", // 2026-10-01 — appended LAST so positional readers of the older columns are unaffected
] as const;

function writeCsv(rows: SigRow[]): void {
  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLS.join(",")];
  for (const r of rows) {
    lines.push([
      r.dateET, r.timeET, r.weekday, r.session, r.interval, r.direction, r.signalType,
      r.strategiesInvolved, r.factCount, esc(r.fullLabel), esc(r.why), esc(r.exitStrategy),
      r.entry.toFixed(2), r.tp1.toFixed(2), r.tp2 == null ? "" : r.tp2.toFixed(2), r.sl.toFixed(2), r.outcome,
      r.exitPrice == null ? "" : r.exitPrice.toFixed(2), r.exitTimeET,
      r.pointsResult == null ? "" : r.pointsResult.toFixed(2),
      r.pointsResult == null ? "" : (r.pointsResult - FRICTION_PTS_PER_TRADE).toFixed(2), // NET of friction (2026-08-02)
      r.mae.toFixed(2), r.mfe.toFixed(2),
      r.barsToExit == null ? "" : r.barsToExit, r.yellowboxContext,
      r.distFromSettle == null ? "" : r.distFromSettle.toFixed(2),
      esc((r.shadowTags ?? []).join("|")),
    ].join(","));
  }
  fs.writeFileSync(OUT_CSV, lines.join("\n"));
}

// ==================== THE WORKBOOK (PHASE I) ====================

const FONT = { name: "Arial", size: 10 } as const;
const FONT_BOLD = { name: "Arial", size: 10, bold: true } as const;
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const SECTION_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
const FMT_COUNT = '#,##0;-#,##0;"-"';
const FMT_PTS = '+#,##0.00;(#,##0.00);"-"';
const FMT_PRICE = "0.00";
const FMT_PCT = '0.0%;-0.0%;"-"';
const FMT_NUM2 = '#,##0.00;(#,##0.00);"-"';
const FMT_PF = '0.00;-0.00;"-"';

/** Display name for a row's signal type — covers live classes AND the solo analysis types. */
function rowTypeDisplay(signalType: string): string {
  if (signalType === "solo-vector") return "Solo Vector (analysis)";
  if (signalType === "solo-yellowbox") return "Solo Yellow Box (analysis)";
  if (signalType === "solo-footprint") return "Solo Footprint (analysis)";
  return displaySignalType(signalType);
}
const OUTCOME_TXT: Record<Outcome, string> = {
  tp1: displayOutcome("tp1"), tp2: displayOutcome("tp2"), sl: displayOutcome("sl"),
  eod: displayOutcome("eod"), open: displayOutcome("open"),
};

interface TradeSheetOpts {
  title: string;
  note?: string;
  maxRows?: number;
  /** Add the CHART column: relative =HYPERLINK("trade-charts\…","VIEW CHART") per row. */
  chartLinks?: boolean;
  /** All-Trades only: ALSO embed the PNG in-row for trades with entryTs >= this (recent month). */
  embedFromTs?: number;
}

let LAST_EMBED_COUNT = 0; // reported by the All Trades build (recent-month in-row images)

function addTradeSheet(wb: ExcelJS.Workbook, name: string, rowsIn: SigRow[], opts: TradeSheetOpts): ExcelJS.Worksheet {
  let rows = rowsIn;
  let capNote = "";
  const cap = opts.maxRows ?? 100000;
  if (rows.length > cap) {
    capNote = ` SHOWING THE MOST RECENT ${cap.toLocaleString()} OF ${rows.length.toLocaleString()} TRADES (stats cover the SHOWN rows).`;
    rows = rows.slice(rows.length - cap);
  }
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 5 }] });
  const m = metricsOf(rows);
  const closed = m.count - m.open;

  const COLS: Array<{ h: string; w: number; fmt?: string; get: (r: SigRow, i: number) => string | number | null }> = [
    { h: "#", w: 7, fmt: "0", get: (_r, i) => i + 1 },
    { h: "date ET", w: 11, get: r => r.dateET },
    { h: "time ET", w: 8, get: r => r.timeET },
    { h: "weekday", w: 9, get: r => r.weekday },
    { h: "session", w: 8, get: r => r.session },
    { h: "interval", w: 8, get: r => r.interval },
    { h: "direction", w: 9, get: r => r.direction },
    { h: "signal type", w: 33, get: r => rowTypeDisplay(r.signalType) },
    { h: "WHY IT FIRED", w: 78, get: r => r.why },
    { h: "full fact label", w: 48, get: r => r.fullLabel },
    { h: "EXIT STRATEGY", w: 66, get: r => r.exitStrategy },
    { h: "entry", w: 9, fmt: FMT_PRICE, get: r => r.entry },
    { h: "tp1", w: 9, fmt: FMT_PRICE, get: r => r.tp1 },
    { h: "tp2", w: 9, fmt: FMT_PRICE, get: r => r.tp2 },
    { h: "sl", w: 9, fmt: FMT_PRICE, get: r => r.sl },
    { h: "WON?", w: 22, get: r => OUTCOME_TXT[r.outcome] },
    { h: "P&L points", w: 11, fmt: FMT_PTS, get: r => r.pointsResult },
    { h: "MAE", w: 8, fmt: FMT_NUM2, get: r => r.mae },
    { h: "MFE", w: 8, fmt: FMT_NUM2, get: r => r.mfe },
    { h: "bars to exit", w: 11, fmt: "#,##0.00", get: r => r.barsToExit },
    { h: "yellow box context", w: 16, get: r => r.yellowboxContext },
  ];
  if (opts.chartLinks) COLS.push({ h: "CHART", w: 13, get: () => null }); // value set per-row below (HYPERLINK)
  ws.columns = COLS.map(c => ({ width: c.w }));

  const HEADER_ROW = 5;
  const dataFrom = HEADER_ROW + 1;
  const lastRow = HEADER_ROW + rows.length;
  const colL = (n: number): string => { let s = ""; while (n > 0) { const md = (n - 1) % 26; s = String.fromCharCode(65 + md) + s; n = (n - md - 1) / 26; } return s; };
  const wonCol = colL(16), ptsCol = colL(17); // P, Q
  const range = (c: string): string => `$${c}$${dataFrom}:$${c}$${Math.max(dataFrom, lastRow)}`;

  // Title row
  {
    const row = ws.getRow(1);
    const cell = row.getCell(1);
    cell.value = opts.title + capNote;
    cell.font = { name: "Arial", size: 12, bold: true };
    for (let i = 1; i <= COLS.length; i++) row.getCell(i).fill = SECTION_FILL;
  }
  // Stats header block (labels row 2, values row 3 — real formulas with cached results)
  const statLabels = ["Trades", "Wins @T1", "Wins @T2", "Stopped out", "Session end", "Still open", "Win rate", "Expectancy pts", "Cum pts", "Profit factor", "Max DD pts*", "NET expcy pts*", "NET cum pts*", "NET PF*"];
  {
    const lr = ws.getRow(2);
    statLabels.forEach((h, i) => {
      const cell = lr.getCell(1 + i);
      cell.value = h;
      cell.font = { ...FONT_BOLD, color: { argb: "FFFFFFFF" } };
      cell.fill = HEADER_FILL;
    });
    const vr = ws.getRow(3);
    const put = (col: number, v: number, fmt: string, formula?: string): void => {
      const cell = vr.getCell(col);
      cell.value = formula ? ({ formula, result: v } as ExcelJS.CellFormulaValue) : v;
      cell.font = FONT; cell.numFmt = fmt;
    };
    const CF = (txt: string): string => `COUNTIFS(${range(wonCol)},"${txt}")`;
    const hasRows = rows.length > 0;
    put(1, m.count, FMT_COUNT, hasRows ? `COUNTIFS(${range("A")},">0")` : undefined);
    put(2, rows.filter(r => r.outcome === "tp1").length, FMT_COUNT, hasRows ? CF(OUTCOME_TXT.tp1) : undefined);
    put(3, rows.filter(r => r.outcome === "tp2").length, FMT_COUNT, hasRows ? CF(OUTCOME_TXT.tp2) : undefined);
    put(4, m.losses, FMT_COUNT, hasRows ? CF(OUTCOME_TXT.sl) : undefined);
    put(5, m.eod, FMT_COUNT, hasRows ? CF(OUTCOME_TXT.eod) : undefined);
    put(6, m.open, FMT_COUNT, hasRows ? CF(OUTCOME_TXT.open) : undefined);
    put(7, m.winRate, FMT_PCT, closed > 0 ? `(B3+C3)/(A3-F3)` : undefined);
    put(8, m.expectancy, FMT_PTS, closed > 0 ? `I3/(A3-F3)` : undefined);
    put(9, m.cumPts, FMT_PTS, hasRows ? `SUMIFS(${range(ptsCol)},${range(ptsCol)},"<>")` : undefined);
    const hasLoss = rows.some(r => (r.pointsResult ?? 0) < 0);
    put(10, m.profitFactor, FMT_PF, hasLoss ? `SUMIFS(${range(ptsCol)},${range(ptsCol)},">0")/-SUMIFS(${range(ptsCol)},${range(ptsCol)},"<0")` : undefined);
    put(11, m.maxDD, FMT_NUM2); // JS literal — sequencing not expressible in COUNTIFS/SUMIFS
    // NET-OF-FRICTION (2026-08-02, reporting-only): JS literals — the friction charge applies
    // per CLOSED trade, and the sheet's P&L column stays GROSS (the record), so these cannot
    // be simple SUMIFS over a column.
    put(12, m.netExpectancy, FMT_PTS);
    put(13, m.netCumPts, FMT_PTS);
    put(14, m.netProfitFactor, FMT_PF);
  }
  // Note row
  {
    const cell = ws.getRow(4).getCell(1);
    cell.value = (opts.note ?? "") + "  * Max DD pts is JS-computed over the sheet's chronological closed-trade sequence (running cum-points peak-to-trough) — not expressible with COUNTIFS/SUMIFS."
      + ` NET columns charge ${FRICTION_PTS_PER_TRADE} pts of friction per CLOSED trade (${FRICTION.pointsPerRoundTrip} pt slippage/spread round trip + 2 x $${FRICTION.commissionPerSideUsd} commission at $${FRICTION.mesPointValueUsd}/pt) — the P&L column itself stays gross (the record). See the README's FRICTION section.`;
    cell.font = { ...FONT, italic: true };
  }
  // Column header row
  {
    const hr = ws.getRow(HEADER_ROW);
    COLS.forEach((c, i) => {
      const cell = hr.getCell(i + 1);
      cell.value = c.h;
      cell.font = { ...FONT_BOLD, color: { argb: "FFFFFFFF" } };
      cell.fill = HEADER_FILL;
      cell.alignment = { vertical: "middle" };
    });
  }
  // Data
  const chartColIdx = opts.chartLinks ? COLS.length : 0; // 1-based (CHART is the last column)
  let embeds = 0;
  rows.forEach((r, i) => {
    const row = ws.getRow(dataFrom + i);
    COLS.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = c.get(r, i);
      cell.font = FONT;
      if (c.fmt) cell.numFmt = c.fmt;
    });
    // CHART hyperlink — RELATIVE path (backslashes for Excel) so it resolves as long as the
    // trade-charts folder sits next to the workbook. Rows outside the coverage window
    // (before CHART_FROM_KEY) show "—".
    if (opts.chartLinks) {
      const cell = row.getCell(chartColIdx);
      if (r.chartPath) {
        cell.value = {
          formula: `HYPERLINK("${r.chartPath.replace(/\//g, "\\")}","VIEW CHART")`,
          result: "VIEW CHART",
        } as ExcelJS.CellFormulaValue;
        cell.font = { ...FONT, color: { argb: "FF2E75B6" }, underline: true };
      } else {
        cell.value = "—";
        cell.font = { ...FONT, color: { argb: "FF9AA4B2" } };
        cell.alignment = { horizontal: "center" };
      }
    }
    // Recent-month in-row embed (All Trades only): the PNG itself, in a tall row at the far right.
    if (opts.embedFromTs != null && r.entryTs >= opts.embedFromTs && r.chartPath) {
      const abs = path.join(ARTIFACTS_DIR, r.chartPath); // charts sit next to the workbook (BAXTER_ARTIFACTS_DIR)
      if (fs.existsSync(abs)) {
        const imgId = wb.addImage({ buffer: fs.readFileSync(abs) as unknown as ExcelJS.Buffer, extension: "png" });
        ws.addImage(imgId, { tl: { col: COLS.length + 0.2, row: dataFrom + i - 1 }, ext: { width: 800, height: 450 } });
        row.height = 342; // 450 px ≈ 342 pt — row sized to the image
        embeds++;
      }
    }
  });
  if (opts.embedFromTs != null) {
    LAST_EMBED_COUNT = embeds;
    console.log(`[fe-bt] ${name}: embedded ${embeds} in-row trade charts (recent month)`);
  }
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: Math.max(HEADER_ROW, lastRow), column: COLS.length } };
  console.log(`[fe-bt] sheet built: ${name} (${rows.length} rows)  ${elapsed()}`); // workbook-phase progress (the 2026-07-15 "silent grind" was undiagnosable without this)
  return ws;
}

async function buildWorkbook(doc: ResultsDoc): Promise<void> {
  const { meta, signals: rows, solo, pngs } = doc;
  const wb = new ExcelJS.Workbook();
  wb.creator = "fact-engine-backtest";

  const orderedNames: string[] = [];

  // ── 1..5: All Trades + per-interval sheets ──
  addTradeSheet(wb, "All Trades", rows, {
    title: `ALL QUALITY-GATED TRADES — ${meta.symbol} — 3-MONTH WINDOW ${meta.windowFromKey} .. ${meta.windowToKey} — Monte-Carlo calibrated exits — ICT+fractal confirmations ON`,
    note: "REPORTING WINDOW: only trades entered in the last three months (earlier data is lookback only — user directive 2026-07-15). Every trade here passes the quality gate (classes passing PF>=1.05 & expectancy>0.1 over the window, plus any 3-fact setup; thin classes carry the previous verdict). Outcomes resolved on 1m bars under the official rules: first touch decides (stop-first on same-bar ambiguity); a Target-1 win upgrades to Target 2 only when 2x is reached with no stop touch in between; force-close at the 17:00 ET settle. CHART links open each trade's own image (keep the trade-charts folder next to this file); recent-month rows also carry the image in-row at the far right.",
    chartLinks: true,
    // In-row embeds cover the last WEEK only (2026-07-15: the 3-month window put ~900 trades in
    // the last month and exceljs ground >1h on that many in-row images — every trade still has
    // its VIEW CHART hyperlink; the in-row copy is a convenience for the freshest rows).
    embedFromTs: meta.lastDataTs - 7 * 86400,
  });
  orderedNames.push("All Trades");
  for (const iv of INTERVALS) {
    addTradeSheet(wb, iv, rows.filter(r => r.interval === iv), {
      title: `${iv.toUpperCase()} QUALITY-GATED TRADES — one signal stream, like a live chart on ${iv}`,
      note: iv === "60m" ? "The only 60m class passing the gate is the overnight Vector Side-Entry (plus any 3-fact setup)." : "",
      chartLinks: true,
    });
    orderedNames.push(iv);
  }

  // ── 6+: per-strategy sheets (data-driven from the gated set) ──
  const comboKeyOf = (r: SigRow): string => (r.signalType === "vector-side-entry" ? "__vse" : `combo:${r.strategiesInvolved}`);
  const comboKeys = [...new Set(rows.map(comboKeyOf))];
  comboKeys.sort((a, b) => rows.filter(r => comboKeyOf(r) === b).length - rows.filter(r => comboKeyOf(r) === a).length);
  const usedNames = new Set<string>();
  for (const ck of comboKeys) {
    const sub = rows.filter(r => comboKeyOf(r) === ck);
    let name: string;
    let title: string;
    if (ck === "__vse") {
      const ivs = [...new Set(sub.map(r => r.interval))].join("+");
      name = `Vector Side-Entry (${ivs} ETH)`;
      title = `VECTOR SIDE-ENTRY — overnight solo side-entries (${ivs}); the only side-entry class passing the quality gate`;
    } else {
      const combo = ck.slice(6);
      name = combo === "vector" ? "Vector Multi-Timeframe" : displayStrategyCombo(combo);
      title = combo === "vector"
        ? "VECTOR MULTI-TIMEFRAME — two or more timeframes' vector facts agreed (no other strategy involved)"
        : `${displayStrategyCombo(combo).toUpperCase()} — these strategies agreed on the same candle`;
    }
    name = name.slice(0, 31).replace(/[[\]*?/\\:]/g, "-").replace(/[\s.]+$/, "");
    // Collision de-dup with an INCREMENTING counter. The old `slice(0,29) + " 2"` looped
    // FOREVER on the third collision of one truncated prefix (slice+append reproduces the
    // existing " 2" name verbatim) — with "Fractal Geometry" in combo names, three combos
    // share the same 31-char prefix and the 2026-07-15 workbook runs spun for hours here.
    if (usedNames.has(name)) {
      const base = name.slice(0, 27).replace(/[\s.]+$/, "");
      for (let k = 2; usedNames.has(name); k++) name = `${base} ${k}`;
    }
    usedNames.add(name);
    addTradeSheet(wb, name, sub, { title, note: "Subset of the quality-gated trade set (same rules and exits as All Trades).", chartLinks: true });
    orderedNames.push(name);
  }

  // ── Solo sheets (analysis only) ──
  addTradeSheet(wb, "Solo Vector", solo.vector, {
    title: "SOLO VECTOR (ANALYSIS ONLY — NOT GATED, NOT LIVE): every side-entry on every interval, ANY session, fixed 10/5/20 exits",
    note: "Measures the raw side-entry strategy alone. Live rules require confluence during market hours; this sheet ignores that on purpose so the strategy's standalone merit is visible.",
  });
  orderedNames.push("Solo Vector");
  addTradeSheet(wb, "Solo Yellow Box", solo.yellowbox, {
    title: "SOLO YELLOW BOX (ANALYSIS ONLY): 5m closes breaking out of the day's box (market hours), TP1 = init level, SL = opposite box edge",
    note: "Transition-based: a break fires when the close crosses from inside to outside the box. Live solo box-breaks stay behind the Yellow-Box-solo setting (default off — historically -EV).",
  });
  orderedNames.push("Solo Yellow Box");
  {
    const ws = addTradeSheet(wb, "Solo Milk Zone", [], {
      title: "SOLO MILK ZONE (ANALYSIS ONLY): no historical zone uploads exist — structurally zero trades",
      note: "Milk zones are uploaded day by day and no upload history exists, so this backtest cannot contain a single zone trade. The table will populate as zones are uploaded going forward. This is a DATA gap, not a strategy verdict.",
    });
    ws.getRow(7).getCell(2).value = "No rows — see note above.";
    ws.getRow(7).getCell(2).font = { ...FONT, italic: true };
  }
  orderedNames.push("Solo Milk Zone");
  addTradeSheet(wb, "Solo Footprint", solo.footprint, {
    title: `SOLO FOOTPRINT (ANALYSIS ONLY): 5m imbalance-zone touches inside the real data window (${meta.coverage.footprint.split("(")[0].trim()}), fixed 10/5/20 exits`,
    note: "Footprint data exists only for the window above (5m). Live rules treat footprint as corroboration-only; this sheet trades it alone on purpose.",
  });
  orderedNames.push("Solo Footprint");

  // ── Monte Carlo sheet ──
  {
    const ws = wb.addWorksheet("Monte Carlo");
    ws.columns = [{ width: 34 }, { width: 16 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }];
    let rn = 1;
    const title = (t: string): void => {
      const row = ws.getRow(rn++);
      const cell = row.getCell(1);
      cell.value = t;
      cell.font = { name: "Arial", size: 12, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = HEADER_FILL;
      for (let i = 2; i <= 14; i++) row.getCell(i).fill = HEADER_FILL;
    };
    const kv = (k: string, v: string): void => {
      const row = ws.getRow(rn++);
      row.getCell(1).value = k; row.getCell(1).font = FONT_BOLD; row.getCell(1).alignment = { vertical: "top" };
      row.getCell(2).value = v; row.getCell(2).font = FONT; row.getCell(2).alignment = { wrapText: true, vertical: "top" };
      ws.mergeCells(rn - 1, 2, rn - 1, 14);
    };
    const headerRow = (labels: string[]): void => {
      const row = ws.getRow(rn++);
      labels.forEach((h, i) => {
        const cell = row.getCell(1 + i);
        cell.value = h;
        cell.font = { ...FONT_BOLD, color: { argb: "FFFFFFFF" } };
        cell.fill = HEADER_FILL;
      });
    };

    title("MONTE-CARLO EXIT CALIBRATION — METHODOLOGY");
    kv("Goal", "Replace the provisional one-size-fits-all exits (TP1 10 / SL 5) with per-class exits derived from how far winning trades actually run and how much heat they take on the way.");
    kv("Inputs", "The quality-gated signal set only. For every gated signal the full price path from entry to the 17:00 ET session settle was replayed on 1m bars, recording the running best-case excursion (MFE) and worst-case excursion (MAE) in points.");
    kv("Stop rule (user-dictated)", "SL = the 85th percentile MAE of TP1-WINNERS: among trades that reached the candidate target, how much heat did the 85% least-painful take first? The stop sits just past that.");
    kv("Target rule", "TP1 = grid search 4.00..30.00 pts (0.25 steps). For each candidate target: find its winners, set the stop at their p85 MAE (heat before the FIRST Target-1 touch — first touch locks the record), then simulate every signal in the class under the official outcome rules: stop-first on same-bar ambiguity; a Target-1 win pays DOUBLE when Target 2 (2x) is reached with no stop touch in between, and stays a Target-1 win otherwise — a stop touch after Target 1 never turns the win into a loss; no target hit and no stop = session-end result. The TP1 that maximizes expectancy wins. Candidates with fewer than 30 winners are skipped (a percentile over fewer is noise).");
    kv("Grid-edge caveat", "For the confluence classes the optimum landed NEAR THE TOP of the dictated 4..30 grid (~28-29.5 pts): historically these setups paid best when given lots of room, with more trades closing at session end instead of at a nearby target. The 30-pt cap is a house rule, not a data conclusion — the true optimum may sit beyond it. Win RATE drops under wide targets while expectancy rises; that trade-off is the deliberate choice here.");
    kv("TP2 rule (user-dictated)", "TP2 = 2 x TP1 distance, always.");
    kv("Pooling", "Classes with n >= 100 calibrate on their own signals. Below 100: all gated same-interval signals if that pool reaches 100; else the class's own signals if n >= 30 (cross-interval pooling mixes excursion scales — a 60m overnight trade breathes far more than a 1m scalp); else all gated signals. The 'calibration sample' column names what was actually used.");
    kv("Confidence intervals", "Bootstrap: each class's own signals resampled 1,000x (with replacement); the 2.5th and 97.5th percentile of the simulated expectancy give the 95% CI. Wide CI = thin sample = trust it less.");
    kv("Anchors still win", "Live exits still anchor TP1 to real obstacles when nearer than the calibrated default (milk-zone edge > Yellow Box init level > vector tabletop). The calibration replaces only the DEFAULT distances.");
    kv("Simulated vs realized", "'Sim expectancy' below uses the TP1/SL path model (no TP2, no anchors) — the quantity the grid optimized. 'Realized after' is the full final backtest (TP2, anchors, everything). They differ slightly by construction.");
    rn++;

    title("PER-CLASS CALIBRATION");
    headerRow(["class", "n (gated)", "calibration sample", "old TP1/SL", "MC SL (p85 MAE)", "MC TP1", "TP2 (2x)", "TP1-winners", "sim expcy", "95% CI low", "95% CI high", "realized before", "realized after", "PF before -> after"]);
    for (const c of meta.calibration) {
      const row = ws.getRow(rn++);
      const put = (col: number, v: string | number | null, fmt?: string): void => {
        const cell = row.getCell(col);
        cell.value = v; cell.font = FONT;
        if (fmt) cell.numFmt = fmt;
      };
      put(1, c.display);
      put(2, c.n, FMT_COUNT);
      put(3, `${c.pool} (n=${c.poolN})`);
      put(4, `${c.oldTp1}/${c.oldSl}`);
      put(5, c.sl, FMT_NUM2);
      put(6, c.tp1, FMT_NUM2);
      put(7, c.tp2, FMT_NUM2);
      put(8, c.winnersN, FMT_COUNT);
      put(9, c.simExp, FMT_PTS);
      put(10, c.ciLo, FMT_PTS);
      put(11, c.ciHi, FMT_PTS);
      put(12, c.expBefore, FMT_PTS);
      put(13, c.expAfter, FMT_PTS);
      put(14, `${c.pfBefore.toFixed(2)} -> ${c.pfAfter.toFixed(2)}`);
    }
    rn++;

    title("WINDOW EXCURSION PERCENTILES PER CLASS (points, entry -> session settle)");
    headerRow(["class", "n", "MAE p50", "MAE p75", "MAE p85", "MAE p90", "MAE p95", "MFE p50", "MFE p75", "MFE p85", "MFE p90", "MFE p95"]);
    for (const [cls, pc] of Object.entries(meta.percentiles)) {
      const row = ws.getRow(rn++);
      row.getCell(1).value = rowTypeDisplay(cls.split("@")[0]) + " @ " + cls.split("@")[1];
      row.getCell(1).font = FONT;
      row.getCell(2).value = pc.n; row.getCell(2).font = FONT; row.getCell(2).numFmt = FMT_COUNT;
      pc.mae.forEach((v, i) => { const cell = row.getCell(3 + i); cell.value = v; cell.font = FONT; cell.numFmt = FMT_NUM2; });
      pc.mfe.forEach((v, i) => { const cell = row.getCell(8 + i); cell.value = v; cell.font = FONT; cell.numFmt = FMT_NUM2; });
    }
    rn++;

    title("RECENT-MONTH CHARTS — every gated signal + its excursion envelope (per interval)");
    kv("How to read", "Top panel: the last 30 days on 60m context candles with every gated signal for that interval marked (arrow = entry, pointing in the trade direction). Bottom panel: the most recent native bars with each signal's envelope — green band = room we give it to TP1 (MC-calibrated), red band = adverse heat we tolerate before the p85-MAE stop, dashed white = entry, dashed green = TP2.");
    rn++;
    for (const iv of INTERVALS) {
      const b64 = pngs[iv];
      if (!b64) continue;
      const lbl = ws.getRow(rn).getCell(1);
      lbl.value = `${iv} — quality-gated signals, recent window`;
      lbl.font = FONT_BOLD;
      rn++;
      const imgId = wb.addImage({ buffer: Buffer.from(b64, "base64") as unknown as ExcelJS.Buffer, extension: "png" });
      ws.addImage(imgId, { tl: { col: 0, row: rn - 1 }, ext: { width: 1400, height: 800 } });
      rn += 42; // ~800px at default 19px row height, plus a gap
    }

    title("RECENT-MONTH SIGNAL DETAIL (the signals on the charts above)");
    headerRow(["date/time ET", "interval", "signal type", "direction", "entry", "TP1", "TP2", "SL", "MFE", "MAE", "bars to exit", "outcome", "P&L pts"]);
    const winStart = meta.lastDataTs - 30 * 86400;
    const recent = rows.filter(r => r.entryTs >= winStart);
    for (const r of recent) {
      const row = ws.getRow(rn++);
      const put = (col: number, v: string | number | null, fmt?: string): void => {
        const cell = row.getCell(col);
        cell.value = v; cell.font = FONT;
        if (fmt) cell.numFmt = fmt;
      };
      put(1, `${r.dateET} ${r.timeET}`);
      put(2, r.interval);
      put(3, rowTypeDisplay(r.signalType));
      put(4, r.direction);
      put(5, r.entry, FMT_PRICE);
      put(6, r.tp1, FMT_PRICE);
      put(7, r.tp2, FMT_PRICE);
      put(8, r.sl, FMT_PRICE);
      put(9, r.mfe, FMT_NUM2);
      put(10, r.mae, FMT_NUM2);
      put(11, r.barsToExit, "#,##0.00");
      put(12, OUTCOME_TXT[r.outcome]);
      put(13, r.pointsResult, FMT_PTS);
    }
  }
  orderedNames.push("Monte Carlo");

  // ── Sheet 0: README (created last, ordered first) ──
  buildReadme(wb, doc);
  const finalOrder = ["README", ...orderedNames];
  finalOrder.forEach((name, i) => {
    const ws = wb.getWorksheet(name);
    if (ws) (ws as ExcelJS.Worksheet & { orderNo: number }).orderNo = i; // undocumented but honored by exceljs
  });

  // EBUSY resilience: the canonical file is often OPEN IN EXCEL (it locks the path). Fall back
  // to <name>.new.xlsx so the run never loses the build; swap it over once Excel lets go.
  console.log(`[fe-bt] workbook assembled (${wb.worksheets.length} sheets) — writing ${path.basename(OUT_XLSX)}  ${elapsed()}`);
  try {
    await wb.xlsx.writeFile(OUT_XLSX);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EPERM") throw e;
    const fallback = OUT_XLSX.replace(/\.xlsx$/i, ".new.xlsx");
    console.error(`[fe-bt] !! ${path.basename(OUT_XLSX)} is locked (open in Excel?) — writing ${path.basename(fallback)} instead. Close Excel and rename it over the old file.`);
    await wb.xlsx.writeFile(fallback);
  }
}

function buildReadme(wb: ExcelJS.Workbook, doc: ResultsDoc): void {
  const { meta, signals: rows, solo } = doc;
  const ws = wb.addWorksheet("README", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [{ width: 34 }, { width: 160 }];
  let rn = 1;
  const title = (t: string): void => {
    const row = ws.getRow(rn++);
    const cell = row.getCell(1);
    cell.value = t;
    cell.font = { name: "Arial", size: 12, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    row.getCell(2).fill = HEADER_FILL;
  };
  const kv = (k: string, v: string): void => {
    const row = ws.getRow(rn++);
    row.getCell(1).value = k; row.getCell(1).font = FONT_BOLD;
    row.getCell(1).alignment = { vertical: "top" };
    row.getCell(2).value = v; row.getCell(2).font = FONT;
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  };
  const gap = (): void => { rn++; };

  title("QUALITY OVER QUANTITY — WHAT THIS WORKBOOK IS");
  kv("REPORTING WINDOW", `${meta.windowFromKey} .. ${meta.windowToKey} — THE LAST THREE MONTHS ONLY (user directive 2026-07-15, standing). Every count, stat and trade in this workbook covers trades ENTERED inside this window; earlier bars were loaded only as lookback (50-day Yellow Box derivation, vector warmup, ICT/fractal context). Do NOT compare these numbers against older full-history workbooks.`);
  kv("The directive", "\"I don't need a million trades, I need trades that will win — only take trades you're confident should win.\" This workbook is the window backtest AFTER that filter: every trade here belongs to a setup class that made money over the window (or carries a previous full-history verdict when the window sample is too thin to judge), with exits calibrated to how those classes actually move.");
  kv("Generated", `${meta.generatedAt} by scripts/fact-engine-backtest.ts (runtime ${meta.runtimeSec}s, symbol ${meta.symbol})`);
  kv("Decision model", "shared/fact-engine.ts — the IDENTICAL module the live chart runs, including this quality gate, these calibrated exits, and the new ICT + fractal confirmation facts (all live defaults). Live and backtest cannot diverge.");
  kv("Headline", `${meta.ungatedTotal.toLocaleString()} raw signals in the window -> ${meta.gatedTotal.toLocaleString()} quality-gated trades (${(100 * meta.gatedTotal / Math.max(1, meta.ungatedTotal)).toFixed(1)}% kept). Net of friction: ${meta.beforeAfter.after.netExpectancy >= 0 ? "+" : ""}${meta.beforeAfter.after.netExpectancy} pts/trade, PF ${meta.beforeAfter.after.netPf}, cum ${meta.beforeAfter.after.netCumPts} pts (see FRICTION below).`);
  gap();

  title("FRICTION — WHAT THE NET COLUMNS MEAN (2026-08-02, reporting-only)");
  kv("The model", `Every CLOSED trade is charged ${meta.friction.ptsPerTrade} points of friction: ${meta.friction.pointsPerRoundTrip} pt = one tick (0.25) of slippage/spread allowance on EACH side of the round trip (the record fills AT the level; real fills pay the spread), plus 2 x $${meta.friction.commissionPerSideUsd} commission/fees at $${meta.friction.mesPointValueUsd}/pt (MES). Named constants in scripts/fact-engine-backtest.ts (FRICTION) — settings exposure planned.`);
  kv("Where it shows", "Every stats header row now carries NET expectancy / NET cum / NET PF alongside the gross numbers; the CSV carries a netPointsResult column; the gate-bar menu JSONs carry net columns per rung. The per-trade P&L column itself stays GROSS — it is the record.");
  kv("THE GATE STILL JUDGES GROSS", "Deliberate and documented (changing the verdict basis silently is out of scope): class/combo verdicts and the Monte-Carlo exits are derived on gross points, exactly as before. The FRICTION AUDIT below shows every allowed class/combo that would FAIL its bar net-of-friction — marginal survivors you should treat with caution. Whether the bar itself should move to net accounting is a user decision.");
  if (!meta.frictionAudit.length) {
    kv("Friction audit", "CLEAN — every gate-allowed class and combo also clears its bar net of friction.");
  } else {
    for (const a of meta.frictionAudit) {
      kv(`Friction audit: ${a.key}`, `${a.kind}, bar ${a.bar}, held-out n=${a.n}: gross PF ${a.grossPf} / ${a.grossExp >= 0 ? "+" : ""}${a.grossExp} pts CLEARS the bar, but NET PF ${a.netPf} / ${a.netExp >= 0 ? "+" : ""}${a.netExp} pts FAILS it${a.carried ? " (carried verdict — thin fresh sample)" : ""}. It still fires live (gate judges gross); treat it as a marginal setup.`);
    }
  }
  gap();

  title("DAILY LOSS STOP (2026-08-02 — engine-enforced, simulated here day-sequentially)");
  kv("The rule", `Once TODAY's realized signal P&L reaches -${meta.dailyLossStop.stopPts} points, the engine fires NOTHING for the rest of the session; it resumes next session (Globex day, 18:00 ET roll). Live, the check runs on the served rows' closed points PLUS the open-trade mark, sticky once tripped. Settings: market page -> Chart Settings -> Risk Controls (default ON at ${meta.dailyLossStop.stopPts}).`);
  kv("Where the default comes from", meta.dailyLossStop.derivation);
  kv("Simulated in this workbook", `The trade set here is the AS-TRADED set: the same rule applied day-sequentially over resolved exits (a candidate is suppressed when the day's realized P&L at its entry time had already breached the stop; once tripped, the whole rest of the day is suppressed). This window: ${meta.dailyLossStop.trippedDays.length} tripped day(s)${meta.dailyLossStop.trippedDays.length ? ` (${meta.dailyLossStop.trippedDays.join(", ")})` : ""}, ${meta.dailyLossStop.suppressedTrades} trade(s) suppressed. HONESTY NOTE: live also counts the open-trade mark, so live can only trip EARLIER — this simulation is the optimistic bound. Gate verdicts / MC exits were derived on the pre-stop population (the stop cuts tail DAYS, not setup quality).`);
  gap();

  title("DEAD-TAPE SUPPRESSION (2026-08-02 — measured rule promoted to enforcement)");
  kv("The rule", `A would-be fire while the session day's realized range so far is under ${meta.deadTape.mult} x the window's median session-day range is suppressed — measured 5.6% win rate on the gated window (n=18, thin but one-sided; corroborated at n=182 ungated where it was the worst regime tier). NOTHING is exempt — the data killed every class and session. Escape hatch: Risk Controls -> Dead-tape suppression OFF restores the old warning-badge-only behavior.`);
  kv("Measured effect this run", meta.deadTape.suppressedVsFinal === 0
    ? "ZERO fires suppressed vs a diagnostic pass without the rule — at this elite gate the surviving setups simply never fire on dead tape (said honestly: the rule changed nothing here; it remains armed for regimes where it would)."
    : `${meta.deadTape.suppressedVsFinal} would-be fire(s) suppressed vs a diagnostic pass without the rule (${Object.entries(meta.deadTape.suppressedByInterval).map(([iv, n]) => `${iv}: ${n}`).join(", ")}). Because the rule runs INSIDE the engine, gate evidence bases and exits were derived under it.`);
  gap();

  title("POSITION SIZING BY COMBO TIER (2026-08-02 — display/config-only)");
  kv("The rule", "Every signal now carries suggestedContracts: 2 when its fact-combination's held-out record is PROVEN (PF >= 1.3 on an adequate sample), 1 otherwise. Shown in the signal detail's RISK PROFILE and on Discord alerts; persisted per row (suggested_contracts).");
  kv("AUTO-TRADE IS UNCHANGED BY DEFAULT", "Orders keep using the user's 'Contracts per trade' setting. ONLY the explicit opt-in 'Size by combo tier' (market page -> Auto Trade, default OFF) makes orders use the suggested size — and it is per-order and server-verified. Nothing autonomous changed.");
  gap();

  title("ICT + FRACTAL CONFIRMATIONS — WHAT CHANGED (same window, old engine vs new)");
  kv("What they are", "ICT concepts (liquidity sweeps, order blocks, breakers, fair value gaps) and fractal-probability concepts (Williams fractal breakouts, chaos bands, chaos oscillator) now run as CONFIRMATION FACTS in the engine — never standalone strategies. They count toward the 2-agreeing-facts requirement but a signal still needs one of your core drivers (side-entry, zone reaction, Yellow Box break). Chop states (flat chaos bands, |FCO| <= 0.25) actively argue AGAINST breakout-type signals at weight 1 each.");
  {
    const ba = meta.beforeAfter;
    kv("Old engine (this window)", `${ba.before.trades.toLocaleString()} trades, expectancy ${ba.before.expectancy >= 0 ? "+" : ""}${ba.before.expectancy} pts/trade, PF ${ba.before.pf}, win rate ${ba.before.winRate}%, cum ${ba.before.cumPts} pts (previous gate + exits, confirmations OFF — exactly what was live before this change).`);
    kv("New engine (this window)", `${ba.after.trades.toLocaleString()} trades, expectancy ${ba.after.expectancy >= 0 ? "+" : ""}${ba.after.expectancy} pts/trade, PF ${ba.after.pf}, win rate ${ba.after.winRate}%, cum ${ba.after.cumPts} pts (new gate + exits, ICT + fractal confirmations ON).`);
    kv("Newly fired", `${ba.newlyFiredTotal.toLocaleString()} trades fire now that the old engine did not — ${ba.newlyFiredWithCorroborators.toLocaleString()} of them carry an ICT/fractal confirmation fact (corroborator support completing the confluence or the 3-fact override).`);
    kv("No longer fired", `${ba.droppedVsBefore.toLocaleString()} old-engine trades no longer fire (regenerated gate verdicts, contradiction weighing, chop rule, cooldown knock-ons).`);
    kv("Suppressed by chop", `${ba.suppressedByChop.toLocaleString()} would-be signals were suppressed by the chop-contradiction rule (measured by a diagnostic pass with ONLY that rule disabled).`);
    kv("Confirmation coverage", `${ba.corroboratedTrades.toLocaleString()} of the ${ba.after.trades.toLocaleString()} final trades (${ba.corroboratedSharePct}%) carry at least one ICT or fractal confirmation fact in their WHY column.`);
  }
  gap();

  title("FRACTAL-GEOMETRY GUIDE CONFIRMATIONS (added 2026-07-15 — this run's BEFORE excludes only these)");
  kv("Where they come from", "The Fractal Exchange guides studied 2026-07-15 (the Fractals Geometry Guide, the Ultimate Vector Guide, the wave-analysis / open-states / percent-band video workshops), translated into mechanical checks against the vector line. Confirmation facts ONLY — same contract as ICT/fractal: they complete confluence but can never fire alone.");
  kv("The five confirmation facts", "VECTOR RECLAIM (a failed break snapping back across the vector — the guides' counter-trend reversal / 'ghost'); FLAT-VECTOR BOUNCE (price testing a flattened vector and holding — their 'side exit' / 'table top'); COMPRESSION BREAKOUT (3+ progressively shallower pullbacks resolving with a range break); WAVE HAS ROOM TO RUN (the current move away from the vector is smaller than the median of past moves); CROSS OF YESTERDAY'S CLOSES (a close through both of the prior day's closing levels — the 4 PM cash close and 5 PM futures close, the 'E/S vector' pair drawn nightly on the reference charts).");
  kv("The two warnings", "VECTOR CHASE (the vector adjusting against price — price tends to get pulled back to it) argues against breakout-type signals; WAVE EXHAUSTION (the current move stretched beyond ~80% of past moves — the guides' tail-band fade) argues against entering WITH the move for every driver type. Both weigh 1 point of contradiction, like the chop rule.");
  for (const f of meta.fgFactStats) {
    kv(f.display, f.trades === 0
      ? "0 final trades carry this fact in the window."
      : `${f.trades.toLocaleString()} final trades carry this fact — win rate ${f.winRatePct}%, ${f.expectancy >= 0 ? "+" : ""}${f.expectancy} pts/trade. (Trades can carry several facts; rows overlap across this list.)`);
  }
  kv("PML / TML excluded (honesty note)", "The guides' Peak/Trough Money Lines are derived from LIVE options-chain exposure (open interest + volume). NO historical options data exists, so they are implemented live-only: reference lines on the terminal + live-edge confirmation facts explicitly marked backtestable:false. This backtest contains ZERO PML/TML influence by construction — they are forward-test only.");
  gap();

  title("THE QUALITY GATE — WHAT FIRES AND WHAT IS BLOCKED, AND WHY");
  kv("The rule", `PER-INTERVAL GATE BARS (user-chosen 2026-07-31 from the per-interval gate-bar menu): a setup class (signal type x chart interval) may fire only if its record over the ${meta.windowFromKey}..${meta.windowToKey} window clears ITS OWN interval's bar — ${Object.entries(meta.gateRule.perInterval).map(([iv, b]) => `${iv}: profit factor >= ${b.MIN_PF} and > ${b.MIN_EXPECTANCY_PTS} pts/trade`).join("; ")}. Plus: any signal with ${meta.gateRule.MIN_FACTS_OVERRIDE}+ agreeing facts fires anywhere (that pool: ${meta.multiFact.n} trades, PF ${meta.multiFact.pf}, ${meta.multiFact.expectancy} pts/trade). STATISTICAL HONESTY: a class with fewer than 50 window trades is too thin to judge — its verdict is CARRIED FORWARD from the previous full-history gate and marked below.`);
  for (const [cls, c] of Object.entries(meta.gateClasses)) {
    const [st, iv] = cls.split("@");
    const verdict = c.lowConfidence
      ? `${c.allowed ? "FIRES LIVE" : "BLOCKED"} — LOW CONFIDENCE: ${c.note ?? "thin window sample"}`
      : (c.allowed ? "FIRES LIVE" : "BLOCKED (fails the bar — these trades churned commissions without making money)");
    kv(`${displaySignalType(st)} @ ${iv}`, `${c.n.toLocaleString()} window trades, profit factor ${c.pf}, ${c.expectancy >= 0 ? "+" : ""}${c.expectancy} pts/trade, win rate ${(c.winRate * 100).toFixed(1)}% -> ${verdict}`);
  }
  kv("GATE vs CALIBRATED EXITS — a tension to understand", "The gate judges each class on the UNGATED baseline with PROVISIONAL 10/5 exits (deliberate: judging on this run's own calibrated exits would let the calibration vote for itself — a self-referencing loop this pipeline explicitly guards against). Consequence in this window: the 5m and 15m confluence classes miss the bar on provisional exits (PF 1.04 / 0.96) and are BLOCKED as 2-fact setups — yet the trades those classes DO still contribute (every 3-plus-fact signal fires through the override) run strongly positive once the Monte-Carlo exits apply (5m: +1.70 pts/trade, PF 1.26, n=347; 15m: +1.78, PF 1.37, n=147). Read it this way: on 5m/15m the engine currently demands the HIGHER conviction bar (3 agreeing facts), and at that bar the classes make good money. If a future run shows the same pattern persistently, the ordering question (gate first vs calibrate first) deserves a revisit — but flipping it inside one run would let this run's exits justify this run's gate.");
  kv("Never blocked (no data)", "Milk Zone Reaction (no uploaded-zone history exists — structurally zero trades, a data gap not a verdict) and Yellow Box Break (solo box-breaks only exist behind the explicit Yellow-Box-solo setting, default off). Blocking a class we've never seen trade would silently dead-end those features.");
  kv("Escape hatch", "A single engine setting (qualityGateEnabled, default ON) can switch the gate off — wired through the app but deliberately not exposed in the UI yet.");
  gap();

  title("THE COMBO GATE (2026-07-29) — ONLY HISTORICALLY WINNING FACT COMBINATIONS");
  kv("The idea", "On top of the class gate, each signal's set of agreeing fact FAMILIES forms a combination key — Vec (vector), YB (Yellow Box), ICT, Fr (fractal indicators), FG (fractal geometry), FP (footprint), Zone (milk zones). Combinations that historically LOSE are blocked, even when they carry 3+ agreeing facts (the multi-fact override bypasses the class gate only — a 4-fact combination that loses money stays blocked). Combinations judged per interval when the sample allows (n >= 20 held-out class-gated trades) at THAT interval's gate bar, falling back to the all-interval combination (n >= 15) — whose verdict is evaluated at the bar of the interval CONSULTING it, so the same fallback record can fire on 60m yet stay blocked on 1m; a combination too thin to judge is NEVER blocked. Strong milk-zone solos and overnight solo side-entries are structural rules and stay exempt.");
  {
    const entries = Object.entries(meta.comboClasses).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) kv("Verdicts", "none derived this run (all combinations too thin) — the class gate alone governs.");
    for (const [key, c] of entries) {
      const perIv = c.allowedByInterval
        ? `PER CONSULTING INTERVAL: ${Object.entries(c.allowedByInterval).map(([iv, a]) => `${iv} ${a ? "FIRES" : "blocked"}`).join(", ")}`
        : null;
      const verdict = c.lowConfidence
        ? `${perIv ?? (c.allowed ? "FIRES LIVE" : "BLOCKED")} — LOW CONFIDENCE: ${c.note ?? "thin held-out sample, verdict carried forward"}`
        : (perIv ?? (c.allowed ? "FIRES LIVE" : "BLOCKED (this combination lost money over the held-out half)"));
      kv(key, `${c.n.toLocaleString()} held-out trades, profit factor ${c.pf}, ${c.expectancy >= 0 ? "+" : ""}${c.expectancy} pts/trade, win rate ${(c.winRate * 100).toFixed(1)}% -> ${verdict}`);
    }
    const ce = meta.comboEffect;
    kv("Measured effect (this window)", `a diagnostic pass with only the combination verdicts removed takes ${ce.diag.trades.toLocaleString()} trades (expectancy ${ce.diag.expectancy >= 0 ? "+" : ""}${ce.diag.expectancy}, PF ${ce.diag.pf}) vs ${meta.beforeAfter.after.trades.toLocaleString()} in the final set — ${ce.suppressedTrades.toLocaleString()} trades suppressed by the combo gate${ce.suppressedByCombo.length ? ` (${ce.suppressedByCombo.map(x => `${x.key}: ${x.n}`).join("; ")})` : ""}.`);
  }
  gap();

  title("MONTE-CARLO EXITS (full methodology on the Monte Carlo sheet)");
  kv("Stop", "p85 MAE of TP1-winners — the stop sits just beyond the heat 85% of winning trades took before paying out.");
  kv("Target", "TP1 = the grid-searched (4..30 pts) target that maximizes expectancy against that stop, per class. TP2 = 2 x TP1 (house rule). Real obstacles (milk-zone edge, Yellow Box init level, vector tabletop) still cap TP1 when nearer.");
  for (const c of meta.calibration) {
    const thin = c.n < THIN_N ? " LOW CONFIDENCE: the class's own window sample is under 50 trades — the calibration leans on the pooled sample; treat these exits with caution." : "";
    kv(c.display, `TP1 ${c.tp1} / SL ${c.sl} / TP2 ${c.tp2} (was 10/5/20). Expectancy ${c.expBefore >= 0 ? "+" : ""}${c.expBefore} -> ${c.expAfter >= 0 ? "+" : ""}${c.expAfter} pts/trade, PF ${c.pfBefore} -> ${c.pfAfter}. Calibrated on ${c.pool} (n=${c.poolN}); bootstrap 95% CI on expectancy [${c.ciLo}, ${c.ciHi}].${thin}`);
  }
  gap();

  title("PER-COMBINATION EXITS (2026-07-29 — winning combinations carry their own calibration)");
  kv("The idea", `A winning fact COMBINATION (say footprint + fractal + vector + Yellow Box on the 5m) trades its own geometry, not the class blend. Combinations the gate allows with >= ${COMBO_EXIT_MIN_OWN_N} of their own trades in the gated window get their OWN grid-searched TP1/SL (same method as the class exits); ${COMBO_EXIT_MIN_POOLED_N}..${COMBO_EXIT_MIN_OWN_N - 1} own trades borrow the same-interval pool; anything thinner keeps the class exits. The engine resolves exits combo-first: real obstacles (milk-zone edge / Yellow Box init level / tabletop) still cap TP1 when nearer, then the combination's exits, then the class's, then the provisional 10/5. Overnight solo side-entries and milk-zone solos always use their class exits (structural rules).`);
  if (!meta.comboCalibration.length) kv("Calibrations", `none this run — no allowed combination reached the ${COMBO_EXIT_MIN_POOLED_N}-own-trades floor; every combination trades its class exits.`);
  for (const cc of meta.comboCalibration) {
    const thin = cc.n < THIN_N ? " LOW CONFIDENCE: under 50 own trades." : "";
    kv(cc.key, `TP1 ${cc.tp1} / SL ${cc.sl} / TP2 ${cc.tp2} (class exit: ${cc.clsTp1 ?? "provisional"}/${cc.clsSl ?? "provisional"}). Own n=${cc.n}, calibrated on ${cc.pool} (n=${cc.poolN}, ${cc.winnersN} TP1-winners), grid expectancy ${cc.simExp >= 0 ? "+" : ""}${cc.simExp}. Realized this window under these exits: n=${cc.nFinal}, ${cc.expFinal >= 0 ? "+" : ""}${cc.expFinal} pts/trade, PF ${cc.pfFinal}.${thin}`);
  }
  gap();

  title("TRADE CHARTS (one PNG per trade)");
  kv("VIEW CHART links", "Every gated trade row has a VIEW CHART link opening that trade's own chart image: candles on the trade's interval (~70 bars before entry to ~40 after exit), entry arrow + entry line, dashed TP1/TP2/SL at the levels used for THAT trade, exit marker with P&L, the day's Yellow Box band with its init levels, and RTH-open markers (overnight bars drawn dim).");
  kv("Coverage window", `Charts are rendered for Mar 2026 -> present (trades dated ${CHART_FROM_KEY} onward). Older rows keep all their data but show — in the CHART column.`);
  kv("Folder requirement", "The links are RELATIVE (trade-charts\\<interval>\\<date>_<time>_<direction>_<seq>.png). Keep the trade-charts folder in the SAME folder as this workbook — move them together or the links stop resolving. The most recent WEEK of trades is ALSO embedded directly in tall rows at the far right of the All Trades sheet, so those need no folder at all.");
  gap();

  title("SHEET GUIDE (in order)");
  kv("All Trades", "Every quality-gated trade in the 3-month reporting window with the calibrated exits — the master list.");
  kv("1m / 5m / 15m / 60m", "The same trades split per chart interval (each interval is its own independent signal stream).");
  kv("Per-strategy sheets", "The same trades split by WHICH strategies agreed (e.g. Vector + Yellow Box). Sheet names spell the strategies out.");
  kv("Solo sheets", "ANALYSIS ONLY — each strategy traded alone over the same 3-month window, ignoring the live confluence rules, so its standalone merit is visible. These trades are NOT part of the gated set and do NOT fire live.");
  kv("Monte Carlo", "The exit-calibration evidence: methodology, per-class table with confidence intervals, excursion percentiles, recent-month charts with every gated signal's envelope, and the per-signal detail behind the charts.");
  gap();

  title("DATA & COVERAGE CAVEATS — READ BEFORE COMPARING STRATEGIES");
  for (const iv of INTERVALS) {
    const d = meta.dataSpan[iv];
    kv(`${iv} candles`, `${d.n.toLocaleString()} bars, ${d.from} .. ${d.to} (MotiveWave-authoritative, read-only snapshot)`);
  }
  kv("Emission window", `Signals only from ${meta.windowFromKey} (the 3-month reporting window). Bars from ${LOOKBACK_START_KEY} were loaded as lookback for the 50-trading-day Yellow Box walk-forward, vector warmup and ICT/fractal context — they never produce reported trades.`);
  kv("Milk zones", meta.coverage.milkZones);
  kv("Footprint", `Real MotiveWave footprint data exists ONLY for: ${meta.coverage.footprint}. No synthetic footprint anywhere.`);
  kv("Yellow Box", meta.coverage.yellowbox);
  kv("Session rules", "No entries at/after 3:15 PM ET; the 5:00-6:00 PM ET halt and weekends excluded; every gate evaluated at the bar's CLOSE time. Overnight (ETH) allows only solo Vector Side-Entries by house rule.");
  gap();

  title("COLUMN GLOSSARY (trade sheets)");
  kv("#", "Row number within the sheet.");
  kv("date/time ET", "New York time of the ENTRY (= the firing bar's close; the engine decides at bar close).");
  kv("session", "RTH = market hours (9:30-17:00 ET); ETH = overnight Globex.");
  kv("interval", "The chart interval whose engine run fired the trade.");
  kv("signal type", Object.values(SIGNAL_TYPE_GLOSSARY).join("  •  "));
  kv("WHY IT FIRED", "Plain-English sentence listing the exact facts that agreed, built from the engine's fact list.");
  kv("full fact label", "The engine's compact technical label for the same facts (what the app's Signals tab shows).");
  kv("EXIT STRATEGY", "The exit plan and where each level came from: MC p-optimal target / p85-MAE stop / anchored to a real obstacle when one was nearer.");
  kv("entry / tp1 / tp2 / sl", "Entry = firing bar close; targets and stop as planned at entry.");
  kv("WON?", `${OUTCOME_TXT.tp1} / ${OUTCOME_TXT.tp2} = target hit. ${OUTCOME_TXT.sl} = stop hit. ${OUTCOME_TXT.eod} = force-closed at the 17:00 ET settle (P&L can be + or -). ${OUTCOME_TXT.open} = session not finished at run time (excluded from stats denominators).`);
  kv("P&L points", "Signed points: exit minus entry for longs, entry minus exit for shorts.");
  kv("MAE / MFE", "Worst / best excursion in points between entry and exit (how much heat it took / how far it ran).");
  kv("bars to exit", "How many bars of that interval the trade lasted (fractional — exits resolve on 1m bars).");
  kv("yellow box context", "Where the entry sat relative to that day's Yellow Box: inside / above / below.");
  gap();

  title("HONEST LIMITATIONS & JUDGMENT CALLS");
  kv("Stats vs formulas", "All headline stats are REAL Excel formulas (COUNTIFS/SUMIFS/AVERAGEIFS + arithmetic, with cached results) over each sheet's own rows — except Max DD, which needs sequencing and is a JS-computed literal (marked *).");
  kv("Slippage/commission", `The per-trade P&L record is GROSS — fills AT the level (gap-throughs fill at the level, favorable), same-bar stop+target resolves STOP FIRST (never over-reports a win). Since 2026-08-02 every stats block ALSO reports NET of ${FRICTION_PTS_PER_TRADE} pts/trade friction (see the FRICTION section); the gate still judges gross (documented there).`);
  kv("Gate is in-sample", "The gate rule was derived from the same window it filters. The forward test is the live engine running with the gate on.");
  kv("Thin classes", `Classes with under 50 window trades are NOT judged on the thin sample: they carry the previous full-history verdict (flagged LOW CONFIDENCE in the gate section above and in shared/quality-gate.ts). Exit calibrations whose own class sample is under 50 are flagged the same way in the Monte Carlo section.`);
  kv("Pooling judgment call", "For classes under 100 trades the calibration prefers the class's own signals (>=30) over cross-interval pools, because a 60m trade's excursions dwarf a 1m trade's — mixing scales would produce a stop that is nonsense for both. Documented per class in the calibration table.");
  kv("Solo-sheet exits", "Solo sheets use the flat 10/5/20 house exits (not MC-calibrated) as a common yardstick — except Solo Yellow Box, which uses the strategy's own box geometry.");
  kv("Internal names", `The app's internal identifiers map to the names used here: fact-engine = ${displaySignalType("fact-engine")}; vector-side-entry = ${displaySignalType("vector-side-entry")}; zone-reaction = ${displaySignalType("zone-reaction")}; yellowbox-break = ${displaySignalType("yellowbox-break")}. The DB keeps the internal strings.`);
  kv("Solo trade counts", Object.entries(meta.soloCounts).map(([k, v]) => `${k}: ${v.toLocaleString()}`).join("  •  ") + `  •  gated live set: ${rows.length.toLocaleString()}  •  solo sheets are capped at 100,000 most-recent rows if larger (stats cover shown rows).`);
  void solo;
}

// ==================== PERSIST (--persist → signal_history) ====================
// Writes the FINAL gated trade set into signal_history so the chart, the Signals tab and the
// workbook all show the SAME trades. Write path = the live adapter's own guarded route
// (POST /api/signals/history: validateSignalRow skip+count + the natural-key upsert); if the
// dev server is down, an identical direct-DB upsert (same conflict set + COALESCE guards +
// validateSignalRow) is used. The window's previous engine-written rows are wiped first —
// after a full table backup copy (signal_history_backup_pre_regen).

/** Harness outcome → DB outcome. "eod" is now persisted DISTINCTLY (2026-07-29 — the UI says
 *  "CLOSED AT SESSION END", not "STOPPED OUT"); the live path posts the same vocabulary via the
 *  engine's eodClose flag. Learn/means still treat eod as a closed non-win (isWinOutcome). */
const DB_OUTCOME: Record<Outcome, string> = { tp1: "win_tp1", tp2: "win_tp2", sl: "loss", eod: "eod", open: "open" };

interface PersistRow {
  symbol: string; interval: string; timestamp: number; direction: string; riskLevel: string;
  signalType: string; entry: number; tp1: number; tp2: number | null; sl: number;
  outcome: string; label: string; confirmations?: string;
  // BACKTEST-GRADE EXIT DETAIL (2026-07-29) — the harness's 1m-walk per-trade numbers.
  exitPrice: number | null; exitTs: number | null; pointsResult: number | null;
  mae: number | null; mfe: number | null; barsToExit: number | null;
  // RISK DISPLAY (2026-07-30): combo key + risk flags (the POST route serializes the array;
  // the direct-DB fallback serializes it itself — same stored JSON string either way).
  comboKey: string | null; riskFlags: string[] | null;
  // POSITION SIZING (2026-08-02): engine-suggested contract count (additive, COALESCE-guarded).
  suggestedContracts: number | null;
  // SOURCE PROVENANCE (2026-07-31): every --persist row is stamped 'regen'. Rows stamped
  // 'live' (live-tab fires/outcome updates) are PERMANENT: the wipe below skips them and a
  // regen row for the same natural key YIELDS to the live row (collision reported).
  source: "regen";
}

async function persistSignals(doc: ResultsDoc): Promise<void> {
  const symbol = doc.meta.symbol;
  const windowStartTs = doc.meta.emissionStartTs;
  const rows: PersistRow[] = doc.signals.map(r => ({
    symbol, interval: r.interval, timestamp: r.fireTs, direction: r.direction,
    riskLevel: "safe", // single-tier (2026-06-02) — the live adapter always posts "safe"
    signalType: r.signalType, entry: r.entry, tp1: r.tp1, tp2: r.tp2, sl: r.sl,
    outcome: DB_OUTCOME[r.outcome], label: r.fullLabel,
    // BACKTEST-GRADE EXIT DETAIL: straight from the SigRow 1m walk (null while open).
    exitPrice: r.exitPrice, exitTs: r.exitTs, pointsResult: r.pointsResult,
    mae: r.mae, mfe: r.mfe, barsToExit: r.barsToExit,
    // RISK DISPLAY (2026-07-30): fire-time combo key + situational flags.
    comboKey: r.combo ?? null, riskFlags: r.riskFlags ?? null,
    // POSITION SIZING (2026-08-02): the engine's combo-tier suggested size.
    suggestedContracts: r.suggestedContracts ?? null,
    source: "regen", // SOURCE PROVENANCE (2026-07-31): regen rows yield to permanent live rows
    ...(r.confirmations ? { confirmations: r.confirmations } : {}),
  }));
  const bad = rows.map(r => ({ r, v: validateSignalRow(r) })).filter(x => !x.v.ok);
  if (bad.length) {
    const reasons = new Map<string, number>();
    for (const b of bad) reasons.set(b.v.reason ?? "?", (reasons.get(b.v.reason ?? "?") ?? 0) + 1);
    console.log(`[fe-bt] PERSIST WARNING: ${bad.length}/${rows.length} rows fail validateSignalRow locally: ` +
      [...reasons.entries()].map(([k, n]) => `${n}x ${k}`).join("; "));
  }

  const wdb = new Database(DB_PATH, { fileMustExist: true });
  wdb.pragma("busy_timeout = 15000");
  const perIv = (label: string): void => {
    const t = wdb.prepare(
      `SELECT interval, COUNT(*) n FROM signal_history WHERE symbol=? AND timestamp>=? GROUP BY interval ORDER BY interval`
    ).all(symbol, windowStartTs) as Array<{ interval: string; n: number }>;
    const tot = wdb.prepare(`SELECT COUNT(*) n FROM signal_history`).get() as { n: number };
    console.log(`[fe-bt] persist ${label}: window rows ${t.map(x => `${x.interval}=${x.n}`).join(" ") || "(none)"}; table total ${tot.n}`);
  };

  // 1) backup: full table copy (deterministic name, refreshed per persist run)
  wdb.exec(`DROP TABLE IF EXISTS signal_history_backup_pre_regen`);
  wdb.exec(`CREATE TABLE signal_history_backup_pre_regen AS SELECT * FROM signal_history`);
  const bk = wdb.prepare(`SELECT COUNT(*) n FROM signal_history_backup_pre_regen`).get() as { n: number };
  console.log(`[fe-bt] persist backup: signal_history_backup_pre_regen (${bk.n} rows)`);
  perIv("BEFORE wipe");

  // 2) wipe the window's engine-written rows (the regen set replaces them 1:1) — EXCEPT
  // source='live' rows (2026-07-31, "live-fired records are permanent"): a record the live
  // app wrote is never deleted by a regen; regen rows for the same key yield below.
  const liveKept = wdb.prepare(
    `SELECT COUNT(*) n FROM signal_history WHERE symbol=? AND timestamp>=? AND source='live'`
  ).get(symbol, windowStartTs) as { n: number };
  const del = wdb.prepare(
    `DELETE FROM signal_history WHERE symbol=? AND timestamp>=? AND (source IS NULL OR source <> 'live')`
  ).run(symbol, windowStartTs);
  console.log(`[fe-bt] persist wipe: deleted ${del.changes} window rows (symbol=${symbol}, timestamp>=${windowStartTs}); PRESERVED ${liveKept.n} source='live' rows (permanent)`);

  // 3) write through the LIVE guarded path; direct-DB fallback with identical semantics
  const baseUrl = process.env.PERSIST_BASE_URL ?? "http://127.0.0.1:3000";
  let inserted = 0, skipped = 0, viaServer = true;
  const collisionKeys: Array<{ symbol: string; interval: string; timestamp: number; direction: string }> = [];
  try {
    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400);
      const res = await fetch(`${baseUrl}/api/signals/history`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signals: chunk }),
      });
      if (!res.ok) throw new Error(`POST /api/signals/history → ${res.status}`);
      const j = await res.json() as { inserted: number; skipped: number; collisions?: number; collisionKeys?: typeof collisionKeys };
      inserted += j.inserted; skipped += j.skipped;
      if (j.collisionKeys?.length) collisionKeys.push(...j.collisionKeys);
    }
  } catch (err) {
    viaServer = false;
    console.log(`[fe-bt] persist: server path failed (${(err as Error).message}) — direct-DB upsert with identical guard/upsert semantics`);
    inserted = 0; skipped = 0; collisionKeys.length = 0;
    // SOURCE-GUARD (2026-07-31): same collision rule as the POST route — a stored 'live' row
    // makes the incoming regen row yield WHOLE (skip + report); source immutable once 'live'.
    const selLive = wdb.prepare(
      `SELECT source FROM signal_history WHERE symbol=? AND interval=? AND timestamp=? AND direction=?`
    );
    const stmt = wdb.prepare(
      `INSERT INTO signal_history (symbol, interval, timestamp, direction, risk_level, signal_type, entry, tp1, tp2, sl, outcome, footprint_reading, confirmations, label,
         exit_price, exit_ts, points_result, mae, mfe, bars_to_exit, combo_key, risk_flags, suggested_contracts, source, updated_at)
       VALUES (@symbol, @interval, @timestamp, @direction, @riskLevel, @signalType, @entry, @tp1, @tp2, @sl, @outcome, NULL, @confirmations, @label,
         @exitPrice, @exitTs, @pointsResult, @mae, @mfe, @barsToExit, @comboKey, @riskFlagsJson, @suggestedContracts, @source, @updatedAt)
       ON CONFLICT(symbol, interval, timestamp, direction) DO UPDATE SET
         risk_level=excluded.risk_level,
         outcome=CASE WHEN (outcome IS NULL OR outcome='open' OR excluded.outcome IS NULL OR excluded.outcome=outcome
                            OR (outcome='win_tp1' AND excluded.outcome='win_tp2'))
                      THEN COALESCE(excluded.outcome, outcome) ELSE outcome END,
         footprint_reading=excluded.footprint_reading,
         confirmations=excluded.confirmations, label=COALESCE(excluded.label, label),
         signal_type=COALESCE(excluded.signal_type, signal_type),
         exit_price=COALESCE(excluded.exit_price, exit_price), exit_ts=COALESCE(excluded.exit_ts, exit_ts),
         points_result=COALESCE(excluded.points_result, points_result), mae=COALESCE(excluded.mae, mae),
         mfe=COALESCE(excluded.mfe, mfe), bars_to_exit=COALESCE(excluded.bars_to_exit, bars_to_exit),
         combo_key=COALESCE(excluded.combo_key, combo_key), risk_flags=COALESCE(excluded.risk_flags, risk_flags),
         suggested_contracts=COALESCE(excluded.suggested_contracts, suggested_contracts),
         source=CASE WHEN source='live' THEN source ELSE COALESCE(excluded.source, source) END,
         updated_at=excluded.updated_at`
    );
    const updatedAt = new Date().toISOString();
    const insertMany = wdb.transaction((rs: PersistRow[]) => {
      for (const r of rs) {
        if (!validateSignalRow(r).ok) { skipped++; continue; }
        const stored = selLive.get(r.symbol, r.interval, r.timestamp, r.direction) as { source: string | null } | undefined;
        if (stored?.source === "live") { // regen yields whole to the permanent live record
          collisionKeys.push({ symbol: r.symbol, interval: r.interval, timestamp: r.timestamp, direction: r.direction });
          continue;
        }
        // riskFlags (array) must NOT reach better-sqlite3 as a bind value — serialize + strip.
        const { riskFlags: rfArr, ...bindable } = r;
        stmt.run({
          ...bindable, confirmations: r.confirmations ?? null,
          riskFlagsJson: rfArr ? JSON.stringify(rfArr) : null, // mirror the POST route's serialization
          updatedAt,
        });
        inserted++;
      }
    });
    insertMany(rows);
  }
  console.log(`[fe-bt] persist write (${viaServer ? "live POST route" : "direct DB"}): inserted ${inserted}, skipped ${skipped} of ${rows.length}; ${collisionKeys.length} collision(s) with permanent live rows`);
  // COLLISION REPORT (2026-07-31): every regen row that yielded to a source='live' record —
  // printed with the SURVIVING live record so the report shows what the book actually says.
  if (collisionKeys.length) {
    const selRow = wdb.prepare(
      `SELECT outcome, points_result, entry, tp1, sl, source FROM signal_history WHERE symbol=? AND interval=? AND timestamp=? AND direction=?`
    );
    for (const k of collisionKeys) {
      const live = selRow.get(k.symbol, k.interval, k.timestamp, k.direction) as
        | { outcome: string | null; points_result: number | null; entry: number; tp1: number; sl: number; source: string | null } | undefined;
      console.log(`[fe-bt] persist COLLISION (live row kept): ${k.symbol}/${k.interval} ts=${k.timestamp} ${k.direction} → ` +
        (live ? `stored LIVE record stands: outcome=${live.outcome} pts=${live.points_result} entry=${live.entry} tp1=${live.tp1} sl=${live.sl}` : "row missing (unexpected)"));
    }
  }
  perIv("AFTER regen");
  const byType = wdb.prepare(
    `SELECT signal_type, interval, COUNT(*) n FROM signal_history WHERE symbol=? AND timestamp>=? GROUP BY 1,2 ORDER BY 1,2`
  ).all(symbol, windowStartTs) as Array<{ signal_type: string; interval: string; n: number }>;
  console.log(`[fe-bt] persist window by type: ${byType.map(x => `${x.signal_type}@${x.interval}=${x.n}`).join(" ")}`);

  // 4) STALE-TAB RESYNC NUDGE (2026-07-30): a wipe+reinsert is invisible to open tabs — the wipe
  // above runs on THIS connection (no signal_removed per row) and the POST route's signal_new
  // broadcasts are additive-only, so tabs keep pre-regen rows (or, mid-wipe, an empty fetch)
  // until reload. Ask the server to broadcast `signals_resync`; every connected client does a
  // full signals refetch. No-op-safe: server down (the direct-DB fallback case) → log and move
  // on — the next tab load fetches fresh rows anyway.
  try {
    const res = await fetch(`${baseUrl}/api/signals/resync-broadcast`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol }),
    });
    console.log(`[fe-bt] persist resync nudge: ${res.ok ? "broadcast ok" : `HTTP ${res.status}`}`);
  } catch (err) {
    console.log(`[fe-bt] persist resync nudge skipped (server unreachable: ${(err as Error).message})`);
  }
  wdb.close();
}

// ==================== MAIN ====================

async function main(): Promise<void> {
  let doc: ResultsDoc;

  if (CHARTS_ONLY) {
    // Render per-trade charts for the EXISTING (frozen) trade set — no engine re-run, so the
    // published counts/stats stay exactly as backtested even though the live DB keeps growing.
    console.log(`[fe-bt] --charts-only: reading ${OUT_JSON}`);
    doc = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as ResultsDoc;
    const L = loadData();
    renderAllTradeCharts(doc.signals, L);
    fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 1)); // persist chartPath per row
    console.log(`[fe-bt] updated ${OUT_JSON} with chartPath  ${elapsed()}`);
  } else if (XLSX_ONLY) {
    console.log(`[fe-bt] --xlsx-only: reading ${OUT_JSON}`);
    doc = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as ResultsDoc;
  } else {
    doc = WINDOW_FROM_OVR ? runWindow() : runAll();
    fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 1));
    console.log(`[fe-bt] wrote ${OUT_JSON} (${(fs.statSync(OUT_JSON).size / 1e6).toFixed(1)} MB)  ${elapsed()}`);
    writeCsv(doc.signals);
    console.log(`[fe-bt] wrote ${OUT_CSV} (${doc.signals.length} rows)  ${elapsed()}`);
  }

  if (PERSIST) await persistSignals(doc);

  if (WINDOW_FROM_OVR && !SKIP_XLSX) console.log(`[fe-bt] window mode: xlsx + per-trade charts skipped by design`);
  if (!SKIP_XLSX && !WINDOW_FROM_OVR) {
    await buildWorkbook(doc);
    const fallback = OUT_XLSX.replace(/\.xlsx$/i, ".new.xlsx");
    const wrote = fs.existsSync(fallback) && fs.statSync(fallback).mtimeMs > t0 ? fallback : OUT_XLSX;
    console.log(`[fe-bt] wrote ${wrote} (${(fs.statSync(wrote).size / 1e6).toFixed(2)} MB)  ${elapsed()}`);
  }
  const mem = process.memoryUsage();
  console.log(`[fe-bt] DONE  runtime ${elapsed()}  peakRSS ${(mem.rss / 1e9).toFixed(2)} GB`);
}

function runAll(): ResultsDoc {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const windowToKey = new Date(L.lastDataTs * 1000).toISOString().slice(0, 10);

  // ── PHASE B0: the BEFORE pass — the OLD engine over the SAME 3-month window ──
  // Apples-to-apples baseline (user directive 2026-07-15): previous checked-in gate + exits
  // (OLD_GATE snapshot) with exactly the confirmations the SHIPPED engine had — as of
  // 2026-07-15 that means ICT + fractal ON (they shipped with the previous commit) and ONLY
  // the fractal-geometry guide facts OFF. The final pass below is compared against this, so
  // the before/after delta isolates the NEW fact family.
  // deadTape:false — the previous shipped engine had NO dead-tape suppression (and no daily
  // loss stop; neither applies to this baseline), so the before/after delta isolates the
  // NEW rules + gate/exit re-derivation exactly.
  const beforeByIv = enginePass(L, { gate: true, gateData: OLD_GATE, label: "BEFORE(old-engine)", fractalGeo: false, deadTape: false }, nowSec);
  const oldCalibClasses = new Set(Object.keys(OLD_GATE.exitByClass));
  const beforeRows: SigRow[] = [];
  for (const iv of INTERVALS) for (const sig of beforeByIv[iv]) beforeRows.push(resolveSignal(sig, L, nowSec, oldCalibClasses));
  beforeRows.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  printClassTable("BEFORE — OLD ENGINE (old gate+exits, no ICT/fractal), 3-mo window", beforeRows);

  // ── PHASE B: ungated pass → per-class stats → gate data ──
  // NEUTRAL config: gate off AND empty exitByClass, so the baseline always measures the
  // PROVISIONAL 10/5 exits — never the previous run's checked-in calibration.
  // ICT + fractal ON — the gate must judge the classes AS THE LIVE ENGINE now fires them.
  const neutralGate: QualityGateData = {
    generatedAt: "", source: "baseline (provisional exits)",
    rule: { ...GATE_RULE }, multiFact: { n: 0, pf: 0, expectancy: 0 },
    classes: {}, exitByClass: {},
  };
  const ungatedByIv = enginePass(L, { gate: false, gateData: neutralGate, label: "UNGATED" }, nowSec);
  const noCalib = new Set<string>();
  const ungatedRows: SigRow[] = [];
  for (const iv of INTERVALS) for (const sig of ungatedByIv[iv]) ungatedRows.push(resolveSignal(sig, L, nowSec, noCalib));
  ungatedRows.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  console.log(`[fe-bt] ungated resolved: ${ungatedRows.length}  ${elapsed()}`);
  printClassTable("UNGATED 3-MO WINDOW (gate-rule input)", ungatedRows);

  const gateData = computeGateDataWalkForward(ungatedByIv, L, nowSec, new Date().toISOString(), windowToKey);
  console.log(`[fe-bt] gate rule PER-INTERVAL bars [${INTERVALS.map(iv => `${iv}: ${gateBarTxt(iv)}`).join(" | ")}] on HELD-OUT data (n<${THIN_N} carries forward): ` +
    Object.entries(gateData.classes).map(([k, c]) => `${k}=${c.allowed ? "PASS" : "BLOCK"}${c.lowConfidence ? "(carry)" : ""}`).join(" "));

  // ── PHASE C: gated pass, provisional exits → gated set + excursions ──
  const gatedByIv = enginePass(L, { gate: true, gateData, label: "GATED(prov)" }, nowSec);
  const gatedSignals: FactSignal[] = INTERVALS.flatMap(iv => gatedByIv[iv]);
  const gatedRowsBefore: SigRow[] = gatedSignals.map(s => resolveSignal(s, L, nowSec, noCalib));
  console.log(`[fe-bt] gated (provisional exits): ${gatedSignals.length} signals  ${elapsed()}`);

  const excursions: Excursion[] = [];
  for (const sig of gatedSignals) {
    const e = buildExcursion(sig, L, nowSec);
    if (e) excursions.push(e);
  }
  console.log(`[fe-bt] excursion profiles: ${excursions.length}  ${elapsed()}`);

  // ── PHASE D: Monte-Carlo calibration per class ──
  const byClass = new Map<string, Excursion[]>();
  const byIvPool = new Map<Interval, Excursion[]>();
  for (const e of excursions) {
    let a = byClass.get(e.cls); if (!a) { a = []; byClass.set(e.cls, a); }
    a.push(e);
    let b = byIvPool.get(e.interval); if (!b) { b = []; byIvPool.set(e.interval, b); }
    b.push(e);
  }
  const calibration: CalibRow[] = [];
  const exitByClass: Record<string, ClassExit> = {};
  for (const [cls, own] of [...byClass.entries()].sort()) {
    const iv = cls.split("@")[1] as Interval;
    let pool = own, poolName = `its own trades`;
    if (own.length < 100) {
      const ivPool = byIvPool.get(iv) ?? [];
      if (ivPool.length >= 100) { pool = ivPool; poolName = `all gated ${iv} trades`; }
      else if (own.length >= 30) { pool = own; poolName = `its own trades (small sample kept — interval-scale faithful)`; }
      else { pool = excursions; poolName = `all gated trades (class too small)`; }
    }
    const best = gridSearch(pool);
    if (!best) { console.log(`[fe-bt] MC ${cls}: no valid grid candidate — provisional exits kept`); continue; }
    const [ciLo, ciHi] = bootstrapCi(own, best.tp1, best.sl);
    // lowConfidence (directive 2026-07-15): the class's OWN window sample under THIN_N —
    // the calibration rests on pooled/thin data and is flagged in the file + README.
    exitByClass[cls] = { tp1: best.tp1, sl: best.sl, n: own.length, pool: poolName, ...(own.length < THIN_N ? { lowConfidence: true } : {}) };
    calibration.push({
      cls, display: `${rowTypeDisplay(cls.split("@")[0])} @ ${iv}`,
      n: own.length, pool: poolName, poolN: pool.length,
      oldTp1: EXIT_CALIBRATION.DEFAULT_TP1_PTS, oldSl: EXIT_CALIBRATION.DEFAULT_SL_PTS,
      tp1: best.tp1, sl: best.sl, tp2: rnd2(best.tp1 * 2),
      winnersN: best.winnersN, simExp: best.exp, ciLo, ciHi,
      expBefore: 0, expAfter: 0, pfBefore: 0, pfAfter: 0, // filled below
    });
    console.log(`[fe-bt] MC ${cls}: TP1 ${best.tp1} SL ${best.sl} (pool ${poolName}, n=${pool.length}, winners ${best.winnersN}) simExp ${best.exp} CI [${ciLo},${ciHi}]`);
  }
  gateData.exitByClass = exitByClass;

  // ── PHASE D2: PER-COMBO Monte-Carlo calibration (mission 2026-07-29 — "5m and 15m fire only
  // their most optimized, winning trades"). Gate-ALLOWED fact combinations get their OWN exits
  // instead of the class blend. Same population and same full-window-refit rule as the class
  // calibration (the combo-gated PHASE-C excursions ARE the live trade population; future live
  // trades are unseen data — only the VERDICT must be held-out, and the combo VERDICTS above
  // were judged held-out under first-half CLASS exits, never under these). Structural classes
  // (zone-reaction / vector-side-entry) are exempt — mirrors the engine's combo exemption and
  // keeps vse@1m byte-identical to its class calibration. Ladder:
  //   n >= COMBO_EXIT_MIN_OWN_N own trades → grid-search the combo's own excursions
  //     (TP 4..30, SL = p85 MAE of TP1-winners, >=30-winners rule inside gridSearch);
  //   COMBO_EXIT_MIN_POOLED_N..MIN_OWN-1  → pooled with the same-interval allowed-combo trades;
  //   fewer → no entry (the class exit governs — previous behavior).
  const comboExc = excursions.filter(e => e.sigType !== "zone-reaction" && e.sigType !== "vector-side-entry" && e.combo.length > 0);
  const byComboIvExc = new Map<string, Excursion[]>();
  const byIvComboPool = new Map<Interval, Excursion[]>();
  for (const e of comboExc) {
    const k = `${e.combo}@${e.interval}`;
    let a = byComboIvExc.get(k); if (!a) { a = []; byComboIvExc.set(k, a); }
    a.push(e);
    let b = byIvComboPool.get(e.interval); if (!b) { b = []; byIvComboPool.set(e.interval, b); }
    b.push(e);
  }
  const exitByCombo: Record<string, ClassExit> = {};
  const comboCalibration: ComboCalibRow[] = [];
  for (const [key, own] of [...byComboIvExc.entries()].sort()) {
    if (own.length < COMBO_EXIT_MIN_POOLED_N) continue; // class exits govern
    const iv = key.split("@")[1] as Interval;
    const pooled = own.length < COMBO_EXIT_MIN_OWN_N;
    const pool = pooled ? (byIvComboPool.get(iv) ?? own) : own;
    const poolName = pooled
      ? `same-interval allowed-combo trades (combo n=${own.length} in ${COMBO_EXIT_MIN_POOLED_N}..${COMBO_EXIT_MIN_OWN_N - 1})`
      : "its own trades";
    const best = gridSearch(pool);
    if (!best) { console.log(`[fe-bt] MC-COMBO ${key}: no valid grid candidate — class exits govern`); continue; }
    exitByCombo[key] = { tp1: best.tp1, sl: best.sl, n: own.length, pool: poolName, ...(own.length < THIN_N ? { lowConfidence: true } : {}) };
    const clsExit = exitByClass[own[0].cls];
    comboCalibration.push({
      key, n: own.length, pool: poolName, poolN: pool.length,
      tp1: best.tp1, sl: best.sl, tp2: rnd2(best.tp1 * 2),
      winnersN: best.winnersN, simExp: best.exp,
      clsTp1: clsExit?.tp1 ?? null, clsSl: clsExit?.sl ?? null,
      nFinal: 0, expFinal: 0, pfFinal: 0, // filled after PHASE F
    });
    console.log(`[fe-bt] MC-COMBO ${key}: TP1 ${best.tp1} SL ${best.sl} (pool ${poolName}, n=${pool.length}, winners ${best.winnersN}) simExp ${best.exp} | class exit ${clsExit ? `${clsExit.tp1}/${clsExit.sl}` : "provisional"}`);
  }
  gateData.exitByCombo = exitByCombo;

  // ── PHASE E: regenerate the checked-in gate/calibration config ──
  writeQualityGateFile(gateData);

  // ── PHASE F: final gated pass WITH calibrated exits ──
  const finalByIv = enginePass(L, { gate: true, gateData, label: "FINAL(calib)" }, nowSec);
  const calibratedClasses = new Set(Object.keys(exitByClass));
  const finalRows: SigRow[] = [];
  for (const iv of INTERVALS) for (const sig of finalByIv[iv]) finalRows.push(resolveSignal(sig, L, nowSec, calibratedClasses));
  finalRows.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  console.log(`[fe-bt] FINAL gated+calibrated (pre-loss-stop): ${finalRows.length} trades  ${elapsed()}`);

  // ── DAILY LOSS STOP SIMULATION (2026-08-02): the live engine's rule, day-sequential ──
  // Applied AFTER resolution (the rule consumes realized exits) and BEFORE every reported
  // stat/artifact — the standing set is the AS-TRADED set. Gate verdicts + MC exits above
  // were derived on the pre-stop population (the rule cuts tail days, not setup quality —
  // documented in the README). The engine-level sets (finalByIv/finalKeys) stay pre-stop so
  // the chop/combo/dead-tape diagnostics keep measuring THEIR OWN variable.
  // (2026-08-10: a 3-loss STREAK STOP was implemented + honestly validated here and did NOT
  // clear the corroborator bar — the as-traded rule stays loss-stop-only. applyRiskStops +
  // scripts/streak-validate.ts hold the capability and the measurement.)
  const lossStopSim = applyDailyLossStop(finalRows, DAILY_LOSS_STOP_PTS);
  const lossStopSuppressedRows = lossStopSim.suppressed;
  finalRows.length = 0;
  finalRows.push(...lossStopSim.kept);
  console.log(`[fe-bt] DAILY LOSS STOP (-${DAILY_LOSS_STOP_PTS} pts/day, day-sequential): ${lossStopSim.trippedDays.length} tripped day(s) [${lossStopSim.trippedDays.join(", ") || "none"}], ${lossStopSuppressedRows.length} trade(s) suppressed → ${finalRows.length} as-traded  ${elapsed()}`);
  printClassTable("FINAL — QUALITY-GATED + MC-CALIBRATED EXITS + DAILY LOSS STOP (3-mo window)", finalRows);

  // ── CHOP DIAGNOSTIC + BEFORE/AFTER ACCOUNTING (2026-07-15) ──────────────────────────────
  // Diagnostic pass: the FINAL config with ONLY the chop-contradiction rule disabled — every
  // signal it fires that the final pass does not is a chop suppression (directly, or via the
  // cooldown knock-on of a suppressed fire; counted together and labeled as such).
  const chopDiagByIv = enginePass(L, { gate: true, gateData, label: "DIAG(no-chop)", settings: { CHOP_CONTRADICTS: false } }, nowSec);
  const sigKey = (s: FactSignal): string => `${s.time}|${s.interval}|${s.direction}`;
  const rowKey = (r: SigRow): string => `${r.fireTs}|${r.interval}|${r.direction}`;
  const finalKeys = new Set(INTERVALS.flatMap(iv => finalByIv[iv].map(sigKey)));
  const suppressedByChop = INTERVALS.flatMap(iv => chopDiagByIv[iv]).filter(s => !finalKeys.has(sigKey(s))).length;
  const beforeKeys = new Set(beforeRows.map(rowKey));
  const newlyFired = finalRows.filter(r => !beforeKeys.has(rowKey(r)));
  const hasCorrob = (r: SigRow): boolean => /(^|;)(ict|fractal)(;|$)/.test(r.strategiesInvolved);
  const newlyFiredWithCorroborators = newlyFired.filter(hasCorrob).length;
  const droppedVsBefore = beforeRows.filter(r => !finalKeys.has(rowKey(r))).length;
  const corroboratedTrades = finalRows.filter(hasCorrob).length;
  const mBefore = metricsOf(beforeRows);
  const mAfter = metricsOf(finalRows);
  const beforeAfter: RunMeta["beforeAfter"] = {
    windowFrom: WINDOW_START_KEY, windowTo: windowToKey,
    before: { trades: mBefore.count, expectancy: mBefore.expectancy, pf: mBefore.profitFactor, cumPts: mBefore.cumPts, winRate: rnd2(mBefore.winRate * 100), netExpectancy: mBefore.netExpectancy, netPf: mBefore.netProfitFactor, netCumPts: mBefore.netCumPts },
    after: { trades: mAfter.count, expectancy: mAfter.expectancy, pf: mAfter.profitFactor, cumPts: mAfter.cumPts, winRate: rnd2(mAfter.winRate * 100), netExpectancy: mAfter.netExpectancy, netPf: mAfter.netProfitFactor, netCumPts: mAfter.netCumPts },
    newlyFiredTotal: newlyFired.length,
    newlyFiredWithCorroborators,
    droppedVsBefore,
    suppressedByChop,
    corroboratedTrades,
    corroboratedSharePct: rnd2((corroboratedTrades / Math.max(1, finalRows.length)) * 100),
  };
  console.log(`[fe-bt] BEFORE/AFTER (same ${WINDOW_START_KEY}..${windowToKey} window): before ${mBefore.count} trades exp ${mBefore.expectancy} PF ${mBefore.profitFactor} (net ${mBefore.netExpectancy}/${mBefore.netProfitFactor}) | after ${mAfter.count} trades exp ${mAfter.expectancy} PF ${mAfter.profitFactor} (net ${mAfter.netExpectancy}/${mAfter.netProfitFactor})`);

  // ── COMBO DIAGNOSTIC (2026-07-29): the FINAL config with ONLY the combo verdicts removed —
  // every trade it takes that the final pass does not is a combo suppression (directly, or a
  // cooldown knock-on of one). Same gate classes + calibrated exits: the delta isolates the
  // combo gate exactly. ──
  const noComboGate: QualityGateData = { ...gateData, comboClasses: {} };
  const comboDiagByIv = enginePass(L, { gate: true, gateData: noComboGate, label: "DIAG(no-combo)" }, nowSec);
  const comboDiagRows: SigRow[] = [];
  for (const iv of INTERVALS) for (const sig of comboDiagByIv[iv]) comboDiagRows.push(resolveSignal(sig, L, nowSec, calibratedClasses));
  comboDiagRows.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  const comboSuppressedSigs = INTERVALS.flatMap(iv => comboDiagByIv[iv]).filter(s => !finalKeys.has(sigKey(s)));
  const supByKey = new Map<string, number>();
  for (const s of comboSuppressedSigs) {
    const k = `${comboKeyOf(s.facts)}@${s.interval}`;
    supByKey.set(k, (supByKey.get(k) ?? 0) + 1);
  }
  // Diag metrics under the SAME as-traded loss-stop rule so its row compares 1:1 with FINAL.
  const mComboDiag = metricsOf(applyDailyLossStop(comboDiagRows, DAILY_LOSS_STOP_PTS).kept);

  // ── DEAD-TAPE DIAGNOSTIC (2026-08-02): the FINAL config with ONLY the dead-tape suppression
  // disabled — every ENGINE fire it takes that the final pass does not is a dead-tape
  // suppression (directly, or a cooldown knock-on of one). Honest reporting mandate: if the
  // count is ZERO at this elite gate, say exactly that. ──
  const dtDiagByIv = enginePass(L, { gate: true, gateData, label: "DIAG(no-deadtape)", deadTape: false }, nowSec);
  const deadTapeSuppressedSigs = INTERVALS.flatMap(iv => dtDiagByIv[iv]).filter(s => !finalKeys.has(sigKey(s)));
  const dtByIv: Record<string, number> = {};
  for (const s of deadTapeSuppressedSigs) dtByIv[s.interval] = (dtByIv[s.interval] ?? 0) + 1;
  console.log(`[fe-bt] DEAD-TAPE suppression effect: ${deadTapeSuppressedSigs.length} would-be fire(s) suppressed at the shipped gate` +
    (deadTapeSuppressedSigs.length ? ` (${Object.entries(dtByIv).map(([iv, n]) => `${iv}=${n}`).join(" ")})` : " — the rule changes NOTHING at this gate (say so honestly)"));
  const comboEffect: RunMeta["comboEffect"] = {
    suppressedTrades: comboSuppressedSigs.length,
    suppressedByCombo: [...supByKey.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n })),
    diag: { trades: mComboDiag.count, expectancy: mComboDiag.expectancy, pf: mComboDiag.profitFactor, cumPts: mComboDiag.cumPts },
  };
  console.log(`[fe-bt] COMBO GATE effect: no-combo diag ${mComboDiag.count} trades exp ${mComboDiag.expectancy} PF ${mComboDiag.profitFactor} | final ${mAfter.count} exp ${mAfter.expectancy} PF ${mAfter.profitFactor} | ${comboSuppressedSigs.length} suppressed: ${comboEffect.suppressedByCombo.map(x => `${x.key}=${x.n}`).join(" ") || "(none)"}`);
  console.log(`[fe-bt] corroborator effect: ${newlyFired.length} newly fired (${newlyFiredWithCorroborators} carrying ICT/fractal facts), ${droppedVsBefore} no longer fired vs before, ${suppressedByChop} suppressed by the chop rule, ${corroboratedTrades}/${finalRows.length} final trades carry a confirmation fact`);

  // ── FRACTAL-GEOMETRY per-fact contribution (2026-07-15 guide-study mission) ──
  // Label-fragment accounting over the FINAL trade set: each FG fact kind's coverage + the
  // outcomes of the trades carrying it (a trade can carry several kinds — rows overlap).
  const FG_KINDS: Array<{ kind: string; frag: string; display: string }> = [
    { kind: "reclaim", frag: "FG Reclaim", display: "Vector Reclaim (failed break reversed)" },
    { kind: "flat-bounce", frag: "FG FlatBounce", display: "Flat-Vector Bounce" },
    { kind: "compression", frag: "FG Compression", display: "Compression Breakout" },
    { kind: "wave-room", frag: "FG WaveRoom", display: "Wave Has Room To Run" },
    { kind: "prior-close-cross", frag: "FG PriorClose", display: "Cross of Yesterday's Closes" },
  ];
  const fgFactStats: RunMeta["fgFactStats"] = FG_KINDS.map(k => {
    const own = finalRows.filter(r => r.fullLabel.includes(k.frag));
    const m = metricsOf(own);
    return { kind: k.kind, display: k.display, trades: own.length, winRatePct: rnd2(m.winRate * 100), expectancy: m.expectancy };
  });
  console.log(`[fe-bt] fractal-geometry facts on final trades: ` +
    fgFactStats.map(s => `${s.kind}=${s.trades} (win ${s.winRatePct}%, exp ${s.expectancy})`).join("  "));

  // ── PHASE H2: one chart PNG per gated trade (linked + recent-month-embedded in the workbook) ──
  renderAllTradeCharts(finalRows, L);

  // before/after per class
  for (const c of calibration) {
    const before = gatedRowsBefore.filter(r => classKey(r.signalType, r.interval) === c.cls);
    const after = finalRows.filter(r => classKey(r.signalType, r.interval) === c.cls);
    const mB = metricsOf(before), mA = metricsOf(after);
    c.expBefore = mB.expectancy; c.expAfter = mA.expectancy;
    c.pfBefore = mB.profitFactor; c.pfAfter = mA.profitFactor;
  }
  // realized per-combo stats under the shipped combo exits (PHASE D2 accounting)
  for (const cc of comboCalibration) {
    const [combo, iv] = [cc.key.slice(0, cc.key.lastIndexOf("@")), cc.key.slice(cc.key.lastIndexOf("@") + 1)];
    const rows = finalRows.filter(r => r.combo === combo && r.interval === iv);
    const m = metricsOf(rows);
    cc.nFinal = m.count; cc.expFinal = m.expectancy; cc.pfFinal = m.profitFactor;
    console.log(`[fe-bt] COMBO-EXIT ${cc.key}: final n=${m.count} exp=${m.expectancy} PF=${m.profitFactor} (TP1 ${cc.tp1}/SL ${cc.sl} vs class ${cc.clsTp1 ?? "prov"}/${cc.clsSl ?? "prov"})`);
  }

  // percentiles per class (full-horizon excursions)
  const percentiles: RunMeta["percentiles"] = {};
  for (const [cls, own] of [...byClass.entries()].sort()) {
    const maes = own.map(e => e.maeMax), mfes = own.map(e => e.mfeMax);
    const ps = [0.5, 0.75, 0.85, 0.9, 0.95];
    percentiles[cls] = { n: own.length, mae: ps.map(p => rnd2(pctl(maes, p))), mfe: ps.map(p => rnd2(pctl(mfes, p))) };
  }

  // ── PHASE G: solo backtests ──
  const soloV = soloVector(L, nowSec);
  console.log(`[fe-bt] solo vector: ${soloV.length}  ${elapsed()}`);
  const soloY = soloYellowbox(L, nowSec);
  console.log(`[fe-bt] solo yellowbox: ${soloY.length}  ${elapsed()}`);
  const soloF = soloFootprint(L, nowSec);
  console.log(`[fe-bt] solo footprint: ${soloF.length}  ${elapsed()}`);
  printClassTable("SOLO VECTOR (analysis)", soloV);
  printClassTable("SOLO YELLOW BOX (analysis)", soloY);
  printClassTable("SOLO FOOTPRINT (analysis)", soloF);

  // ── PHASE H: Monte-Carlo PNGs ──
  const pngs: Record<string, string> = {};
  for (const iv of INTERVALS) {
    const note = exitByClass[classKey("fact-engine", iv)]
      ? `CALIBRATED EXITS: ${Object.entries(exitByClass).filter(([k]) => k.endsWith("@" + iv)).map(([k, e]) => `${k.split("@")[0]} TP1 ${e.tp1}/SL ${e.sl}`).join("  ")}`
      : `CALIBRATED EXITS: ${Object.entries(exitByClass).filter(([k]) => k.endsWith("@" + iv)).map(([k, e]) => `${k.split("@")[0]} TP1 ${e.tp1}/SL ${e.sl}`).join("  ") || "none for this interval"}`;
    const png = renderMcPng(iv, L, finalRows, note);
    pngs[iv] = png.toString("base64");
    console.log(`[fe-bt] PNG ${iv}: ${(png.length / 1024).toFixed(0)} KB  ${elapsed()}`);
  }

  // ── tails + per-interval stats ──
  const tail30d: RunMeta["tail30d"] = {};
  const tailCut = L.lastDataTs - 30 * 86400;
  for (const iv of INTERVALS) {
    const t = finalRows.filter(r => r.interval === iv && r.entryTs >= tailCut);
    const byType: Record<string, number> = {};
    for (const r of t) byType[r.signalType] = (byType[r.signalType] ?? 0) + 1;
    tail30d[iv] = { gated: t.length, byType };
  }
  console.log(`[fe-bt] 30-day gated tails: ${INTERVALS.map(iv => `${iv}=${tail30d[iv].gated}`).join(" ")} (old ungated 5m tail was 72)`);

  const gatedPerInterval: RunMeta["gatedPerInterval"] = INTERVALS.map(iv => {
    const primaryBars = L.candlesByIv[iv].filter(c => c.time >= L.emissionStartTs).length;
    const n = finalRows.filter(r => r.interval === iv).length;
    return { interval: iv, primaryBars, signals: n, fireRatePct: rnd2((n / Math.max(1, primaryBars)) * 100) };
  });

  const meta: RunMeta = {
    symbol: SYMBOL,
    generatedAt: new Date().toISOString(),
    runtimeSec: rnd2((Date.now() - t0) / 1000),
    dataSpan: L.dataSpan,
    emissionStart: WINDOW_START_KEY,
    emissionStartTs: L.emissionStartTs,
    lastDataTs: L.lastDataTs,
    windowFromKey: WINDOW_START_KEY,
    windowToKey,
    beforeAfter,
    fgFactStats,
    engineSettings: FACT_ENGINE_DEFAULTS,
    provisionalExit: EXIT_CALIBRATION,
    coverage: {
      milkZones: "NONE historically — no uploaded-zone history exists; Milk Zone Reaction trades are a structural zero in this backtest (a data gap, not a strategy verdict)",
      footprint: L.fpCoverage,
      yellowbox: `walk-forward day zones (server cache ver=2 + ${L.computedYbKeys.length} computed via shared/yellowbox-core); ${L.dayZones.length} days with >= 50 prior trading days (${L.firstEligibleKey} ..)`,
    },
    gateRule: GATE_RULE,
    gateClasses: gateData.classes,
    comboClasses: gateData.comboClasses ?? {},
    comboEffect,
    multiFact: gateData.multiFact,
    ungatedTotal: ungatedRows.length,
    gatedTotal: finalRows.length,
    calibration,
    comboCalibration,
    percentiles,
    gatedPerInterval,
    tail30d,
    soloCounts: { "Solo Vector": soloV.length, "Solo Yellow Box": soloY.length, "Solo Milk Zone": 0, "Solo Footprint": soloF.length },
    friction: { ...FRICTION, ptsPerTrade: FRICTION_PTS_PER_TRADE },
    frictionAudit: FRICTION_AUDIT,
    dailyLossStop: {
      stopPts: DAILY_LOSS_STOP_PTS,
      derivation: `REMOVED 2026-08-17 (user directive — funded accounts; prop-firm daily limits govern). Historic derivation of the retired 80: p95 |day loss| of the losing session days of the previous standing 444-trade config — see shared/fact-engine.ts DAILY_LOSS_STOP_DEFAULT_PTS`,
      trippedDays: lossStopSim.trippedDays,
      suppressedTrades: lossStopSuppressedRows.length,
    },
    deadTape: { mult: DEAD_TAPE_SUPPRESS_MULT, suppressedVsFinal: deadTapeSuppressedSigs.length, suppressedByInterval: dtByIv },
  };

  return { meta, signals: finalRows, solo: { vector: soloV, yellowbox: soloY, footprint: soloF }, pngs };
}

// ==================== WINDOW MODE (--window-from) ====================
// Targeted regen of a specific window (e.g. a backfilled missed-data span) under the SHIPPED
// quality gate + calibrated exits (OLD_GATE = shared/quality-gate.ts as imported at process
// start). Deliberately does NOT run the BEFORE/UNGATED passes, re-derive gate verdicts,
// recalibrate exits, or rewrite the gate file — see the CLI comment.
function runWindow(): ResultsDoc {
  const nowSec = Math.floor(Date.now() / 1000);
  const L = loadData();
  const fromKey = WINDOW_FROM_OVR as string;
  const windowToTs = Math.min(L.lastDataTs, WINDOW_END_TS);
  const windowToKey = new Date(windowToTs * 1000).toISOString().slice(0, 10);
  console.log(`[fe-bt] WINDOW MODE ${fromKey} -> ${WINDOW_TO_OVR ?? "present"}: SHIPPED gate + calibrated exits (quality-gate.ts NOT re-derived)`);

  const finalByIv = enginePass(L, { gate: true, gateData: OLD_GATE, label: "WINDOW(shipped-gate)" }, nowSec);
  const calibratedClasses = new Set(Object.keys(OLD_GATE.exitByClass));
  const finalRows: SigRow[] = [];
  for (const iv of INTERVALS) for (const sig of finalByIv[iv]) finalRows.push(resolveSignal(sig, L, nowSec, calibratedClasses));
  finalRows.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  // DAILY LOSS STOP (2026-08-02): window mode reports the AS-TRADED set too (same rule).
  const winLossStop = applyDailyLossStop(finalRows, DAILY_LOSS_STOP_PTS);
  finalRows.length = 0;
  finalRows.push(...winLossStop.kept);
  console.log(`[fe-bt] WINDOW daily loss stop: ${winLossStop.trippedDays.length} tripped day(s), ${winLossStop.suppressed.length} suppressed`);
  printClassTable(`WINDOW ${fromKey} -> ${windowToKey} — SHIPPED GATE + CALIBRATED EXITS`, finalRows);

  const inWin = (r: SigRow): boolean => r.fireTs <= WINDOW_END_TS;
  const soloV = soloVector(L, nowSec).filter(inWin);
  const soloY = soloYellowbox(L, nowSec).filter(inWin);
  const soloF = soloFootprint(L, nowSec).filter(inWin);
  printClassTable("WINDOW SOLO VECTOR (analysis)", soloV);
  printClassTable("WINDOW SOLO YELLOW BOX (analysis)", soloY);
  printClassTable("WINDOW SOLO FOOTPRINT (analysis)", soloF);

  const m = metricsOf(finalRows);
  const hasCorrob = (r: SigRow): boolean => /(^|;)(ict|fractal)(;|$)/.test(r.strategiesInvolved);
  const corroboratedTrades = finalRows.filter(hasCorrob).length;
  const gatedPerInterval: RunMeta["gatedPerInterval"] = INTERVALS.map(iv => {
    const primaryBars = L.candlesByIv[iv].filter(c => c.time >= L.emissionStartTs && c.time <= WINDOW_END_TS).length;
    const n = finalRows.filter(r => r.interval === iv).length;
    return { interval: iv, primaryBars, signals: n, fireRatePct: rnd2((n / Math.max(1, primaryBars)) * 100) };
  });
  const tail30d: RunMeta["tail30d"] = {};
  for (const iv of INTERVALS) {
    const t = finalRows.filter(r => r.interval === iv);
    const byType: Record<string, number> = {};
    for (const r of t) byType[r.signalType] = (byType[r.signalType] ?? 0) + 1;
    tail30d[iv] = { gated: t.length, byType };
  }
  const meta: RunMeta = {
    symbol: SYMBOL,
    generatedAt: new Date().toISOString(),
    runtimeSec: rnd2((Date.now() - t0) / 1000),
    dataSpan: L.dataSpan,
    emissionStart: fromKey,
    emissionStartTs: L.emissionStartTs,
    lastDataTs: L.lastDataTs,
    windowFromKey: fromKey,
    windowToKey,
    beforeAfter: {
      windowFrom: fromKey, windowTo: windowToKey,
      before: { trades: 0, expectancy: 0, pf: 0, cumPts: 0, winRate: 0, netExpectancy: 0, netPf: 0, netCumPts: 0 }, // window mode runs no old-engine pass
      after: { trades: m.count, expectancy: m.expectancy, pf: m.profitFactor, cumPts: m.cumPts, winRate: rnd2(m.winRate * 100), netExpectancy: m.netExpectancy, netPf: m.netProfitFactor, netCumPts: m.netCumPts },
      newlyFiredTotal: 0, newlyFiredWithCorroborators: 0, droppedVsBefore: 0, suppressedByChop: 0,
      corroboratedTrades,
      corroboratedSharePct: rnd2((corroboratedTrades / Math.max(1, finalRows.length)) * 100),
    },
    fgFactStats: [],
    engineSettings: FACT_ENGINE_DEFAULTS,
    provisionalExit: EXIT_CALIBRATION,
    coverage: {
      milkZones: "NONE in this window (no uploaded-zone history)",
      footprint: L.fpCoverage,
      yellowbox: `walk-forward day zones from the server cache (ver=${YB_CACHE_VER}) + ${L.computedYbKeys.length} computed via shared/yellowbox-core`,
    },
    gateRule: GATE_RULE,
    gateClasses: OLD_GATE.classes,
    comboClasses: OLD_GATE.comboClasses ?? {}, // window mode runs under the SHIPPED combo verdicts
    comboEffect: { suppressedTrades: 0, suppressedByCombo: [], diag: { trades: 0, expectancy: 0, pf: 0, cumPts: 0 } }, // no diagnostic pass in window mode
    multiFact: OLD_GATE.multiFact,
    ungatedTotal: 0, // window mode runs no ungated pass
    gatedTotal: finalRows.length,
    calibration: [],
    comboCalibration: [], // window mode never recalibrates — the SHIPPED exitByCombo applied via OLD_GATE
    percentiles: {},
    gatedPerInterval,
    tail30d,
    soloCounts: { "Solo Vector": soloV.length, "Solo Yellow Box": soloY.length, "Solo Milk Zone": 0, "Solo Footprint": soloF.length },
    friction: { ...FRICTION, ptsPerTrade: FRICTION_PTS_PER_TRADE },
    frictionAudit: [], // window mode derives no verdicts — no fresh sim basis to audit
    dailyLossStop: {
      stopPts: DAILY_LOSS_STOP_PTS,
      derivation: "same default as the standing run (shared/fact-engine.ts DAILY_LOSS_STOP_DEFAULT_PTS)",
      trippedDays: winLossStop.trippedDays,
      suppressedTrades: winLossStop.suppressed.length,
    },
    deadTape: { mult: DEAD_TAPE_SUPPRESS_MULT, suppressedVsFinal: 0, suppressedByInterval: {} }, // no diagnostic pass in window mode
  };
  return { meta, signals: finalRows, solo: { vector: soloV, yellowbox: soloY, footprint: soloF }, pngs: {} };
}

// ==================== ENTRY / EXPORTS ====================
// Direct-run guard (2026-07-17): the parity test imports loadData/enginePass from this module,
// so the full backtest must only execute when the script is run directly (npx tsx scripts/
// fact-engine-backtest.ts) — never on import.
const _selfPath = fileURLToPath(import.meta.url).toLowerCase();
const _argvPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
if (_selfPath === _argvPath) {
  main().catch(err => { console.error(err); process.exit(1); });
}

// Exports for the parity test (scripts/fact-engine-parity.test.ts): the EXACT harness input
// builder (enginePass) + data loader the backtest itself uses.
export { loadData, enginePass, isValidBar, isMarketClosedEt, WINDOW_START_KEY, LOOKBACK_START_KEY, INTERVALS };
// Exports for the outcome sweep/repair (scripts/outcome-sweep-repair.ts): CSV writer + the
// harness row/metrics shapes so the standing deliverables regenerate byte-consistently.
// resolveSignal added 2026-07-31 for the gate-bar menu (scripts/gate-bar-menu.ts) — the
// menu resolves each rung's gated pass through the SAME canonical 1m walk as the harness.
export { writeCsv, metricsOf, resolveSignal };
export type { Loaded, SigRow };
// Exports for the RAISED-BAR analysis scripts (2026-08-02 option-b mission, ANALYSIS ONLY:
// scripts/option-b-menu.ts + scripts/option-b-simulation.ts): the WF verdict machinery + the
// MC-exit primitives, so a simulation can derive a full gate at HIGHER per-interval bars
// entirely in-memory. The gate FILE is never written by these consumers (PHASE E belongs to
// the real pipeline alone) and a normal harness run is byte-identical — nothing here changes
// behavior unless setGateBarsForAnalysis is explicitly called by an analysis script.
export { computeGateDataWalkForward, buildExcursion, gridSearch, bootstrapCi, THIN_N, COMBO_EXIT_MIN_OWN_N, COMBO_EXIT_MIN_POOLED_N, GATE_RULE };
export { simulate, pctl, TICK }; // TP1-frontier analysis (2026-08-12) — same sim/SL-rule primitives the calibration uses
export type { Excursion, GridBest };
/** Override the module GATE_RULE's per-interval bars for an in-memory analysis derivation
 *  (computeGateDataWalkForward judges at gateBarOf → the mutated bars). SIMULATION ONLY —
 *  never called by the real pipeline; MIN_FACTS_OVERRIDE is deliberately not overridable. */
export function setGateBarsForAnalysis(bars: Partial<Record<Interval, GateBar>>): void {
  for (const iv of Object.keys(bars) as Interval[]) {
    const b = bars[iv];
    if (b) GATE_RULE.perInterval[iv] = { MIN_PF: b.MIN_PF, MIN_EXPECTANCY_PTS: b.MIN_EXPECTANCY_PTS };
  }
}
/** Snapshot of the FRICTION AUDIT table built by the most recent computeGateDataWalkForward
 *  call (allowed classes/combos that fail their bar NET of friction) — analysis reporting. */
export function getFrictionAudit(): FrictionAuditRow[] {
  return FRICTION_AUDIT.map(a => ({ ...a }));
}
