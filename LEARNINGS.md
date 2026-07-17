# LEARNINGS — Milks Yellow Box Strategy Viewer

**2026-07-13 — USER CONFIRMED "CHART IS PERFECT" — state locked in (commits 4ba772c, 5c88740) + backups + in-app backup button**
- MILESTONE: after the 1m-derivation architecture went live (all 5m/15m/60m computed from the single MW 1m stream; commit 4ba772c — the Opus build was verified working but died uncommitted at a session limit; committed by the main session after independent tsc + git review), the user confirmed the chart is finally correct. THE WINNING ARCHITECTURE, for the record: MW LiveBarRelay v2 on ONE active 1m chart → server-driven getBars backfill + reconcile-deletes (gap-audit) → 1m is the only MW-fed resolution → derive-bars.ts computes 5m/15m/60m from 1m on every 1m write (bucket-exact consistency, every candle) → serving caps (ed2b1c4) keep responses <2s on a 3M-row store → heavy read-filters bypassed for MW-covered ranges.
- PERMANENCE MEASURES: (1) DB backup of the exact perfect state via online better-sqlite3 .backup() while server ran — `data/app.db.backup-chart-perfect-2026-07-13` (983MB, integrity ok, 3.09M MES rows). (2) Program source mirrored to `Desktop\DAY TRADING PC - DO NOT TOUCH\Milks-Yellow-Box-Strategy` via robocopy /MIR (excludes: node_modules/.git/data/dist/logs/db-files; /XD-excluded dirs are PRESERVED in the destination, so the old May-era data/ copy there survives). (3) In-app "Back Up Program" button: Settings → Program Backup card → POST /api/backup/program runs the same mirror server-side (robocopy exit 0-7 = success bitmask, >=8 = failure; parse "Files : N copied" for the toast) and writes BACKUP_MANIFEST.txt with restore instructions (commit 5c88740).
- Post-restart this time ALL FOUR studies sent hello automatically (no tab-clicking needed) — with the market open and charts recently active, MW fires calculate() on reconnect. The tab-click ritual is only needed when charts have been idle/backgrounded a long time.
- Restart performance proof: cached-continuous per interval now 0.36-1.63s (was 7-8s pre-caps, pre-restart).
- OPERATIONAL RUNBOOK for the user (told): keep ONE MW 1m chart open with LiveBarRelay; after any server restart, if the live edge stalls, click that 1m chart once; press "Back Up Program" whenever the program is in a state worth keeping; the DB backs itself up only when explicitly requested (983MB a pop — don't automate every press).

**2026-07-09 (later) — MW-RECONCILIATION: phantom-delete in the backfill path + always-closed direct cleanup + MW-covered filter gating (supersedes never-delete for MW reconciliation)**
- USER MANDATE (explicit, supersedes the old "never delete" convention FOR MW-RECONCILIATION ONLY): remove the "floating false candles" (closed-period phantoms) and the "same wicks at multiple candles that are false" (low-vol displaced single-print bars) throughout ALL history. MW's getBars is authoritative, so a timestamp inside a range MW answered for which MW has NO bar cannot be real.
- ROOT CAUSE of BUG-1 (floating candles / false-wick clusters): the v2 backfill OVERWRITES timestamps MW returns (onConflictDoUpdate) but NEVER REMOVES our rows at timestamps MW has no bar. Verified in the July-3→5 closure window: 12–13 phantom rows each on 1m/5m/60m (e.g. `5m 2026-07-04T01:00Z O7555.75 V244` — a Saturday bar). Also 279 low-vol (V≤5) displaced non-flat 5m prints in the last 90d alone (e.g. `5m 2026-07-03T16:15Z close 7624.25 V2` vs real ~7555) — the "identical false wicks." The mid-session displaced prints at real timestamps get HEALED (overwritten) by reconciliation, not deleted (MW has a real bar there).
- FIX 1 — RECONCILE-DELETE in the backfill path (`server/gap-audit.ts`): added `recordBackfillBars(id, timestamps)` (fed from `live-bars.ts` on every v2 `bulk_bars` batch, recording the RAW returned timestamps BEFORE validation so a real MW bar our validator rejects can never be treated as a phantom) + `reconcileRange()` called in `onBackfillDone`. **SAFETY RULE (why it can't wipe real data):** reconcile ONLY when `count>0` (MW returned real bars → chart is active), and ONLY within `[min(returned)..max(returned)]` (the span MW ACTUALLY covered) — NEVER the raw requested range. This defends against LiveBarRelay `serviceBackfill` step-2 `source:"chart"` degrade (when getBars returns nothing it falls back to the chart-LOADED DataSeries slice, which may cover only PART of the range) — clamping to the returned span means we never delete real DB bars outside what MW could see. `count===0` reconciles NOTHING (an idle chart that can't answer is indistinguishable from a real closure). Deep `[0..cap]` probe never reconciled. Every delete logged (`[gap-audit] RECONCILE SYM:RES deleted N phantom rows within MW-returned span…`). 4/4 offline safety unit tests pass (phantom deleted + reals kept; partial-span keeps outside rows; count=0 no-op; deep no-op).
- FIX 1b — FULL-HISTORY RESYNC (`gap-audit.ts` `requestFullResync`/`enqueueFullResync`, `POST /api/data/full-resync/:sym/:res`): the normal `auditGaps` requests only MISSING session-open runs, so it SKIPS OVER closed-period phantoms (they sit at `!isSessionOpen` grid points between real bars, never "missing"). The force-resync instead sweeps the WHOLE `[provider-earliest..now]` range in reconcile-enabled MAX_RANGE_BARS chunks — each chunk MW answers (count>0) reconcile-deletes the phantoms MW omits INSIDE it, including closed-session floating candles interior to a chunk. Endpoint also clears retryable `no_data` first so wrongly-marked holes get re-requested.
- FIX 2 — ALWAYS-CLOSED DIRECT CLEANUP (`POST /api/data/purge-closed`, also run once directly): rows at times `isMarketClosed()` says the market is ALWAYS shut (Sat; Fri>17ET; Sun<18ET; the 17–18ET daily halt) can be deleted outright across ALL history — no real bar can exist there, independent of MW retention. Ran it: **deleted 821 always-closed rows** (MES 1m=402, 5m=349, 15m=5, 60m=57; ES 1m=1, 5m=1, 60m=6) → re-count = 0 across every SYM:RES. This alone removed all 36 phantom rows in the July-3→5 closure window; the only 4 rows left there are the LEGITIMATE Sunday-18:00-ET reopen (`2026-07-05T22:00Z`, 5m V4212 / 60m V22141). Do NOT hardcode a holiday calendar — early-close phantoms OUTSIDE always-closed windows are MW-reconciliation's job.
- FIX 3 — MW-COVERED FILTER GATING (`server/routes.ts` cached-continuous, `serveFilter()` + `mwCoverageTs()`): for bars newer than a resolution's `sync_state.earliest_ts` (MW-authoritative, ingest-validated, reconcile-cleaned) BYPASS the heavy heuristic trio (`dropWickSpikes`/`dropIsolatedSpikes`/`dropCompletedGhostBars`) — keep only the cheap malformed-guard (`isSpikeBar`) + `isMarketClosed` + flat + off-grid guards. Older-than-coverage bars keep the FULL chain (old untrusted pipeline). No `sync_state` for a res ⇒ coverTs=Infinity ⇒ everything keeps the full chain (safe default). RATIONALE: those heavy filters were built for the old stitched pipeline and would drop thin-but-real overnight MW bars (V5–50). "Serve every single MW candle." 2/2 gating split tests pass. **DEPENDENCY: because gating bypasses the trio, the 279 displaced phantom prints MUST be healed by the full-resync BEFORE this is safe to serve — otherwise they leak. Roll them out together (restart on this code THEN run full-resync).**
- BACKUP (verified before ANY delete): better-sqlite3 online `.backup()` (WAL-safe, live — NO need to stop the server, unlike VACUUM INTO) → scratchpad, integrity_check=ok, then copied to `data/app.db.backup-pre-mw-reconcile-2026-07-09` (1.0GB, integrity ok). Online `.backup()` checkpoints the WAL so its counts include committed WAL data (why it showed 1m=2.33M vs a naive readonly-open showing 200k — the readonly open without full WAL read undercounts a busy DB).
- OBSERVED (live DB, mid-session): since yesterday all FOUR MES resolutions handshook + deep-backfilled (1m 200k→2.33M back to 2019, 15m→2022, 60m→2020) — all now have `sync_state`, so gating + reconcile apply to all four. BUG-2 (1m holes): a 1040-min 1m gap Jul-8 19:57Z→Jul-9 13:17Z remains (deep history filled but the recent overnight not yet) — no `no_data` recorded for MES:1, so the force-resync (or next audit) will re-request it.
- BLOCKER (reported to user, NOT worked around): the live verification (task 4) + the MW-reconciliation full-resync + gating verification REQUIRE the server to run THIS new code. The user's PRE-EXISTING dev server (PID from session start) holds ports 3000/5000 and is actively backfilling; the auto-mode classifier BLOCKS killing a process this session didn't create, and 3000/5000 are occupied so a second instance can't bind. So: code + always-closed cleanup + backup are DONE and tsc-clean; the full-resync sweep + live 4a–4e verification are PENDING a server restart on this branch's code (user must stop their server, or authorize it).
- tsc --noEmit EXIT 0. Additive schema only (no new tables needed — reused sync_state/unfillable_ranges). Did NOT touch mw-study/ or DayTrading/.

**2026-07-09 — MotiveWave is now the SINGLE SOURCE OF TRUTH: ported the v2 server-driven getBars backfill protocol onto `restore/jul1-plus-v2-studies` + demoted the disk-ingest phantom factory**
- ARCHITECTURE CHANGE (user-approved): stop stitching 4 unreliable candle sources (MW `.bar_data1` disk files, `.tick_data` reconstruction, price-only ticks, Yahoo patches). Every glitch class this week (phantom bars, stale opens, splice corruption, frozen intervals) came from that stitching. Solution: the deployed v2 `LiveBarRelay.java` (already on this branch) sends a `hello` handshake `{type:"hello",symbol,resolution,seriesStartMs,seriesEndMs,ver:2}` per chart, then services server-requested `{type:"backfill",id,fromMs,toMs}` by streaming `bulk_bars` batches (500/msg, id/seq-tagged) + `backfill_done{count,earliestAvailableMs}`. Ported the SERVER side of that protocol from the SDK branch (`claude/historical-data-fetch-fix-j2sw91`, commit 50d82fd) onto the current July-1 lineage.
- PORTED: (1) `server/gap-audit.ts` VERBATIM (self-contained: CME Globex session grid, per-(SYM:RES) `StudySync` dispatcher, deep-history probe `{fromTs:0,toTs:earliestStored,deep:true}` on first-ever sync, one-in-flight backfill, `unfillable_ranges` provider_cap/no_data memory with retry-once so it never infinite-loops, hourly re-audit, `getCompleteness`). (2) `server/roll-heal.ts` VERBATIM (`detectAndHeal` — shifts older stored bars by a constant roll δ when the overlap disagrees uniformly by >½ ES tick). (3) `shared/schema.ts` + `server/db.ts`: 3 additive `CREATE TABLE IF NOT EXISTS` (sync_state, unfillable_ranges, adjustment_log) — NO destructive SQL on the live 820MB DB. (4) `server/routes.ts`: read-only `/api/data/gaps/:sym/:res` (completeness) + `DELETE /api/data/unfillable/:sym/:res` (clears only retryable `no_data`, never `provider_cap`, never cached_candles).
- MERGE DECISION — `server/live-bars.ts` (the tricky part): MERGED the v2 protocol INTO the current file, did NOT overwrite it. KEPT ALL current-branch functionality the SDK version lacked: port-5000 bridge server (studies connect to :5000), `reconnectMWStudies`, `setTickRelayConnected`, AutoTrader order-commands sockets + socketAlive ping/pong, `footprint_bar`, `cacheInvalidate`, preloaded `_fpAddBar`, MW ping/pong, `lastDumpMaxTs` re-dump guard, `validateBar`/`isSaneBarTime`/float32-bound/body-anomaly chain in persistBar/persistBulk. ADDED: `studySockets` Map (SYM:RES→ws), `hello`/`backfill_done` handlers → `onStudyConnected`/`onBackfillDone`, `registeredKeys` per-socket + close-handler unregister → `onStudyDisconnected`, v2 bulk_bars `id`/`seq`/`bulk_report` ack + `detectAndHeal` before persist.
- KEY MERGE INSIGHT (the one that makes healing work): the current branch's re-dump high-water guard (`newBars = cleanBars.filter(b => b.t > watermark)`) DROPS bars OLDER than what the DB already has — correct for v1 constant re-dumps, but it would silently discard EVERY v2 backfill bar (gap-audit requests exactly the ranges that are MISSING/old). So I gated BOTH the fast re-dump rejection AND the watermark filter behind `if (!isV2)` (isV2 = `id` present). v2 bars bypass the guard entirely and overwrite via `onConflictDoUpdate` — that IS the mechanism that heals history to MW-identical values. v2 bars still flow through the full validation chain (validateBar rejects off-grid/ghost/spike; float32 bounds; body-anomaly) — getBars is authoritative but a Java reflection bug could still emit garbage, so guards stay.
- SYMBOL MODULE RECONCILIATION: current branch has `shared/symbol.ts` (singular) with `normalizeSymbol` that folds contract codes (MESM6→MES, MES=F→MES, .CME suffix) — a SUPERSET of the SDK's `shared/symbols.ts`. Kept the singular module, adapted the ported code's imports; did NOT add a duplicate module.
- DELIBERATELY SKIPPED from the SDK diff: `foldContractSymbols(sqlite)` in db.ts — it does `DELETE FROM cached_candles/signal_history` to merge contract-keyed rows into roots. That violates never-delete on the live DB, and this branch already normalizes symbols at INGEST (normalizeSymbol on every bulk_bars), so contract-fragmentation can't occur going forward. Also skipped `csv-watch.ts` wiring (out of scope, no hard dependency).
- DISK-INGEST DEMOTION (`server/mw-reader.ts`): added module-level `const DISK_INGEST_ENABLED = false` (one-line revertible) gating the FOUR DB-writing disk paths: startup `.bar_data1` `loadMultiDir`, the 1s `pollChanged` bar-file poll, `onTickFileChange` (disk `.tick_data`→applyTick→bulkUpsert), and the 1s stale-feed `applyTick` heartbeat. KEPT LIVE: `notifyExternalTick` (TickRelay WS tick path — its own bulkUpsert for the live forming/provisional bars that MW backfill later overwrites), `setMWBroadcast`, `setTickRelayConnected`, `getMemBars`/`getLatestBar*` (routes.ts fallback — may return empty/stale now, never throws). `reloadAll` left reachable (manual HTTP-triggered, like Yahoo backfill — not the auto phantom factory).
- VERIFIED END-TO-END (real numbers, live MW running with v2 studies, server booted on :3000/:5000): log showed `[mw-reader] disk bulk load SKIPPED (DISK_INGEST_ENABLED=false)` and ZERO `[mw-reader] bulkUpsert` (disk writer wrote nothing); `[mw-feed] hello MES:5 ver=2 series=[1783430400000..1783602900000]`; `[gap-audit] MES:5 → backfill bf-1 [0..1736243100] (deep)` then bf-2..77 (session-hole gaps + live edge); ~817 `bulk_bars: persisted 500 bars for MES res=5` batches, 6 skipped, ZERO persist errors. **MES 5m rows 106,390 → 485,046** (+378,656); min ts 2025-01-07 → **2019-08-04** (MW supplied 5.5yr of deep 5m history the DB never had). `sync_state` earliest_ts=1564956000 (provider cap) recorded; `unfillable_ranges` got the deep `provider_cap` + ~27 `no_data` session holes (retry-once → marked unfillable, NO infinite loop). Spot-check: deep 2019 bars O=2933.25 C=2931.25 V=998 (correct ES level, on-grid, validated); recent 2026-07-09T13:10Z O=7547.75 C=7547.25 live. Serving endpoint `/api/data/cached-continuous/MES/5m` returned both the deep 2019 bars AND fresh live bars byte-identical to the DB — the read filters did NOT drop freshly-backfilled MW bars.
- CAVEAT / OPEN: only the 5m chart sent `hello` during the test window; 1m/15m/60m studies connected (200+ rapid `[mw-feed] MotiveWave study connected`) but never handshook — the Java fires `hello` from `calculate()` only once its chart resolves resolution + ticks, and rapid reconnects can prevent it on idle charts. The SERVER correctly handles whichever resolutions handshake (gap-audit keys per SYM:RES); when the user's other 3 charts tick, they'll backfill identically. The 200+ connects with 0 clean disconnects is a study-side reconnect pattern (Java reconnect-every-5s + multiple instances), harmless server-side (ping/pong reaps dead sockets).
- 60m grid: v2 study emits 60m timestamps at :00 (getBars/BarSize minutes → server stores as-is); `validateBar` with resSec=3600 rejects non-:00, so no :30 rows can re-enter (the July-1 :00 standardization holds). No 60m hello observed this session so unexercised live, but the ingest guard is correct.
- SAFETY: recent backup `data/app.db.backup-pre-splice-repair-2026-07-08` (820MB, Jul 8) present; backfill is pure upsert/insert (never deletes rows). tsc --noEmit EXIT 0 after every edit. Port 3000 + 5000 left FREE (verified Get-NetTCPConnection = 0 listeners). Committed this time per instructions.

**2026-07-08 (later) — "No charts are accurate": FOUR distinct causes found and fixed (commit d310419 + Yahoo splice repair)**
- USER REPORT after the DB restore + July-2 port: "no charts are accurate at all." Systematic diagnosis found FOUR interacting causes — none of which were the filters themselves (today's 5m was verified 99% accurate vs Yahoo, 132/134 closes within 1pt):
- CAUSE 1 — 1m chart 5.5h STALE: raw DB had no 1m rows after 14:02Z despite live ticks flowing (live in-progress bar current, but never PERSISTED). Root cause: tick-built in-progress bars carry `volume: 0` (TickRelay ticks are price-only), and the July-2 `validateBar` ghost-guard in `bulkUpsert` silently rejected every completed tick-built bar. THE LESSON: a write-guard added later can silently kill a legitimate producer whose data shape predates the guard — when adding write-validation, grep for every producer of that data and check each one's field population. FIX: count ticks as volume (`volume += 1` per tick, seed 1 — same convention as the tick-file parser); real MW volume still overwrites via onConflictDoUpdate.
- CAUSE 2 — PHANTOM-OPEN bars from stale boot seeds: at boot, in-progress bars are seeded from the last tick-FILE price (hours stale when MW's tick files lag, e.g. 7559.25 vs market 7525). First real tick only updated close/low → bar persisted with phantom open/high 35pt off. Worse, CAUSE-1's fix made these persistable (volume now > 0). FIX: `volume === 0` marks a never-ticked boot seed — RESEED the whole bar (OHLC=price) on the first real tick instead of updating. Applied to 1m/5m/60m in BOTH notifyExternalTick and the disk-file tick path.
- CAUSE 3 — the Jul-2→Jul-5 SPLICE region (merged fresh-SDK rows) contained phantom-OPEN bars (O 7590-7615 vs real 7525-7550, e.g. 5m 07-02T22:55 O7601.5 L7535 V143) that evade ALL filters because only open/high are corrupt while the CLOSE is real — clustering uses closes (passes), lone-wick needs body-inside (body spans the phantom open → fails), volume 143-281 above the 100 floor. NEW GLITCH SHAPE to remember: "stale-open" — huge upper wick + body from a false open, real close. FIX: Yahoo overwrite where `max(|dO|,|dH|,|dL|,|dC|) > 4pt` for Jul-2 12:00→now (5m: 77 repaired/911 ok; 15m: 1; 60m: 31; 1m: 103 + 705 missing inserted), then 60m REBUILT from the now-verified 5m aggregation for the window (22 more; all flagged 60m bars now dev 0.0 from 5m agg). Two last-hour phantom rows (written before the code fix loaded; Yahoo didn't have those minutes yet) patched from neighboring closes.
- CAUSE 4 — false positives in MY OWN spike scan: range>25pt is NORMAL for a 60m bar (V133k-144k real hours) and the 15m 08:15 V30207 was a real 40pt news drop — verify against Yahoo/5m-agg before calling an hourly bar a glitch; don't reuse the 1m/5m thresholds on higher timeframes.
- VERIFIED END-TO-END: post-fix, 1m/5m have ZERO range>25pt anomalies over 6 days; live 1m persistence confirmed by watching a fresh bar land in the DB 1 minute after its bucket closed (Monitor until-loop); page renders (17 canvases, no errors; preview screenshots may time out on the ~176k-bar initial render — use preview_eval readyState/canvas-count instead). Backup at `data/app.db.backup-pre-splice-repair-2026-07-08` (VACUUM INTO scratchpad first — faster off OneDrive — then copied to data/).

**2026-07-08 — Ported the July-2 candle-glitch + contract-roll upgrades from `a1ce1f1` onto `restore/jul1-plus-v2-studies` (working tree only, not committed)**
- TASK: bring the verified July-2 filter suite + contract-roll fix from `a1ce1f1` (fix/candle-glitch-and-ingestion-guards, on the 06-13 base) onto the current branch (HEAD 98494be, the July-1 code). Ported FAITHFULLY (no redesign) — the algorithms were verified extensively upstream.
- **routes.ts (item 1, done):** replaced the two July-1 filter fns with the THREE July-2 module-level generics over `type SpikeBar = {open,high,low,close,volume:number|null,time}` — `dropCompletedGhostBars` (drops completed V0/null bars, exempts last array elem = forming), `dropIsolatedSpikes` (windowed-majority VOLUME-weighted clustering ±4 bars, clusterTol `max(12,px*0.0015)`, dominant-VOLUME track = real, tiny-minority/thin-displaced dropped, anchor-CONFIRMED bars protected from the secondary 4-pass pairwise displaced-body cleanup), `dropWickSpikes` (low-vol `vol<100` tol `max(5,close*0.0007)` else `max(8,close*0.001)`, VOL_HARD_FLOOR 500, lone-wick body-inside test, 4 passes). Wired BOTH cached-continuous call sites (DB path + memBarsToCandles fallback) as `dropWickSpikes(dropIsolatedSpikes(dropCompletedGhostBars(mapped)))`, innermost=ghost, BEFORE the 15m-from-5m aggregation.
- ADAPTATION (routes.ts): the current branch keeps EXTRA July-1 `.filter()` calls a1ce1f1's base lacked — `isMarketClosed`, flat `high===low`, off-grid `timestamp % resSec === 0`. Those were PRESERVED (they're correct July-1 additions); I only inserted `dropCompletedGhostBars` as the innermost wrap and swapped the two filter fn bodies verbatim.
- **mw-reader.ts (item 2, done):** added `sessionDayKey()` + the `_sessionDayFmt` Intl(America/New_York, h23) formatter (DST-safe 6PM-ET session-day bucketing, NEVER a hardcoded offset); rewrote `loadMultiDir` Step 1/1b from per-MINUTE "highest volume wins" (flip-flops between contracts during roll week) to per-directory grouping → per-trading-day TOTAL-volume winner (stable front-month tracking); added the `validateBar({...},{resSec})` guard as the first check in `bulkUpsert`'s clean filter (replacing the two inline ghost+off-grid checks). `validateBar` was already exported from `shared/bar-time.ts`.
- ADAPTATION (mw-reader.ts) — IMPORTANT: a1ce1f1's mw-reader is on the 06-13 base and does NOT have the July-1 60m `:00` standardization (`agg60mBucket`, the `:30`-purge DELETE, the `:00` comment blocks) — its 60m code inlines `Math.floor(t/3600)*3600`. The current branch's 60m handling is NEWER/correct (see the 2026-07-01 60m entry). So I deliberately DID NOT port a1ce1f1's 60m code, nor its `resSec = parseInt(...)` (current uses `|| 1` fallback), nor its extra `maxWickPct` block in bulkUpsert (the current branch deliberately removed that per 2026-06-26 "removed redundant per-wick filter"). Only the 3 named items were ported.
- **bar-time.ts + live-bars.ts (item 3, diff-and-unify):** OUTCOME = adopt NOTHING. The current branch (98494be) is a SUPERSET/refinement of a1ce1f1 for BOTH: (a) `validateBar` is functionally identical (same 5 rules, same defaults; a1ce1f1 only adds cosmetic exported `WritableBar`/`ValidateBarOpts` interfaces vs current's inline type + rule-numbered docs). (b) `live-bars.ts` — the current branch ALREADY calls `validateBar(..., {maxDeviation:0.05})` in both `persistBar` and `persistBulk` with the `(parseInt||5)` fallback and `h<=l` flat rejection; a1ce1f1's versions there are the OLDER inline variant. Porting a1ce1f1 into these two would REGRESS them, so left both untouched.
- VERIFICATION (real numbers): (1) `tsc --noEmit` EXIT 0 after every edit. (2) Offline harness (scratch, deleted) ran the ported chain over 5 crafted cases — (a) 2026-03-17 interleaved 15-bar (real ~6744-53 V640-1240, phantom ~6800-6852 V3-12): all 5 phantoms dropped, all 10 reals kept; (b) 2026-07-02 displaced body `C7563 V90` among ~7546-47: dropped; (c) V8200 +40pt breakout: kept; (d) 4h session-gap reopen +35pt sustained: all 7 kept; (e) 4-bar V0 run w/ trailing forming: 3 completed V0 dropped, forming kept — 9/9 PASS. (3) `sessionDayKey` units: 6:05pm EST→next day (2026-01-16), 5:55pm EST→same day (2026-01-15), 6:05pm EDT→next day (2026-07-16) — all PASS. (4) BASELINE: curled the running :3000 server (old July-1 filters) MES 1m=175569 / 5m=94396 bars, ran the July-2 chain offline over the SAME response → 1m removes 96 additional, 5m removes 140 additional.
- BYTE-PARITY PROOF: ran the a1ce1f1 ORIGINAL three functions verbatim over the identical baseline → 1m 96 / 5m 140 removed, EXACTLY matching my port. Confirms the port is faithful (not an integration artifact).
- OBSERVATION (reported, NOT "fixed" — no-redesign mandate): the July-2 `dropIsolatedSpikes` pairwise pass removes some HIGH-volume 5m bars, e.g. the 2025-10-10T15:00 selloff cluster (C6725.5 V74152 → C6722.5 V44174 → C6693.5 V51157, a real steep monotonic move where the windowed CONFIRMED-protection didn't fire for those bars). This is inherent a1ce1f1-verified behavior (reproduced identically by the original), so it was ported as-is. If it ever proves to be real-move collateral in practice, the fix belongs upstream in the algorithm, not in this port.
- Scratch verification files were written under the session scratchpad (NOT the repo) and deleted after. Working tree left uncommitted per instructions; only server/routes.ts + server/mw-reader.ts changed (plus this LEARNINGS entry).

**2026-07-08 — Hybrid restore: July-1 code (ccb75dc) + v2 SDK studies kept (branch `restore/jul1-plus-v2-studies`, commit 98494be)**
- USER DECISION: revert the program to the July 1 commit (`ccb75dc` — the pre-revert state with dropWickSpikes/validateBar/1m-crash-fix, also on GitHub as PR #2) but KEEP the current state of all MW studies. Between Jul 2 and Jul 8, another session had built branch `claude/historical-data-fetch-fix-j2sw91` (LiveBarRelay v2 with server-driven getBars backfill, SdkProbe, roll-heal.ts/gap-audit.ts) based on OLD origin/main, and had DELETED the 820MB data/app.db + all ~20 backups (fresh 4KB DB started Jul 5). Deleted DBs are likely still in the OneDrive online Recycle Bin (~30 days from Jul 5 → until ~Aug 4) — flagged to user.
- EXECUTION: stopped the in-flight Opus port subagent (its partial work stashed: `git stash list` → "partial filter port onto SDK branch"); new branch `restore/jul1-plus-v2-studies` at ccb75dc; `rm -rf mw-study && git checkout 50d82fd -- mw-study` to overlay the SDK branch's studies exactly (v2 LiveBarRelay.java, SdkProbe.java, UPGRADE_NOTES.md, updated TickRelay/AutoTrader, HistoryDumper.java deleted); committed as 98494be. Untracked-file checkout collisions (.claude/launch.json, shared/bar-time.ts) were safely deleted first (identical/canonical copies tracked in the target commits).
- COMPATIBILITY (verified in the v2 Java source, not assumed): v2 LiveBarRelay still sends live `tick` (L210) and `bar` (L316) messages the July-1 server handles; its `hello`/`bulk_bars`(id-tagged)/`backfill_done` protocol messages fall harmlessly through the July-1 server's if/else (inside try/catch). BUT v2 sends historical bulk_bars ONLY on server request — the July-1 server never requests, so NO study-driven history sync on this pairing. History instead rebuilt via July-1-era mechanisms: on first boot the mw-reader .bar_data1 disk ingest + Yahoo backfill produced 30,369 1m / 11,216 5m / 10,826 60m bars with the live edge current to the minute. `/api/mw/sync-status` stays "pending" forever on this pairing (cosmetic — it waits for unsolicited bulk_bars that v2 never sends).
- NUANCE (told to user): ccb75dc has the JULY-1 filter versions only. The July-2 improvements (dropCompletedGhostBars ghost-run drop, interleaved-phantom volume-clustering in dropIsolatedSpikes, low-vol tolerance tightening, sessionDayKey contract-roll fix) live in `a1ce1f1` (fix/candle-glitch-and-ingestion-guards) on the 06-13 base — they are NOT in this restored state and would need porting if the glitches they fixed reappear.
- Subagent model policy confirmed by user as correct (CLAUDE.md "Subagent Model Policy (permanent)": fable=problem-solving/strategy, sonnet=research/thinking, opus=coding/implementation) — also mirrored into auto-memory feedback_model_routing.md.

**2026-07-01 — GLITCH CANDLES still rendering on the BAXTER chart → root cause was a FILTER GAP (low-volume wick/body spikes); added `dropWickSpikes` permanent fallback**
- SYMPTOM: user screenshots showed "thin vertical line" glitch candles STILL on the live 5m chart (and repeated across history/intervals), despite the prior Yahoo repair. My earlier "they're hidden by the read filters" claim was WRONG for these.
- ROOT CAUSE: a whole GLITCH FAMILY evaded every existing filter. The `cached-continuous` chain (server/routes.ts) filters flat(`h=l`), off-grid(`ts%resSec`), `isSpikeBar` (absolute range/close > 2.5–7%), `isMarketClosed`, and `dropIsolatedSpikes` (displaced BODY only). A bar with a LONE displaced HIGH or LOW (a 20–200pt wick/body spike, low volume) passes ALL of them: its total range is below the absolute `isSpikeBar` threshold (40pt ≪ 4% of 7500 = 300pt), and `dropIsolatedSpikes` only tests the body (low>both closes / high<both closes), not a single wick. e.g. `MES 5m 2026-06-08 12:15 H7540.5 body0.5 V19`, `2026-06-30 09:40 H7505 V0`, `2026-06-01 01:00 H7675 L7468 V29`.
- KEY (same as the repair session): VOLUME is the discriminator. True glitches are near-zero volume; real news/settlement moves are V400+. A neighbour-relative scan alone is CONTAMINATED with real bars (V48118 FOMC, V8408 gap, V43453) — must gate on volume.
- FIX (permanent fallback, non-destructive, honors never-delete): added `dropWickSpikes()` in `server/routes.ts` (right after `dropIsolatedSpikes`, ~line 231) and applied it in BOTH serving paths — the DB path (wraps the filter chain, BEFORE the 15m aggregation so a glitchy 5m wick can't corrupt aggregated 15m high/low) and `memBarsToCandles`. Logic: for bars with `volume < volMin(=100)`, drop if `high - max(adjNeighbourHighs) > tol` OR `min(adjNeighbourLows) - low > tol`, `tol = max(10pt, 0.12%*close)`, neighbours must be temporally adjacent (`≤ interval*3`), left-neighbours use last-KEPT bars, iterate up to 4 passes. Bars with `volume ≥ 100` are ALWAYS kept (real moves preserved).
- VERIFIED: tsc EXIT 0. Offline sim across all MES intervals: dropped 1m=2425 / 5m=619 / 15m=0 / 60m=31 glitches, and **maxVol among ALL dropped bars = 99/96/–/85 (< 100)** → ZERO real-bar collateral. Live endpoint after restart: the 4 circled glitch timestamps ABSENT, the 3 real high-vol bars PRESENT. Browser screenshot: chart renders clean, no vertical-line spikes.
- COVERAGE: one server-side filter covers EVERY consumer — web terminal, mobile app, and the market.tsx engine all fetch `/api/data/cached-continuous`, so all intervals/all symbols are sanitized at serve time regardless of what's in the DB. This is the durable "always-there fallback" the user asked for. `routes.ts` is NOT StrategyGuard-protected (guard only covers `strategies/*.json`), so no re-hash needed.
- STILL OPEN (optional): the underlying rows remain in the DB (never-delete). An active INGESTION leak is still WRITING fresh off-grid V0 15m bars (mw-reader/live-bars) — a write-time guard would be belt-and-suspenders but the read filter already guarantees they never render.

**2026-07-01 — Historical false-candle SURGICAL repair (MES, repair-only/never-delete) — 156 bars fixed from Yahoo**
- USER TASK: find & fix false/ghost/no-body candles across ALL historical data. USER DECISIONS (AskUserQuestion): (a) fix method = REPAIR ONLY, NEVER DELETE (overwrite reachable bars from Yahoo, leave older defects in place); (b) scope = MES only; (c) fix flat/off-grid/weekend auto but SHOW the ghost list first.
- CRITICAL FINDING — the ghost/spike detector (`dropIsolatedSpikes`, routes.ts:185) is CONTAMINATED with REAL bars when used as a flat "these are all false" list. It flagged genuine high-volume news bars (MES 5m 2025-10-12/13 cluster V1500–2100; 60m 2026-03-20 19:00 V361,655; 2026-04-20 15:00 V196,347) AND even FLAT `h=l` bars that are REAL quarterly triple-witching SETTLEMENT prints (60m 2024-09-20/2024-12-20/2025-06-20 20:00–21:00 UTC, V1.4M–2.1M). RULE: VOLUME is the reliable discriminator — true phantoms are LOW volume (V0–~75); real settlement/news bars are V800+. Only repair the low-vol subset (`volume<100`). NEVER treat the raw spike-filter output as a delete list (it's designed to run reversibly at read time on a rendered window).
- DB REALITY: prior cleanups left it mostly clean — malformed(h<l)=0, non-positive=0, ALL 1m clean. Remaining defects were modest: MES 5m/15m/60m flat 5/5/14, off-grid 5/5/17, + low-vol ghost phantoms (5m ~160 reachable, 60m ~17 reachable, 1m/15m ~0).
- MECHANISM: surgical Yahoo overwrite. `new YahooFinance({suppressNotices:['yahooSurvey']})` (v3.13.2 — must instantiate, NOT `yahooFinance.chart` directly like v2). Windows must stay JUST INSIDE Yahoo limits: 5m ≤ 59d (60d boundary is REJECTED as "must be within last 60 days"), 60m ≤ 725d. Fetched ES=F, matched by exact unix timestamp, overwrote OHLC only where Yahoo had a real (`high>low`) bar within ±5% of a DB neighbour close. LEFT VOLUME UNTOUCHED (ES-scale volume must not overwrite MES-scale rows). Targets = reachable && on-grid (`ts%sec===0`) && `volume<100` && (`h=l` OR ghost).
- RESULT: 183 targets → 156 repaired (5m 144/160, 60m 12/23); 16 left (Yahoo lacked the overnight bar), 6 skipped-unsafe (Yahoo also flat / failed ±5%), 5 no-op (already matched Yahoo = real bars the filter over-flagged). Verified: low-vol phantom ghosts 5m 160→16, 60m 17→5 (remainder = unreachable, still hidden by read filters). 0 malformed introduced. NOTHING deleted.
- OFF-GRID CAVEAT: under never-delete, off-grid bars (wrong timestamp) CANNOT be repaired in place — Yahoo overwrite writes to the ALIGNED timestamp, so the off-grid phantom row remains (harmless — read filters drop it). Flat counts (5m=5 off-grid, 60m=14) therefore unchanged; those are off-grid or Yahoo-also-flat.
- 1m + 15m (ran on user request): 0 repairable targets within Yahoo reach. 1m — only 4 reachable ghost bars, ALL real high-vol news (V2845–7046), and older 1m phantoms are beyond Yahoo's ~7d 1m limit (unrepairable). 15m — 0 ghosts; the only reachable false candles are 6 OFF-GRID V0 no-body bars (ts%900 = 503/521/790/535/525/572), ALL fresh 2026-06-30/07-01 → a LIVE ingestion path is still writing off-grid 15m V0 rows (like the flat-candle ingestion leak noted elsewhere; suspects mw-reader/live-bars 15m bucket write). Deletion is the ONLY fix for off-grid rows; USER CHOSE to LEAVE them (keep never-delete) — they're read-filtered/hidden so harmless. If ever revisited: delete `WHERE timestamp % resSec <> 0` per res, and trace the 15m off-grid writer.
- SAFETY: backed up first via `VACUUM INTO data/app.db.backup-false-candle-repair-2026-07-01` (818MB) BEFORE any write. Repair script ran against the LIVE db while the server held it open (WAL, single-writer — fine). Server continuous-cache won't reflect changes until restart, but since these bars are already read-filtered, the visible chart is unchanged either way. ESM scripts can't use NODE_PATH — must live inside the project dir (or use tsx) to resolve node_modules.

**2026-07-01 — MERIDIAN firing rebuild: STEP 1 ground-truth confirmed + Phase-0 extraction slice 1 (foundation only)**
- The rebuild prompt's architecture is LARGELY FALSE for this repo (confirmed the prior session's finding + went deeper): (1) NO Node matcher — the live signal engine is CLIENT-side `client/src/pages/market.tsx` `allConfluenceSignals` useMemo (~2547–3088); (2) `grep server/` for hurst/regime/mfdfa = 0 hits → NO live DFA-Hurst gate, NO live MFDFA/Δα service (the fractal libs are client, DISPLAY-ONLY); (3) `scripts/monte_carlo_exits.py` is a GRID-SEARCH maximizing expected R (prompt FORBIDS this) AND targets PostgreSQL while the app is SQLite → unusable as a base; (4) NO news-flat logic (only a `Newspaper` icon for the ticker UI); (5) NO explicit ATR-14 stop-floor formula (only `ATR_PERIOD=14`, `SL_ATR_MULT=0.5` for the legacy VEC signal). Port default = 3000 (`server/index.ts:124`). No PM2 ecosystem config tracked.
- KEY CORRECTION to the divergence list: the confluence FIRING is ALREADY single-tier. `market.tsx:2887–2901`/`3010–3020` fire only when `totalPts>=4 || fpOnMilkZone || fpPartialOnZone` and hardcode `riskLevel:"safe"`. Tiers (`safeplus/risky/riskiest`) survive ONLY in the exit table `EXIT_STRATEGY_PROFILES` (:278), UI colors, and the vector side-entry path (`:2823`, emits `"risky"`). The `4/3/2/1`-style weighted scoring IS the live fire-gate (fpPts=4/milkPts≤4/vecPts=2). Pattern/matrix-profile = absent from firing (only a doc folder + vestigial `patternBars` column).
- USER DECISIONS (via AskUserQuestion, all "do what you recommend"): (a) architecture = extract a framework-agnostic `shared/firing/` module reused by live engine + a headless Node backtest harness (NOT a server rewrite); (b) regime compute = TS-native (port `hurst.ts`/`multifractal.ts`, no new Python process); (c) cadence = checkpoint after the extraction, pause for review before the money-path rewire.
- DELIVERED this session (SAFE, non-destructive): `shared/firing/{constants,session,vector,types}.ts` + `README.md` — faithful VERBATIM copies of the firing constants / session helpers / vector math / types, as the single source of truth for both live engine and harness. **`market.tsx` deliberately NOT touched** → live engine byte-for-byte identical. `npx tsc --noEmit` EXIT 0. Extraction plan (slices 2–5) + the pure `computeConfluenceSignals(ctx)` signature (lock Maps passed BY REFERENCE to preserve mutation/lock semantics) are in the module README + `docs/MERIDIAN_TRADING_LOGIC.md` §5b.
- HARD GATE reminder for next session: Build → backtest → report → STOP for user approval. All new behavior behind flags default `false`. No live-behavior change until the one-month A/B backtest is approved. Do NOT touch the Portfolio/stock side (out of scope). StrategyGuard: re-hash any protected file touched (none touched yet — `market.tsx` and `strategies/*` untouched this slice).

**2026-07-01 — 60m standardized on :00 top-of-hour (prior :30 note was WRONG about Yahoo)**
- ROOT CAUSE: 60m bars were stored at TWO conflicting alignments. Yahoo ES=F 60m is `:00` top-of-hour (EMPIRICALLY VERIFIED: `yahooFinance.chart(ES=F,60m)` returns 22:00/23:00/00:00… UTC, 590/591 at :00) — NOT :30. But a prior session set the MW pipeline (`agg60mBucket`, `get60mBucket`, `notifyExternalTick`) to `:30` on the mistaken belief (see the now-corrected note below) that "Yahoo + LiveBarRelay use :30." Result: Yahoo wrote 7,589 `:00` MES bars (the deep 2yr history) while MW wrote 1,043 `:30` bars, and the serving filter `timestamp % 3600 === 0` at `routes.ts:903` SILENTLY DROPPED every :30 bar → live 60m vanished on reload + 30-min live-edge misalignment.
- DECISION (user): standardize on `:00` — it's where the deep Yahoo history lives, it's the standard convention, and the serving filter already keeps it. Tradeoff accepted: a 60m bar spans 9:00–10:00 (straddles the 9:30 RTH open) rather than RTH-aligned.
- CHANGES: (1) `mw-reader.ts agg60mBucket()` → `Math.floor(t/3600)*3600`. (2) `mw-reader.ts` startup purge INVERTED — now deletes `:30` rows (`% 3600 === 1800`), keeps `:00` (was deleting :00!). (3) `client/src/lib/trading-utils.ts get60mBucket()` → `:00`. (4) `DayTrading/lib/candles.ts aggToInterval` OFFSET→0.
- DATA REPAIR: MES 60m `:00` (Yahoo) had stopped at 2025-11-03 — recent MES 60m lived ONLY in the :30 bars. After deleting :30, re-ran `POST /api/data/yahoo-backfill {symbol:MES}` (Yahoo has ES=F 60m through today) → MES 60m :00 now continuous 2024-07-11 .. 2026-07-01, 11,306 served, all :00, 0 flat, 0 off-grid. ES likewise reaches current.
- CLEANUP: `VACUUM INTO data/app.db.backup-60m-align-2026-07-01T09-06-33`, deleted 1,068 `:30` rows. NOTE: the still-running old-code server keeps writing :30 until RESTART; those transient :30 rows are read-filtered and purged by the inverted startup DELETE on next boot.
- CORRECTION to the 2026-06-?? "60m duplicate bars" entry further down: its claim "Yahoo Finance and LiveBarRelay produce bars at RTH-aligned :30 boundaries" is FALSE for Yahoo (Yahoo=:00). That entry's :30 fix was the source of this bug.

**2026-06-30 — Flat-candle INGESTION leak closed in the LiveBarRelay path (5m/15m/60m)**
- Last session's `h===l` fix was only at the SERVING/read layer + a one-time DB delete. Flat bars kept re-entering the DB because the LiveBarRelay write path never rejected them. Audit found 93 NEW flat rows since the cleanup: MES15=23, ES60=20, MES5=18, MES60=16, ES5=9, ES15=7 — and **res=1 had ZERO** (the tick path `bulkUpsert` in `mw-reader.ts:824` already rejects `high<=low`). That split (0 on 1m, all on 5/15/60) localized the leak precisely to LiveBarRelay.
- ROOT CAUSE: `server/live-bars.ts` `persistBar` (~515) and the `bulk_bars` validator (~344) used `high < low`, which PASSES `high === low` (flat/no-range candles). FIX: changed both to `high <= low`. Left the `type:"bar"` broadcast guard (~263) at `<` on purpose — a FORMING bar (`complete:false`) is legitimately flat the instant a new candle opens; only completed/persisted bars must be non-flat.
- WHY removing flat bars never breaks continuity (user's "next candle opens at prev body" rule): a flat bar has open==close==price, so deleting it leaves prev.close == next.open at the same price — neighbours stay connected. Proven safe.
- DB CLEANUP: `VACUUM INTO data/app.db.backup-flat-clean-2026-06-30T10-36-17`, then `DELETE FROM cached_candles WHERE high = low` (93 rows). tsc clean. 1m path needed no change.
- HISTORICAL DATA REALITY CHECK (Yahoo): probed `yahooFinance.chart(ES=F, since 2000)` per interval — 1m ERRORS ("Only 8 days of 1m granularity allowed", and even 35d fails; only ~last 7d works), 5m/15m capped 60d, 60m capped 730d, ONLY 1d/1wk/1mo reach 2000 (1d=6552 bars back to 2000-09-18). So "1m back to 2000" is IMPOSSIBLE from Yahoo and CANNOT be derived from monthly (aggregation is fine→coarse only). Deep intraday requires a paid vendor file (FirstRate Data ~2008, Kibot, Databento 2010+) imported via `/api/data/import-csv`. ES e-mini itself only began Sept 1997.

**2026-06-27 — Chart accuracy pass: all 4 intervals (1m/5m/15m/60m) verified clean first-to-last**
- AUDITED `cached_candles` for MES across res 1/5/15/60 over the full range. Defect types & counts (raw DB): isolated spikes (1m 4820, 5m 1885, 60m 788), market-closed bars (1m 377, 5m 324), zero-range no-body (5m 16, 15m 21, 60m 8), zero-range WITH volume (60m 7 — leaked!), off-grid (60m 940).
- KEY FINDING #1 — the only actual READ leak: zero-range filter was `!(h===l && !volume)`, so flat bars WITH volume (7 on 60m) rendered as no-body candles. FIX: drop ALL `h===l` (no real MES bar is perfectly flat). Applied in both the DB path and `memBarsToCandles`.
- KEY FINDING #2 — 60m "off-grid" 940 bars are NOT all artifacts: ~129 at :30 are real (half-day RTH bars like Black Friday 09:30–12:30 w/ 100k+ vol). But 806 at :30 are PHANTOMS (wrong-contract, ~50–190pt off, low vol, e.g. 04:30 @7625 vs real ~7477). The `%3600===0` off-grid filter correctly drops them; verified before deleting so as not to lose real history.
- KEY FINDING #3 — interleaved phantoms leaked through `dropIsolatedSpikes`: a wrong-contract feed bled in on ALTERNATE 1m bars (10:00 @6852 / 10:01 @6798 / 10:02 @6848, real ~6750, vol 2–110). The inner phantom is shielded because its NEXT bar is also a phantom (not isolated on that side in one pass). FIX: rewrote `dropIsolatedSpikes` to (a) ITERATE until stable (outer phantoms removed → inner becomes isolated next pass), (b) be TIME-GAP aware — only treat a price-displaced bar as a spike when neighbours are temporally adjacent (≤3 intervals); a lone overnight bar whose neighbours are hours away is normal drift, NOT a spike, and must be kept, (c) validate the FIRST/LAST bar of a served window so a phantom at a pagination boundary can't leak.
- DB CLEANUP: backed up to `data/app.db.backup-pre-candle-clean-2026-06-27T15-56-31`, then permanently deleted 874 UNAMBIGUOUS garbage rows (malformed + zero-range h==l + market-closed) across all symbols. Did NOT permanently delete off-grid/spikes (heuristic/edge — handled reversibly at read time).
- VERIFIED: simulated the exact serving chain AND hit the live `/api/data/cached-continuous/MES/{iv}` endpoint — 1m=182685, 5m=102172, 15m=85294, 60m=11329 candles, ZERO zeroRange/offGrid/marketClosed/malformed/spike/isolated-spike across every candle.
- Filters live in `server/routes.ts`: `isMarketClosed` (~170), `dropIsolatedSpikes` (~185, now iterative+time-gap), the DB serving chain (~872) and `memBarsToCandles` (~841). Server must be restarted to pick up changes (clears the continuous cache). Confidence: high (live-endpoint verified).

**2026-06-26 — AutoTrader missing in MW = duplicate jars in BACKUP SUBFOLDERS inside the Extensions scan path (+ corrects a prior misdiagnosis)**
- SYMPTOM: after a new-laptop migration, AutoTrader would not appear in MotiveWave. User confirmed it worked perfectly before (it was always `strategy=true`, added via **Add Study**).
- ROOT CAUSE: `C:\Users\Jackson\MotiveWave Extensions\` contained TWO backup subfolders (`backup-pre-restore-20260626\`, `backup-studies-20260625\`), EACH holding a full set of the 4 study jars. **MotiveWave scans the Extensions folder recursively**, so it loaded `com.custom.AutoTrader` 2–3× → duplicate-class conflict → MW silently dropped AutoTrader. PROOF: with MW running, those backup-folder jars were file-locked by `MotiveWave.exe` — confirming MW had them open.
- NOTE on the 2026-06-25 entry below: it was PARTLY right and PARTLY wrong. RIGHT: `strategy=true` keeps it out of the normal "Add Study"/"All Studies" list. WRONG/incomplete: it isn't under a "Strategies" menu either — with no `menu` attribute it's nowhere. The duplicate classes were a SEPARATE, real problem (fixed above). The actual add path is `menu="Custom"` → **Study → Custom** (see FIX 2 below). The build.bat "Add Study → Auto Trader" instruction text is wrong; ignore it.
- FIX: moved BOTH backup subfolders out to `C:\Users\Jackson\MW-Extensions-Backups\` (outside MW's scan path). Had to terminate a leftover `MotiveWave.exe` launcher (PID held jar locks even after the UI closed; the main JVM had already exited). Left the VS Code redhat.java `java.exe` language-server process ALONE (not MotiveWave). Verified: Extensions has exactly 4 top-level jars, `jar tf` shows zero duplicate `com/custom/*.class` across them.
- RULE: NEVER place jar backups inside `MotiveWave Extensions\` — MW recurses. Back up to a sibling dir. To finish jar moves, MW must be FULLY closed (watch for the lingering `MotiveWave.exe` launcher after the window closes — it keeps jars locked).
- SECOND ROOT CAUSE (the real blocker, found after de-dup): a `strategy=true` study is EXCLUDED from the "All Studies" dialog (Ctrl+T; its Type filter is only All/Overlay/Signal — no "Strategy"), AND our `@StudyHeader`s have NO `menu` attribute, so AutoTrader had NO entry point ANYWHERE. Plain studies w/o `menu` still appear in All Studies (that's how TickRelay/LiveBarRelay get added); a STRATEGY w/o `menu` appears nowhere. The MW SDK example studies (Delta MA, MA High Low, Wallaby…) show under **Study → Custom** because they declare `menu="Custom"`.
- FIX 2: added `menu = "Custom"` to AutoTrader's `@StudyHeader` (valid field — test-compiled EXIT=0 vs the v70 SDK w/ JDK 25). Rebuilt AutoTrader.jar 14189→14199 bytes, installed. AutoTrader now appears under **Study → Custom**, NOT "Add Study". (`menu` is the way to make any custom study/strategy discoverable in the Study menu.)
- EDITION NOTE: license is `ORDER_FLOW` (MW log: `License Edition: ORDER_FLOW`). MW marketing implies strategy backtest/optimize is Professional+, but the user confirms this exact Order Flow + Apex setup ran AutoTrader live before — so running a custom strategy is NOT edition-gated here; the missing `menu` entry point was the whole problem. Also in log: Rithmic `permission denied` for get_order_book on ES (L2 depth perm) — watch order-routing perms when it fires.
- RESTORE STEPS for user: reopen MW → menu bar **Study → Custom → AutoTrader** (click to add). Server (`npm run dev`, port 5000 listener) must be running so AutoTrader's `/ws/order-commands` WebSocket reconnects; confirm `WS connected` in `~/autotrader_log.txt`.

**2026-06-25 — MW studies fixed (duplicate-class + strategy=true) + chart "no-body dash" candles (off-grid/V0 bars)**
- WHY AutoTrader + HistoryDumper didn't show in MW's "Add Study" list — TWO different causes:
  (1) HistoryDumper's class `com.custom.HistoryDumper` was in TWO jars at once — bundled inside
  `LiveBarRelay.jar` (build.bat compiled `LiveBarRelay.java HistoryDumper.java` together) AND in
  standalone `HistoryDumper.jar`. MW registered study id `HISTORY_DUMPER` twice → dropped it.
  (2) AutoTrader's `@StudyHeader` has `strategy = true` → MW registers it under **Strategies**, NOT
  "Add Study". It was never broken — you add it via the chart's Strategy mechanism. (An order-placing
  component MUST be `strategy=true` to trade, so leave it.)
- FIX: rebuilt each study into its OWN jar (no bundling) with the now-installed JDK 25. Verified zero
  duplicate classes across the 4 installed jars + `@StudyHeader` retained in bytecode (javap). De-bundled
  build.bat (`LiveBarRelay.java` ALONE) + added a JDK-26-preferred search block. Also fixed a stale
  `import com.motivewave.platform.sdk.study.DataContext` in TickRelay.java (DataContext moved to
  `...sdk.common`; the wildcard already covers it) that broke its compile.
- COMPILE FACTS: MW SDK is class v70 (Java 26). JDK 25's javac compiles against it FINE — only emits a
  harmless `major version 70 is newer than 69` warning, exit 0, output classes are v61/Java17 (load fine
  in MW's Java-26 runtime). So JDK 26 is NOT required to build; JDK 25 works. JDK at
  `C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot`. SDK at `C:\Program Files (x86)\MotiveWave\lib\mwave_sdk.jar`.
  Can't launch MW to confirm the list — verified structurally only (the user restarts MW to reload Extensions).
- CHART "false no-body candles" = zero-range dash bars (`O==H==L==C`). Two kinds, both removed: (a) ~310
  OFF-GRID bars whose timestamp wasn't on the resolution boundary (`timestamp % resSec != 0`, e.g. 13:15:34,
  V0) — foreign-source single prints; (b) 11 on-grid but `V0` zero-range flat bars. Fix = read filters in
  `cached-continuous` (`timestamp % resSec === 0` AND drop `high===low && !volume`) PLUS a permanent DB
  delete of the 310 off-grid rows. NOTE: real dojis (`open===close` but `high!==low`, with a wick) are
  KEPT — only zero-RANGE dashes are noise. Verified served MES 5m: 0 zero-range, 0 off-grid.
- Yahoo fetch is fine as-is (`yahoo-finance2` `chart()`, MES→ES=F); the no-body bars were never Yahoo's
  (Yahoo bars are bucket-aligned) — they were foreign rows the `onConflictDoUpdate` overwrite couldn't
  touch (different timestamps), which is why the bucket-grid filter, not a re-fetch, was the real fix.
- `tsc` clean. DB backed up to `data/app.db.backup-pre-nobody-cleanup-20260625`; old study jars to
  `MotiveWave Extensions/backup-studies-20260625`. Confidence: high (de-spike/no-body verified; MW study
  list not visually confirmed — structural only).

**2026-06-26 — "Bugged throughout" = interleaved phantom bars; de-spike filter + Yahoo overwrite; studies blocked; rebuild Step 1**
- ROOT CAUSE of the whole-history "bugged" chart: ~4,855 intrabar jumps >40pt across the MES 5m history, in spike-and-RETURN pairs (close 6703 → bar `O6755 C6754 V2` → back to 6704). i.e. isolated phantom bars ~50pt off the real level with tiny volume (V2), almost certainly a wrong-contract/bad-source print normalized to `MES`. THEY PASS `isSpikeBar` because their own H-L range is tiny — the displacement is only visible RELATIVE TO NEIGHBOURS. Fix: `dropIsolatedSpikes()` in routes.ts — drop a bar whose whole body is > fracThr (0.25%) from BOTH the last-kept bar's close AND the next bar's close (compare to last KEPT, not raw prev, so phantom runs don't anchor each other). Applied in both serving paths of `cached-continuous`. Verified: served jumps 4855→990, and the 990 remaining are REAL high-volume news moves (Jan-10 jobs V28749, Apr-2 tariffs V52062) correctly preserved — the round-trip+two-sided test never flags a one-directional real gap.
- Yahoo IS authoritative now ON REQUEST: `yahooBackfillSymbol(sym, overwrite)` — default false keeps `onConflictDoNothing` (auto-startup never clobbers live MW relay) but `overwrite:true` uses `onConflictDoUpdate` (target sym/res/ts, `set excluded.*`) so Yahoo repairs corrupt bars. `/api/data/yahoo-backfill` takes `{overwrite:true}`. Ran it for MES. HARD LIMIT: Yahoo ES=F intraday is 60d for 5m/15m, ~720d for 60m — it CANNOT overwrite 5m older than 60d (92k of 103k MES 5m bars are beyond reach), which is exactly why the read-side `dropIsolatedSpikes` (works on ALL history, no source needed) is the real fix, not the overwrite.
- Removed the floating ProbabilityPanel (overlapped the Strategies dropdown). The probability concepts now live ONLY as the individual on-chart overlays — removed the render + import from terminal.tsx (kept the component file).
- STUDIES are un-fixable from here right now: (1) NO JDK installed at all (`javac` absent, no Adoptium/Java dirs) and the MW SDK is class v70 = JAVA 26, so the studies CANNOT be recompiled — any `.java` edit is dead until JDK 26 (Temurin 26) is installed; (2) both AutoTrader + HistoryDumper are blocked anyway by MW's "Market Data Connection Not Available" (MW⇄Rithmic, user-side) — no data to relay/dump. AutoTrader places orders via REFLECTION on the MW SDK (`createMarketOrder(2)`, `submitOrders`) so the Java-26 SDK update is a prime suspect for it breaking, but that's unverifiable without JDK 26 + live MW + real-order risk. Reported instead of shipping un-compilable edits.
- REBUILD STEP 1 started → `docs/MERIDIAN_TRADING_LOGIC.md` (ground-truth map, NO behavior change). BIG finding: the prompt's premise that "a DFA-Hurst regime gate is live inline in the Node matcher" is FALSE here — `grep server/` for hurst/regime/mfdfa = 0 hits; the engine is CLIENT-side `client/src/pages/market.tsx` (6,378 lines) and the fractal code is the display-only client libs. Tiers (`safeplus/safe/risky/riskiest`) + `RISK_QUALITY 4/3/2/1` (market.tsx:104) are STILL LIVE (prompt says retired). Pattern/matrix-profile already absent from live firing (only a `strategies/pattern-recognition/` doc folder + vestigial `signal_history.patternBars`). Did NOT touch firing; flagged architecture questions for the user before Phase 0.
- `tsc` clean; DB backed up to `data/app.db.backup-pre-yahoo-overwrite-20260626` before the overwrite. Confidence: high on de-spike (verified) + studies diagnosis; MEDIUM on overlay visual (per prior entry).

**2026-06-26 — Interval data accuracy fixes (60m alignment + 15m fallback + spike thresholds)**
- ROOT CAUSE of 60m duplicate bars: `mw-reader.ts aggregate()` was using `Math.floor(timeSec / 3600) * 3600` (UTC :00 boundaries like 13:00, 14:00 UTC) while Yahoo Finance and LiveBarRelay produce bars at RTH-aligned :30 boundaries (13:30, 14:30 UTC = 9:30 ET open). These wrote as separate DB rows, producing two 60m bars per period on the chart. The client-side `trading-utils.ts` `get60mBucket()` already had the correct `Math.floor((ts - 1800) / 3600) * 3600 + 1800` formula — the server just wasn't matching it.
- FIX: added `agg60mBucket()` helper in `mw-reader.ts` mirroring `get60mBucket()`, applied in `aggregate()` for periodMin===60, in `applyTick()`, and in `notifyExternalTick()`. Added a one-time SQL `DELETE FROM cached_candles WHERE symbol=? AND resolution='60' AND (timestamp % 3600) = 0` in `loadMultiDir` to purge stale :00-UTC rows already in the DB. Yahoo/LiveBarRelay bars at :30 are unaffected (`1800 % 3600 = 1800 ≠ 0`).
- ROOT CAUSE of 15m fallback bad data: when native 15m bars were absent and `cached-continuous` fell back to resolution "5", it returned raw 5m bars for a 15m chart request. The client's `isAligned("15m")` kept ONLY bars at 15m boundaries (the first 5m sub-bar of each 15m period) — wrong OHLCV values. FIX: added server-side aggregation in routes.ts `cached-continuous`: when `interval === "15m" && usedRes === "5"`, bucket by `Math.floor(timestamp / 900) * 900` and merge OHLCV (first open, max high, min low, last close, sum volume). Applied to both the DB path and the memory fallback path.
- `isSpikeBar` thresholds were too tight (`1m=0.5%, 5m=1.0%, 15m=1.5%, 60m=2.5%`) — real news bars (flash crashes, FOMC moves) were filtered. Float32 corruptions are 10x+ off from real price (~512, 8192 instead of ~5800), so safe thresholds are much higher. Raised to `1m=2.5%, 5m=4.0%, 15m=5.0%, 60m=7.0%`. Removed the doji-spike check (`body/range < 0.05`) that was incorrectly filtering valid doji candles.
- Removed redundant per-wick filter from `bulkUpsert` in `mw-reader.ts` (lines that checked `lowerWick/close > maxWickPct`). The existing 5% range check and the doji-wick body-ratio check already catch float32 corruptions; the wick check was mathematically dominated and only removed valid extreme-wick bars (pin bars, hammers, shooting stars).
- RULE: 60m bucket must ALWAYS use the RTH :30 offset (`Math.floor((t - 1800) / 3600) * 3600 + 1800`) on BOTH client and server. Any new server code touching 60m timestamps must use `agg60mBucket()` not `Math.floor(t / 3600) * 3600`.
- `tsc` clean. Confidence: high.

**2026-06-26 — Chart phantom-bar fix (market-closed filter) + individual on-chart probability overlays**
- "Completely bugged" chart = NOT spike bars (recent window had 0) but PHANTOM market-closed bars: 6 low-volume Saturday bars (Jun 20, futures shut) at ~4.75h spacing, each isolated between gaps → render as "thin vertical line" spikes. Root cause: `/api/data/cached-continuous` filtered `isSpikeBar` but had NO weekend/maintenance filter. Fix: added `isMarketClosed(sec)` (Sat all day; Fri ≥17:00 ET; Sun <18:00 ET; Mon–Thu 17:00–18:00 maintenance) using the existing `etOffsetMin` DST helper, applied in BOTH serving paths (DB rows + `memBarsToCandles`). Verified: served Saturday bars 6→0, total 103536→103231. Read-only filter — does NOT mutate the DB.
- GOTCHA that wasted a cycle: a STALE `tsx server/index.ts` from a prior background run was still bound to :3000 and served OLD code, so my first verify showed the filter "not working." ALWAYS `Get-Process node | Stop-Process -Force` + confirm `:3000` free before re-testing a server change, or you test the wrong process.
- Yahoo IS the working historical source (MES→ES=F map, same index price). Verified live: `yahooFinance.chart("ES=F",{interval:"5m"})` returns ~11k valid bars (of ~14k quotes — `mapQuotes` already drops the ~2.9k null-OHLC rows). Backfill auto-runs on startup (`onConflictDoNothing`). BUT Yahoo ES=F intraday is inherently gappy overnight/holidays (Jun 19 Juneteenth) — re-running the backfill did NOT fill those gaps because Yahoo simply lacks those bars. Truly gap-free data needs MW's Rithmic feed. The MW dialog "Market Data Connection Not Available" is a MotiveWave⇄broker problem (user-side), not our code — the studies can only relay what MW itself has.
- Probability concepts now render INDIVIDUALLY on the chart, not just the text panel. Added 4 sub-toggles to `StrategyToggles` (`probValueArea`/`probRegime`/`probForecast`/`probScaler`, default true, shown as sub-rows under the Probability master in the Strategies dropdown). Drawn on a SEPARATE `probCanvasRef` canvas (zIndex 4, above footprint's zIndex 3) — never touches the candle/vector series, so it can't destabilize the chart. `drawProbability()` mirrors `drawFootprint`'s dpr/clear/`timeToCoordinate`/`priceToCoordinate` pattern + a pxPerSec estimator for FUTURE-time X (the forecast cone). Snapshot computed via `computeProbabilitySnapshot` keyed on `barSig` (the 80×DFA regimeStrip cost only runs on a new bar); sub-flag toggles redraw without recompute. Wired redraw into the visible-range-change sub + the ResizeObserver.
- `lib/probability.ts` gained `regimeStrip` (sampled regime over time, mirrors mobile) for the bottom ribbon. `tsc` clean; all modules transform HTTP 200.
- DEFERRED (correctly, not skipped): the big MERIDIAN firing-logic rebuild prompt is explicitly backtest-gated + "STOP for approval" + "once done with everything else." Did NOT touch live firing or the Signals-tab signal set (its Phase 2 owns that). Next session starts at its STEP 1 ground-truth map (`docs/MERIDIAN_TRADING_LOGIC.md`), no behavior change, flags default false.
- Confidence: high on the data/filter fix (verified) + overlay compile/transform; MEDIUM on the on-chart overlay VISUAL placement (not seen rendered live — geometry mirrors the proven footprint canvas).

**2026-06-26 — Cross-machine transfer recovery + probability concept wired into the terminal**
- Context: a PC→PC transfer dropped ~0.4 GB. Two distinct losses: (1) `node_modules` (fixed: `npm install` + `npm approve-scripts better-sqlite3 bufferutil esbuild` to build native addons — `better_sqlite3.node` must exist), and (2) **372 tracked files** deleted from the working tree (all 47 shadcn `ui/*`, the whole `terminal/` + `portfolio/` view layer, iOS, MW `.class`). Restored exactly with `git ls-files --deleted -z | xargs -0 git checkout HEAD --`. Left the 5 MODIFIED files alone (`data/app.db*` live DB + `package.json`/`-lock`) — never revert those.
- KEY: "restore to N days ago" was NOT possible. Latest commit `3b357db` (06-24) is where the working tree already sat after the deleted-file restore; no stash, no dangling commits (`git reflog`/`fsck` clean), and `FULL_SOURCE_CODE.txt` is an APRIL-17 dump, not recent. So the fractal probability libs (`client/src/lib/{hurst,ergodic,multifractal,fbm,hurstScaler}.ts`) and `DayTrading/lib/probability.ts` are **untracked working files that were never committed** — git could not recover the wiring; it had to be rebuilt forward. Lesson: those libs are `??` untracked — commit them or they're one bad sync from gone.
- The fractal libs were orphaned: present on disk, `import`ed by NOTHING in `client/`. Their own headers say DISPLAY-ONLY / "shown in the Info tab" / regime FILTER never a trigger. Wired them in WITHOUT touching the fragile chart: new `client/src/lib/probability.ts` (snapshot read-model) + floating `ProbabilityPanel.tsx` (mirrors `FootprintPanel` — separate component, NOT a chart series/canvas, so zero risk to candle rendering) gated on a new `Probability` `StrategyToggles` key (mwb mirror `showProbability`). Added a `STRATS` entry (auto-renders the dropdown toggle + Info card + market strip), `strategies/probability/{strategy.json,STRATEGY.md}` (strategy-guard now guards 7, loads clean), and a STRATEGIES.md §8b. New floating panel needed `.tt-floating .tt-prob{ pointer-events:auto }` (allowlist passthrough rule) + a non-colliding slot (footprint=left, clock=bottom-right → probability=top-right).
- Chart false-candles/gaps were NOT a code regression: server `isSpikeBar` (routes.ts:768, 3 call sites) + client `badBar`/`spikeThr` + `lastCloseRef` tick-clamp (useTerminalData.ts) are all intact. Root cause = sparse MW history on the new PC (`historical_data\RITHMIC` had ~16 bar files; logs full of "Gap … no bar data available"). Real fix is repopulating via the MW HistoryDumper study, not code.
- MW studies: the 4 jars live in `%USERPROFILE%\MotiveWave Extensions` (build.bat DEST). Reinstalled the newer `mw-study/*.jar` (same compiled classes, just repackaged) over the older installed set with a backup; did NOT recompile (would need JDK 26 for MW's Java-26 SDK). Studies connect to `ws://localhost:5000/ws/mw-feed` (LiveBarRelay/TickRelay) and `:5000/ws/order-commands` (AutoTrader); LiveBarRelay.jar BUNDLES HistoryDumper.
- `npm run check` (tsc) clean; all new modules transform at HTTP 200; strategy-guard loads `probability v1.0.0` with no integrity violation. Confidence: high (compile + transform verified; live MW feed + on-chart panel render not visually confirmed here).

**2026-06-02 — Restored per-session footprint ladders + zones in the terminal (was lost in UI rewrite)**
- Observation: The "old footprint" — a bid/ask (net-delta) LADDER anchored at each session's first candle + its imbalance ZONES — disappeared from the Baxter terminal. Rendering code was intact (`TerminalLiveChart.drawFootprint`: Step 1 zones from `sessions[].imbalances`, Step 2 `renderLadder` anchored at `ts.timeToCoordinate(fp.time)` for each session). Root cause was the DATA: `footprintAggregate.aggregateSessions` sums REAL per-candle `levels` only, and real MW data spans just the last ~50 buckets (and the dup-preview bug made that ~15min), so historical sessions had no aggregate → no ladder. The OLD market.tsx (`candleFootprintMap`/`buildAggregate`, market.tsx ~L2233-2335) built these from the OHLCV PROXY (`buildProxyFootprintCandle`) over ALL windowed candles → a ladder on every session. The terminal rewrite dropped proxy.
- Action (HYBRID per user req): `TerminalLiveChart` footprint useEffect builds sessions via a `buildSessions(realByTime?)` helper = `aggregateSessions(validCandles.map(c => realByTime?.get(c.time) ?? buildProxyFootprintCandle({time,open:o,high:h,low:l,close:c})))`. (1) Synchronously builds PROXY-only (`buildSessions()`) so every session shows instantly. (2) The `/api/footprint/history` fetch builds `realByTime` (per-candle real footprint keyed by bucket time) + delta map; if `interval === base && realByTime.size`, REBUILDS sessions with `buildSessions(realByTime)` so candles with real data use real bid/ask levels and the rest stay proxy → real upgrades applicable (recent) sessions, proxy stays for historical. GUARD `interval === base`: real data only exists at 5m, and a 15m chart uses base=5m so 15m candle times wouldn't align 1:1 with 5m buckets (would grab only 1 of 3) — so real merge only on 5m (1m/60m have no real data anyway). `aggregateSessions` handles proxy tiers (PROXY_TIER2/3 when `!FOOTPRINT_DATA_CONFIRMED`). `TerminalCandle` is `{time,o,h,l,c}` (no volume → proxy defaults 100).
- GOTCHA (expected): the ladder for a session only renders when that session's FIRST candle is on-screen (`if (xf<0||xf>cw) continue`) — scroll so the session open (e.g. 9:30 RTH) is visible. Requires Footprint toggle ON + Market/home tab.
- `npm run check` clean. Confidence: high (compile-verified; render mirrors proven market.tsx proxy aggregation)

**2026-06-02 — News ticker not clickable: `.tt-app` pointer-events:none not re-enabled for `.tt-ticker`**
- Observation: `NewsTicker.tsx` already renders correct `<a target=_blank>` links, but they weren't clickable (and hover-pause didn't work). Root cause: in floating mode `.tt-floating .tt-app{ pointer-events:none }` (terminalStyles.ts) disables events app-wide, then re-enables ONLY `.tt-header`/`.tt-main`/`.tt-clock`/`.tt-fp`. `<NewsTicker>` mounts as a direct child of `.tt-app` between `<header>` and `<main>`, so `.tt-ticker` inherited `pointer-events:none` and was never restored.
- Action: Added `.tt-floating .tt-ticker{ pointer-events:auto; }` to terminalStyles.ts. RULE: any new floating element placed under `.tt-app` (sibling of header/main) needs its own `.tt-floating .X{ pointer-events:auto }` or it'll be click-dead — the passthrough pattern is allowlist-based, not opt-out.
- `npm run check` clean. Confidence: high

**2026-06-02 — Footprint candles now persisted to DB (past sessions survive restart)**
- Observation: Footprint (bid/ask ladder) data only ever lived in `footprint-engine.ts`'s in-memory `candleStore` Map, capped at 50 candles/symbol+interval and wiped on every server restart. There was NO footprint table — `signalHistory.footprintReading` is just a summary string. So "past sessions footprint data" never existed beyond the live RAM window. (Real footprint requires live trade ticks w/ aggressor side from MW `LiveBarRelay.flushFootprintBar`; historical OHLCV can't reconstruct it — only the synthetic proxy can.)
- Action: Added durable `footprint_candles` table (schema.ts + db.ts CREATE TABLE IF NOT EXISTS, UNIQUE(symbol,interval,time)) storing each candle as a JSON blob. `pushCandle()` (the single chokepoint all candle writes flow through) now calls `persistCandle()` → upsert (onConflictDoUpdate) so previews get overwritten by the finalized complete candle; the session's last partial candle is retained if MW disconnects before rollover. `loadPersistedCandles(sym,iv,limit=600)` reads back ascending. `hydrateFromDb()` (called first in `initFootprintEngine`) seeds the in-memory store with the last 50 COMPLETE candles/key so signal analysis + getLatestCandle work right after a restart (previews excluded so they don't pose as "latest"). `/api/footprint/history` now merges DB (older) + in-memory (fresh) + active preview, deduped by time (in-memory wins), with `?limit=` (default 600, max 5000).
- Dup-preview bug found + fixed: `pushCandle` APPENDED on every call, but the 10s preview interval + every footprint_bar both re-push the CURRENT bucket → the 50-slot cap filled with repeats of one bucket. Live probe of `/api/footprint/history/MES/5m` returned 50 entries spanning only 600s (~3 unique buckets, ~15min) instead of ~4h. Fixed: `pushCandle` now replaces the last entry when `last.time === candle.time` (preview→preview refresh, preview→complete on rollover) and only appends/shifts on a NEW bucket. This is also why little/no footprint rendered on the chart — barely any distinct buckets existed to draw.
- Caveat: only captures sessions where MW was connected going forward — cannot retroactively recover already-passed sessions. For those, a vendor tick backfill (Databento/Rithmic/CQG) is the only source of REAL footprint. Footprint data exists ONLY at 5m (MW LiveBarRelay flushes 5m footprint bars; `/api/footprint/latest/<sym>/1m` is null) — 15m maps to 5m, 1m has none.
- Stopgap option (raise the RAM cap): in `footprint-engine.ts` `pushCandle`, `if (arr.length > 50) arr.shift()` is the in-memory limit — bump 50 to keep a full session in RAM without restart (one number). DB persistence supersedes this but the cap still governs `getAllCandles`/`getPriorCandles`.
- `npm run check` (tsc) clean. Additive change, no top-level await / import.meta (build-safe).
- Confidence: high (compile-verified; live MW capture not run here)

**2026-06-02 — iPhone app renamed Meridian → "Baxter: Trading Platform"**
- Only ONE user-facing "MERIDIAN" string in the Expo app: the header wordmark in `DayTrading/components/meridian-header.tsx` (`<Text style={h.brand}>`). Changed to a brand column: "BAXTER" + "Trading Platform" subtitle (matches the web terminal). The other `meridian-*` hits are component/file identifiers + comments — NOT renamed (refactoring filenames/imports is churn/risk, not needed to rename the app).
- Expo home-screen name: `DayTrading/app.json` expo.name "DayTrading" → "Baxter: Trading Platform". Left `slug` as "DayTrading" (tied to EAS projectId — don't change).
- RN TextStyle accepts textTransform:'uppercase'. DayTrading tsc --noEmit clean.
- Confidence: high

**2026-06-02 — Baxter: all-vectors, chart accuracy, footprint ladders+zones, title**
- ALL timeframe vectors restored (TerminalLiveChart): pre-allocate 4 LineSeries (1m/5m/15m/60m), current interval = teal C.accent width2, others colored (#60a5fa/#9ca3af/#fbbf24/#a855f7). Base per interval: current = chart candles; coarser = aggToInterval(chartCB,sec); finer = aggToInterval(base1mCB,sec) where base1m fetched from /api/data/cached-continuous/{sym}/1m?from=now-3d (only when currentSec>60). Each vector forwardFillVector'd to chart times. Recompute keyed on barSig (`len:lastTime`) NOT every tick.
- Chart accuracy / ghost candles (useTerminalData): badBar(o,h,l,c,thr) mirrors server isSpikeBar thresholds (0.5/1/1.5/2.5% by interval) → filters fetched bars + validates live `bar`. Live `tick` CLAMPED via lastCloseRef: ignore px<=0 or |px-lastClose|/lastClose>2% (a single bad tick was spiking the forming candle into a ghost). lastCloseRef updated on fetch/bar/tick.
- Footprint LADDER + ZONES (tint alone wasn't enough): on-chart ZONES = latest completed FootprintCandle POC (amber w2) + VAH/VAL + imbalances[] clusters (start/end price lines, green buy/red sell), refetched on barSig, range-clamped. LADDER = FootprintPanel.tsx polling /api/footprint/latest/{sym}/{base} every 4s, renders levels[] price-desc windowed ±13 around POC, bid/ask bars scaled to maxVol, POC row amber, imbalance cells colored. Floats right (right:14 top:88 bottom:128) clearing HUD + clock; pointer-events:auto; only when Footprint on + Market tab.
- FootprintCandle.levels fields are bidVol/askVol (not b/a); footprintDelta() handles candleDelta||delta||Σ(askVol-bidVol).
- Title: Brand sub "trading terminal" → "trading platform".
- tsc + vite build clean.
- Confidence: high

**2026-06-02 — Baxter: clickable signal detail + more-opaque Signals/Settings panels**
- Click-to-detail: extended TerminalSignal (useTerminalData) + SignalRow to carry signalType/outcome/confirmations/footprintReading (raw JSON). SignalsView rows are now `.clickable` (onClick → setSelected); a fixed-center `.tt-detail` modal shows ENTRY/STOP/TP1/TP2 with point distances, Risk:Reward (TP1/SL, TP2/SL), P&L, outcome, parsed CONFIRMATIONS chips (milkOk+milkPts, vecOk, secondaryVecOk+count) and a FOOTPRINT READING key/value grid (primitive fields only). Author-mode "Mark Bad" button uses e.stopPropagation() so it doesn't open the modal.
- Readability: bumped `.tt-card` / `.tt-table-wrap` / `.tt-stat` backgrounds from ~2% white to rgba(10,12,18,0.82–0.85) + backdrop-blur(10px) — Signals/Settings panels are now solid/readable over the live chart background while still floating. Market HUD (`.tt-hud`) unchanged.
- tsc + vite build clean.
- Confidence: high

**2026-06-02 — Baxter terminal: restore real Exit Strategy, milk-zone upload, rename, chart interactivity**
- Rename MERIDIAN → BAXTER: only the visible wordmark in `controls.tsx` <Brand/> (`tt-brand-name`). Sub stays "trading terminal".
- Exit Strategy restored to the real engine controls (was mockup partial/breakeven/tp2/monte): Tight/Standard/Wide = `exitStrategy` safe/risky/riskiest (EXIT_STRATEGY_PROFILES labels), Direction = `autoTradeDirection` both/long/short, Targets = `autoTradeTp1Only` (TP1 vs TP1+TP2), Trailer Stop = `useTrailer`+`trailerOffset`, Zone Targets = `useZoneTargets`, Side-Entry Longs = `takeSideEntries`. ALL added to TerminalSettings and MIRRORED into mwb_settings via saveSettings (engine reads on reload). loadSettings seeds them back from mwb_settings. Default exitStrategy="risky" to match the engine's getPersistedSetting default.
- Milk zones = UPLOAD-PICTURE feature again (new `client/src/lib/milkZones.ts`): file → base64 → POST /api/zones/parse with {filename,data,visibleHigh,visibleLow} → response {zones:[{topPrice,bottomPrice,fillColor,label}],count}. Endpoint PARSES ONLY (no persistence) — store per-symbol in localStorage `baxter_milk_zones_<SYM>`. Upload button lives in the Strategies dropdown MilkZone row; uploading auto-enables MilkZone. TerminalLiveChart draws zones from the `milkZones` prop (NOT discord-zones anymore) as createPriceLine pairs. GOTCHA: price lines participate in right-scale autoscale → filter drawn zones to within ±1.5×range of the visible candles or a far-off zone squishes the candles.
- Chart pan/zoom/price-axis (#4): lightweight-charts createChart needs explicit `handleScroll {mouseWheel,pressedMouseMove,horz/vertTouchDrag}` + `handleScale {mouseWheel,pinch,axisPressedMouseMove:{time:true,price:true},axisDoubleClickReset}`. Dragging the price axis scales price (autoScale flips off automatically); double-click axis resets. rightPriceScale.autoScale:true.
- tsc + vite build clean. npm run build still fails only on pre-existing server-bundle errors (unrelated).
- Confidence: high

**2026-06-02 — MERIDIAN terminal tweaks: market-as-background + real overlays + author/learn**
- Chart-as-background (#1+#5): the CSS wave-reveal mockup chart was REPLACED with `TerminalLiveChart.tsx` (lightweight-charts v5) rendered `position:fixed inset:0 z-index:0` — the market IS the background; HUD/panels/clock float over it. Gives native scroll/zoom. v5 API: `chart.addSeries(CandlestickSeries|LineSeries, opts)`, markers via `createSeriesMarkers(series, [])` then `.setMarkers()` (NOT series.setMarkers). `CandleBar` type is NOT re-exported by trading-utils — import it from `@/components/CandlestickChart`. markers plugin is typed `ISeriesMarkersPluginApi<Time>` (Time, not UTCTimestamp) or tsc errors. CLAMP marker times to the loaded candle [min,max] or lightweight-charts throws on out-of-range.
- Overlays driven by Strategies toggles: Vector → computeVectorLine(candles); MilkZone → real zones from GET /api/discord-zones (fields top/bottom/is_bull) drawn as createPriceLine bands (PNG-upload zones live only in market.tsx state — no GET — so discord-zones is the available real source); Footprint → per-candle body tint from GET /api/footprint/history/{sym}/{base} (base="5m" for 15m), delta = Σask−Σbid per levels[].
- Floating click-through: chart needs to be draggable in empty space. `.tt-main.passthrough{ pointer-events:none }` only on the Market tab (so empty center passes clicks to the z0 chart), with `.tt-hud{ pointer-events:auto }`. Signals/Settings keep pointer-events auto (chart is static backdrop there). `.tt-overlay` is a pointer-events:none vignette.
- HUD stats gotcha: candle window widened to 600 bars for scroll (MAX_CANDLES), so MarketView change/high/low MUST filter to today's ET session (etDayStartSec, DST-safe) — using candles[0] would be 600 bars ago. Fallback to last 64 when today is empty.
- Settings trimmed (#2/#3): removed Risk Management + Data Feed cards; Contract&Session = Symbol only; Notifications → single Discord-Bot card (webhook input → POST /api/discord/settings + localStorage "discord_webhook", the same plumbing market.tsx uses). Exit/Signal/ML cards kept. SettingsView no longer takes `connected`.
- Signals (#4): Author mode = `editMode` analog — per-row "Mark Bad" persists to localStorage "sp-annotations" (key `${sym}-${ts}-${Dir}-${iv}`, matches SignalsPanel) + POST /api/signals/label {key,time,direction,isBad,note,...}. Learn button = POST /api/learn/backfill → /api/learn/run + toast "Learned from N signals (X% win rate)". Tier filter replaced by SIDE filter (single-tier).
- Clock made compact (#4b): 34px→21px time, smaller padding/radius.
- Deleted unused TerminalChart.tsx + ShaderBackground.tsx. tsc clean + vite build clean. `npm run build` still fails ONLY on pre-existing server-bundle errors (routes.ts top-level await, db.ts import.meta) — unrelated; npm run dev unaffected.
- Confidence: high

Update this file after every session. Be SPECIFIC. Vague entries are useless.

---

## What Has Worked

- **`useLayoutEffect` for chart init** — DOM dimensions are 0 at `useEffect` time in lightweight-charts v5. Always use `useLayoutEffect` when creating the chart or reading `getBoundingClientRect()`.

- **Pre-allocating chart series at init** — Adding/removing `LineSeries` dynamically (after chart creation) resets the visible time range. Pre-allocate ALL series (vector, extra vectors, overlays) at chart init, then just call `setData()` to show/hide.

- **`autoscaleInfoProvider: () => null` on indicator series** — Without this, vector lines pull the Y-axis to fit their full historical range, compressing candles to a tiny sliver. Set this on ALL non-candle series (main vector, extra vectors).

- **`dedupMap` before `series.setData()`** — Duplicate timestamps silently drop bars in lightweight-charts v5. Always deduplicate before passing candle arrays.

- **`series.update()` fast path for live ticks** — Calling `setLiveCandles()` on every tick floods React with re-renders. Tick messages call `chartRef.current.updateLastBarClose()` directly (bypasses React state). `bar` messages use `setLiveCandles()` for signal recomputation.

- **Suppressing disk reads when TickRelay is active** — `onTickFileChange` must return early when `Date.now() - lastExternalTickMs < 5000`. Without this, stale disk prices override live WebSocket prices, causing visible price jumping.

- **`forwardFillVector` for multi-interval vectors** — To display a 15m or 60m vector on a 5m chart, forward-fill: for each 5m chart time T, emit the last vector value whose time ≤ T. Works for both coarser-on-finer and finer-on-coarser.

- **`aggToInterval(candles, intervalSec)`** — Generic aggregation correctly handles all intervals. `agg5mTo15m` only works for 5m→15m; `aggToInterval` handles any target.

- **Bar interval detection starting from `Infinity`** — The gap detection loop `let barIntervalSec = 300` breaks 15m/60m charts because `900 < 300` is false and the variable never updates. Must start from `Infinity` and scan down.

- **`intervalKey` prop + `prevIntervalKeyRef` to detect interval switches** — When switching 1m→15m, the old logical range `{from:155000, to:155080}` exceeds 15m data length (~10k bars), causing lw-charts to zoom-to-fit all history as tiny dots. The fix: pass `intervalKey={interval}` to CandlestickChart, track `prevIntervalKeyRef`, and on mismatch reset to last 80 bars. Also needed: `if (!range || range.from >= total)` guard for the reverse case (old low-res range pointing into stale history after switching to high-res).

---

## What Has Failed

- **`useEffect` for chart init** — Dimensions are 0, chart renders with height 0. Always use `useLayoutEffect`.

- **Starting gap detection at `barIntervalSec = 300`** — 15m candles are 900s apart; `900 < 300` is always false so `barIntervalSec` stays 300, `GAP_THRESHOLD_SEC = 600`, and spacers are inserted between EVERY 15m candle pair. Broke the 15m chart completely.

- **Stale logical range after interval switch** — Switching 15m→1m and back leaves the old range (e.g. `{from:7920,to:8005}`) which in 1m context points to early December history, not the recent bars. Fixed by detecting `intervalKey` change in the candle useEffect and resetting zoom. Do not leave visible range correction to the `scrollToRealTime()` path — it only fires when near the right edge.

- **Dynamic `chart.addSeries()` in `useEffect`** — Resets the chart's visible range every time series are added. Also: if the chart is recreated (resize/theme change), the useEffect doesn't re-run (prop didn't change) and the new chart has no series. Pre-allocate at init instead.

- **Byte-scanning tick file for prices** — Attempting to scan the MW `.tick_data` file by looking for float32BE values in the 400–50,000 range returns garbage (e.g., 20,992 / 1,600 for MES). These corrupt bars produce ATR ~19,000pts → every SL hits immediately → ~11% win rate. Use fixed-offset record parsing only.

- **Setting `lastTickPrice` before the forming-bar broadcast condition** — In `notifyExternalTick`, `lastTickPrice.set(sym, price)` was called on line 458 THEN the condition `Math.abs(price - lastTickPrice.get(sym)) >= 0.01` was checked on line 501. The difference is always 0 → broadcast never fires. Move the set AFTER the check, or use a throttle.

- **`parseTickFileAsBars` byte scanner** — Rewrote to scan every 4 bytes for plausible MES prices. Produced corrupt OHLCV bars that destroyed win rates. Reverted immediately to fixed-offset version.

- **Letting vector series affect `autoscaleInfoProvider`** — Without `() => null`, a 15m or 60m vector from 90 days of history (when the price was 500pts lower) pulls the Y-axis down, compressing current candles into the bottom 5% of the chart.

- **Not pre-allocating extra vector series** — After adding dynamic series, `fit all` would re-trigger chart autoscale and compress candles.

---

## Patterns and Preferences

- **4 pre-allocated extra vector series slots** (even though max needed is 3) — always enough room for 1m/5m/15m/60m minus current interval.

- **Interval-to-seconds mapping**: `1m=60, 5m=300, 15m=900, 60m=3600`. The `fetchInterval` only has 3 values: `"1m"`, `"5m"` (used for both 5m and 15m charts), `"60m"`. The 15m chart is ALWAYS aggregated client-side from 5m data.

- **Signal cooldown is 10 RTH bars** — signals cluster without it. This is measured in RTH bars only, not wall-clock time.

- **MotiveWave TickRelay study sends `{type:"tick", symbol, price}` only** — no OHLCV bars. All OHLCV bar state is maintained server-side in `inProgressBar1m` / `inProgressBar5m` maps and broadcast as `{type:"bar"}` when buckets close.

- **~~Whitespace spacer collision guard~~** — REMOVED. Gap spacers removed entirely (user wants no gaps). Just pass plain `CandlestickData[]` to `series.setData()`.

- **Real unix timestamps (NO gap spacers)** — The compressed bar-index timeline was reverted. Use real unix timestamps in all `series.setData()`/`series.update()` calls. Gap spacers were subsequently removed too — user wants zero gaps including overnight/weekend. Just call `series.setData(candleData)` with the plain array; lw-charts handles time gaps natively on the axis.

- **~~Pure integer bar indices eliminate ALL weekend/session gaps~~** — SUPERSEDED. Compressed timeline was reverted because it introduced a race-condition gap when `_compPairs` was stale on WS reconnect, and produced a chart that didn't match MotiveWave/PC. Real timestamps + whitespace spacers is the correct approach.

- **Footprint imbalance zones must be time-gated** — `allAggsFp` can include sessions from months ago when the chart spans a large history. Without a recency filter (e.g., `nowSec - zfp.time > 5 * 86400 → skip`), old sessions render imbalance bands at historical price levels, which appear as "imaginary zones" when the Y-axis includes those old prices. Add `ZONE_CUTOFF_SEC = 5 * 24 * 3600` filter.

- **Footprint ladder must be price-range filtered** — `prevSessionFp` is the most recent completed session. When the user scrolls back in time, the visible Y-axis can include old price ranges. Guard with `fp.high >= visPriceBot && fp.low <= visPriceTop` to prevent a ladder with stale prices from rendering at the right edge against current candle territory.

- **Session boundary markers needed with compressed timeline** — When ETH and RTH bars are compressed together, overnight price gaps look like spurious spikes. Draw thin vertical dashed lines at RTH↔ETH transitions using `ctx.setLineDash([3,4])` at `rgba(90,120,160,0.30)` opacity. Detect transitions by checking `prev.rth !== false !== cur.rth !== false`.

- **Vector computation uses ALL bars (RTH + ETH)** — `computeVectorLine` must NOT filter to RTH-only. ThinkorSwim's `vectorexitstrat` uses all bars; RTH-only filtering causes large slow-moving staircase steps that don't match the reference. The 20-bar window already provides enough smoothing. Trading SIGNALS still gate on RTH/ETH conditions separately — the formula is all-bars but signal firing is controlled upstream.

- **Win rate baseline** — Safe signals historically run ~55–65% win rate on MES 5m. Below 50% almost always means corrupt candle data, not a strategy problem. Check DB first.

- **HOD/LOD TP1 caution (3 pts prox, 2 pts buf, 3 pts min profit)** — TP1 is tightened to HOD − 2 (longs) or LOD + 2 (shorts) when within 3 pts of HOD/LOD. TP2 is never clamped. Applied at all 6 lock sites. HOD/LOD must be tracked before `continue` statements so skipped bars still update the day's high/low. Only applied to RTH signals (`rthC = true`).

- **Long entry suppression near HOD (5 pts, uses `prevDayHodHigh`)** — Long signals are blocked when `c.close` is within 5 pts of the HOD that existed BEFORE the current bar (`prevDayHodHigh`). Using `prevDayHodHigh` (not `hodHigh`) is critical: it prevents blocking valid breakout bars that themselves pushed price above the old HOD. The guard `prevDayHodHigh > -Infinity` skips the check on the first RTH bar of the day (no reference yet). Applied to all 3 long signal types (confluence, pure tabletop, side tabletop).

- **Discord zone toTime was 14 days (incorrect)** — Each zone is valid for its market day only. Fixed in market.tsx `activeZones` useMemo: now uses `rthSettleOfDay(z.posted_at)` instead of `z.posted_at + 14 * 86400`. Zones posted post-RTH (ETH pre-market) advance to next day's settle.

- **extraVecSignalLines replaces extraVecSignalMaps** — Added `flatMap` (true when secondary vector barely moved over 2 steps ≤1pt) and `declineMap` (true when secondary vector is in a falling phase, reset on any upward tick). Pre-computed at useMemo time for O(1) per-candle lookups in the signal loop. The `vec60mLine` reference pre-extracted before the loop so the 60m `declineMap` check is O(1) per candle.

- **Trade journal built in** — new `/api/journal` CRUD routes, `trade_journal` DB table, `/journal` page. Stats panel shows win rate by emotion state and plan adherence. Accessible via "Journal" button in the market page toolbar. Feeds user trade data directly into the system for ML analysis.

- **Zone day-isolation: zone-parser now caps toTime to RTH settle when no explicit end time in MWML** — `defaultToTime(fromTs)` computes 20:30 UTC on the zone's `fromTime` day. Previously all MWML zones without an explicit `toTime` got `9_999_999_999` (infinite), causing prior-day zones to bleed into all subsequent sessions and produce false `milkBullOk`/`milkBearOk` matches. Fix only applied when `fromTs > 0`; fallback parsing paths with `fromTime: 0` keep `9_999_999_999` because there's no day context.

- **Spike candle filter in `cached-continuous` endpoint** — Added `isSpikeBar(o, h, l, c)` in `server/routes.ts` that rejects: (1) any bar whose H-L range > threshold × close (1m=0.5%, 5m=1%, 15m=1.5%, 60m=2.5%), (2) doji-spike bars where body/range < 5% AND range/close > 0.2%. Applied before `.map()` in both DB path and `memBarsToCandles()`. Filters corrupt data-glitch bars that trash `Lowest(low, 20)` vector for 20 bars downstream.

- **TickRelay phantom bar root causes (three distinct bugs)** — (a) Close-handler fires `setTickRelayConnected(false)` on first of N disconnects (should only fire when ALL clients disconnect — check `mwWss.clients.size === 0`). (b) `onTickFileChange` checks `tickRelayConnected` but NOT `lastExternalTickMs`, so a brief flag flip lets stale disk prices corrupt live price. (c) At startup, disk poll seeds `inProgressBar5m.open` before TickRelay connects → phantom bar with open at yesterday's close (e.g. 7192) and close at live (7485). Fix: clear all in-progress bars inside `setTickRelayConnected(true)`.

- **backtest.tsx zone scan was capped at last 234 RTH bars** — `const startIdx = Math.max(0, rth.length - 234)` made `detectMilkZones` only detect zones for the most recent ~2 weeks, leaving all older candles with `milkBullOk=false` and showing as RISKY. Fix: start the loop from index 1 unconditionally. Also had a secondary `zones.slice(-60)` cap that hid 90%+ of detected zones. Both removed.

- **extraVecSignalMaps refactored to extraVecSignalLines with flatMap + declineMap** — The old structure stripped labels from secondary vector maps, making it impossible to identify the 60m interval for the hard veto. Replaced with `{ label, color, map, flatMap, declineMap }` per line. `flatMap` pre-computes whether each vector is flat (≤1pt change over 2 steps), used as the side-entry proxy. `declineMap` tracks whether the vector is in a falling phase (resets on any upward tick).

- **Secondary vector now requires flatness as side-entry gate** — Per strategy: secondary vectors only count as confluence when that interval shows a side-entry/consolidation first. Proxy: the secondary vector must be flat (≤1pt change over 2 steps). Without this gate, `secLongOk` fired anytime `c.close > secondaryVector` regardless of trend state, producing false confluence.

- **60m hard veto added for Long signals** — Pre-computed `vec60mLine` before the main signal loop. Inside the Long block, `vec60mDecline = vec60mLine?.declineMap.get(c.time) === true` gates the entire Long condition. When the 60m vector is in a declining phase, ALL Long signals are suppressed regardless of zone/footprint/secondary-vector state.

**2026-06-02 — Production build fixed (esbuild cjs: top-level await + import.meta)**
- Observation: `npm run build` (`script/build.ts` → esbuild server bundle, `format:"cjs"`, `dist/index.cjs`) failed on `server/routes.ts` top-level `await import(...)` (the discord-webhook DB load) and warned on `server/db.ts` `fileURLToPath(import.meta.url)` (empty in cjs → would throw at runtime).
- Action: routes.ts — the dynamic `await import("./db" | "@shared/schema" | "drizzle-orm")` was redundant (all three are already statically imported at the top) and better-sqlite3 `.all()` is synchronous, so replaced it with a plain `db.select().from(appSettings).where(eq(...)).all()` — no top-level await.
- Action: db.ts — resolve `DB_PATH` from `process.cwd()` (both `npm run dev` via tsx and prod `node dist/index.cjs` launch from the project root → same `<root>/data/app.db`) with a `DB_PATH` env override; removed `import.meta`/`fileURLToPath`/`__dirname`. Build now exits 0 with no warnings; bundle no longer crashes on startup.
- Note: `package.json` is `"type":"module"` (dev=ESM via tsx); only the esbuild PROD bundle is cjs. `server/vite.ts` uses `import.meta.dirname` but is dev-only (not bundled), so it's fine.
- Confidence: high

**2026-06-02 — MERIDIAN mobile redesign ported into the Expo app (native, no DOM)**
- Source of truth: `trading-terminal-mobile.jsx` (web mockup). Rebuilt natively, not as WebView/DOM.
- Theme is the pivot: every screen reads `constants/theme.ts` `Trading`/`TIER`/`Fonts`, so repointing those token VALUES to the Meridian palette (bg #06070b, accent #2dd4bf, up #1fd98a, down #ff4d6d, amber #ffb454) + Chakra Petch/IBM Plex Mono re-skins the whole app (incl. trade/journal/welcome) with one edit. Added tokens: `glass`, `glass2`, `line`, `lineSoft`, `amber`. `Fonts.mono`→`IBMPlexMono_500Medium`; added `Fonts.display`→`ChakraPetch_600SemiBold`/`Fonts.bold`.
- Fonts loaded in `app/_layout.tsx` via `useFonts` + `SplashScreen.preventAutoHideAsync/hideAsync` gate. Root wraps in `GestureHandlerRootView` + `BottomSheetModalProvider`; renders `<MeridianBackground/>` behind a transparent-background navigator (navTheme background:'transparent', Stack contentStyle + Tabs sceneStyle transparent) so the gradient shows through. New screens use `SafeAreaView backgroundColor:'transparent'`.
- Nav: 3 visible tabs (index=Market, signals, settings) via custom `tabBar` (`components/custom-tab-bar.tsx`); `trade`/`journal`/`explore` kept as `href:null` routes (hidden but routable). Position links from Market; AutoTrader reached from a Settings card.
- IMPORTANT: did NOT rewrite `journal.tsx` (AutoTrader arm/disarm + order-firing) — safety-critical per the AutoTrade risk-gate rule. It auto-reskins via the palette and is reached via `router.push('/(tabs)/journal')`. If asked to inline it, extract verbatim without touching firing logic.
- Deps added (all Expo Go safe, `npx expo install`): `react-native-svg`, `@gorhom/bottom-sheet` v5 (uses existing reanimated+gesture-handler), `expo-linear-gradient`, `@expo-google-fonts/chakra-petch`, `@expo-google-fonts/ibm-plex-mono`. Deliberately NOT `@shopify/react-native-skia` (forces a dev build, breaks `expo start --tunnel`/Expo Go).
- Shared code: moved `MobileSignal`/`OutcomeResult`/`mapDbSignal`/`isPcDisplaySignal`/`isRTH` out of `chart-view.tsx` into `lib/signal-map.ts` (chart-view re-exports the types for back-compat). `lib/candles.ts` holds light `spikeBarOk`/`dedupByTime`/`aggToInterval`/`atr14` for `hooks/use-market-data.ts` (candles+stats+signals, shared by Market & Signals, independent of the WebView). Also `hooks/use-et-clock.ts`, `hooks/use-trade-status.ts`.
- Wave chart (`components/wave-chart.tsx`): react-native-svg Rect/Line + one reanimated `progress` value; each candle is its own `<WaveCandle>` component (hooks can't run inside a `.map`) animating an `AnimatedG`'s `opacity`+`y`; replays when `chartKey` changes (Market `useFocusEffect`, refresh, new data via `lastUpdated`).
- Settings binds real config (symbol→instrument, session, exitStrategy, push→notifications, endpoint→apiBaseUrl, connection→/api/trade/status, min-tier/confirms/closed-only as client filters) and persists the mockup's other controls as local prefs in the new `terminal` object in `context/app-context.tsx` (not faked as server-saved). Custom `Slider` is PanResponder-based (no extra native dep).
- The full lightweight-charts WebView (`chart-view.tsx`) is untouched and opens via "Expand" on Market.
- `npx tsc --noEmit` clean; `npx eslint` clean. Confidence: high (compile-verified; on-device run pending).

**2026-05-17 — Mobile gap spacers cause 0-price phantom candles**
- Observation: Lightweight-charts v4 does NOT support whitespace-only `{time}` entries in a candlestick series (unlike v5 which has explicit WhitespaceData). Passing `{time}` without OHLCV renders as a candle at price 0, appearing as tiny bars far below the chart.
- Action: Remove gap spacer logic entirely from mobile `setChartData`. Just call `candleSeries.setData(candles)` directly. LW v4 handles time gaps natively on the time axis without needing spacer entries.
- Confidence: high

**2026-05-17 — Mobile live data via WebSocket**
- Observation: Mobile only fetched historical data on mount/refresh; no live tick feed.
- Action: Added `window.connectLive(wsUrl, sym, resolution)` to WebView HTML. Called from React Native after each historical data load by converting `apiBaseUrl` (`http://`) to `ws://` and connecting to `/ws/live-bars`. On tick: updates `liveLastBar.close/high/low` and calls `candleSeries.update()`. On complete bar: updates `storedCandles` and redraws footprint. Auto-reconnects after 5s on disconnect.
- Confidence: high

**2026-05-17 — Footprint ladder + zone mitigation fix**
- Observation: PC ladder rendered `bidVol × askVol` on the left column plus net delta on the right. Zone mitigation was wrapped in `if (!isCurZ)` — so any historical session whose anchor candle was visible on screen bypassed mitigation and kept showing already-traded-through zones.
- Action: (1) Reduce `C_TOT` to 80, remove two-column layout, show only signed net delta centered in the single column. (2) Remove `!isCurZ` guard — mitigation now always runs for every historical session. (3) Mobile: rewrite `buildProxyFP` to use whole-number price buckets (matching PC); rewrite imbalance detection to per-level ratio (not diagonal cross-level); rewrite `drawFootprint` to render the same net delta column on the right edge.
- Confidence: high

**2026-05-23 — Per-candle MW Volume Imprint footprint**
- Observation: `candleFootprints` prop was session-aggregate (one RTH/ETH ladder). Real per-candle bid×ask data from MW arrives via `footprint_bar` WS → `footprint-engine.ts` → `footprint_candle` WS → `footprintCandlesRef` on client — but was only used for signal computation, never rendered.
- Action: Added `perCandleFootprints?: Map<number, FootprintCandle>` prop to CandlestickChart. Built `perCandleFootprintMap` in market.tsx from `footprintCandlesRef` (real MW data only, keyed by candle time). In `drawAll`, added per-candle rendering block: for each visible candle with a footprint, draw bid bars (left half, red) and ask bars (right half, green) within the bar's pixel width. `rowH = pixPerPoint × 0.25` — if too small (<0.5px), skip. Numbers shown when barW ≥ 60px and rowH ≥ 10px. Only shows for bars with real MW tick data (last ~50 5m bars); no proxy fallback for historical.
- Confidence: high

**2026-05-24 — Footprint zone detection: diagonal ratio fails with proxy OHLCV data**
- Observation: After applying the footprint literature's diagonal 3:1 rule (`ask@bucket[bp] / bid@bucket[bp-2] >= 3.0`), ALL session-aggregate zones disappeared. The proxy bid/ask generated from OHLCV (`buildProxyFootprintCandle`) is a smooth distribution where adjacent 2-point buckets have nearly identical ratios — the diagonal comparison never reaches 3.0 with synthetic data. Only real MW tick data (from `footprint_bar` WS) can achieve 3:1 cross-level ratios.
- Action: Revert zone detection to same-bucket comparison (`ask / bid >= 1.3` and `net >= 100` within the same 2-point bucket). Applied identically in both the `drawAll` Step 1 block and the mitigation `useEffect`. Stacked detection, zone boundary mitigation (close < bp for buy, close > bp+2 for sell), and opacity tiers are unchanged.
- Confidence: high

**2026-06-02 — LiveBarRelay now relays the forming candle on every tick (throttled)**
- Observation: `LiveBarRelay.onTick()` only sent the price-only `{type:"tick"}` message; the forming candle's full OHLCV (`{type:"bar",complete:false}`) was sent ONLY from `calculate()`, which MotiveWave does NOT invoke on every tick. So the live candle's open/high/low/volume lagged between recalcs even though the close updated every tick via the client `updateLastBarClose()` fast path.
- Action: In `onTick`, after the tick send, read the live bar (`idx = ds.size()-1`) straight from MW's DataSeries and send a forming `bar` message. `close := tick price`; `high/low := Math.max/min(ds value, price)` so the OHLC is never malformed (server rejects `high<low`; `close>high`/`close<low` would also be wrong) and the wick always includes the latest print. Resolution via `inferResolution(ds, idx)`; `complete` via `ds.isBarComplete(idx)`.
- Action: Throttled to `FORMING_BAR_THROTTLE_MS = 200` (≈5/sec) to avoid the documented React re-render flood — the server's `bar` handler broadcasts forming bars unthrottled (live-bars.ts ~L252) and the client does `setLiveCandles()` (React state) per `bar`. Did NOT send on literally every tick for this reason. Kept the `calculate()` forming-bar send too (belt-and-suspenders; it also guarantees the final `complete:true` bar even if no tick lands exactly at close).
- Build env: MotiveWave updated to **Java 26**; its SDK jar is class-file v70. `build.bat` searches jdk-25/21/17 — none can read v70. Must install a **JDK 26** (Temurin 26) to rebuild the studies; MW's bundled `\jre` is a JRE only (no javac). Could not binary-verify the compile here (no JDK 26 present); change verified by API consistency with existing code in the same file.
- Confidence: high

**2026-06-02 — Milk-zone confluence must come ONLY from PNG-uploaded zones (user rule)**
- Observation: User reported signals' firing reasoning showed "Milk Zone" confluence when they had NOT uploaded any zones. Root cause: `market.tsx` `activeZones` prioritized auto-fetched **Discord zones** (`GET /api/discord-zones`) over the user's uploaded `parsedZones`. The Discord reader auto-populates `discord_zones`, so milk fired with no PNG upload. Separately, `backtest.tsx` (`detectMilkZones(bars)`) and `timestamps.tsx` (`detectMilkZones(sorted,0,0)`) fed **synthetic** zones (FVG/absorption/structural detected from price action) straight into milk confirmation — also firing milk with nothing uploaded. (`market.tsx`'s own `detectMilkZones` at L112 was already dead code.)
- Rule (from user): a trade/signal may claim milk-zone confluence ONLY when the zones were uploaded by the user via PNG → `parsedZones`. NOT Discord auto-fetch, NOT synthetic/auto-detected. Before a PNG upload there are zero milk zones.
- Action: (1) `market.tsx` — `activeZones` is now simply `parsedZones` (PNG uploads only); removed the entire Discord-zone `useQuery` + `discordZoneFromTs`. PNG-uploaded zones get `fromTime`/`toTime` for today (L3655-3662) so they pass the `fromTime>0` milk guard and DO fire after upload. (2) `backtest.tsx` — `const zones: ZoneBand[] = []` (no PNG upload on that page → no milk). (3) `timestamps.tsx` — `milkZones=[]`, `milkBull`/`milkBear` empty. `detectMilkZones` left defined-but-unused in all three (project tsconfig has no `noUnusedLocals`, so safe). `npm run check` passes.
- Not touched: server discord reader / `/api/discord-zones` endpoint (still populate the table; client just ignores it for milk). Mobile `chart-view.tsx` also fetches Discord zones for milk — flag for the same fix if the rule should extend to iPhone (user said "PC program").
- Confidence: high

**2026-06-02 — Terminal MilkZone strategy toggle gated to upload-only**
- Observation: The Baxter terminal (`terminal.tsx`) Strategies dropdown had a free MilkZone on/off `Toggle` defaulting to `true` (`DEFAULT_STRATEGIES.MilkZone`), letting the user "switch the milk zone strategy on" with no PNG uploaded. It's display-only (mirrors to `mwb_settings.showMilkZones`; terminal signals come from the hidden market engine which already uses upload-only `parsedZones`), and the terminal's own `milkZones` come from `loadMilkZones` localStorage (upload-only, no fabrication) — but the toggle contradicted the "milk = upload only" rule.
- Action: (1) `controls.tsx` `Toggle` gained an optional `disabled` prop (40% opacity, not-allowed cursor, no-op click). (2) `terminal.tsx` computes `milkUploaded = milkZones.length > 0` and `effectiveStrategies = { ...strategies, MilkZone: strategies.MilkZone && milkUploaded }`, passed to `TerminalLiveChart` + `MarketView`; the MilkZone toggle is `disabled` until an upload and shows the effective (gated) state. Upload still auto-enables it (`setStrategies MilkZone:true`, terminal.tsx ~L61). (3) `DEFAULT_STRATEGIES.MilkZone` → `false`. Runtime gating is the real enforcement since `loadStrategies` can still seed `MilkZone` from `mwb.showMilkZones`.
- Verified: no remaining CALLS to `detectMilkZones(`/`buildMilkZoneSets(` in `client/src` (functions now dead code; tsconfig has no `noUnusedLocals`). `npm run check` passes.
- Confidence: high

**2026-06-02 — Milk zones must be time-bounded to ONE RTH session when charted**
- Observation: The terminal's `MilkZone` type (`lib/milkZones.ts`) carried NO time fields, so `TerminalLiveChart` drew each zone as a full-width `createPriceLine` spanning ALL time — not time-oriented at all. Separately, `market.tsx` time-bounded uploaded zones but `zoneFromTime` started OVN-labeled zones at the *previous* day's 6 PM ET (`todayOvnOpen`) → toTime 4:30 PM ET = ~22 h span (multiple sessions). User rule: a milk zone is valid for ONE RTH session only and must be charted at the correct time, never farther.
- Action: (1) `milkZones.ts` — added `fromTime?`/`toTime?` to `MilkZone` and `currentRthSession(nowMs)` (DST-safe 9:30 AM→4:00 PM ET, rolls forward off weekday/after-close); `uploadMilkZones` stamps every parsed zone with that single session. (2) `TerminalLiveChart.tsx` — replaced the full-width price lines with a pre-allocated pool of `ZONE_POOL=24` `LineSeries` (12 zones × top+bottom edges, `autoscaleInfoProvider:()=>null`). Each zone = two horizontal segments whose endpoints are SNAPPED to real candle times within `[fromTime,toTime]` (`times.find(t>=fromRaw)` … last `t<=toRaw`) — never extends past the session and never distorts the time axis (a raw LineSeries point at a future time would extend the scale and show empty space). Pre-allocated, never added/removed (visible-range-reset rule). (3) `market.tsx` — uploaded zones now `fromTime: todayRthOpen`, `toTime: todayRthClose` (9:30→4:00 ET); removed `todayOvnOpen`/`prevUtc`/`zoneFromTime`. Matches the main `CandlestickChart` default zone window (openTs 9:30 → closeTs 4:00, ~L1418).
- Verified: `npm run check` passes. Could not visually verify the terminal render (no live launch); logic mirrors the proven main-chart `fromTime→toTime` rectangle anchoring.
- Confidence: high

**2026-06-02 — Calendar (date browser) + mini chart re-added to terminal SignalsView**
- Observation: The terminal `components/terminal/SignalsView.tsx` only showed TODAY's signals (text rows) and a text-only detail card. The PC `SignalsPanel.tsx` already had the `SignalMiniChart` preview; the terminal lacked both a date browser and the mini chart. `useTerminalData` hard-fetches today's signals + recent candles only.
- Action: (1) `useTerminalData.ts` — exported `mapSignal`, `SignalRow`, and added `etDateStr(ms)` + `etDayBounds(dateStr)` (DST-safe via `timeZoneName:"short"` EST/EDT check). (2) `SignalsView.tsx` — added a `candles` prop (live, for today) + `selectedDate` state. Calendar control in the toolbar: ‹ / › day steppers, native `<input type=date max=todayStr colorScheme:dark>`, and a "Today" jump. For a PAST day it fetches that day's signals (`/api/signals/history` filtered to `etDayBounds`) and candles (`/api/data/cached-continuous?from&to` — endpoint honors from/to, routes.ts ~L712); today uses the live props. `daySig`/`miniCandles` switch on `isToday`; stats/list/empty-text all derive from `daySig`. (3) `SignalDetail` now takes `candles` and renders `<SignalMiniChart height=180 showMilk=false>` centred on the signal (maps `TerminalCandle{o,h,l,c}`→`CandleBar{open..}`, `tier.toLowerCase()`→riskLevel). (4) `terminal.tsx` passes `candles` to `<SignalsView>`.
- Verified: `npm run check` + `npx vite build` both pass (client bundles clean, 1740 modules). NOTE: `npm run build` fails in the SERVER esbuild step (`server/routes.ts` top-level await, `server/db.ts` import.meta with cjs) — PRE-EXISTING (both files were already modified in the working tree; unrelated to this client-only change; `npm run dev`/tsx is unaffected).
- Confidence: high

---

---

**[2026-05-17] — MW bar file format correction + historical data fix**
- Observation: `mw-reader.ts` had wrong constants: `HEADER_SIZE=80/RECORD_SIZE=22` with `minuteOff` at offset `o+20`. Actual format (confirmed via hex dump of real `.bar_data1` files) is `HEADER_SIZE=48/RECORD_SIZE=30` with `minuteOff` at offset `o+28` (last 2 bytes, after 8 bytes of zero padding post-volume). Old constants produced garbage — 20 records of zeros instead of 15 valid price records per file.
- Observation: `TICK_HISTORY_MS = 8 days` only read the most recent 8 days of tick files. MW stores ~7-9 months of hourly tick files. The bulk of the historical minute-bar data comes from tick files (dense), not from sparse weekly bar files (~15 bars/file). Extending to 300 days grew DB from 19,805 1m bars → 173,044 1m bars, back-filling from June 2025 to April 2025.
- Action: To verify `parseBarFile` format: hex-dump the smallest `.bar_data1` file and find the first 4-byte sequence that decodes to a plausible price (MES ~5000–8000). Count bytes from file start → header size. Find next occurrence → record size. `minuteOff` is the last u16 of the record.
- Action: Set `TICK_HISTORY_MS = 300 * 24 * 3600 * 1000` (300 days) to cover all available MW tick history. First load takes ~23s; subsequent reloads are fast (no-op upserts).
- Action: After extending tick history, sparse MESU6 bar files added future-dated placeholder bars (up to June 24, 2026 — the contract expiry). These pushed the chart's default 60-day window into empty/sparse territory, causing zone rendering artifacts (full-chart olive overlay). Fix: `filter(b => b.timeSec <= Math.floor(Date.now()/1000) + 3600)` in `loadMultiDir` before DB write. Also `DELETE FROM cached_candles WHERE timestamp > nowSec` to clean existing rows.
- Confidence: high

**2026-05-18 — Compressed timeline eliminates weekend/overnight chart gaps**
- Observation: lw-charts v5 has no built-in gap-removal for intraday data. Weekend/overnight gaps (49h Fri 5pm→Sun 6pm ET) consumed ~28% of chart width on a 60-day 5m chart, compressing the visible price action.
- Action: Replaced the gap-spacer approach with a compressed timeline: `base + i * barIntervalSec` assigns sequential chart-times to each bar. Module-level `_toChartTime(actual)` / `_toActualTime(comp)` translate between actual unix timestamps and chart-times via binary-search interpolation. All `ts.timeToCoordinate()` calls receive `_toChartTime(t)`. All `coordinateToTime()` results pass through `_toActualTime()`. `tickMarkFormatter` and `localization.timeFormatter` both call `_toActualTime(compT)` to show real dates. `updateLastBarClose` extends the map for each new live bar.
- Confidence: high

**2026-05-18 — Live data lag: 3 server-side fixes**
- Observation: 16ms fallback poll did `fs.statSync` 60×/sec saturating the Node event loop. Heartbeat broadcast at 60fps sent bar+bar+tick (118/120 sends wasted). Dynamic `import("./footprint-engine")` on every MW tick created a Promise microtask chain.
- Action: (1) Pre-resolve footprint import to a module-level `_checkMidTradeDivergence` variable. (2) Slow fallback poll 16ms→100ms. (3) Split heartbeat: 16ms tick-only + 1s bar-state; 16ms path skips `applyTick` entirely.
- Confidence: high

**2026-05-18 — Full 3-strategy signal computation ported to mobile**
- Observation: Mobile `computeSignals` was a simplified vector-crossover-only version (boolean milk zone, no footprint, no tabletop/side-entry, only safe/risky tiers). PC's SignalsPanel.tsx has 3 strategies: Vector patterns (tabletop + side entry = 2pts each), Footprint proxy (deltaAgrees = 2pts, never 4pts in proxy mode), and graduated Milk Zones (3/1/0 pts by proximity).
- Action: Ported `buildProxyFp` (whole-number price bucket synthesis) and `analyzeFp` (simplified: always isProxyData=true, partial=deltaAgrees, vetoed=false) into chart-view.tsx as inline functions. Rewrote `computeSignals` to match PC: graduated milk scoring (milkPtsL/S tracking best zone), vector tabletop + side-entry patterns, fpPts = fpFires ? 2 : 0, totalPts = fpPts + milkPts + vecPts, risk tiers safeplus/safe/risky/riskiest. Added ETH_COOLDOWN=20 for overnight signals. Updated EXIT_STRAT to all 4 tiers per profile. Market break skip: minsUtc [1230, 1320) ≈ 4:30-6pm ET EDT.
- Action: Updated MobileSignal.riskLevel to include 'safeplus'|'riskiest'. Updated WebView setSignals to color-code all 4 tiers (purple/green/blue/orange/red). Updated index.tsx RiskFilter type and filter chips to show all 4 tiers.
- Confidence: high

**2026-05-17 — 7 pipeline bug fixes**
- Observation: `loadMultiDir` gap-fill fabricated synthetic bars from tick files, injecting inaccurate OHLCV into historical data. `onTickFileChange` suppression used a 60s timer (race: timer expires while relay is still connected). `applyTick` used a 15% ratio threshold (too loose for normal fast MES moves, too tight for morning gap-opens). Cache TTL was 45s (live bars invisible for up to 45s after each close). Gap spacers triggered at ALL gaps including normal overnight/weekend session boundaries. Proxy `IMBALANCE_THRESHOLD` was 1.5 (fired on noise). Canvas overlay didn't resize on panel open/close.
- Action: (1) Remove gap-fill tick loop from `loadMultiDir`; warn per gap. (2) Replace 60s timer with `tickRelayConnected` boolean; set on WS connect/close in `live-bars.ts`. (3) Replace 15% ratio with tick-size check: `|price - ref| / TICK_SIZE > MAX_TICK_DEVIATION (50 ticks)`. (4) Cut `TTL.continuous` from 45→5s; call `cacheInvalidate(symbol)` on `bar_persisted`. (5) Gap spacers skip when `prevRth !== currRth` (session boundary) or `gapSec >= 4*3600` (overnight/weekend). (6) Proxy `IMBALANCE_THRESHOLD` 1.5→3.0. (7) Add `ResizeObserver` on `containerRef` to call `drawAll` on canvas resize.
- Confidence: high

**[2026-05-17] — Footprint imbalance threshold + giant teal band fix**
- Observation: `IMBALANCE_THRESHOLD = 3.0` is the mathematical maximum of the proxy bid/ask ratio (max ratio = `0.75/0.25 = 3.0`). Only 1 level per candle fires, stacked clusters (≥2 consecutive) never form → no bright highlighting, no imbalance stripe visible.
- Action: Lower proxy threshold from 3.0 → 2.0. At 2.0, ~41% of body levels flag as imbalanced (relPos ≤ 0.415 means buyRatio ≥ 2.0), creating stacked clusters that activate `#22c55e` text and `#15803d` left stripe. Keep comment explaining the math so future editors don't raise it back.
- Observation: Vector signal band overlays (`rgba(38,166,154,0.06)` per band) accumulate alpha via canvas layering. Many historical signals at the same price level stack to 60–90% opacity — appearing as a "giant solid teal vertical rectangle" in the chart area, especially after a contract roll (many signals from old contract era at same price band).
- Action (two-part): (1) In `CandlestickChart.tsx` band overlay loop, call `ts.getVisibleRange()` and `series.coordinateToPrice()` before the loop; skip any band whose time range ends before the visible window or whose price range is entirely outside the visible price scale. (2) In `market.tsx`, pass `vectorSignals.slice(-15)` to `computeVectorTradeOverlays` so at most 15 bands accumulate. Max alpha = `1 - 0.94^15 ≈ 60%` — visible but not opaque.
- Confidence: high

**[2026-05-18] — MW study reconnection + WebSocket dead-connection fix**
- Observation: After a server restart, the MW TickRelay and AutoTrader studies' WebSocket connections die. The server had NO ping/pong on `/ws/mw-feed`, so dead connections were never detected. `tickRelayConnected` could stay `true` permanently, suppressing the disk-file heartbeat indefinitely — chart goes dark. The order-commands ping existed but never terminated unresponsive sockets (`ws.on("pong", () => {})` was a no-op).
- Observation: `bulk_bars` handler was storing timestamps directly — if MW sends ms-precision timestamps (13-digit), they'd be stored as garbage in the DB (column expects seconds). Added `b.t > 10_000_000_000 ? Math.floor(b.t/1000) : b.t` normalization before validate+persist.
- Action: Added `isAlive` ping/pong with 15s termination to mwWss connection handler. On `terminate()`, the `close` event fires → `setTickRelayConnected(false)` → disk fallback resumes. Added `socketAlive Map<WebSocket, boolean>` to order-commands; ping now terminates sockets that miss a pong. Both fixes ensure stale connections are cleaned up after one missed heartbeat cycle.
- Action: When MW studies do NOT auto-reconnect after server restart, user must remove and re-add the study in MotiveWave (right-click chart → Remove Study → re-add TickRelay / AutoTrader) to re-establish the WebSocket.
- Confidence: high

**[2026-05-18] — ALL MW studies hardcoded to port 5000, server runs on port 3000**
- Observation: TickRelay, LiveBarRelay, AND AutoTrader Java studies all connect to `ws://localhost:5000/ws/...`. The server runs on port 3000. This means ALL three studies were NEVER connecting to the server since the port mismatch was introduced. "AutoTrader not connected" and "chart not live" were both caused by this — not by the ping/pong changes.
- Action: Added a second minimal HTTP server on port 5000 (bound to 127.0.0.1) inside `setupLiveBars`. It handles only WebSocket upgrades for `/ws/mw-feed` and `/ws/order-commands`, forwarding them to the same mwWss and orderWss instances. The main port 3000 server is unchanged. DO NOT change the MW study Java source (it's in the DO NOT TOUCH folder). DO NOT change the server's main port from 3000.
- Confidence: high

**[2026-05-20] — Corrupt candles in DB: MW float32 bar file misreads**
- Observation: MW `.bar_data1` binary parser occasionally produces corrupt float32 OHLCV values. Two failure modes: (1) entire bar body is ~150-450pts below its temporal neighbors (isolated stray candle); (2) low or high field is ~75-100pts outside the open/close range (massive wick spike while body is normal).
- Observation: 417 corrupt MES bars found across all resolutions. Detection method: neighbor-median deviation >120pts for isolated bars (or >400pts for any cluster), PLUS wick extension >75pts on 1m/5m bars. The `bulkUpsert` wick-filter threshold (1.5% of price) was just above the corrupt wick values (~1.35-1.49%), so they slipped through.
- Action: Deleted 417 corrupt rows from `data/app.db` (backed up to `data/app.db.bak`). Added resolution-aware wick guard to `bulkUpsert`: `maxWickPct` = 0.9% for 1m, 1.2% for 5m, 2.5% for 60m. Any bar where lower/upper wick exceeds these thresholds is rejected before DB write.
- Action: Removed all gap spacer code from CandlestickChart.tsx. WhitespaceData import removed; barIntervalSec detection loop removed; GAP_THRESHOLD_SEC removed; spacer insertion loop removed. User wants zero gaps including overnight/weekend.
- Confidence: high

**[2026-05-18] — No-body dot candles + fake huge candle spikes**
- Observation: DB contained 2,934 flat bars (open=high=low=close, zero range) from MW binary files during low-activity ETH periods — these render as single dots in lw-charts. DB also contained 45 doji-wick spike bars with 1.5-5% spread where body <10% of range — a corrupt float32 byte in the `.bar_data1` file creates an extreme wick while open/close stay near real price, appearing as a tall teal/red column on the chart.
- Root cause: `bulkUpsert` only checked `(high-low)/close ≤ 0.05` (5% spread), which passed both flat bars (spread=0%) and doji-wick bars (e.g., 4.96% but with 99% wicked). The `.bar_data1` parser's `low > open` / `high < open` checks don't catch wicks where open≈close near the true price.
- Action: (1) In `baseCandles` and `allBarsForVector` in market.tsx, changed `c.high >= c.low` to `c.high > c.low` (rejects flat dot bars) and added doji-wick filter: `if (range/c.close > 0.015 && Math.abs(c.open-c.close)/range < 0.10) return false`. (2) Same filter added to `bulkUpsert` in mw-reader.ts to prevent future corrupt bars entering DB. (3) Same strict `>` applied to `windowedCandles` live bar filter for transient forming-bar dots.
- Confidence: high

**[2026-05-18] — Phantom spike-and-return bars: third category of corrupt MW data**
- Observation: After deleting all flat bars (16,321) and doji-wick bars (148) from DB, huge-candle artifacts still appeared on the 15m chart. Root cause: a third corruption type — "phantom spike-and-return" bars — where BOTH the bar's price LEVEL is wrong (not just a wick). The midpoint `(open+close)/2` deviates >1.5% from `(prev_close + next_open)/2`. These bars have LARGE bodies (body/range 96%+), so the doji-wick filter (body/range < 10%) never triggers. The 20% neighbor-close filter is also too loose: a bar with low=6749 when prev_close=6972 passes because 6749/6972=0.968 > 0.80.
- Action: (1) Deleted 1,104 phantom bars from DB via Node.js script using `prev_close + next_open` neighbor context. MES/1m: 517, MES/5m: 311, MES/60m: 272, ESM6/5m: 2, ES/1m: 1, ES/5m: 1. DB reduced to 204,312 rows. (2) Added phantom-bar second pass to `baseCandles` in market.tsx AFTER the 20% neighbor check. Two sub-types: close-type (dEnd = `|next.open - cur.close| / cur.close > 0.005`) and open-type (`|gapDir|/pc > 0.01 AND sign(barDir) != sign(gapDir)`). Only rejects when `midDev > 1.5%` AND (close-phantom OR open-phantom). (3) Added same phantom detection to `bulkUpsert` in mw-reader.ts: sort `clean` by time → second loop with neighbor context → reject phantoms before DB insert. Prevents re-insertion when MW bar files are re-read.
- Confidence: high

**[2026-05-18] — Client-side filter alone insufficient — must delete bad bars from DB**
- Observation: Even with client-side doji-wick + flat-bar filters in `baseCandles`, bugs persisted after hard refresh. Root cause: (a) Client filters run on data already fetched from DB — they can't fix bad data that ALREADY IS in the DB if the user has a stale server cache. (b) 15m aggregation in `candleData` useMemo runs `agg5mTo15m(rawCandleData.candles)` on RAW unfiltered 5m bars. A doji-wick 5m bar (e.g., low=6272 stuck value, real price=6925) aggregated with surrounding bars that have a large body can produce a 15m bar where body/range > 10%, slipping past the doji-wick threshold entirely. (c) `fetchGapCandles` WS handler used non-strict `c.high < c.low` (not `<=`), letting flat bars into liveCandles.
- Action: (1) `DELETE FROM cached_candles WHERE high = low` — removed 16,321 flat bars from ALL symbols/resolutions. (2) `DELETE FROM cached_candles WHERE high > low AND (high-low)/close > 0.015 AND ABS(open-close)/(high-low) < 0.10` — removed 148 doji-wick bars. Total: 16,469 bad bars purged. (3) Fixed 15m pre-aggregation filter: in `candleData` useMemo, filter raw 5m bars with flat+doji-wick check BEFORE calling `agg5mTo15m`. (4) Fixed `fetchGapCandles` and `allBarsForVector` live-merge to use strict `<= ` for flat-bar rejection.
- Confidence: high

**[2026-05-18] — Overnight ETH bars invisible at zoom-out = apparent "gaps"**
- Observation: After deleting all phantom/flat/doji bars, chart still showed blank horizontal spaces between candle clusters. Root cause: MW started recording 24/7 in ~Dec 2025. The recent months (Jan-May 2026) have ~35 ETH 15m bars per overnight period between RTH sessions. ETH candle body+wick both used `#26a69a70` (44% opacity on a near-black #05080d background). At any zoom where the price range per ETH bar is < 1 point (~0.5% of chart height), the wick height is sub-pixel and appears completely invisible → the ETH period between RTH sessions looks like blank gap. Older months (Sep-Oct 2025) had 4-6 bars/day total with NO overnight ETH bars, so they appeared continuous.
- Action: (1) ETH wicks now use `t.wickUp`/`t.wickDown` (full-opacity RTH wick colors) instead of the transparent `upEth`/`downEth`. This makes ETH wicks always visible regardless of price move size. (2) Added session boundary markers to `drawAll`: dashed vertical lines (`rgba(90,120,160,0.30)`, [3,4] dash) drawn at every RTH↔ETH transition in `sortedCandlesRef.current`. These visually delineate where each session starts/ends even when zoomed out far.
- Confidence: high

**[2026-05-18] — Refresh button: two bugs (spinner hung + gap in chart after refresh)**
- Observation 1: Clicking Refresh sent `POST /api/admin/reload-mw` which called `await reloadAll()` on the server. `reloadAll()` reads 300 days of tick files and can take 20-30s. Client awaited the response indefinitely → spinner never stopped.
- Action 1: Made `reload-mw` respond immediately (`res.json()` before any await). `reloadAll()` runs in the background via fire-and-forget promise. `cacheFlushAll()` is called both immediately (so the client's next refetch hits the DB) and again after the background reload writes new data. Removed `async` from the route handler since there are no awaits.
- Observation 2: After `setLiveCandles([])` was called in `handleRefresh`, `setWsReconnectKey` fired immediately. The WS reconnected before React re-rendered and the candle `useEffect` rebuilt `_compPairs`. A WS tick arriving during this window used stale `_compPairs` (still had high indices from the previous live bars), placing the forming bar many slots ahead of the last base bar → visible gap in the chart.
- Action 2: Moved `setWsReconnectKey(k => k + 1)` to AFTER `await fetch("/api/live/bar/${sym}")`. The network await yields to the microtask queue, letting React re-render and the candle `useEffect` rebuild `_compPairs` from base-only data. Ticks received after reconnect now use the correct index, placing the forming bar at `lastBaseIndex + 1` with no gap.
- Confidence: high

**[2026-05-20] — DB refresh didn't update chart OHLCV + "Value is null" lw-charts crash**
- Observation 1: After clicking Refresh, `structKey` in CandlestickChart was purely timestamp-based (`first-last-count`). If the DB refresh corrected OHLCV of existing bars but timestamps stayed the same, `structKey` was unchanged → `structChanged = false` → fast path only called `series.update()` on the last bar. Historical corrections were silently ignored.
- Action 1: Added `refreshKey?: number` prop to CandlestickChart. Parent increments it on every handleRefresh call. Chart tracks `prevRefreshKeyRef`; any change forces `structChanged = true` regardless of structKey. Added `refreshKey` to the chart `useEffect` dependency array.
- Observation 2: DB rows with NULL OHLCV (SQLite returns null at runtime even though TypeScript declares `open: number`) passed directly to lw-charts `series.setData()`, triggering "Value is null" at SeriesBarColorer.Candlestick.
- Action 2: Added `Number.isFinite()` guard: skip any bar where `!Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)`. Use `Number.isFinite` not `c.open == null` — the latter fails TypeScript strict mode on `number` typed fields; `Number.isFinite(null)` returns false without TS errors.
- Observation 3: The 10s gate `if (Date.now() - lastRefreshMsRef.current < 10_000) return` in the `data_updated` WS handler was blocking the bulk_bars data_updated that arrives ~5s after refresh (the exact window when MW reconnects and sends fresh data).
- Action 3: Changed gate to `if (!isPostReload && Date.now() - lastRefreshMsRef.current < 10_000) return`. `isPostReload` is set true immediately after the reload POST and cleared after the gate window passes.
- Confidence: high

**[2026-05-20] — Live corrupt bars slip through 2000-tick threshold + corrupt-open bars bypass body-anomaly check**
- Observation: `MAX_TICK_DEVIATION = 2000 ticks` (500 pts) was too loose — corrupt float32 ticks at ~199 pts deviation (796 ticks) slipped through. These created 1m/5m bars with prices 200 pts below true market (e.g., 7183 when market was at 7382). Separately, the LiveBarRelay (bulk_bars path) can send completed bars where the OPEN is corrupted but CLOSE is correct (e.g., O=7280, C=7446), making the mid-price ≈ correct — the body anomaly filter misses these because mid deviation is only 0.9%.
- Action 1: Lowered `MAX_TICK_DEVIATION` from 2000 to 600 ticks (150 pts). Added 30-minute gap bypass: first tick after >30 min of silence skips the check (allows legitimate session gap-opens without blocking the corruption filter during active trading).
- Action 2: Added open-deviation guard to `persistCompletedBar5`: if the new bar's open deviates >2% from the previous bar's close AND the gap is <30 min, reject the bar. Uses `latestBar5` in-memory cache (no DB read). Catches the 7280-open/7446-close corrupt-open pattern.
- Confidence: high

**[2026-05-20] — Body anomaly detection was missing from bulkUpsert reloadAll path**
- Observation: Batch body anomaly detection (trimmed-mean of ±10 neighbors, reject if mid-price >2.5% off) was added to the `live-bars.ts` bulk_bars handler but NOT to `bulkUpsert` in `mw-reader.ts`. The `reloadAll()` / `loadAll()` disk-file path could re-insert the same corrupt body-anomaly bars on every server restart, since MW bar files are re-read from disk.
- Action: Added the same batch body anomaly filter to `bulkUpsert` in `mw-reader.ts`, between the phantom-bar pass and the DB insert loop. Uses identical logic: trimmed-mean of ±10 neighbors, 20% trim, reject if deviation >2.5%. Logs count of rejected bars per call.
- Confidence: high

**[2026-05-20] — AutoTrader OCO bracket order design is correct**
- Observation: AutoTrader.java submits entry + stopOrder + tp1Order + tp2Order together via `submitOrders()`. TP1 is `qty/2` contracts, TP2 is the remaining `rest = qty - qty/2` contracts, stopOrder uses full `qty`. When TP1 fills (partial close), MW adjusts the stop order quantity to match remaining position — this is native bracket behavior.
- Observation: `onPositionClosed` fires when the position fully closes (SL hit, or both TPs filled). It calls `cancelAllOrders(ctx)` which tries `cancelAllOrders`, `cancelAll`, `flattenAll`, `cancelOpenOrders`, `cancelOrders` (zero-param methods) in order. This handles cleanup of any surviving bracket legs.
- Action: No code changes needed. The OCO behavior is correctly implemented via MW's native bracket order system + `onPositionClosed` fallback. DO NOT try to manage OCO server-side — MW handles it at the order level.
- Confidence: high

**[2026-05-20] — iPhone signals didn't match PC: missing server zones**
- Observation: iPhone `computeSignals` used only manually-imported zones (`zonesRef.current`). PC fetches zones from `GET /api/discord-zones`. With no zones loaded, `milkPtsL/S = 0` for all signals → all iPhone signals were RISKY or RISKIEST, never SAFE/SAFE+.
- Action: Added zone fetch inside `load()` in chart-view.tsx: `GET /api/discord-zones?from_ts=X&to_ts=Y&symbol=SYM`. Transform response to `ParsedZone` format using same `rthSettleOfDay` logic as PC (fromTime=posted_at, toTime=rthSettleOfDay(posted_at)). Merge server zones with manually imported zones. Pass merged zones to `computeSignals` AND `window.setZones()` for visual display.
- Observation: PC is the authoritative signal source. iPhone `computeSignals` is a port — keep it in sync with market.tsx.
- Confidence: high

**[2026-05-20] — iPhone chart "server disconnected" + live feed indicator**
- Observation: Any fetch error that didn't match `/50[23]|network request failed|failed to fetch/i` (e.g., iOS TLS errors, HTTP 500, timeout) would display the raw error string permanently with NO retry. The chart stayed stuck on "The certificate…" or "HTTP 500" indefinitely.
- Observation: WebSocket `onclose` in the WebView's `connectLive` silently reconnected after 5s with no user feedback. User had no way to know whether the live feed was connected, reconnecting, or broken.
- Observation: iPhone `computeSignals` had the same milk zone time-bounding bug as the PC code: `c.time < (z.fromTime ?? 0)` with `fromTime=0` meant static zones (Donchian, session open) matched ALL historical candles.
- Action: Made ALL catch-block errors retry with exponential backoff (max 15s). Error message now uniformly shows "Server disconnected — retrying in Xs…" regardless of error type.
- Action: Added `#live-badge` div (bottom-left, `position:fixed`, z-index 30) with `setLiveBadge(true/false)` helper. Shows "● Live" (green) on `liveWs.onopen`, "○ Reconnecting…" (amber) on `onerror`/`onclose`. Shown after first connection attempt; badge is non-blocking (chart stays visible underneath).
- Action: Fixed iPhone milk zone check: `if (!(z.fromTime ?? 0) || c.time < z.fromTime || (z.toTime != null && c.time > z.toTime)) continue;` — same fix as PC.
- Confidence: high

**[2026-05-20] — Zone time-bounding + zonesLoaded indicator + pattern recognition removal**
- Observation: Zones with `fromTime=0` (static structural levels like Donchian/session open) matched ALL historical candles via `c.time < 0 → false`. This caused historical signals to show `milkOk=true` even though no dated session zone was present at that candle's time.
- Action: Added `fromTime > 0` guard to ALL zone loops in `market.tsx` and `SignalsPanel.tsx`. Only MWML/Discord zones with explicit session dates now count for milk zone confirmation. Static zones (gold box, Donchian, session open) are excluded.
- Action: Added `hasDatedZones = activeZones.some(z => z.fromTime > 0)` before the main signal loop. Each signal push now includes `zonesLoaded: hasDatedZones`. SignalDetail panel shows a green "Zones Active" / grey "No Zones Loaded" badge so the user knows whether dated zones were available when the signal computed. If milkOk=true but zonesLoaded=false, a warning is shown.
- Action: Deleted pattern recognition entirely (pure tabletop, side-entry tabletop, tabletop breakdown retest, `findPatternMatches`, `buildPatternVec`, `PatternMatchResult`). Pattern pts removed from scoring. Footprint remains the primary non-milk confirmation (strong=4pts, partial=2pts). Score: FP=4/2 | MilkZone=3 | Vector=2.
- Confidence: high

**[2026-05-20] — "No signals on both programs" — symbol mismatch + risk level filter**
- Observation: PC saves signals to DB with `symbol: selectedSymbol` (e.g., "MES1!"). iPhone fetches with `instrument.toUpperCase()` (also "MES1!"). But the DB had 3,797 signals saved as "MES" (no contract code) from prior sessions. GET/POST routes did `sym.toUpperCase()` only — no normalization. Result: "MES1!" fetch found 0 rows even though 3,797 equivalent signals existed under "MES".
- Observation: Default `chartRiskLevel = "safe"` in market.tsx filtered out "risky" and "riskiest" signals from the SignalsPanel. Without Discord zones loaded, most signals score ≤ 3 pts (fpPts=2 + vecPts=2 only fires when BOTH conditions hit the same candle), so many signals are "risky". User saw blank SignalsPanel and thought no signals existed — chart dots (riskiest = radius 5, alpha 0.35) were too small to notice.
- Action: (1) Added `normalizeSignalSymbol` helper in routes.ts: strips non-letter chars, removes trailing month-code letter (H/M/U/Z). "MES1!" → "MES", "MESM6" → "MES", "ESM6" → "ES". Applied to both GET and POST `/api/signals/history` routes. DB now unifies all contract-code variants under the base symbol. (2) Changed `chartRiskLevel` default from "safe" to "risky" so signals show even when zones aren't loaded. (3) Changed iPhone chart-view.tsx signal fetch to use `sym` (already stripped symbol, e.g. "MES") instead of `instrument.toUpperCase()` ("MES1!") — belt-and-suspenders with server normalization.
- Confidence: high

**[2026-05-20] — iPhone chart mismatch + no live + no signals: all caused by compressed timeline**
- Observation: `DayTrading/components/chart-view.tsx` used sequential integer bar indices (`_timeToIdx`/`_idxToTime`) as the lw-charts `time` field instead of real Unix timestamps. This caused three simultaneous failures: (1) Chart looked different from PC because the time axis used 0,1,2… instead of real times — different gaps and label spacing. (2) Live ticks silently dropped because `connectLive` used `_timeToIdx[liveLastBar.time]` and when a NEW bar formed (timestamp not yet in the map), `tickIdx === undefined` so `candleSeries.update` was never called. (3) Signals all dropped because `setSignals` did `var sigIdx = _timeToIdx[s.time]; if (sigIdx === undefined) continue;` — DB signal timestamps that weren't in the loaded candle window (or any mismatch) caused every marker to be skipped.
- Action: Removed all `_timeToIdx`/`_idxToTime`/`_tToIdx` compressed-timeline code. All functions now pass real Unix timestamps directly: `setChartData` uses `{ time: c.time }`, `setSignals` uses `{ time: s.time }`, tick updates use `{ time: liveLastBar.time }`, bar updates use `{ time: bar.time }`, `drawYellowBox` calls `ts.timeToCoordinate(yboxSessionStart)` directly, `scrollToTime` uses `chart.timeScale().setVisibleRange()` with real timestamps. Added `markers.sort((a,b) => a.time - b.time)` before `setMarkers` since lw-charts v4 requires sorted order. Note: `prependChartData` previously used `_idxToTime` to recover real timestamps from `storedCandles`; after fix, `storedCandles` already holds real-time objects so concat is direct.
- Confidence: high

**[2026-05-20] — iPhone signals tab showed "Switch to Chart to load signals" always**
- Observation: `ChartView` was conditionally rendered (`{segment === 'chart' ? <ChartView> : <View>}`). Switching to the Signals tab unmounted `ChartView`, cancelling in-flight data loads (setting `cancelled = true` in the useEffect cleanup). `onSignals` was never called if the user switched before the 8s signal fetch completed. `chartSignals` state stayed empty. Switching back to Chart caused ChartView to remount and restart from scratch.
- Action: Changed to always render ChartView but hide it with `display: 'none'` when on the signals tab: `<View style={{flex:1, display: segment==='chart'?'flex':'none'}}>`. React Native's `display:'none'` hides the component without unmounting it, keeping the WebView alive and the data load running in the background.
- Confidence: high

**[2026-05-20] — iPhone chart showed wrong/old price data vs PC**
- Observation: iPhone candle fetches had no `from`/`to` query parameters, returning ALL historical data: 161,627 1m bars (~16MB JSON) and 36,501 5m bars. The PC uses a 60-day window (`from`/`to` computed from `windowedDays`). (1) The 16MB 1m bar response would often fail the 15s timeout, so vectors were computed from 5m bars instead — producing different vector values from PC. (2) The initial chart showed 1000 most recent bars (correct) but as prependChartData loaded historical chunks, if the view shifted, the user saw old prices from Sep 2025 (~5700) instead of May 2026 (~7400).
- Action: Added `from=${nowSec - 90*86400}&to=${nowSec+86400}` to both the display candle fetch and the 1m bar fetch. Reduces 1m from 161k to ~13k rows, 5m from 36k to ~3k rows. Chart data now matches PC's 60-90 day window. Same PC fix pattern: `fromTs = nowSec - 90 * 86400`.
- Confidence: high

**[2026-05-21] — 4-section implementation: Current Trade tab, zone directional fix, ML feedback**
- Observation: `display:'none'` on WebView (iOS) prevents native WKWebView layer creation — `chartReady` never fires, data never loads. Fixed: use `opacity:0`+`pointerEvents:'none'` instead, inside a `flex:1` wrapper with `StyleSheet.absoluteFillObject`. This keeps the native layer alive while hiding the view.
- Observation: DB outcome strings are prefixed (`win_tp1`, `win_tp2`, `win_trailer`, `loss`). iPhone code was checking bare strings (`tp1`, `tp2`, `sl`). All outcomes appeared as "Open". Fixed with dual-format boolean flags covering both conventions.
- Observation: `isBullZone()` in both `market.tsx` and `SignalsPanel.tsx` used color-only detection. This failed for MWML zones with neutral/unclear colors. Fixed: added label-text parsing as the PRIMARY classifier — bear keywords (sell/resist/ceiling) take priority over bull keywords (buy/demand/floor). Color is the fallback.
- Observation: Zone "currently IN" scoring was indistinguishable from "just touching bottom" in the milk zone check. Both scored 3 pts. Added 4-pt score for close inside [bottom, top], so zones where price is actively inside get priority over zones just touched.
- Action: Added `signal_labels` table to DB for server-side persistence of user feedback (reason + note + markedBad). Previously annotations were localStorage-only — lost on new browser session.
- Action: Added reason dropdown (8 predefined failure reasons) to SignalDetail edit mode. Annotations now save to both localStorage and `/api/signals/label` server endpoint.
- Action: Confidence score (0-100%) now displayed in signal table rows as a small colored badge (green ≥90, amber ≥75, grey otherwise).
- Action: Added `CurrentTrade` state to `trade-state.ts`. `/api/trade/current` GET returns active trade; set automatically when AutoTrade fires via `/api/trade/execute`. New iPhone `trade.tsx` tab polls this every 5s and shows direction, levels, R:R, elapsed time, and a visual price bar.
- Confidence: high

## Open Questions

- ~~Should the 1m vector be shown on the 5m chart?~~ **Resolved**: Added secondary `useQuery` for 1m data enabled when `showVector && fetchInterval !== "1m"`. All 4 vectors now show on all charts.
- Is the `persistCompletedBar5` function writing duplicate data? It writes to both "5" and "1" resolutions from a 5m bar, but live-bars.ts also calls `persistBar()` on `bar.complete`. May be double-writing.

---

- **Risk tier restructure: SAFE = milkOk alone (with vector gate)** — Previously required 2 votes (milkOk + secondaryVecOk) to reach "safe". Under new spec, the vector gate is always the prerequisite for confluence signals, so milkOk=true is sufficient for SAFE. Change: `longVotes >= 2 ? "safe"` → `milkBullOk ? "safe" : secLongOk ? "risky" : "riskiest"`. This upgrades signals that were previously RISKY (milkOk=true but secOk=false) to SAFE.

- **Strategy guard uses SHA-256 of raw JSON file content** — `crypto.createHash("sha256").update(content, "utf8").digest("hex")`. Hash is computed at init and stored in memory. 60-second interval re-reads files and compares hashes. `authorizedUpdate()` writes new content then updates the stored hash so the next check doesn't flag it.

- **Signal levels must be locked on first fire** — `allConfluenceSignals` is a `useMemo` that recomputes on every candle update. Without `lockedSignalLevelsRef`, the live bar's `c.close` drifts on every tick, shifting TP/SL/entry mid-bar. Fix: `useRef<Map<string, {price,tp1,tp2,sl}>>` keyed by `${time}_${direction}`; first fire writes the lock, subsequent recomputes read it. Never recompute from `c.close` after the lock is set.

- **Zone type label matching O(N×M) → O(log M) with LabelIndex** — The naive `_find_best_label` iterating all 19K labels for each of 14K zones per file = ~280M iterations per file × 23 files = too slow to ever complete. Fix: sort labels by price once into a `LabelIndex`, then use `bisect.bisect_left/right` to narrow to price-range candidates before time filtering. Runs in seconds instead of never.

- **Milk's zone vocabulary (28,709 zones, 23 files)** — The MWML files contain exact zone type labels as `comment` figures paired with each `supportResist` zone. Top types: pivot (2688), seller_objective (1902), floor (1761), ceiling (1589), buyer_objective (1447), non_fair_value (1061), buyer_positioning (751), seller_positioning (742), iv_wall (657). 75% labeled, 25% unknown (neutral zones with no nearby text label). Zone type + strength tier are now ML features; GradientBoosting replaces RandomForest for better handling of categorical zone_type_code.

**[2026-05-20] — Periodic float32 body-anomaly bars: one every ~512 minutes**
- Observation: After initial cleanup (417 bars deleted in prior session), MW float32 corruption continued writing new corrupt bars. 26 more corrupt bars found across 1m/5m/60m resolutions (12+11+3). Pattern: bars appear approximately every 512 minutes (8.53 hours) across calendar time, all with full-body displacement ~3-4% below real price (e.g., ~7145-7185 while surrounding bars are at ~7395-7415). The body looks normal in isolation (3-5 pt range) so wick and flat-bar filters miss it. Client-side phantom-bar filter is unreliable when multiple consecutive bars are corrupt or when the corrupt bar is at the edge of the dataset.
- Action: Deleted 26 bars from DB. Added batch-level body anomaly pass to `live-bars.ts` bulk_bars handler: sort the batch, compare each bar's mid-price to trimmed mean of ±10 neighbors; reject if deviation >2.5%. Only fired during bulk_bars (has batch context); individual bar messages don't have enough neighbors to apply this check.
- Action: Also added `Number.isFinite` guard in `CandlestickChart.tsx` setData loop — `if (!Number.isFinite(c.open) || ... ) continue` — to prevent any null/NaN bar that slips through from causing lw-charts "Value is null" runtime crash.
- Confidence: high

**[2026-05-20] — Reload button blocked by 10s gate it was meant to bypass**
- Observation: `handleRefresh` sets `lastRefreshMsRef.current = Date.now()` then hits the server, which terminates MW WS connections → study reconnects → sends bulk_bars → server persists → sends `data_updated`. The `data_updated` handler had `if (Date.now() - lastRefreshMsRef.current < 10_000) return` — this unconditionally blocked the very bulk_bars `data_updated` that the reload was trying to use (arrives ~5s after click). The prior session added a 60s post-reload window check but forgot to guard the 10s block with it.
- Action: Changed `if (Date.now() - lastRefreshMsRef.current < 10_000) return` → `if (!isPostReload && Date.now() - lastRefreshMsRef.current < 10_000) return`. The 10s debounce now only fires during normal operation (no recent refresh), not during the 60s post-reload window.
- Confidence: high

**[2026-05-18] — Compressed timeline reverted: chart now uses real unix timestamps**
- Observation: Compressed bar-index timeline (`_toChartTime`/`_toActualTime` maps) caused a race-condition gap: after `setLiveCandles([])` in handleRefresh, WS ticks arrived before React re-rendered and rebuilt `_compPairs`, so the live bar was placed at the wrong index (stale high index) → visible gap between base bars and live bar. Also, the compressed timeline produced a chart that looked nothing like MotiveWave/PC, since both use real timestamps.
- Action: Removed the entire compressed timeline block (module-level `_actualToComp`, `_compToActual`, `_actualPairs`, `_compPairs`, `_bisect`, `_toChartTime`, `_toActualTime`). Chart now uses real unix timestamps throughout. Whitespace spacers (3 entries at `barIntervalSec` intervals) are inserted at session breaks (`gap > barIntervalSec * 2`), matching PC gap-spacer behavior. `updateLastBarClose` new-bucket branch directly calls `series.update({ time: bucketSec as any, ... })` — no map extension needed.
- Confidence: high

---

## Milk Zone Vocabulary (learned from daily charts)

Milk draws zones at market open each day. These are fixed predictions — they do NOT move after the open. If price misses a zone, that is new information, not an error.

**Zone type definitions (learned from uploaded charts):**

| Zone Label | Color | Meaning |
|---|---|---|
| IV WALL | Dark red, top | Implied Volatility ceiling — major resistance cap for the day |
| LARGE SELLER POSITIONING | Large dark red block | Heavy institutional selling zone; strong rejection expected |
| SELLER POSITIONING | Red/maroon zone | Standard seller zone; expect resistance / short opportunity |
| TOP SIDE BARRIER / PIVOT | Label on resistance | Structural pivot; key decision level |
| NON FAIR VALUE | Bright green zone | Price is outside fair value here; mean-reversion bias |
| BUYER POSITIONING | Green zone (lower) | Institutional buying zone; expect support |
| BUYERS BUY TARGET ON RNGUP | Yellow line | Projected buy-side target if range expands upward |
| SELLERS SELL TARGET ON RNGDN | Yellow line | Projected sell-side target if range expands downward |
| SELLERS SOFT TARGET ON RNGDN | Secondary yellow line | Weaker/secondary seller target |
| MILK TREND DATA | Bottom zone | Trend reference; where trend support lives |
| BID GAP / BID GAP TOP | Lines | Gap fill levels from prior session |

**Color coding:**
- **Dark red / maroon blocks** = seller zones, resistance
- **Bright green blocks** = non-fair-value or buyer zones
- **Yellow/white horizontal lines** = projected target levels
- **Purple/olive text** = Milk's structural annotations

**Key methodology lessons from charts:**
- Zones are drawn from STRUCTURE (order blocks, FVG, prior highs/lows, implied vol levels) — not indicators
- "Non Fair Value" means price WILL likely revisit the zone; it's not a signal to fade immediately but a magnet
- Seller Positioning + IV Wall stacked = very strong cap; two confluent seller zones reinforce each other
- When price is IN a Non Fair Value zone, expect choppiness; clean signals come at zone EDGES, not middles
- Targets (SELLERS SELL TARGET ON RNGDN) are where Milk expects price to reach IF the daily range extends — not guaranteed, but where momentum carries to

---

## Session Log

**2026-04-19 — Taught by User**
- **Resistance Within TP1 Range**: A long signal failed because a resistance zone at 7165.50 sat only 2.5 pts above entry, effectively blocking price before reaching TP1 at 7166.00 and creating an unfavorable reward structure.
  - Action: Skip any long signal where a resistance level exists within 1.0 pt of TP1 (or between entry and TP1), unless price has already broken and closed above that level on the signal interval before entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-19 — Taught by User**
- **Multi-Zone Resistance Block on Incomplete Confirmations**: When price must travel through multiple resistance zones to reach TP1 and the setup is missing both Milk Zone and Bullish Body confirmations, the probability of stalling before TP1 is high enough to invalidate the trade.
  - Action: Skip any Long signal rated "risky" where Milk Zone ✗ AND Bullish Body ✗ AND there are 2+ resistance zones between entry and TP1, regardless of Primary/Secondary Vector alignment.
  - Confidence: low (single observation — needs more data to confirm)

**2026-04-27 — Chart visualization + proxy footprint**
- **Chart shows old prices after lookback change**: When user changes the lookback slider (e.g. 30d→120d), `intervalKey={interval}` did not change, so `intervalChanged=false` and chart kept the old logical range pointing to Oct 2025 data. Fix: pass `intervalKey={\`${interval}-${windowSize}\`}` so any lookback change triggers the same zoom-reset path as an interval switch.
  - Action: Always include window/context size in `intervalKey` — any parameter that changes the dataset size should be part of the key so the chart resets to last 80 bars.
  - Confidence: high

- **`minBarSpacing: 0.1` causes solid-band compression**: With 3000+ candles loaded (120d of 15m data), `fitContent` / zoom-out collapses bars to sub-pixel widths, displaying as a solid colored band. Fix: `minBarSpacing: 1.0` so bars never go below 1px wide.
  - Action: Never set `minBarSpacing` below 1.0 — lw-charts v5 respects this across all zoom levels including fitContent.
  - Confidence: high

- **OHLCV proxy footprint (`buildProxyFootprintCandle`)**: When real tick-level footprint data is unavailable (no MotiveWave Java code), synthesize FootprintCandle from OHLCV structure: body gets 70% of volume (directionally biased 65/35), wicks get 30% (rejection bias). Proxy delta correctly captures bullish vs bearish pressure for divergence detection. Divergence veto (declining delta on new highs) is directionally valid with proxy — works as a "bearish body structure on new high" pattern filter. Prior candles are synthesized from `sorted.slice(i-4, i)` in the signal loop.
  - Action: Use `buildProxyFootprintCandle(c)` when `fpByTime.get(c.time)` returns null. Real data takes priority when available.
  - Confidence: medium (proxy is approximate; divergence veto may have higher false positive rate than real footprint)

- **Win rate fixes (2026-04-27)**: Four root causes identified and fixed:
  1. **Confidence threshold too low (60→80)**: zone(40)+primaryVec(20)=60 was passing with ZERO secondary confirmation. New threshold 80 requires at least one of: delta-confirmed proxy footprint (fpPartial weight raised 8→20), secondary vector, or full footprint. Pure zone+vector-alone now filtered.
  2. **Bearish candles triggered Long signals**: proxy footprint returns `fpPartial=false` for bearish bars (negative delta), so with threshold 80, bearish-close-in-zone = 60 < 80 → automatically filtered. No separate body check needed — the confidence math handles it.
  3. **Overhead resistance not affecting tier**: Was only setting `reclassifyReason` for display. Now: resistance within 5pts downgrades one tier (safe→risky, risky→riskiest), and riskiest+resistance signals are SKIPPED entirely (no upside room = bad R/R).
  4. **Backtest/monte-carlo no body check**: Added `c.close >= c.open` (longs) and `c.close <= c.open` (shorts) plus `!fp.deltaAgrees continue` to ensure only momentum-confirming candles enter.
  - Action: fpPartial weight stays at 20; threshold stays at 80. Do NOT lower threshold to chase signal count.
  - Confidence: high

- **backtest.tsx + monte-carlo.tsx aligned to strategy rules**: Added 3 missing filters to both backtest engines:
  1. **60m hard veto**: aggregate candles to 60m, build `vec60mMap`, detect decline phases, forward-fill to primary bars via `Math.floor(ts/3600)*3600` bucket key. Any bar in a declining-60m-vector phase skips ALL Long signals.
  2. **HOD suppression**: pre-compute `hodBeforeBar` map (running HOD per RTH day, excluding the current bar's high). Skip Long entries when `c.close >= prevHod - 5`. Uses pre-bar HOD so valid breakout bars that push price through the old HOD are not suppressed.
  3. **Proxy footprint divergence veto**: `buildProxyFootprintCandle(c)` + `analyzeFootprint(fpCandle, direction, priorFp, c.close)`. `fp.vetoed = true` → `continue`. Exit adjustments (POC stop, TP1 override, TP2 extension) applied to tp1/tp2/sl after signal fires.
  - These three filters mirror what `market.tsx` does for live signals — backtest results are now more calibrated to real strategy behavior.
  - Confidence: high


**2026-04-17 — Vector fix: RTH-only bug when showETH=false**
- **Observation**: `vectorLine` useMemo called `computeVectorLine(windowedCandles)`. `windowedCandles` is filtered by `showETH` — so when `showETH=false`, the vector was computed on RTH-only bars. This violates the rule in Patterns ("Vector computation uses ALL bars (RTH+ETH)"), causing staircase values that don't match MotiveWave.
- **Fix**: Added `allBarsForVector` useMemo that takes `candleData?.candles` (all bars, no ETH gate) + merges `liveCandles`, same outlier filter as `baseCandles`. `vectorLine` now uses `allBarsForVector` for computation and forward-fills to `windowedCandles` chart times for rendering. The `showETH` toggle now only affects candle DISPLAY, not vector computation.
- **Confidence**: high

**2026-04-17 — Discord feed: newest messages at bottom (chat style)**
- **Observation**: `[dm, ...prev]` prepended new messages, oldest-first rendered = newest at top. User wants chat-style (newest at bottom).
- **Fix**: `[...prev, dm]` appends; `data.messages.slice().reverse()` on load; `atBottomRef` tracks bottom; auto-scroll on new message when at bottom; "↓ N new" banner at bottom of panel; grouping uses `displayed[i-1]` (prev in oldest-first array).
- **Confidence**: high

**2026-04-17 — Milk Zones (uploaded by user)**
- **Date**: 2026-04-17 (ESM6, 5-min chart, Milk Yellow Box Strategy)
- **Price at upload**: ~7132.75 — trading ABOVE the TOP AVE RANGE / IV WALL / OVN SPY CEILING cluster at 7113.75 (bullish breakout structure)
- **Zone structure from top to bottom:**
  1. **W10 10MIN 10% BAND** (~7144.25–7146.25) — extreme outlier cap; only trade here on major momentum extension
  2. **1% ODDS AT AND ABOVE** (7136.96–7137.00) — statistical extreme; 99% of sessions end below this; hard fade zone
  3. **Structural line** (7125.25) — green horizontal structural reference
  4. **W10 10MIN 70% BAND / 5.36% ODDS** (7114.47–7116.50) — BUYERS ULTIMATE TARGET ON SESSION per chart label; 5.36% probability of reaching/exceeding; active resistance
  5. **TOP AVE RANGE "RESISTANCE" / IV WALL / OVN SPY CEILING** (7113.75) — KEY TRIPLE CONFLUENCE LEVEL; was capping prior sessions; after breakout above = now support
  6. **THUR PR SPLICE IMPRINT** (7108.75–7109.5) — Thursday prior-range splice level; structural reference
  7. **Clustered lines** (7105.75 / 7106.50) — minor structural
  8. **Purple zone** (~7090–7098) — imbalance/structural band; sellers defended here before breakout
  9. **PIVOT** (7078.00) — key decision level; sellers offside at/above; break below = confirm short; 7085.50 is a recent swing high near it
  10. **SELLER OBJECTIVE** (7067.5–7070.0) — sellers target; only loss of this confirms short direction
  11. **SUPPORT / BOTTOM AVE RANGE** (7054–7055.5) — buyers value add on test; supportive first attempts
  12. **SELLER OBJECTIVE cluster** (7054–7058) — seller target cluster overlapping support
  13. **NON FAIR VALUE / THUR PR SPLICE IMPRINTS** (7051) — orange dashes; NFV label; price will revisit if sellers gain control
  14. **PIVOTAL ZONE — BUYER POSITIONING / SELLER OBJECTIVE** (7034–7038) — 7036 is pivotal; buyers absorb sellers first test here; dual label = contested zone
  15. **SELLERS ULTIMATE TARGET ON SESSION / SELLERS OBJECTIVE** (7026–7030) — session low target if sellers win; S VECTOR ~7025.5 nearby
  16. **IV WALL (lower)** (7016.25) — lower IV wall boundary
  17. **FRI WEEKLY CEILING** (~7004.5) — weekly structural floor
  18. **BUYER POSITIONING (extreme)** (7000) — high probability outlier cap downside; ultimate buyer zone
- **Bias read**: Strong BULLISH breakout day. Price broke cleanly above the triple-confluence TOP AVE RANGE / IV WALL / OVN SPY CEILING (7113.75) and is targeting the W10 70% BAND (7114–7116) and potentially 7125. Sellers have statistical edge only at 7136.96+ (1% odds). Buyers defend any pullback to 7113.75 (prior resistance = new support). Shorts only valid on rejection at 7114.47–7116.50 with confirmed bearish structure.
- **Lesson**: When price trades above the TOP AVE RANGE "RESISTANCE" + IV WALL, that level flips to support — bias is long on pullbacks to 7113.75. Short only at the statistical caps (5.36% / 1% odds bands). DO NOT short into the middle of the range.
- **Lesson**: "W10 10MIN X% BAND" levels are statistical caps from Milk's implied-vol model — the % labels (1%, 5.36%, 10%) represent how often price EXCEEDS that level. Fade these levels, especially the 1% level. They define the day's maximum expected range.
- **Lesson**: SELLER OBJECTIVE at 7070 + PIVOT at 7078 cluster = if price pulls back to this area, short setups are viable only if 7078 breaks; above 7078, sellers are "offsides" and buyers remain in control.

**2026-04-17 — Trailer Exit Strategy added**
- Added "Trailer" as a fourth exit strategy option next to TP1/TP2 tiers in the settings panel.
- `EXIT_STRATEGY_PROFILES["trailer"]` uses the same RTH/ETH values as "risky" for activation levels. Removed `as const` since trailer needed a distinct runtime entry.
- `exitStrategy` type extended to `"safe" | "risky" | "riskiest" | "trailer"`. `trailerOffset` state (default 2.0 pts) persisted to localStorage.
- `walkForward` now branches on `exitStrategy === "trailer"`: Phase 1 walks until SL or TP1 activation; Phase 2 tracks `trailPeak` and exits when price retreats `trailerOffset` pts. Outcome `"win_trailer"` added to `CSig`.
- `allConfluenceSignals` useMemo now depends on `trailerOffset` and `lockedSignalLevelsRef.current.clear()` fires on both `exitStrategy` and `trailerOffset` change.
- Auto-trade fetch sends `useTrailer` + `trailingOffset` fields; routes.ts passes them to `broadcastOrderCommand`.
- **AutoTrader.java v17**: `PendingTrade` extended with `useTrailer` + `trailingOffset`. In trailer mode, `submitBracket` places only entry + SL (no TP1/TP2 limits). `onBarUpdate` monitors price: Phase 1 watches for TP1 activation, Phase 2 trails the peak manually. `trySubmitTrailingStop` attempts MW native `createTrailingStopOrder` (4 or 5 params) via reflection when TP1 is hit; falls back to manual tracking if the method doesn't exist. `resetTrailerState()` called on `initialize` and `onPositionClosed`.
- If both Trailer and TP2 are somehow active simultaneously, Trailer wins (enforced at `submitBracket` level — no limit orders placed in trailer mode).

**2026-04-17 — Taught by User**
- **Short Into Visible Support**: Trader shorted near a recognizable support zone with price already extended downward after a large prior candle, leaving minimal room before the support would absorb or reverse the move.
  - Action: Before entering any short signal, check for support zones within 2x the stop distance below entry (i.e., within 10 pts here); if a visible support level exists inside that buffer, skip the trade regardless of Primary Vector or Milk Zone confirmation.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-17 — Taught by User**
- **Resistance Proximity + Approaching Vector (No Entry)**: When price has not yet reached the vector and a resistance level sits within 1.5 pts above entry, the trade lacks room to breathe and the candle pattern confirms continuation toward the vector rather than a reversal off it.
  - Action: Skip any Long signal where (a) Bullish Body confirmation is absent, (b) Secondary TF Vector is absent, AND (c) a resistance level exists within 1.5 pts above entry — instead, wait for price to tag the vector and form a confirmed bullish signal there.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-17 — Taught by User**
- **Resistance Proximity TP Adjustment**: When a reclassify warning flags resistance within 4 pts of entry on a risky long signal, the original TP1 overshoots that resistance, turning a probable winner into a loss.
  - Action: On risky signals where resistance sits between entry and TP1 at a distance ≤ 4 pts, automatically cap TP1 at resistance minus 0.25 pts rather than using the standard TP1 target.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-15 — Data persistence and candle rendering fixes**
- **`DELETE FROM cached_candles` on startup was wiping all historical data** — `server/db.ts` line 86 ran this on every server start, destroying months of Polygon-downloaded candles. Fixed by removing the line entirely. MW's `onConflictDoUpdate` in `persistBulk`/`persistBar` already handles re-syncing live bars without a pre-wipe. Never add a table-wide DELETE on startup for tables that hold persistent user data.
- **Catch-up candle rejection in `bulk_bars`** — MW sends a history dump on reconnect. Added validation: each bar must have valid OHLCV (h≥l, all prices finite and >0) AND its timestamp must be aligned to the declared resolution interval (`t % intervalSec === 0`). Misaligned or invalid bars are logged and discarded. Same validation added to individual live bar messages in `live-bars.ts`.
- **Client-side interval-alignment filter** — `windowedCandles` now also checks `c.time % intervalAlignSec === 0` before merging live bars. A catch-up bar from a reconnect gap would land at an unaligned timestamp and corrupt the bar sequence; this prevents it from reaching the chart or signal computation.
- **Gap-fill on WS reconnect** — Added `fetchGapCandles()` called in `ws.onopen`. On reconnect, fetches the last 4 hours of candles from `/api/data/cached-continuous` and binary-merges them into `liveCandles`, filling any gaps that opened during the disconnect period without creating oversized catch-up bars.
- **Full JSON export/import added** — `GET /api/data/export-full/:symbol` exports all candles + locked signal levels for a symbol as a single JSON file. `POST /api/data/import-full` re-uploads it, appending candles and signals with `onConflictDoNothing` (never overwrites existing data). UI added to Data page as "Export [TICKER] JSON" + "Import JSON" buttons.

**2026-04-15 — Milk Zones (uploaded by user)**
- **Date**: 2026-04-15 (ESM6, 5-min chart, "ES Yellowstone" / Milk's Yellow Box Strategy study)
- **Zone structure from top to bottom:**
  1. **W WALL** — top cap; absolute ceiling for the session, hard resistance
  2. **Sell cluster (multiple stacked)** — several red/orange resistance zones below W Wall; sellers positioned above current price
  3. **NEGOTIABLE** — transition/buffer zone in upper-middle; price may chop through this area
  4. **MLK'S YELLOW BOX STRATEGY** (center label) — the yellow box zone; current structural level
  5. **NEW FAIR VALUE** (green zone) — new equilibrium level established after a range shift; acts as a magnet if price moves away from it
  6. **SECTOR OBJECTIVE** — downside target zone; where the move aims if sellers take control
  7. **BUYER POSITIONING** (teal, right panel) — institutional buy zone; expect support on retests
  8. **SELLER OBJECTIVE** (orange, right panel) — seller's measured-move target
  9. **SELLERS SOFT TARGET ON DIVISION** — secondary/weaker downside target line
  10. **W WALL** — bottom floor; absolute support cap for the session
- **Chart structure observation**: Significant selloff followed by V-shaped recovery. Price is consolidating in the middle zone (yellow box / new fair value area). Bearish resistance stacked above; buyer zones below.
- **Bias read**: Neutral-to-bearish. Price found a "NEW FAIR VALUE" level after a large move — this suggests the range has shifted. Longs are viable only at buyer positioning / W Wall bottom with strong confluence. Shorts viable on rejections from the sell cluster / negotiable zone above.
- **Lesson**: "NEW FAIR VALUE" zone appearing after a large V-move means Milk considers the prior range as mispriced — the new equilibrium is where we are now. Price inside New Fair Value = expect range-bound chop; wait for edges. Zone edges (top and bottom of New Fair Value) are cleaner entry points than the middle.
- **Lesson**: When both a W WALL (top) and a W WALL (bottom) are both visible on the same day chart, Milk is explicitly defining the day's range — do not expect breakouts beyond either wall without major catalyst. Focus on fading extremes.
- **Lesson**: SECTOR OBJECTIVE below current price + SELLER OBJECTIVE on right panel = bearish downside targets defined. If price breaks below New Fair Value cleanly, these are the magnets.

**2026-04-13 — Milk Zones (uploaded by user)**
- **Date**: 2026-04-13 (ES/MES 5-min chart, "ES Yellowstone" study)
- **Zone structure from top to bottom:**
  1. **IV WALL** — top cap, extreme resistance
  2. **LARGE SELLER POSITIONING** — major dark red block just below IV Wall; primary resistance for the day
  3. **TOP SIDE BARRIER / PIVOT** — label at top of structure
  4. **SELLER POSITIONING** — secondary red zone below large seller block
  5. **NON FAIR VALUE** (green) — current price action trading through this zone; mean-reversion magnet
  6. **SELLERS SOFT TARGET ON RNGDN** — first downside target level
  7. **SELLERS SELL TARGET ON RNGDN** — primary downside target if range expands
  8. **MILK TREND DATA** — bottom trend support zone
- **Bias read**: Bearish structure. Price in Non Fair Value with stacked seller zones above. Downside targets defined. Longs are counter-trend and require strong confluence to take.
- **Lesson**: When LARGE SELLER POSITIONING + IV WALL stack at top and price is already in Non Fair Value, the day's bias is SHORT. Any long signals in the Non Fair Value zone should be treated as riskiest-tier only.

**2026-04-13 — Refactor: imbalance removal, pattern expansion, signal persistence, live edits**
- **Imbalances removed from signal votes**: vote system simplified to 2 votes (milkOk + secondaryVecOk). SignalsPanel.tsx and market.tsx both cleaned of all `imbalanceOk` / `significantImbalances` refs. Removing one vote dimension does not require renumbering thresholds — safe/risky/riskiest tiers now just require 2/1/0 secondary votes.
- **Pattern scan size matters**: Tabletop patterns now scan the LARGEST qualifying window (5–20 bars for pure, 5–30 for side). Scanning from MAX down and breaking on first qualifying result finds the largest without O(N²) enumeration.
- **Signal persistence hydration key**: DB signals hydrate `lockedSignalLevelsRef` using `${timestamp}_${direction}` keys. Also hydrate `PureLong_${ts}`, `PureShort_${ts}`, `SideLong_${ts}`, `SideShort_${ts}` keys so that pattern-type signals don't re-fire on page load.
- **Live Edits endpoint safety**: `/api/live-edit` restricts file writes to `client/src/`, `server/`, and `shared/` dirs only — never allow path traversal outside project source.
- **SignalsPanel ExternalSignal type must stay in sync with market.tsx CSig**: Any field added/removed from `CSig.confirmations` in market.tsx must be mirrored in `ExternalSignal.confirmations` in SignalsPanel.tsx, or TypeScript build will silently accept mismatches if fields are optional.

**2026-04-10 — Taught by User**
- **Resistance Within 0.5 pts of Entry (Long)**: A long entry at 6869.50 with resistance at 6869.65 (0.1 pts away) places the trade immediately into supply, negating any vector signal before price can develop.
  - Action: Skip any long signal where a resistance R-zone is within 0.5 pts above the entry price, regardless of vector or milk zone confirmation.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **Resistance Too Close to Entry**: A valid long setup failed because a resistance zone sat only 2.4 pts above entry (less than half the 5.0 pt stop distance), with price already touching it, leaving insufficient room to reach TP1 before hitting supply.
  - Action: Skip any long signal where a resistance zone is within **3.0 pts of entry** (i.e., closer than 60% of the stop distance), especially if candles are already touching or testing that level at signal time.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **Resistance Within 2pts on Entry (No Breakout/Retest)**: A long setup with valid Primary Vector, Milk Zone, and Secondary TF confirmation still fails when unchallenged resistance sits within 2 points above entry, because price is likely to stall or reject before reaching TP1.
  - Action: When a `reclassify warning` flags resistance ≤ 2.0 pts above entry on a long, do not enter immediately — require either (1) a confirmed 1m close above that resistance level, or (2) a pullback retest of the vector tabletop *after* price has cleared the resistance, before triggering the entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **ETH Tabletop Retest Short — Premature Entry Mid-Pattern**: Shorting during an active tabletop retest in ETH produced a loss because the price had not yet resolved direction — entering mid-retest rather than waiting for breakout/rejection confirmation meant taking on maximum directional uncertainty with no Milk Zone support.
  - Action: During ETH, if price is actively retesting a tabletop (support/resistance level) and Milk Zone confirmation is absent, do not enter short; wait for a confirmed breakout or rejection candle close beyond the tabletop before evaluating direction — a completed retest may instead generate a long entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **Mid-Retest Short Entry**: Entering a short while price is actively mid-retest of a tabletop/resistance level (Milk Zone ✗, Bullish Body ✗) invites reversal — the retest wasn't complete, so the level hadn't rejected price yet, and a breakout long became the higher-probability play once the retest resolved.
  - Action: Skip any short signal during ETH where Milk Zone is unconfirmed AND price is visibly mid-retest of a key level; wait for the retest to fully complete (either a confirmed rejection candle closing back below the level, or a clean breakout) before re-evaluating direction.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **ETH Milk Zone signals invalid during RTH**: This Long was taken during RTH (05:40 ET is pre-market/ETH, but the note indicates Milk Zone confluence was absent and the rule is that Milk Zones should only be applied within their respective session — ETH zones for ETH, RTH zones for RTH — meaning an ETH Milk Zone cannot substitute as RTH confirmation and vice versa.
  - Action: When session is RTH, require Milk Zone confirmation derived strictly from RTH price structure; reject any signal where the Milk Zone check references an ETH-origin zone, and additionally skip any signal where the Primary Vector is not within a visually proximate distance to the entry candle (codeable as: vector value must be within X points of entry price at signal bar).
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **Zone Bias Contradiction — Short in Bullish Structure**: A short signal fired with Milk Zone + Vector confirmation, but the trader recognized the zone context implied long bias (bullish body confirmation absent, ✗), meaning the confluences were pointing *against* the trade direction rather than supporting it.
  - Action: Skip any short signal where Bullish Body confirmation is ✗ **and** the trader's zone read implies demand/support (i.e., price is at or bouncing from a Milk Zone from below) — require all four confirmations to align directionally before entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **Tabletop Break Requirement for Early Short Signals**: A short signal firing before price has tested and broken through a tabletop resistance level is premature — the setup is structurally valid but sequentially wrong, as the tabletop must act as resistance first before a short entry has confirmation.
  - Action: Skip short signals where price has not yet touched and rejected (or broken below) the nearest tabletop level above entry; require a visible wick or candle close beyond the tabletop before the signal qualifies as valid.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **Resistance Proximity + Multi-RZone Bearish Confluence = Skip Long**: A long signal taken with resistance only 0.9 pts above entry and multiple resistance zones indicating a bearish trend context resulted in an immediate loss, as overhead supply killed upward momentum before TP1 could be reached.
  - Action: Skip any long signal (especially risky-rated) when a reclassify warning flags resistance within 1.5 pts of entry AND two or more additional R-zones are present above price indicating a bearish trend bias — treat the setup as a potential short candidate instead.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **Vector Tabletop with Opposing Milk Zone Support**: A short signal fails when the primary vector has flattopped (no sustained bearish momentum after retest) AND nearby Milk Zones below entry indicate active support, creating a structural long bias that invalidates the short setup.
  - Action: Skip short signals where the vector has flattopped (last 2–3 vector values are within 1–2 pts of each other with no lower low) AND at least one Milk Zone exists between entry and TP1 acting as support rather than resistance.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **No Bullish Body on 60m Long at 14:30**: A 60m long signal at 14:30 ET with all other confirmations present but missing Bullish Body confirmation resulted in a loss, matching a prior failed 15m trade under the same body-absent condition.
  - Action: Skip Long signals on both 15m and 60m intervals when Bullish Body confirmation is absent, regardless of how many other confirmations are present.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **Downward-sloping vector approaching side-entry**: The vector was already trending down toward its side-entry point, meaning the signal fired one candle early on a deteriorating vector rather than at the confirmed flat/side entry required by the strategy.
  - Action: Skip long entries where the Primary Vector slope over the last 2–3 candles is negative (each vector value lower than the previous), even if the current bar hasn't yet reached the formal side-entry level — wait for the slope to flatten before entering.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-08 — Taught by User**
- **Bullish Body Confirmation is Obsolete**: A "Bullish Body ✓" confirmation was present but the trader has explicitly rejected this as a valid signal filter, preferring pattern-based historical confirmation instead.
  - Action: Remove "Bullish Body" as a confirmation criterion entirely; replace with a pattern-matching filter derived from historical data before re-enabling body-based entry logic.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-08 — Taught by User**
- **Weak Vector Confluence + Low Volume = Skip**: Both vectors lacked strength (primary vector not close enough to signal zone, secondary vectors pressing against tabletop resistance rather than breaking clean) and surrounding candles showed low volume, producing a losing ETH long despite 3/4 confirmations checked.
  - Action: Skip any signal where (a) the primary vector has not reached or crossed the signal level within the last 2 bars, OR (b) secondary vectors are flat/testing a tabletop rather than pointing directionally, OR (c) volume on the signal candle and the 2 preceding candles is all below the 20-bar average volume — require ALL three conditions to be clear before taking a "safe" ETH entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-07 — Taught by User**
- **Flat/Tabletopped Primary Vector Without Retest**: A primary vector that has flatlined (zero slope) and whose level has not been physically retested by price (2–3 candle touches) indicates exhausted momentum, not a valid launch point — taking a long here ignores that the vector is offering no directional conviction.
  - Action: Skip any long (or short) signal where the primary vector has been flat for 2+ bars AND price has not physically touched the vector level at least twice since it flattened; require confirmed retest before treating the vector as active support/resistance.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-06 — AI Trade Analysis**
Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CZoJpkVfZL8W94jk5T4QM"}


**2026-04-06 — AI Trade Analysis**
Error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted


**2026-04-05 — Multi-interval vector display**
- Observation: The 1m vector was missing from 5m/15m/60m charts because `iv.sec < sourceSec` filtered it out — you can't disaggregate 5m→1m data. Comparing `fetchInterval === "15m"` also caused a TS error since `fetchInterval` is typed `"1m" | "5m" | "60m"`.
- Action: Add a secondary `useQuery` for 1m data (enabled only when `showVector && fetchInterval !== "1m"`). Use `interval ===` not `fetchInterval ===` for 15m checks. Provide a `base` per interval in the INTERVALS array.
- Confidence: high

**2026-04-05 — CLAUDE.md / LEARNINGS.md location**
- Observation: Files placed in `client/src/components/` are NOT auto-read by Claude Code. Only `CLAUDE.md` at the project root is loaded as persistent instructions.
- Action: Always place CLAUDE.md and LEARNINGS.md at the project root (`/`). Subdirectory copies are ignored.
- Confidence: high



**2026-04-05 — Multi-session (chart, live data, vectors)**
- Observation: `useLayoutEffect` is mandatory for any chart init code. `useEffect` silently produces a 0-height chart.
- Action: Always check for `useLayoutEffect` when chart doesn't render or has zero dimensions.
- Confidence: high

**2026-04-05 — Gap detection for 15m candles**
- Observation: Starting `barIntervalSec = 300` and only decrementing breaks any chart with bars > 300s. The 15m chart inserted spacers between every candle pair.
- Action: Always start gap detection from `Infinity` and find minimum. Cover up to `4 * 3600` to handle 60m bars.
- Confidence: high

**2026-04-05 — autoscaleInfoProvider on indicator series**
- Observation: Vector lines from 90 days of history include price levels 500+ pts below current — auto-scale fits the entire range and compresses current candles.
- Action: All non-candle series (vectors, overlays) must have `autoscaleInfoProvider: () => null`.
- Confidence: high

**2026-04-05 — Dynamic series add causes chart reset**
- Observation: Calling `chart.addSeries()` in a `useEffect` after chart init resets `setVisibleLogicalRange`. Also breaks on chart recreation because useEffect doesn't re-run.
- Action: Pre-allocate ALL series at chart init. useEffect only calls `setData()`.
- Confidence: high

**2026-04-05 — TickRelay disk conflict causes price jumping**
- Observation: `onTickFileChange` was still running even when TickRelay was active. Disk prices (slightly stale) broadcast as `{type:"bar"}` → `setLiveCandles` → re-render → chart jumped back to disk price on every tick.
- Action: `onTickFileChange` must return early when `Date.now() - lastExternalTickMs.get(sym) < 5_000`.
- Confidence: high

**2026-04-05 — Forming-bar broadcast condition always false**
- Observation: `lastTickPrice.set(sym, price)` called before `Math.abs(price - lastTickPrice.get(sym))` check. Difference always 0, broadcast never fires, liveCandles never updated for forming bar.
- Action: Use a throttle (1s) instead of price-change condition. Set `lastTickPrice` inside the throttle or after the check.
- Confidence: high

**2026-04-05 — timestamps.tsx zone divergence from market.tsx**
- Observation: timestamps.tsx used `buildMilkZoneSets()` — a legacy zone algorithm independent of `detectMilkZones`. This produced different bull/bear zone sets than market.tsx, causing confluence signals to differ between the chart and the Confluence tab.
- Action: Replaced `buildMilkZoneSets` with `detectMilkZones(sorted, 0, 0)` + the same label-based isBull/isBear mapping used in market.tsx `allConfluenceSignals`. Also added slope gate (vector must be trending in signal direction) to match market.tsx. Never use `buildMilkZoneSets` — it's dead code.
- Confidence: high

**2026-04-05 — Multi-Vector proximity gate and signal click panel**
- Observation: MV signals were firing with vectors far from price (e.g. 60m vector 33pts away). Far-away vectors represent stale structure and are less predictive. User also requested click-to-inspect and desktop notifications for MV signals.
- Action: Added `MV_PROXIMITY_ATR = 2.5` gate — skip vector vote if `|vNow - close| > atr * 2.5`. Added `voters: string[]` to MVSig so the panel can show "5m + 15m". Added `markerHitsRef` in CandlestickChart — each draw frame records (x,y,SignalClickInfo) for all signal markers. `handleDragStart` hit-tests markers first (14px radius), calls `onSignalClick`. In market.tsx, `selectedSignal` state drives a floating detail panel. MV notifications fire same way as confluence — AudioContext tone (triangle wave, different frequency) + Notification API.
- Confidence: high

**2026-04-05 — Multi-Vector Convergence (MV) signal layer**
- Observation: S/T/R (Side/Tabletop/Reversal) pattern signals were too cluttered and not aligned with the user's mental model. User wanted signals based on vector-candle convergence theory: if 2+ of {1m,5m,15m} vectors are above price AND declining → SHORT; below price AND rising → LONG.
- Action: Removed computeVectorPatternSignals entirely. Added `computeMultiVectorSignals` at module level. Uses `buildMap = forwardFillVector(computeVectorLine(candles), chartTimes)` for each of the 3 intervals, then votes: `shortCount++` when `vNow > close && vNow < vPrev` (above+declining), `longCount++` when `vNow < close && vNow > vPrev` (below+rising). Fires when count >= 2. Separate `lastLong`/`lastShort` cooldown trackers (8 bars). Teal hexagon markers for Long, fuchsia for Short.
- Confidence: high

**2026-04-05 — Separate Long/Short cooldowns are required for all signal systems**
- Observation: A shared `lastBar` cooldown tracker blocks opposite-direction signals within the cooldown window. This suppressed short signals whenever a long had just fired (and vice versa).
- Action: Always use `lastLong` and `lastShort` as separate trackers in any signal generator that emits both directions. A Long at bar 50 must not block a Short at bar 55.
- Confidence: high

**2026-04-05 — Fractal Liquidity Sweep (FLS) signal layer**
- Observation: A new reversal-based signal layer was added independently of the Milk+Vector confluence system. It detects 5-bar fractal swing points, checks for wick-through-then-close-back sweeps, and requires vector agreement.
- Action: `computeFractalSweepSignals` runs on RTH bars only. Same `TP_ATR_MULT`/`SL_ATR_MULT` constants as the confluence system for consistent R:R. Uses 8-bar cooldown (vs 10 for confluence). Diamond markers (orange=Long, purple=Short) distinguish visually from confluence circles (green/red). Dotted TP/SL lines (vs dashed for confluence).
- Confidence: high

**2026-04-07 — Chart glitch: useEffect vs useLayoutEffect for chart init**
- Observation: Chart init was using `useEffect` — DOM dimensions are 0 at that point, causing the chart to render with 0×0 then flash as ResizeObserver corrected it.
- Action: Always use `useLayoutEffect` for the chart init block in CandlestickChart. Must also add `useLayoutEffect` to the React import statement.
- Confidence: high

**2026-04-07 — HTTP poll overwrites WS tick prices (250ms stutter)**
- Observation: The 250ms HTTP poll for futures calls `setLiveCandles(close=pollPrice)` which triggers the candle effect's `series.update(pollPrice)`, overwriting the more granular WS tick price (`updateLastBarClose`). This caused a visible price stutter every 250ms.
- Action: Add `lastWsTickMsRef` in market.tsx. In the HTTP poll merge, when `Date.now() - lastWsTickMsRef.current < 5000`, keep `prev[idx].close` (don't overwrite with HTTP poll close). Only update high/low from HTTP poll. WS ticks via `updateLastBarClose` remain authoritative for close.
- Confidence: high

**2026-04-07 — Whitespace spacer collision guard**
- Observation: CLAUDE.md specifies spacer timestamps must not land on real bar times. The setData loop had no guard, allowing spacers to collide with and silently drop real bars in lw-charts v5.
- Action: Build `realBarTimes = new Set(sorted.map(c => c.time))` before the loop. Before pushing each spacer, check `if (!realBarTimes.has(prev + step * g))`.
- Confidence: high

**2026-04-07 — 60m vector wrong for stocks due to epoch-alignment mismatch**
- Observation: Polygon stores 60m bars starting at 09:30 ET (13:30 UTC). `aggToInterval(base5m, 3600)` uses `Math.floor(t/3600)*3600` which gives epoch-aligned buckets at 13:00 UTC. A 60m bar from 13:00 only covers 13:30-13:55 (partial), while Polygon's 13:30 bar covers 13:30-14:29. The vectors are completely wrong because the OHLC buckets don't match.
- Action: Added `raw60mData` secondary query (enabled when fetchInterval !== "60m", same as raw1mData pattern). Always use `raw60mData.candles` for the 60m extra vector computation — never `aggToInterval(base5m, 3600)`. Fall back to aggregation only if raw60mData hasn't loaded yet.
- Confidence: high

**2026-04-07 — Confluence signals are Long-only**
- Observation: User requested no Short signals from the vector confluence system. Short signals were too noisy and not aligned with the Long-biased strategy.
- Action: After computing `signalDir`, add `if (signalDir === "Short") continue;` before the signal is emitted. This applies to all risk levels (safe/risky/riskiest) and both RTH and ETH.
- Confidence: high

**2026-04-07 — today-signals.tsx had divergent signal logic causing wrong P&L**
- Observation: today-signals.tsx used a 2-component (milkSig+vecSig) system AND still had MV signals and Short signals. market.tsx had been upgraded to a 3-component Long-only system. Result: today-signals showed 0 wins even when the chart had winning trades.
- Action: Rewrote computeConfluenceSignals in today-signals.tsx to exactly match market.tsx's 3-component logic (vecOk required + milkOk+bodyOk+secondaryVecOk bonus). Removed computeMVSignals entirely. Removed isMV from TodaySignal type.
- Confidence: high

**2026-04-07 — SPA navigation unmounts MarketPage, killing notification effects**
- Observation: wouter Switch unmounts inactive routes. When user navigates to /today or /data, MarketPage unmounts — all useEffects stop, including notification and live data effects.
- Action: In App.tsx, render MarketPage ALWAYS (outside Switch) but wrap it in `display:none` when not on "/". Other routes rendered in a separate Switch only when !onMarket. Use `useLocation` from wouter.
- Confidence: high

**2026-04-07 — Primary vector as hard gate; secondary vec as tier bonus**
- Observation: Secondary vectors from other intervals were not participating in signal computation at all — they were display-only. User wanted primary vector (current interval) to be required, and secondary vectors to add a bonus toward tier upgrade.
- Action: In allConfluenceSignals: (1) `if (!vecOk) continue` — primary is hard gate. (2) Compute `secondaryVecOk = extraVecSignalMaps.some(m => c.close > m.get(c.time))`. (3) Tier = bonus(milkOk+bodyOk+secondaryVecOk): safe≥2, risky≥1, riskiest=0. (4) Add `extraVecSignalMaps` as useMemo dependency.
- Confidence: high

**2026-04-07 — Resistance proximity reclassification**
- Observation: User wanted signals that have bearish milk zones within 5.0 pts (20 ticks) above the entry to be downgraded one tier (SAFE→RISKY, RISKY→RISKIEST).
- Action: After tier assignment, loop allMilkZones for bearish types active at c.time. Compute `distAbove = zoneLow - c.close`. If 0 ≤ distAbove ≤ 5.0, downgrade level and store `reclassifyReason`. Break after first match.
- Confidence: high

**2026-04-07 — Section 3: SignalMiniChart tier coloring via riskLevel prop**
- Observation: Signal circle and glow were always green (Long color), regardless of safe/risky/riskiest. No way to visually distinguish tier on mini chart.
- Action: Add `riskLevel?: string` to signal prop in SignalMiniChartProps. Derive `tierRgb` from riskLevel (safe=38,200,122 / risky=245,158,11 / riskiest=239,68,68). Use tierRgb for both the glow gradient and circle fill. Pass `riskLevel: s.riskLevel` from today-signals.tsx row.
- Confidence: high

**2026-04-07 — Section 4: ML prediction fetched on-demand (row expand), not upfront**
- Observation: Pre-fetching predictions for all signals on page load would fire 10+ API calls. Model may not exist yet (returns early with note field).
- Action: Fetch prediction in the row onClick handler only on first expand of that row. Cache in `mlPredictions` state keyed by `${time}-${interval}`. Check `data.note === "no model trained yet"` to return null (no badge). Show ⚠ badge only when `warn: true` (score < 0.45).
- Confidence: high

**2026-04-07 — Section 6: 5m base candles for interval-consistent zones**
- Observation: On 1m chart, detectMilkZones used 1m candles → more micro-zones at different price levels than 5m chart. On 60m chart, used 60m candles → coarse zones. User saw different zones depending on interval.
- Action: Add raw5mForZones secondary query (enabled when showMilkZones && fetchInterval !== "5m"). Compute zoneBaseCandles = raw5mForZones?.candles if on 1m/60m chart, else windowedCandles. Pass zoneBaseCandles to detectMilkZones. Zones now identical between 5m and 15m charts, and use 5m data on 1m/60m.
- Confidence: high

**2026-04-07 — today-signals.tsx Section 1+2: secondary candles passed explicitly**
- Observation: today-signals.tsx doesn't have extraVecSignalMaps infrastructure like market.tsx. To get secondary vector bonus, each interval's computeConfluenceSignals call must receive the OTHER intervals' candle arrays as a second argument and forward-fill them internally.
- Action: Add forwardFillVector back to today-signals.tsx. Change computeConfluenceSignals signature to (candles, secondaryCandles[]). Build secMaps inside the function. Call sites: sigs1m receives [5m,15m,60m], sigs5m receives [1m,15m,60m], etc.
- Confidence: high

**2026-04-07 — .mwml files are a dict with context/instr/graphs keys, not a JSON array**
- Observation: zone_classifier.py initially used regex to find supportResist objects and found 0 zones. Files are ~11MB each, structured as {"context":..,"instr":..,"graphs":..} — NOT an array. supportResist objects are nested deeply inside graphs.
- Action: Use json.load() + recursive _find_support_resist(obj, results) to walk the whole tree. One file has ~15,440 supportResist figures. Total across 23 files: ~29,583 zones after deduplication.
- Confidence: high

**2026-04-07 — SignalClickInfo extended for confirmation detail panel**
- Observation: Signal detail panel only showed a generic tier reason line. User wanted to see which exact components fired and any reclassification reason.
- Action: Extended SignalClickInfo and confluenceSignals prop type to include optional `confirmations: {milkOk,vecOk,bodyOk,secondaryVecOk}` and `reclassifyReason?: string`. The draw loop in CandlestickChart.tsx passes these through to markerHitsRef. Panel renders component list and ⚠ reclassify line.
- Confidence: high

**2026-04-07 — Performance pass: Intl formatter, UTC arithmetic, effect split**
- Observation: Three sources of unnecessary per-render/per-candle work: (1) `new Intl.DateTimeFormat(...)` called inside `isMarketBreak` on every candle = expensive allocation in hot loop. (2) `new Date(c.time * 1000)` called twice per candle in allConfluenceSignals for RTH and closing-hour checks. (3) Two useEffects in CandlestickChart both scheduling drawAll on `drawings` change = double canvas redraw on every drawing mutation.
- Action: (1) Move Intl formatter to module-level singleton `_etFmt`. (2) Replace Date objects with pure UTC arithmetic: `(ts/3600|0)%24` for hour, `(ts/60|0)%60` for minute — no allocations. (3) Split effects: one subscribes pan/zoom only (`[drawAll]` dep), one schedules redraws on data deps only. Each change triggers exactly one `requestAnimationFrame(drawAll)`.
- Confidence: high

**2026-04-07 — isMarketBreak parse via indexOf/parseInt, not split**
- Observation: `_etFmt.format(d).split(":").map(Number)` creates a 2-element array allocation per call. Fine once, but called thousands of times across candle history.
- Action: `const col = et.indexOf(":"); parseInt(et.slice(0, col)) * 60 + parseInt(et.slice(col + 1))` — no array, same result.
- Confidence: high

**2026-04-08 — milkOk MUST compare prices, not just timestamps**
- Observation: `milkBull.has(c.time)` (time-only zone check) marks every candle in the zone's time window as "in the zone" even when price is 50+ pts away. This is observational bias — you're treating temporal proximity as spatial proximity.
- Action: Replace with `c.low <= z.top + MILK_TOL && c.close >= z.bottom - MILK_TOL` where MILK_TOL=2.0 pts. This is the actual "zone test and hold" pattern: wick reached the zone AND close held above it. Compare numbers to numbers.
- Confidence: high

**2026-04-08 — Never cap zone toTime at rthCloseOfDay(from_ts)**
- Observation: `Math.min(z.to_ts, rthCloseOfDay(z.from_ts))` truncates multi-day zones. A zone starting March 29 gets capped at March 29 21:00 UTC. When viewing April 8, `timeToCoordinate(March 29 21:00)` returns a very negative x-pixel → zone is skipped by the `zxR <= 0` guard → zones appear invisible.
- Action: Use `toTime = z.to_ts` always. Milk zones are multi-session support/resistance levels; they persist until broken.
- Confidence: high

**2026-04-08 — Zone rendering must be unconditional (not inside session guard)**
- Observation: Zone drawing loop was inside `if (xStart !== null && xEnd !== null)` — today's session pixel coordinates. ML zones with explicit fromTime/toTime don't need today's session. If viewing historical data where today is off-screen, xStart/xEnd may be null → all zones hidden.
- Action: Move zone loop OUTSIDE the session guard. Only the gap-fill (which needs session width) stays inside. Check: `if (zonesRef.current.length > 0)` unconditionally, then use per-zone fromTime/toTime for x-range.
- Confidence: high

**2026-04-08 — Fixed-point exits beat ATR-based for MES/ES**
- Observation: Monte Carlo on 222 real MES 5m signals shows ATR averages 15.3 pts (range 3.3–45.3). ATR-based SL (0.5×ATR) = 1.6–22.6 pts — completely inconsistent. Fixed TP=10pts/SL=5pts gives 32% WR, 1.16 pts expected. Best combo: TP=20pts/SL=5pts, 4:1 R:R, 2.05 pts expected.
- Action: Use TP_FIXED_1=10, TP_FIXED_2=20, SL_FIXED=5 in both market.tsx and SignalsPanel.tsx. Never use TP_ATR_MULT/SL_ATR_MULT for confluence signals.
- Confidence: high

**2026-04-08 — Signals panel must default to TODAY, not 30 days ago**
- Observation: `defaultStartDate()` returned `d.setDate(d.getDate() - 30)` — signals panel opened 30 days back. User wants today's signals on open.
- Action: `return new Date().toISOString().split("T")[0]` — just today's date.
- Confidence: high

**2026-04-08 — SignalsPanel must receive allConfluenceSignals (not chartRiskLevel-filtered)**
- Observation: `externalSignals={confluenceSignals}` passed the chart-filtered subset — so when chart showed only "Safe" tier, the Signals panel also only showed Safe. The panel should always show ALL computed signals regardless of chart display tier.
- Action: Pass `allConfluenceSignals` (before risk filter) to `SignalsPanel externalSignals`. The panel has its own tier filter internally.
- Confidence: high

**2026-04-08 — detectMilkZones zone toTime must never use dayRthClose cap**
- Observation: Client-side `detectMilkZones` was capping zone `toTime` with `Math.min(..., dayRthClose)`, which truncates FVGs/OBs to end-of-session. When viewing historical data, zones appeared missing because their end timestamp predated the visible window.
- Action: Use `curr.time + N * BAR_INT` for FVG/OB zones and `curr.time + 30 * 86400` for structural zones — no session-end cap. Mirrors the LEARNINGS entry for ML zones (2026-04-08 "Never cap zone toTime").
- Confidence: high

**2026-04-08 — showMlZones should default to true**
- Observation: Default `showMlZones = false` meant zones never appeared on first load — user had to manually click "Milk Zones" button. The strategy depends on zones being visible.
- Action: `useState(true)` so zones are visible immediately on page load.
- Confidence: high

**2026-04-08 — Monte Carlo page added (/monte-carlo route)**
- Observation: User needed a dedicated simulation view with Back Test (signal outcome table + chart markers), Monte Carlo equity curve (canvas-rendered), and a Notes/Edit panel to modify exit parameters and append to LEARNINGS.md.
- Action: Created `client/src/pages/monte-carlo.tsx`. Signal computation mirrors market.tsx exactly. MC runs 500 block-bootstrap iterations client-side. EquityCurve renders on canvas (no extra library). Added `/api/strategy/config` GET/PUT and `/api/monte-carlo/calibrate` POST to routes.ts. Added nav link in market.tsx toolbar.
- Confidence: high

**2026-04-08 — ML zone bands (from DB) cap at 4:30pm ET using rthSettleOfDay**
- Observation: ML zones fetched from the DB (`mlZonesData`) use `z.to_ts` which can extend days forward. The user wants DB zones to end at 4:30pm ET of their start day (settlement), not persist indefinitely.
- Action: `rthSettleOfDay(ts) = Math.floor(ts/86400)*86400 + 20*3600 + 30*60`. Use `toTime: rthSettleOfDay(z.from_ts)` in `mlZoneBands` useMemo in both market.tsx and monte-carlo.tsx. Distinct from `detectMilkZones` (client-side FVG/OB zones) which must NEVER be capped.
- Confidence: high

**2026-04-08 — vectorLine and extraVectorLines must be declared AFTER windowedCandles**
- Observation: vectorLine used `windowedCandles` in both its useMemo callback AND its dependency array `[candleData, windowedCandles]`. `windowedCandles` was declared 230 lines later. TypeScript caught this as "used before declaration" (temporal dead zone). At runtime, the dep array `[candleData, windowedCandles]` would evaluate `windowedCandles` before it was initialized — a real ReferenceError.
- Action: Move the entire vector block (`vectorLine`, `vectorSignals`, `vectorOverlays`, `extraVectorLines`, `extraVecSignalMaps`, and the tradeSegments destructure) to AFTER the `windowedCandles = useMemo(...)` block. Also add `windowedCandles` to `extraVectorLines`' dep array (it was missing, causing a stale closure bug).
- Confidence: high

**2026-04-08 — MC equity curve uses lightweight-charts (time-indexed), not canvas-only**
- Observation: Canvas-only equity curves couldn't be read easily (no axes, no scale). User wanted simulations visible on the chart with a proper equity curve panel.
- Action: `MCEquityChart` component uses `createChart` + 3 `LineSeries` (median/P10/P90) from lightweight-charts. Equity paths are time-indexed: X axis uses real signal timestamps so each point aligns with when the signal fired. Canvas overlay appended inside the chart container renders up to 150 faint individual paths at 6% opacity. `useLayoutEffect` for chart init (mandatory). All series have `autoscaleInfoProvider: () => null`.
- Confidence: high

**2026-04-08 — generateSuggestion grid search for optimal TP/SL**
- Observation: User wanted a "Suggested" button that auto-computes the optimal exit parameters from backtest data instead of guessing.
- Action: `generateSuggestion(signals, tier)` iterates TP_RANGE=[5,7.5,...,20] × SL_RANGE=[2.5,...,8]. For each combo, re-evaluates stored backtest outcomes as proxies: a signal that won with pnl≥tp1 would still win under the new TP1; losses stay losses (conservative). Returns best EV combo as `SuggestedParams`. "Apply to Config" button populates the Notes/Edit panel with the suggested values.
- Confidence: high

## [2026-04-23] — Backtest Adjustments (228 signals)

**Missed / Stopped Out (141)**
- No zone confirmation — vector-only stopped out (×100)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Zone held but momentum failed (×2)
- Resistance 0.5pts overhead (×1)
- Resistance 0.3pts overhead (×1)
- Support 1.8pts below — buyers defended (×1)
- Resistance 3.6pts overhead (×1)
- Resistance 4.8pts overhead (×1)
**Caution / Partial (87)**
- Hit TP1 — stalled before full target (×55)
- Afternoon entry — momentum often faded (×22)
- Late session — expired near close (×10)

## [2026-04-23] — Backtest Adjustments (232 signals)

**Missed / Stopped Out (143)**
- No zone confirmation — vector-only stopped out (×101)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Zone held but momentum failed (×2)
- Resistance 0.3pts overhead (×1)
- Support 1.8pts below — buyers defended (×1)
- Resistance 3.6pts overhead (×1)
- Resistance 4.8pts overhead (×1)
- Resistance 2.5pts overhead (×1)
- Resistance 4.0pts overhead (×1)
**Caution / Partial (89)**
- Hit TP1 — stalled before full target (×56)
- Afternoon entry — momentum often faded (×22)
- Late session — expired near close (×11)

## [2026-04-24] — Backtest Adjustments (232 signals)

**Missed / Stopped Out (143)**
- No zone confirmation — vector-only stopped out (×101)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Zone held but momentum failed (×2)
- Resistance 0.3pts overhead (×1)
- Support 1.8pts below — buyers defended (×1)
- Resistance 3.6pts overhead (×1)
- Resistance 4.8pts overhead (×1)
- Resistance 2.5pts overhead (×1)
- Resistance 4.0pts overhead (×1)
**Caution / Partial (89)**
- Hit TP1 — stalled before full target (×56)
- Afternoon entry — momentum often faded (×22)
- Late session — expired near close (×11)

## [2026-04-24] — Backtest Adjustments (233 signals)

**Missed / Stopped Out (143)**
- No zone confirmation — vector-only stopped out (×101)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Zone held but momentum failed (×2)
- Resistance 0.3pts overhead (×1)
- Support 1.8pts below — buyers defended (×1)
- Resistance 3.6pts overhead (×1)
- Resistance 4.8pts overhead (×1)
- Resistance 2.5pts overhead (×1)
- Resistance 4.0pts overhead (×1)
**Caution / Partial (90)**
- Hit TP1 — stalled before full target (×56)
- Afternoon entry — momentum often faded (×22)
- Late session — expired near close (×11)
- Open — session not yet resolved (×1)

## [2026-05-17] — PC chart candle corruption + iPhone Yellow Box / Footprint overhaul

**MESU6 price contamination (PC chart)**
- Observation: MESU6 (Sep 2026 contract) bar files were being loaded and merged with MESM6 (Jun 2026), producing candles with ~15-20 pt price gaps mid-day. Root cause: `getContractDirs` included all `MES*.CME` dirs regardless of contract state.
- Action: Filter contract dirs using tick-file presence — only dirs containing at least one `.tick_data` file are valid. MotiveWave only writes tick files for the active/recently-active front-month, so MESU6 (not yet front-month) has no tick files and is excluded naturally. After applying: deleted 215,916 contaminated DB rows and reloaded — 170,663 clean bars from Sep 2025 onward.
- Confidence: high

**Sparse bar files creating false FVG zones (PC chart)**
- Observation: Jul–Nov 2025 MESM6 bar files had 3–370 records per file (weekly-summary sparse files). Pairs of bars days apart created massive false imbalance zones in `detectMilkZones`.
- Action: (1) `getBarFiles` size filter — skip any `.bar_data1` file < 10,000 bytes (~300 records). (2) Gap check in `detectMilkZones` after ATR calculation — skip any FVG triplet where `next.time - prev.time > 6 * BAR_INT` (30 min for 5m chart). Both filters are required; either alone misses edge cases.
- Confidence: high

**Zone cascade causing zones to always show (PC chart)**
- Observation: `showMlZones` was persisted as `true` from a prior session. `mlZoneBands` fell back through `activeZones` → `clientMilkZones` cascade, so zones always appeared on load even though the user wanted a clean chart by default.
- Action: Changed `showVector` and `showMlZones` defaults to `false`. Added `migrateSettingsV3` IIFE to force-clear old persisted `true` values from localStorage on first load (keyed by `mwb_ui_v = "3"`). This is a one-time migration — subsequent loads read the stored (now false) values directly.
- Confidence: high

**iPhone Yellow Box — pivot levels from previous RTH H/L/C**
- Observation: The old chart-view had no Yellow Box implementation. MotiveWave's Milk Yellow Box study draws key levels at RTH open each day based on prior-session price structure.
- Action: Added `computeYellowBoxLevels(rawBars)` — computes 13 classic floor-trader pivot levels (P, R1/S1, R2/S2, IV Wall, Seller/Buyer Objectives, Weekly Ceiling, FRI Ceiling, Max Range/Trend) from yesterday's RTH H/L/C. `drawYellowBox()` renders dark olive/green session background (`rgba(50,70,15,0.20)`) + labeled horizontal lines with color-coded pills. Session is constrained to today 13:30–20:30 UTC (9:30 AM–4:30 PM ET).
- Action: Level labels map Milk's vocabulary: R1=RESISTANCE, S1=SUPPORT, P=Pivot, R2=Non Fair Value Upper, S2=Non Fair Value Lower. IV Wall = midpoint(P, R1). These are floor-trader pivots, not MotiveWave's proprietary formula — may need tuning if levels don't match exactly.
- Confidence: medium (formula approximates Milk's output; exact match requires MotiveWave source)

**iPhone Footprint — real bid/ask delta from server**
- Observation: Old `setFootprintVisible` only showed/hid a text badge — no actual footprint data was rendered.
- Action: Replaced with `setFootprintData(candles, visible)` API. `drawFootprint()` renders per-candle delta badges (green=positive, red=negative) and imbalance tick markers at price levels from `candle.imbalances[]`. Added footprint `useEffect` that fetches from `/api/footprint/history/${sym}/${fetchInterval}` first; falls back to OHLCV synthetic delta (close-open ratio × volume) when server returns empty (no MotiveWave footprint relay connected).
- Confidence: medium (real data requires MotiveWave footprint_bar study to be connected and sending WS messages)

## [2026-05-05] — Backtest Adjustments (262 signals)

**Missed / Stopped Out (153)**
- No zone confirmation — vector-only stopped out (×115)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Resistance 1.5pts overhead (×1)
- Resistance 4.8pts overhead (×1)
- Zone held but momentum failed (×1)
- Resistance 1.8pts overhead (×1)
**Caution / Partial (109)**
- Hit TP1 — stalled before full target (×66)
- Afternoon entry — momentum often faded (×31)
- Late session — expired near close (×11)
- Resistance at 7235.00 capped the run (×1)


**[2026-05-22] — Footprint chart + Milk Zones display fixes**
- Observation: The WebView chart (`buildHtml()`) had NO footprint canvas at all — `buildProxyFp()` only fed signal scoring, never visual rendering. The footprint `strategies.footprint` toggle existed in context but had no WebView effect.
- Action: Added `fpCanvas` (z-index:7, below zones/ybox), `drawFootprint()` function, and `window.setFootprintData()/setFootprintVisible()` to the WebView HTML. Footprint cells use `priceToCoordinate(price±0.5)` for exact y-bounds per integer price level. Imbalance colors: buy=green 40% opacity, sell=red 40%, neutral=dark 55%. POC highlighted with gold border. Delta right-side label in green/red. Bars skip rendering when `barPx < 18` (too zoomed out to read). In `load()`: tries `GET /api/footprint/history/:sym/:interval` for real DX Feed data first, falls back to `buildProxyFp()` on OHLCV for last 100 candles. Payload stripped to minimal fields (price, bidVol, askVol, imbalance, candleDelta, poc, high, low) to stay under WKWebView injection limit.
- Observation: Milk Zones were loading 30 days of zones (`fromTs = now - 30*86400`), causing all historical zones to draw as simultaneous full-width bands across the chart — completely unreadable.
- Action: Changed `fromTs` to `Math.floor(Date.now()/1000/86400)*86400` (today midnight UTC). Changed `toTime` on each zone to `todayMidnightUtc + 20*3600 + 30*60` (today's RTH settle). Applied `strategies.milkZones` boolean to the `setZones(allZones, visible)` call so the toggle actually hides server-side zones (was previously always `true`). Increased zone fill alpha from 0.18 to 0.25 for slightly better mobile visibility.
- Confidence: high

**[2026-05-23] — Complete UI enhancement: design tokens + all screens**
- Action: Updated `DayTrading/constants/theme.ts` with new design tokens: accent `#3d8ef8`, green `#00e676`, red `#ff4444`, purple `#a78bfa`, border `#1a1a1a`, surface `#0d0d0d`, text `#ffffff`, muted `#888888`. Added new keys: `dim`, `borderDefault`, `surfaceCard`, `gold`. These cascade to all screens automatically via `Trading.*` references.
- Action: `strategy-toggle.tsx` — pill shape (borderRadius 999), iOS shadow glow when active (shadowColor = strategy color, shadowRadius 6, shadowOpacity 0.45).
- Action: `_layout.tsx` — tab bar pure black `#000000`, border `#1a1a1a`, active tint `#3d8ef8`, inactive `#444444`. Updated Explore tab to About with `info.circle.fill` icon.
- Action: `app/index.tsx` (welcome) — title 44px weight 900 letterSpacing 6, subtitle italic gray `#888`, timeframe pills (borderRadius 999), instrument input terminal-style `#c8ffd4` text, Open Chart button blue with shadow glow.
- Action: `(tabs)/index.tsx` (signals) — updated `C` palette to new design tokens, pill timeframe buttons, `C.dim` for filter/header labels, `rlColor`/`ocColor` helpers updated to use `C.up`/`C.down`.
- Action: `(tabs)/journal.tsx` (AutoTrader) — section labels with `#111` border separator, strategy card borderRadius 14, animated pulse dot when connected (Animated.loop scale 1→1.6→1).
- Action: `(tabs)/settings.tsx` — instrument input `#c8ffd4` terminal color, URL input `#a0c4ff` light blue, Save URL button full-width blue with glow, ghost Back button.
- Action: `(tabs)/trade.tsx` — `LoadingCard` with spinner + "Awaiting trade data…" + three skeleton rows (replaces bare ActivityIndicator).
- Action: `(tabs)/explore.tsx` — replaced default Expo explore screen with About screen: app info card, signal tiers with color dots, strategy descriptions.
- Note: Custom fonts (Barlow Condensed, DM Sans, JetBrains Mono) NOT installed — spec calls for them but installation requires expo-font setup + font files. Mono font applied via `Fonts.mono` system alias (ui-monospace on iOS). Display headers use system fontWeight '900' which is visually close.
- Confidence: high


**2026-05-29 — PC↔iPhone parity audit: signal dedup, DST fix, auto-trade sync, signal_new push**
- Observation: `computeSignals()` in `chart-view.tsx` was dead code — never called. iPhone already fetches from `/api/signals/history` (correct path). The dead function was ~300 lines of duplicated signal scoring with stale EXIT_STRAT values (safe.tp1=12.5 vs calibrated 8.5) and proxy-only footprint (2pts max vs PC's 4pts). Left in place, it was a parity risk.
- Action: Deleted all dead code from `chart-view.tsx`: `computeSignals`, `buildProxyFp`, `analyzeFp`, `EXIT_STRAT`, `computeOutcome`, `isBullZone`, and associated constants/interfaces. Kept `OutcomeResult` and `MobileSignal` (exported, used by index.tsx).
- Observation: `isRTH()` in `chart-view.tsx` used hardcoded UTC offsets (13:30-20:00 UTC). In winter (EST=UTC-5), this ends RTH at 3:00 PM ET instead of 4:00 PM ET -- signals in the last hour are classified wrong.
- Action: Replaced with DST-safe version using Intl.DateTimeFormat("America/New_York") -- identical to trading-utils.ts isRTH().
- Observation: Signal-mapping code (DB row to MobileSignal) was duplicated verbatim in two places (initial load + bar_complete handler).
- Action: Extracted to mapDbSignal(s: any): MobileSignal helper. Both callers now use it.
- Observation: iPhone signal sync lagged up to 15 minutes (only refetched on bar_complete WS message).
- Action: Server POST /api/signals/history now calls broadcast({ type: "signal_new", symbol, interval }) after DB upsert. WebView JS forwards signal_new to React Native. iPhone handles signal_new in onMessage with immediate refetch -- sub-second sync.
- Observation: autoTradeEnabled on PC lived only in localStorage -- no server state, no iPhone visibility, no way to kill auto-trade remotely.
- Action: PC toggle now also calls POST /api/trade/settings { enabled } to sync server. Server broadcasts auto_trade_state when enabled changes. PC handles auto_trade_state WS message to stay in sync. iPhone shows read-only "AUTO TRADE ON" badge. PC mount effect reads server state to survive refresh/new tab.
- Confidence: high

**2026-05-29 — iPhone app redesign: cockpit UI, tier badges, hold-to-arm, hero card**
- Action: Updated constants/theme.ts — new cockpit palette (bg:#040d12, cool tint), TIER system (safeplus=emerald #10b981, safe=teal #14b8a6, risky=amber, riskiest=red-orange), arm state colors (armOff/armArmed/armLive), direction (long=green/short=red). Kept Colors.light key — collapsible.tsx and use-theme-color.ts require it.
- Action: New components/tier-badge.tsx — TierBadge + TierChip. Encodes tier as color + glyph (safeplus=diamond, risky=triangle) so tier is never conveyed by color alone.
- Action: New components/sync-chip.tsx — SyncChip with pulsing dot for SYNCED/NOT SYNCED state.
- Action: app/(tabs)/journal.tsx redesigned — master arm banner shows OFF/ARMED/LIVE state. Hold-to-arm uses Animated.timing progress fill over 2 seconds (not a one-tap toggle). Fires POST /api/trade/settings only after hold completes. Not connected = button disabled. Pulse beacon only when LIVE. NOT SYNCED banner when enabled but disconnected. All existing settings (contract type, exit mode, direction, risk levels, intervals) preserved.
- Action: app/(tabs)/index.tsx redesigned — SignalHeroCard at top of signals segment shows most recent signal with tier badge, direction chip, 3-column Stop/Entry/Target (price + pts + $ values), R:R chip, confirmation chips (MilkZone/Vector/Footprint). ScanningCard shown when no signals. Signal feed rows use tier-colored left border instead of flat table. Monospace font for all prices. applyExitProfile, CalendarModal, SignalDetailModal logic unchanged.
- Action: app/(tabs)/trade.tsx redesigned — TradeCard shows 3-column levels (STOP/ENTRY/TARGET) with pts and $ values. PositionTrack is a horizontal bar with risk/reward fill regions and markers for SL/Entry/TP1/TP2 with filled indicator when hit. All fetch/poll/clear logic unchanged.
- CRITICAL: buildProxyFp is used by session-zone overlay and footprint rendering — NOT dead code, even though it's also referenced by computeSignals (which IS dead). When removing computeSignals, must keep buildProxyFp + its FpPriceLevel/FpCluster/FpCandle/FP_THRESH types.
- Confidence: high

**2026-06-01 — iPhone parity sync + animated UI polish**
- Parity: chart-view.tsx `sym` derivation replaced the buggy `.replace(/\d+$/,'')` (which turned MESM6→MESM) with an exact inline port of shared/symbol.ts normalizeSymbol() — strips .CME, =F, CME month-code, and TradingView `1!` suffix. iPhone now resolves the same canonical symbol as the PC.
- Parity: `isValidBar()` now rejects timestamps < 1262304000 or > now+36h, mirroring PC shared/bar-time.ts isSaneBarTime() — defends against future-dated corrupt rows even though the server already clamps them.
- New `components/animated-ui.tsx` (reanimated v4 + worklets 0.5.1, already configured — no babel changes): AnimatedNumber (TextInput + useAnimatedProps + addWhitelistedNativeProps text trick), GlowPulse (breathing shadow for live states), PressableScale (spring press), LivePulse (pulsing dot+ring), Shimmer (skeleton).
- Signals tab: hero card wrapped in FadeInDown entrance + GlowPulse (active when outcome=Open) + PressableScale, level prices use AnimatedNumber. Feed rows get staggered FadeInDown (delay = min(idx,12)*45ms) + LinearTransition layout. ScanningCard icon spins+breathes. Light selection haptic on signal tap.
- Position tab: header card FadeInDown + GlowPulse (live when status=open) + LivePulse on OPEN badge; level numbers animate; price track and mini-chart cascade in with delays.
- AutoTrader tab: arm banner wrapped in GlowPulse (active when LIVE). Hold-to-arm now fires Haptics: Light impact on grip-start, Warning notification on ARM-confirm, Success on DISARM-confirm.
- CRITICAL: reanimated entering animations need a stable `key` to re-fire — hero card uses `key={sig.time}` so new signals animate in. GlowPulse carries the margin (glowWrap style) since shadows render outside the bordered child.
- iPhone tsc: 0 errors.
- Confidence: high

**2026-06-01 — iPhone signal confirmation breakdown now persisted (chips were always greyed)**
- Observation: After the 2026-05-29 decision to delete the iPhone's local `computeSignals` and fetch from `/api/signals/history`, `mapDbSignal()` in `chart-view.tsx` hardcoded `strategies: { fp:false, milk:false, vec:false, milkPts:0 }`. Result: the MilkZone / Vector / Footprint confirmation chips on the hero card, feed rows, and detail modal were ALWAYS shown inactive/greyed — even for SAFE/SAFE+ signals the PC computed WITH milk + vector confluence. The breakdown the PC persisted was incomplete: only `footprint_reading` was stored; `milkOk` / `vecOk` / `milkPts` were computed on the PC but never saved, so the phone had no data to populate the chips.
- Why parity-relevant: the PC is the authoritative signal source and the iPhone is a read-only mirror. The chips are the visible representation of "which signal rules fired", so all-greyed chips directly contradict "signal rules work correctly on the phone".
- Action (5 additive, low-risk edits — the codebase already uses the idempotent `ALTER TABLE ... ADD COLUMN` pattern):
  1. `shared/schema.ts`: added `confirmations: text("confirmations")` to `signalHistory`.
  2. `server/db.ts`: idempotent `ALTER TABLE signal_history ADD COLUMN confirmations TEXT` (mirrors the existing `footprint_reading` ALTER).
  3. `server/routes.ts`: POST `/api/signals/history` now accepts + stores `confirmations`, and refreshes it in `onConflictDoUpdate`. GET returns it automatically via `db.select().from(signalHistory)`.
  4. `client/src/pages/market.tsx`: added `milkPts` to the `confirmations` object at BOTH Long (`milkPtsL`) and Short (`milkPtsS`) push sites + the `confirmations` type, and `confirmations: JSON.stringify(s.confirmations)` in the POST body.
  5. `DayTrading/components/chart-view.tsx` `mapDbSignal()`: `safeParse(s.confirmations)` + `safeParse(s.footprintReading)` → real `{ fp, milk, vec, milkPts }`. Legacy rows (confirmations=null) fall back to: vec=true (vector is a hard prerequisite for every persisted signal), milk = (tier is safe/safeplus), fp = false. New rows are exact.
- The footprint chip `fp` fires when `footprintReading.vetoed !== true && (confirmed || partial)` — matches the PC's `fpFires = fpFull || fpPartial`.
- Verified: iPhone tsc 0 errors; full PC `tsc --noEmit` 0 errors.
- Confidence: high

**2026-06-01 — PC↔iPhone chart/signal parity audit (no regressions found)**
- Audited the full mirroring path after the recent uncommitted refactor. Confirmed still in parity:
  - Chart uses REAL unix timestamps (no compressed timeline). ✓
  - Vector: iPhone `computeVector` = PC `computeVectorLine` — identical `Highest(Lowest(low,20),20)` monotonic-deque algorithm. ✓
  - `aggToInterval`: iPhone 60m bucket offset (`intervalMin===60 ? 1800 : 0`) == PC `get60mBucket` (:30 boundary). ✓
  - 15m display is always aggregated client-side from a 5m fetch on both. ✓
  - `isRTH`: both DST-safe via `Intl.DateTimeFormat('America/New_York')`. ✓
  - Signal fetch keys: iPhone GETs `/api/signals/history/${sym}/${timeframe}`; PC POSTs `symbol=selectedSymbol, interval`. Server `normalizeSignalSymbol` collapses both to the base symbol (MES1!/MESM6/MES → MES); intervals match the timeframe strings. ✓
  - `signal_new` (server broadcast on POST) + `bar_complete` (local) both trigger an immediate iPhone refetch via `mapDbSignal`. ✓
- Known minor (not changed, sub-tick cosmetic): the iPhone's active-interval vector is computed from the 1m→Nm aggregation chain while display candles come from the server's fetch-interval bars; differences are negligible because both derive from the same MW data. Signal marker tier-colors differ slightly by direction on the phone, but tier/direction/levels are identical.
- Confidence: high

**2026-06-01 — AutoTrader real OCO bracket via onOrderFilled (SDK has no native OCO)**
- Root cause: javap on mwave_sdk.jar confirmed MotiveWave's SDK has NO OCO/bracket creation. OrderContext only has createMarketOrder/createLimitOrder/createStopOrder/submitOrders/cancelOrders. The Order interface has NO link/group/oco/parent setter (only getStopPrice, getLimitPrice, getOrderId, getReferenceID, setAdjQuantity, etc). The earlier reflection-based ocoLink() always logged "no method found on bp.aa" — orders stayed independent.
- Fix: removed ocoLink() entirely. OCO is now enforced in the `onOrderFilled(OrderContext, Order)` Study callback: when an exit fills, cancel its sibling. Stop fill → cancel TP(s); final TP fill (TP1 in tp1Only, else TP2) → cancel stop; TP1 partial in 2-TP mode → leave stop for the runner.
- CRITICAL: order IDs CHANGE after submission (created id 845 → filled id 2769237131 in the MW log), so the filled order is matched by PRICE not ID — readOrderDouble(order,"getStopPrice") vs bracketStopPrice, getLimitPrice vs bracketTp1/Tp2Price, with 0.125 tolerance (half a tick). Bracket prices stored in volatile instance fields (bracketStopPrice/Tp1/Tp2/Tp1Only/bracketActive) set in submitBracket, cleared in onPositionClosed.
- The MW study study-list loading issue was separate: `name="Auto Trader"` (space) didn't match a search for "AutoTrader", and ORDER_FLOW license + workspace state. Fixed name to "AutoTrader". strategy=true kept (needed for the Activate tab + OrderContext callbacks).
- Diagnostic to find SDK method names: `javap -cp mwave_sdk.jar com.motivewave.platform.sdk.order_mgmt.OrderContext` (and Order, and study.Study for callbacks like onOrderFilled).
- Deployed JAR: 14189 bytes. Confidence: high.

**2026-06-01 — iPhone chart candle parity (different candles/prices vs PC)**
- Root cause: the server returns IDENTICAL clean data to both clients (same /api/data/cached-continuous endpoint, confirmed 16,834 MES 5m candles), but the iPhone's `isValidBar` only rejected bars with >15% H-L spread. The PC applies a far stricter CLIENT-SIDE multi-pass filter in baseCandles, so corrupt spike/phantom bars the PC removes still rendered on the phone → different candle shapes/prices for the same data.
- Fix: ported the PC's EXACT filter to chart-view.tsx. Two functions: `spikeBarOk(c)` = PC Pass 1 (per-bar: timestamp/finite/price-range, doji-spike `range/close>1.5% && body/range<10%`, wick>1.5%); `filterCandlesPC(bars)` = full 4-pass (spikeBarOk + neighbor-outlier ±20% from prev close + phantom-bar close/open type + isolation ≥7 overlap of nearest 50).
- CRITICAL ordering: the PC for 15m does clean5m(Pass1 on 5m) → agg5mTo15m → baseCandles(full multi-pass on 15m). So the iPhone must match: `rawBars.filter(spikeBarOk)` → `aggToInterval(_, displayMin)` → `filterCandlesPC(_)`. Filtering fully on 5m THEN aggregating gives different results (a corrupt 5m bar poisons its 15m bucket if not pre-cleaned; phantom 15m bars only appear post-aggregation). For 1m/5m/60m the displayMin agg is a no-op so the order still matches the PC's direct multi-pass.
- Both the initial 1000-bar payload and the streamed older chunks slice from the filtered `candles` array, so all displayed bars are filtered identically.
- iPhone tsc: 0 errors. Requires Expo reload to take effect.
- Confidence: high

**2026-06-01 — "Side-Entry Longs" feature: take every vector side entry as a Long with the vector exit**
- Request: "code for the pc program to take every side entry as a long with the vector's exit strategy." Confirmed via question that these should be LIVE signals AND auto-trade eligible.
- The two halves already existed but only as faint chart OVERLAYS: `computeVectorSignals` (side-entry detection) + `computeVectorTradeOverlays` (vector trailing-stop exit). The feature promotes them into first-class emitted signals.
- Implementation (all in market.tsx unless noted):
  - New persisted toggle `takeSideEntries` (state near `useZoneTargets`, added to the settings persist object + dep array, UI switch "Side-Entry Longs" after the Zone Targets toggle).
  - Detection injected INSIDE `allConfluenceSignals` right after the footprint-pointer advance (so the closure `walkForward` — which references the outer loop's `i`/`c` — is usable for the outcome). Side entry = `sePrev.close < sePrevLb && c.close > lb && (lb - sePrevLb) < 0`.
  - Bracket = vector exit strategy constants: `sl = max(vector − VEC_STOP_BELOW(3.5), entry − VEC_MAX_STOP(8))`, `tp1 = entry + VEC_TP1(7.5)`, `tp2 = entry + VEC_TP2(26)`. Outcome via shared `walkForward` (honours trailer toggle). Levels locked under `${time}_Long_SE`.
  - Candidates collected in a separate `sideEntryRaw[]` during the scan, then merged into `raw` AFTER the loop, SKIPPING any bar where a confluence Long already fired (prevents the `(symbol,interval,timestamp,direction)` DB unique-key collision — both persist as direction "Long").
  - Emitted as `riskLevel:"risky"`, `signalType:"vector-side-entry"`, `confirmations:{milkOk:false,vecOk:true,...}`.
  - Auto-trade: gate in `fireSignalNotification` now `const isSideEntry = sig.signalType === 'vector-side-entry'; riskOk = isSideEntry || (isPermanentRisk && ...)`. Explicit authorized exception to the safe/safe+ rule (still honours interval + direction filters + 3s confirmation). Added `signalType?` to the `sig` param type.
  - Persistence: added `signalType: s.signalType` to the `/api/signals/history` POST body (server already accepted/stored `signalType`).
  - Type fix: `CandlestickChart.tsx` `confluenceSignals` prop had `signalType?: "confluence"|...` literal union — widened to `string` (it's cast to string at use site anyway) so `allConfluenceSignals` (CSig.signalType broadened) assigns cleanly.
- iPhone parity: side-entries flow through `/api/signals/history` → `mapDbSignal` → shown as a risky Long with the Vector chip lit. Visible on the chart by default (`chartRiskLevel` defaults to "risky", side-entries are quality-2 "risky" ≥ minQ).
- Caveat to watch: no extra cooldown ("every" side entry) — relies on the fresh-cross condition (no consecutive dupes) + the server single-trade lock + 3s confirmation to bound auto-trade order spam.
- Verified: PC `tsc --noEmit` 0 errors; iPhone tsc 0 errors.
- Confidence: high

**2026-06-01 — iPhone live-candle offset + signal display parity**
- Live-candle bug: the WebView live tick/bar handler bucketed with `floor(t/displaySec)*displaySec` (no offset), but the historical aggToInterval uses a 30-min offset for 60m (get60mBucket → :30 boundaries). So on a 60m chart the forming/most-recent candle landed a half-hour off the historical bars. Fixed: live bucketing now applies `liveDisplaySec===3600 ? 1800 : 0` offset in BOTH the tick and bar handlers to match aggToInterval exactly.
- Also added a live-bar spike guard in the WebView JS (same wick>1.5% / doji-spike test as historical spikeBarOk) so a corrupt live bar can't paint a giant wick on the most-recent candle.
- Signal parity: the PC's actual current display rule (after the isStrong/totalPts signal-quality work was reverted by a file restore) is `confluenceSignals = allConfluenceSignals.filter(RISK_QUALITY[riskLevel] >= RISK_QUALITY[chartRiskLevel])` with RISK_QUALITY={safeplus:4,safe:3,risky:2,riskiest:1} and default chartRiskLevel="risky" (=2) → chart shows safeplus/safe/risky, hides riskiest. The iPhone was showing ALL persisted tiers. Fixed: added `isPcDisplaySignal(s)` = `RISK_QUALITY[riskLevel] >= 2` applied to all 3 iPhone fetch paths (initial load, bar_complete, signal_new). NO PC/schema/persist change — pure iPhone filter on existing DB rows.
- GOTCHA: don't assume CSig has totalPts/isStrong — that signal-quality work was reverted; the live market.tsx CSig has milkPts in confirmations but no totalPts/isStrong. Always grep the current type before referencing fields.
- LIMITATION: the iPhone hardcodes the PC DEFAULT chartRiskLevel ("risky"); if the user changes chartRiskLevel on the PC it won't sync (no endpoint exposes it). Default-match covers the common case.
- Both tsc clean. Requires Expo reload (iPhone-only change).
- Confidence: high

**2026-06-01 — PC UI overhaul: "Midnight Glow" theme + animation/effects layer (cosmetic only)**
- Goal: make the PC program's UI cooler/more pleasing with animations & effects. Chose "Midnight Glow" (deep navy + electric-blue glow) via a question. Implemented as a COSMETIC-ONLY pass — no layout/logic changes — so the chart, signals, and auto-trade are untouched.
- The whole PC chrome is inline-styled off a single `MW` palette object (market.tsx line ~832) PLUS a duplicate `MW` exported from `client/src/lib/trading-utils.ts` (used by the secondary pages). Updating BOTH to the same Midnight Glow values recolors EVERY page's chrome cohesively in one shot. The chart itself uses `CHART_THEMES` (in CandlestickChart.tsx) — separate, so the palette change does NOT affect chart rendering. KEY LESSON: `MW` is the single highest-leverage styling lever for the chrome; change it (both copies) before hand-editing individual elements.
- Added a global effects layer at the END of `client/src/index.css` (all `mg`-prefixed to avoid collisions with the existing `pulse`/`spin`/`fadeInRight`): layered deep-navy radial-gradient app background (static, `background-attachment: fixed` — NOT animated, to avoid full-viewport repaints behind the live chart canvas), custom glowing scrollbars, universal smooth transitions, a universal `button:not(:disabled):hover { filter: brightness(1.12) }` micro-interaction (makes the whole UI feel alive with ONE rule, since buttons are inline-styled with no shared class to target), electric focus rings + selection, and utility classes `.mg-glass/.mg-glow/.mg-glow-pulse/.mg-fade-up/.mg-fade-in/.mg-pop-in/.mg-float/.mg-accent-text/.mg-accent-bar/.mg-shimmer/.mg-lift/.mg-backdrop` + keyframes. Includes a `prefers-reduced-motion` guard.
- Targeted polish (market.tsx): toolbar got a navy gradient + downward blue glow + an absolutely-positioned animated flowing `.mg-accent-bar` underline; the symbol ticker uses `.mg-accent-text` (animated gradient). Live signal alert: deeper layered glow + backdrop blur + springier entrance + `.mg-lift`. Zone-paste modal, chart loading overlay, and signals-panel slide-over: `.mg-backdrop` blur + `.mg-pop-in`/`.mg-fade-in` + blue-tinted glow shadows, and replaced leftover hardcoded near-black literals (`#05080d`/`#090d14`/`#1a2535`) with `MW.*` tokens so they track the palette.
- GOTCHA: don't put `background-attachment: fixed` animated gradients behind the chart — keep the body gradient static. Animate only small elements.
- GOTCHA: `.mg-accent-text` needs BOTH `-webkit-text-fill-color: transparent` and `color: transparent` (+ `background-clip:text`) or the gradient won't show.
- Verified: PC `tsc --noEmit` 0 errors; `vite build` clean (mg- classes confirmed in dist/public/assets/*.css).
- Confidence: high

**2026-06-02 — Signal TIER LOCK (risk factor flicker fix)**
- Bug: a fired signal changed its risk factor (safeplus/safe/risky/riskiest) multiple times. Root cause: `allConfluenceSignals` recomputes every tick, and although it skips the forming bar (`complete===false`), the SAME completed bar gets re-evaluated as footprint (footprintCandlesRef), milk zones (activeZones), vector (vecMap), and win-rates load asynchronously — each re-derives `level`, so the tier flickered. The SL was also unstable: `sl = entryClose - slF` recomputed slF from the live `level`.
- Fix: added `lockedSignalTierRef: Map<"${time}_${direction}", { riskLevel, confirmations, footprintReading, confidence }>`. On a signal's FIRST fire (after it passes the cooldown + time gates), the tier + exact footprint/milk/vector breakdown is frozen. Every later recompute reuses the locked tier for: the after-20:00 time gate (`effLevelL`), `tierExits(lockedTier)` (so SL is stable), and the pushed signal's riskLevel/confirmations/footprintReading/confidence. Applied symmetrically to Long and Short.
- Persistence: the tier lock is restored from the DB on symbol/interval load (reads riskLevel + confirmations + footprintReading from /api/signals/history) so a reload reuses the same tier instead of re-deriving it. Cleared on symbol/interval switch. NOT cleared on exitStrategy change (tier is independent of the TP/SL profile — only price levels recompute there).
- Why accuracy holds: signals only fire on COMPLETED bars, and footprint streams in real-time during the bar, so the first-fire tier already reflects the real footprint+milk+vector reading; the lock just stops late data from mutating it. Old historical signals restore their tier straight from the DB.
- Auto-trade now reads a stable `sig.riskLevel` → no more tier-flip mid-decision.
- PC tsc clean. PC-only change (server/iPhone untouched).
- Confidence: high

**2026-06-02 — Single-tier signals: remove risk categories, every signal is "safe"**
- User request: eliminate risk tiers entirely. A signal only fires if it clears the existing SAFE quality bar; every signal is labeled "safe"; the old risky/riskiest (weaker) setups stop being signals at all (not relabeled — dropped). SAFE+ setups still fire, just labeled "safe". Quality-over-quantity preserved (only ≥safe-quality fires).
- market.tsx (Long + Short): replaced the 4-tier `level` computation with `safeQuality = totalPts >= 4 || fpOnMilkZone || fpPartialOnZone` (the exact old "safe-or-better" set). `level = "safe" as const`. Gate simplified to `if (!nearHod/Lod)` (the after-20:00 risky/riskiest exclusion is now vacuous). Exits use `tierExits(level)` = safe profile, push `riskLevel: level`.
- CONTAMINATION GOTCHA: the tier-lock (lockedSignalTierRef) loads OLD riskLevels from the DB (safeplus/risky/riskiest). Pushing `lvlL = tierL.riskLevel` would re-emit those old tiers. Fix: push `level` ("safe") for tier + exits, and use the lock ONLY to freeze confirmations/footprint (so chips don't flicker); confidence falls back to `tierL.confidence ?? confL`.
- confluenceSignals simplified to `allConfluenceSignals` (no RISK_QUALITY/chartRiskLevel filter). Risk-level `<select>` dropdown removed from the chart toolbar. SignalsPanel risk-filter buttons (All/SAFE+/Safe/Risky/Riskiest) removed; `defaultRiskLevel="all"`.
- SignalsPanel internal `computeSignals` (used by /today-signals without externalSignals) also changed: fire only `totalPts >= 4`, label "safe". WATCH BRACES — removing the nested guard `if` drops one `{`/`}` level; the old_string must include the matching close or you get an orphan `}` (hit TS1128 here, removed the stray brace).
- iPhone isPcDisplaySignal: now `riskLevel === 'safe' || 'safeplus'` (hide retired risky/riskiest in old DB rows).
- Both PC + iPhone tsc clean. PC change is the source of truth; reload page (PC) and Expo (iPhone).
- Confidence: high

**2026-06-02 — Real footprint fix (was fabricated by a wrong reflection method name)**
- Root cause: LiveBarRelay.java onTick footprint accumulator used reflection to GUESS the Tick's aggressor-side method: `extractBool(tick, "isAsk","askTick","isBuyTick")`. None of those exist on the MW SDK Tick — confirmed via `javap -cp mwave_sdk.jar com.motivewave.platform.sdk.common.Tick`: the real methods are `getVolume()`, `isAskTick()`, `getBid/AskPrice/Size()`. So aggressor side ALWAYS fell through to false → every trade counted as "bid" (aggressive sell) → permanently sell-biased fabricated delta. Second bug: `getVolume()==0` on quote-only ticks was treated as "1 contract", polluting footprint with phantom volume.
- Fix: `tick` is already typed as the SDK `Tick`, so dropped reflection entirely — `int vol = tick.getVolume(); if (vol > 0) { if (tick.isAskTick()) ask+=vol else bid+=vol; }`. Quote-only ticks (vol==0) are skipped. Removed extractLong/extractBool + warnedNoVol/warnedNoSide. Footprint is now REAL bid/ask-per-price order flow from Rithmic via MW.
- KEY LESSON: MotiveWave's Tick SDK exposes real trade size + aggressor side directly (getVolume/isAskTick). Never reflect-guess SDK method names — `javap` the jar. The whole "footprint is a synthesized proxy" belief was wrong for LIVE data; only the wrong method name made it look synthetic.
- Scope: live/forward footprint is now real. Historical bars (no stored tick history) still use buildProxyFootprintCandle — unchanged, only affects how old bars look, not live signals. This made the Rithmic-bridge migration unnecessary.
- Deployed LiveBarRelay.jar 11507 bytes (compiles clean; warnings are just SDK Java-26 vs JDK-17 version mismatch). Requires MW restart to load.
- Confidence: high

**2026-06-02 — Signal FIRE-LOCK (a fired signal can never disappear from the chart)**
- Problem: the tier was locked, but the FIRING DECISION (`if (safeQualityL)`) was re-evaluated every recompute. If late-arriving footprint/milk/vector data dropped a fired signal below the safe threshold (totalPts<4), the whole push block was skipped → the dot vanished from the chart.
- Fix: restructured both Long and Short signal blocks. Compute `lockKey`/`existingTier`/`safeQuality`/`cooldown` up front, then gate on `if (existingTier || newFire)` where `newFire = safeQuality && !nearHod/Lod && cooldownOk`. An already-fired signal (its tier is in lockedSignalTierRef) re-emits UNCONDITIONALLY every recompute — bypasses safeQuality, HOD/LOD, and cooldown. Once a dot appears it stays for the session. The cooldown anchor (lastLongBar/lastShortBar) now advances on EVERY emit (locked re-emit included) so new signals stay spaced from the last shown one.
- BRACE GOTCHA: this removed two nesting levels per block (the `if (!nearHod)` and `if (cooldown)` wrappers collapse into one `if (existingTier || newFire)`). Had to drop 2 closing braces at each block's tail (3 `}` → 1 `}`). Always recount closes when flattening nested guards.
- Persistence: lockedSignalTierRef restores from DB on mount, so resolved signals survive reloads; cleared on symbol/interval switch. Within-session, no fired dot ever disappears.
- iPhone unaffected (it renders static DB signals, no live recompute).
- PC tsc clean. Reload page to apply.
- Confidence: high

**2026-06-02 — MERIDIAN terminal integrated as the new home UI (design source of truth)**
- Integrated the `trading-terminal.jsx` mockup as the VISIBLE face of the app. Split into `client/src/components/terminal/` (ShaderBackground, TerminalChart, MarketView, SignalsView, SettingsView, Clock, controls, icons, strategyMeta, terminalStyles) + `client/src/pages/terminal.tsx` (root) + `client/src/hooks/useTerminalData.ts` + `client/src/lib/terminalSettings.ts`. NOT one giant file.
- ARCHITECTURE (key): MarketPage is the always-mounted ENGINE (signals/WS/auto-trade/notifications). The terminal is a PURE CONSUMER of that real data — exactly like the iPhone app. In App.tsx, MarketPage now renders hidden (display:none) except at `/classic`; the terminal is the visible `/`. This means the trading engine is never touched — zero risk to signal generation / auto-trade.
- Real data wiring: candles ← `GET /api/data/cached-continuous/:symbol/:interval` (mapped to {time,o,h,l,c}, last 64); signals ← `GET /api/signals/history/:symbol/:interval` filtered to today (ET, DST-safe etDayStartSec) + live `signal_new` over `/ws/live-bars`; live price/forming-bar ← `tick`/`bar` WS msgs; `data_updated` → silent refetch (NO chartKey bump so the wave reveal doesn't replay). Wave reveal replays ONLY on reload button + entering Market tab (chartKey++).
- 4 confirmed decisions: SINGLE-TIER (every signal "SAFE"; dropped RISKY/RISKIEST/SAFE+ filters + tier-scaling + min-tier settings; SignalsView filter is now by SIDE); terminal REPLACES home; settings PERSIST + mirror shared keys into engine's `mwb_settings` (read-modify-write merge so engine keys aren't dropped; takes effect on engine's next mount/reload); Pattern strategy REMOVED.
- Shared-settings mapping (terminal → mwb_settings): symbol→selectedSymbol, session ETH→showETH, MilkZone→showMilkZones, Vector→showVector, Footprint→showFpPanel. Terminal-only settings (minStop/maxRisk/tp2/monte/ml/etc.) live under `meridian_settings`.
- CLOBBER NOTE: MarketPage's persist effect does a FULL overwrite of mwb_settings with only its own keys; it only re-runs when ITS state changes (won't, while hidden/unused), so it won't clobber terminal writes mid-session. On reload both load from the same mwb_settings → consistent.
- Preserved verbatim: WebGL shader bg, Chakra Petch + IBM Plex Mono (Google Fonts @import in CSS string), full palette, corner-bracket HUD, wave-charting reveal, animated Strategies dropdown, tab transitions, ET clock + open/closed pill.
- BUILD: `tsc` (npm run check) clean exit 0; `vite build` clean exit 0. `npm run build` (server esbuild) fails on PRE-EXISTING errors in server/routes.ts (top-level await) + server/db.ts (import.meta under cjs) — unrelated to client; `npm run dev` is unaffected.
- UX note: the terminal's tabs are only Market/Signals/Settings. Other pages (/data /news /journal /backtest /today /predictions /discord /timestamps) are still reachable by URL and the full old UI lives at `/classic`. No nav link was added into the pristine MERIDIAN header (preserve design exactly) — revisit if the user wants a nav/launcher.
- Confidence: high

**2026-07-17 — ALL signals replaced with the optimized program strategy (ported from the backtest work)**
- NEW `shared/firing/optimized.ts` (framework-agnostic per firing-module rules): ICT Zones + Candle Body during RTH — an RTH candle tests-and-holds an ICT zone (FVG/Order Block/structural, ±2 pts) AND closes in the trade direction. Trades BOTH 5m (TP1 +4/TP2 +8/SL −4) and 15m (TP1 +8/TP2 +16/SL −4) with per-interval grid-calibrated exits (validated on a held-out test window; benchmark month: 5m +332 pts @ 58.3% WR, 15m +412 pts @ 52.5% WR). Baseline risk filters kept: 10-bar cooldown, HOD long suppression, 60m declining-vector long veto, settlement-break skip, session-settle exits.
- market.tsx: the 540-line legacy `allConfluenceSignals` confluence engine (footprint tiers, tabletops, side-entries, trailer, locks) REPLACED by a thin adapter over the shared engine; signals tagged with their strategy interval; notification/auto-trade path groups by SIGNAL interval; bg scanners emptied; persist effect stores rows under the signal's own interval; "Trade on intervals" reduced to 5m/15m (default both).
- strategyLabel: signalType "optimized" → "ICT Zone + Body".
- NEW `DELETE /api/signals/history` — one-time wipe of legacy persisted signals (run once after deploy: `fetch('/api/signals/history',{method:'DELETE'})`).
