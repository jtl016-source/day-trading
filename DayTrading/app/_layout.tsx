import 'react-native-reanimated';
import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import Constants from 'expo-constants';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts, ChakraPetch_500Medium, ChakraPetch_600SemiBold, ChakraPetch_700Bold } from '@expo-google-fonts/chakra-petch';
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium, IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono';
import { AppProvider, useApp } from '@/context/app-context';
import { MeridianBackground } from '@/components/meridian-background';
import { Trading } from '@/constants/theme';

// Keep the splash up until fonts are ready (Chakra Petch + IBM Plex Mono).
SplashScreen.preventAutoHideAsync().catch(() => {});

// Navigator backgrounds transparent so the MeridianBackground shows through.
const navTheme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: 'transparent' } };

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
  const [fontsLoaded] = useFonts({
    ChakraPetch_500Medium, ChakraPetch_600SemiBold, ChakraPetch_700Bold,
    IBMPlexMono_400Regular, IBMPlexMono_500Medium, IBMPlexMono_600SemiBold,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppProvider>
        <NotificationSetup />
        <ThemeProvider value={navTheme}>
          <BottomSheetModalProvider>
            <View style={{ flex: 1, backgroundColor: Trading.bg }}>
              <MeridianBackground />
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="(tabs)" />
              </Stack>
            </View>
            <StatusBar style="light" />
          </BottomSheetModalProvider>
        </ThemeProvider>
      </AppProvider>
    </GestureHandlerRootView>
  );
}
