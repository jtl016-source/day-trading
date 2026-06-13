// Clock.tsx — live ET clock with market open/closed pill (preserved verbatim).
import { useEffect, useState } from "react";
import { C } from "./terminalStyles";

export function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(now);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const session = marketSession(now);
  const openColor = session === "RTH" ? C.up : session === "ETH" ? C.accent : C.down;
  const label = session === "CLOSED" ? "MARKET CLOSED" : `MARKET OPEN · ${session}`;

  return (
    <div className="tt-clock">
      <span className="tt-corner tl" /><span className="tt-corner br" />
      <div className="tt-clock-time">{time}</div>
      <div className="tt-clock-meta">
        <span className="tt-clock-date">{date} · ET</span>
        <span className="tt-clock-mkt" style={{ color: openColor }}>
          <span className="tt-clock-dot" style={{ background: openColor }} />{label}
        </span>
      </div>
    </div>
  );
}

export type MarketSession = "RTH" | "ETH" | "CLOSED";

// CME ES/MES (E-mini S&P) session, ET:
//   • RTH    9:30 AM – 4:00 PM, Mon–Fri
//   • ETH    the rest of the Globex session — Sun 6:00 PM → Fri 5:00 PM, continuous
//   • CLOSED daily maintenance halt 5:00–6:00 PM ET, and the weekend (Fri 5 PM → Sun 6 PM)
const _sessFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
export function marketSession(d: Date = new Date()): MarketSession {
  const parts = _sessFmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  const mins = parseInt(get("hour")) * 60 + parseInt(get("minute"));
  if (wd === "Sat") return "CLOSED";
  if (wd === "Sun") return mins >= 18 * 60 ? "ETH" : "CLOSED";   // session opens Sun 6:00 PM ET
  if (wd === "Fri" && mins >= 17 * 60) return "CLOSED";          // session closes Fri 5:00 PM ET
  if (mins >= 17 * 60 && mins < 18 * 60) return "CLOSED";        // daily maintenance halt 5–6 PM ET
  if (mins >= 9 * 60 + 30 && mins < 17 * 60) return "RTH";       // 9:30 AM – 5:00 PM ET
  return "ETH";
}

/** Shared helper: is the US equity RTH session open right now (Mon–Fri 9:30–16:00 ET)? */
export function isMarketOpenNow(): boolean {
  return marketSession() === "RTH";
}
