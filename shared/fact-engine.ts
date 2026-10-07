// shared/fact-engine.ts
// ═════════════════════════════════════════════════════════════════════════════
// THE FACT ENGINE — logic-based (NO POINTS) signal decision model.
//
// This is the single source of truth for the firing decision, imported BOTH by the
// live engine (client/src/pages/market.tsx) AND by the offline regeneration + Monte-Carlo
// calibration Node script. It has NO React / DOM / lightweight-charts imports — it operates
// purely over plain data (candles per interval, vector lines per interval, zones, footprint
// imbalance zones, settings). Live and backtest therefore can NEVER diverge.
//
// ── The model (user-dictated 2026-07-13, replacing the retired points system) ────────────
//  VECTOR   — the core fact is a SIDE ENTRY: price crossing the vector line after a sideways
//             shelf. A LONG cross fires on the breakout candle itself. A SHORT needs the down
//             cross plus ≥2 consecutive bearish closes. The SAME rules run on every interval;
//             secondary intervals corroborate (they never veto/modify the primary's fact).
//             TABLETOPS (flat vector plateaus) are level facts whose prices anchor TP1.
//  ZONE     — uploaded milk zones. Fire on a REACTION: wick touches the zone and price moves
//             ≥ ZONE_REACTION_PTS away. A STRONG reaction is the ONLY fact allowed to fire SOLO
//             (RTH only — zones are RTH-only).
//  FOOTPRINT— imbalance ZONES acting as support (long) / resistance (short). Corroborating
//             ONLY, never solo. Works RTH and ETH. (ALL delta logic is gone.)
//  CONFLUENCE — enumerate directional FACTS, then FIRE when: a solo-eligible fact is present,
//             OR ≥2 independent agreeing facts with ≥1 real driver, AND there is ROOM to TP1,
//             AND contradictions are not heavy. Never emit opposing signals on one candle.
//  ICT      — CORROBORATOR-ONLY facts (user directive 2026-07-15: "they back up/confirm signals
//             that would fire for the strategies i already have"): a liquidity-sweep reversal on
//             the firing bar, or price REACTING from a recent order block / breaker / fair value
//             gap in the signal direction (touch the level, close back beyond it, inside the
//             setup's retest window). Detectors imported from shared/ict-engine.ts — never
//             duplicated. counted:true, driver:false — they can complete confluence but NEVER
//             fire alone. RTH-only, primary interval only. Kill-zone flag carried in the note.
//  FRACTAL  — CORROBORATOR-ONLY facts from shared/fractal-engine.ts: a Williams-fractal
//             breakout in the signal direction within the last 5 bars, price closed outside the
//             fractal chaos band in the signal direction (skipped on bars already carrying the
//             breakout fact — same-evidence dedup, the E3 lesson), and the Fractal Chaos
//             Oscillator trending (|FCO| ≥ 0.6) with the signal. RTH-only, primary only.
//  CHOP     — DOCUMENTED DESIGN CHOICE (user rule 5, 2026-07-15): a CHOP state (flat fractal
//             chaos bands with price boxed inside, and/or |FCO| ≤ 0.25) counts as a WEIGHT-1
//             CONTRADICTING fact against BREAKOUT-TYPE drivers (primary vector side-entry,
//             primary yellowbox break) — chop says breakouts fail, so it argues against them,
//             while zone REACTIONS (reversal-type) are untouched. Each active chop reading
//             (bands / FCO) contributes W_FRACTAL_CHOP=1 of contra weight. To give the rule
//             effect, decide() now applies the CONTRADICTION_MARGIN check even when only one
//             side qualifies: the winner's counted weight minus (opposing counted weight +
//             chop contra) must be ≥ CONTRADICTION_MARGIN, else nothing fires. All corroborator
//             weights start at 1 — the data-driven quality gate recalibrates the classes.
//  LABEL    — every signal is labeled with the exact facts used, e.g.
//             "Vector(5m SE↑ + 15m tabletop) + Zone(support @6512)" — never just "confluence".
//             ICT/fractal fragments are explicit: "ICT Breaker(@7601.25, NY-AM)",
//             "Fractal(breakout↑ @7598.50)", "FCO(+0.71 trending)".
// ═════════════════════════════════════════════════════════════════════════════
import { computeVectorLine, classifyZoneBullish } from "./firing/vector";
import { isRTH, isMarketBreak, isAfter315ET, rthSettleOfDay, etWallClock, etSessionDayBucket } from "./firing/session";
import { QUALITY_GATE, qualityGateAllows, comboGateAllows, comboKeyOf, exitOverrideFor, comboExitOverrideFor, type QualityGateData } from "./quality-gate";
import { runIctEngine, deriveSessionLevels, killZoneOf, ICT_CONST, type IctStrategy } from "./ict-engine";
import { computeFractalSeries, FRACTAL_DEFAULTS, FRACTAL_CONST } from "./fractal-engine";
import { computeFractalGeometrySeries, FG_CONST, FG_COUNTED_KINDS, type FgDir } from "./fractal-geometry";
import { walkOutcomeCanonical } from "./outcome-resolver";
import { comboTierOf, SIZE_BY_COMBO_TIER } from "./signal-display";
import type { FiringCandle, FiringZone, VectorPoint } from "./firing/types";

export type Interval = "1m" | "5m" | "15m" | "60m";
export type FactDirection = "Long" | "Short";
export type SignalOutcome = "win_tp1" | "win_tp2" | "loss" | "open";

// Bucket seconds per interval — used for CLOSE-time gating (session gates are evaluated at the
// bar's CLOSE, not its open — rule 11) and for the secondary-interval LOOKAHEAD guard (a coarser
// secondary bar may only corroborate once its close ≤ the primary bar's close — rule B7).
export const INTERVAL_SEC: Record<Interval, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };
/** Seconds between two bars of a slice, inferred from the data (robust when the declared interval
 *  label is wrong — e.g. a "5m" slice actually carrying native 15m bars, defect D18). Falls back
 *  to the declared interval's nominal spacing when the sample is too short. */
function inferBarSec(times: number[], declared: Interval): number {
  let minDelta = Infinity;
  for (let k = 1; k < Math.min(times.length, 50); k++) {
    const d = times[k] - times[k - 1];
    if (d > 0 && d < minDelta) minDelta = d;
  }
  return Number.isFinite(minDelta) ? minDelta : INTERVAL_SEC[declared];
}

// ── EXIT_CALIBRATION — PROVISIONAL placeholders overwritten by the Monte-Carlo step ──────
// Structured as one config object so the MC calibration can replace SL/TP1 defaults wholesale.
export interface ExitCalibration {
  DEFAULT_TP1_PTS: number;   // fallback TP1 when no zone/tabletop anchor is in reach
  DEFAULT_SL_PTS: number;    // fallback stop distance
  TP2_MULT: number;          // TP2 = TP2_MULT × TP1 distance
  MIN_TP1_PTS: number;       // never anchor TP1 closer than this
  TP_ANCHOR_BUFFER_PTS: number; // place TP1 this far short of a zone/tabletop anchor
  ROOM_MIN_PTS: number;      // obstacles nearer than this are ignored (touching the entry)
}
export const EXIT_CALIBRATION: ExitCalibration = {
  DEFAULT_TP1_PTS: 10.0,     // PROVISIONAL — MC calibration overwrites
  DEFAULT_SL_PTS: 5.0,       // PROVISIONAL — MC calibration overwrites
  TP2_MULT: 2.0,             // PROVISIONAL — TP2 = 2 × TP1
  MIN_TP1_PTS: 3.0,
  TP_ANCHOR_BUFFER_PTS: 1.0,
  ROOM_MIN_PTS: 1.0,
};

// ── DAILY LOSS STOP (2026-08-02 — engine-enforced, user-approved) ────────────────────────
/** Default daily loss stop in points. DERIVATION (documented, recompute when the standing
 *  config changes materially): the p95 |day loss| of the LOSING session days of the standing
 *  444-trade per-interval-gate-bar config (fact-engine-backtest-results.json generated
 *  2026-08-01T18:03Z) — 16 losing days of 73, |loss| p50 38 / p75 54.2 / p90 66.6 /
 *  p95 80.13 / worst 115.75 — rounded to the clean 80. Meaning: a day this bad happens on
 *  ~5% of losing days (~1% of all days); beyond it the engine stops firing for the REST OF
 *  THE SESSION (Globex session day, 18:00 ET roll — fires resume next session).
 *
 *  2026-08-17: RULE REMOVED FROM EVERY LIVE PATH (user directive: "take away the rule for the
 *  funded accounts", after the stop — tripped at 9:35 AM ET by the overnight ETH Long-run
 *  losses closing at the open — suppressed an entire RTH session; the funded accounts' own
 *  prop-firm daily limits govern now). The engine capability is UNCHANGED and still honors
 *  whatever dailyLossStopPts an adapter passes; what changed is the SETTINGS layer: catchup.ts
 *  computeDayLossStop defaults to 0 (CATCHUP_DAILY_LOSS_STOP_PTS re-enables), market.tsx
 *  defaults OFF (key bumped to dailyLossStopEnabled2 so the new default beats stale
 *  localStorage), and the harness as-traded stop is 0 (live parity). This constant keeps the
 *  derivation value for the UI input default, would-have analysis, and any future re-enable. */
export const DAILY_LOSS_STOP_DEFAULT_PTS = 80;

/** DEAD-TAPE SUPPRESSION multiplier (2026-08-02 — promoted from display flag to gate-level
 *  enforcement): a fire whose session-day realized range SO FAR is under this fraction of the
 *  window's median full-session-day range is suppressed (measured 5.6% win on the gated
 *  window, n=18 THIN, corroborated ungated n=182 — the analysis showed it kills EVERYTHING,
 *  so nothing is exempt). Same 0.6 the display flag has always used (computeRiskFlags). */
export const DEAD_TAPE_SUPPRESS_MULT = 0.6;

/** ANALYSIS-ONLY dead-tape multiplier override (2026-08-10 strictness sweep). Mirrors the
 *  setGateBarsForAnalysis pattern: NOTHING in the live/serving/backtest pipeline calls the
 *  setter, so every normal run uses DEAD_TAPE_SUPPRESS_MULT and stays byte-identical. Only
 *  scripts/dead-tape-sweep.ts mutates it, in-memory, per simulated pass. */
let deadTapeMultActive = DEAD_TAPE_SUPPRESS_MULT;
export function setDeadTapeMultForAnalysis(mult: number): void { deadTapeMultActive = mult; }

/** DEAD-TAPE DIRECTIONALITY EXEMPTION (2026-08-12 — SHIPPED, user-approved after the sweep):
 *  a quiet-tape bar is EXEMPT from dead-tape suppression when the session's net drift so far
 *  (|close − session open|) is ≥ this fraction of the range so far — quiet-but-TRENDING days
 *  trade, quiet-and-DIRECTIONLESS days stay suppressed. The journal's
 *  [dead-tape-trend-blindspot] hypothesis (filed 2026-08-06 from live evidence, pre-carry),
 *  measured 2026-08-12: at 0.5 it dominated the shipped book on EVERY axis and EVERY sleeve
 *  (win 66.1→73.7%, PF 1.78→2.30, maxDD −24%, 60m sleeve flipped positive; added pool 76.8%
 *  winners). 0.6 also dominated; 0.4/0.3 added volume at slightly lower PF — 0.5 chosen. */
export const DEAD_TAPE_DIR_EXEMPT = 0.5;
/** Analysis mutator (sweep machinery): null disables the exemption entirely (the pre-2026-08-12
 *  gate); restore by setting back to DEAD_TAPE_DIR_EXEMPT. No real path calls this. */
let deadTapeDirExempt: number | null = DEAD_TAPE_DIR_EXEMPT;
export function setDeadTapeDirExemptForAnalysis(x: number | null): void { deadTapeDirExempt = x; }

/** LOSS-STREAK STOP capability (2026-08-10) — MEASURED AND DELIBERATELY NOT WIRED.
 *  Loss momentum is REAL on the standing book (same-day same-interval loss rate 33% base →
 *  54% after 1 straight closed loss → 64% after 2; 1m n=224/103) — but the only honestly
 *  enforceable rule (a loss counts when it CLOSES, exit-aware; scripts/streak-validate.ts)
 *  fails the corroborator bar at EVERY K: K=3 removes 49 trades worth +247 pts (31W/18L),
 *  costs 242 cum pts for +0.02 PF and leaves maxDD EXACTLY unchanged (638.49); K=1/2 are
 *  strictly worse, K=4 a near-no-op. By the time the Kth loss closes, the damage is done and
 *  the -80 daily loss stop already owns the tail. The menu filter's apparent dominance
 *  (cum +882, DD 638→402) was an instant-outcome-knowledge artifact — no live rule can act
 *  on a loss before it closes. NO adapter passes dayLossStreak/streakStopLosses and the
 *  harness as-traded set stays loss-stop-only; the engine capability below stays tested and
 *  inert for future re-evaluation. */
export const STREAK_STOP_LOSSES = 3;
/** Max consecutive-loss run (pointsResult < 0) over CLOSED signals, EXIT-time-ordered.
 *  Monotone as a session day accrues closed trades (the exit-ordered sequence is append-only),
 *  so "run >= K" is sticky without any adapter trip state. SINGLE IMPLEMENTATION: market.tsx,
 *  server/catchup.ts and the harness risk-stop replay all call this — never inline a copy. */
export function maxConsecLossRun(closed: Array<{ exitTs: number; pointsResult: number }>): number {
  const seq = [...closed].sort((a, b) => a.exitTs - b.exitTs);
  let run = 0, max = 0;
  for (const c of seq) { run = c.pointsResult < 0 ? run + 1 : 0; if (run > max) max = run; }
  return max;
}

// ── Detection + confluence constants (named; user granted discretion on exact values) ────
export interface FactEngineSettings {
  // Sideways shelf → side-entry detection
  SHELF_MIN_BARS: number;     // consecutive bars whose bodies form the shelf before the cross
  SHELF_BAND_PTS: number;     // max body-band width (bodies "overlap within a small band")
  SHELF_NEAR_VEC_PTS: number; // shelf must hug the vector within this distance
  SHORT_CONFIRM_BARS: number; // consecutive bearish lower closes after a down cross (≥2)
  // Tabletop (flat vector plateau)
  TABLETOP_FLAT_PTS: number;  // vector flat within this over 2 steps
  // Milk-zone reaction
  ZONE_REACTION_PTS: number;  // N — move-away distance to fire a reaction (settings-exposed)
  ZONE_TOUCH_TOL_PTS: number; // wick within this of the zone edge counts as a touch
  ZONE_STRONG_MULT: number;   // strong reaction ≥ this × N move-away
  ZONE_STRONG_TOUCHES: number;// …or ≥ this many prior touches of the zone
  ZONE_TOUCH_LOOKBACK: number;// bars back to count prior touches for "strong"
  // Yellow Box (per-trading-day box break)
  YELLOWBOX_SOLO: boolean;    // allow a lone yellowbox box-break to fire (RTH) — DEFAULT OFF (solo is -EV)
  /** ETH CONFLUENCE (2026-08-11 — USER REPEALED the "ETH stays pure solo vector side-entry"
   *  house rule: "don't follow it anymore. I want to see how it performs"). TRUE = the full
   *  fact-enumeration block (secondaries, footprint, yellowbox, ICT/fractal/FG corroborators)
   *  runs on ETH bars too and fact-engine confluence signals may fire overnight, judged by the
   *  SAME quality gate + calibrated exits (note: those were derived on RTH-dominated
   *  populations — the weekly regen absorbs ETH rows going forward). FALSE restores the
   *  pre-2026-08-11 purity. RTH-only pieces stay RTH-only regardless: milk-zone reactions
   *  (zones are dated RTH artifacts), strong-zone/yellowbox SOLO fires, forming-bar fires,
   *  and the 15:15 afternoon cutoff. */
  ETH_CONFLUENCE: boolean;
  /** TP1-ONLY EXECUTABLE POLICY (2026-08-13, user directive: "no TP2 ever — all contracts on
   *  one TP"; follows the 2026-08-12 finding that the old record convention retro-awarded
   *  win_tp2 to full positions, an un-executable look-ahead). TRUE (default): signals carry
   *  tp2 = null, walks end at the TP1 touch (win_tp1, exit AT tp1 — a resting limit + stop,
   *  OCO), win_tp2 is never produced. FALSE restores the legacy convention — used ONLY by
   *  pre-policy test fixtures (the ethSeRun escape-hatch pattern). */
  TP1_ONLY: boolean;
  // Confluence
  MIN_AGREEING_FACTS: number; // ≥ this many agreeing facts to fire (non-solo)
  /** ETH CONFLUENCE THRESHOLD (2026-10-01 — SHADOW-TEST setting, docs/eth-trading-research
   *  R4; default = MIN_AGREEING_FACTS so nothing changes until a replay proves it). The
   *  ≥N-counted-agreeing-facts confluence check in decide() uses THIS value instead of
   *  MIN_AGREEING_FACTS on ETH bars (session of the bar CLOSE ≠ RTH); RTH bars keep
   *  MIN_AGREEING_FACTS. At 3 an overnight bar needs three counted agreeing facts (still with
   *  ≥1 driver) to qualify through the confluence path.
   *  SCOPE — the confluence path ONLY: the structural ETH solo PRIMARY vector side-entry rule
   *  (signalType vector-side-entry; a lone primary SE qualifies overnight regardless of count)
   *  is a solo rule like the RTH strong-zone solo and is NOT affected — so a 2-fact
   *  {primary SE + fractal} overnight fire still qualifies; ETH_VETO_FRACTAL_TWO_FACT covers that.
   *  INHERITANCE: a caller that overrides MIN_AGREEING_FACTS but NOT this key gets the same
   *  value for ETH (runFactEngine resolves it), i.e. "default = MIN_AGREEING_FACTS". */
  ETH_MIN_AGREEING_FACTS: number;
  /** ETH FRACTAL TWO-FACT VETO (2026-10-01 — SHADOW-TEST setting, research R4 alternative;
   *  default false = today's behaviour). TRUE: on ETH bars (close ≠ RTH) with the primary
   *  interval 1m or 5m, a fire whose counted facts are a TWO-FAMILY combo that includes a
   *  fractal breakout / chaos-band / FCO fact (strategy "fractal" — NOT fractalGeo) is
   *  suppressed SILENTLY, like a gate block: no note, the cooldown cursor and open-trade state
   *  are NOT consumed. Families = comboKeyOf (the research tables' "Fr+YB" / "Fr+Vec" keys):
   *  exactly two counted facts incl. a fractal one always qualify, and so does {YB break +
   *  fractal breakout + FCO} (3 facts, still "Fr+YB"). Applies whatever the signalType
   *  (vse-driven fires included). Counted in FactEngineInput.statsOut.ethFractalVetoSuppressed. */
  ETH_VETO_FRACTAL_TWO_FACT: boolean;
  /** BOX-SIDE ADMISSION (2026-10-01 — SHADOW-RULE setting R1, docs/signal-analysis-2026-10-01.md;
   *  default false = today's behaviour). TRUE: a Long fires only when the fire bar CLOSES ABOVE
   *  that session's yellow box (close > boxTop), a Short only BELOW it (close < boxBottom) —
   *  never inside or on the wrong side. Bars without a day zone are not judged (no block).
   *  Silent like a gate block: no note, cooldown cursor + open-trade state untouched. Both the
   *  bar-close loop and evaluateFormingBar. Shadow tag: "box-side-wrong". */
  REQUIRE_BOX_SIDE: boolean;
  /** SESSION-RANGE FLOOR (2026-10-01 — SHADOW-RULE setting R2; 0 = off, the default). >0: no
   *  fire until the session day's realized range so far (the dead-tape running range,
   *  including the fire bar) ≥ this × dayRangeMedian. No median → not judged. Silent; both
   *  paths. Shadow tag (at 0.25): "range-below-0.25med". */
  MIN_SESSION_RANGE_FRAC: number;
  /** SESSION-RANGE CAP (2026-10-01 — SHADOW-RULE setting, analysis "Set B"; 0 = off, the
   *  default). >0: no fire once the session range so far > this × dayRangeMedian. Silent; both
   *  paths. Shadow tag (at 1.0): "range-above-1.0med". */
  MAX_SESSION_RANGE_FRAC: number;
  /** TIGHT-ROOM BLOCK (2026-10-01 — SHADOW-RULE setting R3; empty = off, the default): fires on
   *  a listed PRIMARY interval that carry computeRiskFlags' "tight-room" flag are suppressed
   *  silently (both paths). Shadow tag (for ["5m","15m"]): "tight-room@5m15m". */
  BLOCK_TIGHT_ROOM_INTERVALS: Interval[];
  /** PER-INTERVAL TP1 FLOOR (2026-10-01 — SHADOW-RULE setting R4; empty = off, the default):
   *  overrides ExitCalibration.MIN_TP1_PTS for the listed primary interval (e.g. {"1m": 12.25}).
   *  computeExit then BLOCKS a fire whose nearest TP-side obstacle (zone edge / yellowbox init
   *  level / tabletop) is nearer than the floor — the analysis' engine re-run "near-anchor
   *  block" — instead of anchoring TP1 short of it. Silent (an exit-room block). Both paths.
   *  Shadow tag (1m at 12.25): "1m-anchor-under-12.25". */
  MIN_TP1_PTS_BY_INTERVAL: Partial<Record<Interval, number>>;
  CONTRADICTION_MARGIN: number; // winner must beat loser weight by ≥ this, else stalemate (fire nothing)
  // Gates
  /** GLOBAL per-interval cooldown (D13): no new signal (EITHER direction) fires within this many
   *  PRIMARY bars of the previous fire on the interval. Index-based, so ETH bars count exactly
   *  like RTH bars. 2026-09-24: 4 → 10 (the documented "10 bars between signals" rule; at 4 a
   *  persistent box-break state re-fired every 4 minutes all night on 1m). */
  COOLDOWN_BARS: number;
  /** YELLOW-BOX BREAK = ONE-TIME EVENT (2026-09-24, user-approved fix for "a million signals"):
   *  the primary yellowbox break is a COUNTED DRIVER only on the FIRST bar that closes beyond a
   *  box side and the next YB_BREAK_EVENT_BARS-1 bars. Afterwards, while price stays beyond the
   *  box, the fact survives as an uncounted, non-driver label-note ("beyond box ↓ @…", kind
   *  "beyond" — it still selects the initRes/initSup TP1 anchor like before, but can never
   *  complete confluence). The event RE-ARMS when a close returns inside the box (or a new
   *  session's box starts) and price breaks again. Secondary-interval echo notes follow the same
   *  per-interval event window and are OMITTED afterwards (one box ≠ four "breaks" for hours).
   *  0 = legacy unlimited per-bar STATE (pre-2026-09-24 output, for parity/fixture runs). */
  YB_BREAK_EVENT_BARS: number;
  /** ONE OPEN TRADE PER DIRECTION PER INTERVAL (2026-09-24): while a same-direction trade fired
   *  on this interval (by this run, or seeded via FactEngineInput.priorFires /
   *  FormingBarInput.openTrades) has not touched TP1 or SL — canonical resolver rules: tp1Only,
   *  carry-overnight, same-bar TP+SL = loss — no new fire in that direction. Silent like a gate
   *  block: the cooldown cursor is NOT consumed. false = legacy (fires stack while open). */
  ONE_OPEN_PER_DIRECTION: boolean;
  HOD_LOD_PROX_PTS: number;   // suppress longs within this of HOD / shorts within this of LOD
  // Fact weights (for contradiction resolution + confidence)
  W_SIDE_ENTRY: number;
  W_VECTOR_SOFT: number;      // heading / tabletop
  W_ZONE_STRONG: number;
  W_ZONE_NORMAL: number;
  W_YELLOWBOX: number;        // yellowbox break — comparable to a normal milk-zone fact
  W_FOOTPRINT: number;
  // ICT + fractal corroborators (2026-07-15) — confirmation facts, never drivers.
  // ALL start at 1 (user rule 5): the data-driven quality gate recalibrates the classes.
  W_ICT: number;              // per agreeing ICT fact (sweep / OB / breaker / FVG reaction)
  W_FRACTAL: number;          // per agreeing fractal fact (breakout / band / FCO trend)
  W_FRACTAL_CHOP: number;     // CONTRA weight per active chop reading, against breakout drivers
  FRACTAL_RECENT_BARS: number;// a Williams breakout corroborates for this many bars (incl. its own)
  CHOP_CONTRADICTS: boolean;  // escape hatch: disable ONLY the chop-contradiction rule (diagnostics)
  // Fractal-Geometry guide corroborators (2026-07-15 study mission) — confirmation facts,
  // never drivers; weight 1 like ICT/fractal (user rule 5: the gate recalibrates classes).
  W_FRACTAL_GEO: number;      // per agreeing guide fact (reclaim / flat-bounce / compression / room / prior-close cross)
  W_FG_CONTRA: number;        // CONTRA weight per chase / exhaustion warning
  FG_RECENT_BARS: number;     // an event fact corroborates for this many bars (incl. its own)
  FG_CONTRADICTS: boolean;    // escape hatch: disable ONLY chase+exhaustion contra (diagnostics)
}
export const FACT_ENGINE_DEFAULTS: FactEngineSettings = {
  SHELF_MIN_BARS: 3,
  SHELF_BAND_PTS: 3.0,
  SHELF_NEAR_VEC_PTS: 4.0,
  SHORT_CONFIRM_BARS: 2,
  TABLETOP_FLAT_PTS: 0.5,
  ZONE_REACTION_PTS: 2.0,
  ZONE_TOUCH_TOL_PTS: 0.5,
  ZONE_STRONG_MULT: 2.0,
  ZONE_STRONG_TOUCHES: 2,
  ZONE_TOUCH_LOOKBACK: 60,
  YELLOWBOX_SOLO: false,
  ETH_CONFLUENCE: true, // 2026-08-11 user directive — see the interface doc
  TP1_ONLY: true,       // 2026-08-13 user directive — see the interface doc
  MIN_AGREEING_FACTS: 2,
  ETH_MIN_AGREEING_FACTS: 2,        // 2026-10-01 shadow setting — = MIN_AGREEING_FACTS (no change)
  ETH_VETO_FRACTAL_TWO_FACT: false, // 2026-10-01 shadow setting — off (no change)
  REQUIRE_BOX_SIDE: false,          // 2026-10-01 shadow rule R1 — off (no change)
  MIN_SESSION_RANGE_FRAC: 0,        // 2026-10-01 shadow rule R2 — off (no change)
  MAX_SESSION_RANGE_FRAC: 0,        // 2026-10-01 shadow rule (Set B cap) — off (no change)
  BLOCK_TIGHT_ROOM_INTERVALS: [],   // 2026-10-01 shadow rule R3 — off (no change)
  MIN_TP1_PTS_BY_INTERVAL: {},      // 2026-10-01 shadow rule R4 — off (no change)
  CONTRADICTION_MARGIN: 2,
  COOLDOWN_BARS: 10,          // 2026-09-24 (was 4) — see the interface doc
  YB_BREAK_EVENT_BARS: 3,     // 2026-09-24 — break is an event, not a state; 0 = legacy
  ONE_OPEN_PER_DIRECTION: true, // 2026-09-24 — see the interface doc; false = legacy
  HOD_LOD_PROX_PTS: 3.0,
  W_SIDE_ENTRY: 3,
  W_VECTOR_SOFT: 1,
  W_ZONE_STRONG: 3,
  W_ZONE_NORMAL: 2,
  W_YELLOWBOX: 2,
  W_FOOTPRINT: 1,
  W_ICT: 1,
  W_FRACTAL: 1,
  W_FRACTAL_CHOP: 1,
  FRACTAL_RECENT_BARS: FRACTAL_CONST.BREAKOUT_RECENT_BARS,
  CHOP_CONTRADICTS: true,
  W_FRACTAL_GEO: 1,
  W_FG_CONTRA: 1,
  FG_RECENT_BARS: FG_CONST.RECENT_BARS,
  FG_CONTRADICTS: true,
};

// ── Inputs (all plain data) ──────────────────────────────────────────────────────────────
/** One footprint imbalance zone (a stacked-imbalance cluster) — mirror of ImbalanceCluster. */
export interface FpImbalanceZone {
  startPrice: number;
  endPrice: number;
  direction: "buy" | "sell";
  levelCount: number;
}
export interface IntervalSlice {
  interval: Interval;
  candles: FiringCandle[]; // ascending by time; may include a forming last bar (complete:false)
  vector?: VectorPoint[];  // Highest(Lowest(low,20),20); computed here when omitted
}
/** One trading day's Yellow Box, supplied as PLAIN DATA (from /api/yellowbox/day-zones). The engine
 *  stays framework-agnostic — market.tsx marshals the fetched day-zones into this shape. A confirmation
 *  candle closing OUTSIDE the box (close > boxTop / close < boxBottom) emits a `yellowbox` fact; that
 *  day's initRes/initSup then join the TP1 anchor candidate set. RTH-only. */
export interface YellowboxDayZone {
  dayKeyET: string;
  sessionStartTs: number;
  sessionEndTs: number;
  boxTop: number;
  boxBottom: number;
  initRes: number;
  initSup: number;
}
export interface FactEngineInput {
  primary: Interval;
  slices: IntervalSlice[];                         // primary + up to 3 secondaries
  zones: FiringZone[];                             // uploaded milk zones (activeZones)
  dayZones?: YellowboxDayZone[];                   // per-trading-day Yellow Boxes (day-zones endpoint)
  footprintByTime?: Map<number, FpImbalanceZone[]>;// primary-interval imbalance zones per candle time
  settings?: Partial<FactEngineSettings>;
  exit?: Partial<ExitCalibration>;
  nowSec?: number;
  /** DATA-DRIVEN QUALITY GATE (shared/quality-gate.ts, default ON). When enabled, a setup class
   *  (signalType x interval) whose full-history backtest fails PF >= 1.05 AND expectancy > 0.1 pts
   *  emits NOTHING (not even a note; it does not consume cooldown). >=3 counted agreeing facts
   *  always pass; classes without backtest data (zone-reaction, yellowbox-break) are never blocked. */
  qualityGateEnabled?: boolean;
  /** Override of the generated gate + exit-calibration data — used by the backtest harness (which
   *  regenerates the config in-process) and by tests (synthetic configs). Default: QUALITY_GATE. */
  gateData?: QualityGateData;
  /** ICT CONFIRMATIONS (default ON): corroborator-only facts from shared/ict-engine.ts detectors
   *  (sweep / order-block / breaker / FVG reactions) on the PRIMARY interval, RTH-only. Session
   *  liquidity levels are derived INTERNALLY from the primary slice via deriveSessionLevels, so
   *  live and backtest can never diverge. Never a driver — cannot fire without a core fact. */
  ictEnabled?: boolean;
  /** FRACTAL CONFIRMATIONS (default ON): corroborator-only facts from shared/fractal-engine.ts
   *  (Williams breakout / chaos-band close / FCO trend) + the chop-contradiction rule.
   *  Primary interval, RTH-only. Never a driver. */
  fractalEnabled?: boolean;
  /** FRACTAL GEOMETRY CONFIRMATIONS (default ON): corroborator-only facts from
   *  shared/fractal-geometry.ts — the Fractal Exchange GUIDE mechanics (vector reclaim,
   *  flat-vector bounce, compression release, wave room-to-run, prior-close/E-S-vector cross)
   *  + two CONTRA warnings (vector-chase divergence, wave exhaustion — the tail-band fade).
   *  Primary interval, RTH-only. Never a driver. */
  fractalGeoEnabled?: boolean;
  /** LIVE-ONLY reference levels (PML/TML from /api/pml-tml — options-chain exposure). NO
   *  historical options data exists, so these facts are marked backtestable:false and the
   *  backtest harness NEVER supplies them; they only enumerate on the live edge
   *  (bar close within 2 bars of nowSec). Corroborator-only, RTH-only. */
  liveLevels?: { pml?: number | null; tml?: number | null };
  /** RISK BASELINE (2026-07-30 display; ALSO the 2026-08-02 dead-tape ENFORCEMENT baseline):
   *  median full-session-day realized range (pts) of the reporting window. The engine compares
   *  the CURRENT session day's running realized range at fire time against
   *  DEAD_TAPE_SUPPRESS_MULT × this. Harness and live adapter MUST supply the same value
   *  (harness: median over its loaded window days; adapter: served by GET /api/risk/combo-stats,
   *  computed identically) — the parity test asserts equality. Absent/0 → neither the dead-tape
   *  flag nor the suppression is computed (graceful). */
  dayRangeMedian?: number;
  /** DEAD-TAPE SUPPRESSION (2026-08-02 — gate-level enforcement, default ON): a would-be fire
   *  on a session day whose realized range so far < DEAD_TAPE_SUPPRESS_MULT × dayRangeMedian
   *  emits NOTHING (invisible; never consumes cooldown). Nothing is exempt — the measured rule
   *  (5.6% win) killed every class/session. Settings-exposed escape hatch (false = display-flag
   *  only, the pre-2026-08-02 behavior). */
  deadTapeSuppressEnabled?: boolean;
  /** FAIL-CLOSED on a missing dead-tape baseline (2026-08-07 — journal [same-day-drift]):
   *  when TRUE and suppression is not explicitly disabled, an absent/invalid dayRangeMedian
   *  means the gate CANNOT evaluate → the engine emits NOTHING (better no signals than
   *  ungated signals — 2026-08-06's three fires all bypassed dead-tape this way and won by
   *  luck). Every REAL adapter construction (market.tsx, server/catchup.ts, harness) passes
   *  true; unit fixtures omit it and keep the legacy graceful default. */
  deadTapeFailClosed?: boolean;
  /** DAILY LOSS STOP (2026-08-02 — engine-enforced): TODAY's realized signal P&L in points
   *  (adapter: sum of the current session day's closed signal points from served rows + the
   *  open-trade mark; sticky once tripped — see market.tsx). When
   *  dayPnlPts <= -dailyLossStopPts, the engine fires NOTHING for bars of the CURRENT session
   *  day (nowSec's Globex session, 18:00 ET roll) — historical days are untouched (backtests
   *  simulate the same rule day-sequentially in the harness, applyDailyLossStop). */
  dayPnlPts?: number | null;
  /** The stop threshold in points (positive). undefined/<=0 disables the check.
   *  Default lives in the SETTINGS layer (DAILY_LOSS_STOP_DEFAULT_PTS) — the engine only
   *  enforces what it is handed. */
  dailyLossStopPts?: number;
  /** LOSS-STREAK STOP capability — NOT WIRED (2026-08-10 honest validation failed the ship
   *  bar; see the STREAK_STOP_LOSSES doc). If ever passed: max consecutive-loss run
   *  (pointsResult < 0, exit-ordered) among TODAY's CLOSED signals of THIS run's primary
   *  interval (compute with maxConsecLossRun — monotone within a session, sticky by
   *  construction). dayLossStreak >= streakStopLosses ⇒ no more fires for this interval's
   *  CURRENT session day; historical days untouched (harness mirror: applyRiskStops). */
  dayLossStreak?: number | null;
  /** Losses-in-a-row threshold (positive). undefined/<=0 disables — which is the shipped
   *  state: no real adapter passes it (capability only, see STREAK_STOP_LOSSES doc). */
  streakStopLosses?: number;
  /** CROSS-WRITER SEED (2026-09-24): fires ALREADY STORED for THIS primary interval (by another
   *  writer — catch-up, the live engine, a tab). The engine treats each exactly like one of its
   *  own earlier fires: it sets the global cooldown cursor at that bar and (with
   *  ONE_OPEN_PER_DIRECTION) blocks same-direction fires until the stored bracket touches TP1/SL
   *  (resolved here with the canonical resolver over the same 1m-or-primary bars walkForward
   *  uses). A prior fire only affects bars AFTER its own bar (no lookahead); a prior at the
   *  exact bar the engine evaluates is applied after that bar's own decision, so the engine
   *  still re-emits a stored fire it reproduces (identical natural key — callers dedupe).
   *  Absent/empty = today's behaviour. */
  priorFires?: PriorFire[];
  /** NEWS BLACKOUT WINDOWS (2026-10-01 — SHADOW-TEST input, docs/eth-trading-research R3;
   *  absent/empty = today's behaviour; no real adapter passes it yet). A would-be fire whose
   *  bar CLOSE time (= entry time, bar open + primary interval) falls inside a window
   *  [fromSec, toSec) — half-open, unix seconds — is suppressed SILENTLY: no note, the cooldown
   *  cursor and open-trade state are NOT consumed (a later bar outside the window may fire).
   *  Applies to RTH and ETH bars alike, on every interval. Windows with non-finite bounds or
   *  toSec ≤ fromSec are ignored. Each suppression is counted in statsOut
   *  (newsBlackoutSuppressed + newsBlackoutByLabel[label]). Bar-close path only:
   *  evaluateFormingBar (live intra-candle RTH zone reactions) does not take blackouts. */
  newsBlackouts?: Array<{ fromSec: number; toSec: number; label: string }>;
  /** RUN STATS OUT-PARAM (2026-10-01): when supplied, the engine ADDS its suppression counts
   *  for this run into the object (missing fields are initialised to 0 / {}), so one object
   *  can be shared across many runs (per interval / per day) of a replay. Pure reporting —
   *  never read back by the engine, never changes which signals fire. */
  statsOut?: FactEngineRunStats;
}

/** Suppression counters a replay reads back (FactEngineInput.statsOut). Counts are of fires
 *  that had passed EVERY other gate of that run (quality/combo gate, cooldown, one-open,
 *  HOD/LOD, exit room) and were removed only by the named rule — except ethMinFactsSuppressed,
 *  which is counted at decide() (pre-gate; see its doc). The exact fire-set delta of a rule is
 *  always a two-run diff (baseline vs setting): a removed fire no longer starts a cooldown, so
 *  later bars can fire in its place. */
export interface FactEngineRunStats {
  /** Fires removed by FactEngineInput.newsBlackouts. */
  newsBlackoutSuppressed: number;
  /** Same, keyed by the window's label. */
  newsBlackoutByLabel: Record<string, number>;
  /** Fires removed by ETH_VETO_FRACTAL_TWO_FACT. */
  ethFractalVetoSuppressed: number;
  /** ETH bars where decide() found NO qualifying side under ETH_MIN_AGREEING_FACTS but WOULD
   *  have under MIN_AGREEING_FACTS — confluence CANDIDATES removed (pre quality-gate /
   *  cooldown), so this upper-bounds the fires removed. Counted only when the two differ. */
  ethMinFactsSuppressed: number;
  /** Fires removed by the 2026-10-01 shadow-rule settings, keyed by setting name
   *  (REQUIRE_BOX_SIDE / MIN_SESSION_RANGE_FRAC / MAX_SESSION_RANGE_FRAC /
   *  BLOCK_TIGHT_ROOM_INTERVALS / MIN_TP1_PTS_BY_INTERVAL). Added lazily — only present when a
   *  rule actually suppressed something (MIN_TP1_PTS_BY_INTERVAL counts the exit-room blocks
   *  that the default floor would NOT have made). */
  shadowRuleSuppressed?: Record<string, number>;
}
export function newFactEngineRunStats(): FactEngineRunStats {
  return { newsBlackoutSuppressed: 0, newsBlackoutByLabel: {}, ethFractalVetoSuppressed: 0, ethMinFactsSuppressed: 0 };
}

/** A stored fire fed back into runFactEngine (FactEngineInput.priorFires). `time` = the fire
 *  bar's OPEN time on the run's primary interval (signal_history.timestamp); entry/tp1/sl =
 *  the stored bracket (signal_history price/tp1/sl). */
export interface PriorFire {
  time: number;
  direction: FactDirection;
  entry: number;
  tp1: number;
  sl: number;
}

/** An open same-direction bracket handed to evaluateFormingBar (FormingBarInput.openTrades).
 *  `firedAt` = the fire bar's OPEN time on this interval (entry = that bar's close). */
export interface OpenTradeBracket {
  entry: number;
  tp1: number;
  sl: number;
  firedAt: number;
}

// ── A single enumerated fact ──────────────────────────────────────────────────────────────
// "ict" + "fractal" (2026-07-15) are CORROBORATOR-ONLY strategies: counted:true, driver:false —
// they complete the ≥2-agreeing-facts confluence and weigh into contradictions, but a signal
// still needs ≥1 core driver (fired side-entry / zone reaction / primary yellowbox break).
export type FactStrategy = "vector" | "zone" | "yellowbox" | "footprint" | "ict" | "fractal" | "fractalGeo" | "moneyline";
export interface Fact {
  strategy: FactStrategy;
  direction: FactDirection;
  kind: string;          // "side-entry" | "heading" | "tabletop" | "reaction" | "support" | "resistance"
  weight: number;
  driver: boolean;       // real conviction facts (side-entry / zone reaction) — footprint/tabletop/heading are false
  /** Counts toward the ≥2-agreeing-facts confluence tally + contradiction weighing. Tabletops
   *  (C10) and "heading toward side entry" (C11) are label-notes / TP anchors ONLY — counted:false
   *  so a flat consolidation can never fire on heading+tabletop alone. */
  counted: boolean;
  interval: Interval;    // which interval produced this fact (primary vs secondary matters for C9)
  primary: boolean;      // true = primary interval; secondary vector facts may NEVER veto a primary driver
  strong?: boolean;      // strong milk-zone reaction (solo-eligible in RTH)
  level?: number | null; // tabletop / zone-edge price — target anchor / obstacle
  label: string;         // human fragment for the composite label
  /** false = LIVE-ONLY evidence (PML/TML options levels) — absent from every backtest by
   *  construction (the harness never supplies liveLevels); flagged for the DB confirmations
   *  JSON so forward-test analysis can separate it. Default (undefined) = backtestable. */
  backtestable?: boolean;
}

export interface FactSignal {
  time: number;
  interval: Interval;
  direction: FactDirection;
  price: number;   // entry (close of the firing candle)
  high: number;
  low: number;
  tp1: number;
  /** TP1-ONLY policy (2026-08-13): null under TP1_ONLY (the default) — there IS no second
   *  target anymore. Non-null only on legacy-convention runs (TP1_ONLY: false fixtures). */
  tp2: number | null;
  sl: number;
  toTime: number;
  session: "RTH" | "ETH";
  outcome: SignalOutcome;
  facts: Fact[];
  label: string;
  confidence: number;
  signalType: string;     // "fact-engine" | "vector-side-entry" (ETH solo) | "zone-reaction"
  confirmations: string;  // JSON — corroboration metadata for the DB confirmations column
  // RISK DISPLAY (2026-07-30 — DISPLAY-ONLY, never consulted by any gate): the canonical
  // fact-family combo key already computed for the combo gate (comboKeyOf), now EXPOSED so the
  // UI can look up the setup's held-out track record; and the situational risk flags computed
  // at fire time (computeRiskFlags — the four factors the 2026-07-30 risk-factor analysis
  // proved real: no-footprint / late-entry / dead-tape / tight-room).
  comboKey?: string;
  riskFlags?: string[];
  /** SHADOW TAGS (2026-10-01 — RECORD-ONLY, never consulted by any gate): which of the
   *  analysis' candidate rules (docs/signal-analysis-2026-10-01.md R1–R4 + the Set B range cap)
   *  this fire would trip — computeShadowTags, evaluated on EVERY fire whatever the settings
   *  (a rule that is ON removes its own tag's fires, so its tag never appears). Persisted to
   *  signal_history.shadow_tags; scored by GET /api/signals/shadow-tags/summary. */
  shadowTags?: string[];
  /** POSITION SIZING (2026-08-02 — display/config-only): suggested contract count from the
   *  fact-combo's held-out track-record tier (suggestedContractsFor: PROVEN combo = 2, else 1;
   *  mapping = shared/signal-display SIZE_BY_COMBO_TIER). NEVER consulted by any gate and
   *  NEVER sizes a trade unless the user's explicit "Size by combo tier" opt-in is ON. */
  suggestedContracts?: number;
  // BACKTEST-GRADE EXIT DETAIL (2026-07-29) — filled by walkForward for RESOLVED signals so
  // live-fired rows persist the same per-trade detail the backtest harness writes (exit price,
  // exit time, realized points, max adverse/favorable excursion, bars held). All null/undefined
  // while the trade is still open (and on forming-bar intra signals).
  exitPrice?: number | null;
  exitTs?: number | null;
  pointsResult?: number | null;
  mae?: number | null;
  mfe?: number | null;
  barsToExit?: number | null;
  /** True when the trade never hit TP/SL and the session ended (force-closed at the 17:00 ET
   *  settle). The OUTCOME stays "loss" (unchanged engine vocabulary); persistence maps this to
   *  the DB outcome "eod" so the UI can say "CLOSED AT SESSION END" instead of "STOPPED OUT". */
  eodClose?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Per-interval vector state — the SAME rules run on every interval.
// ═════════════════════════════════════════════════════════════════════════════
export interface VectorState {
  sideEntryLong: boolean;   // shelf + upward cross completes on this bar
  sideEntryShort: boolean;  // shelf + down cross + ≥SHORT_CONFIRM_BARS bearish lower closes
  headingLong: boolean;     // in a shelf hugging the vector, poised to break up
  headingShort: boolean;    // in a shelf hugging the vector, poised to break down
  tabletop: boolean;        // vector flat over 2 steps
  tabletopLevel: number | null;
}

/** True when the SHELF_MIN_BARS bars ENDING at index `end` form a tight body-band that hugs
 *  the vector — the "sideways movement" the user requires before a vector cross counts. */
function isShelf(candles: FiringCandle[], vecAt: (i: number) => number | undefined, end: number, s: FactEngineSettings): boolean {
  const start = end - s.SHELF_MIN_BARS + 1;
  if (start < 0) return false;
  let bodyHi = -Infinity, bodyLo = Infinity;
  for (let k = start; k <= end; k++) {
    bodyHi = Math.max(bodyHi, Math.max(candles[k].open, candles[k].close));
    bodyLo = Math.min(bodyLo, Math.min(candles[k].open, candles[k].close));
  }
  if (bodyHi - bodyLo > s.SHELF_BAND_PTS) return false; // bodies must overlap within a small band
  const v = vecAt(end);
  if (v == null) return false;
  // The band must hug the vector line (distance from band to vector within tolerance).
  const dist = Math.max(0, bodyLo - v, v - bodyHi);
  return dist <= s.SHELF_NEAR_VEC_PTS;
}

export function vectorStateAt(candles: FiringCandle[], vecByTime: Map<number, number>, i: number, s: FactEngineSettings): VectorState {
  const state: VectorState = { sideEntryLong: false, sideEntryShort: false, headingLong: false, headingShort: false, tabletop: false, tabletopLevel: null };
  const vecAt = (k: number) => (k >= 0 && k < candles.length ? vecByTime.get(candles[k].time) : undefined);
  const v = vecAt(i);
  if (v == null) return state;

  // Tabletop: vector FLAT across the whole 2-step segment (bars i, i-1, i-2) — every bar in the
  // segment must lie within TABLETOP_FLAT_PTS of the others, not merely the two endpoints (D17).
  const v1 = vecAt(i - 1), v2 = vecAt(i - 2);
  if (v1 != null && v2 != null) {
    const hi = Math.max(v, v1, v2), lo = Math.min(v, v1, v2);
    if (hi - lo <= s.TABLETOP_FLAT_PTS) { state.tabletop = true; state.tabletopLevel = v; }
  }

  // Heading: currently sitting in a shelf that hugs the vector, cross not yet taken.
  if (isShelf(candles, vecAt, i, s)) {
    if (candles[i].close <= v + s.SHELF_BAND_PTS) state.headingLong = true;
    if (candles[i].close >= v - s.SHELF_BAND_PTS) state.headingShort = true;
  }

  // LONG side entry: shelf into bar i-1, then close crosses ABOVE the vector this bar.
  const prev = candles[i - 1], prevV = vecAt(i - 1);
  if (prev && prevV != null && isShelf(candles, vecAt, i - 1, s) && prev.close <= prevV && candles[i].close > v) {
    state.sideEntryLong = true;
  }

  // SHORT side entry: a shelf→down-cross at bar c = i - SHORT_CONFIRM_BARS, then
  // SHORT_CONFIRM_BARS consecutive bearish, strictly-lower closes completing at bar i.
  const c = i - s.SHORT_CONFIRM_BARS;
  if (c >= 1) {
    const cv = vecAt(c), cpv = vecAt(c - 1), cp = candles[c - 1];
    const downCross = cv != null && cpv != null && cp && cp.close >= cpv && candles[c].close < cv && isShelf(candles, vecAt, c - 1, s);
    if (downCross) {
      let ok = true;
      for (let k = c + 1; k <= i; k++) {
        if (!(candles[k].close < candles[k].open && candles[k].close < candles[k - 1].close)) { ok = false; break; }
      }
      if (ok) state.sideEntryShort = true;
    }
  }
  return state;
}

// ═════════════════════════════════════════════════════════════════════════════
// Milk-zone reaction (C8) — the only INTRA-CANDLE-eligible fact.
//   LIVE (market.tsx): evaluated on the FORMING bar so it can fire the instant the wick touches
//     the zone AND price has moved ≥ N away; if that reaction FAILS (price falls back through the
//     touched edge) before the trade is entered, the live path cancels it.
//   BACKTEST / regen (runFactEngine below): the bar-close path APPROXIMATES the same event with a
//     same-bar wick-touch + close-move-away test on the CLOSED bar — the forming-bar intra-candle
//     timeline is not reconstructable from OHLC alone, so the closed bar is the honest proxy.
// Exported so the live engine can reuse the exact same predicate on the forming bar.
// ═════════════════════════════════════════════════════════════════════════════
export interface ZoneReaction {
  direction: FactDirection;
  strong: boolean;
  zoneTop: number;
  zoneBottom: number;
  moveAway: number;   // pts price closed away from the touched edge
}
export function detectZoneReaction(
  candle: FiringCandle,
  zone: FiringZone,
  bullish: boolean,
  priorTouchCount: number,
  s: FactEngineSettings,
): ZoneReaction | null {
  if (bullish) {
    // Support zone: wick dipped to/into the zone, close bounced ≥ N above the top edge.
    const touched = candle.low <= zone.topPrice + s.ZONE_TOUCH_TOL_PTS && candle.low >= zone.bottomPrice - s.ZONE_TOUCH_TOL_PTS - 6;
    const moveAway = candle.close - zone.topPrice;
    if (touched && candle.close > zone.topPrice && moveAway >= s.ZONE_REACTION_PTS) {
      const strong = moveAway >= s.ZONE_STRONG_MULT * s.ZONE_REACTION_PTS || priorTouchCount >= s.ZONE_STRONG_TOUCHES;
      return { direction: "Long", strong, zoneTop: zone.topPrice, zoneBottom: zone.bottomPrice, moveAway };
    }
  } else {
    // Resistance zone: wick poked to/into the zone, close rejected ≥ N below the bottom edge.
    const touched = candle.high >= zone.bottomPrice - s.ZONE_TOUCH_TOL_PTS && candle.high <= zone.topPrice + s.ZONE_TOUCH_TOL_PTS + 6;
    const moveAway = zone.bottomPrice - candle.close;
    if (touched && candle.close < zone.bottomPrice && moveAway >= s.ZONE_REACTION_PTS) {
      const strong = moveAway >= s.ZONE_STRONG_MULT * s.ZONE_REACTION_PTS || priorTouchCount >= s.ZONE_STRONG_TOUCHES;
      return { direction: "Short", strong, zoneTop: zone.topPrice, zoneBottom: zone.bottomPrice, moveAway };
    }
  }
  return null;
}

// Count DISTINCT touch EPISODES of this zone across the prior `lookback` bars (for the strong-
// reaction test). Episode dedup (D14): a run of consecutive touching bars is ONE touch; a new
// episode only begins after ≥1 bar has moved fully away from the zone. This prevents a single
// slow drift through the zone from being counted as many touches.
export function countZoneTouches(candles: FiringCandle[], i: number, zone: FiringZone, bullish: boolean, s: FactEngineSettings): number {
  const isTouch = (b: FiringCandle): boolean => bullish
    ? (b.low <= zone.topPrice + s.ZONE_TOUCH_TOL_PTS && b.low >= zone.bottomPrice - s.ZONE_TOUCH_TOL_PTS)
    : (b.high >= zone.bottomPrice - s.ZONE_TOUCH_TOL_PTS && b.high <= zone.topPrice + s.ZONE_TOUCH_TOL_PTS);
  let episodes = 0, prevTouching = false;
  for (let k = Math.max(0, i - s.ZONE_TOUCH_LOOKBACK); k < i; k++) {
    const touching = isTouch(candles[k]);
    if (touching && !prevTouching) episodes++; // rising edge = a new touch episode
    prevTouching = touching;
  }
  return episodes;
}

// ═════════════════════════════════════════════════════════════════════════════
// Exit geometry + ROOM check (combined — TP1 anchors to the nearest zone/tabletop, and a
// nearer opposing obstacle blocks the fire because there is no clear path to TP1).
// ═════════════════════════════════════════════════════════════════════════════
export type ExitAnchor = "zone" | "yellowbox" | "tabletop" | "default";
export interface ExitResult {
  tp1: number; tp2: number; sl: number; blocked: boolean; anchor: ExitAnchor;
  /** Distance (pts) from the entry to the nearest TP-side obstacle beyond ROOM_MIN_PTS, or null
   *  when there is none (2026-10-01 — read by the "1m-anchor-under-12.25" shadow tag). */
  nearestDist?: number | null;
}
export function computeExit(
  direction: FactDirection,
  entry: number,
  zones: FiringZone[],
  zoneBull: boolean[],
  tabletopLevels: number[],
  cTime: number,
  exit: ExitCalibration,
  ybAnchors: number[] = [],   // yellowbox initRes(long)/initSup(short) anchors — priority after zones, before tabletops
): ExitResult {
  const isLong = direction === "Long";
  // Obstacles in the TP direction: opposing milk zones + yellowbox init levels + tabletops.
  //   Long  → resistance above (bear-zone bottoms, initRes, tabletops above)
  //   Short → support below   (bull-zone tops,     initSup, tabletops below)
  type ObKind = "zone" | "yellowbox" | "tabletop";
  const obstacles: Array<{ level: number; kind: ObKind }> = [];
  for (let zi = 0; zi < zones.length; zi++) {
    const z = zones[zi];
    if (!(z.fromTime ?? 0) || cTime < (z.fromTime ?? 0) || (z.toTime != null && cTime > z.toTime)) continue;
    if (isLong && !zoneBull[zi] && z.bottomPrice > entry) obstacles.push({ level: z.bottomPrice, kind: "zone" });
    if (!isLong && zoneBull[zi] && z.topPrice < entry)    obstacles.push({ level: z.topPrice, kind: "zone" });
  }
  for (const y of ybAnchors) {
    if (isLong && y > entry) obstacles.push({ level: y, kind: "yellowbox" });
    if (!isLong && y < entry) obstacles.push({ level: y, kind: "yellowbox" });
  }
  for (const t of tabletopLevels) {
    if (isLong && t > entry) obstacles.push({ level: t, kind: "tabletop" });
    if (!isLong && t < entry) obstacles.push({ level: t, kind: "tabletop" });
  }
  // Nearest obstacle in the TP direction. Ties (equal distance) break by kind PRIORITY:
  // milk-zone edge > yellowbox init level > tabletop.
  const rankOf = (k: ObKind): number => (k === "zone" ? 0 : k === "yellowbox" ? 1 : 2);
  let nearest: { level: number; kind: ObKind; dist: number } | null = null;
  for (const o of obstacles) {
    const dist = Math.abs(o.level - entry);
    if (dist <= exit.ROOM_MIN_PTS) continue; // touching the entry — ignore
    if (!nearest || dist < nearest.dist - 1e-9 ||
        (Math.abs(dist - nearest.dist) < 1e-9 && rankOf(o.kind) < rankOf(nearest.kind))) {
      nearest = { ...o, dist };
    }
  }

  const defaultTp1 = isLong ? entry + exit.DEFAULT_TP1_PTS : entry - exit.DEFAULT_TP1_PTS;
  const slPts = exit.DEFAULT_SL_PTS;

  if (nearest) {
    if (nearest.dist < exit.MIN_TP1_PTS) {
      // The nearest obstacle is closer than the minimum TP — no clear path to any worthwhile TP1.
      return { tp1: 0, tp2: 0, sl: 0, blocked: true, anchor: nearest.kind, nearestDist: nearest.dist };
    }
    if (nearest.dist < exit.DEFAULT_TP1_PTS) {
      // Anchor TP1 just short of the obstacle (milk-zone edge / tabletop within reach).
      const tp1 = isLong ? nearest.level - exit.TP_ANCHOR_BUFFER_PTS : nearest.level + exit.TP_ANCHOR_BUFFER_PTS;
      const tp1Dist = Math.abs(tp1 - entry);
      const tp2 = isLong ? entry + tp1Dist * exit.TP2_MULT : entry - tp1Dist * exit.TP2_MULT;
      const sl = isLong ? entry - slPts : entry + slPts;
      return { tp1, tp2, sl, blocked: false, anchor: nearest.kind, nearestDist: nearest.dist };
    }
    // Obstacle exists but is beyond the default TP1 — plenty of room; use the default.
  }
  const tp1Dist = exit.DEFAULT_TP1_PTS;
  const tp2 = isLong ? entry + tp1Dist * exit.TP2_MULT : entry - tp1Dist * exit.TP2_MULT;
  const sl = isLong ? entry - slPts : entry + slPts;
  return { tp1: defaultTp1, tp2, sl, blocked: false, anchor: "default", nearestDist: nearest ? nearest.dist : null };
}

// ── Walk-forward outcome — CANONICAL RESOLVER (2026-07-31, shared/outcome-resolver.ts).
//    First touch decides permanently; the ONLY upgrade is win_tp1 → win_tp2 when TP2 is
//    reached with NO SL touch in between (an SL touch after TP1 locks win_tp1 forever);
//    same-bar TP+SL resolves SL-first; "eod" only when NEITHER TP1 nor SL ever touched.
//    The walk runs on the FINEST slice available — the 1m slice when it covers the trade
//    (deriveEngineSlices supplies one on every chart), else the primary bars. This fixes
//    the false-record bug: a 15m primary bar spanning a 09:32 TP1 touch and a 09:49 SL
//    touch used to read "loss" (SL-first within the coarse bar) though TP1 was first. ────
interface WalkExitDetail {
  exitPrice: number | null;
  exitTs: number | null;
  pointsResult: number | null;
  mae: number | null;
  mfe: number | null;
  barsToExit: number | null;
  eodClose: boolean;
}
/** CLOSED-BAR LIVE EDGE (2026-10-01, docs/signal-analysis-2026-10-01.md ticket 12b): the close time of
 *  the newest bar in `candles` that has CLOSED by `nowSec` (bar.time + barSec <= nowSec), or -Infinity
 *  when none has. The served 5m/15m/60m windows carry the FORMING bucket — derive-bars rewrites it after
 *  every 1m close and it reaches the engine as a plain candle (no complete:false flag) — so the LAST
 *  bar's end lies in the future and must never define the primary's live edge: measured against it the
 *  1m slice "never covered" the trade and every 5m/15m/60m walk fell back to the coarse bars (SL-first
 *  inside one bar that spanned both levels — the 2026-07-31 false-record class, back through a side
 *  door). Bars are ascending, so the scan from the end stops at the first closed one. Exported for the
 *  forming-bar walk harness only. */
export function closedEdgeTs(candles: ReadonlyArray<{ time: number }>, barSec: number, nowSec: number): number {
  for (let k = candles.length - 1; k >= 0; k--) {
    const end = candles[k].time + barSec;
    if (end <= nowSec) return end;
  }
  return -Infinity;
}

function walkForward(
  candles: FiringCandle[],
  i: number,
  tp1: number,
  tp2: number,
  sl: number,
  isLong: boolean,
  nowSec: number,
  barSecIn?: number,
  fineBars?: FiringCandle[],
  fineBarSecIn?: number,
  tp1Only?: boolean,
): { outcome: SignalOutcome; toTime: number; exit: WalkExitDetail } {
  let settleTs = rthSettleOfDay(candles[i].time);
  if (candles[i].time >= settleTs) {
    for (let d = 1; d <= 4; d++) { settleTs = rthSettleOfDay(candles[i].time + d * 86400); if (settleTs > candles[i].time) break; }
  }
  // barSec comes from the caller (the primary slice's inferred spacing) — consecutive-bar deltas
  // here would be wrong across session gaps (16:55 → 18:00 is 3900s, not one 5m bar).
  const barSec = barSecIn && Number.isFinite(barSecIn) && barSecIn > 0 ? barSecIn : 60;
  const entry = candles[i].close;
  const entryTs = candles[i].time + barSec;
  // CANONICAL WALK SERIES: prefer the FINER slice, but only when it actually COVERS the
  // trade — its data must start at/before the fire bar and reach the primary series' live
  // edge (a partially-covering 1m window could miss the true first touch). Otherwise the
  // primary bars resolve (a --persist regen refines persisted fields at 1m later).
  const fineBarSec = fineBarSecIn && Number.isFinite(fineBarSecIn) && fineBarSecIn > 0 ? fineBarSecIn : 60;
  // CARRY-OVERNIGHT (2026-08-11): coverage requirement is the primary live edge — the walk no
  // longer terminates at the settle, so the settle is not a sufficient coverage bar anymore.
  // CLOSED-BAR EDGE (2026-10-01, ticket 12b): that edge is the newest primary bar CLOSED by nowSec —
  // never a forming bucket's future end (closedEdgeTs). The 1m slice can reach the former, not the
  // latter, and the resolver's own horizon rule keeps every forming bar out of the walk regardless.
  const primaryEndTs = closedEdgeTs(candles, barSec, nowSec);
  const useFine = !!fineBars && fineBars.length > 0 && fineBarSec < barSec
    && fineBars[0].time <= candles[i].time
    && fineBars[fineBars.length - 1].time + fineBarSec >= primaryEndTs;
  const w = walkOutcomeCanonical({
    bars: useFine ? (fineBars as FiringCandle[]) : candles,
    entryTs, entry, tp1, tp2, sl, isLong, settleTs,
    barSec: useFine ? fineBarSec : barSec,
    // The live engine's data horizon is "now" (its candle arrays are now-complete by
    // construction) — mirrors the legacy pastSessionEnd = nowSec > settleTs rule.
    coveredThroughTs: nowSec,
    tp1Only: tp1Only === true,
  });
  const rnd2 = (v: number): number => Math.round(v * 100) / 100;
  if (w.outcome === "open") {
    return { outcome: "open", toTime: settleTs, exit: { exitPrice: null, exitTs: null, pointsResult: null, mae: null, mfe: null, barsToExit: null, eodClose: false } };
  }
  if (w.outcome === "eod") {
    // UNREACHABLE since CARRY-OVERNIGHT (2026-08-11): the canonical resolver no longer
    // produces "eod". Kept for shape-compat with historical callers/rows.
    // Legacy engine shape: a session-end force-close stays outcome "loss" with eodClose:true
    // (the DB persists it distinctly as "eod" via the callers' dbOutcome mapping).
    const exitPrice = w.exitPrice as number, exitTs = w.exitTs as number;
    return {
      outcome: "loss", toTime: settleTs,
      exit: {
        exitPrice: rnd2(exitPrice), exitTs,
        pointsResult: rnd2((exitPrice - entry) * (isLong ? 1 : -1)),
        mae: rnd2(w.mae), mfe: rnd2(w.mfe),
        barsToExit: rnd2((exitTs - entryTs) / barSec),
        eodClose: true,
      },
    };
  }
  const exitPrice = w.exitPrice as number, exitTs = w.exitTs as number;
  return {
    outcome: w.outcome, toTime: w.resolvedBarTime ?? settleTs,
    exit: {
      exitPrice: rnd2(exitPrice), exitTs,
      pointsResult: rnd2((exitPrice - entry) * (isLong ? 1 : -1)),
      mae: rnd2(w.mae), mfe: rnd2(w.mfe),
      barsToExit: rnd2((exitTs - entryTs) / barSec),
      eodClose: false,
    },
  };
}

/** ONE_OPEN_PER_DIRECTION helper (2026-09-24): the exit time (bar-close convention) of a stored
 *  bracket under the CANONICAL resolver — tp1Only per setting, carry-overnight, same-bar TP+SL =
 *  loss — or +Infinity while it is still open at `horizon`. Bar choice mirrors walkForward
 *  exactly: the finer slice when it covers the fire bar through the primary live edge, else
 *  the primary bars. `fireBarTime` = the fire bar's OPEN time (entry at its close). */
function bracketExitTs(
  candles: FiringCandle[],
  barSec: number,
  fireBarTime: number,
  entry: number,
  tp1: number,
  sl: number,
  isLong: boolean,
  horizon: number,
  tp1Only: boolean,
  fineBars?: FiringCandle[],
  fineBarSecIn?: number,
): number {
  if (!candles.length) return Infinity;
  const fineBarSec = fineBarSecIn && Number.isFinite(fineBarSecIn) && fineBarSecIn > 0 ? fineBarSecIn : 60;
  // CLOSED-BAR EDGE (2026-10-01, ticket 12b) — same rule as walkForward: the newest primary bar closed
  // by `horizon`, never a forming bucket's future end.
  const primaryEndTs = closedEdgeTs(candles, barSec, horizon);
  const useFine = !!fineBars && fineBars.length > 0 && fineBarSec < barSec
    && fineBars[0].time <= fireBarTime
    && fineBars[fineBars.length - 1].time + fineBarSec >= primaryEndTs;
  const w = walkOutcomeCanonical({
    bars: useFine ? (fineBars as FiringCandle[]) : candles,
    entryTs: fireBarTime + barSec, entry, tp1, tp2: null, sl, isLong,
    settleTs: rthSettleOfDay(fireBarTime), // carry-overnight: diagnostics only
    barSec: useFine ? fineBarSec : barSec,
    coveredThroughTs: horizon,
    tp1Only,
  });
  return w.outcome === "open" || w.exitTs == null ? Infinity : w.exitTs;
}

// ── Signal-type + confidence — SHARED between the bar-close loop and evaluateFormingBar ──
// (single code path: the intra-candle signal must carry the identical type/confidence the
// engine would assign the same fact set at bar close).
export function signalTypeOf(facts: Fact[], rth: boolean): string {
  const counted = facts.filter(f => f.counted);
  const soloZone = counted.length === 1 && counted[0].strategy === "zone";
  const soloYb = counted.length === 1 && counted[0].strategy === "yellowbox";
  // ETH: a PRIMARY vector side-entry keeps its structural vse identity even when ETH_CONFLUENCE
  // corroborators attach (2026-08-11 — measured: reclassifying vse-driven ETH bars to
  // fact-engine put the book's largest class behind class/combo gates derived without it and
  // halved the standing cum, 7,484→3,912; corroborators now ride along as extra evidence while
  // the type/gating/exits stay vse). ETH fires with NO primary vse driver — the genuinely new
  // ETH-confluence population (yellowbox-break-driven etc.) — classify fact-engine and are
  // gate-judged like any confluence signal. Pre-repeal behavior (facts.every vector) is a
  // subset of the new predicate, so ETH_CONFLUENCE:false runs are unchanged.
  const ethVse = !rth && facts.some(f => f.strategy === "vector" && f.kind === "side-entry" && f.primary && f.counted);
  return soloZone ? "zone-reaction" : soloYb ? "yellowbox-break" : ethVse ? "vector-side-entry" : "fact-engine";
}
export function confidenceOf(facts: Fact[]): number {
  // Provisional — agreeing-fact count + strength (no points scoring in the model).
  const weight = facts.reduce((a, f) => a + f.weight, 0);
  return Math.max(50, Math.min(95, 45 + weight * 8));
}

// ── RISK FLAGS (2026-07-30 — DISPLAY-ONLY; mission "risk info on every signal") ───────────
// The four situational factors the risk-factor analysis (scripts/risk-factor-analysis.ts,
// LEARNINGS 2026-07-30 evening) proved REAL on the gated 3-month window. Computed at fire
// time from engine inputs only, so harness and live adapter agree byte-for-byte (parity).
// NEVER consulted by decide()/gates — pure metadata on the emitted signal.
//   no-footprint  FP family absent from the counted-fact combo (FP-present setups: 75.9% win
//                 PF 3.07 vs 58.7%/1.40 without).
//   late-entry    entry bar opens 14:30–15:15 ET (45.3% win vs 61.7% earlier; n=75).
//   dead-tape     the session day's realized range SO FAR at fire time < 0.6 × the window's
//                 median full-day range (full-day basis measured 5.6% win, n=18 THIN). Note
//                 the live reading is the running range (honest at fire time); the post-hoc
//                 analysis used the finished day's range — backfilled rows carry the latter.
//   tight-room    nearest OPPOSING yellowbox day-zone level (boxTop/boxBottom/initRes/initSup)
//                 closer than 1 × the TP1 distance (54.7% win PF 1.45 vs 75.8%/1.95 with 1–2×
//                 room). The analysis also counted persistent bands; bands are not an engine
//                 input (the harness cannot supply them), so the live flag is levels-only.
// Deterministic order — the parity test compares the array verbatim.
export const RISK_FLAG_IDS = ["no-footprint", "late-entry", "dead-tape", "tight-room"] as const;
export type RiskFlagId = (typeof RISK_FLAG_IDS)[number];
export function computeRiskFlags(args: {
  combo: string;                       // canonical comboKeyOf key of the counted facts
  entryTime: number;                   // fire bar's scheduled CLOSE = entry bar open (unix sec)
  direction: FactDirection;
  entry: number;
  tp1: number;
  dayZone: YellowboxDayZone | null;    // the fire bar's session day-zone (tight-room), or null
  dayRangeSoFar: number | null;        // running session-day realized range at fire time (pts)
  dayRangeMedian: number | null;       // window median full-day range (dead-tape baseline)
}): RiskFlagId[] {
  const flags: RiskFlagId[] = [];
  const fams = args.combo ? args.combo.split("+") : [];
  if (!fams.includes("FP")) flags.push("no-footprint");
  const mins = etWallClock(args.entryTime).mins;
  if (mins >= 14 * 60 + 30 && mins < 15 * 60 + 15) flags.push("late-entry");
  if (args.dayRangeMedian != null && args.dayRangeMedian > 0
    && args.dayRangeSoFar != null && args.dayRangeSoFar > 0
    && args.dayRangeSoFar < 0.6 * args.dayRangeMedian) flags.push("dead-tape");
  const z = args.dayZone;
  const tp1Dist = Math.abs(args.tp1 - args.entry);
  if (z && tp1Dist > 0) {
    const dists: number[] = [];
    for (const lv of [z.boxTop, z.boxBottom, z.initRes, z.initSup]) {
      if (args.direction === "Long" ? lv > args.entry : lv < args.entry) dists.push(Math.abs(lv - args.entry));
    }
    if (dists.length && Math.min(...dists) / tp1Dist < 1.0) flags.push("tight-room");
  }
  return flags;
}

// ── SHADOW TAGS + SHADOW-RULE SETTINGS (2026-10-01, docs/signal-analysis-2026-10-01.md) ─────
// The analysis' four robust NEGATIVE statuses (R1–R4) + the Set B range cap, as (a) RECORD-ONLY
// tags stamped on every fire (computeShadowTags — scored weekly on de-clustered fires, decide
// a rule once its tag has ≥ 40 de-clustered fires) and (b) OFF-by-default engine settings
// (shadowRuleBlock + MIN_TP1_PTS_BY_INTERVAL via exitWithIntervalFloor). ONE predicate per rule,
// shared by the tag and the setting, so a tag means exactly "this setting would have blocked
// this fire" (at the tag's fixed threshold). Deterministic tag order (persisted verbatim).
export const SHADOW_TAG_IDS = [
  "box-side-wrong", "range-below-0.25med", "range-above-1.0med", "tight-room@5m15m", "1m-anchor-under-12.25",
] as const;
export type ShadowTagId = (typeof SHADOW_TAG_IDS)[number];
/** The fixed thresholds the TAGS use (the settings take their own values). */
export const SHADOW_TAG_RULES = {
  RANGE_LOW_FRAC: 0.25,
  RANGE_HIGH_FRAC: 1.0,
  TIGHT_ROOM_INTERVALS: ["5m", "15m"] as Interval[],
  ANCHOR_INTERVAL: "1m" as Interval,
  ANCHOR_FLOOR_PTS: 12.25,
} as const;
export interface ShadowRuleContext {
  interval: Interval;
  direction: FactDirection;
  close: number;                       // fire bar close = entry
  dayZone: YellowboxDayZone | null;    // the fire bar's session day-zone
  dayRangeSoFar: number | null;        // session-day realized range so far INCLUDING the fire bar
  dayRangeMedian: number | null;       // dead-tape baseline (window median full-day range)
  riskFlags: readonly string[];        // computeRiskFlags output for this fire
  nearestObstacleDist: number | null;  // computeExit nearestDist (null = no obstacle / not computed)
}
/** R1 predicate: a Long NOT closing above the box / a Short NOT closing below it. No day zone →
 *  false (not judged). */
export function isBoxSideWrong(direction: FactDirection, close: number, dz: YellowboxDayZone | null): boolean {
  if (!dz || !Number.isFinite(dz.boxTop) || !Number.isFinite(dz.boxBottom)) return false;
  return direction === "Long" ? !(close > dz.boxTop) : !(close < dz.boxBottom);
}
/** Session range so far as a multiple of the median, or null when either is unusable. */
export function sessionRangeRatio(rangeSoFar: number | null, median: number | null): number | null {
  if (median == null || !(median > 0) || rangeSoFar == null || !Number.isFinite(rangeSoFar) || rangeSoFar < 0) return null;
  return rangeSoFar / median;
}
export function computeShadowTags(ctx: ShadowRuleContext): ShadowTagId[] {
  const tags: ShadowTagId[] = [];
  if (isBoxSideWrong(ctx.direction, ctx.close, ctx.dayZone)) tags.push("box-side-wrong");
  const ratio = sessionRangeRatio(ctx.dayRangeSoFar, ctx.dayRangeMedian);
  if (ratio != null && ratio < SHADOW_TAG_RULES.RANGE_LOW_FRAC) tags.push("range-below-0.25med");
  if (ratio != null && ratio > SHADOW_TAG_RULES.RANGE_HIGH_FRAC) tags.push("range-above-1.0med");
  if (SHADOW_TAG_RULES.TIGHT_ROOM_INTERVALS.includes(ctx.interval) && ctx.riskFlags.includes("tight-room")) tags.push("tight-room@5m15m");
  if (ctx.interval === SHADOW_TAG_RULES.ANCHOR_INTERVAL && ctx.nearestObstacleDist != null
    && ctx.nearestObstacleDist < SHADOW_TAG_RULES.ANCHOR_FLOOR_PTS) tags.push("1m-anchor-under-12.25");
  return tags;
}
/** The ENFORCED shadow rules (settings R1–R3 + the range cap; R4 lives in the exit floor). Returns
 *  the blocking setting's name, or null. All OFF by default → always null. */
export function shadowRuleBlock(s: FactEngineSettings, ctx: ShadowRuleContext): string | null {
  if (s.REQUIRE_BOX_SIDE && isBoxSideWrong(ctx.direction, ctx.close, ctx.dayZone)) return "REQUIRE_BOX_SIDE";
  const ratio = (s.MIN_SESSION_RANGE_FRAC > 0 || s.MAX_SESSION_RANGE_FRAC > 0)
    ? sessionRangeRatio(ctx.dayRangeSoFar, ctx.dayRangeMedian) : null;
  if (s.MIN_SESSION_RANGE_FRAC > 0 && ratio != null && ratio < s.MIN_SESSION_RANGE_FRAC) return "MIN_SESSION_RANGE_FRAC";
  if (s.MAX_SESSION_RANGE_FRAC > 0 && ratio != null && ratio > s.MAX_SESSION_RANGE_FRAC) return "MAX_SESSION_RANGE_FRAC";
  if (s.BLOCK_TIGHT_ROOM_INTERVALS?.length && s.BLOCK_TIGHT_ROOM_INTERVALS.includes(ctx.interval)
    && ctx.riskFlags.includes("tight-room")) return "BLOCK_TIGHT_ROOM_INTERVALS";
  return null;
}
/** R4: the effective exit calibration with MIN_TP1_PTS_BY_INTERVAL[interval] applied (returns the
 *  SAME object when the interval has no finite floor — the default — so nothing changes). */
export function exitWithIntervalFloor(exit: ExitCalibration, s: FactEngineSettings, interval: Interval): ExitCalibration {
  const floor = s.MIN_TP1_PTS_BY_INTERVAL?.[interval];
  if (floor == null || !Number.isFinite(floor)) return exit;
  return { ...exit, MIN_TP1_PTS: floor };
}
/** statsOut reporting for a shadow-rule suppression (lazy: default runs never add the key). */
function countShadowRule(stats: FactEngineRunStats | undefined, rule: string): void {
  if (!stats) return;
  const m = stats.shadowRuleSuppressed ?? (stats.shadowRuleSuppressed = {});
  m[rule] = (m[rule] ?? 0) + 1;
}

// ── POSITION SIZING (2026-08-02 — display/config-only) ───────────────────────────────────
/** Suggested contract count for a signal's fact combo at its interval: the combo's held-out
 *  verdict is resolved EXACTLY like the UI does (comboKey@interval first, then the
 *  all-interval fallback, else none) and tiered via the SHARED comboTierOf — PROVEN
 *  (held-out PF >= 1.3, adequate n, not carried) = 2 contracts, everything else = 1
 *  (SIZE_BY_COMBO_TIER). Pure metadata: computed at emission, never consulted by decide()
 *  or any gate. */
export function suggestedContractsFor(
  combo: string,
  interval: string,
  data: QualityGateData = QUALITY_GATE,
): number {
  const cc = data.comboClasses;
  const atIv = (combo && cc?.[`${combo}@${interval}`]) || null;
  const all = (!atIv && combo && cc?.[combo]) || null;
  const scope: "interval" | "all" | "none" = atIv ? "interval" : all ? "all" : "none";
  return SIZE_BY_COMBO_TIER[comboTierOf(atIv ?? all, scope)];
}

// ── Per-class exit resolution — Monte-Carlo calibration (quality-gate.ts exitByClass) ─────
/** Resolve the EFFECTIVE exit calibration for a signal class: the class's Monte-Carlo values
 *  replace the provisional DEFAULT_TP1_PTS / DEFAULT_SL_PTS, while fields the CALLER set
 *  explicitly (input.exit) always win over the calibration. Anchor priority inside computeExit
 *  (milk-zone edge > yellowbox init level > tabletop > calibrated default) is untouched — the
 *  calibration only changes the DEFAULT distances used when no anchor is within reach (and the
 *  anchor-vs-default reach threshold, which is the point). Classes without calibration data
 *  fall back to the provisional EXIT_CALIBRATION (10/5). */
export function resolveClassExit(
  signalType: string,
  interval: Interval,
  base: ExitCalibration,
  callerExit: Partial<ExitCalibration> | undefined,
  data: QualityGateData = QUALITY_GATE,
): ExitCalibration {
  return resolveExitCalibration(signalType, interval, "", base, callerExit, data);
}

/** FULL exit resolution (2026-07-29 — per-COMBO calibration): the signal's fact COMBINATION may
 *  carry its own Monte-Carlo exits (quality-gate.ts exitByCombo, "<combo>@<interval>" keys).
 *  Priority: caller-explicit exit fields > combo exit > class exit > provisional defaults.
 *  Zone/yellowbox TP1 anchors keep their priority INSIDE computeExit — like the class
 *  calibration, a combo exit only changes the DEFAULT distances used when no anchor is within
 *  reach. zone-reaction + vector-side-entry are EXEMPT (mirrors the combo-GATE exemption:
 *  structural rules whose combos have no backtest population of their own — and exempting
 *  vector-side-entry keeps vse@1m, the largest class, byte-identical to its class calibration). */
export function resolveExitCalibration(
  signalType: string,
  interval: Interval,
  combo: string,
  base: ExitCalibration,
  callerExit: Partial<ExitCalibration> | undefined,
  data: QualityGateData = QUALITY_GATE,
): ExitCalibration {
  const comboOv = (signalType === "zone-reaction" || signalType === "vector-side-entry")
    ? null
    : comboExitOverrideFor(combo, interval, data);
  const ov = comboOv ?? exitOverrideFor(signalType, interval, data);
  if (!ov) return base;
  return {
    ...base,
    DEFAULT_TP1_PTS: callerExit?.DEFAULT_TP1_PTS ?? ov.tp1,
    DEFAULT_SL_PTS: callerExit?.DEFAULT_SL_PTS ?? ov.sl,
  };
}

// ── Label builder — lists every strategy/fact; NEVER just "confluence". ──────────────────
// (Exported so the live intra-candle zone-reaction path labels signals identically.)
export function buildLabel(facts: Fact[]): string {
  const order: FactStrategy[] = ["vector", "zone", "yellowbox", "footprint"];
  const names: Partial<Record<FactStrategy, string>> = { vector: "Vector", zone: "Zone", yellowbox: "Yellowbox", footprint: "Footprint" };
  const parts: string[] = [];
  for (const strat of order) {
    const frags = facts.filter(f => f.strategy === strat).map(f => f.label);
    if (frags.length) parts.push(`${names[strat]}(${frags.join(" + ")})`);
  }
  // ICT / fractal / fractal-geometry / moneyline corroborators carry COMPLETE fragments
  // (rule 6: labels list them explicitly) — e.g. "ICT Breaker(@7601.25, NY-AM)",
  // "Fractal(breakout↑ @7598.50)", "FG Reclaim(↑ vector)", "PML(above @7591.25)".
  for (const f of facts) if (f.strategy === "ict" || f.strategy === "fractal" || f.strategy === "fractalGeo" || f.strategy === "moneyline") parts.push(f.label);
  return parts.join(" + ") || "Vector";
}

// Precomputed per-slice lookup structures. `barSec` is INFERRED from the data, not the declared
// label — a slice labelled "5m" may actually carry native 15m bars (D18); close-time gating and
// the lookahead guard must use the real spacing.
interface SliceLookup { interval: Interval; candles: FiringCandle[]; vecByTime: Map<number, number>; times: number[]; barSec: number; }
function asOfIndex(times: number[], t: number): number {
  // Largest index whose time ≤ t (binary search). Returns -1 if none.
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/** Defaults ⊕ caller overrides, plus the ETH_MIN_AGREEING_FACTS inheritance rule: a caller
 *  that overrides MIN_AGREEING_FACTS without naming ETH_MIN_AGREEING_FACTS gets the same
 *  threshold in ETH (the setting "defaults to MIN_AGREEING_FACTS"). */
export function resolveEngineSettings(over?: Partial<FactEngineSettings>): FactEngineSettings {
  const s = { ...FACT_ENGINE_DEFAULTS, ...(over ?? {}) };
  if (over && over.ETH_MIN_AGREEING_FACTS == null && over.MIN_AGREEING_FACTS != null) {
    s.ETH_MIN_AGREEING_FACTS = s.MIN_AGREEING_FACTS;
  }
  return s;
}

/** The confluence threshold decide() applies for a bar's session (ETH_MIN_AGREEING_FACTS on
 *  ETH bars; a missing/non-finite ETH value falls back to MIN_AGREEING_FACTS). */
export function minAgreeingFactsFor(rth: boolean, s: FactEngineSettings): number {
  if (rth) return s.MIN_AGREEING_FACTS;
  const eth = s.ETH_MIN_AGREEING_FACTS;
  return typeof eth === "number" && Number.isFinite(eth) ? eth : s.MIN_AGREEING_FACTS;
}

/** ETH_VETO_FRACTAL_TWO_FACT predicate (exported for replay scripts + tests): ETH bar, 1m/5m
 *  primary, and the counted facts form exactly TWO fact families (comboKeyOf — the key the
 *  research's combo tables are keyed by: "Fr+YB", "Fr+Vec"…) one of which is the fractal
 *  family (a fractal breakout / band / FCO fact). Exactly two counted facts incl. a fractal
 *  one is always such a set; family counting ALSO catches {YB break + breakout + FCO} (3
 *  counted facts, still the Fr+YB combo) and {primary SE + 15m SE + FCO} (Fr+Vec). */
export function isEthFractalTwoFactVeto(facts: Fact[], rth: boolean, primary: Interval, s: FactEngineSettings): boolean {
  if (!s.ETH_VETO_FRACTAL_TWO_FACT || rth || (primary !== "1m" && primary !== "5m")) return false;
  const hasFractal = facts.some(f => f.counted && f.backtestable !== false && f.strategy === "fractal"
    && (f.kind === "breakout" || f.kind === "band" || f.kind === "fco"));
  if (!hasFractal) return false;
  return comboKeyOf(facts).split("+").length === 2;
}

/** The label of the first news-blackout window containing tSec ([fromSec, toSec)), else null. */
export function newsBlackoutAt(
  windows: FactEngineInput["newsBlackouts"], tSec: number,
): string | null {
  if (!windows || !windows.length) return null;
  for (const w of windows) {
    if (!w || !Number.isFinite(w.fromSec) || !Number.isFinite(w.toSec) || w.toSec <= w.fromSec) continue;
    if (tSec >= w.fromSec && tSec < w.toSec) return w.label ?? "";
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// runFactEngine — iterate the PRIMARY interval's closed candles, enumerate facts across all
// intervals, decide, and emit fired signals with composite labels + walk-forward outcomes.
// ═════════════════════════════════════════════════════════════════════════════
export function runFactEngine(input: FactEngineInput): FactSignal[] {
  const s = resolveEngineSettings(input.settings);
  // SHADOW-TEST REPORTING (2026-10-01): suppression counters, ADDED into the caller's object.
  const stats = input.statsOut;
  if (stats) {
    stats.newsBlackoutSuppressed = stats.newsBlackoutSuppressed ?? 0;
    stats.newsBlackoutByLabel = stats.newsBlackoutByLabel ?? {};
    stats.ethFractalVetoSuppressed = stats.ethFractalVetoSuppressed ?? 0;
    stats.ethMinFactsSuppressed = stats.ethMinFactsSuppressed ?? 0;
  }
  const exit = { ...EXIT_CALIBRATION, ...(input.exit ?? {}) };
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const gateOn = input.qualityGateEnabled !== false; // DEFAULT ON
  const gateData = input.gateData ?? QUALITY_GATE;
  // DEAD-TAPE SUPPRESSION (2026-08-02, default ON) — needs the window median to compute at all.
  const medianOk = input.dayRangeMedian != null && input.dayRangeMedian > 0;
  const deadTapeOn = input.deadTapeSuppressEnabled !== false && medianOk;
  // FAIL-CLOSED (2026-08-07): enforcement requested + baseline missing → the gate cannot
  // evaluate for ANY bar of this run — emit nothing at all (see FactEngineInput doc).
  if (input.deadTapeFailClosed && input.deadTapeSuppressEnabled !== false && !medianOk) return [];
  // DAILY LOSS STOP (2026-08-02): tripped = fire NOTHING for the CURRENT session day's bars.
  const lossStopPts = input.dailyLossStopPts ?? 0;
  const lossStopTripped = lossStopPts > 0 && input.dayPnlPts != null
    && Number.isFinite(input.dayPnlPts) && input.dayPnlPts <= -lossStopPts;
  // LOSS-STREAK STOP (2026-08-10): K straight closed losses on this interval today = done.
  const streakStopN = input.streakStopLosses ?? 0;
  const streakStopTripped = streakStopN > 0 && input.dayLossStreak != null
    && Number.isFinite(input.dayLossStreak) && input.dayLossStreak >= streakStopN;
  const nowSessionBucket = etSessionDayBucket(nowSec);
  const ethMinDiffers = minAgreeingFactsFor(false, s) !== s.MIN_AGREEING_FACTS;

  const primarySlice = input.slices.find(sl => sl.interval === input.primary);
  if (!primarySlice || primarySlice.candles.length === 0) return [];

  // Build per-slice lookups (vectors computed here when a slice omits them).
  const lookups: SliceLookup[] = input.slices.map(sl => {
    const candles = sl.candles;
    const vec = sl.vector ?? computeVectorLine(candles);
    const vecByTime = new Map(vec.map(v => [v.time, v.value]));
    const times = candles.map(c => c.time);
    return { interval: sl.interval, candles, vecByTime, times, barSec: inferBarSec(times, sl.interval) };
  });
  const primary = lookups.find(l => l.interval === input.primary)!;
  const secondaries = lookups.filter(l => l.interval !== input.primary);

  // Pre-classify uploaded zones (bull/bear) once.
  const zones = input.zones;
  const zoneBull = zones.map(z => classifyZoneBullish(z));

  // Yellow Box day-zones — plain data, indexed by Globex session span for O(log n) lookup per candle.
  const dayZones = input.dayZones ?? [];
  const dzSorted = [...dayZones].sort((a, b) => a.sessionStartTs - b.sessionStartTs);
  const dzStarts = dzSorted.map(z => z.sessionStartTs);
  const dayZoneAt = (t: number): YellowboxDayZone | null => {
    const idx = asOfIndex(dzStarts, t); // largest session start ≤ t
    if (idx < 0) return null;
    const z = dzSorted[idx];
    return t >= z.sessionStartTs && t <= z.sessionEndTs ? z : null;
  };

  const out: FactSignal[] = [];
  // GLOBAL per-interval cooldown (D13 / rule 10): a single last-fire cursor, NOT per-direction —
  // no new signal (either side) may fire within COOLDOWN_BARS of the previous one on this interval.
  let lastFireBar = -s.COOLDOWN_BARS - 1;
  // ONE OPEN TRADE PER DIRECTION (2026-09-24): per direction, the latest exit time (bar-close
  // convention, exitTs) of any known fire in that direction — +Infinity while one is still open
  // at the data horizon. A candidate at bar i is blocked while openUntil > bar i's close.
  const openUntil: Record<FactDirection, number> = { Long: -Infinity, Short: -Infinity };

  // HOD / LOD of the RTH day (as of the current bar) for entry-proximity suppression.
  let hodDay = -1, hodHigh = -Infinity, hodLow = Infinity;

  // RISK DISPLAY (2026-07-30): running SESSION-DAY realized range (Globex day, 18:00 ET roll —
  // etSessionDayBucket) folded from every closed bar BEFORE the session-gate continues, so the
  // dead-tape flag reads the honest "range so far at fire time". Display-only metadata.
  let sdBucket = Number.NaN, sdHigh = -Infinity, sdLow = Infinity;
  // ANALYSIS (2026-08-12 dead-tape directionality study): the session's OPEN so far — folded
  // alongside the extremes; consumed ONLY by the analysis-mutator exemption below (inert live).
  let sdOpen = Number.NaN;

  const pc = primary.candles;
  const primarySec = primary.barSec; // inferred spacing — for CLOSE-time gates + lookahead

  // CANONICAL OUTCOME WALK INPUT (2026-07-31): the finest slice available for walkForward —
  // the 1m slice when present (deriveEngineSlices supplies one on every chart). Outcome/exit
  // detail is emission METADATA (display + persistence) — never a gate/firing input, so this
  // cannot change which signals fire. walkForward itself falls back to primary bars whenever
  // the 1m slice doesn't fully cover a trade's window.
  const fineLk = lookups.find(l => l.interval === "1m" && l !== primary);
  const fineWalkBars = fineLk?.candles;
  const fineWalkSec = fineLk?.barSec;

  // ═══ CROSS-WRITER SEED (2026-09-24 — FactEngineInput.priorFires): stored fires of this
  // interval act exactly like this run's own earlier fires. Each is mapped to its primary bar
  // index (negative = before this window) and resolved ONCE with the canonical resolver over
  // the same bars walkForward would use; absorbed at the top of the first iteration AFTER its
  // bar (so a stored fire never gates its own bar — no lookahead, and the engine still
  // re-emits a fire it reproduces). A prior older than the window's first bar only seeds the
  // cooldown: its bracket cannot be walked honestly without the missing bars. ═══
  interface SeededPrior { idx: number; direction: FactDirection; exitTs: number }
  const seeded: SeededPrior[] = [];
  for (const pf of input.priorFires ?? []) {
    if (!pf || !Number.isFinite(pf.time) || (pf.direction !== "Long" && pf.direction !== "Short")) continue;
    let idx = asOfIndex(primary.times, pf.time);
    if (idx < 0) idx = -Math.ceil((pc[0].time - pf.time) / primarySec);
    let exitTs = -Infinity; // before-window priors: cooldown only
    if (pf.time >= pc[0].time && Number.isFinite(pf.entry) && Number.isFinite(pf.tp1) && Number.isFinite(pf.sl)) {
      exitTs = bracketExitTs(pc, primarySec, pf.time, pf.entry, pf.tp1, pf.sl, pf.direction === "Long", nowSec, s.TP1_ONLY, fineWalkBars, fineWalkSec);
    }
    seeded.push({ idx, direction: pf.direction, exitTs });
  }
  seeded.sort((a, b) => a.idx - b.idx);
  let seededCursor = 0;

  // ═══ YELLOW-BOX BREAK EVENT STATE (2026-09-24 — YB_BREAK_EVENT_BARS): per series (the
  // primary + each secondary), which side of the current session's box the last CLOSED bar
  // closed on, and the index of the bar that FIRST closed beyond the current side. Folded for
  // every closed bar BEFORE any gate (a gated bar can still be the break bar), re-armed by a
  // close back inside the box, a flip to the other side, or a new session's box. ═══
  interface YbBreakState { side: "above" | "below" | "inside" | null; zoneStart: number; breakIdx: number; cursor: number }
  const newYbState = (): YbBreakState => ({ side: null, zoneStart: Number.NaN, breakIdx: -Infinity, cursor: -1 });
  const ybStep = (st: YbBreakState, idx: number, bar: FiringCandle): void => {
    const dz = dayZoneAt(bar.time);
    if (!dz) { st.side = null; st.zoneStart = Number.NaN; return; }
    if (dz.sessionStartTs !== st.zoneStart) { st.zoneStart = dz.sessionStartTs; st.side = null; }
    const side = bar.close > dz.boxTop ? "above" : bar.close < dz.boxBottom ? "below" : "inside";
    if (side !== "inside" && side !== st.side) st.breakIdx = idx; // a NEW break event
    st.side = side;
  };
  // Event window test: the break bar itself + the next YB_BREAK_EVENT_BARS-1 bars (0 = legacy state).
  const ybEventLive = (st: YbBreakState, idx: number): boolean =>
    s.YB_BREAK_EVENT_BARS <= 0 || idx - st.breakIdx < s.YB_BREAK_EVENT_BARS;
  const ybPrimary = newYbState();
  const ybSecondary = new Map<SliceLookup, YbBreakState>(secondaries.map(sl => [sl, newYbState()]));

  // ═══ ICT + FRACTAL CORROBORATOR PRECOMPUTE (2026-07-15 — user directive: "facts, NOT
  // strategies; they back up/confirm signals that would fire for the strategies i already
  // have"). Both run ONCE over the PRIMARY interval's candles (secondaries deliberately not
  // enumerated — a scope judgment call: primary-bar evidence only, no echo inflation). Both
  // engines are NO-LOOKAHEAD by construction (truncation-tested), so a forming last bar can
  // never contaminate the events of earlier CLOSED bars; the loop below skips the forming
  // bar itself. Fact enumeration historically RTH-ONLY (rule 3) — since 2026-08-11 the
  // ETH_CONFLUENCE setting (default ON, user directive) extends it to ETH bars too. ═══
  const ictOn = input.ictEnabled !== false;         // default ON
  const fractalOn = input.fractalEnabled !== false; // default ON
  interface IctEvent { kind: "sweep" | "ob" | "breaker" | "fvg"; direction: FactDirection; level: number }
  const ictEventsByBar = new Map<number, IctEvent[]>();
  if (ictOn && pc.length > ICT_CONST.MIN_WARMUP_BARS) {
    const pushEv = (barIdx: number, ev: IctEvent): void => {
      let a = ictEventsByBar.get(barIdx);
      if (!a) { a = []; ictEventsByBar.set(barIdx, a); }
      a.push(ev);
    };
    // Only the four fact-bearing ICT setups (mission scope); detectors REUSED from
    // shared/ict-engine.ts — never duplicated. Session liquidity levels derived internally
    // (deriveSessionLevels) so the live adapter and the backtest harness cannot diverge.
    const ictStrategies: IctStrategy[] = ["ICT-SWEEP", "ICT-OB", "ICT-BREAKER", "ICT-FVG"];
    const setups = runIctEngine({
      candles: pc, interval: input.primary, barSec: primarySec,
      levels: deriveSessionLevels(pc), strategies: ictStrategies,
    });
    for (const su of setups) {
      if (su.strategy === "ICT-SWEEP") {
        // The sweep reversal CONFIRMS on its detection bar (the engine's market entry there).
        pushEv(su.setupIdx, { kind: "sweep", direction: su.direction, level: su.refs.sweptLevel ?? su.entry });
        continue;
      }
      // Limit setups (OB / BREAKER / FVG): the corroborating EVENT is the first RETEST
      // REACTION — price returns to the setup's entry level and CLOSES back beyond it in the
      // setup direction, inside the retest window. Death checks first (conservative): a close
      // through the stop, or an FVG close beyond its invalidation level, kills the setup
      // before any reaction is credited. One event per setup.
      const kind = su.strategy === "ICT-OB" ? ("ob" as const) : su.strategy === "ICT-BREAKER" ? ("breaker" as const) : ("fvg" as const);
      const isLong = su.direction === "Long";
      const end = Math.min(pc.length - 1, su.setupIdx + ICT_CONST.RETEST_WINDOW_BARS);
      for (let j = su.setupIdx + 1; j <= end; j++) {
        const b = pc[j];
        if (isLong) {
          if (b.close < su.stop) break;
          if (su.invalidBeyond != null && b.close < su.invalidBeyond) break;
          if (b.low <= su.entry && b.close > su.entry) { pushEv(j, { kind, direction: "Long", level: su.entry }); break; }
        } else {
          if (b.close > su.stop) break;
          if (su.invalidBeyond != null && b.close > su.invalidBeyond) break;
          if (b.high >= su.entry && b.close < su.entry) { pushEv(j, { kind, direction: "Short", level: su.entry }); break; }
        }
      }
    }
  }
  const frSeries = fractalOn && pc.length ? computeFractalSeries(pc) : null;
  // Rolling most-recent Williams breakout per direction (advanced lazily inside the loop).
  let frBkCursor = 0;
  let lastLongBk = { idx: -Infinity, level: 0 };
  let lastShortBk = { idx: -Infinity, level: 0 };
  // ═══ FRACTAL-GEOMETRY GUIDE CORROBORATORS (2026-07-15 study mission) — same contract as
  // ICT/fractal: primary interval only, RTH-only, counted:true, driver:false. The series is
  // computed once, walk-forward (truncation-tested in fractal-geometry.test.ts). Event kinds
  // (reclaim / flat-bounce / compression / prior-close cross) corroborate for FG_RECENT_BARS
  // bars; state kinds (wave room) hold only while the state reads. Chase + exhaustion are
  // CONTRA warnings charged in decide() (coordinator directive: contradicting facts —
  // side-entry DRIVER semantics untouched). ═══
  const fgOn = input.fractalGeoEnabled !== false; // default ON
  const fgSeries = fgOn && pc.length
    ? computeFractalGeometrySeries(pc, pc.map(cc => primary.vecByTime.get(cc.time) ?? null), primarySec)
    : null;
  const fgRecent = (arr: FgDir[], i: number, want: 1 | -1): number => {
    // Index of the most recent `want` event within FG_RECENT_BARS bars ending at i, else -1.
    for (let k = 0; k < s.FG_RECENT_BARS && i - k >= 0; k++) if (arr[i - k] === want) return i - k;
    return -1;
  };
  for (let i = 0; i < pc.length; i++) {
    const c = pc[i];
    // CROSS-WRITER SEED: absorb every stored fire whose bar is BEFORE this one (see above).
    while (seededCursor < seeded.length && seeded[seededCursor].idx < i) {
      const sp = seeded[seededCursor++];
      if (sp.idx > lastFireBar) lastFireBar = sp.idx;
      if (sp.exitTs > openUntil[sp.direction]) openUntil[sp.direction] = sp.exitTs;
    }
    if ((c as any).complete === false) continue; // closed candles only (live forming bar handled by caller)
    // Session gates are evaluated at the bar's CLOSE time, not its open (rule 11 / D16). A bar that
    // OPENS inside RTH but CLOSES after 5:00 PM ET is an ETH/break bar for firing purposes.
    const closeTime = c.time + primarySec;
    // CLOSED BY THE ENGINE'S CLOCK (2026-10-01, docs/signal-analysis-2026-10-01.md ticket 12b): a bar
    // whose close lies AFTER nowSec has not closed — it is the forming 5m/15m/60m bucket the served
    // windows carry (derive-bars rewrites it after every 1m close; it arrives with no complete flag, so
    // the check above cannot see it). Evaluating it fired on partial OHLC at the bucket's OPEN time —
    // read-only audit 2026-10-01: 20 of the 354 stored 5m/15m/60m rows of the last 30 days carry an
    // entry that is not their bar's final close, up to 22 pts off — and folded its partial close into
    // the YB-break / HOD-LOD / session-range state. Skip it entirely. Every real caller passes
    // nowSec = now (tab, catch-up, live engine, harness, parity), so a closed bar is never affected.
    if (closeTime > nowSec) continue;
    ybStep(ybPrimary, i, c); // YB break event state — every closed bar, before any gate
    const rth = isRTH(closeTime);
    const session: "RTH" | "ETH" = rth ? "RTH" : "ETH";

    // HOD/LOD tracking (RTH), captured BEFORE folding the current bar in.
    const cDay = Math.floor(c.time / 86400);
    if (cDay !== hodDay) { hodDay = cDay; hodHigh = -Infinity; hodLow = Infinity; }
    const prevHodHigh = hodHigh, prevHodLow = hodLow;
    if (rth) { if (c.high > hodHigh) hodHigh = c.high; if (c.low < hodLow) hodLow = c.low; }

    // Session-day running range (risk display) — folded for EVERY closed bar, before any gate.
    const cSd = etSessionDayBucket(c.time);
    if (cSd !== sdBucket) { sdBucket = cSd; sdHigh = -Infinity; sdLow = Infinity; sdOpen = c.open; }
    if (c.high > sdHigh) sdHigh = c.high;
    if (c.low < sdLow) sdLow = c.low;

    if (isMarketBreak(closeTime)) continue;              // 5:00–6:00 PM ET settlement halt (at close)
    if (rth && isAfter315ET(closeTime)) continue;        // no new signals ≥ 3:15 PM ET (at close)
    if (primary.vecByTime.get(c.time) == null) continue; // need a vector value on this bar

    // DAILY LOSS STOP (2026-08-02 — engine-enforced): once the CURRENT session day's realized
    // P&L (adapter-supplied dayPnlPts, sticky once tripped) breaches -dailyLossStopPts, the
    // engine fires NOTHING for the rest of that session — invisible (no note) and BEFORE the
    // cooldown cursor, exactly like a gate block. Historical session days are untouched (the
    // harness simulates the same rule day-sequentially — applyDailyLossStop).
    if (lossStopTripped && cSd === nowSessionBucket) continue;
    // LOSS-STREAK STOP (2026-08-10): same current-session-only scope + invisibility as the
    // loss stop — a tripped interval fires nothing more today, historical days untouched.
    if (streakStopTripped && cSd === nowSessionBucket) continue;

    // DEAD-TAPE SUPPRESSION (2026-08-02 — the measured rule promoted from display flag to
    // gate-level enforcement, NOTHING exempt): session-day realized range so far (folded
    // above, including this bar) under DEAD_TAPE_SUPPRESS_MULT × the window median → no fire.
    // Same predicate as the computeRiskFlags "dead-tape" flag — with enforcement ON, no
    // emitted signal can carry that flag (the escape hatch restores flag-only behavior).
    if (deadTapeOn) {
      const drSoFar = sdHigh > -Infinity && sdLow < Infinity ? sdHigh - sdLow : null;
      // deadTapeMultActive === DEAD_TAPE_SUPPRESS_MULT except inside the analysis sweep.
      if (drSoFar != null && drSoFar > 0 && drSoFar < deadTapeMultActive * (input.dayRangeMedian as number)) {
        // DIRECTIONALITY EXEMPTION (2026-08-12, SHIPPED): a quiet-but-TRENDING session
        // (net drift ≥ DEAD_TAPE_DIR_EXEMPT × range so far) trades through the quiet tape;
        // quiet-and-directionless bars stay suppressed (the measured 5.6%-win chop).
        const drift = Number.isFinite(sdOpen) ? Math.abs(c.close - sdOpen) : 0;
        const dirOk = deadTapeDirExempt != null && drift >= deadTapeDirExempt * drSoFar;
        if (!dirOk) continue;
      }
    }

    // ── Enumerate facts ────────────────────────────────────────────────────────────────
    const longFacts: Fact[] = [];
    const shortFacts: Fact[] = [];
    const tabletopLevels: number[] = [];
    let chopContra = 0; // fractal CHOP contra weight for this bar (RTH-only, set below)
    let fgContraLong = 0, fgContraShort = 0; // fractal-geometry chase/exhaustion contra (RTH-only)

    const addVectorFacts = (st: VectorState, iv: Interval, isPrimaryIv: boolean) => {
      const pfx = isPrimaryIv ? "" : `${iv} `;
      // A FIRED side-entry is a conviction DRIVER (counted). "heading toward side entry" (still in
      // the shelf, cross not yet taken) is a LABEL-NOTE ONLY — counted:false (C11) so it never adds
      // to the confluence tally; a flat consolidation must not fire on heading+tabletop alone.
      if (st.sideEntryLong)  longFacts.push({ strategy: "vector", direction: "Long", kind: "side-entry", weight: s.W_SIDE_ENTRY, driver: true, counted: true, interval: iv, primary: isPrimaryIv, label: `${pfx}SE↑` });
      else if (st.headingLong) longFacts.push({ strategy: "vector", direction: "Long", kind: "heading", weight: s.W_VECTOR_SOFT, driver: false, counted: false, interval: iv, primary: isPrimaryIv, label: `${pfx}→SE↑` });
      if (st.sideEntryShort) shortFacts.push({ strategy: "vector", direction: "Short", kind: "side-entry", weight: s.W_SIDE_ENTRY, driver: true, counted: true, interval: iv, primary: isPrimaryIv, label: `${pfx}SE↓` });
      else if (st.headingShort) shortFacts.push({ strategy: "vector", direction: "Short", kind: "heading", weight: s.W_VECTOR_SOFT, driver: false, counted: false, interval: iv, primary: isPrimaryIv, label: `${pfx}→SE↓` });
      if (st.tabletop && st.tabletopLevel != null) {
        tabletopLevels.push(st.tabletopLevel);
        // A tabletop is a flat-vector LEVEL that anchors TP1 — a LABEL-NOTE ONLY, counted:false
        // (C10). It never adds to the confluence tally, only annotates and anchors the target.
        const fac: Fact = { strategy: "vector", direction: c.close >= st.tabletopLevel ? "Long" : "Short", kind: "tabletop", weight: s.W_VECTOR_SOFT, driver: false, counted: false, interval: iv, primary: isPrimaryIv, level: st.tabletopLevel, label: `${pfx}tabletop @${st.tabletopLevel.toFixed(2)}` };
        (fac.direction === "Long" ? longFacts : shortFacts).push(fac);
      }
    };

    // Primary interval facts (always).
    addVectorFacts(vectorStateAt(primary.candles, primary.vecByTime, i, s), input.primary, true);

    // Secondary interval facts — historically RTH CORROBORATION ONLY (rule 6 / B6). ETH
    // CONFLUENCE (2026-08-11, user repealed the ETH-purity house rule): with the setting ON
    // (default) this block also enumerates on ETH bars, so full confluence signals can fire
    // overnight. Milk-zone reactions inside stay vacuous overnight (zones are dated RTH
    // artifacts). Each secondary bar keeps the LOOKAHEAD guard (B7): it may only corroborate
    // once it has FULLY CLOSED by the primary bar's close (start + its bucket ≤ close).
    if (rth || s.ETH_CONFLUENCE) {
      for (const sec of secondaries) {
        // LOOKAHEAD guard (B7): the newest usable secondary bar is the one whose CLOSE
        // (start + barSec) ≤ the primary bar's close — never a bar still open at that moment.
        let j = asOfIndex(sec.times, closeTime - sec.barSec);
        while (j >= 0 && (sec.candles[j] as any).complete === false) j--;
        if (j < 0) continue;
        addVectorFacts(vectorStateAt(sec.candles, sec.vecByTime, j, s), sec.interval, false);

        // Secondary-interval Yellow Box break — a LABEL-NOTE ONLY (counted:false, never a driver),
        // mirroring tabletops/headings. The SAME day-box break observed on several intervals is ONE
        // piece of evidence, not N: with counted:true a primary break + its own secondary echoes
        // satisfied the ≥2-agreeing-facts rule and fired "Yellowbox-only confluence" at one identical
        // price across intervals (the 253 fabricated fact-engine rows purged 2026-07-14). Same-strategy
        // yellowbox facts now count AT MOST ONCE per direction (the primary one).
        // 2026-09-24 YB_BREAK_EVENT_BARS: the echo is emitted only inside THIS interval's own
        // break-event window (state folded over every closed secondary bar up to j, lazily);
        // afterwards it is omitted — the primary's "beyond box" note already carries the level.
        const yst = ybSecondary.get(sec) as YbBreakState;
        while (yst.cursor < j) {
          yst.cursor++;
          const b = sec.candles[yst.cursor];
          if ((b as any).complete === false) continue;
          ybStep(yst, yst.cursor, b);
        }
        const scb = sec.candles[j];
        const sdz = ybEventLive(yst, j) ? dayZoneAt(scb.time) : null;
        if (sdz) {
          if (scb.close > sdz.boxTop) {
            longFacts.push({ strategy: "yellowbox", direction: "Long", kind: "break", weight: s.W_YELLOWBOX, driver: false, counted: false, interval: sec.interval, primary: false, level: sdz.initRes, label: `${sec.interval} break↑ @${sdz.boxTop.toFixed(2)}` });
          } else if (scb.close < sdz.boxBottom) {
            shortFacts.push({ strategy: "yellowbox", direction: "Short", kind: "break", weight: s.W_YELLOWBOX, driver: false, counted: false, interval: sec.interval, primary: false, level: sdz.initSup, label: `${sec.interval} break↓ @${sdz.boxBottom.toFixed(2)}` });
          }
        }
      }

      // Milk-zone reactions (RTH only — zones are RTH-only). Only dated session zones vote.
      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi];
        if (!(z.fromTime ?? 0) || c.time < (z.fromTime ?? 0) || (z.toTime != null && c.time > z.toTime)) continue;
        const bull = zoneBull[zi];
        const touches = countZoneTouches(primary.candles, i, z, bull, s);
        const rx = detectZoneReaction(c, z, bull, touches, s);
        if (rx) {
          const fac: Fact = {
            strategy: "zone", direction: rx.direction, kind: "reaction",
            weight: rx.strong ? s.W_ZONE_STRONG : s.W_ZONE_NORMAL, driver: true, counted: true, strong: rx.strong,
            interval: input.primary, primary: true,
            level: bull ? z.topPrice : z.bottomPrice,
            label: `${rx.strong ? "strong " : ""}${bull ? "support" : "resistance"} @${(bull ? z.topPrice : z.bottomPrice).toFixed(2)}`,
          };
          (rx.direction === "Long" ? longFacts : shortFacts).push(fac);
        }
      }

      // Footprint imbalance zones — corroborating support/resistance, RTH ONLY (rule 6 / B5), never
      // solo. NO delta logic anywhere (rule 7) — these come from REAL imbalance zones only.
      const fpZones = input.footprintByTime?.get(c.time);
      if (fpZones && fpZones.length) {
        for (const fz of fpZones) {
          const mid = (fz.startPrice + fz.endPrice) / 2;
          if (fz.direction === "buy" && mid <= c.close + 0.5) {
            longFacts.push({ strategy: "footprint", direction: "Long", kind: "support", weight: s.W_FOOTPRINT, driver: false, counted: true, interval: input.primary, primary: true, level: fz.endPrice, label: `support @${mid.toFixed(2)}` });
          } else if (fz.direction === "sell" && mid >= c.close - 0.5) {
            shortFacts.push({ strategy: "footprint", direction: "Short", kind: "resistance", weight: s.W_FOOTPRINT, driver: false, counted: true, interval: input.primary, primary: true, level: fz.startPrice, label: `resistance @${mid.toFixed(2)}` });
          }
        }
      }

      // Yellow Box break (RTH, and ETH under ETH_CONFLUENCE — this whole block's scope). A
      // confirmation candle CLOSING outside the day's box is a PRIMARY driver (conviction ~ a
      // normal milk-zone fact). Solo firing stays gated behind YELLOWBOX_SOLO (default off —
      // full-history solo box-breaks are -EV). That day's initRes/initSup anchors TP1 (below,
      // priority after zones, before tabletops).
      // 2026-09-24 ONE-TIME EVENT (YB_BREAK_EVENT_BARS): counted driver only inside the break
      // event window; afterwards an uncounted, non-driver "beyond box" label-note (kind
      // "beyond") that still anchors TP1 but can never complete confluence — the per-bar STATE
      // re-paired with every fresh fractal breakout for hours (80 of 100 fires on 2026-09-24).
      const pdz = dayZoneAt(c.time);
      if (pdz) {
        const ybLive = ybEventLive(ybPrimary, i);
        if (c.close > pdz.boxTop) {
          longFacts.push(ybLive
            ? { strategy: "yellowbox", direction: "Long", kind: "break", weight: s.W_YELLOWBOX, driver: true, counted: true, interval: input.primary, primary: true, level: pdz.initRes, label: `break↑ @${pdz.boxTop.toFixed(2)}` }
            : { strategy: "yellowbox", direction: "Long", kind: "beyond", weight: s.W_YELLOWBOX, driver: false, counted: false, interval: input.primary, primary: true, level: pdz.initRes, label: `beyond box ↑ @${pdz.boxTop.toFixed(2)}` });
        } else if (c.close < pdz.boxBottom) {
          shortFacts.push(ybLive
            ? { strategy: "yellowbox", direction: "Short", kind: "break", weight: s.W_YELLOWBOX, driver: true, counted: true, interval: input.primary, primary: true, level: pdz.initSup, label: `break↓ @${pdz.boxBottom.toFixed(2)}` }
            : { strategy: "yellowbox", direction: "Short", kind: "beyond", weight: s.W_YELLOWBOX, driver: false, counted: false, interval: input.primary, primary: true, level: pdz.initSup, label: `beyond box ↓ @${pdz.boxBottom.toFixed(2)}` });
        }
      }

      // ── ICT corroborator facts (2026-07-15) — RTH only, primary only, NEVER drivers ──
      // counted:true so they complete the ≥2-agreeing-facts confluence; driver:false so
      // ICT (+fractal) alone can never fire. Kill-zone flag carried in the note (rule 6).
      if (ictOn) {
        const kz = killZoneOf(closeTime);
        const kzTag = kz ? `, ${kz}` : "";
        const ictName: Record<IctEvent["kind"], string> = { sweep: "Sweep", ob: "OB", breaker: "Breaker", fvg: "FVG" };
        for (const ev of ictEventsByBar.get(i) ?? []) {
          const fac: Fact = {
            strategy: "ict", direction: ev.direction, kind: ev.kind,
            weight: s.W_ICT, driver: false, counted: true,
            interval: input.primary, primary: true, level: ev.level,
            label: `ICT ${ictName[ev.kind]}(@${ev.level.toFixed(2)}${kzTag})`,
          };
          (ev.direction === "Long" ? longFacts : shortFacts).push(fac);
        }
      }

      // ── Fractal corroborator facts (2026-07-15) — RTH only, primary only, NEVER drivers ──
      if (frSeries) {
        // Advance the rolling most-recent-breakout state up to this bar.
        while (frBkCursor < frSeries.breakouts.length && frSeries.breakouts[frBkCursor].idx <= i) {
          const e = frSeries.breakouts[frBkCursor++];
          if (e.direction === "Long") lastLongBk = { idx: e.idx, level: e.level };
          else lastShortBk = { idx: e.idx, level: e.level };
        }
        // Williams breakout agreeing within the last FRACTAL_RECENT_BARS bars (one per direction).
        const longBkRecent = i - lastLongBk.idx < s.FRACTAL_RECENT_BARS;
        const shortBkRecent = i - lastShortBk.idx < s.FRACTAL_RECENT_BARS;
        if (longBkRecent) longFacts.push({ strategy: "fractal", direction: "Long", kind: "breakout", weight: s.W_FRACTAL, driver: false, counted: true, interval: input.primary, primary: true, level: lastLongBk.level, label: `Fractal(breakout↑ @${lastLongBk.level.toFixed(2)})` });
        if (shortBkRecent) shortFacts.push({ strategy: "fractal", direction: "Short", kind: "breakout", weight: s.W_FRACTAL, driver: false, counted: true, interval: input.primary, primary: true, level: lastShortBk.level, label: `Fractal(breakout↓ @${lastShortBk.level.toFixed(2)})` });
        // Chaos-band close-outside STATE — SKIPPED while the same-direction breakout fact is
        // attached (the E3 lesson: the same close over the same fractal level is ONE piece of
        // evidence, not two). The band fact takes over from bar FRACTAL_RECENT_BARS onward.
        const ub = frSeries.upper[i], lb = frSeries.lower[i];
        if (ub != null && c.close > ub && !longBkRecent) longFacts.push({ strategy: "fractal", direction: "Long", kind: "band", weight: s.W_FRACTAL, driver: false, counted: true, interval: input.primary, primary: true, level: ub, label: `Fractal(band↑ @${ub.toFixed(2)})` });
        if (lb != null && c.close < lb && !shortBkRecent) shortFacts.push({ strategy: "fractal", direction: "Short", kind: "band", weight: s.W_FRACTAL, driver: false, counted: true, interval: input.primary, primary: true, level: lb, label: `Fractal(band↓ @${lb.toFixed(2)})` });
        // Fractal Chaos Oscillator trending with the signal.
        const v = frSeries.fco[i];
        if (Number.isFinite(v)) {
          if (v >= FRACTAL_DEFAULTS.FCO_TREND_MIN) longFacts.push({ strategy: "fractal", direction: "Long", kind: "fco", weight: s.W_FRACTAL, driver: false, counted: true, interval: input.primary, primary: true, level: null, label: `FCO(+${v.toFixed(2)} trending)` });
          else if (v <= -FRACTAL_DEFAULTS.FCO_TREND_MIN) shortFacts.push({ strategy: "fractal", direction: "Short", kind: "fco", weight: s.W_FRACTAL, driver: false, counted: true, interval: input.primary, primary: true, level: null, label: `FCO(${v.toFixed(2)} trending)` });
        }
        // CHOP states (rule 5 — DOCUMENTED CHOICE): flat boxed chaos bands and/or |FCO| ≤ 0.25
        // each contribute W_FRACTAL_CHOP of CONTRA weight, charged in decide() against sides
        // whose driver is BREAKOUT-TYPE (side-entry / primary yellowbox break). Reversal-type
        // zone reactions are untouched — chop argues against breakouts, not reversals.
        if (s.CHOP_CONTRADICTS) {
          chopContra = (frSeries.chopFCB[i] ? s.W_FRACTAL_CHOP : 0)
            + (Number.isFinite(v) && Math.abs(v) <= FRACTAL_DEFAULTS.FCO_CHOP_MAX ? s.W_FRACTAL_CHOP : 0);
        }
      }

      // ── Fractal-Geometry GUIDE corroborators (2026-07-15) — RTH only, primary only, NEVER
      // drivers. Guide sources documented in shared/fractal-geometry.ts. Event facts (reclaim /
      // flat-bounce / compression / prior-close cross) corroborate for FG_RECENT_BARS bars; the
      // wave-tape "room" state holds while it reads. Chase + exhaustion contribute CONTRA
      // weight (applied in decide() below), never opposing pseudo-facts. ──
      if (fgSeries) {
        const pushFg = (dir: 1 | -1, kind: string, level: number | null, label: string): void => {
          const fac: Fact = {
            strategy: "fractalGeo", direction: dir === 1 ? "Long" : "Short", kind,
            // counted is PER-KIND, data-driven (FG_COUNTED_KINDS — see the calibration note
            // in fractal-geometry.ts): only kinds that beat the window aggregate complete
            // confluence; the rest are label-notes, exactly like tabletops/headings.
            weight: s.W_FRACTAL_GEO, driver: false, counted: FG_COUNTED_KINDS.has(kind),
            interval: input.primary, primary: true, level, label,
          };
          (dir === 1 ? longFacts : shortFacts).push(fac);
        };
        for (const dir of [1, -1] as const) {
          const rIdx = fgRecent(fgSeries.reclaim, i, dir);
          if (rIdx >= 0) pushFg(dir, "reclaim", null, `FG Reclaim(${dir === 1 ? "↑" : "↓"} vector)`);
          const bIdx = fgRecent(fgSeries.flatBounce, i, dir);
          if (bIdx >= 0) pushFg(dir, "flat-bounce", null, `FG FlatBounce(${dir === 1 ? "↑" : "↓"} vector)`);
          const cIdx = fgRecent(fgSeries.compression, i, dir);
          if (cIdx >= 0) pushFg(dir, "compression", null, `FG Compression(release${dir === 1 ? "↑" : "↓"})`);
          const pIdx = fgRecent(fgSeries.priorCloseCross, i, dir);
          if (pIdx >= 0) {
            const e = fgSeries.eVec[i], sv = fgSeries.sVec[i];
            pushFg(dir, "prior-close-cross", dir === 1 ? Math.max(e ?? 0, sv ?? 0) : Math.min(e ?? 0, sv ?? 0),
              `FG PriorClose(cross${dir === 1 ? "↑" : "↓"} E@${e?.toFixed(2) ?? "?"} S@${sv?.toFixed(2) ?? "?"})`);
          }
        }
        const tp = fgSeries.tape[i];
        if (tp && tp.state === "room") pushFg(tp.dir, "wave-room", null, `FG WaveRoom(${tp.extent.toFixed(1)} < med ${tp.median.toFixed(1)})`);
        if (s.FG_CONTRADICTS) {
          // Chase: price expected to return TOWARD the vector — contradicts the side that
          // needs continuation AWAY from it (chase +1 = return UP expected → contra Short).
          const ch = fgSeries.chase[i];
          if (ch === 1) fgContraShort += s.W_FG_CONTRA;
          else if (ch === -1) fgContraLong += s.W_FG_CONTRA;
          // Exhaustion: the current wave is beyond p80 of prior same-direction waves — the
          // videos' tail-band fade ("~80% chance of reversal"): entering WITH the wave here
          // is contradicted regardless of driver type (documented choice; unlike chop, which
          // only argues against breakout drivers).
          if (tp && tp.state === "exhausted") {
            if (tp.dir === 1) fgContraLong += s.W_FG_CONTRA;
            else fgContraShort += s.W_FG_CONTRA;
          }
        }
      }

      // ── PML/TML LIVE-ONLY corroborators (options exposure — no historical data exists).
      // Enumerate ONLY on the live edge (this bar closes within 2 bars of "now"): liveLevels
      // are CURRENT-day levels and must never be applied to historical bars. backtestable:false
      // + the harness never supplies liveLevels ⇒ zero backtest footprint by construction. ──
      const ll = input.liveLevels;
      if (ll && closeTime >= nowSec - 2 * primarySec) {
        if (ll.pml != null) {
          if (c.close > ll.pml) longFacts.push({ strategy: "moneyline", direction: "Long", kind: "pml", weight: s.W_FRACTAL_GEO, driver: false, counted: true, interval: input.primary, primary: true, level: ll.pml, label: `PML(above @${ll.pml.toFixed(2)})`, backtestable: false });
          else if (c.close < ll.pml) shortFacts.push({ strategy: "moneyline", direction: "Short", kind: "pml", weight: s.W_FRACTAL_GEO, driver: false, counted: true, interval: input.primary, primary: true, level: ll.pml, label: `PML(below @${ll.pml.toFixed(2)})`, backtestable: false });
        }
      }
    }

    // ── Decide ───────────────────────────────────────────────────────────────────────────
    const isBreakoutDriven = (facts: Fact[]): boolean => facts.some(f => f.driver && f.counted && f.primary
      && ((f.strategy === "vector" && f.kind === "side-entry") || (f.strategy === "yellowbox" && f.kind === "break")));
    // Chop argues against BREAKOUT drivers only; fractal-geometry chase applies the same way
    // (a chase warns against continuation AWAY from the vector — i.e. breakouts). Wave
    // EXHAUSTION contra (also folded into fgContra*) applies to EVERY driver type — entering
    // with an over-extended wave is the guides' core don't (tail-band fade). Since the chase
    // component is breakout-only and exhaustion is universal, split them: fgContra* here
    // carries exhaustion for all drivers, chase gated on isBreakoutDriven inside the loop
    // above would lose the driver context — so both are charged whenever the side is
    // breakout-driven, and ONLY exhaustion is charged otherwise via the tape check below.
    // Session scope follows the enumeration block (ETH CONFLUENCE 2026-08-11): the exhaustion
    // contra must see the same tape reading the FG facts above were built from.
    const tpNow = rth || s.ETH_CONFLUENCE ? fgSeries?.tape[i] : null;
    const exhLong = s.FG_CONTRADICTS && tpNow?.state === "exhausted" && tpNow.dir === 1 ? s.W_FG_CONTRA : 0;
    const exhShort = s.FG_CONTRADICTS && tpNow?.state === "exhausted" && tpNow.dir === -1 ? s.W_FG_CONTRA : 0;
    const contra = {
      long: (chopContra > 0 && isBreakoutDriven(longFacts) ? chopContra : 0)
        + (isBreakoutDriven(longFacts) ? fgContraLong : exhLong),
      short: (chopContra > 0 && isBreakoutDriven(shortFacts) ? chopContra : 0)
        + (isBreakoutDriven(shortFacts) ? fgContraShort : exhShort),
    };
    const decision = decide(longFacts, shortFacts, rth, s, contra);
    if (!decision) {
      // ETH_MIN_AGREEING_FACTS reporting: would the RTH/default threshold have qualified a side?
      if (stats && !rth && ethMinDiffers
        && decide(longFacts, shortFacts, rth, { ...s, ETH_MIN_AGREEING_FACTS: s.MIN_AGREEING_FACTS }, contra)) {
        stats.ethMinFactsSuppressed++;
      }
      continue;
    }
    const { direction, facts } = decision;

    // QUALITY GATE (the final firing filter — user directive "quality over quantity"): a
    // blocked class emits NOTHING (not even a note) and never consumes cooldown — an invisible
    // signal must not suppress a later allowed one. signalType/confidence via the SHARED
    // helpers so the gate sees exactly what would be emitted.
    const signalType = signalTypeOf(facts, rth);
    const countedFactsN = facts.filter(f => f.counted).length;
    if (gateOn && !qualityGateAllows(signalType, input.primary, countedFactsN, gateData)) continue;

    // COMBO GATE (2026-07-29 — "only take the historically winning fact-combinations"): the
    // signal's counted fact FAMILIES form a canonical combo key (comboKeyOf — the SHARED
    // helper the harness derivation uses too); an explicitly blocked combo emits NOTHING,
    // exactly like a blocked class (silent, before the cooldown cursor). Applies EVEN to
    // >=3-counted-fact signals — the multi-fact override bypasses the CLASS gate only
    // (Fr+ICT+Vec+YB is a 4-fact historical loser). Absent/thin combos always pass.
    // EXEMPT (structural rules, zero backtest data classes): zone-reaction (strong milk-zone
    // solo) and ETH solo vector-side-entry.
    const combo = comboKeyOf(facts); // shared canonical key — also selects the per-combo exit below
    if (gateOn && signalType !== "zone-reaction" && signalType !== "vector-side-entry"
      && !comboGateAllows(combo, input.primary, gateData)) continue;

    // GLOBAL cooldown (D13): one cursor for BOTH directions on this interval.
    if (i - lastFireBar < s.COOLDOWN_BARS) continue;

    // ONE OPEN TRADE PER DIRECTION (2026-09-24): a same-direction trade that has not touched
    // TP1/SL by this bar's close blocks the fire — silently, before the cursor is consumed.
    if (s.ONE_OPEN_PER_DIRECTION && openUntil[direction] > closeTime) continue;

    // HOD/LOD entry suppression (no room into the ceiling/floor).
    if (direction === "Long" && rth && prevHodHigh > -Infinity && c.close >= prevHodHigh - s.HOD_LOD_PROX_PTS && c.close < prevHodHigh) continue;
    if (direction === "Short" && rth && prevHodLow < Infinity && c.close > prevHodLow && c.close <= prevHodLow + s.HOD_LOD_PROX_PTS) continue;

    // Exit geometry + room check. The COMBO's Monte-Carlo calibration (quality-gate.ts
    // exitByCombo) wins over the class's (exitByClass); both replace the provisional
    // DEFAULT_TP1/SL; caller-explicit input.exit wins over everything.
    const exitCal = resolveExitCalibration(signalType, input.primary, combo, exit, input.exit, gateData);
    // R4 shadow rule (2026-10-01, default off → the same object): per-interval TP1 floor.
    const exitEff = exitWithIntervalFloor(exitCal, s, input.primary);
    const counted = facts.filter(f => f.counted);
    const soloYb = counted.length === 1 && counted[0].strategy === "yellowbox";
    const ybFactPresent = facts.some(f => f.strategy === "yellowbox");
    const fireDz = dayZoneAt(c.time);

    let tp1: number, tp2: number, sl: number, anchorKind: ExitAnchor;
    let nearestObstacleDist: number | null = null; // shadow tag "1m-anchor-under-12.25"
    if (soloYb && fireDz) {
      // Solo yellowbox-break geometry: TP1 = init res/sup (Milk's first target), SL = opposite box edge.
      if (direction === "Long") { tp1 = fireDz.initRes; sl = fireDz.boxBottom; }
      else { tp1 = fireDz.initSup; sl = fireDz.boxTop; }
      if ((direction === "Long" && tp1 <= c.close) || (direction === "Short" && tp1 >= c.close)) continue; // no room to TP1
      const tp1Dist = Math.abs(tp1 - c.close);
      tp2 = direction === "Long" ? c.close + tp1Dist * exitEff.TP2_MULT : c.close - tp1Dist * exitEff.TP2_MULT;
      anchorKind = "yellowbox";
    } else {
      // Standard geometry. When a yellowbox fact participated, its initRes(long)/initSup(short) joins
      // the TP1 anchor candidate set (priority after milk-zone edges, before tabletops).
      const ybAnchors: number[] = (ybFactPresent && fireDz) ? [direction === "Long" ? fireDz.initRes : fireDz.initSup] : [];
      const ex = computeExit(direction, c.close, zones, zoneBull, tabletopLevels, c.time, exitEff, ybAnchors);
      if (ex.blocked) { // no clear path to TP1
        if (stats && exitEff !== exitCal && !computeExit(direction, c.close, zones, zoneBull, tabletopLevels, c.time, exitCal, ybAnchors).blocked) {
          countShadowRule(stats, "MIN_TP1_PTS_BY_INTERVAL");
        }
        continue;
      }
      tp1 = ex.tp1; tp2 = ex.tp2; sl = ex.sl; anchorKind = ex.anchor;
      nearestObstacleDist = ex.nearestDist ?? null;
    }

    // RISK DISPLAY (2026-07-30) flags — pure; computed here (was after the walk) because the
    // 2026-10-01 BLOCK_TIGHT_ROOM_INTERVALS setting reads "tight-room". Default settings never
    // read them, so firing is unchanged.
    const riskFlags = computeRiskFlags({
      combo, entryTime: closeTime, direction, entry: c.close, tp1,
      dayZone: fireDz,
      dayRangeSoFar: sdHigh > -Infinity && sdLow < Infinity ? sdHigh - sdLow : null,
      dayRangeMedian: input.dayRangeMedian ?? null,
    });
    // SHADOW RULES (2026-10-01, all default OFF): R1 box side / R2 range floor / range cap /
    // R3 tight-room — silent like a gate block (no note, cooldown cursor + open-trade state
    // untouched). The SAME context feeds the record-only shadow tags on the emitted fire.
    const shadowCtx: ShadowRuleContext = {
      interval: input.primary, direction, close: c.close, dayZone: fireDz,
      dayRangeSoFar: sdHigh > -Infinity && sdLow < Infinity ? sdHigh - sdLow : null,
      dayRangeMedian: input.dayRangeMedian ?? null,
      riskFlags, nearestObstacleDist,
    };
    const shadowBlocked = shadowRuleBlock(s, shadowCtx);
    if (shadowBlocked) { countShadowRule(stats, shadowBlocked); continue; }

    // SHADOW-TEST SUPPRESSIONS (2026-10-01 — both default OFF): silent like a gate block (no
    // note, cooldown cursor + open-trade state untouched). Placed AFTER every other gate so
    // the statsOut counts are fires that would otherwise have been emitted by this run; the
    // fire set itself is position-independent (every check above is a pure `continue`).
    if (isEthFractalTwoFactVeto(facts, rth, input.primary, s)) {
      if (stats) stats.ethFractalVetoSuppressed++;
      continue;
    }
    const blackout = newsBlackoutAt(input.newsBlackouts, closeTime);
    if (blackout != null) {
      if (stats) {
        stats.newsBlackoutSuppressed++;
        stats.newsBlackoutByLabel[blackout] = (stats.newsBlackoutByLabel[blackout] ?? 0) + 1;
      }
      continue;
    }

    const { outcome, toTime, exit: exitDetail } = walkForward(pc, i, tp1, tp2, sl, direction === "Long", nowSec, primarySec, fineWalkBars, fineWalkSec, s.TP1_ONLY);

    lastFireBar = i;
    // Open-trade state for ONE_OPEN_PER_DIRECTION: this fire's own canonical walk (the same
    // record the row persists) — open at the horizon = blocks every later same-direction bar.
    {
      const ex = outcome === "open" || exitDetail.exitTs == null ? Infinity : exitDetail.exitTs;
      if (ex > openUntil[direction]) openUntil[direction] = ex;
    }

    // Confidence — SHARED helper (also used by evaluateFormingBar); signalType was computed
    // above (before the quality gate) via the shared signalTypeOf.
    const confidence = confidenceOf(facts);

    out.push({
      time: c.time, interval: input.primary, direction,
      price: c.close, high: c.high, low: c.low,
      tp1, tp2: s.TP1_ONLY ? null : tp2, sl, toTime, session,
      outcome, facts, label: buildLabel(facts), confidence, signalType,
      comboKey: combo, riskFlags,
      shadowTags: computeShadowTags(shadowCtx), // 2026-10-01 record-only
      // POSITION SIZING (2026-08-02 — display/config-only): tier-derived suggested size.
      suggestedContracts: suggestedContractsFor(combo, input.primary, gateData),
      confirmations: JSON.stringify({
        facts: facts.map(f => ({ s: f.strategy, d: f.direction, k: f.kind, lvl: f.level ?? null })),
        anchor: anchorKind, session,
      }),
      // BACKTEST-GRADE EXIT DETAIL (2026-07-29): persisted so live-fired rows carry the same
      // per-trade detail as --persist rows (all null while the trade is open).
      exitPrice: exitDetail.exitPrice, exitTs: exitDetail.exitTs, pointsResult: exitDetail.pointsResult,
      mae: exitDetail.mae, mfe: exitDetail.mfe, barsToExit: exitDetail.barsToExit, eodClose: exitDetail.eodClose,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

// ═════════════════════════════════════════════════════════════════════════════
// evaluateFormingBar — THE intra-candle evaluation path (C8), IN the engine (B1 fix 2026-07-14).
// market.tsx is a thin caller: it marshals the forming primary bar + closed bars + zones +
// real footprint zones and hands them here. This shares the EXACT gate / decide / HOD-LOD /
// exit / label / signal-type / confidence code paths with the bar-close loop above, so a
// forming-bar signal can never carry different semantics than the same bar would get at close.
//
// Rules enforced here (identical to the loop):
//  • ALL session gates evaluate at the forming bar's SCHEDULED CLOSE (time + barSec): RTH-only
//    (zone reactions are the only intra-candle-eligible facts and zones are RTH-only), the
//    17:00–18:00 break, and the 15:15 cutoff — a bar that will close ≥15:15 can never fire intra.
//  • Cooldown: the caller passes `lastFireTime` = the most recent fire on this interval —
//    INCLUDING previously fired intra-candle signals — and no fire happens within
//    COOLDOWN_BARS × barSec of it.
//  • One open trade per direction (2026-09-24): the caller passes `openTrades` (latest bracket
//    per direction, mirroring lastFireTime); an unresolved same-direction bracket = no fire.
//  • decide() must select a fact set CONTAINING a zone fact (C8 is the zone-reaction intra path;
//    vector/yellowbox facts only exist at bar close).
//  • HOD/LOD suppression over TODAY's closed RTH bars, same predicate as the loop.
//  • Exit geometry via computeExit (room check blocks), label via buildLabel, type/confidence
//    via signalTypeOf/confidenceOf — the shared helpers.
// Cancellation stays architectural in the caller: the memo recomputes on every live bar update,
// so a failed reaction vanishes from the next recompute (and B2 retracts the persisted row).
// ═════════════════════════════════════════════════════════════════════════════
export interface FormingBarInput {
  interval: Interval;
  formingBar: FiringCandle;           // live OHLC snapshot of the forming primary bar
  closedCandles: FiringCandle[];      // primary interval's CLOSED bars, ascending by time
  zones: FiringZone[];                // uploaded milk zones (activeZones)
  footprintZones?: FpImbalanceZone[]; // REAL imbalance zones at the forming bar's time (C12)
  lastFireTime?: number;              // most recent fire on this interval (engine OR prior intra)
  /** ONE_OPEN_PER_DIRECTION (2026-09-24), mirroring lastFireTime: per direction, the most
   *  recent fire on this interval (engine OR prior intra) as its bracket. The engine resolves it
   *  itself with the canonical resolver over closedCandles + the forming bar's extremes so far
   *  (tp1Only, carry-overnight, same-bar TP+SL = loss); while it has touched neither TP1 nor SL,
   *  no forming-bar fire in that direction. Callers may pass the latest fire regardless of its
   *  stored outcome — a resolved bracket simply does not block. Absent = no open trade. */
  openTrades?: Partial<Record<FactDirection, OpenTradeBracket>>;
  settings?: Partial<FactEngineSettings>;
  exit?: Partial<ExitCalibration>;
  qualityGateEnabled?: boolean;       // DATA-DRIVEN quality gate (default ON) — same as runFactEngine
  gateData?: QualityGateData;         // test/harness override of the generated gate config
  // RISK DISPLAY (2026-07-30 — display-only, both optional/graceful): the day-zones list (the
  // tight-room flag needs the fire day's box/init levels) + the window median day range (the
  // dead-tape baseline), same semantics as FactEngineInput. Absent → those flags never compute.
  dayZones?: YellowboxDayZone[];
  dayRangeMedian?: number;
  /** DEAD-TAPE SUPPRESSION + DAILY LOSS STOP (2026-08-02) — identical semantics to
   *  FactEngineInput; the forming bar is ALWAYS in the current session, so a tripped loss
   *  stop silences this path entirely. */
  deadTapeSuppressEnabled?: boolean;
  /** FAIL-CLOSED on a missing dead-tape baseline — same contract as FactEngineInput. */
  deadTapeFailClosed?: boolean;
  dayPnlPts?: number | null;
  dailyLossStopPts?: number;
  /** LOSS-STREAK STOP — same contract as FactEngineInput (forming bar = current session). */
  dayLossStreak?: number | null;
  streakStopLosses?: number;
}
export function evaluateFormingBar(input: FormingBarInput): FactSignal | null {
  const s = resolveEngineSettings(input.settings);
  const exit = { ...EXIT_CALIBRATION, ...(input.exit ?? {}) };
  const gateOn = input.qualityGateEnabled !== false; // DEFAULT ON
  const gateData = input.gateData ?? QUALITY_GATE;
  const { formingBar, closedCandles, zones } = input;
  const barSec = INTERVAL_SEC[input.interval];
  if (!barSec || !zones.length) return null;

  // Session gates at the SCHEDULED close (rule 11 / D16) — identical to the bar-close loop.
  const closeTime = formingBar.time + barSec;
  if (!isRTH(closeTime)) return null;        // intra-candle zone reactions are RTH-only
  if (isMarketBreak(closeTime)) return null; // 5:00–6:00 PM ET settlement halt
  if (isAfter315ET(closeTime)) return null;  // no new signals ≥ 3:15 PM ET (at close)

  // Cooldown vs the last fire — the caller includes previously fired INTRA signals.
  if (input.lastFireTime != null && formingBar.time - input.lastFireTime < s.COOLDOWN_BARS * barSec) return null;

  // DAILY LOSS STOP (2026-08-02): the forming bar IS the current session — tripped = silent.
  const lossStopPts = input.dailyLossStopPts ?? 0;
  if (lossStopPts > 0 && input.dayPnlPts != null && Number.isFinite(input.dayPnlPts)
    && input.dayPnlPts <= -lossStopPts) return null;

  // LOSS-STREAK STOP (2026-08-10): the forming bar IS the current session — tripped = silent.
  const streakStopN = input.streakStopLosses ?? 0;
  if (streakStopN > 0 && input.dayLossStreak != null && Number.isFinite(input.dayLossStreak)
    && input.dayLossStreak >= streakStopN) return null;

  // Session-day running range — computed HERE (was riskFlags-only) because the 2026-08-02
  // dead-tape ENFORCEMENT needs it before any fact work: today's CLOSED bars (reverse scan,
  // current session day only, 18:00 ET roll) + the forming bar's own extremes so far.
  const sdB = etSessionDayBucket(formingBar.time);
  let sdHigh = formingBar.high, sdLow = formingBar.low;
  // Session OPEN (2026-08-12 directionality exemption): the earliest same-session closed
  // bar's open — falls back to the forming bar's own open on a fresh session.
  let fbSdOpen = formingBar.open;
  for (let k = input.closedCandles.length - 1; k >= 0; k--) {
    const cb = input.closedCandles[k];
    if (etSessionDayBucket(cb.time) !== sdB) break;
    if (cb.high > sdHigh) sdHigh = cb.high;
    if (cb.low < sdLow) sdLow = cb.low;
    fbSdOpen = cb.open; // keeps updating until the scan crosses the session boundary
  }
  const sdRangeSoFar = Number.isFinite(sdHigh) && Number.isFinite(sdLow) && sdHigh > sdLow ? sdHigh - sdLow : null;

  // DEAD-TAPE SUPPRESSION (2026-08-02 — same predicate + escape hatch as the bar-close loop).
  // FAIL-CLOSED (2026-08-07): enforcement requested + baseline missing → no forming-bar fire.
  const fbMedianOk = input.dayRangeMedian != null && input.dayRangeMedian > 0;
  if (input.deadTapeFailClosed && input.deadTapeSuppressEnabled !== false && !fbMedianOk) return null;
  if (input.deadTapeSuppressEnabled !== false && fbMedianOk
    && sdRangeSoFar != null && sdRangeSoFar > 0
    && sdRangeSoFar < DEAD_TAPE_SUPPRESS_MULT * (input.dayRangeMedian as number)) {
    // DIRECTIONALITY EXEMPTION (2026-08-12, SHIPPED — identical to the bar-close loop,
    // including the analysis mutator so sweeps/fixtures can disable it symmetrically):
    // quiet-but-TRENDING (drift ≥ DEAD_TAPE_DIR_EXEMPT × range so far) fires through.
    const fbDrift = Math.abs(formingBar.close - fbSdOpen);
    if (!(deadTapeDirExempt != null && fbDrift >= deadTapeDirExempt * sdRangeSoFar)) return null;
  }

  // ── Enumerate facts on the forming bar (zone reactions + real footprint corroboration) ──
  const zoneBull = zones.map(z => classifyZoneBullish(z));
  const longFacts: Fact[] = [];
  const shortFacts: Fact[] = [];
  for (let zi = 0; zi < zones.length; zi++) {
    const z = zones[zi];
    if (!(z.fromTime ?? 0) || formingBar.time < (z.fromTime ?? 0) || (z.toTime != null && formingBar.time > z.toTime)) continue;
    const bull = zoneBull[zi];
    const touches = countZoneTouches(closedCandles, closedCandles.length, z, bull, s);
    const rx = detectZoneReaction(formingBar, z, bull, touches, s);
    if (rx) {
      const fac: Fact = {
        strategy: "zone", direction: rx.direction, kind: "reaction",
        weight: rx.strong ? s.W_ZONE_STRONG : s.W_ZONE_NORMAL, driver: true, counted: true, strong: rx.strong,
        interval: input.interval, primary: true,
        level: bull ? z.topPrice : z.bottomPrice,
        label: `${rx.strong ? "strong " : ""}${bull ? "support" : "resistance"} @${(bull ? z.topPrice : z.bottomPrice).toFixed(2)}`,
      };
      (rx.direction === "Long" ? longFacts : shortFacts).push(fac);
    }
  }
  // Real footprint corroboration only (C12) — absent data means no fact.
  for (const fz of input.footprintZones ?? []) {
    const mid = (fz.startPrice + fz.endPrice) / 2;
    if (fz.direction === "buy" && mid <= formingBar.close + 0.5) {
      longFacts.push({ strategy: "footprint", direction: "Long", kind: "support", weight: s.W_FOOTPRINT, driver: false, counted: true, interval: input.interval, primary: true, level: fz.endPrice, label: `support @${mid.toFixed(2)}` });
    } else if (fz.direction === "sell" && mid >= formingBar.close - 0.5) {
      shortFacts.push({ strategy: "footprint", direction: "Short", kind: "resistance", weight: s.W_FOOTPRINT, driver: false, counted: true, interval: input.interval, primary: true, level: fz.startPrice, label: `resistance @${mid.toFixed(2)}` });
    }
  }

  // ── Decide — SAME rules; must include a zone fact (C8 is the zone intra path). ──
  const dec = decide(longFacts, shortFacts, true, s);
  if (!dec || !dec.facts.some(f => f.strategy === "zone")) return null;

  // QUALITY GATE — identical final filter to the bar-close loop (a blocked class emits nothing).
  const signalType = signalTypeOf(dec.facts, true);
  const countedFactsN = dec.facts.filter(f => f.counted).length;
  if (gateOn && !qualityGateAllows(signalType, input.interval, countedFactsN, gateData)) return null;

  // COMBO GATE — identical consult to the bar-close loop (same exemptions; this path is
  // RTH-only so the vector-side-entry exemption is vacuous here, kept for symmetry).
  const combo = comboKeyOf(dec.facts); // shared canonical key — also selects the per-combo exit below
  if (gateOn && signalType !== "zone-reaction" && signalType !== "vector-side-entry"
    && !comboGateAllows(combo, input.interval, gateData)) return null;

  // ONE OPEN TRADE PER DIRECTION (2026-09-24) — same rule as the bar-close loop: the caller's
  // latest same-direction bracket, resolved over the closed bars + the forming bar so far.
  const ot = input.openTrades?.[dec.direction];
  if (s.ONE_OPEN_PER_DIRECTION && ot && Number.isFinite(ot.firedAt)) {
    // The forming bar's extremes SO FAR deliberately count here (documented gate semantics above), so
    // it is appended WITHOUT its complete:false flag — the canonical resolver stops a RECORD walk at a
    // flagged forming bar (2026-10-01, ticket 12b), and this gate is not a record.
    const { complete: _formingFlag, ...soFar } = formingBar as FiringCandle & { complete?: boolean };
    const bars = closedCandles.length && closedCandles[closedCandles.length - 1].time >= formingBar.time
      ? closedCandles.filter(b => b.time < formingBar.time).concat([soFar as FiringCandle])
      : closedCandles.concat([soFar as FiringCandle]);
    const exitTs = bracketExitTs(bars, barSec, ot.firedAt, ot.entry, ot.tp1, ot.sl, dec.direction === "Long",
      formingBar.time + barSec, s.TP1_ONLY);
    if (exitTs === Infinity) return null;
  }

  // HOD/LOD entry suppression over TODAY's closed RTH bars (same predicate as the loop).
  const dayKey = Math.floor(formingBar.time / 86400);
  let hod = -Infinity, lod = Infinity;
  for (const c of closedCandles) {
    if (Math.floor(c.time / 86400) !== dayKey) continue;
    if (!isRTH(c.time + barSec)) continue; // RTH at close — same fold rule as the loop
    if (c.high > hod) hod = c.high;
    if (c.low < lod) lod = c.low;
  }
  if (dec.direction === "Long" && hod > -Infinity && formingBar.close >= hod - s.HOD_LOD_PROX_PTS && formingBar.close < hod) return null;
  if (dec.direction === "Short" && lod < Infinity && formingBar.close > lod && formingBar.close <= lod + s.HOD_LOD_PROX_PTS) return null;

  // Exit geometry + room check (no tabletop/yellowbox anchors — those facts are bar-close-only).
  // Per-combo > per-class Monte-Carlo exit calibration applies exactly as in the bar-close loop.
  const exitEff = exitWithIntervalFloor( // R4 shadow rule (2026-10-01, default off → same object)
    resolveExitCalibration(signalType, input.interval, combo, exit, input.exit, gateData), s, input.interval);
  const ex = computeExit(dec.direction, formingBar.close, zones, zoneBull, [], formingBar.time, exitEff);
  if (ex.blocked) return null;

  // RISK DISPLAY (2026-07-30 — display-only, same helper as the bar-close loop). The running
  // session-day range was computed ABOVE (sdRangeSoFar — it now also feeds the dead-tape
  // enforcement). Day-zone lookup mirrors runFactEngine's dayZoneAt.
  let fireDz: YellowboxDayZone | null = null;
  for (const z of input.dayZones ?? []) {
    if (formingBar.time >= z.sessionStartTs && formingBar.time <= z.sessionEndTs) { fireDz = z; break; }
  }
  const riskFlags = computeRiskFlags({
    combo, entryTime: closeTime, direction: dec.direction, entry: formingBar.close, tp1: ex.tp1,
    dayZone: fireDz,
    dayRangeSoFar: sdRangeSoFar,
    dayRangeMedian: input.dayRangeMedian ?? null,
  });
  // SHADOW RULES + TAGS (2026-10-01) — same predicates as the bar-close loop. The range here is
  // the running session range incl. the forming bar (0 when every bar so far is flat).
  const shadowCtx: ShadowRuleContext = {
    interval: input.interval, direction: dec.direction, close: formingBar.close, dayZone: fireDz,
    dayRangeSoFar: Number.isFinite(sdHigh) && Number.isFinite(sdLow) ? sdHigh - sdLow : null,
    dayRangeMedian: input.dayRangeMedian ?? null,
    riskFlags, nearestObstacleDist: ex.nearestDist ?? null,
  };
  if (shadowRuleBlock(s, shadowCtx)) return null;

  return {
    time: formingBar.time, interval: input.interval, direction: dec.direction,
    price: formingBar.close, high: formingBar.high, low: formingBar.low,
    tp1: ex.tp1, tp2: s.TP1_ONLY ? null : ex.tp2, sl: ex.sl, toTime: closeTime, session: "RTH",
    outcome: "open", facts: dec.facts, label: buildLabel(dec.facts),
    confidence: confidenceOf(dec.facts),
    signalType,
    comboKey: combo, riskFlags,
    shadowTags: computeShadowTags(shadowCtx), // 2026-10-01 record-only
    // POSITION SIZING (2026-08-02): identical derivation to the bar-close loop.
    suggestedContracts: suggestedContractsFor(combo, input.interval, gateData),
    confirmations: JSON.stringify({
      facts: dec.facts.map(f => ({ s: f.strategy, d: f.direction, k: f.kind, lvl: f.level ?? null })),
      anchor: ex.anchor, session: "RTH", intraCandle: true,
    }),
  };
}

/** The FIRE decision over the enumerated facts. Returns the winning direction + its facts, or
 *  null to fire nothing. Encapsulates: solo eligibility, ≥2-agreeing-with-a-driver, and the
 *  heavy-contradiction stalemate. Never returns opposing directions on the same candle.
 *
 *  `contra` (2026-07-15, the CHOP rule — documented design choice): extra CONTRADICTING weight
 *  charged against each direction that is NOT carried by a directional fact — today only the
 *  fractal CHOP states (flat chaos bands / |FCO| ≤ 0.25), weight-1 each, charged against sides
 *  whose driver is BREAKOUT-TYPE (primary side-entry / primary yellowbox break). To give that
 *  rule effect, the CONTRADICTION_MARGIN check now ALSO applies when only ONE side qualifies:
 *  the winner's counted weight must beat (opposing counted weight + contra) by ≥ the margin,
 *  else nothing fires. With no opposition and no chop this changes nothing (every qualifying
 *  side weighs ≥ 2 = the margin); it lets accumulated contradiction kill marginal breakouts. */
export function decide(
  longFacts: Fact[],
  shortFacts: Fact[],
  rth: boolean,
  s: FactEngineSettings,
  contra: { long: number; short: number } = { long: 0, short: 0 },
): { direction: FactDirection; facts: Fact[] } | null {
  // Only COUNTED facts (side-entry / zone reaction / footprint) form the confluence tally and the
  // contradiction weight — tabletops (C10) and headings (C11) are label-notes, excluded here.
  const qualifies = (facts: Fact[]): boolean => {
    const counted = facts.filter(f => f.counted);
    if (!counted.length) return false;
    const strongZone = rth && counted.some(f => f.strategy === "zone" && f.strong);
    if (strongZone) return true;                                     // solo: strong milk-zone reaction (RTH)
    const yellowboxSolo = rth && s.YELLOWBOX_SOLO && counted.some(f => f.strategy === "yellowbox" && f.primary);
    if (yellowboxSolo) return true;                                  // solo: primary yellowbox break, gated by the setting (RTH)
    const ethSoloSideEntry = !rth && counted.some(f => f.strategy === "vector" && f.kind === "side-entry" && f.primary);
    if (ethSoloSideEntry) return true;                               // solo: PRIMARY vector side-entry in ETH
    const drivers = counted.filter(f => f.driver).length;           // side-entry / zone reaction
    // ETH bars use ETH_MIN_AGREEING_FACTS (2026-10-01 shadow setting; default = MIN_AGREEING_FACTS).
    return counted.length >= minAgreeingFactsFor(rth, s) && drivers >= 1;   // footprint/tabletop/heading never solo
  };
  const weightOf = (facts: Fact[]) => facts.filter(f => f.counted).reduce((a, f) => a + f.weight, 0);

  const lq = qualifies(longFacts);
  const sq = qualifies(shortFacts);
  if (!lq && !sq) return null;
  // C9 / rule 2 — SECONDARIES MAY NEVER VETO THE PRIMARY: when one side carries a PRIMARY vector
  // side-entry driver, the OPPOSING side's SECONDARY vector facts are stripped from the weight
  // comparison. Only non-vector facts and primary-interval drivers can create a real stalemate.
  const longHasPrimaryDriver = longFacts.some(f => f.strategy === "vector" && f.kind === "side-entry" && f.primary);
  const shortHasPrimaryDriver = shortFacts.some(f => f.strategy === "vector" && f.kind === "side-entry" && f.primary);
  // Opposing SECONDARY vector AND secondary yellowbox facts are stripped from the weight comparison
  // (they may never veto a primary side-entry driver — rule C9 + the yellowbox secondary rule).
  const stripSecondary = (facts: Fact[], opposingHasPrimaryDriver: boolean) =>
    opposingHasPrimaryDriver ? facts.filter(f => !((f.strategy === "vector" || f.strategy === "yellowbox") && !f.primary)) : facts;
  const wl = weightOf(stripSecondary(longFacts, shortHasPrimaryDriver)) - contra.long;
  const ws = weightOf(stripSecondary(shortFacts, longHasPrimaryDriver)) - contra.short;
  if (lq && sq) {
    // Contradictions: heavier side wins; a near-tie is a heavy contradiction → fire nothing.
    // Effective weights include the chop contra charged against each side.
    if (Math.abs(wl - ws) < s.CONTRADICTION_MARGIN) return null;
    return wl > ws ? { direction: "Long", facts: longFacts } : { direction: "Short", facts: shortFacts };
  }
  // ONE-SIDED margin check (2026-07-15 — gives the chop rule + opposing corroborators teeth):
  // the qualifying side must beat the non-qualifying opposition's counted weight PLUS its own
  // chop contra by ≥ CONTRADICTION_MARGIN. Opposing ICT/fractal facts weigh in here at their
  // weight (rule 4); with zero opposition and zero chop the check is always satisfied.
  if (lq) return wl - weightOf(stripSecondary(shortFacts, longHasPrimaryDriver)) >= s.CONTRADICTION_MARGIN - 1e-9
    ? { direction: "Long", facts: longFacts } : null;
  return ws - weightOf(stripSecondary(longFacts, shortHasPrimaryDriver)) >= s.CONTRADICTION_MARGIN - 1e-9
    ? { direction: "Short", facts: shortFacts } : null;
}
