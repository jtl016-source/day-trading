// ProbabilityPanel.tsx — the fractal "probability concept" read-out: regime (DFA-Hurst),
// long-run value area, Hurst target scaler, and multifractal stress, computed live from the
// loaded candles. Floats top-right over the chart when the Probability strategy is enabled.
// DISPLAY ONLY — these are regime/context reads, never trade triggers (see lib/probability.ts).
import { useMemo } from "react";
import { C } from "./terminalStyles";
import { computeProbabilitySnapshot } from "@/lib/probability";
import type { TerminalCandle } from "@/hooks/useTerminalData";
import type { Regime } from "@/lib/hurst";

const IV_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };

const REGIME_COLOR: Record<Regime, string> = {
  PERSISTENT: C.up,      // trending — momentum persists
  MEANREVERT: C.amber,   // chop — fades back to value
  NEUTRAL: C.muted,
  UNKNOWN: C.dim,
};
const REGIME_LABEL: Record<Regime, string> = {
  PERSISTENT: "TRENDING", MEANREVERT: "MEAN-REVERT", NEUTRAL: "NEUTRAL", UNKNOWN: "—",
};
const TONE_COLOR: Record<string, string> = { high: C.down, low: C.up, mid: C.muted, tight: C.down, wide: C.up, neutral: C.muted };

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 8, letterSpacing: 1, color: C.dim }}>{label}</span>
      <span style={{ fontFamily: "var(--fm)", fontSize: 12, fontWeight: 700, color: color ?? C.text }}>{value}</span>
    </div>
  );
}

export function ProbabilityPanel({ candles, interval }: { candles: TerminalCandle[]; interval: string }) {
  const ivSec = IV_SEC[interval] ?? 300;
  const snap = useMemo(() => computeProbabilitySnapshot(candles, ivSec), [candles, ivSec]);

  if (!snap.ready && !snap.valueArea) {
    return (
      <div className="tt-prob">
        <div className="tt-prob-head"><b>PROBABILITY</b><span>building history…</span></div>
      </div>
    );
  }

  const rc = REGIME_COLOR[snap.regime];
  const va = snap.valueArea;
  const proj = snap.projection;

  return (
    <div className="tt-prob">
      <div className="tt-prob-head">
        <b>PROBABILITY</b>
        <span style={{ color: rc }}>{REGIME_LABEL[snap.regime]}</span>
      </div>

      {/* Regime — DFA-Hurst + historical edge for this regime */}
      <div className="tt-prob-grid">
        <Stat label="HURST H" value={snap.H != null ? snap.H.toFixed(3) : "—"} color={rc} />
        <Stat label="WIN RATE" value={snap.winProb != null ? snap.winProb.toFixed(1) + "%" : "—"} />
        <Stat label="PROFIT F" value={snap.pf != null ? snap.pf.toFixed(2) : "—"} />
      </div>
      <div className="tt-prob-note">
        {snap.regime === "PERSISTENT" && "Moves extend — trend-follow, let targets run."}
        {snap.regime === "MEANREVERT" && "Moves fade — fade extremes, tighten targets."}
        {snap.regime === "NEUTRAL" && "Near random-walk — no Hurst edge; default sizing."}
        {snap.regime === "UNKNOWN" && "Not enough history for a regime read."}
      </div>

      {/* Long-run value area — where price sits in its realized distribution */}
      {va && (
        <>
          <div className="tt-prob-sec">VALUE AREA</div>
          {snap.vaVerdict && (
            <div className="tt-prob-verdict" style={{ color: TONE_COLOR[snap.vaVerdict.tone] }}>
              {snap.vaVerdict.label}
            </div>
          )}
          <div className="tt-prob-grid">
            <Stat label="VAL" value={va.val.toFixed(2)} color={C.up} />
            <Stat label="POC" value={va.poc.toFixed(2)} color={C.amber} />
            <Stat label="VAH" value={va.vah.toFixed(2)} color={C.down} />
          </div>
          <div className="tt-prob-bar" title={`Price at ${(va.pricePct * 100).toFixed(0)}% of the ${va.bars}-bar range`}>
            <span className="tt-prob-bar-fill" style={{ width: (va.pricePct * 100).toFixed(1) + "%" }} />
          </div>
        </>
      )}

      {/* Hurst target scaler — what fBm scaling implies for stops/targets */}
      {snap.scaler && (
        <>
          <div className="tt-prob-sec">TARGET SCALER</div>
          <div className="tt-prob-verdict" style={{ color: TONE_COLOR[snap.scaler.tone] }}>{snap.scaler.label}</div>
          {proj && (
            <div className="tt-prob-grid">
              {proj.levels.map((lv) => (
                <Stat key={lv.horizon} label={`±${lv.horizon} BAR`} value={(lv.up - snap.price).toFixed(1)} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Multifractal stress — how turbulent the tape is vs its own recent norm */}
      {snap.stress != null && (
        <>
          <div className="tt-prob-sec">MULTIFRACTAL STRESS</div>
          <div className="tt-prob-bar" title={`${(snap.stress * 100).toFixed(0)}th percentile vs recent windows`}>
            <span className="tt-prob-bar-fill" style={{ width: (snap.stress * 100).toFixed(1) + "%", background: snap.stress > 0.7 ? C.down : snap.stress < 0.3 ? C.up : C.amber }} />
          </div>
        </>
      )}
    </div>
  );
}
