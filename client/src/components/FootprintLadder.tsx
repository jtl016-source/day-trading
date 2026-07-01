import { useMemo } from "react"; // FIX: removed useState — session is now a controlled prop from parent
import { X } from "lucide-react";
import { buildProxyFootprintCandle, FOOTPRINT_DATA_CONFIRMED, IMBALANCE_THRESHOLD } from "@/lib/footprint-analysis";

// ── Types ───────────────────────────────────────────────────────────────────

type CandleBar = {
  time: number; open: number; high: number; low: number; close: number;
  volume?: number; rth?: boolean;
};

export interface FpZoneBand {
  topPrice: number; bottomPrice: number;
  color: string; label: string;
  fromTime: number; toTime: number;
}

interface SessionLevel {
  price: number; bidVol: number; askVol: number; delta: number;
  imbalance: "buy" | "sell" | "none";
  isPoc: boolean; inValueArea: boolean;
}

interface SessionResult {
  levels: SessionLevel[];
  poc: number; vah: number; val: number;
  sessionDelta: number; sessionHigh: number; sessionLow: number;
  imbalanceClusters: { startPrice: number; endPrice: number; direction: "buy" | "sell"; stacked: boolean; count: number }[];
  candles: number;
  sessionStart: number; sessionEnd: number;
}

// ── RTH helper ──────────────────────────────────────────────────────────────

function isRTH(ts: number): boolean {
  const d = new Date(ts * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 13 * 60 + 30 && m < 21 * 60; // 9:30 AM – 5:00 PM ET (EDT)
}

// ── Session ladder builder ───────────────────────────────────────────────────

export function buildSessionLadder(candles: CandleBar[], rth: boolean): SessionResult | null {
  const filtered = candles.filter(c => rth ? (c.rth ?? isRTH(c.time)) : !(c.rth ?? isRTH(c.time)));
  if (filtered.length === 0) return null;

  // Aggregate proxy footprint levels across entire session
  const acc = new Map<number, { bidVol: number; askVol: number }>();
  for (const c of filtered) {
    const fp = buildProxyFootprintCandle(c);
    for (const lv of fp.levels) {
      const rp = Math.round(lv.price); // FOOTPRINT-SIZE-FIX: snap to whole number
      const ex = acc.get(rp) ?? { bidVol: 0, askVol: 0 };
      ex.bidVol += lv.bidVol;
      ex.askVol += lv.askVol;
      acc.set(rp, ex);
    }
  }
  if (!acc.size) return null;

  // Sort prices ascending
  const raw = [...acc.entries()]
    .map(([price, { bidVol, askVol }]) => ({ price, bidVol, askVol }))
    .sort((a, b) => a.price - b.price);

  // POC
  let poc = raw[0].price, maxVol = 0, totalBid = 0, totalAsk = 0;
  for (const lv of raw) {
    const vol = lv.bidVol + lv.askVol;
    if (vol > maxVol) { maxVol = vol; poc = lv.price; }
    totalBid += lv.bidVol; totalAsk += lv.askVol;
  }

  // VAH / VAL — 70% of volume from POC outward
  const totalVol = raw.reduce((s, l) => s + l.bidVol + l.askVol, 0);
  const target = totalVol * 0.70;
  let accum = 0, vah = poc, val = poc;
  let hi = raw.findIndex(l => Math.abs(l.price - poc) < 0.5); // FOOTPRINT-SIZE-FIX: tolerance 0.5 for whole numbers
  if (hi < 0) hi = 0;
  let lo = hi;
  while (accum < target && (hi < raw.length - 1 || lo > 0)) {
    const upV = hi < raw.length - 1 ? raw[hi + 1].bidVol + raw[hi + 1].askVol : 0;
    const dnV = lo > 0       ? raw[lo - 1].bidVol + raw[lo - 1].askVol : 0;
    if (upV >= dnV && hi < raw.length - 1) { hi++; accum += upV; vah = raw[hi].price; }
    else if (lo > 0) { lo--; accum += dnV; val = raw[lo].price; }
    else break;
  }

  // Build final level objects with imbalance flags
  const levels: SessionLevel[] = raw.map(lv => {
    const buyRatio  = lv.bidVol > 0 ? lv.askVol / lv.bidVol : 999;
    const sellRatio = lv.askVol > 0 ? lv.bidVol / lv.askVol : 999;
    const imbalance: "buy" | "sell" | "none" =
      buyRatio >= IMBALANCE_THRESHOLD ? "buy" : sellRatio >= IMBALANCE_THRESHOLD ? "sell" : "none"; // FOOTPRINT-RULE: threshold from data source
    return {
      price: lv.price, bidVol: lv.bidVol, askVol: lv.askVol,
      delta: lv.askVol - lv.bidVol, imbalance,
      isPoc: Math.abs(lv.price - poc) < 0.5, // FOOTPRINT-SIZE-FIX:
      inValueArea: lv.price >= val - 0.5 && lv.price <= vah + 0.5, // FOOTPRINT-SIZE-FIX:
    };
  });

  // Stacked imbalance clusters
  const imbalanceClusters: SessionResult["imbalanceClusters"] = [];
  let cStart = -1, cDir: "buy" | "sell" | null = null, cCount = 0;
  const flush = (endIdx: number) => {
    if (cStart < 0 || !cDir) return;
    imbalanceClusters.push({
      startPrice: levels[cStart].price,
      endPrice:   levels[endIdx - 1].price,
      direction:  cDir, count: cCount, stacked: cCount >= 3,
    });
    cStart = -1; cDir = null; cCount = 0;
  };
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    if (lv.imbalance !== "none") {
      if (lv.imbalance === cDir) { cCount++; }
      else { flush(i); cStart = i; cDir = lv.imbalance; cCount = 1; }
    } else flush(i);
  }
  flush(levels.length);

  const times = filtered.map(c => c.time);
  return {
    levels, poc, vah, val,
    sessionDelta: totalAsk - totalBid,
    sessionHigh: Math.max(...filtered.map(c => c.high)),
    sessionLow:  Math.min(...filtered.map(c => c.low)),
    imbalanceClusters, candles: filtered.length,
    sessionStart: Math.min(...times),
    sessionEnd:   Math.max(...times) + 300,
  };
}

// ── Session-start finder ─────────────────────────────────────────────────────
// Returns unix seconds when the current session (RTH or ETH) began.
// Candles at or after this time are actively forming and must not be used for zones.

function getCurrentSessionStart(nowSec: number): number {
  const now    = new Date(nowSec * 1000);
  const nowDay = now.getUTCDay();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inRth  = nowDay >= 1 && nowDay <= 5 && nowMin >= 13 * 60 + 30 && nowMin < 20 * 60 + 30;

  if (inRth) {
    // Current session = RTH; it started at 13:30 UTC today
    const d = new Date(nowSec * 1000);
    d.setUTCHours(13, 30, 0, 0);
    return d.getTime() / 1000;
  } else {
    // Current session = ETH; it started at the most recent weekday's 20:30 UTC
    for (let i = 0; i <= 7; i++) {
      const d = new Date((nowSec - i * 86400) * 1000);
      const dow = d.getUTCDay();
      if (dow >= 1 && dow <= 5) {
        d.setUTCHours(20, 30, 0, 0);
        const t = d.getTime() / 1000;
        if (t <= nowSec) return t;
      }
    }
    return nowSec - 17 * 3600; // fallback
  }
}

// ── Zone band export ─────────────────────────────────────────────────────────
// Called from market.tsx to get ZoneBand-compatible objects for chart overlay.
// Only uses candles from COMPLETED sessions — active session candles are excluded
// because those imbalances are still forming and would produce misleading zones.

export function buildFpImbalanceBands(candles: CandleBar[]): FpZoneBand[] {
  const nowSec            = Math.floor(Date.now() / 1000);
  const sessionStart      = getCurrentSessionStart(nowSec);
  const completedCandles  = candles.filter(c => c.time < sessionStart);

  const rthLadder = buildSessionLadder(completedCandles, true);
  const ethLadder = buildSessionLadder(completedCandles, false);
  const bands: FpZoneBand[] = [];

  for (const [ladder] of [[rthLadder], [ethLadder]] as const) {
    if (!ladder) continue;
    for (const cl of ladder.imbalanceClusters) {
      if (!cl.stacked) continue; // IMBALANCE-FIX: only stacked (3+ consecutive) become visible zones
      const top    = Math.max(cl.startPrice, cl.endPrice) + 0.5; // IMBALANCE-FIX: 0.5 padding per spec
      const bottom = Math.min(cl.startPrice, cl.endPrice) - 0.5; // IMBALANCE-FIX: 0.5 padding per spec
      bands.push({
        topPrice: top, bottomPrice: bottom,
        // IMBALANCE-FIX: green for buy support, red for sell resistance per spec
        color: cl.direction === "buy"
          ? "rgba(34,197,94,0.18)"   // IMBALANCE-FIX: green — stacked buy imbalance support zone per spec
          : "rgba(239,68,68,0.18)",  // IMBALANCE-FIX: red — stacked sell imbalance resistance zone per spec
        // IMBALANCE-FIX: label includes direction and level count per spec
        label: cl.direction === "buy"
          ? `▲ Stacked Buy ${cl.count} levels`
          : `▼ Stacked Sell ${cl.count} levels`,
        fromTime: ladder.sessionStart,
        toTime:   ladder.sessionEnd,
      });
    }
  }
  return bands;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}

// ── FootprintLadder — compact stats badge overlaid on the chart ───────────────

const MW = {
  bg: "#05080d", panel: "#0d1117", border: "#1e2a3a",
  text: "#c9d4e0", muted: "#4a6080", accent: "#1a72d4",
  green: "#26c87a", red: "#ef5350", amber: "#f59e0b", purple: "#a855f7",
};

export default function FootprintLadder({
  candles,
  onClose,
  session = "rth", // FIX: controlled by parent; was internal useState causing badge/canvas disconnect
  onSessionChange, // FIX: lifted so fpLadderData re-computes when user toggles
}: {
  candles: CandleBar[];
  onClose: () => void;
  session?: "rth" | "eth"; // FIX: controlled prop
  onSessionChange?: (s: "rth" | "eth") => void; // FIX: controlled callback
}) {

  const ladder = useMemo(
    () => buildSessionLadder(candles, session === "rth"),
    [candles, session],
  );

  const stackedClusters = ladder?.imbalanceClusters.filter(cl => cl.stacked) ?? [];

  // Compact stats badge — positioned top-right of chart, above the ladder column
  return (
    <div style={{
      position: "absolute", right: 134, top: 8, zIndex: 31,
      fontFamily: "'Trebuchet MS', monospace",
      background: "rgba(5,8,13,0.88)",
      backdropFilter: "blur(4px)",
      border: `1px solid ${MW.border}`,
      borderRadius: 4,
      padding: "4px 10px",
      display: "flex", alignItems: "center", gap: 10,
      pointerEvents: "auto",
    }}>
      {/* RTH / ETH toggle */}
      {(["rth", "eth"] as const).map(s => (
        <button key={s} onClick={() => onSessionChange?.(s)} style={{ // FIX: was setSession — internal state removed, now calls parent
          padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: session === s ? 700 : 400,
          cursor: "pointer",
          background: session === s ? "rgba(26,114,212,0.22)" : "transparent",
          color: session === s ? MW.accent : MW.muted,
          border: `1px solid ${session === s ? "rgba(26,114,212,0.5)" : MW.border}`,
        }}>{s.toUpperCase()}</button>
      ))}

      {!FOOTPRINT_DATA_CONFIRMED && ladder && (
        <div style={{ fontSize: 9, color: MW.amber, fontStyle: "italic" }}>proxy</div>
      )}
      {ladder && <>
        <span style={{ fontSize: 10, color: MW.muted }}>Δ <span style={{ fontWeight: 700, color: ladder.sessionDelta >= 0 ? MW.green : MW.red }}>{ladder.sessionDelta >= 0 ? "+" : ""}{fmt(ladder.sessionDelta)}</span></span>
        <span style={{ fontSize: 10, color: MW.muted }}>POC <span style={{ fontWeight: 700, color: MW.purple }}>{ladder.poc.toFixed(2)}</span></span>
        <span style={{ fontSize: 10, color: MW.muted }}>VAH <span style={{ color: MW.green }}>{ladder.vah.toFixed(2)}</span></span>
        <span style={{ fontSize: 10, color: MW.muted }}>VAL <span style={{ color: MW.red }}>{ladder.val.toFixed(2)}</span></span>
        {stackedClusters.map((cl, i) => (
          // IMBALANCE-FIX: pill-style zone indicator per spec — shows direction, price range, level count
          <span key={i} style={{
            fontSize: 9, fontWeight: 700,
            padding: "1px 5px", borderRadius: 3,
            background: cl.direction === "buy" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", // IMBALANCE-FIX: green/red bg per spec
            color: cl.direction === "buy" ? "#26c87a" : "#ef5350", // IMBALANCE-FIX: badge text per spec
            border: `1px solid ${cl.direction === "buy" ? "rgba(34,197,94,0.40)" : "rgba(239,68,68,0.40)"}`, // IMBALANCE-FIX: badge border per spec
          }}>
            {cl.direction === "buy" ? "▲ BUY" : "▼ SELL"}{" "}
            {Math.min(cl.startPrice, cl.endPrice).toFixed(0)}{"–"}{Math.max(cl.startPrice, cl.endPrice).toFixed(0)}{" "}
            <span style={{ opacity: 0.7 }}>({cl.count} lvls)</span>
          </span>
        ))}
      </>}

      <button onClick={onClose} style={{
        background: "transparent", border: "none", color: MW.muted, cursor: "pointer",
        display: "flex", alignItems: "center", padding: 0,
      }}>
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
