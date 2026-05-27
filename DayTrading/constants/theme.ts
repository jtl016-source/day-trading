import { Platform } from 'react-native';

export const Trading = {
  bg: '#000000',
  surface: '#0d0d0d',
  surfaceAlt: '#111111',
  surfaceCard: '#141414',
  border: '#1a1a1a',
  borderDefault: '#222222',
  text: '#ffffff',
  textSecondary: '#888888',
  muted: '#888888',
  dim: '#555555',
  accent: '#3d8ef8',
  green: '#00e676',
  red: '#ff4444',
  orange: '#f59e0b',
  purple: '#a78bfa',
  gold: '#fbbf24',
  // strategy brand colors
  milkZones: '#00e676',
  vector: '#8b5cf6',
  footprint: '#f97316',
  // signal tier colors
  safe: '#00e676',
  risky: '#f59e0b',
  riskiest: '#a78bfa',
};

const tintColorDark = '#3d8ef8';

export const Colors = {
  light: {
    text: '#11181C',
    background: '#fff',
    tint: '#0a7ea4',
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: '#0a7ea4',
  },
  dark: {
    text: Trading.text,
    background: Trading.bg,
    tint: tintColorDark,
    icon: Trading.muted,
    tabIconDefault: Trading.muted,
    tabIconSelected: tintColorDark,
  },
};

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
