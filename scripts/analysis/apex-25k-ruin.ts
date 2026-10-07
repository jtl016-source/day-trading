/**
 * scripts/analysis/apex-25k-ruin.ts — ANALYSIS ONLY (reads the signal dataset; no DB, no persistence).
 *
 * Apex 25K EVALUATION ruin re-simulation for the SHIPPED exits on the GATED fires of
 * C:\BaxterSandbox\analysis\signals-3mo.json (built by scripts/analysis/build-signal-dataset.ts), using
 * the day-sequence sim of scripts/analysis/exit-monte-carlo.ts (5-day block bootstrap of session days,
 * trades chronological within a day, trailing threshold / DLL checked against realized P&L plus each
 * trade's MAE capped at its stop) re-parameterised for the 25K evaluation:
 *
 *   Apex 25K rules (apextraderfunding.com help center, read 2026-10-01 in the browser pane):
 *     EOD Evaluation:      profit target $1,500 | max drawdown (EOD trailing) $1,000 | DLL $500 | max 4 contracts
 *     Intraday Evaluation: profit target $1,500 | max drawdown (intraday trailing, follows peak incl. unrealized) $1,000 | NO DLL
 *     "Consistency: Not Applied", no minimum trading days, 30-day access period.
 *   The brief assumed a $1,500 trailing threshold — that is the LEGACY 25K figure (legacy products retired
 *   2026-03-01); both $1,000 (official 4.0) and $1,500 are simulated. MES = $5/pt → $1,000 = 200 pts at 1 micro
 *   (100 pts/contract at 2 micros), $1,500 = 300 pts, $500 DLL = 100 pts.
 *
 *   Threshold models: EOD = trails the highest END-OF-DAY balance, enforced intraday against realized+open
 *   (worst point = day P&L so far − trade MAE − friction); INTRADAY = trails the peak INCLUDING unrealized
 *   (peak updated with each trade's MFE). Evaluation thresholds never lock (no start+$100 cap: that is a PA rule).
 *   Target = balance ≥ +300 pts/micro at a day close (no consistency rule on evaluations).
 *   Apex mode outcomes (flat at 16:55 ET) — the dataset's path.outcomeApex (shipped tp1/sl, served 1m bars).
 *
 * Sleeves: {5m+15m+60m (the owner's armed intervals), 60m only} × {all fires, ORDER-WINDOW fires 09:30–15:15 ET
 * (what the live auto-trader can actually place)} × {1, 2 micros} × {EOD DD1000 ±DLL500, EOD DD1500 ±DLL500,
 * Intraday DD1000}. Also per half (H1 / H2 day pools) for regime sensitivity.
 *
 * Outputs (only) to C:\BaxterSandbox\analysis\eth-build\replays\apex25k_*.  Run: npx tsx scripts/analysis/apex-25k-ruin.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const IN = "C:\\BaxterSandbox\\analysis\\signals-3mo.json";
const OUT = "C:\\BaxterSandbox\\analysis\\eth-build\\replays";
fs.mkdirSync(OUT, { recursive: true });
const FRICTION = 1.0;
const PT_USD = 5;
const RESAMPLES = 10000, BLOCK = 5, HORIZON = 250;
const TARGET_USD = 1500;
const ORDER_WINDOW = { from: 9 * 60 + 30, to: 15 * 60 + 15 };
const H2_FROM_KEY = "2026-08-13";
const r2 = (x: number): number => Math.round(x * 100) / 100;
const pct = (sorted: number[], p: number): number => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1) + 1e-9)))] : NaN;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── load ──
const ds = JSON.parse(fs.readFileSync(IN, "utf8")) as { meta: Record<string, unknown>; rows: Array<Record<string, any>> };
interface Tr { key: string; iv: string; day: string; half: string; entryTs: number; mins: number; inOW: boolean; gross: number; mae: number; mfe: number; outcome: string; slDist: number; tpDist: number }
const trades: Tr[] = [];
let skippedOpen = 0;
for (const r of ds.rows) {
  if (r.gated !== true) continue;
  const a = r.path.outcomeApex;
  if (a.points == null) { skippedOpen++; continue; }
  const [hh, mm] = (r.timeET as string).split(":").map(Number);
  const mins = hh * 60 + mm;
  trades.push({ key: r.key, iv: r.interval, day: r.sessionDay, half: r.half, entryTs: r.entryTs, mins, inOW: mins >= ORDER_WINDOW.from && mins < ORDER_WINDOW.to,
    gross: a.points, mae: Math.min(a.mae ?? 0, r.slDist), mfe: Math.min(a.mfe ?? 0, r.tpDist), outcome: a.outcome, slDist: r.slDist, tpDist: r.tpDist });
}
trades.sort((a, b) => a.entryTs - b.entryTs);
console.log(`[apex] dataset ${ds.rows.length} rows, gated apex-closed trades ${trades.length}, skipped open ${skippedOpen}`);

// session days: from the replay's session-days.json (served 1m bars) — fallback weekday calendar.
let allDays: string[];
try {
  allDays = (JSON.parse(fs.readFileSync(path.join(OUT, "session-days.json"), "utf8")) as { days: string[] }).days;
  console.log(`[apex] session days from session-days.json: ${allDays.length}`);
} catch {
  allDays = [];
  const d = new Date("2026-06-24T12:00:00Z"); const end = new Date("2026-10-01T12:00:00Z");
  const hol = new Set(["2026-07-03", "2026-09-07"]);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) { const wd = d.getUTCDay(); const k = d.toISOString().slice(0, 10); if (wd >= 1 && wd <= 5 && !hol.has(k)) allDays.push(k); }
  console.log(`[apex] session days from weekday calendar (fallback): ${allDays.length}`);
}
// Make sure every trade day is in the pool (a Sunday-evening session day would otherwise be dropped).
for (const t of trades) if (!allDays.includes(t.day)) allDays.push(t.day);
allDays.sort();

// ── sim ──
interface Rules { id: string; model: "EOD" | "INTRADAY"; ddUsd: number; dllUsd: number | null }
const RULES: Rules[] = [
  { id: "EOD_DD1000_DLL500", model: "EOD", ddUsd: 1000, dllUsd: 500 },      // official 4.0 EOD evaluation
  { id: "EOD_DD1000_noDLL", model: "EOD", ddUsd: 1000, dllUsd: null },
  { id: "INTRADAY_DD1000_noDLL", model: "INTRADAY", ddUsd: 1000, dllUsd: null }, // official 4.0 Intraday evaluation
  { id: "EOD_DD1500_DLL500", model: "EOD", ddUsd: 1500, dllUsd: 500 },      // brief's $1,500 threshold (legacy 25K)
  { id: "EOD_DD1500_noDLL", model: "EOD", ddUsd: 1500, dllUsd: null },
];
interface SimOut { pBlown30: number; pBlown60: number; pBlown120: number; pBlown250: number; pTarget: number; pTarget30: number; pTarget60: number; pTarget120: number; targetDaysMedian: number; targetDaysP25: number; targetDaysP75: number; blownDaysMedian: number; dllDayRate: number; medianBal60: number; p5Bal60: number; p95Bal60: number }
function daySim(idx: Tr[], days: string[], micros: number, rules: Rules, seed: number): SimOut {
  const byDay = new Map<string, Tr[]>(); for (const d of days) byDay.set(d, []);
  for (const t of idx) byDay.get(t.day)?.push(t);
  const pool = days.map(d => byDay.get(d) as Tr[]);
  const D = pool.length; const rng = mulberry32(seed);
  const dd = rules.ddUsd / PT_USD / micros, dll = rules.dllUsd == null ? null : rules.dllUsd / PT_USD / micros, target = TARGET_USD / PT_USD / micros;
  let b30 = 0, b60 = 0, b120 = 0, b250 = 0, tN = 0, t30 = 0, t60 = 0, t120 = 0, dllDays = 0, simDays = 0;
  const tDays: number[] = [], bDays: number[] = [], bal60: number[] = [];
  for (let r = 0; r < RESAMPLES; r++) {
    let bal = 0, peak = 0, thr = -dd, blownDay = -1, targetDay = -1, d = 0, balAt60 = NaN;
    while (d < HORIZON && blownDay < 0 && targetDay < 0) {
      const st = Math.floor(rng() * D);
      for (let q = 0; q < BLOCK && d < HORIZON && blownDay < 0 && targetDay < 0; q++, d++) {
        const day = pool[(st + q) % D]; let dp = 0, stopped = false;
        for (const t of day) {
          if (stopped) break;
          const worst = dp - t.mae - FRICTION;                 // day P&L at this trade's worst point
          const thrLevel = thr - bal;                           // day P&L that touches the trailing threshold
          const dllLevel = dll == null ? -Infinity : -dll;
          if (worst <= Math.max(dllLevel, thrLevel)) {
            if (thrLevel >= dllLevel) { blownDay = d + 1; break; }
            dp = dllLevel; stopped = true; dllDays++; break;   // DLL: flat at the limit, done for the day
          }
          if (rules.model === "INTRADAY") {                     // unrealized peak ratchets the threshold
            const pk = bal + dp + t.mfe; if (pk > peak) { peak = pk; thr = peak - dd; }
          }
          dp += t.gross - FRICTION;
        }
        if (blownDay >= 0) break;
        bal += dp; simDays++;
        if (bal <= thr) { blownDay = d + 1; break; }
        if (bal > peak) { peak = bal; thr = peak - dd; }        // EOD trailing (never locks on an evaluation)
        if (d + 1 === 60) balAt60 = bal;
        if (bal >= target) { targetDay = d + 1; break; }
      }
    }
    if (Number.isNaN(balAt60)) balAt60 = bal; // ended before day 60 (blown or passed): final balance
    bal60.push(balAt60);
    if (blownDay > 0) { b250++; bDays.push(blownDay); if (blownDay <= 30) b30++; if (blownDay <= 60) b60++; if (blownDay <= 120) b120++; }
    if (targetDay > 0) { tN++; tDays.push(targetDay); if (targetDay <= 30) t30++; if (targetDay <= 60) t60++; if (targetDay <= 120) t120++; }
  }
  tDays.sort((a, b) => a - b); bDays.sort((a, b) => a - b); bal60.sort((a, b) => a - b);
  const R = RESAMPLES;
  return { pBlown30: b30 / R, pBlown60: b60 / R, pBlown120: b120 / R, pBlown250: b250 / R, pTarget: tN / R, pTarget30: t30 / R, pTarget60: t60 / R, pTarget120: t120 / R,
    targetDaysMedian: pct(tDays, 0.5), targetDaysP25: pct(tDays, 0.25), targetDaysP75: pct(tDays, 0.75), blownDaysMedian: pct(bDays, 0.5), dllDayRate: simDays ? dllDays / simDays : 0,
    medianBal60: pct(bal60, 0.5) * micros, p5Bal60: pct(bal60, 0.05) * micros, p95Bal60: pct(bal60, 0.95) * micros };
}
function stats(idx: Tr[]) {
  const n = idx.length; let w = 0, g = 0, pos = 0, neg = 0;
  for (const t of idx) { const nn = t.gross - FRICTION; if (t.outcome === "win_tp1") w++; g += t.gross; if (nn > 0) pos += nn; else neg -= nn; }
  return { n, winPct: n ? r2((100 * w) / n) : null, grossExp: n ? r2(g / n) : null, netExp: n ? r2((g - n * FRICTION) / n) : null, pf: neg > 0 ? r2(pos / neg) : null, net: r2(g - n * FRICTION), days: new Set(idx.map(t => t.day)).size };
}

const SLEEVES: Array<{ id: string; ivs: string[] }> = [{ id: "5m+15m+60m", ivs: ["5m", "15m", "60m"] }, { id: "60m", ivs: ["60m"] }, { id: "1m+5m+15m+60m", ivs: ["1m", "5m", "15m", "60m"] }];
const POPS: Array<{ id: string; f: (t: Tr) => boolean }> = [{ id: "all-sessions", f: () => true }, { id: "orderWindow-0930-1515", f: t => t.inOW }];
const DAYSETS: Array<{ id: string; days: string[] }> = [{ id: "all", days: allDays }, { id: "H1", days: allDays.filter(d => d < H2_FROM_KEY) }, { id: "H2", days: allDays.filter(d => d >= H2_FROM_KEY) }];
const lines: unknown[][] = [];
const md: string[] = [];
md.push(`# Apex 25K evaluation ruin re-sim — shipped exits on the gated fires (Apex mode: flat 16:55 ET)`, "");
md.push(`Generated ${new Date().toISOString()} by \`scripts/analysis/apex-25k-ruin.ts\` from \`${IN}\` (dataset built ${(ds.meta as any).generatedAt}). ${trades.length} gated apex-closed trades over ${allDays.length} session days; ${RESAMPLES} paths of ${BLOCK}-day blocks, ${HORIZON}-day horizon, NET = gross − ${FRICTION} pt. MES $${PT_USD}/pt.`, "");
md.push(`Apex 25K rules (help center, read 2026-10-01): EOD Evaluation = target $1,500 / EOD trailing max drawdown $1,000 / DLL $500 / 4 contracts; Intraday Evaluation = target $1,500 / intraday trailing $1,000 (peak incl. unrealized) / no DLL. Consistency not applied on evaluations. The brief's $1,500 threshold is the retired LEGACY 25K figure — shown as a sensitivity. Trailing thresholds on an evaluation never lock; DLL (where present) flattens at the limit and ends the day; concurrent trades are treated as independent.`, "");
let seed = 101;
for (const sl of SLEEVES) for (const pop of POPS) for (const dsel of DAYSETS) {
  const idx = trades.filter(t => sl.ivs.includes(t.iv) && pop.f(t) && dsel.days.includes(t.day));
  const st = stats(idx);
  if (dsel.id === "all") md.push(`## ${sl.id} — ${pop.id}`, "", `Trades n=${st.n}, win ${st.winPct}%, gross ${st.grossExp}/tr, NET ${st.netExp}/tr, PF(net) ${st.pf}, NET total ${st.net} pts over ${st.days} trade days (${dsel.days.length} session days in pool).`, "",
    `| day pool | rules | micros | P(blown ≤30d) | ≤60d | ≤120d | ≤250d | P(target before blown, ≤250d) | P(target ≤30/60/120d) | target days p25/median/p75 | blown-day median | DLL-hit day rate | balance after 60 d p5/median/p95 ($) |`, `|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const rules of RULES) for (const micros of [1, 2]) {
    const s = daySim(idx, dsel.days, micros, rules, seed++);
    lines.push([sl.id, pop.id, dsel.id, rules.id, micros, st.n, st.winPct, st.netExp, st.pf, st.net, dsel.days.length, s.pBlown30, s.pBlown60, s.pBlown120, s.pBlown250, s.pTarget, s.pTarget30, s.pTarget60, s.pTarget120, s.targetDaysP25, s.targetDaysMedian, s.targetDaysP75, s.blownDaysMedian, r2(s.dllDayRate), r2(s.p5Bal60 * PT_USD), r2(s.medianBal60 * PT_USD), r2(s.p95Bal60 * PT_USD)].map(x => (typeof x === "number" && Number.isNaN(x) ? "" : x)));
    const f = (x: number): string => (Number.isNaN(x) ? "–" : String(r2(x)));
    const P = (x: number): string => `${(100 * x).toFixed(1)}%`;
    md.push(`| ${dsel.id} (${dsel.days.length} d, n=${st.n}) | ${rules.id} | ${micros} | ${P(s.pBlown30)} | ${P(s.pBlown60)} | ${P(s.pBlown120)} | ${P(s.pBlown250)} | **${P(s.pTarget)}** | ${P(s.pTarget30)} / ${P(s.pTarget60)} / ${P(s.pTarget120)} | ${f(s.targetDaysP25)} / **${f(s.targetDaysMedian)}** / ${f(s.targetDaysP75)} | ${f(s.blownDaysMedian)} | ${(100 * s.dllDayRate).toFixed(1)}% | ${f(s.p5Bal60 * PT_USD)} / ${f(s.medianBal60 * PT_USD)} / ${f(s.p95Bal60 * PT_USD)} |`);
  }
  if (dsel.id === "H2") md.push("");
}
md.push(`## Method notes`, "", `- Day-sequence sim = scripts/analysis/exit-monte-carlo.ts daySim re-parameterised (same block bootstrap, same worst-point check: day P&L so far − MAE − friction vs max(DLL level, threshold level)). Differences: evaluation thresholds do not lock at start+$100 (PA rule); target replaces the payout test (no consistency rule on evaluations); 120/250-day horizons and target-day percentiles added; INTRADAY model ratchets the threshold on each trade's MFE (intrabar order of MFE vs MAE is unknown — the check uses the trade's MAE against the threshold BEFORE its MFE ratchets it, the optimistic order).`,
  `- Per-trade gross/MAE/MFE are the dataset's Apex-mode walk (path.outcomeApex: shipped tp1/sl on served 1m bars, flat at the 16:54 close). MAE is capped at the stop distance and MFE at the target distance.`,
  `- "orderWindow" = entries 09:30–15:15 ET (server/trade-state orderWindows) — the fires the live auto-trader can place; "all-sessions" includes ETH fires the owner would have to hand-trade.`,
  `- The 60-day balance percentiles are in $ at the stated micros (paths that blew or passed before day 60 contribute their final balance).`, "");
fs.writeFileSync(path.join(OUT, "apex25k_ruin.csv"), [["sleeve", "population", "dayPool", "rules", "micros", "n", "winPct", "netExp", "PF", "netTotal", "poolDays", "pBlown30", "pBlown60", "pBlown120", "pBlown250", "pTargetBeforeBlown", "pTarget30", "pTarget60", "pTarget120", "targetDaysP25", "targetDaysMedian", "targetDaysP75", "blownDaysMedian", "dllDayRate", "bal60_p5_usd", "bal60_median_usd", "bal60_p95_usd"].join(","), ...lines.map(l => l.join(","))].join("\n") + "\n");
fs.writeFileSync(path.join(OUT, "APEX25K.md"), md.join("\n") + "\n");
console.log(`[apex] DONE → ${OUT}\\apex25k_ruin.csv, APEX25K.md`);
