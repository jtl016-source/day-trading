// ── Shared signal model + DB→MobileSignal mapping ────────────────────────────
// Single source of truth so both the detailed chart WebView (chart-view.tsx) and
// the Market/Signals screens (via hooks/use-market-data.ts) map server rows the
// same way. Keep in sync with the PC's useTerminalData mapSignal (LEARNINGS rule).
//
// 2026-08-04 REWRITE to the current server contract (rows carry pointsResult /
// exitPrice / exitTs / label / comboKey / riskFlags / source / suggestedContracts
// since late July — the old mapper ignored all of them and re-derived stale values):
//   • points: the persisted realized pointsResult IS the truth when present; the
//     tp/sl arithmetic below is only the legacy fallback (mirrors useTerminalData).
//   • outcome vocab: win_tp2|tp2 · win_tp1|tp1|win|target|filled · loss|sl|stopped|stop
//     · eod (17:00 ET settle force-close — a distinct outcome, NOT "Open").
//   • label/comboKey: the composite fact-list label replaces derived strategy guesses.

export type OutcomeResult = { outcome: 'Win' | 'Loss' | 'Open'; tpHit: 1 | 2 | null; points: number | null };

export interface MobileSignal {
  time: number;
  direction: 'Long' | 'Short';
  riskLevel: 'safeplus' | 'safe' | 'risky' | 'riskiest';
  price: number;
  tp1: number;
  tp2: number | null; // TP1-only policy (2026-08-13): null on every engine signal
  sl: number;
  outcome: 'Win' | 'Loss' | 'EOD' | 'Open';
  tpHit: 1 | 2 | null;
  /** Realized points — persisted pointsResult when present, legacy tp/sl arithmetic otherwise. */
  points: number | null;
  rth: boolean;
  /** Signal source — "vector-side-entry" marks the take-every-side-entry Long (allowed in ETH). */
  signalType: string | null;
  /** Composite fact-list label from the engine (e.g. "Yellowbox(break↑) + Fractal(…)"). */
  label: string | null;
  /** Canonical fact-family combo key (e.g. "Fr+YB", "FP+Fr+YB"). */
  comboKey: string | null;
  /** Display-only risk flags (e.g. ["no-footprint","late-entry"]). */
  riskFlags: string[];
  /** Row provenance: 'live' | 'regen' | 'catchup' | null (legacy). */
  source: string | null;
  exitPrice: number | null;
  exitTs: number | null;
  barsToExit: number | null;
  suggestedContracts: number | null;
  /** Pre-computed outcomes for each exit strategy (avoids needing candle data later). */
  exitOutcomes: Record<string, OutcomeResult & { tp1: number; tp2: number; sl: number }>;
  /** Which strategies contributed points to this signal (legacy chips — prefer `label`). */
  strategies: { fp: boolean; milk: boolean; vec: boolean; milkPts: number };
}

// DST-safe RTH check — matches trading-utils.ts isRTH() exactly.
// Old versions used hardcoded UTC offsets which broke in winter (EST=UTC-5 vs
// EDT=UTC-4), ending RTH at 3 PM ET instead of 4 PM from Nov–Mar.
const _nyRthFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
export function isRTH(ts: number): boolean {
  const parts = _nyRthFmt.formatToParts(new Date(ts * 1000));
  const day  = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value  ?? '0');
  const min  = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  if (day === 'Sat' || day === 'Sun') return false;
  const etMins = hour * 60 + min;
  return etMins >= 9 * 60 + 30 && etMins < 17 * 60; // 9:30 AM – 5:00 PM ET
}

function safeParse(json: any): any {
  if (!json || typeof json !== 'string') return null;
  try { return JSON.parse(json); } catch { return null; }
}

// Converts a DB row (from /api/signals/history) to MobileSignal.
export function mapDbSignal(s: any): MobileSignal {
  const isLong = s.direction === 'Long';
  const oc     = String(s.outcome ?? '');
  const isTp2  = oc === 'win_tp2' || oc === 'tp2';
  const isTp1  = oc === 'win_tp1' || oc === 'tp1' || oc === 'win' || oc === 'target' || oc === 'filled';
  const isLoss = oc === 'loss' || oc === 'sl' || oc === 'stopped' || oc === 'stop';
  const isEod  = oc === 'eod';

  // Realized points: persisted pointsResult is the truth (exit-field migration 2026-07-29);
  // the tp/sl arithmetic is only the legacy fallback for old rows.
  const legacyPts = isTp2  ? (isLong ? s.tp2 - s.entry : s.entry - s.tp2)
                  : isTp1  ? (isLong ? s.tp1 - s.entry : s.entry - s.tp1)
                  : isLoss ? (isLong ? s.sl  - s.entry : s.entry - s.sl)
                  : null;
  const pts = (typeof s.pointsResult === 'number' && Number.isFinite(s.pointsResult))
    ? s.pointsResult
    : legacyPts;

  // ── Legacy confirmation breakdown (kept for old UI chips — prefer `label`) ──
  const conf = safeParse(s.confirmations);
  const fpr  = safeParse(s.footprintReading);
  const isSafeTier = s.riskLevel === 'safe' || s.riskLevel === 'safeplus';
  const milk    = conf ? !!conf.milkOk : isSafeTier;
  const milkPts = conf && typeof conf.milkPts === 'number' ? conf.milkPts : (milk ? 3 : 0);
  const vec     = conf ? conf.vecOk !== false : true;
  const fp      = !!fpr && fpr.vetoed !== true && (fpr.confirmed === true || fpr.partial === true);

  const flags = safeParse(s.riskFlags);

  return {
    time:         s.timestamp,
    direction:    s.direction,
    // SINGLE-TIER: the PC relabels every displayed signal "SAFE" (mapSignal in useTerminalData
    // hardcodes tier:"SAFE"). Mirror that so the phone never shows RISKY/RISKIEST tiers.
    riskLevel:    'safe',
    price:        s.entry,
    tp1:          s.tp1,
    tp2:          s.tp2,
    sl:           s.sl,
    outcome:      (isTp2 || isTp1) ? 'Win' : isLoss ? 'Loss' : isEod ? 'EOD' : 'Open',
    tpHit:        isTp2 ? 2 : isTp1 ? 1 : null,
    points:       pts !== null && pts !== undefined ? +Number(pts).toFixed(2) : null,
    rth:          isRTH(s.timestamp),
    signalType:   s.signalType ?? null,
    label:        typeof s.label === 'string' && s.label.length ? s.label : null,
    comboKey:     typeof s.comboKey === 'string' && s.comboKey.length ? s.comboKey : null,
    riskFlags:    Array.isArray(flags) ? flags.map(String) : [],
    source:       typeof s.source === 'string' ? s.source : null,
    exitPrice:    typeof s.exitPrice === 'number' ? s.exitPrice : null,
    exitTs:       typeof s.exitTs === 'number' ? s.exitTs : null,
    barsToExit:   typeof s.barsToExit === 'number' ? s.barsToExit : null,
    suggestedContracts: typeof s.suggestedContracts === 'number' ? s.suggestedContracts : null,
    exitOutcomes: {},
    strategies:   { fp, milk, vec, milkPts },
  } as MobileSignal;
}

// Every row in signal_history was generated by the PC engine (the server already
// gate-filters via validateSignalRow). Show all of them so the phone matches the PC.
export function isPcDisplaySignal(_s: any): boolean {
  return true;
}
