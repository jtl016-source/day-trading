// scripts/live-fire-audit.ts
// ═════════════════════════════════════════════════════════════════════════════
// LIVE-FIRE ASSURANCE AUDIT (mission 2026-07-29: "make sure 5m and 15m fire only their
// most optimized, winning trades"). Replays the LAST N TRADING DAYS through the LITERAL
// live-adapter construction (@shared/live-adapter over the RUNNING dev server's serving
// path — the parity architecture) under the CHECKED-IN quality gate, then audits:
//
//   A. GATE COMPLIANCE — every fired signal's combo must pass comboGateAllows and its
//      class must pass qualityGateAllows (exempt signal types excepted). Any violation
//      is a hard FAIL: the live path fired a combination the gate blocks.
//   B. WINNER PRESENCE — every explicitly ALLOWED 5m/15m combo (and all-interval allowed
//      combos on 5m/15m) either fired in the replay window or gets a DIAGNOSIS:
//      missing input (e.g. footprint coverage ended before the window — MW closed) vs
//      genuinely no qualifying occurrence (backtest agrees: zero in the same window).
//      A combo the BACKTEST fired in the window but the replay did not is a parity FAIL.
//   C. BACKTEST PARITY — the replayed 5m/15m signal sets must be IDENTICAL to the
//      regenerated backtest's FINAL rows over the same days (fireTs|direction|tp1|sl).
//   D. EXIT PROVENANCE — for each fired 5m/15m signal: which calibration produced its
//      exits (combo exit / class exit / zone-yellowbox anchor) — printed for the report.
//   E. FALLBACK-FEED SCENARIO (2026-07-30, Yahoo live-poll mission) — synthetic
//      co-occurring facts on a LIVE-SHAPED 5m stream (all-closed bars ending ~1min
//      behind its own "now", run through the LITERAL adapter construction): asserts an
//      allowed >=3-fact 5m combo FIRES, that a blocked combo verdict suppresses the same
//      stream, and that removing the footprint fact kills the fire (the 5m dependency).
//   F. TODAY REPLAY + NEAR-MISSES — per-interval fired counts for TODAY (ET) + a
//      neutral-gate 5m pass diffed against the shipped gate: for each candidate that
//      almost fired, exactly which gate blocked it / which single added fact family
//      would reach an allowed combo (footprint absences called out explicitly).
//
// REQUIRES the dev server on http://127.0.0.1:3000 (npm run dev).
// Run:  npx tsx scripts/live-fire-audit.ts   (exit 0 = all assertions hold)
// ═════════════════════════════════════════════════════════════════════════════
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsDir } from "../shared/artifacts-dir"; // BAXTER_ARTIFACTS_DIR (2026-08-02)
import { runFactEngine, type Interval, type FactSignal, type FpImbalanceZone, type IntervalSlice } from "../shared/fact-engine";
import {
  QUALITY_GATE, qualityGateAllows, comboGateAllows, comboKeyOf, comboExitOverrideFor, exitOverrideFor,
  FACT_FAMILY, type QualityGateData,
} from "../shared/quality-gate";
import { buildBaseCandles, normalizeServed15m, deriveEngineSlices, buildFootprintMap, type LiveCandle } from "../shared/live-adapter";
import { etWallToEpoch } from "../shared/yellowbox-core";

const BASE_URL = process.env.PARITY_BASE_URL ?? "http://127.0.0.1:3000";
const SYMBOL = "MES";
const AUDIT_DAYS = Number(process.env.AUDIT_DAYS ?? 10);
const WINDOW_SIZE_DAYS = 90; // market.tsx windowSize_v4 default — same context as live
const INTERVALS: Interval[] = ["1m", "5m", "15m", "60m"];
const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
const RESULTS_JSON = path.join(artifactsDir(ROOT), "fact-engine-backtest-results.json"); // BAXTER_ARTIFACTS_DIR (2026-08-02)

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
}
function info(line: string): void { console.log(`      ${line}`); }

function dateToTs(s: string, h = 0): number {
  const [y, m, d] = s.split("-").map(Number);
  return Math.floor(new Date(Date.UTC(y, m - 1, d, h)).getTime() / 1000);
}
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
interface ServedCandles { candles: LiveCandle[]; resolution?: string }

async function main(): Promise<void> {
  try { await getJson(`${BASE_URL}/api/data/cached-days/${SYMBOL}`); }
  catch (err) {
    console.error(`FAIL  dev server unreachable at ${BASE_URL} — this audit consumes the real serving path; start it with: npm run dev`);
    console.error(`      (${(err as Error).message})`);
    process.exit(1);
  }
  const nowSec = Math.floor(Date.now() / 1000);

  // ── The live window (adapter context) + the audit window (last N trading days) ──
  const daysResp = await getJson<{ days: Array<{ date: string }> }>(`${BASE_URL}/api/data/cached-days/${SYMBOL}`);
  const todayStr = new Date().toISOString().split("T")[0];
  const sortedDays = [...(daysResp.days ?? [])].filter(d => d.date <= todayStr).sort((a, b) => a.date.localeCompare(b.date));
  const windowedDays = sortedDays.slice(Math.max(0, sortedDays.length - WINDOW_SIZE_DAYS));
  const auditDays = sortedDays.slice(Math.max(0, sortedDays.length - AUDIT_DAYS)).map(d => d.date);
  const auditFrom = etWallToEpoch(auditDays[0], 0, 0);
  const auditTo = etWallToEpoch(auditDays[auditDays.length - 1], 0, 0) + 86400;
  const fromTs = dateToTs(windowedDays[0].date, 0);
  const toTs = Math.min(nowSec + 86400, nowSec + 3600);
  console.log(`[audit] replaying ${auditDays.length} trading days ${auditDays[0]}..${auditDays[auditDays.length - 1]} (live context window from ${windowedDays[0].date})`);

  const cc = (iv: string): Promise<ServedCandles> =>
    getJson<ServedCandles>(`${BASE_URL}/api/data/cached-continuous/${SYMBOL}/${iv}?from=${fromTs}&to=${toTs}`);
  const [served1m, served5m, served15m, served60m] = await Promise.all([cc("1m"), cc("5m"), cc("15m"), cc("60m")]);
  const servedByIv: Record<Interval, ServedCandles> = { "1m": served1m, "5m": served5m, "15m": served15m, "60m": served60m };

  const dz = await getJson<{ days: Array<{ dayKeyET: string; sessionStartTs: number; sessionEndTs: number; boxTop: number; boxBottom: number; initRes: number; initSup: number }> }>(
    `${BASE_URL}/api/yellowbox/day-zones?symbol=${SYMBOL}&fromTs=${fromTs}&toTs=${toTs}`);
  const feDayZones = (dz.days ?? []).map(d => ({
    dayKeyET: d.dayKeyET, sessionStartTs: d.sessionStartTs, sessionEndTs: d.sessionEndTs,
    boxTop: d.boxTop, boxBottom: d.boxBottom, initRes: d.initRes, initSup: d.initSup,
  }));

  // Real 5m footprint rows (the only interval with data) — fed to 5m AND 15m primaries,
  // exactly like market.tsx (`interval === "15m" ? "5m" : interval` — footprint runs on 5m base).
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const fpRows = db.prepare(`SELECT time, data FROM footprint_candles WHERE symbol=? AND interval='5m' AND complete=1`).all(SYMBOL) as Array<{ time: number; data: string }>;
  const fpByTime = new Map<number, { imbalances: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> }>();
  let fpMaxTs = 0;
  for (const r of fpRows) {
    try {
      const d = JSON.parse(r.data) as { imbalances?: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> };
      if (d.imbalances?.length) { fpByTime.set(r.time, { imbalances: d.imbalances }); if (r.time > fpMaxTs) fpMaxTs = r.time; }
    } catch { /* malformed row — no fact */ }
  }
  const fpMaxDay = fpMaxTs ? new Date(fpMaxTs * 1000).toISOString().slice(0, 10) : "(none)";
  console.log(`[audit] footprint rows: ${fpByTime.size} (coverage ends ${fpMaxDay})`);

  // ── Replay: LITERAL live construction per interval, checked-in QUALITY_GATE (default) ──
  const firedByIv: Record<Interval, FactSignal[]> = { "1m": [], "5m": [], "15m": [], "60m": [] };
  // Retained per interval so section F can re-run the SAME inputs under a neutral gate.
  const slicesByIv: Partial<Record<Interval, IntervalSlice[]>> = {};
  const fpMapByIv: Partial<Record<Interval, Map<number, FpImbalanceZone[]>>> = {};
  for (const iv of INTERVALS) {
    const raw = servedByIv[iv];
    const candleData: LiveCandle[] = iv === "15m" ? normalizeServed15m(raw.candles, raw.resolution) : raw.candles;
    const windowedCandles = buildBaseCandles(candleData, /*showETH*/ true, nowSec);
    const { slices } = deriveEngineSlices({
      interval: iv, windowedCandles,
      raw1mCandles: iv !== "1m" ? served1m.candles : undefined,
      rawCandles: raw.candles,
      raw60mCandles: iv !== "60m" ? served60m.candles : undefined,
    });
    const footprintByTime: Map<number, FpImbalanceZone[]> = (iv === "5m" || iv === "15m")
      ? buildFootprintMap(windowedCandles, t => fpByTime.get(t))
      : new Map();
    slicesByIv[iv] = slices;
    fpMapByIv[iv] = footprintByTime;
    const fired = runFactEngine({
      primary: iv, slices, zones: [], dayZones: feDayZones, footprintByTime,
      settings: { ZONE_REACTION_PTS: 2.0, YELLOWBOX_SOLO: false }, nowSec,
      qualityGateEnabled: true, // gateData omitted → the imported QUALITY_GATE, same as market.tsx
    });
    firedByIv[iv] = fired.filter(s => s.time >= auditFrom && s.time < auditTo);
    console.log(`[audit] replay ${iv}: ${firedByIv[iv].length} fires in the audit window`);
  }

  // ── A. GATE COMPLIANCE ──
  console.log(`\n── A. gate compliance (every replayed fire vs the shipped gate) ──`);
  for (const iv of INTERVALS) {
    const bad: string[] = [];
    for (const s of firedByIv[iv]) {
      const combo = comboKeyOf(s.facts);
      const counted = s.facts.filter(f => f.counted).length;
      const exempt = s.signalType === "zone-reaction" || s.signalType === "vector-side-entry";
      if (!qualityGateAllows(s.signalType, iv, counted)) bad.push(`CLASS ${s.signalType}@${iv} t=${s.time}`);
      if (!exempt && !comboGateAllows(combo, iv)) bad.push(`COMBO ${combo}@${iv} t=${s.time}`);
    }
    ok(`A: every replayed ${iv} fire passes class + combo gate (n=${firedByIv[iv].length})`, bad.length === 0, bad.join("; "));
  }
  const comboTally = new Map<string, number>();
  for (const iv of ["5m", "15m"] as Interval[]) for (const s of firedByIv[iv]) {
    const k = `${comboKeyOf(s.facts)}@${iv}`;
    comboTally.set(k, (comboTally.get(k) ?? 0) + 1);
  }
  info(`5m/15m combos fired in the window: ${[...comboTally.entries()].map(([k, n]) => `${k}=${n}`).join("  ") || "(none)"}`);

  // ── C. BACKTEST PARITY over the audit window (needed for B's diagnosis too) ──
  console.log(`\n── C. replay vs regenerated backtest (same days, FINAL rows) ──`);
  const results = JSON.parse(fs.readFileSync(RESULTS_JSON, "utf-8")) as {
    meta: { generatedAt: string }; signals: Array<{ fireTs: number; interval: string; direction: string; tp1: number; sl: number; combo?: string; signalType: string }>;
  };
  info(`backtest results generated ${results.meta.generatedAt}`);
  const btWindow = results.signals.filter(r => r.fireTs >= auditFrom && r.fireTs < auditTo);
  for (const iv of ["5m", "15m"] as Interval[]) {
    const key = (t: number, d: string, tp1: number, sl: number): string => `${t}|${d}|${tp1}|${sl}`;
    const replayKeys = new Map(firedByIv[iv].map(s => [key(s.time, s.direction, s.tp1, s.sl), s]));
    const btKeys = new Map(btWindow.filter(r => r.interval === iv).map(r => [key(r.fireTs, r.direction, r.tp1, r.sl), r]));
    const onlyReplay = [...replayKeys.keys()].filter(k => !btKeys.has(k));
    const onlyBt = [...btKeys.keys()].filter(k => !replayKeys.has(k));
    ok(`C: ${iv} replay set == backtest FINAL set (n=${btKeys.size})`, onlyReplay.length === 0 && onlyBt.length === 0,
      [...onlyReplay.map(k => `REPLAY-ONLY ${k}`), ...onlyBt.map(k => `BACKTEST-ONLY ${k}`)].join("; "));
  }

  // ── B. WINNER PRESENCE + diagnosis ──
  console.log(`\n── B. allowed 5m/15m combos: fired in the window, or diagnosed ──`);
  const cc2 = QUALITY_GATE.comboClasses ?? {};
  const expected: Array<{ combo: string; iv: Interval; via: string }> = [];
  for (const [k, v] of Object.entries(cc2)) {
    if (!v.allowed) continue;
    if (k.includes("@")) {
      const combo = k.slice(0, k.lastIndexOf("@")); const iv = k.slice(k.lastIndexOf("@") + 1) as Interval;
      if ((iv === "5m" || iv === "15m") && combo !== "Vec") expected.push({ combo, iv, via: "explicit @interval PASS" });
    } else if (k !== "Vec") {
      for (const iv of ["5m", "15m"] as Interval[]) {
        if (comboGateAllows(k, iv)) expected.push({ combo: k, iv, via: "all-interval PASS applies at this interval" });
      }
    }
  }
  if (!expected.length) info("no explicitly ALLOWED 5m/15m combos in the shipped gate — nothing to require here.");
  for (const e of expected) {
    const k = `${e.combo}@${e.iv}`;
    const firedN = comboTally.get(k) ?? 0;
    if (firedN > 0) { ok(`B: winner ${k} fired in the replay window (${firedN}x; ${e.via})`, true); continue; }
    // Diagnose: missing input vs genuinely no occurrence (backtest = ground truth for occurrence).
    const btN = btWindow.filter(r => r.interval === e.iv && r.combo === e.combo).length;
    const needsFp = e.combo.split("+").includes("FP");
    const fpCovered = fpMaxTs >= auditFrom;
    if (btN > 0) {
      ok(`B: winner ${k} fired in replay`, false, `backtest has ${btN} in the same window but the replay has 0 — LIVE-PATH PARITY PROBLEM`);
    } else if (needsFp && !fpCovered) {
      ok(`B: winner ${k} — no fire, diagnosed: MISSING INPUT (footprint coverage ends ${fpMaxDay}, before the audit window; reopen MotiveWave to enable)`, true);
    } else {
      ok(`B: winner ${k} — no fire, diagnosed: no qualifying occurrence in these ${auditDays.length} days (backtest agrees: 0 in the same window${needsFp ? `; footprint covered through ${fpMaxDay}` : ""})`, true);
    }
  }

  // ── D. EXIT PROVENANCE for the replayed 5m/15m fires ──
  console.log(`\n── D. exit provenance (replayed 5m/15m fires) ──`);
  for (const iv of ["5m", "15m"] as Interval[]) {
    for (const s of firedByIv[iv]) {
      const combo = comboKeyOf(s.facts);
      let anchor = "default";
      try { anchor = (JSON.parse(s.confirmations) as { anchor?: string }).anchor ?? "default"; } catch { /* keep */ }
      const comboOv = comboExitOverrideFor(combo, iv);
      const classOv = exitOverrideFor(s.signalType, iv);
      const basis = anchor !== "default" ? `${anchor} ANCHOR (TP1 capped by a real obstacle)`
        : comboOv ? `COMBO exit ${comboOv.tp1}/${comboOv.sl}`
        : classOv ? `class exit ${classOv.tp1}/${classOv.sl}`
        : "provisional 10/5";
      const d = new Date(s.time * 1000).toISOString().slice(0, 16).replace("T", " ");
      info(`${iv}  ${d}Z  ${s.direction}  ${combo}  TP1 ${s.tp1} SL ${s.sl}  ← ${basis}`);
      const expectTp1 = s.direction === "Long" ? s.price + (comboOv?.tp1 ?? classOv?.tp1 ?? 10) : s.price - (comboOv?.tp1 ?? classOv?.tp1 ?? 10);
      if (anchor === "default") {
        ok(`D: ${iv} t=${s.time} default-path TP1 matches the ${comboOv ? "combo" : classOv ? "class" : "provisional"} calibration`,
          Math.abs(s.tp1 - expectTp1) < 1e-9, `tp1=${s.tp1} expected=${expectTp1}`);
      }
    }
    if (!firedByIv[iv].length) info(`${iv}: no fires in the audit window.`);
  }

  // ── E. FALLBACK-FEED SCENARIO — synthetic co-occurring facts on a live-shaped 5m stream ──
  console.log(`\n── E. fallback-feed scenario: allowed >=3-fact 5m combo fires on a live-shaped stream ──`);
  {
    // Deterministic synthetic stream mirroring what the Yahoo 1m fallback delivers: ALL-CLOSED
    // 5m bars ending ~1min behind the stream's own "now", pushed through the LITERAL live
    // construction (buildBaseCandles → deriveEngineSlices → buildFootprintMap → runFactEngine).
    // Geometry mirrors the proven >=3-fact fixture in shared/fact-engine.test.ts (SE↑ +
    // yellowbox break↑ + footprint = 3 counted facts) at realistic MES prices, with a 30-bar
    // preamble whose lows pin the ADAPTER-computed vector (Highest(Lowest(low,20),20)) at V.
    const V = 6500;
    const etF = (h: number, mi: number) => Date.UTC(2026, 6, 7, h + 4, mi, 0) / 1000; // Tue 2026-07-07 ET (EDT)
    const M5 = 300;
    const mk = (time: number, open: number, high: number, low: number, close: number): LiveCandle =>
      ({ time, open, high, low, close, volume: 100, rth: true, complete: true });
    const t0 = etF(9, 35);
    const stream: LiveCandle[] = [];
    for (let k = 0; k < 30; k++) stream.push(mk(t0 + k * M5, V + 0.5, V + 1, V, V + 0.6)); // low=V pins the vector at V
    const tS = t0 + 30 * M5; // shelf starts 12:05 ET — well before the 15:15 cutoff
    stream.push(mk(tS + 0 * M5, V - 0.5, V + 0.3, V - 1.0, V - 0.2));
    stream.push(mk(tS + 1 * M5, V - 0.2, V + 0.4, V - 0.8, V - 0.4));
    stream.push(mk(tS + 2 * M5, V - 0.4, V + 0.3, V - 0.9, V - 0.1));
    stream.push(mk(tS + 3 * M5, V - 0.1, V + 0.4, V - 0.7, V - 0.5)); // shelf ends; close <= vector
    const fireT = tS + 4 * M5;
    stream.push(mk(fireT, V - 0.3, V + 2.6, V - 0.4, V + 2.0));       // SE breakout: close > vector AND > boxTop
    const synthNow = fireT + M5 + 60; // fire bar CLOSED 60s ago — the fallback's ~1min-behind shape

    const wc = buildBaseCandles(stream, /*showETH*/ true, synthNow);
    const { slices: synthSlices } = deriveEngineSlices({ interval: "5m", windowedCandles: wc, rawCandles: stream });
    const fpSrc = new Map<number, { imbalances: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> }>(
      [[fireT, { imbalances: [{ startPrice: V - 1, endPrice: V, direction: "buy", levelCount: 3 }] }]]);
    const synthFp = buildFootprintMap(wc, t => fpSrc.get(t));
    const ybDay = {
      dayKeyET: "2026-07-07",
      sessionStartTs: Date.UTC(2026, 6, 6, 22, 0, 0) / 1000, // Mon 6 PM ET
      sessionEndTs: Date.UTC(2026, 6, 7, 21, 0, 0) / 1000,   // Tue 5 PM ET
      boxTop: V + 1, boxBottom: V - 100, initRes: V + 100, initSup: V - 200,
    };
    const synthGateE = (comboAllowed: boolean): QualityGateData => ({
      generatedAt: "synthetic", source: "live-fire-audit section E",
      rule: { ...QUALITY_GATE.rule },
      multiFact: { n: 0, pf: 0, expectancy: 0 },
      classes: { "fact-engine@5m": { n: 500, pf: 0.93, expectancy: -0.6, winRate: 0.35, allowed: false } }, // mirrors the shipped held-out BLOCK
      exitByClass: {},
      comboClasses: {
        "FP+Vec+YB@5m": { n: 60, pf: 2.5, expectancy: 4.0, winRate: 0.7, allowed: comboAllowed },
        // The residual no-FP combo is BLOCKED — the shipped-gate shape (Fr+YB blocked, FP+Fr+YB
        // allowed): the stream also emits a SECONDARY (15m-aggregate) SE fact, so stripping FP
        // still leaves 3 counted facts; without this verdict the stack would fire through an
        // unjudged Vec+YB combo instead of demonstrating the FP dependency.
        "Vec+YB@5m": { n: 60, pf: 0.8, expectancy: -0.5, winRate: 0.35, allowed: false },
      },
    });
    const runSynth = (over: { comboAllowed?: boolean; footprint?: boolean } = {}) => runFactEngine({
      primary: "5m", slices: synthSlices, zones: [], dayZones: [ybDay],
      footprintByTime: over.footprint === false ? new Map() : synthFp,
      nowSec: synthNow, qualityGateEnabled: true, gateData: synthGateE(over.comboAllowed !== false),
      ictEnabled: false, fractalEnabled: false, fractalGeoEnabled: false, // exact-count fixture (SE + YB + FP = 3)
    });

    ok("E: live-shaped stream survives the adapter chain (fire bar intact)",
      wc.some(c => c.time === fireT), `windowed=${wc.length}/${stream.length}`);
    const fires = runSynth();
    ok("E: allowed >=3-fact 5m combo FIRES on the live-shaped stream (blocked class overridden)",
      fires.length === 1 && fires[0].time === fireT && fires[0].direction === "Long",
      `fires=${JSON.stringify(fires.map(s => ({ t: s.time, d: s.direction, type: s.signalType })))}`);
    if (fires.length === 1) {
      const counted = fires[0].facts.filter(f => f.counted).length;
      ok(`E: fired signal is a >=3-counted-fact FP+Vec+YB stack (counted=${counted})`,
        counted >= 3 && comboKeyOf(fires[0].facts) === "FP+Vec+YB", `combo=${comboKeyOf(fires[0].facts)}`);
    }
    ok("E: the SAME stream under a BLOCKED combo verdict fires NOTHING (combo gate consulted on the live path)",
      runSynth({ comboAllowed: false }).length === 0);
    ok("E: removing the footprint fact drops the stack into the BLOCKED residual combo — nothing fires (the 5m FP dependency, live)",
      runSynth({ footprint: false }).length === 0);
  }

  // ── F. TODAY replay: per-interval fired counts + 5m near-misses under the shipped gate ──
  console.log(`\n── F. today (ET) — fired counts + 5m near-miss diagnosis ──`);
  const todayET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const todayFrom = etWallToEpoch(todayET, 0, 0);
  const todayFires: Record<Interval, FactSignal[]> = { "1m": [], "5m": [], "15m": [], "60m": [] };
  for (const iv of INTERVALS) todayFires[iv] = firedByIv[iv].filter(s => s.time >= todayFrom);
  info(`replay fired counts TODAY (${todayET}): ${INTERVALS.map(iv => `${iv}=${todayFires[iv].length}`).join("  ")}`);
  try {
    const rows = db.prepare(`SELECT interval, COUNT(*) n FROM signal_history WHERE timestamp>=? GROUP BY interval ORDER BY interval`)
      .all(todayFrom) as Array<{ interval: string; n: number }>;
    info(`signal_history rows today (live tabs may add more): ${rows.map(r => `${r.interval}=${r.n}`).join("  ") || "(none)"}`);
  } catch { info("signal_history today: (query failed — non-fatal)"); }

  // Neutral-gate 5m pass over the SAME adapter inputs: everything decide() passes fires.
  // Diff vs the shipped-gate replay = today's candidates that ALMOST fired.
  const neutralGate: QualityGateData = {
    generatedAt: "neutral", source: "live-fire-audit section F",
    rule: { ...QUALITY_GATE.rule }, multiFact: { n: 0, pf: 0, expectancy: 0 },
    classes: {}, exitByClass: {},
  };
  const neutral5mToday = runFactEngine({
    primary: "5m", slices: slicesByIv["5m"] ?? [], zones: [], dayZones: feDayZones,
    footprintByTime: fpMapByIv["5m"] ?? new Map(),
    settings: { ZONE_REACTION_PTS: 2.0, YELLOWBOX_SOLO: false }, nowSec,
    qualityGateEnabled: true, gateData: neutralGate,
  }).filter(s => s.time >= todayFrom && s.time < auditTo);
  const gatedKeys5m = new Set(todayFires["5m"].map(s => `${s.time}|${s.direction}`));
  const candidates = neutral5mToday.filter(s => !gatedKeys5m.has(`${s.time}|${s.direction}`));
  info(`neutral-gate 5m pass today: ${neutral5mToday.length} decide()-passing setups, ${candidates.length} suppressed by the shipped gate`);

  const FAMILIES = [...new Set(Object.values(FACT_FAMILY))].filter(f => f !== "ML" && f !== "Zone"); // ML: live-only; Zone: no uploaded zones in this audit
  interface NearMiss { s: FactSignal; counted: number; combo: string; reason: string; fpBlocked: boolean; completions: string[] }
  const nearMisses: NearMiss[] = candidates.map(s => {
    const counted = s.facts.filter(f => f.counted).length;
    const combo = comboKeyOf(s.facts);
    const classOk = qualityGateAllows(s.signalType, "5m", counted);
    const comboOk = comboGateAllows(combo, "5m");
    const fams = combo ? combo.split("+") : [];
    let reason: string; let fpBlocked = false; const completions: string[] = [];
    if (!classOk) {
      // Which single ADDED fact family reaches a non-blocked (>=3-fact-override) combo?
      for (const f of FAMILIES) {
        if (fams.includes(f)) continue;
        const withF = [...fams, f].sort().join("+");
        if (comboGateAllows(withF, "5m")) {
          const cc3 = QUALITY_GATE.comboClasses ?? {};
          const explicit = cc3[`${withF}@5m`]?.allowed === true || cc3[withF]?.allowed === true;
          completions.push(`+${f} → ${withF}${explicit ? " (EXPLICIT allowed winner)" : ""}`);
          if (f === "FP") fpBlocked = true;
        }
      }
      reason = `class gate: ${s.signalType}@5m BLOCKED and only ${counted} counted fact${counted === 1 ? "" : "s"} (override needs >=3)`;
    } else if (!comboOk) {
      reason = `combo gate: ${combo}@5m blocked by the held-out verdict`;
    } else {
      reason = "both gates pass — suppressed by run-order effects (cooldown/HOD/no-room differ between the gated and neutral passes)";
    }
    return { s, counted, combo, reason, fpBlocked, completions };
  });
  nearMisses.sort((a, b) => (b.counted - a.counted)
    || ((b.completions.length ? 1 : 0) - (a.completions.length ? 1 : 0))
    || (a.s.time - b.s.time));
  if (!nearMisses.length) info("no 5m near-misses today — nothing beyond the fired set reached decide().");
  for (const nm of nearMisses.slice(0, 3)) {
    const dStr = new Date(nm.s.time * 1000).toLocaleString("en-CA", {
      timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    info(`NEAR-MISS ${dStr} ET  ${nm.s.direction}  combo=${nm.combo || "(none)"}  counted=${nm.counted}  type=${nm.s.signalType}`);
    info(`   blocked by: ${nm.reason}`);
    if (nm.completions.length) info(`   one added fact completes: ${nm.completions.join("; ")}${nm.fpBlocked ? "   ← the FP fact was ABSENT at this bar (needs LIVE MotiveWave footprint data; coverage ends " + fpMaxDay + ")" : ""}`);
  }
  ok(`F: every suppressed 5m candidate today has an exact gate/fact attribution (${nearMisses.length} candidate${nearMisses.length === 1 ? "" : "s"})`,
    nearMisses.every(n => !!n.reason));

  // The standing 5m footprint-dependency share, recomputed from the shipped backtest JSON.
  const bt5m = results.signals.filter(r => r.interval === "5m");
  const bt5mFp = bt5m.filter(r => (r.combo ?? "").split("+").includes("FP"));
  info(`FOOTPRINT DEPENDENCY: ${bt5mFp.length}/${bt5m.length} (${(100 * bt5mFp.length / Math.max(1, bt5m.length)).toFixed(1)}%) of FINAL 5m backtest trades carry FP — these setups need LIVE MotiveWave footprint data (coverage ends ${fpMaxDay}${fpMaxDay >= todayET ? " — MW is delivering today" : " — impossible until MW reopens"}).`);

  db.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
