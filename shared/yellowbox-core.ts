/**
 * shared/yellowbox-core.ts — shared zone-derivation core for:
 *   - scripts/yellowbox.ts          (per-day renderer / calibration harness)
 *   - scripts/yellowbox-backtest.ts (full-history walk-forward backtest)
 *   - server/routes.ts              (GET /api/yellowbox/day-zones live endpoint)
 *
 * Everything here is pure (no DB, no I/O) and framework-agnostic (no React/DOM,
 * no better-sqlite3) so it is safe to import from BOTH the server bundle and the
 * offline tsx scripts. `scripts/yellowbox-core.ts` re-exports this module so the
 * scripts keep their `./yellowbox-core` import path unchanged.
 *
 * The calibration constants are the DEFINITIVE 4-day joint fit vs Milk's MotiveWave
 * exports (Jul-8/9/10/13 2026); see the header of scripts/yellowbox.ts for the full
 * derivation notes.
 */

// ==================== CACHE VERSION ====================

/** `yellowbox_day_zones` cache-payload version. Rows tagged with an OLDER ver are treated as
 *  uncached: server/yellowbox.ts regenerates them lazily, and offline harnesses
 *  (scripts/fact-engine-backtest.ts) recompute them. Lives HERE — not in server/yellowbox.ts —
 *  so every reader filters on the current version instead of a hard-coded literal that silently
 *  rots on the next bump (a stale `ver=2` in the backtest harness did exactly that).
 *  v3: mwml eligible-set fix (intra-day figures serve from the NEXT day onward), straddling auto
 *      bands kept + side-labeled by volume, low-confidence flag for <20 prior trading days, and a
 *      per-day `import_hash` so new/updated .mwml files regenerate exactly the days they affect.
 *  v4 (2026-07-15): E/S VECTOR strip added to every day's bands (guide-study mission).
 *  v5 (2026-07-16): spike/outlier bar filter (isYbSpikeBar) applied to every zone-input loader —
 *      loadBars previously read cached_candles RAW, so one extreme MES 60m bar (2026-03-23 11:00
 *      UTC, 242-pt real news rally) shifted box_top +0.20 for every day whose 50-day lookback
 *      contained it (day keys 2026-03-24..2026-06-01). Bump regenerates all rows from filtered
 *      inputs. */
export const YB_CACHE_VER = 5;

// ========================= TIME HELPERS =========================
// DST-safe, always via Intl America/New_York (per CLAUDE.md — never hardcode UTC offsets)

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export interface EtParts { y: number; mo: number; d: number; hh: number; mm: number }

export function etParts(epochSec: number): EtParts {
  const parts = ET_FMT.formatToParts(new Date(epochSec * 1000));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "0";
  return { y: +get("year"), mo: +get("month"), d: +get("day"), hh: +get("hour") % 24, mm: +get("minute") };
}

/** Epoch seconds for an ET wall-clock time (DST-safe: tries both possible offsets). */
export function etWallToEpoch(dateStr: string, hh: number, mm: number): number {
  const [y, mo, d] = dateStr.split("-").map(Number);
  for (const off of [4, 5, 6, 3]) { // EDT=4, EST=5 (3/6 pure paranoia)
    const cand = Date.UTC(y, mo - 1, d, hh + off, mm, 0) / 1000;
    const p = etParts(cand);
    if (p.y === y && p.mo === mo && p.d === d && p.hh === hh && p.mm === mm) return cand;
  }
  throw new Error(`etWallToEpoch failed for ${dateStr} ${hh}:${mm}`);
}

/** Globex session-day key: bars at/after 18:00 ET belong to the NEXT calendar day.
 * Memoized per UTC hour (ET offset is a whole number of hours, so the key is constant within one). */
const _sdkCache = new Map<number, string>();
export function sessionDayKey(epochSec: number): string {
  const hb = Math.floor(epochSec / 3600);
  const hit = _sdkCache.get(hb);
  if (hit !== undefined) return hit;
  const key = sessionDayKeyUncached(epochSec);
  _sdkCache.set(hb, key);
  return key;
}
function sessionDayKeyUncached(epochSec: number): string {
  const p = etParts(epochSec);
  let ms = Date.UTC(p.y, p.mo - 1, p.d);
  if (p.hh >= 18) ms += 86400_000;
  const d2 = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d2.getUTCFullYear()}-${pad(d2.getUTCMonth() + 1)}-${pad(d2.getUTCDate())}`;
}

/** Weekday of a calendar date key (0=Sun..6=Sat). Timezone-independent for pure dates. */
export function weekdayOfKey(key: string): number {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

export const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function isoUtc(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(".000Z", "Z");
}

/** Calendar day BEFORE a YYYY-MM-DD key (pure date arithmetic, UTC-anchored). */
export function priorCalendarDay(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ============================ MATH ============================

export function pctile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
export function median(vals: number[]): number {
  return pctile([...vals].sort((a, b) => a - b), 0.5);
}
export const TICK = 0.25;
export const rnd2 = (x: number): number => Math.round(x * 100) / 100;
export const toTick = (x: number): number => Math.round(x / TICK) * TICK;

// ========================= DATA TYPES =========================

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

// ================= BAR VALIDITY (corrupt-spike filter) =================
// Mirror of the CLASSIC serving-path `isSpikeBar` (see LEARNINGS "Spike candle filter in
// cached-continuous endpoint"). Every zone-input loader (server/yellowbox.ts loadBars,
// scripts/yellowbox.ts loadBars, scripts/yellowbox-backtest.ts loadAll) MUST run raw
// cached_candles rows through this — computeCoreZones means over 60m H−O / O−L, so a single
// corrupt bar poisons box_top/box_bottom for every day whose 50-day lookback contains it.
// Thresholds are the STRICT classic ones (1m=0.5%, 5m=1%, 15m=1.5%, 60m=2.5% H−L/close), NOT
// the serving path's raised news-event thresholds (60m=7%) — those are deliberately loose for
// chart display. This filter also drops REAL extreme-outlier bars (e.g. the 2026-03-23 11:00
// UTC MES 60m news rally, 3.65% range/close — verified real via 1m/5m corroboration): correct
// here, because one such hour distorts the 50-day box means, but such bars must stay in the DB
// and on charts.

/** True when a bar is malformed or a corrupt data spike. `resolution` is the DB string ('1'|'5'|'15'|'60'). */
export function isYbSpikeBar(resolution: string, o: number, h: number, l: number, c: number): boolean {
  if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) return true;
  // Malformed OHLCV (impossible values)
  if (h < l || o > h || o < l || c > h || c < l || c <= 0) return true;
  const thr = resolution === "1" ? 0.005 : resolution === "5" ? 0.010 : resolution === "15" ? 0.015 : 0.025;
  const range = h - l;
  // Large absolute range
  if (range / c > thr) return true;
  // Both artifact-shape rules below fire only when the range is ABNORMALLY LARGE for the
  // interval (half the spike threshold). NOTE: the classic serving-path doji rule used a flat
  // 0.2% range gate at every interval — fine for chart display, but at 60m that flags ordinary
  // 13pt+ consolidation dojis (70 of 3194 real MES hourly bars, audited 2026-07-16). Dojis have
  // large H−O AND O−L, so purging them systematically NARROWS the box means — a calibration
  // drift far bigger than the corruption being filtered. Gated at thr*0.5, the whole filter
  // rejects exactly 1 of 3194 60m bars (the corrupt 2026-03-23) and 4 of 38301 5m bars.
  if (range / c > thr * 0.5) {
    // Gap-bar artifact: O≈H and L≈C (bearish session gap) or O≈L and H≈C (bullish) — a
    // stitched bar spanning an overnight gap. Normal marubozu bars survive the range gate.
    if ((Math.abs(o - h) < 0.5 && Math.abs(l - c) < 0.5) ||
        (Math.abs(o - l) < 0.5 && Math.abs(h - c) < 0.5)) return true;
    // Doji-spike: tiny body but abnormally large wick span.
    if (Math.abs(c - o) / range < 0.05) return true;
  }
  return false;
}

/** Drop corrupt/malformed bars from a raw cached_candles load (see isYbSpikeBar). */
export function filterYbBars(bars: Bar[], resolution: string): Bar[] {
  return bars.filter((b) => !isYbSpikeBar(resolution, b.o, b.h, b.l, b.c));
}

export interface DayAgg {
  key: string;       // session-day YYYY-MM-DD (ET, 18:00 boundary)
  weekday: number;   // 0..6
  o: number; h: number; l: number; c: number;
  vol: number; bars: number;
  prevClose: number | null; // prior trading day's close (17:00 ET session close)
  /** The day's 16:00 ET (cash-close) close — the last bar whose CLOSE time is ≤ 16:00 ET.
   *  Feeds the S VECTOR line (see ES_VECTOR_CALIBRATION); null if the day has no such bar. */
  close16: number | null;
}

/** Aggregate 5m (or finer) bars into session-day aggregates + per-day bar lists.
 * Caller filters (bar count, weekday, date range), sorts, and chains prevClose. */
export function buildSessionDays(bars: Bar[]): { dayMap: Map<string, DayAgg>; dayBars: Map<string, Bar[]> } {
  const dayMap = new Map<string, DayAgg>();
  const dayBars = new Map<string, Bar[]>();
  for (const b of bars) {
    const key = sessionDayKey(b.t);
    let d = dayMap.get(key);
    if (!d) {
      d = { key, weekday: weekdayOfKey(key), o: b.o, h: b.h, l: b.l, c: b.c, vol: 0, bars: 0, prevClose: null, close16: null };
      dayMap.set(key, d);
      dayBars.set(key, []);
    }
    d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); d.c = b.c; d.vol += b.v; d.bars++;
    // 16:00 ET cash close: last bar whose close time (t + 300s for 5m source) lands ≤ 16:00 ET.
    // Bars are ascending, so the final assignment wins. Uses the bar's own span end.
    const et = etParts(b.t + 300);
    if (et.hh * 60 + et.mm <= 16 * 60 && et.hh >= 9) d.close16 = b.c; // RTH-side bars only (09:xx-16:00)
    dayBars.get(key)!.push(b);
  }
  return { dayMap, dayBars };
}

// ==== E/S VECTOR CALIBRATION (2026-07-15 guide-study mission) ====
// Milk's nightly "E VECTOR" / "S VECTOR" strips: NO formula exists in any Fractal Exchange
// guide (proprietary). Identified EMPIRICALLY from 24 labeled pairs mined out of
// data/reference/*.mwml (comment objects, 15:57-16:17 ET placement) fitted against MES 1m/5m:
//   E VECTOR = prior trading day's FINAL (17:00 ET) futures close
//              → MAE 2.18 pts, max 5.63 over the 14 same-contract days (Jun-17..Jul-13 2026);
//                task's 4 reference days: Jul-8 Δ1.57, Jul-9 Δ0.65, Jul-10 Δ5.63, Jul-13 Δ1.54.
//   S VECTOR ≈ prior trading day's 16:00 ET close (cash-close proxy)
//              → MAE 4.97 (3.8 excluding one 19-pt weekend outlier). The true source is most
//                likely the SPX CASH close mapped through a drifting futures basis we do not
//                store — the futures 16:00 close is the correct OHLCV-only proxy.
// Labels are hand-placed text boxes (off-tick-grid values), so residuals of a few points ARE
// the label-placement noise floor. Corroborating structure: the E−S spread tracks the prior
// day's 16:00→17:00 move (sign agreement 10/12, incl. a +49-pt outlier day matched by +53).
export const ES_VECTOR_SOURCE = "prior-day closes: E = 17:00 ET final close, S = 16:00 ET close" as const;
export const E_VECTOR_FIT = { mae: 2.18, maxAbs: 5.63, n: 14 } as const;
export const S_VECTOR_FIT = { mae: 4.97, maxAbs: 19.38, n: 14 } as const;

/** Aggregate bars to a coarser interval (UTC-aligned buckets). */
export function aggBars(bs: Bar[], intervalSec: number): Bar[] {
  if (intervalSec === 300) return bs;
  const out = new Map<number, Bar>();
  for (const b of bs) {
    const bk = Math.floor(b.t / intervalSec) * intervalSec;
    const o = out.get(bk);
    if (!o) out.set(bk, { t: bk, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { o.h = Math.max(o.h, b.h); o.l = Math.min(o.l, b.l); o.c = b.c; o.v += b.v; }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// ==== DEFINITIVE CALIBRATION CONSTANTS (jointly fit vs Milk's 4 MotiveWave exports Jul-8/9/10/13) ====
// Yellow Box (SOLVED): bottom = settle - mean(O-L), top = settle + mean(H-O) over ALL 60m bars in the
// last 50 trading days; PURE settle anchor (no drift) -> maxAbs 2.75 over 8 edges, 3/4 days near-EXACT.
export const YB_FORMULA = "settle+-mean60mExt50";
export const YB_DRIFT_K = 0;
// Stats families (each day's own 50-day daily-extension distribution vs settle):
export const IRS_PCT_UP = 0.33;    // init res (red inner edge):  p33.0 opt, maxAbs 3.22
export const IRS_PCT_DN = 0.435;   // init sup (green inner edge): p43.5 opt, maxAbs 2.24
export const NR_PCT = 0.755;       // normal range dn (white box lower): p75.5 opt, maxAbs 2.50
export const MR_PCT = 0.855;       // max range UP (red outer): p85.5 opt, maxAbs 1.22
export const MR_PCT_DN = 0.87;     // max range DN (green outer): p87 opt, maxAbs 3.87
export const MT_PCT = 0.91;        // max trend up (white box upper): p91 opt, maxAbs 3.14
// TASK 4 — LongAve/ShortAve (best 3/4 fit vs Milk's mwml exports; his LongAve sits at ~p68, NOT p50):
export const LA_PCT_UP = 0.68;     // LongAve  = anchor + p68 of dayUp (50d) — Jul-8/9/10 within ~7pt
export const SA_PCT_DN = 0.50;     // ShortAve = anchor - p50 of dayDn (50d) — Jul-8/9/10 within ~2.5pt

// ==================== CORE ZONE COMPUTATION ====================

export interface CoreZones {
  meanHO: number; meanOL: number; n60: number;
  dayUpS: number[]; dayDnS: number[];   // sorted ascending, settle-relative daily extensions
  ybBottom: number; ybTop: number;
  initRes: number; initSup: number;
  nrUp: number; nrDn: number;
  mrUp: number; mrDn: number;
  mtUp: number;
  longAve: number; shortAve: number;
}

/**
 * Compute the calibrated Yellow Box + envelope levels for one target day.
 * @param last50  the 50 trading days immediately before the target day (prevClose chained)
 * @param day60   session-day -> 60m bars map covering those days
 * @param anchor  settle = prior trading day's 17:00 ET close
 * All inputs must be built from bars strictly BEFORE the target day's 09:30 ET cutoff.
 */
export function computeCoreZones(last50: DayAgg[], day60: Map<string, Bar[]>, anchor: number): CoreZones {
  const dayUpS: number[] = [], dayDnS: number[] = [];
  for (const d of last50) {
    const pc = d.prevClose as number;
    dayUpS.push(Math.max(0, d.h - pc));
    dayDnS.push(Math.max(0, pc - d.l));
  }
  dayUpS.sort((a, b) => a - b); dayDnS.sort((a, b) => a - b);
  let sumHO = 0, sumOL = 0, n60 = 0;
  for (const d of last50) for (const b of day60.get(d.key) ?? []) {
    sumHO += b.h - b.o; sumOL += b.o - b.l; n60++;
  }
  const meanHO = sumHO / Math.max(1, n60);
  const meanOL = sumOL / Math.max(1, n60);
  return {
    meanHO, meanOL, n60, dayUpS, dayDnS,
    ybBottom: anchor - meanOL,
    ybTop: anchor + meanHO,
    initRes: anchor + pctile(dayUpS, IRS_PCT_UP),
    initSup: anchor - pctile(dayDnS, IRS_PCT_DN),
    nrUp: anchor + pctile(dayUpS, NR_PCT),
    nrDn: anchor - pctile(dayDnS, NR_PCT),
    mrUp: anchor + pctile(dayUpS, MR_PCT),
    mrDn: anchor - pctile(dayDnS, MR_PCT_DN),
    mtUp: anchor + pctile(dayUpS, MT_PCT),
    longAve: anchor + pctile(dayUpS, LA_PCT_UP),
    shortAve: anchor - pctile(dayDnS, SA_PCT_DN),
  };
}

// ============ PERSISTENT STRUCTURAL BANDS (Correction A — relocated from scripts/yellowbox.ts) ============
// Objectives/positioning are PERSISTENT volume bands relabeled daily by side-of-price: born from a
// day's volume profile (4pt sliding-window clusters), live until a later day re-auctions the full
// band with high participation. Calibrated on Milk's Jul-10 chart, verified by persistence into Jul-13.
//
// Split into TWO stages so the live endpoint can compute bands for MANY target days cheaply:
//   buildDayProfile(key, bars)  — per-day volume profile + birth CANDIDATES (the expensive part,
//                                 independent of any target day → cache once per unique day)
//   runBandLifecycle(profiles)  — cheap chronological merge/death pass over a scan window.
// runBandLifecycle(last-45-profiles-before-asOf) is EXACTLY the old buildPersistentBands(asOfKey).

export const PB_LOOKBACK = 45;    // trading days scanned for band births
export const PB_WIN = 16;         // 4pt sliding window (0.25pt buckets)
export const PB_TOP_M = 6;        // max clusters born per day
export const PB_EFFORT = 1.8;     // window sum >= PB_EFFORT * median bucket vol * PB_WIN
export const PB_TRIM = 0.45;      // trim window to buckets >= PB_TRIM * peak
export const PB_DEATH = 0.80;     // re-auctioned when min in-band bucket vol >= PB_DEATH * day median

export interface PersistentBand { bottom: number; top: number; born: string; died: string | null; effort: number; refreshes: number }
export interface PBandCandidate { bottom: number; top: number; effort: number }
export interface DayProfile {
  key: string;
  prof: Map<number, number>; // price-bucket (price/TICK) -> distributed volume
  med: number;               // median bucket volume
  kLo: number; kHi: number;  // bucket range
  candidates: PBandCandidate[]; // same-day birth candidates, in effort-desc acceptance order
}

/** Build one day's volume profile + birth candidates (order/threshold semantics identical to the
 *  original in-loop code: wins sorted by effort desc, ≤ PB_TOP_M accepted, same-day clash-filtered,
 *  trimmed to PB_TRIM×peak, min-width 8 buckets re-centered). Returns null when the day has no volume. */
export function buildDayProfile(key: string, bars: Bar[]): DayProfile | null {
  const prof = new Map<number, number>();
  for (const b of bars) {
    if (!(b.v > 0)) continue;
    const b0 = Math.round(b.l / TICK), b1 = Math.round(b.h / TICK);
    const per = b.v / (b1 - b0 + 1);
    for (let k = b0; k <= b1; k++) prof.set(k, (prof.get(k) ?? 0) + per);
  }
  const vols = [...prof.values()].sort((a, b) => a - b);
  if (!vols.length) return null;
  const med = pctile(vols, 0.5);
  const keys = [...prof.keys()].sort((a, b) => a - b);
  const kLo = keys[0], kHi = keys[keys.length - 1];
  const wins: [number, number][] = [];
  for (let k = kLo; k + PB_WIN - 1 <= kHi; k++) {
    let s = 0;
    for (let j = 0; j < PB_WIN; j++) s += prof.get(k + j) ?? 0;
    wins.push([k, s]);
  }
  wins.sort((a, b) => b[1] - a[1]);
  const used = new Set<number>();
  const candidates: PBandCandidate[] = [];
  for (const [k, s] of wins) {
    if (candidates.length >= PB_TOP_M || s < PB_EFFORT * med * PB_WIN) break;
    let clash = false;
    for (let j = -PB_WIN; j < 2 * PB_WIN; j++) if (used.has(k + j)) { clash = true; break; }
    if (clash) continue;
    for (let j = 0; j < PB_WIN; j++) used.add(k + j);
    let peak = 0;
    for (let j = 0; j < PB_WIN; j++) peak = Math.max(peak, prof.get(k + j) ?? 0);
    let lo = k, hi = k + PB_WIN - 1;
    while (lo < hi && (prof.get(lo) ?? 0) < PB_TRIM * peak) lo++;
    while (hi > lo && (prof.get(hi) ?? 0) < PB_TRIM * peak) hi--;
    if (hi - lo < 8) { const mid = Math.round((lo + hi) / 2); lo = mid - 4; hi = mid + 4; }
    candidates.push({ bottom: lo * TICK, top: hi * TICK, effort: s });
  }
  return { key, prof, med, kLo, kHi, candidates };
}

/** Chronological band lifecycle over a scan window of day profiles (ascending by day). Death-checks
 *  live bands against each day's profile, then merges/births that day's candidates — byte-identical
 *  semantics to the original buildPersistentBands loop. */
export function runBandLifecycle(profiles: Array<DayProfile | null>): PersistentBand[] {
  const live: PersistentBand[] = [];
  for (const p of profiles) {
    if (!p) continue;
    for (const band of live) {
      if (band.died) continue;
      const bLo = Math.round(band.bottom / TICK), bHi = Math.round(band.top / TICK);
      if (bLo < p.kLo || bHi > p.kHi) continue;
      let minV = Infinity;
      for (let k = bLo; k <= bHi; k++) minV = Math.min(minV, p.prof.get(k) ?? 0);
      if (minV >= PB_DEATH * p.med) band.died = p.key; // re-auctioned
    }
    for (const c of p.candidates) {
      const ov = live.find((x) => !x.died && Math.min(x.top, c.top) - Math.max(x.bottom, c.bottom) > 0.5 * (c.top - c.bottom));
      if (ov) { ov.effort += c.effort; ov.refreshes++; }
      else live.push({ bottom: c.bottom, top: c.top, born: p.key, died: null, effort: c.effort, refreshes: 0 });
    }
  }
  return live;
}

// ============ MWML IMPORT (Milk's RESIST_TOOL/SUPPORT_TOOL band figures — authoritative seeds) ============
// Color -> type: navy 0,0,240=OBJECTIVES | red 255,0,0=POSITIONING | green 0,255,0=NON FAIR VALUE |
// steel 40,85,125=PIVOT. Pure doc→bands mapping — file I/O stays in the caller (scripts / server).

export interface MwmlBand { type: string; top: number; bottom: number; drawStart: number; file: string }
export const MWML_COLORMAP: Record<string, { type: string; label: string; color: string }> = {
  "0,0,240": { type: "objectives", label: "OBJECTIVE", color: "#5c6bc0" },
  "255,0,0": { type: "positioning", label: "POSITIONING", color: "#ef5350" },
  "0,255,0": { type: "nfv", label: "NON FAIR VALUE", color: "#66bb6a" },
  "40,85,125": { type: "pivot", label: "PIVOT", color: "#90a4ae" },
};

/** Parse one already-JSON.parsed .mwml document into typed bands (no cutoff filtering here). */
export function parseMwmlDoc(doc: unknown, fileName: string): MwmlBand[] {
  const bands: MwmlBand[] = [];
  const graphs = (doc as { graphs?: { figures?: unknown[] }[] }).graphs ?? [];
  for (const g of graphs) for (const fRaw of g.figures ?? []) {
    const f = fRaw as { type?: string; srcId?: string; fillColor?: string; coords?: string[] };
    if (f.type !== "supportResist" || !f.srcId || !/tool;(RESIST|SUPPORT)_TOOL/.test(f.srcId)) continue;
    const rgb = (f.fillColor ?? "").split(",").slice(0, 3).join(",");
    const map = MWML_COLORMAP[rgb];
    if (!map || !f.coords || f.coords.length < 3) continue;
    const parse = (s: string): { ms: number; p: number } => ({ ms: +s.split("|")[0], p: +s.split("|")[1] });
    const tl = parse(f.coords[0]);
    const blStr = f.coords.find((c) => c.includes("bottomLeft")) ?? f.coords[2];
    const bl = parse(blStr);
    const drawStart = Math.floor(tl.ms / 1000);
    const top = Math.max(tl.p, bl.p), bottom = Math.min(tl.p, bl.p);
    if (!(top > 0) || !(bottom > 0)) continue;
    bands.push({ type: map.type, top, bottom, drawStart, file: fileName });
  }
  return bands;
}
