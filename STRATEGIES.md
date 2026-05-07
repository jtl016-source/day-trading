# STRATEGIES — Milk Yellow Box Strategy Reference

This file documents all strategies integrated into the program.
The ML system should read this file to understand the conceptual basis for
every signal, zone, and exit rule before generating or evaluating trades.

---

## 1. Primary Vector (Highest Lowest — HL20)

**Formula:** `Highest( Lowest(low, 20), 20 )` on the current chart interval

**What it represents:**
The vector is the highest level that the 20-bar lowest-low has reached over the last 20 bars.
It tracks the market's "floor of floors" — the highest point at which buyers have repeatedly
absorbed selling pressure. When price is above a rising vector, buyers are in control.

**Signal rules:**
- HARD GATE: `close > vector` — price must be numerically above the vector value
- SLOPE GATE: `vector[now] >= vector[3 bars ago]` — vector must be flat or rising
  (a declining vector means buyers are losing ground; no Long entries)
- Entry on the NEXT bar after both conditions are met

**Why it works:**
The vector acts as a dynamic support baseline. A rising vector with price above it means
recent lows are systematically higher — the definition of an uptrend at the micro level.

---

## 2. Milk Yellow Box Zone

**Source:** Real zones extracted from MotiveWave MWML files (29,583 zones, 2023–2026)
**ML pipeline:** `ml/zone_classifier.py` — extract → features → train (RandomForest)

**What it represents:**
A "Milk zone" is a price level where Milk's MotiveWave study identified significant order
flow imbalance — an area where institutional buyers (for support/bullish zones) or sellers
(for resistance/bearish zones) placed large resting orders. These levels are NOT derived
from candle patterns alone — they are based on volume/order-flow data that Milk manually
curated in MotiveWave.

**Zone types:**
- **Bullish zone (support):** `is_bull = true` — buyers absorbed sellers here; price bounced
- **Bearish zone (resistance):** `is_bull = false` — sellers absorbed buyers here; price rejected

**milkOk signal condition (price-based, not time-based):**
```
milkOk = TRUE when ALL of:
  1. candle is during RTH (13:30–20:30 UTC Mon-Fri)
  2. zone is active: candle.time ∈ [zone.from_ts, zone.to_ts]
  3. candle.low  ≤ zone.top    + 2.0 pts  (price wicked into or near the zone)
  4. candle.close ≥ zone.bottom - 2.0 pts  (price held above zone bottom — bounce pattern)
```

**What "milkOk" means economically:**
The candle tested the support zone (low reached the zone) AND closed back above the zone
bottom — this is the "zone test and hold" pattern. It confirms the zone is still active
as a support level and buyers stepped in.

**Why the price check matters (vs time check):**
A time-only check (`candle.time ∈ [zone.from_ts, zone.to_ts]`) marks every candle in the
time window as "in the milk zone" even if price is 50 pts above or below the zone level.
This is observational bias — you'd be comparing visual chart position, not actual prices.
The price-based check compares `candle.low` and `candle.close` (numbers) to `zone.top`
and `zone.bottom` (numbers) — fully quantitative, no visual interpretation required.

**Zone lifetime:**
Zones persist from their `from_ts` to `to_ts` as extracted from MWML files. A zone
formed on March 29 can remain valid through April 2 if it was never invalidated.
Zones do NOT reset every day — they represent actual structural price levels.

---

## 3. Confluence Signal Tier System

**Three bonus components (beyond the vector hard gate):**

| Component | Condition | Weight |
|-----------|-----------|--------|
| `milkOk` | Price tested a bullish Milk zone AND bounced (price-based, see above) | +1 |
| `bodyOk` | Candle closed bullish (`close > open`) — body confirmation | +1 |
| `secondaryVecOk` | Any secondary-interval vector (1m/5m/15m/60m) also below price | +1 |

**Tier thresholds:**
- **Safe (≥2 bonus):** Strong conviction — two or more components confirm the Long
- **Risky (1 bonus):** Moderate conviction — vector gate + one bonus component
- **Riskiest (0 bonus):** Low conviction — vector gate only, no additional confirmation

**Resistance proximity downgrade:**
If a bearish Milk zone's bottom is within 5.0 pts above entry → downgrade one tier.
Overhead supply limits upside potential and increases risk of rejection.

---

## 4. Exit Strategy (Monte Carlo Calibrated)

**Calibration:** 222 signals on real MES 5m data (June 2025–April 2026)
**Method:** Walk-forward grid search over TP/SL parameter space

**Results:**
| Config | TP1 | SL | R:R | Win% | Exp. pts/trade |
|--------|-----|----|-----|------|----------------|
| Best ATR-based | 2.5×ATR | 0.25×ATR | 10:1 | 18.1% | 0.25 |
| Best Fixed | 20 pts | 5 pts | 4:1 | 28.2% | 2.05 |

**Selected exit strategy (fixed points, MES/ES):**
```
TP1 = entry + 10 pts   (40 ticks, $50 per MES contract)
TP2 = entry + 20 pts   (80 ticks, $100 per MES contract)
SL  = entry - 5 pts    (20 ticks, $25 per MES contract)
R:R = 2:1 (TP1), 4:1 (TP2)
```

**Why fixed points beat ATR-based:**
The MES 5m ATR varies enormously (3–45 pts in the test period). ATR-based stops
become massive during high-volatility periods (averaging 15.3 pts in the test period),
causing the SL to be too wide to be practical. Fixed points give consistent risk
regardless of market volatility — the trader always knows exactly how much they risk.

**Walk-forward win rate:**
With the vector-only filter: ~28-32% baseline.
With the milk zone price filter (price-in-zone bounces only): target ~50-60%.
The milk zone filter removes signals where price is in a structural no-man's land.

---

## 5. Multi-Interval Vector System

All four intervals are shown simultaneously on every chart:
- **1m vector** — short-term momentum; fast-moving support
- **5m vector** — session structure; primary trading interval  
- **15m vector** — intraday bias; overrides 5m on conflicting signals
- **60m vector** — macro bias; do not fight a declining 60m vector

**How secondary vectors vote:**
Each secondary vector is forward-filled to the current chart's bar timestamps.
`secondaryVecOk = any(close > vector_value)` for any of the secondary intervals.
This gives +1 bonus toward the signal tier.

**How to read multi-vector confluence:**
- All 4 vectors below price AND rising → very strong Long confirmation
- 60m vector above price (declining) → skip Long entries, even if 5m looks good
- 1m vector crossing above (rising fast) → often leads the 5m vector higher soon

---

## 6. Signal Cooldown and Filters

- **RTH only for Safe/Risky:** Signals fire during Regular Trading Hours (13:30–21:00 UTC, Mon–Fri)
- **CME Settlement break filter:** No signals 4:30–6:00 PM ET (settlement/low volume)  
- **Closing hour filter:** Last 60 min of RTH (20:00–21:00 UTC) → Safe tier only
- **Cooldown:** 10 RTH bars between signals (prevents clustering at the same level)
- **ETH cooldown:** 20 bars (ETH signals require more separation due to low volume/wider spreads)

---

## 7. Delta Imbalance Zones

**What they are:** Candles where volume was dominated by one side (buyers or sellers)
in the last 20 bars, more than 1.5× the 20-bar average imbalance.

**How to use them:** These zones act as short-term support (buyer-heavy) or resistance
(seller-heavy). They are NOT Milk zones — they are derived from volume data in the DB.

---

## 8. Fractal Liquidity Sweep (FLS) — Reference Only

**Pattern:** 5-bar fractal swing point where a wick briefly breaks the fractal high/low
then closes BACK inside the prior range — a "sweep and close back" rejection.

**Conditions:**
1. Identify a 5-bar fractal swing high (bearish sweep) or low (bullish sweep)
2. A later candle's wick breaks through the fractal point
3. That candle CLOSES back inside the prior range (rejection, not continuation)
4. The current-interval vector agrees with the sweep direction

**Significance:** Fractal sweeps represent stop-hunts where institutional traders
trigger retail stop orders to fill their own position at a better price. After the sweep,
price typically reverses sharply.

---

## 9. Rules the ML Must Never Violate

1. **Never compare visual positions** — always compare prices (numbers) to prices
2. **Milk zone milkOk requires price IN the zone** (close within zone top±2pts, low ≤ zone top)
3. **Vector must be numerically below close** (close > vector value, not "close is above on chart")
4. **Stop loss is always below entry for Long signals** (sl = entry - SL_FIXED)
5. **No signals at CME settlement break** (4:30–6:00 PM ET)
6. **60m vector declining → skip all Long signals** (macro structure overrides micro)
7. **Zone resistance within 5 pts → downgrade tier** (too much overhead supply)
8. **10-bar cooldown prevents signal clustering** (same zone should not fire repeatedly)

---

## 10. What Has Worked vs. What Has Failed (from LEARNINGS.md)

**Worked:**
- Fixed-point exits (TP=10/20pts, SL=5pts) vs ATR-based (too volatile during high-VIX days)
- Price-based zone check (c.low ≤ z.top, c.close ≥ z.bottom) vs time-only check
- Forward-filling coarser vectors onto finer chart timestamps for multi-interval lookup
- RTH-only vector computation (ETH candles skew Highest(Lowest()) with low-volume noise)
- 10-bar RTH cooldown between signals (without it, same zone fires 3-5 times)

**Failed / Do Not Use:**
- ATR-based SL when ATR is above 10 pts (stops become unrealistically wide — 15+ pts)
- Time-only milkOk check (fires on every candle in the time window, even 50+ pts away from zone)
- `rthCloseOfDay()` cap on zone toTime (truncates multi-day zones, making them invisible)
- Dynamic chart.addSeries() after chart init (resets visible range, breaks on resize)
- Flat/tabletopped vector with no retest (exhausted momentum, not a valid launch point)
- Body confirmation as a hard gate (too restrictive; use as bonus component only)
