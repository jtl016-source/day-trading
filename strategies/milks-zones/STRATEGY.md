# Strategy: Milk Yellow Box Zones

## What It Is
A "Milk zone" is a price level derived from the PREVIOUS day's order flow data that
predicts where institutional activity will matter for the COMING day. Milk reads
yesterday's order flow in MotiveWave and maps zones at 9:30 AM ET before the market
opens — these zones are then placed on the chart as FUTURE levels that price has not
yet reached.

**Source:** Real zones extracted from MotiveWave MWML files (29,583 zones, 2023–2026)  
**ML pipeline:** `ml/zone_classifier.py` — extract → features → train (RandomForest)

## How Zones Are Used — Forward-Looking Decision Points

Zones are NOT reactive. You do NOT draw them after price moves. You place them before
the open and then watch price travel toward them. The mental model is:

> "Price is here now. There is a Support Zone 12 points below. If price drops into it,
> I look for a long signal. There is a Resistance Zone 8 points above. If price rallies
> into it, I look for a short or reduce longs."

Every zone on the chart represents a pre-committed decision: **what to do IF price
reaches this level**. The zone is a hypothesis formed from yesterday's data. Today's
price action either confirms it or invalidates it. Either outcome is information.

## Zones Are Pre-Market — Immutable Once Set

All zones for the day are mapped from the prior day's order flow and committed before
9:30 AM ET. Once RTH opens they are locked.

**Hard rules:**
- Zones are placed before the first RTH candle closes — they exist AHEAD of price
- No zone may be moved, adjusted, extended, shrunk, or removed during the session
- No new zones added mid-session to "adapt" — that is hindsight, not prediction
- If price blows through a zone without reacting, the zone is simply wrong for today —
  it expires naturally via `to_ts` and is logged as a miss for the learning engine
- A zone repositioned after price has already moved there is invalid data and must
  never be used for signal generation or learning engine training

## Zone Types
- **Support Zone:** `is_bull = true` — predicted level below current price where buyers are expected to step in; "if price drops here, look long"
- **Resistance Zone:** `is_bull = false` — predicted level above current price where sellers are expected to step in; "if price rallies here, look short or reduce longs"

## milkOk Condition (price-based, NOT time-based)
```
milkOk = TRUE when ALL of:
  1. candle is during RTH (13:30–20:30 UTC Mon-Fri)
  2. zone is active: candle.time ∈ [zone.from_ts, zone.to_ts]
  3. candle.low  ≤ zone.top    + 2.0 pts  (price is inside or has broke through a zone on a CLOSED candle)
  4. candle.close ≥ zone.bottom - 2.0 pts  (price held above zone bottom — bounce pattern)
```

## What "milkOk" Means Economically
The candle tested the Support Zone (low reached the zone or broke through it) AND closed back above the zone
bottom — this is the "zone test and hold" pattern. It confirms the zone is still active
as a support level and buyers stepped in.

## Why Price Check Matters (vs Time Check)
A time-only check (`candle.time ∈ [zone.from_ts, zone.to_ts]`) marks every candle in the
time window as "in the milk zone" even if price is 50 pts above or below the zone level.
This is observational bias. The price-based check compares `candle.low` and `candle.close`
(numbers) to `zone.top` and `zone.bottom` (numbers) — fully quantitative.

## Resistance Proximity Downgrade
If a Resistance Zone's bottom is within 5.0 pts above entry → downgrade one tier.
Overhead supply limits upside potential and increases risk of rejection.

## Zone Lifetime
Zones persist from their `from_ts` to `to_ts` as extracted from MWML files. A zone
formed on March 29 can remain valid through April 2 if it was never invalidated.
Zones do NOT reset every day — they represent actual structural price levels.

The `to_ts` boundary is set at zone creation time (pre-market). It does NOT move.
If a zone's `to_ts` is 17:00 ET on the day it was drawn, it expires at that time
exactly as intended — it is not extended because price "kept respecting it."

## Rules ML Must Never Violate
1. Always compare prices to prices — NEVER compare visual positions
2. milkOk requires price IN the zone (close within zone top±2pts, low ≤ zone top)
3. Resistance Zone within 5 pts above entry → mandatory tier downgrade
4. Zone is inactive outside [from_ts, to_ts] window — do not apply it
5. Zones are mapped pre-market and are IMMUTABLE once RTH opens — never adjust mid-day
6. A zone that was repositioned after price moved is invalid data — exclude from learning
7. All zones for the day must be committed by 9:30 AM ET — no mid-session additions
