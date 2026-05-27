import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Timeframe = '1m' | '5m' | '15m' | '60m';
export type ExitStrategy = 'current' | 'tight' | 'standard' | 'wide';

export interface Strategies {
  milkZones: boolean;
  vector: boolean;
  footprint: boolean;
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
  toggleStrategy: (key: keyof Strategies) => void;
  setInstrument: (v: string) => void;
  setTimeframe: (v: Timeframe) => void;
  setApiBaseUrl: (v: string) => void;
  setNotificationsEnabled: (v: boolean) => void;
  setExitStrategy: (v: ExitStrategy) => void;
  setZones: (zones: ParsedZone[]) => void;
}

const AppContext = createContext<AppContextType | null>(null);

const STORAGE_KEY = 'appSettings_v1';

const DEFAULTS = {
  strategies: { milkZones: true, vector: true, footprint: false } as Strategies,
  instrument: 'MES1!',
  timeframe: '15m' as Timeframe,
  apiBaseUrl: 'https://trading.jacksonlems.com',
  notificationsEnabled: true,
  exitStrategy: 'standard' as ExitStrategy,
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

  // Load persisted settings on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(raw => {
        if (raw) {
          try {
            const s = JSON.parse(raw);
            if (s.strategies) setStrategies(s.strategies);
            if (s.instrument) setInstrument(s.instrument);
            if (s.timeframe) setTimeframe(s.timeframe);
            if (s.apiBaseUrl) setApiBaseUrl(s.apiBaseUrl);
            if (typeof s.notificationsEnabled === 'boolean') setNotificationsEnabled(s.notificationsEnabled);
            if (s.exitStrategy && ['current','tight','standard','wide'].includes(s.exitStrategy)) {
              setExitStrategy(s.exitStrategy);
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
      strategies, instrument, timeframe, apiBaseUrl, notificationsEnabled, exitStrategy,
    })).catch(() => {});
  }, [hydrated, strategies, instrument, timeframe, apiBaseUrl, notificationsEnabled, exitStrategy]);

  const toggleStrategy = useCallback((key: keyof Strategies) => {
    setStrategies(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  if (!hydrated) return null;

  return (
    <AppContext.Provider value={{
      strategies, instrument, timeframe, apiBaseUrl, notificationsEnabled, exitStrategy, zones,
      toggleStrategy, setInstrument, setTimeframe, setApiBaseUrl, setNotificationsEnabled, setExitStrategy, setZones,
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
