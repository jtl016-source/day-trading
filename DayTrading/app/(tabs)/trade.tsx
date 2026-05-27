import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, RefreshControl, ActivityIndicator,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '@/context/app-context';
import { Trading } from '@/constants/theme';

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
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#0d0f17;overflow:hidden;width:100%;height:100%}
#chart{width:100%;height:100%}
</style>
</head><body>
<div id="chart"></div>
<script>${lwScript}</script>
<script>
var chart, candleSeries, priceLines = [];
function init() {
  chart = LightweightCharts.createChart(document.getElementById('chart'), {
    width: window.innerWidth, height: window.innerHeight,
    layout: { background: { color: '#0d0f17' }, textColor: '#9ca3af' },
    grid: { vertLines: { color: '#1c2030' }, horzLines: { color: '#1c2030' } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1c2030' },
    rightPriceScale: { borderColor: '#1c2030', scaleMargins: { top: 0.15, bottom: 0.15 } },
    crosshair: { mode: 1 },
    handleScale: true, handleScroll: true,
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: '#26c87a', downColor: '#ef5350',
    borderUpColor: '#26c87a', borderDownColor: '#ef5350',
    wickUpColor: '#26c87a', wickDownColor: '#ef5350',
  });
  window.addEventListener('resize', function() { chart.resize(window.innerWidth, window.innerHeight); });
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' })); } catch(e) {}
}
window.setMiniData = function(candles, levels) {
  for (var i = 0; i < priceLines.length; i++) { try { candleSeries.removePriceLine(priceLines[i]); } catch(e) {} }
  priceLines = [];
  if (candles && candles.length) candleSeries.setData(candles);
  if (levels) {
    priceLines.push(candleSeries.createPriceLine({ price: levels.entry, color: '#e8eaf0', lineWidth: 1, lineStyle: 0, title: 'Entry', axisLabelVisible: true }));
    priceLines.push(candleSeries.createPriceLine({ price: levels.tp1,   color: '#26c87a', lineWidth: 1, lineStyle: 1, title: 'TP1',   axisLabelVisible: true }));
    if (levels.tp2 && Math.abs(levels.tp2 - levels.tp1) > 0.01)
      priceLines.push(candleSeries.createPriceLine({ price: levels.tp2, color: '#26c87a', lineWidth: 2, lineStyle: 0, title: 'TP2', axisLabelVisible: true }));
    priceLines.push(candleSeries.createPriceLine({ price: levels.sl,    color: '#ef5350', lineWidth: 1, lineStyle: 1, title: 'SL',    axisLabelVisible: true }));
    chart.timeScale().fitContent();
  }
};
init();
</script></body></html>`;
}

interface CurrentTrade {
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
  firedAt: number;
  status: 'open' | 'tp1_hit' | 'tp2_hit' | 'sl_hit';
}

function riskColor(level: string): string {
  if (level === 'safe' || level === 'safeplus') return Trading.green;
  if (level === 'risky') return Trading.orange;
  return Trading.purple;
}

function statusColor(status: CurrentTrade['status']): string {
  if (status === 'tp2_hit' || status === 'tp1_hit') return Trading.green;
  if (status === 'sl_hit') return Trading.red;
  return Trading.accent;
}

function statusLabel(status: CurrentTrade['status']): string {
  if (status === 'tp2_hit') return 'TP2 Hit';
  if (status === 'tp1_hit') return 'TP1 Hit';
  if (status === 'sl_hit') return 'SL Hit';
  return 'Open';
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'America/New_York',
  });
}

function fmtPts(val: number, entry: number): string {
  const diff = val - entry;
  return diff >= 0 ? `+${diff.toFixed(2)} pts` : `${diff.toFixed(2)} pts`;
}

export default function TradeScreen() {
  const { apiBaseUrl } = useApp();
  const [trade, setTrade] = useState<CurrentTrade | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const fetchTrade = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const r = await fetch(`${apiBaseUrl}/api/trade/current`);
      const d = await r.json();
      setTrade(d.trade ?? null);
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, [apiBaseUrl]);

  // Initial load + poll every 5 seconds
  useEffect(() => {
    fetchTrade();
    const t = setInterval(() => fetchTrade(), 5000);
    return () => clearInterval(t);
  }, [fetchTrade]);

  // Elapsed timer — updates every second when trade is open
  useEffect(() => {
    if (!trade || trade.status !== 'open') { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor(Date.now() / 1000) - trade.firedAt);
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [trade]);

  async function clearTrade() {
    setClearing(true);
    try {
      await fetch(`${apiBaseUrl}/api/trade/current/clear`, { method: 'POST' });
      setTrade(null);
    } catch {}
    setClearing(false);
  }

  const isLong = trade?.direction === 'Long';

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.headerBar}>
        <Text style={s.title}>Current Trade</Text>
        {trade && (
          <Pressable style={s.clearBtn} onPress={clearTrade} disabled={clearing}>
            <Text style={s.clearBtnText}>{clearing ? 'Clearing…' : 'Clear'}</Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchTrade(true)} tintColor={Trading.accent} />}
      >
        {loading ? (
          <LoadingCard />
        ) : !trade ? (
          <NoTrade />
        ) : (
          <TradeCard trade={trade} isLong={isLong} elapsed={elapsed} apiBaseUrl={apiBaseUrl} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function LoadingCard() {
  return (
    <View style={s.loadingCard}>
      <ActivityIndicator color={Trading.accent} size="large" />
      <Text style={s.loadingText}>Awaiting trade data…</Text>
      <View style={[s.skeleton, { width: '100%' }]} />
      <View style={[s.skeleton, { width: '75%' }]} />
      <View style={[s.skeleton, { width: '85%' }]} />
    </View>
  );
}

function NoTrade() {
  return (
    <View style={s.noTrade}>
      <Text style={s.noTradeIcon}>—</Text>
      <Text style={s.noTradeTitle}>No Active Trade</Text>
      <Text style={s.noTradeSub}>AutoTrader will populate this when a signal fires.</Text>
    </View>
  );
}

function MiniChart({ trade, apiBaseUrl }: { trade: CurrentTrade; apiBaseUrl: string }) {
  const webviewRef = useRef<any>(null);
  const [html, setHtml] = useState<string | null>(null);
  const candlesRef = useRef<any[] | null>(null);
  const injectedRef = useRef(false);

  useEffect(() => {
    getMiniLwScript().then(script => setHtml(buildMiniHtml(script))).catch(() => {});
  }, []);

  useEffect(() => {
    const resMap: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '5m', '60m': '60m' };
    const lookbackSec: Record<string, number> = { '1m': 4 * 3600, '5m': 24 * 3600, '15m': 24 * 3600, '60m': 7 * 24 * 3600 };
    const res = resMap[trade.interval] ?? '5m';
    const now = Math.floor(Date.now() / 1000);
    const from = now - (lookbackSec[trade.interval] ?? 24 * 3600);
    fetch(`${apiBaseUrl}/api/data/candles/${trade.symbol}/${res}?from=${from}&to=${now}`)
      .then(r => r.json())
      .then((d: any) => { candlesRef.current = d.candles ?? []; })
      .catch(() => {});
  }, [trade.symbol, trade.interval, apiBaseUrl]);

  function tryInject() {
    if (injectedRef.current || !webviewRef.current) return;
    if (!candlesRef.current) { setTimeout(tryInject, 500); return; }
    injectedRef.current = true;
    const levels = { entry: trade.entry, tp1: trade.tp1, tp2: trade.tp2, sl: trade.sl };
    const js = `window.setMiniData(${JSON.stringify(candlesRef.current)},${JSON.stringify(levels)});true;`;
    webviewRef.current.injectJavaScript(js);
  }

  function onMessage(event: any) {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') tryInject();
    } catch {}
  }

  if (!html) {
    return (
      <View style={[s.card, { height: 240, alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={Trading.accent} />
      </View>
    );
  }

  return (
    <View style={s.card}>
      <Text style={s.cardHeader}>CHART</Text>
      <View style={{ height: 210, borderRadius: 8, overflow: 'hidden' }}>
        <WebView
          ref={webviewRef}
          source={{ html }}
          style={{ flex: 1, backgroundColor: '#0d0f17' }}
          scrollEnabled={false}
          onMessage={onMessage}
          javaScriptEnabled
          originWhitelist={['*']}
        />
      </View>
    </View>
  );
}

function TradeCard({ trade, isLong, elapsed, apiBaseUrl }: { trade: CurrentTrade; isLong: boolean; elapsed: number; apiBaseUrl: string }) {
  const sl_pts = Math.abs(trade.entry - trade.sl);
  const tp1_pts = Math.abs(trade.entry - trade.tp1);
  const tp2_pts = Math.abs(trade.entry - trade.tp2);
  const rr1 = (tp1_pts / sl_pts).toFixed(1);
  const rr2 = (tp2_pts / sl_pts).toFixed(1);

  const elapsedStr = elapsed > 0
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : '';

  return (
    <>
      {/* Header row — direction + status */}
      <View style={[s.card, s.dirCard]}>
        <View style={[s.dirBadge, { backgroundColor: isLong ? Trading.green + '22' : Trading.red + '22', borderColor: isLong ? Trading.green : Trading.red }]}>
          <Text style={[s.dirText, { color: isLong ? Trading.green : Trading.red }]}>
            {isLong ? '▲ LONG' : '▼ SHORT'}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <View style={[s.statusBadge, { backgroundColor: statusColor(trade.status) + '22', borderColor: statusColor(trade.status) }]}>
            <Text style={[s.statusText, { color: statusColor(trade.status) }]}>{statusLabel(trade.status)}</Text>
          </View>
          {elapsedStr ? <Text style={s.elapsed}>{elapsedStr}</Text> : null}
        </View>
      </View>

      {/* Entry info */}
      <View style={s.card}>
        <Row label="Symbol" value={trade.symbol} />
        <Row label="Interval" value={trade.interval} />
        <Row label="Risk Level" value={trade.riskLevel.toUpperCase()} valueColor={riskColor(trade.riskLevel)} />
        <Row label="Contracts" value={`${trade.contracts}x`} />
        <Row label="Fired At" value={fmtTime(trade.firedAt)} />
      </View>

      {/* Price levels */}
      <View style={s.card}>
        <Text style={s.cardHeader}>LEVELS</Text>
        <LevelRow label="Entry" price={trade.entry} diff={null} color={Trading.text} />
        <LevelRow label="TP1" price={trade.tp1} diff={fmtPts(trade.tp1, trade.entry)} color={Trading.green} note={`R:R  1:${rr1}`} />
        {!trade.tp1Only && (
          <LevelRow label="TP2" price={trade.tp2} diff={fmtPts(trade.tp2, trade.entry)} color={Trading.green} note={`R:R  1:${rr2}`} />
        )}
        <LevelRow label="Stop" price={trade.sl} diff={fmtPts(trade.sl, trade.entry)} color={Trading.red} />
        {trade.tp1Only && (
          <Text style={s.tp1OnlyNote}>TP1-only mode</Text>
        )}
      </View>

      {/* Visual price bar */}
      <PriceBar trade={trade} isLong={isLong} />

      {/* Mini chart */}
      <MiniChart trade={trade} apiBaseUrl={apiBaseUrl} />
    </>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, valueColor ? { color: valueColor } : {}]}>{value}</Text>
    </View>
  );
}

function LevelRow({ label, price, diff, color, note }: { label: string; price: number; diff: string | null; color: string; note?: string }) {
  return (
    <View style={s.levelRow}>
      <Text style={[s.levelLabel, { color }]}>{label}</Text>
      <View style={{ flex: 1, alignItems: 'flex-end', gap: 2 }}>
        <Text style={[s.levelPrice, { color }]}>{price.toFixed(2)}</Text>
        {diff && <Text style={s.levelDiff}>{diff}{note ? `  ·  ${note}` : ''}</Text>}
      </View>
    </View>
  );
}

function PriceBar({ trade, isLong }: { trade: CurrentTrade; isLong: boolean }) {
  const lo = Math.min(trade.sl, trade.tp2);
  const hi = Math.max(trade.sl, trade.tp2);
  const range = hi - lo || 1;

  function pct(v: number) { return ((v - lo) / range) * 100; }

  const markers: { label: string; price: number; color: string }[] = [
    { label: 'SL', price: trade.sl, color: Trading.red },
    { label: 'Entry', price: trade.entry, color: Trading.text },
    { label: 'TP1', price: trade.tp1, color: Trading.green },
    { label: 'TP2', price: trade.tp2, color: Trading.green },
  ].filter(m => m.price !== trade.entry || m.label === 'Entry');

  return (
    <View style={s.card}>
      <Text style={s.cardHeader}>RANGE VIEW</Text>
      <View style={s.barTrack}>
        {/* Risk region (entry→sl) */}
        <View style={[s.barFill, {
          left: `${Math.min(pct(trade.sl), pct(trade.entry))}%` as any,
          width: `${Math.abs(pct(trade.entry) - pct(trade.sl))}%` as any,
          backgroundColor: Trading.red + '33',
        }]} />
        {/* Reward region (entry→tp2) */}
        <View style={[s.barFill, {
          left: `${Math.min(pct(trade.entry), pct(trade.tp2))}%` as any,
          width: `${Math.abs(pct(trade.tp2) - pct(trade.entry))}%` as any,
          backgroundColor: Trading.green + '33',
        }]} />
        {markers.map(m => (
          <View key={m.label} style={[s.barMarker, { left: `${pct(m.price)}%` as any, borderColor: m.color }]}>
            <Text style={[s.barMarkerLabel, { color: m.color }]}>{m.label}</Text>
          </View>
        ))}
      </View>
      <View style={s.barLegend}>
        <Text style={[s.barLegendText, { color: Trading.red }]}>{lo.toFixed(2)}</Text>
        <Text style={[s.barLegendText, { color: Trading.muted }]}>{((lo + hi) / 2).toFixed(2)}</Text>
        <Text style={[s.barLegendText, { color: Trading.green }]}>{hi.toFixed(2)}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Trading.bg },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Trading.border,
  },
  title: { color: Trading.text, fontSize: 20, fontWeight: '700' },
  clearBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: Trading.red + '22',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Trading.red,
  },
  clearBtnText: { color: Trading.red, fontSize: 13, fontWeight: '700' },
  scroll: { paddingBottom: 40, gap: 12, paddingTop: 12, paddingHorizontal: 16 },
  loadingCard: {
    margin: 16,
    backgroundColor: Trading.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Trading.border,
    padding: 32,
    alignItems: 'center',
    gap: 16,
    marginTop: 24,
  },
  loadingText: { color: Trading.dim, fontSize: 14 },
  skeleton: {
    height: 12,
    borderRadius: 6,
    backgroundColor: Trading.surfaceAlt,
    opacity: 0.6,
  },
  noTrade: { alignItems: 'center', marginTop: 80, gap: 12 },
  noTradeIcon: { color: Trading.muted, fontSize: 48, fontWeight: '100' },
  noTradeTitle: { color: Trading.text, fontSize: 20, fontWeight: '700' },
  noTradeSub: { color: Trading.muted, fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  card: {
    backgroundColor: Trading.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Trading.border,
    padding: 16,
    gap: 10,
  },
  cardHeader: {
    color: Trading.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  dirCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dirBadge: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  dirText: { fontSize: 18, fontWeight: '800', letterSpacing: 0.5 },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusText: { fontSize: 13, fontWeight: '700' },
  elapsed: { color: Trading.muted, fontSize: 12 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowLabel: { color: Trading.muted, fontSize: 14 },
  rowValue: { color: Trading.text, fontSize: 14, fontWeight: '600' },
  levelRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  levelLabel: { fontSize: 14, fontWeight: '700', width: 50, paddingTop: 2 },
  levelPrice: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  levelDiff: { color: Trading.muted, fontSize: 11 },
  tp1OnlyNote: { color: Trading.orange, fontSize: 12, fontStyle: 'italic' },
  barTrack: {
    height: 32,
    backgroundColor: Trading.surfaceAlt,
    borderRadius: 6,
    position: 'relative',
    marginTop: 8,
    overflow: 'hidden',
  },
  barFill: { position: 'absolute', top: 0, bottom: 0 },
  barMarker: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    borderLeftWidth: 2,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 2,
  },
  barMarkerLabel: { fontSize: 9, fontWeight: '700', marginLeft: 3 },
  barLegend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  barLegendText: { fontSize: 11 },
});
