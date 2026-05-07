import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, TrendingUp, TrendingDown, Minus, Activity, BarChart3, AlertTriangle } from "lucide-react";

interface CandleBar {
  time: number; open: number; high: number; low: number; close: number; volume?: number; rth?: boolean;
}

// ── RTH helper ─────────────────────────────────────────────────────────────
function isRTH(ts: number): boolean {
  const d = new Date(ts * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 13 * 60 + 30 && m < 20 * 60; // 9:30 AM – 4:00 PM ET
}

function isToday(ts: number): boolean {
  const now = new Date();
  const d   = new Date(ts * 1000);
  return d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate()  === now.getUTCDate();
}

function isYesterday(ts: number): boolean {
  const yest = new Date(Date.now() - 86400_000);
  const d    = new Date(ts * 1000);
  return d.getUTCFullYear() === yest.getUTCFullYear() &&
    d.getUTCMonth() === yest.getUTCMonth() &&
    d.getUTCDate()  === yest.getUTCDate();
}

// ── Analysis engine ────────────────────────────────────────────────────────

interface DayStats {
  date: string;
  open: number; high: number; low: number; close: number;
  range: number;
  bullCandles: number; bearCandles: number; totalCandles: number;
  bullPct: number;
  openToHigh: number; openToLow: number;
  closedUpperHalf: boolean;
  highOfDay: number; lowOfDay: number;
}

function analyzeDays(candles: CandleBar[]): DayStats[] {
  const byDay = new Map<string, CandleBar[]>();
  for (const c of candles) {
    // Include all candles (RTH + ETH); skip weekend-only days below via < 3 bar filter
    const d = new Date(c.time * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(c);
  }
  const result: DayStats[] = [];
  for (const [date, bars] of byDay) {
    const sorted = [...bars].sort((a, b) => a.time - b.time);
    if (sorted.length < 3) continue;
    const open  = sorted[0].open;
    const close = sorted[sorted.length - 1].close;
    const high  = Math.max(...sorted.map(c => c.high));
    const low   = Math.min(...sorted.map(c => c.low));
    const range = high - low;
    const bull  = sorted.filter(c => c.close > c.open).length;
    const bear  = sorted.filter(c => c.close < c.open).length;
    result.push({
      date, open, high, low, close, range,
      bullCandles: bull, bearCandles: bear, totalCandles: sorted.length,
      bullPct: sorted.length ? bull / sorted.length : 0.5,
      openToHigh: high - open, openToLow: open - low,
      closedUpperHalf: close > (high + low) / 2,
      highOfDay: high, lowOfDay: low,
    });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

interface Prediction {
  title: string;
  body: string;
  bias: "bullish" | "bearish" | "neutral";
  confidence: "high" | "medium" | "low";
  category: "trend" | "reversion" | "range" | "structure";
}

function generatePredictions(days: DayStats[], todayCandles: CandleBar[]): Prediction[] {
  const preds: Prediction[] = [];
  if (days.length < 2) return preds;

  const recent  = days.slice(-5);
  const today   = days[days.length - 1];
  const prev    = days[days.length - 2];
  const prev2   = days.length >= 3 ? days[days.length - 3] : null;

  // ── Sort today's live candles ──
  const todaySorted = [...todayCandles].sort((a, b) => a.time - b.time);
  const liveHigh = todaySorted.length ? Math.max(...todaySorted.map(c => c.high)) : null;
  const liveLow  = todaySorted.length ? Math.min(...todaySorted.map(c => c.low))  : null;
  const liveClose = todaySorted.length ? todaySorted[todaySorted.length - 1].close : null;
  const liveOpen  = todaySorted.length ? todaySorted[0].open : null;

  // ── 1. Multi-day directional streak → reversion bias ──────────────────────
  const streak = {
    bull: recent.filter(d => d.close > d.open).length,
    bear: recent.filter(d => d.close < d.open).length,
  };
  if (streak.bear >= 4) {
    preds.push({
      title: "Extended Bearish Streak — Reversion Watch",
      body: `The market has closed bearish ${streak.bear} of the last ${recent.length} RTH sessions. Extended one-sided moves historically attract counter-trend participation. A bounce or consolidation period becomes increasingly probable — watch for bullish price action near established support zones.`,
      bias: "bullish",
      confidence: streak.bear >= 5 ? "high" : "medium",
      category: "reversion",
    });
  } else if (streak.bull >= 4) {
    preds.push({
      title: "Extended Bullish Streak — Reversion Watch",
      body: `The market has closed bullish ${streak.bull} of the last ${recent.length} RTH sessions. Markets rarely extend in one direction without pausing. A pullback or range day becomes increasingly probable — watch for short opportunities at overhead resistance.`,
      bias: "bearish",
      confidence: streak.bull >= 5 ? "high" : "medium",
      category: "reversion",
    });
  }

  // ── 2. Today's intraday bear structure → late-day bounce? ─────────────────
  if (liveClose !== null && liveOpen !== null && liveHigh !== null && liveLow !== null && todaySorted.length >= 6) {
    const moveDown = liveOpen - liveClose;
    const moveUp   = liveClose - liveOpen;
    const liveRange = liveHigh - liveLow;
    const closePct = liveRange > 0 ? (liveClose - liveLow) / liveRange : 0.5;

    if (moveDown > 15 && closePct < 0.35) {
      preds.push({
        title: "Heavy Selling Today — Late Mean Reversion Possible",
        body: `Price is down ${moveDown.toFixed(1)} pts from the open and closing near the low of day. When sessions are heavily one-sided early, mean-reversion buying often appears into the final 60–90 minutes of RTH. Watch for a bullish imbalance signal near the session low.`,
        bias: "bullish",
        confidence: moveDown > 25 ? "high" : "medium",
        category: "reversion",
      });
    } else if (moveUp > 15 && closePct > 0.65) {
      preds.push({
        title: "Strong Buying Today — Late Profit-Taking Possible",
        body: `Price is up ${moveUp.toFixed(1)} pts from the open near the high of day. Late-session selling pressure (profit-taking) often compresses gains into the close. Watch for a short opportunity near the high if volume drops off in the last hour.`,
        bias: "bearish",
        confidence: moveUp > 25 ? "high" : "medium",
        category: "reversion",
      });
    }
  }

  // ── 3. Range analysis vs yesterday ────────────────────────────────────────
  if (prev.range > 0) {
    const todayRange = liveHigh !== null && liveLow !== null ? liveHigh - liveLow : today.range;
    const rangeRatio = todayRange / prev.range;
    if (rangeRatio < 0.45 && todaySorted.length > 10) {
      preds.push({
        title: "Compression Day — Breakout Setup Building",
        body: `Today's range (${todayRange.toFixed(1)} pts) is only ${(rangeRatio * 100).toFixed(0)}% of yesterday's range (${prev.range.toFixed(1)} pts). Tight compression typically precedes expansion. A breakout above/below today's range could produce a fast 10–20 pt move. Watch the extremes closely.`,
        bias: "neutral",
        confidence: "medium",
        category: "range",
      });
    } else if (rangeRatio > 2.5) {
      preds.push({
        title: "High Volatility Expansion — Expect Continuation or Snap-Back",
        body: `Today's range (${todayRange.toFixed(1)} pts) is ${(rangeRatio).toFixed(1)}× yesterday's. High-volatility days often see range contraction the following session. If there is no clear directional close, tomorrow may chop or consolidate.`,
        bias: "neutral",
        confidence: "low",
        category: "range",
      });
    }
  }

  // ── 4. Open vs prior day high/low ─────────────────────────────────────────
  if (liveOpen !== null) {
    if (liveOpen > prev.high) {
      preds.push({
        title: "Gap Above Prior Day High",
        body: `Today opened at ${liveOpen.toFixed(2)}, above yesterday's high of ${prev.high.toFixed(2)}. Gap-up opens above prior highs often either fill the gap (bearish reversion) or accelerate — the first 30 minutes of RTH direction is the tell. If price holds above ${prev.high.toFixed(2)}, the bullish trend continues; a fill of the gap targets ${prev.close.toFixed(2)}.`,
        bias: "neutral",
        confidence: "medium",
        category: "structure",
      });
    } else if (liveOpen < prev.low) {
      preds.push({
        title: "Gap Below Prior Day Low",
        body: `Today opened at ${liveOpen.toFixed(2)}, below yesterday's low of ${prev.low.toFixed(2)}. Gap-down opens below prior lows are structurally bearish. Watch for a dead-cat bounce back to ${prev.low.toFixed(2)} (which becomes resistance) then continuation lower.`,
        bias: "bearish",
        confidence: "medium",
        category: "structure",
      });
    }
  }

  // ── 5. High/low of day vs prior range midpoint ────────────────────────────
  const prevMid = (prev.high + prev.low) / 2;
  if (liveClose !== null) {
    if (liveClose > prev.high && prev2 && prev.close > prev2.high) {
      preds.push({
        title: "Two Consecutive Days Closing Above Prior High",
        body: `Today and yesterday both closed above the prior day's high. This stair-stepping pattern signals strong institutional buying. The path of least resistance is up — dips to the prior day's high (${prev.high.toFixed(2)}) are buy opportunities with trend confirmation.`,
        bias: "bullish",
        confidence: "high",
        category: "trend",
      });
    } else if (liveClose < prev.low && prev2 && prev.close < prev2.low) {
      preds.push({
        title: "Two Consecutive Days Closing Below Prior Low",
        body: `Today and yesterday both closed below the prior day's low. This is a distribution pattern consistent with institutional selling. Rallies to the prior day's low (${prev.low.toFixed(2)}) are likely short opportunities in a downtrend.`,
        bias: "bearish",
        confidence: "high",
        category: "trend",
      });
    }
  }

  // ── 6. Bull/bear candle imbalance today ───────────────────────────────────
  if (todaySorted.length >= 10) {
    const todayBull = todaySorted.filter(c => c.close > c.open).length;
    const todayBear = todaySorted.filter(c => c.close < c.open).length;
    const todayTotal = todaySorted.length;
    const todayBullPct = todayBull / todayTotal;
    if (todayBullPct > 0.72) {
      preds.push({
        title: "Bullish Candle Dominance Today",
        body: `${todayBull} of ${todayTotal} 5-min candles today (${(todayBullPct * 100).toFixed(0)}%) are closing green. The intraday structure is strongly bullish — breadth of this quality typically sustains into the close. Pullbacks are likely shallow; dip-buying has been rewarded.`,
        bias: "bullish",
        confidence: todayBullPct > 0.80 ? "high" : "medium",
        category: "trend",
      });
    } else if (todayBullPct < 0.28) {
      preds.push({
        title: "Bearish Candle Dominance Today",
        body: `${todayBear} of ${todayTotal} 5-min candles today (${((1 - todayBullPct) * 100).toFixed(0)}%) are closing red. Sustained selling breadth like this typically does not reverse cleanly intraday. Expect continued pressure — any bounces are likely to be sold.`,
        bias: "bearish",
        confidence: todayBullPct < 0.20 ? "high" : "medium",
        category: "trend",
      });
    }
  }

  // ── 7. High of day not extended → room above ──────────────────────────────
  if (liveHigh !== null && liveClose !== null && prev.range > 0) {
    const distFromHigh = liveHigh - liveClose;
    const distFromLow  = liveClose - (liveLow ?? liveClose);
    if (distFromHigh > 0 && distFromLow / (distFromHigh + distFromLow) > 0.75 && todaySorted.length >= 8) {
      preds.push({
        title: "Price Compressing Near Session Low",
        body: `Current price is ${distFromHigh.toFixed(1)} pts below the day's high of ${liveHigh.toFixed(2)} and only ${distFromLow.toFixed(1)} pts above the low. With price hugging the lower quarter of the session range, the risk/reward for a long trade near support improves significantly.`,
        bias: "bullish",
        confidence: "medium",
        category: "range",
      });
    } else if (distFromLow > 0 && distFromHigh / (distFromHigh + distFromLow) > 0.75 && todaySorted.length >= 8) {
      preds.push({
        title: "Price Compressing Near Session High",
        body: `Current price is only ${distFromHigh.toFixed(1)} pts below the day's high of ${liveHigh.toFixed(2)}. With price in the upper quarter of the range and ${distFromLow.toFixed(1)} pts of air below, the risk/reward for shorts near resistance improves.`,
        bias: "bearish",
        confidence: "medium",
        category: "range",
      });
    }
  }

  // Fallback if no strong signals
  if (preds.length === 0) {
    preds.push({
      title: "No Strong Directional Bias Detected",
      body: "Market conditions are mixed or neutral. No strong trending or reversal patterns are present. Wait for clearer structure before committing to a directional trade. Focus on executing at high-confluence zone levels.",
      bias: "neutral",
      confidence: "low",
      category: "trend",
    });
  }

  return preds;
}

// ── Styles ─────────────────────────────────────────────────────────────────
const MW = {
  bg: "#05080d", panel: "#0d1117", border: "#1e2a3a",
  text: "#c9d4e0", muted: "#4a6080", accent: "#1a72d4",
  green: "#26c87a", red: "#ef5350", amber: "#f59e0b",
};

const BIAS_COLOR = { bullish: MW.green, bearish: MW.red, neutral: MW.amber };
const CONF_COLOR = { high: MW.green, medium: MW.amber, low: MW.muted };
const BIAS_ICON = {
  bullish: <TrendingUp className="w-4 h-4" style={{ color: MW.green }} />,
  bearish: <TrendingDown className="w-4 h-4" style={{ color: MW.red }} />,
  neutral: <Minus className="w-4 h-4" style={{ color: MW.amber }} />,
};
const CAT_LABEL: Record<string, string> = {
  trend: "Trend", reversion: "Mean Reversion", range: "Range Analysis", structure: "Market Structure",
};

// ── Component ──────────────────────────────────────────────────────────────
export default function PredictionsPage() {
  const fromTs = Math.floor(Date.now() / 1000) - 14 * 86400; // 14 days back
  const toTs   = Math.floor(Date.now() / 1000) + 3600;

  const { data: candleData5m, isLoading } = useQuery<{ candles: CandleBar[] }>({
    queryKey: ["/api/data/cached-continuous", "MES", "5m", fromTs, toTs, "predictions"],
    queryFn: async () => {
      const r = await fetch(`/api/data/cached-continuous/MES/5m?from=${fromTs}&to=${toTs}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  const allCandles: CandleBar[] = useMemo(() => {
    if (!candleData5m?.candles) return [];
    return candleData5m.candles
      .filter(c => isFinite(c.open) && isFinite(c.close) && c.high >= c.low)
      .sort((a, b) => a.time - b.time);
  }, [candleData5m]);

  const days = useMemo(() => analyzeDays(allCandles), [allCandles]);

  // Today's candles (RTH + ETH), fallback to yesterday if today has no data
  const todayCandles = useMemo(() => {
    const t = allCandles.filter(c => isToday(c.time));
    if (t.length > 0) return t;
    return allCandles.filter(c => isYesterday(c.time));
  }, [allCandles]);

  const predictions = useMemo(() => generatePredictions(days, todayCandles), [days, todayCandles]);

  // Recent day summary table
  const recentDays = days.slice(-7);

  return (
    <div style={{ minHeight: "100vh", background: MW.bg, color: MW.text, fontFamily: "monospace" }}>
      {/* Header */}
      <div style={{ background: MW.panel, borderBottom: `1px solid ${MW.border}`, padding: "10px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <Link href="/">
          <button style={{ background: "transparent", border: "none", color: MW.muted, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <ArrowLeft className="w-4 h-4" /> Back to Chart
          </button>
        </Link>
        <div style={{ width: 1, height: 20, background: MW.border }} />
        <Activity className="w-4 h-4" style={{ color: MW.accent }} />
        <span style={{ fontSize: 15, fontWeight: 600, color: MW.text }}>Market Predictions — MES</span>
        <span style={{ fontSize: 11, color: MW.muted, marginLeft: "auto" }}>
          Based on {days.length} sessions · {allCandles.length} 5m bars
        </span>
      </div>

      <div style={{ padding: "20px 24px", maxWidth: 1100, margin: "0 auto" }}>

        {isLoading && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: MW.muted, marginTop: 40 }}>
            <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: `${MW.accent} transparent transparent transparent` }} />
            Loading market data...
          </div>
        )}

        {!isLoading && allCandles.length === 0 && (
          <div style={{ textAlign: "center", marginTop: 60, color: MW.muted }}>
            <BarChart3 className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p>No MES data available. Make sure MotiveWave is running and bar files are loaded.</p>
          </div>
        )}

        {!isLoading && allCandles.length > 0 && (
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>

            {/* Left column: Predictions */}
            <div style={{ flex: "1 1 560px", minWidth: 0 }}>
              <div style={{ fontSize: 11, color: MW.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
                Current Analysis &amp; Predictions
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {predictions.map((p, i) => (
                  <div key={i} style={{
                    background: MW.panel,
                    border: `1px solid ${BIAS_COLOR[p.bias]}33`,
                    borderLeft: `3px solid ${BIAS_COLOR[p.bias]}`,
                    borderRadius: 6,
                    padding: "14px 16px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      {BIAS_ICON[p.bias]}
                      <span style={{ fontSize: 13, fontWeight: 600, color: MW.text }}>{p.title}</span>
                      <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
                        <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: `${BIAS_COLOR[p.bias]}22`, color: BIAS_COLOR[p.bias], border: `1px solid ${BIAS_COLOR[p.bias]}44` }}>
                          {p.bias.toUpperCase()}
                        </span>
                        <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: MW.bg, color: CONF_COLOR[p.confidence], border: `1px solid ${MW.border}` }}>
                          {p.confidence} conf
                        </span>
                        <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: MW.bg, color: MW.muted, border: `1px solid ${MW.border}` }}>
                          {CAT_LABEL[p.category]}
                        </span>
                      </span>
                    </div>
                    <p style={{ fontSize: 12, color: MW.muted, lineHeight: 1.7, margin: 0 }}>{p.body}</p>
                  </div>
                ))}
              </div>

              {/* Disclaimer */}
              <div style={{ marginTop: 20, display: "flex", gap: 8, padding: "10px 14px", background: `${MW.amber}11`, border: `1px solid ${MW.amber}33`, borderRadius: 6 }}>
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: MW.amber }} />
                <p style={{ fontSize: 11, color: MW.muted, margin: 0, lineHeight: 1.6 }}>
                  Predictions are statistical tendencies derived from recent price structure — not financial advice.
                  Always validate against real-time zone levels and signal confluence before entering a trade.
                </p>
              </div>
            </div>

            {/* Right column: Recent session table */}
            <div style={{ flex: "0 0 320px", minWidth: 260 }}>
              <div style={{ fontSize: 11, color: MW.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
                Recent Sessions
              </div>
              <div style={{ background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 6, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: MW.bg, borderBottom: `1px solid ${MW.border}` }}>
                      {["Date", "O→C", "Range", "Bull%"].map(h => (
                        <th key={h} style={{ padding: "7px 10px", color: MW.muted, textAlign: "left", fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recentDays.map((d, i) => {
                      const dir = d.close > d.open ? "bull" : d.close < d.open ? "bear" : "flat";
                      const chg = d.close - d.open;
                      return (
                        <tr key={d.date} style={{ borderBottom: i < recentDays.length - 1 ? `1px solid ${MW.border}` : "none" }}>
                          <td style={{ padding: "7px 10px", color: MW.muted }}>{d.date.slice(5)}</td>
                          <td style={{ padding: "7px 10px", color: dir === "bull" ? MW.green : dir === "bear" ? MW.red : MW.muted, fontWeight: 600 }}>
                            {chg > 0 ? "+" : ""}{chg.toFixed(1)}
                          </td>
                          <td style={{ padding: "7px 10px", color: MW.text }}>{d.range.toFixed(1)}</td>
                          <td style={{ padding: "7px 10px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <div style={{ flex: 1, height: 4, background: MW.bg, borderRadius: 2 }}>
                                <div style={{ width: `${d.bullPct * 100}%`, height: "100%", background: d.bullPct > 0.55 ? MW.green : d.bullPct < 0.45 ? MW.red : MW.amber, borderRadius: 2 }} />
                              </div>
                              <span style={{ color: MW.muted, minWidth: 28 }}>{(d.bullPct * 100).toFixed(0)}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Today's intraday stats */}
              {todayCandles.length > 0 && (() => {
                const sorted = [...todayCandles].sort((a, b) => a.time - b.time);
                const open   = sorted[0].open;
                const close  = sorted[sorted.length - 1].close;
                const high   = Math.max(...sorted.map(c => c.high));
                const low    = Math.min(...sorted.map(c => c.low));
                const chg    = close - open;
                const bull   = sorted.filter(c => c.close > c.open).length;
                const pct    = sorted.length ? bull / sorted.length : 0;
                const isPos  = chg >= 0;
                return (
                  <div style={{ marginTop: 14, background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 6, padding: "14px 16px" }}>
                    <div style={{ fontSize: 11, color: MW.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
                      Today's Session
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
                      {[
                        { label: "Open",  val: open.toFixed(2),  color: MW.text },
                        { label: "Close", val: close.toFixed(2), color: isPos ? MW.green : MW.red },
                        { label: "High",  val: high.toFixed(2),  color: MW.green },
                        { label: "Low",   val: low.toFixed(2),   color: MW.red },
                        { label: "Change",val: `${chg >= 0 ? "+" : ""}${chg.toFixed(1)} pts`, color: isPos ? MW.green : MW.red },
                        { label: "Bull Bars", val: `${(pct * 100).toFixed(0)}%`, color: pct > 0.5 ? MW.green : MW.red },
                      ].map(row => (
                        <div key={row.label}>
                          <div style={{ fontSize: 10, color: MW.muted }}>{row.label}</div>
                          <div style={{ fontSize: 13, color: row.color, fontWeight: 600 }}>{row.val}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
