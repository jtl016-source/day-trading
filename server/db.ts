import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
import path from "path";
import { isMainThread } from "worker_threads";

// DB lives at <projectRoot>/data/app.db. Resolve from cwd — both `npm run dev` (tsx) and the
// production `node dist/index.cjs` are launched from the project root — with a DB_PATH env
// override. Avoids import.meta/__dirname, which esbuild leaves empty in the cjs bundle (that
// previously made fileURLToPath("") throw at startup in production).
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(process.cwd(), "data", "app.db");

// Ensure data directory exists
import fs from "fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);

// WAL mode for better concurrent read performance
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
// Explicit write-lock tolerance (2026-07-30). This matches better-sqlite3's constructor default
// (timeout: 5000 → busy_timeout 5000) but is pinned here so it can never regress silently:
// the regen harness (scripts/fact-engine-backtest.ts --persist) and backfill scripts open their
// OWN write connections on this file, and without a busy_timeout a colliding write lock surfaces
// as an instant SQLITE_BUSY 500 instead of a short wait. Readers never block writers under WAL.
sqlite.pragma("busy_timeout = 5000");

// Create tables if they don't exist (idempotent, runs synchronously on startup)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cached_candles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    resolution TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL DEFAULT 0,
    UNIQUE(symbol, resolution, timestamp)
  );
  CREATE TABLE IF NOT EXISTS download_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'none',
    bar_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(symbol, year, month)
  );
  CREATE TABLE IF NOT EXISTS news_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    content TEXT,
    url TEXT NOT NULL UNIQUE,
    source TEXT,
    image_url TEXT,
    published_at TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    search_query TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_tokens (
    token      TEXT PRIMARY KEY,
    platform   TEXT,
    created_at INTEGER,
    last_seen  INTEGER
  );
  CREATE TABLE IF NOT EXISTS signal_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    direction TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    signal_type TEXT,
    entry REAL NOT NULL,
    tp1 REAL NOT NULL,
    tp2 REAL,            -- TP1-ONLY policy (2026-08-13): null = one target only (all new rows)
    sl REAL NOT NULL,
    outcome TEXT,
    pattern_bars INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(symbol, interval, timestamp, direction)
  );
  CREATE TABLE IF NOT EXISTS discord_messages (
    message_id  TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL,
    channel_name TEXT,
    author_name TEXT NOT NULL,
    author_id   TEXT NOT NULL,
    content     TEXT NOT NULL,
    posted_at   INTEGER NOT NULL,
    attachments TEXT,
    saved_at    TEXT NOT NULL,
    has_signal  INTEGER NOT NULL DEFAULT 0,
    historical  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS discord_zones (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   TEXT NOT NULL,
    channel_name TEXT,
    author_name  TEXT NOT NULL,
    posted_at    INTEGER NOT NULL,
    zone_type    TEXT NOT NULL,
    label_raw    TEXT NOT NULL,
    top          REAL NOT NULL,
    bottom       REAL NOT NULL,
    is_bull      INTEGER NOT NULL,
    symbol       TEXT NOT NULL DEFAULT 'MES',
    raw          TEXT NOT NULL,
    UNIQUE(message_id, zone_type, top)
  );
  CREATE TABLE IF NOT EXISTS discord_signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT NOT NULL,
    author      TEXT NOT NULL,
    channel     TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    direction   TEXT NOT NULL,
    entry_price REAL,
    tp1         REAL,
    tp2         REAL,
    tp3         REAL,
    sl          REAL,
    confidence  TEXT NOT NULL,
    executed    INTEGER NOT NULL DEFAULT 0,
    outcome     TEXT,
    raw_text    TEXT NOT NULL,
    historical  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS learning_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at       TEXT DEFAULT (datetime('now')),
    symbol       TEXT NOT NULL DEFAULT 'MES',
    interval     TEXT NOT NULL DEFAULT '5m',
    signal_count INTEGER NOT NULL DEFAULT 0,
    summary      TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
`);

// Idempotent column additions for existing deployments
for (const col of [
  "has_signal INTEGER NOT NULL DEFAULT 0",
  "historical INTEGER NOT NULL DEFAULT 0",
  "embeds TEXT",
]) {
  try { sqlite.exec(`ALTER TABLE discord_messages ADD COLUMN ${col}`); } catch {}
}

// FOOTPRINT-STRATEGY: add footprint_reading column to signal_history (idempotent)
try { sqlite.exec(`ALTER TABLE signal_history ADD COLUMN footprint_reading TEXT`); } catch {} // FOOTPRINT-STRATEGY:
// PC↔iPhone parity: persist the confirmation breakdown so the phone shows the same
// MilkZone/Vector/Footprint chips the PC computed (idempotent).
try { sqlite.exec(`ALTER TABLE signal_history ADD COLUMN confirmations TEXT`); } catch {}
// FACT-ENGINE: composite fact-list label (replaces tier badge in the Signals UI) — additive (idempotent).
try { sqlite.exec(`ALTER TABLE signal_history ADD COLUMN label TEXT`); } catch {}
// BACKTEST-GRADE EXIT DETAIL (2026-07-29): outcome + P&L per trade in the app, matching the
// workbook — written by --persist and by the live outcome-resolution pass (idempotent).
for (const col of [
  "exit_price REAL",
  "exit_ts INTEGER",
  "points_result REAL",
  "mae REAL",
  "mfe REAL",
  "bars_to_exit INTEGER",
]) {
  try { sqlite.exec(`ALTER TABLE signal_history ADD COLUMN ${col}`); } catch {}
}
// RISK DISPLAY (2026-07-30): display-only per-signal risk info — the fire-time canonical
// fact-family combo key (quality-gate comboKeyOf, e.g. "FG+Fr+YB") + the situational risk
// flags as a JSON string array (shared/fact-engine computeRiskFlags). Written by the live
// engine POST, --persist, and the one-time analysis backfill. Additive (idempotent).
for (const col of ["combo_key TEXT", "risk_flags TEXT"]) {
  try { sqlite.exec(`ALTER TABLE signal_history ADD COLUMN ${col}`); } catch {}
}
// SOURCE PROVENANCE (2026-07-31): 'live' | 'regen' | NULL(legacy=regen) — live rows are
// permanent (wipe-exempt, collision-yielding, source immutable once 'live'). Additive.
try { sqlite.exec(`ALTER TABLE signal_history ADD COLUMN source TEXT`); } catch {}
// POSITION SIZING (2026-08-02): engine-suggested contract count from the combo tier
// (display/config-only — see shared/schema.ts). Additive (idempotent).
try { sqlite.exec(`ALTER TABLE signal_history ADD COLUMN suggested_contracts INTEGER`); } catch {}
// SHADOW TAGS (2026-10-01): record-only fire-time shadow-rule tags (JSON string array; NULL =
// pre-feature row). Additive (idempotent) — see shared/schema.ts.
try { sqlite.exec(`ALTER TABLE signal_history ADD COLUMN shadow_tags TEXT`); } catch {}

// TRADE-JOURNAL: user trade log table
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS trade_journal (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     INTEGER NOT NULL,
    symbol        TEXT NOT NULL DEFAULT 'MES',
    direction     TEXT NOT NULL,
    signal_id     INTEGER,
    entry_price   REAL NOT NULL,
    exit_price    REAL,
    outcome       TEXT,
    pnl_pts       REAL,
    pnl_dollars   REAL,
    risk_level    TEXT NOT NULL DEFAULT 'safe',
    followed_plan INTEGER NOT NULL DEFAULT 1,
    emotion_state TEXT NOT NULL DEFAULT 'calm',
    setup_type    TEXT,
    notes         TEXT,
    error_made    TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );
`); // TRADE-JOURNAL:

// SELF-LEARNING: strategy proposals table for machine-generated rule changes
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS strategy_proposals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id     TEXT NOT NULL,
    rule_key        TEXT NOT NULL,
    proposed_change TEXT NOT NULL,
    rationale       TEXT NOT NULL,
    samples_used    INTEGER NOT NULL DEFAULT 0,
    confidence      REAL NOT NULL DEFAULT 0,
    current_value   TEXT NOT NULL,
    proposed_value  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT DEFAULT (datetime('now')),
    reviewed_at     TEXT
  );
`); // SELF-LEARNING:

// SIGNAL-LABELS: persistent user feedback on individual signals (ML training data)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS signal_labels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_key  TEXT NOT NULL UNIQUE,
    signal_time INTEGER NOT NULL,
    direction   TEXT NOT NULL,
    risk_level  TEXT NOT NULL,
    outcome     TEXT NOT NULL DEFAULT 'Open',
    is_bad      INTEGER NOT NULL DEFAULT 0,
    reason      TEXT,
    note        TEXT,
    labeled_at  TEXT DEFAULT (datetime('now'))
  );
`); // SIGNAL-LABELS:

// FOOTPRINT-STRATEGY: durable footprint candle store — the engine keeps only the last 50 candles
// per symbol+interval in RAM and loses everything on restart. This table persists them as JSON.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS footprint_candles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol     TEXT NOT NULL,
    interval   TEXT NOT NULL,
    time       INTEGER NOT NULL,
    complete   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(symbol, interval, time)
  );
`); // FOOTPRINT-STRATEGY:

// YELLOW-BOX: per-trading-day walk-forward zone cache (GET /api/yellowbox/day-zones).
// Completed days are IMMUTABLE (each day derived only from bars strictly before its own session),
// so once a day's session has ended its row is frozen — warm requests read here in sub-ms without
// touching cached_candles. `traded=0` marks a known non-trading weekday (holiday) so the endpoint
// never re-scans bars for it. Today's/forming day is recomputed on request and NOT persisted here.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS yellowbox_day_zones (
    symbol          TEXT NOT NULL,
    day_key         TEXT NOT NULL,
    traded          INTEGER NOT NULL DEFAULT 1,
    session_start   INTEGER,
    session_end     INTEGER,
    settle          REAL,
    box_top         REAL,
    box_bottom      REAL,
    init_res        REAL,
    init_sup        REAL,
    max_range_up    REAL,
    max_range_dn    REAL,
    normal_range_dn REAL,
    max_trend_up    REAL,
    ver             INTEGER,
    long_ave        REAL,
    short_ave       REAL,
    normal_range_up REAL,
    bands           TEXT,
    PRIMARY KEY (symbol, day_key)
  );
`); // YELLOW-BOX:
// YELLOW-BOX v2 columns (idempotent — SQLite has no ADD COLUMN IF NOT EXISTS; the "duplicate
// column" error on an already-migrated DB is expected and swallowed). `ver` is the cache-payload
// version: rows whose ver != the server's YB_CACHE_VER are treated as uncached and regenerate.
// v3 adds `import_hash` (hash of the mwml figure set the day's bands were built from — a new or
// updated .mwml file changes the hash so affected days lazily regenerate instead of staying
// frozen) and `low_conf` (day derived from <20 prior trading days — flagged in the payload).
for (const col of [
  "ver INTEGER", "long_ave REAL", "short_ave REAL", "normal_range_up REAL", "bands TEXT",
  "import_hash TEXT", "low_conf INTEGER",
]) {
  try { sqlite.exec(`ALTER TABLE yellowbox_day_zones ADD COLUMN ${col}`); } catch { /* exists */ }
}

// CANDLE GRID GUARD: the single lowest-level cached_candles write backstop. Every INSERT —
// drizzle, raw prepared statements, scripts, future code — passes through this BEFORE INSERT
// trigger: a row whose timestamp is not aligned to its resolution grid (res minutes × 60) is
// logged to candle_write_rejects and DROPPED (RAISE(IGNORE)), never stored. This is what killed
// the Yahoo forming-bar snapshot rows (O=H=L=C V=0 stamped at the fetch wall-clock second).
// NOTE on RAISE(IGNORE) semantics: it abandons the REMAINDER of the statement that fired the
// trigger — for a multi-row INSERT the rows after the offending one are skipped too. Every bulk
// write path therefore pre-filters off-grid rows in JS (validateBar / explicit % checks) so the
// trigger only ever fires on single stray rows from future bugs. DROP+CREATE keeps the definition
// current across deploys (idempotent).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS candle_write_rejects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol     TEXT NOT NULL,
    resolution TEXT NOT NULL,
    timestamp  INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    seen_at    INTEGER NOT NULL
  );
`);
// (2026-09-18) This module now also loads inside the live-engine WORKER thread (its own
// connection). The DROP+CREATE below is only needed once per process start, and outside a
// transaction it left a moment with NO grid guard while the main thread's writers were live —
// so it runs on the main thread only, and atomically.
if (isMainThread) sqlite.exec(`
  BEGIN IMMEDIATE;
  DROP TRIGGER IF EXISTS trg_cached_candles_grid_guard;
  CREATE TRIGGER trg_cached_candles_grid_guard
  BEFORE INSERT ON cached_candles FOR EACH ROW
  WHEN NEW.resolution IN ('1','5','15','60')
   AND (NEW.timestamp % (CAST(NEW.resolution AS INTEGER) * 60)) != 0
  BEGIN
    INSERT INTO candle_write_rejects (symbol, resolution, timestamp, reason, seen_at)
    VALUES (NEW.symbol, NEW.resolution, NEW.timestamp, 'off-grid', strftime('%s','now'));
    SELECT RAISE(IGNORE);
  END;
  COMMIT;
`); // CANDLE GRID GUARD:

// MW-SYNC: server-driven backfill bookkeeping tables (additive, idempotent — never drops data).
// sync_state tracks the earliest/latest bar per (symbol, resolution) and the deep-history cap;
// unfillable_ranges remembers ranges MW cannot supply so the auditor stops re-requesting them;
// adjustment_log records continuous-contract roll re-adjustments applied by roll-heal.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sync_state (
    symbol        TEXT NOT NULL,
    resolution    TEXT NOT NULL,
    earliest_ts   INTEGER,
    latest_ts     INTEGER,
    last_audit_ts INTEGER,
    PRIMARY KEY (symbol, resolution)
  );
  CREATE TABLE IF NOT EXISTS unfillable_ranges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol     TEXT NOT NULL,
    resolution TEXT NOT NULL,
    from_ts    INTEGER NOT NULL,
    to_ts      INTEGER NOT NULL,
    attempts   INTEGER DEFAULT 0,
    reason     TEXT
  );
  CREATE TABLE IF NOT EXISTS adjustment_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT NOT NULL,
    resolution  TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    delta       REAL NOT NULL,
    pivot_ts    INTEGER NOT NULL
  );
`); // MW-SYNC:

// SHADOW EXITS (2026-10-01): per-fire alternative-exit records (server/shadow-exits.ts) — keyed by
// the signal natural key × variant × mode. Record-only: nothing reads it for trading. Additive.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS signal_shadow_exits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT NOT NULL,
    interval    TEXT NOT NULL,
    timestamp   INTEGER NOT NULL,
    direction   TEXT NOT NULL,
    variant     TEXT NOT NULL,
    mode        TEXT NOT NULL,
    session     TEXT,
    ref_entry   REAL NOT NULL,
    ref_tp1     REAL NOT NULL,
    ref_sl      REAL NOT NULL,
    tp_price    REAL,
    sl_price    REAL,
    outcome     TEXT NOT NULL,
    exit_reason TEXT,
    exit_ts     INTEGER,
    exit_price  REAL,
    points      REAL,
    mae         REAL,
    mfe         REAL,
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(symbol, interval, timestamp, direction, variant, mode)
  );
  CREATE INDEX IF NOT EXISTS idx_signal_shadow_exits_ts ON signal_shadow_exits(symbol, timestamp);
  -- COVERING index for the pending-fire scan (shadow-exits.ts resolvePending): 371 ms → 28 ms
  -- measured on a 5k-fire / 70k-row copy — without it every pass re-reads the table per fire.
  CREATE INDEX IF NOT EXISTS idx_signal_shadow_exits_done ON signal_shadow_exits(
    symbol, interval, timestamp, direction, variant, ref_entry, ref_tp1, ref_sl, outcome, exit_reason);
`); // SHADOW EXITS:

// SHADOW SCALPS (2026-10-06): record-only S1 ORB-30 / S2 yellow-box edge-fade trades + hour-matched
// random nulls (server/shadow-scalps.ts) — the ONLY table that module writes. Additive.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS shadow_scalps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol       TEXT NOT NULL,
    day_key      TEXT NOT NULL,
    era          TEXT NOT NULL,
    strategy     TEXT NOT NULL,
    variant      TEXT NOT NULL,
    direction    TEXT NOT NULL,
    signal_ts    INTEGER NOT NULL,
    seq          INTEGER NOT NULL DEFAULT 0,
    cell         TEXT NOT NULL,
    tp           REAL NOT NULL,
    sl           REAL NOT NULL,
    fill_model   TEXT NOT NULL,
    level        REAL,
    entry_ts     INTEGER NOT NULL,
    entry_price  REAL NOT NULL,
    tp_price     REAL NOT NULL,
    sl_price     REAL NOT NULL,
    outcome      TEXT NOT NULL,
    exit_ts      INTEGER NOT NULL,
    exit_price   REAL NOT NULL,
    points       REAL NOT NULL,
    minutes_held INTEGER NOT NULL,
    run_at       INTEGER NOT NULL,
    zone_state   TEXT,
    zone_top     REAL,
    zone_bottom  REAL,
    UNIQUE(symbol, day_key, strategy, variant, direction, signal_ts, seq, cell, fill_model)
  );
  CREATE INDEX IF NOT EXISTS idx_shadow_scalps_day ON shadow_scalps(symbol, day_key);
`); // SHADOW SCALPS:
// zone_state ('cached' | 'pending' | 'none') + the RAW day box (zone_top / zone_bottom) the day's S2
// rows were built from — S2 reads only a box FROZEN in yellowbox_day_zones; 'pending' days are re-run
// once it is. Added after the table first shipped (empty) → idempotent ALTERs for an existing table.
for (const col of ["zone_state TEXT", "zone_top REAL", "zone_bottom REAL"]) {
  try { sqlite.exec(`ALTER TABLE shadow_scalps ADD COLUMN ${col}`); } catch { /* exists */ }
}
sqlite.exec(`
  CREATE INDEX IF NOT EXISTS idx_shadow_scalps_era ON shadow_scalps(symbol, era, fill_model);
  CREATE INDEX IF NOT EXISTS idx_shadow_scalps_zone ON shadow_scalps(symbol, zone_state, day_key);
`); // SHADOW SCALPS: digest (live + pessimistic) and deferred-S2 retry reads

// STORAGE FIX: Do NOT wipe cached_candles on startup.
// MW's persistBulk/persistBar use onConflictDoUpdate — they overwrite individual rows when
// MW re-syncs, so historical Polygon-downloaded data is never lost across server restarts.
// Previously this line: sqlite.exec(`DELETE FROM cached_candles`) wiped months of data.
console.log("[db] cached_candles intact — historical data preserved across restarts");

export const db = drizzle(sqlite, { schema });

// RISK DISPLAY (2026-07-30): the raw better-sqlite3 handle, for read-only helpers that share
// code with the backtest harness (shared/day-range-median.ts — the dead-tape baseline served
// by GET /api/risk/combo-stats must be computed by the SAME implementation the harness uses).
export const sqliteRaw = sqlite;
