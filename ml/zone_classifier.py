"""
zone_classifier.py — MilkZone ML from .mwml annotation files.

Reads human-annotated zones from MotiveWave .mwml files, extracts features
from the PostgreSQL candle DB, labels zones by whether price respected them,
and trains a RandomForestClassifier.

Zone type vocabulary is based on Milk's actual MotiveWave labels (extracted
from 29,583 zones across 23 .mwml files, 2023-2026):
  IV WALL, NON FAIR VALUE, FLOOR, CEILING, PIVOT,
  BUYER POSITIONING, SELLER POSITIONING, BUYER OBJECTIVE, SELLER OBJECTIVE,
  BUYERS WILL VALUE ADD ON TEST, BUYERS WILL ABSORB SELLERS ON TEST,
  RTH GAP, MAX RANGE DAYS, MAX TREND DAYS, NORMAL RANGE DAYS,
  OVN SPY CEILING, OVN SPY FLOOR, SPY CEILING, SPY FLOOR,
  LTF BUYER POSITIONING, LTF SELLER POSITIONING, etc.

Usage:
  python ml/zone_classifier.py extract   -> parse .mwml files, save zones_raw.json
  python ml/zone_classifier.py features  -> enrich zones.json with DB candle features
  python ml/zone_classifier.py train     -> train RF classifier, save zone_model.pkl
  python ml/zone_classifier.py stats     -> print extraction + training stats
  python ml/zone_classifier.py predict <json_zone_features> -> {"score": float, "is_strong": bool}
  python ml/zone_classifier.py strong [min_score] [from_ts] [to_ts]
"""

import json
import os
import sys
import glob
import pickle
import bisect
import re
from pathlib import Path
from datetime import datetime, timezone

BASE_DIR   = Path(__file__).parent
ZONES_PATH = BASE_DIR / "zones_raw.json"
MODEL_PATH = BASE_DIR / "zone_model.pkl"

# ── Zone-type taxonomy ────────────────────────────────────────────────────────
# Maps normalized label text → canonical zone_type string
# Milk's vocabulary extracted from 19,456 text labels in 23 .mwml files

ZONE_TYPE_MAP: list[tuple[str, str]] = [
    # ── Institutional buyer positioning (strong support) ──────────────────
    ("BUYERS ULTIMATE TARGET",      "buyer_ultimate_target"),
    ("BUYERS WILL ABSORB",          "buyer_absorb"),
    ("BUYERS WILL VALUE ADD",       "buyer_value_add"),
    ("BUYER POSITIONING",           "buyer_positioning"),
    ("BUYER OBJECTIVE",             "buyer_objective"),
    ("BUYERS OBJECTIVE",            "buyer_objective"),
    ("LTF BUYER POSITIONING",       "buyer_positioning_ltf"),
    ("LTF BUYER OBJECTIVE",         "buyer_objective_ltf"),
    ("LTF BUYERS OBJECTIVE",        "buyer_objective_ltf"),
    ("SUPPORTIVE",                  "supportive"),
    ("SUPPORT",                     "support"),
    ("BOTTOM AVE RANGE",            "avg_range_low"),
    # ── Institutional seller positioning (strong resistance) ──────────────
    ("SELLERS ULTIMATE TARGET",     "seller_ultimate_target"),
    ("SELLERS WILL ABSORB",         "seller_absorb"),
    ("SELLERS SOFT TARGET",         "seller_soft_target"),
    ("SELLER POSITIONING",          "seller_positioning"),
    ("SELLER OBJECTIVE",            "seller_objective"),
    ("SELLERS OBJECTIVE",           "seller_objective"),
    ("LTF SELLER POSITIONING",      "seller_positioning_ltf"),
    ("LTF SELLER OBJECTIVE",        "seller_objective_ltf"),
    ("LTF SELLERS OBJECTIVE",       "seller_objective_ltf"),
    ("RESISTIVE",                   "resistive"),
    ("TOP AVE RANGE",               "avg_range_high"),
    ("POTENTIAL TO CAP SESSION",    "session_cap"),
    # ── Structural / volatility levels ────────────────────────────────────
    ("IV WALL",                     "iv_wall"),
    ("IV GAP",                      "iv_gap"),
    ("IV OVERFLOW",                 "iv_overflow"),
    ("NON FAIR VALUE",              "non_fair_value"),
    ("PIVOT",                       "pivot"),
    ("MACRO PIVOT",                 "pivot_macro"),
    ("SECONDARY PIVOT",             "pivot_secondary"),
    ("STRONG SELLER POSITIONING",   "seller_positioning_strong"),
    ("STRONG BUYER POSITIONING",    "buyer_positioning_strong"),
    # ── Range / session levels ─────────────────────────────────────────────
    ("RTH GAP",                     "rth_gap"),
    ("FLOOR",                       "floor"),
    ("CEILING",                     "ceiling"),
    ("MAX RANGE DAYS",              "max_range"),
    ("MAX TREND DAYS",              "max_trend"),
    ("NORMAL RANGE DAYS",           "normal_range"),
    ("REVERSION SETUP",             "reversion"),
    # ── SPY / OVN reference levels ─────────────────────────────────────────
    ("OVN SPY CEILING",             "ovn_spy_ceiling"),
    ("OVN SPY FLOOR",               "ovn_spy_floor"),
    ("SPY CEILING",                 "spy_ceiling"),
    ("SPY FLOOR",                   "spy_floor"),
    # ── Vector / structural markers ────────────────────────────────────────
    ("E VECTOR",                    "e_vector"),
    ("S VECTOR",                    "s_vector"),
    ("APEX",                        "apex"),
    ("SINGLE PRINT",                "single_print"),
    ("OPTIONS LEDGE",               "options_ledge"),
    # ── GEX / spread levels ────────────────────────────────────────────────
    ("SPREAD MONSTER",              "gex_spread"),
    ("GEX FLIP",                    "gex_flip"),
    ("WALL LONG",                   "gex_wall_long"),
    ("WALL SHORT",                  "gex_wall_short"),
    ("LONG MEDIAN",                 "gex_median_long"),
    ("SHORT MEDIAN",                "gex_median_short"),
    ("WED",                         "splice_band"),
    ("SPLICE",                      "splice_band"),
]

# Zone types that are inherently bullish / bearish for feature encoding
BULLISH_TYPES = {
    "buyer_ultimate_target", "buyer_absorb", "buyer_value_add",
    "buyer_positioning", "buyer_objective", "buyer_positioning_ltf",
    "buyer_objective_ltf", "buyer_positioning_strong", "supportive",
    "support", "avg_range_low", "ovn_spy_floor", "spy_floor", "floor",
    "gex_wall_long", "gex_median_long",
}
BEARISH_TYPES = {
    "seller_ultimate_target", "seller_absorb", "seller_soft_target",
    "seller_positioning", "seller_objective", "seller_positioning_ltf",
    "seller_objective_ltf", "seller_positioning_strong", "resistive",
    "avg_range_high", "session_cap", "ovn_spy_ceiling", "spy_ceiling",
    "ceiling", "gex_wall_short", "gex_median_short",
}

# Strength tiers (1=weakest … 4=strongest) for each zone type
ZONE_STRENGTH: dict[str, int] = {
    "buyer_ultimate_target": 4, "seller_ultimate_target": 4,
    "buyer_absorb": 4,          "seller_absorb": 4,
    "buyer_value_add": 3,       "seller_soft_target": 2,
    "buyer_positioning_strong": 4, "seller_positioning_strong": 4,
    "buyer_positioning": 3,     "seller_positioning": 3,
    "buyer_positioning_ltf": 2, "seller_positioning_ltf": 2,
    "buyer_objective": 2,       "seller_objective": 2,
    "buyer_objective_ltf": 1,   "seller_objective_ltf": 1,
    "iv_wall": 3,               "iv_overflow": 2, "iv_gap": 2,
    "rth_gap": 3,
    "pivot": 2, "pivot_macro": 3, "pivot_secondary": 1,
    "non_fair_value": 1,
    "floor": 2, "ceiling": 2,
    "max_range": 2, "max_trend": 3, "normal_range": 1,
    "avg_range_low": 2, "avg_range_high": 2, "session_cap": 2,
    "ovn_spy_ceiling": 2, "ovn_spy_floor": 2,
    "spy_ceiling": 2,   "spy_floor": 2,
    "supportive": 2,    "resistive": 2,
    "support": 2,
    "gex_spread": 2,    "gex_flip": 3,
    "gex_wall_long": 3, "gex_wall_short": 3,
    "gex_median_long": 2, "gex_median_short": 2,
    "e_vector": 2, "s_vector": 2,
    "apex": 2, "single_print": 1, "options_ledge": 2,
    "reversion": 1, "splice_band": 2,
}

def classify_label(text: str) -> str:
    """Map a raw label string to a canonical zone_type."""
    up = text.upper().strip()
    for pattern, zone_type in ZONE_TYPE_MAP:
        if pattern in up:
            return zone_type
    return "unknown"


# ── .mwml parsing ─────────────────────────────────────────────────────────────

def _collect_figures(obj: object, figures: list, depth: int = 0) -> None:
    """Recursively collect ALL figure objects (any type) from the JSON tree."""
    if depth > 10:
        return
    if isinstance(obj, dict):
        if "type" in obj:
            figures.append(obj)
        for v in obj.values():
            _collect_figures(v, figures, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            _collect_figures(item, figures, depth + 1)


def _parse_coord_price(coord_str: str) -> tuple[int, float] | None:
    """Parse 'timeMs|price|corner' or 'timeMs|price' coord string."""
    parts = str(coord_str).split("|")
    if len(parts) < 2:
        return None
    try:
        t_ms = int(float(parts[0]))
        price = float(parts[1])
        if 100 < price < 1_000_000:
            return t_ms, price
    except (ValueError, IndexError):
        pass
    return None


def parse_mwml_zones(mwml_path: str) -> list[dict]:
    """
    Extract zones from a .mwml file, matching each supportResist zone
    to its nearest text label to capture Milk's zone vocabulary.
    """
    try:
        data = json.load(open(mwml_path, encoding="utf-8"))
    except Exception:
        return []

    all_figures: list[dict] = []
    _collect_figures(data, all_figures)

    # ── Collect text labels with price+time coordinates ──────────────────
    # Each label: {text, price, time_ms}
    text_labels: list[dict] = []
    for fig in all_figures:
        if fig.get("type") != "comment":
            continue
        text_obj = fig.get("text", {})
        raw_text = text_obj.get("text", "") if isinstance(text_obj, dict) else str(text_obj)
        if not raw_text or not raw_text.strip():
            continue
        for coord in fig.get("coords", []):
            parsed = _parse_coord_price(coord)
            if parsed:
                t_ms, price = parsed
                text_labels.append({
                    "text":    raw_text.strip(),
                    "price":   price,
                    "time_ms": t_ms,
                })

    # Build fast price index from collected labels (O(M log M) once, O(log M) per query)
    label_idx = LabelIndex(text_labels)

    # ── Collect supportResist zones ───────────────────────────────────────
    zones: list[dict] = []
    for fig in all_figures:
        if fig.get("type") != "supportResist":
            continue

        coords = fig.get("coords", [])
        coord_map: dict[str, tuple[int, float]] = {}
        min_time_ms = None
        max_time_ms = None

        for coord_str in coords:
            parts = str(coord_str).split("|")
            if len(parts) < 2:
                continue
            try:
                t_ms  = int(float(parts[0]))
                price = float(parts[1])
                corner = parts[2].lower() if len(parts) > 2 else ""
                if 100 < price < 1_000_000:
                    if corner:
                        coord_map[corner] = (t_ms, price)
                    if min_time_ms is None or t_ms < min_time_ms:
                        min_time_ms = t_ms
                    if max_time_ms is None or t_ms > max_time_ms:
                        max_time_ms = t_ms
            except (ValueError, IndexError):
                continue

        # Need top and bottom corners
        top_price    = None
        bottom_price = None
        for corner, (_, p) in coord_map.items():
            if "top" in corner:
                top_price = p
            if "bottom" in corner:
                bottom_price = p

        if top_price is None or bottom_price is None:
            # Fallback: use max/min of all prices
            prices = [p for _, p in coord_map.values()]
            if len(prices) >= 2:
                top_price    = max(prices)
                bottom_price = min(prices)

        if top_price is None or bottom_price is None:
            continue

        hi = max(top_price, bottom_price)
        lo = min(top_price, bottom_price)
        if hi == lo or not (100 < lo < hi < 1_000_000):
            continue

        from_ts_ms = min_time_ms or 0
        to_ts_ms   = max_time_ms or from_ts_ms

        # ── Determine direction from srcId + fillColor ───────────────────
        src_id     = str(fig.get("srcId", "")).lower()
        fill_color = str(fig.get("fillColor", ""))
        fc_parts   = [x.strip() for x in fill_color.split(",")]

        is_bull = (
            "support" in src_id or
            fill_color.startswith("0,255,0") or
            fill_color.startswith("0,128,0") or
            fill_color.startswith("38,200,122") or
            (len(fc_parts) >= 3 and _is_green_dominant(fc_parts))
        )
        is_bear = (
            "resist" in src_id or
            fill_color.startswith("255,0,0") or
            fill_color.startswith("240,0,0") or
            fill_color.startswith("239,68,68") or
            (len(fc_parts) >= 3 and _is_red_dominant(fc_parts))
        )

        # ── Match nearest text label within zone's price range ───────────
        zone_label = label_idx.find_best(hi, lo, from_ts_ms, to_ts_ms)
        zone_type  = classify_label(zone_label) if zone_label else "unknown"

        # Override is_bull/is_bear from zone_type if we have a good label
        if zone_type in BULLISH_TYPES:
            is_bull, is_bear = True, False
        elif zone_type in BEARISH_TYPES:
            is_bull, is_bear = False, True
        elif not is_bull and not is_bear:
            # Unlabeled neutral zone — skip (no training signal)
            continue

        zones.append({
            "from_ts":   from_ts_ms // 1000,
            "to_ts":     to_ts_ms   // 1000,
            "top":       hi,
            "bottom":    lo,
            "is_bull":   is_bull,
            "zone_type": zone_type,
            "label_raw": zone_label or "",
            "strength":  ZONE_STRENGTH.get(zone_type, 1),
            "src_file":  Path(mwml_path).name,
        })

    return zones


def _is_green_dominant(parts: list[str]) -> bool:
    try:
        r, g, b = int(parts[0]), int(parts[1]), int(parts[2])
        return g > r * 1.5 and g > b * 1.5 and g > 80
    except (ValueError, IndexError):
        return False


def _is_red_dominant(parts: list[str]) -> bool:
    try:
        r, g, b = int(parts[0]), int(parts[1]), int(parts[2])
        return r > g * 1.5 and r > b * 1.5 and r > 80
    except (ValueError, IndexError):
        return False


class LabelIndex:
    """
    Fast O(log N) label lookup by price using a sorted array + bisect.
    Build once per .mwml file, query for each zone.
    """
    def __init__(self, labels: list[dict]) -> None:
        # Sort by price for binary search
        sorted_labels = sorted(labels, key=lambda l: l["price"])
        self._prices  = [l["price"]   for l in sorted_labels]
        self._labels  = sorted_labels

    def find_best(self, hi: float, lo: float, from_ms: int, to_ms: int) -> str | None:
        """
        Return the text of the nearest label whose price falls in [lo-5, hi+5]
        and whose time overlaps the zone's time window (±7 days).
        Falls back to nearest within 20 pts if nothing time-overlaps.
        """
        mid      = (hi + lo) / 2
        time_pad = 7 * 86_400_000

        lo_search = lo - 5.0
        hi_search = hi + 5.0

        # Binary search for the slice of labels in price range
        i_start = bisect.bisect_left(self._prices, lo_search)
        i_end   = bisect.bisect_right(self._prices, hi_search)

        # First pass: price + time match
        best_dist = float("inf")
        best_text = None
        for idx in range(i_start, i_end):
            lbl  = self._labels[idx]
            t_ms = lbl["time_ms"]
            if from_ms - time_pad <= t_ms <= to_ms + time_pad:
                dist = abs(lbl["price"] - mid)
                if dist < best_dist:
                    best_dist = dist
                    best_text = lbl["text"]

        if best_text:
            return best_text

        # Fallback: widen search to ±20 pts, ignore time
        lo_wide = mid - 20.0
        hi_wide = mid + 20.0
        i_start = bisect.bisect_left(self._prices, lo_wide)
        i_end   = bisect.bisect_right(self._prices, hi_wide)
        best_dist = float("inf")
        best_text = None
        for idx in range(i_start, i_end):
            dist = abs(self._labels[idx]["price"] - mid)
            if dist < best_dist:
                best_dist = dist
                best_text = self._labels[idx]["text"]

        return best_text


# ── Extract command ───────────────────────────────────────────────────────────

def cmd_extract(mwml_dir: str = "C:/Users/jacks/Downloads") -> dict:
    """Parse all .mwml files and save raw zone list with zone_type labels."""
    pattern = os.path.join(mwml_dir, "*.mwml")
    files   = glob.glob(pattern)
    if not files:
        return {"error": f"No .mwml files found in {mwml_dir}"}

    all_zones: list[dict] = []
    for f in files:
        z = parse_mwml_zones(f)
        all_zones.extend(z)

    # Deduplicate by (from_ts, top, bottom, zone_type)
    seen: set = set()
    deduped: list[dict] = []
    for z in all_zones:
        key = (z["from_ts"], round(z["top"], 2), round(z["bottom"], 2), z["zone_type"])
        if key not in seen:
            seen.add(key)
            deduped.append(z)

    deduped.sort(key=lambda z: z["from_ts"])
    ZONES_PATH.write_text(json.dumps(deduped, indent=2))

    # Stats
    bulls  = sum(1 for z in deduped if z["is_bull"])
    bears  = len(deduped) - bulls
    types  = {}
    for z in deduped:
        types[z["zone_type"]] = types.get(z["zone_type"], 0) + 1
    top_types = sorted(types.items(), key=lambda x: x[1], reverse=True)[:15]

    return {
        "total_zones":  len(deduped),
        "bullish":      bulls,
        "bearish":      bears,
        "files_parsed": len(files),
        "saved_to":     str(ZONES_PATH),
        "top_zone_types": [{"type": t, "count": c} for t, c in top_types],
    }


# ── Feature extraction from DB ────────────────────────────────────────────────

def _get_db_conn():
    import psycopg2
    from urllib.parse import urlparse, parse_qs

    env_path = Path(__file__).parent.parent / ".env"
    db_url   = None
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                db_url = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    if not db_url:
        db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        raise RuntimeError("DATABASE_URL not found in .env")

    parsed = urlparse(db_url)
    qs     = parse_qs(parsed.query)
    ssl    = qs.get("sslmode", ["require"])[0]
    conn   = psycopg2.connect(
        host=parsed.hostname, port=parsed.port or 5432,
        dbname=parsed.path.lstrip("/"), user=parsed.username,
        password=parsed.password, sslmode=ssl,
    )
    return conn


def _fetch_candles_around(conn, symbol: str, from_ts: int, window_sec: int = 3600) -> list[dict]:
    lo = from_ts - window_sec
    hi = from_ts + window_sec
    cur = conn.cursor()
    cur.execute(
        """SELECT timestamp, open, high, low, close, volume
           FROM cached_candles
           WHERE symbol=%s AND resolution='5' AND timestamp >= %s AND timestamp <= %s
           ORDER BY timestamp""",
        (symbol, lo, hi),
    )
    return [
        {"time": r[0], "open": r[1], "high": r[2],
         "low":  r[3], "close": r[4], "volume": r[5] or 0}
        for r in cur.fetchall()
    ]


def _atr(candles: list[dict], period: int = 14) -> float:
    if len(candles) < 2:
        return 2.0
    trs = []
    for i in range(1, len(candles)):
        b, p = candles[i], candles[i - 1]
        trs.append(max(b["high"] - b["low"],
                       abs(b["high"] - p["close"]),
                       abs(b["low"]  - p["close"])))
    recent = trs[-period:]
    return sum(recent) / len(recent) if recent else 2.0


def _label_zone(zone: dict, candles_after: list[dict], atr: float) -> int | None:
    """
    Label = 1 (respected) if price:
      - approached zone within 1.5 ATR
      - then reversed at least 1 ATR in the expected direction
    Label = 0 (broken) if price penetrated beyond zone edge by > 0.3 ATR.

    Zone-type specific tuning:
      - RTH GAP: wider approach threshold (gaps can be wide)
      - IV WALL: tighter reversal requirement (IV walls can absorb more before rejecting)
      - NON FAIR VALUE: neutral (price should move through quickly)
    """
    if not candles_after:
        return None

    z_top    = zone["top"]
    z_bot    = zone["bottom"]
    is_bull  = zone["is_bull"]
    z_type   = zone.get("zone_type", "unknown")

    # Zone-type-specific thresholds
    if z_type == "rth_gap":
        approach_mult, reversal_mult, break_mult = 2.5, 0.8, 0.5
    elif z_type in ("iv_wall", "iv_overflow"):
        approach_mult, reversal_mult, break_mult = 1.5, 1.2, 0.4
    elif z_type in ("buyer_ultimate_target", "seller_ultimate_target"):
        approach_mult, reversal_mult, break_mult = 2.0, 1.5, 0.6
    elif z_type in ("buyer_positioning_strong", "seller_positioning_strong"):
        approach_mult, reversal_mult, break_mult = 1.5, 1.0, 0.3
    elif z_type in ("non_fair_value",):
        # Non-fair-value zones — price should pass through them quickly
        approach_mult, reversal_mult, break_mult = 1.0, 0.5, 0.2
    else:
        approach_mult, reversal_mult, break_mult = 1.0, 1.0, 0.4

    approach_thr = atr * approach_mult
    reversal_thr = atr * reversal_mult
    break_thr    = atr * break_mult

    touched = False
    for c in candles_after[:60]:  # look 5 hours ahead (60 × 5m)
        if is_bull:
            # Bullish zone: price approaches from below, should bounce up
            if c["low"] <= z_bot + approach_thr:
                touched = True
            if touched and c["close"] >= z_bot + reversal_thr:
                return 1  # bounced up
            if c["close"] < z_bot - break_thr:
                return 0  # broke through
        else:
            # Bearish zone: price approaches from above, should drop
            if c["high"] >= z_top - approach_thr:
                touched = True
            if touched and c["close"] <= z_top - reversal_thr:
                return 1  # rejected down
            if c["close"] > z_top + break_thr:
                return 0  # broke through

    return None  # undecided in the window


# ── Feature engineering ───────────────────────────────────────────────────────

# Zone type integer encoding (for RF categorical feature)
ZONE_TYPE_ENCODING: dict[str, int] = {
    "buyer_ultimate_target":     10,
    "seller_ultimate_target":    10,
    "buyer_absorb":              9,
    "seller_absorb":             9,
    "buyer_value_add":           8,
    "buyer_positioning_strong":  8,
    "seller_positioning_strong": 8,
    "buyer_positioning":         7,
    "seller_positioning":        7,
    "iv_wall":                   6,
    "rth_gap":                   6,
    "pivot_macro":               5,
    "gex_flip":                  5,
    "gex_wall_long":             5,
    "gex_wall_short":            5,
    "buyer_objective":           4,
    "seller_objective":          4,
    "buyer_positioning_ltf":     4,
    "seller_positioning_ltf":    4,
    "pivot":                     4,
    "ovn_spy_ceiling":           4,
    "ovn_spy_floor":             4,
    "avg_range_low":             3,
    "avg_range_high":            3,
    "spy_ceiling":               3,
    "spy_floor":                 3,
    "floor":                     3,
    "ceiling":                   3,
    "max_trend":                 3,
    "session_cap":               3,
    "supportive":                3,
    "resistive":                 3,
    "support":                   3,
    "iv_overflow":               3,
    "iv_gap":                    3,
    "e_vector":                  3,
    "s_vector":                  3,
    "apex":                      3,
    "max_range":                 2,
    "normal_range":              2,
    "reversion":                 2,
    "splice_band":               2,
    "buyer_objective_ltf":       2,
    "seller_objective_ltf":      2,
    "seller_soft_target":        2,
    "pivot_secondary":           2,
    "gex_spread":                2,
    "gex_median_long":           2,
    "gex_median_short":          2,
    "options_ledge":             2,
    "single_print":              1,
    "non_fair_value":            1,
    "unknown":                   0,
}

ZONE_FEATURE_NAMES = [
    "zone_size_atr",      # zone height in ATR units
    "hour_utc",           # UTC hour of zone creation
    "is_rth",             # 1 = RTH, 0 = ETH
    "atr",                # raw ATR at creation
    "avg_vol",            # avg volume in 6 bars before zone
    "dist_entry_atr",     # distance of price from zone midpoint in ATR
    "is_bull",            # 1 = bullish zone
    "zone_type_code",     # integer encoding of zone type (0–10)
    "strength",           # Milk zone strength tier (1–4)
    "is_institutional",   # 1 = buyer/seller positioning or absorb (high conviction)
    "is_iv_level",        # 1 = IV Wall, IV Gap, IV Overflow
    "is_gap_level",       # 1 = RTH Gap
    "is_reference_level", # 1 = MAX RANGE, NORMAL RANGE, SPY LEVELS, etc.
]


def _zone_meta_flags(zone_type: str) -> tuple[int, int, int, int]:
    """Return (is_institutional, is_iv_level, is_gap_level, is_reference) flags."""
    institutional_types = {
        "buyer_absorb", "seller_absorb", "buyer_value_add",
        "buyer_positioning", "seller_positioning",
        "buyer_positioning_strong", "seller_positioning_strong",
        "buyer_positioning_ltf", "seller_positioning_ltf",
        "buyer_ultimate_target", "seller_ultimate_target",
    }
    iv_types  = {"iv_wall", "iv_overflow", "iv_gap"}
    gap_types = {"rth_gap"}
    ref_types = {
        "max_range", "max_trend", "normal_range", "avg_range_low", "avg_range_high",
        "ovn_spy_ceiling", "ovn_spy_floor", "spy_ceiling", "spy_floor",
        "session_cap", "floor", "ceiling",
    }
    return (
        int(zone_type in institutional_types),
        int(zone_type in iv_types),
        int(zone_type in gap_types),
        int(zone_type in ref_types),
    )


def cmd_features(symbol: str = "MES") -> dict:
    """Enrich zones_raw.json with DB features and labels, save zones_features.json."""
    if not ZONES_PATH.exists():
        return {"error": "Run 'extract' first to create zones_raw.json"}
    zones = json.loads(ZONES_PATH.read_text())

    try:
        conn = _get_db_conn()
    except Exception as e:
        return {"error": f"DB connection failed: {e}"}

    enriched: list[dict] = []
    labeled   = 0

    for z in zones:
        candles_all    = _fetch_candles_around(conn, symbol, z["from_ts"], window_sec=18000)
        candles_before = [c for c in candles_all if c["time"] <= z["from_ts"]]
        candles_after  = [c for c in candles_all if c["time"]  > z["from_ts"]]

        if len(candles_before) < 3:
            continue

        atr_val    = _atr(candles_before)
        zone_size  = z["top"] - z["bottom"]
        hour_utc   = datetime.fromtimestamp(z["from_ts"], tz=timezone.utc).hour
        mid        = (z["top"] + z["bottom"]) / 2
        avg_vol    = sum(c["volume"] for c in candles_before[-6:]) / max(len(candles_before[-6:]), 1)
        pre_close  = candles_before[-1]["close"] if candles_before else mid
        dist_entry = abs(pre_close - mid)

        zone_type  = z.get("zone_type", "unknown")
        type_code  = ZONE_TYPE_ENCODING.get(zone_type, 0)
        strength   = z.get("strength", ZONE_STRENGTH.get(zone_type, 1))
        is_inst, is_iv, is_gap, is_ref = _zone_meta_flags(zone_type)

        # RTH: 9:30–5pm ET = 13:30–21:00 UTC
        is_rth = int(13 <= hour_utc < 21)

        label = _label_zone(z, candles_after, atr_val)
        if label is not None:
            labeled += 1

        enriched.append({
            **z,
            "features": {
                "zone_size_atr":      round(zone_size / max(atr_val, 0.01), 3),
                "hour_utc":           hour_utc,
                "is_rth":             is_rth,
                "atr":                round(atr_val, 3),
                "avg_vol":            round(avg_vol, 1),
                "dist_entry_atr":     round(dist_entry / max(atr_val, 0.01), 3),
                "is_bull":            int(z["is_bull"]),
                "zone_type_code":     type_code,
                "strength":           strength,
                "is_institutional":   is_inst,
                "is_iv_level":        is_iv,
                "is_gap_level":       is_gap,
                "is_reference_level": is_ref,
            },
            "label": label,
        })

    conn.close()
    out_path = BASE_DIR / "zones_features.json"
    out_path.write_text(json.dumps(enriched, indent=2))

    return {
        "total_zones": len(enriched),
        "labeled":     labeled,
        "unlabeled":   len(enriched) - labeled,
        "saved_to":    str(out_path),
    }


# ── Training ──────────────────────────────────────────────────────────────────

def cmd_train() -> dict:
    try:
        from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
        from sklearn.model_selection import cross_val_score
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import Pipeline
        import numpy as np
    except ImportError:
        return {"error": "scikit-learn not installed. Run: pip install scikit-learn numpy"}

    feat_path = BASE_DIR / "zones_features.json"
    if not feat_path.exists():
        return {"error": "Run 'features' first to create zones_features.json"}

    data    = json.loads(feat_path.read_text())
    labeled = [z for z in data if z.get("label") is not None]

    if len(labeled) < 20:
        return {"error": f"Need at least 20 labeled zones (have {len(labeled)})"}

    X = [[z["features"].get(k, 0) for k in ZONE_FEATURE_NAMES] for z in labeled]
    y = [int(z["label"]) for z in labeled]

    X_arr = np.array(X, dtype=float)
    y_arr = np.array(y, dtype=int)

    # Use GradientBoosting which handles the categorical zone_type_code better
    clf = GradientBoostingClassifier(
        n_estimators=300,
        max_depth=4,
        learning_rate=0.05,
        min_samples_leaf=4,
        subsample=0.8,
        random_state=42,
    )

    n_cv = min(5, len(labeled) // 5)
    if n_cv >= 2:
        cv_scores = cross_val_score(clf, X_arr, y_arr, cv=n_cv, scoring="accuracy")
        accuracy  = float(np.mean(cv_scores))
    else:
        accuracy = float("nan")

    clf.fit(X_arr, y_arr)

    with open(MODEL_PATH, "wb") as fh:
        pickle.dump({"model": clf, "feature_names": ZONE_FEATURE_NAMES}, fh)

    fi = sorted(
        zip(ZONE_FEATURE_NAMES, clf.feature_importances_),
        key=lambda x: x[1], reverse=True,
    )[:7]

    respected = sum(y)
    broken    = len(y) - respected

    # Per-zone-type accuracy breakdown
    type_stats: dict[str, dict] = {}
    for z, lbl in zip(labeled, y):
        zt = z.get("zone_type", "unknown")
        if zt not in type_stats:
            type_stats[zt] = {"total": 0, "respected": 0}
        type_stats[zt]["total"] += 1
        type_stats[zt]["respected"] += lbl
    type_breakdown = [
        {"type": t, "total": v["total"],
         "respect_rate": round(v["respected"] / v["total"], 2)}
        for t, v in sorted(type_stats.items(), key=lambda x: x[1]["total"], reverse=True)
        if v["total"] >= 5
    ][:10]

    return {
        "accuracy":         round(accuracy, 3) if accuracy == accuracy else None,
        "n_labeled":        len(labeled),
        "respected":        respected,
        "broken":           broken,
        "top_features":     [{"feature": n, "importance": round(float(i), 4)} for n, i in fi],
        "type_breakdown":   type_breakdown,
    }


def cmd_predict(features_json: str) -> dict:
    if not MODEL_PATH.exists():
        return {"score": 0.5, "is_strong": True, "note": "no model trained yet"}

    f = json.loads(features_json)

    # Enrich zone_type_code + flags if zone_type provided
    zone_type = f.get("zone_type", "unknown")
    if "zone_type_code" not in f:
        f["zone_type_code"]     = ZONE_TYPE_ENCODING.get(zone_type, 0)
    if "strength" not in f:
        f["strength"]           = ZONE_STRENGTH.get(zone_type, 1)
    is_inst, is_iv, is_gap, is_ref = _zone_meta_flags(zone_type)
    f.setdefault("is_institutional",   is_inst)
    f.setdefault("is_iv_level",        is_iv)
    f.setdefault("is_gap_level",       is_gap)
    f.setdefault("is_reference_level", is_ref)

    with open(MODEL_PATH, "rb") as fh:
        payload = pickle.load(fh)
    clf   = payload["model"]
    names = payload["feature_names"]

    row = [float(f.get(k, 0)) for k in names]
    try:
        proba = float(clf.predict_proba([row])[0][1])
    except Exception:
        proba = 0.5

    return {"score": round(proba, 3), "is_strong": proba >= 0.60}


def cmd_strong(min_score: float = 0.60, from_ts: int = 0, to_ts: int = 9_999_999_999) -> dict:
    """
    Return zones that the trained model predicts as strong (score >= min_score).
    Includes zone_type and strength in output for chart overlay labeling.
    Falls back to zones_raw.json when model not yet trained.
    """
    feat_path = BASE_DIR / "zones_features.json"

    if not MODEL_PATH.exists() or not feat_path.exists():
        if not ZONES_PATH.exists():
            return {"zones": [], "count": 0, "fallback": True,
                    "error": "No zones extracted yet. Run 'extract' first."}
        data  = json.loads(ZONES_PATH.read_text())
        zones = [
            {"from_ts":   z["from_ts"],
             "to_ts":     z["to_ts"],
             "top":       z["top"],
             "bottom":    z["bottom"],
             "is_bull":   z["is_bull"],
             "zone_type": z.get("zone_type", "unknown"),
             "label_raw": z.get("label_raw", ""),
             "strength":  z.get("strength", 1),
             "score":     0.5}
            for z in data
            if z["to_ts"] >= from_ts and z["from_ts"] <= to_ts
        ]
        zones.sort(key=lambda z: z["from_ts"])
        return {"zones": zones, "count": len(zones), "fallback": True}

    data = json.loads(feat_path.read_text())
    with open(MODEL_PATH, "rb") as fh:
        payload = pickle.load(fh)
    clf   = payload["model"]
    names = payload["feature_names"]

    strong: list[dict] = []
    for z in data:
        if z["to_ts"] < from_ts or z["from_ts"] > to_ts:
            continue
        feats = z.get("features", {})
        row   = [float(feats.get(k, 0)) for k in names]
        try:
            score = float(clf.predict_proba([row])[0][1])
        except Exception:
            score = 0.5
        if score >= min_score:
            strong.append({
                "from_ts":   z["from_ts"],
                "to_ts":     z["to_ts"],
                "top":       z["top"],
                "bottom":    z["bottom"],
                "is_bull":   z["is_bull"],
                "zone_type": z.get("zone_type", "unknown"),
                "label_raw": z.get("label_raw", ""),
                "strength":  z.get("strength", 1),
                "score":     round(score, 3),
            })

    strong.sort(key=lambda z: z["from_ts"])

    # Fallback: if no scored zones in window, use raw zones
    if not strong and ZONES_PATH.exists():
        data_raw = json.loads(ZONES_PATH.read_text())
        raw_in_window = [
            {"from_ts":   z["from_ts"],
             "to_ts":     z["to_ts"],
             "top":       z["top"],
             "bottom":    z["bottom"],
             "is_bull":   z["is_bull"],
             "zone_type": z.get("zone_type", "unknown"),
             "label_raw": z.get("label_raw", ""),
             "strength":  z.get("strength", 1),
             "score":     0.5}
            for z in data_raw
            if z["to_ts"] >= from_ts and z["from_ts"] <= to_ts
        ]
        raw_in_window.sort(key=lambda z: z["from_ts"])
        return {
            "zones": raw_in_window, "count": len(raw_in_window),
            "fallback": True, "reason": "no_scored_zones_in_window",
        }

    return {"zones": strong, "count": len(strong), "min_score": min_score}


def cmd_stats() -> dict:
    result: dict = {
        "zones_raw_exists": ZONES_PATH.exists(),
        "model_exists":     MODEL_PATH.exists(),
    }
    if ZONES_PATH.exists():
        zones = json.loads(ZONES_PATH.read_text())
        result["raw_total"]    = len(zones)
        result["raw_bullish"]  = sum(1 for z in zones if z["is_bull"])
        result["raw_bearish"]  = sum(1 for z in zones if not z["is_bull"])
        # Zone type breakdown
        types: dict[str, int] = {}
        for z in zones:
            t = z.get("zone_type", "unknown")
            types[t] = types.get(t, 0) + 1
        result["zone_types"] = sorted(types.items(), key=lambda x: x[1], reverse=True)[:20]
        result["unlabeled_types"] = sum(1 for z in zones if z.get("zone_type") == "unknown")

    feat_path = BASE_DIR / "zones_features.json"
    if feat_path.exists():
        data    = json.loads(feat_path.read_text())
        labeled = [z for z in data if z.get("label") is not None]
        result["features_total"]     = len(data)
        result["features_labeled"]   = len(labeled)
        result["features_respected"] = sum(1 for z in labeled if z["label"] == 1)
        result["features_broken"]    = sum(1 for z in labeled if z["label"] == 0)
    return result


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"error": "no command. use: extract | features | train | predict | stats | strong"}))
        sys.exit(1)

    cmd = args[0]
    try:
        if cmd == "extract":
            mwml_dir = args[1] if len(args) > 1 else "C:/Users/jacks/Downloads"
            result   = cmd_extract(mwml_dir)
        elif cmd == "features":
            symbol = args[1] if len(args) > 1 else "MES"
            result = cmd_features(symbol)
        elif cmd == "train":
            result = cmd_train()
        elif cmd == "predict" and len(args) >= 2:
            result = cmd_predict(args[1])
        elif cmd == "strong":
            min_score = float(args[1]) if len(args) > 1 else 0.60
            from_ts   = int(args[2])   if len(args) > 2 else 0
            to_ts     = int(args[3])   if len(args) > 3 else 9_999_999_999
            result    = cmd_strong(min_score, from_ts, to_ts)
        elif cmd == "stats":
            result = cmd_stats()
        else:
            result = {"error": f"unknown command: {cmd}"}
    except Exception as e:
        result = {"error": str(e)}

    print(json.dumps(result))
