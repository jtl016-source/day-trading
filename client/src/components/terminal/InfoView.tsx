// InfoView.tsx — the Info tab: a detailed description of each confirmation strategy and how
// it's used, plus a "how signals fire" overview. Reuses the terminal's corner-bracket card.
import { C } from "./terminalStyles";
import { STRATS, SIGNAL_OVERVIEW } from "./strategyMeta";

const stratColor: Record<string, string> = {
  MilkZone: C.accent,
  Vector: "#a855f7",
  Footprint: C.amber,
};

function Corners() {
  return (
    <>
      <span className="tt-corner tl" /><span className="tt-corner tr" />
      <span className="tt-corner bl" /><span className="tt-corner br" />
    </>
  );
}

export function InfoView() {
  return (
    <div className="tt-info" style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 40 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1, color: C.text }}>Strategy Guide</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
          How each confirmation strategy works and how to use it. Toggle them in <b style={{ color: C.accent }}>Strategies</b>.
        </div>
      </div>

      {STRATS.map((s) => {
        const col = stratColor[s.key] ?? C.accent;
        return (
          <div key={s.key} className="tt-card" style={{ position: "relative" }}>
            <Corners />
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.5, color: col }}>{s.title}</div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{s.tagline}</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: col, border: `1px solid ${col}55`, background: `${col}14`, padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap" }}>
                {s.stat}
              </span>
            </div>

            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              {s.how.map((p, i) => (
                <p key={i} style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "#aeb4c0" }}>{p}</p>
              ))}
            </div>

            <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: `${col}10`, border: `1px solid ${col}33` }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: col, marginBottom: 4 }}>WHAT CONFIRMS IT</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: C.text }}>{s.signals}</div>
            </div>

            <ul style={{ margin: "12px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
              {s.tips.map((t, i) => (
                <li key={i} style={{ fontSize: 12, lineHeight: 1.5, color: C.muted }}>{t}</li>
              ))}
            </ul>
          </div>
        );
      })}

      <div className="tt-card" style={{ position: "relative" }}>
        <Corners />
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.5, color: C.text }}>{SIGNAL_OVERVIEW.title}</div>
        <ul style={{ margin: "10px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7 }}>
          {SIGNAL_OVERVIEW.points.map((p, i) => (
            <li key={i} style={{ fontSize: 12.5, lineHeight: 1.55, color: C.muted }}>{p}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
