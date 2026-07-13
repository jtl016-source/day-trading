/**
 * ONE-TIME full rebuild of MES 5m/15m/60m from the 1m base (2026-07-13, user-directed).
 *
 * Order is load-bearing:
 *   0. BACKUP (better-sqlite3 online .backup()) → scratchpad → integrity_check → copy to data/.
 *      ABORTS before any write if the backup is not integrity-ok.
 *   1. DETECT phantom buckets (15m/60m native vs 1m-derived, maxDev > 0.25pt) BEFORE the rebuild
 *      overwrites native — writes their 1m reconcile ranges to scratchpad JSON for the heal step.
 *   2. REBUILD: deriveRange over the full 1m coverage in 30-day chunks (upsert derived rows;
 *      buckets with no 1m are skipped so native 1m-gap rows stay put).
 *   3. sync_state.earliest_ts for 5/15/60 := 1m earliest (so routes.mwCoverageTs bypasses the
 *      heavy heuristic filters for the derived rows back to 2019).
 *   4. integrity_check + per-resolution before/after summary.
 *
 * Run with the dev server STOPPED (single writer):  npx tsx scripts/rebuild-derived-1m.ts
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { db } from "../server/db";
import { deriveRange } from "../server/derive-bars";

const SYMBOL = "MES";
const SCRATCH = "C:/Users/Jackson/AppData/Local/Temp/claude/C--Users-Jackson-OneDrive-day-trading-iphone/72b4f6f0-9bc5-49f3-99ef-01e6b56a684d/scratchpad";
const ROOT = process.cwd(); // run from project root (same cwd db.ts uses to resolve data/app.db)
const BACKUP_NAME = "app.db.backup-pre-1m-derive-2026-07-13";
const PHANTOM_JSON = path.join(SCRATCH, "phantom-1m-ranges.json");
const DERIVED = [ { res: "5", sec: 300 }, { res: "15", sec: 900 }, { res: "60", sec: 3600 } ];
const iso = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString() : "null");

function snapshot(): Record<string, { n: number; mn: number | null; mx: number | null }> {
  const out: Record<string, any> = {};
  for (const res of ["1", "5", "15", "60"]) {
    const r = db.$client.prepare(
      `SELECT COUNT(*) n, MIN(timestamp) mn, MAX(timestamp) mx FROM cached_candles WHERE symbol=? AND resolution=?`,
    ).get(SYMBOL, res) as { n: number; mn: number | null; mx: number | null };
    out[res] = r;
  }
  return out;
}

async function main() {
  const before = snapshot();
  console.log(`\n=== 1M-DERIVE REBUILD for ${SYMBOL} ===`);
  for (const res of ["1", "5", "15", "60"]) console.log(`  BEFORE res=${res.padStart(2)} n=${String(before[res].n).padStart(8)} [${iso(before[res].mn)} .. ${iso(before[res].mx)}]`);

  const oneMinFrom = before["1"].mn, oneMinTo = before["1"].mx;
  if (!oneMinFrom || !oneMinTo) throw new Error("no 1m data — nothing to derive");

  // ── STEP 0: BACKUP + integrity gate ────────────────────────────────────────
  const scratchBackup = path.join(SCRATCH, BACKUP_NAME);
  console.log(`\n[0] backup → ${scratchBackup}`);
  await db.$client.backup(scratchBackup);
  {
    const b = new Database(scratchBackup, { readonly: true, fileMustExist: true });
    const ic = (b.prepare(`PRAGMA integrity_check`).get() as any).integrity_check;
    const bn = (b.prepare(`SELECT COUNT(*) n FROM cached_candles WHERE symbol=? AND resolution='1'`).get(SYMBOL) as any).n;
    b.close();
    console.log(`[0] backup integrity_check=${ic}  1m rows in backup=${bn}`);
    if (ic !== "ok") throw new Error(`backup integrity_check=${ic} — ABORTING before any write`);
  }
  const dataBackup = path.join(ROOT, "data", BACKUP_NAME);
  fs.copyFileSync(scratchBackup, dataBackup);
  console.log(`[0] backup copied → ${dataBackup} (${(fs.statSync(dataBackup).size / 1e6).toFixed(0)} MB)`);

  // ── STEP 1: DETECT phantom buckets (before overwrite) ──────────────────────
  console.log(`\n[1] detecting phantom 15m/60m buckets (native vs 1m-derived, maxDev>0.25pt)…`);
  // Stream 1m once; aggregate into 15m + 60m derived maps in memory.
  const derived: Record<string, Map<number, { o: number; h: number; l: number; c: number }>> = { "15": new Map(), "60": new Map() };
  const it = db.$client.prepare(
    `SELECT timestamp t, open o, high h, low l, close c FROM cached_candles WHERE symbol=? AND resolution='1' ORDER BY timestamp ASC`,
  ).iterate(SYMBOL);
  for (const row of it as IterableIterator<{ t: number; o: number; h: number; l: number; c: number }>) {
    for (const sec of [900, 3600]) {
      const key = String(sec === 900 ? 15 : 60);
      const bt = Math.floor(row.t / sec) * sec;
      const m = derived[key];
      const ex = m.get(bt);
      if (!ex) m.set(bt, { o: row.o, h: row.h, l: row.l, c: row.c });
      else { if (row.h > ex.h) ex.h = row.h; if (row.l < ex.l) ex.l = row.l; ex.c = row.c; }
    }
  }
  const phantomRanges: { fromTs: number; toTs: number }[] = [];
  const detail: Record<string, { differing: number; nativeOnly: number; derivedOnly: number }> = {};
  for (const sec of [900, 3600]) {
    const key = String(sec === 900 ? 15 : 60);
    const nativeRows = db.$client.prepare(
      `SELECT timestamp t, open o, high h, low l, close c FROM cached_candles WHERE symbol=? AND resolution=? ORDER BY timestamp ASC`,
    ).all(SYMBOL, key) as { t: number; o: number; h: number; l: number; c: number }[];
    let differing = 0, nativeOnly = 0;
    const nativeSet = new Set<number>();
    for (const nr of nativeRows) {
      nativeSet.add(nr.t);
      const d = derived[key].get(nr.t);
      if (!d) { nativeOnly++; continue; }
      const dev = Math.max(Math.abs(nr.o - d.o), Math.abs(nr.h - d.h), Math.abs(nr.l - d.l), Math.abs(nr.c - d.c));
      if (dev > 0.25) { differing++; phantomRanges.push({ fromTs: nr.t, toTs: nr.t + sec - 1 }); }
    }
    let derivedOnly = 0;
    for (const bt of derived[key].keys()) if (!nativeSet.has(bt)) derivedOnly++;
    detail[key] = { differing, nativeOnly, derivedOnly };
    console.log(`[1] res=${key.padStart(2)}  differing(phantom)=${differing}  native-only(1m-gap)=${nativeOnly}  derived-only(new history)=${derivedOnly}`);
  }
  fs.writeFileSync(PHANTOM_JSON, JSON.stringify({ symbol: SYMBOL, resolution: "1", detectedAt: new Date().toISOString(), ranges: phantomRanges }, null, 2));
  console.log(`[1] wrote ${phantomRanges.length} phantom 1m reconcile ranges → ${PHANTOM_JSON}`);

  // ── STEP 2: full rebuild in 30-day chunks ──────────────────────────────────
  console.log(`\n[2] rebuilding 5m/15m/60m from 1m [${iso(oneMinFrom)} .. ${iso(oneMinTo)}] in 30-day chunks…`);
  const CHUNK = 30 * 86400;
  const written: Record<string, number> = { "5": 0, "15": 0, "60": 0 };
  let chunks = 0;
  for (let from = oneMinFrom; from <= oneMinTo; from += CHUNK) {
    const to = Math.min(oneMinTo, from + CHUNK - 1);
    const r = deriveRange(SYMBOL, from, to);
    for (const { res } of DERIVED) written[res] += r[res].written;
    chunks++;
    if (chunks % 20 === 0) console.log(`[2]   …chunk ${chunks} through ${iso(to)}  (5m+${written["5"]} 15m+${written["15"]} 60m+${written["60"]})`);
  }
  console.log(`[2] rebuild done: ${chunks} chunks. buckets written: 5m=${written["5"]} 15m=${written["15"]} 60m=${written["60"]}`);

  // ── STEP 3: sync_state.earliest_ts for derived resolutions := 1m earliest ──
  console.log(`\n[3] setting sync_state.earliest_ts := ${iso(oneMinFrom)} (1m earliest) for res 5/15/60…`);
  const now = Math.floor(Date.now() / 1000);
  for (const res of ["5", "15", "60"]) {
    const exists = db.$client.prepare(`SELECT 1 FROM sync_state WHERE symbol=? AND resolution=?`).get(SYMBOL, res);
    const mx = (db.$client.prepare(`SELECT MAX(timestamp) mx FROM cached_candles WHERE symbol=? AND resolution=?`).get(SYMBOL, res) as any).mx;
    if (exists) db.$client.prepare(`UPDATE sync_state SET earliest_ts=?, latest_ts=?, last_audit_ts=? WHERE symbol=? AND resolution=?`).run(oneMinFrom, mx, now, SYMBOL, res);
    else db.$client.prepare(`INSERT INTO sync_state (symbol, resolution, earliest_ts, latest_ts, last_audit_ts) VALUES (?,?,?,?,?)`).run(SYMBOL, res, oneMinFrom, mx, now);
  }

  // ── STEP 4: verify + summary ───────────────────────────────────────────────
  const ic = (db.$client.prepare(`PRAGMA integrity_check`).get() as any).integrity_check;
  console.log(`\n[4] main DB integrity_check=${ic}`);
  const after = snapshot();
  for (const res of ["1", "5", "15", "60"]) {
    const b = before[res], a = after[res];
    console.log(`  AFTER  res=${res.padStart(2)} n=${String(a.n).padStart(8)} (${a.n - b.n >= 0 ? "+" : ""}${a.n - b.n})  [${iso(a.mn)} .. ${iso(a.mx)}]`);
  }
  console.log(`\nnative-only (1m-gap) rows KEPT: 15m=${detail["15"].nativeOnly} 60m=${detail["60"].nativeOnly} (5m native-only counted at serve time)`);
  console.log(`phantom reconcile ranges queued for heal: ${phantomRanges.length} (15m diff=${detail["15"].differing} + 60m diff=${detail["60"].differing})`);
  console.log(`=== DONE ===\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("REBUILD FAILED:", e); process.exit(1); });
