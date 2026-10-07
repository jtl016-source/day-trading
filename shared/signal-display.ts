// shared/signal-display.ts
// ─────────────────────────────────────────────────────────────────────────────
// USER-FACING DISPLAY NAMES for internal signal identifiers (2026-07-14 user rule:
// NO internal jargon anywhere the user reads — he flagged "fact-engine" specifically).
//
// The INTERNAL strings ("fact-engine", "vector-side-entry", "tp1", "sl", "vector;yellowbox",
// …) stay unchanged everywhere data lives: signal_history rows, shared/signal-rules.ts
// validation, server/signal-guard.ts, the engine, and the backtest JSON/CSV. This module is
// the SINGLE mapping consulted by everything that renders those strings to the user — the
// Excel workbook (scripts/fact-engine-backtest.ts) AND the UI (SignalsView / SignalDetail /
// SignalsPanel / notifications / Discord messages). Add new identifiers HERE first.
// ─────────────────────────────────────────────────────────────────────────────

/** signalType → user-facing name. */
export const SIGNAL_TYPE_DISPLAY: Record<string, string> = {
  "fact-engine": "Multi-Strategy Confluence (2+ facts)",
  "vector-side-entry": "Vector Side-Entry",
  "yellowbox-break": "Yellow Box Break",
  "zone-reaction": "Milk Zone Reaction",
};

/** Short variant for tight UI chips / chart badges (still jargon-free). */
export const SIGNAL_TYPE_DISPLAY_SHORT: Record<string, string> = {
  "fact-engine": "Confluence",
  "vector-side-entry": "Vector Side-Entry",
  "yellowbox-break": "Yellow Box Break",
  "zone-reaction": "Zone Reaction",
};

export function displaySignalType(signalType: string | null | undefined, short = false): string {
  if (!signalType) return "Signal";
  return (short ? SIGNAL_TYPE_DISPLAY_SHORT : SIGNAL_TYPE_DISPLAY)[signalType] ?? signalType;
}

/** One plain sentence per signal type — used by the workbook README glossary and Info UIs. */
export const SIGNAL_TYPE_GLOSSARY: Record<string, string> = {
  "fact-engine":
    "Multi-Strategy Confluence: two or more independent strategies agreed on the same direction at the same time — the exact facts are listed in the WHY IT FIRED column.",
  "vector-side-entry":
    "Vector Side-Entry: price broke out of a sideways shelf across the vector line (overnight/ETH these fire on their own; during market hours they need a second agreeing strategy).",
  "yellowbox-break":
    "Yellow Box Break: a candle closed outside the day's calibrated Yellow Box range (only fires alone when the Yellow-Box-solo setting is switched on).",
  "zone-reaction":
    "Milk Zone Reaction: price wick-touched an uploaded Milk zone and snapped away hard — a strong reaction can fire on its own during market hours.",
};

/** fact strategy key → user-facing name. */
export const STRATEGY_DISPLAY: Record<string, string> = {
  vector: "Vector",
  zone: "Milk Zone",
  yellowbox: "Yellow Box",
  footprint: "Footprint",
  ict: "ICT",
  fractal: "Fractal",
  fractalGeo: "Fractal Geometry",
  moneyline: "Money Line",
};

/** CONFIRMATION-fact kinds (2026-07-15: ICT + fractal corroborators) → user-facing names.
 *  Keyed `<strategy>-<kind>` exactly as the engine emits them. These are confirmations that
 *  back up the user's existing strategies — never standalone signals. */
export const CONFIRMATION_FACT_DISPLAY: Record<string, string> = {
  "ict-sweep": "ICT Liquidity Sweep",
  "ict-ob": "ICT Order Block",
  "ict-breaker": "ICT Breaker Block",
  "ict-fvg": "ICT Fair Value Gap",
  "fractal-breakout": "Fractal Breakout",
  "fractal-band": "Fractal Band Break",
  "fractal-fco": "Fractal Trend (Chaos Oscillator)",
  "fractal-chop": "Fractal Chop (contradiction)",
  // Fractal-Geometry GUIDE confirmations (2026-07-15 study mission)
  "fractalGeo-reclaim": "Vector Reclaim (failed break reversed)",
  "fractalGeo-flat-bounce": "Flat-Vector Bounce",
  "fractalGeo-compression": "Compression Breakout",
  "fractalGeo-wave-room": "Wave Has Room To Run",
  "fractalGeo-prior-close-cross": "Cross of Yesterday's Closes",
  // LIVE-ONLY money-line context (options exposure; never in backtests)
  "moneyline-pml": "Peak Money Line Side (live options data)",
  // 2026-09-24 (YB_BREAK_EVENT_BARS): price still beyond the day's Yellow Box AFTER the break
  // event window — a note only (never counted toward confluence, never a driver).
  "yellowbox-beyond": "Still Beyond Yellow Box (earlier break — note only)",
};

export function displayConfirmationFact(strategy: string, kind: string): string {
  return CONFIRMATION_FACT_DISPLAY[`${strategy}-${kind}`] ?? `${displayStrategy(strategy)} ${kind}`;
}

export function displayStrategy(key: string): string {
  return STRATEGY_DISPLAY[key] ?? key;
}

/** "vector;yellowbox;footprint" → "Vector + Yellow Box + Footprint". */
export function displayStrategyCombo(combo: string | null | undefined): string {
  if (!combo) return "";
  return combo.split(";").filter(Boolean).map(displayStrategy).join(" + ");
}

/** Trade outcomes → user-facing wording. Covers BOTH the backtest codes (tp1/tp2/sl/eod/open)
 *  and the engine codes (win_tp1/win_tp2/loss/open). */
export const OUTCOME_DISPLAY: Record<string, string> = {
  // TP1-ONLY policy (2026-08-13): there is one target now — win_tp1 reads "WIN AT TARGET".
  // The "TARGET 2" strings survive only for pre-policy historical rows, which were wiped;
  // the vocab is tolerated (never produced) like "eod".
  tp1: "WIN AT TARGET",
  tp2: "WIN AT TARGET 2",
  sl: "STOPPED OUT",
  eod: "CLOSED AT SESSION END",
  open: "STILL OPEN",
  win_tp1: "WIN AT TARGET",
  win_tp2: "WIN AT TARGET 2",
  loss: "STOPPED OUT",
};

export function displayOutcome(outcome: string | null | undefined): string {
  if (!outcome) return "";
  return OUTCOME_DISPLAY[outcome] ?? outcome;
}

/** Session codes are already plain, but centralize the long form for headers/tooltips. */
export const SESSION_DISPLAY: Record<string, string> = {
  RTH: "RTH (market hours 9:30-17:00 ET)",
  ETH: "ETH (overnight Globex)",
};

// ═════════════════════════════════════════════════════════════════════════════
// RISK DISPLAY (2026-07-30 — DISPLAY-ONLY; user-approved mission "risk info on every
// signal, NO enforcement, NO letter grade"). Two elements per signal:
//   1. the setup's TRACK RECORD — its fact-combo's held-out walk-forward stats
//      (quality-gate comboClasses), tiered PROVEN / PASSING / PROMISING-UNPROVEN;
//   2. SITUATIONAL WARNINGS — the four factors the 2026-07-30 risk-factor analysis
//      proved real (no-footprint / late-entry / dead-tape / tight-room), each with a
//      plain-English tooltip citing the measured stats.
// Numbers cited below come from risk-factor-analysis.json aggregates.gated (the standing
// 724-trade window). Chop and Tuesday were DISPROVEN — deliberately not shown.
// ═════════════════════════════════════════════════════════════════════════════

/** comboKey family code (quality-gate FACT_FAMILY) → user-facing name. */
export const COMBO_FAMILY_DISPLAY: Record<string, string> = {
  Vec: "Vector", YB: "Yellow Box", ICT: "ICT", Fr: "Fractal",
  FG: "Fractal Geometry", FP: "Footprint", Zone: "Milk Zone", ML: "Money Line",
};

/** "FG+Fr+YB" → "Fractal Geometry + Fractal + Yellow Box". (displayStrategyCombo splits on
 *  ";" with full strategy keys — a comboKey uses "+" and short family codes, hence its own.) */
export function displayComboKey(comboKey: string | null | undefined): string {
  if (!comboKey) return "";
  return comboKey.split("+").filter(Boolean).map(f => COMBO_FAMILY_DISPLAY[f] ?? f).join(" + ");
}

/** Track-record tier. Thresholds mirror scripts/risk-factor-analysis.ts RISK_THRESHOLDS —
 *  "weak" is the analysis's "blocked-losing" (held-out PF < 1.05 on an adequate sample);
 *  the gate excludes those combos from firing, so it only appears on legacy/backfilled rows. */
export type ComboTier = "proven" | "passing" | "unproven" | "weak";
export const COMBO_TIER_THRESHOLDS = {
  PROVEN_PF: 1.3, PASSING_PF: 1.05, MIN_N_AT_INTERVAL: 20, MIN_N_ALL_INTERVAL: 15,
} as const;
export const COMBO_TIER_DISPLAY: Record<ComboTier, string> = {
  proven: "PROVEN",
  passing: "PASSING",
  unproven: "PROMISING, UNPROVEN",
  weak: "WEAK RECORD",
};
/** Short chip variant for the Signals-tab row. */
export const COMBO_TIER_DISPLAY_SHORT: Record<ComboTier, string> = {
  proven: "PROVEN",
  passing: "PASSING",
  unproven: "UNPROVEN",
  weak: "WEAK",
};
/** POSITION SIZING BY COMBO TIER (2026-08-02 — display/config-only, user-approved):
 *  suggested contract count per track-record tier. PROVEN (held-out PF >= 1.3 on an adequate
 *  sample) = 2 contracts; everything else (passing / unproven / weak) = 1. This mapping is the
 *  SINGLE source for the engine's suggestedContracts output (shared/fact-engine
 *  suggestedContractsFor), the SignalDetail RISK PROFILE row, and the Discord size line —
 *  UI and engine can never disagree. IT NEVER SIZES A TRADE BY ITSELF: the auto-trade path
 *  keeps using the user's contract setting unless the explicit OPT-IN setting
 *  "Size by combo tier" (default OFF) is enabled in the market page's Auto Trade panel. */
export const SIZE_BY_COMBO_TIER: Record<ComboTier, number> = {
  proven: 2,
  passing: 1,
  unproven: 1,
  weak: 1,
};
export function suggestedContractsForTier(tier: ComboTier): number {
  return SIZE_BY_COMBO_TIER[tier];
}

export interface ComboHeldOutLike { n: number; pf: number; winRate: number; expectancy: number; lowConfidence?: boolean }
/** Tier from a held-out combo verdict (scope = which quality-gate granularity supplied it).
 *  Mirrors scripts/risk-factor-analysis.ts comboRecordOf: thin/absent/carried-forward
 *  verdicts are "unproven" — small samples are never praised OR condemned. */
export function comboTierOf(
  heldOut: ComboHeldOutLike | null | undefined,
  scope: "interval" | "all" | "none",
): ComboTier {
  const minN = scope === "interval" ? COMBO_TIER_THRESHOLDS.MIN_N_AT_INTERVAL : COMBO_TIER_THRESHOLDS.MIN_N_ALL_INTERVAL;
  if (!heldOut || scope === "none" || heldOut.lowConfidence || heldOut.n < minN) return "unproven";
  if (heldOut.pf >= COMBO_TIER_THRESHOLDS.PROVEN_PF) return "proven";
  if (heldOut.pf >= COMBO_TIER_THRESHOLDS.PASSING_PF) return "passing";
  return "weak";
}

/** "18 trades · 61% win · PF 2.06" (any missing number is skipped). */
export function fmtTrackRecord(s: { n: number | null; winPct: number | null; pf: number | null }): string {
  const parts: string[] = [];
  if (s.n != null) parts.push(`${s.n} trades`);
  if (s.winPct != null) parts.push(`${Math.round(s.winPct)}% win`);
  if (s.pf != null) parts.push(`PF ${s.pf.toFixed(2)}`);
  return parts.join(" · ");
}
/** The explicit small-sample caveat the unproven tier must always carry. */
export function fmtSmallSampleCaveat(n: number): string {
  return `${n} trade${n === 1 ? "" : "s"} — too few to trust`;
}

/** Situational risk-flag ids (shared/fact-engine RISK_FLAG_IDS) → display + plain-English
 *  tooltip citing the measured window stats. */
export interface RiskFlagDisplay { short: string; label: string; tooltip: string }
export const RISK_FLAG_DISPLAY: Record<string, RiskFlagDisplay> = {
  "no-footprint": {
    short: "NO FP",
    label: "NO FOOTPRINT CONFIRMATION",
    tooltip: "No footprint (order-flow) fact backed this signal. Setups WITH a footprint confirmation won 75.9% (PF 3.07) over the 3-month window; without one, 58.7% (PF 1.40).",
  },
  "late-entry": {
    short: "LATE",
    label: "LATE ENTRY",
    tooltip: "Entry between 2:30 and 3:15 PM ET, close to the no-new-signals cutoff. Late entries won 45.3% vs 61.7% earlier in the day (75 late trades in the window).",
  },
  "dead-tape": {
    short: "DEAD",
    label: "DEAD TAPE",
    tooltip: "The session's realized range at fire time was under 0.6x the typical (median) session-day range. Dead-tape setups won just 5.6% in the window (n=18 — a small sample, but one-sided).",
  },
  "tight-room": {
    short: "ROOM",
    label: "TIGHT ROOM",
    tooltip: "The nearest opposing Yellow Box level sits closer than the TP1 target — the trade must clear an obstacle before its first target. These won 54.7% (PF 1.45) vs 75.8% (PF 1.95) with 1-2x TP1 of clear room.",
  },
};
export function displayRiskFlag(id: string): RiskFlagDisplay {
  return RISK_FLAG_DISPLAY[id] ?? { short: id.toUpperCase(), label: id, tooltip: "" };
}

/** Parse a stored risk_flags value (JSON string array, an array, or null) → string[]. */
export function parseRiskFlags(raw: string[] | string | null | undefined): string[] {
  if (Array.isArray(raw)) return raw.filter(x => typeof x === "string");
  if (typeof raw === "string" && raw.length) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p.filter((x: unknown): x is string => typeof x === "string");
    } catch { /* legacy/garbage value — no flags */ }
  }
  return [];
}
