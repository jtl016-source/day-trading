# Footprint feed fix (2026-10-06): the ask side was dead for three months

`footprint_candles` (MES, 5m) stored `askVol = 0` on every level of every complete bar from
2026-07-08 through 2026-10-06. Every stacked imbalance became a SELL stack and all 37 engine
footprint fires since July were Short. This note records the cause, the fix, how to rebuild and
reinstall the MotiveWave study, how to prove it worked, and what stays untrusted.

Nothing live was touched: the server on :3000 was not restarted, MotiveWave was not restarted,
no trade setting changed, no order placed, and the database was opened read-only only.

---

## 1. The fault: the study, not the server

`mw-study/com/custom/LiveBarRelay.java` (the "v2" relay committed 2026-07-02 as e3ad100 and kept
by the 07-08 restore) classified the aggressor side in `onTick` with a reflection guess:

```java
long    vol   = extractLong(tick, "getVolume", "getSize", "getQuantity", "getLastSize");
boolean isAsk = extractBool(tick, "isAsk", "askTick", "isBuyTick");
if (vol <= 0) vol = 1;               // "treat unknown as 1 contract"
if (isAsk) arr[1] += vol; else arr[0] += vol;
```

None of `isAsk`, `askTick`, `isBuyTick` exist on the SDK `Tick`. The constant pool of
`C:\Program Files (x86)\MotiveWave\lib\mwave_sdk.jar` (2026-09-18 build) lists exactly:
`getPrice`, `getTime`, `getVolume`, `getVolumeAsFloat`, `isAskTick`, `getAskPrice`, `getAskSize`,
`getAskSizeAsFloat`, `getBidPrice`, `getBidSize`, `getBidSizeAsFloat`, `getExchOrderId`,
`getAggExchOrderId`. So `extractBool` always fell through to `false`, every trade was counted on
the bid, and the ask side was never populated. The `vol <= 0 → 1` rule also fabricated one
contract per quote-only tick.

This is the exact bug LEARNINGS 2026-06-02 fixed ("Real footprint fix … wrong reflection method
name"). The fix lived in the June source (`tick.getVolume()` / `tick.isAskTick()`, commits
ccb75dc / 435ac43) but the July v2 rewrite copied the older `onTick` ("unchanged from v1") and
overwrote it. The jar in `%USERPROFILE%\MotiveWave Extensions` (19,584 bytes, 2026-08-14) is a
build of that regressed source.

### The two other suspects were cleared

- **Server ingest** (`server/live-bars.ts` → `server/footprint-engine.ts`): the study sends
  `levels: [{price, b, a}]`; the server reads `b` / `a` and maps them to `bidVol` / `askVol`.
  No rename on either side. `scripts/footprint-ingest.test.ts` now proves a two-sided message
  persists both sides level for level.
- **Engine direction logic** (`shared/fact-engine.ts`): a `buy` stack is Long support and a
  `sell` stack is Short resistance. Correct for real data. The Short-only output came from
  `footprint-engine.closeCandle()`'s zero-vs-nonzero rule: with a dead ask side every level is a
  `sell` imbalance, so each bar collapses into ONE stacked sell cluster spanning its whole range.

### Evidence (read-only, `data/app.db`, complete 5m candles)

| Window (ET)              | Side state | Example                                                  |
|--------------------------|------------|----------------------------------------------------------|
| 2026-06-02 → 06-05       | two-sided  | 06-05: 203 bars, ask 1,848,183 / bid 5,656,724           |
| 2026-06-07 → 06-12       | one-sided  | 06-11: 278 bars, ask 0 / bid 4,092,406 (an earlier swap) |
| 2026-06-25 → 07-02 09:35 | two-sided  | 06-29: 48 bars, ask 813,012 / bid 819,228                |
| 2026-07-08 → 10-06       | one-sided  | 08-19: 278/278 bars, ask 0 / bid 3,886,404; 10-06 ask 0  |

Last two-sided complete bar: 2026-07-02 09:35 ET. First one-sided bar of the current run:
2026-07-08.

---

## 2. What changed

**Study (the real fix)** — `mw-study/com/custom/LiveBarRelay.java`, rebuilt into
`mw-study/LiveBarRelay.jar` (LiveBarRelay + SdkProbe, same composition as before):

- `onTick` reads `int vol = tick.getVolume()` and `tick.isAskTick()` directly from the SDK type.
  Quote-only ticks (`vol == 0`) are skipped instead of counted as one contract.
- `extractLong` / `extractBool` deleted so the guess cannot come back.
- `[LiveBarRelay] v2.1 (footprint aggressor fix 2026-10-06) initialize` banner, plus one-time
  `footprint: first ASK-side trade seen …` and `first BID-side trade seen …` lines, so the
  MotiveWave console proves both sides are alive after the reinstall.

**Server (detection only, semantics unchanged)**:

- `shared/footprint-side.ts` — the one definition of "one-sided": a candle with ≥ 4 price
  levels and ≥ 50 contracts whose bid or ask side is exactly zero. Alarm share 10 %.
- `server/footprint-engine.ts` — stores `oneSided` on every candle and logs
  `[footprint] ONE-SIDED complete … candle` (30-minute rate limit) when a complete candle shows
  the signature. Takes effect at the next server restart; none was performed.
- `scripts/integrity-check.ts` — new **W3** warning in the 8:30 daily digest when ≥ 10 % of the
  last 7 days' qualifying complete 5m candles are one-sided. It will keep warning until
  two-sided sessions dominate the window. That is intended.
- `scripts/footprint-ingest.test.ts` — in `npm test`. Feeds a two-sided `footprint_bar` through
  `ingestStudyMessage` on a temp DB and asserts both sides persist, both imbalance directions
  survive, same-bucket messages accumulate, the dead-ask signature is flagged, and a tiny
  legitimate print is not.
- `scripts/footprint-side-check.ts` — read-only verifier (section 4).

**Deliberately not changed**: the consumers that read stored `imbalances`
(`server/catchup.ts`, `shared/live-adapter.ts`, `scripts/fact-engine-backtest.ts`,
`scripts/live-fire-audit.ts`, `scripts/session-review-collect.ts`) still use every stored zone,
one-sided or not. Dropping one-sided candles' zones would move the standing book, the
quality-gate calibration and integrity-check V1 underneath the live engine. That is the owner's
decision (section 5).

---

## 3. Rebuild the study (when the source changes again)

Prerequisites on this machine (verified 2026-10-06):

- JDK 25: `C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot` (`javac 25.0.3`).
- SDK: `C:\Program Files (x86)\MotiveWave\lib\mwave_sdk.jar` (2026-09-18, class-file major 69).
  JDK 25 reads it directly. The 2026-08-04 byte-patch recipe (70 → 69) is no longer needed.

From the `mw-study` folder:

```bat
set JDK=C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot\bin
set SDK=C:\Program Files (x86)\MotiveWave\lib\mwave_sdk.jar
rmdir /s /q out & mkdir out
"%JDK%\javac.exe" --release 17 -cp "%SDK%" -d out com\custom\LiveBarRelay.java com\custom\SdkProbe.java
"%JDK%\jar.exe" cf LiveBarRelay.jar -C out .
```

`build.bat` does the same, but it ALSO recompiles `AutoTrader.jar` from the current
`AutoTrader.java` and copies both jars straight into `MotiveWave Extensions`. Only run it when
you want AutoTrader redeployed from source too.

Check the build before installing it (Git Bash):

```bash
unzip -p mw-study/LiveBarRelay.jar com/custom/LiveBarRelay.class | tr -c '[:print:]' '\n' | grep -c "isAskTick"
```

Expect 1 or more. Zero means the old reflection build.

---

## 4. Reinstall into MotiveWave (owner's action: it restarts the live feed and the armed AutoTrader)

1. Be flat. Confirm `Orders (0)` on the DOM / strategy panel.
2. Copy `mw-study\LiveBarRelay.jar` over `%USERPROFILE%\MotiveWave Extensions\LiveBarRelay.jar`.
   Overwrite in place. Do not leave a backup copy anywhere under `MotiveWave Extensions`:
   MotiveWave scans subfolders and a duplicate class breaks study loading (LEARNINGS 2026-06-26).
3. File > Exit MotiveWave. Confirm the shutdown dialog and the "Active Strategies!" dialog;
   decline the update prompt. Reopen; click Continue at the workspace picker.
4. Click each of the four chart tabs once (background tabs reconnect lazily). On the strategy
   panel click Activate for Auto Trader and wait for `onActivate(OrderContext)` in
   `%USERPROFILE%\autotrader_log.txt`. Do not fight the post-reconnect re-init wave; verify after
   it quiets (~2 minutes).
5. In the MotiveWave console output (where `[LiveBarRelay] Connected to ws://localhost:5000/ws/mw-feed`
   prints today) confirm:
   - `[LiveBarRelay] v2.1 (footprint aggressor fix 2026-10-06) initialize`
   - `[LiveBarRelay] footprint: first ASK-side trade seen (…)`
   - `[LiveBarRelay] footprint: first BID-side trade seen (…)`
6. After at least one full 5-minute bucket, from the project root:

```bash
npx tsx scripts/footprint-side-check.ts
```

   Expect `VERDICT: newest session … TWO-SIDED ✓` and exit code 0. The per-day table shows the
   ask share of volume; a healthy RTH session runs roughly 45–55 %.
7. The next 8:30 digest still prints `W3-footprint-one-sided` until two-sided candles are at
   least 90 % of the trailing 7 days. Expected; it clears on its own.

---

## 5. Trust rule and what is still built on bad data

Footprint facts are **untrusted until 20 consecutive two-sided sessions are stored**. Count them
with:

```bash
npx tsx scripts/footprint-side-check.ts --days 40
```

Everything derived from stored imbalances since 2026-07-08 (and 06-07 → 06-12) rests on
fabricated zones: the standing book's FP combos (FP+Fr+YB and friends), the quality-gate
verdicts that counted FP facts, the 37 Short footprint fires, and the scalping-research
footprint cell. When the feed has proven itself, the owner's next decision is whether to drop
one-sided candles' imbalances at the consumers (one shared helper now exists for the test) and
regenerate the standing book under that rule.
