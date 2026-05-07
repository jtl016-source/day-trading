# Strategy: Pattern Recognition

## Overview
Pattern recognition provides supplementary (bonus) evidence for entries. Patterns alone
are generally not sufficient for a Safe signal — they add conviction when combined with
zone or vector confirmation. However, at sufficiently high confidence, Pattern Recognition
CAN fire as a standalone signal (see Standalone Signal Rules below).

Operates on both RTH and ETH candles.

---

## Pattern 1: Delta Imbalance Zones

### What They Are
Candles where volume was dominated by one side (buyers or sellers) in the last 20 bars,
more than 1.5× the 20-bar average imbalance.

### How to Use Them
These zones act as short-term support (buyer-heavy) or resistance (seller-heavy). They are
NOT Milk zones — they are derived from volume data in the DB.

### Signal Use
- Buyer-heavy delta imbalance below current price → supports Long entry
- Seller-heavy delta imbalance above current price → confirms resistance / downgrade

---

## Pattern 2: Fractal Liquidity Sweep (FLS)

### Pattern Description
5-bar fractal swing point where a wick briefly breaks the fractal high/low then closes
BACK inside the prior range — a "sweep and close back" rejection.

### Conditions
1. Identify a 5-bar fractal swing high (bearish sweep) or low (bullish sweep)
2. A later candle's wick breaks through the fractal point
3. That candle CLOSES back inside the prior range (rejection, not continuation)
4. The current-interval vector agrees with the sweep direction

### Candle Lookback Window
Pattern analysis uses a 5-10 candle lookback window for fractal and imbalance detection.

### Why It Works
Fractal sweeps represent stop-hunts where institutional traders trigger retail stop orders
to fill their own position at a better price. After the sweep, price typically reverses sharply.

### Signal Use
- FLS confirmed → adds +1 pattern bonus to signal tier
- Requires vector agreement — do not trade FLS against declining vector

---

## Pattern 3: Body Confirmation

### What It Is
`bodyOk = close > open` — the candle closed bullish (body confirmation).

### Signal Use
- bodyOk = true → +1 bonus toward signal tier
- Used as a bonus component, NEVER as a hard gate
- A bearish candle can still produce a valid Risky or Safe signal if zone + vector confirm

---

## Standalone Signal Rules

Pattern Recognition CAN fire as a standalone signal if the confidence level is strong enough.
A standalone pattern signal requires a very high occurrence count and a win rate significantly
above the minimum threshold. The system uses confidence scoring to determine whether the pattern
is strong enough to stand alone. A standalone pattern signal at sufficient confidence fires as
a RISKY signal.

Requirements for standalone firing:
- Minimum occurrences: 25 historical instances of this exact pattern
- Minimum win rate: 72% across those occurrences
- Confidence classification must be HIGH

---

## Signal Tier Role

| Scenario | Tier |
|----------|------|
| Pattern alone at high confidence (≥25 occurrences, ≥72% win rate) | RISKY |
| Pattern alone at low/medium confidence | RISKIEST |
| Pattern + one primary confirmation (zone or vector) | RISKY |
| Pattern + zone + vector | SAFE with confluence note |

---

## Tier Contribution Rules (as bonus components)
| Pattern | Condition | Tier Contribution |
|---------|-----------|-------------------|
| Body confirmation | `close > open` | +1 bonus |
| Secondary vector alignment | Any secondary interval vector below price | +1 bonus |
| Delta imbalance (bullish) | Buyer-heavy candle below price | +1 bonus |
| Fractal Liquidity Sweep | Sweep + close-back + vector agree | +1 bonus |

## Rules ML Must Never Violate
1. Body confirmation (`close > open`) is a bonus, not a hard gate
2. FLS requires vector agreement — never trade against declining vector
3. Delta imbalance zones are NOT Milk zones — different source, different weight
4. Standalone pattern signals require ≥25 occurrences AND ≥72% win rate — no exceptions
5. Standalone pattern signals fire as RISKY, never SAFE
