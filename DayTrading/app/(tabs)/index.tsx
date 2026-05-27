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
import { Trading } from '@/constants/theme';

type Segment = 'chart' | 'signals';
type DirFilter  = 'all' | 'long' | 'short';
type RiskFilter = 'all' | 'safeplus' | 'safe' | 'risky' | 'riskiest';
const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '60m'];

// ── Color palette ──────────────────────────────────────────────────────────────
const C = {
  bg:     '#000000',
  panel:  '#0d0d0d',
  border: '#1a1a1a',
  text:   '#ffffff',
  muted:  '#888888',
  dim:    '#555555',
  accent: '#3d8ef8',
  up:     '#00e676',
  down:   '#ff4444',
};

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

function rlColor(rl: string) {
  return rl === 'safeplus' ? '#a78bfa' : rl === 'safe' ? C.up : rl === 'risky' ? '#f59e0b' : C.down;
}

function ocColor(oc: string) {
  return oc === 'Win' ? C.up : oc === 'Loss' ? C.down : C.muted;
}

// ── Calendar helpers ──────────────────────────────────────────────────────────
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW_LABELS  = ['Su','Mo','Tu','We','Th','Fr','Sa'];

/** 'YYYY-MM-DD' from a unix timestamp (ET timezone) */
function toDateKey(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // en-CA = YYYY-MM-DD
}

/** Grid cells for a month calendar — 6 rows × 7 cols. Cells outside month have day = 0. */
function buildMonthGrid(year: number, month: number): Array<{ day: number; dateKey: string }> {
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ day: number; dateKey: string }> = [];
  // Leading empty cells
  for (let i = 0; i < firstDow; i++) cells.push({ day: 0, dateKey: '' });
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, dateKey: key });
  }
  // Trailing empty cells to complete the grid
  while (cells.length % 7 !== 0) cells.push({ day: 0, dateKey: '' });
  return cells;
}

interface CalendarProps {
  visible: boolean;
  selectedDate: string | null;    // 'YYYY-MM-DD' or null
  signalDates: Set<string>;       // dates that have signals
  onSelect: (dateKey: string | null) => void;
  onClose: () => void;
}

function CalendarModal({ visible, selectedDate, signalDates, onSelect, onClose }: CalendarProps) {
  const today = new Date();
  const [viewYear,  setViewYear]  = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const todayKey = toDateKey(Math.floor(today.getTime() / 1000));
  const grid = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={cal.backdrop} onPress={onClose}>
        <Pressable style={cal.sheet} onPress={e => e.stopPropagation()}>
          {/* Header */}
          <View style={cal.header}>
            <Pressable onPress={prevMonth} style={cal.navBtn}><Text style={cal.navArrow}>‹</Text></Pressable>
            <Text style={cal.monthLabel}>{MONTH_NAMES[viewMonth]} {viewYear}</Text>
            <Pressable onPress={nextMonth} style={cal.navBtn}><Text style={cal.navArrow}>›</Text></Pressable>
          </View>
          {/* DOW labels */}
          <View style={cal.dowRow}>
            {DOW_LABELS.map(d => <Text key={d} style={cal.dowLabel}>{d}</Text>)}
          </View>
          {/* Day grid */}
          <View style={cal.grid}>
            {grid.map((cell, i) => {
              if (cell.day === 0) return <View key={i} style={cal.dayCell} />;
              const isToday    = cell.dateKey === todayKey;
              const isSel      = cell.dateKey === selectedDate;
              const hasSignals = signalDates.has(cell.dateKey);
              const dow = (i % 7);
              const isWeekend = dow === 0 || dow === 6;
              return (
                <Pressable key={cell.dateKey} style={[cal.dayCell, isSel && cal.daySel, isToday && !isSel && cal.dayToday]}
                  onPress={() => { onSelect(isSel ? null : cell.dateKey); onClose(); }}>
                  <Text style={[cal.dayText, isSel && cal.dayTextSel, isWeekend && !isSel && { color: C.muted }, !isSel && isToday && { color: C.accent }]}>
                    {cell.day}
                  </Text>
                  {hasSignals && !isSel && <View style={cal.dot} />}
                </Pressable>
              );
            })}
          </View>
          {/* Footer */}
          <View style={cal.footer}>
            <Pressable style={cal.clearBtn} onPress={() => { onSelect(toDateKey(Math.floor(Date.now() / 1000))); onClose(); }}>
              <Text style={cal.clearText}>Today Only</Text>
            </Pressable>
            <Pressable style={[cal.clearBtn, { borderColor: C.dim }]} onPress={() => { onSelect(null); onClose(); }}>
              <Text style={[cal.clearText, { color: C.muted }]}>All Dates</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Apply an exit strategy profile to a signal using pre-computed outcomes ─────
function applyExitProfile(sig: MobileSignal, strategy: ExitStrategy): MobileSignal {
  if (strategy === 'current') return sig;
  const pre = sig.exitOutcomes[strategy];
  if (!pre) return sig;
  return { ...sig, tp1: pre.tp1, tp2: pre.tp2, sl: pre.sl, outcome: pre.outcome, tpHit: pre.tpHit, points: pre.points };
}

// ── Signal detail bottom sheet ─────────────────────────────────────────────────
interface SignalDetailProps {
  sig: MobileSignal;
  onClose: () => void;
  onViewOnChart: (time: number) => void;
}

function SignalDetailModal({ sig, onClose, onViewOnChart }: SignalDetailProps) {
  const isLong = sig.direction === 'Long';
  const rl     = rlColor(sig.riskLevel);
  const oc     = ocColor(sig.outcome);
  const slDist = Math.abs(sig.sl - sig.price);
  const rr     = slDist > 0 ? +(Math.abs(sig.tp1 - sig.price) / slDist).toFixed(2) : null;

  const levels = [
    { label: 'Entry', value: sig.price.toFixed(2), color: C.text },
    { label: 'TP1',   value: sig.tp1.toFixed(2),   color: '#67e8f9' },
    { label: 'TP2',   value: sig.tp2.toFixed(2),   color: '#22d3ee' },
    { label: 'SL',    value: sig.sl.toFixed(2),    color: '#f87171' },
  ];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={det.backdrop} onPress={onClose}>
        <Pressable style={det.sheet} onPress={e => e.stopPropagation()}>

          {/* Header row */}
          <View style={det.header}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[det.dir, { color: isLong ? C.up : C.down }]}>
                {isLong ? '▲ Long' : '▼ Short'}
              </Text>
              <View style={[det.badge, { borderColor: rl + '55', backgroundColor: rl + '18' }]}>
                <Text style={[det.badgeText, { color: rl }]}>{sig.riskLevel}</Text>
              </View>
              {!sig.rth && (
                <View style={[det.badge, { borderColor: C.muted + '44', backgroundColor: C.muted + '11' }]}>
                  <Text style={[det.badgeText, { color: C.muted }]}>ETH</Text>
                </View>
              )}
            </View>
            <Pressable onPress={onClose} style={det.closeBtn} hitSlop={10}>
              <Text style={det.closeTxt}>✕</Text>
            </Pressable>
          </View>

          <Text style={det.subtitle}>{fmtDate(sig.time)}  ·  {fmtTime(sig.time)}</Text>

          {/* Price levels table */}
          <View style={det.table}>
            {levels.map((row, i) => (
              <View key={row.label} style={[det.tRow, i === levels.length - 1 && { borderBottomWidth: 0 }]}>
                <Text style={det.tLabel}>{row.label}</Text>
                <Text style={[det.tValue, { color: row.color }]}>{row.value}</Text>
              </View>
            ))}
          </View>

          {/* R:R */}
          {rr !== null && (
            <Text style={det.rr}>Risk / Reward  ·  1 : {rr}</Text>
          )}

          {/* Strategies used */}
          <View style={det.stratRow}>
            <Text style={det.stratLabel}>Strategies</Text>
            <View style={det.stratChips}>
              {[
                { key: 'fp',   label: 'Footprint',  active: sig.strategies.fp,   detail: sig.strategies.fp ? 'delta agrees' : '' },
                { key: 'milk', label: sig.strategies.milkPts === 3 ? 'Milk ×3' : sig.strategies.milkPts === 1 ? 'Milk ×1' : 'Milk Zone',
                               active: sig.strategies.milk,  detail: sig.strategies.milk ? `${sig.strategies.milkPts}pts` : '' },
                { key: 'vec',  label: 'Vector',      active: sig.strategies.vec,  detail: sig.strategies.vec ? '2pts' : '' },
              ].map(st => (
                <View key={st.key}
                  style={[det.stratChip,
                    st.active
                      ? { borderColor: '#4ade8055', backgroundColor: '#4ade8012' }
                      : { borderColor: C.border,    backgroundColor: 'transparent', opacity: 0.4 }]}>
                  <Text style={[det.stratChipTxt, { color: st.active ? '#4ade80' : C.muted }]}>
                    {st.active ? '✓ ' : '— '}{st.label}
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {/* Outcome + P&L */}
          <View style={det.outcomeRow}>
            <Text style={[det.outcomeText, { color: oc }]}>
              {sig.outcome === 'Open' ? 'Open trade'
                : sig.outcome === 'Win' ? `Win — TP${sig.tpHit}`
                : 'Loss'}
            </Text>
            {sig.points !== null && (
              <Text style={[det.pnlText, { color: sig.points >= 0 ? C.up : C.down }]}>
                {sig.points >= 0 ? '+' : ''}{sig.points.toFixed(2)} pts
              </Text>
            )}
          </View>

          {/* View on Chart */}
          <Pressable style={({ pressed }) => [det.chartBtn, pressed && { opacity: 0.75 }]}
            onPress={() => onViewOnChart(sig.time)}>
            <Text style={det.chartBtnTxt}>View on Chart  →</Text>
          </Pressable>

        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function SignalsTab() {
  const { timeframe, setTimeframe, apiBaseUrl, strategies, toggleStrategy, zones, setZones, exitStrategy } = useApp();
  const [segment, setSegment]       = useState<Segment>('chart');
  const [chartSignals, setChartSignals] = useState<MobileSignal[]>([]);
  const [dirFilter,  setDirFilter]  = useState<DirFilter>('all');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [selectedDate, setSelectedDate] = useState<string | null>(() => toDateKey(Math.floor(Date.now() / 1000)));
  const [calVisible,   setCalVisible]   = useState(false);
  const [importingZones, setImportingZones] = useState(false);
  const [selectedSig,  setSelectedSig]  = useState<MobileSignal | null>(null);
  const [scrollToTime, setScrollToTime] = useState<number | null>(null);
  const [rthOnly,      setRthOnly]      = useState(false);
  const priceRangeRef = useRef<{ high: number; low: number } | null>(null);

  // ── Chart signals callback ─────────────────────────────────────────────────
  const onChartSignals = useCallback((sigs: MobileSignal[]) => {
    setChartSignals([...sigs].sort((a, b) => b.time - a.time));
  }, []);

  // ── Filtered & stats ───────────────────────────────────────────────────────
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
    const wins = decided.filter(s => s.outcome === 'Win').length;
    const pnl  = decided.reduce((sum, s) => sum + (s.points ?? 0), 0);
    return {
      total:  filtered.length,
      wins,
      losses: decided.length - wins,
      open:   filtered.length - decided.length,
      wr:     decided.length ? Math.round(wins / decided.length * 100) : null,
      pnl,
    };
  }, [filtered]);

  // ── Zone import ────────────────────────────────────────────────────────────
  async function importZones() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to import zones.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.9, base64: true, allowsEditing: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    if (!asset.base64) { Alert.alert('Error', 'Could not read image data.'); return; }

    setImportingZones(true);
    try {
      const resp = await fetch(`${apiBaseUrl}/api/zones/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename:   asset.fileName ?? 'screenshot.png',
          data:       asset.base64,
          mediaType:  asset.mimeType ?? 'image/png',
          visibleHigh: priceRangeRef.current?.high,
          visibleLow:  priceRangeRef.current?.low,
        }),
      });
      const data = await resp.json();
      if (data.zones?.length) {
        setZones(data.zones);
        Alert.alert('Zones loaded', `Found ${data.zones.length} zone${data.zones.length !== 1 ? 's' : ''}.`);
      } else {
        Alert.alert('No zones found', 'Could not detect zones in this image.');
      }
    } catch (e) {
      Alert.alert('Import failed', String(e));
    } finally {
      setImportingZones(false);
    }
  }

  const showZoneBanner = strategies.milkZones && zones.length === 0;
  const showZoneBadge  = strategies.milkZones && zones.length > 0;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Timeframe selector */}
      <View style={s.tfBar}>
        {TIMEFRAMES.map(tf => (
          <Pressable key={tf} onPress={() => setTimeframe(tf)}
            style={[s.tfBtn, timeframe === tf && s.tfBtnActive]}>
            <Text style={[s.tfLabel, timeframe === tf && s.tfLabelActive]}>{tf}</Text>
          </Pressable>
        ))}
      </View>

      {/* Strategy toggles */}
      <View style={s.stratBar}>
        <StrategyToggle label="Milk Zones" color={Trading.milkZones} active={strategies.milkZones} onPress={() => toggleStrategy('milkZones')} />
        <StrategyToggle label="Vector"     color={Trading.vector}    active={strategies.vector}    onPress={() => toggleStrategy('vector')} />
        <StrategyToggle label="Footprint"  color={Trading.footprint}  active={strategies.footprint}  onPress={() => toggleStrategy('footprint')} />
      </View>

      {/* Milk Zones banner / badge */}
      {showZoneBanner && (
        <Pressable style={[s.zoneBanner, importingZones && { opacity: 0.7 }]}
          onPress={importZones} disabled={importingZones}>
          {importingZones
            ? <><ActivityIndicator color={Trading.milkZones} size="small" /><Text style={[s.zoneBannerText, { color: Trading.milkZones }]}>Reading zones with AI…</Text></>
            : <><View style={[s.zoneDot, { backgroundColor: Trading.milkZones }]} /><Text style={[s.zoneBannerText, { color: Trading.milkZones }]}>Tap to import Milk Zones screenshot</Text></>}
        </Pressable>
      )}
      {showZoneBadge && (
        <View style={s.zoneBadge}>
          <View style={[s.zoneDot, { backgroundColor: Trading.milkZones }]} />
          <Text style={[s.zoneBadgeText, { color: Trading.milkZones }]}>{zones.length} zone{zones.length !== 1 ? 's' : ''} loaded</Text>
          <Pressable onPress={() => setZones([])} style={s.zoneBtn}><Text style={s.zoneBtnText}>Clear</Text></Pressable>
          <Pressable onPress={importZones} disabled={importingZones} style={s.zoneBtn}>
            <Text style={[s.zoneBtnText, { color: Trading.accent }]}>{importingZones ? '…' : 'Re-import'}</Text>
          </Pressable>
        </View>
      )}

      {/* Segmented control */}
      <View style={s.segRow}>
        <Pressable style={[s.segBtn, segment === 'chart'   && s.segBtnActive]} onPress={() => { setSegment('chart'); setScrollToTime(null); }}>
          <Text style={[s.segLabel, segment === 'chart'   && s.segLabelActive]}>Chart</Text>
        </Pressable>
        <Pressable style={[s.segBtn, segment === 'signals' && s.segBtnActive]} onPress={() => setSegment('signals')}>
          <Text style={[s.segLabel, segment === 'signals' && s.segLabelActive]}>Signals</Text>
        </Pressable>
      </View>

      {/* ── Content area: chart + signals stacked in a flex:1 wrapper ────────── */}
      {/* Both live inside one flex:1 container so absoluteFillObject stays inside the header */}
      <View style={{ flex: 1 }}>
        {/* Chart — always mounted, always rendered (WebView needs to be visible to init on iOS) */}
        <View style={[StyleSheet.absoluteFillObject,
                      { opacity: segment === 'chart' ? 1 : 0 }]}
              pointerEvents={segment === 'chart' ? 'auto' : 'none'}>
          <ChartView
            onPriceRange={(high, low) => { priceRangeRef.current = { high, low }; }}
            onSignals={onChartSignals}
            scrollToTime={scrollToTime}
          />
        </View>

      {/* ── Signals tab — mirrors PC SignalsPanel ─────────────────────────────── */}
      {segment === 'signals' && <View style={[StyleSheet.absoluteFillObject, s.sigPanel]}>

        {/* Stats bar */}
        <View style={s.statsBar}>
          <View style={s.statsGroup}>
            <Text style={[s.statsBig, { color: stats.wr !== null ? (stats.wr >= 50 ? C.up : C.down) : C.muted }]}>
              {stats.wr !== null ? `${stats.wr}%` : '—%'}
            </Text>
            <Text style={s.statsLabel}>win rate</Text>
          </View>
          <View style={s.statsDivider} />
          <View style={s.statsGroup}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Text style={s.statsText}><Text style={{ color: C.up, fontWeight: '700' }}>{stats.wins}</Text><Text style={{ color: C.muted }}> W</Text></Text>
              <Text style={s.statsText}><Text style={{ color: C.down, fontWeight: '700' }}>{stats.losses}</Text><Text style={{ color: C.muted }}> L</Text></Text>
              <Text style={[s.statsText, { color: C.muted }]}>{stats.open} open</Text>
            </View>
          </View>
          <View style={s.statsDivider} />
          <Text style={[s.statsText, { color: stats.pnl >= 0 ? C.up : C.down, fontWeight: '700' }]}>
            {stats.pnl >= 0 ? '+' : ''}{stats.pnl.toFixed(2)} pts
          </Text>
          <Text style={[s.statsLabel, { marginLeft: 2 }]}>{stats.total} signals</Text>
          {exitStrategy !== 'current' && (() => {
            const prof = EXIT_PROFILES[exitStrategy as keyof typeof EXIT_PROFILES];
            return (
              <View style={[s.exitBadge, { borderColor: prof.color + '55', backgroundColor: prof.color + '18' }]}>
                <Text style={[s.exitBadgeText, { color: prof.color }]}>{prof.label}</Text>
              </View>
            );
          })()}
        </View>

        {/* Filter row 1: Direction + RTH + Date */}
        <View style={s.filterBar}>
          <Text style={s.filterLabel}>Dir</Text>
          {(['all', 'long', 'short'] as DirFilter[]).map(d => (
            <Pressable key={d} onPress={() => setDirFilter(d)}
              style={[s.chip, dirFilter === d && { borderColor: d === 'long' ? C.up + '88' : d === 'short' ? C.down + '88' : C.accent + '88', backgroundColor: d === 'long' ? C.up + '18' : d === 'short' ? C.down + '18' : C.accent + '18' }]}>
              <Text style={[s.chipText, dirFilter === d && { color: d === 'long' ? C.up : d === 'short' ? C.down : C.accent }]}>
                {d === 'all' ? 'All' : d === 'long' ? '▲ Long' : '▼ Short'}
              </Text>
            </Pressable>
          ))}
          <View style={s.chipDivider} />
          <Pressable onPress={() => setRthOnly(v => !v)}
            style={[s.chip, rthOnly && { borderColor: C.accent + '88', backgroundColor: C.accent + '18' }]}>
            <Text style={[s.chipText, rthOnly && { color: C.accent }]}>RTH</Text>
          </Pressable>
          <View style={s.chipDivider} />
          <Pressable onPress={() => setCalVisible(true)}
            style={[s.chip, selectedDate !== null && { borderColor: '#a78bfa88', backgroundColor: '#a78bfa18' }]}>
            <Text style={[s.chipText, selectedDate !== null && { color: '#a78bfa' }]}>
              {selectedDate
                ? (selectedDate === toDateKey(Math.floor(Date.now() / 1000))
                    ? 'Today'
                    : 'From ' + new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
                : '📅 Date'}
            </Text>
          </Pressable>
          {selectedDate !== null && (
            <Pressable onPress={() => setSelectedDate(null)} style={s.chip}>
              <Text style={[s.chipText, { color: C.muted }]}>✕</Text>
            </Pressable>
          )}
        </View>

        {/* Filter row 2: Risk level */}
        <View style={s.filterBar}>
          <Text style={s.filterLabel}>Risk</Text>
          {(['all', 'safeplus', 'safe', 'risky', 'riskiest'] as RiskFilter[]).map(r => {
            const col = r === 'all' ? C.accent : rlColor(r);
            return (
              <Pressable key={r} onPress={() => setRiskFilter(r)}
                style={[s.chip, riskFilter === r && { borderColor: col + '88', backgroundColor: col + '18' }]}>
                <Text style={[s.chipText, riskFilter === r && { color: col }]}>
                  {r === 'all' ? 'All' : r === 'safeplus' ? 'Safe+' : r === 'safe' ? 'Safe' : r === 'risky' ? 'Risky' : 'Riskiest'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Calendar modal */}
        <CalendarModal
          visible={calVisible}
          selectedDate={selectedDate}
          signalDates={signalDates}
          onSelect={setSelectedDate}
          onClose={() => setCalVisible(false)}
        />

        {/* Signal detail bottom sheet */}
        {selectedSig && (
          <SignalDetailModal
            sig={selectedSig}
            onClose={() => setSelectedSig(null)}
            onViewOnChart={(time) => {
              setSelectedSig(null);
              setScrollToTime(time);
              setSegment('chart');
            }}
          />
        )}

        {/* Table header */}
        <View style={s.tableHeader}>
          <Text style={[s.thCell, { flex: 2.2 }]}>DATE</Text>
          <Text style={[s.thCell, { flex: 2 }]}>TIME</Text>
          <Text style={[s.thCell, { flex: 1.2 }]}>DIR</Text>
          <Text style={[s.thCell, { flex: 1.5 }]}>RISK</Text>
          <Text style={[s.thCell, { flex: 2.2, textAlign: 'right' }]}>ENTRY</Text>
          <Text style={[s.thCell, { flex: 2.2, textAlign: 'right' }]}>TP1</Text>
          <Text style={[s.thCell, { flex: 2, textAlign: 'right' }]}>SL</Text>
          <Text style={[s.thCell, { flex: 1.4, textAlign: 'center' }]}>W/L</Text>
          <Text style={[s.thCell, { flex: 2.2, textAlign: 'right' }]}>P&L</Text>
        </View>

        {/* Signal rows */}
        {filtered.length === 0 ? (
          <View style={s.empty}>
            {chartSignals.length === 0
              ? <Text style={s.emptyText}>Switch to Chart to load signals</Text>
              : <Text style={s.emptyText}>No signals match filters</Text>}
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {filtered.map((sig, idx) => {
              const isLong = sig.direction === 'Long';
              const dirColor = isLong ? C.up : C.down;
              const rl = rlColor(sig.riskLevel);
              const oc = ocColor(sig.outcome);
              return (
                <Pressable key={`${sig.time}-${sig.direction}`}
                  onPress={() => setSelectedSig(sig)}
                  style={({ pressed }) => [s.row, idx % 2 !== 0 && { backgroundColor: 'rgba(255,255,255,0.012)' },
                    (sig.riskLevel === 'risky' || sig.riskLevel === 'riskiest') && { opacity: 0.8 },
                    pressed && { backgroundColor: C.accent + '0f' }]}>
                  {/* Date */}
                  <Text style={[s.cell, { flex: 2.2, color: C.muted }]}>{fmtDate(sig.time)}</Text>
                  {/* Time */}
                  <Text style={[s.cell, { flex: 2, color: C.accent }]}>{fmtTime(sig.time)}</Text>
                  {/* Direction */}
                  <Text style={[s.cell, { flex: 1.2, color: dirColor, fontWeight: '700' }]}>
                    {isLong ? '▲ L' : '▼ S'}
                  </Text>
                  {/* Risk badge */}
                  <View style={{ flex: 1.5, justifyContent: 'center' }}>
                    <View style={[s.badge, { borderColor: rl + '44', backgroundColor: rl + '18' }]}>
                      <Text style={[s.badgeText, { color: rl }]}>{sig.riskLevel}</Text>
                    </View>
                  </View>
                  {/* Entry */}
                  <Text style={[s.cell, { flex: 2.2, textAlign: 'right', color: C.text }]}>{sig.price.toFixed(2)}</Text>
                  {/* TP1 */}
                  <Text style={[s.cell, { flex: 2.2, textAlign: 'right', color: '#67e8f9' }]}>{sig.tp1.toFixed(2)}</Text>
                  {/* SL */}
                  <Text style={[s.cell, { flex: 2, textAlign: 'right', color: '#f87171' }]}>{sig.sl.toFixed(2)}</Text>
                  {/* W/L badge */}
                  <View style={{ flex: 1.4, alignItems: 'center', justifyContent: 'center' }}>
                    {sig.outcome === 'Open' ? (
                      <Text style={{ fontSize: 10, color: C.muted }}>—</Text>
                    ) : sig.outcome === 'Win' ? (
                      <View style={[s.wlBadge, { backgroundColor: sig.tpHit === 2 ? 'rgba(38,200,122,0.22)' : 'rgba(38,200,122,0.14)', borderColor: sig.tpHit === 2 ? 'rgba(38,200,122,0.6)' : 'rgba(74,222,128,0.4)' }]}>
                        <Text style={[s.wlText, { color: sig.tpHit === 2 ? '#26c87a' : '#4ade80' }]}>W{sig.tpHit}</Text>
                      </View>
                    ) : (
                      <View style={[s.wlBadge, { backgroundColor: 'rgba(239,68,68,0.14)', borderColor: 'rgba(239,68,68,0.4)' }]}>
                        <Text style={[s.wlText, { color: C.down }]}>L</Text>
                      </View>
                    )}
                  </View>
                  {/* P&L */}
                  <Text style={[s.cell, { flex: 2.2, textAlign: 'right', color: oc, fontWeight: '700' }]}>
                    {sig.points !== null ? `${sig.points >= 0 ? '+' : ''}${sig.points.toFixed(2)}` : '—'}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>}
      </View>{/* end content wrapper */}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: C.bg },
  tfBar:   { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, gap: 6, borderBottomWidth: 1, borderBottomColor: C.border },
  stratBar: { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  tfBtn:   { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, borderWidth: 1.5, borderColor: '#222222', backgroundColor: C.panel },
  tfBtnActive: { borderColor: C.accent, backgroundColor: C.accent + '20' },
  tfLabel: { color: C.dim, fontSize: 13, fontWeight: '600' },
  tfLabelActive: { color: C.accent, fontWeight: '700' },

  zoneBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, borderColor: Trading.milkZones + '66', backgroundColor: Trading.milkZones + '11' },
  zoneBannerText: { fontSize: 13, fontWeight: '600' },
  zoneDot:   { width: 8, height: 8, borderRadius: 4 },
  zoneBadge: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: Trading.milkZones + '11', borderWidth: 1, borderColor: Trading.milkZones + '44' },
  zoneBadgeText: { fontSize: 12, fontWeight: '600', flex: 1 },
  zoneBtn:   { paddingHorizontal: 8, paddingVertical: 4 },
  zoneBtnText: { color: C.muted, fontSize: 12, fontWeight: '600' },

  segRow:   { flexDirection: 'row', marginHorizontal: 16, marginVertical: 10, backgroundColor: C.panel, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: C.border },
  segBtn:   { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segBtnActive: { backgroundColor: C.accent },
  segLabel: { color: C.muted, fontSize: 14, fontWeight: '600' },
  segLabelActive: { color: '#fff' },

  sigPanel:  { flex: 1, backgroundColor: C.bg },

  statsBar:  { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel, flexWrap: 'wrap' },
  statsGroup: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  statsBig:  { fontSize: 20, fontWeight: '800', lineHeight: 24 },
  statsLabel: { fontSize: 9, color: C.muted },
  statsText:  { fontSize: 11 },
  statsDivider: { width: 1, height: 20, backgroundColor: C.border },

  exitBadge:     { borderRadius: 4, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  exitBadgeText: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },

  filterBar:   { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel, flexWrap: 'wrap' },
  filterLabel: { fontSize: 9, color: C.dim, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginRight: 2, width: 26 },
  chip:        { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: '#222222', backgroundColor: C.panel },
  chipText:    { fontSize: 10, color: C.muted, fontWeight: '600' },
  chipDivider: { width: 1, height: 14, backgroundColor: C.border, marginHorizontal: 2 },

  tableHeader: { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel },
  thCell:    { fontSize: 8, color: C.dim, fontWeight: '600', letterSpacing: 0.5 },

  row:       { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.border + '55', alignItems: 'center' },
  cell:      { fontSize: 10.5 },

  badge:     { borderRadius: 3, borderWidth: 1, paddingHorizontal: 4, paddingVertical: 1, alignSelf: 'flex-start' },
  badgeText: { fontSize: 8, fontWeight: '700', textTransform: 'uppercase' },
  wlBadge:   { borderRadius: 3, borderWidth: 1, paddingHorizontal: 4, paddingVertical: 1, minWidth: 20, alignItems: 'center' },
  wlText:    { fontSize: 8, fontWeight: '800' },

  empty:     { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  emptyText: { color: C.muted, fontSize: 13 },
});

// ── Calendar stylesheet ────────────────────────────────────────────────────────
const CELL = 40;
const cal = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center' },
  sheet:    { width: 300, borderRadius: 12, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },

  header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  monthLabel: { fontSize: 14, fontWeight: '700', color: C.text },
  navBtn:     { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  navArrow:   { fontSize: 20, color: C.accent, fontWeight: '300' },

  dowRow:     { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6 },
  dowLabel:   { width: CELL, textAlign: 'center', fontSize: 10, color: C.muted, fontWeight: '600' },

  grid:       { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingBottom: 8 },
  dayCell:    { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center' },
  daySel:     { backgroundColor: C.accent, borderRadius: CELL / 2 },
  dayToday:   { borderWidth: 1, borderColor: C.accent + '66', borderRadius: CELL / 2 },
  dayText:    { fontSize: 13, color: C.text },
  dayTextSel: { color: '#fff', fontWeight: '700' },
  dot:        { position: 'absolute', bottom: 5, width: 4, height: 4, borderRadius: 2, backgroundColor: C.accent },

  footer:     { borderTopWidth: 1, borderTopColor: C.border, padding: 10, flexDirection: 'row', justifyContent: 'center', gap: 12 },
  clearBtn:   { paddingVertical: 6, paddingHorizontal: 16, borderWidth: 1, borderColor: C.border, borderRadius: 8 },
  clearText:  { fontSize: 12, color: C.accent, fontWeight: '600' },
});

// ── Signal detail bottom-sheet stylesheet ──────────────────────────────────────
const det = StyleSheet.create({
  backdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  sheet:       { backgroundColor: C.panel, borderTopLeftRadius: 18, borderTopRightRadius: 18,
                 borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, borderColor: C.border,
                 paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 },
  header:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  dir:         { fontSize: 20, fontWeight: '800' },
  badge:       { borderRadius: 4, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText:   { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  closeBtn:    { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  closeTxt:    { color: C.muted, fontSize: 18 },
  subtitle:    { fontSize: 12, color: C.muted, marginTop: 2, marginBottom: 16 },
  table:       { borderRadius: 8, borderWidth: 1, borderColor: C.border, overflow: 'hidden', marginBottom: 14, backgroundColor: '#070b11' },
  tRow:        { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 11, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: C.border + '55' },
  tLabel:      { fontSize: 12, color: C.muted, fontWeight: '600' },
  tValue:      { fontSize: 13, fontWeight: '700' },
  rr:          { fontSize: 11, color: C.muted, textAlign: 'center', marginBottom: 14 },
  stratRow:    { marginBottom: 14 },
  stratLabel:  { fontSize: 10, color: C.muted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  stratChips:  { flexDirection: 'row', gap: 6 },
  stratChip:   { borderRadius: 6, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 5 },
  stratChipTxt:{ fontSize: 11, fontWeight: '600' },
  outcomeRow:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingVertical: 4 },
  outcomeText: { fontSize: 15, fontWeight: '700' },
  pnlText:     { fontSize: 24, fontWeight: '800' },
  chartBtn:    { backgroundColor: C.accent + '22', borderWidth: 1, borderColor: C.accent + '66', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  chartBtnTxt: { color: C.accent, fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },
});
