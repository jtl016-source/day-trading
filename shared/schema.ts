import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, bigint, doublePrecision, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const cachedCandles = pgTable("cached_candles", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  resolution: varchar("resolution", { length: 10 }).notNull(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  open: doublePrecision("open").notNull(),
  high: doublePrecision("high").notNull(),
  low: doublePrecision("low").notNull(),
  close: doublePrecision("close").notNull(),
  volume: bigint("volume", { mode: "number" }).notNull().default(0),
}, (t) => [
  unique().on(t.symbol, t.resolution, t.timestamp),
]);

export const downloadStatus = pgTable("download_status", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("none"),
  barCount: integer("bar_count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  unique().on(t.symbol, t.year, t.month),
]);

export const newsArticles = pgTable("news_articles", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  content: text("content"),
  url: text("url").notNull(),
  source: varchar("source", { length: 100 }),
  imageUrl: text("image_url"),
  publishedAt: timestamp("published_at").notNull(),
  category: varchar("category", { length: 50 }).notNull().default("general"),
  searchQuery: varchar("search_query", { length: 200 }),
  fetchedAt: timestamp("fetched_at").defaultNow(),
}, (t) => [
  unique().on(t.url),
]);

export const insertNewsArticleSchema = createInsertSchema(newsArticles).omit({ id: true, fetchedAt: true });
export type InsertNewsArticle = z.infer<typeof insertNewsArticleSchema>;
export type NewsArticle = typeof newsArticles.$inferSelect;

export type CachedCandle = typeof cachedCandles.$inferSelect;
export type DownloadStatus = typeof downloadStatus.$inferSelect;
