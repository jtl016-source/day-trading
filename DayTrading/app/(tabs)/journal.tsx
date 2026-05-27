import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, Switch, Pressable, ScrollView,
  StyleSheet, Alert, ActivityIndicator, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp, EXIT_PROFILES, type ExitStrategy } from '@/context/app-context';
import { Trading } from '@/constants/theme';

const AT_KEY = 'autoTraderSettings_v1';

type ContractType = 'MES' | 'ES';
type Direction = 'both' | 'long' | 'short';
type RiskLevel = 'safe' | 'risky' | 'riskiest';
type Interval = '1m' | '5m' | '15m' | '60m';

export default function AutoTraderScreen() {
  const { apiBaseUrl, exitStrategy, setExitStrategy } = useApp();
  const [connected, setConnected] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [contractType, setContractType] = useState<ContractType>('MES');
  const [contracts, setContracts] = useState(1);
  const [tp1Only, setTp1Only] = useState(false);
  const [direction, setDirection] = useState<Direction>('both');
  const [riskLevels, setRiskLevels] = useState<Set<RiskLevel>>(new Set(['safe']));
  const [intervals, setIntervals] = useState<Set<Interval>>(new Set(['5m']));
  const [resetLoading, setResetLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const settingsLoaded = useRef(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation for connected status dot
  useEffect(() => {
    if (connected) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.6, duration: 900, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [connected, pulseAnim]);

  // Load persisted autotrade settings on mount
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

  // Persist + sync to server whenever settings change
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

  const pollStatus = useCallback(async () => {
    try {
      const r = await fetch(`${apiBaseUrl}/api/trade/status`);
      if (!r.ok) throw new Error('');
      const d = await r.json();
      setConnected(!!d.connected);
    } catch {
      setConnected(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    pollStatus();
    pollRef.current = setInterval(pollStatus, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollStatus]);

  const resetLock = useCallback(async () => {
    setResetLoading(true);
    try {
      const r = await fetch(`${apiBaseUrl}/api/trade/reset-flag`, { method: 'POST' });
      const d = await r.json();
      Alert.alert(
        d.ok ? 'Lock Reset' : 'Not Connected',
        d.ok
          ? 'Trade lock cleared — ready for new orders.'
          : 'AutoTrader not connected. Lock will clear on next connect.',
      );
    } catch (e) {
      Alert.alert('Error', String(e));
    } finally {
      setResetLoading(false);
    }
  }, [apiBaseUrl]);

  const toggleRiskLevel = (level: RiskLevel) => {
    setRiskLevels(prev => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level); else next.add(level);
      return next;
    });
  };

  const toggleInterval = (iv: Interval) => {
    setIntervals(prev => {
      const next = new Set(prev);
      if (next.has(iv)) next.delete(iv); else next.add(iv);
      return next;
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.headerBar}>
          <Text style={styles.title}>AutoTrader</Text>
          <View style={styles.statusRow}>
            <Animated.View style={[
              styles.statusDot,
              { backgroundColor: connected ? Trading.green : Trading.red },
              connected && { transform: [{ scale: pulseAnim }] },
              connected && { shadowColor: Trading.green, shadowRadius: 6, shadowOpacity: 0.8, shadowOffset: { width: 0, height: 0 } },
            ]} />
            <Text style={[styles.statusText, { color: connected ? Trading.green : Trading.muted }]}>
              {connected ? 'Connected to MotiveWave' : 'Not connected'}
            </Text>
          </View>
        </View>

        {!connected && (
          <View style={styles.notConnectedBanner}>
            <Text style={styles.notConnectedText}>
              ⚡ Add the AutoTrader study to a chart in MotiveWave to connect.
            </Text>
          </View>
        )}

        {/* Master toggle */}
        <Section label="Auto Trade">
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={[styles.rowLabel, enabled && { color: Trading.red, fontWeight: '700' }]}>
                {enabled ? 'LIVE ORDERS ENABLED' : 'Auto trade off'}
              </Text>
              {enabled && (
                <Text style={styles.rowSub}>Real orders will be placed via MotiveWave</Text>
              )}
            </View>
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              trackColor={{ false: Trading.border, true: Trading.red + '88' }}
              thumbColor={enabled ? Trading.red : Trading.muted}
            />
          </View>
          {enabled && (
            <View style={styles.warningBanner}>
              <Text style={styles.warningText}>
                Real orders will be placed when signals fire. Use sim mode in MotiveWave until ready to trade live.
              </Text>
            </View>
          )}
        </Section>

        {/* Contract type */}
        <Section label="Contract Type">
          <View style={styles.chipRow}>
            {(['MES', 'ES'] as ContractType[]).map(t => (
              <Pressable
                key={t}
                onPress={() => setContractType(t)}
                style={[styles.chip, contractType === t && styles.chipActive]}
              >
                <Text style={[styles.chipText, contractType === t && styles.chipTextActive]}>
                  {t === 'MES' ? 'MES  ·  Micro' : 'ES  ·  Full'}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.hint}>
            {contractType === 'MES' ? '$5 / point per contract' : '$50 / point per contract'}
          </Text>
        </Section>

        {/* Contracts per trade */}
        <Section label="Contracts per Trade">
          <View style={styles.stepperRow}>
            <Pressable
              onPress={() => setContracts(c => Math.max(1, c - 1))}
              style={styles.stepBtn}
            >
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{contracts}</Text>
            <Pressable
              onPress={() => setContracts(c => Math.min(10, c + 1))}
              style={styles.stepBtn}
            >
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </Section>

        {/* Exit mode */}
        <Section label="Exit Mode">
          <View style={styles.chipRow}>
            {([false, true] as const).map(tp1 => (
              <Pressable
                key={String(tp1)}
                onPress={() => setTp1Only(tp1)}
                style={[styles.chip, tp1Only === tp1 && styles.chipActive]}
              >
                <Text style={[styles.chipText, tp1Only === tp1 && styles.chipTextActive]}>
                  {tp1 ? 'TP1 Only' : 'TP1 + TP2'}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.hint}>
            {tp1Only ? 'All contracts exit at TP1' : 'Half at TP1, rest runners at TP2'}
          </Text>
        </Section>

        {/* Exit strategy */}
        <Section label="Exit Strategy">
          {(Object.entries(EXIT_PROFILES) as [Exclude<ExitStrategy,'current'>, typeof EXIT_PROFILES[keyof typeof EXIT_PROFILES]][]).map(([key, prof]) => {
            const active = exitStrategy === key;
            return (
              <Pressable
                key={key}
                onPress={() => setExitStrategy(key)}
                style={[styles.stratRow, active && { borderColor: prof.color, borderWidth: 2, backgroundColor: prof.color + '0e' }]}
              >
                <View style={styles.rowLeft}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={[styles.stratDot, { backgroundColor: active ? prof.color : Trading.border }]} />
                    <Text style={[styles.rowLabel, { color: active ? prof.color : Trading.text }]}>{prof.label}</Text>
                    <View style={styles.stratLevels}>
                      <Text style={styles.stratLevel}>TP1 {prof.rth.safe.tp1}</Text>
                      <Text style={styles.stratLevel}>TP2 {prof.rth.safe.tp2}</Text>
                      <Text style={styles.stratLevel}>SL {prof.rth.safe.sl}</Text>
                    </View>
                  </View>
                  <Text style={styles.rowSub}>{prof.desc}</Text>
                </View>
              </Pressable>
            );
          })}
          <Text style={styles.hint}>Applies to live orders and signal outcome simulation</Text>
        </Section>

        {/* Direction */}
        <Section label="Direction">
          <View style={styles.chipRow}>
            {(['both', 'long', 'short'] as Direction[]).map(d => {
              const active = direction === d;
              const color = d === 'long' ? Trading.green : d === 'short' ? Trading.red : Trading.accent;
              return (
                <Pressable
                  key={d}
                  onPress={() => setDirection(d)}
                  style={[styles.chip, active && { borderColor: color, backgroundColor: color + '1a' }]}
                >
                  <Text style={[styles.chipText, active && { color }]}>
                    {d === 'both' ? 'Both' : d === 'long' ? '▲ Long' : '▼ Short'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        {/* Risk levels */}
        <Section label="Trade on Risk Levels">
          {(['safe', 'risky', 'riskiest'] as RiskLevel[]).map(level => {
            const color = level === 'safe' ? Trading.green : level === 'risky' ? Trading.orange : Trading.red;
            const on = riskLevels.has(level);
            return (
              <Pressable key={level} onPress={() => toggleRiskLevel(level)} style={styles.checkRow}>
                <View style={[styles.checkbox, on && { backgroundColor: color, borderColor: color }]}>
                  {on && <Text style={styles.checkmark}>✓</Text>}
                </View>
                <Text style={[styles.checkLabel, { color: on ? color : Trading.muted }]}>
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </Text>
              </Pressable>
            );
          })}
        </Section>

        {/* Intervals */}
        <Section label="Trade on Intervals">
          <View style={styles.chipRow}>
            {(['1m', '5m', '15m', '60m'] as Interval[]).map(iv => {
              const on = intervals.has(iv);
              return (
                <Pressable
                  key={iv}
                  onPress={() => toggleInterval(iv)}
                  style={[styles.chip, on && styles.chipActive]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextActive]}>{iv}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        {/* Reset lock */}
        <Section label="Utilities">
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowLabel}>Reset trade lock</Text>
              <Text style={styles.rowSub}>Unstick a stuck order in MotiveWave</Text>
            </View>
            <Pressable onPress={resetLock} disabled={resetLoading} style={styles.resetBtn}>
              {resetLoading
                ? <ActivityIndicator color={Trading.muted} size="small" />
                : <Text style={styles.resetBtnText}>Reset</Text>
              }
            </Pressable>
          </View>
        </Section>

      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>{label.toUpperCase()}</Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Trading.bg },
  scroll: { paddingBottom: 48 },

  headerBar: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Trading.border,
    gap: 4,
  },
  title: { color: Trading.text, fontSize: 20, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: '600' },

  notConnectedBanner: {
    marginHorizontal: 20,
    marginTop: 12,
    backgroundColor: '#1a0808',
    borderWidth: 1,
    borderColor: Trading.red + '44',
    borderRadius: 12,
    padding: 12,
  },
  notConnectedText: { color: Trading.muted, fontSize: 12, lineHeight: 18 },

  section: { paddingHorizontal: 20, paddingTop: 22, gap: 10 },
  sectionHead: {
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#111111',
  },
  sectionLabel: {
    color: Trading.dim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  sectionBody: { gap: 8 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Trading.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: Trading.border,
    gap: 12,
  },
  rowLeft: { flex: 1, gap: 2 },
  rowLabel: { color: Trading.text, fontSize: 14, fontWeight: '600' },
  rowSub: { color: Trading.muted, fontSize: 11 },

  warningBanner: {
    backgroundColor: Trading.orange + '11',
    borderWidth: 1,
    borderColor: Trading.orange + '44',
    borderRadius: 10,
    padding: 12,
  },
  warningText: { color: Trading.orange, fontSize: 12, lineHeight: 18 },

  chipRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Trading.borderDefault,
    backgroundColor: Trading.surface,
    alignItems: 'center',
  },
  chipActive: {
    borderColor: Trading.accent,
    backgroundColor: Trading.accent + '20',
  },
  chipText: { color: Trading.muted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: Trading.accent, fontWeight: '700' },
  hint: { color: Trading.muted, fontSize: 11, paddingHorizontal: 2 },

  stratRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Trading.surface,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: Trading.border,
    gap: 12,
  },
  stratDot: { width: 10, height: 10, borderRadius: 5 },
  stratLevels: { flexDirection: 'row', gap: 8 },
  stratLevel: { fontSize: 10, color: Trading.muted, fontWeight: '600' },

  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Trading.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Trading.border,
    overflow: 'hidden',
  },
  stepBtn: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111111',
  },
  stepBtnText: { color: Trading.accent, fontSize: 24, fontWeight: '300' },
  stepValue: {
    flex: 1,
    textAlign: 'center',
    color: Trading.text,
    fontSize: 20,
    fontWeight: '700',
  },

  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: Trading.borderDefault,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: { color: '#000', fontSize: 13, fontWeight: '800' },
  checkLabel: { fontSize: 14, fontWeight: '600' },

  resetBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Trading.borderDefault,
    backgroundColor: Trading.surface,
    minWidth: 64,
    alignItems: 'center',
  },
  resetBtnText: { color: Trading.muted, fontSize: 13, fontWeight: '600' },
});
