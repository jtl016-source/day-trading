// strategyMeta.ts — confirmation-strategy metadata for the Strategies dropdown, the Market
// view's "active strategies" strip, and the Info tab. SINGLE-TIER: Pattern removed (no real
// module). `desc`/`stat` drive the compact UI; `title`/`how`/`signals`/`tips` drive the Info tab.
import type { StrategyToggles } from "@/lib/terminalSettings";

export interface StrategyMeta {
  key: keyof StrategyToggles;
  name?: string;           // dropdown display name (defaults to the key)
  group: StratGroupId;     // dropdown section (2026-08-10 declutter): core | facts | display
  desc: string;            // one-liner (dropdown / strip)
  stat: string;            // win-rate chip
  title: string;           // Info-tab heading
  tagline: string;         // Info-tab sub-heading
  how: string[];           // "how it works / how it's used" paragraphs
  signals: string;         // what a confirming read looks like
  tips: string[];          // practical do/don't bullets
}

export type StratGroupId = "core" | "facts" | "display";
/** Dropdown sections, in render order — signal strategies, corroborator-only facts, then
 *  display-only context layers. Grouping is presentation only; STRATS stays the single source. */
export const STRAT_GROUPS: { id: StratGroupId; label: string }[] = [
  { id: "core", label: "Signal Strategies" },
  { id: "facts", label: "Confirmation Facts" },
  { id: "display", label: "Display Overlays" },
];

export const STRATS: StrategyMeta[] = [
  {
    key: "MilkZone",
    group: "core",
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
    key: "YellowBox",
    group: "core",
    desc: "Daily volatility box + init S/R levels",
    stat: "confluence fact",
    title: "Yellow Box",
    tagline: "Milk's daily Yellow Box — settle ± mean 60m extension over 50 trading days",
    how: [
      "The Yellow Box is Milk's daily volatility envelope: bottom = prior settle − mean(open−low), top = prior settle + mean(high−open), measured over every 60m bar of the last 50 trading days. It is derived walk-forward for EVERY trading day (only bars before that day's session), so historical boxes are exactly what you would have had pre-open.",
      "Each day also carries its initial resistance (p33 of the 50-day daily up-extension) and initial support (p43.5 of the down-extension) — Milk's first-target levels, drawn as thin dashed red/green lines across the session.",
      "A confirmation candle CLOSING outside the box (above the top = bullish, below the bottom = bearish) is a directional fact that counts toward confluence in the signal engine, RTH only. When it participates in a fired signal, that day's init res/sup anchors TP1.",
    ],
    signals: "Confluence fires when an RTH candle closes outside the day's box in the trade's direction. Solo box-breaks are gated OFF by default (full-history backtest PF 0.80–0.89 solo — negative EV; it earns its keep as a confluence fact, not a standalone trigger).",
    tips: [
      "Boxes span the full Globex session (prior day 6:00 PM ET → 5:00 PM ET) and appear on every trading day automatically — no upload needed.",
      "Price opening inside the box and breaking out with vector agreement is the highest-quality read.",
      "Init res/sup are first targets, not reversal calls — expect reaction, not necessarily rejection.",
    ],
  },
  {
    key: "CloseEst",
    group: "display",
    name: "Close Estimate",
    desc: "EOD close-magnet zone + open-line target",
    stat: "display only",
    title: "Close Estimate",
    tagline: "End-of-day close-estimate zone (Fractal Exchange 'END OF DAY CLOSE VALUES' method, 2026-08-09 study session)",
    how: [
      "Green days close BELOW their high by a repeatable average, and red days close ABOVE their low by one. This layer measures both averages over the last 60 sessions of spike-filtered 5m data (mean HOD − 16:00 close on green days; mean 16:00 close − LOD on red days) and projects today's estimated close from the RUNNING session extremes: est close-high = today's HOD − the green-day average, est close-low = today's LOD + the red-day average. Whenever a new session high or low prints, the estimate reruns automatically.",
      "When the two independent estimates land close together they form the CLOSE-MAGNET ZONE — drawn as the amber band between the dashed EST CL▲ and EST CL▼ lines. Price tends to be pulled toward this zone through the afternoon (their ~2:00 PM ET checkpoint is when it usually locks in). The solid blue OPEN line is the day's RTH open — the method's reversion target: as price approaches or passes the open line into the close, the reversion trade is realized.",
      "This layer is DISPLAY-ONLY context, like the Probability layer: it never fires or vetoes a signal. The zone derives from running session extremes that no backtest can mirror, so by design it stays out of the engine.",
    ],
    signals: "There is no 'fire' here. Read it as an afternoon magnet: price stretched far above the zone late in the day tends to fade toward it (and toward the open line); a tight zone (estimates within a point or two) is the strongest read.",
    tips: [
      "The estimates only mean something once the day's HOD/LOD have formed and been tested — treat ~2:00 PM ET as the lock-in checkpoint, per the source method.",
      "A full-body candle day (no wick on the leading side) tends to close AT its extreme — expect the estimate to chase the extreme rather than fade.",
      "The zone pairs with the Yellow Box: a close-magnet zone sitting on a box edge or init level is a natural afternoon target confluence.",
    ],
  },
  {
    key: "Vector",
    group: "core",
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
    group: "display",
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
    key: "ICT",
    group: "facts",
    name: "ICT Confirmations",
    desc: "Confirmation facts — not a standalone strategy",
    stat: "confirmation fact",
    title: "ICT Confirmations",
    tagline: "Liquidity sweeps, order blocks, breakers & fair value gaps as extra agreeing facts",
    how: [
      "ICT (Inner Circle Trader) concepts read where the market hunts liquidity: a SWEEP wicks through a resting level (prior-day high/low, session high/low, an old swing) and snaps back; an ORDER BLOCK is the last opposite candle before a displacement move; a BREAKER is a failed order block traded from the other side; a FAIR VALUE GAP is a 3-candle imbalance that price tends to revisit.",
      "On this terminal these are CONFIRMATION FACTS ONLY — they never fire a signal by themselves. When one of your existing strategies produces a signal (a Yellow Box break, a vector side-entry, a Milk zone reaction), an agreeing ICT read counts as one more independent fact toward the confluence requirement. If ICT and the fractal read agree with a Yellow Box break, that's three facts — enough to fire.",
      "Facts are detected on the chart's own interval during market hours only, and each one names its level and the ICT kill zone it happened in (e.g. NY-AM).",
    ],
    signals: "A signal's fact list shows entries like ICT Sweep(@6795.00, NY-AM) or ICT Breaker(@6801.25) — meaning that ICT concept agreed with the trade's direction on the same bar.",
    tips: [
      "Leave it ON — it only ever adds agreeing evidence or argues against a bad breakout; it cannot fire alone.",
      "A sweep + reclaim in your direction right at entry is the strongest ICT read.",
      "Disagreeing ICT facts weigh against a marginal signal — that suppression is deliberate.",
    ],
  },
  {
    key: "Fractal",
    group: "facts",
    name: "Fractal Confirmations",
    desc: "Confirmation facts — not a standalone strategy",
    stat: "confirmation fact",
    title: "Fractal Confirmations",
    tagline: "Williams fractals, chaos bands & the chaos oscillator as extra agreeing facts",
    how: [
      "Bill Williams fractals mark confirmed 5-bar pivot highs/lows. A close beyond the most recent confirmed fractal is a FRACTAL BREAKOUT; the stepped lines tracking the latest fractal high/low are the CHAOS BANDS; the CHAOS OSCILLATOR (FCO) measures how much of the recent churn was actual directional progress, from -1 to +1.",
      "Like ICT, these are CONFIRMATION FACTS ONLY — never standalone signals. A fractal breakout in your direction (within the last 5 bars), a close outside the chaos band, or a trending FCO (|FCO| ≥ 0.6) each add one agreeing fact to a signal your existing strategies produced.",
      "CHOP protection: when the chaos bands are flat with price boxed inside, or |FCO| ≤ 0.25, the tape is chopping — that state actively argues AGAINST breakout-style signals (Yellow Box breaks, side-entries) and can suppress a marginal one. Reversal-style zone reactions are unaffected.",
    ],
    signals: "A signal's fact list shows entries like Fractal(breakout↑ @6798.50) or FCO(+0.71 trending) — the fractal read agreed with the trade's direction on that bar.",
    tips: [
      "Leave it ON — it confirms good breakouts and vetoes breakouts fired into chop.",
      "A fresh fractal breakout + trending FCO alongside a Yellow Box break is the textbook stack.",
      "If a breakout signal vanishes in a flat range, the chop rule likely suppressed it — by design.",
    ],
  },
  {
    key: "FractalGeo",
    group: "facts",
    name: "Fractal Geometry Confirmations",
    desc: "Confirmation facts — not a standalone strategy",
    stat: "confirmation fact",
    title: "Fractal Geometry Confirmations",
    tagline: "Vector reclaims, flat-vector bounces, compression breaks & wave measurements as extra agreeing facts",
    how: [
      "These reads come from the Fractal Exchange guides, translated into mechanical checks against the vector line. A VECTOR RECLAIM is a failed break that snaps back across the vector (the guides' counter-trend reversal / 'ghost' pattern). A FLAT-VECTOR BOUNCE is price testing a flattened vector and holding (their 'side exit' / 'table top' setups). A COMPRESSION BREAKOUT is three or more progressively shallower pullbacks resolving with a range break. A CROSS OF YESTERDAY'S CLOSES is a close pushing through both of the prior day's closing levels (the 4 PM cash close and the 5 PM futures close — the lines drawn nightly on the reference charts).",
      "The WAVE MEASUREMENT compares the current move away from the vector against the sizes of previous moves: smaller than the usual move = room to run (an agreeing fact); stretched beyond ~80% of past moves = exhausted, which actively argues AGAINST entering in that direction — as does a VECTOR CHASE, when the vector is adjusting one way while price runs the other (price tends to get pulled back to it).",
      "Like the ICT and Fractal reads, these are CONFIRMATION FACTS ONLY — they never fire a signal by themselves and only apply during market hours on the chart's own interval.",
    ],
    signals: "A signal's fact list shows entries like FG Reclaim(↑ vector), FG Compression(release↑), FG WaveRoom(4.2 < med 7.5) or FG PriorClose(cross↑ E@6795.25 S@6791.00) — that read agreed with the trade's direction.",
    tips: [
      "Leave it ON — reclaims and flat-vector bounces confirm exactly the setups the guides trade.",
      "When a signal disappears near the top of a big run, the wave-exhaustion rule likely suppressed it — buying an over-stretched move is the guides' core don't.",
      "The yesterday's-closes cross pairs naturally with a Yellow Box break in the same direction.",
    ],
  },
  {
    key: "Footprint",
    group: "core",
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
