// ── Shared portfolio UI atoms (RN, MERIDIAN theme) ───────────────────────────
import { View, Text, StyleSheet, type ViewStyle } from 'react-native';
import { Trading, Fonts } from '@/constants/theme';
import { GRADE_COLOR } from '@/hooks/use-portfolio';

export function Panel({ title, right, children, style }: { title?: string; right?: React.ReactNode; children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[ui.panel, style]}>
      {(title || right) && (
        <View style={ui.panelHead}>
          {title ? <Text style={ui.panelTitle}>{title}</Text> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function ScoreBadge({ grade, total, size = 12 }: { grade: string; total: number; size?: number }) {
  const c = GRADE_COLOR[grade] ?? Trading.muted;
  return (
    <View style={[ui.badge, { borderColor: c + '66', paddingHorizontal: size * 0.6, paddingVertical: size * 0.22 }]}>
      <Text style={{ color: c, fontFamily: Fonts.monoBold, fontSize: size, fontWeight: '700' }}>{grade} {Math.round(total)}</Text>
    </View>
  );
}

export function PillarBar({ label, score, max }: { label: string; score: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  return (
    <View style={{ marginBottom: 12 }}>
      <View style={ui.pbTop}>
        <Text style={ui.pbLabel}>{label}</Text>
        <Text style={ui.pbVal}>{score.toFixed(1)} / {max}</Text>
      </View>
      <View style={ui.track}><View style={[ui.fill, { width: `${pct}%` }]} /></View>
    </View>
  );
}

export function Flag({ text }: { text: string }) {
  return <View style={ui.flag}><Text style={ui.flagTxt}>{text}</Text></View>;
}

export function Empty({ text }: { text: string }) {
  return <View style={ui.empty}><Text style={ui.emptyTxt}>{text}</Text></View>;
}

const ui = StyleSheet.create({
  panel: { backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 14, padding: 14, marginBottom: 14 },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  panelTitle: { fontFamily: Fonts.display, fontSize: 11, fontWeight: '600', letterSpacing: 1.5, color: Trading.text, textTransform: 'uppercase' },
  badge: { borderWidth: 1, borderRadius: 6, alignSelf: 'flex-start' },
  pbTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  pbLabel: { fontSize: 11, letterSpacing: 1, color: Trading.muted, textTransform: 'uppercase' },
  pbVal: { fontFamily: Fonts.mono, fontSize: 12, color: Trading.text },
  track: { height: 7, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.05)', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 5, backgroundColor: Trading.accent },
  flag: { backgroundColor: 'rgba(255,180,84,0.12)', borderWidth: 1, borderColor: 'rgba(255,180,84,0.35)', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  flagTxt: { fontFamily: Fonts.mono, fontSize: 9, letterSpacing: 0.5, color: Trading.amber },
  empty: { paddingVertical: 34, alignItems: 'center' },
  emptyTxt: { color: Trading.muted, fontSize: 12, letterSpacing: 1 },
});
