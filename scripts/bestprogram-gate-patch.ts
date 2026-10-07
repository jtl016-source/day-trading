/**
 * bestprogram-gate-patch.ts — BEST-PROGRAM SHIP, gate layer (2026-08-13, user: "do your
 * recommendations" after the best-program lab; final scope reduced by certification:
 * 15m ONLY — the 1m block list failed cross-basis certification (era-anti-persistent) and
 * 5m/60m darkening contradicted their positive honest standing records, so those sleeves
 * ship UNCHANGED).
 *
 * Edits to shared/quality-gate.ts (generated file — hand-calibration documented in-place;
 * the Sunday regen re-derives under executable scoring and MUST be reviewed against this):
 *   1. comboClasses: six 15m combos blocked — negative on BOTH the lab's reference-geometry
 *      basis AND the as-calibrated executable rebased record (n>=15 each):
 *      Fr+YB, Vec+YB, Fr+Vec+YB, ICT+YB, Fr+ICT+YB, FG+Fr+Vec+YB (all @15m).
 *   2. exitByClass: fact-engine@15m + vector-side-entry@15m -> TP 10.5 / SL 26 (the
 *      valid-era Pareto knee: 86.9% win, +4.65/trade net under realistic fills).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = path.join(process.cwd(), "shared", "quality-gate.ts");
let src = fs.readFileSync(FILE, "utf8");

const START = "export const QUALITY_GATE: QualityGateData = ";
const si = src.indexOf(START);
if (si < 0) throw new Error("QUALITY_GATE marker not found");
const jsonStart = si + START.length;
const jsonEnd = src.indexOf("\n};", jsonStart);
if (jsonEnd < 0) throw new Error("QUALITY_GATE end not found");
const blob = src.slice(jsonStart, jsonEnd + 2);
const data = JSON.parse(blob.replace(/;\s*$/, ""));

const OVERRIDE_NOTE = "BEST-PROGRAM OVERRIDE 2026-08-13 (user-approved 'do your recommendations'): blocked on the executable TP1-only record — negative on BOTH the lab reference-geometry basis (train era 2025-06..2026-04) and the as-calibrated rebased book. The pre-override record-convention stats are retired; see LEARNINGS.";

// 1. combo blocks @15m — flip existing, add missing with measured executable stats.
const blocks: Record<string, { n: number; winRate: number; pf: number; expectancy: number }> = {
  "Fr+YB@15m":        { n: 915, winRate: 0.691, pf: 0.89, expectancy: -1.71 },
  "Vec+YB@15m":       { n: 49,  winRate: 0.653, pf: 0.80, expectancy: -2.60 },
  "Fr+Vec+YB@15m":    { n: 34,  winRate: 0.618, pf: 0.71, expectancy: -3.58 },
  "ICT+YB@15m":       { n: 30,  winRate: 0.733, pf: 0.90, expectancy: -1.61 },
  "Fr+ICT+YB@15m":    { n: 24,  winRate: 0.708, pf: 0.94, expectancy: -1.43 },
  "FG+Fr+Vec+YB@15m": { n: 17,  winRate: 0.647, pf: 0.73, expectancy: -3.18 },
};
for (const [key, s] of Object.entries(blocks)) {
  const existing = data.comboClasses[key];
  if (existing) {
    existing.allowed = false;
    existing.note = `${existing.note ?? ""} | ${OVERRIDE_NOTE}`;
  } else {
    data.comboClasses[key] = { ...s, allowed: false, note: OVERRIDE_NOTE };
  }
}

// 2. 15m exits (both signal classes).
for (const cls of ["fact-engine@15m", "vector-side-entry@15m"]) {
  const e = data.exitByClass[cls];
  if (!e) continue;
  e.tp1 = 10.5;
  e.sl = 26;
  e.pool = "best-program lab 2026-08-13: valid-era Pareto knee on the blocked 15m set, realistic fills (86.9% win, +4.65/tr net)";
}

data.generatedAt = new Date().toISOString();
data.source += " | HAND-CALIBRATED 2026-08-13 by the best-program ship (15m combo blocks + 10.5/26 exits) — review the next weekly regen against these verdicts before accepting it";

const newBlob = JSON.stringify(data, null, 2) + ";";
src = src.slice(0, jsonStart) + newBlob + src.slice(jsonEnd + 3);
fs.writeFileSync(FILE, src);
console.log("[gate-patch] applied: 6 combo blocks @15m, exits 10.5/26 on both 15m classes");
