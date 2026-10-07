// scripts/catchup-missed-days.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unit harness for the MISSED SESSION DAYS catch-up (server/catchup.ts, 2026-10-07 — owner: "if i
// turn off my computer … i want this so i can see if the program is still running correctly").
// Temp SQLite via DB_PATH (the live data/app.db is never opened); no server, no worker, no HTTP —
// the compute is stubbed (deps.compute / the delegate) and the POST is the route's write core
// (validateSignalRow + the 120-day floor + writeSignalRows). Run: npx tsx scripts/catchup-missed-days.test.ts
//
//   M1  session calendar: weekends, CME holiday closures + early halts, DST-safe session bounds
//   M2  detection: anchor-day tail grace, weekends/holidays/DST, the 7-session cap (beyond-depth)
//   M3  state: first-use anchor seed from scheduler_last_catchup, refresh, noteRegularCatchupOk
//   M4  deferral when the day's 1m bars are missing (< 90 %), strict chronological order + skip
//   M5  back-fill: source='catchup' inserts, live rows untouched, idempotent re-run
//   M6  admission across the day boundary (open trade + cooldown from the previous missed day)
//   M7  the worker job channel (app_settings catchup_missed_job), priorFires widening, guards
//   M8  digest line text
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-missed-days-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.BAXTER_ARTIFACTS_DIR = tmp;
  // Dynamic imports AFTER DB_PATH is set (static imports would open the real DB first).
  const cu = await import("../server/catchup");
  const fa = await import("../server/fire-admission");
  const { validateSignalRow } = await import("@shared/signal-rules");
  const { sessionDayKey } = await import("@shared/yellowbox-core");
  const { db } = await import("../server/db");
  const client = (db as any).$client as import("better-sqlite3").Database;

  const et = (key: string, h: number, m = 0) => cu.etWallToUtcSec(key, h, m);
  const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
  const setState = (s: unknown) => client.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(cu.MISSED_STATE_KEY, JSON.stringify(s));
  const clearState = () => client.prepare(`DELETE FROM app_settings WHERE key IN (?, ?, 'scheduler_last_catchup')`).run(cu.MISSED_STATE_KEY, cu.MISSED_JOB_KEY);
  const freshState = (anchorAt: number) => setState({ v: 1, anchorAt, pending: [], deferred: {}, done: [], unrecoverable: [] });

  console.log("── M1 session calendar ──");
  {
    assert(cu.isSessionDay("2026-09-28") && !cu.isSessionDay("2026-09-26") && !cu.isSessionDay("2026-09-27"), "Mon is a session day, Sat/Sun are not");
    assert(!cu.isSessionDay("2026-12-25") && !cu.isSessionDay("2027-01-01") && !cu.isSessionDay("2027-03-26"), "Christmas / New Year / Good Friday 2027 are CME full closures");
    assert(cu.isSessionDay("2026-11-26") && cu.sessionBounds("2026-11-26").minutes === 1140, "Thanksgiving trades to the 13:00 ET halt (18:00 → 13:00 = 1140 min)");
    assert(cu.sessionBounds("2026-11-27").minutes === 1155 && cu.sessionBounds("2026-12-24").minutes === 1155, "Black Friday / Christmas Eve halt 13:15 ET (1155 min)");
    assert(cu.sessionBounds("2026-01-19").minutes === 1140, "MLK 13:00 halt — matches the 1135–1140 bars the real store holds");
    const fri = cu.sessionBounds("2026-10-30"), mon = cu.sessionBounds("2026-11-02");
    assert(fri.startSec === utc(2026, 10, 29, 22) && fri.endSec === utc(2026, 10, 30, 21) && fri.minutes === 1380, "EDT session: Thu 18:00 EDT = 22:00Z → Fri 17:00 EDT = 21:00Z (1380 min)");
    assert(mon.startSec === utc(2026, 11, 1, 23) && mon.endSec === utc(2026, 11, 2, 22) && mon.minutes === 1380, "first EST session after the fall-back: Sun 18:00 EST = 23:00Z → Mon 17:00 EST = 22:00Z");
    const spring = cu.sessionBounds("2027-03-15");
    assert(spring.startSec === utc(2027, 3, 14, 22) && spring.minutes === 1380, "first EDT session after the spring-forward: Sun 18:00 EDT = 22:00Z");
    assert(JSON.stringify(cu.previousSessionDays("2026-12-28", 7)) === JSON.stringify(["2026-12-24", "2026-12-23", "2026-12-22", "2026-12-21", "2026-12-18", "2026-12-17", "2026-12-16"]),
      "the 7-session depth skips the weekend and Christmas");
    assert(sessionDayKey(et("2026-09-28", 20)) === "2026-09-29", "an 18:00+ ET bar belongs to the NEXT session day (Globex)");
  }

  console.log("── M2 detection ──");
  {
    const now = et("2026-09-29", 10); // Tue 10:00 ET
    let r = cu.missedSessionDays(et("2026-09-25", 12), now);
    assert(JSON.stringify(r.recoverable) === JSON.stringify(["2026-09-25", "2026-09-28"]) && r.beyondDepth.length === 0,
      `off from Fri 12:00 → Fri (afternoon missed) + Mon; never Sat/Sun or today (got ${r.recoverable.join(",")})`);
    r = cu.missedSessionDays(et("2026-09-25", 16, 50), now);
    assert(JSON.stringify(r.recoverable) === JSON.stringify(["2026-09-28"]), "last good pass Fri 16:50 (10 min before the close ≤ 15-min grace) → Fri is NOT missed");
    r = cu.missedSessionDays(et("2026-09-25", 17, 30), now);
    assert(JSON.stringify(r.recoverable) === JSON.stringify(["2026-09-28"]), "last pass inside the 17:00–18:00 halt → Fri complete");
    r = cu.missedSessionDays(et("2026-09-29", 9), now);
    assert(r.recoverable.length === 0, "anchor already in today's session → nothing missed (today = the today pass)");
    r = cu.missedSessionDays(et("2026-11-25", 12), et("2026-11-30", 10));
    assert(JSON.stringify(r.recoverable) === JSON.stringify(["2026-11-25", "2026-11-26", "2026-11-27"]), "Thanksgiving week: the early-halt days are sessions");
    r = cu.missedSessionDays(et("2026-12-24", 10), et("2026-12-28", 10));
    assert(JSON.stringify(r.recoverable) === JSON.stringify(["2026-12-24"]), "Christmas Day closed → only Christmas Eve is missed");
    r = cu.missedSessionDays(et("2026-12-24", 13, 5), et("2026-12-28", 10));
    assert(r.recoverable.length === 0, "the tail grace uses the EARLY halt (13:05 pass on a 13:15 close → not missed)");
    r = cu.missedSessionDays(et("2026-10-30", 10), et("2026-11-03", 10));
    assert(JSON.stringify(r.recoverable) === JSON.stringify(["2026-10-30", "2026-11-02"]), "across the DST fall-back: Fri (EDT) + Mon (EST)");
    r = cu.missedSessionDays(et("2026-09-14", 10), et("2026-09-24", 10));
    assert(r.recoverable.length === cu.MAX_MISSED_SESSIONS && r.recoverable[0] === "2026-09-15" && r.recoverable[6] === "2026-09-23"
      && JSON.stringify(r.beyondDepth) === JSON.stringify(["2026-09-14"]),
      `7-session cap: 09-15..09-23 recoverable, 09-14 beyond the depth (got ${r.recoverable.length} / ${r.beyondDepth.join(",")})`);
  }

  console.log("── M3 state: first-use seed, refresh, regular-pass anchor ──");
  {
    clearState();
    client.prepare(`INSERT INTO app_settings (key, value) VALUES ('scheduler_last_catchup', ?)`).run(JSON.stringify({ at: new Date(et("2026-09-25", 12) * 1000).toISOString(), ok: true }));
    let s = cu.refreshMissedDays(et("2026-09-29", 10));
    assert(JSON.stringify(s.pending) === JSON.stringify(["2026-09-25", "2026-09-28"]), "first use seeds the anchor from scheduler_last_catchup (ok) → Fri + Mon queued");
    assert(s.anchorAt === cu.sessionBounds("2026-09-29").startSec, "after detection the anchor is today's session start (every earlier day is classified)");
    s = cu.refreshMissedDays(et("2026-09-29", 11));
    assert(s.pending.length === 2, "a second refresh does not duplicate queued days");
    clearState();
    client.prepare(`INSERT INTO app_settings (key, value) VALUES ('scheduler_last_catchup', ?)`).run(JSON.stringify({ at: new Date(et("2026-09-25", 12) * 1000).toISOString(), ok: false }));
    s = cu.refreshMissedDays(et("2026-09-29", 10));
    assert(JSON.stringify(s.pending) === JSON.stringify(["2026-09-25", "2026-09-28"]) && s.unrecoverable.length === 0,
      "first use after a FAILED last pass seeds from its time too (review 2026-10-07: a failed pass still proves the server was alive) → Fri + Mon queued");
    clearState();
    s = cu.refreshMissedDays(et("2026-09-29", 10));
    assert(s.pending.length === 0 && s.unrecoverable.length === 0, "first use with NO recorded pass invents nothing — anchor = now");
    clearState();
    freshState(et("2026-09-14", 10));
    s = cu.refreshMissedDays(et("2026-09-24", 10));
    assert(s.pending.length === 7 && s.unrecoverable.length === 1 && s.unrecoverable[0].day === "2026-09-14" && s.unrecoverable[0].reason === "beyond-depth",
      "refresh queues the 7 recoverable days and REPORTS the older one as not recoverable");
    s = cu.refreshMissedDays(et("2026-09-25", 10)); // one session later: 09-15 ages out of the depth
    assert(!s.pending.includes("2026-09-15") && s.unrecoverable.some(u => u.day === "2026-09-15"), "a queued day that ages beyond the 7-session depth moves to unrecoverable");
    clearState();
    freshState(et("2026-09-28", 9));
    cu.noteRegularCatchupOk(et("2026-09-28", 11));
    s = cu.getMissedDaysState()!;
    assert(s.anchorAt === et("2026-09-28", 11) && s.pending.length === 0, "noteRegularCatchupOk: detect first, then the anchor moves to the pass time");
    cu.noteRegularCatchupOk(et("2026-09-30", 10)); // laptop off from Mon 11:00 to Wed 10:00
    s = cu.getMissedDaysState()!;
    assert(JSON.stringify(s.pending) === JSON.stringify(["2026-09-28", "2026-09-29"]) && s.anchorAt === et("2026-09-30", 10),
      "the first good pass after a gap queues the gap (Mon afternoon + Tue) before moving the anchor");
  }

  // ── fixtures for M4–M8 ──
  const insBar = client.prepare(`INSERT OR IGNORE INTO cached_candles (symbol, resolution, timestamp, open, high, low, close, volume) VALUES ('MES', '1', ?, 7700, 7701, 7699, 7700.25, 10)`);
  const fillBars = (day: string, frac: number) => {
    const { startSec, minutes } = cu.sessionBounds(day);
    const n = Math.floor(minutes * frac);
    client.transaction(() => { for (let k = 0; k < n; k++) insBar.run(startSec + k * 60); })();
  };
  const ivSec: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };
  const fire = (interval: string, time: number, direction: "Long" | "Short", outcome: string, exitTs: number | null = null, price = 7700) => ({
    interval, time, direction, signalType: "fact-engine", price,
    tp1: direction === "Long" ? price + 10 : price - 10, tp2: null, sl: direction === "Long" ? price - 20 : price + 20,
    outcome, exitTs, exitPrice: exitTs ? (outcome === "loss" ? (direction === "Long" ? price - 20 : price + 20) : (direction === "Long" ? price + 10 : price - 10)) : null,
    pointsResult: exitTs ? (outcome === "loss" ? -20 : 10) : null, mae: null, mfe: null, barsToExit: exitTs ? Math.round((exitTs - time - ivSec[interval]) / ivSec[interval]) : null,
    label: "Vec+YB", comboKey: "Vec+YB", riskFlags: null, suggestedContracts: null, shadowTags: [],
  });
  const fakeCompute = (byDay: Record<string, any[]>, calls: string[]) => async (day: string) => {
    calls.push(day);
    return { nowSec: Math.floor(Date.now() / 1000), todayKey: day, missedDay: day, todaysFires: byDay[day] ?? [],
      dayLoss: { dayPnlPts: 0, effectiveDayPnl: 0, tripped: false, stopPts: 0 }, stuck: { checked: 0, resolved: 0, keys: [] } } as any;
  };
  // The route's write core, as POST /api/signals/history applies it (120-day floor + validator + guarded upsert).
  const routePost = async (rows: Array<Record<string, unknown>>) => {
    const floor = Math.floor(Date.now() / 1000) - 120 * 86400;
    const values = rows.filter(v => (v.timestamp as number) >= floor && validateSignalRow(v as any).ok);
    const skipped = rows.length - values.length;
    if (!values.length) return { inserted: 0, skipped };
    const r = await fa.writeSignalRows(values as any);
    return { inserted: r.accepted.length, skipped, collisions: r.collisionKeys.length, admissionRejected: r.admissionRejected.length, admissionKeys: r.admissionRejected };
  };
  const rowsOf = (sql = "") => client.prepare(`SELECT interval, timestamp, direction, outcome, entry, source FROM signal_history WHERE symbol='MES' ${sql} ORDER BY timestamp`).all() as Array<{ interval: string; timestamp: number; direction: string; outcome: string | null; entry: number; source: string | null }>;
  const insRow = client.prepare(
    `INSERT INTO signal_history (symbol, interval, timestamp, direction, risk_level, signal_type, entry, tp1, tp2, sl, outcome, exit_ts, label, source, updated_at)
     VALUES ('MES', ?, ?, ?, 'safe', 'fact-engine', ?, ?, NULL, ?, ?, ?, 'Vec+YB', ?, 'x')`);

  const D1 = "2026-09-28", D2 = "2026-09-29";
  const NOW = et("2026-09-30", 10); // Wed 10:00 ET; laptop off since Fri 09-25 16:58 ET
  const D1fires = [
    fire("60m", et(D1, 0), "Short", "win_tp1", et(D1, 1, 30)),                 // closed overnight fire
    fire("60m", et(D1, 10), "Long", "open"),                                   // 10 bars later (admitted); still open → blocks D2 60m Longs
    fire("5m", et(D1, 9, 35), "Long", "win_tp1", et(D1, 10, 5)),               // same key as a stored LIVE row (different outcome)
    fire("1m", et(D1, 11, 3), "Short", "loss", et(D1, 11, 30)),                // 3 bars after a stored live 1m Short → cooldown
    fire("15m", et(D1, 11), "Long", "win_tp1", et(D1, 12)),                    // plain missing fire → inserted
  ];
  const D2fires = [
    fire("60m", et(D1, 18), "Short", "win_tp1", et(D1, 22)),                   // 18:00 ET 09-28 = session 09-29; 8 bars after D1 10:00 → cooldown
    fire("60m", et(D2, 11), "Long", "win_tp1", et(D2, 13)),                    // 25 bars after D1's open Long → "open"
    fire("5m", et(D2, 10), "Long", "win_tp1", et(D2, 10, 30)),                 // other interval → inserted
    fire("5m", et(D1, 10), "Long", "win_tp1", et(D1, 10, 30)),                 // a D1 fire in D2's compute answer → filtered out (not D2's)
  ];

  console.log("── M4 deferral: bars missing → wait, retry, strict chronological order ──");
  {
    clearState(); client.exec(`DELETE FROM signal_history; DELETE FROM cached_candles;`);
    freshState(et("2026-09-25", 16, 58));
    const calls: string[] = [];
    const deps = { nowSec: NOW, compute: fakeCompute({ [D1]: D1fires, [D2]: D2fires }, calls), post: routePost };
    let r = await cu.runMissedDayPass("boot", deps);
    assert(r.ok && r.day === null && calls.length === 0 && r.deferred[0]?.day === D1 && r.deferred[0].coveragePct === 0,
      "no 1m bars for the oldest missed day → deferred ('bars not healed yet'), no compute request");
    assert(r.deferred.length === 1, "strict order: the healed-or-not later day is not even examined while the oldest waits (attempt 1 < 6)");
    let s = cu.getMissedDaysState()!;
    assert(s.deferred[D1]?.reason === "bars not healed yet" && s.deferred[D1].attempts === 1 && JSON.stringify(s.pending) === JSON.stringify([D1, D2]), "the deferral is recorded and the day stays queued");
    fillBars(D1, 0.85);
    r = await cu.runMissedDayPass("scheduled", deps);
    assert(r.day === null && Math.abs(r.deferred[0].coveragePct - 85) < 0.2 && cu.getMissedDaysState()!.deferred[D1].attempts === 2, "85 % coverage is still below the 90 % floor → deferred again (attempt 2)");
    fillBars(D2, 1);
    for (let k = 0; k < 3; k++) await cu.runMissedDayPass("scheduled", deps);
    assert(calls.length === 0 && cu.getMissedDaysState()!.deferred[D1].attempts === 5, "D2 is healed but waits for D1 through attempt 5 (chronological seeding)");
    r = await cu.runMissedDayPass("scheduled", deps);
    assert(r.day === D2 && calls.join(",") === D2 && r.deferred[0]?.day === D1 && r.deferred[0].attempts === 6,
      `after ${cu.MISSED_DEFER_BEFORE_SKIP} deferrals the healed later day goes ahead without the unhealed one`);
    // Reset for M5 (the D2-first run above must not leak into the ordered scenario).
    clearState(); client.exec(`DELETE FROM signal_history;`);
  }

  console.log("── M5 back-fill: catchup inserts, live rows untouched, idempotent ──");
  {
    freshState(et("2026-09-25", 16, 58));
    fillBars(D1, 0.95); // D1 now ≥ 90 %
    insRow.run("5m", et(D1, 9, 35), "Long", 7000, 7010, 6980, "loss", et(D1, 9, 50), "live");
    insRow.run("1m", et(D1, 11), "Short", 7000, 6990, 7020, "loss", et(D1, 11, 20), "live");
    const liveBefore = JSON.stringify(rowsOf(`AND source='live'`));
    const calls: string[] = [];
    const deps = { nowSec: NOW, compute: fakeCompute({ [D1]: D1fires, [D2]: D2fires }, calls), post: routePost };
    const r = await cu.runMissedDayPass("boot", deps);
    assert(r.ok && r.day === D1 && calls.join(",") === D1, "the oldest healed missed day is replayed first (one compute request)");
    const res = r.result!;
    assert(res.engineFires === 5 && res.dbRows === 2 && res.missing === 3 && res.inserted === 3,
      `D1: 5 engine fires, 2 stored rows, 3 posted/inserted (got fires ${res.engineFires} db ${res.dbRows} missing ${res.missing} inserted ${res.inserted})`);
    assert(res.admissionKeys.some(k => k.startsWith(`1m|${et(D1, 11, 3)}|Short:cooldown`)), "the 1m Short 3 bars after a stored live row is refused (cooldown)");
    const cat = rowsOf(`AND source='catchup'`);
    assert(cat.length === 3 && cat.every(x => sessionDayKey(x.timestamp) === D1), "3 source='catchup' rows, all on the missed session day");
    assert(JSON.stringify(rowsOf(`AND source='live'`)) === liveBefore, "the stored LIVE rows are byte-identical (the same-key 5m Long kept its live outcome/entry)");
    let s = cu.getMissedDaysState()!;
    assert(s.done.length === 1 && s.done[0].day === D1 && s.done[0].inserted === 3 && JSON.stringify(s.pending) === JSON.stringify([D2]) && !s.deferred[D1], "D1 is recorded done and leaves the queue");
    // Idempotent: force D1 back into the queue (as a crash-before-state-save would) and re-run.
    s.pending = [D1, D2]; s.done = []; setState(s);
    const before = rowsOf().length;
    const r2 = await cu.runMissedDayPass("manual", deps);
    assert(r2.day === D1 && r2.result!.missing === 0 && r2.result!.inserted === 0 && rowsOf().length === before, "re-running a finished day inserts nothing (every key already stored)");
    const r3 = await cu.runMissedDayPass("manual", { ...deps, compute: fakeCompute({ [D1]: D1fires }, calls) });
    assert(r3.day === null || r3.day === D2, "a done day is never re-queued by a refresh");
  }

  console.log("── M6 admission across the day boundary ──");
  {
    // The pass above (r3) may have run D2 with an EMPTY answer; replay D2 with its real fires.
    const s = cu.getMissedDaysState()!;
    s.pending = [D2]; s.done = s.done.filter(d => d.day !== D2); setState(s);
    fillBars(D2, 1);
    const calls: string[] = [];
    const r = await cu.runMissedDayPass("scheduled", { nowSec: NOW, compute: fakeCompute({ [D2]: D2fires }, calls), post: routePost });
    const res = r.result!;
    assert(r.day === D2 && res.engineFires === 3, `the compute answer is filtered to D2's session (4 returned, 3 kept — got ${res.engineFires})`);
    assert(res.admissionKeys.some(k => k === `60m|${et(D1, 18)}|Short:cooldown`), "D2's 18:00 ET (prior evening) 60m Short is refused: 8 bars after D1's back-filled 10:00 Long (cooldown crosses the day boundary)");
    assert(res.admissionKeys.some(k => k === `60m|${et(D2, 11)}|Long:open`), "D2's 60m Long is refused: D1's back-filled 60m Long is still open (one open per direction across days)");
    assert(res.inserted === 1 && rowsOf(`AND source='catchup' AND interval='5m'`).length === 1, "only D2's independent 5m Long is inserted");
    assert(cu.getMissedDaysState()!.pending.length === 0, "queue empty");
  }

  console.log("── M7 worker job channel, priorFires widening, guards ──");
  {
    const realNow = Math.floor(Date.now() / 1000);
    assert(cu.readMissedDayJob(realNow) === null, "no job → null (every normal today compute)");
    client.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(cu.MISSED_JOB_KEY, JSON.stringify({ day: D1, at: realNow }));
    assert(cu.readMissedDayJob(realNow) === D1, "a fresh job names its day");
    assert(cu.readMissedDayJob(realNow + 16 * 60) === null, "a job older than 15 min is ignored (crash leftovers can never hijack a today pass)");
    const start = realNow - (realNow % 60) - 120 * 60;
    const c1 = Array.from({ length: 120 }, (_, k) => ({ time: start + k * 60, open: 7700, high: 7701, low: 7699, close: 7700.25, volume: 10 }));
    const fetchJson = async <T,>(url: string): Promise<T> => {
      if (url.includes("/api/data/cached-days/")) return { days: [{ date: new Date((realNow - 86400) * 1000).toISOString().slice(0, 10) }] } as T;
      if (url.includes("/api/data/cached-continuous/")) return { candles: url.includes("/1m?") ? c1 : [] } as T;
      if (url.includes("/api/yellowbox/day-zones")) return { days: [] } as T;
      if (url.includes("/api/risk/combo-stats")) return { medianDayRange: 60 } as T;
      throw new Error(`unexpected url ${url}`);
    };
    let c = await cu.computeCatchup({ fetchJson });
    assert(c.missedDay === D1 && c.todayKey === D1, "computeCatchup (the worker's entry) reads the job and replays THAT day");
    cu.clearMissedDayJob();
    c = await cu.computeCatchup({ fetchJson });
    assert(c.missedDay === undefined && c.todayKey === sessionDayKey(c.nowSec), "no job → the unchanged today replay");

    // priorFires widening: a closed row 5 days back seeds only a missed-day replay.
    client.exec(`DELETE FROM signal_history;`);
    insRow.run("1m", realNow - 5 * 86400 - (realNow % 60), "Short", 7000, 6990, 7020, "win_tp1", realNow - 5 * 86400, "catchup");
    assert(!(cu.loadPriorFires(realNow)["1m"]?.length), "default seed (3 days) does not reach a closed row 5 days back");
    assert(cu.loadPriorFires(realNow, "MES", realNow - 6 * 86400)["1m"]?.length === 1, "loadPriorFires(fromTs) widens the seed back to a missed day's earlier sessions");
    const ctx = await cu.buildLiveEngineContext({ fetchJson, priorFromTs: realNow - 6 * 86400 });
    assert(ctx.priorsByIv?.["1m"]?.length === 1, "buildLiveEngineContext({priorFromTs}) carries the widened seed to the engine input");
    const ctx0 = await cu.buildLiveEngineContext({ fetchJson });
    assert(!(ctx0.priorsByIv?.["1m"]?.length), "…and without it the context is unchanged");

    // Delegate path (the worker): the job reaches it, and is cleared afterwards.
    clearState(); client.exec(`DELETE FROM signal_history;`);
    freshState(et("2026-09-25", 16, 58));
    const seen: Array<string | null> = [];
    cu.setCatchupComputeDelegate(async () => {
      const day = cu.readMissedDayJob(Math.floor(Date.now() / 1000));
      seen.push(day);
      return { nowSec: realNow, todayKey: day ?? "x", missedDay: day ?? undefined, todaysFires: day === D1 ? [D1fires[4]] : [],
        dayLoss: { dayPnlPts: 0, effectiveDayPnl: 0, tripped: false, stopPts: 0 }, stuck: { checked: 0, resolved: 0, keys: [] }, computeMode: "worker" } as any;
    });
    const r = await cu.runMissedDayPass("boot", { nowSec: NOW, post: routePost });
    assert(seen[0] === D1 && r.day === D1 && r.result?.inserted === 1 && r.result?.computeMode === "worker", "runMissedDayPass hands the day to the compute delegate through the job key (one day per request)");
    assert(cu.readMissedDayJob(Math.floor(Date.now() / 1000)) === null, "the job key is cleared after the request");
    // A today pass never consumes a missed-day answer.
    client.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(cu.MISSED_JOB_KEY, JSON.stringify({ day: D2, at: Math.floor(Date.now() / 1000) }));
    seen.length = 0;
    const st = await cu.runCatchupPass("manual");
    assert(seen[0] === null, "runCatchupPass clears any leftover job BEFORE its compute request");
    cu.setCatchupComputeDelegate(async () => ({ nowSec: realNow, todayKey: D2, missedDay: D2, todaysFires: [], dayLoss: { dayPnlPts: 0, effectiveDayPnl: 0, tripped: false, stopPts: 0 }, stuck: { checked: 0, resolved: 0, keys: [] } }) as any);
    const st2 = await cu.runCatchupPass("manual");
    assert(!st2.ok && /stale job/.test(st2.error ?? ""), "a today pass that gets a missed-day answer fails loudly instead of diffing the wrong day");
    void st;
    // Wrong-day answer to a missed-day request → error, the day stays queued.
    clearState(); client.exec(`DELETE FROM signal_history;`); freshState(et("2026-09-25", 16, 58));
    cu.setCatchupComputeDelegate(async () => ({ nowSec: realNow, todayKey: "2026-09-01", missedDay: "2026-09-01", todaysFires: [], dayLoss: { dayPnlPts: 0, effectiveDayPnl: 0, tripped: false, stopPts: 0 }, stuck: { checked: 0, resolved: 0, keys: [] } }) as any);
    const r2 = await cu.runMissedDayPass("scheduled", { nowSec: NOW, post: routePost });
    assert(!r2.ok && r2.day === D1 && cu.getMissedDaysState()!.pending.includes(D1) && cu.getMissedDaysState()!.lastError?.day === D1 && client.prepare(`SELECT COUNT(*) n FROM signal_history`).get().n === 0,
      "a compute that answers another day fails the pass; the day stays queued and lastError is recorded");
    cu.setCatchupComputeDelegate(null);
    // runMissedDaysStep: several ready days in one boot sweep, oldest first, one request each.
    clearState(); client.exec(`DELETE FROM signal_history;`);
    freshState(et("2026-09-24", 12));
    fillBars("2026-09-24", 1); fillBars("2026-09-25", 1);
    const order: string[] = [];
    const out = await cu.runMissedDaysStep({ trigger: "boot", maxDays: 7, gapMs: 0, deps: { nowSec: NOW, compute: fakeCompute({}, order), post: routePost } });
    assert(order.join(",") === "2026-09-24,2026-09-25,2026-09-28,2026-09-29" && out.length === 4 && out.every(o => o.ok),
      `the boot sweep walks every ready day oldest-first, one compute request each (got ${order.join(",")})`);
    const one: string[] = [];
    clearState(); freshState(et("2026-09-24", 12));
    const out1 = await cu.runMissedDaysStep({ trigger: "scheduled", maxDays: 1, gapMs: 0, deps: { nowSec: NOW, compute: fakeCompute({}, one), post: routePost } });
    assert(one.length === 1 && out1.length === 1, "a scheduled step (maxDays 1) replays at most ONE day");
  }

  console.log("── M8 digest line ──");
  {
    clearState();
    assert(cu.missedDaysDigestLine(NOW) === null, "no state → no digest line");
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const done = (day: string, inserted: number, at: number) => ({ day, at: iso(at), trigger: "boot", engineFires: inserted, dbRows: 0, missing: inserted, inserted, skipped: 0, collisions: 0, admissionRejected: 0, keys: [], admissionKeys: [], coveragePct: 99.9, tookMs: 1 });
    setState({ v: 1, anchorAt: NOW, pending: [], deferred: {}, done: [done("2026-09-28", 4, NOW - 3600), done("2026-09-29", 2, NOW - 1800), done("2026-09-10", 9, NOW - 3 * 86400)], unrecoverable: [] });
    assert(cu.missedDaysDigestLine(NOW) === "Catch-up: back-filled 2 missed session day(s): 2026-09-28, 2026-09-29 (6 fires)",
      `back-filled days of the last 24 h (got "${cu.missedDaysDigestLine(NOW)}")`);
    setState({ v: 1, anchorAt: NOW, pending: ["2026-09-29"], deferred: { "2026-09-29": { reason: "bars not healed yet", coveragePct: 41.2, attempts: 2, lastAt: iso(NOW) } },
      done: [done("2026-09-28", 3, NOW - 600)], unrecoverable: [{ day: "2026-09-17", at: iso(NOW - 60), reason: "beyond-depth" }, { day: "2026-09-18", at: iso(NOW - 60), reason: "beyond-depth" }] });
    const line = cu.missedDaysDigestLine(NOW);
    assert(line === "Catch-up: back-filled 1 missed session day(s): 2026-09-28 (3 fires); 2 day(s) beyond the 7-day bar depth not recoverable (2026-09-17, 2026-09-18); 1 day(s) waiting for healed 1m bars (2026-09-29 41.2%) ⚠️",
      `full line with the beyond-depth + waiting parts (got "${line}")`);
    setState({ v: 1, anchorAt: NOW, pending: [], deferred: {}, done: [done("2026-09-10", 9, NOW - 3 * 86400)], unrecoverable: [] });
    assert(cu.missedDaysDigestLine(NOW) === null, "nothing in the last 24 h and nothing pending → no line");
  }
}

main()
  .catch(e => { failures.push(`threw: ${e?.stack ?? e}`); console.error(e); })
  .finally(() => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.error(failures.join("\n"));
    process.exit(failures.length ? 1 : 0);
  });
