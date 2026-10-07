// shared/ledger-stats.ts
// ─────────────────────────────────────────────────────────────────────────────
// FORWARD-VALIDATION LEDGER (2026-08-02): "is live performance tracking the backtest?"
//
// PURE computation — no DB, no fs, no imports. Two halves:
//
//   deriveExpectation(doc)  — turns the standing backtest results JSON (which carries
//     NO precomputed headline — only the 444 signal rows) into the model's expectation:
//     win rate / expectancy / profit factor / per-trade std / daily-net mean+std /
//     per-interval breakdown. Same aggregation semantics as the workbook metricsOf:
//     win rate = wins / (wins + losses + eod), PF capped at 999 (route precedent).
//
//   computeLedger(rows, expectation) — judges LIVE-era rows (source 'live' or 'catchup',
//     i.e. fired in production; 'regen'/NULL/legacy rows are EXCLUDED — this measures
//     reality against the model, never the model against itself) and returns rolling
//     30-trade stats, the daily net series, the cumulative live-vs-expected curve with
//     a 2σ band, and a drift verdict:
//       COLLECTING — fewer than 30 closed live trades (no fake verdicts on thin data)
//       ALERT      — rolling-30 PF < 1.0, OR cumulative live points below the
//                    expectation's 2σ band (expected − 2·σ_trade·√n)
//       WATCH      — rolling-30 PF below the backtest PF but not ALERT-bad
//       OK         — tracking the model
//
// All user-facing verdict WORDING lives here (verdictWords/verdict reasons) so the UI,
// the status endpoint and the Discord alert say the same plain-English thing.
// ─────────────────────────────────────────────────────────────────────────────

export type LedgerOutcome = "win_tp1" | "win_tp2" | "loss" | "eod" | "open";
export type LedgerVerdict = "COLLECTING" | "OK" | "WATCH" | "ALERT";

/** Verdicts start once this many live trades have CLOSED. */
export const MIN_CLOSED_FOR_VERDICT = 30;
/** Rolling window length (trades). */
export const ROLLING_WINDOW = 30;
/** PF ceiling when there are wins but zero losses (mirrors /api/risk/combo-stats). */
export const PF_CAP = 999;

/** Normalize every outcome vocabulary in the system (DB win_tp1/win_tp2/loss/eod,
 *  backtest tp1/tp2/sl/eod, legacy win/target/stopped/stop/sl) onto one enum.
 *  Anything unknown (open, filled, null) is "open" — never counted as closed. */
export function normalizeLedgerOutcome(o: string | null | undefined): LedgerOutcome {
  switch ((o ?? "").toLowerCase()) {
    case "win_tp2": case "tp2": return "win_tp2";
    case "win_tp1": case "tp1": case "win": case "target": return "win_tp1";
    case "loss": case "sl": case "stopped": case "stop": return "loss";
    case "eod": return "eod";
    default: return "open";
  }
}

/** Fired-in-production rows only: source 'live' (or 'catchup' if that ever appears).
 *  'regen', NULL and undefined are all model-side rows — excluded from the ledger. */
export function isLiveEraSource(source: string | null | undefined): boolean {
  return source === "live" || source === "catchup";
}

/** One signal row as the ledger needs it (DB or backtest shape mapped by the caller). */
export interface LedgerTradeRow {
  /** Fire timestamp, epoch SECONDS. */
  ts: number;
  interval: string;
  outcome: string | null;
  /** pointsResult — the house record's P&L in points. */
  points: number | null;
  source: string | null | undefined;
}

export interface IntervalStats {
  trades: number;          // closed trades
  wins: number;
  winRate: number | null;  // percent 0..100
  expectancy: number | null;
  pf: number | null;
}

export interface BacktestExpectation {
  generatedAt: string | null;
  windowFromKey: string | null;
  windowToKey: string | null;
  /** Closed backtest trades the expectation is derived from. */
  trades: number;
  expWinRate: number | null;    // percent 0..100
  expExpectancy: number | null; // points per closed trade
  expPF: number | null;
  /** Std-dev (population) of closed per-trade points — drives the 2σ band. */
  perTradeStd: number | null;
  dailyNetMean: number | null;
  dailyNetStd: number | null;
  tradesPerDay: number | null;
  perInterval: Record<string, IntervalStats>;
}

// ── small pure helpers ───────────────────────────────────────────────────────

// Module-scope formatter (never construct Intl per row — documented perf trap).
const ET_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
/** ET calendar day ("YYYY-MM-DD") for an epoch-seconds timestamp. */
export function etDateKey(tsSec: number): string {
  return ET_DAY_FMT.format(new Date(tsSec * 1000));
}

function pfOf(points: number[]): number | null {
  let gw = 0, gl = 0;
  for (const p of points) { if (p > 0) gw += p; else if (p < 0) gl += p; }
  if (gl < 0) return Math.min(gw / -gl, PF_CAP);
  return gw > 0 ? PF_CAP : null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Population std-dev (÷n). Null on empty. */
function stdDev(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null) return null;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

interface ClosedTrade { ts: number; interval: string; outcome: LedgerOutcome; points: number }

function isWin(o: LedgerOutcome): boolean { return o === "win_tp1" || o === "win_tp2"; }

function statsOf(trades: ClosedTrade[]): IntervalStats {
  const wins = trades.filter(t => isWin(t.outcome)).length;
  const pts = trades.map(t => t.points);
  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? (100 * wins) / trades.length : null,
    expectancy: mean(pts),
    pf: pfOf(pts),
  };
}

// ── expectation from the standing backtest results JSON ─────────────────────

/** Minimal shape of fact-engine-backtest-results.json the ledger reads. */
export interface StandingResultsDocLike {
  meta?: { generatedAt?: string; windowFromKey?: string; windowToKey?: string };
  signals?: Array<{
    fireTs?: number;
    dateET?: string;
    interval?: string;
    outcome?: string | null;        // backtest vocab: tp1/tp2/sl/eod/open
    engineOutcome?: string | null;  // DB vocab: win_tp1/win_tp2/loss/eod
    pointsResult?: number | null;
  }>;
}

/** Derive the model's expectation from the standing results JSON. Null when the doc
 *  has no usable closed signals (absent file, empty run) — callers degrade honestly. */
export function deriveExpectation(doc: StandingResultsDocLike | null | undefined): BacktestExpectation | null {
  const signals = doc?.signals ?? [];
  const closed: ClosedTrade[] = [];
  const dayNet = new Map<string, { net: number; trades: number }>();
  for (const s of signals) {
    const outcome = normalizeLedgerOutcome(s.outcome ?? s.engineOutcome);
    if (outcome === "open") continue;
    if (typeof s.pointsResult !== "number" || !Number.isFinite(s.pointsResult)) continue;
    const ts = typeof s.fireTs === "number" ? s.fireTs : 0;
    closed.push({ ts, interval: s.interval ?? "?", outcome, points: s.pointsResult });
    const day = s.dateET ?? (ts > 0 ? etDateKey(ts) : "?");
    const cell = dayNet.get(day) ?? { net: 0, trades: 0 };
    cell.net += s.pointsResult; cell.trades += 1;
    dayNet.set(day, cell);
  }
  if (!closed.length) return null;

  const all = statsOf(closed);
  const dayNets = [...dayNet.values()].map(d => d.net);
  const perInterval: Record<string, IntervalStats> = {};
  for (const iv of [...new Set(closed.map(t => t.interval))].sort()) {
    perInterval[iv] = statsOf(closed.filter(t => t.interval === iv));
  }
  return {
    generatedAt: doc?.meta?.generatedAt ?? null,
    windowFromKey: doc?.meta?.windowFromKey ?? null,
    windowToKey: doc?.meta?.windowToKey ?? null,
    trades: closed.length,
    expWinRate: all.winRate,
    expExpectancy: all.expectancy,
    expPF: all.pf,
    perTradeStd: stdDev(closed.map(t => t.points)),
    dailyNetMean: mean(dayNets),
    dailyNetStd: stdDev(dayNets),
    tradesPerDay: dayNet.size ? closed.length / dayNet.size : null,
    perInterval,
  };
}

// ── the ledger itself ────────────────────────────────────────────────────────

export interface CumulativePoint {
  ts: number;
  /** Cumulative live points after this closed trade. */
  live: number;
  /** expectancy × trade count (null when no expectation). */
  expected: number | null;
  /** expected − 2·σ_trade·√n — the honesty band (null when no expectation/σ). */
  lower2: number | null;
}

export interface LedgerReport {
  verdict: LedgerVerdict;
  /** Plain-English one-liner explaining the verdict (same text everywhere). */
  verdictReason: string;
  /** Non-null only while COLLECTING: progress toward the first verdict. */
  collecting: { closed: number; needed: number } | null;
  liveTradesTotal: number;  // every live-era row, open included
  liveClosed: number;
  liveOpen: number;
  liveWins: number;
  liveWinRate: number | null;
  liveExpectancy: number | null;
  livePF: number | null;
  liveNetPts: number;
  rolling30: IntervalStats | null;
  /** Rolling-30 PF at each closed-trade index (sparkline). Empty until 30 closed. */
  rolling30PFSeries: Array<{ ts: number; pf: number | null }>;
  cumulative: CumulativePoint[];
  dailyNet: Array<{ date: string; net: number; trades: number }>;
  perInterval: Record<string, IntervalStats>;
  asOf: string;
}

export function computeLedger(
  rows: LedgerTradeRow[],
  expectation: BacktestExpectation | null,
  opts?: { nowMs?: number },
): LedgerReport {
  const nowMs = opts?.nowMs ?? Date.now();
  // STRICT live-era filter — regen/NULL/undefined never enter the ledger.
  const live = rows.filter(r => isLiveEraSource(r.source));
  const closed: ClosedTrade[] = [];
  let open = 0;
  for (const r of live) {
    const outcome = normalizeLedgerOutcome(r.outcome);
    if (outcome === "open" || typeof r.points !== "number" || !Number.isFinite(r.points)) { open += 1; continue; }
    closed.push({ ts: r.ts, interval: r.interval, outcome, points: r.points });
  }
  closed.sort((a, b) => a.ts - b.ts);

  const all = statsOf(closed);
  const liveNetPts = closed.reduce((a, t) => a + t.points, 0);

  // Rolling 30-trade window over the closed sequence.
  const rollingSeries: Array<{ ts: number; pf: number | null }> = [];
  let rolling30: IntervalStats | null = null;
  if (closed.length >= ROLLING_WINDOW) {
    for (let i = ROLLING_WINDOW - 1; i < closed.length; i++) {
      const win = closed.slice(i - ROLLING_WINDOW + 1, i + 1);
      rollingSeries.push({ ts: closed[i].ts, pf: pfOf(win.map(t => t.points)) });
    }
    rolling30 = statsOf(closed.slice(-ROLLING_WINDOW));
  }

  // Cumulative live vs expected (+ 2σ band).
  const expExp = expectation?.expExpectancy ?? null;
  const sigma = expectation?.perTradeStd ?? null;
  const cumulative: CumulativePoint[] = [];
  let cum = 0;
  for (let i = 0; i < closed.length; i++) {
    cum += closed[i].points;
    const n = i + 1;
    const expected = expExp !== null ? expExp * n : null;
    const lower2 = expected !== null && sigma !== null ? expected - 2 * sigma * Math.sqrt(n) : null;
    cumulative.push({ ts: closed[i].ts, live: cum, expected, lower2 });
  }

  // Daily net over live closed trades.
  const dayNet = new Map<string, { net: number; trades: number }>();
  for (const t of closed) {
    const day = etDateKey(t.ts);
    const cell = dayNet.get(day) ?? { net: 0, trades: 0 };
    cell.net += t.points; cell.trades += 1;
    dayNet.set(day, cell);
  }
  const dailyNet = [...dayNet.entries()]
    .map(([date, v]) => ({ date, net: v.net, trades: v.trades }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const perInterval: Record<string, IntervalStats> = {};
  for (const iv of [...new Set(closed.map(t => t.interval))].sort()) {
    perInterval[iv] = statsOf(closed.filter(t => t.interval === iv));
  }

  // ── verdict ──
  let verdict: LedgerVerdict;
  let verdictReason: string;
  let collecting: LedgerReport["collecting"] = null;
  if (closed.length < MIN_CLOSED_FOR_VERDICT) {
    verdict = "COLLECTING";
    collecting = { closed: closed.length, needed: MIN_CLOSED_FOR_VERDICT };
    verdictReason = `Collecting live trades: ${closed.length} of ${MIN_CLOSED_FOR_VERDICT} closed. A drift verdict starts once ${MIN_CLOSED_FOR_VERDICT} live trades have closed — no judgment on thin data.`;
  } else {
    const r30pf = rolling30?.pf ?? null;
    const last = cumulative[cumulative.length - 1];
    const pfBad = r30pf !== null && r30pf < 1.0;
    const bandBreach = last !== undefined && last.lower2 !== null && last.live < last.lower2;
    if (pfBad || bandBreach) {
      verdict = "ALERT";
      const parts: string[] = [];
      if (pfBad) parts.push(`the last ${ROLLING_WINDOW} live trades are net losers (profit factor ${r30pf!.toFixed(2)}, below 1.0)`);
      if (bandBreach && last) parts.push(`cumulative live points (${last.live.toFixed(1)}) have fallen below the backtest's 2-sigma band (${last.lower2!.toFixed(1)})`);
      verdictReason = `Live results are OFF TRACK: ${parts.join("; and ")}.`;
    } else if (expectation?.expPF != null && r30pf !== null && r30pf < expectation.expPF) {
      verdict = "WATCH";
      verdictReason = `Live results are lagging the model but within normal noise: rolling ${ROLLING_WINDOW}-trade profit factor ${r30pf.toFixed(2)} vs the backtest's ${expectation.expPF.toFixed(2)}, still profitable and inside the 2-sigma band.`;
    } else {
      verdict = "OK";
      verdictReason = expectation
        ? `Live results are tracking the backtest: rolling ${ROLLING_WINDOW}-trade profit factor ${r30pf !== null ? r30pf.toFixed(2) : "n/a"} vs the backtest's ${expectation.expPF != null ? expectation.expPF.toFixed(2) : "n/a"}, cumulative points inside the expected range.`
        : `Live trading is profitable over the last ${ROLLING_WINDOW} closed trades. No backtest baseline is on file to compare against.`;
    }
  }

  return {
    verdict, verdictReason, collecting,
    liveTradesTotal: live.length,
    liveClosed: closed.length,
    liveOpen: open,
    liveWins: all.wins,
    liveWinRate: all.winRate,
    liveExpectancy: all.expectancy,
    livePF: all.pf,
    liveNetPts,
    rolling30,
    rolling30PFSeries: rollingSeries,
    cumulative, dailyNet, perInterval,
    asOf: new Date(nowMs).toISOString(),
  };
}

/** The compact shape GET /api/ledger/status serves (ops digest consumes this). */
export interface LedgerStatus {
  verdict: LedgerVerdict;
  verdictReason: string;
  rolling30PF: number | null;
  liveTrades: number;   // total live-era rows (open included)
  liveClosed: number;
  asOf: string;
}

export function summarizeLedgerStatus(report: LedgerReport): LedgerStatus {
  return {
    verdict: report.verdict,
    verdictReason: report.verdictReason,
    rolling30PF: report.rolling30?.pf ?? null,
    liveTrades: report.liveTradesTotal,
    liveClosed: report.liveClosed,
    asOf: report.asOf,
  };
}

/** Plain-English verdict label — ONE wording source for UI, status route and Discord. */
export function verdictWords(v: LedgerVerdict): string {
  switch (v) {
    case "COLLECTING": return "COLLECTING";
    case "OK": return "ON TRACK";
    case "WATCH": return "WATCH";
    case "ALERT": return "OFF TRACK";
  }
}
