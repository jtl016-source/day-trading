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

export type CachedCandle = typeof cachedCandles.$inferSelect;
export type DownloadStatus = typeof downloadStatus.$inferSelect;
