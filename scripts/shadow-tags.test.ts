// scripts/shadow-tags.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-01 SHADOW TAGS — persistence + scoring (temp SQLite via DB_PATH; the live data/app.db
// is never opened). NO test framework — plain asserts:
//   npx tsx scripts/shadow-tags.test.ts   (exit 0 = all pass)
//
//   T1  server/db.ts DDL adds signal_history.shadow_tags (idempotent ALTER).
//   T2  writeSignalRows (POST /api/signals/history's core — the catch-up + live engine + tab
//       writers all land here) persists FactSignal.shadowTags as a JSON string array: array and
//       pre-serialized forms, '[]' kept distinct from NULL, garbage → NULL, a re-post without
//       tags never erases stored ones (COALESCE), catch-up rows go through admission unchanged.
//   T3  shadowTagSummary math on a hand-built book: raw vs de-clustered (one open per direction
//       per interval), −1 pt friction, derived points when points_result is NULL, open/unscored
//       rows, legacy NULL rows excluded from tagged AND untagged, the "all" row, judgeable at 40.
//   T4  GET /api/signals/shadow-tags/summary handler: query validation + body.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-tags-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.BAXTER_ARTIFACTS_DIR = tmp;
  // Dynamic imports AFTER DB_PATH is set (static imports would open the real DB first).
  const fa = await import("../server/fire-admission");
  const st = await import("../server/shadow-tags-routes");
  const { db } = await import("../server/db");
  const { SHADOW_TAG_IDS } = await import("@shared/fact-engine");
  const client = (db as any).$client as import("better-sqlite3").Database;

  console.log("── T1 DDL ──");
  const cols = (client.prepare(`PRAGMA table_info(signal_history)`).all() as Array<{ name: string; type: string }>);
  assert(cols.some(c => c.name === "shadow_tags" && c.type.toUpperCase() === "TEXT"), "signal_history.shadow_tags TEXT exists on a fresh DB");

  const nowSec = Math.floor(Date.now() / 1000);
  const T = Math.floor((nowSec - 5 * 86400) / 3600) * 3600; // 5 days ago, hour-aligned
  const get = (iv: string, ts: number, dir: string) =>
    client.prepare(`SELECT shadow_tags, source FROM signal_history WHERE symbol='MES' AND interval=? AND timestamp=? AND direction=?`).get(iv, ts, dir) as { shadow_tags: string | null; source: string | null } | undefined;
  const base = (iv: string, ts: number, dir: string, extra: Record<string, unknown> = {}) => ({
    symbol: "MES", interval: iv, timestamp: ts, direction: dir, riskLevel: "safe", signalType: "fact-engine",
    entry: 100, tp1: dir === "Long" ? 110 : 90, tp2: null, sl: dir === "Long" ? 75 : 125, outcome: "open", label: "x", ...extra,
  }) as any;

  console.log("── T2 writeSignalRows persists shadow tags ──");
  client.exec(`DELETE FROM signal_history`);
  await fa.writeSignalRows([
    base("1m", T, "Long", { source: "regen", shadowTags: ["box-side-wrong", "range-below-0.25med"] }),
    base("1m", T + 3600, "Long", { source: "regen", shadowTags: '["tight-room@5m15m"]' }),
    base("1m", T + 7200, "Long", { source: "regen", shadowTags: [] }),
    base("1m", T + 10800, "Long", { source: "regen" }),
    base("1m", T + 14400, "Long", { source: "regen", shadowTags: { not: "an array" } }),
  ]);
  assert(get("1m", T, "Long")?.shadow_tags === '["box-side-wrong","range-below-0.25med"]', "an array is stored as its JSON string, order kept");
  assert(get("1m", T + 3600, "Long")?.shadow_tags === '["tight-room@5m15m"]', "a pre-serialized JSON array string is stored as-is (normalized)");
  assert(get("1m", T + 7200, "Long")?.shadow_tags === "[]", "'[]' (evaluated, nothing tripped) stays distinct from NULL");
  assert(get("1m", T + 10800, "Long")?.shadow_tags === null, "a writer that sends no tags stores NULL (legacy / not evaluated)");
  assert(get("1m", T + 14400, "Long")?.shadow_tags === null, "a non-array value is rejected to NULL");
  // Conflict re-posts (the tab's re-post class): no tags / garbage never erase; a real value refreshes.
  await fa.writeSignalRows([
    base("1m", T, "Long", { source: "regen" }),
    base("1m", T + 3600, "Long", { source: "regen", shadowTags: "garbage" }),
    base("1m", T + 10800, "Long", { source: "regen", shadowTags: ["box-side-wrong"] }),
  ]);
  assert(get("1m", T, "Long")?.shadow_tags === '["box-side-wrong","range-below-0.25med"]', "re-post WITHOUT tags keeps the stored tags (COALESCE)");
  assert(get("1m", T + 3600, "Long")?.shadow_tags === '["tight-room@5m15m"]', "re-post with an invalid tag value keeps the stored tags");
  assert(get("1m", T + 10800, "Long")?.shadow_tags === '["box-side-wrong"]', "re-post with tags fills a NULL row");
  {
    // CATCH-UP rows (source 'catchup', FactSignal → row mapping `shadowTags: s.shadowTags ?? null`)
    // go through fire admission unchanged and persist their tags; a refused twin persists nothing.
    const sig = { shadowTags: ["box-side-wrong"] as string[] | undefined };
    const r = await fa.writeSignalRows([
      base("5m", T, "Short", { source: "catchup", shadowTags: sig.shadowTags ?? null }),
      base("5m", T + 300, "Short", { source: "catchup", shadowTags: ["range-above-1.0med"] }), // 1 bar later → cooldown
    ]);
    assert(r.freshInserts === 1 && r.admissionRejected.length === 1 && r.admissionRejected[0].reason === "cooldown",
      "catch-up batch: admission still decides (1 admitted, the 1-bar twin refused on cooldown)");
    assert(get("5m", T, "Short")?.shadow_tags === '["box-side-wrong"]' && get("5m", T, "Short")?.source === "catchup" && get("5m", T + 300, "Short") === undefined,
      "catch-up: the admitted fire carries its tags; the refused twin is not stored");
    assert(r.effective.find(v => v.timestamp === T)?.shadowTags === '["box-side-wrong"]', "the broadcast (effective) row carries the stored JSON form");
    const live = await fa.writeSignalRows([base("15m", T, "Long", { source: "live", shadowTags: ["tight-room@5m15m", "box-side-wrong"] })]);
    assert(live.freshInserts === 1 && get("15m", T, "Long")?.shadow_tags === '["tight-room@5m15m","box-side-wrong"]', "a live-engine row persists its tags");
  }
  assert(fa.normalizeShadowTags(["a"]) === '["a"]' && fa.normalizeShadowTags("[1]") === null && fa.normalizeShadowTags(null) === null
    && fa.normalizeShadowTags(["a", 2]) === null && fa.normalizeShadowTags("[]") === "[]", "normalizeShadowTags: string arrays only");

  console.log("── T3 shadowTagSummary math ──");
  client.exec(`DELETE FROM signal_history`);
  const ins = client.prepare(
    `INSERT INTO signal_history (symbol, interval, timestamp, direction, risk_level, signal_type, entry, tp1, tp2, sl, outcome, exit_ts, points_result, shadow_tags, source)
     VALUES ('MES', ?, ?, ?, 'safe', 'fact-engine', ?, ?, NULL, ?, ?, ?, ?, ?, 'regen')`);
  const J = (x: string[] | null) => (x == null ? null : JSON.stringify(x));
  // 1m stream                          iv    ts          dir      entry tp1  sl   outcome    exit_ts      pts   tags
  ins.run("1m", T,         "Long",  100, 110, 75,  "win_tp1", T + 600,     10,   J(["box-side-wrong"]));                          // #1 kept
  ins.run("1m", T + 120,   "Long",  100, 110, 75,  "loss",    T + 900,     -20,  J(["box-side-wrong"]));                          // #2 clustered (#1 open at its entry)
  ins.run("1m", T + 1200,  "Long",  100, 110, 75,  "loss",    T + 1500,    -25,  J([]));                                          // #3 kept (clean)
  ins.run("1m", T + 1260,  "Short", 100, 92,  125, "win_tp1", T + 1400,    null, J(["range-below-0.25med", "box-side-wrong"]));   // #4 kept, pts derived +8
  ins.run("1m", T + 1320,  "Short", 100, 92,  125, "open",    null,        null, J(["box-side-wrong"]));                          // #5 clustered, open
  ins.run("1m", T + 3000,  "Long",  100, 112, 75,  "win_tp1", T + 3300,    12,   null);                                           // #6 legacy (NULL tags), kept
  ins.run("5m", T,         "Short", 100, 90,  124, "loss",    T + 3000,    -24,  J(["tight-room@5m15m"]));                        // #7 kept
  ins.run("1m", T + 5000,  "Long",  100, 110, 75,  "eod",     T + 6000,    null, J([]));                                          // #8 unscored (eod, no points)
  ins.run("1m", nowSec - 100 * 86400, "Long", 100, 110, 75, "win_tp1", null, 10, J(["box-side-wrong"]));                           // #9 outside 90 d
  // 15m: 40 spaced tagged winners → judgeable.
  for (let k = 0; k < 40; k++) ins.run("15m", T - 86400 * 2 + k * 3600, "Long", 100, 105, 80, "win_tp1", T - 86400 * 2 + k * 3600 + 1800, 5, J(["range-above-1.0med"]));

  const sum = st.shadowTagSummary({ nowSec, days: 90 });
  const row = (tag: string, iv: string) => sum.tags.find(r => r.tag === tag && r.interval === iv)!;
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  assert(sum.rows.total === 48 && sum.rows.legacy === 1 && sum.rows.evaluated === 47 && sum.rows.open === 1 && sum.rows.unscored === 1 && sum.rows.clustered === 2,
    `row census: 48 in window (old row excluded), 1 legacy, 1 open, 1 unscored, 2 clustered (${JSON.stringify(sum.rows)})`);
  assert(sum.tags.length === SHADOW_TAG_IDS.length * 5, "one row per tag × {1m,5m,15m,60m,all}");
  const b1 = row("box-side-wrong", "1m");
  assert(eq(b1.tagged.raw, { n: 3, wins: 2, winPct: 66.7, grossPts: -2, netPts: -5, expPts: -1.67, open: 1 }),
    `box-side-wrong@1m RAW: #1 +10, #2 −20, #4 +8 (derived) − 3×1 friction = −5; #5 open (${JSON.stringify(b1.tagged.raw)})`);
  assert(eq(b1.tagged.declustered, { n: 2, wins: 2, winPct: 100, grossPts: 18, netPts: 16, expPts: 8, open: 0 }),
    `box-side-wrong@1m DE-CLUSTERED: #2 and #5 dropped (same-direction trade still open) → +16 (${JSON.stringify(b1.tagged.declustered)})`);
  assert(eq(b1.untagged.raw, { n: 1, wins: 0, winPct: 0, grossPts: -25, netPts: -26, expPts: -26, open: 0 }),
    `box-side-wrong@1m UNTAGGED: only #3 (the legacy #6 is in neither group; #8 unscored) (${JSON.stringify(b1.untagged.raw)})`);
  assert(b1.judgeable === false, "box-side-wrong@1m: n 2 de-clustered → not judgeable");
  assert(eq(row("range-below-0.25med", "1m").tagged.raw, { n: 1, wins: 1, winPct: 100, grossPts: 8, netPts: 7, expPts: 7, open: 0 }),
    "range-below-0.25med@1m: #4 alone (derived +8 − 1)");
  assert(eq(row("tight-room@5m15m", "5m").tagged.declustered, { n: 1, wins: 0, winPct: 0, grossPts: -24, netPts: -25, expPts: -25, open: 0 })
    && row("tight-room@5m15m", "1m").tagged.raw.n === 0,
    "tight-room@5m15m: the 5m row only");
  const ra = row("range-above-1.0med", "15m");
  assert(ra.tagged.declustered.n === 40 && ra.tagged.declustered.netPts === 160 && ra.judgeable === true,
    `range-above-1.0med@15m: 40 de-clustered winners (+5 −1 each = +160) → judgeable at n ≥ ${st.SHADOW_TAG_JUDGEABLE_MIN_N}`);
  const bAll = row("box-side-wrong", "all");
  assert(bAll.tagged.raw.n === 3 && bAll.untagged.raw.n === 1 + 1 + 40 && bAll.untagged.raw.netPts === -26 - 25 + 160,
    `"all" row aggregates every interval (untagged = #3 + #7 + the 40 15m rows) (${JSON.stringify(bAll.untagged.raw)})`);
  assert(eq(sum.clean["1m"].raw, { n: 1, wins: 0, winPct: 0, grossPts: -25, netPts: -26, expPts: -26, open: 0 }) && sum.clean["15m"].raw.n === 0,
    "clean@1m = the '[]' rows (#3; #8 unscored)");
  assert(st.shadowTagSummary({ nowSec, days: 90, symbol: "ES" }).rows.total === 0, "symbol filter");
  assert(st.shadowTagSummary({ nowSec, days: 200 }).rows.total === 49, "days widens the window (the 100-day-old row joins)");
  {
    // An open row older than OPEN_LOOKBACK_SEC stops holding its slot (admission's horizon).
    client.exec(`DELETE FROM signal_history`);
    const t0 = nowSec - 40 * 86400;
    ins.run("1m", t0, "Long", 100, 110, 75, "open", null, null, J([]));
    ins.run("1m", t0 + 3 * 86400, "Long", 100, 110, 75, "win_tp1", t0 + 3 * 86400 + 600, 10, J(["box-side-wrong"]));
    ins.run("1m", t0 + 20 * 86400, "Long", 100, 110, 75, "win_tp1", t0 + 20 * 86400 + 600, 10, J(["box-side-wrong"]));
    const s2 = st.shadowTagSummary({ nowSec, days: 90 });
    const r2 = s2.tags.find(r => r.tag === "box-side-wrong" && r.interval === "1m")!;
    assert(r2.tagged.raw.n === 2 && r2.tagged.declustered.n === 1 && s2.rows.clustered === 1,
      "de-cluster: an open row blocks same-direction rows for 14 days, then releases the slot");
  }

  console.log("── T4 route handler ──");
  {
    let handler: any = null; let routePath = "";
    st.registerShadowTagRoutes({ get: ((p: string, h: any) => { routePath = p; handler = h; }) as any }, client);
    const call = (query: Record<string, unknown>) => {
      const out: { status: number; body: any } = { status: 200, body: null };
      const res: any = {
        status(c: number) { out.status = c; return res; },
        json(b: unknown) { out.body = b; return res; },
        type() { return res; },
        send(b: string) { out.body = JSON.parse(b); return res; },
      };
      handler({ query }, res);
      return out;
    };
    assert(routePath === "/api/signals/shadow-tags/summary", "route path");
    const ok = call({ days: "90" });
    assert(ok.status === 200 && ok.body.days === 90 && ok.body.frictionPts === 1 && ok.body.judgeableMinN === 40 && Array.isArray(ok.body.tags),
      "GET ?days=90 → 200 with the summary body");
    assert(call({}).body.days === 90, "days defaults to 90");
    assert(call({ days: "abc" }).status === 400 && call({ days: "0" }).status === 400 && call({ symbol: "MES;DROP" }).status === 400,
      "invalid days / symbol → 400");
  }

  try { client.close(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows WAL handles */ }
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.error("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
