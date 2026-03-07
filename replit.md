# MarketView — Market Charting Application

## Overview
A real-time and historical market charting application using live Yahoo Finance data. Displays professional candlestick charts for stocks, ETFs, futures, and market indices with ETH/RTH visual distinction.

## Features
- **Today's Intraday Chart**: Full-day candlestick chart including ETH (pre/post market) + RTH, 15m or 60m intervals, auto-refreshing every 60 seconds
- **200-Day Continuous History**: Single continuous candlestick chart covering the full historical window — no per-day loading. ETH + RTH candles shown throughout. Supports zoom/pan via the chart and a draggable day-card timeline scrubber for jumping to specific dates.
  - 15m interval: last 60 days (Yahoo Finance API limit)
  - 60m interval: full 200 trading days
- **ETH/RTH Color Coding**: Vivid green/red for Regular Trading Hours candles; muted light green/light red for Extended Trading Hours candles. Shown on both the intraday and historical charts.
- **Symbol Support**: Stocks (AAPL, MSFT, etc.), ETFs (SPY, QQQ, etc.), Futures (ES=F, GC=F, etc.), Indices (^GSPC, ^VIX, etc.)
- **Volume bars** shown below each candlestick chart
- **Live quote data** showing price, change, day high/low, volume

## Architecture

### Frontend
- `client/src/pages/market.tsx` — Main market page: intraday chart, continuous history chart, timeline scrubber, symbol selector sidebar
- `client/src/components/CandlestickChart.tsx` — TradingView lightweight-charts v5 component; supports ETH/RTH per-bar coloring and `scrollToTime()` via forwardRef

### Backend
- `server/routes.ts` — Express API routes fetching from Yahoo Finance (yahoo-finance2 v3)

## API Routes
- `GET /api/market/symbols` — Static list of symbols by category
- `GET /api/market/quote/:symbol` — Real-time quote from Yahoo Finance
- `GET /api/market/intraday/:symbol/:interval` — Today's intraday candles (full day including ETH)
- `GET /api/market/historical-days/:symbol` — Past 200 daily OHLCV bars (for timeline scrubber)
- `GET /api/market/historical-continuous/:symbol/:interval` — Continuous intraday history (60 days for 15m, 200 days for 60m), all candles tagged with `rth` boolean

## RTH Detection
RTH (Regular Trading Hours) = 9:30am – 4:00pm ET. Implemented server-side by checking UTC timestamp falls between 13:30–21:00 UTC (covers both EST/EDT offsets).

## Key Libraries
- `yahoo-finance2` (v3) — Server-side Yahoo Finance data fetching; uses `period1`/`period2` Date objects
- `lightweight-charts` (v5) — TradingView candlestick charting library
- `@tanstack/react-query` — Data fetching and caching on the frontend

## Running
The app runs via `npm run dev` which starts the Express + Vite dev server on port 5000.
