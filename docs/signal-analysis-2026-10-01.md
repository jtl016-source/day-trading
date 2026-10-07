# Signal analysis: why the backtest loses, what lines up, what to change

**Date:** 2026-10-01. **Window:** 2026-06-24 to 2026-10-01. **Symbol:** MES. **Status:** analysis only. Nothing in the engine, the gate, signal_history or C:\BaxterData was changed.

All numbers are net of 1.0 pt friction per trade unless marked gross. Each row shows **n / win % / expectancy (pts per trade) / profit factor**. The two halves are always **H1 = 06-24..08-12** and **H2 = 08-13..10-01**.

---

## The short answer

1. **There are two different "bad results", and the larger one is mostly gone already.** The Signals tab's last 30 days show −3,117 pts (1,530 trades, 68.6 % win, −2.04/trade, PF 0.75). About 87 % of that loss came from an older engine generation. Under its rules (cooldown 4, no one-open-per-direction, yellow-box break counted as a state) the engine re-fired the same idea dozens of times. One catch-up batch on 09-04 placed 91 stacked 1m Longs against a single target: 4.4 % win, −2,208 pts. Re-walking the same 30 days under today's rules leaves 213 trades and −389 pts. That is still negative, but it is a different problem.
2. **Under today's rules the system still loses about 1.1 pts per trade.** That is the 3-month replay of the shipped (gated) engine: n=609, 71.4 % win, −1.09/trade, PF 0.85 (H1 −0.86, H2 −1.38). A 70 % win rate is not healthy here. The average win is +9.7 and the average loss is −24.5, so the brackets need about 74.5 % winners just to break even.
3. **This is mainly an entry problem, not an exit problem.** After entry, price drifts neither for nor against the trade: median favourable and adverse moves are equal at every horizon. No exit tested was positive on held-out data on any interval. The one place where the bracket itself is the problem is 1m fires whose target is anchored to a nearby tabletop level: a median target of 5.75 pts against a 27-pt stop.
4. **No strategy status, and no pair or triple of statuses, reliably picks winners.** Of 254 single statuses, none passes a both-halves test with a confidence interval above zero. The pairs and triples that do pass are about as many as random shuffles produce.
5. **Some conditions reliably pick losers.** Four groups of fires lose in both halves:
   - fires inside the yellow box, or on the wrong side of it;
   - fires before the session has moved about 19 pts, which is mostly the 18:00–21:00 ET Globex reopen;
   - 1m fires with a short anchored target;
   - 5m and 15m fires carrying the engine's own `tight-room` flag.

   Removing them moves the book from about −1.1 to roughly −0.3..+1.0 per trade, depending on population and counting. That stops the bleed. It is **not** a proven edge, so every change below is proposed as a shadow test first.

---

## 0. Data, method, and how much to trust it

| Item | What it is |
|---|---|
| Replay dataset | `C:\BaxterSandbox\analysis\signals-3mo.json`, 980 fires. These are today's engine rules replayed on the served 1m bars: cooldown 10, YB break as a 3-bar event, one open per direction, ETH confluence on, 15:15 cutoff, TP1-only. |
| Populations | **Ungated**: every fire the engine makes with the gate off but the shipped exits on (n=883 closed). **Gated / shipped**: what the live gate admits (n=609 closed). |
| Outcomes | **Carry**: the live convention, where a trade rides until TP or SL. **Apex**: flat at 16:55 ET. Both use one exit per trade. |
| Live book | `live-book-30d.json`, 1,531 stored signal_history rows from 09-01..10-01, almost all written under the OLD rules. |
| Checks | An independent verifier re-derived every field of all 980 rows: 0 differences in outcomes, paths and statuses, and no lookahead. Every headline claim then went to a refuter that re-computed it with its own code. Four headline claims were **rejected** (§2.3). I also recomputed the firing-rule numbers myself (`C:\BaxterSandbox\analysis\report\verify.cjs`, `status.cjs`, `rth.cjs`, `rthiv.cjs`). |
| Statistical reality | About 70 trading days. Roughly 44 % of fires duplicate a same-direction trade already open on another interval, so the effective sample is about half the row count. Day-block bootstrap of the shipped book: 90 % CI **[−2.32, +0.03]** per trade, P(negative) ≈ 0.94. The book is *probably* losing, not *certainly* losing. |
| In-sample warning | The shipped gate and exits were fit on 2026-04-15..08-12, so **H1 is in-sample for them**. Only H2 is clean for judging the shipped setup. |

---

## 1. Why the book is negative

### 1.1 The Signals tab, last 30 days (live book)

| Slice | n | Win % | Exp/trade | PF | Net pts |
|---|---|---|---|---|---|
| Everything stored 09-01..10-01 | 1,530 | 68.6 | −2.04 | 0.75 | −3,117 |
| Same rows re-walked with one-open-per-direction only | 275 | — | −0.74 | 0.90 | −205 |
| Same rows under all three current rules | 213 | — | −1.83 | 0.77 | −389 |
| Catch-up-written rows (server/tab was down) | 612 | 58.2 | −6.17 | 0.43 | −3,774 |
| Live-written rows | 664 | 75.6 | +1.02 | 1.16 | +675 |
| Current-rules era only (session day ≥ 09-27) | 53 | 62.3 | −5.09 | 0.48 | −270 (too small to judge) |

- 414 of the 481 stored losses (−10,203 of −11,825 gross) were admitted by a rule that no longer exists.
- The 10 worst live days total −6,389 pts. Under current rules they total −638.
- On those days every strategy agreed with the fires: mean alignScore 4.3–6.4, and 81–100 % of fires on the box side. The losses were stacked re-fires into a trend-day reversal. No status could have flagged them; only the count of same-direction positions could.
- 10 stored losses are wins when re-walked on served bars (+371 pts). They come from the 09-14 roll interleave and one isolation-filter case (id 148944).
- *Not independently refuted. The writer split and the 09-04 batch were confirmed by two separate lenses.*

### 1.2 Current rules, 3 months (replay), by interval and session

| Population | All | H1 | H2 | Apex (flat 16:55) |
|---|---|---|---|---|
| Ungated | 883 / 70.9 / −1.13 / 0.85 | 470 / 70.0 / −1.37 / 0.82 | 413 / 71.9 / −0.85 / 0.88 | 883 / 68.0 / −1.09 / 0.84 |
| **Gated (shipped)** | **609 / 71.4 / −1.09 / 0.85** | 336 / 72.0 / −0.86 / 0.88 | 273 / 70.7 / −1.38 / 0.82 | 609 / 70.3 / −0.99 / 0.86 |
| Gated 1m | 355 / 73.2 / −0.84 / 0.88 | −0.49 | −1.31 | −0.84 |
| Gated 5m | 143 / 69.9 / −1.72 / 0.77 | −2.97 | −0.22 | −1.30 |
| Gated 15m | 38 / 68.4 / −2.45 / 0.71 | +1.35 | −6.26 | −2.54 |
| Gated 60m | 73 / 67.1 / −0.35 / 0.95 | +0.42 | −1.19 | −0.29 |
| Gated RTH | 156 / 71.2 / −0.17 / 0.98 | −2.43 | +3.65 | −0.01 |
| Gated ETH | 453 / 71.5 / −1.41 / 0.81 | −0.21 | −2.74 | — |

ETH carries 96 % of the gated loss (−638 of −664). RTH is roughly flat overall, but it swings from H1 to H2. The refuter traced that swing to a July 20–31 drawdown (n=64, 50 % win, −7.94/trade) and three good September days. It is not a stable regime.

### 1.3 Where the gated −664 pts sits, by exit anchor

| Exit anchor (gated, carry) | n | Win % | Needs* | Exp/trade | Net pts |
|---|---|---|---|---|---|
| Tabletop-anchored (all intervals) | 136 | 77.2 | 86.2 | −2.74 | **−373 (56 % of the loss)** |
| of which 1m tabletop (median TP 5.75 / SL 27.25) | 95 | 75.8 | ~86 | −3.44 (PF 0.47) | −327 (H1 −293 / H2 −34) |
| of which 1m tabletop fired 18:00–24:00 ET | 43 | — | — | −6.47 | −278 (both halves negative) |
| Default calibrated bracket | 350 | 67.1 | 69.1 | −0.72 | −252 |
| of which 1m default (12.25/27.25 mostly) | 205 | 72.2 | — | +0.74 (PF 1.10) | +152, **statistically zero** (CI −1.9..+2.7) |
| of which 5m / 15m / 60m default | 81 / 27 / 37 | 61.7 / — / 54.1 | — | −2.81 / −3.67 / −2.13 | −228 / −99 / −79 |
| Yellowbox-anchored | 123 | 77.2 | 78.2 | −0.31 | −38 |
| of which 5m / 60m yellowbox | 32 / 29 | 81.3 / 79.3 | — | +1.13 / +1.31 | +36 / +38 |

\*"Needs" is the trade-weighted break-even win rate, (SL+1)/(TP+SL). Do not use the median bracket for this: it reports 71.7 %, which would make the book look like it breaks even.

Plain reading:
- Tiny targets against wide stops need near-perfect hit rates, and they do not get them.
- The calibrated default brackets at 5m, 15m and 60m also lose.
- The box-anchored targets at 5m and 60m are the one part of the exit system that works.

### 1.4 Where the loss sits, by entry condition (gated; groups overlap)

| Group | n | Win % | Exp/trade | H1 / H2 | Net pts |
|---|---|---|---|---|---|
| Inside the box or on the wrong side of it | 171 | 70.2 | −2.68 | −1.30 / −4.17 | −458 |
| Session range so far < 0.25 × median (≈19 pts) | 134 | 64.2 | −3.98 | −1.20 / −6.10 | −533 |
| Entered 18:00–20:59 ET (Globex reopen) | 129 | 65.1 | −3.58 | −2.26 / −5.67 | −462 |
| Carries `tight-room` flag | 94 | 66.0 | −3.07 | +0.43 / −6.14 | −289 |

The first three groups overlap heavily. The low-range group is mostly the reopen window.

### 1.5 Why exits cannot fix it

- **Symmetric path.** Gated median favourable vs adverse excursion is 3.0/2.75 at 15 min, 5.75/5.75 at 60 min and 12.75/11.0 at 240 min. Mean mark-to-market is about 0. There is no drift for a wider target or trailing stop to capture.
- **Breakeven stops hurt.** 36 % of losers were +6 first, but 45 % of winners dipped 6+ before hitting target. The refuter's bar-by-bar re-walk gives −1.20 / −1.08 / −1.10 per trade for breakeven at +6 / +8 / +10, against −1.11 shipped. *(refuter: HOLDS)*
- **Losers live 3× longer than winners**: median 191–215 min vs 73–74 min. This is the one asymmetry a time stop can use, and it only reaches about 0.
- **Even hindsight cannot get far.** The best single fixed bracket gives about +0.3/trade at 1m and +1.2 at 5m in-sample. On ungated 1m, zero of 1,836 variants are positive in both halves.

---

## 2. What lines up: every strategy's status against every signal

Each fire's 11 strategy statuses were scored +1 / 0 / −1 for whether they agree with the trade direction (`status.align.*`, one row per signal in `lens-why-bad\replay-per-signal-status.csv` and `live-per-signal-status.csv`). The table shows the ungated population; H1/H2 cells give exp/trade (n).

### 2.1 Per-strategy table (ungated n=883, carry)

| Strategy status | Reading | n | Win % | Exp | PF | H1 | H2 |
|---|---|---|---|---|---|---|---|
| **Yellow box side** | agree (beyond box on fire side) | 617 | 72.6 | −0.27 | 0.96 | −0.67 (333) | +0.20 (284) |
| | inside box | 68 | 64.7 | **−3.94** | 0.58 | −2.02 (31) | −5.56 (37) |
| | wrong side | 198 | 67.7 | **−2.84** | 0.67 | −3.38 (106) | −2.23 (92) |
| **15m vector slope (20 bars)** | agree | 466 | 75.5 | +0.50 | 1.08 | +0.91 (244) | +0.05 (222) |
| | oppose | 378 | 64.3 | −3.38 | 0.63 | −3.98 (213) | −2.61 (165) |
| 60m vector (price side) | agree | 553 | 71.1 | −0.77 | 0.89 | −0.52 (274) | −1.02 (279) |
| | oppose | 326 | 70.6 | −1.77 | 0.77 | −2.51 (194) | −0.67 (132) |
| 15m vector (price side) | agree | 607 | 68.4 | −1.53 | 0.81 | −1.03 | −2.13 |
| | oppose | 274 | 76.3 | −0.31 | 0.95 | −2.17 | +1.62 |
| 5m vector (price side) | agree | 684 | 70.5 | −0.86 | 0.88 | −0.20 | −1.60 |
| | oppose | 194 | 72.2 | −2.17 | 0.71 | −5.33 | +1.88 |
| 1m vector (price side) | agree | 835 | 70.4 | −1.24 | 0.84 | −1.32 | −1.15 |
| Fractal breakout/band | agree | 523 | 71.9 | −0.52 | 0.93 | −1.42 | +0.53 |
| | neutral | 279 | 69.5 | −2.08 | 0.73 | −2.37 | −1.75 |
| FCO | agree | 549 | 71.8 | −0.68 | 0.90 | −2.16 | +0.99 |
| | neutral | 319 | 69.0 | −2.03 | 0.75 | −0.35 | −3.97 |
| Fractal geometry | agree | 645 | 69.9 | −1.38 | 0.82 | −1.26 | −1.52 |
| | neutral | 216 | 73.1 | −0.42 | 0.94 | −1.27 | +0.61 |
| ICT at bar | agree | 37 | 70.3 | −1.22 | 0.84 | +0.27 | −2.97 |
| Footprint stack (only 206 rows have fresh data) | agree | 85 | 68.2 | −1.79 | 0.78 | −3.54 | +0.58 |
| | oppose | 118 | 69.5 | −1.19 | 0.84 | +1.77 | −4.35 |
| Close estimate (mean reversion) | agree | 82 | 75.6 | +0.55 | 1.09 | −3.06 | +4.16 |
| | oppose | 182 | 64.3 | −2.30 | 0.74 | −2.69 | −1.76 |
| Vectors agreeing | 4 of 4 | 425 | 68.7 | −0.97 | 0.88 | +0.12 | −2.09 |
| | 2 of 4 | 147 | 79.6 | +0.93 | 1.18 | +1.79 | +0.12 |
| | 1 of 4 | 115 | 69.6 | −2.57 | 0.68 | −6.42 | +2.80 |
| **alignScore** (sum of all 11) | ≤1 | 186 | 69.4 | −2.89 | 0.64 | −4.96 | −0.39 |
| | 2–3 | 121 | 76.9 | +0.49 | 1.08 | +0.53 | +0.45 |
| | 4–5 | 207 | 72.0 | −0.59 | 0.92 | +1.87 | −3.78 |
| | 6+ | 369 | 69.1 | −1.07 | 0.86 | −2.04 | −0.04 |

How to read it:
- **Only the yellow-box side is negative-when-wrong in both halves, in both populations.** Gated: inside −3.47, wrong side −2.28 (H1 −2.23 / H2 −2.34).
- **The 15m slope is the strongest replay signal, but it did not survive refutation** (§2.3).
- **More agreement is not better.** alignScore 6+ is worse than 2–3, and 4-of-4 vectors is worse than 2-of-4. Confidence-95 fires (n=762, −1.16) are the worst confidence band. *(lineup-9: refuter HOLDS. "Stop treating more agreeing facts as a quality signal.")*
- Footprint, close-estimate, FCO, fractal and ICT readings flip sign between halves or rest on small n. None of them is usable as a filter.

### 2.2 Combinations (pairs and triples)

- **Search size:** about 254 singles, 18,556 pairs and 540,398 triples with n ≥ 40.
- **Task screen** (both halves positive, n ≥ 40, 90 % CI > 0): 0 singles, ~190–204 pairs and ~6,900–8,800 triples pass.
- **Random shuffles pass about as many:** ~127–162 pairs and ~4,200–5,200 triples. That is a false-discovery rate of about 60–85 %.
- **Gated population:** fewer pass than in the shuffled data. *(lineup-1, lineup-2: refuter HOLDS.)*
- **Best positive pair, for the record:** combo FG+Fr+Vec with the 5m slope against the fire. n=41, 95 % win, +7.60, H1 +5.4 / H2 +9.7. Its family-wise p is about 0.08 after the search, its 29 Shorts went 29/29 (a regime signature), and the mirror cell is −3.86. Treat it as a hypothesis, not a rule.
- **Positive in both halves at combo@interval level (gated):** FG+Fr+Vec@1m n=35, 80 %, +2.07, PF 1.37 (H1 +2.27 / H2 +1.89; ungated n=66 +2.12). Fr+YB@60m n=26, +1.78 (H1 +2.81 / H2 +0.57). Note that the 2026-09-25 sandbox re-gate would **block** FG+Fr+Vec@1m. Hand-check it before accepting that regen.
- **Worst shipped combos (gated):** Fr+YB@1m n=90, 65.6 %, −2.62 (H1 −3.53 / H2 −1.20); Fr+Vec@1m n=88, −1.25; FG+Vec@1m n=47, −2.10.

### 2.3 Claims that were made and then refuted (do not act on these)

| Claim | Why it fails |
|---|---|
| "Block fires when the 15m slope opposes" (lineup-3) | Replay effect is real in-sample (n=378, −3.38). It fails family-wise control: p 0.43–0.89 with day clustering. After dropping 3 days the CI includes 0. September alone is −1.15 with CI [−3.62, +1.33]. The raw live book shows the opposite sign (+1.43). The effect of a block on the real fire chain is unknown. |
| "15m AND 60m both oppose" (lineup-4) | Adding the 60m condition gives no significant extra lift (t −1.23). 15m-agree with 60m-oppose is *positive* (+2.22). The live book is inconsistent depending on the de-clustering rule. |
| "De-clustered live book confirms the replay" (lineup-11) | It agrees on only 6 of 12 statuses. Picking the *first* fire of each cluster flatters the result: random pick gives −5.01, last pick −7.07. |
| "RTH lost H1 and won H2, ETH the opposite" (lineup-12) | ETH lost in both halves. The RTH swing is one July fortnight plus three September days. |
| "The 1m default bracket is net positive" (part of exits-2) | +0.74 has CI −1.9..+2.7. It is 0.00 without its best 3 days, and −0.50 ungated. |

---

## 3. Anti-patterns: fires to stop taking

Removed-set numbers are ungated, carry, recomputed by me (`report\verify.cjs`). "De-clustered" applies one-open-per-direction across all intervals.

| # | Anti-pattern | n | Win % | Exp | PF | H1 / H2 | 90 % CI (day-block) | De-clustered | Gated removed set | Strength |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | **Inside the box or wrong side of it** (Long not above, Short not below) | 266 | 66.9 | −3.13 | 0.64 | −3.07 / −3.18 | [−4.81, −1.11] | 197 / −1.73 | 171 / −2.68 (−1.30 / −4.17) | Best-supported entry filter; negative on every interval |
| A2 | **Session range so far < 0.25 × median** (~19 pts) | 149 | 62.4 | −4.49 | 0.52 | −4.25 / −4.65 | [−7.03, −1.66] | 80 / −3.09 | 134 / −3.98 (−1.20 / −6.10) | Strong; mostly the Globex reopen |
| A3 | **1m fire with a nearby anchor (TP < 12.25)** | 95 tabletop (gated) | 75.8 | −3.44 | 0.47 | −5.53 / −0.82 | bootstrap −5.84..−1.18 | — | — | Refuter HOLDS (tabletop leg); H1-heavy |
| A4 | `tight-room` flag on **5m/15m** | 5m 15+16, 15m 3+6 | — | 5m −6.08 / −15.36 | — | — | — | — | gated all-interval 94 / −3.07 (+0.43 / −6.14) | Weak; small n; 1m effect small |
| A5 | Entries 18:00–20:59 ET | 152 | 63.8 | −3.86 | 0.58 | −2.62 / −5.61 | [−7.14, −0.95] | 84 / −3.16 | 129 / −3.58 | Do **not** gate by hour: September live had the opposite sign, and LEARNINGS (10-01) records that overnight hour profiles flip. A2 captures most of it without a clock rule. |
| A6 | Stacking: several intervals firing the same direction within ~10 min | 173 gated fires in clusters | — | — | — | — | — | — | 95 % of clusters share one outcome; 20 all-stop clusters = −1,049 | Portfolio rule, not a signal rule |

**Not anti-patterns, despite appearances:**
- Dead tape. Dead-tape fires are the *better* sleeve: gated +0.30 vs −1.46.
- The 15m slope opposing. Refuted, see §2.3.
- 60m opposing alone. Contrast t 0.72, not significant.
- Low alignScore. Weak, and it reverses in the live book.

---

## 4. Exit treatment per interval (TP1-only: one exit per trade, no second target)

These are gated (shipped) fires walked on served 1m bars. The shipped numbers include the 2 rows that resolved after the build (n=611). Carry is the book convention. Apex flattens at 16:55 ET.

| Interval | Shipped exit (median) | Shipped carry / Apex | Candidate | Candidate carry (H1 / H2) | Candidate Apex | Held-out evidence | Verdict |
|---|---|---|---|---|---|---|---|
| **1m** | default 12.25/27.25; anchored TP ~5.75–8 | −0.84 / −0.84 (H1 −0.49 / H2 −1.31) | **Block 1m fires whose nearest obstacle is < 12.25 pts** (`MIN_TP1_PTS` 12.25 on 1m only). Engine re-run, so cooldown and open-trade effects are included. | 236 fires, +0.60, PF 1.08 (+1.44 / −0.55). Baseline 358 fires, −0.87 (−0.49 / −1.37). | unknown (not run; 1m carry ≈ Apex historically) | None clean. Three floors were tried (8 → −0.78, 10 → −0.35, 12.25 → +0.60). The best is reported, so this is in-sample. It improves both halves, but H2 stays negative. | **Shadow, then ship if the shadow agrees.** Best-supported exit-side change (refuter HOLDS on the mechanism). |
| 1m (alt.) | — | — | Shipped bracket + TP floor 10 + SL cap 12 | fit H1 → test H2 +0.13 (n=141) | +0.10 | Reverse direction −0.37 | Not recommended. About 0, and only one direction holds. |
| **5m** | default 11/24; yellowbox-anchored | −1.63 / −1.21 (H1 −2.97 / H2 −0.04) | Default bracket → 15/15; keep yellowbox-anchored | 142, +0.54, PF 1.08 (−0.75 / +2.11). Ungated −0.01. | +0.63 | Built in-sample from the anchor table. Block bootstrap gives P(100-trade loss) = 0.33. Trail m18/g3 SL12: H1 → H2 +0.37, reverse −1.51. | Shadow only |
| **15m** | 10.5/26 (user-approved) | −2.14 / −2.23 (n=39; H1 +1.35 / H2 −5.47) | Time stop 240 min with TP20/SL30 | gated 39, +3.17, PF 1.59 (+2.91 / +3.43) | +3.10 | Passes one walk-forward direction. **The same exit on ungated 15m (n=133) is −1.42 (H1 −2.95 / H2 +0.23).** It does not generalise. | **Keep 10.5/26.** Do not switch on 39 trades. |
| **60m** | default 18.25/20 (median 10.75/20 with anchors); yellowbox-anchored | −0.35 / −0.29 (H1 +0.42 / H2 −1.19) | Default bracket → 15/15; keep yellowbox-anchored (+1.31/trade, n=29) | 73, +0.74, PF 1.12 (+0.08 / +1.46). Ungated +0.35. | +0.69 | Nothing positive held-out in walk-forward (best −0.62). | Shadow only |
| All | — | — | Breakeven move at +6/+8/+10 | −1.20 / −1.08 / −1.10 vs −1.11 | −1.15 / −1.09 / −1.10 | Negative held-out on every interval | **Do not add** |
| All | — | — | Stop cap 12 on the shipped TP | ungated −1.11 → −0.79 (H1 −1.22 / H2 −0.30) | — | 15m and 60m get worse (−0.65 → −1.02, −0.16 → −1.10) | Not as a global rule |

**What exits can do:**
- The anchor-aware policy combined (P1: 1m anchored → 12/12, 5m/60m default → 15/15, keep the rest) takes the gated book from −1.05 to **+0.06/trade** (Apex +0.04; H1 −0.17 / H2 +0.35) and roughly halves max drawdown (838 → 461 pts).
- A block bootstrap still gives a **50 % chance that any 100-trade run loses**.
- Exits stop the bleed. They do not create an edge.

**Apex reality:**
- Carry and flat-at-16:55 differ by ≤ 0.4/trade everywhere except 5m, where Apex is better (−1.21 vs −1.63).
- For RTH-only hand trading (owner-approved R1), the gated RTH book is n=156: carry −0.17 / Apex −0.01 (H1 −2.43 / H2 +3.65). Too unstable to call.
- A time stop is still one exit per trade (a flat, not a second target), so it complies with TP1-only. None is recommended for shipping.

---

## 5. Firing-rule changes, with held-out numbers and the code each needs

"Held-out" here means: each rule was defined *before* looking at a half, and its removed set is negative in **each half separately**, with the lens's permutation p-values. The combined set B was picked with both halves visible, so it has no clean held-out. Its only out-of-sample-style evidence is date splits from the firing lens: fit 06-24..08-31 → September +0.93 (n=104); fit 06-24..07-31 → Aug–Oct +0.64 (n=199); fit 07-25..10-01 → Jun–Jul **−2.29** (n=133).

**Important limitation.** Removing fires from a replay is not the same as running the engine with a block. A blocked fire frees the cooldown and open-trade slot, and *other* bars fire instead. For the 1m `MIN_TP1_PTS` change this was measured with a full engine re-run: 34 new fires at −0.04/trade, about flat. For R1, R2 and R3 it has **not** been measured. Their chain effect is unknown until a sandboxed fe-bt run with the setting is done.

| # | Rule | Kept set (gated, carry) | Kept H1 / H2 | Apex | De-clustered | Removed set (both halves) | Code change |
|---|---|---|---|---|---|---|---|
| R1 | **Box-side admission:** Long only when the close is above the day box, Short only below; never inside. In practice it only bites on vector side-entry fires, because yellowbox-break fires are on the box side by construction. | 438 / 71.9 / −0.47 / 0.93 | −0.70 / −0.18 | −0.40 | 274 / −0.79 | ungated −3.07 / −3.18 (perm p 0.072 / 0.016) | New `FactEngineSettings.REQUIRE_BOX_SIDE` (default false). Check at both emit sites in `shared/fact-engine.ts`: the bar-close path near the `computeRiskFlags` call (~L1751) and `evaluateFormingBar` (~L1980). The day zone is already passed for the tight-room flag. Add parity fixtures plus a flag in `scripts/fact-engine-backtest.ts`. |
| R2 | **Session-range floor:** no fire until the session range so far ≥ 0.25 × the dead-tape median (~19 pts) | 475 / 73.5 / −0.28 / 0.96 | −0.78 / +0.44 | −0.22 | 341 / −0.58 | ungated −4.25 / −4.65 (p 0.069 / 0.007). Live book: removed rows 47 % win, −10.1 (old rules, clustered). | New `MIN_SESSION_RANGE_FRAC` (0.25; 0 = off). It uses the `dayRangeSoFar / dayRangeMedian` already computed for dead-tape (~L1866), in both paths. |
| R3 | **Tight-room block on 5m and 15m only** | (in set B) | — | — | — | 5m −6.08 (n=15) / −15.36 (n=16); 15m n=3 / 6 | New `BLOCK_TIGHT_ROOM_INTERVALS: ["5m","15m"]`, reading the existing `computeRiskFlags` output. Low confidence. |
| R4 | **1m near-anchor block** (`MIN_TP1_PTS` 12.25 on 1m) | 1m: 236 / 71.6 / +0.60 / 1.08 | +1.44 / −0.55 | unknown | — | tabletop@1m −5.53 / −0.82 | `MIN_TP1_PTS` exists in `ExitCalibration` (fact-engine.ts L88/L96, used at L751). It needs a **per-interval** value: add it to `resolveExitCalibration`, or have every writer (catchup.ts, live-engine worker, market.tsx tab, fe-bt harness) pass `exit: {MIN_TP1_PTS: 12.25}` when primary = 1m. |
| R5 | **Portfolio one-open across intervals** (or, by hand: one position per direction per cluster) | ungated 883 → 497, −1.13 → −0.90; gated 609 → 408, −0.99 | ungated −1.30 / −0.43 | — | (this *is* the de-cluster) | — | `ONE_OPEN_PER_DIRECTION` is per interval today. Needs a cross-interval option in `server/fire-admission.ts` and the priorFires seed (`shared/engine-seed.ts`). Per-trade expectancy is unchanged; exposure is roughly halved and cluster stop-outs cap. |
| Set B | R1 + R2 (upper cap: range < 1 × median) + no tight-room flag | **297 / 76.4 / +0.95 / 1.16** | +0.41 / +1.65 | +0.99 | 200 / +0.52 | — | Combination of R1–R3 plus a `MAX_SESSION_RANGE_FRAC` (1.0). The cap has the weakest support. |
| Set B, ungated | same | 426 / 76.5 / +0.85 / 1.14 | +0.62 / +1.12 | +1.01 | **231 / −0.15** | — | — |
| Set B, RTH only (gated) | same | 98 / 77.6 / +1.87 / 1.36 | +0.24 / +3.95 | +2.02 | — | — | — |

Set B robustness:
- Gated day-block 90 % CI [−0.87, +2.44], P(negative) = 0.21.
- Without the best 3 days: +0.30 gated, +0.22 ungated.
- July is still negative. 1m H2 stays negative in ungated sets (−1.45). 15m responds best, but on small n.
- Firing about 6 fires/day instead of about 12.

**Do not add (tested; reverses sign between halves or too small):**
- 60m or 15m vector-side gates;
- a 15m slope gate (refuted);
- fresh-break-only;
- ≥3 counted facts;
- per-session caps;
- alignScore thresholds;
- footprint agreement;
- skip-the-open;
- hour blackouts;
- an engine-wide RTH-only switch;
- greedy ≤4-rule optimiser outputs. Fitted on H2 and tested on H1, they gave −2.36 against a base of −1.37.

---

## 6. Approval list (answer yes / no to each)

1. **Era-stamp the book.** Report Signals-tab results from session day 2026-09-27 onward (current rules) separately from everything older, and stop judging the system on the pre-09-24 rows.
2. **Re-resolve the 10 stored rows** whose stored loss is a win on served bars (+371 pts: the 09-14 roll interleave plus id 148944). This writes signal_history, so it would be done in a separate session with a backup.
3. **Shadow tags (no effect on fires, alerts or orders).** Stamp every new fire with four tags: `box-side-wrong`, `range-below-0.25med`, `tight-room@5m/15m` and `1m-anchor-under-12.25`. Score them weekly on de-clustered fires, and decide R1–R4 once each tag has **≥ 40 de-clustered fires** (about 1–4 months; a month alone is underpowered).
4. **Sandboxed engine replay** of R1, R2 and R4 (fe-bt with the new settings, no `--persist`), to measure the chain effect the row-removal numbers cannot show.
5. **R4 (1m `MIN_TP1_PTS` 12.25)**: approve for live *after* the shadow (3) and replay (4) agree?
6. **R1 (box-side admission)**: approve for live after shadow and replay agree?
7. **R2 (session-range floor)**: approve for live after shadow and replay agree?
8. **Hand-trading rule now (no code):** when 1m/5m/15m/60m fire the same direction within about 10 minutes, take **one** position, not one per interval.
9. **Keep exits as they are:** 15m stays at the user-approved 10.5/26, no breakeven move, no global stop cap.
10. **Shadow the anchor-aware 5m/60m exits** (default bracket 15/15, keep yellowbox-anchored) next to the shipped exits.
11. **Before accepting any gate regen** (including the 09-25 sandbox re-gate), hand-check FG+Fr+Vec@1m (+2.07/trade here, both halves positive; the regen would block it) and Fr+YB@1m (−2.62 here).
12. **Open tickets:**
    - (a) The catch-up writer should not be able to stack dozens of same-direction fires against one unchanged target. **Verified 2026-10-01 (late): real but narrow. The admission one-open check looked backward only, so a replay twin landing 11+ bars BEFORE an ordered fire was admitted; fixed in `server/fire-admission.ts` (symmetric check), covered by `scripts/fire-admission.test.ts` B1+. Same-target re-fires after a closed trade are sequential by rule and unchanged.**
    - (b) A verifier observed that the live engine may walk 5m/15m/60m outcomes on coarse bars, because the forming higher-timeframe bar is in the DB. In the replay, 5 of 79 60m outcomes flip under that walk. This is unverified on the running server. **Verified 2026-10-01 (late) on the running server's data: the forming bucket is always in `cached_candles` (derive-bars), the walk fell back to coarse bars whenever it was present, and the engine also FIRED on it (20 of 354 HTF rows in 30 days carry a partial-bar entry). Fixed in `shared/fact-engine.ts` + `shared/outcome-resolver.ts`, covered by `scripts/forming-bar-walk.test.ts`; live after the owner's next restart. Affected stored rows are not repaired (see LEARNINGS 2026-10-01 late).**
    - (c) Data repair for the 2026-09-04 16:28Z phantom bar and the 2026-09-14 roll seam.
    - (d) Three live rows had their label rewritten on re-post (identity-field mutation).
13. **Add a LEARNINGS.md entry** with these findings. This task was read-only, so it has not been written.

---

## 7. Caveats: what this does and does not show

- **Sample:** about 70 session days, which is one regime pair. The effective independent sample is about 500 ungated and 400 gated trades after cross-interval de-duplication. Per-trade standard error is about 0.65 pts. Every "+0.5 to +1.0" result above lies within about 1.5 standard errors of zero.
- **In-sample:** H1 is in-sample for the shipped gate and exits. Set B and P1 were chosen with both halves visible. The `MIN_TP1_PTS` floor was the best of three tried.
- **Not reproducible in the replay:**
  - milk zones (no upload history, so zone-reaction facts never appear);
  - PML/TML option levels (live-only);
  - the live writers' priorFires seed;
  - the per-day engine window (the replay uses today's 90-day window, with only about 3 days of warmup at the start);
  - the dead-tape median as of each date (computed as of today);
  - the gates that were actually in force before 09-24.
- **Data defects (bounded):**
  - The 09-14 15:31Z contract-roll seam (+67 pts) touches 0 outcome walks, but contaminates first-crossing cells for 38 rows and 60m vector values for 22 rows. Those were excluded where it mattered.
  - The 09-04 phantom bar affects one 1m outcome.
  - Footprint data exists for only 206 of 883 fires.
- **Not testable here:** fills and slippage beyond the 1-pt friction (hand fills on tight stops likely cost another ~0.3/trade); news-event exposure; the Apex daily-loss interaction across the 18:00 reset; 5m/15m/60m live outcome walks (ticket 12b).
- **The live 30-day book** is mostly old-rule rows, so it cannot confirm or refute the status findings. De-clustering it gives contradictory answers depending on the rule (lineup-11 refuted).
- **"Unknown" stays unknown:** the engine-chain effect of R1–R3, the Apex result of R4, and live-book status results for H1 (the export covers 30 days).

### Files
- Dataset: `C:\BaxterSandbox\analysis\signals-3mo.json` / `.csv`, `live-book-30d.json`, `README.md`
- Lens outputs: `C:\BaxterSandbox\analysis\lens-lineup\`, `lens-exits\`, `lens-why-bad\` (per-signal status CSVs), `lens-firing\`
- Refutations: `C:\BaxterSandbox\analysis\refute\` (including `exits2\min-tp-floor-counterfactual.json`)
- This report's recomputes: `C:\BaxterSandbox\analysis\report\` (`verify.cjs` / `verify.json`, `status.cjs`, `rth.cjs`, `rthiv.cjs`)
- Dataset builder: `scripts/analysis/build-signal-dataset.ts`. 1m floor counterfactual: `scripts/analysis/exits2-min-tp-floor-counterfactual.ts`
