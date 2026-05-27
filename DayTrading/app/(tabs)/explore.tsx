import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Trading } from '@/constants/theme';

const APP_INFO = [
  { label: 'Strategy', value: 'Milk Yellow Box' },
  { label: 'Instruments', value: 'MES1! / ES1! / NQ1! / MNQ1!' },
  { label: 'Data Source', value: 'MotiveWave TickRelay' },
  { label: 'Version', value: '2.0.0' },
];

const TIERS = [
  { label: 'Safe+',    color: '#a78bfa', desc: 'All confirmations — highest probability' },
  { label: 'Safe',     color: '#00e676', desc: 'Milk zone + vector alignment' },
  { label: 'Risky',    color: '#f59e0b', desc: 'Vector only — reduced conviction' },
  { label: 'Riskiest', color: '#ff4444', desc: 'Direction only — lowest confidence' },
];

export default function AboutScreen() {
  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        <View style={s.header}>
          <Text style={s.title}>DAY TRADER</Text>
          <Text style={s.subtitle}>Milk Yellow Box Strategy</Text>
        </View>

        <Section label="APP INFO">
          <View style={s.card}>
            {APP_INFO.map((item, i) => (
              <View key={item.label} style={[s.row, i < APP_INFO.length - 1 && s.rowBorder]}>
                <Text style={s.rowLabel}>{item.label}</Text>
                <Text style={s.rowValue}>{item.value}</Text>
              </View>
            ))}
          </View>
        </Section>

        <Section label="SIGNAL TIERS">
          {TIERS.map(t => (
            <View key={t.label} style={[s.card, s.tierCard]}>
              <View style={[s.tierDot, { backgroundColor: t.color, shadowColor: t.color, shadowRadius: 5, shadowOpacity: 0.7, shadowOffset: { width: 0, height: 0 } }]} />
              <View style={s.tierInfo}>
                <Text style={[s.tierLabel, { color: t.color }]}>{t.label}</Text>
                <Text style={s.tierDesc}>{t.desc}</Text>
              </View>
            </View>
          ))}
        </Section>

        <Section label="STRATEGIES">
          <View style={s.card}>
            <Text style={s.body}>
              <Text style={s.bold}>Milk Zones</Text>
              {' — FVG and Order Block levels drawn daily by the Milk Yellow Box indicator. Signals are strongest at Milk Zone edges.\n\n'}
              <Text style={s.bold}>Vector</Text>
              {' — 20-bar highest-lowest vector line. Tabletop and side-entry patterns generate confluence points.\n\n'}
              <Text style={s.bold}>Footprint</Text>
              {' — Volume-at-price ladder showing bid/ask imbalances. Delta confirmation strengthens signal quality.'}
            </Text>
          </View>
        </Section>

        <Section label="SIGNALS">
          <View style={s.card}>
            <Text style={s.body}>
              Signals are computed in real-time from 1m, 5m, 15m, and 60m candle data. Each signal includes entry, TP1, TP2, and SL levels calculated from the active exit strategy profile.
            </Text>
          </View>
        </Section>

      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  safe:  { flex: 1, backgroundColor: Trading.bg },
  scroll: { paddingBottom: 48, gap: 0 },
  header: { alignItems: 'center', paddingVertical: 36, paddingHorizontal: 24 },
  title:  { color: '#ffffff', fontSize: 32, fontWeight: '900', letterSpacing: 5 },
  subtitle: { color: '#888888', fontSize: 13, marginTop: 6, fontStyle: 'italic' },

  section: { paddingHorizontal: 20, paddingTop: 24, gap: 10 },
  sectionLabel: { color: Trading.dim, fontSize: 10, fontWeight: '700', letterSpacing: 2 },

  card: {
    backgroundColor: Trading.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Trading.border,
    padding: 16,
  },
  row:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: Trading.border },
  rowLabel:  { color: Trading.muted, fontSize: 13 },
  rowValue:  { color: Trading.text, fontSize: 13, fontWeight: '600' },

  tierCard: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 0 },
  tierDot:  { width: 10, height: 10, borderRadius: 5 },
  tierInfo: { flex: 1, gap: 2 },
  tierLabel: { fontSize: 13, fontWeight: '700' },
  tierDesc:  { color: Trading.muted, fontSize: 12, lineHeight: 17 },

  body: { color: Trading.muted, fontSize: 13, lineHeight: 20 },
  bold: { color: Trading.text, fontWeight: '700' },
});
