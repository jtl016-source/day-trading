// scripts/analysis/shadow-rules-replay.ts
// ─────────────────────────────────────────────────────────────────────────────
// SHADOW-RULE SANDBOX REPLAY (2026-10-01, docs/signal-analysis-2026-10-01.md R1–R4 + Set B).
// The analysis' row-removal numbers ignore the cooldown / one-open chain ("only engine re-runs
// count"). This runs the fe-bt harness in WINDOW mode (shipped quality-gate.ts, calibrated exits,
// nothing re-derived, the gate file never written) once per variant with the new OFF-by-default
// engine settings switched on through the harness flags, then scores every run the same way.
//
//   npx tsx scripts/analysis/shadow-rules-replay.ts [--from 2026-06-24] [--only baseline,R1] [--summarize-only]
//
// SAFETY: every fe-bt child gets --strict-readonly (data/app.db opened readonly:true, no
// write-handle fallback), never --persist; BAXTER_ARTIFACTS_DIR points each run at its own
// folder under C:\BaxterSandbox\analysis\shadow-rules\ so no repo deliverable is touched.
// Runs are sequential (the live server shares this machine).
//
// Output: <OUT>/<variant>/fact-engine-backtest-results.window[.shadow-rules].json (+ csv),
//         <OUT>/summary.json, <OUT>/SUMMARY.md.
// Scoring: harness records (carry-overnight, 1m walk), NET of 1.0 pt friction per trade;
// H1 = 06-24..08-12, H2 = 08-13..; "current rules" = session days from 2026-09-27 (method
// rule from the analysis) reported separately. Win = harness tp1/tp2 (DB win_tp1/win_tp2); open rows not scored.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = process.env.SHADOW_RULES_OUT ?? "C:\\BaxterSandbox\\analysis\\shadow-rules";
const FRICTION = 1.0;
const H2_START = Date.UTC(2026, 7, 13, 4, 0, 0) / 1000;      // 2026-08-13 00:00 ET
const CURRENT_RULES_START = Date.UTC(2026, 8, 27, 4, 0, 0) / 1000;  // 2026-09-27 00:00 ET (a Sunday — the first fires are the 18:00 ET reopen)

interface Variant { id: string; label: string; flags: string[] }
const VARIANTS: Variant[] = [
  { id: "baseline", label: "shipped engine (no shadow rule)", flags: [] },
  { id: "R1", label: "REQUIRE_BOX_SIDE", flags: ["--require-box-side"] },
  { id: "R2", label: "MIN_SESSION_RANGE_FRAC 0.25", flags: ["--min-session-range-frac", "0.25"] },
  { id: "R3", label: "BLOCK_TIGHT_ROOM_INTERVALS 5m,15m", flags: ["--block-tight-room", "5m,15m"] },
  { id: "R4", label: "MIN_TP1_PTS_BY_INTERVAL 1m=12.25", flags: ["--min-tp1-by-interval", "1m=12.25"] },
  { id: "SetB", label: "R1 + R2 + MAX_SESSION_RANGE_FRAC 1.0 + tight-room blocked on every interval",
    flags: ["--require-box-side", "--min-session-range-frac", "0.25", "--max-session-range-frac", "1.0", "--block-tight-room", "1m,5m,15m,60m"] },
];

let FROM = "2026-06-24";
let ONLY: string[] | null = null;
let SUMMARIZE_ONLY = false;
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--from") FROM = a[++i];
    else if (a[i] === "--only") ONLY = String(a[++i] ?? "").split(",");
    else if (a[i] === "--summarize-only") SUMMARIZE_ONLY = true;
  }
}

interface Row {
  fireTs: number; interval: string; direction: string; session: string; outcome: string;
  pointsResult: number | null; shadowTags?: string[];
}
interface Stats { n: number; wins: number; winPct: number | null; net: number; exp: number | null; pf: number | null; open: number }
function stats(rows: Row[]): Stats {
  let n = 0, wins = 0, net = 0, pos = 0, neg = 0, open = 0;
  for (const r of rows) {
    if (r.pointsResult == null || !Number.isFinite(r.pointsResult) || r.outcome === "open") { open++; continue; }
    const p = r.pointsResult - FRICTION;
    n++; net += p;
    if (r.outcome.startsWith("win") || r.outcome === "tp1" || r.outcome === "tp2") wins++; // harness vocab tp1/tp2/sl/eod/open
    if (p > 0) pos += p; else neg -= p;
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { n, wins, winPct: n ? Math.round((wins / n) * 1000) / 10 : null, net: r2(net), exp: n ? r2(net / n) : null, pf: neg > 0 ? r2(pos / neg) : null, open };
}
function block(rows: Row[]) {
  return {
    all: stats(rows),
    h1: stats(rows.filter(r => r.fireTs < H2_START)),
    h2: stats(rows.filter(r => r.fireTs >= H2_START)),
    currentRules: stats(rows.filter(r => r.fireTs >= CURRENT_RULES_START)),
    rth: stats(rows.filter(r => r.session === "RTH")),
    eth: stats(rows.filter(r => r.session === "ETH")),
  };
}

function resultsPath(v: Variant): string {
  const dir = path.join(OUT, v.id);
  const suffix = v.flags.length ? ".window.shadow-rules" : ".window";
  return path.join(dir, `fact-engine-backtest-results${suffix}.json`);
}

function runVariant(v: Variant): void {
  const dir = path.join(OUT, v.id);
  fs.mkdirSync(dir, { recursive: true });
  const args = ["tsx", "scripts/fact-engine-backtest.ts", "--window-from", FROM, "--skip-xlsx", "--strict-readonly", ...v.flags];
  console.log(`[shadow-replay] ${v.id}: npx ${args.join(" ")}  (artifacts → ${dir})`);
  const t0 = Date.now();
  const res = spawnSync(`npx ${args.join(" ")}`, { // fixed argv (no user input) — one command string, no DEP0190
    cwd: ROOT, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, BAXTER_ARTIFACTS_DIR: dir },
  });
  fs.writeFileSync(path.join(dir, "fe-bt.log"), `${res.stdout ?? ""}\n--- stderr ---\n${res.stderr ?? ""}`);
  if (res.status !== 0) throw new Error(`${v.id}: fe-bt exit ${res.status} (see ${path.join(dir, "fe-bt.log")})`);
  console.log(`[shadow-replay] ${v.id}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  const variants = VARIANTS.filter(v => !ONLY || ONLY.includes(v.id));
  if (!SUMMARIZE_ONLY) for (const v of variants) runVariant(v);

  const loaded: Array<{ v: Variant; rows: Row[]; meta: unknown }> = [];
  for (const v of VARIANTS) {
    const p = resultsPath(v);
    if (!fs.existsSync(p)) continue;
    const doc = JSON.parse(fs.readFileSync(p, "utf8")) as { meta: unknown; signals: Row[] };
    loaded.push({ v, rows: doc.signals, meta: doc.meta });
  }
  const base = loaded.find(x => x.v.id === "baseline");
  const key = (r: Row) => `${r.interval}|${r.fireTs}|${r.direction}`;
  const baseKeys = new Set((base?.rows ?? []).map(key));
  const IVS = ["1m", "5m", "15m", "60m"];

  const variantsOut = loaded.map(({ v, rows }) => {
    const keys = new Set(rows.map(key));
    return {
      id: v.id, label: v.label, flags: v.flags,
      total: block(rows),
      byInterval: Object.fromEntries(IVS.map(iv => [iv, block(rows.filter(r => r.interval === iv))])),
      vsBaseline: base ? {
        removed: base.rows.filter(r => !keys.has(key(r))).length,
        added: rows.filter(r => !baseKeys.has(key(r))).length,
        removedStats: stats(base.rows.filter(r => !keys.has(key(r)))),
        addedStats: stats(rows.filter(r => !baseKeys.has(key(r)))),
      } : null,
    };
  });
  // Tag scoring on the BASELINE run (record-only tags, raw rows): tagged vs untagged per interval.
  const TAGS = ["box-side-wrong", "range-below-0.25med", "range-above-1.0med", "tight-room@5m15m", "1m-anchor-under-12.25"];
  const tagTable = base ? TAGS.flatMap(tag => [...IVS, "all"].map(iv => {
    const pop = base.rows.filter(r => iv === "all" || r.interval === iv);
    return { tag, interval: iv, tagged: block(pop.filter(r => (r.shadowTags ?? []).includes(tag))), untagged: block(pop.filter(r => !(r.shadowTags ?? []).includes(tag))) };
  })) : [];

  const summary = { generatedAt: new Date().toISOString(), from: FROM, frictionPts: FRICTION, variants: variantsOut, baselineTags: tagTable };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));

  const f = (s: Stats) => s.n ? `${s.n} / ${s.winPct}% / ${s.exp! >= 0 ? "+" : ""}${s.exp} / ${s.pf ?? "-"}` : "0";
  const md: string[] = [];
  md.push(`# Shadow-rule sandbox replay (${FROM} → latest)`, "",
    `Generated ${summary.generatedAt} by \`scripts/analysis/shadow-rules-replay.ts\`. Each variant is a fe-bt WINDOW-mode engine re-run`,
    "(shipped quality gate + calibrated exits, cooldown / one-open chain included) with the named OFF-by-default setting switched on.",
    "Cells: **n / win % / net expectancy per trade (−1.0 pt friction) / PF**. H1 = 06-24..08-12, H2 = 08-13..; current rules = fires from 2026-09-27.",
    "In-sample: the thresholds come from the same window (see the analysis doc). Nothing here was shipped; every setting stays OFF.", "",
    "| Variant | All | H1 | H2 | Current rules | RTH | ETH | Removed vs base (exp) | Added vs base (exp) |",
    "|---|---|---|---|---|---|---|---|---|");
  for (const v of variantsOut) {
    const t = v.total;
    md.push(`| ${v.id} — ${v.label} | ${f(t.all)} | ${f(t.h1)} | ${f(t.h2)} | ${f(t.currentRules)} | ${f(t.rth)} | ${f(t.eth)} | ${v.vsBaseline ? `${v.vsBaseline.removed} (${v.vsBaseline.removedStats.exp ?? "-"})` : "-"} | ${v.vsBaseline ? `${v.vsBaseline.added} (${v.vsBaseline.addedStats.exp ?? "-"})` : "-"} |`);
  }
  md.push("", "## By interval (All / H1 / H2)", "", "| Variant | 1m | 5m | 15m | 60m |", "|---|---|---|---|---|");
  for (const v of variantsOut) {
    md.push(`| ${v.id} | ${IVS.map(iv => `${f(v.byInterval[iv].all)}<br>H1 ${f(v.byInterval[iv].h1)}<br>H2 ${f(v.byInterval[iv].h2)}`).join(" | ")} |`);
  }
  if (tagTable.length) {
    md.push("", "## Shadow tags on the baseline run (raw, clustered as fired)", "", "| Tag | Interval | Tagged (All / H1 / H2) | Untagged All |", "|---|---|---|---|");
    for (const t of tagTable) {
      if (!t.tagged.all.n && !t.tagged.all.open) continue;
      md.push(`| ${t.tag} | ${t.interval} | ${f(t.tagged.all)} · ${f(t.tagged.h1)} · ${f(t.tagged.h2)} | ${f(t.untagged.all)} |`);
    }
  }
  fs.writeFileSync(path.join(OUT, "SUMMARY.md"), md.join("\n") + "\n");
  console.log(md.join("\n"));
}
main();
