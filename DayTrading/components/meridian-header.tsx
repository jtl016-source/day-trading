import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Trading, Fonts } from '@/constants/theme';
import { LayersIcon } from '@/components/meridian-icons';
import { LivePulse } from '@/components/animated-ui';
import { useETClock } from '@/hooks/use-et-clock';

// ── App header — brand + LIVE pill + STRATEGIES button + ET clock/market pill ──
// Ports the mockup <Header/> + <div class="m-clockbar"/>. Screens supply SafeArea.
export function MeridianHeader({ live, onOpenStrategies }:
  { live?: boolean; onOpenStrategies: () => void }) {
  const clock = useETClock();
  return (
    <View>
      <View style={h.header}>
        <View style={h.brandRow}>
          <View style={h.brandCol}>
            <Text style={h.brand}>BAXTER</Text>
            <Text style={h.brandSub}>Trading Platform</Text>
          </View>
          <View style={h.brandDot} />
          {live && (
            <View style={h.livePill}>
              <LivePulse size={6} color={Trading.long} />
              <Text style={h.liveTxt}>LIVE</Text>
            </View>
          )}
        </View>
        <Pressable style={({ pressed }) => [h.stratBtn, pressed && { backgroundColor: 'rgba(45,212,191,0.15)' }]} onPress={onOpenStrategies}>
          <LayersIcon size={14} color={Trading.accent} />
          <Text style={h.stratTxt}>STRATEGIES</Text>
        </Pressable>
      </View>

      <View style={h.clockbar}>
        <Text style={h.clkTime}>{clock.time} <Text style={h.clkZone}>ET</Text></Text>
        <View style={h.clkMkt}>
          <View style={[h.dot, { backgroundColor: clock.open ? Trading.long : Trading.short }]} />
          <Text style={[h.clkMktTxt, { color: clock.open ? Trading.long : Trading.short }]}>
            {clock.open ? 'MARKET OPEN' : 'MARKET CLOSED'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const h = StyleSheet.create({
  header: { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandCol: { flexDirection: 'column' },
  brand: { fontFamily: Fonts.bold, fontSize: 17, fontWeight: '700', letterSpacing: 3, color: Trading.text },
  brandSub: { fontFamily: Fonts.display, fontSize: 8, letterSpacing: 2, color: Trading.muted, textTransform: 'uppercase', marginTop: 2 },
  brandDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: Trading.accent },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: 'rgba(31,217,138,0.3)', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, marginLeft: 2 },
  liveTxt: { fontSize: 9, fontWeight: '600', letterSpacing: 1.5, color: Trading.long, fontFamily: Fonts.display },

  stratBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(45,212,191,0.08)', borderWidth: 1, borderColor: 'rgba(45,212,191,0.28)', borderRadius: 9, paddingHorizontal: 11, paddingVertical: 8 },
  stratTxt: { color: Trading.accent, fontSize: 10, fontWeight: '600', letterSpacing: 1, fontFamily: Fonts.display },

  clockbar: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  clkTime: { fontFamily: Fonts.mono, fontSize: 13, letterSpacing: 1.5, color: Trading.text },
  clkZone: { fontSize: 9, color: Trading.muted, letterSpacing: 1 },
  clkMkt: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  clkMktTxt: { fontSize: 9, fontWeight: '600', letterSpacing: 1, fontFamily: Fonts.display },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
