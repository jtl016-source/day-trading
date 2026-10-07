// terminalSettings.ts — typed settings for the Baxter terminal.
//
// Persistence: the terminal's full settings live under `meridian_settings`; the subset of
// keys that drive the always-mounted MarketPage engine are MERGED into `mwb_settings`
// (read-modify-write, so we never drop the engine's own keys). The engine reads
// `mwb_settings` on mount, so terminal changes take effect on the next reload.
//
// SINGLE-TIER: every signal is "safe". The Exit Strategy block mirrors the engine's real
// exit controls (Tight/Standard/Wide profile, direction, TP targets) — same keys the market
// page uses. (Trailer + zone-target + side-entry-long toggles DELETED 2026-07-13: trailer is
// gone per spec rule 12; the other two controlled nothing in the fact-engine model.)

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
  // Signal Engine (terminal-only display)
  closed: boolean;
  confirms: Confirms;
  // Machine Learning (terminal-only display)
  ml: boolean;
  retrain: Retrain;
}

export interface StrategyToggles {
  MilkZone: boolean;     // → mwb_settings.showMilkZones (engine display)
  Vector: boolean;       // → mwb_settings.showVector (engine display)
  Footprint: boolean;    // → mwb_settings.showFpPanel (engine display)
  YellowBox: boolean;    // → mwb_settings.yellowBoxEnabled (per-day gold boxes + engine fact input)
  CloseEst: boolean;     // → mwb_settings.closeEstEnabled (EOD close-estimate zone overlay — display-only)
  Probability: boolean;  // master toggle: fractal probability layer (panel + on-chart overlays)
  // CONFIRMATION-FACT toggles (2026-07-15) — corroborator-only facts in the signal engine,
  // NOT standalone strategies. DEFAULT ON; missing-key-means-ON semantics like YellowBox.
  ICT: boolean;          // → mwb_settings.ictConfirmEnabled (engine fact input)
  Fractal: boolean;      // → mwb_settings.fractalConfirmEnabled (engine fact input)
  FractalGeo: boolean;   // → mwb_settings.fractalGeoConfirmEnabled (engine fact input)
  // Per-concept on-chart overlays (only active when Probability is on) — each shown individually.
  probValueArea: boolean; // long-run POC / VAH / VAL horizontal lines
  probRegime: boolean;    // DFA-Hurst regime ribbon along the bottom
  probForecast: boolean;  // Hurst-scaled expected-range forecast cone projecting right
  probScaler: boolean;    // ± target-scaler expected-range levels at the current price
}

const SETTINGS_KEY = "meridian_settings";
const STRATS_KEY = "meridian_strategies";
const MWB_KEY = "mwb_settings";

export const DEFAULT_SETTINGS: TerminalSettings = {
  symbol: "MES",
  exitStrategy: "risky", // matches the engine default getPersistedSetting("exitStrategy","risky")
  direction: "both",
  tp1Only: false,
  closed: true,
  confirms: "2",
  ml: true,
  retrain: "Daily",
};

export const DEFAULT_STRATEGIES: StrategyToggles = {
  MilkZone: false, // upload-driven only — turns on when the user uploads a zone PNG, never by default
  Vector: true,
  Footprint: true,
  YellowBox: true, // DEFAULT ON — {...DEFAULT_STRATEGIES, ...saved} makes a MISSING key resolve true for existing profiles
  CloseEst: true, // DEFAULT ON — EOD close-estimate zone (2026-08-09 study session); missing key resolves true
  Probability: false, // off by default — opt-in fractal regime/value-area read-out
  ICT: true,     // DEFAULT ON — confirmation facts (missing key resolves true for existing profiles)
  Fractal: true, // DEFAULT ON — confirmation facts (missing key resolves true for existing profiles)
  FractalGeo: true, // DEFAULT ON — Fractal-Geometry guide confirmations (missing key resolves true)
  probValueArea: true,
  probRegime: true,
  probForecast: true,
  probScaler: true,
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
  // Missing yellowBoxEnabled key (pre-existing profiles) keeps the default ON — only a real boolean overrides.
  if (typeof mwb.yellowBoxEnabled === "boolean") merged.YellowBox = mwb.yellowBoxEnabled as boolean;
  if (typeof mwb.closeEstEnabled === "boolean") merged.CloseEst = mwb.closeEstEnabled as boolean;
  if (typeof mwb.showProbability === "boolean") merged.Probability = mwb.showProbability as boolean;
  // Confirmation-fact toggles: missing key = default ON — only a real boolean overrides.
  if (typeof mwb.ictConfirmEnabled === "boolean") merged.ICT = mwb.ictConfirmEnabled as boolean;
  if (typeof mwb.fractalConfirmEnabled === "boolean") merged.Fractal = mwb.fractalConfirmEnabled as boolean;
  if (typeof mwb.fractalGeoConfirmEnabled === "boolean") merged.FractalGeo = mwb.fractalGeoConfirmEnabled as boolean;
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
    yellowBoxEnabled: s.YellowBox,
    closeEstEnabled: s.CloseEst,
    showProbability: s.Probability,
    ictConfirmEnabled: s.ICT,
    fractalConfirmEnabled: s.Fractal,
    fractalGeoConfirmEnabled: s.FractalGeo,
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
