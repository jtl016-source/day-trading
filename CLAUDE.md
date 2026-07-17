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

### Signals — THE program strategy (optimized 2026-07-16, dual-interval 2026-07-17)
- ONE signal source for chart, Signals tab, backtest and notifications:
  `computeOptimizedSignals` in `client/src/lib/signal-engine.ts`
- Rule: an RTH candle tests-and-holds an ICT zone (FVG/Order Block/structural, ±2 pts)
  AND closes in the trade direction. No vector gate, no footprint gate.
- Trades TWO intervals, each with grid-calibrated exits (never share exits across intervals):
  · 15m: TP1 +8 / TP2 +16 / SL −4 (`OPTIMIZED_EXITS`)
  · 5m:  TP1 +4 / TP2 +8  / SL −4 (`OPTIMIZED_EXITS_5M`)
- Signals are tagged with their interval; the auto-trader's "Trade on intervals"
  setting (5m/15m checkboxes) gates which ones fire orders
- The 5m strategy component needs ≤5m candles — the 15m chart's dataset is 15m,
  so market.tsx sources the raw 5m fetch there (60m chart: background 15m fetch)
- Cooldown: 10 bars between signals per direction (prevents clustering)
- Baseline risk filters always on: HOD long suppression (5 pts), 60m declining-vector
  long veto, CME settlement-break skip, session-settle exits

### RTH Definition
- Mon–Fri, 13:30–21:00 UTC (9:30am–5pm ET)
- ETH = everything else (overnight, weekends)
- This definition is used in BOTH server (`isRTH` in mw-reader.ts) and client

---

## Style Rules
- Never add `autoscaleInfoProvider` without `() => null` for indicator series
- Always use `useLayoutEffect` for any code that reads DOM dimensions at init
- `fetchInterval` maps: `"1m"→1m`, `"5m"|"15m"→5m`, `"60m"→60m` — 15m is always aggregated client-side
- Candle coloring: above vector = normal colors, below vector = dim/muted colors
- All candle data passes through `dedupMap` before `series.setData()`
- Signal computation always uses `rth !== false` filter (RTH-only candles for strategies)
