// shared/outcome-resolver.ts
// ═════════════════════════════════════════════════════════════════════════════
// THE CANONICAL TRADE-OUTCOME RESOLVER — single source of truth (2026-07-31).
//
// User-dictated semantics (implemented EXACTLY):
//   1. FIRST TOUCH DECIDES, PERMANENTLY. The moment price reaches TP1 or SL —
//      chronologically, on the finest available resolution (1m canonical) — the
//      outcome registers and is locked. A TP1 win can NEVER become a loss.
//   2. The ONLY allowed upgrade is win_tp1 → win_tp2, and ONLY when price reaches
//      TP2 after TP1 WITHOUT touching SL in between. An SL touch after TP1 ENDS
//      the watch and locks the record at win_tp1 forever — a later TP2 touch does
//      NOT upgrade (user correction 2026-07-31, supersedes the earlier "SL after
//      TP1 is irrelevant" phrasing).
//   3. win_tp2 / loss / eod are terminal — immutable forever.
//   4. Same-bar ambiguity (TP and SL inside ONE bar) resolves SL-FIRST
//      (conservative — never over-report a win). This applies both to the first
//      touch (TP1+SL in one bar → loss) and to the post-TP1 watch (TP2+SL in one
//      bar → the watch ends, record stays win_tp1 — no upgrade).
//   5. CARRY-OVERNIGHT (2026-08-11, user directive alongside the ETH repeal: "do not
//      have signals that close on session end anymore — an open trade remains open
//      until it hits tp or sl"): the walk NO LONGER stops at the 17:00 settle. It
//      continues across the halt / overnight / weekend on the next available bars
//      until TP or SL touches; a trade untouched at the data horizon stays "open".
//      Session gaps resolve by the same per-bar conventions (gap-through fills AT
//      the level; a gap spanning BOTH levels resolves SL-FIRST — conservative).
//      "eod" is no longer PRODUCED; it remains in the vocabulary and the transition
//      matrix because historical rows carry it (terminal, immutable).
//
// Consumers (all outcome paths MUST route through this module):
//   • shared/fact-engine.ts  walkForward   — the live engine's emission walk
//     (prefers the 1m slice; falls back to primary bars when 1m doesn't cover).
//   • scripts/fact-engine-backtest.ts walkExit — the harness's 1m resolution.
//   • scripts/outcome-sweep-repair.ts — the persisted-row corrector.
//   • server/routes.ts POST /api/signals/history — enforces the matching
//     transition matrix (isOutcomeTransitionAllowed + the mirrored SQL CASE)
//     at the write layer, so false records are structurally impossible even
//     from buggy or stale-data callers.
// ═════════════════════════════════════════════════════════════════════════════

/** DB / engine outcome vocabulary. The engine maps "eod" onto its legacy
 *  { outcome: "loss", eodClose: true } shape; the DB stores "eod" distinctly. */
export type CanonicalOutcome = "open" | "win_tp1" | "win_tp2" | "loss" | "eod";

export interface CanonicalBar {
  time: number; high: number; low: number; close: number;
  /** A live FORMING bar (the tab's WS merge marks it complete:false). NEVER walked (2026-10-01,
   *  ticket 12b): its extremes are not final, so a touch inside it is not a record — the walk ends
   *  there and the trade stays "open" until the bar closes. Absent = a closed bar. */
  complete?: boolean;
}

export interface CanonicalWalkArgs {
  /** Chronologically sorted bars — the FINEST resolution available (1m canonical). */
  bars: CanonicalBar[];
  /** Entry moment = fire-bar close time (fire bar time + primary interval sec). */
  entryTs: number;
  /** Entry price (fire-bar close). */
  entry: number;
  tp1: number;
  /** Nullable under the TP1-only policy — never evaluated when tp1Only is true. */
  tp2: number | null;
  sl: number;
  isLong: boolean;
  /** 17:00 ET settle of the entry's session day. CARRY-OVERNIGHT (2026-08-11): no longer a
   *  walk boundary — retained for call-site compatibility and diagnostics only. */
  settleTs: number;
  /** Spacing of `bars` — exits stamp at bar.time + barSec (bar-close convention). */
  barSec: number;
  /** Data horizon = min(lastDataTs, nowSec). "eod"/final-win_tp1 verdicts require
   *  settleTs <= coveredThroughTs; otherwise an untouched trade stays "open". */
  coveredThroughTs: number;
  /** CARRY-OVERNIGHT (2026-08-11): DEFAULT TRUE — the walk crosses the settle and rides until
   *  TP/SL (the live/record contract). FALSE restores the session-bounded walk WITH "eod"
   *  production — used ONLY by DERIVATION machinery (gate verdicts / exit calibration): letting
   *  derivation consume time-unbounded records inflated every class (drift flatters wide stops
   *  and long holds — measured 2026-08-11: SL 15-30→90-112, 186 concurrent positions, then a
   *  "fixed" pass still at PF 1.79 vs 2.11) — judgments stay session-bounded, records carry. */
  carryOvernight?: boolean;
  /** TP1-ONLY EXECUTABLE POLICY (2026-08-13, user directive: "no TP2 ever — all contracts on
   *  one TP"): when TRUE the walk ends the moment TP1 touches — outcome win_tp1, exit AT tp1,
   *  no TP2 watch, no upgrade, ever. This is exactly a resting limit at TP1 + stop at SL (OCO):
   *  every outcome is executable with a real position. The old default (false) preserves the
   *  legacy record convention, which retroactively awarded win_tp2 to full positions — an
   *  un-executable look-ahead (measured 2026-08-12: record +6.62 vs best executable +1.65)
   *  that no serving/derivation path uses anymore. */
  tp1Only?: boolean;
}

export interface CanonicalWalkResult {
  outcome: CanonicalOutcome;
  /** null for "open". For win_tp1 the exit reflects the TP1 record (price=tp1,
   *  ts=the TP1-touch bar close) even when a later SL touch ended the watch. */
  exitPrice: number | null;
  exitTs: number | null;
  /** Max adverse/favorable excursion from entry THROUGH the record's resolving bar
   *  (TP1 bar for win_tp1, TP2 bar for win_tp2, SL bar for loss, all bars for eod/open). */
  mae: number;
  mfe: number;
  /** First TP1-touch bar time (diagnostics), null if TP1 never touched. */
  tp1Ts: number | null;
  /** The bar that fixed the record (TP1 bar for win_tp1, TP2 bar for win_tp2, SL bar
   *  for loss); null for eod/open. */
  resolvedBarTime: number | null;
  /** Last processed bar's close/close-time (entry/entryTs when no bar was walked) —
   *  the "eod" exit basis. */
  lastClose: number;
  lastCloseTs: number;
}

/** First index in `bars` with time >= t (bars sorted ascending). */
function lowerBoundBars(bars: CanonicalBar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function walkOutcomeCanonical(a: CanonicalWalkArgs): CanonicalWalkResult {
  const { bars, entryTs, entry, tp1, tp2, sl, isLong, settleTs, barSec, coveredThroughTs } = a;
  const carry = a.carryOvernight !== false; // default TRUE — see the field doc
  const tp1Only = a.tp1Only === true;       // TP1-only executable policy — see the field doc
  let mae = 0, mfe = 0;
  let lastClose = entry, lastCloseTs = entryTs;
  let tp1Ts: number | null = null;
  // Snapshot of the record at the TP1 touch — the win_tp1 exit is ALWAYS this,
  // no matter what ends the watch afterwards.
  let tp1Exit: { exitTs: number; mae: number; mfe: number; barTime: number } | null = null;

  for (let j = lowerBoundBars(bars, entryTs); j < bars.length; j++) {
    const b = bars[j];
    // CARRY-OVERNIGHT (2026-08-11): with carry (default) the settle is NOT a boundary — the
    // walk continues across the halt/overnight/weekend until TP or SL touches. Derivation
    // callers pass carryOvernight:false and keep the session-bounded contract.
    if (!carry && b.time >= settleTs) break;
    if (b.time + barSec > coveredThroughTs) break; // never read bars beyond the data horizon
    if (b.complete === false) break;               // never count a forming bar (2026-10-01, ticket 12b)
    if (isLong) { mae = Math.max(mae, entry - b.low); mfe = Math.max(mfe, b.high - entry); }
    else { mae = Math.max(mae, b.high - entry); mfe = Math.max(mfe, entry - b.low); }

    const slHit = isLong ? b.low <= sl : b.high >= sl;
    // TP1-ONLY: tp2 may legitimately be null/absent on post-policy records — it must never be
    // evaluated (a null coerces to 0 and would fake a win_tp2 on every long). Guarded here so
    // no caller can trip it.
    const tp2Hit = !tp1Only && tp2 != null && (isLong ? b.high >= tp2 : b.low <= tp2);
    const tp1Hit = isLong ? b.high >= tp1 : b.low <= tp1;

    if (tp1Ts == null) {
      // ── Phase 1: nothing touched yet — the FIRST touch decides. SL-first on ties. ──
      if (slHit) {
        return { outcome: "loss", exitPrice: sl, exitTs: b.time + barSec, mae, mfe, tp1Ts: null, resolvedBarTime: b.time, lastClose, lastCloseTs };
      }
      // TP1-ONLY (2026-08-13): the resting TP1 limit fills the moment TP1 trades — the walk
      // ends here as win_tp1 even when the same SL-free bar ran through TP2. No watch, ever.
      if (tp1Only && tp1Hit) {
        return { outcome: "win_tp1", exitPrice: tp1, exitTs: b.time + barSec, mae, mfe, tp1Ts: b.time, resolvedBarTime: b.time, lastClose, lastCloseTs };
      }
      if (tp2Hit) {
        // Reaching TP2 inside one SL-free bar necessarily crossed TP1 first — win_tp2 outright.
        return { outcome: "win_tp2", exitPrice: tp2, exitTs: b.time + barSec, mae, mfe, tp1Ts: b.time, resolvedBarTime: b.time, lastClose, lastCloseTs };
      }
      if (tp1Hit) {
        tp1Ts = b.time;
        tp1Exit = { exitTs: b.time + barSec, mae, mfe, barTime: b.time };
        // fall through — the TP2 watch continues on subsequent bars
      }
    } else {
      // ── Phase 2: win_tp1 registered — watching ONLY for TP2. An SL touch ends the
      //    watch and locks win_tp1 (same-bar TP2+SL resolves SL-first: NO upgrade). ──
      if (slHit) {
        const t = tp1Exit as { exitTs: number; mae: number; mfe: number; barTime: number };
        return { outcome: "win_tp1", exitPrice: tp1, exitTs: t.exitTs, mae: t.mae, mfe: t.mfe, tp1Ts, resolvedBarTime: t.barTime, lastClose, lastCloseTs };
      }
      if (tp2Hit) {
        return { outcome: "win_tp2", exitPrice: tp2, exitTs: b.time + barSec, mae, mfe, tp1Ts, resolvedBarTime: b.time, lastClose, lastCloseTs };
      }
    }
    lastClose = b.close; lastCloseTs = b.time + barSec;
  }

  if (tp1Ts != null && tp1Exit != null) {
    // TP1 registered; neither TP2 nor SL ended the watch within the walked data.
    // The record is win_tp1 the moment TP1 touches (first touch decides) — the
    // write layer permits exactly one later transition: win_tp1 → win_tp2.
    return { outcome: "win_tp1", exitPrice: tp1, exitTs: tp1Exit.exitTs, mae: tp1Exit.mae, mfe: tp1Exit.mfe, tp1Ts, resolvedBarTime: tp1Exit.barTime, lastClose, lastCloseTs };
  }
  if (!carry && settleTs <= coveredThroughTs) {
    // Session-bounded mode only (derivation): fully covered, neither level touched → "eod".
    return { outcome: "eod", exitPrice: lastClose, exitTs: Math.min(settleTs, lastCloseTs), mae, mfe, tp1Ts: null, resolvedBarTime: null, lastClose, lastCloseTs };
  }
  // CARRY-OVERNIGHT (default): no "eod" — a trade that never touched TP1 or SL within the
  // covered data simply stays OPEN and resolves on a later pass when more bars exist.
  return { outcome: "open", exitPrice: null, exitTs: null, mae, mfe, tp1Ts: null, resolvedBarTime: null, lastClose, lastCloseTs };
}

// ═════════════════════════════════════════════════════════════════════════════
// WRITE-LAYER TRANSITION MATRIX — the immutability guard.
// Allowed: (NULL|open) → anything; win_tp1 → win_tp2; identity (X → X);
//          incoming NULL/undefined (no-op — COALESCE keeps the stored value).
// Everything else is REJECTED (win_tp1 → loss, loss → win, eod → anything, ...).
// server/routes.ts mirrors this matrix in the upsert's SQL CASE — keep both in sync.
// ═════════════════════════════════════════════════════════════════════════════
export function isOutcomeTransitionAllowed(
  stored: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  if (incoming == null || incoming === stored) return true; // no-op / identity
  if (stored == null || stored === "open") return true;     // first registration
  if (stored === "win_tp1" && incoming === "win_tp2") return true; // the ONLY upgrade
  return false; // win_tp2 / loss / eod terminal; win_tp1 never becomes loss/eod/open
}

// ═════════════════════════════════════════════════════════════════════════════
// SOURCE PROVENANCE — "live-fired records are permanent" (user directive 2026-07-31).
// signal_history.source: 'live' = written by a live tab (market.tsx fire / live outcome
// update); 'regen' = written by the harness --persist; NULL = legacy rows from before the
// column existed (historically live-tab and regen writes are indistinguishable — treated
// as regen, documented). Rules, mirrored by the POST route AND the --persist paths:
//   • source is IMMUTABLE once 'live' (a live row never becomes regen).
//   • a stored 'live' row hit by a NON-live write is a COLLISION: the incoming row YIELDS
//     entirely (no field merged, reported not overwritten). The --persist wipe likewise
//     never deletes source='live' rows.
//   • a live write over a stored regen/NULL row upgrades it to 'live' (permanent after).
// ═════════════════════════════════════════════════════════════════════════════
export type SignalSource = "live" | "regen" | null;

/** Normalize a client-supplied source value: only the two known literals count; anything
 *  else (absent, garbage, old clients) is NULL — treated as regen. */
export function normalizeSignalSource(v: unknown): SignalSource {
  return v === "live" ? "live" : v === "regen" ? "regen" : null;
}

/** TRUE when a stored live row is being written by a non-live source — the write must be
 *  dropped whole and reported (the regen/legacy row yields to the permanent live record). */
export function isLiveSourceCollision(
  stored: string | null | undefined,
  incoming: SignalSource,
): boolean {
  return stored === "live" && incoming !== "live";
}

/** The source value a write may leave behind: immutable once 'live'; otherwise the incoming
 *  value wins when present (a live fire upgrades a regen row) and NULL keeps the stored one. */
export function effectiveSourceOnWrite(
  stored: string | null | undefined,
  incoming: SignalSource,
): string | null {
  if (stored === "live") return "live";
  return incoming ?? stored ?? null;
}
