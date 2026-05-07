"""
vector_yellowbox_sim.py
=======================
Senior Quant implementation of the Vector + Yellow Box methodology
for ES/MES S&P 500 Futures (1-minute bars).

Phases:
  1. Confluence scoring per candle (0-100%)
  2. Spike Volatility Engine  → dynamic TP/SL
  3. Monte Carlo (1,000 iterations, ±2 candle slippage)

Dependencies: pandas, numpy, tabulate
  pip install pandas numpy tabulate
"""

import numpy as np
import pandas as pd
from tabulate import tabulate
import warnings
warnings.filterwarnings("ignore")

np.random.seed(42)

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────
TICK          = 0.25        # MES/ES tick size
N_BARS        = 500         # simulation length (1-min bars)
MC_ITERS      = 1_000       # Monte Carlo iterations
SLIP_WINDOW   = 2           # ±2 candle entry slippage
VOL_MULT      = 2.0         # Vector: volume > VOL_MULT × 20-bar avg
RANGE_MULT    = 1.5         # Vector: range  > RANGE_MULT × 20-bar avg
YB_MIN_BARS   = 10          # Yellow Box: minimum consolidation bars
YB_COMPRESS   = 0.5         # Yellow Box: range/ATR threshold
TT_BARS       = 3           # Tabletop: minimum consecutive bars
TT_TICK_TOL   = 1           # Tabletop: high/low within N ticks
SPIKE_WINDOW  = 60          # bars to measure average wick (noise floor)
SL_MULT       = 2.0         # SL = SL_MULT × avg_spike
TP1_MULT      = 1.5         # TP1 = TP1_MULT × avg_spike


# ─────────────────────────────────────────────────────────────────────────────
# 1. SIMULATE 1-MINUTE OHLCV DATA
# ─────────────────────────────────────────────────────────────────────────────
def simulate_ohlcv(n: int = N_BARS) -> pd.DataFrame:
    """
    GBM-based 1-minute ES futures bar generator.
    Injects periodic high-volume vector candles and consolidation zones.
    """
    start_price = 5_400.0
    mu          = 0.0
    sigma       = 0.30 / np.sqrt(252 * 390)   # annualised → per 1-min bar

    closes = [start_price]
    for _ in range(n - 1):
        ret = np.random.normal(mu, sigma)
        closes.append(closes[-1] * np.exp(ret))
    closes = np.array(closes)

    # Build OHLC around closes
    bar_range = np.abs(np.random.normal(1.5, 0.6, n)).clip(0.25)
    opens  = closes - np.random.uniform(-0.5, 0.5, n) * bar_range
    highs  = np.maximum(opens, closes) + np.abs(np.random.normal(0, 0.4, n)) * bar_range
    lows   = np.minimum(opens, closes) - np.abs(np.random.normal(0, 0.4, n)) * bar_range

    # Base volume
    volume = np.random.lognormal(mean=np.log(2_000), sigma=0.4, size=n).astype(int)

    # Inject ~8% vector candles (high volume + wide range)
    vec_idx = np.random.choice(np.arange(30, n), size=int(n * 0.08), replace=False)
    for i in vec_idx:
        volume[i]     *= np.random.uniform(2.2, 4.0)
        extra_range    = np.random.uniform(3.0, 7.0)
        direction      = np.random.choice([-1, 1])
        closes[i]      = opens[i] + direction * extra_range
        highs[i]       = max(opens[i], closes[i]) + extra_range * 0.15
        lows[i]        = min(opens[i], closes[i]) - extra_range * 0.15

    # Inject ~4% consolidation zones (flat, narrow range)
    con_starts = np.random.choice(np.arange(20, n - YB_MIN_BARS - 5), size=int(n * 0.04), replace=False)
    for s in con_starts:
        anchor = closes[s]
        for j in range(s, min(s + YB_MIN_BARS + np.random.randint(0, 10), n)):
            noise       = np.random.uniform(-0.3, 0.3)
            closes[j]   = anchor + noise
            opens[j]    = anchor + np.random.uniform(-0.2, 0.2)
            highs[j]    = anchor + 0.5
            lows[j]     = anchor - 0.5
            volume[j]   = int(volume[j] * 0.6)

    idx = pd.date_range("2026-04-03 09:30", periods=n, freq="1min")
    df  = pd.DataFrame({
        "open":   opens,
        "high":   highs,
        "low":    lows,
        "close":  closes,
        "volume": volume.astype(int),
    }, index=idx)

    # Round to tick
    for col in ["open", "high", "low", "close"]:
        df[col] = (df[col] / TICK).round() * TICK

    df["high"] = df[["open", "close", "high"]].max(axis=1)
    df["low"]  = df[["open", "close", "low"]].min(axis=1)
    return df


# ─────────────────────────────────────────────────────────────────────────────
# 2. FEATURE ENGINEERING
# ─────────────────────────────────────────────────────────────────────────────
def add_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    n  = len(df)

    # ── Rolling metrics ───────────────────────────────────────────────────
    df["bar_range"]  = df["high"] - df["low"]
    df["avg_vol20"]  = df["volume"].rolling(20).mean()
    df["avg_rng20"]  = df["bar_range"].rolling(20).mean()
    df["atr20"]      = df["bar_range"].rolling(20).mean()   # simplified ATR

    # Upper / lower wicks
    df["up_wick"]    = df["high"] - df[["open", "close"]].max(axis=1)
    df["dn_wick"]    = df[["open", "close"]].min(axis=1) - df["low"]
    df["avg_spike"]  = (df["up_wick"] + df["dn_wick"]).rolling(SPIKE_WINDOW).mean() / 2

    # ── Vector candle flags ───────────────────────────────────────────────
    df["is_vector"]  = (
        (df["volume"]    > VOL_MULT  * df["avg_vol20"]) &
        (df["bar_range"] > RANGE_MULT * df["avg_rng20"])
    )
    df["vec_dir"]    = np.where(df["close"] > df["open"], 1, -1)  # 1=bull, -1=bear
    df["vec_50"]     = df["open"] + (df["close"] - df["open"]) * 0.50
    df["vec_100"]    = df["close"]

    # Track the most recent vector levels (carry forward)
    last_vec_50  = np.full(n, np.nan)
    last_vec_100 = np.full(n, np.nan)
    last_vec_dir = np.zeros(n)
    for i in range(1, n):
        if df["is_vector"].iloc[i - 1]:
            last_vec_50[i]  = df["vec_50"].iloc[i - 1]
            last_vec_100[i] = df["vec_100"].iloc[i - 1]
            last_vec_dir[i] = df["vec_dir"].iloc[i - 1]
        else:
            last_vec_50[i]  = last_vec_50[i - 1]
            last_vec_100[i] = last_vec_100[i - 1]
            last_vec_dir[i] = last_vec_dir[i - 1]
    df["last_vec_50"]  = last_vec_50
    df["last_vec_100"] = last_vec_100
    df["last_vec_dir"] = last_vec_dir

    # Price proximity to vector levels (within 1 ATR)
    df["near_vec_50"]  = (df["low"]  <= df["last_vec_50"]  + df["atr20"]) & \
                         (df["high"] >= df["last_vec_50"]  - df["atr20"])
    df["near_vec_100"] = (df["low"]  <= df["last_vec_100"] + df["atr20"]) & \
                         (df["high"] >= df["last_vec_100"] - df["atr20"])

    # ── Yellow Box detection (rolling window) ─────────────────────────────
    yb_flag  = np.zeros(n, dtype=bool)
    yb_mid   = np.full(n, np.nan)
    yb_top   = np.full(n, np.nan)
    yb_bot   = np.full(n, np.nan)
    for i in range(YB_MIN_BARS, n):
        window     = df.iloc[i - YB_MIN_BARS: i]
        w_range    = window["high"].max() - window["low"].min()
        w_atr      = window["atr20"].mean()
        if pd.notna(w_atr) and w_atr > 0 and (w_range / w_atr) < YB_COMPRESS:
            yb_flag[i] = True
            yb_top[i]  = window["high"].max()
            yb_bot[i]  = window["low"].min()
            yb_mid[i]  = (yb_top[i] + yb_bot[i]) / 2
        elif i > 0:
            yb_top[i]  = yb_top[i - 1]
            yb_bot[i]  = yb_bot[i - 1]
            yb_mid[i]  = yb_mid[i - 1]
    df["in_yb"]   = yb_flag
    df["yb_top"]  = yb_top
    df["yb_bot"]  = yb_bot
    df["yb_mid"]  = yb_mid

    # Price touching YB boundary (within 1 tick)
    df["near_yb_top"] = (df["high"] >= df["yb_top"] - TICK) & pd.notna(df["yb_top"])
    df["near_yb_bot"] = (df["low"]  <= df["yb_bot"] + TICK) & pd.notna(df["yb_bot"])

    # ── Tabletop detection ────────────────────────────────────────────────
    tt_flag = np.zeros(n, dtype=bool)
    for i in range(TT_BARS, n):
        highs = df["high"].iloc[i - TT_BARS: i].values
        lows  = df["low"].iloc[i  - TT_BARS: i].values
        if (np.max(highs) - np.min(highs) <= TT_TICK_TOL * TICK and
                np.max(lows)  - np.min(lows)  <= TT_TICK_TOL * TICK):
            tt_flag[i] = True
    df["tabletop"] = tt_flag

    return df


# ─────────────────────────────────────────────────────────────────────────────
# 3. CONFLUENCE SCORING
# ─────────────────────────────────────────────────────────────────────────────
def score_confluence(df: pd.DataFrame) -> pd.DataFrame:
    """
    Score each candle 0–100 based on how many conditions align.

    Component weights (sum = 100):
      Vector 50% recovery proximity  : 20 pts
      Vector 100% recovery proximity : 20 pts
      Yellow Box boundary touch       : 20 pts
      Yellow Box active               : 15 pts
      Tabletop formation              : 25 pts
    """
    df = df.copy()
    score = pd.Series(0.0, index=df.index)

    score += df["near_vec_50"].astype(float)  * 20
    score += df["near_vec_100"].astype(float) * 20
    score += (df["near_yb_top"] | df["near_yb_bot"]).astype(float) * 20
    score += df["in_yb"].astype(float) * 15
    score += df["tabletop"].astype(float) * 25

    df["confluence"] = score.clip(0, 100)

    # Signal tier
    conditions = [
        df["confluence"] >= 75,
        df["confluence"] >= 50,
        df["confluence"] >= 25,
    ]
    choices = ["HIGH_CONVICTION", "STRONG", "WEAK"]
    df["signal_tier"] = np.select(conditions, choices, default="NO_SIGNAL")

    # Direction: follow last vector direction
    df["signal_dir"] = np.where(
        df["last_vec_dir"] == 1,  "BUY",
        np.where(df["last_vec_dir"] == -1, "SHORT", "NONE")
    )
    df.loc[df["signal_tier"] == "NO_SIGNAL", "signal_dir"] = "NONE"

    return df


# ─────────────────────────────────────────────────────────────────────────────
# 4. SPIKE VOLATILITY ENGINE  →  TP / SL per bar
# ─────────────────────────────────────────────────────────────────────────────
def add_tp_sl(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    spike       = df["avg_spike"].fillna(0.5)
    df["sl"]    = (SL_MULT  * spike).clip(lower=TICK * 2)
    df["tp1"]   = (TP1_MULT * spike).clip(lower=TICK)

    # TP2 = next vector level or YB edge (directional)
    tp2 = np.full(len(df), np.nan)
    for i in range(len(df)):
        if df["signal_dir"].iloc[i] == "BUY":
            tp2[i] = df["last_vec_100"].iloc[i] if pd.notna(df["last_vec_100"].iloc[i]) \
                     else df["close"].iloc[i] + spike.iloc[i] * 3
        elif df["signal_dir"].iloc[i] == "SHORT":
            tp2[i] = df["last_vec_100"].iloc[i] if pd.notna(df["last_vec_100"].iloc[i]) \
                     else df["close"].iloc[i] - spike.iloc[i] * 3
        else:
            tp2[i] = np.nan
    df["tp2_price"] = tp2
    return df


# ─────────────────────────────────────────────────────────────────────────────
# 5. TRADE EXECUTION (deterministic pass)
# ─────────────────────────────────────────────────────────────────────────────
def extract_signals(df: pd.DataFrame) -> pd.DataFrame:
    """Return only actionable signal rows (tier >= WEAK, direction != NONE)."""
    mask = (df["signal_tier"] != "NO_SIGNAL") & (df["signal_dir"] != "NONE")
    sigs = df[mask].copy()

    # TP1 / TP2 absolute prices
    sigs["entry"] = sigs["close"]
    sigs.loc[sigs["signal_dir"] == "BUY",   "tp1_price"] = sigs["close"] + sigs["tp1"]
    sigs.loc[sigs["signal_dir"] == "SHORT", "tp1_price"] = sigs["close"] - sigs["tp1"]
    sigs.loc[sigs["signal_dir"] == "BUY",   "sl_price"]  = sigs["close"] - sigs["sl"]
    sigs.loc[sigs["signal_dir"] == "SHORT", "sl_price"]  = sigs["close"] + sigs["sl"]

    return sigs.reset_index()


def simulate_trade(entry, direction, tp1, tp2, sl, future_bars: np.ndarray) -> str:
    """Walk forward through future_bars OHLC until TP1, TP2, or SL hit."""
    for bar in future_bars:
        o, h, l, c = bar
        if direction == "BUY":
            if l <= sl:  return "SL"
            if h >= tp2: return "TP2"
            if h >= tp1: return "TP1"
        else:
            if h >= sl:  return "SL"
            if l <= tp2: return "TP2"
            if l <= tp1: return "TP1"
    return "OPEN"


# ─────────────────────────────────────────────────────────────────────────────
# 6. MONTE CARLO SIMULATION
# ─────────────────────────────────────────────────────────────────────────────
def monte_carlo(df: pd.DataFrame, signals: pd.DataFrame) -> pd.DataFrame:
    """
    For each signal, run MC_ITERS iterations:
      - Randomise entry bar ±SLIP_WINDOW
      - Randomise TP1 multiplier in [1.0, 2.0], SL multiplier in [1.5, 2.5]
      - Record outcome distribution
    Returns signals enriched with optimal TP/SL and win-rate.
    """
    ohlc = df[["open", "high", "low", "close"]].values
    n    = len(ohlc)

    results = []
    for _, sig in signals.iterrows():
        bar_idx   = df.index.get_loc(sig["index"])
        direction = sig["signal_dir"]
        spike_val = df["avg_spike"].iloc[bar_idx]
        if spike_val <= 0 or np.isnan(spike_val):
            spike_val = 0.5

        win_counts   = {}
        best_ratio   = None
        best_winrate = 0.0

        # Test a grid of TP1/SL multipliers
        for tp1_m in np.arange(1.0, 2.25, 0.25):
            for sl_m in np.arange(1.5, 2.75, 0.25):
                wins = 0
                for _ in range(MC_ITERS):
                    slip        = np.random.randint(-SLIP_WINDOW, SLIP_WINDOW + 1)
                    entry_idx   = max(0, min(bar_idx + slip, n - 2))
                    entry_price = ohlc[entry_idx][3]  # close of slipped bar

                    tp1_abs = tp1_m * spike_val
                    sl_abs  = sl_m  * spike_val

                    # TP2 = fixed 3× spike from slipped entry
                    tp2_abs = 3.0 * spike_val

                    if direction == "BUY":
                        tp1 = entry_price + tp1_abs
                        tp2 = entry_price + tp2_abs
                        sl  = entry_price - sl_abs
                    else:
                        tp1 = entry_price - tp1_abs
                        tp2 = entry_price - tp2_abs
                        sl  = entry_price + sl_abs

                    future = ohlc[entry_idx + 1: entry_idx + 51]
                    outcome = simulate_trade(entry_price, direction, tp1, tp2, sl, future)
                    if outcome in ("TP1", "TP2"):
                        wins += 1

                wr = wins / MC_ITERS
                win_counts[(tp1_m, sl_m)] = wr
                if wr > best_winrate:
                    best_winrate = wr
                    best_ratio   = (tp1_m, sl_m)

        opt_tp1_m, opt_sl_m = best_ratio if best_ratio else (TP1_MULT, SL_MULT)
        entry_price = ohlc[bar_idx][3]

        if direction == "BUY":
            opt_tp1 = entry_price + opt_tp1_m * spike_val
            opt_tp2 = entry_price + 3.0       * spike_val
            opt_sl  = entry_price - opt_sl_m  * spike_val
        else:
            opt_tp1 = entry_price - opt_tp1_m * spike_val
            opt_tp2 = entry_price - 3.0       * spike_val
            opt_sl  = entry_price + opt_sl_m  * spike_val

        future   = ohlc[bar_idx + 1: bar_idx + 51]
        outcome  = simulate_trade(entry_price, direction, opt_tp1, opt_tp2, opt_sl, future)

        results.append({
            "time":         sig["index"].strftime("%H:%M"),
            "signal_type":  f"{sig['signal_tier']} {direction}",
            "confluence":   f"{sig['confluence']:.0f}%",
            "entry":        round(entry_price, 2),
            "tp1":          round(opt_tp1, 2),
            "tp2":          round(opt_tp2, 2),
            "sl":           round(opt_sl,  2),
            "win_rate":     f"{best_winrate*100:.1f}%",
            "result":       outcome,
        })

    return pd.DataFrame(results)


# ─────────────────────────────────────────────────────────────────────────────
# 7. MAIN
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("\n[1/5] Simulating 1-minute OHLCV data ...")
    df = simulate_ohlcv(N_BARS)

    print("[2/5] Engineering features (Vector / Yellow Box / Tabletop) ...")
    df = add_features(df)

    print("[3/5] Scoring confluence (0-100%) per candle ...")
    df = score_confluence(df)

    print("[4/5] Calculating TP / SL via Spike Volatility Engine ...")
    df = add_tp_sl(df)

    signals = extract_signals(df)
    print(f"      → {len(signals)} actionable signals found\n")

    if signals.empty:
        print("No signals generated. Try relaxing thresholds.")
    else:
        # Cap output at 30 strongest signals for readability
        top_signals = signals.nlargest(30, "confluence")

        print("[5/5] Running Monte Carlo simulation (1,000 iterations per signal) ...")
        mc_results = monte_carlo(df, top_signals)

        # ── Summary stats ─────────────────────────────────────────────────
        win_rates = mc_results["win_rate"].str.rstrip("%").astype(float)
        outcomes  = mc_results["result"].value_counts()

        print("\n" + "═" * 70)
        print("  MONTE CARLO SUMMARY")
        print("═" * 70)
        print(f"  Signals analysed  : {len(mc_results)}")
        print(f"  Avg MC win rate   : {win_rates.mean():.1f}%")
        print(f"  Best win rate     : {win_rates.max():.1f}%")
        print(f"  Outcome breakdown : {dict(outcomes)}")
        print("═" * 70)

        # ── Results table ─────────────────────────────────────────────────
        headers = ["Time", "Signal Type", "Confluence", "Entry",
                   "TP1", "TP2", "SL", "Win Rate", "Result"]
        rows = [
            [r["time"], r["signal_type"], r["confluence"], r["entry"],
             r["tp1"], r["tp2"], r["sl"], r["win_rate"], r["result"]]
            for _, r in mc_results.iterrows()
        ]
        print("\n" + tabulate(rows, headers=headers, tablefmt="rounded_outline",
                              floatfmt=".2f", numalign="right"))

        # ── Confluence distribution ───────────────────────────────────────
        print("\n  CONFLUENCE DISTRIBUTION (all bars):")
        bins = [0, 25, 50, 75, 100]
        labels = ["NO_SIGNAL (0-25)", "WEAK (25-50)", "STRONG (50-75)", "HIGH (75-100)"]
        dist = pd.cut(df["confluence"], bins=bins, labels=labels, include_lowest=True)
        for tier, count in dist.value_counts().sort_index().items():
            pct = count / len(df) * 100
            bar = "█" * int(pct / 2)
            print(f"  {tier:<22} {count:>5} bars  {pct:5.1f}%  {bar}")

        print("\n  Done.\n")
