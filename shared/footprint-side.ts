// shared/footprint-side.ts — side-completeness of a footprint candle (2026-10-06).
//
// Born from the 2026-07-08 → 10-06 one-sided footprint incident: the LiveBarRelay study
// shipped in July guessed the SDK Tick's aggressor method by reflection, every trade fell to
// the bid side, and footprint-engine's zero-vs-nonzero rule turned the dead ask side into one
// full-bar SELL stack on every 5m candle (37/37 engine footprint fires Short). Nothing alarmed
// for three months. This file is the ONE definition of "one-sided", shared by the engine's
// canary log (server/footprint-engine.ts), the daily integrity check (scripts/integrity-check.ts
// W3) and the post-reinstall verifier (scripts/footprint-side-check.ts). Plain data in, plain
// data out — no DB, no imports.

export interface FootprintSideLevel { bidVol: number; askVol: number }

export interface FootprintSideStats {
  levels: number;
  bidVol: number;
  askVol: number;
  /** big enough that a zero side cannot be order flow (≥ ONE_SIDED_MIN_LEVELS and ≥ ONE_SIDED_MIN_VOLUME) */
  qualifies: boolean;
  /** a qualifying candle whose bid OR ask side is exactly zero — a feed defect, never order flow */
  oneSided: boolean;
}

/** A real MES 5m bar spanning this many price levels with this many contracts always prints
 *  on both sides; a tiny ETH print can legitimately be one-sided and is never flagged. */
export const ONE_SIDED_MIN_LEVELS = 4;
export const ONE_SIDED_MIN_VOLUME = 50;
/** Share of qualifying complete candles (per session / per 7-day window) that are one-sided
 *  before the feed is declared dead. A broken relay scores 100 %, a healthy one ~0 %. */
export const ONE_SIDED_ALARM_SHARE = 0.10;

export function footprintSideStats(levels: ReadonlyArray<FootprintSideLevel>): FootprintSideStats {
  let bidVol = 0, askVol = 0;
  for (const l of levels) {
    const b = Number(l?.bidVol), a = Number(l?.askVol);
    if (b > 0) bidVol += b;
    if (a > 0) askVol += a;
  }
  const qualifies = levels.length >= ONE_SIDED_MIN_LEVELS && bidVol + askVol >= ONE_SIDED_MIN_VOLUME;
  return { levels: levels.length, bidVol, askVol, qualifies, oneSided: qualifies && (bidVol === 0 || askVol === 0) };
}
