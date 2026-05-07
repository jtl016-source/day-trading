# Strategy: Vector Line (Highest Lowest HL20)

## Formula
`Highest( Lowest(low, 20), 20 )` on the current chart interval

## What It Represents
The vector is the highest level that the 20-bar lowest-low has reached over the last 20 bars.
It tracks the market's "floor of floors" — the highest point at which buyers have repeatedly
absorbed selling pressure. When price is above a rising vector, buyers are in control.

## Signal Gates
- **HARD GATE:** `close > vector` — price must be numerically above the vector value
- **SLOPE GATE:** `vector[now] >= vector[3 bars ago]` — vector must be flat or rising
  (a declining vector means buyers are losing ground; no Long entries)
- Entry on the NEXT bar after both conditions are met

## Why It Works
The vector acts as a dynamic support baseline. A rising vector with price above it means
recent lows are systematically higher — the definition of an uptrend at the micro level.

## Multi-Interval Vector System
All four intervals are shown simultaneously on every chart:
- **1m vector** — short-term momentum; fast-moving support
- **5m vector** — session structure; primary trading interval
- **15m vector** — intraday bias; overrides 5m on conflicting signals
- **60m vector** — macro bias; do not fight a declining 60m vector

## Secondary Vector Voting
Each secondary vector is forward-filled to the current chart's bar timestamps.
`secondaryVecOk = any(close > vector_value)` for any of the secondary intervals.
This gives +1 bonus toward the signal tier.

## How to Read Multi-Vector Confluence
- All 4 vectors below price AND rising → very strong Long confirmation
- 60m vector above price (declining) → skip Long entries, even if 5m looks good
- 1m vector crossing above (rising fast) → often leads the 5m vector higher soon

## Signal Rules

### Long Setups
For a LONG signal: look for a side entry or a tested tabletop off of a side entry.
A side entry is where price has moved horizontally into the zone before making its move.
A tested tabletop off a side entry is where price made the sideways move, tested that level again,
and is now pushing off it. These are the two setups where the Vector is most trustworthy for longs.

### Short Setups
For a SHORT signal: the Vector is not a strong confluence for shorts. It can confirm a short
but treat it with less conviction than a long. Always seek additional confirmation from the zone
and footprint before taking a Vector-confirmed short.

### Minimum Timeframe Confirmation
Only one timeframe needs to confirm for the Vector to count as a confirmation. If only one
timeframe is confirming, it must be the primary Vector on the timeframe being traded for it
to carry real weight. The more timeframes that agree the stronger the reading — but one
primary confirmation is sufficient.

## Vector Computation Rules
- Vector operates on both RTH and ETH candles
- The 20-bar window provides sufficient smoothing
- Flat/tabletopped vector with no retest = exhausted momentum, NOT a valid launch point

## Rules ML Must Never Violate
1. `close > vector` must be a numeric comparison, not a visual one
2. Slope check requires `vector[now] >= vector[3]` — flat is OK, declining is not
3. 60m vector declining → skip ALL Long signals regardless of lower-interval confirmation
4. Never use RTH-only filtering for vector computation itself
5. Vector is not a strong confluence for shorts — always seek additional confirmation
