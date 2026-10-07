// SignalDetail.tsx — shared click-through detail card for a signal: side/strategy/tier/status,
// the exit strategy (entry/stop/TP1/TP2 + R:R + P&L/outcome), confirmations, footprint reading,
// and a mini chart centred on the signal. Used by both the Signals tab AND a chart-marker click.
import { useEffect, useMemo, useState } from "react";
import { isRTH } from "@shared/firing/session";
import { SIGNAL_INTERVAL_SEC } from "@shared/signal-rules";
import { C } from "./terminalStyles";
import { TierPill } from "./controls";
import { SignalMiniChart } from "@/components/SignalMiniChart";
import {
  displayOutcome, displayStrategy, displayStrategyCombo, displaySignalType,
  displayRiskFlag, COMBO_TIER_DISPLAY, fmtTrackRecord, suggestedContractsForTier, type ComboTier,
} from "@shared/signal-display";
import { useRiskComboStats, resolveComboRisk } from "@/lib/riskStats";
import type { CandleBar } from "@/components/CandlestickChart";
import type { TerminalSignal, TerminalCandle, SignalStatus } from "@/hooks/useTerminalData";

export const statusColor = (s: SignalStatus) =>
  s === "TARGET" ? C.up : s === "TP1 HIT" ? "#7fe6b8" : s === "STOPPED" ? C.down
  : s === "EOD" ? "#9aa3ad" : s === "ACTIVE" ? C.accent : C.muted;

/** Plain-English outcome words (shared/signal-display) — the recorded outcome when present,
 *  the candle-walked status as the fallback for legacy rows. Shared by the tab + this card. */
export function outcomeWords(s: TerminalSignal): string {
  if (s.outcome && s.outcome !== "open") return displayOutcome(s.outcome);
  switch (s.status) {
    case "TARGET": return displayOutcome("win_tp2");
    case "TP1 HIT": return displayOutcome("win_tp1");
    case "STOPPED": return displayOutcome("loss");
    case "EOD": return displayOutcome("eod");
    case "EXPIRED": return "EXPIRED";
    default: return "OPEN";
  }
}

/** "YYYY-MM-DD HH:MM ET" for exit timestamps. */
function fmtEtDateTime(tsSec: number): string {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(tsSec * 1000));
  return s.replace(",", "") + " ET";
}

/** TP1 anchor code (confirmations JSON) → plain words — the exit-calibration source. */
const ANCHOR_DISPLAY: Record<string, string> = {
  zone: "Milk-zone edge",
  yellowbox: "Yellow Box init level",
  tabletop: "Vector tabletop",
  default: "Calibrated default (Monte-Carlo)",
};

function prettyKey(k: string): string {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}
function parseJsonObj(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try { const o = JSON.parse(raw); return o && typeof o === "object" ? o : null; } catch { return null; }
}

// ── ALERT TAGS (2026-10-01, owner-approved R2a + R3) ─────────────────────────────
// "overnight · record only": the fire's bar CLOSES in ETH (America/New_York — the engine's own
// isRTH(close) rule) while tradeSettings.ethAlertsEnabled is off, so it sent no Discord/desktop
// alert and the RTH-only order window placed no order. "news blackout": the close falls inside a
// scheduled-news window (GET /api/news/blackouts?all=1, server/news-blackout.ts) while
// newsBlackoutEnabled — alerts muted, orders refused. Mirrors server alertMuteReason().
export interface AlertTagContext {
  ethAlertsEnabled: boolean;
  newsBlackoutEnabled: boolean;
  windows: Array<{ fromSec: number; toSec: number; reason: string }>;
}
const DEFAULT_TAG_CTX: AlertTagContext = { ethAlertsEnabled: false, newsBlackoutEnabled: true, windows: [] };
let _tagCtx: AlertTagContext | null = null;
let _tagCtxAt = 0;
let _tagCtxInflight: Promise<void> | null = null;
const _tagListeners = new Set<(c: AlertTagContext) => void>();
function refreshTagCtx(): Promise<void> {
  if (_tagCtxInflight) return _tagCtxInflight;
  _tagCtxInflight = Promise.all([
    fetch("/api/trade/settings").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/api/news/blackouts?all=1").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]).then(([s, nb]) => {
    const wins = Array.isArray(nb?.allWindows) ? nb.allWindows : [];
    _tagCtx = {
      ethAlertsEnabled: s?.ethAlertsEnabled === true,
      newsBlackoutEnabled: s ? s.newsBlackoutEnabled !== false : true,
      windows: wins
        .filter((w: any) => w && Number.isFinite(w.fromSec) && Number.isFinite(w.toSec))
        .map((w: any) => ({ fromSec: w.fromSec, toSec: w.toSec, reason: String(w.reason ?? "news blackout") })),
    };
    _tagCtxAt = Date.now();
    for (const l of _tagListeners) l(_tagCtx);
  }).finally(() => { _tagCtxInflight = null; });
  return _tagCtxInflight;
}
/** Shared, cached (5 min) alert-tag context for the Signals rows + this card. */
export function useAlertTagContext(): AlertTagContext {
  const [ctx, setCtx] = useState<AlertTagContext>(_tagCtx ?? DEFAULT_TAG_CTX);
  useEffect(() => {
    _tagListeners.add(setCtx);
    if (!_tagCtx || Date.now() - _tagCtxAt > 5 * 60_000) void refreshTagCtx();
    const t = window.setInterval(() => { void refreshTagCtx(); }, 5 * 60_000);
    return () => { _tagListeners.delete(setCtx); window.clearInterval(t); };
  }, []);
  return ctx;
}
/** Bar length of an interval label — mirrors server/news-blackout.ts intervalSecOf: the engine's
 *  closed set first, then "<n>m" / "<n>h"; unknown = 0 (close = open). */
function intervalSecOf(interval: string | undefined): number {
  const k = String(interval ?? "").trim();
  if (SIGNAL_INTERVAL_SEC[k]) return SIGNAL_INTERVAL_SEC[k];
  const m = /^(\d{1,4})\s*([mhMH])$/.exec(k);
  return m ? Number(m[1]) * (m[2].toLowerCase() === "h" ? 3600 : 60) : 0;
}
/** Tags for a fire at bar-open `ts` on `interval` (classified at the bar close). */
export function alertTagsFor(ts: number, interval: string | undefined, ctx: AlertTagContext): { overnight: boolean; news: string | null } {
  const close = ts + intervalSecOf(interval);
  const overnight = !ctx.ethAlertsEnabled && !isRTH(close);
  const w = ctx.newsBlackoutEnabled ? ctx.windows.find((x) => close >= x.fromSec && close < x.toSec) : undefined;
  return { overnight, news: w ? w.reason : null };
}
const OVN_TIP = "Overnight (ETH) fire — record only. Overnight alerts are muted (Settings: ethAlertsEnabled is off) and the order window is RTH-only, so no Discord/desktop alert was sent and no order was placed. The row still counts in the record.";
/** Small chips for a row / the detail head. `ctx` comes from ONE useAlertTagContext() call in
 *  the parent (not per row — a list of hundreds of rows must not start hundreds of pollers). */
export function AlertTagChips({ ts, interval, ctx, size = "row" }: { ts: number; interval?: string; ctx: AlertTagContext; size?: "row" | "detail" }) {
  const t = alertTagsFor(ts, interval, ctx);
  if (!t.overnight && !t.news) return null;
  const fs = size === "row" ? 8 : 9.5;
  const chip = (txt: string, tip: string, col: string, bd: string) => (
    <span title={tip} style={{ fontSize: fs, fontWeight: 700, letterSpacing: 0.4, color: col, border: `1px solid ${bd}`, borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>
      {txt}
    </span>
  );
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
      {t.overnight && chip("overnight · record only", OVN_TIP, "#9aa3ad", "rgba(154,163,173,0.5)")}
      {t.news && chip("news blackout", `${t.news} — scheduled-news window: alerts muted, auto-trade orders refused (Settings: newsBlackoutEnabled).`, "#e6b45a", "rgba(230,180,90,0.5)")}
    </span>
  );
}

// RISK DISPLAY (2026-07-30): tier chip colors (display-only; wording via shared/signal-display).
const TIER_COLOR: Record<ComboTier, string> = {
  proven: C.up, passing: C.accent, unproven: "#9aa3ad", weak: C.down,
};

export function SignalDetail({ signal, candles, onClose, interval }: { signal: TerminalSignal; candles: TerminalCandle[]; onClose: () => void; interval?: string }) {
  const dStop = Math.abs(signal.stop - signal.entry);
  const dTp1 = Math.abs(signal.tp1 - signal.entry);
  // TP1-ONLY (2026-08-13): tp2 null on all post-policy rows — TP2 lines vanish from the detail.
  const dTp2 = signal.tp2 != null ? Math.abs(signal.tp2 - signal.entry) : null;
  const rr1 = dStop ? dTp1 / dStop : 0;
  const rr2 = dStop && dTp2 != null ? dTp2 / dStop : null;
  const conf = parseJsonObj(signal.confirmations);
  const fp = parseJsonObj(signal.footprintReading);

  // Mini chart centred on this signal (candles for the signal's day).
  const miniCandles = useMemo<CandleBar[]>(
    () => candles.map((c) => ({ time: c.time, open: c.o, high: c.h, low: c.l, close: c.c })),
    [candles],
  );
  const showMini =
    miniCandles.length > 0 &&
    signal.ts >= miniCandles[0].time - 3600 &&
    signal.ts <= miniCandles[miniCandles.length - 1].time + 3600;
  const miniSignal = {
    time: signal.ts,
    direction: (signal.side === "LONG" ? "Long" : "Short") as "Long" | "Short",
    price: signal.entry, tp1: signal.tp1, tp2: signal.tp2 ?? undefined, sl: signal.stop,
    riskLevel: signal.tier?.toLowerCase(),
  };

  const levels = [
    { l: "ENTRY", v: signal.entry, d: null as number | null, col: C.text },
    { l: "STOP", v: signal.stop, d: dStop, col: C.down },
    { l: signal.tp2 != null ? "TP1" : "TP", v: signal.tp1, d: dTp1, col: C.up },
    ...(signal.tp2 != null ? [{ l: "TP2", v: signal.tp2, d: dTp2, col: C.up }] : []),
  ];

  // Strategy-family combo (workbook "combo" column) — unique fact strategies, engine order.
  const comboFamilies: string[] = [];
  if (conf && Array.isArray(conf.facts)) {
    for (const f of conf.facts) {
      if (f && typeof f.s === "string" && !comboFamilies.includes(f.s)) comboFamilies.push(f.s);
    }
  }
  const anchorTxt = conf && typeof conf.anchor === "string" ? (ANCHOR_DISPLAY[conf.anchor] ?? conf.anchor) : null;

  // RISK DISPLAY (2026-07-30): the setup's track record (held-out primary, realized secondary)
  // + the situational warnings. Renders nothing for rows without risk info (graceful).
  const riskStats = useRiskComboStats();
  const risk = resolveComboRisk(signal.comboKey, interval ?? "", riskStats);
  const alertTagCtx = useAlertTagContext(); // 2026-10-01 alert tags (overnight / news blackout)
  const hasRiskInfo = signal.comboKey != null || signal.riskFlags.length > 0;

  const confChips: { label: string; ok: boolean; extra?: string }[] = [];
  if (conf) {
    if (Array.isArray(conf.facts)) {
      // Fact-engine confirmations ({facts:[{s,d,k,lvl}],anchor,session}) — one chip per fact,
      // strategy keys routed through the shared display map (no internal jargon).
      for (const f of conf.facts.slice(0, 6)) {
        if (!f || typeof f.s !== "string") continue;
        confChips.push({ label: displayStrategy(f.s), ok: true, extra: f.lvl != null ? `@${Number(f.lvl).toFixed(2)}` : undefined });
      }
    }
    if ("milkOk" in conf) confChips.push({ label: "MilkZone", ok: !!conf.milkOk, extra: conf.milkPts != null ? `${conf.milkPts}pt` : undefined });
    if ("vecOk" in conf) confChips.push({ label: "Vector", ok: !!conf.vecOk });
    if ("secondaryVecOk" in conf) confChips.push({ label: "2nd Vector", ok: !!conf.secondaryVecOk, extra: conf.secondaryVecCount != null ? `×${conf.secondaryVecCount}` : undefined });
  }
  const fpEntries = fp ? Object.entries(fp).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 8) : [];

  return (
    <>
      <div className="tt-detail-backdrop" onClick={onClose} />
      <div className="tt-detail">
        <span className="tt-corner tl" /><span className="tt-corner tr" /><span className="tt-corner bl" /><span className="tt-corner br" />
        <button className="tt-detail-close" onClick={onClose}>✕</button>
        <div className="tt-detail-head">
          <span className="tt-side" style={{ color: signal.side === "LONG" ? C.up : C.down, fontSize: 15 }}>{signal.side}</span>
          <span className="tt-detail-strat">{signal.strat}</span>
          <TierPill tier={signal.tier} />
          <span className="tt-status" style={{ color: statusColor(signal.status) }}>{outcomeWords(signal)}</span>
          <span className="mono dim" style={{ marginLeft: "auto" }}>{signal.time}</span>
        </div>
        <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1, marginBottom: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {displaySignalType(signal.signalType)}
          {/* ALERT TAGS (2026-10-01): overnight · record only / news blackout */}
          <AlertTagChips ts={signal.ts} interval={interval} ctx={alertTagCtx} size="detail" />
        </div>

        <div className="tt-detail-levels">
          {levels.map((lv) => (
            <div key={lv.l} className="tt-detail-level">
              <div className="tt-detail-level-l">{lv.l}</div>
              <div className="tt-detail-level-v mono" style={{ color: lv.col }}>{lv.v.toFixed(2)}</div>
              {lv.d != null && <div className="tt-detail-level-d mono">{lv.d.toFixed(2)} pt</div>}
            </div>
          ))}
        </div>

        {showMini && (
          <div className="tt-detail-sec" style={{ marginTop: 0, marginBottom: 14 }}>
            <div className="tt-detail-sec-h">CHART</div>
            <div style={{ borderRadius: 10, overflow: "hidden", border: `1px solid ${C.line}` }}>
              <SignalMiniChart candles={miniCandles} signal={miniSignal} height={180} showMilk={false} />
            </div>
          </div>
        )}

        <div className="tt-detail-meta">
          <div><span>RISK : REWARD</span><b className="mono">1 : {rr1.toFixed(1)}{rr2 != null ? ` / ${rr2.toFixed(1)}` : ""}</b></div>
          <div><span>P&amp;L PTS</span><b className="mono" style={{ color: signal.pnl == null ? C.dim : signal.pnl >= 0 ? C.up : C.down }}>{signal.pnl == null ? "open" : (signal.pnl >= 0 ? "+" : "") + signal.pnl.toFixed(2)}</b></div>
          <div><span>OUTCOME</span><b style={{ color: statusColor(signal.status), fontSize: 12 }}>{outcomeWords(signal)}</b></div>
        </div>

        {/* BACKTEST-GRADE TRADE RESULT (2026-07-29): exit price/time, bars held, MAE/MFE, the
            strategy-family combo and the TP1 anchor — same detail as the workbook row. */}
        {(signal.exitPrice != null || signal.mae != null || comboFamilies.length > 0 || anchorTxt) && (
          <div className="tt-detail-sec">
            <div className="tt-detail-sec-h">TRADE RESULT</div>
            <div className="tt-detail-kv">
              {signal.exitPrice != null && <div><span>Exit price</span><b className="mono">{signal.exitPrice.toFixed(2)}</b></div>}
              {signal.exitTs != null && <div><span>Exit time</span><b className="mono">{fmtEtDateTime(signal.exitTs)}</b></div>}
              {signal.barsToExit != null && <div><span>Bars to exit</span><b className="mono">{signal.barsToExit}</b></div>}
              {signal.mae != null && <div><span>Max adverse move (MAE)</span><b className="mono" style={{ color: C.down }}>−{signal.mae.toFixed(2)} pt</b></div>}
              {signal.mfe != null && <div><span>Max favorable move (MFE)</span><b className="mono" style={{ color: C.up }}>+{signal.mfe.toFixed(2)} pt</b></div>}
              {comboFamilies.length > 0 && <div><span>Strategy combo</span><b>{displayStrategyCombo(comboFamilies.join(";"))}</b></div>}
              {anchorTxt && <div><span>TP1 based on</span><b>{anchorTxt}</b></div>}
            </div>
          </div>
        )}

        {/* RISK PROFILE (2026-07-30 — display-only): the setup's track record on BOTH bases
            (held-out walk-forward = primary, realized window = secondary) + the situational
            warnings with plain-English one-liners citing the measured stats. */}
        {hasRiskInfo && (
          <div className="tt-detail-sec">
            <div className="tt-detail-sec-h">RISK PROFILE</div>
            {risk ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{
                    fontSize: 10, letterSpacing: 0.8, fontWeight: 700, color: TIER_COLOR[risk.tier],
                    border: `1px solid ${TIER_COLOR[risk.tier]}`, borderRadius: 5, padding: "1px 7px",
                  }}>
                    {COMBO_TIER_DISPLAY[risk.tier]}
                  </span>
                  <span style={{ fontSize: 11, color: C.text }}>{risk.comboWords}</span>
                </div>
                <div className="tt-detail-kv">
                  <div><span>This exact setup</span><b className="mono">{risk.trackRecord}</b></div>
                  {risk.tier !== "unproven" && risk.heldOut && (
                    <div>
                      <span>Held-out basis{risk.scope === "all" ? " (all intervals pooled)" : ""}</span>
                      <b className="mono">
                        {fmtTrackRecord({ n: risk.heldOut.n, winPct: 100 * risk.heldOut.winRate, pf: risk.heldOut.pf })}
                        {Number.isFinite(risk.heldOut.expectancy) ? ` · ${risk.heldOut.expectancy >= 0 ? "+" : ""}${risk.heldOut.expectancy.toFixed(2)} pts/trade` : ""}
                      </b>
                    </div>
                  )}
                  {risk.realized && risk.realized.closed > 0 && (
                    <div>
                      <span>Realized this window</span>
                      <b className="mono">{fmtTrackRecord({ n: risk.realized.closed, winPct: risk.realized.winPct, pf: risk.realized.pf })}</b>
                    </div>
                  )}
                  {/* POSITION SIZING (2026-08-02 — display/config-only): the combo-tier suggested
                      size, from the SAME shared mapping the engine stamps (SIZE_BY_COMBO_TIER:
                      PROVEN = 2 contracts, everything else = 1). Sizes a real order ONLY under
                      the explicit "Size by combo tier" opt-in on the market page (default OFF). */}
                  <div>
                    <span>Suggested size</span>
                    <b className="mono">
                      {suggestedContractsForTier(risk.tier)} contract{suggestedContractsForTier(risk.tier) === 1 ? "" : "s"}
                      {risk.tier === "proven" ? " — proven setup" : ""}
                    </b>
                  </div>
                </div>
              </>
            ) : signal.comboKey ? (
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
                Track record unavailable{riskStats ? " for this setup" : " (stats still loading)"} — combo {signal.comboKey}
              </div>
            ) : null}
            {signal.riskFlags.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {signal.riskFlags.map((f) => {
                  const d = displayRiskFlag(f);
                  return (
                    <div key={f} style={{ fontSize: 11, lineHeight: 1.45 }}>
                      <span style={{ color: "#e6b45a", fontWeight: 700, letterSpacing: 0.5 }}>⚠ {d.label}</span>
                      <span style={{ color: C.muted }}> — {d.tooltip}</span>
                    </div>
                  );
                })}
              </div>
            ) : signal.comboKey != null ? (
              <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>No situational warnings at fire time.</div>
            ) : null}
          </div>
        )}

        {confChips.length > 0 && (
          <div className="tt-detail-sec">
            <div className="tt-detail-sec-h">CONFIRMATIONS</div>
            <div className="tt-detail-chips">
              {confChips.map((c, i) => (
                // Key includes the index — several facts can share a strategy ("Vector" ×3), so
                // the label alone produced React duplicate-key warnings.
                <span key={`${c.label}-${i}`} className="tt-detail-chip" style={{ color: c.ok ? C.up : C.dim, borderColor: c.ok ? "rgba(31,217,138,0.4)" : C.line }}>
                  {c.ok ? "✓" : "✗"} {c.label}{c.extra ? ` ${c.extra}` : ""}
                </span>
              ))}
            </div>
          </div>
        )}

        {fpEntries.length > 0 && (
          <div className="tt-detail-sec">
            <div className="tt-detail-sec-h">FOOTPRINT READING</div>
            <div className="tt-detail-kv">
              {fpEntries.map(([k, v]) => (
                <div key={k}><span>{prettyKey(k)}</span><b className="mono">{String(v)}</b></div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
