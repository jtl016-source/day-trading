# Shadow rules R1–R4 and Set B: replay results, verdicts, and what goes live

**Date:** 2026-10-01, closed out 2026-10-02. **Window:** 2026-06-24 to 2026-10-01, MES. **Status:** every rule is **NO-SHIP**. Every setting is built and **OFF**. Tags are recorded on fires once you restart the server.

This follows on from `docs/signal-analysis-2026-10-01.md` §3 and §5. That analysis found four groups of fires that lose in both halves. It proposed four blocking rules (R1–R4) and one combination (Set B), all to be tested as shadow rules first. This round did three things:

1. Built each rule into the engine as a setting that defaults to off.
2. Re-ran the full engine with each rule switched on, so a blocked fire frees the cooldown and the open-trade slot exactly as it would live.
3. Added a record-only tag to every fire, so live data can judge each rule without changing any trade.

All numbers are **net of 1.0 pt friction per trade**. Cells are **n / net expectancy (pts per trade)** unless marked otherwise. H1 = 06-24..08-12, H2 = 08-13..10-01.

---

## The short answer

- **Ship nothing.** None of the five variants passes even one of the three ship checks:
  1. H2 is still positive after cross-interval de-clustering.
  2. The H2 result is not carried by its best 3 days.
  3. The fires that the rule lets through in place of the blocked ones are not negative.
- **Every rule makes the book less negative, and none makes it positive** once clustering is removed. Set B has the only positive H2 cell in the study (as fired, +0.55). It turns −0.96 after de-clustering and −2.46 without its best 3 days.
- **The substitutes are the trap.** When a rule blocks a fire, the freed cooldown and open-trade slot let a different fire through. Those substitute fires lose for every rule: R1 −4.91, R2 −3.86, R3 −10.25, R4 −1.87, Set B −1.33 per trade. That is why the earlier row-removal estimates in the analysis doc were too optimistic. For example, Set B de-clustered was +0.52 by row removal and is −1.24 in the engine re-run.
- **The armed Apex account barely notices any of these rules.** It trades 5m and 60m, RTH 09:30–15:15. On that slice, R4 changes nothing (it is 1m-only) and R1/R2 move fewer than 6 fires in 3 months (§3).
- **What changes after a restart:** nothing about trading. The server starts writing a `shadow_tags` value on each fire it records. In 6–8 weeks, `GET /api/signals/shadow-tags/summary` will show whether the tagged fires keep losing on live data. §5 and §6 cover what records, what does not, and how to read the route.

---

## 1. How the replay was run (and how far to trust it)

| Item | What it is |
|---|---|
| Engine | Full `scripts/fact-engine-backtest.ts` WINDOW runs on a sandbox copy (`C:\BaxterSandbox\fe-bt-20260924`), with the shipped quality gate, calibrated exits, cooldown 10, one-open-per-direction, ETH confluence and TP1-only. `data/app.db` was opened `readonly:true` with no read-write fallback (`--strict-readonly`). It never ran with `--persist`. |
| Variants | baseline, R1, R2, R3, R4, Set B. These are six engine runs that differ only in the shadow flag. |
| Carry | The live convention: a trade rides until TP or SL. The re-walk on 1m bars matched the harness outcomes on 3086/3086 fires before any other number was trusted. |
| Apex | Every fire is flattened at the last 1m bar before 16:55 ET of its session day. 1-pt friction only. Slippage, news events and the Apex daily loss limit are not modelled. |
| De-clustered | One open trade per direction **across all intervals**, in time order, finest interval first on ties. The engine already enforces this per interval, so the "as fired" numbers include that. |
| Drop-3 | The same population with its 3 best session days removed. |
| Chain | Each variant's fires are compared to the baseline's, keyed by interval, fire time and direction. "Removed" splits into **direct** (the baseline fire carries the rule's tag, so the rule itself blocked it) and **knock-on** (an untagged fire that vanished because the chain changed). "Admitted" means fires that exist only under the rule: the substitutes. |
| Ship rule | SHIP only if all three hold: H2 de-clustered net > 0, H2 de-clustered minus its best 3 days > 0, and chain-admitted net ≥ 0. |
| Dead-tape median | 72.25 pts over 71 days, because the sandbox WINDOW_START_KEY is 2026-06-24. The live server uses 76.25 over 121 days (key 2026-04-15). R2's floor is therefore 18.1 pts here and 19.1 live. The builder's first replay ran at 76.25 and got a baseline of 617 / −1.43, against 627 / −1.66 here. The difference comes only from dead-tape suppression, and the verdicts are the same in both. |
| In-sample | Every threshold (box side, 0.25, 1.0, 12.25) was picked on this same window. The shipped gate and exits were fit on 04-15..08-12, so H1 is in-sample for them too. About 400 de-clustered trades gives a per-trade SE of about 0.7 pts. |

Source files: `C:\BaxterSandbox\analysis\shadow-rules\chain-replay\REPORT.md` (every cell), `variants.csv`, `by-interval.csv`, `chain-fires.csv` (every removed and admitted fire), and one folder per variant (fe-bt JSON, CSV and log). The scorer is `scripts/analysis/shadow-rules-chain-score.ts`. A verifier recomputed every cell independently from the six JSONs and matched to the cent. Re-running the scorer reproduced the report byte for byte.

---

## 2. Per-rule replay tables

### Baseline (shipped engine, no shadow rule)

| Slice | Carry: n / win % / net / PF | Apex |
|---|---|---|
| All | 627 / 69.9 % / **−1.66** / 0.78 | −1.47 |
| H1 / H2 | 346 / −1.58  ·  281 / −1.77 | −1.42 / −1.54 |
| RTH / ETH | 167 / −1.07  ·  460 / −1.88 | −0.57 / −1.80 |
| De-clustered all / H1 / H2 | 382 / −1.93  ·  218 / −1.80  ·  164 / **−2.10** | −1.90 / −1.85 / −1.95 |
| De-clustered H2 minus best 3 days | 152 / −3.18 (dropped 09-17, 09-16, 09-23) | −2.98 |
| From 09-27 (current rules) | 51 / −3.02 | −3.02 |
| By interval (all) | 1m 362 / −1.26 · 5m 151 / −2.60 · 15m 40 / −2.77 · 60m 74 / −1.16 | |

### R1 — `REQUIRE_BOX_SIDE` (Long only above the day box, Short only below, never inside)

| Slice | Baseline | With R1 |
|---|---|---|
| All (carry) | 627 / −1.66 / PF 0.78 | 473 / **−1.38** / PF 0.82 |
| H1 / H2 | −1.58 / −1.77 | 258 / −1.79  ·  215 / −0.89 |
| Apex all / H2 | −1.47 / −1.54 | −1.19 / −0.68 |
| De-clustered all / H1 / H2 | 382 / −1.93 · −1.80 · −2.10 | 259 / −1.93 · 144 / −2.37 · 115 / **−1.39** |
| De-clustered H2 minus best 3 days | −3.18 | 103 / **−2.86** (dropped 09-17, 08-18, 09-16) |
| By interval | 1m −1.26 · 5m −2.60 · 15m −2.77 · 60m −1.16 | 1m 237 / −1.40 · 5m 134 / −1.64 · 15m 29 / +0.37 · 60m 73 / −1.53 |
| Chain | — | removed 188 = **174 direct (−3.13/tr, −544)** + 14 knock-on (−0.99/tr). **Admitted 34 / −4.91/tr (−167)**: H1 13 / −11.10, H2 21 / −1.07, Apex −4.42. 13 survive de-clustering at +0.63. |

**Verdict: NO-SHIP. Leave `REQUIRE_BOX_SIDE: false`.** It fails all three checks: H2 de-clustered −1.39, worse without the best 3 days, and substitutes at −4.91. Its substitutes are the worst of the four single rules relative to what it removes. The fires it blocks are bad (−3.13/trade), but the engine replaces them with worse ones. Keep the `box-side-wrong` tag recording.

### R2 — `MIN_SESSION_RANGE_FRAC` 0.25 (no fire until the session range so far is ≥ 0.25 × the dead-tape median)

| Slice | Baseline | With R2 |
|---|---|---|
| All (carry) | 627 / −1.66 / PF 0.78 | 529 / **−1.27** / PF 0.83 |
| H1 / H2 | −1.58 / −1.77 | 302 / −1.76  ·  227 / −0.61 |
| Apex all / H2 | −1.47 / −1.54 | −1.12 / −0.58 |
| De-clustered all / H1 / H2 | 382 / −1.93 · −1.80 · −2.10 | 334 / −2.01 · 194 / −1.94 · 140 / **−2.12** |
| De-clustered H2 minus best 3 days | −3.18 | 129 / **−3.19** (dropped 09-17, 09-16, 09-23) |
| By interval | 1m −1.26 · 5m −2.60 · 15m −2.77 · 60m −1.16 | 1m 306 / −1.04 · 5m 121 / −2.39 · 15m 33 / −1.04 · 60m 69 / −0.41 |
| Chain | — | removed 145 = **131 direct (−4.23/tr, −554)** + 14 knock-on (−0.02/tr). **Admitted 47 / −3.86/tr (−182)**: H1 23 / −2.94, H2 24 / −4.75, Apex −3.97. 31 survive de-clustering at −0.61. |

**Verdict: NO-SHIP. Leave `MIN_SESSION_RANGE_FRAC: 0`.** It fails all three checks. The as-fired H2 gain (−1.77 → −0.61) disappears after cross-interval de-clustering (−2.12, no better than baseline), and the substitutes lose 3.9/trade, worse in H2 than in H1. Keep the `range-below-0.25med` tag recording.

### R3 — `BLOCK_TIGHT_ROOM_INTERVALS` ["5m","15m"] (block 5m/15m fires carrying the engine's own `tight-room` flag)

| Slice | Baseline | With R3 |
|---|---|---|
| All (carry) | 627 / −1.66 / PF 0.78 | 612 / **−1.23** / PF 0.83 |
| H1 / H2 | −1.58 / −1.77 | 340 / −1.36  ·  272 / −1.08 |
| Apex all / H2 | −1.47 / −1.54 | −1.11 / −0.92 |
| De-clustered all / H1 / H2 | 382 / −1.93 · −1.80 · −2.10 | 379 / −1.75 · 216 / −1.59 · 163 / **−1.95** |
| De-clustered H2 minus best 3 days | −3.18 | 151 / **−3.03** (dropped 09-17, 09-16, 09-23) |
| By interval | 5m 151 / −2.60 · 15m 40 / −2.77 | 5m 143 / −1.59 · 15m 33 / +0.37 (1m and 60m unchanged) |
| Chain | — | removed 20, **all direct: 25 % win, −16.94/tr (−339)**, negative in both halves (H1 8 / −12.34, H2 12 / −20.00), 0 knock-on. **Admitted 5 / −10.25/tr (−51)**: 5m 4 / −6.81, 15m 1 / −24. 1 survives de-clustering (+10.25). |

**Verdict: NO-SHIP. Leave `BLOCK_TIGHT_ROOM_INTERVALS: []`.** The removed set is the cleanest of any rule: 20 fires, −16.9/trade, both halves negative. But n=20 in three months is tiny, the whole book stays negative (H2 de-clustered −1.95), and the 5 substitutes lose 10/trade. It is low-confidence either way. Keep the `tight-room@5m15m` tag recording. At about 7 tagged fires a month, it will take the longest of any tag to reach a judgeable count.

### R4 — `MIN_TP1_PTS_BY_INTERVAL` {"1m": 12.25} (block 1m fires whose nearest TP-side obstacle is under 12.25 pts)

| Slice | Baseline | With R4 |
|---|---|---|
| All (carry) | 627 / −1.66 / PF 0.78 | 504 / **−1.20** / PF 0.85 |
| H1 / H2 | −1.58 / −1.77 | 280 / −0.95  ·  224 / −1.50 |
| Apex all / H2 / RTH | −1.47 / −1.54 / −0.57 | −0.92 / −1.21 / 0.00 |
| De-clustered all / H1 / H2 | 382 / −1.93 · −1.80 · −2.10 | 298 / **−1.12** (best of any variant) · 165 / −1.00 · 133 / **−1.27** |
| De-clustered H2 minus best 3 days | −3.18 | 119 / **−2.56** (dropped 09-17, 09-02, 09-23) |
| 1m only | 362 / 72.1 % / −1.26 / PF 0.83 (H1 −0.98 / H2 −1.62); de-clustered 281 / −1.99 | 239 / 69.9 % / **−0.06** / PF 0.99 (H1 +0.58 / H2 −0.94); Apex +0.03; de-clustered 178 / −0.96 |
| 5m / 15m / 60m | — | unchanged (the setting is 1m-only) |
| Chain | — | removed 158 = **146 direct (76 % win, −2.78/tr, −407)** + 12 knock-on (−8.26/tr, −99). **Admitted 35 1m fires / −1.87/tr (−65)**: H1 16 / −0.64, H2 19 / −2.91, Apex −1.33. 25 survive de-clustering at −2.67. |

**Verdict: NO-SHIP. Leave `MIN_TP1_PTS_BY_INTERVAL: {}`.** It fails all three checks. It is still the best-supported mechanism. The blocked fires win 76 % of the time and still lose 2.8/trade, because their target is about 5.75 pts against a stop of about 27. The rule lifts 1m from −1.26 to −0.06 and gives the best de-clustered book. But 1m H2 stays negative, the improvement is carried by H1, and the substitutes lose 1.9/trade, with H2 worse than H1. **This is the first candidate to re-test once its tag has live data.** It does not touch the armed account, which does not trade 1m.

### Set B — R1 + R2 + `MAX_SESSION_RANGE_FRAC` 1.0 + tight-room blocked on **every** interval

| Slice | Baseline | With Set B |
|---|---|---|
| All (carry) | 627 / 69.9 % / −1.66 / PF 0.78 | 341 / 73.0 % / **−0.23** / PF 0.96 |
| H1 / H2 | −1.58 / −1.77 | 188 / −0.88  ·  153 / **+0.55** (PF 1.09; the only positive H2 cell in the study) |
| Apex all / H2 | −1.47 / −1.54 | **+0.01** (PF 1.00) / +0.74 |
| RTH / ETH | −1.07 / −1.88 | 100 / +1.13 (Apex +1.85)  ·  241 / −0.80 |
| As-fired H2 minus best 3 days | — | −0.72 |
| De-clustered all / H1 / H2 | 382 / −1.93 · −1.80 · −2.10 | 203 / −1.24 · 109 / −1.48 · 94 / **−0.96** |
| De-clustered H2 minus best 3 days | −3.18 | 83 / **−2.46** (dropped 09-17, 09-24, 08-18) |
| From 09-27 (current rules) | 51 / −3.02 | 26 / −7.01 (too small to judge, but no help) |
| By interval | 1m −1.26 · 5m −2.60 · 15m −2.77 · 60m −1.16 | 1m 175 / +0.12 · 5m 85 / −1.11 · 15m 21 / +2.00 · 60m 60 / −0.82 |
| Chain | — | removed 337 (about 325 direct and 12 knock-on; see note). **Admitted 51 / −1.33/tr (−68)**: H1 23 / −2.08, H2 28 / −0.72, Apex −1.29. 27 survive de-clustering at +2.75. |

**Verdict: NO-SHIP. Leave all four Set B settings at their defaults.** The as-fired H2 of +0.55 is real in the engine re-run, with the chain included. But it does not survive cross-interval de-clustering (−0.96), is carried by its best 3 days (−0.72 without them), and the 51 substitutes net −68. The thresholds were also chosen with both halves visible.

Note: the scorer's split was 319 direct / 18 knock-on, but the `tight-room@5m15m` tag does not cover 1m and 60m. The verifier's corrected split is about 325 direct / 12 knock-on (−16.6). This does not change the totals, the admitted set or the verdict.

### Summary

| Variant | All (carry) | Apex | De-cl. H2 | De-cl. H2 drop-3 | Admitted | Check 1 / 2 / 3 | Verdict | Setting (stays at default) |
|---|---|---|---|---|---|---|---|---|
| Baseline | 627 / −1.66 | −1.47 | −2.10 | −3.18 | — | — | — | — |
| R1 | 473 / −1.38 | −1.19 | −1.39 | −2.86 | 34 / −4.91 | ✗ ✗ ✗ | **NO-SHIP** | `REQUIRE_BOX_SIDE: false` |
| R2 | 529 / −1.27 | −1.12 | −2.12 | −3.19 | 47 / −3.86 | ✗ ✗ ✗ | **NO-SHIP** | `MIN_SESSION_RANGE_FRAC: 0` |
| R3 | 612 / −1.23 | −1.11 | −1.95 | −3.03 | 5 / −10.25 | ✗ ✗ ✗ | **NO-SHIP** | `BLOCK_TIGHT_ROOM_INTERVALS: []` |
| R4 | 504 / −1.20 | −0.92 | −1.27 | −2.56 | 35 / −1.87 | ✗ ✗ ✗ | **NO-SHIP** (first to re-test) | `MIN_TP1_PTS_BY_INTERVAL: {}` |
| Set B | 341 / −0.23 | +0.01 | −0.96 | −2.46 | 51 / −1.33 | ✗ ✗ ✗ | **NO-SHIP** | all four above + `MAX_SESSION_RANGE_FRAC: 0` |

---

## 3. What these rules would do to the armed account

The armed Apex account trades only **5m and 60m, with orders 09:30–15:15 ET** (`GET /api/trade/settings`, read 2026-10-02). The table below takes each variant's fires on those two intervals with entry inside 09:30–15:15 ET, using carry and net values. The harness carries no risk level, so the "safe" filter and the news blackout are **not** applied. Treat this as an upper bound on what reaches the account.

| Variant | 5m+60m in order hours | H1 | H2 | 5m | 60m |
|---|---|---|---|---|---|
| Baseline | 79 / 64.6 % / −2.16 (−171) | 47 / −4.45 | 32 / +1.21 | 52 / −2.55 | 27 / −1.41 |
| R1 | 74 / −2.07 (−154) | 42 / −4.57 | 32 / +1.21 | 47 / −1.70 | 27 / −2.72 |
| R2 | 80 / −2.01 (−161) | 47 / −4.45 | 33 / +1.46 | 52 / −2.55 | 28 / −1.01 |
| R3 | 76 / −1.27 (−97) | 44 / −3.07 | 32 / +1.21 | 49 / −1.20 | 27 / −1.41 |
| R4 | identical to baseline | | | | |
| Set B | 48 / −1.42 (−68) | 26 / −3.19 | 22 / +0.67 | 29 / −0.35 | 19 / −2.72 |

How to read it:
- About 79 fires in 3 months reach this slice, so every difference here is a handful of trades.
- R3 is the only rule that changes this slice meaningfully. It removes 3 bad 5m fires (+74 pts). That is not enough evidence to ship on.
- Set B gives up a third of the H2 trades and halves the H2 gain (+39 → +15).
- R4 cannot affect orders at all.
- None of this changes the verdicts.

---

## 4. If a rule ever passes: the exact setting to flip

There is **no runtime switch** for these rules: no app setting, environment variable or Risk Controls toggle. The settings live in `FACT_ENGINE_DEFAULTS` in `shared/fact-engine.ts` (lines 321–325 today). The catch-up pass, the live-engine worker and the browser tab all read those defaults. Enabling a rule means a code change in a session, followed by a restart that **you** do.

| Rule | Line in `FACT_ENGINE_DEFAULTS` | Flip to | Harness flag to re-test first |
|---|---|---|---|
| R1 | `REQUIRE_BOX_SIDE: false` | `true` | `--require-box-side` |
| R2 | `MIN_SESSION_RANGE_FRAC: 0` | `0.25` | `--min-session-range-frac 0.25` |
| Set B cap | `MAX_SESSION_RANGE_FRAC: 0` | `1.0` | `--max-session-range-frac 1.0` |
| R3 | `BLOCK_TIGHT_ROOM_INTERVALS: []` | `["5m","15m"]` | `--block-tight-room 5m,15m` |
| R4 | `MIN_TP1_PTS_BY_INTERVAL: {}` | `{ "1m": 12.25 }` | `--min-tp1-by-interval 1m=12.25` |

Flipping a default **intentionally** changes the golden fire set in `shared/fact-engine.test.ts` (1m `fb9c8132`, 5m `5a510da1`). That session must re-baseline the golden set on purpose and say so. The same session must also re-run the chain replay (`scripts/analysis/shadow-rules-replay.ts` / `shadow-rules-chain-score.ts`, sandbox only, `--strict-readonly`) over a window that includes the live tag period.

---

## 5. What is live after you restart the server

Nothing changes in trading. All five settings default to off, and the golden fire sets reproduce byte for byte. What does change:

| Change | Effect after restart |
|---|---|
| `signal_history.shadow_tags` column | Added by an idempotent `ALTER TABLE` in `server/db.ts` at boot. A readonly check shows the live `data/app.db` **already has the column**: some process that imported the new `server/db.ts` against the live DB path ran it after 16:22 on 10-01, and the origin is unknown. It is harmless: the column is additive, 0 rows are tagged, and the server logs show no schema errors. It is disclosed here because the round was meant to keep the live DB read-only. |
| Tags on every fire the engine evaluates | A JSON array per row. `'[]'` means evaluated with nothing tripped. `NULL` means written before this feature, or by a writer that does not send tags. Tag IDs: `box-side-wrong` (R1), `range-below-0.25med` (R2), `range-above-1.0med` (Set B cap), `tight-room@5m15m` (R3), `1m-anchor-under-12.25` (R4). Each tag is computed by the **same predicate** as its setting, so a tag means exactly "this setting would have blocked this fire". Fires with no day zone or no dead-tape median get no tag and would get no block. |
| New read-only route | `GET /api/signals/shadow-tags/summary?days=90[&symbol=MES]`, cached for 60 s. |
| Engine settings | All OFF. No fire is blocked. |

**Which writers record tags (important):**

| Writer | Tags stored? |
|---|---|
| Server live engine (bar-close fires, `server/live-engine.ts` via the POST route) | **Yes**. This is the reliable source. |
| Catch-up pass (`server/catchup.ts`) | Yes, **but** the Sunday regen (`fact-engine-backtest.ts --persist`, `server/scheduler.ts`) deletes every non-live window row, catch-up rows included, and re-inserts them **without** tags. Catch-up tags therefore last only until the next Sunday regen. |
| Browser tab (`client/src/pages/market.tsx`), including its intra-candle (forming-bar) fires | **No**. It does not send `shadowTags` yet, so those rows stay NULL. It is COALESCE-safe: a tab re-post never erases tags that are already stored. |
| Sunday regen rows, `scripts/full-history-regen.ts`, `/api/data/import-full` | **No**. They are NULL, and an export→import round trip drops tags. |

The practical result is that **live-engine bar-close fires are the population the tags will be judged on.** That is still the right population, because those are the fires the account can trade. Fixing the tab and regen gaps is a follow-up for whoever owns `market.tsx` and the regen persist path.

---

## 6. How to judge the tags later

1. **Wait.** In the replay, tagged fires per 3 months were: `box-side-wrong` 174, `range-below-0.25med` 131, `1m-anchor-under-12.25` 146, `range-above-1.0med` 79, `tight-room@5m15m` 20. Only live-engine rows count, and de-clustering removes some, so expect roughly **6–8 weeks** before R1, R2 and R4 reach 40. R3 will likely take **6 months or more**.
2. **Open** `GET /api/signals/shadow-tags/summary?days=90&symbol=MES`. For each tag and interval (`1m` / `5m` / `15m` / `60m` / `all`), it reports **tagged vs untagged**, each **raw and de-clustered**: n, wins, win %, gross, net (−1/trade), expectancy and open count. It also returns a `clean` group (rows that tripped no tag) and a row census (`rows.legacy` = NULL rows, excluded from both groups).
3. **Judge only rows where `judgeable: true`**, meaning de-clustered tagged n ≥ 40.
4. **A tag supports its rule when all of these hold:**
   - the tagged de-clustered expectancy is negative;
   - it is clearly below the untagged group on the same interval;
   - both are still true when the live period is split in half.

   If those hold, **re-run the engine chain replay** (sandbox, `--strict-readonly`) over a window that includes the live period, and apply the same three ship checks as §2. A tag that looks bad is not enough on its own: this round showed that the substitute fires can be worse than the blocked ones.
5. **Two caveats when reading the route:**
   - The route's "de-clustered" is a one-open-per-direction walk **per interval**. Admission already enforces that for live rows, so on live data it is close to raw. The replay verdicts used the stricter **cross-interval** de-cluster, which turned every H2 cell negative. Before acting, re-score the tagged rows cross-interval. A one-off script over the readonly DB is enough.
   - The live dead-tape median is 76.25, so R2's floor is about 19.1 pts live against 18.1 in this replay. Compare live tag numbers with the builder's first replay (`C:\BaxterSandbox\analysis\shadow-rules\SUMMARY.md`, same median: baseline 617 / −1.43), not with the chain replay above.
6. **Judge only on current-rules data** (session days from 2026-09-27 on), and report older rows separately. Every variant was negative on the 09-27+ slice of the replay (n 25–51). It is far too small to judge, but no rule rescued the recent days.

---

## 7. Known limitations of this round

- **Artifact provenance.** Every shadow-rule results JSON records `meta.engineSettings` as the **defaults**, not the applied flags. Only line 1 of `fe-bt.log` in each variant folder names the applied settings. Read the log before trusting a JSON on its own.
- **`statsOut.shadowRuleSuppressed` counts bars, not fires.** The block never consumes the cooldown, so the bars after a blocked fire are counted again. In tests, `REQUIRE_BOX_SIDE` counted 47 bars where 10 fires were removed. Use the chain comparison, not this counter, to count removed fires.
- **`exitWithIntervalFloor` replaces the exit's `MIN_TP1_PTS` instead of taking the larger value.** With the shipped 3.0 default it can only tighten, and no caller sets a higher value today. A future caller that does could see R4 loosen it.
- **The replay artifacts predate one engine edit.** The 10-01 ticket-12b `closedEdgeTs` change touches only the forming-bar path, which the harness never calls. A readonly re-run on today's tree gives baseline 592 / −1.34 and R1 443 / −1.00, against the builder's 617 / −1.43 and 465 / −1.17. That is small and the verdicts are unchanged, but the standing `SUMMARY.md` numbers are not exactly reproducible from the current tree. The fires dated 10-01 and a median of 76.38 vs 76.25 account for most of it.
- **Variant runs were not on a frozen snapshot.** The baseline served 98,962 1m bars and the variants 98,963. Every fire common to the baseline and a variant has an identical outcome, TP and SL, so this has no effect.
- **Acceptance.** `npx tsc --noEmit` is clean. All 22 suites in `package.json` "test" are green when run individually, except the three tolerated failures: fact-engine 364/2 (the two "generated config" asserts) and fact-engine-parity 11/1 (DB vs standing-JSON drift). The new `scripts/shadow-tags.test.ts` passes 32/0. `scripts/safe-stdio.test.ts` passes 5/0 under PowerShell but 4/1 under Git Bash. That is an environment effect: the file has not changed since 09-18. `npm test` stops at the first failing suite, so run suites individually.

Nothing in this round touched the live server, trade settings, arming, `.env`, `shared/quality-gate.ts` or git.
