"""
monte_carlo_exits.py
====================
Runs a grid-search Monte Carlo over TP/SL multiples using REAL MES 5m candle
data from the PostgreSQL DB. Finds the optimal exit strategy for the
Vector + Milk Yellow Box confluence signal system.

Signal logic mirrors market.tsx allConfluenceSignals:
  - Primary vector (Highest(Lowest(low,20),20)) must be below price AND rising
  - RTH-only (13:30–21:00 UTC Mon-Fri)
  - 10-bar cooldown between signals

Usage:
  cd c:\Users\jacks\Downloads\Milks-Yellow-Box-Strategy
  python3 scripts/monte_carlo_exits.py
"""

import os, sys, json
import numpy as np
import psycopg2
from dotenv import load_dotenv

load_dotenv()

# ── DB connection ────────────────────────────────────────────────────────────
DB_URL = os.environ.get("DATABASE_URL", "")
if not DB_URL:
    print("ERROR: DATABASE_URL not set in .env"); sys.exit(1)

conn = psycopg2.connect(DB_URL)
cur  = conn.cursor()

print("[1/4] Fetching real MES 5m candles from DB...")
cur.execute("""
    SELECT timestamp, open, high, low, close
    FROM cached_candles
    WHERE symbol='MES' AND resolution='5'
    ORDER BY timestamp ASC
""")
rows = cur.fetchall()
conn.close()

if not rows:
    print("No MES 5m candles found. Exiting."); sys.exit(1)

print(f"      → {len(rows)} candles loaded")

# ── Build candle arrays ──────────────────────────────────────────────────────
times  = np.array([r[0] for r in rows], dtype=np.int64)
opens  = np.array([float(r[1]) for r in rows])
highs  = np.array([float(r[2]) for r in rows])
lows   = np.array([float(r[3]) for r in rows])
closes = np.array([float(r[4]) for r in rows])
n      = len(times)

def is_rth(ts: int) -> bool:
    import datetime
    d = datetime.datetime.utcfromtimestamp(ts)
    if d.weekday() >= 5: return False         # Sat/Sun
    mins = d.hour * 60 + d.minute
    return 13*60+30 <= mins < 21*60

rth_flags = np.array([is_rth(int(t)) for t in times], dtype=bool)

# ── Vector computation: Highest(Lowest(low, 20), 20) ────────────────────────
print("[2/4] Computing vector line...")
VEC_LEN = 20
lower_band = np.zeros(n)
for i in range(n):
    lo = lows[i]
    for j in range(max(0, i - VEC_LEN + 1), i):
        if lows[j] < lo: lo = lows[j]
    lower_band[i] = lo

vector = np.zeros(n)
for i in range(n):
    hi = lower_band[i]
    for j in range(max(0, i - VEC_LEN + 1), i):
        if lower_band[j] > hi: hi = lower_band[j]
    vector[i] = hi

# ── ATR (14-period) ──────────────────────────────────────────────────────────
ATR_P = 14
atr_arr = np.zeros(n)
for i in range(n):
    start = max(0, i - ATR_P + 1)
    s = 0.0
    for j in range(start, i + 1):
        prev_close = closes[j-1] if j > 0 else closes[j]
        tr = max(highs[j] - lows[j], abs(highs[j] - prev_close), abs(lows[j] - prev_close))
        s += tr
    atr_arr[i] = max(s / (i - start + 1), 0.5)   # min ATR = 0.5 pts for MES

# ── Signal generation ────────────────────────────────────────────────────────
print("[3/4] Generating signals (vector above, rising, RTH, 10-bar cooldown)...")
signals = []  # list of bar indices
cooldown = 10
last_sig = -cooldown

for i in range(VEC_LEN * 2, n - 5):
    if not rth_flags[i]: continue
    lb = vector[i]
    # Primary vector hard gate: price above vector AND rising
    if closes[i] <= lb: continue
    prev_lb = vector[i - 3] if i >= 3 else lb
    if lb < prev_lb: continue  # vector declining
    if i - last_sig < cooldown: continue
    signals.append(i)
    last_sig = i

print(f"      → {len(signals)} signals found")

# ── Walk-forward outcome evaluation ─────────────────────────────────────────
def eval_outcome(entry_idx, entry_price, tp1, sl, max_bars=100):
    """Walk forward from entry_idx+1, return (outcome, bars_to_exit)."""
    for k in range(1, min(max_bars + 1, n - entry_idx)):
        j = entry_idx + k
        if lows[j]  <= sl:  return "Loss", k
        if highs[j] >= tp1: return "Win",  k
    return "Open", max_bars

# ── Monte Carlo grid search ──────────────────────────────────────────────────
print("[4/4] Running Monte Carlo grid search (TP/SL multiples)...")

# Test ATR multiples for TP1 and SL
tp_mults = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0]
sl_mults = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

# Also test fixed-point values (common for MES)
fixed_tp = [2.0, 3.0, 5.0, 7.0, 10.0, 15.0, 20.0]
fixed_sl = [1.0, 2.0, 3.0, 5.0, 7.0, 10.0]

results = []

# ATR-based grid
for tp_m in tp_mults:
    for sl_m in sl_mults:
        wins = losses = opens = 0
        rr = tp_m / sl_m
        for idx in signals:
            entry  = closes[idx]
            atr    = atr_arr[idx]
            tp1    = entry + tp_m * atr
            sl     = entry - sl_m * atr
            oc, _  = eval_outcome(idx, entry, tp1, sl)
            if oc == "Win":   wins   += 1
            elif oc == "Loss": losses += 1
            else:              opens  += 1
        decided = wins + losses
        wr = wins / decided * 100 if decided > 0 else 0
        exp = (wins * tp_m - losses * sl_m) / decided if decided > 0 else 0
        results.append({
            "type": "ATR",
            "tp_param": f"{tp_m}×ATR", "sl_param": f"{sl_m}×ATR",
            "tp_m": tp_m, "sl_m": sl_m,
            "rr": rr, "wr": wr, "exp": exp,
            "wins": wins, "losses": losses, "opens": opens,
        })

# Fixed-point grid
for tp_pts in fixed_tp:
    for sl_pts in fixed_sl:
        wins = losses = opens = 0
        rr = tp_pts / sl_pts
        for idx in signals:
            entry  = closes[idx]
            tp1    = entry + tp_pts
            sl     = entry - sl_pts
            oc, _  = eval_outcome(idx, entry, tp1, sl)
            if oc == "Win":   wins   += 1
            elif oc == "Loss": losses += 1
            else:              opens  += 1
        decided = wins + losses
        wr = wins / decided * 100 if decided > 0 else 0
        exp = (wins * tp_pts - losses * sl_pts) / decided if decided > 0 else 0
        results.append({
            "type": "Fixed",
            "tp_param": f"{tp_pts}pts", "sl_param": f"{sl_pts}pts",
            "tp_m": tp_pts, "sl_m": sl_pts,
            "rr": rr, "wr": wr, "exp": exp,
            "wins": wins, "losses": losses, "opens": opens,
        })

# ── Report ────────────────────────────────────────────────────────────────────
results.sort(key=lambda r: r["exp"], reverse=True)

print("\n" + "═"*90)
print("  MONTE CARLO RESULTS — REAL MES 5m DATA")
print(f"  Signals: {len(signals)}   Period: {len(rows)} bars   Vector length: {VEC_LEN}")
print("═"*90)
print(f"  {'Type':6}  {'TP1':12}  {'SL':12}  {'R:R':6}  {'Win%':7}  {'Exp/trade':10}  {'W/L/O':15}")
print("  " + "-"*88)
for r in results[:20]:
    print(f"  {r['type']:6}  {r['tp_param']:12}  {r['sl_param']:12}  {r['rr']:5.2f}x  {r['wr']:6.1f}%  {r['exp']:10.2f}  {r['wins']}/{r['losses']}/{r['opens']}")

best_atr   = max((r for r in results if r["type"]=="ATR"),   key=lambda r: r["exp"])
best_fixed = max((r for r in results if r["type"]=="Fixed"), key=lambda r: r["exp"])

print("\n" + "═"*90)
print(f"  BEST ATR-BASED  : TP1={best_atr['tp_param']}  SL={best_atr['sl_param']}  "
      f"WR={best_atr['wr']:.1f}%  Exp={best_atr['exp']:.2f}pts/trade")
print(f"  BEST FIXED-PTS  : TP1={best_fixed['tp_param']}  SL={best_fixed['sl_param']}  "
      f"WR={best_fixed['wr']:.1f}%  Exp={best_fixed['exp']:.2f}pts/trade")
print("═"*90)
print()

# Save full results to JSON for reference
out_path = os.path.join(os.path.dirname(__file__), "monte_carlo_results.json")
with open(out_path, "w") as f:
    json.dump({"signals": len(signals), "bars": len(rows),
               "best_atr": best_atr, "best_fixed": best_fixed,
               "top20": results[:20]}, f, indent=2)
print(f"  Full results saved to: {out_path}\n")
