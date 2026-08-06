// Candle-by-candle "what is the program thinking" explainer.
// Fetches MES=F 5m bars from Yahoo (same source as replay-day.ts), then for each
// RTH bar of the requested day walks the EXACT gate sequence computeEngineSignals
// applies under OPTIMIZED_GATES ({vector:false, zone:"required", body:true,
// footprint:false}) and reports every gate's pass/fail with the zones involved.
// Cross-checked against computeOptimizedSignals so a mismatch prints loudly.
// Usage:
//   npx tsx scripts/candle-explain.ts            → explain the latest closed bar(s)
//   npx tsx scripts/candle-explain.ts --day      → explain every RTH bar today
//   npx tsx scripts/candle-explain.ts --since=<unixSec> → bars after that time
import YahooFinance from "yahoo-finance2";
import {
  aggregateToInterval,
  computeVectorLine,
  computeOptimizedSignals,
  detectIctZones,
  isBullZone,
  isRTH,
  MILK_TOLERANCE,
  COOLDOWN_BARS,
  OPTIMIZED_INTERVALS,
  type EngineCandle,
  type EngineZone,
  type OptimizedInterval,
} from "../client/src/lib/signal-engine";

const SYMBOL = "MES=F";

function et(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
}
const fmt = (n: number) => n.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");

interface BarExplain {
  interval: OptimizedInterval;
  bar: EngineCandle;
  lines: string[];
  fired: null | { direction: "Long" | "Short"; tier: string; entry: number; tp1: number; tp2: number; sl: number };
}

// Instrumented re-walk of computeEngineSignals under OPTIMIZED_GATES for one interval.
function explainInterval(
  candles5m: EngineCandle[],
  interval: OptimizedInterval,
  fromTs: number,
): BarExplain[] {
  const iv = OPTIMIZED_INTERVALS.find(x => x.label === interval)!;
  const sorted = aggregateToInterval(candles5m, iv.sec);
  const zones = detectIctZones(sorted);
  const vecMap = computeVectorLine(sorted);
  const exitProfile = iv.exits.rth;

  // 60m declining-vector map (same construction as the engine)
  const candles60m = aggregateToInterval(sorted, 3600);
  const vec60mMap = computeVectorLine(candles60m);
  const vec60mDecline = new Map<number, boolean>();
  let prev60m: number | null = null;
  for (const c of candles60m) {
    const v = vec60mMap.get(c.time);
    if (v != null) { vec60mDecline.set(c.time, prev60m !== null && v < prev60m); prev60m = v; }
  }
  const get60mDecline = (ts: number) => vec60mDecline.get(Math.floor(ts / 3600) * 3600) ?? false;
  const get60mVec = (ts: number) => vec60mMap.get(Math.floor(ts / 3600) * 3600);

  // Pre-bar HOD per day
  const hodBeforeBar = new Map<number, number>();
  const hodRunning = new Map<number, number>();
  for (const c of sorted) {
    if (!isRTH(c.time)) continue;
    const dayKey = Math.floor(c.time / 86400);
    const prevHod = hodRunning.get(dayKey) ?? -Infinity;
    hodBeforeBar.set(c.time, prevHod);
    hodRunning.set(dayKey, Math.max(prevHod, c.high));
  }

  const zoneActive = (z: EngineZone, ts: number) =>
    ts >= (z.fromTime ?? 0) && ts <= (z.toTime ?? Infinity);
  const zoneDesc = (z: EngineZone) => `${z.label} ${fmt(z.bottomPrice)}–${fmt(z.topPrice)}`;

  const out: BarExplain[] = [];
  let lastLongBar = -10, lastShortBar = -10;

  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    const report = c.time >= fromTs;
    const lines: string[] = [];
    let fired: BarExplain["fired"] = null;
    const push = (s: string) => { if (report) lines.push(s); };

    const rth = isRTH(c.time);
    const hr = new Date(c.time * 1000).getUTCHours();
    if (!rth) continue; // engine ignores non-RTH bars; skip silently (RTH status noted by caller)
    if (hr >= 20 && hr < 22) { push("CME settlement break (20:30–22:00 UTC window) — bar skipped"); if (report) out.push({ interval, bar: c, lines, fired }); continue; }
    const lb = vecMap.get(c.time);
    if (lb == null) { push("no vector value yet (warmup) — bar skipped"); if (report) out.push({ interval, bar: c, lines, fired }); continue; }

    // Zone test-and-hold, both directions, with the matching zones named
    const active = zones.filter(z => zoneActive(z, c.time));
    const bullHits = active.filter(z => isBullZone(z) && c.low <= z.topPrice + MILK_TOLERANCE && c.close >= z.bottomPrice - MILK_TOLERANCE);
    const bearHits = active.filter(z => !isBullZone(z) && c.high >= z.bottomPrice - MILK_TOLERANCE && c.close <= z.topPrice + MILK_TOLERANCE);
    // Nearest misses for narrative
    const bullZones = active.filter(isBullZone);
    const bearZones = active.filter(z => !isBullZone(z));
    const nearestBelow = bullZones.length
      ? bullZones.reduce((a, b) => Math.abs(c.low - a.topPrice) < Math.abs(c.low - b.topPrice) ? a : b)
      : null;
    const nearestAbove = bearZones.length
      ? bearZones.reduce((a, b) => Math.abs(c.high - a.bottomPrice) < Math.abs(c.high - b.bottomPrice) ? a : b)
      : null;

    const bullish = c.close >= c.open;
    const bearish = c.close <= c.open;
    const bodyStr = c.close > c.open ? "bullish" : c.close < c.open ? "bearish" : "doji";

    push(`bar O ${fmt(c.open)} H ${fmt(c.high)} L ${fmt(c.low)} C ${fmt(c.close)} (${bodyStr} body)`);

    // ── LONG evaluation ──
    const longCooldownLeft = Math.max(0, COOLDOWN_BARS - (i - lastLongBar));
    const prevHod = hodBeforeBar.get(c.time) ?? -Infinity;
    const nearHodLong = prevHod > -Infinity && c.close < prevHod && c.close >= prevHod - 5;
    const veto60 = get60mDecline(c.time);

    if (bullHits.length === 0) {
      const broke = bullZones.find(z => c.low <= z.topPrice + MILK_TOLERANCE && c.close < z.bottomPrice - MILK_TOLERANCE);
      const near = broke
        ? ` tested ${zoneDesc(broke)} but closed BELOW it (${fmt(c.close)} < ${fmt(broke.bottomPrice - MILK_TOLERANCE)}) — broke through, didn't hold`
        : nearestBelow
          ? ` nearest support zone: ${zoneDesc(nearestBelow)} (low ${fmt(c.low)} is ${fmt(c.low - nearestBelow.topPrice)} pts above its top; needs ≤${fmt(MILK_TOLERANCE)})`
          : " no active support zones today";
      push(`LONG  ✗ no support-zone test-and-hold.${near}`);
    } else if (!bullish) {
      push(`LONG  ✗ tested ${zoneDesc(bullHits[0])} but closed BEARISH — engine reads that as rejection, not a bounce`);
    } else if (longCooldownLeft > 0) {
      push(`LONG  ✗ zone hold OK (${zoneDesc(bullHits[0])}) + bullish body, but cooldown: ${longCooldownLeft} more bar(s) since last long`);
    } else if (nearHodLong) {
      push(`LONG  ✗ zone hold OK but close ${fmt(c.close)} is within 5 pts of pre-bar HOD ${fmt(prevHod)} — HOD suppression`);
    } else if (veto60) {
      push(`LONG  ✗ zone hold OK but 60m vector is DECLINING (${fmt(get60mVec(c.time) ?? NaN)}) — hard long veto`);
    } else {
      lastLongBar = i;
      const tp1 = c.close + exitProfile.tp1Safe, tp2 = c.close + exitProfile.tp2, sl = c.close - exitProfile.sl;
      fired = { direction: "Long", tier: "safe", entry: c.close, tp1, tp2, sl };
      push(`LONG  🔥 FIRES — held ${zoneDesc(bullHits[0])} (±2), bullish close, cooldown clear, no HOD/60m veto → entry ${fmt(c.close)} TP1 ${fmt(tp1)} TP2 ${fmt(tp2)} SL ${fmt(sl)}`);
    }
    if (report && !fired) {
      // extra context: what WOULD also have blocked, so the narrative is honest
      const also: string[] = [];
      if (bullHits.length && bullish) {
        if (longCooldownLeft > 0 && nearHodLong) also.push("HOD suppression also active");
        if ((longCooldownLeft > 0 || nearHodLong) && veto60) also.push("60m declining veto also active");
      }
      if (also.length) push(`      (${also.join("; ")})`);
    }

    // ── SHORT evaluation ──
    const shortCooldownLeft = Math.max(0, COOLDOWN_BARS - (i - lastShortBar));
    if (bearHits.length === 0) {
      const broke = bearZones.find(z => c.high >= z.bottomPrice - MILK_TOLERANCE && c.close > z.topPrice + MILK_TOLERANCE);
      const near = broke
        ? ` tested ${zoneDesc(broke)} but closed ABOVE it (${fmt(c.close)} > ${fmt(broke.topPrice + MILK_TOLERANCE)}) — broke through, didn't hold`
        : nearestAbove
          ? ` nearest resistance zone: ${zoneDesc(nearestAbove)} (high ${fmt(c.high)} is ${fmt(nearestAbove.bottomPrice - c.high)} pts below its bottom; needs ≤${fmt(MILK_TOLERANCE)})`
          : " no active resistance zones today";
      push(`SHORT ✗ no resistance-zone test-and-hold.${near}`);
    } else if (!bearish) {
      push(`SHORT ✗ tested ${zoneDesc(bearHits[0])} but closed BULLISH — rejection of the short idea`);
    } else if (shortCooldownLeft > 0) {
      push(`SHORT ✗ zone hold OK (${zoneDesc(bearHits[0])}) + bearish body, but cooldown: ${shortCooldownLeft} more bar(s) since last short`);
    } else {
      lastShortBar = i;
      const tp1 = c.close - exitProfile.tp1Safe, tp2 = c.close - exitProfile.tp2, sl = c.close + exitProfile.sl;
      fired = { direction: "Short", tier: "safe", entry: c.close, tp1, tp2, sl };
      push(`SHORT 🔥 FIRES — held ${zoneDesc(bearHits[0])} (±2), bearish close, cooldown clear → entry ${fmt(c.close)} TP1 ${fmt(tp1)} TP2 ${fmt(tp2)} SL ${fmt(sl)}`);
    }

    if (report) out.push({ interval, bar: c, lines, fired });
  }
  return out;
}

async function main() {
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const now = new Date();
  const from = new Date(now.getTime() - 10 * 86400 * 1000);
  const r = await yf.chart(SYMBOL, { period1: from, period2: now, interval: "5m", includePrePost: true });
  const candles: EngineCandle[] = [];
  for (const q of r.quotes) {
    if (q.open == null || q.high == null || q.low == null || q.close == null) continue;
    const time = Math.floor(new Date(q.date).getTime() / 1000);
    candles.push({ time, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0, rth: isRTH(time) });
  }
  candles.sort((a, b) => a.time - b.time);
  // Pop Yahoo's trailing live-quote pseudo-bar (unaligned timestamp), then drop
  // the still-forming bucket: keep only bars whose 5m bucket has fully elapsed
  while (candles.length && candles[candles.length - 1].time % 300 !== 0) candles.pop();
  const nowSec = Math.floor(Date.now() / 1000);
  const lastClosed = Math.floor(nowSec / 300) * 300 - 300;
  while (candles.length && candles[candles.length - 1].time > lastClosed) candles.pop();
  if (!candles.length) { console.log("No candle data."); return; }
  const last = candles[candles.length - 1];

  const dayMode = process.argv.includes("--day");
  const sinceArg = process.argv.find(a => a.startsWith("--since="));
  const dayStartTs = Math.floor(last.time / 86400) * 86400;
  const fromTs = dayMode
    ? dayStartTs
    : sinceArg
      ? parseInt(sinceArg.split("=")[1], 10) + 1
      : last.time; // just the newest closed bar

  console.log(`DATA last closed 5m bar: ${et(last.time)} ET (t=${last.time})  C ${fmt(last.close)}`);

  // Ground truth from the real engine
  const truth = computeOptimizedSignals(candles, nowSec);
  const truthKeys = new Set(truth.map(s => `${s.interval}_${s.time}_${s.direction}`));

  const explains: BarExplain[] = [];
  for (const ivLabel of ["5m", "15m"] as OptimizedInterval[]) {
    const ivSec = ivLabel === "5m" ? 300 : 900;
    // Only report COMPLETE buckets (all underlying 5m bars in): bucket T done when T+ivSec ≤ last.time+300
    // In --since mode report any bucket that COMPLETED after the since-bar closed
    // (a 15m bucket's bar.time is 10 min before its completion): bar.time > since+300-ivSec
    const ivFromTs = fromTs === last.time
      ? Math.floor(last.time / ivSec) * ivSec
      : sinceArg
        ? fromTs + 300 - ivSec
        : fromTs;
    for (const e of explainInterval(candles, ivLabel, ivFromTs)) {
      if (e.bar.time + ivSec <= last.time + 300) explains.push(e);
    }
  }

  explains.sort((a, b) => a.bar.time - b.bar.time || (a.interval === "5m" ? -1 : 1));
  for (const e of explains) {
    console.log(`\n■ ${et(e.bar.time)} ET  [${e.interval}]`);
    for (const l of e.lines) console.log(`  ${l}`);
    const key = e.fired ? `${e.interval}_${e.bar.time}_${e.fired.direction}` : null;
    if (key && !truthKeys.has(key)) console.log("  ⚠ MISMATCH: explainer fired but engine did not — investigate");
    if (!key) {
      for (const d of ["Long", "Short"]) {
        if (truthKeys.has(`${e.interval}_${e.bar.time}_${d}`)) console.log(`  ⚠ MISMATCH: engine fired ${d} but explainer did not — investigate`);
      }
    }
  }

  // Day tally from the real engine
  const today = truth.filter(s => s.time >= dayStartTs);
  console.log(`\nEngine signals today: ${today.length}` + (today.length
    ? " — " + today.map(s => `${s.direction} ${s.interval} @ ${et(s.time)} (${s.outcome})`).join(", ")
    : ""));
}

main().catch(e => { console.error(e); process.exit(1); });
