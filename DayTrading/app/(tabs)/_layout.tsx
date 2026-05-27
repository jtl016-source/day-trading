import { Tabs } from 'expo-router';
import { IconSymbol } from '@/components/ui/icon-symbol';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#000000',
          borderTopColor: '#1a1a1a',
          borderTopWidth: 1,
          height: 58,
          paddingBottom: 8,
          paddingTop: 4,
        },
        tabBarActiveTintColor: '#3d8ef8',
        tabBarInactiveTintColor: '#444444',
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '600',
          letterSpacing: 0.3,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Signals',
          tabBarIcon: ({ color }) => (
            <IconSymbol name="chart.line.uptrend.xyaxis" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="trade"
        options={{
          title: 'Trade',
          tabBarIcon: ({ color }) => (
            <IconSymbol name="arrow.up.arrow.down.circle.fill" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="journal"
        options={{
          title: 'AutoTrader',
          tabBarIcon: ({ color }) => (
            <IconSymbol name="bolt.fill" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => (
            <IconSymbol name="gearshape.fill" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'About',
          tabBarIcon: ({ color }) => (
            <IconSymbol name="info.circle.fill" size={22} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
