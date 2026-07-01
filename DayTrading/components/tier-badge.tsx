import { View, Text, StyleSheet } from 'react-native';
import { TIER, type TierKey, Fonts } from '@/constants/theme';

interface TierBadgeProps {
  level: string;
  size?: 'sm' | 'md' | 'lg';
  showGlyph?: boolean;
}

export function TierBadge({ level, size = 'md', showGlyph = true }: TierBadgeProps) {
  const t = TIER[level as TierKey] ?? TIER.risky;
  const sz = size === 'lg' ? s.lg : size === 'sm' ? s.sm : s.md;
  const txtSz = size === 'lg' ? s.textLg : size === 'sm' ? s.textSm : s.textMd;

  return (
    <View style={[s.badge, sz, { borderColor: t.color + '80', backgroundColor: t.color + '18' }]}>
      {showGlyph && <Text style={[s.glyph, txtSz, { color: t.color }]}>{t.glyph}</Text>}
      <Text style={[s.label, txtSz, { color: t.color }]}>{t.label}</Text>
    </View>
  );
}

/** Inline chip version — no border, just colored text + glyph */
export function TierChip({ level }: { level: string }) {
  const t = TIER[level as TierKey] ?? TIER.risky;
  return (
    <Text style={[s.chip, { color: t.color }]}>{t.glyph} {t.label}</Text>
  );
}

const s = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 5,
    alignSelf: 'flex-start',
  },
  sm:     { paddingHorizontal: 6,  paddingVertical: 2 },
  md:     { paddingHorizontal: 8,  paddingVertical: 4 },
  lg:     { paddingHorizontal: 12, paddingVertical: 6 },
  glyph:  { fontWeight: '700' },
  label:  { fontWeight: '700', letterSpacing: 0.5 },
  textSm: { fontSize: 10 },
  textMd: { fontSize: 12 },
  textLg: { fontSize: 16 },
  chip:   { fontSize: 11, fontWeight: '700' },
});
