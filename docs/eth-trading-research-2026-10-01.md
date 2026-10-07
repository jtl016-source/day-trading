# Overnight (ETH) trading: what the research says, what your data says, what to change

**Date:** 2026-10-01. **Scope:** the overnight sleeve (ETH, 18:00 → 09:29 ET) of the MES signal engine, and how you trade it on the Apex evaluation by hand.
**Companion report:** `docs/exit-monte-carlo-2026-10-01.md`. That report answers question 1, "is there a better exit?" This report answers question 2, "how should the overnight session be traded?" It also pulls the overnight-specific findings out of the exit work.
**Nothing was shipped.** No engine setting, gate, order window, database row or server process was changed. Every recommendation below is waiting for your yes or no (see section 6).

Labels used throughout:
- **[EVIDENCE]** is a measured result: a published study, or a query on your own database.
- **[RULE]** is an exchange or Apex rule.
- **[OPINION]** is lore, a vendor claim, or my own inference. Treat it as a hypothesis to test, not a fact.

Money: MES is $5 per point. 100 pts = $500 per micro.

---

## 0. The short answer

1. **The overnight sleeve loses money in every way it was measured, and no exit fixes it.**

   | Population | Overnight trades | Net result |
   |---|---|---|
   | Live book, last 3 months | n = 3,635 | -4,006 pts |
   | Live book with the clustered repeat-fires removed | n = 480 | -136 pts |
   | Current-rules replay, as alerted (gated) | n = 453 | -750 pts, -1.66/trade, PF 0.78 |
   | Current-rules replay, ungated | n = 551 | -745 pts |

   The companion Monte Carlo tried 12,232 exits. None survived a held-out test.

2. **Why it loses.** Overnight moves are about half the size of daytime moves. Overnight fires take 2.5 to 3 times longer to reach +6 pts (median 20 min vs 7 min at 1m). Once a fire is live, the median favourable move and the median adverse move are almost the same size (8.25 vs 7.75 pts). Against a target of about 12 pts and a stop of 25 pts, a ~70% win rate is roughly breakeven before costs and a loss after costs.

3. **Where the money is actually lost:** in the overnight fires that are still open when the 08:00-10:59 ET window arrives. In the live 1m book:
   - Overnight fires that exited before 09:30: **+1,400 pts** (77.6% win).
   - The 695 that exited inside RTH: **-4,372 pts** (54% win).

   But flattening everything at 09:29 makes the result **worse** (-2,971 → -4,946), because those trades are already underwater by then. The fix has to be on the entry side (do not take the trade), not a clock exit.

4. **The published research agrees.**
   - The one well-documented overnight return pattern in ES (the 2-3 AM ET drift) was never tradable after the bid-ask spread. It has averaged about zero since 2021.
   - Asia-hours ES has about 1/50 of RTH volume and about 1/18 of its depth.
   - The 8:30 and 10:00 ET releases produce scheduled price jumps.
   - Practitioners treat 7 PM-2 AM ET as a context-only session, not a time to scalp.

   Nothing published supports 1m breakout-style confluence fires through the night.

5. **What to do.**
   - Keep hand-trading RTH only on Apex (your order window is already 09:30-15:15).
   - Turn overnight confluence back into "record, don't alert" (or off).
   - Add a scheduled-news blackout.
   - Test only two things further: dropping the fractal-breakout two-fact combos overnight, and an hour-scaled stop. Run both as shadow (paper) tests, not live changes.

---

## 1. Your numbers, reconciled

Different reports have quoted different "overnight loss" figures. They come from different filters, and they all point the same way.

| Source | Window | Rows | Overnight result |
|---|---|---|---|
| Daily digest (your "~500 pts / 30 d on 1m") | 30 d | digest filters + cooldown | about -500 pts |
| `signal_history` 1m, ETH fires, outcomes win/loss only | 30 d | 820 | 67.8% win, **-1,100.9 pts**, median TP 12.25 / SL 25.0 |
| `signal_history` all intervals (clustered, old cooldown of 4, no one-open rule before 09-24) | 3 mo | 3,635 | 71.5% win, **-4,006** (-1.10/trade, PF 0.85). RTH made +1,143 |
| Same, de-clustered to one open trade per direction × interval | 3 mo | 480 | 73.8% win, **-136** (-0.28/trade, PF 0.96) |
| Current-rules replay (`signals-3mo.json`), gated = what is alerted | 3 mo | 453 | 70.9% win, **-750** (-1.66/trade, PF 0.78). RTH was -159 |
| Same, Apex mode (flat by 16:55) | 3 mo | 453 | -715 |

What this means:
- **About 97% of the big live-book loss was clustering.** The old 4-bar cooldown re-fired the same box break all night. The 2026-09-24 fixes (cooldown 10, one open trade per direction, yellow-box break counted as a one-time event) already removed that.
- **What remains is structural.** Under current rules the overnight sleeve is still about -1.7 pts per alerted trade.

**The bracket arithmetic [EVIDENCE, arithmetic].** Take the median 1m overnight bracket: TP 12.25, SL 25.
- Breakeven win rate before costs = 25 / (12.25 + 25) = **67.1%**.
- After the 1-pt friction it is 26 / 37.25 = **69.8%**.

The sleeve wins 68-72%, so it sits right on the breakeven line. Many anchored targets are smaller than the median, which pushes it below.

---

## 2. What the published evidence says about overnight index futures

Every academic claim below was independently fact-checked against the primary source on 2026-10-01. Corrections from that check are included. The practitioner and Apex items were collected but **not** independently fact-checked; they are marked as such.

### 2.1 There is no overnight drift left to lean on

- **[EVIDENCE] Where the drift was.** ES mid-quote returns from 1998 to 2020 were robustly positive only in the 00:00-03:00 ET hours and, weakly, 06:00-07:00 ET. The 02:00-03:00 hour alone averaged +1.48 bp (t = 7.1), about 3.7% a year.
  - Only the 02-03 hour survives multiple-testing adjustment.
  - The Asian block (18:00-24:00) shows no significant drift in either direction.
  - Source: Boyarchenko, Larsen & Whelan, *The Overnight Drift*, NY Fed Staff Report 917 (rev. Aug 2022; RFS 2023), Table I. https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr917.pdf
- **[EVIDENCE] It was never tradable after costs.** A long-only 2-3 AM strategy had a Sharpe ratio of 1.10 gross and -0.54 after the bid-ask spread. The authors' words: "With transaction costs, the OD is not profitable in practice." (SR 917, Table IX.)
- **[EVIDENCE] It is now gone.** The 2-3 AM window "has averaged close to zero" over 2021-2025. The authors link this to closing-order imbalance becoming much less lopsided (its standard deviation fell from 6.5% to 2.9%). NightShares' overnight-only ETFs closed after 14 months.
  - Correction from the fact-check: the 5.9% close-to-close figure is the 1998-2020 number only.
  - Source: Liberty Street Economics, *The Disappearing Overnight Drift*, 1 Jul 2026. https://libertystreeteconomics.newyorkfed.org/2026/07/the-disappearing-overnight-drift/
- **[EVIDENCE] The "fade a lopsided close at the Asian/European open" effect has also shrunk.**
  - What it was (1998-2019): after a sell-off close, the European hours returned +12.4% annualised; after a rally close, -5.1%.
  - What it is now: the same authors report the spread is "much narrower" in 2021-2025.
  - Sources: Liberty Street, 26 May 2021, https://libertystreeteconomics.newyorkfed.org/2021/05/the-overnight-drift-in-us-equity-returns ; and the 2026-07-01 post above.
- **[EVIDENCE] Overnight moves do not reliably continue or reverse.** The correlation between the overnight move so far and the rest of the move to the cash open ranged from about -5% to +5.4%, and its sign flipped from year to year: "no sign of significant mean reversion."
  - Milliman, *Overnight trading strategies*, 20 Mar 2024. https://edge.sitecorecloud.io/millimaninc5660-milliman6442-prod27d5-0001/media/Milliman/PDFs/2024-Articles/3-28-24_Overnight-trading-strategies.pdf
  - Corrected range per the fact-check. Milliman's hour labels are uncertain by ±2 h.
- **[EVIDENCE] The FOMC-eve drift is old.** Before scheduled FOMC announcements, the S&P 500 rose +49 bp in the prior 24 hours (Sept 1994-Mar 2011). Other releases showed no such pattern. The sample ends in 2011, and the paper did not isolate the overnight-futures part.
  - Lucca & Moench, JoF 2015 (NBER draft): https://conference.nber.org/conf_papers/f66717.pdf

**Takeaway:** do not add any directional overnight tilt. It would be built on effects that are gone, were never net-profitable, or were never measured overnight.

### 2.2 The overnight tape is a different, thinner market

- **[EVIDENCE] Activity by session.** ES, Jan 2008-Nov 2011, averages per minute:

  | | Asia (6 PM-3 AM ET) | Europe (3-9:30 AM ET) | US |
  |---|---|---|---|
  | Volume (contracts) | 95 | 601 | 4,726 |
  | Trades | 14 | 67 | 360 |
  | Depth at best bid + ask | 54 | 265 | 984 |
  | Annualised volatility | 0.16 | 0.25 | 0.40 |

  The spread was one tick almost always.
  - Andersen, Bondarenko, Kyle & Obizhaeva, *Intraday Trading Invariance in the E-mini S&P 500*, AEA 2017 draft, Table 1. http://www.aeaweb.org/conference/2017/preliminary/paper/bNFQsR3f
  - Absolute levels are dated (crisis era, before MES existed). The relative structure is the durable part.
- **[EVIDENCE] Overnight volatility per hour.** It is about 10-21 bp, against 29-51 bp in US hours. The typical overnight hour is about 0.45 of a typical RTH hour.
  - Your own MES bars (last 180 days) reproduce the ratio: overnight median 10.7 bp vs RTH 22.7 bp, a ratio of 0.47.
  - SR 917, Table I. Corrected per the fact-check: the original claim said 15-21 bp and one-third to one-half.
  - At MES ≈ 7,700, one overnight hour's standard deviation is roughly 6-13 pts. A 25-pt stop is 2-3 of those away. A 6-12 pt target is about one.
- **[EVIDENCE] Volatility outside US hours has been rising, especially in Asian hours.** Andersen, Su, Todorov & Zhang, JASA 2024. https://www.kellogg.northwestern.edu/faculty/todorov/htm/papers/cal.pdf
  - Practical point: calibrate overnight sizing on recent data, not old data.
- **[EVIDENCE, broker education, not peer-reviewed, not fact-checked]** ES spreads are 0.25 pt in liquid hours vs 0.75-1.00 pt in thin hours. Optimus Futures names 02:00-08:00 ET among the thinnest windows. https://learn.optimusfutures.com/low-liquidity-trading
  - Your engine assumes 1 pt of friction. That was validated on RTH-weighted 15m data (LEARNINGS 2026-08-12), not on 1m Asian-hours fills.
- **[EVIDENCE, not fact-checked] Stop-market fills.** CME fills stop-market orders inside a 3-pt protection band. The CFTC found that floor was hit "on many occasions", and stop fills track volatility.
  - Fett & McPhail, CFTC, 2017. https://www.cftc.gov/sites/default/files/Stoploss_final_ada.pdf

### 2.3 Scheduled releases are jump events

- **[EVIDENCE] 8:30 and 10:00 ET jumps.** Over three-quarters of S&P futures jumps between 8:30 and 8:35 ET are tied to 8:30 releases. About 60% of 10:00-10:05 jumps are tied to 10:00 releases. Nonfarm payrolls were followed by a jump 77% of the time.
  - Miao, Ramchander & Zumwalt, *J. Futures Markets* 34(10), 2014. https://mountainscholar.org/handle/10217/206891
  - Same paper: jump clusters also appear at the 9:35 cash open and at the 18:05 Globex reopen.
- **[EVIDENCE] Informed pre-release drift.** In E-mini and T-note futures (2008-2014), 9 of 20 market-moving releases show informed trading. Prices move in the right direction about 30 minutes early, and that early move is about 40% of the total adjustment.
  - Kurov, Sancetta, Strasser & Wolfe, JFQA 2019. https://ideas.repec.org/a/cup/jfinqa/v54y2019i01p449-479_00.html
  - Corrected per the fact-check: the working paper said 7 of 18 and about half.
- **[EVIDENCE, your data] The 8:30 bar's tail.** On your MES 1m bars (90 days):
  - 08:30-08:35 bar: median range 5.6 pts, but p90 20.75 and max 57.25.
  - 08:00-08:05 bar, for comparison: p90 8.5, max 15.75.
  - First 15 minutes after the 09:30 open: median excursion 13 pts, p90 20.5.

### 2.4 Practitioner material (collected, not independently fact-checked)

- **[EVIDENCE, vendor sample, 6 months] Session ranges.** Edgeful reports the ES Asia-session range (7 PM-4 AM ET) exceeds its 14-day ATR only 12.6% of the time, against 32.3% for London and 40.9% for NY. They call Asia a context session, "not active day trading". https://www.edgeful.com/blog/posts/best-time-to-trade-futures (2026-01-27)
- **[EVIDENCE, vendor, Jun-Dec 2024] Overnight direction does not carry into RTH.** A green overnight was followed by a green RTH day 47% of the time. https://www.edgeful.com/blog/posts/overnight-continuation-trading-strategy
- **[EVIDENCE, weak: NQ, single blog, no costs] Killzone backtest.** An ICT-style setup on NQ (2024-2026) showed:
  - Asia window (7-10 PM ET): PF 0.86.
  - London window (2-5 AM ET): PF 1.32.
  - NY window (7-10 AM ET): PF 1.74.

  https://www.awaketrader.com/educacion/ict-killzones-backtest-500-sesiones-nq-2024-2026
- **[EVIDENCE, SPY 2006-2026, vendor] Carrying intraday trades overnight.** Carry-to-open roughly doubled the maximum drawdown (-45.4% vs -25.6%). The short leg's Sharpe fell from 0.52 to 0.17 when carried. https://concretumgroup.com/breaking-the-rules-of-intraday-trading/
- **[OPINION] Overnight lore is consistent across educators.**
  - Trade smaller overnight.
  - Treat the Asian range as context.
  - Treat the first London break of the Asian range as a fade, not a breakout.
  - Use mean-reversion targets (range midpoint, overnight VWAP) rather than fixed points.
  - Use limit entries and stop-limit exits.

  No published ES hit rates back any of this. Sources: propfirmapp (mod. 2026-08-07), NinjaTrader (2026-08-17), WH SelfInvest, LuxAlgo, MQL5, NexusFi (search snippets only).
- **[OPINION] No breakout research exists for this case.** No peer-reviewed study was found that tests breakout, FVG or level-style setups inside the Globex overnight session. Your own 1m store is the only credible test bed.

### 2.5 Apex rules that bear on overnight trading

These come from the Apex help center, accessed 2026-10-01, and were not independently fact-checked.

- **[RULE] Trading day and daily loss limit (DLL).**
  - The trading day runs 18:00 ET to 16:59 ET, so overnight trading is allowed.
  - The DLL resets at 18:00 ET and counts open losses in real time.
  - Hitting the DLL liquidates you and **pauses trading for the rest of that session**. A 2 AM DLL hit therefore costs you the whole RTH day.
  - Sunday-evening trading counts toward Monday.
- **[RULE] Flat by 16:59 ET.** Holding through the close is a prohibited activity. The 16:59 auto-close is "a final resort and should not be relied upon."
- **[RULE] Prohibited risk shape.** "Strategies that involve small profit targets while risking disproportionately large amounts are not allowed." Apex's example is a 5-tick target against a 150-tick stop. Your overnight 1m profile (about 12 vs 25) is nowhere near that example, but it leans in that direction.
- **[RULE] No automation.** "No Automation or Algorithm Usage allowed." The engine may inform your hand trades. Routing its order commands into the Apex account is a conduct violation.
- **[RULE] Check which drawdown model you are on.** The numbers you gave ($1,000 daily loss + $2,500 trailing drawdown on a 50K) do not match any single current Apex 50K plan:

  | Plan | Drawdown | Daily loss limit |
  |---|---|---|
  | Apex 4.0 EOD | $2,000 | $1,000 |
  | Apex 4.0 Intraday | $2,000 | none |
  | Legacy 50K | $2,500 trailing | none, but the PA has a 30% per-trade MAE rule |

  The models treat overnight open profit differently. On the Intraday and Legacy models, an unrealised overnight peak ratchets the threshold up. Check this in RTrader before relying on any overnight budget.

---

## 3. What your own overnight data says

The data has two populations, both covering the last 3 months:
- **DB** is the live `signal_history` book: clustered, under the old rules.
- **DS** is the current-rules replay.

CSVs are in `C:\BaxterSandbox\analysis\eth-research\internal\`.

### 3.1 Robust: it holds in every population

1. **The sleeve is negative everywhere.** DB -4,006 / de-clustered -136 / DS gated -750 / DS ungated -745. It also got worse in the second half: DS gated 1m went from -56 in H1 to -320 in H2, and 60m from +63 to -90.
2. **The worst combos are always the fractal-breakout two-fact combos on 1m/5m.**

   | Combo | DB | DS gated | DB de-clustered |
   |---|---|---|---|
   | 1m Fractal + Yellow Box | n = 1,949, -2,399 (**54.6% of all live overnight losses**) | n = 51, -115 | — |
   | 5m Fractal + Yellow Box | -779 | n = 56, -95 | — |
   | 1m Fractal + Vector | — | n = 88, -149 (worst single combo) | — |
   | 1m FG + Vector (worst per trade) | -9.0/trade | n = 47, -99 | -6.9/trade |

   This matches the research prior: continuation breakouts in a thin, range-bound overnight tape are the class that should not work.
3. **The tape is slower overnight, not lopsided.** These figures are DS gated, walked on 1m bars:

   | 1m fires | Overnight | RTH |
   |---|---|---|
   | Median move in favour after 30 min | 3.5 pts | 7.75 pts |
   | Median minutes to reach +6 | 20 | 7 |
   | Median hold (DB) | 169 min | 65 min |

   Overnight, the median move in favour and against by exit are almost equal (8.25 vs 7.75). With no asymmetry to harvest, an exit cannot create an edge. This is why the companion Monte Carlo found nothing that survives.
4. **The losses are realised at 08:00-10:59 ET.** DB 1m overnight fires by exit hour:

   | Exit hour (ET) | n | Result |
   |---|---|---|
   | 08 | 412 | -3,304 |
   | 09 | — | -1,133 |
   | 10 | — | -1,189 |
   | 12 | — | -1,230 at 2% win |

   Every exit hour from 18:00 to 01:00 is positive.
5. **But a 09:29 flat is worse** [EVIDENCE]:

   | Population | As traded | Flat at 09:29 |
   |---|---|---|
   | DB 1m | -2,971 | -4,946 |
   | DB 5m | -753 | -1,165 |
   | DS gated, all intervals | -750 | -763 |
   | DS ungated | -745 | -868 |

   About a third of the trades open at 09:29 recover to the target after the open. The earlier 15m exit study also found generic time stops destructive (LEARNINGS 2026-08-12).

### 3.2 Not robust: it flips between populations or between months

1. **Which hours are worst.**

   | Population | Worst hours | Positive hours |
   |---|---|---|
   | DB | 02 ET (-1,637, PF 0.52) and 04 ET (-1,208) | 1m 18-23 ET net +1,404 |
   | DS gated | 19 ET (-277, PF 0.36) and 18 ET (-143) | — |
   | 30-day 1m slice | 04 ET (-675), 07 ET (-344), 03 ET (-248) | 18-23 ET |
   | 2026-08-20 study (for comparison) | 18:00-03:00 ET was the kill zone | 04:00-07:30 ET was "good" |

   **The hour profile has flipped within six weeks.** An hour gate built on any one of these would be curve-fitting.
2. **60m-vector alignment.**
   - DB 1m: fading the vector won (+561, PF 1.17) and aligning lost (-3,532).
   - DS gated 1m: aligning lost less (-0.88/trade) than fading (-2.02/trade).

   The sign flips, so this is unusable as a filter.
3. **London-window fires.**
   - DS gated London 1m: n = 94, +49 (78.7% win).
   - DS gated London 60m: n = 14, +59.
   - DB London 1m: -3,463.

   Only "60m entered in the London hours" is positive in three cuts (+59 / +33 / +30), and every cut has n ≤ 38. That is too small to act on.
4. **Only two hour-cells are positive in both books:** 1m entries at 05 and 07 ET (DS +70 / +74, DB 07 +117). Small samples.

---

## 4. Recommendations for this system

Each recommendation gives the evidence, the exact change it needs, and a confidence level. "Shadow" means a paper exit or rule recorded on every new alert without changing what fires or what you trade.

### R1. Keep the Apex account RTH-only for hand trades. Do not take overnight alerts. (Confidence: HIGH)

**Evidence:**
- The sleeve is negative in every population (§3.1).
- The DLL resets at 18:00 ET, so an overnight loss spends the RTH day's budget, and a DLL hit locks you out of RTH (§2.5).
- The companion report's shipped-exit Monte Carlo puts the chance of losing the account within 60 trading days at 34% at 1 micro.

**Change:**
- None to code. `server/trade-state.ts` already has `orderHoursEnabled: true` with `orderWindows` set to `[09:30-15:15]` since 2026-08-20.
- Keep it that way. Do **not** re-add the `04:00-07:30` window. The hour study that justified it has flipped (§3.2).
- Personal rule: no manual overnight entries on the Apex account.

### R2. Stop ALERTING overnight confluence fires. Keep recording them for scoring. (Confidence: MEDIUM-HIGH)

**Evidence:**
- You enabled ETH confluence on 2026-08-11 to "see how it performs". Seven weeks later the answer is consistently negative: -750 alerted under current rules, -136 even after de-clustering, worse in H2.
- No published edge supports this class of trade overnight (§2.1-2.2).

**Change.** Two options:
- **(a) Preferred.** Keep `ETH_CONFLUENCE: true` in `FACT_ENGINE_DEFAULTS` (`shared/fact-engine.ts:266`), so the records keep scoring. Add an alert-layer filter so ETH-session confluence fires are tagged "ETH, record-only": no push or Discord alert, and shown muted on the Signals tab.
  - The exact alert call site still needs to be located. Signal alerts do not go through `server/discord-notify.ts` directly; `trade-notify.ts` only covers AutoTrader order events.
  - The vector side-entry overnight fire keeps its existing behaviour.
- **(b) Simpler, bigger blast radius.** Set `ETH_CONFLUENCE: false`. This restores the pre-2026-08-11 behaviour (overnight fires are vector side-entry only). Because it changes what the engine fires, it also requires the full regen sequence:
  1. Regen.
  2. `scripts/uniform-live-revalue.ts`.
  3. `scripts/integrity-check.ts` (uniform serving policy).
  4. Before choosing (b), run `scripts/fact-engine-backtest.ts` with `ETH_CONFLUENCE:false` over the same 3-month window. That checks whether the vector-side-entry-only overnight sleeve is itself positive. It has not been measured in this study.

### R3. Scheduled-news blackout for new entries. (Confidence: MEDIUM)

**Evidence:**
- Jump studies: 8:30 and 10:00 jumps are release-driven (§2.3).
- Informed drift starts about 30 min before a release.
- Your 8:30 bar's p90 is 20.75 pts, about the size of a stop.
- Apex also bans news strategies that "gamble the outcome" and two-sided orders.
- Not tested: whether this improves this system's P&L. The jump risk itself is well established.

**Change:**
- A new `newsBlackouts` list in `tradeSettings` (`server/trade-state.ts`), checked in `orderHoursGateReason()`, plus a small dated calendar file:
  - Every US 8:30 print (CPI, PPI, NFP, retail sales, GDP): 08:25-08:40 ET.
  - 10:00 prints (ISM, Consumer Confidence): 09:55-10:05 ET.
  - FOMC: 13:55-14:30 ET.
- For the engine records: an optional matching suppression in the firing loop, behind a new setting such as `NEWS_BLACKOUT` (default off until replay-tested).
- Your order window already blocks 08:30, so for Apex the live effect is the 10:00 and 14:00 windows.

### R4. Shadow-test dropping the fractal-breakout two-fact combos overnight. (Confidence: MEDIUM-LOW)

**Evidence:**
- 1m/5m Fractal + Yellow Box, Fractal + Vector and FG + Vector are the worst overnight combos in every cut (§3.1 point 2). It is the most stable entry-side finding in the data.
- The research prior is against continuation breakouts in thin overnight tape.

**Risk:** the quality gate is already over-fitted. The 15m gated result fell from +1.35 to -6.44/trade on the first unseen data (companion report §1). Another combo block could repeat that.

**Change:**
- A new engine setting `ETH_MIN_AGREEING_FACTS` (proposed 3; today `MIN_AGREEING_FACTS` = 2 for all sessions), applied in the confluence check in `shared/fact-engine.ts` only when the bar is ETH.
- Alternative: an ETH-only veto when the agreeing set is exactly {fractal breakout + one other} on 1m/5m.
- Pick on H1 (06-24..08-12) and score on H2 before anything goes live. Run it shadow-first. Ship only if H2 is positive net of 1 pt **and** not carried by ≤ 3 days, the same bar used in the exit report.

### R5. Shadow-test an hour-scaled overnight stop. (Confidence: LOW, [OPINION])

**Evidence:**
- Your median 60-minute range overnight is 6-12 pts per hour (00h 6.0, 03h 11.0, 23h 7.5), against 25-27 at 09-10 ET.
- A fixed 25-pt stop is 2-4 overnight hour-ranges wide but only one hour-range once the open arrives.

**Against it:**
- ATR-scaled exits transferred worse than static ones on 15m (LEARNINGS 2026-08-12).
- The ATR pick in the exit Monte Carlo failed on H2 (60m: -1.75).

**Change:**
- Shadow exit only: stop = 1.5-2 × the median 60-minute range of the fire hour (measured on the trailing 60 days), target unchanged. Record it beside the shipped bracket under TP1-only scoring.
- Do not change `shared/quality-gate.ts` exits.

### R6. Sizing and budget if you ever trade overnight again. (Confidence: HIGH on the arithmetic)

**Evidence:**
- 1 MES with a 25-pt stop = $125. That is 12.5% of a $1,000 DLL and 5% of a $2,500 trailing drawdown.
- The 30-day 1m overnight sleeve (-1,101 pts) = **-$5,505 per micro**, which is twice the trailing drawdown.

**Rule:**
- 1 micro and one position at a time.
- Overnight loss cap $250 per night (two full stops), leaving at least three-quarters of the DLL for RTH.
- On the Intraday or Legacy drawdown models, take overnight profits mechanically, because an unrealised peak ratchets the threshold.

**Change:**
- A new `ethLossCapDollars` setting on the Apex guard in `server/trade-state.ts` (`apexGuard*`).
- It does nothing while R1 holds. Build it only if overnight trading is ever resumed.
- First confirm your actual Apex plan type in RTrader (§2.5).

### Considered and rejected

| Idea | Verdict | Why |
|---|---|---|
| Disable firing in specific overnight hours (e.g. 18-20 ET or 02-04 ET) | **No** | The worst hours flip between populations and months (§3.2). This is a curve-fit. |
| London-open-only overnight window (02/03-08 ET) | **No (shadow at most)** | The books disagree (DS +49 vs DB -3,463 at 1m). The European-open drift that would justify it is gone (§2.1). 60m London fires are positive but n ≤ 38. |
| Overnight-only cooldown | **No** | The 2026-09-24 fixes already removed about 97% of the clustering. Current-rules replay is still -750. Note: `ETH_COOLDOWN = 20` in `shared/firing/constants.ts` is a retired constant that nothing reads. |
| Require 60m-vector alignment overnight | **No** | The sign flips between books (§3.2). |
| Clock exit or time stop on overnight positions (flat at 08:25 or 09:29) | **No** | Measured worse (-2,971 → -4,946 at 1m). Generic time stops were destructive on 15m. The companion report's 240-minute time stops stay shadow-only. |
| Fade the US close at 19:00/02:00, or a FOMC-eve long bias | **No** | Both effects are historical (1998-2020 and 1994-2011). The first is documented as fading since 2021. |

---

## 5. Do not

- Do not hand-trade overnight alerts on the Apex account, at any size, until a shadow test shows a positive held-out result (R1).
- Do not re-add the `04:00-07:30` order window on the strength of the 2026-08-20 hour study; that profile has since flipped.
- Do not add a 09:29 or 08:25 forced flat; it is measured worse.
- Do not add any directional overnight bias (overnight drift, close-imbalance fade, FOMC-eve long). The evidence is gone, untradable after costs, or not measured overnight.
- Do not trust any overnight hour-of-day win rate from one six-week window.
- Do not raise size to make up the overnight losses. At 2 micros the chance of blowing the account within 60 days with the shipped 1m exit is 89% (companion report).
- Do not route engine order commands into the Apex account. Apex bans automation.
- Do not ship any of the exit Monte Carlo's four candidate exits as the calibrated exit (companion report).
- Do not rely on the 1-pt friction assumption for overnight 1m fills. Thin-hour spreads alone can be 0.5-1.0 pt per round trip.

---

## 6. Approval list (answer yes or no to each)

1. **R1:** Keep the Apex account hand-traded during RTH only, with no manual overnight entries, and keep `orderWindows` at `[09:30-15:15]`?
2. **R2(a):** Keep overnight confluence fires recorded and scored, but stop push and Discord alerts for them and mute them on the Signals tab?
3. **R2(b), instead of (a):** First run the `ETH_CONFLUENCE:false` replay over the 3-month window, then decide whether to switch overnight confluence off entirely (with the regen, uniform-live-revalue and integrity-check sequence)?
4. **R3:** Add a scheduled-news entry blackout (08:25-08:40, 09:55-10:05 and 13:55-14:30 ET on release days), applied to orders now and replay-tested before it touches engine records?
5. **R4:** Run a shadow walk-forward test of `ETH_MIN_AGREEING_FACTS = 3`, or the fractal-breakout two-fact veto, on 1m/5m overnight fires?
6. **R5:** Record an hour-scaled overnight stop as a shadow exit next to the shipped bracket?
7. **R6:** Before any overnight trading resumes, confirm your Apex plan type (EOD, Intraday or Legacy) in RTrader and set a $250 per night overnight loss cap at 1 micro?
8. Record the conclusion in `LEARNINGS.md`? The rule: "the overnight loss lives in entry selection, not the bracket; the 09:29 flat is measured worse; overnight hour profiles are regime-unstable."

---

### Sources and working files

- **Internal tables (37 CSVs plus summary.json):** `C:\BaxterSandbox\analysis\eth-research\internal\`
- **Research notes:** `C:\BaxterSandbox\analysis\eth-research\` (academic, practitioner, risk and prop-firm notes, plus the fact-check files `factcheck-academic-*.md`)
- **Companion exit Monte Carlo:** `docs/exit-monte-carlo-2026-10-01.md`
- **Read access:** the database was read only. No project file other than this one was written.
