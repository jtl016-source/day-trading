import { Platform } from 'react-native';

// ── Cockpit palette — near-black base with cool blue tint ─────────────────────
export const Trading = {
  // Backgrounds
  bg:          '#040d12',   // near-black, cool tint
  surface:     '#07111a',   // card / panel bg
  surfaceAlt:  '#0b1825',   // alternate card shade
  surfaceCard: '#0f1f2e',   // raised card
  panel:       '#091520',   // panel overlay

  // Borders (hairline — layered panels, not flat gray cards)
  border:      '#19293d',
  borderDefault:'#1e2f42',
  borderAccent:'#243d54',

  // Text
  text:        '#e8f0f7',   // warm white, not harsh
  textSecondary:'#7a9ab8',
  muted:       '#4a6880',
  dim:         '#2e4257',

  // Accent
  accent:      '#3d8ef8',

  // Direction
  long:        '#22c55e',   // LONG = green
  short:       '#ef4444',   // SHORT = red

  // Legacy (keep for chart-view compatibility)
  green:       '#22c55e',
  red:         '#ef4444',
  orange:      '#f59e0b',
  purple:      '#a78bfa',
  gold:        '#fbbf24',

  // ── Tier system — color + glyph, never color alone ───────────────────────────
  // SAFE+  ◆ emerald  #10b981
  // SAFE   ◆ teal     #14b8a6
  // RISKY  △ amber    #f59e0b
  // RISKIEST ▽ red-orange #f97316
  safeplus:    '#10b981',   // emerald
  safe:        '#14b8a6',   // teal
  risky:       '#f59e0b',   // amber
  riskiest:    '#f97316',   // red-orange

  // ── Auto-trader arm states ────────────────────────────────────────────────────
  armOff:      '#4a6880',   // muted gray — off/idle
  armArmed:    '#f59e0b',   // amber — connected, ready, not firing
  armLive:     '#10b981',   // emerald — firing live orders

  // ── Strategy brand colors (chart overlays) ────────────────────────────────────
  milkZones:   '#14b8a6',
  vector:      '#8b5cf6',
  footprint:   '#f97316',
};

export const Colors = {
  // light kept for hook compatibility (collapsible.tsx, use-theme-color.ts)
  light: {
    text: '#11181C',
    background: '#fff',
    tint: '#0a7ea4',
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: '#0a7ea4',
  },
  dark: {
    text:             Trading.text,
    background:       Trading.bg,
    tint:             Trading.accent,
    icon:             Trading.muted,
    tabIconDefault:   Trading.dim,
    tabIconSelected:  Trading.accent,
  },
};

// Tier metadata — single source of truth used across all screens
export const TIER = {
  safeplus:  { color: Trading.safeplus,  glyph: '◆', label: 'SAFE+',    labelFull: 'SAFE PLUS'  },
  safe:      { color: Trading.safe,      glyph: '◆', label: 'SAFE',     labelFull: 'SAFE'        },
  risky:     { color: Trading.risky,     glyph: '△', label: 'RISKY',    labelFull: 'RISKY'       },
  riskiest:  { color: Trading.riskiest,  glyph: '▽', label: 'RISKIEST', labelFull: 'RISKIEST'    },
} as const;

export type TierKey = keyof typeof TIER;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',   // SF Mono on iOS
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  },
});
