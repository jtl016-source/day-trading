// terminalSettings.ts — typed settings for the Baxter terminal.
//
// Persistence: the terminal's full settings live under `meridian_settings`; the subset of
// keys that drive the always-mounted MarketPage engine are MERGED into `mwb_settings`
// (read-modify-write, so we never drop the engine's own keys). The engine reads
// `mwb_settings` on mount, so terminal changes take effect on the next reload.
//
// SINGLE-TIER: every signal is "safe". The Exit Strategy block mirrors the engine's real
// exit controls (Tight/Standard/Wide profile, direction, TP targets, trailer, zone targets,
// side-entry longs) — same keys the old market page used.

export type ExitProfile = "safe" | "risky" | "riskiest"; // Tight / Standard / Wide
export type TradeDirection = "both" | "long" | "short";
export type Retrain = "Daily" | "Weekly" | "Manual";
export type Confirms = "1" | "2" | "3" | "4";

export interface TerminalSettings {
  // Contract
  symbol: string;            // → mwb_settings.selectedSymbol (engine)
  // Exit strategy (all mirrored into the engine's mwb_settings)
  exitStrategy: ExitProfile; // Tight / Standard / Wide
  direction: TradeDirection; // → autoTradeDirection
  tp1Only: boolean;          // → autoTradeTp1Only (TP1 only vs TP1 + TP2)
  useTrailer: boolean;       // → useTrailer
  trailerOffset: number;     // → trailerOffset
  useZoneTargets: boolean;   // → useZoneTargets
  takeSideEntries: boolean;  // → takeSideEntries
  // Signal Engine (terminal-only display)
  closed: boolean;
  confirms: Confirms;
  // Machine Learning (terminal-only display)
  ml: boolean;
  retrain: Retrain;
}

export interface StrategyToggles {
  MilkZone: boolean;  // → mwb_settings.showMilkZones (engine display)
  Vector: boolean;    // → mwb_settings.showVector (engine display)
  Footprint: boolean; // → mwb_settings.showFpPanel (engine display)
}

const SETTINGS_KEY = "meridian_settings";
const STRATS_KEY = "meridian_strategies";
const MWB_KEY = "mwb_settings";

export const DEFAULT_SETTINGS: TerminalSettings = {
  symbol: "MES",
  exitStrategy: "risky", // matches the engine default getPersistedSetting("exitStrategy","risky")
  direction: "both",
  tp1Only: false,
  useTrailer: false,
  trailerOffset: 2.0,
  useZoneTargets: false,
  takeSideEntries: false,
  closed: true,
  confirms: "2",
  ml: true,
  retrain: "Daily",
};

export const DEFAULT_STRATEGIES: StrategyToggles = {
  MilkZone: false, // upload-driven only — turns on when the user uploads a zone PNG, never by default
  Vector: true,
  Footprint: true,
};

// ── Engine shared store (mwb_settings) ──────────────────────────────────────
function readMwb(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(MWB_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Merge a partial object into mwb_settings WITHOUT dropping the engine's own keys. */
function mergeMwb(partial: Record<string, unknown>): void {
  try {
    const cur = readMwb();
    localStorage.setItem(MWB_KEY, JSON.stringify({ ...cur, ...partial }));
  } catch {
    /* ignore quota / serialization errors */
  }
}

// ── Settings load/save ──────────────────────────────────────────────────────
export function loadSettings(): TerminalSettings {
  let saved: Partial<TerminalSettings> = {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) saved = JSON.parse(raw) as Partial<TerminalSettings>;
  } catch {
    /* ignore */
  }
  const merged: TerminalSettings = { ...DEFAULT_SETTINGS, ...saved };
  // Seed shared keys from the engine's mwb_settings so the terminal reflects what the
  // engine is actually using on first open.
  const mwb = readMwb();
  if (typeof mwb.selectedSymbol === "string") merged.symbol = mwb.selectedSymbol as string;
  if (mwb.exitStrategy === "safe" || mwb.exitStrategy === "risky" || mwb.exitStrategy === "riskiest") merged.exitStrategy = mwb.exitStrategy;
  if (mwb.autoTradeDirection === "both" || mwb.autoTradeDirection === "long" || mwb.autoTradeDirection === "short") merged.direction = mwb.autoTradeDirection;
  if (typeof mwb.autoTradeTp1Only === "boolean") merged.tp1Only = mwb.autoTradeTp1Only as boolean;
  if (typeof mwb.useTrailer === "boolean") merged.useTrailer = mwb.useTrailer as boolean;
  if (typeof mwb.trailerOffset === "number") merged.trailerOffset = mwb.trailerOffset as number;
  if (typeof mwb.useZoneTargets === "boolean") merged.useZoneTargets = mwb.useZoneTargets as boolean;
  if (typeof mwb.takeSideEntries === "boolean") merged.takeSideEntries = mwb.takeSideEntries as boolean;
  return merged;
}

export function saveSettings(s: TerminalSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  // Mirror the shared keys into the engine's mwb_settings.
  mergeMwb({
    selectedSymbol: s.symbol,
    exitStrategy: s.exitStrategy,
    autoTradeDirection: s.direction,
    autoTradeTp1Only: s.tp1Only,
    useTrailer: s.useTrailer,
    trailerOffset: s.trailerOffset,
    useZoneTargets: s.useZoneTargets,
    takeSideEntries: s.takeSideEntries,
  });
}

// ── Strategy toggles load/save ──────────────────────────────────────────────
export function loadStrategies(): StrategyToggles {
  let saved: Partial<StrategyToggles> = {};
  try {
    const raw = localStorage.getItem(STRATS_KEY);
    if (raw) saved = JSON.parse(raw) as Partial<StrategyToggles>;
  } catch {
    /* ignore */
  }
  const mwb = readMwb();
  const merged: StrategyToggles = { ...DEFAULT_STRATEGIES, ...saved };
  if (typeof mwb.showMilkZones === "boolean") merged.MilkZone = mwb.showMilkZones as boolean;
  if (typeof mwb.showVector === "boolean") merged.Vector = mwb.showVector as boolean;
  if (typeof mwb.showFpPanel === "boolean") merged.Footprint = mwb.showFpPanel as boolean;
  return merged;
}

export function saveStrategies(s: StrategyToggles): void {
  try {
    localStorage.setItem(STRATS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  mergeMwb({
    showMilkZones: s.MilkZone,
    showVector: s.Vector,
    showFpPanel: s.Footprint,
  });
}

/** The interval the engine is charting (so the terminal matches it). */
export function getEngineInterval(): string {
  const mwb = readMwb();
  return typeof mwb.interval === "string" ? (mwb.interval as string) : "15m";
}

/** Set the charting interval — mirrors into the engine's mwb_settings so both stay in sync. */
export function setEngineInterval(interval: string): void {
  mergeMwb({ interval });
}
