# Overnight (ETH) changes and replay results, 2026-10-01

For: the owner. Covers the five items you approved ("yes to 1,2,3,4,5"), what the server does differently now, what you need to do, and what the replays found.

Your five yeses map to the approval list in `docs/eth-trading-research-2026-10-01.md` section 6:
1 = R1 (RTH-only orders), 2 = R2(a) (mute overnight alerts, keep scoring), 3 = R2(b) (run the `ETH_CONFLUENCE:false` replay first), 4 = R3 (news blackout), 5 = R4 (shadow test of two overnight entry rules).
Items 6 (R5 hour-scaled shadow stop), 7 (R6 plan-type check + overnight cap) and 8 were not answered.

---

## 0. Status right now (read at 16:06 ET, GET requests only)

- **The restart has already happened.** The server log shows a reboot at about 3:52 PM ET, which came back disarmed, and a settings save at 3:54:16 PM that re-armed it. So the new code is live now. Nothing below is still waiting for a restart.
- Auto-trade: **armed**, 2 contracts, intervals **5m and 60m only**. 15m was removed by a settings save at 2:36:47 PM. Order window 09:30-15:15 ET.
- **Every order is currently paused by the Apex guard.** The guard has recorded -$970 realized since today, and its budget is $500 (headroom $1,000 - margin $500). It stays paused until you act (see section 2). It does not clear by itself overnight.
- Overnight alerts muted (`ethAlertsEnabled:false`), news blackout on (`newsBlackoutEnabled:true`), news calendar healthy, covering through 2026-12-31.

---

## 1. What changed at the restart, per approved item

**R1, RTH-only orders (item 1).**
The auto-trader and the manual "execute" route only place orders between 09:30 and 15:15 ET. That window was already saved in your settings; the code default now matches, so a fresh install gets the same. Overnight fires are still computed, recorded and scored. They just never become orders.
Also new: if 3 order errors happen within 10 minutes, auto-trade disarms itself.

**R2(a), overnight alerts muted (item 2).**
A fire whose bar closes outside RTH no longer sends Discord, a desktop notification or a sound. The server refuses to forward it to Discord even if an old browser tab asks. The browser half needs a page reload to pick up the new code. Signals rows show an "overnight" or "news" tag on fires that were muted. Overnight fires are still in the Signals tab and still in the stats.
The switch is "Overnight alerts" in the Account guard & alerts panel.

**R2(b), the `ETH_CONFLUENCE:false` replay (item 3).**
This was a replay only. Nothing live changed. Results are in section 3. My recommendation is not to switch overnight confluence off; R2(a) already gives you the useful part.

**R3, news blackout (item 4).**
On scheduled release days, no order is placed in these windows: 08:25-08:40, 09:55-10:05, and 13:55-14:30 (FOMC days only). Alerts are muted in the same windows. Inside your 09:30-15:15 order window, only the 10:00 and FOMC windows can block anything. The dates come from `data/news-calendar.json`: 29 official-source events from Oct 2026 to Jan 2027. Every tier-1 date was checked against BLS, BEA and the Fed, with 0 mismatches.
The engine's recorded fires are NOT changed by the blackout. It is an order-and-alert rule only.
If the calendar file goes missing or breaks, the blackout fails open (orders allowed). The morning digest has a "News calendar:" line and warns 14 days before coverage ends.

**R4, overnight entry rules shadow-tested (item 5).**
Two new engine settings exist: `ETH_MIN_AGREEING_FACTS` (overnight fires need N agreeing facts) and `ETH_VETO_FRACTAL_TWO_FACT` (drop overnight 1m/5m fires that are only a fractal plus one other family). There is also an engine-level news-blackout input for replays. All three are **off by default**, and no live caller turns them on, so the live fire set is byte-identical to before (pinned by a golden test). They failed the walk-forward test (section 3), so they stay off.

**Also live now, not one of your five yeses. Please confirm or reject these.**
- **Apex guard reset for the 25K account.** The guard used your old 50K-era $2,500 headroom. It now uses $1,000 headroom and $500 margin, so orders pause after $500 of drawdown is used. It also has an account-level tracker that does not reset each morning, because Apex's threshold doesn't reset either. This is what is pausing orders now.
- **Shadow exits.** A record-only table (`signal_shadow_exits`) scores 6 alternative exits next to the real one, including the item-6 hour-scaled overnight stop. It places no orders and does not change signal_history. The code calls it "user-approved R5", but you did not answer item 6. Say if you want it removed.

---

## 2. What you need to do

1. **Decide whether the auto-trader should be armed on Apex at all.** This is the biggest item. Apex's rules ban automated trading. On 2026-09-24 you decided the AutoTrader stays disarmed on Apex and you trade by hand. Today it is armed on the Apex account. If Apex flags it, the account can be closed regardless of P&L. If you are keeping it armed, do so knowingly. If not, disarm it in the Auto Trade panel.
2. **Check RTrader before touching the guard.** Look at the plan type (EOD, Intraday or Legacy) and the real distance to the drawdown threshold.
   - **Do NOT set the guard headroom to $1,500.** $1,500 is your profit target, not your drawdown. Current Apex 25K plans fail you at a $1,000 trailing drawdown. A $1,500 headroom with $500 margin would pause orders at exactly the point the account is already failed. Set headroom to the distance RTrader shows; on a fresh 25K that is $1,000, which is already set. Use $1,500 only if RTrader shows a legacy $1,500 threshold.
   - **About the -$970:** if those losses were on the OLD account you switched away from, press **Reset guard tracker** and orders resume. If they were on the NEW 25K, the account is about $30 from failing. In that case, leave the guard paused and do not reset it.
   - If RTrader says EOD plan, set "Daily pause $" to about 300 (the plan's own daily loss limit is $500).
3. **Confirm the 15m removal** at 2:36:47 PM was you. If it wasn't, re-add 15m in the Auto Trade panel. Section 3 shows 15m is not where the edge is.
4. **Reload the browser tab** (and the phone app) so the client-side alert mute and the new panel load.
5. **Where to look:**
   - Market page settings, panel **"Account guard & alerts"**: headroom, margin, daily pause, account tracker, Reset guard tracker, Overnight alerts, News blackout.
   - Signals tab: overnight/news tags on muted rows.
   - Morning digest: "News calendar:" and "Apex guard:" lines.
   - `GET /api/news/blackouts`: today's windows.
   - `GET /api/trade/actives`: the guard state.
6. **Restarts from now on:** use the Desktop "Start Trading Server" shortcut. Any code change only takes effect after that, and every restart comes back disarmed by design.
7. **In December**, refresh the news calendar for January 2027 using the README procedure (`docs/news-calendar-README.md`). Right now January only has the Jan 27 FOMC. The digest starts warning on Dec 17, and a test goes red on Jan 1.

---

## 3. Replay answers

All replays are full engine runs with the shipped gate and exits, walked on real 1m bars, over the last 3 months (from 2026-06-24). The base replay reproduced the stored gated book 611/611 with 0 outcome differences. NET is after 1 pt friction. Outputs are in `C:\BaxterSandbox\analysis\eth-build\replays\`.

### 3.1 `ETH_CONFLUENCE:false` (overnight = side-entries only)

| | fires | win % | NET/trade | PF | total NET | H1 / H2 |
|---|---|---|---|---|---|---|
| Whole book, current | 614 | 71.7 | -1.02 | 0.86 | -627 | -281 / -346 |
| Whole book, ETH off | 419 | 70.6 | -0.26 | 0.97 | -107 | -140 / +33 |
| Overnight only, current | 454 | 71.6 | -1.39 | 0.81 | -632 | -43 / -590 |
| Overnight only, side-entries | 249 | 70.3 | -0.50 | 0.94 | -125 | +105 / -230 |

- Overnight 5m and 60m fires disappear entirely. What remains is a 1m/15m vector side-entry sleeve. 294 fires are removed, worth -669, and 99 replacement fires appear, worth -134.
- **Verdict:** this cuts about 80% of the overnight bleed in the records, but what's left is still losing (-0.50/trade, and -1.91/trade in H2). It is not tradeable. Since R1 already keeps overnight fires out of orders, switching it off only cleans up the records. That would cost a full regen, revalue and integrity-check cycle. **Recommendation: keep R2(a), do not switch `ETH_CONFLUENCE` off.**

### 3.2 Shadow rules, walk-forward

Method: pick on H1, score on H2, per interval. Ship only if H2 NET is positive and not carried by 3 or fewer days.

| Interval | base | min3 | veto | both |
|---|---|---|---|---|
| 1m | -98 → -197 | -105 → -206 | -99 → -88 | -113 → -91 |
| 5m | -225 → +2.6 | -156 → +63 | -161 → -9 | -150 → -2.6 (picked on H1) |
| 15m | +25.7 → -109 | +25.7 → -101 | = base | = min3 |
| 60m | +15.9 → -42 | -0.4 → +78 | = base | = min3 |

(Each cell is H1 NET → H2 NET, carry mode, all fires. Apex mode gives the same verdicts. The veto only acts on 1m/5m, so at 15m/60m "veto" equals base and "both" equals min3.)

- **`ETH_MIN_AGREEING_FACTS=3`: NO SHIP.** H1 shows nothing. The H2 gains at 5m (+60) and 60m (+119) come from 3 or fewer days: without the top 3 days they are -14.8 and -3.9. The one delta that survives that check (60m overnight-only, +10.2) has n=20, and it is still -33 without the top 3 days.
- **Fractal two-fact veto: NO SHIP.** It does remove exactly the worst overnight combos, and every removed group lost money: 1m Fr+Vec 88 fires -110, 1m Fr+YB 51 fires -77, 5m Fr+YB 56 fires -25. But 91 replacement fires appear, H1 shows no improvement, and the +109 at 1m in H2 becomes -43 without its top 3 days.
- **Both together: NO SHIP.** The only interval where H1 picked it (5m) is negative in H2 (-2.6).
- **Verdict:** defaults stay (`ETH_MIN_AGREEING_FACTS` 2, veto off). If you ever choose to act on combo evidence instead of this bar, the veto is the better of the two.

### 3.3 News blackout P&L

| | fires removed | NET of removed fires | book delta |
|---|---|---|---|
| Whole book (615 gated fires) | 7 (1m 4, 5m 1, 15m 2, 60m 0) | 08:30 windows: 3 fires, -35.75; 10:00 windows: 4 fires, +31.16 | +4.6 |
| Inside your 09:30-15:15 order window | 4 (all 10:00, all winners) | +31.16 | -31 |
| Engine replay with the blackout input | 7 removed, 1 replacement added | | -627 → -609 |

- No overnight fire is ever affected, and FOMC windows removed 0 fires.
- **Verdict:** P&L-neutral over 3 months (n=7). Inside your order window it cost 31 pts (4 winners skipped). Keep it as an order-side tail-risk rule, because a print can move a whole stop in one bar. Do not turn it into an engine-record rule: it shows no measurable benefit there and would change persisted fires.
- Note: the Jun-Sep news dates were rebuilt from the official pages for this replay. Six of them are ISM dates inferred from ISM's published rule.

### 3.4 Apex 25K ruin odds

Rules modelled: the current 25K EOD evaluation, which is a $1,500 profit target, a $1,000 EOD trailing drawdown and a $500 daily loss limit. Method: 10,000 bootstrap paths, using only fires inside the 09:30-15:15 order window, with Apex flat at 16:55.

| Configuration | failed by day 30 | by day 60 | by day 120 | reaches $1,500 first | target within 30 d | median days |
|---|---|---|---|---|---|---|
| **5m+15m+60m, 2 micros** | **45%** | **62%** | **65%** | **35%** | 15% | 34 |
| 5m+15m+60m, 1 micro | 15% | 36% | 61% | 28% | 0.3% | 96 |
| **60m only, 1 micro** | **0%** | **1%** | **5%** | **22%** | ~0% | 191 |
| 60m only, 2 micros | 8% | 23% | 43% | 46% | n/a | 100 |
| 5m+15m+60m, 1 micro, plus hand-trading every overnight fire | 69% | 92% | 95% | 5% | n/a | n/a |

The edge underneath these numbers:
- 5m+15m+60m inside the order window: n=87, **+0.06/trade NET** (PF 1.01). That is effectively zero.
- 60m only: n=27, +1.55/trade (PF 1.29). Better, but a small sample.

**Plainly, about the current arming:**
- The armed set at 2 micros is a losing bet against this account. About **2 in 3 paths fail it, and 45% fail within the first 30 days.** Only about 1 in 3 reach $1,500.
- The live set today is 5m+60m. That exact mix was not simulated. Its edge sits somewhere between the two rows above. 5m was the weakest interval in every replay.
- 60m-only at 1 micro almost never fails (5% by day 120), but it reaches the target only 22% of the time and needs about 6 months. It is slow, not profitable enough to pass quickly.
- 60m-only at 2 micros is the best pass rate (46%), with 23% failed by day 60.
- Regime caveat: the same armed set at 2 micros was 73% failed in 30 days on H1 days and 0% on H2 days. These odds are a range, not a forecast.
- The guard (pause at $500 used) turns many of the "failed" paths into "paused" paths. It does not create any edge.
- Not modelled: liquidation slippage, and concurrent trades being correlated.

---

## 4. Open decisions (yours)

1. **Automation on Apex.** Keep the auto-trader armed on an account whose rules ban it, or go back to the 09-24 decision (disarmed; hand-trade RTH from alerts)?
2. **Size and intervals.** 2 micros on 5m+60m, or 60m-only? 60m-only at 1 micro is the lowest-risk configuration; at 2 micros it has the best pass rate. Nothing measured supports 5m.
3. **The -$970 and the guard.** Old account or new? Reset the guard tracker or leave it paused (section 2).
4. **Items you didn't answer:**
   - Item 6 (R5 shadow exits): already recording; keep or remove?
   - Item 7 (R6 plan type + $250/night overnight cap).
   - Item 8 (the LEARNINGS rule). The rule is recorded as engineering memory; say if you disagree.
5. **`ETH_CONFLUENCE`:** stay on (recommended) or switch off with the full regen sequence?
6. **Commit.** All of today's work and the earlier engine edits on this branch are uncommitted. Say when to commit.

Engineering follow-ups, not yours to decide but listed so they aren't lost:
- **Shadow exits early-close bug.** A fire right before a long halt (early closes 2026-11-27, 2026-12-24) gets a permanent "no data" result. Fix before Nov 27.
- **Missing tests for the client-side mutes.** The desktop-notification and sound mutes, and the overnight badge, have no failing-without-it test. The server mute is tested.
- **One data-drift failure.** `scripts/fact-engine-parity.test.ts` fails 1 check: 3 mismatched rows and 5 extra regen rows, from Aug 18 and the Sep 14-15 roll-repair window. Reconcile it through integrity-check plus regen. It is not a code regression.
- **Replay plumbing.** `scripts/fact-engine-backtest.ts` `enginePass` should pass `newsBlackouts`/`statsOut` through. It is a one-line change with no behaviour change.
- **Sandbox window key.** The sandbox's fe-bt `WINDOW_START_KEY` was reset to 2026-04-15. Roll it again before the next sandbox regen.
