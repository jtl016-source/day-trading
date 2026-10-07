/**
 * exits2-min-tp-floor-counterfactual.ts — READ-ONLY refutation check for claim "exits-2".
 *
 * Question: the colleague's "actionable" is to stop anchoring a 1m target below a floor. The only
 * executable knob the engine already has for that is ExitCalibration.MIN_TP1_PTS: an obstacle nearer
 * than it BLOCKS the fire ("no room"). Because blocked fires no longer consume the cooldown and the
 * ONE_OPEN_PER_DIRECTION slot, the P&L effect cannot be read by subtracting the anchored fires from
 * the book — the chain re-fires other bars. This script re-runs the SHIPPED gated 1m pass with the
 * production defaults (baseline, must reproduce the dataset) and with MIN_TP1_PTS = 8 / 10 / 12.25,
 * and resolves every fire by the canonical carry walk on the server-served 1m bars (the same bars
 * the v2 dataset uses). Nothing is written to the project; output goes to C:\BaxterSandbox\analysis\refute\exits2\.
 *
 *   npx tsx scripts/analysis/exits2-min-tp-floor-counterfactual.ts
 */
import * as fs from "node:fs";
import { loadData, INTERVALS, type Loaded } from "../fact-engine-backtest";
import { runFactEngine, FACT_ENGINE_DEFAULTS, type FactSignal, type Interval, type ExitCalibration } from "../../shared/fact-engine";
import { deriveEngineSlices } from "../../shared/live-adapter";
import { QUALITY_GATE } from "../../shared/quality-gate";
import { walkOutcomeCanonical } from "../../shared/outcome-resolver";
import type { FiringCandle } from "../../shared/firing/types";

const OUT = "C:/BaxterSandbox/analysis/refute/exits2";
const FR = 1.0;
const WINDOW_FROM = Date.UTC(2026, 5, 24, 4) / 1000; // 2026-06-24 00:00 ET (EDT)
const H2_FROM = Date.UTC(2026, 7, 13, 4) / 1000;     // 2026-08-13 00:00 ET
const r2 = (v: number) => Math.round(v * 100) / 100;

// ET wall clock via Intl (never a fixed offset)
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function etParts(ts: number) { const p: Record<string, string> = {}; for (const x of fmt.formatToParts(new Date(ts * 1000))) p[x.type] = x.value; return { y: +p.year, mo: +p.month, d: +p.day, hh: Number(p.hour) % 24, mm: +p.minute }; }
function sessionDayKey(ts: number): string { const p = etParts(ts); let ms = Date.UTC(p.y, p.mo - 1, p.d); if (p.hh >= 18) ms += 86400000; return new Date(ms).toISOString().slice(0, 10); }
function wallEpoch(key: string, hh: number, mm: number): number {
  const [y, mo, d] = key.split("-").map(Number);
  let g = Date.UTC(y, mo - 1, d, hh, mm) / 1000 + 4 * 3600;
  for (let k = 0; k < 5; k++) { const p = etParts(g); const dayDiff = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(y, mo - 1, d)) / 86400000); const dmin = p.hh * 60 + p.mm - (hh * 60 + mm); if (!dayDiff && !dmin) return g; g -= dayDiff * 86400 + dmin * 60; }
  return g;
}

function gatedPass1m(L: Loaded, exit: Partial<ExitCalibration> | undefined, nowSec: number): FactSignal[] {
  const primary: Interval = "1m";
  const { slices } = deriveEngineSlices({ interval: primary, windowedCandles: L.candlesByIv[primary], raw1mCandles: undefined, rawCandles: L.servedByIv[primary], raw60mCandles: L.servedByIv["60m"] });
  const fired = runFactEngine({
    primary, slices, zones: [], dayZones: L.dayZones, footprintByTime: undefined, settings: {}, nowSec,
    qualityGateEnabled: true, gateData: QUALITY_GATE, ictEnabled: true, fractalEnabled: true, fractalGeoEnabled: true,
    dayRangeMedian: L.dayRangeMedian, deadTapeSuppressEnabled: true,
    exit,
  } as Parameters<typeof runFactEngine>[0]);
  return fired.filter(s => s.time >= L.emissionStartTs && s.time >= WINDOW_FROM);
}

interface Res { key: string; fireTs: number; entryTs: number; dir: string; entry: number; tp1: number; sl: number; tpDist: number; anchor: string; signalType: string; combo: string; half: string; outcome: string; points: number | null; exitTs: number | null; }
function resolve(L: Loaded, sigs: FactSignal[]): Res[] {
  const c1m = L.servedByIv["1m"] as unknown as FiringCandle[];
  const covered = L.lastDataTs;
  const out: Res[] = [];
  for (const s of sigs) {
    const isLong = s.direction === "Long";
    const entryTs = s.time + 60;
    const settleTs = wallEpoch(sessionDayKey(entryTs), 17, 0);
    const w = walkOutcomeCanonical({ bars: c1m, entryTs, entry: s.price, tp1: s.tp1, tp2: null, sl: s.sl, isLong, settleTs, barSec: 60, coveredThroughTs: covered, carryOvernight: true, tp1Only: FACT_ENGINE_DEFAULTS.TP1_ONLY } as Parameters<typeof walkOutcomeCanonical>[0]);
    let anchor = "default"; try { anchor = (JSON.parse((s as unknown as { confirmations?: string }).confirmations ?? "{}") as { anchor?: string }).anchor ?? "default"; } catch { /* default */ }
    const pts = w.exitPrice == null ? null : r2((w.exitPrice - s.price) * (isLong ? 1 : -1));
    out.push({ key: `1m|${s.time}|${s.direction}`, fireTs: s.time, entryTs, dir: s.direction, entry: s.price, tp1: s.tp1, sl: s.sl, tpDist: r2(Math.abs(s.tp1 - s.price)), anchor, signalType: s.signalType, combo: s.comboKey ?? "", half: s.time >= H2_FROM ? "H2" : "H1", outcome: w.outcome, points: pts, exitTs: w.exitTs ?? null });
  }
  return out;
}
function stats(rows: Res[]) {
  const P = rows.filter(r => r.outcome !== "open" && r.points != null).map(r => r.points as number);
  const n = P.length; if (!n) return { nFires: rows.length, n: 0 };
  let w = 0, g = 0, pos = 0, neg = 0; for (const p of P) { g += p; if (p > 0) w++; const nt = p - FR; if (nt > 0) pos += nt; else neg -= nt; }
  return { nFires: rows.length, n, winPct: r2(100 * w / n), net: r2(g / n - FR), total: r2(g - FR * n), pf: neg > 0 ? r2(pos / neg) : Infinity };
}
function summarize(label: string, rows: Res[]) {
  const by: Record<string, unknown> = { label, all: stats(rows), H1: stats(rows.filter(r => r.half === "H1")), H2: stats(rows.filter(r => r.half === "H2")) };
  for (const an of ["tabletop", "yellowbox", "zone", "default"]) { const P = rows.filter(r => r.anchor === an); if (P.length) by[an] = stats(P); }
  by.tpLt8 = stats(rows.filter(r => r.tpDist < 8));
  return by;
}

const L = loadData();
const nowSec = Math.floor(Date.now() / 1000);
const scenarios: Array<{ name: string; exit: Partial<ExitCalibration> | undefined }> = [
  { name: "baseline (MIN_TP1_PTS 3, shipped)", exit: undefined },
  { name: "MIN_TP1_PTS 8", exit: { MIN_TP1_PTS: 8 } },
  { name: "MIN_TP1_PTS 10", exit: { MIN_TP1_PTS: 10 } },
  { name: "MIN_TP1_PTS 12.25 (never anchor on 1m; near-obstacle fires blocked)", exit: { MIN_TP1_PTS: 12.25 } },
];
const results: Record<string, { summary: unknown; rows: Res[] }> = {};
let baseKeys = new Set<string>();
for (const sc of scenarios) {
  const t0 = Date.now();
  const sigs = gatedPass1m(L, sc.exit, nowSec);
  const rows = resolve(L, sigs);
  const summary = summarize(sc.name, rows);
  if (!baseKeys.size) baseKeys = new Set(rows.map(r => r.key));
  const newKeys = rows.filter(r => !baseKeys.has(r.key));
  const kept = rows.filter(r => baseKeys.has(r.key));
  results[sc.name] = { summary: { ...(summary as object), newFiresNotInBaseline: stats(newKeys), firesSharedWithBaseline: stats(kept), elapsedSec: r2((Date.now() - t0) / 1000) }, rows };
  console.log(`\n== ${sc.name} ==`);
  console.log(JSON.stringify(results[sc.name].summary, null, 1));
}
fs.writeFileSync(OUT + "/min-tp-floor-counterfactual.json", JSON.stringify({ meta: { generatedAt: new Date().toISOString(), windowFrom: WINDOW_FROM, h2From: H2_FROM, lastDataTs: L.lastDataTs, emissionStartTs: L.emissionStartTs }, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.summary])), rows: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.rows])) }, null, 1));
console.log("\nwrote", OUT + "/min-tp-floor-counterfactual.json");
