# MarketView — Market Charting Application

## Overview
A cache-driven market charting application. Downloads historical data from Polygon.io, stores it in PostgreSQL, and generates professional candlestick charts with Yellow Box strategy overlays entirely from cached data — no live API calls for chart rendering.

## Features
- **Cache-Driven Chart**: Uses downloaded 5-min candle data for the candlestick chart and 60-min aggregated daily data for Yellow Box zone computation. No live API calls are made for chart display.
- **Date Window Selector**: Configurable sliding window (5/10/20/40/60/120 days) over all cached trading days. Navigate with prev/next buttons (by day or by window), or click any day in the timeline strip to center the window there.
- **TradingView-Style Theme**: Chart styling matches TradingView's dark theme exactly — background #131722, grid #1e222d, crosshair #758696, scale text #787b86, scale borders #2a2e39.
- **ETH/RTH Color Coding**: TradingView candle colors — teal #26a69a for up, red #ef5350 for down. ETH candles use same palette with reduced opacity. Volume bars match candle colors.
- **Symbol Support**: Stocks (AAPL, MSFT, etc.), ETFs (SPY, QQQ, etc.), Futures (ES=F, GC=F, etc.), Indices (^GSPC, ^VIX, etc.).
- **Volume bars** shown below the candlestick chart
- **Yellow Box Method** (per the Official Yellow Box Guide): Per-day zone overlays on the chart. POC = previous day's close. Yellow Box width from 50-day historical volatility (average daily range × 0.35). Red Box = Average Range High. Green Box = Average Range Low. Max Range dashed lines show historical extreme levels.
- **Data Download Panel** (`/data` route): Bulk download historical 5-min and 60-min candle data from Polygon.io. Calendar grid UI showing download status by month. Downloaded data cached in PostgreSQL.
- **Market News Timeline** (`/news` route): Timeline chart of major market-moving events fetched from GNews API. Articles categorized by type (Fed policy, crashes, rallies, inflation, geopolitical, earnings, recession, crypto). Interactive timeline with hover tooltips and click-to-expand article cards. Cached in PostgreSQL.

## Architecture

### Frontend
- `client/src/pages/market.tsx` — Main market page: cache-driven candlestick chart with date window selector, Yellow Box overlays, symbol sidebar. Uses 5m cached data for chart and 60m-aggregated daily data for zones.
- `client/src/pages/data-download.tsx` — Data Download page: Polygon.io bulk download UI, calendar grid, stored data table
- `client/src/pages/news.tsx` — News page: GNews-powered market event timeline with category filters
- `client/src/components/CandlestickChart.tsx` — TradingView lightweight-charts v5 component; supports ETH/RTH per-bar coloring, `scrollToTime()` via forwardRef, and dynamic zone overlay rendering via `zoneOverlays` prop (LineSeries)

### Backend
- `server/routes.ts` — Express API routes fetching from Yahoo Finance (yahoo-finance2 v3), MarketData.app, and Polygon.io
- `server/db.ts` — PostgreSQL database connection via Drizzle ORM
- `shared/schema.ts` — Drizzle schema: users, cached_candles, download_status, news_articles tables

### Database (PostgreSQL)
- `cached_candles` — Stores downloaded 5-min and 60-min OHLCV candle data per symbol
- `download_status` — Tracks download state (none/downloading/done/error) per symbol/year/month
- `news_articles` — Cached news articles from GNews API with category, source, published date

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
- `GET /api/data/cached-continuous/:symbol/:interval?from=X&to=Y` — Cached continuous candle data for chart display, supports timestamp windowing via from/to query params
- `GET /api/data/cached-days/:symbol` — Daily OHLCV from cached 60-min data for Yellow Box calculations
- `DELETE /api/data/clear/:symbol` — Clear all cached data for a symbol
- `GET /api/news/categories` — News category definitions
- `GET /api/news/articles?category=X&limit=N` — Cached news articles with optional category filter
- `POST /api/news/fetch` — Fetch latest news from GNews API across all categories
- `POST /api/news/fetch-historical` — Fetch historical news with date range

## Environment Secrets
- `LIVE_DATA` — MarketData.app API bearer token for live stock/ETF quotes
- `MASSIVE_API_CODE` — Polygon.io API key for historical data downloads
- `LIVE_NEWS` — GNews API key for market news fetching
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
