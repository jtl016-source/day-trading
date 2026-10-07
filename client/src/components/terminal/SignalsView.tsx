// SignalsView.tsx — live signal stream from /api/signals/history (+ WS). SINGLE-TIER:
// tier filters dropped (filter is by SIDE). Adds AUTHOR mode (annotate / mark-bad,
// compatible with the engine's sp-annotations + /api/signals/label) and the LEARN button
// (POST /api/learn/run over existing engine rows, with a toast — the retired backfill is gone).
// Click a row → SignalDetail (exit strategy + mini chart), shared with the chart-marker click
// on the Market tab.
import { useEffect, useMemo, useState } from "react";
import { C } from "./terminalStyles";
import { SignalDetail, statusColor, outcomeWords, AlertTagChips, useAlertTagContext } from "./SignalDetail";
import {
  mapSignal, etDateStr, etDayBounds,
  type TerminalSignal, type TerminalCandle, type SignalRow,
} from "@/hooks/useTerminalData";
import { isSessionLegalSignal } from "@shared/signal-rules";
import { displaySignalType, displayRiskFlag, COMBO_TIER_DISPLAY_SHORT, COMBO_TIER_DISPLAY, type ComboTier } from "@shared/signal-display";
import { useRiskComboStats, resolveComboRisk } from "@/lib/riskStats";

// 13-column grid (2026-07-30 risk display): DATE TIME IV SIDE TYPE WHY RISK ENTRY STOP TP1 TP2
// OUTCOME P&L. Inline override — the shared .tt-thead default stays 11-col for other views.
const SIG_GRID = "0.62fr 0.56fr 0.34fr 0.5fr 0.85fr 1.45fr 1.05fr 0.6fr 0.6fr 0.6fr 0.6fr 1.0fr 0.58fr";

// Tier chip color per track-record tier (display-only — mirrors shared/signal-display wording).
const TIER_COLOR: Record<ComboTier, string> = {
  proven: C.up, passing: C.accent, unproven: C.dim, weak: C.down,
};

/** RISK cell: compact tier chip + one-line track record + small warning badges, every element
 *  carrying a plain-English tooltip with the measured stats (2026-07-30 risk display). */
export function RiskCell({ comboKey, riskFlags, interval }: { comboKey: string | null; riskFlags: string[]; interval: string }) {
  const stats = useRiskComboStats();
  const risk = resolveComboRisk(comboKey, interval, stats);
  if (!risk && riskFlags.length === 0) return <span className="dim">—</span>;
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
        {risk && (
          <span
            title={`${COMBO_TIER_DISPLAY[risk.tier]} — ${risk.comboWords}. This exact setup: ${risk.trackRecord}${risk.scope === "all" ? " (all intervals pooled)" : ""}`}
            style={{
              fontSize: 8.5, letterSpacing: 0.5, fontWeight: 700, color: TIER_COLOR[risk.tier],
              border: `1px solid ${TIER_COLOR[risk.tier]}`, borderRadius: 4, padding: "0 4px", opacity: 0.95,
            }}>
            {COMBO_TIER_DISPLAY_SHORT[risk.tier]}
          </span>
        )}
        {riskFlags.map((f) => {
          const d = displayRiskFlag(f);
          return (
            <span key={f} title={`${d.label}: ${d.tooltip}`}
              style={{ fontSize: 8.5, color: "#e6b45a", border: "1px solid rgba(230,180,90,0.45)", borderRadius: 4, padding: "0 3px" }}>
              ⚠ {d.short}
            </span>
          );
        })}
      </span>
      {risk && (
        <span className="mono" style={{ fontSize: 9, color: C.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          title={`This exact setup: ${risk.trackRecord}`}>
          {risk.trackRecord}
        </span>
      )}
    </span>
  );
}

type SideFilter = "All" | "LONG" | "SHORT";

// INTERVAL PIN (2026-08-10, user request): browse another interval's signals WITHOUT touching
// the chart interval. null = follow the chart (the historical default behavior).
type IvPin = "1m" | "5m" | "15m" | "60m";
const IV_CHOICES: IvPin[] = ["1m", "5m", "15m", "60m"];

// Short ET date label for the DATE column, e.g. "Jun 8".
const _dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
function fmtEtDate(tsSec: number): string {
  return _dateFmt.format(new Date(tsSec * 1000));
}

// Resolve a signal that has NO recorded outcome (status "ACTIVE") by walking the candles AFTER
// its entry: did price reach TP/SL? This fixes the "still active even though it's done" bug —
// many older signals never had their outcome written back. Bars with a recorded outcome (or
// already EXPIRED) are trusted as-is. Candles must be ascending by time.
function resolveSignal(s: TerminalSignal, candles: TerminalCandle[]): TerminalSignal {
  if (s.status !== "ACTIVE") return s;
  const isLong = s.side === "LONG";
  // TP1-ONLY policy (2026-08-13): tp2 is null on all post-policy rows — the trade is DONE at
  // TP1 (resting limit + stop, OCO). NOTE the null must be handled explicitly: `c.h >= null`
  // coerces null→0 and would instantly fake a TARGET on every long.
  if (s.tp2 == null) {
    for (const c of candles) {
      if (c.time <= s.ts) continue;
      if (isLong) {
        if (c.l <= s.stop) return { ...s, status: "STOPPED", pnl: +(s.stop - s.entry).toFixed(2) };
        if (c.h >= s.tp1) return { ...s, status: "TARGET", pnl: +(s.tp1 - s.entry).toFixed(2) };
      } else {
        if (c.h >= s.stop) return { ...s, status: "STOPPED", pnl: +(s.entry - s.stop).toFixed(2) };
        if (c.l <= s.tp1) return { ...s, status: "TARGET", pnl: +(s.entry - s.tp1).toFixed(2) };
      }
    }
    return s;
  }
  // Legacy-convention rows (pre-policy, tp2 present) keep the old two-phase display walk.
  let tp1Hit = false;
  for (const c of candles) {
    if (c.time <= s.ts) continue; // outcome plays out on bars AFTER the entry bar
    if (isLong) {
      if (!tp1Hit && c.l <= s.stop) return { ...s, status: "STOPPED", pnl: +(s.stop - s.entry).toFixed(2) };
      if (c.h >= s.tp2) return { ...s, status: "TARGET", pnl: +(s.tp2 - s.entry).toFixed(2) };
      if (c.h >= s.tp1) tp1Hit = true;
    } else {
      if (!tp1Hit && c.h >= s.stop) return { ...s, status: "STOPPED", pnl: +(s.entry - s.stop).toFixed(2) };
      if (c.l <= s.tp2) return { ...s, status: "TARGET", pnl: +(s.entry - s.tp2).toFixed(2) };
      if (c.l <= s.tp1) tp1Hit = true;
    }
  }
  if (tp1Hit) return { ...s, status: "TP1 HIT", pnl: +((isLong ? s.tp1 - s.entry : s.entry - s.tp1)).toFixed(2) };
  return s; // genuinely still open — keep mapSignal's ACTIVE / EXPIRED
}

const _rthFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
function isRTHts(ts: number): boolean {
  const p = _rthFmt.formatToParts(new Date(ts * 1000));
  const wd = p.find((x) => x.type === "weekday")?.value ?? "";
  if (wd === "Sat" || wd === "Sun") return false;
  const h = parseInt(p.find((x) => x.type === "hour")?.value ?? "0", 10) % 24;
  const m = parseInt(p.find((x) => x.type === "minute")?.value ?? "0", 10);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 17 * 60; // 9:30 AM – 5:00 PM ET
}

interface Annotation { note?: string; markedBad: boolean; reason?: string; }

function loadAnnotations(): Record<string, Annotation> {
  try { return JSON.parse(localStorage.getItem("sp-annotations") ?? "{}"); } catch { return {}; }
}

export function SignalsView({
  signals, candles, filter, setFilter, symbol, interval, signalsResyncNonce = 0,
}: {
  signals: TerminalSignal[];
  candles: TerminalCandle[];
  filter: SideFilter;
  setFilter: (f: SideFilter) => void;
  symbol: string;
  interval: string;
  // RESYNC (2026-07-30): bumped by useTerminalData on a `signals_resync` WS broadcast (regen
  // --persist wipe+reinsert). Keys the date-browse fetch effect so a browsed past range reloads
  // too — the live (today) list rides the `signals` prop, which useTerminalData already refetches.
  signalsResyncNonce?: number;
}) {
  const [author, setAuthor] = useState(false);
  const [rthOnly, setRthOnly] = useState(false);
  // INTERVAL PIN: overrides which interval's signals this tab shows; the chart is untouched.
  const [ivPin, setIvPin] = useState<IvPin | null>(null);
  const iv = ivPin ?? interval;
  const [annotations, setAnnotations] = useState<Record<string, Annotation>>(() => loadAnnotations());
  const [learnLoading, setLearnLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<TerminalSignal | null>(null);
  const alertTagCtx = useAlertTagContext(); // 2026-10-01: one poller for every row's alert tags

  // ── Calendar: browse signals (and their mini charts) by day ──────────────────
  const todayStr = etDateStr();
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [daySignals, setDaySignals] = useState<TerminalSignal[]>([]);
  const [dayCandles, setDayCandles] = useState<TerminalCandle[]>([]);
  const isToday = selectedDate === todayStr;
  // Live props (signals/candles from useTerminalData) are CHART-interval data — they only serve
  // this tab when today is shown AND the pin matches the chart. Any other combination fetches.
  const followLive = isToday && iv === interval;
  // Pinned-to-today lists don't ride the WS stream (that's chart-interval only) — refresh them
  // on a light 60s poll so a pinned interval still shows new fires reasonably promptly.
  const [pollNonce, setPollNonce] = useState(0);
  useEffect(() => {
    if (followLive || !isToday) return;
    const t = window.setInterval(() => setPollNonce((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, [followLive, isToday]);

  // Picking a date shows every signal from that date THROUGH the present (an open-ended range,
  // not a single day). Today uses the live props; a past date fetches signals + candles for the
  // whole [date → now] span.
  const rangeStart = useMemo(() => etDayBounds(selectedDate).start, [selectedDate]);
  useEffect(() => {
    if (followLive) { setDaySignals([]); setDayCandles([]); return; }
    const nowSec = Math.floor(Date.now() / 1000);
    let cancelled = false;
    // PERF (2026-07-30): `since` mirrors the rangeStart filter below — the server pre-trims the
    // response (older servers ignore the param; the client filter stays as defense in depth).
    // INTERVAL PIN: `iv` (pinned interval or the chart's) drives BOTH fetches so the rows,
    // session checks and mini-chart candles stay one coherent interval.
    fetch(`/api/signals/history/${encodeURIComponent(symbol)}/${iv}?since=${Math.floor(rangeStart)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const rows: SignalRow[] = Array.isArray(d?.signals) ? d.signals : [];
        setDaySignals(rows
          .filter((r) => r && Number.isFinite(r.entry) && r.timestamp >= rangeStart) // date → present
          // SIGNAL-INTEGRITY (D1): the SAME shared rule validator as useTerminalData — the
          // date-browse list applies identical break/weekend/15:15/ETH-purity close-time checks,
          // so browsing a past day shows exactly the set the live chart would.
          .filter((r) => isSessionLegalSignal(r.timestamp, iv, r.signalType))
          .map(mapSignal).sort((a, b) => a.ts - b.ts));
        // (D2: cluster dedupe removed — every rule-compliant persisted signal shows.)
      })
      .catch(() => {
        if (cancelled) return;
        setDaySignals([]);
        // ONE-SHOT WEDGE FIX (2026-08-13, same class as the JournalView/LedgerView probe
        // lessons): a transient endpoint stall (server busy with a bulk write) used to blank
        // a browsed past range PERMANENTLY — the 60s poll only refreshes pinned-to-today.
        // One 4s retry heals it.
        window.setTimeout(() => { if (!cancelled) setPollNonce(n => n + 1); }, 4000);
      });
    fetch(`/api/data/cached-continuous/${encodeURIComponent(symbol)}/${iv}?from=${rangeStart - 6 * 3600}&to=${nowSec + 3600}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const raw = Array.isArray(d?.candles) ? d.candles : [];
        setDayCandles(raw
          .map((b: any) => ({ time: b.time, o: b.open, h: b.high, l: b.low, c: b.close }))
          .filter((b: TerminalCandle) => Number.isFinite(b.o) && Number.isFinite(b.c)));
      })
      .catch(() => { if (!cancelled) setDayCandles([]); });
    return () => { cancelled = true; };
    // signalsResyncNonce: not read in the body — it keys a refetch after a bulk signal_history
    // wipe+reinsert (signals_resync broadcast) so a browsed past range never shows wiped rows.
    // pollNonce: not read either — it keys the 60s pinned-to-today refresh (no WS for a pin).
  }, [selectedDate, symbol, iv, followLive, rangeStart, signalsResyncNonce, pollNonce]);

  // Follow-live → the chart-interval feed from today's open; anything else → the fetched range.
  const daySig = followLive ? signals.filter((s) => s.ts >= rangeStart) : daySignals;
  const miniCandles = followLive ? candles : dayCandles;

  const shiftDate = (deltaDays: number) => {
    const { start } = etDayBounds(selectedDate);
    setSelectedDate(etDateStr((start + deltaDays * 86400 + 12 * 3600) * 1000)); // noon ET avoids DST edges
  };

  // Annotation key matches the engine's SignalsPanel format: `${sym}-${time}-${Dir}-${iv}`
  // (uses the DISPLAYED interval so a pinned view annotates the rows it is actually showing).
  const annKey = (s: TerminalSignal) => `${symbol}-${s.ts}-${s.side === "LONG" ? "Long" : "Short"}-${iv}`;

  const toggleBad = (s: TerminalSignal) => {
    const key = annKey(s);
    const cur = annotations[key] ?? { markedBad: false };
    const next: Annotation = { ...cur, markedBad: !cur.markedBad };
    const map = { ...annotations, [key]: next };
    setAnnotations(map);
    try { localStorage.setItem("sp-annotations", JSON.stringify(map)); } catch { /* ignore */ }
    fetch("/api/signals/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key, time: s.ts, direction: s.side === "LONG" ? "Long" : "Short",
        riskLevel: "safe", outcome: null, isBad: next.markedBad, reason: "", note: next.note ?? "",
      }),
    }).catch(() => { /* localStorage is the source of truth on failure */ });
  };

  const runLearn = async () => {
    setLearnLoading(true);
    try {
      // (POST /api/learn/backfill REMOVED 2026-07-14 — SIGNAL-INTEGRITY A1: it regenerated
      //  retired-model signals. LEARN now runs only over existing engine-produced rows.)
      const res = await fetch("/api/learn/run", { method: "POST" });
      const data = await res.json();
      setToast(`Learned from ${data.signalCount ?? 0} signals (${((data.winRate ?? 0) * 100).toFixed(0)}% win rate)`);
      setTimeout(() => setToast(null), 4000);
    } catch {
      setToast("Learn failed — server error");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setLearnLoading(false);
    }
  };

  const list = daySig
    .filter((s) => filter === "All" || s.side === filter)
    .filter((s) => !rthOnly || isRTHts(s.ts))
    .map((s) => resolveSignal(s, miniCandles)); // fill in TP/SL outcomes the engine didn't record
  // Stats always reflect the currently filtered list (respects RTH, side, date).
  // WIN RATE mirrors the workbook's metricsOf: wins / CLOSED (session-end closes count in the
  // denominator, stop-outs and EOD both close a trade); NET POINTS sums realized P&L (the
  // persisted points_result when present) across every closed trade including EOD.
  const wins = list.filter((s) => s.status === "TARGET" || s.status === "TP1 HIT").length;
  const losses = list.filter((s) => s.status === "STOPPED").length;
  const eodCount = list.filter((s) => s.status === "EOD").length;
  const closed = wins + losses + eodCount;
  const net = list.reduce((a, s) => a + (s.pnl || 0), 0);
  const activeCount = list.filter((s) => s.status === "ACTIVE").length;
  const winRate = closed > 0 ? Math.round((wins / closed) * 100) : 0;
  const sides: SideFilter[] = ["All", "LONG", "SHORT"];

  return (
    <div>
      <div className="tt-stat-grid">
        {[
          { l: (isToday ? "SIGNALS TODAY" : "SIGNALS SINCE " + fmtEtDate(rangeStart).toUpperCase()) + (ivPin ? " · " + ivPin.toUpperCase() : ""), v: String(list.length), c: C.text },
          { l: `WIN RATE (${wins}W · ${losses}L · ${eodCount}E)`, v: winRate + "%", c: C.up },
          { l: "NET POINTS", v: (net >= 0 ? "+" : "") + net.toFixed(1), c: net >= 0 ? C.up : C.down },
          { l: "ACTIVE", v: String(activeCount), c: C.accent },
        ].map((s, i) => (
          <div key={i} className="tt-stat" style={{ animationDelay: i * 60 + "ms" }}>
            <span className="tt-corner tl" /><span className="tt-corner br" />
            <div className="tt-stat-l">{s.l}</div>
            <div className="tt-stat-v" style={{ color: s.c }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div className="tt-sig-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div className="tt-filters">
            {sides.map((f) => (
              <button key={f} onClick={() => setFilter(f)} className="tt-filter"
                style={f === filter ? { color: C.bg, background: C.accent, borderColor: C.accent } : undefined}>
                {f}
              </button>
            ))}
            <button className="tt-filter" onClick={() => setRthOnly((v) => !v)}
              style={rthOnly ? { color: C.bg, background: C.accent, borderColor: C.accent } : undefined}
              title="Show RTH signals only (9:30–16:00 ET)">
              RTH
            </button>
          </div>
          {/* INTERVAL PIN — browse another interval's signals without changing the chart */}
          <div className="tt-filters" title="Which interval's signals to list — the chart keeps its own interval">
            <button className="tt-filter" onClick={() => setIvPin(null)}
              style={ivPin === null ? { color: C.bg, background: C.accent, borderColor: C.accent } : undefined}
              title={`Follow the chart's interval (currently ${interval})`}>
              CHART
            </button>
            {IV_CHOICES.map((v) => (
              <button key={v} onClick={() => setIvPin(v)} className="tt-filter"
                style={ivPin === v ? { color: C.bg, background: C.accent, borderColor: C.accent } : undefined}
                title={`Show ${v} signals without changing the chart`}>
                {v}
              </button>
            ))}
          </div>
          {/* Calendar — browse signals by day */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button className="tt-filter" onClick={() => shiftDate(-1)} title="Previous day" style={{ padding: "7px 11px" }}>‹</button>
            <input
              type="date" value={selectedDate} max={todayStr}
              onChange={(e) => { if (e.target.value) setSelectedDate(e.target.value); }}
              title="Pick a start date — shows every signal from that date through today"
              style={{
                background: "rgba(255,255,255,0.03)", color: C.text, border: `1px solid ${C.line}`,
                borderRadius: 8, padding: "6px 10px", fontFamily: "var(--fm)", fontSize: 11, colorScheme: "dark",
              }}
            />
            <button className="tt-filter" onClick={() => shiftDate(1)} disabled={isToday} title="Next day"
              style={{ padding: "7px 11px", opacity: isToday ? 0.4 : 1, cursor: isToday ? "not-allowed" : "pointer" }}>›</button>
            {!isToday && <button className="tt-filter" onClick={() => setSelectedDate(todayStr)} title="Jump to today">Today</button>}
          </div>
        </div>
        <div className="tt-sig-actions">
          <button className={"tt-author-btn" + (author ? " on" : "")} onClick={() => setAuthor((v) => !v)} title="Author mode — annotate signals">
            ✏ {author ? "Author ON" : "Author"}
          </button>
          <button className="tt-learn-btn" onClick={runLearn} disabled={learnLoading}>
            🎓 {learnLoading ? "Learning…" : "Learn"}
          </button>
        </div>
      </div>

      <div className="tt-table-wrap">
        <div className="tt-table">
          <div className="tt-thead" style={{ gridTemplateColumns: SIG_GRID }}>
            <span>DATE</span><span>TIME ET</span><span>IV</span><span>SIDE</span><span>SIGNAL TYPE</span><span>WHY IT FIRED</span>
            <span title="The setup's track record (held-out walk-forward stats) + situational warnings — hover any chip for the measured numbers">RISK</span>
            <span className="r">ENTRY</span><span className="r">STOP</span><span className="r">TP1</span><span className="r">TP2</span>
            <span>{author ? "AUTHOR" : "OUTCOME"}</span><span className="r">P&amp;L PTS</span>
          </div>
          <div key={filter + selectedDate + iv} className="tt-tbody">
            {list.length === 0 && <div className="tt-empty-row">{isToday ? "no signals today" : "no signals in this range"}</div>}
            {list.map((s, i) => {
              const bad = annotations[annKey(s)]?.markedBad;
              return (
                <div key={s.id} className={"tt-trow clickable" + (bad ? " bad" : "")}
                  style={{ animationDelay: i * 45 + "ms", gridTemplateColumns: SIG_GRID }}
                  onClick={() => setSelected(s)} title="View details">
                  <span className="mono dim">{fmtEtDate(s.ts)}</span>
                  <span className="mono dim">
                    {s.time}
                    {/* LATE-SIGNAL FAILSAFE (2026-08-11): back-filled rows are visibly labeled —
                        a signal inserted after the fact can never masquerade as a live fire.
                        2026-10-07: also the days the computer was off (missed-day catch-up); the
                        session date = Globex session day (+6 h maps 18:00–23:59 ET to the next day). */}
                    {s.source === "catchup" && (
                      <span
                        title={`BACKFILLED — session ${fmtEtDate(s.ts + 6 * 3600)}: nothing recorded this fire at the time (no live tab or server pass ran, or the computer was off); the catch-up replay reconstructed it from healed bars when the program came back (engine-endorsed, source=catchup). It appeared in this list when that pass ran, not at its fire time.`}
                        style={{ marginLeft: 4, fontSize: 8, fontWeight: 700, letterSpacing: 0.4, color: "#e6b45a", border: "1px solid rgba(230,180,90,0.45)", borderRadius: 4, padding: "0 3px", verticalAlign: "middle" }}>
                        BF
                      </span>
                    )}
                  </span>
                  <span className="mono dim">{iv}</span>
                  <span className="tt-side" style={{ color: s.side === "LONG" ? C.up : C.down }}>{s.side}</span>
                  <span style={{ fontSize: 11, display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
                    {displaySignalType(s.signalType, true)}
                    {/* ALERT TAGS (2026-10-01 R2a/R3): ETH fires are record-only while overnight
                        alerts are muted; news-blackout fires were not alerted nor ordered. */}
                    <AlertTagChips ts={s.ts} interval={iv} ctx={alertTagCtx} />
                  </span>
                  <span style={{ fontSize: 11 }}>{s.strat}</span>
                  <RiskCell comboKey={s.comboKey} riskFlags={s.riskFlags} interval={iv} />
                  <span className="mono r">{s.entry.toFixed(2)}</span>
                  <span className="mono r down-t">{s.stop.toFixed(2)}</span>
                  <span className="mono r">{s.tp1.toFixed(2)}</span>
                  {/* TP1-ONLY (2026-08-13): tp2 null on all post-policy rows */}
                  <span className="mono r dim">{s.tp2 != null ? s.tp2.toFixed(2) : "—"}</span>
                  {author ? (
                    <span>
                      <button className={"tt-bad-btn" + (bad ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggleBad(s); }}>
                        {bad ? "● Bad" : "Mark Bad"}
                      </button>
                    </span>
                  ) : (
                    <span className="tt-status" style={{ color: statusColor(s.status), fontSize: 10 }}>
                      {s.status === "ACTIVE" && <span className="tt-st-dot" />}{outcomeWords(s)}
                    </span>
                  )}
                  <span className="mono r" style={{ color: s.pnl == null ? C.dim : s.pnl >= 0 ? C.up : C.down }}>
                    {s.pnl == null ? "—" : (s.pnl >= 0 ? "+" : "") + s.pnl.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {toast && <div className="tt-toast">{toast}</div>}
      {selected && <SignalDetail signal={selected} candles={miniCandles} onClose={() => setSelected(null)} interval={iv} />}
    </div>
  );
}
