import 'react-native-reanimated';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { AppProvider, useApp } from '@/context/app-context';

// Show alerts + play sound when a notification arrives while the app is open
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function NotificationSetup() {
  const { apiBaseUrl } = useApp();

  useEffect(() => {
    (async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') return;

      // Android needs a notification channel
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('signals', {
          name: 'Trading Signals',
          importance: Notifications.AndroidImportance.HIGH,
          sound: 'default',
        });
      }

      try {
        const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId as string | undefined;
        const { data: token } = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );
        await fetch(`${apiBaseUrl}/api/push-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, platform: Platform.OS }),
        });
      } catch {}
    })();
  }, [apiBaseUrl]);

  return null;
}

export default function RootLayout() {
  return (
    <AppProvider>
      <NotificationSetup />
      <ThemeProvider value={DarkTheme}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#000' } }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(tabs)" />
        </Stack>
        <StatusBar style="light" />
      </ThemeProvider>
    </AppProvider>
  );
}
