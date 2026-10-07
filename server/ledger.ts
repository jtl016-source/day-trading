/**
 * server/ledger.ts — FORWARD-VALIDATION LEDGER endpoints (2026-08-02).
 *
 * "Is live performance tracking the backtest?" — all math lives in the pure
 * shared/ledger-stats.ts; this file only (1) reads the standing backtest results
 * JSON (env BAXTER_ARTIFACTS_DIR first, repo root fallback — cwd-resolved like
 * server/db.ts DB_PATH; __dirname is NOT defined under tsx ESM), cached by mtime
 * so a regen is picked up without a restart, (2) queries LIVE-era signal rows
 * (source 'live' / 'catchup' — regen and legacy-NULL rows are the model, not
 * reality, and never enter the ledger), and (3) serves:
 *
 *   GET /api/ledger/expectation — the model's bar: {expWinRate, expExpectancy,
 *       expPF, perTradeStd, dailyNetMean, dailyNetStd, tradesPerDay, perInterval...}
 *   GET /api/ledger/status      — compact {verdict, rolling30PF, liveTrades, asOf}
 *       (consumed by the ops daily digest)
 *   GET /api/ledger/summary     — the full ledger payload the Ledger tab renders
 *
 * Alerting: every 15 minutes the verdict is re-evaluated server-side; on a
 * transition INTO ALERT one Discord message is posted via the stored webhook
 * (app_settings key discord_webhook — same store the signal alerts use), deduped
 * to at most ONE alert per ET day (persisted in app_settings so restarts can't
 * double-send). Absence of the JSON, the webhook or live rows degrades gracefully
 * — these routes never 500 on missing artifacts (combo-stats precedent).
 *
 * Registered from routes.ts with a single line: registerLedger(app).
 */
import type { Express } from "express";
import fs from "fs";
import path from "path";
import { db } from "./db";
import { sendDiscordMessage, discordConfigured } from "./discord-notify"; // ONE server-side send path (scheduler mission)
import { appSettings, signalHistory } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { normalizeSymbol } from "@shared/symbol";
import { artifactsDir } from "@shared/artifacts-dir"; // ONE resolver for BAXTER_ARTIFACTS_DIR (coherence rule)
import {
  computeLedger, deriveExpectation, etDateKey, summarizeLedgerStatus, verdictWords,
  type BacktestExpectation, type LedgerTradeRow, type StandingResultsDocLike,
} from "@shared/ledger-stats";

const RESULTS_FILE = "fact-engine-backtest-results.json";
const ALERT_CHECK_MS = 15 * 60 * 1000;
const LAST_ALERT_KEY = "ledger_last_alert_date";

// ── standing-results expectation (mtime-cached: boot read + refresh on file change) ──
let expCache: { path: string; mtimeMs: number; expectation: BacktestExpectation | null } | null = null;

function resultsCandidates(): string[] {
  // Primary: the shared artifacts-dir resolver (BAXTER_ARTIFACTS_DIR, else repo root) —
  // the SAME helper every artifact writer/reader uses. Repo root stays a fallback so a
  // half-moved artifacts dir degrades to the old location instead of "no baseline".
  const primary = path.join(artifactsDir(process.cwd()), RESULTS_FILE);
  const fallback = path.join(process.cwd(), RESULTS_FILE);
  return primary === fallback ? [primary] : [primary, fallback];
}

/** Exported for the pre-restart standalone probe + future parity checks. */
export function loadExpectation(): { expectation: BacktestExpectation | null; sourceFile: string | null } {
  const p = resultsCandidates().find(f => { try { return fs.existsSync(f); } catch { return false; } });
  if (!p) { expCache = null; return { expectation: null, sourceFile: null }; }
  try {
    const mtimeMs = fs.statSync(p).mtimeMs;
    if (expCache && expCache.path === p && expCache.mtimeMs === mtimeMs) {
      return { expectation: expCache.expectation, sourceFile: p };
    }
    const doc = JSON.parse(fs.readFileSync(p, "utf-8")) as StandingResultsDocLike;
    const expectation = deriveExpectation(doc);
    expCache = { path: p, mtimeMs, expectation };
    console.log(`[ledger] expectation loaded from ${path.basename(p)} (${expectation ? `${expectation.trades} closed backtest trades` : "no closed trades"})`);
    return { expectation, sourceFile: p };
  } catch (e) {
    console.warn(`[ledger] failed to read ${p}: ${(e as Error).message}`);
    return { expectation: expCache?.expectation ?? null, sourceFile: p };
  }
}

// ── live-era rows (better-sqlite3 drizzle — synchronous .all()) ──────────────
/** Exported for the pre-restart standalone probe + future parity checks. */
export function loadLiveRows(symbol: string): LedgerTradeRow[] {
  const rows = db.select({
    ts: signalHistory.timestamp,
    interval: signalHistory.interval,
    outcome: signalHistory.outcome,
    points: signalHistory.pointsResult,
    source: signalHistory.source,
  }).from(signalHistory)
    .where(and(eq(signalHistory.symbol, symbol), inArray(signalHistory.source, ["live", "catchup"])))
    .all();
  return rows.map(r => ({ ts: r.ts, interval: r.interval, outcome: r.outcome, points: r.points, source: r.source }));
}

// ── app_settings helpers (sync, non-fatal) ───────────────────────────────────
function readSetting(key: string): string {
  try {
    const rows = db.select().from(appSettings).where(eq(appSettings.key, key)).all();
    return rows[0]?.value ?? "";
  } catch { return ""; }
}
function writeSetting(key: string, value: string): void {
  try {
    db.insert(appSettings).values({ key, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } }).run();
  } catch { /* non-fatal */ }
}

// ── server-side ALERT transition check (15-min cadence, one Discord msg/day) ──
let lastVerdict: string | null = null;
let alertTimerStarted = false;

async function checkAlertTransition(): Promise<void> {
  try {
    const { expectation } = loadExpectation();
    const report = computeLedger(loadLiveRows("MES"), expectation);
    const prev = lastVerdict;
    lastVerdict = report.verdict;
    if (report.verdict !== "ALERT" || prev === "ALERT") return; // fire on TRANSITION only
    const today = etDateKey(Math.floor(Date.now() / 1000));
    if (readSetting(LAST_ALERT_KEY) === today) return;          // max one alert per ET day
    if (!discordConfigured()) { console.warn("[ledger] verdict is ALERT but no Discord webhook is configured"); return; }
    const pf = report.rolling30?.pf;
    const content = [
      `🚨 **LEDGER ALERT — live results are ${verdictWords("ALERT")}**`,
      report.verdictReason,
      `Live record: ${report.liveClosed} closed trades, ${report.liveWinRate != null ? report.liveWinRate.toFixed(1) : "n/a"}% win, net ${report.liveNetPts >= 0 ? "+" : ""}${report.liveNetPts.toFixed(1)} pts.`,
      `Rolling 30-trade profit factor: ${pf != null ? pf.toFixed(2) : "n/a"}${expectation?.expPF != null ? ` (backtest: ${expectation.expPF.toFixed(2)})` : ""}.`,
    ].join("\n");
    const r = await sendDiscordMessage(content); // shared server-side send path (webhook read fresh per send)
    if (r.ok) { writeSetting(LAST_ALERT_KEY, today); console.log("[ledger] ALERT notification sent to Discord"); }
    else console.warn(`[ledger] Discord send failed for the ALERT notification: ${r.error}`);
  } catch (e) {
    console.warn(`[ledger] alert check failed: ${(e as Error).message}`);
  }
}

// ── registration (ONE line in routes.ts: registerLedger(app)) ────────────────
export function registerLedger(app: Express): void {
  loadExpectation(); // boot read — warms the cache and logs what baseline is on file

  // The model's bar, derived from the standing backtest results JSON.
  app.get("/api/ledger/expectation", (_req, res) => {
    try {
      const { expectation, sourceFile } = loadExpectation();
      if (!expectation) {
        res.json({ available: false, reason: "no standing backtest results on file", sourceFile });
        return;
      }
      res.json({ available: true, sourceFile: sourceFile ? path.basename(sourceFile) : null, ...expectation });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Compact status for the ops daily digest.
  app.get("/api/ledger/status", (req, res) => {
    try {
      const sym = normalizeSymbol(String(req.query.symbol ?? "MES"));
      const { expectation } = loadExpectation();
      const report = computeLedger(loadLiveRows(sym), expectation);
      res.json(summarizeLedgerStatus(report));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The full payload the Ledger tab renders — one fetch, no client-side joins.
  app.get("/api/ledger/summary", (req, res) => {
    try {
      const sym = normalizeSymbol(String(req.query.symbol ?? "MES"));
      const { expectation, sourceFile } = loadExpectation();
      const report = computeLedger(loadLiveRows(sym), expectation);
      res.json({
        symbol: sym,
        sourceFile: sourceFile ? path.basename(sourceFile) : null,
        expectation,
        ledger: report,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  if (!alertTimerStarted) {
    alertTimerStarted = true;
    setInterval(() => { void checkAlertTransition(); }, ALERT_CHECK_MS).unref();
    // Seed lastVerdict shortly after boot so the first 15-min tick sees a real "previous".
    setTimeout(() => { void checkAlertTransition(); }, 60 * 1000).unref();
  }
}
