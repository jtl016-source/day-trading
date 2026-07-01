import { useState, useEffect, useCallback } from 'react';
import { useApp, Timeframe } from '@/context/app-context';
import { Candle, spikeBarOk, dedupByTime, aggToInterval, atr14 } from '@/lib/candles';
import { mapDbSignal, isPcDisplaySignal, type MobileSignal } from '@/lib/signal-map';

// fetchInterval maps 15m → 5m (aggregated client-side); 60m direct (see CLAUDE.md).
const FETCH_INTERVAL: Record<Timeframe, string> = { '1m': '1m', '5m': '5m', '15m': '5m', '60m': '60m' };
const DISPLAY_MIN: Record<Timeframe, number> = { '1m': 1, '5m': 5, '15m': 15, '60m': 60 };

// Collapse "bundled" signals so the phone matches the PC exactly: the engine can emit several
// same-direction signals on consecutive bars — keep only the FIRST of each same-direction
// cluster within ~5 bars. (Mirror of dedupeSignals in the PC's useTerminalData.)
function dedupeSignals(sigs: MobileSignal[], intervalSec: number): MobileSignal[] {
  const windowSec = intervalSec * 5;
  const asc = [...sigs].sort((a, b) => a.time - b.time);
  const out: MobileSignal[] = [];
  const lastBySide: Record<string, number> = {};
  for (const sg of asc) {
    const last = lastBySide[sg.direction];
    if (last != null && sg.time - last < windowSec) continue;
    out.push(sg);
    lastBySide[sg.direction] = sg.time;
  }
  return out;
}

// Canonical symbol — exact port of shared/symbol.ts normalizeSymbol() (matches chart-view.tsx).
export function normalizeSymbol(instrument: string): string {
  return instrument.toUpperCase().trim()
    .replace(/\.[A-Z]+$/, '')
    .replace(/=F$/, '')
    .replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '')
    .replace(/\d+!?$/, '');
}

export interface MarketStats {
  last: number;
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  atr: number | null;
  up: boolean;
}

export interface MarketData {
  candles: Candle[];          // cleaned, at display interval
  stats: MarketStats | null;
  signals: MobileSignal[];    // newest-first
  loading: boolean;
  error: string | null;
  source: string;
  lastUpdated: number;        // ms; bump to retrigger the wave-reveal
  refresh: () => void;
}

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Request timed out')), ms);
    fetch(url).then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}

// Retry wrapper — a single timeout is brittle on mobile (slow first connect/SSL, or the server
// briefly busy after a restart). Try a few times with a short backoff before giving up.
async function fetchRetry(url: string, ms: number, attempts: number): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetchWithTimeout(url, ms);
      if (r.ok) return r;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
    if (i < attempts - 1) await new Promise(res => setTimeout(res, 1200));
  }
  throw lastErr ?? new Error('Request failed');
}

// Derive today's session high/low/last/change from the cleaned candles (ET day).
function deriveStats(candles: Candle[]): MarketStats | null {
  if (!candles.length) return null;
  const last = candles[candles.length - 1].close;
  // Bars from the most recent UTC calendar day present in the data, fallback to last 80.
  const lastTime = candles[candles.length - 1].time;
  const dayStart = Math.floor(lastTime / 86400) * 86400;
  let dayBars = candles.filter(c => c.time >= dayStart);
  if (dayBars.length < 2) dayBars = candles.slice(-80);
  const open = dayBars[0].open;
  const dayHigh = Math.max(...dayBars.map(c => c.high));
  const dayLow = Math.min(...dayBars.map(c => c.low));
  const change = last - open;
  const changePct = open > 0 ? (change / open) * 100 : 0;
  return { last, change, changePct, dayHigh, dayLow, atr: atr14(candles), up: change >= 0 };
}

/**
 * Shared market data for the Market + Signals screens. Fetches cleaned OHLC from
 * /api/data/cached-continuous and signals from /api/signals/history (mapped via the
 * shared lib for PC parity). Independent of the WebView chart.
 */
export function useMarketData(): MarketData {
  const { apiBaseUrl, instrument, timeframe } = useApp();
  const sym = normalizeSymbol(instrument);
  const fetchInterval = FETCH_INTERVAL[timeframe];
  const displayMin = DISPLAY_MIN[timeframe];

  const [candles, setCandles] = useState<Candle[]>([]);
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [signals, setSignals] = useState<MobileSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState('unknown');
  const [lastUpdated, setLastUpdated] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    // ── Signals — fetched INDEPENDENTLY so a slow/failed candle load can't block them.
    // Last 30 days, same mapping as the PC for identical signals.
    const loadSignals = async () => {
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const sr = await fetchRetry(
          `${apiBaseUrl}/api/signals/history/${encodeURIComponent(sym.toUpperCase())}/${timeframe}`, 12000, 3,
        );
        if (cancelled) return;
        const sd = await sr.json();
        const cutoff = nowSec - 30 * 86400;
        const mapped: MobileSignal[] = (sd.signals ?? [])
          // Reject corrupt FUTURE-dated rows and anything older than the 30-day window.
          .filter((s: any) => s.timestamp >= cutoff && s.timestamp <= nowSec + 3600)
          .filter(isPcDisplaySignal)
          .map(mapDbSignal)
          // USER RULE: in ETH, show ONLY vector side-entry signals — drop any other ETH signal.
          .filter((s: MobileSignal) => s.rth || s.signalType === 'vector-side-entry');
        const deduped = dedupeSignals(mapped, DISPLAY_MIN[timeframe] * 60)
          .sort((a, b) => b.time - a.time);
        if (!cancelled) setSignals(deduped);
      } catch { /* signals are non-fatal */ }
    };

    // ── Candles — FAST 14-day window so the chart loads reliably on mobile.
    const loadCandles = async (silent: boolean) => {
      if (!silent) { setLoading(true); setError(null); }
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const fromSec = nowSec - 14 * 86400;
        const toSec = nowSec + 86400;
        const url = `${apiBaseUrl}/api/data/cached-continuous/${sym}/${fetchInterval}?from=${fromSec}&to=${toSec}`;
        const resp = await fetchRetry(url, 20000, 3);
        const raw = await resp.json();
        if (cancelled) return;
        const rawBars: any[] = Array.isArray(raw) ? raw : (raw.candles ?? raw.bars ?? []);
        setSource((raw && raw.source) ?? 'unknown');
        const clean = dedupByTime((rawBars as Candle[]).filter(spikeBarOk).sort((a, b) => a.time - b.time));
        const display = dedupByTime(aggToInterval(clean, displayMin)).sort((a, b) => a.time - b.time);
        if (!cancelled) {
          setCandles(display);
          setStats(deriveStats(display));
          setLastUpdated(Date.now());
        }
      } catch (e: any) {
        if (!cancelled && !silent) setError(String(e?.message ?? e));
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };

    // ── LIVE price tick — cheap poll that moves the last bar + day stats between full
    // refetches, so the app shows live price instead of a frozen snapshot.
    const loadLivePrice = async () => {
      try {
        const res = fetchInterval === '1m' ? '1' : '5';
        const r = await fetchWithTimeout(`${apiBaseUrl}/api/live/bar/${encodeURIComponent(sym)}?res=${res}`, 6000);
        if (!r.ok || cancelled) return;
        const d = await r.json();
        const price: number | null = typeof d?.price === 'number' ? d.price
          : (typeof d?.bar?.close === 'number' ? d.bar.close : null);
        if (price == null || cancelled) return;
        setCandles(prev => {
          if (!prev.length) return prev;
          const next = prev.slice();
          const last = { ...next[next.length - 1] };
          last.close = price;
          if (price > last.high) last.high = price;
          if (price < last.low) last.low = price;
          next[next.length - 1] = last;
          return next;
        });
        setStats(prev => {
          if (!prev) return prev;
          const open = prev.last - prev.change;       // recover today's open
          const change = price - open;
          return {
            ...prev, last: price, change,
            changePct: open > 0 ? (change / open) * 100 : 0,
            dayHigh: Math.max(prev.dayHigh, price),
            dayLow: Math.min(prev.dayLow, price),
            up: change >= 0,
          };
        });
      } catch { /* live tick is best-effort */ }
    };

    loadSignals();
    loadCandles(false);
    // Live polling: price every 4s, full candles+signals refetch every 20s (silent — no spinner).
    const priceId = setInterval(loadLivePrice, 4000);
    const dataId = setInterval(() => { if (!cancelled) { loadSignals(); loadCandles(true); } }, 20000);

    return () => { cancelled = true; clearInterval(priceId); clearInterval(dataId); };
  }, [apiBaseUrl, sym, fetchInterval, displayMin, timeframe, reloadKey]);

  return { candles, stats, signals, loading, error, source, lastUpdated, refresh };
}
