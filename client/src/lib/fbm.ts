// fbm.ts — Rank 4: synthetic fractional-Brownian-motion path generator (TEST/VISUAL infra).
//
// In the backtest harness, fBm paths calibrated to real MES return stats feed the CSCV/PBO +
// Monte-Carlo robustness checks (it never touches the live signal path). In the app we use it
// for a TEACHING VISUAL: three illustrative paths at H = 0.3 / 0.5 / 0.7 so the user can SEE
// what "mean-reverting", "random walk" and "trending" actually look like as price curves.
//
// Method: successive random addition (midpoint displacement), a standard, fast fBm approximation
// whose roughness is governed by H. Seeded RNG so the visual is stable across renders.

// Deterministic mulberry32 PRNG (so the demo paths don't flicker on every re-render).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal via Box–Muller from a uniform RNG.
function gauss(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Illustrative fBm via midpoint displacement. Returns `points` samples in [0, length].
 * Roughness scales with H: low H = jagged/mean-reverting, high H = smooth/trending.
 */
export function fbmPath(H: number, points = 64, seed = 12345): number[] {
  // Build on a power-of-two grid then resample to `points`.
  let levels = Math.ceil(Math.log2(Math.max(2, points - 1)));
  const N = Math.pow(2, levels);
  const x = new Array<number>(N + 1).fill(0);
  const rng = mulberry32(seed);
  let scale = 1;
  x[0] = 0;
  x[N] = gauss(rng);
  let stride = N;
  for (let lvl = 0; lvl < levels; lvl++) {
    const half = stride / 2;
    scale *= Math.pow(0.5, H); // displacement variance shrinks as 2^(−H) per level
    for (let i = half; i < N; i += stride) {
      const mid = (x[i - half] + x[i + half]) / 2;
      x[i] = mid + scale * gauss(rng);
    }
    // successive random addition: re-perturb existing points for proper fBm texture
    for (let i = 0; i <= N; i += half) x[i] += scale * gauss(rng) * 0.5;
    stride = half;
  }
  // Resample to `points` and normalize to ~[-1, 1] for plotting.
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const idx = Math.round((i / (points - 1)) * N);
    out.push(x[idx]);
  }
  const min = Math.min(...out), max = Math.max(...out), rng2 = max - min || 1;
  return out.map(v => (2 * (v - min)) / rng2 - 1);
}
