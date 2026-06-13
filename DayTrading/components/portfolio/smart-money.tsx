// ── SMART MONEY — superinvestor cards + consensus (RN) ───────────────────────
import { useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { Trading, Fonts } from '@/constants/theme';
import { usePortfolioApi, fmtCompact, fmtNum, CHANGE_COLOR } from '@/hooks/use-portfolio';
import { Panel, Empty } from './portfolio-ui';

interface FundSummary { cik: string; manager: string; fund: string; portfolioValue: number; asOf: string; topTickers: string[]; }
interface Holding { ticker: string; weight: number; marketValue: number; change: string; changePct: number | null; }
interface FullFund { manager: string; fund: string; portfolioValue: number; asOf: string; topHoldings: Holding[]; }
interface ConsensusRow { ticker: string; holders: number; adders: number; funds: string[]; }

export function SmartMoney() {
  const funds = usePortfolioApi<{ funds: FundSummary[] }>('/api/portfolio/smartmoney/funds');
  const consensus = usePortfolioApi<{ consensus: ConsensusRow[] }>('/api/portfolio/smartmoney/consensus');
  const [cik, setCik] = useState<string | null>(null);

  return (
    <View>
      <Panel title="Consensus — Most Owned" right={<Text style={s.dim}>copy the best</Text>}>
        <View style={[s.row, s.head]}>
          <Text style={[s.h, { flex: 1 }]}>TICKER</Text>
          <Text style={[s.h, s.r, { flex: 0.7 }]}>HOLDERS</Text>
          <Text style={[s.h, s.r, { flex: 0.7 }]}>ADDING</Text>
        </View>
        {consensus.loading && <Empty text="BUILDING CONSENSUS…" />}
        {(consensus.data?.consensus ?? []).slice(0, 20).map((r) => (
          <View key={r.ticker} style={s.row}>
            <Text style={[s.tk, { flex: 1 }]}>{r.ticker}</Text>
            <Text style={[s.num, s.r, { flex: 0.7, color: Trading.accent }]}>{r.holders}</Text>
            <Text style={[s.num, s.r, { flex: 0.7, color: r.adders ? Trading.long : Trading.muted }]}>{r.adders}</Text>
          </View>
        ))}
      </Panel>

      <Panel title={`Superinvestors (${funds.data?.funds?.length ?? 0})`}>
        {funds.loading && <Empty text="LOADING 13F…" />}
        {(funds.data?.funds ?? []).map((f) => (
          <Pressable key={f.cik} style={s.fund} onPress={() => setCik(f.cik)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={s.mgr}>{f.manager}</Text>
              <Text style={s.fundVal}>{fmtCompact(f.portfolioValue)}</Text>
            </View>
            <Text style={s.fundName}>{f.fund} · {f.asOf || '—'}</Text>
            <View style={s.tickerRow}>
              {f.topTickers.length
                ? f.topTickers.map((t) => <View key={t} style={s.tchip}><Text style={s.tchipTxt}>{t}</Text></View>)
                : <Text style={s.dim}>no data (verify CIK)</Text>}
            </View>
          </Pressable>
        ))}
      </Panel>

      <Modal visible={!!cik} transparent animationType="slide" onRequestClose={() => setCik(null)}>
        <View style={s.dBack}><FundModal cik={cik} onClose={() => setCik(null)} /></View>
      </Modal>
    </View>
  );
}

function FundModal({ cik, onClose }: { cik: string | null; onClose: () => void }) {
  const { data, loading } = usePortfolioApi<{ fund: FullFund | null }>(cik ? `/api/portfolio/smartmoney/fund/${cik}` : '/api/portfolio/health');
  const f = data?.fund;
  return (
    <View style={s.drawer}>
      <ScrollView contentContainerStyle={{ padding: 22, paddingBottom: 40 }}>
        <View style={s.dHead}>
          <View><Text style={s.dMgr}>{f?.manager ?? '…'}</Text><Text style={s.dSub}>{f?.fund} · {f?.asOf}</Text></View>
          <Text style={[s.fundVal, { fontSize: 13 }]}>{fmtCompact(f?.portfolioValue ?? 0)}</Text>
        </View>
        {loading && <Empty text="LOADING HOLDINGS…" />}
        {f && !f.topHoldings.length && <Text style={s.hint}>No holdings — the CIK may be stale (see PORTFOLIO_README).</Text>}
        {f && !!f.topHoldings.length && (
          <>
            <View style={[s.row, s.head]}>
              <Text style={[s.h, { flex: 1 }]}>TICKER</Text>
              <Text style={[s.h, s.r, { flex: 0.7 }]}>WEIGHT</Text>
              <Text style={[s.h, s.r, { flex: 0.8 }]}>QoQ</Text>
            </View>
            {f.topHoldings.map((h) => (
              <View key={h.ticker} style={s.row}>
                <Text style={[s.tk, { flex: 1 }]}>{h.ticker}</Text>
                <Text style={[s.num, s.r, { flex: 0.7 }]}>{fmtNum(h.weight, 1)}%</Text>
                <Text style={[s.num, s.r, { flex: 0.8, color: CHANGE_COLOR[h.change] ?? Trading.muted }]}>{h.change.toUpperCase()}</Text>
              </View>
            ))}
          </>
        )}
        <Pressable style={s.close} onPress={onClose}><Text style={s.closeTxt}>Close</Text></Pressable>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  head: { borderBottomColor: Trading.line, paddingVertical: 7 },
  h: { fontSize: 8, letterSpacing: 1, color: Trading.muted },
  r: { textAlign: 'right' },
  tk: { color: Trading.text, fontWeight: '600', fontFamily: Fonts.display, fontSize: 13 },
  num: { fontFamily: Fonts.mono, fontSize: 11, color: Trading.text },
  dim: { color: Trading.muted, fontFamily: Fonts.mono, fontSize: 10 },
  fund: { paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  mgr: { fontFamily: Fonts.display, fontSize: 14, fontWeight: '600', color: Trading.text },
  fundName: { fontSize: 10, letterSpacing: 0.5, color: Trading.muted, textTransform: 'uppercase', marginTop: 2 },
  fundVal: { fontFamily: Fonts.mono, fontSize: 12, color: Trading.accent },
  tickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 },
  tchip: { backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  tchipTxt: { color: Trading.text, fontFamily: Fonts.mono, fontSize: 10 },
  dBack: { flex: 1, backgroundColor: 'rgba(2,3,6,0.55)', justifyContent: 'flex-end' },
  drawer: { backgroundColor: '#0b0d14', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: Trading.line, maxHeight: '88%' },
  dHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  dMgr: { fontFamily: Fonts.display, fontSize: 18, fontWeight: '700', color: Trading.text },
  dSub: { fontSize: 9, letterSpacing: 1, color: Trading.muted, textTransform: 'uppercase', marginTop: 2 },
  hint: { color: Trading.amber, fontSize: 12, padding: 14, borderWidth: 1, borderColor: 'rgba(255,180,84,0.4)', borderRadius: 11, backgroundColor: 'rgba(255,180,84,0.06)' },
  close: { alignSelf: 'flex-end', paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: Trading.line, marginTop: 12 },
  closeTxt: { fontFamily: Fonts.display, fontSize: 12, color: Trading.muted },
});
