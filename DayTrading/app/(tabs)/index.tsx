import { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import Animated, {
  FadeInDown, FadeIn, useSharedValue, useAnimatedStyle, withTiming, Easing,
} from 'react-native-reanimated';
import { useApp, type Timeframe } from '@/context/app-context';
import { useMarketData, normalizeSymbol } from '@/hooks/use-market-data';
import { useTradeStatus } from '@/hooks/use-trade-status';
import { MeridianHeader } from '@/components/meridian-header';
import { ChartView } from '@/components/chart-view';
import { StrategySheet, type StrategySheetRef } from '@/components/strategy-sheet';
import { ReloadIcon } from '@/components/meridian-icons';
import { Trading, Fonts } from '@/constants/theme';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '60m'];
const SYMBOL_NAMES: Record<string, string> = {
  MES: 'MICRO E-MINI S&P 500', ES: 'E-MINI S&P 500',
  MNQ: 'MICRO E-MINI NASDAQ', NQ: 'E-MINI NASDAQ',
  MYM: 'MICRO E-MINI DOW', YM: 'E-MINI DOW',
};

export default function MarketScreen() {
  const { instrument, timeframe, setTimeframe, strategies } = useApp();
  const { candles, stats, signals, loading, error, source, lastUpdated, refresh } = useMarketData();
  const { connected, trade } = useTradeStatus();
  const sheetRef = useRef<StrategySheetRef>(null);

  const [chartKey, setChartKey] = useState(0);

  // Replay the wave reveal on focus and whenever fresh data lands.
  useFocusEffect(useCallback(() => { setChartKey(k => k + 1); }, []));
  useEffect(() => { if (lastUpdated) setChartKey(k => k + 1); }, [lastUpdated]);

  // Spinning refresh icon
  const spin = useSharedValue(0);
  const spinStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * -360}deg` }] }));
  const onRefresh = () => {
    spin.value = 0;
    spin.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) });
    refresh();
  };

  const sym = normalizeSymbol(instrument);
  const live = connected || (!!stats && source !== 'none' && source !== 'unknown');
  const up = stats ? stats.up : true;
  const dirColor = up ? Trading.long : Trading.short;

  const activeStrats = [
    strategies.milkZones && 'MilkZone',
    strategies.vector && 'Vector',
    strategies.footprint && 'Footprint',
  ].filter(Boolean) as string[];

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <MeridianHeader live={live} onOpenStrategies={() => sheetRef.current?.present()} />

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        <Animated.View entering={FadeIn.duration(300)}>
          {/* ── Symbol + price + change (compact floating panel) ────────────── */}
          <View style={s.topRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={s.symRow}>
                <Text style={s.sym}>{sym}</Text>
                <Text style={s.symName} numberOfLines={1}>{SYMBOL_NAMES[sym] ?? 'FUTURES'}</Text>
              </View>
              <View style={s.priceRow}>
                <Text style={[s.last, { color: dirColor }]}>{stats ? stats.last.toFixed(2) : '—'}</Text>
                {stats && (
                  <Text style={[s.chg, { color: dirColor }]}>
                    {up ? '▲' : '▼'} {Math.abs(stats.change).toFixed(2)} ({up ? '+' : '−'}{Math.abs(stats.changePct).toFixed(2)}%)
                  </Text>
                )}
              </View>
            </View>
            <Pressable style={s.refreshBtn} onPress={onRefresh} hitSlop={8}>
              <Animated.View style={spinStyle}><ReloadIcon size={14} color={Trading.accent} /></Animated.View>
            </Pressable>
          </View>

          {/* ── Stat row ────────────────────────────────────────────────────── */}
          <View style={s.statRow}>
            <Stat label="DAY HIGH" value={stats ? stats.dayHigh.toFixed(2) : '—'} />
            <Stat label="DAY LOW"  value={stats ? stats.dayLow.toFixed(2) : '—'} />
            <Stat label="ATR-14"   value={stats?.atr != null ? stats.atr.toFixed(2) : '—'} />
          </View>

          {/* ── Timeframe ───────────────────────────────────────────────────── */}
          <View style={s.tfRow}>
            {TIMEFRAMES.map(tf => (
              <Pressable key={tf} onPress={() => setTimeframe(tf)}
                style={[s.tfBtn, timeframe === tf && s.tfBtnOn]}>
                <Text style={[s.tfLbl, timeframe === tf && { color: Trading.accent }]}>{tf}</Text>
              </Pressable>
            ))}
          </View>

          {/* ── Chart — PC-style WebView chart: candles + vector + milk zones +
                footprint, all driven by the strategies toggle (1:1 with the PC). ── */}
          <View style={s.chartWrap}>
            <ChartView />
          </View>

          {/* ── Active strategy chips ───────────────────────────────────────── */}
          <View style={s.chips}>
            {activeStrats.length === 0
              ? <View style={[s.chip, s.chipOff]}><Text style={[s.chipTxt, { color: Trading.dim }]}>NO ACTIVE STRATEGIES</Text></View>
              : activeStrats.map(name => (
                  <View key={name} style={s.chip}><Text style={s.chipTxt}>{name}</Text></View>
                ))}
          </View>

          {/* ── Active position (folded-in Position screen entry) ───────────── */}
          {trade && trade.status === 'open' && (
            <Animated.View entering={FadeInDown.springify().damping(16)}>
              <Pressable style={s.posCard} onPress={() => router.push('/(tabs)/trade')}>
                <View style={s.posTop}>
                  <Text style={s.posLabel}>ACTIVE POSITION</Text>
                  <Text style={[s.posDir, { color: trade.direction === 'Long' ? Trading.long : Trading.short }]}>
                    {trade.direction === 'Long' ? '▲ LONG' : '▼ SHORT'} ×{trade.contracts}
                  </Text>
                </View>
                <View style={s.posGrid}>
                  <PosCell label="ENTRY" value={trade.entry.toFixed(2)} color={Trading.text} />
                  <PosCell label="STOP"  value={trade.sl.toFixed(2)}    color={Trading.short} />
                  <PosCell label="TP1"   value={trade.tp1.toFixed(2)}   color={Trading.long} />
                  <PosCell label="TP2"   value={trade.tp2.toFixed(2)}   color={Trading.long} />
                </View>
                <Text style={s.posMore}>View position →</Text>
              </Pressable>
            </Animated.View>
          )}

          <View style={{ height: 24 }} />
        </Animated.View>
      </ScrollView>

      <StrategySheet ref={sheetRef} signals={signals} />
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.statCell}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
    </View>
  );
}

function PosCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={s.posCell}>
      <Text style={s.posCellLabel}>{label}</Text>
      <Text style={[s.posCellValue, { color }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  scroll: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 16, gap: 13 },

  topRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 10, marginTop: 4,
    backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9,
  },
  symRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  sym: { fontFamily: Fonts.display, fontSize: 12, fontWeight: '700', letterSpacing: 1.5, color: Trading.text },
  symName: { flex: 1, fontSize: 8, color: Trading.muted, letterSpacing: 0.8, fontWeight: '500' },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 3 },
  last: { fontFamily: Fonts.mono, fontSize: 22, fontWeight: '600', lineHeight: 24 },
  chg: { fontFamily: Fonts.mono, fontSize: 11 },
  refreshBtn: { width: 32, height: 32, borderRadius: 9, backgroundColor: Trading.glass2, borderWidth: 1, borderColor: Trading.line, alignItems: 'center', justifyContent: 'center' },

  statRow: { flexDirection: 'row', gap: 8 },
  statCell: { flex: 1, backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9 },
  statLabel: { fontSize: 8, letterSpacing: 1, color: Trading.muted, fontWeight: '600' },
  statValue: { fontFamily: Fonts.mono, fontSize: 15, fontWeight: '600', color: Trading.text, marginTop: 3 },

  tfRow: { flexDirection: 'row', gap: 6 },
  tfBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass, alignItems: 'center' },
  tfBtnOn: { borderColor: 'rgba(45,212,191,0.4)', backgroundColor: 'rgba(45,212,191,0.14)' },
  tfLbl: { fontFamily: Fonts.mono, fontSize: 12, fontWeight: '600', color: Trading.muted },

  chartWrap: { position: 'relative', height: 360, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: Trading.line, marginTop: 4 },
  chartOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 6 },
  errTxt: { color: Trading.muted, fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  errSub: { color: Trading.dim, fontSize: 11 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { backgroundColor: 'rgba(45,212,191,0.08)', borderWidth: 1, borderColor: 'rgba(45,212,191,0.25)', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 7 },
  chipOff: { backgroundColor: 'transparent', borderColor: Trading.line },
  chipTxt: { fontFamily: Fonts.mono, fontSize: 9, fontWeight: '600', letterSpacing: 0.5, color: Trading.accent },

  posCard: { backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.borderAccent, borderRadius: 12, padding: 12, gap: 10 },
  posTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  posLabel: { fontFamily: Fonts.display, fontSize: 10, letterSpacing: 1.5, color: Trading.muted, fontWeight: '600' },
  posDir: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  posGrid: { flexDirection: 'row', gap: 6 },
  posCell: { flex: 1 },
  posCellLabel: { fontSize: 8, color: Trading.dim, letterSpacing: 0.5 },
  posCellValue: { fontFamily: Fonts.mono, fontSize: 13, fontWeight: '600', marginTop: 2 },
  posMore: { fontSize: 11, color: Trading.accent, fontWeight: '600' },
});
