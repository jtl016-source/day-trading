import { useState, useCallback } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { useApp } from '@/context/app-context';
import { normalizeSymbol } from '@/hooks/use-market-data';
import { mapDbSignal, type MobileSignal } from '@/lib/signal-map';
import { Trading, Fonts, TIER, type TierKey } from '@/constants/theme';

// ── Types ─────────────────────────────────────────────────────────────────────
type TierFilter  = 'all' | TierKey;
type DirFilter   = 'all' | 'long' | 'short';
type SessionFilter = 'all' | 'rth' | 'eth';

interface TierStat { count: number; wins: number; losses: number; open: number; pts: number }

// ── Constants ─────────────────────────────────────────────────────────────────
const SYMBOLS    = ['MES', 'ES', 'MNQ', 'NQ'] as const;
const INTERVALS  = ['1m', '5m', '15m', '60m'] as const;
const DAY_RANGES = [7, 14, 30, 60, 90, 180, 365] as const;
const MES_PER_PT = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────
function isRTH(ts: number): boolean {
  const d = new Date(ts * 1000);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 13 * 60 + 30 && m < 20 * 60;
}
function fmtDateTime(ts: number) {
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'America/New_York',
  });
}
function fmtPts(n: number) { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`; }

const OUTCOME_COLOR: Record<string, string> = {
  Win: Trading.long, Loss: Trading.short, Open: Trading.amber,
};
const OUTCOME_LABEL: Record<string, string> = { Win: 'TP1 WIN', Loss: 'LOSS', Open: 'OPEN' };
const TIER_FILTERS: TierFilter[] = ['all', 'safeplus', 'safe', 'risky', 'riskiest'];

function tierColor(rl: string): string { return TIER[rl as TierKey]?.color ?? Trading.risky; }

// ── Screen ────────────────────────────────────────────────────────────────────
export default function BacktestScreen() {
  const { apiBaseUrl, instrument } = useApp();

  const [symbol,   setSymbol]   = useState<typeof SYMBOLS[number]>(
    (SYMBOLS.includes(normalizeSymbol(instrument) as any) ? normalizeSymbol(instrument) : 'MES') as typeof SYMBOLS[number],
  );
  const [interval, setInterval] = useState<typeof INTERVALS[number]>('5m');
  const [days,     setDays]     = useState<typeof DAY_RANGES[number]>(90);
  const [tier,     setTier]     = useState<TierFilter>('all');
  const [dir,      setDir]      = useState<DirFilter>('all');
  const [session,  setSession]  = useState<SessionFilter>('rth');

  const [loading,  setLoading]  = useState(false);
  const [signals,  setSignals]  = useState<MobileSignal[] | null>(null);
  const [error,    setError]    = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSignals(null);
    try {
      const url = `${apiBaseUrl}/api/signals/history/${encodeURIComponent(symbol)}/${interval}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      const allRows: any[] = raw.signals ?? raw ?? [];
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const mapped = allRows
        .filter((s: any) => s.timestamp >= cutoff)
        .map(mapDbSignal)
        .sort((a, b) => b.time - a.time);
      setSignals(mapped);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
    setLoading(false);
  }, [apiBaseUrl, symbol, interval, days]);

  // Apply UI filters
  const rows = (signals ?? []).filter(s => {
    if (tier !== 'all' && s.riskLevel !== tier) return false;
    if (dir === 'long' && s.direction !== 'Long') return false;
    if (dir === 'short' && s.direction !== 'Short') return false;
    if (session === 'rth' && !s.rth) return false;
    if (session === 'eth' && s.rth) return false;
    return true;
  });

  // Stats across filtered rows
  const decided = rows.filter(s => s.outcome !== 'Open');
  const wins    = decided.filter(s => s.outcome === 'Win').length;
  const wr      = decided.length > 0 ? Math.round(wins / decided.length * 100) : null;
  const netPts  = decided.reduce((a, s) => a + (s.points ?? 0), 0);

  // Tier breakdown
  const tierStats = new Map<string, TierStat>();
  for (const s of rows) {
    const k = s.riskLevel;
    if (!tierStats.has(k)) tierStats.set(k, { count: 0, wins: 0, losses: 0, open: 0, pts: 0 });
    const t = tierStats.get(k)!;
    t.count++;
    if (s.outcome === 'Win') { t.wins++; t.pts += s.points ?? 0; }
    else if (s.outcome === 'Loss') { t.losses++; t.pts += s.points ?? 0; }
    else t.open++;
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.appBar}>
        <Text style={s.appBarTitle}>BACKTEST</Text>
        <Text style={s.appBarSub}>PC signal history · exact match</Text>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* ── Config ─────────────────────────────────────────────────────────── */}
        <View style={s.configCard}>
          <CfgRow label="SYMBOL">
            <View style={s.chips}>
              {SYMBOLS.map(sym => (
                <Pressable key={sym} onPress={() => setSymbol(sym)}
                  style={[s.chip, symbol === sym && s.chipOn]}>
                  <Text style={[s.chipTxt, symbol === sym && { color: Trading.accent }]}>{sym}</Text>
                </Pressable>
              ))}
            </View>
          </CfgRow>

          <CfgRow label="INTERVAL">
            <View style={s.chips}>
              {INTERVALS.map(iv => (
                <Pressable key={iv} onPress={() => setInterval(iv)}
                  style={[s.chip, interval === iv && s.chipOn]}>
                  <Text style={[s.chipTxt, interval === iv && { color: Trading.accent }]}>{iv}</Text>
                </Pressable>
              ))}
            </View>
          </CfgRow>

          <CfgRow label="LOOKBACK">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
              {DAY_RANGES.map(d => (
                <Pressable key={d} onPress={() => setDays(d)}
                  style={[s.chip, days === d && s.chipOn]}>
                  <Text style={[s.chipTxt, days === d && { color: Trading.accent }]}>{d}d</Text>
                </Pressable>
              ))}
            </ScrollView>
          </CfgRow>

          <CfgRow label="SESSION" last>
            <View style={s.chips}>
              {([['all', 'ALL'], ['rth', 'RTH'], ['eth', 'ETH']] as [SessionFilter, string][]).map(([k, label]) => (
                <Pressable key={k} onPress={() => setSession(k)}
                  style={[s.chip, session === k && s.chipOn]}>
                  <Text style={[s.chipTxt, session === k && { color: Trading.accent }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </CfgRow>
        </View>

        {/* ── Run ────────────────────────────────────────────────────────────── */}
        <Pressable style={[s.runBtn, loading && { opacity: 0.6 }]} onPress={run} disabled={loading}>
          {loading ? <ActivityIndicator color={Trading.bg} /> : <Text style={s.runBtnTxt}>▶ LOAD PC SIGNALS</Text>}
        </Pressable>

        {error && <View style={s.errorBox}><Text style={s.errorTxt}>{error}</Text></View>}

        {/* ── Results ────────────────────────────────────────────────────────── */}
        {signals !== null && (
          <Animated.View entering={FadeIn.duration(300)} style={{ gap: 12 }}>
            {/* Filter row */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
              {TIER_FILTERS.map(t => {
                const on = tier === t;
                const col = t === 'all' ? Trading.accent : tierColor(t);
                const label = t === 'all' ? 'ALL' : TIER[t as TierKey].label;
                return (
                  <Pressable key={t} onPress={() => setTier(t)}
                    style={[s.fc, on && { borderColor: col + '88', backgroundColor: col + '20' }]}>
                    <Text style={[s.fcTxt, on && { color: col }]}>{label}</Text>
                  </Pressable>
                );
              })}
              {(['all', 'long', 'short'] as DirFilter[]).map(d => {
                const on = dir === d;
                const col = d === 'long' ? Trading.long : d === 'short' ? Trading.short : Trading.accent;
                return (
                  <Pressable key={d} onPress={() => setDir(d)}
                    style={[s.fc, on && { borderColor: col + '88', backgroundColor: col + '20' }]}>
                    <Text style={[s.fcTxt, on && { color: col }]}>{d === 'all' ? 'BOTH' : d === 'long' ? '▲ LONG' : '▼ SHORT'}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* Overall stats */}
            <View style={s.statsRow}>
              <StatCell label="SIGNALS" value={String(rows.length)} />
              <StatCell label="WIN RATE" value={wr !== null ? `${wr}%` : '—'}
                color={wr !== null ? (wr >= 50 ? Trading.long : Trading.short) : undefined} />
              <StatCell label="NET PTS" value={fmtPts(netPts)} color={netPts >= 0 ? Trading.long : Trading.short} />
              <StatCell label="NET $" value={`$${Math.abs(netPts * MES_PER_PT).toFixed(0)}`}
                color={netPts >= 0 ? Trading.long : Trading.short} />
            </View>

            {/* Tier breakdown */}
            {(['safeplus', 'safe', 'risky', 'riskiest'] as TierKey[]).map(tk => {
              const t = tierStats.get(tk);
              if (!t || t.count === 0) return null;
              const tw = t.wins + t.losses > 0 ? Math.round(t.wins / (t.wins + t.losses) * 100) : null;
              const col = tierColor(tk);
              return (
                <Animated.View key={tk} entering={FadeInDown.duration(280)} style={[s.tierCard, { borderLeftColor: col }]}>
                  <View style={s.tierHeader}>
                    <Text style={[s.tierName, { color: col }]}>{TIER[tk].label}</Text>
                    <Text style={s.tierCount}>{t.count} signals</Text>
                    {tw !== null && <Text style={[s.tierWR, { color: tw >= 50 ? Trading.long : Trading.short }]}>{tw}% WR</Text>}
                    <Text style={[s.tierPts, { color: t.pts >= 0 ? Trading.long : Trading.short }]}>{fmtPts(t.pts)} pts</Text>
                  </View>
                  <View style={s.tierStats}>
                    <TierCell label="WINS"   value={t.wins}   color={Trading.long} />
                    <TierCell label="LOSSES" value={t.losses} color={Trading.short} />
                    <TierCell label="OPEN"   value={t.open}   color={Trading.amber} />
                  </View>
                </Animated.View>
              );
            })}

            {/* Signal list */}
            {rows.length === 0 ? (
              <View style={s.empty}><Text style={s.emptyTxt}>No signals match filters</Text></View>
            ) : (
              <>
                <Text style={s.listHdr}>SIGNALS ({rows.length})</Text>
                <View style={{ gap: 7 }}>
                  {rows.map((sig, i) => {
                    const long = sig.direction === 'Long';
                    const oc   = OUTCOME_COLOR[sig.outcome];
                    const tc   = tierColor(sig.riskLevel);
                    return (
                      <Animated.View key={`${sig.time}-${sig.direction}-${i}`}
                        entering={FadeInDown.duration(280).delay(Math.min(i, 25) * 20)}>
                        <View style={s.sigCard}>
                          <View style={s.sigTop}>
                            <Text style={[s.sigDir, { color: long ? Trading.long : Trading.short, backgroundColor: (long ? Trading.long : Trading.short) + '1a' }]}>
                              {sig.direction.toUpperCase()}
                            </Text>
                            <Text style={[s.sigTier, { color: tc }]}>{TIER[sig.riskLevel as TierKey]?.label ?? sig.riskLevel}</Text>
                            <Text style={s.sigTime}>{fmtDateTime(sig.time)}</Text>
                            <View style={{ flex: 1 }} />
                            <View style={[s.sigOutcome, { backgroundColor: oc + '1a', borderColor: oc + '50' }]}>
                              <Text style={[s.sigOutcomeTxt, { color: oc }]}>{OUTCOME_LABEL[sig.outcome] ?? sig.outcome}</Text>
                            </View>
                          </View>
                          <View style={s.sigLevels}>
                            <LvlCell label="ENTRY" value={sig.price.toFixed(2)} color={Trading.text} />
                            <LvlCell label="TP1"   value={sig.tp1.toFixed(2)}   color={Trading.long} />
                            <LvlCell label="TP2"   value={sig.tp2.toFixed(2)}   color='#16a34a' />
                            <LvlCell label="SL"    value={sig.sl.toFixed(2)}    color={Trading.short} />
                            {sig.points != null && (
                              <LvlCell label="PTS" value={fmtPts(sig.points)}
                                color={sig.points >= 0 ? Trading.long : Trading.short} />
                            )}
                          </View>
                        </View>
                      </Animated.View>
                    );
                  })}
                </View>
              </>
            )}
          </Animated.View>
        )}
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function CfgRow({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <View style={[cr.row, last && { borderBottomWidth: 0 }]}>
      <Text style={cr.label}>{label}</Text>
      {children}
    </View>
  );
}
function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.statCell}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}
function TierCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[s.tcV, { color }]}>{value}</Text>
      <Text style={s.tcL}>{label}</Text>
    </View>
  );
}
function LvlCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={s.lvlLabel}>{label}</Text>
      <Text style={[s.lvlValue, { color }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: 'transparent' },
  appBar:  { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Trading.line, flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  appBarTitle: { fontFamily: Fonts.display, fontSize: 13, fontWeight: '800', letterSpacing: 2, color: Trading.text },
  appBarSub:   { fontSize: 10, color: Trading.muted },
  scroll:  { paddingHorizontal: 14, paddingTop: 10, gap: 12 },

  configCard: { backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 12 },
  chips:   { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip:    { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 7, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass },
  chipOn:  { borderColor: 'rgba(45,212,191,0.45)', backgroundColor: 'rgba(45,212,191,0.12)' },
  chipTxt: { fontFamily: Fonts.mono, fontSize: 11, fontWeight: '600', color: Trading.muted },

  runBtn:    { backgroundColor: Trading.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  runBtnTxt: { color: '#04140f', fontSize: 14, fontWeight: '900', letterSpacing: 1.5, fontFamily: Fonts.display },

  errorBox:  { backgroundColor: Trading.short + '18', borderRadius: 8, borderWidth: 1, borderColor: Trading.short + '40', padding: 12 },
  errorTxt:  { color: Trading.short, fontSize: 12 },

  filterRow: { flexDirection: 'row', gap: 6 },
  fc:        { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 7, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass },
  fcTxt:     { fontFamily: Fonts.mono, fontSize: 10, fontWeight: '600', color: Trading.muted },

  statsRow:  { flexDirection: 'row', gap: 7 },
  statCell:  { flex: 1, backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 8 },
  statLabel: { fontSize: 8, letterSpacing: 1, color: Trading.muted, fontWeight: '600' },
  statValue: { fontFamily: Fonts.mono, fontSize: 14, fontWeight: '600', color: Trading.text, marginTop: 3 },

  tierCard:   { backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderLeftWidth: 3, borderRadius: 10, padding: 12 },
  tierHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  tierName:   { fontFamily: Fonts.display, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  tierCount:  { fontSize: 11, color: Trading.muted },
  tierWR:     { fontFamily: Fonts.mono, fontSize: 12, fontWeight: '700' },
  tierPts:    { fontFamily: Fonts.mono, fontSize: 11, fontWeight: '600', marginLeft: 'auto' as any },
  tierStats:  { flexDirection: 'row', justifyContent: 'space-around' },
  tcV:        { fontFamily: Fonts.mono, fontSize: 16, fontWeight: '700' },
  tcL:        { fontSize: 8, color: Trading.dim, letterSpacing: 0.5, marginTop: 2 },

  listHdr:    { fontFamily: Fonts.display, fontSize: 10, letterSpacing: 1.5, color: Trading.muted, fontWeight: '600' },

  sigCard:    { backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 10, padding: 11 },
  sigTop:     { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sigDir:     { fontFamily: Fonts.mono, fontSize: 9, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 },
  sigTier:    { fontFamily: Fonts.mono, fontSize: 9, fontWeight: '600' },
  sigTime:    { fontFamily: Fonts.mono, fontSize: 9, color: Trading.muted },
  sigOutcome: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, borderWidth: 1 },
  sigOutcomeTxt: { fontFamily: Fonts.mono, fontSize: 9, fontWeight: '600' },
  sigLevels:  { flexDirection: 'row', marginTop: 8, gap: 2 },
  lvlLabel:   { fontSize: 7, letterSpacing: 0.5, color: Trading.dim },
  lvlValue:   { fontFamily: Fonts.mono, fontSize: 10, fontWeight: '500', marginTop: 2 },

  empty:     { paddingVertical: 30, alignItems: 'center' },
  emptyTxt:  { color: Trading.muted, fontSize: 13 },
});
const cr = StyleSheet.create({
  row:   { paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft, gap: 8 },
  label: { fontSize: 9, letterSpacing: 1, color: Trading.muted, fontWeight: '600' },
});
