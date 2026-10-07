/**
 * yellowbox.ts — Milk (The Fractal Exchange) style "Yellow Box" zone generator.
 *
 * Computes every zone type from OUR OWN data (data/app.db, cached_candles, MES)
 * for a target trading day D, using ONLY bars strictly BEFORE D 09:30 ET
 * ("committed pre-open"), then renders a labeled 1600x1000 PNG + companion JSON.
 *
 * Usage:
 *   npx tsx scripts/yellowbox.ts --date 2026-07-13 --out yellowbox-2026-07-13.png
 *
 * Zero native deps: PNG is encoded with node:zlib + a hand-rolled 5x7 bitmap font.
 * IV Walls are best-effort via yahoo-finance2 (skipped gracefully on failure).
 */

import Database from "better-sqlite3";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  etParts, etWallToEpoch, sessionDayKey, weekdayOfKey, WEEKDAY_NAMES, isoUtc,
  pctile, median, TICK, rnd2, toTick,
  buildSessionDays, aggBars, computeCoreZones, filterYbBars,
  YB_FORMULA, YB_DRIFT_K, IRS_PCT_UP, IRS_PCT_DN, NR_PCT, MR_PCT, MR_PCT_DN, MT_PCT,
  LA_PCT_UP, SA_PCT_DN,
  PB_LOOKBACK, PB_WIN, PB_TOP_M, PB_EFFORT, PB_TRIM, PB_DEATH, buildDayProfile, runBandLifecycle,
  MWML_COLORMAP, parseMwmlDoc,
} from "./yellowbox-core";
import type { Bar, DayAgg, PersistentBand, MwmlBand } from "./yellowbox-core";

// ============================= CLI =============================

type ViewMode = "pre-open" | "rth-morning";

function parseArgs(): { date: string; out: string; symbol: string; view: ViewMode; importMwml: string } {
  const argv = process.argv.slice(2);
  let date = "";
  let out = "";
  let symbol = "MES";
  let view: ViewMode = "pre-open";
  let importMwml = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--date") date = argv[++i] ?? "";
    else if (argv[i] === "--out") out = argv[++i] ?? "";
    else if (argv[i] === "--symbol") symbol = argv[++i] ?? "MES";
    else if (argv[i] === "--view") view = (argv[++i] ?? "pre-open") as ViewMode;
    else if (argv[i] === "--import-mwml") importMwml = argv[++i] ?? "";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (view !== "pre-open" && view !== "rth-morning")) {
    console.error("Usage: npx tsx scripts/yellowbox.ts --date YYYY-MM-DD [--out file.png] [--symbol MES] [--view pre-open|rth-morning] [--import-mwml <file|dir|f1,f2>]");
    process.exit(1);
  }
  if (!out) out = view === "pre-open" ? `yellowbox-${date}.png` : `yellowbox-${date}-${view}.png`;
  return { date, out, symbol, view, importMwml };
}

// ==== time helpers + math + Bar/DayAgg + calibration constants now come from ./yellowbox-core ====

// ====================== 5x7 BITMAP FONT ======================

const FONT: Record<string, string[]> = {
  "A": [".XXX.", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  "B": ["XXXX.", "X...X", "X...X", "XXXX.", "X...X", "X...X", "XXXX."],
  "C": [".XXX.", "X...X", "X....", "X....", "X....", "X...X", ".XXX."],
  "D": ["XXXX.", "X...X", "X...X", "X...X", "X...X", "X...X", "XXXX."],
  "E": ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  "F": ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "X...."],
  "G": [".XXX.", "X...X", "X....", "X.XXX", "X...X", "X...X", ".XXX."],
  "H": ["X...X", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  "I": ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  "J": ["..XXX", "...X.", "...X.", "...X.", "...X.", "X..X.", ".XX.."],
  "K": ["X...X", "X..X.", "X.X..", "XX...", "X.X..", "X..X.", "X...X"],
  "L": ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  "M": ["X...X", "XX.XX", "X.X.X", "X.X.X", "X...X", "X...X", "X...X"],
  "N": ["X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X", "X...X"],
  "O": [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  "P": ["XXXX.", "X...X", "X...X", "XXXX.", "X....", "X....", "X...."],
  "Q": [".XXX.", "X...X", "X...X", "X...X", "X.X.X", "X..X.", ".XX.X"],
  "R": ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  "S": [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
  "T": ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  "U": ["X...X", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  "V": ["X...X", "X...X", "X...X", "X...X", ".X.X.", ".X.X.", "..X.."],
  "W": ["X...X", "X...X", "X...X", "X.X.X", "X.X.X", "XX.XX", "X...X"],
  "X": ["X...X", "X...X", ".X.X.", "..X..", ".X.X.", "X...X", "X...X"],
  "Y": ["X...X", "X...X", ".X.X.", "..X..", "..X..", "..X..", "..X.."],
  "Z": ["XXXXX", "....X", "...X.", "..X..", ".X...", "X....", "XXXXX"],
  "0": [".XXX.", "X...X", "X..XX", "X.X.X", "XX..X", "X...X", ".XXX."],
  "1": ["..X..", ".XX..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  "2": [".XXX.", "X...X", "....X", "...X.", "..X..", ".X...", "XXXXX"],
  "3": [".XXX.", "X...X", "....X", "..XX.", "....X", "X...X", ".XXX."],
  "4": ["...X.", "..XX.", ".X.X.", "X..X.", "XXXXX", "...X.", "...X."],
  "5": ["XXXXX", "X....", "XXXX.", "....X", "....X", "X...X", ".XXX."],
  "6": [".XXX.", "X....", "X....", "XXXX.", "X...X", "X...X", ".XXX."],
  "7": ["XXXXX", "....X", "...X.", "..X..", ".X...", ".X...", ".X..."],
  "8": [".XXX.", "X...X", "X...X", ".XXX.", "X...X", "X...X", ".XXX."],
  "9": [".XXX.", "X...X", "X...X", ".XXXX", "....X", "....X", ".XXX."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".XX..", ".XX.."],
  ",": [".....", ".....", ".....", ".....", "..X..", "..X..", ".X..."],
  "-": [".....", ".....", ".....", ".XXX.", ".....", ".....", "....."],
  ":": [".....", ".XX..", ".XX..", ".....", ".XX..", ".XX..", "....."],
  "(": ["...X.", "..X..", ".X...", ".X...", ".X...", "..X..", "...X."],
  ")": [".X...", "..X..", "...X.", "...X.", "...X.", "..X..", ".X..."],
  "/": ["....X", "....X", "...X.", "..X..", ".X...", "X....", "X...."],
  "%": ["XX..X", "XX..X", "...X.", "..X..", ".X...", "X..XX", "X..XX"],
  "+": [".....", "..X..", "..X..", "XXXXX", "..X..", "..X..", "....."],
  "<": ["...X.", "..X..", ".X...", "X....", ".X...", "..X..", "...X."],
  ">": [".X...", "..X..", "...X.", "....X", "...X.", "..X..", ".X..."],
  "=": [".....", "XXXXX", ".....", "XXXXX", ".....", ".....", "....."],
  "|": ["..X..", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  "'": ["..X..", "..X..", ".....", ".....", ".....", ".....", "....."],
  "_": [".....", ".....", ".....", ".....", ".....", ".....", "XXXXX"],
  "?": [".XXX.", "X...X", "....X", "...X.", "..X..", ".....", "..X.."],
  "!": ["..X..", "..X..", "..X..", "..X..", "..X..", ".....", "..X.."],
  "[": [".XXX.", ".X...", ".X...", ".X...", ".X...", ".X...", ".XXX."],
  "]": [".XXX.", "...X.", "...X.", "...X.", "...X.", "...X.", ".XXX."],
  "~": [".....", ".....", ".X...", "X.X.X", "...X.", ".....", "....."],
  "*": [".....", "X.X.X", ".XXX.", "XXXXX", ".XXX.", "X.X.X", "....."],
};

// ========================= RASTER CANVAS =========================

type RGB = [number, number, number];

class Raster {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array; // RGB, opaque

  constructor(w: number, h: number, bg: RGB) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      this.px[i * 3] = bg[0]; this.px[i * 3 + 1] = bg[1]; this.px[i * 3 + 2] = bg[2];
    }
  }

  set(x: number, y: number, c: RGB, alpha = 1): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    if (alpha >= 1) {
      this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
    } else {
      this.px[i] = Math.round(c[0] * alpha + this.px[i] * (1 - alpha));
      this.px[i + 1] = Math.round(c[1] * alpha + this.px[i + 1] * (1 - alpha));
      this.px[i + 2] = Math.round(c[2] * alpha + this.px[i + 2] * (1 - alpha));
    }
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGB, alpha = 1): void {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w)), y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, c, alpha);
  }

  hLine(x0: number, x1: number, y: number, c: RGB, alpha = 1, dash = 0, gap = 0): void {
    const a = Math.min(x0, x1), b = Math.max(x0, x1);
    for (let x = a; x <= b; x++) {
      if (dash > 0 && ((x - a) % (dash + gap)) >= dash) continue;
      this.set(x, y, c, alpha);
    }
  }

  vLine(x: number, y0: number, y1: number, c: RGB, alpha = 1, dash = 0, gap = 0): void {
    const a = Math.min(y0, y1), b = Math.max(y0, y1);
    for (let y = a; y <= b; y++) {
      if (dash > 0 && ((y - a) % (dash + gap)) >= dash) continue;
      this.set(x, y, c, alpha);
    }
  }

  rectOutline(x: number, y: number, w: number, h: number, c: RGB, alpha = 1): void {
    this.hLine(x, x + w - 1, y, c, alpha);
    this.hLine(x, x + w - 1, y + h - 1, c, alpha);
    this.vLine(x, y, y + h - 1, c, alpha);
    this.vLine(x + w - 1, y, y + h - 1, c, alpha);
  }

  text(x: number, y: number, s: string, c: RGB, scale = 1, alpha = 1): void {
    let cx = Math.round(x);
    for (const chRaw of s.toUpperCase()) {
      const glyph = FONT[chRaw] ?? FONT[" "];
      for (let ry = 0; ry < 7; ry++) {
        const row = glyph[ry];
        for (let rx = 0; rx < 5; rx++) {
          if (row[rx] === "X") {
            for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
              this.set(cx + rx * scale + sx, y + ry * scale + sy, c, alpha);
            }
          }
        }
      }
      cx += 6 * scale;
    }
  }

  textRight(xRight: number, y: number, s: string, c: RGB, scale = 1, alpha = 1): void {
    this.text(xRight - (s.length * 6 - 1) * scale, y, s, c, scale, alpha);
  }
}

function textWidth(s: string, scale = 1): number { return (s.length * 6 - 1) * scale; }

// ========================= PNG ENCODER =========================

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  const crcBuf = Buffer.alloc(4 + data.length);
  crcBuf.write(type, 0, "ascii");
  Buffer.from(data).copy(crcBuf, 4);
  out.writeUInt32BE(crc32(crcBuf), 8 + data.length);
  return out;
}

function encodePNG(r: Raster): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.w, 0);
  ihdr.writeUInt32BE(r.h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  const raw = Buffer.alloc((r.w * 3 + 1) * r.h);
  for (let y = 0; y < r.h; y++) {
    const rowStart = y * (r.w * 3 + 1);
    raw[rowStart] = 0; // filter: none
    Buffer.from(r.px.subarray(y * r.w * 3, (y + 1) * r.w * 3)).copy(raw, rowStart + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))]);
}

// ========================= DATA TYPES =========================
// Bar / DayAgg imported from ./yellowbox-core

interface Zone {
  type: string;
  label: string;
  top: number;       // for lines top === bottom === price
  bottom: number;
  render: "band" | "line" | "box";
  color: string;
  meta?: Record<string, unknown>;
}

// ========================= HISTOGRAM =========================

class VolHist {
  readonly m = new Map<number, number>(); // bucketIdx (price*4) -> volume
  add(low: number, high: number, vol: number): void {
    if (!(vol > 0) || !(high >= low)) return;
    const b0 = Math.round(low / TICK);
    const b1 = Math.round(high / TICK);
    const per = vol / (b1 - b0 + 1);
    for (let b = b0; b <= b1; b++) this.m.set(b, (this.m.get(b) ?? 0) + per);
  }
  get(b: number): number { return this.m.get(b) ?? 0; }
  range(): [number, number] {
    let lo = Infinity, hi = -Infinity;
    for (const k of this.m.keys()) { if (k < lo) lo = k; if (k > hi) hi = k; }
    return [lo, hi];
  }
  total(): number { let s = 0; for (const v of this.m.values()) s += v; return s; }
}

// ========================= MAIN =========================

const args = parseArgs();
const __dir = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dir, "..", "data", "app.db");

const targetKey = args.date;
const targetWeekday = weekdayOfKey(targetKey);
if (targetWeekday === 0 || targetWeekday === 6) {
  console.error(`failed: ${targetKey} is a ${WEEKDAY_NAMES[targetWeekday]} — not a trading day.`);
  process.exit(1);
}
const cutoffTs = etWallToEpoch(targetKey, 9, 30);
console.log(`[yellowbox] target=${targetKey} (${WEEKDAY_NAMES[targetWeekday]})  cutoff=09:30 ET = ${isoUtc(cutoffTs)} (epoch ${cutoffTs})`);

let db: InstanceType<typeof Database>;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch {
  db = new Database(DB_PATH, { fileMustExist: true }); // WAL readonly needs -shm; fall back (still no writes issued)
}

let maxUsedTs = 0;
function loadBars(resolution: string, fromTs: number, toTsExclusive: number): Bar[] {
  const rows = filterYbBars(db.prepare(
    `SELECT timestamp t, open o, high h, low l, close c, volume v
     FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp>=? AND timestamp<? ORDER BY timestamp`
  ).all(args.symbol, resolution, fromTs, toTsExclusive) as Bar[], resolution);
  for (const r of rows) if (r.t > maxUsedTs) maxUsedTs = r.t;
  return rows;
}

// ---- load everything (ALL queries bounded < cutoffTs) ----
const SIX_YEARS = 6 * 366 * 86400;
const bars5 = loadBars("5", cutoffTs - SIX_YEARS, cutoffTs);
const bars60 = loadBars("60", cutoffTs - 120 * 86400, cutoffTs);
const bars1 = loadBars("1", cutoffTs - 25 * 86400, cutoffTs);
console.log(`[yellowbox] loaded pre-cutoff bars: 5m=${bars5.length} 60m=${bars60.length} 1m=${bars1.length}`);
if (bars5.length < 1000) { console.error("failed: not enough 5m history before cutoff"); process.exit(1); }

// ---- session-day aggregation from 5m (shared core) ----
const { dayMap, dayBars: dayBars5 } = buildSessionDays(bars5);
// trading days strictly before D, with a sane bar count (drops junk/holiday slivers, keeps half-days)
const allDays: DayAgg[] = [...dayMap.values()]
  .filter((d) => d.key < targetKey && d.bars >= 60 && d.weekday >= 1 && d.weekday <= 5)
  .sort((a, b) => (a.key < b.key ? -1 : 1));
for (let i = 1; i < allDays.length; i++) allDays[i].prevClose = allDays[i - 1].c;

const priorDay = allDays[allDays.length - 1];
if (!priorDay) { console.error("failed: no prior trading day found"); process.exit(1); }
const anchor = priorDay.c; // prior RTH close (17:00 ET session close)

// last close before cutoff (includes D's overnight session)
const overnight = (dayBars5.get(targetKey) ?? []).filter((b) => b.t < cutoffTs);
const lastBar5 = overnight.length ? overnight[overnight.length - 1] : bars5[bars5.length - 1];
const lastClose = lastBar5.c;
console.log(`[yellowbox] prior trading day=${priorDay.key} close(anchor)=${anchor}  lastCloseBeforeCutoff=${lastClose} @ ${isoUtc(lastBar5.t)}`);

const zones: Zone[] = [];

// ============ 1. VOLATILITY METRICS (60m, last 50 trading days) ============

const last50 = allDays.filter((d) => d.prevClose !== null).slice(-50);
const day60 = new Map<string, Bar[]>();
for (const b of bars60) {
  const key = sessionDayKey(b.t);
  if (!day60.has(key)) day60.set(key, []);
  day60.get(key)!.push(b);
}
const upExts: number[] = [];
const dnExts: number[] = [];
const dayMaxUp: number[] = [];
const dayMaxDn: number[] = [];
for (const d of last50) {
  const a = d.prevClose as number;
  const b60 = day60.get(d.key) ?? [];
  let mu = 0, md = 0;
  for (const b of b60) {
    const up = b.h - a, dn = a - b.l;
    if (up > 0) upExts.push(up);
    if (dn > 0) dnExts.push(dn);
    mu = Math.max(mu, up); md = Math.max(md, dn);
  }
  if (b60.length) { dayMaxUp.push(mu); dayMaxDn.push(md); }
}
upExts.sort((a, b) => a - b); dnExts.sort((a, b) => a - b);
dayMaxUp.sort((a, b) => a - b); dayMaxDn.sort((a, b) => a - b);

// ---- Tutorial-calibrated volatility mapping (Milk's Yellow Box video + his ACTUAL Jul-13 chart) ----
// Everything derives pre-open for day D from the last 50 trading days.
// Two anchor variants are computed and printed each run:
//   settle = prior trading day's 17:00 ET close;  gopen = day D's Globex session open (18:00 ET eve).
// LOCKED constants below were calibrated once against Milk's actual 2026-07-13 chart
// (yellow box 7616.75-7632, LongAve 7651.75, bottom ave 7597.25, normal range dn ~7560, max range dn ~7522).

const MILK_DATE = "2026-07-13";

// ==== DEFINITIVE CALIBRATION CONSTANTS ====
// TASK 1 (yellow box, SOLVED) + TASK 3 (stats-family percentiles) constants now live in
// ./yellowbox-core (YB_FORMULA, YB_DRIFT_K, IRS_PCT_UP/DN, NR_PCT, MR_PCT/MR_PCT_DN, MT_PCT) —
// shared with scripts/yellowbox-backtest.ts. Full derivation notes are in that module.
// NOTE: an earlier calibration saw a spurious +5.6 Jul-13 shift — that was a STALE Jul-10 settle in the
//   live DB (7620.25 vs the corrected 7625.75); with fresh data no drift term is warranted.
const EXT_DIST: "settle" | "gopen" = "settle";  // distribution family label for IRS/NR/MR (settle-anchored, per core)
// TASK 4 — LongAve/ShortAve: NO median variant fits all 4. Milk's LongAve sits at ~p68 of the up-extension
// distribution (NOT the median), and Jul-13's whole band is shifted ~26-37pt DOWN (outlier). Best 3/4 fit:
// (LA_PCT_UP=0.68 / SA_PCT_DN=0.50 now imported from ./yellowbox-core — shared with the live endpoint.)
// TASK 7 — WEEKLY ENVELOPES (single-week extension dist vs prior-Fri settle; asymmetric — Jul-13 run-up):
const WK_MF_UP = 0.415, WK_MF_DN = 0.88;   // MON-FRI weekly ceiling/floor percentiles (fit to Jul-12 draw)
const WK_FR_UP = 0.76,  WK_FR_DN = 0.94;   // FRI weekly ceiling/floor percentiles
// TASK 6 — OVN SPY factors (prior-day SPY high/low * factor). Best fit but NOT within 3pt (Jul-9 ceil/Jul-10
// floor off ~20-29pt) -> computed zones are JSON-noted & NOT rendered; Milk's exact boxes render as ref.
const OVN_SPY_F_CEIL = 10.135, OVN_SPY_F_FLOOR = 10.063;
// Persistent-band knobs (auto layer; now only FILLS GAPS the mwml import (Task 5) does not cover):
// PB_LOOKBACK/PB_WIN/PB_TOP_M/PB_EFFORT/PB_TRIM/PB_DEATH now live in ./yellowbox-core (shared with
// the live endpoint) — as do buildDayProfile/runBandLifecycle (the builder itself).

// ==== MILK GROUND TRUTH (exact figures from his 4 MotiveWave exports; DEFINITIVE reference) ====
// Rendered as thin "(MILK REF)" overlays when target is one of these 4 days (E/S strip, OVN SPY,
// NET DEALER, IV walls — none are reproducible pre-open from our data alone). Also feeds the grand table.
interface MilkDay {
  esVec: [number, number];         // E/S vector strip [lo, hi] (thin gold strip)
  ovnCeil: [number, number]; ovnFloor: [number, number]; // OVN SPY ceiling/floor 10pt boxes
  netDealer: number; ivWall: [number, number];           // NET DEALER line; daily IV wall [dn, up]
  weeklyIV?: [number, number];                           // weekly IV walls (union)
  yb: [number, number]; redBox: [number, number]; greenBox: [number, number]; whiteBox: [number, number];
  longAve: number; shortAve: number;
}
const MILK_REF: Record<string, MilkDay> = {
  "2026-07-08": { esVec: [7551.75, 7555.50], ovnCeil: [7605.25, 7615.25], ovnFloor: [7494.50, 7504.50], netDealer: 7561.00, ivWall: [7487.52, 7597.44], yb: [7542.75, 7560.25], redBox: [7578.00, 7636.25], greenBox: [7450.25, 7523.50], whiteBox: [7483.25, 7656.75], longAve: 7620.75, shortAve: 7521.00 },
  "2026-07-09": { esVec: [7517.50, 7530.25], ovnCeil: [7586.50, 7596.50], ovnFloor: [7438.50, 7448.50], netDealer: 7548.50, ivWall: [7434.13, 7575.04], yb: [7508.75, 7526.50], redBox: [7547.25, 7602.00], greenBox: [7416.75, 7489.50], whiteBox: [7449.25, 7622.50], longAve: 7578.50, shortAve: 7483.00 },
  "2026-07-10": { esVec: [7586.25, 7591.00], ovnCeil: [7619.25, 7629.25], ovnFloor: [7477.25, 7487.25], netDealer: 7526.50, ivWall: [7533.62, 7633.16], yb: [7577.00, 7595.00], redBox: [7612.75, 7671.25], greenBox: [7484.25, 7557.50], whiteBox: [7521.75, 7691.75], longAve: 7657.00, shortAve: 7555.50 },
  "2026-07-13": { esVec: [7622.50, 7626.00], ovnCeil: [7650.45, 7660.45], ovnFloor: [7523.50, 7533.50], netDealer: 7565.50, ivWall: [7553.78, 7662.81], weeklyIV: [7468.96, 7724.29], yb: [7616.75, 7635.00], redBox: [7653.75, 7711.00], greenBox: [7523.75, 7597.25], whiteBox: [7561.00, 7732.00], longAve: 7651.75, shortAve: 7570.25 },
};
const milkRef: MilkDay | undefined = MILK_REF[targetKey];

const gopenBar = (dayBars5.get(targetKey) ?? [])[0];
const gopen = gopenBar ? gopenBar.o : anchor;

// ---- SHARED CORE: yellow box + envelope levels (identical math in the backtest) ----
const core = computeCoreZones(last50, day60, anchor);
const { meanHO, meanOL, n60, dayUpS, dayDnS } = core;

// open-anchored extension distributions (candidate/percentile tables only)
const dayUpO: number[] = [], dayDnO: number[] = [];
for (const d of last50) {
  dayUpO.push(Math.max(0, d.h - d.o)); dayDnO.push(Math.max(0, d.o - d.l));
}
for (const a of [dayUpO, dayDnO]) a.sort((x, y) => x - y);

// per-60m-bar C2C stats over the 50-day window (candidate table only)
const posC2C: number[] = [], negC2C: number[] = [];
{
  let prevC: number | null = null;
  for (const d of last50) for (const b of day60.get(d.key) ?? []) {
    if (prevC !== null) { const dc = b.c - prevC; if (dc > 0) posC2C.push(dc); else if (dc < 0) negC2C.push(-dc); }
    prevC = b.c;
  }
}
const meanPosC2C = posC2C.reduce((s, x) => s + x, 0) / Math.max(1, posC2C.length);
const meanNegC2C = negC2C.reduce((s, x) => s + x, 0) / Math.max(1, negC2C.length);
const meanDayUpS = dayUpS.reduce((s, x) => s + x, 0) / Math.max(1, dayUpS.length);
const meanDayDnS = dayDnS.reduce((s, x) => s + x, 0) / Math.max(1, dayDnS.length);
// 50-day mean daily drift (close - prevClose): centers the box on the regime trend
const drift = last50.reduce((s, d) => s + (d.c - (d.prevClose as number)), 0) / Math.max(1, last50.length);

// TASK 1 — Yellow Box candidate formulas. WIDTH is definitively the 50-day mean 60m bar extension
// (bottom = center - meanOL, top = center + meanHO); only the CENTER anchor varies between candidates.
const ybCandidates: Record<string, { bottom: number; top: number }> = {
  "settle+-mean60mExt50": { bottom: anchor - meanOL, top: anchor + meanHO },                          // WINNER: k=0, maxAbs 2.75 (3/4 near-EXACT)
  "settle+0.16drift50+-mean60mExt50": { bottom: anchor + 0.16 * drift - meanOL, top: anchor + 0.16 * drift + meanHO }, // strict min-max maxAbs 1.50 (overfit; NOT used)
  "settle+drift50+-mean60mExt50": { bottom: anchor + drift - meanOL, top: anchor + drift + meanHO },   // full drift (old), maxAbs 8.00
  "gopen+-mean60mExt50": { bottom: gopen - meanOL, top: gopen + meanHO },
  "settle+-mean60mC2C": { bottom: anchor - meanNegC2C, top: anchor + meanPosC2C },
  "settle+-0.12pct": { bottom: anchor * (1 - 0.0012), top: anchor * (1 + 0.0012) },
  "settle+-thirdMeanDailyExt": { bottom: anchor - meanDayDnS / 3, top: anchor + meanDayUpS / 3 },
};
console.log(`\n[yb] anchors: settle=${anchor}  globexOpen=${gopen}${gopenBar ? ` @ ${isoUtc(gopenBar.t)}` : " (fallback=settle)"}  drift50=${drift.toFixed(2)}  meanHO=${meanHO.toFixed(2)} meanOL=${meanOL.toFixed(2)}`);
{
  // residuals vs Milk's exact box on any of the 4 known days (print EVERY candidate)
  const gt = milkRef?.yb;
  let bestName = "", bestErr = Infinity;
  for (const [name, c] of Object.entries(ybCandidates)) {
    const eb = gt ? toTick(c.bottom) - gt[0] : NaN, et = gt ? toTick(c.top) - gt[1] : NaN;
    const maxAbs = gt ? Math.max(Math.abs(eb), Math.abs(et)) : NaN;
    if (gt && maxAbs < bestErr) { bestErr = maxAbs; bestName = name; }
    console.log(`  YB ${name.padEnd(34)} ${toTick(c.bottom).toFixed(2)}-${toTick(c.top).toFixed(2)}${gt ? `  (db${eb.toFixed(2)},dt${et.toFixed(2)} maxAbs${maxAbs.toFixed(2)})` : ""}${name === YB_FORMULA ? "  << WINNER" : ""}`);
  }
  if (gt) console.log(`  YB best-fit vs Milk ${gt[0]}-${gt[1]} (this day): ${bestName}`);
}
const yb = ybCandidates[YB_FORMULA];

// Initial Resistance/Support / normal-range / max-range / max-trend levels = shared core values
// (settle-anchored calibrated percentiles; mode detector DROPPED — it grabbed a near-anchor bucket
// for Jul-10 initial support: 7571.08 vs Milk's 7557.50).
const { initRes, initSup, nrUp, nrDn, mrUp, mrDn, mtUp } = core;

// ---- TASK 2: E/S VECTOR grid-search (Milk's gold strip, drawn (D-1) 18:00 ET = 22:00 UTC) ----
// Milk's tick-aligned STRIP endpoints [lo, hi] ARE the two raw vector lines (E & S cross day-to-day).
// GRID: forms A=Highest(Lowest(low,N)), B=Highest(Lowest(close,N)), C=Lowest(Highest(high,N)); N 10..50;
// interval {5,15,30,60}; session {RTH,ETH,ALL}; eval @ (D-1) 18:00 ET.  RESULT = NO-MATCH within +/-1.5pt.
// Best (over 4 days): upper=C:LoHi(high) N=15 5m (maxErr 2.25); lower=B:HiLo(close) N=25 5m (maxErr 3.75).
// -> vector NOT wired as authoritative; the settle-anchored yellow box (Task 1) stands. Milk's exact strip
//    renders as a "(MILK REF)" overlay on the 4 known days; best-fit values + residuals stored in JSON.
// (aggBars imported from ./yellowbox-core)
function sessBars(bs: Bar[], mode: "RTH" | "ETH" | "ALL"): Bar[] {
  if (mode === "ALL") return bs;
  return bs.filter((b) => { const p = etParts(b.t); const m = p.hh * 60 + p.mm; const rth = m >= 570 && m < 1020; return mode === "RTH" ? rth : !rth; });
}
/** Generalized nested extreme: dir "HiLo" = Highest(Lowest(field,N),N); "LoHi" = Lowest(Highest(field,N),N). */
function vecVal(bs: Bar[], N: number, field: "l" | "h" | "c", dir: "HiLo" | "LoHi"): number {
  if (bs.length < N) return NaN;
  const inner: number[] = [];
  for (let i = 0; i < bs.length; i++) {
    let v = dir === "HiLo" ? Infinity : -Infinity;
    for (let j = Math.max(0, i - N + 1); j <= i; j++) v = dir === "HiLo" ? Math.min(v, bs[j][field]) : Math.max(v, bs[j][field]);
    inner.push(v);
  }
  const tail = inner.slice(-N);
  return dir === "HiLo" ? Math.max(...tail) : Math.min(...tail);
}
const derivDayMs = Date.UTC(...(targetKey.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as unknown as [number, number, number]) - 86400_000;
const derivDayKey = new Date(derivDayMs).toISOString().slice(0, 10);
const derivTs = etWallToEpoch(derivDayKey, 18, 0);
const vecTest: Record<string, number> = {};
{
  const pre5 = bars5.filter((b) => b.t < derivTs);
  // best-fit strip (task formula set {A,B,C}; 5m; ALL): lower=B:HiLo(close,25), upper=C:LoHi(high,15)
  const vLower = rnd2(vecVal(pre5, 25, "c", "HiLo"));
  const vUpper = rnd2(vecVal(pre5, 15, "h", "LoHi"));
  vecTest["lower B:HiLo(close,25) 5m"] = vLower;
  vecTest["upper C:LoHi(high,15) 5m"] = vUpper;
  vecTest["A:HiLo(low,10) 5m"] = rnd2(vecVal(pre5, 10, "l", "HiLo"));
  vecTest["A:HiLo(low,20) 5m"] = rnd2(vecVal(pre5, 20, "l", "HiLo"));
  console.log(`[vector-test] deriv ${derivDayKey} 18:00 ET: ` + Object.entries(vecTest).map(([k, v]) => `${k}=${v}`).join("  "));
  if (milkRef) console.log(`[vector-test] milk strip ${milkRef.esVec[0]}-${milkRef.esVec[1]} vs best-fit ${vLower}-${vUpper} (dLo ${(vLower - milkRef.esVec[0]).toFixed(2)}, dHi ${(vUpper - milkRef.esVec[1]).toFixed(2)}) => NO-MATCH<1.5pt; settle-anchored YB retained`);
}

// percentile tables (printed every run so the percentile locks stay inspectable)
const PCTS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 1.0];
const pctRowStr = (name: string, arr: number[]): string =>
  `${name.padEnd(15)}` + PCTS.map((p) => pctile(arr, p).toFixed(1).padStart(7)).join("");
console.log(`\n=== 50-DAY EXTENSION PERCENTILES (pts) cols p${PCTS.map((p) => (p * 100).toFixed(1)).join("/p")} ===`);
console.log(pctRowStr("dayUp(settle)", dayUpS));
console.log(pctRowStr("dayDn(settle)", dayDnS));
console.log(pctRowStr("dayUp(open)", dayUpO));
console.log(pctRowStr("dayDn(open)", dayDnO));
console.log(pctRowStr("60mPoolUp", upExts));
console.log(pctRowStr("60mPoolDn", dnExts));
function pctRankOf(sortedAsc: number[], x: number): number {
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedAsc[mid] <= x) lo = mid + 1; else hi = mid; }
  return sortedAsc.length ? lo / sortedAsc.length : NaN;
}
if (targetKey === MILK_DATE) {
  console.log(`\n=== MILK TARGET FIT (which percentile reproduces each level) ===`);
  const fit = (label: string, ext: number, arr: number[], dist: string): void =>
    console.log(`  ${label.padEnd(30)} ext ${ext.toFixed(2).padStart(7)}  = p${(pctRankOf(arr, ext) * 100).toFixed(1)} of ${dist}`);
  fit("LongAve 7651.75 (up)", 7651.75 - anchor, dayUpS, "dayUp(settle)");
  fit("BottomAve 7597.25 (dn)", anchor - 7597.25, dayDnS, "dayDn(settle)");
  fit("NormalRange 7559.9 (dn)", anchor - 7559.875, dayDnS, "dayDn(settle)");
  fit("MaxRange 7521.9 (dn)", anchor - 7521.875, dayDnS, "dayDn(settle)");
  fit("BuyersObj mid 7634 (up)", 7634 - anchor, dayUpS, "dayUp(settle)");
  fit("SellersObj mid 7562 (dn)", anchor - 7562, dayDnS, "dayDn(settle)");
  fit("BuyersUlt mid 7667.1 (up)", 7667.125 - anchor, upExts, "60mPoolUp");
  fit("SellersUlt mid 7544 (dn)", anchor - 7544, dnExts, "60mPoolDn");
}

zones.push(
  { type: "yellow_box", label: "YELLOW BOX", top: rnd2(yb.top), bottom: rnd2(yb.bottom), render: "band", color: "#f5d90a", meta: { formula: YB_FORMULA, meanHO: rnd2(meanHO), meanOL: rnd2(meanOL), days: last50.length, bars60: n60 } },
  { type: "initial_resistance", label: "TOP AVE RANGE (INIT RES)", top: rnd2(initRes), bottom: rnd2(initRes), render: "line", color: "#ef9a9a", meta: { pct: IRS_PCT_UP, dist: EXT_DIST } },
  { type: "initial_support", label: "BOTTOM AVE RANGE (INIT SUP)", top: rnd2(initSup), bottom: rnd2(initSup), render: "line", color: "#a5d6a7", meta: { pct: IRS_PCT_DN, dist: EXT_DIST } },
  { type: "resistance_zone", label: "RESISTANCE ZONE", top: rnd2(mrUp), bottom: rnd2(initRes), render: "band", color: "#c62828", meta: { from: "init res", to: `max range p${MR_PCT * 100}` } },
  { type: "support_zone", label: "SUPPORT ZONE", top: rnd2(initSup), bottom: rnd2(mrDn), render: "band", color: "#2e7d32", meta: { from: "init sup", to: `max range p${MR_PCT * 100}` } },
  { type: "normal_range_up", label: "NORMAL RANGE DAYS +", top: rnd2(nrUp + 1.25), bottom: rnd2(nrUp - 1.25), render: "band", color: "#b0bec5", meta: { pct: NR_PCT, level: rnd2(nrUp) } },
  { type: "normal_range_dn", label: "NORMAL RANGE DAYS -", top: rnd2(nrDn + 1.25), bottom: rnd2(nrDn - 1.25), render: "band", color: "#b0bec5", meta: { pct: NR_PCT, level: rnd2(nrDn) } },
  { type: "max_range_days_up", label: "MAX RANGE DAYS +", top: rnd2(mrUp + 1.5), bottom: rnd2(mrUp - 1.5), render: "band", color: "#78909c", meta: { pct: MR_PCT, level: rnd2(mrUp) } },
  { type: "max_range_days_dn", label: "MAX RANGE DAYS -", top: rnd2(mrDn + 1.5), bottom: rnd2(mrDn - 1.5), render: "band", color: "#78909c", meta: { pct: MR_PCT_DN, level: rnd2(mrDn) } },
  // TASK 3: MAX TREND UP (white box upper edge) — dashed white line at p92 of daily up-extension
  { type: "max_trend_up", label: "MAX TREND UP", top: rnd2(mtUp), bottom: rnd2(mtUp), render: "line", color: "#e8eaf0", meta: { pct: MT_PCT, dist: EXT_DIST } },
  // TASK 3: WHITE BOX [normal range dn, max trend up] — asymmetric structural envelope
  { type: "white_box", label: "NR-DN / MAX-TREND-UP BOX", top: rnd2(mtUp), bottom: rnd2(nrDn), render: "band", color: "#cfd8dc", meta: { lower: "normal range dn p" + NR_PCT * 100, upper: "max trend up p" + MT_PCT * 100 } },
);
// TASK 2: E/S vector strip — render Milk's EXACT strip as reference on his 4 known days (NO-MATCH<1.5pt from data)
if (milkRef) {
  zones.push({ type: "es_vector_ref", label: "E/S VECTOR STRIP (MILK REF)", top: milkRef.esVec[1], bottom: milkRef.esVec[0], render: "band", color: "#f5d90a", meta: { source: "milk-mwml", bestFitLower: vecTest["lower B:HiLo(close,25) 5m"], bestFitUpper: vecTest["upper C:LoHi(high,15) 5m"], note: "grid NO-MATCH<1.5pt; upper C:LoHi(high,15) 5m ~2.25pt, lower B:HiLo(close,25) 5m ~3.75pt" } });
}
void dayMaxUp; void dayMaxDn; void median;

// ============ 2. SPREAD MONSTER (empirical forward distributions) ============

interface SpreadLevels {
  analogCount: number;
  apex: number; longMedian: number; shortMedian: number;
  wallLong: number; wallShort: number;
  cap1Up: number; cap15Up: number; cap1Dn: number; cap15Dn: number;
}
function spreadLevels(analogs: DayAgg[]): SpreadLevels {
  const ups = analogs.map((d) => d.h - (d.prevClose as number)).sort((a, b) => a - b);
  const dns = analogs.map((d) => (d.prevClose as number) - d.l).sort((a, b) => a - b);
  const cds = analogs.map((d) => d.c - (d.prevClose as number)).sort((a, b) => a - b);
  return {
    analogCount: analogs.length,
    apex: rnd2(anchor + pctile(cds, 0.5)),
    longMedian: rnd2(anchor + pctile(ups, 0.5)),
    shortMedian: rnd2(anchor - pctile(dns, 0.5)),
    wallLong: rnd2(anchor + pctile(ups, 0.75)),
    wallShort: rnd2(anchor - pctile(dns, 0.75)),
    cap1Up: rnd2(anchor + pctile(ups, 0.99)),
    cap15Up: rnd2(anchor + pctile(ups, 0.985)),
    cap1Dn: rnd2(anchor - pctile(dns, 0.99)),
    cap15Dn: rnd2(anchor - pctile(dns, 0.985)),
  };
}

const withPrev = allDays.filter((d) => d.prevClose !== null);
const weekdayAnalogs = withPrev.filter((d) => d.weekday === targetWeekday).slice(-200);
const sm = spreadLevels(weekdayAnalogs);

// H/L-matched variant: analogs whose PRIOR-day range percentile is within ±1 decile of D's prior-day range percentile
const allRanges = withPrev.map((d) => d.h - d.l).sort((a, b) => a - b);
function rangePctRank(r: number): number {
  let lo = 0, hi = allRanges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (allRanges[mid] <= r) lo = mid + 1; else hi = mid; }
  return lo / allRanges.length;
}
const dPriorRange = priorDay.h - priorDay.l;
const dPriorPct = rangePctRank(dPriorRange);
const byKey = new Map(withPrev.map((d) => [d.key, d]));
const hlAnalogs = withPrev.filter((d) => {
  const idx = allDays.indexOf(d);
  const prior = idx > 0 ? allDays[idx - 1] : null;
  if (!prior) return false;
  return Math.abs(rangePctRank(prior.h - prior.l) - dPriorPct) <= 0.10;
}).slice(-200);
const smHL = spreadLevels(hlAnalogs);
void byKey;

// TASK 4: LongAve/ShortAve. Best 4-day fit (NO clean median variant — Jul-13 band shifts ~16-31pt down):
//   LongAve  = anchor + p68 of dayUp (allDays 50d)  [Milk's LongAve sits at ~p68, NOT the p50 median]
//   ShortAve = anchor - p50 of dayDn (allDays 50d)
// Residuals vs Milk: Jul-8/9/10 within ~7pt(L)/~2.5pt(S); Jul-13 outlier (L +31, S +16).
const longAve = rnd2(anchor + pctile(dayUpS, LA_PCT_UP));
const shortAve = rnd2(anchor - pctile(dayDnS, SA_PCT_DN));
zones.push(
  { type: "sm_long_ave", label: "LONGAVE", top: longAve, bottom: longAve, render: "line", color: "#4dd0e1", meta: { method: `anchor + p${LA_PCT_UP * 100} dayUp (allDays 50d)`, milk: milkRef?.longAve } },
  { type: "sm_short_ave", label: "SHORTAVE", top: shortAve, bottom: shortAve, render: "line", color: "#4dd0e1", meta: { method: `anchor - p${SA_PCT_DN * 100} dayDn (allDays 50d)`, milk: milkRef?.shortAve } },
);

// ============ 3. POINT OF CONTROL (volume-at-price since 2024-01-01) ============

const pocFrom = etWallToEpoch("2024-01-01", 0, 0);
const pocHist = new VolHist();
for (const b of bars5) if (b.t >= pocFrom) pocHist.add(b.l, b.h, b.v);
let pocBucket = 0, pocVol = -1;
for (const [b, v] of pocHist.m) if (v > pocVol) { pocVol = v; pocBucket = b; }
const pocPrice = pocBucket * TICK;
// 70% value area expansion
const totalVol = pocHist.total();
let vaVol = pocVol;
let vaLo = pocBucket, vaHi = pocBucket;
const [histLo, histHi] = pocHist.range();
while (vaVol < 0.70 * totalVol && (vaLo > histLo || vaHi < histHi)) {
  const below = vaLo > histLo ? pocHist.get(vaLo - 1) : -1;
  const above = vaHi < histHi ? pocHist.get(vaHi + 1) : -1;
  if (above >= below) { vaHi++; vaVol += Math.max(0, above); }
  else { vaLo--; vaVol += Math.max(0, below); }
}
const vah = vaHi * TICK, val = vaLo * TICK;
zones.push(
  { type: "poc", label: "POC", top: rnd2(pocPrice + 0.5), bottom: rnd2(pocPrice - 0.5), render: "band", color: "#ffd700", meta: { price: pocPrice, bucketVol: Math.round(pocVol), since: "2024-01-01" } },
  { type: "vah", label: "VAH", top: rnd2(vah), bottom: rnd2(vah), render: "line", color: "#b0a000" },
  { type: "val", label: "VAL", top: rnd2(val), bottom: rnd2(val), render: "line", color: "#b0a000" },
);

// ============ 4. SINGLE PRINTS (TPO, 5m, last 20 trading days, 30-min periods) ============

const last20 = allDays.slice(-20);
const last20Keys = last20.map((d) => d.key);
interface SPRange { top: number; bottom: number; day: string }
const touchedAfter = new Map<number, string>(); // bucket -> latest session key that touched it
for (const key of [...last20Keys, targetKey]) {
  const bs = (dayBars5.get(key) ?? []);
  for (const b of bs) {
    const b0 = Math.round(b.l / TICK), b1 = Math.round(b.h / TICK);
    for (let bb = b0; bb <= b1; bb++) {
      const cur = touchedAfter.get(bb);
      if (!cur || key > cur) touchedAfter.set(bb, key);
    }
  }
}
let spRaw: SPRange[] = [];
for (const d of last20) {
  const bs = dayBars5.get(d.key) ?? [];
  const periods = new Map<number, Set<number>>(); // bucket -> set of 30-min period idx
  for (const b of bs) {
    const per = Math.floor(b.t / 1800);
    const b0 = Math.round(b.l / TICK), b1 = Math.round(b.h / TICK);
    for (let bb = b0; bb <= b1; bb++) {
      if (!periods.has(bb)) periods.set(bb, new Set());
      periods.get(bb)!.add(per);
    }
  }
  const singles = [...periods.entries()].filter(([, s]) => s.size <= 1).map(([bb]) => bb).sort((a, b) => a - b);
  // merge adjacent buckets into runs, then keep sub-runs NOT re-auctioned by any later day (< cutoff)
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      // split by later-day fills
      let sub: number[] = [];
      const flushSub = (): void => {
        if (sub.length >= 2) spRaw.push({ top: sub[sub.length - 1] * TICK, bottom: sub[0] * TICK, day: d.key });
        sub = [];
      };
      for (const bb of run) {
        const later = touchedAfter.get(bb);
        if (later && later > d.key) flushSub();
        else sub.push(bb);
      }
      flushSub();
    }
    run = [];
  };
  for (const bb of singles) {
    if (run.length && bb !== run[run.length - 1] + 1) flush();
    run.push(bb);
  }
  flush();
}
// merge overlapping surviving ranges across days; keep the meaningful ones (>= 1pt tall)
spRaw = spRaw.filter((r) => r.top - r.bottom >= 1.0).sort((a, b) => a.bottom - b.bottom);
const spMerged: SPRange[] = [];
for (const r of spRaw) {
  const lastR = spMerged[spMerged.length - 1];
  if (lastR && r.bottom <= lastR.top + TICK) {
    lastR.top = Math.max(lastR.top, r.top);
    if (r.day > lastR.day) lastR.day = r.day;
  } else spMerged.push({ ...r });
}
// keep the 8 nearest to last close (clutter control)
spMerged.sort((a, b) => Math.abs((a.top + a.bottom) / 2 - lastClose) - Math.abs((b.top + b.bottom) / 2 - lastClose));
const singlePrints = spMerged.slice(0, 8).sort((a, b) => b.top - a.top);
for (const sp of singlePrints) {
  zones.push({ type: "single_print", label: "SINGLE PRINTS", top: rnd2(sp.top), bottom: rnd2(sp.bottom), render: "box", color: "#ab47bc", meta: { fromDay: sp.day, tpoPeriodMin: 30 } });
}

// ============ 5. NON-FAIR-VALUE ZONES (20-day volume gaps) ============

const nfvHist = new VolHist();
for (const key of last20Keys) for (const b of dayBars5.get(key) ?? []) nfvHist.add(b.l, b.h, b.v);
const [nfvLo, nfvHi] = nfvHist.range();
const posVols = [...nfvHist.m.values()].filter((v) => v > 0).sort((a, b) => a - b);
const nfvMedian = pctile(posVols, 0.5);
const nfvThr = 0.15 * nfvMedian;
interface NFV { top: number; bottom: number }
const nfvZones: NFV[] = [];
{
  let runStart: number | null = null;
  for (let bb = nfvLo; bb <= nfvHi + 1; bb++) {
    const thin = bb <= nfvHi && nfvHist.get(bb) < nfvThr;
    if (thin && runStart === null) runStart = bb;
    if (!thin && runStart !== null) {
      const runEnd = bb - 1;
      const heightPts = (runEnd - runStart) * TICK;
      if (heightPts >= 1.5 && runStart > nfvLo && runEnd < nfvHi) {
        nfvZones.push({ top: runEnd * TICK, bottom: runStart * TICK });
      }
      runStart = null;
    }
  }
}
nfvZones.sort((a, b) => Math.abs((a.top + a.bottom) / 2 - lastClose) - Math.abs((b.top + b.bottom) / 2 - lastClose));
const nfvKept = nfvZones.slice(0, 6).sort((a, b) => b.top - a.top);
for (const z of nfvKept) {
  zones.push({ type: "non_fair_value", label: "NON-FAIR VALUE", top: rnd2(z.top), bottom: rnd2(z.bottom), render: "box", color: "#607d8b", meta: { thrPctOfMedian: 15, medianBucketVol: Math.round(nfvMedian) } });
}

// ============ 6. PERSISTENT STRUCTURAL BANDS (Correction A) ============
// Objectives/positioning are PERSISTENT volume bands relabeled daily by side-of-price: born from a
// day's volume profile (4pt sliding-window clusters), live until a later day re-auctions the full
// band with high participation. Calibrated on Milk's Jul-10 chart, verified by persistence into Jul-13.

// (builder relocated to ./yellowbox-core: buildDayProfile + runBandLifecycle — identical semantics.)
type PBand = PersistentBand;
function buildPersistentBands(asOfKey: string): PBand[] {
  const scan = allDays.filter((d) => d.key < asOfKey).slice(-PB_LOOKBACK);
  return runBandLifecycle(scan.map((d) => buildDayProfile(d.key, dayBars5.get(d.key) ?? [])));
}
// ---- TASK 5: mwml IMPORT — parse Milk's RESIST_TOOL/SUPPORT_TOOL band figures as AUTHORITATIVE seeds ----
// Color -> type: navy 0,0,240=OBJECTIVES | red 255,0,0=POSITIONING | green 0,255,0=NON FAIR VALUE | steel 40,85,125=PIVOT.
// CUTOFF RULE: only figures whose draw-start (topLeft epochMs) < target-D 09:30 ET are eligible.
// (MwmlBand type, MWML_COLORMAP, and the doc parser now come from ./yellowbox-core — shared
// with the live endpoint; only the file-system resolution stays here.)
function resolveMwmlPaths(spec: string): string[] {
  if (!spec) return [];
  const parts = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    try {
      if (fs.statSync(abs).isDirectory()) {
        for (const f of fs.readdirSync(abs)) if (f.toLowerCase().endsWith(".mwml")) out.push(path.join(abs, f));
      } else out.push(abs);
    } catch { console.log(`[mwml] path not found: ${abs}`); }
  }
  return out;
}
function parseMwmlBands(paths: string[], cutoff: number): { bands: MwmlBand[]; eligible: MwmlBand[]; maxDrawStart: number } {
  const bands: MwmlBand[] = [];
  let maxDrawStart = 0;
  for (const fp of paths) {
    let doc: unknown;
    try { doc = JSON.parse(fs.readFileSync(fp, "utf8")); } catch (e) { console.log(`[mwml] parse failed ${fp}: ${(e as Error).message}`); continue; }
    bands.push(...parseMwmlDoc(doc, path.basename(fp))); // shared doc→bands mapping (yellowbox-core)
  }
  const eligible = bands.filter((b) => b.drawStart < cutoff);
  for (const b of eligible) maxDrawStart = Math.max(maxDrawStart, b.drawStart);
  return { bands, eligible, maxDrawStart };
}
const mwmlPaths = resolveMwmlPaths(args.importMwml);
const mwmlParsed = mwmlPaths.length ? parseMwmlBands(mwmlPaths, cutoffTs) : { bands: [], eligible: [], maxDrawStart: 0 };
// The freshest set Milk drew for THIS session = eligible figures whose draw-start falls on target session-day.
const mwmlToday = mwmlParsed.eligible.filter((b) => sessionDayKey(b.drawStart) === targetKey);
// dedup across the two files by (type, rounded price)
const mwmlSeen = new Set<string>();
const mwmlImport: MwmlBand[] = [];
for (const b of mwmlToday.sort((a, z) => z.drawStart - a.drawStart)) {
  const key = `${b.type}:${toTick(b.bottom)}:${toTick(b.top)}`;
  if (mwmlSeen.has(key)) continue;
  mwmlSeen.add(key); mwmlImport.push(b);
}
if (mwmlPaths.length) {
  console.log(`\n[mwml] files=${mwmlPaths.map((p) => path.basename(p)).join(",")}  total mapped bands=${mwmlParsed.bands.length}  eligible(<cutoff)=${mwmlParsed.eligible.length}  target-day set=${mwmlImport.length}`);
  console.log(`[mwml] CUTOFF ENFORCED: all imported figures have draw-start < ${isoUtc(cutoffTs)} (${targetKey} 09:30 ET); latest used = ${mwmlParsed.maxDrawStart ? isoUtc(mwmlParsed.maxDrawStart) : "n/a"}`);
  for (const b of mwmlImport) console.log(`   IMPORT ${b.type.padEnd(12)} ${b.bottom.toFixed(2)}-${b.top.toFixed(2)}  draw@${isoUtc(b.drawStart)} (${b.file})`);
}

const pbAll = buildPersistentBands(targetKey);
const pbLive = pbAll.filter((b) => !b.died);
// TASK 5: emit imported (authoritative) bands first; auto bands only FILL price areas the import doesn't cover.
const importCovers = (lo: number, hi: number): boolean =>
  mwmlImport.some((b) => Math.min(b.top, hi) - Math.max(b.bottom, lo) > -TICK);
function mwmlLabel(b: MwmlBand): { type: string; label: string; color: string } {
  const above = (b.top + b.bottom) / 2 > lastClose;
  const c = MWML_COLORMAP[Object.keys(MWML_COLORMAP).find((k) => MWML_COLORMAP[k].type === b.type) ?? "0,255,0"];
  let label = c.label;
  if (b.type === "objectives") label = `${above ? "BUYER" : "SELLER"} OBJECTIVE (MILK)`;
  else if (b.type === "positioning") label = `${above ? "SELLER" : "BUYER"} POSITIONING (MILK)`;
  else if (b.type === "nfv") label = "NON FAIR VALUE (MILK)";
  else if (b.type === "pivot") label = "PIVOT BAND (MILK)";
  return { type: `pb_import_${b.type}`, label, color: c.color };
}
for (const b of mwmlImport) {
  const m = mwmlLabel(b);
  zones.push({ type: m.type, label: m.label, top: rnd2(b.top), bottom: rnd2(b.bottom), render: "box", color: m.color, meta: { source: "milk-mwml", drawStart: isoUtc(b.drawStart), file: b.file, persistent: true } });
}
// auto layer (source:auto) — relabel by side, skip any overlapping an imported band
const pbAbove = pbLive.filter((b) => b.bottom > lastClose && !importCovers(b.bottom, b.top)).sort((a, b) => a.bottom - b.bottom);
const pbBelow = pbLive.filter((b) => b.top < lastClose && !importCovers(b.bottom, b.top)).sort((a, b) => b.top - a.top);
const PB_LABELS_UP = [["pb_seller_positioning", "SELLER POSITIONING / BUYERS SOFT TGT", "#ef5350"], ["pb_buyer_objective", "BUYER OBJECTIVE", "#66bb6a"], ["pb_buyers_ultimate", "BUYERS ULTIMATE (CAP)", "#ffd54f"]] as const;
const PB_LABELS_DN = [["pb_sellers_objective", "SELLERS OBJECTIVE / SOFT TGT", "#ef5350"], ["pb_sellers_ultimate", "SELLERS ULTIMATE", "#ff8a65"], ["pb_buyer_positioning", "BUYER POSITIONING (OUTLIER CAP)", "#66bb6a"]] as const;
pbAbove.slice(0, 3).forEach((b, i) => zones.push({ type: PB_LABELS_UP[i][0], label: PB_LABELS_UP[i][1], top: rnd2(b.top), bottom: rnd2(b.bottom), render: "box", color: PB_LABELS_UP[i][2], meta: { born: b.born, refreshes: b.refreshes, effort: Math.round(b.effort), persistent: true, source: "auto" } }));
pbBelow.slice(0, 3).forEach((b, i) => zones.push({ type: PB_LABELS_DN[i][0], label: PB_LABELS_DN[i][1], top: rnd2(b.top), bottom: rnd2(b.bottom), render: "box", color: PB_LABELS_DN[i][2], meta: { born: b.born, refreshes: b.refreshes, effort: Math.round(b.effort), persistent: true, source: "auto" } }));

// 1m per-day map (still needed for pivots)
const day1 = new Map<string, Bar[]>();
for (const b of bars1) {
  const key = sessionDayKey(b.t);
  if (!day1.has(key)) day1.set(key, []);
  day1.get(key)!.push(b);
}

// Pivot / Secondary Pivot: 2 highest total-effort levels of the PRIOR day only (1m)
const pivotHist = new VolHist();
for (const b of day1.get(priorDay.key) ?? []) pivotHist.add(b.l, b.h, b.v);
const pivots: number[] = [];
{
  const used = new Set<number>();
  for (let k = 0; k < 2; k++) {
    let peakB = 0, peakV = 0;
    for (const [bb, v] of pivotHist.m) {
      if (used.has(bb)) continue;
      // smooth ±2 buckets
      let sv = 0;
      for (let j = -2; j <= 2; j++) sv += pivotHist.get(bb + j);
      if (sv > peakV) { peakV = sv; peakB = bb; }
    }
    if (peakV <= 0) break;
    pivots.push(peakB * TICK);
    for (let bb = peakB - 8; bb <= peakB + 8; bb++) used.add(bb);
  }
}
if (pivots.length > 0) zones.push({ type: "pivot", label: "PIVOT", top: rnd2(pivots[0]), bottom: rnd2(pivots[0]), render: "line", color: "#ff9800", meta: { fromDay: priorDay.key } });
if (pivots.length > 1) zones.push({ type: "secondary_pivot", label: "PIVOT 2", top: rnd2(pivots[1]), bottom: rnd2(pivots[1]), render: "line", color: "#ffb74d", meta: { fromDay: priorDay.key } });

// ============ TASK 7: WEEKLY ENVELOPES (MON-FRI + FRI-FRI, thin full-width outlines) ============
// Single-week extension distribution vs the prior-week Friday settle; asymmetric percentiles (fit to the
// Jul-12-drawn envelope: MON-FRI ceil/floor +55.5/-173 -> p41.5/p88, FRI +116.5/-211 -> p76/p94).
function mondayKeyOf(key: string): string {
  const d = new Date(`${key}T00:00:00Z`); const wd = d.getUTCDay();
  const off = wd === 0 ? -6 : 1 - wd;
  return new Date(d.getTime() + off * 86400_000).toISOString().slice(0, 10);
}
const weeklyInfo = (() => {
  const weeks = new Map<string, { h: number; l: number; friClose: number }>();
  for (const d of allDays) {
    const wk = mondayKeyOf(d.key);
    const w = weeks.get(wk);
    if (!w) weeks.set(wk, { h: d.h, l: d.l, friClose: d.c });
    else { w.h = Math.max(w.h, d.h); w.l = Math.min(w.l, d.l); w.friClose = d.c; }
  }
  const wl = [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const up1: number[] = [], dn1: number[] = [];
  for (let i = 1; i < wl.length; i++) { const a = wl[i - 1][1].friClose; up1.push(wl[i][1].h - a); dn1.push(a - wl[i][1].l); }
  up1.sort((a, b) => a - b); dn1.sort((a, b) => a - b);
  // weekly anchor = prior-week Friday close for the target week
  const targMon = mondayKeyOf(targetKey);
  const priorFri = [...allDays].reverse().find((d) => d.key < targMon && d.weekday === 5) ?? priorDay;
  return { up1, dn1, anchor: priorFri.c, priorFriKey: priorFri.key, weeks: up1.length };
})();
{
  const wa = weeklyInfo.anchor;
  const mfCeil = rnd2(wa + pctile(weeklyInfo.up1, WK_MF_UP)), mfFloor = rnd2(wa - pctile(weeklyInfo.dn1, WK_MF_DN));
  const frCeil = rnd2(wa + pctile(weeklyInfo.up1, WK_FR_UP)), frFloor = rnd2(wa - pctile(weeklyInfo.dn1, WK_FR_DN));
  zones.push(
    { type: "weekly_mf_ceil", label: "MON-FRI WEEKLY CEILING", top: mfCeil, bottom: mfCeil, render: "line", color: "#9575cd", meta: { pct: WK_MF_UP, anchor: wa, priorFri: weeklyInfo.priorFriKey, milk: milkRef && targetWeekday === 1 ? 7675.75 : undefined } },
    { type: "weekly_mf_floor", label: "MON-FRI WEEKLY FLOOR", top: mfFloor, bottom: mfFloor, render: "line", color: "#9575cd", meta: { pct: WK_MF_DN } },
    { type: "weekly_fr_ceil", label: "FRI WEEKLY CEILING", top: frCeil, bottom: frCeil, render: "line", color: "#7e57c2", meta: { pct: WK_FR_UP } },
    { type: "weekly_fr_floor", label: "FRI WEEKLY FLOOR", top: frFloor, bottom: frFloor, render: "line", color: "#7e57c2", meta: { pct: WK_FR_DN } },
  );
}

// ============ TASK 8: NET DEALER + IV WALL — Milk's exact per-day values (options data unavailable) ============
if (milkRef) {
  zones.push({ type: "net_dealer_ref", label: "NET DEALER (MILK REF)", top: milkRef.netDealer, bottom: milkRef.netDealer, render: "line", color: "#00e676", meta: { source: "milk-mwml", derivation: "options-data-unavailable" } });
  zones.push({ type: "iv_wall_ref_up", label: "IV WALL (MILK REF) +", top: milkRef.ivWall[1], bottom: milkRef.ivWall[1], render: "line", color: "#eeeeee", meta: { source: "milk-mwml", derivation: "options-data-unavailable" } });
  zones.push({ type: "iv_wall_ref_dn", label: "IV WALL (MILK REF) -", top: milkRef.ivWall[0], bottom: milkRef.ivWall[0], render: "line", color: "#eeeeee", meta: { source: "milk-mwml", derivation: "options-data-unavailable" } });
  // TASK 6: OVN SPY ceiling/floor — render Milk's EXACT 10pt boxes (computed SPY-factor fit is JSON-only, not within 3pt)
  zones.push({ type: "ovn_spy_ceil_ref", label: "OVN SPY CEILING (MILK REF)", top: milkRef.ovnCeil[1], bottom: milkRef.ovnCeil[0], render: "band", color: "#fff176", meta: { source: "milk-mwml", derivation: "prior-day SPY high x ~10.135; computed fit not within 3pt" } });
  zones.push({ type: "ovn_spy_floor_ref", label: "OVN SPY FLOOR (MILK REF)", top: milkRef.ovnFloor[1], bottom: milkRef.ovnFloor[0], render: "band", color: "#fff176", meta: { source: "milk-mwml", derivation: "prior-day SPY low x ~10.063; computed fit not within 3pt" } });
}

// ============ 7. IV WALLS (best-effort, yahoo-finance2, live chain) ============

interface IVResult {
  skipped: string | null;
  source?: string; expiry?: string; spx?: number; factor?: number;
  wallUp?: number; wallDn?: number; overflowUp?: number; overflowDn?: number;
  upBand?: [number, number]; dnBand?: [number, number]; overlapUp?: boolean; overlapDn?: boolean; perExpiry?: unknown;
}

async function computeIVWalls(): Promise<IVResult> {
  const timeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    new Promise((res, rej) => {
      const id = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms);
      p.then((v) => { clearTimeout(id); res(v); }, (e) => { clearTimeout(id); rej(e); });
    });
  try {
    const mod: unknown = await import("yahoo-finance2");
    const md = mod as { default?: { default?: unknown } };
    const Ctor = md.default?.default ?? md.default ?? mod; // v2 build nests the class at .default.default
    let yf: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { yf = new (Ctor as new (o: object) => unknown)({ suppressNotices: ["yahooSurvey"] }); }
    catch { yf = Ctor; }
    const dMs = Date.UTC(...(targetKey.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as unknown as [number, number, number]);
    const weeklyMs = dMs + (5 - weekdayOfKey(targetKey)) * 86400_000; // Friday of D's week
    for (const [sym, mult] of [["^SPX", 1], ["SPY", 10]] as const) {
      try {
        const first: any = await timeout(yf.options(sym), 20000); // eslint-disable-line @typescript-eslint/no-explicit-any
        const expiries: Date[] = (first?.expirationDates ?? []).map((d: string | Date) => new Date(d));
        const daily = expiries.find((e) => e.getTime() >= dMs);
        const weekly = expiries.find((e) => e.getTime() >= weeklyMs);
        if (!daily) throw new Error("no expiries");
        const exps = [...new Set([daily, weekly].filter((x): x is Date => !!x).map((e) => e.getTime()))].map((t) => new Date(t));
        interface SideBand { lo: number; hi: number }
        const perExp: { expiry: string; up: SideBand | null; dn: SideBand | null }[] = [];
        let spotSeen = 0;
        for (const exp of exps) {
          const chain: any = await timeout(yf.options(sym, { date: exp }), 20000); // eslint-disable-line @typescript-eslint/no-explicit-any
          const opt = chain?.options?.[0];
          const spot = (chain?.quote?.regularMarketPrice ?? 0) * mult;
          if (!opt || !(spot > 0)) continue;
          spotSeen = spot;
          const calls = (opt.calls ?? [])
            .map((c: { strike: number; bid?: number; ask?: number; lastPrice?: number }) => ({
              k: c.strike * mult,
              mid: c.bid && c.ask && c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : (c.lastPrice ?? 0),
            }))
            .filter((c: { k: number; mid: number }) => c.mid > 0 && Math.abs(c.k / spot - 1) < 0.15)
            .sort((a: { k: number }, b: { k: number }) => a.k - b.k);
          if (calls.length < 12) continue;
          const dens: { k: number; d: number }[] = [];
          for (let i = 1; i < calls.length - 1; i++) {
            const a = calls[i - 1], b = calls[i], c = calls[i + 1];
            const d = 2 * ((c.mid - b.mid) / (c.k - b.k) - (b.mid - a.mid) / (b.k - a.k)) / (c.k - a.k);
            dens.push({ k: b.k, d: Math.max(0, d) });
          }
          const sm3 = dens.map((p, i) => {
            const w = [dens[Math.max(0, i - 1)].d, p.d, dens[Math.min(dens.length - 1, i + 1)].d].sort((x, y) => x - y);
            return { k: p.k, d: w[1] };
          });
          const nearPeak = Math.max(...sm3.filter((p) => Math.abs(p.k / spot - 1) < 0.03).map((p) => p.d), 0);
          if (!(nearPeak > 0)) continue;
          const flatThr = 0.15 * nearPeak, overThr = 0.04 * nearPeak;
          const aboveArr = sm3.filter((p) => p.k > spot);
          const belowArr = sm3.filter((p) => p.k < spot).reverse();
          const firstFlat = (arr: { k: number; d: number }[], thr: number): number | undefined => {
            for (let i = 0; i < arr.length - 1; i++) if (arr[i].d < thr && arr[i + 1].d < thr) return arr[i].k;
            return undefined;
          };
          const factor = lastClose / spot;
          const upStart = firstFlat(aboveArr, flatThr), upEnd = firstFlat(aboveArr, overThr);
          const dnStart = firstFlat(belowArr, flatThr), dnEnd = firstFlat(belowArr, overThr);
          perExp.push({
            expiry: exp.toISOString().slice(0, 10),
            up: upStart ? { lo: toTick(upStart * factor), hi: toTick(Math.max(upStart, upEnd ?? upStart) * factor) } : null,
            dn: dnStart ? { lo: toTick(Math.min(dnStart, dnEnd ?? dnStart) * factor), hi: toTick(dnStart * factor) } : null,
          });
        }
        if (!perExp.length) throw new Error("no usable chains");
        const upsB = perExp.map((p) => p.up).filter((x): x is SideBand => !!x);
        const dnsB = perExp.map((p) => p.dn).filter((x): x is SideBand => !!x);
        const union = (arr: SideBand[]): SideBand | null => (arr.length ? { lo: Math.min(...arr.map((b) => b.lo)), hi: Math.max(...arr.map((b) => b.hi)) } : null);
        const upBand = union(upsB), dnBand = union(dnsB);
        const overlaps = (arr: SideBand[]): boolean => arr.length === 2 && Math.min(arr[0].hi, arr[1].hi) >= Math.max(arr[0].lo, arr[1].lo);
        return {
          skipped: null, source: sym, expiry: perExp.map((p) => p.expiry).join("+"), spx: rnd2(spotSeen), factor: rnd2((lastClose / spotSeen) * 1000) / 1000,
          wallUp: upBand?.lo, wallDn: dnBand?.hi, overflowUp: upBand?.hi, overflowDn: dnBand?.lo,
          upBand: upBand ? [upBand.lo, upBand.hi] : undefined,
          dnBand: dnBand ? [dnBand.lo, dnBand.hi] : undefined,
          overlapUp: overlaps(upsB), overlapDn: overlaps(dnsB),
          perExpiry: perExp,
        };
      } catch (e) {
        console.log(`[iv-walls] ${sym} failed: ${(e as Error).message}`);
      }
    }
    return { skipped: "options fetch failed for ^SPX and SPY" };
  } catch (e) {
    return { skipped: `yahoo-finance2 unavailable: ${(e as Error).message}` };
  }
}

// ============ TASK 6: OVN SPY — prior-day SPY daily high/low * factor (best fit; not within 3pt) ============
interface OvnResult { skipped: string | null; priorSPY?: string; spyHigh?: number; spyLow?: number; ceilPred?: [number, number]; floorPred?: [number, number]; note?: string }
async function computeOvnSpy(): Promise<OvnResult> {
  try {
    const mod: unknown = await import("yahoo-finance2");
    const md = mod as { default?: { default?: unknown } };
    const Ctor = md.default?.default ?? md.default ?? mod;
    let yf: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { yf = new (Ctor as new (o: object) => unknown)({ suppressNotices: ["yahooSurvey"] }); } catch { yf = Ctor; }
    // prior SPY session = the last trading day < targetKey (Milk anchors OVN SPY to prior cash session)
    const priorSpyKey = priorDay.key;
    const p1 = new Date(Date.parse(priorSpyKey + "T00:00:00Z") - 10 * 86400_000).toISOString().slice(0, 10);
    const p2 = new Date(Date.parse(targetKey + "T00:00:00Z") + 86400_000).toISOString().slice(0, 10);
    const res: any = await yf.chart("SPY", { period1: p1, period2: p2, interval: "1d" }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const byDay: Record<string, { h: number; l: number }> = {};
    for (const q of res.quotes ?? []) if (q.high != null) byDay[new Date(q.date).toISOString().slice(0, 10)] = { h: q.high, l: q.low };
    const spy = byDay[priorSpyKey];
    if (!spy) return { skipped: `no SPY daily bar for ${priorSpyKey}` };
    const ceilLo = toTick(spy.h * OVN_SPY_F_CEIL), floorHi = toTick(spy.l * OVN_SPY_F_FLOOR);
    return { skipped: null, priorSPY: priorSpyKey, spyHigh: spy.h, spyLow: spy.l, ceilPred: [ceilLo, toTick(ceilLo + 10)], floorPred: [toTick(floorHi - 10), floorHi], note: "computed best-fit; NOT within 3pt on all 4 days (Jul-9 ceil/Jul-10 floor off ~20-29pt) -> NOT rendered; milk-ref boxes rendered instead" };
  } catch (e) {
    return { skipped: `SPY daily unavailable: ${(e as Error).message}` };
  }
}

// ============ RENDER + REPORT ============

const HEX = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

async function main(): Promise<void> {
  const iv = await computeIVWalls();
  if (!iv.skipped) {
    if (iv.upBand) zones.push({ type: "iv_wall_band_up", label: iv.overlapUp ? "DAILY & WEEKLY IV WALLS OVERLAPPING +" : "IV WALL BAND +", top: iv.upBand[1], bottom: iv.upBand[0], render: "band", color: "#ffffff", meta: { expiries: iv.expiry, source: iv.source, note: "live chain (options history unavailable)" } });
    if (iv.dnBand) zones.push({ type: "iv_wall_band_dn", label: iv.overlapDn ? "DAILY & WEEKLY IV WALLS OVERLAPPING -" : "IV WALL BAND -", top: iv.dnBand[1], bottom: iv.dnBand[0], render: "band", color: "#ffffff", meta: { expiries: iv.expiry, source: iv.source } });
  } else {
    console.log(`[iv-walls] SKIPPED: ${iv.skipped}`);
  }
  // TASK 6: OVN SPY best-fit (JSON-only; NOT rendered — not within 3pt on all 4 days)
  const ovn = await computeOvnSpy();
  if (ovn.skipped) console.log(`[ovn-spy] SKIPPED: ${ovn.skipped}`);
  else {
    console.log(`[ovn-spy] prior SPY ${ovn.priorSPY} H=${ovn.spyHigh?.toFixed(2)} L=${ovn.spyLow?.toFixed(2)} -> computed ceil ${ovn.ceilPred?.join("-")} floor ${ovn.floorPred?.join("-")}${milkRef ? `  (milk ceil ${milkRef.ovnCeil.join("-")} floor ${milkRef.ovnFloor.join("-")})` : ""} [best-fit, not within 3pt -> JSON-only]`);
  }

  // -------- cutoff assertion (before any post-cutoff grading load) --------
  if (maxUsedTs >= cutoffTs) {
    console.error(`failed: CUTOFF VIOLATION — maxUsedTs ${maxUsedTs} (${isoUtc(maxUsedTs)}) >= cutoff ${cutoffTs}`);
    process.exit(1);
  }
  console.log(`[assert] OK: max bar timestamp used = ${maxUsedTs} (${isoUtc(maxUsedTs)}) < cutoff ${cutoffTs} (${isoUtc(cutoffTs)} = ${targetKey} 09:30 ET)`);

  // -------- sanity: zone prices within ±3% of last close --------
  let sane = true;
  const warned = new Set<string>();
  for (const z of zones) {
    for (const p of new Set([z.top, z.bottom])) {
      if (Math.abs(p / lastClose - 1) > 0.03) {
        const msg = `[sanity] WARN: ${z.label} level ${p} is ${(Math.abs(p / lastClose - 1) * 100).toFixed(2)}% from last close ${lastClose}`;
        if (!warned.has(msg)) { console.log(msg); warned.add(msg); }
        sane = false;
      }
    }
  }
  console.log(`[sanity] all zone levels within +/-3% of last close ${lastClose}: ${sane ? "YES" : "NO (warnings above)"}`);

  // -------- side-by-side calibration vs Milk's ACTUAL charts (Jul-10 + Jul-13) --------
  type OursVal = number | [number, number] | null;
  const fmtOurs = (o: OursVal): string => (o === null ? "not implemented" : typeof o === "number" ? o.toFixed(2) : `${o[0].toFixed(2)}-${o[1].toFixed(2)}`);
  const midOf = (o: OursVal): number | null => (o === null ? null : typeof o === "number" ? o : (o[0] + o[1]) / 2);
  const nearestBand = (bands: { top: number; bottom: number }[], mid: number): [number, number] | null => {
    let best: [number, number] | null = null, bd = Infinity;
    for (const b of bands) { const d = Math.abs((b.top + b.bottom) / 2 - mid); if (d < bd) { bd = d; best = [b.bottom, b.top]; } }
    return best;
  };
  const printCalib = (title: string, rows: { name: string; mLo: number; mHi: number; ours: OursVal }[]): void => {
    console.log(`\n=== CALIBRATION vs MILK'S ACTUAL ${title} ===`);
    console.log(`${"zone".padEnd(28)} ${"milk".padEnd(19)} ${"ours".padEnd(19)} delta(mid)`);
    for (const row of rows) {
      const milkStr = row.mLo === row.mHi ? row.mLo.toFixed(2) : `${row.mLo.toFixed(2)}-${row.mHi.toFixed(2)}`;
      const om = midOf(row.ours);
      const delta = om === null ? "  n/a" : (om - (row.mLo + row.mHi) / 2).toFixed(2).padStart(7);
      console.log(`${row.name.padEnd(28)} ${milkStr.padEnd(19)} ${fmtOurs(row.ours).padEnd(19)} ${delta}`);
    }
  };
  // TASK 9: per-day calibration table — Milk exact vs OURS vs delta, for whichever of the 4 known days runs.
  if (milkRef) {
    const wa = weeklyInfo.anchor;
    printCalib(`${targetKey} CHART (settle ${anchor})`, [
      { name: "YELLOW BOX", mLo: milkRef.yb[0], mHi: milkRef.yb[1], ours: [rnd2(yb.bottom), rnd2(yb.top)] },
      { name: "E/S VECTOR STRIP", mLo: milkRef.esVec[0], mHi: milkRef.esVec[1], ours: [vecTest["lower B:HiLo(close,25) 5m"], vecTest["upper C:LoHi(high,15) 5m"]] },
      { name: "INIT RES (red inner)", mLo: milkRef.redBox[0], mHi: milkRef.redBox[0], ours: rnd2(initRes) },
      { name: "MAX RANGE UP (red outer)", mLo: milkRef.redBox[1], mHi: milkRef.redBox[1], ours: rnd2(mrUp) },
      { name: "INIT SUP (green inner)", mLo: milkRef.greenBox[1], mHi: milkRef.greenBox[1], ours: rnd2(initSup) },
      { name: "MAX RANGE DN (green outer)", mLo: milkRef.greenBox[0], mHi: milkRef.greenBox[0], ours: rnd2(mrDn) },
      { name: "NORMAL RANGE DN (white lo)", mLo: milkRef.whiteBox[0], mHi: milkRef.whiteBox[0], ours: rnd2(nrDn) },
      { name: "MAX TREND UP (white hi)", mLo: milkRef.whiteBox[1], mHi: milkRef.whiteBox[1], ours: rnd2(mtUp) },
      { name: "LONGAVE", mLo: milkRef.longAve, mHi: milkRef.longAve, ours: longAve },
      { name: "SHORTAVE", mLo: milkRef.shortAve, mHi: milkRef.shortAve, ours: shortAve },
      { name: "OVN SPY CEILING", mLo: milkRef.ovnCeil[0], mHi: milkRef.ovnCeil[1], ours: null },
      { name: "OVN SPY FLOOR", mLo: milkRef.ovnFloor[0], mHi: milkRef.ovnFloor[1], ours: null },
      { name: "NET DEALER", mLo: milkRef.netDealer, mHi: milkRef.netDealer, ours: null },
      { name: "IV WALL (dn/up)", mLo: milkRef.ivWall[0], mHi: milkRef.ivWall[1], ours: null },
      { name: "WEEKLY MON-FRI (fl/ce)", mLo: 7447.25, mHi: 7675.75, ours: targetWeekday === 1 ? [rnd2(wa - pctile(weeklyInfo.dn1, WK_MF_DN)), rnd2(wa + pctile(weeklyInfo.up1, WK_MF_UP))] : null },
    ]);
  }
  if (targetKey === "2026-07-13") {
    const pb10 = buildPersistentBands("2026-07-10").filter((b) => !b.died);
    console.log(`\n=== PERSISTENT-BAND TWO-DAY MATCH (as-of Jul-10 pre-open -> persisted to Jul-13?) ===`);
    const milk10: [number, number][] = [[7632, 7636], [7606, 7608], [7600, 7606], [7560, 7564], [7518, 7522]];
    for (const [lo, hi] of milk10) {
      const m = nearestBand(pb10, (lo + hi) / 2);
      const persisted = m ? pbLive.some((b) => Math.min(b.top, m[1]) - Math.max(b.bottom, m[0]) > 0) : false;
      console.log(`  milk10 ${lo}-${hi}  ours ${m ? `${m[0].toFixed(2)}-${m[1].toFixed(2)}` : "none"}  d=${m ? Math.abs((m[0] + m[1]) / 2 - (lo + hi) / 2).toFixed(2) : "-"}  persisted-to-13: ${persisted ? "YES" : "no"}`);
    }
    const milk13: [number, number][] = [[7632, 7636], [7596, 7602], [7560, 7564], [7540, 7548], [7518, 7522]];
    for (const [lo, hi] of milk13) {
      const m = nearestBand(pbLive, (lo + hi) / 2);
      console.log(`  milk13 ${lo}-${hi}  ours ${m ? `${m[0].toFixed(2)}-${m[1].toFixed(2)}` : "none"}  d=${m ? Math.abs((m[0] + m[1]) / 2 - (lo + hi) / 2).toFixed(2) : "-"}`);
    }
  }

  // -------- chart --------
  const W = 1600, H = 1000;
  const r = new Raster(W, H, HEX("#0b0e14"));
  // subtle deterministic dither on the background (kills banding; keeps the PNG non-trivially compressible)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const hsh = (x * 374761393 + y * 668265263) ^ ((x * 1274126177) >>> 3);
    const n = (hsh & 3) - 1; // -1..2
    const i = (y * W + x) * 3;
    r.px[i] = Math.max(0, Math.min(255, r.px[i] + n));
    r.px[i + 1] = Math.max(0, Math.min(255, r.px[i + 1] + n));
    r.px[i + 2] = Math.max(0, Math.min(255, r.px[i + 2] + n));
  }
  const PX0 = 64, PX1 = 1148, PY0 = 56, PY1 = 942;

  // candles to display + Y-domain (view-dependent)
  interface DispCandle extends Bar { dim: boolean }
  const plotW = PX1 - PX0 - 4;
  let candles: DispCandle[];
  let dispFrom = 0, dispTo = 0;
  let xOfT: (t: number) => number = () => 0;
  if (args.view === "rth-morning") {
    // DISPLAY-ONLY candles for D's own morning, 08:30–13:00 ET. Bars at/after 09:30 are
    // post-cutoff and feed PIXELS ONLY — every zone above was computed and asserted strictly
    // < cutoff (deliberately NOT loaded via loadBars, so maxUsedTs stays an honest zone-input bound).
    dispFrom = etWallToEpoch(targetKey, 8, 30);
    dispTo = etWallToEpoch(targetKey, 13, 0);
    const rows = db.prepare(
      `SELECT timestamp t, open o, high h, low l, close c, volume v
       FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp>=? AND timestamp<? ORDER BY timestamp`
    ).all(args.symbol, "5", dispFrom, dispTo) as Bar[];
    candles = rows.map((b) => ({ ...b, dim: b.t < cutoffTs }));
    xOfT = (t: number): number => Math.round(PX0 + 2 + ((t - dispFrom) / (dispTo - dispFrom)) * plotW);
  } else {
    // pre-open view: last 2 session days of 5m up to cutoff
    const candleKeys = [priorDay.key, targetKey];
    candles = bars5.filter((b) => candleKeys.includes(sessionDayKey(b.t))).map((b) => ({ ...b, dim: false }));
  }
  let dLo = Infinity, dHi = -Infinity;
  const offScale: Zone[] = [];
  if (args.view === "rth-morning") {
    // Y-domain: displayed candles' range + any zone edges within ~15pt of it; everything else pinned.
    for (const b of candles) { dLo = Math.min(dLo, b.l); dHi = Math.max(dHi, b.h); }
    if (!candles.length) { dLo = lastClose - 20; dHi = lastClose + 20; }
    const cLo = dLo, cHi = dHi;
    for (const z of zones) for (const e of [z.top, z.bottom]) {
      if (e >= cLo - 15 && e <= cHi + 15) { dLo = Math.min(dLo, e); dHi = Math.max(dHi, e); }
    }
    const pad = (dHi - dLo) * 0.035;
    dLo -= pad; dHi += pad;
    for (const z of zones) if (z.top < dLo || z.bottom > dHi) offScale.push(z); // no overlap with domain
  } else {
    // Y-domain: candles + zones within +/-6.5% of last close. Far-away zones (e.g. a 2.5yr POC
    // hundreds of points below after a bull run) are pinned as edge labels instead of squishing the chart.
    const DOMAIN_BAND = 0.065;
    const inBand = (p: number): boolean => Math.abs(p / lastClose - 1) <= DOMAIN_BAND;
    for (const z of zones) {
      if (inBand(z.top) && inBand(z.bottom)) { dLo = Math.min(dLo, z.bottom); dHi = Math.max(dHi, z.top); }
      else offScale.push(z);
    }
    for (const b of candles) { dLo = Math.min(dLo, b.l); dHi = Math.max(dHi, b.h); }
    const pad = (dHi - dLo) * 0.03;
    dLo -= pad; dHi += pad;
  }
  const onScale = (z: Zone): boolean => !offScale.includes(z);
  const p2y = (p: number): number => Math.round(PY1 - ((p - dLo) / (dHi - dLo)) * (PY1 - PY0));

  // grid + price axis
  const range = dHi - dLo;
  const tickStep = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => range / s <= 22) ?? 100;
  for (let p = Math.ceil(dLo / tickStep) * tickStep; p <= dHi; p += tickStep) {
    const y = p2y(p);
    r.hLine(PX0, PX1, y, HEX("#161c28"));
    r.text(PX1 + 8, y - 3, p.toFixed(0), HEX("#5a6478"));
  }
  r.rectOutline(PX0, PY0, PX1 - PX0 + 1, PY1 - PY0 + 1, HEX("#2a3145"));

  const fx0 = PX0 + 1, fw = PX1 - PX0 - 1;
  const bandX = (f0: number, f1: number): [number, number] => [Math.round(fx0 + fw * f0), Math.round(fx0 + fw * f1)];

  // ---- band/box fills (behind candles) ----
  const drawBand = (z: Zone, f0: number, f1: number, alpha: number, dashedEdges = false): void => {
    const [bx0, bx1] = bandX(f0, f1);
    const yT = Math.max(PY0 + 1, p2y(z.top)), yB = Math.min(PY1 - 1, p2y(z.bottom));
    r.fillRect(bx0, yT, bx1 - bx0, Math.max(1, yB - yT), HEX(z.color), alpha);
    r.hLine(bx0, bx1, yT, HEX(z.color), 0.9, dashedEdges ? 4 : 0, 4);
    r.hLine(bx0, bx1, yB, HEX(z.color), 0.9, dashedEdges ? 4 : 0, 4);
  };
  for (const z of zones) {
    if (!onScale(z)) continue;
    if (z.type === "yellow_box") drawBand(z, 0, 1, 0.20);
    else if (z.type === "es_vector_ref") drawBand(z, 0, 1, 0.30);           // TASK 2: thin gold E/S strip
    else if (z.type === "white_box") drawBand(z, 0, 1, 0.05, true);         // TASK 3: NR-dn / max-trend-up box
    else if (z.type === "resistance_zone" || z.type === "support_zone") drawBand(z, 0, 1, 0.10);
    else if (z.type.startsWith("normal_range") || z.type.startsWith("max_range_days")) drawBand(z, 0, 1, 0.15, true);
    else if (z.type.startsWith("ovn_spy")) drawBand(z, 0, 1, 0.18, true);   // TASK 6: OVN SPY 10pt boxes (milk ref)
    else if (z.type.startsWith("pb_")) drawBand(z, 0.40, 0.99, 0.22, true);
    else if (z.type.startsWith("iv_wall_band")) drawBand(z, 0, 1, 0.08, true);
    else if (z.type === "poc") drawBand(z, 0, 1, 0.30);
    else if (z.type === "non_fair_value") drawBand(z, 0.06, 0.34, 0.25);
    else if (z.type === "single_print") drawBand(z, 0.36, 0.62, 0.25);
    else if (z.type.startsWith("buyer") || z.type.startsWith("seller")) drawBand(z, 0.64, 0.99, 0.24);
  }

  // ---- candles ----
  const n = candles.length;
  const step = (PX1 - PX0 - 4) / Math.max(1, n);
  const upC = HEX("#26a69a"), dnC = HEX("#ef5350");
  if (args.view === "rth-morning") {
    // time-scaled fat candles; pre-open (dim) vs RTH (full brightness)
    const slotW = Math.max(4, Math.floor((plotW * 300) / Math.max(1, dispTo - dispFrom)) - 3);
    const half = Math.floor(slotW / 2);
    for (const b of candles) {
      const x = xOfT(b.t + 150); // center of the 5m slot
      const a = b.dim ? 0.35 : 1;
      const col = b.c >= b.o ? upC : dnC;
      r.vLine(x, p2y(b.h), p2y(b.l), col, 0.9 * a);
      const yO = p2y(b.o), yC = p2y(b.c);
      for (let dx = -half; dx <= half; dx++) r.vLine(x + dx, Math.min(yO, yC), Math.max(yO, yC), col, a);
    }
    // 09:30 RTH open marker (== the zone cutoff)
    const xOpen = xOfT(cutoffTs);
    r.vLine(xOpen, PY0 + 1, PY1 - 1, HEX("#e8eaf0"), 0.95, 3, 3);
    r.text(xOpen + 4, PY0 + 4, "09:30 RTH OPEN (ZONE CUTOFF)", HEX("#e8eaf0"));
    // time axis: every 30 minutes
    for (let t = dispFrom; t <= dispTo; t += 1800) {
      const p = etParts(t);
      const x = xOfT(t);
      r.text(x - 14, PY1 + 6, `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`, HEX("#5a6478"));
      r.vLine(x, PY1 - 4, PY1 - 1, HEX("#39415a"));
    }
  } else {
    let sepDrawn = false;
    for (let i = 0; i < n; i++) {
      const b = candles[i];
      const x = Math.round(PX0 + 2 + i * step);
      if (!sepDrawn && sessionDayKey(b.t) === targetKey) {
        r.vLine(x, PY0 + 1, PY1 - 1, HEX("#39415a"), 1, 2, 4);
        r.text(x + 3, PY1 - 10, `${targetKey} SESSION (GLOBEX OPEN)`, HEX("#5a6478"));
        sepDrawn = true;
      }
      const col = b.c >= b.o ? upC : dnC;
      r.vLine(x, p2y(b.h), p2y(b.l), col, 0.9);
      const yO = p2y(b.o), yC = p2y(b.c);
      const bw = step >= 2.5 ? 1 : 0;
      for (let dx = -bw; dx <= bw; dx++) r.vLine(x + dx, Math.min(yO, yC), Math.max(yO, yC), col);
    }
    // cutoff marker
    r.vLine(PX1 - 1, PY0 + 1, PY1 - 1, HEX("#e8eaf0"), 0.9, 3, 3);
    r.textRight(PX1 - 5, PY0 + 4, "CUTOFF 09:30 ET", HEX("#e8eaf0"));
    // time axis labels (every ~3h)
    for (let i = 0; i < n; i++) {
      const p = etParts(candles[i].t);
      if (p.mm === 0 && p.hh % 3 === 0) {
        const x = Math.round(PX0 + 2 + i * step);
        r.text(x - 12, PY1 + 6, `${String(p.hh).padStart(2, "0")}:00`, HEX("#5a6478"));
        r.vLine(x, PY1 - 4, PY1 - 1, HEX("#39415a"));
      }
    }
  }

  // ---- lines over candles ----
  const isDashed = (t: string): boolean => ["max_range", "max_trend", "vah", "val", "iv_wall", "iv_overflow", "weekly_"].some((p) => t.includes(p));
  if (anchor >= dLo && anchor <= dHi) r.hLine(PX0 + 1, PX1 - 1, p2y(anchor), HEX("#8090a8"), 0.9, 2, 5); // anchor (only when in-domain)
  for (const z of zones) {
    if (z.render !== "line" || !onScale(z)) continue;
    const y = p2y(z.top);
    r.hLine(PX0 + 1, PX1 - 1, y, HEX(z.color), 0.95, isDashed(z.type) ? 4 : 0, 4);
  }

  // ---- labels (collision-avoided lanes) ----
  const lane = (usedYs: number[], want: number): number => {
    let y = Math.max(PY0 + 2, Math.min(PY1 - 9, want));
    for (let k = 0; k < 300; k++) {
      const cand = y + (k % 2 === 0 ? 1 : -1) * 9 * Math.ceil(k / 2);
      if (cand < PY0 + 2 || cand > PY1 - 9) continue;
      if (!usedYs.some((u) => Math.abs(u - cand) < 9)) { usedYs.push(cand); return cand; }
    }
    usedYs.push(y); return y;
  };
  const rightUsed: number[] = [];
  const leftUsed: number[] = [];
  const midUsed: number[] = [];
  if (args.view === "rth-morning") {
    const hy = lane(leftUsed, PY0 + 4);
    r.text(PX0 + 6, hy, "08:30-09:30 DIMMED = PRE-OPEN", HEX("#5a6478"));
  }
  const anchorOff = anchor < dLo || anchor > dHi;
  const anchorY = lane(rightUsed, anchorOff ? PY0 + 4 : p2y(anchor) - 8);
  r.textRight(PX1 - 8, anchorY, `PRIOR CLOSE ${anchor.toFixed(2)}${anchorOff ? " (OFF-SCALE)" : ""}`, HEX("#8090a8"));
  for (const z of zones) {
    const c = HEX(z.color);
    if (!onScale(z)) continue;
    if (z.render === "line") {
      const y = lane(rightUsed, p2y(z.top) - 8);
      r.textRight(PX1 - 8, y, `${z.label} ${z.top.toFixed(2)}`, c);
    } else if (z.type === "yellow_box" || z.type === "poc" || z.type === "resistance_zone" || z.type === "support_zone"
      || z.type.startsWith("normal_range") || z.type.startsWith("max_range_days")
      || z.type === "es_vector_ref" || z.type === "white_box" || z.type.startsWith("ovn_spy")
      || z.type.startsWith("iv_wall_band")) {
      const y = lane(leftUsed, p2y((z.top + z.bottom) / 2) - 3);
      const txt = z.type === "poc" ? `${z.label} ${(z.meta?.price as number).toFixed(2)}` : `${z.label} ${z.bottom.toFixed(2)}-${z.top.toFixed(2)}`;
      r.text(PX0 + 6, y, txt, c);
    } else {
      const useLeft = z.type === "non_fair_value";
      const y = lane(useLeft ? leftUsed : midUsed, p2y((z.top + z.bottom) / 2) - 3);
      const x = useLeft ? PX0 + 6 : Math.round(fx0 + fw * (z.type === "single_print" ? 0.365 : z.type.startsWith("pb_") ? 0.405 : 0.645));
      r.text(x, y, `${z.label} ${z.bottom.toFixed(2)}-${z.top.toFixed(2)}`, c);
    }
  }
  // off-scale zones: pinned edge annotations (values preserved exactly in the JSON)
  for (const z of offScale) {
    const c = HEX(z.color);
    const below = (z.top + z.bottom) / 2 < dLo;
    const span = z.top === z.bottom ? z.top.toFixed(2) : `${z.bottom.toFixed(2)}-${z.top.toFixed(2)}`;
    const y = lane(leftUsed, below ? PY1 - 12 : PY0 + 4);
    r.text(PX0 + 6, y, `${z.label} ${span} (OFF-SCALE ${below ? "BELOW" : "ABOVE"})`, c);
  }

  // ---- title + sidebar ----
  const titleTxt = args.view === "rth-morning"
    ? `MES YELLOW BOX - ${targetKey} RTH MORNING (5M) - ZONES COMMITTED PRE-OPEN`
    : `MES YELLOW BOX - ${targetKey} (COMMITTED PRE-OPEN FROM DATA < 09:30 ET)`;
  r.text(16, 12, titleTxt, HEX("#e8eaf0"), 2);
  const SX = 1252;
  let sy = PY0;
  const line = (txt: string, col: RGB, swatch?: RGB): void => {
    if (swatch) { r.fillRect(SX, sy, 9, 7, swatch, 0.9); r.text(SX + 13, sy, txt, col); }
    else r.text(SX, sy, txt, col);
    sy += 11;
  };
  line("LEGEND / DERIVATION (4-DAY MWML CALIBRATED)", HEX("#e8eaf0")); sy += 2;
  line(`YELLOW BOX ${yb.bottom.toFixed(2)}-${yb.top.toFixed(2)} (W ${(yb.top - yb.bottom).toFixed(2)})`, HEX("#f5d90a"), HEX("#f5d90a"));
  line(`  settle+.35drift50 +- 50D 60M EXT (maxAbs 3.25)`, HEX("#8090a8"));
  line(`E/S VECTOR ${milkRef ? `${milkRef.esVec[0]}-${milkRef.esVec[1]} (MILK REF)` : "n/a"}`, HEX("#f5d90a"), HEX("#f5d90a"));
  line(`INIT RES ${initRes.toFixed(2)} / SUP ${initSup.toFixed(2)}`, HEX("#ef9a9a"), HEX("#ef9a9a"));
  line(`  P${IRS_PCT_UP * 100}UP/P${IRS_PCT_DN * 100}DN DAILY EXT (${EXT_DIST})`, HEX("#8090a8"));
  line(`NORMAL RANGE ${nrDn.toFixed(2)} / ${nrUp.toFixed(2)} (P${NR_PCT * 100})`, HEX("#b0bec5"), HEX("#b0bec5"));
  line(`MAX RANGE DAYS ${mrDn.toFixed(2)} / ${mrUp.toFixed(2)} (P${MR_PCT * 100})`, HEX("#78909c"), HEX("#78909c"));
  line(`MAX TREND UP ${mtUp.toFixed(2)} (P${MT_PCT * 100})`, HEX("#e8eaf0"), HEX("#e8eaf0"));
  line(`IMPORTED MILK BANDS ${mwmlImport.length} (mwml, <09:30)`, HEX("#5c6bc0"), HEX("#5c6bc0"));
  line(`AUTO PB ${pbAbove.slice(0, 3).length}UP/${pbBelow.slice(0, 3).length}DN (fill gaps only)`, HEX("#ffd54f"), HEX("#ffd54f"));
  line(`LONGAVE ${longAve.toFixed(2)} / SHORTAVE ${shortAve.toFixed(2)}`, HEX("#4dd0e1"), HEX("#4dd0e1"));
  line(`  p${LA_PCT_UP * 100}UP / p${SA_PCT_DN * 100}DN (Jul-13 outlier)`, HEX("#8090a8"));
  line(`RED ZONE = INIT RES > MAX RANGE`, HEX("#c62828"), HEX("#c62828"));
  line(`GREEN ZONE = INIT SUP > MAX RANGE`, HEX("#2e7d32"), HEX("#2e7d32"));
  line(`WEEKLY MF/FR ENVELOPES (P-FIT)`, HEX("#9575cd"), HEX("#9575cd"));
  if (milkRef) {
    line(`NET DEALER ${milkRef.netDealer.toFixed(2)} (MILK REF)`, HEX("#00e676"), HEX("#00e676"));
    line(`IV WALL ${milkRef.ivWall[0]} / ${milkRef.ivWall[1]} (MILK REF)`, HEX("#eeeeee"), HEX("#eeeeee"));
    line(`OVN SPY ${milkRef.ovnFloor[0]} / ${milkRef.ovnCeil[1]} (MILK REF)`, HEX("#fff176"), HEX("#fff176"));
  }
  sy += 6;
  line(`--- DERIVATION UNCONFIRMED ---`, HEX("#8090a8"));
  line(`POC ${pocPrice.toFixed(2)}  VA ${val.toFixed(2)}-${vah.toFixed(2)}`, HEX("#ffd700"), HEX("#ffd700"));
  line(`SINGLE PRINTS (${singlePrints.length}) / NFV (${nfvKept.length})`, HEX("#ab47bc"), HEX("#ab47bc"));
  line(`PB REGISTRY ${pbLive.length} LIVE / ${pbAll.length - pbLive.length} DEAD (${PB_LOOKBACK}D)`, HEX("#9aa4b8"));
  line(`PIVOTS ${pivots.map((p) => p.toFixed(2)).join(" / ")} (${priorDay.key})`, HEX("#ff9800"), HEX("#ff9800"));
  if (!iv.skipped) {
    line(`IV WALL(LIVE) ${iv.wallDn?.toFixed(2) ?? "-"} / ${iv.wallUp?.toFixed(2) ?? "-"}`, HEX("#ffffff"), HEX("#ffffff"));
    line(`  ${iv.source} EXP ${iv.expiry} SPOT ${iv.spx}`, HEX("#8090a8"));
  } else {
    line(`IV WALLS(LIVE) SKIPPED`, HEX("#9e9e9e"), HEX("#9e9e9e"));
  }
  sy += 6;
  line(`ANCHOR = PRIOR RTH CLOSE ${anchor.toFixed(2)}`, HEX("#8090a8"));
  line(`LAST PRE-OPEN PRICE ${lastClose.toFixed(2)}`, HEX("#8090a8"));
  line(`MAX BAR TS USED (ZONES) ${isoUtc(maxUsedTs)}`, HEX("#8090a8"));
  line(`CUTOFF ${isoUtc(cutoffTs)} - RESPECTED`, HEX("#8090a8"));

  // ---- footer: strategy note (both views) + post-open observation (rth-morning only) ----
  const STRATEGY_NOTE = "BOX PLAY: ENTER ON YELLOW-BOX BREAK, STOP AT OPPOSITE BOX EDGE, TP1 FIRST TOUCH OF INITIAL S/R, RUNNERS TO MAX RANGE.";
  let obsLo = Infinity, obsHi = -Infinity, obsN = 0, obsEnd = 0;
  if (args.view === "rth-morning") {
    for (const b of candles) {
      if (b.dim) continue; // pre-open bars excluded from the observation
      obsLo = Math.min(obsLo, b.l); obsHi = Math.max(obsHi, b.h); obsN++; obsEnd = b.t + 300;
    }
    r.hLine(PX0, PX1, H - 42, HEX("#2a3145"));
    r.text(PX0, H - 36, STRATEGY_NOTE, HEX("#c9a227"));
    if (obsN > 0) {
      const pe = etParts(obsEnd);
      r.text(PX0, H - 20,
        `POST-OPEN OBSERVATION ONLY (NOT USED IN ANY ZONE): SESSION RANGE SO FAR ${obsLo.toFixed(2)}-${obsHi.toFixed(2)} (09:30-${String(pe.hh).padStart(2, "0")}:${String(pe.mm).padStart(2, "0")} ET, ${obsN} BARS)`,
        HEX("#8090a8"));
    } else {
      r.text(PX0, H - 20, `NO POST-OPEN BARS IN DB YET - PREDICTION VIEW (ZONES COMMITTED PRE-OPEN)`, HEX("#8090a8"));
    }
  } else {
    r.hLine(PX0, PX1, H - 30, HEX("#2a3145"));
    r.text(PX0, H - 22, STRATEGY_NOTE, HEX("#c9a227"));
  }

  // -------- write outputs --------
  const outPng = path.resolve(process.cwd(), args.out);
  fs.writeFileSync(outPng, encodePNG(r));
  const outJson = outPng.replace(/\.png$/i, "") + ".json";
  const jsonDoc = {
    symbol: args.symbol,
    date: targetKey,
    weekday: WEEKDAY_NAMES[targetWeekday],
    cutoffUtc: isoUtc(cutoffTs),
    cutoffEpoch: cutoffTs,
    maxBarTsUsed: maxUsedTs,
    maxBarTsUsedUtc: isoUtc(maxUsedTs),
    cutoffRespected: maxUsedTs < cutoffTs,
    anchorPriorClose: anchor,
    priorTradingDay: priorDay.key,
    lastCloseBeforeCutoff: lastClose,
    generatedAt: new Date().toISOString(),
    spreadMonster: { weekdayMatched: sm, hlMatched: smHL, note: "JSON-only (not rendered); LongAve mapping superseded by initial_resistance" },
    volatility: {
      lookbackDays: last50.length,
      anchorSettle: anchor,
      globexOpen: rnd2(gopen),
      yellowBox: { formula: YB_FORMULA, driftK: YB_DRIFT_K, bottom: rnd2(yb.bottom), top: rnd2(yb.top), meanBarUpExt: rnd2(meanHO), meanBarDnExt: rnd2(meanOL), width: rnd2(yb.top - yb.bottom), solved: "WIDTH = 50-day 60m mean bar extension (EXACT); CENTER = settle + 0.35*drift50 (min-max over 8 edges = 3.25pt)", candidates: Object.fromEntries(Object.entries(ybCandidates).map(([k, v]) => [k, { bottom: toTick(v.bottom), top: toTick(v.top) }])) },
      initialResistance: rnd2(initRes), initialSupport: rnd2(initSup),
      irsMethod: { up: `p${IRS_PCT_UP * 100}`, dn: `p${IRS_PCT_DN * 100}`, dist: EXT_DIST, maxAbs: { initRes: 3.22, initSup: 2.24 } },
      normalRangeDays: { pct: NR_PCT, up: rnd2(nrUp), dn: rnd2(nrDn), maxAbsDn: 2.50 },
      maxRangeDays: { pctUp: MR_PCT, pctDn: MR_PCT_DN, up: rnd2(mrUp), dn: rnd2(mrDn), maxAbsUp: 1.22, maxAbsDn: 3.87 },
      maxTrendUp: { pct: MT_PCT, level: rnd2(mtUp), maxAbs: 3.14 },
      longAveShortAve: { longAve, shortAve, method: `LongAve=anchor+p${LA_PCT_UP * 100}dayUp, ShortAve=anchor-p${SA_PCT_DN * 100}dayDn (allDays 50d)`, milk: milkRef ? { longAve: milkRef.longAve, shortAve: milkRef.shortAve } : null, note: "NO median variant fits all 4; Milk LongAve ~p68 of up-ext (not median); Jul-13 band shifts ~16-31pt down (outlier)" },
    },
    vectorTest: {
      derivation: `${derivDayKey} 18:00 ET (= (D-1) 22:00 UTC, Milk's strip draw time)`,
      variants: vecTest,
      milkStrip: milkRef ? milkRef.esVec : null,
      esVectorLabels: { jul08: { E: 7550.18, S: 7556.56 }, jul09: { E: 7515.90, S: 7531.64 }, jul10: { E: 7591.88, S: 7584.89 }, jul13: { E: 7627.29, S: 7620.89 } },
      gridWinners: { lowerVector: "B:HiLo(close) N=25 5m (maxErr 3.75)", upperVector: "C:LoHi(high) N=15-20 5m (maxErr 2.25)" },
      verdict: "NO-MATCH within +/-1.5pt; strip rendered from Milk's exact values on his 4 days; box stays settle-anchored",
    },
    persistentBands: {
      knobs: { lookbackDays: PB_LOOKBACK, windowPts: PB_WIN * TICK, topPerDay: PB_TOP_M, effortMult: PB_EFFORT, trim: PB_TRIM, deathParticipation: PB_DEATH },
      mwmlImport: { files: mwmlPaths.map((p) => path.basename(p)), totalMappedBands: mwmlParsed.bands.length, eligibleBeforeCutoff: mwmlParsed.eligible.length, targetDaySet: mwmlImport.length, latestDrawStartUtc: mwmlParsed.maxDrawStart ? isoUtc(mwmlParsed.maxDrawStart) : null, cutoffRule: `draw-start < ${isoUtc(cutoffTs)} (${targetKey} 09:30 ET)`, imported: mwmlImport.map((b) => ({ type: b.type, bottom: rnd2(b.bottom), top: rnd2(b.top), drawStart: isoUtc(b.drawStart), source: "milk-mwml", file: b.file })) },
      live: pbLive.map((b) => ({ bottom: rnd2(b.bottom), top: rnd2(b.top), born: b.born, effort: Math.round(b.effort), refreshes: b.refreshes, source: "auto" })),
      dead: pbAll.filter((b) => b.died).map((b) => ({ bottom: rnd2(b.bottom), top: rnd2(b.top), born: b.born, died: b.died })),
    },
    weeklyEnvelopes: {
      anchorPriorFriClose: weeklyInfo.anchor, priorFriKey: weeklyInfo.priorFriKey, weeksInSample: weeklyInfo.weeks,
      monFri: { ceilPct: WK_MF_UP, floorPct: WK_MF_DN, ceil: rnd2(weeklyInfo.anchor + pctile(weeklyInfo.up1, WK_MF_UP)), floor: rnd2(weeklyInfo.anchor - pctile(weeklyInfo.dn1, WK_MF_DN)), milk: targetWeekday === 1 ? [7447.25, 7675.75] : null },
      friWeekly: { ceilPct: WK_FR_UP, floorPct: WK_FR_DN, ceil: rnd2(weeklyInfo.anchor + pctile(weeklyInfo.up1, WK_FR_UP)), floor: rnd2(weeklyInfo.anchor - pctile(weeklyInfo.dn1, WK_FR_DN)), milk: targetWeekday === 1 ? [7409.00, 7736.75] : null },
      note: "single-week extension dist vs prior-Fri settle; asymmetric percentiles fit to the Jul-12-drawn envelope (market run-up compresses upside)",
    },
    ovnSpy: { ...ovn, factors: { ceiling: OVN_SPY_F_CEIL, floor: OVN_SPY_F_FLOOR }, milk: milkRef ? { ceiling: milkRef.ovnCeil, floor: milkRef.ovnFloor } : null },
    netDealerMilkRef: milkRef ? milkRef.netDealer : null,
    ivWallMilkRef: milkRef ? { dn: milkRef.ivWall[0], up: milkRef.ivWall[1], weekly: milkRef.weeklyIV ?? null, derivation: "options-data-unavailable" } : null,
    ivWalls: iv,
    zones,
  };
  const pngSize = fs.statSync(outPng).size;
  if (args.view === "pre-open") {
    fs.writeFileSync(outJson, JSON.stringify(jsonDoc, null, 2));
    console.log(`[yellowbox] wrote ${outPng} (${(pngSize / 1024).toFixed(1)} KB) + ${outJson} (${zones.length} zones)`);
  } else {
    console.log(`[yellowbox] wrote ${outPng} (${(pngSize / 1024).toFixed(1)} KB) — JSON skipped for view=${args.view} (the pre-open run's zones JSON stands)`);
    console.log(`[view] rth-morning window ${isoUtc(dispFrom)}..${isoUtc(dispTo)} ET 08:30-13:00; displayed candles=${candles.length} (dim pre-open=${candles.filter((c) => c.dim).length})`);
    console.log(`[view] y-domain chosen: ${dLo.toFixed(2)}..${dHi.toFixed(2)} (${(dHi - dLo).toFixed(2)} pts)`);
    const on = zones.filter(onScale);
    console.log(`[view] zones inside visible window: ${on.length}; pinned off-scale: ${offScale.length}`);
    for (const z of on) console.log(`  IN   ${z.label.padEnd(22)} ${z.top === z.bottom ? z.top.toFixed(2) : `${z.bottom.toFixed(2)}..${z.top.toFixed(2)}`}`);
    for (const z of offScale) console.log(`  PIN  ${z.label.padEnd(22)} ${z.top === z.bottom ? z.top.toFixed(2) : `${z.bottom.toFixed(2)}..${z.top.toFixed(2)}`} (${(z.top + z.bottom) / 2 < dLo ? "below" : "above"})`);
    if (obsN > 0) console.log(`[view] post-open observation (display/footer only): session range so far ${obsLo.toFixed(2)}..${obsHi.toFixed(2)} over ${obsN} RTH 5m bars`);
  }

  // -------- console zone report --------
  console.log(`\n=== ZONES ${targetKey} (anchor ${anchor.toFixed(2)}, last pre-open ${lastClose.toFixed(2)}) ===`);
  for (const z of zones) {
    const span = z.top === z.bottom ? z.top.toFixed(2) : `${z.bottom.toFixed(2)}..${z.top.toFixed(2)}`;
    console.log(`  ${z.type.padEnd(20)} ${z.label.padEnd(22)} ${span}`);
  }

  // -------- accuracy preview (POST-CUTOFF, grading only — never used for zones; pre-open view only) --------
  const rthEnd = etWallToEpoch(targetKey, 17, 0);
  const gradeBars = args.view !== "pre-open" ? [] : db.prepare(
    `SELECT timestamp t, high h, low l FROM cached_candles WHERE symbol=? AND resolution='5' AND timestamp>=? AND timestamp<? ORDER BY timestamp`
  ).all(args.symbol, cutoffTs, rthEnd) as { t: number; h: number; l: number }[];
  if (args.view === "pre-open" && gradeBars.length >= 10) {
    let gh = -Infinity, gl = Infinity;
    for (const b of gradeBars) { gh = Math.max(gh, b.h); gl = Math.min(gl, b.l); }
    const levels: { name: string; p: number }[] = [];
    for (const z of zones) {
      if (z.render === "line") levels.push({ name: z.label, p: z.top });
      else { levels.push({ name: `${z.label} TOP`, p: z.top }); levels.push({ name: `${z.label} BOT`, p: z.bottom }); }
    }
    const hit = levels.filter((L) => L.p >= gl - TICK && L.p <= gh + TICK);
    console.log(`\n=== ACCURACY PREVIEW (post-cutoff data, grading only) ===`);
    console.log(`RTH ${targetKey} 09:30-17:00 ET actual range: ${gl.toFixed(2)}..${gh.toFixed(2)} (${(gh - gl).toFixed(2)} pts, ${gradeBars.length} 5m bars)`);
    console.log(`zone levels interacted (inside RTH range): ${hit.length} of ${levels.length}`);
    for (const L of hit) console.log(`  HIT  ${L.name.padEnd(26)} ${L.p.toFixed(2)}`);
  } else if (args.view === "pre-open") {
    console.log(`\n[grade] no post-cutoff RTH data for ${targetKey} yet — prediction mode (grade later vs Milk's chart).`);
  }

  db.close();
}

main().catch((e) => { console.error("failed:", e); process.exit(1); });
