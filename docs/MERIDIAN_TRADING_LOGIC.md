# MERIDIAN Trading Logic — Ground-Truth Map & Authoritative Spec

> **STATUS: STEP 1 COMPLETE (2026-07-01) — GROUND TRUTH ONLY. NO BEHAVIOR HAS BEEN CHANGED.**
> Remaining ⟳ markers are traced in §4b. Phase 0 build is BLOCKED on the §5 decisions.
> No feature flags added, no firing logic touched, no StrategyGuard hashes re-registered yet.
> This document maps what the code does **today** and lists where it diverges from the
> AUTHORITATIVE FIRING MODEL (in the rebuild prompt), per Step 1 of that prompt.
>
> Sections marked **⟳ NEEDS DEEPER TRACE** are confirmed at a high level but the full
> line-by-line decision tree inside the 6,378-line engine still needs to be walked before
> Phase 0 coding begins.

---

## 0. ⚠️ CRITICAL PREMISE MISMATCH (read first)

The rebuild prompt states: *"Live now: a DFA-Hurst regime gate (computed inline in the Node
matcher) and a multifractal Δα measure (MFDFA in the Python service). These are already in
production — preserve their computation."*

**This does not match the repository.** As of this map:

- `grep -rniE "hurst|dfaHurst|regime|mfdfa|deltaAlpha|singularity" server/` → **zero matches.**
  There is **no DFA-Hurst regime gate in any Node/server file**, and **no live MFDFA/Δα wiring.**
- The fractal math (`client/src/lib/{hurst,ergodic,multifractal,fbm,hurstScaler}.ts`) exists
  **only on the client and is DISPLAY-ONLY** — it was wired into the terminal's Probability
  overlays in the 2026-06-26 session and explicitly *"never gates a signal or auto-trade."*
- The live **signal engine is client-side** (`client/src/pages/market.tsx`), **not** a "Node
  matcher." Signals are computed in the browser and POSTed to the server for storage.

**Implication for the rebuild:** the regime gate the prompt says to "preserve" does not yet
exist as a live gate.

### ✅ ARCHITECTURE DECISION (2026-06-26, "do what you think is best")

**Keep the live engine client-side in `market.tsx`, but extract the firing decision into a pure,
framework-agnostic module** (e.g. `shared/firing/` — no React/DOM imports) that BOTH the live
engine and a headless **Node backtest harness** import. The DFA-Hurst regime gate ports into that
shared module (the libs are already plain TS). Rationale:

- A full server-side rewrite of a working 6,378-line engine is high-risk and unnecessary; the
  engine already owns all strategy math (footprint/vector/zone/ATR/sessions).
- The prompt's real requirements are a **testable matcher + a live Hurst gate + flagged A/B** —
  all satisfied by a shared pure module, *without* relocating data access and the whole pipeline.
- Phase 1's baseline-vs-new backtest **requires** the firing logic to be callable headlessly; a pure
  module is the minimum refactor that makes that possible. (Today the logic is locked in a React
  component and cannot be backtested as-is.)

So Phase 0 = (1) extract current firing into the shared module unchanged (baseline), (2) add the
new SAFE-or-nothing model + Hurst gate behind a flag (default `false`) in the same module,
(3) build the Node backtest harness that calls both. **No live behavior change until the Phase 1
backtest is approved.**

---

## 1. System Map (where everything lives)

| Concern | Location | Notes |
|---|---|---|
| **Live signal engine** | `client/src/pages/market.tsx` (6,378 lines) | The always-mounted "ENGINE" (see `App.tsx`). Computes signals in-browser on closed candles, POSTs to `/api/signals/history`. **There is no server-side matcher.** |
| **Footprint strategy** | `client/src/lib/footprint-analysis.ts` (`analyzeFootprint`, `IMBALANCE_THRESHOLD`, `MW_IMBALANCE_THRESHOLDS`, `NET_THRESHOLDS`) + server `footprint-engine.ts` (real MW bid/ask) | Magnitude = imbalance ratio + net delta; tiers 2/3 via `MW_IMBALANCE_THRESHOLDS.tier2/tier3` & `NET_THRESHOLDS`. |
| **MilkZone strategy** | PNG ingestion: `server/zone-parser.ts` + `/api/zones/parse`; client uses `@/lib/milkZones` | Zones are an **uploaded-PNG input**, never engine-computed. RTH-only. (Per LEARNINGS, milk confluence is PNG-upload-only — not Discord/auto.) |
| **Vector strategy** | `computeVectorLine` in `@/lib/trading-utils`; multi-TF in `market.tsx` | `Highest(Lowest(low,20),20)`, multi-interval (1m/5m/15m/60m). |
| **DFA-Hurst regime** | `client/src/lib/hurst.ts` (DISPLAY-ONLY) | **NOT wired to firing.** No server copy. See §0. |
| **MFDFA / Δα** | `client/src/lib/multifractal.ts` (DISPLAY-ONLY) | **NOT wired to firing or exits.** No Python live service found wired to the engine. ⟳ NEEDS DEEPER TRACE (confirm no `ml/`/Python path feeds the engine). |
| **Signals schema** | `shared/schema.ts` → `signal_history` | Columns: `symbol, interval, timestamp, direction, riskLevel, signalType, entry, tp1, tp2, sl, outcome, patternBars, footprintReading`. Note `riskLevel` (tiers) + `patternBars` (pattern remnant) are still in the schema. |
| **Signals tab (UI)** | `client/src/components/terminal/SignalsView.tsx` + `SignalsPanel.tsx`; data via `GET /api/signals/history/:symbol/:interval` | Displays stored signals; date browser + mini-chart. |
| **StrategyGuard** | `server/strategy-guard.ts` + `strategies/*/strategy.json` | Guards 7 strategy JSONs (incl. `pattern-recognition/` and the new `probability/`). It **monitors file integrity only — it does not execute strategies.** |
| **PM2** | ⟳ no `ecosystem.config.*` found in repo root | Commit `ffbabc6` mentions "PM2 production setup"; config location TBD. |

---

## 2. Current Firing Logic (as implemented today)

**Output is TIERED, not SAFE-or-nothing.** `market.tsx` assigns each signal a `riskLevel` of
`safeplus | safe | risky | riskiest` and scores quality with:

```ts
// market.tsx:104
const RISK_QUALITY: Record<string, number> = { safeplus: 4, safe: 3, risky: 2, riskiest: 1 };
```

Exit geometry is a 3×(profile)×(tier) table of fixed TP1/TP2/SL points (`market.tsx:279–325`),
selected by tier and by the active exit profile (`safe`/`risky`/`riskiest`). Example (safe profile):
`safeplus {tp1:14,tp2:28,sl:3.5}`, `safe {12.5/25/4}`, `risky {9/20/5.5}`, `riskiest {7/16/8}`.

**Confluence model (today):** `safe` = zone + vector direction + body confirmation + within recent
zones; `risky`/`riskiest` relax those (per `CLAUDE.md` "Signal Levels"). The Vector is a hard
prerequisite for confluence signals; a separate `signalType: "vector-side-entry"` path fires the
ETH side-entry feature (`market.tsx:2825`).

**Traced fire decision (confirmed in code):**
- `allConfluenceSignals` (`market.tsx:410–459`, a "lightweight" version) is the clearest statement
  of the tier rule: on a closed bar, if `close > vector` (Long) then
  `riskLevel = milkBullOk ? "safe" : "risky"` — i.e. **zone-reaction + vector ⇒ `safe`; vector
  alone (no zone) ⇒ `risky`.** Mirror for Short with `milkBearOk`. `milkBullOk`/`milkBearOk`
  (`market.tsx:438/444`) = a candle reacting at an active uploaded zone in the trade direction.
- The **full live engine** (main loop ~`market.tsx:2543+`) layers on top of that: footprint
  imbalance tier (2/3), secondary-timeframe vector confluence, the 60m declining-vector veto for
  Longs, HOD/LOD proximity guards, the 3:15 PM ET cutoff, and the RTH/ETH session gate (ETH ⇒ only
  `vector-side-entry`). ⟳ NEEDS DEEPER TRACE for the exact ordering + the `safeplus` promotion rule.
- Net mapping to the authoritative model: today's **`safe`** ≈ the model's "confluence" (zone+vec
  ± footprint); today's **`risky`/`riskiest`** are the tiers to retire; today's **`vector-side-entry`**
  is the only solo path and it's **Vector-driven** — the opposite of the model (Vector never solo;
  solo = strong proven zone in RTH or strong Footprint in ETH).

**Sessions:** confluence/milk/vector/footprint signals are RTH-gated; during ETH **only**
`vector-side-entry` may fire (per `CLAUDE.md`). No signals at/after 3:15 PM ET (`market.tsx:95`).

**ATR:** `ATR_PERIOD = 14` (`market.tsx:2495`); legacy `TP_ATR_MULT=1.0`, `SL_ATR_MULT=0.5`
(`market.tsx:330–331`) used for the VEC signal, not the confluence table. ⟳ NEEDS DEEPER TRACE
for the exact ATR-14 **stop-floor** formula the prompt references.

---

## 3. Divergence List (current → AUTHORITATIVE MODEL)

| # | Authoritative model | Current implementation | Action |
|---|---|---|---|
| D1 | **SAFE-or-nothing** | `safeplus/safe/risky/riskiest` tiers live (`RISK_QUALITY 4/3/2/1`) | Retire tiers behind a flag; collapse to single SAFE output. |
| D2 | Regime gate **blocks** every fire via live DFA-Hurst | **No live Hurst gate exists** (§0) | Decide: port client Hurst → engine, or build in a real matcher. |
| D3 | Δα conditions the **Monte-Carlo exit** + is a read-only gauge | No Δα anywhere live; exits are the fixed tier table | Build MC exit engine; wire Δα as conditioning input only. |
| D4 | Solo-fire: strong proven zone (RTH) **or** strong Footprint (ETH); Vector never solo | Current solo path is `vector-side-entry` (Vector-driven, ETH) | Replace with zone-reaction + ETH-footprint solo rules; remove Vector solo. |
| D5 | Confluence: ETH = FP+Vector; RTH = any 2+ of {FP,MilkZone,Vector} | Tier-based confluence (zone+vec+body…) | Re-express as the 2+-vote table; cover every RTH/ETH cell. |
| D6 | Exits: zone-based when zones present, else **Monte-Carlo** (bootstrap primary, fBm cross-check, 85th-pct survive-the-noise) | Fixed point tables per tier/profile | Build MC exit; keep zone-based for RTH-with-zones. |
| D7 | Flat through scheduled high-impact news; empty TOD-exclusion config | ⟳ NEEDS TRACE — confirm current news-flat handling | Expose news window + empty TOD config. |

---

## 4. Retired-Feature Verification (prompt requires this)

> **CORRECTION (2026-07-01 deep trace):** the *emitted confluence signal* is ALREADY
> single-tier. `market.tsx:2887–2901` / `3010–3020` ("SINGLE-TIER … Every signal that fires
> is labeled 'safe'") fire a Long/Short only when `totalPts >= 4 || fpOnMilkZone ||
> fpPartialOnZone`, and hardcode `riskLevel = "safe"`. So the model's "SAFE-or-nothing" is
> **partly implemented in firing already.** The tiers survive in THREE non-firing places:
> (1) the **exit table** `EXIT_STRATEGY_PROFILES` (indexed by tier, but only the `safe` row is
> ever hit now), (2) **UI colors** (`safeplus/risky/riskiest` swatches, lines 3304/4789/5453…),
> and (3) the **vector side-entry path** which still emits `riskLevel:"risky"` (`market.tsx:2823`).

- **Tiers `SAFE+/RISKY/RISKIEST`** → **retired in confluence FIRING** (always `"safe"`), but
  **still present** in the exit table (`market.tsx:278–327`), UI, side-entry (`:2823`), and the
  `signal_history.riskLevel` column. Full retirement = collapse the exit table + side-entry + UI.
- **`4/3/2/1` weighted scoring** → **STILL PRESENT as the fire GATE** (`fpPts=4`, `milkPts` up to
  4, `vecPts=2`, threshold `totalPts>=4`, `market.tsx:2883–2893`). The `RISK_QUALITY 4/3/2/1`
  map (`:104`) is now only read by non-firing ranking UI. The *scoring-to-fire* is what the new
  SAFE-or-nothing solo/confluence table replaces.
- **Pattern Recognition / matrix-profile motif** → **ABSENT from live firing**: no
  `matrixProfile`/`motif`/`patternRecognition` references in `market.tsx` or `routes.ts`. Remnants:
  a `strategies/pattern-recognition/` doc folder (StrategyGuard-monitored, **not executed**) and a
  `signal_history.patternBars` column (vestigial). Safe to leave; remove the column/folder only if
  you want a clean schema.

---

## 4b. Additional confirmed facts (2026-07-01 trace)

- **Existing MC exit script is stale + wrong-objective.** `scripts/monte_carlo_exits.py` is a
  **grid-search that maximizes expected R** — which the prompt EXPLICITLY forbids ("do not substitute
  a grid-search that maximizes expected R; that overfits"). It also connects to **PostgreSQL**
  (`psycopg2`, `DATABASE_URL`) while the live app is **SQLite** (`data/app.db`, `better-sqlite3`) — so
  it cannot even run against current data. The new percentile / survive-the-noise MC engine must be
  built fresh (bootstrap-primary, SQLite source); this script is a reference only, not a base.
- **No news-flat / econ-calendar logic exists.** `market.tsx` has only a `Newspaper` icon for the
  news *ticker* UI — there is **no "flat through scheduled high-impact news" gate**. Must be built +
  exposed as config, alongside the empty TOD-exclusion config.
- **No explicit ATR-14 stop-floor formula.** Only `ATR_PERIOD = 14` (`market.tsx:2495`) and
  `SL_ATR_MULT = 0.5` (`market.tsx:331`) for the legacy VEC signal. The confluence exits use the fixed
  tier point-table, not an ATR floor. The prompt's "read the ATR-14 stop-floor from code" premise has
  **no code to read** — the MC engine defines exit geometry instead.
- **Port = 3000** (`server/index.ts:124`, `process.env.PORT || "3000"`). Matches the prompt.
- **No PM2 `ecosystem.config.*`** in the repo (commit `ffbabc6` mentions PM2 setup; config not tracked).
- **`client/src/pages/backtest.tsx` (1,328 lines) is a client UI**, not a headless harness — Phase 1's
  baseline-vs-new A/B needs a Node harness that imports the extracted pure firing module.
- **CSCV/PBO** exists only in `exit_strategy.py` (Python) — reusable as the PBO harness for Phase 1.

## 5. Open Questions Before Phase 0 (BLOCKING — need user decision)

1. ~~Architecture / engine language~~ — **DECIDED (§0):** keep client engine, extract a pure shared
   firing module, port Hurst into it, build a Node backtest harness against it. *(Re-confirm with user.)*
2. **Δα live source** — there is no live MFDFA service wired in. Stand up the Python service the
   prompt describes, or compute Δα in TS from the existing `multifractal.ts`? *Recommendation:* TS
   from `multifractal.ts` to start (no new process), keep the Python option open for the slow cadence.
3. **Backtest harness** — none headless exists; `backtest.tsx` is client-only. Must build a Node
   harness importing the shared firing module. CSCV/PBO reusable from `exit_strategy.py`.
4. **MES block-bootstrap source** — the MC exit needs clean historical bars; the de-spiked served
   `cached-continuous` SQLite data is the clean source to bootstrap from.

---

## 5b. Extraction progress (Phase 0, slice 1 — 2026-07-01)

Per the user's approved "checkpoint after extraction" cadence + the §0 architecture decision,
the pure firing module `shared/firing/` was started **non-destructively** (see its README):

- ✅ **Slice 1 (foundation):** `constants.ts`, `session.ts`, `vector.ts`, `types.ts` — faithful
  VERBATIM copies of the live engine's firing constants / session helpers / vector math / types.
  **`market.tsx` NOT touched** → live engine is byte-for-byte identical. tsc clean.
- ⏳ **Slice 2 (consolidate):** rewire `market.tsx` to import slice-1 primitives (delete local
  dupes). Behavior-sensitive → needs a live smoke test before relying on it.
- ⏳ **Slice 3 (core port):** pure `computeConfluenceSignals(ctx)` = verbatim port of
  `allConfluenceSignals` (signature designed in the README; lock Maps passed by reference to
  preserve exact mutation semantics).
- ⏳ **Slice 4 (harness):** Node harness imports the baseline core = the A/B BASELINE.
- ⏳ **Slice 5 (new model):** SAFE-or-nothing + Hurst gate + MC exits behind `FIRING_MODEL="new"`
  flag (default `false`).

## 6. Next Steps (Step 1 completion)

- Walk `market.tsx` end-to-end and document the exact fire decision tree + the ATR-14 stop-floor
  formula (D-references above marked ⟳).
- Locate the backtest harness, the news-flat logic, and the PM2 config.
- Then, **only after your answers to §5**, begin Phase 0 (new firing model behind a flag defaulting
  `false`, current logic intact for the A/B) — and **STOP at the Phase 1 backtest report** per the
  prompt. **No live behavior changes until you approve the backtest.**
