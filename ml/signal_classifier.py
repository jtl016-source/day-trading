"""
signal_classifier.py — ML feedback loop for confluence signals.

Stores signal feature vectors in SQLite, labels them as good/bad,
trains a RandomForestClassifier, and serves predictions via JSON CLI.

Usage (called by server/routes.ts via child_process):
  python ml/signal_classifier.py log     <json_features>   -> {"id": int}
  python ml/signal_classifier.py label   <id> <outcome>     -> {"ok": true}
  python ml/signal_classifier.py predict <json_features>   -> {"score": float, "warn": bool}
  python ml/signal_classifier.py retrain                   -> {"accuracy": float, "n_samples": int, "top_features": [...]}
  python ml/signal_classifier.py stats                     -> {"labeled": int, "unlabeled": int, "wins": int, "losses": int}
"""

import json
import os
import sys
import sqlite3
import pickle
from pathlib import Path

DB_PATH    = Path(__file__).parent / "signals.db"
MODEL_PATH = Path(__file__).parent / "signal_model.pkl"

FEATURE_NAMES = [
    "hour_utc",         # 0-23 UTC hour of signal
    "is_rth",           # 1 = RTH, 0 = ETH
    "atr",              # 14-period ATR at signal time
    "price_vs_vec",     # close - primary_vector (absolute pts above)
    "milk_ok",          # 1 = in bullish milk zone
    "body_ok",          # 1 = bullish candle body
    "secondary_vec_ok", # 1 = any secondary interval vector below price
    "bonus",            # 0-3 total bonus components
    "risk_level",       # 0=riskiest, 1=risky, 2=safe
    "rr_ratio",         # (tp2-entry)/(entry-sl) at signal time
]

# ── DB helpers ────────────────────────────────────────────────────────────────

def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS signals (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts          INTEGER NOT NULL,
            interval    TEXT NOT NULL,
            symbol      TEXT NOT NULL,
            features    TEXT NOT NULL,   -- JSON array of FEATURE_NAMES values
            outcome     INTEGER,         -- 1=good/win, 0=bad/loss, NULL=unlabeled
            created_at  INTEGER DEFAULT (strftime('%s','now'))
        )
    """)
    conn.commit()
    return conn


def _feats_to_list(f: dict) -> list:
    """Convert feature dict to ordered list matching FEATURE_NAMES."""
    rl_map = {"safe": 2, "risky": 1, "riskiest": 0}
    return [
        float(f.get("hour_utc", 0)),
        float(f.get("is_rth", 0)),
        float(f.get("atr", 1.0)),
        float(f.get("price_vs_vec", 0.0)),
        float(1 if f.get("milk_ok") else 0),
        float(1 if f.get("body_ok") else 0),
        float(1 if f.get("secondary_vec_ok") else 0),
        float(f.get("bonus", 0)),
        float(rl_map.get(str(f.get("risk_level", "riskiest")), 0)),
        float(f.get("rr_ratio", 2.0)),
    ]


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_log(features_json: str) -> dict:
    f = json.loads(features_json)
    feat_list = _feats_to_list(f)
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO signals (ts, interval, symbol, features) VALUES (?,?,?,?)",
        (
            int(f.get("ts", 0)),
            str(f.get("interval", "5m")),
            str(f.get("symbol", "MES")),
            json.dumps(feat_list),
        ),
    )
    conn.commit()
    conn.close()
    return {"id": cur.lastrowid}


def cmd_label(sig_id: int, outcome: str) -> dict:
    outcome_val = 1 if outcome in ("1", "win", "good", "true") else 0
    conn = get_conn()
    conn.execute("UPDATE signals SET outcome=? WHERE id=?", (outcome_val, sig_id))
    conn.commit()
    conn.close()
    return {"ok": True}


def cmd_predict(features_json: str) -> dict:
    if not MODEL_PATH.exists():
        return {"score": 0.5, "warn": False, "note": "no model trained yet"}
    f = json.loads(features_json)
    feat_list = _feats_to_list(f)
    with open(MODEL_PATH, "rb") as fh:
        model = pickle.load(fh)
    try:
        proba = float(model.predict_proba([feat_list])[0][1])
    except Exception:
        proba = 0.5
    return {"score": round(proba, 3), "warn": proba < 0.45}


def cmd_retrain() -> dict:
    try:
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.model_selection import cross_val_score
        import numpy as np
    except ImportError:
        return {"error": "scikit-learn not installed. Run: pip install scikit-learn numpy"}

    conn = get_conn()
    rows = conn.execute(
        "SELECT features, outcome FROM signals WHERE outcome IS NOT NULL"
    ).fetchall()
    conn.close()

    if len(rows) < 10:
        return {"error": f"Need at least 10 labeled signals to train (have {len(rows)})"}

    X = [json.loads(r["features"]) for r in rows]
    y = [int(r["outcome"]) for r in rows]

    X_arr = np.array(X, dtype=float)
    y_arr = np.array(y, dtype=int)

    clf = RandomForestClassifier(
        n_estimators=200,
        max_depth=6,
        min_samples_leaf=3,
        class_weight="balanced",
        random_state=42,
    )

    # Cross-val accuracy
    if len(rows) >= 20:
        cv_scores = cross_val_score(clf, X_arr, y_arr, cv=min(5, len(rows) // 4), scoring="accuracy")
        accuracy = float(np.mean(cv_scores))
    else:
        accuracy = float("nan")

    clf.fit(X_arr, y_arr)

    with open(MODEL_PATH, "wb") as fh:
        pickle.dump(clf, fh)

    # Feature importance
    importances = clf.feature_importances_
    fi = sorted(
        zip(FEATURE_NAMES, importances),
        key=lambda x: x[1],
        reverse=True,
    )[:5]
    top_features = [{"feature": name, "importance": round(float(imp), 4)} for name, imp in fi]

    wins   = sum(1 for ov in y if ov == 1)
    losses = sum(1 for ov in y if ov == 0)

    return {
        "accuracy": round(accuracy, 3) if accuracy == accuracy else None,
        "n_samples": len(rows),
        "wins": wins,
        "losses": losses,
        "top_features": top_features,
    }


def cmd_stats() -> dict:
    conn = get_conn()
    total    = conn.execute("SELECT COUNT(*) FROM signals").fetchone()[0]
    labeled  = conn.execute("SELECT COUNT(*) FROM signals WHERE outcome IS NOT NULL").fetchone()[0]
    wins     = conn.execute("SELECT COUNT(*) FROM signals WHERE outcome=1").fetchone()[0]
    losses   = conn.execute("SELECT COUNT(*) FROM signals WHERE outcome=0").fetchone()[0]
    conn.close()
    return {
        "total":     total,
        "labeled":   labeled,
        "unlabeled": total - labeled,
        "wins":      wins,
        "losses":    losses,
        "model_exists": MODEL_PATH.exists(),
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"error": "no command given"}))
        sys.exit(1)

    cmd = args[0]
    try:
        if cmd == "log" and len(args) >= 2:
            result = cmd_log(args[1])
        elif cmd == "label" and len(args) >= 3:
            result = cmd_label(int(args[1]), args[2])
        elif cmd == "predict" and len(args) >= 2:
            result = cmd_predict(args[1])
        elif cmd == "retrain":
            result = cmd_retrain()
        elif cmd == "stats":
            result = cmd_stats()
        else:
            result = {"error": f"unknown command: {cmd}"}
    except Exception as e:
        result = {"error": str(e)}

    print(json.dumps(result))
