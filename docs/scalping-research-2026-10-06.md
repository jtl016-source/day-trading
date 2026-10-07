# Scalping research: 3–5 point targets "every few candles" (2026-10-06)

The question: can small trades (3–5 pt targets, a new trade every few candles) add up to real P&L on MES, hand-traded on the Apex 25K evaluation?

This is research only. Nothing was shipped. No engine setting, live server, or trade setting was changed. The database was opened read-only for every measurement.

---

## 1. Verdict

**Not on the evidence we have. Small targets traded often make the losses bigger, not the profits.**

On your own MES 1m bars, a 3–5 pt bracket only pays if the entry wins **8–19 percentage points more often than a random entry** with the same bracket. That figure assumes the project's 1.0 pt round-trip cost and realistic fills.

I tested 19 scalp entry variants on the last three months of your data. None clears that bar. That includes:
- your own engine's fires
- yellow-box level fades
- VWAP band fades
- opening-range breakouts
- vector pullbacks
- the earlier dead-tape range scalp

The best of them, the yellow-box edge fade, does pick direction better than a coin flip. But that skill is worth about +0.5 pt per trade gross, and costs are 0.7–1.0 pt, so it still nets −0.4 to −0.6 pt per trade.

Trading more often just multiplies that negative number. With no real edge, a trade every few candles loses **19–79 pts per day per contract**.

The published record agrees. No ES/MES scalping system with costs and out-of-sample results clears the bar. Every edge that does survive, in the literature or in this project, is multi-point and low-frequency.

Two ideas are worth a **record-only** shadow test, with no orders:
- **(a) A 30-minute opening-range breakout.** It trades about once a day and is the only family with any positive cells.
- **(b) A yellow-box edge fade entered with a resting limit order.** The point is to test whether cheaper fills turn its small real skill positive.

A third idea, footprint confirmation, **cannot be tested until the footprint feed is fixed** (see section 9).

---

## 2. What was measured

- **Data:** your MES 1m bars, `data/app.db`, opened read-only.
  - Windows: 2026-06-24 → 10-01 for the bracket grid on engine fires; 2026-07-06 → 10-05/06 for the random baseline and the strategy simulations.
  - The 2026-09-14 Sep→Dec roll jump (+67 pts at 11:31 ET) was cut out.
- **Brackets:** TP 2–6 × SL 3–12, plus the 4/23 reference cell. All flat by 16:55 ET.
- **Three fill rules:**
  - **Optimistic:** a touch of the target fills it.
  - **Standard:** a touch fills it, but a bar that hits both TP and SL counts as a loss.
  - **Pessimistic:** the target must trade 1 tick *through* to fill, and the stop fills 1 tick worse.
- **Which fill rule is closest to the truth:**
  - The Rithmic MESZ6 tick files were partly decoded: 979,105 trades from Sep 18 – Oct 5. They show that a resting limit sitting exactly at a swing extreme fills only about **53–62 %** of the time.
  - So the truth sits **between standard and pessimistic**.
  - The gap between optimistic and pessimistic is 0.25–0.30 pt per trade, which is $1.25–1.50 per micro per trade.
- **Random-entry null:** enter at every 1m bar, long and short, with the same bracket. It behaves like a coin flip: P(TP first) ≈ SL/(TP+SL), gross ≈ 0, net ≈ −friction. This held in every session and in both halves of the window.
- **Sanity check:** my bar walk reproduces the engine's own recorded outcome on 886 of 887 fires.

Scripts and outputs are in `C:\BaxterSandbox\analysis\scalping\`:
- `sim-brackets\RESULTS.md`
- `sim-entries\README.md`
- `first-passage.md`
- `rules-costs-sources.md`
- `refute\`

The strategy simulator is `scripts/analysis/scalp-sim-entries.ts` (run with `npx tsx scripts/analysis/scalp-sim-entries.ts`, about 10 s).

---

## 3. Friction math

### 3.1 What one round trip costs on MES ($5/pt, tick 0.25 = $1.25)

| Component | Amount | In points |
|---|---|---|
| Apex Rithmic commission (Apex help center, read 2026-10-06) | $0.51/side = **$1.02 RT** | 0.20 |
| CME exchange + NFA fees, if charged on top (Apex's page does not say) | ~$0.35 + $0.01 per side ≈ $0.72 RT | 0.14 |
| Topstep / Bulenox all-in (for comparison) | $1.22 RT | 0.24 |
| Slippage, RTH, market or stop order | 0–1 tick **per order** (broker guidance; no MES-by-hour measurement exists) | 0–0.25 per order |
| Slippage, overnight / open / news | 2–5 ticks per order (same guidance) | 0.5–1.25 per order |

**Per round-trip scenarios used below:**
- **0.7 pt:** Apex commission plus 1 tick each side. This is a good RTH fill day.
- **1.0 pt:** the project standard. It is mildly conservative for RTH.
- **1.5 pt:** the stress case for the 9:30 open, news, and any overnight trade.

In dollars per micro, that is $3.50 / $5.00 / $7.50 per round trip, against a $15 gross win on a 3-pt target.

### 3.2 Friction as a share of the target

| Target | at 0.7 pt | at 1.0 pt | at 1.5 pt |
|---|---|---|---|
| 3 pt | 23 % | 33 % | 50 % |
| 4 pt | 18 % | 25 % | 38 % |
| 5 pt | 14 % | 20 % | 30 % |
| 10–13 pt (your current book) | 5–7 % | 8–10 % | 12–15 % |

### 3.3 Break-even win rate compared with what random entries already get

- **Break-even win rate** = (SL + friction) / (TP + SL).
- **Random win %** is measured on your RTH 1m bars, long and short averaged. Standard and pessimistic fills are shown separately.
- **Gap** is how many win-rate points an entry must add over random just to break even at 1.0 pt.

| TP / SL | Random win (std / pess) | Break-even @0.7 | @1.0 | @1.5 | Gap @1.0 (std / pess) |
|---|---|---|---|---|---|
| 3 / 3 | 49.3 / 47.3 % | 61.7 % | 66.7 % | 75.0 % | +17.4 / +19.4 |
| 3 / 5 | 62.4 / 60.5 % | 71.2 % | 75.0 % | 81.2 % | +12.6 / +14.5 |
| 3 / 8 | 72.8 / 71.1 % | 79.1 % | 81.8 % | 86.4 % | +9.0 / +10.7 |
| 3 / 10 | 76.6 / 75.1 % | 82.3 % | 84.6 % | 88.5 % | +8.0 / +9.5 |
| 4 / 4 | 49.5 / 47.9 % | 58.8 % | 62.5 % | 68.8 % | +13.0 / +14.6 |
| 4 / 6 | 59.7 / 58.1 % | 67.0 % | 70.0 % | 75.0 % | +10.3 / +11.9 |
| 4 / 8 | 66.2 / 64.8 % | 72.5 % | 75.0 % | 79.2 % | +8.8 / +10.2 |
| 5 / 5 | 49.4 / 48.1 % | 57.0 % | 60.0 % | 65.0 % | +10.6 / +11.9 |
| 5 / 8 | 60.8 / 59.5 % | 66.9 % | 69.2 % | 73.1 % | +8.4 / +9.7 |
| 5 / 10 | 65.4 / 64.2 % | 71.3 % | 73.3 % | 76.7 % | +7.9 / +9.1 |
| 6 / 8 | 55.9 / 54.9 % | 62.1 % | 64.3 % | 67.9 % | +8.4 / +9.4 |
| 6 / 12 | 64.1 / 63.0 % | 70.6 % | 72.2 % | 75.0 % | +8.1 / +9.2 |
| 4 / 23 (the banned cell) | 80.5 / 79.4 % | 87.8 % | 88.9 % | 90.7 % | +8.4 / +9.5 |

How to read the table:
- **High win rates come from the bracket shape, not from skill.** A 3/10 bracket wins 77 % of the time on random entries. That is why "I win most of my scalps" proves nothing by itself.
- **Each extra win-rate point is worth (TP + SL)/100 pts per trade.** At 4/6 that is 0.10 pt. Closing a 10-point gap means finding about +1.0 pt of gross edge per trade, which is the entire friction.
- **Random entries lose about the friction on every trade**, in every cell: −0.94 to −1.07 pt at standard fills and −1.18 to −1.31 at pessimistic fills, at 1.0 pt friction.
- **Same-bar ambiguity is not the problem on 1m bars.** It affects 0.1–2.4 % of trades. On 5m bars it is 1–11 %, so never score a sub-6-pt bracket on 5m bars.

### 3.4 Why "more often" does not help

These are random-direction trades taken back to back in RTH, standard fills, 1.0 pt friction, averaged over 40 random seeds:

| Bracket | Trades/day | Net pts/day per contract | $/day at 1 MES |
|---|---|---|---|
| 3 / 3 | 74 | −77 ± 3 | −$385 |
| 3 / 5 | 55 | −55 ± 3 | −$272 |
| 5 / 5 | 38 | −38 ± 4 | −$192 |
| 5 / 10 | 22 | −19 ± 5 | −$97 |

Frequency multiplies the per-trade number. A negative per-trade edge becomes a larger negative daily total.

Even the engine's own fires, taken one at a time with small brackets, lose: 5.8–9.9 trades/day and −$31 to −$65/day at 1 micro.

**How small the edge would need to be, and why that is still out of reach:**
- To pass the 25K evaluation in 30 trading days at 4 micros you need only about **2.5 pts/day per contract**. At 10 trades/day that is +0.25 pt per trade.
- That sounds tiny. But every measured scalp is between −0.4 and −1.4 pt per trade, a 0.65–1.65 pt shortfall.

**And the $500 daily loss limit bites even at break-even.** A 4/6 scalp at exactly break-even (70 % win), with independent trades:

| Size | Trades/day | Days the DLL is hit |
|---|---|---|
| 4 micros | 10 | 8 % |
| 4 micros | 20 | 20 % |
| 2 micros | 20 | 2 % |

At 1 micro the DLL is effectively out of reach, but so is the profit target. Real losing streaks cluster, so these figures are a floor.

---

## 4. Strategies ranked (best to worst)

"Own data" means your MES 1m bars, **pessimistic fills, 1.0 pt friction**, unless marked otherwise.
- **H1 / H2** are the first and second halves of the window.
- **"t vs null"** compares the strategy against random entries taken at the same hours.

| # | Strategy | Trades/day | Own data (pessimistic, F 1.0) | Verdict |
|---|---|---|---|---|
| 1 | **Opening-range breakout, 30 min** (first 1m close beyond the 9:30–10:00 range, each side at most once, until 12:00) | 1.1 | 4/6: 68.5 % win, −0.15/trade (H1 −0.89, H2 +0.57). Best cell 5/8: +0.44 (H1 −0.69, H2 +1.54). n = 73, t = 0.92. 8 of 15 standard cells positive, all positive only in H2. | **Not an edge yet. Shadow it** (cheap, 1/day). Outside evidence for the ORB family is the best of any small-target idea: Edgeful ES 5m ORB, 115 trades, 72 % win, PF 1.62, but filtered and costs not stated. |
| 2 | **Yellow-box edge fade** (wick through the box top/bottom, close back inside) | RTH 4.2 / all 9.5 | RTH 4/6: 64.4 % win, −0.55 (H1 −0.53, H2 −0.57). Best RTH cell 5/6: −0.38. Beats a coin-flip direction by 0.5–0.66 pt/trade (t vs null 1.6–3.0): **real skill**, but gross is only +0.5–0.63 against 0.7–1.0 costs. Entering 1 bar (~60 s) late → −1.05. | **Real but too small. Shadow it only as a limit-entry cost test** (section 7). Do not trade it by hand at market. |
| 3 | **Footprint stacked-imbalance confirmation** | ~1.2 | **Cannot be tested.** The footprint table has been one-sided since 2026-07-02 (askVol = 0). On the 75 trades from two-sided days, 4/6 was +0.07, which is too small to judge. | **Fix the feed first**, then shadow it as confirmation at your existing levels. Online claims of 75–85 % win rates come with no backtests. Academic order-flow results explain price moves *in the same second* (Cont et al. 2014; Takahashi 2025 on ES at 1 s) and say nothing about a 1–5 min read. |
| 4 | VWAP 1σ band fade (RTH VWAP) | 9.4–9.8 | 4/6: −0.82 / −0.75. Best cell 5/8: −0.38 to −0.39. Some direction skill (+0.2–0.5 over coin flip). | Reject. The only 10-year band-fade backtest found (DAX 15m) ran PF 0.64. |
| 5 | Yellow-box break-and-retest | 3.4–7.1 | RTH edges 4/6: −0.71. Four-level version, best cell 4/8: −0.66. | Reject. |
| 6 | **Your engine's own fires with small brackets** (880 ungated / 607 gated) | 5.8–9.9 | 0 of 3,888 rows net positive. Best: gated RTH 6/12 −0.24 standard / −0.43 pessimistic. Gated 5m 4/6: −0.49 pessimistic. **Win rates equal random** (largest z across 648 tests = 2.34, and it is negative). | Reject. The signals carry no small-target information. |
| 7 | Dead-tape range scalp (project test, 2026-08-12) | ~5 | Original: −0.71 net. Re-checked today: realistic fills make **gross** −0.16 to −0.36. Out-of-sample 08-13 → 10-06: gross −0.32 to −1.12 in every cell. Its targets were really about 12 pts, and 86 % of trades were overnight. | Reject (confirmed). "Edge exists gross" was too generous. |
| 8 | 4-pt TP / 23-pt SL | — | On the 3-month fires: 83.8 % win vs 83.9 % random, net −1.08 / −0.91. In the old standing window: +0.83 at touch fills, +0.44 with realistic fills (≈ $2.17/contract). That window was not distinguishable from best-of-120 luck (p = 0.09), 73 % of its profit came from 3 days, and its RTH-only subset was −1.11. | **Your ban stands.** It is also the shape Apex's rules call unacceptable (section 5). |
| 9 | Micro-structure exits (1m/5m fractal trails, ATR trail, PFE) | — | Every variant net-negative under both fill rules, on your fires and on random entries alike. Statistically the same as fixed exits. | Reject. |
| 10 | Vector pullback (close near a rising/falling `Highest(Lowest(low,20),20)`) | 4–17 | 4/6: −1.02 to −1.39. No skill: t vs null −0.48 to +0.64. | Reject. |
| 11 | VWAP 2σ fade | 5–10 | −0.91 to −1.30. No skill. | Reject. |
| 12 | Opening-range breakout, 15 min | 1.3 | −1.58 (trading the opposite direction did better). | Reject. |
| 13 | First pullback after the open | 1.0 | D5: −1.92 standard. D8: −1.15. The opposite direction is better. | Reject. |
| 14 | No signal, just "every few candles" | 22–74 | −19 to −79 pts/day per contract. | Reject. |

**Outside ideas with no usable evidence for a 3–5 pt scalp:**
- **Value-area "80 % rule":** measures about 62 % and sets up only a handful of times a year.
- **Round-number fades:** the statistics come from 1990s FX dealer data, not ES.
- **Prior-day high/low and gap statistics:** these predict where the *day* closes. They come from vendor scripts, and the one gap-fade test found had t = 1.8.
- **A 2026 walk-forward study of 14 intraday signal families on MNQ:** none cleared costs. The only survivors were low-frequency, multi-point edges (+4 and +11.8 pts net).
- **A 2014 ES 1m scalper:** 76 % win, PF 1.24, in-sample only, no slippage.
- **Vendor automated ES systems:** the more often they traded, the lower their profit factor.

**Base rates for frequent retail day trading:**
- Brazil, index futures: 97 % of those who persisted 300+ days lost money.
- Taiwan: fewer than 1 % predictably beat fees.
- Topstep 2025: 16.8 % of Combines passed, 33 % of funded traders got any payout, and 0.71 % reached live capital.

---

## 5. Prop-firm rules and costs that bind

Apex pages were read directly on 2026-10-06 through the browser, because the site blocks fetchers.

**Apex 25K EOD evaluation (your account)**
- **Limits:**
  - $1,500 profit target.
  - $1,000 end-of-day trailing drawdown, recalculated at 4:59:59 PM ET.
  - **$500 daily loss limit.** It counts open losses, liquidates at market, and pauses trading until 6 PM ET. That is 100 pts at 1 MES, 25 pts at 4.
  - 4 contracts maximum.
  - No consistency rule during the evaluation.
- **Must be flat by the close.** Holding through it is a prohibited activity.
- **No minimum hold time** appears anywhere on Apex's pages.
- **Banned:**
  - High-frequency trading.
  - "Non-directional bracket trading" (orders resting on both sides).
  - Hedging.
  - **Any automation or algorithm.** Every scalp must be placed by hand. That adds reaction delay, and a one-bar delay alone erased most of the yellow-box fade's skill.
- **"Small profit targets while risking disproportionately large amounts are not allowed."** Apex's example is a 5-tick target with a 150-tick stop.
  - 4/23 is 16 ticks vs 92 (5.75:1).
  - A 3-pt target on your usual ~25-pt stop is 12 vs 100 (8:1).
  - **The stop has to shrink with the target.**
- **The Performance Account (after passing):**
  - 1 contract until +$1,000 profit, then 2.
  - 50 % consistency rule at payout.
  - 5 days of at least $100 per payout.
  - At most 6 payouts of $1,000 on a 25K.
  - At 1 MES a 3-pt scalp nets about $14.
- **Unverified:** "orders must carry a stop and a target since March 2026" appears only on third-party sites, and Apex's own page says "pending or mental stop losses". Check this in RTrader.

**Other firms, for reference.** Minute-scale scalping is legal at all of them.
- **Topstep:** MES $1.22 RT all-in. No current hold-time rule; the 2021 "50 % of winners ≥ 20 s" rule is absent from today's pages. Bans SIM-fill-exploiting algorithms and "hundreds of rapid trades".
- **Lucid:** flags an account only if more than 50 % of profit comes from trades held ≤ 5 s.
- **Tradeify (funded accounts):** more than 50 % of trades and of profit must come from holds over 10 s.
- **Bulenox:** MES $1.22 RT all-in, 40 % consistency rule. Its terms ban "scalping algorithms".

**Bottom line on rules:** the rulebooks allow it. The economics, the hand-placement requirement, and Apex's DLL / 1-contract PA / payout cap are what limit it.

---

## 6. What doing this properly would take

1. **Timestamped tick data with bid/ask.**
   - The MotiveWave Rithmic `.tick_data` files already hold price, size, aggressor, and bid/ask in 45-byte records. Only the two 8-byte time fields are still undecoded.
   - Decode them, or record ticks with wall-clock time going forward. Without timestamps you cannot tell whether a limit at the target filled, or what a stop really cost.
2. **A queue-aware fill model.**
   - A limit at the target fills only when the price trades through it, or when enough volume trades at that price to clear the queue ahead of you.
   - Bars cannot show this. The tick proxy says about 55–60 % of exact touches fill.
3. **A working footprint feed.** `footprint_candles` must record both bid and ask volume again (section 9) before any order-flow idea can be tested, including the engine's own footprint facts.
4. **Measured hand execution.**
   - Log your real fills for at least 50 SIM trades: alert time, order time, fill price vs the signal price, and stop slippage.
   - A one-bar delay already erased most of the only real skill found. If your median delay is more than a few seconds, scalps at market are out.
5. **Lower costs on entry**, meaning resting limit entries instead of market orders.
   - This is the only lever that moves friction materially: it saves about 0.25–0.5 pt.
   - The catch is adverse selection. Limits fill most reliably on the trades that keep going against you. Only tick data can measure the net effect.
6. **A real sample and honest statistics.**
   - At least 300 out-of-sample trades.
   - Pessimistic fills.
   - Positive in both halves.
   - Beats a random entry at the same hours.
   - Not carried by its best 3 days.
   - Corrected for the number of ideas tried.

---

## 7. Shadow-test plan (record only, no orders)

**How it runs:**
- A nightly sandbox script reads the 1m bars, and the tick files once timestamps are decoded, read-only.
- It writes one row per hypothetical trade: entry, fill under each fill rule, outcome, and minutes held.
- No engine change, no live-server change, no orders, and the AutoTrader is not involved.
- Brackets are fixed now, before any results are seen.
- The **decision cell is TP 6 / SL 8**, which respects your 6-pt TP floor. 4/6 and 5/8 are recorded for learning only.

| ID | Candidate | Rules | Decision cell | Expected sample |
|---|---|---|---|---|
| S1 | ORB-30 breakout | RTH only. Range = 9:30–10:00 ET high/low. Enter on the first 1m close beyond it, each side at most once per day, entries until 12:00. Flat 16:55. | 6/8, entry at the next bar's open + 1 tick | ~1.1/day → n = 100 in ~90 sessions, n = 300 in ~13 months |
| S2 | Yellow-box edge fade, limit entry | RTH only. A resting limit at the box edge in the fade direction, placed only when price is within 2 pts of the edge. A fill needs a 1-tick trade-through on tick data. The bar-close version is recorded alongside for comparison. | 6/8 | ~4/day → n = 300 in ~75 sessions |
| S3 | Footprint confirmation at existing levels | **Blocked** until the footprint feed is fixed and shows 20 straight sessions of two-sided data. Then: a stacked imbalance (≥ 3 levels) in the trade's direction within 1 pt of a yellow-box edge or the vector. | 6/8 | Unknown |

**Kill rule:** at n ≥ 100, if net per trade (pessimistic fills, 1.0 pt) is below −0.3, stop that candidate.

**Promotion bar.** All of these must hold before even SIM hand-trading:
- n ≥ 300.
- Net ≥ +0.3 pt per trade at pessimistic fills and 1.0 pt friction.
- Positive in both halves.
- Beats an hour-matched random entry at p < 0.05 / 3 (three candidates tested).
- Still positive with its best 3 days removed.
- A block-bootstrap Apex check at the intended size: fewer than 5 % of days hit the $500 DLL, and an acceptable chance of hitting the trailing drawdown before the target.

**After that, and before any money:**
- 50+ SIM trades placed by hand, with measured slippage of at most 1 tick per order on the median.
- Only then a decision from you.

---

## 8. Do not

- **Do not** take 3–5 pt targets at market every few candles. At any measured win rate this loses 19–79 pts/day per contract.
- **Do not** read a high win rate as edge. 3/10 wins 77 % and 4/23 wins 80 % on random entries.
- **Do not** revive the 4-pt / 23-pt cell. Your ban was right, and the shape matches Apex's prohibited example.
- **Do not** pair a small target with your normal ~25-pt stop. Shrink the stop with the target, or don't trade the bracket.
- **Do not** score any sub-6-pt bracket on 5m bars, or let target touches count as fills, when deciding anything.
- **Do not** route scalps, or any order, through the AutoTrader on an Apex account. Apex bans automation.
  - The project notes from 2026-10-01 record the AutoTrader as **armed** on the account.
  - That is your call to make, but it reverses your own 2026-09-24 decision. Please check it in the app.
- **Do not** scalp the 9:30 open, news minutes, or overnight on the 1.0 pt assumption. Fills there cost 1.5 pt or more, and the overnight loss would come out of the next RTH day's DLL.
- **Do not** size up to make a small edge "matter". At 4 micros, a break-even scalp hits the $500 DLL on 8–20 % of days.
- **Do not** trust footprint-based signals or the engine's footprint facts until the feed records both sides again.
- **Do not** cite the corrected figures in section 10 in their old form.

---

## 9. Data defects found during this research (outside the scalping question)

1. **The footprint feed is one-sided (high priority).**
   - Since 2026-07-02, 5,705 of 6,243 rows in `footprint_candles` (MES 5m) have askVol = 0. Every contract is being classed as a sell.
   - Since then every stacked imbalance is a SELL stack: 4,539 sell vs 0 buy. Every engine fire carrying a footprint fact since July is Short (37 of 37).
   - The engine's footprint input is effectively broken. The relay needs to be checked.
2. **A bad opening print** at 2026-09-24 13:29 ET: open 7781 against a previous close of 7766 / close 7766.25. It is still in the 1m store; the simulations patched it locally.
3. **The 2026-09-14 roll seam** (+67.25 pts at 11:31 ET) is still in the continuous series, as previously documented. Any analysis window that includes that day must cut it out.

---

## 10. Corrections to earlier project findings

These came from independent re-checks this round. They should go into LEARNINGS.md; this round was limited to writing this one file.

- **"29.3 % of losses came within 1 tick of TP1" (2026-08-12 exit-sim suite) is a script artifact.**
  - The favorable-excursion array kept filling for up to 480 minutes *after* the stop was hit.
  - Measured before the stop, it is **4.3 %** (4 of 92 losses).
  - Correctly measured, target-fill risk at 3–5 pt targets on those trades is about 1–4 % of wins: second-order. The first-order problem is friction share.
- **The "realistic stop slip −0.06 / −0.12" figures are arithmetic, not measurements**: loss rate × assumed slip.
- **The "−0.78 worst case" was mostly the retired TP2 convention.** Under the TP1-only policy the same mechanism costs −0.15 (target needs a trade-through) and −0.27 (plus 0.5 pt stop slip).
- **`commissionPerSideUsd 1.24`** in `scripts/fact-engine-backtest.ts` is applied per side ($2.48 RT), about twice every published all-in round trip.
  - So the flat 1.0 pt is roughly 0.5 commission + 0.5 slippage, versus a realistic ~0.2–0.35 commission + 0.25–0.5 RTH slippage.
  - It is mildly conservative in RTH, and **not** conservative at the open, around news, or overnight.
- **Micro-structure exits:** "every variant underperformed its baseline" is wrong in the details.
  - 7 of 23 beat their baseline by ≤ 0.17 pt, which is inside the noise.
  - 1m trails held 3–13 min (not 3–7) and won 32.5–51.4 % (not 32–48 %).
  - The conclusion stands: they do not help.
- **The 4/23 era-split figures (+0.87, +0.47 / $2.35) exist in no saved artifact.** An independent recompute gives +0.83 and +0.44 ($2.17/contract).
- **A "lag-1 autocorrelation ≈ −0.35" figure seen in research summaries is unsourced. Do not cite it.**
- **Order-flow imbalance studies (Cont–Kukanov–Stoikov) measure a same-interval relationship, not prediction.** On ES, order-flow impact fades within about a second.

---

## 11. Key sources

**Your data and analysis** (`C:\BaxterSandbox\analysis\scalping\`):
- `first-passage.md`
- `sim-brackets\RESULTS.md`, `grid_null.csv`, `grid_fires.csv`, `day_level.csv`, `tick_fill_proxy.json`
- `sim-entries\README.md`, `grid.csv`
- `refute\` (independent re-checks)
- `rules-costs-sources.md`

**Project history:** LEARNINGS.md
- 2026-08-12 range scalp
- 2026-08-13 TP1 grid and exit lab
- 2026-10-01 entries

**Apex** (help center, read 2026-10-06):
- `/help-center/rithmic/rithmic-commissions-instruments/`
- `/help-center/getting-started/prohibited-activities/`
- `/help-center/eod-trailing-drawdown-accounts/eod-evaluations/`
- `/help-center/additional-helpful-items/daily-loss-limit-explained/`
- `/help-center/eod-trailing-drawdown-accounts/eod-payouts/`
- `/help-center/additional-helpful-items/50-consistency-requirement/`

**Other firms:**
- Topstep help articles 8284213, 10305426, 8284208
- Lucid support 11404742
- Tradeify guidelines 10468318
- Bulenox FAQ, Terms of Use, and rate sheet (2026-08-11)

**Academic and evidence:**
- Cont, Kukanov & Stoikov 2014 (arXiv 1011.6402)
- Takahashi 2025 (arXiv 2508.06788)
- Chordia, Roll & Subrahmanyam 2005
- Grant, Wolf & Yu 2005
- Mesfin 2026 (arXiv 2605.04004)
- Chague, De-Losso & Giovannetti 2019
- Barber, Lee, Liu & Odean 2014
- Barber & Odean 2000

**Published backtests and claims:**
- Backtrex DAX VWAP band fade (2026-10-02)
- Edgeful ES 5m ORB (2026-04-18)
- marketcalls 2014 ES scalper
- Automated Trading Strategies ES (2021)
- Brooks Trading Course rules for scalping
- futureshive footprint guide (claims only)
