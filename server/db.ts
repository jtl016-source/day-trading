import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "app.db");

// Ensure data directory exists
import fs from "fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);

// WAL mode for better concurrent read performance
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");

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
    tp2 REAL NOT NULL,
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

// STORAGE FIX: Do NOT wipe cached_candles on startup.
// MW's persistBulk/persistBar use onConflictDoUpdate — they overwrite individual rows when
// MW re-syncs, so historical Polygon-downloaded data is never lost across server restarts.
// Previously this line: sqlite.exec(`DELETE FROM cached_candles`) wiped months of data.
console.log("[db] cached_candles intact — historical data preserved across restarts");

export const db = drizzle(sqlite, { schema });
