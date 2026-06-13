import { useEffect, useState } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Svg, { Rect, Line, Text as SvgText, G } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue, useAnimatedProps, useAnimatedStyle, withTiming, withDelay, Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { Trading, Fonts } from '@/constants/theme';
import type { Candle } from '@/lib/candles';

const AnimatedG = Animated.createAnimatedComponent(G);

const MAX_BARS = 42;
const PAD_L = 8, PAD_R = 52, PAD_T = 12, PAD_B = 12;
const REVEAL_MS = 1000;

// One candle — fades + rises into place, staggered by its index along the timeline.
function WaveCandle({
  progress, index, total, x, slotW, bodyTop, bodyH, wickTop, wickH, up, isLast,
}: {
  progress: SharedValue<number>;
  index: number; total: number;
  x: number; slotW: number; bodyTop: number; bodyH: number; wickTop: number; wickH: number;
  up: boolean; isLast: boolean;
}) {
  const col = up ? Trading.long : Trading.short;
  const aProps = useAnimatedProps(() => {
    const start = (index / Math.max(1, total)) * 0.6 + Math.sin(index * 0.45) * 0.015;
    const local = Math.min(1, Math.max(0, (progress.value - start) / 0.4));
    return { opacity: local, y: (1 - local) * 16 } as any;
  });
  const bodyW = Math.max(1.5, slotW * 0.64);
  const bodyX = x + slotW * 0.18;
  const cx = x + slotW / 2;
  return (
    <AnimatedG animatedProps={aProps}>
      <Line x1={cx} y1={wickTop} x2={cx} y2={wickTop + wickH} stroke={col} strokeWidth={1.5} strokeLinecap="round" />
      <Rect x={bodyX} y={bodyTop} width={bodyW} height={Math.max(1.5, bodyH)} rx={1.5} fill={col}
        opacity={isLast ? 1 : 0.92} stroke={isLast ? col : undefined} strokeWidth={isLast ? 1 : 0} />
    </AnimatedG>
  );
}

export function WaveChart({ candles, chartKey, height = 248 }:
  { candles: Candle[]; chartKey: number | string; height?: number }) {
  const [w, setW] = useState(0);
  const progress = useSharedValue(0);
  const sweepX = useSharedValue(-0.4);

  // Replay the reveal whenever chartKey changes (entering Market / refresh).
  useEffect(() => {
    progress.value = 0;
    progress.value = withDelay(40, withTiming(1, { duration: REVEAL_MS, easing: Easing.out(Easing.cubic) }));
    sweepX.value = -0.4;
    sweepX.value = withTiming(1.4, { duration: 1100, easing: Easing.out(Easing.quad) });
  }, [chartKey, progress, sweepX]);

  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);

  const data = candles.slice(-MAX_BARS);
  const n = data.length;

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: sweepX.value * (w || 1) }],
  }));

  if (n < 2 || w < 2) {
    return <View style={[styles.wrap, { height }]} onLayout={onLayout} />;
  }

  // Price range with 12% padding (mockup geometry).
  const lows = data.map(c => c.low), highs = data.map(c => c.high);
  let lo = Math.min(...lows), hi = Math.max(...highs);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;

  const plotL = PAD_L, plotR = w - PAD_R;
  const plotW = Math.max(1, plotR - plotL);
  const plotT = PAD_T, plotB = height - PAD_B;
  const plotH = Math.max(1, plotB - plotT);
  const yOf = (p: number) => plotT + ((hi - p) / (hi - lo)) * plotH;
  const slotW = plotW / n;

  const last = data[n - 1];
  const lastY = yOf(last.close);
  const gridFracs = [0, 0.25, 0.5, 0.75, 1];

  return (
    <View style={[styles.wrap, { height }]} onLayout={onLayout}>
      <Svg width={w} height={height}>
        {/* grid + y labels */}
        {gridFracs.map((f, i) => {
          const price = hi - f * (hi - lo);
          const gy = plotT + f * plotH;
          return (
            <G key={'g' + i}>
              <Line x1={plotL} y1={gy} x2={plotR} y2={gy} stroke="rgba(255,255,255,0.045)" strokeWidth={1} />
              <SvgText x={plotR + 6} y={gy + 3} fill={Trading.muted} fontSize={9} fontFamily={Fonts.mono}>
                {price.toFixed(1)}
              </SvgText>
            </G>
          );
        })}

        {/* candles */}
        {data.map((cd, i) => {
          const up = cd.close >= cd.open;
          const bodyTop = yOf(Math.max(cd.open, cd.close));
          const bodyH = Math.max(0.6, yOf(Math.min(cd.open, cd.close)) - bodyTop);
          const wickTop = yOf(cd.high);
          const wickH = yOf(cd.low) - wickTop;
          return (
            <WaveCandle key={i} progress={progress} index={i} total={n}
              x={plotL + i * slotW} slotW={slotW}
              bodyTop={bodyTop} bodyH={bodyH} wickTop={wickTop} wickH={wickH}
              up={up} isLast={i === n - 1} />
          );
        })}

        {/* dashed price line + tag */}
        <Line x1={plotL} y1={lastY} x2={plotR} y2={lastY} stroke="rgba(45,212,191,0.55)" strokeWidth={1} strokeDasharray="4,3" />
        <Rect x={plotR + 2} y={lastY - 8} width={PAD_R - 4} height={16} rx={3} fill={Trading.accent} />
        <SvgText x={plotR + (PAD_R - 4) / 2 + 2} y={lastY + 3} fill="#04140f" fontSize={9} fontWeight="700"
          fontFamily={Fonts.monoBold} textAnchor="middle">
          {last.close.toFixed(2)}
        </SvgText>
      </Svg>

      {/* sweep band — single pass left→right on reveal */}
      <Animated.View pointerEvents="none" style={[styles.sweep, { width: w * 0.4 }, sweepStyle]}>
        <LinearGradient
          colors={['rgba(45,212,191,0)', 'rgba(45,212,191,0.10)', 'rgba(45,212,191,0)']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    backgroundColor: 'rgba(255,255,255,0.012)',
    borderWidth: 1, borderColor: Trading.line, borderRadius: 12,
    overflow: 'hidden',
  },
  sweep: { position: 'absolute', top: 0, bottom: 0, left: 0 },
});
