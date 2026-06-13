import { useEffect } from 'react';
import { TextInput, StyleProp, TextStyle, ViewStyle, View, Pressable, PressableProps } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedProps, useAnimatedStyle,
  withTiming, withRepeat, withSequence, withSpring,
  Easing, interpolateColor, cancelAnimation,
} from 'react-native-reanimated';
import { Trading } from '@/constants/theme';

// ── AnimatedNumber — smoothly counts to a new value when it changes ───────────
Animated.addWhitelistedNativeProps({ text: true });
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

interface AnimatedNumberProps {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  style?: StyleProp<TextStyle>;
}
export function AnimatedNumber({ value, decimals = 2, prefix = '', suffix = '', duration = 550, style }: AnimatedNumberProps) {
  const sv = useSharedValue(value);
  useEffect(() => {
    sv.value = withTiming(value, { duration, easing: Easing.out(Easing.cubic) });
  }, [value, duration, sv]);
  const animatedProps = useAnimatedProps(() => {
    return { text: `${prefix}${sv.value.toFixed(decimals)}${suffix}` } as any;
  });
  return (
    <AnimatedTextInput
      editable={false}
      underlineColorAndroid="transparent"
      value={`${prefix}${value.toFixed(decimals)}${suffix}`}
      animatedProps={animatedProps}
      style={style}
      pointerEvents="none"
    />
  );
}

// ── GlowPulse — breathing glow border for "live"/"active" states ──────────────
interface GlowPulseProps {
  color: string;
  active?: boolean;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}
export function GlowPulse({ color, active = true, radius = 14, style, children }: GlowPulseProps) {
  const glow = useSharedValue(0);
  useEffect(() => {
    if (active) {
      glow.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.25, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
        ), -1, false,
      );
    } else {
      cancelAnimation(glow);
      glow.value = withTiming(0, { duration: 300 });
    }
    return () => cancelAnimation(glow);
  }, [active, glow]);
  const aStyle = useAnimatedStyle(() => ({
    shadowColor: color,
    shadowOpacity: 0.15 + glow.value * 0.55,
    shadowRadius: radius * (0.5 + glow.value * 0.8),
    shadowOffset: { width: 0, height: 0 },
    elevation: glow.value * 8,
  }));
  return <Animated.View style={[aStyle, style]}>{children}</Animated.View>;
}

// ── PressableScale — spring scale + dim on press ──────────────────────────────
interface PressableScaleProps extends PressableProps {
  scaleTo?: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}
export function PressableScale({ scaleTo = 0.96, children, style, onPressIn, onPressOut, ...rest }: PressableScaleProps) {
  const s = useSharedValue(1);
  const aStyle = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Pressable
      onPressIn={(e) => { s.value = withSpring(scaleTo, { damping: 15, stiffness: 400 }); onPressIn?.(e); }}
      onPressOut={(e) => { s.value = withSpring(1, { damping: 12, stiffness: 350 }); onPressOut?.(e); }}
      {...rest}
    >
      <Animated.View style={[aStyle, style]}>{children}</Animated.View>
    </Pressable>
  );
}

// ── Shimmer — animated loading skeleton bar ───────────────────────────────────
export function Shimmer({ width, height = 12, radius = 6, style }: { width: number | string; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const x = useSharedValue(0);
  useEffect(() => {
    x.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }), -1, false);
    return () => cancelAnimation(x);
  }, [x]);
  const aStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(x.value, [0, 0.5, 1], [Trading.surfaceAlt, Trading.borderAccent, Trading.surfaceAlt]),
  }));
  return <Animated.View style={[{ width: width as any, height, borderRadius: radius }, aStyle, style]} />;
}

// ── LivePulse — a small pulsing dot (live indicator) ──────────────────────────
export function LivePulse({ color = Trading.long, size = 8 }: { color?: string; size?: number }) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  useEffect(() => {
    scale.value = withRepeat(withSequence(
      withTiming(1.5, { duration: 800, easing: Easing.out(Easing.ease) }),
      withTiming(1, { duration: 800, easing: Easing.in(Easing.ease) }),
    ), -1, false);
    opacity.value = withRepeat(withSequence(
      withTiming(0.4, { duration: 800 }),
      withTiming(1, { duration: 800 }),
    ), -1, false);
    return () => { cancelAnimation(scale); cancelAnimation(opacity); };
  }, [scale, opacity]);
  const ring = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }], opacity: opacity.value }));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color }, ring]} />
      <View style={{ width: size * 0.62, height: size * 0.62, borderRadius: size, backgroundColor: color }} />
    </View>
  );
}
