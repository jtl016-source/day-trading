# CLAUDE.md — Milks Yellow Box Strategy Viewer
# Generated 2026-04-28 — Full context for new sessions

---

## BEFORE STARTING ANY TASK
1. Read this entire file before touching code
2. Apply all "What Has Worked" — avoid all "What Has Failed"
3. After completing work, append a dated entry to LEARNINGS.md

---

## Project Overview

**Full-stack day-trading strategy viewer** for ES/MES futures (Micro E-mini S&P 500).

- **Frontend**: React 18 + TypeScript + Vite + lightweight-charts v5
- **Backend**: Express + TypeScript + PostgreSQL (drizzle-orm)
- **Live data**: MotiveWave Java study → WebSocket → browser
- **Strategy**: Milk Yellow Box (FVG + Order Block + Structural zones) + Vector line confluence + Proxy Footprint analysis

## Commands
- Run dev: `npm run dev`
- Type check: `npm run check` ← run this after EVERY change
- Build: `npm run build`

---

## Architecture That Must Be Understood

### Live Data Flow
```
MotiveWave (Java study — LiveBarRelay)
  → WS /ws/mw-feed  (sends {type:"tick", symbol, price} ONLY — never OHLCV)
  → live-bars.ts: broadcast({type:"tick"}) + notifyExternalTick()
  → notifyExternalTick(): builds in-memory 1m/5m bars, broadcasts on bucket rollover
  → browser /ws/live-bars:
      tick → updateLastBarClose() direct series.update() [fast path, no React re-render]
      bar  → setLiveCandles() [React state, triggers signal/zone recompute]
```

### Key Suppression Logic
- `lastExternalTickMs` suppresses disk-file heartbeat 5s after a TickRelay tick
- `onTickFileChange` returns early when TickRelay active (prevents stale disk prices)
- Forming bars throttled to 1/second via `notifyExternalTick` (prevents render flood)
- HTTP 250ms poll: when `Date.now() - lastWsTickMsRef < 5000`, keep WS close price (don't overwrite with poll)

### Chart Architecture (CandlestickChart.tsx)
- `useLayoutEffect` initializes chart — NEVER `useEffect` (dimensions are 0 at useEffect time)
- ALL series pre-allocated at init — NEVER add/remove dynamically (resets visible range)
- `series.update()` fast path for live ticks; `series.setData()` only on structural changes
- `autoscaleInfoProvider: () => null` on ALL indicator series — candlestick drives Y-axis only
- `lastCandleRef` tracks forming bar for `updateLastBarClose()` direct update
- `dedupMap` REQUIRED before `series.setData()` — duplicate timestamps silently drop bars in lw-charts v5
- `markerHitsRef` stores (x,y,SignalClickInfo) for each signal marker — hit-tested in `handleDragStart` at 14px radius

### Candle Gap Detection (CandlestickChart.tsx)
- Detects bar interval from MINIMUM consecutive delta across first 50 bars
- MUST start from `Infinity` — starting from 300 breaks 15m/60m charts
- `GAP_THRESHOLD_SEC = barIntervalSec * 2` — gaps wider than this get 3 whitespace spacers
- Spacer timestamps must NOT collide with real bar times (use `realBarTimes Set` guard)

### Interval System
- `fetchInterval`: `"1m"`, `"5m"`, `"60m"` only — 15m is ALWAYS aggregated client-side from 5m
- `intervalKey={`${interval}-${windowSize}`}` passed to CandlestickChart — any dataset-size change must be in the key to trigger zoom reset
- On `intervalKey` change: reset chart to last 80 bars (`prevIntervalKeyRef`)
- `minBarSpacing: 1.0` — never below 1.0 (sub-pixel = solid band on zoom out)

### Vector Line System
- Main vector: `Highest(Lowest(low, 20), 20)` on current-interval candles
- Vector uses ALL bars (RTH + ETH) — `allBarsForVector` useMemo — never filter by showETH
- Extra vectors (15m, 60m, etc.): `aggToInterval(base, intervalSec)` — use raw 60m data, not aggregation
- Forward-fill coarser vectors onto finer chart times: `forwardFillVector(vec, chartTimes)`
- Pre-allocate exactly 4 extra `LineSeries` at chart init — update data only, never add/remove
- `extraVecSignalLines`: `{ label, color, map, flatMap, declineMap }` per line
  - `flatMap`: true when vector change ≤1pt over 2 steps (side-entry proxy)
  - `declineMap`: true when vector in falling phase (resets on any upward tick)
- **60m hard veto**: when `vec60mLine?.declineMap.get(c.time) === true`, ALL Long signals suppressed

### Signal Levels
- **safe**: milkBullOk=true (zone price test + bullish body + within 3 recent zones)
- **risky**: secLongOk=true (secondary vector flat/side-entry confluence)
- **riskiest**: zone+vector only, no secondary confirmation
- Cooldown: 10 RTH bars between signals (separate lastLong/lastShort trackers)
- Confluence signals are **Long-only** — shorts suppressed entirely
- `lockedSignalLevelsRef`: Map keyed `${time}_${direction}` — first fire writes lock, never drift on tick
- Resistance within 5pts above entry → downgrade one tier; riskiest+resistance → skip

### RTH / ETH Definition
- RTH: Mon–Fri, 13:30–21:00 UTC (9:30am–5pm ET)
- ETH: everything else (overnight, weekends)
- Used in BOTH server (`isRTH` in mw-reader.ts) and client

### Fixed-Point Exits
- TP1 = 10 pts, TP2 = 20 pts, SL = 5 pts (fixed — never ATR-based for confluence signals)
- HOD/LOD TP1 tightening: if within 3pts of HOD, cap TP1 at HOD−2
- Long suppression: skip when `c.close >= prevDayHodHigh - 5` (use pre-bar HOD)

---

## Footprint System (Proxy — No Real Tick Data Yet)

### Architecture
```
buildProxyFootprintCandle(OHLCV bar) → FootprintCandle
  - Whole-number price buckets (floor(low) to ceil(high))
  - Body: 70% of volume, directionally biased (askRatio 0.55→0.75 for up candles)
  - Wicks: 30% of volume, rejection biased
  - Imbalance threshold: 1.5:1 (proxy; real footprint uses 3:1)
  - Stacked imbalance: 3+ consecutive levels same direction

buildAggregate(rthCandles, anchorTime, "RTH") → FootprintCandle
  - Aggregates all session candles into one ladder
  - Sentinel keys: RTH=-1, ETH=-2 in candleFootprintMap (avoids timestamp collision)
  - Also uses 1.5:1 imbalance threshold

buildSessionLadder(candles, rth) → SessionResult  [FootprintLadder.tsx]
  - Also uses 1.5:1 imbalance threshold
```

### Files
- `client/src/lib/footprint-analysis.ts` — `buildProxyFootprintCandle`, `analyzeFootprint`, `FootprintCandle` types
- `client/src/components/FootprintLadder.tsx` — badge overlay, `buildSessionLadder`, `buildFpImbalanceBands`
- `client/src/components/CandlestickChart.tsx` — canvas rendering (layers 2–5 below signals)

### Rendering Layers (CandlestickChart.tsx, executed BEFORE signal markers)
1. **Layer 2**: Cross-candle stacked imbalance extension lines (dashed, fade to right until mitigation)
2. **Layers 3-4**: Per-candle imbalance zone bands (semi-transparent rect over full candle width)
3. **Layers 3-5**: Aggregate session ladder (RTH column + ETH column)
   - Row background: POC=purple, stacked buy=bright green, single buy=dim green, stacked sell=bright red, single sell=dim red, neutral=dark
   - Numbers: `fmtVol()` compact format (1.2M / 808k / 493)
   - Bid left of center divider (right-aligned), ask right (left-aligned)
   - Number colors: POC=purple, stacked buy=bright green, stacked sell=bright red, neutral=#7a8a9a
   - Text skip threshold: clampedH < 5px (was 8 — too strict for zoomed-out views)
   - Min font: 7px (was 10 — too large for tight rows)

### candleFootprintMap in market.tsx
```ts
const candleFootprintMap = useMemo(() => {
  // result.set(-1, rthAgg)  ← RTH aggregate (symbol="RTH")
  // result.set(-2, ethAgg)  ← ETH aggregate (symbol="ETH")
  // result.set(c.time, buildProxyFootprintCandle(c))  ← per-candle (symbol="")
}, [showFpPanel, windowedCandles]);
```

### Zone Band Integration
```ts
const fpBands = useMemo(() => buildFpImbalanceBands(windowedCandles), [showFpPanel, windowedCandles]);
zones={[...parsedZones, ...mlZoneBands, ...fpBands]}
```

### analyzeFootprint() Usage (market.tsx signal loop)
- Called per candle with `(latestFootprintCandle, "Long", priorFp, c.close)`
- `fpReading.vetoed=true` → suppress signal entirely (delta divergence)
- `fpReading.confirmed` → zone+vector+footprint full = SAFE
- `fpReading.partial` → zone+vector+footprint partial = SAFE with note
- Exit adjustments: POC-based stop, TP1 override at unfinished auction, TP2 +20% extension

---

## Zone System

### Milk Zones (from MWML files / ML pipeline)
- Each zone valid for its own market day only (never carry forward)
- `rthSettleOfDay(ts)` = that day's 20:30 UTC = zone `toTime` for DB zones
- `mlZoneBands` uses `rthSettleOfDay(z.from_ts)` as toTime
- `detectMilkZones` client-side FVG/OB zones: NEVER cap toTime at session end
- `milkBullOk`: price test requires `c.low <= z.top + 2.0 && c.close >= z.bottom - 2.0` (price check, not just timestamp)
- Zone scan: start from index 1, never cap at last 234 bars (backtest bug — fixed)

### Zone Vocabulary (Milk's labels)
| Label | Color | Meaning |
|---|---|---|
| IV WALL | Dark red top | Implied Vol ceiling — hard resistance cap |
| LARGE SELLER POSITIONING | Large dark red | Heavy institutional selling zone |
| SELLER POSITIONING | Red/maroon | Standard resistance zone |
| NON FAIR VALUE | Bright green | Mean-reversion magnet |
| BUYER POSITIONING | Green lower | Institutional support zone |
| PIVOT | Label on level | Structural decision level |
| BUYERS BUY TARGET ON RNGUP | Yellow line | Projected upside target |
| W WALL | Top + bottom | Explicit day range boundary — fade both extremes |

---

## Database

### Key Tables
- `cached_candles` — OHLCV bars (never DELETE on startup — was a bug, fixed)
- `signal_history` — locked signals with tp1/tp2/sl/outcome
- `ml_zones` — zones from MWML pipeline
- `trade_journal` — user trade entries

### Bar Validation (live-bars.ts + client)
- Must have valid OHLCV: h≥l, all prices finite and >0
- Timestamp must align: `t % intervalSec === 0`
- Client-side: `c.time % intervalAlignSec === 0` in windowedCandles

---

## Pages

| Route | File | Purpose |
|---|---|---|
| `/` | market.tsx | Main chart + signals + live data |
| `/backtest` | backtest.tsx | Historical signal replay |
| `/monte-carlo` | monte-carlo.tsx | MC simulation + equity curve |
| `/today` | today-signals.tsx | Today's signals list |
| `/journal` | journal page | Trade journal (feeds ML) |
| `/data` | data-download.tsx | Export/import candle data |
| `/discord` | discord-feed.tsx | Discord feed |
| `/timestamps` | timestamps.tsx | Confluence tab |
| `/predictions` | predictions.tsx | ML predictions |

### MarketPage Always Mounted
- Rendered OUTSIDE `Switch` in App.tsx — wrapped in `display:none` when not on "/"
- Prevents notification effects from dying on navigation

---

## Critical Style Rules

- **NEVER** `autoscaleInfoProvider` without `() => null` on indicator series
- **ALWAYS** `useLayoutEffect` for chart init (not useEffect — dims are 0)
- **NEVER** add/remove chart series after init (resets visible range)
- **ALWAYS** `dedupMap` before `series.setData()`
- **ALWAYS** separate `lastLong`/`lastShort` cooldown trackers (shared tracker blocks opposite direction)
- **NEVER** cap zone toTime at session close for client-side FVG/OB zones
- **NEVER** use price-change condition for forming-bar broadcast (always 0 — use throttle)
- **ALWAYS** start gap detection from `Infinity`, not 300
- **ALWAYS** include windowSize in `intervalKey` (not just interval)
- Signal computation always uses `rth !== false` filter (RTH-only for strategy gates)
- Vector computation uses ALL bars (RTH+ETH) — `allBarsForVector`, not `windowedCandles`
- `fetchInterval` map: `"1m"→1m`, `"5m"|"15m"→5m`, `"60m"→60m` (15m always aggregated client-side)

---

## What Has Failed (Never Repeat)

- `useEffect` for chart init → 0×0 dimensions → invisible chart
- Starting gap detection at `barIntervalSec = 300` → 15m charts insert spacers every bar
- `chart.addSeries()` after init → resets visible range
- Byte-scanning tick file → corrupt OHLCV → ~11% win rate (ATR 19000pts)
- `lastTickPrice.set()` BEFORE price-change check → difference always 0 → broadcast never fires
- `DELETE FROM cached_candles` on startup → wipes months of data
- `milkBull.has(c.time)` timestamp-only zone check → observational bias (50pt away still passes)
- `Math.min(z.to_ts, rthCloseOfDay(z.from_ts))` on ML zones → zones invisible on history view
- `buildMilkZoneSets()` legacy function → dead code, diverges from market.tsx
- Zone rendering inside session guard (`if (xStart && xEnd)`) → zones invisible on historical view
- `parseTickFileAsBars` byte scanner → corrupt bars
- Pre-fetching ML predictions for all signals on load → 10+ API calls
- `window.size` in `intervalKey` missing → chart doesn't reset on lookback change
- `minBarSpacing: 0.1` → solid band compression at 3000+ candles
- Imbalance threshold 3:1 for proxy data → nearly never fires (proxy max ratio ~3:1 only at extremes)

---

## What Has Worked (Apply Always)

- `useLayoutEffect` for chart init
- Pre-allocated chart series (all at init)
- `autoscaleInfoProvider: () => null` on all indicator series
- `dedupMap` before setData
- `series.update()` fast path for ticks
- `lastExternalTickMs` suppression (5s) for disk reads
- `forwardFillVector` for multi-interval vector display
- `aggToInterval` generic aggregation (not interval-specific functions)
- Gap detection starting from `Infinity`
- `intervalKey={`${interval}-${windowSize}`}` for zoom reset
- Separate `lastLong`/`lastShort` cooldown trackers
- Fixed exits: TP1=10, TP2=20, SL=5 (never ATR for confluence)
- `lockedSignalLevelsRef` keyed `${time}_${direction}` to prevent drift
- `buildProxyFootprintCandle` for proxy footprint when real data unavailable
- `allBarsForVector` (not windowedCandles) for vector computation
- Zone rendering outside session guard
- 1.5:1 imbalance threshold for proxy footprint data
- `fmtVol()` compact number format for footprint ladder

---

## Backtest Filters (must match market.tsx)

All three must be in both backtest.tsx AND monte-carlo.tsx:
1. **60m hard veto**: aggregate candles to 60m → build `vec60mMap` → detect decline → skip ALL Longs in decline
2. **HOD suppression**: pre-compute `hodBeforeBar` map → skip Long when `c.close >= prevHod - 5`
3. **Proxy footprint veto**: `analyzeFootprint(fp, "Long", priorFp, c.close)` → `fp.vetoed → continue`

---

## Open Questions / Known Issues

- Double-write: `persistCompletedBar5` writes to both "5" and "1" resolutions; `persistBar()` also called on bar.complete — may duplicate
- Weekend gap detection: all gaps > threshold get same 3 spacers regardless of length (49hr vs 16hr gaps look identical)
- Per-candle imbalance zone bands (Layer 3-4) rarely show because proxy data rarely produces stacked imbalances at 1.5:1 (only at body extremes of strongly directional candles)
- ETH footprint column can render at left edge of viewport if first ETH candle is at x≈0, showing only half the column

---

## Strategy Files (Primary Source of Truth)

Located in `strategies/*/STRATEGY.md`. Always read these before modifying signal logic:
- `strategies/vector/STRATEGY.md` — vector side-entry and tabletop rules
- `strategies/milks-zones/STRATEGY.md` — zone validity and day isolation rules
- `strategies/footprint/STRATEGY.md` — footprint confirmation spec (real data)
- `strategies/pattern-recognition/STRATEGY.md` — FLS and pattern gates
- `strategies/data-analysis/STRATEGY.md` — exit calibration

---

## Footprint Plan Status (from Master Plan)

**HOLD**: Waiting for real MotiveWave LiveBarRelay.java footprint code from user.
- Do NOT implement LiveBarRelay.java changes until user sends the code
- Do NOT implement footprint-engine.ts server-side until LiveBarRelay.java is modified
- Current proxy footprint in `footprint-analysis.ts` is the placeholder — functional for visual display
- When real code arrives: follow the full architecture in the Master Plan (footprint_bar messages, server-side FootprintCandleBuilder, WS broadcast to client)

---

## Recent Session Work (2026-04-28)

### Footprint Ladder Legibility
- `HALF` minimum raised to 48px (COL_W=96px minimum)
- `fmtVol()` compact format: ≥1M → "1.2M", ≥1k → "808k", else raw
- Min font: 7px (down from 10px to fit tight rows on zoomed-out charts)
- Text skip threshold: clampedH < 5px (down from 8px — 15m chart rows are ~7-8px)

### Footprint Imbalance Colors
- Row backgrounds: stacked buy=`rgba(34,197,94,0.28)`, single buy=`rgba(34,197,94,0.14)`
- Row backgrounds: stacked sell=`rgba(239,68,68,0.28)`, single sell=`rgba(239,68,68,0.14)`
- Number colors: stacked buy=`#00ff7f`, buy=`#26c87a`, stacked sell=`#ff3333`, sell=`#ef5350`, POC=`#c084fc`, neutral=`#7a8a9a`
- Volume bars: stacked buy side bright green (0.75 alpha), stacked sell side bright red (0.75 alpha)

### Imbalance Threshold Fix
- Changed from 3:1 to **1.5:1** in ALL three proxy locations:
  - `footprint-analysis.ts` `buildProxyFootprintCandle`
  - `market.tsx` `buildAggregate`
  - `FootprintLadder.tsx` `buildSessionLadder`
- Rationale: proxy model max ratio is ~3:1 at body extremes only; 1.5:1 triggers on all directionally biased levels

### Zone Band Integration
- `buildFpImbalanceBands` exported from FootprintLadder.tsx
- Stacked imbalance clusters → `FpZoneBand` objects with topPrice/bottomPrice/color/label
- Bands included in `zones` prop: `[...parsedZones, ...mlZoneBands, ...fpBands]`
- Footprint rendering block positioned BEFORE signal markers in draw loop (correct z-order)

### candleFootprintMap Sentinel Keys
- RTH aggregate stored at key `-1` (symbol="RTH")
- ETH aggregate stored at key `-2` (symbol="ETH")
- Per-candle entries stored at `c.time` (symbol="")
- Rendering code filters by `fp.symbol === "RTH" | "ETH"` for aggregate ladder
- Rendering code skips aggregates for per-candle zone bands
