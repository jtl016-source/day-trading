# Learnings

## What Has Worked
- (Nothing recorded yet)

**2026-06-02 — Footprint ladder anchoring (CandlestickChart.tsx)**
- Observation: Session footprint ladders are meant to anchor to each session's FIRST candle (`candleFootprints`/`fpMap` is keyed by `sg.candles[0].time` in market.tsx:2334; ladder loop draws at `ts.timeToCoordinate(fp.time)`). A separate block pinned the most-recent completed session's ladder to the RIGHT EDGE (`renderFpLadder(prevSessionFp, cw - C_TOT - 2)`), overriding the first-candle anchoring the block's own header comment describes.
- Action: To get "ladder on the first candle of each session," REMOVE the right-edge pinned `prevSessionFp` block (+ its `visPriceTop`/`visPriceBot` calc and the dedupe-skip guard in the per-session loop). The per-session loop alone (`for (const fp of allAggsFp) renderFpLadder(fp, xf)` with `xf<0||xf>cw` off-screen guard) renders every session's ladder on its first candle. Ladders intentionally disappear when the first candle pans off-screen — that's the design.
- Confidence: high

**2026-06-02 — Footprint ladder must span full session HOD→LOD (CandlestickChart.tsx)**
- Observation: `renderFpLadder` row sampler `visible.filter((lv,i)=> i%skip===0 || lv.price===fp.poc)` always keeps index 0 (session HIGH/HOD) but DROPS the last index (session LOW/LOD) unless it lands on a `skip` multiple — so when zoomed out the ladder reached the HOD but stopped a few rows short of the LOD. Session levels themselves already span low→high (`prices[0]`=low, `prices[last]`=high in market.tsx buildAggregate), so the data was fine; only the sampler truncated.
- Action: add `|| i === visible.length - 1` to the row filter so the lowest visible level is always drawn. Top row already = highest visible level. The outer border uses rows[0]/rows[last], so the column now spans HOD→LOD. Zones (Step 1 imbalance bands) and ladders (Step 2) both render whenever `showFpPanel` is on — there is NO separate zones/ladder mode toggle.
- Confidence: high

**2026-06-02 — Footprint imbalance zones must be CLUSTER-sized, not per-bucket (CandlestickChart.tsx)**
- Observation: The "new UI change" (commit jump 8a3ae11 → 3d93296, "sync latest local changes") rewrote Step-1 footprint zones from cluster-based to per-2pt-bucket bands + added a right-edge pinned ladder. User wants the pre-change behavior: each zone = the SIZE of the imbalance on the ladder.
- Action: Restore the 8a3ae11 Step-1 logic — iterate `zfp.imbalances`, draw only `cl.stacked` clusters as a full-width band spanning `cl.startPrice`→`cl.endPrice` (±0.5), full opacity for the on-screen/current session and 0.28 for historical, tier opacity (×1.0/1.4/1.8), and DROP historical zones once a later candle CLOSES through the cluster midprice (inline binary-search mitigation over `candlesRef`, cutoff `zfp.time + 25000`). The ratio≥1.3 / net≥100 / stacked=2+ rules live upstream in market.tsx `buildAggregate` (`imbalances`). To find the "before" code, `git show 8a3ae11:.../CandlestickChart.tsx`.
- Action: Ladder stays anchored to each session's FIRST candle (no right-edge pin) and spans HOD→LOD (keep the `i === visible.length - 1` row so the LOD row isn't dropped by the `skip` sampler). `fmtVol` is defined once at the outer footprint scope (~L1544) — do NOT redefine it when editing the session block.
- Open: kept the current 80px net-delta single-column ladder (documented user preference) rather than the 8a3ae11 175px two-column bid×ask|total. Flagged to user.
- Confidence: high

**2026-06-02 — Terminal live charting must bucket to the display interval (useTerminalData.ts)**
- Observation: The MERIDIAN terminal's own chart (pages/terminal.tsx → TerminalLiveChart, fed by hooks/useTerminalData.ts) drove candles independently of market.tsx. Two bugs: (1) live `bar` messages arrive at resolution "5" for a 15m chart but were appended at the RAW 5m time with REPLACE semantics → 5m candles misaligned onto 15m history and lost the bucket's accumulated high/low; (2) the `tick` handler only edited the last candle (no rollover), so 15m/60m never opened a new candle from ticks (the server emits only 1m/5m bars, never "60").
- Action: Mirror market.tsx. Bar handler: bucket 5m→15m (`Math.floor(t/900)*900`, accept "5" or exact "15"), and MERGE on same bucket (keep open, max high, min low, new close) instead of replace. Tick handler: compute the display bucket from `Date.now()` (`ivSecs`), append a NEW candle when `bucket > last.time` (seed open from tick on >0.5% gap, else last close), clamp >2% single-tick prints only WITHIN the bucket. Keep a `lastBarRef` mirror of the tail candle so both handlers bucket/merge without depending on setState `prev`.
- Note: market.tsx's engine chart (candles + live: validate OHLCV, 20% outlier reject, binary-search merge, useLayoutEffect init, series.update() fast path with bucketSec rollover) was already correct — left untouched. Verified `npm run check` + `npx vite build` clean. The full `npm run build` fails only on a PRE-EXISTING server esbuild error (top-level await in server/routes.ts + cjs output) — unrelated to the chart; dev (`tsx`) runs fine.
- Confidence: high

**2026-06-02 — Terminal chart drifts stale / drops candles without a reconcile poll (useTerminalData.ts)**
- Observation: The terminal chart only loaded candles on mount/reload and relied on live WS `bar`/`tick` + `data_updated`. Unlike market.tsx (which re-polls the DB as a fallback), there was NO reconciliation — so any `bar` missed during a WS hiccup/reconnect was lost permanently → "a candle is missing" + chart looks frozen ("not live anymore"). Compounded by the pre-fix 15m bucketing bug (now fixed) that had been mis-appending live bars.
- Action: Added a 15s `reconcile()` poll in useTerminalData — re-fetch `/api/data/cached-continuous` and MERGE server bars into the array (preserve the live forming candle when `live.time >= lastServerTime`), keeping `lastBarRef` in sync. Gated on `!document.hidden`. This recovers any missed bar and keeps the chart matching the engine DB. The forming candle is NOT clobbered.
- Action: Fixed the misleading LIVE/DELAYED badge. It was `live = open(RTH) && source` → ALWAYS "DELAYED · ETH" outside 9:30–16:00 even when futures stream live in ETH. Now useTerminalData consumes the server's `feedStatus` WS message (live/stale/unknown) and exposes it + `connected`; MarketView computes `live = connected && hasSource && feedStatus !== "stale"` (RTH/ETH is just the session suffix). Defaults optimistic when feedStatus is "unknown".
- Confidence: high

**2026-06-02 — Real-data footprint in the terminal + Info tab + news ticker**
- Footprint: the terminal chart (`TerminalLiveChart.tsx`) now renders the OLD on-chart footprint
  (session ladder anchored to each session's first candle, full HOD→LOD, net-delta column +
  cluster imbalance ZONES sized to the cluster) as a `<canvas>` overlay synced to the
  lightweight-charts v5 time/price scales (`subscribeVisibleTimeRangeChange` + ResizeObserver +
  data effects, coalesced via one rAF in `drawFpRef`). Fed by REAL data: `/api/footprint/history`
  → `footprintAggregate.ts aggregateSessions()` groups real per-candle MW footprints into RTH/ETH
  session aggregates (POC/VA/clusters), a port of `market.tsx buildAggregate` but summing real
  `levels` bid/ask instead of `buildProxyFootprintCandle`. Replaced the old POC/VAH/VAL price-lines.
  `.tt-livechart` is `position:fixed` so an `inset:0` canvas anchors to it.
- Info tab: expanded `strategyMeta.ts` (added `title/tagline/how/signals/tips` + `SIGNAL_OVERVIEW`),
  new `InfoView.tsx`, `Ico.info`, and a 4th `"info"` tab in `terminal.tsx`.
- News ticker: server `GET /api/news/ticker` (in `routes.ts`) fetches free RSS (Yahoo/NYT/WSJ/
  CNBC/MarketWatch + Google-News RSS search for Morning Brew & Berkshire), parses with
  `fast-xml-parser`, upserts into the existing `news_articles` table (url unique →
  onConflictDoNothing), returns newest 40, cached 10 min, and falls back to the DB on feed
  outage. Client `NewsTicker.tsx` = CSS marquee (duplicated track + `translateX(-50%)`, pause on
  hover), clickable `<a target="_blank">`, mounted under the header. Verified all feeds return
  200 and parse (Google-News `<source>` resolves the real publisher).
- Verified: `npm run check` (tsc) clean, `npx vite build` clean. Server routes (spike-filter fix
  + news ticker) need the dev server (tsx) to reload to take effect; full `npm run build` still
  fails only on the pre-existing server esbuild top-level-await (unrelated).
- Confidence: high

**2026-06-02 — Market HUD made draggable + resizable (MarketView.tsx)**
- Observation: the "MES front month · futures" panel (`.tt-hud`) was in normal flow inside
  `.tt-view`, which animates with `transform` (viewIn) — so making it `position:fixed` in-place
  would jump on tab-enter (a transformed ancestor becomes the fixed containing block).
- Action: render the HUD via `createPortal(..., document.body)` so it's always viewport-fixed
  (no transformed ancestor). Drag-to-move (pointerdown anywhere except buttons/links/inputs/the
  resize grip) + a bottom-right resize grip (`.tt-hud-resize`), via window pointermove/up
  listeners created per-drag. Position/size persisted to localStorage `meridian_hud_box`
  ({x,y,w,h}); double-click empty area resets to default. Inline `maxWidth:"none"` overrides the
  `.tt-hud` 760px clamp; `zIndex:6` floats above chart(0)/footprint(5). Default x=240 clears the
  now-left-side footprint panel. `.tt-fp` was also moved right→left (`left:14px`).
- Confidence: high

**2026-06-03 — Milk zones restored to the old filled-band render + HUD close button**
- Observation: the terminal drew milk zones as thin top/bottom `LineSeries` segments (a pool of
  24 line series, time-bounded to the RTH session). The "perfect" pre-UI-change look was the
  CandlestickChart canvas render: a filled rect fromTime→toTime, fill/border/label colors derived
  from `zone.color` (rgba → #hex via hexToRgba → support/resist keyword), top/bottom price labels,
  zone-name label, anchored via a px-per-sec estimator (`estX`) so off-screen-anchored zones still
  render. Data source unchanged (PNG-upload only via lib/milkZones.ts — the rule holds).
- Action: ported that exact band render into TerminalLiveChart's overlay canvas (drawFootprint),
  drawn BEFORE the footprint so footprint sits on top. Removed the LineSeries pool
  (`zoneEdgeSeriesRef`/`ZONE_POOL`) + its effect; the milk-zone effect now just calls
  `scheduleFpDraw()`. Added refs `milkOnRef`/`milkZonesRef` + a `hexToRgba` helper. The overlay
  draw no longer early-returns on `!fpOn` — it clears, draws zones if MilkZone on, then footprint
  if Footprint on. MilkZone `{top,bottom,fromTime,toTime,color,label}` maps onto the old
  `{topPrice,bottomPrice,...}` fields inline. Skipped the old gap-fill (only applied to zones with
  NO fromTime/toTime; terminal zones always have both).
- Action: MarketView HUD got an ✕ close button (sets persisted `hidden`); when hidden a small
  "▣ SYMBOL" restore chip renders at the saved position (portal to body); double-click empty panel
  resets position/size.
- Confidence: high

**2026-06-04 — Signal parity check + clickable chart signals (terminal)**
- Observation: signal FIRING is engine-side and unchanged — `App.tsx` keeps `MarketPage` (the
  legacy engine) ALWAYS mounted (display:none) doing signal computation + WS + auto-trade; the
  terminal is a pure consumer of `/api/signals/history`. The Signals TAB already had full parity
  (click row → `SignalDetail` = exit strategy levels + R:R + P&L + confirmations + footprint
  reading + `SignalMiniChart`). The only gap: chart signal markers weren't clickable.
- Action: extracted `SignalDetail` (+ `statusColor`) to `components/terminal/SignalDetail.tsx`
  (shared by SignalsView + the chart). Added `chart.subscribeClick` in TerminalLiveChart's init
  effect: match the click x to the nearest signal's `timeToCoordinate(ts)` within 16px → fire
  `onSignalClick(signal)` (via `signalsRef`/`onSignalClickRef` so the once-subscribed handler
  stays current). terminal.tsx holds `chartSig` state, passes `onSignalClick={setChartSig}`, and
  renders `<SignalDetail>` — so clicking a marker on the Market chart opens the same detail
  (exit strategy + mini chart) as the Signals tab. Works on the Market tab because
  `.tt-main.passthrough` is pointer-events:none, so clicks fall through to the chart.
- Confidence: high

**2026-06-04 — Signal click → visual TP/SL lines on chart + AutoTrader Settings card**
- Observation: "see the exit strategy" meant the VISUAL horizontal price-lines on the main chart (like the old CandlestickChart), not a modal.
- Action: ported `renderConfluenceSegment` from CandlestickChart.tsx into the terminal's overlay canvas `drawFootprint`. When a signal is selected (`selectedSigRef`), draws colored horizontal lines (TP2/TP1/Entry/Stop), labelled with price, + colored fill bands for profit/risk zones spanning entry→right edge. Redraw triggered by a dedicated `useEffect([selectedSig])`. `onSignalClick` now passes `null` when clicking empty space (clears selection). Click same signal again also clears. `Escape` key clears. The click matcher was changed from pixel-distance (16px threshold — too tight) to time-based (`param.time` vs `signal.ts`, within 2 bar intervals) + fallback pixel at 60px. `TerminalSignal` uses `entry` (not `price`) — confirmed.
- Action: added `AutoTraderCard` to SettingsView.tsx — polls `/api/trade/status` + `/api/trade/current` every 5s for connection/trade state; loads settings from `/api/trade/settings`; ARM/DISARM button (POST enabled:true/false); contract type (MES/ES), contracts per trade (1–10), direction (Both/Long/Short), exit mode (TP1+TP2 / TP1 Only). Live warning banner when enabled.
- Confidence: high

**2026-06-04 — Live signals not appearing in terminal (two root causes)**
- Observation: Signal engine (market.tsx line 3040) had `if (s.outcome === "open") return false` — newly fired signals were NEVER written to DB until they already closed. So the terminal received `signal_new` broadcast and fetched from DB, but the signal wasn't there yet. Also useTerminalData had no periodic signal poll, so a missed WS broadcast meant the signal never appeared.
- Action 1 (market.tsx): change dedup key to include outcome: `${sym}_${iv}_${time}_${dir}_${outcome}`. This lets signals be written TWICE — once on first fire (outcome=open, terminal sees it immediately) and again when outcome resolves (upsert updates to win/loss). Removed the `outcome === "open"` skip entirely.
- Action 2 (useTerminalData.ts): added 30s `fetchSignals` poll (like the 15s candle reconcile) so signals are refreshed even if `signal_new` WS broadcast is missed or arrives before the DB write completes.
- These two fixes together: live signal fires → immediately persisted → signal_new broadcast → terminal fetches → signal appears with outcome=ACTIVE. When it closes → re-persisted with win/loss outcome → terminal updates at next poll or next signal_new.
- Confidence: high

## What Has Failed
- (Nothing recorded yet)

## Patterns and Preferences
- (Nothing recorded yet)

## Open Questions
- (Nothing recorded yet)