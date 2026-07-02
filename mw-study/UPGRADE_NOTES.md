# MotiveWave Study Upgrade — Data Sync Overhaul

This upgrade makes history sync **server-driven and gap-aware**. The old connect-time
history dump is gone; the server now tells each study exactly which bar ranges are
missing and the study backfills them one range at a time. It also detects continuous-contract
roll re-adjustments and heals older bars automatically.

## 1. Rebuild the studies

From the `mw-study` folder on your Windows machine:

```
build.bat
```

This now builds:
- **LiveBarRelay.jar** (upgraded v2 — also contains the new **SDK Probe** study)
- **AutoTrader.jar** (unchanged)

`HistoryDumper` has been **removed** (superseded by server-driven backfill). Any old
`HistoryDumper.jar` in `%USERPROFILE%\MotiveWave Extensions` can be deleted.

Then fully restart MotiveWave (File > Exit, reopen).

## 2. Replace the study on each of the 4 charts

You run one chart per resolution (1m / 5m / 15m / 60m). On **each** chart:
- Remove the old "Live Bar Relay" study if present.
- Right-click > Add Study > search **"Live Bar Relay"** > add.
- Keep **Auto Trader** as-is.

Each chart's study now announces its resolution to the server (a `hello` message) and
services backfill requests for that resolution only.

## 3. Run SDK Probe ONCE and send back the report (important)

Some SDK method names/signatures could not be verified off your machine, so the deep-history
backfill uses reflection with fallbacks. To let me lock it down:

1. Add **"SDK Probe"** to any ONE chart (right-click > Add Study > "SDK Probe").
2. Let it sit for ~30 seconds (it runs once, on a background thread).
3. Send me the file it writes:
   `%USERPROFILE%\MotiveWave Extensions\sdk_probe.txt`
4. Remove the SDK Probe study afterward (it is a one-shot diagnostic).

The report answers:
- **P1** — the real `BarSize` interval accessor (name + minutes vs seconds).
- **P2/P3** — whether `Instrument.forEachBar` can fetch history **beyond the chart-loaded
  range** (the make-or-break test for deep backfill). P3 requests a 7-day window from ~2 years ago.
- **P4** — the `Instrument.getBars` signature (a fallback path).

If P3 comes back empty, deep history must come from the CSV export fallback (step 5).

## 4. Set the continuous contract to "Difference" adjustment

For the roll-heal logic to behave predictably, set your continuous contract (e.g. `@ES`)
to **Difference** back-adjustment in MotiveWave. When a roll re-adjusts the whole series
by a constant offset, the server now detects the constant delta across the overlap and
shifts older stored bars to match (logged in `adjustment_log`), so history stays continuous.

## 5. (Optional) CSV export fallback

If forEachBar cannot reach deep history, you can feed history via MotiveWave's **Data Export**:

1. Set the server env var `MW_EXPORT_DIR` to a folder (e.g. `C:\mw-export`) and restart the server.
2. Configure MW to export CSVs into that folder named `<SYMBOL>_<RES>.csv`, where
   `RES` ∈ `1, 5, 15, 60` (or `1min, 5min, 15min, 60min`) — e.g. `ES_5.csv`.
3. The CSV needs a header row with columns that include a timestamp plus open/high/low/close/volume
   (any order — the header names are detected). Timestamps may be epoch seconds, epoch ms, or
   `yyyy-MM-dd HH:mm` (assumed **UTC** — please confirm your export's format in the P5 note above).

The watcher is **off** unless `MW_EXPORT_DIR` is set. Files are debounced 2s, validated, roll-healed,
and upserted through the same path as the WebSocket ingest.

## What the server now does automatically

- On each study `hello`, audits `cached_candles` for that (symbol, resolution) against the
  expected CME Globex bar grid and requests backfill for missing runs (one in-flight at a time).
- Re-audits hourly for connected studies.
- Remembers ranges the provider can't fill (`unfillable_ranges`: `provider_cap` / `no_data`) so it
  won't ask forever. Clear retryable ones with
  `DELETE /api/data/unfillable/:symbol/:resolution`.
- Detects + heals roll re-adjustments before persisting.
- Exposes completeness: `GET /api/data/gaps/:symbol/:resolution` and per-resolution
  summary on `GET /api/mw/sync-status`.
