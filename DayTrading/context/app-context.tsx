import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Timeframe = '1m' | '5m' | '15m' | '60m';
export type ExitStrategy = 'current' | 'tight' | 'standard' | 'wide';
export type Session = 'RTH' | 'ETH';
export type MinTier = 'safeplus' | 'safe' | 'risky';

export interface Strategies {
  milkZones: boolean;
  vector: boolean;
  footprint: boolean;
}

// ── Terminal settings — mirrors the MERIDIAN mockup Settings cards ─────────────
// Some fields are server-backed elsewhere (symbol→instrument, push→notifications,
// endpoint→apiBaseUrl, AutoTrader→/api/trade/settings); the rest are persisted
// local preferences (no mobile backend yet) applied as client-side display logic.
export interface TerminalSettings {
  // Contract & session
  continuous: boolean;
  session: Session;          // RTH/ETH — drives the signal display filter
  roll: 'VOL' | 'OI';
  // Risk management (local prefs)
  stopAtr: number;
  maxRisk: number;
  scaleSafePlus: number;
  scaleRiskiest: number;
  // Exit (local prefs; exitStrategy profile is separate) — mirrors the PC Exit Strategy card
  direction: 'both' | 'long' | 'short';   // → /api/trade/settings autoTradeDirection
  tp1Only: boolean;                        // Targets: TP1 only vs TP1+TP2
  useTrailer: boolean;
  trailerOffset: number;                   // points trailed after TP1
  useZoneTargets: boolean;                 // TP/SL snap to nearest zones
  takeSideEntries: boolean;                // every vector side entry → Long
  partial: boolean;
  breakeven: boolean;
  tp2Atr: number;
  monteCarlo: boolean;
  // Signal engine — applied as client-side filters on the signal stream
  closedOnly: boolean;
  minTier: MinTier;
  confirms: number;          // 1–4 confirmations required (milk/vec/fp/pattern)
  // Machine learning (local prefs)
  mlLoop: boolean;
  retrain: 'DAILY' | 'WEEKLY' | 'MANUAL';
  // Notifications (relay/sound local; push → notificationsEnabled)
  relay: boolean;
  sound: boolean;
  // Data feed (provider cosmetic; endpoint → apiBaseUrl)
  feed: 'RITHMIC' | 'DXFEED';
}

export interface ParsedZone {
  topPrice: number;
  bottomPrice: number;
  fillColor: string;
  fromTime: number;
  toTime: number;
  label?: string;
  zoneScope?: 'ovn' | 'rth';
}

// ── Exit strategy profiles — exact mirror of EXIT_STRATEGY_PROFILES in market.tsx ──
// "current" = fixed 10/20/5 pts from signal computation (no override)
export const EXIT_PROFILES = {
  tight: {
    label: 'Tight',
    desc: 'Safe+ confirmed · smaller SL, aggressive TP',
    color: '#26c87a',
    rth: {
      safe:  { tp1: 12.5, tp2: 25.0, sl: 4.0 },
      risky: { tp1:  9.0, tp2: 20.0, sl: 5.5 },
    },
  },
  standard: {
    label: 'Standard',
    desc: 'Zone + secondary · balanced exits',
    color: '#f59e0b',
    rth: {
      safe:  { tp1: 10.0, tp2: 20.0, sl: 5.0 },
      risky: { tp1:  7.5, tp2: 17.0, sl: 6.5 },
    },
  },
  wide: {
    label: 'Wide',
    desc: 'Swing style · larger TP, wider SL',
    color: '#ef5350',
    rth: {
      safe:  { tp1: 16.0, tp2: 30.0, sl: 10.0 },
      risky: { tp1: 12.0, tp2: 25.0, sl: 12.0 },
    },
  },
} as const;

interface AppContextType {
  strategies: Strategies;
  instrument: string;
  timeframe: Timeframe;
  apiBaseUrl: string;
  notificationsEnabled: boolean;
  exitStrategy: ExitStrategy;
  zones: ParsedZone[];
  terminal: TerminalSettings;
  toggleStrategy: (key: keyof Strategies) => void;
  setInstrument: (v: string) => void;
  setTimeframe: (v: Timeframe) => void;
  setApiBaseUrl: (v: string) => void;
  setNotificationsEnabled: (v: boolean) => void;
  setExitStrategy: (v: ExitStrategy) => void;
  setZones: (zones: ParsedZone[]) => void;
  setTerminal: <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => void;
}

const AppContext = createContext<AppContextType | null>(null);

const STORAGE_KEY = 'appSettings_v1';

const DEFAULT_TERMINAL: TerminalSettings = {
  continuous: true, session: 'RTH', roll: 'VOL',
  stopAtr: 1.2, maxRisk: 75, scaleSafePlus: 1.5, scaleRiskiest: 0.5,
  direction: 'both', tp1Only: false, useTrailer: false, trailerOffset: 2.0,
  useZoneTargets: false, takeSideEntries: false,
  partial: true, breakeven: true, tp2Atr: 2.5, monteCarlo: true,
  closedOnly: true, minTier: 'safe', confirms: 2,
  mlLoop: true, retrain: 'DAILY',
  relay: true, sound: false,
  feed: 'RITHMIC',
};

const DEFAULTS = {
  strategies: { milkZones: true, vector: true, footprint: false } as Strategies,
  instrument: 'MES1!',
  timeframe: '15m' as Timeframe,
  apiBaseUrl: 'https://trading.jacksonlems.com',
  notificationsEnabled: true,
  exitStrategy: 'standard' as ExitStrategy,
  terminal: DEFAULT_TERMINAL,
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [strategies, setStrategies] = useState<Strategies>(DEFAULTS.strategies);
  const [instrument, setInstrument] = useState(DEFAULTS.instrument);
  const [timeframe, setTimeframe] = useState<Timeframe>(DEFAULTS.timeframe);
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULTS.apiBaseUrl);
  const [notificationsEnabled, setNotificationsEnabled] = useState(DEFAULTS.notificationsEnabled);
  const [exitStrategy, setExitStrategy] = useState<ExitStrategy>(DEFAULTS.exitStrategy);
  const [zones, setZones] = useState<ParsedZone[]>([]);
  const [terminal, setTerminalState] = useState<TerminalSettings>(DEFAULTS.terminal);

  // Load persisted settings on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(raw => {
        if (raw) {
          try {
            const s = JSON.parse(raw);
            // Merge with defaults so newly-added keys (e.g. strategies.pattern) are never undefined.
            if (s.strategies) setStrategies({ ...DEFAULTS.strategies, ...s.strategies });
            if (s.instrument) setInstrument(s.instrument);
            if (s.timeframe) setTimeframe(s.timeframe);
            if (s.apiBaseUrl) setApiBaseUrl(s.apiBaseUrl);
            if (typeof s.notificationsEnabled === 'boolean') setNotificationsEnabled(s.notificationsEnabled);
            if (s.exitStrategy && ['current','tight','standard','wide'].includes(s.exitStrategy)) {
              setExitStrategy(s.exitStrategy);
            }
            if (s.terminal && typeof s.terminal === 'object') {
              setTerminalState({ ...DEFAULT_TERMINAL, ...s.terminal });
            }
          } catch {}
        }
      })
      .finally(() => setHydrated(true));
  }, []);

  // Persist on every change (after initial hydration)
  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
      strategies, instrument, timeframe, apiBaseUrl, notificationsEnabled, exitStrategy, terminal,
    })).catch(() => {});
  }, [hydrated, strategies, instrument, timeframe, apiBaseUrl, notificationsEnabled, exitStrategy, terminal]);

  const toggleStrategy = useCallback((key: keyof Strategies) => {
    setStrategies(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const setTerminal = useCallback(<K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => {
    setTerminalState(prev => ({ ...prev, [key]: value }));
  }, []);

  if (!hydrated) return null;

  return (
    <AppContext.Provider value={{
      strategies, instrument, timeframe, apiBaseUrl, notificationsEnabled, exitStrategy, zones, terminal,
      toggleStrategy, setInstrument, setTimeframe, setApiBaseUrl, setNotificationsEnabled, setExitStrategy, setZones, setTerminal,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be within AppProvider');
  return ctx;
}
