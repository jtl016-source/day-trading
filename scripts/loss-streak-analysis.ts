/**
 * loss-streak-analysis.ts — INTERVAL QUALITY + CONSECUTIVE-LOSS ANALYSIS (2026-08-10,
 * user: "15m is clearly the best, the others suck" + "I cannot have 4-losses-in-a-row days").
 * ANALYSIS ONLY — read-only DB, no persist, no gate write. Output: console + loss-streak-analysis.json.
 *
 * [A] SIGNALS-TAB REALITY CHECK: last 60 days of signal_history (what the tab shows), per
 *     interval, split at 2026-08-02 (the day quality gate + dead-tape + daily loss stop went
 *     live) — is the "other intervals suck" impression driven by the pre-gate era?
 * [B] Same 60-day window under CURRENT rules: harness as-traded book (shipped gate + exits +
 *     loss stop) windowed per interval — what the system as it exists today would have served.
 * [C] 15m streak autopsy: per-session-day W/L sequences, max-consecutive-loss distribution,
 *     worst days — in BOTH the live tab rows and the current-config book.
 * [D] Streak momentum test: P(loss | prev same-day same-interval loss) vs base loss rate —
 *     if streaks are just binomial clustering a streak-stop only truncates variance; if the
 *     conditional loss rate rises, a streak-breaker has real edge.
 * [E] STREAK-BREAKER MENU (approximation: filter on as-traded rows, no engine re-run, so no
 *     cooldown-chain or loss-stop re-interaction — same honest caveat as the option-b menu):
 *     per-interval "after K straight losses on interval I, no more I today" for K=2,3 and
 *     book-wide "after K straight losses on ANY interval, day over" for K=3,4.
 *
 * Usage: npx tsx scripts/loss-streak-analysis.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { QUALITY_GATE } from "../shared/quality-gate";
import { sessionDayKey } from "../shared/yellowbox-core";
import {
  loadData, enginePass, resolveSignal, metricsOf, applyDailyLossStop,
  INTERVALS, DAILY_LOSS_STOP_PTS,
  type SigRow,
} from "./fact-engine-backtest";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd();
const OUT = path.join(artifactsDir(ROOT), "loss-streak-analysis.json");
const DB_PATH = path.join(ROOT, "data", "app.db");
const WINDOW_DAYS = 60;
const RISK_CONTROLS_DAY = "2026-08-02"; // gate + dead-tape + daily loss stop ship date
const rnd2 = (v: number): number => Math.round(v * 100) / 100;

// A row is a LOSS for streak purposes when it realized negative points (sl always, eod when
// negative); >= 0 (incl. scratch eod) resets the streak — conservative toward fewer stops.
const isLoss = (pts: number | null | undefined): boolean => pts != null && pts < 0;
const isWin = (pts: number | null | undefined): boolean => pts != null && pts > 0;

interface LiveRow { timestamp: number; interval: string; outcome: string | null; points_result: number | null; source: string | null }

function liveSleeve(rows: LiveRow[]): { n: number; w: number; l: number; pts: number; winPct: number } {
  const w = rows.filter(r => isWin(r.points_result)).length;
  const l = rows.filter(r => isLoss(r.points_result)).length;
  const pts = rows.reduce((s, r) => s + (r.points_result ?? 0), 0);
  return { n: rows.length, w, l, pts: rnd2(pts), winPct: rnd2(w + l ? (100 * w) / (w + l) : 0) };
}

function harnessSleeve(rows: SigRow[]): Record<string, number> {
  const m = metricsOf(rows);
  return { n: rows.length, winPct: rnd2(m.winRate * 100), exp: rnd2(m.expectancy), pf: rnd2(m.profitFactor), cum: rnd2(m.cumPts), maxDD: rnd2(m.maxDD) };
}

/** Per-session-day W/L sequence stats for one set of rows (already one interval, or book-wide). */
function streakStats(rows: { ts: number; pts: number | null }[]): {
  days: number; maxConsecLossEver: number; daysWith3Plus: string[]; daysWith4Plus: string[];
  perDayWorst: { day: string; seq: string; pts: number }[];
} {
  const byDay = new Map<string, { ts: number; pts: number | null }[]>();
  for (const r of rows) {
    const d = sessionDayKey(r.ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  let maxEver = 0;
  const d3: string[] = [], d4: string[] = [];
  const perDay: { day: string; seq: string; pts: number; maxConsec: number }[] = [];
  for (const [day, dr] of [...byDay.entries()].sort()) {
    dr.sort((a, b) => a.ts - b.ts);
    let consec = 0, dayMax = 0;
    let seq = "";
    let pts = 0;
    for (const r of dr) {
      pts += r.pts ?? 0;
      if (isLoss(r.pts)) { consec++; dayMax = Math.max(dayMax, consec); seq += "L"; }
      else { consec = 0; seq += isWin(r.pts) ? "W" : "·"; }
    }
    maxEver = Math.max(maxEver, dayMax);
    if (dayMax >= 3) d3.push(day);
    if (dayMax >= 4) d4.push(day);
    perDay.push({ day, seq, pts: rnd2(pts), maxConsec: dayMax });
  }
  const perDayWorst = perDay.sort((a, b) => a.pts - b.pts).slice(0, 5).map(({ day, seq, pts }) => ({ day, seq, pts }));
  return { days: byDay.size, maxConsecLossEver: maxEver, daysWith3Plus: d3, daysWith4Plus: d4, perDayWorst };
}

/** P(loss | k prior same-day consecutive losses) — same interval stream. */
function conditionalLoss(rows: { ts: number; pts: number | null }[]): { base: number; after1: [number, number]; after2: [number, number] } {
  const byDay = new Map<string, { ts: number; pts: number | null }[]>();
  for (const r of rows) {
    const d = sessionDayKey(r.ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  let n = 0, losses = 0;
  let n1 = 0, l1 = 0, n2 = 0, l2 = 0;
  for (const dr of byDay.values()) {
    dr.sort((a, b) => a.ts - b.ts);
    let consec = 0;
    for (const r of dr) {
      const L = isLoss(r.pts);
      n++; if (L) losses++;
      if (consec >= 1) { n1++; if (L) l1++; }
      if (consec >= 2) { n2++; if (L) l2++; }
      consec = L ? consec + 1 : 0;
    }
  }
  return { base: rnd2(n ? (100 * losses) / n : 0), after1: [l1, n1], after2: [l2, n2] };
}

/** Streak-breaker filter on as-traded rows. perInterval: streak+stop scoped per interval; else any-interval streak stops the whole day. */
function applyStreakStop(rows: SigRow[], K: number, perInterval: boolean): { kept: SigRow[]; dropped: SigRow[] } {
  const byDay = new Map<string, SigRow[]>();
  for (const r of rows) {
    const d = sessionDayKey(r.entryTs);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  const kept: SigRow[] = [], dropped: SigRow[] = [];
  for (const dr of byDay.values()) {
    dr.sort((a, b) => a.entryTs - b.entryTs);
    const consec = new Map<string, number>();
    const stopped = new Set<string>();
    let dayStopped = false;
    for (const r of dr) {
      const key = perInterval ? r.interval : "*";
      if (dayStopped || stopped.has(key)) { dropped.push(r); continue; }
      kept.push(r);
      const c = isLoss(r.pointsResult) ? (consec.get(key) ?? 0) + 1 : 0;
      consec.set(key, c);
      if (c >= K) { if (perInterval) stopped.add(key); else dayStopped = true; }
    }
  }
  kept.sort((a, b) => a.entryTs - b.entryTs);
  return { kept, dropped };
}

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - WINDOW_DAYS * 86400;
  const report: Record<string, unknown> = { generated: new Date().toISOString(), windowDays: WINDOW_DAYS, riskControlsDay: RISK_CONTROLS_DAY };

  // ── [A] Signals-tab view: live signal_history, last 60 days, pre/post risk controls ──
  let db: Database.Database;
  try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
  catch { db = new Database(DB_PATH, { fileMustExist: true }); }
  const live = db.prepare(
    `SELECT timestamp, interval, outcome, points_result, source FROM signal_history WHERE timestamp >= ? ORDER BY timestamp`,
  ).all(windowStart) as LiveRow[];
  db.close();
  const ivOf = (r: LiveRow): string => (r.interval.endsWith("m") ? r.interval : `${r.interval}m`);
  const liveTab: Record<string, unknown> = {};
  console.log(`[A] SIGNALS TAB (live signal_history, last ${WINDOW_DAYS}d, n=${live.length}) — pre vs post ${RISK_CONTROLS_DAY} risk controls:`);
  for (const iv of INTERVALS) {
    const rows = live.filter(r => ivOf(r) === iv);
    const pre = rows.filter(r => sessionDayKey(r.timestamp) < RISK_CONTROLS_DAY);
    const post = rows.filter(r => sessionDayKey(r.timestamp) >= RISK_CONTROLS_DAY);
    const s = { all: liveSleeve(rows), pre: liveSleeve(pre), post: liveSleeve(post) };
    liveTab[iv] = s;
    console.log(`  ${iv.padEnd(3)} all n=${s.all.n} win ${s.all.winPct}% pts ${s.all.pts} | PRE n=${s.pre.n} win ${s.pre.winPct}% pts ${s.pre.pts} | POST n=${s.post.n} win ${s.post.winPct}% pts ${s.post.pts}`);
  }
  report.liveTab = liveTab;

  // 15m streaks as the USER saw them (live tab rows)
  const live15 = live.filter(r => ivOf(r) === "15m").map(r => ({ ts: r.timestamp, pts: r.points_result }));
  const live15Streaks = streakStats(live15);
  report.live15mStreaks = live15Streaks;
  console.log(`\n[C1] 15m streaks AS SEEN IN THE TAB (live rows, ${WINDOW_DAYS}d): maxConsecLoss=${live15Streaks.maxConsecLossEver}, days w/ 3+ = ${live15Streaks.daysWith3Plus.join(",") || "none"}, 4+ = ${live15Streaks.daysWith4Plus.join(",") || "none"}`);
  for (const d of live15Streaks.perDayWorst) console.log(`    worst: ${d.day} ${d.seq} ${d.pts}`);

  // ── [B] Current-config book (harness as-traded), same window ──
  const L = loadData();
  const calibratedClasses = new Set(Object.keys(QUALITY_GATE.exitByClass ?? {}));
  const byIv = enginePass(L, { gate: true, gateData: QUALITY_GATE, label: "streak-analysis" }, nowSec);
  const preStop: SigRow[] = [];
  for (const iv of INTERVALS) for (const sig of byIv[iv]) preStop.push(resolveSignal(sig, L, nowSec, calibratedClasses));
  preStop.sort((a, b) => a.entryTs - b.entryTs || a.interval.localeCompare(b.interval));
  const asTraded = applyDailyLossStop(preStop, DAILY_LOSS_STOP_PTS).kept;
  const windowed = asTraded.filter(r => r.entryTs >= windowStart);
  const currentBook: Record<string, unknown> = {};
  console.log(`\n[B] CURRENT RULES, same ${WINDOW_DAYS}d window (as-traded n=${windowed.length}):`);
  for (const iv of INTERVALS) {
    const s = harnessSleeve(windowed.filter(r => r.interval === iv));
    currentBook[iv] = s;
    console.log(`  ${iv.padEnd(3)} n=${s.n} win ${s.winPct}% exp ${s.exp} PF ${s.pf} cum ${s.cum} maxDD ${s.maxDD}`);
  }
  report.currentBookWindowed = currentBook;

  // [C2] 15m streaks under current rules (windowed + full book)
  const cur15 = windowed.filter(r => r.interval === "15m").map(r => ({ ts: r.entryTs, pts: r.pointsResult }));
  const cur15Streaks = streakStats(cur15);
  const full15 = asTraded.filter(r => r.interval === "15m").map(r => ({ ts: r.entryTs, pts: r.pointsResult }));
  const full15Streaks = streakStats(full15);
  report.current15mStreaks = { windowed: cur15Streaks, fullBook: full15Streaks };
  console.log(`\n[C2] 15m streaks UNDER CURRENT RULES: ${WINDOW_DAYS}d maxConsec=${cur15Streaks.maxConsecLossEver} (3+ days: ${cur15Streaks.daysWith3Plus.join(",") || "none"}) | full book maxConsec=${full15Streaks.maxConsecLossEver} (3+ days: ${full15Streaks.daysWith3Plus.join(",") || "none"})`);

  // ── [D] Streak momentum: is a loss more likely after a loss? ──
  const momentum: Record<string, unknown> = {};
  console.log(`\n[D] P(loss | prior same-day consecutive losses) — full current-config book:`);
  for (const iv of [...INTERVALS, "*"]) {
    const rows = (iv === "*" ? asTraded : asTraded.filter(r => r.interval === iv)).map(r => ({ ts: r.entryTs, pts: r.pointsResult }));
    const c = conditionalLoss(rows);
    momentum[iv] = c;
    const f = (p: [number, number]): string => (p[1] ? `${rnd2((100 * p[0]) / p[1])}% (${p[0]}/${p[1]})` : "n=0");
    console.log(`  ${iv === "*" ? "ALL" : iv.padEnd(3)} base ${c.base}% | after 1 loss ${f(c.after1)} | after 2 losses ${f(c.after2)}`);
  }
  report.momentum = momentum;

  // ── [E] Streak-breaker menu on the full as-traded book ──
  const baseline = harnessSleeve(asTraded);
  const variants: Record<string, unknown> = { baseline };
  console.log(`\n[E] STREAK-BREAKER MENU (filter on as-traded rows — no engine re-run; cooldown/loss-stop interplay NOT re-simulated):`);
  console.log(`  baseline           n=${baseline.n} exp ${baseline.exp} PF ${baseline.pf} cum ${baseline.cum} maxDD ${baseline.maxDD}`);
  const cfgs: { name: string; K: number; perInterval: boolean }[] = [
    { name: "perInterval K=2", K: 2, perInterval: true },
    { name: "perInterval K=3", K: 3, perInterval: true },
    { name: "bookWide K=3", K: 3, perInterval: false },
    { name: "bookWide K=4", K: 4, perInterval: false },
  ];
  for (const cfg of cfgs) {
    const { kept, dropped } = applyStreakStop(asTraded, cfg.K, cfg.perInterval);
    const m = harnessSleeve(kept);
    const dW = dropped.filter(r => isWin(r.pointsResult)).length;
    const dL = dropped.filter(r => isLoss(r.pointsResult)).length;
    const dPts = rnd2(dropped.reduce((s, r) => s + (r.pointsResult ?? 0), 0));
    const m15 = harnessSleeve(kept.filter(r => r.interval === "15m"));
    variants[cfg.name] = { ...m, dropped: { n: dropped.length, wins: dW, losses: dL, pts: dPts }, sleeve15m: m15 };
    console.log(`  ${cfg.name.padEnd(18)} n=${m.n} exp ${m.exp} PF ${m.pf} cum ${m.cum} maxDD ${m.maxDD} | dropped ${dropped.length} (${dW}W/${dL}L, ${dPts >= 0 ? "+" : ""}${dPts} pts) | 15m: n=${m15.n} PF ${m15.pf} cum ${m15.cum}`);
  }
  report.streakBreakerMenu = variants;

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
