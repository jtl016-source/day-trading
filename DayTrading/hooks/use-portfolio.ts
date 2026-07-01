// ── iPhone portfolio data hooks + formatters ─────────────────────────────────
// Consumes the SAME server endpoints as the PC (/api/portfolio/*) via apiBaseUrl.
// Plain useState/useEffect/fetch — matches use-market-data.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/context/app-context';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  dataStale: boolean;
  refetch: () => void;
}

/** GET `${apiBaseUrl}${path}` with optional polling. */
export function usePortfolioApi<T>(path: string, pollMs = 0): ApiState<T> {
  const { apiBaseUrl } = useApp();
  const url = `${apiBaseUrl}${path}`;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const aliveRef = useRef(true);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(to));
        const j = await r.json();
        if (aliveRef.current) { setData(j); setError(j?.error ?? null); }
      } catch (e: any) {
        if (aliveRef.current) setError(String(e?.message ?? e));
      } finally {
        if (aliveRef.current && !silent) setLoading(false);
      }
    };
    run(false);
    if (pollMs > 0) timer = setInterval(() => run(true), pollMs);
    return () => { aliveRef.current = false; if (timer) clearInterval(timer); };
  }, [url, pollMs, tick]);

  return { data, loading, error, dataStale: !!(data as any)?.dataStale, refetch };
}

export function usePortfolioPost() {
  const { apiBaseUrl } = useApp();
  return useCallback(async (path: string, body: unknown) => {
    const r = await fetch(`${apiBaseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.json();
  }, [apiBaseUrl]);
}

// ── formatters ───────────────────────────────────────────────────────────────
export const fmtNum = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtMoney = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : '$' + Math.round(n).toLocaleString('en-US');
export const fmtCompact = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
};
export const fmtPct = (n: number | null | undefined, d = 1): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
export const fmtDate = (s: string): string => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
};

export const GRADE_COLOR: Record<string, string> = { A: '#1fd98a', B: '#2dd4bf', C: '#ffb454', D: '#ff8a5b', F: '#ff4d6d' };
export const CHANGE_COLOR: Record<string, string> = { new: '#2dd4bf', add: '#1fd98a', trim: '#ff8a5b', exit: '#ffb454', hold: '#7c8190' };
export const partyColor = (party: string): string => {
  const p = (party || '').toLowerCase();
  return p.includes('repub') ? '#ff4d6d' : p.includes('democ') ? '#4d9bff' : '#7c8190';
};
export const DONUT_COLORS = ['#2dd4bf', '#1fd98a', '#ffb454', '#4d9bff', '#c4b5fd', '#ff8a5b', '#ff4d6d', '#7c8190'];
