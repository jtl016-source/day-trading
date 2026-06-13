import Svg, { Path, Circle } from 'react-native-svg';

// ── Line icons — native ports of the mockup `Ic` set (react-native-svg) ───────
interface IconProps { size?: number; color?: string; strokeWidth?: number; }

// Trade / open-position icon — a target (bullseye) with crosshair.
export function TradeIcon({ size = 22, color = '#e9ebf1', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx="12" cy="12" r="8" fill="none" stroke={color} strokeWidth={strokeWidth} />
      <Circle cx="12" cy="12" r="2.5" fill={color} />
      <Path d="M12 1v3M12 20v3M1 12h3M20 12h3" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

// Portfolio / allocation icon — pie chart.
export function PortfolioIcon({ size = 22, color = '#e9ebf1', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M12 12 L12 3 A9 9 0 0 1 20.5 14.5 Z" fill={color} opacity={0.55} />
      <Path d="M12 12 L12 3M12 12 L20.5 14.5" stroke={color} strokeWidth={strokeWidth * 0.8} strokeLinecap="round" />
    </Svg>
  );
}

export function MarketIcon({ size = 22, color = '#e9ebf1', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 17l5-6 4 3 5-8 4 5" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function SignalIcon({ size = 22, color = '#e9ebf1', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 12h3l2 6 4-14 2 8h7" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function SettingsIcon({ size = 22, color = '#e9ebf1', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M5 8h14M5 8a2 2 0 104 0 2 2 0 10-4 0M5 16h14M15 16a2 2 0 104 0 2 2 0 10-4 0" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

export function ReloadIcon({ size = 16, color = '#2dd4bf', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M4 9a8 8 0 0113-5l3 2M20 15a8 8 0 01-13 5l-3-2M19 4v4h-4M5 20v-4h4" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function LayersIcon({ size = 14, color = '#2dd4bf', strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function JournalIcon({ size = 22, color = '#e9ebf1', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zM8 9h8M8 13h5" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function BacktestIcon({ size = 22, color = '#e9ebf1', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 3v18h18M7 16l4-4 3 3 4-5" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
