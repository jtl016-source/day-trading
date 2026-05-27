/**
 * Shared auto-trade settings and push token registry.
 * Imported by both routes.ts and discord-reader.ts to avoid circular deps.
 */

export type ExitStrategy = 'current' | 'tight' | 'standard' | 'wide';

// Exit profile TP/SL pts by strategy → tier
const EXIT_STRAT: Record<string, Record<string, { tp1: number; tp2: number; sl: number }>> = {
  tight:    { safe: { tp1: 12.5, tp2: 25.0, sl: 4.0 }, risky: { tp1:  9.0, tp2: 20.0, sl: 5.5 } },
  standard: { safe: { tp1: 10.0, tp2: 20.0, sl: 5.0 }, risky: { tp1:  7.5, tp2: 17.0, sl: 6.5 } },
  wide:     { safe: { tp1: 16.0, tp2: 30.0, sl: 10.0 }, risky: { tp1: 12.0, tp2: 25.0, sl: 12.0 } },
};

/** Compute exit levels for a given strategy + signal tier + direction + entry price. */
export function resolveExits(
  strategy: ExitStrategy,
  tier: 'safe' | 'risky',
  isLong: boolean,
  entry: number,
): { tp1: number; tp2: number; sl: number } {
  if (strategy === 'current') {
    return {
      tp1: isLong ? entry + 10 : entry - 10,
      tp2: isLong ? entry + 20 : entry - 20,
      sl:  isLong ? entry -  5 : entry +  5,
    };
  }
  const e = EXIT_STRAT[strategy]?.[tier] ?? EXIT_STRAT.standard.safe;
  return {
    tp1: isLong ? entry + e.tp1 : entry - e.tp1,
    tp2: isLong ? entry + e.tp2 : entry - e.tp2,
    sl:  isLong ? entry - e.sl  : entry + e.sl,
  };
}

export interface AutoTradeSettings {
  enabled: boolean;
  contracts: number;
  tp1Only: boolean;
  direction: 'both' | 'long' | 'short';
  contractType: 'MES' | 'ES';
  riskLevels: string[];
  intervals: string[];
  exitStrategy: ExitStrategy;
}

export const tradeSettings: AutoTradeSettings = {
  enabled: false,
  contracts: 1,
  tp1Only: false,
  direction: 'both',
  contractType: 'MES',
  riskLevels: ['safe'],
  intervals: ['5m'],
  exitStrategy: 'standard',
};

// ── Current active trade (set when AutoTrade fires, cleared manually or on exit) ──
export interface CurrentTrade {
  symbol: string;
  direction: 'Long' | 'Short';
  interval: string;
  riskLevel: string;
  entry: number;
  tp1: number;
  tp2: number;
  sl: number;
  contracts: number;
  tp1Only: boolean;
  firedAt: number; // unix seconds
  status: 'open' | 'tp1_hit' | 'tp2_hit' | 'sl_hit';
}

let _currentTrade: CurrentTrade | null = null;
export function getCurrentTrade(): CurrentTrade | null { return _currentTrade; }
export function setCurrentTrade(trade: CurrentTrade): void { _currentTrade = trade; }
export function clearCurrentTrade(): void { _currentTrade = null; }

// Expo push tokens registered by the mobile app
export const pushTokens = new Set<string>();

export async function sendPushNotifications(payload: {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}) {
  if (pushTokens.size === 0) return;
  const messages = [...pushTokens].map(to => ({ to, sound: 'default', ...payload }));
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch {}
}
