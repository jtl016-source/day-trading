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

### Signal Levels
- **safe**: zone + vector direction + bullish/bearish body + within 3 most recent zones
- **risky**: zone + vector direction + body confirmation
- **riskiest**: zone + vector direction only
- Cooldown: 10 RTH bars between signals (prevents clustering)

### RTH / ETH Definition (CME ES/MES futures)
- **RTH**: Mon–Fri, 9:30 AM – **5:00 PM ET** (user-defined close). Compute with `Intl.DateTimeFormat({timeZone:"America/New_York"})` — NEVER a hardcoded UTC offset (9:30 ET = 13:30 UTC in EDT but 14:30 UTC in EST). Canonical: `isRTH` in `client/src/lib/trading-utils.ts` (`etMins < 17*60`).
- **ETH**: the overnight Globex session — Sun 6:00 PM ET → Fri 5:00 PM ET minus the RTH window (i.e. 6:00 PM → 9:30 AM).
- **CLOSED**: daily maintenance halt 5:00–6:00 PM ET, and the weekend (Fri 5 PM → Sun 6 PM).
- Full session classifier (RTH/ETH/CLOSED) for display: `marketSession()` in `client/src/components/terminal/Clock.tsx`.

### Signal rules (user-defined)
- **No signals after 3:15 PM ET** (15:15) on any interval — too risky near the RTH close.
- **During ETH, only vector side-entry signals** (`signalType: "vector-side-entry"`) may fire/display — all confluence (milk/vector/footprint) signals are RTH-only.

---

## Style Rules
- Never add `autoscaleInfoProvider` without `() => null` for indicator series
- Always use `useLayoutEffect` for any code that reads DOM dimensions at init
- `fetchInterval` maps: `"1m"→1m`, `"5m"→5m`, `"15m"→15m`, `"60m"→60m` — server tries resolution `["15","5"]` for 15m (native 15m bars first, falls back to 5m aggregation)
- `cached-days` includes `resolution IN ('5','15','60')` so native 15m days from MW relay appear in the scrubber
- Candle coloring: above vector = normal colors, below vector = dim/muted colors
- All candle data passes through `dedupMap` before `series.setData()`
- Signal computation always uses `rth !== false` filter (RTH-only candles for strategies)
