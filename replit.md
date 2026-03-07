# MarketView — Market Charting Application

## Overview
A real-time and historical market charting application using live Yahoo Finance data. Displays professional candlestick charts for stocks, ETFs, futures, and market indices with ETH/RTH visual distinction.

## Features
- **Today's Intraday Chart**: Full-day candlestick chart including ETH (pre/post market) + RTH, 15m or 60m intervals, auto-refreshing every 60 seconds
- **200-Day Continuous History**: Single continuous candlestick chart covering the full historical window — no per-day loading. ETH + RTH candles shown throughout. Supports zoom/pan via the chart and a draggable day-card timeline scrubber for jumping to specific dates.
  - 15m interval: last 60 days (Yahoo Finance API limit)
  - 60m interval: full 200 trading days
- **TradingView-Style Theme**: Chart styling matches TradingView's dark theme exactly — background #131722, grid #1e222d, crosshair #758696, scale text #787b86, scale borders #2a2e39. Font matches TradingView's system font stack.
- **ETH/RTH Color Coding**: TradingView candle colors — teal #26a69a for up, red #ef5350 for down. ETH candles use same palette with reduced opacity. Volume bars match candle colors.
- **Symbol Support**: Stocks (AAPL, MSFT, etc.), ETFs (SPY, QQQ, etc.), Futures (ES=F, GC=F, etc.), Indices (^GSPC, ^VIX, etc.). Futures use a wider intraday window starting 5 PM ET the previous day to capture overnight Globex sessions.
- **Volume bars** shown below each candlestick chart
- **Live quote data** via MarketData.app API (LIVE_DATA secret) for stocks/ETFs, with Yahoo Finance fallback. Shows price, change, day high/low, volume. Futures and indices always use Yahoo Finance.
- **Yellow Box Method** (per the Official Yellow Box Guide): Per-day zone overlays on both intraday and historical charts. POC = previous day's close (not today's open). Yellow Box width derived from 50-day historical volatility (average daily range × 0.35 fraction). Red Box (above Yellow Box) = Average Range High from POC. Green Box (below Yellow Box) = Average Range Low from POC. Max Range lines (dashed) show historical extreme levels. Average up/down moves computed separately from `high - prevClose` and `prevClose - low` over the 50-day lookback window.
- **Data Download Panel** (`/data` route): Bulk download historical 5-min and 60-min candle data from Polygon.io. Calendar grid UI showing download status by month for the last 5 years. Downloaded data cached in PostgreSQL. When cached data exists for a symbol, the main chart uses it instead of Yahoo Finance for the continuous history view and Yellow Box calculations.

## Architecture

### Frontend
- `client/src/pages/market.tsx` — Main market page: intraday chart, continuous history chart, timeline scrubber, symbol selector sidebar
- `client/src/pages/data-download.tsx` — Data Download page: Polygon.io bulk download UI, calendar grid, stored data table
- `client/src/components/CandlestickChart.tsx` — TradingView lightweight-charts v5 component; supports ETH/RTH per-bar coloring, `scrollToTime()` via forwardRef, and dynamic zone overlay rendering via `zoneOverlays` prop (LineSeries)

### Backend
- `server/routes.ts` — Express API routes fetching from Yahoo Finance (yahoo-finance2 v3), MarketData.app, and Polygon.io
- `server/db.ts` — PostgreSQL database connection via Drizzle ORM
- `shared/schema.ts` — Drizzle schema: users, cached_candles, download_status tables

### Database (PostgreSQL)
- `cached_candles` — Stores downloaded 5-min and 60-min OHLCV candle data per symbol
- `download_status` — Tracks download state (none/downloading/done/error) per symbol/year/month

## API Routes
- `GET /api/market/symbols` — Static list of symbols by category
- `GET /api/market/quote/:symbol` — Real-time quote (MarketData.app for stocks/ETFs, Yahoo Finance fallback)
- `GET /api/market/intraday/:symbol/:interval` — Today's intraday candles (full day including ETH)
- `GET /api/market/historical-days/:symbol` — Past 200 daily OHLCV bars (for timeline scrubber)
- `GET /api/market/historical-continuous/:symbol/:interval` — Continuous intraday history (60 days for 15m, 200 days for 60m)
- `GET /api/data/verify-key` — Verify Polygon.io API key (MASSIVE_API_CODE secret)
- `GET /api/data/status/:symbol` — Download status for all months
- `POST /api/data/download` — Download candle data for a specific symbol/year/month from Polygon.io
- `GET /api/data/candles/:symbol/:resolution` — Retrieve cached candles with optional from/to filters
- `GET /api/data/daily-summary/:symbol` — Aggregated daily summary from cached 5-min data
- `GET /api/data/cached-continuous/:symbol/:interval` — Cached continuous candle data for chart display
- `GET /api/data/cached-days/:symbol` — Daily OHLCV from cached 60-min data for Yellow Box calculations
- `DELETE /api/data/clear/:symbol` — Clear all cached data for a symbol

## Environment Secrets
- `LIVE_DATA` — MarketData.app API bearer token for live stock/ETF quotes
- `MASSIVE_API_CODE` — Polygon.io API key for historical data downloads
- `SESSION_SECRET` — Express session secret
- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned)

## RTH Detection
RTH (Regular Trading Hours) = 9:30am – 4:00pm ET. Implemented server-side by checking UTC timestamp falls between 13:30–21:00 UTC (covers both EST/EDT offsets).

## UI/UX
- **Dark Theme**: Professional trading terminal dark theme (near-black background `220 10% 4%`). Dark class forced on mount via `useEffect` in `App.tsx`.
- **Drag-to-Zoom**: Crosshair toggle button enables drag-to-zoom rectangle selection. Fit-all reset button (Maximize2 icon). Global mouseup + Escape key handlers for reliable deactivation.
- **Band Overlays**: Canvas-based filled zone rendering for Yellow Box strategy. Semi-transparent yellow/red/green rectangles redrawn on every pan/zoom via `subscribeVisibleLogicalRangeChange` + `subscribeCrosshairMove`. Uses `unsubscribe*` methods (not callable return values) for cleanup.

## Key Libraries
- `yahoo-finance2` (v3) — Server-side Yahoo Finance data fetching; uses `period1`/`period2` Date objects
- `lightweight-charts` (v5) — TradingView candlestick charting library; subscribe methods return void, use `unsubscribe*` counterparts for cleanup
- `@tanstack/react-query` — Data fetching and caching on the frontend
- `drizzle-orm` + `pg` — PostgreSQL ORM for cached candle data storage
- Polygon.io REST API — Historical candle data downloads

## Running
The app runs via `npm run dev` which starts the Express + Vite dev server on port 5000.
