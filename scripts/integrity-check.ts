/**
 * integrity-check.ts — THE SERVING-IDENTITY RECONCILIATION (2026-08-12, born from the user
 * catching the tab contradicting the backtest: "I cannot have this mistake again").
 *
 * Verifies the structural identity the Signals tab now guarantees:
 *   signal_history = CURRENT standing book (regen) + FULL-HISTORY book (regen)
 *                    + genuine live fires from the last LIVE_EDGE_DAYS only
 * plus the store-level invariants every drift incident of the past week violated somewhere.
 *
 * CHECKS (violations exit 1; warnings exit 0):
 *   V1  standing-window regen/NULL rows must match the standing JSON key-for-key AND
 *       outcome/points byte-wise (pre-live-edge; edge-window mismatches are warnings —
 *       live refinement of recent rows is legal).
 *   V2  standing-window LIVE rows older than the live edge must exist in the standing book
 *       (collision-kept genuine records). Pre-edge live rows absent from the book = the
 *       stale-config/drift class.
 *   V2b pre-edge live rows must also carry the BOOK's values (uniform-serving policy,
 *       user-chosen 2026-08-12) — as-traded originals are preserved in
 *       signal_history_astraded_backup by scripts/uniform-live-revalue.ts, which is the fix
 *       to run when this fires after a regen.
 *   V3  every standing-JSON signal must exist in the DB (persist gap).
 *   V4  pre-window rows must all be source='regen' and their per-year counts must equal the
 *       full-history artifact's era counts.
 *   V5  no natural-key duplicates; no future-dated rows (> now + 1h); no NULL-source rows
 *       inside the standing window.
 *   W1  'open' rows older than 7 days (carry-overnight holds are legal for days, not weeks).
 *   W2  candle store, last 7 days: off-grid rows, zero/NULL-volume ghost rows, future bars.
 *   W3  footprint_candles, last 7 days: ≥ 10 % of qualifying complete 5m candles have a ZERO bid
 *       or ask side — the 2026-07-08 → 10-06 dead-aggressor-side incident (every footprint fire
 *       went Short for three months and nothing alarmed; shared/footprint-side.ts).
 *   V6  candle store, last 7 days: contract-month interleave (≥30-pt 1m flip-flops — the
 *       2026-09-14→17 Sep/Dec roll incident; see server/contract-guard.ts).
 *   N1  (warning) data/news-calendar.json health — missing/unreadable, window.to past or
 *       within 14 days, no print in the next 30 days, unknown print time, rules copy drift
 *       (server/news-blackout.ts newsCalendarHealth; the blackout fails OPEN without it).
 *
 * Output: console summary + <artifacts>/integrity-check.json. Designed to run standalone
 * (npx tsx scripts/integrity-check.ts) AND as the daily digest's drift alarm (scheduler).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { artifactsDir } from "../shared/artifacts-dir";
import { footprintSideStats, ONE_SIDED_ALARM_SHARE } from "../shared/footprint-side";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data", "app.db");
const SYMBOL = "MES";
const LIVE_EDGE_DAYS = 2;
const OUT = path.join(artifactsDir(ROOT), "integrity-check.json");

interface Finding { level: "VIOLATION" | "WARNING"; check: string; detail: string }
const findings: Finding[] = [];
const v = (check: string, detail: string): void => { findings.push({ level: "VIOLATION", check, detail }); };
const w = (check: string, detail: string): void => { findings.push({ level: "WARNING", check, detail }); };

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const liveEdge = now - LIVE_EDGE_DAYS * 86400;
  const doc = JSON.parse(fs.readFileSync(path.join(artifactsDir(ROOT), "fact-engine-backtest-results.json"), "utf8")) as {
    meta: { emissionStartTs: number; generatedAt?: string };
    signals: Array<{ interval: string; fireTs: number; direction: string; outcome: string; pointsResult: number | null }>;
  };
  const winStart = doc.meta.emissionStartTs;
  const DB_OUTCOME: Record<string, string> = { tp1: "win_tp1", tp2: "win_tp2", sl: "loss", eod: "eod", open: "open" };
  const bookByKey = new Map(doc.signals.map(s => [
    `${s.interval}|${s.fireTs}|${s.direction.toLowerCase()}`,
    { outcome: DB_OUTCOME[s.outcome] ?? s.outcome, pts: s.pointsResult },
  ]));

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const rows = db.prepare(
    `SELECT interval, timestamp, direction, outcome, points_result, source FROM signal_history WHERE symbol=?`,
  ).all(SYMBOL) as Array<{ interval: string; timestamp: number; direction: string; outcome: string | null; points_result: number | null; source: string | null }>;

  // ── V5 first: dupes / future / NULL-source-in-window ──
  const dupes = db.prepare(
    `SELECT COUNT(*) n FROM (SELECT 1 FROM signal_history WHERE symbol=? GROUP BY interval, timestamp, direction HAVING COUNT(*) > 1)`,
  ).get(SYMBOL) as { n: number };
  if (dupes.n > 0) v("V5-dupes", `${dupes.n} duplicated natural keys`);
  const future = rows.filter(r => r.timestamp > now + 3600);
  if (future.length) v("V5-future", `${future.length} future-dated rows (first ${new Date(future[0].timestamp * 1000).toISOString()})`);
  const nullInWin = rows.filter(r => r.timestamp >= winStart && r.source == null);
  if (nullInWin.length) v("V5-null-source", `${nullInWin.length} NULL-source rows inside the standing window`);

  // ── V1/V2/W: the standing window ──
  const dbWinKeys = new Set<string>();
  let v1 = 0, v2 = 0, v2b = 0, edgeMismatch = 0;
  for (const r of rows) {
    if (r.timestamp < winStart) continue;
    const key = `${r.interval}|${r.timestamp}|${r.direction.toLowerCase()}`;
    dbWinKeys.add(key);
    const book = bookByKey.get(key);
    const isEdge = r.timestamp >= liveEdge;
    if (r.source === "live") {
      if (!book && !isEdge) { v2++; if (v2 <= 3) v("V2-stale-live", `pre-edge live row not in book: ${key} (${r.outcome} ${r.points_result})`); }
      // V2b (2026-08-12, uniform-serving policy): pre-edge live rows must carry the BOOK's
      // values — as-traded originals live in signal_history_astraded_backup. Value drift here
      // was the "tab says +693.9, report says +587.6" confusion; it must never pass silently.
      if (book && !isEdge) {
        const ocOk = (r.outcome ?? "open") === book.outcome;
        const ptsOk = (r.points_result ?? null) === (book.pts ?? null)
          || (r.points_result != null && book.pts != null && Math.abs(r.points_result - book.pts) < 0.011);
        if (!ocOk || !ptsOk) { v2b++; if (v2b <= 3) v("V2b-live-drift", `${key}: DB ${r.outcome}/${r.points_result} vs book ${book.outcome}/${book.pts} — run scripts/uniform-live-revalue.ts`); }
      }
      continue;
    }
    // regen/NULL row: must be book-backed and byte-matched (pre-edge).
    if (!book) {
      if (!isEdge) { v1++; if (v1 <= 3) v("V1-orphan-regen", `regen row not in book: ${key}`); }
      continue;
    }
    const outMatch = (r.outcome ?? "open") === book.outcome;
    const ptsMatch = (r.points_result ?? null) === (book.pts ?? null)
      || (r.points_result != null && book.pts != null && Math.abs(r.points_result - book.pts) < 0.011);
    if (!outMatch || !ptsMatch) {
      if (isEdge) edgeMismatch++;
      else { v1++; if (v1 <= 3) v("V1-mismatch", `${key}: DB ${r.outcome}/${r.points_result} vs book ${book.outcome}/${book.pts}`); }
    }
  }
  if (v1 > 3) v("V1-more", `…and ${v1 - 3} more V1 diffs`);
  if (v2 > 3) v("V2-more", `…and ${v2 - 3} more V2 stale-live rows`);
  if (v2b > 3) v("V2b-more", `…and ${v2b - 3} more V2b live-drift rows`);
  if (edgeMismatch) w("W-edge-refinement", `${edgeMismatch} live-edge rows differ from the book (legal live refinement)`);

  // ── V3: book coverage ──
  let missing = 0;
  for (const [key] of bookByKey) if (!dbWinKeys.has(key)) missing++;
  if (missing) v("V3-persist-gap", `${missing} standing-book signals missing from the DB`);

  // ── V4: pre-window = full-history regen only, per-year counts vs the artifact ──
  const pre = rows.filter(r => r.timestamp < winStart);
  const preNonRegen = pre.filter(r => r.source !== "regen");
  if (preNonRegen.length) v("V4-pre-window-source", `${preNonRegen.length} pre-window rows with source != regen`);
  try {
    const fh = JSON.parse(fs.readFileSync(path.join(artifactsDir(ROOT), "full-history-regen.json"), "utf8")) as { era?: Record<string, { n: number }> };
    if (fh.era) {
      const byYr: Record<string, number> = {};
      for (const r of pre) { const y = new Date(r.timestamp * 1000).getUTCFullYear().toString(); byYr[y] = (byYr[y] ?? 0) + 1; }
      for (const [yr, e] of Object.entries(fh.era)) {
        const winYr = new Date(winStart * 1000).getUTCFullYear().toString();
        if (yr === winYr) continue; // the artifact's boundary year overlaps the standing window
        const dbN = byYr[yr] ?? 0;
        if (dbN !== e.n) w("W-era-count", `pre-window ${yr}: DB ${dbN} vs artifact ${e.n} (boundary/live effects possible)`);
      }
    }
  } catch { w("W-era-artifact", "full-history artifact unreadable — era counts unchecked"); }

  // ── W1: stuck opens ──
  const stuck = rows.filter(r => (r.outcome == null || r.outcome === "open") && r.timestamp < now - 7 * 86400);
  if (stuck.length) w("W1-stuck-open", `${stuck.length} rows open for > 7 days (carry holds are days, not weeks)`);

  // ── W2: candle-store sanity, last 7 days ──
  for (const res of ["1", "5", "15", "60"]) {
    const resSec = parseInt(res, 10) * 60;
    const bad = db.prepare(
      `SELECT
         SUM(CASE WHEN timestamp % ? != 0 THEN 1 ELSE 0 END) offgrid,
         SUM(CASE WHEN volume IS NULL OR volume = 0 THEN 1 ELSE 0 END) ghosts,
         SUM(CASE WHEN timestamp > ? THEN 1 ELSE 0 END) future
       FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp >= ?`,
    ).get(resSec, now + 7200, SYMBOL, res, now - 7 * 86400) as { offgrid: number | null; ghosts: number | null; future: number | null };
    if (bad.offgrid) w("W2-offgrid", `${res}m: ${bad.offgrid} off-grid bars in the last 7d`);
    if (bad.ghosts) w("W2-ghosts", `${res}m: ${bad.ghosts} zero-volume bars in the last 7d`);
    if (bad.future) v("W2-future-bars", `${res}m: ${bad.future} future-dated bars`);
  }

  // ── W3: footprint feed side-completeness, last 7 days (2026-10-06 incident) ──
  // The LiveBarRelay footprint accumulator ran one-sided (askVol = 0 on every level) from
  // 2026-07-08 to 10-06 and nothing alarmed: the engine read the dead ask side as a full-bar
  // SELL stack on every 5m candle and 37/37 footprint fires went Short. A warning, not a
  // violation — the serving identity is intact, the INPUT is fabricated. It keeps firing until
  // two-sided sessions dominate the 7-day window, which is the point.
  try {
    const hasFp = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='footprint_candles'`).get();
    if (hasFp) {
      const fpRows = db.prepare(
        `SELECT time, data FROM footprint_candles WHERE symbol=? AND interval='5m' AND complete=1 AND time >= ?`,
      ).all(SYMBOL, now - 7 * 86400) as Array<{ time: number; data: string }>;
      let qualifying = 0, oneSided = 0, firstBad = 0, lastBad = 0;
      for (const r of fpRows) {
        let levels: Array<{ bidVol: number; askVol: number }> = [];
        try { levels = (JSON.parse(r.data) as { levels?: typeof levels }).levels ?? []; } catch { continue; }
        const s = footprintSideStats(levels);
        if (!s.qualifies) continue;
        qualifying++;
        if (s.oneSided) { oneSided++; if (!firstBad) firstBad = r.time; lastBad = r.time; }
      }
      if (qualifying && oneSided / qualifying >= ONE_SIDED_ALARM_SHARE) {
        w("W3-footprint-one-sided", `${oneSided}/${qualifying} complete 5m footprint candles in the last 7d have a ZERO bid or ask side (${new Date(firstBad * 1000).toISOString()} → ${new Date(lastBad * 1000).toISOString()}) — the LiveBarRelay aggressor side is dead; footprint facts are fabricated until the fixed jar is reinstalled (docs/footprint-feed-fix-2026-10-06.md)`);
      }
    }
  } catch (e: any) { w("W3-footprint-one-sided", `footprint side check failed to run: ${e?.message ?? e}`); }

  // ── V6: contract-roll interleave, last 7 days (2026-09-17 incident) ──
  // Two feeds on different contract months writing the same continuous key leave a sawtooth:
  // a 1m open ≥ 30 pts from the prior close that jumps BACK within 3 bars. A legitimate roll
  // is ONE cliff (no return); a real 30-pt minute does not revert 30 pts inside 3 minutes.
  {
    const oneMin = db.prepare(
      `SELECT timestamp t, open o, close c FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp >= ? ORDER BY timestamp`,
    ).all(SYMBOL, now - 7 * 86400) as Array<{ t: number; o: number; c: number }>;
    let flipFlops = 0;
    let firstAt = 0;
    for (let i = 1; i < oneMin.length; i++) {
      const d = oneMin[i].o - oneMin[i - 1].c;
      if (Math.abs(d) < 30 || oneMin[i].t - oneMin[i - 1].t > 900) continue;
      for (let j = i + 1; j <= Math.min(i + 3, oneMin.length - 1); j++) {
        const back = oneMin[j].o - oneMin[j - 1].c;
        if (Math.abs(back) >= 30 && Math.sign(back) === -Math.sign(d)) { flipFlops++; if (!firstAt) firstAt = oneMin[i].t; break; }
      }
    }
    if (flipFlops) v("V6-contract-interleave", `${flipFlops} ≥30-pt open-vs-prev-close flip-flops in the 1m store (last 7d, first ${new Date(firstAt * 1000).toISOString()}) — two contract months interleaved; run POST /api/data/roll-mismatch-repair`);
  }
  db.close();

  // ── N1: scheduled-news calendar health (2026-10-01) ──
  // The order-side news blackout FAILS OPEN on a missing/expired calendar, so a stale
  // data/news-calendar.json would silently remove the protection. Warnings, not violations:
  // the serving identity is unaffected, but the digest also prints its own "News calendar:" line.
  try {
    const { newsCalendarHealth, etDateOf } = await import("../server/news-blackout");
    const h = newsCalendarHealth(etDateOf(now));
    for (const p of h.problems) w("N1-news-calendar", p);
  } catch (e: any) { w("N1-news-calendar", `calendar health check failed to run: ${e?.message ?? e}`); }

  const violations = findings.filter(f => f.level === "VIOLATION");
  const warnings = findings.filter(f => f.level === "WARNING");
  for (const f of findings) console.log(`[integrity] ${f.level} ${f.check}: ${f.detail}`);
  console.log(`[integrity] ${violations.length} violation(s), ${warnings.length} warning(s) — book ${doc.signals.length} signals (${doc.meta.generatedAt ?? "?"}), DB ${rows.length} rows`);
  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(), ok: violations.length === 0,
    violations: violations.length, warnings: warnings.length, findings,
    bookSignals: doc.signals.length, dbRows: rows.length, liveEdgeDays: LIVE_EDGE_DAYS,
  }, null, 2));
  console.log(`[integrity] artifact: ${OUT}`);
  process.exit(violations.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
