// scripts/cached-continuous-cap.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// SERVE WINDOW (2026-09-24 — "the chart isn't loading correctly") unit tests. Pure — no DB,
// no server, no clock. Covers server/serve-window.ts (the clamp GET /api/data/cached-continuous
// and GET /api/yellowbox/day-zones run before touching SQLite):
//   1. an explicit deep `from` is clamped (the 2019 request that cost 248 MB / 20 s)
//   2. per-resolution span caps (1m/5m floored at the engine window, 15m 400 d, 60m none)
//   3. ?full=1 honored only for 15m / 60m, ignored for 1m / 5m
//   4. NaN / negative / garbage / array `from` → absent → capped window; `to` sanitised
//   5. the server engines' 90-cached-day windows are NEVER clamped (catch-up / live-engine parity)
//   6. cache-key consistency (key == SQL bounds; same-hour callers share; superset `to`)
//   7. row-cap check gating + floor application
//   8. day-zones span cap
//   9. client helper (client/src/lib/candle-window.ts): per-interval caps, day-window
//      derivation (never the FIRST cached day), fallback, terminal deep-history query
//  10. C2 query plan (windowQueryPlan / windowQueryKey — what market.tsx keys every window
//      query with): one key per URL on every view (a DOM-free stand-in for the fetch spy:
//      react-query dedupes by key hash, so distinct enabled keys == requests), identical
//      shared observer options, enabled flags = the pre-C2 conditions, bg15m = agg5mTo15m(5m)
// Run: tsx scripts/cached-continuous-cap.test.ts
// ─────────────────────────────────────────────────────────────────────────────
import {
  resolveServeWindow, rowCapCheckNeeded, applyRowCapFloor, serveCacheKey, resolveDayZonesWindow,
  parseEpochParam, SERVE_SPAN_CAP_DAYS, REQUESTED_SPAN_CAP_DAYS, ENGINE_WINDOW_MIN_DAYS, SERVE_ROW_CAP,
  DAY_ZONES_MAX_SPAN_DAYS, FUTURE_SLACK_SEC,
} from "../server/serve-window";
import {
  CLIENT_WINDOW_CAP_DAYS, FALLBACK_WINDOW_DAYS, resolveDayRange, daysStateOf, windowStartTs,
  cappedFromTs, windowCapHint, terminalDeepHistoryQuery,
  windowQueryPlan, windowQueryKey, fetchIntervalFor, bg15mFrom5mData, WINDOW_QUERY_OPTIONS, CONTINUOUS_QUERY_ROOT,
  type WindowQueryPlan, type CandleInterval,
} from "../client/src/lib/candle-window";
import { agg5mTo15m } from "../shared/live-adapter";

let pass = 0; const failures: string[] = [];
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}`); }
}

const H = 3600, D = 86400;
const NOW = 1790265445;                   // 2026-09-24 ~15:57Z (the evidence file's `to` − 1 h)
const hf = (t: number) => Math.floor(t / H) * H;
const hc = (t: number) => Math.ceil(t / H) * H;
const FIRST_DAY_2019 = 1564876800;        // 2019-08-04 — the observed deep `from`

// ── 1. explicit deep `from` is clamped ───────────────────────────────────────
console.log("1. explicit deep from");
{
  const w = resolveServeWindow({ interval: "1m", from: String(FIRST_DAY_2019), to: String(NOW + H) }, NOW);
  const expectFloor = hf(Math.min(NOW + H, NOW + H) - SERVE_SPAN_CAP_DAYS["1"] * D);
  assert(w.capped === true, "1m from=2019 → capped");
  assert(w.fromQ === expectFloor, `1m from=2019 → fromQ = to − ${SERVE_SPAN_CAP_DAYS["1"]} d (hour-floored)`);
  assert(w.servedFrom === w.fromQ, "servedFrom echoes the clamped lower bound");
  assert((w.toQ - w.fromQ) / D <= SERVE_SPAN_CAP_DAYS["1"] + 1, "served span ≤ cap (+1 h ceil)");
  const w5 = resolveServeWindow({ interval: "5m", from: String(FIRST_DAY_2019), to: String(NOW + H) }, NOW);
  assert(w5.capped && w5.fromQ === hf(NOW + H - SERVE_SPAN_CAP_DAYS["5"] * D), "5m from=2019 → clamped to the 5m cap");
  const w15 = resolveServeWindow({ interval: "15m", from: String(FIRST_DAY_2019), to: String(NOW + H) }, NOW);
  assert(w15.capped && w15.fromQ === hf(NOW + H - 400 * D), "15m from=2019 → clamped to 400 d");
  const w60 = resolveServeWindow({ interval: "60m", from: String(FIRST_DAY_2019), to: String(NOW + H) }, NOW);
  assert(!w60.capped && w60.fromQ === hf(FIRST_DAY_2019), "60m from=2019 → span unlimited (row cap still applies)");
}

// ── 2. cap numbers ───────────────────────────────────────────────────────────
console.log("2. span caps");
assert(REQUESTED_SPAN_CAP_DAYS["1"] === 14 && REQUESTED_SPAN_CAP_DAYS["5"] === 90 && REQUESTED_SPAN_CAP_DAYS["15"] === 400 && REQUESTED_SPAN_CAP_DAYS["60"] === Infinity,
  "requested caps: 1m 14 d, 5m 90 d, 15m 400 d, 60m ∞");
assert(SERVE_SPAN_CAP_DAYS["1"] === Math.max(14, ENGINE_WINDOW_MIN_DAYS), "server 1m cap = max(14, engine window)");
assert(SERVE_SPAN_CAP_DAYS["5"] === Math.max(90, ENGINE_WINDOW_MIN_DAYS), "server 5m cap = max(90, engine window)");
assert(SERVE_SPAN_CAP_DAYS["15"] === 400 && SERVE_SPAN_CAP_DAYS["60"] === Infinity, "server 15m 400 d, 60m ∞");
// 90 cached days can never span more than 90 × 7/5 calendar days (weekday-only list) + holidays.
assert(ENGINE_WINDOW_MIN_DAYS >= Math.ceil(90 * 7 / 5) + 14, "engine-window floor covers 90 cached days even for a weekday-only list + 2 weeks of holidays");
{
  // an explicit window INSIDE the cap is untouched (only hour-floored)
  const from = NOW - 3 * D + 1234;
  const w = resolveServeWindow({ interval: "1m", from: String(from) }, NOW);
  assert(!w.capped && w.fromQ === hf(from) && w.servedFrom === null, "3-day 1m window: not capped, from hour-floored");
  // absent from → capped window from the cap floor
  const wa = resolveServeWindow({ interval: "1m" }, NOW);
  assert(wa.capped && wa.fromQ === hf(NOW + H - SERVE_SPAN_CAP_DAYS["1"] * D), "absent from → the capped window (anchored at now + 1 h)");
  // the anchor for a request with no `to` is now + 1 h, not the 36-h future clamp
  assert(wa.toQ === hf(NOW + FUTURE_SLACK_SEC), "absent to → toQ = hour-floored future clamp");
  // a HISTORICAL `to`: the cap is measured back from that `to`
  const histTo = NOW - 200 * D;
  const wh = resolveServeWindow({ interval: "1m", from: String(FIRST_DAY_2019), to: String(histTo) }, NOW);
  assert(wh.capped && wh.fromQ === hf(histTo - SERVE_SPAN_CAP_DAYS["1"] * D) && wh.toQ === hc(histTo), "historical to → span measured back from that to");
}

// ── 3. full=1 rules ──────────────────────────────────────────────────────────
console.log("3. full=1");
{
  const w15 = resolveServeWindow({ interval: "15m", full: "1" }, NOW);
  assert(w15.full && !w15.capped && w15.fromQ === 0 && w15.spanCapDays === Infinity, "15m full=1 → span unlimited");
  const w60 = resolveServeWindow({ interval: "60m", full: "1" }, NOW);
  assert(w60.full && w60.fromQ === 0, "60m full=1 → span unlimited");
  const w1 = resolveServeWindow({ interval: "1m", full: "1" }, NOW);
  assert(!w1.full && w1.capped && w1.fromQ === hf(NOW + H - SERVE_SPAN_CAP_DAYS["1"] * D), "1m full=1 → IGNORED (still capped)");
  const w5 = resolveServeWindow({ interval: "5m", full: "1", from: String(FIRST_DAY_2019) }, NOW);
  assert(!w5.full && w5.capped, "5m full=1 + deep from → IGNORED (still capped)");
  const w15t = resolveServeWindow({ interval: "15m", full: "true", from: String(FIRST_DAY_2019) }, NOW);
  assert(w15t.full && !w15t.capped && w15t.fromQ === hf(FIRST_DAY_2019), "15m full=true + deep from → honored");
  const w15x = resolveServeWindow({ interval: "15m", full: "yes", from: String(FIRST_DAY_2019) }, NOW);
  assert(!w15x.full && w15x.capped, "15m full=yes → not a full request");
}

// ── 4. NaN / negative / garbage ──────────────────────────────────────────────
console.log("4. parameter sanitising");
{
  const capped1m = hf(NOW + H - SERVE_SPAN_CAP_DAYS["1"] * D);
  for (const bad of ["-1", "-1564876800", "abc", "NaN", "", "0", "Infinity", "1e400"]) {
    const w = resolveServeWindow({ interval: "1m", from: bad }, NOW);
    assert(w.fromQ === capped1m && w.capped, `1m from=${JSON.stringify(bad)} → absent → capped window`);
  }
  const wArr = resolveServeWindow({ interval: "1m", from: ["1564876800", "1"] }, NOW);
  assert(wArr.fromQ === capped1m, "repeated from (array) → absent → capped window");
  const wNeg60 = resolveServeWindow({ interval: "60m", from: "-5" }, NOW);
  assert(wNeg60.fromQ === 0 && rowCapCheckNeeded(wNeg60), "60m negative from → 0 → row-cap check runs");
  const wT = resolveServeWindow({ interval: "5m", from: String(NOW - D), to: "abc" }, NOW);
  assert(wT.toQ === hf(NOW + FUTURE_SLACK_SEC), "to=abc → the future clamp (never unbounded)");
  const wFar = resolveServeWindow({ interval: "5m", from: String(NOW - D), to: String(NOW + 400 * D) }, NOW);
  assert(wFar.toQ <= NOW + FUTURE_SLACK_SEC, "far-future to → clamped to now + 36 h");
  assert(parseEpochParam(undefined) === null && parseEpochParam(null) === null && parseEpochParam({}) === null, "parseEpochParam: undefined/null/object → null");
  assert(parseEpochParam(" 5 ") === 5 && parseEpochParam(7) === 7, "parseEpochParam: numeric string / number");
}

// ── 5. engine windows are never clamped ──────────────────────────────────────
console.log("5. server engine windows (catch-up / live-engine / parity)");
{
  // catchup.ts: from = UTC midnight of the 90th-newest cached day (2026-06-12 on 2026-09-24), to = now + 1 h.
  const engineFrom = Date.UTC(2026, 5, 12) / 1000;
  for (const iv of ["1m", "5m", "15m", "60m"]) {
    const w = resolveServeWindow({ interval: iv, from: String(engineFrom), to: String(NOW + H) }, NOW);
    assert(!w.capped && w.fromQ === engineFrom && w.toQ >= NOW + H, `engine ${iv} window (105 d) served unclamped`);
  }
  // worst plausible 90-cached-day span (weekday-only list + holidays)
  const worstFrom = hf(NOW - 140 * D);
  const w = resolveServeWindow({ interval: "1m", from: String(worstFrom), to: String(NOW + H) }, NOW);
  assert(!w.capped, "a 140-calendar-day 1m engine window is still unclamped");
  // phone windows (DayTrading chart-view 10 d, use-market-data 14 d; to = now + 1 d)
  for (const days of [10, 14]) {
    for (const iv of ["1m", "5m", "15m", "60m"]) {
      const pw = resolveServeWindow({ interval: iv, from: String(NOW - days * D), to: String(NOW + D) }, NOW);
      assert(!pw.capped, `phone ${days}-day ${iv} window unclamped`);
    }
  }
}

// ── 6. cache-key consistency ─────────────────────────────────────────────────
console.log("6. cache key");
{
  const hourStart = hf(NOW);
  // two callers inside the same hour (from AND to) → identical SQL bounds → identical key
  const a = resolveServeWindow({ interval: "1m", from: String(hourStart - 3 * D + 10), to: String(hourStart + 300) }, NOW);
  const b = resolveServeWindow({ interval: "1m", from: String(hourStart - 3 * D + 3000), to: String(hourStart + 1500) }, NOW);
  assert(a.fromQ === b.fromQ && a.toQ === b.toQ, "same-hour from/to → same SQL bounds");
  assert(serveCacheKey("MES", a) === serveCacheKey("MES", b), "same SQL bounds → same key");
  // the body served under that key covers BOTH callers' `to` (superset — the old rounding bug
  // handed caller B a body cut at caller A's to=H+300)
  assert(a.toQ >= hourStart + 1500 && a.toQ >= hourStart + 300, "shared body's upper bound ≥ every sharing caller's to");
  // different SQL bounds → different key
  const c = resolveServeWindow({ interval: "1m", from: String(hourStart - 3 * D + 10), to: String(hourStart + H + 5) }, NOW);
  assert(serveCacheKey("MES", c) !== serveCacheKey("MES", a), "different toQ → different key");
  // the key carries the clamped from (a deep request and a request AT the floor run the same SQL
  // but differ in the echoed capped flag → different keys, each body exact)
  const deep = resolveServeWindow({ interval: "1m", from: String(FIRST_DAY_2019), to: String(NOW + H) }, NOW);
  const atFloor = resolveServeWindow({ interval: "1m", from: String(deep.fromQ), to: String(NOW + H) }, NOW);
  assert(deep.fromQ === atFloor.fromQ && deep.toQ === atFloor.toQ, "deep vs at-floor: same SQL bounds");
  assert(serveCacheKey("MES", deep).includes(`:${deep.fromQ}:${deep.toQ}:`), "key contains the clamped from and the ceiled to");
  assert(serveCacheKey("MES", deep) !== serveCacheKey("MES", atFloor), "capped flag is part of the key");
  // every deep 1m request, whatever its raw from, lands on ONE key (inside the same hour)
  const deep2 = resolveServeWindow({ interval: "1m", from: "-1", to: String(NOW + H) }, NOW);
  assert(serveCacheKey("MES", deep2) === serveCacheKey("MES", deep), "from=-1 and from=2019 share the capped key");
  // key bounds are hour-aligned
  assert(a.fromQ % H === 0 && a.toQ % H === 0 && deep.fromQ % H === 0, "fromQ / toQ hour-aligned");
  // interval is part of the key
  const a5 = resolveServeWindow({ interval: "5m", from: String(hourStart - 3 * D + 10), to: String(hourStart + 300) }, NOW);
  assert(serveCacheKey("MES", a5) !== serveCacheKey("MES", a), "interval is part of the key");
  assert(serveCacheKey("MES", a).startsWith("MES:"), "key keeps the symbol prefix (cacheInvalidate(symbol) still drops it)");
}

// ── 7. row cap ───────────────────────────────────────────────────────────────
console.log("7. row cap");
{
  const w1 = resolveServeWindow({ interval: "1m" }, NOW);
  assert(!rowCapCheckNeeded(w1), "1m capped span (≤ 150 d ≈ 216k bars) never needs the OFFSET query");
  const w3 = resolveServeWindow({ interval: "1m", from: String(NOW - 3 * D) }, NOW);
  assert(!rowCapCheckNeeded(w3), "short windows skip the OFFSET query (hot path)");
  const w60 = resolveServeWindow({ interval: "60m" }, NOW);
  assert(rowCapCheckNeeded(w60), "60m unbounded → row-cap query");
  const w15f = resolveServeWindow({ interval: "15m", full: "1" }, NOW);
  assert(rowCapCheckNeeded(w15f) && w15f.rowRes === "5", "15m full=1 → row-cap query on the 5m rows (the route's long-standing mapping)");
  const capTs = 1768273140; // 2026-01-13 (the observed 1m floor), not hour-aligned
  const applied = applyRowCapFloor(w60, capTs);
  assert(applied.fromQ === hf(capTs) && applied.capped && applied.servedFrom === hf(capTs), "row-cap floor applied (hour-floored) + capped");
  assert(applyRowCapFloor(w60, undefined) === w60, "no cap row (store under the cap) → unchanged");
  const w60recent = resolveServeWindow({ interval: "60m", from: String(NOW - 10 * D) }, NOW);
  assert(applyRowCapFloor(w60recent, capTs - 400 * D) === w60recent, "cap floor older than from → unchanged");
  assert(SERVE_ROW_CAP["1"] === 250_000 && SERVE_ROW_CAP["5"] === 500_000 && SERVE_ROW_CAP["60"] === 60_000, "row-cap numbers unchanged");
}

// ── 8. day-zones ─────────────────────────────────────────────────────────────
console.log("8. day-zones");
{
  const z = resolveDayZonesWindow({ fromTs: String(FIRST_DAY_2019), toTs: String(NOW + H) }, NOW);
  assert(z.capped && z.fromTs === NOW + H - DAY_ZONES_MAX_SPAN_DAYS * D && z.toTs === NOW + H, "2019 fromTs → capped to 400 d");
  const eng = resolveDayZonesWindow({ fromTs: String(Date.UTC(2026, 5, 12) / 1000), toTs: String(NOW + H) }, NOW);
  assert(!eng.capped && eng.fromTs === Date.UTC(2026, 5, 12) / 1000, "engine 105-day day-zones window unclamped");
  const def = resolveDayZonesWindow({}, NOW);
  assert(def.toTs === NOW && def.fromTs === NOW - 400 * D, "no params → last 400 d (was 730)");
  const bad = resolveDayZonesWindow({ fromTs: "-7", toTs: "abc" }, NOW);
  assert(bad.toTs === NOW && bad.fromTs === NOW - 400 * D, "garbage bounds → defaults, capped");
  const recent = resolveDayZonesWindow({ fromTs: String(NOW - 2 * D), toTs: String(NOW + D) }, NOW);
  assert(!recent.capped && recent.fromTs === NOW - 2 * D, "ThoughtsPanel 2-day window unclamped");
}

// ── 9. client helper ─────────────────────────────────────────────────────────
console.log("9. client candle-window helper");
{
  assert(CLIENT_WINDOW_CAP_DAYS["1m"] === 14 && CLIENT_WINDOW_CAP_DAYS["5m"] === 90 && CLIENT_WINDOW_CAP_DAYS["15m"] === 400 && CLIENT_WINDOW_CAP_DAYS["60m"] === Infinity,
    "client caps: 1m 14 d, 5m 90 d, 15m 400 d, 60m ∞");
  for (const iv of ["1m", "5m", "15m", "60m"] as const) {
    const serverCap = SERVE_SPAN_CAP_DAYS[iv === "1m" ? "1" : iv === "5m" ? "5" : iv === "15m" ? "15" : "60"];
    assert(CLIENT_WINDOW_CAP_DAYS[iv] <= serverCap, `client ${iv} cap ≤ server cap (a client-capped request is never re-clamped)`);
  }
  assert(FALLBACK_WINDOW_DAYS === 10, "fallback window = 10 days (was 730)");

  // resolveDayRange: an UNSETTLED window is the LAST windowSize days — never days[0..59]
  const total = 2226;
  const r0 = resolveDayRange(total, 90, 0, 59, false);
  assert(r0 !== null && r0.start === total - 90 && r0.end === total - 1, "unsettled (initial 0..59) → last 90 days, never the first cached day");
  const rS = resolveDayRange(total, 90, 100, 189, true);
  assert(rS !== null && rS.start === 100 && rS.end === 189, "settled scrubber indices are kept");
  const rBad = resolveDayRange(500, 90, 2136, 2225, true);
  assert(rBad !== null && rBad.start === 410 && rBad.end === 499, "stale indices (symbol switch) → default window");
  assert(resolveDayRange(0, 90, 0, 59, true) === null, "no days → null");
  const rAll = resolveDayRange(total, 9999, 0, total - 1, true);
  assert(rAll !== null && rAll.start === 0, "ALL window keeps start 0 (the per-interval cap bounds the fetch)");

  // days state + window start
  assert(daysStateOf({ loading: true, error: false, count: 0 }) === "loading", "days loading → loading");
  assert(daysStateOf({ loading: false, error: true, count: 0 }) === "empty", "days error → empty (fallback)");
  assert(daysStateOf({ loading: false, error: false, count: 0 }) === "empty", "no days → empty (fallback)");
  assert(daysStateOf({ loading: false, error: false, count: 3 }) === "ready", "days → ready");
  assert(daysStateOf({ loading: true, error: false, count: 3 }) === "ready", "refetching with data → ready");
  assert(windowStartTs("loading", null, NOW) === 0, "loading → 0 (queries disabled — no 730-day fallback fetch)");
  assert(windowStartTs("ready", 1781222400, NOW) === 1781222400, "ready → first windowed day");
  assert(windowStartTs("ready", null, NOW) === 0, "ready without a day → 0");
  assert(windowStartTs("empty", null, NOW) === hf(NOW - 10 * D), "empty → 10-day fallback");

  // cappedFromTs
  const toTs = NOW + H;
  assert(cappedFromTs(FIRST_DAY_2019, toTs, "1m") === hf(toTs - 14 * D), "1m from=2019 → to − 14 d");
  assert(cappedFromTs(FIRST_DAY_2019, toTs, "5m") === hf(toTs - 90 * D), "5m from=2019 → to − 90 d");
  assert(cappedFromTs(FIRST_DAY_2019, toTs, "15m") === hf(toTs - 400 * D), "15m from=2019 → to − 400 d");
  assert(cappedFromTs(FIRST_DAY_2019, toTs, "60m") === FIRST_DAY_2019, "60m unlimited");
  assert(cappedFromTs(1781222400, toTs, "15m") === 1781222400, "90-day 15m window unchanged");
  assert(cappedFromTs(0, toTs, "1m") === 0, "0 (not ready) stays 0");
  // the client-capped request is NOT re-clamped by the server
  for (const iv of ["1m", "5m", "15m"] as const) {
    const f = cappedFromTs(FIRST_DAY_2019, toTs, iv);
    const w = resolveServeWindow({ interval: iv, from: String(f), to: String(toTs) }, NOW);
    assert(!w.capped && w.fromQ === f, `client-capped ${iv} request served as asked`);
  }
  assert(windowCapHint(FIRST_DAY_2019, toTs, "1m") === "window capped to 14 days for 1m", "hint text for a capped 1m window");
  assert(windowCapHint(1781222400, toTs, "15m") === null, "no hint when not capped");
  assert(windowCapHint(0, toTs, "1m") === null, "no hint while not ready");

  // terminal deep history (useTerminalData.loadMoreHistory)
  assert(terminalDeepHistoryQuery("15m", NOW) === "full=1" && terminalDeepHistoryQuery("60m", NOW) === "full=1", "15m/60m deep history → full=1");
  assert(terminalDeepHistoryQuery("1m", NOW) === `from=${hf(NOW - 14 * D)}`, "1m deep history → explicit 14-day window");
  assert(terminalDeepHistoryQuery("5m", NOW) === `from=${hf(NOW - 90 * D)}`, "5m deep history → explicit 90-day window");
  const dq = resolveServeWindow({ interval: "1m", from: String(hf(NOW - 14 * D)) }, NOW);
  assert(!dq.capped, "1m deep-history request is inside the server cap");
}

// ── 10. C2: one react-query key per URL ─────────────────────────────────────
console.log("10. C2 window query plan");
{
  const toTs = NOW + H;
  const fromTs = 1781222400; // the 90-day window start from the evidence file
  const SYM = "MES";
  // The URL each observer's queryFn requests (market.tsx fetchContinuousWindow).
  const urlOf = (key: readonly unknown[]) => `/api/data/cached-continuous/${key[1]}/${key[2]}?from=${key[3]}&to=${key[4]}`;
  const observers = (p: WindowQueryPlan) => [
    { name: "main", ...p.main }, { name: "q1m", ...p.q1m }, { name: "q60m", ...p.q60m }, { name: "q5m", ...p.q5m },
  ];
  for (const view of ["1m", "5m", "15m", "60m"] as const) {
    for (const showVector of [true, false]) {
      const p = windowQueryPlan({ symbol: SYM, viewInterval: view, showVector, fromTs, toTs });
      const tag = `${view} view, vector ${showVector ? "on" : "off"}`;
      const obs = observers(p);
      // Every observer key is 5 elements — no "bg" suffix can split a URL across two entries.
      assert(obs.every(o => o.key.length === 5 && o.key[0] === CONTINUOUS_QUERY_ROOT && o.key[1] === SYM), `${tag}: every key = [root, sym, iv, from, to]`);
      // Per resolution ONE from: any two observers of the same resolution have identical keys.
      const byIv = new Map<string, string>();
      let oneKeyPerResolution = true;
      for (const o of obs) {
        const h = JSON.stringify(o.key);
        const prev = byIv.get(String(o.key[2]));
        if (prev && prev !== h) oneKeyPerResolution = false;
        byIv.set(String(o.key[2]), h);
      }
      assert(oneKeyPerResolution, `${tag}: observers of one resolution share one key`);
      // Fetch spy: react-query issues one request per distinct ENABLED key hash.
      const enabled = obs.filter(o => o.enabled);
      const requests = new Set(enabled.map(o => JSON.stringify(o.key)));
      const urls = enabled.map(o => urlOf(o.key));
      assert(requests.size === new Set(urls).size, `${tag}: distinct keys == distinct URLs (${requests.size} requests)`);
      const expectIvs = new Set<string>([p.fetchInterval, "5m", ...(p.q1m.enabled ? ["1m"] : []), ...(p.q60m.enabled ? ["60m"] : [])]);
      assert(requests.size === expectIvs.size, `${tag}: exactly one request per needed resolution (${[...expectIvs].join(",")})`);
      // Main key == the shared secondary/bg key of its resolution.
      const mainIv = fetchIntervalFor(view);
      const twin = mainIv === "1m" ? p.q1m : mainIv === "5m" ? p.q5m : mainIv === "60m" ? p.q60m : null;
      if (twin) assert(JSON.stringify(twin.key) === JSON.stringify(p.main.key), `${tag}: main key IS the shared ${mainIv} entry`);
      else assert(!obs.slice(1).some(o => o.key[2] === "15m"), `${tag}: nothing else keys 15m (bg15m is derived, never a query)`);
      assert(p.main.from === p.froms[mainIv] && p.q1m.from === p.froms["1m"] && p.q5m.from === p.froms["5m"] && p.q60m.from === p.froms["60m"], `${tag}: froms are the per-resolution capped window`);
      // Enabled/consumer flags = the pre-C2 conditions (HEAD market.tsx raw1m/bg1m/raw60m/bg60m).
      assert(p.q1m.rawEnabled === (showVector && mainIv !== "1m") && p.q1m.bgEnabled === (view !== "1m"), `${tag}: 1m consumer gating unchanged`);
      assert(p.q60m.rawEnabled === (showVector && mainIv !== "60m") && p.q60m.bgEnabled === (view !== "60m"), `${tag}: 60m consumer gating unchanged`);
      assert(p.bg15mFrom5m === (view !== "15m"), `${tag}: bg15m derived from 5m except on the 15m view`);
    }
  }
  // Window not ready (cached-days loading) → nothing is requested.
  const idle = windowQueryPlan({ symbol: SYM, viewInterval: "5m", showVector: true, fromTs: 0, toTs });
  assert(!idle.main.enabled && !idle.q1m.enabled && !idle.q5m.enabled && !idle.q60m.enabled, "fromTs 0 → every window query disabled");
  // The client caps still apply through the plan.
  const deep = windowQueryPlan({ symbol: SYM, viewInterval: "1m", showVector: true, fromTs: FIRST_DAY_2019, toTs });
  assert(deep.main.from === hf(toTs - 14 * D) && deep.q5m.from === hf(toTs - 90 * D), "plan froms are capped (1m 14 d, 5m 90 d)");
  assert(JSON.stringify(windowQueryKey(SYM, "5m" as CandleInterval, 1, 2)) === JSON.stringify([CONTINUOUS_QUERY_ROOT, SYM, "5m", 1, 2]), "windowQueryKey tuple layout (refreshRangedFrom reads key[2..4])");
  // Shared observer options — query-core applies each observer's options to the shared Query,
  // so a differing retry on any observer used to change the main chart query's behaviour.
  assert(WINDOW_QUERY_OPTIONS.retry === false && WINDOW_QUERY_OPTIONS.staleTime === Infinity &&
    WINDOW_QUERY_OPTIONS.refetchOnWindowFocus === false && WINDOW_QUERY_OPTIONS.refetchOnReconnect === false,
    "one option set for every window observer (fail-fast, never auto-refetch)");

  // bg15m derivation over the shared 5m entry.
  const t0 = hf(NOW) - 6 * H;
  const c5 = Array.from({ length: 12 }, (_, k) => ({ time: t0 + k * 300, open: 100 + k, high: 101 + k, low: 99 + k, close: 100.5 + k, volume: 10 + k }));
  const entry = { candles: c5 };
  const d15 = bg15mFrom5mData("5m", entry);
  assert(!!d15 && JSON.stringify(d15.candles) === JSON.stringify(agg5mTo15m(c5)) && d15.candles.length === 4, "bg15m = agg5mTo15m over the 5m entry");
  assert(bg15mFrom5mData("15m", entry) === undefined && bg15mFrom5mData("1m", undefined) === undefined, "15m view / 5m entry not loaded → undefined");
  // A ranged setQueryData splice replaces the 5m entry object → the memo input changes → re-derived.
  const spliced = { ...entry, candles: [...c5.slice(0, 9), ...c5.slice(9).map(c => ({ ...c, high: c.high + 50 }))] };
  const d15b = bg15mFrom5mData("5m", spliced)!;
  assert(d15b.candles[3].high === Math.max(...spliced.candles.slice(9).map(c => c.high)) && d15b.candles[0].high === d15!.candles[0].high,
    "a spliced 5m entry re-derives the affected 15m bucket only");
  assert(c5[11].high === 112, "derivation never mutates the shared 5m entry");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
