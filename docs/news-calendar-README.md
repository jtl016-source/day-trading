# news-calendar.json — official US release calendar (complete 2026-10-01 → 2026-12-31; FOMC 2027-01-27 partial)

File: `data/news-calendar.json` (schema `version: 1`). Built 2026-10-01 from the OFFICIAL schedule pages
only — no aggregator dates were used. Builder + validation log:
`C:\BaxterSandbox\analysis\eth-build\build-news-calendar.mjs` / `build-log.txt` (re-run the script with the
output path to regenerate; it refuses to write if any date is a weekend, outside the window, duplicated,
mis-tiered, or carries a `timeET` that is not exactly one of the rule's print times `08:30` / `10:00` / `14:00`
(14:00 for FOMC only) — a typo like `"8:30 "` would otherwise silently derive no blackout).

## Coverage: `window` is COMPLETE, `partialThrough` is not (2026-10-01 verifier fix)

- `window: { from: "2026-10-01", to: "2026-12-31" }` = the range in which EVERY approved release is in `events[]`.
  `calendarCovers(date)` (server/news-blackout.ts) is true only for `from <= date <= to`, and
  `GET /api/news/blackouts` reports `covered` from it.
- `partialThrough: "2027-01-31"` = the last date of an already-published row kept beyond the complete window. Today
  that is only FOMC 2027-01-27. Those rows still derive a blackout window, but the days report `covered:false`.
- Before this fix `window.to` was 2027-01-31, so the API told the UI that January 2027 was covered although 8 of 9
  January prints were unpublished.
- Extend `window.to` only once EVERY agency has published the month (the builder refuses non-FOMC rows past it).

## Staleness alarm (the server fails OPEN)

A missing, corrupt or expired calendar means **no blackout** (the server logs once and lets orders through). So
`newsCalendarHealth()` is checked every morning:
- the 8:30 digest prints `News calendar: OK — covered through … / ⚠️ …`;
- `scripts/integrity-check.ts` adds `N1-news-calendar` warnings.
It flags: file missing/unreadable, `window.to` in the past or within 14 days, no event in the next 30 days, an event
at a time no rule covers, and a `blackoutRules` block that differs from the rule in force.
`scripts/news-calendar-data.test.ts` (in `npm test`) loads THIS file and fails when it is missing, malformed,
mis-dated (weekend), missing a monthly tier-1 print, carries different rules, or has expired.

Why it exists: the 2026-10-01 ETH research (`docs/eth-trading-research-2026-10-01.md`, LEARNINGS 2026-10-01)
found that scheduled 08:30 / 10:00 ET prints are jump events (our 08:30 1m bar p90 is 20.75 pts — about one
stop) with ~40 % of the move arriving as informed drift in the 30 minutes before. A scheduled-news entry
blackout is the one overnight-adjacent rule with evidence behind it; this file is its data.

## Owner-approved blackout rule (an INFORMATIONAL copy is in the file under `blackoutRules`)

The rule the live gate applies is the `BLACKOUT_RULES` literal in `server/news-blackout.ts`. The server never reads
the file's `blackoutRules` block, so editing it changes nothing live. The test, the digest and integrity-check
compare the two and complain when they differ. To change the rule, change the code AND the builder's copy together.

Wall-clock America/New_York, applied on every day that has a matching print:

| Print time (ET) | No new entries between |
|---|---|
| 08:30 (BLS, BEA, Census) | **08:25 – 08:40** |
| 10:00 (ISM, JOLTS) | **09:55 – 10:05** |
| 14:00 FOMC statement | **13:55 – 14:30** (covers the 14:30 press-conference open) |

Only `events[]` entries drive the blackout. `pending[]` entries are releases that fall inside the window whose
official date has NOT been published yet — they are documentation, not blackout input, and must be promoted to
`events[]` once the agency posts the date (see "Refresh" below).

## Record format

```json
{ "date": "2026-10-14", "timeET": "08:30", "event": "CPI", "source": "BLS", "tier": 1,
  "ref": "September 2026" }
```

- `tier 1` = CPI, Employment Situation, FOMC, GDP advance, PCE (Personal Income and Outlays).
- `tier 2` = PPI, Retail Sales (Census advance), ISM Manufacturing PMI, ISM Services PMI, JOLTS, GDP second / third.
- `ref` = the reference period as printed on the agency schedule. One record per release, so a day can hold several
  (2026-10-15 PPI + Retail Sales; 10-29 / 11-25 / 12-23 GDP + PCE; 12-01 ISM Manufacturing + JOLTS).
- Event names are fixed strings; consumers should match on `event` and `timeET`, never on `ref`.

## Sources (one URL per agency; every date in `events[]` was read from these pages on 2026-10-01)

| Source | URL | Dates taken | Notes |
|---|---|---|---|
| BLS Employment Situation | https://www.bls.gov/schedule/news_release/empsit.htm | Oct 2, Nov 6, Dec 4 (08:30) | Page ends at the Nov-2026-data release (Dec 4). No 2027 rows. |
| BLS CPI | https://www.bls.gov/schedule/news_release/cpi.htm | Oct 14, Nov 10, Dec 10 (08:30) | Ends at Dec 10 2026. |
| BLS PPI | https://www.bls.gov/schedule/news_release/ppi.htm | Oct 15, Nov 13, Dec 15 (08:30) | Ends at Dec 15 2026. |
| BLS JOLTS | https://www.bls.gov/schedule/news_release/jolts.htm | Nov 3, Dec 1 (10:00) | Sep 29 release (Aug data) is before the window. Ends at Dec 1 2026. |
| BEA (GDP, Personal Income & Outlays) | https://www.bea.gov/news/schedule | Oct 29 GDP adv + PCE; Nov 25 GDP 2nd + PCE; Dec 23 GDP 3rd + PCE (all 08:30) | Schedule stops at Dec 23 2026; no 2027 rows. |
| Census Advance Retail Sales | https://www.census.gov/economic-indicators/calendar-listview.html (cross-checked against https://www.census.gov/retail/release_schedule.html) | Oct 15, Nov 17, Dec 16 (08:30) | MARTS page prints **"To be announced at a later date"** for the December-2026-data advance report (the January 2027 print). |
| ISM Manufacturing / Services PMI | https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/ | Mfg Oct 1, Nov 2, Dec 1; Services Oct 5, Nov 4, Dec 3 (10:00) | **PLAUSIBLE, NOT INDEPENDENTLY VERIFIED.** Page lists 2026 only. The site 302s scripted fetches to an SSO login (reproduced by the 2026-10-01 verifier). The builder read the dates once in a real browser via the ISM PMI Reports page ("View Calendar"). They match the nominal first / third business day pattern. Re-check them in a browser at the next refresh. All other sources were re-verified against the official pages by an independent verifier on 2026-10-01. |
| Federal Reserve FOMC | https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm | Oct 27–28, Dec 8–9 (SEP), Jan 26–27 2027 → statement day Oct 28, Dec 9, Jan 27 at 14:00 | Fed note: each meeting date is tentative until confirmed at the preceding meeting. |

FOMC double-check (two independent sources, as required):
- 2026 Oct 27–28 and Dec 8–9: Chicago Fed calendar https://www.chicagofed.org/utilities/about-us/federal-reserve-calendars
  (same dates; its 2027 blackout "January 16 – January 28" is consistent with a Jan 26–27 meeting).
- 2027 Jan 26–27: MNI "Federal Reserve Sets 2027 FOMC Meeting Schedule"
  https://www.mnimarkets.com/articles/mni-federal-reserve-sets-2027-fomc-meeting-schedule-1757093400287
  (statement 14:00 ET on day two, press conference 14:30).

Weekday sanity: every `events[]` date was checked programmatically (no Saturday/Sunday); the build log prints the
weekday next to each row.

## What is NOT in `events[]` (the `pending[]` list) — January 2027

As of 2026-10-01 none of the agencies has published its 2027 schedule:
- BLS: `bls.gov/schedule/2027/home.htm` and `.../2027/01_sched.htm` return 404; the release pages end with the
  December 2026 prints. January 2027 Employment Situation, CPI, PPI and JOLTS are therefore **unknown** (BLS
  usually posts the next year's schedule in Q4).
- BEA: no 2027 rows (the Q4 2026 GDP advance and December 2026 PCE are normally late January).
- Census: the January 2027 advance retail sales print is officially "To be announced at a later date".
- ISM: 2026 only. Do NOT assume "first business day" for January — ISM moved January 2026 to the 5th for an ISM
  holiday, so January 2027 could be the 4th or 5th (Services nominally the 6th).
- The only January 2027 entry with an official date is FOMC (Jan 27).

Consequence for the blackout: in January 2027 the file protects FOMC day only until it is refreshed. The
machine-readable fields now agree: `window.to` is 2026-12-31, so January days report `covered:false`, and the
digest starts warning on 2026-12-17 (14 days before `window.to`). Until the refresh, treat the first Friday (jobs),
the second week (CPI) and the last week (GDP/PCE) of January as unprotected, or add a manual blackout.
(A 2026-10-01 verifier note claiming "CPI Jan 13 2027" on bls.gov was re-checked the same day: cpi.htm ends at
Dec 10 2026. The Jan 13 row on that page is the 2026 release of December 2025 data.)

## Refresh procedure

1. Re-read the seven agency URLs above (ISM needs a real browser: open the ISM PMI Reports page, click "View
   Calendar"). Compare against `events[]`; agencies do move dates (government shutdowns, holidays).
2. Add every newly posted date to `RAW` in `build-news-calendar.mjs`, delete the matching `pending[]` row, move
   `WINDOW_TO` / `PARTIAL_THROUGH` forward once a month is COMPLETE, run the builder, and commit the regenerated
   JSON. The builder refuses weekends, duplicates, out-of-window rows and unknown print times. Then run
   `npx tsx scripts/news-calendar-data.test.ts`. Its monthly tier-1 check fails if a month inside `window` is missing
   CPI, Employment Situation or PCE.
3. Bump `generatedAt`; keep `version: 1` unless the record shape changes.
4. Suggested cadence: first trading day of each month, and immediately after any BLS/BEA "revised release dates"
   notice (e.g. the 2025 lapse page https://www.bls.gov/bls/2025-lapse-revised-release-dates.htm shows how a
   shutdown rewrites the calendar).

## Not included on purpose

Durable goods, trade balance, housing, consumer confidence, Fed minutes (14:00, three weeks after each meeting),
Fed speakers, Treasury auctions, and the ISM Supply Chain Planning Forecast (Dec 16 2026, 10:00) — none were in the
owner's approved list. Fed minutes and the Dec 16 ISM forecast are the two most likely candidates if the blackout is
later widened.
