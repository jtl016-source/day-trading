import { Tabs } from 'expo-router';
import { CustomTabBar } from '@/components/custom-tab-bar';

// 4 primary tabs: Market / Signals / Trade / Settings
// journal, backtest, autotrader, explore stay routable (href: null) but hidden from the bar.
export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Tabs.Screen name="index"       options={{ title: 'Market' }} />
      <Tabs.Screen name="signals"     options={{ title: 'Signals' }} />
      <Tabs.Screen name="trade"       options={{ title: 'Trade' }} />
      <Tabs.Screen name="portfolio"   options={{ title: 'Portfolio' }} />
      <Tabs.Screen name="settings"    options={{ title: 'Settings' }} />
      <Tabs.Screen name="journal"     options={{ href: null }} />
      <Tabs.Screen name="backtest"    options={{ href: null }} />
      <Tabs.Screen name="autotrader"  options={{ href: null }} />
      <Tabs.Screen name="explore"     options={{ href: null }} />
    </Tabs>
  );
}
