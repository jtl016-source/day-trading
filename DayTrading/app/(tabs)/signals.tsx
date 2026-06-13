import { useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { useMarketData } from '@/hooks/use-market-data';
import { useTradeStatus } from '@/hooks/use-trade-status';
import { MeridianHeader } from '@/components/meridian-header';
import { StrategySheet, type StrategySheetRef } from '@/components/strategy-sheet';
import { TierPill } from '@/components/meridian-ui';
import { Trading, Fonts, TIER, type TierKey } from '@/constants/theme';
import type { MobileSignal } from '@/lib/signal-map';

type DirFilter = 'all' | 'long' | 'short';
const MES_PER_PT = 5;

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York',
  });
}
function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });
}
// Unix seconds at the most recent ET midnight (start of today in ET).
function etMidnightSec(atMs: number = Date.now()): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(atMs));
  const g = (t: string) => Number(p.find(x => x.type === t)?.value ?? 0);
  return Math.floor(atMs / 1000) - (g('hour') * 3600 + g('minute') * 60 + g('second'));
}
function primaryStrat(s: MobileSignal): string {
  return s.strategies.milk ? 'MilkZone' : s.strategies.fp ? 'Footprint' : s.strategies.vec ? 'Vector' : 'Signal';
}
const ACTIVE_WINDOW_HOURS = 48; // signals older than this are expired, not active

function sigAgeHours(s: MobileSignal): number {
  return (Date.now() / 1000 - s.time) / 3600;
}
function statusOf(s: MobileSignal): { label: string; color: string; active: boolean } {
  if (s.outcome === 'Win')  return { label: 'TP1 WIN', color: Trading.long,  active: false };
  if (s.outcome === 'Loss') return { label: 'LOSS',    color: Trading.short, active: false };
  if (sigAgeHours(s) > ACTIVE_WINDOW_HOURS) return { label: 'EXPIRED', color: Trading.dim, active: false };
  return { label: 'ACTIVE', color: Trading.amber, active: true };
}
function tierColor(rl: string): string { return TIER[rl as TierKey]?.color ?? Trading.risky; }

export default function SignalsScreen() {
  const { signals, loading } = useMarketData();
  const { connected } = useTradeStatus();
  const sheetRef = useRef<StrategySheetRef>(null);

  const [dir, setDir] = useState<DirFilter>('all');
  const [rthOnly, setRthOnly] = useState(false);
  const [selected, setSelected] = useState<MobileSignal | null>(null);

  // Calendar reference is the DATA's most recent signal day — NOT the device clock (the data
  // can be dated independently of the phone's date, which made "today" look empty). Default view
  // shows that latest day's signals; ‹/› browse the start day (from that date → the latest).
  const latestDay = useMemo(() => {
    if (!signals.length) return etMidnightSec();
    const latest = signals.reduce((m, sg) => Math.max(m, sg.time), 0);
    return etMidnightSec(latest * 1000);
  }, [signals]);
  const minStart = latestDay - 30 * 86400;
  const [dayStartSel, setDayStartSel] = useState<number | null>(null);
  const start = dayStartSel ?? latestDay;       // default follows the latest day until user navigates
  const isLatest = start >= latestDay;

  const rows = useMemo(() => signals.filter(s => {
    if (s.time < start) return false; // from the selected date onward
    if (dir === 'long' && s.direction !== 'Long') return false;
    if (dir === 'short' && s.direction !== 'Short') return false;
    if (rthOnly && !s.rth) return false;
    return true;
  }), [signals, dir, rthOnly, start]);

  const stats = useMemo(() => {
    const decided = rows.filter(s => s.outcome !== 'Open');
    const wins = decided.filter(s => s.outcome === 'Win').length;
    const net = decided.reduce((a, s) => a + (s.points ?? 0), 0);
    const active = rows.filter(s => s.outcome === 'Open' && sigAgeHours(s) <= ACTIVE_WINDOW_HOURS).length;
    return { count: rows.length, wr: decided.length ? Math.round(wins / decided.length * 100) : null, net, active };
  }, [rows]);

  const openSig = (s: MobileSignal) => { Haptics.selectionAsync().catch(() => {}); setSelected(s); };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <MeridianHeader live={connected} onOpenStrategies={() => sheetRef.current?.present()} />

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Stat grid ──────────────────────────────────────────────────────── */}
        <View style={s.statGrid}>
          <StatCell label="SIGNALS"  value={String(stats.count)} />
          <StatCell label="WIN RATE" value={stats.wr !== null ? `${stats.wr}%` : '—'} color={stats.wr !== null ? (stats.wr >= 50 ? Trading.long : Trading.short) : undefined} />
          <StatCell label="NET PTS"  value={`${stats.net >= 0 ? '+' : ''}${stats.net.toFixed(1)}`} color={stats.net >= 0 ? Trading.long : Trading.short} />
          <StatCell label="ACTIVE"   value={String(stats.active)} color={Trading.amber} />
        </View>

        {/* ── Direction + RTH ────────────────────────────────────────────────── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
          {(['all', 'long', 'short'] as DirFilter[]).map(d => {
            const on = dir === d;
            const col = d === 'long' ? Trading.long : d === 'short' ? Trading.short : Trading.accent;
            return (
              <Pressable key={d} onPress={() => setDir(d)} style={[s.fc, on && { borderColor: col + '88', backgroundColor: col + '20' }]}>
                <Text style={[s.fcTxt, on && { color: col }]}>{d === 'all' ? 'ALL' : d === 'long' ? '▲ LONG' : '▼ SHORT'}</Text>
              </Pressable>
            );
          })}
          <Pressable onPress={() => setRthOnly(v => !v)} style={[s.fc, rthOnly && { borderColor: Trading.accent + '88', backgroundColor: Trading.accent + '20' }]}>
            <Text style={[s.fcTxt, rthOnly && { color: Trading.accent }]}>RTH</Text>
          </Pressable>
        </ScrollView>

        {/* ── Calendar (latest day by default; ‹ › browse from a past date → latest) ─ */}
        <View style={s.dateRow}>
          <Pressable onPress={() => setDayStartSel(Math.max(minStart, start - 86400))} style={s.dateBtn} hitSlop={8}>
            <Text style={s.dateArrow}>‹</Text>
          </Pressable>
          <Text style={s.dateLabel}>{isLatest ? 'TODAY' : `SINCE ${fmtDate(start).toUpperCase()}`}</Text>
          <Pressable onPress={() => setDayStartSel(Math.min(latestDay, start + 86400))} disabled={isLatest}
            style={[s.dateBtn, isLatest && { opacity: 0.35 }]} hitSlop={8}>
            <Text style={s.dateArrow}>›</Text>
          </Pressable>
          {!isLatest && (
            <Pressable onPress={() => setDayStartSel(latestDay)} style={s.todayBtn}>
              <Text style={s.todayTxt}>Today</Text>
            </Pressable>
          )}
        </View>

        {/* ── Cards ──────────────────────────────────────────────────────────── */}
        <View key={`${dir}-${rthOnly}-${start}`} style={{ gap: 9 }}>
          {rows.length === 0 ? (
            <View style={s.empty}>
              <Text style={s.emptyTxt}>{loading ? 'Loading signals…' : signals.length === 0 ? 'No signals yet' : isLatest ? 'No signals today' : `No signals since ${fmtDate(start)}`}</Text>
            </View>
          ) : rows.map((sig, i) => {
            const long = sig.direction === 'Long';
            const st = statusOf(sig);
            const pnlColor = sig.points == null ? Trading.muted : sig.points > 0 ? Trading.long : sig.points < 0 ? Trading.short : Trading.muted;
            return (
              <Animated.View key={`${sig.time}-${sig.direction}`} entering={FadeInDown.duration(380).delay(Math.min(i, 12) * 45)}>
                <Pressable style={s.card} onPress={() => openSig(sig)}>
                  <View style={s.cardTop}>
                    <View style={s.cardId}>
                      <Text style={[s.side, { color: long ? Trading.long : Trading.short, backgroundColor: (long ? Trading.long : Trading.short) + '1a' }]}>
                        {sig.direction.toUpperCase()}
                      </Text>
                      <Text style={s.strat}>{primaryStrat(sig)}</Text>
                      <TierPill tier={sig.riskLevel} />
                    </View>
                    <Text style={s.time}>{fmtTime(sig.time)}</Text>
                  </View>
                  <View style={s.grid}>
                    <Cell label="ENTRY" value={sig.price.toFixed(2)} />
                    <Cell label="STOP"  value={sig.sl.toFixed(2)}  color={Trading.short} />
                    <Cell label="TP1"   value={sig.tp1.toFixed(2)} color={Trading.long} />
                    <Cell label="TP2"   value={sig.tp2.toFixed(2)} color={Trading.long} />
                  </View>
                  <View style={s.foot}>
                    <View style={[s.status, { backgroundColor: st.color + '1a' }]}>
                      {st.active && <View style={[s.dot, { backgroundColor: st.color }]} />}
                      <Text style={[s.statusTxt, { color: st.color }]}>{st.label}</Text>
                    </View>
                    {sig.points != null && (
                      <Text style={[s.pnl, { color: pnlColor }]}>{sig.points >= 0 ? '+' : ''}{sig.points.toFixed(2)} pts</Text>
                    )}
                  </View>
                </Pressable>
              </Animated.View>
            );
          })}
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>

      {selected && <DetailModal sig={selected} onClose={() => setSelected(null)} />}
      <StrategySheet ref={sheetRef} signals={signals} />
    </SafeAreaView>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}
function Cell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={s.cellLabel}>{label}</Text>
      <Text style={[s.cellValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function DetailModal({ sig, onClose }: { sig: MobileSignal; onClose: () => void }) {
  const long = sig.direction === 'Long';
  const tc = tierColor(sig.riskLevel);
  const slDist = Math.abs(sig.sl - sig.price);
  const rr = slDist > 0 ? +(Math.abs(sig.tp1 - sig.price) / slDist).toFixed(2) : null;
  const usd = (pts: number) => `$${Math.abs(pts * MES_PER_PT).toFixed(0)}`;
  const levels = [
    { label: 'Entry', value: sig.price, color: Trading.text },
    { label: 'TP1', value: sig.tp1, color: Trading.long },
    { label: 'TP2', value: sig.tp2, color: Trading.long },
    { label: 'SL', value: sig.sl, color: Trading.short },
  ];
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={d.backdrop} onPress={onClose}>
        <Animated.View entering={FadeIn.duration(200)} style={d.sheet} onStartShouldSetResponder={() => true}>
          <View style={d.header}>
            <TierPill tier={sig.riskLevel} />
            <View style={[d.dirChip, { backgroundColor: (long ? Trading.long : Trading.short) + '20', borderColor: (long ? Trading.long : Trading.short) + '55' }]}>
              <Text style={[d.dirTxt, { color: long ? Trading.long : Trading.short }]}>{long ? '▲ LONG' : '▼ SHORT'}</Text>
            </View>
            {!sig.rth && <View style={d.tag}><Text style={d.tagTxt}>ETH</Text></View>}
            <View style={{ flex: 1 }} />
            <Pressable onPress={onClose} hitSlop={12}><Text style={d.close}>✕</Text></Pressable>
          </View>
          <Text style={d.sub}>{fmtDate(sig.time)} · {fmtTime(sig.time)} ET</Text>

          <View style={d.table}>
            {levels.map((row, i) => (
              <View key={row.label} style={[d.tRow, i === levels.length - 1 && { borderBottomWidth: 0 }]}>
                <Text style={d.tLabel}>{row.label}</Text>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[d.tValue, { color: row.color }]}>{row.value.toFixed(2)}</Text>
                  {row.label !== 'Entry' && (
                    <Text style={d.tSub}>{Math.abs(row.value - sig.price).toFixed(2)} pts · {usd(Math.abs(row.value - sig.price))}</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
          {rr !== null && <Text style={d.rr}>Risk / Reward · 1 : {rr}</Text>}

          <View style={d.outRow}>
            <Text style={[d.outTxt, { color: sig.outcome === 'Win' ? Trading.long : sig.outcome === 'Loss' ? Trading.short : sigAgeHours(sig) > ACTIVE_WINDOW_HOURS ? Trading.dim : tc }]}>
              {sig.outcome === 'Win' ? 'Win — TP1'
               : sig.outcome === 'Loss' ? 'Loss'
               : sigAgeHours(sig) > ACTIVE_WINDOW_HOURS ? 'Expired' : 'Active trade'}
            </Text>
            {sig.points != null && (
              <Text style={[d.pnl, { color: sig.points >= 0 ? Trading.long : Trading.short }]}>
                {sig.points >= 0 ? '+' : ''}{sig.points.toFixed(2)} pts
              </Text>
            )}
          </View>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  scroll: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 12 },

  statGrid: { flexDirection: 'row', gap: 7 },
  stat: { flex: 1, backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 8 },
  statLabel: { fontSize: 8, letterSpacing: 1, color: Trading.muted, fontWeight: '600' },
  statValue: { fontFamily: Fonts.mono, fontSize: 15, fontWeight: '600', color: Trading.text, marginTop: 3 },

  filterRow: { flexDirection: 'row', gap: 6, paddingRight: 8 },
  fc: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass },
  fcTxt: { fontFamily: Fonts.mono, fontSize: 10, fontWeight: '600', letterSpacing: 0.5, color: Trading.muted },

  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dateBtn: { width: 34, height: 30, borderRadius: 8, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass, alignItems: 'center', justifyContent: 'center' },
  dateArrow: { color: Trading.accent, fontSize: 18, lineHeight: 20, fontWeight: '700' },
  dateLabel: { flex: 1, textAlign: 'center', fontFamily: Fonts.mono, fontSize: 11, fontWeight: '700', letterSpacing: 1, color: Trading.text },
  todayBtn: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Trading.accent + '88', backgroundColor: Trading.accent + '20' },
  todayTxt: { fontFamily: Fonts.mono, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: Trading.accent },

  card: { backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 12, padding: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardId: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  side: { fontFamily: Fonts.mono, fontSize: 9, fontWeight: '600', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, letterSpacing: 0.5 },
  strat: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5, color: Trading.text, fontFamily: Fonts.display },
  time: { fontFamily: Fonts.mono, fontSize: 11, color: Trading.muted },
  grid: { flexDirection: 'row', gap: 6, marginVertical: 10 },
  cellLabel: { fontSize: 8, color: Trading.dim, letterSpacing: 0.5 },
  cellValue: { fontFamily: Fonts.mono, fontSize: 12, fontWeight: '500', color: Trading.text, marginTop: 2 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 9, borderTopWidth: 1, borderTopColor: Trading.lineSoft },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusTxt: { fontFamily: Fonts.mono, fontSize: 9, fontWeight: '600', letterSpacing: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  pnl: { fontFamily: Fonts.mono, fontSize: 12, fontWeight: '600' },

  empty: { paddingVertical: 40, alignItems: 'center' },
  emptyTxt: { color: Trading.muted, fontSize: 13 },
});

const d = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#0a0c12', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderColor: 'rgba(45,212,191,0.2)', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dirChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  dirTxt: { fontSize: 13, fontWeight: '800' },
  tag: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: Trading.muted + '40' },
  tagTxt: { fontSize: 9, fontWeight: '700', color: Trading.muted },
  close: { color: Trading.muted, fontSize: 18 },
  sub: { fontSize: 12, color: Trading.muted, marginTop: 10, marginBottom: 14 },
  table: { borderRadius: 10, borderWidth: 1, borderColor: Trading.line, overflow: 'hidden', backgroundColor: Trading.glass },
  tRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  tLabel: { fontSize: 12, color: Trading.muted, fontWeight: '600' },
  tValue: { fontFamily: Fonts.mono, fontSize: 15, fontWeight: '700' },
  tSub: { fontSize: 10, color: Trading.muted },
  rr: { fontSize: 11, color: Trading.muted, textAlign: 'center', marginTop: 14 },
  outRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 },
  outTxt: { fontSize: 15, fontWeight: '700' },
  pnl: { fontFamily: Fonts.mono, fontSize: 22, fontWeight: '800' },
});
