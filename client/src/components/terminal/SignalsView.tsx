// SignalsView.tsx — live signal stream from /api/signals/history (+ WS). SINGLE-TIER:
// tier filters dropped (filter is by SIDE). Adds AUTHOR mode (annotate / mark-bad,
// compatible with the engine's sp-annotations + /api/signals/label) and the LEARN button
// (POST /api/learn/backfill → /api/learn/run, with a toast). Click a row → SignalDetail
// (exit strategy + mini chart), shared with the chart-marker click on the Market tab.
import { useEffect, useMemo, useState } from "react";
import { C } from "./terminalStyles";
import { TierPill } from "./controls";
import { SignalDetail, statusColor } from "./SignalDetail";
import {
  mapSignal, dedupeSignals, etDateStr, etDayBounds,
  type TerminalSignal, type TerminalCandle, type SignalRow,
} from "@/hooks/useTerminalData";

type SideFilter = "All" | "LONG" | "SHORT";

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
  signals, candles, filter, setFilter, symbol, interval,
}: {
  signals: TerminalSignal[];
  candles: TerminalCandle[];
  filter: SideFilter;
  setFilter: (f: SideFilter) => void;
  symbol: string;
  interval: string;
}) {
  const [author, setAuthor] = useState(false);
  const [rthOnly, setRthOnly] = useState(false);
  const [annotations, setAnnotations] = useState<Record<string, Annotation>>(() => loadAnnotations());
  const [learnLoading, setLearnLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<TerminalSignal | null>(null);

  // ── Calendar: browse signals (and their mini charts) by day ──────────────────
  const todayStr = etDateStr();
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [daySignals, setDaySignals] = useState<TerminalSignal[]>([]);
  const [dayCandles, setDayCandles] = useState<TerminalCandle[]>([]);
  const isToday = selectedDate === todayStr;

  // Picking a date shows every signal from that date THROUGH the present (an open-ended range,
  // not a single day). Today uses the live props; a past date fetches signals + candles for the
  // whole [date → now] span.
  const rangeStart = useMemo(() => etDayBounds(selectedDate).start, [selectedDate]);
  useEffect(() => {
    if (isToday) { setDaySignals([]); setDayCandles([]); return; }
    const nowSec = Math.floor(Date.now() / 1000);
    let cancelled = false;
    fetch(`/api/signals/history/${encodeURIComponent(symbol)}/${interval}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const rows: SignalRow[] = Array.isArray(d?.signals) ? d.signals : [];
        setDaySignals(dedupeSignals(rows
          .filter((r) => r && Number.isFinite(r.entry) && r.timestamp >= rangeStart) // date → present
          .map(mapSignal).sort((a, b) => a.ts - b.ts), interval));
      })
      .catch(() => { if (!cancelled) setDaySignals([]); });
    fetch(`/api/data/cached-continuous/${encodeURIComponent(symbol)}/${interval}?from=${rangeStart - 6 * 3600}&to=${nowSec + 3600}`)
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
  }, [selectedDate, symbol, interval, isToday, rangeStart]);

  // Today → live feed from today's open; a past date → the fetched [date → now] range.
  const daySig = isToday ? signals.filter((s) => s.ts >= rangeStart) : daySignals;
  const miniCandles = isToday ? candles : dayCandles;

  const shiftDate = (deltaDays: number) => {
    const { start } = etDayBounds(selectedDate);
    setSelectedDate(etDateStr((start + deltaDays * 86400 + 12 * 3600) * 1000)); // noon ET avoids DST edges
  };

  // Annotation key matches the engine's SignalsPanel format: `${sym}-${time}-${Dir}-${iv}`
  const annKey = (s: TerminalSignal) => `${symbol}-${s.ts}-${s.side === "LONG" ? "Long" : "Short"}-${interval}`;

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
      await fetch("/api/learn/backfill", { method: "POST" });
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
  const wins = list.filter((s) => s.status === "TARGET" || s.status === "TP1 HIT").length;
  const losses = list.filter((s) => s.status === "STOPPED").length;
  const net = list.reduce((a, s) => a + (s.pnl || 0), 0);
  const activeCount = list.filter((s) => s.status === "ACTIVE").length;
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
  const sides: SideFilter[] = ["All", "LONG", "SHORT"];

  return (
    <div>
      <div className="tt-stat-grid">
        {[
          { l: isToday ? "SIGNALS TODAY" : "SIGNALS SINCE " + fmtEtDate(rangeStart).toUpperCase(), v: String(list.length), c: C.text },
          { l: "WIN RATE", v: winRate + "%", c: C.up },
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
          <div className="tt-thead">
            <span>DATE</span><span>TIME</span><span>SIDE</span><span>STRATEGY</span><span>TIER</span>
            <span className="r">ENTRY</span><span className="r">STOP</span><span className="r">TP1</span><span className="r">TP2</span>
            <span>{author ? "AUTHOR" : "STATUS"}</span><span className="r">P&amp;L</span>
          </div>
          <div key={filter + selectedDate} className="tt-tbody">
            {list.length === 0 && <div className="tt-empty-row">{isToday ? "no signals today" : "no signals in this range"}</div>}
            {list.map((s, i) => {
              const bad = annotations[annKey(s)]?.markedBad;
              return (
                <div key={s.id} className={"tt-trow clickable" + (bad ? " bad" : "")} style={{ animationDelay: i * 45 + "ms" }}
                  onClick={() => setSelected(s)} title="View details">
                  <span className="mono dim">{fmtEtDate(s.ts)}</span>
                  <span className="mono dim">{s.time}</span>
                  <span className="tt-side" style={{ color: s.side === "LONG" ? C.up : C.down }}>{s.side}</span>
                  <span>{s.strat}</span>
                  <span><TierPill tier={s.tier} /></span>
                  <span className="mono r">{s.entry.toFixed(2)}</span>
                  <span className="mono r down-t">{s.stop.toFixed(2)}</span>
                  <span className="mono r">{s.tp1.toFixed(2)}</span>
                  <span className="mono r">{s.tp2.toFixed(2)}</span>
                  {author ? (
                    <span>
                      <button className={"tt-bad-btn" + (bad ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggleBad(s); }}>
                        {bad ? "● Bad" : "Mark Bad"}
                      </button>
                    </span>
                  ) : (
                    <span className="tt-status" style={{ color: statusColor(s.status) }}>
                      {s.status === "ACTIVE" && <span className="tt-st-dot" />}{s.status}
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
      {selected && <SignalDetail signal={selected} candles={miniCandles} onClose={() => setSelected(null)} />}
    </div>
  );
}
