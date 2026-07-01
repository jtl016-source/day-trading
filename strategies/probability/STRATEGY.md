# Strategy: Fractal Probability Concept (Hurst regime / value area / scaler)

> **DISPLAY-ONLY.** This layer never fires, gates, or vetoes a trade. It is a regime/macro
> context read that *frames* the confluence signals (Vector / MilkZone / Footprint). The fractal
> libs each carry the same warning in their headers (`client/src/lib/{hurst,ergodic,multifractal,hurstScaler}.ts`).

## What It Represents
The market's *character*, not a single entry. Four read-outs, computed live from the loaded
closed candles and surfaced in the terminal **Probability** panel (Strategies → Probability):

### 1. Regime — DFA-Hurst exponent (H)
A rolling Detrended-Fluctuation-Analysis Hurst exponent of recent log-returns:
- **H ≥ 0.55 → PERSISTENT (trending):** moves extend; momentum persists → trend-follow, let targets run.
- **H ≤ 0.45 → MEAN-REVERT (chop):** moves fade back to value → fade extremes, tighten targets.
- **0.45 < H < 0.55 → NEUTRAL:** near random-walk; no Hurst edge → default sizing.

Each regime carries the historical win-rate / profit-factor measured on 6,916 real safe 15m MES
signals (2024–2026): PERSISTENT 39.1% / PF 1.53, NEUTRAL 41.4% / PF 1.57, MEAN-REVERT 44.9% / PF 1.75.

> Hurst is **backward-looking** (effective lag ≈ half the window). Never treat an H crossing as
> an entry — it confirms a regime that already began. Closed bars only.

### 2. Value Area (ergodicity panel)
Long-run POC / VAH / VAL over ~500 closed bars (a volume-less TPO / market-profile approximation),
plus where the current price sits in its realized range:
- **Above VAH:** extended high — mean-reversion risk.
- **Below VAL:** extended low — mean-reversion risk.
- **Inside value:** balanced / fair price.

### 3. Hurst Target Scaler
Under a fractional-Brownian model, the expected range over a horizon τ scales as **τ^H**, not the
random-walk **√τ**. So H < 0.5 ⇒ moves grow slower ⇒ **tighten targets**; H > 0.5 ⇒ moves grow
faster ⇒ **let targets run**. The panel shows the implied ± expected range at several horizons.
This only *computes* what Hurst-aware sizing would do — it does **not** change live ATR/stop logic.

### 4. Multifractal Stress
The percentile of the current multifractal spectrum width (Δα) vs trailing windows. High stress =
the tape is more turbulent than its own recent norm → treat range projections with caution.

## How To Use It
There is no "fire" here — read it as context:
- Trend-follow and let targets run for a confluence **long** in a **PERSISTENT** regime inside value.
- Fade extremes and tighten targets for a setup in a **MEAN-REVERT** regime stretched above/below value.
- Stand down when **multifractal stress** is high (unstable scaling, wider noise).

The strongest framing is a confluence signal that **agrees** with the regime and isn't fighting the
value area.

## Why It Works
A single price path's time-average (what one trader actually experiences) need not equal the
ensemble-average of all paths (ergodicity), and real markets are multifractal rather than pure
random walks. Knowing the prevailing regime and where price sits in its realized distribution tells
you whether continuation or reversion is statistically favored — context that improves how you size
and target the confluence entries, without ever manufacturing a trade on its own.

## Parameters
- Hurst window: 100 bars · thresholds 0.45 / 0.55 (a-priori, never fit to data)
- Value area: 500-bar lookback, 70% value band
- Stress window: 150 bars · scaler horizons 2 / 4 / 8 / 12 bars

## Implementation
- Math: `client/src/lib/{hurst,ergodic,multifractal,hurstScaler,fbm}.ts`
- Snapshot read-model: `client/src/lib/probability.ts`
- UI: `client/src/components/terminal/ProbabilityPanel.tsx` (floats top-right when enabled)
- iPhone parity port: `DayTrading/lib/probability.ts`
