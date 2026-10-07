// scripts/ibkr-bridge.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unit harness for server/ibkr-bridge.ts — NO IB Gateway, NO network, NO prod DB.
// NO test framework — plain asserts, run with:
//   npx tsx scripts/ibkr-bridge.test.ts   (exit 0 = all pass)
//
// A mock IBApi (an EventEmitter with the same method + event names the bridge uses) drives:
//   • front-month selection: nearest expiry, the IB_ROLL_DAYS_BEFORE_EXPIRY roll rule, IB_CONTRACT override
//   • raw study-style symbol derivation ("MESZ6") — what contract-guard keys on
//   • tick → ingestStudyMessage({type:"tick", symbol:"MESZ6", price, time})
//   • completed-bar detection from keepUpToDate updates (forming bar repeats; only a NEW time emits)
//   • connect-time backfill as bulk_bars + hello handshake
//   • bracket construction (ids, parentId, transmit chain, GTC, tp1Only single TP, Short side flip)
//   • event mapping: submitted → order_ack, filled → order_filled, TP/SL fill → bracket_flattened,
//     201 → order_error, parent cancel → orders_cancelled, reset_flag → flag_reset
//   • reconnect with backoff + resubscribe
//   • gap-audit backfill servicing (era floor, chunking, bulk_bars v2 + backfill_done)
//   • the order-executor registry + study ingest in server/live-bars.ts (temp DB via DB_PATH)
//   • post-build review fixes (2026-09-23): contract-era floor + persisted eras (F1), policy
//     declines (F2, bridge + gap-audit), connectivity / live-tick order gate (F3), child-leg
//     rejection (F4), historical-request timeouts (F5), request-id space (F6), late same-minute
//     bar re-emit (F7), deferred order_error (F8), ET-midnight roll instant (F10)
//   • real-money gap fixes (2026-09-23): later-leg placeOrder throw cancels the sent legs (G1),
//     informational 2xxx warnings keep historical requests (G2), farm "is OK" clears a 2110 (G3),
//     the no-answer timer measures silence (G4), a roll declines in-flight backfills (G5),
//     an incomplete backfill job is declined, never partially answered (G6)
//   • MOCK FIDELITY (2026-09-23 verifier refutation): IB system messages with id -1 (1100/1101/
//     1102/2110/210x farm statuses) arrive on EventName.info — @stoqey/ib's decoder never emits
//     them on 'error'. MockIB.sys() emits them the library's way; emitting one on 'error' with
//     id -1 is recorded as a fidelity violation (fails the run). A real-IBApi decoder block pins
//     the library routing and drives the bridge end-to-end through it (no socket, no network).
// ─────────────────────────────────────────────────────────────────────────────
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IBApi } from "@stoqey/ib";
import {
  requestDateField,
  IbkrBridge, BarStream, HistoricalPacer, selectFrontMonth, rawSymbolFor, parseIbDate, ibDateTime, buildBracket,
  parseOrderCommand, classifyIbError, configFromEnv, TICK_REQ_ID, BARS_REQ_ID, CONTRACT_REQ_BASE,
  BACKFILL_REQ_BASE, EXEC_REQ_ID, HIST_TIMEOUT_MS, seedEraStartSec, thirdFridayUtcSec, etMidnightSec,
  type BridgeDeps, type IbApiLike, type IbkrConfig, type ContractDetailsLike, type Bracket, type StudyLinkLike, type BridgeState,
} from "../server/ibkr-bridge";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── mock IBApi ────────────────────────────────────────────────────────────────
/** IB codes TWS/Gateway send as SYSTEM messages (ERR_MSG id -1). @stoqey/ib 1.6.10's decoder
 *  (decodeMsg_ERR_MSG) routes every id -1 ERR_MSG to EventName.info(message, code) — so a mock
 *  that emits these on 'error' with id -1 tests a shape production never produces. */
const IB_SYSTEM_CODES = new Set([1100, 1101, 1102, 1300, 2103, 2104, 2105, 2106, 2107, 2108, 2110, 2157, 2158]);
const mockFidelity: string[] = [];
class MockIB extends EventEmitter implements IbApiLike {
  override emit(event: string | symbol, ...args: any[]): boolean {
    if (event === "error" && args[2] === -1 && IB_SYSTEM_CODES.has(args[1])) mockFidelity.push(`MockIB emitted system code ${args[1]} on 'error' (the real library emits it on 'info')`);
    return super.emit(event, ...args);
  }
  /** An IB system message (id -1), delivered exactly as @stoqey/ib does: EventName.info(message, code). */
  sys(code: number, message: string) { return this.emit("info", message, code); }
  calls: Array<{ m: string; args: any[] }> = [];
  private _connected = false;
  get isConnected() { return this._connected; }
  private rec(m: string, ...args: any[]) { this.calls.push({ m, args }); return this; }
  connect(clientId?: number) { this._connected = true; return this.rec("connect", clientId); }
  disconnect() { this._connected = false; return this.rec("disconnect"); }
  reqIds(n?: number) { return this.rec("reqIds", n); }
  reqCurrentTime() { return this.rec("reqCurrentTime"); }
  reqManagedAccts() { return this.rec("reqManagedAccts"); }
  reqContractDetails(reqId: number, contract: any) { return this.rec("reqContractDetails", reqId, contract); }
  reqTickByTickData(reqId: number, contract: any, tickType: any, n: number, ignoreSize: boolean) { return this.rec("reqTickByTickData", reqId, contract, tickType, n, ignoreSize); }
  cancelTickByTickData(reqId: number) { return this.rec("cancelTickByTickData", reqId); }
  reqHistoricalData(reqId: number, contract: any, end: string | undefined, dur: string, bar: any, what: any, rth: any, fmt: number, keep: boolean) { return this.rec("reqHistoricalData", reqId, contract, end, dur, bar, what, rth, fmt, keep); }
  cancelHistoricalData(reqId: number) { return this.rec("cancelHistoricalData", reqId); }
  failNextPlace = 0;
  /** G1: let this many placeOrder calls succeed, then throw ONCE (-1 = off). */
  failAfterPlaces = -1;
  failCancel = false;
  placeOrder(id: number, contract: any, order: any) {
    if (this.failNextPlace > 0) { this.failNextPlace--; throw new Error("socket write failed"); }
    if (this.failAfterPlaces === 0) { this.failAfterPlaces = -1; throw new Error("socket write failed mid-bracket"); }
    if (this.failAfterPlaces > 0) this.failAfterPlaces--;
    return this.rec("placeOrder", id, contract, order);
  }
  cancelOrder(orderId: number) { if (this.failCancel) throw new Error("socket write failed on cancel"); return this.rec("cancelOrder", orderId); }
  reqOpenOrders() { return this.rec("reqOpenOrders"); }
  reqExecutions(reqId: number, filter: any) { return this.rec("reqExecutions", reqId, filter); }
  count(m: string) { return this.calls.filter(c => c.m === m).length; }
  last(m: string) { const l = this.calls.filter(c => c.m === m); return l[l.length - 1]; }
  of(m: string) { return this.calls.filter(c => c.m === m); }
}

// ── fake clock + scheduler + recorders ────────────────────────────────────────
interface Rec {
  ingested: any[]; events: any[]; notes: any[]; logs: string[];
  executor: { name: string; isReady: () => boolean; execute: (c: any) => boolean } | null;
  attached: Array<{ link: StudyLinkLike; reply: (m: object) => void }>; detached: number;
  saved: Bracket[] | null; timers: Array<{ id: number; fn: () => void; ms: number; at: number }>;
  states: BridgeState[];
}
function mkDeps(ib: MockIB, clock: { nowMs: number }, preset: Bracket[] = [], state: BridgeState = { eras: {} }): { deps: BridgeDeps; rec: Rec; runTimers: (filter?: (ms: number) => boolean) => number } {
  let tid = 0;
  const rec: Rec = { ingested: [], events: [], notes: [], logs: [], executor: null, attached: [], detached: 0, saved: null, timers: [], states: [] };
  const deps: BridgeDeps = {
    api: ib,
    ingest: m => { rec.ingested.push(m); },
    emitEvent: m => { rec.events.push(m); },
    registerExecutor: e => { rec.executor = e; },
    attachStudy: (link, reply) => { const h = { link, reply }; rec.attached.push(h); return h; },
    detachStudy: () => { rec.detached++; },
    notify: m => { rec.notes.push(m); },
    orderGateReason: () => null,
    log: (lvl, msg) => { rec.logs.push(`${lvl}: ${msg}`); },
    now: () => clock.nowMs,
    schedule: (fn, ms) => { const id = ++tid; rec.timers.push({ id, fn, ms, at: clock.nowMs }); return id; },
    cancel: h => { rec.timers = rec.timers.filter(t => t.id !== h); },
    loadBrackets: () => preset,
    saveBrackets: l => { rec.saved = l; },
    loadState: () => JSON.parse(JSON.stringify(state)),
    saveState: s => { rec.states.push(JSON.parse(JSON.stringify(s))); },
  };
  const runTimers = (filter: (ms: number) => boolean = () => true) => {
    const due = rec.timers.filter(t => filter(t.ms));
    rec.timers = rec.timers.filter(t => !filter(t.ms));
    for (const t of due) t.fn();
    return due.length;
  };
  return { deps, rec, runTimers };
}

const NOW = Date.UTC(2026, 8, 23, 14, 0, 0); // Wed 2026-09-23 10:00 ET — RTH
const CFG: IbkrConfig = { ...configFromEnv({}), enabled: true, backfillMaxDays: 30 };

const U6: ContractDetailsLike = { contract: { conId: 111, symbol: "MES", localSymbol: "MESU6", lastTradeDateOrContractMonth: "20260918", exchange: "CME", currency: "USD" }, contractMonth: "202609" };
const Z6: ContractDetailsLike = { contract: { conId: 222, symbol: "MES", localSymbol: "MESZ6", lastTradeDateOrContractMonth: "20261218", exchange: "CME", currency: "USD" }, contractMonth: "202612" };
const H7: ContractDetailsLike = { contract: { conId: 333, symbol: "MES", localSymbol: "MESH7", lastTradeDateOrContractMonth: "20270319", exchange: "CME", currency: "USD" }, contractMonth: "202703" };
const LIST = [H7, U6, Z6]; // deliberately unsorted

function answerContracts(ib: MockIB, list: ContractDetailsLike[] = LIST) {
  const req = ib.last("reqContractDetails");
  const reqId = req.args[0] as number;
  for (const d of list) ib.emit("contractDetails", reqId, d);
  ib.emit("contractDetailsEnd", reqId);
}

/** Bring a bridge to the "connected + contract resolved + subscribed" state. */
function boot(cfgOver: Partial<IbkrConfig> = {}, preset: Bracket[] = [], opts: { list?: ContractDetailsLike[]; state?: BridgeState; nowMs?: number } = {}) {
  const ib = new MockIB();
  const clock = { nowMs: opts.nowMs ?? NOW };
  const { deps, rec, runTimers } = mkDeps(ib, clock, preset, opts.state);
  const bridge = new IbkrBridge({ ...CFG, ...cfgOver }, deps);
  bridge.start();
  ib.emit("connected");
  ib.emit("nextValidId", 100);
  ib.emit("managedAccounts", "DU1234567");
  answerContracts(ib, opts.list);
  return { ib, clock, deps, rec, runTimers, bridge };
}

/** One live AllLast tick at the fake clock — the F3 order gate needs a fresh tick on this connection. */
function tick(b: { ib: MockIB; clock: { nowMs: number } }, price = 7685) {
  b.ib.emit("tickByTickAllLast", TICK_REQ_ID, 1, String(Math.floor(b.clock.nowMs / 1000)), price, 1, {}, "CME", "");
}
/** Run only the timers DUE at the fake clock (registered `at` + `ms` ≤ now) that match `filter`
 *  — lets a test prove a timer was RE-ARMED (G4) instead of firing everything by duration. */
function runDue(b: { rec: Rec; clock: { nowMs: number } }, filter: (ms: number) => boolean = () => true): number {
  let n = 0;
  for (;;) {
    const due = b.rec.timers.filter(t => filter(t.ms) && t.at + t.ms <= b.clock.nowMs);
    if (!due.length) return n;
    b.rec.timers = b.rec.timers.filter(t => !due.includes(t));
    for (const t of due) { t.fn(); n++; }
  }
}
const FINISHED = (ib: MockIB, reqId: number) => ib.emit("historicalData", reqId, "finished-x-y", -1, -1, -1, -1, -1, -1, -1, false);
const ROW = (ib: MockIB, reqId: number, t: number) => ib.emit("historicalData", reqId, String(t), 7680, 7690, 7670, 7685, 5, 1, 7681, false);
const sec = (ms: number) => Math.floor(ms / 1000);
const CMD ={ type: "order_command", symbol: "MES", direction: "Long", interval: "15m", riskLevel: "safe", price: 7685, tp1: 7695.5, tp2: null, sl: 7659, contracts: 2, tp1Only: true };

// ═════════════════════════════════════════════════════════════════════════════
console.log("── pure: parseIbDate / ibDateTime ──");
{
  assert(parseIbDate("1790000000") === 1790000000, "epoch-seconds string (formatDate=2) passes through");
  assert(parseIbDate(1790000000) === 1790000000, "numeric epoch passes through");
  assert(parseIbDate("20260923-14:00:00") === Math.floor(NOW / 1000), "yyyymmdd-hh:mm:ss is UTC");
  assert(parseIbDate("20260923  10:00:00 US/Eastern") === Math.floor(NOW / 1000), "wall clock with zone (double space) → correct instant");
  assert(parseIbDate("20260923 10:00:00") === Math.floor(NOW / 1000), "wall clock without zone → America/New_York");
  assert(parseIbDate("20260923") === Math.floor(Date.UTC(2026, 8, 23) / 1000), "date-only → UTC midnight");
  assert(parseIbDate("finished-20260921  09:30:00-20260923  10:00:00") === null, "'finished' marker → null");
  assert(ibDateTime(Math.floor(NOW / 1000)) === "20260923-14:00:00", "ibDateTime formats UTC as yyyymmdd-hh:mm:ss");
}

console.log("── pure: rawSymbolFor ──");
{
  assert(rawSymbolFor({ localSymbol: "MESZ6" }, "MES") === "MESZ6", "localSymbol MESZ6 → MESZ6");
  assert(rawSymbolFor({ localSymbol: "MESZ26" }, "MES") === "MESZ6", "two-digit-year localSymbol → one-digit year");
  assert(rawSymbolFor({ localSymbol: "", lastTradeDateOrContractMonth: "20261218" }, "MES") === "MESZ6", "no localSymbol → from lastTradeDate month");
  assert(rawSymbolFor({ localSymbol: "", lastTradeDateOrContractMonth: "20270319" }, "MES", { contractMonth: "202703" }) === "MESH7", "contractMonth wins → MESH7");
  assert(rawSymbolFor({ localSymbol: "ESZ6" }, "MES", { contractMonth: "202612" }) === "MESZ6", "foreign localSymbol root ignored → from contractMonth");
}

console.log("── pure: selectFrontMonth (roll rule + override) ──");
{
  const c = selectFrontMonth(LIST, NOW, 8, "MES");
  assert(c?.rawSymbol === "MESZ6" && c.reason === "nearest", "2026-09-23 (U6 expired 09-18) → MESZ6 nearest");
  assert(c?.prevLastTradeSec === Math.floor(Date.UTC(2026, 8, 18) / 1000), "previous contract expiry (era floor) = 2026-09-18");
  assert(c != null && new Date(c.rollAtSec * 1000).toISOString().slice(0, 10) === "2026-12-10", "Z6 roll date = lastTrade − 8 d = 2026-12-10");
  assert(c?.rollAtSec === sec(Date.UTC(2026, 11, 10, 5, 0, 0)), "F10: 8-d roll instant = 00:00 ET 2026-12-10 (05:00Z, EST) — not UTC midnight (= 19:00 ET the evening before)");
  const beforeRoll = selectFrontMonth(LIST, Date.UTC(2026, 11, 9, 23, 0, 0), 8, "MES");
  assert(beforeRoll?.rawSymbol === "MESZ6", "2026-12-09 23:00Z (>8 d before 12-18) → still MESZ6");
  const eveBefore = selectFrontMonth(LIST, Date.UTC(2026, 11, 10, 0, 0, 1), 8, "MES");
  assert(eveBefore?.rawSymbol === "MESZ6", "F10: 2026-12-10 00:00:01Z = 19:00 ET 12-09 (mid-ETH, the evening BEFORE the roll day) → still MESZ6");
  const atRoll = selectFrontMonth(LIST, Date.UTC(2026, 11, 10, 5, 0, 1), 8, "MES");
  assert(atRoll?.rawSymbol === "MESH7", "2026-12-10 05:00:01Z (just after 00:00 ET, 8 d before 12-18) → rolled to MESH7");
  const c4 = selectFrontMonth(LIST, NOW, 4, "MES");
  assert(c4?.rollAtSec === sec(Date.UTC(2026, 11, 14, 5, 0, 0)), "F10: MESZ6 (20261218) with 4 d → rollAtSec = 2026-12-14 05:00Z (00:00 ET Monday of expiry week)");
  assert(selectFrontMonth(LIST, Date.UTC(2026, 11, 14, 4, 59, 0), 4, "MES")?.rawSymbol === "MESZ6" && selectFrontMonth(LIST, Date.UTC(2026, 11, 14, 5, 0, 1), 4, "MES")?.rawSymbol === "MESH7", "F10: 4-d roll flips at 00:00 ET 12-14, not at 19:00 ET 12-13");
  const sep = selectFrontMonth(LIST, Date.UTC(2026, 8, 9, 12, 0, 0), 8, "MES");
  assert(sep?.rawSymbol === "MESU6", "2026-09-09 (9 d before 09-18) → MESU6");
  const sep2 = selectFrontMonth(LIST, Date.UTC(2026, 8, 10, 12, 0, 0), 8, "MES");
  assert(sep2?.rawSymbol === "MESZ6", "2026-09-10 (Thursday before the 3rd Friday) → MESZ6");
  const zero = selectFrontMonth(LIST, Date.UTC(2026, 8, 17, 12, 0, 0), 0, "MES");
  assert(zero?.rawSymbol === "MESU6", "rollDays=0 → holds the expiring contract until its last trade date");
  const o = selectFrontMonth(LIST, NOW, 8, "MES", "MESH7");
  assert(o?.rawSymbol === "MESH7" && o.reason === "override", "IB_CONTRACT=MESH7 pins H7 regardless of the rule");
  const o2 = selectFrontMonth(LIST, NOW, 8, "MES", "mesz6");
  assert(o2?.rawSymbol === "MESZ6" && o2.reason === "override", "override is case-insensitive");
  assert(selectFrontMonth(LIST, NOW, 8, "MES", "MESM7") === null, "unknown override → null (nothing subscribed, never a silent wrong month)");
  const far = selectFrontMonth(LIST, Date.UTC(2027, 5, 1), 8, "MES");
  assert(far?.rawSymbol === "MESH7" && far.reason === "last-listed", "past every listed expiry → last listed (flagged)");
  assert(selectFrontMonth([{ contract: { symbol: "ES", localSymbol: "ESZ6", lastTradeDateOrContractMonth: "20261218" } }], NOW, 8, "MES") === null, "foreign root rows are ignored");
}

console.log("── pure: era helpers (F1) ──");
{
  assert(thirdFridayUtcSec(2026, 9) === sec(Date.UTC(2026, 8, 18)) && thirdFridayUtcSec(2026, 12) === sec(Date.UTC(2026, 11, 18)) && thirdFridayUtcSec(2027, 3) === sec(Date.UTC(2027, 2, 19)), "thirdFridayUtcSec: Sep 18 2026 / Dec 18 2026 / Mar 19 2027");
  assert(thirdFridayUtcSec(2026, 5) === sec(Date.UTC(2026, 4, 15)), "thirdFridayUtcSec: a month starting on a Friday (May 2026 → 15th)");
  assert(etMidnightSec(sec(Date.UTC(2026, 8, 18))) === sec(Date.UTC(2026, 8, 18, 4)) && etMidnightSec(sec(Date.UTC(2026, 11, 18))) === sec(Date.UTC(2026, 11, 18, 5)), "etMidnightSec: 00:00 ET = 04:00Z in EDT, 05:00Z in EST");
  const z6 = sec(Date.UTC(2026, 11, 18));
  assert(seedEraStartSec({ lastTradeSec: z6, prevLastTradeSec: null }, 4) === sec(Date.UTC(2026, 8, 15, 4)), "seed with U6 no longer listed: 3rd Friday of Sep → 00:00 ET 09-18 − 4 d + 1 d margin = 00:00 ET 2026-09-15");
  assert(seedEraStartSec({ lastTradeSec: z6, prevLastTradeSec: sec(Date.UTC(2026, 8, 18)) }, 4) === sec(Date.UTC(2026, 8, 15, 4)), "seed with U6 still listed → same boundary");
  assert(seedEraStartSec({ lastTradeSec: z6, prevLastTradeSec: null }, 8) === sec(Date.UTC(2026, 8, 15, 4)), "seed caps the roll allowance at 4 d (Yahoo's roll owns the store, whatever the bridge's own rule)");
  assert(seedEraStartSec({ lastTradeSec: sec(Date.UTC(2027, 2, 19)), prevLastTradeSec: null }, 4) === sec(Date.UTC(2026, 11, 15, 5)), "seed for H7: Dec 18 expiry → 00:00 ET 2026-12-15");
}

console.log("── pure: parseOrderCommand + buildBracket ──");
{
  const p = parseOrderCommand({ type: "order_command", symbol: "MES", direction: "Long", interval: "15m", riskLevel: "safe", price: 7685, tp1: 7695.5, tp2: null, sl: 7659, contracts: 2, tp1Only: true });
  assert(p.ok && p.cmd.tp1Only && p.cmd.contracts === 2, "valid Long command parses; tp2 null forces tp1Only");
  const bad = parseOrderCommand({ type: "order_command", direction: "Long", price: 7685, tp1: 7695, sl: 0, contracts: 1 });
  assert(!bad.ok && bad.error === "price or sl is 0", "sl 0 → AutoTrader's exact error text");
  const side = parseOrderCommand({ type: "order_command", direction: "Long", price: 7685, tp1: 7675, sl: 7659, contracts: 1 });
  assert(!side.ok, "Long with tp1 below entry → rejected");
  if (p.ok) {
    const b = buildBracket(p.cmd, 100, { stopType: "STP", stopSlipPts: 2, account: "DU1", orderRef: "MYB:15m:Long" });
    assert(eq(b.ids, { parent: 100, tp: 101, sl: 102 }), "three consecutive ids from nextValidId");
    assert(b.parent.orderType === "MKT" && b.parent.action === "BUY" && b.parent.totalQuantity === 2 && b.parent.transmit === false && b.parent.parentId === undefined, "parent = MKT BUY full qty, transmit=false (AutoTrader's createMarketOrder entry)");
    assert(b.tp.orderType === "LMT" && b.tp.action === "SELL" && b.tp.lmtPrice === 7695.5 && b.tp.totalQuantity === 2 && b.tp.parentId === 100 && b.tp.transmit === false, "take-profit = LMT SELL @tp1 FULL qty, parentId, transmit=false");
    assert(b.sl.orderType === "STP" && b.sl.action === "SELL" && b.sl.auxPrice === 7659 && b.sl.totalQuantity === 2 && b.sl.parentId === 100 && b.sl.transmit === true, "stop = STP SELL @sl, parentId, transmit=true (releases the chain)");
    assert([b.parent, b.tp, b.sl].every(o => o.tif === "GTC" && o.outsideRth === true && o.account === "DU1" && o.orderRef === "MYB:15m:Long"), "all legs GTC + outsideRth + account + orderRef");
  }
  const s = parseOrderCommand({ type: "order_command", direction: "Short", price: 7685, tp1: 7674.5, tp2: 7660, sl: 7711, contracts: 3, tp1Only: false });
  if (s.ok) {
    const b = buildBracket(s.cmd, 200, { stopType: "STP LMT", stopSlipPts: 2 });
    assert(b.parent.action === "SELL" && b.tp.action === "BUY" && b.sl.action === "BUY", "Short flips sides: SELL entry, BUY exits");
    assert(b.tp.totalQuantity === 3 && b.tp.lmtPrice === 7674.5, "tp1Only=false with a tp2 STILL yields ONE take-profit at tp1 for the full qty (TP1-only policy)");
    assert(b.sl.orderType === "STP LMT" && b.sl.auxPrice === 7711 && b.sl.lmtPrice === 7713, "STP LMT mode: Short stop limit = sl + slip (AutoTrader's STOP_SLIP_PTS)");
    assert(Object.keys(b).filter(k => k !== "ids").length === 3, "exactly three orders — never a tp2 leg");
  }
  const t = parseOrderCommand({ type: "order_command", direction: "Long", price: 7685.13, tp1: 7695.62, sl: 7659.01, contracts: 1 });
  if (t.ok) { const b = buildBracket(t.cmd, 1, { stopType: "STP", stopSlipPts: 2 }); assert(b.tp.lmtPrice === 7695.5 && b.sl.auxPrice === 7659, "prices rounded to the 0.25 tick"); }
}

console.log("── pure: BarStream (keepUpToDate forming-bar repeats) ──");
{
  const s = new BarStream(60);
  const T = 1790000000 - (1790000000 % 60);
  const bar = (time: number, close: number, v = 10) => ({ time, open: 7680, high: 7690, low: 7670, close, volume: v });
  assert(s.onUpdate(bar(T, 7681)).length === 0, "first update seeds the forming bar");
  assert(s.onUpdate(bar(T, 7682)).length === 0 && s.onUpdate(bar(T, 7683)).length === 0, "same-time repeats emit nothing");
  const done = s.onUpdate(bar(T + 60, 7684));
  assert(done.length === 1 && done[0].time === T && done[0].close === 7683, "a NEWER time completes the previous bar with its LAST values");
  assert(s.onUpdate(bar(T + 60, 7685)).length === 0, "the new forming bar repeats → nothing");
  assert(s.onUpdate(bar(T, 7600)).length === 0, "an older/out-of-order update is ignored");
  assert(s.flush(T + 60 + 60 + 4, 5).length === 0, "flush inside the grace window → nothing");
  const fl = s.flush(T + 60 + 60 + 5, 5);
  assert(fl.length === 1 && fl[0].time === T + 60 && fl[0].close === 7685, "flush after grace → forming bar emitted");
  assert(s.flush(T + 1000, 5).length === 0 && s.onUpdate(bar(T + 60, 7686)).length === 0, "a time is never emitted twice");
  // F7: a LATE update for the minute the 5-s flush just emitted is re-emitted as a correction.
  const r = new BarStream(60);
  r.onUpdate(bar(T, 7681), T + 10);
  const fl2 = r.flush(T + 66, 5);
  assert(fl2.length === 1 && fl2[0].close === 7681, "F7 setup: flush emits the forming minute at T+66");
  const late = r.onUpdate(bar(T, 7683, 14), T + 70);
  assert(late.length === 1 && late[0].time === T && late[0].close === 7683 && late[0].volume === 14 && r.corrections === 1, "F7: late same-minute update within 120 s of the emission → RE-EMITTED with IB's final values");
  assert(r.onUpdate(bar(T, 7683, 14), T + 71).length === 0, "F7: an identical repeat of the corrected bar → nothing");
  assert(r.onUpdate(bar(T + 60, 7684), T + 75).length === 0, "F7: the next minute starts forming → nothing emitted yet");
  const late2 = r.onUpdate(bar(T, 7686, 15), T + 80);
  assert(late2.length === 1 && late2[0].close === 7686 && r.corrections === 2, "F7: a correction for the emitted minute still lands while the next one forms (inside the window)");
  assert(r.onUpdate(bar(T, 7690, 20), T + 66 + 121).length === 0 && r.corrections === 2, "F7: a late update more than 120 s after the emission → dropped");
  assert(r.onUpdate(bar(T - 60, 7600), T + 190).length === 0, "F7: an update OLDER than the emitted minute is never re-emitted");
}

console.log("── pure: HistoricalPacer ──");
{
  const p = new HistoricalPacer(3, 15_000);
  const t0 = 1_000_000;
  assert(p.waitMs("a", t0) === 0, "first request sends now");
  p.note("a", t0);
  assert(p.waitMs("a", t0 + 5_000) === 10_000, "identical request within 15 s waits the remainder");
  assert(p.waitMs("b", t0 + 5_000) === 0, "a different request is not held by the identical-key rule");
  p.note("b", t0 + 5_000); p.note("c", t0 + 6_000);
  assert(p.waitMs("d", t0 + 7_000) > 0, "cap reached (3 in window) → waits");
  assert(p.waitMs("d", t0 + 600_001) === 0, "window expired → sends");
}

console.log("── pure: classifyIbError ──");
{
  assert(classifyIbError(1100, "Connectivity between IB and TWS has been lost.") === "connectivity_lost", "1100 → connectivity_lost");
  assert(classifyIbError(1102, "…restored – data maintained.") === "connectivity_restored", "1102 → restored");
  assert(classifyIbError(10167, "Requested market data is not subscribed. Displaying delayed market data.") === "market_data_delayed", "10167 → delayed data");
  assert(classifyIbError(201, "Order rejected - reason:") === "order_rejected", "201 → rejected");
  assert(classifyIbError(202, "Order Canceled - reason:") === "order_cancelled", "202 → cancelled (informational)");
  assert(classifyIbError(162, "Historical Market Data Service error message:HMDS query returned no data") === "hist_no_data", "162 no data");
  assert(classifyIbError(162, "Historical data request pacing violation") === "hist_pacing", "162 pacing");
  assert(classifyIbError(2104, "Market data farm connection is OK") === "farm_status", "2104 → farm status");
}

console.log("── pure: configFromEnv ──");
{
  const c = configFromEnv({});
  assert(!c.enabled && c.host === "127.0.0.1" && c.port === 4002 && c.clientId === 17 && c.rollDaysBeforeExpiry === 4 && c.stopType === "STP", "defaults: OFF, 127.0.0.1:4002, clientId 17, roll 4 d (Yahoo's roll), STP");
  const c2 = configFromEnv({ IB_ENABLED: "true", IB_PORT: "4001", IB_CONTRACT: "mesz6", IB_STOP_TYPE: "stp_lmt", IB_ROLL_DAYS_BEFORE_EXPIRY: "8" });
  assert(c2.enabled && c2.port === 4001 && c2.contractOverride === "MESZ6" && c2.stopType === "STP LMT" && c2.rollDaysBeforeExpiry === 8, "env overrides parse");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── bridge: connect → contract → subscriptions ──");
{
  const { ib, rec, bridge } = boot();
  assert(ib.count("connect") === 1 && ib.last("connect").args[0] === 17, "start() connects with IB_CLIENT_ID");
  assert(rec.executor?.name === "ibkr-bridge", "registers itself as the order executor");
  assert(ib.count("reqIds") >= 1 && ib.count("reqOpenOrders") === 1 && ib.count("reqExecutions") === 1, "on connect: reqIds + reqOpenOrders + reqExecutions (reconcile)");
  const cd = ib.last("reqContractDetails");
  assert(cd.args[0] === CONTRACT_REQ_BASE && eq({ symbol: cd.args[1].symbol, secType: cd.args[1].secType, exchange: cd.args[1].exchange, currency: cd.args[1].currency }, { symbol: "MES", secType: "FUT", exchange: "CME", currency: "USD" }), "reqContractDetails(MES FUT CME USD)");
  const tk = ib.last("reqTickByTickData");
  assert(tk.args[0] === TICK_REQ_ID && tk.args[1].conId === 222 && tk.args[2] === "AllLast" && tk.args[3] === 0 && tk.args[4] === false, "reqTickByTickData(AllLast) on the Z6 conId");
  const hd = ib.last("reqHistoricalData");
  assert(hd.args[0] === BARS_REQ_ID && hd.args[1].conId === 222 && hd.args[2] === "" && hd.args[3] === "2 D" && hd.args[4] === "1 min" && hd.args[5] === "TRADES" && hd.args[6] === 0 && hd.args[7] === 2 && hd.args[8] === true, "reqHistoricalData(1 min TRADES, 2 D, useRTH 0, formatDate 2, keepUpToDate)");
  assert(rec.attached.length === 1, "attaches as an in-process study before subscribing");
  assert(bridge.isReady() && rec.executor!.isReady(), "ready once connected + contract + nextValidId");
  const st = bridge.status() as any;
  assert(st.connected && st.contract.rawSymbol === "MESZ6" && st.rollDate === "2026-12-14" && st.account === "DU1234567" && st.gateway.mode === "paper", "status: connected, MESZ6, roll 2026-12-14 (4 d before the 12-18 last trade), paper account");
}

console.log("── bridge: tick → ingestStudyMessage shape ──");
{
  const { ib, rec } = boot();
  ib.emit("tickByTickAllLast", TICK_REQ_ID, 2, "1790000000", 7685.25, 3, { pastLimit: false, unreported: false }, "CME", "");
  const t = rec.ingested.find(m => m.type === "tick");
  assert(eq(t, { type: "tick", symbol: "MESZ6", price: 7685.25, time: 1790000000000 }), "tick → {type:'tick', symbol:'MESZ6' (raw, month-coded), price, time ms}");
  ib.emit("tickByTickAllLast", 4242, 2, "1790000001", 7000, 1, {}, "CME", "");
  ib.emit("tickByTickAllLast", TICK_REQ_ID, 2, "1790000002", 0, 1, {}, "CME", "");
  assert(rec.ingested.filter(m => m.type === "tick").length === 1, "foreign reqId and zero price are ignored");
}

console.log("── bridge: initial batch → bulk_bars + hello; keepUpToDate → complete bars ──");
{
  const { ib, rec, clock, bridge } = boot();
  const nowSec = Math.floor(NOW / 1000);
  const M = nowSec - (nowSec % 60);
  const hist = (t: number, c: number, v = 25) => ib.emit("historicalData", BARS_REQ_ID, String(t), 7680, 7690, 7670, c, v, 5, 7681, false);
  for (let i = 5; i >= 0; i--) hist(M - i * 60, 7680 + i); // 5 closed + the forming minute M
  ib.emit("historicalData", BARS_REQ_ID, "finished-20260921  09:30:00-20260923  10:00:00", -1, -1, -1, -1, -1, -1, -1, false);
  const bulk = rec.ingested.filter(m => m.type === "bulk_bars");
  const hello = rec.ingested.find(m => m.type === "hello");
  assert(bulk.length === 1 && bulk[0].symbol === "MESZ6" && bulk[0].resolution === "1" && bulk[0].id === undefined, "history dump = ONE v1 bulk_bars (no id → watermark-guarded like a LiveBarRelay re-dump)");
  assert(bulk[0].bars.length === 5 && bulk[0].bars[0].t === M - 300 && bulk[0].bars[4].t === M - 60 && !bulk[0].bars.some((b: any) => b.t === M), "dump holds the 5 CLOSED minutes oldest-first; the forming minute is excluded");
  assert(eq(bulk[0].bars[0], { t: M - 300, o: 7680, h: 7690, l: 7670, c: 7685, v: 25 }), "bulk bar shape {t,o,h,l,c,v}");
  assert(hello && hello.symbol === "MESZ6" && hello.resolution === "1" && hello.ver === 2 && hello.seriesStartMs === (M - 300) * 1000 && hello.seriesEndMs === M * 1000, "hello {symbol:'MESZ6', resolution:'1', ver:2, seriesStart/EndMs}");
  assert(rec.ingested.indexOf(bulk[0]) < rec.ingested.indexOf(hello), "bulk_bars precedes hello (gap-audit audits an already-filled store)");
  assert(rec.attached[0].link.readyState === 1, "study link is OPEN after the handshake");

  const upd = (t: number, c: number, v: number) => ib.emit("historicalDataUpdate", BARS_REQ_ID, String(t), 7680, 7690, 7670, c, v, 5, 7681);
  upd(M, 7681, 30); upd(M, 7682, 31); upd(M, 7683, 32);
  assert(rec.ingested.filter(m => m.type === "bar").length === 0, "repeated forming-bar updates (same time) emit no bar");
  clock.nowMs += 61_000;
  upd(M + 60, 7684, 1);
  const bars = rec.ingested.filter(m => m.type === "bar");
  assert(bars.length === 1 && eq(bars[0], { type: "bar", symbol: "MESZ6", resolution: "1", time: M, open: 7680, high: 7690, low: 7670, close: 7683, volume: 32, complete: true }), "a NEW bar time completes the previous minute: {type:'bar', resolution:'1', …, complete:true} with the LAST values");
  upd(M + 60, 7685, 2); upd(M + 60, 7686, 3);
  assert(rec.ingested.filter(m => m.type === "bar").length === 1, "the next forming bar repeating emits nothing");
  upd(M - 120, 7000, 1);
  assert(rec.ingested.filter(m => m.type === "bar").length === 1, "an old bar time (re-sent history) never re-emits");
  clock.nowMs = (M + 120 + 5) * 1000;
  bridge.flushBars();
  const bars2 = rec.ingested.filter(m => m.type === "bar");
  assert(bars2.length === 2 && bars2[1].time === M + 60 && bars2[1].close === 7686, "boundary flush (bucket ended ≥ grace ago) emits the forming bar");
  bridge.flushBars();
  assert(rec.ingested.filter(m => m.type === "bar").length === 2, "flush is idempotent");
  const st = bridge.status() as any;
  assert(st.stats.bars === 2 && st.subscriptions.bars && st.subscriptions.ticks, "status counts bars, shows subscriptions");
}

console.log("── bridge: orders — bracket placement + event mapping ──");
{
  const b0 = boot(); tick(b0);
  const { ib, rec, runTimers, bridge } = b0;
  const cmd = { ...CMD };
  assert(rec.executor!.execute(cmd) === true, "executor accepts an order_command");
  const po = ib.of("placeOrder");
  assert(po.length === 3 && eq(po.map(c => c.args[0]), [100, 101, 102]), "three placeOrder calls with ids 100/101/102 (nextValidId)");
  assert(po.every(c => c.args[1].conId === 222 && c.args[1].secType === "FUT" && c.args[1].exchange === "CME"), "all legs on the resolved MES contract");
  assert(po[0].args[2].orderType === "MKT" && po[0].args[2].transmit === false && po[1].args[2].parentId === 100 && po[1].args[2].transmit === false && po[2].args[2].parentId === 100 && po[2].args[2].transmit === true, "parent MKT (transmit false) → TP (parentId, transmit false) → SL (parentId, transmit TRUE) — the atomic chain");
  assert(po[0].args[2].account === "DU1234567", "account from managedAccounts when IB_ACCOUNT is unset");
  assert(rec.events[0]?.type === "order_queued" && rec.events[0].direction === "Long" && rec.events[0].entry === 7685, "order_queued emitted on receipt (as AutoTrader does)");
  assert(rec.saved?.length === 1 && rec.saved[0].parentId === 100, "bracket persisted for restart reconciliation");

  ib.emit("orderStatus", 100, "PreSubmitted", 0, 2, 0, 1, 0, 0, 17, "", 0);
  ib.emit("orderStatus", 100, "Submitted", 0, 2, 0, 1, 0, 0, 17, "", 0);
  const acks = rec.events.filter(e => e.type === "order_ack");
  assert(acks.length === 1 && eq({ d: acks[0].direction, e: acks[0].entry, tp1: acks[0].tp1, tp2: acks[0].tp2, sl: acks[0].sl, q: acks[0].qty, tr: acks[0].useTrailer }, { d: "Long", e: 7685, tp1: 7695.5, tp2: 7695.5, sl: 7659, q: 2, tr: false }), "PreSubmitted/Submitted → ONE order_ack {direction, entry, tp1, tp2(=tp1), sl, qty, useTrailer:false}");
  ib.emit("orderStatus", 100, "Filled", 2, 0, 7685.25, 1, 0, 7685.25, 17, "", 0);
  ib.emit("orderStatus", 100, "Filled", 2, 0, 7685.25, 1, 0, 7685.25, 17, "", 0);
  const fills = rec.events.filter(e => e.type === "order_filled");
  assert(fills.length === 1 && fills[0].direction === "Long" && fills[0].entry === 7685 && fills[0].fillPrice === 7685.25, "parent Filled → ONE order_filled {direction, entry: command price (trade-state matches ±2), fillPrice}");
  ib.emit("orderStatus", 101, "Filled", 2, 0, 7695.5, 1, 100, 7695.5, 17, "", 0);
  const flat = rec.events.filter(e => e.type === "bracket_flattened");
  assert(flat.length === 1 && flat[0].reason === "tp_filled" && flat[0].entry === 7685 && flat[0].remaining_brackets === 0 && flat[0].exitPrice === 7695.5, "TP child Filled → bracket_flattened {reason:'tp_filled', entry, remaining_brackets:0}");
  assert(bridge.openBrackets().length === 0 && rec.saved?.length === 0, "bracket closed + persisted store emptied");
  assert(runTimers(ms => ms === 2_000) === 1 && ib.count("cancelOrder") === 1 && ib.last("cancelOrder").args[0] === 102, "2 s later the surviving stop is cancelled if IB's OCA had not (never a naked stop)");
  ib.emit("orderStatus", 102, "Cancelled", 0, 2, 0, 1, 100, 0, 17, "", 0);
  ib.emit("error", new Error("Order Canceled - reason:"), 202, 102);
  assert(rec.events.filter(e => e.type === "order_error").length === 0 && rec.events.length === 4, "sibling cancel + its 202 notice are silent (no order_error, no duplicate events)");

  // SL hit on a second bracket.
  rec.events.length = 0;
  assert(rec.executor!.execute({ ...cmd, direction: "Short", price: 7685, tp1: 7674.5, sl: 7711, tp2: 7660, tp1Only: false }) === true, "second (Short) bracket accepted");
  assert(ib.of("placeOrder").length === 6 && ib.of("placeOrder")[3].args[2].action === "SELL" && ib.of("placeOrder")[4].args[2].action === "BUY" && ib.of("placeOrder")[5].args[2].action === "BUY", "Short: SELL parent, BUY exits; still only 3 orders (tp2 ignored)");
  assert(rec.logs.some(l => l.includes("TP2 leg NOT created")), "tp1Only=false + tp2 → logged: TP2 leg NOT created (TP1-only policy)");
  ib.emit("orderStatus", 103, "Filled", 2, 0, 7685, 2, 0, 7685, 17, "", 0);
  ib.emit("orderStatus", 105, "Filled", 2, 0, 7711.25, 2, 103, 7711.25, 17, "", 0);
  const f2 = rec.events.filter(e => e.type === "bracket_flattened");
  assert(rec.events.some(e => e.type === "order_ack") && f2.length === 1 && f2[0].reason === "sl_filled" && f2[0].exitPrice === 7711.25, "Filled parent → ack+filled; SL child Filled → bracket_flattened {reason:'sl_filled'}");

  // Rejected parent (201).
  rec.events.length = 0;
  rec.executor!.execute(cmd);
  ib.emit("error", new Error("Order rejected - reason: insufficient margin"), 201, 106);
  const err = rec.events.filter(e => e.type === "order_error");
  assert(err.length === 1 && err[0].error === "IB 201: Order rejected - reason: insufficient margin" && err[0].orderId === 106, "201 on the parent → order_error {error:'IB 201: …'}");
  assert(bridge.openBrackets().length === 0, "rejected bracket dropped from the open set");

  // Cancelled parent before fill.
  rec.events.length = 0;
  rec.executor!.execute(cmd);
  ib.emit("orderStatus", 109, "Submitted", 0, 2, 0, 4, 0, 0, 17, "", 0);
  ib.emit("orderStatus", 109, "Cancelled", 0, 2, 0, 4, 0, 0, 17, "", 0);
  assert(rec.events.some(e => e.type === "orders_cancelled" && e.orderId === 109) && bridge.openBrackets().length === 0, "parent Cancelled before fill → orders_cancelled, bracket dropped");

  // Stop cancelled while the position is open → loud warning.
  rec.events.length = 0;
  rec.executor!.execute(cmd);
  ib.emit("orderStatus", 112, "Filled", 2, 0, 7685, 5, 0, 7685, 17, "", 0);
  ib.emit("orderStatus", 114, "Cancelled", 0, 2, 0, 5, 112, 0, 17, "", 0);
  assert(rec.events.some(e => e.type === "order_error" && /UNPROTECTED/.test(e.error)) && bridge.openBrackets().length === 1, "stop cancelled with an open position → order_error 'UNPROTECTED' (bracket stays tracked)");

  // reset_flag + invalid command + not-ready.
  rec.events.length = 0;
  assert(rec.executor!.execute({ type: "reset_flag" }) === true && rec.events[0]?.type === "flag_reset", "reset_flag → flag_reset");
  assert(rec.executor!.execute({ ...cmd, sl: 0 }) === true && !rec.events.some(e => e.type === "order_error"), "F8: invalid command accepted (true) — its order_error is NOT emitted synchronously (the caller records the trade first)");
  runTimers(ms => ms === 0);
  assert(rec.events.some(e => e.type === "order_error" && e.error === "price or sl is 0"), "F8: …and arrives on the next tick: accepted-then-errored exactly like AutoTrader");
  assert(ib.of("placeOrder").length === 15, "no orders placed for the invalid command");
  const gated = boot(); (gated.deps as any).orderGateReason = () => "off-contract";
  assert(gated.rec.executor!.execute(cmd) === false, "contract-guard gate refuses (belt and braces)");
}

console.log("── bridge: execDetails reconciliation (fills missed while disconnected) ──");
{
  const preset: Bracket[] = [{
    key: "MES|15m|Long|300", createdAt: Math.floor(NOW / 1000) - 600, rawSymbol: "MESZ6", conId: 222,
    cmd: { symbol: "MES", direction: "Long", interval: "15m", riskLevel: "safe", price: 7685, tp1: 7695.5, tp2: null, sl: 7659, contracts: 1, tp1Only: true },
    parentId: 300, tpId: 301, slId: 302, ackSent: true, filledSent: true,
  }];
  const { ib, rec, bridge } = boot({}, preset);
  assert(bridge.openBrackets().length === 1, "open bracket restored from disk at construction");
  ib.emit("execDetails", 9200, { conId: 222 }, { orderId: 301, execId: "x1", shares: 1, cumQty: 1, price: 7695.5, avgPrice: 7695.5, side: "SLD" });
  const flat = rec.events.filter(e => e.type === "bracket_flattened");
  assert(flat.length === 1 && flat[0].reason === "tp_filled" && bridge.openBrackets().length === 0, "execDetails for the TP leg (replayed by reqExecutions) → bracket_flattened once");
  ib.emit("execDetails", 9200, { conId: 222 }, { orderId: 301, execId: "x1", shares: 1, cumQty: 1, price: 7695.5, avgPrice: 7695.5, side: "SLD" });
  ib.emit("orderStatus", 301, "Filled", 1, 0, 7695.5, 9, 300, 7695.5, 17, "", 0);
  assert(rec.events.filter(e => e.type === "bracket_flattened").length === 1 && rec.events.filter(e => e.type === "order_filled").length === 0, "replays are idempotent: nothing spurious re-emitted");
  ib.emit("execDetails", 9200, { conId: 222 }, { orderId: 777, cumQty: 1, avgPrice: 1 });
  assert(rec.events.length === 1, "executions of untracked orders (manual TWS trades) are ignored");
}

console.log("── bridge: reconnect with backoff + resubscribe ──");
{
  const { ib, rec, runTimers, bridge } = boot();
  ib.emit("disconnected");
  assert(!bridge.isReady() && !rec.executor!.isReady(), "disconnected → not ready (orders refused → 'not connected' path)");
  assert(rec.detached === 1, "study detached (gap-audit sees the source gone)");
  const rt = rec.timers.filter(t => t.ms >= 2_000 && t.ms <= 60_000);
  assert(rt.length === 1 && rt[0].ms === 2_000, "reconnect scheduled with the 2 s initial backoff");
  runTimers(ms => ms === 2_000);
  assert(ib.count("connect") === 2, "reconnect timer → connect() again");
  ib.emit("error", new Error("Couldn't connect to TWS"), 502, -1);
  const rt2 = rec.timers.filter(t => t.ms >= 2_000 && t.ms <= 60_000);
  assert(rt2.length === 1 && rt2[0].ms === 4_000, "502 while down → next attempt at 4 s (doubling)");
  runTimers(ms => ms === 4_000);
  ib.emit("connected"); ib.emit("nextValidId", 500); answerContracts(ib);
  assert(ib.count("reqTickByTickData") === 2 && ib.of("reqHistoricalData").filter(c => c.args[0] === BARS_REQ_ID).length === 2, "after reconnect: ticks AND bars re-requested");
  assert(rec.attached.length === 2 && bridge.isReady(), "study re-attached, ready again");
  const st = bridge.status() as any;
  assert(st.reconnects === 1 && st.connectAttempts === 3 && st.nextOrderId === 500, "status: reconnects=1, attempts=3, nextValidId adopted");
  assert(rec.timers.some(t => t.ms === 30_000), "heartbeat (reqCurrentTime) rescheduled after reconnect");
  // Heartbeat death → forced disconnect → reconnect path.
  const { ib: ib2, rec: rec2, runTimers: run2, clock: clock2 } = boot();
  run2(ms => ms === 30_000);
  assert(ib2.count("reqCurrentTime") === 1, "heartbeat sends reqCurrentTime");
  clock2.nowMs += 120_000;
  run2(ms => ms === 30_000);
  assert(ib2.count("disconnect") === 1 && rec2.logs.some(l => l.includes("heartbeat")), "3 missed beats → forced disconnect");
  // 1101 (connectivity restored, data lost) → resubscribe.
  const b3 = boot();
  b3.ib.sys(1101, "Connectivity between IB and TWS has been restored - data lost.");
  assert(b3.ib.count("cancelTickByTickData") === 1 && b3.ib.count("reqTickByTickData") === 2 && b3.ib.count("reqHistoricalData") === 2, "1101 → cancel + re-request both subscriptions");
  b3.ib.emit("error", new Error("Requested market data is not subscribed. Displaying delayed market data."), 10167, TICK_REQ_ID);
  assert((b3.bridge.status() as any).marketData === "delayed" && b3.rec.notes.some(n => n.type === "ibkr_bridge" && /10167/.test(n.title)), "10167 → status marketData=delayed + one push/Discord note");
  // DELAYED DATA blocks orders (the engine would be firing ~15 min behind the market).
  const placedBefore = b3.ib.count("placeOrder");
  const delayedCmd = { type: "order_command", symbol: "MES", direction: "Long", interval: "15m", riskLevel: "safe", price: 7685, tp1: 7695.5, tp2: null, sl: 7659, contracts: 1, tp1Only: true };
  assert(b3.rec.executor!.isReady() === true && b3.rec.executor!.execute(delayedCmd) === false, "delayed data → executor stays 'ready' (status honest) but REFUSES the order (false, nothing tracked)");
  assert(b3.ib.count("placeOrder") === placedBefore && b3.rec.logs.some(l => /DELAYED/.test(l)), "no placeOrder while delayed; refusal logged");
  assert(b3.bridge.openBrackets().length === 0, "refused order is not tracked as a bracket");
  // A reconnect re-verifies the entitlement: first real tick → realtime → orders flow again.
  b3.ib.emit("disconnected");
  b3.ib.emit("connected");
  b3.ib.emit("nextValidId", 200);
  answerContracts(b3.ib);
  assert((b3.bridge.status() as any).marketData === "unknown", "reconnect resets the delayed verdict to unknown");
  b3.ib.emit("tickByTickAllLast", TICK_REQ_ID, 0, String(Math.floor(b3.clock.nowMs / 1000)), 7690, 1, {}, "", "");
  assert((b3.bridge.status() as any).marketData === "realtime" && b3.rec.executor!.execute(delayedCmd) === true && b3.ib.count("placeOrder") === placedBefore + 3, "real-time tick after reconnect → orders accepted again");
}

console.log("── bridge: contract roll switches subscriptions ──");
{
  const { ib, rec, clock, bridge } = boot();
  clock.nowMs = Date.UTC(2026, 11, 15, 12, 0, 0); // 3 days before Z6's 12-18 last trade — inside the default 4-day roll window
  (bridge as any).resolveContract();
  answerContracts(ib);
  assert(ib.count("cancelTickByTickData") === 1 && ib.count("cancelHistoricalData") === 1, "roll: old subscriptions cancelled");
  assert(ib.last("reqTickByTickData").args[1].conId === 333 && ib.last("reqHistoricalData").args[1].conId === 333, "roll: resubscribed on the H7 conId");
  assert((bridge.status() as any).contract.rawSymbol === "MESH7" && rec.notes.some(n => /roll/i.test(String(n.title))), "roll: status shows MESH7 and a push/Discord note went out");
  ib.emit("tickByTickAllLast", TICK_REQ_ID, 2, "1797000000", 7800, 1, {}, "CME", "");
  assert(rec.ingested.filter(m => m.type === "tick").pop()?.symbol === "MESH7", "ticks after the roll carry the new month code (contract-guard sees the roll)");
  (bridge as any).resolveContract(); answerContracts(ib);
  assert(ib.count("cancelTickByTickData") === 1, "re-check with no change → no churn");
  const pinned = boot({ contractOverride: "MESU6" });
  assert((pinned.bridge.status() as any).contract.rawSymbol === "MESU6", "IB_CONTRACT override pins the subscribed contract");
  const unknown = boot({ contractOverride: "MESM7" });
  assert(!unknown.bridge.isReady() && unknown.ib.count("reqTickByTickData") === 0 && /not found/.test(String((unknown.bridge.status() as any).lastError)), "unknown IB_CONTRACT → nothing subscribed, not ready, lastError explains");
}

console.log("── bridge: gap-audit backfill servicing ──");
{
  const { ib, rec, runTimers, clock } = boot();
  const nowSec = Math.floor(NOW / 1000);
  const link = rec.attached[0].link;
  // Old range (before the previous contract's expiry) → declined next tick with count 0.
  link.send(JSON.stringify({ type: "backfill", id: "bf-1", fromMs: (nowSec - 40 * 86400) * 1000, toMs: (nowSec - 39 * 86400) * 1000 }));
  assert(rec.ingested.filter(m => m.type === "backfill_done").length === 0, "declined answer is deferred (no synchronous re-entry into gap-audit's dispatcher)");
  runTimers(ms => ms === 0);
  const d1 = rec.ingested.find(m => m.type === "backfill_done" && m.id === "bf-1");
  assert(d1 && d1.count === 0 && d1.earliestAvailableMs === 0 && ib.count("reqHistoricalData") === 1, "range before the era floor → backfill_done count 0, no IB request, no provider-cap claim");
  assert(d1.declined === true && d1.reason === "era" && d1.source === "ibkr", "F2: the era decline is flagged {declined:true, reason:'era', source:'ibkr'} (never mistaken for 'no data')");
  // Recent 2-hour hole → one paced chunk, filtered to the range, answered as v2 bulk_bars + backfill_done.
  const from = nowSec - 7200, to = nowSec - 600;
  link.send(JSON.stringify({ type: "backfill", id: "bf-2", fromMs: from * 1000, toMs: to * 1000 }));
  const hr = ib.last("reqHistoricalData");
  assert(ib.count("reqHistoricalData") === 2 && hr.args[0] >= BACKFILL_REQ_BASE && hr.args[0] < BACKFILL_REQ_BASE + 100_000 && hr.args[2] === ibDateTime(to) && hr.args[3] === `${to - from} S` && hr.args[8] === false, "backfill → reqHistoricalData(endDateTime=range end UTC, '<span> S', keepUpToDate=false)");
  const reqId = hr.args[0];
  const M = from - (from % 60);
  for (let t = M - 120; t <= to + 120; t += 60) ib.emit("historicalData", reqId, String(t), 7680, 7690, 7670, 7685, 12, 3, 7681, false);
  ib.emit("historicalData", reqId, "finished-x-y", -1, -1, -1, -1, -1, -1, -1, false);
  const bulk = rec.ingested.filter(m => m.type === "bulk_bars" && m.id === "bf-2");
  const done = rec.ingested.find(m => m.type === "backfill_done" && m.id === "bf-2");
  assert(bulk.length === 1 && bulk[0].symbol === "MESZ6" && bulk[0].seq === 0 && bulk[0].final === true, "answer = v2 bulk_bars {id, seq, final}");
  assert(bulk[0].bars.every((b: any) => b.t >= from && b.t <= to) && bulk[0].bars.length === done.count && done.source === "ibkr", "bars clipped to the requested range; backfill_done count matches");
  // Pacing: an identical request inside 15 s waits.
  link.send(JSON.stringify({ type: "backfill", id: "bf-3", fromMs: from * 1000, toMs: to * 1000 }));
  assert(ib.count("reqHistoricalData") === 2 && rec.timers.some(t => t.ms > 0 && t.ms <= 15_000), "identical request within 15 s is held by the pacer");
  clock.nowMs += 16_000;
  runTimers(ms => ms > 0 && ms <= 15_000);
  assert(ib.count("reqHistoricalData") === 3, "…and sent once the identical-request gap has passed");
  const off = boot({ serveBackfill: false });
  off.rec.attached[0].link.send(JSON.stringify({ type: "backfill", id: "bf-9", fromMs: from * 1000, toMs: to * 1000 }));
  off.runTimers(ms => ms === 0);
  assert(off.ib.count("reqHistoricalData") === 1 && off.rec.ingested.some(m => m.type === "backfill_done" && m.id === "bf-9" && m.count === 0), "IB_SERVE_BACKFILL=false → every request declined (count 0)");
  const d9 = off.rec.ingested.find(m => m.type === "backfill_done" && m.id === "bf-9");
  assert(d9.declined === true && d9.reason === "disabled" && d9.source === "ibkr", "F2: serving disabled → {declined:true, reason:'disabled'}");
  const md = boot({ backfillMaxDays: 3 }); // floor = now − 3 d (09-20) is later than the era (09-15)
  md.rec.attached[0].link.send(JSON.stringify({ type: "backfill", id: "bf-md", fromMs: Date.UTC(2026, 8, 16), toMs: Date.UTC(2026, 8, 17) }));
  md.runTimers(ms => ms === 0);
  const dmd = md.rec.ingested.find(m => m.type === "backfill_done" && m.id === "bf-md");
  assert(dmd && dmd.count === 0 && dmd.declined === true && dmd.reason === "max_days" && dmd.source === "ibkr" && md.ib.count("reqHistoricalData") === 1, "F2: inside the era but older than IB_BACKFILL_MAX_DAYS → {declined:true, reason:'max_days'}, no IB request");
}

console.log("── F1: backfill era floor (previous contract expired / bridge roll / persisted era) ──");
{
  // 2026-09-23 with IB no longer listing U6 (includeExpired:false drops it on expiry day).
  const b = boot({}, [], { list: [H7, Z6] });
  const link = b.rec.attached[0].link;
  const era = sec(Date.UTC(2026, 8, 15, 4)); // 00:00 ET 09-15 (seeded: 09-18 expiry − 4 d + 1 d)
  assert(b.bridge.eraStartSec() === era, "LIST without U6: era = 00:00 ET 2026-09-15 (third Friday of Sep − 4 d + 1 d margin), not now − 30 d");
  link.send(JSON.stringify({ type: "backfill", id: "era-old", fromMs: Date.UTC(2026, 8, 1), toMs: Date.UTC(2026, 8, 10) }));
  b.runTimers(ms => ms === 0);
  const dOld = b.rec.ingested.find(m => m.type === "backfill_done" && m.id === "era-old");
  assert(dOld && dOld.declined === true && dOld.reason === "era" && dOld.count === 0 && b.ib.count("reqHistoricalData") === 1, "Sep 1–10 (the Sep contract's era) → declined:'era', IB never asked for Dec prices there");
  link.send(JSON.stringify({ type: "backfill", id: "era-new", fromMs: Date.UTC(2026, 8, 16, 0), toMs: Date.UTC(2026, 8, 16, 2) }));
  const hNew = b.ib.last("reqHistoricalData");
  assert(b.ib.count("reqHistoricalData") === 2 && hNew.args[2] === ibDateTime(sec(Date.UTC(2026, 8, 16, 2))) && hNew.args[3] === "7200 S", "Sep 16 00:00–02:00Z (inside the Dec era) → served");
  for (let t = sec(Date.UTC(2026, 8, 16, 0)); t <= sec(Date.UTC(2026, 8, 16, 2)); t += 60) b.ib.emit("historicalData", hNew.args[0], String(t), 7680, 7690, 7670, 7685, 5, 1, 7681, false);
  b.ib.emit("historicalData", hNew.args[0], "finished-x-y", -1, -1, -1, -1, -1, -1, -1, false);
  const dNew = b.rec.ingested.find(m => m.type === "backfill_done" && m.id === "era-new");
  assert(dNew && dNew.count === 121 && !dNew.declined, "…answered with its bars (not declined)");
  b.clock.nowMs += 20_000;
  link.send(JSON.stringify({ type: "backfill", id: "era-straddle", fromMs: Date.UTC(2026, 8, 14, 0), toMs: Date.UTC(2026, 8, 15, 12) }));
  const hS = b.ib.last("reqHistoricalData");
  assert(b.ib.count("reqHistoricalData") === 3 && hS.args[2] === ibDateTime(sec(Date.UTC(2026, 8, 15, 12))) && hS.args[3] === `${sec(Date.UTC(2026, 8, 15, 12)) - era} S`, "straddling request (09-14 → 09-15 12:00Z) → trimmed: IB asked only from the era start");
  for (let t = sec(Date.UTC(2026, 8, 15, 0)); t <= sec(Date.UTC(2026, 8, 15, 12)); t += 60) b.ib.emit("historicalData", hS.args[0], String(t), 7680, 7690, 7670, 7685, 5, 1, 7681, false);
  b.ib.emit("historicalData", hS.args[0], "finished-x-y", -1, -1, -1, -1, -1, -1, -1, false);
  const bS = b.rec.ingested.filter(m => m.type === "bulk_bars" && m.id === "era-straddle").flatMap((m: any) => m.bars);
  assert(bS.length > 0 && bS.every((x: any) => x.t >= era) && bS[0].t === era, "…and bars IB returns from before the era are dropped from the answer");
  // The connect-time dump is era-floored too.
  const nowS = sec(b.clock.nowMs);
  b.ib.emit("historicalData", BARS_REQ_ID, String(era - 120), 7000, 7001, 6999, 7000, 1, 1, 7000, false);
  b.ib.emit("historicalData", BARS_REQ_ID, String(era), 7680, 7690, 7670, 7685, 1, 1, 7681, false);
  b.ib.emit("historicalData", BARS_REQ_ID, String(nowS - 600), 7680, 7690, 7670, 7685, 1, 1, 7681, false);
  b.ib.emit("historicalData", BARS_REQ_ID, "finished-x-y", -1, -1, -1, -1, -1, -1, -1, false);
  const dump = b.rec.ingested.filter(m => m.type === "bulk_bars" && m.id === undefined).flatMap((m: any) => m.bars);
  assert(dump.length === 2 && dump.every((x: any) => x.t >= era), "connect-time bulk_bars dump: bars older than the era are never sent");
  assert(b.rec.states.length === 0, "no roll → nothing persisted");

  // Bridge roll Z6 → H7 on 2026-12-15 (inside the 4-day window): the era moves to the switch instant.
  const r = boot();
  const rollAt = Date.UTC(2026, 11, 15, 12, 0, 0);
  r.clock.nowMs = rollAt;
  (r.bridge as any).resolveContract(); answerContracts(r.ib);
  assert((r.bridge.status() as any).contract.rawSymbol === "MESH7", "bridge rolled to MESH7 on 12-15");
  const saved = r.rec.states[r.rec.states.length - 1];
  assert(saved && saved.eras.MESH7 === sec(rollAt), "saveState called with eras.MESH7 = the switch instant");
  assert(r.bridge.eraStartSec() === sec(rollAt), "era = the bridge's own switch instant (later than the seeded 00:00 ET 12-15)");
  const rl = r.rec.attached[0].link;
  rl.send(JSON.stringify({ type: "backfill", id: "dec-1", fromMs: Date.UTC(2026, 11, 1, 14), toMs: Date.UTC(2026, 11, 1, 16) }));
  rl.send(JSON.stringify({ type: "backfill", id: "dec-15-early", fromMs: Date.UTC(2026, 11, 15, 6), toMs: Date.UTC(2026, 11, 15, 7) }));
  r.runTimers(ms => ms === 0);
  const hr0 = r.ib.of("reqHistoricalData").length;
  assert(["dec-1", "dec-15-early"].every(id => r.rec.ingested.some(m => m.type === "backfill_done" && m.id === id && m.declined === true && m.reason === "era")), "after the roll a Dec 1 range (Z6's era) is declined — so is 12-15 06:00Z, before the bridge switched");
  assert(r.ib.of("reqHistoricalData").filter(c => c.args[0] >= BACKFILL_REQ_BASE).length === 0 && hr0 >= 1, "no H7 history requested for Z6-era ranges");

  // Restart: a persisted era is honoured (here 2026-09-20 00:00Z — later than the 09-15 seed).
  const persisted = sec(Date.UTC(2026, 8, 20));
  const p = boot({}, [], { state: { eras: { MESZ6: persisted } } });
  assert(p.bridge.eraStartSec() === persisted, "restart: persisted eras.MESZ6 honoured");
  const pl = p.rec.attached[0].link;
  pl.send(JSON.stringify({ type: "backfill", id: "p-18", fromMs: Date.UTC(2026, 8, 18, 14), toMs: Date.UTC(2026, 8, 18, 16) }));
  p.runTimers(ms => ms === 0);
  assert(p.rec.ingested.some(m => m.type === "backfill_done" && m.id === "p-18" && m.declined === true && m.reason === "era"), "…a 09-18 range (served by the seed alone) is declined after the restart");
  pl.send(JSON.stringify({ type: "backfill", id: "p-21", fromMs: Date.UTC(2026, 8, 21, 14), toMs: Date.UTC(2026, 8, 21, 16) }));
  assert(p.ib.of("reqHistoricalData").some(c => c.args[0] >= BACKFILL_REQ_BASE), "…a 09-21 range is served");
}

console.log("── F3: connectivity + live-tick order gate ──");
{
  const b = boot();
  assert(b.rec.executor!.execute(CMD) === false && b.ib.count("placeOrder") === 0 && b.rec.events.length === 0, "no tick yet on this connection → execute false, nothing placed, no event");
  assert(b.rec.logs.some(l => /^error: order refused: no IB tick yet/.test(l)), "…refusal logged as an error");
  tick(b);
  b.ib.sys(1100, "Connectivity between IB and TWS has been lost.");
  assert(b.rec.executor!.isReady() === true && b.rec.executor!.execute(CMD) === false && b.ib.count("placeOrder") === 0, "1100 → execute false (isReady unchanged — status stays honest about the socket)");
  assert(b.rec.logs.some(l => /connectivity LOST/.test(l)) && !b.rec.events.some(e => e.type === "order_error"), "…logged, no order_error event");
  b.ib.sys(1102, "Connectivity between IB and TWS has been restored - data maintained.");
  tick(b);
  assert(b.rec.executor!.execute(CMD) === true && b.ib.count("placeOrder") === 3, "1102 + a fresh tick → execute true, bracket placed");
  b.clock.nowMs += 120_000;
  assert(b.rec.executor!.execute(CMD) === false && b.ib.count("placeOrder") === 3, "clock +120 s with no tick → execute false (dead tick stream)");
  tick(b);
  assert(b.rec.executor!.execute(CMD) === true && b.ib.count("placeOrder") === 6, "a new tick → orders flow again");
  const t2 = boot(); tick(t2);
  t2.ib.sys(2110, "Connectivity between IB and TWS has been lost.");
  assert(t2.rec.executor!.execute(CMD) === false, "2110 (TWS↔server link broken) → execute false");
}

console.log("── F4: child-leg rejection ──");
{
  // TP leg rejected before the entry fills → whole bracket pulled.
  const a = boot(); tick(a);
  a.rec.executor!.execute(CMD); // ids 100/101/102
  a.ib.emit("error", new Error("Order rejected - reason: price out of range"), 201, 101);
  const ca = a.ib.of("cancelOrder").map(c => c.args[0]).sort();
  assert(eq(ca, [100, 102]), "201 on the TP (entry not filled) → cancelOrder(parent 100) + cancelOrder(stop 102)");
  assert(a.bridge.openBrackets().length === 0 && (a.bridge.status() as any).recentlyClosed.some((x: any) => x.reason === "rejected"), "…bracket closed 'rejected'");
  assert(a.rec.events.some(e => e.type === "order_error" && e.orderId === 101 && /take-profit leg rejected/.test(e.error)), "…order_error names the rejected take-profit leg");
  // SL leg rejected before the entry fills.
  const s = boot(); tick(s);
  s.rec.executor!.execute(CMD);
  s.ib.emit("error", new Error("Order rejected - reason: stop price"), 201, 102);
  assert(eq(s.ib.of("cancelOrder").map(c => c.args[0]).sort(), [100, 101]) && s.bridge.openBrackets().length === 0 && s.rec.events.some(e => e.type === "order_error" && /stop leg rejected/.test(e.error)), "201 on the STOP (entry not filled) → parent + TP cancelled, bracket closed, order_error");
  // SL leg rejected AFTER the entry filled → replacement STP.
  const f = boot(); tick(f);
  f.rec.executor!.execute(CMD);
  f.ib.emit("orderStatus", 100, "Filled", 2, 0, 7685.25, 1, 0, 7685.25, 17, "", 0);
  const reqIdsBefore = f.ib.count("reqIds");
  f.ib.emit("error", new Error("Order rejected - reason: stop"), 201, 102);
  const rep = f.ib.last("placeOrder");
  assert(f.ib.count("placeOrder") === 4 && rep.args[0] === 103, "201 on the STOP after the fill → replacement placed under a fresh id (103)");
  const o = rep.args[2];
  assert(o.orderType === "STP" && o.auxPrice === 7659 && o.action === "SELL" && o.totalQuantity === 2 && o.parentId === undefined && o.tif === "GTC" && o.outsideRth === true && o.transmit === true, "…plain STP @ original sl, exit side, full qty, GTC, outsideRth, no parentId");
  assert(f.ib.count("cancelOrder") === 0 && f.ib.count("reqIds") === reqIdsBefore + 1, "…nothing cancelled (position stays open), reqIds(1) refreshes the id counter");
  assert(f.rec.events.some(e => e.type === "order_error" && /STOP leg rejected, replacement placed/.test(e.error) && e.orderId === 103), "…loud order_error: 'leg rejected — replacement placed'");
  f.ib.emit("orderStatus", 103, "Filled", 2, 0, 7658.75, 1, 0, 7658.75, 17, "", 0);
  const fl = f.rec.events.filter(e => e.type === "bracket_flattened");
  assert(fl.length === 1 && fl[0].reason === "sl_filled" && f.bridge.openBrackets().length === 0, "the replacement stop's fill flattens the bracket through the normal child path (remapped id)");
  // TP leg rejected AFTER the fill → replacement LMT.
  const t = boot(); tick(t);
  t.rec.executor!.execute(CMD);
  t.ib.emit("orderStatus", 100, "Filled", 2, 0, 7685, 1, 0, 7685, 17, "", 0);
  t.ib.emit("error", new Error("Order rejected"), 201, 101);
  const tr = t.ib.last("placeOrder");
  assert(tr.args[0] === 103 && tr.args[2].orderType === "LMT" && tr.args[2].lmtPrice === 7695.5 && tr.args[2].action === "SELL" && tr.args[2].totalQuantity === 2 && tr.args[2].parentId === undefined, "201 on the TP after the fill → replacement LMT @ tp1 (fresh id 103)");
  assert(t.bridge.openBrackets()[0].tpId === 103 && t.bridge.openBrackets()[0].slId === 102, "…bracket's tpId remapped, stop untouched");
  // Replacement placeOrder throws → UNPROTECTED.
  const u = boot(); tick(u);
  u.rec.executor!.execute(CMD);
  u.ib.emit("orderStatus", 100, "Filled", 2, 0, 7685, 1, 0, 7685, 17, "", 0);
  u.ib.failNextPlace = 1;
  u.ib.emit("error", new Error("Order rejected"), 201, 102);
  assert(u.rec.events.some(e => e.type === "order_error" && /UNPROTECTED/.test(e.error)) && u.bridge.openBrackets().length === 1, "replacement placeOrder throws → order_error 'UNPROTECTED', bracket stays tracked");
}

console.log("── F5: historical-request timeouts ──");
{
  const b = boot();
  const link = b.rec.attached[0].link;
  const nowS = sec(NOW);
  link.send(JSON.stringify({ type: "backfill", id: "to-1", fromMs: (nowS - 3600) * 1000, toMs: (nowS - 600) * 1000 }));
  const first = b.ib.last("reqHistoricalData").args[0];
  assert(first >= BACKFILL_REQ_BASE && b.rec.timers.some(t => t.ms === HIST_TIMEOUT_MS), "backfill chunk request armed a 60 s no-answer timer");
  b.clock.nowMs += 61_000;
  b.runTimers(ms => ms === HIST_TIMEOUT_MS); // also fires the live stream's timer (never answered in this boot)
  assert(b.ib.of("cancelHistoricalData").some(c => c.args[0] === first), "no reply in 60 s → cancelHistoricalData(reqId)");
  const second = b.ib.of("reqHistoricalData").filter(c => c.args[0] >= BACKFILL_REQ_BASE);
  assert(second.length === 2 && second[1].args[0] !== first, "…the chunk is re-queued ONCE under a new reqId");
  assert(b.ib.of("cancelHistoricalData").some(c => c.args[0] === BARS_REQ_ID) && b.ib.of("reqHistoricalData").filter(c => c.args[0] === BARS_REQ_ID).length === 2, "live keepUpToDate request unanswered for 60 s → cancelled and re-requested");
  b.clock.nowMs += 61_000;
  b.runTimers(ms => ms === HIST_TIMEOUT_MS);
  const done = b.rec.ingested.find(m => m.type === "backfill_done" && m.id === "to-1");
  assert(done && done.count === 0 && done.declined === true && done.reason === "incomplete" && (b.bridge.status() as any).subscriptions.backfill.inflight === false, "second silence → job DECLINED as incomplete (G6), backfill_done STILL delivered (gap-audit's queue never wedges)");
  assert((b.bridge.status() as any).stats.histTimeouts >= 3, "timeouts counted in stats.histTimeouts");
  // Partial answer then silence → the chunk completes with what arrived.
  const c = boot();
  c.rec.attached[0].link.send(JSON.stringify({ type: "backfill", id: "to-2", fromMs: (nowS - 3600) * 1000, toMs: (nowS - 600) * 1000 }));
  const rq = c.ib.last("reqHistoricalData").args[0];
  for (let t = nowS - 3600; t < nowS - 3000; t += 60) c.ib.emit("historicalData", rq, String(t), 7680, 7690, 7670, 7685, 5, 1, 7681, false);
  c.clock.nowMs += 61_000;
  c.runTimers(ms => ms === HIST_TIMEOUT_MS);
  const d2 = c.rec.ingested.find(m => m.type === "backfill_done" && m.id === "to-2");
  assert(d2 && d2.count === 0 && d2.declined === true && d2.reason === "incomplete", "G6: bars arrived but no 'finished' → the job is DECLINED (a partial count>0 answer would let reconcile delete the missing span's rows)");
  assert(!c.rec.ingested.some(m => m.type === "bulk_bars" && m.id === "to-2"), "G6: the partial bars are discarded, never delivered under the job id");
  // Answered requests never time out; disconnect cancels the timers.
  const a = boot();
  a.ib.emit("historicalData", BARS_REQ_ID, "finished-x-y", -1, -1, -1, -1, -1, -1, -1, false);
  assert(!a.rec.timers.some(t => t.ms === HIST_TIMEOUT_MS), "answered live request → its timer cancelled");
  a.rec.attached[0].link.send(JSON.stringify({ type: "backfill", id: "to-3", fromMs: (nowS - 3600) * 1000, toMs: (nowS - 600) * 1000 }));
  a.ib.emit("disconnected");
  assert(!a.rec.timers.some(t => t.ms === HIST_TIMEOUT_MS), "disconnect → every historical timer cancelled");
}

console.log("── G6: a job with a lost chunk is declined, never partially answered ──");
{
  // Three 1-day chunks; the MIDDLE one goes silent twice. With a partial answer gap-audit's
  // reconcileRange would delete every stored row of that middle day (returned span = day1..day3).
  const b = boot();
  const link = b.rec.attached[0].link;
  const nowS = sec(NOW);
  const from = nowS - 3 * 86400 + 600, to = nowS - 600;
  link.send(JSON.stringify({ type: "backfill", id: "g6-1", fromMs: from * 1000, toMs: to * 1000 }));
  const r1 = b.ib.last("reqHistoricalData").args[0];
  for (let t = from; t < from + 600; t += 60) b.ib.emit("historicalData", r1, String(t), 7680, 7690, 7670, 7685, 5, 1, 7681, false);
  b.ib.emit("historicalData", r1, "finished-x-y", -1, -1, -1, -1, -1, -1, -1, false);
  const r2 = b.ib.last("reqHistoricalData").args[0];
  assert(r2 !== r1, "second chunk requested after the first finished");
  b.clock.nowMs += 61_000; b.runTimers(ms => ms === HIST_TIMEOUT_MS);
  b.clock.nowMs += 61_000; b.runTimers(ms => ms === HIST_TIMEOUT_MS);
  const done = b.rec.ingested.find(m => m.type === "backfill_done" && m.id === "g6-1");
  assert(done && done.declined === true && done.reason === "incomplete" && done.count === 0, "middle chunk silent twice → whole job declined 'incomplete'");
  assert(!b.rec.ingested.some(m => m.type === "bulk_bars" && m.id === "g6-1"), "…and the first chunk's 10 bars are NOT delivered (no partial answer)");
  const reqs = b.ib.of("reqHistoricalData").filter(c => c.args[0] >= BACKFILL_REQ_BASE);
  assert(reqs.length === 3, "the third chunk is never requested once the job is abandoned (2 for chunk 2 incl. the retry)");
  assert((b.bridge.status() as any).stats.backfillsDeclined >= 1, "declined jobs counted");
  // A non-'no data' IB error on a chunk (e.g. 200 no security definition) → declined too.
  const c = boot();
  c.rec.attached[0].link.send(JSON.stringify({ type: "backfill", id: "g6-2", fromMs: (nowS - 3600) * 1000, toMs: (nowS - 600) * 1000 }));
  const rq = c.ib.last("reqHistoricalData").args[0];
  c.ib.emit("error", new Error("No security definition has been found for the request"), 200, rq);
  const d2 = c.rec.ingested.find(m => m.type === "backfill_done" && m.id === "g6-2");
  assert(d2 && d2.declined === true && d2.reason === "incomplete" && /200/.test(String(d2.detail)), "IB 200 on a chunk → job declined 'incomplete' (detail carries the code)");
  // IB's explicit 'no data' (162 HMDS query returned no data) stays a legitimately EMPTY chunk.
  const e = boot();
  e.rec.attached[0].link.send(JSON.stringify({ type: "backfill", id: "g6-3", fromMs: (nowS - 3600) * 1000, toMs: (nowS - 600) * 1000 }));
  const rq3 = e.ib.last("reqHistoricalData").args[0];
  e.ib.emit("error", new Error("Historical Market Data Service error message:HMDS query returned no data: MESZ6@CME Trades"), 162, rq3);
  const d3 = e.rec.ingested.find(m => m.type === "backfill_done" && m.id === "g6-3");
  assert(d3 && !d3.declined && d3.count === 0, "162 'no data' → normal count-0 answer (closed session), not declined");
}

console.log("── LIVE 10372: request contracts carry only the yyyymmdd date (TWS long-form lastTradeDate) ──");
{
  assert(requestDateField("20261218 08:30:00 US/Central") === "20261218", "long TWS form → yyyymmdd only");
  assert(requestDateField("20261218") === "20261218" && requestDateField("202612") === "202612", "yyyymmdd / yyyymm pass through");
  assert(requestDateField("") === undefined && requestDateField(undefined) === undefined && requestDateField("US/Central") === undefined, "no usable prefix → field omitted");
  const b = boot();
  const LONG = [H7, { ...Z6, contract: { ...Z6.contract, lastTradeDateOrContractMonth: "20261218 08:30:00 US/Central" } }];
  (b.bridge as any).resolveContract(); answerContracts(b.ib, LONG);
  assert((b.bridge.status() as any).contract.rawSymbol === "MESZ6" && (b.bridge.status() as any).contract.lastTradeDate === "2026-12-18", "long-form details still resolve MESZ6 / 2026-12-18");
  b.ib.sys(1101, "Connectivity between IB and TWS has been restored - data lost."); // resubscribe with the rebuilt contract
  const tk = b.ib.last("reqTickByTickData").args[1], hd = b.ib.last("reqHistoricalData").args[1];
  assert(tk.conId === 222 && tk.lastTradeDateOrContractMonth === "20261218" && hd.lastTradeDateOrContractMonth === "20261218", "tick + bar requests send lastTradeDateOrContractMonth as yyyymmdd (never the ' 08:30:00 US/Central' tail)");
  tick(b);
  b.rec.executor!.execute({ type: "order_command", symbol: "MES", direction: "Long", interval: "15m", riskLevel: "safe", price: 7685, tp1: 7695.5, tp2: null, sl: 7659, contracts: 1, tp1Only: true });
  assert(b.ib.last("placeOrder").args[1].lastTradeDateOrContractMonth === "20261218", "orders send the sanitized date too");
}

console.log("── F6: request ids live outside the order-id space and resolve first ──");
{
  assert(TICK_REQ_ID === 2_000_000_001 && BARS_REQ_ID === 2_000_000_002 && CONTRACT_REQ_BASE === 2_000_000_100 && EXEC_REQ_ID === 2_000_000_200 && BACKFILL_REQ_BASE === 2_000_000_500, "request id bases 2_000_000_001 / 002 / 100 / 200 / 500");
  const b = boot(); tick(b);
  assert(b.ib.last("reqExecutions").args[0] === EXEC_REQ_ID, "reqExecutions uses EXEC_REQ_ID");
  // Contrived collision: a tracked bracket whose parent id equals BARS_REQ_ID.
  const preset: Bracket[] = [{ key: "MES|15m|Long|x", createdAt: sec(NOW) - 60, rawSymbol: "MESZ6", conId: 222, cmd: { symbol: "MES", direction: "Long", interval: "15m", riskLevel: "safe", price: 7685, tp1: 7695.5, tp2: null, sl: 7659, contracts: 1, tp1Only: true }, parentId: BARS_REQ_ID, tpId: BARS_REQ_ID + 1, slId: BARS_REQ_ID + 2, ackSent: true, filledSent: false }];
  const c = boot({}, preset);
  c.ib.emit("error", new Error("Historical Market Data Service error message:invalid duration"), 321, BARS_REQ_ID);
  assert(!c.rec.events.some(e => e.type === "order_error") && c.bridge.openBrackets().length === 1, "an error on BARS_REQ_ID is the bar request's — never a tracked order's (no order_error, bracket intact)");
  assert(c.ib.of("reqHistoricalData").filter(x => x.args[0] === BARS_REQ_ID).length === 2 && c.ib.last("reqHistoricalData").args[3] === "1 D", "…handled as the live request (retried with 1 D)");
}

console.log("── F7: bridge re-emits a late same-minute update ──");
{
  const b = boot();
  const nowSec = sec(NOW);
  const M = nowSec - (nowSec % 60);
  b.ib.emit("historicalData", BARS_REQ_ID, String(M), 7680, 7690, 7670, 7681, 5, 1, 7681, false);
  b.ib.emit("historicalData", BARS_REQ_ID, "finished-x-y", -1, -1, -1, -1, -1, -1, -1, false);
  b.clock.nowMs = (M + 66) * 1000;
  b.bridge.flushBars();
  assert(b.rec.ingested.filter(m => m.type === "bar").length === 1, "flush emitted the forming minute");
  b.clock.nowMs = (M + 70) * 1000;
  b.ib.emit("historicalDataUpdate", BARS_REQ_ID, String(M), 7680, 7692, 7670, 7684, 9, 1, 7681);
  const bars = b.rec.ingested.filter(m => m.type === "bar");
  assert(bars.length === 2 && bars[1].time === M && bars[1].close === 7684 && bars[1].high === 7692 && bars[1].complete === true, "late update for the same minute (4 s after the flush) → re-emitted with IB's final values");
  const st = b.bridge.status() as any;
  assert(st.stats.barCorrections === 1 && st.stats.bars === 1, "counted in stats.barCorrections (not as a new bar)");
}

console.log("── F8: placeOrder throw → order_error deferred ──");
{
  const b = boot(); tick(b);
  b.ib.failNextPlace = 1;
  assert(b.rec.executor!.execute(CMD) === true && !b.rec.events.some(e => e.type === "order_error"), "placeOrder throws → execute still true (accepted-then-errored), no synchronous order_error");
  b.runTimers(ms => ms === 0);
  assert(b.rec.events.some(e => e.type === "order_error" && /placeOrder threw/.test(e.error)) && b.bridge.openBrackets().length === 0, "…order_error on the next tick; bracket untracked");
}

console.log("── G1: placeOrder throws on a LATER leg → sent legs cancelled, bracket kept until IB confirms ──");
{
  // Control: a throw on the FIRST leg → nothing reached IB → untracked at once, nothing to cancel.
  const z = boot(); tick(z);
  z.ib.failAfterPlaces = 0;
  assert(z.rec.executor!.execute(CMD) === true && z.bridge.openBrackets().length === 0 && z.ib.count("cancelOrder") === 0 && z.ib.count("placeOrder") === 0, "G1 control: throw on the 1st (parent) leg → untracked immediately, no cancelOrder");

  // Throw on the 2nd (take-profit) leg: the parent MKT was already sent.
  const a = boot(); tick(a);
  a.ib.failAfterPlaces = 1;
  assert(a.rec.executor!.execute(CMD) === true, "G1: TP-leg throw → execute still true (accepted-then-errored)");
  assert(eq(a.ib.of("placeOrder").map(c => c.args[0]), [100]), "G1 setup: only the parent (100) reached the socket");
  assert(eq(a.ib.of("cancelOrder").map(c => c.args[0]), [100]), "G1: throw on the 2nd leg → cancelOrder(parent 100)");
  const ob = a.bridge.openBrackets();
  assert(ob.length === 1 && ob[0].parentId === 100 && ob[0].placeFailed === "tp", "G1: bracket STILL tracked (placeFailed 'tp') until IB confirms the cancel");
  assert(a.rec.saved?.length === 1 && a.rec.saved[0].placeFailed === "tp", "G1: …and persisted (a restart still knows about the sent parent)");
  assert(!a.rec.events.some(e => e.type === "order_error"), "G1: no synchronous order_error (F8 — the caller records the trade first)");
  a.runTimers(ms => ms === 0);
  const ea = a.rec.events.filter(e => e.type === "order_error");
  assert(ea.length === 1 && /take-profit leg/.test(ea[0].error) && /cancel requested for 100/.test(ea[0].error) && ea[0].orderId === 100, "G1: deferred order_error names the failed leg and the cancel of the sent parent");
  a.ib.emit("orderStatus", 100, "Cancelled", 0, 2, 0, 1, 0, 0, 17, "", 0);
  assert(a.bridge.openBrackets().length === 0 && (a.bridge.status() as any).recentlyClosed.some((x: any) => x.reason === "rejected"), "G1: IB confirms the parent Cancelled → bracket closed 'rejected'");
  assert(!a.rec.events.some(e => e.type === "orders_cancelled") && a.rec.events.filter(e => e.type === "order_error").length === 1, "G1: …no orders_cancelled (it clears EVERY trade record downstream), no second order_error");

  // Throw on the 3rd (stop) leg: parent AND take-profit were sent.
  const s = boot(); tick(s);
  s.ib.failAfterPlaces = 2;
  s.rec.executor!.execute(CMD);
  assert(eq(s.ib.of("placeOrder").map(c => c.args[0]), [100, 101]) && eq(s.ib.of("cancelOrder").map(c => c.args[0]).sort(), [100, 101]), "G1: throw on the 3rd leg → cancelOrder for BOTH the parent 100 and the take-profit 101");
  assert(s.bridge.openBrackets().length === 1 && s.bridge.openBrackets()[0].placeFailed === "sl", "G1: …bracket kept tracked (placeFailed 'sl')");
  s.runTimers(ms => ms === 0);
  assert(s.rec.events.some(e => e.type === "order_error" && /stop leg/.test(e.error) && /100 \+ 101/.test(e.error)), "G1: …deferred order_error names the stop leg and both cancelled ids");
  s.ib.emit("error", new Error("OrderId 100 that needs to be cancelled is not found."), 10147, 100);
  assert(s.bridge.openBrackets().length === 0 && (s.bridge.status() as any).recentlyClosed.some((x: any) => x.reason === "rejected"), "G1: 10147 on the entry cancel (IB never held it) → bracket closed 'rejected'");

  // The parent FILLS anyway (the cancel lost the race) → the position gets a replacement stop.
  const f = boot(); tick(f);
  f.ib.failAfterPlaces = 1;
  f.rec.executor!.execute(CMD);
  f.runTimers(ms => ms === 0);
  f.ib.emit("orderStatus", 100, "Filled", 2, 0, 7685.25, 1, 0, 7685.25, 17, "", 0);
  assert(f.rec.events.some(e => e.type === "order_filled" && e.fillPrice === 7685.25), "G1: parent Filled after the throw → order_filled still reported");
  const rep = f.ib.last("placeOrder");
  assert(f.ib.count("placeOrder") === 2 && rep.args[0] === 103, "G1: …a replacement leg is placed under a fresh id (103)");
  const ro = rep.args[2];
  assert(ro.orderType === "STP" && ro.auxPrice === 7659 && ro.action === "SELL" && ro.totalQuantity === 2 && ro.parentId === undefined && ro.transmit === true && ro.tif === "GTC", "G1: …it is a transmitted STP @ the original sl, exit side, full qty, GTC, no parentId");
  assert(f.bridge.openBrackets().length === 1 && f.bridge.openBrackets()[0].slId === 103, "G1: …bracket stays open with its stop remapped to 103");
  assert(f.rec.events.some(e => e.type === "order_error" && /replacement placed/.test(e.error) && e.orderId === 103), "G1: …loud order_error: replacement placed");
  f.ib.emit("orderStatus", 103, "Filled", 2, 0, 7658.75, 1, 0, 7658.75, 17, "", 0);
  assert(f.rec.events.some(e => e.type === "bracket_flattened" && e.reason === "sl_filled") && f.bridge.openBrackets().length === 0, "G1: …the replacement stop's fill flattens the bracket normally");

  // cancelOrder itself throws → the loudest possible error, bracket still tracked.
  const x = boot(); tick(x);
  x.ib.failAfterPlaces = 1; x.ib.failCancel = true;
  x.rec.executor!.execute(CMD);
  x.runTimers(ms => ms === 0);
  assert(x.rec.events.some(e => e.type === "order_error" && /cancelOrder FAILED/.test(e.error) && /WITHOUT A STOP/.test(e.error)) && x.bridge.openBrackets().length === 1, "G1: cancelOrder throws too → order_error 'cancelOrder FAILED … WITHOUT A STOP', bracket kept tracked");
}

console.log("── G2: informational warnings never abandon historical requests ──");
{
  const W2174 = "Warning: You submitted request with date-time attributes without explicit time zone. Please switch to use yyyymmdd-hh:mm:ss in UTC or use instrument time zone, like US/Eastern.";
  assert(classifyIbError(2174, W2174) === "warning", "2174 classifies as an informational warning");
  // Live keepUpToDate request.
  const b = boot();
  const liveReq = (b.bridge as any).histReqs.get(BARS_REQ_ID);
  b.ib.emit("error", new Error(W2174), 2174, BARS_REQ_ID);
  assert(!b.ib.of("cancelHistoricalData").some(c => c.args[0] === BARS_REQ_ID) && b.ib.of("reqHistoricalData").filter(c => c.args[0] === BARS_REQ_ID).length === 1, "G2: 2174 on the live reqId → no cancelHistoricalData, no re-request");
  assert(!!liveReq && (b.bridge as any).histReqs.get(BARS_REQ_ID) === liveReq && liveReq.timer != null && b.rec.timers.some(t => t.ms === HIST_TIMEOUT_MS), "G2: …the histReqs entry and its no-answer timer are kept untouched");
  const st = b.bridge.status() as any;
  assert(st.subscriptions.bars === true && st.subscriptions.barsDuration === "2 D", "G2: …bars subscription intact, duration NOT downgraded to 1 D");
  const nowS = sec(NOW), M = nowS - (nowS % 60);
  for (let i = 3; i >= 1; i--) ROW(b.ib, BARS_REQ_ID, M - i * 60);
  FINISHED(b.ib, BARS_REQ_ID);
  const dump = b.rec.ingested.filter(m => m.type === "bulk_bars" && m.id === undefined);
  assert(dump.length === 1 && dump[0].bars.length === 3 && b.rec.ingested.some(m => m.type === "hello"), "G2: the historicalData rows that follow are still ingested (bulk_bars + hello)");
  assert(b.rec.logs.some(l => /2174/.test(l) && /request kept/.test(l)), "G2: the warning is logged");
  // A backfill chunk.
  const c = boot();
  FINISHED(c.ib, BARS_REQ_ID);
  c.rec.attached[0].link.send(JSON.stringify({ type: "backfill", id: "g2-bf", fromMs: (nowS - 3600) * 1000, toMs: (nowS - 600) * 1000 }));
  const rq = c.ib.last("reqHistoricalData").args[0];
  c.ib.emit("error", new Error(W2174), 2174, rq);
  assert(!c.ib.of("cancelHistoricalData").some(x => x.args[0] === rq) && !c.rec.ingested.some(m => m.type === "backfill_done" && m.id === "g2-bf") && (c.bridge as any).histReqs.has(rq), "G2: 2174 on a backfill chunk → request kept, job neither answered nor declined");
  for (let t = nowS - 3600; t < nowS - 600; t += 60) ROW(c.ib, rq, t);
  FINISHED(c.ib, rq);
  const done = c.rec.ingested.find(m => m.type === "backfill_done" && m.id === "g2-bf");
  assert(done && !done.declined && done.count === 50 && c.rec.ingested.some(m => m.type === "bulk_bars" && m.id === "g2-bf"), "G2: …the chunk completes normally (count 50, not declined)");
  assert(c.ib.of("reqHistoricalData").filter(x => x.args[0] >= BACKFILL_REQ_BASE).length === 1, "G2: …and was never re-requested");
  // Control: 162 pacing is a genuine failure — the existing 60 s chunk retry still runs.
  const p = boot();
  FINISHED(p.ib, BARS_REQ_ID);
  p.rec.attached[0].link.send(JSON.stringify({ type: "backfill", id: "g2-pace", fromMs: (nowS - 3600) * 1000, toMs: (nowS - 600) * 1000 }));
  const rp = p.ib.last("reqHistoricalData").args[0];
  p.ib.emit("error", new Error("Historical Market Data Service error message:Historical data request pacing violation"), 162, rp);
  assert(!(p.bridge as any).histReqs.has(rp) && !p.rec.ingested.some(m => m.type === "backfill_done" && m.id === "g2-pace") && p.rec.timers.some(t => t.ms === 60_000), "G2 control: 162 pacing → request dropped, chunk re-queued behind a 60 s retry (not declined)");
  p.clock.nowMs += 61_000;
  runDue(p, ms => ms === 60_000);
  const bf = p.ib.of("reqHistoricalData").filter(x => x.args[0] >= BACKFILL_REQ_BASE);
  assert(bf.length === 2 && bf[1].args[0] !== rp && bf[1].args[2] === bf[0].args[2] && bf[1].args[3] === bf[0].args[3], "G2 control: …the same chunk is re-requested 60 s later under a new reqId");
  assert(/^\d{8}-\d{2}:\d{2}:\d{2}$/.test(bf[0].args[2]) && bf[0].args[2] === ibDateTime(nowS - 600), "G2: backfill endDateTime is IB's explicit-UTC dash form yyyymmdd-HH:MM:SS (never provokes 2174)");
}

console.log("── G3: connectivity recovery after 2110 via farm 'is OK' ──");
{
  const LINK_BROKEN = "Connectivity between Trader Workstation and server is broken. It will be restored automatically.";
  const b = boot(); tick(b);
  b.ib.sys(2110, LINK_BROKEN);
  assert(b.rec.executor!.execute(CMD) === false && (b.bridge.status() as any).connectivity === "lost", "G3: 2110 → connectivity lost, execute false");
  b.ib.sys(2103, "Market data farm connection is broken:usfarm");
  tick(b);
  assert(b.rec.executor!.execute(CMD) === false, "G3: 2103 '…is broken' does NOT restore");
  b.ib.sys(2104, "Market data farm connection is OK:usfarm");
  assert((b.bridge.status() as any).connectivity === "ok" && b.rec.logs.some(l => /2104 farm OK after 2110/.test(l)), "G3: 2104 '…is OK' after a 2110 → connectivity ok (logged)");
  tick(b);
  assert(b.rec.executor!.execute(CMD) === true && b.ib.count("placeOrder") === 3, "G3: …+ a fresh tick → execute true, bracket placed");
  const cases: Array<[number, string]> = [[2106, "HMDS data farm connection is OK:ushmds"], [2158, "Sec-def data farm connection is OK:secdefnj"]];
  for (const [code, text] of cases) {
    const x = boot(); tick(x);
    x.ib.sys(2110, LINK_BROKEN);
    x.ib.sys(code, text);
    tick(x);
    assert(x.rec.executor!.execute(CMD) === true, `G3: 2110 → ${code} '…is OK' + tick → execute true`);
  }
  // A 1100 (IB ↔ Gateway) loss is only cleared by 1101/1102 — IB always sends one for that link.
  const y = boot(); tick(y);
  y.ib.sys(1100, "Connectivity between IB and Trader Workstation has been lost.");
  y.ib.sys(2104, "Market data farm connection is OK:usfarm");
  tick(y);
  assert(y.rec.executor!.execute(CMD) === false, "G3: a 1100 loss is NOT cleared by a farm '…is OK'");
  y.ib.sys(1102, "Connectivity between IB and Trader Workstation has been restored - data maintained.");
  tick(y);
  assert(y.rec.executor!.execute(CMD) === true, "G3: …1102 + tick clears it");
}

console.log("── G3/F3 wiring: system messages arrive on EventName.info (real @stoqey/ib decoder) ──");
{
  const b = boot();
  assert(b.ib.listenerCount("info") === 1, "wiring: the bridge subscribes to EventName.info (IB's id -1 system messages)");
  // Library contract: feed raw ERR_MSG frames through a REAL IBApi's decoder (never connected —
  // no socket, no network). Pins the routing the bridge depends on across library upgrades.
  const real = new IBApi({ port: 1 });
  const ctl = (real as any).controller;
  const frame = (id: number, code: number, msg: string) => { ctl.onMessage(["4", "2", String(id), String(code), msg]); ctl.processIngressQueue(); };
  const seen: Array<[string, number, number | null]> = [];
  real.on("info", (_m: string, code: number) => seen.push(["info", code, null]));
  real.on("error", (_e: Error, code: number, id: number) => seen.push(["error", code, id]));
  for (const code of [1100, 1101, 1102, 2110, 2104, 2106, 2158]) frame(-1, code, `system ${code}`);
  frame(101, 201, "Order rejected");
  assert(eq(seen.slice(0, 7).map(x => x[0]), ["info", "info", "info", "info", "info", "info", "info"]), "library: 1100/1101/1102/2110/2104/2106/2158 with id -1 → EventName.info (never 'error')");
  assert(eq(seen[7], ["error", 201, 101]), "library: an order/request id → EventName.error (code, reqId)");
  real.removeAllListeners();
  // End-to-end: the real decoder's events piped into the bridge's api (the bridge's own listeners).
  const pipe = (x: ReturnType<typeof boot>) => {
    real.removeAllListeners();
    real.on("info", (...a: any[]) => { x.ib.emit("info", ...a); });
    real.on("error", (...a: any[]) => { x.ib.emit("error", ...a); });
  };
  const LINK = "Connectivity between Trader Workstation and server is broken. It will be restored automatically.";
  const e = boot(); pipe(e); tick(e);
  frame(-1, 2110, LINK);
  assert(e.rec.executor!.execute(CMD) === false && (e.bridge.status() as any).connectivity === "lost", "real decoder: 2110 → connectivity lost, execute false");
  frame(-1, 2104, "Market data farm connection is OK:usfarm");
  assert((e.bridge.status() as any).connectivity === "ok" && e.rec.logs.some(l => /2104 farm OK after 2110/.test(l)), "real decoder: 2104 '…is OK' after 2110 → connectivity ok (logged)");
  tick(e);
  assert(e.rec.executor!.execute(CMD) === true && e.ib.count("placeOrder") === 3, "real decoder: …+ a fresh tick → execute true, bracket placed");
  const f = boot(); pipe(f); tick(f);
  frame(-1, 1100, "Connectivity between IB and Trader Workstation has been lost.");
  assert(f.rec.executor!.execute(CMD) === false && f.ib.count("placeOrder") === 0 && f.rec.notes.some(x => x.type === "ibkr_bridge" && /lost its connection/.test(x.title)), "real decoder (F3): 1100 → execute false + push/Discord note");
  frame(-1, 1101, "Connectivity between IB and Trader Workstation has been restored - data lost.");
  assert(f.ib.count("cancelTickByTickData") === 1 && f.ib.count("reqTickByTickData") === 2 && (f.bridge.status() as any).connectivity === "ok", "real decoder (F3): 1101 → connectivity ok + resubscribe");
  tick(f);
  assert(f.rec.executor!.execute(CMD) === true, "real decoder (F3): …+ a fresh tick → execute true");
  const g = boot(); pipe(g); tick(g);
  frame(-1, 1100, "Connectivity between IB and Trader Workstation has been lost.");
  frame(-1, 1102, "Connectivity between IB and Trader Workstation has been restored - data maintained.");
  tick(g);
  assert(g.rec.executor!.execute(CMD) === true && g.ib.count("reqTickByTickData") === 1, "real decoder (F3): 1100 → 1102 + tick → execute true, no resubscribe");
  // 501 "Cannot connect if already connected" is library-local — logged, never an error state.
  const h = boot(); h.ib.emit("info", "Cannot connect if already connected.", 501);
  assert((h.bridge.status() as any).lastError == null && h.rec.logs.some(l => /IB 501/.test(l)), "info 501 (library-local) → logged only, lastError untouched");
  real.removeAllListeners();
}

console.log("── G4: the historical no-answer timer measures SILENCE, not duration ──");
{
  const b = boot();
  const nowS = sec(NOW), M = nowS - (nowS % 60);
  for (let k = 0; k < 9; k++) { // a row every 20 s for 3 minutes (a slow 2-day opening batch)
    b.clock.nowMs += 20_000;
    ROW(b.ib, BARS_REQ_ID, M - 3000 + 60 * k);
    runDue(b, ms => ms === HIST_TIMEOUT_MS);
  }
  const liveReqs = () => b.ib.of("reqHistoricalData").filter(c => c.args[0] === BARS_REQ_ID).length;
  assert(!b.ib.of("cancelHistoricalData").some(c => c.args[0] === BARS_REQ_ID) && liveReqs() === 1 && (b.bridge.status() as any).stats.histTimeouts === 0, "G4: live batch streaming a row every 20 s for 3 min → never cancelled");
  b.clock.nowMs += 59_000;
  runDue(b, ms => ms === HIST_TIMEOUT_MS);
  assert(!b.ib.of("cancelHistoricalData").some(c => c.args[0] === BARS_REQ_ID), "G4: 59 s of silence after the last row → still waiting");
  b.clock.nowMs += 2_000;
  runDue(b, ms => ms === HIST_TIMEOUT_MS);
  assert(b.ib.of("cancelHistoricalData").some(c => c.args[0] === BARS_REQ_ID) && liveReqs() === 2 && (b.bridge.status() as any).stats.histTimeouts === 1, "G4: 61 s of silence after the last row → timeout as before (cancel + re-request)");
  // Backfill chunk streaming slowly.
  const c = boot();
  FINISHED(c.ib, BARS_REQ_ID);
  c.rec.attached[0].link.send(JSON.stringify({ type: "backfill", id: "g4-bf", fromMs: (nowS - 3600) * 1000, toMs: (nowS - 600) * 1000 }));
  const rq = c.ib.last("reqHistoricalData").args[0];
  for (let k = 0; k < 9; k++) {
    c.clock.nowMs += 20_000;
    ROW(c.ib, rq, nowS - 3600 + 60 * k);
    runDue(c, ms => ms === HIST_TIMEOUT_MS);
  }
  FINISHED(c.ib, rq);
  const done = c.rec.ingested.find(m => m.type === "backfill_done" && m.id === "g4-bf");
  assert(done && !done.declined && done.count === 9 && !c.ib.of("cancelHistoricalData").some(x => x.args[0] === rq) && (c.bridge.status() as any).stats.histTimeouts === 0, "G4: backfill chunk streaming for 3 min → answered with all 9 rows (no timeout, no decline)");
}

console.log("── G5: in-flight backfill at a contract roll ──");
{
  const pre = Date.UTC(2026, 11, 13, 12, 0, 0); // Sun 12-13: Z6 still front (the 4-d roll flips at 00:00 ET 12-14)
  const b = boot({}, [], { nowMs: pre });
  assert((b.bridge.status() as any).contract.rawSymbol === "MESZ6", "G5 setup: MESZ6 is front on 12-13");
  FINISHED(b.ib, BARS_REQ_ID);
  const link = b.rec.attached[0].link;
  const from = sec(Date.UTC(2026, 11, 11, 14)), to = sec(Date.UTC(2026, 11, 12, 20)); // 30 h → two 1-day chunks
  link.send(JSON.stringify({ type: "backfill", id: "g5-a", fromMs: from * 1000, toMs: to * 1000 }));
  const r1 = b.ib.last("reqHistoricalData").args[0];
  for (let t = from; t < from + 600; t += 60) ROW(b.ib, r1, t);
  FINISHED(b.ib, r1);
  const r2 = b.ib.last("reqHistoricalData").args[0];
  assert(r2 !== r1 && (b.bridge as any).histReqs.has(r2), "G5 setup: chunk 1 answered (10 bars held), chunk 2 in flight");
  link.send(JSON.stringify({ type: "backfill", id: "g5-b", fromMs: Date.UTC(2026, 11, 12, 21), toMs: Date.UTC(2026, 11, 12, 22) }));
  assert((b.bridge.status() as any).subscriptions.backfill.queued === 2, "G5 setup: a second job queued behind it");
  // Roll Z6 → H7.
  b.clock.nowMs = Date.UTC(2026, 11, 14, 12, 0, 0);
  (b.bridge as any).resolveContract(); answerContracts(b.ib);
  assert((b.bridge.status() as any).contract.rawSymbol === "MESH7", "G5: rolled to MESH7");
  assert(b.ib.of("cancelHistoricalData").some(c => c.args[0] === r2) && !(b.bridge as any).histReqs.has(r2), "G5: the in-flight backfill request is cancelled (cancelHistoricalData + dropped)");
  const bst = (b.bridge.status() as any).subscriptions.backfill;
  assert(bst.queued === 0 && bst.inflight === false, "G5: …queue cleared, nothing in flight");
  assert(!b.rec.ingested.some(m => m.type === "backfill_done" && (m.id === "g5-a" || m.id === "g5-b")), "G5: answers deferred one tick (never re-entering gap-audit's dispatcher)");
  b.runTimers(ms => ms === 0);
  const da = b.rec.ingested.filter(m => m.type === "backfill_done" && m.id === "g5-a");
  const db2 = b.rec.ingested.filter(m => m.type === "backfill_done" && m.id === "g5-b");
  assert(da.length === 1 && da[0].declined === true && da[0].reason === "roll" && da[0].count === 0 && da[0].source === "ibkr", "G5: the in-flight job → backfill_done {declined:true, reason:'roll', count:0}");
  assert(db2.length === 1 && db2[0].declined === true && db2[0].reason === "roll" && db2[0].count === 0, "G5: the queued job → declined 'roll' too");
  assert(!b.rec.ingested.some(m => m.type === "bulk_bars" && (m.id === "g5-a" || m.id === "g5-b")), "G5: the 10 old-month bars already held are NEVER emitted");
  ROW(b.ib, r2, from + 86400); FINISHED(b.ib, r2);
  assert(!b.rec.ingested.some(m => m.type === "bulk_bars" && m.id === "g5-a") && b.rec.ingested.filter(m => m.type === "backfill_done" && m.id === "g5-a").length === 1, "G5: stragglers from the cancelled request are ignored (no bars, no second answer)");
  // Later requests are served under the NEW contract's era floor (the switch instant).
  FINISHED(b.ib, BARS_REQ_ID);
  // H7 era = max(switch instant 12-14 12:00Z, seeded 00:00 ET 12-15 = Z6 expiry − 4 d + 1 d margin).
  assert(b.bridge.eraStartSec() === sec(Date.UTC(2026, 11, 15, 5)), "G5: new era floor = 00:00 ET 2026-12-15 (seed, later than the 12-14 switch)");
  b.clock.nowMs = Date.UTC(2026, 11, 15, 16, 0, 0);
  link.send(JSON.stringify({ type: "backfill", id: "g5-old", fromMs: Date.UTC(2026, 11, 13, 10), toMs: Date.UTC(2026, 11, 13, 11) }));
  b.runTimers(ms => ms === 0);
  assert(b.rec.ingested.some(m => m.type === "backfill_done" && m.id === "g5-old" && m.declined === true && m.reason === "era"), "G5: a pre-roll range (Z6's era) is declined 'era' after the roll");
  link.send(JSON.stringify({ type: "backfill", id: "g5-new", fromMs: Date.UTC(2026, 11, 15, 13), toMs: Date.UTC(2026, 11, 15, 14) }));
  const rn = b.ib.last("reqHistoricalData");
  assert(rn.args[0] >= BACKFILL_REQ_BASE && rn.args[1].conId === 333, "G5: a post-roll range is requested on the H7 conId");
  for (let t = sec(Date.UTC(2026, 11, 15, 13)); t <= sec(Date.UTC(2026, 11, 15, 14)); t += 60) ROW(b.ib, rn.args[0], t);
  FINISHED(b.ib, rn.args[0]);
  const dn = b.rec.ingested.find(m => m.type === "backfill_done" && m.id === "g5-new");
  const bn = b.rec.ingested.filter(m => m.type === "bulk_bars" && m.id === "g5-new");
  assert(dn && !dn.declined && dn.count === 61 && bn.length === 1 && bn[0].symbol === "MESH7", "G5: …and answered with its bars under MESH7");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("── live-bars: order-executor registry + in-process study ingest (temp DB) ──");
async function liveBarsTests() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ibkr-bridge-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.BAXTER_ARTIFACTS_DIR = tmp;
  const lb = await import("../server/live-bars");
  const mw = await import("../server/mw-reader");
  assert(lb.isOrderCommandSocketOpen() === false && lb.getOrderExecutor() === null, "no executor, no sockets → not connected");
  assert(lb.broadcastOrderCommand({ type: "reset_flag" }) === false, "no executor → command not sent (today's behaviour)");
  const seen: any[] = [];
  let ready = true;
  lb.registerOrderExecutor({ name: "test-exec", isReady: () => ready, execute: c => { seen.push(c); return true; } });
  assert(lb.isOrderCommandSocketOpen() === true, "registered + ready executor → isOrderCommandSocketOpen() true (/api/trade/status connected)");
  const cmd = { type: "order_command", symbol: "MES", direction: "Long", interval: "15m", riskLevel: "safe", price: 7685, tp1: 7695.5, tp2: 7695.5, sl: 7659, contracts: 1, tp1Only: true };
  assert(lb.broadcastOrderCommand(cmd) === true && seen.length === 1 && seen[0].tp1 === 7695.5, "broadcastOrderCommand routes order_command to the executor and returns true");
  assert(lb.broadcastOrderCommand({ type: "reset_flag" }) === true && seen[1].type === "reset_flag", "reset_flag routes to the executor too");
  ready = false;
  assert(lb.isOrderCommandSocketOpen() === false && lb.broadcastOrderCommand(cmd) === false && seen.length === 2, "executor not ready → falls through to the (absent) sockets → false");
  lb.registerOrderExecutor(null);
  assert(lb.getOrderExecutor() === null && lb.isOrderCommandSocketOpen() === false, "unregister → back to sockets-only");
  assert(lb.ingestAutoTraderEvent({ type: "order_queued", direction: "Long", entry: 7685, queued: 1 }) === true, "ingestAutoTraderEvent accepts a known event type");
  assert(lb.ingestAutoTraderEvent({ type: "bogus" }) === false, "…and rejects an unknown one");
  const link = { readyState: 1, send: () => {} } as unknown as import("ws").WebSocket;
  const ctx = lb.attachInProcessStudy(link, () => {}, "test-feed");
  assert(mw.isTickRelayConnected() === true, "attachInProcessStudy flips tickRelayConnected (yahoo-live yields, like a study connect)");
  lb.ingestStudyMessage({ type: "tick", symbol: "MESZ6", price: 7685.25, time: Date.now() }, ctx);
  assert(mw.getLastTickPrice("MES") === 7685.25, "a raw month-coded tick lands under the normalized MES key in mw-reader (contract-guard + bars fed)");
  lb.detachInProcessStudy(ctx);
  assert(mw.isTickRelayConnected() === false, "detach with no other feed → tickRelayConnected false");

  // F2 (2026-09-23): a POLICY-declined backfill_done never lands in unfillable_ranges; a plain
  // count-0 answer still does after two tries (the MotiveWave path is unchanged).
  const ga = await import("../server/gap-audit");
  const { db } = await import("../server/db");
  // Seed two real bars 3 d and 1 d back so the store has a span with holes in it.
  const ins = (db as any).$client.prepare(`INSERT OR IGNORE INTO cached_candles (symbol, resolution, timestamp, open, high, low, close, volume) VALUES ('MES','1',?,7680,7690,7670,7685,10)`);
  const nowWall = Math.floor(Date.now() / 1000);
  ins.run(nowWall - (nowWall % 60) - 3 * 86400); ins.run(nowWall - (nowWall % 60) - 86400);
  const sent: any[] = [];
  const blink = { readyState: 1, send: (d: string) => { sent.push(JSON.parse(d)); } } as unknown as import("ws").WebSocket;
  const bctx = lb.attachInProcessStudy(blink, () => {}, "ibkr-test");
  lb.ingestStudyMessage({ type: "hello", symbol: "MESZ6", resolution: "1", ver: 2, source: "ibkr" } as any, bctx);
  const settle = () => new Promise<void>(r => setTimeout(r, 30));
  await settle(); await settle(); // the whole-history audit runs on its own async chain
  const answer = (req: any, declined: boolean) => lb.ingestStudyMessage({ type: "backfill_done", id: req.id, count: 0, earliestAvailableMs: 0, source: "ibkr", ...(declined ? { declined: true, reason: "era" } : {}) } as any, bctx);
  const deep = sent.find(r => r.fromMs === 0);
  assert(!!deep, "hello on an empty store → deep probe dispatched first");
  let declinedReq: any = null;
  let answered = 0;
  for (let guard = 0; guard < 400; guard++) {
    const req = sent.shift();
    if (!req) { await settle(); if (!sent.length) break; continue; }
    answered++;
    if (req.fromMs === 0) { answer(req, true); continue; } // deep probe declined → no provider_cap row
    if (!declinedReq) { declinedReq = req; answer(req, true); continue; } // first gap range → declined
    answer(req, false); // everything else: MW-style empty answers
  }
  const unf = (db as any).$client.prepare(`SELECT from_ts, to_ts, reason FROM unfillable_ranges WHERE symbol='MES' AND resolution='1'`).all() as Array<{ from_ts: number; to_ts: number; reason: string }>;
  assert(!!declinedReq && answered >= 3, `the study was asked for the deep probe + ${answered - 1} gap range(s)`);
  const dFrom = Math.floor(declinedReq.fromMs / 1000), dTo = Math.floor(declinedReq.toMs / 1000);
  assert(!unf.some(u => u.from_ts === dFrom && u.to_ts === dTo), "declined:true answer → the range is NOT written to unfillable_ranges (not 'no_data')");
  assert(!unf.some(u => u.reason === "provider_cap"), "declined deep probe → no provider_cap claim");
  assert(unf.some(u => u.reason === "no_data"), "control: a plain count-0 answer twice still marks no_data (MotiveWave path unchanged)");
  const offered = ga.takeStudyDeclined("MES", "1");
  assert(offered.length === 1 && offered[0].fromTs === dFrom && offered[0].toTs === dTo, "takeStudyDeclined hands exactly the declined gap range to gap-heal (deep probe excluded)");
  assert(ga.takeStudyDeclined("MES", "1").length === 0, "…and clears it");
  const before = sent.length;
  ga.requestGapSweep("MES", "1");
  assert(!sent.slice(before).some(r => Math.floor(r.fromMs / 1000) === dFrom), "a re-sweep does NOT re-ask the study for the declined range (6 h skip)");
  assert(ga.takeStudyDeclined("MES", "1").some(r => r.fromTs === dFrom), "…it is re-offered to gap-heal's Yahoo path instead");
  lb.detachInProcessStudy(bctx);
}

liveBarsTests()
  .catch(e => { failures.push(`live-bars tests threw: ${e?.stack ?? e}`); console.error(e); })
  .finally(() => {
    assert(mockFidelity.length === 0, `mock fidelity: no IB system code emitted on 'error' with id -1${mockFidelity.length ? ` — ${mockFidelity.join('; ')}` : ""}`);
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.error(failures.join("\n"));
    // live-bars' import graph (gap-audit) arms module-level intervals — exit explicitly.
    process.exit(failures.length ? 1 : 0);
  });
