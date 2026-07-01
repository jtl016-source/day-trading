import { useEffect } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing, cancelAnimation,
} from 'react-native-reanimated';

// ── MERIDIAN background — Expo Go-safe replacement for the web WebGL shader ────
// expo-linear-gradient base + two slowly-drifting low-alpha teal/violet blobs +
// a vignette. No Skia, no native rebuild. Subtle, sits behind every screen.
function Blob({ color, size, fromX, fromY, dx, dy }:
  { color: string; size: number; fromX: number; fromY: number; dx: number; dy: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 22000, easing: Easing.inOut(Easing.sin) }),
      -1, true,
    );
    return () => cancelAnimation(t);
  }, [t]);
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: fromX + t.value * dx },
      { translateY: fromY + t.value * dy },
      { scale: 0.9 + t.value * 0.25 },
    ],
    opacity: 0.5 + t.value * 0.4,
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        style,
      ]}
    />
  );
}

export function MeridianBackground() {
  const { width, height } = useWindowDimensions();
  const blob = Math.max(width, height) * 0.9;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={['#0c0f17', '#06070c', '#030307']}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
      <Blob color="rgba(45,212,191,0.06)"  size={blob} fromX={-blob * 0.3} fromY={-blob * 0.15} dx={width * 0.25} dy={height * 0.12} />
      <Blob color="rgba(120,80,200,0.055)" size={blob} fromX={width - blob * 0.6} fromY={height - blob * 0.7} dx={-width * 0.22} dy={-height * 0.1} />
      {/* vignette — darken edges toward the bottom (matches the mockup veil) */}
      <LinearGradient
        colors={['rgba(6,7,11,0.0)', 'rgba(6,7,11,0.35)', 'rgba(6,7,11,0.8)']}
        locations={[0, 0.65, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
