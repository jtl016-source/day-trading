// server/yellowbox.ts
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/yellowbox/day-zones — per-trading-day walk-forward Yellow Box derivation.
//
// Uses the SINGLE shared derivation core (`@shared/yellowbox-core`) — the identical math
// the renderer (scripts/yellowbox.ts) and the full-history backtest (scripts/yellowbox-backtest.ts)
// use, so the live boxes can NEVER drift from the calibrated reference.
//
// Each trading day D is derived ONLY from bars strictly before D's own session:
//   settle   = prior trading day's 17:00 ET close
//   box      = settle ± mean(60m O−L / H−O) over the last 50 trading days
//   initRes  = settle + p33 of the 50-day daily up-extension distribution (Milk's first target)
//   initSup  = settle − p43.5 of the down-extension distribution
//   longAve/shortAve = settle + p68 up / − p50 dn (Milk's LongAve/ShortAve fit)
//   bands    = Milk's mwml-imported figures for D (authoritative — data/reference/*.mwml,
//              per-figure draw-start < D 09:30 ET cutoff) + auto persistent volume bands
//              (45-day cluster lifecycle) filling price areas the import doesn't cover,
//              side-relabeled vs the last pre-open close (buyer/seller POSITIONING /
//              OBJECTIVE / ULTIMATE, NON FAIR VALUE, PIVOT).
// The box is DRAWN spanning the full Globex session: prior-cal-day 18:00 ET → D 17:00 ET.
//
// Completed days are IMMUTABLE → persisted in `yellowbox_day_zones` (created in db.ts) tagged
// with YB_CACHE_VER; bumping the version invalidates old rows so they regenerate lazily with
// the richer payload. Today's/forming day is recomputed on every request. Never scans 1m data.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "fs";
import * as path from "path";
import {
  buildSessionDays, computeCoreZones, sessionDayKey, weekdayOfKey,
  etWallToEpoch, priorCalendarDay, rnd2, toTick, TICK,
  buildDayProfile, runBandLifecycle, PB_LOOKBACK,
  parseMwmlDoc, YB_CACHE_VER, filterYbBars,
  type Bar, type DayAgg, type DayProfile, type MwmlBand,
} from "@shared/yellowbox-core";

// YB_CACHE_VER (bump to invalidate ALL cached rows — they lazily regenerate with the current
// payload) now lives in @shared/yellowbox-core with its version history, so offline DB readers
// (scripts/fact-engine-backtest.ts) share the same constant instead of hard-coding a literal.

/** Minimal synchronous better-sqlite3 surface (decouples this module from the driver types). */
interface SqliteLike {
  prepare(sql: string): {
    all: (...args: any[]) => any[];
    get: (...args: any[]) => any;
    run: (...args: any[]) => any;
  };
}

/** One labeled structural band (mwml-imported or auto persistent cluster). */
export interface DayZoneBand {
  type: string;    // "objectives" | "positioning" | "nfv" | "pivot" | "ultimate"
  label: string;   // side-relabeled, e.g. "SELLER OBJECTIVE"
  top: number;
  bottom: number;
  color: string;   // Milk's scheme: navy=objectives, red=positioning, green=NFV, steel=pivot, amber=ultimate
  source: "milk-mwml" | "auto";
}

/** One day's Yellow Box + envelope levels — the endpoint's response element. */
export interface DayZone {
  dayKeyET: string;
  sessionStartTs: number;   // prior-cal-day 18:00 ET (Globex reopen)
  sessionEndTs: number;     // D 17:00 ET (session close)
  settle: number;           // prior trading day 17:00 ET close (the box anchor)
  boxTop: number;
  boxBottom: number;
  initRes: number;
  initSup: number;
  maxRangeUp: number;
  maxRangeDn: number;
  normalRangeUp: number;
  normalRangeDn: number;
  maxTrendUp: number;
  longAve: number;
  shortAve: number;
  bands: DayZoneBand[];
  /** Derived from 10–19 prior trading days (<20 required for full confidence) — treat as advisory.
   *  Days with <10 prior trading days are not emitted at all. */
  lowConfidence?: boolean;
}

const MAX_SPAN_SEC = 8 * 366 * 86400;  // guard: cap a request span to ~8 years
const LOOKBACK_SEC = 130 * 86400;      // load ≥50 trading days of prior history before the earliest box
const MIN_DAY_BARS = 60;               // drops holiday slivers from the prior-day chain (matches renderer)

// ── MWML registry — Milk's authoritative band figures (data/reference/*.mwml) ──
// Reloaded whenever the directory contents change (name/mtime/size signature) — a new or updated
// .mwml file reaches the chart WITHOUT a server restart. figDay (the figure's session day) is
// precomputed once per parse so per-day eligibility scans stay cheap.
interface RegFigure { band: MwmlBand; figDay: string }
let _reg: { sig: string; figures: RegFigure[] } | null = null;

function registrySignature(dir: string): string {
  try {
    const parts: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".mwml")) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch { /* racing delete — skip */ }
    }
    return parts.sort().join("|");
  } catch { return ""; } // no data/reference dir — empty registry
}

function mwmlRegistry(): RegFigure[] {
  const dir = path.join(process.cwd(), "data", "reference");
  const sig = registrySignature(dir);
  if (_reg && _reg.sig === sig) return _reg.figures;
  const out: RegFigure[] = [];
  if (sig !== "") {
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".mwml")) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        for (const band of parseMwmlDoc(doc, f)) out.push({ band, figDay: sessionDayKey(band.drawStart) });
      } catch (e: any) {
        console.log(`[yellowbox] mwml parse failed ${f}: ${e.message}`);
      }
    }
  }
  console.log(`[yellowbox] mwml registry ${_reg ? "RELOADED" : "loaded"}: ${out.length} band figures from data/reference`);
  _reg = { sig, figures: out };
  return out;
}

/** FNV-1a over a canonical descriptor of the figure set — the per-day import hash. */
function hashFigures(figs: MwmlBand[]): string {
  const s = figs
    .map((b) => `${b.type}:${toTick(b.bottom)}:${toTick(b.top)}:${b.drawStart}:${b.file}`)
    .sort()
    .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

/**
 * Eligible mwml figures for target day K (pre-open cutoff = K 09:30 ET), plus their import hash.
 * ELIGIBLE-SET RULE (v3): use the FRESHEST figure-day whose figures were drawn before K's cutoff.
 *  - Figures drawn pre-open ON day K serve day K (unchanged behavior).
 *  - Figures drawn DURING day K's session (intra-day) are excluded from K itself by the cutoff,
 *    but serve from the NEXT day onward — the pre-open cutoff only applies to the day they were
 *    drawn. (Previously they matched NO day at all: `sessionDayKey===dayKey` failed for later days
 *    and the cutoff failed for their own day — every intra-day .mwml set was permanently invisible.)
 *  - A newer figure-day supersedes older sets, so days never accumulate stale bands.
 * Dedup: freshest figure per (type, tick prices) within the chosen set.
 */
function eligibleFiguresFor(dayKey: string, cutoffTs: number): { figures: MwmlBand[]; hash: string } {
  const drawn = mwmlRegistry().filter((f) => f.band.drawStart < cutoffTs);
  let bestDay = "";
  for (const f of drawn) if (f.figDay > bestDay && f.figDay <= dayKey) bestDay = f.figDay;
  const set = bestDay ? drawn.filter((f) => f.figDay === bestDay).map((f) => f.band) : [];
  const seen = new Set<string>();
  const figures: MwmlBand[] = [];
  for (const b of set.sort((a, z) => z.drawStart - a.drawStart)) {
    const key = `${b.type}:${toTick(b.bottom)}:${toTick(b.top)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    figures.push(b);
  }
  return { figures, hash: hashFigures(figures) };
}

/** Session-day K (a calendar date, ET) spans the full Globex session:
 *  [prior-calendar-day 18:00 ET  →  K 17:00 ET]. DST-safe via etWallToEpoch. */
function sessionSpan(dayKey: string): { start: number; end: number } {
  return {
    start: etWallToEpoch(priorCalendarDay(dayKey), 18, 0),
    end: etWallToEpoch(dayKey, 17, 0),
  };
}

/** Count of keys strictly less than `k` in an ascending-sorted key array (lower bound). */
function lowerBound(keysAsc: string[], k: string): number {
  let lo = 0, hi = keysAsc.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (keysAsc[mid] < k) lo = mid + 1; else hi = mid; }
  return lo;
}

interface Candidate { key: string; start: number; end: number; }

// ── Per-day band assembly: mwml import (authoritative) + auto persistent gap-fill ──────────
// Auto band → (type, label, color) by SIDE slot; colors by TYPE per Milk's scheme
// (navy=objectives #5c6bc0, red=positioning #ef5350, amber=ultimate #ffd54f).
const AUTO_ABOVE: Array<[string, string, string]> = [
  ["positioning", "SELLER POSITIONING", "#ef5350"],
  ["objectives", "BUYER OBJECTIVE", "#5c6bc0"],
  ["ultimate", "BUYERS ULTIMATE", "#ffd54f"],
];
const AUTO_BELOW: Array<[string, string, string]> = [
  ["objectives", "SELLERS OBJECTIVE", "#5c6bc0"],
  ["ultimate", "SELLERS ULTIMATE", "#ffd54f"],
  ["positioning", "BUYER POSITIONING", "#ef5350"],
];
const MWML_COLORS: Record<string, string> = {
  objectives: "#5c6bc0", positioning: "#ef5350", nfv: "#66bb6a", pivot: "#90a4ae",
};

function buildDayBands(
  imported: MwmlBand[],
  lastClose: number,
  scanProfiles: Array<DayProfile | null>,
): DayZoneBand[] {
  const bands: DayZoneBand[] = [];

  // 1) mwml import — the eligible (freshest-set, pre-open-cutoff, deduped) figures for this day,
  //    resolved by eligibleFiguresFor. Side-relabeled vs the last pre-open close.
  for (const b of imported) {
    const above = (b.top + b.bottom) / 2 > lastClose;
    let label: string;
    if (b.type === "objectives") label = above ? "BUYER OBJECTIVE" : "SELLER OBJECTIVE";
    else if (b.type === "positioning") label = above ? "SELLER POSITIONING" : "BUYER POSITIONING";
    else if (b.type === "pivot") label = "PIVOT BAND";
    else label = "NON FAIR VALUE";
    bands.push({ type: b.type, label, top: rnd2(b.top), bottom: rnd2(b.bottom), color: MWML_COLORS[b.type] ?? "#66bb6a", source: "milk-mwml" });
  }

  // 2) Auto persistent bands FILL price areas the import doesn't cover (3 above + 3 below).
  //    v3: a band STRADDLING the pre-open price is no longer dropped — it is classified to the
  //    side holding MORE of its profile volume (summed over the scan window's day profiles) and
  //    labeled with that side's slot label.
  const importCovers = (lo: number, hi: number): boolean =>
    imported.some((b) => Math.min(b.top, hi) - Math.max(b.bottom, lo) > -0.25);
  const live = runBandLifecycle(scanProfiles).filter((b) => !b.died && !importCovers(b.bottom, b.top));
  const closeBucket = Math.round(lastClose / TICK); // profile buckets are Math.round(price/TICK)
  const straddleIsAbove = (band: { bottom: number; top: number }): boolean => {
    let volAbove = 0, volBelow = 0;
    const b0 = Math.round(band.bottom / TICK), b1 = Math.round(band.top / TICK);
    for (const p of scanProfiles) {
      if (!p) continue;
      for (const [bucket, v] of p.prof) {
        if (bucket < b0 || bucket > b1) continue;
        if (bucket > closeBucket) volAbove += v;
        else if (bucket < closeBucket) volBelow += v;
      }
    }
    return volAbove >= volBelow;
  };
  const above: Array<{ bottom: number; top: number }> = [];
  const below: Array<{ bottom: number; top: number }> = [];
  for (const b of live) {
    if (b.bottom > lastClose) above.push(b);
    else if (b.top < lastClose) below.push(b);
    else (straddleIsAbove(b) ? above : below).push(b); // straddler → side with more volume
  }
  above.sort((a, b) => a.bottom - b.bottom);
  below.sort((a, b) => b.top - a.top);
  above.slice(0, 3).forEach((b, i) => bands.push({ type: AUTO_ABOVE[i][0], label: AUTO_ABOVE[i][1], top: rnd2(b.top), bottom: rnd2(b.bottom), color: AUTO_ABOVE[i][2], source: "auto" }));
  below.slice(0, 3).forEach((b, i) => bands.push({ type: AUTO_BELOW[i][0], label: AUTO_BELOW[i][1], top: rnd2(b.top), bottom: rnd2(b.bottom), color: AUTO_BELOW[i][2], source: "auto" }));
  return bands;
}

/**
 * Compute (walk-forward) + serve the Yellow Box day-zones whose Globex session intersects
 * [fromTs, toTs]. Reads/writes the `yellowbox_day_zones` cache for completed (frozen) days;
 * rows from an older YB_CACHE_VER are treated as uncached and lazily regenerated.
 */
export function getYellowboxDayZones(
  sqlite: SqliteLike,
  symbol: string,
  fromTsIn: number,
  toTsIn: number,
  nowSec: number,
): { days: DayZone[] } {
  let fromTs = Math.floor(fromTsIn);
  let toTs = Math.floor(toTsIn);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return { days: [] };
  if (toTs - fromTs > MAX_SPAN_SEC) fromTs = toTs - MAX_SPAN_SEC; // clamp span
  // Only emit sessions that have already begun (start ≤ now) — never draw an unopened future box.
  const cap = Math.min(toTs, nowSec);
  if (cap <= fromTs) return { days: [] };

  // 1) Enumerate candidate weekday session-days whose Globex span intersects [fromTs, cap].
  const candidates: Candidate[] = [];
  const startWalk = new Date((fromTs - 2 * 86400) * 1000);
  const endWalk = new Date((cap + 86400) * 1000);
  const cur = new Date(Date.UTC(startWalk.getUTCFullYear(), startWalk.getUTCMonth(), startWalk.getUTCDate()));
  const endMs = Date.UTC(endWalk.getUTCFullYear(), endWalk.getUTCMonth(), endWalk.getUTCDate());
  while (cur.getTime() <= endMs) {
    const key = cur.toISOString().slice(0, 10);
    const wd = weekdayOfKey(key);
    if (wd >= 1 && wd <= 5) { // Mon–Fri only
      const { start, end } = sessionSpan(key);
      if (end >= fromTs && start <= cap && start <= nowSec) candidates.push({ key, start, end });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  if (!candidates.length) return { days: [] };

  const minKey = candidates[0].key;
  const maxKey = candidates[candidates.length - 1].key;

  // 2) Warm cache: completed days are immutable at the CURRENT payload version AND the current
  //    per-day mwml import hash — a new/updated .mwml file changes the hash for the days it
  //    affects, so exactly those rows regenerate (previously they stayed frozen forever).
  const cacheRows = sqlite.prepare(
    `SELECT * FROM yellowbox_day_zones WHERE symbol=? AND day_key>=? AND day_key<=?`,
  ).all(symbol, minKey, maxKey) as any[];
  const cacheByKey = new Map<string, any>(cacheRows.map((r) => [r.day_key as string, r]));
  const hasBarsStmt = sqlite.prepare(
    `SELECT 1 FROM cached_candles WHERE symbol=? AND resolution IN ('1','5') AND timestamp>=? AND timestamp<=? LIMIT 1`,
  );

  // Per-candidate eligible mwml set + import hash (cheap — in-memory registry scan).
  const eligByKey = new Map<string, { figures: MwmlBand[]; hash: string }>();
  const eligOf = (key: string): { figures: MwmlBand[]; hash: string } => {
    let e = eligByKey.get(key);
    if (!e) { e = eligibleFiguresFor(key, etWallToEpoch(key, 9, 30)); eligByKey.set(key, e); }
    return e;
  };

  const out: DayZone[] = [];
  const toCompute: Candidate[] = [];
  for (const c of candidates) {
    const isComplete = c.end < nowSec;
    const cached = cacheByKey.get(c.key);
    if (isComplete && cached && cached.ver === YB_CACHE_VER && (cached.import_hash ?? "") === eligOf(c.key).hash) {
      if (cached.traded) { out.push(rowToDayZone(cached)); continue; }
      // traded=0 → recorded as a holiday. HEAL: if bars exist for the session NOW (a backfill
      // landed after the marker was written — a DATA GAP, not a holiday), recompute the day.
      if (!hasBarsStmt.get(symbol, c.start, c.end)) continue; // still no bars → real holiday
      // fall through to toCompute (recompute + re-freeze with traded=1)
    }
    toCompute.push(c); // uncached/stale-version/stale-hash completed day OR the active day
  }

  // 3) Cold path — load 5m+60m only for the window the uncomputed days need, then derive.
  if (toCompute.length) {
    const minStart = Math.min(...toCompute.map((c) => c.start));
    const loadFrom = minStart - LOOKBACK_SEC;
    const bars5 = loadBars(sqlite, symbol, "5", loadFrom, cap);
    const bars60 = loadBars(sqlite, symbol, "60", loadFrom, cap);

    const { dayMap, dayBars } = buildSessionDays(bars5);
    // Trading-day chain for the prior-day/settle lookups (drops holiday slivers).
    const allTradingDays: DayAgg[] = [...dayMap.values()]
      .filter((d) => d.weekday >= 1 && d.weekday <= 5 && d.bars >= MIN_DAY_BARS)
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    for (let i = 1; i < allTradingDays.length; i++) allTradingDays[i].prevClose = allTradingDays[i - 1].c;
    const allKeys = allTradingDays.map((d) => d.key);
    const daysWithPrev = allTradingDays.filter((d) => d.prevClose !== null);
    const withPrevKeys = daysWithPrev.map((d) => d.key);
    const lastDataDayKey = allKeys.length ? allKeys[allKeys.length - 1] : "";

    const day60 = new Map<string, Bar[]>();
    for (const b of bars60) {
      const key = sessionDayKey(b.t);
      let arr = day60.get(key);
      if (!arr) { arr = []; day60.set(key, arr); }
      arr.push(b);
    }

    // Persistent-band day profiles — the expensive part is per UNIQUE day, so cache across
    // the (possibly hundreds of) target days whose 45-day scan windows overlap.
    const profCache = new Map<string, DayProfile | null>();
    const profileOf = (key: string): DayProfile | null => {
      let p = profCache.get(key);
      if (p === undefined) { p = buildDayProfile(key, dayBars.get(key) ?? []); profCache.set(key, p); }
      return p;
    };

    const insTraded = sqlite.prepare(
      `INSERT OR REPLACE INTO yellowbox_day_zones
        (symbol, day_key, traded, session_start, session_end, settle, box_top, box_bottom,
         init_res, init_sup, max_range_up, max_range_dn, normal_range_dn, max_trend_up,
         ver, long_ave, short_ave, normal_range_up, bands, import_hash, low_conf)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insHoliday = sqlite.prepare(
      `INSERT OR REPLACE INTO yellowbox_day_zones
        (symbol, day_key, traded, session_start, session_end, ver, import_hash)
       VALUES (?, ?, 0, ?, ?, ?, ?)`,
    );

    for (const c of toCompute) {
      const isComplete = c.end < nowSec;
      const realTradingDay = dayMap.has(c.key);
      const elig = eligOf(c.key);
      // A past weekday with NO bars (≤ our latest data) is a market holiday — persist a marker
      // so it is never re-scanned (until a backfill lands — see the warm-path heal), emit nothing.
      if (isComplete && !realTradingDay && lastDataDayKey && c.key <= lastDataDayKey) {
        try { insHoliday.run(symbol, c.key, c.start, c.end, YB_CACHE_VER, elig.hash); } catch { /* transient busy — non-fatal */ }
        continue;
      }
      // Derive from the ≤50 most recent trading days strictly before c.key.
      // CONFIDENCE (v3): <10 prior days → emit nothing (statistically meaningless percentiles);
      // 10–19 prior days → emit but flag lowConfidence so the client can render it as advisory.
      const idxAll = lowerBound(allKeys, c.key);
      if (idxAll === 0) continue; // no prior trading day → cannot anchor a settle
      const anchor = allTradingDays[idxAll - 1].c;
      const idxPrev = lowerBound(withPrevKeys, c.key);
      const last50 = daysWithPrev.slice(Math.max(0, idxPrev - 50), idxPrev);
      if (last50.length < 10) continue; // earliest-history guard — no reliable distribution yet
      const lowConfidence = last50.length < 20;

      const core = computeCoreZones(last50, day60, anchor);

      // Bands: mwml eligible set (freshest figure-day before D's 09:30 ET cutoff — includes sets
      // drawn intra-day on EARLIER days) + auto persistent gap-fill.
      // Side-relabel anchor = last 5m close before D 09:30 ET (includes D's overnight session).
      const cutoffTs = etWallToEpoch(c.key, 9, 30);
      const own = (dayBars.get(c.key) ?? []).filter((b) => b.t < cutoffTs);
      const lastClose = own.length ? own[own.length - 1].c : anchor;
      const scanKeys = allKeys.slice(Math.max(0, idxAll - PB_LOOKBACK), idxAll);
      const bands = buildDayBands(elig.figures, lastClose, scanKeys.map(profileOf));

      // E/S VECTOR strip (2026-07-15 guide-study mission): Milk's nightly pair, identified
      // empirically from 24 mwml label pairs (see ES_VECTOR_CALIBRATION in yellowbox-core):
      //   E VECTOR = prior trading day's FINAL 17:00 ET close (== this day's `anchor`;
      //              MAE 2.18 pts vs the labels), S VECTOR = prior day's 16:00 ET close
      //              (cash-close proxy; MAE 4.97). Drawn exactly as on Milk's charts — one
      //   gold strip spanning the two closes for the whole session.
      const prevDayAgg = allTradingDays[idxAll - 1];
      const sVec = prevDayAgg.close16;
      const eVec = anchor;
      bands.push({
        type: "es_vector",
        label: sVec != null ? "E/S VECTORS (PRIOR 5PM/4PM CLOSES)" : "E VECTOR (PRIOR 5PM CLOSE)",
        top: rnd2(sVec != null ? Math.max(eVec, sVec) : eVec + 0.25),
        bottom: rnd2(sVec != null ? Math.min(eVec, sVec) : eVec - 0.25),
        color: "#ffd700",
        source: "auto",
      });

      const dz: DayZone = {
        dayKeyET: c.key,
        sessionStartTs: c.start,
        sessionEndTs: c.end,
        settle: rnd2(anchor),
        boxTop: rnd2(core.ybTop),
        boxBottom: rnd2(core.ybBottom),
        initRes: rnd2(core.initRes),
        initSup: rnd2(core.initSup),
        maxRangeUp: rnd2(core.mrUp),
        maxRangeDn: rnd2(core.mrDn),
        normalRangeUp: rnd2(core.nrUp),
        normalRangeDn: rnd2(core.nrDn),
        maxTrendUp: rnd2(core.mtUp),
        longAve: rnd2(core.longAve),
        shortAve: rnd2(core.shortAve),
        bands,
        ...(lowConfidence ? { lowConfidence: true } : {}),
      };
      out.push(dz);
      // Freeze only completed days — today's/forming day stays recompute-on-request.
      if (isComplete) {
        try {
          insTraded.run(symbol, dz.dayKeyET, dz.sessionStartTs, dz.sessionEndTs, dz.settle,
            dz.boxTop, dz.boxBottom, dz.initRes, dz.initSup, dz.maxRangeUp, dz.maxRangeDn,
            dz.normalRangeDn, dz.maxTrendUp,
            YB_CACHE_VER, dz.longAve, dz.shortAve, dz.normalRangeUp, JSON.stringify(dz.bands),
            elig.hash, lowConfidence ? 1 : 0);
        } catch { /* transient busy — non-fatal */ }
      }
    }
  }

  out.sort((a, b) => a.sessionStartTs - b.sessionStartTs);
  return { days: out };
}

function loadBars(sqlite: SqliteLike, symbol: string, resolution: string, fromTs: number, toTs: number): Bar[] {
  const rows = sqlite.prepare(
    `SELECT timestamp t, open o, high h, low l, close c, volume v
       FROM cached_candles
      WHERE symbol=? AND resolution=? AND timestamp>=? AND timestamp<=?
      ORDER BY timestamp`,
  ).all(symbol, resolution, fromTs, toTs) as Bar[];
  // cached_candles rows are RAW (no ingest-time validity guarantee) — filter corrupt spikes
  // before they reach computeCoreZones' 50-day 60m means (see isYbSpikeBar in the shared core).
  return filterYbBars(rows, resolution);
}

function rowToDayZone(r: any): DayZone {
  let bands: DayZoneBand[] = [];
  try { const p = JSON.parse(r.bands ?? "[]"); if (Array.isArray(p)) bands = p; } catch { /* tolerate old rows */ }
  return {
    dayKeyET: r.day_key,
    sessionStartTs: r.session_start,
    sessionEndTs: r.session_end,
    settle: r.settle,
    boxTop: r.box_top,
    boxBottom: r.box_bottom,
    initRes: r.init_res,
    initSup: r.init_sup,
    maxRangeUp: r.max_range_up,
    maxRangeDn: r.max_range_dn,
    normalRangeUp: r.normal_range_up,
    normalRangeDn: r.normal_range_dn,
    maxTrendUp: r.max_trend_up,
    longAve: r.long_ave,
    shortAve: r.short_ave,
    bands,
    ...(r.low_conf ? { lowConfidence: true } : {}),
  };
}
