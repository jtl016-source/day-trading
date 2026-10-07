# CLAUDE.md — Milks Yellow Box Strategy Viewer

## Before Starting ANY Task
1. Read `LEARNINGS.md` in full
2. Apply all "What Has Worked" and avoid all "What Has Failed"
3. After completing the task, update `LEARNINGS.md`

---

## Project Overview

**Full-stack day-trading strategy viewer** for ES/MES futures.

- **Frontend**: React 18 + TypeScript + Vite + lightweight-charts v5
- **Backend**: Express + TypeScript + PostgreSQL (drizzle-orm)
- **Live data**: MotiveWave TickRelay WebSocket study → `/ws/mw-feed` → `/ws/live-bars` → browser
- **Strategy**: Milk Yellow Box (FVG + Order Block + Structural zones) with Vector line confluence signals

## Commands
- Run dev: `npm run dev`
- Type check: `npm run check`
- Build: `npm run build`

---

## Architecture That Must Be Understood

### Live Data Flow
```
MotiveWave (Java study)
  → WS /ws/mw-feed  (sends {type:"tick", symbol, price} ONLY — never OHLCV bars)
  → live-bars.ts: broadcast({type:"tick"}) + notifyExternalTick()
  → notifyExternalTick(): updates in-memory 1m/5m bars, broadcasts completed bars on bucket rollover
  → browser /ws/live-bars:
      tick → updateLastBarClose() direct series.update() [fast path, no React re-render]
      bar  → setLiveCandles() [React state, for signals/zones]
```

### IBKR Bridge (server/ibkr-bridge.ts — 2026-09-23, OFF unless IB_ENABLED=true)
- The MotiveWave studies are only a JSON bridge; `ibkr-bridge.ts` speaks the same protocol
  in-process against TWS/IB Gateway (TWS 7496 live, Gateway 4001 live / 4002 paper, `@stoqey/ib`): ticks + completed 1m
  bars → `live-bars.ingestStudyMessage` (raw month-coded symbol "MESZ6" so the contract guard
  works unchanged); `order_command` → MKT parent + ONE LMT take-profit + STP stop, GTC,
  parentId-linked, transmit chained → AutoTrader-identical events → `ingestAutoTraderEvent`.
- `registerOrderExecutor` in live-bars: a registered+READY executor owns
  `broadcastOrderCommand`/`isOrderCommandSocketOpen`; nothing registered = today's sockets.
- Status: `GET /api/ibkr/status`, digest line, `[ibkr]` log lines. Setup: `docs/ibkr-setup.md`.
  Tests: `scripts/ibkr-bridge.test.ts` (mock IBApi, no Gateway, temp DB).
- Roll rule default 4 d before expiry = Yahoo's observed ES=F roll, so the contract guard pairs
  like with like; 8 (CME volume roll) would put IB on the new month first → guard quarantine +
  orders blocked ~4 days every quarter. Delayed data (IB 10167) → `execute()` refuses orders
  until a reconnect confirms real-time ticks.
- Review fixes (2026-09-23): backfill served only inside the contract ERA (`eraStartSec()` = seeded
  Yahoo-roll boundary or the bridge's own switch, persisted in `ibkr-state.json`); older ranges →
  `backfill_done {declined:true}` → gap-audit skips 6 h, never marks unfillable, gap-heal heals via
  Yahoo (`takeStudyDeclined`). Orders also refused on 1100/2110 or no tick for 90 s; roll at 00:00 ET.
  Ports: TWS 7496 live / 7497 paper, Gateway 4001 / 4002. No paper account → soak with Read-Only API ON.
- IB system messages (1100/1101/1102/2110/farm 210x, id -1) arrive on `EventName.info`, NOT `error`
  (@stoqey/ib decoder) — `wire()` routes info → `onInfo` → `onError(msg, code, -1)`. MockIB.sys() mirrors it.
- Real-money gap fixes (2026-09-23 G1–G6): a TP/SL-leg placeOrder throw cancels the already-sent legs and keeps
  the bracket tracked until IB confirms; 2xxx warnings never drop a historical request; farm "is OK" clears a 2110;
  the 60 s hist timer measures silence; a roll declines in-flight backfills ('roll'); an incomplete backfill job is
  DECLINED, never partially answered (a partial answer lets gap-audit's reconcile delete the missing span's real rows).

### Contract Guard (server/contract-guard.ts — 2026-09-17/18 Sep/Dec roll incident)
- `normalizeSymbol` strips month codes on purpose (MESU6/MESZ6/ES=F → MES), so MW and Yahoo can
  write DIFFERENT contract months into the same key around a quarterly roll (Yahoo ES=F rolls
  ~4 days before expiry; MW rolls when the user changes the chart). MW is authoritative ONLY
  while its RAW 1m closes match Yahoo's front month: a constant ≥10-pt same-minute offset over
  the newest 4 pairs → `isMwOffContract()` → nothing MW sends is persisted (the MW-written rows
  of the detection window are purged at the trip), yahoo-live is the writer, gap-heal/gap-audit
  never ask the study, tracked brackets are never price-inferred (`basisSuspect`), and
  `broadcastOrderCommand` refuses `order_command`. Verdict persists in
  `app_settings.contract_guard_state`.
- **Yahoo's CME chart feed is ~10 MINUTES DELAYED** — a Yahoo-driven chart is never "live". So
  while off-contract the chart stays tick-live by BROADCAST-TIME TRANSLATION: mw-reader's
  in-memory bars + `lastTickPrice` stay RAW (MW's basis — what brackets are worked in, and the
  only MW price the verdict pairs); the frozen spread (`frontMonthOffset()`) is added ONLY at
  the broadcast sites (live-bars tick, mw-reader `wireBar()`, GET `/api/live/bar`). Translated
  bars carry `provisional:true`: display-only, never stored, never an engine bar close.
- Roll signals while off-contract: the TICK stream's month code (debounced 20 ticks; other
  relays are reported, never acted on) and tick votes (40 raw ticks fitting Yahoo better
  untranslated). Either stops translation at once; BOTH together = fast recovery. Tick relays
  on two months at once = MIXED MONTHS → MW fully quarantined until every chart agrees.
- Surfaces: `/api/mw/sync-status.contractGuard`, red header pill (FeedStatusBadge), WS
  `contract_guard` events (clients reset their forming candle), daily digest line,
  integrity-check V6, push+Discord on every flip.
- Repair for an already-interleaved window: `POST /api/data/roll-mismatch-repair {fromTs?, apply}`
  (dry run unless `apply:true`; backs up to `cached_candles_roll_backup_<date>`), then the
  missed-window runbook for zones + signals (purge window rows → fe-bt `--window-from` → catchup).

### Main-thread hygiene (2026-09-18 — "laggy / trouble staying live")
- The server is ONE thread: anything synchronous and slow freezes ticks, WS broadcasts and every
  HTTP poll. Measured before the fix: p90 7.6 s on a pure in-memory route.
- The per-bar-close engine pass AND the 10-min catch-up compute run in `server/live-engine-worker.ts`
  (worker thread, heap capped at 768 MB; inline fallback). The worker imports ONLY `./catchup` +
  `@shared/*` — never import live-bars / gap-audit / live-engine from it (module-load timers).
  tsx does NOT register itself inside workers: the eval'd bootstrap calls `tsx/esm/api register()`.
- `server/safe-stdio.ts` MUST stay the first import of `server/index.ts`: on Windows a console/pipe
  write is synchronous, and a launcher that stops draining stdout froze the whole server at 0 %
  CPU (2026-09-18 outage). Console writes go through a writer thread + `C:\BaxterData\logs\server-YYYYMMDD.log`.
- `cached-continuous` floors `from` to the hour and caches the SERIALIZED body (5 s TTL) so N
  consumers cost one read; every bar writer must `cacheInvalidate(symbol)` after its commit.
- `auditGaps` takes `{sinceTs}` — never run the unbounded 2.4M-row audit on a timer.
- `npm run dev` caps the main heap (`--max-old-space-size=2048`): on this 16 GB machine an
  uncapped server grew to 3 GB and the paging was itself the lag.
- Spawned children with `shell:true` must be killed with `killProcessTree` (taskkill /T /F).

### Key Suppression Logic
- `lastExternalTickMs` suppresses disk-file heartbeat for 5s after a TickRelay tick arrives
- `onTickFileChange` returns early when TickRelay active (prevents stale disk prices conflicting with live)
- Forming bars broadcast via `notifyExternalTick` are throttled to 1/second (prevents React render flood)

### Chart Architecture (CandlestickChart.tsx)
- `useLayoutEffect` initializes chart (NOT `useEffect` — dimensions are 0 at useEffect time)
- ALL series (candle, volume, vector, extra vectors) are pre-allocated at init — NEVER add/remove dynamically
- `series.update()` fast path for live ticks; `series.setData()` only on structural changes
- `autoscaleInfoProvider: () => null` on ALL vector/indicator series — only candlestick drives Y-axis scale
- `lastCandleRef` tracks current forming bar so `updateLastBarClose()` can call series.update() directly
- `dedupMap` must be used before setData — duplicate timestamps silently drop bars in lw-charts v5

### Candle Gap Detection (CandlestickChart.tsx)
- Detects bar interval by finding minimum consecutive delta across first 50 bars
- MUST start from `Infinity` and scan down — starting from 300 breaks 15m/60m charts
- `GAP_THRESHOLD_SEC = barIntervalSec * 2` — gaps wider than this get 3 whitespace spacers

### Vector Line System
- Main vector: `Highest(Lowest(low, 20), 20)` on current-interval candles
- Extra vectors (15m, 60m, etc.): aggregated from rawCandleData using `aggToInterval(base, intervalSec)`
- Forward-fill coarser vectors onto finer chart times using `forwardFillVector(vec, chartTimes)`
- Pre-allocate exactly 3 extra `LineSeries` at chart init — update data only, never add/remove

### Signal Levels
- **safe**: zone + vector direction + bullish/bearish body + within 3 most recent zones
- **risky**: zone + vector direction + body confirmation
- **riskiest**: zone + vector direction only
- Cooldown: `COOLDOWN_BARS` = 10 primary bars (GLOBAL per-interval cursor, ETH bars count; was 4 until 2026-09-24).
- Yellow-box BREAK is a one-time EVENT (`YB_BREAK_EVENT_BARS` = 3 bars after the first close beyond the box, re-armed on re-entry; 0 = legacy per-bar state). Afterwards it is an uncounted `beyond box` note.
- `ONE_OPEN_PER_DIRECTION` (default true): no new fire in a direction while the engine's own prior bracket on that interval is still open (canonical TP1/SL walk, carry-overnight). Writers seed the engine with stored fires (`priorFires` / `openTrades`) and `server/fire-admission.ts` refuses cross-writer twins (cooldown + open-trade) at persist time.
- Chart windows are CAPPED: client 1m 14 d / 5m 90 d / 15m 400 d (`client/src/lib/candle-window.ts`); server `cached-continuous` clamps spans even with an explicit `from` (`server/serve-window.ts`: 1m/5m 150 d, 15m 400 d) — a 2019 `from` on 1m was a 248 MB / 20 s single-thread stall (2026-09-24).

### RTH / ETH Definition (CME ES/MES futures)
- **RTH**: Mon–Fri, 9:30 AM – **5:00 PM ET** (user-defined close). Compute with `Intl.DateTimeFormat({timeZone:"America/New_York"})` — NEVER a hardcoded UTC offset (9:30 ET = 13:30 UTC in EDT but 14:30 UTC in EST). Canonical: `isRTH` in `client/src/lib/trading-utils.ts` (`etMins < 17*60`).
- **ETH**: the overnight Globex session — Sun 6:00 PM ET → Fri 5:00 PM ET minus the RTH window (i.e. 6:00 PM → 9:30 AM).
- **CLOSED**: daily maintenance halt 5:00–6:00 PM ET, and the weekend (Fri 5 PM → Sun 6 PM).
- Full session classifier (RTH/ETH/CLOSED) for display: `marketSession()` in `client/src/components/terminal/Clock.tsx`.

### Signal rules (user-defined)
- **TP1-ONLY EXECUTABLE POLICY (2026-08-13, user directive: "no TP2 ever — all contracts on
  one TP")**: signals carry ONE target (tp1) + stop; `tp2` is NULL everywhere; outcomes are
  `win_tp1` / `loss` / `open` — `win_tp2` and the retro-award record convention are RETIRED
  (the old convention scored an un-executable look-ahead: record +6.62/trade vs best
  executable +1.65 — measured 2026-08-12). The canonical resolver's `tp1Only` flag +
  `FACT_ENGINE_DEFAULTS.TP1_ONLY` (default true) enforce it engine+harness+catchup+repair
  wide; exit calibration's TP1 grid floor is 6 pts (user ban: "dont ship the 4 point tp").
  ALL history was wiped + re-resolved from real 1m bars under this policy on 2026-08-13
  (as-was records preserved in `signal_history_pre_tp1only_backup` +
  `fact-engine-backtest-results.pre-tp1only.json`).
- **DAILY LOSS STOP REMOVED (2026-08-17, user directive: "take away the rule for the funded
  accounts")**: the engine-level −80 pts/session stop (2026-08-02) no longer runs anywhere —
  the overnight 2026-08-17 ETH Long-run losses closed at the RTH open, tripped it at 9:35 AM
  ET, and suppressed the entire RTH session; the funded accounts' own prop-firm daily limits
  govern instead. Settings-layer removal only: catchup.ts `computeDayLossStop` defaults 0
  (`CATCHUP_DAILY_LOSS_STOP_PTS` re-enables), market.tsx defaults OFF (key bumped to
  `dailyLossStopEnabled2` so stale localStorage can't resurrect it; Risk Controls toggle still
  opts back in), harness as-traded stop 0 (live parity). Engine capability + the documented
  80-pt derivation stay intact (`DAILY_LOSS_STOP_DEFAULT_PTS`). The session-review collector
  still reports would-have trips (`ruleRemoved: true`) so the digest keeps scoring the decision.
- **No signals after 3:15 PM ET** (15:15) on any interval — too risky near the RTH close.
- **Dead-tape DIRECTIONALITY exemption (2026-08-12, user-approved)**: a quiet-tape bar fires
  anyway when the session's net drift so far ≥ `DEAD_TAPE_DIR_EXEMPT` (0.5) × its range so far
  — quiet-TRENDING days trade, quiet-DIRECTIONLESS days stay suppressed (the measured
  5.6%-win chop). Both bar-close and forming-bar paths; the [dead-tape-trend-blindspot]
  journal hypothesis, swept 2026-08-12 (dominated every axis and sleeve).
- **CARRY-OVERNIGHT outcomes (2026-08-11)**: no session-end force-close — an open trade rides
  across the settle/halt/weekend until TP or SL is hit ("eod" is never produced anymore; the
  vocab survives on historical rows). DERIVATION (gate verdicts + MC exits) deliberately stays
  session-bounded (`carryOvernight:false` in the canonical resolver) — time-unbounded records
  inflate every judgment (measured 2026-08-11; see LEARNINGS).
- **ETH confluence ENABLED (2026-08-11 — user repealed the old ETH-purity rule)**: full
  fact-engine confluence signals fire during ETH too (`ETH_CONFLUENCE` engine setting, default
  ON; `false` restores the old vse-only overnight behavior). Still RTH-only regardless:
  milk-zone reactions (zones are dated RTH artifacts), strong-zone / yellowbox SOLO fires,
  forming-bar (intra-candle) fires, and the 15:15 cutoff. The quality gate + calibrated exits
  apply to ETH fires unchanged (RTH-derived calibration — the weekly regen absorbs ETH rows
  going forward).

---

## Style Rules
- Never add `autoscaleInfoProvider` without `() => null` for indicator series
- Always use `useLayoutEffect` for any code that reads DOM dimensions at init
- `fetchInterval` maps: `"1m"→1m`, `"5m"→5m`, `"15m"→15m`, `"60m"→60m` — server tries resolution `["15","5"]` for 15m (native 15m bars first, falls back to 5m aggregation)
- `cached-days` includes `resolution IN ('5','15','60')` so native 15m days from MW relay appear in the scrubber
- Candle coloring: above vector = normal colors, below vector = dim/muted colors
- All candle data passes through `dedupMap` before `series.setData()`
- Signal computation always uses `rth !== false` filter (RTH-only candles for strategies)
