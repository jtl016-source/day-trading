// shared/firing/types.ts
// ─────────────────────────────────────────────────────────────────────────────
// Framework-agnostic types for the shared firing module. Intentionally free of any
// React / DOM / lightweight-charts imports so a headless Node backtest harness can
// import this module unchanged. The shapes mirror the live engine's runtime objects
// (CandleBar from @/components/CandlestickChart, ZoneBand, CSig from market.tsx).
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal OHLC candle the firing logic needs. Superset-compatible with the
 *  client's `CandleBar` (extra fields are ignored). */
export interface FiringCandle {
  time: number;   // unix seconds, bucket-aligned
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  /** false = ETH bar; true/undefined = RTH (matches CandleBar.rth). */
  rth?: boolean;
  /** false = still-forming bar (never fire on it); true/undefined = closed. */
  complete?: boolean;
}

/** Zone band as produced by the PNG ingestion / detectMilkZones. Mirror of ZoneBand. */
export interface FiringZone {
  topPrice: number;
  bottomPrice: number;
  color: string;
  label?: string;
  fromTime?: number;
  toTime?: number;
}

export type SignalDirection = "Long" | "Short";
export type SignalOutcome = "win_tp1" | "win_tp2" | "win_trailer" | "loss" | "open";
export type RiskLevel = "safeplus" | "safe" | "risky" | "riskiest";

/** Confirmation breakdown captured/locked at fire time (mirror of CSig.confirmations). */
export interface SignalConfirmations {
  milkOk: boolean;
  milkPts?: number;
  vecOk: boolean;
  secondaryVecOk: boolean;
  secondaryVecCount?: number;
}

/** A fired signal — mirror of market.tsx `CSig`. This is the contract both the live
 *  engine and the backtest harness read. */
export interface FiredSignal {
  time: number;
  price: number;
  high: number;
  low: number;
  direction: SignalDirection;
  tp1: number;
  tp2: number;
  sl: number;
  toTime: number;
  riskLevel: RiskLevel;
  confirmations: SignalConfirmations;
  reclassifyReason?: string;
  outcome?: SignalOutcome;
  zonesLoaded?: boolean;
  footprintReading?: string;
  confidence?: number;
  interval?: string;
  /** "vector-side-entry" marks the take-every-side-entry-as-Long feature. */
  signalType?: string;
}

/** A single point on a vector line. */
export interface VectorPoint { time: number; value: number; }
