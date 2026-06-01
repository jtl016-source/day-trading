import { Tabs } from 'expo-router';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Trading } from '@/constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: Trading.surface,
          borderTopColor: Trading.border,
          borderTopWidth: 1,
          height: 62,
          paddingBottom: 10,
          paddingTop: 6,
        },
        tabBarActiveTintColor:   Trading.accent,
        tabBarInactiveTintColor: Trading.muted,
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '600',
          letterSpacing: 0.5,
          marginTop: 1,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Signals',
          tabBarIcon: ({ color, size }) => (
            <IconSymbol name="chart.line.uptrend.xyaxis" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="trade"
        options={{
          title: 'Position',
          tabBarIcon: ({ color, size }) => (
            <IconSymbol name="arrow.up.arrow.down.circle.fill" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="journal"
        options={{
          title: 'AutoTrader',
          tabBarIcon: ({ color, size }) => (
            <IconSymbol name="bolt.fill" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <IconSymbol name="gearshape.fill" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'About',
          tabBarIcon: ({ color, size }) => (
            <IconSymbol name="info.circle.fill" size={size ?? 22} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
