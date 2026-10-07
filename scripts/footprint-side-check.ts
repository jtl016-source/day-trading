// scripts/footprint-side-check.ts — is the footprint feed two-sided? (READ-ONLY, 2026-10-06)
// ─────────────────────────────────────────────────────────────────────────────
// Per ET trading day: complete MES 5m footprint candles stored, how many are two-sided /
// one-sided (shared/footprint-side.ts definition) and the ask share of volume. Then a verdict
// on the NEWEST session. Exit 0 = newest session two-sided, 1 = one-sided or nothing stored,
// 2 = error. This is the post-reinstall proof for the LiveBarRelay aggressor fix and the
// counter for the "20 two-sided sessions" trust rule (LEARNINGS 2026-10-06).
//   npx tsx scripts/footprint-side-check.ts [--days N] [--db path]     (default 10 days, data/app.db)
// ─────────────────────────────────────────────────────────────────────────────
import Database from "better-sqlite3";
import * as path from "node:path";
import { footprintSideStats, ONE_SIDED_ALARM_SHARE } from "../shared/footprint-side";

const args = process.argv.slice(2);
const argv = (k: string, d: string): string => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DAYS = Math.max(1, parseInt(argv("--days", "10"), 10) || 10);
const DB_PATH = path.resolve(argv("--db", process.env.DB_PATH ?? path.join(process.cwd(), "data", "app.db")));
const SYMBOL = "MES";

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDay = (sec: number) => dayFmt.format(new Date(sec * 1000));
const etTime = (sec: number) => new Date(sec * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

interface DayAgg { n: number; qualifying: number; twoSided: number; oneSided: number; bid: number; ask: number; last: number }

function main(): number {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
  const rows = db.prepare(
    `SELECT time, data FROM footprint_candles WHERE symbol=? AND interval='5m' AND complete=1 AND time >= ? ORDER BY time`,
  ).all(SYMBOL, since) as Array<{ time: number; data: string }>;
  db.close();

  const days = new Map<string, DayAgg>();
  let newest: { time: number; bid: number; ask: number } | null = null;
  for (const r of rows) {
    let levels: Array<{ bidVol: number; askVol: number }>;
    try { levels = (JSON.parse(r.data) as { levels?: Array<{ bidVol: number; askVol: number }> }).levels ?? []; } catch { continue; }
    const s = footprintSideStats(levels);
    const k = etDay(r.time);
    const a = days.get(k) ?? { n: 0, qualifying: 0, twoSided: 0, oneSided: 0, bid: 0, ask: 0, last: 0 };
    a.n++; a.bid += s.bidVol; a.ask += s.askVol; a.last = r.time;
    if (s.qualifies) { a.qualifying++; if (s.oneSided) a.oneSided++; else a.twoSided++; }
    days.set(k, a);
    newest = { time: r.time, bid: s.bidVol, ask: s.askVol };
  }

  console.log(`footprint_candles ${SYMBOL} 5m COMPLETE candles, last ${DAYS} d — ${DB_PATH} (read-only)`);
  console.log("day (ET)      bars  qualifying  two-sided  one-sided  askShare   last bar (ET)");
  const healthy = (a: DayAgg) => a.qualifying > 0 && a.oneSided / a.qualifying < ONE_SIDED_ALARM_SHARE;
  let healthyDays = 0;
  for (const [k, a] of days) {
    const share = a.bid + a.ask > 0 ? (a.ask / (a.bid + a.ask) * 100).toFixed(1) + "%" : "n/a";
    if (healthy(a)) healthyDays++;
    console.log(`${k}    ${String(a.n).padStart(4)}  ${String(a.qualifying).padStart(10)}  ${String(a.twoSided).padStart(9)}  ${String(a.oneSided).padStart(9)}  ${share.padStart(8)}   ${etTime(a.last)}${healthy(a) ? "" : "   ✗ one-sided"}`);
  }
  if (!newest) {
    console.log(`VERDICT: NO complete footprint candles stored in the last ${DAYS} days — is LiveBarRelay running on the 5m chart and connected to :5000?`);
    return 1;
  }
  const last = days.get(etDay(newest.time))!;
  const ok = healthy(last);
  console.log(`VERDICT: newest session ${etDay(newest.time)} is ${ok ? "TWO-SIDED ✓" : "ONE-SIDED ✗"} — newest bar ${etTime(newest.time)} bid=${newest.bid} ask=${newest.ask}; ${last.oneSided}/${last.qualifying} qualifying candles one-sided`);
  console.log(`Two-sided sessions in the window: ${healthyDays}/${days.size}. Footprint facts stay UNTRUSTED until 20 consecutive two-sided sessions are stored (LEARNINGS 2026-10-06).`);
  return ok ? 0 : 1;
}

try { process.exit(main()); } catch (e) { console.error(e); process.exit(2); }
