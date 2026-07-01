import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.milksyellowbox.trading',
  appName: 'YellowBox',
  webDir: 'dist/public',
  server: {
    url: 'https://creation-atlanta-jazz-area.trycloudflare.com/:5000',
    cleartext: false,
    allowNavigation: ['jacksonspc.tail992e4c.ts.net'],
  },
  ios: {
    contentInset: 'always',
    allowsLinkPreview: false,
    scrollEnabled: true,
  },
};

export default config;
