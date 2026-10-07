/**
 * pml-tml.ts — Peak / Trough Money Lines from LIVE options-chain exposure (2026-07-15
 * guide-study mission; source: "The Official PML & TML Guide", The Fractal Exchange).
 *
 * Guide mechanics, translated deterministically:
 *   PML (Peak Money Line)   = the price of MAXIMUM NET NEGATIVE market-maker exposure across
 *                             the strike range (MMs steer price away from it; a move through
 *                             it flips exposure positive → expansion).
 *   TML (Trough Money Line) = the flattest / minimally-positive trough of the exposure curve
 *                             (balanced calls+puts → price coils/pins there).
 * Exposure model (open interest + intraday volume, the guide's stated inputs). The guide's
 * curve carries BOTH signs, has an INTERIOR negative peak, and "beyond this point we enter
 * the wings, where we strive to balance our exposure to zero" — the signature of a NET
 * GAMMA exposure profile (settlement-payout/max-pain curves are edge-maximal and never
 * decay in the wings; first implementation attempt, discarded). So:
 *     netExposure(P) = Σ_calls w_c·Γ(K_c, P) − Σ_puts w_p·Γ(K_p, P),   w = OI + volume,
 *     Γ = Black-Scholes gamma at a flat σ (0.15) with T from the nearest expiry (floor 0.5d)
 *     PML = the most NEGATIVE interior point of netExposure within ±8% of spot
 *           (falls back to |exposure| peak when the chain is call/put lopsided all-positive);
 *     TML = the flattest point — argmin |netExposure| — the balanced coil/pin zone.
 * Mapped to futures points via factor = lastFuturesClose / spot (same approach as
 * computeIVWalls in scripts/yellowbox.ts). Sources tried in order: ^SPX, then SPY×10.
 *
 * LIVE-ONLY: there is NO historical options data — these levels are terminal reference lines
 * + live-edge corroborator facts marked backtestable:false. They are EXCLUDED from every
 * backtest by construction (the harness never supplies liveLevels).
 *
 * Endpoint: GET /api/pml-tml?symbol=MES  (3-minute cache — chain data is delayed anyway)
 */
import type { Express } from "express";
import YahooFinance from "yahoo-finance2";

interface SqliteLike { prepare(sql: string): { get(...args: unknown[]): unknown } }

export interface PmlTmlResult {
  skipped: string | null;
  asOf?: string;
  source?: string;
  expiry?: string;
  spot?: number;
  factor?: number;
  /** Futures-point levels (tick-rounded). */
  pml?: number;
  tml?: number;
  /** Raw underlying-strike levels (SPX scale). */
  pmlRaw?: number;
  tmlRaw?: number;
  payoutAtPml?: number;
  payoutAtTml?: number;
  curve?: { k: number; payout: number }[];
}

const CACHE_MS = 3 * 60 * 1000;
const WINDOW = 0.08; // ±8% of spot
let cache: { at: number; res: PmlTmlResult } | null = null;

const timeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((res, rej) => {
    const id = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(id); res(v); }, (e) => { clearTimeout(id); rej(e); });
  });

export async function computePmlTml(lastFuturesClose: number): Promise<PmlTmlResult> {
  let yf: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { yf = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"] }); } // eslint-disable-line @typescript-eslint/no-explicit-any
  catch { yf = YahooFinance; }
  for (const [sym, mult] of [["^SPX", 1], ["SPY", 10]] as const) {
    try {
      const first: any = await timeout(yf.options(sym), 20000); // eslint-disable-line @typescript-eslint/no-explicit-any
      const expiries: Date[] = (first?.expirationDates ?? []).map((d: string | Date) => new Date(d));
      const exp = expiries.find((e) => e.getTime() >= Date.now() - 86400_000); // nearest (incl. today)
      if (!exp) throw new Error("no expiries");
      const chain: any = await timeout(yf.options(sym, { date: exp }), 20000); // eslint-disable-line @typescript-eslint/no-explicit-any
      const opt = chain?.options?.[0];
      const spot = (chain?.quote?.regularMarketPrice ?? 0) * mult;
      if (!opt || !(spot > 0)) throw new Error("no chain/spot");
      interface Row { strike: number; openInterest?: number; volume?: number }
      const norm = (rows: Row[]): { k: number; w: number }[] =>
        (rows ?? [])
          .map((r) => ({ k: r.strike * mult, w: (r.openInterest ?? 0) + (r.volume ?? 0) }))
          .filter((r) => r.w > 0 && Math.abs(r.k / spot - 1) < WINDOW * 1.5);
      const calls = norm(opt.calls), puts = norm(opt.puts);
      if (calls.length + puts.length < 20) throw new Error("thin chain");
      const grid = [...new Set([...calls, ...puts].map((r) => r.k))]
        .sort((a, b) => a - b)
        .filter((k) => Math.abs(k / spot - 1) < WINDOW);
      if (grid.length < 8) throw new Error("thin grid");
      // Net GAMMA exposure profile (see header): calls positive, puts negative, flat σ.
      const T = Math.max(0.5 / 365, (exp.getTime() - Date.now()) / (365 * 86400_000));
      const SIG = 0.15;
      const denomBase = SIG * Math.sqrt(T);
      const gamma = (K: number, P: number): number => {
        const d1 = (Math.log(P / K) + (SIG * SIG / 2) * T) / denomBase;
        return Math.exp(-d1 * d1 / 2) / (P * denomBase * Math.sqrt(2 * Math.PI));
      };
      const exposure = (P: number): number => {
        let s = 0;
        for (const c of calls) s += c.w * gamma(c.k, P);
        for (const p of puts) s -= p.w * gamma(p.k, P);
        return s;
      };
      const curve = grid.map((k) => ({ k, payout: exposure(k) }));
      // PML = most NEGATIVE interior point (all-positive lopsided chains fall back to the
      // absolute peak). TML = the guide's "washout zone": the ZERO-CROSSING of the exposure
      // curve nearest to spot ("where negative exposure turns to positive" — the pin /
      // gravitational center). Plain argmin |exposure| is wrong here: gamma decays to ~0 in
      // the wings, so the flattest point degenerates to the window edge (observed live).
      // Fallback when the curve never changes sign: flattest point within ±3% of spot.
      let pmlPt = curve[0];
      for (const pt of curve) if (pt.payout < pmlPt.payout) pmlPt = pt; // most negative
      if (pmlPt.payout >= 0) { // no negative region — fall back to the dominant |exposure| peak
        for (const pt of curve) if (Math.abs(pt.payout) > Math.abs(pmlPt.payout)) pmlPt = pt;
      }
      let tmlPt: { k: number; payout: number } | null = null;
      for (let i = 1; i < curve.length; i++) {
        const a = curve[i - 1], b = curve[i];
        if ((a.payout < 0) !== (b.payout < 0)) {
          // linear-interpolated crossing between the two strikes
          const t = Math.abs(a.payout) / (Math.abs(a.payout) + Math.abs(b.payout) || 1);
          const k = a.k + t * (b.k - a.k);
          if (tmlPt === null || Math.abs(k - spot) < Math.abs(tmlPt.k - spot)) tmlPt = { k, payout: 0 };
        }
      }
      if (!tmlPt) {
        const near = curve.filter((p) => Math.abs(p.k / spot - 1) < 0.03);
        tmlPt = (near.length ? near : curve).reduce((best, p) => (Math.abs(p.payout) < Math.abs(best.payout) ? p : best));
      }
      const factor = lastFuturesClose > 0 ? lastFuturesClose / spot : 1;
      const dec = Math.max(1, Math.floor(curve.length / 40));
      return {
        skipped: null,
        asOf: new Date().toISOString(),
        source: sym,
        expiry: exp.toISOString().slice(0, 10),
        spot: Math.round(spot * 100) / 100,
        factor: Math.round(factor * 10000) / 10000,
        pmlRaw: pmlPt.k,
        tmlRaw: tmlPt.k,
        pml: Math.round((pmlPt.k * factor) * 4) / 4,
        tml: Math.round((tmlPt.k * factor) * 4) / 4,
        payoutAtPml: Math.round(pmlPt.payout),
        payoutAtTml: Math.round(tmlPt.payout),
        curve: curve.filter((_, i) => i % dec === 0)
          .map((p) => ({ k: Math.round(p.k * factor * 4) / 4, payout: Math.round(p.payout) })),
      };
    } catch (e) {
      console.log(`[pml-tml] ${sym} failed: ${(e as Error).message}`);
    }
  }
  return { skipped: "options fetch failed for ^SPX and SPY" };
}

/** Wire GET /api/pml-tml into the express app. `sqlite` provides the last futures close. */
export function registerPmlTml(app: Express, sqlite: SqliteLike): void {
  app.get("/api/pml-tml", async (req, res) => {
    try {
      const symbol = String(req.query.symbol ?? "MES");
      if (cache && Date.now() - cache.at < CACHE_MS) { res.json(cache.res); return; }
      const row = sqlite.prepare(
        `SELECT close FROM cached_candles WHERE symbol=? AND resolution IN ('1','5') ORDER BY timestamp DESC LIMIT 1`,
      ).get(symbol) as { close?: number } | undefined;
      const out = await computePmlTml(row?.close ?? 0);
      if (!out.skipped) cache = { at: Date.now(), res: out };
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
