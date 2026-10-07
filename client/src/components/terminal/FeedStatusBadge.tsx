// FeedStatusBadge — small amber "DELAYED FEED" pill in the terminal header while the server
// is on the Yahoo 1m live-poll fallback (no MotiveWave study connected; candles ~1min behind).
//
// Self-contained on purpose: polls GET /api/mw/sync-status (feed_status provenance field from
// server/yahoo-live.ts) on its own 30s timer — deliberately NOT wired through useTerminalData
// (file ownership: the header owns feed provenance; useTerminalData owns candles/signals).
// Renders nothing when feed_status is "mw-live" (MW authoritative) — the MarketView LIVE badge
// already covers that state. "stale" renders a red variant so a dead feed is never silent.
//
// CONTRACT GUARD (2026-09-17): `contractGuard.offContract` (server/contract-guard.ts) means the
// MotiveWave chart is on a different contract month than Yahoo's front month (the Sep/Dec roll
// interleave). That state outranks the others — red pill with the measured offset and the
// action (roll the MW chart); MW is quarantined, Yahoo drives, auto-trade orders are blocked.
import { useEffect, useState } from "react";

type FeedStatus = "mw-live" | "yahoo-fallback" | "stale";
interface ContractGuard {
  offContract: boolean; delta: number | null; since: number | null;
  mwLast?: { close: number } | null; yahooLast?: { close: number } | null;
  mwContract?: string | null; rollPending?: boolean; mixedMonths?: boolean;
  translation?: { active: boolean; offsetPts: number } | null;
}

export function FeedStatusBadge() {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [detail, setDetail] = useState<string>("");
  const [guard, setGuard] = useState<ContractGuard | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      fetch("/api/mw/sync-status")
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!alive || !d?.feed_status) return;
          setStatus(d.feed_status as FeedStatus);
          setGuard(d.contractGuard && typeof d.contractGuard.offContract === "boolean" ? d.contractGuard as ContractGuard : null);
          // (The 30 s poll is the badge's only input on purpose — the WS contract_guard message
          //  belongs to useTerminalData; worst case the pill lags a regime change by one poll.)
          const yl = d.yahooLive;
          setDetail(yl
            ? `Yahoo 1m fallback — cycles ${yl.cycles ?? 0}, last OK ${yl.lastOkAgeSec ?? "?"}s ago, +${yl.totalInserted ?? 0} bars this run${yl.lastError ? `, last error: ${yl.lastError}` : ""}`
            : "");
        })
        .catch(() => { /* transient — keep last known state */ });
    };
    poll();
    const id = window.setInterval(poll, 30_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // MIXED MONTHS (2026-09-18): MotiveWave tick relays on two contract months at once (charts
  // rolled one at a time) — no offset can fix an interleaved stream, so MW is quarantined
  // entirely until every chart is on one month. Rendered like off-contract, own wording.
  const mixed = guard?.mixedMonths === true;
  const offContract = guard?.offContract === true || mixed;
  if (!offContract && status !== "yahoo-fallback" && status !== "stale") return null;
  const amber = !offContract && status === "yahoo-fallback";
  const deltaTxt = guard?.delta == null ? "?" : `${guard.delta > 0 ? "+" : ""}${guard.delta.toFixed(2)}`;
  // TICK TRANSLATION (2026-09-17): while off-contract the chart normally stays tick-live on
  // MW ticks shifted by the measured spread; only while a chart roll awaits confirmation does
  // the (10-min-delayed) Yahoo poll drive — say which, so "laggy" is never a mystery.
  const translating = offContract && guard?.translation?.active === true;
  const label = mixed
    ? "MW CHARTS ON MIXED MONTHS · YAHOO DRIVING (10-MIN DELAYED)"
    : offContract
    ? `MW OFF-CONTRACT${guard?.mwContract ? ` (${guard.mwContract})` : ""} · Δ ${deltaTxt} · ${translating ? "LIVE TICKS CORRECTED" : guard?.rollPending ? "ROLL PENDING · YAHOO (10-MIN DELAYED)" : "YAHOO DRIVING (10-MIN DELAYED)"}`
    : amber ? "DELAYED FEED (Yahoo ~1min)" : "FEED STALE";
  const title = mixed
    ? `MotiveWave's tick relays are on two different contract months at once — roll EVERY MotiveWave chart (and the AutoTrader chart) to the same front month. Until then MW is ignored, the 10-min-delayed Yahoo feed drives the chart, nothing MW sends is stored and AUTO-TRADE ORDERS ARE BLOCKED. ${detail}`
    : offContract
    ? `MotiveWave's chart is on a different contract month than Yahoo's front month (MW ${guard?.mwLast?.close ?? "?"} vs Yahoo ${guard?.yahooLast?.close ?? "?"}, Δ ${deltaTxt} pts${guard?.since ? `, since ${new Date(guard.since * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })} ET` : ""}). ${translating
        ? `The chart stays live on MotiveWave ticks shifted by ${guard?.translation?.offsetPts ?? "?"} pts onto the front month; Yahoo's real (10-min-delayed) bars replace them as they arrive.`
        : guard?.rollPending
          ? "The MotiveWave chart was just rolled — waiting for a few closed minutes to confirm it matches Yahoo; the delayed Yahoo feed drives meanwhile."
          : "No trusted offset yet — the 10-min-delayed Yahoo feed drives the chart."} MW bars are never stored while off-contract and AUTO-TRADE ORDERS ARE BLOCKED. Roll the MotiveWave chart to the front month — MW resumes automatically once it agrees with Yahoo. ${detail}`
    : amber
      ? `No MotiveWave connection — candles come from Yahoo's delayed 1m feed. ${detail}`
      : `No MotiveWave connection and the Yahoo fallback is not delivering. ${detail}`;
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        marginLeft: 8,
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.06em",
        whiteSpace: "nowrap",
        color: amber ? "#f5b942" : "#f26d6d",
        border: `1px solid ${amber ? "rgba(245,185,66,0.55)" : "rgba(242,109,109,0.55)"}`,
        background: amber ? "rgba(245,185,66,0.10)" : "rgba(242,109,109,0.10)",
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: amber ? "#f5b942" : "#f26d6d",
        boxShadow: `0 0 6px ${amber ? "rgba(245,185,66,0.8)" : "rgba(242,109,109,0.8)"}`,
      }} />
      {label}
    </span>
  );
}
