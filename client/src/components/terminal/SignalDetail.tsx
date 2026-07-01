// SignalDetail.tsx — shared click-through detail card for a signal: side/strategy/tier/status,
// the exit strategy (entry/stop/TP1/TP2 + R:R + P&L/outcome), confirmations, footprint reading,
// and a mini chart centred on the signal. Used by both the Signals tab AND a chart-marker click.
import { useMemo } from "react";
import { C } from "./terminalStyles";
import { TierPill } from "./controls";
import { SignalMiniChart } from "@/components/SignalMiniChart";
import type { CandleBar } from "@/components/CandlestickChart";
import type { TerminalSignal, TerminalCandle, SignalStatus } from "@/hooks/useTerminalData";

export const statusColor = (s: SignalStatus) =>
  s === "TARGET" ? C.up : s === "TP1 HIT" ? "#7fe6b8" : s === "STOPPED" ? C.down : s === "ACTIVE" ? C.accent : C.muted;

function prettyKey(k: string): string {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}
function parseJsonObj(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try { const o = JSON.parse(raw); return o && typeof o === "object" ? o : null; } catch { return null; }
}

export function SignalDetail({ signal, candles, onClose }: { signal: TerminalSignal; candles: TerminalCandle[]; onClose: () => void }) {
  const dStop = Math.abs(signal.stop - signal.entry);
  const dTp1 = Math.abs(signal.tp1 - signal.entry);
  const dTp2 = Math.abs(signal.tp2 - signal.entry);
  const rr1 = dStop ? dTp1 / dStop : 0;
  const rr2 = dStop ? dTp2 / dStop : 0;
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
    price: signal.entry, tp1: signal.tp1, tp2: signal.tp2, sl: signal.stop,
    riskLevel: signal.tier?.toLowerCase(),
  };

  const levels = [
    { l: "ENTRY", v: signal.entry, d: null as number | null, col: C.text },
    { l: "STOP", v: signal.stop, d: dStop, col: C.down },
    { l: "TP1", v: signal.tp1, d: dTp1, col: C.up },
    { l: "TP2", v: signal.tp2, d: dTp2, col: C.up },
  ];

  const confChips: { label: string; ok: boolean; extra?: string }[] = [];
  if (conf) {
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
          <span className="tt-status" style={{ color: statusColor(signal.status) }}>{signal.status}</span>
          <span className="mono dim" style={{ marginLeft: "auto" }}>{signal.time}</span>
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
          <div><span>RISK : REWARD</span><b className="mono">1 : {rr1.toFixed(1)} / {rr2.toFixed(1)}</b></div>
          <div><span>P&amp;L</span><b className="mono" style={{ color: signal.pnl == null ? C.dim : signal.pnl >= 0 ? C.up : C.down }}>{signal.pnl == null ? "open" : (signal.pnl >= 0 ? "+" : "") + signal.pnl.toFixed(2)}</b></div>
          {signal.outcome && <div><span>OUTCOME</span><b>{signal.outcome}</b></div>}
        </div>

        {confChips.length > 0 && (
          <div className="tt-detail-sec">
            <div className="tt-detail-sec-h">CONFIRMATIONS</div>
            <div className="tt-detail-chips">
              {confChips.map((c) => (
                <span key={c.label} className="tt-detail-chip" style={{ color: c.ok ? C.up : C.dim, borderColor: c.ok ? "rgba(31,217,138,0.4)" : C.line }}>
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
