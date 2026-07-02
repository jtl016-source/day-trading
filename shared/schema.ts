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
  tp2: real("tp2").notNull(),
  sl: real("sl").notNull(),
  outcome: text("outcome"),
  patternBars: integer("pattern_bars"),
  footprintReading: text("footprint_reading"), // FOOTPRINT-STRATEGY: JSON FootprintReading, nullable
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
  attachments: text("attachments"),  // JSON: [{url,filename,contentType,size,width?,height?}]
  embeds:      text("embeds"),        // JSON: Discord embed objects (link previews, images)
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
  summary:     text("summary"),          // JSON: LearningLog
  createdAt:   text("created_at").default(sql`(datetime('now'))`),
});

// SELF-LEARNING: machine-generated strategy rule proposals, approved/rejected by user
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
  status:         text("status").notNull().default("pending"),  // "pending" | "approved" | "rejected"
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

export type CachedCandle      = typeof cachedCandles.$inferSelect;
export type DownloadStatus    = typeof downloadStatus.$inferSelect;
export type SignalHistory      = typeof signalHistory.$inferSelect;
export type DiscordMessage    = typeof discordMessages.$inferSelect;
export type DiscordSignal     = typeof discordSignals.$inferSelect;
export type LearningSession   = typeof learningSessions.$inferSelect;
export type StrategyProposal  = typeof strategyProposals.$inferSelect;
export type TradeJournalEntry = typeof tradeJournal.$inferSelect;
