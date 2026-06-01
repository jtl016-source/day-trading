import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet,
  Alert, ActivityIndicator, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp, EXIT_PROFILES, type ExitStrategy } from '@/context/app-context';
import { Trading, Fonts } from '@/constants/theme';
import { SyncChip } from '@/components/sync-chip';

const AT_KEY = 'autoTraderSettings_v1';
const HOLD_MS = 2000; // ms to hold before arm/disarm confirms

type ContractType = 'MES' | 'ES';
type Direction    = 'both' | 'long' | 'short';
type RiskLevel    = 'safe' | 'risky' | 'riskiest';
type Interval     = '1m' | '5m' | '15m' | '60m';

// ── Arm state: OFF | ARMED | LIVE ─────────────────────────────────────────────
// OFF   = enabled=false (or disconnected)
// ARMED = enabled=true + connected (ready but no active trade)
// LIVE  = enabled=true + connected + active trade open
type ArmState = 'OFF' | 'ARMED' | 'LIVE';

function getArmState(enabled: boolean, connected: boolean, hasActiveTrade: boolean): ArmState {
  if (!enabled) return 'OFF';
  if (!connected) return 'OFF'; // treat disconnected+enabled as OFF visually
  return hasActiveTrade ? 'LIVE' : 'ARMED';
}

export default function AutoTraderScreen() {
  const { apiBaseUrl, exitStrategy, setExitStrategy } = useApp();

  // ── Connection + trade state ────────────────────────────────────────────────
  const [connected,      setConnected]      = useState(false);
  const [hasActiveTrade, setHasActiveTrade] = useState(false);

  // ── Auto-trader settings ────────────────────────────────────────────────────
  const [enabled,       setEnabled]       = useState(false);
  const [contractType,  setContractType]  = useState<ContractType>('MES');
  const [contracts,     setContracts]     = useState(1);
  const [tp1Only,       setTp1Only]       = useState(false);
  const [direction,     setDirection]     = useState<Direction>('both');
  const [riskLevels,    setRiskLevels]    = useState<Set<RiskLevel>>(new Set(['safe']));
  const [intervals,     setIntervals]     = useState<Set<Interval>>(new Set(['5m']));
  const [resetLoading,  setResetLoading]  = useState(false);

  // ── Hold-to-arm state ───────────────────────────────────────────────────────
  const [isSyncing, setIsSyncing] = useState(false);   // waiting for server confirmation
  const holdProgress = useRef(new Animated.Value(0)).current;
  const holdAnimRef  = useRef<Animated.CompositeAnimation | null>(null);

  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const settingsLoaded = useRef(false);

  const armState = getArmState(enabled, connected, hasActiveTrade);

  // ── Persist + sync to server on settings change ─────────────────────────────
  useEffect(() => {
    if (!settingsLoaded.current) return;
    const payload = {
      enabled, contractType, contracts, tp1Only, direction,
      riskLevels: [...riskLevels], intervals: [...intervals], exitStrategy,
    };
    AsyncStorage.setItem(AT_KEY, JSON.stringify(payload)).catch(() => {});
    fetch(`${apiBaseUrl}/api/trade/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }, [enabled, contractType, contracts, tp1Only, direction, riskLevels, intervals, exitStrategy, apiBaseUrl]);

  // ── Load persisted settings on mount ────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(AT_KEY).then(raw => {
      if (raw) {
        try {
          const s = JSON.parse(raw);
          if (typeof s.enabled === 'boolean') setEnabled(s.enabled);
          if (s.contractType === 'MES' || s.contractType === 'ES') setContractType(s.contractType);
          if (typeof s.contracts === 'number') setContracts(s.contracts);
          if (typeof s.tp1Only === 'boolean') setTp1Only(s.tp1Only);
          if (s.direction === 'both' || s.direction === 'long' || s.direction === 'short') setDirection(s.direction);
          if (Array.isArray(s.riskLevels)) setRiskLevels(new Set(s.riskLevels as RiskLevel[]));
          if (Array.isArray(s.intervals)) setIntervals(new Set(s.intervals as Interval[]));
        } catch {}
      }
    }).finally(() => { settingsLoaded.current = true; });
  }, []);

  // ── Poll connection + trade status every 5 s ─────────────────────────────
  const pollStatus = useCallback(async () => {
    try {
      const r = await fetch(`${apiBaseUrl}/api/trade/status`);
      if (!r.ok) throw new Error('');
      const d = await r.json();
      setConnected(!!d.connected);
    } catch { setConnected(false); }

    try {
      const r2 = await fetch(`${apiBaseUrl}/api/trade/current`);
      if (r2.ok) {
        const d2 = await r2.json();
        setHasActiveTrade(!!(d2.trade && d2.trade.status === 'open'));
      }
    } catch {}
  }, [apiBaseUrl]);

  useEffect(() => {
    pollStatus();
    pollRef.current = setInterval(pollStatus, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollStatus]);

  // ── Hold-to-arm / disarm ────────────────────────────────────────────────────
  function startHold() {
    if (isSyncing || !connected) return;
    holdAnimRef.current = Animated.timing(holdProgress, {
      toValue: 1, duration: HOLD_MS, useNativeDriver: false,
    });
    holdAnimRef.current.start(({ finished }) => {
      holdProgress.setValue(0);
      if (finished) {
        // Toggle confirmed — sync to server
        setIsSyncing(true);
        const next = !enabled;
        fetch(`${apiBaseUrl}/api/trade/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        })
          .then(() => setEnabled(next))
          .catch(() => {})
          .finally(() => setIsSyncing(false));
      }
    });
  }

  function cancelHold() {
    holdAnimRef.current?.stop();
    Animated.timing(holdProgress, {
      toValue: 0, duration: 150, useNativeDriver: false,
    }).start();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const resetLock = useCallback(async () => {
    setResetLoading(true);
    try {
      const r = await fetch(`${apiBaseUrl}/api/trade/reset-flag`, { method: 'POST' });
      const d = await r.json();
      Alert.alert(
        d.ok ? 'Lock Reset' : 'Not Connected',
        d.ok ? 'Trade lock cleared — ready for new orders.'
             : 'AutoTrader not connected. Lock will clear on next connect.',
      );
    } catch (e) {
      Alert.alert('Error', String(e));
    } finally { setResetLoading(false); }
  }, [apiBaseUrl]);

  const toggleRiskLevel = (level: RiskLevel) => setRiskLevels(prev => {
    const n = new Set(prev); n.has(level) ? n.delete(level) : n.add(level); return n;
  });
  const toggleInterval = (iv: Interval) => setIntervals(prev => {
    const n = new Set(prev); n.has(iv) ? n.delete(iv) : n.add(iv); return n;
  });

  // ── Arm state display ────────────────────────────────────────────────────────
  const armColor  = armState === 'LIVE' ? Trading.armLive : armState === 'ARMED' ? Trading.armArmed : Trading.armOff;
  const holdLabel = enabled ? 'HOLD TO DISARM' : 'HOLD TO ARM';
  const holdBg    = holdProgress.interpolate({ inputRange: [0, 1], outputRange: ['#00000000', armColor + 'cc'] });

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* ── App bar ─────────────────────────────────────────────────────── */}
        <View style={s.appBar}>
          <Text style={s.appBarTitle}>AUTO TRADER</Text>
          <SyncChip connected={connected} feedName="MW" />
        </View>

        {/* ── Master arm banner ───────────────────────────────────────────── */}
        <View style={[s.armBanner, { borderColor: armColor + '60', backgroundColor: armColor + '12' }]}>
          {/* State row */}
          <View style={s.armStateRow}>
            {armState === 'LIVE' && <ArmPulse color={armColor} />}
            <Text style={[s.armStateLabel, { color: armColor }]}>
              {armState === 'LIVE'  ? 'LIVE'  :
               armState === 'ARMED' ? 'ARMED' : 'DISARMED'}
            </Text>
            {armState !== 'OFF' && (
              <Text style={s.armSubLabel}>
                {armState === 'LIVE'  ? 'Trade open · monitoring' :
                 armState === 'ARMED' ? `${contractType} · ${contracts} contract${contracts > 1 ? 's' : ''}` : ''}
              </Text>
            )}
          </View>

          {/* Sync line */}
          {armState !== 'OFF' && (
            <Text style={[s.armSyncLine, { color: armColor + 'cc' }]}>
              ⇄ Mirrored with PC Engine · {connected ? 'in sync' : 'reconnecting…'}
            </Text>
          )}

          {!connected && enabled && (
            <View style={s.staleBanner}>
              <Text style={s.staleText}>NOT SYNCED — DISPLAYED STATE MAY BE STALE</Text>
            </View>
          )}

          {/* Hold-to-arm button */}
          <View style={s.holdOuter}>
            <Animated.View style={[StyleSheet.absoluteFillObject, { backgroundColor: holdBg, borderRadius: 10 }]} />
            <Pressable
              style={s.holdBtn}
              onPressIn={startHold}
              onPressOut={cancelHold}
              disabled={isSyncing || !connected}
            >
              {isSyncing ? (
                <ActivityIndicator color={armColor} size="small" />
              ) : (
                <Text style={[s.holdBtnText, { color: connected ? armColor : Trading.muted }]}>
                  {!connected ? 'CONNECT MW TO ARM' : holdLabel}
                </Text>
              )}
            </Pressable>
          </View>

          <Text style={s.holdHint}>Hold 2 seconds to confirm — prevents accidental triggers</Text>
        </View>

        {/* ── Settings sections ────────────────────────────────────────────── */}
        <Section label="CONTRACT">
          <View style={s.chipRow}>
            {(['MES', 'ES'] as ContractType[]).map(t => (
              <Pressable key={t} onPress={() => setContractType(t)} style={[s.chip, contractType === t && { borderColor: Trading.accent, backgroundColor: Trading.accent + '18' }]}>
                <Text style={[s.chipText, contractType === t && { color: Trading.accent }]}>
                  {t === 'MES' ? 'MES  Micro · $5/pt' : 'ES  Full · $50/pt'}
                </Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section label="CONTRACTS PER TRADE">
          <View style={s.stepperRow}>
            <Pressable onPress={() => setContracts(c => Math.max(1, c - 1))} style={s.stepBtn} hitSlop={8}>
              <Text style={s.stepBtnText}>−</Text>
            </Pressable>
            <Text style={[s.stepValue, { fontFamily: Fonts?.mono }]}>{contracts}</Text>
            <Pressable onPress={() => setContracts(c => Math.min(10, c + 1))} style={s.stepBtn} hitSlop={8}>
              <Text style={s.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </Section>

        <Section label="EXIT MODE">
          <View style={s.chipRow}>
            {([false, true] as const).map(tp1 => (
              <Pressable key={String(tp1)} onPress={() => setTp1Only(tp1)} style={[s.chip, tp1Only === tp1 && { borderColor: Trading.accent, backgroundColor: Trading.accent + '18' }]}>
                <Text style={[s.chipText, tp1Only === tp1 && { color: Trading.accent }]}>
                  {tp1 ? 'TP1 Only' : 'TP1 + TP2'}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.hint}>{tp1Only ? 'All contracts exit at TP1' : 'Half at TP1 · runners trail to TP2'}</Text>
        </Section>

        <Section label="EXIT STRATEGY">
          {(Object.entries(EXIT_PROFILES) as [Exclude<ExitStrategy,'current'>, typeof EXIT_PROFILES[keyof typeof EXIT_PROFILES]][]).map(([key, prof]) => {
            const active = exitStrategy === key;
            const tiers = prof.rth;
            return (
              <Pressable key={key} onPress={() => setExitStrategy(key)}
                style={[s.stratRow, active && { borderColor: prof.color + '80', backgroundColor: prof.color + '0e' }]}>
                <View style={s.stratLeft}>
                  <View style={[s.stratDot, { backgroundColor: active ? prof.color : Trading.border }]} />
                  <View>
                    <Text style={[s.stratLabel, active && { color: prof.color }]}>{prof.label}</Text>
                    <Text style={s.stratDesc}>{prof.desc}</Text>
                  </View>
                </View>
                <View style={s.stratLevels}>
                  <Text style={[s.stratNum, { fontFamily: Fonts?.mono, color: active ? Trading.safeplus : Trading.muted }]}>
                    TP {tiers.safe.tp1} / {tiers.safe.tp2}
                  </Text>
                  <Text style={[s.stratNum, { fontFamily: Fonts?.mono, color: active ? Trading.riskiest : Trading.dim }]}>
                    SL {tiers.safe.sl}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </Section>

        <Section label="DIRECTION">
          <View style={s.chipRow}>
            {(['both', 'long', 'short'] as Direction[]).map(d => (
              <Pressable key={d} onPress={() => setDirection(d)}
                style={[s.chip, direction === d && { borderColor: d === 'long' ? Trading.long : d === 'short' ? Trading.short : Trading.accent, backgroundColor: (d === 'long' ? Trading.long : d === 'short' ? Trading.short : Trading.accent) + '18' }]}>
                <Text style={[s.chipText, direction === d && { color: d === 'long' ? Trading.long : d === 'short' ? Trading.short : Trading.accent }]}>
                  {d === 'both' ? 'Both' : d === 'long' ? '▲ Long' : '▼ Short'}
                </Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section label="RISK TIERS">
          {([['safe', Trading.safe], ['risky', Trading.risky], ['riskiest', Trading.riskiest]] as [RiskLevel, string][]).map(([level, color]) => {
            const active = riskLevels.has(level);
            return (
              <Pressable key={level} onPress={() => toggleRiskLevel(level)}
                style={[s.checkRow, active && { backgroundColor: color + '12' }]}>
                <View style={[s.checkBox, { borderColor: active ? color : Trading.border }, active && { backgroundColor: color }]}>
                  {active && <Text style={s.checkMark}>✓</Text>}
                </View>
                <Text style={[s.checkLabel, { color: active ? color : Trading.textSecondary }]}>
                  {level.toUpperCase()}
                </Text>
              </Pressable>
            );
          })}
          <Text style={s.hint}>SAFE+ always trades when enabled</Text>
        </Section>

        <Section label="INTERVALS">
          <View style={s.chipRow}>
            {(['1m', '5m', '15m', '60m'] as Interval[]).map(iv => {
              const active = intervals.has(iv);
              return (
                <Pressable key={iv} onPress={() => toggleInterval(iv)}
                  style={[s.chip, active && { borderColor: Trading.accent, backgroundColor: Trading.accent + '18' }]}>
                  <Text style={[s.chipText, active && { color: Trading.accent }]}>{iv}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        {/* Reset lock */}
        <View style={s.resetSection}>
          <Text style={s.resetTitle}>STUCK ORDERS</Text>
          <Text style={s.resetDesc}>If MotiveWave shows an open position but no order exists, tap to unstick the lock.</Text>
          <Pressable onPress={resetLock} disabled={resetLoading} style={s.resetBtn}>
            {resetLoading
              ? <ActivityIndicator color={Trading.risky} size="small" />
              : <Text style={s.resetBtnText}>Reset Trade Lock</Text>}
          </Pressable>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>{label}</Text>
      <View style={s.sectionBody}>{children}</View>
    </View>
  );
}

function ArmPulse({ color }: { color: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(scale, { toValue: 1.4, duration: 700, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1,   duration: 700, useNativeDriver: true }),
    ]));
    anim.start();
    return () => anim.stop();
  }, [scale]);
  return (
    <Animated.View style={[s.armPulse, { backgroundColor: color, shadowColor: color, transform: [{ scale }] }]} />
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Trading.bg },
  scroll: { paddingBottom: 48 },

  appBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: Trading.border,
  },
  appBarTitle: { color: Trading.text, fontSize: 13, fontWeight: '800', letterSpacing: 2 },

  // ── Master arm banner ────────────────────────────────────────────────────────
  armBanner: {
    margin: 14, borderRadius: 12, borderWidth: 1,
    padding: 18, gap: 12,
  },
  armStateRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  armStateLabel: { fontSize: 22, fontWeight: '900', letterSpacing: 2 },
  armSubLabel:   { color: Trading.textSecondary, fontSize: 12, marginLeft: 4 },
  armSyncLine:   { fontSize: 11, letterSpacing: 0.3, marginTop: -4 },

  armPulse: {
    width: 10, height: 10, borderRadius: 5,
    shadowOffset: { width: 0, height: 0 }, shadowRadius: 6, shadowOpacity: 0.9, elevation: 4,
  },

  staleBanner: {
    backgroundColor: Trading.riskiest + '22',
    borderRadius: 6, padding: 8,
    borderWidth: 1, borderColor: Trading.riskiest + '60',
  },
  staleText: { color: Trading.riskiest, fontSize: 11, fontWeight: '700', textAlign: 'center', letterSpacing: 0.5 },

  holdOuter: {
    borderRadius: 10, overflow: 'hidden',
    borderWidth: 1, borderColor: Trading.border,
    minHeight: 52,
  },
  holdBtn: {
    minHeight: 52, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 24,
  },
  holdBtnText: { fontSize: 14, fontWeight: '800', letterSpacing: 2 },
  holdHint:    { color: Trading.muted, fontSize: 10, textAlign: 'center', letterSpacing: 0.2 },

  // ── Sections ─────────────────────────────────────────────────────────────────
  section: { marginHorizontal: 14, marginTop: 14 },
  sectionLabel: {
    color: Trading.muted, fontSize: 10, fontWeight: '700',
    letterSpacing: 2, marginBottom: 8,
  },
  sectionBody: {
    backgroundColor: Trading.surface, borderRadius: 10,
    borderWidth: 1, borderColor: Trading.border,
    overflow: 'hidden',
  },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8,
    borderWidth: 1, borderColor: Trading.border,
  },
  chipText: { color: Trading.textSecondary, fontSize: 13, fontWeight: '600' },

  hint: { color: Trading.muted, fontSize: 11, paddingHorizontal: 12, paddingBottom: 12 },

  stepperRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 24, padding: 14,
  },
  stepBtn: {
    width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Trading.surfaceAlt, borderWidth: 1, borderColor: Trading.border,
  },
  stepBtnText: { color: Trading.text, fontSize: 22, fontWeight: '300' },
  stepValue:   { color: Trading.text, fontSize: 26, fontWeight: '700', minWidth: 48, textAlign: 'center' },

  // Exit strategy rows
  stratRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 14, borderWidth: 1.5, borderColor: 'transparent',
    borderBottomWidth: 1, borderBottomColor: Trading.border,
  },
  stratLeft:   { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  stratDot:    { width: 9, height: 9, borderRadius: 5 },
  stratLabel:  { color: Trading.text, fontSize: 14, fontWeight: '700' },
  stratDesc:   { color: Trading.muted, fontSize: 11, marginTop: 2 },
  stratLevels: { alignItems: 'flex-end', gap: 2 },
  stratNum:    { fontSize: 11 },

  // Risk level checks
  checkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14,
    borderBottomWidth: 1, borderBottomColor: Trading.border,
  },
  checkBox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  checkMark:  { color: Trading.bg, fontSize: 13, fontWeight: '900' },
  checkLabel: { fontSize: 14, fontWeight: '700' },

  // Reset section
  resetSection: {
    margin: 14, backgroundColor: Trading.surface,
    borderRadius: 10, borderWidth: 1, borderColor: Trading.border,
    padding: 16, gap: 8,
  },
  resetTitle: { color: Trading.muted, fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  resetDesc:  { color: Trading.textSecondary, fontSize: 12, lineHeight: 18 },
  resetBtn: {
    height: 44, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Trading.risky + '18', borderRadius: 8,
    borderWidth: 1, borderColor: Trading.risky + '60',
  },
  resetBtnText: { color: Trading.risky, fontSize: 13, fontWeight: '700' },
});
