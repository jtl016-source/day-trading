# LEARNINGS — Milks Yellow Box Strategy Viewer

Update this file after every session. Be SPECIFIC. Vague entries are useless.

---

## What Has Worked

- **`useLayoutEffect` for chart init** — DOM dimensions are 0 at `useEffect` time in lightweight-charts v5. Always use `useLayoutEffect` when creating the chart or reading `getBoundingClientRect()`.

- **Pre-allocating chart series at init** — Adding/removing `LineSeries` dynamically (after chart creation) resets the visible time range. Pre-allocate ALL series (vector, extra vectors, overlays) at chart init, then just call `setData()` to show/hide.

- **`autoscaleInfoProvider: () => null` on indicator series** — Without this, vector lines pull the Y-axis to fit their full historical range, compressing candles to a tiny sliver. Set this on ALL non-candle series (main vector, extra vectors).

- **`dedupMap` before `series.setData()`** — Duplicate timestamps silently drop bars in lightweight-charts v5. Always deduplicate before passing candle arrays.

- **`series.update()` fast path for live ticks** — Calling `setLiveCandles()` on every tick floods React with re-renders. Tick messages call `chartRef.current.updateLastBarClose()` directly (bypasses React state). `bar` messages use `setLiveCandles()` for signal recomputation.

- **Suppressing disk reads when TickRelay is active** — `onTickFileChange` must return early when `Date.now() - lastExternalTickMs < 5000`. Without this, stale disk prices override live WebSocket prices, causing visible price jumping.

- **`forwardFillVector` for multi-interval vectors** — To display a 15m or 60m vector on a 5m chart, forward-fill: for each 5m chart time T, emit the last vector value whose time ≤ T. Works for both coarser-on-finer and finer-on-coarser.

- **`aggToInterval(candles, intervalSec)`** — Generic aggregation correctly handles all intervals. `agg5mTo15m` only works for 5m→15m; `aggToInterval` handles any target.

- **Bar interval detection starting from `Infinity`** — The gap detection loop `let barIntervalSec = 300` breaks 15m/60m charts because `900 < 300` is false and the variable never updates. Must start from `Infinity` and scan down.

- **`intervalKey` prop + `prevIntervalKeyRef` to detect interval switches** — When switching 1m→15m, the old logical range `{from:155000, to:155080}` exceeds 15m data length (~10k bars), causing lw-charts to zoom-to-fit all history as tiny dots. The fix: pass `intervalKey={interval}` to CandlestickChart, track `prevIntervalKeyRef`, and on mismatch reset to last 80 bars. Also needed: `if (!range || range.from >= total)` guard for the reverse case (old low-res range pointing into stale history after switching to high-res).

---

## What Has Failed

- **`useEffect` for chart init** — Dimensions are 0, chart renders with height 0. Always use `useLayoutEffect`.

- **Starting gap detection at `barIntervalSec = 300`** — 15m candles are 900s apart; `900 < 300` is always false so `barIntervalSec` stays 300, `GAP_THRESHOLD_SEC = 600`, and spacers are inserted between EVERY 15m candle pair. Broke the 15m chart completely.

- **Stale logical range after interval switch** — Switching 15m→1m and back leaves the old range (e.g. `{from:7920,to:8005}`) which in 1m context points to early December history, not the recent bars. Fixed by detecting `intervalKey` change in the candle useEffect and resetting zoom. Do not leave visible range correction to the `scrollToRealTime()` path — it only fires when near the right edge.

- **Dynamic `chart.addSeries()` in `useEffect`** — Resets the chart's visible range every time series are added. Also: if the chart is recreated (resize/theme change), the useEffect doesn't re-run (prop didn't change) and the new chart has no series. Pre-allocate at init instead.

- **Byte-scanning tick file for prices** — Attempting to scan the MW `.tick_data` file by looking for float32BE values in the 400–50,000 range returns garbage (e.g., 20,992 / 1,600 for MES). These corrupt bars produce ATR ~19,000pts → every SL hits immediately → ~11% win rate. Use fixed-offset record parsing only.

- **Setting `lastTickPrice` before the forming-bar broadcast condition** — In `notifyExternalTick`, `lastTickPrice.set(sym, price)` was called on line 458 THEN the condition `Math.abs(price - lastTickPrice.get(sym)) >= 0.01` was checked on line 501. The difference is always 0 → broadcast never fires. Move the set AFTER the check, or use a throttle.

- **`parseTickFileAsBars` byte scanner** — Rewrote to scan every 4 bytes for plausible MES prices. Produced corrupt OHLCV bars that destroyed win rates. Reverted immediately to fixed-offset version.

- **Letting vector series affect `autoscaleInfoProvider`** — Without `() => null`, a 15m or 60m vector from 90 days of history (when the price was 500pts lower) pulls the Y-axis down, compressing current candles into the bottom 5% of the chart.

- **Not pre-allocating extra vector series** — After adding dynamic series, `fit all` would re-trigger chart autoscale and compress candles.

---

## Patterns and Preferences

- **4 pre-allocated extra vector series slots** (even though max needed is 3) — always enough room for 1m/5m/15m/60m minus current interval.

- **Interval-to-seconds mapping**: `1m=60, 5m=300, 15m=900, 60m=3600`. The `fetchInterval` only has 3 values: `"1m"`, `"5m"` (used for both 5m and 15m charts), `"60m"`. The 15m chart is ALWAYS aggregated client-side from 5m data.

- **Signal cooldown is 10 RTH bars** — signals cluster without it. This is measured in RTH bars only, not wall-clock time.

- **MotiveWave TickRelay study sends `{type:"tick", symbol, price}` only** — no OHLCV bars. All OHLCV bar state is maintained server-side in `inProgressBar1m` / `inProgressBar5m` maps and broadcast as `{type:"bar"}` when buckets close.

- **~~Whitespace spacer collision guard~~** — REMOVED. Gap spacers removed entirely (user wants no gaps). Just pass plain `CandlestickData[]` to `series.setData()`.

- **Real unix timestamps (NO gap spacers)** — The compressed bar-index timeline was reverted. Use real unix timestamps in all `series.setData()`/`series.update()` calls. Gap spacers were subsequently removed too — user wants zero gaps including overnight/weekend. Just call `series.setData(candleData)` with the plain array; lw-charts handles time gaps natively on the axis.

- **~~Pure integer bar indices eliminate ALL weekend/session gaps~~** — SUPERSEDED. Compressed timeline was reverted because it introduced a race-condition gap when `_compPairs` was stale on WS reconnect, and produced a chart that didn't match MotiveWave/PC. Real timestamps + whitespace spacers is the correct approach.

- **Footprint imbalance zones must be time-gated** — `allAggsFp` can include sessions from months ago when the chart spans a large history. Without a recency filter (e.g., `nowSec - zfp.time > 5 * 86400 → skip`), old sessions render imbalance bands at historical price levels, which appear as "imaginary zones" when the Y-axis includes those old prices. Add `ZONE_CUTOFF_SEC = 5 * 24 * 3600` filter.

- **Footprint ladder must be price-range filtered** — `prevSessionFp` is the most recent completed session. When the user scrolls back in time, the visible Y-axis can include old price ranges. Guard with `fp.high >= visPriceBot && fp.low <= visPriceTop` to prevent a ladder with stale prices from rendering at the right edge against current candle territory.

- **Session boundary markers needed with compressed timeline** — When ETH and RTH bars are compressed together, overnight price gaps look like spurious spikes. Draw thin vertical dashed lines at RTH↔ETH transitions using `ctx.setLineDash([3,4])` at `rgba(90,120,160,0.30)` opacity. Detect transitions by checking `prev.rth !== false !== cur.rth !== false`.

- **Vector computation uses ALL bars (RTH + ETH)** — `computeVectorLine` must NOT filter to RTH-only. ThinkorSwim's `vectorexitstrat` uses all bars; RTH-only filtering causes large slow-moving staircase steps that don't match the reference. The 20-bar window already provides enough smoothing. Trading SIGNALS still gate on RTH/ETH conditions separately — the formula is all-bars but signal firing is controlled upstream.

- **Win rate baseline** — Safe signals historically run ~55–65% win rate on MES 5m. Below 50% almost always means corrupt candle data, not a strategy problem. Check DB first.

- **HOD/LOD TP1 caution (3 pts prox, 2 pts buf, 3 pts min profit)** — TP1 is tightened to HOD − 2 (longs) or LOD + 2 (shorts) when within 3 pts of HOD/LOD. TP2 is never clamped. Applied at all 6 lock sites. HOD/LOD must be tracked before `continue` statements so skipped bars still update the day's high/low. Only applied to RTH signals (`rthC = true`).

- **Long entry suppression near HOD (5 pts, uses `prevDayHodHigh`)** — Long signals are blocked when `c.close` is within 5 pts of the HOD that existed BEFORE the current bar (`prevDayHodHigh`). Using `prevDayHodHigh` (not `hodHigh`) is critical: it prevents blocking valid breakout bars that themselves pushed price above the old HOD. The guard `prevDayHodHigh > -Infinity` skips the check on the first RTH bar of the day (no reference yet). Applied to all 3 long signal types (confluence, pure tabletop, side tabletop).

- **Discord zone toTime was 14 days (incorrect)** — Each zone is valid for its market day only. Fixed in market.tsx `activeZones` useMemo: now uses `rthSettleOfDay(z.posted_at)` instead of `z.posted_at + 14 * 86400`. Zones posted post-RTH (ETH pre-market) advance to next day's settle.

- **extraVecSignalLines replaces extraVecSignalMaps** — Added `flatMap` (true when secondary vector barely moved over 2 steps ≤1pt) and `declineMap` (true when secondary vector is in a falling phase, reset on any upward tick). Pre-computed at useMemo time for O(1) per-candle lookups in the signal loop. The `vec60mLine` reference pre-extracted before the loop so the 60m `declineMap` check is O(1) per candle.

- **Trade journal built in** — new `/api/journal` CRUD routes, `trade_journal` DB table, `/journal` page. Stats panel shows win rate by emotion state and plan adherence. Accessible via "Journal" button in the market page toolbar. Feeds user trade data directly into the system for ML analysis.

- **Zone day-isolation: zone-parser now caps toTime to RTH settle when no explicit end time in MWML** — `defaultToTime(fromTs)` computes 20:30 UTC on the zone's `fromTime` day. Previously all MWML zones without an explicit `toTime` got `9_999_999_999` (infinite), causing prior-day zones to bleed into all subsequent sessions and produce false `milkBullOk`/`milkBearOk` matches. Fix only applied when `fromTs > 0`; fallback parsing paths with `fromTime: 0` keep `9_999_999_999` because there's no day context.

- **Spike candle filter in `cached-continuous` endpoint** — Added `isSpikeBar(o, h, l, c)` in `server/routes.ts` that rejects: (1) any bar whose H-L range > threshold × close (1m=0.5%, 5m=1%, 15m=1.5%, 60m=2.5%), (2) doji-spike bars where body/range < 5% AND range/close > 0.2%. Applied before `.map()` in both DB path and `memBarsToCandles()`. Filters corrupt data-glitch bars that trash `Lowest(low, 20)` vector for 20 bars downstream.

- **TickRelay phantom bar root causes (three distinct bugs)** — (a) Close-handler fires `setTickRelayConnected(false)` on first of N disconnects (should only fire when ALL clients disconnect — check `mwWss.clients.size === 0`). (b) `onTickFileChange` checks `tickRelayConnected` but NOT `lastExternalTickMs`, so a brief flag flip lets stale disk prices corrupt live price. (c) At startup, disk poll seeds `inProgressBar5m.open` before TickRelay connects → phantom bar with open at yesterday's close (e.g. 7192) and close at live (7485). Fix: clear all in-progress bars inside `setTickRelayConnected(true)`.

- **backtest.tsx zone scan was capped at last 234 RTH bars** — `const startIdx = Math.max(0, rth.length - 234)` made `detectMilkZones` only detect zones for the most recent ~2 weeks, leaving all older candles with `milkBullOk=false` and showing as RISKY. Fix: start the loop from index 1 unconditionally. Also had a secondary `zones.slice(-60)` cap that hid 90%+ of detected zones. Both removed.

- **extraVecSignalMaps refactored to extraVecSignalLines with flatMap + declineMap** — The old structure stripped labels from secondary vector maps, making it impossible to identify the 60m interval for the hard veto. Replaced with `{ label, color, map, flatMap, declineMap }` per line. `flatMap` pre-computes whether each vector is flat (≤1pt change over 2 steps), used as the side-entry proxy. `declineMap` tracks whether the vector is in a falling phase (resets on any upward tick).

- **Secondary vector now requires flatness as side-entry gate** — Per strategy: secondary vectors only count as confluence when that interval shows a side-entry/consolidation first. Proxy: the secondary vector must be flat (≤1pt change over 2 steps). Without this gate, `secLongOk` fired anytime `c.close > secondaryVector` regardless of trend state, producing false confluence.

- **60m hard veto added for Long signals** — Pre-computed `vec60mLine` before the main signal loop. Inside the Long block, `vec60mDecline = vec60mLine?.declineMap.get(c.time) === true` gates the entire Long condition. When the 60m vector is in a declining phase, ALL Long signals are suppressed regardless of zone/footprint/secondary-vector state.

**2026-05-17 — Mobile gap spacers cause 0-price phantom candles**
- Observation: Lightweight-charts v4 does NOT support whitespace-only `{time}` entries in a candlestick series (unlike v5 which has explicit WhitespaceData). Passing `{time}` without OHLCV renders as a candle at price 0, appearing as tiny bars far below the chart.
- Action: Remove gap spacer logic entirely from mobile `setChartData`. Just call `candleSeries.setData(candles)` directly. LW v4 handles time gaps natively on the time axis without needing spacer entries.
- Confidence: high

**2026-05-17 — Mobile live data via WebSocket**
- Observation: Mobile only fetched historical data on mount/refresh; no live tick feed.
- Action: Added `window.connectLive(wsUrl, sym, resolution)` to WebView HTML. Called from React Native after each historical data load by converting `apiBaseUrl` (`http://`) to `ws://` and connecting to `/ws/live-bars`. On tick: updates `liveLastBar.close/high/low` and calls `candleSeries.update()`. On complete bar: updates `storedCandles` and redraws footprint. Auto-reconnects after 5s on disconnect.
- Confidence: high

**2026-05-17 — Footprint ladder + zone mitigation fix**
- Observation: PC ladder rendered `bidVol × askVol` on the left column plus net delta on the right. Zone mitigation was wrapped in `if (!isCurZ)` — so any historical session whose anchor candle was visible on screen bypassed mitigation and kept showing already-traded-through zones.
- Action: (1) Reduce `C_TOT` to 80, remove two-column layout, show only signed net delta centered in the single column. (2) Remove `!isCurZ` guard — mitigation now always runs for every historical session. (3) Mobile: rewrite `buildProxyFP` to use whole-number price buckets (matching PC); rewrite imbalance detection to per-level ratio (not diagonal cross-level); rewrite `drawFootprint` to render the same net delta column on the right edge.
- Confidence: high

**2026-05-23 — Per-candle MW Volume Imprint footprint**
- Observation: `candleFootprints` prop was session-aggregate (one RTH/ETH ladder). Real per-candle bid×ask data from MW arrives via `footprint_bar` WS → `footprint-engine.ts` → `footprint_candle` WS → `footprintCandlesRef` on client — but was only used for signal computation, never rendered.
- Action: Added `perCandleFootprints?: Map<number, FootprintCandle>` prop to CandlestickChart. Built `perCandleFootprintMap` in market.tsx from `footprintCandlesRef` (real MW data only, keyed by candle time). In `drawAll`, added per-candle rendering block: for each visible candle with a footprint, draw bid bars (left half, red) and ask bars (right half, green) within the bar's pixel width. `rowH = pixPerPoint × 0.25` — if too small (<0.5px), skip. Numbers shown when barW ≥ 60px and rowH ≥ 10px. Only shows for bars with real MW tick data (last ~50 5m bars); no proxy fallback for historical.
- Confidence: high

**2026-05-24 — Footprint zone detection: diagonal ratio fails with proxy OHLCV data**
- Observation: After applying the footprint literature's diagonal 3:1 rule (`ask@bucket[bp] / bid@bucket[bp-2] >= 3.0`), ALL session-aggregate zones disappeared. The proxy bid/ask generated from OHLCV (`buildProxyFootprintCandle`) is a smooth distribution where adjacent 2-point buckets have nearly identical ratios — the diagonal comparison never reaches 3.0 with synthetic data. Only real MW tick data (from `footprint_bar` WS) can achieve 3:1 cross-level ratios.
- Action: Revert zone detection to same-bucket comparison (`ask / bid >= 1.3` and `net >= 100` within the same 2-point bucket). Applied identically in both the `drawAll` Step 1 block and the mitigation `useEffect`. Stacked detection, zone boundary mitigation (close < bp for buy, close > bp+2 for sell), and opacity tiers are unchanged.
- Confidence: high

---

---

**[2026-05-17] — MW bar file format correction + historical data fix**
- Observation: `mw-reader.ts` had wrong constants: `HEADER_SIZE=80/RECORD_SIZE=22` with `minuteOff` at offset `o+20`. Actual format (confirmed via hex dump of real `.bar_data1` files) is `HEADER_SIZE=48/RECORD_SIZE=30` with `minuteOff` at offset `o+28` (last 2 bytes, after 8 bytes of zero padding post-volume). Old constants produced garbage — 20 records of zeros instead of 15 valid price records per file.
- Observation: `TICK_HISTORY_MS = 8 days` only read the most recent 8 days of tick files. MW stores ~7-9 months of hourly tick files. The bulk of the historical minute-bar data comes from tick files (dense), not from sparse weekly bar files (~15 bars/file). Extending to 300 days grew DB from 19,805 1m bars → 173,044 1m bars, back-filling from June 2025 to April 2025.
- Action: To verify `parseBarFile` format: hex-dump the smallest `.bar_data1` file and find the first 4-byte sequence that decodes to a plausible price (MES ~5000–8000). Count bytes from file start → header size. Find next occurrence → record size. `minuteOff` is the last u16 of the record.
- Action: Set `TICK_HISTORY_MS = 300 * 24 * 3600 * 1000` (300 days) to cover all available MW tick history. First load takes ~23s; subsequent reloads are fast (no-op upserts).
- Action: After extending tick history, sparse MESU6 bar files added future-dated placeholder bars (up to June 24, 2026 — the contract expiry). These pushed the chart's default 60-day window into empty/sparse territory, causing zone rendering artifacts (full-chart olive overlay). Fix: `filter(b => b.timeSec <= Math.floor(Date.now()/1000) + 3600)` in `loadMultiDir` before DB write. Also `DELETE FROM cached_candles WHERE timestamp > nowSec` to clean existing rows.
- Confidence: high

**2026-05-18 — Compressed timeline eliminates weekend/overnight chart gaps**
- Observation: lw-charts v5 has no built-in gap-removal for intraday data. Weekend/overnight gaps (49h Fri 5pm→Sun 6pm ET) consumed ~28% of chart width on a 60-day 5m chart, compressing the visible price action.
- Action: Replaced the gap-spacer approach with a compressed timeline: `base + i * barIntervalSec` assigns sequential chart-times to each bar. Module-level `_toChartTime(actual)` / `_toActualTime(comp)` translate between actual unix timestamps and chart-times via binary-search interpolation. All `ts.timeToCoordinate()` calls receive `_toChartTime(t)`. All `coordinateToTime()` results pass through `_toActualTime()`. `tickMarkFormatter` and `localization.timeFormatter` both call `_toActualTime(compT)` to show real dates. `updateLastBarClose` extends the map for each new live bar.
- Confidence: high

**2026-05-18 — Live data lag: 3 server-side fixes**
- Observation: 16ms fallback poll did `fs.statSync` 60×/sec saturating the Node event loop. Heartbeat broadcast at 60fps sent bar+bar+tick (118/120 sends wasted). Dynamic `import("./footprint-engine")` on every MW tick created a Promise microtask chain.
- Action: (1) Pre-resolve footprint import to a module-level `_checkMidTradeDivergence` variable. (2) Slow fallback poll 16ms→100ms. (3) Split heartbeat: 16ms tick-only + 1s bar-state; 16ms path skips `applyTick` entirely.
- Confidence: high

**2026-05-18 — Full 3-strategy signal computation ported to mobile**
- Observation: Mobile `computeSignals` was a simplified vector-crossover-only version (boolean milk zone, no footprint, no tabletop/side-entry, only safe/risky tiers). PC's SignalsPanel.tsx has 3 strategies: Vector patterns (tabletop + side entry = 2pts each), Footprint proxy (deltaAgrees = 2pts, never 4pts in proxy mode), and graduated Milk Zones (3/1/0 pts by proximity).
- Action: Ported `buildProxyFp` (whole-number price bucket synthesis) and `analyzeFp` (simplified: always isProxyData=true, partial=deltaAgrees, vetoed=false) into chart-view.tsx as inline functions. Rewrote `computeSignals` to match PC: graduated milk scoring (milkPtsL/S tracking best zone), vector tabletop + side-entry patterns, fpPts = fpFires ? 2 : 0, totalPts = fpPts + milkPts + vecPts, risk tiers safeplus/safe/risky/riskiest. Added ETH_COOLDOWN=20 for overnight signals. Updated EXIT_STRAT to all 4 tiers per profile. Market break skip: minsUtc [1230, 1320) ≈ 4:30-6pm ET EDT.
- Action: Updated MobileSignal.riskLevel to include 'safeplus'|'riskiest'. Updated WebView setSignals to color-code all 4 tiers (purple/green/blue/orange/red). Updated index.tsx RiskFilter type and filter chips to show all 4 tiers.
- Confidence: high

**2026-05-17 — 7 pipeline bug fixes**
- Observation: `loadMultiDir` gap-fill fabricated synthetic bars from tick files, injecting inaccurate OHLCV into historical data. `onTickFileChange` suppression used a 60s timer (race: timer expires while relay is still connected). `applyTick` used a 15% ratio threshold (too loose for normal fast MES moves, too tight for morning gap-opens). Cache TTL was 45s (live bars invisible for up to 45s after each close). Gap spacers triggered at ALL gaps including normal overnight/weekend session boundaries. Proxy `IMBALANCE_THRESHOLD` was 1.5 (fired on noise). Canvas overlay didn't resize on panel open/close.
- Action: (1) Remove gap-fill tick loop from `loadMultiDir`; warn per gap. (2) Replace 60s timer with `tickRelayConnected` boolean; set on WS connect/close in `live-bars.ts`. (3) Replace 15% ratio with tick-size check: `|price - ref| / TICK_SIZE > MAX_TICK_DEVIATION (50 ticks)`. (4) Cut `TTL.continuous` from 45→5s; call `cacheInvalidate(symbol)` on `bar_persisted`. (5) Gap spacers skip when `prevRth !== currRth` (session boundary) or `gapSec >= 4*3600` (overnight/weekend). (6) Proxy `IMBALANCE_THRESHOLD` 1.5→3.0. (7) Add `ResizeObserver` on `containerRef` to call `drawAll` on canvas resize.
- Confidence: high

**[2026-05-17] — Footprint imbalance threshold + giant teal band fix**
- Observation: `IMBALANCE_THRESHOLD = 3.0` is the mathematical maximum of the proxy bid/ask ratio (max ratio = `0.75/0.25 = 3.0`). Only 1 level per candle fires, stacked clusters (≥2 consecutive) never form → no bright highlighting, no imbalance stripe visible.
- Action: Lower proxy threshold from 3.0 → 2.0. At 2.0, ~41% of body levels flag as imbalanced (relPos ≤ 0.415 means buyRatio ≥ 2.0), creating stacked clusters that activate `#22c55e` text and `#15803d` left stripe. Keep comment explaining the math so future editors don't raise it back.
- Observation: Vector signal band overlays (`rgba(38,166,154,0.06)` per band) accumulate alpha via canvas layering. Many historical signals at the same price level stack to 60–90% opacity — appearing as a "giant solid teal vertical rectangle" in the chart area, especially after a contract roll (many signals from old contract era at same price band).
- Action (two-part): (1) In `CandlestickChart.tsx` band overlay loop, call `ts.getVisibleRange()` and `series.coordinateToPrice()` before the loop; skip any band whose time range ends before the visible window or whose price range is entirely outside the visible price scale. (2) In `market.tsx`, pass `vectorSignals.slice(-15)` to `computeVectorTradeOverlays` so at most 15 bands accumulate. Max alpha = `1 - 0.94^15 ≈ 60%` — visible but not opaque.
- Confidence: high

**[2026-05-18] — MW study reconnection + WebSocket dead-connection fix**
- Observation: After a server restart, the MW TickRelay and AutoTrader studies' WebSocket connections die. The server had NO ping/pong on `/ws/mw-feed`, so dead connections were never detected. `tickRelayConnected` could stay `true` permanently, suppressing the disk-file heartbeat indefinitely — chart goes dark. The order-commands ping existed but never terminated unresponsive sockets (`ws.on("pong", () => {})` was a no-op).
- Observation: `bulk_bars` handler was storing timestamps directly — if MW sends ms-precision timestamps (13-digit), they'd be stored as garbage in the DB (column expects seconds). Added `b.t > 10_000_000_000 ? Math.floor(b.t/1000) : b.t` normalization before validate+persist.
- Action: Added `isAlive` ping/pong with 15s termination to mwWss connection handler. On `terminate()`, the `close` event fires → `setTickRelayConnected(false)` → disk fallback resumes. Added `socketAlive Map<WebSocket, boolean>` to order-commands; ping now terminates sockets that miss a pong. Both fixes ensure stale connections are cleaned up after one missed heartbeat cycle.
- Action: When MW studies do NOT auto-reconnect after server restart, user must remove and re-add the study in MotiveWave (right-click chart → Remove Study → re-add TickRelay / AutoTrader) to re-establish the WebSocket.
- Confidence: high

**[2026-05-18] — ALL MW studies hardcoded to port 5000, server runs on port 3000**
- Observation: TickRelay, LiveBarRelay, AND AutoTrader Java studies all connect to `ws://localhost:5000/ws/...`. The server runs on port 3000. This means ALL three studies were NEVER connecting to the server since the port mismatch was introduced. "AutoTrader not connected" and "chart not live" were both caused by this — not by the ping/pong changes.
- Action: Added a second minimal HTTP server on port 5000 (bound to 127.0.0.1) inside `setupLiveBars`. It handles only WebSocket upgrades for `/ws/mw-feed` and `/ws/order-commands`, forwarding them to the same mwWss and orderWss instances. The main port 3000 server is unchanged. DO NOT change the MW study Java source (it's in the DO NOT TOUCH folder). DO NOT change the server's main port from 3000.
- Confidence: high

**[2026-05-20] — Corrupt candles in DB: MW float32 bar file misreads**
- Observation: MW `.bar_data1` binary parser occasionally produces corrupt float32 OHLCV values. Two failure modes: (1) entire bar body is ~150-450pts below its temporal neighbors (isolated stray candle); (2) low or high field is ~75-100pts outside the open/close range (massive wick spike while body is normal).
- Observation: 417 corrupt MES bars found across all resolutions. Detection method: neighbor-median deviation >120pts for isolated bars (or >400pts for any cluster), PLUS wick extension >75pts on 1m/5m bars. The `bulkUpsert` wick-filter threshold (1.5% of price) was just above the corrupt wick values (~1.35-1.49%), so they slipped through.
- Action: Deleted 417 corrupt rows from `data/app.db` (backed up to `data/app.db.bak`). Added resolution-aware wick guard to `bulkUpsert`: `maxWickPct` = 0.9% for 1m, 1.2% for 5m, 2.5% for 60m. Any bar where lower/upper wick exceeds these thresholds is rejected before DB write.
- Action: Removed all gap spacer code from CandlestickChart.tsx. WhitespaceData import removed; barIntervalSec detection loop removed; GAP_THRESHOLD_SEC removed; spacer insertion loop removed. User wants zero gaps including overnight/weekend.
- Confidence: high

**[2026-05-18] — No-body dot candles + fake huge candle spikes**
- Observation: DB contained 2,934 flat bars (open=high=low=close, zero range) from MW binary files during low-activity ETH periods — these render as single dots in lw-charts. DB also contained 45 doji-wick spike bars with 1.5-5% spread where body <10% of range — a corrupt float32 byte in the `.bar_data1` file creates an extreme wick while open/close stay near real price, appearing as a tall teal/red column on the chart.
- Root cause: `bulkUpsert` only checked `(high-low)/close ≤ 0.05` (5% spread), which passed both flat bars (spread=0%) and doji-wick bars (e.g., 4.96% but with 99% wicked). The `.bar_data1` parser's `low > open` / `high < open` checks don't catch wicks where open≈close near the true price.
- Action: (1) In `baseCandles` and `allBarsForVector` in market.tsx, changed `c.high >= c.low` to `c.high > c.low` (rejects flat dot bars) and added doji-wick filter: `if (range/c.close > 0.015 && Math.abs(c.open-c.close)/range < 0.10) return false`. (2) Same filter added to `bulkUpsert` in mw-reader.ts to prevent future corrupt bars entering DB. (3) Same strict `>` applied to `windowedCandles` live bar filter for transient forming-bar dots.
- Confidence: high

**[2026-05-18] — Phantom spike-and-return bars: third category of corrupt MW data**
- Observation: After deleting all flat bars (16,321) and doji-wick bars (148) from DB, huge-candle artifacts still appeared on the 15m chart. Root cause: a third corruption type — "phantom spike-and-return" bars — where BOTH the bar's price LEVEL is wrong (not just a wick). The midpoint `(open+close)/2` deviates >1.5% from `(prev_close + next_open)/2`. These bars have LARGE bodies (body/range 96%+), so the doji-wick filter (body/range < 10%) never triggers. The 20% neighbor-close filter is also too loose: a bar with low=6749 when prev_close=6972 passes because 6749/6972=0.968 > 0.80.
- Action: (1) Deleted 1,104 phantom bars from DB via Node.js script using `prev_close + next_open` neighbor context. MES/1m: 517, MES/5m: 311, MES/60m: 272, ESM6/5m: 2, ES/1m: 1, ES/5m: 1. DB reduced to 204,312 rows. (2) Added phantom-bar second pass to `baseCandles` in market.tsx AFTER the 20% neighbor check. Two sub-types: close-type (dEnd = `|next.open - cur.close| / cur.close > 0.005`) and open-type (`|gapDir|/pc > 0.01 AND sign(barDir) != sign(gapDir)`). Only rejects when `midDev > 1.5%` AND (close-phantom OR open-phantom). (3) Added same phantom detection to `bulkUpsert` in mw-reader.ts: sort `clean` by time → second loop with neighbor context → reject phantoms before DB insert. Prevents re-insertion when MW bar files are re-read.
- Confidence: high

**[2026-05-18] — Client-side filter alone insufficient — must delete bad bars from DB**
- Observation: Even with client-side doji-wick + flat-bar filters in `baseCandles`, bugs persisted after hard refresh. Root cause: (a) Client filters run on data already fetched from DB — they can't fix bad data that ALREADY IS in the DB if the user has a stale server cache. (b) 15m aggregation in `candleData` useMemo runs `agg5mTo15m(rawCandleData.candles)` on RAW unfiltered 5m bars. A doji-wick 5m bar (e.g., low=6272 stuck value, real price=6925) aggregated with surrounding bars that have a large body can produce a 15m bar where body/range > 10%, slipping past the doji-wick threshold entirely. (c) `fetchGapCandles` WS handler used non-strict `c.high < c.low` (not `<=`), letting flat bars into liveCandles.
- Action: (1) `DELETE FROM cached_candles WHERE high = low` — removed 16,321 flat bars from ALL symbols/resolutions. (2) `DELETE FROM cached_candles WHERE high > low AND (high-low)/close > 0.015 AND ABS(open-close)/(high-low) < 0.10` — removed 148 doji-wick bars. Total: 16,469 bad bars purged. (3) Fixed 15m pre-aggregation filter: in `candleData` useMemo, filter raw 5m bars with flat+doji-wick check BEFORE calling `agg5mTo15m`. (4) Fixed `fetchGapCandles` and `allBarsForVector` live-merge to use strict `<= ` for flat-bar rejection.
- Confidence: high

**[2026-05-18] — Overnight ETH bars invisible at zoom-out = apparent "gaps"**
- Observation: After deleting all phantom/flat/doji bars, chart still showed blank horizontal spaces between candle clusters. Root cause: MW started recording 24/7 in ~Dec 2025. The recent months (Jan-May 2026) have ~35 ETH 15m bars per overnight period between RTH sessions. ETH candle body+wick both used `#26a69a70` (44% opacity on a near-black #05080d background). At any zoom where the price range per ETH bar is < 1 point (~0.5% of chart height), the wick height is sub-pixel and appears completely invisible → the ETH period between RTH sessions looks like blank gap. Older months (Sep-Oct 2025) had 4-6 bars/day total with NO overnight ETH bars, so they appeared continuous.
- Action: (1) ETH wicks now use `t.wickUp`/`t.wickDown` (full-opacity RTH wick colors) instead of the transparent `upEth`/`downEth`. This makes ETH wicks always visible regardless of price move size. (2) Added session boundary markers to `drawAll`: dashed vertical lines (`rgba(90,120,160,0.30)`, [3,4] dash) drawn at every RTH↔ETH transition in `sortedCandlesRef.current`. These visually delineate where each session starts/ends even when zoomed out far.
- Confidence: high

**[2026-05-18] — Refresh button: two bugs (spinner hung + gap in chart after refresh)**
- Observation 1: Clicking Refresh sent `POST /api/admin/reload-mw` which called `await reloadAll()` on the server. `reloadAll()` reads 300 days of tick files and can take 20-30s. Client awaited the response indefinitely → spinner never stopped.
- Action 1: Made `reload-mw` respond immediately (`res.json()` before any await). `reloadAll()` runs in the background via fire-and-forget promise. `cacheFlushAll()` is called both immediately (so the client's next refetch hits the DB) and again after the background reload writes new data. Removed `async` from the route handler since there are no awaits.
- Observation 2: After `setLiveCandles([])` was called in `handleRefresh`, `setWsReconnectKey` fired immediately. The WS reconnected before React re-rendered and the candle `useEffect` rebuilt `_compPairs`. A WS tick arriving during this window used stale `_compPairs` (still had high indices from the previous live bars), placing the forming bar many slots ahead of the last base bar → visible gap in the chart.
- Action 2: Moved `setWsReconnectKey(k => k + 1)` to AFTER `await fetch("/api/live/bar/${sym}")`. The network await yields to the microtask queue, letting React re-render and the candle `useEffect` rebuild `_compPairs` from base-only data. Ticks received after reconnect now use the correct index, placing the forming bar at `lastBaseIndex + 1` with no gap.
- Confidence: high

**[2026-05-20] — DB refresh didn't update chart OHLCV + "Value is null" lw-charts crash**
- Observation 1: After clicking Refresh, `structKey` in CandlestickChart was purely timestamp-based (`first-last-count`). If the DB refresh corrected OHLCV of existing bars but timestamps stayed the same, `structKey` was unchanged → `structChanged = false` → fast path only called `series.update()` on the last bar. Historical corrections were silently ignored.
- Action 1: Added `refreshKey?: number` prop to CandlestickChart. Parent increments it on every handleRefresh call. Chart tracks `prevRefreshKeyRef`; any change forces `structChanged = true` regardless of structKey. Added `refreshKey` to the chart `useEffect` dependency array.
- Observation 2: DB rows with NULL OHLCV (SQLite returns null at runtime even though TypeScript declares `open: number`) passed directly to lw-charts `series.setData()`, triggering "Value is null" at SeriesBarColorer.Candlestick.
- Action 2: Added `Number.isFinite()` guard: skip any bar where `!Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)`. Use `Number.isFinite` not `c.open == null` — the latter fails TypeScript strict mode on `number` typed fields; `Number.isFinite(null)` returns false without TS errors.
- Observation 3: The 10s gate `if (Date.now() - lastRefreshMsRef.current < 10_000) return` in the `data_updated` WS handler was blocking the bulk_bars data_updated that arrives ~5s after refresh (the exact window when MW reconnects and sends fresh data).
- Action 3: Changed gate to `if (!isPostReload && Date.now() - lastRefreshMsRef.current < 10_000) return`. `isPostReload` is set true immediately after the reload POST and cleared after the gate window passes.
- Confidence: high

**[2026-05-20] — Live corrupt bars slip through 2000-tick threshold + corrupt-open bars bypass body-anomaly check**
- Observation: `MAX_TICK_DEVIATION = 2000 ticks` (500 pts) was too loose — corrupt float32 ticks at ~199 pts deviation (796 ticks) slipped through. These created 1m/5m bars with prices 200 pts below true market (e.g., 7183 when market was at 7382). Separately, the LiveBarRelay (bulk_bars path) can send completed bars where the OPEN is corrupted but CLOSE is correct (e.g., O=7280, C=7446), making the mid-price ≈ correct — the body anomaly filter misses these because mid deviation is only 0.9%.
- Action 1: Lowered `MAX_TICK_DEVIATION` from 2000 to 600 ticks (150 pts). Added 30-minute gap bypass: first tick after >30 min of silence skips the check (allows legitimate session gap-opens without blocking the corruption filter during active trading).
- Action 2: Added open-deviation guard to `persistCompletedBar5`: if the new bar's open deviates >2% from the previous bar's close AND the gap is <30 min, reject the bar. Uses `latestBar5` in-memory cache (no DB read). Catches the 7280-open/7446-close corrupt-open pattern.
- Confidence: high

**[2026-05-20] — Body anomaly detection was missing from bulkUpsert reloadAll path**
- Observation: Batch body anomaly detection (trimmed-mean of ±10 neighbors, reject if mid-price >2.5% off) was added to the `live-bars.ts` bulk_bars handler but NOT to `bulkUpsert` in `mw-reader.ts`. The `reloadAll()` / `loadAll()` disk-file path could re-insert the same corrupt body-anomaly bars on every server restart, since MW bar files are re-read from disk.
- Action: Added the same batch body anomaly filter to `bulkUpsert` in `mw-reader.ts`, between the phantom-bar pass and the DB insert loop. Uses identical logic: trimmed-mean of ±10 neighbors, 20% trim, reject if deviation >2.5%. Logs count of rejected bars per call.
- Confidence: high

**[2026-05-20] — AutoTrader OCO bracket order design is correct**
- Observation: AutoTrader.java submits entry + stopOrder + tp1Order + tp2Order together via `submitOrders()`. TP1 is `qty/2` contracts, TP2 is the remaining `rest = qty - qty/2` contracts, stopOrder uses full `qty`. When TP1 fills (partial close), MW adjusts the stop order quantity to match remaining position — this is native bracket behavior.
- Observation: `onPositionClosed` fires when the position fully closes (SL hit, or both TPs filled). It calls `cancelAllOrders(ctx)` which tries `cancelAllOrders`, `cancelAll`, `flattenAll`, `cancelOpenOrders`, `cancelOrders` (zero-param methods) in order. This handles cleanup of any surviving bracket legs.
- Action: No code changes needed. The OCO behavior is correctly implemented via MW's native bracket order system + `onPositionClosed` fallback. DO NOT try to manage OCO server-side — MW handles it at the order level.
- Confidence: high

**[2026-05-20] — iPhone signals didn't match PC: missing server zones**
- Observation: iPhone `computeSignals` used only manually-imported zones (`zonesRef.current`). PC fetches zones from `GET /api/discord-zones`. With no zones loaded, `milkPtsL/S = 0` for all signals → all iPhone signals were RISKY or RISKIEST, never SAFE/SAFE+.
- Action: Added zone fetch inside `load()` in chart-view.tsx: `GET /api/discord-zones?from_ts=X&to_ts=Y&symbol=SYM`. Transform response to `ParsedZone` format using same `rthSettleOfDay` logic as PC (fromTime=posted_at, toTime=rthSettleOfDay(posted_at)). Merge server zones with manually imported zones. Pass merged zones to `computeSignals` AND `window.setZones()` for visual display.
- Observation: PC is the authoritative signal source. iPhone `computeSignals` is a port — keep it in sync with market.tsx.
- Confidence: high

**[2026-05-20] — iPhone chart "server disconnected" + live feed indicator**
- Observation: Any fetch error that didn't match `/50[23]|network request failed|failed to fetch/i` (e.g., iOS TLS errors, HTTP 500, timeout) would display the raw error string permanently with NO retry. The chart stayed stuck on "The certificate…" or "HTTP 500" indefinitely.
- Observation: WebSocket `onclose` in the WebView's `connectLive` silently reconnected after 5s with no user feedback. User had no way to know whether the live feed was connected, reconnecting, or broken.
- Observation: iPhone `computeSignals` had the same milk zone time-bounding bug as the PC code: `c.time < (z.fromTime ?? 0)` with `fromTime=0` meant static zones (Donchian, session open) matched ALL historical candles.
- Action: Made ALL catch-block errors retry with exponential backoff (max 15s). Error message now uniformly shows "Server disconnected — retrying in Xs…" regardless of error type.
- Action: Added `#live-badge` div (bottom-left, `position:fixed`, z-index 30) with `setLiveBadge(true/false)` helper. Shows "● Live" (green) on `liveWs.onopen`, "○ Reconnecting…" (amber) on `onerror`/`onclose`. Shown after first connection attempt; badge is non-blocking (chart stays visible underneath).
- Action: Fixed iPhone milk zone check: `if (!(z.fromTime ?? 0) || c.time < z.fromTime || (z.toTime != null && c.time > z.toTime)) continue;` — same fix as PC.
- Confidence: high

**[2026-05-20] — Zone time-bounding + zonesLoaded indicator + pattern recognition removal**
- Observation: Zones with `fromTime=0` (static structural levels like Donchian/session open) matched ALL historical candles via `c.time < 0 → false`. This caused historical signals to show `milkOk=true` even though no dated session zone was present at that candle's time.
- Action: Added `fromTime > 0` guard to ALL zone loops in `market.tsx` and `SignalsPanel.tsx`. Only MWML/Discord zones with explicit session dates now count for milk zone confirmation. Static zones (gold box, Donchian, session open) are excluded.
- Action: Added `hasDatedZones = activeZones.some(z => z.fromTime > 0)` before the main signal loop. Each signal push now includes `zonesLoaded: hasDatedZones`. SignalDetail panel shows a green "Zones Active" / grey "No Zones Loaded" badge so the user knows whether dated zones were available when the signal computed. If milkOk=true but zonesLoaded=false, a warning is shown.
- Action: Deleted pattern recognition entirely (pure tabletop, side-entry tabletop, tabletop breakdown retest, `findPatternMatches`, `buildPatternVec`, `PatternMatchResult`). Pattern pts removed from scoring. Footprint remains the primary non-milk confirmation (strong=4pts, partial=2pts). Score: FP=4/2 | MilkZone=3 | Vector=2.
- Confidence: high

**[2026-05-20] — "No signals on both programs" — symbol mismatch + risk level filter**
- Observation: PC saves signals to DB with `symbol: selectedSymbol` (e.g., "MES1!"). iPhone fetches with `instrument.toUpperCase()` (also "MES1!"). But the DB had 3,797 signals saved as "MES" (no contract code) from prior sessions. GET/POST routes did `sym.toUpperCase()` only — no normalization. Result: "MES1!" fetch found 0 rows even though 3,797 equivalent signals existed under "MES".
- Observation: Default `chartRiskLevel = "safe"` in market.tsx filtered out "risky" and "riskiest" signals from the SignalsPanel. Without Discord zones loaded, most signals score ≤ 3 pts (fpPts=2 + vecPts=2 only fires when BOTH conditions hit the same candle), so many signals are "risky". User saw blank SignalsPanel and thought no signals existed — chart dots (riskiest = radius 5, alpha 0.35) were too small to notice.
- Action: (1) Added `normalizeSignalSymbol` helper in routes.ts: strips non-letter chars, removes trailing month-code letter (H/M/U/Z). "MES1!" → "MES", "MESM6" → "MES", "ESM6" → "ES". Applied to both GET and POST `/api/signals/history` routes. DB now unifies all contract-code variants under the base symbol. (2) Changed `chartRiskLevel` default from "safe" to "risky" so signals show even when zones aren't loaded. (3) Changed iPhone chart-view.tsx signal fetch to use `sym` (already stripped symbol, e.g. "MES") instead of `instrument.toUpperCase()` ("MES1!") — belt-and-suspenders with server normalization.
- Confidence: high

**[2026-05-20] — iPhone chart mismatch + no live + no signals: all caused by compressed timeline**
- Observation: `DayTrading/components/chart-view.tsx` used sequential integer bar indices (`_timeToIdx`/`_idxToTime`) as the lw-charts `time` field instead of real Unix timestamps. This caused three simultaneous failures: (1) Chart looked different from PC because the time axis used 0,1,2… instead of real times — different gaps and label spacing. (2) Live ticks silently dropped because `connectLive` used `_timeToIdx[liveLastBar.time]` and when a NEW bar formed (timestamp not yet in the map), `tickIdx === undefined` so `candleSeries.update` was never called. (3) Signals all dropped because `setSignals` did `var sigIdx = _timeToIdx[s.time]; if (sigIdx === undefined) continue;` — DB signal timestamps that weren't in the loaded candle window (or any mismatch) caused every marker to be skipped.
- Action: Removed all `_timeToIdx`/`_idxToTime`/`_tToIdx` compressed-timeline code. All functions now pass real Unix timestamps directly: `setChartData` uses `{ time: c.time }`, `setSignals` uses `{ time: s.time }`, tick updates use `{ time: liveLastBar.time }`, bar updates use `{ time: bar.time }`, `drawYellowBox` calls `ts.timeToCoordinate(yboxSessionStart)` directly, `scrollToTime` uses `chart.timeScale().setVisibleRange()` with real timestamps. Added `markers.sort((a,b) => a.time - b.time)` before `setMarkers` since lw-charts v4 requires sorted order. Note: `prependChartData` previously used `_idxToTime` to recover real timestamps from `storedCandles`; after fix, `storedCandles` already holds real-time objects so concat is direct.
- Confidence: high

**[2026-05-20] — iPhone signals tab showed "Switch to Chart to load signals" always**
- Observation: `ChartView` was conditionally rendered (`{segment === 'chart' ? <ChartView> : <View>}`). Switching to the Signals tab unmounted `ChartView`, cancelling in-flight data loads (setting `cancelled = true` in the useEffect cleanup). `onSignals` was never called if the user switched before the 8s signal fetch completed. `chartSignals` state stayed empty. Switching back to Chart caused ChartView to remount and restart from scratch.
- Action: Changed to always render ChartView but hide it with `display: 'none'` when on the signals tab: `<View style={{flex:1, display: segment==='chart'?'flex':'none'}}>`. React Native's `display:'none'` hides the component without unmounting it, keeping the WebView alive and the data load running in the background.
- Confidence: high

**[2026-05-20] — iPhone chart showed wrong/old price data vs PC**
- Observation: iPhone candle fetches had no `from`/`to` query parameters, returning ALL historical data: 161,627 1m bars (~16MB JSON) and 36,501 5m bars. The PC uses a 60-day window (`from`/`to` computed from `windowedDays`). (1) The 16MB 1m bar response would often fail the 15s timeout, so vectors were computed from 5m bars instead — producing different vector values from PC. (2) The initial chart showed 1000 most recent bars (correct) but as prependChartData loaded historical chunks, if the view shifted, the user saw old prices from Sep 2025 (~5700) instead of May 2026 (~7400).
- Action: Added `from=${nowSec - 90*86400}&to=${nowSec+86400}` to both the display candle fetch and the 1m bar fetch. Reduces 1m from 161k to ~13k rows, 5m from 36k to ~3k rows. Chart data now matches PC's 60-90 day window. Same PC fix pattern: `fromTs = nowSec - 90 * 86400`.
- Confidence: high

**[2026-05-21] — 4-section implementation: Current Trade tab, zone directional fix, ML feedback**
- Observation: `display:'none'` on WebView (iOS) prevents native WKWebView layer creation — `chartReady` never fires, data never loads. Fixed: use `opacity:0`+`pointerEvents:'none'` instead, inside a `flex:1` wrapper with `StyleSheet.absoluteFillObject`. This keeps the native layer alive while hiding the view.
- Observation: DB outcome strings are prefixed (`win_tp1`, `win_tp2`, `win_trailer`, `loss`). iPhone code was checking bare strings (`tp1`, `tp2`, `sl`). All outcomes appeared as "Open". Fixed with dual-format boolean flags covering both conventions.
- Observation: `isBullZone()` in both `market.tsx` and `SignalsPanel.tsx` used color-only detection. This failed for MWML zones with neutral/unclear colors. Fixed: added label-text parsing as the PRIMARY classifier — bear keywords (sell/resist/ceiling) take priority over bull keywords (buy/demand/floor). Color is the fallback.
- Observation: Zone "currently IN" scoring was indistinguishable from "just touching bottom" in the milk zone check. Both scored 3 pts. Added 4-pt score for close inside [bottom, top], so zones where price is actively inside get priority over zones just touched.
- Action: Added `signal_labels` table to DB for server-side persistence of user feedback (reason + note + markedBad). Previously annotations were localStorage-only — lost on new browser session.
- Action: Added reason dropdown (8 predefined failure reasons) to SignalDetail edit mode. Annotations now save to both localStorage and `/api/signals/label` server endpoint.
- Action: Confidence score (0-100%) now displayed in signal table rows as a small colored badge (green ≥90, amber ≥75, grey otherwise).
- Action: Added `CurrentTrade` state to `trade-state.ts`. `/api/trade/current` GET returns active trade; set automatically when AutoTrade fires via `/api/trade/execute`. New iPhone `trade.tsx` tab polls this every 5s and shows direction, levels, R:R, elapsed time, and a visual price bar.
- Confidence: high

## Open Questions

- ~~Should the 1m vector be shown on the 5m chart?~~ **Resolved**: Added secondary `useQuery` for 1m data enabled when `showVector && fetchInterval !== "1m"`. All 4 vectors now show on all charts.
- Is the `persistCompletedBar5` function writing duplicate data? It writes to both "5" and "1" resolutions from a 5m bar, but live-bars.ts also calls `persistBar()` on `bar.complete`. May be double-writing.

---

- **Risk tier restructure: SAFE = milkOk alone (with vector gate)** — Previously required 2 votes (milkOk + secondaryVecOk) to reach "safe". Under new spec, the vector gate is always the prerequisite for confluence signals, so milkOk=true is sufficient for SAFE. Change: `longVotes >= 2 ? "safe"` → `milkBullOk ? "safe" : secLongOk ? "risky" : "riskiest"`. This upgrades signals that were previously RISKY (milkOk=true but secOk=false) to SAFE.

- **Strategy guard uses SHA-256 of raw JSON file content** — `crypto.createHash("sha256").update(content, "utf8").digest("hex")`. Hash is computed at init and stored in memory. 60-second interval re-reads files and compares hashes. `authorizedUpdate()` writes new content then updates the stored hash so the next check doesn't flag it.

- **Signal levels must be locked on first fire** — `allConfluenceSignals` is a `useMemo` that recomputes on every candle update. Without `lockedSignalLevelsRef`, the live bar's `c.close` drifts on every tick, shifting TP/SL/entry mid-bar. Fix: `useRef<Map<string, {price,tp1,tp2,sl}>>` keyed by `${time}_${direction}`; first fire writes the lock, subsequent recomputes read it. Never recompute from `c.close` after the lock is set.

- **Zone type label matching O(N×M) → O(log M) with LabelIndex** — The naive `_find_best_label` iterating all 19K labels for each of 14K zones per file = ~280M iterations per file × 23 files = too slow to ever complete. Fix: sort labels by price once into a `LabelIndex`, then use `bisect.bisect_left/right` to narrow to price-range candidates before time filtering. Runs in seconds instead of never.

- **Milk's zone vocabulary (28,709 zones, 23 files)** — The MWML files contain exact zone type labels as `comment` figures paired with each `supportResist` zone. Top types: pivot (2688), seller_objective (1902), floor (1761), ceiling (1589), buyer_objective (1447), non_fair_value (1061), buyer_positioning (751), seller_positioning (742), iv_wall (657). 75% labeled, 25% unknown (neutral zones with no nearby text label). Zone type + strength tier are now ML features; GradientBoosting replaces RandomForest for better handling of categorical zone_type_code.

**[2026-05-20] — Periodic float32 body-anomaly bars: one every ~512 minutes**
- Observation: After initial cleanup (417 bars deleted in prior session), MW float32 corruption continued writing new corrupt bars. 26 more corrupt bars found across 1m/5m/60m resolutions (12+11+3). Pattern: bars appear approximately every 512 minutes (8.53 hours) across calendar time, all with full-body displacement ~3-4% below real price (e.g., ~7145-7185 while surrounding bars are at ~7395-7415). The body looks normal in isolation (3-5 pt range) so wick and flat-bar filters miss it. Client-side phantom-bar filter is unreliable when multiple consecutive bars are corrupt or when the corrupt bar is at the edge of the dataset.
- Action: Deleted 26 bars from DB. Added batch-level body anomaly pass to `live-bars.ts` bulk_bars handler: sort the batch, compare each bar's mid-price to trimmed mean of ±10 neighbors; reject if deviation >2.5%. Only fired during bulk_bars (has batch context); individual bar messages don't have enough neighbors to apply this check.
- Action: Also added `Number.isFinite` guard in `CandlestickChart.tsx` setData loop — `if (!Number.isFinite(c.open) || ... ) continue` — to prevent any null/NaN bar that slips through from causing lw-charts "Value is null" runtime crash.
- Confidence: high

**[2026-05-20] — Reload button blocked by 10s gate it was meant to bypass**
- Observation: `handleRefresh` sets `lastRefreshMsRef.current = Date.now()` then hits the server, which terminates MW WS connections → study reconnects → sends bulk_bars → server persists → sends `data_updated`. The `data_updated` handler had `if (Date.now() - lastRefreshMsRef.current < 10_000) return` — this unconditionally blocked the very bulk_bars `data_updated` that the reload was trying to use (arrives ~5s after click). The prior session added a 60s post-reload window check but forgot to guard the 10s block with it.
- Action: Changed `if (Date.now() - lastRefreshMsRef.current < 10_000) return` → `if (!isPostReload && Date.now() - lastRefreshMsRef.current < 10_000) return`. The 10s debounce now only fires during normal operation (no recent refresh), not during the 60s post-reload window.
- Confidence: high

**[2026-05-18] — Compressed timeline reverted: chart now uses real unix timestamps**
- Observation: Compressed bar-index timeline (`_toChartTime`/`_toActualTime` maps) caused a race-condition gap: after `setLiveCandles([])` in handleRefresh, WS ticks arrived before React re-rendered and rebuilt `_compPairs`, so the live bar was placed at the wrong index (stale high index) → visible gap between base bars and live bar. Also, the compressed timeline produced a chart that looked nothing like MotiveWave/PC, since both use real timestamps.
- Action: Removed the entire compressed timeline block (module-level `_actualToComp`, `_compToActual`, `_actualPairs`, `_compPairs`, `_bisect`, `_toChartTime`, `_toActualTime`). Chart now uses real unix timestamps throughout. Whitespace spacers (3 entries at `barIntervalSec` intervals) are inserted at session breaks (`gap > barIntervalSec * 2`), matching PC gap-spacer behavior. `updateLastBarClose` new-bucket branch directly calls `series.update({ time: bucketSec as any, ... })` — no map extension needed.
- Confidence: high

---

## Milk Zone Vocabulary (learned from daily charts)

Milk draws zones at market open each day. These are fixed predictions — they do NOT move after the open. If price misses a zone, that is new information, not an error.

**Zone type definitions (learned from uploaded charts):**

| Zone Label | Color | Meaning |
|---|---|---|
| IV WALL | Dark red, top | Implied Volatility ceiling — major resistance cap for the day |
| LARGE SELLER POSITIONING | Large dark red block | Heavy institutional selling zone; strong rejection expected |
| SELLER POSITIONING | Red/maroon zone | Standard seller zone; expect resistance / short opportunity |
| TOP SIDE BARRIER / PIVOT | Label on resistance | Structural pivot; key decision level |
| NON FAIR VALUE | Bright green zone | Price is outside fair value here; mean-reversion bias |
| BUYER POSITIONING | Green zone (lower) | Institutional buying zone; expect support |
| BUYERS BUY TARGET ON RNGUP | Yellow line | Projected buy-side target if range expands upward |
| SELLERS SELL TARGET ON RNGDN | Yellow line | Projected sell-side target if range expands downward |
| SELLERS SOFT TARGET ON RNGDN | Secondary yellow line | Weaker/secondary seller target |
| MILK TREND DATA | Bottom zone | Trend reference; where trend support lives |
| BID GAP / BID GAP TOP | Lines | Gap fill levels from prior session |

**Color coding:**
- **Dark red / maroon blocks** = seller zones, resistance
- **Bright green blocks** = non-fair-value or buyer zones
- **Yellow/white horizontal lines** = projected target levels
- **Purple/olive text** = Milk's structural annotations

**Key methodology lessons from charts:**
- Zones are drawn from STRUCTURE (order blocks, FVG, prior highs/lows, implied vol levels) — not indicators
- "Non Fair Value" means price WILL likely revisit the zone; it's not a signal to fade immediately but a magnet
- Seller Positioning + IV Wall stacked = very strong cap; two confluent seller zones reinforce each other
- When price is IN a Non Fair Value zone, expect choppiness; clean signals come at zone EDGES, not middles
- Targets (SELLERS SELL TARGET ON RNGDN) are where Milk expects price to reach IF the daily range extends — not guaranteed, but where momentum carries to

---

## Session Log

**2026-04-19 — Taught by User**
- **Resistance Within TP1 Range**: A long signal failed because a resistance zone at 7165.50 sat only 2.5 pts above entry, effectively blocking price before reaching TP1 at 7166.00 and creating an unfavorable reward structure.
  - Action: Skip any long signal where a resistance level exists within 1.0 pt of TP1 (or between entry and TP1), unless price has already broken and closed above that level on the signal interval before entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-19 — Taught by User**
- **Multi-Zone Resistance Block on Incomplete Confirmations**: When price must travel through multiple resistance zones to reach TP1 and the setup is missing both Milk Zone and Bullish Body confirmations, the probability of stalling before TP1 is high enough to invalidate the trade.
  - Action: Skip any Long signal rated "risky" where Milk Zone ✗ AND Bullish Body ✗ AND there are 2+ resistance zones between entry and TP1, regardless of Primary/Secondary Vector alignment.
  - Confidence: low (single observation — needs more data to confirm)

**2026-04-27 — Chart visualization + proxy footprint**
- **Chart shows old prices after lookback change**: When user changes the lookback slider (e.g. 30d→120d), `intervalKey={interval}` did not change, so `intervalChanged=false` and chart kept the old logical range pointing to Oct 2025 data. Fix: pass `intervalKey={\`${interval}-${windowSize}\`}` so any lookback change triggers the same zoom-reset path as an interval switch.
  - Action: Always include window/context size in `intervalKey` — any parameter that changes the dataset size should be part of the key so the chart resets to last 80 bars.
  - Confidence: high

- **`minBarSpacing: 0.1` causes solid-band compression**: With 3000+ candles loaded (120d of 15m data), `fitContent` / zoom-out collapses bars to sub-pixel widths, displaying as a solid colored band. Fix: `minBarSpacing: 1.0` so bars never go below 1px wide.
  - Action: Never set `minBarSpacing` below 1.0 — lw-charts v5 respects this across all zoom levels including fitContent.
  - Confidence: high

- **OHLCV proxy footprint (`buildProxyFootprintCandle`)**: When real tick-level footprint data is unavailable (no MotiveWave Java code), synthesize FootprintCandle from OHLCV structure: body gets 70% of volume (directionally biased 65/35), wicks get 30% (rejection bias). Proxy delta correctly captures bullish vs bearish pressure for divergence detection. Divergence veto (declining delta on new highs) is directionally valid with proxy — works as a "bearish body structure on new high" pattern filter. Prior candles are synthesized from `sorted.slice(i-4, i)` in the signal loop.
  - Action: Use `buildProxyFootprintCandle(c)` when `fpByTime.get(c.time)` returns null. Real data takes priority when available.
  - Confidence: medium (proxy is approximate; divergence veto may have higher false positive rate than real footprint)

- **Win rate fixes (2026-04-27)**: Four root causes identified and fixed:
  1. **Confidence threshold too low (60→80)**: zone(40)+primaryVec(20)=60 was passing with ZERO secondary confirmation. New threshold 80 requires at least one of: delta-confirmed proxy footprint (fpPartial weight raised 8→20), secondary vector, or full footprint. Pure zone+vector-alone now filtered.
  2. **Bearish candles triggered Long signals**: proxy footprint returns `fpPartial=false` for bearish bars (negative delta), so with threshold 80, bearish-close-in-zone = 60 < 80 → automatically filtered. No separate body check needed — the confidence math handles it.
  3. **Overhead resistance not affecting tier**: Was only setting `reclassifyReason` for display. Now: resistance within 5pts downgrades one tier (safe→risky, risky→riskiest), and riskiest+resistance signals are SKIPPED entirely (no upside room = bad R/R).
  4. **Backtest/monte-carlo no body check**: Added `c.close >= c.open` (longs) and `c.close <= c.open` (shorts) plus `!fp.deltaAgrees continue` to ensure only momentum-confirming candles enter.
  - Action: fpPartial weight stays at 20; threshold stays at 80. Do NOT lower threshold to chase signal count.
  - Confidence: high

- **backtest.tsx + monte-carlo.tsx aligned to strategy rules**: Added 3 missing filters to both backtest engines:
  1. **60m hard veto**: aggregate candles to 60m, build `vec60mMap`, detect decline phases, forward-fill to primary bars via `Math.floor(ts/3600)*3600` bucket key. Any bar in a declining-60m-vector phase skips ALL Long signals.
  2. **HOD suppression**: pre-compute `hodBeforeBar` map (running HOD per RTH day, excluding the current bar's high). Skip Long entries when `c.close >= prevHod - 5`. Uses pre-bar HOD so valid breakout bars that push price through the old HOD are not suppressed.
  3. **Proxy footprint divergence veto**: `buildProxyFootprintCandle(c)` + `analyzeFootprint(fpCandle, direction, priorFp, c.close)`. `fp.vetoed = true` → `continue`. Exit adjustments (POC stop, TP1 override, TP2 extension) applied to tp1/tp2/sl after signal fires.
  - These three filters mirror what `market.tsx` does for live signals — backtest results are now more calibrated to real strategy behavior.
  - Confidence: high


**2026-04-17 — Vector fix: RTH-only bug when showETH=false**
- **Observation**: `vectorLine` useMemo called `computeVectorLine(windowedCandles)`. `windowedCandles` is filtered by `showETH` — so when `showETH=false`, the vector was computed on RTH-only bars. This violates the rule in Patterns ("Vector computation uses ALL bars (RTH+ETH)"), causing staircase values that don't match MotiveWave.
- **Fix**: Added `allBarsForVector` useMemo that takes `candleData?.candles` (all bars, no ETH gate) + merges `liveCandles`, same outlier filter as `baseCandles`. `vectorLine` now uses `allBarsForVector` for computation and forward-fills to `windowedCandles` chart times for rendering. The `showETH` toggle now only affects candle DISPLAY, not vector computation.
- **Confidence**: high

**2026-04-17 — Discord feed: newest messages at bottom (chat style)**
- **Observation**: `[dm, ...prev]` prepended new messages, oldest-first rendered = newest at top. User wants chat-style (newest at bottom).
- **Fix**: `[...prev, dm]` appends; `data.messages.slice().reverse()` on load; `atBottomRef` tracks bottom; auto-scroll on new message when at bottom; "↓ N new" banner at bottom of panel; grouping uses `displayed[i-1]` (prev in oldest-first array).
- **Confidence**: high

**2026-04-17 — Milk Zones (uploaded by user)**
- **Date**: 2026-04-17 (ESM6, 5-min chart, Milk Yellow Box Strategy)
- **Price at upload**: ~7132.75 — trading ABOVE the TOP AVE RANGE / IV WALL / OVN SPY CEILING cluster at 7113.75 (bullish breakout structure)
- **Zone structure from top to bottom:**
  1. **W10 10MIN 10% BAND** (~7144.25–7146.25) — extreme outlier cap; only trade here on major momentum extension
  2. **1% ODDS AT AND ABOVE** (7136.96–7137.00) — statistical extreme; 99% of sessions end below this; hard fade zone
  3. **Structural line** (7125.25) — green horizontal structural reference
  4. **W10 10MIN 70% BAND / 5.36% ODDS** (7114.47–7116.50) — BUYERS ULTIMATE TARGET ON SESSION per chart label; 5.36% probability of reaching/exceeding; active resistance
  5. **TOP AVE RANGE "RESISTANCE" / IV WALL / OVN SPY CEILING** (7113.75) — KEY TRIPLE CONFLUENCE LEVEL; was capping prior sessions; after breakout above = now support
  6. **THUR PR SPLICE IMPRINT** (7108.75–7109.5) — Thursday prior-range splice level; structural reference
  7. **Clustered lines** (7105.75 / 7106.50) — minor structural
  8. **Purple zone** (~7090–7098) — imbalance/structural band; sellers defended here before breakout
  9. **PIVOT** (7078.00) — key decision level; sellers offside at/above; break below = confirm short; 7085.50 is a recent swing high near it
  10. **SELLER OBJECTIVE** (7067.5–7070.0) — sellers target; only loss of this confirms short direction
  11. **SUPPORT / BOTTOM AVE RANGE** (7054–7055.5) — buyers value add on test; supportive first attempts
  12. **SELLER OBJECTIVE cluster** (7054–7058) — seller target cluster overlapping support
  13. **NON FAIR VALUE / THUR PR SPLICE IMPRINTS** (7051) — orange dashes; NFV label; price will revisit if sellers gain control
  14. **PIVOTAL ZONE — BUYER POSITIONING / SELLER OBJECTIVE** (7034–7038) — 7036 is pivotal; buyers absorb sellers first test here; dual label = contested zone
  15. **SELLERS ULTIMATE TARGET ON SESSION / SELLERS OBJECTIVE** (7026–7030) — session low target if sellers win; S VECTOR ~7025.5 nearby
  16. **IV WALL (lower)** (7016.25) — lower IV wall boundary
  17. **FRI WEEKLY CEILING** (~7004.5) — weekly structural floor
  18. **BUYER POSITIONING (extreme)** (7000) — high probability outlier cap downside; ultimate buyer zone
- **Bias read**: Strong BULLISH breakout day. Price broke cleanly above the triple-confluence TOP AVE RANGE / IV WALL / OVN SPY CEILING (7113.75) and is targeting the W10 70% BAND (7114–7116) and potentially 7125. Sellers have statistical edge only at 7136.96+ (1% odds). Buyers defend any pullback to 7113.75 (prior resistance = new support). Shorts only valid on rejection at 7114.47–7116.50 with confirmed bearish structure.
- **Lesson**: When price trades above the TOP AVE RANGE "RESISTANCE" + IV WALL, that level flips to support — bias is long on pullbacks to 7113.75. Short only at the statistical caps (5.36% / 1% odds bands). DO NOT short into the middle of the range.
- **Lesson**: "W10 10MIN X% BAND" levels are statistical caps from Milk's implied-vol model — the % labels (1%, 5.36%, 10%) represent how often price EXCEEDS that level. Fade these levels, especially the 1% level. They define the day's maximum expected range.
- **Lesson**: SELLER OBJECTIVE at 7070 + PIVOT at 7078 cluster = if price pulls back to this area, short setups are viable only if 7078 breaks; above 7078, sellers are "offsides" and buyers remain in control.

**2026-04-17 — Trailer Exit Strategy added**
- Added "Trailer" as a fourth exit strategy option next to TP1/TP2 tiers in the settings panel.
- `EXIT_STRATEGY_PROFILES["trailer"]` uses the same RTH/ETH values as "risky" for activation levels. Removed `as const` since trailer needed a distinct runtime entry.
- `exitStrategy` type extended to `"safe" | "risky" | "riskiest" | "trailer"`. `trailerOffset` state (default 2.0 pts) persisted to localStorage.
- `walkForward` now branches on `exitStrategy === "trailer"`: Phase 1 walks until SL or TP1 activation; Phase 2 tracks `trailPeak` and exits when price retreats `trailerOffset` pts. Outcome `"win_trailer"` added to `CSig`.
- `allConfluenceSignals` useMemo now depends on `trailerOffset` and `lockedSignalLevelsRef.current.clear()` fires on both `exitStrategy` and `trailerOffset` change.
- Auto-trade fetch sends `useTrailer` + `trailingOffset` fields; routes.ts passes them to `broadcastOrderCommand`.
- **AutoTrader.java v17**: `PendingTrade` extended with `useTrailer` + `trailingOffset`. In trailer mode, `submitBracket` places only entry + SL (no TP1/TP2 limits). `onBarUpdate` monitors price: Phase 1 watches for TP1 activation, Phase 2 trails the peak manually. `trySubmitTrailingStop` attempts MW native `createTrailingStopOrder` (4 or 5 params) via reflection when TP1 is hit; falls back to manual tracking if the method doesn't exist. `resetTrailerState()` called on `initialize` and `onPositionClosed`.
- If both Trailer and TP2 are somehow active simultaneously, Trailer wins (enforced at `submitBracket` level — no limit orders placed in trailer mode).

**2026-04-17 — Taught by User**
- **Short Into Visible Support**: Trader shorted near a recognizable support zone with price already extended downward after a large prior candle, leaving minimal room before the support would absorb or reverse the move.
  - Action: Before entering any short signal, check for support zones within 2x the stop distance below entry (i.e., within 10 pts here); if a visible support level exists inside that buffer, skip the trade regardless of Primary Vector or Milk Zone confirmation.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-17 — Taught by User**
- **Resistance Proximity + Approaching Vector (No Entry)**: When price has not yet reached the vector and a resistance level sits within 1.5 pts above entry, the trade lacks room to breathe and the candle pattern confirms continuation toward the vector rather than a reversal off it.
  - Action: Skip any Long signal where (a) Bullish Body confirmation is absent, (b) Secondary TF Vector is absent, AND (c) a resistance level exists within 1.5 pts above entry — instead, wait for price to tag the vector and form a confirmed bullish signal there.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-17 — Taught by User**
- **Resistance Proximity TP Adjustment**: When a reclassify warning flags resistance within 4 pts of entry on a risky long signal, the original TP1 overshoots that resistance, turning a probable winner into a loss.
  - Action: On risky signals where resistance sits between entry and TP1 at a distance ≤ 4 pts, automatically cap TP1 at resistance minus 0.25 pts rather than using the standard TP1 target.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-15 — Data persistence and candle rendering fixes**
- **`DELETE FROM cached_candles` on startup was wiping all historical data** — `server/db.ts` line 86 ran this on every server start, destroying months of Polygon-downloaded candles. Fixed by removing the line entirely. MW's `onConflictDoUpdate` in `persistBulk`/`persistBar` already handles re-syncing live bars without a pre-wipe. Never add a table-wide DELETE on startup for tables that hold persistent user data.
- **Catch-up candle rejection in `bulk_bars`** — MW sends a history dump on reconnect. Added validation: each bar must have valid OHLCV (h≥l, all prices finite and >0) AND its timestamp must be aligned to the declared resolution interval (`t % intervalSec === 0`). Misaligned or invalid bars are logged and discarded. Same validation added to individual live bar messages in `live-bars.ts`.
- **Client-side interval-alignment filter** — `windowedCandles` now also checks `c.time % intervalAlignSec === 0` before merging live bars. A catch-up bar from a reconnect gap would land at an unaligned timestamp and corrupt the bar sequence; this prevents it from reaching the chart or signal computation.
- **Gap-fill on WS reconnect** — Added `fetchGapCandles()` called in `ws.onopen`. On reconnect, fetches the last 4 hours of candles from `/api/data/cached-continuous` and binary-merges them into `liveCandles`, filling any gaps that opened during the disconnect period without creating oversized catch-up bars.
- **Full JSON export/import added** — `GET /api/data/export-full/:symbol` exports all candles + locked signal levels for a symbol as a single JSON file. `POST /api/data/import-full` re-uploads it, appending candles and signals with `onConflictDoNothing` (never overwrites existing data). UI added to Data page as "Export [TICKER] JSON" + "Import JSON" buttons.

**2026-04-15 — Milk Zones (uploaded by user)**
- **Date**: 2026-04-15 (ESM6, 5-min chart, "ES Yellowstone" / Milk's Yellow Box Strategy study)
- **Zone structure from top to bottom:**
  1. **W WALL** — top cap; absolute ceiling for the session, hard resistance
  2. **Sell cluster (multiple stacked)** — several red/orange resistance zones below W Wall; sellers positioned above current price
  3. **NEGOTIABLE** — transition/buffer zone in upper-middle; price may chop through this area
  4. **MLK'S YELLOW BOX STRATEGY** (center label) — the yellow box zone; current structural level
  5. **NEW FAIR VALUE** (green zone) — new equilibrium level established after a range shift; acts as a magnet if price moves away from it
  6. **SECTOR OBJECTIVE** — downside target zone; where the move aims if sellers take control
  7. **BUYER POSITIONING** (teal, right panel) — institutional buy zone; expect support on retests
  8. **SELLER OBJECTIVE** (orange, right panel) — seller's measured-move target
  9. **SELLERS SOFT TARGET ON DIVISION** — secondary/weaker downside target line
  10. **W WALL** — bottom floor; absolute support cap for the session
- **Chart structure observation**: Significant selloff followed by V-shaped recovery. Price is consolidating in the middle zone (yellow box / new fair value area). Bearish resistance stacked above; buyer zones below.
- **Bias read**: Neutral-to-bearish. Price found a "NEW FAIR VALUE" level after a large move — this suggests the range has shifted. Longs are viable only at buyer positioning / W Wall bottom with strong confluence. Shorts viable on rejections from the sell cluster / negotiable zone above.
- **Lesson**: "NEW FAIR VALUE" zone appearing after a large V-move means Milk considers the prior range as mispriced — the new equilibrium is where we are now. Price inside New Fair Value = expect range-bound chop; wait for edges. Zone edges (top and bottom of New Fair Value) are cleaner entry points than the middle.
- **Lesson**: When both a W WALL (top) and a W WALL (bottom) are both visible on the same day chart, Milk is explicitly defining the day's range — do not expect breakouts beyond either wall without major catalyst. Focus on fading extremes.
- **Lesson**: SECTOR OBJECTIVE below current price + SELLER OBJECTIVE on right panel = bearish downside targets defined. If price breaks below New Fair Value cleanly, these are the magnets.

**2026-04-13 — Milk Zones (uploaded by user)**
- **Date**: 2026-04-13 (ES/MES 5-min chart, "ES Yellowstone" study)
- **Zone structure from top to bottom:**
  1. **IV WALL** — top cap, extreme resistance
  2. **LARGE SELLER POSITIONING** — major dark red block just below IV Wall; primary resistance for the day
  3. **TOP SIDE BARRIER / PIVOT** — label at top of structure
  4. **SELLER POSITIONING** — secondary red zone below large seller block
  5. **NON FAIR VALUE** (green) — current price action trading through this zone; mean-reversion magnet
  6. **SELLERS SOFT TARGET ON RNGDN** — first downside target level
  7. **SELLERS SELL TARGET ON RNGDN** — primary downside target if range expands
  8. **MILK TREND DATA** — bottom trend support zone
- **Bias read**: Bearish structure. Price in Non Fair Value with stacked seller zones above. Downside targets defined. Longs are counter-trend and require strong confluence to take.
- **Lesson**: When LARGE SELLER POSITIONING + IV WALL stack at top and price is already in Non Fair Value, the day's bias is SHORT. Any long signals in the Non Fair Value zone should be treated as riskiest-tier only.

**2026-04-13 — Refactor: imbalance removal, pattern expansion, signal persistence, live edits**
- **Imbalances removed from signal votes**: vote system simplified to 2 votes (milkOk + secondaryVecOk). SignalsPanel.tsx and market.tsx both cleaned of all `imbalanceOk` / `significantImbalances` refs. Removing one vote dimension does not require renumbering thresholds — safe/risky/riskiest tiers now just require 2/1/0 secondary votes.
- **Pattern scan size matters**: Tabletop patterns now scan the LARGEST qualifying window (5–20 bars for pure, 5–30 for side). Scanning from MAX down and breaking on first qualifying result finds the largest without O(N²) enumeration.
- **Signal persistence hydration key**: DB signals hydrate `lockedSignalLevelsRef` using `${timestamp}_${direction}` keys. Also hydrate `PureLong_${ts}`, `PureShort_${ts}`, `SideLong_${ts}`, `SideShort_${ts}` keys so that pattern-type signals don't re-fire on page load.
- **Live Edits endpoint safety**: `/api/live-edit` restricts file writes to `client/src/`, `server/`, and `shared/` dirs only — never allow path traversal outside project source.
- **SignalsPanel ExternalSignal type must stay in sync with market.tsx CSig**: Any field added/removed from `CSig.confirmations` in market.tsx must be mirrored in `ExternalSignal.confirmations` in SignalsPanel.tsx, or TypeScript build will silently accept mismatches if fields are optional.

**2026-04-10 — Taught by User**
- **Resistance Within 0.5 pts of Entry (Long)**: A long entry at 6869.50 with resistance at 6869.65 (0.1 pts away) places the trade immediately into supply, negating any vector signal before price can develop.
  - Action: Skip any long signal where a resistance R-zone is within 0.5 pts above the entry price, regardless of vector or milk zone confirmation.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **Resistance Too Close to Entry**: A valid long setup failed because a resistance zone sat only 2.4 pts above entry (less than half the 5.0 pt stop distance), with price already touching it, leaving insufficient room to reach TP1 before hitting supply.
  - Action: Skip any long signal where a resistance zone is within **3.0 pts of entry** (i.e., closer than 60% of the stop distance), especially if candles are already touching or testing that level at signal time.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **Resistance Within 2pts on Entry (No Breakout/Retest)**: A long setup with valid Primary Vector, Milk Zone, and Secondary TF confirmation still fails when unchallenged resistance sits within 2 points above entry, because price is likely to stall or reject before reaching TP1.
  - Action: When a `reclassify warning` flags resistance ≤ 2.0 pts above entry on a long, do not enter immediately — require either (1) a confirmed 1m close above that resistance level, or (2) a pullback retest of the vector tabletop *after* price has cleared the resistance, before triggering the entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **ETH Tabletop Retest Short — Premature Entry Mid-Pattern**: Shorting during an active tabletop retest in ETH produced a loss because the price had not yet resolved direction — entering mid-retest rather than waiting for breakout/rejection confirmation meant taking on maximum directional uncertainty with no Milk Zone support.
  - Action: During ETH, if price is actively retesting a tabletop (support/resistance level) and Milk Zone confirmation is absent, do not enter short; wait for a confirmed breakout or rejection candle close beyond the tabletop before evaluating direction — a completed retest may instead generate a long entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **Mid-Retest Short Entry**: Entering a short while price is actively mid-retest of a tabletop/resistance level (Milk Zone ✗, Bullish Body ✗) invites reversal — the retest wasn't complete, so the level hadn't rejected price yet, and a breakout long became the higher-probability play once the retest resolved.
  - Action: Skip any short signal during ETH where Milk Zone is unconfirmed AND price is visibly mid-retest of a key level; wait for the retest to fully complete (either a confirmed rejection candle closing back below the level, or a clean breakout) before re-evaluating direction.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **ETH Milk Zone signals invalid during RTH**: This Long was taken during RTH (05:40 ET is pre-market/ETH, but the note indicates Milk Zone confluence was absent and the rule is that Milk Zones should only be applied within their respective session — ETH zones for ETH, RTH zones for RTH — meaning an ETH Milk Zone cannot substitute as RTH confirmation and vice versa.
  - Action: When session is RTH, require Milk Zone confirmation derived strictly from RTH price structure; reject any signal where the Milk Zone check references an ETH-origin zone, and additionally skip any signal where the Primary Vector is not within a visually proximate distance to the entry candle (codeable as: vector value must be within X points of entry price at signal bar).
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-10 — Taught by User**
- **Zone Bias Contradiction — Short in Bullish Structure**: A short signal fired with Milk Zone + Vector confirmation, but the trader recognized the zone context implied long bias (bullish body confirmation absent, ✗), meaning the confluences were pointing *against* the trade direction rather than supporting it.
  - Action: Skip any short signal where Bullish Body confirmation is ✗ **and** the trader's zone read implies demand/support (i.e., price is at or bouncing from a Milk Zone from below) — require all four confirmations to align directionally before entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **Tabletop Break Requirement for Early Short Signals**: A short signal firing before price has tested and broken through a tabletop resistance level is premature — the setup is structurally valid but sequentially wrong, as the tabletop must act as resistance first before a short entry has confirmation.
  - Action: Skip short signals where price has not yet touched and rejected (or broken below) the nearest tabletop level above entry; require a visible wick or candle close beyond the tabletop before the signal qualifies as valid.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **Resistance Proximity + Multi-RZone Bearish Confluence = Skip Long**: A long signal taken with resistance only 0.9 pts above entry and multiple resistance zones indicating a bearish trend context resulted in an immediate loss, as overhead supply killed upward momentum before TP1 could be reached.
  - Action: Skip any long signal (especially risky-rated) when a reclassify warning flags resistance within 1.5 pts of entry AND two or more additional R-zones are present above price indicating a bearish trend bias — treat the setup as a potential short candidate instead.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **Vector Tabletop with Opposing Milk Zone Support**: A short signal fails when the primary vector has flattopped (no sustained bearish momentum after retest) AND nearby Milk Zones below entry indicate active support, creating a structural long bias that invalidates the short setup.
  - Action: Skip short signals where the vector has flattopped (last 2–3 vector values are within 1–2 pts of each other with no lower low) AND at least one Milk Zone exists between entry and TP1 acting as support rather than resistance.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **No Bullish Body on 60m Long at 14:30**: A 60m long signal at 14:30 ET with all other confirmations present but missing Bullish Body confirmation resulted in a loss, matching a prior failed 15m trade under the same body-absent condition.
  - Action: Skip Long signals on both 15m and 60m intervals when Bullish Body confirmation is absent, regardless of how many other confirmations are present.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-09 — Taught by User**
- **Downward-sloping vector approaching side-entry**: The vector was already trending down toward its side-entry point, meaning the signal fired one candle early on a deteriorating vector rather than at the confirmed flat/side entry required by the strategy.
  - Action: Skip long entries where the Primary Vector slope over the last 2–3 candles is negative (each vector value lower than the previous), even if the current bar hasn't yet reached the formal side-entry level — wait for the slope to flatten before entering.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-08 — Taught by User**
- **Bullish Body Confirmation is Obsolete**: A "Bullish Body ✓" confirmation was present but the trader has explicitly rejected this as a valid signal filter, preferring pattern-based historical confirmation instead.
  - Action: Remove "Bullish Body" as a confirmation criterion entirely; replace with a pattern-matching filter derived from historical data before re-enabling body-based entry logic.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-08 — Taught by User**
- **Weak Vector Confluence + Low Volume = Skip**: Both vectors lacked strength (primary vector not close enough to signal zone, secondary vectors pressing against tabletop resistance rather than breaking clean) and surrounding candles showed low volume, producing a losing ETH long despite 3/4 confirmations checked.
  - Action: Skip any signal where (a) the primary vector has not reached or crossed the signal level within the last 2 bars, OR (b) secondary vectors are flat/testing a tabletop rather than pointing directionally, OR (c) volume on the signal candle and the 2 preceding candles is all below the 20-bar average volume — require ALL three conditions to be clear before taking a "safe" ETH entry.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-07 — Taught by User**
- **Flat/Tabletopped Primary Vector Without Retest**: A primary vector that has flatlined (zero slope) and whose level has not been physically retested by price (2–3 candle touches) indicates exhausted momentum, not a valid launch point — taking a long here ignores that the vector is offering no directional conviction.
  - Action: Skip any long (or short) signal where the primary vector has been flat for 2+ bars AND price has not physically touched the vector level at least twice since it flattened; require confirmed retest before treating the vector as active support/resistance.
  - Confidence: low (single observation — needs more data to confirm)


**2026-04-06 — AI Trade Analysis**
Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CZoJpkVfZL8W94jk5T4QM"}


**2026-04-06 — AI Trade Analysis**
Error: Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted


**2026-04-05 — Multi-interval vector display**
- Observation: The 1m vector was missing from 5m/15m/60m charts because `iv.sec < sourceSec` filtered it out — you can't disaggregate 5m→1m data. Comparing `fetchInterval === "15m"` also caused a TS error since `fetchInterval` is typed `"1m" | "5m" | "60m"`.
- Action: Add a secondary `useQuery` for 1m data (enabled only when `showVector && fetchInterval !== "1m"`). Use `interval ===` not `fetchInterval ===` for 15m checks. Provide a `base` per interval in the INTERVALS array.
- Confidence: high

**2026-04-05 — CLAUDE.md / LEARNINGS.md location**
- Observation: Files placed in `client/src/components/` are NOT auto-read by Claude Code. Only `CLAUDE.md` at the project root is loaded as persistent instructions.
- Action: Always place CLAUDE.md and LEARNINGS.md at the project root (`/`). Subdirectory copies are ignored.
- Confidence: high



**2026-04-05 — Multi-session (chart, live data, vectors)**
- Observation: `useLayoutEffect` is mandatory for any chart init code. `useEffect` silently produces a 0-height chart.
- Action: Always check for `useLayoutEffect` when chart doesn't render or has zero dimensions.
- Confidence: high

**2026-04-05 — Gap detection for 15m candles**
- Observation: Starting `barIntervalSec = 300` and only decrementing breaks any chart with bars > 300s. The 15m chart inserted spacers between every candle pair.
- Action: Always start gap detection from `Infinity` and find minimum. Cover up to `4 * 3600` to handle 60m bars.
- Confidence: high

**2026-04-05 — autoscaleInfoProvider on indicator series**
- Observation: Vector lines from 90 days of history include price levels 500+ pts below current — auto-scale fits the entire range and compresses current candles.
- Action: All non-candle series (vectors, overlays) must have `autoscaleInfoProvider: () => null`.
- Confidence: high

**2026-04-05 — Dynamic series add causes chart reset**
- Observation: Calling `chart.addSeries()` in a `useEffect` after chart init resets `setVisibleLogicalRange`. Also breaks on chart recreation because useEffect doesn't re-run.
- Action: Pre-allocate ALL series at chart init. useEffect only calls `setData()`.
- Confidence: high

**2026-04-05 — TickRelay disk conflict causes price jumping**
- Observation: `onTickFileChange` was still running even when TickRelay was active. Disk prices (slightly stale) broadcast as `{type:"bar"}` → `setLiveCandles` → re-render → chart jumped back to disk price on every tick.
- Action: `onTickFileChange` must return early when `Date.now() - lastExternalTickMs.get(sym) < 5_000`.
- Confidence: high

**2026-04-05 — Forming-bar broadcast condition always false**
- Observation: `lastTickPrice.set(sym, price)` called before `Math.abs(price - lastTickPrice.get(sym))` check. Difference always 0, broadcast never fires, liveCandles never updated for forming bar.
- Action: Use a throttle (1s) instead of price-change condition. Set `lastTickPrice` inside the throttle or after the check.
- Confidence: high

**2026-04-05 — timestamps.tsx zone divergence from market.tsx**
- Observation: timestamps.tsx used `buildMilkZoneSets()` — a legacy zone algorithm independent of `detectMilkZones`. This produced different bull/bear zone sets than market.tsx, causing confluence signals to differ between the chart and the Confluence tab.
- Action: Replaced `buildMilkZoneSets` with `detectMilkZones(sorted, 0, 0)` + the same label-based isBull/isBear mapping used in market.tsx `allConfluenceSignals`. Also added slope gate (vector must be trending in signal direction) to match market.tsx. Never use `buildMilkZoneSets` — it's dead code.
- Confidence: high

**2026-04-05 — Multi-Vector proximity gate and signal click panel**
- Observation: MV signals were firing with vectors far from price (e.g. 60m vector 33pts away). Far-away vectors represent stale structure and are less predictive. User also requested click-to-inspect and desktop notifications for MV signals.
- Action: Added `MV_PROXIMITY_ATR = 2.5` gate — skip vector vote if `|vNow - close| > atr * 2.5`. Added `voters: string[]` to MVSig so the panel can show "5m + 15m". Added `markerHitsRef` in CandlestickChart — each draw frame records (x,y,SignalClickInfo) for all signal markers. `handleDragStart` hit-tests markers first (14px radius), calls `onSignalClick`. In market.tsx, `selectedSignal` state drives a floating detail panel. MV notifications fire same way as confluence — AudioContext tone (triangle wave, different frequency) + Notification API.
- Confidence: high

**2026-04-05 — Multi-Vector Convergence (MV) signal layer**
- Observation: S/T/R (Side/Tabletop/Reversal) pattern signals were too cluttered and not aligned with the user's mental model. User wanted signals based on vector-candle convergence theory: if 2+ of {1m,5m,15m} vectors are above price AND declining → SHORT; below price AND rising → LONG.
- Action: Removed computeVectorPatternSignals entirely. Added `computeMultiVectorSignals` at module level. Uses `buildMap = forwardFillVector(computeVectorLine(candles), chartTimes)` for each of the 3 intervals, then votes: `shortCount++` when `vNow > close && vNow < vPrev` (above+declining), `longCount++` when `vNow < close && vNow > vPrev` (below+rising). Fires when count >= 2. Separate `lastLong`/`lastShort` cooldown trackers (8 bars). Teal hexagon markers for Long, fuchsia for Short.
- Confidence: high

**2026-04-05 — Separate Long/Short cooldowns are required for all signal systems**
- Observation: A shared `lastBar` cooldown tracker blocks opposite-direction signals within the cooldown window. This suppressed short signals whenever a long had just fired (and vice versa).
- Action: Always use `lastLong` and `lastShort` as separate trackers in any signal generator that emits both directions. A Long at bar 50 must not block a Short at bar 55.
- Confidence: high

**2026-04-05 — Fractal Liquidity Sweep (FLS) signal layer**
- Observation: A new reversal-based signal layer was added independently of the Milk+Vector confluence system. It detects 5-bar fractal swing points, checks for wick-through-then-close-back sweeps, and requires vector agreement.
- Action: `computeFractalSweepSignals` runs on RTH bars only. Same `TP_ATR_MULT`/`SL_ATR_MULT` constants as the confluence system for consistent R:R. Uses 8-bar cooldown (vs 10 for confluence). Diamond markers (orange=Long, purple=Short) distinguish visually from confluence circles (green/red). Dotted TP/SL lines (vs dashed for confluence).
- Confidence: high

**2026-04-07 — Chart glitch: useEffect vs useLayoutEffect for chart init**
- Observation: Chart init was using `useEffect` — DOM dimensions are 0 at that point, causing the chart to render with 0×0 then flash as ResizeObserver corrected it.
- Action: Always use `useLayoutEffect` for the chart init block in CandlestickChart. Must also add `useLayoutEffect` to the React import statement.
- Confidence: high

**2026-04-07 — HTTP poll overwrites WS tick prices (250ms stutter)**
- Observation: The 250ms HTTP poll for futures calls `setLiveCandles(close=pollPrice)` which triggers the candle effect's `series.update(pollPrice)`, overwriting the more granular WS tick price (`updateLastBarClose`). This caused a visible price stutter every 250ms.
- Action: Add `lastWsTickMsRef` in market.tsx. In the HTTP poll merge, when `Date.now() - lastWsTickMsRef.current < 5000`, keep `prev[idx].close` (don't overwrite with HTTP poll close). Only update high/low from HTTP poll. WS ticks via `updateLastBarClose` remain authoritative for close.
- Confidence: high

**2026-04-07 — Whitespace spacer collision guard**
- Observation: CLAUDE.md specifies spacer timestamps must not land on real bar times. The setData loop had no guard, allowing spacers to collide with and silently drop real bars in lw-charts v5.
- Action: Build `realBarTimes = new Set(sorted.map(c => c.time))` before the loop. Before pushing each spacer, check `if (!realBarTimes.has(prev + step * g))`.
- Confidence: high

**2026-04-07 — 60m vector wrong for stocks due to epoch-alignment mismatch**
- Observation: Polygon stores 60m bars starting at 09:30 ET (13:30 UTC). `aggToInterval(base5m, 3600)` uses `Math.floor(t/3600)*3600` which gives epoch-aligned buckets at 13:00 UTC. A 60m bar from 13:00 only covers 13:30-13:55 (partial), while Polygon's 13:30 bar covers 13:30-14:29. The vectors are completely wrong because the OHLC buckets don't match.
- Action: Added `raw60mData` secondary query (enabled when fetchInterval !== "60m", same as raw1mData pattern). Always use `raw60mData.candles` for the 60m extra vector computation — never `aggToInterval(base5m, 3600)`. Fall back to aggregation only if raw60mData hasn't loaded yet.
- Confidence: high

**2026-04-07 — Confluence signals are Long-only**
- Observation: User requested no Short signals from the vector confluence system. Short signals were too noisy and not aligned with the Long-biased strategy.
- Action: After computing `signalDir`, add `if (signalDir === "Short") continue;` before the signal is emitted. This applies to all risk levels (safe/risky/riskiest) and both RTH and ETH.
- Confidence: high

**2026-04-07 — today-signals.tsx had divergent signal logic causing wrong P&L**
- Observation: today-signals.tsx used a 2-component (milkSig+vecSig) system AND still had MV signals and Short signals. market.tsx had been upgraded to a 3-component Long-only system. Result: today-signals showed 0 wins even when the chart had winning trades.
- Action: Rewrote computeConfluenceSignals in today-signals.tsx to exactly match market.tsx's 3-component logic (vecOk required + milkOk+bodyOk+secondaryVecOk bonus). Removed computeMVSignals entirely. Removed isMV from TodaySignal type.
- Confidence: high

**2026-04-07 — SPA navigation unmounts MarketPage, killing notification effects**
- Observation: wouter Switch unmounts inactive routes. When user navigates to /today or /data, MarketPage unmounts — all useEffects stop, including notification and live data effects.
- Action: In App.tsx, render MarketPage ALWAYS (outside Switch) but wrap it in `display:none` when not on "/". Other routes rendered in a separate Switch only when !onMarket. Use `useLocation` from wouter.
- Confidence: high

**2026-04-07 — Primary vector as hard gate; secondary vec as tier bonus**
- Observation: Secondary vectors from other intervals were not participating in signal computation at all — they were display-only. User wanted primary vector (current interval) to be required, and secondary vectors to add a bonus toward tier upgrade.
- Action: In allConfluenceSignals: (1) `if (!vecOk) continue` — primary is hard gate. (2) Compute `secondaryVecOk = extraVecSignalMaps.some(m => c.close > m.get(c.time))`. (3) Tier = bonus(milkOk+bodyOk+secondaryVecOk): safe≥2, risky≥1, riskiest=0. (4) Add `extraVecSignalMaps` as useMemo dependency.
- Confidence: high

**2026-04-07 — Resistance proximity reclassification**
- Observation: User wanted signals that have bearish milk zones within 5.0 pts (20 ticks) above the entry to be downgraded one tier (SAFE→RISKY, RISKY→RISKIEST).
- Action: After tier assignment, loop allMilkZones for bearish types active at c.time. Compute `distAbove = zoneLow - c.close`. If 0 ≤ distAbove ≤ 5.0, downgrade level and store `reclassifyReason`. Break after first match.
- Confidence: high

**2026-04-07 — Section 3: SignalMiniChart tier coloring via riskLevel prop**
- Observation: Signal circle and glow were always green (Long color), regardless of safe/risky/riskiest. No way to visually distinguish tier on mini chart.
- Action: Add `riskLevel?: string` to signal prop in SignalMiniChartProps. Derive `tierRgb` from riskLevel (safe=38,200,122 / risky=245,158,11 / riskiest=239,68,68). Use tierRgb for both the glow gradient and circle fill. Pass `riskLevel: s.riskLevel` from today-signals.tsx row.
- Confidence: high

**2026-04-07 — Section 4: ML prediction fetched on-demand (row expand), not upfront**
- Observation: Pre-fetching predictions for all signals on page load would fire 10+ API calls. Model may not exist yet (returns early with note field).
- Action: Fetch prediction in the row onClick handler only on first expand of that row. Cache in `mlPredictions` state keyed by `${time}-${interval}`. Check `data.note === "no model trained yet"` to return null (no badge). Show ⚠ badge only when `warn: true` (score < 0.45).
- Confidence: high

**2026-04-07 — Section 6: 5m base candles for interval-consistent zones**
- Observation: On 1m chart, detectMilkZones used 1m candles → more micro-zones at different price levels than 5m chart. On 60m chart, used 60m candles → coarse zones. User saw different zones depending on interval.
- Action: Add raw5mForZones secondary query (enabled when showMilkZones && fetchInterval !== "5m"). Compute zoneBaseCandles = raw5mForZones?.candles if on 1m/60m chart, else windowedCandles. Pass zoneBaseCandles to detectMilkZones. Zones now identical between 5m and 15m charts, and use 5m data on 1m/60m.
- Confidence: high

**2026-04-07 — today-signals.tsx Section 1+2: secondary candles passed explicitly**
- Observation: today-signals.tsx doesn't have extraVecSignalMaps infrastructure like market.tsx. To get secondary vector bonus, each interval's computeConfluenceSignals call must receive the OTHER intervals' candle arrays as a second argument and forward-fill them internally.
- Action: Add forwardFillVector back to today-signals.tsx. Change computeConfluenceSignals signature to (candles, secondaryCandles[]). Build secMaps inside the function. Call sites: sigs1m receives [5m,15m,60m], sigs5m receives [1m,15m,60m], etc.
- Confidence: high

**2026-04-07 — .mwml files are a dict with context/instr/graphs keys, not a JSON array**
- Observation: zone_classifier.py initially used regex to find supportResist objects and found 0 zones. Files are ~11MB each, structured as {"context":..,"instr":..,"graphs":..} — NOT an array. supportResist objects are nested deeply inside graphs.
- Action: Use json.load() + recursive _find_support_resist(obj, results) to walk the whole tree. One file has ~15,440 supportResist figures. Total across 23 files: ~29,583 zones after deduplication.
- Confidence: high

**2026-04-07 — SignalClickInfo extended for confirmation detail panel**
- Observation: Signal detail panel only showed a generic tier reason line. User wanted to see which exact components fired and any reclassification reason.
- Action: Extended SignalClickInfo and confluenceSignals prop type to include optional `confirmations: {milkOk,vecOk,bodyOk,secondaryVecOk}` and `reclassifyReason?: string`. The draw loop in CandlestickChart.tsx passes these through to markerHitsRef. Panel renders component list and ⚠ reclassify line.
- Confidence: high

**2026-04-07 — Performance pass: Intl formatter, UTC arithmetic, effect split**
- Observation: Three sources of unnecessary per-render/per-candle work: (1) `new Intl.DateTimeFormat(...)` called inside `isMarketBreak` on every candle = expensive allocation in hot loop. (2) `new Date(c.time * 1000)` called twice per candle in allConfluenceSignals for RTH and closing-hour checks. (3) Two useEffects in CandlestickChart both scheduling drawAll on `drawings` change = double canvas redraw on every drawing mutation.
- Action: (1) Move Intl formatter to module-level singleton `_etFmt`. (2) Replace Date objects with pure UTC arithmetic: `(ts/3600|0)%24` for hour, `(ts/60|0)%60` for minute — no allocations. (3) Split effects: one subscribes pan/zoom only (`[drawAll]` dep), one schedules redraws on data deps only. Each change triggers exactly one `requestAnimationFrame(drawAll)`.
- Confidence: high

**2026-04-07 — isMarketBreak parse via indexOf/parseInt, not split**
- Observation: `_etFmt.format(d).split(":").map(Number)` creates a 2-element array allocation per call. Fine once, but called thousands of times across candle history.
- Action: `const col = et.indexOf(":"); parseInt(et.slice(0, col)) * 60 + parseInt(et.slice(col + 1))` — no array, same result.
- Confidence: high

**2026-04-08 — milkOk MUST compare prices, not just timestamps**
- Observation: `milkBull.has(c.time)` (time-only zone check) marks every candle in the zone's time window as "in the zone" even when price is 50+ pts away. This is observational bias — you're treating temporal proximity as spatial proximity.
- Action: Replace with `c.low <= z.top + MILK_TOL && c.close >= z.bottom - MILK_TOL` where MILK_TOL=2.0 pts. This is the actual "zone test and hold" pattern: wick reached the zone AND close held above it. Compare numbers to numbers.
- Confidence: high

**2026-04-08 — Never cap zone toTime at rthCloseOfDay(from_ts)**
- Observation: `Math.min(z.to_ts, rthCloseOfDay(z.from_ts))` truncates multi-day zones. A zone starting March 29 gets capped at March 29 21:00 UTC. When viewing April 8, `timeToCoordinate(March 29 21:00)` returns a very negative x-pixel → zone is skipped by the `zxR <= 0` guard → zones appear invisible.
- Action: Use `toTime = z.to_ts` always. Milk zones are multi-session support/resistance levels; they persist until broken.
- Confidence: high

**2026-04-08 — Zone rendering must be unconditional (not inside session guard)**
- Observation: Zone drawing loop was inside `if (xStart !== null && xEnd !== null)` — today's session pixel coordinates. ML zones with explicit fromTime/toTime don't need today's session. If viewing historical data where today is off-screen, xStart/xEnd may be null → all zones hidden.
- Action: Move zone loop OUTSIDE the session guard. Only the gap-fill (which needs session width) stays inside. Check: `if (zonesRef.current.length > 0)` unconditionally, then use per-zone fromTime/toTime for x-range.
- Confidence: high

**2026-04-08 — Fixed-point exits beat ATR-based for MES/ES**
- Observation: Monte Carlo on 222 real MES 5m signals shows ATR averages 15.3 pts (range 3.3–45.3). ATR-based SL (0.5×ATR) = 1.6–22.6 pts — completely inconsistent. Fixed TP=10pts/SL=5pts gives 32% WR, 1.16 pts expected. Best combo: TP=20pts/SL=5pts, 4:1 R:R, 2.05 pts expected.
- Action: Use TP_FIXED_1=10, TP_FIXED_2=20, SL_FIXED=5 in both market.tsx and SignalsPanel.tsx. Never use TP_ATR_MULT/SL_ATR_MULT for confluence signals.
- Confidence: high

**2026-04-08 — Signals panel must default to TODAY, not 30 days ago**
- Observation: `defaultStartDate()` returned `d.setDate(d.getDate() - 30)` — signals panel opened 30 days back. User wants today's signals on open.
- Action: `return new Date().toISOString().split("T")[0]` — just today's date.
- Confidence: high

**2026-04-08 — SignalsPanel must receive allConfluenceSignals (not chartRiskLevel-filtered)**
- Observation: `externalSignals={confluenceSignals}` passed the chart-filtered subset — so when chart showed only "Safe" tier, the Signals panel also only showed Safe. The panel should always show ALL computed signals regardless of chart display tier.
- Action: Pass `allConfluenceSignals` (before risk filter) to `SignalsPanel externalSignals`. The panel has its own tier filter internally.
- Confidence: high

**2026-04-08 — detectMilkZones zone toTime must never use dayRthClose cap**
- Observation: Client-side `detectMilkZones` was capping zone `toTime` with `Math.min(..., dayRthClose)`, which truncates FVGs/OBs to end-of-session. When viewing historical data, zones appeared missing because their end timestamp predated the visible window.
- Action: Use `curr.time + N * BAR_INT` for FVG/OB zones and `curr.time + 30 * 86400` for structural zones — no session-end cap. Mirrors the LEARNINGS entry for ML zones (2026-04-08 "Never cap zone toTime").
- Confidence: high

**2026-04-08 — showMlZones should default to true**
- Observation: Default `showMlZones = false` meant zones never appeared on first load — user had to manually click "Milk Zones" button. The strategy depends on zones being visible.
- Action: `useState(true)` so zones are visible immediately on page load.
- Confidence: high

**2026-04-08 — Monte Carlo page added (/monte-carlo route)**
- Observation: User needed a dedicated simulation view with Back Test (signal outcome table + chart markers), Monte Carlo equity curve (canvas-rendered), and a Notes/Edit panel to modify exit parameters and append to LEARNINGS.md.
- Action: Created `client/src/pages/monte-carlo.tsx`. Signal computation mirrors market.tsx exactly. MC runs 500 block-bootstrap iterations client-side. EquityCurve renders on canvas (no extra library). Added `/api/strategy/config` GET/PUT and `/api/monte-carlo/calibrate` POST to routes.ts. Added nav link in market.tsx toolbar.
- Confidence: high

**2026-04-08 — ML zone bands (from DB) cap at 4:30pm ET using rthSettleOfDay**
- Observation: ML zones fetched from the DB (`mlZonesData`) use `z.to_ts` which can extend days forward. The user wants DB zones to end at 4:30pm ET of their start day (settlement), not persist indefinitely.
- Action: `rthSettleOfDay(ts) = Math.floor(ts/86400)*86400 + 20*3600 + 30*60`. Use `toTime: rthSettleOfDay(z.from_ts)` in `mlZoneBands` useMemo in both market.tsx and monte-carlo.tsx. Distinct from `detectMilkZones` (client-side FVG/OB zones) which must NEVER be capped.
- Confidence: high

**2026-04-08 — vectorLine and extraVectorLines must be declared AFTER windowedCandles**
- Observation: vectorLine used `windowedCandles` in both its useMemo callback AND its dependency array `[candleData, windowedCandles]`. `windowedCandles` was declared 230 lines later. TypeScript caught this as "used before declaration" (temporal dead zone). At runtime, the dep array `[candleData, windowedCandles]` would evaluate `windowedCandles` before it was initialized — a real ReferenceError.
- Action: Move the entire vector block (`vectorLine`, `vectorSignals`, `vectorOverlays`, `extraVectorLines`, `extraVecSignalMaps`, and the tradeSegments destructure) to AFTER the `windowedCandles = useMemo(...)` block. Also add `windowedCandles` to `extraVectorLines`' dep array (it was missing, causing a stale closure bug).
- Confidence: high

**2026-04-08 — MC equity curve uses lightweight-charts (time-indexed), not canvas-only**
- Observation: Canvas-only equity curves couldn't be read easily (no axes, no scale). User wanted simulations visible on the chart with a proper equity curve panel.
- Action: `MCEquityChart` component uses `createChart` + 3 `LineSeries` (median/P10/P90) from lightweight-charts. Equity paths are time-indexed: X axis uses real signal timestamps so each point aligns with when the signal fired. Canvas overlay appended inside the chart container renders up to 150 faint individual paths at 6% opacity. `useLayoutEffect` for chart init (mandatory). All series have `autoscaleInfoProvider: () => null`.
- Confidence: high

**2026-04-08 — generateSuggestion grid search for optimal TP/SL**
- Observation: User wanted a "Suggested" button that auto-computes the optimal exit parameters from backtest data instead of guessing.
- Action: `generateSuggestion(signals, tier)` iterates TP_RANGE=[5,7.5,...,20] × SL_RANGE=[2.5,...,8]. For each combo, re-evaluates stored backtest outcomes as proxies: a signal that won with pnl≥tp1 would still win under the new TP1; losses stay losses (conservative). Returns best EV combo as `SuggestedParams`. "Apply to Config" button populates the Notes/Edit panel with the suggested values.
- Confidence: high

## [2026-04-23] — Backtest Adjustments (228 signals)

**Missed / Stopped Out (141)**
- No zone confirmation — vector-only stopped out (×100)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Zone held but momentum failed (×2)
- Resistance 0.5pts overhead (×1)
- Resistance 0.3pts overhead (×1)
- Support 1.8pts below — buyers defended (×1)
- Resistance 3.6pts overhead (×1)
- Resistance 4.8pts overhead (×1)
**Caution / Partial (87)**
- Hit TP1 — stalled before full target (×55)
- Afternoon entry — momentum often faded (×22)
- Late session — expired near close (×10)

## [2026-04-23] — Backtest Adjustments (232 signals)

**Missed / Stopped Out (143)**
- No zone confirmation — vector-only stopped out (×101)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Zone held but momentum failed (×2)
- Resistance 0.3pts overhead (×1)
- Support 1.8pts below — buyers defended (×1)
- Resistance 3.6pts overhead (×1)
- Resistance 4.8pts overhead (×1)
- Resistance 2.5pts overhead (×1)
- Resistance 4.0pts overhead (×1)
**Caution / Partial (89)**
- Hit TP1 — stalled before full target (×56)
- Afternoon entry — momentum often faded (×22)
- Late session — expired near close (×11)

## [2026-04-24] — Backtest Adjustments (232 signals)

**Missed / Stopped Out (143)**
- No zone confirmation — vector-only stopped out (×101)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Zone held but momentum failed (×2)
- Resistance 0.3pts overhead (×1)
- Support 1.8pts below — buyers defended (×1)
- Resistance 3.6pts overhead (×1)
- Resistance 4.8pts overhead (×1)
- Resistance 2.5pts overhead (×1)
- Resistance 4.0pts overhead (×1)
**Caution / Partial (89)**
- Hit TP1 — stalled before full target (×56)
- Afternoon entry — momentum often faded (×22)
- Late session — expired near close (×11)

## [2026-04-24] — Backtest Adjustments (233 signals)

**Missed / Stopped Out (143)**
- No zone confirmation — vector-only stopped out (×101)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Zone held but momentum failed (×2)
- Resistance 0.3pts overhead (×1)
- Support 1.8pts below — buyers defended (×1)
- Resistance 3.6pts overhead (×1)
- Resistance 4.8pts overhead (×1)
- Resistance 2.5pts overhead (×1)
- Resistance 4.0pts overhead (×1)
**Caution / Partial (90)**
- Hit TP1 — stalled before full target (×56)
- Afternoon entry — momentum often faded (×22)
- Late session — expired near close (×11)
- Open — session not yet resolved (×1)

## [2026-05-17] — PC chart candle corruption + iPhone Yellow Box / Footprint overhaul

**MESU6 price contamination (PC chart)**
- Observation: MESU6 (Sep 2026 contract) bar files were being loaded and merged with MESM6 (Jun 2026), producing candles with ~15-20 pt price gaps mid-day. Root cause: `getContractDirs` included all `MES*.CME` dirs regardless of contract state.
- Action: Filter contract dirs using tick-file presence — only dirs containing at least one `.tick_data` file are valid. MotiveWave only writes tick files for the active/recently-active front-month, so MESU6 (not yet front-month) has no tick files and is excluded naturally. After applying: deleted 215,916 contaminated DB rows and reloaded — 170,663 clean bars from Sep 2025 onward.
- Confidence: high

**Sparse bar files creating false FVG zones (PC chart)**
- Observation: Jul–Nov 2025 MESM6 bar files had 3–370 records per file (weekly-summary sparse files). Pairs of bars days apart created massive false imbalance zones in `detectMilkZones`.
- Action: (1) `getBarFiles` size filter — skip any `.bar_data1` file < 10,000 bytes (~300 records). (2) Gap check in `detectMilkZones` after ATR calculation — skip any FVG triplet where `next.time - prev.time > 6 * BAR_INT` (30 min for 5m chart). Both filters are required; either alone misses edge cases.
- Confidence: high

**Zone cascade causing zones to always show (PC chart)**
- Observation: `showMlZones` was persisted as `true` from a prior session. `mlZoneBands` fell back through `activeZones` → `clientMilkZones` cascade, so zones always appeared on load even though the user wanted a clean chart by default.
- Action: Changed `showVector` and `showMlZones` defaults to `false`. Added `migrateSettingsV3` IIFE to force-clear old persisted `true` values from localStorage on first load (keyed by `mwb_ui_v = "3"`). This is a one-time migration — subsequent loads read the stored (now false) values directly.
- Confidence: high

**iPhone Yellow Box — pivot levels from previous RTH H/L/C**
- Observation: The old chart-view had no Yellow Box implementation. MotiveWave's Milk Yellow Box study draws key levels at RTH open each day based on prior-session price structure.
- Action: Added `computeYellowBoxLevels(rawBars)` — computes 13 classic floor-trader pivot levels (P, R1/S1, R2/S2, IV Wall, Seller/Buyer Objectives, Weekly Ceiling, FRI Ceiling, Max Range/Trend) from yesterday's RTH H/L/C. `drawYellowBox()` renders dark olive/green session background (`rgba(50,70,15,0.20)`) + labeled horizontal lines with color-coded pills. Session is constrained to today 13:30–20:30 UTC (9:30 AM–4:30 PM ET).
- Action: Level labels map Milk's vocabulary: R1=RESISTANCE, S1=SUPPORT, P=Pivot, R2=Non Fair Value Upper, S2=Non Fair Value Lower. IV Wall = midpoint(P, R1). These are floor-trader pivots, not MotiveWave's proprietary formula — may need tuning if levels don't match exactly.
- Confidence: medium (formula approximates Milk's output; exact match requires MotiveWave source)

**iPhone Footprint — real bid/ask delta from server**
- Observation: Old `setFootprintVisible` only showed/hid a text badge — no actual footprint data was rendered.
- Action: Replaced with `setFootprintData(candles, visible)` API. `drawFootprint()` renders per-candle delta badges (green=positive, red=negative) and imbalance tick markers at price levels from `candle.imbalances[]`. Added footprint `useEffect` that fetches from `/api/footprint/history/${sym}/${fetchInterval}` first; falls back to OHLCV synthetic delta (close-open ratio × volume) when server returns empty (no MotiveWave footprint relay connected).
- Confidence: medium (real data requires MotiveWave footprint_bar study to be connected and sending WS messages)

## [2026-05-05] — Backtest Adjustments (262 signals)

**Missed / Stopped Out (153)**
- No zone confirmation — vector-only stopped out (×115)
- Entry near HOD — limited upside (×22)
- Entry near LOD — bounce risk (×12)
- Resistance 1.5pts overhead (×1)
- Resistance 4.8pts overhead (×1)
- Zone held but momentum failed (×1)
- Resistance 1.8pts overhead (×1)
**Caution / Partial (109)**
- Hit TP1 — stalled before full target (×66)
- Afternoon entry — momentum often faded (×31)
- Late session — expired near close (×11)
- Resistance at 7235.00 capped the run (×1)


**[2026-05-22] — Footprint chart + Milk Zones display fixes**
- Observation: The WebView chart (`buildHtml()`) had NO footprint canvas at all — `buildProxyFp()` only fed signal scoring, never visual rendering. The footprint `strategies.footprint` toggle existed in context but had no WebView effect.
- Action: Added `fpCanvas` (z-index:7, below zones/ybox), `drawFootprint()` function, and `window.setFootprintData()/setFootprintVisible()` to the WebView HTML. Footprint cells use `priceToCoordinate(price±0.5)` for exact y-bounds per integer price level. Imbalance colors: buy=green 40% opacity, sell=red 40%, neutral=dark 55%. POC highlighted with gold border. Delta right-side label in green/red. Bars skip rendering when `barPx < 18` (too zoomed out to read). In `load()`: tries `GET /api/footprint/history/:sym/:interval` for real DX Feed data first, falls back to `buildProxyFp()` on OHLCV for last 100 candles. Payload stripped to minimal fields (price, bidVol, askVol, imbalance, candleDelta, poc, high, low) to stay under WKWebView injection limit.
- Observation: Milk Zones were loading 30 days of zones (`fromTs = now - 30*86400`), causing all historical zones to draw as simultaneous full-width bands across the chart — completely unreadable.
- Action: Changed `fromTs` to `Math.floor(Date.now()/1000/86400)*86400` (today midnight UTC). Changed `toTime` on each zone to `todayMidnightUtc + 20*3600 + 30*60` (today's RTH settle). Applied `strategies.milkZones` boolean to the `setZones(allZones, visible)` call so the toggle actually hides server-side zones (was previously always `true`). Increased zone fill alpha from 0.18 to 0.25 for slightly better mobile visibility.
- Confidence: high

**[2026-05-23] — Complete UI enhancement: design tokens + all screens**
- Action: Updated `DayTrading/constants/theme.ts` with new design tokens: accent `#3d8ef8`, green `#00e676`, red `#ff4444`, purple `#a78bfa`, border `#1a1a1a`, surface `#0d0d0d`, text `#ffffff`, muted `#888888`. Added new keys: `dim`, `borderDefault`, `surfaceCard`, `gold`. These cascade to all screens automatically via `Trading.*` references.
- Action: `strategy-toggle.tsx` — pill shape (borderRadius 999), iOS shadow glow when active (shadowColor = strategy color, shadowRadius 6, shadowOpacity 0.45).
- Action: `_layout.tsx` — tab bar pure black `#000000`, border `#1a1a1a`, active tint `#3d8ef8`, inactive `#444444`. Updated Explore tab to About with `info.circle.fill` icon.
- Action: `app/index.tsx` (welcome) — title 44px weight 900 letterSpacing 6, subtitle italic gray `#888`, timeframe pills (borderRadius 999), instrument input terminal-style `#c8ffd4` text, Open Chart button blue with shadow glow.
- Action: `(tabs)/index.tsx` (signals) — updated `C` palette to new design tokens, pill timeframe buttons, `C.dim` for filter/header labels, `rlColor`/`ocColor` helpers updated to use `C.up`/`C.down`.
- Action: `(tabs)/journal.tsx` (AutoTrader) — section labels with `#111` border separator, strategy card borderRadius 14, animated pulse dot when connected (Animated.loop scale 1→1.6→1).
- Action: `(tabs)/settings.tsx` — instrument input `#c8ffd4` terminal color, URL input `#a0c4ff` light blue, Save URL button full-width blue with glow, ghost Back button.
- Action: `(tabs)/trade.tsx` — `LoadingCard` with spinner + "Awaiting trade data…" + three skeleton rows (replaces bare ActivityIndicator).
- Action: `(tabs)/explore.tsx` — replaced default Expo explore screen with About screen: app info card, signal tiers with color dots, strategy descriptions.
- Note: Custom fonts (Barlow Condensed, DM Sans, JetBrains Mono) NOT installed — spec calls for them but installation requires expo-font setup + font files. Mono font applied via `Fonts.mono` system alias (ui-monospace on iOS). Display headers use system fontWeight '900' which is visually close.
- Confidence: high
