// scripts/analysis/shadow-rules-chain-score.ts
// ─────────────────────────────────────────────────────────────────────────────
// SHADOW-RULE CHAIN-AWARE REPLAY + SCORING (2026-10-01, quant round after the builder round).
//
// Runs the fe-bt harness in the SANDBOX COPY (C:\BaxterSandbox\fe-bt-20260924, WINDOW_START_KEY
// rolled to 2026-06-24, data/ junction opened readonly:true via --strict-readonly, never
// --persist) once per variant, then scores every run the same way:
//   - per interval: gated fires, n / win % / GROSS and NET (-1 pt) expectancy / PF, H1 vs H2;
//   - Apex mode: every fire re-walked on the harness's own 1m bars and flattened at the close
//     of the last bar before 16:55 ET of its session day (the carry re-walk is validated first);
//   - de-clustered: cross-interval ONE-OPEN-PER-DIRECTION walk (chronological, finest interval
//     first on ties; a fire is skipped while a kept same-direction trade is still open under
//     the mode's exit);
//   - drop-best-3-days: the population minus its 3 best session days (by net);
//   - CHAIN effect vs the baseline run: removed fires split into DIRECT (the baseline row carries
//     the rule's own shadow tag) and KNOCK-ON (no tag: a chain casualty), and the ADMITTED
//     fires (present only under the rule: the freed cooldown / open slot let them through),
//     each scored.
// Verdict per rule (task spec): SHIP only if H2 net > 0 after de-clustering, that H2 result is
// not carried by its best 3 days, and the chain-admitted fires are not negative.
//
//   npx tsx scripts/analysis/shadow-rules-chain-score.ts --strict-readonly [--run] [--only baseline,R1]
//        [--from 2026-06-24] [--sandbox C:\BaxterSandbox\fe-bt-20260924] [--out C:\BaxterSandbox\analysis\shadow-rules\chain-replay]
//
// --strict-readonly MUST be on the command line: this file imports the harness module for
// loadData, and the harness reads process.argv at import time (readonly-only DB handle).
// Outputs ONLY under --out. Nothing in the repo, the DB, .env, the gate or git is touched.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { etWallToEpoch, sessionDayKey } from "../../shared/yellowbox-core";

const SANDBOX_DEFAULT = "C:\\BaxterSandbox\\fe-bt-20260924";
const OUT_DEFAULT = "C:\\BaxterSandbox\\analysis\\shadow-rules\\chain-replay";
const FRICTION = 1.0;
const H2_START = etWallToEpoch("2026-08-13", 0, 0);
const CURRENT_RULES_START = etWallToEpoch("2026-09-27", 0, 0);
const IVS = ["1m", "5m", "15m", "60m"] as const;
type Iv = (typeof IVS)[number];
const IV_RANK: Record<string, number> = { "1m": 0, "5m": 1, "15m": 2, "60m": 3 };

interface Variant { id: string; label: string; flags: string[]; tags: string[] }
const VARIANTS: Variant[] = [
  { id: "baseline", label: "shipped engine (no shadow rule)", flags: [], tags: [] },
  { id: "R1", label: "REQUIRE_BOX_SIDE", flags: ["--require-box-side"], tags: ["box-side-wrong"] },
  { id: "R2", label: "MIN_SESSION_RANGE_FRAC 0.25", flags: ["--min-session-range-frac", "0.25"], tags: ["range-below-0.25med"] },
  { id: "R3", label: "BLOCK_TIGHT_ROOM_INTERVALS 5m,15m", flags: ["--block-tight-room", "5m,15m"], tags: ["tight-room@5m15m"] },
  { id: "R4", label: "MIN_TP1_PTS_BY_INTERVAL 1m=12.25", flags: ["--min-tp1-by-interval", "1m=12.25"], tags: ["1m-anchor-under-12.25"] },
  { id: "SetB", label: "R1 + R2 + MAX_SESSION_RANGE_FRAC 1.0 + tight-room blocked on every interval",
    flags: ["--require-box-side", "--min-session-range-frac", "0.25", "--max-session-range-frac", "1.0", "--block-tight-room", "1m,5m,15m,60m"],
    tags: ["box-side-wrong", "range-below-0.25med", "range-above-1.0med", "tight-room@5m15m"] },
];

let FROM = "2026-06-24", SANDBOX = SANDBOX_DEFAULT, OUT = OUT_DEFAULT, RUN = false, ONLY: string[] | null = null;
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--from") FROM = a[++i];
    else if (a[i] === "--sandbox") SANDBOX = a[++i];
    else if (a[i] === "--out") OUT = a[++i];
    else if (a[i] === "--run") RUN = true;
    else if (a[i] === "--only") ONLY = String(a[++i] ?? "").split(",");
  }
  if (!a.includes("--strict-readonly")) { console.error("[chain-score] pass --strict-readonly (the imported harness module opens the DB readonly-only when it sees the flag)"); process.exit(2); }
}
process.env.BAXTER_ARTIFACTS_DIR = path.join(OUT, "_loader"); // the harness module mkdirs its artifacts dir at import
fs.mkdirSync(OUT, { recursive: true });

// ───────────────────────────── harness rows ─────────────────────────────
interface Row {
  fireTs: number; entryTs: number; dateET: string; timeET: string; sessionDay: string; session: string;
  interval: Iv; direction: "Long" | "Short"; signalType: string; anchor: string;
  entry: number; tp1: number; sl: number; outcome: string; exitTs: number | null; pointsResult: number | null;
  shadowTags?: string[]; riskFlags?: string[]; combo?: string;
}
const key = (r: Row): string => `${r.interval}|${r.fireTs}|${r.direction}`;
function resultsPath(v: Variant): string {
  return path.join(OUT, v.id, `fact-engine-backtest-results.window${v.flags.length ? ".shadow-rules" : ""}.json`);
}

function runVariant(v: Variant): void {
  const dir = path.join(OUT, v.id);
  fs.mkdirSync(dir, { recursive: true });
  const args = ["tsx", "scripts/fact-engine-backtest.ts", "--window-from", FROM, "--skip-xlsx", "--strict-readonly", ...v.flags];
  console.log(`[chain-score] ${v.id}: (cd ${SANDBOX}) npx ${args.join(" ")}  -> ${dir}`);
  const t0 = Date.now();
  const res = spawnSync(`npx ${args.join(" ")}`, {
    cwd: SANDBOX, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, BAXTER_ARTIFACTS_DIR: dir, IB_ENABLED: "false" },
  });
  fs.writeFileSync(path.join(dir, "fe-bt.log"), `${res.stdout ?? ""}\n--- stderr ---\n${res.stderr ?? ""}`);
  if (res.status !== 0) throw new Error(`${v.id}: fe-bt exit ${res.status} (see ${path.join(dir, "fe-bt.log")})`);
  const med = /dead-tape baseline: median session-day range ([\d.]+) over (\d+) window days/.exec(res.stdout ?? "");
  console.log(`[chain-score] ${v.id}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s; dead-tape median ${med?.[1]} over ${med?.[2]} days`);
}

// ───────────────────────────── scoring ─────────────────────────────
type Mode = "carry" | "apex";
interface Scored extends Row { k: string; pts: Record<Mode, number | null>; exit: Record<Mode, number>; win: Record<Mode, boolean | null> }
interface Stats { n: number; wins: number; winPct: number | null; gross: number | null; net: number | null; netTotal: number; pf: number | null; open: number }
const r2 = (x: number): number => Math.round(x * 100) / 100;
function stats(rows: Scored[], mode: Mode): Stats {
  let n = 0, wins = 0, tot = 0, pos = 0, neg = 0, open = 0;
  for (const r of rows) {
    const p = r.pts[mode];
    if (p == null) { open++; continue; }
    n++; tot += p; if (r.win[mode]) wins++;
    const q = p - FRICTION; if (q > 0) pos += q; else neg -= q;
  }
  const netTotal = tot - n * FRICTION;
  return { n, wins, winPct: n ? r2((wins / n) * 100) : null, gross: n ? r2(tot / n) : null, net: n ? r2(netTotal / n) : null, netTotal: r2(netTotal), pf: neg > 0 ? r2(pos / neg) : (pos > 0 ? Infinity : null), open };
}
/** Cross-interval one-open-per-direction: chronological, finest interval first on ties. */
function decluster(rows: Scored[], mode: Mode): Scored[] {
  const sorted = [...rows].sort((a, b) => a.fireTs - b.fireTs || IV_RANK[a.interval] - IV_RANK[b.interval]);
  const openUntil: Record<string, number> = { Long: -Infinity, Short: -Infinity };
  const kept: Scored[] = [];
  for (const r of sorted) {
    if (r.fireTs < openUntil[r.direction]) continue;
    kept.push(r);
    openUntil[r.direction] = r.pts[mode] == null ? Infinity : r.exit[mode];
  }
  return kept;
}
function dropBestDays(rows: Scored[], mode: Mode, k = 3): { rows: Scored[]; dropped: Array<{ day: string; net: number }> } {
  const byDay = new Map<string, number>();
  for (const r of rows) { const p = r.pts[mode]; if (p == null) continue; byDay.set(r.sessionDay, (byDay.get(r.sessionDay) ?? 0) + p - FRICTION); }
  const best = [...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  const drop = new Set(best.map(x => x[0]));
  return { rows: rows.filter(r => !drop.has(r.sessionDay)), dropped: best.map(([day, net]) => ({ day, net: r2(net) })) };
}
const inH1 = (r: Row): boolean => r.fireTs < H2_START;
const inH2 = (r: Row): boolean => r.fireTs >= H2_START;
const pfStr = (s: Stats): string => s.pf === Infinity ? "inf" : s.pf == null ? "-" : String(s.pf);
const sgn = (x: number | null): string => x == null ? "-" : `${x >= 0 ? "+" : ""}${x}`;

async function main(): Promise<void> {
  const variants = VARIANTS.filter(v => !ONLY || ONLY.includes(v.id));
  if (RUN) for (const v of variants) runVariant(v);

  // 1m bars from the harness's own loader (readonly-only handle: --strict-readonly is on argv).
  const harness = await import("../fact-engine-backtest");
  const L = harness.loadData();
  const c1m = L.c1m as Array<{ time: number; open: number; high: number; low: number; close: number }>;
  const N = c1m.length;
  const T = new Float64Array(N), Hi = new Float64Array(N), Lo = new Float64Array(N), Cl = new Float64Array(N);
  for (let i = 0; i < N; i++) { T[i] = c1m[i].time; Hi[i] = c1m[i].high; Lo[i] = c1m[i].low; Cl[i] = c1m[i].close; }
  const covered = Math.min(T[N - 1] + 60, Math.floor(Date.now() / 1000));
  const lowerBound = (t: number): number => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; } return lo; };
  console.log(`[chain-score] 1m bars ${N} through ${new Date(covered * 1000).toISOString()}`);

  /** Re-walk a fire. Same conventions as shared/outcome-resolver walkOutcomeCanonical (TP1-only, stop first on a
   *  same-bar touch, fills at the level). apexTs = 16:55 ET of the entry's session day: flat at the close of the
   *  last bar before it. Returns null pts when still open at the data horizon. */
  function walk(r: Row, apexTs: number | null): { pts: number | null; exit: number; win: boolean | null } {
    const long = r.direction === "Long";
    const tpD = Math.abs(r.tp1 - r.entry), slD = Math.abs(r.sl - r.entry);
    for (let i = lowerBound(r.entryTs); i < N; i++) {
      if (T[i] + 60 > covered) break;
      if (apexTs != null && T[i] >= apexTs) {
        if (i === 0 || T[i - 1] < r.entryTs) return { pts: 0, exit: T[i], win: false }; // no bar before the cut: flat at entry
        const px = long ? Cl[i - 1] - r.entry : r.entry - Cl[i - 1];
        return { pts: px, exit: T[i - 1] + 60, win: px > 0 };
      }
      const slHit = long ? Lo[i] <= r.sl : Hi[i] >= r.sl;
      if (slHit) return { pts: -slD, exit: T[i] + 60, win: false };
      const tpHit = long ? Hi[i] >= r.tp1 : Lo[i] <= r.tp1;
      if (tpHit) return { pts: tpD, exit: T[i] + 60, win: true };
    }
    return { pts: null, exit: Infinity, win: null };
  }

  const loaded: Array<{ v: Variant; rows: Scored[]; log: string }> = [];
  let valOk = 0, valTot = 0; const valBad: string[] = [];
  for (const v of VARIANTS) {
    const p = resultsPath(v);
    if (!fs.existsSync(p)) continue;
    const doc = JSON.parse(fs.readFileSync(p, "utf8")) as { signals: Row[] };
    const logPath = path.join(OUT, v.id, "fe-bt.log");
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const rows: Scored[] = doc.signals.map(r => {
      const carry = walk(r, null);
      const apex = walk(r, etWallToEpoch(sessionDayKey(r.entryTs), 16, 55));
      valTot++;
      const hPts = r.outcome === "open" || r.pointsResult == null ? null : r.pointsResult;
      if ((hPts == null && carry.pts == null) || (hPts != null && carry.pts != null && Math.abs(hPts - carry.pts) < 1e-6)) valOk++;
      else if (valBad.length < 10) valBad.push(`${v.id} ${key(r)} harness ${r.outcome}/${r.pointsResult} re-walk ${carry.pts}`);
      return { ...r, k: key(r), pts: { carry: carry.pts, apex: apex.pts }, exit: { carry: carry.exit, apex: apex.exit }, win: { carry: carry.win, apex: apex.win } };
    });
    loaded.push({ v, rows, log });
  }
  console.log(`[chain-score] VALIDATION carry re-walk vs harness outcomes: ${valOk}/${valTot}${valBad.length ? "\n  " + valBad.join("\n  ") : ""}`);
  const base = loaded.find(x => x.v.id === "baseline");
  if (!base) throw new Error("baseline run missing");
  const baseByKey = new Map(base.rows.map(r => [r.k, r]));

  const csvVariants: string[] = ["variant,mode,slice,n,wins,win_pct,gross_exp,net_exp,net_total,pf,open"];
  const csvInterval: string[] = ["variant,mode,interval,slice,n,wins,win_pct,gross_exp,net_exp,net_total,pf"];
  const csvChain: string[] = ["variant,class,interval,fireTs,dateET,timeET,session,direction,signalType,anchor,outcome_carry,pts_carry,pts_apex,baseline_tags,kept_declustered_in_variant"];
  const summary: Record<string, unknown>[] = [];
  const md: string[] = [];
  const f = (s: Stats): string => s.n ? `${s.n} / ${s.winPct}% / ${sgn(s.gross)} / ${sgn(s.net)} / ${pfStr(s)}` : "0";
  const fs2 = (s: Stats): string => s.n ? `${s.n} / ${sgn(s.net)} (${sgn(s.netTotal)})` : "0";
  const pushCell = (vid: string, mode: Mode, slice: string, s: Stats): void => {
    csvVariants.push([vid, mode, slice, s.n, s.wins, s.winPct ?? "", s.gross ?? "", s.net ?? "", s.netTotal, pfStr(s), s.open].join(","));
  };
  const medOf = (log: string): string => { const m = /dead-tape baseline: median session-day range ([\d.]+) over (\d+) window days/.exec(log); return m ? `${m[1]} (${m[2]} days)` : "?"; };
  const suppressedOf = (log: string): string => { const m = /shadowRuleSuppressed[^\n]*/.exec(log); return m ? m[0].trim() : ""; };

  md.push(`# Shadow-rule CHAIN-AWARE replay (sandbox fe-bt, ${FROM} -> latest)`, "",
    `Generated ${new Date().toISOString()} by \`scripts/analysis/shadow-rules-chain-score.ts\`. Each variant is a full fe-bt WINDOW-mode engine re-run in the sandbox copy`,
    `(\`${SANDBOX}\`, WINDOW_START_KEY 2026-06-24 so the dead-tape median is the 3-month one: ${medOf(base.log)}; shipped quality gate + calibrated exits; cooldown 10 / one-open-per-direction chain included; data/app.db opened readonly:true; never --persist).`,
    `Carry re-walk validation against the harness's own outcomes: ${valOk}/${valTot}. Cells: **n / win % / gross exp / NET exp (-${FRICTION} pt) / PF**; "n / net (total)" where marked.`,
    `H1 = 06-24..08-12, H2 = 08-13..; current rules = fires from 2026-09-27. **Apex** = every fire flattened at the close of the last 1m bar before 16:55 ET of its session day.`,
    `**De-clustered** = cross-interval one-open-per-direction (chronological, finest interval first on ties). **Drop-3** = minus the population's 3 best session days by net.`,
    `In-sample warning: every threshold (0.25, 1.0, 12.25, the box-side rule) was chosen on this same window. Nothing here is shipped; every setting stays OFF.`, "");

  const verdicts: Array<Record<string, string>> = [];
  const slices: Array<[string, (r: Scored) => boolean]> = [["all", () => true], ["H1", inH1], ["H2", inH2], ["currentRules", r => r.fireTs >= CURRENT_RULES_START], ["RTH", r => r.session === "RTH"], ["ETH", r => r.session === "ETH"]];
  const MODES: Mode[] = ["carry", "apex"];
  for (const { v, rows, log } of loaded) {
    const block: Record<string, Record<Mode, Stats>> = {};
    const perMode = {} as Record<Mode, { decl: Scored[]; drop3: ReturnType<typeof dropBestDays>; declDrop3: ReturnType<typeof dropBestDays>; declH2Drop3: ReturnType<typeof dropBestDays>; h2Drop3: ReturnType<typeof dropBestDays> }>;
    for (const mode of MODES) {
      for (const [name, pred] of slices) { (block[name] ??= {} as Record<Mode, Stats>)[mode] = stats(rows.filter(pred), mode); pushCell(v.id, mode, name, block[name][mode]); }
      const decl = decluster(rows, mode);
      const drop3 = dropBestDays(rows, mode), declDrop3 = dropBestDays(decl, mode);
      const h2Drop3 = dropBestDays(rows.filter(inH2), mode), declH2Drop3 = dropBestDays(decl.filter(inH2), mode);
      perMode[mode] = { decl, drop3, declDrop3, declH2Drop3, h2Drop3 };
      pushCell(v.id, mode, "declustered_all", stats(decl, mode));
      pushCell(v.id, mode, "declustered_H1", stats(decl.filter(inH1), mode));
      pushCell(v.id, mode, "declustered_H2", stats(decl.filter(inH2), mode));
      pushCell(v.id, mode, "declustered_currentRules", stats(decl.filter(r => r.fireTs >= CURRENT_RULES_START), mode));
      pushCell(v.id, mode, "drop3_all", stats(drop3.rows, mode));
      pushCell(v.id, mode, "drop3_H2", stats(h2Drop3.rows, mode));
      pushCell(v.id, mode, "declustered_drop3_all", stats(declDrop3.rows, mode));
      pushCell(v.id, mode, "declustered_drop3_H2", stats(declH2Drop3.rows, mode));
      for (const iv of IVS) {
        const ivRows = rows.filter(r => r.interval === iv);
        const ivSlices: Array<[string, (r: Scored) => boolean]> = [["all", () => true], ["H1", inH1], ["H2", inH2]];
        for (const [name, pred] of ivSlices) {
          const s = stats(ivRows.filter(pred), mode);
          csvInterval.push([v.id, mode, iv, name, s.n, s.wins, s.winPct ?? "", s.gross ?? "", s.net ?? "", s.netTotal, pfStr(s)].join(","));
        }
        const sd = stats(decl.filter(r => r.interval === iv), mode);
        csvInterval.push([v.id, mode, iv, "declustered_all", sd.n, sd.wins, sd.winPct ?? "", sd.gross ?? "", sd.net ?? "", sd.netTotal, pfStr(sd)].join(","));
      }
    }

    // chain vs baseline
    const keys = new Set(rows.map(r => r.k));
    const removed = base.rows.filter(r => !keys.has(r.k));
    const direct = removed.filter(r => (r.shadowTags ?? []).some(t => v.tags.includes(t)));
    const knockOn = removed.filter(r => !(r.shadowTags ?? []).some(t => v.tags.includes(t)));
    const added = rows.filter(r => !baseByKey.has(r.k));
    const declKeysCarry = new Set(perMode.carry.decl.map(r => r.k));
    const addedDecl = added.filter(r => declKeysCarry.has(r.k));
    let commonDiff = 0;
    for (const r of rows) { const b = baseByKey.get(r.k); if (b && (b.pointsResult !== r.pointsResult || b.tp1 !== r.tp1 || b.sl !== r.sl)) commonDiff++; }
    const chainLists: Array<[string, Scored[]]> = [["direct-blocked", direct], ["knock-on-removed", knockOn], ["chain-admitted", added]];
    for (const [cls, list] of chainLists) {
      for (const r of list) csvChain.push([v.id, cls, r.interval, r.fireTs, r.dateET, r.timeET, r.session, r.direction, r.signalType, r.anchor, r.outcome, r.pts.carry ?? "", r.pts.apex ?? "", `"${(baseByKey.get(r.k)?.shadowTags ?? r.shadowTags ?? []).join(";")}"`, cls === "chain-admitted" ? (declKeysCarry.has(r.k) ? 1 : 0) : ""].join(","));
    }
    const chain = {
      removed: removed.length, direct: stats(direct, "carry"), knockOn: stats(knockOn, "carry"),
      added: stats(added, "carry"), addedH1: stats(added.filter(inH1), "carry"), addedH2: stats(added.filter(inH2), "carry"), addedApex: stats(added, "apex"),
      addedDecl: stats(addedDecl, "carry"), addedByIv: Object.fromEntries(IVS.map(iv => [iv, stats(added.filter(r => r.interval === iv), "carry")])) as Record<Iv, Stats>,
      commonDiff,
    };
    const chainCells: Record<string, Stats> = { chain_direct_blocked: chain.direct, chain_knock_on_removed: chain.knockOn, chain_admitted: chain.added, chain_admitted_H1: chain.addedH1, chain_admitted_H2: chain.addedH2, chain_admitted_declustered: chain.addedDecl };
    for (const [slice, s] of Object.entries(chainCells)) pushCell(v.id, "carry", slice, s);
    pushCell(v.id, "apex", "chain_admitted", chain.addedApex);

    // verdict (carry = the book convention; Apex reported beside it)
    const h2Decl = stats(perMode.carry.decl.filter(inH2), "carry");
    const h2DeclDrop3 = stats(perMode.carry.declH2Drop3.rows, "carry");
    const c1 = h2Decl.netTotal > 0, c2 = h2DeclDrop3.netTotal > 0, c3 = chain.added.n === 0 || chain.added.netTotal >= 0;
    const ship = v.id !== "baseline" && c1 && c2 && c3;
    const why = v.id === "baseline" ? "reference" : [
      `H2 de-clustered net ${sgn(h2Decl.netTotal)} (${h2Decl.n} tr, ${sgn(h2Decl.net)}/tr) ${c1 ? "OK" : "FAIL"}`,
      `minus best 3 H2 days ${sgn(h2DeclDrop3.netTotal)} (${h2DeclDrop3.n} tr; dropped ${perMode.carry.declH2Drop3.dropped.map(d => `${d.day} ${sgn(d.net)}`).join(", ")}) ${c2 ? "OK" : "FAIL"}`,
      `chain-admitted ${chain.added.n} fires net ${sgn(chain.added.netTotal)} (${sgn(chain.added.net)}/tr) ${c3 ? "OK" : "FAIL"}`,
    ].join("; ");
    verdicts.push({ rule: v.id, verdict: v.id === "baseline" ? "-" : ship ? "SHIP (in-sample thresholds: shadow first)" : "NO-SHIP", why });

    summary.push({
      id: v.id, label: v.label, flags: v.flags, deadTapeMedian: medOf(log), shadowRuleSuppressed: suppressedOf(log),
      total: block,
      declustered: Object.fromEntries(MODES.map(m => [m, { all: stats(perMode[m].decl, m), h1: stats(perMode[m].decl.filter(inH1), m), h2: stats(perMode[m].decl.filter(inH2), m) }])),
      drop3: Object.fromEntries(MODES.map(m => [m, { all: stats(perMode[m].drop3.rows, m), dropped: perMode[m].drop3.dropped, declAll: stats(perMode[m].declDrop3.rows, m), declDropped: perMode[m].declDrop3.dropped, declH2: stats(perMode[m].declH2Drop3.rows, m), declH2Dropped: perMode[m].declH2Drop3.dropped }])),
      byInterval: Object.fromEntries(IVS.map(iv => [iv, Object.fromEntries(MODES.map(m => [m, { all: stats(rows.filter(r => r.interval === iv), m), h1: stats(rows.filter(r => r.interval === iv && inH1(r)), m), h2: stats(rows.filter(r => r.interval === iv && inH2(r)), m), decl: stats(perMode[m].decl.filter(r => r.interval === iv), m) }]))])),
      chain, verdict: verdicts[verdicts.length - 1],
    });

    const b = block;
    md.push(`## ${v.id}: ${v.label}`, "",
      `Flags: \`${v.flags.join(" ") || "(none)"}\`. Dead-tape median ${medOf(log)}. ${suppressedOf(log) ? "Engine: " + suppressedOf(log) + ". " : ""}Common trades with baseline whose exit/outcome changed: ${commonDiff}.`, "",
      "| Slice | Carry (n / win% / gross / net / PF) | Apex flat-16:55 |", "|---|---|---|");
    for (const [name] of slices) md.push(`| ${name} | ${f(b[name].carry)} | ${f(b[name].apex)} |`);
    const pc = perMode.carry, pa = perMode.apex;
    md.push(`| de-clustered all | ${f(stats(pc.decl, "carry"))} | ${f(stats(pa.decl, "apex"))} |`,
      `| de-clustered H1 | ${f(stats(pc.decl.filter(inH1), "carry"))} | ${f(stats(pa.decl.filter(inH1), "apex"))} |`,
      `| de-clustered H2 | ${f(stats(pc.decl.filter(inH2), "carry"))} | ${f(stats(pa.decl.filter(inH2), "apex"))} |`,
      `| drop-3 all (as fired) | ${f(stats(pc.drop3.rows, "carry"))} dropped ${pc.drop3.dropped.map(d => d.day).join(",")} | ${f(stats(pa.drop3.rows, "apex"))} |`,
      `| de-clustered drop-3 all | ${f(stats(pc.declDrop3.rows, "carry"))} | ${f(stats(pa.declDrop3.rows, "apex"))} |`,
      `| de-clustered H2 drop-3 | ${f(stats(pc.declH2Drop3.rows, "carry"))} dropped ${pc.declH2Drop3.dropped.map(d => `${d.day} ${sgn(d.net)}`).join(", ")} | ${f(stats(pa.declH2Drop3.rows, "apex"))} |`);
    md.push("", "| Interval | Carry all | Carry H1 | Carry H2 | Apex all | De-clustered carry all |", "|---|---|---|---|---|---|");
    for (const iv of IVS) md.push(`| ${iv} | ${f(stats(rows.filter(r => r.interval === iv), "carry"))} | ${f(stats(rows.filter(r => r.interval === iv && inH1(r)), "carry"))} | ${f(stats(rows.filter(r => r.interval === iv && inH2(r)), "carry"))} | ${f(stats(rows.filter(r => r.interval === iv), "apex"))} | ${f(stats(pc.decl.filter(r => r.interval === iv), "carry"))} |`);
    if (v.id !== "baseline") {
      md.push("", "**Chain vs baseline (carry, n / net per trade (total)):**", "",
        `- Removed ${chain.removed}: direct (baseline row carries the rule's tag) ${fs2(chain.direct)}; knock-on (untagged casualty of the changed chain) ${fs2(chain.knockOn)}.`,
        `- Chain-ADMITTED (fires only under the rule): ${fs2(chain.added)}; H1 ${fs2(chain.addedH1)} / H2 ${fs2(chain.addedH2)}; Apex ${fs2(chain.addedApex)}; survive de-clustering ${fs2(chain.addedDecl)}; by interval ${IVS.map(iv => `${iv} ${fs2(chain.addedByIv[iv])}`).join(", ")}.`,
        `- Verdict: **${verdicts[verdicts.length - 1].verdict}**. ${why}`);
    }
    md.push("");
  }

  md.push("## Verdicts (task rule: SHIP only if H2 net > 0 after de-clustering, not carried by its best 3 days, chain-admitted fires not negative)", "", "| Rule | Verdict | Checks |", "|---|---|---|");
  for (const vd of verdicts) md.push(`| ${vd.rule} | ${vd.verdict} | ${vd.why} |`);
  md.push("", "## Baseline shadow tags (raw as fired, carry)", "", "| Tag | Interval | Tagged n / win% / gross / net / PF | H1 | H2 | Untagged |", "|---|---|---|---|---|---|");
  for (const tag of ["box-side-wrong", "range-below-0.25med", "range-above-1.0med", "tight-room@5m15m", "1m-anchor-under-12.25"]) {
    for (const iv of [...IVS, "all"]) {
      const pop = base.rows.filter(r => iv === "all" || r.interval === iv);
      const tg = pop.filter(r => (r.shadowTags ?? []).includes(tag)), un = pop.filter(r => !(r.shadowTags ?? []).includes(tag));
      if (!tg.length) continue;
      md.push(`| ${tag} | ${iv} | ${f(stats(tg, "carry"))} | ${f(stats(tg.filter(inH1), "carry"))} | ${f(stats(tg.filter(inH2), "carry"))} | ${f(stats(un, "carry"))} |`);
    }
  }
  md.push("", "## Files", "", "- `variants.csv`: every slice x mode per variant (n, wins, win %, gross/net exp, net total, PF, open).",
    "- `by-interval.csv`: per interval x mode x slice.", "- `chain-fires.csv`: every removed (direct / knock-on) and chain-admitted fire with its baseline tags and whether it survives de-clustering.",
    "- `summary.json`: everything above as data. `<variant>/`: the fe-bt run (results JSON, CSV, log).", "");

  fs.writeFileSync(path.join(OUT, "variants.csv"), csvVariants.join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "by-interval.csv"), csvInterval.join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "chain-fires.csv"), csvChain.join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), from: FROM, sandbox: SANDBOX, friction: FRICTION, validation: { ok: valOk, total: valTot, bad: valBad }, variants: summary }, null, 1));
  fs.writeFileSync(path.join(OUT, "REPORT.md"), md.join("\n"));
  console.log(md.join("\n"));
}
main().catch(e => { console.error(e); process.exit(1); });
