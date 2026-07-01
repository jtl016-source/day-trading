#!/usr/bin/env python3
"""
exit_strategy.py  ?  Monte Carlo exit-strategy engine for Milks Yellow Box Strategy
=====================================================================================

Reads historical OHLCV from the PostgreSQL cached_candles table (populated by
MotiveWave -> server/mw-reader.ts), detects Safe / Risky / Riskiest confluence
signals that mirror the TypeScript logic in market.tsx, then runs 10 000-iteration
block-bootstrap Monte Carlo to find the TP/SL levels that maximise expected value
per tier.

Risk tiers (matching TypeScript market.tsx):
  SAFE      ? all 3: Milk zone + Vector + Bullish pattern (body)
  RISKY     ? any 2 of 3
  RISKIEST  ? only 1 of 3

Quick start
-----------
  # Calibrate (reads DB, runs MC, saves results, prints table):
  python exit_strategy.py calibrate --symbol MES --resolution 5

  # Get exits for a live signal:
  python exit_strategy.py exits --tier safe --entry 5123.50 --atr 8.25

  # Print last calibration summary:
  python exit_strategy.py summary

As a library:
  from exit_strategy import ExitStrategyEngine
  engine = ExitStrategyEngine()
  engine.calibrate("MES", resolution="5")
  p = engine.get_exits("safe", entry_price=5123.50, atr=8.25)
  print(p.tp1_price, p.sl_price, p.win_rate_tp1)

Dependencies:
  pip install numpy pandas psycopg2-binary python-dotenv
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse, parse_qs

import numpy as np
import pandas as pd

# -- Optional deps -------------------------------------------------------------
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    _PSYCOPG2 = True
except ImportError:
    _PSYCOPG2 = False
    print("Warning: psycopg2 not installed. Run: pip install psycopg2-binary")

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass


# ===============================================================================
# CONSTANTS
# ===============================================================================

TICK_SIZE         = 0.25     # MES/ES price per tick
TICK_VALUE_MES    = 1.25     # $/tick for 1 MES contract
TICK_VALUE_ES     = 12.50    # $/tick for 1 ES contract

ATR_PERIOD        = 14
VECTOR_PERIOD     = 20       # Highest(Lowest(low, 20), 20)  ? matches market.tsx
COOLDOWN_RTH      = 10       # bars between signals in RTH
COOLDOWN_ETH      = 20       # bars between signals in ETH
FORWARD_BARS      = 60       # how many bars forward to evaluate each signal

# MC grid in ATR multiples
TP_GRID_ATR  = [round(x * 0.25, 2) for x in range(1, 25)]   # 0.25 ? 6.00
SL_GRID_ATR  = [round(x * 0.10, 2) for x in range(1, 21)]   # 0.10 ? 2.00
MC_ITERATIONS    = 10_000

# Per-tier SL caps (prevent the optimiser from picking an absurdly wide SL)
TIER_SL_CAP_ATR = {"safe": 2.0, "risky": 1.2, "riskiest": 0.7}

# Problem 2 — SL floor and tier multipliers
ATR_SL_MIN_MULT = 1.25   # minimum SL = 1.25x ATR regardless of MC output (Step A)
TIER_SL_MULT = {          # applied after ATR-floor + MC-MAE max (Step C)
    "safe":     1.00,
    "risky":    1.25,
    "riskiest": 1.50,
}

# Problem 2 Step B — MC MAE percentile for SL floor
MAE_PERCENTILE = 70       # 70% of historical trades did NOT exceed this adverse move

# Problem 3 — MFE-based TP targets
MFE_TP1_PCTILE = 50       # 50th pct MFE -> price reaches TP1 on 50% of trades
MFE_TP2_PCTILE = 75       # 75th pct MFE -> price reaches TP2 on 25% of trades
MIN_RR_TP1     = 1.5      # advisory minimum R:R for TP1
MIN_RR_TP2     = 2.5      # advisory minimum R:R for TP2

# RTH: Mon?Fri 09:30?17:00 ET = 13:30?21:00 UTC
RTH_UTC_OPEN_H,  RTH_UTC_OPEN_M  = 13, 30
RTH_UTC_CLOSE_H, RTH_UTC_CLOSE_M = 21,  0

CALIBRATION_FILE = Path(__file__).parent / "exit_strategy_calibration.json"
OUTCOMES_LOG     = Path(__file__).parent / "exit_strategy_outcomes.jsonl"

# ── Signal logic constants (per spec) ─────────────────────────────────────────
# Footprint zone proximity: "relatively close" = within this many ticks of a zone.
# Configurable; spec suggests 5-8 ticks; 6 is the default.
FP_PROXIMITY_TICKS    = 6
FP_TICK_THRESHOLD     = FP_PROXIMITY_TICKS * TICK_SIZE   # price units

# ETH minimum confirmations: FP alone is never enough for ETH.
# Must have FP + Vector (count >= 2) to fire an ETH signal.
ETH_MIN_CONFIRMATIONS = 2

# Persistent, append-only signal store path.
# This file is the single source of truth; signals written here are PERMANENT.
SIGNAL_STORE_PATH = Path(__file__).parent / "signals_permanent.jsonl"


# ===============================================================================
# DATA TYPES
# ===============================================================================

@dataclass
class ExitParams:
    """Exit levels returned for a single live signal."""
    tier:                   str
    entry_price:            float
    sl_price:               float
    tp1_price:              float
    tp2_price:              float
    sl_ticks:               int
    tp1_ticks:              int
    tp2_ticks:              int
    win_rate_tp1:           float   # 0-1 probability of reaching TP1 before SL
    win_rate_tp2:           float   # 0-1 probability of reaching TP2 (from entry)
    ev_per_trade:           float   # expected value in ticks
    ev_dollars:             float   # expected value in USD
    confidence:             str     # "HIGH" >=50 / "MEDIUM" >=20 / "LOW" / "DEFAULT"
    sample_count:           int     # historical signals used in calibration
    atr_used:               float
    # Required signal log fields (Problems 2/3)
    atr_14:                 float = 0.0   # same as atr_used, named per spec
    rr_ratio_tp1:           float = 0.0
    rr_ratio_tp2:           float = 0.0
    monte_carlo_mae_used:   float = 0.0   # 70th pct MAE applied (ticks)
    candle_close_confirmed: bool  = True  # always True -- never fire on open candle


@dataclass
class PartialExitPlan:
    """Scale-out plan generated alongside ExitParams (Problem 3 Step C)."""
    first_exit_price:  float   # TP1 -- close 50% of position here
    first_exit_pct:    float   # 0.50
    breakeven_sl:      float   # entry price -- move SL here once TP1 is hit
    second_exit_price: float   # TP2 -- close remaining 50% here
    second_exit_pct:   float   # 0.50


@dataclass
class TierCalibration:
    """Stored calibration result for one tier."""
    tier:          str
    sl_atr:        float     # optimal SL in ATR multiples
    tp1_atr:       float     # optimal TP1 in ATR multiples
    tp2_atr:       float     # secondary target (scale-out)
    win_rate_tp1:  float
    win_rate_tp2:  float
    ev_tp1:        float     # EV in ATR units at TP1
    ev_combined:   float     # EV of 50%@TP1 + 50%@TP2 strategy
    sample_count:  int
    calibrated_at: str       # ISO timestamp
    ev_ci_low:     float     # 95% CI lower bound on EV
    ev_ci_high:    float     # 95% CI upper bound on EV
    top5:          list      # top-5 (tp, sl, ev) cells for audit
    # Problem 2 Step B — Monte Carlo MAE/MFE distributions
    mae_p70_atr:   float = 0.0  # 70th pct absolute MAE in ATR units (MC SL reference)
    mfe_p50_atr:   float = 0.0  # 50th pct MFE in ATR units (TP1 reference)
    mfe_p75_atr:   float = 0.0  # 75th pct MFE in ATR units (TP2 reference)
    date_range:    str   = ""   # date range of historical data used in calibration


# ===============================================================================
# SIGNAL STORE  (append-only, permanent)
# ===============================================================================

class SignalStore:
    """
    Append-only persistent signal log.

    Each signal is keyed by (symbol, resolution, bar_time).
    Once written, a signal is NEVER overwritten or deleted.
    `add()` returns False if the key already exists (idempotent).
    `all_signals()` returns read-only dicts — callers must not mutate them.
    """

    def __init__(self, path: Path = SIGNAL_STORE_PATH):
        self._path    = path
        self._index:   set                   = set()
        self._records: List[Dict[str, Any]]  = []
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        with open(self._path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    key = (rec.get("symbol"), rec.get("resolution"), rec.get("bar_time"))
                    if key not in self._index:
                        self._index.add(key)
                        self._records.append(rec)
                except json.JSONDecodeError:
                    pass

    def add(self, record: Dict[str, Any]) -> bool:
        """
        Append a signal record. Returns True if added, False if already exists.
        record must contain: symbol, resolution, bar_time, tier.
        """
        key = (record.get("symbol"), record.get("resolution"), record.get("bar_time"))
        if key in self._index:
            return False
        self._index.add(key)
        self._records.append(record)
        with open(self._path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
        return True

    def all_signals(self) -> List[Dict[str, Any]]:
        """Returns read-only copies of all stored signals."""
        return [dict(r) for r in self._records]

    def __len__(self) -> int:
        return len(self._records)


# ===============================================================================
# EXIT STRATEGY ENGINE
# ===============================================================================

class ExitStrategyEngine:
    """
    Monte Carlo-driven exit engine for the Milks Yellow Box Strategy.

    Workflow
    --------
    1. engine.calibrate("MES")  ->  pulls DB candles, detects signals, runs MC
    2. engine.get_exits("safe", 5123.50, atr=8.25)  ->  returns TP/SL/EV
    3. engine.log_outcome(...)  ->  appends trade result for future re-calibration
    """

    def __init__(
        self,
        db_url:      Optional[str]  = None,
        tick_size:   float          = TICK_SIZE,
        tick_value:  float          = TICK_VALUE_MES,
        verbose:     bool           = True,
        store_path:  Optional[Path] = None,
    ):
        self.tick_size  = tick_size
        self.tick_value = tick_value
        self.verbose    = verbose
        self._db_url    = db_url or os.getenv("DATABASE_URL", "")
        self._conn      = None
        self._calibration: Dict[str, TierCalibration] = {}
        self._store     = SignalStore(store_path or SIGNAL_STORE_PATH)
        self._load_calibration()

    # --------------------------------------------------------------------------
    # DATABASE
    # --------------------------------------------------------------------------

    def _connect(self) -> None:
        if not _PSYCOPG2:
            raise RuntimeError("Install psycopg2-binary: pip install psycopg2-binary")
        if self._conn and not self._conn.closed:
            return
        url = self._db_url
        if not url:
            raise RuntimeError(
                "DATABASE_URL not set. Add it to .env or pass db_url= to ExitStrategyEngine()."
            )
        try:
            parsed = urlparse(url)
            # Extract sslmode from query string
            qs = parse_qs(parsed.query)
            ssl_mode = qs.get("sslmode", [""])[0]
            kwargs: Dict[str, Any] = dict(
                host=parsed.hostname,
                port=parsed.port or 5432,
                dbname=(parsed.path or "/neondb").lstrip("/"),
                user=parsed.username,
                password=parsed.password,
                connect_timeout=15,
            )
            if ssl_mode == "require":
                kwargs["sslmode"] = "require"
            self._conn = psycopg2.connect(**kwargs)
        except Exception as exc:
            raise RuntimeError(f"DB connection failed: {exc}") from exc

    def _disconnect(self) -> None:
        if self._conn and not self._conn.closed:
            try:
                self._conn.close()
            except Exception:
                pass

    # --------------------------------------------------------------------------
    # CANDLE FETCHING
    # --------------------------------------------------------------------------

    def fetch_candles(
        self,
        symbol:     str,
        resolution: str = "5",   # "1", "5", or "60"
        from_ts:    int = 0,
        to_ts:      int = 0,
    ) -> pd.DataFrame:
        """
        Pull OHLCV from cached_candles table. Returns DataFrame sorted by time
        with an added `rth` boolean column (Mon?Fri 09:30?17:00 ET).
        """
        self._connect()
        conditions = ["symbol = %s", "resolution = %s"]
        params: list = [symbol.upper(), resolution]
        if from_ts > 0:
            conditions.append("timestamp >= %s"); params.append(from_ts)
        if to_ts > 0:
            conditions.append("timestamp <= %s"); params.append(to_ts)

        sql = (
            f"SELECT timestamp AS time, open, high, low, close, volume "
            f"FROM cached_candles WHERE {' AND '.join(conditions)} "
            f"ORDER BY timestamp ASC"
        )
        with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

        if not rows:
            return pd.DataFrame(columns=["time","open","high","low","close","volume","rth"])

        df = pd.DataFrame(rows)
        df["time"]   = df["time"].astype(int)
        df["open"]   = df["open"].astype(float)
        df["high"]   = df["high"].astype(float)
        df["low"]    = df["low"].astype(float)
        df["close"]  = df["close"].astype(float)
        df["volume"] = df["volume"].astype(float)
        df["rth"]    = df["time"].apply(self._is_rth)
        return df.reset_index(drop=True)

    def load_candles_csv(self, path: str) -> pd.DataFrame:
        """Fallback: load candles from CSV (columns: time, open, high, low, close, volume)."""
        df = pd.read_csv(path)
        df.columns = [c.lower() for c in df.columns]
        df["time"] = df["time"].astype(int)
        df["rth"]  = df["time"].apply(self._is_rth)
        return df.sort_values("time").reset_index(drop=True)

    # --------------------------------------------------------------------------
    # TIME HELPERS
    # --------------------------------------------------------------------------

    @staticmethod
    def _is_rth(ts: int) -> bool:
        """Mon?Fri 13:30?21:00 UTC (09:30?17:00 ET, ignores DST)."""
        dt = datetime.utcfromtimestamp(int(ts))
        if dt.weekday() >= 5:
            return False
        minutes = dt.hour * 60 + dt.minute
        return (RTH_UTC_OPEN_H * 60 + RTH_UTC_OPEN_M) <= minutes < (RTH_UTC_CLOSE_H * 60 + RTH_UTC_CLOSE_M)

    # --------------------------------------------------------------------------
    # INDICATORS  (matches TypeScript market.tsx)
    # --------------------------------------------------------------------------

    def compute_indicators(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Appends indicator columns to df (in-place copy):
          vector    — Highest(Lowest(low, 20), 20)   <- identical to TypeScript
          vector_3  — vector 3 bars ago (slope gate)
          atr       — 14-period Wilder ATR
          vec_ok    — close > vector AND vector rising  (legacy alias)
          vec_side  — vector side-entry cross (preferred gate)
          body_ok   — close > open
          milk_ok   — price inside today's RTH bullish Milk zone (today only)
          fp_ok     — price near a prior-session footprint zone (bearish retrace)
        """
        df = df.copy()
        lo, hi, cl, op = df["low"], df["high"], df["close"], df["open"]

        # Vector: rolling max of rolling min
        df["vector"]   = lo.rolling(VECTOR_PERIOD).min().rolling(VECTOR_PERIOD).max()
        df["vector_3"] = df["vector"].shift(3)

        # ATR (Wilder's — ewm approximation of Wilder smoothing)
        hl  = hi - lo
        hpc = (hi - cl.shift(1)).abs()
        lpc = (lo - cl.shift(1)).abs()
        tr  = pd.concat([hl, hpc, lpc], axis=1).max(axis=1)
        df["atr"] = tr.ewm(span=ATR_PERIOD, adjust=False).mean()

        # Signal components
        df["vec_ok"]   = (cl > df["vector"]) & (df["vector"] > df["vector_3"])
        df["body_ok"]  = cl > op
        df["vec_side"] = self._detect_vector_side_entry(df)
        df["milk_ok"]  = self._detect_today_milk_zones(df)
        df["fp_ok"]    = self._detect_fp_zones(df)
        return df

    def _detect_milk_zones(self, df: pd.DataFrame) -> pd.Series:
        """
        Python approximation of TypeScript detectMilkZones() for bullish zones.

        Two zone types detected:

        (A) Fair Value Gap / "Imbalance"
            Condition: low[i] > high[i-2]  ->  gap up (unfilled imbalance)
            Zone range: [high[i-2], low[i]]
            Active for up to 60 bars after formation.
            Invalidated when a candle closes below zone bottom.

        (B) Bullish Order Block / "Absorption"
            Condition: bearish candle at i-1 followed by strong bullish impulse
                       (? 1.5 ? ATR within 3 bars)
            Zone range: [low[i-1], high[i-1]]
            Active for up to 40 bars.
            Invalidated when close drops below zone bottom.

        Returns pd.Series[bool] ? True if bar is inside an active bullish zone.
        """
        n      = len(df)
        atr_v  = df["atr"].values
        high_v = df["high"].values
        low_v  = df["low"].values
        close_v= df["close"].values
        open_v = df["open"].values

        # Collect zones: (bottom, top, start_idx, expire_idx)
        zones: List[Tuple[float, float, int, int]] = []

        for i in range(2, n):
            a = atr_v[i] if not (math.isnan(atr_v[i]) if isinstance(atr_v[i], float) else False) else 1.0

            # (A) Bullish FVG: gap up between bar i-2 top and bar i bottom
            if low_v[i] > high_v[i - 2]:
                bottom = high_v[i - 2]
                top    = low_v[i]
                if top > bottom:
                    zones.append((bottom, top, i, min(i + 60, n)))

            # (B) Bullish Order Block
            if i >= 3:
                # bearish candle at i-1
                if close_v[i - 1] < open_v[i - 1]:
                    # strong bullish impulse within next 3 bars
                    look_end = min(i + 3, n)
                    impulse  = max(close_v[i:look_end], default=close_v[i-1]) - close_v[i - 1]
                    if impulse >= 1.5 * a:
                        bottom = low_v[i - 1]
                        top    = high_v[i - 1]
                        if top > bottom:
                            zones.append((bottom, top, i, min(i + 40, n)))

        # Mark bars
        result = np.zeros(n, dtype=bool)
        for (bottom, top, start, expire) in zones:
            seg = close_v[start:expire]
            in_range = (seg >= bottom) & (seg <= top)
            # Invalidate from first close below bottom
            below = np.where(seg < bottom)[0]
            if len(below) > 0:
                in_range[below[0]:] = False
            result[start:expire] |= in_range

        return pd.Series(result, index=df.index, dtype=bool)

    def _detect_fp_zones(self, df: pd.DataFrame) -> pd.Series:
        """
        Prior-session footprint zone proximity gate (OHLCV proxy).

        True when ALL of:
          1. Bar is bearish (close < open) — price retracing into support
          2. Price is within FP_TICK_THRESHOLD of a bullish zone (FVG or OB)
             formed in a PREVIOUS RTH session (never today's session)
          3. Zone has not been invalidated by a prior close below zone bottom
        """
        n       = len(df)
        rth_v   = df["rth"].values
        high_v  = df["high"].values
        low_v   = df["low"].values
        close_v = df["close"].values
        open_v  = df["open"].values
        time_v  = df["time"].values
        atr_v   = df["atr"].values if "atr" in df.columns else np.ones(n)

        today_str = datetime.utcnow().strftime("%Y-%m-%d")

        def _bar_date(ts: int) -> str:
            return datetime.utcfromtimestamp(int(ts)).strftime("%Y-%m-%d")

        # Collect prior-session bullish zones
        raw_zones: List[Tuple[float, float, int]] = []
        for i in range(2, n):
            if not rth_v[i]:
                continue
            if _bar_date(int(time_v[i])) == today_str:
                continue
            a = float(atr_v[i])
            if math.isnan(a) or a <= 0:
                a = 1.0

            # FVG: gap up
            if low_v[i] > high_v[i - 2]:
                bottom, top = high_v[i - 2], low_v[i]
                if top > bottom:
                    raw_zones.append((bottom, top, i))

            # Bullish OB: bearish bar followed by ≥1.5 ATR impulse
            if i >= 3 and close_v[i - 1] < open_v[i - 1]:
                seg     = close_v[i:min(i + 3, n)]
                impulse = (seg.max() if len(seg) > 0 else close_v[i - 1]) - close_v[i - 1]
                if impulse >= 1.5 * a:
                    bottom, top = low_v[i - 1], high_v[i - 1]
                    if top > bottom:
                        raw_zones.append((bottom, top, i))

        # Pre-compute invalidation index for each zone
        zones: List[Tuple[float, float, int, int]] = []
        for (bottom, top, formed) in raw_zones:
            inv_idx = n
            for k in range(formed + 1, n):
                if close_v[k] < bottom:
                    inv_idx = k
                    break
            zones.append((bottom, top, formed, inv_idx))

        result = np.zeros(n, dtype=bool)
        for j in range(n):
            if close_v[j] >= open_v[j]:
                continue  # must be bearish
            price = close_v[j]
            for (bottom, top, formed, inv) in zones:
                if formed >= j or inv <= j:
                    continue
                if (price >= bottom - FP_TICK_THRESHOLD) and (price <= top + FP_TICK_THRESHOLD):
                    result[j] = True
                    break

        return pd.Series(result, index=df.index, dtype=bool)

    def _detect_today_milk_zones(self, df: pd.DataFrame) -> pd.Series:
        """
        Milk zone detection restricted to current RTH session (today only).
        Yesterday's zones never qualify — spec requirement.
        Logic identical to _detect_milk_zones but gated on today's UTC date.
        """
        n       = len(df)
        rth_v   = df["rth"].values
        high_v  = df["high"].values
        low_v   = df["low"].values
        close_v = df["close"].values
        open_v  = df["open"].values
        time_v  = df["time"].values
        atr_v   = df["atr"].values if "atr" in df.columns else np.ones(n)

        today_str = datetime.utcnow().strftime("%Y-%m-%d")

        def _bar_date(ts: int) -> str:
            return datetime.utcfromtimestamp(int(ts)).strftime("%Y-%m-%d")

        zones: List[Tuple[float, float, int, int]] = []
        for i in range(2, n):
            if not rth_v[i]:
                continue
            if _bar_date(int(time_v[i])) != today_str:
                continue
            a = float(atr_v[i])
            if math.isnan(a) or a <= 0:
                a = 1.0

            # FVG
            if low_v[i] > high_v[i - 2]:
                bottom, top = high_v[i - 2], low_v[i]
                if top > bottom:
                    zones.append((bottom, top, i, min(i + 60, n)))

            # Bullish OB
            if i >= 3 and close_v[i - 1] < open_v[i - 1]:
                seg     = close_v[i:min(i + 3, n)]
                impulse = (seg.max() if len(seg) > 0 else close_v[i - 1]) - close_v[i - 1]
                if impulse >= 1.5 * a:
                    bottom, top = low_v[i - 1], high_v[i - 1]
                    if top > bottom:
                        zones.append((bottom, top, i, min(i + 40, n)))

        result = np.zeros(n, dtype=bool)
        for (bottom, top, start, expire) in zones:
            seg      = close_v[start:expire]
            in_range = (seg >= bottom) & (seg <= top)
            below    = np.where(seg < bottom)[0]
            if len(below) > 0:
                in_range[below[0]:] = False
            result[start:expire] |= in_range

        return pd.Series(result, index=df.index, dtype=bool)

    def _detect_vector_side_entry(self, df: pd.DataFrame) -> pd.Series:
        """
        True when price crosses from at-or-below vector to above on this bar.
        Two forms:
          (A) Rising vector cross: prev_close <= prev_vector AND curr_close > curr_vector
          (B) Tabletop cross:      vector is flat (vector == vector_3) — same cross condition
        vec_ok (rising only) is kept as a legacy alias; vec_side is the preferred gate.
        """
        if "vector" not in df.columns:
            df = df.copy()
            df["vector"] = df["low"].rolling(VECTOR_PERIOD).min().rolling(VECTOR_PERIOD).max()
        if "vector_3" not in df.columns:
            df = df.copy()
            df["vector_3"] = df["vector"].shift(3)

        cl       = df["close"]
        vec      = df["vector"]
        vec3     = df["vector_3"]
        prev_cl  = cl.shift(1)
        prev_vec = vec.shift(1)

        cross_above = (prev_cl <= prev_vec) & (cl > vec)
        tabletop    = (vec == vec3) & cross_above

        return (cross_above | tabletop).fillna(False)

    # --------------------------------------------------------------------------
    # SIGNAL DETECTION  (Footprint-first, per spec)
    # --------------------------------------------------------------------------

    def detect_signals(self, df: pd.DataFrame, symbol: str = "", resolution: str = "") -> pd.DataFrame:
        """
        Confluence signal detection with session-aware gating.

        RTH — no required gate; fire if there is enough confluence:
          Counts: fp_ok + milk_ok (today RTH) + vec_side + body_ok  (max 4)
          SAFE      = count >= 3
          RISKY     = count == 2
          RISKIEST  = count == 1
          Closing-hour gate: 20:00–21:00 UTC → safe only.

        ETH — footprint zone proximity (fp_ok) is REQUIRED:
          No FP = no signal, regardless of other confirmations.
          Available additions: vec_side, body_ok  (milk_ok is always off in ETH)
          count = 1 (fp) + vec_side + body_ok  (max 3)
          Must reach ETH_MIN_CONFIRMATIONS (2) — RISKIEST never fires in ETH.

        Cooldown: 10 RTH bars / 20 ETH bars between signals (unchanged).
        Adds column 'signal_tier': "safe" | "risky" | "riskiest" | ""
        """
        if "fp_ok" not in df.columns:
            df = self.compute_indicators(df)

        n        = len(df)
        tier_col = [""] * n
        last_bar = {"rth": -(COOLDOWN_RTH + 1), "eth": -(COOLDOWN_ETH + 1)}

        fp_ok_v   = df["fp_ok"].values
        milk_ok_v = df["milk_ok"].values
        vec_side_v = df["vec_side"].values
        body_ok_v  = df["body_ok"].values
        rth_v      = df["rth"].values
        time_v     = df["time"].values

        warmup = VECTOR_PERIOD + ATR_PERIOD

        for i in range(warmup, n - 1):
            is_rth = bool(rth_v[i])
            fp  = bool(fp_ok_v[i])
            m   = bool(milk_ok_v[i])
            vs  = bool(vec_side_v[i])
            b   = bool(body_ok_v[i])

            if is_rth:
                # RTH: count all confirmations, no single one required
                count = int(fp) + int(m) + int(vs) + int(b)
                if count == 0:
                    continue
                tier = "safe" if count >= 3 else "risky" if count >= 2 else "riskiest"

                # Closing-hour gate (last 60 min RTH → safe only)
                dt = datetime.utcfromtimestamp(int(time_v[i]))
                if dt.hour >= 20 and tier != "safe":
                    continue
            else:
                # ETH: footprint required
                if not fp:
                    continue
                # milk_ok is always False in ETH (today-RTH-only zones)
                count = 1 + int(vs) + int(b)
                if count < ETH_MIN_CONFIRMATIONS:
                    continue
                tier = "safe" if count >= 3 else "risky"
                # RISKIEST never fires in ETH (count >= 2 enforced above)

            # Cooldown
            key      = "rth" if is_rth else "eth"
            cooldown = COOLDOWN_RTH if is_rth else COOLDOWN_ETH
            if i - last_bar[key] < cooldown:
                continue

            last_bar[key] = i
            tier_col[i]   = tier

        df = df.copy()
        df["signal_tier"] = tier_col
        return df

    # --------------------------------------------------------------------------
    # FORWARD PATH BUILDER
    # --------------------------------------------------------------------------

    def _build_forward_paths(
        self,
        df:             pd.DataFrame,
        signal_indices: List[int],
        forward_bars:   int = FORWARD_BARS,
    ) -> List[Dict[str, Any]]:
        """
        For each signal bar, extract a normalised forward price path.

        Normalisation by ATR makes paths comparable across different
        price levels and volatility regimes ? no random walk needed,
        we sample the real empirical distributions.

        Each path dict:
          entry      ? close at signal bar
          atr        ? ATR at signal bar
          norm_high  ? (forward_bars,) float32 array: (high[t+k] - entry) / atr
          norm_low   ? (forward_bars,) float32 array: (low[t+k]  - entry) / atr
          mfe        ? max(norm_high)  best-case excursion
          mae        ? min(norm_low)   worst-case adverse excursion
          terminal   ? normalised close at bar forward_bars
        """
        high_v  = df["high"].values
        low_v   = df["low"].values
        close_v = df["close"].values
        atr_v   = df["atr"].values
        n       = len(df)

        paths = []
        for idx in signal_indices:
            entry = float(close_v[idx])
            a     = float(atr_v[idx])
            if math.isnan(a) or a <= 0:
                continue

            end = min(idx + forward_bars + 1, n)
            fwd_h = (high_v[idx + 1 : end] - entry) / a
            fwd_l = (low_v[idx + 1  : end] - entry) / a

            if len(fwd_h) < 5:        # too close to dataset end
                continue

            # Pad short tails with last value to maintain fixed length
            pad = forward_bars - len(fwd_h)
            if pad > 0:
                fwd_h = np.concatenate([fwd_h, np.full(pad, fwd_h[-1])])
                fwd_l = np.concatenate([fwd_l, np.full(pad, fwd_l[-1])])

            terminal = float((close_v[min(idx + forward_bars, n - 1)] - entry) / a)

            paths.append({
                "entry":     entry,
                "atr":       a,
                "norm_high": fwd_h.astype(np.float32),
                "norm_low":  fwd_l.astype(np.float32),
                "mfe":       float(fwd_h.max()),
                "mae":       float(fwd_l.min()),
                "terminal":  terminal,
            })

        return paths

    # --------------------------------------------------------------------------
    # VECTORISED OUTCOME MATRIX
    # --------------------------------------------------------------------------

    @staticmethod
    def _build_outcome_matrix(
        paths:       List[Dict],
        tp_grid:     np.ndarray,   # (T,)
        sl_grid:     np.ndarray,   # (S,)
    ) -> np.ndarray:
        """
        Pre-compute the outcome for every path ? (TP, SL) combination.

        outcome[k, t, s] =
          +tp_grid[t]   if TP hit before SL
          -sl_grid[s]   if SL hit before TP
          terminal[k]   if neither hit within forward_bars

        Fully vectorised with numpy ? runs in <1 s for 300 paths ? 24?20 grid.
        """
        K = len(paths)
        T = len(tp_grid)
        S = len(sl_grid)
        F = len(paths[0]["norm_high"]) if paths else 1

        outcome = np.empty((K, T, S), dtype=np.float32)

        for k, path in enumerate(paths):
            nh  = path["norm_high"]   # (F,)
            nl  = path["norm_low"]    # (F,)
            ter = np.float32(path["terminal"])

            # First bar index where each TP/SL level is crossed
            # tp_crossed[f, t] = nh[f] >= tp_grid[t]
            tp_cross = nh[:, np.newaxis] >= tp_grid[np.newaxis, :]   # (F, T)
            sl_cross = nl[:, np.newaxis] <= -sl_grid[np.newaxis, :]  # (F, S)

            tp_first = np.where(tp_cross.any(axis=0), tp_cross.argmax(axis=0), F)  # (T,)
            sl_first = np.where(sl_cross.any(axis=0), sl_cross.argmax(axis=0), F)  # (S,)

            # Compare: (T, 1) vs (1, S)
            tp_mat = tp_first[:, np.newaxis]   # (T, 1)
            sl_mat = sl_first[np.newaxis, :]   # (1, S)

            outcome[k] = np.where(
                tp_mat < sl_mat,
                tp_grid[:, np.newaxis].astype(np.float32),
                np.where(
                    sl_mat < tp_mat,
                    (-sl_grid[np.newaxis, :]).astype(np.float32),
                    ter,
                ),
            )

        return outcome   # (K, T, S)

    # --------------------------------------------------------------------------
    # MONTE CARLO CORE
    # --------------------------------------------------------------------------

    def _run_mc_for_tier(
        self,
        paths:  List[Dict],
        tier:   str,
        n_iter: int = MC_ITERATIONS,
    ) -> TierCalibration:
        """
        Block-bootstrap Monte Carlo for a single tier.

        Each iteration:
          1. Sample K paths with replacement (preserves empirical distribution)
          2. Compute mean EV across the (TP, SL) grid for this sample
        After n_iter iterations:
          3. Find (TP*, SL*) = argmax mean EV
          4. Compute 95 % CI, win rates, TP2 (secondary target)
        """
        if len(paths) < 5:
            return self._default_calibration(tier, len(paths))

        # ── Problem 2 Step B + Problem 3 Step A: MAE/MFE distributions ──────────
        # MAE is the worst adverse move before TP or exit (stored as negative float)
        # Use absolute value: how far against entry did price go?
        mae_abs  = np.array([abs(p["mae"]) for p in paths])
        mfe_vals = np.array([p["mfe"]      for p in paths])

        # 70th percentile MAE: 70% of trades did NOT move against entry by more than this
        mae_p70 = float(np.percentile(mae_abs, MAE_PERCENTILE))

        # 50th/75th percentile MFE: TP1 reached on 50% of trades, TP2 on 25%
        mfe_p50 = float(np.percentile(mfe_vals, MFE_TP1_PCTILE))
        mfe_p75 = float(np.percentile(mfe_vals, MFE_TP2_PCTILE))

        if self.verbose:
            _log(f"  [{tier:>9}] MAE-p70={mae_p70:.3f}x  MFE-p50={mfe_p50:.3f}x  MFE-p75={mfe_p75:.3f}x ATR")
        # ────────────────────────────────────────────────────────────────────────

        K       = len(paths)
        tp_grid = np.array(TP_GRID_ATR, dtype=np.float32)
        sl_grid = np.array(SL_GRID_ATR, dtype=np.float32)
        T, S    = len(tp_grid), len(sl_grid)

        # Apply tier-specific SL cap
        sl_cap = TIER_SL_CAP_ATR.get(tier, 2.0)
        sl_mask = sl_grid <= sl_cap    # boolean mask for valid SL columns

        if self.verbose:
            _log(f"  [{tier:>9}] outcome matrix ({K} paths x {T}x{S} grid)", end=" ")
        t0 = time.time()
        om = self._build_outcome_matrix(paths, tp_grid, sl_grid)    # (K, T, S)
        if self.verbose:
            _log(f"({time.time()-t0:.1f}s)")

        # -- Bootstrap ---------------------------------------------------------
        rng      = np.random.default_rng(seed=42)
        ev_accum = np.zeros((T, S), dtype=np.float64)
        ev_sq    = np.zeros((T, S), dtype=np.float64)

        if self.verbose:
            _log(f"  [{tier:>9}] {n_iter:,} bootstrap iterations", end=" ")
        t0 = time.time()

        for _ in range(n_iter):
            idx    = rng.integers(0, K, size=K)
            sample = om[idx]               # (K, T, S)
            ev     = sample.mean(axis=0)   # (T, S)
            ev_accum += ev
            ev_sq    += ev * ev

        mean_ev = ev_accum / n_iter
        var_ev  = np.maximum(ev_sq / n_iter - mean_ev ** 2, 0)
        std_ev  = np.sqrt(var_ev)

        if self.verbose:
            _log(f"({time.time()-t0:.1f}s)")

        # -- Apply SL cap mask (zero out disallowed SL columns) -----------------
        masked_ev = mean_ev.copy()
        masked_ev[:, ~sl_mask] = -np.inf

        # -- Find optimal (TP*, SL*) --------------------------------------------
        flat_best        = int(np.argmax(masked_ev))
        best_ti, best_si = np.unravel_index(flat_best, masked_ev.shape)
        best_tp          = float(tp_grid[best_ti])
        best_sl          = float(sl_grid[best_si])
        best_ev          = float(mean_ev[best_ti, best_si])
        best_std         = float(std_ev[best_ti, best_si])
        ev_ci_low        = best_ev - 1.96 * best_std / math.sqrt(n_iter)
        ev_ci_high       = best_ev + 1.96 * best_std / math.sqrt(n_iter)

        # Win rate at optimal point (full dataset, not bootstrap)
        win_mask_1  = om[:, best_ti, best_si] > 0
        win_rate_1  = float(win_mask_1.mean())

        # -- TP2: highest TP at the same SL that still has EV ? 40 % of best --
        tp2_atr  = best_tp
        tp2_ti   = best_ti
        for ti2 in range(best_ti + 1, T):
            if not sl_mask[best_si]:
                break
            ev2 = float(mean_ev[ti2, best_si])
            if ev2 >= 0.40 * best_ev:
                tp2_atr = float(tp_grid[ti2])
                tp2_ti  = ti2
            else:
                break

        win_mask_2  = om[:, tp2_ti, best_si] > 0
        win_rate_2  = float(win_mask_2.mean())

        # Combined EV: 50 % exit at TP1, 50 % at TP2 (same SL for full position)
        ev_tp2     = float(mean_ev[tp2_ti, best_si])
        ev_combined = 0.5 * best_ev + 0.5 * ev_tp2

        # -- Top-5 cells for audit table ---------------------------------------
        flat_sort = np.argsort(masked_ev.ravel())[::-1][:5]
        top5 = []
        for fi in flat_sort:
            ti_, si_ = np.unravel_index(fi, masked_ev.shape)
            if masked_ev[ti_, si_] == -np.inf:
                continue
            top5.append({
                "tp_atr": round(float(tp_grid[ti_]), 2),
                "sl_atr": round(float(sl_grid[si_]), 2),
                "ev":     round(float(mean_ev[ti_, si_]), 4),
                "wr":     round(float((om[:, ti_, si_] > 0).mean()), 3),
            })

        return TierCalibration(
            tier          = tier,
            sl_atr        = best_sl,
            tp1_atr       = best_tp,
            tp2_atr       = tp2_atr,
            win_rate_tp1  = win_rate_1,
            win_rate_tp2  = win_rate_2,
            ev_tp1        = best_ev,
            ev_combined   = ev_combined,
            sample_count  = K,
            calibrated_at = datetime.now(timezone.utc).isoformat(),
            ev_ci_low     = ev_ci_low,
            ev_ci_high    = ev_ci_high,
            top5          = top5,
            mae_p70_atr   = mae_p70,
            mfe_p50_atr   = mfe_p50,
            mfe_p75_atr   = mfe_p75,
        )

    # --------------------------------------------------------------------------
    # PUBLIC: CALIBRATE
    # --------------------------------------------------------------------------

    def calibrate(
        self,
        symbol:     str = "MES",
        resolution: str = "5",
        from_ts:    int = 0,
        to_ts:      int = 0,
        n_iter:     int = MC_ITERATIONS,
    ) -> Dict[str, TierCalibration]:
        """
        Full calibration pipeline:
          1. Fetch candles from PostgreSQL (cached_candles table)
          2. Compute vector/ATR/zone indicators
          3. Detect Safe / Risky / Riskiest signals
          4. Build normalised forward paths per tier
          5. Run bootstrap Monte Carlo for each tier
          6. Persist results to exit_strategy_calibration.json
          7. Print summary table

        Returns dict keyed by tier name.
        """
        if self.verbose:
            print(f"\n{'='*62}")
            print(f"  MC Calibration  |  {symbol}  resolution={resolution}m")
            print(f"{'='*62}")

        df = self.fetch_candles(symbol, resolution, from_ts, to_ts)
        if df.empty:
            raise ValueError(
                f"No candles found for {symbol} res={resolution}. "
                "Run a data download in the Data tab first."
            )

        date_range = (
            f"{datetime.utcfromtimestamp(df.time.iloc[0]).date()} -> "
            f"{datetime.utcfromtimestamp(df.time.iloc[-1]).date()}"
        )
        if self.verbose:
            print(f"  Loaded {len(df):,} bars  ({date_range})")

        df  = self.compute_indicators(df)
        df  = self.detect_signals(df)
        sig = df[df["signal_tier"] != ""]
        counts = sig["signal_tier"].value_counts().to_dict()

        if self.verbose:
            print(f"  Signals detected: {counts}")
            print()

        results: Dict[str, TierCalibration] = {}

        for tier in ("safe", "risky", "riskiest"):
            idx   = df.index[df["signal_tier"] == tier].tolist()
            paths = self._build_forward_paths(df, idx, FORWARD_BARS)
            if self.verbose:
                print(f"  -- {tier.upper():<9} ({len(idx)} signals, {len(paths)} valid paths) --")
            cal            = self._run_mc_for_tier(paths, tier, n_iter)
            cal.date_range = date_range
            results[tier]  = cal
            if self.verbose:
                print()

        self._calibration = results
        self._save_calibration()
        self._disconnect()

        if self.verbose:
            self.print_summary()

        return results

    # --------------------------------------------------------------------------
    # PUBLIC: EMIT LIVE SIGNAL  (single call site for live signal persistence)
    # --------------------------------------------------------------------------

    def emit_live_signal(
        self,
        df:         pd.DataFrame,
        symbol:     str,
        resolution: str,
    ) -> Tuple[Optional[str], Optional["ExitParams"], Optional["PartialExitPlan"]]:
        """
        Check whether the most recently CLOSED bar carries a signal, and if so
        emit it permanently to the SignalStore.

        This is the only correct call site for live signal persistence.
        Signals written here are append-only — they can never be deleted or
        modified by any subsequent bar update or recalculation.

        Parameters
        ----------
        df         - DataFrame with at least the most recent N bars (already
                     fetched from the DB or passed from live feed).
                     Must contain: time, open, high, low, close, volume, rth.
        symbol     - Instrument symbol, e.g. "MES".
        resolution - Bar resolution string, e.g. "5".

        Returns
        -------
        (tier, exit_params, partial_plan)  if a NEW signal was emitted
        (tier, None, None)                 if the signal was already stored
        (None, None, None)                 if no signal on the last closed bar
        """
        if len(df) < 2:
            return (None, None, None)

        df_sig = self.detect_signals(df, symbol=symbol, resolution=resolution)

        # Last CLOSED bar is index -2 (index -1 is the still-forming bar)
        last_closed = df_sig.iloc[-2]
        tier: str = last_closed["signal_tier"]

        if not tier:
            return (None, None, None)

        bar_time  = int(last_closed["time"])
        entry     = float(last_closed["close"])
        atr_val   = float(last_closed["atr"]) if "atr" in last_closed.index else None
        is_rth    = bool(last_closed.get("rth", False))

        record = {
            "symbol":      symbol,
            "resolution":  resolution,
            "bar_time":    bar_time,
            "tier":        tier,
            "entry_price": entry,
            "atr":         round(atr_val, 4) if atr_val else None,
            "rth":         is_rth,
            "emitted_at":  datetime.utcnow().isoformat() + "Z",
            "fp_ok":       bool(last_closed.get("fp_ok",    False)),
            "milk_ok":     bool(last_closed.get("milk_ok",  False)),
            "vec_side":    bool(last_closed.get("vec_side", False)),
            "body_ok":     bool(last_closed.get("body_ok",  False)),
        }

        added = self._store.add(record)

        exits = self.get_exits(tier, entry, atr=atr_val)
        plan  = self.get_partial_exit_plan(exits)

        if self.verbose:
            status = "NEW" if added else "DUPLICATE (already stored)"
            print(
                f"[emit_live_signal] {status} | {symbol} {resolution}m | "
                f"{tier.upper()} @ {entry} | bar_time={bar_time}"
            )

        return (tier, exits if added else None, plan if added else None)

    # --------------------------------------------------------------------------
    # PUBLIC: GET EXITS FOR LIVE SIGNAL
    # --------------------------------------------------------------------------

    def get_exits(
        self,
        tier:        str,
        entry_price: float,
        atr:         Optional[float] = None,
    ) -> ExitParams:
        """
        Return calibrated exit levels for a live signal.

        Parameters
        ----------
        tier         - "safe" | "risky" | "riskiest"
        entry_price  - signal entry price (typically the close of the signal bar)
        atr          - current 14-period ATR in price units; if None, uses 8.0 pts

        Returns ExitParams with TP1, TP2, SL, win rates, and EV.
        """
        tier = tier.lower().strip()
        cal  = self._calibration.get(tier)

        if cal is None or cal.sample_count < 5:
            return self._default_exits(tier, entry_price, atr)

        atr_used = atr if (atr and atr > 0) else 8.0

        # Step A — ATR-based minimum SL buffer (1.25x ATR floor)
        atr_floor = ATR_SL_MIN_MULT * atr_used

        # Step B — Monte Carlo MAE floor: use 70th pct MAE from calibration
        mae_dist = cal.mae_p70_atr * atr_used if cal.mae_p70_atr > 0 else 0.0

        # base SL = largest of: ATR floor, MC MAE 70th pct, MC-optimised SL
        base_sl = max(atr_floor, mae_dist, cal.sl_atr * atr_used)

        # Step C — tier scaling multiplier
        tier_mult = TIER_SL_MULT.get(tier, 1.0)
        sl_dist   = base_sl * tier_mult

        # TP distances — prefer MFE percentile targets, fall back to MC-optimised
        tp1_dist = (cal.mfe_p50_atr * atr_used) if cal.mfe_p50_atr > 0 else (cal.tp1_atr * atr_used)
        tp2_dist = (cal.mfe_p75_atr * atr_used) if cal.mfe_p75_atr > 0 else (cal.tp2_atr * atr_used)

        def _ticks(dist: float) -> int:
            return max(1, round(dist / self.tick_size))

        def _price(dist: float, sign: int) -> float:
            t = _ticks(dist)
            return round(entry_price + sign * t * self.tick_size, 2)

        rr_tp1 = tp1_dist / sl_dist if sl_dist > 0 else 0.0
        rr_tp2 = tp2_dist / sl_dist if sl_dist > 0 else 0.0

        if rr_tp1 < MIN_RR_TP1:
            print(f"WARNING: [{tier}] TP1 R:R={rr_tp1:.2f} below minimum {MIN_RR_TP1} "
                  f"(SL={sl_dist:.2f}pts, TP1={tp1_dist:.2f}pts)")
        if rr_tp2 < MIN_RR_TP2:
            print(f"WARNING: [{tier}] TP2 R:R={rr_tp2:.2f} below minimum {MIN_RR_TP2} "
                  f"(SL={sl_dist:.2f}pts, TP2={tp2_dist:.2f}pts)")

        confidence = (
            "HIGH"   if cal.sample_count >= 50 else
            "MEDIUM" if cal.sample_count >= 20 else
            "LOW"
        )

        ev_ticks   = cal.ev_tp1 * (atr_used / self.tick_size)
        ev_dollars = ev_ticks * self.tick_value

        return ExitParams(
            tier                  = tier,
            entry_price           = entry_price,
            sl_price              = _price(sl_dist,  -1),
            tp1_price             = _price(tp1_dist, +1),
            tp2_price             = _price(tp2_dist, +1),
            sl_ticks              = _ticks(sl_dist),
            tp1_ticks             = _ticks(tp1_dist),
            tp2_ticks             = _ticks(tp2_dist),
            win_rate_tp1          = cal.win_rate_tp1,
            win_rate_tp2          = cal.win_rate_tp2,
            ev_per_trade          = round(ev_ticks, 2),
            ev_dollars            = round(ev_dollars, 2),
            confidence            = confidence,
            sample_count          = cal.sample_count,
            atr_used              = round(atr_used, 4),
            atr_14                = round(atr_used, 4),
            rr_ratio_tp1          = round(rr_tp1, 3),
            rr_ratio_tp2          = round(rr_tp2, 3),
            monte_carlo_mae_used  = round(_ticks(mae_dist), 2),
            candle_close_confirmed= True,
        )

    # --------------------------------------------------------------------------
    # --------------------------------------------------------------------------
    # PUBLIC: PARTIAL EXIT PLAN
    # --------------------------------------------------------------------------

    def get_partial_exit_plan(self, exit_params: ExitParams) -> PartialExitPlan:
        """
        Build a 50/50 scale-out plan from ExitParams:
          - Close 50% at TP1, move SL to breakeven
          - Close remaining 50% at TP2
        """
        return PartialExitPlan(
            first_exit_price  = exit_params.tp1_price,
            first_exit_pct    = 0.50,
            breakeven_sl      = exit_params.entry_price,
            second_exit_price = exit_params.tp2_price,
            second_exit_pct   = 0.50,
        )

    # --------------------------------------------------------------------------
    # PUBLIC: LOG TRADE OUTCOME
    # --------------------------------------------------------------------------

    def log_outcome(
        self,
        signal_time: int,
        tier:        str,
        entry:       float,
        exit_price:  float,
        outcome:     str,          # "Win" | "Loss" | "Open"
        tp1:         float = 0.0,
        tp2:         float = 0.0,
        sl:          float = 0.0,
        notes:       str   = "",
    ) -> None:
        """
        Append a completed trade's result to the outcomes log (JSONL format).
        Re-run calibrate() periodically to incorporate new trades.
        """
        record = {
            "signal_time": signal_time,
            "tier":        tier,
            "entry":       entry,
            "exit_price":  exit_price,
            "pnl_pts":     round(exit_price - entry, 4),
            "outcome":     outcome,
            "tp1":         tp1,
            "tp2":         tp2,
            "sl":          sl,
            "logged_at":   datetime.now(timezone.utc).isoformat(),
            "notes":       notes,
        }
        with open(OUTCOMES_LOG, "a") as fh:
            fh.write(json.dumps(record) + "\n")

    # --------------------------------------------------------------------------
    # PUBLIC: PRINT SUMMARY TABLE
    # --------------------------------------------------------------------------

    def print_summary(self) -> None:
        """Print a formatted calibration summary table."""
        if not self._calibration:
            print("No calibration data. Run: python exit_strategy.py calibrate")
            return

        atr_ref = 8.0
        W = 78

        # Header info from first available calibration
        first_cal = next(iter(self._calibration.values()), None)
        date_range   = first_cal.date_range    if first_cal else ""
        cal_at       = first_cal.calibrated_at if first_cal else ""
        total_signals = sum(c.sample_count for c in self._calibration.values())

        print(f"\n┌{'─'*W}┐")
        title = "MILKS YELLOW BOX STRATEGY — CALIBRATION SUMMARY"
        print(f"│  {title:<{W-2}}│")
        meta = f"Signals: {total_signals}  |  Range: {date_range}  |  Last calibrated: {cal_at[:19]}"
        print(f"│  {meta:<{W-2}}│")
        print(f"├{'─'*W}┤")

        hdr = f"{'Tier':<9} │ {'Stop Loss':>10} │ {'TP1':>10} │ {'TP2':>10} │ {'Win %':>7} │ {'EV/Trade':>9} │ {'MAE-p70':>8}"
        print(f"│  {hdr:<{W-2}}│")
        print(f"├{'─'*W}┤")

        for tier in ("safe", "risky", "riskiest"):
            cal = self._calibration.get(tier)
            if not cal:
                row = f"{tier.upper():<9}   (not calibrated)"
                print(f"│  {row:<{W-2}}│")
                continue

            sl_t   = round(cal.sl_atr  * atr_ref / self.tick_size)
            tp1_t  = round(cal.tp1_atr * atr_ref / self.tick_size)
            tp2_t  = round(cal.tp2_atr * atr_ref / self.tick_size)
            ev_d   = cal.ev_tp1 * (atr_ref / self.tick_size) * self.tick_value
            mae_t  = round(cal.mae_p70_atr * atr_ref / self.tick_size) if cal.mae_p70_atr > 0 else 0

            row = (
                f"{tier.upper():<9} │ {f'-{sl_t}t ({cal.sl_atr:.2f}x)':>10} │"
                f" {f'+{tp1_t}t ({cal.tp1_atr:.2f}x)':>10} │"
                f" {f'+{tp2_t}t ({cal.tp2_atr:.2f}x)':>10} │"
                f" {cal.win_rate_tp1*100:>6.1f}% │"
                f" ${ev_d:>+8.2f} │"
                f" {f'-{mae_t}t':>8}"
            )
            print(f"│  {row:<{W-2}}│")

            ci_row = (
                f"{'':9}   95%CI[{cal.ev_ci_low:+.3f},{cal.ev_ci_high:+.3f}]  "
                f"MFE-p50={cal.mfe_p50_atr:.2f}x  MFE-p75={cal.mfe_p75_atr:.2f}x  "
                f"n={cal.sample_count}"
            )
            print(f"│  {ci_row:<{W-2}}│")

        print(f"└{'─'*W}┘")
        print()

    # --------------------------------------------------------------------------
    # CALIBRATION PERSISTENCE
    # --------------------------------------------------------------------------

    def _save_calibration(self) -> None:
        data = {k: asdict(v) for k, v in self._calibration.items()}
        try:
            CALIBRATION_FILE.write_text(json.dumps(data, indent=2))
            if self.verbose:
                print(f"  Saved -> {CALIBRATION_FILE.name}")
        except Exception as exc:
            print(f"  Warning: could not save calibration: {exc}")

    def _load_calibration(self) -> None:
        if not CALIBRATION_FILE.exists():
            return
        try:
            import dataclasses
            valid_fields = {f.name for f in dataclasses.fields(TierCalibration)}
            raw = json.loads(CALIBRATION_FILE.read_text())
            for tier, d in raw.items():
                filtered = {k: v for k, v in d.items() if k in valid_fields}
                self._calibration[tier] = TierCalibration(**filtered)
            if self.verbose and self._calibration:
                ts = next(iter(self._calibration.values())).calibrated_at[:10]
                print(f"  Loaded calibration from {CALIBRATION_FILE.name} (run {ts})")
        except Exception as exc:
            print(f"  Warning: could not load calibration: {exc}")

    # --------------------------------------------------------------------------
    # DEFAULTS (pre-calibration or <5 samples)
    # --------------------------------------------------------------------------

    def _default_calibration(self, tier: str, sample_count: int) -> TierCalibration:
        """Conservative fallback calibration."""
        defaults = {
            "safe":     dict(sl=0.50, tp1=1.00, tp2=2.00),
            "risky":    dict(sl=0.40, tp1=0.75, tp2=1.50),
            "riskiest": dict(sl=0.25, tp1=0.50, tp2=1.00),
        }
        d = defaults.get(tier, defaults["riskiest"])
        return TierCalibration(
            tier=tier, sl_atr=d["sl"], tp1_atr=d["tp1"], tp2_atr=d["tp2"],
            win_rate_tp1=0.50, win_rate_tp2=0.40,
            ev_tp1=0.0, ev_combined=0.0, sample_count=sample_count,
            calibrated_at=datetime.now(timezone.utc).isoformat(),
            ev_ci_low=-0.1, ev_ci_high=0.1, top5=[],
        )

    def _default_exits(
        self,
        tier:        str,
        entry_price: float,
        atr:         Optional[float],
    ) -> ExitParams:
        atr_used = atr if (atr and atr > 0) else 8.0
        cal      = self._default_calibration(tier, 0)

        def _ticks(dist: float) -> int:
            return max(1, round(dist / self.tick_size))

        return ExitParams(
            tier         = tier,
            entry_price  = entry_price,
            sl_price     = round(entry_price - cal.sl_atr  * atr_used, 2),
            tp1_price    = round(entry_price + cal.tp1_atr * atr_used, 2),
            tp2_price    = round(entry_price + cal.tp2_atr * atr_used, 2),
            sl_ticks     = _ticks(cal.sl_atr  * atr_used),
            tp1_ticks    = _ticks(cal.tp1_atr * atr_used),
            tp2_ticks    = _ticks(cal.tp2_atr * atr_used),
            win_rate_tp1 = 0.50,
            win_rate_tp2 = 0.40,
            ev_per_trade = 0.0,
            ev_dollars   = 0.0,
            confidence   = "DEFAULT",
            sample_count = 0,
            atr_used     = atr_used,
        )


# ===============================================================================
# HELPERS
# ===============================================================================

def _log(msg: str, end: str = "\n") -> None:
    print(msg, end=end, flush=True)


# ===============================================================================
# STANDALONE RECALIBRATION + WEEKLY SCHEDULE
# ===============================================================================

def recalibrate_monte_carlo(
    symbol:     str = "MES",
    resolution: str = "5",
    tick_value: float = 1.25,
    n_iter:     int   = MC_ITERATIONS,
    verbose:    bool  = True,
) -> None:
    """Run a full MC calibration and print the summary. Called weekly or on demand."""
    if verbose:
        _log(f"\n[recalibrate_monte_carlo] Starting — {symbol} res={resolution}m  iter={n_iter:,}")
    try:
        engine = ExitStrategyEngine(tick_value=tick_value, verbose=verbose)
        engine.calibrate(symbol=symbol, resolution=resolution, n_iter=n_iter)
    except Exception as exc:
        _log(f"[recalibrate_monte_carlo] ERROR: {exc}")


def _seconds_until_next_sunday_midnight_et() -> float:
    """Return seconds from now until the next Sunday 00:00 ET (UTC-5 standard / UTC-4 DST)."""
    import time as _time
    now_utc = datetime.now(timezone.utc)
    # ET offset: use a fixed UTC-5 approximation (conservative; does not switch for DST)
    et_offset = -5
    now_et = now_utc + timedelta(hours=et_offset)
    # weekday(): Monday=0 … Sunday=6
    days_until_sunday = (6 - now_et.weekday()) % 7
    if days_until_sunday == 0 and now_et.hour >= 0:
        days_until_sunday = 7  # already past midnight Sunday — wait for next week
    next_sunday_et = now_et.replace(hour=0, minute=0, second=0, microsecond=0)
    next_sunday_et = next_sunday_et + timedelta(days=days_until_sunday)
    delta = (next_sunday_et - now_et).total_seconds()
    return max(delta, 1.0)


def _schedule_weekly_recalibration(
    symbol:     str   = "MES",
    resolution: str   = "5",
    tick_value: float = 1.25,
) -> None:
    """
    Schedule recalibrate_monte_carlo() to run every Sunday at midnight ET.
    Call once at process startup. Uses threading.Timer — non-blocking.
    """
    import threading

    def _fire() -> None:
        recalibrate_monte_carlo(symbol=symbol, resolution=resolution, tick_value=tick_value)
        _schedule_weekly_recalibration(symbol=symbol, resolution=resolution, tick_value=tick_value)

    delay = _seconds_until_next_sunday_midnight_et()
    t = threading.Timer(delay, _fire)
    t.daemon = True
    t.start()
    _log(f"[weekly_recal] Next run in {delay/3600:.1f}h  ({symbol} res={resolution}m)")


# ===============================================================================
# CLI
# ===============================================================================

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="exit_strategy.py",
        description="Milks Yellow Box ? Monte Carlo Exit Strategy Engine",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python exit_strategy.py calibrate --symbol MES --resolution 5
  python exit_strategy.py exits --tier safe --entry 5123.50 --atr 8.25
  python exit_strategy.py summary
""",
    )
    sub = p.add_subparsers(dest="cmd")

    # -- calibrate ----------------------------------------------------------
    c = sub.add_parser("calibrate", help="Run MC calibration on historical data from DB")
    c.add_argument("--symbol",     default="MES",   help="Instrument symbol (default: MES)")
    c.add_argument("--resolution", default="5",     help="Bar size in minutes: 1, 5, or 60 (default: 5)")
    c.add_argument("--from-ts",    default=0,       type=int,   help="Unix start timestamp (0 = all)")
    c.add_argument("--to-ts",      default=0,       type=int,   help="Unix end timestamp (0 = all)")
    c.add_argument("--iterations", default=10_000,  type=int,   help="MC iterations (default: 10000)")
    c.add_argument("--tick-value", default=1.25,    type=float, help="$/tick: MES=1.25, ES=12.50")
    c.add_argument("--csv",        default=None,                help="Load candles from CSV instead of DB")

    # -- exits --------------------------------------------------------------
    e = sub.add_parser("exits", help="Get calibrated exit levels for a live signal")
    e.add_argument("--tier",  required=True, choices=["safe","risky","riskiest"])
    e.add_argument("--entry", required=True, type=float, help="Entry price")
    e.add_argument("--atr",   default=None,  type=float, help="Current 14-period ATR")
    e.add_argument("--tick-value", default=1.25, type=float)

    # -- summary ------------------------------------------------------------
    sub.add_parser("summary", help="Print stored calibration results")

    # -- recalibrate --------------------------------------------------------
    r = sub.add_parser("recalibrate", help="Re-run MC calibration (same as calibrate, no CSV)")
    r.add_argument("--symbol",     default="MES",   help="Instrument symbol (default: MES)")
    r.add_argument("--resolution", default="5",     help="Bar size in minutes: 1, 5, or 60 (default: 5)")
    r.add_argument("--iterations", default=10_000,  type=int,   help="MC iterations (default: 10000)")
    r.add_argument("--tick-value", default=1.25,    type=float, help="$/tick: MES=1.25, ES=12.50")

    return p


def main() -> None:
    parser = _build_parser()
    args   = parser.parse_args()

    if args.cmd == "calibrate":
        engine = ExitStrategyEngine(tick_value=args.tick_value)
        if args.csv:
            # CSV path provided ? skip DB
            print(f"  Loading candles from {args.csv}")
            df = engine.load_candles_csv(args.csv)
            df = engine.compute_indicators(df)
            df = engine.detect_signals(df)
            counts = df[df["signal_tier"] != ""]["signal_tier"].value_counts().to_dict()
            print(f"  Signals: {counts}\n")
            csv_range = (
                f"{datetime.utcfromtimestamp(df.time.iloc[0]).date()} -> "
                f"{datetime.utcfromtimestamp(df.time.iloc[-1]).date()}"
            )
            results: Dict[str, TierCalibration] = {}
            for tier in ("safe", "risky", "riskiest"):
                idx            = df.index[df["signal_tier"] == tier].tolist()
                paths          = engine._build_forward_paths(df, idx, FORWARD_BARS)
                cal            = engine._run_mc_for_tier(paths, tier, args.iterations)
                cal.date_range = csv_range
                results[tier]  = cal
            engine._calibration = results
            engine._save_calibration()
            engine.print_summary()
        else:
            engine.calibrate(
                symbol=args.symbol,
                resolution=args.resolution,
                from_ts=args.from_ts,
                to_ts=args.to_ts,
                n_iter=args.iterations,
            )

    elif args.cmd == "exits":
        engine = ExitStrategyEngine(tick_value=args.tick_value, verbose=False)
        if not engine._calibration:
            print("No calibration found. Run: python exit_strategy.py calibrate")
            sys.exit(1)
        p = engine.get_exits(args.tier, args.entry, args.atr)
        pp = engine.get_partial_exit_plan(p)
        atr_str = f"ATR={p.atr_used:.2f}" if p.atr_used else ""
        print(f"\n{'-'*56}")
        print(f"  Signal tier  : {p.tier.upper()}  [{p.confidence}  n={p.sample_count}]")
        print(f"  Entry        : {p.entry_price:.2f}  {atr_str}")
        print(f"  Stop Loss    : {p.sl_price:.2f}  ({p.sl_ticks} ticks below)  MC-MAE={p.monte_carlo_mae_used:.0f}t")
        print(f"  TP1          : {p.tp1_price:.2f}  ({p.tp1_ticks} ticks above)  WR={p.win_rate_tp1*100:.1f}%  R:R={p.rr_ratio_tp1:.2f}")
        print(f"  TP2          : {p.tp2_price:.2f}  ({p.tp2_ticks} ticks above)  WR={p.win_rate_tp2*100:.1f}%  R:R={p.rr_ratio_tp2:.2f}")
        print(f"  EV / trade   : {p.ev_dollars:+.2f} USD  ({p.ev_per_trade:+.2f} ticks)")
        print(f"  Scale-out    : 50% @ {pp.first_exit_price:.2f}  ->  move SL to {pp.breakeven_sl:.2f}  ->  50% @ {pp.second_exit_price:.2f}")
        print(f"{'-'*56}\n")

    elif args.cmd == "summary":
        engine = ExitStrategyEngine(verbose=False)
        engine.print_summary()

    elif args.cmd == "recalibrate":
        recalibrate_monte_carlo(
            symbol=args.symbol,
            resolution=args.resolution,
            tick_value=args.tick_value,
            n_iter=args.iterations,
        )

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
