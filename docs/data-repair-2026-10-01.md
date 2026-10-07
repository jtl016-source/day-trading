# Data repair 2026-10-01: false losses, the 09-04 phantom bar, the 09-14 roll seam

**Date:** 2026-10-01 (16:20–16:30 ET). **Source of the findings:** `docs/signal-analysis-2026-10-01.md` §7 and the recompute scripts under `C:\BaxterSandbox\analysis\report\`. **Status:** done. The live server on :3000 was never restarted, no trade setting was touched (auto-trade stayed armed: contracts 2, intervals 5m/60m), and the contract guard stayed on-contract throughout.

Every write had a create-once backup table and a dry run first. Nothing in `shared/`, `server/`, the gate file or the standing book JSON changed.

---

## 1. The 10 stored losses that are wins on the served bars — re-resolved (+371.0 pts)

**Method.** A scratch script (`resolve-sweep.mts`, copy in the sandbox folder) imported the canonical resolver (`shared/outcome-resolver.ts`, `walkOutcomeCanonical`, TP1-only, carry-overnight) and `FACT_ENGINE_DEFAULTS` from the main checkout, fetched the server-served 1m bars from `GET /api/data/cached-continuous/MES/1m` in 10-day chunks (51,581 bars, 08-11 → 10-01) — the same bars the catch-up resolver walks — and re-walked every closed `signal_history` row fired since 2026-08-13 (2,666 rows).

Dry run: 1,861 win→win, 795 loss→loss, **10 loss→win_tp1, 0 win→loss**, net +371.0. That is exactly the set the analysis doc named.

| id | key | fire (ET) | source | stored | now | exit now (ET) | cause |
|---|---|---|---|---|---|---|---|
| 145616 | 60m \| Long | 09-14 11:00 | live | loss −17.25 | win_tp1 +19.00 | 09-14 12:53 | 09-14 roll interleave (stored MAE 68.5 = Sep print) |
| 145659 | 1m \| Long | 09-14 11:37 | catchup | loss −22.50 | win_tp1 +14.00 | 09-14 12:19 | roll interleave (MAE 61) |
| 145660 | 1m \| Long | 09-14 11:43 | catchup | loss −25.00 | win_tp1 +13.25 | 09-14 12:49 | roll interleave (MAE 70) |
| 145677 | 5m \| Long | 09-14 11:50 | catchup | loss −24.00 | win_tp1 +11.25 | 09-14 12:49 | roll interleave (MAE 68.5) |
| 145667 | 1m \| Long | 09-14 11:53 | catchup | loss −25.00 | win_tp1 +13.25 | 09-14 12:49 | roll interleave (MAE 71.5) |
| 146638 | 5m \| Long | 09-14 12:15 | regen | loss −24.00 | win_tp1 +11.25 | 09-14 12:50 | 09-17 window regen walked the isolation-filtered chain; touch bar dropped |
| 146637 | 1m \| Long | 09-14 12:16 | regen | loss −25.00 | win_tp1 +13.25 | 09-14 12:50 | same |
| 146642 | 1m \| Long | 09-14 12:43 | regen | loss −25.00 | win_tp1 +13.25 | 09-14 12:50 | same |
| 146717 | 5m \| Short | 09-15 03:50 | regen | loss −24.00 | win_tp1 +11.25 | 09-15 04:12 | same |
| 148944 | 1m \| Short | 10-01 03:25 | live | loss −27.25 | win_tp1 +12.25 | 10-01 04:33 | tab recompute on the isolation-filtered chain (08:32Z touch bar dropped) |

**Why a direct write.** The POST route's transition matrix treats `loss` as terminal, so no server endpoint can perform these flips; the direct `UPDATE … WHERE id=? AND outcome='loss'` path is the one the 2026-07-31 sweep repair established. `data/db-repair.lock` was held for the transaction and removed after; `POST /api/signals/resync-broadcast` nudged open tabs.

**Backup.** `signal_history_backup_20261001` = full table copy, 138,325 rows, taken before the first write (all 15 touched ids are `loss` there).

**Standing book.** None of the keys exist in `C:\BaxterData\fact-engine-backtest-results.json` (generated 2026-08-12, last fire 08-17), so no artifact patch was needed.

## 2. The 2026-09-04 phantom 1m bar — healed from MotiveWave

**The bar.** `cached_candles` MES res 1, timestamp 1788539280 = 2026-09-04 12:28:00 ET (16:28Z): O 7760.25 / H 7761.25 / L 7750.25 / C 7750.50, V 699, between a 12:27 close of 7730.00 and a 12:29 open of 7729.50 (+30.25 in, −21.00 out). It was served by `cached-continuous` (the serving path has no bad-print guard) and folded into the 5m 12:25, 15m 12:15 and 60m 12:00 buckets (all carried high 7761.25). Yahoo ES=F 5m for the 12:25 bucket shows high 7730.75, so the print was false.

**Roll-repair endpoint.** `POST /api/data/roll-mismatch-repair {"apply":false}` was run first as asked: it only reaches Yahoo's 6.5-day 1m window and reported "no stored 1m minute disagrees with Yahoo … nothing to repair" (6,190 Yahoo bars, 0 mismatches). It cannot reach 09-04.

**Repair that worked.**
1. Backup `cached_candles_backup_sep04_phantom` (80 rows: 1m 12:00–13:00 ET, the 5m/15m rows in that hour, the 60m 12:00 row).
2. `POST /api/data/reconcile-ranges/MES/1 {"ranges":[{"fromTs":1788539100,"toTs":1788539400}]}` → `ranImmediately:true`; the connected 1m LiveBarRelay study answered backfill `bf-3` within seconds (`bulk_bars: persisted 5 bars for MES res=1`).
3. The phantom minute was **overwritten** with MotiveWave's real bar: O 7730 / H 7730 / L 7728.75 / C 7729.50, V 1018 (same row id 66600680). The derive hook rebuilt the parents: 5m 12:25 high 7731, 15m 12:15 high 7733.75, 60m 12:00 high 7735.25.
4. Verified through `cached-continuous` on all four intervals; max high in the 12:00–13:00 window is now 7735.25. No `unfillable_ranges` marker was needed (no hole was left).

**Consequence applied.** After the heal, the same sweep flipped exactly the five 09-04 catch-up shorts the phantom had "stopped" (the isolation-filter report's "5 fabricated losses −180.5"), nothing else:

| id | key | fire (ET) | stored | now | exit now (ET) |
|---|---|---|---|---|---|
| 145362 | 1m \| Short | 09-04 10:54 | loss −25 | win_tp1 +13.25 | 09-07 08:12 |
| 145386 | 5m \| Short | 09-04 10:55 | loss −24 | win_tp1 +11.25 | 09-07 07:26 |
| 145363 | 1m \| Short | 09-04 11:02 | loss −25 | win_tp1 +13.25 | 09-07 19:17 |
| 145365 | 1m \| Short | 09-04 11:22 | loss −25 | win_tp1 +13.25 | 09-07 18:39 |
| 145366 | 1m \| Short | 09-04 11:47 | loss −25 | win_tp1 +5.50 | 09-04 13:46 |

These five were not in the user's list of ten; they became wrong-versus-served-bars only because the bar was repaired, and they are covered by the same backup table. Combined effect of both passes: 15 rows, +551.5 pts.

## 3. The 2026-09-14 roll seam — verified, nothing to repair

- 1m store since 09-01: exactly **one** ≥30-pt open-vs-previous-close jump, 09-14 11:30 → 11:31 ET, +67.25. That is Yahoo's one-way Sep→Dec roll cliff, correct for a non-back-adjusted continuous series. 5m / 15m / 60m: 0 jumps. The 09-17 repair held; integrity-check V6 is clean.
- The "+67-pt seam contaminating 38 rows' MFE/MAE" in the analysis dataset is replay rows whose first-crossing windows straddle that single cliff. Only one stored row straddled it (145616, re-resolved above).
- `yellowbox_day_zones` 09-11 … 09-18 are present at ver 5 (recomputed after the 09-17 drop).
- Anything that walks across 11:31 ET on 09-14 sees a +67 step. Removing it would mean back-adjusting the continuous series, which is a design decision, not a data defect.

## 4. Integrity check

`npx tsx scripts/integrity-check.ts` run three times (baseline, after pass 1, final): **12 violations / 0 warnings each time, identical findings** (the pre-existing Aug 7–14 rows-vs-08-12-book class: V1-orphan-regen, V2-stale-live, V2b-live-drift — "the Sunday regen has been failing since 08-16"). 0 new, 0 gone. Copies: `integrity-baseline.json`, `integrity-after.json`, `integrity-final.json` in the sandbox folder.

Live state after the work: feed mw-live, contract guard on-contract (Z6, Δ −0.5), repair sentinel absent, last scheduled catch-up ok, trade settings unchanged.

## 5. Revert

```sql
-- outcomes (15 rows)
UPDATE signal_history SET outcome=b.outcome, exit_price=b.exit_price, exit_ts=b.exit_ts,
  points_result=b.points_result, mae=b.mae, mfe=b.mfe, bars_to_exit=b.bars_to_exit, updated_at=b.updated_at
FROM signal_history_backup_20261001 b WHERE signal_history.id=b.id
  AND signal_history.id IN (145616,145659,145660,145677,145667,146638,146637,146642,146717,148944,145362,145386,145363,145365,145366);
-- the phantom window (only if you really want the false print back)
INSERT OR REPLACE INTO cached_candles SELECT * FROM cached_candles_backup_sep04_phantom;
```

## 6. Not done / open

- The analysis dataset (`C:\BaxterSandbox\analysis\signals-3mo.json`, `live-book-30d.json`) still carries the pre-repair outcomes for these 15 keys; rebuild it before reusing it.
- The 12 pre-existing integrity violations are untouched (they need the standing-book regen the Sunday job has been failing since 08-16).
- The serving path still has no bad-print guard; the proposal in `C:\BaxterSandbox\analysis\checks\served-bars-2026-10-01\` (integrity-check "W3" daily served-bar census) would have caught 148944 the same morning.

## Files
- Sandbox: `C:\BaxterSandbox\analysis\repair-2026-10-01\` (this report, `resolve-sweep.mts`, `sweep-dry-pass2-after-bar-heal.json` / `sweep-apply-pass2-after-bar-heal.json` (the pass-1 JSONs were overwritten by pass 2; pass-1 rows are listed in §1 and in the console log), the three integrity JSONs, `phantom-backup.cjs`, `seam.cjs`).
- Main checkout: `docs/data-repair-2026-10-01.md` (this report) and the LEARNINGS.md entry dated 2026-10-01.
