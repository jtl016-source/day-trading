import { Platform } from 'react-native';

// ── MERIDIAN palette — dark HUD, teal accent over a near-black teal/violet flow ─
// Ported from the design source of truth (trading-terminal-mobile mockup):
//   bg #06070b · accent #2dd4bf · amber #ffb454 · up #1fd98a · down #ff4d6d
//   text #e9ebf1 · muted #7c8190
// Every screen reads these tokens, so repointing them re-skins the whole app.
export const Trading = {
  // Backgrounds (solid, slightly cool near-black — read well over the gradient bg)
  bg:          '#06070b',   // base
  surface:     '#0c0e13',   // card / panel bg
  surfaceAlt:  '#11141b',   // alternate card shade
  surfaceCard: '#151922',   // raised card
  panel:       '#0a0c11',   // panel overlay

  // Glass fills — translucent white, let the animated background show through
  glass:       'rgba(255,255,255,0.022)',
  glass2:      'rgba(255,255,255,0.04)',

  // Hairlines
  line:        'rgba(255,255,255,0.08)',
  lineSoft:    'rgba(255,255,255,0.045)',
  border:      'rgba(255,255,255,0.08)',
  borderDefault:'rgba(255,255,255,0.10)',
  borderAccent:'rgba(45,212,191,0.30)',

  // Text
  text:        '#e9ebf1',
  textSecondary:'#aeb4c0',
  muted:       '#7c8190',
  dim:         '#565b69',

  // Accent — teal
  accent:      '#2dd4bf',
  amber:       '#ffb454',

  // Direction
  long:        '#1fd98a',   // LONG = green
  short:       '#ff4d6d',   // SHORT = red

  // Legacy aliases (kept for chart-view + existing screens)
  green:       '#1fd98a',
  red:         '#ff4d6d',
  orange:      '#ffb454',
  purple:      '#a78bfa',
  gold:        '#ffd27a',

  // ── Tier system — color + glyph, never color alone (mockup TIER_C mapping) ────
  // SAFE+  ◆ green  #1fd98a
  // SAFE   ◆ teal   #2dd4bf
  // RISKY  △ amber  #ffb454
  // RISKIEST ▽ red  #ff4d6d
  safeplus:    '#1fd98a',
  safe:        '#2dd4bf',
  risky:       '#ffb454',
  riskiest:    '#ff4d6d',

  // ── Auto-trader arm states ────────────────────────────────────────────────────
  armOff:      '#7c8190',   // muted — off/idle
  armArmed:    '#ffb454',   // amber — connected, ready, not firing
  armLive:     '#1fd98a',   // green — firing live orders

  // ── Strategy brand colors (chart overlays) ────────────────────────────────────
  milkZones:   '#2dd4bf',
  vector:      '#a78bfa',
  footprint:   '#ffb454',
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

// ── Fonts — loaded via useFonts() in app/_layout.tsx (splash-gated) ───────────
// Display/labels = Chakra Petch · all numbers = IBM Plex Mono.
// The family strings equal the @expo-google-fonts export names once loaded.
export const Fonts = {
  sans:     'ChakraPetch_500Medium',
  display:  'ChakraPetch_600SemiBold',
  bold:     'ChakraPetch_700Bold',
  mono:     'IBMPlexMono_500Medium',
  monoBold: 'IBMPlexMono_600SemiBold',
  rounded:  'ChakraPetch_500Medium',
  serif:    Platform.select({ ios: 'ui-serif', web: "Georgia, 'Times New Roman', serif", default: 'serif' }),
};
