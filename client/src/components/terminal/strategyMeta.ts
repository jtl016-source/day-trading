// strategyMeta.ts — confirmation-strategy metadata for the Strategies dropdown, the Market
// view's "active strategies" strip, and the Info tab. SINGLE-TIER: Pattern removed (no real
// module). `desc`/`stat` drive the compact UI; `title`/`how`/`signals`/`tips` drive the Info tab.
import type { StrategyToggles } from "@/lib/terminalSettings";

export interface StrategyMeta {
  key: keyof StrategyToggles;
  desc: string;            // one-liner (dropdown / strip)
  stat: string;            // win-rate chip
  title: string;           // Info-tab heading
  tagline: string;         // Info-tab sub-heading
  how: string[];           // "how it works / how it's used" paragraphs
  signals: string;         // what a confirming read looks like
  tips: string[];          // practical do/don't bullets
}

export const STRATS: StrategyMeta[] = [
  {
    key: "MilkZone",
    desc: "Supply / demand liquidity zones",
    stat: "68% win",
    title: "MilkZone",
    tagline: "Liquidity supply/demand zones (Milk Yellow Box)",
    how: [
      "MilkZones are horizontal supply/demand bands — the Milk Yellow Box levels built from fair-value gaps, order blocks, and structural pivots. They mark where price previously left an imbalance and is likely to react again.",
      "On this terminal, MilkZones are NEVER fabricated. They only appear after you upload a chart screenshot (Strategies → MilkZone → Upload Zone Picture); the server parses the boxes from the image and pins them to price. No upload means no zones, so the strategy can't fire on invented levels.",
      "A signal gains MilkZone confluence when the entry candle is reacting inside (or off the edge of) one of your uploaded zones — buying demand at a green zone, selling supply at a red zone.",
    ],
    signals: "Confluence fires when a closed candle prints inside an active uploaded zone in the trade's direction (price holding the zone edge), within the most recent zones.",
    tips: [
      "Upload fresh zones for the day — stale levels from another session aren't valid.",
      "Strongest when the zone lines up with the Vector direction and a Footprint imbalance.",
      "A zone is 'spent' once price has traded cleanly through it; expect less reaction the second time.",
    ],
  },
  {
    key: "Vector",
    desc: "Directional momentum confirmation",
    stat: "61% win",
    title: "Vector",
    tagline: "Trend / momentum line — Highest(Lowest(low,20),20)",
    how: [
      "The Vector is a trailing momentum line: the highest value over 20 bars of the 20-bar lowest-low. It rises in uptrends and flattens/falls when momentum stalls — a clean read of which side controls the tape.",
      "It is a HARD prerequisite for every confluence signal: longs require price above a rising vector, shorts require price below a falling one. Multi-timeframe vectors (1m/5m/15m/60m) are drawn at once so you can see when the higher timeframe agrees.",
      "Two entry shapes are recognized: a 'tabletop' (price coils flat on the vector then continues) and a 'side-entry' (price pulls back to the flat vector and resumes).",
    ],
    signals: "Confirms when the candle closes on the correct side of the current-interval vector AND the higher-timeframe vector isn't pointing against the trade (e.g. a falling 60m vector vetoes longs).",
    tips: [
      "Don't fade a steeply rising/falling vector — it's a momentum filter, not a reversal signal.",
      "Flat vector + zone reaction = the highest-quality continuation entries.",
      "Watch the 60m vector: it can veto an otherwise-clean lower-timeframe setup.",
    ],
  },
  {
    key: "Probability",
    desc: "Fractal regime / value-area context",
    stat: "regime read",
    title: "Probability",
    tagline: "Fractal regime, value area & Hurst target scaling (MERIDIAN probability concept)",
    how: [
      "The Probability panel reads the market's CHARACTER, not a single entry. A rolling DFA-Hurst exponent (H) classifies the regime: H ≥ 0.55 = PERSISTENT/trending (moves extend), H ≤ 0.45 = MEAN-REVERT/chop (moves fade), in between = NEUTRAL/near random-walk. Each regime carries the historical win-rate and profit-factor measured on thousands of real MES signals.",
      "A long-run VALUE AREA (POC / VAH / VAL over the last ~500 bars) shows where price sits in its realized distribution — inside value (fair), above value (extended high, reversion risk), or below value (extended low). The Hurst TARGET SCALER then says whether fBm scaling justifies tighter or wider targets than the random-walk √τ baseline, and a MULTIFRACTAL STRESS gauge flags when the tape is more turbulent than its own recent norm.",
      "This layer is DISPLAY-ONLY context — a regime filter and macro read. It never fires or vetoes a trade on its own; use it to size and frame the confluence signals the other strategies produce.",
    ],
    signals: "There is no 'fire' here. Read it as context: trend-follow and let targets run in a PERSISTENT regime inside value; fade extremes and tighten targets in a MEAN-REVERT regime stretched above/below value; stand down when stress is high.",
    tips: [
      "Hurst lags by ~half its window — it confirms a regime that already began; never treat an H crossing as an entry.",
      "Strongest framing: a confluence signal that AGREES with the regime (long in PERSISTENT, fade in MEAN-REVERT) and isn't fighting the value area.",
      "High multifractal stress = unstable scaling; expect wider noise and treat target projections with caution.",
    ],
  },
  {
    key: "Footprint",
    desc: "Order-flow bid / ask delta",
    stat: "72% win",
    title: "Footprint",
    tagline: "Order-flow bid/ask delta & imbalance (real MW Volume Imprint)",
    how: [
      "The Footprint shows REAL traded volume at each price — bid (sell-side) vs ask (buy-side) — from MotiveWave's Volume Imprint, aggregated per session into the on-chart ladder anchored at the session's first candle.",
      "A price level is 'imbalanced' when one side outpaces the other (ask/bid ≥ 1.3 with net ≥ 100). Two or more stacked imbalanced levels in a row = a strong initiative move and print as colored zones (green = buying, red = selling) sized to the imbalance.",
      "POC (point of control) is the highest-volume price; VAH/VAL bracket the 70% value area. These act as magnets and fade levels.",
    ],
    signals: "Confirms when order flow agrees with the trade — stacked ask imbalance / positive delta for longs, stacked bid imbalance / negative delta for shorts — and isn't being absorbed against you.",
    tips: [
      "Stacked imbalance zones are the levels to watch for continuation or rejection.",
      "Price returning to an unmitigated imbalance zone often reacts; the zone fades once a candle closes through its midpoint.",
      "Delta disagreeing with price (price up, delta negative) warns of absorption — a possible reversal.",
    ],
  },
];

// How signals actually fire — shown as an overview block on the Info tab.
export const SIGNAL_OVERVIEW = {
  title: "How signals fire",
  points: [
    "SINGLE-TIER: every fired signal is a 'SAFE' setup — the engine only publishes its highest-quality confluence trades, it does not grade them into risky/riskiest tiers.",
    "Confirmations: a signal needs the enabled strategies to AGREE on a closed candle. The Vector is always required; MilkZone and Footprint add confluence. The 'Confirmations required' setting controls how many must align.",
    "Closed-candle only: signals evaluate on completed bars, not the forming candle, so they don't repaint.",
    "Exits: each signal carries an entry, stop, TP1 and TP2 from the active Exit profile — Tight (smaller stop, aggressive targets), Standard (balanced), or Wide (swing-style). TP1 can partial out with breakeven on the runner.",
    "Sessions: RTH = 9:30–16:00 ET; everything else is ETH. Signals respect the session filter and the engine's HOD/LOD guards.",
  ],
};
