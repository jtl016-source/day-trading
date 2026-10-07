// shared/artifacts-dir.ts
// ─────────────────────────────────────────────────────────────────────────────
// BAXTER_ARTIFACTS_DIR (2026-08-02 — user-approved OUTPUT_DIR support): harness/analysis
// artifact outputs (fact-engine results JSON/CSV/xlsx, gate-bar menu JSONs, risk-factor /
// ICT analysis JSONs, trade-chart folders) honor this env var; default = the repo root,
// exactly as before. The ops agent owns moving existing artifacts + setting the env — this
// helper only makes the paths configurable.
//
// COHERENCE RULE: the workbooks' CHART hyperlinks are RELATIVE (trade-charts\...\*.png,
// ict-trade-charts\...), so the xlsx and its chart folder MUST live in the SAME directory.
// Every writer resolves BOTH through this helper, which keeps that invariant automatically.
// Readers of the standing artifacts (server /api/risk/combo-stats, live-fire-audit,
// backfill-risk-info, gate-bar menus' self-checks) resolve through the same helper so a
// moved artifacts dir stays visible everywhere.
// ─────────────────────────────────────────────────────────────────────────────
import * as path from "node:path";

/** The artifacts directory: BAXTER_ARTIFACTS_DIR when set (resolved absolute), else the
 *  caller's default (repo root / process.cwd()). */
export function artifactsDir(defaultRoot: string): string {
  const env = process.env.BAXTER_ARTIFACTS_DIR;
  return env && env.trim().length ? path.resolve(env.trim()) : defaultRoot;
}
