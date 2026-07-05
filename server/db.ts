import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
import { normalizeSymbol } from "@shared/symbols";
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

// MW-SYNC: server-driven backfill bookkeeping tables
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

// STORAGE FIX: Do NOT wipe cached_candles on startup.
// MW's persistBulk/persistBar use onConflictDoUpdate — they overwrite individual rows when
// MW re-syncs, so historical Polygon-downloaded data is never lost across server restarts.
// Previously this line: sqlite.exec(`DELETE FROM cached_candles`) wiped months of data.
console.log("[db] cached_candles intact — historical data preserved across restarts");

/**
 * SYMBOL-FOLD: one-time (idempotent) merge of contract-keyed rows into root buckets.
 *
 * MW ingest keys rows by the raw contract code getSymbol() returns (e.g. "MESU6"),
 * but the web client queries by continuous ROOT ("MES"). Without this fold, MW history
 * fragments into per-contract buckets the client never reads, and every quarterly roll
 * starts a fresh bucket. This folds each contract symbol into its root:
 *   - INSERT OR IGNORE so existing root rows win on a (symbol,res,ts) collision — the root
 *     rows are the ones the client has been reading, so they are authoritative.
 *   - DELETE the now-duplicated contract rows.
 * Idempotent: a second run finds no symbols where normalizeSymbol(s) !== s → no-ops.
 *
 * Exported so tests can drive it against a throwaway DB.
 */
export function foldContractSymbols(sqlite: Database.Database): void {
  // cached_candles: unique(symbol, resolution, timestamp) → INSERT OR IGNORE is safe.
  // signal_history: unique(symbol, interval, timestamp, direction) → same pattern applies.
  const candleSyms = sqlite
    .prepare(`SELECT DISTINCT symbol FROM cached_candles`)
    .all() as { symbol: string }[];

  let sigSyms: { symbol: string }[] = [];
  try {
    sigSyms = sqlite
      .prepare(`SELECT DISTINCT symbol FROM signal_history`)
      .all() as { symbol: string }[];
  } catch {
    // signal_history may not exist in a stripped-down DB — skip its fold.
  }

  const foldTxn = sqlite.transaction(() => {
    // ── cached_candles ──────────────────────────────────────────────────────
    for (const { symbol } of candleSyms) {
      const root = normalizeSymbol(symbol);
      if (root === symbol) continue; // already a root (or unrecognized) — leave it
      const ins = sqlite
        .prepare(
          `INSERT OR IGNORE INTO cached_candles
             (symbol, resolution, timestamp, open, high, low, close, volume)
           SELECT ?, resolution, timestamp, open, high, low, close, volume
             FROM cached_candles WHERE symbol = ?`,
        )
        .run(root, symbol);
      const del = sqlite
        .prepare(`DELETE FROM cached_candles WHERE symbol = ?`)
        .run(symbol);
      const moved = ins.changes; // rows that actually landed in the root bucket
      const dropped = del.changes - moved; // collisions IGNOREd (existing root row kept)
      console.log(
        `[db] symbol-fold cached_candles ${symbol}->${root}: moved=${moved} dropped=${dropped}`,
      );
    }

    // ── signal_history (has a symbol column; unique constraint makes IGNORE safe) ──
    for (const { symbol } of sigSyms) {
      const root = normalizeSymbol(symbol);
      if (root === symbol) continue;
      const ins = sqlite
        .prepare(
          `INSERT OR IGNORE INTO signal_history
             (symbol, interval, timestamp, direction, risk_level, signal_type,
              entry, tp1, tp2, sl, outcome, pattern_bars, footprint_reading, updated_at)
           SELECT ?, interval, timestamp, direction, risk_level, signal_type,
              entry, tp1, tp2, sl, outcome, pattern_bars, footprint_reading, updated_at
             FROM signal_history WHERE symbol = ?`,
        )
        .run(root, symbol);
      const del = sqlite
        .prepare(`DELETE FROM signal_history WHERE symbol = ?`)
        .run(symbol);
      const moved = ins.changes;
      const dropped = del.changes - moved;
      console.log(
        `[db] symbol-fold signal_history ${symbol}->${root}: moved=${moved} dropped=${dropped}`,
      );
    }
  });
  foldTxn();
}

foldContractSymbols(sqlite);

export const db = drizzle(sqlite, { schema });
