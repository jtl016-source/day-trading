# Missed-day catch-up (computer was off)

**Added 2026-10-07.** Code: `server/catchup.ts` (bottom section "MISSED SESSION DAYS"), wired in `server/scheduler.ts` (tick step 0 and the digest). Tests: `scripts/catchup-missed-days.test.ts` (in `npm test`).

## What it does, in plain words

When the computer is off, nothing records signals. Before this change, the 10-minute catch-up only filled in **today's** missed signals. A whole day the computer was off stayed empty in the Signals tab for good.

Now, when the program comes back, it works out which trading days it missed. For each one it replays the strategy over that day's candles, oldest day first, and adds every signal that should have fired. The rules are the same ones the live program and today's catch-up use. Each added signal:

- shows the **BF** badge in the Signals tab. Hover over it to see "BACKFILLED — session <date> … or the computer was off";
- is stored as `source='catchup'`, so it can never be mistaken for a live fire. The live engine never orders a back-filled signal at fire time. The one exception is the same as for today's catch-up rows: the optional late-entry scan (`lateEntryEnabled`, armed) looks at any still-open row up to 6 h old whose price is back at its entry with TP/SL untouched. Only a short outage right before a boot can produce such a row;
- has its win/loss worked out from the real 1-minute candles, the same way as every other row.

Use these rows to check that the program kept working while you were away. The right signals should be there on the right candles.

## Rules

| Rule | Value | Why |
|---|---|---|
| Which days count | Mon–Fri Globex sessions (18:00 ET the evening before → 17:00 ET), CME full closures skipped | weekends and holidays have no session |
| Where the gap starts | the last successful catch-up pass (`app_settings.scheduler_last_catchup` on first use, then the state's `anchorAt`) | a pass less than 15 min before a session's close counts as covering that day (the 10-min cadence always leaves the last few minutes) |
| How far back | the last **7 session days** before today (`MAX_MISSED_SESSIONS`) | Yahoo / gap-heal can only heal about 7 days of 1-minute bars. Older missed days are **reported, never faked** |
| Bars first | a day is replayed only when the 1m store holds **≥ 90 %** of its session minutes | otherwise the day is "waiting for healed 1m bars" and is retried every 10 min (gap-heal runs every 10 min) |
| Order | oldest day first; a later day waits for an older unhealed day for 6 attempts (~1 h), then goes ahead | each day's replay is seeded with the stored rows of the days before it |
| Cost | one day per compute-worker request; the boot sweep spaces days 20 s apart; afterwards at most **one day per 10 min** | the server is one thread, and the live engine skips its tick while any catch-up compute runs |
| Safety | only signals not already stored are added; live rows are never touched; fire admission (cooldown + one open trade per direction) applies across day boundaries; re-running a day adds nothing | identical to the today catch-up |

## When it runs

- **At boot**, on the first scheduler tick after the 3-minute quiet window: it sweeps every ready missed day (oldest first) **before** today's catch-up pass. It runs at any hour, so a Saturday boot still fills Thursday and Friday.
- **Every 10 minutes after that**: at most one more day (deferred days retry here).
- Days are found from the last good pass. Today's pass also records a gap the moment it next succeeds.

## What you will see

- **Signals tab:** missed-day signals with the BF badge on their real date and time. Change the date range to that day to see them.
- **Daily digest (8:30 ET)**, only when something happened in the last 24 h:
  - `Catch-up: back-filled 2 missed session day(s): 2026-09-28, 2026-09-29 (6 fires)`
  - `…; 1 day(s) beyond the 7-day bar depth not recoverable (2026-09-17)`: the computer was off longer than the bars can be healed. Those days stay empty. That is honest, not a bug.
  - `…; 1 day(s) waiting for healed 1m bars (2026-09-29 41.2%) ⚠️`: the candles for that day have not come back yet. If it stays, check MotiveWave / internet.
- **Server log:** `[catchup] missed-day boot pass 2026-09-28: engine N fires, db M rows, missing K → inserted …` and `deferred … bars not healed yet`.

## Limits to know

- **Engine-endorsed on the bars available, not a byte-for-byte replay of the live day.** A missed day has no footprint rows (that feed is MotiveWave-only and records nothing while the computer is off), so the 5m/15m replays run without footprint confluence facts and can differ from what the live engine would have fired that day. Today's catch-up has the same property for a morning the computer was off.
- **The 90 % check counts bars, not where they sit.** A day with up to ~138 missing minutes anywhere still passes; if the hole is inside RTH the outcome walk cannot see a TP/SL touch inside it. Yahoo heals a day all-or-nothing in practice, so this is rare. An RTH-window sub-check is a possible follow-up.
- **Outages longer than ~6.5 days:** Yahoo's 1m depth is 6.5 days, so the oldest sessions inside the 7-session window may never heal unless MotiveWave's own backfill supplies them. They sit as "waiting" (⚠️ in the digest) until they age out as not recoverable; later days proceed after 6 attempts.
- **First boot on this code:** the anchor is seeded from the last recorded catch-up pass, failed or not (a failed pass still proves the server was alive then). Only a server that never ran a pass starts from "now".

## State (for diagnosis)

`app_settings.catchup_missed_days` (JSON): `anchorAt` (unix sec), `pending` (days to fill), `deferred` (day → coverage %, attempts), `done` (last 40 filled days with counts and keys), `unrecoverable` (last 40, with reason `beyond-depth` or `bars never healed (x%)`), `lastError`.
`app_settings.catchup_missed_job` exists only while a missed-day compute request is in flight. It is how the day reaches the worker thread. It expires after 15 min and is cleared by every today pass.

To re-run a day by hand (it is idempotent): put the date back into `pending` and remove it from `done` with the server's own DB tools, under `data/db-repair.lock` if you are doing other repairs. The next 10-min step fills it.

## Maintenance

- **Holiday table:** `CME_EQUITY_SPECIAL_SESSIONS` in `server/catchup.ts` covers 2026–2027 (full closures plus the 13:00 / 13:15 / 10:15 ET early halts). **Extend it every year.** A holiday missing from the table cannot pass the 90 % bar check. It waits, then shows in the digest as "beyond the 7-day bar depth". Nothing is faked, but the day is reported as missed.
- **Integrity check:** back-filled rows are regen-class (`source='catchup'`), like every today catch-up row. Once they are older than the 2-day live edge, `scripts/integrity-check.ts` counts them in V1 "regen row not in book" until a weekly regen re-baselines the book (the regen is dormant). This is the class that already exists for every catch-up row, not a new one.
- **Not retroactive to before the deploy:** detection starts from the last good pass before the server restart that loads this code. Days missed before that are not filled automatically.
