# shared/firing — MERIDIAN firing logic (framework-agnostic)

Single source of truth for the **firing decision**, importable by BOTH the live engine
(`client/src/pages/market.tsx`, via `@shared/firing/...`) and a headless Node backtest
harness. No React / DOM / lightweight-charts imports allowed in this folder.

Full spec + divergence list: [`docs/MERIDIAN_TRADING_LOGIC.md`](../../docs/MERIDIAN_TRADING_LOGIC.md).

## Why this exists

Today the firing logic is locked inside a 6,378-line React component and **cannot be
backtested as-is**. The rebuild prompt requires a baseline-vs-new A/B over held-out data,
which needs the firing logic callable headlessly. This module extracts it incrementally,
**baseline-first, behavior-preserving**, so the live money-path is never changed blindly.

## Extraction status

| Slice | Contents | Status |
|---|---|---|
| 1 — foundation | `constants.ts`, `session.ts`, `vector.ts`, `types.ts` | ✅ done, tsc-clean. Faithful copies. **market.tsx not yet rewired** (live engine byte-identical). |
| 2 — consolidate | Rewire `market.tsx` to import slice-1 primitives (delete local dupes) | ⏳ next — behavior-sensitive; needs a live smoke test. |
| 3 — core port | `confluence.ts`: pure `computeConfluenceSignals(ctx)` = verbatim port of `allConfluenceSignals` (incl. vector side-entry) | ⏳ after slice 2. |
| 4 — harness | Node harness imports `computeConfluenceSignals` = **BASELINE** engine for the A/B | ⏳ |
| 5 — new model | `newModel.ts`: SAFE-or-nothing + Hurst regime gate + MC exits, behind `FIRING_MODEL="new"` flag (default off) | ⏳ Phase 0 |

## Designed signature for slice 3 (baseline core port)

`allConfluenceSignals` closes over component state + refs. The pure port takes them as an
explicit context; the lock **Maps are passed by reference** so the live engine keeps its
exact mutation/lock semantics (fired signals stay locked, tiers frozen, DB levels win):

```ts
export interface FiringContext {
  candles: FiringCandle[];          // windowedCandles (sorted, may include forming bar)
  interval: "1m" | "5m" | "15m" | "60m";
  vectorLine: VectorPoint[];        // current-interval vector
  zones: FiringZone[];              // activeZones (uploaded PNG + structural)
  extraVectors: Array<{ label: string; map: Map<number, number>; flatMap: Map<number, boolean> }>;
  footprintCandles: FootprintCandle[];   // footprintCandlesRef.current snapshot
  // exit / feature state
  exitProfile: ExitProfileKey; useTrailer: boolean; trailerOffset: number;
  useZoneTargets: boolean; takeSideEntries: boolean;
  signalWinRates: Record<string, { winRate: number; sampleCount: number }>;
  // lock state (mutated in place — same objects the live refs hold)
  lockedLevels: Map<string, { price: number; tp1: number; tp2: number; sl: number }>;
  lockedTiers: Map<string, LockTier>;
  dbSignalHistory: Map<string, { price: number; tp1: number; tp2: number; sl: number }>;
  // injected impure deps (analyzeFootprint / buildProxyFootprintCandle from footprint-analysis)
  analyzeFootprint: (...) => FootprintReading | null;
  buildProxyFootprintCandle: (c: FiringCandle) => FootprintCandle;
  nowSec?: number;                  // defaults Date.now()/1000; injectable for deterministic tests
}
export function computeConfluenceSignals(ctx: FiringContext): FiredSignal[];
```

The `market.tsx` `allConfluenceSignals` useMemo becomes a thin adapter that builds this
context (passing its refs' Maps straight through) and returns the result — identical
behavior, now also callable headlessly.

## Hard rules (from the rebuild prompt)

- **Closed candles only** — never fire on `complete === false`.
- **Baseline is frozen** — do not tune slice 1–4 values. New-model params live in `newModel.ts`
  behind a flag defaulting `false`.
- **No leakage** — any new threshold is a-priori or calibrated on a window strictly before the test month.
