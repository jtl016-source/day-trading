// ThoughtsPanel.tsx — "THOUGHTS" floating panel (2026-08-12, user request: a live narration of
// what the system is thinking THIS candle: trend read, long/short proximity, zone behavior,
// dead-tape state, risk posture).
//
// DISPLAY NARRATION ONLY — this panel derives plain-English reads from the SAME shared data
// the engine consumes (vector via @shared/firing/vector, dead-tape constants via
// @shared/fact-engine, day-zones / close-estimate / combo-stats endpoints). It re-implements
// NO firing logic and its "lean" lines are hedged proximity descriptions — the engine's gates
// decide, not this panel (footer says so on-screen).
//
// Mechanics: exact MarketView HUD idiom — createPortal(document.body), drag anywhere,
// bottom-right resize grip, double-click reset, ✕ → persisted restore chip
// (localStorage meridian_thoughts_box).
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { C } from "./terminalStyles";
import { marketSession } from "./Clock";
import { useRiskComboStats } from "@/lib/riskStats";
import type { TerminalCandle, TerminalSignal } from "@/hooks/useTerminalData";
import { computeVectorLine } from "@shared/firing/vector";
import { DEAD_TAPE_SUPPRESS_MULT, DEAD_TAPE_DIR_EXEMPT, DAILY_LOSS_STOP_DEFAULT_PTS, FACT_ENGINE_DEFAULTS } from "@shared/fact-engine";

const BOX_KEY = "meridian_thoughts_box";
interface Box { x: number; y: number; w: number; h: number | null; hidden?: boolean }
const DEFAULT_BOX: Box = { x: 24, y: 340, w: 330, h: null };
/** OFF-SCREEN RECOVERY (2026-08-12 user report "the popup is gone"): a position saved on a
 *  wider/taller viewport (desktop, or the phone rotated) can sit entirely beyond the current
 *  screen — drag-time clamping never re-runs on load. Clamp whenever the box is read or the
 *  viewport changes, so the panel (and its restore chip) can never be stranded. */
function clampBox(b: Box): Box {
  const maxX = Math.max(0, window.innerWidth - 90);
  const maxY = Math.max(44, window.innerHeight - 70);
  return { ...b, x: Math.min(Math.max(0, b.x), maxX), y: Math.min(Math.max(44, b.y), maxY) };
}
function loadBox(): Box {
  try { const r = localStorage.getItem(BOX_KEY); if (r) return clampBox({ ...DEFAULT_BOX, ...JSON.parse(r) }); } catch { /* ignore */ }
  return clampBox(DEFAULT_BOX);
}

const IV_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };

/** Most recent 18:00 ET Globex session start ≤ now (DST-safe via Intl parts). */
function sessionStartSec(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const sinceMidnight = g("hour") * 3600 + g("minute") * 60 + g("second");
  const midnight = Math.floor(Date.now() / 1000) - sinceMidnight;
  return sinceMidnight >= 18 * 3600 ? midnight + 18 * 3600 : midnight - 6 * 3600;
}

interface YbDay {
  sessionStartTs: number; sessionEndTs: number;
  boxTop: number; boxBottom: number; initRes: number; initSup: number;
}
interface CloseEst {
  adjHigh: number; adjLow: number;
  day: { hod: number; lod: number; estCloseHigh: number; estCloseLow: number };
}

interface Thought { label: string; text: string; tone?: "up" | "down" | "warn" | "dim" }

export function ThoughtsPanel({
  symbol, candles, lastPrice, interval, signals,
}: {
  symbol: string;
  candles: TerminalCandle[];
  lastPrice: number | null;
  interval: string;
  signals: TerminalSignal[];
}) {
  const [box, setBox] = useState<Box>(loadBox);
  const boxRef = useRef(box); boxRef.current = box;
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(BOX_KEY, JSON.stringify(box)); } catch { /* ignore */ } }, [box]);
  // Re-clamp on rotation/resize so an open panel can never leave the screen.
  useEffect(() => {
    const onResize = () => setBox((b) => clampBox(b));
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("orientationchange", onResize); };
  }, []);

  // 1s heartbeat for the candle countdown (everything else recomputes on data changes).
  const [, setTick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setTick((v) => v + 1), 1000); return () => window.clearInterval(t); }, []);

  // ── Self-contained data (LedgerView precedent): day-zones 5-min, close-est 3-min ──
  const [yb, setYb] = useState<YbDay | null>(null);
  const [est, setEst] = useState<CloseEst | null>(null);
  const stats = useRiskComboStats(); // cached shared fetch — medianDayRange (dead-tape baseline)
  useEffect(() => {
    let gone = false;
    const pull = () => {
      const now = Math.floor(Date.now() / 1000);
      fetch(`/api/yellowbox/day-zones?symbol=${encodeURIComponent(symbol)}&fromTs=${now - 2 * 86400}&toTs=${now + 86400}`)
        .then((r) => r.json())
        .then((d) => {
          if (gone || !Array.isArray(d?.days)) return;
          const cur = (d.days as YbDay[]).find((z) => now >= z.sessionStartTs && now <= z.sessionEndTs) ?? null;
          setYb(cur);
        })
        .catch(() => { /* narration simply omits the zone section */ });
      fetch(`/api/close-estimate?symbol=${encodeURIComponent(symbol)}`)
        .then((r) => r.json())
        .then((d) => { if (!gone && d && d.day) setEst(d as CloseEst); })
        .catch(() => { /* omit */ });
    };
    pull();
    const t = window.setInterval(pull, 180_000);
    return () => { gone = true; window.clearInterval(t); };
  }, [symbol]);

  // ── The narration (pure derivation — recomputes when the data moves) ──
  const thoughts = useMemo<Thought[]>(() => {
    const out: Thought[] = [];
    const n = candles.length;
    if (!n) return [{ label: "DATA", text: "waiting for candles…", tone: "dim" }];
    const px = lastPrice ?? candles[n - 1].c;
    const ivSec = IV_SEC[interval] ?? 300;
    const nowSec = Math.floor(Date.now() / 1000);

    // CANDLE — forming bar + countdown to its close.
    const bar = candles[n - 1];
    const secsLeft = Math.max(0, bar.time + ivSec - nowSec);
    out.push({
      label: "CANDLE",
      text: `${interval} bar closes in ${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")} — O ${bar.o.toFixed(2)} H ${bar.h.toFixed(2)} L ${bar.l.toFixed(2)} now ${px.toFixed(2)} (${marketSession()})`,
    });

    // TREND — price vs the shared vector line + vector slope + 20-bar net drift.
    // (TerminalCandle {o,h,l,c} → FiringCandle {open,high,low,close} for the shared vector.)
    const tail = candles.slice(-400);
    const vec = computeVectorLine(tail.map((c) => ({ time: c.time, open: c.o, high: c.h, low: c.l, close: c.c })));
    const vNow = vec.length ? vec[vec.length - 1].value : null;
    const vPrev = vec.length > 20 ? vec[vec.length - 21].value : null;
    if (vNow != null) {
      const d = px - vNow;
      const slope = vPrev != null ? vNow - vPrev : 0;
      const net20 = tail.length > 20 ? px - tail[tail.length - 21].c : 0;
      const above = d >= 0;
      const agree = above === net20 >= 0 && Math.abs(net20) > Math.abs(d) * 0.25;
      const lean = Math.abs(d) < 1 ? "No edge — price straddling the vector"
        : `${above ? "Bullish" : "Bearish"} lean — ${Math.abs(d).toFixed(1)} pts ${above ? "above" : "below"} the vector${slope !== 0 ? `, vector ${slope > 0 ? "rising" : "falling"}` : ""}${agree ? `, drift agrees (${net20 >= 0 ? "+" : ""}${net20.toFixed(1)}/20 bars)` : `, but drift ${net20 >= 0 ? "+" : ""}${net20.toFixed(1)}/20 bars disagrees`}`;
      out.push({ label: "TREND", text: lean, tone: Math.abs(d) < 1 ? "dim" : above ? "up" : "down" });
    }

    // TAPE — the engine's dead-tape rule verbatim (shared constant × served median).
    const ssStart = sessionStartSec();
    let sHi = -Infinity, sLo = Infinity, sOpen: number | null = null, clearedAt: number | null = null;
    const median = stats?.medianDayRange ?? null;
    const thr = median != null ? DEAD_TAPE_SUPPRESS_MULT * median : null;
    for (let i = n - 1; i >= 0 && candles[i].time >= ssStart; i--) { /* find session slice start */ if (i === 0 || candles[i - 1].time < ssStart) { sOpen = candles[i].o; for (let j = i; j < n; j++) { sHi = Math.max(sHi, candles[j].h); sLo = Math.min(sLo, candles[j].l); if (clearedAt == null && thr != null && sHi - sLo >= thr) clearedAt = candles[j].time; } break; } }
    const range = sHi > sLo ? sHi - sLo : 0;
    if (thr != null) {
      const drift = sOpen != null ? Math.abs(px - sOpen) : 0;
      const dirExempt = range > 0 && drift >= DEAD_TAPE_DIR_EXEMPT * range;
      if (range >= thr) {
        const t = clearedAt != null ? new Date(clearedAt * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }) : "?";
        out.push({ label: "TAPE", text: `ACTIVE — range ${range.toFixed(1)} cleared the ${thr.toFixed(1)} dead-tape bar at ${t} ET. Signals are live.`, tone: "up" });
      } else if (dirExempt) {
        // DIRECTIONALITY EXEMPTION (2026-08-12): quiet but going somewhere — signals allowed.
        out.push({ label: "TAPE", text: `QUIET-TRENDING — range ${range.toFixed(1)} is under the ${thr.toFixed(1)} bar, but drift ${drift.toFixed(1)} ≥ ${DEAD_TAPE_DIR_EXEMPT}× range: the drift exemption is ACTIVE, signals allowed.`, tone: "up" });
      } else {
        const needDrift = range > 0 ? (DEAD_TAPE_DIR_EXEMPT * range - drift).toFixed(1) : "—";
        out.push({ label: "TAPE", text: `DEAD — range ${range.toFixed(1)} of ${thr.toFixed(1)} needed AND drift ${drift.toFixed(1)} short of the ${DEAD_TAPE_DIR_EXEMPT}× exemption by ${needDrift}. Nothing fires until either clears.`, tone: "warn" });
      }
    }

    // ZONES — today's Yellow Box behavior (position + touch/hold reads on the session slice).
    if (yb) {
      const sess = candles.filter((c) => c.time >= ssStart);
      const touches = (level: number) => sess.filter((c) => c.h >= level && c.l <= level).length;
      const pos = px > yb.boxTop ? `ABOVE the box (top ${yb.boxTop.toFixed(2)})` : px < yb.boxBottom ? `BELOW the box (bottom ${yb.boxBottom.toFixed(2)})` : `INSIDE the box (${yb.boxBottom.toFixed(2)}–${yb.boxTop.toFixed(2)})`;
      const resT = touches(yb.initRes), supT = touches(yb.initSup);
      const resState = resT === 0 ? "untested" : px > yb.initRes ? `${resT} touch(es), BROKEN — now overhead support?` : `${resT} touch(es), holding`;
      const supState = supT === 0 ? "untested" : px < yb.initSup ? `${supT} touch(es), BROKEN` : `${supT} touch(es), holding`;
      out.push({ label: "ZONES", text: `${pos}. initRes ${yb.initRes.toFixed(2)}: ${resState}. initSup ${yb.initSup.toFixed(2)}: ${supState}.` });
    }

    // EST CLOSE — the close-magnet band (Fractal Exchange method) + the tight-band quality read.
    if (est?.day) {
      const lo = Math.min(est.day.estCloseLow, est.day.estCloseHigh), hi = Math.max(est.day.estCloseLow, est.day.estCloseHigh);
      const w = hi - lo;
      const rel = px < lo ? `${(lo - px).toFixed(1)} below the band — magnet OVERHEAD` : px > hi ? `${(px - hi).toFixed(1)} above the band — magnet BELOW` : "inside the band";
      out.push({ label: "EST CL", text: `band ${lo.toFixed(2)}–${hi.toFixed(2)} (${w <= 10 ? "TIGHT — quality condition" : `wide ${w.toFixed(1)}`}); price ${rel}.` });
    }

    // LEAN — hedged proximity reads. NEVER a promise; the gates decide.
    const leans: string[] = [];
    const dirVotes = { long: 0, short: 0 };
    const tapeBlocked = thr != null && range < thr
      && !(sOpen != null && range > 0 && Math.abs(px - sOpen) >= DEAD_TAPE_DIR_EXEMPT * range);
    if (tapeBlocked) {
      leans.push("No trade likely — tape is dead AND directionless; everything is suppressed regardless of setup.");
    } else {
      if (yb) {
        if (px < yb.initRes && yb.initRes - px <= 3) { leans.push(`Pressing initRes from below — a ${interval} close above ${yb.initRes.toFixed(2)} would put a yellowbox-break LONG in front of the gate.`); dirVotes.long++; }
        if (px > yb.initSup && px - yb.initSup <= 3) { leans.push(`Sitting on initSup — a close below ${yb.initSup.toFixed(2)} would put a break SHORT in front of the gate.`); dirVotes.short++; }
        if (px > yb.boxTop && px - yb.boxTop <= 2) { leans.push("Hovering just above the box top — holding here keeps the upside break alive; losing it puts price back in chop."); dirVotes.long++; }
      }
      if (vNow != null) {
        const lastFew = candles.slice(-4);
        const crossedUp = lastFew.length >= 2 && lastFew[0].c < vNow && px > vNow;
        const crossedDn = lastFew.length >= 2 && lastFew[0].c > vNow && px < vNow;
        if (crossedUp) { leans.push("Fresh vector reclaim — a side-entry LONG is forming if price holds above."); dirVotes.long++; }
        if (crossedDn) { leans.push("Fresh vector loss — a side-entry SHORT is forming if price stays below."); dirVotes.short++; }
      }
      if (est?.day) {
        const lo = Math.min(est.day.estCloseLow, est.day.estCloseHigh), hi = Math.max(est.day.estCloseLow, est.day.estCloseHigh);
        if (px < lo - 5) { leans.push("Close-magnet sits overhead — reversion pressure favors longs into the band."); dirVotes.long++; }
        else if (px > hi + 5) { leans.push("Close-magnet sits below — reversion pressure favors shorts into the band."); dirVotes.short++; }
      }
      const ivSignals = signals.filter((s) => s.ts >= ssStart);
      const lastSig = ivSignals.length ? ivSignals[ivSignals.length - 1] : null;
      if (lastSig) {
        const barsSince = Math.floor((nowSec - lastSig.ts) / ivSec);
        const cd = FACT_ENGINE_DEFAULTS.COOLDOWN_BARS;
        if (barsSince < cd) leans.push(`Cooldown: ${cd - barsSince} bar(s) left after the ${lastSig.time} ${lastSig.side} — no re-fire before that.`);
      }
      if (!leans.length) leans.push("Nothing close — no setup structure within reach of this candle.");
    }
    const dir = dirVotes.long > dirVotes.short ? "If anything fires next, LONG is the closer setup." : dirVotes.short > dirVotes.long ? "If anything fires next, SHORT is the closer setup." : null;
    out.push({ label: "LEAN", text: leans.join(" ") + (dir ? ` ${dir}` : ""), tone: dirVotes.long > dirVotes.short ? "up" : dirVotes.short > dirVotes.long ? "down" : undefined });

    // RISK — today's realized signal P&L vs the daily loss stop.
    const todays = signals.filter((s) => s.ts >= ssStart);
    const closedPnl = todays.reduce((a, s) => a + (s.pnl ?? 0), 0);
    const openN = todays.filter((s) => s.status === "ACTIVE").length;
    out.push({
      label: "RISK",
      text: `day P&L ${closedPnl >= 0 ? "+" : ""}${closedPnl.toFixed(1)} pts (no engine loss stop — removed 2026-08-17, account limits govern); ${todays.length} signal(s) today, ${openN} open.`,
      tone: closedPnl <= -DAILY_LOSS_STOP_DEFAULT_PTS * 0.6 ? "warn" : undefined, // heavy-day flag at the retired stop's 60%
    });
    return out;
  }, [candles, lastPrice, interval, signals, yb, est, stats]);

  // ── HUD drag/resize/restore mechanics (MarketView idiom, verbatim) ──
  if (box.hidden) {
    return createPortal(
      <button
        onClick={() => setBox((b) => ({ ...b, hidden: false }))}
        title="Show thoughts panel"
        style={{
          position: "fixed", left: box.x, top: box.y, zIndex: 6, display: "flex", alignItems: "center", gap: 6,
          background: "rgba(8,10,16,0.86)", border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px",
          color: C.accent, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600,
          letterSpacing: 1, cursor: "pointer", backdropFilter: "blur(10px)",
        }}
      >
        💭 THOUGHTS
      </button>,
      document.body,
    );
  }
  const beginDrag = (mode: "move" | "resize", e: React.PointerEvent) => {
    e.preventDefault();
    const el = elRef.current;
    const startW = el?.offsetWidth ?? boxRef.current.w;
    const startH = el?.offsetHeight ?? 220;
    const sx = e.clientX, sy = e.clientY, o = { ...boxRef.current };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (mode === "move") setBox((b) => ({ ...b, x: Math.min(Math.max(0, o.x + dx), window.innerWidth - 80), y: Math.min(Math.max(44, o.y + dy), window.innerHeight - 50) }));
      else setBox((b) => ({ ...b, w: Math.max(260, Math.min(startW + dx, window.innerWidth - 20)), h: Math.max(140, startH + dy) }));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.userSelect = ""; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.userSelect = "none";
  };
  const tone = (t?: Thought["tone"]) => t === "up" ? C.up : t === "down" ? C.down : t === "warn" ? "#e6b45a" : t === "dim" ? C.dim : C.muted;

  return createPortal(
    <div
      ref={elRef}
      className="tt-hud"
      onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button,a,input,select,.tt-hud-resize")) return; beginDrag("move", e); }}
      onDoubleClick={(e) => { if ((e.target as HTMLElement).closest("button,a,input,select,.tt-hud-resize")) return; setBox(DEFAULT_BOX); }}
      style={{
        position: "fixed", left: box.x, top: box.y, width: box.w, maxWidth: "none",
        ...(box.h ? { height: box.h, overflowY: "auto" } : {}), zIndex: 6, cursor: "grab",
        background: "rgba(8,10,16,0.92)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ color: C.accent, fontSize: 11, fontWeight: 700, letterSpacing: 1.2 }}>💭 THOUGHTS · {symbol} {interval}</span>
        <button
          className="tt-hud-close"
          onClick={() => setBox((b) => ({ ...b, hidden: true }))}
          title="Hide (a chip remains to bring it back)"
          style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 13, lineHeight: 1 }}
        >✕</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {thoughts.map((t, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span className="mono" style={{ color: C.dim, fontSize: 9, letterSpacing: 0.6, minWidth: 44, flexShrink: 0 }}>{t.label}</span>
            <span style={{ color: tone(t.tone), fontSize: 11, lineHeight: 1.45 }}>{t.text}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 7, paddingTop: 5, borderTop: `1px solid ${C.lineSoft}`, color: C.dim, fontSize: 9, lineHeight: 1.4 }}>
        Display narration only — signals come from the engine's gates (quality gate, combo verdicts, dead-tape, loss stop), not this panel.
      </div>
      <div className="tt-hud-resize" onPointerDown={(e) => { e.stopPropagation(); beginDrag("resize", e); }} />
    </div>,
    document.body,
  );
}
