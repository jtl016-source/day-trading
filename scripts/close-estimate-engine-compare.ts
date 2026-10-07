// scripts/close-estimate-engine-compare.ts
// ─────────────────────────────────────────────────────────────────────────────
// FULL-STACK BEFORE/AFTER: the shipped fact-engine book (ALL strategies, standing 3-month
// results) vs the same book with a CLOSE-ESTIMATE rule layered on — 15m TRADES ONLY.
// ANALYSIS ONLY (simulated): reads the standing results JSON + DB read-only; the live
// engine is untouched; writes ONE artifact JSON to BAXTER_ARTIFACTS_DIR.
//
// BEFORE = every 15m row of C:\BaxterData\fact-engine-backtest-results.json (as-fired
// outcomes, raw per-trade basis — daily loss stop NOT replayed on either side, so the
// comparison is apples-to-apples).
// AFTER  = BEFORE minus rows suppressed by a close-estimate rule. Zone at each fire is
// computed WALK-FORWARD with the SAME shared computeCloseEstimate over 5m bars sliced to
// the moment before entry (identical basis to the terminal overlay — zero mirror drift).
//
// RULES EVALUATED (each an independent AFTER variant; RTH-afternoon only — bar-close time
// ≥ 14:00 ET, the method's zone lock-in checkpoint; ETH and pre-14:00 rows always pass):
//   R1 no-chase        — suppress a trade pointing AWAY from the close-magnet zone from
//                        beyond it (Long entered above zone-top / Short below zone-bottom).
//   R2 toward-only     — afternoon trades must point TOWARD the zone from beyond it;
//                        everything else afternoon is suppressed (strictest reading).
//   R3 no-chase-tight  — R1 but only when the zone is TIGHT (width ≤ 10 pts — the "both
//                        estimates agree" case; the only condition with positive evidence
//                        in the standalone backtest).
//
// HONESTY CAVEATS (printed + stored): (1) post-hoc SUBTRACTIVE filtering — an in-engine
// suppression would free cooldown windows and could admit later fires the standing book
// never recorded (the documented menu-vs-full-sim artifact class); effects here are
// therefore the DROPPED side only. (2) rows whose fire predates a computable zone
// (<10 green or red lookback days) pass through unfiltered and are counted as "no-zone".
//
// Run: npx tsx scripts/close-estimate-engine-compare.ts   (dev server NOT required)
// ─────────────────────────────────────────────────────────────────────────────
import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import { computeCloseEstimate } from "../shared/close-estimate-core";
import { filterYbBars, type Bar } from "../shared/yellowbox-core";
import { etWallClock } from "../shared/firing/session";
import { artifactsDir } from "../shared/artifacts-dir";

const ROOT = process.cwd(); // __dirname undefined under tsx ESM (LEARNINGS 2026-07-30)
const DB_PATH = path.join(ROOT, "data", "app.db");
const RESULTS_JSON = path.join(artifactsDir(ROOT), "fact-engine-backtest-results.json");
const OUT_PATH = path.join(artifactsDir(ROOT), "close-estimate-engine-compare.json");

const SYMBOL = "MES";
const FRICTION_PTS = 0.996;
const AFTERNOON_MIN = 14 * 60;
const TIGHT_PTS = 10;

interface Row {
  fireTs: number; entryTs: number; dateET: string; timeET: string; sessionDay: string;
  session: string; interval: string; direction: "Long" | "Short"; entry: number;
  outcome: string; pointsResult: number; combo: string; signalType: string;
}

const doc = JSON.parse(fs.readFileSync(RESULTS_JSON, "utf8")) as { meta?: unknown; signals: Row[] };
const rows15 = doc.signals.filter((r) => r.interval === "15m");
if (!rows15.length) { console.error("no 15m rows in standing JSON"); process.exit(1); }

let db: Database.Database;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch { db = new Database(DB_PATH, { fileMustExist: true }); } // WAL readonly needs -shm; no writes issued
const firstFire = Math.min(...rows15.map((r) => r.entryTs));
const bars5: Bar[] = filterYbBars(db.prepare(
  `SELECT timestamp t, open o, high h, low l, close c, COALESCE(volume,0) v
     FROM cached_candles WHERE symbol=? AND resolution='5' AND timestamp>=? ORDER BY timestamp`,
).all(SYMBOL, firstFire - 130 * 86400) as Bar[], "5");
db.close();

// Zone at each fire (walk-forward slice; cached per entryTs — several rows can share a day).
interface ZoneAt { zoneBot: number; zoneTop: number; width: number } // per fire, or null
const zones = new Map<number, ZoneAt | null>();
let cursorHint = 0;
for (const r of rows15.slice().sort((a, b) => a.entryTs - b.entryTs)) {
  // slice index via linear advance (rows sorted) — bars5 is ascending
  while (cursorHint < bars5.length && bars5[cursorHint].t + 300 <= r.entryTs) cursorHint++;
  const est = computeCloseEstimate(bars5.slice(0, cursorHint));
  if (est && est.day.dayKey === r.sessionDay) {
    const zoneBot = Math.min(est.day.estCloseHigh, est.day.estCloseLow);
    const zoneTop = Math.max(est.day.estCloseHigh, est.day.estCloseLow);
    zones.set(r.entryTs, { zoneBot, zoneTop, width: +(zoneTop - zoneBot).toFixed(2) });
  } else {
    zones.set(r.entryTs, null);
  }
}

const isAfternoon = (r: Row): boolean => r.session === "RTH" && etWallClock(r.fireTs).mins >= AFTERNOON_MIN;
const awayFromZone = (r: Row, z: ZoneAt): boolean =>
  (r.direction === "Long" && r.entry > z.zoneTop) || (r.direction === "Short" && r.entry < z.zoneBot);
const towardZone = (r: Row, z: ZoneAt): boolean =>
  (r.direction === "Short" && r.entry > z.zoneTop) || (r.direction === "Long" && r.entry < z.zoneBot);

type RuleFn = (r: Row, z: ZoneAt | null) => boolean; // true = SUPPRESS
const RULES: Record<string, RuleFn> = {
  R1_noChase: (r, z) => !!z && isAfternoon(r) && awayFromZone(r, z),
  R2_towardOnly: (r, z) => !!z && isAfternoon(r) && !towardZone(r, z),
  R3_noChaseTight: (r, z) => !!z && isAfternoon(r) && z.width <= TIGHT_PTS && awayFromZone(r, z),
};

function metrics(rs: Row[]) {
  const n = rs.length;
  // Standing-JSON outcome vocabulary: tp1 / tp2 (wins), sl (loss), eod (closed, not a win).
  const wins = rs.filter((r) => r.outcome === "tp1" || r.outcome === "tp2" || r.outcome === "win_tp1" || r.outcome === "win_tp2").length;
  const losses = rs.filter((r) => r.outcome === "sl" || r.outcome === "loss").length;
  const eod = rs.filter((r) => r.outcome === "eod").length;
  const gross = rs.reduce((s, r) => s + r.pointsResult, 0);
  const gw = rs.filter((r) => r.pointsResult > 0).reduce((s, r) => s + r.pointsResult, 0);
  const gl = -rs.filter((r) => r.pointsResult < 0).reduce((s, r) => s + r.pointsResult, 0);
  return {
    n, wins, losses, eod,
    winRate: n ? +(100 * wins / Math.max(1, wins + losses + eod)).toFixed(2) : 0,
    grossPts: +gross.toFixed(2), netPts: +(gross - n * FRICTION_PTS).toFixed(2),
    avgGross: n ? +(gross / n).toFixed(3) : 0, avgNet: n ? +((gross / n) - FRICTION_PTS).toFixed(3) : 0,
    pf: gl > 0 ? +(gw / gl).toFixed(3) : (gw > 0 ? 999 : 0),
  };
}

const before = metrics(rows15);
const monthCut = Math.max(...rows15.map((r) => r.entryTs)) - 31 * 86400;
const beforeMonth = metrics(rows15.filter((r) => r.entryTs >= monthCut));
const noZone = rows15.filter((r) => !zones.get(r.entryTs)).length;
const afternoonN = rows15.filter((r) => isAfternoon(r)).length;

const variants: Record<string, unknown> = {};
for (const [name, fn] of Object.entries(RULES)) {
  const kept = rows15.filter((r) => !fn(r, zones.get(r.entryTs) ?? null));
  const dropped = rows15.filter((r) => fn(r, zones.get(r.entryTs) ?? null));
  variants[name] = {
    after: metrics(kept),
    afterLastMonth: metrics(kept.filter((r) => r.entryTs >= monthCut)),
    dropped: {
      ...metrics(dropped),
      rows: dropped.map((r) => ({
        day: r.sessionDay, time: r.timeET, dir: r.direction, entry: r.entry,
        zone: zones.get(r.entryTs), combo: r.combo, outcome: r.outcome, pts: r.pointsResult,
      })),
    },
  };
}

const out = {
  generated: new Date().toISOString(), symbol: SYMBOL, interval: "15m",
  basis: "as-fired standing results (raw per-trade; daily loss stop NOT replayed on either side); post-hoc SUBTRACTIVE filter — cooldown refires not simulated; SIMULATED analysis only",
  windowET: { from: rows15.reduce((m, r) => (r.dateET < m ? r.dateET : m), "9999"), to: rows15.reduce((m, r) => (r.dateET > m ? r.dateET : m), "0000") },
  counts: { rows15: rows15.length, afternoonRTH: afternoonN, noZone },
  before, beforeLastMonth: beforeMonth,
  variants,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

const fmt = (m: ReturnType<typeof metrics>): string =>
  `n=${m.n} win ${m.winRate}% (${m.wins}W/${m.losses}L/${m.eod}E) gross ${m.grossPts} net ${m.netPts} avg ${m.avgGross}/${m.avgNet}n PF ${m.pf}`;
console.log(`\nCLOSE-EST ENGINE COMPARE — ${SYMBOL} 15m — standing window ${out.windowET.from}..${out.windowET.to}`);
console.log(`rows: ${rows15.length} 15m trades (${afternoonN} RTH-afternoon, ${noZone} without computable zone → always pass)`);
console.log(`\nBEFORE (all strategies, shipped engine):\n  full window : ${fmt(before)}\n  last month  : ${fmt(beforeMonth)}`);
for (const [name, v] of Object.entries(variants) as [string, any][]) {
  console.log(`\nAFTER ${name}:`);
  console.log(`  full window : ${fmt(v.after)}`);
  console.log(`  last month  : ${fmt(v.afterLastMonth)}`);
  console.log(`  dropped     : ${fmt(v.dropped)}`);
  for (const d of v.dropped.rows) {
    console.log(`    ${d.day} ${d.time} ${d.dir.padEnd(5)} ${d.combo.padEnd(12)} entry ${d.entry} zone ${d.zone ? `${d.zone.zoneBot}-${d.zone.zoneTop} (w${d.zone.width})` : "—"} → ${d.outcome} ${d.pts >= 0 ? "+" : ""}${d.pts}`);
  }
}
console.log(`\nartifact: ${OUT_PATH}\n`);
