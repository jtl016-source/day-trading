import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, PanResponder,
  type LayoutChangeEvent, type StyleProp, type ViewStyle,
} from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, interpolateColor } from 'react-native-reanimated';
import { Trading, Fonts, TIER, type TierKey } from '@/constants/theme';

const MONO = Fonts.mono;
const DISP = Fonts.display;

// ── Card — translucent glass panel with teal corner brackets + optional header ─
export function Card({ title, icon, children, style }:
  { title?: string; icon?: React.ReactNode; children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[c.card, style]}>
      <View style={[c.br, c.tl]} /><View style={[c.br, c.tr]} />
      <View style={[c.br, c.bl]} /><View style={[c.br, c.brr]} />
      {!!title && (
        <View style={c.header}>
          {icon}
          <Text style={c.headerText}>{title}</Text>
        </View>
      )}
      {children}
    </View>
  );
}

// ── Row — label/sub left, control right, hairline divider ─────────────────────
export function Row({ label, sub, children, last }:
  { label: string; sub?: string; children?: React.ReactNode; last?: boolean }) {
  return (
    <View style={[c.row, last && { borderBottomWidth: 0 }]}>
      <View style={c.rowL}>
        <Text style={c.rowLab}>{label}</Text>
        {!!sub && <Text style={c.rowSub}>{sub}</Text>}
      </View>
      <View style={c.rowR}>{children}</View>
    </View>
  );
}

// ── Toggle — pill switch (reanimated knob + track color) ──────────────────────
export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const p = useSharedValue(on ? 1 : 0);
  useEffect(() => { p.value = withTiming(on ? 1 : 0, { duration: 200 }); }, [on, p]);
  const track = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(p.value, [0, 1], ['rgba(255,255,255,0.10)', 'rgba(45,212,191,0.30)']),
    borderColor: interpolateColor(p.value, [0, 1], [Trading.line, 'rgba(45,212,191,0.5)']),
  }));
  const knob = useAnimatedStyle(() => ({
    transform: [{ translateX: 2 + p.value * 18 }],
    backgroundColor: interpolateColor(p.value, [0, 1], ['#e9ebf1', Trading.accent]),
  }));
  return (
    <Pressable onPress={() => onChange(!on)} hitSlop={6}>
      <Animated.View style={[c.tog, track]}>
        <Animated.View style={[c.togKnob, knob]} />
      </Animated.View>
    </Pressable>
  );
}

// ── Seg — segmented control (optional display labels) ─────────────────────────
export function Seg<T extends string>({ value, options, onChange, labels }:
  { value: T; options: readonly T[]; onChange: (v: T) => void; labels?: Partial<Record<T, string>> }) {
  return (
    <View style={c.seg}>
      {options.map(o => {
        const on = value === o;
        return (
          <Pressable key={o} onPress={() => onChange(o)} style={[c.segBtn, on && c.segBtnOn]}>
            <Text style={[c.segTxt, on && { color: Trading.accent }]}>{labels?.[o] ?? o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Slider — custom track + draggable thumb (no extra native dep) ─────────────
export function Slider({ value, min, max, step, onChange, fmt }:
  { value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  const [w, setW] = useState(0);
  const wRef = useRef(0);
  const valRef = useRef(value);
  valRef.current = value;

  const clampSnap = (raw: number) => {
    const stepped = Math.round(raw / step) * step;
    const cl = Math.min(max, Math.max(min, stepped));
    return +cl.toFixed(4);
  };
  const fromX = (x: number) => {
    if (wRef.current <= 0) return value;
    const frac = Math.min(1, Math.max(0, x / wRef.current));
    return clampSnap(min + frac * (max - min));
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => onChange(fromX(e.nativeEvent.locationX)),
      onPanResponderMove: (e) => onChange(fromX(e.nativeEvent.locationX)),
    }),
  ).current;

  const onLayout = (e: LayoutChangeEvent) => { const ww = e.nativeEvent.layout.width; wRef.current = ww; setW(ww); };
  const frac = max > min ? (value - min) / (max - min) : 0;

  return (
    <View style={c.slider}>
      <View style={c.sliderTrackWrap} onLayout={onLayout} {...pan.panHandlers}>
        <View style={c.sliderTrack} />
        <View style={[c.sliderFill, { width: `${frac * 100}%` }]} />
        <View style={[c.sliderThumb, { left: Math.max(0, frac * w - 8) }]} />
      </View>
      <Text style={c.sliderVal}>{fmt ? fmt(value) : String(value)}</Text>
    </View>
  );
}

// ── Stepper — −/value/+ ───────────────────────────────────────────────────────
export function Stepper({ value, step = 0.1, min = 0, max = 99, onChange, fmt }:
  { value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  const dec = () => onChange(Math.max(min, +(value - step).toFixed(2)));
  const inc = () => onChange(Math.min(max, +(value + step).toFixed(2)));
  return (
    <View style={c.step}>
      <Pressable onPress={dec} style={c.stepBtn} hitSlop={6}><Text style={c.stepBtnTxt}>–</Text></Pressable>
      <Text style={c.stepVal}>{fmt ? fmt(value) : String(value)}</Text>
      <Pressable onPress={inc} style={c.stepBtn} hitSlop={6}><Text style={c.stepBtnTxt}>+</Text></Pressable>
    </View>
  );
}

// ── TierPill — colored tier chip (uses the app TIER metadata) ─────────────────
export function TierPill({ tier }: { tier: string }) {
  const t = TIER[tier as TierKey] ?? TIER.risky;
  return (
    <View style={[c.tier, { borderColor: t.color + '66', backgroundColor: t.color + '20' }]}>
      <Text style={[c.tierTxt, { color: t.color }]}>{t.label}</Text>
    </View>
  );
}

const c = StyleSheet.create({
  // card
  card: { position: 'relative', backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 13, padding: 13 },
  br: { position: 'absolute', width: 8, height: 8, borderColor: 'rgba(45,212,191,0.45)' },
  tl: { top: 7, left: 7, borderTopWidth: 1.5, borderLeftWidth: 1.5 },
  tr: { top: 7, right: 7, borderTopWidth: 1.5, borderRightWidth: 1.5 },
  bl: { bottom: 7, left: 7, borderBottomWidth: 1.5, borderLeftWidth: 1.5 },
  brr: { bottom: 7, right: 7, borderBottomWidth: 1.5, borderRightWidth: 1.5 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 10, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  headerText: { fontFamily: DISP, fontSize: 11, fontWeight: '600', letterSpacing: 1.5, color: Trading.accent, textTransform: 'uppercase' },

  // row
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  rowL: { flex: 1 },
  rowLab: { fontSize: 13, fontWeight: '500', color: Trading.text },
  rowSub: { fontSize: 9, color: Trading.muted, marginTop: 2, letterSpacing: 0.3 },
  rowR: { flexShrink: 0 },

  // toggle
  tog: { width: 44, height: 26, borderRadius: 13, borderWidth: 1, justifyContent: 'center' },
  togKnob: { width: 20, height: 20, borderRadius: 10 },

  // seg
  seg: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.3)', borderWidth: 1, borderColor: Trading.line, borderRadius: 8, padding: 2 },
  segBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  segBtnOn: { backgroundColor: 'rgba(45,212,191,0.18)' },
  segTxt: { fontFamily: MONO, fontSize: 10, fontWeight: '600', color: Trading.muted },

  // slider
  slider: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  sliderTrackWrap: { width: 96, height: 24, justifyContent: 'center' },
  sliderTrack: { position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)' },
  sliderFill: { position: 'absolute', left: 0, height: 3, borderRadius: 2, backgroundColor: Trading.accent },
  sliderThumb: { position: 'absolute', width: 16, height: 16, borderRadius: 8, backgroundColor: Trading.accent, top: 4 },
  sliderVal: { fontFamily: MONO, fontSize: 12, color: Trading.text, minWidth: 40, textAlign: 'right' },

  // stepper
  step: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepBtn: { width: 26, height: 26, borderRadius: 7, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass2, alignItems: 'center', justifyContent: 'center' },
  stepBtnTxt: { color: Trading.accent, fontSize: 16, lineHeight: 18 },
  stepVal: { fontFamily: MONO, fontSize: 12, color: Trading.text, minWidth: 44, textAlign: 'center' },

  // tier pill
  tier: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 },
  tierTxt: { fontFamily: MONO, fontSize: 9, fontWeight: '600', letterSpacing: 0.5 },
});
