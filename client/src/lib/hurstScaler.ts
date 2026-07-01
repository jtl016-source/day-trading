// hurstScaler.ts — Rank 2: generalized-Hurst stop/target scaler (DISPLAY ONLY, flag-gated OFF).
//
// Under a fractional Brownian model, the expected range over a horizon τ scales as σ(τ) ∝ τ^H,
// NOT the random-walk √τ. So if H < 0.5 (mean-reverting) moves grow slower than √τ → targets
// should be TIGHTER; if H > 0.5 (trending) they grow faster → targets can run WIDER.
//
// This module only COMPUTES the multiplier the engine WOULD apply. It is experimental/marginal
// per the spec and is NOT wired into live stop/target logic — it is shown in the Info tab so the
// user can see what Hurst-aware sizing would do. Never changes default ATR behavior.

/** Multiplier vs the random-walk (√τ) baseline for a given horizon (bars) and Hurst H. */
export function targetScaler(H: number, horizonBars: number): number {
  if (!Number.isFinite(H) || horizonBars <= 1) return 1;
  // τ^H / τ^0.5 = τ^(H − 0.5)
  return Math.pow(horizonBars, H - 0.5);
}

/** Scaler across a set of horizons — for the visual ladder in the Info tab. */
export function scalerLadder(H: number, horizons: number[] = [1, 2, 4, 8, 16]):
  Array<{ horizon: number; mult: number }> {
  return horizons.map(h => ({ horizon: h, mult: targetScaler(H, h) }));
}

/** Plain-English read of what the scaler implies at the current H. */
export function scalerVerdict(H: number): { label: string; detail: string; tone: "tight" | "neutral" | "wide" } {
  if (!Number.isFinite(H)) return { label: "—", detail: "Not enough data.", tone: "neutral" };
  if (H <= 0.45) return {
    label: "TIGHTEN TARGETS",
    detail: "Moves grow slower than a random walk — reaching far targets is less likely. Take profit sooner.",
    tone: "tight",
  };
  if (H >= 0.55) return {
    label: "LET TARGETS RUN",
    detail: "Moves grow faster than a random walk — trends extend. Wider targets are statistically justified.",
    tone: "wide",
  };
  return {
    label: "STANDARD TARGETS",
    detail: "Near random-walk scaling — no Hurst adjustment; keep the default ATR targets.",
    tone: "neutral",
  };
}
