// ── OVERVIEW — holdings, allocation, core/satellite (RN) ─────────────────────
import { useMemo, useState } from 'react';
import { View, Text, Pressable, Modal, TextInput, StyleSheet } from 'react-native';
import { Trading, Fonts } from '@/constants/theme';
import { usePortfolioApi, usePortfolioPost, fmtMoney, fmtNum, fmtPct, DONUT_COLORS } from '@/hooks/use-portfolio';
import { Panel, ScoreBadge, Empty } from './portfolio-ui';

interface HoldingRow {
  ticker: string; shares: number; costBasis: number; isCore?: boolean;
  price: number; value: number; pl: number; plPct: number; weight: number;
}
interface HoldingsResp { holdings: HoldingRow[]; totalValue: number; corePct: number; coreTargetPct: number; coreEtf: string; }
interface ScreenRow { ticker: string; total: number; grade: string; }

export function Overview() {
  const { data, refetch } = usePortfolioApi<HoldingsResp>('/api/portfolio/holdings', 60000);
  const scores = usePortfolioApi<{ rows: ScreenRow[] }>('/api/portfolio/screener?universe=holdings');
  const post = usePortfolioPost();
  const [modal, setModal] = useState<Partial<HoldingRow> | null>(null);

  const scoreMap = useMemo(() => {
    const m = new Map<string, ScreenRow>();
    for (const r of scores.data?.rows ?? []) m.set(r.ticker, r);
    return m;
  }, [scores.data]);

  const holdings = data?.holdings ?? [];
  const corePct = data?.corePct ?? 0;
  const target = data?.coreTargetPct ?? 70;
  const satPct = 100 - corePct;
  const satTarget = 100 - target;
  const over = satPct > satTarget + 0.5;

  const save = async () => {
    if (!modal?.ticker) return;
    await post('/api/portfolio/holdings', { ticker: modal.ticker, shares: modal.shares ?? 0, costBasis: modal.costBasis ?? 0, isCore: !!modal.isCore });
    setModal(null); refetch();
  };
  const del = async (t: string) => { await post('/api/portfolio/holdings', { action: 'delete', ticker: t }); setModal(null); refetch(); };

  return (
    <View>
      <Panel title="Long-Term Holdings" right={
        <Pressable style={s.addBtn} onPress={() => setModal({})}><Text style={s.addTxt}>+ Position</Text></Pressable>
      }>
        {/* header row */}
        <View style={[s.row, s.head]}>
          <Text style={[s.h, { flex: 1.1 }]}>TICKER</Text>
          <Text style={[s.h, s.r, { flex: 1 }]}>VALUE</Text>
          <Text style={[s.h, s.r, { flex: 1.1 }]}>P/L</Text>
          <Text style={[s.h, s.r, { flex: 0.6 }]}>WT%</Text>
          <Text style={[s.h, s.r, { flex: 0.8 }]}>SCORE</Text>
        </View>
        {!holdings.length && <Empty text="NO POSITIONS — ADD ONE" />}
        {holdings.map((h) => {
          const sc = scoreMap.get(h.ticker);
          return (
            <Pressable key={h.ticker} style={s.row} onPress={() => setModal(h)}>
              <View style={{ flex: 1.1, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Text style={s.tk}>{h.ticker}</Text>
                {h.isCore && <Text style={s.core}>CORE</Text>}
              </View>
              <Text style={[s.num, s.r, { flex: 1 }]}>{fmtMoney(h.value)}</Text>
              <Text style={[s.num, s.r, { flex: 1.1, color: h.pl >= 0 ? Trading.long : Trading.short }]}>{fmtMoney(h.pl)} ({fmtPct(h.plPct)})</Text>
              <Text style={[s.num, s.r, { flex: 0.6, color: Trading.muted }]}>{fmtNum(h.weight, 1)}</Text>
              <View style={{ flex: 0.8, alignItems: 'flex-end' }}>{sc ? <ScoreBadge grade={sc.grade} total={sc.total} size={10} /> : <Text style={s.dim}>—</Text>}</View>
            </Pressable>
          );
        })}
      </Panel>

      {/* allocation */}
      <Panel title="Allocation" right={<Text style={s.dim}>{fmtMoney(data?.totalValue)}</Text>}>
        <View style={s.allocBar}>
          {holdings.length
            ? holdings.map((h, i) => <View key={h.ticker} style={{ width: `${Math.max(h.weight, 1)}%`, backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />)
            : <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)' }} />}
        </View>
        <View style={s.legend}>
          {holdings.slice(0, 8).map((h, i) => (
            <View key={h.ticker} style={s.legRow}>
              <View style={[s.legDot, { backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }]} />
              <Text style={s.legTk}>{h.ticker}</Text>
              <Text style={s.legW}>{fmtNum(h.weight, 1)}%</Text>
            </View>
          ))}
        </View>
      </Panel>

      {/* core / satellite */}
      <Panel title="Core / Satellite" right={<Text style={s.dim}>target {target}/{satTarget}</Text>}>
        <View style={s.csBar}>
          <View style={[s.csCore, { flex: Math.max(corePct, 8) }]}><Text style={s.csCoreTxt}>{fmtNum(corePct, 0)}% CORE</Text></View>
          <View style={[s.csSat, over && { backgroundColor: 'rgba(255,180,84,0.22)' }, { flex: Math.max(satPct, 8) }]}>
            <Text style={[s.csSatTxt, over && { color: Trading.amber }]}>{fmtNum(satPct, 0)}% SAT</Text>
          </View>
        </View>
        <Text style={[s.note, over && { color: Trading.amber }]}>
          {over
            ? `⚠ Satellites ${fmtNum(satPct, 0)}% exceed the ${satTarget}% target — trim picks toward ${data?.coreEtf ?? 'VTI'}.`
            : `Within target. Core (${data?.coreEtf ?? 'VTI'}) ${fmtNum(corePct, 0)}% / picks ${fmtNum(satPct, 0)}%. Mark a holding CORE when editing.`}
        </Text>
      </Panel>

      {/* add/edit modal */}
      <Modal visible={!!modal} transparent animationType="slide" onRequestClose={() => setModal(null)}>
        <Pressable style={s.mBack} onPress={() => setModal(null)}>
          <Pressable style={s.modal} onPress={(e) => e.stopPropagation()}>
            <Text style={s.mTitle}>{modal?.ticker && modal?.value !== undefined ? `Edit ${modal.ticker}` : 'Add Position'}</Text>
            <Text style={s.lab}>TICKER</Text>
            <TextInput style={s.input} autoCapitalize="characters" placeholder="AAPL" placeholderTextColor={Trading.dim}
              editable={modal?.value === undefined} value={modal?.ticker ?? ''} onChangeText={(t) => setModal({ ...modal, ticker: t.toUpperCase() })} />
            <Text style={s.lab}>SHARES</Text>
            <TextInput style={s.input} keyboardType="numeric" placeholderTextColor={Trading.dim}
              value={modal?.shares != null ? String(modal.shares) : ''} onChangeText={(t) => setModal({ ...modal, shares: parseFloat(t) || 0 })} />
            <Text style={s.lab}>COST BASIS (per share)</Text>
            <TextInput style={s.input} keyboardType="numeric" placeholderTextColor={Trading.dim}
              value={modal?.costBasis != null ? String(modal.costBasis) : ''} onChangeText={(t) => setModal({ ...modal, costBasis: parseFloat(t) || 0 })} />
            <Pressable style={s.checkRow} onPress={() => setModal({ ...modal, isCore: !modal?.isCore })}>
              <View style={[s.check, modal?.isCore && { backgroundColor: Trading.accent, borderColor: Trading.accent }]} />
              <Text style={s.checkTxt}>Core index ETF (counts toward core target)</Text>
            </Pressable>
            <View style={s.mBtns}>
              {modal?.ticker && modal?.value !== undefined && (
                <Pressable style={[s.mBtn, { marginRight: 'auto' }]} onPress={() => del(modal.ticker!)}><Text style={[s.mBtnTxt, { color: Trading.short }]}>Delete</Text></Pressable>
              )}
              <Pressable style={s.mBtn} onPress={() => setModal(null)}><Text style={[s.mBtnTxt, { color: Trading.muted }]}>Cancel</Text></Pressable>
              <Pressable style={[s.mBtn, s.primary]} onPress={save}><Text style={[s.mBtnTxt, { color: Trading.accent }]}>Save</Text></Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  addBtn: { backgroundColor: 'rgba(45,212,191,0.14)', borderWidth: 1, borderColor: 'rgba(45,212,191,0.4)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  addTxt: { color: Trading.accent, fontFamily: Fonts.display, fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  head: { borderBottomColor: Trading.line, paddingVertical: 7 },
  h: { fontSize: 8, letterSpacing: 1, color: Trading.muted },
  r: { textAlign: 'right' },
  tk: { color: Trading.text, fontWeight: '600', fontFamily: Fonts.display, fontSize: 13 },
  core: { color: Trading.accent, fontSize: 8, fontFamily: Fonts.mono },
  num: { fontFamily: Fonts.mono, fontSize: 11, color: Trading.text },
  dim: { color: Trading.muted, fontSize: 11, fontFamily: Fonts.mono },
  allocBar: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 12 },
  legend: { gap: 6 },
  legRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legDot: { width: 9, height: 9, borderRadius: 2 },
  legTk: { color: Trading.text, fontSize: 12, fontFamily: Fonts.sans },
  legW: { marginLeft: 'auto', color: Trading.muted, fontFamily: Fonts.mono, fontSize: 12 },
  csBar: { flexDirection: 'row', height: 30, borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: Trading.line },
  csCore: { backgroundColor: 'rgba(45,212,191,0.5)', justifyContent: 'center', paddingHorizontal: 10 },
  csCoreTxt: { fontFamily: Fonts.mono, fontSize: 11, color: '#04201c', fontWeight: '700' },
  csSat: { backgroundColor: 'rgba(255,255,255,0.05)', alignItems: 'flex-end', justifyContent: 'center', paddingHorizontal: 10 },
  csSatTxt: { fontFamily: Fonts.mono, fontSize: 11, color: Trading.text },
  note: { fontSize: 11, color: Trading.muted, marginTop: 9, lineHeight: 16 },
  mBack: { flex: 1, backgroundColor: 'rgba(2,3,6,0.6)', justifyContent: 'flex-end' },
  modal: { backgroundColor: '#0b0d14', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: Trading.line, padding: 22, paddingBottom: 40 },
  mTitle: { fontFamily: Fonts.display, fontSize: 15, color: Trading.text, marginBottom: 14, letterSpacing: 1 },
  lab: { fontSize: 10, letterSpacing: 1.2, color: Trading.muted, marginBottom: 6, marginTop: 4 },
  input: { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: Trading.line, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 9, color: Trading.text, fontFamily: Fonts.mono, fontSize: 13, marginBottom: 11 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginVertical: 6 },
  check: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: Trading.line },
  checkTxt: { color: Trading.muted, fontSize: 12, flex: 1 },
  mBtns: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 18 },
  mBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: Trading.line },
  primary: { backgroundColor: 'rgba(45,212,191,0.14)', borderColor: 'rgba(45,212,191,0.4)' },
  mBtnTxt: { fontFamily: Fonts.display, fontSize: 12, fontWeight: '600' },
});
