import { useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, Pressable, ScrollView, Modal,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useApp, Timeframe, EXIT_PROFILES, type ExitStrategy } from '@/context/app-context';
import { ChartView, type MobileSignal } from '@/components/chart-view';
import { StrategyToggle } from '@/components/strategy-toggle';
import { TierBadge } from '@/components/tier-badge';
import { Trading, Fonts, TIER, type TierKey } from '@/constants/theme';

type Segment   = 'chart' | 'signals';
type DirFilter = 'all' | 'long' | 'short';
type RiskFilter= 'all' | 'safeplus' | 'safe' | 'risky' | 'riskiest';
const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '60m'];
const MES_PER_PT = 5; // $5 per point per MES contract

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });
}
function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York',
  });
}
function fmtAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}
function tierColor(rl: string): string {
  return TIER[rl as TierKey]?.color ?? Trading.risky;
}
function ocColor(oc: string): string {
  return oc === 'Win' ? Trading.long : oc === 'Loss' ? Trading.short : Trading.muted;
}
function ptsToUsd(pts: number, contracts = 1): string {
  const val = pts * MES_PER_PT * contracts;
  return `$${Math.abs(val).toFixed(0)}`;
}

// 'YYYY-MM-DD' from unix timestamp (ET)
function toDateKey(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── Calendar ──────────────────────────────────────────────────────────────────
const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const DOW_LABELS  = ['Su','Mo','Tu','We','Th','Fr','Sa'];

function buildMonthGrid(year: number, month: number) {
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ day: number; dateKey: string }> = [];
  for (let i = 0; i < firstDow; i++) cells.push({ day: 0, dateKey: '' });
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    cells.push({ day: d, dateKey: key });
  }
  while (cells.length % 7 !== 0) cells.push({ day: 0, dateKey: '' });
  return cells;
}

function CalendarModal({ visible, selectedDate, signalDates, onSelect, onClose }:
  { visible: boolean; selectedDate: string | null; signalDates: Set<string>; onSelect: (k: string | null) => void; onClose: () => void }) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const todayKey = toDateKey(Math.floor(today.getTime() / 1000));
  const grid = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  const prevMonth = () => { if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0);  } else setViewMonth(m => m + 1); };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={cal.backdrop} onPress={onClose}>
        <Pressable style={cal.sheet} onPress={e => e.stopPropagation()}>
          <View style={cal.header}>
            <Pressable onPress={prevMonth} style={cal.navBtn}><Text style={cal.navArrow}>‹</Text></Pressable>
            <Text style={cal.monthLabel}>{MONTH_NAMES[viewMonth]} {viewYear}</Text>
            <Pressable onPress={nextMonth} style={cal.navBtn}><Text style={cal.navArrow}>›</Text></Pressable>
          </View>
          <View style={cal.dowRow}>{DOW_LABELS.map(d => <Text key={d} style={cal.dowLabel}>{d}</Text>)}</View>
          <View style={cal.grid}>
            {grid.map((cell, i) => {
              if (cell.day === 0) return <View key={i} style={cal.dayCell} />;
              const isToday = cell.dateKey === todayKey;
              const isSel   = cell.dateKey === selectedDate;
              const hasSig  = signalDates.has(cell.dateKey);
              const isWknd  = (i % 7 === 0 || i % 7 === 6);
              return (
                <Pressable key={cell.dateKey} style={[cal.dayCell, isSel && cal.daySel, isToday && !isSel && cal.dayToday]}
                  onPress={() => { onSelect(isSel ? null : cell.dateKey); onClose(); }}>
                  <Text style={[cal.dayText, isSel && cal.dayTextSel, isWknd && !isSel && { color: Trading.muted }, !isSel && isToday && { color: Trading.accent }]}>{cell.day}</Text>
                  {hasSig && !isSel && <View style={cal.dot} />}
                </Pressable>
              );
            })}
          </View>
          <View style={cal.footer}>
            <Pressable style={cal.clearBtn} onPress={() => { onSelect(toDateKey(Math.floor(Date.now()/1000))); onClose(); }}>
              <Text style={cal.clearText}>Today</Text>
            </Pressable>
            <Pressable style={[cal.clearBtn, { borderColor: Trading.muted + '44' }]} onPress={() => { onSelect(null); onClose(); }}>
              <Text style={[cal.clearText, { color: Trading.muted }]}>All Dates</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Apply exit profile ────────────────────────────────────────────────────────
function applyExitProfile(sig: MobileSignal, strategy: ExitStrategy): MobileSignal {
  if (strategy === 'current') return sig;
  const pre = sig.exitOutcomes[strategy];
  if (!pre) return sig;
  return { ...sig, tp1: pre.tp1, tp2: pre.tp2, sl: pre.sl, outcome: pre.outcome, tpHit: pre.tpHit, points: pre.points };
}

// ── Confirmation chips ────────────────────────────────────────────────────────
function ConfirmChips({ sig, compact = false }: { sig: MobileSignal; compact?: boolean }) {
  const chips = [
    { key: 'milk', label: compact ? 'MZ' : 'MilkZone', pts: sig.strategies.milkPts, active: sig.strategies.milk },
    { key: 'vec',  label: compact ? 'Vec' : 'Vector',   pts: 2,                       active: sig.strategies.vec  },
    { key: 'fp',   label: compact ? 'FP' : 'Footprint', pts: 2,                       active: sig.strategies.fp   },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {chips.map(c => (
        <View key={c.key} style={[cc.chip,
          c.active ? { borderColor: Trading.safe + '60', backgroundColor: Trading.safe + '14' }
                   : { borderColor: Trading.dim + '40', opacity: 0.45 }]}>
          <Text style={[cc.text, { color: c.active ? Trading.safe : Trading.muted }]}>
            {c.active ? '✓ ' : '— '}{c.label}
          </Text>
        </View>
      ))}
    </View>
  );
}
const cc = StyleSheet.create({
  chip: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  text: { fontSize: 10, fontWeight: '600' },
});

// ── Hero Signal Card ──────────────────────────────────────────────────────────
function SignalHeroCard({ sig, onTap }: { sig: MobileSignal; onTap: () => void }) {
  const isLong  = sig.direction === 'Long';
  const tc      = tierColor(sig.riskLevel);
  const slPts   = Math.abs(sig.price - sig.sl);
  const tp1Pts  = Math.abs(sig.price - sig.tp1);
  const rrRatio = slPts > 0 ? (tp1Pts / slPts).toFixed(1) : '—';
  const isWin   = sig.outcome === 'Win';
  const isLoss  = sig.outcome === 'Loss';

  const cols = [
    { label: 'STOP',   price: sig.sl,    pts: slPts,  color: Trading.short },
    { label: 'ENTRY',  price: sig.price,  pts: 0,      color: Trading.text  },
    { label: 'TARGET', price: sig.tp1,    pts: tp1Pts, color: Trading.long  },
  ];

  return (
    <Pressable onPress={onTap} style={[hc.card, { borderColor: tc + '55' }]}>
      {/* Tier-colored accent bar */}
      <View style={[hc.accentBar, { backgroundColor: tc }]} />

      <View style={hc.inner}>
        {/* Row 1: Tier + direction + time */}
        <View style={hc.topRow}>
          <TierBadge level={sig.riskLevel} size="md" />
          <View style={[hc.dirChip, { backgroundColor: (isLong ? Trading.long : Trading.short) + '20', borderColor: (isLong ? Trading.long : Trading.short) + '60' }]}>
            <Text style={[hc.dirText, { color: isLong ? Trading.long : Trading.short }]}>
              {isLong ? '▲ LONG' : '▼ SHORT'}
            </Text>
          </View>
          <View style={{ flex: 1 }} />
          <Text style={hc.agoText}>{fmtAgo(sig.time)}</Text>
        </View>

        <Text style={hc.candle}>on closed candle · {fmtDate(sig.time)} {fmtTime(sig.time)}</Text>

        {/* Row 2: Stop / Entry / Target */}
        <View style={hc.levelsRow}>
          {cols.map((col, i) => (
            <View key={col.label} style={[hc.levelCol, i === 1 && hc.levelColCenter]}>
              <Text style={[hc.levelLabel, { color: col.color }]}>{col.label}</Text>
              <Text style={[hc.levelPrice, { color: col.color, fontFamily: Fonts?.mono }]}>{col.price.toFixed(2)}</Text>
              {col.pts > 0 && (
                <Text style={[hc.levelSub, { fontFamily: Fonts?.mono }]}>
                  {col.pts.toFixed(1)} pts · {ptsToUsd(col.pts)}
                </Text>
              )}
            </View>
          ))}
        </View>

        {/* Row 3: R:R + outcome + confirmation chips */}
        <View style={hc.footerRow}>
          <View style={hc.rrChip}>
            <Text style={hc.rrLabel}>R:R</Text>
            <Text style={[hc.rrValue, { fontFamily: Fonts?.mono }]}>1 : {rrRatio}</Text>
          </View>
          {sig.outcome !== 'Open' && (
            <View style={[hc.outcomeChip, { backgroundColor: ocColor(sig.outcome) + '20', borderColor: ocColor(sig.outcome) + '55' }]}>
              <Text style={[hc.outcomeText, { color: ocColor(sig.outcome) }]}>
                {isWin ? `Win TP${sig.tpHit}` : isLoss ? 'Loss' : 'Open'}
                {sig.points !== null ? `  ${sig.points >= 0 ? '+' : ''}${sig.points.toFixed(1)}pts` : ''}
              </Text>
            </View>
          )}
          <View style={{ flex: 1 }} />
          <ConfirmChips sig={sig} compact />
        </View>
      </View>
    </Pressable>
  );
}
const hc = StyleSheet.create({
  card: {
    marginHorizontal: 14, marginTop: 10,
    borderRadius: 12, borderWidth: 1,
    backgroundColor: Trading.surface,
    flexDirection: 'row', overflow: 'hidden',
  },
  accentBar: { width: 4 },
  inner: { flex: 1, padding: 14, gap: 10 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dirChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  dirText: { fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  agoText: { color: Trading.muted, fontSize: 11 },
  candle:  { color: Trading.muted, fontSize: 10, marginTop: -6 },
  levelsRow: { flexDirection: 'row', gap: 0 },
  levelCol: { flex: 1, alignItems: 'center', gap: 2 },
  levelColCenter: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: Trading.border },
  levelLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  levelPrice: { fontSize: 18, fontWeight: '700' },
  levelSub:   { fontSize: 9, color: Trading.textSecondary },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rrChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Trading.surfaceAlt, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1, borderColor: Trading.border,
  },
  rrLabel: { color: Trading.muted, fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  rrValue: { color: Trading.text, fontSize: 11, fontWeight: '700' },
  outcomeChip: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  outcomeText: { fontSize: 10, fontWeight: '700' },
});

// ── No-signal scanning state ──────────────────────────────────────────────────
function ScanningCard() {
  return (
    <View style={sc.card}>
      <Text style={sc.icon}>◌</Text>
      <Text style={sc.title}>Scanning — no qualifying setup</Text>
      <Text style={sc.sub}>A signal will appear here when MilkZone + Vector + Footprint align on a closed candle</Text>
    </View>
  );
}
const sc = StyleSheet.create({
  card:  { marginHorizontal: 14, marginTop: 10, backgroundColor: Trading.surface, borderRadius: 12, borderWidth: 1, borderColor: Trading.border, padding: 24, alignItems: 'center', gap: 8 },
  icon:  { fontSize: 32, color: Trading.muted, marginBottom: 4 },
  title: { color: Trading.textSecondary, fontSize: 14, fontWeight: '600' },
  sub:   { color: Trading.muted, fontSize: 11, textAlign: 'center', lineHeight: 16 },
});

// ── Signal detail modal ───────────────────────────────────────────────────────
function SignalDetailModal({ sig, onClose, onViewOnChart }: { sig: MobileSignal; onClose: () => void; onViewOnChart: (t: number) => void }) {
  const isLong = sig.direction === 'Long';
  const tc     = tierColor(sig.riskLevel);
  const oc     = ocColor(sig.outcome);
  const slDist = Math.abs(sig.sl - sig.price);
  const rr     = slDist > 0 ? +(Math.abs(sig.tp1 - sig.price) / slDist).toFixed(2) : null;

  const levels = [
    { label: 'Entry', value: sig.price.toFixed(2), color: Trading.text },
    { label: 'TP1',   value: sig.tp1.toFixed(2),   color: Trading.long },
    { label: 'TP2',   value: sig.tp2.toFixed(2),   color: Trading.long },
    { label: 'SL',    value: sig.sl.toFixed(2),    color: Trading.short },
  ];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={det.backdrop} onPress={onClose}>
        <Pressable style={det.sheet} onPress={e => e.stopPropagation()}>
          {/* Header */}
          <View style={det.header}>
            <TierBadge level={sig.riskLevel} size="lg" />
            <View style={[det.dirChip, { backgroundColor: (isLong ? Trading.long : Trading.short) + '20', borderColor: (isLong ? Trading.long : Trading.short) + '55' }]}>
              <Text style={[det.dirText, { color: isLong ? Trading.long : Trading.short }]}>{isLong ? '▲ LONG' : '▼ SHORT'}</Text>
            </View>
            {!sig.rth && (
              <View style={[det.tagChip, { borderColor: Trading.muted + '40' }]}>
                <Text style={[det.tagText, { color: Trading.muted }]}>ETH</Text>
              </View>
            )}
            <View style={{ flex: 1 }} />
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={det.close}>✕</Text>
            </Pressable>
          </View>
          <Text style={det.subtitle}>{fmtDate(sig.time)} · {fmtTime(sig.time)}</Text>

          {/* Price levels */}
          <View style={det.table}>
            {levels.map((row, i) => (
              <View key={row.label} style={[det.tRow, i === levels.length - 1 && { borderBottomWidth: 0 }]}>
                <Text style={det.tLabel}>{row.label}</Text>
                <View style={{ alignItems: 'flex-end', gap: 1 }}>
                  <Text style={[det.tValue, { color: row.color, fontFamily: Fonts?.mono }]}>{row.value}</Text>
                  {row.label !== 'Entry' && (
                    <Text style={det.tSub}>{Math.abs(+row.value - sig.price).toFixed(2)} pts · {ptsToUsd(Math.abs(+row.value - sig.price))}</Text>
                  )}
                </View>
              </View>
            ))}
          </View>

          {rr !== null && <Text style={det.rr}>Risk / Reward · 1 : {rr}</Text>}

          {/* Confirmation chips */}
          <View style={{ marginBottom: 14 }}>
            <Text style={det.sectionLabel}>CONFIRMATIONS</Text>
            <ConfirmChips sig={sig} />
          </View>

          {/* Outcome */}
          <View style={det.outcomeRow}>
            <Text style={[det.outcomeText, { color: oc }]}>
              {sig.outcome === 'Open' ? 'Open trade' : sig.outcome === 'Win' ? `Win — TP${sig.tpHit}` : 'Loss'}
            </Text>
            {sig.points !== null && (
              <Text style={[det.pnlText, { color: sig.points >= 0 ? Trading.long : Trading.short }]}>
                {sig.points >= 0 ? '+' : ''}{sig.points.toFixed(2)} pts
              </Text>
            )}
          </View>

          <Pressable style={det.chartBtn} onPress={() => onViewOnChart(sig.time)}>
            <Text style={det.chartBtnTxt}>View on Chart  →</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Main Signals Tab ──────────────────────────────────────────────────────────
export default function SignalsTab() {
  const { timeframe, setTimeframe, apiBaseUrl, strategies, toggleStrategy, zones, setZones, exitStrategy } = useApp();
  const [segment,      setSegment]      = useState<Segment>('chart');
  const [chartSignals, setChartSignals] = useState<MobileSignal[]>([]);
  const [dirFilter,    setDirFilter]    = useState<DirFilter>('all');
  const [riskFilter,   setRiskFilter]   = useState<RiskFilter>('all');
  const [selectedDate, setSelectedDate] = useState<string | null>(() => toDateKey(Math.floor(Date.now() / 1000)));
  const [calVisible,   setCalVisible]   = useState(false);
  const [importingZones, setImportingZones] = useState(false);
  const [selectedSig,  setSelectedSig]  = useState<MobileSignal | null>(null);
  const [scrollToTime, setScrollToTime] = useState<number | null>(null);
  const [rthOnly,      setRthOnly]      = useState(false);
  const priceRangeRef = useRef<{ high: number; low: number } | null>(null);

  const onChartSignals = useCallback((sigs: MobileSignal[]) => {
    setChartSignals([...sigs].sort((a, b) => b.time - a.time));
  }, []);

  const signalDates = useMemo(() => {
    const s = new Set<string>();
    chartSignals.forEach(sig => s.add(toDateKey(sig.time)));
    return s;
  }, [chartSignals]);

  const filtered = useMemo(() =>
    chartSignals
      .filter(s => {
        if (dirFilter === 'long'  && s.direction !== 'Long')  return false;
        if (dirFilter === 'short' && s.direction !== 'Short') return false;
        if (riskFilter !== 'all'  && s.riskLevel !== riskFilter) return false;
        if (selectedDate && toDateKey(s.time) < selectedDate) return false;
        if (rthOnly && !s.rth) return false;
        return true;
      })
      .map(s => applyExitProfile(s, exitStrategy)),
  [chartSignals, dirFilter, riskFilter, selectedDate, rthOnly, exitStrategy]);

  const stats = useMemo(() => {
    const decided = filtered.filter(s => s.outcome !== 'Open');
    const wins    = decided.filter(s => s.outcome === 'Win').length;
    const pnl     = decided.reduce((sum, s) => sum + (s.points ?? 0), 0);
    return {
      total: filtered.length, wins, losses: decided.length - wins,
      open: filtered.length - decided.length,
      wr: decided.length ? Math.round(wins / decided.length * 100) : null, pnl,
    };
  }, [filtered]);

  // Most recent signal for hero card (from ALL signals, not just filtered)
  const heroSig = chartSignals[0] ?? null;

  async function importZones() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo library access to import zones.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, base64: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    if (!asset.base64) { Alert.alert('Error', 'Could not read image data.'); return; }
    setImportingZones(true);
    try {
      const resp = await fetch(`${apiBaseUrl}/api/zones/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: asset.fileName ?? 'screenshot.png', data: asset.base64, mediaType: asset.mimeType ?? 'image/png', visibleHigh: priceRangeRef.current?.high, visibleLow: priceRangeRef.current?.low }),
      });
      const data = await resp.json();
      if (data.zones?.length) {
        setZones(data.zones);
        Alert.alert('Zones loaded', `Found ${data.zones.length} zone${data.zones.length !== 1 ? 's' : ''}.`);
      } else Alert.alert('No zones found', 'Could not detect zones in this image.');
    } catch (e) {
      Alert.alert('Import failed', String(e));
    } finally { setImportingZones(false); }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>

      {/* ── App bar ──────────────────────────────────────────────────────────── */}
      <View style={s.appBar}>
        <View style={s.tfRow}>
          {TIMEFRAMES.map(tf => (
            <Pressable key={tf} onPress={() => setTimeframe(tf)}
              style={[s.tfBtn, timeframe === tf && { borderColor: Trading.accent, backgroundColor: Trading.accent + '22' }]}>
              <Text style={[s.tfLabel, timeframe === tf && { color: Trading.accent }]}>{tf}</Text>
            </Pressable>
          ))}
        </View>

        {/* Segmented control */}
        <View style={s.segPill}>
          <Pressable style={[s.segBtn, segment === 'chart'   && s.segBtnOn]} onPress={() => { setSegment('chart'); setScrollToTime(null); }}>
            <Text style={[s.segLbl, segment === 'chart'   && { color: '#fff' }]}>Chart</Text>
          </Pressable>
          <Pressable style={[s.segBtn, segment === 'signals' && s.segBtnOn]} onPress={() => setSegment('signals')}>
            <Text style={[s.segLbl, segment === 'signals' && { color: '#fff' }]}>Signals</Text>
          </Pressable>
        </View>
      </View>

      {/* ── Strategy toggles ─────────────────────────────────────────────────── */}
      <View style={s.stratBar}>
        <StrategyToggle label="Milk Zones" color={Trading.milkZones} active={strategies.milkZones} onPress={() => toggleStrategy('milkZones')} />
        <StrategyToggle label="Vector"     color={Trading.vector}    active={strategies.vector}    onPress={() => toggleStrategy('vector')} />
        <StrategyToggle label="Footprint"  color={Trading.footprint}  active={strategies.footprint}  onPress={() => toggleStrategy('footprint')} />
        {/* Zone badge */}
        {strategies.milkZones && zones.length > 0 && (
          <Pressable onPress={() => setZones([])} style={s.zoneBadge}>
            <View style={[s.zoneDot, { backgroundColor: Trading.milkZones }]} />
            <Text style={[s.zoneBadgeText, { color: Trading.milkZones }]}>{zones.length}z</Text>
          </Pressable>
        )}
      </View>

      {/* Zone import banner */}
      {strategies.milkZones && zones.length === 0 && (
        <Pressable style={[s.zoneBanner, importingZones && { opacity: 0.7 }]} onPress={importZones} disabled={importingZones}>
          {importingZones
            ? <><ActivityIndicator color={Trading.milkZones} size="small" /><Text style={[s.zoneBannerTxt, { color: Trading.milkZones }]}>Reading zones…</Text></>
            : <><View style={[s.zoneDot, { backgroundColor: Trading.milkZones }]} /><Text style={[s.zoneBannerTxt, { color: Trading.milkZones }]}>Tap to import Milk Zones screenshot</Text></>}
        </Pressable>
      )}

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      <View style={{ flex: 1 }}>

        {/* Chart — always mounted */}
        <View style={[StyleSheet.absoluteFillObject, { opacity: segment === 'chart' ? 1 : 0 }]}
          pointerEvents={segment === 'chart' ? 'auto' : 'none'}>
          <ChartView
            onPriceRange={(high, low) => { priceRangeRef.current = { high, low }; }}
            onSignals={onChartSignals}
            scrollToTime={scrollToTime}
          />
        </View>

        {/* ── Signals segment ─────────────────────────────────────────────── */}
        {segment === 'signals' && (
          <View style={[StyleSheet.absoluteFillObject, { backgroundColor: Trading.bg }]}>
            <ScrollView showsVerticalScrollIndicator={false}>

              {/* Hero card — most recent signal */}
              {heroSig ? (
                <SignalHeroCard sig={heroSig} onTap={() => setSelectedSig(heroSig)} />
              ) : (
                <ScanningCard />
              )}

              {/* Stats + filters */}
              <View style={s.statsRow}>
                <Text style={[s.statWr, { color: stats.wr !== null ? (stats.wr >= 50 ? Trading.long : Trading.short) : Trading.muted }]}>
                  {stats.wr !== null ? `${stats.wr}%` : '—%'}
                </Text>
                <Text style={s.statLabel}>WR</Text>
                <View style={s.statDiv} />
                <Text style={[s.statNum, { color: Trading.long }]}>{stats.wins}W</Text>
                <Text style={[s.statNum, { color: Trading.short }]}>{stats.losses}L</Text>
                <Text style={[s.statNum, { color: Trading.muted }]}>{stats.open} open</Text>
                <View style={s.statDiv} />
                <Text style={[s.statPnl, { color: stats.pnl >= 0 ? Trading.long : Trading.short, fontFamily: Fonts?.mono }]}>
                  {stats.pnl >= 0 ? '+' : ''}{stats.pnl.toFixed(1)} pts
                </Text>
                <Text style={[s.statLabel, { color: Trading.muted }]}>{stats.total} sig</Text>
              </View>

              {/* Filter row 1 */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterScroll} contentContainerStyle={s.filterRow}>
                {(['all', 'long', 'short'] as DirFilter[]).map(d => {
                  const col = d === 'long' ? Trading.long : d === 'short' ? Trading.short : Trading.accent;
                  const on  = dirFilter === d;
                  return (
                    <Pressable key={d} onPress={() => setDirFilter(d)} style={[s.fc, on && { borderColor: col + '88', backgroundColor: col + '18' }]}>
                      <Text style={[s.ft, on && { color: col }]}>{d === 'all' ? 'All' : d === 'long' ? '▲ Long' : '▼ Short'}</Text>
                    </Pressable>
                  );
                })}
                <View style={s.filterSep} />
                <Pressable onPress={() => setRthOnly(v => !v)} style={[s.fc, rthOnly && { borderColor: Trading.accent + '88', backgroundColor: Trading.accent + '18' }]}>
                  <Text style={[s.ft, rthOnly && { color: Trading.accent }]}>RTH</Text>
                </Pressable>
                <View style={s.filterSep} />
                <Pressable onPress={() => setCalVisible(true)} style={[s.fc, selectedDate !== null && { borderColor: Trading.vector + '88', backgroundColor: Trading.vector + '18' }]}>
                  <Text style={[s.ft, selectedDate !== null && { color: Trading.vector }]}>
                    {selectedDate ? (selectedDate === toDateKey(Math.floor(Date.now()/1000)) ? 'Today' : 'From ' + new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : '📅 Date'}
                  </Text>
                </Pressable>
                {selectedDate !== null && (
                  <Pressable onPress={() => setSelectedDate(null)} style={s.fc}><Text style={[s.ft, { color: Trading.muted }]}>✕</Text></Pressable>
                )}
              </ScrollView>

              {/* Filter row 2: Risk tier */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterScroll} contentContainerStyle={s.filterRow}>
                {(['all', 'safeplus', 'safe', 'risky', 'riskiest'] as RiskFilter[]).map(r => {
                  const col = r === 'all' ? Trading.accent : tierColor(r);
                  const on  = riskFilter === r;
                  return (
                    <Pressable key={r} onPress={() => setRiskFilter(r)} style={[s.fc, on && { borderColor: col + '80', backgroundColor: col + '18' }]}>
                      <Text style={[s.ft, on && { color: col }]}>
                        {r === 'all' ? 'All' : r === 'safeplus' ? `◆ SAFE+` : r === 'safe' ? `◆ SAFE` : r === 'risky' ? `△ RISKY` : `▽ RISKIEST`}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {/* Signal feed */}
              {filtered.length === 0 ? (
                <View style={s.empty}>
                  <Text style={s.emptyText}>{chartSignals.length === 0 ? 'Switch to Chart to load signals' : 'No signals match filters'}</Text>
                </View>
              ) : (
                filtered.map((sig, idx) => {
                  const isLong   = sig.direction === 'Long';
                  const tc       = tierColor(sig.riskLevel);
                  const oc       = ocColor(sig.outcome);
                  const pnlStr   = sig.points !== null ? `${sig.points >= 0 ? '+' : ''}${sig.points.toFixed(1)}` : '—';
                  const pnlDol   = sig.points !== null ? ptsToUsd(Math.abs(sig.points)) : '';
                  return (
                    <Pressable key={`${sig.time}-${sig.direction}-${idx}`}
                      onPress={() => setSelectedSig(sig)}
                      style={({ pressed }) => [sf.row, pressed && { backgroundColor: Trading.accent + '0c' }]}>
                      {/* Tier-colored left border */}
                      <View style={[sf.tierBar, { backgroundColor: tc }]} />
                      <View style={sf.body}>
                        {/* Row 1: direction + entry + time */}
                        <View style={sf.topRow}>
                          <Text style={[sf.dir, { color: isLong ? Trading.long : Trading.short }]}>
                            {isLong ? '▲' : '▼'} {isLong ? 'LONG' : 'SHORT'}
                          </Text>
                          <Text style={[sf.entry, { fontFamily: Fonts?.mono }]}>{sig.price.toFixed(2)}</Text>
                          <View style={{ flex: 1 }} />
                          <Text style={sf.time}>{fmtDate(sig.time)} {fmtTime(sig.time)}</Text>
                        </View>
                        {/* Row 2: confirmations + outcome */}
                        <View style={sf.bottomRow}>
                          <ConfirmChips sig={sig} compact />
                          <View style={{ flex: 1 }} />
                          {sig.outcome !== 'Open' && (
                            <View style={{ alignItems: 'flex-end' }}>
                              <Text style={[sf.pnl, { color: oc, fontFamily: Fonts?.mono }]}>{pnlStr} pts</Text>
                              <Text style={[sf.pnlDol, { color: oc + 'aa' }]}>{pnlDol}</Text>
                            </View>
                          )}
                          {sig.outcome === 'Open' && <Text style={[sf.open]}>open</Text>}
                        </View>
                      </View>
                    </Pressable>
                  );
                })
              )}

              <View style={{ height: 40 }} />
            </ScrollView>
          </View>
        )}

        {/* Modals */}
        <CalendarModal visible={calVisible} selectedDate={selectedDate} signalDates={signalDates} onSelect={setSelectedDate} onClose={() => setCalVisible(false)} />
        {selectedSig && (
          <SignalDetailModal sig={selectedSig} onClose={() => setSelectedSig(null)}
            onViewOnChart={(time) => { setSelectedSig(null); setScrollToTime(time); setSegment('chart'); }} />
        )}
      </View>

    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Trading.bg },

  appBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 10, borderBottomWidth: 1, borderBottomColor: Trading.border },
  tfRow:  { flexDirection: 'row', gap: 4 },
  tfBtn:  { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: Trading.border },
  tfLabel:{ color: Trading.muted, fontSize: 12, fontWeight: '600' },

  segPill: { flexDirection: 'row', backgroundColor: Trading.surfaceAlt, borderRadius: 8, padding: 2, borderWidth: 1, borderColor: Trading.border },
  segBtn:  { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6 },
  segBtnOn:{ backgroundColor: Trading.accent },
  segLbl:  { color: Trading.muted, fontSize: 12, fontWeight: '600' },

  stratBar: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: Trading.border, alignItems: 'center' },
  zoneBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: Trading.milkZones + '50', backgroundColor: Trading.milkZones + '10' },
  zoneBadgeText: { fontSize: 10, fontWeight: '700' },
  zoneDot: { width: 6, height: 6, borderRadius: 3 },
  zoneBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginTop: 6, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: Trading.milkZones + '50', backgroundColor: Trading.milkZones + '10' },
  zoneBannerTxt: { fontSize: 12, fontWeight: '600' },

  // Stats bar
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, marginTop: 10, backgroundColor: Trading.surface, borderRadius: 10, marginHorizontal: 14, borderWidth: 1, borderColor: Trading.border },
  statWr:   { fontSize: 20, fontWeight: '800' },
  statLabel:{ fontSize: 9, color: Trading.muted, fontWeight: '600', letterSpacing: 0.4 },
  statDiv:  { width: 1, height: 16, backgroundColor: Trading.border },
  statNum:  { fontSize: 12, fontWeight: '700' },
  statPnl:  { fontSize: 12, fontWeight: '700' },

  // Filters
  filterScroll:  { paddingHorizontal: 14, marginTop: 8 },
  filterRow:     { flexDirection: 'row', gap: 6, paddingRight: 14 },
  fc:            { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Trading.border, backgroundColor: Trading.surface },
  ft:            { fontSize: 11, color: Trading.muted, fontWeight: '600' },
  filterSep:     { width: 1, backgroundColor: Trading.border, alignSelf: 'stretch', marginVertical: 4 },

  empty:     { paddingVertical: 40, alignItems: 'center' },
  emptyText: { color: Trading.muted, fontSize: 13 },
});

// Signal feed row
const sf = StyleSheet.create({
  row:      { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: Trading.border + '55' },
  tierBar:  { width: 3 },
  body:     { flex: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
  topRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dir:      { fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  entry:    { fontSize: 13, fontWeight: '700', color: Trading.text },
  time:     { fontSize: 10, color: Trading.muted },
  bottomRow:{ flexDirection: 'row', alignItems: 'center', gap: 6 },
  pnl:      { fontSize: 13, fontWeight: '700' },
  pnlDol:   { fontSize: 9 },
  open:     { fontSize: 10, color: Trading.muted, fontStyle: 'italic' },
});

// Calendar
const CELL = 38;
const cal = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', alignItems: 'center', justifyContent: 'center' },
  sheet:    { width: 300, borderRadius: 14, backgroundColor: Trading.surface, borderWidth: 1, borderColor: Trading.border, overflow: 'hidden' },
  header:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Trading.border },
  monthLabel:{ fontSize: 14, fontWeight: '700', color: Trading.text },
  navBtn:   { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  navArrow: { fontSize: 22, color: Trading.accent, fontWeight: '300' },
  dowRow:   { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6 },
  dowLabel: { width: CELL, textAlign: 'center', fontSize: 10, color: Trading.muted, fontWeight: '600' },
  grid:     { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingBottom: 8 },
  dayCell:  { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center' },
  daySel:   { backgroundColor: Trading.accent, borderRadius: CELL / 2 },
  dayToday: { borderWidth: 1, borderColor: Trading.accent + '66', borderRadius: CELL / 2 },
  dayText:  { fontSize: 13, color: Trading.text },
  dayTextSel: { color: '#fff', fontWeight: '700' },
  dot:      { position: 'absolute', bottom: 5, width: 4, height: 4, borderRadius: 2, backgroundColor: Trading.accent },
  footer:   { borderTopWidth: 1, borderTopColor: Trading.border, padding: 10, flexDirection: 'row', justifyContent: 'center', gap: 12 },
  clearBtn: { paddingVertical: 6, paddingHorizontal: 16, borderWidth: 1, borderColor: Trading.border, borderRadius: 8 },
  clearText:{ fontSize: 12, color: Trading.accent, fontWeight: '600' },
});

// Signal detail modal
const det = StyleSheet.create({
  backdrop:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end' },
  sheet:     { backgroundColor: Trading.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, borderColor: Trading.border, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 44, gap: 0 },
  header:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  dirChip:   { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  dirText:   { fontSize: 14, fontWeight: '800' },
  tagChip:   { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, borderWidth: 1 },
  tagText:   { fontSize: 9, fontWeight: '700' },
  close:     { color: Trading.muted, fontSize: 18, paddingLeft: 8 },
  subtitle:  { fontSize: 12, color: Trading.muted, marginBottom: 14 },
  table:     { borderRadius: 10, borderWidth: 1, borderColor: Trading.border, overflow: 'hidden', marginBottom: 12, backgroundColor: Trading.panel },
  tRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Trading.border + '55' },
  tLabel:    { fontSize: 12, color: Trading.muted, fontWeight: '600' },
  tValue:    { fontSize: 15, fontWeight: '700' },
  tSub:      { fontSize: 10, color: Trading.muted },
  rr:        { fontSize: 11, color: Trading.muted, textAlign: 'center', marginBottom: 14 },
  sectionLabel: { fontSize: 9, color: Trading.muted, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  outcomeRow:{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, marginBottom: 18 },
  outcomeText:{ fontSize: 15, fontWeight: '700' },
  pnlText:   { fontSize: 24, fontWeight: '800' },
  chartBtn:  { backgroundColor: Trading.accent + '20', borderWidth: 1, borderColor: Trading.accent + '60', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  chartBtnTxt:{ color: Trading.accent, fontSize: 14, fontWeight: '700', letterSpacing: 0.3 },
});
