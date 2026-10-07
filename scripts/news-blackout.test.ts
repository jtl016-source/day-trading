// scripts/news-blackout.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-01 owner-approved settings round (R1 RTH-only orders, R2a muted overnight alerts,
// R3 scheduled-news blackout, Apex 25K defaults). Temp SQLite via DB_PATH + a FIXTURE calendar
// via NEWS_CALENDAR_PATH — the live data/app.db and data/news-calendar.json are never opened.
// NO test framework — plain asserts, run with:
//   npx tsx scripts/news-blackout.test.ts   (exit 0 = all pass)
//
//   W  window derivation (08:30 / 10:00 / FOMC 14:00), multi-event names, non-FOMC 14:00 ignored,
//      DST: an 08:30 ET print in NOVEMBER (EST, UTC-5) vs OCTOBER (EDT, UTC-4)
//   G  blackoutReason + trade-state.orderHoursGateReason inside / outside / edges / switch off /
//      calendar missing (fails open) / calendar edited (mtime reload)
//   E  ETH classification at the bar CLOSE across DST (America/New_York, never a UTC offset)
//   H  calendar health (newsCalendarHealth / digest line / rules-copy drift), covered range
//   S  settings defaults (RTH-only window, ethAlertsEnabled false, newsBlackoutEnabled true,
//      Apex 25K $1,000 / $500 — see scripts/apex-guard.test.ts for hydration + carry-over)
//   (the REAL data/news-calendar.json is tested by scripts/news-calendar-data.test.ts)
//   M  alert mute decisions (eth / news / null) + the route / tab wiring (source scan)
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}
const U = (iso: string): number => Math.floor(Date.parse(iso) / 1000); // explicit UTC instants

const FIXTURE = {
  version: 1,
  window: { from: "2026-10-01", to: "2026-12-31" },
  timezone: "America/New_York",
  events: [
    { date: "2026-10-01", timeET: "10:00", event: "ISM Manufacturing PMI", tier: 2 },
    { date: "2026-10-14", timeET: "08:30", event: "CPI", tier: 1 },
    { date: "2026-10-15", timeET: "08:30", event: "PPI", tier: 2 },
    { date: "2026-10-15", timeET: "08:30", event: "Retail Sales", tier: 2 },
    { date: "2026-10-28", timeET: "14:00", event: "FOMC", tier: 1 },
    { date: "2026-10-30", timeET: "14:00", event: "Treasury refunding", tier: 3 }, // NOT FOMC → no window
    { date: "2026-11-10", timeET: "08:30", event: "CPI", tier: 1 },                // EST (DST ended 2026-11-01)
    { date: "2026-12-09", timeET: "14:00", event: "FOMC", tier: 1 },               // EST FOMC
  ],
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "news-blackout-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  const calPath = path.join(tmp, "news-calendar.json");
  fs.writeFileSync(calPath, JSON.stringify(FIXTURE));
  process.env.NEWS_CALENDAR_PATH = calPath;
  // Dynamic imports AFTER the env is set (static imports would open the real DB / calendar).
  const nb = await import("../server/news-blackout");
  const ts = await import("../server/trade-state");

  console.log("── W window derivation ──");
  {
    const w = nb.deriveWindows(FIXTURE as any, "2026-10-14");
    assert(w.length === 1 && w[0].fromET === "08:25" && w[0].toET === "08:40" && w[0].reason === "news blackout: CPI 08:30",
      `CPI day → one 08:25–08:40 window "news blackout: CPI 08:30" (got ${JSON.stringify(w.map(x => x.reason))})`);
    assert(w[0].fromSec === U("2026-10-14T12:25:00Z") && w[0].toSec === U("2026-10-14T12:40:00Z"),
      "October (EDT, UTC-4): 08:25 ET = 12:25 UTC, 08:40 ET = 12:40 UTC");
  }
  {
    const w = nb.deriveWindows(FIXTURE as any, "2026-11-10");
    assert(w.length === 1 && w[0].fromSec === U("2026-11-10T13:25:00Z") && w[0].toSec === U("2026-11-10T13:40:00Z"),
      "DST: November CPI (EST, UTC-5): 08:25 ET = 13:25 UTC — not the EDT 12:25");
  }
  {
    const w = nb.deriveWindows(FIXTURE as any, "2026-10-01");
    assert(w.length === 1 && w[0].fromSec === U("2026-10-01T13:55:00Z") && w[0].toSec === U("2026-10-01T14:05:00Z") && w[0].printET === "10:00",
      "10:00 print → 09:55–10:05 ET (13:55–14:05 UTC in EDT)");
  }
  {
    const w = nb.deriveWindows(FIXTURE as any, "2026-10-28");
    assert(w.length === 1 && w[0].fromSec === U("2026-10-28T17:55:00Z") && w[0].toSec === U("2026-10-28T18:30:00Z") && w[0].reason === "news blackout: FOMC 14:00",
      "FOMC statement day → 13:55–14:30 ET (EDT)");
    const d = nb.deriveWindows(FIXTURE as any, "2026-12-09");
    assert(d.length === 1 && d[0].fromSec === U("2026-12-09T18:55:00Z") && d[0].toSec === U("2026-12-09T19:30:00Z"),
      "DST: December FOMC (EST) → 18:55–19:30 UTC");
  }
  {
    const w = nb.deriveWindows(FIXTURE as any, "2026-10-15");
    assert(w.length === 1 && w[0].reason === "news blackout: PPI + Retail Sales 08:30", `two 08:30 prints → ONE window naming both (got ${w[0]?.reason})`);
  }
  assert(nb.deriveWindows(FIXTURE as any, "2026-10-30").length === 0, "a non-FOMC 14:00 event derives NO window (the FOMC rule is FOMC-only)");
  assert(nb.deriveWindows(FIXTURE as any, "2026-10-16").length === 0, "a day without prints derives no window");
  assert(nb.windowsForDay("2026-10-14").length === 1, "windowsForDay reads the (fixture) calendar file");
  assert(nb.allWindows().length === 6, `allWindows covers every derived window (got ${nb.allWindows().length})`);
  assert(nb.calendarCovers("2026-12-31") && !nb.calendarCovers("2027-01-05"), "calendarCovers honours window.to");
  assert(nb.calendarCovers("2026-10-01") && !nb.calendarCovers("2026-09-30"), "calendarCovers honours window.from (a day before the calendar is not covered)");
  {
    // 2026-10-01 verifier: window.to used to run past the published data (January). A partial
    // row beyond window.to still derives its window, but its day is NOT covered.
    const partial = { ...FIXTURE, partialThrough: "2027-01-31", events: [...FIXTURE.events, { date: "2027-01-27", timeET: "14:00", event: "FOMC", tier: 1 }] };
    assert(nb.deriveWindows(partial as any, "2027-01-27").length === 1 && !nb.calendarCovers("2027-01-27", partial as any) && !nb.calendarCovers("2027-01-08", partial as any),
      "a partial (post-window) FOMC row derives a window, but January days report covered:false");
  }

  console.log("── H calendar health (digest + integrity-check N1) ──");
  {
    const RULES_BLOCK = { rules: [
      { printTimeET: "08:30", blackoutFromET: "08:25", blackoutToET: "08:40" },
      { printTimeET: "10:00", blackoutFromET: "09:55", blackoutToET: "10:05" },
      { printTimeET: "14:00", event: "FOMC", blackoutFromET: "13:55", blackoutToET: "14:30" },
    ] };
    const good = { ...FIXTURE, blackoutRules: RULES_BLOCK, events: FIXTURE.events.filter(e => e.event !== "Treasury refunding") };
    const ok = nb.newsCalendarHealth("2026-10-01", good as any);
    assert(ok.ok && ok.eventsNext30 >= 1 && ok.next?.event === "ISM Manufacturing PMI", `healthy calendar → ok, next = ISM 2026-10-01 (${ok.problems.join(" | ")})`);
    assert(nb.calendarRulesMatch(good as any) && !nb.calendarRulesMatch(FIXTURE as any), "calendarRulesMatch: true for the approved copy, false when the block is missing");
    const drift = { ...good, blackoutRules: { rules: [{ ...RULES_BLOCK.rules[0], blackoutToET: "08:45" }, RULES_BLOCK.rules[1], RULES_BLOCK.rules[2]] } };
    assert(!nb.calendarRulesMatch(drift as any) && nb.newsCalendarHealth("2026-10-01", drift as any).problems.some(p => /differs/.test(p)),
      "a drifted rules copy (08:45) is flagged — the code literal governs");
    // deriveWindows ignores the file's block: the drifted copy does NOT change the live window.
    assert(nb.deriveWindows(drift as any, "2026-10-14")[0].toET === "08:40", "the file's blackoutRules are informational: windows still end 08:40");
    const miss = nb.newsCalendarHealth("2026-10-01", null);
    assert(!miss.ok && /missing\/unreadable/.test(miss.problems[0]), "missing calendar → problem 'NO news blackout is in force'");
    assert(nb.newsCalendarHealth("2027-01-02", good as any).problems.some(p => /EXPIRED/.test(p)), "today past window.to → EXPIRED");
    assert(nb.newsCalendarHealth("2026-12-20", good as any).problems.some(p => /covered only through 2026-12-31 \(11 day/.test(p)), "within 14 days of window.to → refresh warning");
    assert(nb.newsCalendarHealth("2026-10-29", good as any).problems.some(p => /no scheduled print in the next 30 days/.test(p)) === false,
      "Nov CPI inside 30 days of 2026-10-29 → no empty-horizon problem");
    assert(nb.newsCalendarHealth("2026-12-10", good as any).problems.some(p => /no scheduled print in the next 30 days/.test(p)),
      "after the last event (2026-12-09 FOMC) → 'no scheduled print in the next 30 days'");
    const typo = { ...good, events: [...good.events, { date: "2026-10-20", timeET: "8:30 ", event: "CPI", tier: 1 }] };
    assert(nb.newsCalendarHealth("2026-10-01", typo as any).problems.some(p => /no rule covers/.test(p)), "an event at '8:30 ' (typo) is flagged — it derives no window");
    assert(/^News calendar: OK — covered through 2026-12-31/.test(nb.newsCalendarDigestLine("2026-10-01", good as any)) && /^News calendar: ⚠️/.test(nb.newsCalendarDigestLine("2026-10-01", null)),
      "digest line: OK / ⚠️");
  }

  console.log("── G blackout reason + order gate ──");
  const cpi = U("2026-10-14T12:25:00Z");
  assert(nb.blackoutReason(cpi) === "news blackout: CPI 08:30", "08:25:00 ET (window start) → inside (inclusive)");
  assert(nb.blackoutReason(cpi - 1) === null, "08:24:59 ET → outside");
  assert(nb.blackoutReason(U("2026-10-14T12:39:59Z")) === "news blackout: CPI 08:30", "08:39:59 ET → inside");
  assert(nb.blackoutReason(U("2026-10-14T12:40:00Z")) === null, "08:40:00 ET (window end) → outside (exclusive)");
  assert(nb.blackoutReason(U("2026-11-10T12:30:00Z")) === null && nb.blackoutReason(U("2026-11-10T13:30:00Z")) === "news blackout: CPI 08:30",
    "DST: Nov CPI — 12:30 UTC (07:30 EST) outside, 13:30 UTC (08:30 EST) inside");

  const ism = U("2026-10-01T14:00:00Z"); // 10:00 ET — inside the 09:30–15:15 order window
  assert(ts.orderHoursGateReason(ism) === "news blackout: ISM Manufacturing PMI 10:00", `order gate refuses inside a 10:00 blackout during RTH (got ${ts.orderHoursGateReason(ism)})`);
  assert(ts.orderHoursGateReason(U("2026-10-01T14:05:00Z")) === null, "order gate allows at 10:05 ET (window end, inside order hours)");
  assert(ts.orderHoursGateReason(U("2026-10-28T18:10:00Z")) === "news blackout: FOMC 14:00", "order gate refuses at 14:10 ET on an FOMC day");
  assert(/^news blackout: CPI 08:30$/.test(ts.orderHoursGateReason(U("2026-10-14T12:30:00Z")) ?? ""), "inside an 08:30 window the NEWS reason is reported (checked before order hours)");
  ts.tradeSettings.orderHoursEnabled = false;
  assert(ts.orderHoursGateReason(ism) === "news blackout: ISM Manufacturing PMI 10:00", "the blackout applies even with orderHoursEnabled=false");
  ts.tradeSettings.orderHoursEnabled = true;
  ts.tradeSettings.newsBlackoutEnabled = false;
  assert(ts.orderHoursGateReason(ism) === null, "newsBlackoutEnabled=false → no blackout refusal");
  assert(ts.newsBlackoutGateReason(ism) === null, "newsBlackoutGateReason honours the switch");
  ts.tradeSettings.newsBlackoutEnabled = true;
  // Edited calendar → reload on mtime change (bump mtime explicitly; the 5 s stat throttle is
  // bypassed by re-pointing the path, which resets the cache like a fresh boot would).
  {
    const edited = { ...FIXTURE, events: [...FIXTURE.events, { date: "2026-10-16", timeET: "10:00", event: "JOLTS", tier: 2 }] };
    fs.writeFileSync(calPath, JSON.stringify(edited));
    const t = new Date(Date.now() + 5000); fs.utimesSync(calPath, t, t);
    nb.setNewsCalendarPath(calPath);
    assert(nb.blackoutReason(U("2026-10-16T13:58:00Z")) === "news blackout: JOLTS 10:00", "an edited calendar is picked up (mtime reload)");
    fs.writeFileSync(calPath, JSON.stringify(FIXTURE));
    nb.setNewsCalendarPath(calPath);
  }
  {
    nb.setNewsCalendarPath(path.join(tmp, "missing.json"));
    assert(ts.orderHoursGateReason(ism) === null, "missing calendar → fails OPEN (no blackout) — order hours still govern");
    nb.setNewsCalendarPath(calPath);
  }

  console.log("── E ETH classification at the bar close (DST) ──");
  // October = EDT (UTC-4): 09:30 ET = 13:30 UTC. November = EST (UTC-5): 09:30 ET = 14:30 UTC.
  assert(nb.isEthFire(U("2026-10-14T13:28:00Z"), "1m") === true, "Oct: 1m bar 09:28 EDT (closes 09:29) → ETH");
  assert(nb.isEthFire(U("2026-10-14T13:29:00Z"), "1m") === false, "Oct: 1m bar 09:29 EDT closes 09:30 → RTH (engine's close-time rule)");
  assert(nb.isEthFire(U("2026-11-10T13:29:00Z"), "1m") === true, "DST: Nov 13:29 UTC = 08:29 EST → ETH (a UTC-4 offset would call it RTH)");
  assert(nb.isEthFire(U("2026-11-10T14:29:00Z"), "1m") === false, "DST: Nov 14:29 UTC = 09:29 EST closes 09:30 → RTH");
  assert(nb.isEthFire(U("2026-11-10T13:00:00Z"), "60m") === true && nb.isEthFire(U("2026-11-10T14:00:00Z"), "60m") === false,
    "DST: Nov 60m 08:00 EST closes 09:00 → ETH; 09:00 EST closes 10:00 → RTH");
  assert(nb.isEthFire(U("2026-10-14T20:55:00Z"), "5m") === true, "Oct: 5m 16:55 EDT closes 17:00 → ETH (RTH ends 17:00)");
  assert(nb.isEthFire(U("2026-10-17T15:00:00Z"), "1m") === true, "Saturday → ETH/closed, never RTH");

  console.log("── S settings defaults ──");
  // Fresh temp DB → no persisted trade_settings row → the literal defaults stand.
  assert(JSON.stringify(ts.tradeSettings.orderWindows) === JSON.stringify([{ start: "09:30", end: "15:15" }]),
    `R1: default order window is RTH-only 09:30–15:15 (got ${JSON.stringify(ts.tradeSettings.orderWindows)})`);
  assert(ts.tradeSettings.ethAlertsEnabled === false, "R2a: ethAlertsEnabled defaults to false (overnight fires are record-only)");
  assert(ts.tradeSettings.newsBlackoutEnabled === true, "R3: newsBlackoutEnabled defaults to true (applies to orders now)");
  // 2026-10-01 verifier: $1,500 is the 25K PROFIT TARGET; current 25K plans trail $1,000 (only the
  // legacy 25K had a $1,500 threshold) — 1500/500 would pause at exactly the liquidation point.
  assert(ts.tradeSettings.apexHeadroomDollars === 1000 && ts.tradeSettings.apexGuardMarginDollars === 500,
    "Apex 25K: headroom $1,000 / margin $500 (MES $5/pt → 200 pts at 1 micro, 100 at 2; pause at $500 used)");
  assert(ts.tradeSettings.enabled === false, "auto-trade defaults DISARMED");
  assert(ts.orderHoursGateReason(U("2026-10-14T09:00:00Z")) != null, "05:00 ET (the removed 04:00–07:30 window) → orders withheld");

  console.log("── M alert mute decisions ──");
  const on = { ethAlertsEnabled: false, newsBlackoutEnabled: true };
  const cal = FIXTURE as any;
  assert(nb.alertMuteReason({ timestampSec: U("2026-10-14T07:00:00Z"), interval: "5m" }, on, cal) === "eth", "03:00 ET 5m fire → muted 'eth'");
  assert(nb.alertMuteReason({ timestampSec: U("2026-10-14T07:00:00Z"), interval: "5m" }, { ...on, ethAlertsEnabled: true }, cal) === null, "ethAlertsEnabled=true → overnight fire alerts");
  assert(nb.alertMuteReason({ timestampSec: U("2026-10-14T12:29:00Z"), interval: "1m" }, on, cal) === "eth", "08:29 ET on a CPI day, eth muted → 'eth' (ETH checked first)");
  assert(nb.alertMuteReason({ timestampSec: U("2026-10-14T12:29:00Z"), interval: "1m" }, { ...on, ethAlertsEnabled: true }, cal) === "news", "08:29 ET (closes 08:30) on a CPI day, ETH alerts on → 'news'");
  assert(nb.alertMuteReason({ timestampSec: U("2026-10-01T13:58:00Z"), interval: "1m" }, on, cal) === "news", "09:58 ET RTH fire on an ISM day → 'news'");
  assert(nb.alertMuteReason({ timestampSec: U("2026-10-01T13:58:00Z"), interval: "1m" }, { ...on, newsBlackoutEnabled: false }, cal) === null, "newsBlackoutEnabled=false → RTH news-window fire alerts");
  assert(nb.alertMuteReason({ timestampSec: U("2026-10-01T15:00:00Z"), interval: "15m" }, on, cal) === null, "11:00 ET RTH fire, no print → alerts");
  assert(nb.alertMuteReason({ timestampSec: U("2026-10-01T13:50:00Z"), interval: "5m" }, on, cal) === "news", "5m bar 09:50 closes 09:55 → inside the 10:00 window (classified at the close)");
  assert(nb.alertMuteReason({ timestampSec: null, interval: "5m", nowSec: U("2026-10-14T07:00:00Z") }, on, cal) === "eth", "no bar time → classified at now");
  assert(nb.alertMuteReason({ timestampSec: U("2026-10-14T07:00:00Z"), interval: "5m" }, {}, cal) === "eth", "unset switches default to the safe side (eth muted, news on)");
  // Unknown interval labels (2026-10-01 verifier minor): parsed, not close = open.
  assert(nb.intervalSecOf("60m") === 3600 && nb.intervalSecOf("1h") === 3600 && nb.intervalSecOf("4H") === 14400 && nb.intervalSecOf("30m") === 1800 && nb.intervalSecOf("weird") === 0,
    "intervalSecOf: known set, then <n>m / <n>h, unparseable = 0");
  assert(nb.isEthFire(U("2026-10-14T13:00:00Z"), "1h") === false && nb.isEthFire(U("2026-10-14T13:00:00Z"), "weird") === true,
    "a '1h' 09:00 EDT bar closes 10:00 → RTH (it used to be classified at its 09:00 open → ETH)");

  // Wiring (source scan): the route consults the decision BEFORE any webhook send, both switches
  // are accepted by POST /api/trade/settings, and the tab skips Discord for ETH fires + sends time.
  const routes = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf8");
  const dIdx = routes.indexOf('app.post("/api/discord/send"');
  const muteIdx = routes.indexOf("alertMuteReason(", dIdx);
  const hookIdx = routes.indexOf("fetch(webhook", dIdx);
  assert(dIdx > 0 && muteIdx > dIdx && muteIdx < hookIdx && /res\.json\(\{ ok: true, muted \}\)/.test(routes.slice(dIdx, hookIdx)),
    "/api/discord/send returns {ok:true, muted} from alertMuteReason before fetch(webhook)");
  assert(/typeof body\.ethAlertsEnabled === "boolean"/.test(routes) && /typeof body\.newsBlackoutEnabled === "boolean"/.test(routes),
    "POST /api/trade/settings merges ethAlertsEnabled + newsBlackoutEnabled");
  assert(routes.includes('app.get("/api/news/blackouts"'), "GET /api/news/blackouts is registered");
  const market = fs.readFileSync(path.join(process.cwd(), "client", "src", "pages", "market.tsx"), "utf8");
  assert(/if \(!ethMuted && discordWebhookRef\.current/.test(market) && /time: sig\.time/.test(market),
    "market.tsx skips the Discord POST for muted ETH fires and sends the fire time");

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
