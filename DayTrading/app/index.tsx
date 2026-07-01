import {
  View, Text, TextInput, Pressable, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '@/context/app-context';
import { StrategyToggle } from '@/components/strategy-toggle';
import { Trading, Fonts } from '@/constants/theme';

const TIMEFRAMES = ['1m', '5m', '15m', '60m'] as const;

export default function WelcomeScreen() {
  const {
    strategies, toggleStrategy,
    instrument, setInstrument,
    timeframe, setTimeframe,
  } = useApp();

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>DAY TRADER</Text>
            <Text style={styles.subtitle}>Milk Yellow Box Strategy</Text>
          </View>

          {/* Strategies */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>STRATEGIES</Text>
            <View style={styles.toggleRow}>
              <StrategyToggle
                label="Milk Zones"
                color={Trading.milkZones}
                active={strategies.milkZones}
                onPress={() => toggleStrategy('milkZones')}
              />
              <StrategyToggle
                label="Vector"
                color={Trading.vector}
                active={strategies.vector}
                onPress={() => toggleStrategy('vector')}
              />
            </View>
            <View style={styles.toggleRow}>
              <StrategyToggle
                label="Footprint"
                color={Trading.footprint}
                active={strategies.footprint}
                onPress={() => toggleStrategy('footprint')}
              />
              <View style={styles.flex} />
            </View>
          </View>

          {/* Instrument */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>INSTRUMENT</Text>
            <TextInput
              style={styles.input}
              value={instrument}
              onChangeText={setInstrument}
              placeholder="e.g. MES1!"
              placeholderTextColor={Trading.dim}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
            />
          </View>

          {/* Timeframe */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>TIMEFRAME</Text>
            <View style={styles.tfRow}>
              {TIMEFRAMES.map(tf => (
                <Pressable
                  key={tf}
                  onPress={() => setTimeframe(tf)}
                  style={[
                    styles.tfBtn,
                    timeframe === tf && styles.tfBtnActive,
                  ]}
                >
                  <Text style={[styles.tfLabel, timeframe === tf && styles.tfLabelActive]}>
                    {tf}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Open Chart */}
          <Pressable
            style={({ pressed }) => [styles.openBtn, pressed && styles.openBtnPressed]}
            onPress={() => router.push('/(tabs)')}
          >
            <Text style={styles.openBtnText}>Open Chart</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const MONO = Fonts?.mono ?? undefined;

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Trading.bg,
  },
  flex: { flex: 1 },
  scroll: {
    padding: 24,
    gap: 28,
    flexGrow: 1,
  },
  header: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  title: {
    color: '#ffffff',
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 6,
  },
  subtitle: {
    color: '#888888',
    fontSize: 13,
    marginTop: 8,
    fontStyle: 'italic',
    letterSpacing: 0.4,
  },
  section: {
    gap: 12,
  },
  sectionLabel: {
    color: Trading.dim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
  },
  input: {
    backgroundColor: Trading.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Trading.borderDefault,
    color: '#c8ffd4',
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingVertical: 12,
    letterSpacing: 0.5,
    fontFamily: MONO,
  },
  tfRow: {
    flexDirection: 'row',
    gap: 8,
  },
  tfBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: Trading.borderDefault,
    backgroundColor: Trading.surface,
    alignItems: 'center',
  },
  tfBtnActive: {
    borderColor: Trading.accent,
    backgroundColor: Trading.accent + '20',
  },
  tfLabel: {
    color: Trading.dim,
    fontSize: 14,
    fontWeight: '600',
  },
  tfLabelActive: {
    color: Trading.accent,
    fontWeight: '700',
  },
  openBtn: {
    backgroundColor: Trading.accent,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: Trading.accent,
    shadowRadius: 14,
    shadowOpacity: 0.45,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  openBtnPressed: {
    opacity: 0.85,
  },
  openBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1,
  },
});
