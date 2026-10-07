// scripts/footprint-ingest.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-06 one-sided footprint incident: footprint_candles carried askVol = 0 on every level
// of every complete MES 5m bar from 2026-07-08 to 10-06 (the LiveBarRelay study shipped in July
// guessed the SDK Tick aggressor method by reflection and every trade fell to the bid side).
// This pins the SERVER half of the contract so a future regression can be localised in seconds:
//   • a two-sided `footprint_bar` study message (levels [{price,b,a}]) reaches footprint_candles
//     with BOTH sides intact, level for level, under the normalized symbol;
//   • both imbalance directions survive, same-bucket messages accumulate, the bucket rollover
//     finalizes the candle;
//   • the dead-ask signature (every level "sell", ONE stacked sell cluster spanning the bar) is
//     flagged `oneSided` by shared/footprint-side.ts, and a tiny legitimate print is not.
// Temp SQLite via DB_PATH — the live DB is never opened.
//   npx tsx scripts/footprint-ingest.test.ts   (exit 0 = all pass)
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}
const settle = (ms = 80) => new Promise<void>(r => setTimeout(r, ms));

interface StoredLevel { price: number; bidVol: number; askVol: number; delta: number; imbalance: "buy" | "sell" | "none" }
interface StoredCandle {
  levels: StoredLevel[]; totalBidVol: number; totalAskVol: number; complete: boolean; oneSided?: boolean;
  imbalances: Array<{ startPrice: number; endPrice: number; direction: "buy" | "sell"; levelCount: number; stacked: boolean }>;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "footprint-ingest-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.BAXTER_ARTIFACTS_DIR = tmp;
  const lb = await import("../server/live-bars");
  const { footprintSideStats } = await import("../shared/footprint-side");
  const { db } = await import("../server/db");
  const client = (db as any).$client as import("better-sqlite3").Database;
  await settle(); // live-bars binds footprint-engine.addBar through a dynamic import at module load

  const link = { readyState: 1, send: () => {} } as unknown as import("ws").WebSocket;
  const ctx = lb.attachInProcessStudy(link, () => {}, "fp-test");
  const send = (time: number, levels: Array<{ price: number; b: number; a: number }>) =>
    lb.ingestStudyMessage({ type: "footprint_bar", symbol: "MESZ6", resolution: "5", time, levels } as any, ctx); // raw month-coded symbol, as the study sends it
  const row = (time: number) => client.prepare(
    `SELECT complete, data FROM footprint_candles WHERE symbol='MES' AND interval='5m' AND time=?`,
  ).get(time) as { complete: number; data: string } | undefined;
  const parse = (time: number): StoredCandle => JSON.parse(row(time)!.data) as StoredCandle;

  const now = Math.floor(Date.now() / 1000);
  const T = now - (now % 300) - 1800; // a 5m bucket that closed half an hour ago

  // ── Two-sided bar: every classification in one message ──
  // ask-stacked (buy), bid-stacked (sell), balanced (none), ask-only (buy by zero-vs-nonzero)
  const levels = [
    { price: 7700.00, b: 10, a: 40 },
    { price: 7700.25, b: 60, a: 15 },
    { price: 7700.50, b: 30, a: 30 },
    { price: 7700.75, b: 0,  a: 12 },
  ];
  send(T, levels);
  await settle();
  const preview = row(T);
  assert(!!preview && preview.complete === 0, "two-sided footprint_bar → preview row persisted (complete=0) under the normalized key MES/5m");

  send(T + 300, [{ price: 7701, b: 5, a: 7 }]); // next bucket → finalizes T
  await settle();
  const done = row(T);
  assert(!!done && done.complete === 1, "bucket rollover → T re-stored as a COMPLETE candle");
  const c = parse(T);
  const byPrice = new Map(c.levels.map(l => [l.price, l]));
  assert(c.levels.length === 4, "all four price levels stored");
  assert(levels.every(l => byPrice.get(l.price)?.bidVol === l.b && byPrice.get(l.price)?.askVol === l.a),
    "every level keeps BOTH sides: bidVol === b and askVol === a, level for level (the b/a → bidVol/askVol mapping)");
  assert(c.totalBidVol === 100 && c.totalAskVol === 97, "totals: bid 100 / ask 97");
  assert(byPrice.get(7700)?.imbalance === "buy" && byPrice.get(7700.25)?.imbalance === "sell"
      && byPrice.get(7700.5)?.imbalance === "none" && byPrice.get(7700.75)?.imbalance === "buy",
    "per-level classification: ask-stacked=buy, bid-stacked=sell, balanced=none, ask-only=buy");
  assert(c.imbalances.some(z => z.direction === "buy") && c.imbalances.some(z => z.direction === "sell"),
    "imbalance clusters carry BOTH directions");
  assert(c.oneSided === false, "two-sided candle stored with oneSided=false");
  assert(footprintSideStats(c.levels).oneSided === false, "shared side-stats agree: not one-sided");

  // ── Same-bucket accumulation ──
  send(T + 300, [{ price: 7701, b: 1, a: 2 }, { price: 7701.25, b: 3, a: 0 }]);
  await settle();
  const p2 = parse(T + 300);
  const l7701 = p2.levels.find(l => l.price === 7701);
  assert(p2.complete === false && l7701?.bidVol === 6 && l7701?.askVol === 9 && p2.levels.length === 2,
    "same-bucket messages accumulate per level on the preview (b 5+1, a 7+2; new level added)");

  // ── The 2026-07 failure signature ──
  // A relay whose aggressor side is dead sends a = 0 on every level. footprint-engine's
  // zero-vs-nonzero rule then marks EVERY level 'sell' and the cluster walk collapses the bar
  // into ONE stacked sell zone spanning its full range → a Short footprint fact, never a Long.
  const T2 = T + 600;
  const dead = [7702, 7702.25, 7702.5, 7702.75, 7703].map((price, i) => ({ price, b: 40 + i * 10, a: 0 }));
  send(T2, dead);
  send(T2 + 300, [{ price: 7703, b: 1, a: 1 }]);
  await settle();
  const d = parse(T2);
  assert(d.complete === true && d.totalAskVol === 0 && d.totalBidVol === 300 && d.levels.every(l => l.imbalance === "sell"),
    "ask-dead candle: ask total 0, every level classified 'sell' (the July → October signature)");
  assert(d.imbalances.length === 1 && d.imbalances[0].direction === "sell" && d.imbalances[0].stacked && d.imbalances[0].levelCount === 5
      && d.imbalances[0].startPrice === 7702 && d.imbalances[0].endPrice === 7703,
    "…collapsing into ONE stacked SELL cluster spanning the whole bar (why every footprint fire went Short)");
  assert(d.oneSided === true, "…and the stored candle is flagged oneSided=true (what W3 / footprint-side-check read)");
  assert(footprintSideStats(d.levels).oneSided === true, "shared side-stats flag it one-sided");

  // ── No false alarm on a tiny legitimate print ──
  const tiny = footprintSideStats([{ bidVol: 4, askVol: 0 }, { bidVol: 2, askVol: 0 }]);
  assert(tiny.qualifies === false && tiny.oneSided === false, "a 2-level / 6-contract one-sided print is below the defect threshold");
  const bigBalanced = footprintSideStats([7700, 7700.25, 7700.5, 7700.75].map(() => ({ bidVol: 20, askVol: 20 })));
  assert(bigBalanced.qualifies === true && bigBalanced.oneSided === false, "a qualifying two-sided candle is not flagged");

  lb.detachInProcessStudy(ctx);
}

main()
  .catch(e => { failures.push(`threw: ${e?.stack ?? e}`); console.error(e); })
  .finally(() => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.error(failures.join("\n"));
    // live-bars' import graph (gap-audit, contract-guard) arms module-level intervals — exit explicitly.
    process.exit(failures.length ? 1 : 0);
  });
