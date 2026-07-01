import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Trading } from '@/constants/theme';

interface SyncChipProps {
  connected: boolean;
  latencyMs?: number | null;
  feedName?: string;
}

export function SyncChip({ connected, latencyMs, feedName = 'DXFeed' }: SyncChipProps) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!connected) { pulse.setValue(0.3); return; }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1,   duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 1000, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [connected, pulse]);

  const dotColor = connected ? Trading.safeplus : Trading.riskiest;
  const chipBorder = connected ? Trading.safeplus + '50' : Trading.riskiest + '50';
  const chipBg = connected ? Trading.safeplus + '10' : Trading.riskiest + '10';

  return (
    <View style={[s.chip, { borderColor: chipBorder, backgroundColor: chipBg }]}>
      <Animated.View style={[s.dot, { backgroundColor: dotColor, opacity: pulse }]} />
      <Text style={[s.label, { color: connected ? Trading.safeplus : Trading.riskiest }]}>
        {connected
          ? `SYNCED · ${feedName}${latencyMs != null ? ` · ${latencyMs}ms` : ''}`
          : 'NOT SYNCED'}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  dot:   { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
});
