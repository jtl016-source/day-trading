# Learnings

## What Has Worked
- (Nothing recorded yet)

**2026-08-10 — Strategies dropdown declutter (terminal.tsx, terminalStyles.ts, strategyMeta.ts, TerminalLiveChart.tsx)**
- Observation: at 9 entries the flat dropdown outgrew itself — no desktop max-height (could run past the viewport with the upload block + suboverlays open), no visual grouping, and the 55ms/row stagger took ~500ms to settle. On-canvas: a TIGHT close-est zone printed the two EST CL labels 0–3px apart (unreadable overprint).
- Action: presentation-only `group` field on StrategyMeta + STRAT_GROUPS (signal/facts/display) rendered as sections with `.tt-dd-group` mono headers; dropdown gets max-height:min(78vh,660px) + overflow-y:auto + slim scrollbar; row padding 11→8px, desc 11→10.5px; stagger per-group and capped (40+min(i,4)*35ms). Canvas labels: when the est lines sit within 14px draw ONE merged range label ("EST CL lo–hi"), and the OPEN label draws BELOW its line so an EST label just above can't collide. Verified via DOM probe (3 groups, 9 names, 545px ≤ viewport, scrollable) + canvas composite (rAF-shim + Reload-chart) showing the merged label.
- Confidence: high

**2026-08-09 — CLOSE-EST zone overlay (terminal/TerminalLiveChart.tsx)**
- Observation: the PML/TML live-only recipe (2026-07-15 entry) held exactly for a second consumer — new ref next to pmlTmlRef, draw block immediately after the PML/TML block (same save/clip/9px-mono idiom, paneW/clipBottom/series already in scope there), poll effect cloned with the endpoint swapped, gated by the same YellowBox toggle. Zero changes to terminal.tsx, settings, or strategyMeta.
- Action: when two overlay families both label full-width lines, split the edges — PML/TML labels are right-aligned at paneW−4, so CLOSE-EST labels go left-aligned at x=4; a shared y-guard helper (`yOf` returning null off-pane) keeps the band fill and each line independently skippable, never repositioned on-screen. Band fill draws once before the lines (no alpha stacking).
- Addendum (same day, user request): promoted from the YellowBox family to its OWN Strategies toggle — the 3-file recipe held exactly again (StrategyToggles + DEFAULT ON + two typeof-boolean mwb mirror lines for `closeEstEnabled`; one STRATS entry keyed "CloseEst" → dropdown row + "display only" chip + full Info page derived; new `closeEstOnRef` synced beside yellowOnRef). Verified live in the dropdown text ("Close Estimate / display only") via get_page_text. Screenshot gotcha: in the HIDDEN pane, installing a `requestAnimationFrame = setTimeout` shim and THEN clicking "Reload chart" gets the OVERLAY canvas painting (composited to PNG via drawImage + toDataURL, chunk-extracted through the 65K-char tool-result files) — but the lw-charts candle series still refuses to render (visibilityState spoof included); a true full screenshot requires the pane displayed.
- Confidence: high

**2026-08-07 — Journal tab (terminal/JournalView.tsx, pages/terminal.tsx, terminal/icons.tsx)**
- Observation: the Ledger-tab recipe held exactly (Tab union + tabs[] entry + mount line + one Ico entry; view self-contained with its own fetches). NEW gotcha class: a one-shot endpoint probe is WRONG for "does this route exist yet" — a transient server event-loop stall (boot slab, catch-up pass) makes the 10s-abort fetch fail exactly like a missing route, and a sticky `endpointLive=false` then shows the "activates on next restart" panel against a live endpoint forever.
- Action: every new-endpoint probe needs a retry loop (20s re-probe here) and data fetches need at least one delayed retry (4s) — the honest fallback panel must SELF-HEAL. Verified via get_page_text after tab clicks (hidden browser pane cannot screenshot); javascript_exec fetch-from-page distinguishes "endpoint broken" from "component state stuck".
- Gotcha (user report, same day): the terminal's live chart IS the page background and .tt-view adds NO backdrop — C.panel (rgba(255,255,255,0.022)) is fine inside opaque cards but unreadable directly over candles. Any long-form-text view needs its own opaque root card (rgba(8,10,16,0.92) + blur(8px), the .tt-hud idiom — more opaque for text) with near-solid panels (rgba(10,12,18,0.97)) inside. Verify computed backgroundColor via javascript_exec, not screenshots.
- Confidence: high

**2026-08-02 — Suggested-size row in RISK PROFILE (terminal/SignalDetail.tsx)**
- Observation: the row needed ZERO data plumbing — `resolveComboRisk` already yields `risk.tier`, and the suggested count derives from it via the shared `suggestedContractsForTier` (shared/signal-display SIZE_BY_COMBO_TIER, the SAME mapping the engine stamps into `suggested_contracts`), so useTerminalData/SignalRow/mapSignal were untouched. The stored per-row column exists for the record/audit; the display derives live from the tier so it can never disagree with the engine rule.
- Action: when a new per-signal display value is a pure function of data the detail card already resolves, derive it in the card from the shared mapping instead of threading a new field through the four useTerminalData places — the threading recipe (2026-07-30 entry) is only for values that CANNOT be derived client-side.
- Gotcha: the Signals tab date-browse showed 0 rows for a day the server verifiably serves (9 rows via curl) while the ledger-dashboard agent had the view mid-rework — verify server-side truth with curl before touching a component another agent owns; the detail-card change was verified via the served-module source + the shared-mapping unit tests instead of a click-through.
- Confidence: high

**2026-08-02 — Ledger tab (terminal/LedgerView.tsx, pages/terminal.tsx, terminal/icons.tsx)**
- Observation: a new terminal tab is exactly 3 terminal.tsx edits (Tab union, tabs[] entry, mount line in the `key={tab}` view block) + one Ico entry; the view stayed fully self-contained (own 60s poll of GET /api/ledger/summary, no useTerminalData coupling) so no shared-hook threading was needed. A server that predates a new /api route HANGS the request (no 404, no vite-catch-all fallthrough — verified with curl); the JSON-content-type guard alone never fires, so the fetch needs an AbortController timeout (10s) for the honest "endpoint not live yet" panel to ever render. Two such wedged fetches froze the whole browser-pane renderer — open a fresh tab after the server recovers.
- Action: hand-drawn `<canvas>` panels (DPR pattern from SignalMiniChart: getBoundingClientRect → canvas.width=w·dpr → setTransform(dpr,…) → draw in CSS px) with a `rect.width<10 → skip` guard work in the hidden pane (draws run from useEffect, not rAF) but lay out at 0 width there; to verify pixels, force `canvas.style.width='800px'` + dispatch a window `resize` event (the draw effect listens) and getImageData-scan for the palette colors. Verify the READY state without the endpoint by stubbing window.fetch with a synthetic `new Response(json, {headers:{'Content-Type':'application/json'}})` and remounting via tab-away/tab-back. All verdict/metric WORDING imports from shared/ledger-stats.ts (verdictWords) — same one-wording-source rule as signal-display.
- Confidence: high

**2026-07-30 — signals_resync + fetch-failure resilience (hooks/useTerminalData.ts, terminal/SignalsView.tsx)**
- Observation: fetchSignals' `catch { setSignals([]) }` blanked the Signals tab + chart markers on ANY transient endpoint stall (a 15s server queue-up did exactly this to the user); and a regen `--persist` wipe+reinsert of signal_history was invisible to open tabs — the wipe runs on the harness's own DB connection (no signal_removed per row) and signal_new broadcasts are additive-only.
- Action: useTerminalData handles the `signals_resync` WS message (broadcast via the new POST /api/signals/resync-broadcast, fired by the harness after persist) with a FULL fetchSignals — replacement setState is what conveys deletions — and bumps `signalsResyncNonce` (new TerminalData field). SignalsView takes it as an optional prop keying its date-browse fetch effect; the nonce is deliberately in the dep array WITHOUT being read in the body (comment it so a cleanup pass doesn't remove it). Fetch failure now keeps the displayed set only when `signalsGenRef` (gen of last successful fetch) matches the current gen — switch-then-fail still blanks, so cross-interval rows never linger.
- Gotcha (verification): the interval buttons live in the MarketView HUD portal — when the user closed the HUD only the "▣ MES" restore chip exists, and the HUD is reachable only from the Market tab; dispatch .click() on the chip first. Fiber probe from `__reactContainer$` on #root, matching hook-state arrays by shape (`entry`+`ts` = signals, `o`+`c`+`time` = candles), is reliable for counting per-interval signal state.
- Confidence: high

**2026-07-30 — Perf round (terminal/SignalsView.tsx, hooks/useTerminalData.ts)**
- Observation: every consumer of GET /api/signals/history that filters to a range client-side should pass `?since=<cutoff>` — the server pre-trims (1m: 1.96MB → 583KB) and the client filter stays as defense in depth (older servers ignore the param). SignalsView date-browse passes `since=rangeStart`; useTerminalData passes its loaded-range/30-day cutoff.
- Action: Intl.DateTimeFormat must NEVER be constructed inside a per-row map (fmtEtTime built one per signal row — seconds of main thread on a 1m refetch); hoist to module scope. `signal_new` WS messages now carry `rows` — apply incrementally via the shared validator + COALESCE-mirror merge instead of refetching; `signal_removed` deletes by `${timestamp}-${direction}`.
- Confidence: high

**2026-07-29 — Backtest-grade signal rows (terminal/SignalsView.tsx, terminal/SignalDetail.tsx, terminal/TerminalLiveChart.tsx, hooks/useTerminalData.ts)**
- Observation: signal_history now carries exit_price/exit_ts/points_result/mae/mfe/bars_to_exit and a distinct "eod" outcome. mapPnl PREFERS points_result (tp/sl arithmetic is only the legacy fallback); mapStatus maps "eod" → new SignalStatus "EOD" (gray via statusColor). The plain-English outcome text lives in ONE place: `outcomeWords()` exported from SignalDetail.tsx (recorded outcome via displayOutcome first, walked status fallback) — import it, never re-derive.
- Action: SignalsView's 12-column layout is an INLINE gridTemplateColumns override (SIG_GRID) on .tt-thead/.tt-trow — the shared 11-col default in terminalStyles.ts is untouched because other views ride it. Header win rate mirrors the workbook metricsOf: wins / (wins+losses+eod), NOT wins/(wins+losses).
- Action: outcome-styled chart markers draw on the OVERLAY CANVAS (drawFootprint block before the selected-signal lines), NOT the lw-charts marker plugin: resolved statuses (TARGET / TP1 HIT / STOPPED / EOD) are excluded from setMarkers and drawn as triangles anchored bar-low/high ± offset via timeToXSnap + series.priceToCoordinate (win = solid + subtle green halo, loss = stroke-only hollow red, eod = gray). The plugin keeps ONLY unresolved rows, so plugin + canvas = every signal in candle range; the markers effect must call scheduleFpDraw().
- Gotcha: `key={c.label}` on confirmation chips collides (several facts share a strategy display name) — key by label+index. Browser-pane automation: ref/coordinate clicks can land offset; dispatch .click() on the VISIBLE matching button (first textContent match may be a hidden 0-rect element — filter by getBoundingClientRect().width > 0).
- Gotcha (data): a fresh tab's hidden MarketPage persists deep-history recomputes within seconds of load — market.tsx now floors persistence at 30 days (display-only older) and the server floors POST at 120 days; without those floors any pre-window DB purge is undone on next page load.
- Confidence: high

**2026-07-15 — Fractal Geometry Confirmations toggle + PML/TML lines (terminal/strategyMeta.ts, terminal/TerminalLiveChart.tsx, lib/terminalSettings.ts)**
- Observation: the established recipe held exactly — a new confirmation-fact toggle needed ONLY StrategyToggles + DEFAULT_STRATEGIES + the two typeof-boolean-gated mwb mirror lines in terminalSettings.ts and one STRATS entry in strategyMeta.ts (key "FractalGeo" → mwb `fractalGeoConfirmEnabled`); the dropdown row/chip/Info tab all derived. New per-day chart content (the gold E/S VECTOR strip) needed ZERO client changes — it rides the day-zones `bands` array through the existing band-run renderer (server adds `type:"es_vector"` + YB_CACHE_VER bump).
- Action: LIVE-ONLY levels with no history (PML/TML) do NOT fit the bands/day-zone pattern — they're full-width dashed lines from a 3-min-polled ref (`pmlTmlRef`) drawn right after the yellowbox stack, gated by the same YellowBox toggle. Poll effect keyed [symbol, strategies.YellowBox] with a `window.setInterval`, not barSig (levels are time-based, not bar-based).
- Gotcha: a browser tab left open across another agent's shared/ commit keeps a poisoned vite module graph (ReferenceError on a symbol that plainly exists, same ?t= stamp even after dev-server restart + force reload) — open a FRESH tab before believing the error. Hidden panes never paint (no rAF): verify overlays via React-fiber ref probes + endpoint curls, not screenshots.
- Confidence: high

**2026-07-14 — No-jargon display names (terminal/SignalDetail.tsx)**
- Observation: SignalDetail rendered the RAW outcome string (`win_tp1`/`loss`) at the OUTCOME row, and its CONFIRMATIONS chips only understood the legacy `{milkOk,vecOk,...}` shape — fact-engine rows (`{facts:[{s,d,k,lvl}],anchor,session}`) showed no chips at all.
- Action: user-facing identifier text must route through `shared/signal-display.ts` (`displayOutcome`, `displayStrategy`, `displaySignalType`) — the SAME map the backtest workbook uses; when parsing confirmations, handle BOTH the legacy object shape and the fact-engine `facts` array. Never print a signalType/outcome/strategy key verbatim in JSX.
- Confidence: high

**2026-07-14 — Signal-integrity round (SignalsPanel.tsx, terminal/SignalsView.tsx, CandlestickChart.tsx)**
- Observation: three components in this dir carried divergent signal logic: SignalsPanel's standalone mode ran its OWN runFactEngine pass over panel-fetched candles (a second signal set vs the terminal), SignalsView's date-browse skipped the ETH/session filter useTerminalData applied AND both applied a 5-bar cluster dedupe that hid persisted rows, and CandlestickChart still carried the retired vector-cross plumbing (entrySignals/tradeSegments/renderTradeSegment) that no caller fed.
- Action: standalone SignalsPanel now consumes GET /api/signals/history (computeSignals + secondaryCandles deleted); both SignalsPanel and SignalsView import `isSessionLegalSignal` from `@shared/signal-rules` (ONE validator, close-time semantics = timestamp + interval secs) — never re-implement session checks locally. Cluster dedupe is gone (engine cooldown already spaces fires). SignalsPanel date defaults are ET (`Intl en-CA America/New_York` for the calendar day; ET-midnight for the cutoff — machine-local midnight is wrong for any non-ET machine).
- Action: when removing a dead chart prop from CandlestickChart, sweep ALL of: props interface, destructure, ref + sync effect, render block, redraw-effect dep array, and the exported type/renderer it referenced.
- Gotcha: reading the SignalsView list text right after a date-browse click races the fetch (shows 0); the fiber hook state is the truth.
- Confidence: high

**2026-07-14 (latest) — Yellow Box session-snap ported to CandlestickChart.tsx (drawAll)**
- Observation: Same bar-index-vs-linear-time defect as the terminal (entry below). CORRECTION to that entry's precondition note: CandlestickChart's series does NOT contain whitespace gap spacers anymore (removed long ago — "user wants no gaps"). The remaining logical-index shift is the setData loop's invalid-bar FILTER (skips non-finite/≤0 OHLC and high≤low bars), so `sortedCandlesRef`/`candlesRef` indices ≠ series logical indices.
- Action: Added `seriesTimesRef` = times of the EXACT array handed to `series.setData()`; assigned right before `setData`, and `updateLastBarClose`'s new-bucket branch pushes `bucketSec` (inside the same try as `series.update`) so the live rollover append stays 1:1. YELLOW-BOX block now binary-searches `seriesTimesRef` for each box's first/last bar index and maps index→x via `idxToX(i)=refBarX+(i−refBarI)·pxPerBar`, anchor = two rightmost bars with non-null `timeToCoordinate`. NOTE this differs from the terminal fix's `getVisibleLogicalRange()/cw` linear map on purpose: drawAll's `cw` (container width) INCLUDES the ~60px right price axis, so a logical-range-onto-cw map would stretch boxes; the timeToCoordinate-anchored form is exact and consistent with every other coordinate in drawAll. lw-charts v5 `timeToCoordinate` returns real coords (even off-screen/negative) for EXISTING bar times and null only for absent times — the old `estX` only extrapolated (wrongly, time-linearly) on the null case, i.e. for session-boundary timestamps inside the 17:00-18:00 halt.
- Verified: tsc + build clean; /classic shows a gold box on EVERY session, adjacent boxes tile exactly at seams (rawRight[i] == rawLeft[i+1]), weekends zero-width. Hidden-tab harness trick: `document.hidden` browser pane → no rAF → nothing paints; patch rAF to setTimeout, grab `chartRef`/`drawAllRef` from the React fiber hook chain, `chart.takeScreenshot()` once to FLUSH a pending `setVisibleLogicalRange` (it's deferred!), then `drawAllRef.current()`, then screenshot again and composite.
- Confidence: high

**2026-07-14 (later) — Session-spanning overlays MUST use bar-index X, never linear-time (TerminalLiveChart.tsx)**
- Observation: The `estX` linear-time fallback (`refX + (t−refT)·pxPerSec`) is WRONG for anything spanning sessions: the lw-charts x-axis is bar-index spaced (overnight/weekend gaps take no width), so off-visible sessions over-stretch and drift left until the off-screen guard skips them — the user saw Yellow Boxes on only 2 sessions. It is only safe for short intra-session spans near the visible range (the milk-zone use).
- Action: For session-spanning shapes, binary-search the candle array for the session's first/last candle indices and map logical→x LINEARLY from `timeScale().getVisibleLogicalRange()`: `x=((L−vr.from)/(vr.to−vr.from))·cw`. Do NOT call `timeScale().logicalToCoordinate()` — in this build it returns 0 (not null) for every input, silently zero-widthing every shape with no exception; if a canvas layer draws nothing but its data/gates are fine, log the raw coordinate values first. Precondition: the series data must equal the candle array 1:1 (holds for TerminalLiveChart, `setData(dedupe(candles))`; does NOT hold for CandlestickChart whose series contains whitespace gap spacers).
- Action: Draw-order for the day-zone stack: red/green range shading → dashed levels → LongAve/ShortAve → gold box → labeled persistent bands, all BEFORE the milk-zone block so milk/footprint/signals stay on top. Band labels: `${label} ${bottom}-${top}` at the band's left edge, skip when <11px tall or <90px wide.
- Confidence: high

**2026-07-14 — Yellow Box layer added to TerminalLiveChart (terminal/TerminalLiveChart.tsx, terminal/strategyMeta.ts)**
- Observation: The terminal chart the user actually watches is `TerminalLiveChart` (`.tt-livechart`, route "/"), NOT the market page's CandlestickChart (collapsed 0×0 by default). It's a hybrid: lightweight-charts draws candles/vectors; ALL band overlays go on its own 2D canvases (fpCanvasRef z3 / probCanvasRef z4) via `drawFootprint`. The `estX`/`pxPerSec` coordinate estimator there is scoped INSIDE the milk-zone `if` block — a new overlay block after it must build its own copy.
- Action: To add a band layer: ref pair (`xxRef` data + `xxOnRef` toggle, assigned in the render body next to `milkOnRef`), a fetch effect keyed `[symbol, barSig, strategies.X]` (barSig=`len:lastTime` — refetches when deep-history lazy-load prepends bars, so the layer extends automatically), a draw block in `drawFootprint` after the milk-zone block gated `xxOnRef.current && xxRef.current.length`, and a `scheduleFpDraw()` effect on the toggle. Off-screen sessions must be SKIPPED (`rawRight<0 || rawLeft>cw → continue`) — a full-width fallback tiles gold stripes.
- Action: A terminal strategy toggle needs NO terminal.tsx change: add the key to StrategyToggles + DEFAULT_STRATEGIES (+ load/save mwb mirror) in lib/terminalSettings.ts and one STRATS entry in strategyMeta.ts — the dropdown row, ACTIVE STRATEGIES chip, and Info tab all derive from STRATS. Default-ON for existing profiles is guaranteed by `{...DEFAULT_STRATEGIES, ...saved}` — keep any mwb override `typeof === "boolean"`-gated so a missing key never collapses to false.
- Confidence: high

**2026-07-14 — Yellow Box layer added to the canvas overlay (CandlestickChart.tsx)**
- Observation: New per-trading-day "Yellow Box" boxes fit the EXISTING `zones` mechanism exactly — the single `<canvas>` overlay drawn in `drawAll`, NOT a lightweight-charts series/primitive (adding a series risks the locked-in Y-autoscale). A new prop layer needs 4 mirror pieces: a `yellowBoxes?: YellowBox[]` prop, a `yellowBoxesRef`, a `useEffect` that syncs the ref + `requestAnimationFrame(drawAll)` (copy the `zones` effect verbatim), and a render block inside `drawAll`. The render block MUST go AFTER the `if (zonesRef.current.length>0){…}` closes but still inside the coordinate-setup `{}` (so `estX`/`series`/`cw`/`clipBottom` are in scope) — placing it inside the zones `if` would make it never run when no milk zones are uploaded (the normal case).
- Action: For any session-spanning box, clip off-screen boxes explicitly — `estX` EXTRAPOLATES via `pxPerSec` for times outside the visible range, so a box left of view returns a NEGATIVE X. Use `if (rawRight < 0 || rawLeft > cw) continue;` then `bxLeft=max(0,rawLeft)`, `bxRight=min(cw,rawRight)`. A `: cw` "keep it on screen" fallback instead tiles every off-screen day as a full-width horizontal stripe (flooded the whole pane; ~1.65M gold px). Draw the box `if (brh>=1)` and draw per-day dashed levels with `ctx.setLineDash([5,3])` from `bxLeft`→`bxRight` (session width, not full width). Gold = `rgba(245,217,10,·)` (#f5d90a), init-res `rgba(239,154,154)`, init-sup `rgba(165,214,167)`.
- Action: VERIFY the render visually, not just by pixel counts. A gold-pixel scan said "boxes drawing" while the screenshot showed the stripe flood. Also note: the market `CandlestickChart` lives in a collapsible panel that renders 0×0 by default and the visible chart is a separate floating `.tt-livechart` (TerminalLiveChart) — to inspect the real chart, read `yellowBoxes` off the React fiber (`memoizedProps`) and/or force the `display:none` ancestor visible with an explicit flex height.
- Confidence: high

**2026-07-13 — Fact-engine defect round (SignalsPanel.tsx, SettingsView.tsx, CandlestickChart.tsx, FootprintPanel.tsx, TerminalLiveChart.tsx, footprintAggregate.ts)**
- Observation: SignalsPanel's standalone `computeSignals` was a SECOND copy of the retired points model (proxy footprint delta gate + points>=4) that silently diverged from market.tsx; its local `isRTH` was a hardcoded 21:00-UTC window — wrong under EST. The SignalDetail "Footprint" section + mid-trade divergence banner rendered a reading shape whose server producer no longer exists.
- Action: standalone panels must call `runFactEngine` from `@shared/fact-engine` (identify each candle slice's REAL interval from min bar spacing, never trust the declared label) and import `isRTH`/`isMarketBreak` from `@shared/firing/session`. When deleting a server broadcast (e.g. `footprint_alert`), delete the WHOLE client chain in the same pass: WS handler → state → prop → UI block. The candle-level footprint delta FIELD is gone from FootprintCandle — displays must compute `totalAskVol - totalBidVol` (FootprintPanel + TerminalLiveChart do this now).
- Confidence: high

**2026-06-02 — Footprint ladder anchoring (CandlestickChart.tsx)**
- Observation: Session footprint ladders are meant to anchor to each session's FIRST candle (`candleFootprints`/`fpMap` is keyed by `sg.candles[0].time` in market.tsx:2334; ladder loop draws at `ts.timeToCoordinate(fp.time)`). A separate block pinned the most-recent completed session's ladder to the RIGHT EDGE (`renderFpLadder(prevSessionFp, cw - C_TOT - 2)`), overriding the first-candle anchoring the block's own header comment describes.
- Action: To get "ladder on the first candle of each session," REMOVE the right-edge pinned `prevSessionFp` block (+ its `visPriceTop`/`visPriceBot` calc and the dedupe-skip guard in the per-session loop). The per-session loop alone (`for (const fp of allAggsFp) renderFpLadder(fp, xf)` with `xf<0||xf>cw` off-screen guard) renders every session's ladder on its first candle. Ladders intentionally disappear when the first candle pans off-screen — that's the design.
- Confidence: high

**2026-06-02 — Footprint ladder must span full session HOD→LOD (CandlestickChart.tsx)**
- Observation: `renderFpLadder` row sampler `visible.filter((lv,i)=> i%skip===0 || lv.price===fp.poc)` always keeps index 0 (session HIGH/HOD) but DROPS the last index (session LOW/LOD) unless it lands on a `skip` multiple — so when zoomed out the ladder reached the HOD but stopped a few rows short of the LOD. Session levels themselves already span low→high (`prices[0]`=low, `prices[last]`=high in market.tsx buildAggregate), so the data was fine; only the sampler truncated.
- Action: add `|| i === visible.length - 1` to the row filter so the lowest visible level is always drawn. Top row already = highest visible level. The outer border uses rows[0]/rows[last], so the column now spans HOD→LOD. Zones (Step 1 imbalance bands) and ladders (Step 2) both render whenever `showFpPanel` is on — there is NO separate zones/ladder mode toggle.
- Confidence: high

**2026-06-02 — Footprint imbalance zones must be CLUSTER-sized, not per-bucket (CandlestickChart.tsx)**
- Observation: The "new UI change" (commit jump 8a3ae11 → 3d93296, "sync latest local changes") rewrote Step-1 footprint zones from cluster-based to per-2pt-bucket bands + added a right-edge pinned ladder. User wants the pre-change behavior: each zone = the SIZE of the imbalance on the ladder.
- Action: Restore the 8a3ae11 Step-1 logic — iterate `zfp.imbalances`, draw only `cl.stacked` clusters as a full-width band spanning `cl.startPrice`→`cl.endPrice` (±0.5), full opacity for the on-screen/current session and 0.28 for historical, tier opacity (×1.0/1.4/1.8), and DROP historical zones once a later candle CLOSES through the cluster midprice (inline binary-search mitigation over `candlesRef`, cutoff `zfp.time + 25000`). The ratio≥1.3 / net≥100 / stacked=2+ rules live upstream in market.tsx `buildAggregate` (`imbalances`). To find the "before" code, `git show 8a3ae11:.../CandlestickChart.tsx`.
- Action: Ladder stays anchored to each session's FIRST candle (no right-edge pin) and spans HOD→LOD (keep the `i === visible.length - 1` row so the LOD row isn't dropped by the `skip` sampler). `fmtVol` is defined once at the outer footprint scope (~L1544) — do NOT redefine it when editing the session block.
- Open: kept the current 80px net-delta single-column ladder (documented user preference) rather than the 8a3ae11 175px two-column bid×ask|total. Flagged to user.
- Confidence: high

**2026-06-02 — Terminal live charting must bucket to the display interval (useTerminalData.ts)**
- Observation: The MERIDIAN terminal's own chart (pages/terminal.tsx → TerminalLiveChart, fed by hooks/useTerminalData.ts) drove candles independently of market.tsx. Two bugs: (1) live `bar` messages arrive at resolution "5" for a 15m chart but were appended at the RAW 5m time with REPLACE semantics → 5m candles misaligned onto 15m history and lost the bucket's accumulated high/low; (2) the `tick` handler only edited the last candle (no rollover), so 15m/60m never opened a new candle from ticks (the server emits only 1m/5m bars, never "60").
- Action: Mirror market.tsx. Bar handler: bucket 5m→15m (`Math.floor(t/900)*900`, accept "5" or exact "15"), and MERGE on same bucket (keep open, max high, min low, new close) instead of replace. Tick handler: compute the display bucket from `Date.now()` (`ivSecs`), append a NEW candle when `bucket > last.time` (seed open from tick on >0.5% gap, else last close), clamp >2% single-tick prints only WITHIN the bucket. Keep a `lastBarRef` mirror of the tail candle so both handlers bucket/merge without depending on setState `prev`.
- Note: market.tsx's engine chart (candles + live: validate OHLCV, 20% outlier reject, binary-search merge, useLayoutEffect init, series.update() fast path with bucketSec rollover) was already correct — left untouched. Verified `npm run check` + `npx vite build` clean. The full `npm run build` fails only on a PRE-EXISTING server esbuild error (top-level await in server/routes.ts + cjs output) — unrelated to the chart; dev (`tsx`) runs fine.
- Confidence: high

**2026-06-02 — Terminal chart drifts stale / drops candles without a reconcile poll (useTerminalData.ts)**
- Observation: The terminal chart only loaded candles on mount/reload and relied on live WS `bar`/`tick` + `data_updated`. Unlike market.tsx (which re-polls the DB as a fallback), there was NO reconciliation — so any `bar` missed during a WS hiccup/reconnect was lost permanently → "a candle is missing" + chart looks frozen ("not live anymore"). Compounded by the pre-fix 15m bucketing bug (now fixed) that had been mis-appending live bars.
- Action: Added a 15s `reconcile()` poll in useTerminalData — re-fetch `/api/data/cached-continuous` and MERGE server bars into the array (preserve the live forming candle when `live.time >= lastServerTime`), keeping `lastBarRef` in sync. Gated on `!document.hidden`. This recovers any missed bar and keeps the chart matching the engine DB. The forming candle is NOT clobbered.
- Action: Fixed the misleading LIVE/DELAYED badge. It was `live = open(RTH) && source` → ALWAYS "DELAYED · ETH" outside 9:30–16:00 even when futures stream live in ETH. Now useTerminalData consumes the server's `feedStatus` WS message (live/stale/unknown) and exposes it + `connected`; MarketView computes `live = connected && hasSource && feedStatus !== "stale"` (RTH/ETH is just the session suffix). Defaults optimistic when feedStatus is "unknown".
- Confidence: high

**2026-06-02 — Real-data footprint in the terminal + Info tab + news ticker**
- Footprint: the terminal chart (`TerminalLiveChart.tsx`) now renders the OLD on-chart footprint
  (session ladder anchored to each session's first candle, full HOD→LOD, net-delta column +
  cluster imbalance ZONES sized to the cluster) as a `<canvas>` overlay synced to the
  lightweight-charts v5 time/price scales (`subscribeVisibleTimeRangeChange` + ResizeObserver +
  data effects, coalesced via one rAF in `drawFpRef`). Fed by REAL data: `/api/footprint/history`
  → `footprintAggregate.ts aggregateSessions()` groups real per-candle MW footprints into RTH/ETH
  session aggregates (POC/VA/clusters), a port of `market.tsx buildAggregate` but summing real
  `levels` bid/ask instead of `buildProxyFootprintCandle`. Replaced the old POC/VAH/VAL price-lines.
  `.tt-livechart` is `position:fixed` so an `inset:0` canvas anchors to it.
- Info tab: expanded `strategyMeta.ts` (added `title/tagline/how/signals/tips` + `SIGNAL_OVERVIEW`),
  new `InfoView.tsx`, `Ico.info`, and a 4th `"info"` tab in `terminal.tsx`.
- News ticker: server `GET /api/news/ticker` (in `routes.ts`) fetches free RSS (Yahoo/NYT/WSJ/
  CNBC/MarketWatch + Google-News RSS search for Morning Brew & Berkshire), parses with
  `fast-xml-parser`, upserts into the existing `news_articles` table (url unique →
  onConflictDoNothing), returns newest 40, cached 10 min, and falls back to the DB on feed
  outage. Client `NewsTicker.tsx` = CSS marquee (duplicated track + `translateX(-50%)`, pause on
  hover), clickable `<a target="_blank">`, mounted under the header. Verified all feeds return
  200 and parse (Google-News `<source>` resolves the real publisher).
- Verified: `npm run check` (tsc) clean, `npx vite build` clean. Server routes (spike-filter fix
  + news ticker) need the dev server (tsx) to reload to take effect; full `npm run build` still
  fails only on the pre-existing server esbuild top-level-await (unrelated).
- Confidence: high

**2026-06-02 — Market HUD made draggable + resizable (MarketView.tsx)**
- Observation: the "MES front month · futures" panel (`.tt-hud`) was in normal flow inside
  `.tt-view`, which animates with `transform` (viewIn) — so making it `position:fixed` in-place
  would jump on tab-enter (a transformed ancestor becomes the fixed containing block).
- Action: render the HUD via `createPortal(..., document.body)` so it's always viewport-fixed
  (no transformed ancestor). Drag-to-move (pointerdown anywhere except buttons/links/inputs/the
  resize grip) + a bottom-right resize grip (`.tt-hud-resize`), via window pointermove/up
  listeners created per-drag. Position/size persisted to localStorage `meridian_hud_box`
  ({x,y,w,h}); double-click empty area resets to default. Inline `maxWidth:"none"` overrides the
  `.tt-hud` 760px clamp; `zIndex:6` floats above chart(0)/footprint(5). Default x=240 clears the
  now-left-side footprint panel. `.tt-fp` was also moved right→left (`left:14px`).
- Confidence: high

**2026-06-03 — Milk zones restored to the old filled-band render + HUD close button**
- Observation: the terminal drew milk zones as thin top/bottom `LineSeries` segments (a pool of
  24 line series, time-bounded to the RTH session). The "perfect" pre-UI-change look was the
  CandlestickChart canvas render: a filled rect fromTime→toTime, fill/border/label colors derived
  from `zone.color` (rgba → #hex via hexToRgba → support/resist keyword), top/bottom price labels,
  zone-name label, anchored via a px-per-sec estimator (`estX`) so off-screen-anchored zones still
  render. Data source unchanged (PNG-upload only via lib/milkZones.ts — the rule holds).
- Action: ported that exact band render into TerminalLiveChart's overlay canvas (drawFootprint),
  drawn BEFORE the footprint so footprint sits on top. Removed the LineSeries pool
  (`zoneEdgeSeriesRef`/`ZONE_POOL`) + its effect; the milk-zone effect now just calls
  `scheduleFpDraw()`. Added refs `milkOnRef`/`milkZonesRef` + a `hexToRgba` helper. The overlay
  draw no longer early-returns on `!fpOn` — it clears, draws zones if MilkZone on, then footprint
  if Footprint on. MilkZone `{top,bottom,fromTime,toTime,color,label}` maps onto the old
  `{topPrice,bottomPrice,...}` fields inline. Skipped the old gap-fill (only applied to zones with
  NO fromTime/toTime; terminal zones always have both).
- Action: MarketView HUD got an ✕ close button (sets persisted `hidden`); when hidden a small
  "▣ SYMBOL" restore chip renders at the saved position (portal to body); double-click empty panel
  resets position/size.
- Confidence: high

**2026-06-04 — Signal parity check + clickable chart signals (terminal)**
- Observation: signal FIRING is engine-side and unchanged — `App.tsx` keeps `MarketPage` (the
  legacy engine) ALWAYS mounted (display:none) doing signal computation + WS + auto-trade; the
  terminal is a pure consumer of `/api/signals/history`. The Signals TAB already had full parity
  (click row → `SignalDetail` = exit strategy levels + R:R + P&L + confirmations + footprint
  reading + `SignalMiniChart`). The only gap: chart signal markers weren't clickable.
- Action: extracted `SignalDetail` (+ `statusColor`) to `components/terminal/SignalDetail.tsx`
  (shared by SignalsView + the chart). Added `chart.subscribeClick` in TerminalLiveChart's init
  effect: match the click x to the nearest signal's `timeToCoordinate(ts)` within 16px → fire
  `onSignalClick(signal)` (via `signalsRef`/`onSignalClickRef` so the once-subscribed handler
  stays current). terminal.tsx holds `chartSig` state, passes `onSignalClick={setChartSig}`, and
  renders `<SignalDetail>` — so clicking a marker on the Market chart opens the same detail
  (exit strategy + mini chart) as the Signals tab. Works on the Market tab because
  `.tt-main.passthrough` is pointer-events:none, so clicks fall through to the chart.
- Confidence: high

**2026-06-04 — Signal click → visual TP/SL lines on chart + AutoTrader Settings card**
- Observation: "see the exit strategy" meant the VISUAL horizontal price-lines on the main chart (like the old CandlestickChart), not a modal.
- Action: ported `renderConfluenceSegment` from CandlestickChart.tsx into the terminal's overlay canvas `drawFootprint`. When a signal is selected (`selectedSigRef`), draws colored horizontal lines (TP2/TP1/Entry/Stop), labelled with price, + colored fill bands for profit/risk zones spanning entry→right edge. Redraw triggered by a dedicated `useEffect([selectedSig])`. `onSignalClick` now passes `null` when clicking empty space (clears selection). Click same signal again also clears. `Escape` key clears. The click matcher was changed from pixel-distance (16px threshold — too tight) to time-based (`param.time` vs `signal.ts`, within 2 bar intervals) + fallback pixel at 60px. `TerminalSignal` uses `entry` (not `price`) — confirmed.
- Action: added `AutoTraderCard` to SettingsView.tsx — polls `/api/trade/status` + `/api/trade/current` every 5s for connection/trade state; loads settings from `/api/trade/settings`; ARM/DISARM button (POST enabled:true/false); contract type (MES/ES), contracts per trade (1–10), direction (Both/Long/Short), exit mode (TP1+TP2 / TP1 Only). Live warning banner when enabled.
- Confidence: high

**2026-06-04 — Live signals not appearing in terminal (two root causes)**
- Observation: Signal engine (market.tsx line 3040) had `if (s.outcome === "open") return false` — newly fired signals were NEVER written to DB until they already closed. So the terminal received `signal_new` broadcast and fetched from DB, but the signal wasn't there yet. Also useTerminalData had no periodic signal poll, so a missed WS broadcast meant the signal never appeared.
- Action 1 (market.tsx): change dedup key to include outcome: `${sym}_${iv}_${time}_${dir}_${outcome}`. This lets signals be written TWICE — once on first fire (outcome=open, terminal sees it immediately) and again when outcome resolves (upsert updates to win/loss). Removed the `outcome === "open"` skip entirely.
- Action 2 (useTerminalData.ts): added 30s `fetchSignals` poll (like the 15s candle reconcile) so signals are refreshed even if `signal_new` WS broadcast is missed or arrives before the DB write completes.
- These two fixes together: live signal fires → immediately persisted → signal_new broadcast → terminal fetches → signal appears with outcome=ACTIVE. When it closes → re-persisted with win/loss outcome → terminal updates at next poll or next signal_new.
- Confidence: high

## What Has Failed
- (Nothing recorded yet)

## Patterns and Preferences
- (Nothing recorded yet)

## Open Questions
- (Nothing recorded yet)
**2026-08-10 — Interval pin in the Signals tab (terminal/SignalsView.tsx)**
- Observation: the tab was hard-wired to the chart's `interval` prop in SEVEN places (date-browse fetch ×2, isSessionLegalSignal, annKey, RiskCell, IV cell, SignalDetail) and the "today" fast path silently assumes the live props are chart-interval data — so "show another interval without changing the chart" is NOT a fetch tweak, it's `const iv = ivPin ?? interval` swapped into all seven + a `followLive = isToday && iv === interval` gate that routes today-with-a-pin through the fetch path (the live `signals`/`candles` props are the WRONG interval the moment a pin diverges).
- Action: pinned-today lists don't ride the WS stream (chart-interval only) — add a 60s `pollNonce` interval effect gated `!followLive && isToday`, with the nonce in the fetch deps unread (comment it, same idiom as signalsResyncNonce). Keep the pin as plain component state (no terminalSettings write) so the chart provably cannot be affected; surface it in the stat label ("SIGNALS TODAY · 5M") and add `iv` to the tbody key so the row stagger re-runs on a pin switch.
- Gotcha: computer-tool ref clicks on the header tab buttons didn't switch tabs in the hidden pane — the dispatch-.click()-on-visible-button rule (2026-07-29 entry) applies to the TAB BAR too. React date inputs need the native value setter + input/change events. `javascript_exec` has no top-level await — return a Promise instead.
- Confidence: high

**2026-08-12 — THOUGHTS narration panel (terminal/ThoughtsPanel.tsx, pages/terminal.tsx)**
- Observation: the MarketView HUD idiom (createPortal + drag-anywhere + .tt-hud-resize grip + double-click reset + hidden→restore-chip, persisted as one localStorage box key) transplants cleanly into a second floating panel — copy the beginDrag/onPointerDown closures verbatim and only change the storage key/default box. Mount beside FootprintPanel in terminal.tsx gated `tab === "home"` (no strategy toggle needed — the ✕/chip is the dismissal).
- Action: a "what is the system thinking" narration must DERIVE, never re-implement: vector via @shared/firing/vector (map TerminalCandle {o,h,l,c} → FiringCandle {open,high,low,close} — the type mismatch is a compile error, not a runtime surprise), dead-tape as DEAD_TAPE_SUPPRESS_MULT × useRiskComboStats().medianDayRange (the same served baseline the engine gets), zones/close-est from the chart's own endpoints, cooldown from FACT_ENGINE_DEFAULTS.COOLDOWN_BARS. Hedge every "lean" line as proximity description + an on-panel disclaimer that the gates decide. Session slice: walk backward from the array end (candle arrays reach 100k+ with full history — never filter the whole array per render); computeVectorLine over a 400-bar tail only.
- Gotcha: self-fetched rows race the first render — probe DOM for a data-dependent row only after the fetch settles (the EST CL row was "missing" at +2.5s and present at +30s). The hidden pane's javascript_tool can time out ("pane stuck") transiently — retry once before diagnosing.
- Confidence: high

**2026-08-12 (addendum) — floating-panel off-screen stranding (ThoughtsPanel.tsx, MarketView.tsx)**
- Observation: user report "the popup is gone" — persisted box positions are only clamped DURING drag; a box saved on a wider viewport (desktop vs phone, or landscape→portrait rotation) renders fully off-screen on load with no recovery path (the restore chip inherits the same stranded x/y; double-click-reset is unreachable off-screen).
- Action: clamp the box to the CURRENT viewport in loadBox AND on resize/orientationchange (both floating panels). Verified by stranding at (2400,1800) → clamps to (1190,650) in a 1280×720 pane on reload, corrected position persists.
- Confidence: high

**2026-09-17 — Contract-mismatch state on the feed badge (terminal/FeedStatusBadge.tsx)**
- Observation: "the charting bug is back" was not a chart defect — the MotiveWave chart was on the September contract while Yahoo's ES=F had rolled to December (09-14 11:30 ET), so two 66-pt-apart series interleaved in the store and the chart drew cliffs. The user's stale tab (bars stopped at 06:20 while the clock read 10:05) was a slept PC + server restart; a fresh load rendered current bars. Verified via the fiber probe (candles state: last bar time/age + a 3-day ≥30-pt jump scan) — the hidden pane still cannot screenshot.
- Action: the header badge now reads `contractGuard` from GET /api/mw/sync-status (server/contract-guard.ts) and, when `offContract`, outranks the other states with a RED pill "MW OFF-CONTRACT · Δ −66.50 · YAHOO DRIVING" + a tooltip naming the action (roll the MW chart; orders are blocked; MW resumes automatically). Same self-contained 30s poll, no useTerminalData coupling — the badge owns feed provenance. Nothing else in the client changed: the fix is server-side arbitration (MW quarantined, Yahoo drives), and the chart simply consumes the canonical series.
- Gotcha: Yahoo's 1m chart feed ran ~10 min behind real time today, so while MW is quarantined the chart's newest bar is ~10 min old — that is the feed, not a client bug (the badge tooltip says so).
- Confidence: high

**2026-09-18 — Chart liveness round (hooks/useTerminalData.ts, terminal/TerminalLiveChart.tsx, terminal/MarketView.tsx, terminal/FeedStatusBadge.tsx, pages/market.tsx, pages/terminal.tsx; DayTrading chart-view + use-market-data)**
- Observation: "laggy / trouble staying live" was FIRST a server event-loop problem (p90 7.6 s on an in-memory route — see LEARNINGS.md 2026-09-18), and only second a client one. Client-side findings: (1) the lw-charts tick fast path ("same length / first / last" → `series.update` of the last bar only) is ALSO the signature of reconcile() replacing an interior closed bar in place, so replaced bars kept their old shape until the next structural setData; (2) a `bar` message for the display's CURRENT bucket with a stale close (Yahoo's still-forming 15m/60m bucket, ~10 min old) overwrote the live tick close once a minute; (3) every `data_updated` re-downloaded the whole loaded history after the user had scrolled back; (4) most 15 s reconciles change nothing yet rebuilt a Map of the full dataset and re-rendered the terminal; (5) MarketView's HUD did O(dataset) work on every tick.
- Action: reconcile() detects interior OHLC changes OUTSIDE the state updater and bumps `candlesRevision` (TerminalData → `<TerminalLiveChart candlesRevision>`); a revision change takes the structural path classified APPEND/SAME so the view is left alone. Same-bucket bar merge keeps `last.c` (h/l still union) when a tick was accepted < 5 s ago and the bar is not a fresh complete one. `data_updated {fromTs}` → `reconcile(max(floor, fromTs))`, `fullyLoaded` cleared only when fromTs is absent/below the floor. reconcile() returns the SAME array when nothing changed. WS `contract_guard` flip/roll/offset events drop the current-bucket forming candle (it straddles two price regimes) and re-seed from the next tick; `snapshot` events only update `TerminalData.guard`. Stale-tick guard prefers the server-computed `msg.ageMs` (a tunnel client with a skewed clock silently dropped every tick under the browser-clock rule). market.tsx: `bar.provisional === true` is display-only — never into liveCompleteTailRef / liveCandles (the engine would evaluate bucket T twice); the 1 s `/api/live/bar` poll skips provisional/stale answers too; ticks there never write liveCandles, so "a recent tick owns the close" must NOT be applied in that file.
- Gotcha: a hooks-count change over HMR (useTerminalData gained five hooks) leaves already-open tabs in a broken state — hard-reload before judging. lightweight-charts 5.1 has `series.update(bar, true)` for historical bars (a cheaper interior repaint than setData); the phone's 4.2 throws on update() of an older time. In the hidden pane, a promise that waits on a 10 s timer can exceed the 45 s tool timeout — install `window.__probe` in one call, wait with the computer tool, read it in the next.
- Confidence: high on the mechanisms (code-traced + server-side verified); medium on the React-side paths until they have been watched through a real session (no runtime test exists for them).

**2026-10-06 — Shadow scalps card (terminal/ShadowScalpsCard.tsx, terminal/SignalsView.tsx)**
- Observation: a self-contained record-only card mounts into the Signals tab with exactly 2 SignalsView edits (import + `<ShadowScalpsCard />` after the table, before the toast). It reuses `.tt-card/.tt-card-head/.tt-table-wrap/.tt-thead/.tt-trow/.tt-filter/.tt-hint/.tt-prob-note` with an INLINE gridTemplateColumns override (the SIG_GRID idiom) — the shared 11-col default is untouched.
- Action: for the next shadow-* card, copy this one — pure helpers exported beside the component (tested by scripts/<name>.test.ts under tsx with a relative import, no `@/`), 60 s poll + one-shot 4 s retry, keep the last good table on a transient miss, 404 → "route not live yet" copy, status chips from the route's flags only.
- Confidence: high
