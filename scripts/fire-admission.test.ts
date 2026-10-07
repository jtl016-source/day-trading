// scripts/fire-admission.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unit harness for the 2026-09-24 pipeline fixes (temp SQLite via DB_PATH — the live
// data/app.db is never opened). NO test framework — plain asserts, run with:
//   npx tsx scripts/fire-admission.test.ts   (exit 0 = all pass)
//
//   B1  server/fire-admission.ts admitFires — cross-writer cooldown (either side, either
//       direction) + one open trade per direction, batch-ordered; exempt sources.
//   B2  writeSignalRows (POST /api/signals/history's core) — a conflict write keeps the
//       stored row's source + updated_at; admission applies to NEW live/catchup keys only.
//   B4  catchup.ts resolveStuckRows — under TP1_ONLY only NULL/'open' rows are walked.
//   B5  catchup.ts loadPriorFires + engineInputForInterval — the stored fires reach the
//       engine as priorFires, and the engine settings stay FACT_ENGINE_DEFAULTS.
//   B5+ (2026-09-25) buildLiveEngineContext really wires the seed (fetchJson test seam, no
//       server); the tab's GET /api/signals/prior-fires body parses back to the identical seed;
//       orderSignalGateReason (POST /api/trade/execute) orders only STORED fires; no live-path
//       writer module carries a divergent cooldown copy (ICT / legacy firing constants).
//   B1+ (2026-10-01, docs/signal-analysis-2026-10-01.md ticket 12a) one-open is SYMMETRIC: a replay
//       twin landing BEFORE a stored same-direction fire, still open at that fire's entry, is refused
//       (it used to be admitted — two open same-direction positions against one target).
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fire-admission-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.BAXTER_ARTIFACTS_DIR = tmp;
  // Dynamic imports AFTER DB_PATH is set (static imports would open the real DB first).
  const fa = await import("../server/fire-admission");
  const cu = await import("../server/catchup");
  const { db } = await import("../server/db");
  const { FACT_ENGINE_DEFAULTS } = await import("@shared/fact-engine");
  const client = (db as any).$client as import("better-sqlite3").Database;

  const CD = FACT_ENGINE_DEFAULTS.COOLDOWN_BARS;
  assert(CD === 10 && FACT_ENGINE_DEFAULTS.ONE_OPEN_PER_DIRECTION === true, `admission reads the engine defaults (COOLDOWN_BARS ${CD}, ONE_OPEN_PER_DIRECTION ${FACT_ENGINE_DEFAULTS.ONE_OPEN_PER_DIRECTION})`);

  const ins = client.prepare(
    `INSERT INTO signal_history (symbol, interval, timestamp, direction, risk_level, signal_type, entry, tp1, tp2, sl, outcome, exit_ts, source, updated_at)
     VALUES (?, ?, ?, ?, 'safe', 'fact-engine', ?, ?, NULL, ?, ?, ?, ?, ?)`);
  const clear = () => client.exec(`DELETE FROM signal_history`);
  const row = (interval: string, timestamp: number, direction: string, extra: Record<string, unknown> = {}) =>
    ({ symbol: "MES", interval, timestamp, direction, ...extra });

  const T = 1790229300; // 2026-09-24 00:35 ET, 60-aligned (and 300-aligned)

  console.log("── B1 admitFires: cooldown (either side, either direction) ──");
  clear();
  ins.run("MES", "1m", T, "Short", 7746.25, 7733, 7771, "loss", T + 300, "catchup", "2026-09-24T12:36:26.177Z");
  {
    const r = fa.admitFires([row("1m", T + 60, "Short")]);
    assert(r.admitted.length === 0 && r.rejected[0]?.reason === "cooldown", "1m Short one bar after a stored 1m Short → rejected (cooldown) — the 01:55/01:56 pair");
  }
  {
    const r = fa.admitFires([row("1m", T + 120, "Long")]);
    assert(r.rejected[0]?.reason === "cooldown", "opposite direction inside the cooldown → rejected (the engine cursor is global)");
  }
  {
    const r = fa.admitFires([row("1m", T - 3 * 60, "Short")]);
    assert(r.rejected[0]?.reason === "cooldown", "a fire 3 bars BEFORE a stored row → rejected too (phase-shifted replay on the other side)");
  }
  {
    const r = fa.admitFires([row("1m", T + (CD - 1) * 60, "Short")]);
    assert(r.rejected.length === 1, `${CD - 1} bars after → still rejected`);
  }
  {
    const r = fa.admitFires([row("1m", T + CD * 60, "Short")]);
    assert(r.admitted.length === 1, `exactly COOLDOWN_BARS (${CD}) bars after a CLOSED row → admitted (engine spacing)`);
  }
  {
    const r = fa.admitFires([row("5m", T + 300, "Short")]);
    assert(r.admitted.length === 1, "another interval is independent");
  }
  {
    const r = fa.admitFires([row("1m", T, "Short")]);
    assert(r.admitted.length === 1 && r.rejected.length === 0, "the stored row's own natural key passes through (an update, not a new fire)");
  }
  {
    const r = fa.admitFires([row("1m", T + 20 * 60, "Long"), row("1m", T + 22 * 60, "Long"), row("1m", T + 32 * 60, "Long", { outcome: "loss", exitTs: T + 33 * 60 })]);
    // T+20 admitted (outcome unknown → treated open) → T+22 cooldown; T+32 is 12 bars after T+20
    // but T+20 is still OPEN (no outcome given) → rejected 'open'.
    assert(r.admitted.length === 1 && r.admitted[0].timestamp === T + 20 * 60, "batch: the first of a cluster is admitted");
    assert(r.rejected.find(x => x.row.timestamp === T + 22 * 60)?.reason === "cooldown", "batch: rows admitted earlier in the SAME batch count as stored (cooldown)");
    assert(r.rejected.find(x => x.row.timestamp === T + 32 * 60)?.reason === "open", "batch: an admitted row with no outcome counts as open for later same-direction rows");
  }
  {
    const r = fa.admitFires([row("1m", T + 20 * 60, "Long", { outcome: "win_tp1", exitTs: T + 25 * 60 }), row("1m", T + 32 * 60, "Long")]);
    assert(r.admitted.length === 2, "batch: an admitted row resolved before the next entry does not block it");
  }

  console.log("── B1 admitFires: one open trade per direction ──");
  clear();
  const T5 = T - (T % 300);
  ins.run("MES", "5m", T5, "Short", 7757, 7748.5, 7779.5, "open", null, "live", "2026-09-24T04:00:00.000Z");
  {
    const r = fa.admitFires([row("5m", T5 + 12 * 300, "Short")]);
    assert(r.rejected[0]?.reason === "open", "same-direction 5m fire 12 bars later while the stored Short is OPEN → rejected (open)");
  }
  {
    const r = fa.admitFires([row("5m", T5 + 12 * 300, "Long")]);
    assert(r.admitted.length === 1, "opposite direction past the cooldown → admitted (one open per DIRECTION)");
  }
  client.prepare(`UPDATE signal_history SET outcome='loss', exit_ts=? WHERE interval='5m'`).run(T5 + 20 * 300);
  {
    const r = fa.admitFires([row("5m", T5 + 12 * 300, "Short")]);
    assert(r.rejected[0]?.reason === "open", "resolved, but exit_ts AFTER the new fire's entry → still open at that time → rejected");
  }
  {
    const r = fa.admitFires([row("5m", T5 + 19 * 300, "Short")]);
    assert(r.admitted.length === 1, "exit_ts == the new fire's entry (bar close) → admitted (engine: openUntil > closeTime)");
  }
  client.prepare(`UPDATE signal_history SET outcome='win_tp1', exit_ts=? WHERE interval='5m'`).run(T5 + 3 * 300);
  {
    const r = fa.admitFires([row("5m", T5 + 12 * 300, "Short")]);
    assert(r.admitted.length === 1, "after the stored trade resolved → same-direction fire admitted");
  }
  {
    const r = fa.admitFires([row("5m", T5 + 12 * 300, "Short")], { onePerDirection: false, cooldownBars: 4 });
    assert(r.admitted.length === 1, "legacy knobs (cooldown 4, stacking) are honoured when passed explicitly");
  }
  clear();
  ins.run("MES", "5m", T5 - 15 * 86400, "Short", 7757, 7748.5, 7779.5, "open", null, "live", "x");
  {
    const r = fa.admitFires([row("5m", T5, "Short")]);
    assert(r.admitted.length === 1, "an open row older than the 14-day stuck-open horizon never blocks forever");
  }

  console.log("── B1+ one-open is SYMMETRIC: a replay twin BEFORE a stored open fire (ticket 12a, 2026-10-01) ──");
  clear();
  // THE REPRODUCTION: the live engine fired + ordered a 5m Long at T5 (stored, open, target 7770). The
  // 10-min catch-up (or a tab's 2-day recompute) replays over its own bars and lands the same idea 12
  // and 24 bars EARLIER — outside the cooldown — against the same target; their own walks are open at
  // T5's entry. The engine's priors seed cannot block bars before T5 (no lookahead) and the admission
  // open check looked backward only, so both were admitted: three open Longs against one target.
  ins.run("MES", "5m", T5, "Long", 7757, 7770, 7745, "open", null, "live", "x");
  {
    const r = fa.admitFires([row("5m", T5 - 24 * 300, "Long"), row("5m", T5 - 12 * 300, "Long")]);
    assert(r.admitted.length === 0 && r.rejected.length === 2 && r.rejected.every(x => x.reason === "open" && x.blockedBy === `5m|${T5}|Long`),
      "two same-direction replay twins BEFORE a stored OPEN fire, both open at its entry → both refused (open) — admitted before 2026-10-01");
  }
  {
    const r = fa.admitFires([row("5m", T5 - 12 * 300, "Long", { outcome: "loss", exitTs: T5 - 2 * 300 })]);
    assert(r.admitted.length === 1, "a candidate whose OWN walk closed before the stored fire's entry is admitted (no overlap)");
  }
  {
    const r = fa.admitFires([row("5m", T5 - 12 * 300, "Long", { outcome: "win_tp1", exitTs: T5 + 300 })]);
    assert(r.admitted.length === 1, "candidate exit == the stored fire's entry (bar close) → admitted (engine: openUntil > closeTime)");
  }
  {
    const r = fa.admitFires([row("5m", T5 - 12 * 300, "Long", { outcome: "win_tp1", exitTs: T5 + 2 * 300 })]);
    assert(r.rejected[0]?.reason === "open", "candidate exit AFTER the stored fire's entry → still open there → refused");
  }
  {
    const r = fa.admitFires([row("5m", T5 - 12 * 300, "Short")]);
    assert(r.admitted.length === 1, "opposite direction before a stored open fire → admitted (one open per DIRECTION)");
  }
  client.prepare(`UPDATE signal_history SET outcome='loss', exit_ts=? WHERE interval='5m'`).run(T5 + 6 * 300);
  {
    const r = fa.admitFires([row("5m", T5 - 12 * 300, "Long")]);
    assert(r.rejected[0]?.reason === "open", "the stored fire has since CLOSED — the earlier open twin is still refused (the two would have overlapped at its entry)");
  }
  {
    // The ticket's other reading — a SAME-TARGET re-fire AFTER the stored trade closed — is the engine's
    // own rule (cooldown + one open), i.e. sequential, not stacking. Unchanged on purpose: changing it
    // is an R-rule (docs/signal-analysis-2026-10-01.md §5), not an admission fix.
    const r = fa.admitFires([row("5m", T5 + 12 * 300, "Long")]);
    assert(r.admitted.length === 1, "same-direction, same-target re-fire 12 bars AFTER the stored trade closed → admitted (sequential, by design)");
  }
  {
    const r = fa.admitFires([row("5m", T5 - 12 * 300, "Long")], { onePerDirection: false });
    assert(r.admitted.length === 1, "legacy stacking knob (onePerDirection:false) still admits it");
  }
  client.prepare(`UPDATE signal_history SET outcome='open', exit_ts=NULL WHERE interval='5m'`).run();
  {
    // Route level: the same refusal for a NEW catch-up key posted through writeSignalRows.
    const r = await fa.writeSignalRows([{ symbol: "MES", interval: "5m", timestamp: T5 - 12 * 300, direction: "Long", riskLevel: "safe", signalType: "fact-engine", entry: 7750, tp1: 7770, tp2: null, sl: 7740, outcome: "open", source: "catchup" } as any]);
    const stored = client.prepare(`SELECT 1 FROM signal_history WHERE interval='5m' AND timestamp=?`).get(T5 - 12 * 300);
    assert(r.freshInserts === 0 && r.admissionRejected[0]?.reason === "open" && !stored, "writeSignalRows: the earlier catch-up twin is refused at the route, not written");
  }

  console.log("── B2 writeSignalRows: provenance kept on conflict; admission on new live/catchup keys ──");
  clear();
  const base = (timestamp: number, direction: string, source: string, extra: Record<string, unknown> = {}) => ({
    symbol: "MES", interval: "1m", timestamp, direction, riskLevel: "safe", signalType: "fact-engine",
    entry: 7746.25, tp1: 7733, tp2: null, sl: 7771, outcome: "open", label: "Yellowbox(break↓ @7765.52) + Fractal(breakout↓ @7747.50)",
    source, updatedAt: "2026-09-24T12:36:26.177Z", ...extra,
  }) as any;
  const get = (ts: number, dir = "Short") => client.prepare(`SELECT source, updated_at, outcome, exit_ts FROM signal_history WHERE symbol='MES' AND interval='1m' AND timestamp=? AND direction=?`).get(ts, dir) as { source: string | null; updated_at: string; outcome: string | null; exit_ts: number | null } | undefined;
  {
    const r = await fa.writeSignalRows([base(T, "Short", "catchup")]);
    assert(r.freshInserts === 1 && get(T)?.source === "catchup", "fresh catch-up row inserted with source 'catchup'");
  }
  {
    // The tab's 2-day re-post: same key, source 'live', same outcome, fresh updatedAt.
    const r = await fa.writeSignalRows([base(T, "Short", "live", { updatedAt: "2026-09-24T14:58:35.111Z" })]);
    const g = get(T);
    assert(r.freshInserts === 0 && r.accepted.length === 1, "re-post of an existing key is an update, not a fresh insert");
    assert(g?.source === "catchup", `re-post with source 'live' KEEPS the stored 'catchup' source (got ${g?.source})`);
    assert(g?.updated_at === "2026-09-24T12:36:26.177Z", `identical re-post leaves updated_at unchanged (got ${g?.updated_at})`);
    assert(r.effective[0].source === "catchup", "the broadcast (effective) row carries the stored source");
  }
  {
    const r = await fa.writeSignalRows([base(T, "Short", "live", { outcome: "win_tp1", exitPrice: 7733, exitTs: T + 600, pointsResult: 13.25 })]);
    const g = get(T);
    assert(g?.outcome === "win_tp1" && g?.exit_ts === T + 600, "a real outcome change (open → win_tp1) still lands");
    assert(g?.source === "catchup", "…and the source still stays 'catchup'");
    assert(g?.updated_at !== "2026-09-24T12:36:26.177Z", "…and updated_at moves on a real change");
    assert(r.admissionRejected.length === 0, "outcome updates are never admission-checked");
  }
  {
    const r = await fa.writeSignalRows([base(T + 60, "Short", "live")]);
    assert(r.freshInserts === 0 && r.admissionRejected.length === 1 && r.admissionRejected[0].reason === "cooldown" && !get(T + 60), "NEW live key one bar after a stored row → refused, not written");
  }
  {
    const r = await fa.writeSignalRows([base(T + 120, "Short", "catchup")]);
    assert(r.admissionRejected.length === 1 && !get(T + 120), "NEW catch-up key inside the cooldown → refused too");
  }
  {
    const r = await fa.writeSignalRows([base(T + 180, "Short", "regen")]);
    assert(r.freshInserts === 1 && get(T + 180)?.source === "regen", "regen (--persist) rows are exempt — the standing book is its own canonical replay");
  }
  {
    const r = await fa.writeSignalRows([base(T + CD * 60 + 180, "Long", "live", { outcome: "open" })]);
    assert(r.freshInserts === 1 && get(T + CD * 60 + 180, "Long")?.source === "live", "NEW live key past the cooldown, no same-direction open → admitted");
  }
  {
    const r = await fa.writeSignalRows([base(T + CD * 60 + 180, "Long", "regen")]);
    assert(r.collisionKeys.length === 1, "unchanged: a regen write over a stored 'live' row is a collision (dropped whole)");
  }

  console.log("── B4 resolveStuckRows: TP1-only walks open rows only ──");
  clear();
  const now = Math.floor(Date.now() / 1000);
  const t0 = now - (now % 60) - 6 * 3600;
  for (let k = 0; k < 3; k++) ins.run("MES", "1m", t0 + k * 900, "Short", 7700, 7690, 7720, "win_tp1", t0 + k * 900 + 300, "catchup", "x");
  ins.run("MES", "1m", t0 + 3600, "Long", 7700, 7750, 7650, "open", null, "live", "x");
  const bars1m: Array<{ time: number; open: number; high: number; low: number; close: number }> = [];
  for (let t = t0 - 600; t <= now - 120; t += 60) bars1m.push({ time: t, open: 7700, high: 7701, low: 7699, close: 7700.25 });
  {
    const st = cu.resolveStuckRows(bars1m, now);
    assert(st.checked === 1 && st.resolved === 0, `TP1_ONLY: checked = the 1 open row, not the 3 closed winners (got ${st.checked}/${st.resolved})`);
    const legacy = cu.resolveStuckRows(bars1m, now, false);
    assert(legacy.checked === 4, `legacy (tp1Only=false) keeps the win_tp1 upgrade watch (checked ${legacy.checked})`);
  }
  {
    // Touch the open Long's TP → resolved.
    const hit = bars1m.map(b => b.time === t0 + 3600 + 1800 ? { ...b, high: 7751 } : b);
    const st = cu.resolveStuckRows(hit, now);
    assert(st.checked === 1 && st.resolved === 1, "the open row still resolves when its TP is touched");
  }

  console.log("── B5 loadPriorFires + engineInputForInterval: the seed reaches the engine ──");
  clear();
  ins.run("MES", "1m", now - 86400, "Short", 7700, 7690, 7720, "loss", now - 86000, "catchup", "x");
  ins.run("MES", "1m", now - 5 * 86400, "Long", 7700, 7750, 7650, "open", null, "live", "x");
  ins.run("MES", "1m", now - 5 * 86400 + 60, "Short", 7700, 7690, 7720, "loss", null, "regen", "x");
  ins.run("MES", "5m", now - 3600 - (now % 300), "Long", 7700, 7710, 7690, "win_tp1", now - 3000, "live", "x");
  ins.run("MES", "1m", now + 3600, "Long", 7700, 7710, 7690, "open", null, "live", "x");
  const priors = cu.loadPriorFires(now);
  assert(priors["1m"]?.length === 2 && priors["1m"]![0].time === now - 5 * 86400 && priors["1m"]![0].direction === "Long" && priors["1m"]![1].time === now - 86400,
    "1m priors = last 3 days + older still-open rows (closed 5-day-old row and future row excluded), time-ordered");
  assert(priors["5m"]?.length === 1 && priors["5m"]![0].tp1 === 7710 && !priors["15m"], "other intervals keyed separately");
  {
    const candles = [] as Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    const start = now - (now % 60) - 300 * 60;
    for (let k = 0; k < 300; k++) {
      const o = 7700 + Math.sin(k / 7) * 4;
      candles.push({ time: start + k * 60, open: o, high: o + 1.25, low: o - 1.25, close: o + 0.25, volume: 100 });
    }
    const ctx: any = {
      nowSec: now, todayKey: "x",
      servedByIv: { "1m": { candles }, "5m": { candles: [] }, "15m": { candles: [] }, "60m": { candles: [] } },
      served1m: { candles }, feDayZones: [], medianDayRange: 60, fpByTime: new Map(),
      dayLoss: { dayPnlPts: 0, effectiveDayPnl: 0, tripped: false, stopPts: 0 },
      stuck: { checked: 0, resolved: 0, keys: [] },
      priorsByIv: priors,
    };
    const input = cu.engineInputForInterval(ctx, "1m");
    assert(!!input && input.priorFires === priors["1m"], "engineInputForInterval hands the interval's stored fires to runFactEngine as priorFires");
    const st = (input?.settings ?? {}) as Record<string, unknown>;
    assert(!("COOLDOWN_BARS" in st) && !("ONE_OPEN_PER_DIRECTION" in st) && !("YB_BREAK_EVENT_BARS" in st),
      "no divergent copy: COOLDOWN_BARS / ONE_OPEN_PER_DIRECTION / YB_BREAK_EVENT_BARS come from FACT_ENGINE_DEFAULTS");
    const noSeed = cu.engineInputForInterval({ ...ctx, priorsByIv: undefined }, "1m");
    assert(!!noSeed && noSeed.priorFires === undefined, "no priors in the context → no priorFires key (pre-2026-09-24 input)");
    let threw = false;
    try { cu.runEngineForInterval(ctx, "1m"); } catch (e) { threw = true; console.error(e); }
    assert(!threw, "runEngineForInterval runs with the seed");
  }

  console.log("── B5+ buildLiveEngineContext wires loadPriorFires (fetchJson seam — no server) ──");
  {
    const es = await import("@shared/engine-seed");
    const nan = (_k: string, v: unknown) => (typeof v === "number" && Number.isNaN(v) ? "NaN" : v);
    const start = now - (now % 60) - 120 * 60;
    const c1 = Array.from({ length: 120 }, (_, k) => ({ time: start + k * 60, open: 7700, high: 7701, low: 7699, close: 7700.25, volume: 10 }));
    const urls: string[] = [];
    const fetchJson = async <T,>(url: string): Promise<T> => {
      urls.push(url);
      if (url.includes("/api/data/cached-days/")) return { days: [{ date: new Date((now - 86400) * 1000).toISOString().slice(0, 10) }] } as T;
      if (url.includes("/api/data/cached-continuous/")) return { candles: url.includes("/1m?") ? c1 : [] } as T;
      if (url.includes("/api/yellowbox/day-zones")) return { days: [] } as T;
      if (url.includes("/api/risk/combo-stats")) return { medianDayRange: 60 } as T;
      throw new Error(`unexpected url ${url}`);
    };
    const ctx = await cu.buildLiveEngineContext({ fetchJson });
    assert(urls.length === 7, `the stub served every request (${urls.length} — no real HTTP)`);
    const expected = cu.loadPriorFires(ctx.nowSec);
    assert((ctx.priorsByIv?.["1m"]?.length ?? 0) === 2 && (ctx.priorsByIv?.["5m"]?.length ?? 0) === 1,
      "buildLiveEngineContext's context carries the stored fires (1m ×2, 5m ×1) — fails if the loadPriorFires line is dropped");
    assert(JSON.stringify(ctx.priorsByIv, nan) === JSON.stringify(expected, nan), "…and they are exactly loadPriorFires(nowSec)");
    const input = cu.engineInputForInterval(ctx, "1m");
    assert(!!input && input.priorFires === ctx.priorsByIv!["1m"], "…and reach the 1m engine input as priorFires (catch-up, live worker + inline all build this way)");

    // The tab's seed: GET /api/signals/prior-fires = { nowSec, priors: loadPriorFires(nowSec, sym) }
    // through JSON → parsePriorFiresResponse must give back the identical seed.
    const wire = JSON.parse(JSON.stringify({ nowSec: ctx.nowSec, priors: expected }));
    assert(JSON.stringify(es.parsePriorFiresResponse(wire), nan) === JSON.stringify(expected, nan),
      "the tab's endpoint body parses back to the server writers' seed (NULL levels stay cooldown-only NaN)");
  }

  console.log("── B5+ orderSignalGateReason: /api/trade/execute orders only STORED fires ──");
  {
    clear();
    ins.run("MES", "1m", T, "Short", 7746.25, 7733, 7771, "open", null, "live", "x");
    assert(fa.orderSignalGateReason({ interval: "1m", fireTs: T, direction: "Short" }) === null, "stored fire → order allowed");
    // The tab's refused twin: POSTed one bar later, refused by admission → not stored → no order.
    const w = await fa.writeSignalRows([{ symbol: "MES", interval: "1m", timestamp: T + 60, direction: "Short", riskLevel: "safe", entry: 7745, tp1: 7732, tp2: null, sl: 7770, outcome: "open", source: "live" } as any]);
    assert(w.admissionRejected.length === 1, "the twin is refused by admission (setup)");
    const why = fa.orderSignalGateReason({ interval: "1m", fireTs: T + 60, direction: "Short" });
    assert(typeof why === "string" && why.includes("not a stored signal"), "refused twin → order withheld with a reason");
    assert(fa.orderSignalGateReason({ interval: "1m", fireTs: T, direction: "Long" }) !== null, "direction is part of the identity");
    assert(fa.orderSignalGateReason({ interval: "5m", fireTs: T, direction: "Short" }) !== null, "interval is part of the identity");
    assert(fa.orderSignalGateReason({ interval: "test", fireTs: Number.NaN, direction: "Long" }) === null, "no fireTs (test / manual order) → not this gate's call");
  }

  console.log("── B5+ no divergent cooldown copy in the live-path writers ──");
  {
    const files = ["server/catchup.ts", "server/live-engine.ts", "server/live-engine-worker.ts", "server/fire-admission.ts", "server/live-bars.ts"];
    const { fileURLToPath } = await import("node:url");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      const bad = /firing\/constants|ICT_CONST\.COOLDOWN_BARS|COOLDOWN_BARS\s*[:=]\s*\d|ONE_OPEN_PER_DIRECTION\s*[:=]\s*(true|false)|YB_BREAK_EVENT_BARS\s*[:=]\s*\d/.exec(src);
      assert(!bad, `${f}: no literal COOLDOWN_BARS / ONE_OPEN_PER_DIRECTION / YB_BREAK_EVENT_BARS and no ICT/legacy cooldown import${bad ? ` (found "${bad[0]}")` : ""}`);
    }
  }
}

main()
  .catch(e => { failures.push(`threw: ${e?.stack ?? e}`); console.error(e); })
  .finally(() => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.error(failures.join("\n"));
    process.exit(failures.length ? 1 : 0);
  });
