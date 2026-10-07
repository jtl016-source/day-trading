// MarketView.tsx — now ONLY the floating market-head HUD (symbol / price / change / hi /
// lo / ATR-14) + the active-strategies strip. The chart itself is the full-screen
// background (TerminalLiveChart), so this panel floats over it. All numbers are derived
// from REAL candles.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { C } from "./terminalStyles";
import { Ico } from "./icons";
import { STRATS } from "./strategyMeta";
import { marketSession } from "./Clock";
import type { TerminalCandle, TerminalGuard } from "@/hooks/useTerminalData";
import type { StrategyToggles } from "@/lib/terminalSettings";

// Persisted position + size of the floating market HUD (drag to move, corner to resize).
const HUD_BOX_KEY = "meridian_hud_box";
interface HudBox { x: number; y: number; w: number; h: number | null; hidden?: boolean }
const DEFAULT_HUD_BOX: HudBox = { x: 240, y: 96, w: 560, h: null };
/** OFF-SCREEN RECOVERY (2026-08-12 — same latent bug the THOUGHTS panel exposed): clamp the
 *  persisted position to the CURRENT viewport on load, so a box saved on a wider screen (or
 *  before a phone rotation) can never strand the panel/chip beyond the visible area. */
function clampHudBox(b: HudBox): HudBox {
  const maxX = Math.max(0, window.innerWidth - 90);
  const maxY = Math.max(44, window.innerHeight - 70);
  return { ...b, x: Math.min(Math.max(0, b.x), maxX), y: Math.min(Math.max(44, b.y), maxY) };
}
function loadHudBox(): HudBox {
  try { const r = localStorage.getItem(HUD_BOX_KEY); if (r) return clampHudBox({ ...DEFAULT_HUD_BOX, ...JSON.parse(r) }); } catch { /* ignore */ }
  return clampHudBox(DEFAULT_HUD_BOX);
}

// PERF (2026-09-18 — "laggy"): ONE module-level formatter. Intl.DateTimeFormat CONSTRUCTION is
// ms-scale (the 2026-07-30 fmtEtTime lesson) and this ran on EVERY render — the HUD re-renders
// on every live tick (lastPrice changes per tick).
const _etClockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** Unix seconds at the most recent ET midnight (DST-safe). */
function etDayStartSec(): number {
  const parts = _etClockFmt.formatToParts(new Date());
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Math.floor(Date.now() / 1000) - (g("hour") * 3600 + g("minute") * 60 + g("second"));
}

/** Wilder ATR-14 on the supplied candles (returns null when too few bars).
 *  PERF (2026-09-18): only the LAST 14 true ranges are averaged, so only the last 15 candles are
 *  walked — the old form built a true-range array over the WHOLE dataset (100k+ bars with deep
 *  history) on every render. Same 14 values summed in the same order → identical result. */
function atr14(candles: TerminalCandle[]): number | null {
  const n = candles.length;
  if (n < 15) return null;
  let sum = 0;
  for (let i = n - 14; i < n; i++) {
    const cur = candles[i], prev = candles[i - 1];
    sum += Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
  }
  return sum / 14;
}

const INTERVALS = ["1m", "5m", "15m", "60m"] as const;

export function MarketView({
  symbol, candles, lastPrice, onReload, strategies, source, connected, feedStatus, guard,
  interval, onIntervalChange,
}: {
  symbol: string;
  candles: TerminalCandle[];
  lastPrice: number | null;
  onReload: () => void;
  strategies: StrategyToggles;
  source: string;
  connected?: boolean;
  feedStatus?: "live" | "stale" | "unknown";
  /** CONTRACT GUARD state (useTerminalData `guard`, 2026-09-18) — null/undefined = unknown. */
  guard?: TerminalGuard | null;
  interval: string;
  onIntervalChange: (iv: string) => void;
}) {
  const n = candles.length;
  const has = n > 0;
  // HUD stats reflect TODAY's session. With a 600-bar scroll window the candle array can
  // span many days, so filter to today (ET); fall back to the last ~64 bars when today is empty.
  // PERF (2026-09-18 — "laggy"): this HUD re-renders on EVERY live tick (lastPrice), and each
  // render used to filter the whole candle array, spread today's bars into Math.max/min twice
  // and rebuild the ATR true-range list — O(dataset) work per tick, 100k+ bars once deep history
  // is loaded. The candle-derived stats are memoised on the array identity (it changes ≤8×/s,
  // and not at all on a price-only render) and "today" is a binary search — the array is
  // time-sorted — instead of a full filter. Same numbers as before.
  const { hasStatBars, first, dayHi, dayLo, atr } = useMemo(() => {
    const dayStart = etDayStartSec();
    let lo = 0, hi = candles.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time < dayStart) lo = mid + 1; else hi = mid; }
    const statBars = lo < candles.length ? candles.slice(lo) : candles.slice(-64);
    let mx = -Infinity, mn = Infinity;
    for (const d of statBars) { if (d.h > mx) mx = d.h; if (d.l < mn) mn = d.l; }
    return {
      hasStatBars: statBars.length > 0,
      first: statBars.length ? statBars[0].o : 0,
      dayHi: statBars.length ? mx : 0,
      dayLo: statBars.length ? mn : 0,
      atr: atr14(candles),
    };
  }, [candles]);
  const last = lastPrice ?? (has ? candles[n - 1].c : 0);
  const chg = hasStatBars ? last - first : 0;
  const pct = first ? (chg / first) * 100 : 0;
  const up = chg >= 0;
  const active = STRATS.filter((s) => strategies[s.key]);
  const session = marketSession(); // "RTH" | "ETH" | "CLOSED" — full CME futures session
  // LIVE reflects the actual feed, NOT just RTH hours — futures stream in ETH too.
  // Live when the WS is connected, we have a real data source, and the server's MW
  // feed isn't reporting "stale". The "· RTH/ETH" suffix still shows the session.
  const hasSource = source !== "none" && source !== "";
  // CONTRACT GUARD (2026-09-18): MotiveWave off-contract with NO tick translation (roll pending /
  // no trusted offset) means nothing MW sends reaches this chart — Yahoo's CME feed drives and
  // it runs ~10 minutes behind. The WS is connected and the source is real, so the old rule read
  // LIVE over a ten-minute-old candle. (While translation IS active the chart is tick-live on
  // the front month, so that state stays LIVE.)
  const yahooDriving = !!guard && guard.offContract && !guard.translationActive;
  const live = (connected ?? true) && hasSource && feedStatus !== "stale" && !yahooDriving;

  // ── Draggable + resizable floating panel (position/size persisted) ──────────
  const hudRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<HudBox>(loadHudBox);
  const boxRef = useRef(box); boxRef.current = box;
  useEffect(() => { try { localStorage.setItem(HUD_BOX_KEY, JSON.stringify(box)); } catch { /* ignore */ } }, [box]);

  // Dismissed → show a small restore chip where the panel was (click to bring it back).
  if (box.hidden) {
    return createPortal(
      <button
        onClick={() => setBox((b) => ({ ...b, hidden: false }))}
        title="Show market panel"
        style={{
          position: "fixed", left: box.x, top: box.y, zIndex: 6, display: "flex", alignItems: "center", gap: 6,
          background: "rgba(8,10,16,0.86)", border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px",
          color: C.accent, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600,
          letterSpacing: 1, cursor: "pointer", backdropFilter: "blur(10px)",
        }}
      >
        ▣ {symbol}
      </button>,
      document.body,
    );
  }

  const beginDrag = (mode: "move" | "resize", e: React.PointerEvent) => {
    e.preventDefault();
    const el = hudRef.current;
    const startW = el?.offsetWidth ?? boxRef.current.w;
    const startH = el?.offsetHeight ?? 160;
    const sx = e.clientX, sy = e.clientY, o = { ...boxRef.current };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (mode === "move") {
        setBox((b) => ({
          ...b,
          x: Math.min(Math.max(0, o.x + dx), window.innerWidth - 80),
          y: Math.min(Math.max(44, o.y + dy), window.innerHeight - 50),
        }));
      } else {
        setBox((b) => ({
          ...b,
          w: Math.max(300, Math.min(startW + dx, window.innerWidth - 20)),
          h: Math.max(110, startH + dy),
        }));
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.userSelect = "none";
  };
  // Drag from anywhere on the panel except its interactive controls / the resize grip.
  const onHudPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,a,input,select,.tt-hud-resize")) return;
    beginDrag("move", e);
  };
  // Double-click empty panel area to reset position/size (recovers a lost panel).
  const onHudDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,a,input,select,.tt-hud-resize")) return;
    setBox(DEFAULT_HUD_BOX);
  };

  return createPortal(
    <div
      className="tt-hud"
      ref={hudRef}
      onPointerDown={onHudPointerDown}
      onDoubleClick={onHudDoubleClick}
      style={{ position: "fixed", left: box.x, top: box.y, width: box.w, height: box.h ?? undefined, maxWidth: "none", zIndex: 6, cursor: "grab" }}
      title="Drag to move · drag the corner to resize · double-click to reset"
    >
      <div className="tt-mkt-head">
        <div className="tt-mkt-id">
          <div className="tt-mkt-sym">{symbol}<span className="tt-mkt-tag">FRONT MONTH · FUTURES</span></div>
          <div className={"tt-live" + (live && session !== "CLOSED" ? "" : " closed")}
            title={yahooDriving ? "MotiveWave is on a different contract month — Yahoo's ~10-minute-delayed feed is driving the chart. Roll the MotiveWave chart to the front month to go live again." : undefined}>
            <span className="tt-live-dot" />
            {session === "CLOSED" ? "MARKET CLOSED" : `${live ? "LIVE" : "DELAYED"} · ${session}`}
          </div>
        </div>
        <div className="tt-mkt-price">
          <div className="tt-mkt-last" style={{ color: up ? C.up : C.down }}>{has ? last.toFixed(2) : "—"}</div>
          <div className="tt-mkt-chg" style={{ color: up ? C.up : C.down }}>
            {up ? "▲" : "▼"} {Math.abs(chg).toFixed(2)} ({up ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)
          </div>
        </div>
        <div className="tt-mkt-stats">
          <div><span>HIGH</span><b>{has ? dayHi.toFixed(2) : "—"}</b></div>
          <div><span>LOW</span><b>{has ? dayLo.toFixed(2) : "—"}</b></div>
          <div><span>ATR-14</span><b>{atr != null ? atr.toFixed(2) : "—"}</b></div>
        </div>
        {/* Interval selector — lets the user switch timeframe (the terminal had none before). */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: 8, border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" }}>
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              onClick={() => onIntervalChange(iv)}
              title={`Switch to ${iv}`}
              style={{
                padding: "3px 8px", fontSize: 11, fontWeight: interval === iv ? 700 : 500,
                fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.2,
                background: interval === iv ? C.accent : "transparent",
                color: interval === iv ? "#05080f" : C.muted,
                border: "none", cursor: "pointer",
              }}
            >
              {iv}
            </button>
          ))}
        </div>
        <button className="tt-reload" onClick={onReload} title="Reload chart">{Ico.reload()}</button>
        <button
          className="tt-hud-close"
          onClick={() => setBox((b) => ({ ...b, hidden: true }))}
          title="Hide panel"
          style={{ marginLeft: 2, background: "transparent", border: "none", color: C.muted, cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 4px" }}
        >
          ✕
        </button>
      </div>

      <div className="tt-active-strip">
        <span className="tt-active-label">ACTIVE STRATEGIES</span>
        {active.length === 0 && <span className="tt-active-none">none enabled</span>}
        {active.map((s) => (
          <span key={s.key} className="tt-active-chip"><span className="tt-active-cdot" />{s.key}</span>
        ))}
      </div>

      {/* resize grip (bottom-right) */}
      <div
        className="tt-hud-resize"
        onPointerDown={(e) => { e.stopPropagation(); beginDrag("resize", e); }}
        title="Drag to resize"
        style={{
          position: "absolute", right: 4, bottom: 4, width: 14, height: 14, cursor: "nwse-resize",
          borderRight: `2px solid ${C.muted}`, borderBottom: `2px solid ${C.muted}`,
          opacity: 0.55, borderBottomRightRadius: 4,
        }}
      />
    </div>,
    document.body,
  );
}
