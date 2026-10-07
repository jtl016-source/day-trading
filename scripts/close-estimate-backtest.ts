// scripts/close-estimate-backtest.ts
// ─────────────────────────────────────────────────────────────────────────────
// CLOSE-ESTIMATE BACKTEST — ANALYSIS ONLY (in-memory; reads the DB read-only; writes ONE
// artifact JSON to BAXTER_ARTIFACTS_DIR; no persistence, no standing-artifact overwrite).
//
// Question (user, 2026-08-09): "a backtest for just the close estimates and the signals it
// would produce for the 15m interval from the last month."
//
// Method under test = the shipped display-only CLOSE-EST tool (shared/close-estimate-core),
// i.e. the Fractal Exchange "END OF DAY CLOSE VALUES" card:
//   est close-high = running RTH HOD − avg(HOD − 16:00 close | green days)
//   est close-low  = running RTH LOD + avg(16:00 close − LOD | red days)
//   zone = [min,max] of the two; the day's OPEN line is the reversion anchor.
//
// WALK-FORWARD FIDELITY: at every decision point the script calls the SAME shared
// computeCloseEstimate() over the 5m bars sliced to that moment — stats come from the ≤60
// completed sessions strictly before the day, running extremes from bars up to the decision
// bar. Zero re-implementation → zero drift from what the terminal overlay shows live.
//
// SIGNAL RULE (the session's teaching, made mechanical; simulated — never traded live):
//   • decisions at 15m bar CLOSES with close time in [14:00, 15:15) ET
//     (14:00 = their "zone lock-in" checkpoint; 15:15 = the platform's hard no-entry rule)
//   • 15m close ABOVE zone-top + edge  → SHORT toward the zone (target = zone top)
//     15m close BELOW zone-bot − edge  → LONG  toward the zone (target = zone bottom)
//   • one trade per day (first qualifying 15m close); no stop (the method holds into the
//     close) — exits: target touch on subsequent 5m bars, else mark at the 16:00 cash close.
//     MAE reported so the no-stop risk is visible. Edge ladder: 0 / 5 / 10 pts.
//   • friction: NET = gross − 0.996 pts/trade (repo convention).
//
// ESTIMATE-ACCURACY (every day, no trade needed): zone snapshot at the FIRST decision bar
// (~14:00 ET) vs the actual 16:00 close — error to zone mid, close-lands-in-zone rate, and
// whether price moved TOWARD the zone from the snapshot price into the close.
//
// Run: npx tsx scripts/close-estimate-backtest.ts   (dev server NOT required)
// ─────────────────────────────────────────────────────────────────────────────
import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import { computeCloseEstimate } from "../shared/close-estimate-core";
import { filterYbBars, sessionDayKey, type Bar } from "../shared/yellowbox-core";
import { etWallClock } from "../shared/firing/session";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd(); // __dirname is undefined under tsx ESM (LEARNINGS 2026-07-30) — run from repo root
const DB_PATH = path.join(ROOT, "data", "app.db");
const OUT_PATH = path.join(artifactsDir(ROOT), "close-estimate-backtest.json");

const SYMBOL = "MES";
const BACKTEST_CAL_DAYS = 31;   // "the last month"
const STATS_CAL_DAYS = 170;     // 5m history loaded so every backtest day has its 60-session lookback
const FRICTION_PTS = 0.996;     // repo NET convention, round-trip per trade
const EDGES = [0, 5, 10];       // minimum distance beyond the zone edge to take the signal
const DECIDE_FROM_MIN = 14 * 60;      // 14:00 ET — their lock-in checkpoint
const DECIDE_BEFORE_MIN = 15 * 60 + 15; // 15:15 ET — house hard no-entry rule (close-time basis)
const CASH_CLOSE_MIN = 16 * 60;

interface Trade {
  day: string; dir: "long" | "short"; entryEt: string; entry: number;
  zoneBot: number; zoneTop: number; target: number; edgePts: number;
  exit: number; exitKind: "target" | "close"; pts: number; mae: number;
}
interface DayAccuracy {
  day: string; snapEt: string; snapPrice: number; zoneBot: number; zoneTop: number;
  close16: number; errToMid: number; inZone: boolean; movedToward: boolean;
}

function loadBars(db: Database.Database, resolution: string, fromTs: number): Bar[] {
  const rows = db.prepare(
    `SELECT timestamp t, open o, high h, low l, close c, COALESCE(volume,0) v
       FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp>=? ORDER BY timestamp`,
  ).all(SYMBOL, resolution, fromTs) as Bar[];
  return filterYbBars(rows, resolution);
}

function etHm(tsSec: number): string {
  const { mins } = etWallClock(tsSec);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

const nowSec = Math.floor(Date.now() / 1000);
let db: Database.Database;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch { db = new Database(DB_PATH, { fileMustExist: true }); } // WAL readonly needs -shm; no writes issued

const bars5 = loadBars(db, "5", nowSec - STATS_CAL_DAYS * 86400);
const bars15 = loadBars(db, "15", nowSec - (BACKTEST_CAL_DAYS + 14) * 86400);
db.close();
if (!bars5.length || !bars15.length) { console.error("no bars"); process.exit(1); }

// Backtest days = session days with any 15m RTH bar in the last BACKTEST_CAL_DAYS.
const cutoff = nowSec - BACKTEST_CAL_DAYS * 86400;
const dayKeys = [...new Set(bars15.filter((b) => b.t >= cutoff).map((b) => sessionDayKey(b.t)))].sort();

// Per-day 5m/15m RTH-window bars (close-time semantics, matching the shared core).
const inRthWindow = (b: Bar, barSec: number): boolean => {
  const { wd, mins } = etWallClock(b.t + barSec);
  return wd !== 0 && wd !== 6 && mins > 9 * 60 + 30 && mins <= CASH_CLOSE_MIN;
};
const by5 = new Map<string, Bar[]>(), by15 = new Map<string, Bar[]>();
for (const b of bars5) { if (inRthWindow(b, 300)) { const k = sessionDayKey(b.t); if (!by5.has(k)) by5.set(k, []); by5.get(k)!.push(b); } }
for (const b of bars15) { if (inRthWindow(b, 900)) { const k = sessionDayKey(b.t); if (!by15.has(k)) by15.set(k, []); by15.get(k)!.push(b); } }

const accuracy: DayAccuracy[] = [];
const tradesByEdge = new Map<number, Trade[]>(EDGES.map((e) => [e, []]));

for (const day of dayKeys) {
  const d5 = by5.get(day) ?? [], d15 = by15.get(day) ?? [];
  if (d5.length < 20 || !d15.length) continue; // holiday/partial or missing data
  const close16 = d5[d5.length - 1].c;
  const decisions = d15.filter((b) => { const m = etWallClock(b.t + 900).mins; return m >= DECIDE_FROM_MIN && m < DECIDE_BEFORE_MIN; });
  if (!decisions.length) continue;

  let snapped = false;
  const taken = new Set<number>();
  for (const bar of decisions) {
    const tClose = bar.t + 900;
    // Walk-forward slice: everything the shipped tool would have seen at this 15m close.
    const est = computeCloseEstimate(bars5.filter((b) => b.t + 300 <= tClose));
    if (!est || est.day.dayKey !== day) continue; // thin stats or day-key mismatch — skip honestly
    const zoneBot = Math.min(est.day.estCloseHigh, est.day.estCloseLow);
    const zoneTop = Math.max(est.day.estCloseHigh, est.day.estCloseLow);

    if (!snapped) { // accuracy snapshot at the first decision bar of the day
      snapped = true;
      const mid = (zoneBot + zoneTop) / 2;
      accuracy.push({
        day, snapEt: etHm(tClose), snapPrice: bar.c, zoneBot, zoneTop, close16,
        errToMid: Math.round((close16 - mid) * 4) / 4,
        inZone: close16 >= zoneBot - 0.25 && close16 <= zoneTop + 0.25,
        movedToward: Math.abs(close16 - mid) < Math.abs(bar.c - mid) - 1e-9,
      });
    }

    for (const edge of EDGES) {
      if (taken.has(edge)) continue;
      let dir: "long" | "short" | null = null;
      if (bar.c > zoneTop + edge) dir = "short";
      else if (bar.c < zoneBot - edge) dir = "long";
      if (!dir) continue;
      taken.add(edge);
      const target = dir === "short" ? zoneTop : zoneBot;
      const rest = d5.filter((b) => b.t >= tClose); // 5m bars after entry, same day
      let exit = close16, exitKind: Trade["exitKind"] = "close", mae = 0;
      for (const nb of rest) {
        mae = Math.max(mae, dir === "short" ? nb.h - bar.c : bar.c - nb.l);
        if (dir === "short" ? nb.l <= target : nb.h >= target) { exit = target; exitKind = "target"; break; }
      }
      const pts = Math.round(((dir === "short" ? bar.c - exit : exit - bar.c)) * 4) / 4;
      tradesByEdge.get(edge)!.push({
        day, dir, entryEt: etHm(tClose), entry: bar.c, zoneBot, zoneTop, target,
        edgePts: edge, exit, exitKind, pts, mae: Math.round(mae * 4) / 4,
      });
    }
  }
}

// ── Summaries ──
function summarize(trades: Trade[]) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pts > 0);
  const gross = trades.reduce((s, t) => s + t.pts, 0);
  const grossWin = trades.filter((t) => t.pts > 0).reduce((s, t) => s + t.pts, 0);
  const grossLoss = -trades.filter((t) => t.pts < 0).reduce((s, t) => s + t.pts, 0);
  const net = gross - n * FRICTION_PTS;
  const maes = trades.map((t) => t.mae).sort((a, b) => a - b);
  return {
    n, winRate: n ? +(100 * wins.length / n).toFixed(1) : 0,
    zoneTagged: trades.filter((t) => t.exitKind === "target").length,
    grossPts: +gross.toFixed(2), netPts: +net.toFixed(2),
    avgGross: n ? +(gross / n).toFixed(2) : 0, avgNet: n ? +((gross / n) - FRICTION_PTS).toFixed(2) : 0,
    pf: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 999 : 0),
    maxMae: maes.length ? maes[maes.length - 1] : 0,
    medMae: maes.length ? maes[Math.floor(maes.length / 2)] : 0,
  };
}
const accSummary = {
  days: accuracy.length,
  closeInZonePct: accuracy.length ? +(100 * accuracy.filter((a) => a.inZone).length / accuracy.length).toFixed(1) : 0,
  movedTowardPct: accuracy.length ? +(100 * accuracy.filter((a) => a.movedToward).length / accuracy.length).toFixed(1) : 0,
  medAbsErrToMid: (() => { const e = accuracy.map((a) => Math.abs(a.errToMid)).sort((x, y) => x - y); return e.length ? e[Math.floor(e.length / 2)] : 0; })(),
  meanAbsErrToMid: accuracy.length ? +(accuracy.reduce((s, a) => s + Math.abs(a.errToMid), 0) / accuracy.length).toFixed(2) : 0,
};

const out = {
  generated: new Date().toISOString(), symbol: SYMBOL, interval: "15m",
  windowDays: BACKTEST_CAL_DAYS, sessionDays: dayKeys, note: "ANALYSIS-ONLY / SIMULATED — display-only method, never an engine input. Walk-forward via shared computeCloseEstimate on sliced 5m bars; decisions at 15m closes 14:00–15:15 ET; no stop (MAE reported); NET = gross − 0.996 pts/trade.",
  accuracy: { summary: accSummary, days: accuracy },
  signals: Object.fromEntries(EDGES.map((e) => [`edge_${e}`, { summary: summarize(tradesByEdge.get(e)!), trades: tradesByEdge.get(e)! }])),
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

// ── Console report ──
console.log(`\nCLOSE-ESTIMATE BACKTEST — ${SYMBOL} 15m — last ${BACKTEST_CAL_DAYS} cal days (${dayKeys[0]} → ${dayKeys[dayKeys.length - 1]}, ${accuracy.length} evaluable sessions)`);
console.log(`\n[ESTIMATE ACCURACY @ first 14:00 ET snapshot vs 16:00 close]`);
console.log(`  close landed IN zone: ${accSummary.closeInZonePct}%   moved TOWARD zone: ${accSummary.movedTowardPct}%   |err to mid| med ${accSummary.medAbsErrToMid} / mean ${accSummary.meanAbsErrToMid} pts`);
for (const e of EDGES) {
  const s = summarize(tradesByEdge.get(e)!);
  console.log(`\n[SIGNALS edge≥${e}pts]  n=${s.n} win ${s.winRate}% (zone-tagged ${s.zoneTagged}) | gross ${s.grossPts} net ${s.netPts} | avg ${s.avgGross}/${s.avgNet} net | PF ${s.pf} | MAE med ${s.medMae} max ${s.maxMae}`);
}
const primary = tradesByEdge.get(5)!;
console.log(`\n[TRADE LIST edge≥5pts]`);
for (const t of primary) {
  console.log(`  ${t.day} ${t.entryEt}ET ${t.dir.toUpperCase().padEnd(5)} entry ${t.entry.toFixed(2)} zone ${t.zoneBot.toFixed(2)}–${t.zoneTop.toFixed(2)} → exit ${t.exit.toFixed(2)} (${t.exitKind}) ${t.pts >= 0 ? "+" : ""}${t.pts.toFixed(2)} pts (MAE ${t.mae.toFixed(2)})`);
}
console.log(`\nartifact: ${OUT_PATH}\n`);
