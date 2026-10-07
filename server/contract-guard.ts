/**
 * CONTRACT GUARD (2026-09-17 — the Sep→Dec roll interleave).
 *
 * WHAT HAPPENED: Yahoo's continuous ES=F rolled to the DECEMBER contract at 11:30 ET on
 * 2026-09-14 while the MotiveWave chart stayed on SEPTEMBER (expiring 09-18). Both sources
 * write under the same continuous key ("MES" — normalizeSymbol strips month codes), so for
 * three sessions the 1m store alternated between Sep prints (~7620) and Dec prints (~7687):
 * a ±67-pt sawtooth that the derive step folded into every coarser bar, the engine read as
 * violent reactions (126 "live" 1m fires on 09-16 alone), and the chart rendered as cliffs.
 * No guard existed: "MW active" was pure liveness, never AGREEMENT.
 *
 * THE RULE: MotiveWave stays authoritative ONLY while it agrees with Yahoo's continuous
 * front month. Same-minute closes are paired (MW's RAW 1m close vs Yahoo's 1m bar); a
 * CONSTANT offset of ≥ OFF_CONTRACT_MIN_PTS across the newest DECIDE_PAIRS pairs is the
 * roll-spread signature (a genuine ES-vs-MES divergence of 10 pts for three straight minutes
 * is impossible — arbitrage). While off-contract:
 *   • nothing MW sends is PERSISTED (mw-reader finalize*, live-bars bar/bulk_bars) — Yahoo's
 *     1m poll is the canonical writer (yahoo-live treats MW as absent);
 *   • the MW-written 1m rows of the detection window are PURGED at the trip (Yahoo's feed lags
 *     ~10 min, so the verdict lands ~15 min after the mismatch starts and MW kept persisting
 *     meanwhile — Yahoo's DO-NOTHING writer would never overwrite them);
 *   • gap-heal / gap-audit never ask the study for fills;
 *   • ORDERS ARE BLOCKED (broadcastOrderCommand + both order paths) — a bracket priced off one
 *     contract and worked on another is the worst outcome of all;
 *   • BROADCAST-TIME TRANSLATION keeps the chart LIVE (2026-09-17/18, user: "having trouble
 *     staying live / laggy"): Yahoo's CME chart data is ~10 MINUTES DELAYED, so a Yahoo-only
 *     chart advances once a minute, ten minutes late. mw-reader's in-memory bars and last
 *     tick stay RAW (MotiveWave's own basis — the basis its brackets are worked in, and the
 *     only MW price path this verdict ever sees, so translation can never feed back into its
 *     own trigger); the measured spread (frontMonthOffset ≈ +66.5) is added ONLY at the
 *     broadcast sites (live-bars tick, mw-reader finalize/forming bars, GET /api/live/bar).
 *     Translated bars are tagged `provisional` and never stored — Yahoo's real bars replace
 *     them on the client's next reconcile. The offset is FROZEN at the trip and re-centred
 *     only on sustained ≥1-pt drift (a per-minute re-centre stepped the series without a
 *     market move).
 *   • Translation is valid ONLY for the contract the guard tripped on. Two independent roll
 *     signals stop it at once: the tick stream's month code changes (MESU6 → MESZ6, debounced
 *     over CODE_STABLE_TICKS so mixed-month charts cannot flap it), or ROLL_VOTE_TICKS
 *     consecutive raw ticks fit Yahoo better UNtranslated. A Dec tick shifted by +66.5 would
 *     be a 66-pt lie. When BOTH signals agree MW recovers immediately (fast recovery) instead
 *     of waiting ~15 min for Yahoo's delayed pairs; the pairs keep verifying afterwards.
 *   • MIXED MONTHS: tick relays on two different month codes at once (the user rolling charts
 *     one at a time) interleave prices inside MW's own stream — no offset can fix that. While
 *     two codes are seen within MIXED_WINDOW_MS the guard quarantines MW entirely (Yahoo
 *     drives, nothing persisted, orders blocked) and says so.
 * Recovery is automatic. Verdict flips are pushed (push + Discord), broadcast to clients, and
 * persisted (app_settings) so a restart never re-admits wrong-contract bars.
 *
 * Yahoo reference: its own ~60s single-flight poll of ES=F 1m (last 20 min, CLOSED minutes
 * only) — independent of yahoo-live, so the comparison keeps running while MW is authoritative
 * (exactly when yahoo-live is deliberately idle). Direct chart-API fetch like gap-heal.ts.
 *
 * TESTABILITY: assessPairs / contractParts / offsetFromDelta / rollVote / recentre are pure
 * (scripts/contract-guard.test.ts). The live modules (live-bars broadcast, trade-notify,
 * mw-reader reset) are imported lazily so this module has no static dependency on them —
 * mw-reader/live-bars/yahoo-live import it freely.
 */
import { db } from "./db";
import { deriveForDeletedOneMin } from "./derive-bars";
import { cacheInvalidate } from "./cache";

export const OFF_CONTRACT_MIN_PTS = 10;    // every paired minute must disagree by at least this
export const OFF_CONTRACT_SPREAD_PTS = 8;  // …and the disagreement must be CONSTANT (roll spread, not a fast tape)
export const RECOVER_MAX_PTS = 4;          // every paired minute back within this → MW resumes
export const MIN_PAIRS = 3;                // fewer paired minutes than this → no verdict change
export const DECIDE_PAIRS = 4;             // the newest N pairs decide (old pairs must not delay recovery)
const RING_MINUTES = 40;                   // closes retained per side — Yahoo's CME chart feed runs ~10 min behind real time, so the ring must outlast that lag (plus poll jitter) or MW/Yahoo minutes never overlap
export const ROLL_VOTE_TICKS = 40;         // consecutive raw ticks that sit closer to Yahoo UNtranslated → the chart was rolled
export const ROLL_VOTE_MARGIN_PTS = 2;     // …by at least this margin (a fast tape must not vote)
const ROLL_REF_MAX_AGE_SEC = 20 * 60;      // Yahoo's newest close is usable as the vote reference while younger than this
export const CODE_STABLE_TICKS = 20;       // a new month code must hold for this many consecutive ticks before it counts
export const FAST_TRIP_MIN_PTS = 25;       // after an ON-contract month-code change: raw ticks this far from Yahoo (ROLL_VOTE_TICKS in a row) = wrong month NOW
const VERIFY_WINDOW_SEC = 30 * 60;         // how long an on-contract month-code change stays "unverified" without paired minutes
const RECOVERY_HEAL_DELAY_MS = 13 * 60_000; // Yahoo's ~10-min lag + margin: heal the hole between Yahoo's last write and MW's first
const MIXED_WINDOW_MS = 30_000;            // two month codes on the tick stream within this window = mixed charts
export const RECENTRE_MIN_PTS = 1.0;       // frozen offset is re-centred only when the measured one differs by ≥ this…
export const RECENTRE_STREAK = 4;          // …for this many consecutive assessments
const TICK_LIVE_MS = 3 * 60_000;           // MW ticks newer than this = MW is actually driving the live price
const REF_POLL_MS = 60_000;
const REF_JITTER_MS = 10_000;
const REF_LOOKBACK_SEC = 20 * 60;
const YAHOO_TICKER = "ES=F";               // same continuous ticker yahoo-live writes from
const SYMBOL = "MES";
const SETTING_KEY = "contract_guard_state";

export interface PairSample { t: number; mw: number; yahoo: number }
export interface GuardVerdict {
  offContract: boolean;
  pairs: number;
  delta: number | null;   // median (mw − yahoo) over the deciding pairs
  spread: number | null;  // max − min of those diffs
  reason: string;
}

/** Pure verdict over same-minute close pairs (ascending or not — sorted here). */
export function assessPairs(samples: PairSample[], prevOff: boolean): GuardVerdict {
  const recent = [...samples].sort((a, b) => a.t - b.t).slice(-DECIDE_PAIRS);
  if (recent.length < MIN_PAIRS) {
    return { offContract: prevOff, pairs: recent.length, delta: null, spread: null, reason: "insufficient paired minutes" };
  }
  const diffs = recent.map(p => p.mw - p.yahoo);
  const sorted = [...diffs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const delta = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const spread = sorted[sorted.length - 1] - sorted[0];
  const abs = diffs.map(Math.abs);
  const minAbs = Math.min(...abs), maxAbs = Math.max(...abs);
  const sameSign = diffs.every(d => d > 0) || diffs.every(d => d < 0);
  if (!prevOff) {
    const trip = minAbs >= OFF_CONTRACT_MIN_PTS && sameSign && spread <= OFF_CONTRACT_SPREAD_PTS;
    return {
      offContract: trip, pairs: recent.length, delta, spread,
      reason: trip ? `constant ${delta.toFixed(2)}-pt MW−Yahoo offset over ${recent.length} minutes (roll spread)` : "MW and Yahoo agree",
    };
  }
  const recovered = maxAbs <= RECOVER_MAX_PTS;
  return {
    offContract: !recovered, pairs: recent.length, delta, spread,
    reason: recovered ? `MW back within ${RECOVER_MAX_PTS} pts of Yahoo over ${recent.length} minutes` : `still ${delta.toFixed(2)} pts off Yahoo`,
  };
}

/** Root + contract key from a raw study symbol: "MESU6.CME" / "MESU26" / "MESU6.CME.RITHMIC" →
 *  {root:"MES", code:"U6"}; a symbol with no month code (continuous "MES", "@MES", "ES=F") →
 *  {root, code:null}. Year is folded to one digit so MW's one-digit and Yahoo-style two-digit
 *  spellings compare equal. (Confirmed 2026-09-17: MotiveWave/Rithmic getSymbol() = "MESU6".) */
export function contractParts(raw: string | undefined | null): { root: string; code: string | null } | null {
  if (!raw) return null;
  const s = raw.toUpperCase().trim().replace(/(\.[A-Z]+)+$/, "").replace(/=F$/, "").replace(/^@/, "");
  if (!s) return null;
  const m = s.match(/^(.*?)([FGHJKMNQUVXZ])(\d{1,2})$/);
  return m ? { root: m[1], code: `${m[2]}${m[3].slice(-1)}` } : { root: s, code: null };
}

/** Contract key alone ("U6" / "Z6"), null when the symbol carries no month code. */
export function contractCode(raw: string | undefined | null): string | null {
  return contractParts(raw)?.code ?? null;
}

/** Price offset that maps an MW price onto Yahoo's front-month series, tick-rounded. */
export function offsetFromDelta(delta: number | null): number {
  if (delta == null || !Number.isFinite(delta)) return 0;
  return Math.round(-delta * 4) / 4;
}

/** Pure "did the MW chart get rolled?" tick vote: with the guard off-contract on offset `off`,
 *  a raw tick that lands CLOSER to Yahoo's newest close untranslated than translated (by ≥
 *  margin) is a vote that MW is now on the front month. Returns the new consecutive-vote
 *  count (0 resets). */
export function rollVote(rawPrice: number, offsetPts: number, yahooRef: number, votes: number, marginPts = ROLL_VOTE_MARGIN_PTS): number {
  const dRaw = Math.abs(rawPrice - yahooRef);
  const dTranslated = Math.abs(rawPrice + offsetPts - yahooRef);
  return dRaw + marginPts < dTranslated ? votes + 1 : 0;
}

/** Pure "is this freshly changed chart on the WRONG month?" tick vote (ON-contract month-code
 *  change): a raw tick ≥ FAST_TRIP_MIN_PTS away from Yahoo's newest close counts; anything
 *  nearer resets. The roll spread is ~60–70 pts; a genuine 25-pt displacement sustained for 40
 *  consecutive ticks RIGHT AFTER a month-code change is not a coincidence worth trading through
 *  — and a false positive only costs ~15 min of the delayed Yahoo feed. */
export function farVote(rawPrice: number, yahooRef: number, votes: number, minPts = FAST_TRIP_MIN_PTS): number {
  return Math.abs(rawPrice - yahooRef) >= minPts ? votes + 1 : 0;
}

/** Pure frozen-offset policy: keep `current` until the freshly measured offset has differed by
 *  ≥ RECENTRE_MIN_PTS for RECENTRE_STREAK consecutive assessments. Returns the offset to use
 *  and the new streak. `force` (first measurement after a restore / a null offset) adopts. */
export function recentre(current: number | null, measured: number, streak: number, force = false): { offset: number; streak: number; changed: boolean } {
  if (current == null || force) return { offset: measured, streak: 0, changed: current !== measured };
  if (Math.abs(measured - current) < RECENTRE_MIN_PTS) return { offset: current, streak: 0, changed: false };
  const next = streak + 1;
  if (next >= RECENTRE_STREAK) return { offset: measured, streak: 0, changed: true };
  return { offset: current, streak: next, changed: false };
}

// ── Live state ───────────────────────────────────────────────────────────────────────────
const mwCloses = new Map<number, number>();     // minute (epoch sec, bucket start) → MW RAW 1m close
const yahooCloses = new Map<number, number>();  // minute → Yahoo 1m close (closed minutes only)
const tickCodeSeenMs = new Map<string, number>(); // month code → last ms seen on the TICK stream
const relayWarnAt = new Map<string, number>();  // throttle for "relay X disagrees with the tick stream"
const state = {
  started: false,
  offContract: false,
  since: 0,                 // epoch sec of the current off-contract stretch (0 = none)
  delta: null as number | null,        // last MEASURED median (mw − yahoo)
  deltaSource: null as "measured" | "restored" | null,
  offset: null as number | null,       // FROZEN translation offset (pts to ADD to an MW price)
  offsetStreak: 0,
  spread: null as number | null,
  pairs: 0,
  reason: "not started",
  lastAssessAt: 0,
  flips: 0,
  mwContract: null as string | null,   // month code of the TICK stream (the stream that is translated / persisted)
  candidateCode: null as string | null,
  candidateTicks: 0,
  tripContract: null as string | null, // month code the guard tripped on — translation is valid only for it
  rollPending: false,                  // the MW chart was rolled while off-contract — awaiting confirmation
  rollVotes: 0,                        // consecutive raw ticks that fit Yahoo better UNtranslated
  mixedMonths: false,                  // two month codes on the tick stream at once
  verifyUntil: 0,                      // ON-contract month-code change: epoch sec until which raw ticks are checked against Yahoo (fast trip)
  farVotes: 0,                         // consecutive raw ticks ≥ FAST_TRIP_MIN_PTS from Yahoo while unverified
  mwLast: null as { t: number; close: number } | null,
  mwLastTick: null as { at: number; price: number } | null,
  yahooLast: null as { t: number; close: number } | null,
  purgedAtTrip: 0,
  refPolls: 0,
  refOkAt: 0,
  refError: null as string | null,
};

function trim(m: Map<number, number>) {
  if (m.size <= RING_MINUTES) return;
  const keys = [...m.keys()].sort((a, b) => a - b);
  for (const k of keys.slice(0, keys.length - RING_MINUTES)) m.delete(k);
}

function pairs(): PairSample[] {
  const out: PairSample[] = [];
  for (const [t, mw] of mwCloses) {
    const y = yahooCloses.get(t);
    if (y != null) out.push({ t, mw, yahoo: y });
  }
  return out;
}

function persist() {
  try {
    db.$client.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(SETTING_KEY, JSON.stringify({
        offContract: state.offContract, since: state.since, delta: state.delta, offset: state.offset,
        tripContract: state.tripContract, at: Math.floor(Date.now() / 1000),
      }));
  } catch { /* non-fatal */ }
}

function restore() {
  try {
    const row = db.$client.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(SETTING_KEY) as { value: string } | undefined;
    if (!row?.value) return;
    const s = JSON.parse(row.value) as { offContract?: boolean; since?: number; delta?: number | null; offset?: number | null; tripContract?: string | null };
    if (s.offContract) {
      state.offContract = true;
      state.since = s.since ?? Math.floor(Date.now() / 1000);
      state.delta = s.delta ?? null;
      state.deltaSource = s.delta != null ? "restored" : null;
      state.offset = s.offset ?? (s.delta != null ? offsetFromDelta(s.delta) : null);
      state.tripContract = s.tripContract ?? null;
      state.reason = "restored from the last run — awaiting fresh pairs";
      console.warn(`[contract-guard] restored OFF-CONTRACT state from the previous run (Δ ${s.delta ?? "?"}, contract ${s.tripContract ?? "unknown"}) — MW stays quarantined until it agrees with Yahoo; live ticks translated by ${state.offset ?? "?"} pts while the chart is still on that contract`);
    }
  } catch { /* non-fatal */ }
}

/** Tell clients the live price REGIME changed. `roll` / `mixed` also reset mw-reader's raw
 *  in-progress bars (the raw stream itself jumped months); a verdict `flip` or an `offset`
 *  re-centre does not — the in-memory bars are raw on both sides of those. */
async function publish(kind: "flip" | "roll" | "mixed" | "offset") {
  try {
    const lb = await import("./live-bars");
    lb.broadcast({ type: "contract_guard", symbol: SYMBOL, event: kind === "mixed" ? "roll" : kind, ...contractGuardStatus() });
    if (kind === "roll" || kind === "mixed") {
      const mw = await import("./mw-reader");
      mw.resetInProgressBars(SYMBOL);
    }
    if (kind !== "offset") {
      // Ranged refresh: only the last couple of hours can have changed — a bare data_updated
      // makes a scrolled-back tab re-download its entire loaded history.
      lb.broadcast({ type: "data_updated", symbol: SYMBOL, fromTs: Math.floor(Date.now() / 1000) - 2 * 3600 });
    }
  } catch { /* live modules not up yet */ }
}

/** TRIP PURGE: Yahoo's feed lags ~10 min, so the verdict lands ~15 min after the mismatch
 *  began — and MW kept persisting tick-built 1m rows the whole time. Yahoo's writer is
 *  INSERT…DO NOTHING, so those wrong-month rows would stand forever (a guaranteed interleave
 *  at every roll). Delete exactly the rows MW wrote in the ring window (stored close == the
 *  raw MW close we recorded for that minute), re-derive their coarse buckets, and let
 *  yahoo-live's 90-min lookback refill them from the front month. */
function purgeMwWrittenRows(): number {
  try {
    const sel = db.$client.prepare(`SELECT close FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp=?`);
    const del = db.$client.prepare(`DELETE FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp=?`);
    const gone: number[] = [];
    const tx = db.$client.transaction(() => {
      for (const [t, mwClose] of mwCloses) {
        const row = sel.get(SYMBOL, t) as { close: number } | undefined;
        if (!row || Math.abs(row.close - mwClose) > 0.26) continue;       // not MW's row (Yahoo already owns it)
        const y = yahooCloses.get(t);
        if (y != null && Math.abs(row.close - y) < OFF_CONTRACT_MIN_PTS) continue; // agrees with Yahoo — keep
        if (del.run(SYMBOL, t).changes > 0) gone.push(t);
      }
    });
    tx();
    if (gone.length) {
      try { deriveForDeletedOneMin(SYMBOL, gone); } catch { /* derive heal is best-effort */ }
      cacheInvalidate(SYMBOL);
      console.warn(`[contract-guard] purged ${gone.length} wrong-month 1m row(s) MW persisted during the detection window (${new Date(Math.min(...gone) * 1000).toISOString()} → ${new Date(Math.max(...gone) * 1000).toISOString()}); Yahoo refills them`);
    }
    return gone.length;
  } catch (e: any) {
    console.warn(`[contract-guard] trip purge failed: ${e?.message ?? e}`);
    return 0;
  }
}

async function onFlip(v: GuardVerdict) {
  const now = Math.floor(Date.now() / 1000);
  state.flips++;
  const mw = state.mwLast?.close, y = state.yahooLast?.close;
  const d = v.delta == null ? "?" : (v.delta > 0 ? "+" : "") + v.delta.toFixed(2);
  if (v.offContract) {
    state.since = now;
    state.tripContract = state.mwContract;
    state.rollPending = false;
    state.rollVotes = 0;
    // A fast trip carries NO measured spread (delta null): never translate on a guess — the
    // offset stays null (Yahoo's delayed poll drives) until paired minutes measure it.
    state.offset = v.delta == null ? null : offsetFromDelta(v.delta);
    state.offsetStreak = 0;
    state.purgedAtTrip = purgeMwWrittenRows();
    console.error(`[contract-guard] ⚠️⚠️ MotiveWave is on a DIFFERENT CONTRACT than the data feed — MW ${mw} (${state.mwContract ?? "?"}) vs Yahoo ${YAHOO_TICKER} ${y} (Δ ${d} pts, ${v.reason}). MW bars QUARANTINED (live ticks translated by ${state.offset} pts for the chart only), Yahoo 1m is the writer, AUTO-TRADE ORDERS BLOCKED. Roll the MotiveWave chart to the front month.`);
  } else {
    console.log(`[contract-guard] ✅ MotiveWave back on the front month (Δ ${d} pts, ${v.reason}) after ${state.since ? Math.round((now - state.since) / 60) : "?"} min — MW feed + orders resumed`);
    state.since = 0;
    state.tripContract = null;
    state.rollPending = false;
    state.rollVotes = 0;
    state.offset = null;
    state.offsetStreak = 0;
    // RECOVERY HOLE: yahoo-live yields the moment MW is authoritative again, but its last write is
    // ~10 min old (Yahoo's lag) and MW only persists from NOW — the minutes in between belong to
    // nobody. gap-heal's tail grace would find them a pass or two later; ask for that pass as
    // soon as Yahoo can serve the window so the engine's slices are whole again quickly.
    const t = setTimeout(() => { import("./gap-heal").then(g => g.runGapHeal("scheduled")).catch(() => {}); }, RECOVERY_HEAL_DELAY_MS);
    (t as any).unref?.();
  }
  state.verifyUntil = 0;
  state.farVotes = 0;
  persist();
  void publish("flip");
  try {
    const tn = await import("./trade-notify");
    tn.notifyTradeEvent({ type: "contract_guard", offContract: v.offContract, delta: v.delta, mw, yahoo: y });
  } catch { /* notify unavailable */ }
}

function assess() {
  const v = assessPairs(pairs(), state.offContract);
  state.lastAssessAt = Math.floor(Date.now() / 1000);
  state.pairs = v.pairs;
  state.reason = state.rollPending && v.pairs < MIN_PAIRS ? state.reason : v.reason;
  if (v.delta != null) {
    const first = state.deltaSource !== "measured";
    state.delta = v.delta; state.spread = v.spread; state.deltaSource = "measured";
    if (state.rollPending && v.pairs >= MIN_PAIRS) {
      // Fresh pairs from the contract NOW on the chart have spoken: either MW recovered (flip
      // below) or it is still off (rolled to a wrong month / Yahoo has not rolled yet) —
      // translation resumes on the delta measured for the contract now on the chart.
      state.rollPending = false;
      state.rollVotes = 0;
      state.tripContract = state.mwContract;
      state.offset = offsetFromDelta(v.delta);
      state.offsetStreak = 0;
      persist();
      if (v.offContract) void publish("offset");
    } else if (v.offContract && state.offContract) {
      const r = recentre(state.offset, offsetFromDelta(v.delta), state.offsetStreak, first);
      state.offsetStreak = r.streak;
      if (r.changed) {
        console.log(`[contract-guard] translation offset re-centred ${state.offset ?? "—"} → ${r.offset} pts (measured Δ ${v.delta.toFixed(2)})`);
        state.offset = r.offset;
        persist();
        void publish("offset");
      }
    }
  }
  if (state.verifyUntil && v.pairs >= MIN_PAIRS) { state.verifyUntil = 0; state.farVotes = 0; } // paired minutes have spoken
  if (v.offContract !== state.offContract) {
    state.offContract = v.offContract;
    void onFlip(v);
  }
}

/** FAST TRIP (mirror of fast recovery): the tick stream's month code just changed while MW was
 *  authoritative AND its raw ticks sit a roll-spread away from Yahoo — two independent signals.
 *  Quarantine NOW instead of persisting (and arming orders on) a wrong-month chart for the ~15
 *  minutes Yahoo's delayed pairs need. No offset is assumed: translation stays OFF (Yahoo's
 *  delayed poll drives) until paired minutes MEASURE the spread; if it was a false alarm the same
 *  pairs recover the verdict. Typical case: the user rolls MotiveWave a few days BEFORE Yahoo's
 *  ES=F rolls. */
function fastTrip(price: number) {
  const ref = state.yahooLast ? state.yahooLast.close : NaN;
  const v: GuardVerdict = {
    offContract: true, pairs: state.pairs, delta: null, spread: null,
    reason: `chart changed to ${state.mwContract ?? "?"} and ${ROLL_VOTE_TICKS} consecutive ticks sit ${(price - ref).toFixed(2)} pts from Yahoo`,
  };
  state.reason = v.reason;
  state.offContract = true;
  void onFlip(v); // delta null → onFlip leaves the offset null: no translation on an unmeasured spread
}

/** The MW chart appears to have been rolled while off-contract: stop translating NOW (a tick
 *  on the new month shifted by the old spread would be a 66-pt lie), forget the old-month
 *  pairs, and let fresh evidence decide (recover, or re-translate on a new delta). */
function declareRoll(why: string) {
  mwCloses.clear();
  state.pairs = 0;
  state.rollVotes = 0;
  state.rollPending = true;
  state.reason = `${why}; awaiting confirmation`;
  console.warn(`[contract-guard] ${why} — translation OFF, awaiting confirmation (Yahoo's delayed poll drives meanwhile)`);
  persist();
  void publish("roll");
}

/** FAST RECOVERY: the month code changed away from the tripped contract AND the raw ticks fit
 *  Yahoo untranslated — two independent signals agree, so MW resumes now instead of waiting
 *  ~15 min for Yahoo's delayed minute pairs (which keep verifying afterwards and would simply
 *  re-trip on a wrong month). */
function fastRecover(price: number) {
  const v: GuardVerdict = {
    offContract: false, pairs: state.pairs, delta: state.yahooLast ? price - state.yahooLast.close : null, spread: null,
    reason: `chart rolled ${state.tripContract ?? "?"} → ${state.mwContract ?? "?"} and ${ROLL_VOTE_TICKS} consecutive ticks match Yahoo`,
  };
  state.reason = v.reason;
  state.offContract = false;
  void onFlip(v);
}

/** live-bars tick ingest: MW's RAW tick. Liveness + the two tick-vote checks. MES only. */
export function noteMwTick(symbol: string, price: number, nowMs = Date.now()): void {
  if (symbol.toUpperCase() !== SYMBOL || !Number.isFinite(price) || price <= 0) return;
  state.mwLastTick = { at: nowMs, price };
  // Unverified ON-contract month-code change → fast trip when the ticks sit a roll-spread away.
  if (!state.offContract && !state.mixedMonths && state.verifyUntil) {
    if (nowMs / 1000 > state.verifyUntil) { state.verifyUntil = 0; state.farVotes = 0; }
    else if (state.yahooLast && nowMs / 1000 - state.yahooLast.t < ROLL_REF_MAX_AGE_SEC) {
      state.farVotes = farVote(price, state.yahooLast.close, state.farVotes);
      if (state.farVotes >= ROLL_VOTE_TICKS) { fastTrip(price); return; }
    }
  }
  if (!state.offContract || state.mixedMonths || state.offset == null ||
      !state.yahooLast || nowMs / 1000 - state.yahooLast.t >= ROLL_REF_MAX_AGE_SEC) {
    state.rollVotes = 0;
    return;
  }
  // While off-contract every raw tick votes on whether it fits Yahoo's newest close better
  // UNtranslated. A false positive needs a >33-pt adverse move inside Yahoo's 10-min lag and
  // only degrades to the delayed Yahoo feed — the safe direction.
  state.rollVotes = rollVote(price, state.offset, state.yahooLast.close, state.rollVotes);
  if (state.rollVotes < ROLL_VOTE_TICKS) return;
  if (!state.rollPending) {
    declareRoll(`${ROLL_VOTE_TICKS} consecutive MW ticks fit Yahoo untranslated (MW ${price} vs Yahoo ${state.yahooLast.close}, offset ${state.offset})`);
  } else if (state.tripContract != null && state.mwContract != null && state.mwContract !== state.tripContract) {
    fastRecover(price);
  } else {
    state.rollVotes = 0; // roll declared by votes alone — only Yahoo's paired minutes may confirm it
  }
}

/** MW's RAW completed 1m close for a minute (mw-reader finalizeBar1m — tick-built, raw by
 *  construction — and LiveBarRelay official res-1 bars). NEVER call with a translated bar. */
export function noteMwBar1m(symbol: string, timeSec: number, close: number): void {
  if (symbol.toUpperCase() !== SYMBOL || !(timeSec > 0) || !Number.isFinite(close) || close <= 0) return;
  if (state.mixedMonths) return; // interleaved months — these closes describe no contract
  // A skewed MW clock (+3h seen 2026-08-10) must not plant future keys: trim() keeps the
  // LARGEST keys, so they would evict every real minute and freeze the verdict.
  const now = Math.floor(Date.now() / 1000);
  if (timeSec > now + 90 || timeSec < now - RING_MINUTES * 60) return;
  mwCloses.set(timeSec, close);
  trim(mwCloses);
  if (!state.mwLast || timeSec >= state.mwLast.t) state.mwLast = { t: timeSec, close };
  assess();
}

export type MwSymbolSource = "tick" | "bar" | "hello" | "bulk";

/** The study's RAW symbol (before normalizeSymbol). Only the TICK stream defines `mwContract`
 *  — it is the stream that gets translated / persisted as 1m. Other relays that disagree are
 *  reported, never acted on (MW runs one LiveBarRelay per chart and the user rolls charts one
 *  at a time — acting per message made the guard flap at message rate). */
export function noteMwSymbol(raw: string | undefined | null, source: MwSymbolSource = "tick"): void {
  const parts = contractParts(raw);
  // Only the guarded instrument's charts may speak: an ES/NQ relay ("ESZ6", "NQU6") must not
  // register as an MES roll. A continuous spelling ("@MES"/"MES") after a dated one IS a chart
  // change — keyed "CONT" so it is handled like any other code change.
  if (!parts || parts.root !== SYMBOL) return;
  const code = parts.code ?? "CONT";
  const nowMs = Date.now();

  if (source !== "tick") {
    if (state.mwContract && code !== state.mwContract && nowMs - (relayWarnAt.get(source + code) ?? 0) > 5 * 60_000) {
      relayWarnAt.set(source + code, nowMs);
      console.warn(`[contract-guard] a MotiveWave ${source} relay is on ${code} while the tick stream is on ${state.mwContract} — roll EVERY MW chart to the same month`);
    }
    return;
  }

  // ── mixed-month detection on the tick stream ──
  tickCodeSeenMs.set(code, nowMs);
  let live = 0;
  for (const [c, at] of tickCodeSeenMs) { if (nowMs - at <= MIXED_WINDOW_MS) live++; else tickCodeSeenMs.delete(c); }
  if (live >= 2) {
    if (!state.mixedMonths) {
      state.mixedMonths = true;
      mwCloses.clear();
      const codes = [...tickCodeSeenMs.keys()].join(" + ");
      console.error(`[contract-guard] ⚠️ MIXED MONTHS — MotiveWave tick relays are on ${codes} at once; MW quarantined (Yahoo drives, nothing persisted, orders blocked) until every chart is on one month`);
      void publish("mixed");
      // Orders are blocked and the chart drops to the delayed feed — the user must hear about it.
      import("./trade-notify").then(tn => tn.notifyTradeEvent({ type: "contract_guard_mixed", mixed: true, codes })).catch(() => {});
    }
    state.candidateCode = null; state.candidateTicks = 0;
    return;
  }
  if (state.mixedMonths) {
    state.mixedMonths = false;
    mwCloses.clear();
    console.log(`[contract-guard] tick relays agree again (${code}) — mixed-month quarantine lifted`);
    void publish("mixed");
    import("./trade-notify").then(tn => tn.notifyTradeEvent({ type: "contract_guard_mixed", mixed: false, codes: code })).catch(() => {});
  }

  // ── debounced code change ──
  if (code === state.mwContract) { state.candidateCode = null; state.candidateTicks = 0; return; }
  if (state.mwContract != null) {
    if (state.candidateCode !== code) { state.candidateCode = code; state.candidateTicks = 1; }
    else state.candidateTicks++;
    if (state.candidateTicks < CODE_STABLE_TICKS) return;
  }
  const prev = state.mwContract;
  state.mwContract = code;
  state.candidateCode = null; state.candidateTicks = 0;

  if (prev == null) {
    // First sighting this run. A restored off-contract verdict remembers the contract it
    // tripped on — if the chart was rolled while the server was down, do NOT translate.
    if (state.offContract) {
      if (state.tripContract == null) { state.tripContract = code; persist(); }
      else if (state.tripContract !== code) declareRoll(`MW chart is on ${code} but the verdict tripped on ${state.tripContract}`);
    }
    return;
  }
  if (state.offContract) {
    declareRoll(`MW contract ${prev} → ${code}`);
  } else {
    // On-contract and MW changed months (MW rolled BEFORE Yahoo): the old month's pairs must
    // not vote about the new one — start the pairing afresh; the verdict follows the closes.
    console.warn(`[contract-guard] MW contract ${prev} → ${code} — pairing restarted; raw ticks are checked against Yahoo until paired minutes confirm the new month`);
    mwCloses.clear();
    state.pairs = 0;
    state.verifyUntil = Math.floor(nowMs / 1000) + VERIFY_WINDOW_SEC;
    state.farVotes = 0;
  }
}

/** Yahoo closed 1m bars (reference poll, or any Yahoo ingest that wants to contribute). */
export function noteYahooBars1m(bars: Array<{ time: number; close: number }>): void {
  let any = false;
  for (const b of bars) {
    if (!(b.time > 0) || !Number.isFinite(b.close) || b.close <= 0) continue;
    yahooCloses.set(b.time, b.close);
    if (!state.yahooLast || b.time >= state.yahooLast.t) state.yahooLast = { t: b.time, close: b.close };
    any = true;
  }
  if (!any) return;
  trim(yahooCloses);
  assess();
}

/** True while nothing MotiveWave sends may be persisted or traded on: its chart is on a
 *  different contract month than Yahoo's front month, or its tick relays are on MIXED months. */
export function isMwOffContract(): boolean {
  return state.offContract || state.mixedMonths;
}

/** Symbol-aware form for the ingest / broadcast sites: the verdict describes the MES chart only —
 *  any other instrument relayed over the same mw-feed socket is never quarantined or shifted. */
export function isMwQuarantined(symbol: string | undefined | null): boolean {
  return !!symbol && symbol.toUpperCase() === SYMBOL && isMwOffContract();
}

/** True while off-contract AND MW ticks can be trusted as (price + frontMonthOffset): one
 *  month on the tick stream, the chart is still on the contract the offset was measured for,
 *  and no roll awaits confirmation. False → nothing MW sends reaches clients. */
export function translationActive(): boolean {
  // candidateCode != null = a DIFFERENT month code is being debounced right now: those ticks may
  // already belong to the new month, and shifting them by the old spread is the 66-pt lie — so
  // nothing MW sends reaches clients for the ≤ CODE_STABLE_TICKS ticks the debounce takes.
  return state.offContract && !state.mixedMonths && !state.rollPending && state.offset != null &&
    state.candidateCode == null &&
    (state.tripContract == null || state.mwContract == null || state.tripContract === state.mwContract);
}

/** Points to ADD to an MW price to land on Yahoo's front-month series (0 when not translating). */
export function frontMonthOffset(): number {
  return translationActive() ? (state.offset as number) : 0;
}

/** True while MW's translated ticks are ACTUALLY driving the live price (translation on and a
 *  tick arrived recently). An expired / idle wrong-month chart sends nothing — then Yahoo's
 *  delayed bars are the only price and must not be suppressed. */
export function liveTicksCovered(): boolean {
  return translationActive() && state.mwLastTick != null && Date.now() - state.mwLastTick.at < TICK_LIVE_MS;
}

export function contractGuardStatus() {
  return {
    offContract: state.offContract,
    mixedMonths: state.mixedMonths,
    since: state.since || null,
    delta: state.delta,
    deltaSource: state.deltaSource,
    spread: state.spread,
    pairs: state.pairs,
    reason: state.reason,
    flips: state.flips,
    mwContract: state.mwContract,
    tripContract: state.tripContract,
    rollPending: state.rollPending,
    rollVotes: state.rollVotes,
    verifyPending: state.verifyUntil > 0,
    translation: { active: translationActive(), offsetPts: frontMonthOffset(), ticksLive: liveTicksCovered() },
    purgedAtTrip: state.purgedAtTrip,
    mwLast: state.mwLast,
    mwLastTick: state.mwLastTick,
    yahooLast: state.yahooLast,
    lastAssessAt: state.lastAssessAt || null,
    ref: { polls: state.refPolls, okAgeSec: state.refOkAt ? Math.floor(Date.now() / 1000) - state.refOkAt : null, error: state.refError },
    thresholds: { offPts: OFF_CONTRACT_MIN_PTS, spreadPts: OFF_CONTRACT_SPREAD_PTS, recoverPts: RECOVER_MAX_PTS, pairs: DECIDE_PAIRS },
  };
}

// ── Yahoo reference poll ────────────────────────────────────────────────────────────────
let inFlight = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export async function fetchYahooClosed1m(nowSec: number, lookbackSec = REF_LOOKBACK_SEC): Promise<Array<{ time: number; close: number }>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_TICKER)}?period1=${nowSec - lookbackSec}&period2=${nowSec}&interval=1m&includePrePost=true`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) throw new Error(`yahoo 1m chart HTTP ${resp.status}`);
  const j = await resp.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close: Array<number | null> }> } }> } };
  const r0 = j.chart?.result?.[0];
  const ts = r0?.timestamp ?? [];
  const closes = r0?.indicators?.quote?.[0]?.close ?? [];
  const out: Array<{ time: number; close: number }> = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i], c = closes[i];
    if (c == null || !(t % 60 === 0) || t + 60 > nowSec) continue; // null minute / off-grid tail print / still forming
    out.push({ time: t, close: c });
  }
  return out;
}

function scheduleNext(delayMs?: number) {
  const delay = delayMs ?? (REF_POLL_MS + Math.floor((Math.random() * 2 - 1) * REF_JITTER_MS));
  timer = setTimeout(tick, Math.max(1_000, delay));
  (timer as any).unref?.();
}

async function tick() {
  if (inFlight) { scheduleNext(); return; }
  inFlight = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const bars = await fetchYahooClosed1m(now);
    state.refPolls++;
    state.refOkAt = now;
    state.refError = null;
    if (bars.length) noteYahooBars1m(bars);
  } catch (e: any) {
    state.refError = e?.message ?? String(e);
    if (state.refPolls % 10 === 0 || state.refPolls === 0) console.warn(`[contract-guard] yahoo reference poll failed: ${state.refError}`);
  } finally {
    inFlight = false;
    scheduleNext();
  }
}

/** Arm the guard: restore the persisted verdict, then start the Yahoo reference poll. */
export function startContractGuard(): void {
  if (state.started) return;
  state.started = true;
  restore();
  console.log(`[contract-guard] armed — MW authoritative only while its 1m closes match ${YAHOO_TICKER} (trip: ≥${OFF_CONTRACT_MIN_PTS} pts constant over ${DECIDE_PAIRS} min; recover: ≤${RECOVER_MAX_PTS} pts or roll+tick-vote)${state.offContract ? ` — currently OFF-CONTRACT (restored; offset ${state.offset ?? "?"} pts)` : ""}`);
  scheduleNext(3_000);
}
