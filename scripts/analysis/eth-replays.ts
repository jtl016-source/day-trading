/**
 * scripts/analysis/eth-replays.ts — ANALYSIS ONLY (read-only DB, no persistence, no gate write).
 *
 * Information replays for the 2026-10-01 ETH build (Area E):
 *   (1) ETH_CONFLUENCE:false vs the current rules (what the overnight book is with side-entries only)
 *   (2) walk-forward shadow test of ETH_MIN_AGREEING_FACTS=3, ETH_VETO_FRACTAL_TWO_FACT=true, both
 *       (pick on H1 06-24..08-12, score on H2 08-13..10-01, per interval, de-clustered)
 *   (3) scheduled-news blackout (08:25–08:40 / 09:55–10:05 / FOMC 13:55–14:30 ET on release days):
 *       post-hoc removal on the shipped fire set + an engine replay with FactEngineInput.newsBlackouts
 *
 * Every variant is a FULL engine replay through the SAME loader + slice builder the harness and the
 * signal dataset use (scripts/fact-engine-backtest.ts loadData + an enginePass mirror that also
 * plumbs newsBlackouts/statsOut — fe-bt's enginePass does not take them yet). Outcomes are walked on
 * the SERVER-SERVED 1m bars (dataset v2 convention: the bars server/catchup.ts resolves on), carry
 * and Apex-16:55-flat. NET = gross − 1.0 pt/trade. "De-clustered" re-applies one-open-per-direction
 * per interval on the served-bar exit times (the engine's own one-open uses isolation-filtered
 * slices, so a few overlaps survive it).
 *
 * Outputs (only) to C:\BaxterSandbox\analysis\eth-build\replays\.
 * Run from the sandbox copy (outside OneDrive): npx tsx scripts/analysis/eth-replays.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadData, INTERVALS, type Loaded } from "../fact-engine-backtest";
import {
  runFactEngine, FACT_ENGINE_DEFAULTS, INTERVAL_SEC, newFactEngineRunStats,
  type FactSignal, type FactEngineSettings, type FactEngineRunStats, type Interval,
} from "../../shared/fact-engine";
import { QUALITY_GATE, comboKeyOf } from "../../shared/quality-gate";
import { deriveEngineSlices } from "../../shared/live-adapter";
import { walkOutcomeCanonical } from "../../shared/outcome-resolver";
import { etParts, etWallToEpoch, sessionDayKey } from "../../shared/yellowbox-core";
import type { FiringCandle } from "../../shared/firing/types";

const t0 = Date.now();
const el = (): string => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const OUT = "C:\\BaxterSandbox\\analysis\\eth-build\\replays";
fs.mkdirSync(OUT, { recursive: true });
const REPORT_FROM_KEY = "2026-06-24";
const H2_FROM_KEY = "2026-08-13";
const FRICTION = 1.0;
const ORDER_WINDOW = { from: 9 * 60 + 30, to: 15 * 60 + 15 }; // live armed order window (ET minutes)
const r2 = (x: number | null | undefined): number | null => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const pad = (n: number): string => String(n).padStart(2, "0");
const fmtEt = (t: number): string => { const p = etParts(t); return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`; };

// ═══════════════════════ NEWS CALENDAR 2026-06-24 .. 2026-10-01 (reconstructed) ═══════════════════════
// data/news-calendar.json starts 2026-10-01, so Jun 24 – Sep 30 is reconstructed from the SAME official
// schedule pages (read 2026-10-01 via WebFetch): BLS empsit/cpi/ppi/jolts, BEA news/schedule/full,
// Census retail/release_schedule.html, federalreserve.gov fomccalendars. ISM's calendar page redirects
// scripted and browser-pane fetches to an SSO login; ISM's PMI Reports page states the rule
// "Manufacturing PMI on the first business day of the month, Services PMI on the third business day,
// 10:00 ET" — those six dates are RULE-RECONSTRUCTED (flagged ism_rule) and were not read from a
// calendar row. The 2026-10-01 ISM Manufacturing print comes from data/news-calendar.json.
interface NewsEvent { date: string; timeET: "08:30" | "10:00" | "14:00"; event: string; source: string; tier: 1 | 2; ref: string; provenance: string }
const EVENTS: NewsEvent[] = [
  { date: "2026-06-25", timeET: "08:30", event: "GDP third", source: "BEA", tier: 2, ref: "Q1 2026 (third estimate)", provenance: "bea.gov/news/schedule/full" },
  { date: "2026-06-25", timeET: "08:30", event: "PCE", source: "BEA", tier: 1, ref: "May 2026 (Personal Income and Outlays)", provenance: "bea.gov/news/schedule/full" },
  { date: "2026-06-30", timeET: "10:00", event: "JOLTS", source: "BLS", tier: 2, ref: "May 2026", provenance: "bls.gov/schedule/news_release/jolts.htm" },
  { date: "2026-07-01", timeET: "10:00", event: "ISM Manufacturing PMI", source: "ISM", tier: 2, ref: "June 2026", provenance: "ism_rule (first business day)" },
  { date: "2026-07-02", timeET: "08:30", event: "Employment Situation", source: "BLS", tier: 1, ref: "June 2026", provenance: "bls.gov/schedule/news_release/empsit.htm" },
  { date: "2026-07-06", timeET: "10:00", event: "ISM Services PMI", source: "ISM", tier: 2, ref: "June 2026", provenance: "ism_rule (third business day; Jul 3 observed holiday)" },
  { date: "2026-07-14", timeET: "08:30", event: "CPI", source: "BLS", tier: 1, ref: "June 2026", provenance: "bls.gov/schedule/news_release/cpi.htm" },
  { date: "2026-07-15", timeET: "08:30", event: "PPI", source: "BLS", tier: 2, ref: "June 2026", provenance: "bls.gov/schedule/news_release/ppi.htm" },
  { date: "2026-07-16", timeET: "08:30", event: "Retail Sales", source: "Census", tier: 2, ref: "June 2026 (Advance Monthly Sales)", provenance: "census.gov/retail/release_schedule.html" },
  { date: "2026-07-29", timeET: "14:00", event: "FOMC", source: "Federal Reserve", tier: 1, ref: "Jul 28-29 2026 meeting (statement; press conference 14:30)", provenance: "federalreserve.gov/monetarypolicy/fomccalendars.htm" },
  { date: "2026-07-30", timeET: "08:30", event: "GDP advance", source: "BEA", tier: 1, ref: "Q2 2026", provenance: "bea.gov/news/schedule/full" },
  { date: "2026-07-30", timeET: "08:30", event: "PCE", source: "BEA", tier: 1, ref: "June 2026 (Personal Income and Outlays)", provenance: "bea.gov/news/schedule/full" },
  { date: "2026-08-03", timeET: "10:00", event: "ISM Manufacturing PMI", source: "ISM", tier: 2, ref: "July 2026", provenance: "ism_rule (first business day)" },
  { date: "2026-08-04", timeET: "10:00", event: "JOLTS", source: "BLS", tier: 2, ref: "June 2026", provenance: "bls.gov/schedule/news_release/jolts.htm" },
  { date: "2026-08-05", timeET: "10:00", event: "ISM Services PMI", source: "ISM", tier: 2, ref: "July 2026", provenance: "ism_rule (third business day)" },
  { date: "2026-08-07", timeET: "08:30", event: "Employment Situation", source: "BLS", tier: 1, ref: "July 2026", provenance: "bls.gov/schedule/news_release/empsit.htm" },
  { date: "2026-08-12", timeET: "08:30", event: "CPI", source: "BLS", tier: 1, ref: "July 2026", provenance: "bls.gov/schedule/news_release/cpi.htm" },
  { date: "2026-08-13", timeET: "08:30", event: "PPI", source: "BLS", tier: 2, ref: "July 2026", provenance: "bls.gov/schedule/news_release/ppi.htm" },
  { date: "2026-08-14", timeET: "08:30", event: "Retail Sales", source: "Census", tier: 2, ref: "July 2026 (Advance Monthly Sales)", provenance: "census.gov/retail/release_schedule.html" },
  { date: "2026-08-26", timeET: "08:30", event: "GDP second", source: "BEA", tier: 2, ref: "Q2 2026 (second estimate)", provenance: "bea.gov/news/schedule/full" },
  { date: "2026-08-26", timeET: "08:30", event: "PCE", source: "BEA", tier: 1, ref: "July 2026 (Personal Income and Outlays)", provenance: "bea.gov/news/schedule/full" },
  { date: "2026-09-01", timeET: "10:00", event: "ISM Manufacturing PMI", source: "ISM", tier: 2, ref: "August 2026", provenance: "ism_rule (first business day)" },
  { date: "2026-09-01", timeET: "10:00", event: "JOLTS", source: "BLS", tier: 2, ref: "July 2026", provenance: "bls.gov/schedule/news_release/jolts.htm" },
  { date: "2026-09-03", timeET: "10:00", event: "ISM Services PMI", source: "ISM", tier: 2, ref: "August 2026", provenance: "ism_rule (third business day)" },
  { date: "2026-09-04", timeET: "08:30", event: "Employment Situation", source: "BLS", tier: 1, ref: "August 2026", provenance: "bls.gov/schedule/news_release/empsit.htm" },
  { date: "2026-09-10", timeET: "08:30", event: "PPI", source: "BLS", tier: 2, ref: "August 2026", provenance: "bls.gov/schedule/news_release/ppi.htm" },
  { date: "2026-09-11", timeET: "08:30", event: "CPI", source: "BLS", tier: 1, ref: "August 2026", provenance: "bls.gov/schedule/news_release/cpi.htm" },
  { date: "2026-09-16", timeET: "08:30", event: "Retail Sales", source: "Census", tier: 2, ref: "August 2026 (Advance Monthly Sales)", provenance: "census.gov/retail/release_schedule.html" },
  { date: "2026-09-16", timeET: "14:00", event: "FOMC", source: "Federal Reserve", tier: 1, ref: "Sep 15-16 2026 meeting with SEP (statement; press conference 14:30)", provenance: "federalreserve.gov/monetarypolicy/fomccalendars.htm" },
  { date: "2026-09-29", timeET: "10:00", event: "JOLTS", source: "BLS", tier: 2, ref: "August 2026", provenance: "bls.gov/schedule/news_release/jolts.htm" },
  { date: "2026-09-30", timeET: "08:30", event: "GDP third", source: "BEA", tier: 2, ref: "Q2 2026 (third estimate)", provenance: "bea.gov/news/schedule/full" },
  { date: "2026-09-30", timeET: "08:30", event: "PCE", source: "BEA", tier: 1, ref: "August 2026 (Personal Income and Outlays)", provenance: "bea.gov/news/schedule/full" },
  { date: "2026-10-01", timeET: "10:00", event: "ISM Manufacturing PMI", source: "ISM", tier: 2, ref: "September 2026", provenance: "data/news-calendar.json" },
];
const RULES: Record<string, { from: [number, number]; to: [number, number]; fomcOnly?: boolean }> = {
  "08:30": { from: [8, 25], to: [8, 40] },
  "10:00": { from: [9, 55], to: [10, 5] },
  "14:00": { from: [13, 55], to: [14, 30], fomcOnly: true },
};
interface Win { fromSec: number; toSec: number; label: string; date: string; printET: string; events: string[]; tier: number }
function buildWindows(): Win[] {
  const by = new Map<string, NewsEvent[]>();
  for (const e of EVENTS) { const k = `${e.date}|${e.timeET}`; (by.get(k) ?? by.set(k, []).get(k)!).push(e); }
  const out: Win[] = [];
  for (const [k, evs] of by) {
    const [date, printET] = k.split("|");
    const rule = RULES[printET]; if (!rule) continue;
    if (rule.fomcOnly && !evs.some(e => e.event === "FOMC")) continue;
    out.push({
      fromSec: etWallToEpoch(date, rule.from[0], rule.from[1]), toSec: etWallToEpoch(date, rule.to[0], rule.to[1]),
      label: `${printET} ${evs.map(e => e.event).join("+")} ${date}`, date, printET, events: evs.map(e => e.event), tier: Math.min(...evs.map(e => e.tier)),
    });
  }
  return out.sort((a, b) => a.fromSec - b.fromSec);
}
const WINDOWS = buildWindows();
for (const e of EVENTS) { const wd = new Date(`${e.date}T12:00:00Z`).getUTCDay(); if (wd === 0 || wd === 6) throw new Error(`weekend event ${e.date}`); }
fs.writeFileSync(path.join(OUT, "news-calendar-2026-06-24_10-01.json"), JSON.stringify({
  generatedAt: new Date().toISOString(), note: "Reconstructed Jun 24 – Sep 30 2026 from the official agency pages (see provenance); ISM dates by ISM's stated first/third-business-day rule (calendar page is SSO-walled). Oct 1 from data/news-calendar.json. Windows are the owner-approved blackoutRules, half-open [from,to) ET wall clock.",
  events: EVENTS, windows: WINDOWS.map(w => ({ ...w, fromET: fmtEt(w.fromSec), toET: fmtEt(w.toSec) })),
}, null, 1));
console.log(`[rp] news windows: ${WINDOWS.length} (${EVENTS.length} events; ${EVENTS.filter(e => e.provenance.startsWith("ism_rule")).length} ISM rule-reconstructed)`);
const windowAt = (t: number): Win | null => { for (const w of WINDOWS) if (t >= w.fromSec && t < w.toSec) return w; return null; };

// ═══════════════════════ LOAD + ENGINE PASS MIRROR ═══════════════════════
const L: Loaded = loadData();
const nowSec = Math.floor(Date.now() / 1000);
const reportFromTs = etWallToEpoch(REPORT_FROM_KEY, 0, 0);
console.log(`[rp] loaded: 1m ${L.servedByIv["1m"].length} served bars, emissionStart ${fmtEt(L.emissionStartTs)}, dead-tape median ${L.dayRangeMedian} (${L.dayRangeMedianDays} d)  ${el()}`);

interface PassOpts { gate: boolean; settings?: Partial<FactEngineSettings>; newsBlackouts?: Array<{ fromSec: number; toSec: number; label: string }>; statsOut?: FactEngineRunStats }
/** Mirror of scripts/fact-engine-backtest.ts enginePass (same deriveEngineSlices inputs, footprint
 *  on 5m/15m only, no zones/liveLevels, dead-tape ON, shipped gate data) + newsBlackouts/statsOut. */
function enginePassX(opts: PassOpts, label: string): Record<Interval, FactSignal[]> {
  const out = {} as Record<Interval, FactSignal[]>;
  for (const primary of INTERVALS) {
    const { slices } = deriveEngineSlices({
      interval: primary,
      windowedCandles: L.candlesByIv[primary],
      raw1mCandles: primary !== "1m" ? L.servedByIv["1m"] : undefined,
      rawCandles: L.servedByIv[primary],
      raw60mCandles: primary !== "60m" ? L.servedByIv["60m"] : undefined,
    });
    const fired = runFactEngine({
      primary, slices, zones: [], dayZones: L.dayZones,
      footprintByTime: primary === "5m" || primary === "15m" ? L.fpMap : undefined,
      settings: opts.settings ?? {},
      nowSec,
      qualityGateEnabled: opts.gate, gateData: QUALITY_GATE,
      ictEnabled: true, fractalEnabled: true, fractalGeoEnabled: true,
      dayRangeMedian: L.dayRangeMedian, deadTapeSuppressEnabled: true,
      newsBlackouts: opts.newsBlackouts, statsOut: opts.statsOut,
    });
    out[primary] = fired.filter(s => s.time >= Math.max(L.emissionStartTs, reportFromTs));
    console.log(`[rp] ${label} ${primary}: ${out[primary].length} fires in window  ${el()}`);
  }
  return out;
}

// ═══════════════════════ OUTCOME WALK (served 1m bars; carry + Apex 16:55) ═══════════════════════
const c1m = L.servedByIv["1m"] as unknown as FiringCandle[];
const covered1m = Math.min(c1m[c1m.length - 1].time + 60, nowSec);
interface OC { outcome: string; exitTs: number | null; points: number | null; net: number | null; mae: number; mfe: number }
function walk(entryTs: number, entry: number, isLong: boolean, tp1: number, sl: number, carry: boolean, settle: number): OC {
  const w = walkOutcomeCanonical({ bars: c1m, entryTs, entry, tp1, tp2: null, sl, isLong, settleTs: settle, barSec: 60, coveredThroughTs: covered1m, carryOvernight: carry, tp1Only: FACT_ENGINE_DEFAULTS.TP1_ONLY });
  const pts = w.exitPrice == null ? null : r2((w.exitPrice - entry) * (isLong ? 1 : -1));
  return { outcome: w.outcome, exitTs: w.exitTs, points: pts, net: pts == null ? null : r2(pts - FRICTION), mae: r2(w.mae) ?? 0, mfe: r2(w.mfe) ?? 0 };
}
interface Trade {
  key: string; iv: Interval; dir: "Long" | "Short"; fireTs: number; entryTs: number; entry: number; tp1: number; sl: number;
  session: "RTH" | "ETH"; signalType: string; comboKey: string; counted: number; dateET: string; timeET: string; half: "H1" | "H2";
  sessionDay: string; inOrderWindow: boolean; newsWindow: string | null; carry: OC; apex: OC; admitted: { carry: boolean; apex: boolean };
}
function toTrades(byIv: Record<Interval, FactSignal[]>): Trade[] {
  const rows: Trade[] = [];
  for (const iv of INTERVALS) for (const s of byIv[iv]) {
    const entryTs = s.time + INTERVAL_SEC[iv];
    const p = etParts(entryTs);
    const dateET = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
    const mins = p.hh * 60 + p.mm;
    const sd = sessionDayKey(entryTs);
    const isLong = s.direction === "Long";
    const w = windowAt(entryTs);
    rows.push({
      key: `${iv}|${s.time}|${s.direction}`, iv, dir: s.direction as "Long" | "Short", fireTs: s.time, entryTs, entry: s.price, tp1: s.tp1, sl: s.sl,
      session: s.session, signalType: s.signalType, comboKey: s.comboKey ?? comboKeyOf(s.facts), counted: s.facts.filter(f => f.counted).length,
      dateET, timeET: `${pad(p.hh)}:${pad(p.mm)}`, half: dateET < H2_FROM_KEY ? "H1" : "H2", sessionDay: sd,
      inOrderWindow: mins >= ORDER_WINDOW.from && mins < ORDER_WINDOW.to && p.hh < 17, newsWindow: w ? w.label : null,
      carry: walk(entryTs, s.price, isLong, s.tp1, s.sl, true, etWallToEpoch(sd, 17, 0)),
      apex: walk(entryTs, s.price, isLong, s.tp1, s.sl, false, etWallToEpoch(sd, 16, 55)),
      admitted: { carry: true, apex: true },
    });
  }
  rows.sort((a, b) => a.entryTs - b.entryTs || a.iv.localeCompare(b.iv));
  // De-cluster: one open trade per direction × interval on the served-bar exit times (per mode).
  for (const mode of ["carry", "apex"] as const) {
    const last = new Map<string, number>();
    for (const t of rows) {
      const k = `${t.iv}|${t.dir}`;
      const lastExit = last.get(k) ?? -Infinity;
      if (t.entryTs < lastExit) { t.admitted[mode] = false; continue; }
      const oc = t[mode];
      last.set(k, oc.exitTs == null ? Infinity : oc.exitTs);
    }
  }
  return rows;
}

// ═══════════════════════ METRICS ═══════════════════════
interface M { n: number; open: number; wins: number; winPct: number | null; grossExp: number | null; netExp: number | null; pf: number | null; gross: number; net: number; maxDD: number; days: number }
function metrics(ts: Trade[], mode: "carry" | "apex"): M {
  const closed = ts.filter(t => t[mode].outcome === "win_tp1" || t[mode].outcome === "loss" || t[mode].outcome === "eod").sort((a, b) => a.entryTs - b.entryTs);
  let wins = 0, gross = 0, net = 0, pos = 0, neg = 0, cum = 0, peak = 0, dd = 0;
  const days = new Set<string>();
  for (const t of closed) {
    const oc = t[mode]; const g = oc.points as number, n = oc.net as number;
    if (oc.outcome === "win_tp1") wins++;
    gross += g; net += n; if (n > 0) pos += n; else neg -= n;
    cum += n; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; days.add(t.sessionDay);
  }
  const k = closed.length;
  return { n: k, open: ts.length - k, wins, winPct: k ? r2((100 * wins) / k) : null, grossExp: k ? r2(gross / k) : null, netExp: k ? r2(net / k) : null, pf: neg > 0 ? r2(pos / neg) : (pos > 0 ? Infinity : null), gross: r2(gross) ?? 0, net: r2(net) ?? 0, maxDD: r2(dd) ?? 0, days: days.size };
}
const dayNets = (ts: Trade[], mode: "carry" | "apex"): Map<string, number> => {
  const m = new Map<string, number>();
  for (const t of ts) { const n = t[mode].net; if (n == null) continue; m.set(t.sessionDay, (m.get(t.sessionDay) ?? 0) + n); }
  return m;
};
/** net minus the k best days (how much of the total is carried by a few days). */
function exTopDays(dn: Map<string, number>, k: number): number { const v = [...dn.values()].sort((a, b) => b - a); return r2(v.reduce((a, b) => a + b, 0) - v.slice(0, k).reduce((a, b) => a + b, 0)) ?? 0; }

// ═══════════════════════ VARIANTS ═══════════════════════
interface Variant { id: string; label: string; gate: boolean; settings?: Partial<FactEngineSettings>; news?: boolean }
const VARIANTS: Variant[] = [
  { id: "base", label: "current rules (gated, shipped gate+exits)", gate: true },
  { id: "ethOff", label: "ETH_CONFLUENCE:false (gated)", gate: true, settings: { ETH_CONFLUENCE: false } },
  { id: "min3", label: "ETH_MIN_AGREEING_FACTS:3 (gated)", gate: true, settings: { ETH_MIN_AGREEING_FACTS: 3 } },
  { id: "veto", label: "ETH_VETO_FRACTAL_TWO_FACT:true (gated)", gate: true, settings: { ETH_VETO_FRACTAL_TWO_FACT: true } },
  { id: "both", label: "ETH_MIN 3 + fractal two-fact veto (gated)", gate: true, settings: { ETH_MIN_AGREEING_FACTS: 3, ETH_VETO_FRACTAL_TWO_FACT: true } },
  { id: "news", label: "news blackout engine replay (gated, newsBlackouts)", gate: true, news: true },
  { id: "baseU", label: "current rules (UNGATED, shipped exits)", gate: false },
  { id: "ethOffU", label: "ETH_CONFLUENCE:false (UNGATED)", gate: false, settings: { ETH_CONFLUENCE: false } },
];
const tradesBy = new Map<string, Trade[]>();
const statsBy: Record<string, FactEngineRunStats> = {};
for (const v of VARIANTS) {
  const stats = newFactEngineRunStats();
  const byIv = enginePassX({ gate: v.gate, settings: v.settings, newsBlackouts: v.news ? WINDOWS.map(w => ({ fromSec: w.fromSec, toSec: w.toSec, label: w.label })) : undefined, statsOut: stats }, v.id);
  tradesBy.set(v.id, toTrades(byIv));
  statsBy[v.id] = stats;
}
fs.writeFileSync(path.join(OUT, "stats_out.json"), JSON.stringify(statsBy, null, 1));

// Session days in the window (for the Apex ruin sim script) — every Globex session day with served 1m bars.
{
  const set = new Set<string>();
  for (const b of c1m) if (b.time >= reportFromTs - 6 * 3600) set.add(sessionDayKey(b.time));
  const days = [...set].filter(d => d >= REPORT_FROM_KEY).sort();
  fs.writeFileSync(path.join(OUT, "session-days.json"), JSON.stringify({ from: REPORT_FROM_KEY, generatedAt: new Date().toISOString(), days }, null, 1));
  console.log(`[rp] session days ${days.length} (${days[0]}..${days[days.length - 1]})`);
}

// ═══════════════════════ CSV helpers ═══════════════════════
const csvEsc = (s: unknown): string => { const x = s == null ? "" : String(s); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
function writeCsv(file: string, header: string[], lines: unknown[][]): void {
  fs.writeFileSync(path.join(OUT, file), [header.join(","), ...lines.map(l => l.map(csvEsc).join(","))].join("\n") + "\n");
}
const fm = (x: number | null | undefined): string => (x == null ? "" : x === Infinity ? "inf" : String(x));
for (const v of VARIANTS) {
  writeCsv(`trades_${v.id}.csv`, ["key", "interval", "direction", "fireTs", "entryTs", "dateET", "timeET", "half", "sessionDay", "session", "inOrderWindow", "signalType", "comboKey", "countedFacts", "entry", "tp1", "sl", "newsWindow",
    "carryOutcome", "carryPoints", "carryNet", "carryExitET", "carryAdmitted", "apexOutcome", "apexPoints", "apexNet", "apexExitET", "apexAdmitted"],
    (tradesBy.get(v.id) as Trade[]).map(t => [t.key, t.iv, t.dir, t.fireTs, t.entryTs, t.dateET, t.timeET, t.half, t.sessionDay, t.session, t.inOrderWindow, t.signalType, t.comboKey, t.counted, t.entry, t.tp1, t.sl, t.newsWindow ?? "",
      t.carry.outcome, fm(t.carry.points), fm(t.carry.net), t.carry.exitTs == null ? "" : fmtEt(t.carry.exitTs), t.admitted.carry, t.apex.outcome, fm(t.apex.points), fm(t.apex.net), t.apex.exitTs == null ? "" : fmtEt(t.apex.exitTs), t.admitted.apex]));
}

// ═══════════════════════ SUMMARY TABLE (every variant × slice) ═══════════════════════
type Pop = "all" | "ETH" | "RTH" | "orderWindow";
const POPS: Pop[] = ["all", "ETH", "RTH", "orderWindow"];
const IVS: Array<Interval | "all"> = ["all", "1m", "5m", "15m", "60m"];
const HALVES: Array<"all" | "H1" | "H2"> = ["all", "H1", "H2"];
const popF = (p: Pop) => (t: Trade): boolean => p === "all" ? true : p === "orderWindow" ? t.inOrderWindow : t.session === p;
function slice(ts: Trade[], pop: Pop, iv: Interval | "all", half: "all" | "H1" | "H2", mode: "carry" | "apex", declustered: boolean): Trade[] {
  return ts.filter(t => popF(pop)(t) && (iv === "all" || t.iv === iv) && (half === "all" || t.half === half) && (!declustered || t.admitted[mode]));
}
const summaryLines: unknown[][] = [];
const mRow = (vid: string, pop: Pop, iv: Interval | "all", half: "all" | "H1" | "H2", mode: "carry" | "apex", dc: boolean): M => metrics(slice(tradesBy.get(vid) as Trade[], pop, iv, half, mode, dc), mode);
for (const v of VARIANTS) for (const pop of POPS) for (const iv of IVS) for (const half of HALVES) for (const mode of ["carry", "apex"] as const) for (const dc of [false, true]) {
  const m = mRow(v.id, pop, iv, half, mode, dc);
  if (m.n === 0 && m.open === 0) continue;
  summaryLines.push([v.id, pop, iv, half, mode, dc ? "declustered" : "raw", m.n, m.open, m.winPct, m.grossExp, m.netExp, fm(m.pf), m.gross, m.net, m.maxDD, m.days]);
}
writeCsv("variant_summary.csv", ["variant", "population", "interval", "half", "mode", "clustering", "n", "open", "winPct", "grossExp", "netExp", "PF_net", "grossTotal", "netTotal", "maxDD_net", "tradeDays"], summaryLines);

// ═══════════════════════ FIRE-SET DIFFS vs base ═══════════════════════
const baseKeys = new Map((tradesBy.get("base") as Trade[]).map(t => [t.key, t]));
const diffLines: unknown[][] = [];
const diffSummary: Record<string, { removed: number; added: number; removedNetCarry: number; addedNetCarry: number; removedNetApex: number; addedNetApex: number; byInterval: Record<string, { removed: number; added: number }> }> = {};
for (const v of VARIANTS) {
  if (v.id === "base" || v.id === "baseU") continue;
  const ref = v.id === "ethOffU" ? new Map((tradesBy.get("baseU") as Trade[]).map(t => [t.key, t])) : baseKeys;
  const cur = new Map((tradesBy.get(v.id) as Trade[]).map(t => [t.key, t]));
  const ds = { removed: 0, added: 0, removedNetCarry: 0, addedNetCarry: 0, removedNetApex: 0, addedNetApex: 0, byInterval: {} as Record<string, { removed: number; added: number }> };
  const bump = (iv: string, k: "removed" | "added") => { const o = ds.byInterval[iv] ?? (ds.byInterval[iv] = { removed: 0, added: 0 }); o[k]++; ds[k]++; };
  for (const [k, t] of ref) if (!cur.has(k)) { bump(t.iv, "removed"); ds.removedNetCarry += t.carry.net ?? 0; ds.removedNetApex += t.apex.net ?? 0; diffLines.push([v.id, "removed", k, t.iv, t.dir, t.dateET, t.timeET, t.session, t.signalType, t.comboKey, t.counted, t.carry.outcome, fm(t.carry.net), t.apex.outcome, fm(t.apex.net), t.newsWindow ?? ""]); }
  for (const [k, t] of cur) if (!ref.has(k)) { bump(t.iv, "added"); ds.addedNetCarry += t.carry.net ?? 0; ds.addedNetApex += t.apex.net ?? 0; diffLines.push([v.id, "added", k, t.iv, t.dir, t.dateET, t.timeET, t.session, t.signalType, t.comboKey, t.counted, t.carry.outcome, fm(t.carry.net), t.apex.outcome, fm(t.apex.net), t.newsWindow ?? ""]); }
  ds.removedNetCarry = r2(ds.removedNetCarry) ?? 0; ds.addedNetCarry = r2(ds.addedNetCarry) ?? 0; ds.removedNetApex = r2(ds.removedNetApex) ?? 0; ds.addedNetApex = r2(ds.addedNetApex) ?? 0;
  diffSummary[v.id] = ds;
}
writeCsv("fireset_diffs_vs_base.csv", ["variant", "change", "key", "interval", "direction", "dateET", "timeET", "session", "signalType", "comboKey", "countedFacts", "carryOutcome", "carryNet", "apexOutcome", "apexNet", "newsWindow"], diffLines);

// ═══════════════════════ TASK 2 — WALK-FORWARD per interval ═══════════════════════
interface WfRow { iv: string; pop: string; mode: string; candidate: string; h1n: number; h1net: number; h1exp: number | null; h2n: number; h2win: number | null; h2exp: number | null; h2pf: number | null; h2net: number; h2netEx3: number; baseH2net: number; h2delta: number; h2deltaEx3: number; picked: boolean; verdict: string }
const wfRows: WfRow[] = [];
const CANDS = ["base", "min3", "veto", "both"];
for (const pop of ["all", "ETH"] as Pop[]) for (const iv of ["1m", "5m", "15m", "60m"] as Interval[]) for (const mode of ["carry", "apex"] as const) {
  const rowsFor = (vid: string) => {
    const h1 = metrics(slice(tradesBy.get(vid) as Trade[], pop, iv, "H1", mode, true), mode);
    const h2t = slice(tradesBy.get(vid) as Trade[], pop, iv, "H2", mode, true);
    const h2 = metrics(h2t, mode);
    return { h1, h2, h2days: dayNets(h2t, mode) };
  };
  const base = rowsFor("base");
  const cands = CANDS.map(c => ({ c, ...rowsFor(c) }));
  // pick on H1 de-clustered net total (ties → base)
  let pick = cands[0];
  for (const x of cands) if (x.h1.net > pick.h1.net + 1e-9) pick = x;
  for (const x of cands) {
    const deltaDays = new Map<string, number>();
    for (const [d, n] of x.h2days) deltaDays.set(d, n - (base.h2days.get(d) ?? 0));
    for (const [d, n] of base.h2days) if (!x.h2days.has(d)) deltaDays.set(d, -n);
    const h2delta = r2(x.h2.net - base.h2.net) ?? 0;
    const h2deltaEx3 = exTopDays(deltaDays, 3);
    const h2netEx3 = exTopDays(x.h2days, 3);
    let verdict = "";
    if (x === pick) {
      if (x.c === "base") verdict = "H1 prefers the current rules — nothing to ship";
      else verdict = x.h2.net > 0 && h2delta > 0 && h2netEx3 > 0 && h2deltaEx3 > 0 ? "SHIP-WORTHY (H2 net > 0, improves on base, not carried by ≤3 days)"
        : x.h2.net <= 0 ? "NOT ship-worthy: H2 net ≤ 0" : h2delta <= 0 ? "NOT ship-worthy: H2 no better than base" : "NOT ship-worthy: carried by ≤3 days";
    }
    wfRows.push({ iv, pop, mode, candidate: x.c, h1n: x.h1.n, h1net: x.h1.net, h1exp: x.h1.netExp, h2n: x.h2.n, h2win: x.h2.winPct, h2exp: x.h2.netExp, h2pf: x.h2.pf, h2net: x.h2.net, h2netEx3, baseH2net: base.h2.net, h2delta, h2deltaEx3, picked: x === pick, verdict });
  }
}
writeCsv("task2_walk_forward.csv", ["interval", "population", "mode", "candidate", "H1_n", "H1_net", "H1_netExp", "H2_n", "H2_winPct", "H2_netExp", "H2_PF", "H2_net", "H2_net_exTop3Days", "base_H2_net", "H2_delta_vs_base", "H2_delta_exTop3Days", "pickedOnH1", "verdict"],
  wfRows.map(r => [r.iv, r.pop, r.mode, r.candidate, r.h1n, r.h1net, r.h1exp, r.h2n, r.h2win, r.h2exp, fm(r.h2pf), r.h2net, r.h2netEx3, r.baseH2net, r.h2delta, r.h2deltaEx3, r.picked, r.verdict]));

// ═══════════════════════ TASK 3 — NEWS BLACKOUT ═══════════════════════
// (a) post-hoc removal on the shipped (gated) replay fire set, and on the dataset's gated rows.
interface NewsAgg { label: string; n: number; netCarry: number; netApex: number; wins: number }
function postHoc(ts: Trade[], tag: string): { byIv: Record<string, { fires: number; removed: number; removedNetCarry: number; removedNetApex: number; netCarry: number; netApex: number }>; byWindow: NewsAgg[]; byPrint: Record<string, NewsAgg> } {
  const byIv: Record<string, { fires: number; removed: number; removedNetCarry: number; removedNetApex: number; netCarry: number; netApex: number }> = {};
  const byWindow = new Map<string, NewsAgg>(); const byPrint: Record<string, NewsAgg> = {};
  for (const t of ts) {
    const o = byIv[t.iv] ?? (byIv[t.iv] = { fires: 0, removed: 0, removedNetCarry: 0, removedNetApex: 0, netCarry: 0, netApex: 0 });
    o.fires++; o.netCarry += t.carry.net ?? 0; o.netApex += t.apex.net ?? 0;
    if (!t.newsWindow) continue;
    o.removed++; o.removedNetCarry += t.carry.net ?? 0; o.removedNetApex += t.apex.net ?? 0;
    const w = byWindow.get(t.newsWindow) ?? byWindow.set(t.newsWindow, { label: t.newsWindow, n: 0, netCarry: 0, netApex: 0, wins: 0 }).get(t.newsWindow)!;
    w.n++; w.netCarry += t.carry.net ?? 0; w.netApex += t.apex.net ?? 0; if (t.carry.outcome === "win_tp1") w.wins++;
    const pk = t.newsWindow.slice(0, 5);
    const p = byPrint[pk] ?? (byPrint[pk] = { label: pk, n: 0, netCarry: 0, netApex: 0, wins: 0 });
    p.n++; p.netCarry += t.carry.net ?? 0; p.netApex += t.apex.net ?? 0; if (t.carry.outcome === "win_tp1") p.wins++;
  }
  for (const o of Object.values(byIv)) for (const k of Object.keys(o) as Array<keyof typeof o>) o[k] = r2(o[k]) ?? 0;
  const fin = (a: NewsAgg) => ({ ...a, netCarry: r2(a.netCarry) ?? 0, netApex: r2(a.netApex) ?? 0 });
  console.log(`[rp] news post-hoc (${tag}): removed ${Object.values(byIv).reduce((a, b) => a + b.removed, 0)} of ${ts.length}`);
  return { byIv, byWindow: [...byWindow.values()].map(fin), byPrint: Object.fromEntries(Object.entries(byPrint).map(([k, v]) => [k, fin(v)])) };
}
const newsBase = postHoc(tradesBy.get("base") as Trade[], "base replay, gated");
const newsBaseOW = postHoc((tradesBy.get("base") as Trade[]).filter(t => t.inOrderWindow), "base replay, gated, order window 09:30-15:15");
const newsBaseU = postHoc(tradesBy.get("baseU") as Trade[], "base replay, ungated");
// dataset gated rows (the shipped fire set as built 2026-10-01 14:39 UTC)
let newsDs: ReturnType<typeof postHoc> | null = null;
try {
  const ds = JSON.parse(fs.readFileSync("C:\\BaxterSandbox\\analysis\\signals-3mo.json", "utf8")) as { rows: Array<Record<string, any>> };
  const dsTrades: Trade[] = ds.rows.filter(r => r.gated === true).map(r => {
    const w = windowAt(r.entryTs as number);
    const oc = (p: any): OC => ({ outcome: p.outcome, exitTs: p.exitTs, points: p.points, net: p.pointsNet, mae: p.mae ?? 0, mfe: p.mfe ?? 0 });
    const p = etParts(r.entryTs as number); const mins = p.hh * 60 + p.mm;
    return { key: r.key, iv: r.interval, dir: r.direction, fireTs: r.fireTs, entryTs: r.entryTs, entry: r.entry, tp1: r.tp1, sl: r.sl, session: r.session, signalType: r.signalType, comboKey: r.comboKey, counted: r.countedFactCount, dateET: r.dateET, timeET: r.timeET, half: r.half, sessionDay: r.sessionDay, inOrderWindow: mins >= ORDER_WINDOW.from && mins < ORDER_WINDOW.to, newsWindow: w ? w.label : null, carry: oc(r.path.outcomeCarry), apex: oc(r.path.outcomeApex), admitted: { carry: true, apex: true } };
  });
  newsDs = postHoc(dsTrades, "dataset signals-3mo gated rows");
} catch (e) { console.warn(`[rp] dataset post-hoc skipped: ${(e as Error).message}`); }
const newsLines: unknown[][] = [];
for (const [tag, res] of [["base-gated", newsBase], ["base-gated-orderWindow", newsBaseOW], ["base-ungated", newsBaseU], ["dataset-gated", newsDs]] as Array<[string, ReturnType<typeof postHoc> | null]>) {
  if (!res) continue;
  for (const [iv, o] of Object.entries(res.byIv)) newsLines.push([tag, "interval", iv, o.fires, o.removed, o.removedNetCarry, o.removedNetApex, r2(-o.removedNetCarry), r2(-o.removedNetApex), o.netCarry, o.netApex]);
  for (const [k, p] of Object.entries(res.byPrint)) newsLines.push([tag, "print", k, "", p.n, p.netCarry, p.netApex, r2(-p.netCarry), r2(-p.netApex), "", ""]);
  for (const w of res.byWindow) newsLines.push([tag, "window", w.label, "", w.n, w.netCarry, w.netApex, r2(-w.netCarry), r2(-w.netApex), "", ""]);
}
// (b) engine replay with newsBlackouts: two-run diff + statsOut
const nd = diffSummary["news"];
for (const [iv, o] of Object.entries(nd.byInterval)) {
  const mb = metrics(slice(tradesBy.get("base") as Trade[], "all", iv as Interval, "all", "carry", false), "carry"), mn = metrics(slice(tradesBy.get("news") as Trade[], "all", iv as Interval, "all", "carry", false), "carry");
  const ab = metrics(slice(tradesBy.get("base") as Trade[], "all", iv as Interval, "all", "apex", false), "apex"), an = metrics(slice(tradesBy.get("news") as Trade[], "all", iv as Interval, "all", "apex", false), "apex");
  newsLines.push(["engine-replay-diff", "interval", iv, mb.n + mb.open, o.removed, "", "", r2(mn.net - mb.net), r2(an.net - ab.net), mn.net, an.net, `added ${o.added} substitute fires`]);
}
writeCsv("task3_news_blackout.csv", ["population", "level", "key", "fires", "removed", "removedNetCarry", "removedNetApex", "netDeltaCarry_ifRemoved", "netDeltaApex_ifRemoved", "popNetCarry", "popNetApex", "note"], newsLines);

// ═══════════════════════ MARKDOWN SUMMARY ═══════════════════════
const md: string[] = [];
const T = (vid: string, pop: Pop, iv: Interval | "all", half: "all" | "H1" | "H2", mode: "carry" | "apex", dc: boolean): string => {
  const m = mRow(vid, pop, iv, half, mode, dc);
  return `${m.n}${m.open ? `+${m.open}o` : ""} | ${fm(m.winPct)} | ${fm(m.grossExp)} / ${fm(m.netExp)} | ${fm(m.pf)} | ${m.net}`;
};
md.push(`# ETH build — information replays (MES, window ${REPORT_FROM_KEY} → ${fmtEt(nowSec)})`, "");
md.push(`Generated ${new Date().toISOString()} by \`scripts/analysis/eth-replays.ts\` from the sandbox copy. Engine passes through the harness loader (dead-tape median ${L.dayRangeMedian} over ${L.dayRangeMedianDays} days = the live/dataset value; WINDOW_START_KEY left at the working-tree 2026-04-15 for parity, fires filtered to ≥ ${REPORT_FROM_KEY}). Outcomes walked on SERVED 1m bars (carry-overnight, and Apex = flat at 16:55 ET). NET = gross − ${FRICTION} pt/trade. Halves: H1 ${REPORT_FROM_KEY}..08-12, H2 ${H2_FROM_KEY}..present. Cells read: n(+open) | win% | gross/tr / NET/tr | PF(net) | NET total.`, "");
md.push(`## Engine suppression counters (statsOut; counts across the whole loaded range incl. warm-up, pre-filter)`, "", "```", JSON.stringify(statsBy, null, 1), "```", "");

md.push(`## (1) ETH_CONFLUENCE:false vs current rules — gated (shipped gate + exits)`, "");
for (const dc of [false, true]) {
  md.push(`### ${dc ? "De-clustered (one open per direction × interval, served-bar exits)" : "Raw engine fire set"}`, "", `| pop | iv | half | mode | current rules | ETH_CONFLUENCE:false |`, `|---|---|---|---|---|---|`);
  for (const pop of ["all", "ETH", "RTH"] as Pop[]) for (const iv of IVS) for (const half of HALVES) for (const mode of ["carry", "apex"] as const) {
    if (pop === "RTH" && (half !== "all")) continue;
    if (mode === "apex" && half !== "all") continue;
    const a = mRow("base", pop, iv, half, mode, dc), b = mRow("ethOff", pop, iv, half, mode, dc);
    if (a.n + a.open + b.n + b.open === 0) continue;
    md.push(`| ${pop} | ${iv} | ${half} | ${mode} | ${T("base", pop, iv, half, mode, dc)} | ${T("ethOff", pop, iv, half, mode, dc)} |`);
  }
  md.push("");
}
md.push(`Fire-set diff ethOff vs base: removed ${diffSummary.ethOff.removed} (net carry ${diffSummary.ethOff.removedNetCarry}, apex ${diffSummary.ethOff.removedNetApex}), added ${diffSummary.ethOff.added} substitutes (net carry ${diffSummary.ethOff.addedNetCarry}, apex ${diffSummary.ethOff.addedNetApex}); by interval ${JSON.stringify(diffSummary.ethOff.byInterval)}.`, "");
md.push(`Ungated (shipped exits, no gate): current ETH ${T("baseU", "ETH", "all", "all", "carry", true)} vs ETH_CONFLUENCE:false ETH ${T("ethOffU", "ETH", "all", "all", "carry", true)} (de-clustered carry).`, "");
md.push(`What the overnight book becomes with ETH_CONFLUENCE:false (gated, de-clustered, carry), per interval:`, "", `| iv | current ETH | side-entry-only ETH |`, `|---|---|---|`);
for (const iv of IVS) md.push(`| ${iv} | ${T("base", "ETH", iv, "all", "carry", true)} | ${T("ethOff", "ETH", iv, "all", "carry", true)} |`);
md.push("");

md.push(`## (2) Walk-forward shadow test — pick on H1, score on H2 (de-clustered)`, "", `Candidates per interval: base / min3 (ETH_MIN_AGREEING_FACTS=3) / veto (ETH_VETO_FRACTAL_TWO_FACT) / both. Pick = best H1 NET total. Ship-worthy = picked rule ≠ base, H2 NET > 0, H2 better than base, and both H2 NET and the H2 delta stay > 0 after removing the 3 best days.`, "");
for (const pop of ["all", "ETH"] as const) for (const mode of ["carry", "apex"] as const) {
  md.push(`### population ${pop} — ${mode}`, "", `| iv | candidate | H1 n / NET | H2 n / win% / NET/tr / PF / NET | H2 NET ex-top3 | Δ vs base H2 | Δ ex-top3 | pick | verdict |`, `|---|---|---|---|---|---|---|---|---|`);
  for (const r of wfRows.filter(x => x.pop === pop && x.mode === mode)) md.push(`| ${r.iv} | ${r.candidate} | ${r.h1n} / ${r.h1net} | ${r.h2n} / ${fm(r.h2win)} / ${fm(r.h2exp)} / ${fm(r.h2pf)} / ${r.h2net} | ${r.h2netEx3} | ${r.h2delta} | ${r.h2deltaEx3} | ${r.picked ? "**pick**" : ""} | ${r.verdict} |`);
  md.push("");
}
md.push(`Fire-set diffs vs base: min3 removed ${diffSummary.min3.removed} / added ${diffSummary.min3.added}; veto removed ${diffSummary.veto.removed} / added ${diffSummary.veto.added}; both removed ${diffSummary.both.removed} / added ${diffSummary.both.added} (full lists in fireset_diffs_vs_base.csv).`, "");

md.push(`## (3) Scheduled-news blackout`, "", `Windows: ${WINDOWS.length} (08:25–08:40 on 08:30 prints, 09:55–10:05 on 10:00 prints, 13:55–14:30 on FOMC days), ${EVENTS.length} events ${REPORT_FROM_KEY}..10-01; Jun 24–Sep 30 reconstructed from the official pages, ISM by its stated first/third-business-day rule (see news-calendar-2026-06-24_10-01.json).`, "");
const newsTable = (tag: string, res: ReturnType<typeof postHoc>) => {
  md.push(`### ${tag}`, "", `| iv | fires | removed | removed NET carry | removed NET apex | P&L delta if removed (carry / apex) | pop NET carry → after |`, `|---|---|---|---|---|---|---|`);
  let tf = 0, tr = 0, tc = 0, ta = 0, pc = 0;
  for (const iv of ["1m", "5m", "15m", "60m"]) { const o = res.byIv[iv]; if (!o) continue; tf += o.fires; tr += o.removed; tc += o.removedNetCarry; ta += o.removedNetApex; pc += o.netCarry; md.push(`| ${iv} | ${o.fires} | ${o.removed} | ${o.removedNetCarry} | ${o.removedNetApex} | ${r2(-o.removedNetCarry)} / ${r2(-o.removedNetApex)} | ${o.netCarry} → ${r2(o.netCarry - o.removedNetCarry)} |`); }
  md.push(`| **all** | ${tf} | ${tr} | ${r2(tc)} | ${r2(ta)} | ${r2(-tc)} / ${r2(-ta)} | ${r2(pc)} → ${r2(pc - tc)} |`, "");
  md.push(`By print time: ${Object.values(res.byPrint).map(p => `${p.label}: n=${p.n} wins=${p.wins} NET carry ${p.netCarry} / apex ${p.netApex}`).join("; ") || "none"}.`, "");
};
newsTable("Post-hoc removal — base replay, gated (shipped fire set)", newsBase);
newsTable("Post-hoc removal — base replay, gated, ORDER WINDOW 09:30–15:15 only (what the live auto-trader can place)", newsBaseOW);
newsTable("Post-hoc removal — base replay, UNGATED", newsBaseU);
if (newsDs) newsTable("Post-hoc removal — dataset signals-3mo.json gated rows (built 2026-10-01 14:39 UTC)", newsDs);
md.push(`### Engine replay with FactEngineInput.newsBlackouts (two-run diff vs base)`, "", `statsOut.newsBlackoutSuppressed = ${statsBy.news.newsBlackoutSuppressed} (by label: ${JSON.stringify(statsBy.news.newsBlackoutByLabel)}). Diff: removed ${nd.removed} (net carry ${nd.removedNetCarry}, apex ${nd.removedNetApex}), added ${nd.added} substitute fires (net carry ${nd.addedNetCarry}, apex ${nd.addedNetApex}).`, "", `| iv | base n | news n | base NET carry | news NET carry | Δ carry | base NET apex | news NET apex | Δ apex |`, `|---|---|---|---|---|---|---|---|---|`);
for (const iv of IVS) {
  const mb = mRow("base", "all", iv, "all", "carry", false), mn = mRow("news", "all", iv, "all", "carry", false), ab = mRow("base", "all", iv, "all", "apex", false), an = mRow("news", "all", iv, "all", "apex", false);
  md.push(`| ${iv} | ${mb.n} | ${mn.n} | ${mb.net} | ${mn.net} | ${r2(mn.net - mb.net)} | ${ab.net} | ${an.net} | ${r2(an.net - ab.net)} |`);
}
md.push("");
md.push(`## Files`, "", `- variant_summary.csv — every variant × population × interval × half × mode × clustering`, `- trades_<variant>.csv — per-fire rows with both walks`, `- fireset_diffs_vs_base.csv — removed/added fires per variant`, `- task2_walk_forward.csv, task3_news_blackout.csv, stats_out.json, news-calendar-2026-06-24_10-01.json, session-days.json`, "");
fs.writeFileSync(path.join(OUT, "REPLAYS.md"), md.join("\n") + "\n");
console.log(`[rp] DONE ${el()} → ${OUT}`);
