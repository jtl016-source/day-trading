// shared/firing/constants.ts
// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL firing constants — extracted VERBATIM from client/src/pages/market.tsx
// as the BASELINE for the MERIDIAN firing-logic rebuild (see docs/MERIDIAN_TRADING_LOGIC.md).
//
// STATUS: extraction slice 1 (foundation). These values are a faithful copy of the
// current live engine's constants so BOTH the live engine and the headless backtest
// harness can import a single source of truth. NOTHING here changes behavior — the
// live engine still owns its own copies until the reviewed rewire slice.
//
// HARD RULE: do not "tune" any of these here. New-model parameters live behind flags
// in a separate module; this file is the frozen baseline.
// ─────────────────────────────────────────────────────────────────────────────

// ── Fixed-point exits (legacy confluence baseline) ──────────────────────────
export const TP_FIXED_1_SAFE = 12.5; // TP1 for safe signals (strong confluence, zone + vec + imbalance)
export const TP_FIXED_1 = 10.0;      // TP1 for risky/riskiest signals
export const TP_FIXED_2 = 20.0;      // TP2: 20 pts (cap — market can't always extend)
export const SL_FIXED = 5.0;         // SL: 5 pts (20 ticks, $25/MES)
export const MILK_TOLERANCE_PTS = 2.0; // zone price proximity tolerance (8 ticks)

// ── Tier scoring (BASELINE — being retired to SAFE-or-nothing) ───────────────
// NOTE: the live confluence path already collapsed emitted signals to a single
// "safe" tier (market.tsx ~2887). RISK_QUALITY + the multi-tier exit table below
// survive only in the exit geometry, the UI colors, and the vector side-entry path.
export const RISK_QUALITY: Record<string, number> = { safeplus: 4, safe: 3, risky: 2, riskiest: 1 };

// ── Exit strategy profiles — tier-aware TP/SL (verbatim from market.tsx:278) ──
export const EXIT_STRATEGY_PROFILES = {
  safe: {
    label: "Tight", desc: "FP confirmed — SAFE+ 3.5pt SL · 28pt TP2",
    winRate: 0.74, ev: 8.2, avgPts: 8.2,
    rth: {
      safeplus: { tp1: 14.0, tp2: 28.0, sl: 3.5 },
      safe:     { tp1: 12.5, tp2: 25.0, sl: 4.0 },
      risky:    { tp1:  9.0, tp2: 20.0, sl: 5.5 },
      riskiest: { tp1:  7.0, tp2: 16.0, sl: 8.0 },
    },
    eth: {
      safeplus: { tp1:  8.5, tp2: 17.0, sl: 2.5 },
      safe:     { tp1:  7.5, tp2: 15.0, sl: 3.0 },
      risky:    { tp1:  5.5, tp2: 12.0, sl: 4.0 },
      riskiest: { tp1:  4.0, tp2:  9.0, sl: 5.5 },
    },
  },
  risky: {
    label: "Standard", desc: "Zone+secondary — SAFE 5pt SL · 20pt TP2",
    winRate: 0.50, ev: 2.5, avgPts: 2.5,
    rth: {
      safeplus: { tp1: 12.0, tp2: 22.0, sl: 4.0 },
      safe:     { tp1: 10.0, tp2: 20.0, sl: 5.0 },
      risky:    { tp1:  7.5, tp2: 17.0, sl: 6.5 },
      riskiest: { tp1:  5.5, tp2: 13.0, sl: 9.0 },
    },
    eth: {
      safeplus: { tp1:  7.0, tp2: 13.0, sl: 3.0 },
      safe:     { tp1:  6.0, tp2: 12.0, sl: 3.5 },
      risky:    { tp1:  4.5, tp2: 10.0, sl: 4.5 },
      riskiest: { tp1:  3.5, tp2:  8.0, sl: 6.0 },
    },
  },
  riskiest: {
    label: "Wide", desc: "Swing style — SAFE 10pt SL · 30pt TP2",
    winRate: 0.30, ev: 0.5, avgPts: 0.5,
    rth: {
      safeplus: { tp1: 18.0, tp2: 35.0, sl:  8.0 },
      safe:     { tp1: 16.0, tp2: 30.0, sl: 10.0 },
      risky:    { tp1: 12.0, tp2: 25.0, sl: 12.0 },
      riskiest: { tp1: 10.0, tp2: 20.0, sl: 15.0 },
    },
    eth: {
      safeplus: { tp1: 10.0, tp2: 20.0, sl: 5.5 },
      safe:     { tp1:  9.0, tp2: 17.0, sl: 7.0 },
      risky:    { tp1:  7.0, tp2: 14.0, sl: 8.5 },
      riskiest: { tp1:  6.0, tp2: 12.0, sl: 10.0 },
    },
  },
} as const;

export type ExitProfileKey = keyof typeof EXIT_STRATEGY_PROFILES;
export type ExitTier = "safeplus" | "safe" | "risky" | "riskiest";

// ── Legacy ATR multipliers (kept for VEC signal, not confluence) ─────────────
export const TP_ATR_MULT = 1.0;
export const SL_ATR_MULT = 0.5;

// ── Vector (Highest(Lowest(low,20),20)) bracket constants ────────────────────
export const VEC_LENGTH = 20;
export const VEC_STOP_BELOW = 3.5;
export const VEC_STOP_BE = 15.0;
export const VEC_TP1 = 7.5;
export const VEC_TP2 = 26.0;
export const VEC_MAX_STOP = 8.0;

// ── Firing loop gates (verbatim locals from allConfluenceSignals) ────────────
export const ATR_PERIOD = 14;
export const COOLDOWN_BARS = 10;   // RTH cooldown between signals (RTH bars)
export const ETH_COOLDOWN = 20;    // ETH cooldown (wider — low volume / wider spreads)
export const PROX_PTS = 5.0;       // resistance-proximity tier downgrade distance
export const VEC_TEST_BARS = 5;    // lookback window for a "vector test"

// HOD/LOD caution logic
export const HOD_PROX_PTS = 3.0;   // within this many pts of HOD/LOD = "close to" (TP1 tightening)
export const HOD_BUF_PTS = 2.0;    // set TP1 to HOD − buf (or LOD + buf)
export const MIN_TP1_PTS = 3.0;    // never squeeze TP1 below this profit
export const LOD_ENTRY_PROX = 3.0; // suppress shorts within this many pts above LOD
export const HOD_ENTRY_PROX = 3.0; // suppress longs within this many pts below HOD
