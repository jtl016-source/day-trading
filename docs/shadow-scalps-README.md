# Shadow scalps: S1 ORB-30 and S2 yellow-box edge fade (record only, 2026-10-06)

**What this is:** a nightly recorder that writes hypothetical small-target trades for two candidates
from `docs/scalping-research-2026-10-06.md` (§4 rows 1–2, §7 plan), so the kill and promotion rules
can be judged on a forward sample. There is no random-entry control (owner decision 2026-10-07, §0).

**What it is not:** it never places an order, never sends an alert, and is never an engine input.
`server/shadow-scalps.ts` imports only `./db`, `./yellowbox` (called through a cache-only handle, see
§2) and `@shared/yellowbox-core`. The only table it writes is `shadow_scalps`.

| Piece | Where |
|---|---|
| Recorder, simulation, summary, digest line | `server/shadow-scalps.ts` |
| Read-only route | `server/shadow-scalps-routes.ts` → `GET /api/signals/shadow-scalps/summary` |
| Table | `shadow_scalps` (`shared/schema.ts`, DDL in `server/db.ts`) |
| Job + digest line | `server/scheduler.ts` (tick step 5; digest "Shadow scalps: …") |
| Tests | `scripts/shadow-scalps.test.ts` (temp SQLite via `DB_PATH`; in `npm test`), `scripts/shadow-scalps-card.test.ts` (card helpers) |
| Card | `client/src/components/terminal/ShadowScalpsCard.tsx` (Signals tab) |

---

## 0. Owner decision 2026-10-07: no random-entry control

The owner removed the random-entry control ("ok take it out then"). Until then every session also
recorded 20 hour-matched random entries per strategy ("null-S1" / "null-S2", variant "random"), and
promotion required beating them by a one-sided Welch z at p < 0.05/3. Now:

- **Recorder:** nightly, catch-up and retry runs write only S1 and S2 rows.
- **Legacy rows:** the first boot after this change deletes every `strategy LIKE 'null-%'` row from
  `shadow_scalps` (`purgeLegacyNullRows`, before the boot backfill / catch-up). It is idempotent and
  logs one line when it removed rows (`[shadow-scalps] removed N legacy random-control rows …`); a
  boot with nothing to remove logs nothing. It deletes in chunks of 2,000 ids, one statement per
  event-loop turn: on a temp table with 32,040 such rows next to 3,204 strategy rows it took
  116–125 ms in total with a max chunk of 33–34 ms (a single DELETE was 67–94 ms in one block).
  A failed purge (e.g. SQLITE_BUSY) is logged and retried on the next boot.
- **What the live table holds today** (read-only count of `data/app.db`, 2026-10-07): 25,920 control
  rows (null-S1 16,020 on 89 days, null-S2 9,900 on 55 days) and 5,443 strategy rows (S1 873 on 85
  days, S2 4,570 on 55 days), all era "backfill". Row counts quoted further down (31,363 etc.) were
  measured with the control rows included.
- **Live purge (done):** the server restarted at 11:42 ET on 2026-10-07 (an external restart, not
  this change) and the boot purge logged `removed 25920 legacy random-control rows … max chunk 149ms,
  2165ms total`. The live chunks were slower than the offline measurement because the boot catch-up,
  gap audit and chart reads were using the same SQLite file in those seconds. It is a one-time cost:
  the table now holds only the 5,443 S1 / S2 rows, so later boots delete nothing.
- **Session count and halves shift:** the control rows covered every recorded day (89). Without them,
  "sessions" counts only days with an S1 or S2 row (87 on the live table), so the halves split day
  moved from 08-04 to 08-05. That changes the S1 backfill halves in §5; the totals are unchanged.
- **Reads:** the summary route and the digest read `strategy IN ('S1','S2')` in SQL, and the pure
  summary skips any other strategy, so leftover control rows are never shown or counted, even before
  the purge has run.
- **Route body:** `nullNetPerTrade`, `nullN`, `minusNull`, `z` and `p` are gone from every row, and
  `nullNetPerTrade`, `z`, `p` and `promotion.beatsNullOk` from every decision. `rules.promoteAlpha` is
  gone. The card was the only consumer.
- **Card:** the RANDOM and Δ vs RANDOM columns and the "Random rows are the control" sentence are
  gone. The footnote is "Record only — no orders, no alerts."
- **Digest line:** unchanged in shape; it never named the control.

**What the promotion bar is without a control.** Nothing is compared to random entries any more, so
the bar is the break-even arithmetic of the decision bracket plus the robustness checks. At TP 6 /
SL 8 with 1.0 pt round-trip friction a win nets +5 and a loss nets −9, so the bracket breaks even at
9 / 14 = **64.3 % wins**. Under the pessimistic fill model, which the rules use, the stop fills one
tick worse (−8.25 gross, −9.25 net), which moves break-even to 9.25 / 14.25 = 64.9 %. The +0.3/trade
promotion threshold needs about 67.0 % wins at pessimistic fills (66.4 % without the stop slip). A
test pins this: 64 % → −0.13/tr, 65 % → +0.01, 67 % → +0.2975 (fails), 68 % → +0.44 (passes).

On top of that number, the checks that guard against luck are: both halves of the live span positive,
net/trade still positive with the best 3 session days removed, and n ≥ 300 live trades. These are
weaker than a matched control. They cannot tell a real edge from a favourable stretch of tape that
any entry would have caught, which is why the manual steps after promotion (§4) stay.

## 1. The strategies (fixed 2026-10-06, before any forward result; the code matches this text)

**S1 ORB-30:** RTH only. Range = high/low of the 1m bars 09:30:00–09:59:00 ET. Entry signal = first
1m bar whose CLOSE is above the range high (Long) or below the range low (Short); at most ONE Long and
ONE Short per day; signals only until 12:00 ET. Entry price: standard = next bar's open; pessimistic =
next bar's open + 1 tick against you; optimistic = the signal bar's close. Exit: bracket from the
entry; also flat at 16:55 ET at that bar's close if still open.

**S2 yellow-box edge fade with a resting limit:** RTH only. Levels = the day yellow box top and bottom.
Arm a fade limit at the edge only while price is within 2 pts of it (bar high/low within 2 pts). Fill
rules: optimistic = a bar touching the level fills at the level; standard = the bar's extreme must
exceed the level by ≥ 1 tick (trade-through) to fill at the level; pessimistic = trade-through ≥ 1 tick
AND the fill is 1 tick worse. Direction: Short at the top edge, Long at the bottom edge. Also record
the bar-close variant (wick through, close back inside → enter at next open) for comparison, tagged
variant "close". At most one open S2 trade per direction at a time; re-arm after exit.

**Bracket cells:** decision cell TP 6 / SL 8; learning cells TP 4 / SL 6 and TP 5 / SL 8. Outcome walk
on 1m bars from the bar AFTER entry: both touched in one bar = loss; stop fills at the level
(standard/optimistic) or 1 tick worse (pessimistic); target fills at the level (optimistic/standard)
or needs trade-through by 1 tick (pessimistic); flat at 16:55 ET. Points net of friction shown for
0.7 / 1.0 / 1.5 pt in the summary (gross points are stored; friction is applied in the summary).

**NULL population:** REMOVED by the owner on 2026-10-07 (§0). The original text called for 20
hour-matched random entries per session and strategy, stored as "null-S1" / "null-S2"; they are no
longer recorded and the old rows are purged at boot.

**Era:** rows for sessions BEFORE the first live run are tagged era="backfill". This runs once at boot
if the table has no rows: the last 90 sessions from cached_candles, chunked per day via setImmediate.
Rows produced by the nightly job are era="live". The kill and promotion rules count ONLY era="live".

---

## 2. How the code reads those rules

Where the text above leaves a choice open, this is what the code does. Every point has a test.

**Session clock.** Every boundary is `etWallToEpoch(dayKey, h, m)` (Intl, `America/New_York`). The code
never uses a UTC offset. A session is an ET weekday. Only its 1m bars from 09:30 up to but not including
16:55 ET are read, so the walk ends on the 16:54 bar.

**The 16:55 flat** exits at the close of the 16:54 bar, which is the price at 16:55:00. On a short
session it exits at the last bar's close.

**S1:**
- The opening range comes from the 30 bars stamped 09:30 through 09:59.
- A close *equal* to the range high or low is not a breakout.
- The first close beyond the range uses up that side, whether or not an entry follows.
- The signal bar must start before 12:00 ET.
- The optimistic entry is stamped at the signal bar's close time.

**S1 data guards** (these are not strategy rules):
- The range needs at least 25 of its 30 bars, or S1 records nothing that day.
- A market entry needs a next bar within 300 s of the signal bar.

**S2 levels: the source.** S2 reads `getYellowboxDayZones` in `server/yellowbox.ts`. This is the
function behind `GET /api/yellowbox/day-zones`, which the engine's catch-up fetches
(`server/catchup.ts`). The code takes the `boxTop` and `boxBottom` of the session's `dayKeyET`.

**S2 reads only a day box that is already frozen** in `yellowbox_day_zones` at the current
`YB_CACHE_VER` and the current mwml import hash. That is exactly the row the day-zones route serves for
that day. The recorder never derives a box itself:
- First, one primary-key read checks for a row at the current `YB_CACHE_VER`. Without one, the source is
  not called at all.
- Otherwise the source runs through `cacheOnlySqlite`, a fail-closed handle. It may only prepare the warm
  path's reads: SELECTs on `yellowbox_day_zones` and the one-row `… LIMIT 1` bar probe. Any other
  statement is refused before it runs. That covers the cold path's 130-day 5m/60m bar loads, its cache
  INSERTs, and anything added to `yellowbox.ts` later. So a stale import hash also ends here, without
  work.
- **Why:** the earlier no-write wrapper let the cold path run on every uncached day. The verifier measured
  that at 328 ms median and 671–1943 ms max per day over 90 days with an empty cache. That would recur
  after every `YB_CACHE_VER` bump or `.mwml` change.

**A day whose box is not frozen yet** records S1 at once. S2 is deferred:
- Every row of the day carries `zone_state = 'pending'`.
- The scheduler's retry pass (§3) re-records the whole day once the box has been frozen. The retry is
  triggered by the catch-up, which runs again from the 18:00 ET Globex reopen, or by any chart.
- The S1 rows come out identical on the re-run.
- A pending day that produced no rows at all (for example an incomplete opening range) is remembered in
  memory instead.

**Box provenance per row:** `zone_state` (`cached` / `pending` / `none`), plus `zone_top` and
`zone_bottom`, the RAW frozen box the day's rows were built from. The S2 `level` is the tick-snapped
edge actually faded. `none` means the frozen day has no usable box, so it gets no S2 rows.

**What "the frozen box" means for history (disclosed, not fixed here — a `yellowbox.ts` cache
matter):**
- Frozen rows are not always what a fresh derivation would give today. The verifier (2026-10-06) compared a cold recompute with the live
  DB's frozen rows over the 90 backfill sessions: 62 equal, 28 different.
- Most of the September differences are +0.02 or +0.03 on the top edge. Those bars were repaired after
  the rows froze (the Sep roll repair).
- **2026-08-26 through 2026-09-02** (six sessions) all carry the IDENTICAL frozen box 7679.04 / 7662.81.
  A recompute gives day-specific boxes 20–60 pts away, for example 08-28 cold 7740.43 / 7724.48.
- S2 fades the frozen value on purpose. It is the box the day-zones route served, which is what the engine
  and the chart used. But for those six backfill days S2 is fading a stale level. Read their S2 rows with
  that in mind (`zone_top` / `zone_bottom` show it). They are backfill-era rows and never count.

**Idempotence:**
- Re-running a day against the same frozen box replaces it with identical rows.
- Because only frozen rows are used, a cold-cache run followed by its retry and a warm run produce the
  same table. Measured on the live data copy: 31,363 rows each, byte-identical. Before this change the
  verifier saw 31,534 cold vs 31,363 warm.
- If a frozen row is later regenerated (`YB_CACHE_VER` bump or `.mwml` change), already-recorded days are
  NOT re-recorded automatically. Only pending days and the nightly day are re-run. So a recorded S2 day
  keeps the box shown in its `zone_top` / `zone_bottom`. A manual re-run of such a day would pick up the
  new box.

**S2 edge snap.** The box is a derived 2-decimal statistic, for example 7670.71, and a limit can only
rest at a tick price. Each edge is therefore snapped to the nearest tick (7670.75), and every S2 rule
uses that price.

**S2 arming.** A limit rests during bar *j* only when both of these hold:
- bar *j−1* is the contiguous previous minute (the order is placed off a completed bar);
- bar *j−1* closed on the inside of the edge with its high (top) or low (bottom) within 2 pts of it.

**S2 limit fill bar:**
- The entry is stamped at the fill bar's open time.
- The target is never scored inside the fill bar, because that bar's opposite extreme may have come
  before the fill.
- The stop *is* checked inside the fill bar. Price had to pass through the level to reach a stop beyond
  it, so an adverse extreme past the stop in that bar is certainly after the fill.
- The walk proper starts on the next bar.

**S2 "close" variant.** The previous bar closed inside. The signal bar's wick goes through the edge by
at least 1 tick (an exact touch is not a wick through) and the bar closes back inside. Entry uses the S1
entry rules (next open; +1 tick for pessimistic; signal close for optimistic).

**One open per direction** is tracked separately for each cell × fill model × variant. Each pairing
simulates its own position, so the trade sets differ slightly.

**Nulls:** none since 2026-10-07 (§0). The recorder no longer computes eligible minutes or draws
random entries; `seq` is always 0.

**Session data guard (roll cliff).** If any RTH bar opens ≥ 30 pts away from the previous bar's close,
the whole session is not recorded and any old rows for that day are removed. This is a contract-roll
seam or a bad print. 2026-09-14 is the known case: the +67.25 Sep→Dec Yahoo roll at 11:30 ET. It is
rejected in every run.

**Era of a re-run day.** A day's rows are replaced in one transaction (DELETE that day, then INSERT). A
day that already has rows keeps its era: a backfilled day that the nightly job or the retry re-runs stays
"backfill".

### Choices for the owner to confirm

These go beyond the literal spec text. The verifier listed them, and none of them is a refutation. Each
one is a one-line change if you want it the other way.

1. **16:55 flat** = the 16:54 bar's close (the 16:55:00 print). The 16:55 bar itself is never read.
2. **S2 arming** is judged on the PREVIOUS contiguous bar: its high or low is within 2 pts AND it closed
   inside the edge. The spec says only "bar high/low within 2 pts".
3. **S2 "close" variant** also requires the previous bar to have closed inside the box, and a wick
   through of ≥ 1 tick. An exact touch does not count.
4. **S1 data guards** that are not in the spec: the range needs ≥ 25 of 30 bars, and a market entry
   needs a next bar within 300 s.
5. **Roll-cliff guard:** a whole session is dropped, and its old rows deleted, when any RTH bar opens
   ≥ 30 pts from the prior close.
6. **S2 levels are the FROZEN day box** (this section), never a fresh derivation. S2 for a day waits
   until the box is frozen.

---

## 3. When it runs (`server/scheduler.ts`, after the 3-minute boot-quiet window; tick every 30 s)

**First tick after boot:**
- If the table is empty, it backfills the last 90 finished sessions that have RTH 1m bars, as era
  "backfill".
- Otherwise it records every finished weekday session after the newest recorded day, as era "live".
  These are the sessions missed while the server was down.

**Nightly:** on weekdays at or after 17:30 ET (after the 17:20 session review), once per ET date, it
records that day's session as era "live".

**Retry pass:** at most every 10 minutes, at most 10 sessions per pass, newest first. Each one is an
ordinary idempotent re-record that keeps its era. It handles two cases:
- **Deferred-S2 days.** A pending day is a candidate only once a `yellowbox_day_zones` row at the
  current version exists, checked with one primary-key read; otherwise it is skipped without calling
  the source. The catch-up only runs while the market is open, so on a normal weekday the nightly run at
  17:30 records S1 with S2 pending. The first catch-up after the 18:00 ET reopen freezes the day's box,
  and the next retry (≤ 10 min later) completes S2. A Friday completes after the Sunday 18:00 reopen,
  or earlier if a chart loads the day-zones.
- **Sessions that threw.** For example SQLITE_BUSY after the 5 s busy_timeout while the engine worker
  holds a write lock. Each session runs in its own try/catch: a throw rolls that day back, is logged as
  skipped `error: …`, and never aborts the remaining sessions. Such a day is retried up to 6 times per
  process; the in-memory list is lost on restart, where the boot catch-up covers the newest days.

**Main thread:**

Each session is one synchronous chunk: one indexed bar read, one frozen-box read, an in-memory
simulation, and one DELETE + INSERT transaction. Sessions yield to each other with `setImmediate`.

Measured on 2026-10-07 on a temp copy of the live bars, with the live `data/app.db` opened read-only.
These are event-loop delays (`perf_hooks.monitorEventLoopDelay`), on this busy machine:

| Run | Result |
|---|---|
| Boot backfill, **cold** day-zone cache (empty `yellowbox_day_zones`, i.e. right after a `YB_CACHE_VER` bump) | 89 sessions in ~1 s, max chunk 37–61 ms. S2 deferred on all 89 days; 0 yellowbox rows written. The verifier's measurement of the old code was 328 ms median, 671–1943 ms max per chunk. |
| Per session, **warm** | Bar read 0.6 ms, frozen-box read 1.5 ms, simulation 2.6 ms (medians). The whole `recordSession` took 12–16 ms median, p90 ~22 ms. Spikes of 42–105 ms came from the write transaction, plus one 233 ms chunk in one of three warm backfill runs. |

- The read and simulation parts never exceeded 11 ms. The rare long chunks are the per-day
  DELETE + INSERT commit (~350 rows). That cost is the same for any writer on this SQLite file.
- **Live datapoint (2026-10-07 07:11 ET boot, `C:\BaxterData\logs\server-20261007.log`):** the boot
  backfill on the live server recorded 89 sessions / 31,363 rows in 3,565 ms with a **max chunk of
  317 ms**, cache warm and the registry already loaded. That one chunk ran while shadow-exits, the
  catch-up persist and two chart GETs were writing in the same seconds: the chunk includes the
  `busy_timeout` wait for the write lock, so under boot contention a chunk can exceed the offline warm
  figures. It is one chunk per session, never a loop.
- **Known retry loop (bounded per pass, not in repetition):** the pending-day pre-check only tests
  `ver === YB_CACHE_VER`. A pending day whose cache row is at the current version but has a stale
  `import_hash` (or `traded = 0` with bars now present) is therefore a candidate on every retry pass:
  the source refuses it again (S2 stays pending) and the day's S1 rows are re-recorded (~10–20 ms, one
  `[shadow-scalps] retry:` log line) every 10 minutes until a chart or catch-up day-zones GET refreshes
  the row. Self-resolving; a cheap hardening is to also compare the mwml import hash and `traded = 1`
  in the pre-check.
- **One-time cost per process, not specific to this job:** the first day-zone read in a process loads
  the yellowbox mwml registry inside `server/yellowbox.ts`, 7,158 band figures, which took 415–585 ms
  here (585 ms when it landed inside the recorder's own chunk). Whichever caller comes first pays it: the chart's or the catch-up's `GET /api/yellowbox/day-zones`,
  or this recorder when it reads a frozen box before them. On a server that restarts outside market
  hours with no chart open, that can be the recorder's boot catch-up. It is a single block, not repeated.

---

## 4. Summary route and digest

The route is `GET /api/signals/shadow-scalps/summary?era=live|all&friction=1.0`.
- The defaults are `era=live` and `friction=1.0`.
- `era=live` reads only live rows (filtered in SQL).
- Reads are keyset-paged (4,000 rows per event-loop turn), and the aggregation yields the event loop
  every ~8 ms. Measured on the 31k-row backfill table: 269 ms wall, max event-loop block 30 ms (a single
  synchronous read + summary was 195 ms).
- A day replaced mid-read makes the paged read restart, so the result never duplicates a day.
- The body is memoized per table version (row count + max id) and the serialized body is cached 60 s per
  query. Concurrent requests share one computation.

**Each row** is one strategy × variant × cell × fill model. It carries:
- `n` and `wins`. A win is a trade whose net after the chosen friction is > 0.
- `winPct`, `netPerTrade` and `netPts`.
- `pf`: gross net-positive ÷ gross net-negative.
- `maxDD`: peak-to-trough of the cumulative net, in points, ordered by entry time.
- `halves`: H1 and H2, split at the middle *session* of the displayed span.
- `dropBest3NetPerTrade` and `netPerTradeByFriction` (0.7 / 1.0 / 1.5).
- `kill`, and `promotion` (the live-only flags of that strategy × variant × cell).
- No null, Δ, z or p fields (removed 2026-10-07, §0).

**`decisions`** holds S1 orb30, S2 limit and S2 close × 3 cells. They always use era="live" rows,
pessimistic fills and 1.0-pt friction, whatever `era` you query:

- **Kill:** live n ≥ 100 and net/trade < −0.3.
- **Promotion (all must hold; owner decision 2026-10-07, no control):**
  - live n ≥ 300;
  - net ≥ +0.3/trade (the bracket breaks even at 64.3 % wins at 1.0 pt, 64.9 % with the pessimistic
    stop slip; +0.3 needs about 67 %, see §0);
  - both halves > 0;
  - net/trade still > 0 with the best 3 session days removed.
  - `promotion` carries exactly `nOk`, `netOk`, `halvesOk`, `dropBest3Ok` and `all`.

**Not automated:** the doc's block-bootstrap Apex DLL and trailing-drawdown check, and the 50+ SIM
hand-trades. Do these by hand once a cell meets the promotion bar.

**Also in the body:**
- The sessions covered: count, first, last, split day, and days per era.
- `zoneStates`: per-day `cached` / `pending` / `none` counts and the pending days of the displayed era.
- `lastRunAt`: the run time of the newest row.
- `lastJob`: the in-memory status of the last run, including `s2Pending` and per-session errors.

**Digest line** (8:30 daily digest) is on the decision cell 6/8, with S2 as the limit variant. It is
built with a paged read of live + pessimistic rows only: 69 ms wall and a 20 ms max block at 31k live
rows.
`Shadow scalps: S1 live n=…/300 net …/tr (pess, 1.0) [KEEP|KILL]; S2 live n=…/300 net …/tr (pess, 1.0) [KEEP|KILL]`
- It appends `(S2 box pending on N live days)` when live days are still waiting for their box.
- When every promotion check passes, it adds "PROMOTION BAR MET (SIM hand-trading review next)". That is
  a review prompt, not an order.

---

## 5. Backfill preview (2026-10-07, offline on a temp copy; backfill era, NOT a result)

- **Run:** the live `data/app.db` was opened read-only, and 175 days of 1m/5m/60m bars plus the live
  `yellowbox_day_zones` rows were copied into a temp DB via `DB_PATH`. This is what the boot backfill
  will record if the live cache is as warm as it is today.
- **Coverage:** 89 sessions recorded (2026-06-03 → 10-06), with 09-14 rejected by the roll-cliff guard.
  All 89 days had a frozen box (`zone_state = cached`).
- **Figures:** pessimistic fills, 1.0-pt friction, decision cell 6/8. The null and z columns of the
  original preview are dropped with the control (§0); the S1 / S2 figures are unchanged.

| Candidate | n | Net/trade | H1 / H2 |
|---|---|---|---|
| S1 ORB-30 | 97 | +0.05 | −0.17 / +0.25 (was −0.28 / +0.34 with the control's days in the split) |
| S2 limit | 279 | −1.73 | −1.39 / −2.29 |
| S2 close | 167 | −0.89 | −0.15 / −2.25 |

These rows are era="backfill" and never count toward kill or promotion. The S2 limit backfill would
already sit past the kill line (n ≥ 100, net < −0.3) if it were live. The S2 rows for 08-26..09-02 fade
the stale frozen box described in §2.
