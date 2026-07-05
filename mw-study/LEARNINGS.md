
**2026-07-05 — SDK Probe v2 results (deep history CONFIRMED)**
- `getBars(fromMs, toMs, BarSize, false)` returned 1,380 bars for a 7-day window 2 YEARS back while the chart held only 780 bars — deep history fetch beyond the chart-loaded range WORKS on Rithmic. No CSV fallback needed for backfill.
- A "last 24h" getBars window returning 0 during the weekend is CORRECT (market closed), not a failure — never treat empty-on-closed-session as an error.
- `instrument.getUnderlying()` returns the continuous root ("MES" for MESU6); `getKey()` = "MESU6.CME.RITHMIC". Confirms the contract→root symbol fold.
- Historical Bar objects expose `getVWAP`, `getTradesAtBid/Offer`, `getVolumeAtBid/Offer` — real historical footprint data is available via getBars for a future footprint-backfill feature.
- serviceBackfill now walks deep ranges backward in 30-day getBars windows (stop after 6 consecutive empty windows = provider cap) with outbox backpressure — never issue one giant multi-year getBars call.
- Confidence: high
