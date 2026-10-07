/**
 * Dec-2025 roll-phantom direct cleanup (documented fallback — LEARNINGS 2026-07-30 open item).
 *
 * TARGET: MES 1m 2025-12-12 06:21:00Z (epoch 1765520460) — O/H/L/C 6971.25/6971.25/6971/6971.25
 * V=13 vs ~6911 neighbors (+60pt roll phantom). MW reconcile is impossible at 7.5 months back
 * (bf-9 dispatch answered nothing; closed-period safety refuses to reconcile without proof), so
 * this is the sanctioned targeted direct cleanup in the style of the isMarketClosed sweep:
 *
 *   1. BACKUP (create-once): the 4 affected rows (1m phantom + its 5m/15m/60m parent buckets)
 *      → cached_candles_backup_dec12_phantom.
 *   2. DELETE the 1m phantom row (guarded: only if open > 6960 — refuses to delete a healed bar).
 *   3. Re-derive the parent buckets via the server's own deriveForDeletedOneMin (exact same
 *      aggregation semantics as every other derived bar in the store).
 *   4. Mark the now-empty minute unfillable (reason 'phantom_removed') so gap-audit never
 *      re-requests it from MW.
 *
 * Idempotent: a re-run finds no phantom, skips the delete, re-derives (no-op values), and
 * keeps the single backup + single unfillable row.
 *
 * Outside the engine window (starts 2026-04-17) — display-only data; signal history untouched.
 *
 * Run from repo root: npx tsx scripts/dec12-phantom-cleanup.ts
 */
import { db } from "../server/db";
import { deriveForDeletedOneMin } from "../server/derive-bars";

const raw = db.$client;
const SYM = "MES";
const T = 1765520460; // 2025-12-12T06:21:00Z
const BUCKETS: Array<{ res: string; ts: number }> = [
  { res: "5", ts: Math.floor(T / 300) * 300 },    // 1765520400 06:20Z
  { res: "15", ts: Math.floor(T / 900) * 900 },   // 1765520100 06:15Z
  { res: "60", ts: Math.floor(T / 3600) * 3600 }, // 1765519200 06:00Z
];
const BACKUP = "cached_candles_backup_dec12_phantom";

const rowOf = (res: string, ts: number) =>
  raw.prepare(`SELECT * FROM cached_candles WHERE symbol=? AND resolution=? AND timestamp=?`).get(SYM, res, ts) as any;

const show = (tag: string) => {
  console.log(`\n--- ${tag} ---`);
  const one = rowOf("1", T);
  console.log(`1m  06:21Z: ${one ? JSON.stringify(one) : "(deleted)"}`);
  for (const { res, ts } of BUCKETS) {
    console.log(`${res}m`.padEnd(3) + ` ${new Date(ts * 1000).toISOString().slice(11, 16)}Z: ${JSON.stringify(rowOf(res, ts))}`);
  }
};

show("BEFORE");

// 1. Backup (create-once — same convention as the signal_history_backup_* tables).
const backupExists = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(BACKUP);
if (!backupExists) {
  raw.exec(
    `CREATE TABLE ${BACKUP} AS
       SELECT * FROM cached_candles
        WHERE symbol='${SYM}' AND (
          (resolution='1'  AND timestamp=${T}) OR
          ${BUCKETS.map(b => `(resolution='${b.res}' AND timestamp=${b.ts})`).join(" OR ")}
        )`,
  );
  const n = (raw.prepare(`SELECT COUNT(*) c FROM ${BACKUP}`).get() as any).c;
  console.log(`\n[backup] created ${BACKUP} with ${n} rows`);
} else {
  console.log(`\n[backup] ${BACKUP} already exists — left untouched (create-once)`);
}

// 2. Guarded delete of the phantom 1m bar.
const phantom = rowOf("1", T);
if (!phantom) {
  console.log(`[delete] 1m ${T} already absent — skipping (idempotent re-run)`);
} else if (phantom.open <= 6960) {
  console.error(`[delete] REFUSED: 1m ${T} open=${phantom.open} is not the documented phantom (expected >6960). No changes made.`);
  process.exit(1);
} else {
  const del = raw.prepare(`DELETE FROM cached_candles WHERE symbol=? AND resolution='1' AND timestamp=?`).run(SYM, T);
  console.log(`[delete] removed 1m phantom (id ${phantom.id}, O ${phantom.open} V ${phantom.volume}) — ${del.changes} row`);
}

// 3. Re-derive the parent buckets from the surviving 1m rows (server's own semantics).
const dr = deriveForDeletedOneMin(SYM, [T]);
console.log(`[derive] rederived=${dr.rederived} deleted=${dr.deleted} (expect 3/0 — the buckets still have 1m constituents)`);

// 4. Unfillable marker so gap-audit never re-requests the deleted minute from MW.
const unf = raw
  .prepare(`SELECT id FROM unfillable_ranges WHERE symbol=? AND resolution='1' AND from_ts=? AND to_ts=?`)
  .get(SYM, T, T);
if (!unf) {
  raw.prepare(`INSERT INTO unfillable_ranges (symbol, resolution, from_ts, to_ts, attempts, reason) VALUES (?,?,?,?,?,?)`)
    .run(SYM, "1", T, T, 0, "phantom_removed");
  console.log(`[unfillable] marked MES 1m ${T} (phantom_removed)`);
} else {
  console.log(`[unfillable] marker already present (id ${(unf as any).id})`);
}

show("AFTER");

// Sanity: no bucket may still carry the phantom high.
let bad = 0;
for (const { res, ts } of BUCKETS) {
  const r = rowOf(res, ts);
  if (!r) { console.error(`[verify] MISSING ${res}m bucket ${ts}`); bad++; continue; }
  if (r.high > 6920) { console.error(`[verify] ${res}m bucket ${ts} still carries phantom high ${r.high}`); bad++; }
}
if (rowOf("1", T)) { console.error(`[verify] 1m phantom still present`); bad++; }
console.log(bad === 0 ? "\n[verify] OK — phantom gone, all parent buckets healed" : `\n[verify] ${bad} FAILURES`);
process.exit(bad === 0 ? 0 : 1);
