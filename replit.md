# MarketView — Market Charting Application

## Overview
A real-time and historical market charting application using live Yahoo Finance data. Displays professional candlestick charts for stocks, ETFs, futures, and market indices.

## Features
- **Today's Market**: Live intraday candlestick chart with 15m or 60m interval options, auto-refreshing every 60 seconds
- **Historical Data**: 200 days of trading history per symbol, with a draggable day-by-day navigator
- **Symbol Support**: Stocks (AAPL, MSFT, etc.), ETFs (SPY, QQQ, etc.), Futures (ES=F, GC=F, etc.), Indices (^GSPC, ^VIX, etc.)
- **Volume bars** shown below each candlestick chart
- **Live quote data** showing price, change, day high/low, volume

## Architecture

### Frontend
- `client/src/pages/market.tsx` — Main market page with all sections
- `client/src/components/CandlestickChart.tsx` — TradingView lightweight-charts v5 candlestick chart component

### Backend
- `server/routes.ts` — Express API routes fetching from Yahoo Finance

## API Routes
- `GET /api/market/symbols` — Static list of symbols by category
- `GET /api/market/quote/:symbol` — Real-time quote from Yahoo Finance
- `GET /api/market/intraday/:symbol/:interval` — Today's intraday candles (15m or 60m)
- `GET /api/market/historical-days/:symbol` — List of past 200 trading days (OHLCV)
- `GET /api/market/day-detail/:symbol/:date/:interval` — Intraday candles for a specific historical date

## Key Libraries
- `yahoo-finance2` (v3) — Server-side Yahoo Finance data fetching
- `lightweight-charts` (v5) — TradingView candlestick charting library
- `@tanstack/react-query` — Data fetching and caching on the frontend

## Running
The app runs via `npm run dev` which starts the Express + Vite dev server on port 5000.
