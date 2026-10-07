import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = sqliteTable("users", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const cachedCandles = sqliteTable("cached_candles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  resolution: text("resolution").notNull(),
  timestamp: integer("timestamp").notNull(),
  open: real("open").notNull(),
  high: real("high").notNull(),
  low: real("low").notNull(),
  close: real("close").notNull(),
  volume: integer("volume").notNull().default(0),
}, (t) => [
  uniqueIndex("cached_candles_sym_res_ts").on(t.symbol, t.resolution, t.timestamp),
]);

export const downloadStatus = sqliteTable("download_status", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  status: text("status").notNull().default("none"),
  barCount: integer("bar_count").notNull().default(0),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (t) => [
  uniqueIndex("download_status_sym_y_m").on(t.symbol, t.year, t.month),
]);

export const newsArticles = sqliteTable("news_articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  content: text("content"),
  url: text("url").notNull().unique(),
  source: text("source"),
  imageUrl: text("image_url"),
  publishedAt: text("published_at").notNull(),
  category: text("category").notNull().default("general"),
  searchQuery: text("search_query"),
  fetchedAt: text("fetched_at").default(sql`(datetime('now'))`),
});

export const insertNewsArticleSchema = createInsertSchema(newsArticles).omit({ id: true, fetchedAt: true });
export type InsertNewsArticle = z.infer<typeof insertNewsArticleSchema>;
export type NewsArticle = typeof newsArticles.$inferSelect;

export const appSettings = sqliteTable("app_settings", {
  key:   text("key").primaryKey(),
  value: text("value").notNull(),
});

export const signalHistory = sqliteTable("signal_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  interval: text("interval").notNull(),
  timestamp: integer("timestamp").notNull(),
  direction: text("direction").notNull(),
  riskLevel: text("risk_level").notNull(),
  signalType: text("signal_type"),
  entry: real("entry").notNull(),
  tp1: real("tp1").notNull(),
  tp2: real("tp2"), // TP1-ONLY policy (2026-08-13): null = one target only (all new rows)
  sl: real("sl").notNull(),
  outcome: text("outcome"),
  patternBars: integer("pattern_bars"),
  footprintReading: text("footprint_reading"),
  // JSON {milkOk, milkPts, vecOk, secondaryVecOk, secondaryVecCount} — lets the iPhone
  // render the exact confirmation breakdown the PC computed (MilkZone/Vector/Footprint chips).
  confirmations: text("confirmations"),
  // BACKTEST-GRADE EXIT DETAIL (2026-07-29): additive/nullable — filled by --persist (harness
  // 1m walkExit) and by the live engine's walk-forward when a live-fired signal resolves.
  // The Signals tab / SignalDetail / chart markers read these instead of re-deriving P&L.
  exitPrice: real("exit_price"),
  exitTs: integer("exit_ts"),
  pointsResult: real("points_result"),
  mae: real("mae"),
  mfe: real("mfe"),
  barsToExit: integer("bars_to_exit"),
  // FACT-ENGINE: composite fact-list label, e.g. "Vector(5m SE↑ + 15m tabletop) + Zone(support @6512)".
  // Replaces the tier badge in the Signals UI. Additive/nullable — old rows have NULL.
  label: text("label"),
  // RISK DISPLAY (2026-07-30): display-only — the fire-time canonical fact-family combo key
  // ("FG+Fr+YB") + situational risk flags (JSON string array, e.g. '["no-footprint","late-entry"]').
  // Additive/nullable — rows without them display gracefully with no risk info.
  comboKey: text("combo_key"),
  riskFlags: text("risk_flags"),
  // POSITION SIZING (2026-08-02 — display/config-only): the engine's fire-time suggested
  // contract count from the combo's held-out track-record tier (PROVEN = 2, else 1 — shared
  // SIZE_BY_COMBO_TIER). Additive/nullable; NEVER sizes a trade without the explicit
  // "Size by combo tier" opt-in (default OFF).
  suggestedContracts: integer("suggested_contracts"),
  // SHADOW TAGS (2026-10-01 — RECORD-ONLY): the fire-time shadow-rule tags (JSON string array,
  // e.g. '["box-side-wrong","range-below-0.25med"]'; '[]' = evaluated, none tripped) from
  // shared/fact-engine computeShadowTags. Additive/nullable — NULL = pre-feature row (not
  // evaluated). Never read by any gate; scored by GET /api/signals/shadow-tags/summary.
  shadowTags: text("shadow_tags"),
  // SOURCE PROVENANCE (2026-07-31, "live-fired records are permanent"): 'live' = written by a
  // live tab (fire / live outcome update) — PERMANENT: the --persist wipe never deletes it and
  // regen upserts yield to it (collision reported, not merged); 'regen' = harness --persist;
  // NULL = legacy pre-column rows (live/regen indistinguishable — treated as regen).
  // Immutable once 'live' (write-guard in POST /api/signals/history + both persist paths).
  source: text("source"),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (t) => [
  uniqueIndex("signal_history_sym_iv_ts_dir").on(t.symbol, t.interval, t.timestamp, t.direction),
]);

export const discordMessages = sqliteTable("discord_messages", {
  messageId:   text("message_id").primaryKey(),
  channelId:   text("channel_id").notNull(),
  channelName: text("channel_name"),
  authorName:  text("author_name").notNull(),
  authorId:    text("author_id").notNull(),
  content:     text("content").notNull(),
  postedAt:    integer("posted_at").notNull(),
  attachments: text("attachments"),
  embeds:      text("embeds"),
  savedAt:     text("saved_at").notNull(),
  hasSignal:   integer("has_signal").notNull().default(0),
  historical:  integer("historical").notNull().default(0),
});

export const discordSignals = sqliteTable("discord_signals", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  messageId:   text("message_id").notNull(),
  author:      text("author").notNull(),
  channel:     text("channel").notNull(),
  symbol:      text("symbol").notNull(),
  direction:   text("direction").notNull(),
  entryPrice:  real("entry_price"),
  tp1:         real("tp1"),
  tp2:         real("tp2"),
  tp3:         real("tp3"),
  sl:          real("sl"),
  confidence:  text("confidence").notNull(),
  executed:    integer("executed").notNull().default(0),
  outcome:     text("outcome"),
  rawText:     text("raw_text").notNull(),
  historical:  integer("historical").notNull().default(0),
  createdAt:   text("created_at").default(sql`(datetime('now'))`),
});

export const discordZones = sqliteTable("discord_zones", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  messageId:   text("message_id").notNull(),
  channelName: text("channel_name"),
  authorName:  text("author_name").notNull(),
  postedAt:    integer("posted_at").notNull(),
  zoneType:    text("zone_type").notNull(),
  labelRaw:    text("label_raw").notNull(),
  top:         real("top").notNull(),
  bottom:      real("bottom").notNull(),
  isBull:      integer("is_bull").notNull(),
  symbol:      text("symbol").notNull().default("MES"),
  raw:         text("raw").notNull(),
}, (t) => [
  uniqueIndex("discord_zones_msg_type_top").on(t.messageId, t.zoneType, t.top),
]);

export const learningSessions = sqliteTable("learning_sessions", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  runAt:       text("run_at").default(sql`(datetime('now'))`),
  symbol:      text("symbol").notNull().default("MES"),
  interval:    text("interval").notNull().default("5m"),
  signalCount: integer("signal_count").notNull().default(0),
  summary:     text("summary"),
  createdAt:   text("created_at").default(sql`(datetime('now'))`),
});

export const strategyProposals = sqliteTable("strategy_proposals", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  strategyId:     text("strategy_id").notNull(),
  ruleKey:        text("rule_key").notNull(),
  proposedChange: text("proposed_change").notNull(),
  rationale:      text("rationale").notNull(),
  samplesUsed:    integer("samples_used").notNull().default(0),
  confidence:     real("confidence").notNull().default(0),
  currentValue:   text("current_value").notNull(),
  proposedValue:  text("proposed_value").notNull(),
  status:         text("status").notNull().default("pending"),
  createdAt:      text("created_at").default(sql`(datetime('now'))`),
  reviewedAt:     text("reviewed_at"),
});

export const tradeJournal = sqliteTable("trade_journal", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  timestamp:    integer("timestamp").notNull(),
  symbol:       text("symbol").notNull().default("MES"),
  direction:    text("direction").notNull(),
  signalId:     integer("signal_id"),
  entryPrice:   real("entry_price").notNull(),
  exitPrice:    real("exit_price"),
  outcome:      text("outcome"),
  pnlPts:       real("pnl_pts"),
  pnlDollars:   real("pnl_dollars"),
  riskLevel:    text("risk_level").notNull().default("safe"),
  followedPlan: integer("followed_plan").notNull().default(1),
  emotionState: text("emotion_state").notNull().default("calm"),
  setupType:    text("setup_type"),
  notes:        text("notes"),
  errorMade:    text("error_made"),
  createdAt:    text("created_at").default(sql`(datetime('now'))`),
});

// MW-SYNC: per (symbol, resolution) sync bookkeeping for the server-driven backfill protocol
export const syncState = sqliteTable("sync_state", {
  symbol:      text("symbol").notNull(),
  resolution:  text("resolution").notNull(),
  earliestTs:  integer("earliest_ts"),
  latestTs:    integer("latest_ts"),
  lastAuditTs: integer("last_audit_ts"),
}, (t) => [
  uniqueIndex("sync_state_sym_res").on(t.symbol, t.resolution),
]);

// MW-SYNC: ranges the provider could not fill (deep-history cap, no-data) — skipped by the auditor
export const unfillableRanges = sqliteTable("unfillable_ranges", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  symbol:     text("symbol").notNull(),
  resolution: text("resolution").notNull(),
  fromTs:     integer("from_ts").notNull(),
  toTs:       integer("to_ts").notNull(),
  attempts:   integer("attempts").notNull().default(0),
  reason:     text("reason"),
});

// MW-SYNC: audit log of continuous-contract roll re-adjustments detected by roll-heal
export const adjustmentLog = sqliteTable("adjustment_log", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  symbol:     text("symbol").notNull(),
  resolution: text("resolution").notNull(),
  detectedAt: integer("detected_at").notNull(),
  delta:      real("delta").notNull(),
  pivotTs:    integer("pivot_ts").notNull(),
});

// FOOTPRINT-STRATEGY: durable per-candle footprint store. The footprint engine builds bid/ask
// ladders in RAM (capped, lost on restart); this table persists each finalized + forming candle
// as a JSON blob so past sessions survive restarts and the 50-candle in-memory cap.
export const footprintCandles = sqliteTable("footprint_candles", {
  id:        integer("id").primaryKey({ autoIncrement: true }),
  symbol:    text("symbol").notNull(),
  interval:  text("interval").notNull(),
  time:      integer("time").notNull(),            // bucket start, unix seconds
  complete:  integer("complete").notNull().default(0),
  data:      text("data").notNull(),               // JSON.stringify(FootprintCandle)
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (t) => [
  uniqueIndex("footprint_candles_sym_iv_time").on(t.symbol, t.interval, t.time),
]);

// SHADOW EXITS (2026-10-01): how alternative single exits would have resolved each fire on the real
// 1m path (server/shadow-exits.ts). Natural key symbol|interval|timestamp|direction × variant × mode
// ("carry" | "apex1655"). outcome: win_tp1 | loss | open | closed (market / moved-stop exit — see
// exit_reason). ref_* = the shipped levels the row was resolved against (a re-levelled fire re-resolves).
export const signalShadowExits = sqliteTable("signal_shadow_exits", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  symbol:     text("symbol").notNull(),
  interval:   text("interval").notNull(),
  timestamp:  integer("timestamp").notNull(),
  direction:  text("direction").notNull(),
  variant:    text("variant").notNull(),
  mode:       text("mode").notNull(),
  session:    text("session"),
  refEntry:   real("ref_entry").notNull(),
  refTp1:     real("ref_tp1").notNull(),
  refSl:      real("ref_sl").notNull(),
  tpPrice:    real("tp_price"),
  slPrice:    real("sl_price"),
  outcome:    text("outcome").notNull(),
  exitReason: text("exit_reason"),
  exitTs:     integer("exit_ts"),
  exitPrice:  real("exit_price"),
  points:     real("points"),
  mae:        real("mae"),
  mfe:        real("mfe"),
  updatedAt:  text("updated_at").default(sql`(datetime('now'))`),
}, (t) => [
  uniqueIndex("signal_shadow_exits_key").on(t.symbol, t.interval, t.timestamp, t.direction, t.variant, t.mode),
]);

// SHADOW SCALPS (2026-10-06 — RECORD ONLY): one row per hypothetical small-target trade from the
// S1 ORB-30 / S2 yellow-box edge-fade shadow test + their hour-matched random nulls (server/shadow-scalps.ts,
// docs/shadow-scalps-README.md). Keyed per session day × strategy × variant × direction × signal bar × null
// draw × bracket cell × fill model; a re-run of a day replaces that day's rows. points = GROSS (friction is
// applied in the summary). era: "backfill" (sessions before the first live run) | "live" (forward record —
// the only rows the kill/promotion rules count). Never read by any engine, gate or order path.
export const shadowScalps = sqliteTable("shadow_scalps", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  symbol:      text("symbol").notNull(),
  dayKey:      text("day_key").notNull(),
  era:         text("era").notNull(),
  strategy:    text("strategy").notNull(),
  variant:     text("variant").notNull(),
  direction:   text("direction").notNull(),
  signalTs:    integer("signal_ts").notNull(),
  seq:         integer("seq").notNull().default(0),
  cell:        text("cell").notNull(),
  tp:          real("tp").notNull(),
  sl:          real("sl").notNull(),
  fillModel:   text("fill_model").notNull(),
  level:       real("level"),
  entryTs:     integer("entry_ts").notNull(),
  entryPrice:  real("entry_price").notNull(),
  tpPrice:     real("tp_price").notNull(),
  slPrice:     real("sl_price").notNull(),
  outcome:     text("outcome").notNull(),
  exitTs:      integer("exit_ts").notNull(),
  exitPrice:   real("exit_price").notNull(),
  points:      real("points").notNull(),
  minutesHeld: integer("minutes_held").notNull(),
  runAt:       integer("run_at").notNull(),
  // S2 box provenance (per day): 'cached' = built from the day box frozen in yellowbox_day_zones (raw
  // values below; S2 `level` = the tick-snapped edge); 'pending' = box not frozen yet, S2 deferred and
  // retried; 'none' = the frozen day has no usable box.
  zoneState:   text("zone_state"),
  zoneTop:     real("zone_top"),
  zoneBottom:  real("zone_bottom"),
}, (t) => [
  uniqueIndex("shadow_scalps_key").on(t.symbol, t.dayKey, t.strategy, t.variant, t.direction, t.signalTs, t.seq, t.cell, t.fillModel),
]);

export type CachedCandle      = typeof cachedCandles.$inferSelect;
export type DownloadStatus    = typeof downloadStatus.$inferSelect;
export type SignalHistory      = typeof signalHistory.$inferSelect;
export type DiscordMessage    = typeof discordMessages.$inferSelect;
export type DiscordSignal     = typeof discordSignals.$inferSelect;
export type LearningSession   = typeof learningSessions.$inferSelect;
export type StrategyProposal  = typeof strategyProposals.$inferSelect;
export type TradeJournalEntry = typeof tradeJournal.$inferSelect;
export type FootprintCandleRow = typeof footprintCandles.$inferSelect;
export type SignalShadowExit  = typeof signalShadowExits.$inferSelect;
export type ShadowScalpRow     = typeof shadowScalps.$inferSelect;
