// Trade post-mortem replay: reconstruct a day's program signals (the exact
// trades the auto-trader fires) from Yahoo MES=F 5m data using the shared
// engine. NOTE: btWalkForward checks TP before SL within a bar, so when one
// bar's range spans both, the replay counts a WIN — treat results as the
// optimistic bound on the live day.
// Usage: npx tsx scripts/replay-day.ts [YYYY-MM-DD]   (default: today UTC)
import YahooFinance from "yahoo-finance2";
import {
  computeOptimizedSignals,
  isRTH,
  type EngineCandle,
  type OptimizedSignal,
} from "../client/src/lib/signal-engine";

const SYMBOL = "MES=F";

function utc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(".000Z", "Z");
}
function et(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
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
  while (candles.length && candles[candles.length - 1].time % 300 !== 0) candles.pop();
  console.log(`Fetched ${candles.length} 5m bars, ${utc(candles[0].time)} → ${utc(candles[candles.length - 1].time)}`);

  const signals = computeOptimizedSignals(candles);

  const dayArg = process.argv[2];
  const day = dayArg ? new Date(dayArg + "T00:00:00Z") : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const dayStart = day.getTime() / 1000;
  const dayEnd = dayStart + 86400;
  const today = signals.filter(s => s.time >= dayStart && s.time < dayEnd);

  console.log(`\nTotal signals in fetched window: ${signals.length}`);
  console.log(`Signals on ${day.toISOString().slice(0, 10)}: ${today.length}\n`);

  // Day context: today's RTH OHLC + running HOD
  const todayRth = candles.filter(c => c.time >= dayStart && c.time < dayEnd && c.rth);
  if (todayRth.length) {
    const o = todayRth[0].open;
    const h = Math.max(...todayRth.map(c => c.high));
    const l = Math.min(...todayRth.map(c => c.low));
    const c = todayRth[todayRth.length - 1].close;
    console.log(`Today RTH so far: O ${o} H ${h} L ${l} last ${c}  (${todayRth.length} 5m bars)\n`);
  }

  for (const s of today as OptimizedSignal[]) {
    console.log("─".repeat(72));
    console.log(`${s.direction.toUpperCase()} ${s.interval}  @ ${et(s.time)} ET  (${utc(s.time)})`);
    console.log(`  entry ${s.price}  TP1 ${s.tp1}  TP2 ${s.tp2}  SL ${s.sl}`);
    console.log(`  outcome: ${s.outcome ?? "?"}  tier: ${(s as any).tier ?? (s as any).risk ?? "-"}`);
    const conf = (s as any).confirmations;
    if (conf) console.log(`  confirmations: ${JSON.stringify(conf)}`);
    const zone = (s as any).zone ?? (s as any).zoneLabel;
    if (zone) console.log(`  zone: ${JSON.stringify(zone)}`);
    // Show the signal bar + next 8 bars of the SIGNAL's interval context from 5m bars
    const after = candles.filter(c => c.time >= s.time && c.time < s.time + 3600 && c.rth).slice(0, 12);
    for (const b of after) {
      console.log(`    ${et(b.time)}  O${b.open} H${b.high} L${b.low} C${b.close}`);
    }
  }

  // P&L summary
  const pnl = (s: OptimizedSignal): number | null => {
    if (s.outcome === "win_tp1") return Math.abs(s.tp1 - s.price);
    if (s.outcome === "win_tp2") return Math.abs(s.tp2 - s.price);
    if (s.outcome === "loss") return -Math.abs(s.price - s.sl);
    return null;
  };
  let total = 0, wins = 0, losses = 0, open = 0;
  for (const s of today) {
    const p = pnl(s);
    if (p == null) { open++; continue; }
    total += p;
    if (p > 0) wins++; else losses++;
  }
  console.log("─".repeat(72));
  console.log(`\nToday: ${wins} wins, ${losses} losses, ${open} open/other → ${total.toFixed(2)} pts (MES $${(total * 5).toFixed(2)}/contract)`);
}

main().catch(e => { console.error(e); process.exit(1); });
