// ── SCREENER — confluence-scored list, pillar filters, transparency modal (RN) ─
import { useMemo, useState } from 'react';
import { View, Text, Pressable, Modal, TextInput, ScrollView, StyleSheet } from 'react-native';
import { Trading, Fonts } from '@/constants/theme';
import { usePortfolioApi, usePortfolioPost, fmtNum } from '@/hooks/use-portfolio';
import { Panel, ScoreBadge, PillarBar, Flag, Empty } from './portfolio-ui';

type Metrics = Record<string, number | string | null>;
interface P { score: number; max: number; metrics: Metrics; }
interface Pillars { quality: P; value: P; momentum: P; smartMoney: P; congressInsider: P; }
interface Row { ticker: string; total: number; grade: string; pillars: Pillars; flags: string[]; dataStale: boolean; }

const KEYS: (keyof Pillars)[] = ['quality', 'value', 'momentum', 'smartMoney', 'congressInsider'];
const LABEL: Record<string, string> = { quality: 'Quality', value: 'Value', momentum: 'Momentum', smartMoney: 'Smart Money', congressInsider: 'Congress+Insider' };
const SHORT: Record<string, string> = { quality: 'QUAL', value: 'VAL', momentum: 'MOM', smartMoney: 'SMART', congressInsider: 'GOV' };

export function Screener() {
  const { data, loading, refetch } = usePortfolioApi<{ rows: Row[] }>('/api/portfolio/screener');
  const post = usePortfolioPost();
  const [active, setActive] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Row | null>(null);
  const [input, setInput] = useState('');

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    if (!active.size) return all;
    return all.filter((r) => [...active].every((k) => { const p = r.pillars[k as keyof Pillars]; return p.score >= p.max * 0.6; }));
  }, [data, active]);

  const toggle = (k: string) => setActive((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const add = async () => { const t = input.trim().toUpperCase(); if (!t) return; await post('/api/portfolio/watchlist', { ticker: t }); setInput(''); refetch(); };

  return (
    <View>
      <View style={s.toolbar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {KEYS.map((k) => {
            const on = active.has(k);
            return (
              <Pressable key={k} onPress={() => toggle(k)} style={[s.chip, on && s.chipOn]}>
                <Text style={[s.chipTxt, on && { color: Trading.accent }]}>{LABEL[k]}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <View style={s.addRow}>
        <TextInput style={s.input} placeholder="Add ticker…" placeholderTextColor={Trading.dim} autoCapitalize="characters"
          value={input} onChangeText={setInput} onSubmitEditing={add} />
        <Pressable style={s.addBtn} onPress={add}><Text style={s.addTxt}>+ Track</Text></Pressable>
      </View>

      <Panel>
        <View style={[s.row, s.head]}>
          <Text style={[s.h, { width: 22 }]}>#</Text>
          <Text style={[s.h, { flex: 1 }]}>TICKER</Text>
          <Text style={[s.h, s.r, { flex: 0.9 }]}>SCORE</Text>
          <Text style={[s.h, s.r, { flex: 1.4 }]}>PILLARS</Text>
        </View>
        {!rows.length && <Empty text={loading ? 'SCORING…' : 'ADD TICKERS ABOVE'} />}
        {rows.map((r, i) => (
          <Pressable key={r.ticker} style={s.row} onPress={() => setSel(r)}>
            <Text style={[s.dim, { width: 22 }]}>{i + 1}</Text>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={s.tk}>{r.ticker}</Text>
              {r.dataStale && <Text style={{ color: Trading.amber }}>•</Text>}
            </View>
            <View style={{ flex: 0.9, alignItems: 'flex-end' }}><ScoreBadge grade={r.grade} total={r.total} size={11} /></View>
            <Text style={[s.dim, s.r, { flex: 1.4, fontSize: 9 }]}>
              {KEYS.map((k) => Math.round(r.pillars[k].score)).join(' ')}
            </Text>
          </Pressable>
        ))}
      </Panel>

      {/* detail modal */}
      <Modal visible={!!sel} transparent animationType="slide" onRequestClose={() => setSel(null)}>
        <View style={s.dBack}>
          <View style={s.drawer}>
            <ScrollView contentContainerStyle={{ padding: 22, paddingBottom: 40 }}>
              {sel && (
                <>
                  <View style={s.dHead}>
                    <View><Text style={s.dTk}>{sel.ticker}</Text><Text style={s.dSub}>confluence breakdown</Text></View>
                    <ScoreBadge grade={sel.grade} total={sel.total} size={16} />
                  </View>
                  {!!sel.flags.length && <View style={s.flags}>{sel.flags.map((f) => <Flag key={f} text={f} />)}</View>}
                  {KEYS.map((k) => {
                    const p = sel.pillars[k];
                    return (
                      <View key={k} style={{ marginBottom: 16 }}>
                        <PillarBar label={LABEL[k]} score={p.score} max={p.max} />
                        <View style={s.metrics}>
                          {Object.entries(p.metrics).map(([key, val]) => (
                            <View key={key} style={s.metric}>
                              <Text style={s.mKey}>{key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</Text>
                              <Text style={s.mVal}>{val === null ? '—' : String(val)}</Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    );
                  })}
                  <Pressable style={s.close} onPress={() => setSel(null)}><Text style={s.closeTxt}>Close</Text></Pressable>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  toolbar: { marginBottom: 10 },
  chip: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass },
  chipOn: { borderColor: 'rgba(45,212,191,0.4)', backgroundColor: 'rgba(45,212,191,0.1)' },
  chipTxt: { fontFamily: Fonts.sans, fontSize: 11, letterSpacing: 0.5, color: Trading.muted },
  addRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input: { flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: Trading.line, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 8, color: Trading.text, fontFamily: Fonts.mono, fontSize: 13 },
  addBtn: { backgroundColor: 'rgba(45,212,191,0.14)', borderWidth: 1, borderColor: 'rgba(45,212,191,0.4)', borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' },
  addTxt: { color: Trading.accent, fontFamily: Fonts.display, fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  head: { borderBottomColor: Trading.line, paddingVertical: 7 },
  h: { fontSize: 8, letterSpacing: 1, color: Trading.muted },
  r: { textAlign: 'right' },
  tk: { color: Trading.text, fontWeight: '600', fontFamily: Fonts.display, fontSize: 13 },
  dim: { color: Trading.muted, fontFamily: Fonts.mono, fontSize: 11 },
  dBack: { flex: 1, backgroundColor: 'rgba(2,3,6,0.55)', justifyContent: 'flex-end' },
  drawer: { backgroundColor: '#0b0d14', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: Trading.line, maxHeight: '88%' },
  dHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  dTk: { fontFamily: Fonts.display, fontSize: 22, fontWeight: '700', color: Trading.text, letterSpacing: 1 },
  dSub: { fontSize: 9, letterSpacing: 1.5, color: Trading.muted, textTransform: 'uppercase', marginTop: 2 },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 18 },
  metrics: { marginTop: 12, gap: 5 },
  metric: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  mKey: { fontSize: 11, color: Trading.muted, flex: 1 },
  mVal: { fontFamily: Fonts.mono, fontSize: 12, color: Trading.text },
  close: { alignSelf: 'flex-end', paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: Trading.line, marginTop: 6 },
  closeTxt: { fontFamily: Fonts.display, fontSize: 12, color: Trading.muted },
});
