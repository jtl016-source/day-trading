/**
 * SERVER-SIDE JOB SCHEDULER (2026-08-02, user-approved items 1-3).
 *
 *   1. INTRADAY CATCH-UP  — every ~30 min during session hours: parity-locked engine replay of
 *      TODAY, back-fills gate-passing fires missing from signal_history (server/catchup.ts,
 *      source='catchup', regen-class, live rows never touched).
 *   2. WEEKLY REGEN       — Sunday 12:00 ET: spawns `npx tsx scripts/fact-engine-backtest.ts
 *      --persist` (live-preserving persist is built into the harness), captures the report tail
 *      to a log file, records the standing-headline diff for the next daily digest.
 *      Guards: skipped when the MW feed is down or a DB repair sentinel exists.
 *   3. DAILY HEALTH DIGEST — 8:30 AM ET weekdays via the stored Discord webhook: feed status,
 *      audit staleness, candle-write-reject delta, yesterday's signals vs the backtest
 *      expectation band, open trades, last catch-up / last regen status.
 *
 * All wall-clock decisions use Intl.DateTimeFormat America/New_York (NEVER a UTC offset —
 * CLAUDE.md rule). Config flags (default ON, set "false" to disable):
 *   SCHEDULER_CATCHUP_ENABLED · SCHEDULER_WEEKLY_REGEN_ENABLED · SCHEDULER_DIGEST_ENABLED
 *
 * Mutual exclusion (first in the repo — nothing else locks):
 *   • data/db-repair.lock  — NEW CONVENTION: any manual repair may create it; while present the
 *     scheduler runs NO catch-up passes and NO regen (checked each tick; delete to resume).
 *   • data/weekly-regen.lock — written around the spawned regen child (pid + startedAt); a
 *     stale lock (>3h) is reaped. Catch-up passes skip while a regen child is running.
 *
 * Job state is persisted in app_settings (scheduler_last_catchup / scheduler_last_regen /
 * scheduler_last_digest / scheduler_rejects_baseline) so restarts keep history; the whole
 * status block is exposed through GET /api/mw/sync-status (`scheduler` field).
 */
import type { Express } from "express";
import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { db } from "./db";
import { runCatchupPass, catchupRunning, type CatchupStatus, missedDaysPendingCount, runMissedDaysStep, missedDaysDigestLine, MAX_MISSED_SESSIONS } from "./catchup";
import { sendDiscordMessage, discordConfigured } from "./discord-notify";
import { getYahooLiveStatus } from "./yahoo-live";
import { getAuditStaleness, anyStudyConnected } from "./gap-audit";
import { isTickRelayConnected } from "./mw-reader";
import { sessionDayKey, weekdayOfKey } from "@shared/yellowbox-core";
import { shadowScalpsTick, shadowScalpsDigestLineAsync } from "./shadow-scalps"; // SHADOW SCALPS (2026-10-06, record-only)

// ── Config flags (default ON) ────────────────────────────────────────────────
const flag = (name: string): boolean => (process.env[name] ?? "true") !== "false";
const CATCHUP_ENABLED = flag("SCHEDULER_CATCHUP_ENABLED");
const WEEKLY_REGEN_ENABLED = flag("SCHEDULER_WEEKLY_REGEN_ENABLED");
const DIGEST_ENABLED = flag("SCHEDULER_DIGEST_ENABLED");
const SESSION_REVIEW_ENABLED = flag("SCHEDULER_SESSION_REVIEW_ENABLED");

// LATE-SIGNAL FAILSAFE (2026-08-11, user request after a 14:00 fire surfaced at 15:27): the
// healing cadence is the ceiling on how late a replay-endorsed fire can appear — tightened
// 30 → 10 min (env SCHEDULER_CATCHUP_EVERY_MIN; each pass is a ~20s read-mostly replay).
const CATCHUP_EVERY_MIN = (() => {
  const v = Number(process.env.SCHEDULER_CATCHUP_EVERY_MIN ?? 10);
  return Number.isFinite(v) && v >= 2 ? v : 10;
})();
const CATCHUP_EVERY_MS = CATCHUP_EVERY_MIN * 60_000;
const BOOT_QUIET_MS = 3 * 60_000; // never run jobs inside the boot window (backfill/hello slabs)
const REGEN_TIMEOUT_MS = 45 * 60_000;
const COLLECT_TIMEOUT_MS = 3 * 60_000;   // session-review fact collector (measured ~10s)
const REVIEW_TIMEOUT_MS = 10 * 60_000;   // headless claude reviewer

const REPO_ROOT = process.cwd();
const REPAIR_SENTINEL = path.join(REPO_ROOT, "data", "db-repair.lock");
const REGEN_LOCK = path.join(REPO_ROOT, "data", "weekly-regen.lock");

/** Big artifacts (standing results JSON, regen logs) live in BAXTER_ARTIFACTS_DIR once the
 *  relocation lands; fall back to the historical repo-root/data locations. */
function artifactsDir(): string {
  const d = process.env.BAXTER_ARTIFACTS_DIR;
  if (d && fs.existsSync(d)) return d;
  return REPO_ROOT;
}
function resolveResultsJson(): string | null {
  const candidates = [
    path.join(artifactsDir(), "fact-engine-backtest-results.json"),
    path.join(REPO_ROOT, "fact-engine-backtest-results.json"),
    // Last resort: the user-approved artifact relocation target (2026-08-02). Covers a server
    // process started BEFORE BAXTER_ARTIFACTS_DIR reached its environment but AFTER the
    // artifacts moved out of the OneDrive-synced repo root.
    "C:\\BaxterData\\fact-engine-backtest-results.json",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// ── ET wall clock (Intl — DST-safe) ──────────────────────────────────────────
interface EtParts { wd: string; dateKey: string; hh: number; mm: number; mins: number }
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function etNow(d = new Date()): EtParts {
  const p = Object.fromEntries(ET_FMT.formatToParts(d).map(x => [x.type, x.value]));
  const hh = Number(p.hour) % 24; // "24" → 0
  const mm = Number(p.minute);
  return { wd: p.weekday, dateKey: `${p.year}-${p.month}-${p.day}`, hh, mm, mins: hh * 60 + mm };
}
/** CME ES/MES Globex hours: Sun 18:00 ET → Fri 17:00 ET minus the daily 17:00-18:00 halt. */
function isMarketOpen(p: EtParts): boolean {
  if (p.wd === "Sat") return false;
  if (p.wd === "Sun") return p.mins >= 18 * 60;
  if (p.wd === "Fri") return p.mins < 17 * 60;
  return !(p.mins >= 17 * 60 && p.mins < 18 * 60);
}

// ── app_settings-backed job state ────────────────────────────────────────────
function readSetting(key: string): string | null {
  try {
    const r = db.$client.prepare(`SELECT value FROM app_settings WHERE key=?`).get(key) as { value?: string } | undefined;
    return r?.value ?? null;
  } catch { return null; }
}
function writeSetting(key: string, value: string): void {
  try {
    db.$client.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(key, value);
  } catch (e: any) { console.error(`[scheduler] writeSetting ${key} failed: ${e?.message ?? e}`); }
}
function readJsonSetting<T>(key: string): T | null {
  const raw = readSetting(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

interface Headline { generatedAt?: string; trades: number; winRate: number; expectancy: number; pf: number; cumPts: number }
interface RegenStatus {
  at: string; trigger: "scheduled" | "manual"; ok: boolean;
  skipped?: string; error?: string; exitCode?: number | null;
  startedAt?: string; finishedAt?: string; durationSec?: number; logFile?: string;
  headlineBefore?: Headline | null; headlineAfter?: Headline | null; tail?: string[];
}
interface DigestStatus { at: string; dateKey: string; ok: boolean; test?: boolean; error?: string }
// SESSION REVIEW (2026-08-07): the daily post-close review ritual — deterministic collector +
// headless `claude -p` narrative reviewer (docs/session-review-prompt.md).
interface SessionReviewStatus {
  at: string; trigger: "scheduled" | "manual"; dateKey: string; ok: boolean; test?: boolean;
  skipped?: string; error?: string; degraded?: boolean; durationSec?: number;
  collector?: { ok: boolean; tookMs: number; factsFile?: string; error?: string };
  claude?: { path: string; version: string | null } | null;
  reviewer?: {
    ok: boolean; exitCode?: number | null; durationSec?: number; logFile?: string;
    reportFile?: string; reportOk?: boolean; journalAppended?: boolean; discordPosted?: boolean;
    error?: string;
  };
}

let lastCatchup: CatchupStatus | null = readJsonSetting<CatchupStatus>("scheduler_last_catchup");
// LATE-SIGNAL FAILSAFE (2026-08-11): per-pass trail — the 08-11 "which pass missed the 14:00
// fire?" question was unanswerable because only the LAST pass survives. In-memory ring of the
// recent passes (compact), exposed via sync-status.
interface CatchupTrailEntry {
  at: string; trigger: string; ok: boolean; engineFires?: number; dbRows?: number;
  missing?: number; inserted?: number; collisions?: number; backfilledKeys?: string[]; error?: string;
}
const catchupTrail: CatchupTrailEntry[] = [];
function recordCatchupTrail(s: CatchupStatus): void {
  catchupTrail.push({
    at: s.at, trigger: s.trigger, ok: s.ok, engineFires: s.engineFires, dbRows: s.dbRows,
    missing: s.missing, inserted: s.inserted, collisions: s.collisions,
    ...(s.backfilledKeys?.length ? { backfilledKeys: s.backfilledKeys } : {}),
    ...(s.error ? { error: s.error } : {}),
  });
  if (catchupTrail.length > 60) catchupTrail.shift();
}
let lastRegen: RegenStatus | null = readJsonSetting<RegenStatus>("scheduler_last_regen");
let lastDigest: DigestStatus | null = readJsonSetting<DigestStatus>("scheduler_last_digest");
let lastSessionReview: SessionReviewStatus | null = readJsonSetting<SessionReviewStatus>("scheduler_last_session_review");
let regenChildRunning = false;
let reviewRunning = false;
let reviewPostHits = 0; // POST /api/scheduler/review-post counter (did the reviewer post?)
const bootMs = Date.now();

export function getSchedulerStatus(): Record<string, unknown> {
  return {
    flags: { catchup: CATCHUP_ENABLED, weeklyRegen: WEEKLY_REGEN_ENABLED, digest: DIGEST_ENABLED, sessionReview: SESSION_REVIEW_ENABLED },
    repairSentinel: fs.existsSync(REPAIR_SENTINEL),
    catchupRunning: catchupRunning(),
    regenRunning: regenChildRunning,
    reviewRunning,
    lastCatchup, lastRegen, lastDigest, lastSessionReview,
    catchupTrail, // LATE-SIGNAL FAILSAFE (2026-08-11): recent passes, oldest first
  };
}

// ── Standing-results helpers (headline + expectation band) ───────────────────
function readHeadline(): Headline | null {
  const file = resolveResultsJson();
  if (!file) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as {
      meta?: { generatedAt?: string; beforeAfter?: { after?: { trades: number; winRate: number; expectancy: number; pf: number; cumPts: number } } };
    };
    const a = doc.meta?.beforeAfter?.after;
    if (!a) return null;
    return { generatedAt: doc.meta?.generatedAt, trades: a.trades, winRate: a.winRate, expectancy: a.expectancy, pf: a.pf, cumPts: a.cumPts };
  } catch { return null; }
}
/** mean ± 2σ of daily net points over the standing set (group by sessionDay, sum pointsResult). */
function dailyNetBand(): { mean: number; sd: number; days: number } | null {
  const file = resolveResultsJson();
  if (!file) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as {
      signals?: Array<{ sessionDay?: string; pointsResult?: number | null }>;
    };
    const byDay = new Map<string, number>();
    for (const s of doc.signals ?? []) {
      if (!s.sessionDay || s.pointsResult == null) continue;
      byDay.set(s.sessionDay, (byDay.get(s.sessionDay) ?? 0) + s.pointsResult);
    }
    const nets = [...byDay.values()];
    if (nets.length < 5) return null;
    const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
    const sd = Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / nets.length);
    return { mean, sd, days: nets.length };
  } catch { return null; }
}

// ── Weekly regen ─────────────────────────────────────────────────────────────
function mwFeedUp(): boolean {
  try { return anyStudyConnected() || isTickRelayConnected(); } catch { return false; }
}
function regenLockFresh(): boolean {
  try {
    if (!fs.existsSync(REGEN_LOCK)) return false;
    const j = JSON.parse(fs.readFileSync(REGEN_LOCK, "utf8")) as { startedAt?: number };
    if (j.startedAt && Date.now() - j.startedAt < 3 * 3600_000) return true;
    fs.unlinkSync(REGEN_LOCK); // stale (>3h) — reap
    return false;
  } catch { return false; }
}

export async function runWeeklyRegen(trigger: "scheduled" | "manual"): Promise<RegenStatus> {
  const at = new Date().toISOString();
  const record = (s: RegenStatus): RegenStatus => {
    lastRegen = s;
    writeSetting("scheduler_last_regen", JSON.stringify(s));
    return s;
  };
  if (regenChildRunning || regenLockFresh()) return record({ at, trigger, ok: false, skipped: "regen already running (lock)" });
  if (fs.existsSync(REPAIR_SENTINEL)) return record({ at, trigger, ok: false, skipped: "db-repair sentinel present (data/db-repair.lock)" });
  if (!mwFeedUp()) return record({ at, trigger, ok: false, skipped: "MW feed down (no study/TickRelay connection)" });

  const headlineBefore = readHeadline();
  const stamp = at.replace(/[:.]/g, "-").slice(0, 17);
  const logDir = artifactsDir() === REPO_ROOT ? path.join(REPO_ROOT, "data") : artifactsDir();
  const logFile = path.join(logDir, `weekly-regen-${stamp}.log`);
  const startedAt = new Date().toISOString();

  regenChildRunning = true;
  fs.writeFileSync(REGEN_LOCK, JSON.stringify({ pid: process.pid, startedAt: Date.now(), trigger }));
  console.log(`[scheduler] weekly regen (${trigger}) spawning: npx tsx scripts/fact-engine-backtest.ts --persist → ${logFile}`);

  return await new Promise<RegenStatus>((resolve) => {
    const out = fs.createWriteStream(logFile, { flags: "a" });
    let tailBuf = "";
    const child = spawn("npx", ["tsx", "scripts/fact-engine-backtest.ts", "--persist"], {
      cwd: REPO_ROOT, shell: true, windowsHide: true,
      env: { ...process.env, PERSIST_BASE_URL: `http://127.0.0.1:${process.env.PORT || "3000"}` },
    });
    const onChunk = (c: Buffer): void => {
      out.write(c);
      tailBuf = (tailBuf + c.toString()).slice(-12_000);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    const killer = setTimeout(() => {
      console.error(`[scheduler] weekly regen exceeded ${REGEN_TIMEOUT_MS / 60000}min — killing child`);
      // 2026-09-18: shell:true → child.kill() reaps only the cmd.exe wrapper on Windows; the
      // npx/tsx/node descendants lived on (the integrity-check outage). Kill the TREE.
      killProcessTree(child);
    }, REGEN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(killer);
      out.end();
      regenChildRunning = false;
      try { fs.unlinkSync(REGEN_LOCK); } catch { /* best-effort */ }
      const finishedAt = new Date().toISOString();
      const durationSec = Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
      const tail = tailBuf.split(/\r?\n/).filter(l => l.trim().length).slice(-25);
      const headlineAfter = readHeadline();
      const status = record({
        at, trigger, ok: code === 0, exitCode: code,
        startedAt, finishedAt, durationSec, logFile,
        headlineBefore, headlineAfter, tail,
        ...(code === 0 ? {} : { error: `regen exited ${code}` }),
      });
      console.log(`[scheduler] weekly regen finished exit=${code} in ${durationSec}s — headline ` +
        (headlineAfter ? `${headlineAfter.trades}tr exp ${headlineAfter.expectancy} PF ${headlineAfter.pf}` : "unreadable"));
      resolve(status);
    });
    child.on("error", (err) => {
      clearTimeout(killer);
      out.end();
      regenChildRunning = false;
      try { fs.unlinkSync(REGEN_LOCK); } catch { /* best-effort */ }
      resolve(record({ at, trigger, ok: false, error: `spawn failed: ${err.message}`, startedAt, logFile }));
    });
  });
}

// ── Daily digest ─────────────────────────────────────────────────────────────
const fmt1 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
function prevTradingDayKey(todayKey: string): string {
  // Walk calendar days back from the session-day key until a weekday (Mon-Fri).
  const [y, m, d] = todayKey.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d) / 1000;
  for (let i = 0; i < 7; i++) {
    t -= 86400;
    const key = new Date(t * 1000).toISOString().slice(0, 10);
    const wd = weekdayOfKey(key);
    if (wd >= 1 && wd <= 5) return key;
  }
  return todayKey;
}

// async since 2026-08-12: the digest now runs the integrity-check child (drift alarm).
export async function buildDailyDigest(test: boolean): Promise<string> {
  const now = new Date();
  const p = etNow(now);
  const nowSec = Math.floor(now.getTime() / 1000);
  const lines: string[] = [];
  lines.push(`🩺 **Daily health digest — ${p.wd} ${p.dateKey} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")} ET**${test ? "  ⚠️ TEST" : ""}`);

  // Feed + audit staleness per resolution.
  try {
    const y = getYahooLiveStatus() as { feed_status?: string };
    const audit = getAuditStaleness() as Array<{ resolution: string; staleSec: number | null; stale: boolean; studyConnected: boolean }>;
    const anyStale = audit.some(a => a.stale);
    const auditStr = audit
      .sort((a, b) => Number(a.resolution) - Number(b.resolution))
      .map(a => `${a.resolution}m ${a.staleSec == null ? "?" : Math.round(a.staleSec / 60) + "min"}${a.stale ? "⚠️" : ""}`)
      .join(" · ");
    lines.push(`Feed: ${y.feed_status ?? "?"} — audit ${auditStr}${anyStale ? "  ⚠️ STALE" : ""}`);
  } catch (e: any) { lines.push(`Feed: status unavailable (${e?.message ?? e})`); }

  // CONTRACT GUARD (2026-09-17): MW on a different contract month than Yahoo's front month is
  // the silent-corruption class this digest must never let age — shout it every morning.
  try {
    const { contractGuardStatus } = await import("./contract-guard");
    const g = contractGuardStatus();
    const d = g.delta == null ? "?" : `${g.delta > 0 ? "+" : ""}${g.delta.toFixed(2)}`;
    lines.push(g.offContract
      ? `Contract guard: ⚠️⚠️ MW OFF-CONTRACT since ${g.since ? new Date(g.since * 1000).toISOString().slice(0, 16) + "Z" : "?"} (Δ ${d} pts vs Yahoo front month) — MW quarantined, Yahoo driving, ORDERS BLOCKED. Roll the MotiveWave chart.`
      : `Contract guard: OK (Δ ${d} pts over ${g.pairs} paired min${g.flips ? `, ${g.flips} flip(s) this run` : ""}${g.ref.error ? `, yahoo ref error: ${g.ref.error}` : ""})`);
  } catch (e: any) { lines.push(`Contract guard: status unavailable (${e?.message ?? e})`); }

  // NEWS CALENDAR (2026-10-01): the order-side news blackout FAILS OPEN on a missing / expired /
  // empty data/news-calendar.json — shout it every morning (warns 14 d before window.to).
  try {
    const { newsCalendarDigestLine, etDateOf } = await import("./news-blackout");
    lines.push(newsCalendarDigestLine(etDateOf(nowSec)));
  } catch (e: any) { lines.push(`News calendar: status unavailable (${e?.message ?? e}) ⚠️`); }

  // APEX GUARD (2026-10-01, 25K switch): the headroom in force + the carried account tracker —
  // the stored headroom must match RTrader's real distance-to-threshold; say it every morning.
  try {
    const { apexGuardDigestLine } = await import("./trade-state");
    lines.push(apexGuardDigestLine());
  } catch (e: any) { lines.push(`Apex guard: status unavailable (${e?.message ?? e}) ⚠️`); }

  // IBKR BRIDGE (2026-09-23): only when IB_ENABLED=true — gateway link, contract + roll date,
  // tick freshness, open brackets, last error. Absent otherwise (nothing to report).
  if ((process.env.IB_ENABLED ?? "").trim().toLowerCase() === "true") {
    try {
      const { ibkrDigestLine } = await import("./ibkr-bridge");
      lines.push(ibkrDigestLine() ?? "IBKR: enabled but the bridge is not running ⚠️");
    } catch (e: any) { lines.push(`IBKR: status unavailable (${e?.message ?? e})`); }
  }

  // Candle-write-reject delta since the last digest.
  try {
    const total = (db.$client.prepare(`SELECT COUNT(*) n FROM candle_write_rejects`).get() as { n: number }).n;
    const baseline = Number(readSetting("scheduler_rejects_baseline") ?? "NaN");
    const delta = Number.isFinite(baseline) ? total - baseline : 0;
    lines.push(`Candle write rejects: ${Number.isFinite(baseline) ? (delta > 0 ? `+${delta} since last digest ⚠️` : "+0 since last digest") : "baseline set"} (total ${total})`);
    if (!test) writeSetting("scheduler_rejects_baseline", String(total));
  } catch { lines.push("Candle write rejects: unavailable"); }

  // Yesterday's signals vs the expectation band.
  try {
    const todayKey = sessionDayKey(nowSec);
    const yKey = prevTradingDayKey(todayKey);
    const rows = db.$client
      .prepare(`SELECT timestamp, outcome, points_result FROM signal_history WHERE symbol='MES' AND timestamp>=?`)
      .all(nowSec - 7 * 86400) as Array<{ timestamp: number; outcome: string | null; points_result: number | null }>;
    const yRows = rows.filter(r => sessionDayKey(r.timestamp) === yKey);
    const w = yRows.filter(r => r.outcome === "win_tp1" || r.outcome === "win_tp2").length;
    const l = yRows.filter(r => r.outcome === "loss").length;
    const e = yRows.filter(r => r.outcome === "eod").length;
    const net = yRows.reduce((a, r) => a + (r.points_result ?? 0), 0);
    const band = dailyNetBand();
    let bandStr = "band unavailable";
    if (band) {
      const lo = band.mean - 2 * band.sd, hi = band.mean + 2 * band.sd;
      const inBand = net >= lo && net <= hi;
      bandStr = `${inBand ? "inside" : "OUTSIDE ⚠️"} band [${fmt1(lo)} … ${fmt1(hi)}] (mean ${fmt1(band.mean)} ± 2σ over ${band.days}d)`;
    }
    lines.push(`Yesterday (${yKey}): ${yRows.length} signals · ${w}W/${l}L/${e}E · net ${net >= 0 ? "+" : ""}${fmt1(net)} pts — ${bandStr}`);
  } catch (e: any) { lines.push(`Yesterday: unavailable (${e?.message ?? e})`); }

  // Open trades.
  try {
    const open = (db.$client
      .prepare(`SELECT COUNT(*) n FROM signal_history WHERE symbol='MES' AND timestamp>=? AND (outcome IS NULL OR outcome='open')`)
      .get(nowSec - 7 * 86400) as { n: number }).n;
    lines.push(`Open trades: ${open}`);
  } catch { lines.push("Open trades: unavailable"); }

  // DATA INTEGRITY (2026-08-12 — "I cannot have this mistake again"): the serving-identity
  // reconciliation (scripts/integrity-check.ts) runs with every digest. ANY violation makes
  // the digest scream; the tab-vs-book contradiction class can never again age silently.
  // 2026-09-18 OUTAGE: this child hit its timeout, `child.kill()` killed only the cmd.exe
  // wrapper, the node grandchild ran on for 19+ minutes and the digest hung on a promise that
  // could never resolve — spawnCapture now kills the process TREE and resolves from its own
  // timeout path. And a run that did NOT finish must never be reported from the PREVIOUS
  // run's artifact (the old code read integrity-check.json unconditionally — a timed-out check
  // would have printed yesterday's "Integrity: OK"): the artifact must be FRESH.
  try {
    const icStartMs = Date.now();
    const ic = await spawnCapture("npx", ["tsx", "scripts/integrity-check.ts"], {
      timeoutMs: 120_000, shell: true,
      env: { ...process.env },
    });
    const icArt = path.join(artifactsDir(), "integrity-check.json");
    let icFresh = false;
    try { icFresh = fs.statSync(icArt).mtimeMs >= icStartMs - 2_000; } catch { /* no artifact at all */ }
    if (ic.timedOut) {
      lines.push(`Integrity: ⚠️ check TIMED OUT after 120s (process tree killed) — result UNKNOWN today; run \`npx tsx scripts/integrity-check.ts\` by hand`);
    } else if (!icFresh) {
      lines.push(`Integrity: ⚠️ check exited (code ${ic.code ?? "?"}) without writing a fresh integrity-check.json — result UNKNOWN${ic.tail ? ` · ${ic.tail.trim().split("\n").pop()?.slice(0, 140)}` : ""}`);
    } else {
      const icJson = JSON.parse(fs.readFileSync(icArt, "utf8")) as { ok: boolean; violations: number; warnings: number; findings: Array<{ level: string; check: string; detail: string }> };
      if (icJson.ok) lines.push(`Integrity: OK — 0 violations, ${icJson.warnings} warning(s) (tab == standing book + full history + live edge)`);
      else {
        const first = icJson.findings.find(f => f.level === "VIOLATION");
        lines.push(`Integrity: ⚠️⚠️ ${icJson.violations} VIOLATION(S) — ${first ? `${first.check}: ${first.detail.slice(0, 140)}` : "see integrity-check.json"} — the tab may be showing rows the book does not back!`);
      }
    }
  } catch (e: any) { lines.push(`Integrity: check failed to run (${e?.message ?? e}) ⚠️`); }

  // RISK-BUDGET ALARM (2026-08-13, the "can you give me the security" answer): the forward
  // record must stay inside the measured envelope — rolling last-100 resolved trades (all
  // intervals, TP1-only executable outcomes): max drawdown ≤ 230 net pts (block-bootstrap
  // P95 of the 15m book) and win rate ≥ 55%. Outside the envelope = STOP AND REASSESS, said
  // loudly every morning — no willpower required.
  try {
    const rows = db.$client.prepare(
      `SELECT outcome, points_result FROM signal_history
        WHERE symbol='MES' AND outcome IN ('win_tp1','win_tp2','loss')
        ORDER BY timestamp DESC LIMIT 100`,
    ).all() as Array<{ outcome: string; points_result: number | null }>;
    if (rows.length >= 30) {
      const seq = [...rows].reverse();
      let cum = 0, peak = 0, dd = 0, wins = 0;
      for (const r of seq) {
        cum += (r.points_result ?? 0) - 1.0; // net of friction, same basis as every report
        if (cum > peak) peak = cum;
        if (peak - cum > dd) dd = peak - cum;
        if (r.outcome !== "loss") wins++;
      }
      // Envelope recalibrated 2026-08-13 (best-program ship): block-bootstrap P95 maxDD per
      // 100 trades on the post-ship combined standing record = 786.5 (the 1m sleeve's volume
      // dominates the rolling window and its point-variance is large); win 75.0% typical.
      // DD ≤ 800 / win ≥ 63 = "outside anything the honest record calls normal".
      const winPct = (100 * wins) / seq.length;
      const inBudget = dd <= 800 && winPct >= 63;
      lines.push(inBudget
        ? `Risk budget: OK — last ${seq.length} closed: ${winPct.toFixed(1)}% win, net ${cum >= 0 ? "+" : ""}${cum.toFixed(1)} pts, maxDD ${dd.toFixed(1)} (envelope: DD ≤ 800, win ≥ 63%)`
        : `Risk budget: 🚨🚨 OUTSIDE ENVELOPE — last ${seq.length} closed: ${winPct.toFixed(1)}% win, maxDD ${dd.toFixed(1)} net pts (limits: DD ≤ 800, win ≥ 63%). STOP AND REASSESS — this is the pre-agreed tripwire, not a suggestion.`);
    } else {
      lines.push(`Risk budget: warming up — only ${rows.length} closed trades since the TP1-only rebase (needs 30).`);
    }
  } catch (e: any) { lines.push(`Risk budget: check failed (${e?.message ?? e}) ⚠️`); }

  // GAP-HEAL FAILSAFE (2026-08-14): surface the bar-store health every morning — persistent
  // gaps degrade signal computation and must never age silently.
  try {
    const { gapHealStatus } = await import("./gap-heal");
    const g = gapHealStatus();
    if (!g) lines.push("Bar store: gap-heal has not run yet");
    else {
      const total = Object.values(g.gapsFound).reduce((a, b) => a + b, 0);
      lines.push(total === 0
        ? `Bar store: OK — last gap audit clean (${g.at})`
        : `Bar store: ⚠️⚠️ ${total} missing range(s) ${JSON.stringify(g.gapsFound)} after ${g.consecutiveDirtyPasses} heal pass(es) — check MotiveWave/LiveBarRelay + network`);
    }
  } catch (e: any) { lines.push(`Bar store: gap status unavailable (${e?.message ?? e})`); }

  // SHADOW SCALPS (2026-10-06, record-only): S1 ORB-30 / S2 yellow-box limit fade, live era only,
  // decision cell 6/8 at pessimistic fills + 1.0-pt friction, against the kill rule.
  try { lines.push(await shadowScalpsDigestLineAsync()); } // paged read + yielding aggregate (live + pessimistic rows only)
  catch (e: any) { lines.push(`Shadow scalps: unavailable (${e?.message ?? e})`); }

  // Last catch-up + last weekly regen.
  if (lastCatchup) {
    lines.push(lastCatchup.ok
      ? `Catch-up: ${lastCatchup.at.slice(11, 16)}Z ok — ${lastCatchup.engineFires} fires / ${lastCatchup.dbRows} db / ${lastCatchup.missing} backfilled (${lastCatchup.collisions} live collisions)`
      : `Catch-up: ${lastCatchup.at.slice(11, 16)}Z FAILED — ${lastCatchup.error} ⚠️`);
  } else lines.push("Catch-up: never run");
  // MISSED SESSION DAYS (2026-10-07): days the computer was off for, back-filled in the last 24 h,
  // plus days beyond the 7-day bar depth / still waiting for bars (absent when there is nothing).
  try { const ml = missedDaysDigestLine(); if (ml) lines.push(ml); }
  catch (e: any) { lines.push(`Catch-up: missed-day status unavailable (${e?.message ?? e})`); }
  if (lastRegen) {
    if (lastRegen.skipped) lines.push(`Weekly regen: ${lastRegen.at.slice(0, 10)} SKIPPED — ${lastRegen.skipped} ⚠️`);
    else if (!lastRegen.ok) lines.push(`Weekly regen: ${lastRegen.at.slice(0, 10)} FAILED (exit ${lastRegen.exitCode}) ⚠️`);
    else {
      const b = lastRegen.headlineBefore, a = lastRegen.headlineAfter;
      const diff = a && b
        ? `${b.trades}→${a.trades}tr, exp ${fmt1(b.expectancy)}→${fmt1(a.expectancy)}, PF ${fmt1(b.pf)}→${fmt1(a.pf)}, cum ${fmt1(b.cumPts)}→${fmt1(a.cumPts)}`
        : a ? `${a.trades}tr exp ${fmt1(a.expectancy)} PF ${fmt1(a.pf)}` : "headline unreadable";
      lines.push(`Weekly regen: ${lastRegen.at.slice(0, 10)} ok in ${lastRegen.durationSec}s — ${diff}`);
    }
  } else lines.push("Weekly regen: never run");

  return lines.join("\n");
}

export async function sendDailyDigest(test: boolean): Promise<DigestStatus> {
  const at = new Date().toISOString();
  const dateKey = etNow().dateKey;
  const content = await buildDailyDigest(test);
  const r = await sendDiscordMessage(content);
  const status: DigestStatus = { at, dateKey, ok: r.ok, ...(test ? { test: true } : {}), ...(r.ok ? {} : { error: r.error }) };
  if (!test || !r.ok) {
    lastDigest = status;
    writeSetting("scheduler_last_digest", JSON.stringify(status));
  }
  console.log(`[scheduler] digest${test ? " (TEST)" : ""} ${r.ok ? "sent" : `FAILED: ${r.error}`}`);
  return status;
}

// ── SESSION REVIEW (2026-08-07 mission — the daily post-close ritual) ────────
// 17:20 ET weekdays: (1) scripts/session-review-collect.ts gathers the day's facts
// (signals + near-misses w/ exact suppression causes + context + health + ledger +
// journal echo) into <artifacts>/session-reports/<date>-facts.json; (2) a headless
// `claude -p` reviewer (docs/session-review-prompt.md, model claude-sonnet-5) writes
// the narrative review <date>.md, appends distilled lessons to session-journal.md,
// and posts a compact version to Discord via POST /api/scheduler/review-post;
// (3) degraded mode: reviewer missing/failed → the deterministic fact summary is
// posted marked "MECHANICAL REPORT (reviewer unavailable)".
//
// claude CLI resolution (documented 2026-08-07): `where claude` first; this machine
// has no PATH entry, so the fallback scans the desktop app's bundled CLI at
// %APPDATA%\Claude\claude-code\<version>\claude.exe (found: 2.1.222) newest-first.
const PROMPT_FILE = path.join(REPO_ROOT, "docs", "session-review-prompt.md");

let claudeCliCache: { path: string; version: string | null } | null | undefined;
function resolveClaudeCli(): { path: string; version: string | null } | null {
  if (claudeCliCache !== undefined) return claudeCliCache;
  const candidates: string[] = [];
  try {
    const w = spawnSync("where", ["claude"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    for (const line of (w.stdout ?? "").split(/\r?\n/)) if (line.trim()) candidates.push(line.trim());
  } catch { /* where unavailable */ }
  try {
    const bundleDir = path.join(process.env.APPDATA ?? "", "Claude", "claude-code");
    if (fs.existsSync(bundleDir)) {
      const vers = fs.readdirSync(bundleDir)
        .filter(d => fs.existsSync(path.join(bundleDir, d, "claude.exe")))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); // newest version first
      for (const v of vers) candidates.push(path.join(bundleDir, v, "claude.exe"));
    }
  } catch { /* scan best-effort */ }
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      if (r.status === 0) {
        claudeCliCache = { path: c, version: (r.stdout ?? "").trim() || null };
        return claudeCliCache;
      }
    } catch { /* try next */ }
  }
  claudeCliCache = null;
  return null;
}

/** Kill a spawned child AND everything it spawned. On Windows `child.kill()` is
 *  TerminateProcess on ONE pid — with `shell:true` that pid is the cmd.exe wrapper, and its
 *  descendants (npx → node → tsx's worker node) live on. `taskkill /T /F` walks the tree; it
 *  must run FIRST, while the wrapper still exists to anchor the walk. Best-effort throughout —
 *  plain kill() is the fallback if taskkill cannot be spawned or reports failure. Non-Windows
 *  behaviour is unchanged (kill the child). */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  const plainKill = (): void => { try { child.kill(); } catch { /* gone */ } };
  if (process.platform === "win32" && child.pid != null) {
    try {
      const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      tk.on("error", plainKill);
      tk.on("exit", (code) => { if (code !== 0) plainKill(); });
      return;
    } catch { /* fall through to the plain kill */ }
  }
  plainKill();
}

const SPAWN_KILL_GRACE_MS = 5_000; // timeout → tree kill → this long for a normal 'close' → resolve regardless

/** Spawn + capture with timeout — returns exit code and the output tail.
 *  TIMEOUT HARDENING (2026-09-18 outage): the 8:30 digest's integrity-check child
 *  (`npx tsx …`, shell:true) hit its 120 s timeout and the old `child.kill()` killed only the
 *  cmd.exe wrapper — the node grandchild survived 19+ MINUTES, and because 'close' fires only
 *  once every holder of the stdio pipes has let go, the promise never resolved and the digest
 *  awaiting it hung with it. Now: (1) the timeout kills the whole process TREE, and (2) the
 *  timeout path RESOLVES BY ITSELF after a short grace — 'close' is no longer load-bearing.
 *  `settled` guards the three finish paths (close / error / timeout-grace) against double
 *  resolution and against late pipe chunks writing into an ended log stream. */
function spawnCapture(cmd: string, args: string[], opts: {
  timeoutMs: number; logFile?: string; stdinText?: string; shell?: boolean; env?: NodeJS.ProcessEnv;
}): Promise<{ code: number | null; tail: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const out = opts.logFile ? fs.createWriteStream(opts.logFile, { flags: "a" }) : null;
    let tail = "", timedOut = false, settled = false;
    let killer: ReturnType<typeof setTimeout> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      if (grace) clearTimeout(grace);
      out?.end();
      resolve({ code, tail, timedOut });
    };
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT, windowsHide: true, shell: opts.shell ?? false,
      env: opts.env ?? process.env,
    });
    const onChunk = (c: Buffer): void => {
      if (settled) return; // a survivor still holding the pipe must not write into the ended log
      out?.write(c); tail = (tail + c.toString()).slice(-8000);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    // A dead child's stdin can emit EPIPE asynchronously — without a listener that is an
    // uncaught 'error' event on the stream.
    child.stdin?.on("error", () => { /* child gone — nothing to feed */ });
    if (opts.stdinText != null) { child.stdin?.write(opts.stdinText); child.stdin?.end(); }
    killer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      // Do not wait for 'close': if any descendant outlives the kill and keeps the pipes open
      // it never comes. Give the kill a moment to land (a normal 'close' inside the grace
      // still wins and reports the real exit code), then let go of the pipes and resolve.
      grace = setTimeout(() => {
        tail += `\n[spawnCapture] timed out after ${Math.round(opts.timeoutMs / 1000)}s — process tree killed; resolved without waiting for 'close'`;
        try { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); } catch { /* already closed */ }
        try { child.unref(); } catch { /* ignore */ }
        finish(null);
      }, SPAWN_KILL_GRACE_MS);
    }, opts.timeoutMs);
    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      tail += `\nspawn error: ${err.message}`;
      finish(null);
    });
  });
}

/** Deterministic compact summary from the facts JSON — the degraded-mode Discord body. */
function buildMechanicalSummary(factsFile: string): string {
  try {
    const f = JSON.parse(fs.readFileSync(factsFile, "utf8")) as any;
    const sigs: any[] = f.signalsFired ?? [];
    const w = sigs.filter(s => s.outcome === "win_tp1" || s.outcome === "win_tp2").length;
    const l = sigs.filter(s => s.outcome === "loss").length;
    const e = sigs.filter(s => s.outcome === "eod").length;
    const nm = f.nearMisses ?? {};
    const causes = Object.entries((nm.counts ?? {}) as Record<string, number>).map(([c, n]) => `${c}=${n}`).join(" ") || "none";
    const sc = f.sessionContext ?? {};
    const lines = [
      `${f.meta?.date}: ${sigs.length} signals · ${w}W/${l}L/${e}E · net ${f.lossStop?.dayClosedNetPts ?? "?"} pts` +
        (f.ledger?.dayInsideBand === false ? " (OUTSIDE daily band ⚠️)" : ""),
      `Shape ${sc.shape?.classification ?? "?"} · range ${sc.sessionOhlc?.range ?? "?"} vs median ${sc.medianDayRange ?? "?"}` +
        (sc.deadTape?.clearedAtEt == null ? " · tape NEVER cleared dead-tape" : ` · tape alive from ${sc.deadTape.clearedAtEt}`),
      `Suppressed setups: ${nm.total ?? 0} (${causes})`,
      `Ledger: ${f.ledger?.after?.verdict ?? "?"} (r30 PF ${typeof f.ledger?.after?.rolling30PF === "number" ? f.ledger.after.rolling30PF.toFixed(2) : "?"})`,
      f.lossStop?.tripped ? (f.lossStop?.ruleRemoved
        ? `ℹ️ the retired −${f.lossStop.stopPts} loss stop WOULD have tripped at ${f.lossStop.tripEt} (rule removed 2026-08-17 — funded-account limits govern)`
        : `⚠️ DAILY LOSS STOP tripped at ${f.lossStop.tripEt}`) : null,
      (f.replayVsDb?.dbOnly?.length || f.replayVsDb?.replayOnly?.length)
        ? `Live-vs-replay asymmetry: ${f.replayVsDb.dbOnly.length} live-only, ${f.replayVsDb.replayOnly.length} replay-only` : null,
    ].filter(Boolean) as string[];
    return lines.join("\n");
  } catch (err: any) {
    return `facts file unreadable: ${err?.message ?? err}`;
  }
}

export async function runSessionReview(trigger: "scheduled" | "manual", opts: { date?: string; test?: boolean } = {}): Promise<SessionReviewStatus> {
  const at = new Date().toISOString();
  const dateKey = opts.date ?? sessionDayKey(Math.floor(Date.now() / 1000));
  const test = !!opts.test;
  const record = (s: SessionReviewStatus): SessionReviewStatus => {
    // TEST runs never claim the day (the scheduled 17:20 run must still fire) — digest precedent.
    if (!test || !s.ok) { lastSessionReview = s; writeSetting("scheduler_last_session_review", JSON.stringify(s)); }
    return s;
  };
  if (reviewRunning) return { at, trigger, dateKey, ok: false, skipped: "session review already running" };
  if (fs.existsSync(REPAIR_SENTINEL)) return record({ at, trigger, dateKey, ok: false, skipped: "db-repair sentinel present" });
  reviewRunning = true;
  const t0 = Date.now();
  try {
    // Same resolution as the collector (shared/artifacts-dir semantics): env dir, else repo root.
    const reportDir = path.join(artifactsDir(), "session-reports");
    fs.mkdirSync(reportDir, { recursive: true });
    const factsFile = path.join(reportDir, `${dateKey}-facts.json`);
    const reportFile = path.join(reportDir, `${dateKey}.md`);
    const compactFile = path.join(reportDir, `${dateKey}-discord.txt`);
    const journalFile = process.env.SESSION_JOURNAL_PATH ?? path.join(artifactsDir(), "session-journal.md");
    const logFile = path.join(reportDir, `${dateKey}-review.log`);

    // 1. Deterministic collector (child — same isolation as the weekly regen).
    console.log(`[scheduler] session review (${trigger}${test ? ", TEST" : ""}) ${dateKey}: collecting facts…`);
    const col = await spawnCapture("npx", ["tsx", "scripts/session-review-collect.ts", "--date", dateKey], {
      timeoutMs: COLLECT_TIMEOUT_MS, shell: true, logFile,
      env: { ...process.env, PORT: process.env.PORT || "3000" },
    });
    const collectorOk = col.code === 0 && fs.existsSync(factsFile);
    const collector: NonNullable<SessionReviewStatus["collector"]> = {
      ok: collectorOk, tookMs: Date.now() - t0,
      ...(collectorOk ? { factsFile } : { error: col.timedOut ? "collector timed out" : `collector exited ${col.code}: ${col.tail.slice(-400)}` }),
    };
    if (!collectorOk) {
      const status = record({ at, trigger, dateKey, ok: false, test, collector, error: collector.error, durationSec: Math.round((Date.now() - t0) / 1000) });
      console.error(`[scheduler] session review ${dateKey}: collector FAILED — ${collector.error}`);
      if (discordConfigured()) void sendDiscordMessage(`${test ? "⚠️ TEST — " : ""}🌇 Session review ${dateKey}: COLLECTOR FAILED ⚠️\n${(collector.error ?? "").slice(0, 500)}`);
      return status;
    }

    // 2. Headless reviewer.
    const claude = resolveClaudeCli();
    let reviewer: SessionReviewStatus["reviewer"];
    let degraded = false;
    if (!claude) {
      degraded = true;
      reviewer = { ok: false, error: "claude CLI not found (PATH + %APPDATA%\\Claude\\claude-code scan)" };
    } else {
      const postUrl = `http://127.0.0.1:${process.env.PORT || "3000"}/api/scheduler/review-post${test ? "?test=1" : ""}`;
      const header = [
        "RUN PARAMETERS (for the instructions below):",
        `- DATE: ${dateKey}`,
        `- FACTS_JSON: ${factsFile}`,
        `- REPORT_OUT: ${reportFile}`,
        `- COMPACT_OUT: ${compactFile}`,
        `- JOURNAL: ${journalFile}`,
        `- DISCORD_POST_URL: ${postUrl}`,
        "", "---", "",
      ].join("\n");
      const prompt = header + fs.readFileSync(PROMPT_FILE, "utf8");
      const postsBefore = reviewPostHits;
      const rvT0 = Date.now();
      console.log(`[scheduler] session review ${dateKey}: spawning reviewer ${claude.path} (${claude.version ?? "?"})…`);
      // acceptEdits + --add-dir (NOT --dangerously-skip-permissions): the reviewer only needs
      // file writes inside the artifacts dir; a denied Bash curl degrades to the scheduler's
      // own compact-post fallback below. 2026-08-07: the skip-permissions variant was blocked
      // by the auto-mode classifier during the build — this scoped form is the sanctioned one.
      const rv = await spawnCapture(claude.path, [
        "-p", "--model", "claude-sonnet-5", "--output-format", "text",
        "--permission-mode", "acceptEdits", "--add-dir", artifactsDir(),
      ], { timeoutMs: REVIEW_TIMEOUT_MS, stdinText: prompt, logFile });
      // FRESHNESS (2026-08-07): a rerun with a pre-existing report must not read as success
      // when the reviewer wrote nothing — require the report be (re)written DURING this run.
      const reportOk = fs.existsSync(reportFile)
        && fs.statSync(reportFile).mtimeMs >= rvT0 - 5000
        && fs.statSync(reportFile).size > 1200
        && fs.readFileSync(reportFile, "utf8").includes("## LESSONS");
      let journalAppended = false;
      try { journalAppended = fs.readFileSync(journalFile, "utf8").includes(`## ${dateKey} [`); } catch { /* keep false */ }
      const discordPosted = reviewPostHits > postsBefore;
      reviewer = {
        ok: rv.code === 0 && reportOk,
        exitCode: rv.code, durationSec: Math.round((Date.now() - rvT0) / 1000), logFile,
        reportFile, reportOk, journalAppended, discordPosted,
        ...(rv.code === 0 && reportOk ? {} : { error: rv.timedOut ? "reviewer timed out" : `exit ${rv.code}, reportOk=${reportOk}: ${rv.tail.slice(-400)}` }),
      };
      degraded = !reviewer.ok;
      // Reviewer wrote the report but skipped/failed the Discord POST → post its compact file.
      if (reviewer.ok && !discordPosted && discordConfigured()) {
        const compact = fs.existsSync(compactFile) ? fs.readFileSync(compactFile, "utf8").trim() : "";
        if (compact) {
          const r = await sendDiscordMessage(`${test ? "⚠️ TEST — " : ""}${compact.slice(0, 1800)}`);
          reviewer.discordPosted = r.ok;
        }
      }
    }

    // 3. Degraded mode — deterministic summary so the ritual NEVER goes silent.
    if (degraded && discordConfigured()) {
      const mech = buildMechanicalSummary(factsFile);
      await sendDiscordMessage(`${test ? "⚠️ TEST — " : ""}🌇 **Session review ${dateKey} — MECHANICAL REPORT (reviewer unavailable)**\n${mech}\nFacts: ${factsFile}`);
    }

    const status = record({
      at, trigger, dateKey, ok: !degraded, test, degraded, collector,
      claude: claude ?? null, reviewer,
      durationSec: Math.round((Date.now() - t0) / 1000),
    });
    console.log(`[scheduler] session review ${dateKey} ${degraded ? "DEGRADED (mechanical report posted)" : "ok"} in ${status.durationSec}s` +
      (reviewer ? ` — report=${reviewer.reportOk ? "ok" : "missing"} journal=${reviewer.journalAppended ? "appended" : "no"} discord=${reviewer.discordPosted ? "posted" : "no"}` : ""));
    return status;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[scheduler] session review ${dateKey} FAILED: ${msg}`);
    return record({ at, trigger, dateKey, ok: false, test, error: msg, durationSec: Math.round((Date.now() - t0) / 1000) });
  } finally {
    reviewRunning = false;
  }
}

// ── Tick loop + admin routes ─────────────────────────────────────────────────
async function scheduledCatchup(): Promise<void> {
  const status = await runCatchupPass("scheduled");
  lastCatchup = status;
  writeSetting("scheduler_last_catchup", JSON.stringify(status));
  recordCatchupTrail(status);
  // LATE-SIGNAL FAILSAFE (2026-08-11): a back-fill must never be a silent surprise the user
  // discovers on the chart — announce every inserted fire the moment the pass lands it.
  if (status.ok && (status.inserted ?? 0) > 0 && discordConfigured()) {
    const fmtKey = (k: string): string => {
      const [iv, ts, dir] = k.split("|");
      const et = new Date(Number(ts) * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
      return `${et} ET ${iv} ${dir}`;
    };
    const list = (status.backfilledKeys ?? []).map(fmtKey).join(" · ");
    void sendDiscordMessage(
      `⏱️ Catch-up back-filled ${status.inserted} missed fire(s) (engine-endorsed, source=catchup): ${list || "(keys unavailable)"} — a live tab did not record these at fire time (live-vs-replay drift or no tab open).`,
    );
  }
}

// MISSED SESSION DAYS (2026-10-07) step bookkeeping (see tick step 0).
const MISSED_STEP_EVERY_MS = 10 * 60_000;
let missedBootSweepDone = false, missedBootSweepRunning = false, missedStepRunning = false, lastMissedStepMs = 0;

function tick(): void {
  const p = etNow();
  const uptimeOk = Date.now() - bootMs >= BOOT_QUIET_MS;
  if (!uptimeOk) return;
  const repair = fs.existsSync(REPAIR_SENTINEL);

  // 0. MISSED SESSION DAYS (2026-10-07): whole sessions the computer was off for get back-filled
  // (catchup.ts runMissedDayPass — same replay/admission/source='catchup' as the today pass, one day
  // per compute request, only once the day's 1m bars are healed). BOOT: the first eligible tick
  // after the quiet window sweeps every ready day (oldest first, 20 s apart) BEFORE the today pass,
  // so days are written in chronological order; afterwards at most ONE day per 10 min, any hour
  // (a Saturday boot still back-fills Thu/Fri). The detection check is a few indexed reads.
  if (CATCHUP_ENABLED && !repair && !regenChildRunning && !catchupRunning() && !missedStepRunning) {
    const boot = !missedBootSweepDone;
    if (boot || Date.now() - lastMissedStepMs >= MISSED_STEP_EVERY_MS) {
      missedBootSweepDone = true;
      lastMissedStepMs = Date.now();
      let pending = 0;
      try { pending = missedDaysPendingCount(); }
      catch (e: any) { console.error(`[scheduler] missed-day detection failed: ${e?.message ?? e}`); }
      if (pending > 0) {
        missedStepRunning = true;
        missedBootSweepRunning = boot;
        void runMissedDaysStep({ trigger: boot ? "boot" : "scheduled", maxDays: boot ? MAX_MISSED_SESSIONS : 1 })
          .catch((e: any) => console.error(`[scheduler] missed-day step failed: ${e?.message ?? e}`))
          .finally(() => { missedStepRunning = false; missedBootSweepRunning = false; });
      }
    }
  }

  // 1. Catch-up: every 30 min during session hours (waits while the boot missed-day sweep runs —
  // chronological order; the sweep holds the flag only per day, so this check is explicit).
  if (CATCHUP_ENABLED && !repair && !regenChildRunning && !catchupRunning() && !missedBootSweepRunning && isMarketOpen(p)) {
    const lastMs = lastCatchup ? Date.parse(lastCatchup.at) : 0;
    if (!Number.isFinite(lastMs) || Date.now() - lastMs >= CATCHUP_EVERY_MS - 30_000) {
      void scheduledCatchup();
    }
  }

  // 2. Daily digest: 8:30 AM ET weekdays. CATCH-UP (2026-08-04): the old fire window was
  // 08:30-08:59 only — a server that was down/asleep at 08:30 silently skipped the WHOLE day
  // ("digest sometimes never shows"). Now any tick until 16:00 ET sends the missed digest;
  // the header's send-time makes lateness self-evident.
  if (DIGEST_ENABLED && p.wd !== "Sat" && p.wd !== "Sun" && p.mins >= 510 && p.mins < 960) {
    if (lastDigest?.dateKey !== p.dateKey) {
      // Mark the day BEFORE the async send so a slow Discord call can't double-fire.
      lastDigest = { at: new Date().toISOString(), dateKey: p.dateKey, ok: false, error: "sending" };
      void sendDailyDigest(false);
    }
  }

  // 3. Weekly regen: Sunday 12:00 ET (fire window 12:00-12:29).
  if (WEEKLY_REGEN_ENABLED && p.wd === "Sun" && p.mins >= 720 && p.mins < 750) {
    const lastKey = lastRegen ? lastRegen.at.slice(0, 10) : "";
    const todayUtcKey = new Date().toISOString().slice(0, 10);
    if (lastKey !== todayUtcKey && !regenChildRunning) void runWeeklyRegen("scheduled");
  }

  // 4. Session review: weekdays 17:20 ET (post-RTH-close). Any later tick that day still
  // fires a missed review (server down/asleep at 17:20 — digest catch-up precedent); the
  // Globex 18:00 roll doesn't matter because the job pins its own dateKey at entry.
  if (SESSION_REVIEW_ENABLED && p.wd !== "Sat" && p.wd !== "Sun" && p.mins >= 17 * 60 + 20) {
    if (lastSessionReview?.dateKey !== p.dateKey && !reviewRunning && !regenChildRunning && !repair) {
      // Claim the day BEFORE the async run so a slow review can't double-fire.
      lastSessionReview = { at: new Date().toISOString(), trigger: "scheduled", dateKey: p.dateKey, ok: false, error: "running" };
      void runSessionReview("scheduled", { date: p.dateKey });
    }
  }

  // 5. SHADOW SCALPS (2026-10-06, record-only — never an order/alert/engine input): first tick after
  // the boot-quiet window = boot backfill (empty table → last 90 sessions, era backfill) or catch-up
  // (missed sessions, era live); then weekdays from 17:30 ET the finished session (idempotent per day).
  try { shadowScalpsTick({ dateKey: p.dateKey, mins: p.mins }); }
  catch (e: any) { console.error(`[scheduler] shadow scalps tick failed: ${e?.message ?? e}`); }
}

export function initScheduler(app: Express): void {
  // Admin triggers (same class as POST /api/signals/resync-broadcast — local ops nudges).
  app.post("/api/scheduler/catchup-now", async (_req, res) => {
    const status = await runCatchupPass("manual");
    lastCatchup = status;
    writeSetting("scheduler_last_catchup", JSON.stringify(status));
    res.json(status);
  });
  app.post("/api/scheduler/digest-test", async (_req, res) => {
    res.json(await sendDailyDigest(true));
  });
  // SESSION REVIEW (2026-08-07): manual trigger — {date?: "YYYY-MM-DD", test?: boolean}.
  app.post("/api/scheduler/session-review-now", async (req, res) => {
    const body = (req.body ?? {}) as { date?: string; test?: boolean };
    const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined;
    res.json(await runSessionReview("manual", { date, test: !!body.test }));
  });
  // SESSION REVIEW (2026-08-07): raw-text Discord relay — the headless reviewer's post path
  // (the existing /api/discord/send is a signal-alert formatter, not a text sender).
  // ?test=1 marks the message; localhost-class ops route like the other scheduler POSTs.
  app.post("/api/scheduler/review-post", async (req, res) => {
    const content = String((req.body as { content?: string } | undefined)?.content ?? "").trim();
    if (!content) { res.status(400).json({ ok: false, error: "content required" }); return; }
    const marked = `${req.query.test != null ? "⚠️ TEST — " : ""}${content.slice(0, 1900)}`;
    const r = await sendDiscordMessage(marked);
    if (r.ok) reviewPostHits++;
    res.json(r);
  });

  setInterval(tick, 30_000);
  console.log(
    `[scheduler] armed — catchup ${CATCHUP_ENABLED ? `ON (every ${CATCHUP_EVERY_MIN}min, session hours)` : "OFF"}, ` +
    `digest ${DIGEST_ENABLED ? "ON (08:30 ET weekdays)" : "OFF"}${discordConfigured() ? "" : " [no webhook!]"}, ` +
    `weekly regen ${WEEKLY_REGEN_ENABLED ? "ON (Sun 12:00 ET)" : "OFF"}, ` +
    `session review ${SESSION_REVIEW_ENABLED ? `ON (17:20 ET weekdays; claude ${resolveClaudeCli()?.version ?? "NOT FOUND — degraded mode"})` : "OFF"}; ` +
    `boot quiet ${BOOT_QUIET_MS / 60000}min; repair sentinel ${REPAIR_SENTINEL}`,
  );
}
