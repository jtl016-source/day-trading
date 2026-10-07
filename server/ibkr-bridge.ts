/**
 * IBKR BRIDGE (2026-09-23) — Interactive Brokers in place of the three MotiveWave studies.
 *
 * MotiveWave's TickRelay / LiveBarRelay / AutoTrader are only a BRIDGE between a broker feed
 * and this server: they speak a small JSON protocol over /ws/mw-feed and /ws/order-commands.
 * This module speaks the SAME protocol in-process, against IB Gateway on localhost, so
 * nothing downstream changes:
 *
 *   data in   IB tick-by-tick "AllLast"      → ingestStudyMessage({type:"tick", symbol:"MESZ6", price, time})
 *             IB 1-min TRADES keepUpToDate  → ingestStudyMessage({type:"bar", resolution:"1", … complete:true})
 *             connect                        → {type:"bulk_bars"} (last IB_BACKFILL_DAYS of 1m, LiveBarRelay-style v1 dump)
 *                                              then {type:"hello", ver:2} so gap-audit registers the source and can
 *                                              ask it for backfills (serviced here with IB pacing)
 *   orders    broadcastOrderCommand(order_command) → executor → IB bracket (MKT parent + LMT take-profit
 *             + STP stop, parentId-linked, transmit chained, GTC, ONE take-profit for the full quantity —
 *             the TP1-only policy) → IB order events → ingestAutoTraderEvent(order_ack / order_filled /
 *             bracket_flattened / orders_cancelled / order_error / flag_reset) exactly as AutoTrader emits them.
 *
 * The raw symbol carries the MONTH CODE ("MESZ6") because server/contract-guard.ts keys its
 * roll logic on it and shared/symbol.ts normalizeSymbol strips it for storage.
 *
 * OFF by default. server/index.ts starts it only when IB_ENABLED=true; the /api/ibkr/status
 * route exists either way and says {enabled:false} otherwise. NO credentials live here — the
 * bridge only ever talks to the local API socket — TWS (live 7496 / paper 7497) or IB Gateway
 * (live 4001 / paper 4002); docs/ibkr-setup.md covers both.
 *
 * Pure, testable pieces (scripts/ibkr-bridge.test.ts): selectFrontMonth, rawSymbolFor,
 * parseIbDate, buildBracket, BarStream, HistoricalPacer, classifyIbError. The IbkrBridge
 * class takes every live dependency by injection (api, ingest, emitEvent, executor registry,
 * timers), so the tests drive it with a mock IBApi (an EventEmitter with the same method and
 * event names). startIbkrBridge() does the real wiring with lazy imports — importing this
 * module never touches the database or opens a socket.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Express } from "express";
import type { WebSocket } from "ws";
import type { StudyIngestCtx, StudyMessage } from "./live-bars"; // type-only: no runtime import of live-bars here
import {
  EventName, SecType, OrderAction, OrderType, TimeInForce, OrderStatus, BarSizeSetting, WhatToShow,
  TickByTickDataType, type Contract, type ContractDetails, type Order, type OrderState, type Execution,
  type ExecutionFilter, type OrderCancel,
} from "@stoqey/ib";
import { artifactsDir } from "@shared/artifacts-dir";

// ── Configuration (env) ──────────────────────────────────────────────────────────────────
export interface IbkrConfig {
  enabled: boolean;
  host: string;
  port: number;
  clientId: number;
  account?: string;
  symbolRoot: string;
  exchange: string;
  currency: string;
  /** IB_CONTRACT — pin a contract ("MESZ6") instead of the roll rule. */
  contractOverride?: string;
  /** IB_ROLL_DAYS_BEFORE_EXPIRY — switch to the next contract this many days before lastTradeDate.
   *  Default 4 = the Monday of expiry week, matching Yahoo's observed ES=F roll (2026-09-14 for the
   *  09-18 expiry) so the contract guard keeps pairing like with like; 8 (the CME volume roll)
   *  would put IB on the new month ~4 days before Yahoo and trip the guard every quarter. */
  rollDaysBeforeExpiry: number;
  /** IB_BACKFILL_DAYS — 1m history pulled on connect (the LiveBarRelay-style bulk_bars dump). */
  backfillDays: number;
  /** IB_SERVE_BACKFILL — answer gap-audit backfill requests from IB history. */
  serveBackfill: boolean;
  /** IB_BACKFILL_MAX_DAYS — oldest range gap-audit may have serviced from IB. */
  backfillMaxDays: number;
  /** IB_STOP_TYPE — "STP" (stop-market, default) or "STP LMT" (AutoTrader's 2-pt slip cap). */
  stopType: "STP" | "STP LMT";
  stopSlipPts: number;
  heartbeatSec: number;
  rollCheckHours: number;
  /** A forming 1m bar whose bucket ended this long ago is emitted complete even without a newer update. */
  barCloseGraceSec: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): IbkrConfig {
  const num = (k: string, d: number) => { const v = Number(env[k]); return Number.isFinite(v) && env[k] !== undefined && env[k] !== "" ? v : d; };
  const bool = (k: string, d: boolean) => { const v = (env[k] ?? "").trim().toLowerCase(); return v === "" ? d : v === "true" || v === "1" || v === "yes"; };
  const stop = (env.IB_STOP_TYPE ?? "STP").trim().toUpperCase().replace("_", " ");
  return {
    enabled: bool("IB_ENABLED", false),
    host: (env.IB_HOST ?? "127.0.0.1").trim(),
    port: num("IB_PORT", 4002),
    clientId: num("IB_CLIENT_ID", 17),
    account: (env.IB_ACCOUNT ?? "").trim() || undefined,
    symbolRoot: (env.IB_SYMBOL ?? "MES").trim().toUpperCase(),
    exchange: (env.IB_EXCHANGE ?? "CME").trim().toUpperCase(),
    currency: (env.IB_CURRENCY ?? "USD").trim().toUpperCase(),
    contractOverride: (env.IB_CONTRACT ?? "").trim().toUpperCase() || undefined,
    rollDaysBeforeExpiry: num("IB_ROLL_DAYS_BEFORE_EXPIRY", 4),
    backfillDays: Math.max(1, Math.min(5, num("IB_BACKFILL_DAYS", 2))),
    serveBackfill: bool("IB_SERVE_BACKFILL", true),
    backfillMaxDays: Math.max(1, num("IB_BACKFILL_MAX_DAYS", 30)),
    stopType: stop === "STP LMT" ? "STP LMT" : "STP",
    stopSlipPts: num("IB_STOP_SLIP_PTS", 2),
    heartbeatSec: Math.max(10, num("IB_HEARTBEAT_SEC", 30)),
    rollCheckHours: Math.max(1, num("IB_ROLL_CHECK_HOURS", 6)),
    barCloseGraceSec: Math.max(1, num("IB_BAR_CLOSE_GRACE_SEC", 5)),
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────
export const MONTH_CODES = "FGHJKMNQUVXZ";
export const TICK_SIZE = 0.25;
export const roundTick = (p: number): number => Math.round(p / TICK_SIZE) * TICK_SIZE;

/** Offset (minutes) of an IANA zone at a UTC instant — the Intl trick, no tz library. */
function tzOffsetMin(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - utcMs) / 60_000);
}

/** IB date strings → epoch seconds. Handles "1789653000" (formatDate=2), "20260917 09:50:00",
 *  "20260917  09:50:00 US/Eastern", "20260917-13:50:00" (UTC form) and "20260917" (midnight UTC).
 *  Wall-clock forms without a zone are read in `defaultTz`. Returns null for junk. */
export function parseIbDate(s: string | number | undefined | null, defaultTz = "America/New_York"): number | null {
  if (s == null) return null;
  const str = String(s).trim();
  if (/^\d{9,11}$/.test(str)) return Number(str);
  let m = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
  m = str.match(/^(\d{4})(\d{2})(\d{2})(-|\s+)(\d{2}):(\d{2}):(\d{2})(?:\s+(\S+))?$/);
  if (!m) return null;
  const [y, mo, d, hh, mm, ss] = [+m[1], +m[2], +m[3], +m[5], +m[6], +m[7]];
  const naive = Date.UTC(y, mo - 1, d, hh, mm, ss);
  if (m[4] === "-" && !m[8]) return Math.floor(naive / 1000); // API v10 "yyyymmdd-hh:mm:ss" = UTC
  const tz = m[8] ?? defaultTz;
  try {
    // Two-pass offset correction handles DST edges.
    let guess = naive - tzOffsetMin(tz, naive) * 60_000;
    guess = naive - tzOffsetMin(tz, guess) * 60_000;
    return Math.floor(guess / 1000);
  } catch { return Math.floor(naive / 1000); }
}

/** "YYYYMMDD-HH:MM:SS" in UTC — the endDateTime form IB's newer API reads unambiguously.
 *  G2 (2026-09-23): this dash form IS IB's explicit-UTC form — the exact format warning 2174
 *  ("…without explicit time zone. Please switch to use yyyymmdd-hh:mm:ss in UTC or use
 *  instrument time zone, like US/Eastern") asks for — so it never provokes 2174. Do NOT switch
 *  to the space form ("yyyymmdd hh:mm:ss") without a zone suffix, and do not append " UTC" to
 *  the dash form (not a documented IB format). The live keepUpToDate request sends "" (now). */
export function ibDateTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export interface ContractLike { conId?: number; symbol?: string; localSymbol?: string; lastTradeDateOrContractMonth?: string; lastTradeDate?: string; exchange?: string; currency?: string; secType?: string; tradingClass?: string }
export interface ContractDetailsLike { contract: ContractLike; contractMonth?: string; realExpirationDate?: string; lastTradeTime?: string; timeZoneId?: string }

/** The contract's last trade date as epoch seconds (UTC midnight of that day), or null. */
/** The only forms IB accepts in a REQUEST contract: yyyymmdd or yyyymm (IB 10372 otherwise).
 *  contractDetails may deliver "20261218 08:30:00 US/Central" — keep the leading date only. */
export function requestDateField(raw: string | undefined | null): string | undefined {
  const m = String(raw ?? "").trim().match(/^(\d{8}|\d{6})(?!\d)/);
  return m ? m[1] : undefined;
}

export function contractLastTradeSec(c: ContractLike): number | null {
  const raw = (c.lastTradeDateOrContractMonth ?? c.lastTradeDate ?? "").trim();
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
}

/** 00:00 America/New_York of the calendar date whose UTC midnight is `utcMidnightSec` (IB's
 *  yyyymmdd dates parse as UTC midnight = 19:00/20:00 ET the evening BEFORE). */
export function etMidnightSec(utcMidnightSec: number): number {
  const ms = utcMidnightSec * 1000;
  let guess = ms - tzOffsetMin("America/New_York", ms) * 60_000;
  guess = ms - tzOffsetMin("America/New_York", guess) * 60_000; // second pass: DST edges
  return Math.floor(guess / 1000);
}

/** The third Friday of `month1to12` (the CME equity-index quarterly expiry day) as UTC midnight. */
export function thirdFridayUtcSec(year: number, month1to12: number): number {
  const dow = new Date(Date.UTC(year, month1to12 - 1, 1)).getUTCDay(); // 0 = Sunday
  const firstFriday = 1 + ((5 - dow + 7) % 7);
  return Math.floor(Date.UTC(year, month1to12 - 1, firstFriday + 14) / 1000);
}

/** SEEDED start of the current contract's era in THIS DB (post-build review F1, 2026-09-23):
 *  before the bridge existed the store rolled when Yahoo's ES=F rolled (~4 days before expiry —
 *  2026-09-14 for the 09-18 expiry), and while the bridge and Yahoo disagree the contract guard
 *  keeps Yahoo the writer — so the new month owns the store from ~min(rollDays, 4) days before
 *  the PREVIOUS contract's expiry, plus a one-day margin so the roll day itself is never served.
 *  The previous expiry is `prevLastTradeSec` while IB still lists that contract, else the third
 *  Friday three months before the current contract's month (reqContractDetails uses
 *  includeExpired:false, so the previous contract disappears the day it expires). */
export function seedEraStartSec(choice: Pick<FrontMonthChoice, "lastTradeSec" | "prevLastTradeSec">, rollDays: number): number {
  let prevExpiry = choice.prevLastTradeSec;
  if (prevExpiry == null) {
    const d = new Date(choice.lastTradeSec * 1000);
    let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1 - 3;
    if (m < 1) { m += 12; y -= 1; }
    prevExpiry = thirdFridayUtcSec(y, m);
  }
  return etMidnightSec(prevExpiry) - Math.min(Math.max(0, rollDays), 4) * 86400 + 86400;
}

/** Study-style raw symbol — root + month letter + ONE-digit year ("MESZ6"), what TickRelay
 *  sends and what contract-guard's month-code watch expects. Derived from IB's localSymbol
 *  when it has that shape (CME futures do: "MESZ6"), else from contractMonth / lastTradeDate. */
export function rawSymbolFor(c: ContractLike, root: string, details?: Pick<ContractDetailsLike, "contractMonth">): string {
  const R = root.toUpperCase();
  const ls = (c.localSymbol ?? "").toUpperCase().trim();
  const m = ls.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1,2})$/);
  if (m && m[1] === R) return `${R}${m[2]}${m[3].slice(-1)}`;
  const cm = (details?.contractMonth ?? "").match(/^(\d{4})(\d{2})$/);
  if (cm) return `${R}${MONTH_CODES[+cm[2] - 1]}${(+cm[1]) % 10}`;
  const sec = contractLastTradeSec(c);
  if (sec != null) { const d = new Date(sec * 1000); return `${R}${MONTH_CODES[d.getUTCMonth()]}${d.getUTCFullYear() % 10}`; }
  return R;
}

export interface FrontMonthChoice { details: ContractDetailsLike; rawSymbol: string; lastTradeSec: number; rollAtSec: number; reason: "override" | "nearest" | "last-listed"; prevLastTradeSec: number | null }

/** Front-month selection: the nearest expiry, but roll to the NEXT contract `rollDays` before
 *  lastTradeDate (CME e-mini liquidity moves on the Thursday before the third Friday — 8 days
 *  before expiry). `override` ("MESZ6") pins a contract; unknown override → null (nothing is
 *  subscribed — better than silently trading the wrong month).
 *  The roll instant is 00:00 ET of the roll DAY (post-build review F10): IB's yyyymmdd parses
 *  as UTC midnight, and subtracting days from that switched at 19:00/20:00 ET the evening
 *  before — mid-ETH, with live brackets and Yahoo still on the old month. */
export function selectFrontMonth(list: ContractDetailsLike[], nowMs: number, rollDays: number, root: string, override?: string): FrontMonthChoice | null {
  const R = root.toUpperCase();
  const rows = list
    .map(d => ({ d, lt: contractLastTradeSec(d.contract), raw: rawSymbolFor(d.contract, root, d) }))
    .filter((r): r is { d: ContractDetailsLike; lt: number; raw: string } => r.lt != null && (r.d.contract.symbol ?? R).toUpperCase() === R)
    .sort((a, b) => a.lt - b.lt);
  if (rows.length === 0) return null;
  const rollSec = Math.max(0, rollDays) * 86400;
  const rollAt = (lt: number) => etMidnightSec(lt) - rollSec;
  const prevOf = (i: number) => (i > 0 ? rows[i - 1].lt : null);
  if (override) {
    const o = override.toUpperCase();
    const i = rows.findIndex(r => r.raw === o || (r.d.contract.localSymbol ?? "").toUpperCase() === o);
    if (i < 0) return null;
    return { details: rows[i].d, rawSymbol: rows[i].raw, lastTradeSec: rows[i].lt, rollAtSec: rollAt(rows[i].lt), reason: "override", prevLastTradeSec: prevOf(i) };
  }
  const nowSec = Math.floor(nowMs / 1000);
  const i = rows.findIndex(r => rollAt(r.lt) > nowSec);
  if (i >= 0) return { details: rows[i].d, rawSymbol: rows[i].raw, lastTradeSec: rows[i].lt, rollAtSec: rollAt(rows[i].lt), reason: "nearest", prevLastTradeSec: prevOf(i) };
  const last = rows.length - 1;
  return { details: rows[last].d, rawSymbol: rows[last].raw, lastTradeSec: rows[last].lt, rollAtSec: rollAt(rows[last].lt), reason: "last-listed", prevLastTradeSec: prevOf(last) };
}

// ── Orders ───────────────────────────────────────────────────────────────────────────────
export interface OrderCommand {
  symbol: string; direction: "Long" | "Short"; interval: string; riskLevel: string;
  price: number; tp1: number; tp2: number | null; sl: number; contracts: number; tp1Only: boolean;
}

export function parseOrderCommand(cmd: Record<string, unknown>): { ok: true; cmd: OrderCommand } | { ok: false; error: string } {
  const direction = cmd.direction === "Long" ? "Long" : cmd.direction === "Short" ? "Short" : null;
  const price = Number(cmd.price), tp1 = Number(cmd.tp1), sl = Number(cmd.sl);
  const tp2 = cmd.tp2 == null ? null : Number(cmd.tp2);
  if (!direction) return { ok: false, error: "direction must be Long or Short" };
  if (!(price > 0) || !(sl > 0)) return { ok: false, error: "price or sl is 0" }; // AutoTrader's exact check
  if (!(tp1 > 0) || tp1 === price) return { ok: false, error: `Invalid TP levels: tp1=${cmd.tp1} entry=${cmd.price} — order rejected` };
  const isLong = direction === "Long";
  if (isLong ? (tp1 <= price || sl >= price) : (tp1 >= price || sl <= price)) return { ok: false, error: `TP/SL on the wrong side of entry for ${direction} (entry ${price}, tp1 ${tp1}, sl ${sl})` };
  return {
    ok: true,
    cmd: {
      symbol: String(cmd.symbol ?? "MES"), direction, interval: String(cmd.interval ?? "?"), riskLevel: String(cmd.riskLevel ?? "safe"),
      price, tp1, tp2, sl,
      contracts: Math.max(1, Math.floor(Number(cmd.contracts) || 1)),
      tp1Only: cmd.tp1Only === true || tp2 == null,
    },
  };
}

export interface BracketOrders { parent: Order; tp: Order; sl: Order; ids: { parent: number; tp: number; sl: number } }

/** Mirror of AutoTrader.submitBracket: MARKET entry (createMarketOrder), GTC everywhere, ONE
 *  take-profit LIMIT for the full quantity at tp1 (TP1-ONLY policy — a tp2 leg is never
 *  created), protective stop at sl (STP, or STP LMT with AutoTrader's slip cap when
 *  configured). Children carry parentId; transmit is false on the parent and the TP and true
 *  on the stop so IB releases the whole chain atomically. */
export function buildBracket(cmd: OrderCommand, firstId: number, opts: { account?: string; stopType: "STP" | "STP LMT"; stopSlipPts: number; orderRef?: string }): BracketOrders {
  const isLong = cmd.direction === "Long";
  const qty = Math.max(1, Math.floor(cmd.contracts));
  const entryAction = isLong ? OrderAction.BUY : OrderAction.SELL;
  const exitAction = isLong ? OrderAction.SELL : OrderAction.BUY;
  const base: Partial<Order> = { tif: TimeInForce.GTC, outsideRth: true, totalQuantity: qty, ...(opts.account ? { account: opts.account } : {}), ...(opts.orderRef ? { orderRef: opts.orderRef } : {}) };
  const ids = { parent: firstId, tp: firstId + 1, sl: firstId + 2 };
  const parent: Order = { ...base, orderId: ids.parent, action: entryAction, orderType: OrderType.MKT, transmit: false };
  const tp: Order = { ...base, orderId: ids.tp, action: exitAction, orderType: OrderType.LMT, lmtPrice: roundTick(cmd.tp1), parentId: ids.parent, transmit: false };
  const slPx = roundTick(cmd.sl);
  const sl: Order = opts.stopType === "STP LMT"
    ? { ...base, orderId: ids.sl, action: exitAction, orderType: OrderType.STP_LMT, auxPrice: slPx, lmtPrice: roundTick(isLong ? slPx - opts.stopSlipPts : slPx + opts.stopSlipPts), parentId: ids.parent, transmit: true }
    : { ...base, orderId: ids.sl, action: exitAction, orderType: OrderType.STP, auxPrice: slPx, parentId: ids.parent, transmit: true };
  return { parent, tp, sl, ids };
}

// ── Bars: completed-bar detection from keepUpToDate updates ──────────────────────────────
export interface Bar1m { time: number; open: number; high: number; low: number; close: number; volume: number }

/** IB's keepUpToDate stream re-sends the FORMING bar (same start time) on every change; a bar
 *  is complete when an update with a NEWER start time arrives — or, failing that, when its
 *  bucket ended `graceSec` ago (flush). A time is emitted ONCE as a new bar; the one exception
 *  (post-build review F7) is a LATE update for the minute just emitted — IB's final values can
 *  land after the 5-s flush already sent the bar — which is re-emitted as a CORRECTION when its
 *  values differ and it arrives within REEMIT_WINDOW_SEC of the emission (only when the caller
 *  passes `nowSec`). Downstream a `bar` message is a broadcast + upsert, so a re-emit is idempotent. */
export class BarStream {
  static readonly REEMIT_WINDOW_SEC = 120;
  forming: Bar1m | null = null;
  lastEmitted = 0;
  /** The bar last emitted and when (nowSec) — the late-update correction window. */
  lastEmittedBar: Bar1m | null = null;
  emittedAtSec = 0;
  corrections = 0;
  constructor(public readonly intervalSec = 60) {}
  reset(): void { this.forming = null; }
  private mark(b: Bar1m, nowSec?: number): void {
    this.lastEmitted = b.time;
    this.lastEmittedBar = b;
    if (nowSec != null) this.emittedAtSec = nowSec;
  }
  onUpdate(bar: Bar1m, nowSec?: number): Bar1m[] {
    if (!Number.isFinite(bar.time) || bar.time <= 0) return [];
    if (bar.time === this.lastEmitted && this.lastEmitted > 0 && (!this.forming || this.forming.time > bar.time)) {
      const prev = this.lastEmittedBar;
      const differs = !prev || prev.open !== bar.open || prev.high !== bar.high || prev.low !== bar.low || prev.close !== bar.close || prev.volume !== bar.volume;
      if (nowSec == null || !differs || nowSec - this.emittedAtSec > BarStream.REEMIT_WINDOW_SEC) return [];
      this.lastEmittedBar = bar;
      this.corrections++;
      return [bar];
    }
    if (!this.forming) { if (bar.time > this.lastEmitted) this.forming = bar; return []; }
    if (bar.time === this.forming.time) { this.forming = bar; return []; }
    if (bar.time < this.forming.time) return []; // late / out-of-order
    const done = this.forming;
    this.forming = bar;
    if (done.time <= this.lastEmitted) return [];
    this.mark(done, nowSec);
    return [done];
  }
  flush(nowSec: number, graceSec: number): Bar1m[] {
    const f = this.forming;
    if (!f) return [];
    if (f.time + this.intervalSec + graceSec > nowSec) return [];
    this.forming = null;
    if (f.time <= this.lastEmitted) return [];
    this.mark(f, nowSec);
    return [f];
  }
}

// ── Historical-data pacing (IB: ≤ 60 requests / 10 min, no identical request within 15 s) ──
export class HistoricalPacer {
  private sent: number[] = [];
  private byKey = new Map<string, number>();
  constructor(private readonly maxPer10Min = 60, private readonly identicalGapMs = 15_000) {}
  /** 0 = send now; otherwise the ms to wait. */
  waitMs(key: string, nowMs: number): number {
    this.sent = this.sent.filter(t => nowMs - t < 600_000);
    let wait = 0;
    const last = this.byKey.get(key);
    if (last != null && nowMs - last < this.identicalGapMs) wait = Math.max(wait, this.identicalGapMs - (nowMs - last));
    if (this.sent.length >= this.maxPer10Min) wait = Math.max(wait, 600_000 - (nowMs - this.sent[0]) + 250);
    return wait;
  }
  note(key: string, nowMs: number): void { this.sent.push(nowMs); this.byKey.set(key, nowMs); }
  get lastTenMin(): number { return this.sent.length; }
}

// ── IB error classification ──────────────────────────────────────────────────────────────
export type IbErrorKind = "connect_failed" | "not_connected" | "connectivity_lost" | "connectivity_restored_data_lost" | "connectivity_restored" | "tws_server_link_broken" | "market_data_delayed" | "no_market_data" | "farm_status" | "hist_no_data" | "hist_pacing" | "order_cancelled" | "order_already_done" | "warning" | "order_rejected" | "other";
export function classifyIbError(code: number, msg: string): IbErrorKind {
  const m = (msg ?? "").toLowerCase();
  switch (code) {
    case 502: return "connect_failed";
    case 504: return "not_connected";
    case 1100: return "connectivity_lost";
    case 1101: return "connectivity_restored_data_lost";
    case 1102: return "connectivity_restored";
    case 2110: return "tws_server_link_broken";
    case 10167: return "market_data_delayed";
    case 10197: case 354: case 10089: case 10090: return "no_market_data";
    case 2104: case 2106: case 2107: case 2108: case 2158: case 2103: case 2105: case 2157: return "farm_status";
    case 162: return m.includes("pacing") ? "hist_pacing" : "hist_no_data";
    case 202: return "order_cancelled";
    case 10147: case 10148: return "order_already_done";
    case 399: return "warning";
    case 201: case 110: case 200: case 203: case 321: case 322: case 10268: case 461: case 10318: return "order_rejected";
    default: return code >= 2100 && code < 3000 ? "warning" : "other";
  }
}

// ── The bridge ───────────────────────────────────────────────────────────────────────────
/** The subset of IBApi this bridge uses. The real IBApi satisfies it; the test mock is an
 *  EventEmitter implementing the same names. */
export interface IbApiLike {
  connect(clientId?: number): unknown;
  disconnect(): unknown;
  readonly isConnected: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  reqIds(numIds?: number): unknown;
  reqCurrentTime(): unknown;
  reqManagedAccts(): unknown;
  reqContractDetails(reqId: number, contract: Contract): unknown;
  reqTickByTickData(reqId: number, contract: Contract, tickType: TickByTickDataType, numberOfTicks: number, ignoreSize: boolean): unknown;
  cancelTickByTickData(reqId: number): unknown;
  reqHistoricalData(reqId: number, contract: Contract, endDateTime: string | undefined, durationStr: string, barSizeSetting: BarSizeSetting, whatToShow: WhatToShow, useRTH: number | boolean, formatDate: number, keepUpToDate: boolean): unknown;
  cancelHistoricalData(reqId: number): unknown;
  placeOrder(id: number, contract: Contract, order: Order): unknown;
  cancelOrder(orderId: number, orderCancelParam?: string | OrderCancel): unknown;
  reqOpenOrders(): unknown;
  reqExecutions(reqId: number, filter: ExecutionFilter): unknown;
}

export interface StudyLinkLike { readyState: number; send(data: string): void }

export interface BridgeDeps {
  api: IbApiLike;
  /** → live-bars.ingestStudyMessage (the /ws/mw-feed protocol). */
  ingest: (msg: Record<string, unknown>) => void;
  /** → live-bars.ingestAutoTraderEvent (the /ws/order-commands protocol). */
  emitEvent: (msg: Record<string, unknown>) => void;
  /** → live-bars.registerOrderExecutor. */
  registerExecutor: (exec: { name: string; isReady: () => boolean; execute: (cmd: Record<string, unknown>) => boolean } | null) => void;
  /** → live-bars.attachInProcessStudy / detachInProcessStudy (gap-audit registration). */
  attachStudy: (link: StudyLinkLike, reply: (msg: object) => void) => unknown;
  detachStudy: (handle: unknown) => void;
  /** → trade-notify (push + Discord); `{type:"ibkr_bridge", title, body}`. */
  notify: (msg: Record<string, unknown>) => void;
  /** Extra order gate (live-bars.orderContractGateReason) — belt and braces. */
  orderGateReason?: () => string | null;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  loadBrackets: () => Bracket[];
  saveBrackets: (list: Bracket[]) => void;
  /** Restart memory beyond brackets (`<BAXTER_ARTIFACTS_DIR>/ibkr-state.json`): the contract
   *  eras — when the bridge itself switched to each raw symbol (post-build review F1). */
  loadState: () => BridgeState;
  saveState: (state: BridgeState) => void;
}

export interface BridgeState {
  /** rawSymbol ("MESH7") → epoch seconds the bridge switched to that contract. */
  eras: Record<string, number>;
}

export interface Bracket {
  key: string;
  createdAt: number;
  cmd: OrderCommand;
  rawSymbol: string;
  conId?: number;
  parentId: number; tpId: number; slId: number;
  parentStatus?: string; tpStatus?: string; slStatus?: string;
  ackSent: boolean;
  filledSent: boolean;
  fillPrice?: number;
  exitPrice?: number;
  closed?: { reason: string; at: number };
  unprotectedWarned?: boolean;
  /** A child leg IB rejected while the entry was still working (the bracket was then cancelled). */
  legRejected?: "tp" | "sl";
  /** Replacement legs placed after a child rejection with the position open (max 1 per leg). */
  replaced?: { tp?: number; sl?: number };
  /** G1 (2026-09-23): placeOrder THREW on this leg after the parent (and maybe the TP) had
   *  already been sent. The sent legs were cancelled; the bracket stays tracked until IB
   *  reports the parent Cancelled (→ closed 'rejected') or Filled (→ replacement stop). */
  placeFailed?: "tp" | "sl";
}

interface BackfillChunk { fromSec: number; toSec: number; retried?: boolean }
interface BackfillJob { id: string; fromSec: number; toSec: number; chunks: BackfillChunk[]; bars: Bar1m[]; started: boolean; /** G6: set when any chunk could not be fully answered — the job is then DECLINED, never partially answered */ incomplete?: string }
interface HistReq { kind: "live" | "backfill"; job?: BackfillJob; chunk?: BackfillChunk; bars: Bar1m[]; retried?: boolean; timer?: unknown }
/** IB farm-status codes whose "… farm connection is OK" text signals the data path is back (G3). */
const FARM_OK_CODES = new Set([2104, 2106, 2158]);

// REQUEST IDS (post-build review F6): IB uses ONE id space for requests and orders, and order
// ids climb from nextValidId without bound — request ids sit far above any order id this
// account will ever reach (IB ids are signed 32-bit: max 2_147_483_647).
export const TICK_REQ_ID = 2_000_000_001;
export const BARS_REQ_ID = 2_000_000_002;
export const CONTRACT_REQ_BASE = 2_000_000_100; // … +49
export const EXEC_REQ_ID = 2_000_000_200;
export const BACKFILL_REQ_BASE = 2_000_000_500;
const BACKFILL_REQ_SPAN = 100_000;
const CONTRACT_REQ_SPAN = 50;
/** An IB historical request with no answer (neither data nor error) for this long is cancelled (F5). */
export const HIST_TIMEOUT_MS = 60_000;
/** Orders need a tick this fresh on the current connection (F3) — no quotes = no order. */
export const ORDER_MAX_TICK_AGE_MS = 90_000;
const BULK_CHUNK = 500;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const HEARTBEAT_DEAD_FACTOR = 3;
const STALE_BRACKET_SEC = 7 * 86400;

export class IbkrBridge {
  readonly cfg: IbkrConfig;
  private readonly d: BridgeDeps;
  private stopped = false;
  private connected = false;
  private connectedAt = 0;
  private connectAttempts = 0;
  private reconnects = 0;
  private backoffMs = RECONNECT_MIN_MS;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private flushTimer: unknown = null;
  private rollTimer: unknown = null;
  private lastHeartbeatAt = 0;
  private lastError: string | null = null;
  private account: string | null = null;
  private nextOrderId = 0;
  private contractReqId = 0;
  private contractRows: ContractDetailsLike[] = [];
  private choice: FrontMonthChoice | null = null;
  private subs = { ticks: false, bars: false };
  private stream = new BarStream(60);
  private histReqs = new Map<number, HistReq>();
  private histDuration: string;
  private backfillQueue: BackfillJob[] = [];
  private backfillInflight: BackfillJob | null = null;
  private backfillTimer: unknown = null;
  private backfillReqId = BACKFILL_REQ_BASE;
  private pacer = new HistoricalPacer();
  private link: StudyLinkLike;
  private studyHandle: unknown = null;
  private brackets: Bracket[] = [];
  private byOrderId = new Map<number, Bracket>();
  private marketData: "unknown" | "realtime" | "delayed" = "unknown";
  private connectivity: "unknown" | "ok" | "lost" = "unknown";
  /** Which IB code put connectivity at "lost" (G3): a 2110 loss also clears on a farm "is OK"
   *  message; a 1100 loss clears only on 1101/1102 (or a fresh socket connect). */
  private connectivityLostBy: 1100 | 2110 | null = null;
  private delayedNotified = false;
  private lastTickAt = 0;
  /** Last tick received on the CURRENT Gateway connection (reset on connect) — the order gate (F3). */
  private connTickAt = 0;
  private lastTickPrice: number | null = null;
  private lastBarAt = 0;
  private stats = { ticks: 0, bars: 0, barCorrections: 0, backfillsServed: 0, backfillBars: 0, backfillsDeclined: 0, histTimeouts: 0, ordersPlaced: 0, legReplacements: 0 };
  private listenersWired = false;
  private state: BridgeState = { eras: {} };

  constructor(cfg: IbkrConfig, deps: BridgeDeps) {
    this.cfg = cfg;
    this.d = deps;
    this.histDuration = `${cfg.backfillDays} D`;
    try {
      const s = this.d.loadState();
      const eras: Record<string, number> = {};
      for (const [k, v] of Object.entries(s?.eras ?? {})) if (typeof v === "number" && Number.isFinite(v) && v > 0) eras[k] = v;
      this.state = { eras };
    } catch { this.state = { eras: {} }; }
    const self = this;
    this.link = {
      readyState: 3,
      send(data: string) { try { self.onStudyRequest(JSON.parse(data)); } catch { /* ignore */ } },
    };
    for (const b of this.d.loadBrackets()) {
      if (b.closed || this.d.now() / 1000 - b.createdAt > STALE_BRACKET_SEC) continue;
      this.track(b);
    }
    if (this.brackets.length) this.d.log("info", `restored ${this.brackets.length} open bracket(s) from disk — will reconcile with reqOpenOrders/reqExecutions on connect`);
  }

  // ── lifecycle ──
  start(): void {
    this.stopped = false;
    this.wire();
    this.d.registerExecutor({ name: "ibkr-bridge", isReady: () => this.isReady(), execute: (cmd) => this.execute(cmd) });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.reconnectTimer, this.heartbeatTimer, this.flushTimer, this.rollTimer, this.backfillTimer]) if (t) this.d.cancel(t);
    this.reconnectTimer = this.heartbeatTimer = this.flushTimer = this.rollTimer = this.backfillTimer = null;
    this.clearHistReqs();
    this.d.registerExecutor(null);
    this.detachStudy();
    try { this.d.api.disconnect(); } catch { /* ignore */ }
    this.connected = false;
  }

  isReady(): boolean { return !this.stopped && this.connected && !!this.choice && this.nextOrderId > 0; }

  private connect(): void {
    if (this.stopped) return;
    this.reconnectTimer = null;
    this.connectAttempts++;
    this.d.log("info", `connecting to IB Gateway ${this.cfg.host}:${this.cfg.port} clientId=${this.cfg.clientId} (attempt ${this.connectAttempts})`);
    try { this.d.api.connect(this.cfg.clientId); }
    catch (e: any) { this.lastError = `connect threw: ${e?.message ?? e}`; this.scheduleReconnect(); }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const ms = this.backoffMs;
    this.backoffMs = Math.min(RECONNECT_MAX_MS, Math.round(this.backoffMs * 2));
    this.d.log("warn", `reconnect in ${Math.round(ms / 1000)} s`);
    this.reconnectTimer = this.d.schedule(() => this.connect(), ms);
  }

  private wire(): void {
    if (this.listenersWired) return;
    this.listenersWired = true;
    const api = this.d.api;
    api.on(EventName.connected, () => this.onConnected());
    api.on(EventName.disconnected, () => this.onDisconnected("disconnected"));
    api.on(EventName.connectionClosed, () => this.onDisconnected("connectionClosed"));
    api.on(EventName.error, (err: Error | number, code: number, reqId?: number) => this.onError(err, code, reqId));
    // G3/F3 wiring (2026-09-23 verifier refutation): @stoqey/ib's decoder routes EVERY ERR_MSG
    // whose id is -1 to EventName.info (message, code) — never EventName.error. IB sends the
    // system messages 1100/1101/1102/2110 and the farm statuses 2103–2108/2157/2158 with id -1,
    // so without this listener the connectivity state machine (1100 order refusal + push, 1101
    // resubscribe, 2110 loss, farm "is OK" recovery) never ran against a real TWS/Gateway.
    api.on(EventName.info, (message: string, code: number) => this.onInfo(message, code));
    api.on(EventName.nextValidId, (id: number) => { if (id > this.nextOrderId) this.nextOrderId = id; });
    api.on(EventName.managedAccounts, (list: string) => { const first = String(list ?? "").split(",").map(s => s.trim()).filter(Boolean)[0]; this.account = this.cfg.account ?? first ?? null; });
    api.on(EventName.currentTime, () => { this.lastHeartbeatAt = this.d.now(); });
    api.on(EventName.contractDetails, (reqId: number, details: ContractDetails) => { if (reqId === this.contractReqId) this.contractRows.push(details as ContractDetailsLike); });
    api.on(EventName.contractDetailsEnd, (reqId: number) => { if (reqId === this.contractReqId) this.onContractDetailsEnd(); });
    api.on(EventName.tickByTickAllLast, (reqId: number, _tickType: number, time: string | number, price: number) => this.onTick(reqId, time, price));
    api.on(EventName.historicalData, (reqId: number, time: string, open: number, high: number, low: number, close: number, volume: number) => this.onHistoricalData(reqId, time, open, high, low, close, volume));
    api.on(EventName.historicalDataUpdate, (reqId: number, time: string, open: number, high: number, low: number, close: number, volume: number) => this.onHistoricalUpdate(reqId, time, open, high, low, close, volume));
    api.on(EventName.openOrder, (orderId: number, _c: Contract, _o: Order, state: OrderState) => this.onOrderStatus(orderId, String(state?.status ?? ""), undefined, undefined, undefined));
    api.on(EventName.orderStatus, (orderId: number, status: string, filled: number, remaining: number, avgFillPrice: number) => this.onOrderStatus(orderId, status, filled, remaining, avgFillPrice));
    api.on(EventName.execDetails, (_reqId: number, _c: Contract, ex: Execution) => this.onExecution(ex));
  }

  private onConnected(): void {
    this.connected = true;
    this.connectedAt = this.d.now();
    this.lastHeartbeatAt = this.connectedAt;
    this.connectivity = "ok";
    this.connectivityLostBy = null;
    // A fresh session re-verifies the data entitlement: the first tick sets "realtime" again, a
    // repeat 10167 sets "delayed" again (and notifies once more — one push per Gateway session).
    this.marketData = "unknown";
    this.delayedNotified = false;
    this.connTickAt = 0; // orders wait for this connection's first tick (F3)
    if (this.connectAttempts > 1) this.reconnects++;
    this.backoffMs = RECONNECT_MIN_MS;
    this.lastError = null;
    this.d.log("info", `connected to IB Gateway (reconnects so far: ${this.reconnects})`);
    try {
      this.d.api.reqIds(1);
      this.d.api.reqManagedAccts();
      // Reconcile what the broker holds for this client id — idempotent: statuses we already
      // acted on are skipped by the per-bracket flags, fills we missed arrive via execDetails.
      this.d.api.reqOpenOrders();
      this.d.api.reqExecutions(EXEC_REQ_ID, { clientId: String(this.cfg.clientId) });
    } catch (e: any) { this.lastError = `post-connect requests failed: ${e?.message ?? e}`; }
    this.startHeartbeat();
    this.resolveContract();
    this.startRollCheck();
  }

  private onDisconnected(why: string): void {
    const was = this.connected;
    this.connected = false;
    this.subs = { ticks: false, bars: false };
    this.stream.reset();
    this.clearHistReqs();
    this.backfillQueue = [];
    this.backfillInflight = null;
    this.link.readyState = 3;
    this.detachStudy();
    for (const t of [this.heartbeatTimer, this.flushTimer, this.backfillTimer]) if (t) this.d.cancel(t);
    this.heartbeatTimer = this.flushTimer = this.backfillTimer = null;
    if (was) this.d.log("warn", `IB Gateway connection lost (${why})`);
    this.scheduleReconnect();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) this.d.cancel(this.heartbeatTimer);
    const period = this.cfg.heartbeatSec * 1000;
    const beat = () => {
      this.heartbeatTimer = null;
      if (this.stopped || !this.connected) return;
      const age = this.d.now() - Math.max(this.lastHeartbeatAt, this.connectedAt);
      if (age > period * HEARTBEAT_DEAD_FACTOR) {
        this.lastError = `heartbeat: no currentTime reply for ${Math.round(age / 1000)} s — forcing reconnect`;
        this.d.log("error", this.lastError);
        try { this.d.api.disconnect(); } catch { /* ignore */ }
        // If the socket never reports the close, drive the state machine ourselves.
        this.d.schedule(() => { if (this.connected) this.onDisconnected("heartbeat"); }, 5_000);
        return;
      }
      try { this.d.api.reqCurrentTime(); } catch { /* ignore */ }
      this.heartbeatTimer = this.d.schedule(beat, period);
    };
    this.heartbeatTimer = this.d.schedule(beat, period);
  }

  // ── contract ──
  private resolveContract(): void {
    if (!this.connected) return;
    this.contractReqId = CONTRACT_REQ_BASE + (this.contractReqId ? (this.contractReqId - CONTRACT_REQ_BASE + 1) % CONTRACT_REQ_SPAN : 0);
    this.contractRows = [];
    const c: Contract = { symbol: this.cfg.symbolRoot, secType: SecType.FUT, exchange: this.cfg.exchange, currency: this.cfg.currency, includeExpired: false };
    try { this.d.api.reqContractDetails(this.contractReqId, c); }
    catch (e: any) { this.lastError = `reqContractDetails failed: ${e?.message ?? e}`; }
  }

  private onContractDetailsEnd(): void {
    const choice = selectFrontMonth(this.contractRows, this.d.now(), this.cfg.rollDaysBeforeExpiry, this.cfg.symbolRoot, this.cfg.contractOverride);
    if (!choice) {
      this.lastError = this.cfg.contractOverride
        ? `IB_CONTRACT=${this.cfg.contractOverride} not found among ${this.contractRows.length} listed ${this.cfg.symbolRoot} contracts — nothing subscribed`
        : `no ${this.cfg.symbolRoot} contract details returned — nothing subscribed`;
      this.d.log("error", this.lastError);
      return;
    }
    const prev = this.choice;
    const changed = !prev || prev.details.contract.conId !== choice.details.contract.conId;
    this.choice = choice;
    if (!changed) { if (!this.subs.ticks || !this.subs.bars) this.subscribe(); return; }
    if (prev) {
      const msg = `contract ROLL: ${prev.rawSymbol} → ${choice.rawSymbol} (lastTrade ${new Date(choice.lastTradeSec * 1000).toISOString().slice(0, 10)}, roll rule ${this.cfg.rollDaysBeforeExpiry} d)`;
      this.d.log("warn", msg);
      // ERA (F1): from this instant the bridge serves the new month — never anything older.
      this.state.eras[choice.rawSymbol] = Math.floor(this.d.now() / 1000);
      this.saveState();
      this.d.notify({ type: "ibkr_bridge", title: "🔄 IBKR contract roll", body: `${msg}. The contract guard compares against Yahoo's front month — a few days of quarantine around the roll is expected until Yahoo rolls too.` });
      this.abortBackfillsForRoll(prev.rawSymbol, choice.rawSymbol);
      this.unsubscribe();
    } else {
      this.d.log("info", `front month: ${choice.rawSymbol} conId=${choice.details.contract.conId} lastTrade=${new Date(choice.lastTradeSec * 1000).toISOString().slice(0, 10)} roll=${new Date(choice.rollAtSec * 1000).toISOString().slice(0, 10)} (${choice.reason})`);
    }
    this.subscribe();
  }

  /** G5 (2026-09-23): a backfill job queued or in flight at a roll holds (or would fetch) bars of
   *  the OLD month, and finishBackfill would emit them under the NEW rawSymbol with a
   *  non-declined count — the 2026-09-17 interleave class. Every pending job is dropped: the
   *  in-flight IB request is cancelled, its partial bars are discarded (never emitted), and each
   *  job is answered backfill_done {declined:true, reason:'roll', count:0} on the next tick, so
   *  gap-audit skips it for now and re-asks later under the new contract's era rules. */
  private abortBackfillsForRoll(from: string, to: string): void {
    const jobs: BackfillJob[] = [];
    const add = (j: BackfillJob | null | undefined) => { if (j && !jobs.includes(j)) jobs.push(j); };
    add(this.backfillInflight);
    for (const j of this.backfillQueue) add(j);
    for (const [reqId, r] of [...this.histReqs.entries()]) {
      if (r.kind !== "backfill") continue;
      add(r.job);
      this.dropHistReq(reqId);
      try { this.d.api.cancelHistoricalData(reqId); } catch { /* ignore */ }
    }
    if (this.backfillTimer) { this.d.cancel(this.backfillTimer); this.backfillTimer = null; }
    this.backfillQueue = [];
    this.backfillInflight = null;
    if (!jobs.length) return;
    this.stats.backfillsDeclined += jobs.length;
    this.d.log("warn", `contract roll ${from} → ${to}: ${jobs.length} pending backfill job(s) dropped (partial ${from} bars discarded) and answered declined:'roll' — gap-audit re-asks under the new era`);
    const ids = jobs.map(j => j.id);
    this.d.schedule(() => { for (const id of ids) this.d.ingest({ type: "backfill_done", id, count: 0, earliestAvailableMs: 0, declined: true, reason: "roll", source: "ibkr" }); }, 0);
  }

  private startRollCheck(): void {
    if (this.rollTimer) this.d.cancel(this.rollTimer);
    const period = this.cfg.rollCheckHours * 3600_000;
    const tick = () => { this.rollTimer = null; if (this.stopped || !this.connected) return; this.resolveContract(); this.rollTimer = this.d.schedule(tick, period); };
    this.rollTimer = this.d.schedule(tick, period);
  }

  private contract(): Contract | null {
    const c = this.choice?.details.contract;
    if (!c) return null;
    // IB 10372 (first LIVE connection, 2026-09-23): newer TWS builds return
    // lastTradeDateOrContractMonth in contractDetails as "20261218 08:30:00 US/Central"; echoing
    // that into a request makes TWS refuse it ("correct format is yyyyMM or yyyyMMdd") — no
    // ticks, no bars. Requests carry only the yyyymmdd / yyyymm prefix (conId identifies the
    // contract anyway; the field is dropped when it has no usable prefix).
    const ltd = requestDateField(c.lastTradeDateOrContractMonth);
    return { conId: c.conId, symbol: c.symbol ?? this.cfg.symbolRoot, secType: SecType.FUT, exchange: c.exchange ?? this.cfg.exchange, currency: c.currency ?? this.cfg.currency, localSymbol: c.localSymbol, ...(ltd ? { lastTradeDateOrContractMonth: ltd } : {}) };
  }

  /** ERA FLOOR (post-build review F1): the oldest instant the CURRENT contract may supply bars
   *  for — anything older belongs to another month in this DB (a Dec-priced answer for a
   *  Sep-era hole recreates the 2026-09-17 interleave, and roll-heal would then shift the whole
   *  older history). The LATER of the seeded boundary (seedEraStartSec — the store's own roll,
   *  +1 day margin) and the instant the bridge itself switched to this contract (persisted in
   *  ibkr-state.json): the seed alone would serve a late bridge roll's pre-switch hours, the
   *  persisted instant alone would serve the hours between the bridge's roll and Yahoo's, when
   *  the contract guard keeps Yahoo's OLD-month rows the writer. null = no contract resolved. */
  eraStartSec(): number | null {
    const c = this.choice;
    if (!c) return null;
    const seeded = seedEraStartSec(c, this.cfg.rollDaysBeforeExpiry);
    const persisted = this.state.eras[c.rawSymbol];
    return typeof persisted === "number" && persisted > seeded ? persisted : seeded;
  }

  private saveState(): void {
    // Keep the newest eight eras (two years of quarterlies) — the file never grows unbounded.
    const entries = Object.entries(this.state.eras).sort((a, b) => b[1] - a[1]).slice(0, 8);
    this.state = { eras: Object.fromEntries(entries) };
    try { this.d.saveState({ eras: { ...this.state.eras } }); } catch (e: any) { this.d.log("warn", `state persist failed: ${e?.message ?? e}`); }
  }

  // ── historical request bookkeeping (F5: every request has a no-answer timeout) ──
  private setHistReq(reqId: number, req: HistReq): void {
    const old = this.histReqs.get(reqId);
    if (old?.timer) this.d.cancel(old.timer);
    if (old && old !== req) old.timer = undefined;
    this.armHistTimer(reqId, req);
    this.histReqs.set(reqId, req);
  }
  /** (Re-)arm the no-answer timer. G4 (2026-09-23): called on EVERY historicalData row too, so
   *  the timeout measures SILENCE, not total duration — a 5-day opening batch (~7000 rows) that
   *  keeps streaming past 60 s is never cancelled and re-requested from scratch. */
  private armHistTimer(reqId: number, req: HistReq): void {
    if (req.timer) this.d.cancel(req.timer);
    req.timer = this.d.schedule(() => this.onHistTimeout(reqId, req), HIST_TIMEOUT_MS);
  }
  private dropHistReq(reqId: number): HistReq | undefined {
    const req = this.histReqs.get(reqId);
    if (!req) return undefined;
    if (req.timer) this.d.cancel(req.timer);
    req.timer = undefined;
    this.histReqs.delete(reqId);
    return req;
  }
  private clearHistReqs(): void {
    for (const r of this.histReqs.values()) if (r.timer) this.d.cancel(r.timer);
    this.histReqs.clear();
  }
  private onHistTimeout(reqId: number, req: HistReq): void {
    if (this.histReqs.get(reqId) !== req) return; // answered / replaced meanwhile
    req.timer = undefined;
    this.histReqs.delete(reqId);
    this.stats.histTimeouts++;
    try { this.d.api.cancelHistoricalData(reqId); } catch { /* ignore */ }
    if (req.kind === "live") {
      this.subs.bars = false;
      this.lastError = `1m bar stream: no answer from IB in ${HIST_TIMEOUT_MS / 1000} s — cancelled and re-requested`;
      this.d.log("warn", this.lastError);
      const c = this.contract();
      if (!c || !this.connected || this.stopped) return;
      const wait = this.pacer.waitMs(`live:${c.conId}:${this.histDuration}`, this.d.now());
      if (wait > 0) this.d.schedule(() => { if (this.connected && !this.stopped && !this.subs.bars) this.requestLiveBars(); }, wait);
      else this.requestLiveBars();
      return;
    }
    const job = req.job!, chunk = req.chunk!;
    this.backfillInflight = null;
    // G6: a chunk that IB never finished (partial rows, or silence twice) makes the WHOLE job
    // incomplete — a partial count>0 answer would let gap-audit's reconcile delete the real rows
    // of the missing span. The job is declined instead (its bars discarded) and Yahoo heals.
    if (req.bars.length) {
      this.abandonBackfill(job, `chunk ${ibDateTime(chunk.fromSec)}..${ibDateTime(chunk.toSec)} timed out after ${req.bars.length} bars`);
      return;
    }
    if (!chunk.retried) {
      chunk.retried = true;
      job.chunks.unshift(chunk);
      this.d.log("warn", `backfill ${job.id}: chunk ${ibDateTime(chunk.fromSec)}..${ibDateTime(chunk.toSec)} got no answer in ${HIST_TIMEOUT_MS / 1000} s — retrying once`);
      this.pumpBackfill();
      return;
    }
    this.abandonBackfill(job, `chunk ${ibDateTime(chunk.fromSec)}..${ibDateTime(chunk.toSec)} got no answer twice`);
  }

  /** G6: mark a job incomplete, stop requesting its remaining chunks and answer it DECLINED. */
  private abandonBackfill(job: BackfillJob, why: string): void {
    job.incomplete = why;
    job.chunks = [];
    this.backfillInflight = null;
    this.d.log("warn", `backfill ${job.id}: ${why} — job declined as incomplete (no partial answer; gap-audit/Yahoo re-heal)`);
    this.finishBackfill(job);
  }

  // ── subscriptions ──
  private subscribe(): void {
    const c = this.contract();
    if (!c || !this.connected) return;
    if (!this.studyHandle) this.studyHandle = this.d.attachStudy(this.link, () => { /* bulk_report acks — nothing to do */ });
    if (!this.subs.ticks) {
      try { this.d.api.reqTickByTickData(TICK_REQ_ID, c, TickByTickDataType.AllLast, 0, false); this.subs.ticks = true; }
      catch (e: any) { this.lastError = `reqTickByTickData failed: ${e?.message ?? e}`; }
    }
    if (!this.subs.bars) this.requestLiveBars();
  }

  private requestLiveBars(): void {
    const c = this.contract();
    if (!c) return;
    this.stream.reset();
    this.setHistReq(BARS_REQ_ID, { kind: "live", bars: [] });
    try {
      // endDateTime must be empty with keepUpToDate; formatDate 2 = epoch seconds; useRTH 0 = full Globex session.
      this.d.api.reqHistoricalData(BARS_REQ_ID, c, "", this.histDuration, BarSizeSetting.MINUTES_ONE, WhatToShow.TRADES, 0, 2, true);
      this.subs.bars = true;
      this.pacer.note(`live:${c.conId}:${this.histDuration}`, this.d.now());
    } catch (e: any) { this.dropHistReq(BARS_REQ_ID); this.lastError = `reqHistoricalData failed: ${e?.message ?? e}`; }
  }

  private unsubscribe(): void {
    if (this.subs.ticks) { try { this.d.api.cancelTickByTickData(TICK_REQ_ID); } catch { /* ignore */ } }
    if (this.subs.bars) { try { this.d.api.cancelHistoricalData(BARS_REQ_ID); } catch { /* ignore */ } }
    this.subs = { ticks: false, bars: false };
    this.dropHistReq(BARS_REQ_ID);
    this.stream.reset();
    this.link.readyState = 3;
  }

  private detachStudy(): void {
    if (this.studyHandle) { try { this.d.detachStudy(this.studyHandle); } catch { /* ignore */ } this.studyHandle = null; }
  }

  // ── data in ──
  private onTick(reqId: number, time: string | number, price: number): void {
    if (reqId !== TICK_REQ_ID || !this.choice) return;
    if (!Number.isFinite(price) || price <= 0) return;
    const sec = parseIbDate(time);
    const at = sec != null && sec > 1_000_000_000 ? sec * 1000 : this.d.now();
    this.lastTickAt = this.d.now();
    this.connTickAt = this.lastTickAt;
    this.lastTickPrice = price;
    this.stats.ticks++;
    if (this.marketData === "unknown") this.marketData = "realtime";
    this.d.ingest({ type: "tick", symbol: this.choice.rawSymbol, price, time: at });
  }

  private onHistoricalData(reqId: number, time: string, open: number, high: number, low: number, close: number, volume: number): void {
    const req = this.histReqs.get(reqId);
    if (!req) return;
    if (typeof time === "string" && time.startsWith("finished")) {
      this.dropHistReq(reqId);
      if (req.kind === "live") this.onInitialBatch(req.bars);
      else this.onBackfillChunkDone(req, req.bars);
      return;
    }
    this.armHistTimer(reqId, req); // G4: IB is still answering — only true silence times out
    const t = parseIbDate(time);
    if (t == null || !(open > 0) || !(close > 0)) return;
    req.bars.push({ time: t, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }

  /** The keepUpToDate request's opening batch: the LiveBarRelay-style history dump (bulk_bars,
   *  oldest first, 500 per message, forming bucket excluded) + the hello handshake. */
  private onInitialBatch(bars: Bar1m[]): void {
    if (!this.choice) return;
    const nowSec = Math.floor(this.d.now() / 1000);
    // ERA FLOOR (F1): the 2-day dump right after a roll reaches back into the previous month's
    // era — those minutes belong to the other contract in this DB and are never sent.
    const era = this.eraStartSec() ?? 0;
    const sorted = bars.filter(b => b.time >= era).sort((a, b) => a.time - b.time);
    const closed = sorted.filter(b => b.time + 60 <= nowSec);
    const forming = sorted.find(b => b.time + 60 > nowSec) ?? null;
    if (closed.length && closed[closed.length - 1].time > this.stream.lastEmitted) {
      this.stream.lastEmitted = closed[closed.length - 1].time;
      this.stream.lastEmittedBar = closed[closed.length - 1];
      this.stream.emittedAtSec = nowSec;
    }
    this.stream.forming = forming;
    const raw = this.choice.rawSymbol;
    for (let i = 0; i < closed.length; i += BULK_CHUNK) {
      const chunk = closed.slice(i, i + BULK_CHUNK);
      this.d.ingest({ type: "bulk_bars", symbol: raw, resolution: "1", bars: chunk.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })) });
    }
    const seriesStartMs = (sorted[0]?.time ?? nowSec) * 1000;
    const seriesEndMs = (sorted[sorted.length - 1]?.time ?? nowSec) * 1000;
    this.link.readyState = 1; // OPEN — gap-audit may now dispatch backfill requests to us
    this.d.ingest({ type: "hello", symbol: raw, resolution: "1", ver: 2, seriesStartMs, seriesEndMs, source: "ibkr" });
    this.d.log("info", `1m stream live: ${closed.length} history bars delivered as bulk_bars, hello sent for ${raw}:1`);
    this.startFlushTimer();
  }

  private onHistoricalUpdate(reqId: number, time: string, open: number, high: number, low: number, close: number, volume: number): void {
    if (reqId !== BARS_REQ_ID || !this.choice) return;
    const t = parseIbDate(time);
    if (t == null || !(open > 0) || !(close > 0)) return;
    const before = this.stream.corrections;
    const out = this.stream.onUpdate({ time: t, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 }, Math.floor(this.d.now() / 1000));
    const correction = this.stream.corrections > before; // a late same-minute update re-emitted (F7)
    if (correction) this.stats.barCorrections++;
    for (const done of out) this.emitBar(done, correction);
  }

  private emitBar(b: Bar1m, correction = false): void {
    if (!this.choice) return;
    this.lastBarAt = this.d.now();
    if (!correction) this.stats.bars++;
    this.d.ingest({ type: "bar", symbol: this.choice.rawSymbol, resolution: "1", time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, complete: true });
  }

  private startFlushTimer(): void {
    if (this.flushTimer) this.d.cancel(this.flushTimer);
    const tick = () => {
      this.flushTimer = null;
      if (this.stopped || !this.connected || !this.subs.bars) return;
      for (const done of this.stream.flush(Math.floor(this.d.now() / 1000), this.cfg.barCloseGraceSec)) this.emitBar(done);
      this.flushTimer = this.d.schedule(tick, 1_000);
    };
    this.flushTimer = this.d.schedule(tick, 1_000);
  }

  /** Test/diagnostic hook: run the forming-bar flush now. */
  flushBars(): void { for (const done of this.stream.flush(Math.floor(this.d.now() / 1000), this.cfg.barCloseGraceSec)) this.emitBar(done); }

  // ── gap-audit backfill requests (the LiveBarRelay `backfill` protocol) ──
  private onStudyRequest(req: { type?: string; id?: string; fromMs?: number; toMs?: number }): void {
    if (req?.type !== "backfill" || !req.id) return;
    const fromSec = Math.floor(Number(req.fromMs) / 1000), toSec = Math.floor(Number(req.toMs) / 1000);
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) return;
    const nowSec = Math.floor(this.d.now() / 1000);
    // Only the CURRENT contract's era is ours to heal (eraStartSec — F1): anything older belongs
    // to another month in this DB (a Dec-priced answer for a Sep-era range would recreate the
    // 2026-09-17 interleave). Also bounded by IB_BACKFILL_MAX_DAYS and the serve switch.
    const era = this.eraStartSec();
    const maxDaysFloor = nowSec - this.cfg.backfillMaxDays * 86400;
    const floor = Math.max(maxDaysFloor, era ?? 0);
    const reason = !this.cfg.serveBackfill || era == null ? "disabled" : toSec <= floor ? (era >= maxDaysFloor ? "era" : "max_days") : null;
    if (reason) {
      // A POLICY decline, not "IB has no data" (F2): `declined:true` tells gap-audit to skip its
      // no_data accounting (two quick answers used to mark the range unfillable forever and keep
      // the Yahoo healer away) and to hand the range to gap-heal's Yahoo path instead.
      // Answered on the next tick: gap-audit calls link.send() from inside its dispatcher, and a
      // synchronous backfill_done would re-enter dispatchNext recursively for every old range.
      const id = req.id;
      this.stats.backfillsDeclined++;
      this.d.schedule(() => this.d.ingest({ type: "backfill_done", id, count: 0, earliestAvailableMs: 0, declined: true, reason, source: "ibkr" }), 0);
      return;
    }
    const f = Math.max(fromSec, floor);
    const chunks: BackfillChunk[] = [];
    for (let s = f; s < toSec; s += 86400) chunks.push({ fromSec: s, toSec: Math.min(toSec, s + 86400) });
    this.backfillQueue.push({ id: req.id, fromSec: f, toSec, chunks, bars: [], started: false });
    this.pumpBackfill();
  }

  private pumpBackfill(): void {
    if (this.backfillTimer) return;
    if (!this.connected || !this.choice) return;
    if (this.backfillInflight) return;
    const job = this.backfillQueue[0];
    if (!job) return;
    const chunk = job.chunks.shift();
    if (!chunk) { this.finishBackfill(job); return; }
    const c = this.contract()!;
    const dur = `${Math.max(60, chunk.toSec - chunk.fromSec)} S`;
    const key = `bf:${c.conId}:${chunk.toSec}:${dur}`;
    const wait = this.pacer.waitMs(key, this.d.now());
    if (wait > 0) { job.chunks.unshift(chunk); this.backfillTimer = this.d.schedule(() => { this.backfillTimer = null; this.pumpBackfill(); }, wait); return; }
    const reqId = this.backfillReqId++;
    if (this.backfillReqId >= BACKFILL_REQ_BASE + BACKFILL_REQ_SPAN) this.backfillReqId = BACKFILL_REQ_BASE;
    this.setHistReq(reqId, { kind: "backfill", job, chunk, bars: [] });
    this.backfillInflight = job;
    try {
      this.d.api.reqHistoricalData(reqId, c, ibDateTime(chunk.toSec), dur, BarSizeSetting.MINUTES_ONE, WhatToShow.TRADES, 0, 2, false);
      this.pacer.note(key, this.d.now());
    } catch (e: any) {
      this.lastError = `backfill reqHistoricalData failed: ${e?.message ?? e}`;
      this.dropHistReq(reqId);
      this.backfillInflight = null;
      this.finishBackfill(job);
    }
  }

  private onBackfillChunkDone(req: HistReq, bars: Bar1m[]): void {
    const job = req.job!, chunk = req.chunk!;
    // Belt and braces (F1): the era can move while a job is queued (a roll mid-job re-points
    // this.contract() at the new month) — nothing older than the CURRENT era is ever kept.
    const era = this.eraStartSec() ?? Number.POSITIVE_INFINITY;
    for (const b of bars) if (b.time >= chunk.fromSec && b.time <= chunk.toSec && b.time >= era) job.bars.push(b);
    this.backfillInflight = null;
    if (job.chunks.length === 0) this.finishBackfill(job);
    else this.pumpBackfill();
  }

  private finishBackfill(job: BackfillJob): void {
    this.backfillQueue = this.backfillQueue.filter(j => j !== job);
    this.backfillInflight = null;
    if (job.incomplete) {
      // G6: never a partial count>0 answer (see abandonBackfill). Declined answers carry no bars;
      // gap-audit skips the range for the study for 6 h and gap-heal offers it to Yahoo.
      this.stats.backfillsDeclined = (this.stats.backfillsDeclined ?? 0) + 1;
      this.d.ingest({ type: "backfill_done", id: job.id, count: 0, declined: true, reason: "incomplete", detail: job.incomplete, earliestAvailableMs: 0, source: "ibkr" });
      this.pumpBackfill();
      return;
    }
    if (!this.choice) return;
    const raw = this.choice.rawSymbol;
    const bars = [...job.bars].sort((a, b) => a.time - b.time);
    let seq = 0;
    for (let i = 0; i < bars.length; i += BULK_CHUNK) {
      const chunk = bars.slice(i, i + BULK_CHUNK);
      this.d.ingest({ type: "bulk_bars", id: job.id, symbol: raw, resolution: "1", seq: seq++, final: i + BULK_CHUNK >= bars.length, bars: chunk.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })) });
    }
    this.d.ingest({ type: "backfill_done", id: job.id, count: bars.length, earliestAvailableMs: 0, source: "ibkr" });
    this.stats.backfillsServed++;
    this.stats.backfillBars += bars.length;
    this.pumpBackfill();
  }

  // ── orders out ──
  execute(raw: Record<string, unknown>): boolean {
    if (raw?.type === "reset_flag") { this.d.emitEvent({ type: "flag_reset" }); return true; }
    if (raw?.type !== "order_command") return false;
    if (!this.isReady()) return false;
    const gate = this.d.orderGateReason?.();
    if (gate) { this.d.log("error", `order refused: ${gate}`); return false; }
    // DELAYED DATA (10167): the engine is then firing off ticks ~15 min behind the market — a MKT
    // bracket would fill at a price the signal never saw. Refuse (false → the engine logs/notifies
    // "not placed" and tracks nothing) until real-time data is confirmed after a reconnect.
    if (this.marketData === "delayed") { this.d.log("error", `order refused: IB market data is DELAYED (10167) — subscribe to CME Real-Time (NP, L1) (and share it with the paper account if you trade paper)`); return false; }
    // CONNECTIVITY / LIVE-QUOTE GATE (post-build review F3): isReady() only knows the local
    // socket. IB 1100 (Gateway ↔ IB lost) or a silent tick stream means the engine's price is
    // not the market's — a MKT bracket would fill blind. Refused like the delayed-data case
    // (false → the engine logs "not placed", tracks nothing); status stays honest via isReady().
    if (this.connectivity === "lost") { this.d.log("error", `order refused: IB reports connectivity LOST (${this.connectivityLostBy ?? "?"}) — waiting for ${this.connectivityLostBy === 2110 ? "a farm 'is OK' / 1101 / 1102" : "1101/1102"}`); return false; }
    const tickAge = this.connTickAt ? this.d.now() - this.connTickAt : Number.POSITIVE_INFINITY;
    if (tickAge > ORDER_MAX_TICK_AGE_MS) { this.d.log("error", `order refused: no IB tick ${this.connTickAt ? `for ${Math.round(tickAge / 1000)} s` : "yet on this Gateway connection"} (gate ${ORDER_MAX_TICK_AGE_MS / 1000} s) — the market price is unverified`); return false; }
    const parsed = parseOrderCommand(raw);
    // accepted-then-errored, as AutoTrader does — emitted on the NEXT tick (F8): the caller
    // records the trade after execute() returns true, so a synchronous error arrived before the
    // record existed and its order_error prune never matched it.
    if (!parsed.ok) { const error = parsed.error; this.d.schedule(() => this.d.emitEvent({ type: "order_error", error }), 0); return true; }
    const cmd = parsed.cmd;
    if (!cmd.tp1Only && cmd.tp2 != null && cmd.tp2 !== cmd.tp1) this.d.log("warn", `order_command carried tp2=${cmd.tp2} with tp1Only=false — TP2 leg NOT created (TP1-only policy); full quantity exits at tp1=${cmd.tp1}`);
    const c = this.contract()!;
    const firstId = this.nextOrderId;
    this.nextOrderId += 3;
    const orders = buildBracket(cmd, firstId, { account: this.cfg.account ?? this.account ?? undefined, stopType: this.cfg.stopType, stopSlipPts: this.cfg.stopSlipPts, orderRef: `MYB:${cmd.interval}:${cmd.direction}` });
    const b: Bracket = {
      key: `${cmd.symbol}|${cmd.interval}|${cmd.direction}|${firstId}`, createdAt: Math.floor(this.d.now() / 1000), cmd, rawSymbol: this.choice!.rawSymbol, conId: c.conId,
      parentId: orders.ids.parent, tpId: orders.ids.tp, slId: orders.ids.sl, ackSent: false, filledSent: false,
    };
    this.track(b);
    this.d.emitEvent({ type: "order_queued", direction: cmd.direction, entry: cmd.price, queued: this.openBrackets().length });
    // G1 (2026-09-23): remember which legs were already handed to the socket — a throw on the
    // TP or SL leg must never leave a sent parent MKT untracked (an unprotected position at IB).
    const sent: Array<"parent" | "tp"> = [];
    let failing: "parent" | "tp" | "sl" = "parent";
    try {
      this.d.api.placeOrder(orders.parent.orderId!, c, orders.parent);
      sent.push("parent"); failing = "tp";
      this.d.api.placeOrder(orders.tp.orderId!, c, orders.tp);
      sent.push("tp"); failing = "sl";
      this.d.api.placeOrder(orders.sl.orderId!, c, orders.sl);
    } catch (e: any) {
      const why = e?.message ?? e;
      if (sent.length === 0) {
        // Nothing reached the socket — nothing exists at IB.
        this.untrack(b);
        const error = `placeOrder threw: ${why}`;
        this.d.schedule(() => this.d.emitEvent({ type: "order_error", error }), 0); // after the caller's record exists (F8)
        return true;
      }
      // The parent (and maybe the TP) were already sent: cancel every sent leg and KEEP the
      // bracket tracked until IB confirms — parent Cancelled → closed 'rejected'; parent Filled
      // anyway → the F4 replacement-stop path protects the position.
      b.placeFailed = failing as "tp" | "sl";
      const cancelFailed: number[] = [];
      for (const leg of sent) {
        const id = leg === "parent" ? b.parentId : b.tpId;
        try { this.d.api.cancelOrder(id); } catch { cancelFailed.push(id); }
      }
      const ids = sent.map(l => (l === "parent" ? b.parentId : b.tpId)).join(" + ");
      const legName = failing === "tp" ? "take-profit" : "stop";
      const error = cancelFailed.length
        ? `placeOrder threw on the ${legName} leg (${why}) after entry ${b.parentId} was sent — cancelOrder FAILED for ${cancelFailed.join(" + ")}: a MKT entry may be working at IB WITHOUT A STOP. Check IB Gateway/TWS NOW and cancel/flatten by hand`
        : `placeOrder threw on the ${legName} leg (${why}) after entry ${b.parentId} was sent — cancel requested for ${ids}; bracket kept tracked until IB confirms (a fill before the cancel gets a replacement stop). Check IB Gateway/TWS`;
      this.lastError = error;
      this.d.log("error", `bracket ${b.parentId}: ${error}`);
      this.persist();
      this.d.schedule(() => this.d.emitEvent({ type: "order_error", error, orderId: b.parentId, source: "ibkr" }), 0); // after the caller's record exists (F8)
      try { this.d.api.reqIds(1); } catch { /* ignore */ }
      return true;
    }
    this.stats.ordersPlaced++;
    this.persist();
    this.d.log("info", `bracket placed: ${cmd.direction} ${cmd.contracts}x ${this.choice!.rawSymbol} MKT (ids ${orders.ids.parent}/${orders.ids.tp}/${orders.ids.sl}) tp ${orders.tp.lmtPrice} sl ${orders.sl.auxPrice} ${this.cfg.stopType} GTC`);
    try { this.d.api.reqIds(1); } catch { /* ignore */ }
    return true;
  }

  private track(b: Bracket): void {
    this.brackets.push(b);
    for (const id of [b.parentId, b.tpId, b.slId]) this.byOrderId.set(id, b);
  }
  private untrack(b: Bracket): void {
    this.brackets = this.brackets.filter(x => x !== b);
    for (const id of [b.parentId, b.tpId, b.slId]) this.byOrderId.delete(id);
    this.persist();
  }
  private closeBracket(b: Bracket, reason: string): void {
    b.closed = { reason, at: Math.floor(this.d.now() / 1000) };
    // Keep a short tail of closed brackets for /api/ibkr/status; drop the rest (and their id maps).
    const closed = this.brackets.filter(x => x.closed);
    for (const old of closed.slice(0, Math.max(0, closed.length - 20))) {
      this.brackets = this.brackets.filter(x => x !== old);
      for (const id of [old.parentId, old.tpId, old.slId]) this.byOrderId.delete(id);
    }
    this.persist();
  }
  openBrackets(): Bracket[] { return this.brackets.filter(b => !b.closed); }
  private persist(): void { try { this.d.saveBrackets(this.brackets.filter(b => !b.closed)); } catch (e: any) { this.d.log("warn", `bracket persist failed: ${e?.message ?? e}`); } }

  private onOrderStatus(orderId: number, status: string, filled?: number, remaining?: number, avgFillPrice?: number): void {
    const b = this.byOrderId.get(orderId);
    if (!b) return;
    const leg = orderId === b.parentId ? "parent" : orderId === b.tpId ? "tp" : "sl";
    if (leg === "parent") b.parentStatus = status; else if (leg === "tp") b.tpStatus = status; else b.slStatus = status;
    const isFilled = status === OrderStatus.Filled || (remaining === 0 && (filled ?? 0) > 0);
    const isCancelled = status === OrderStatus.Cancelled || status === OrderStatus.ApiCancelled;
    if (leg === "parent") {
      if ((status === OrderStatus.PreSubmitted || status === OrderStatus.Submitted || isFilled) && !b.ackSent) {
        b.ackSent = true;
        this.d.emitEvent({ type: "order_ack", direction: b.cmd.direction, entry: b.cmd.price, tp1: b.cmd.tp1, tp2: b.cmd.tp1, sl: b.cmd.sl, qty: b.cmd.contracts, useTrailer: false, orderId, source: "ibkr" });
      }
      if (isFilled && !b.filledSent) {
        b.filledSent = true;
        b.fillPrice = avgFillPrice;
        this.d.emitEvent({ type: "order_filled", direction: b.cmd.direction, entry: b.cmd.price, fillPrice: avgFillPrice, qty: b.cmd.contracts, orderId, source: "ibkr" });
        // RACE (F4): a child leg was rejected and the bracket cancelled, but the MKT entry had
        // already filled — the position is OPEN with its exits cancelled. Re-open the bracket and
        // put a protective stop on it (the take-profit is not safety-critical).
        if (b.closed && b.legRejected) {
          b.closed = undefined;
          this.placeReplacementLeg(b, "sl", `entry ${orderId} FILLED after the bracket was cancelled for a rejected ${b.legRejected.toUpperCase()} leg`);
        } else if (b.placeFailed && !b.closed) {
          // G1: the cancel lost the race — the position is OPEN and its stop was never sent
          // (or was cancelled with the TP). Protect it now.
          this.placeReplacementLeg(b, "sl", `entry ${orderId} FILLED although it was cancelled after placeOrder threw on the ${b.placeFailed === "tp" ? "take-profit" : "stop"} leg`);
        }
      }
      if (isCancelled && !b.filledSent && !b.closed && b.placeFailed) {
        // G1: IB confirmed the cancel of a half-sent bracket — nothing is working any more.
        // (order_error was already emitted at the throw; no orders_cancelled — that event clears
        // EVERY active trade record downstream.)
        this.closeBracket(b, "rejected");
        this.d.log("warn", `bracket ${b.parentId}: entry cancel confirmed by IB after the placeOrder throw — nothing working`);
      } else if (isCancelled && !b.filledSent && !b.closed) {
        this.closeBracket(b, "cancelled");
        this.d.emitEvent({ type: "orders_cancelled", msg: `entry order ${orderId} cancelled at IB before fill (${b.cmd.direction} @ ${b.cmd.price})`, orderId, source: "ibkr" });
      }
    } else {
      if (isFilled && !b.closed) {
        b.exitPrice = avgFillPrice;
        this.closeBracket(b, leg === "tp" ? "tp_filled" : "sl_filled");
        this.d.emitEvent({ type: "bracket_flattened", reason: leg === "tp" ? "tp_filled" : "sl_filled", entry: b.cmd.price, exitPrice: avgFillPrice, remaining_brackets: this.openBrackets().length, orderId, source: "ibkr" });
        // IB's bracket OCA cancels the sibling itself; make sure it did (a naked stop that outlives
        // its take-profit is the 2026-08-03 lesson).
        const sibling = leg === "tp" ? b.slId : b.tpId;
        this.d.schedule(() => this.ensureCancelled(b, sibling), 2_000);
      } else if (isCancelled && !b.closed && b.filledSent && leg === "sl" && !b.unprotectedWarned) {
        b.unprotectedWarned = true;
        this.d.emitEvent({ type: "order_error", error: `stop-loss order ${orderId} was CANCELLED at IB while the position is open — position may be UNPROTECTED, check IB Gateway/TWS`, orderId, source: "ibkr" });
      }
    }
    this.persist();
  }

  private ensureCancelled(b: Bracket, orderId: number): void {
    const st = orderId === b.tpId ? b.tpStatus : b.slStatus;
    if (st === OrderStatus.Cancelled || st === OrderStatus.ApiCancelled || st === OrderStatus.Filled || st === OrderStatus.PendingCancel) return;
    try { this.d.api.cancelOrder(orderId); this.d.log("info", `cancelled surviving bracket leg ${orderId}`); } catch { /* ignore */ }
  }

  /** The contract a bracket was PLACED on — after a roll this.contract() is the new month, but
   *  a replacement leg must work the position's own contract. */
  private bracketContract(b: Bracket): Contract | null {
    const cur = this.contract();
    if (cur && (b.conId == null || cur.conId === b.conId)) return cur;
    if (b.conId == null) return null;
    return { conId: b.conId, symbol: this.cfg.symbolRoot, secType: SecType.FUT, exchange: this.cfg.exchange, currency: this.cfg.currency };
  }

  /** CHILD-LEG REJECTION with the position OPEN (post-build review F4): a standalone exit for
   *  the full quantity under a fresh order id — STP at the original sl, or LMT at tp1 — GTC,
   *  outsideRth, no parentId (the parent already filled), transmitted at once. The bracket's
   *  leg id is remapped so fills/cancels keep flowing through the normal child path (a fill of
   *  either exit still cancels the survivor 2 s later — the replacement has no OCA link). ONE
   *  replacement per leg: a replacement that is rejected too is only reported (never a loop). */
  private placeReplacementLeg(b: Bracket, leg: "tp" | "sl", why: string): void {
    const replaced = (b.replaced ??= {});
    if ((replaced[leg] ?? 0) >= 1) {
      this.lastError = `${why} — replacement ${leg.toUpperCase()} already tried once; position may be UNPROTECTED`;
      this.d.log("error", this.lastError);
      this.d.emitEvent({ type: "order_error", error: `IB bracket ${b.parentId}: ${why} — the replacement ${leg === "sl" ? "stop" : "take-profit"} was rejected too. Position may be UNPROTECTED — check IB Gateway/TWS and flatten or re-protect by hand`, orderId: leg === "sl" ? b.slId : b.tpId, source: "ibkr" });
      return;
    }
    replaced[leg] = (replaced[leg] ?? 0) + 1;
    const c = this.bracketContract(b);
    const isLong = b.cmd.direction === "Long";
    const qty = Math.max(1, Math.floor(b.cmd.contracts));
    const id = this.nextOrderId++;
    const acct = this.cfg.account ?? this.account ?? undefined;
    const order: Order = {
      orderId: id, action: isLong ? OrderAction.SELL : OrderAction.BUY, totalQuantity: qty, tif: TimeInForce.GTC, outsideRth: true, transmit: true,
      ...(acct ? { account: acct } : {}), orderRef: `MYB:${b.cmd.interval}:${b.cmd.direction}:R`,
      ...(leg === "sl" ? { orderType: OrderType.STP, auxPrice: roundTick(b.cmd.sl) } : { orderType: OrderType.LMT, lmtPrice: roundTick(b.cmd.tp1) }),
    };
    const oldId = leg === "sl" ? b.slId : b.tpId;
    try {
      if (!c) throw new Error("no contract for the bracket");
      this.d.api.placeOrder(id, c, order);
    } catch (e: any) {
      this.lastError = `${why} — replacement ${leg.toUpperCase()} placeOrder threw: ${e?.message ?? e}`;
      this.d.log("error", this.lastError);
      this.d.emitEvent({ type: "order_error", error: `IB bracket ${b.parentId}: ${why} and the replacement ${leg === "sl" ? "stop" : "take-profit"} could not be placed (${e?.message ?? e}) — position is UNPROTECTED, check IB Gateway/TWS NOW`, orderId: oldId, source: "ibkr" });
      this.persist();
      return;
    }
    this.byOrderId.delete(oldId);
    if (leg === "sl") { b.slId = id; b.slStatus = undefined; } else { b.tpId = id; b.tpStatus = undefined; }
    this.byOrderId.set(id, b);
    this.stats.legReplacements++;
    this.persist();
    const px = leg === "sl" ? `STP @ ${order.auxPrice}` : `LMT @ ${order.lmtPrice}`;
    this.d.log("error", `${why} — replacement ${leg.toUpperCase()} ${id} placed: ${px} ${qty}x GTC (was ${oldId})`);
    this.d.emitEvent({ type: "order_error", error: `IB bracket ${b.parentId}: ${why} — ${leg === "sl" ? "STOP" : "TAKE-PROFIT"} leg rejected, replacement placed (${px}, order ${id}). Check IB Gateway/TWS.`, orderId: id, source: "ibkr" });
    try { this.d.api.reqIds(1); } catch { /* ignore */ }
  }

  private onExecution(ex: Execution): void {
    const id = ex?.orderId;
    if (id == null) return;
    const b = this.byOrderId.get(id);
    if (!b) return;
    const cum = Number(ex.cumQty ?? ex.shares ?? 0);
    if (cum >= b.cmd.contracts) this.onOrderStatus(id, OrderStatus.Filled, cum, 0, Number(ex.avgPrice ?? ex.price ?? 0));
  }

  /** EventName.info = an IB ERR_MSG with id -1 (a system message, not tied to a request or an
   *  order). Same classification as EventName.error, with reqId -1. 501 "Cannot connect if
   *  already connected" is a library-local notice about our own connect() call — logged only. */
  private onInfo(message: string, code: number): void {
    if (code === 501) { this.d.log("info", `IB ${code}: ${message}`); return; }
    this.onError(String(message ?? ""), code, -1);
  }

  private onError(err: Error | number | string, code: number, reqId?: number): void {
    const msg = typeof err === "object" && err ? String((err as Error).message ?? err) : String(err);
    const kind = classifyIbError(code, msg);
    // Our own REQUEST ids resolve first (F6): IB shares one id space between requests and
    // orders, so a request id must never be mistaken for a tracked order's leg.
    const ownReq = reqId != null && reqId > 0 && (
      this.histReqs.has(reqId) || reqId === TICK_REQ_ID || reqId === BARS_REQ_ID || reqId === EXEC_REQ_ID
      || (reqId >= CONTRACT_REQ_BASE && reqId < CONTRACT_REQ_BASE + CONTRACT_REQ_SPAN)
      || (reqId >= BACKFILL_REQ_BASE && reqId < BACKFILL_REQ_BASE + BACKFILL_REQ_SPAN));
    const tracked = reqId != null && !ownReq ? this.byOrderId.get(reqId) : undefined;
    if (tracked) {
      // G1: 10147 "OrderId … that needs to be cancelled is not found" on a half-sent bracket's
      // entry = IB never held it — nothing is working, the bracket can close.
      if (code === 10147 && tracked.placeFailed && reqId === tracked.parentId && !tracked.filledSent && !tracked.closed) {
        this.d.log("warn", `bracket ${tracked.parentId}: IB 10147 on the entry cancel — IB never held it; closed`);
        this.closeBracket(tracked, "rejected");
        return;
      }
      if (kind === "order_cancelled" || kind === "order_already_done" || kind === "warning" || kind === "farm_status") { this.d.log("info", `order ${reqId}: IB ${code} ${msg}`); return; }
      this.lastError = `order ${reqId}: IB ${code} ${msg}`;
      this.d.log("error", this.lastError);
      const leg: "tp" | "sl" | null = reqId === tracked.tpId ? "tp" : reqId === tracked.slId ? "sl" : null;
      // CHILD-LEG REJECTION (post-build review F4): the parent keeps working without that exit.
      if (leg && !tracked.closed) {
        if (!tracked.filledSent) {
          // Entry not filled yet → pull the whole bracket (an entry with no stop is never allowed).
          const other = leg === "tp" ? tracked.slId : tracked.tpId;
          for (const id of [tracked.parentId, other]) { try { this.d.api.cancelOrder(id); } catch { /* ignore */ } }
          tracked.legRejected = leg;
          this.closeBracket(tracked, "rejected");
          this.d.emitEvent({ type: "order_error", error: `IB ${code}: ${msg} — ${leg === "sl" ? "stop" : "take-profit"} leg rejected; entry ${tracked.parentId} and the other leg cancelled`, orderId: reqId, source: "ibkr" });
          return;
        }
        // Entry filled → the position is OPEN: replace the missing exit at once.
        this.placeReplacementLeg(tracked, leg, `IB ${code} on ${leg === "sl" ? "stop" : "take-profit"} ${reqId}: ${msg}`);
        return;
      }
      this.d.emitEvent({ type: "order_error", error: `IB ${code}: ${msg}`, orderId: reqId, source: "ibkr" });
      if (reqId === tracked.parentId && !tracked.filledSent && !tracked.closed) this.closeBracket(tracked, "rejected");
      return;
    }
    switch (kind) {
      case "connect_failed": this.lastError = `IB ${code}: ${msg}`; this.d.log("error", this.lastError); if (!this.connected) this.scheduleReconnect(); return;
      case "not_connected": this.lastError = `IB ${code}: ${msg}`; if (this.connected) this.onDisconnected("504 not connected"); return;
      case "connectivity_lost": this.connectivity = "lost"; this.connectivityLostBy = 1100; this.lastError = `IB 1100: connectivity between IB and Gateway lost`; this.d.log("error", this.lastError); this.d.notify({ type: "ibkr_bridge", title: "🚨 IB Gateway lost its connection to IB", body: "Ticks/bars/orders paused until IB reports 1101/1102 (connectivity restored)." }); return;
      case "connectivity_restored_data_lost": this.connectivity = "ok"; this.connectivityLostBy = null; this.d.log("warn", `IB 1101: connectivity restored, subscriptions LOST — resubscribing`); this.unsubscribe(); this.subscribe(); return;
      case "connectivity_restored": this.connectivity = "ok"; this.connectivityLostBy = null; this.d.log("info", `IB 1102: connectivity restored, subscriptions maintained`); return;
      case "tws_server_link_broken": this.connectivity = "lost"; if (this.connectivityLostBy !== 1100) this.connectivityLostBy = 2110; this.lastError = `IB 2110: ${msg}`; this.d.log("warn", this.lastError); return;
      case "market_data_delayed":
        this.marketData = "delayed";
        this.lastError = `IB 10167: no real-time market data permission — ${msg}`;
        this.d.log("error", this.lastError);
        if (!this.delayedNotified) { this.delayedNotified = true; this.d.notify({ type: "ibkr_bridge", title: "🚨 IB says DELAYED data (10167)", body: "Subscribe to 'CME Real-Time (NP, L1)' in Client Portal → Market Data Subscriptions (on a paper login also enable sharing with the paper account). Delayed ticks are NOT tradeable — orders are refused until a reconnect sees real-time data." }); }
        return;
      case "no_market_data": this.lastError = `IB ${code}: ${msg}`; this.d.log("error", this.lastError); return;
      case "farm_status":
        this.d.log("info", `IB ${code}: ${msg}${reqId != null && reqId > 0 ? ` (reqId ${reqId})` : ""}`);
        // G3 (2026-09-23): IB commonly signals recovery from a 2110 (TWS ↔ IB server link broken)
        // only with "… farm connection is OK" (2104 market data / 2106 HMDS / 2158 sec-def) —
        // never a 1101/1102. Without this the F3 gate refused every order until a reconnect.
        // A 1100 loss still waits for 1101/1102 (IB always sends one when that link returns) —
        // a DELIBERATE, disclosed narrowing of "farm OK clears any loss": farm links can report
        // OK while the IB ↔ TWS login link is still down, so this errs toward refusing orders.
        // These id -1 messages arrive via EventName.info → onInfo (see wire()).
        if (FARM_OK_CODES.has(code) && /is ok/i.test(msg) && this.connectivity === "lost" && this.connectivityLostBy === 2110) {
          this.connectivity = "ok";
          this.connectivityLostBy = null;
          this.d.log("info", `IB ${code} farm OK after 2110 — connectivity restored (orders allowed again once a fresh tick arrives)`);
        }
        return;
      case "hist_pacing":
      case "hist_no_data":
      case "other":
      case "warning":
      default: {
        // G2 (2026-09-23): an informational 2100–2999 WARNING that carries a historical reqId
        // (2174 "date-time attributes without explicit time zone", 2176 fractional shares, …) is
        // NOT a request failure — IB still answers the request. Dropping it here abandoned the
        // live stream / every backfill chunk and ignored the real bars that followed. The
        // request and its no-answer timer stay untouched; only genuine failures (162 no-data /
        // pacing, 321, 200, 10xxx, other) fall through and drop it.
        if (kind === "warning" && reqId != null && this.histReqs.has(reqId)) {
          this.d.log("info", `IB ${code} on historical request ${reqId} (informational — request kept): ${msg}`);
          return;
        }
        const hist = reqId != null ? this.dropHistReq(reqId) : undefined; // cancels its no-answer timer (F5)
        if (hist) {
          if (hist.kind === "live") {
            this.subs.bars = false;
            if (kind !== "hist_pacing" && this.histDuration !== "1 D" && !hist.retried) {
              this.d.log("warn", `live 1m request (${this.histDuration}) refused: IB ${code} ${msg} — retrying with 1 D`);
              this.histDuration = "1 D";
              this.requestLiveBars();
              const r = this.histReqs.get(BARS_REQ_ID); if (r) r.retried = true;
            } else {
              this.lastError = `1m bar stream failed: IB ${code} ${msg}`;
              this.d.log("error", this.lastError);
              this.d.schedule(() => { if (this.connected && !this.subs.bars) this.requestLiveBars(); }, kind === "hist_pacing" ? 60_000 : 30_000);
            }
          } else {
            // A backfill chunk: pacing → retry the chunk in 60 s; IB's explicit "no data" → the chunk
            // is legitimately empty (closed session); ANY other failure → the job is incomplete and
            // declined (G6 — a partial answer would let reconcile delete the missing span's rows).
            const job = hist.job!, chunk = hist.chunk!;
            this.backfillInflight = null;
            if (kind === "hist_pacing") { job.chunks.unshift(chunk); this.backfillTimer = this.d.schedule(() => { this.backfillTimer = null; this.pumpBackfill(); }, 60_000); }
            else if (kind !== "hist_no_data") this.abandonBackfill(job, `chunk ${ibDateTime(chunk.fromSec)}..${ibDateTime(chunk.toSec)} failed: IB ${code} ${msg}`);
            else if (job.chunks.length === 0) this.finishBackfill(job);
            else this.pumpBackfill();
          }
          return;
        }
        if (kind === "warning") { this.d.log("info", `IB ${code}: ${msg}`); return; }
        this.lastError = `IB ${code}: ${msg}${reqId != null && reqId > 0 ? ` (reqId ${reqId})` : ""}`;
        this.d.log("warn", this.lastError);
      }
    }
  }

  // ── status ──
  status(): Record<string, unknown> {
    const now = this.d.now();
    const c = this.choice;
    const age = (t: number) => (t ? Math.round((now - t) / 1000) : null);
    return {
      enabled: true,
      connected: this.connected,
      ready: this.isReady(),
      gateway: { host: this.cfg.host, port: this.cfg.port, clientId: this.cfg.clientId, mode: this.cfg.port === 4001 || this.cfg.port === 7496 ? "LIVE" : "paper" },
      account: this.account,
      contract: c ? { conId: c.details.contract.conId ?? null, localSymbol: c.details.contract.localSymbol ?? null, rawSymbol: c.rawSymbol, lastTradeDate: new Date(c.lastTradeSec * 1000).toISOString().slice(0, 10), exchange: c.details.contract.exchange ?? this.cfg.exchange, reason: c.reason } : null,
      rollDate: c ? new Date(c.rollAtSec * 1000).toISOString().slice(0, 10) : null,
      rollDaysBeforeExpiry: this.cfg.rollDaysBeforeExpiry,
      contractOverride: this.cfg.contractOverride ?? null,
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      lastTickAgeSec: age(this.lastTickAt),
      lastTickPrice: this.lastTickPrice,
      lastBarAt: this.lastBarAt ? new Date(this.lastBarAt).toISOString() : null,
      subscriptions: { ticks: this.subs.ticks, bars: this.subs.bars, barsDuration: this.histDuration, studyLinkOpen: this.link.readyState === 1, backfill: { serve: this.cfg.serveBackfill, queued: this.backfillQueue.length, inflight: !!this.backfillInflight, histReqsLast10Min: this.pacer.lastTenMin } },
      openBrackets: this.openBrackets().map(b => ({ key: b.key, direction: b.cmd.direction, entry: b.cmd.price, tp1: b.cmd.tp1, sl: b.cmd.sl, qty: b.cmd.contracts, ids: [b.parentId, b.tpId, b.slId], parentStatus: b.parentStatus ?? null, tpStatus: b.tpStatus ?? null, slStatus: b.slStatus ?? null, acked: b.ackSent, filled: b.filledSent, fillPrice: b.fillPrice ?? null, createdAt: new Date(b.createdAt * 1000).toISOString() })),
      recentlyClosed: this.brackets.filter(b => b.closed).slice(-5).map(b => ({ key: b.key, direction: b.cmd.direction, entry: b.cmd.price, reason: b.closed!.reason, exitPrice: b.exitPrice ?? null, at: new Date(b.closed!.at * 1000).toISOString() })),
      lastError: this.lastError,
      reconnects: this.reconnects,
      connectAttempts: this.connectAttempts,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      heartbeatAgeSec: this.connected ? age(Math.max(this.lastHeartbeatAt, this.connectedAt)) : null,
      marketData: this.marketData,
      connectivity: this.connectivity,
      nextOrderId: this.nextOrderId,
      stopType: this.cfg.stopType,
      stats: { ...this.stats },
    };
  }

  digestLine(): string {
    const s = this.status() as any;
    const tick = s.lastTickAgeSec == null ? "no ticks yet" : `last tick ${s.lastTickAgeSec}s ago`;
    return `IBKR: ${s.connected ? "connected" : "DISCONNECTED ⚠️"} ${s.gateway.mode} ${s.account ?? "?"} · contract ${s.contract?.rawSymbol ?? "UNRESOLVED ⚠️"}${s.rollDate ? ` (roll ${s.rollDate})` : ""} · ${tick}${s.marketData === "delayed" ? " · DELAYED DATA ⚠️" : ""} · ${s.openBrackets.length} open bracket(s) · reconnects ${s.reconnects}${s.lastError ? ` · last error: ${String(s.lastError).slice(0, 120)}` : ""}`;
  }
}

// ── Real wiring (server only) ────────────────────────────────────────────────────────────
let bridge: IbkrBridge | null = null;
export function getIbkrBridge(): IbkrBridge | null { return bridge; }
export function ibkrDigestLine(): string | null { return bridge ? bridge.digestLine() : null; }

function bracketsFile(): string { return path.join(artifactsDir(process.cwd()), "ibkr-brackets.json"); }
/** Contract eras (F1) — next to ibkr-brackets.json. */
function stateFile(): string { return path.join(artifactsDir(process.cwd()), "ibkr-state.json"); }

/** GET /api/ibkr/status — always registered (says {enabled:false} when the flag is off). */
export function registerIbkrRoutes(app: Express): void {
  app.get("/api/ibkr/status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!bridge) { res.json({ enabled: false, hint: "set IB_ENABLED=true (see docs/ibkr-setup.md)" }); return; }
    res.json(bridge.status());
  });
}

/** Start the bridge against the real IB Gateway. Called from server/index.ts ONLY when
 *  IB_ENABLED=true. Lazy imports keep this module free of db/live-bars at load time. */
export async function startIbkrBridge(app: Express, cfg: IbkrConfig = configFromEnv()): Promise<IbkrBridge> {
  if (bridge) return bridge;
  const [{ IBApi }, lb, tn] = await Promise.all([
    import("@stoqey/ib"),
    import("./live-bars"),
    import("./trade-notify"),
  ]);
  const api = new IBApi({ host: cfg.host, port: cfg.port, clientId: cfg.clientId }) as unknown as IbApiLike;
  const log = (level: "info" | "warn" | "error", msg: string) => { const line = `[ibkr] ${msg}`; if (level === "error") console.error(line); else if (level === "warn") console.warn(line); else console.log(line); };
  // The ingest ctx exists from attach until detach. The bridge attaches before it subscribes,
  // so a message with no ctx can only be a late straggler after a detach — dropped.
  const ctxRef: { ctx: StudyIngestCtx | null } = { ctx: null };
  const deps: BridgeDeps = {
    api,
    ingest: (msg) => { if (!ctxRef.ctx) return; try { lb.ingestStudyMessage(msg as StudyMessage, ctxRef.ctx); } catch (e: any) { log("error", `ingest failed: ${e?.message ?? e}`); } },
    emitEvent: (msg) => { console.log("[order-commands] from ibkr-bridge:", msg); try { lb.ingestAutoTraderEvent(msg); } catch (e: any) { log("error", `event ingest failed: ${e?.message ?? e}`); } },
    registerExecutor: (exec) => lb.registerOrderExecutor(exec),
    attachStudy: (link, reply) => { ctxRef.ctx = lb.attachInProcessStudy(link as unknown as WebSocket, reply, "ibkr-bridge"); return ctxRef.ctx; },
    detachStudy: (handle) => { lb.detachInProcessStudy(handle as StudyIngestCtx); if (ctxRef.ctx === handle) ctxRef.ctx = null; },
    notify: (msg) => { try { tn.notifyTradeEvent(msg); } catch { /* ignore */ } },
    orderGateReason: () => lb.orderContractGateReason(),
    log,
    now: () => Date.now(),
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t; },
    cancel: (h) => clearTimeout(h as NodeJS.Timeout),
    loadBrackets: () => { try { const j = JSON.parse(fs.readFileSync(bracketsFile(), "utf8")); return Array.isArray(j?.brackets) ? j.brackets : []; } catch { return []; } },
    saveBrackets: (list) => { try { fs.writeFileSync(bracketsFile(), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), brackets: list }, null, 2)); } catch (e: any) { log("warn", `could not write ${bracketsFile()}: ${e?.message ?? e}`); } },
    loadState: () => { try { const j = JSON.parse(fs.readFileSync(stateFile(), "utf8")); return { eras: j?.eras && typeof j.eras === "object" ? j.eras : {} }; } catch { return { eras: {} }; } },
    saveState: (state) => { try { fs.writeFileSync(stateFile(), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...state }, null, 2)); } catch (e: any) { log("warn", `could not write ${stateFile()}: ${e?.message ?? e}`); } },
  };
  bridge = new IbkrBridge(cfg, deps);
  bridge.start();
  log("info", `bridge started (paper=${cfg.port === 4002 || cfg.port === 7497}) — GET /api/ibkr/status`);
  void app; // routes are registered by registerIbkrRoutes
  return bridge;
}
