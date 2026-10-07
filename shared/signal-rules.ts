// shared/signal-rules.ts
// ═════════════════════════════════════════════════════════════════════════════
// SIGNAL-INTEGRITY RULES — the single validator every signal_history row must pass,
// shared by the SERVER backstop (server/signal-guard.ts → GET/POST /api/signals/history,
// /api/data/import-full) and the CLIENT consumers (useTerminalData, SignalsView), so the
// terminal chart, Signals tab, date-browse and iPhone can never disagree about which
// rows are rule-compliant.
//
// The rules (user-dictated; mirrors shared/fact-engine.ts firing gates):
//  • Session gates evaluate at the bar's CLOSE time (timestamp + interval seconds).
//  • No signal may CLOSE inside the 17:00–18:00 ET settlement halt or while the market is
//    closed (Sat; Fri ≥ 17:00 ET; Sun < 18:00 ET).
//  • No RTH signal may close at/after 3:15 PM ET.
//  • ETH signal types: any engine type is legal overnight since 2026-08-11 (the user repealed
//    the "ETH stays pure solo vector side-entry" house rule — fact-engine confluence now fires
//    in ETH per shared/fact-engine.ts ETH_CONFLUENCE, default ON). Before that date the
//    validator enforced ETH purity; historical vse-only rows remain legal under this relaxation.
//  • Every row must carry finite entry/tp1/tp2/sl, a known interval, a Long/Short direction,
//    a NON-EMPTY fact-list label, and a signalType from the engine's closed set.
// ═════════════════════════════════════════════════════════════════════════════
import { isRTH, isMarketBreak, isAfter315ET, etWallClock } from "./firing/session";

export const SIGNAL_INTERVAL_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };

/** The engine's closed set of signal types — anything else is a fabrication fingerprint. */
export const VALID_SIGNAL_TYPES: ReadonlySet<string> = new Set([
  "fact-engine",
  "zone-reaction",
  "vector-side-entry",
  "yellowbox-break",
]);

/** CME ES/MES fully-closed windows: all Saturday; Fri ≥ 5:00 PM ET; Sun < 6:00 PM ET.
 *  (The weekday 5–6 PM halt is handled separately by isMarketBreak.)
 *  2026-07-30 perf: uses the shared cached ET clock (etWallClock) instead of per-call Intl
 *  formatting — this runs per row on every GET /api/signals/history read filter. */
export function isWeekendClosed(tsSec: number): boolean {
  const { wd, mins } = etWallClock(tsSec); // 0=Sun..6=Sat, ET wall minutes
  if (wd === 6) return true;                       // Sat
  if (wd === 5 && mins >= 17 * 60) return true;    // Fri ≥ 5:00 PM ET
  if (wd === 0 && mins < 18 * 60) return true;     // Sun < 6:00 PM ET
  return false;
}

/** Session legality of a signal, evaluated at the bar's CLOSE (timestamp + interval seconds):
 *  not weekend-closed, not in the 17:00–18:00 halt, not RTH ≥ 15:15. Any engine signalType is
 *  legal in either session (ETH purity repealed 2026-08-11 — see the header). The signalType
 *  param is retained for call-site compatibility and future session-scoped rules. */
export function isSessionLegalSignal(timestampSec: number, interval: string, signalType: string | null | undefined): boolean {
  void signalType; // no session-scoped type rule since the 2026-08-11 ETH-purity repeal
  const sec = SIGNAL_INTERVAL_SEC[interval];
  if (!sec || !Number.isFinite(timestampSec) || timestampSec <= 0) return false;
  const closeTime = timestampSec + sec;
  if (isWeekendClosed(closeTime)) return false;
  if (isMarketBreak(closeTime)) return false;
  const rth = isRTH(closeTime);
  if (rth && isAfter315ET(closeTime)) return false;
  return true;
}

/** Minimal row shape the validator needs — matches signal_history columns. */
export interface SignalRowLike {
  timestamp: number;
  interval: string;
  direction: string;
  entry: number;
  tp1: number;
  /** TP1-ONLY policy (2026-08-13): null = one target only (all post-policy rows). */
  tp2: number | null;
  sl: number;
  signalType?: string | null;
  label?: string | null;
}

/** Full row validation — the server-side backstop (C1). Returns ok:false with the first
 *  violated rule so rejected rows can be counted per reason. */
export function validateSignalRow(row: SignalRowLike): { ok: boolean; reason?: string } {
  // TP1-ONLY (2026-08-13): tp2 is legitimately null; when PRESENT it must still be finite.
  if (![row.entry, row.tp1, row.sl].every(v => Number.isFinite(v))) {
    return { ok: false, reason: "non-finite entry/tp1/sl" };
  }
  if (row.tp2 != null && !Number.isFinite(row.tp2)) {
    return { ok: false, reason: "non-finite tp2 (null is legal under TP1-only)" };
  }
  if (!SIGNAL_INTERVAL_SEC[row.interval]) return { ok: false, reason: `unknown interval "${row.interval}"` };
  const dir = (row.direction ?? "").toLowerCase();
  if (dir !== "long" && dir !== "short") return { ok: false, reason: `bad direction "${row.direction}"` };
  if (!row.signalType || !VALID_SIGNAL_TYPES.has(row.signalType)) {
    return { ok: false, reason: `signalType "${row.signalType ?? "NULL"}" not in the engine set` };
  }
  if (!row.label || !row.label.trim()) return { ok: false, reason: "empty label (no fact list)" };
  if (!isSessionLegalSignal(row.timestamp, row.interval, row.signalType)) {
    return { ok: false, reason: "session-illegal (close-time break/weekend/15:15)" };
  }
  return { ok: true };
}
