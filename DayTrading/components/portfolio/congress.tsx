// ── CONGRESS — disclosures feed, leaderboard, followed (RN) ──────────────────
import { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Trading, Fonts } from '@/constants/theme';
import { usePortfolioApi, usePortfolioPost, fmtDate, partyColor } from '@/hooks/use-portfolio';
import { Panel, Empty } from './portfolio-ui';

interface Trade { politician: string; party: string; chamber: string; ticker: string; type: 'buy' | 'sell'; amountRange: string; transactionDate: string; lagDays: number; }
interface Leader { politician: string; party: string; buys: number; sells: number; convictionTickers: string[]; }

export function Congress() {
  const recent = usePortfolioApi<{ trades: Trade[]; followed: string[] }>('/api/portfolio/congress/recent');
  const leaders = usePortfolioApi<{ leaders: Leader[] }>('/api/portfolio/congress/leaders');
  const post = usePortfolioPost();
  const [followed, setFollowed] = useState<string[] | null>(null);
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const follow = followed ?? recent.data?.followed ?? [];
  const toggle = async (p: string) => { const res = await post('/api/portfolio/congress/follow', { politician: p }); setFollowed(res.followed ?? []); };

  const trades = useMemo(() => {
    const all = recent.data?.trades ?? [];
    return onlyFollowed ? all.filter((t) => follow.includes(t.politician)) : all;
  }, [recent.data, onlyFollowed, follow]);

  return (
    <View>
      {!dismissed && (
        <Pressable style={s.banner} onPress={() => setDismissed(true)}>
          <Text style={s.bannerTxt}>⚠ Congressional trades are disclosed up to 45 days late and are informational only. Tap to dismiss.</Text>
        </Pressable>
      )}

      <Panel title="Recent Disclosures" right={
        <Pressable onPress={() => setOnlyFollowed((v) => !v)} style={[s.chip, onlyFollowed && s.chipOn]}>
          <Text style={[s.chipTxt, onlyFollowed && { color: Trading.amber }]}>★ Followed</Text>
        </Pressable>
      }>
        {recent.loading && <Empty text="LOADING…" />}
        {!recent.loading && !trades.length && <Empty text="NO DISCLOSURES IN 90 DAYS" />}
        {trades.slice(0, 60).map((t, i) => (
          <View key={i} style={s.feedRow}>
            <View style={{ flex: 1.5 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={[s.dot, { backgroundColor: partyColor(t.party) }]} />
                <Text style={s.pol} numberOfLines={1}>{t.politician}</Text>
              </View>
              <Text style={s.chamber}>{t.chamber} · {fmtDate(t.transactionDate)} <Text style={t.lagDays > 30 ? s.lag : s.dim}>+{t.lagDays}d</Text></Text>
            </View>
            <Text style={[s.tk, { flex: 0.7 }]}>{t.ticker}</Text>
            <Text style={[{ flex: 0.5, textAlign: 'right', fontFamily: Fonts.display, fontSize: 12, fontWeight: '600' }, { color: t.type === 'buy' ? Trading.long : Trading.short }]}>{t.type.toUpperCase()}</Text>
            <Pressable onPress={() => toggle(t.politician)} style={{ width: 28, alignItems: 'flex-end' }}>
              <Text style={{ color: follow.includes(t.politician) ? Trading.amber : Trading.dim, fontSize: 15 }}>★</Text>
            </Pressable>
          </View>
        ))}
      </Panel>

      <Panel title="Most Active Buyers" right={<Text style={s.dim}>90d</Text>}>
        {leaders.loading && <Empty text="LOADING…" />}
        {(leaders.data?.leaders ?? []).slice(0, 12).map((l) => (
          <View key={l.politician} style={s.leadRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={[s.dot, { backgroundColor: partyColor(l.party) }]} />
              <Text style={s.pol}>{l.politician}</Text>
              <Pressable onPress={() => toggle(l.politician)} style={{ marginLeft: 'auto' }}>
                <Text style={{ color: follow.includes(l.politician) ? Trading.amber : Trading.dim, fontSize: 15 }}>★</Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
              <Text style={[s.mono, { color: Trading.long }]}>{l.buys} buys</Text>
              <Text style={[s.mono, s.dim]}>{l.sells} sells</Text>
              {l.convictionTickers.length > 0 && <Text style={[s.mono, { color: Trading.amber }]}>conviction: {l.convictionTickers.slice(0, 3).join(', ')}</Text>}
            </View>
          </View>
        ))}
      </Panel>
    </View>
  );
}

const s = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', padding: 11, borderRadius: 11, marginBottom: 14, backgroundColor: 'rgba(255,180,84,0.08)', borderWidth: 1, borderColor: 'rgba(255,180,84,0.28)' },
  bannerTxt: { color: Trading.amber, fontSize: 11, lineHeight: 16 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass },
  chipOn: { borderColor: 'rgba(255,180,84,0.4)', backgroundColor: 'rgba(255,180,84,0.1)' },
  chipTxt: { fontFamily: Fonts.sans, fontSize: 11, color: Trading.muted },
  feedRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pol: { color: Trading.text, fontWeight: '600', fontFamily: Fonts.sans, fontSize: 12, flexShrink: 1 },
  chamber: { fontFamily: Fonts.mono, fontSize: 9, color: Trading.muted, textTransform: 'uppercase', marginTop: 3 },
  tk: { color: Trading.text, fontWeight: '600', fontFamily: Fonts.display, fontSize: 13 },
  dim: { color: Trading.muted, fontFamily: Fonts.mono, fontSize: 10 },
  lag: { color: Trading.amber, fontFamily: Fonts.mono, fontSize: 9 },
  leadRow: { paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  mono: { fontFamily: Fonts.mono, fontSize: 11 },
});
