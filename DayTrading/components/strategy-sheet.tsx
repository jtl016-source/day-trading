import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { Trading, Fonts } from '@/constants/theme';
import { Toggle } from '@/components/meridian-ui';
import { useApp, type Strategies } from '@/context/app-context';
import type { MobileSignal } from '@/lib/signal-map';

export interface StrategySheetRef { present: () => void; dismiss: () => void; }

type StratKey = keyof Strategies;
const STRATS: { key: StratKey; wrKey: 'milk' | 'vec' | 'fp' | null; name: string; desc: string }[] = [
  { key: 'milkZones', wrKey: 'milk', name: 'MilkZone',  desc: 'Liquidity zone reversion' },
  { key: 'vector',    wrKey: 'vec',  name: 'Vector',    desc: 'Momentum thrust continuation' },
  { key: 'footprint', wrKey: 'fp',   name: 'Footprint', desc: 'Order-flow bid/ask imbalance' },
];

// Per-strategy win rate derived from the loaded signals (real data; honest "—" when none).
function wrFor(key: 'milk' | 'vec' | 'fp', signals: MobileSignal[]): number | null {
  const decided = signals.filter(s => s.outcome !== 'Open' && s.strategies[key]);
  if (!decided.length) return null;
  const wins = decided.filter(s => s.outcome === 'Win').length;
  return Math.round((wins / decided.length) * 100);
}

export const StrategySheet = forwardRef<StrategySheetRef, { signals?: MobileSignal[] }>(
  function StrategySheet({ signals = [] }, ref) {
    const { strategies, toggleStrategy } = useApp();
    const modalRef = useRef<BottomSheetModal>(null);
    useImperativeHandle(ref, () => ({
      present: () => modalRef.current?.present(),
      dismiss: () => modalRef.current?.dismiss(),
    }), []);

    const wr = useMemo(() => ({
      milk: wrFor('milk', signals),
      vec:  wrFor('vec', signals),
      fp:   wrFor('fp', signals),
    }), [signals]);

    return (
      <BottomSheetModal
        ref={modalRef}
        enableDynamicSizing
        backgroundStyle={s.bg}
        handleIndicatorStyle={s.handle}
        backdropComponent={(props) => (
          <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.5} pressBehavior="close" />
        )}
      >
        <BottomSheetView style={s.content}>
          <View style={s.head}>
            <Text style={s.headTxt}>CONFIRMATION STRATEGIES</Text>
          </View>
          {STRATS.map((st, i) => {
            const pct = st.wrKey ? wr[st.wrKey] : null;
            return (
              <View key={st.key} style={[s.row, i === STRATS.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{st.name}</Text>
                  <Text style={s.desc}>{st.desc}</Text>
                </View>
                <View style={s.right}>
                  <Text style={s.wr}>{pct !== null ? `${pct}% WR` : '— WR'}</Text>
                  <Toggle on={strategies[st.key]} onChange={() => toggleStrategy(st.key)} />
                </View>
              </View>
            );
          })}
        </BottomSheetView>
      </BottomSheetModal>
    );
  },
);

const s = StyleSheet.create({
  bg: { backgroundColor: '#0a0c12', borderTopWidth: 1, borderTopColor: 'rgba(45,212,191,0.2)' },
  handle: { backgroundColor: 'rgba(255,255,255,0.25)', width: 38 },
  content: { paddingHorizontal: 18, paddingBottom: 36 },
  head: { paddingBottom: 12, marginBottom: 6, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  headTxt: { fontFamily: Fonts.display, fontSize: 11, fontWeight: '600', letterSpacing: 1.5, color: Trading.accent },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  name: { fontSize: 14, fontWeight: '600', letterSpacing: 0.5, color: Trading.text, fontFamily: Fonts.display },
  desc: { fontSize: 10, color: Trading.muted, marginTop: 3 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  wr: { fontFamily: Fonts.mono, fontSize: 10, color: Trading.long, backgroundColor: 'rgba(31,217,138,0.1)', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, fontWeight: '600' },
});
