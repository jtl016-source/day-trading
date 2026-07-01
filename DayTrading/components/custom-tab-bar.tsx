import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Trading, Fonts } from '@/constants/theme';
import { MarketIcon, SignalIcon, SettingsIcon, TradeIcon, PortfolioIcon } from '@/components/meridian-icons';

// 5-tab bar: Market · Signals · Trade · Portfolio · Settings
const TABS: { name: string; label: string; Icon: typeof MarketIcon }[] = [
  { name: 'index',     label: 'MARKET',    Icon: MarketIcon },
  { name: 'signals',   label: 'SIGNALS',   Icon: SignalIcon },
  { name: 'trade',     label: 'TRADE',     Icon: TradeIcon },
  { name: 'portfolio', label: 'PORTFOLIO', Icon: PortfolioIcon },
  { name: 'settings',  label: 'SETTINGS',  Icon: SettingsIcon },
];

export function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const activeName = state.routes[state.index]?.name;

  return (
    <View style={[bar.wrap, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {TABS.map(({ name, label, Icon }) => {
        const focused = activeName === name;
        const color = focused ? Trading.accent : Trading.dim;
        const onPress = () => {
          const target = state.routes.find(r => r.name === name);
          if (!target) return;
          const event = navigation.emit({ type: 'tabPress', target: target.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(name as never);
        };
        return (
          <Pressable key={name} onPress={onPress}
            style={({ pressed }) => [bar.tab, pressed && { opacity: 0.7, transform: [{ scale: 0.94 }] }]}>
            <View style={focused ? bar.iconGlow : undefined}>
              <Icon size={20} color={color} />
            </View>
            <Text style={[bar.label, { color }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const bar = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    paddingTop: 8,
    paddingHorizontal: 4,
    backgroundColor: 'rgba(8,9,13,0.92)',
    borderTopWidth: 1,
    borderTopColor: Trading.line,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3, paddingVertical: 5 },
  iconGlow: Platform.select({
    ios: { shadowColor: Trading.accent, shadowOpacity: 0.6, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
    default: {},
  })!,
  label: { fontFamily: Fonts.display, fontSize: 7.5, fontWeight: '600', letterSpacing: 0.8 },
});
