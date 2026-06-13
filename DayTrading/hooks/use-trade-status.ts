import { useEffect, useState } from 'react';
import { useApp } from '@/context/app-context';

export interface CurrentTrade {
  symbol: string;
  direction: 'Long' | 'Short';
  interval: string;
  riskLevel: string;
  entry: number; tp1: number; tp2: number; sl: number;
  contracts: number; tp1Only: boolean; firedAt: number;
  status: 'open' | 'tp1_hit' | 'tp2_hit' | 'sl_hit';
}

// Poll AutoTrader connection + the active trade (mirrors journal.tsx polling).
export function useTradeStatus(intervalMs = 5000): { connected: boolean; trade: CurrentTrade | null } {
  const { apiBaseUrl } = useApp();
  const [connected, setConnected] = useState(false);
  const [trade, setTrade] = useState<CurrentTrade | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${apiBaseUrl}/api/trade/status`);
        if (r.ok) { const d = await r.json(); if (alive) setConnected(!!d.connected); }
      } catch { if (alive) setConnected(false); }
      try {
        const r2 = await fetch(`${apiBaseUrl}/api/trade/current`);
        if (r2.ok) { const d2 = await r2.json(); if (alive) setTrade(d2.trade ?? null); }
      } catch { /* non-fatal */ }
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [apiBaseUrl, intervalMs]);

  return { connected, trade };
}
