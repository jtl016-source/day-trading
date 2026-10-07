# Morning 1m candle-pattern scalps (3-5 pt): does it win? — 2026-10-07

**Question (owner):** if we only trade scalps in the morning, averaging 3-5 points per scalp, using pattern recognition on each candle, can that be a winning strategy?

## Verdict

**No, not on the last three months of MES data.** No candle pattern earns 3-5 point morning scalps enough to pay the trading cost.

- **Your exact proposal loses in all 18 tests.** That is 3/3, 4/4 and 5/5 brackets, six patterns, both directions, no filter. Each loses **0.83 to 1.27 pt per trade** with 1.0 pt of friction, and **0.53 to 0.97 pt** with 0.7 pt. Every one of them also loses in both halves of the window.
- **The patterns barely beat a coin flip.** They win 45.8-52.2% of the time. Random entries over the same minutes, with the same bracket, win 43.6-50.0%. The gaps are -2.0 to +5.7 win-rate points. To break even the gap would need to be +8.4 to +14.6 points at 0.7 friction, or +11.4 to +19.6 at 1.0.
- **Trading more makes it worse.** Engulfing and pin bars end up taking 12-24 trades a morning. Engulfing 3/3 took 1,552 trades at -1.09 pt each, with a 1,696 pt max drawdown. Taking all six patterns as one signal stream:
  - 3/3: 2,825 trades (42.8/day), -1.29 pt/trade, -3,656 pts total, about -$18,280 per MES contract at $5/pt.
  - 4/4: -2,821 pts.
  - 5/5: -2,090 pts.
- **I searched 648 pattern/filter/direction/bracket combinations, and the few positives are what chance produces.** The test compares against 300 placebo grids that keep the same signal counts but use random entry minutes:
  - At the harshest scoring, 5 cells were positive in both halves. A random grid makes 3.06 such cells on average, and 24% of placebos make 5 or more.
  - The best real cell made +0.62 pt/trade. The best placebo cell averaged +0.83, and 67% of placebos beat +0.62.
- **The best first-half picks fail out of sample.** I picked the best cell per pattern on Jul 6-Aug 20 and tested it on Aug 21-Oct 6. 5 of 6 lost: -0.71 to -1.44 pt/trade at standard scoring with 1.0 friction. The sixth was +0.17 (+0.06 pessimistic) on 59 trades, and its first-half pick had itself been negative.
- **Every "survivor" depends on a few lucky days.** All 5 both-halves-positive cells are short-side, filtered, and trade less than once a day (n = 49-57 over 27-36 sessions). Each turns negative once its 3 best days are removed.

The best-looking cell is the inside bar, short, below the vector and the box, 5/8. A human cannot trade it. Its edge sits in the first seconds of the next minute:

| Entry timing | Net, pessimistic fills, 1.0 friction |
|---|---|
| Next bar's open | +0.62 |
| Mid-bar | +0.25 (second half: -0.45) |
| Bar close | -0.01 |
| One bar late | -0.58 |

## Method (what was tested)

- **Data:** MES 1m bars from `cached_candles` in `data/app.db`, opened read-only. The window is 2026-07-06 to 2026-10-06: 66 RTH sessions, with the 2026-09-14 roll day excluded. Labor Day is included, on a thin tape. A frozen day yellow box exists for all 66 sessions.
- **Entry and exit:** the signal bar closes between 09:31 and 12:25 ET, and the entry is the next 1m bar's open. The trade exits on the bracket or flat at 12:30 ET. One position is open at a time per cell.
- **Patterns:**

  | Name | Rule |
  |---|---|
  | engulf | Engulfing bar |
  | pin | Hammer or shooting star (wick at least 2x the body) |
  | inside | Inside-bar breakout past the mother bar |
  | rev3 | Three-bar reversal |
  | mom2 | Two big same-colour bars, each at least 1.5x the median range; enter in that direction |
  | dojibrk | Doji, then a close beyond it |

- **Filters:** none, vec (side of `Highest(Lowest(low,20),20)`), yb (side of the frozen day yellow box), vec+yb, first60 (entry 09:31-10:30), and after1030 (entry 10:31-12:25).
- **Directions:** long, short, or both.
- **Brackets (TP/SL, points):** 3/3, 4/4, 5/5, 4/6, 5/8, 6/8.
- **Scoring:** the same definitions as `C:\BaxterSandbox\analysis\scalping\sim-brackets\RESULTS.md`.
  - Optimistic.
  - Standard: if TP and SL are both hit in the same bar, it counts as a loss.
  - Pessimistic: the target needs a 1-tick trade-through, and the stop fills 1 tick worse.
- **Friction:** 0.7, 1.0 and 1.5 pt per trade. That gives 5,832 grid rows in total.
- **Break-even win %:** `(SL + F) / (TP + SL)`. Pessimistic scoring adds 1 tick to SL.
- **Matched random control:** 20 random entries per session over the same entry minutes, with the same direction rule, bracket and scoring.
- **Halves:** H1 = Jul 6-Aug 20 (34 sessions), H2 = Aug 21-Oct 6 (32 sessions).
- **Verification:**
  - An independent bar-by-bar re-walk matched 500 of 500 random draws.
  - A separate refuter wrote its own pure-Python recompute. It reproduced every number in this note, including every cell, the grid counts, the walk-forward table and the placebo.
  - A truncation test checked for lookahead and found none (0/400 mismatches). The box is anchored on the prior day's 17:00 ET settle.

## Best cell per pattern family

These are the best cells per pattern over the whole grid (n >= 30). The column definitions:

- **Win**, **control** and **break-even** use standard scoring. Break-even is at 1.0 friction.
- **Net/trade** columns use pessimistic fills, at 0.7 and 1.0 friction.
- **H1 / H2**, **PF** and **max DD** use standard scoring at 1.0 friction.
- **Walk-forward H2:** the cell picked as best on H1, then traded on H2, at standard scoring with 1.0 friction.

| Pattern | Best cell (filter / dir / TP/SL) | n | Trades/day | Win % | Control win % | Break-even win % | Net/trade pess F0.7 | Net/trade pess F1.0 | H1 net | H2 net | PF | Max DD (pts) | Walk-forward H2 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| engulf | vec+yb / long / 6/8 | 234 | 3.54 | 58.6 | 51.8 | 64.3 | -0.20 | -0.49 | -0.03 | -0.71 | 0.90 | 182.0 | n103, -0.71 |
| pin | vec / short / 6/8 | 135 | 2.04 | 57.8 | 51.6 | 64.3 | +0.06 | -0.24 | +0.03 | -0.28 | 0.96 | 66.8 | n86, -1.44 |
| inside | vec+yb / short / 5/8 | 54 | 0.82 | 72.2 | 57.8 | 69.2 | +0.92 | +0.62 | +0.91 | +0.42 | 1.31 | 18.0 | n61, -0.84 |
| rev3 | first60 / short / 5/8 | 54 | 0.82 | 68.5 | 65.8 | 69.2 | -0.36 | -0.66 | +0.29 | -0.79 | 0.97 | 37.0 | n19, -0.79 |
| mom2 | after1030 / both / 6/8 | 85 | 1.29 | 60.0 | 47.4 | 64.3 | +0.59 | +0.29 | -0.52 | +0.83 | 1.13 | 50.5 | n59, +0.17 |
| dojibrk | first60 / short / 6/8 | 87 | 1.32 | 62.1 | 59.4 | 64.3 | -0.03 | -0.33 | -0.27 | -0.21 | 0.93 | 74.8 | n70, -0.80 |

How to read the table:

- **Most cells lose even at the cheapest cost.** Only inside and mom2 are positive at 1.0 friction, and only those two plus pin at 0.7.
- **Only inside clears its break-even win rate**, at 72.2% against 69.2%. It does that on 54 trades over 27 days, and it falls to -6.50 pts without its 3 best days (07-07, 07-08, 08-14).
- **mom2's best cell lost in H1** (-0.52). Without its best 3 days it is -22.0 pts.
- **Walk-forward picks a different cell than the table.** It chose the best cell on H1 only, so its cells differ from the full-window best:

  | Pattern | H1-best cell used for H2 |
  |---|---|
  | engulf | vec+yb/long/6/8 |
  | pin | vec+yb/long/6/8 |
  | inside | vec/short/5/5 |
  | rev3 | first60/short/5/8 |
  | mom2 | after1030/both/4/6 |
  | dojibrk | first60/both/6/8 |

  Pessimistic H2 nets for those picks are -0.88, -1.79, -0.97, -2.28, +0.06 and -0.90.

### Your exact proposal: no filter, both directions, 3-5 pt brackets

Scoring is standard. Net/trade is shown at 1.0 friction; the range at 0.7 friction is -0.53 to -0.97 across all 18 cells.

| Pattern | 3/3 n / win / control / net | 4/4 n / win / control / net | 5/5 n / win / control / net |
|---|---|---|---|
| engulf | 1552 / 48.1 / 48.8 / -1.09 | 1277 / 48.2 / 47.0 / -1.11 | 1058 / 45.8 / 45.1 / -1.27 |
| pin | 1124 / 48.7 / 47.2 / -1.05 | 955 / 47.4 / 48.7 / -1.13 | 799 / 47.9 / 48.5 / -1.08 |
| inside | 628 / 49.7 / 47.1 / -1.00 | 558 / 49.1 / 45.5 / -1.02 | 494 / 45.8 / 47.7 / -1.22 |
| rev3 | 301 / 52.2 / 47.3 / -0.83 | 293 / 48.8 / 45.9 / -1.00 | 280 / 46.8 / 47.0 / -1.14 |
| mom2 | 345 / 49.0 / 49.9 / -1.04 | 314 / 50.6 / 48.5 / -0.87 | 286 / 49.3 / 43.6 / -0.94 |
| dojibrk | 551 / 49.5 / 50.0 / -1.00 | 515 / 49.9 / 47.4 / -0.94 | 459 / 48.6 / 48.6 / -0.97 |

All 18 cells are negative in both H1 and H2. Max drawdowns run from 252 pts (rev3 3/3) to 1,696 pts (engulf 3/3).

## Why 3-5 pt scalps are structurally hard here

The bracket is symmetric, so the win rate needed to break even is `(SL + F) / (TP + SL)`:

| Bracket | Break-even at F 0.7 | Break-even at F 1.0 |
|---|---|---|
| 3/3 | 61.7% | 66.7% |
| 5/5 | 57.0% | 60.0% |

These percentages follow from the formula; they are not simulation output. Random 1m entries hit a symmetric bracket about 44-50% of the time. A pattern therefore has to add 10-20 win-rate points on top of a coin flip. The best real patterns add 0-6 points unfiltered. Friction is a fixed cost per trade, and a 3-point target is small against it: at 1.0 pt, friction takes a third of every win. Each pt/trade is $5 per MES contract.

## What would change the answer

1. **A pattern that beats the random control by at least 10 win-rate points in both halves, at n >= 100 per half.** It must also survive two more tests:
   - Picked on H1 and confirmed on H2, or on a later window, without re-tuning.
   - Still positive at pessimistic fills after removing its best 3 days.

   Nothing in the 648-cell grid meets this. The largest gaps (+14 to +17) are on cells with fewer than 65 trades in total.
2. **Much lower friction.** The formula makes friction the main lever: at F = 0.25 pt, a 3/3 needs only 54.2%. The patterns still have to show a real gap above control, though. The unfiltered 3/3 gaps are -0.9 to +4.9 points, and the formula still leaves a shortfall at that cost. Re-running the grid at your actual all-in cost per round trip would settle this. That cost is commission plus the entry slippage you really get, measured from your own fills.
3. **Tick or 1-second data.** 1m bars cannot show whether TP or SL came first inside a bar, and cannot model a realistic entry delay.
   - Same-bar ambiguity does not matter here. The 3/3 cells have only 25-31 ambiguous bars out of about 1,500 trades, so scoring every one as a win would not close a -1.0 to -1.3 pt/trade hole.
   - Entry latency does matter. Tick data would show whether the inside-bar short edge survives a realistic 2-5 second human or automation delay. The 1m evidence already says it decays to zero by mid-bar.
4. **A longer or different regime.** This is 66 sessions of one summer/fall tape. A positive result on another 3-6 months would count only for a cell **frozen now**, before that data is seen:

   | Candidate | Pessimistic F1.0 now | Without best 3 days |
   |---|---|---|
   | inside / vec+yb / short / 5/8 | +0.62, n54 | -6.50 |
   | mom2 / after1030 / short / 6/8 | +0.39, n49 | -6.75 |

   mom2 is the only candidate that survives entry latency: +0.39 at the open, +0.42 at the bar close, +0.70 one bar late. That makes it the one worth paper-tracking. It is not tradeable on today's evidence: sign-flip p = 0.32 before any correction for multiple testing, and its best cell sits well inside the placebo distribution.
5. **Context the 1m candle cannot see**, such as order flow, footprint, or a level the candle reacts to. The candle shape alone carries close to no information beyond random entries over the same minutes.

## Files

- **Main analysis**, in `C:\BaxterSandbox\analysis\morning-scalps\`:
  - Report: `RESULTS.md`
  - Data: `grid.csv` (5,832 rows), `best_by_family.csv`, `walk_forward.csv`, `both_halves_positive.csv`, `placebo.json`, `survivor_detail.txt`, `survivor_trades.csv`, `signal_counts.csv`, `meta.json`
  - Scripts: `morning_scalps.py`, `verify_walk.py`, `placebo.py`, `survivor_detail.py`, `report.py`
- **Independent refutation**, in `C:\BaxterSandbox\analysis\morning-scalps\refute\`:
  - Scripts: `recompute.py`, `grid_placebo.py` (200-run placebo; agrees: both-halves mean 2.8, 19% >= 5, 64.5% beat +0.62), `midbar_entry.py` (latency test)
  - Data: `refute_results.json`, `grid_placebo.json`, and the per-trade CSVs for the three top cells
