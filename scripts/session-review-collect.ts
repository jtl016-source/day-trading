// scripts/session-review-collect.ts
// ═════════════════════════════════════════════════════════════════════════════
// DAILY SESSION-REVIEW FACT COLLECTOR (2026-08-07 mission — the deterministic half
// of the post-close review ritual; the narrative half is a headless `claude -p`
// reviewer driven by docs/session-review-prompt.md via server/scheduler.ts).
//
// For one ET session day (default: today; --date YYYY-MM-DD) this gathers EVERY
// reviewable fact into  <artifactsDir>/session-reports/YYYY-MM-DD-facts.json:
//
//   1. SIGNALS FIRED — every signal_history row of the session day (all sources)
//      with full detail + the delta vs its combo's held-out expectation.
//   2. NEAR-MISSES / SUPPRESSIONS — the live-fire-audit section-F machinery
//      generalized to ALL four intervals and FOUR engine variants:
//        A shipped        (gate ON, dead-tape ON — the live behavior)
//        B neutral-gate   (class/combo verdicts emptied — everything decide() passes)
//        C dead-tape OFF  (shipped gate, deadTapeSuppressEnabled:false)
//        P permissive     (neutral gate + dead-tape off + cooldown 0 + HOD/LOD 0
//                          + chop/FG contradiction rules off)
//      plus lazy single-relaxation probes (cooldown / hod-lod / contradiction) so
//      every candidate absent from A gets an EXACT cause. The daily loss stop is
//      replayed POST-HOC over the day's closed rows (harness applyDailyLossStop
//      basis — documented approximation, same as server/catchup.ts).
//      The 15:15 cutoff is an engine-hard rule (bars at/after 15:15 ET never reach
//      decide() in ANY variant) — structurally invisible, documented in meta.notes.
//   3. SESSION CONTEXT — day OHLC (RTH + full session) vs the window median range,
//      dead-tape state timeline, yellowbox level respect (touch/bounce/break per
//      level + time above/inside/below the box), FCO-based shape classification.
//   4. SYSTEM HEALTH — feed status + audit staleness + write-rejects (day-scoped),
//      scheduler job states (catchup/regen/digest) from the running server.
//   5. LEDGER — verdict + rolling numbers BEFORE (rows < session start) and AFTER
//      the session; the day's net vs the standing daily mean ± 2σ band.
//   6. AUTOPSIES — biggest win + biggest loss: bar-by-bar 1m excursion path.
//   7. JOURNAL ECHO — lesson tags + last-10-entry tail of session-journal.md
//      (created with a header if missing) so the reviewer can pattern-match
//      "what have we seen before".
//
// READ-ONLY vs the DB (better-sqlite3 readonly handle); the only writes are the
// facts JSON and the create-if-missing journal header. Requires the dev server on
// http://127.0.0.1:3000 (the parity-locked serving path is the whole point).
// Run:  npx tsx scripts/session-review-collect.ts [--date YYYY-MM-DD]
// ═════════════════════════════════════════════════════════════════════════════
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsDir } from "../shared/artifacts-dir";
import {
  runFactEngine, DEAD_TAPE_SUPPRESS_MULT, DAILY_LOSS_STOP_DEFAULT_PTS,
  type Interval, type FactSignal, type FpImbalanceZone, type IntervalSlice, type FactEngineSettings,
} from "../shared/fact-engine";
import {
  QUALITY_GATE, qualityGateAllows, comboGateAllows, comboKeyOf, comboExitOverrideFor, exitOverrideFor,
  FACT_FAMILY, type QualityGateData,
} from "../shared/quality-gate";
import { buildBaseCandles, normalizeServed15m, deriveEngineSlices, buildFootprintMap, type LiveCandle } from "../shared/live-adapter";
import { etWallToEpoch, sessionDayKey } from "../shared/yellowbox-core";
import { etSessionDayBucket } from "../shared/firing/session";
import { fcoAt, FRACTAL_DEFAULTS } from "../shared/fractal-engine";
import { computeLedger, deriveExpectation, summarizeLedgerStatus, type LedgerTradeRow, type StandingResultsDocLike } from "../shared/ledger-stats";

const SYMBOL = "MES";
const INTERVALS: Interval[] = ["1m", "5m", "15m", "60m"];
const WINDOW_SIZE_DAYS = 90; // market.tsx windowSize_v4 default — same context as live
const BASE_URL = process.env.SESSION_REVIEW_BASE_URL ?? `http://127.0.0.1:${process.env.PORT || "3000"}`;
const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
const ART_DIR = artifactsDir(ROOT);
const REPORT_DIR = path.join(ART_DIR, "session-reports");
const JOURNAL_PATH = process.env.SESSION_JOURNAL_PATH ?? path.join(ART_DIR, "session-journal.md");
const RESULTS_JSON = path.join(ART_DIR, "fact-engine-backtest-results.json");

const t0 = Date.now();
const log = (s: string): void => console.log(`[collect] ${s}`);

// market.tsx dateToTs (VERBATIM: UTC midnight of the day string) — parity with catchup.ts.
function dateToTs(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Math.floor(new Date(Date.UTC(y, m - 1, d, 0)).getTime() / 1000);
}
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
const etTimeOf = (ts: number): string => new Date(ts * 1000).toLocaleString("en-CA", {
  timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const r2 = (n: number): number => Math.round(n * 100) / 100;

interface ServedCandles { candles: LiveCandle[]; resolution?: string }

// ── Held-out expectation lookup (the gate's walk-forward verdicts) ───────────
interface HeldOut { basis: string; n: number; pf: number; expectancy: number; winRate: number; allowed: boolean }
function heldOutFor(combo: string, iv: string, signalType: string): HeldOut | null {
  const cc = (QUALITY_GATE.comboClasses ?? {}) as Record<string, { n: number; pf: number; expectancy: number; winRate: number; allowed: boolean }>;
  const cls = (QUALITY_GATE.classes ?? {}) as Record<string, { n: number; pf: number; expectancy: number; winRate: number; allowed: boolean }>;
  const hit = combo ? (cc[`${combo}@${iv}`] ? { k: `${combo}@${iv}`, v: cc[`${combo}@${iv}`] } : cc[combo] ? { k: combo, v: cc[combo] } : null) : null;
  if (hit) return { basis: `combo ${hit.k}`, n: hit.v.n, pf: hit.v.pf, expectancy: hit.v.expectancy, winRate: hit.v.winRate, allowed: hit.v.allowed };
  const ck = `${signalType}@${iv}`;
  if (cls[ck]) return { basis: `class ${ck}`, n: cls[ck].n, pf: cls[ck].pf, expectancy: cls[ck].expectancy, winRate: cls[ck].winRate, allowed: cls[ck].allowed };
  return null;
}

async function main(): Promise<void> {
  // ── Args + day geometry ────────────────────────────────────────────────────
  const argDate = ((): string | null => {
    const i = process.argv.indexOf("--date");
    if (i < 0) return null;
    const v = process.argv[i + 1] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { console.error(`bad --date '${v}' (want YYYY-MM-DD)`); process.exit(1); }
    return v;
  })();
  const nowSec = Math.floor(Date.now() / 1000);
  const dateKey = argDate ?? sessionDayKey(nowSec);
  const sessionStart = etWallToEpoch(dateKey, 0, 0) - 6 * 3600; // prior cal-day 18:00 ET (Globex reopen)
  const sessionEnd = etWallToEpoch(dateKey, 17, 0);             // 17:00 ET settle
  const replayEnd = Math.min(nowSec, etWallToEpoch(dateKey, 17, 30)); // engine "now" for the replay
  log(`session ${dateKey} (${new Date(sessionStart * 1000).toISOString()} → ${new Date(sessionEnd * 1000).toISOString()}), replay nowSec=${replayEnd}`);

  try { await getJson(`${BASE_URL}/api/data/cached-days/${SYMBOL}`); }
  catch (err) {
    console.error(`[collect] FATAL: dev server unreachable at ${BASE_URL} — the collector consumes the real serving path (npm run dev). (${(err as Error).message})`);
    process.exit(1);
  }

  // ── Served inputs (the parity-locked live construction — catchup.ts shape) ──
  const daysResp = await getJson<{ days: Array<{ date: string }> }>(`${BASE_URL}/api/data/cached-days/${SYMBOL}`);
  const sortedDays = [...(daysResp.days ?? [])].filter(d => d.date <= dateKey).sort((a, b) => a.date.localeCompare(b.date));
  if (!sortedDays.length) { console.error("[collect] FATAL: no cached days at/before the target date"); process.exit(1); }
  const windowedDays = sortedDays.slice(Math.max(0, sortedDays.length - WINDOW_SIZE_DAYS));
  const fromTs = dateToTs(windowedDays[0].date);
  const toTs = replayEnd; // serving-path cap: a past-date replay never sees later bars

  const cc = (iv: string): Promise<ServedCandles> =>
    getJson<ServedCandles>(`${BASE_URL}/api/data/cached-continuous/${SYMBOL}/${iv}?from=${fromTs}&to=${toTs}`);
  const [served1m, served5m, served15m, served60m] = await Promise.all([cc("1m"), cc("5m"), cc("15m"), cc("60m")]);
  const servedByIv: Record<Interval, ServedCandles> = { "1m": served1m, "5m": served5m, "15m": served15m, "60m": served60m };

  interface DzDay {
    dayKeyET: string; sessionStartTs: number; sessionEndTs: number; settle?: number;
    boxTop: number; boxBottom: number; initRes: number; initSup: number;
    maxRangeUp?: number; maxRangeDn?: number; normalRangeUp?: number; normalRangeDn?: number;
    maxTrendUp?: number; longAve?: number; shortAve?: number; lowConfidence?: boolean;
    bands?: Array<{ type: string; label: string; top: number; bottom: number; source: string }>;
  }
  const dz = await getJson<{ days: DzDay[] }>(`${BASE_URL}/api/yellowbox/day-zones?symbol=${SYMBOL}&fromTs=${fromTs}&toTs=${toTs}`);
  const feDayZones = (dz.days ?? []).map(d => ({
    dayKeyET: d.dayKeyET, sessionStartTs: d.sessionStartTs, sessionEndTs: d.sessionEndTs,
    boxTop: d.boxTop, boxBottom: d.boxBottom, initRes: d.initRes, initSup: d.initSup,
  }));
  const riskStats = await getJson<{ medianDayRange: number }>(`${BASE_URL}/api/risk/combo-stats`);
  const medianDayRange = riskStats.medianDayRange > 0 ? riskStats.medianDayRange : 0;
  log(`served: 1m=${served1m.candles.length} 5m=${served5m.candles.length} 15m=${served15m.candles.length} 60m=${served60m.candles.length}; day-zones=${feDayZones.length}; medianDayRange=${medianDayRange}`);

  // ── DB (readonly) — day rows, footprints, ledger rows, health tables ───────
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  interface DbRow {
    id: number; interval: string; timestamp: number; direction: string; risk_level: string;
    signal_type: string | null; entry: number; tp1: number; tp2: number; sl: number;
    outcome: string | null; label: string | null; confirmations: string | null;
    exit_price: number | null; exit_ts: number | null; points_result: number | null;
    mae: number | null; mfe: number | null; bars_to_exit: number | null;
    combo_key: string | null; risk_flags: string | null; suggested_contracts: number | null;
    source: string | null;
  }
  const dayRows = (db.prepare(
    `SELECT id, interval, timestamp, direction, risk_level, signal_type, entry, tp1, tp2, sl, outcome,
            label, confirmations, exit_price, exit_ts, points_result, mae, mfe, bars_to_exit,
            combo_key, risk_flags, suggested_contracts, source
       FROM signal_history WHERE symbol=? AND timestamp>=? AND timestamp<? ORDER BY timestamp`,
  ).all(SYMBOL, sessionStart, sessionEnd + 3600) as DbRow[])
    .filter(r => sessionDayKey(r.timestamp) === dateKey);

  const fpRows = db.prepare(`SELECT time, data FROM footprint_candles WHERE symbol=? AND interval='5m' AND complete=1`)
    .all(SYMBOL) as Array<{ time: number; data: string }>;
  const fpByTime = new Map<number, { imbalances: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> }>();
  let fpMaxTs = 0;
  for (const r of fpRows) {
    try {
      const d = JSON.parse(r.data) as { imbalances?: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> };
      if (d.imbalances?.length) { fpByTime.set(r.time, { imbalances: d.imbalances }); if (r.time > fpMaxTs) fpMaxTs = r.time; }
    } catch { /* malformed row — no fact */ }
  }
  log(`db: ${dayRows.length} signal rows on ${dateKey}; footprint rows ${fpByTime.size} (coverage ends ${fpMaxTs ? new Date(fpMaxTs * 1000).toISOString().slice(0, 10) : "(none)"})`);

  // ── Engine variants (near-miss machinery) ──────────────────────────────────
  const slicesByIv: Partial<Record<Interval, IntervalSlice[]>> = {};
  const fpMapByIv: Partial<Record<Interval, Map<number, FpImbalanceZone[]>>> = {};
  const windowedByIv: Partial<Record<Interval, LiveCandle[]>> = {};
  for (const iv of INTERVALS) {
    const raw = servedByIv[iv];
    const candleData: LiveCandle[] = iv === "15m" ? normalizeServed15m(raw.candles, raw.resolution) : raw.candles;
    const windowedCandles = buildBaseCandles(candleData, /*showETH*/ true, replayEnd);
    windowedByIv[iv] = windowedCandles;
    const { slices } = deriveEngineSlices({
      interval: iv, windowedCandles,
      raw1mCandles: iv !== "1m" ? served1m.candles : undefined,
      rawCandles: raw.candles,
      raw60mCandles: iv !== "60m" ? served60m.candles : undefined,
    });
    slicesByIv[iv] = slices;
    fpMapByIv[iv] = (iv === "5m" || iv === "15m") ? buildFootprintMap(windowedCandles, t => fpByTime.get(t)) : new Map();
  }

  const neutralGate: QualityGateData = {
    generatedAt: "neutral", source: "session-review-collect",
    rule: { ...QUALITY_GATE.rule }, multiFact: { n: 0, pf: 0, expectancy: 0 },
    classes: {}, exitByClass: {},
  };
  function runVariant(iv: Interval, opts: { neutral?: boolean; deadTapeOff?: boolean; settingsOver?: Partial<FactEngineSettings> } = {}): FactSignal[] {
    const fired = runFactEngine({
      primary: iv, slices: slicesByIv[iv] ?? [], zones: [], dayZones: feDayZones,
      footprintByTime: fpMapByIv[iv] ?? new Map(),
      settings: { ZONE_REACTION_PTS: 2.0, YELLOWBOX_SOLO: false, ...(opts.settingsOver ?? {}) },
      nowSec: replayEnd,
      qualityGateEnabled: true,
      ...(opts.neutral ? { gateData: neutralGate } : {}), // omitted → imported QUALITY_GATE, same as market.tsx
      ...(opts.deadTapeOff ? { deadTapeSuppressEnabled: false } : {}),
      dayRangeMedian: medianDayRange > 0 ? medianDayRange : undefined,
      // Daily loss stop deliberately NOT handed to the engine here: it is replayed post-hoc
      // over the day's closed rows (see lossStop below) — the harness applyDailyLossStop basis.
    });
    return fired.filter(s => sessionDayKey(s.time) === dateKey);
  }

  const key = (s: FactSignal): string => `${s.time}|${s.direction}`;
  const A: Partial<Record<Interval, FactSignal[]>> = {};   // shipped (live behavior)
  const B: Partial<Record<Interval, FactSignal[]>> = {};   // neutral gate
  const C: Partial<Record<Interval, FactSignal[]>> = {};   // dead-tape off
  const P: Partial<Record<Interval, FactSignal[]>> = {};   // permissive
  const PERMISSIVE: Partial<FactEngineSettings> = { COOLDOWN_BARS: 0, HOD_LOD_PROX_PTS: 0, CHOP_CONTRADICTS: false, FG_CONTRADICTS: false };
  for (const iv of INTERVALS) {
    A[iv] = runVariant(iv);
    B[iv] = runVariant(iv, { neutral: true });
    C[iv] = runVariant(iv, { deadTapeOff: true });
    P[iv] = runVariant(iv, { neutral: true, deadTapeOff: true, settingsOver: PERMISSIVE });
    log(`replay ${iv}: shipped=${A[iv]!.length} neutral=${B[iv]!.length} deadtape-off=${C[iv]!.length} permissive=${P[iv]!.length}`);
  }

  // Dead-tape predicate per interval: running session-day range at each bar (engine folding).
  const dtRangeByIv: Partial<Record<Interval, Map<number, number>>> = {};
  for (const iv of INTERVALS) {
    const m = new Map<number, number>();
    let bucket = NaN, hi = -Infinity, lo = Infinity;
    for (const c of windowedByIv[iv] ?? []) {
      if ((c as { complete?: boolean }).complete === false) continue;
      const b = etSessionDayBucket(c.time);
      if (b !== bucket) { bucket = b; hi = -Infinity; lo = Infinity; }
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
      m.set(c.time, hi > -Infinity && lo < Infinity ? hi - lo : 0);
    }
    dtRangeByIv[iv] = m;
  }
  const deadTapeAt = (iv: Interval, t: number): { dead: boolean; rangeSoFar: number | null } => {
    const r = dtRangeByIv[iv]?.get(t) ?? null;
    if (r == null || r <= 0 || medianDayRange <= 0) return { dead: false, rangeSoFar: r };
    return { dead: r < DEAD_TAPE_SUPPRESS_MULT * medianDayRange, rangeSoFar: r };
  };

  // ── Near-miss attribution ──────────────────────────────────────────────────
  const FAMILIES = [...new Set(Object.values(FACT_FAMILY))].filter(f => f !== "ML" && f !== "Zone");
  interface NearMiss {
    time: number; etTime: string; interval: Interval; direction: string; signalType: string;
    combo: string; counted: number; cause: string; causeDetail: string;
    completions?: string[]; alsoGateBlocked?: string | null;
    simulated: { outcome: string; eodClose: boolean; pointsResult: number | null; entry: number; tp1: number; sl: number } | null;
  }
  const nearMisses: NearMiss[] = [];
  const probeCache: Partial<Record<Interval, { cool: Set<string>; hod: Set<string>; contra: Set<string> }>> = {};
  const probesFor = (iv: Interval): { cool: Set<string>; hod: Set<string>; contra: Set<string> } => {
    let p = probeCache[iv];
    if (!p) {
      p = {
        cool: new Set(runVariant(iv, { neutral: true, deadTapeOff: true, settingsOver: { COOLDOWN_BARS: 0 } }).map(key)),
        hod: new Set(runVariant(iv, { neutral: true, deadTapeOff: true, settingsOver: { HOD_LOD_PROX_PTS: 0 } }).map(key)),
        contra: new Set(runVariant(iv, { neutral: true, deadTapeOff: true, settingsOver: { CHOP_CONTRADICTS: false, FG_CONTRADICTS: false } }).map(key)),
      };
      probeCache[iv] = p;
    }
    return p;
  };

  // Candidate set = (B ∪ C) \ A — the variants that keep the REAL cooldown, so each candidate
  // is a distinct setup. P-only fires are probed too, but a P-only fire that is itself
  // dead-tape/gate-blocked is a cooldown-free REFIRE of an already-counted suppression —
  // counted as noise, never a table row (172-row table on 2026-08-06 without this).
  let permissiveRefireNoise = 0;
  for (const iv of INTERVALS) {
    const aKeys = new Set((A[iv] ?? []).map(key));
    const bKeys = new Set((B[iv] ?? []).map(key));
    const bcKeys = new Set([...(B[iv] ?? []), ...(C[iv] ?? [])].map(key));
    const seen = new Map<string, FactSignal>();
    for (const s of [...(B[iv] ?? []), ...(C[iv] ?? [])]) {
      const k = key(s);
      if (!aKeys.has(k) && !seen.has(k)) seen.set(k, s);
    }
    for (const s of P[iv] ?? []) {
      const k = key(s);
      if (aKeys.has(k) || bcKeys.has(k) || seen.has(k)) continue;
      const counted = s.facts.filter(f => f.counted).length;
      const exempt = s.signalType === "zone-reaction" || s.signalType === "vector-side-entry";
      const gatesOk = qualityGateAllows(s.signalType, iv, counted)
        && (exempt || comboGateAllows(comboKeyOf(s.facts), iv));
      if (!gatesOk || deadTapeAt(iv, s.time).dead) { permissiveRefireNoise++; continue; }
      seen.set(k, s); // a genuine mechanics suppression (cooldown / hod-lod / contradiction)
    }
    for (const [k, s] of seen) {
      const combo = comboKeyOf(s.facts);
      const counted = s.facts.filter(f => f.counted).length;
      const exempt = s.signalType === "zone-reaction" || s.signalType === "vector-side-entry";
      const classOk = qualityGateAllows(s.signalType, iv, counted);
      const comboOk = exempt || comboGateAllows(combo, iv);
      const dt = deadTapeAt(iv, s.time);
      const gateBlockNote = !classOk ? `class ${s.signalType}@${iv} blocked (counted=${counted})`
        : !comboOk ? `combo ${combo}@${iv} blocked` : null;

      let cause: string, causeDetail: string;
      const completions: string[] = [];
      if (dt.dead) {
        // Engine order: dead-tape runs BEFORE decide() — it is the operative stop.
        cause = "dead-tape";
        causeDetail = `session range so far ${r2(dt.rangeSoFar ?? 0)} < ${r2(DEAD_TAPE_SUPPRESS_MULT * medianDayRange)} (0.6 × median ${r2(medianDayRange)})`;
      } else if (!classOk) {
        cause = "class-gate";
        causeDetail = `class gate: ${s.signalType}@${iv} BLOCKED with ${counted} counted fact${counted === 1 ? "" : "s"} (override needs >=3)`;
        const fams = combo ? combo.split("+") : [];
        for (const f of FAMILIES) {
          if (fams.includes(f)) continue;
          const withF = [...fams, f].sort().join("+");
          if (comboGateAllows(withF, iv)) completions.push(`+${f} → ${withF}`);
        }
      } else if (!comboOk) {
        const v = (QUALITY_GATE.comboClasses ?? {})[`${combo}@${iv}`] ?? (QUALITY_GATE.comboClasses ?? {})[combo];
        cause = "combo-verdict";
        causeDetail = `combo gate: ${combo}@${iv} blocked by the held-out verdict${v ? ` (n=${v.n} pf=${r2(v.pf)} exp=${r2(v.expectancy)})` : ""}`;
      } else {
        // Gates pass, tape alive — a mechanics suppression. Probe which single relaxation admits it.
        const pr = probesFor(iv);
        if (!bKeys.has(k) && pr.cool.has(k) && !pr.hod.has(k) && !pr.contra.has(k)) {
          cause = "cooldown"; causeDetail = "admitted only when COOLDOWN_BARS=0 — a prior fire consumed the interval cooldown";
        } else if (!bKeys.has(k) && pr.hod.has(k) && !pr.cool.has(k) && !pr.contra.has(k)) {
          cause = "hod-lod-room"; causeDetail = "admitted only when HOD_LOD_PROX_PTS=0 — entry too close to the day high/low";
        } else if (!bKeys.has(k) && pr.contra.has(k) && !pr.cool.has(k) && !pr.hod.has(k)) {
          cause = "contradiction-weight"; causeDetail = "admitted only with chop/chase-exhaustion contradiction rules off";
        } else if (bKeys.has(k)) {
          cause = "run-order"; causeDetail = "gates pass; fires in the neutral pass but not the shipped pass (cooldown-consumption ordering between the two)";
        } else {
          cause = "other-mechanics"; causeDetail = "gates pass, tape alive; multiple relaxations involved (tp1-room / stalemate / combined effects)";
        }
      }
      nearMisses.push({
        time: s.time, etTime: etTimeOf(s.time), interval: iv, direction: s.direction, signalType: s.signalType,
        combo, counted, cause, causeDetail,
        ...(completions.length ? { completions } : {}),
        alsoGateBlocked: cause === "dead-tape" ? gateBlockNote : null,
        simulated: s.outcome && s.outcome !== "open"
          ? { outcome: s.outcome, eodClose: !!s.eodClose, pointsResult: s.pointsResult ?? null, entry: s.price, tp1: s.tp1, sl: s.sl }
          : null,
      });
    }
  }
  nearMisses.sort((a, b) => a.time - b.time);
  const nearMissCounts: Record<string, number> = {};
  for (const nm of nearMisses) nearMissCounts[nm.cause] = (nearMissCounts[nm.cause] ?? 0) + 1;
  log(`near-misses: ${nearMisses.length} (${Object.entries(nearMissCounts).map(([c, n]) => `${c}=${n}`).join(" ") || "none"}; refire noise dropped=${permissiveRefireNoise})`);

  // ── Daily loss stop — post-hoc replay over the day's CLOSED rows ───────────
  const CLOSED = new Set(["win_tp1", "win_tp2", "loss", "eod"]);
  const closedSeq = dayRows
    .filter(r => CLOSED.has(r.outcome ?? "") && typeof r.points_result === "number")
    .map(r => ({ ts: r.exit_ts ?? r.timestamp, pts: r.points_result as number }))
    .sort((a, b) => a.ts - b.ts);
  let runSum = 0, runMin = 0, tripTs: number | null = null;
  for (const c of closedSeq) {
    runSum += c.pts;
    if (runSum < runMin) runMin = runSum;
    if (tripTs == null && runSum <= -DAILY_LOSS_STOP_DEFAULT_PTS) tripTs = c.ts;
  }
  const aAll = INTERVALS.flatMap(iv => A[iv] ?? []);
  const lossStop = {
    stopPts: DAILY_LOSS_STOP_DEFAULT_PTS,
    // 2026-08-17: the live rule is REMOVED — every trip field below is WOULD-HAVE analysis at
    // the retired 80-pt default, kept so the journal can keep scoring the removal decision.
    ruleRemoved: true,
    dayClosedNetPts: r2(runSum),
    runningMinPts: r2(runMin),
    tripped: tripTs != null,
    tripTs, tripEt: tripTs != null ? etTimeOf(tripTs) : null,
    firesAfterTripInReplay: tripTs != null ? aAll.filter(s => s.time >= (tripTs as number)).length : 0,
    dbRowsAfterTrip: tripTs != null ? dayRows.filter(r => r.timestamp >= (tripTs as number) && (r.source === "live")).length : 0,
    note: "closed-points chronological replay (harness applyDailyLossStop basis); the live adapter also counts the open-trade mark, so live can only trip EARLIER — a trip that existed only in an open mark is not reconstructable here.",
  };

  // ── Signals fired (DB = what the system served) + replay-vs-db diff ────────
  const signalsFired = dayRows.map(r => {
    const combo = r.combo_key ?? "";
    const exp = heldOutFor(combo, r.interval, r.signal_type ?? "fact-engine");
    let riskFlags: string[] = [];
    try { riskFlags = r.risk_flags ? (JSON.parse(r.risk_flags) as string[]) : []; } catch { /* raw */ }
    const comboOv = comboExitOverrideFor(combo, r.interval as Interval);
    const classOv = exitOverrideFor(r.signal_type ?? "fact-engine", r.interval as Interval);
    return {
      id: r.id, etTime: etTimeOf(r.timestamp), time: r.timestamp, interval: r.interval, direction: r.direction,
      signalType: r.signal_type, combo, label: r.label, source: r.source ?? "regen(legacy)",
      entry: r.entry, tp1: r.tp1, tp2: r.tp2, sl: r.sl,
      exitBasis: comboOv ? `combo exit ${comboOv.tp1}/${comboOv.sl}` : classOv ? `class exit ${classOv.tp1}/${classOv.sl}` : "default/anchor",
      riskFlags, suggestedContracts: r.suggested_contracts,
      outcome: r.outcome, pointsResult: r.points_result, mae: r.mae, mfe: r.mfe,
      exitPrice: r.exit_price, exitTs: r.exit_ts, exitEt: r.exit_ts != null ? etTimeOf(r.exit_ts) : null, barsToExit: r.bars_to_exit,
      heldOutExpectation: exp,
      deltaVsExpectation: exp && exp.expectancy != null && typeof r.points_result === "number" ? r2(r.points_result - exp.expectancy) : null,
    };
  });
  const dbKeys = new Set(dayRows.map(r => `${r.interval}|${r.timestamp}|${r.direction}`));
  const replayKeys = new Set(aAll.map(s => `${s.interval}|${s.time}|${s.direction}`));
  const replayVsDb = {
    replayFires: aAll.length, dbRows: dayRows.length,
    replayOnly: aAll.filter(s => !dbKeys.has(`${s.interval}|${s.time}|${s.direction}`)).map(s => `${s.interval}|${etTimeOf(s.time)}|${s.direction}`),
    dbOnly: dayRows.filter(r => !replayKeys.has(`${r.interval}|${r.timestamp}|${r.direction}`)).map(r => `${r.interval}|${etTimeOf(r.timestamp)}|${r.direction}|src=${r.source}`),
    note: "replayOnly = engine fires absent from signal_history (persistence gap or a live-only suppression: loss-stop/settings). dbOnly = rows the offline replay cannot reproduce (forming-bar fires, live-only PML/TML facts, healed-bar drift).",
  };

  // ── Session context — OHLC, dead-tape timeline, shape ──────────────────────
  const day5m = (windowedByIv["5m"] ?? []).filter(c => sessionDayKey(c.time) === dateKey && (c as { complete?: boolean }).complete !== false);
  const rth5m = day5m.filter(c => (c as { rth?: boolean }).rth !== false);
  const ohlcOf = (cs: LiveCandle[]): { open: number; high: number; low: number; close: number; range: number } | null => {
    if (!cs.length) return null;
    return {
      open: cs[0].open, close: cs[cs.length - 1].close,
      high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)),
      range: r2(Math.max(...cs.map(c => c.high)) - Math.min(...cs.map(c => c.low))),
    };
  };
  const sessionOhlc = ohlcOf(day5m);
  const rthOhlc = ohlcOf(rth5m);
  // Dead-tape timeline: when did the day's running range clear 0.6 × median?
  const dtThreshold = medianDayRange > 0 ? r2(DEAD_TAPE_SUPPRESS_MULT * medianDayRange) : null;
  let aliveTs: number | null = null;
  let deadBars = 0;
  for (const c of day5m) {
    const rr = dtRangeByIv["5m"]?.get(c.time);
    if (rr == null || dtThreshold == null) continue;
    if (rr < dtThreshold) deadBars++;
    else if (aliveTs == null) aliveTs = c.time;
  }
  // Shape via FCO over RTH 5m closes.
  const closes = rth5m.map(c => c.close);
  let trendBars = 0, chopBars = 0, valid = 0;
  for (let i = 0; i < closes.length; i++) {
    const v = fcoAt(closes, i, FRACTAL_DEFAULTS.FCO_WINDOW);
    if (!Number.isFinite(v)) continue;
    valid++;
    if (Math.abs(v) >= FRACTAL_DEFAULTS.FCO_TREND_MIN) trendBars++;
    else if (Math.abs(v) <= FRACTAL_DEFAULTS.FCO_CHOP_MAX) chopBars++;
  }
  const trendShare = valid ? trendBars / valid : 0;
  const chopShare = valid ? chopBars / valid : 0;
  const shape = chopShare >= 0.55 ? "chop" : trendShare >= 0.35 ? "trend" : "mixed";
  const sessionContext = {
    sessionOhlc, rthOhlc,
    medianDayRange: r2(medianDayRange),
    rangeVsMedian: sessionOhlc && medianDayRange > 0 ? r2(sessionOhlc.range / medianDayRange) : null,
    deadTape: {
      threshold: dtThreshold,
      clearedAtEt: aliveTs != null ? etTimeOf(aliveTs) : null,
      deadBars5m: deadBars, totalBars5m: day5m.length,
      note: dtThreshold == null ? "no median baseline — dead-tape not computable" : aliveTs == null ? "the day NEVER cleared the dead-tape threshold" : undefined,
    },
    shape: {
      classification: shape,
      fcoTrendShare: r2(trendShare), fcoChopShare: r2(chopShare), fcoBars: valid,
      netMoveVsRange: rthOhlc && rthOhlc.range > 0 ? r2((rthOhlc.close - rthOhlc.open) / rthOhlc.range) : null,
    },
  };

  // ── Yellowbox respect ──────────────────────────────────────────────────────
  const todayZone = (dz.days ?? []).find(d => d.dayKeyET === dateKey) ?? null;
  interface LevelStat { level: string; price: number; touches: number; bounces: number; closesBeyond: number }
  const yellowbox = ((): Record<string, unknown> | null => {
    if (!todayZone || !rth5m.length) return null;
    const TOL = 1.0, BOUNCE_PTS = 2.0, BOUNCE_BARS = 3;
    const levels: Array<[string, number | undefined]> = [
      ["settle", todayZone.settle], ["boxTop", todayZone.boxTop], ["boxBottom", todayZone.boxBottom],
      ["initRes", todayZone.initRes], ["initSup", todayZone.initSup],
      ["normalRangeUp", todayZone.normalRangeUp], ["normalRangeDn", todayZone.normalRangeDn],
      ["maxRangeUp", todayZone.maxRangeUp], ["maxRangeDn", todayZone.maxRangeDn],
      ["maxTrendUp", todayZone.maxTrendUp], ["longAve", todayZone.longAve], ["shortAve", todayZone.shortAve],
    ];
    const stats: LevelStat[] = [];
    for (const [name, price] of levels) {
      if (price == null || !Number.isFinite(price)) continue;
      let touches = 0, bounces = 0, closesBeyond = 0;
      for (let i = 0; i < rth5m.length; i++) {
        const c = rth5m[i];
        const touched = c.low <= price + TOL && c.high >= price - TOL;
        if (!touched) continue;
        touches++;
        const from = c.close >= price ? 1 : -1;
        let bounced = false;
        for (let j = i + 1; j <= Math.min(i + BOUNCE_BARS, rth5m.length - 1); j++) {
          if ((rth5m[j].close - price) * from >= BOUNCE_PTS) { bounced = true; break; }
        }
        if (bounced) bounces++;
      }
      for (const c of rth5m) {
        if ((name.includes("Res") || name === "boxTop" || name.endsWith("Up") || name === "longAve") && c.close > price) closesBeyond++;
        if ((name.includes("Sup") || name === "boxBottom" || name.endsWith("Dn") || name === "shortAve") && c.close < price) closesBeyond++;
      }
      stats.push({ level: name, price: r2(price), touches, bounces, closesBeyond });
    }
    let above = 0, inside = 0, below = 0;
    for (const c of rth5m) {
      if (c.close > todayZone.boxTop) above++;
      else if (c.close < todayZone.boxBottom) below++;
      else inside++;
    }
    return {
      dayKeyET: todayZone.dayKeyET, lowConfidence: !!todayZone.lowConfidence,
      levels: stats,
      boxTime: { aboveBars: above, insideBars: inside, belowBars: below, totalRthBars: rth5m.length },
      bands: (todayZone.bands ?? []).map(b => ({ type: b.type, label: b.label, top: b.top, bottom: b.bottom, source: b.source })),
      note: "touches = 5m RTH bar within 1.0pt; bounce = >=2.0pt close-move away within 3 bars; closesBeyond = closes past the level in its breach direction. PML/TML are live-only (no history) — absent here by construction.",
    };
  })();

  // ── System health ──────────────────────────────────────────────────────────
  let health: Record<string, unknown> = { note: "sync-status unavailable" };
  try {
    const sync = await getJson<Record<string, unknown>>(`${BASE_URL}/api/mw/sync-status`);
    const sched = (sync.scheduler ?? {}) as Record<string, unknown>;
    const dayRejects = (db.prepare(`SELECT COUNT(*) n FROM candle_write_rejects WHERE seen_at>=? AND seen_at<?`)
      .get(sessionStart, sessionEnd + 3600) as { n: number }).n;
    health = {
      feedStatusNow: sync.feed_status ?? null,
      auditNow: sync.audit ?? null,
      candleWriteRejects: { day: dayRejects, serverCounters: sync.candleWriteRejects ?? null },
      scheduler: {
        lastCatchup: (sched as { lastCatchup?: unknown }).lastCatchup ?? null,
        lastRegen: (sched as { lastRegen?: unknown }).lastRegen ?? null,
        lastDigest: (sched as { lastDigest?: unknown }).lastDigest ?? null,
        repairSentinel: (sched as { repairSentinel?: unknown }).repairSentinel ?? null,
      },
      note: "feedStatusNow/auditNow are collect-time snapshots — no historical feed-status log exists; day-scoped truth is the write-rejects count and the catch-up pass results.",
    };
  } catch (e) { health = { note: `sync-status fetch failed: ${(e as Error).message}` }; }

  // ── Ledger before/after + daily band ───────────────────────────────────────
  let ledger: Record<string, unknown> = { note: "standing results JSON unavailable" };
  try {
    const doc = fs.existsSync(RESULTS_JSON) ? JSON.parse(fs.readFileSync(RESULTS_JSON, "utf-8")) as StandingResultsDocLike : null;
    const expectation = deriveExpectation(doc);
    const liveRows = (db.prepare(
      `SELECT timestamp ts, interval, outcome, points_result points, source FROM signal_history WHERE symbol=? AND source IN ('live','catchup')`,
    ).all(SYMBOL) as LedgerTradeRow[]);
    const before = computeLedger(liveRows.filter(r => r.ts < sessionStart), expectation, { nowMs: sessionStart * 1000 });
    // "after" cuts at replayEnd so a later-day collection (e.g. reviewing yesterday) never
    // leaks rows from sessions after the one under review.
    const after = computeLedger(liveRows.filter(r => r.ts <= replayEnd), expectation, { nowMs: replayEnd * 1000 });
    const dayNet = closedSeq.reduce((a, c) => a + c.pts, 0);
    const band = expectation && expectation.dailyNetMean != null && expectation.dailyNetStd != null
      ? { lo: r2(expectation.dailyNetMean - 2 * expectation.dailyNetStd), hi: r2(expectation.dailyNetMean + 2 * expectation.dailyNetStd), mean: r2(expectation.dailyNetMean) }
      : null;
    ledger = {
      expectation: expectation ? {
        trades: expectation.trades, expWinRate: expectation.expWinRate, expExpectancy: expectation.expExpectancy,
        expPF: expectation.expPF, tradesPerDay: expectation.tradesPerDay, generatedAt: expectation.generatedAt,
      } : null,
      before: summarizeLedgerStatus(before),
      after: summarizeLedgerStatus(after),
      dayNetPts: r2(dayNet),
      dayClosedTrades: closedSeq.length,
      dailyBand: band,
      dayInsideBand: band ? dayNet >= band.lo && dayNet <= band.hi : null,
    };
  } catch (e) { ledger = { note: `ledger computation failed: ${(e as Error).message}` }; }

  // ── Autopsies: biggest win + biggest loss (1m excursion path) ──────────────
  const day1m = (windowedByIv["1m"] ?? []).filter(c => sessionDayKey(c.time) === dateKey);
  function autopsy(r: DbRow | undefined): Record<string, unknown> | null {
    if (!r || typeof r.points_result !== "number") return null;
    const exitTs = r.exit_ts ?? sessionEnd;
    const pathBars = day1m.filter(c => c.time > r.timestamp && c.time <= exitTs);
    const dir = r.direction.toLowerCase().startsWith("l") ? 1 : -1;
    let fav = 0, adv = 0, favTs: number | null = null, advTs: number | null = null;
    const pts: Array<{ etTime: string; close: number; runFav: number; runAdv: number }> = [];
    for (const c of pathBars) {
      const f = (dir > 0 ? c.high - r.entry : r.entry - c.low);
      const a = (dir > 0 ? r.entry - c.low : c.high - r.entry);
      if (f > fav) { fav = f; favTs = c.time; }
      if (a > adv) { adv = a; advTs = c.time; }
      pts.push({ etTime: etTimeOf(c.time), close: c.close, runFav: r2(fav), runAdv: r2(adv) });
    }
    const step = Math.max(1, Math.ceil(pts.length / 40));
    return {
      etTime: etTimeOf(r.timestamp), interval: r.interval, direction: r.direction, combo: r.combo_key,
      entry: r.entry, exitPrice: r.exit_price, exitEt: r.exit_ts != null ? etTimeOf(r.exit_ts) : null,
      outcome: r.outcome, pointsResult: r.points_result, mae: r.mae, mfe: r.mfe, riskFlags: r.risk_flags,
      peakFavorablePts: r2(fav), peakFavorableEt: favTs != null ? etTimeOf(favTs) : null,
      peakAdversePts: r2(adv), peakAdverseEt: advTs != null ? etTimeOf(advTs) : null,
      givebackFromPeak: r2(fav - r.points_result),
      minutesHeld: r.exit_ts != null ? Math.round((r.exit_ts - r.timestamp) / 60) : null,
      path1m: pts.filter((_, i) => i % step === 0 || i === pts.length - 1),
    };
  }
  const closedRows = dayRows.filter(r => typeof r.points_result === "number");
  const biggestWin = autopsy([...closedRows].sort((a, b) => (b.points_result ?? 0) - (a.points_result ?? 0))[0]);
  const biggestLoss = autopsy([...closedRows].sort((a, b) => (a.points_result ?? 0) - (b.points_result ?? 0))[0]);

  // ── Journal echo ───────────────────────────────────────────────────────────
  if (!fs.existsSync(JOURNAL_PATH)) {
    fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
    fs.writeFileSync(JOURNAL_PATH, [
      "# SESSION JOURNAL — Milks Yellow Box strategy (the system's trading memory)",
      "",
      "Read by the daily post-close reviewer to answer \"what have we seen before?\".",
      "One entry per distilled lesson, appended by the automated session review. Format:",
      "",
      "## YYYY-MM-DD [tag-kebab-case] — one-line lesson",
      "2-3 line body: what happened, what it means, what to do about it.",
      "**Recurrence:** first-seen | seen-before (dates) | resolved",
      "",
      "---",
      "",
    ].join("\n"), "utf-8");
    log(`journal created (was missing): ${JOURNAL_PATH}`);
  }
  const journalRaw = fs.readFileSync(JOURNAL_PATH, "utf-8");
  const entryRe = /^## (\d{4}-\d{2}-\d{2}) \[([a-z0-9-]+)\] — (.+)$/gm;
  const lessons: Array<{ date: string; tag: string; lesson: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(journalRaw)) !== null) lessons.push({ date: m[1], tag: m[2], lesson: m[3] });
  const entryStarts = [...journalRaw.matchAll(/^## \d{4}-\d{2}-\d{2} \[/gm)].map(x => x.index ?? 0);
  const tailStart = entryStarts.length > 10 ? entryStarts[entryStarts.length - 10] : (entryStarts[0] ?? journalRaw.length);
  const journal = {
    path: JOURNAL_PATH,
    entryCount: lessons.length,
    lessonTags: lessons,
    tail: journalRaw.slice(tailStart).trim() || "(no entries yet)",
  };

  // ── Write the facts file ───────────────────────────────────────────────────
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outFile = path.join(REPORT_DIR, `${dateKey}-facts.json`);
  const facts = {
    meta: {
      date: dateKey, generatedAt: new Date().toISOString(), tookMs: Date.now() - t0,
      baseUrl: BASE_URL, replayEnd, sessionStart, sessionEnd,
      windowDays: windowedDays.length, windowFrom: windowedDays[0].date,
      notes: [
        "Near-miss 'simulated' outcomes use the CURRENT exit calibrations on healed bars — a suppressed setup is NOT a guaranteed result had it fired live.",
        "Bars closing at/after 15:15 ET never reach decide() in any engine variant (hard rule) — post-15:15 candidates are structurally invisible to this replay.",
        "The daily loss stop is replayed post-hoc on closed points (chronological); live also marks open trades, so live can only trip earlier than this replay.",
        "signalsFired comes from signal_history (what the system actually served); the engine replay (replayVsDb) cross-checks it.",
      ],
    },
    signalsFired,
    replayVsDb,
    nearMisses: {
      counts: nearMissCounts, total: nearMisses.length,
      permissiveRefireNoiseDropped: permissiveRefireNoise,
      table: nearMisses,
    },
    lossStop,
    sessionContext,
    yellowbox,
    health,
    ledger,
    autopsies: { biggestWin, biggestLoss },
    journal,
  };
  fs.writeFileSync(outFile, JSON.stringify(facts, null, 2), "utf-8");
  db.close();
  const w = signalsFired.filter(s => s.outcome === "win_tp1" || s.outcome === "win_tp2").length;
  const l = signalsFired.filter(s => s.outcome === "loss").length;
  const e = signalsFired.filter(s => s.outcome === "eod").length;
  log(`DONE ${dateKey}: ${signalsFired.length} signals (${w}W/${l}L/${e}E, net ${lossStop.dayClosedNetPts} pts), ${nearMisses.length} near-misses, shape=${shape} → ${outFile} (${Date.now() - t0}ms)`);
}

main().catch(err => { console.error("[collect] FATAL:", err); process.exit(1); });
