import { useState } from 'react';
import {
  View, Text, TextInput, Switch, Pressable,
  ScrollView, StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useApp, Timeframe } from '@/context/app-context';
import { Trading, Fonts } from '@/constants/theme';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '60m'];
const INSTRUMENTS = ['MES1!', 'ES1!', 'NQ1!', 'MNQ1!'];
const MONO = Fonts?.mono ?? undefined;

export default function SettingsScreen() {
  const {
    apiBaseUrl, setApiBaseUrl,
    notificationsEnabled, setNotificationsEnabled,
    instrument, setInstrument,
    timeframe, setTimeframe,
  } = useApp();

  const [urlInput, setUrlInput] = useState(apiBaseUrl);

  function saveUrl() {
    const trimmed = urlInput.trim().replace(/\/$/, '');
    setApiBaseUrl(trimmed);
    Alert.alert('Saved', 'API URL updated.');
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <View style={styles.headerBar}>
            <Text style={styles.title}>Settings</Text>
          </View>

          {/* Instrument */}
          <Section label="Instrument">
            <View style={styles.chipRow}>
              {INSTRUMENTS.map(ins => (
                <Pressable
                  key={ins}
                  onPress={() => setInstrument(ins)}
                  style={[styles.chip, instrument === ins && styles.chipActive]}
                >
                  <Text style={[styles.chipText, instrument === ins && styles.chipTextActive]}>
                    {ins}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={styles.inputMono}
              value={instrument}
              onChangeText={setInstrument}
              placeholder="Custom instrument…"
              placeholderTextColor={Trading.dim}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
            />
          </Section>

          {/* Timeframe */}
          <Section label="Default Timeframe">
            <View style={styles.chipRow}>
              {TIMEFRAMES.map(tf => (
                <Pressable
                  key={tf}
                  onPress={() => setTimeframe(tf)}
                  style={[styles.chip, timeframe === tf && styles.chipActive]}
                >
                  <Text style={[styles.chipText, timeframe === tf && styles.chipTextActive]}>
                    {tf}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Section>

          {/* Notifications */}
          <Section label="Notifications">
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Enable Notifications</Text>
              <Switch
                value={notificationsEnabled}
                onValueChange={setNotificationsEnabled}
                trackColor={{ false: Trading.border, true: Trading.green + '66' }}
                thumbColor={notificationsEnabled ? Trading.green : Trading.muted}
              />
            </View>
          </Section>

          {/* API URL */}
          <Section label="Data Source">
            <TextInput
              style={styles.inputUrl}
              value={urlInput}
              onChangeText={setUrlInput}
              placeholder="https://trading.jacksonlems.com"
              placeholderTextColor={Trading.dim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={saveUrl}
            />
            <Pressable
              style={({ pressed }) => [styles.saveBtn, pressed && styles.saveBtnPressed]}
              onPress={saveUrl}
            >
              <Text style={styles.saveBtnText}>Save URL</Text>
            </Pressable>
          </Section>

          {/* Navigation */}
          <Section label="Navigation">
            <Pressable style={styles.navBtn} onPress={() => router.replace('/')}>
              <Text style={styles.navBtnText}>← Back to Welcome</Text>
            </Pressable>
          </Section>
        </ScrollView>
      </KeyboardAvoidingView>
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
  flex: { flex: 1 },
  scroll: { paddingBottom: 48, gap: 0 },
  headerBar: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Trading.border,
  },
  title: { color: Trading.text, fontSize: 20, fontWeight: '700' },

  section: {
    paddingHorizontal: 20,
    paddingTop: 24,
    gap: 10,
  },
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

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: Trading.borderDefault,
    backgroundColor: Trading.surface,
  },
  chipActive: {
    borderColor: Trading.accent,
    backgroundColor: Trading.accent + '20',
  },
  chipText: { color: Trading.muted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: Trading.accent, fontWeight: '700' },

  inputMono: {
    backgroundColor: Trading.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Trading.borderDefault,
    color: '#c8ffd4',
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontFamily: MONO,
    letterSpacing: 0.5,
  },
  inputUrl: {
    backgroundColor: Trading.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Trading.borderDefault,
    color: '#a0c4ff',
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontFamily: MONO,
  },

  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Trading.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: Trading.border,
  },
  rowLabel: { color: Trading.text, fontSize: 15, fontWeight: '500' },

  saveBtn: {
    backgroundColor: Trading.accent,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: Trading.accent,
    shadowRadius: 10,
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  saveBtnPressed: { opacity: 0.85 },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.5 },

  navBtn: {
    backgroundColor: 'transparent',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Trading.borderDefault,
  },
  navBtnText: { color: Trading.muted, fontSize: 14, fontWeight: '600' },
});
