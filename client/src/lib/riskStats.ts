// client/src/lib/riskStats.ts
// ─────────────────────────────────────────────────────────────────────────────
// RISK DISPLAY (2026-07-30): the client-side backing store for per-signal risk info.
// ONE cached fetch of GET /api/risk/combo-stats (held-out combo verdicts + realized window
// stats + the dead-tape median), shared by SignalsView, SignalDetail and market.tsx (which
// feeds `medianDayRange` into the engine input so live risk flags match the harness).
// All WORDING comes from shared/signal-display.ts — this module only resolves data.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import {
  comboTierOf, fmtTrackRecord, fmtSmallSampleCaveat, displayComboKey,
  type ComboTier, type ComboHeldOutLike,
} from "@shared/signal-display";

export interface RealizedCell { n: number; closed: number; wins: number; winPct: number | null; pf: number | null; expectancy: number | null }
export interface RiskComboStats {
  generatedAt: string;
  heldOut: Record<string, ComboHeldOutLike & { note?: string; allowed?: boolean }>;
  realized: Record<string, RealizedCell>;
  medianDayRange: number;
  medianDays: number;
  windowFromKey: string;
}

let cached: RiskComboStats | null = null;
let inflight: Promise<RiskComboStats | null> | null = null;
const listeners = new Set<(s: RiskComboStats) => void>();

export function fetchRiskComboStats(): Promise<RiskComboStats | null> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch("/api/risk/combo-stats")
    .then(r => (r.ok ? r.json() : null))
    .then((j: RiskComboStats | null) => {
      if (j && j.heldOut) {
        cached = j;
        for (const fn of listeners) fn(j);
      }
      return cached;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

/** React hook — null until the (single, shared) fetch resolves; never throws. */
export function useRiskComboStats(): RiskComboStats | null {
  const [stats, setStats] = useState<RiskComboStats | null>(cached);
  useEffect(() => {
    if (cached) { setStats(cached); return; }
    listeners.add(setStats);
    void fetchRiskComboStats();
    return () => { listeners.delete(setStats); };
  }, []);
  return stats;
}

/** Everything the UI renders about one signal's combo track record. */
export interface ComboRiskInfo {
  tier: ComboTier;
  /** Which verdict granularity supplied the held-out stats. */
  scope: "interval" | "all" | "none";
  comboWords: string;               // "Fractal Geometry + Fractal + Yellow Box"
  /** One line for the row/summary — held-out basis for judged tiers, realized (with the
   *  explicit small-sample caveat) for unproven ones. */
  trackRecord: string;
  heldOut: (ComboHeldOutLike & { note?: string }) | null;
  realized: RealizedCell | null;    // this combo@interval (falls back to all-interval)
}

export function resolveComboRisk(
  comboKey: string | null | undefined,
  interval: string,
  stats: RiskComboStats | null,
): ComboRiskInfo | null {
  if (!comboKey || !stats) return null;
  const atIv = stats.heldOut[`${comboKey}@${interval}`];
  const all = stats.heldOut[comboKey];
  const heldOut = atIv ?? all ?? null;
  const scope: ComboRiskInfo["scope"] = atIv ? "interval" : all ? "all" : "none";
  const tier = comboTierOf(heldOut, scope);
  const realized = stats.realized[`${comboKey}@${interval}`] ?? stats.realized[comboKey] ?? null;
  let trackRecord: string;
  if (tier === "unproven") {
    trackRecord = realized && realized.closed > 0
      ? `${fmtTrackRecord({ n: realized.closed, winPct: realized.winPct, pf: realized.pf })} — ${fmtSmallSampleCaveat(realized.closed)}`
      : "no track record on file";
  } else {
    const ho = heldOut!;
    trackRecord = fmtTrackRecord({
      n: ho.n,
      winPct: Number.isFinite(ho.winRate) ? 100 * ho.winRate : null,
      pf: Number.isFinite(ho.pf) ? ho.pf : null,
    });
  }
  return { tier, scope, comboWords: displayComboKey(comboKey), trackRecord, heldOut, realized };
}
