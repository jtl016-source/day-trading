# Strategy: Data Analysis & Exit Rules

## Calibration Sources
- **Monte Carlo simulation** — 222 signals, MES 5m, June 2025–April 2026
- **1-minute vector spreadsheet** — 17 observed side-entry trades (July–August 2025)
- **30-minute vector spreadsheet** — 21 observed trades (May–August 2025)
- **60-minute vector spreadsheet** — 10 observed trades (September–November 2025)

---

## Observed Tabletop Slippage by Timeframe

| Timeframe | Typical Slippage | Max (survivable) | Failure Mode |
|-----------|-----------------|------------------|--------------|
| 1-min     | 0–3 pts          | 4.75 pts          | Straight through, no wick return |
| 5-min     | 0–5 pts          | ~7 pts            | Extrapolated from 1-min + 30-min |
| 30-min    | 1.65–10 pts      | 16.5 pts          | Closed below vector repeatedly |
| 60-min    | 4–15 pts         | 51.84 pts (CPI)   | Macro event breaks tabletop permanently |

**Key rule:** When a candle WICKS through the vector but CLOSES above, tabletop holds → stay in trade.  
When a candle CLOSES below the vector, tabletop is failing → SL is now critical.

---

## Observed Max Moves by Timeframe

| Timeframe | Typical Max Move | Large Move | Outlier |
|-----------|-----------------|------------|---------|
| 1-min     | 3–10 pts extra after tabletop | 25.25 pts | — |
| 30-min    | 30–60 pts total | 102–127 pts | 259 pts (trade 21) |
| 60-min    | 40–94 pts total | 130–212 pts | — |

---

## Observed Adverse Excursion Before Max Move (Winners Only)

**30-min winners:** 0.74, 1.75, 2.0, 2.1, 2.3, 2.5, 2.84, 3.14, 5.95, 6.0, 6.6, 8.0, 10.5, 13.0, 15.16, 16.1, 16.5 pts  
→ 75th percentile ≈ 10 pts. SL of 5 pts would have prematurely stopped ~30% of winners on 30-min.  
→ For 5-min intraday: 5 pt SL appropriate (shorter-hold, lower adverse expected).

**60-min winners:** 1.08, 14.48, 18.25, 20.0, 20.53, 26.2, 51.84 pts  
→ 60-min needs 20–25 pt SL minimum to survive to max move.

---

## Calibrated Exit Profiles (Current)

### Safe (Milk Zone + Vector confirmed)
```
RTH:  TP1 = 10.0 pts  |  TP2 = 20.0 pts  |  SL = 5.0 pts
ETH:  TP1 =  6.0 pts  |  TP2 = 14.0 pts  |  SL = 3.5 pts
```
**Rationale:** SL=5 covers 95%+ of 1-min tabletop slippage (max observed 4.75 pts).  
TP2=20 targets the low end of 30-min high-confluence moves (observed 20–60 pts).

### Risky (Vector + secondary only, no zone)
```
RTH:  TP1 = 10.0 pts  |  TP2 = 25.0 pts  |  SL = 5.0 pts  (tp1Safe = 12.5)
ETH:  TP1 =  5.0 pts  |  TP2 = 12.0 pts  |  SL = 3.0 pts  (tp1Safe = 7.5)
```
**Rationale:** Same SL as Safe (tabletop slippage is independent of zone confirmation).  
TP2=25 reflects moderate-confluence observed moves on 30-min (20–50 pts).

### Riskiest (Swing style — vector gate only)
```
RTH:  TP1 = 16.0 pts  |  TP2 = 40.0 pts  |  SL = 10.0 pts  (tp1Safe = 20.0)
ETH:  TP1 = 10.0 pts  |  TP2 = 22.0 pts  |  SL =  7.0 pts  (tp1Safe = 12.0)
```
**Rationale:** SL=10 covers 75th-percentile 30-min adverse excursion (≈10 pts).  
TP2=40 captures the median 60-min max move (37–94 pts observed range).

---

## Confluence Impact on Outcome (30-min data)

| Confluence | Win Count | Loss Count | Notes |
|------------|-----------|------------|-------|
| 5min + 15min/30min both active | ~10 | ~2 | Almost all big winners had full confluence |
| One timeframe only | ~3 | ~4 | Mixed results |
| No confluence | 0 | ~2 | Straight-through losses |

**Implication:** Safe tier (which requires Milk zone, the strongest confluence) should have the highest TP2 relative to SL because historical data shows these moves run furthest.

---

## Tabletop Win Rate by Timeframe

| Timeframe | Tabletop Initiated | Total Trades | Initiation Rate |
|-----------|-------------------|--------------|-----------------|
| 1-min     | 13 / 17           | 17           | 76%             |
| 30-min    | 12 / 21           | 21           | 57%             |
| 60-min    | 4 / 10            | 10           | 40%             |

**When tabletop fails:** Losses are immediate (no return), typically "straight through."  
**When tabletop holds:** Profits can be very large — 30-min data shows 1.75–16.5 pt wick before big move.

---

## Signal Filters
- **RTH window:** 13:30–21:00 UTC Mon-Fri (Regular Trading Hours)
- **CME settlement break:** No signals 4:30–6:00 PM ET (low volume)
- **Closing hour:** Last 60 min of RTH (20:00–21:00 UTC) → Safe tier only
- **RTH cooldown:** 10 RTH bars between signals
- **ETH cooldown:** 20 bars (wider spreads, lower volume)

---

## HOD/LOD TP1 Adjustment
- **Proximity threshold:** 3 pts — if TP1 is within 3 pts of HOD/LOD, adjust
- **Buffer:** TP1 clamped to HOD − 2 (longs) or LOD + 2 (shorts)
- **Minimum profit:** 3 pts — if adjusted TP1 < entry + 3, use TP2 only
- **TP2 never clamped**

## Long Entry Suppression Near HOD
- Long blocked when `close` is within 5 pts of `prevDayHodHigh`
- Uses `prevDayHodHigh` (before current bar) to allow valid breakouts

---

## Rules ML Must Never Violate
1. SL is always below entry for Long, above entry for Short
2. Fixed-point exits only — never ATR-based in live trading
3. No signals at CME settlement break (4:30–6:00 PM ET)
4. TP2 never clamped to HOD/LOD — only TP1 adjusted
5. Win rate below 50% → check DB for corrupt bars before adjusting strategy
6. Tabletop wick through (but close above vector) → hold trade, do NOT exit
7. Tabletop close below vector repeatedly → expect SL hit
