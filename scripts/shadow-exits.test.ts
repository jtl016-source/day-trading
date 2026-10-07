// scripts/shadow-exits.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unit harness for server/shadow-exits.ts (2026-10-01 shadow-exit recorder). Temp SQLite via
// DB_PATH — the live data/app.db is never opened. Plain asserts, run with:
//   npx tsx scripts/shadow-exits.test.ts   (exit 0 = all pass)
//
//   S1  walkShadowExit: shipped bracket ≡ shared/outcome-resolver walkOutcomeCanonical (carry,
//       TP1-only) on 400 random paths; same-bar stop+target = loss.
//   S2  breakeven move (acts from the NEXT bar, moved stop fills at a gapped open).
//   S3  trail activation + giveback (no activation below m; trail stop never loosens).
//   S4  time stop at 240 min; Apex 16:55 cut (and carry stays open); horizon.
//   S5  hour-scaled stop width (trailing-60-day median of the entry's ET hour, no lookahead,
//       1m fallback) — ETH only; RTH rows keep the shipped bracket.
//   S6  resolvePending end-to-end on fixture fires + idempotent re-run + open→resolved update +
//       re-levelled fire re-resolves + chunked run (budget 0) gives identical rows.
//   S7  shadowSummary math (n, wins, net with −1 friction, shipped on the SAME rows, delta,
//       judgeable n ≥ 150, open rows / orphans / out-of-window excluded) + route query parsing.
//   S8  wiring: computeCatchup calls the hook fire-and-forget; import discipline (worker-safe).
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

type Bar = { time: number; open: number; high: number; low: number; close: number };

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-exits-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.BAXTER_ARTIFACTS_DIR = tmp;
  const se = await import("../server/shadow-exits");
  const routes = await import("../server/shadow-exits-routes");
  const { walkOutcomeCanonical } = await import("@shared/outcome-resolver");
  const { etWallToEpoch } = await import("@shared/yellowbox-core");
  const { db } = await import("../server/db");
  const client = (db as any).$client as import("better-sqlite3").Database;

  const mk = (t0: number, rows: Array<[number, number, number, number]>): Bar[] =>
    rows.map(([o, h, l, c], i) => ({ time: t0 + i * 60, open: o, high: h, low: l, close: c }));
  const flatBars = (t0: number, n: number, px: number, wig = 1): Bar[] =>
    Array.from({ length: n }, (_, i) => ({ time: t0 + i * 60, open: px, high: px + wig, low: px - wig, close: px }));
  const BIG = 4_000_000_000;

  // ── S1 shipped ≡ canonical ──
  console.log("── S1 shipped exit ≡ canonical resolver (carry, TP1-only) ──");
  {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let agree = 0, total = 0; const bad: unknown[] = [];
    for (let k = 0; k < 400; k++) {
      const t0 = 1790000000 - (1790000000 % 60);
      let px = 5000; const bars: Bar[] = [];
      for (let i = 0; i < 300; i++) {
        const o = px; const c = Math.round((px + (rnd() - 0.5) * 6) * 4) / 4;
        const h = Math.max(o, c) + Math.round(rnd() * 8) / 4, l = Math.min(o, c) - Math.round(rnd() * 8) / 4;
        bars.push({ time: t0 + i * 60, open: o, high: h, low: l, close: c }); px = c;
      }
      const isLong = rnd() < 0.5, entry = 5000;
      const tpD = 4 + Math.round(rnd() * 80) / 4, slD = 4 + Math.round(rnd() * 80) / 4;
      const entryTs = t0 + 60 * Math.floor(rnd() * 5);
      const covered = bars[bars.length - 1].time;
      const c = walkOutcomeCanonical({ bars, entryTs, entry, tp1: entry + (isLong ? tpD : -tpD), tp2: null, sl: entry - (isLong ? slD : -slD), isLong, settleTs: entryTs + 86400, barSec: 60, coveredThroughTs: covered, tp1Only: true });
      const s = se.walkShadowExit({ bars, entryTs, entry, isLong, tpDist: tpD, slDist: slD, coveredThroughTs: covered });
      total++;
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const ok = c.outcome === s.outcome && c.exitTs === s.exitTs && (c.exitPrice == null ? s.exitPrice == null : r2(c.exitPrice) === s.exitPrice)
        && r2(c.mae) === s.mae && r2(c.mfe) === s.mfe;
      if (ok) agree++; else if (bad.length < 3) bad.push({ k, c, s });
    }
    assert(agree === total, `shipped re-walk matches walkOutcomeCanonical on ${agree}/${total} random paths`, bad);
    const T = 1790000040 - (1790000040 % 60);
    const r = se.walkShadowExit({ bars: mk(T, [[100, 111, 88, 100]]), entryTs: T, entry: 100, isLong: true, tpDist: 10, slDist: 11, coveredThroughTs: BIG });
    assert(r.outcome === "loss" && r.exitPrice === 89 && r.points === -11 && r.exitReason === "sl", "stop + target in ONE bar = loss at the stop", r);
  }

  // ── S2 breakeven ──
  console.log("── S2 breakeven (be+9 TP10/SL11) ──");
  {
    const T = 1790000040 - (1790000040 % 60);
    const v = { tpDist: 10, slDist: 11, beAt: 9 };
    // bar0 reaches +9.5 AND dips below entry in the SAME bar — the moved stop must NOT act on bar0.
    let r = se.walkShadowExit({ ...v, bars: mk(T, [[100, 109.5, 99.5, 105], [104, 105, 99.75, 101]]), entryTs: T, entry: 100, isLong: true, coveredThroughTs: BIG });
    assert(r.outcome === "closed" && r.exitReason === "be" && r.exitPrice === 100 && r.points === 0 && r.exitTs === T + 120, "BE armed on bar0, acts from bar1 → scratch at entry", r);
    r = se.walkShadowExit({ ...v, bars: mk(T, [[100, 109.5, 99.5, 105], [98, 99, 97, 98]]), entryTs: T, entry: 100, isLong: true, coveredThroughTs: BIG });
    assert(r.exitReason === "be" && r.exitPrice === 98 && r.points === -2, "bar that OPENS through the moved stop fills at its open", r);
    r = se.walkShadowExit({ ...v, bars: mk(T, [[100, 108.75, 99.5, 105], [104, 105, 99.75, 101], [101, 110, 100, 109]]), entryTs: T, entry: 100, isLong: true, coveredThroughTs: BIG });
    assert(r.outcome === "win_tp1" && r.points === 10, "MFE 8.75 < 9 never arms BE → later target wins", r);
    // short mirror
    r = se.walkShadowExit({ ...v, bars: mk(T, [[100, 100.5, 91, 95], [96, 100.25, 95, 99]]), entryTs: T, entry: 100, isLong: false, coveredThroughTs: BIG });
    assert(r.exitReason === "be" && r.exitPrice === 100 && r.points === 0, "short breakeven mirror", r);
  }

  // ── S3 trail ──
  console.log("── S3 trail (SL12, once +18 trail 3 behind the best) ──");
  {
    const T = 1790000040 - (1790000040 % 60);
    const v = { tpDist: null, slDist: 12, trail: { m: 18, g: 3 } };
    let r = se.walkShadowExit({ ...v, bars: mk(T, [[100, 118, 99, 117], [117, 121, 116, 120], [120, 120, 117.5, 118]]), entryTs: T, entry: 100, isLong: true, coveredThroughTs: BIG });
    assert(r.outcome === "closed" && r.exitReason === "trail" && r.exitPrice === 118 && r.points === 18, "activation at +18, best 121 → stop 118 → exit +18 (giveback 3)", r);
    r = se.walkShadowExit({ ...v, bars: mk(T, [[100, 117.75, 99, 117], [117, 117.5, 100, 101], [101, 101, 87.5, 88]]), entryTs: T, entry: 100, isLong: true, coveredThroughTs: BIG });
    assert(r.outcome === "loss" && r.exitReason === "sl" && r.points === -12, "MFE 17.75 < 18 → no trail; full giveback to the hard stop", r);
    r = se.walkShadowExit({ ...v, bars: mk(T, [[100, 118, 99, 117], [110, 112, 109, 111]]), entryTs: T, entry: 100, isLong: true, coveredThroughTs: BIG });
    assert(r.exitReason === "trail" && r.exitPrice === 110 && r.points === 10, "gap below the trail stop fills at the open", r);
    r = se.walkShadowExit({ ...v, bars: mk(T, [[100, 118, 99, 117], [117, 117.5, 115.5, 116]]), entryTs: T, entry: 100, isLong: true, coveredThroughTs: T + 120 });
    assert(r.outcome === "open" && r.mfe === 18, "trail armed but untouched within the data → open", r);
  }

  // ── S4 time stop / Apex / horizon ──
  console.log("── S4 time stop 240 / Apex 16:55 / horizon ──");
  {
    const day = "2026-09-23"; // Wednesday, EDT
    const e0 = etWallToEpoch(day, 10, 0);
    const bars = flatBars(e0, 400, 5000, 2);
    let r = se.walkShadowExit({ bars, entryTs: e0, entry: 5000, isLong: true, tpDist: 30, slDist: 22, timeStopMin: 240, coveredThroughTs: BIG });
    assert(r.outcome === "closed" && r.exitReason === "time" && r.exitTs === e0 + 240 * 60 && r.exitPrice === 5000, "time stop: flat at the close of the bar ending entry+240 min", r);
    r = se.walkShadowExit({ bars: bars.slice(0, 200), entryTs: e0, entry: 5000, isLong: true, tpDist: 30, slDist: 22, timeStopMin: 240, coveredThroughTs: e0 + 199 * 60 });
    assert(r.outcome === "open", "time stop not yet reached at the data horizon → open", r);
    r = se.walkShadowExit({ bars: mk(e0, [[5000, 5002, 4999, 5001], [5001, 5030, 5000, 5029]]), entryTs: e0, entry: 5000, isLong: true, tpDist: 30, slDist: 22, timeStopMin: 240, coveredThroughTs: BIG });
    assert(r.outcome === "win_tp1" && r.points === 30, "target before the time stop wins", r);

    const cut = se.apexCutOf(etWallToEpoch(day, 16, 0));
    assert(cut === etWallToEpoch(day, 16, 55), "apexCutOf(16:00 ET) = 16:55 ET same day");
    assert(se.apexCutOf(etWallToEpoch("2026-09-22", 20, 0)) === etWallToEpoch(day, 16, 55), "an 20:00 ET entry flats at 16:55 of the NEXT (Globex) day");
    const e1 = etWallToEpoch(day, 16, 0);
    const b1 = flatBars(e1, 60, 5000, 1).map((b, i) => (i === 54 ? { ...b, close: 5003 } : b)); // 16:54 bar closes 5003
    r = se.walkShadowExit({ bars: b1, entryTs: e1, entry: 5000, isLong: true, tpDist: 12, slDist: 25, apexCutTs: cut, coveredThroughTs: BIG });
    assert(r.outcome === "closed" && r.exitReason === "apex_flat" && r.exitTs === cut && r.exitPrice === 5003 && r.points === 3, "Apex: flat at the 16:54 bar's close, stamped 16:55", r);
    r = se.walkShadowExit({ bars: b1, entryTs: e1, entry: 5000, isLong: true, tpDist: 12, slDist: 25, apexCutTs: null, coveredThroughTs: BIG });
    assert(r.outcome === "open", "carry: the same path stays open", r);
    r = se.walkShadowExit({ bars: b1, entryTs: e1, entry: 5000, isLong: true, tpDist: 30, slDist: 22, timeStopMin: 240, apexCutTs: cut, coveredThroughTs: BIG });
    assert(r.exitReason === "apex_flat" && r.exitTs === cut, "Apex cut before the 240-min time stop wins", r);
    r = se.walkShadowExit({ bars: flatBars(e0, 30, 5000, 1), entryTs: e0, entry: 5000, isLong: true, tpDist: 12, slDist: 25, coveredThroughTs: BIG, maxHoldSec: 600 });
    assert(r.outcome === "open" && r.exitReason === "horizon", "max hold reached with data beyond → final open (horizon)", r);
  }

  // ── fixtures for S5/S6 ──
  const insBar = client.prepare(`INSERT OR REPLACE INTO cached_candles (symbol, resolution, timestamp, open, high, low, close, volume) VALUES ('MES', ?, ?, ?, ?, ?, ?, 0)`);
  const insSig = client.prepare(`INSERT INTO signal_history (symbol, interval, timestamp, direction, risk_level, signal_type, entry, tp1, tp2, sl, outcome, source) VALUES ('MES', ?, ?, ?, 'safe', 'fact-engine', ?, ?, NULL, ?, 'open', 'live')`);
  const addBars = (bars: Bar[], res = "1") => client.transaction(() => { for (const b of bars) insBar.run(res, b.time, b.open, b.high, b.low, b.close); })();

  const DAY = "2026-09-23";
  // 60m bars: hour 03 ET ranges alternate 6 / 8 over the previous 30 days (median 7); hour 04 ET
  // ranges 50 (must be ignored for a 03:xx entry); a huge 03:00 bar ON the fire day (lookahead trap).
  {
    const bars60: Bar[] = [];
    for (let d = 1; d <= 30; d++) {
      const t3 = etWallToEpoch(DAY, 3, 0) - d * 86400, t4 = etWallToEpoch(DAY, 4, 0) - d * 86400;
      const r = d % 2 ? 6 : 8;
      bars60.push({ time: t3, open: 5000, high: 5000 + r, low: 5000, close: 5000 });
      bars60.push({ time: t4, open: 5000, high: 5050, low: 5000, close: 5000 });
    }
    bars60.push({ time: etWallToEpoch(DAY, 3, 0), open: 5000, high: 5200, low: 5000, close: 5000 });
    addBars(bars60, "60");
  }

  // ── S5 hour-scaled stop ──
  console.log("── S5 hour-scaled stop width ──");
  {
    const hm = se.hourMedianRange(etWallToEpoch(DAY, 3, 1));
    assert(hm.median === 7 && hm.samples === 30 && hm.hour === 3, "median 60-min range of ET hour 03 over the trailing window = 7 (other hours + the fire hour itself excluded)", hm);
    assert(se.hourScaledStopDist(7, 1.5) === 10.5 && se.hourScaledStopDist(7, 2) === 14, "1.5× → 10.5, 2× → 14");
    assert(se.hourScaledStopDist(7.1, 1.5) === 10.75, "tick-rounded (10.65 → 10.75)");
    const none = se.hourMedianRange(etWallToEpoch(DAY, 22, 5));
    assert(none.median === null, "an hour with < 10 samples (no 60m or 1m bars) → null (variant recorded as no-data)", none);
    // 1m fallback: build 12 days of hour-23 ET from 1m bars only (range 5 each)
    const fb: Bar[] = [];
    for (let d = 1; d <= 12; d++) {
      const h0 = etWallToEpoch("2026-08-20", 23, 0) - d * 86400;
      for (let m = 0; m < 60; m++) fb.push({ time: h0 + m * 60, open: 5000, high: m === 10 ? 5005 : 5001, low: 5000, close: 5000 });
    }
    addBars(fb, "1");
    const fbm = se.hourMedianRange(etWallToEpoch("2026-08-20", 23, 30));
    assert(fbm.median === 5 && fbm.samples === 12, "60m bars missing → hours rebuilt from 1m bars (median 5)", fbm);
    client.exec(`DELETE FROM cached_candles WHERE resolution='1'`);
  }

  // ── S6 resolvePending end-to-end ──
  console.log("── S6 resolvePending end-to-end + idempotence ──");
  const T_ETH = etWallToEpoch(DAY, 3, 0);      // 1m Long fire bar 03:00 ET → entry 03:01
  const E_ETH = T_ETH + 60;
  const T_RTH = etWallToEpoch(DAY, 10, 0);     // 5m Short fire bar 10:00 ET → entry 10:05
  const E_RTH = T_RTH + 300;
  {
    const rows: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 5; i++) rows.push([5000, 5001, 4995, 4996]);
    rows.push([4996, 4997, 4988.5, 4990]);                // m5: 1.5× (4989.5) + be-variant SL 11 (4989) hit
    for (let i = 0; i < 5; i++) rows.push([4990, 5005, 4990, 5004]);
    rows.push([5004, 5012, 5003, 5010]);                  // m11: shipped TP 5012 (+12)
    rows.push([5010, 5020, 5009, 5019]);                  // m12: trail arms (MFE 20 → stop 5017)
    rows.push([5019, 5019.5, 5016, 5018]);                // m13: trail exit 5017 (+17)
    while (rows.length < 300) rows.push([5018, 5019, 5017, 5018]); // tp30 variants → 240-min time stop at 5018
    addBars(mk(E_ETH, rows));
    insSig.run("1m", T_ETH, "Long", 5000, 5012, 4975);
    const r2: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 20; i++) r2.push([5100, 5103, 5097, 5099]);
    r2.push([5099, 5101, 5089, 5090]);                    // shipped TP 5090 (Short +10)
    while (r2.length < 300) r2.push(r2.length === 250
      ? [5090, 5113, 5089, 5110]                          // after the 240-min stops: the un-armed trail's SL 5112 (−12)
      : [5090, 5091, 5089, 5090]);
    addBars(mk(E_RTH, r2));
    insSig.run("5m", T_RTH, "Short", 5100, 5090, 5120);
  }
  const NOW = E_RTH + 400 * 60; // data horizon = last 1m bar (minus the forming one)
  const snap = () => JSON.stringify(client.prepare(`SELECT * FROM signal_shadow_exits ORDER BY interval, timestamp, variant, mode`).all());
  const get = (iv: string, ts: number, variant: string, mode: string) => client.prepare(
    `SELECT * FROM signal_shadow_exits WHERE interval=? AND timestamp=? AND variant=? AND mode=?`).get(iv, ts, variant, mode) as any;
  {
    const st = await se.resolvePending(NOW);
    const nRows = (client.prepare(`SELECT COUNT(*) n FROM signal_shadow_exits`).get() as any).n;
    assert(st.firesWalked === 2 && nRows === 2 * se.SHADOW_VARIANTS.length * 2 && st.rowsWritten === nRows, `2 fires × ${se.SHADOW_VARIANTS.length} variants × 2 modes recorded`, { st, nRows });
    const exp: Record<string, [string, string, number]> = {
      "shipped": ["win_tp1", "tp", 12],
      "mc-1m-be9-tp10-sl11": ["loss", "sl", -11],
      "mc-5m-trail-m18-g3-sl12": ["closed", "trail", 17],
      "mc-15m-time240-tp30-sl22": ["closed", "time", 18],
      "mc-60m-time240-tp30-sl18": ["closed", "time", 18],
      "eth-hourstop-1.5x": ["loss", "sl", -10.5],
      "eth-hourstop-2x": ["win_tp1", "tp", 12],
    };
    for (const [vid, [o, why, pts]] of Object.entries(exp)) for (const mode of ["carry", "apex1655"]) {
      const r = get("1m", T_ETH, vid, mode);
      assert(r && r.outcome === o && r.exit_reason === why && r.points === pts && r.session === "ETH", `ETH 1m Long ${vid} [${mode}] → ${o} ${pts >= 0 ? "+" : ""}${pts}`, r);
    }
    const hs = get("1m", T_ETH, "eth-hourstop-2x", "carry");
    assert(hs.sl_price === 4986 && hs.tp_price === 5012, "2× hour stop: SL 5000 − 14 = 4986, shipped TP kept", hs);
    const t240 = get("1m", T_ETH, "mc-15m-time240-tp30-sl22", "carry");
    assert(t240.exit_ts === E_ETH + 240 * 60, "time-stop row stamped entry + 240 min", t240);
    for (const vid of ["eth-hourstop-1.5x", "eth-hourstop-2x"]) {
      const a = get("5m", T_RTH, vid, "carry"), b = get("5m", T_RTH, "shipped", "carry");
      assert(a.session === "RTH" && a.sl_price === 5120 && a.outcome === b.outcome && a.points === b.points && b.points === 10, `RTH fire: ${vid} = shipped bracket as-is (+10)`, { a, b });
    }
    const before = snap();
    const st2 = await se.resolvePending(NOW + 3600);
    assert(st2.candidates === 0 && st2.rowsWritten === 0 && snap() === before, "idempotent: a re-run finds nothing pending and changes no byte", st2);

    // open → resolved: a 15m fire whose data ends before any touch
    const T_OPEN = etWallToEpoch("2026-09-24", 11, 0), E_OPEN = T_OPEN + 900;
    insSig.run("15m", T_OPEN, "Long", 5200, 5240, 5100);
    addBars(flatBars(E_OPEN, 30, 5200, 1));
    const NOW2 = E_OPEN + 30 * 60;
    await se.resolvePending(NOW2);
    const o1 = get("15m", T_OPEN, "shipped", "carry");
    assert(o1 && o1.outcome === "open" && o1.exit_reason === null, "untouched fire recorded open", o1);
    const st3 = await se.resolvePending(NOW2);
    assert(st3.candidates === 1 && st3.rowsWritten === 0, "re-run on an unchanged open fire walks it but writes nothing", st3);
    addBars(mk(E_OPEN + 30 * 60, [[5200, 5241, 5199, 5240], [5240, 5241, 5239, 5240]]));
    const st4 = await se.resolvePending(NOW2 + 3 * 60);
    const o2 = get("15m", T_OPEN, "shipped", "carry");
    assert(o2.outcome === "win_tp1" && o2.points === 40 && st4.rowsWritten > 0, "open row resolves once the bars arrive", { o2, st4 });
    const ethBefore = JSON.stringify(client.prepare(`SELECT * FROM signal_shadow_exits WHERE interval='1m'`).all());
    assert(ethBefore.length > 0 && JSON.stringify(client.prepare(`SELECT * FROM signal_shadow_exits WHERE interval='1m'`).all()) === ethBefore, "final rows of other fires untouched by later passes");

    // re-levelled fire (regen rewrote its bracket) → re-resolved at the new levels
    client.prepare(`UPDATE signal_history SET tp1=5008 WHERE interval='1m' AND timestamp=?`).run(T_ETH);
    await se.resolvePending(NOW2 + 3 * 60);
    const rl = get("1m", T_ETH, "shipped", "carry");
    assert(rl.ref_tp1 === 5008 && rl.tp_price === 5008 && rl.points === 8, "re-levelled fire re-resolves against its current shipped levels", rl);

    // chunked run (budget 0 → a yield between every fire) produces the same rows
    const all = snap();
    client.exec(`DELETE FROM signal_shadow_exits`);
    const st5 = await se.resolvePending(NOW2 + 3 * 60, { budgetMs: 0 });
    const strip = (s: string) => JSON.stringify(JSON.parse(s).map((r: any) => ({ ...r, id: 0, updated_at: "" })));
    assert(st5.chunks >= 2 && strip(snap()) === strip(all), "chunked (yielding) run == one-shot run", st5);
    // re-entrancy: a second concurrent call is refused, not run twice
    client.exec(`DELETE FROM signal_shadow_exits WHERE interval='15m'`);
    const [a1, a2] = await Promise.all([se.resolvePending(NOW2 + 3 * 60, { budgetMs: 0 }), se.resolvePending(NOW2 + 3 * 60)]);
    assert(a1.ran !== a2.ran, "concurrent second call is skipped (already running)", { a1, a2 });
    // limit honours newest-first
    client.exec(`DELETE FROM signal_shadow_exits`);
    const st6 = await se.resolvePending(NOW2 + 3 * 60, { limit: 1 });
    const ivs = client.prepare(`SELECT DISTINCT interval FROM signal_shadow_exits`).all() as any[];
    assert(st6.candidates === 1 && ivs.length === 1 && ivs[0].interval === "15m", "per-pass bound picks the NEWEST pending fire first", { st6, ivs });
  }

  // ── S7 summary math ──
  console.log("── S7 summary math ──");
  {
    client.exec(`DELETE FROM signal_shadow_exits; DELETE FROM signal_history;`);
    const insX = client.prepare(`INSERT INTO signal_shadow_exits (symbol, interval, timestamp, direction, variant, mode, session, ref_entry, ref_tp1, ref_sl, outcome, exit_reason, points)
      VALUES ('MES', ?, ?, 'Long', ?, ?, 'ETH', 100, 110, 90, ?, ?, ?)`);
    const NOWS = 1790800000;
    client.transaction(() => {
      for (let i = 0; i < 150; i++) {
        const ts = NOWS - 86400 - i * 900;
        insSig.run("15m", ts, "Long", 100, 110, 90);
        insX.run("15m", ts, "shipped", "carry", "win_tp1", "tp", 3);
        insX.run("15m", ts, "mc-15m-time240-tp30-sl22", "carry", i < 100 ? "win_tp1" : "loss", i < 100 ? "tp" : "sl", i < 100 ? 5 : -10);
      }
      for (let i = 0; i < 10; i++) {
        const ts = NOWS - 86400 - i * 3600;
        insSig.run("60m", ts, "Long", 100, 110, 90);
        insX.run("60m", ts, "shipped", "apex1655", "loss", "sl", -10);
        insX.run("60m", ts, "mc-60m-time240-tp30-sl18", "apex1655", "closed", "time", i < 4 ? 2 : 0);
      }
      // open variant row → excluded from n, counted in open
      const tsO = NOWS - 3600; insSig.run("60m", tsO, "Long", 100, 110, 90);
      insX.run("60m", tsO, "shipped", "apex1655", "loss", "sl", -10);
      insX.run("60m", tsO, "mc-60m-time240-tp30-sl18", "apex1655", "open", null, null);
      // orphan: signal_history levels differ from the shadow row's refs → ignored
      const tsR = NOWS - 7200; insSig.run("60m", tsR, "Long", 100, 111, 90);
      insX.run("60m", tsR, "shipped", "apex1655", "win_tp1", "tp", 50);
      insX.run("60m", tsR, "mc-60m-time240-tp30-sl18", "apex1655", "win_tp1", "tp", 50);
      // out of window (100 days old)
      const tsW = NOWS - 100 * 86400; insSig.run("60m", tsW, "Long", 100, 110, 90);
      insX.run("60m", tsW, "shipped", "apex1655", "win_tp1", "tp", 50);
      insX.run("60m", tsW, "mc-60m-time240-tp30-sl18", "apex1655", "win_tp1", "tp", 50);
    })();
    const s = se.shadowSummary({ nowSec: NOWS, days: 90 });
    const row = (iv: string, v: string, m: string) => s.rows.find(r => r.interval === iv && r.variant === v && r.mode === m) as any;
    const a = row("15m", "mc-15m-time240-tp30-sl22", "carry");
    assert(a && a.n === 150 && a.wins === 100 && a.winPct === 66.67 && a.grossPts === 0 && a.netPts === -150 && a.netPerTrade === -1, "15m variant: n 150, 100 wins (66.67%), gross 0 → net −150 (−1/trade)", a);
    assert(a.shipped.netPts === 300 && a.shipped.wins === 150 && a.deltaNetPts === -450 && a.judgeable === true, "15m shipped on the same rows: net +300, delta −450, judgeable at n=150", a);
    const b = row("60m", "mc-60m-time240-tp30-sl18", "apex1655");
    assert(b && b.n === 10 && b.wins === 4 && b.grossPts === 8 && b.netPts === -2 && b.shipped.netPts === -110 && b.deltaNetPts === 108 && b.open === 1 && b.judgeable === false,
      "60m: open/orphan/out-of-window rows excluded; scratches (0 pts) are not wins; open counted; n=10 not judgeable", b);
    const s2 = se.shadowSummary({ nowSec: NOWS, days: 90, session: "RTH" });
    assert(s2.rows.length === 0, "session filter (RTH) excludes ETH rows");
    const s3 = se.shadowSummary({ nowSec: NOWS, days: 120 });
    const shipN = (x: typeof s) => (x.rows.find(r => r.interval === "60m" && r.variant === "shipped" && r.mode === "apex1655") as any)?.n;
    assert(shipN(s) === 11 && shipN(s3) === 12, "baseline row counts its own closed rows (10 + the fire whose variant is open = 11); days=120 adds the 100-day-old fire", { a: shipN(s), b: shipN(s3) });
    const p = routes.parseSummaryQuery({ days: "30", session: "ETH", from: "2026-09-25" }, NOWS) as any;
    assert(p.days === 30 && p.session === "ETH" && p.fromTs === Date.UTC(2026, 8, 25) / 1000, "route query parse (days/session/from)", p);
    assert("error" in (routes.parseSummaryQuery({ days: "-3" }, NOWS) as any) && "error" in (routes.parseSummaryQuery({ session: "x" }, NOWS) as any), "route rejects bad days/session");
    assert((routes.parseSummaryQuery({}, NOWS) as any).days === 90, "route default days=90");
  }

  // ── S8 wiring ──
  console.log("── S8 wiring + import discipline ──");
  {
    const cu = fs.readFileSync(path.join(ROOT, "server/catchup.ts"), "utf8");
    const fn = cu.slice(cu.indexOf("export async function computeCatchup"), cu.indexOf("let computeDelegate"));
    assert(/\n\s*void resolvePendingShadowExits\(nowSec\);/.test(fn), "computeCatchup fires the shadow hook (fire-and-forget, not awaited)");
    const ctxFn = cu.slice(cu.indexOf("export async function buildLiveEngineContext"), cu.indexOf("export function engineInputForInterval"));
    assert(!/ShadowExits/.test(ctxFn), "the hook is NOT in buildLiveEngineContext (the per-bar live/order pass)");
    const src = fs.readFileSync(path.join(ROOT, "server/shadow-exits.ts"), "utf8");
    const imps = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map(m => m[1]);
    assert(imps.every(m => m === "./db" || m.startsWith("@shared/")), "shadow-exits.ts imports only ./db + @shared/* (worker-safe)", imps);
    assert(!/signal_history\s+SET|UPDATE\s+signal_history|INSERT\s+INTO\s+signal_history|DELETE\s+FROM\s+signal_history/i.test(src), "shadow-exits.ts never writes signal_history");
    const idx = fs.readFileSync(path.join(ROOT, "server/index.ts"), "utf8");
    assert(/registerShadowExitRoutes\(app\)/.test(idx), "index.ts registers the summary route");
  }

  try { (db as any).$client.close(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
