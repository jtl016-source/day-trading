import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, RefreshControl, ActivityIndicator,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { useApp } from '@/context/app-context';
import { Trading, Fonts } from '@/constants/theme';
import { TierBadge } from '@/components/tier-badge';
import { AnimatedNumber, GlowPulse, LivePulse, PressableScale } from '@/components/animated-ui';

// ── Mini chart WebView (lw-charts v4 CDN) ─────────────────────────────────────
const MINI_LW_CDN = 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js';
function _fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(url).then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}
let _miniLwCache: Promise<string> | null = null;
function getMiniLwScript(): Promise<string> {
  if (!_miniLwCache) {
    _miniLwCache = _fetchWithTimeout(MINI_LW_CDN, 15000)
      .then(r => { if (!r.ok) throw new Error('CDN ' + r.status); return r.text(); })
      .catch(e => { _miniLwCache = null; throw e; });
  }
  return _miniLwCache;
}

function buildMiniHtml(lwScript: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{background:#07111a;overflow:hidden;width:100%;height:100%}#chart{width:100%;height:100%}</style>
</head><body>
<div id="chart"></div>
<script>${lwScript}</script>
<script>
var chart, candleSeries, priceLines = [];
function init() {
  chart = LightweightCharts.createChart(document.getElementById('chart'), {
    width: window.innerWidth, height: window.innerHeight,
    layout: { background: { color: '#07111a' }, textColor: '#7a9ab8' },
    grid: { vertLines: { color: '#19293d' }, horzLines: { color: '#19293d' } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#19293d' },
    rightPriceScale: { borderColor: '#19293d', scaleMargins: { top: 0.15, bottom: 0.15 } },
    crosshair: { mode: 1 }, handleScale: true, handleScroll: true,
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: '#22c55e', downColor: '#ef4444',
    borderUpColor: '#22c55e', borderDownColor: '#ef4444',
    wickUpColor: '#22c55e', wickDownColor: '#ef4444',
  });
  window.addEventListener('resize', function() { chart.resize(window.innerWidth, window.innerHeight); });
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' })); } catch(e) {}
}
window.setMiniData = function(candles, levels) {
  for (var i = 0; i < priceLines.length; i++) { try { candleSeries.removePriceLine(priceLines[i]); } catch(e) {} }
  priceLines = [];
  if (candles && candles.length) candleSeries.setData(candles);
  if (levels) {
    priceLines.push(candleSeries.createPriceLine({ price: levels.entry, color: '#e8f0f7', lineWidth: 1, lineStyle: 0, title: 'Entry', axisLabelVisible: true }));
    priceLines.push(candleSeries.createPriceLine({ price: levels.tp1, color: '#22c55e', lineWidth: 1, lineStyle: 1, title: 'TP1', axisLabelVisible: true }));
    if (levels.tp2 && Math.abs(levels.tp2 - levels.tp1) > 0.01)
      priceLines.push(candleSeries.createPriceLine({ price: levels.tp2, color: '#22c55e', lineWidth: 2, lineStyle: 0, title: 'TP2', axisLabelVisible: true }));
    priceLines.push(candleSeries.createPriceLine({ price: levels.sl, color: '#ef4444', lineWidth: 1, lineStyle: 1, title: 'SL', axisLabelVisible: true }));
    chart.timeScale().fitContent();
  }
};
init();
</script></body></html>`;
}

interface CurrentTrade {
  symbol: string; direction: 'Long' | 'Short'; interval: string; riskLevel: string;
  entry: number; tp1: number; tp2: number; sl: number;
  contracts: number; tp1Only: boolean; firedAt: number;
  status: 'open' | 'tp1_hit' | 'tp2_hit' | 'sl_hit';
}

function statusColor(status: CurrentTrade['status']): string {
  if (status === 'tp2_hit' || status === 'tp1_hit') return Trading.long;
  if (status === 'sl_hit') return Trading.short;
  return Trading.accent;
}
function statusLabel(status: CurrentTrade['status']): string {
  return status === 'tp2_hit' ? 'TP2 HIT' : status === 'tp1_hit' ? 'TP1 HIT' : status === 'sl_hit' ? 'SL HIT' : 'OPEN';
}
function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' });
}
function ptsUsd(pts: number, contracts: number): string {
  return `$${(Math.abs(pts) * 5 * contracts).toFixed(0)}`;
}

export default function TradeScreen() {
  const { apiBaseUrl } = useApp();
  const [trade,     setTrade]     = useState<CurrentTrade | null>(null);
  const [price,     setPrice]     = useState<number | null>(null); // live last price for TP progress
  const [loading,   setLoading]   = useState(true);
  const [refreshing,setRefreshing]= useState(false);
  const [clearing,  setClearing]  = useState(false);
  const [elapsed,   setElapsed]   = useState(0);

  const fetchTrade = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const r = await fetch(`${apiBaseUrl}/api/trade/current`);
      const d = await r.json();
      const tr: CurrentTrade | null = d.trade ?? null;
      setTrade(tr);
      // Live price for the "points / % to next TP" readout.
      if (tr) {
        try {
          const pr = await fetch(`${apiBaseUrl}/api/live/bar/${encodeURIComponent(tr.symbol)}`);
          const pd = await pr.json();
          const p = typeof pd?.price === 'number' ? pd.price : (typeof pd?.bar?.close === 'number' ? pd.bar.close : null);
          if (p != null) setPrice(p);
        } catch {}
      } else {
        setPrice(null);
      }
    } catch {}
    setLoading(false); setRefreshing(false);
  }, [apiBaseUrl]);

  // Poll trade + price every 3s (price moves fast; keep the TP progress responsive).
  useEffect(() => { fetchTrade(); const t = setInterval(() => fetchTrade(), 3000); return () => clearInterval(t); }, [fetchTrade]);

  useEffect(() => {
    if (!trade || trade.status !== 'open') { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor(Date.now() / 1000) - trade.firedAt);
    tick(); const t = setInterval(tick, 1000); return () => clearInterval(t);
  }, [trade]);

  async function clearTrade() {
    setClearing(true);
    try { await fetch(`${apiBaseUrl}/api/trade/current/clear`, { method: 'POST' }); setTrade(null); } catch {}
    setClearing(false);
  }

  const isLong = trade?.direction === 'Long';

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* App bar */}
      <View style={s.appBar}>
        <Text style={s.appBarTitle}>OPEN POSITION</Text>
        {trade && (
          <Pressable onPress={clearTrade} disabled={clearing} style={s.clearBtn}>
            <Text style={s.clearBtnTxt}>{clearing ? '…' : 'Clear'}</Text>
          </Pressable>
        )}
      </View>

      <ScrollView contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchTrade(true)} tintColor={Trading.accent} />}>
        {loading ? <LoadingCard /> : !trade ? <NoTrade /> : (
          <TradeCard trade={trade} isLong={isLong!} elapsed={elapsed} price={price} apiBaseUrl={apiBaseUrl} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function LoadingCard() {
  return (
    <View style={s.emptyCard}>
      <ActivityIndicator color={Trading.accent} size="large" />
      <Text style={s.emptyText}>Fetching position…</Text>
    </View>
  );
}

function NoTrade() {
  return (
    <View style={s.emptyCard}>
      <Text style={{ fontSize: 40, color: Trading.dim, marginBottom: 12 }}>○</Text>
      <Text style={s.emptyTitle}>No Active Position</Text>
      <Text style={s.emptyText}>AutoTrader will populate this when a signal fires and an order is placed.</Text>
    </View>
  );
}

function TradeCard({ trade, isLong, elapsed, price, apiBaseUrl }: { trade: CurrentTrade; isLong: boolean; elapsed: number; price: number | null; apiBaseUrl: string }) {
  const slPts  = Math.abs(trade.entry - trade.sl);
  const tp1Pts = Math.abs(trade.entry - trade.tp1);
  const tp2Pts = Math.abs(trade.entry - trade.tp2);
  const rr1    = slPts > 0 ? (tp1Pts / slPts).toFixed(1) : '—';
  const rr2    = slPts > 0 ? (tp2Pts / slPts).toFixed(1) : '—';
  const sc     = statusColor(trade.status);
  const elapsedStr = elapsed > 0 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : '';

  const isOpen = trade.status === 'open';

  return (
    <>
      {/* ── Position header ─────────────────────────────────────────────────── */}
      <Animated.View entering={FadeInDown.springify().damping(16)}>
        <GlowPulse color={isOpen ? sc : (isLong ? Trading.long : Trading.short)} active={isOpen} radius={18}>
          <View style={t.headerCard}>
            <View style={[t.dirBadge, { backgroundColor: (isLong ? Trading.long : Trading.short) + '20', borderColor: (isLong ? Trading.long : Trading.short) + '60' }]}>
              <Text style={[t.dirText, { color: isLong ? Trading.long : Trading.short }]}>
                {isLong ? '▲ LONG' : '▼ SHORT'}
              </Text>
              <Text style={[t.dirContracts, { color: isLong ? Trading.long : Trading.short }]}>
                {trade.contracts}× {trade.symbol}
              </Text>
            </View>

            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              <View style={[t.statusBadge, { backgroundColor: sc + '20', borderColor: sc + '60' }]}>
                {isOpen && <LivePulse color={sc} size={7} />}
                <Text style={[t.statusText, { color: sc }]}>{statusLabel(trade.status)}</Text>
              </View>
              <TierBadge level={trade.riskLevel} size="sm" />
              {elapsedStr ? <Text style={t.elapsed}>{elapsedStr}</Text> : null}
            </View>
          </View>
        </GlowPulse>
      </Animated.View>

      {/* ── Levels — 3-column display ─────────────────────────────────────── */}
      <Animated.View entering={FadeInDown.springify().damping(16).delay(80)} style={t.levelsCard}>
        <Text style={t.sectionLabel}>TRADE LEVELS</Text>
        <View style={t.levelsRow}>
          {/* Stop */}
          <View style={t.levelCol}>
            <Text style={[t.levelTag, { color: Trading.short }]}>STOP</Text>
            <AnimatedNumber value={trade.sl} decimals={2} style={[t.levelPrice, { color: Trading.short, fontFamily: Fonts?.mono }]} />
            <Text style={[t.levelSub, { fontFamily: Fonts?.mono }]}>{slPts.toFixed(1)} pts</Text>
            <Text style={t.levelDol}>{ptsUsd(slPts, trade.contracts)}</Text>
          </View>
          {/* Entry */}
          <View style={[t.levelCol, t.levelColCenter]}>
            <Text style={[t.levelTag, { color: Trading.textSecondary }]}>ENTRY</Text>
            <AnimatedNumber value={trade.entry} decimals={2} style={[t.levelPrice, { color: Trading.text, fontFamily: Fonts?.mono }]} />
            <Text style={[t.levelSub, { color: Trading.muted }]}>@ {fmtTime(trade.firedAt)}</Text>
            <Text style={t.levelDol}>{trade.interval} · {trade.contracts}c</Text>
          </View>
          {/* Target */}
          <View style={t.levelCol}>
            <Text style={[t.levelTag, { color: Trading.long }]}>TARGET</Text>
            <AnimatedNumber value={trade.tp1} decimals={2} style={[t.levelPrice, { color: Trading.long, fontFamily: Fonts?.mono }]} />
            <Text style={[t.levelSub, { fontFamily: Fonts?.mono }]}>{tp1Pts.toFixed(1)} pts</Text>
            <Text style={t.levelDol}>{ptsUsd(tp1Pts, trade.contracts)}</Text>
          </View>
        </View>
        {/* R:R row */}
        <View style={t.rrRow}>
          <View style={t.rrChip}><Text style={t.rrText}>R:R  1 : {rr1}</Text></View>
          {!trade.tp1Only && (
            <View style={t.rrChip}><Text style={t.rrText}>TP2  1 : {rr2}  ·  {trade.tp2.toFixed(2)}</Text></View>
          )}
          {trade.tp1Only && <Text style={[t.rrText, { color: Trading.risky }]}>TP1-only mode</Text>}
        </View>
      </Animated.View>

      {/* ── Next-target progress (points + % to next TP) ────────────────────── */}
      {(trade.status === 'open' || trade.status === 'tp1_hit') && (
        <Animated.View entering={FadeInDown.springify().damping(16).delay(120)}>
          <NextTargetCard trade={trade} isLong={isLong} price={price} />
        </Animated.View>
      )}

      {/* ── Horizontal price track ──────────────────────────────────────────── */}
      <Animated.View entering={FadeInDown.springify().damping(16).delay(160)}>
        <PositionTrack trade={trade} isLong={isLong} />
      </Animated.View>

      {/* ── Mini chart ──────────────────────────────────────────────────────── */}
      <Animated.View entering={FadeIn.duration(500).delay(240)}>
        <MiniChart trade={trade} apiBaseUrl={apiBaseUrl} />
      </Animated.View>
    </>
  );
}

// ── Next-target progress: points + % from entry toward the next TP ─────────────
function NextTargetCard({ trade, isLong, price }: { trade: CurrentTrade; isLong: boolean; price: number | null }) {
  const tp1Hit = trade.status === 'tp1_hit' || trade.status === 'tp2_hit';
  const targetingTp2 = tp1Hit && !trade.tp1Only;
  const nextTp = targetingTp2 ? trade.tp2 : trade.tp1;
  const nextLabel = targetingTp2 ? 'TP2' : 'TP1';
  const cur = price ?? trade.entry;
  // Progress measured from ENTRY → next TP (full leg), clamped 0–100.
  const legTotal = Math.abs(nextTp - trade.entry) || 1;
  const traveled = isLong ? (cur - trade.entry) : (trade.entry - cur);
  const pct = Math.max(0, Math.min(100, (traveled / legTotal) * 100));
  const ptsRemaining = isLong ? (nextTp - cur) : (cur - nextTp);
  const reached = ptsRemaining <= 0;
  const col = reached ? Trading.long : Trading.accent;

  return (
    <View style={nt.card}>
      <View style={nt.head}>
        <Text style={nt.label}>NEXT TARGET · {nextLabel}</Text>
        <Text style={[nt.target, { fontFamily: Fonts?.mono }]}>{nextTp.toFixed(2)}</Text>
      </View>
      <View style={nt.row}>
        <View style={{ flex: 1 }}>
          <Text style={nt.bigLabel}>{reached ? 'TARGET REACHED' : `${ptsRemaining.toFixed(2)} pts to ${nextLabel}`}</Text>
          <Text style={nt.sub}>
            {price == null ? 'waiting for live price…' : `now ${cur.toFixed(2)}  ·  entry ${trade.entry.toFixed(2)}`}
          </Text>
        </View>
        <Text style={[nt.pct, { color: col }]}>{pct.toFixed(0)}%</Text>
      </View>
      <View style={nt.barTrack}>
        <View style={[nt.barFill, { width: `${pct}%` as any, backgroundColor: col }]} />
      </View>
    </View>
  );
}

// ── Horizontal price track ────────────────────────────────────────────────────
function PositionTrack({ trade, isLong }: { trade: CurrentTrade; isLong: boolean }) {
  const lo    = Math.min(trade.sl, trade.tp2, trade.entry) - 1;
  const hi    = Math.max(trade.sl, trade.tp2, trade.entry) + 1;
  const range = hi - lo || 1;
  const pct   = (v: number) => Math.max(0, Math.min(100, ((v - lo) / range) * 100));

  const tp1Hit  = trade.status === 'tp1_hit' || trade.status === 'tp2_hit';
  const tp2Hit  = trade.status === 'tp2_hit';
  const slHit   = trade.status === 'sl_hit';

  return (
    <View style={pt.card}>
      <Text style={pt.label}>PRICE TRACK</Text>
      <View style={pt.track}>
        {/* Risk fill */}
        <View style={[pt.fill, {
          left: `${Math.min(pct(trade.sl), pct(trade.entry))}%` as any,
          width: `${Math.abs(pct(trade.entry) - pct(trade.sl))}%` as any,
          backgroundColor: Trading.short + '30',
        }]} />
        {/* Reward fill (TP1) */}
        <View style={[pt.fill, {
          left: `${Math.min(pct(trade.entry), pct(trade.tp1))}%` as any,
          width: `${Math.abs(pct(trade.tp1) - pct(trade.entry))}%` as any,
          backgroundColor: Trading.long + '22',
        }]} />
        {/* Reward fill (TP2) */}
        {!trade.tp1Only && (
          <View style={[pt.fill, {
            left: `${Math.min(pct(trade.tp1), pct(trade.tp2))}%` as any,
            width: `${Math.abs(pct(trade.tp2) - pct(trade.tp1))}%` as any,
            backgroundColor: Trading.long + '14',
          }]} />
        )}
        {/* Markers */}
        {[
          { label: 'SL',    price: trade.sl,    color: slHit  ? Trading.short : Trading.short + '99', filled: slHit },
          { label: 'Entry', price: trade.entry,  color: Trading.text },
          { label: 'TP1',   price: trade.tp1,    color: tp1Hit ? Trading.long : Trading.long + '99',   filled: tp1Hit },
          ...(!trade.tp1Only ? [{ label: 'TP2', price: trade.tp2, color: tp2Hit ? Trading.long : Trading.long + '66', filled: tp2Hit }] : []),
        ].map(m => (
          <View key={m.label} style={[pt.marker, { left: `${pct(m.price)}%` as any, borderColor: m.color }]}>
            {(m as any).filled && <View style={[pt.markerFill, { backgroundColor: m.color }]} />}
            <Text style={[pt.markerLabel, { color: m.color }]}>{m.label}</Text>
          </View>
        ))}
      </View>
      {/* Legend */}
      <View style={pt.legend}>
        <Text style={[pt.legendPrice, { color: Trading.short, fontFamily: Fonts?.mono }]}>{Math.min(trade.sl, trade.tp2).toFixed(2)}</Text>
        <Text style={[pt.legendPrice, { color: Trading.text,  fontFamily: Fonts?.mono }]}>{trade.entry.toFixed(2)}</Text>
        <Text style={[pt.legendPrice, { color: Trading.long,  fontFamily: Fonts?.mono }]}>{Math.max(trade.tp1, trade.tp2).toFixed(2)}</Text>
      </View>
    </View>
  );
}

// ── Mini chart ────────────────────────────────────────────────────────────────
function MiniChart({ trade, apiBaseUrl }: { trade: CurrentTrade; apiBaseUrl: string }) {
  const webviewRef   = useRef<any>(null);
  const [html, setHtml] = useState<string | null>(null);
  const candlesRef   = useRef<any[] | null>(null);
  const injectedRef  = useRef(false);

  useEffect(() => { getMiniLwScript().then(script => setHtml(buildMiniHtml(script))).catch(() => {}); }, []);

  useEffect(() => {
    const resMap: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '5m', '60m': '60m' };
    const lookback: Record<string, number> = { '1m': 4*3600, '5m': 24*3600, '15m': 24*3600, '60m': 7*24*3600 };
    const res = resMap[trade.interval] ?? '5m';
    const now = Math.floor(Date.now() / 1000);
    const from = now - (lookback[trade.interval] ?? 24*3600);
    fetch(`${apiBaseUrl}/api/data/candles/${trade.symbol}/${res}?from=${from}&to=${now}`)
      .then(r => r.json()).then((d: any) => { candlesRef.current = d.candles ?? []; }).catch(() => {});
  }, [trade.symbol, trade.interval, apiBaseUrl]);

  function tryInject() {
    if (injectedRef.current || !webviewRef.current) return;
    if (!candlesRef.current) { setTimeout(tryInject, 500); return; }
    injectedRef.current = true;
    webviewRef.current.injectJavaScript(
      `window.setMiniData(${JSON.stringify(candlesRef.current)},${JSON.stringify({ entry: trade.entry, tp1: trade.tp1, tp2: trade.tp2, sl: trade.sl })});true;`
    );
  }

  if (!html) return (
    <View style={[m.card, { height: 180, alignItems: 'center', justifyContent: 'center' }]}>
      <ActivityIndicator color={Trading.accent} />
    </View>
  );

  return (
    <View style={m.card}>
      <Text style={m.label}>CHART</Text>
      <View style={{ height: 200, borderRadius: 8, overflow: 'hidden' }}>
        <WebView ref={webviewRef} source={{ html }} style={{ flex: 1, backgroundColor: Trading.surface }}
          scrollEnabled={false} javaScriptEnabled originWhitelist={['*']}
          onMessage={(e) => { try { const msg = JSON.parse(e.nativeEvent.data); if (msg.type === 'ready') tryInject(); } catch {} }} />
      </View>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Trading.bg },
  appBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Trading.border },
  appBarTitle: { color: Trading.text, fontSize: 13, fontWeight: '800', letterSpacing: 2 },
  clearBtn:    { paddingHorizontal: 14, paddingVertical: 7, backgroundColor: Trading.short + '20', borderRadius: 8, borderWidth: 1, borderColor: Trading.short + '55' },
  clearBtnTxt: { color: Trading.short, fontSize: 13, fontWeight: '700' },
  scroll:  { paddingBottom: 48, gap: 12, paddingTop: 12, paddingHorizontal: 14 },
  emptyCard: { marginTop: 60, alignItems: 'center', gap: 12, paddingHorizontal: 32 },
  emptyTitle:{ color: Trading.text, fontSize: 18, fontWeight: '700' },
  emptyText: { color: Trading.muted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
});

// Trade card components
const t = StyleSheet.create({
  headerCard: {
    backgroundColor: Trading.surface, borderRadius: 12, borderWidth: 1, borderColor: Trading.border,
    padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
  },
  dirBadge: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, gap: 2 },
  dirText:  { fontSize: 20, fontWeight: '900', letterSpacing: 0.5 },
  dirContracts: { fontSize: 11, fontWeight: '700' },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  statusText:  { fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  elapsed:     { color: Trading.muted, fontSize: 11 },

  levelsCard: {
    backgroundColor: Trading.surface, borderRadius: 12, borderWidth: 1, borderColor: Trading.border, padding: 16, gap: 14,
  },
  sectionLabel: { color: Trading.muted, fontSize: 9, fontWeight: '700', letterSpacing: 2 },
  levelsRow:    { flexDirection: 'row' },
  levelCol:     { flex: 1, alignItems: 'center', gap: 3 },
  levelColCenter:{ borderLeftWidth: 1, borderRightWidth: 1, borderColor: Trading.border },
  levelTag:     { fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },
  levelPrice:   { fontSize: 20, fontWeight: '800' },
  levelSub:     { fontSize: 10, color: Trading.textSecondary },
  levelDol:     { fontSize: 9, color: Trading.muted },
  rrRow:   { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  rrChip:  { backgroundColor: Trading.surfaceAlt, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: Trading.border },
  rrText:  { color: Trading.textSecondary, fontSize: 11, fontWeight: '600' },
});

// Position track
const pt = StyleSheet.create({
  card:  { backgroundColor: Trading.surface, borderRadius: 12, borderWidth: 1, borderColor: Trading.border, padding: 16, gap: 12 },
  label: { color: Trading.muted, fontSize: 9, fontWeight: '700', letterSpacing: 2 },
  track: { height: 36, backgroundColor: Trading.surfaceAlt, borderRadius: 8, position: 'relative', overflow: 'visible' },
  fill:  { position: 'absolute', top: 0, bottom: 0 },
  marker:{ position: 'absolute', top: 0, bottom: 0, width: 2, borderLeftWidth: 2, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 2 },
  markerFill: { position: 'absolute', top: -3, left: -4, width: 8, height: 8, borderRadius: 4 },
  markerLabel:{ fontSize: 8, fontWeight: '800', marginLeft: 4 },
  legend:{ flexDirection: 'row', justifyContent: 'space-between' },
  legendPrice: { fontSize: 10 },
});

// Mini chart
const m = StyleSheet.create({
  card:  { backgroundColor: Trading.surface, borderRadius: 12, borderWidth: 1, borderColor: Trading.border, padding: 14, gap: 10 },
  label: { color: Trading.muted, fontSize: 9, fontWeight: '700', letterSpacing: 2 },
});

// Next-target progress
const nt = StyleSheet.create({
  card:     { backgroundColor: Trading.surface, borderRadius: 12, borderWidth: 1, borderColor: Trading.border, padding: 16, gap: 12 },
  head:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label:    { color: Trading.muted, fontSize: 9, fontWeight: '700', letterSpacing: 2 },
  target:   { color: Trading.long, fontSize: 14, fontWeight: '800' },
  row:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 },
  bigLabel: { color: Trading.text, fontSize: 16, fontWeight: '800' },
  sub:      { color: Trading.muted, fontSize: 11, marginTop: 2 },
  pct:      { fontSize: 26, fontWeight: '900', letterSpacing: 0.5 },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: Trading.surfaceAlt, overflow: 'hidden' },
  barFill:  { height: 8, borderRadius: 4 },
});
