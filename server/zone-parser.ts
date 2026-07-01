/**
 * zone-parser.ts
 *
 * Parses uploaded files (MWML / screenshots) into a list of price-band zones
 * that can be rendered on the chart as BandOverlay objects.
 *
 * Supports:
 *   .mwml / .xml  — MotiveWave Markup Language (XML) exported study files
 *   images        — screenshot analysis via Claude vision API
 */

import Anthropic from "@anthropic-ai/sdk";

export interface ParsedZone {
  topPrice:    number;
  bottomPrice: number;
  fillColor:   string;   // rgba string
  fromTime:    number;   // unix seconds (0 = show from start of chart)
  toTime:      number;   // unix seconds (9999999999 = show to end of chart)
  label?:      string;
  zoneScope?:  "ovn" | "rth"; // set by Claude Vision for PNG imports; undefined = use label fallback
}

// Lazy — only instantiated when screenshot analysis is actually requested
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY)
      throw new Error("ANTHROPIC_API_KEY is not set in .env — required for screenshot analysis");
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * MotiveWave exports timestamps in milliseconds; lightweight-charts needs seconds.
 * Heuristic: if > 10^10 it must be milliseconds.
 */
function normalizeTime(t: number): number {
  return t > 10_000_000_000 ? Math.round(t / 1000) : t;
}

function isValidPrice(p: number): boolean {
  return Number.isFinite(p) && p > 50 && p < 1_000_000;
}

// When a zone has no explicit end time, cap it to the RTH session-end of its start day.
// Milk zones are pre-market predictions valid for one trading day only.
function defaultToTime(fromTs: number): number {
  if (fromTs <= 0) return 9_999_999_999;
  // 20:30 UTC = RTH settle for MES/ES
  const dayStart = Math.floor(fromTs / 86400) * 86400;
  const settle   = dayStart + 20 * 3600 + 30 * 60;
  // If fromTs is already past today's settle (e.g. ETH overnight), advance one day
  return settle > fromTs ? settle : settle + 86400;
}

/**
 * Convert a raw color string (or a zone-type keyword) to an rgba fill.
 * MotiveWave uses AARRGGBB 8-hex, standard CSS uses #RRGGBB.
 */
function parseColor(raw: string, type: string): string {
  const t = (type || "").toLowerCase();
  if (t.includes("support") || t.includes("long") || t.includes("bull") || t.includes("demand"))
    return "rgba(38,200,122,0.22)";
  if (t.includes("resist") || t.includes("short") || t.includes("bear") || t.includes("supply"))
    return "rgba(239,83,80,0.22)";

  if (raw) {
    const hex = raw.replace(/^#/, "").trim();

    // MW AARRGGBB (8 digits, alpha-first)
    if (/^[0-9a-f]{8}$/i.test(hex)) {
      const a = parseInt(hex.slice(0, 2), 16) / 255;
      const r = parseInt(hex.slice(2, 4), 16);
      const g = parseInt(hex.slice(4, 6), 16);
      const b = parseInt(hex.slice(6, 8), 16);
      const alpha = Math.max(0.10, Math.min(0.40, a > 0 ? a : 0.22));
      return `rgba(${r},${g},${b},${alpha})`;
    }
    // Standard RRGGBB
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r},${g},${b},0.22)`;
    }
    // RGBA(r,g,b,a)
    const rgbaM = raw.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgbaM) return `rgba(${rgbaM[1]},${rgbaM[2]},${rgbaM[3]},0.22)`;

    // Named colors
    const named: Record<string, string> = {
      yellow: "rgba(255,215,0,0.22)",
      gold:   "rgba(255,200,0,0.22)",
      green:  "rgba(38,200,122,0.22)",
      lime:   "rgba(50,205,50,0.22)",
      red:    "rgba(239,83,80,0.22)",
      blue:   "rgba(100,140,255,0.22)",
      cyan:   "rgba(0,188,212,0.22)",
      magenta:"rgba(233,30,99,0.22)",
      orange: "rgba(255,152,0,0.22)",
      purple: "rgba(156,39,176,0.22)",
      white:  "rgba(255,255,255,0.15)",
      gray:   "rgba(150,150,150,0.18)",
      grey:   "rgba(150,150,150,0.18)",
    };
    const lc = raw.toLowerCase();
    for (const [key, val] of Object.entries(named)) {
      if (lc.includes(key)) return val;
    }
  }
  return "rgba(255,215,0,0.22)"; // default: yellow (common MW Yellow Box color)
}

// ── Attribute parser helpers ──────────────────────────────────────────────────

// Pre-compile attribute regexes keyed by name — MWML parsing calls these in tight
// loops over thousands of elements; re-compiling the same pattern per call is wasteful.
const _attrNumRe = new Map<string, RegExp>();
const _attrStrRe = new Map<string, RegExp>();

function getAttrNum(attrs: string, ...names: string[]): number | null {
  for (const name of names) {
    let r = _attrNumRe.get(name);
    if (!r) { r = new RegExp(`\\b${name}\\s*=\\s*["']?([\\d.eE+\\-]+)["']?`, "i"); _attrNumRe.set(name, r); }
    const match = r.exec(attrs);
    if (match) { const v = parseFloat(match[1]); if (Number.isFinite(v)) return v; }
  }
  return null;
}

function getAttrStr(attrs: string, ...names: string[]): string {
  for (const name of names) {
    let r = _attrStrRe.get(name);
    if (!r) { r = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"); _attrStrRe.set(name, r); }
    const match = r.exec(attrs);
    if (match) return match[1];
  }
  return "";
}

const _childTextRe = new Map<string, RegExp>();
function getChildText(inner: string, ...names: string[]): number | null {
  for (const name of names) {
    let r = _childTextRe.get(name);
    if (!r) { r = new RegExp(`<${name}[^>]*>\\s*([\\d.eE+\\-]+)\\s*<\\/${name}>`, "i"); _childTextRe.set(name, r); }
    const match = r.exec(inner);
    if (match) { const v = parseFloat(match[1]); if (Number.isFinite(v)) return v; }
  }
  return null;
}

// ── Session-start resolver for MWML zones ────────────────────────────────────
//
// MWML coordinate timestamps reflect when/where Milk drew the rectangle in
// MotiveWave — not necessarily the intended display start for the zone.
// This function maps Milk's zone labels to the correct session start time so
// the chart renders zones the same way MotiveWave does.
function resolveFromTime(mwmlFromSec: number, label: string | undefined, srcId: string): number {
  const lbl = ((label ?? "") + " " + srcId).toLowerCase();

  // Current day boundaries (matches CandlestickChart.tsx logic: 13:30 UTC = 9:30 AM ET)
  const now       = new Date();
  const dow       = now.getUTCDay();                          // 0=Sun … 6=Sat
  const rollback  = dow === 0 ? 2 : dow === 6 ? 1 : 0;      // skip weekend to Friday
  const dayStart  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - rollback);
  const daySec    = Math.floor(dayStart / 1000);
  const rthOpen   = daySec + 13 * 3600 + 30 * 60;           // 9:30 AM ET
  const ovnOpen   = daySec - 3 * 3600;                       // yesterday 5:00 PM ET (21:00 UTC prev day)

  // ── RTH-only zones: start at today's 9:30 AM ──────────────────────────────
  if (/rth[\s_-]?gap|daily[\s_-]?open|rtf[\s_-]?gap/.test(lbl)) return rthOpen;

  // ── OVN / overnight zones: start at yesterday's 5 PM ET ──────────────────
  if (/\bovn\b|overnight/.test(lbl)) return ovnOpen;

  // ── Max range / IV Wall / weekly structure: start at yesterday's 5 PM ET ──
  // These span the full session (OVN open → RTH close) on Milk's chart.
  if (/max[\s_-]?range|iv[\s_-]?wall|iv[\s_-]?overflow|mon[\s_-]?fri|weekly|w1\s|w1$/.test(lbl)) return ovnOpen;

  // ── Splice / weekly stat bands: use MWML fromTime if recent (< 7 days) ───
  // Milk anchors these to specific session times; trust the MWML coordinate.
  if (/splice|w7\b|w10\b|w15\b/.test(lbl)) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (mwmlFromSec > 0 && nowSec - mwmlFromSec < 7 * 86400) return mwmlFromSec;
  }

  // ── Default: use MWML fromTime when recent, else fall back to OVN open ───
  const nowSec = Math.floor(Date.now() / 1000);
  if (mwmlFromSec > 0 && nowSec - mwmlFromSec < 7 * 86400) return mwmlFromSec;
  return ovnOpen;
}

// ── MotiveWave JSON parser ────────────────────────────────────────────────────
//
// MotiveWave .mwml files are actually JSON (not XML).
// Structure: { graphs: [{ figures: [{ type, coords, fillColor, srcId, ... }] }] }
// Each zone is type "supportResist" with coords: ["timeMs|price|corner", ...]
// corners: topLeft | topRight | bottomLeft | bottomRight

function parseMWJSON(json: string): ParsedZone[] {
  let data: any;
  try { data = JSON.parse(json); } catch { return []; }

  const figures: any[] = [];
  for (const graph of (data.graphs ?? [])) {
    for (const fig of (graph.figures ?? [])) figures.push(fig);
    // also handle nested overlay graphs
    for (const sub of (graph.graphs ?? [])) {
      for (const fig of (sub.figures ?? [])) figures.push(fig);
    }
  }
  for (const fig of (data.figures ?? [])) figures.push(fig);

  // Collect comment/text labels (type="comment") with their price and time
  interface TextLabel { price: number; timeMs: number; text: string; }
  const textLabels: TextLabel[] = [];
  for (const fig of figures) {
    if (fig.type !== "comment") continue;
    const txt = fig.text?.text;
    if (!txt || typeof txt !== "string") continue;
    if (/copyright|all rights reserved/i.test(txt)) continue;
    for (const coord of (fig.coords ?? [])) {
      const parts = coord.split("|");
      if (parts.length < 2) continue;
      const timeMs = parseFloat(parts[0]);
      const price  = parseFloat(parts[1]);
      if (isFinite(timeMs) && isFinite(price) && isValidPrice(price))
        textLabels.push({ price, timeMs, text: txt.trim() });
    }
  }

  // Use a richer intermediate type to carry raw MWML timestamps for filtering,
  // then strip them before returning ParsedZone[].
  const rawZones: Array<ParsedZone & { mwmlMinMs: number }> = [];

  for (const fig of figures) {
    if (fig.type !== "supportResist") continue;

    const coords: string[] = fig.coords ?? [];
    let topPrice: number | null = null;
    let bottomPrice: number | null = null;
    let minTime = Infinity, maxTime = -Infinity;

    for (const coord of coords) {
      const parts = coord.split("|");
      if (parts.length < 3) continue;
      const timeMs = parseFloat(parts[0]);
      const price  = parseFloat(parts[1]);
      const corner = parts[2].toLowerCase();
      if (!isFinite(timeMs) || !isFinite(price)) continue;
      if (timeMs < minTime) minTime = timeMs;
      if (timeMs > maxTime) maxTime = timeMs;
      if (corner.startsWith("top"))    topPrice    = price;
      if (corner.startsWith("bottom")) bottomPrice = price;
    }

    if (topPrice === null || bottomPrice === null) continue;
    const hi = Math.max(topPrice, bottomPrice);
    const lo = Math.min(topPrice, bottomPrice);
    if (!isValidPrice(hi) || !isValidPrice(lo) || hi === lo) continue;

    // fillColor is "r,g,b,a" (each 0-255)
    const fcParts = (fig.fillColor ?? "").split(",").map(Number);
    let fillColor: string;
    const srcId = (fig.srcId ?? "").toLowerCase();
    if (fcParts.length === 4 && fcParts.every(isFinite)) {
      const [r, g, b, a] = fcParts;
      // Map MW alpha (0-255) to a chart overlay range of 0.12–0.25
      const overlayAlpha = Math.max(0.12, Math.min(0.25, (a / 255) * 0.8));
      fillColor = `rgba(${r},${g},${b},${overlayAlpha.toFixed(2)})`;
    } else {
      fillColor = srcId.includes("support") ? "rgba(38,200,122,0.22)"
                : srcId.includes("resist")  ? "rgba(239,83,80,0.22)"
                : "rgba(255,215,0,0.22)";
    }

    // Find a text label whose price is within or near this zone and time is nearby
    const zoneHeight = hi - lo;
    const matchedLabel = textLabels.find(lbl =>
      lbl.price >= lo - zoneHeight && lbl.price <= hi + zoneHeight &&
      lbl.timeMs >= minTime - 86400_000 && lbl.timeMs <= maxTime + 86400_000
    );
    const label = matchedLabel?.text
                ?? (srcId.includes("support") ? "Support"
                 : srcId.includes("resist")   ? "Resistance"
                 : undefined);

    // fromTime=0 / toTime=0 signals the client to anchor this zone to today's
    // RTH session. The raw MWML timestamps are kept in mwmlMinMs for filtering only.
    rawZones.push({
      topPrice:    hi,
      bottomPrice: lo,
      fillColor,
      fromTime:    0,
      toTime:      0,
      label,
      mwmlMinMs:   isFinite(minTime) ? minTime : 0,
    });
  }

  if (rawZones.length === 0) return [];

  // Keep only the most recent batch of zones (within 14 days of the latest zone).
  // This filters out historical zones from months/years ago in the full MWML database.
  rawZones.sort((a, b) => b.mwmlMinMs - a.mwmlMinMs);
  const latestMs  = rawZones[0].mwmlMinMs;
  const windowMs  = 14 * 86400_000;
  const recent    = rawZones.filter(z => latestMs - z.mwmlMinMs <= windowMs);

  // Deduplicate: same zone if top AND bottom are both within 0.50 pts (2 ticks).
  // Keeps the most-recent version (zones are already sorted newest-first).
  const out: ParsedZone[] = [];
  for (const z of recent) {
    const dup = out.some(o =>
      Math.abs(o.topPrice - z.topPrice) < 0.50 &&
      Math.abs(o.bottomPrice - z.bottomPrice) < 0.50
    );
    if (!dup) out.push({ topPrice: z.topPrice, bottomPrice: z.bottomPrice, fillColor: z.fillColor, fromTime: 0, toTime: 0, label: z.label });
  }
  return out;
}

// ── MWML parser ───────────────────────────────────────────────────────────────

export function parseMWML(xml: string): ParsedZone[] {
  // Detect JSON format (MotiveWave .mwml files are actually JSON, not XML)
  const trimmed = xml.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseMWJSON(trimmed);
  }

  const zones: ParsedZone[] = [];

  // ── STRATEGY 1: Single-element attribute format ──────────────────────────
  // Handles: <rect>, <region>, <zone>, <box>, <highlight>, <mark>, <band>,
  //          <Rectangle>, <Highlight>, <Mark>, <Area>, <Shading>, <Fill>
  const S1_NAMES = [
    "rect(?:angle)?","region","zone","box","highlight","mark(?:ing)?",
    "band","shading","fill","overlay","area","draw(?:ing)?",
    "Rectangle","Region","Highlight","Mark","Box","Band","Area",
    "Zone","Shape","Polygon","PlotRegion","StudyRegion","PriceRegion",
  ].join("|");
  const s1Re = new RegExp(`<(${S1_NAMES})\\b([^>]*)(?:/>|>)`, "gi");
  let m: RegExpExecArray | null;

  while ((m = s1Re.exec(xml)) !== null) {
    const attrs = m[2];
    const top    = getAttrNum(attrs, "topPrice","top","topValue","highPrice","high","priceHigh","priceTop","upper","tp");
    const bottom = getAttrNum(attrs, "bottomPrice","bottom","bottomValue","lowPrice","low","priceLow","priceBottom","lower","bp");
    const rawFrom= getAttrNum(attrs, "fromTime","startTime","from","x1","timeFrom","t1","start","beginTime","timeStart");
    const rawTo  = getAttrNum(attrs, "toTime","endTime","to","x2","timeTo","t2","end","finishTime","timeEnd");
    const color  = getAttrStr(attrs, "color","fillColor","bgColor","fill","c","lineColor","borderColor","background");
    const type   = getAttrStr(attrs, "type","regionType","markType","style","name","label","description");

    if (top !== null && bottom !== null) {
      const hi = Math.max(top, bottom), lo = Math.min(top, bottom);
      if (hi !== lo && isValidPrice(hi) && isValidPrice(lo)) {
        const ft1 = rawFrom !== null ? normalizeTime(rawFrom) : 0;
        zones.push({
          topPrice:    hi,
          bottomPrice: lo,
          fillColor:   parseColor(color, type),
          fromTime:    ft1,
          toTime:      rawTo !== null ? normalizeTime(rawTo) : defaultToTime(ft1),
          label:       type || undefined,
        });
      }
    }
  }

  // ── STRATEGY 2: x1/y1/x2/y2 drawing format (MW drawing exports) ─────────
  // <Rectangle x1="timeMs" y1="price" x2="timeMs" y2="price" />
  const s2Re = /<([A-Za-z]+)\b([^>]*)(?:\/?>)/gi;
  while ((m = s2Re.exec(xml)) !== null) {
    const attrs = m[2];
    const x1 = getAttrNum(attrs, "x1"), y1 = getAttrNum(attrs, "y1");
    const x2 = getAttrNum(attrs, "x2"), y2 = getAttrNum(attrs, "y2");
    if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
      const hi = Math.max(y1, y2), lo = Math.min(y1, y2);
      // y must look like a price, x must look like a timestamp
      if (isValidPrice(hi) && isValidPrice(lo) && hi !== lo && x1 > 1_000_000 && x2 > 1_000_000) {
        const color = getAttrStr(attrs, "color","fillColor","bgColor","fill","c");
        const type  = getAttrStr(attrs, "type","name","style","label");
        const isDup = zones.some(z =>
          Math.abs(z.topPrice - hi) < 0.01 && Math.abs(z.bottomPrice - lo) < 0.01
        );
        if (!isDup) {
          zones.push({
            topPrice:    hi,
            bottomPrice: lo,
            fillColor:   parseColor(color, type),
            fromTime:    normalizeTime(Math.min(x1, x2)),
            toTime:      normalizeTime(Math.max(x1, x2)),
            label:       type || undefined,
          });
        }
      }
    }
  }

  // ── STRATEGY 3: Child-element format ─────────────────────────────────────
  // <Zone><TopPrice>5920</TopPrice><BottomPrice>5900</BottomPrice></Zone>
  if (zones.length === 0) {
    const BLK = "(?:region|zone|rect(?:angle)?|box|highlight|mark|band|area|study|indicator|overlay|plot|drawing)";
    const s3Re = new RegExp(`<(${BLK})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, "gi");
    while ((m = s3Re.exec(xml)) !== null) {
      const inner = m[2];
      const top  = getChildText(inner, "topPrice","top","topValue","highPrice","high","upper","priceHigh","highValue","maxPrice","maxValue");
      const bot  = getChildText(inner, "bottomPrice","bottom","bottomValue","lowPrice","low","lower","priceLow","lowValue","minPrice","minValue");
      const rawFrom = getChildText(inner, "fromTime","startTime","from","x1","t1","start","startDate","beginTime");
      const rawTo   = getChildText(inner, "toTime","endTime","to","x2","t2","end","endDate","finishTime");

      if (top !== null && bot !== null) {
        const hi = Math.max(top, bot), lo = Math.min(top, bot);
        if (isValidPrice(hi) && isValidPrice(lo) && hi !== lo) {
          const ft3 = rawFrom !== null ? normalizeTime(rawFrom) : 0;
          zones.push({
            topPrice: hi, bottomPrice: lo,
            fillColor: "rgba(255,215,0,0.22)",
            fromTime:  ft3,
            toTime:    rawTo !== null ? normalizeTime(rawTo) : defaultToTime(ft3),
          });
        }
      }
    }
  }

  // ── STRATEGY 4: Key=value pair scan anywhere in XML ──────────────────────
  // Catches <StudySettings topPrice="5920" bottomPrice="5900" /> etc.
  if (zones.length === 0) {
    const allAttrsRe = /\btop(?:Price|Value)?\s*=\s*["']?([\d.]+)["']?[^>]*\bbottom(?:Price|Value)?\s*=\s*["']?([\d.]+)["']?/gi;
    while ((m = allAttrsRe.exec(xml)) !== null) {
      const top = parseFloat(m[1]), bot = parseFloat(m[2]);
      const hi = Math.max(top, bot), lo = Math.min(top, bot);
      if (isValidPrice(hi) && isValidPrice(lo) && hi !== lo) {
        zones.push({ topPrice: hi, bottomPrice: lo, fillColor: "rgba(255,215,0,0.22)", fromTime: 0, toTime: 9_999_999_999 });
      }
    }
  }

  // ── STRATEGY 5: Generic numeric price-pair extraction (last resort) ───────
  if (zones.length === 0) {
    const nums = [...xml.matchAll(/\b(\d{2,6}(?:\.\d{1,4})?)\b/g)]
      .map(x => parseFloat(x[1]))
      .filter(p => isValidPrice(p));
    const unique = [...new Set(nums)].sort((a, b) => b - a);
    for (let i = 0; i + 1 < unique.length && zones.length < 40; i += 2) {
      const spread = unique[i] - unique[i + 1];
      if (spread >= 0.25 && spread <= 300) {
        zones.push({
          topPrice:    unique[i],
          bottomPrice: unique[i + 1],
          fillColor:   "rgba(255,215,0,0.22)",
          fromTime:    0,
          toTime:      9_999_999_999,
        });
      }
    }
  }

  // Deduplicate and return
  const out: ParsedZone[] = [];
  for (const z of zones) {
    const dup = out.some(o =>
      Math.abs(o.topPrice - z.topPrice) < 0.05 &&
      Math.abs(o.bottomPrice - z.bottomPrice) < 0.05
    );
    if (!dup) out.push(z);
  }
  return out;
}

// ── JSON recovery helper ──────────────────────────────────────────────────────
// When max_tokens is hit mid-response, the JSON array is truncated.
// This extracts any complete zone objects even from a partial JSON string.
function extractPartialZones(text: string): Array<{ topPrice: number; bottomPrice: number; type: string; zone_type?: string; label?: string; startsAtOvn?: boolean }> {
  const zones: Array<{ topPrice: number; bottomPrice: number; type: string; zone_type?: string; label?: string; startsAtOvn?: boolean }> = [];
  // Match complete zone objects from partial JSON; fields may appear in any order
  const objRe = /\{[^{}]*"topPrice"\s*:\s*([\d.]+)[^{}]*"bottomPrice"\s*:\s*([\d.]+)[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text)) !== null) {
    const obj = m[0];
    const top = parseFloat(m[1]), bot = parseFloat(m[2]);
    if (!isFinite(top) || !isFinite(bot) || top <= bot) continue;
    const typeM      = /"type"\s*:\s*"([^"]+)"/.exec(obj);
    const zoneTypeM  = /"zone_type"\s*:\s*"([^"]*)"/.exec(obj);
    const labelM     = /"label"\s*:\s*"([^"]*)"/.exec(obj);
    const ovnM       = /"startsAtOvn"\s*:\s*(true|false)/.exec(obj);
    zones.push({
      topPrice:    top,
      bottomPrice: bot,
      type:        typeM?.[1] ?? "support",
      zone_type:   zoneTypeM?.[1] || undefined,
      label:       labelM?.[1] || undefined,
      startsAtOvn: ovnM ? ovnM[1] === "true" : undefined,
    });
  }
  return zones;
}

// ── PDF → Claude document API ─────────────────────────────────────────────────

export async function parsePDF(
  base64Data: string,
  visiblePriceHigh?: number,
  visiblePriceLow?:  number,
): Promise<ParsedZone[]> {
  const priceContext = visiblePriceHigh && visiblePriceLow
    ? `The chart's visible price range is approximately ${visiblePriceLow} (bottom) to ${visiblePriceHigh} (top).`
    : "Estimate prices from any axis labels visible in the document.";

  const prompt = `You are analyzing a PDF trading chart from "Milk's Yellow Box Strategy" for ES/MES futures.

${priceContext}

Identify ALL colored rectangular zones/boxes/bands overlaid on the chart. For each zone return:
- topPrice: the price at the top edge of the zone (read from the price axis)
- bottomPrice: the price at the bottom edge of the zone
- type: "support" (green/teal/blue zones) or "resistance" (red/orange/yellow zones)
- zone_type: choose best match from: buyer_positioning, buyer_objective, buyer_ultimate_target, seller_positioning, seller_objective, seller_ultimate_target, seller_soft_target, iv_wall, iv_overflow, rth_gap, non_fair_value, pivot, floor, ceiling, max_range, avg_range_low, avg_range_high, ovn_spy_ceiling, ovn_spy_floor, splice_band, gex_wall_long, gex_wall_short, unknown
- label: the text label visible on the zone if any (e.g. "BUYER POSITIONING", "IV WALL")

Color guide: green/teal=support, red/orange=resistance, yellow/gold=IV Wall or pivot, purple=GEX.

Return ONLY valid JSON, no other text:
{"zones":[{"topPrice":5920.00,"bottomPrice":5900.00,"type":"support","zone_type":"buyer_positioning","label":"BUYER POSITIONING"}]}

If no zones found: {"zones":[]}`;

  const response = await getClient().messages.create({
    model:      "claude-opus-4-6",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } } as any,
        { type: "text", text: prompt },
      ],
    }],
  });

  const text = response.content.find(b => b.type === "text")?.text ?? "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  let parsed: { zones?: Array<{ topPrice: number; bottomPrice: number; type: string; zone_type?: string; label?: string }> };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // Response was truncated — recover complete zone objects from partial JSON
    parsed = { zones: extractPartialZones(jsonMatch[0]) };
  }

  return (parsed.zones ?? [])
    .filter(z => z.topPrice > z.bottomPrice)
    .map(z => ({
      topPrice:    z.topPrice,
      bottomPrice: z.bottomPrice,
      fillColor:   milkZoneColor(z.zone_type ?? "", z.type),
      fromTime:    0,
      toTime:      9_999_999_999,
      label:       z.label || z.zone_type || undefined,
    }));
}

// ── Screenshot → Claude vision ────────────────────────────────────────────────

export async function parseScreenshot(
  base64Data: string,
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
  visiblePriceHigh?: number,
  visiblePriceLow?:  number,
): Promise<ParsedZone[]> {
  const priceContext = visiblePriceHigh && visiblePriceLow
    ? `The chart's visible price range is approximately ${visiblePriceLow} (bottom) to ${visiblePriceHigh} (top).`
    : "Estimate prices from any axis labels visible in the image.";

  const prompt = `You are analyzing a trading chart screenshot from "Milk's Yellow Box Strategy" for ES/MES futures.

${priceContext}

## CRITICAL: Find Every Zone
Your most important job is to find EVERY colored rectangular band in this image. Do not skip any zone, even if it is small, partially obscured, or overlapping with another zone. Before finalizing your response, scan the image top-to-bottom once more to make sure you have not missed any band. Typical Milk charts have 5–15 zones; if you find fewer than 5, look again.

## Price Reading Instructions
The price axis is on the RIGHT side of the chart. Read zone edge prices by:
1. Drawing a horizontal line from the zone's top/bottom edge to the right price axis
2. Reading the exact numeric value at that point on the axis
3. Use the nearest labeled axis tick as an anchor and interpolate for unlabeled prices
4. ES/MES prices typically end in .00, .25, .50, or .75 — round to the nearest quarter point
5. Report prices to 2 decimal places (e.g., 5847.25, not 5847 or 5847.3)
6. If the visible price range is given above, use it to calibrate: zones cannot have prices outside that range

## What Counts as a Zone
INCLUDE: rectangular shaded/filled colored bands that span horizontally across the chart.
Large zones (spanning 20–100 pts or more) are common and important — do NOT skip them.
EXCLUDE:
- Individual candlestick bodies (too narrow and vertical)
- Horizontal lines (1-pixel thin — not zones)
- Chart background or grid
- Price axis labels themselves

## Zone Classification
For each zone return:
- topPrice: the price at the TOP edge of the zone
- bottomPrice: the price at the BOTTOM edge of the zone
- type: "support" (green/teal zones) or "resistance" (red/orange/yellow zones)
- zone_type: best match from Milk's vocabulary:
    buyer_positioning, buyer_objective, buyer_ultimate_target, buyer_absorb, buyer_value_add,
    seller_positioning, seller_objective, seller_ultimate_target, seller_absorb, seller_soft_target,
    buyer_positioning_strong, seller_positioning_strong,
    buyer_positioning_ltf, seller_positioning_ltf,
    iv_wall, iv_overflow, iv_gap,
    rth_gap, non_fair_value, pivot, pivot_macro,
    floor, ceiling, max_range, max_trend, normal_range,
    avg_range_low, avg_range_high, session_cap,
    ovn_spy_ceiling, ovn_spy_floor, spy_ceiling, spy_floor,
    splice_band, gex_wall_long, gex_wall_short, gex_flip,
    e_vector, s_vector, apex, options_ledge, supportive, resistive, unknown
- label: copy the EXACT text visible on the zone. Include all words (e.g. "CEILING/MAX FOR DAY", "BUYER POSITIONING", "IV WALL", "MAX RANGE DAYS"). Use "" if no text.
- startsAtOvn: true if the zone starts at the left edge of the chart (OVN-spanning), false if it starts later (RTH-only)

## Color Guide
- Green/teal → "support"; zone_type: buyer_positioning or buyer_*
- Red/orange → "resistance"; zone_type: seller_positioning or seller_*
- Yellow/gold → "resistance"; zone_type: iv_wall, pivot, or ceiling
- Purple/violet → "support"; zone_type: buyer_positioning or gex_wall_long
- Brown/tan → "resistance"; zone_type: seller_positioning

## Common Zone Labels
- "IV WALL" / "IV OVERFLOW" → iv_wall / iv_overflow
- "BUYER POSITIONING" / "BUYERS WILL VALUE ADD" → buyer_positioning
- "SELLER POSITIONING" / "SELLERS WILL VALUE ADD" → seller_positioning
- "NON FAIR VALUE" → non_fair_value
- "RTH GAP" → rth_gap
- "MAX RANGE DAYS" / "DAILY MAX" / "MAX RANGE" → max_range (startsAtOvn: true)
- "CEILING" / "CEILING/MAX FOR DAY" / "MAX FOR DAY" → ceiling (startsAtOvn: true)
- "FLOOR" / "FLOOR/MIN FOR DAY" / "MIN FOR DAY" → floor (startsAtOvn: true)
- "OVN SPY CEILING" / "OVN SPY FLOOR" → ovn_spy_ceiling / ovn_spy_floor (startsAtOvn: true)
- "BUYERS SOFT TARGET" / "SELLERS SOFT TARGET" → buyer_soft_target / seller_soft_target (startsAtOvn: true)
- "BUYERS ULTIMATE TARGET" / "SELLERS ULTIMATE TARGET" → buyer_ultimate_target / seller_ultimate_target (startsAtOvn: true)
- "NORMAL RANGE HIGH" / "NORMAL RANGE LOW" → normal_range (startsAtOvn: true)
- "AVG RANGE HIGH" / "AVG RANGE LOW" → avg_range_high / avg_range_low (startsAtOvn: true)

Return ONLY valid JSON, no explanatory text:
{
  "zones": [
    {"topPrice": 5920.25, "bottomPrice": 5900.00, "type": "support", "zone_type": "buyer_positioning", "label": "BUYER POSITIONING", "startsAtOvn": false},
    {"topPrice": 5960.00, "bottomPrice": 5945.75, "type": "resistance", "zone_type": "iv_wall", "label": "IV WALL", "startsAtOvn": true}
  ]
}

If no zones found: {"zones": []}
Double-check each price by re-reading the axis. Scan the full image again before finalizing.`;

  const response = await getClient().messages.create({
    model:      "claude-opus-4-6",
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
        { type: "text", text: prompt },
      ],
    }],
  });

  const text = response.content.find(b => b.type === "text")?.text ?? "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  let parsed: { zones?: Array<{ topPrice: number; bottomPrice: number; type: string; zone_type?: string; label?: string; startsAtOvn?: boolean }> };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // Response was truncated at token limit — recover complete zone objects from partial JSON
    parsed = { zones: extractPartialZones(jsonMatch[0]) };
  }

  return (parsed.zones ?? [])
    .filter(z => z.topPrice > z.bottomPrice)
    .map(z => {
      // Deterministic scope from zone_type takes priority — it is always more reliable
      // than Claude Vision's visual x-axis inspection (startsAtOvn).
      // Only fall back to Vision's answer when zone_type is not in the known-scope table.
      const typeScope   = zoneScopeFromType(z.zone_type ?? "");
      const labelScope  = zoneScopeFromLabel(z.label ?? "");
      const visionScope: "ovn" | "rth" | undefined =
        z.startsAtOvn === true ? "ovn" : z.startsAtOvn === false ? "rth" : undefined;
      // Priority: deterministic zone_type → label text → Vision x-axis guess
      const zoneScope = typeScope ?? labelScope ?? visionScope;
      return {
        topPrice:    z.topPrice,
        bottomPrice: z.bottomPrice,
        fillColor:   milkZoneColor(z.zone_type ?? "", z.type),
        fromTime:    0,
        toTime:      9_999_999_999,
        label:       z.label || z.zone_type || undefined,
        zoneScope,
      };
    });
}

/**
 * Deterministically map a Milk zone_type string to its time scope.
 * Returns undefined only for zone types whose scope is genuinely ambiguous.
 *
 * OVN zones span from the overnight open (~22:00 UTC / 5 PM ET).
 * RTH zones start at the regular-session open (~13:30 UTC / 9:30 AM ET).
 */
function zoneScopeFromType(zoneType: string): "ovn" | "rth" | undefined {
  switch (zoneType) {
    // ── OVN-spanning: daily structural levels placed pre-market ──────────────
    case "iv_wall":
    case "iv_overflow":
    case "iv_gap":
    case "max_range":
    case "max_trend":
    case "normal_range":
    case "avg_range_low":
    case "avg_range_high":
    case "ovn_spy_ceiling":
    case "ovn_spy_floor":
    case "spy_ceiling":
    case "spy_floor":
    case "ceiling":
    case "floor":
    case "splice_band":
    case "pivot_macro":          // weekly / macro pivot
    case "pivot_secondary":      // secondary pivot (OVN per Milk's strategy)
    case "gex_wall_long":
    case "gex_wall_short":
    case "gex_flip":
    case "e_vector":
    case "s_vector":
    case "apex":
    case "options_ledge":
    case "session_cap":
    case "buyer_soft_target":    // "BUYERS SOFT TARGET" = OVN per Milk's strategy
    case "seller_soft_target":   // "SELLERS SOFT TARGET" = OVN per Milk's strategy
    case "buyer_ultimate_target":
    case "seller_ultimate_target":
      return "ovn";

    // ── RTH-only: intraday zones that start at the 9:30 AM ET open ───────────
    case "buyer_positioning":
    case "buyer_positioning_strong":
    case "buyer_positioning_ltf":
    case "seller_positioning":
    case "seller_positioning_strong":
    case "seller_positioning_ltf":
    case "buyer_absorb":
    case "seller_absorb":
    case "buyer_value_add":
    case "buyer_objective":
    case "buyer_objective_ltf":
    case "seller_objective":
    case "seller_objective_ltf":
    case "non_fair_value":
    case "rth_gap":
    case "pivot":               // intraday daily pivot = RTH
    case "supportive":
    case "resistive":
    case "single_print":
    case "gex_median_long":
    case "gex_median_short":
    case "gex_spread":
      return "rth";

    default:
      return undefined; // unknown type — fall through to label heuristic or Vision
  }
}

/**
 * Derive scope from the zone's text label using the same regex as market.tsx's zoneFromTime().
 * Used as a secondary fallback when zone_type is unknown.
 */
function zoneScopeFromLabel(label: string): "ovn" | "rth" | undefined {
  const l = label.toLowerCase();
  if (/ovn|overnight|max[\s_]?range|iv[\s_]?wall|iv[\s_]?overflow|splice|weekly|mon[\s_]?fri|buyers?[\s_]?soft|sellers?[\s_]?soft|secondary[\s_]?pivot|avg[\s_]?range|normal[\s_]?range|support.*bottom|top.*ave/.test(l))
    return "ovn";
  if (/non[\s_]?fair|non fair|buyer[\s_]?positioning|seller[\s_]?positioning|rth[\s_]?gap|\bpivot\b/.test(l))
    return "rth";
  return undefined;
}

/**
 * Map Milk zone_type → fill color that matches Milk's actual chart colors.
 * Falls back to type-based color when zone_type is unknown.
 */
function milkZoneColor(zoneType: string, fallbackType: string): string {
  switch (zoneType) {
    // ── Strong institutional buyer zones — vivid green ────────────────────
    case "buyer_positioning_strong":
    case "buyer_absorb":
    case "buyer_ultimate_target":
      return "rgba(38,200,122,0.35)";
    // ── Standard buyer zones — mid green ─────────────────────────────────
    case "buyer_positioning":
    case "buyer_value_add":
    case "buyer_objective":
    case "supportive":
    case "support":
      return "rgba(38,200,122,0.22)";
    // ── LTF buyer zones — dim green ───────────────────────────────────────
    case "buyer_positioning_ltf":
    case "buyer_objective_ltf":
      return "rgba(38,200,122,0.14)";
    // ── Strong seller zones — vivid red ───────────────────────────────────
    case "seller_positioning_strong":
    case "seller_absorb":
    case "seller_ultimate_target":
      return "rgba(239,83,80,0.35)";
    // ── Standard seller zones — mid red ──────────────────────────────────
    case "seller_positioning":
    case "seller_objective":
    case "session_cap":
    case "resistive":
      return "rgba(239,83,80,0.22)";
    // ── LTF seller zones — dim red ────────────────────────────────────────
    case "seller_positioning_ltf":
    case "seller_objective_ltf":
    case "seller_soft_target":
      return "rgba(239,83,80,0.14)";
    // ── IV Wall — gold/yellow (Milk's signature color) ───────────────────
    case "iv_wall":
      return "rgba(255,215,0,0.28)";
    case "iv_overflow":
    case "iv_gap":
      return "rgba(255,215,0,0.18)";
    // ── RTH Gap — orange ─────────────────────────────────────────────────
    case "rth_gap":
      return "rgba(255,140,0,0.28)";
    // ── Non-fair value — muted red (price should not stay here) ──────────
    case "non_fair_value":
      return "rgba(200,50,50,0.18)";
    // ── Pivot levels — cyan ───────────────────────────────────────────────
    case "pivot":
    case "pivot_macro":
    case "pivot_secondary":
      return "rgba(34,211,238,0.18)";
    // ── Max/Normal range — purple ─────────────────────────────────────────
    case "max_range":
    case "max_trend":
    case "normal_range":
    case "avg_range_low":
    case "avg_range_high":
      return "rgba(167,139,250,0.18)";
    // ── SPY / OVN reference levels — teal ────────────────────────────────
    case "ovn_spy_ceiling":
    case "spy_ceiling":
    case "ceiling":
      return "rgba(100,160,255,0.20)";
    case "ovn_spy_floor":
    case "spy_floor":
    case "floor":
      return "rgba(100,200,160,0.20)";
    // ── Splice bands — dim gold ───────────────────────────────────────────
    case "splice_band":
      return "rgba(210,180,100,0.18)";
    // ── GEX levels — magenta ──────────────────────────────────────────────
    case "gex_flip":
    case "gex_wall_long":
    case "gex_wall_short":
    case "gex_median_long":
    case "gex_median_short":
    case "gex_spread":
      return "rgba(233,30,99,0.18)";
    // ── Vector / structural markers — blue-grey ───────────────────────────
    case "e_vector":
    case "s_vector":
    case "apex":
    case "options_ledge":
    case "single_print":
      return "rgba(150,180,220,0.18)";
    // ── Fallback: use directional type ────────────────────────────────────
    default:
      return parseColor("", fallbackType);
  }
}
