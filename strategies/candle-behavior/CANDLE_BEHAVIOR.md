# Candle Behavior Specification

## Overview
This document defines the single source of truth for how every candle in
this program must be stored, rendered, validated, and persisted. Any code
that creates, updates, merges, broadcasts, or displays candles must conform
to this specification. No exceptions.

This file is permanently write-protected. It may only be updated through
an authorized strategy update when explicitly approved by the user.

---

## 1. Candle Data Structure
Every candle — historical or live — must be stored and transmitted with
ALL of the following fields. A candle is invalid if any field is missing
or corrupt:

  {
    time:      number;   // Unix seconds, interval-aligned (see Section 3)
    open:      number;   // Price at which this candle opened
    high:      number;   // Highest price reached during this candle (wick top)
    low:       number;   // Lowest price reached during this candle (wick bottom)
    close:     number;   // Price at which this candle closed (or current price if forming)
    volume:    number;   // Total volume traded during this candle
    rth:       boolean;  // True if this candle falls within Regular Trading Hours
    symbol:    string;   // Ticker symbol this candle belongs to (e.g. "MES", "SPY")
    interval:  string;   // Candle interval (e.g. "1m", "5m", "15m", "60m", "1d")
    complete:  boolean;  // True if the candle's interval has fully closed
  }

No candle may be rendered on the chart or stored in the database unless
all ten fields above are present and pass the validation rules in Section 2.

---

## 2. Candle Validation Rules
Before any candle is stored, broadcast, or rendered, it MUST pass every
one of the following checks. Reject the candle silently if any check fails:

  RULE 1 — Price sanity:
    open > 0 AND high > 0 AND low > 0 AND close > 0
    All four values must be finite (not NaN, not Infinity, not null)

  RULE 2 — OHLC integrity:
    high >= open AND high >= close AND high >= low
    low  <= open AND low  <= close
    (High must be the highest value. Low must be the lowest.)

  RULE 3 — Reasonable price range:
    (high - low) / low < 0.20
    A single candle's wick spread must not exceed 20% of its low price.
    Any candle exceeding this is a corrupt catch-up candle or data error.

  RULE 4 — Timestamp alignment:
    time % interval_seconds === 0
    where interval_seconds = 60 for 1m, 300 for 5m, 900 for 15m, 3600 for 60m
    A candle whose timestamp is not aligned to its declared interval is either
    a corrupt record or a catch-up candle covering multiple periods.
    Reject it entirely — never round or adjust the timestamp.

  RULE 5 — Neighbor deviation check:
    If a prior candle exists in the same series:
      candle.low  / prior.close >= 0.80   (within 20% of prior close)
      candle.high / prior.close <= 1.20
    Candles deviating more than 20% from the prior close are corrupt outliers.

  RULE 6 — No zero-volume candles on historical data:
    For completed candles (complete === true), volume must be > 0.
    Zero-volume completed candles indicate a data gap or corrupt record.
    In-progress candles (complete === false) may have volume === 0.

---

## 3. Timestamp Alignment Rules
Timestamps are the primary key for every candle. Incorrect timestamps are
the root cause of duplicate candles, gaps, and catch-up bars.

  REQUIRED: Every candle's time field must be the OPENING timestamp of its
  interval, aligned to epoch, in Unix seconds.

  1-minute candles:   time = Math.floor(unixSeconds / 60)   * 60
  5-minute candles:   time = Math.floor(unixSeconds / 300)  * 300
  15-minute candles:  time = Math.floor(unixSeconds / 900)  * 900
  60-minute candles:  time = Math.floor(unixSeconds / 3600) * 3600

  NEVER use Date.now() directly as a candle timestamp — it will produce
  millisecond-precision values that fail alignment checks and create ghost bars.
  Always divide by 1000 and align as shown above.

  NEVER use client-side clock for new bar creation. Bar timestamps must
  come from the server's authoritative clock or the data source's timestamp.
  Client/server clock skew causes ghost bars that flicker and disappear.

---

## 4. Candle Storage Rules
The database (cached_candles table) is the single source of truth for all
completed candle data. These rules govern how candles enter and leave it:

  RULE A — Append only, never delete:
    Candles are inserted with onConflictDoUpdate — existing rows are updated
    in-place if the new data is more complete (e.g. final OHLCV vs forming).
    Candles are NEVER deleted except by explicit user action on the Data page.
    The cached_candles table must NEVER be wiped on server startup, restart,
    or reconnect.

  RULE B — Unique key:
    Each row is uniquely identified by (symbol, resolution, timestamp).
    Duplicate insertions for the same key update the existing row — they do
    not create a second row.

  RULE C — Only completed candles in the DB:
    The currently-forming (in-progress) candle is held in memory only
    (inProgressBar1m / inProgressBar5m maps). It is NOT written to the DB
    until its interval closes (complete === true).
    Writing a forming candle to the DB and then updating it creates false
    history if the server restarts before the interval closes.

  RULE D — Gap filling uses individual candles only:
    When a gap is detected between the last stored candle and the current
    time, each missing candle must be fetched and inserted individually at
    its correct timestamp. Multiple missing periods must NEVER be merged
    into a single candle.

  RULE E — Symbol + interval keying:
    All candle data is keyed by BOTH symbol AND interval/resolution.
    Candles from one interval must never overwrite candles from another.
    (e.g. a 5m bar must never be stored at a 1m key)

---

## 5. Live (In-Progress) Candle Rules
The currently-forming candle lives in memory on the server and is broadcast
to the client via WebSocket. These rules prevent false candles from being
created during reconnects, server restarts, or data gaps:

  RULE A — Open price chaining:
    A new in-progress candle's open must equal the prior completed candle's
    close IF AND ONLY IF the prior candle is exactly one interval behind.
    Prior candle timestamp === current bucket - interval_seconds

    If the gap is larger than one interval (reconnect gap, server restart,
    overnight, etc.), the new candle's open must equal the CURRENT TICK PRICE.
    Never chain open to a stale close from minutes or hours ago.

  RULE B — Cold start self-seeding:
    On server startup, if the most recent completed bar in the DB is older
    than one interval period, do NOT create an in-progress bar from its close.
    Wait for the first real live tick to arrive and use that tick as both
    the open and close of the new in-progress candle.

  RULE C — No catch-up candles:
    When the server reconnects to a data feed after a gap, it must fetch
    each missing candle from the REST API individually and insert them one
    by one. It must NEVER create a single in-progress bar that spans the
    entire gap period. A bar whose time range would exceed the declared
    interval duration must be rejected before broadcast.

  RULE D — Tick-only fast path:
    Live price ticks (WebSocket tick messages) update the close, high, and
    low of the current in-progress candle only. They never create a new bar.
    New bars are created exclusively when the current interval boundary is
    crossed — determined by comparing the tick's aligned bucket timestamp
    to the current in-progress bar's timeSec.

  RULE E — HTTP poll alignment:
    The 250ms HTTP poll for futures live bars must align its timestamp to
    the same bucket formula as the WebSocket handler. If both the WS and
    HTTP paths produce a bar for the same timestamp, the merge logic keeps
    the original open and takes the max high, min low, and latest close.
    The open of a live bar is NEVER overwritten once set.

  RULE F — No stale forming bar injection:
    The fetchGapCandles() reconnect function must skip the currently-forming
    bucket when inserting gap candles into liveCandles. The forming candle
    is owned exclusively by the live tick stream. The REST API version of
    the forming candle is a snapshot and must not overwrite the live version.

---

## 6. Client-Side Candle Merge Rules
When merging historical candles (from the DB query) with live candles
(from WebSocket / HTTP poll), these rules apply:

  RULE A — Historical candles are the base layer:
    baseCandles comes from the React Query fetch of cached-continuous.
    It is sorted ascending by time and validated before use.
    It is never mutated — a new array is produced on each merge.

  RULE B — Live candles overlay the base:
    liveCandles are binary-search inserted/overwritten into baseCandles.
    If a live candle has the same timestamp as a historical candle, the
    live candle wins (it is more current).

  RULE C — liveCandles is never wiped during normal operation:
    setLiveCandles([]) must NOT be called in response to a data_updated
    WebSocket message, a query invalidation, or a reconnect event.
    liveCandles is only reset when the symbol or interval changes
    (useEffect dependencies: [selectedSymbol, interval]).

  RULE D — Open price is immutable once set:
    In any setLiveCandles updater that merges a new live bar into an
    existing liveCandles entry, the open field of the existing entry
    is always preserved. The incoming bar's open is discarded.
    open: existing.open   // ALWAYS — never overwrite with incoming open

  RULE E — Stale bar rejection in HTTP poll:
    The HTTP poll must not append a bar to liveCandles if its timestamp
    is older than (current expected bucket - one interval). Old bars
    belong in baseCandles (served by the DB query), not liveCandles.

---

## 7. Interval Switch and Symbol Switch Rules
When the user changes the displayed symbol or interval, these rules apply:

  RULE A — Save before switching:
    Before rendering the new symbol/interval, the current liveCandles state
    is allowed to drain naturally — it does not need to be saved manually
    because the DB already holds the completed candles.

  RULE B — Load from DB first:
    When switching to a new symbol or interval, the DB query fires
    immediately. The chart renders the DB data first, then overlays any
    new live bars that arrive after the switch.
    The chart must never show zero candles on a symbol that has DB history.

  RULE C — liveCandles resets on switch:
    setLiveCandles([]) IS correct when selectedSymbol or interval changes —
    this is the only valid time to wipe liveCandles. The old symbol's live
    bars must not bleed into the new symbol's chart.

  RULE D — No cross-interval contamination:
    A 5m live bar must never appear on the 1m or 15m chart.
    Each interval has its own liveCandles state, its own in-progress bar
    on the server, and its own DB resolution column.

---

## 8. Data Page and Export/Import Rules
The Data page is the user-facing interface for the candle store. These
rules govern what it shows and what export/import must preserve:

  RULE A — Export contains complete candle data:
    Every exported candle must include all ten fields from Section 1.
    Exports must be valid JSON or CSV that can be re-imported without
    any data transformation.

  RULE B — Import is append-only:
    Importing a dataset uses onConflictDoNothing — it never overwrites
    existing candles. New candles in the import file are appended.
    Existing candles with the same (symbol, resolution, timestamp) key
    are left untouched.

  RULE C — Signals travel with candles:
    Any export from the Data page must include the signals associated
    with the exported candles (same symbol, same interval, overlapping
    timestamps). When re-imported, signals are restored at their exact
    original timestamps and are not recalculated.

  RULE D — The Data page is always current:
    The Data page reads directly from the DB. It reflects the true stored
    state of the candle data at all times. It does not cache or snapshot.

---

## 9. Prohibited Behaviors
The following behaviors are explicitly forbidden. Any code that does any
of these is a bug and must be fixed immediately:

  ✗ Creating a candle that spans more than one interval period
  ✗ Using Date.now() directly as a candle timestamp (must align to interval)
  ✗ Using the client clock to open a new bar (server clock only)
  ✗ Wiping cached_candles on startup, restart, or reconnect
  ✗ Merging multiple missing candles into one catch-up candle
  ✗ Overwriting an existing candle's open price with a live tick's open
  ✗ Inserting a forming (incomplete) candle into the DB as completed
  ✗ Allowing a live bar to appear on the wrong interval's chart
  ✗ Rendering a candle before all ten required fields are validated
  ✗ Wiping liveCandles in response to anything other than a symbol/interval change
  ✗ Chaining a new bar's open to a prior close that is more than one interval old
  ✗ Appending an old bar (older than current bucket - one interval) via HTTP poll
  ✗ Allowing the gap fill (fetchGapCandles) to insert the currently-forming bucket

---

## 10. Debugging Reference
When a false candle appears, check these in order:

  Step 1: Is liveCandles being wiped unexpectedly?
    Search for setLiveCandles([]) calls. The only valid location is the
    useEffect with [selectedSymbol, interval] as dependencies. Any other
    location is a bug.

  Step 2: Is the in-progress bar seeded from a stale close?
    Check inProgressBar1m / inProgressBar5m initialization in mw-reader.ts.
    The seed bar's age must be checked before using its close as a new open.

  Step 3: Is applyTick or notifyExternalTick chaining across a gap?
    Check the is1mContiguous / is5mContiguous guard. If the gap between
    prev bucket and current bucket exceeds one interval, open = price (not close).

  Step 4: Is fetchGapCandles inserting the forming candle?
    Check that the currentBucket guard filters out c.time >= currentBucket.

  Step 5: Is the HTTP poll inserting a stale bar?
    Check the expectedBucket guard in the setLiveCandles updater. Any bar
    older than expectedBucket - intervalSecs must be rejected.

  Step 6: Is the timestamp unaligned?
    Log the raw time value and verify time % intervalSecs === 0.
    If not, the source data has an alignment bug.
