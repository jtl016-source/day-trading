/**
 * scripts/yellowbox-core.ts — RE-EXPORT SHIM.
 *
 * The zone-derivation core was relocated to `shared/yellowbox-core.ts` so the SERVER
 * (GET /api/yellowbox/day-zones) and these offline scripts import ONE identical module
 * (single source of truth — live boxes can never drift from the backtest/renderer).
 *
 * This shim preserves the scripts' existing `./yellowbox-core` import path. All values
 * AND types (Bar, DayAgg, CoreZones, EtParts, …) flow through the `export *`.
 */
export * from "../shared/yellowbox-core";
