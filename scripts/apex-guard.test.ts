// scripts/apex-guard.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// APEX 25K GUARD (2026-10-01 verifier round, owner: "my account now is a 25000 with a 1500
// target"). Temp SQLite via DB_PATH, pre-seeded with the EXACT shape of the live install's
// persisted rows (read read-only on 2026-10-01): a 50K-era trade_settings row carrying
// apexHeadroomDollars 2500 and no profile tag, and apex_guard_state {realized -1040, peak 0}.
// The live data/app.db is never opened.
//   H  hydration: a foreign-profile row's guard dollars are DROPPED (25K defaults stand), the
//      rest of the row (contracts, intervals) still hydrates, boot stays disarmed; a
//      same-profile row (after any Settings save) keeps the owner's values
//   C  account carry-over: a losing day carries past the 09:25 roll (lifetime threshold);
//      carry-over off = legacy per-day tracker; reset re-anchors
//   D  daily loss pause (0 = off) incl. open losses; day trailing path still pauses
//   R  route/UI wiring (source scan)
// Run: npx tsx scripts/apex-guard.test.ts
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apex-guard-test-"));
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.NEWS_CALENDAR_PATH = path.join(tmp, "no-calendar.json"); // no blackouts in this suite
  const { db } = await import("../server/db");
  const up = db.$client.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  // The live install's stored row (50K era): headroom 2500, no apexGuardProfile.
  up.run("trade_settings", JSON.stringify({
    enabled: true, contracts: 2, intervals: ["5m", "60m"], apexGuardEnabled: true,
    apexHeadroomDollars: 2500, apexGuardMarginDollars: 500, orderWindows: [{ start: "09:30", end: "15:15" }],
  }));
  // A losing guard day in the past (pre-carry state shape: no acct* fields).
  up.run("apex_guard_state", JSON.stringify({ day: "2000-01-03", realized: -1040, peak: 0 }));
  const ts = await import("../server/trade-state");

  console.log("── H hydration ──");
  assert(ts.tradeSettings.apexHeadroomDollars === 1000 && ts.tradeSettings.apexGuardMarginDollars === 500,
    `stored 50K-era headroom $2,500 is NOT hydrated → 25K default $1,000 / $500 (got ${ts.tradeSettings.apexHeadroomDollars}/${ts.tradeSettings.apexGuardMarginDollars})`);
  assert(ts.tradeSettings.apexGuardProfile === ts.APEX_GUARD_PROFILE, "the code's profile tag stands after hydration");
  assert(ts.tradeSettings.contracts === 2 && JSON.stringify(ts.tradeSettings.intervals) === JSON.stringify(["5m", "60m"]),
    "the rest of the stored row still hydrates (contracts 2, intervals 5m/60m)");
  assert(ts.tradeSettings.enabled === false, "boot stays DISARMED regardless of the stored enabled:true");
  assert(ts.tradeSettings.apexGuardCarryOver === true && ts.tradeSettings.apexDailyLossLimitDollars === 0,
    "defaults: account carry-over ON, daily loss pause OFF (plan type unconfirmed)");
  {
    // After any Settings save the row carries the current profile → the owner's value is kept.
    const saved = JSON.parse(JSON.stringify({ ...ts.tradeSettings, apexHeadroomDollars: 1500 }));
    const h = ts.hydratableSettings(saved);
    assert(h.settings.apexHeadroomDollars === 1500 && !h.droppedGuardDollars, "a same-profile row keeps the owner's headroom (1500 for a legacy plan)");
    const f = ts.hydratableSettings({ apexHeadroomDollars: 2500, apexGuardProfile: "apex-50k" } as any);
    assert(f.settings.apexHeadroomDollars === undefined && f.droppedGuardDollars, "a different profile's headroom is dropped");
    assert(!("apexGuardProfile" in ts.hydratableSettings({ apexGuardProfile: "x" } as any).settings), "the profile tag itself is never hydrated from the row");
  }

  console.log("── C account carry-over ──");
  {
    const g = ts.apexGuardState();
    assert(g.day !== "2000-01-03" && g.realized === 0 && g.peak === 0, `the DAY tracker rolled to today (${g.day}) and zeroed`);
    assert(g.acctRealized === -1040 && g.acctPeak === 0 && g.acctSince === "2000-01-03",
      `the ACCOUNT tracker carried the −$1,040 day (acct ${g.acctRealized}/${g.acctPeak} since ${g.acctSince})`);
    const r = ts.apexGuardReason(null);
    assert(r != null && /ACCOUNT peak since 2000-01-03/.test(r) && /\$1040/.test(r),
      `the carried −$1,040 ≥ the $500 budget → orders PAUSED the next day (got ${r})`);
    ts.tradeSettings.apexGuardCarryOver = false;
    assert(ts.apexGuardReason(null) === null, "carry-over OFF → legacy per-day tracker (fresh day, no pause)");
    ts.tradeSettings.apexGuardCarryOver = true;
    assert(/ORDERS PAUSED/.test(ts.apexGuardDigestLine()) && /headroom \$1000/.test(ts.apexGuardDigestLine()),
      `digest line reports the headroom + the pause (${ts.apexGuardDigestLine()})`);
    const z = ts.resetApexGuard();
    assert(z.acctRealized === 0 && z.acctPeak === 0 && z.acctSince === z.day && ts.apexGuardReason(null) === null,
      "Reset guard tracker re-anchors the account tracker → orders allowed");
    const persisted = JSON.parse((db.$client.prepare(`SELECT value FROM app_settings WHERE key='apex_guard_state'`).get() as { value: string }).value);
    assert(persisted.acctRealized === 0 && persisted.acctSince === z.day, "the reset is persisted (survives a restart)");
  }

  console.log("── D daily loss pause + day trailing ──");
  {
    const now = Math.floor(Date.now() / 1000);
    ts.setCurrentTrade({ symbol: "MES", direction: "Long", interval: "5m", riskLevel: "safe", entry: 5000, tp1: 5050, tp2: null, sl: 4950,
      contracts: 2, tp1Only: true, firedAt: now, status: "open", confirmed: true });
    // open mark at 4980 = −20 pts × 2 × $5 = −$200.
    assert(ts.apexGuardReason(4980) === null, "−$200 open, DLL off, budget $500 → allowed");
    ts.tradeSettings.apexDailyLossLimitDollars = 150;
    const r = ts.apexGuardReason(4980);
    assert(r != null && /daily loss pause/.test(r), `DLL $150 with −$200 OPEN loss → paused (open losses count, like Apex) (got ${r})`);
    ts.tradeSettings.apexDailyLossLimitDollars = 300;
    assert(ts.apexGuardReason(4980) === null, "DLL $300 with −$200 → allowed");
    ts.tradeSettings.apexDailyLossLimitDollars = 0;
    // The stop trades: −50 pts × 2 × $5 = −$500 realized → day used $500 ≥ budget $500.
    const r2 = ts.apexGuardReason(4950);
    assert(ts.getActiveTrades().length === 0, "the SL touch closed the tracked trade");
    assert(r2 != null && /session equity peak/.test(r2), `−$500 realized ≥ $1,000 − $500 → paused (got ${r2})`);
    const g = ts.apexGuardState();
    assert(g.realized === -500 && g.acctRealized === -500, "the close books into BOTH trackers");
    ts.resetApexGuard();
  }

  console.log("── R wiring (source scan) ──");
  const routes = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf8");
  assert(/typeof body\.apexGuardCarryOver === "boolean"/.test(routes) && /body\.apexDailyLossLimitDollars/.test(routes),
    "POST /api/trade/settings accepts apexGuardCarryOver + apexDailyLossLimitDollars");
  assert(!/tradeSettings\.apexGuardProfile\s*=/.test(routes), "the route never lets a client set the profile tag");
  const sched = fs.readFileSync(path.join(process.cwd(), "server", "scheduler.ts"), "utf8");
  assert(sched.includes("apexGuardDigestLine()") && sched.includes("newsCalendarDigestLine("), "the daily digest prints the Apex guard + news calendar lines");
  const market = fs.readFileSync(path.join(process.cwd(), "client", "src", "pages", "market.tsx"), "utf8");
  assert(/apexHeadroomDollars/.test(market) && /\/api\/trade\/guard\/reset/.test(market) && /ethAlertsEnabled: next/.test(market) && /newsBlackoutEnabled: next/.test(market),
    "market.tsx Settings exposes headroom, guard reset, overnight-alert and news-blackout controls");

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
