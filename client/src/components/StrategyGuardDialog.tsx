import { useState } from "react";

interface MatchedStrategy {
  id: string;
  name: string;
  matchedKeywords: string[];
}

interface StrategyGuardDialogProps {
  matchedStrategies: MatchedStrategy[];
  onProceedWithout: () => void;
  onProceedAndUpdate: (selectedIds: string[]) => void;
  onCancel: () => void;
}

const MW = {
  bg: "#05080d", panel: "#090d14", border: "#1a2535",
  text: "#c8d8e8", muted: "#4a6080", accent: "#42a5f5",
};

export default function StrategyGuardDialog({
  matchedStrategies,
  onProceedWithout,
  onProceedAndUpdate,
  onCancel,
}: StrategyGuardDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(matchedStrategies.map((s) => s.id)));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 10000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.75)",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: 520, borderRadius: 8, background: MW.panel,
          border: "1.5px solid rgba(245,158,11,0.4)",
          boxShadow: "0 0 40px rgba(0,0,0,0.9)",
          fontFamily: "'Trebuchet MS', monospace",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${MW.border}`, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 16 }}>⚠</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#f59e0b", letterSpacing: "0.04em" }}>Strategy Guard</div>
            <div style={{ fontSize: 10, color: MW.muted, marginTop: 2 }}>
              Your prompt references {matchedStrategies.length === 1 ? "a protected strategy" : `${matchedStrategies.length} protected strategies`}.
              Do you want to update {matchedStrategies.length === 1 ? "it" : "them"} with any changes suggested by Claude?
            </div>
          </div>
        </div>

        {/* Strategy list */}
        <div style={{ padding: "12px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
          {matchedStrategies.map((s) => (
            <label
              key={s.id}
              style={{
                display: "flex", alignItems: "flex-start", gap: 10,
                padding: "10px 12px", borderRadius: 6, cursor: "pointer",
                background: selected.has(s.id) ? "rgba(245,158,11,0.07)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${selected.has(s.id) ? "rgba(245,158,11,0.35)" : MW.border}`,
                transition: "all 0.15s",
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
                style={{ marginTop: 2, accentColor: "#f59e0b", cursor: "pointer" }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: MW.text }}>{s.name}</div>
                <div style={{ fontSize: 10, color: MW.muted, marginTop: 2 }}>
                  Matched: {s.matchedKeywords.slice(0, 4).join(", ")}
                  {s.matchedKeywords.length > 4 ? ` +${s.matchedKeywords.length - 4} more` : ""}
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Actions */}
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${MW.border}`, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              padding: "7px 14px", borderRadius: 4, fontSize: 11, cursor: "pointer",
              background: "transparent", border: `1px solid ${MW.border}`, color: MW.muted,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onProceedWithout}
            style={{
              padding: "7px 14px", borderRadius: 4, fontSize: 11, cursor: "pointer",
              background: "rgba(148,163,184,0.1)", border: "1px solid rgba(148,163,184,0.3)", color: "#94a3b8",
            }}
          >
            Proceed Without Updating
          </button>
          <button
            onClick={() => onProceedAndUpdate(Array.from(selected))}
            disabled={selected.size === 0}
            style={{
              padding: "7px 14px", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: selected.size > 0 ? "pointer" : "not-allowed",
              background: selected.size > 0 ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${selected.size > 0 ? "rgba(245,158,11,0.5)" : MW.border}`,
              color: selected.size > 0 ? "#f59e0b" : MW.muted,
            }}
          >
            Proceed &amp; Update Selected ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
}
