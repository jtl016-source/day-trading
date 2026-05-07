# Footprint Strategy

## Overview
Footprint is the fourth and most granular confirmation layer in this trading
system. While MilkZones identify WHERE price should react and the Vector
identifies the directional momentum BEHIND the move, Footprint confirms
WHETHER the actual order flow at the tick level is supporting the trade in
real time. It is the difference between a signal that looks right on a candle
chart and a signal that has institutional order flow actively confirming it.

Footprint is the strongest confluence in the entire system. It can fire as a
standalone signal — though it is strongly recommended to pair it with at least
one other confirmation for the highest quality trades.

Footprint reads the full bid/ask volume at every price level inside each
candle using MotiveWave tick data. It sees what no standard candlestick can
show — how many contracts were bought aggressively versus sold aggressively
at each individual price, who is absorbing whom, and whether the move has
genuine participation or is a false push about to reverse.

Operates on both RTH and ETH candles.

## Core Concepts

### Delta
Delta = Ask Volume minus Bid Volume at any price level or candle.
Positive delta = more aggressive buying than selling at that level.
Negative delta = more aggressive selling than buying at that level.
Delta must AGREE with the signal direction to count as a confirmation:
  - LONG signal: delta must be strictly positive (> 0)
  - SHORT signal: delta must be strictly negative (< 0)

### Absorption
Absorption occurs when large volume trades at a price level but price
does not move through it. It means hidden limit orders (institutions) are
absorbing every market order thrown at them.
  - Bullish absorption: heavy sell volume hits a support level but price
    holds or bounces — buyers are absorbing all the selling
  - Bearish absorption: heavy buy volume hits a resistance level but price
    holds or rejects — sellers are absorbing all the buying
Absorption at a MilkZone is the single strongest confluence event in this
entire system. When the zone fires AND footprint shows absorption in the
zone's direction, the signal quality is maximum.

### Imbalance
An imbalance occurs when one side of the market trades at least 3x more
contracts than the other at a single price level.
  - Buy imbalance (ask >> bid): aggressive buyers dominating that level
  - Sell imbalance (bid >> ask): aggressive sellers dominating that level
Stacked imbalances — 3 or more consecutive price levels with imbalances
in the same direction — signal sustained institutional aggression and
strongly confirm trend continuation or breakout.

### Delta Divergence (Veto Gate)
Delta divergence occurs when price makes a new high/low but delta fails
to confirm it — meaning the aggression behind the move is fading.
  - Price makes new high + delta lower than prior high = buyer exhaustion
  - Price makes new low + delta higher (less negative) than prior low = seller exhaustion
Delta divergence is a VETO signal. This veto gate runs BEFORE any confirmation
conditions are checked. If divergence is detected at entry, the footprint
confirmation is denied and the signal is suppressed entirely regardless of
other conditions. It does not matter how strong the zone or vector looks —
divergence means the move has no real fuel behind it.

### Unfinished Auction
An unfinished auction occurs at the high or low of a candle when only
one side of the market traded at that extreme price — meaning the market
left without completing the auction. Price will typically return to finish
that auction. Unfinished auctions above current price act as magnets for
longs. Unfinished auctions below act as magnets for shorts. They refine
the take profit targets in the exit strategy.

### Point of Control (POC)
The POC is the price level inside a candle where the most total volume
traded. It represents the fairest price both sides agreed on. POC levels
from recent candles act as near-term support/resistance and are used to
refine stop loss placement — stops should be placed just beyond the POC
of the signal candle, not just beyond the candle high/low.

### Trapped Traders
Trapped traders are participants who entered on the wrong side and are
now in a losing position. They are forced to exit when price moves against
them, which accelerates the move in the signal direction.
  - Trapped longs: heavy buying volume at a high that fails to break —
    those buyers are now underwater and will sell into any bounce
  - Trapped shorts: heavy selling at a low that fails to break —
    those sellers are now underwater and will buy into any dip
Footprint identifies trapped traders by finding large one-sided volume
at extremes that price subsequently rejected.

## Footprint Confirmation Rules
For Footprint to count as a confirmed confirmation, the veto gate and
all conditions below must pass on the signal candle (closed candle):

  VETO GATE — Delta divergence (runs first, before conditions):
    The signal candle must NOT show delta divergence against its
    direction vs the prior 3 candles. If price is at a new high but
    delta is lower than all 3 prior candles, divergence is present.
    Divergence = automatic VETO — signal suppressed entirely regardless
    of what zone or vector say. This is not a condition to pass; it is
    a hard stop that runs before anything else is evaluated.

  CONDITION 1 — Delta must be confirmed, not trending toward:
    LONG signal: candleDelta must be > 0 (strictly positive)
    SHORT signal: candleDelta must be < 0 (strictly negative)
    A delta of exactly zero does not confirm either direction.
    A delta that is "turning positive" or "almost positive" does NOT
    qualify. The number must already be on the correct side of zero.

  CONDITION 2 — At least one of the following bonus signals present:
    a. Absorption detected at or within 2 ticks of the zone boundary
    b. Stacked imbalances (3+ consecutive levels) in signal direction
    c. Trapped traders detected at the candle's opposing extreme
    d. Unfinished auction in signal direction within last 3 candles

  If CONDITION 1 passes but CONDITION 2 has none of a/b/c/d,
  footprint counts as PARTIAL confirmation (not full). A partial footprint
  confirmation holds the signal at its current tier — it does not upgrade
  or downgrade it.

  If both conditions pass → FULL footprint confirmation → eligible
  for higher tier based on what other confirmations are present.

## Signal Tier Integration

  SAFE (highest quality):
    MilkZone confirms AND Vector confirms AND Footprint FULL confirms
    Pattern confluence present → log as bonus note in details panel

  SAFE (degraded):
    MilkZone confirms AND Vector confirms but Footprint is PARTIAL
    → Signal fires as SAFE but details panel shows:
    "⚠ Footprint partial — delta agrees but no absorption/imbalance/trap detected"

  RISKY:
    Any two of the three primary confirmations (Zone, Vector, Footprint FULL)
    Pattern + one primary confirmation also qualifies as RISKY

  Standalone footprint tier rules:
    Footprint FULL confirmation alone (no zone, no vector) → RISKY tier
    Footprint FULL + one other primary → RISKY (stronger)
    Footprint FULL + zone + vector → SAFE
    Footprint vetoed → signal suppressed entirely regardless of other confirmations

  RISKIEST:
    One primary confirmation only (non-footprint), OR pattern alone at low confidence

  VETO (signal suppressed entirely):
    Footprint detects delta divergence on the signal candle regardless
    of what zone or vector say → signal is suppressed, not fired
    Details panel logs: "✗ Signal vetoed — footprint delta divergence detected"
    The zone and vector confirmation is still logged for the Learn engine
    but no signal is emitted and no trade is taken

## Standalone Signal Note
Footprint is the strongest single confluence in the system. A full footprint
reading with absorption, stacked imbalances, and strong delta carries more weight
than any other single confirmation. However, pairing it with even one zone or
vector confirmation significantly increases reliability. Trade footprint-alone
signals with appropriate sizing and always respect the delta rule strictly — it
must be positive for longs and negative for shorts, no exceptions.

## Exit Strategy Enhancements
Footprint data refines the exit strategy in the following ways:

  STOP LOSS:
    Default: place stop just beyond the signal candle high/low
    Footprint enhancement: place stop just beyond the POC of the signal
    candle instead of the full candle extreme. POC is where the most
    business was done — if price returns through that level the trade
    thesis is invalid. This tightens the stop and improves R:R.
    Only apply POC stop when POC is within 60% of the candle range from
    the entry side. If POC is too far from entry, use the default stop.

  TAKE PROFIT 1 (TP1):
    Default: next opposing zone or fixed R:R target
    Footprint enhancement: if an unfinished auction exists between entry
    and the default TP1, set TP1 at the unfinished auction level — price
    is magnetically drawn to complete that auction first.

  TAKE PROFIT 2 (TP2):
    Default: second opposing zone or extended R:R
    Footprint enhancement: if stacked imbalances were detected in the
    signal direction, extend TP2 by 20% — stacked imbalances signal
    institutional momentum that typically carries further than normal.

  TRAILING STOP:
    When the trade is active and a new candle closes with delta divergence
    against the trade direction, tighten the trailing stop to the current
    candle's POC. Divergence mid-trade means fuel is running out —
    protect the profit aggressively.

## What the Learning Engine Should Watch
  - Did footprint correctly identify absorption at the zone?
  - Did delta divergence vetoes prevent losses? Track the veto accuracy.
  - How often did stacked imbalances lead to TP2 being hit vs TP1?
  - Did trapped trader signals lead to faster moves toward target?
  - How accurate were unfinished auction TP1 targets?
  - When SAFE (degraded) fired vs SAFE (full), what was the win rate difference?
  - Did POC stops perform better than default candle-extreme stops?
  - How did footprint-alone signals perform vs footprint + zone/vector?
  - Were ETH footprint readings as reliable as RTH readings?

## Visual Implementation

The footprint chart renders per-candle bid×ask volume directly inside each
candlestick on the main price chart. It is activated via the FP button in
the toolbar and renders over the last 2 days of candles only (older candles
are intentionally excluded — footprint text is only legible when zoomed in).

### Source Code
  - Analysis logic: client/src/lib/footprint-analysis.ts
    buildProxyFootprintCandle()  — synthesizes per-level bid/ask from OHLCV
    buildCandleFootprints()      — builds Map<timestamp, FootprintCandle> for all candles
    analyzeFootprint()           — evaluates delta, absorption, imbalances for signal tier
  - Rendering: client/src/components/CandlestickChart.tsx (drawAll → per-candle section)
  - Data flow: market.tsx → candleFootprintMap useMemo → CandlestickChart candleFootprints prop

### Per-Candle Rendering
Each candle that has footprint data renders a vertical stack of rows at
0.25-tick (one row per price level). The chart must be zoomed in to at least
~150 visible candles or fewer for the renderer to activate (performance guard).

Row layout for each price level:
  Left half:  bid volume (contracts sold aggressively at this level)
  Right half: ask volume (contracts bought aggressively at this level)
  Far right:  imbalance ratio badge (e.g. "3.2×") in bold — only when imbalanced

### Row Color Coding
  Purple  (50% opacity)  — Point of Control (POC): highest volume level in the candle
  Green   (50% opacity)  — Stacked buy imbalance: 3+ consecutive buy-dominant levels
  Red     (50% opacity)  — Stacked sell imbalance: 3+ consecutive sell-dominant levels
  Green   (28% opacity)  — Single buy imbalance: ask >= 3× bid at this level
  Red     (28% opacity)  — Single sell imbalance: bid >= 3× ask at this level
  Faint   (8% opacity)   — Value area (VAH to VAL, 70% of session volume)
  White   (10% opacity)  — Column background on all rows (makes text readable)

### Imbalance Ratio Badge
Appears to the right inside each imbalanced row when the candle is at least
40px wide (requires zoom). Shows the ratio of dominant side to dominated side:
  Buy imbalance:  "3.2×" in solid green  — ask dominated bid by 3.2×
  Sell imbalance: "3.2×" in solid red    — bid dominated ask by 3.2×

### Text Colors
  Bid volume on buy-imbalanced row:  #ef5350 (red)
  Ask volume on buy-imbalanced row:  #26c87a (green)
  Bid volume on sell-imbalanced row: #ef5350 (red)
  Ask volume on sell-imbalanced row: #26c87a (green)
  POC row text:  #c084fc (purple)
  Neutral rows:  #94a3b8 (slate, readable over white background)

### Session Boundary Lines
Dashed vertical lines mark session transitions:
  Blue  dashed — RTH open  (9:30 AM ET / 13:30 UTC) labeled "RTH"
  Indigo dashed — RTH close (4:30 PM ET / 20:30 UTC) labeled "ETH"

### ETH Dimming
All candles outside Regular Trading Hours render at 70% opacity so the
RTH session footprint data stands out visually.

### Proxy Footprint (No Live MotiveWave Data)
When MotiveWave is not streaming real tick data, bid/ask volumes are
synthesized from OHLCV using buildProxyFootprintCandle():
  - Up candles: ask volume dominates lower in the body, bid dominates upper
  - Down candles: bid volume dominates upper in the body, ask dominates lower
  - Wicks are assumed to be 100% absorbed (opposite side absorbed all aggression)
  - Ratio varies linearly by position within the body (not a uniform 65/35 split)
This is a reasonable approximation for visual reference but is not as precise
as real per-level tick data from MotiveWave.
