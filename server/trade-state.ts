/**
 * Shared auto-trade settings and push token registry.
 * Imported by both routes.ts and discord-reader.ts to avoid circular deps.
 */
import { db } from "./db";
// CONTRACT GUARD (2026-09-18): tracked brackets are priced in MOTIVEWAVE's contract; while the
// guard says off-contract every price this server can see (Yahoo's bars, the translated live
// tick) is in the FRONT month's basis — see refreshActivesWithPrice. No import cycle:
// contract-guard statically imports only ./db (its live modules are lazy imports inside the
// flip handler), and nothing it imports reaches back here.
import { isMwOffContract } from "./contract-guard";
// NEWS BLACKOUT (2026-10-01, R3): pure calendar module — imports only fs/path/@shared, no cycle.
import { blackoutReason } from "./news-blackout";

export type ExitStrategy = 'current' | 'tight' | 'standard' | 'wide';

// Exit profile TP/SL pts by strategy → tier
const EXIT_STRAT: Record<string, Record<string, { tp1: number; tp2: number; sl: number }>> = {
  tight:    { safe: { tp1: 12.5, tp2: 25.0, sl: 4.0 }, risky: { tp1:  9.0, tp2: 20.0, sl: 5.5 } },
  standard: { safe: { tp1: 10.0, tp2: 20.0, sl: 5.0 }, risky: { tp1:  7.5, tp2: 17.0, sl: 6.5 } },
  wide:     { safe: { tp1: 16.0, tp2: 30.0, sl: 10.0 }, risky: { tp1: 12.0, tp2: 25.0, sl: 12.0 } },
};

/** Compute exit levels for a given strategy + signal tier + direction + entry price. */
export function resolveExits(
  strategy: ExitStrategy,
  tier: 'safe' | 'risky',
  isLong: boolean,
  entry: number,
): { tp1: number; tp2: number; sl: number } {
  if (strategy === 'current') {
    return {
      tp1: isLong ? entry + 10 : entry - 10,
      tp2: isLong ? entry + 20 : entry - 20,
      sl:  isLong ? entry -  5 : entry +  5,
    };
  }
  const e = EXIT_STRAT[strategy]?.[tier] ?? EXIT_STRAT.standard.safe;
  return {
    tp1: isLong ? entry + e.tp1 : entry - e.tp1,
    tp2: isLong ? entry + e.tp2 : entry - e.tp2,
    sl:  isLong ? entry - e.sl  : entry + e.sl,
  };
}

export interface AutoTradeSettings {
  enabled: boolean;
  contracts: number;
  tp1Only: boolean;
  direction: 'both' | 'long' | 'short';
  contractType: 'MES' | 'ES';
  riskLevels: string[];
  intervals: string[];
  exitStrategy: ExitStrategy;
  /** SIGNAL-INTEGRITY (A4): push notifications for third-party Discord-PARSED signals.
   *  DEFAULT OFF — Discord signals are display-only and must never look like engine signals. */
  discordPushEnabled: boolean;
  /** ONE-POSITION GATE (2026-08-14): when true, an open position blocks all new orders until
   *  its TP/SL trades. DEFAULT FALSE by explicit user decision the same day ("i just want all
   *  trades to fire... nothing blocking any trades") — the user chose trade flow over position
   *  protection with full knowledge that opposite-direction signals NET (close the open
   *  position at market — observed 2026-08-13 21:00 ET) and same-direction signals stack size. */
  positionGate: boolean;
  /** SAME-DIRECTION-ONLY GATE (2026-08-14, the user's refinement an hour later: "only send
   *  the same direction signals at the same time. if a long is active and a short comes dont
   *  fire and vise versa"). DEFAULT TRUE. Same-direction signals stack as independent
   *  brackets; an opposite-direction signal is withheld while ANY tracked trade is active
   *  (netting against live brackets is never what the user means by a new trade). */
  sameDirectionOnly: boolean;
  /** APEX GUARDS (2026-08-18, user: "is there any way you can help prevent it" — after the
   *  12:22 PM Rithmic auto-liquidation: 25 stacked MES, ~8 pts adverse, −$1,042.50, account
   *  "done for day"). All three are ORDER-side only — signals/records fire unchanged. */
  /** Max TOTAL contracts across all tracked open trades (new order blocked when the sum
   *  would exceed it). 0 or negative = unlimited. Default 10 micros = 1 ES equivalent —
   *  would have stopped today's stack at 10 instead of 25. */
  maxNetContracts: number;
  /** Trailing-threshold guard: pause ORDERS when the session's auto-trade equity has fallen
   *  within `apexGuardMarginDollars` of `apexHeadroomDollars` below its intraday PEAK —
   *  mirroring Apex's intraday trailing liquidation (floor = peak − threshold, ratchets up
   *  with OPEN profit, never down). Headroom = the account's CURRENT distance to its
   *  liquidation threshold (RTrader "Auto Liquidate Threshold"); update it each morning —
   *  the guard's session tracker only sees trades this program placed. */
  apexGuardEnabled: boolean;
  /** APEX 25K (2026-10-01, owner: "my account now is a 25000 with a 1500 target"). $1,500 is
   *  the PROFIT TARGET, not the threshold. Apex's current 25K plans (Intraday Trailing and EOD
   *  evaluations, help center read 2026-10-01) trail a $1,000 max drawdown; only the retired
   *  LEGACY 25K had a $1,500 threshold. Default = $1,000 because it is safe under BOTH (a
   *  legacy account just gets a tighter seatbelt). The first round shipped 1500 — under a
   *  current plan that pauses at exactly $1,000 used = the liquidation point (zero protection).
   *  $/pt (MES = $5/pt per micro): $1,000 / $5 = 200 pts at 1 micro, 100 at 2. Orders pause at
   *  headroom − margin = $500 used → 100 pts at 1 MES / 50 pts at 2 MES. Owner: set 1500 only
   *  if RTrader shows a legacy $1,500 threshold. */
  apexHeadroomDollars: number;
  apexGuardMarginDollars: number;
  /** ACCOUNT CARRY-OVER (2026-10-01, verifier: "per-day tracker vs lifetime threshold"): when
   *  true (DEFAULT) the guard ALSO keeps an account tracker that does NOT roll at 09:25 — a
   *  losing day's drawdown carries into the next day exactly like Apex's lifetime-anchored
   *  trailing threshold (an evaluation's threshold never locks). Before this, the tracker
   *  zeroed every morning, so a −$1,040 day was followed by a fresh $1,000 allowance on an
   *  account that had $460 (legacy) or nothing (current plan) left. The account tracker is
   *  re-anchored ONLY by POST /api/trade/guard/reset (Settings: "Reset guard tracker") — do that
   *  after setting apexHeadroomDollars to RTrader's REAL distance-to-threshold. false = the
   *  2026-08-20 per-RTH-day tracker only. */
  apexGuardCarryOver: boolean;
  /** DAILY LOSS PAUSE (2026-10-01): pause new orders once the RTH guard day's net (realized +
   *  open mark) reaches −$N. 0 = OFF (DEFAULT — the plan type is unconfirmed). For an Apex EOD
   *  25K (DLL $500, counts open losses, a hit ends the session) set it BELOW the DLL by about
   *  one open trade's stop, e.g. 300. The guard day rolls 09:25 ET (Apex's trading day is
   *  18:00–16:59 ET; identical while orders are RTH-only). */
  apexDailyLossLimitDollars: number;
  /** Settings-profile tag (2026-10-01). A persisted trade_settings row whose tag differs (every
   *  pre-25K row has none) is from a different account: its apexHeadroomDollars /
   *  apexGuardMarginDollars are NOT hydrated — the 25K code defaults stand (the 50K-era stored
   *  $2,500 would otherwise override them forever: hydration is Object.assign(saved)). The next
   *  POST /api/trade/settings persists the new tag, after which the owner's values are kept. */
  apexGuardProfile: string;
  /** LATE ENTRY AT LEVEL (2026-08-20, user: "if theres a catch up signal and it comes back to
   *  the same price level and the signal still shows that it will hit, make the trade through
   *  the auto trader"): signals persisted too late for the fresh-fire window (catch-up
   *  backfills, missed boundaries) become resting entry intents — when the live price returns
   *  within `lateEntryTolerancePts` of the ORIGINAL entry and neither the TP nor the SL has
   *  traded since the signal's entry bar, the order fires with the original bracket. Every
   *  order gate (intervals, direction, sameDirectionOnly, net-contract cap, Apex guard, claim
   *  dedup) applies unchanged; the 15:15–17:00 ET no-new-orders window is respected. Honest
   *  limit: a time-shifted fill at the same level rides a different path than the book's
   *  entry-bar fill — this closes the record-vs-account gap, it cannot make them identical. */
  lateEntryEnabled: boolean;
  lateEntryTolerancePts: number;
  lateEntryMaxAgeMin: number;
  /** ORDER-HOURS WINDOW (2026-08-20, user-approved after the ETH study): real orders fire
   *  ONLY inside these ET windows. Signals/records fire 24/5 regardless — only ORDERS respect
   *  the clock (note: ALL auto-trader orders, sim included — the server cannot see which
   *  account MW points at; flip orderHoursEnabled off any night you want the sim executing).
   *  RTH-ONLY DEFAULT (2026-10-01, owner-approved R1): the default is 09:30–15:15 ET only. The
   *  2026-08-20 European-morning window (04:00–07:30, "PF ~4") was REMOVED: the 2026-10-01
   *  overnight research found the hour profile regime-unstable (it flipped between books and
   *  months), the ETH sleeve negative in every population, and on Apex an overnight loss spends
   *  the RTH day's loss limit (trading day 18:00–16:59 ET). See LEARNINGS 2026-10-01. */
  orderHoursEnabled: boolean;
  orderWindows: Array<{ start: string; end: string }>; // ET "HH:MM" half-open [start,end)
  /** MUTE OVERNIGHT ALERTS (2026-10-01, owner-approved R2a): when false (DEFAULT), fires whose
   *  bar CLOSES in the ETH session (America/New_York, shared/firing/session isRTH — the engine's
   *  own classification) send no Discord alert (POST /api/discord/send → {ok:true, muted:"eth"})
   *  and the tab skips its desktop notification/sound; the rows are badged "overnight · record
   *  only". Records still fire and persist 24/5. Order-side events (trade-notify) are unaffected. */
  ethAlertsEnabled: boolean;
  /** SCHEDULED-NEWS BLACKOUT (2026-10-01, owner-approved R3, applied to ORDERS now): inside the
   *  data/news-calendar.json windows (08:25–08:40 on 08:30-print days, 09:55–10:05 on 10:00-print
   *  days, 13:55–14:30 on FOMC statement days — server/news-blackout.ts) orderHoursGateReason
   *  refuses ("news blackout: CPI 08:30") and fire alerts are muted ({muted:"news"}). DEFAULT
   *  TRUE. Independent of orderHoursEnabled. The engine-level NEWS_BLACKOUT stays OFF. */
  newsBlackoutEnabled: boolean;
}

export const tradeSettings: AutoTradeSettings = {
  enabled: false,
  contracts: 1,
  tp1Only: false,
  direction: 'both',
  contractType: 'MES',
  riskLevels: ['safe'],
  intervals: ['1m', '5m', '15m', '60m'],
  exitStrategy: 'standard',
  discordPushEnabled: false,
  positionGate: false,     // user decision 2026-08-14 — see the interface doc
  sameDirectionOnly: true, // user refinement 2026-08-14 — see the interface doc
  maxNetContracts: 10,        // 2026-08-18 Apex guards — see the interface doc
  apexGuardEnabled: true,     // APEX 25K (2026-10-01): $1,000 trailing drawdown (current plans); pause at $500 remaining
  apexHeadroomDollars: 1000,  // MES $5/pt: 200 pts at 1 micro, 100 at 2 (orders pause after $500 = 100 / 50 pts)
  apexGuardMarginDollars: 500,
  apexGuardCarryOver: true,   // 2026-10-01: losing days carry into the next (lifetime-anchored threshold)
  apexDailyLossLimitDollars: 0, // 2026-10-01: OFF until the plan type is confirmed (EOD 25K: set ~300)
  apexGuardProfile: "", // set just below (APEX_GUARD_PROFILE)
  lateEntryEnabled: true,      // 2026-08-20 user directive — see the interface doc
  lateEntryTolerancePts: 1.0,  // fill when price is back within 1 pt of the original entry
  lateEntryMaxAgeMin: 360,     // don't chase signals older than 6h (order-claim TTL bound)
  orderHoursEnabled: true,     // 2026-08-20 ETH-study ship — see the interface doc
  orderWindows: [{ start: "09:30", end: "15:15" }], // RTH-only default (2026-10-01 R1) — see the interface doc
  ethAlertsEnabled: false,     // 2026-10-01 R2a — overnight fires are record-only
  newsBlackoutEnabled: true,   // 2026-10-01 R3 — owner approved applying it to orders now
};

/** Current account profile (see AutoTradeSettings.apexGuardProfile). Bump it whenever the
 *  owner switches Apex account size so a stored headroom from the old account can't survive. */
export const APEX_GUARD_PROFILE = "apex-25k-2026-10-01";
tradeSettings.apexGuardProfile = APEX_GUARD_PROFILE;

/** PURE: the persisted row as it may be hydrated. Drops the account-specific guard dollars of
 *  a row from another profile (exported for scripts/apex-guard.test.ts). */
export function hydratableSettings(saved: Partial<AutoTradeSettings>): { settings: Partial<AutoTradeSettings>; droppedGuardDollars: boolean } {
  const out: Partial<AutoTradeSettings> = { ...saved };
  delete out.apexGuardProfile; // the code's profile always stands
  const foreign = saved.apexGuardProfile !== APEX_GUARD_PROFILE;
  if (foreign) { delete out.apexHeadroomDollars; delete out.apexGuardMarginDollars; }
  return { settings: out, droppedGuardDollars: foreign && (saved.apexHeadroomDollars != null || saved.apexGuardMarginDollars != null) };
}

// HYDRATE persisted settings (2026-08-04) — routes.ts writes app_settings 'trade_settings'
// on every POST. SAFETY: `enabled` is ALWAYS false at boot regardless of what was stored —
// re-arming after a restart is a deliberate human action, never an automatic one.
try {
  const row = db.$client.prepare(`SELECT value FROM app_settings WHERE key='trade_settings'`).get() as { value?: string } | undefined;
  if (row?.value) {
    const saved = JSON.parse(row.value) as Partial<AutoTradeSettings>;
    const h = hydratableSettings(saved);
    Object.assign(tradeSettings, h.settings, { enabled: false });
    if (h.droppedGuardDollars) {
      console.warn(`[trade-settings] APEX PROFILE CHANGE: stored guard dollars (headroom $${saved.apexHeadroomDollars}, margin $${saved.apexGuardMarginDollars}) belong to profile "${saved.apexGuardProfile ?? "(none — pre-25K)"}" — using the ${APEX_GUARD_PROFILE} defaults (headroom $${tradeSettings.apexHeadroomDollars}, margin $${tradeSettings.apexGuardMarginDollars}). Set the real RTrader distance-to-threshold in Settings.`);
    }
    console.log(`[trade-settings] hydrated from app_settings (contracts=${tradeSettings.contracts}, intervals=${tradeSettings.intervals.join(",")}, apex headroom $${tradeSettings.apexHeadroomDollars}/margin $${tradeSettings.apexGuardMarginDollars}, armed=NO — boot-disarmed by design)`);
  }
} catch { /* pre-migration or corrupt row — defaults stand */ }

// ── Current active trade (set when AutoTrade fires, cleared manually or on exit) ──
export interface CurrentTrade {
  symbol: string;
  direction: 'Long' | 'Short';
  interval: string;
  riskLevel: string;
  entry: number;
  tp1: number;
  /** TP1-ONLY policy (2026-08-13): null = one target only — never price-compared when null. */
  tp2: number | null;
  sl: number;
  contracts: number;
  tp1Only: boolean;
  firedAt: number; // unix seconds
  status: 'open' | 'tp1_hit' | 'tp2_hit' | 'sl_hit';
  /** MW RECONCILIATION (2026-08-14): true once the study reported the entry FILLED. An
   *  unconfirmed record is send-time bookkeeping only — the phantom sweep expires it after
   *  UNCONFIRMED_TTL_SEC so a never-placed order can't gate real signals (observed live:
   *  a phantom 5m Long withheld the 12:30 15m Short while the user was flat in MW). */
  confirmed?: boolean;
  /** WRONG-BASIS (2026-09-18): this trade was open while the contract guard said MotiveWave
   *  was OFF-CONTRACT — its entry/tp1/sl are prices of a contract month this server's bars and
   *  ticks may no longer be quoted in. Set once, never cleared: a basis-suspect trade is NEVER
   *  price-resolved again (not during the mismatch, not after the guard recovers — the 1m bars
   *  since its entry include front-month prints ~66 pts away, so the first post-recovery
   *  bar-walk would book the very phantom the freeze exists to stop). It still gates
   *  (conservative) and leaves the active set only through MotiveWave's own order events, the
   *  unconfirmed-record sweep, or POST /api/trade/current/clear. */
  basisSuspect?: boolean;
}

let _currentTrade: CurrentTrade | null = null;
/** MULTI-TRADE TRACKING (2026-08-14, same-direction-only refinement): every ACTIVE bracket,
 *  not just the latest — the direction gate must know about ALL working trades, since
 *  same-direction signals now stack as independent brackets. _currentTrade stays as the
 *  most-recent for display compatibility (/api/trade/current). */
let _activeTrades: CurrentTrade[] = [];
/** PERSISTED (2026-08-14): the open-position records must survive restarts — the gates
 *  protect the user's live positions, and in-memory-only records meant any restart forgot
 *  them (the next signal could then net/close real positions at the broker). */
function persistTrades(): void {
  try {
    const up = db.$client.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    );
    up.run("current_trade", JSON.stringify(_currentTrade));
    up.run("active_trades", JSON.stringify(_activeTrades));
  } catch { /* persistence is best-effort; the in-memory records still govern */ }
}
export function getCurrentTrade(): CurrentTrade | null { return _currentTrade; }
export function getActiveTrades(): CurrentTrade[] { return _activeTrades.filter(t => t.status === "open"); }
export function setCurrentTrade(trade: CurrentTrade): void {
  _currentTrade = trade;
  if (trade.status === "open") _activeTrades.push(trade);
  if (_activeTrades.length > 50) _activeTrades = _activeTrades.slice(-50); // hard sanity cap
  persistTrades();
}
export function clearCurrentTrade(): void { _currentTrade = null; _activeTrades = []; persistTrades(); }
try {
  const rowA = db.$client.prepare(`SELECT value FROM app_settings WHERE key='active_trades'`).get() as { value?: string } | undefined;
  if (rowA?.value && rowA.value !== "null") _activeTrades = (JSON.parse(rowA.value) as CurrentTrade[]).filter(t => t && t.status === "open");
  const row = db.$client.prepare(`SELECT value FROM app_settings WHERE key='current_trade'`).get() as { value?: string } | undefined;
  if (row?.value && row.value !== "null") {
    _currentTrade = JSON.parse(row.value) as CurrentTrade;
    // Legacy seed: a pre-list open record joins the active list once.
    if (_currentTrade?.status === "open" && !_activeTrades.some(t => t.firedAt === _currentTrade!.firedAt && t.direction === _currentTrade!.direction)) {
      _activeTrades.push(_currentTrade);
    }
  }
  if (_activeTrades.length || _currentTrade) {
    console.log(`[trade-state] hydrated ${_activeTrades.length} active trade(s); latest: ${_currentTrade ? `${_currentTrade.direction} ${_currentTrade.symbol} ${_currentTrade.interval} @ ${_currentTrade.entry} (${_currentTrade.status})` : "none"}`);
  }
} catch { /* pre-migration — starts flat */ }

/** Price-touch status inference (shared by GET /api/trade/current and the order gates).
 *  TP1-ONLY aware: tp2 is only consulted when present. Returns the trade's effective status
 *  at `livePrice` WITHOUT mutating state. */
export function inferTradeStatus(trade: CurrentTrade, livePrice: number): CurrentTrade["status"] {
  if (trade.status !== "open") return trade.status;
  // WRONG-BASIS FREEZE (2026-09-18): never compare across contract months — see basisMismatch().
  if (trade.basisSuspect || basisMismatch()) return trade.status;
  const isLong = trade.direction === "Long";
  if (isLong) {
    if (trade.tp2 != null && livePrice >= trade.tp2) return "tp2_hit";
    if (livePrice >= trade.tp1) return "tp1_hit";
    if (livePrice <= trade.sl) return "sl_hit";
  } else {
    if (trade.tp2 != null && livePrice <= trade.tp2) return "tp2_hit";
    if (livePrice <= trade.tp1) return "tp1_hit";
    if (livePrice >= trade.sl) return "sl_hit";
  }
  return "open";
}

/** ONE POSITION AT A TIME (2026-08-14, user rule: "i dont want the program to close positions
 *  on its own unless it hits tp or sl"). Futures accounts NET: an opposite-direction order
 *  flattens the open position at market (observed live 2026-08-13 21:00 ET — a 5m Short
 *  closed the 15m Long fired the same minute), and a same-direction order stacks size.
 *  So while a position is open, EVERY order path must skip new orders. Returns the reason
 *  to skip, or null when flat. Conservative by design: when the price-touch inference
 *  can't prove the bracket filled, we block (missing a trade is acceptable; closing the
 *  user's position is not). */
export function positionGateReason(livePrice: number | null): string | null {
  refreshActivesWithPrice(livePrice);
  const open = getActiveTrades();
  if (!open.length) return null;
  const t = open[0];
  return `position open (${t.direction} ${t.symbol} ${t.interval} @ ${t.entry}${open.length > 1 ? ` +${open.length - 1} more` : ""}) — riding to TP/SL per policy`;
}

/** SAME-DIRECTION-ONLY GATE (2026-08-14 user refinement): an incoming signal in the OPPOSITE
 *  direction of any active trade is withheld (it would net against live brackets); same
 *  direction stacks freely. Returns the skip reason, or null to allow. */
export function oppositeDirectionGateReason(direction: string, livePrice: number | null): string | null {
  refreshActivesWithPrice(livePrice);
  const dirNorm = direction.toLowerCase().startsWith("l") ? "Long" : "Short";
  const conflict = getActiveTrades().find(t => t.direction !== dirNorm);
  if (!conflict) return null;
  return `opposite-direction signal while ${conflict.direction} active (${conflict.symbol} ${conflict.interval} @ ${conflict.entry}) — withheld per same-direction-only policy`;
}

/** MAX-NET-CONTRACTS GATE (2026-08-18 Apex guards): the 12:22 PM liquidation was built from
 *  four stacked 5-lots + singles = 25 MES net — at that size, 12 pts of adverse movement is
 *  a 50K account's ENTIRE $2,500 trailing budget. Caps TOTAL tracked open contracts; the
 *  order that would exceed the cap is withheld (signals/records unaffected). */
export function netContractsGateReason(newContracts: number, livePrice: number | null): string | null {
  const cap = tradeSettings.maxNetContracts;
  if (!(cap > 0)) return null;
  refreshActivesWithPrice(livePrice);
  const open = getActiveTrades();
  const total = open.reduce((a, t) => a + (t.contracts || 1), 0);
  if (total + newContracts <= cap) return null;
  return `net-contract cap: ${total} open + ${newContracts} new > max ${cap} — order withheld (raise maxNetContracts to change)`;
}

// ── APEX TRAILING-THRESHOLD GUARD (2026-08-18) ────────────────────────────────
/** Session-scoped equity tracker over the AUTO-TRADED book only: realized $ from tracked
 *  trade closes + open mark at the live price. Mirrors Apex's intraday trailing mechanics:
 *  the floor sits `apexHeadroomDollars` below the session equity PEAK (open profit counts,
 *  the floor never comes back down); orders pause `apexGuardMarginDollars` before it.
 *  HONEST LIMITS: manual MW trades, fees, and pre-session history are invisible here —
 *  set apexHeadroomDollars to the account's REAL current distance-to-threshold (RTrader
 *  shows it) each morning; the guard is a seatbelt, not the airbag. */
interface ApexGuardState {
  day: string; realized: number; peak: number;
  /** ACCOUNT tracker (2026-10-01): NOT rolled at 09:25 — only resetApexGuard() re-anchors it.
   *  Seeded from the day tracker when an older persisted state lacks it (today's loss carries). */
  acctRealized: number; acctPeak: number; acctSince: string;
}
const dollarsPerPoint = (symbol: string): number => symbol === "ES" ? 50 : 5;
/** GUARD DAY = RTH-anchored (2026-08-20 redesign, user: "i missed a lot of trades because we
 *  were confused since i used the sim account... keep it clear for rth sessions"): the
 *  tracker's day rolls at 9:25 AM ET (just before the open), NOT the 18:00 Globex roll. The
 *  old roll made an evening sim session book into the NEXT morning's tracker — which paused
 *  real RTH orders on sim losses (2026-08-20 incident). Under this key, anything booked in an
 *  evening (deliberate sim runs included) EXPIRES automatically at the next 9:25 roll: every
 *  RTH day starts with a clean tracker. The true account floor still lives in RTrader —
 *  apexHeadroomDollars stays a per-day allowance, not the account's lifetime threshold. */
function etSessionDay(nowSec: number): string {
  const d = new Date(nowSec * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (k: string): string => parts.find(p => p.type === k)?.value ?? "00";
  let y = Number(get("year")), mo = Number(get("month")), day = Number(get("day"));
  if (Number(get("hour")) * 60 + Number(get("minute")) < 9 * 60 + 25) { // pre-9:25 belongs to yesterday's guard day
    const n = new Date(Date.UTC(y, mo - 1, day) - 86400_000);
    y = n.getUTCFullYear(); mo = n.getUTCMonth() + 1; day = n.getUTCDate();
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
let _guard: ApexGuardState = { day: "", realized: 0, peak: 0, acctRealized: 0, acctPeak: 0, acctSince: "" };
try {
  const row = db.$client.prepare(`SELECT value FROM app_settings WHERE key='apex_guard_state'`).get() as { value?: string } | undefined;
  if (row?.value) {
    const saved = JSON.parse(row.value) as Partial<ApexGuardState>;
    _guard = { ..._guard, ...saved };
    const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    _guard.realized = num(_guard.realized); _guard.peak = num(_guard.peak);
    if (!Number.isFinite(saved.acctRealized as number) || !Number.isFinite(saved.acctPeak as number)) {
      // Pre-carry state (2026-10-01 upgrade): the account tracker starts from the stored day —
      // e.g. {day:"2026-10-01", realized:-1040, peak:0} carries the −$1,040 into the next day.
      _guard.acctRealized = _guard.realized; _guard.acctPeak = Math.max(_guard.peak, _guard.realized, 0);
      _guard.acctSince = _guard.day || "";
    }
  }
} catch { /* starts fresh */ }
function persistGuard(): void {
  try {
    db.$client.prepare(`INSERT INTO app_settings (key, value) VALUES ('apex_guard_state', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(_guard));
  } catch { /* best-effort */ }
}
function guardRollIfNewSession(): void {
  const today = etSessionDay(Math.floor(Date.now() / 1000));
  // The DAY tracker rolls; the ACCOUNT tracker (acct*) deliberately does not.
  if (_guard.day !== today) { _guard = { ..._guard, day: today, realized: 0, peak: 0, acctSince: _guard.acctSince || today }; persistGuard(); }
}
/** Called at every tracked-trade close with the exit price actually credited. */
function noteTradeClosed(t: CurrentTrade, status: CurrentTrade["status"]): void {
  guardRollIfNewSession();
  const exitPx = status === "tp1_hit" ? t.tp1 : status === "tp2_hit" ? (t.tp2 ?? t.tp1) : t.sl;
  const dir = t.direction === "Long" ? 1 : -1;
  const pts = (exitPx - t.entry) * dir;
  const dollars = pts * (t.contracts || 1) * dollarsPerPoint(t.symbol);
  _guard.realized += dollars;
  _guard.acctRealized += dollars;
  if (_guard.realized > _guard.peak) _guard.peak = _guard.realized;
  if (_guard.acctRealized > _guard.acctPeak) _guard.acctPeak = _guard.acctRealized;
  persistGuard();
}
/** Order gate: null = allowed; string = withhold reason. Also ratchets the session peak. */
export function apexGuardReason(livePrice: number | null): string | null {
  if (!tradeSettings.apexGuardEnabled) return null;
  guardRollIfNewSession();
  refreshActivesWithPrice(livePrice);
  let openMark = 0;
  // WRONG-BASIS FREEZE (2026-09-18): an open mark of (front-month price − MW-month entry) is
  // ~66 pts × contracts × $5 of fiction — and it would RATCHET the persisted session peak, so
  // the guard would later read the snap-back as a drawdown and pause real orders. No open
  // mark while off-contract, and never for a basis-suspect trade.
  if (livePrice != null && Number.isFinite(livePrice) && !basisMismatch()) {
    for (const t of getActiveTrades()) {
      if (t.basisSuspect) continue;
      const dir = t.direction === "Long" ? 1 : -1;
      openMark += (livePrice - t.entry) * dir * (t.contracts || 1) * dollarsPerPoint(t.symbol);
    }
  }
  const equity = _guard.realized + openMark;
  const acctEquity = _guard.acctRealized + openMark;
  let ratcheted = false;
  if (equity > _guard.peak) { _guard.peak = equity; ratcheted = true; }
  if (acctEquity > _guard.acctPeak) { _guard.acctPeak = acctEquity; ratcheted = true; }
  if (ratcheted) persistGuard();
  const budget = tradeSettings.apexHeadroomDollars - tradeSettings.apexGuardMarginDollars;
  const dayUsed = _guard.peak - equity;
  const acctUsed = _guard.acctPeak - acctEquity;
  if (tradeSettings.apexGuardCarryOver !== false && acctUsed >= budget && acctUsed > dayUsed) {
    return `Apex guard: $${acctUsed.toFixed(0)} below the ACCOUNT peak since ${_guard.acctSince || "?"} (losses carry across days, like Apex's threshold) — within $${tradeSettings.apexGuardMarginDollars} of the $${tradeSettings.apexHeadroomDollars} threshold headroom; orders paused. Check RTrader, set the real headroom, then Reset guard tracker`;
  }
  if (dayUsed >= budget) {
    return `Apex guard: $${dayUsed.toFixed(0)} below the session equity peak — within $${tradeSettings.apexGuardMarginDollars} of the $${tradeSettings.apexHeadroomDollars} threshold headroom; orders paused (they resume if equity recovers)`;
  }
  const dll = Number(tradeSettings.apexDailyLossLimitDollars) || 0;
  if (dll > 0 && -equity >= dll) {
    return `Apex guard: today's net $${equity.toFixed(0)} reached the $${dll} daily loss pause — orders paused for the rest of the guard day (rolls 09:25 ET)`;
  }
  return null;
}
export function apexGuardState(): ApexGuardState & { enabled: boolean; headroom: number; margin: number; carryOver: boolean; dailyLossLimit: number; profile: string } {
  guardRollIfNewSession();
  return {
    ..._guard, enabled: tradeSettings.apexGuardEnabled, headroom: tradeSettings.apexHeadroomDollars, margin: tradeSettings.apexGuardMarginDollars,
    carryOver: tradeSettings.apexGuardCarryOver !== false, dailyLossLimit: Number(tradeSettings.apexDailyLossLimitDollars) || 0, profile: tradeSettings.apexGuardProfile,
  };
}
/** One digest line for the Apex guard (2026-10-01: the 25K settings were never reported). */
export function apexGuardDigestLine(): string {
  const g = apexGuardState();
  if (!g.enabled) return "Apex guard: ⚠️ DISABLED — no drawdown seatbelt on auto-trade orders";
  const budget = g.headroom - g.margin;
  const acctUsed = g.acctPeak - g.acctRealized;
  const warn = g.carryOver && acctUsed >= budget ? " ⚠️ ORDERS PAUSED until the tracker is reset after an RTrader check" : "";
  return `Apex guard: headroom $${g.headroom} / margin $${g.margin} (pause at $${budget} used) · account tracker since ${g.acctSince || "?"}: realized $${g.acctRealized.toFixed(0)}, $${acctUsed.toFixed(0)} below its peak${g.carryOver ? "" : " (carry-over OFF)"} · daily loss pause ${g.dailyLossLimit > 0 ? `$${g.dailyLossLimit}` : "off"}${warn}. Verify headroom against RTrader.`;
}

/** ORDER-HOURS GATE (2026-08-20): null = inside an allowed ET window; string = withhold
 *  reason. Windows are half-open [start,end) in ET wall time; malformed entries are skipped. */
export function orderHoursGateReason(nowSec: number): string | null {
  // NEWS BLACKOUT (2026-10-01 R3): checked FIRST and independent of orderHoursEnabled — a
  // scheduled print inside an allowed window still refuses (e.g. 09:55–10:05 on ISM days).
  const news = newsBlackoutGateReason(nowSec);
  if (news) return news;
  if (!tradeSettings.orderHoursEnabled) return null;
  const windows = Array.isArray(tradeSettings.orderWindows) ? tradeSettings.orderWindows : [];
  if (!windows.length) return null; // no windows configured = no restriction (fail-open by design: an emptied list must not silently kill all trading)
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(nowSec * 1000));
  const get = (k: string): number => Number(parts.find(p => p.type === k)?.value ?? "0");
  const mins = get("hour") * 60 + get("minute");
  const toMins = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  for (const w of windows) {
    const a = toMins(w?.start), b = toMins(w?.end);
    if (a == null || b == null) continue;
    if (mins >= a && mins < b) return null;
  }
  return `outside order hours (${windows.map(w => `${w.start}-${w.end}`).join(", ")} ET) — signal recorded, order withheld`;
}

/** NEWS-BLACKOUT ORDER GATE (2026-10-01 R3): "news blackout: CPI 08:30" inside a calendar
 *  window when tradeSettings.newsBlackoutEnabled, else null. A missing calendar file fails
 *  OPEN (no blackout) — logged once by server/news-blackout.ts. */
export function newsBlackoutGateReason(nowSec: number): string | null {
  if (tradeSettings.newsBlackoutEnabled === false) return null;
  try { return blackoutReason(nowSec); } catch { return null; }
}

/** Morning reset for the Apex-guard tracker (2026-08-20): overnight SIM sessions book into
 *  the same tracker (the server can't see which account MW points at), so a bad sim night
 *  can pause the real day. POST /api/trade/guard/reset zeroes today's tracker AND re-anchors
 *  the account tracker (2026-10-01) — use it after setting apexHeadroomDollars to RTrader's
 *  real distance-to-threshold, or when switching to a fresh account. */
export function resetApexGuard(): ApexGuardState {
  const day = etSessionDay(Math.floor(Date.now() / 1000));
  _guard = { day, realized: 0, peak: 0, acctRealized: 0, acctPeak: 0, acctSince: day };
  persistGuard();
  console.log(`[trade-state] apex guard tracker RESET for ${_guard.day} (manual; account tracker re-anchored)`);
  return { ..._guard };
}

// ── AUTO-DISARM ON REPEATED REJECTIONS (2026-08-18) ──────────────────────────
/** After the liquidation, Apex set the account "done for day" and the engine kept firing
 *  orders at it all afternoon (every one rejected). 3 order_error events inside 10 minutes
 *  now DISARM auto-trade (the protective direction — the arming covenant is untouched) and
 *  the caller notifies. Returns true when this call performed the disarm. */
const _orderErrTs: number[] = [];
export function noteOrderError(): boolean {
  const now = Date.now();
  _orderErrTs.push(now);
  while (_orderErrTs.length && now - _orderErrTs[0] > 10 * 60_000) _orderErrTs.shift();
  if (_orderErrTs.length < 3 || !tradeSettings.enabled) return false;
  tradeSettings.enabled = false;
  _orderErrTs.length = 0;
  try {
    db.$client.prepare(`INSERT INTO app_settings (key, value) VALUES ('trade_settings', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(tradeSettings));
  } catch { /* in-memory disarm still governs */ }
  console.warn(`[trade-state] AUTO-DISARMED — 3 order rejections within 10 min (account locked or broker refusing); re-arm is manual`);
  return true;
}

/** WRONG-BASIS FREEZE (2026-09-18, from the 2026-09-17 phantom close): a tracked bracket's
 *  entry / tp1 / sl are prices in MOTIVEWAVE's contract month. While the contract guard says
 *  off-contract, every price this server holds is in the FRONT month's basis — Yahoo's stored
 *  1m bars, and the live tick once translation shifts it (~+66 pts on the Sep→Dec roll). On
 *  09-17 the bar-walk marked a September Long `tp1_hit` against DECEMBER bars and booked
 *  +$643.75 of phantom P&L into the persisted Apex-guard tracker, while the real position sat
 *  66 pts lower. Comparing across bases is never right, so BOTH touch-inference paths freeze
 *  while off-contract: actives stay exactly as they are until MotiveWave's own order events
 *  (reconcileTradeState — still live, it is the broker's truth). Every trade that was open
 *  during the mismatch is also marked `basisSuspect` (see CurrentTrade) so the freeze outlives
 *  the guard's recovery FOR THAT TRADE — trades fired after recovery resolve normally.
 *  Consequence, deliberately conservative: a frozen active keeps gating (same-direction /
 *  net-contract cap) — and orders are blocked outright while off-contract anyway. The phantom
 *  sweep (unconfirmed records) is time-based, not price-based, and keeps running.
 *  The 2026-09-17 phantom already booked into the guard tracker is NOT touched here — the
 *  guard day rolls at 9:25 ET and takes it along. */
function basisMismatch(): boolean {
  try { return isMwOffContract(); } catch { return false; }
}
/** Mark every open tracked trade basis-suspect (idempotent; persists + logs only on change). */
function markActivesBasisSuspect(): void {
  let n = 0;
  for (const t of _activeTrades) if (t.status === "open" && !t.basisSuspect) { t.basisSuspect = true; n++; }
  // After a restart _currentTrade is a separate object from its twin in the active list.
  if (_currentTrade && _currentTrade.status === "open" && !_currentTrade.basisSuspect) { _currentTrade = { ..._currentTrade, basisSuspect: true }; n++; }
  if (!n) return;
  persistTrades();
  // A frozen trade keeps gating (same-direction-only, net-contract cap) with nothing on screen
  // explaining why orders are withheld — tell the user once, when the freeze is applied.
  import("./trade-notify").then(tn => tn.notifyTradeEvent({ type: "basis_suspect", count: n })).catch(() => {});
  console.warn(`[trade-state] WRONG-BASIS FREEZE: MotiveWave is off-contract — ${_activeTrades.filter(t => t.status === "open").length} open tracked trade(s) marked basis-suspect; their TP/SL will NOT be price-inferred (now or after the guard recovers). MotiveWave's own order events or POST /api/trade/current/clear remove them.`);
}

/** Refresh every active trade against the live price (touch-inference; conservative). */
function refreshActivesWithPrice(livePrice: number | null): void {
  if (basisMismatch()) { markActivesBasisSuspect(); return; } // WRONG-BASIS FREEZE — see basisMismatch()
  if (livePrice == null || !Number.isFinite(livePrice)) return;
  let changed = false;
  _activeTrades = _activeTrades.map(t => {
    if (t.status !== "open" || t.basisSuspect) return t;
    const inferred = inferTradeStatus(t, livePrice);
    if (inferred !== "open") { changed = true; noteTradeClosed(t, inferred); if (_currentTrade?.firedAt === t.firedAt) _currentTrade = { ...t, status: inferred }; return { ...t, status: inferred }; }
    return t;
  });
  if (changed) { _activeTrades = _activeTrades.filter(t => t.status === "open"); persistTrades(); }
}

/** TOUCH-ACCURATE GATE CLEARING (2026-08-14): walk the actual 1m bars since each entry — if
 *  TP or SL truly TRADED at any point (first touch, SL-first ties — the canonical
 *  convention), that bracket filled and it leaves the active set, even if nothing was
 *  polling at that moment. Called by the live engine each pass with its served 1m bars. */
export function refreshCurrentTradeFromBars(bars: Array<{ time: number; high: number; low: number }>): void {
  // WRONG-BASIS FREEZE (2026-09-18): the served 1m bars are Yahoo FRONT-month while off-contract;
  // the brackets are MotiveWave-month prices — this exact walk booked the 09-17 phantom tp1_hit.
  // The live engine calls this every pass, so an open trade is marked within a minute of a trip.
  if (basisMismatch()) { markActivesBasisSuspect(); return; }
  let changed = false;
  _activeTrades = _activeTrades.map(t => {
    // basisSuspect: the bars since this trade's entry include front-month prints from the
    // off-contract window — walking them after recovery would book the same phantom, late.
    if (t.status !== "open" || t.basisSuspect) return t;
    const isLong = t.direction === "Long";
    for (const b of bars) {
      if (b.time < t.firedAt) continue;
      const slHit = isLong ? b.low <= t.sl : b.high >= t.sl;
      const tp1Hit = isLong ? b.high >= t.tp1 : b.low <= t.tp1;
      if (slHit || tp1Hit) {
        const status = slHit ? "sl_hit" as const : "tp1_hit" as const; // SL-first on ties; TP1-only: fully closed
        changed = true;
        noteTradeClosed(t, status);
        if (_currentTrade?.firedAt === t.firedAt) _currentTrade = { ...t, status };
        return { ...t, status };
      }
    }
    return t;
  });
  if (changed) { _activeTrades = _activeTrades.filter(t => t.status === "open"); persistTrades(); }
}

/** MW-EVENT RECONCILIATION (2026-08-14): the study's own events are the ground truth for
 *  what actually exists at the broker. Wired from live-bars' order-commands socket. */
export function reconcileTradeState(msg: { type?: string; entry?: number; direction?: string; reason?: string }): void {
  const near = (a: number | undefined, b: number): boolean => a != null && Math.abs(a - b) <= 2.0;
  switch (msg.type) {
    case "order_filled": {
      // Entry confirmed at MW — the record is real; it gates until its TP/SL resolves.
      const t = _activeTrades.find(x => x.status === "open" && !x.confirmed && (near(msg.entry, x.entry) || msg.entry == null));
      if (t) { t.confirmed = true; persistTrades(); console.log(`[trade-state] entry CONFIRMED by MW: ${t.direction} ${t.interval} @ ${t.entry}`); }
      return;
    }
    case "bracket_flattened": {
      // That bracket's round trip ended (TP/SL leg filled) — it leaves the active set.
      const idx = _activeTrades.findIndex(x => x.status === "open" && near(msg.entry, x.entry));
      if (idx >= 0) {
        const [t] = _activeTrades.splice(idx, 1);
        // Guard accounting: the event doesn't say WHICH leg filled; book it at SL (the
        // protective direction — the bar-walk normally wins this race with the true leg).
        noteTradeClosed(t, "sl_hit");
        if (_currentTrade?.firedAt === t.firedAt) _currentTrade = { ...t, status: "tp1_hit" };
        persistTrades();
        console.log(`[trade-state] bracket flattened at MW — pruned ${t.direction} ${t.interval} @ ${t.entry}`);
      }
      return;
    }
    case "position_closed":     // v21 sends this only when zero brackets remain
    case "orders_cancelled": {  // manual cancel-all at MW
      if (_activeTrades.length) { _activeTrades = []; persistTrades(); console.log(`[trade-state] ${msg.type} from MW — active list cleared`); }
      return;
    }
    case "order_error": {
      // The most recent unconfirmed record's order failed MW-side — it never existed.
      for (let i = _activeTrades.length - 1; i >= 0; i--) {
        if (!_activeTrades[i].confirmed) {
          const [t] = _activeTrades.splice(i, 1);
          persistTrades();
          console.log(`[trade-state] order_error from MW — dropped unconfirmed ${t.direction} ${t.interval} @ ${t.entry}`);
          return;
        }
      }
      return;
    }
  }
}

/** PHANTOM SWEEP (2026-08-14): an active record never confirmed by MW within the TTL is
 *  send-time bookkeeping for an order that never placed (old study version, disconnect,
 *  rejection) — it must not gate real signals. Called by the live engine each pass. */
const UNCONFIRMED_TTL_SEC = 600;
export function sweepUnconfirmedActives(): void {
  const now = Math.floor(Date.now() / 1000);
  const before = _activeTrades.length;
  _activeTrades = _activeTrades.filter(t => t.confirmed || now - t.firedAt <= UNCONFIRMED_TTL_SEC);
  if (_activeTrades.length !== before) {
    persistTrades();
    console.log(`[trade-state] phantom sweep: dropped ${before - _activeTrades.length} unconfirmed active record(s) older than ${UNCONFIRMED_TTL_SEC}s`);
  }
}

// ═════ ONE ORDER AUTHORITY (2026-08-13 server-side live engine) ═════
// Every order path — the server live engine AND the client's POST /api/trade/execute —
// must CLAIM a signal's order key here before broadcasting to MotiveWave. First claim
// wins; the duplicate path no-ops. This is what makes the redundant client path safe
// (an open stale tab can never double-order a signal the server already traded).
// Key: `${symbol}|${interval}|${fireTs}|${direction}`.
const _orderClaims = new Map<string, number>(); // key → claim epoch-sec
const ORDER_CLAIM_TTL_SEC = 6 * 3600;
export function tryClaimOrder(key: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  // opportunistic prune
  if (_orderClaims.size > 500) {
    for (const [k, t] of _orderClaims) if (now - t > ORDER_CLAIM_TTL_SEC) _orderClaims.delete(k);
  }
  if (_orderClaims.has(key)) return false;
  _orderClaims.set(key, now);
  return true;
}

// Expo push tokens registered by the mobile app.
// PERSISTED in the push_tokens table (2026-08-04) — the in-memory Set alone meant every
// server restart silently unregistered the phone until the app happened to re-register
// ("notifications sometimes don't show at all"). Loaded once at module init; register/remove
// keep Set and DB in sync. Dead tokens (Expo "DeviceNotRegistered") are pruned on send.
export const pushTokens = new Set<string>();
try {
  const rows = db.$client.prepare(`SELECT token FROM push_tokens`).all() as Array<{ token: string }>;
  for (const r of rows) pushTokens.add(r.token);
  if (rows.length) console.log(`[push] loaded ${rows.length} persisted push token(s)`);
} catch { /* pre-migration DB — table appears on next boot */ }

export function registerPushToken(token: string, platform?: string): void {
  pushTokens.add(token);
  try {
    const now = Math.floor(Date.now() / 1000);
    db.$client.prepare(
      `INSERT INTO push_tokens (token, platform, created_at, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET last_seen=excluded.last_seen, platform=COALESCE(excluded.platform, platform)`,
    ).run(token, platform ?? null, now, now);
  } catch (e: any) { console.error(`[push] persist token failed: ${e?.message}`); }
}

export function removePushToken(token: string): void {
  pushTokens.delete(token);
  try { db.$client.prepare(`DELETE FROM push_tokens WHERE token=?`).run(token); } catch {}
}

export async function sendPushNotifications(payload: {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}) {
  if (pushTokens.size === 0) return;
  const tokens = [...pushTokens];
  const messages = tokens.map(to => ({ to, sound: 'default', ...payload }));
  try {
    const r = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    // Prune tokens Expo reports as dead — index-aligned tickets.
    const j: any = await r.json().catch(() => null);
    const tickets: any[] = Array.isArray(j?.data) ? j.data : [];
    tickets.forEach((t, i) => {
      if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered' && tokens[i]) {
        console.log(`[push] pruning dead token ${tokens[i].slice(0, 30)}…`);
        removePushToken(tokens[i]);
      }
    });
  } catch (e: any) { console.error(`[push] send failed: ${e?.message}`); }
}
