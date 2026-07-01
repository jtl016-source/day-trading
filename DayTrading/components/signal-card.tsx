import { View, Text, StyleSheet } from 'react-native';
import { Trading } from '@/constants/theme';

export type SignalTier = 'safe' | 'risky' | 'riskiest';
export type SignalDirection = 'LONG' | 'SHORT';

export interface Signal {
  id: string;
  direction: SignalDirection;
  instrument: string;
  timeframe: string;
  tier: SignalTier;
  tp: number;
  sl: number;
  entry: number;
  timestamp: string;
  strategies: string[];
}

const TIER_COLOR: Record<SignalTier, string> = {
  safe: Trading.safe,
  risky: Trading.risky,
  riskiest: Trading.riskiest,
};

const TIER_LABEL: Record<SignalTier, string> = {
  safe: 'SAFE',
  risky: 'RISKY',
  riskiest: 'RISKIEST',
};

interface Props {
  signal: Signal;
}

export function SignalCard({ signal }: Props) {
  const dirColor = signal.direction === 'LONG' ? Trading.green : Trading.red;
  const tierColor = TIER_COLOR[signal.tier];
  const rr = signal.entry
    ? Math.abs(signal.tp - signal.entry) / Math.abs(signal.entry - signal.sl)
    : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.dirRow}>
          <View style={[styles.dirBadge, { backgroundColor: dirColor + '22', borderColor: dirColor }]}>
            <Text style={[styles.dirText, { color: dirColor }]}>{signal.direction}</Text>
          </View>
          <Text style={styles.instrument}>{signal.instrument}</Text>
          <Text style={styles.tf}>{signal.timeframe}</Text>
        </View>
        <View style={[styles.tierBadge, { backgroundColor: tierColor + '22', borderColor: tierColor }]}>
          <Text style={[styles.tierText, { color: tierColor }]}>{TIER_LABEL[signal.tier]}</Text>
        </View>
      </View>

      <View style={styles.levels}>
        <LevelRow label="Entry" value={signal.entry} color={Trading.muted} />
        <LevelRow label="TP" value={signal.tp} color={Trading.green} />
        <LevelRow label="SL" value={signal.sl} color={Trading.red} />
        {rr !== null && (
          <View style={styles.levelRow}>
            <Text style={styles.levelLabel}>R:R</Text>
            <Text style={[styles.levelValue, { color: rr >= 2 ? Trading.green : Trading.muted }]}>
              {rr.toFixed(1)}x
            </Text>
          </View>
        )}
      </View>

      {signal.strategies.length > 0 && (
        <View style={styles.strategies}>
          {signal.strategies.map(s => (
            <StrategyChip key={s} label={s} />
          ))}
        </View>
      )}

      <Text style={styles.time}>{formatTime(signal.timestamp)}</Text>
    </View>
  );
}

function LevelRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.levelRow}>
      <Text style={styles.levelLabel}>{label}</Text>
      <Text style={[styles.levelValue, { color }]}>{value.toFixed(2)}</Text>
    </View>
  );
}

function StrategyChip({ label }: { label: string }) {
  const color =
    label.toLowerCase().includes('milk') ? Trading.milkZones
    : label.toLowerCase().includes('vector') ? Trading.vector
    : Trading.footprint;

  return (
    <View style={[styles.chip, { borderColor: color + '66' }]}>
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </View>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return ts;
  }
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Trading.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Trading.border,
    padding: 14,
    marginHorizontal: 16,
    marginVertical: 6,
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dirBadge: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  dirText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  instrument: {
    color: Trading.text,
    fontSize: 16,
    fontWeight: '700',
  },
  tf: {
    color: Trading.muted,
    fontSize: 13,
  },
  tierBadge: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tierText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  levels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  levelRow: {
    alignItems: 'center',
    gap: 2,
    minWidth: 60,
  },
  levelLabel: {
    color: Trading.muted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  levelValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  strategies: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
  },
  time: {
    color: Trading.muted,
    fontSize: 11,
    alignSelf: 'flex-end',
  },
});
