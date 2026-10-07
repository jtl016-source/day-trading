// scripts/fact-engine-parity.test.ts
// ═════════════════════════════════════════════════════════════════════════════
// LIVE-vs-BACKTEST PARITY TEST (mission 2026-07-17: "make the program's signals match
// the backtest signals"). Runs the fact engine over a FIXED recent day BOTH ways:
//
//   HARNESS side  — scripts/fact-engine-backtest.ts's own loadData() + enginePass()
//                   (the exact input builder every backtest run uses).
//   ADAPTER side  — an input built with the LITERAL live construction code
//                   (@shared/live-adapter, imported by market.tsx itself) over candles
//                   served by the RUNNING dev server's /api/data/cached-continuous —
//                   the same bytes the browser receives — plus the live defaults:
//                   showETH=true, showVector=true (secondary fetches), zones=[],
//                   dayZones from /api/yellowbox/day-zones, footprint = REAL 5m rows
//                   only, settings {ZONE_REACTION_PTS:2, YELLOWBOX_SOLO:false},
//                   qualityGateEnabled=true, gateData omitted (→ imported
//                   QUALITY_GATE — exactly what market.tsx does), ict/fractal/
//                   fractalGeo default ON, liveLevels omitted (PML/TML facts are
//                   live-edge-only by construction — zero effect on a past day).
//
// It asserts the two signal sets for the fixed day are IDENTICAL per interval on
// (fireTs, direction, signalType, entry, tp1, tp2, sl, label). Any construction
// drift between market.tsx and the harness becomes a failure here.
//
// REQUIRES the dev server on http://127.0.0.1:3000 (npm run dev) — the adapter side
// deliberately consumes the real serving path instead of a mirror that could rot.
//
// KNOWN, ACCEPTED input differences (documented, not drift):
//   • context window length — live loads the scrubber window (last ~90 trading days);
//     the harness loads from Jan-1 for the yellowbox walk-forward. Both are months of
//     context; the engine is causal, and the assertions below prove the fixed day's
//     signal sets still agree exactly.
//   • liveLevels (PML/TML) — live-only facts, backtestable:false, live-edge-only.
//   • live in-memory forming bars — exist only at the live edge, not on a past day.
// ═════════════════════════════════════════════════════════════════════════════
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runFactEngine, INTERVAL_SEC, type Interval, type FactSignal, type FpImbalanceZone } from "../shared/fact-engine";
import { QUALITY_GATE } from "../shared/quality-gate";
import {
  buildBaseCandles, normalizeServed15m, deriveEngineSlices, buildFootprintMap, type LiveCandle,
} from "../shared/live-adapter";
import { artifactsDir } from "../shared/artifacts-dir"; // BAXTER_ARTIFACTS_DIR (2026-08-02)
import { etWallToEpoch, sessionDayKey, weekdayOfKey } from "../shared/yellowbox-core";
import { loadData, enginePass } from "./fact-engine-backtest";

const BASE_URL = process.env.PARITY_BASE_URL ?? "http://127.0.0.1:3000";
const SYMBOL = "MES";
/** The fixed comparison day (ET). Recent, completed, inside the 3-month window and the
 *  live 90-day scrubber window. Bump deliberately when the window moves past it. */
const FIXED_DAY = "2026-07-14";
// market.tsx windowSize_v4 default. Override (PARITY_WINDOW_DAYS) exists for the
// context-length experiment: a large value makes the adapter's array start match the
// harness's Jan-1 lookback, isolating construction drift from context-length effects.
const WINDOW_SIZE_DAYS = Number(process.env.PARITY_WINDOW_DAYS ?? 90);
const INTERVALS: Interval[] = ["1m", "5m", "15m", "60m"];

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(path.resolve(__dir, ".."), "data", "app.db");

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
}

// market.tsx dateToTs (VERBATIM: UTC midnight of the day string)
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

function sigKey(s: FactSignal): string {
  // RISK DISPLAY (2026-07-30): comboKey + riskFlags are compared field-for-field too — a
  // divergent flag set (e.g. one side missing the dayRangeMedian input) is construction drift.
  // POSITION SIZING (2026-08-02): suggestedContracts compared field-for-field as well — both
  // sides derive it from the SAME gate data (suggestedContractsFor), so any mismatch is drift.
  return `${s.time}|${s.direction}|${s.signalType}|${s.price}|${s.tp1}|${s.tp2}|${s.sl}|${s.label}`
    + `|${s.comboKey ?? ""}|${(s.riskFlags ?? []).join(",")}|${s.suggestedContracts ?? ""}`;
}

async function main(): Promise<void> {
  // ── Server reachability (hard requirement — no silent skip) ──
  try {
    await getJson(`${BASE_URL}/api/data/cached-days/${SYMBOL}`);
  } catch (err) {
    console.error(`FAIL  dev server unreachable at ${BASE_URL} — the parity test consumes the real serving path; start it with: npm run dev`);
    console.error(`      (${(err as Error).message})`);
    process.exit(1);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const dayStart = etWallToEpoch(FIXED_DAY, 0, 0);
  const dayEnd = dayStart + 86400;

  // ── ADAPTER-side shared fetches (mirror market.tsx's queries + defaults) ──
  const daysResp = await getJson<{ days: Array<{ date: string }> }>(`${BASE_URL}/api/data/cached-days/${SYMBOL}`);
  const todayStr = new Date().toISOString().split("T")[0];
  const sortedDays = [...(daysResp.days ?? [])].filter(d => d.date <= todayStr).sort((a, b) => a.date.localeCompare(b.date));
  if (sortedDays.length < Math.min(WINDOW_SIZE_DAYS, 90)) throw new Error(`only ${sortedDays.length} cached days — need ${Math.min(WINDOW_SIZE_DAYS, 90)}`);
  const windowedDays = sortedDays.slice(Math.max(0, sortedDays.length - WINDOW_SIZE_DAYS));
  const fromTs = dateToTs(windowedDays[0].date, 0);
  const toTs = Math.min(nowSec + 86400, nowSec + 3600); // market.tsx stableToTs/toTs

  const cc = (iv: string): Promise<ServedCandles> =>
    getJson<ServedCandles>(`${BASE_URL}/api/data/cached-continuous/${SYMBOL}/${iv}?from=${fromTs}&to=${toTs}`);
  const [served1m, served5m, served15m, served60m] = await Promise.all([cc("1m"), cc("5m"), cc("15m"), cc("60m")]);
  const servedByIv: Record<Interval, ServedCandles> = { "1m": served1m, "5m": served5m, "15m": served15m, "60m": served60m };
  console.log(`[parity] served: 1m=${served1m.candles.length} 5m=${served5m.candles.length} 15m=${served15m.candles.length}(res ${served15m.resolution}) 60m=${served60m.candles.length}  window ${windowedDays[0].date}..${todayStr}`);

  const dz = await getJson<{ days: Array<{ dayKeyET: string; sessionStartTs: number; sessionEndTs: number; boxTop: number; boxBottom: number; initRes: number; initSup: number }> }>(
    `${BASE_URL}/api/yellowbox/day-zones?symbol=${SYMBOL}&fromTs=${fromTs}&toTs=${toTs}`);
  const feDayZones = (dz.days ?? []).map(d => ({
    dayKeyET: d.dayKeyET, sessionStartTs: d.sessionStartTs, sessionEndTs: d.sessionEndTs,
    boxTop: d.boxTop, boxBottom: d.boxBottom, initRes: d.initRes, initSup: d.initSup,
  }));
  console.log(`[parity] day-zones served: ${feDayZones.length}`);

  // Footprint (REAL 5m rows only — the only interval with footprint data in the DB;
  // same source the live ref is filled from).
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const fpRows = db.prepare(
    `SELECT time, data FROM footprint_candles WHERE symbol=? AND interval='5m' AND complete=1`
  ).all(SYMBOL) as Array<{ time: number; data: string }>;
  db.close();
  const fpByTime = new Map<number, { imbalances: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> }>();
  for (const r of fpRows) {
    try {
      const d = JSON.parse(r.data) as { imbalances?: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number }> };
      if (d.imbalances?.length) fpByTime.set(r.time, { imbalances: d.imbalances });
    } catch { /* malformed row — no fact */ }
  }

  // RISK DISPLAY (2026-07-30): the adapter sources its dead-tape baseline from the server
  // endpoint (exactly like market.tsx). The harness computes its own through the SHARED
  // shared/day-range-median.ts implementation — assert the two are EQUAL, then feed the
  // server value into the adapter engine input (any divergence = flag-level drift).
  const riskStats = await getJson<{ medianDayRange: number; medianDays: number; windowFromKey: string }>(
    `${BASE_URL}/api/risk/combo-stats`);
  console.log(`[parity] risk combo-stats: medianDayRange=${riskStats.medianDayRange} over ${riskStats.medianDays} days (window from ${riskStats.windowFromKey})`);

  // ── HARNESS side: the backtest's own loader + input builder ──
  console.log(`[parity] loading harness data (scripts/fact-engine-backtest.ts loadData)...`);
  const L = loadData();
  ok(`dead-tape baseline: server medianDayRange == harness (${riskStats.medianDayRange} vs ${L.dayRangeMedian})`,
    riskStats.medianDayRange === L.dayRangeMedian,
    `server=${riskStats.medianDayRange} (${riskStats.medianDays} days) harness=${L.dayRangeMedian} (${L.dayRangeMedianDays} days) — shared/day-range-median.ts drifted or the server window key moved`);
  const harnessByIv = enginePass(L, { gate: true, gateData: QUALITY_GATE, label: "parity-harness" }, nowSec);

  // ── Per-interval comparison on the fixed day ──
  for (const iv of INTERVALS) {
    const raw = servedByIv[iv];
    const candleData: LiveCandle[] = iv === "15m" ? normalizeServed15m(raw.candles, raw.resolution) : raw.candles;
    const windowedCandles = buildBaseCandles(candleData, /*showETH*/ true, nowSec);
    const { slices } = deriveEngineSlices({
      interval: iv,
      windowedCandles,
      raw1mCandles: iv !== "1m" ? served1m.candles : undefined,
      rawCandles: raw.candles,
      raw60mCandles: iv !== "60m" ? served60m.candles : undefined,
    });
    // Live's footprintCandlesRef holds 5m-BASED footprint candles on BOTH the 5m and the 15m
    // charts (market.tsx: `interval === "15m" ? "5m" : interval` — "footprint runs on 5m base",
    // shipped 2026-05-27), and the DB has real footprints for 5m alone. So 15m primaries look
    // the 5m rows up at their 900-aligned bar times (buildFootprintMap over the 15m
    // windowedCandles — 900 % 300 == 0), while 1m/60m primaries get NO footprint zones.
    // (Feeding 5m zones into the 1m primary was this test's own first bug: at 300-aligned 1m
    // bars the stray zones acted as contras and shifted firings by a bar.)
    const footprintByTime: Map<number, FpImbalanceZone[]> = (iv === "5m" || iv === "15m")
      ? buildFootprintMap(windowedCandles, t => fpByTime.get(t))
      : new Map();

    const adapterFired = runFactEngine({
      primary: iv,
      slices,
      zones: [], // no uploaded milk zones (live default state)
      dayZones: feDayZones,
      footprintByTime,
      settings: { ZONE_REACTION_PTS: 2.0, YELLOWBOX_SOLO: false },
      nowSec,
      qualityGateEnabled: true,
      // gateData omitted — falls back to the imported QUALITY_GATE, same as market.tsx
      // ict/fractal/fractalGeo omitted — default ON, same as the live toggles' defaults
      // liveLevels omitted — live-edge-only facts, no effect on a past day
      // RISK DISPLAY (2026-07-30): the server-served dead-tape baseline, same as market.tsx
      dayRangeMedian: riskStats.medianDayRange > 0 ? riskStats.medianDayRange : undefined,
    });

    const adapterDay = adapterFired.filter(s => s.time >= dayStart && s.time < dayEnd);
    const harnessDay = harnessByIv[iv].filter(s => s.time >= dayStart && s.time < dayEnd);

    const aKeys = new Map(adapterDay.map(s => [sigKey(s), s]));
    const hKeys = new Map(harnessDay.map(s => [sigKey(s), s]));
    const onlyAdapter = [...aKeys.keys()].filter(k => !hKeys.has(k));
    const onlyHarness = [...hKeys.keys()].filter(k => !aKeys.has(k));

    const detail = [
      `adapter=${adapterDay.length} harness=${harnessDay.length}`,
      ...onlyAdapter.map(k => `ADAPTER-ONLY  ${k}`),
      ...onlyHarness.map(k => `HARNESS-ONLY  ${k}`),
    ].join("\n      ");
    ok(`parity ${iv} @ ${FIXED_DAY}: identical signal sets (n=${harnessDay.length})`,
      onlyAdapter.length === 0 && onlyHarness.length === 0, detail);
  }

  // ═══ SOURCE-AWARE PERSISTENCE PARITY (2026-07-31, "live-fired records are permanent") ═══
  // RULE ENCODED: on SETTLED session days (strictly before today's ET session — same-day rows
  // are the documented provenance-versioned drift class), the standing JSON's trade set and
  // signal_history must agree, EXCEPT rows where the DB says source='live' — the EXPECTED
  // asymmetry: a live-fired record is permanent, the regen replay yields to it (collision),
  // and a live outcome update upgrades a regen row to 'live'. Every EXTRA DB window row on a
  // settled day must itself be source='live' (from now on only live tabs append outside regen).
  // BAXTER_ARTIFACTS_DIR (2026-08-02): the standing JSON lives in the relocated artifacts dir
  // when the env is set (repo root remains the default) — same resolver the harness writes with,
  // so this assertion can never silently skip after the relocation.
  const RESULTS_JSON = path.join(artifactsDir(path.resolve(__dir, "..")), "fact-engine-backtest-results.json");
  if (fs.existsSync(RESULTS_JSON)) {
    const doc = JSON.parse(fs.readFileSync(RESULTS_JSON, "utf8")) as {
      meta: { symbol: string; emissionStartTs: number };
      signals: Array<{ fireTs: number; interval: string; direction: string; outcome: string; pointsResult: number | null; sessionDay: string }>;
    };
    const todayKey = sessionDayKey(nowSec);
    const DB_OUTCOME: Record<string, string> = { tp1: "win_tp1", tp2: "win_tp2", sl: "loss", eod: "eod", open: "open" };
    const pdb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const dbRows = pdb.prepare(
      `SELECT interval, timestamp, direction, outcome, points_result, source FROM signal_history WHERE symbol=? AND timestamp>=?`
    ).all(doc.meta.symbol, doc.meta.emissionStartTs) as Array<{ interval: string; timestamp: number; direction: string; outcome: string | null; points_result: number | null; source: string | null }>;
    pdb.close();
    const dbByKey = new Map(dbRows.map(r => [`${r.interval}|${r.timestamp}|${r.direction}`, r]));
    const jsonKeys = new Set<string>();
    let compared = 0, missing = 0, mismatched = 0, liveAsym = 0, extraLive = 0, extraCatchup = 0, extraNonLive = 0;
    const detail: string[] = [];
    for (const s of doc.signals) {
      const key = `${s.interval}|${s.fireTs}|${s.direction}`;
      jsonKeys.add(key);
      if (s.sessionDay >= todayKey) continue;
      compared++;
      const row = dbByKey.get(key);
      if (!row) { missing++; if (detail.length < 8) detail.push(`MISSING in DB: ${key}`); continue; }
      if (row.source === "live") { liveAsym++; continue; } // EXPECTED asymmetry — the permanent live record outranks the replay
      const wantOutcome = DB_OUTCOME[s.outcome] ?? s.outcome;
      const ptsMatch = (s.pointsResult == null && row.points_result == null)
        || (s.pointsResult != null && row.points_result != null && Math.abs(s.pointsResult - row.points_result) < 0.01);
      if (row.outcome !== wantOutcome || !ptsMatch) {
        mismatched++;
        if (detail.length < 8) detail.push(`MISMATCH ${key}: JSON ${wantOutcome}/${s.pointsResult} vs DB ${row.outcome}/${row.points_result} (source=${row.source})`);
      }
    }
    for (const r of dbRows) {
      if (sessionDayKey(r.timestamp) >= todayKey) continue;
      const key = `${r.interval}|${r.timestamp}|${r.direction}`;
      if (jsonKeys.has(key)) continue;
      if (r.source === "live") { extraLive++; continue; } // permanent live rows (incl. keys the regen yielded on)
      // SCHEDULER (2026-08-02): intraday catch-up back-fills are REGEN-CLASS — the next
      // --persist wipes and replaces them. Until that regen they are EXPECTED extras (the
      // standing JSON predates the fire), so they are the second allowed asymmetry class.
      if (r.source === "catchup") { extraCatchup++; continue; }
      extraNonLive++;
      if (detail.length < 8) detail.push(`EXTRA non-live DB row: ${key} (source=${r.source ?? "NULL"})`);
    }
    ok(`source-aware persistence parity: standing JSON == DB on settled days modulo source='live'/'catchup' rows `
      + `(${compared} compared, ${liveAsym} live asymmetries + ${extraLive} extra live + ${extraCatchup} catch-up rows — expected)`,
      missing === 0 && mismatched === 0 && extraNonLive === 0, detail.join("\n      "));
  } else {
    console.log(`[parity] ${RESULTS_JSON} absent — source-aware persistence parity skipped`);
  }

  // ═══ SOURCE-GUARD LIVE-ROUTE PROBE (2026-07-31): live row survives a regen + immutability ═══
  // Synthetic natural key on a settled weekday ~35 days back (session-legal 10:00 ET fire,
  // deliberately absurd prices so it can never read as a real record). Exercises the RUNNING
  // server's collision + guard semantics end-to-end; cleaned up via the DELETE route (the live
  // retraction path, intentionally NOT source-blocked) in `finally`.
  {
    let probeTs = 0;
    for (let back = 35; back < 45 && !probeTs; back++) {
      const key = new Date((nowSec - back * 86400) * 1000).toISOString().slice(0, 10);
      const wd = weekdayOfKey(key);
      if (wd >= 1 && wd <= 5) probeTs = etWallToEpoch(key, 10, 0);
    }
    const base = {
      symbol: SYMBOL, interval: "1m", timestamp: probeTs, direction: "Long", riskLevel: "safe",
      signalType: "fact-engine", entry: 1000, tp1: 1010, tp2: 1020, sl: 990,
      label: "SOURCE-GUARD parity probe (synthetic, auto-cleaned)",
    };
    const post = async (row: Record<string, unknown>): Promise<{ inserted: number; skipped: number; collisions?: number }> => {
      const res = await fetch(`${BASE_URL}/api/signals/history`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signals: [row] }),
      });
      if (!res.ok) throw new Error(`probe POST → HTTP ${res.status}`);
      return res.json() as Promise<{ inserted: number; skipped: number; collisions?: number }>;
    };
    const readRow = (): { outcome: string | null; points_result: number | null; source: string | null; label: string | null } | undefined => {
      const d = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      const r = d.prepare(
        `SELECT outcome, points_result, source, label FROM signal_history WHERE symbol=? AND interval=? AND timestamp=? AND direction=?`
      ).get(SYMBOL, base.interval, base.timestamp, base.direction) as
        | { outcome: string | null; points_result: number | null; source: string | null; label: string | null } | undefined;
      d.close();
      return r;
    };
    try {
      const j1 = await post({ ...base, outcome: "win_tp1", exitPrice: 1010, exitTs: probeTs + 120, pointsResult: 10, source: "live" });
      const r1 = readRow();
      ok("source-guard probe: live-fired row inserted with source='live'",
        j1.inserted === 1 && r1?.source === "live" && r1?.outcome === "win_tp1", JSON.stringify({ j1, r1 }));
      const j2 = await post({ ...base, outcome: "loss", exitPrice: 990, exitTs: probeTs + 180, pointsResult: -10, label: "regen replay (must yield)", source: "regen" });
      const r2 = readRow();
      ok("source-guard probe: regen write COLLIDES — live row survives byte-for-byte",
        (j2.collisions ?? 0) === 1 && j2.inserted === 0 && r2?.outcome === "win_tp1" && r2?.points_result === 10
        && r2?.source === "live" && r2?.label === base.label, JSON.stringify({ j2, r2 }));
      const j3 = await post({ ...base, outcome: "loss", pointsResult: -10 }); // legacy client — no source field
      const r3 = readRow();
      ok("source-guard probe: legacy NULL-source write collides too (NULL treated as regen)",
        (j3.collisions ?? 0) === 1 && r3?.outcome === "win_tp1" && r3?.source === "live", JSON.stringify({ j3, r3 }));
      const j4 = await post({ ...base, outcome: "loss", exitPrice: 990, pointsResult: -10, source: "live" });
      const r4 = readRow();
      ok("source-guard probe: live-path win_tp1→loss REJECTED by the outcome matrix (record + source intact)",
        j4.inserted === 1 && r4?.outcome === "win_tp1" && r4?.points_result === 10 && r4?.source === "live", JSON.stringify({ j4, r4 }));
      const j5 = await post({ ...base, outcome: "win_tp2", exitPrice: 1020, exitTs: probeTs + 300, pointsResult: 20, source: "live" });
      const r5 = readRow();
      ok("source-guard probe: live-path win_tp1→win_tp2 upgrade still allowed on a live row",
        j5.inserted === 1 && r5?.outcome === "win_tp2" && r5?.points_result === 20 && r5?.source === "live", JSON.stringify({ j5, r5 }));
    } finally {
      const del = await fetch(`${BASE_URL}/api/signals/history`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: SYMBOL, interval: base.interval, timestamp: base.timestamp, direction: base.direction }),
      }).catch(() => null);
      ok("source-guard probe: synthetic row cleaned up (DELETE retraction path intact)",
        readRow() === undefined, `DELETE HTTP ${del ? (del as Response).status : "unreachable"}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
