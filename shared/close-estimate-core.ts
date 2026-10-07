// shared/close-estimate-core.ts
// ─────────────────────────────────────────────────────────────────────────────
// EOD CLOSE-ESTIMATE ZONE — "The Fractal Exchange" Sunday study session, 2026-08-09
// (their "END OF DAY CLOSE VALUES" card, translated to ES/MES RTH).
//
// Method, from the card:
//   • GREEN days (cash close > RTH open) close BELOW the session high by a repeatable
//     average →  est close-high = running HOD − avg(HOD − close | green days)
//     (their Data-Warehouse query "AvgCloseBelowHighGreenDays").
//   • RED days close ABOVE the session low by a repeatable average →
//     est close-low = running LOD + avg(close − LOD | red days)  ("AvgCloseAboveLowRedDays").
//   • "IF NEW HOD or LOD FORMS, RERUN" — recomputed from the running extremes on every call.
//   • The daily OPEN line is the reversion target into the close ("Use Open Line, or just
//     Above Open Line as Target. As Price approaches Open Line — or Passes It — Trade is
//     Realized.").
//
// Close basis = the 16:00 ET cash close (the guide's 4pm-expiration anchor; same basis as the
// repo's existing S-VECTOR close16), NOT the 17:00 ET futures settle. Session gates use bar
// CLOSE time (house close-time semantics): a 5m bar belongs to the RTH window when its close
// lands in (9:30, 16:00] ET.
//
// DISPLAY-ONLY BY CONSTRUCTION (the TIGHT-ROOM lesson): the live zone derives from RUNNING
// session extremes, which no backtest adapter mirrors — this must never become an engine
// input. Callers pass spike-filtered bars (filterYbBars) so one corrupt wick can't become
// "the HOD" (see LEARNINGS 2026-07-16 on stats-input filtering).
// ─────────────────────────────────────────────────────────────────────────────
import { etWallClock } from "./firing/session";
import { sessionDayKey, type Bar } from "./yellowbox-core";

const RTH_START_MIN = 9 * 60 + 30; // bar-close minutes strictly after 9:30 ET
const CASH_CLOSE_MIN = 16 * 60;    // …and at or before 16:00 ET
const MIN_SIDE_DAYS = 10;          // same confidence floor as the yellowbox derivation

/** Quarter-point tick rounding (ES/MES). */
const q = (x: number): number => Math.round(x * 4) / 4;

interface RthDay { key: string; open: number; hod: number; lod: number; close: number; lastBarT: number }

export interface CloseEstimate {
  /** Mean (HOD − cash close) over green lookback days, points (tick-rounded). */
  adjHigh: number;
  /** Mean (cash close − LOD) over red lookback days, points (tick-rounded). */
  adjLow: number;
  nGreen: number;
  nRed: number;
  lookbackSessions: number;
  /** The most recent session day in the bar set — forming intraday, final after 16:00 ET. */
  day: {
    dayKey: string;
    rthOpen: number;
    hod: number;
    lod: number;
    estCloseHigh: number;
    estCloseLow: number;
    /** Close time of the last RTH bar folded in (the "as of" moment). */
    asOfTs: number;
  };
}

/**
 * Compute the EOD close-estimate zone from ascending 5m bars (spike-filtered by the caller).
 * Stats come from up to `lookbackSessions` COMPLETED sessions strictly before the newest day;
 * the newest day supplies the running RTH open/HOD/LOD the estimates are projected from.
 * Returns null when either side has fewer than MIN_SIDE_DAYS qualifying days.
 */
export function computeCloseEstimate(bars: Bar[], lookbackSessions = 60, barSec = 300): CloseEstimate | null {
  const days: RthDay[] = [];
  let cur: RthDay | null = null;
  for (const b of bars) {
    const closeT = b.t + barSec;
    const { wd, mins } = etWallClock(closeT);
    if (wd === 0 || wd === 6) continue;
    if (mins <= RTH_START_MIN || mins > CASH_CLOSE_MIN) continue;
    const key = sessionDayKey(b.t);
    if (!cur || cur.key !== key) {
      cur = { key, open: b.o, hod: b.h, lod: b.l, close: b.c, lastBarT: closeT };
      days.push(cur);
    } else {
      if (b.h > cur.hod) cur.hod = b.h;
      if (b.l < cur.lod) cur.lod = b.l;
      cur.close = b.c;
      cur.lastBarT = closeT;
    }
  }
  if (days.length < MIN_SIDE_DAYS + 2) return null;

  const today = days[days.length - 1];
  const hist = days.slice(Math.max(0, days.length - 1 - lookbackSessions), days.length - 1);
  let gSum = 0, gN = 0, rSum = 0, rN = 0;
  for (const d of hist) {
    if (d.close > d.open) { gSum += d.hod - d.close; gN++; }
    else if (d.close < d.open) { rSum += d.close - d.lod; rN++; }
    // exact doji days (close === open) belong to neither distribution, per the card
  }
  if (gN < MIN_SIDE_DAYS || rN < MIN_SIDE_DAYS) return null;

  const adjHigh = gSum / gN;
  const adjLow = rSum / rN;
  return {
    adjHigh: q(adjHigh),
    adjLow: q(adjLow),
    nGreen: gN,
    nRed: rN,
    lookbackSessions: hist.length,
    day: {
      dayKey: today.key,
      rthOpen: q(today.open),
      hod: q(today.hod),
      lod: q(today.lod),
      estCloseHigh: q(today.hod - adjHigh),
      estCloseLow: q(today.lod + adjLow),
      asOfTs: today.lastBarT,
    },
  };
}
