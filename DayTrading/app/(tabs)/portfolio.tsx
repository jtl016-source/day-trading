// ── PORTFOLIO tab — long-term research console (RN) ──────────────────────────
// Consumes the same /api/portfolio/* endpoints as the PC. Isolated from the
// futures/market/signals/trade screens.
import { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Trading, Fonts } from '@/constants/theme';
import { usePortfolioApi } from '@/hooks/use-portfolio';
import { Overview } from '@/components/portfolio/overview';
import { Screener } from '@/components/portfolio/screener';
import { SmartMoney } from '@/components/portfolio/smart-money';
import { Congress } from '@/components/portfolio/congress';

type View4 = 'overview' | 'screener' | 'smart' | 'congress';
const VIEWS: { key: View4; label: string }[] = [
  { key: 'overview', label: 'OVERVIEW' },
  { key: 'screener', label: 'SCREENER' },
  { key: 'smart', label: 'SMART $' },
  { key: 'congress', label: 'CONGRESS' },
];

export default function PortfolioScreen() {
  const [view, setView] = useState<View4>('overview');
  const health = usePortfolioApi<{ hasApiKey: boolean; budget: { used: number; hardCap: number } }>('/api/portfolio/health');

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* header */}
      <View style={s.header}>
        <View>
          <Text style={s.title}>PORT<Text style={{ color: Trading.accent }}>FOLIO</Text></Text>
          <Text style={s.sub}>Long-Term Research</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {health.data && !health.data.hasApiKey
            ? <Text style={s.warn}>FMP_API_KEY not set</Text>
            : health.data && <Text style={s.budget}>FMP {health.data.budget.used}/{health.data.budget.hardCap}</Text>}
        </View>
      </View>

      {/* segmented control */}
      <View style={s.seg}>
        {VIEWS.map((v) => (
          <Pressable key={v.key} style={[s.segBtn, view === v.key && s.segOn]} onPress={() => setView(v.key)}>
            <Text style={[s.segTxt, view === v.key && { color: Trading.accent }]}>{v.label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {health.data && !health.data.hasApiKey && (
          <Text style={s.keyhint}>Set FMP_API_KEY in the server .env and restart to load data. See PORTFOLIO_README.md.</Text>
        )}
        {view === 'overview' && <Overview />}
        {view === 'screener' && <Screener />}
        {view === 'smart' && <SmartMoney />}
        {view === 'congress' && <Congress />}
        <Text style={s.footer}>Research tool — not investment advice. 13F lags up to 135 days; congressional disclosures up to 45 days.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10 },
  title: { fontFamily: Fonts.bold, fontSize: 18, fontWeight: '700', letterSpacing: 2, color: Trading.text },
  sub: { fontSize: 8, letterSpacing: 2, color: Trading.muted, textTransform: 'uppercase', marginTop: 2 },
  warn: { color: Trading.amber, fontFamily: Fonts.mono, fontSize: 10 },
  budget: { color: Trading.dim, fontFamily: Fonts.mono, fontSize: 10 },
  seg: { flexDirection: 'row', gap: 4, marginHorizontal: 16, marginBottom: 8, padding: 4, borderRadius: 11, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass },
  segBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8 },
  segOn: { backgroundColor: 'rgba(45,212,191,0.1)' },
  segTxt: { fontFamily: Fonts.display, fontSize: 10, fontWeight: '600', letterSpacing: 0.8, color: Trading.muted },
  scroll: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 40 },
  keyhint: { color: Trading.amber, fontSize: 12, padding: 13, borderWidth: 1, borderColor: 'rgba(255,180,84,0.4)', borderRadius: 11, backgroundColor: 'rgba(255,180,84,0.06)', marginBottom: 14, lineHeight: 17 },
  footer: { fontFamily: Fonts.mono, fontSize: 9, color: Trading.dim, textAlign: 'center', marginTop: 8, letterSpacing: 0.3, lineHeight: 14 },
});
