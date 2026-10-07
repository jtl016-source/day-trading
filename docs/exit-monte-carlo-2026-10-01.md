# Exit strategies and Monte Carlo: can a better exit stop the bleeding?

**Date:** 2026-10-01. **Data:** 978 engine fires from 2026-06-24 to 2026-10-01 on MES (`C:\BaxterSandbox\analysis\signals-3mo.json`). 609 of them passed the quality gate ("gated", which is what the app alerts on). Each fire's real 1-minute price path was walked forward under 12,232 different exits. **Friction:** 1.0 pt per trade is taken off every trade ("NET"). **Halves:** H1 = 06-24..08-12, H2 = 08-13..10-01. **Money:** MES is $5 per point, so 100 pts is $500 per micro.

Every exit tested has ONE exit per trade (TP1-only policy): a fixed target and stop, a breakeven move, a trailing stop, or a time stop. There is no second target and no scaling out.

Every number is computed two ways. **Apex** means flat by 16:55 ET, which is how you trade it now. **Carry** means held overnight until the target or stop, which is the book's convention.

Nothing was shipped. `shared/quality-gate.ts`, `signal_history`, `.env`, `C:\BaxterData` and the live server were not touched, and the database was opened read-only.

---

## The short answer

1. **The current exits lose money on every interval.** Over 609 gated alerts in Apex mode they lost **-810 pts in total (about -$4,050 at 1 micro)**. Win rates are high (66-71%), but the losers cost more than the winners make. Before the 1-pt friction the gated trades already average **-0.15 pts (1m), -1.02 (5m), -1.54 (15m) and +0.76 (60m) per trade**. So the problem is not only costs.
2. **No exit makes the losses go away.** The best exit chosen on H1 and tested on H2 brings each interval from clearly losing to **roughly breakeven**. Four candidates came out of the sweep, one per interval. Four separate independent checks re-ran each one, and **none held up**. Their held-out results are within noise of zero. Most of their profit comes from 3 lucky days. Several depend on overnight entries you cannot take by hand on Apex.
3. **The losses come from which trades the system takes (entry selection), not from the bracket.** The exit sweep cannot fix that.
4. **What protects the account right now is behaviour, not a new exit:** stop hand-trading the 1m alerts, use 1 micro per alert, hold one position at a time, and do not size up. With the shipped 1m exit, the chance of blowing the account within 60 trading days is **34% at 1 micro and 89% at 2 micros**.
5. **Recommendation:** do NOT ship any of the four candidate exits as the calibrated exit yet. DO record them as shadow (paper) exits on every new alert, so they get a real forward test. That needs about 150 held-out trades per interval before anyone can judge them.

---

## 1. Why the current exits bleed

The tables below use the shipped exit: the per-trade TP1/SL from the live gate, exactly as fired.
- **P95 DD** is the drawdown that 95% of simulated 100-trade runs stay under, in points.
- **P(DD>=500)** is the chance of a 500-pt drawdown. That is $2,500 at 1 micro, which is your whole trailing drawdown.

### Apex mode (flat by 16:55) - gated alerts

| Interval | n | Win % | Gross /tr | NET /tr | PF | Total NET | H1 (06-24..08-12) n / NET / PF | H2 (08-13..10-01) n / NET / PF | P95 DD | P(DD>=500) | P(DD>=250) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1m | 355 | 71.0% | -0.15 | **-1.15** | 0.84 | -406.9 | 201 / -0.90 / 0.87 | 154 / **-1.46** / 0.81 | 359 | <0.5% | 28% |
| 5m | 143 | 67.1% | -1.02 | **-2.02** | 0.73 | -289.5 | 78 / -3.21 / 0.63 | 65 / **-0.61** / 0.90 | 439 | 2% | 54% |
| 15m | 38 | 65.8% | -1.54 | **-2.54** | 0.70 | -96.6 | 19 / +1.35 / 1.24 | 19 / **-6.44** / 0.43 | 540 | 9% | 72% |
| 60m | 73 | 67.1% | +0.76 | **-0.24** | 0.96 | -17.3 | 38 / +1.39 / 1.28 | 35 / **-2.01** / 0.74 | 316 | 0% | 16% |

### Carry mode (held overnight) - same alerts

| Interval | n | Win % | Gross /tr | NET /tr | PF | Total NET | H1 NET / PF | H2 NET / PF | P95 DD | P(DD>=500) | P(DD>=250) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1m | 355 | 72.4% | -0.15 | -1.15 | 0.85 | -407.4 | -0.82 / 0.89 | -1.57 / 0.80 | 355 | <0.5% | 27% |
| 5m | 143 | 67.8% | -1.44 | -2.44 | 0.70 | -348.7 | -3.87 / 0.58 | -0.72 / 0.89 | 490 | 4% | 66% |
| 15m | 38 | 68.4% | -1.45 | -2.45 | 0.71 | -93.2 | +1.35 / 1.24 | -6.26 / 0.45 | 519 | 7% | 70% |
| 60m | 73 | 65.8% | +0.18 | -0.82 | 0.88 | -60.1 | +1.37 / 1.26 | -3.21 / 0.64 | 380 | 0% | 31% |

### What the numbers say, in plain words

- **A high win rate hides the loss.** A 71% win rate with a profit factor of 0.84 means the 29% of losing trades cost more than the 71% of winners earn. The targets are small relative to the stops, so a handful of full stops wipes out a long run of small wins.
- **It is not just commissions.** Even with zero costs, 1m, 5m and 15m lose money (negative gross). The 1-pt friction only tips 60m from slightly positive to slightly negative.
- **15m and 60m only looked good in the half the gate was built on.** The quality gate was fitted on data up to 2026-08-12, so H1 is "in-sample" for the gate itself. On H2, the first unseen data, 15m fell from +1.35 to -6.44 per trade and 60m fell from +1.39 to -2.01. That is what an over-fitted filter looks like.
- **The gate may be hurting 15m.** The *ungated* 15m fires made **+0.70/trade on H2** (n67, PF 1.13), while the gated ones made -6.44. Gated 5m and 1m are also no better than ungated on H2: ungated 5m H2 was -1.66 and ungated 1m H2 was -1.35, against gated -0.61 and -1.46. Across all ungated alerts the total was -1,259 pts on 883 trades.
- **The overnight hold is not the main problem.** Apex mode and carry mode give almost the same results. Forcing flat at 16:55 helps 5m and 60m a little and changes almost nothing else.

---

## 2. Can a different exit fix it? Walk-forward results

**Method.** For each interval, the best exit was picked on H1 only (minimum 15 trades, P95 drawdown 300 pts or less), then scored on H2, which it had never seen. This is the honest test. The best exits over the full window look much better, but that is curve-fitting across 12,232 tries.

| Interval | Shipped H2 NET /tr (Apex) | Best overall H1 pick, scored on H2 | Best family pick, scored on H2 | Independent check verdict |
|---|---|---|---|---|
| 1m | -1.46 | trail m18/g3 SL10: **0.00** | breakeven: be+9 TP10/SL11: **+0.05** | Does not hold: about -0.6/tr if traded by hand |
| 5m | -0.61 | grid TP22/SL11: **-0.07** | trailing: trail m18/g3 SL12: **+0.84** | Does not hold: confidence range -1.8 to +3.2; -0.59 under worst-case fills |
| 15m | -6.44 | grid TP29/SL22: **-2.88** | time stop: time240m TP30/SL22: **+0.68** | Does not hold: only 19 trades; 44% chance the real result is 0 or below |
| 60m | -2.01 | ATR TP2x/SL2.25x: **-1.75** | time stop: time240m TP30/SL18: **+0.31** | Does not hold: 55/45 coin flip; profit comes from 3 days |

**The pattern.** The pre-registered "best overall" pick failed or was flat on H2 for every interval. A positive H2 result only appears after looking inside one exit family. Six families were checked, so this is partly picking the winner after the fact.

**What does survive:**
- A **wide target with a 3-4 hour time stop** moves 15m and 60m from clearly negative to around zero. At 15m, the time-stop variants that ranked in the top 10% on H1 averaged +0.64 on H2, and 67% of them were positive.
- **Breakeven-style exits stop the 1m bleed.** On H2, be+9 beat the shipped exit by +1.95 pts/trade (90% CI +0.15 to +3.72), but only when every hour is counted, including the overnight hours.

---

## 3. The four candidates in detail (carry AND Apex), with the independent checks

### 5m - trail m18/g3 SL12 (no fixed target)

**The rule:** a hard stop 12 pts from entry. Once the trade is +18 pts, the stop trails 3 pts behind the best price, updated every 1m bar.

| Mode | n | Win % | Gross | NET /tr | PF | Total | H1 n / NET / PF | H2 n / NET / PF | MC100 P5/P50/P95 | P95 DD | P(DD>=250) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Apex (as claimed) | 132 | 47.0% | +1.86 | +0.86 | 1.13 | +113.8 | 75 / +0.88 / 1.13 | 57 / +0.84 / 1.12 | -84 / +84 / +259 | 176 | 0.3% |
| Carry (as claimed) | 131 | 45.0% | +1.49 | +0.49 | 1.07 | +64.5 | 75 / +0.54 / 1.08 | 56 / +0.43 / 1.06 | -127 / +46 / +227 | 199 | 1% |
| **Apex, re-checked on raw 1m bars** | 133 | 47.4% | +1.69 | **+0.69** | 1.10 | +91.3 | 75 / +0.75 / 1.11 | 58 / +0.60 / 1.09 | -110 / +67 / +243 | 193 | 0.7% |
| Apex, worst-case fill order | - | - | - | **-0.59** | 0.91 | - | -0.49 | -0.72 | - | 277 | 8.9% |

**Why it does not hold:**
- **The range of plausible results includes zero.** The 95% confidence range for NET/trade runs from -1.80 to +3.18 (H2: -3.14 to +4.43).
- **Three days are almost the whole profit.** The three best days (07-01, 07-30, 09-16) are +90.5 of the +91.3 total. Without them the result is -0.02 per trade, and H2 without its own top 3 days is -0.99.
- **The edge is overnight.** RTH entries alone: n44, NET -0.60, PF 0.91. ETH entries (91 of the 133) were +1.99 in H1 but only +0.01 in H2, and the five biggest winners were all entered overnight, between 22:20 and 08:25 ET.
- **1m bars cannot tell the order of prices inside a bar.** In 40 of the 58 trail activations, the same bar also gave back 3 pts or more. The sweep assumed the favourable order every time; assuming the unfavourable order turns the result negative. The truth lies somewhere between -0.6 and +0.7, and without tick data it cannot be narrowed.
- **It is not one simple order.** "Fixed stop until +18, then a 3-pt trail" needs a profit-triggered auto-trail, such as an ATM-style strategy. Whether Apex treats that as permitted order management was not checked.

### 60m - time240m TP30/SL18

**The rule:** target +30, stop -18. If neither is hit, exit at market after 240 minutes. Also flat at 16:55.

| Mode | n | Win % | Gross | NET /tr | PF | Total | H1 n / NET / PF | H2 n / NET / PF | MC100 P5/P50/P95 | P95 DD | P(DD>=250) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Apex | 73 | 53.4% | +2.08 | +1.08 | 1.19 | +79.0 | 38 / +1.80 / 1.30 | 35 / +0.31 / 1.06 | -98 / +104 / +332 | 222 | 2% |
| Carry | 73 | 52.1% | +2.05 | +1.05 | 1.18 | +76.8 | 38 / +1.83 / 1.30 | 35 / +0.21 / 1.04 | -103 / +101 / +329 | 224 | 2% |
| **Apex, Monte Carlo on H2 trades only** | 35 | - | - | +0.31 | 1.06 | +10.75 | - | - | -200 / +28 / +288 | **256** | **5.8%** |

**Why it does not hold:**
- **H2 is a coin flip.** H2's +0.31/trade has a 95% confidence range of -4.16 to +4.94; the chance the true mean is above 0 is 55%.
- **Three days carry the full window.** The top 3 of 57 traded days add +118 pts against a +79 total; without them, -0.58 per trade.
- **H1 rank did not carry over.** This exit ranked #1 of 5,000 time-stop variants on H1 but #1,414 on H2.
- **Too much of it happens overnight to trade by hand on Apex.** 46 of the 73 entries are overnight, 19 come between 00:00 and 06:59 ET, and 45 of 73 exits are the 4-hour market exit, for example a 01:00 entry closed at 05:00. Apex bans automation, so you would have to be awake and click it yourself.

### 15m - time240m TP30/SL22

**The rule:** target +30, stop -22. Exit at market after 240 minutes if neither is hit. Flat at 16:55.

| Mode | n | Win % | Gross | NET /tr | PF | Total | H1 n / NET / PF | H2 n / NET / PF | MC100 P5/P50/P95 | P95 DD | P(DD>=250) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Apex | 37 | 62.2% | +3.40 | +2.40 | 1.38 | +88.8 | 18 / +4.21 / 1.81 | 19 / +0.68 / 1.09 | -40 / +235 / +493 | 230 | 3% |
| Carry | 37 | 62.2% | +3.43 | +2.43 | 1.38 | +89.8 | 18 / +4.24 / 1.81 | 19 / +0.71 / 1.10 | -38 / +238 / +497 | 230 | 3% |
| **Apex, Monte Carlo on H2 trades only** | 19 | - | - | +0.68 | 1.09 | +13 | - | - | -200 / +67 / +353 | **326** | **18%** |

**Why it does not hold:**
- **19 held-out trades prove nothing.** H2's 95% range is about -7.7 to +9.1 per trade, with a 44% chance the true result is at or below zero.
- **The profit is three days.** The top 3 days are the entire +88.75 total; without them the result is exactly 0.00 per trade.
- **The H1 numbers do not count.** H1 was used to fit the gate itself, so the H1 figures (+4.21, PF 1.81) carry no out-of-sample weight.
- **The overnight trades lost on H2.** H2's overnight trades (13) averaged -1.90; the whole H2 profit is 6 RTH trades at +6.29 each. 14 of the 37 entries come between 22:00 and 07:00 ET.

### 1m - be+9 TP10/SL11

**The rule:** target +10, stop -11. Once the trade is +9, the stop moves to entry.

| Mode | n | Win % | Gross | NET /tr | PF | Total | H1 n / NET / PF | H2 n / NET / PF | MC100 P5/P50/P95 | P95 DD | P(DD>=250) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Apex (as claimed) | 334 | 53.3% | +0.97 | -0.03 | 0.99 | -10.8 | 191 / -0.09 / 0.98 | 143 / +0.05 / 1.01 | -156 / 0 / +148 | 204 | 1% |
| Carry (as claimed) | 334 | 53.0% | +0.95 | -0.05 | 0.99 | -16.0 | 191 / -0.09 / 0.98 | 143 / +0.01 / 1.00 | -157 / -1 / +148 | 206 | 1% |
| **Hand-executable** (TP needs 1 tick through, 0.25-pt slip on stops, one position at a time) | 289 | 50.2% | +0.38 | **-0.62** | 0.88 | - | 167 / -0.83 / 0.84 | 122 / -0.32 / 0.93 | - | ~224 | - |
| **Awake hours + hand-executable** (entries 07:00-16:55 ET) | 110 | 50.0% | +0.13 | **-0.87** | 0.84 | - | 64 / -0.46 | 46 / **-1.44** / 0.73 | - | - | - |

**Why it does not hold:**
- **The breakeven result depends on overnight trades.** It comes from fires between 23:00 and 07:00 ET (n103, +0.57).
- **In the hours you can trade, it is worse than what you have now.** On the awake-hours H2 trades it does -0.66, while the shipped exit does +0.30 on those same trades.
- **Small execution delays matter.** Entering 2 minutes late turns it to -0.42.

---

## 4. Same trades, shipped exit against candidate

Each candidate was walked over the **same fire list** as the shipped exit. The trade counts differ only because the engine's one-open-per-direction rule was re-applied for each exit. It dropped 21 fires at 1m, 11 at 5m, 1 at 15m and 0 at 60m.

| Interval | Shipped Apex NET /tr (all / H2) | Candidate Apex NET /tr (all / H2) | H2 gain | Is the gain real? |
|---|---|---|---|---|
| 1m | -1.15 / -1.46 | -0.03 / +0.05 | +1.51 (+1.95 on the matched trades) | Marginally, all hours only (90% CI +0.15..+3.72). **Worse in awake hours.** |
| 5m | -2.02 / -0.61 | +0.86 / +0.84 (+0.69 / +0.60 on raw bars) | +1.45 | Not established (fill-order ambiguity, 3-day dependence) |
| 15m | -2.54 / -6.44 | +2.40 / +0.68 | +7.12 | Direction plausible (time stops as a group transfer), size not established (n19) |
| 60m | -0.24 / -2.01 | +1.08 / +0.31 | +2.32 | Weak (H1 rank does not predict H2) |

The paired H2 confidence interval was computed only for 1m. For the others, the gain is "candidate H2 minus shipped H2", and its noise is about as large as the candidate's own H2 range above.

---

## 5. Risk of blowing the account and time to first payout (Apex day simulation)

**Setup:** 5,000 simulated paths, each a 250-trading-day horizon built by resampling the 72 session days in 5-day blocks. The rules modelled were:

- a $1,000 daily loss limit;
- a $2,500 EOD trailing drawdown that locks at the starting balance once the peak reaches +$2,500;
- a payout once the account is up $2,600, with no single day more than 50% of the profit.

Each interval is simulated **on its own account**.

The figures below use each exit's full-window expectancy. For the candidates that expectancy was **not** confirmed by the checks above, so read candidate payout odds as **best case**, and use the H2-only drawdowns in section 3 for planning.

| Interval | Exit | 1 micro: blown in 30d / 60d / 250d | 1 micro: P(payout in 250d) / median days | 2 micros: blown in 30d / 60d / 250d | 2 micros: P(payout) / median days |
|---|---|---|---|---|---|
| 1m | **shipped** | 2.8% / **34%** / 99.9% | 0% / - | 48% / **89%** / 100% | 0.4% / 58 |
| 1m | be+9 TP10/SL11 | 0% / 0.4% / 26% | 9% / 189 | 5.4% / 22% / 74% | 31% / 94 |
| 5m | **shipped** | 0.2% / 8.9% / 98% | 0% / - | 21% / **65%** / ~100% | 0.1% / 67 |
| 5m | trail m18/g3 SL12 | 0% / 0% / 0.04% | 34% / 193 | 0% / 0.2% / 4.5% | 81% / 120 |
| 15m | **shipped** | 0% / 0% / 30% | 0% / - | 0.1% / 7.5% / 87% | 0.2% / 125 |
| 15m | time240m TP30/SL22 | 0% / 0% / 0.3% | 21% / 199 | 0.02% / 0.9% / 11% | 70% / 129 |
| 60m | **shipped** | 0% / 0.02% / 11% | 1.3% / 199 | 0.5% / 7.4% / 63% | 18% / 130 |
| 60m | time240m TP30/SL18 | 0% / 0% / 0.6% | 21% / 196 | 0.2% / 2.2% / 20.5% | 64% / 123 |

**How to read this:**
- **The shipped exits are a slow road to a blown account.** At 1 micro, the shipped 1m and 5m exits blow the account in nearly every 250-day path (99.9% and 98%) and essentially never pay out. 15m and 60m bleed slowly because they trade rarely, but they still blow 30% and 11% of 1-micro accounts within 250 days.
- **The fastest payout would still take months.** Even if a candidate's edge were real, the median time to a first payout is about **190-200 trading days (9-10 months) at 1 micro**, or **about 95-130 trading days at 2 micros**. At 2 micros the blow-up risk rises a lot (60m 20.5%, 1m 74% within 250 days).
- **These odds rest on unproven edges.** The checks showed the candidate edges are not established, and with an edge of about zero the payout odds fall toward the shipped rows.

---

## 6. Sizing advice under Apex's limits

Your limits in points:

| Limit | 1 micro | 2 micros |
|---|---|---|
| $2,500 trailing drawdown | 500 pts | 250 pts |
| $1,000 daily loss | 200 pts | 100 pts |

**The size rules:**
- **1 micro per alert, never more.** The honest (H2-only) P95 drawdowns of the best candidates are 256 pts (60m) and 326 pts (15m). That is **$1,280-$1,630 at 1 micro, but $2,560-$3,260 at 2 micros**, which is more than the whole $2,500 trailing drawdown. With the shipped exits, the P95 drawdowns are already 316-540 pts at 1 micro.
- **One position at a time.** The sims let a Long and a Short run together (48 overlaps on 1m alone). In a single Apex account they net to flat, and running one position at a time made the 1m result worse (-0.35/trade before fill costs).
- **Do not trade the 1m alerts on Apex.** No exit makes them profitable during hours you are awake (-0.87/trade after realistic fills on 07:00-16:55 entries). With the shipped exit they blow 34% of 1-micro accounts within 60 trading days.
- **The numbers above are per interval.** Running 5m, 15m and 60m together on one account adds their drawdowns together; that combination was not simulated.
- **Check which Apex plan you are on.** The research notes (`C:\BaxterSandbox\analysis\eth-research\propfirm-apex-overnight-constraints-2026-10-01.md`) say the current Apex 4.0 50K EOD plan is **$2,000** drawdown + $1,000 daily loss. The $2,500 figure matches the legacy plan. If yours is $2,000, every ruin figure above is optimistic: at 1 micro that is 400 pts, not 500.
- **Apex's trading day starts at 18:00 ET.** An overnight loss spends the same day's $1,000 daily loss before RTH even opens.

---

## 7. Approval list

Each item is yes/no. The recommended answer is in bold.

| # | Item | Recommendation |
|---|---|---|
| 1 | Ship **5m trail m18/g3 SL12** as the calibrated 5m exit | **NO.** Edge not established (CI -1.8..+3.2; -0.59 under worst-case fills); needs overnight trades; the auto-trail may not be one order you can place. |
| 2 | Ship **60m time240m TP30/SL18** as the calibrated 60m exit | **NO.** H2 is a coin flip (P>0 = 55%); 3 days carry the result; mostly overnight 4-hour exits. |
| 3 | Ship **15m time240m TP30/SL22** as the calibrated 15m exit | **NO.** Only 19 held-out trades, and the result without the top 3 days is 0.00. |
| 4 | Ship **1m be+9 TP10/SL11** as the calibrated 1m exit | **NO.** -0.62/tr with realistic fills; worse than shipped in awake hours. |
| 5 | Leave the shipped exits unchanged in the engine and records for now | **YES.** No replacement is proven better out-of-sample. Changing the gate file is a separate, explicit change. |
| 6 | Record all four candidates as **shadow (paper) exits** on every new alert, and re-judge once each interval has about 150 held-out trades | **YES.** This is the only way to get a real out-of-sample answer. It needs a code change, done as a separate task. |
| 7 | Stop hand-trading the **1m** alerts on Apex | **YES.** |
| 8 | Hard cap of **1 micro per alert, one position at a time** on Apex | **YES.** |
| 9 | Investigate the backtest loader dropping 3.3% of 1m bars (see caveats) before the next calibration | **YES.** Separate task. |
| 10 | Re-examine the **15m quality gate** (ungated 15m H2 +0.70 against gated -6.44) | **YES.** Separate study; the problem looks like entry selection, not the exit. |

---

## 8. Caveats

- **The two halves are short.** Each is about 36 session days in a single market regime. With 12,232 exits tried, the full-window "best" exits are optimistic by construction, so only the H2 numbers and the walk-forward numbers deserve weight.
- **H1 is in-sample for the gate.** `shared/quality-gate.ts` was calibrated on 2026-04-15..08-12, so every gated H1 trade was selected by a filter fitted on H1. Only H2 is clean.
- **1m bars cannot show the order of prices inside a bar.** This matters most for tight trails, where 40 of 58 trail activations at 5m are ambiguous. No tick data exists in `app.db`.
- **The backtest loader drops bars at price extremes.** Its isolation filter (`buildBaseCandles`, third pass) removes **3,516 of 101,160** raw 1m bars since 06-24 (3.3%), and it tends to remove the bar at a local extreme, which is exactly where targets and stops get touched. On the raw bars:
  - the shipped 1m exit scores -0.84/tr instead of -1.15 (H2 -1.21 instead of -1.46);
  - 15 of the 978 shipped outcomes flip, 13 of them from loss to win;
  - 3 of the 143 gated 5m outcomes flip from loss to win.

  The bleed is real either way, but the backtests slightly overstate it. The 978/978 validation could not catch this, because the dataset was built from the same filtered bars.
- **Fill rules used.** A target and stop touched in the same bar counts as the stop. Fixed targets and stops fill at their level. A moved stop takes effect from the next bar and fills at that bar's open if price gaps through it. There is no slippage beyond the 1 pt. The hand-executable re-checks in section 3 add realistic fills.
- **Simplifications in the Apex day sim:**
  - Long and Short trades that overlap are treated separately.
  - The trailing drawdown locks at the starting balance, while Apex locks it at start + $100, a 20-pt difference.
  - The sim uses the 50% consistency rule. Current Apex performance accounts use 50% and legacy accounts use 30%.
  - Minimum trading days are not modelled.
  - "Days" are resampled session days.
- **15m and 60m have few trades.** The 100-trade Monte Carlo reuses the 38 (15m) and 73 (60m) trades many times over.
- **ATR14 was computed for this study.** The dataset has no ATR column, so ATR14 is the mean true range of the last 14 bars of the signal interval. The ATR exits overfit H1 and failed H2 on every interval except 15m.
- **Overnight trading is a separate report.** The second part of your request (better ways to trade ETH) is being covered there, with source notes in `C:\BaxterSandbox\analysis\eth-research\`. One finding here is relevant: **most of each candidate's apparent edge sits in overnight entries you would have to take by hand while asleep**, and the overnight edge seen in H1 was mostly gone in H2 (5m trail ETH: H1 +1.99, H2 +0.01; 15m H2 ETH -1.90).

---

## Files

- **Sweep script:** `scripts/analysis/exit-monte-carlo.ts`
- **Outputs:** `C:\BaxterSandbox\analysis\exit-mc\`
  - `SUMMARY.md`, `summary.json`, `walk_forward.csv`, `monte_carlo_top15.csv`, `family_best_insample.csv`, `validation.txt`
  - full grids: `grid_{gated,ungated}_{1m,5m,15m,60m}_all_{carry,apex}.csv`
- **Independent re-checks:** `C:\BaxterSandbox\analysis\exit-mc\refute\`
  - `recompute-trail.cjs`, `trades_m18g3sl12.csv`, `report_m18g3sl12.json` (5m)
  - `recompute-mc2.mts`, `recompute-mc2.log` (60m)
  - `rewalk-15m.ts`, `rewalk-15m.log`, `pick-trades.csv` (15m)
  - `refute_mc4.py`, `followup.py`, `refute_mc4.out` (1m)
  - `c1m-check.mts` (the missing-bar finding)
