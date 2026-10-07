// scripts/live-bars-resolution.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// B3 (2026-09-24 review, journal chart-server-and-phone-6): server/live-bars.ts must only
// broadcast/persist the four served grids (1/5/15/60). A LiveBarRelay on a 10-minute
// MotiveWave chart tags its bars "10" verbatim — those were written to cached_candles and
// registered in sync_state. Temp SQLite via DB_PATH (the live DB is never opened).
//   npx tsx scripts/live-bars-resolution.test.ts   (exit 0 = all pass)
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}
const settle = () => new Promise<void>(r => setTimeout(r, 50));

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "live-bars-res-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.BAXTER_ARTIFACTS_DIR = tmp;
  const lb = await import("../server/live-bars");
  const { db } = await import("../server/db");
  const client = (db as any).$client as import("better-sqlite3").Database;
  const count = (res: string) => (client.prepare(`SELECT COUNT(*) n FROM cached_candles WHERE symbol='MES' AND resolution=?`).get(res) as { n: number }).n;

  assert(["1", "5", "15", "60"].every(r => lb.LIVE_BAR_RESOLUTIONS.has(r)) && !lb.LIVE_BAR_RESOLUTIONS.has("10"), "allowlist = 1/5/15/60");

  const replies: any[] = [];
  const link = { readyState: 1, send: () => {} } as unknown as import("ws").WebSocket;
  const ctx = lb.attachInProcessStudy(link, (m: object) => { replies.push(m); }, "res-test");

  lb.ingestStudyMessage({ type: "hello", symbol: "MESZ6", resolution: "10", ver: 2 } as any, ctx);
  assert(!ctx.registeredKeys.has("MES:10"), "hello with resolution 10 → no study registration (no sync_state / gap-audit row)");

  const now = Math.floor(Date.now() / 1000);
  const t10 = now - (now % 600) - 1200;
  const bar = (time: number, resolution: string) => ({ type: "bar", symbol: "MESZ6", resolution, time, open: 7700, high: 7702, low: 7698, close: 7701, volume: 500, complete: true });
  lb.ingestStudyMessage(bar(t10, "10") as any, ctx);
  await settle();
  assert(count("10") === 0, "complete bar tagged 10 → NOT persisted");

  const t1 = now - (now % 60) - 120;
  lb.ingestStudyMessage(bar(t1, "1") as any, ctx);
  await settle();
  assert(count("1") === 1, "control: complete 1m bar → persisted");

  lb.ingestStudyMessage({ type: "bulk_bars", symbol: "MESZ6", resolution: "10", id: "bf-10", seq: 0,
    bars: [{ t: t10 - 600, o: 7700, h: 7702, l: 7698, c: 7701, v: 10 }, { t: t10 - 1200, o: 7700, h: 7702, l: 7698, c: 7701, v: 10 }] } as any, ctx);
  await settle();
  assert(count("10") === 0, "bulk_bars tagged 10 → NOT persisted");
  const rep = replies.find(r => r.type === "bulk_report" && r.id === "bf-10");
  assert(!!rep && rep.accepted === 0 && rep.rejected === 2, "…but a v2 batch is still acked (accepted 0, rejected 2) so the study's seq accounting holds");

  lb.detachInProcessStudy(ctx);
}

main()
  .catch(e => { failures.push(`threw: ${e?.stack ?? e}`); console.error(e); })
  .finally(() => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.error(failures.join("\n"));
    // live-bars' import graph (gap-audit) arms module-level intervals — exit explicitly.
    process.exit(failures.length ? 1 : 0);
  });
