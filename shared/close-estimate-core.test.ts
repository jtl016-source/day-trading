// shared/close-estimate-core.test.ts — pins the EOD close-estimate contract.
// Run: npx tsx shared/close-estimate-core.test.ts  (part of `npm test`)
//
// Synthetic 5m sessions in June 2026 (EDT, so 9:30 ET = 13:30 UTC — the core itself uses the
// DST-safe etWallClock; the fixture just needs real summer timestamps):
//   green fixture day: RTH open 100 → HOD 110 → cash close 105  (HOD − close = 5)
//   red   fixture day: RTH open 100 → LOD  90 → cash close  95  (close − LOD = 5)
// Alternating for 30 weekdays, then a FORMING current day with open 200 / HOD 210 / LOD 195.
// Expect adjHigh = adjLow = 5 → estCloseHigh = 205, estCloseLow = 200, plus window-edge and
// insufficient-history behavior.
import { strict as assert } from "assert";
import { computeCloseEstimate } from "./close-estimate-core";
import type { Bar } from "./yellowbox-core";

const BAR = 300;
// Mon 2026-06-01 13:30 UTC = 9:30 AM EDT. RTH-window 5m bars: starts 13:30..19:55 UTC
// (closes 13:35..20:00 UTC = 9:35..16:00 ET — house close-time semantics).
const DAY0_START = Date.UTC(2026, 5, 1, 13, 30, 0) / 1000;

function sessionBars(dayOffsetCalDays: number, kind: "green" | "red" | "forming"): Bar[] {
  const start = DAY0_START + dayOffsetCalDays * 86400;
  const bars: Bar[] = [];
  const n = kind === "forming" ? 30 : 78; // full RTH window = 78 five-minute bars
  for (let i = 0; i < n; i++) {
    const t = start + i * BAR;
    let o = 100, h = 100.5, l = 99.5, c = 100;
    if (kind === "green") {
      if (i === 0) { o = 100; h = 100.5; l = 99.8; c = 100.4; }        // RTH open = 100
      else if (i === 40) { o = 104; h = 110; l = 104; c = 105.5; }     // HOD 110
      else if (i === n - 1) { o = 105.2; h = 105.4; l = 104.8; c = 105; } // cash close 105
      else { o = 102; h = 102.6; l = 101.6; c = 102.2; }
    } else if (kind === "red") {
      if (i === 0) { o = 100; h = 100.2; l = 99.5; c = 99.6; }         // RTH open = 100
      else if (i === 40) { o = 96; h = 96; l = 90; c = 94.5; }         // LOD 90
      else if (i === n - 1) { o = 95.2; h = 95.4; l = 94.8; c = 95; }  // cash close 95
      else { o = 97; h = 97.5; l = 96.5; c = 97.1; }
    } else {
      if (i === 0) { o = 200; h = 200.5; l = 199.5; c = 200.2; }       // RTH open = 200
      else if (i === 10) { o = 205; h = 210; l = 205; c = 208; }       // HOD 210
      else if (i === 20) { o = 198; h = 198; l = 195; c = 196; }       // LOD 195
      else { o = 202; h = 202.5; l = 201.5; c = 202; }
    }
    bars.push({ t, o, h, l, c, v: 100 });
  }
  // Pre-open + post-close noise bars that MUST be ignored (close ≤ 9:30 / > 16:00 ET):
  bars.push({ t: start - 2 * BAR, o: 500, h: 999, l: 1, c: 500, v: 1 });   // closes 9:25 ET
  bars.push({ t: start - BAR, o: 500, h: 999, l: 1, c: 500, v: 1 });       // closes 9:30 ET exactly — excluded
  bars.push({ t: start + 78 * BAR, o: 500, h: 999, l: 1, c: 500, v: 1 });  // closes 16:05 ET
  return bars;
}

// 30 completed weekdays (Mon–Fri ×6 weeks), alternating green/red, then a forming day.
const bars: Bar[] = [];
let weekday = 0, cal = 0, completed = 0;
while (completed < 30) {
  weekday = Math.floor(Date.UTC(2026, 5, 1 + cal, 17, 0) / 1000 / 86400 + 4) % 7;
  if (weekday !== 0 && weekday !== 6) {
    bars.push(...sessionBars(cal, completed % 2 === 0 ? "green" : "red"));
    completed++;
  }
  cal++;
}
while (true) { // next weekday = the forming current day
  weekday = Math.floor(Date.UTC(2026, 5, 1 + cal, 17, 0) / 1000 / 86400 + 4) % 7;
  if (weekday !== 0 && weekday !== 6) break;
  cal++;
}
const formingStart = DAY0_START + cal * 86400;
bars.push(...sessionBars(cal, "forming"));
bars.sort((a, b) => a.t - b.t);

const est = computeCloseEstimate(bars);
assert.ok(est, "estimate computed");
assert.equal(est!.nGreen, 15, "15 green lookback days");
assert.equal(est!.nRed, 15, "15 red lookback days");
assert.equal(est!.lookbackSessions, 30, "30 completed sessions in lookback");
assert.equal(est!.adjHigh, 5, "adjHigh = mean(HOD − close | green) = 5");
assert.equal(est!.adjLow, 5, "adjLow = mean(close − LOD | red) = 5");
assert.equal(est!.day.rthOpen, 200, "forming-day RTH open (pre-open noise bars excluded)");
assert.equal(est!.day.hod, 210, "forming-day running HOD");
assert.equal(est!.day.lod, 195, "forming-day running LOD");
assert.equal(est!.day.estCloseHigh, 205, "estCloseHigh = HOD − adjHigh");
assert.equal(est!.day.estCloseLow, 200, "estCloseLow = LOD + adjLow");

// "IF NEW HOD FORMS, RERUN": extend the forming day with a new in-window high (bar 30 of the
// forming session, closes ~12:05 ET) — the estimate must move.
const barsNewHod = [...bars, { t: formingStart + 30 * BAR, o: 210, h: 214, l: 210, c: 213, v: 100 }].sort((a, b) => a.t - b.t);
const est2 = computeCloseEstimate(barsNewHod);
assert.equal(est2!.day.hod, 214, "new HOD folded in");
assert.equal(est2!.day.estCloseHigh, 209, "estCloseHigh reruns off the new HOD");

// Insufficient history → null (fewer than 10 days per side).
assert.equal(computeCloseEstimate(bars.slice(0, 79 * 8)), null, "thin history returns null");

console.log("close-estimate-core: all assertions passed");
