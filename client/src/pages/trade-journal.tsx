import { useState, useEffect } from "react";
import { Link } from "wouter";

const MW = {
  bg:      "#05080d",
  panel:   "#090d14",
  toolbar: "#0b1018",
  border:  "#111a26",
  text:    "#b8c8d8",
  muted:   "#4a6080",
  accent:  "#1a72d4",
};

type Outcome     = "win_tp1" | "win_tp2" | "loss" | "breakeven" | "";
type RiskLevel   = "safe" | "risky" | "riskiest";
type EmotionState = "calm" | "fomo" | "fear" | "revenge" | "other";
type SetupType   = "side_entry" | "tabletop" | "confluence" | "pattern" | "other" | "";

interface JournalEntry {
  id:            number;
  timestamp:     number;
  symbol:        string;
  direction:     string;
  signal_id:     number | null;
  entry_price:   number;
  exit_price:    number | null;
  outcome:       string | null;
  pnl_pts:       number | null;
  pnl_dollars:   number | null;
  risk_level:    string;
  followed_plan: number;
  emotion_state: string;
  setup_type:    string | null;
  notes:         string | null;
  error_made:    string | null;
  created_at:    string | null;
}

interface JournalStats {
  total:           number;
  closed:          number;
  wins:            number;
  losses:          number;
  winRate:         number;
  totalPnlDollars: number;
  byEmotion: Record<string, { count: number; wins: number; losses: number }>;
  byPlan:    Record<string, { count: number; wins: number }>;
}

const OUTCOME_LABEL: Record<string, string> = {
  win_tp1: "TP1 Win", win_tp2: "TP2 Win", loss: "Loss", breakeven: "Breakeven",
};
const OUTCOME_COLOR: Record<string, string> = {
  win_tp1: "#4ade80", win_tp2: "#22c55e", loss: "#f87171", breakeven: "#94a3b8",
};
const OUTCOME_BG: Record<string, string> = {
  win_tp1: "#193a28", win_tp2: "#16422e", loss: "#3b1212", breakeven: "#1e2535",
};
const EMOTION_LABEL: Record<string, string> = {
  calm: "Calm", fomo: "FOMO", fear: "Fear", revenge: "Revenge", other: "Other",
};

function pnlColor(v: number | null): string {
  if (v == null || v === 0) return MW.muted;
  return v > 0 ? "#4ade80" : "#f87171";
}

function fmtPnl(v: number | null): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

function now(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseTs(dateStr: string): number {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

function calcPnl(entry: number, exit: number | null, direction: string): { pts: number | null; dollars: number | null } {
  if (exit == null) return { pts: null, dollars: null };
  const pts = direction === "Long" ? exit - entry : entry - exit;
  return { pts, dollars: pts * 5 };
}

export default function TradeJournalPage() {
  const [entries, setEntries]  = useState<JournalEntry[]>([]);
  const [stats, setStats]      = useState<JournalStats | null>(null);
  const [saving, setSaving]    = useState(false);
  const [editId, setEditId]    = useState<number | null>(null);
  const [showForm, setShowForm] = useState(true);

  // Form state
  const [dateStr, setDateStr]   = useState(now);
  const [symbol, setSymbol]     = useState("MES");
  const [direction, setDir]     = useState<"Long" | "Short">("Long");
  const [entryPrice, setEntry]  = useState("");
  const [exitPrice, setExit]    = useState("");
  const [outcome, setOutcome]   = useState<Outcome>("");
  const [riskLevel, setRisk]    = useState<RiskLevel>("safe");
  const [followedPlan, setFol]  = useState(true);
  const [emotionState, setEmo]  = useState<EmotionState>("calm");
  const [setupType, setSetup]   = useState<SetupType>("");
  const [notes, setNotes]       = useState("");
  const [errorMade, setError]   = useState("");

  const load = async () => {
    const [eRes, sRes] = await Promise.all([
      fetch("/api/journal"),
      fetch("/api/journal/stats"),
    ]);
    if (eRes.ok) setEntries(await eRes.json());
    if (sRes.ok) setStats(await sRes.json());
  };

  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setDateStr(now());
    setSymbol("MES");
    setDir("Long");
    setEntry("");
    setExit("");
    setOutcome("");
    setRisk("safe");
    setFol(true);
    setEmo("calm");
    setSetup("");
    setNotes("");
    setError("");
    setEditId(null);
  };

  const startEdit = (e: JournalEntry) => {
    const d = new Date(e.timestamp * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    setDateStr(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
    setSymbol(e.symbol);
    setDir(e.direction as "Long" | "Short");
    setEntry(String(e.entry_price));
    setExit(e.exit_price != null ? String(e.exit_price) : "");
    setOutcome((e.outcome ?? "") as Outcome);
    setRisk((e.risk_level ?? "safe") as RiskLevel);
    setFol(!!e.followed_plan);
    setEmo((e.emotion_state ?? "calm") as EmotionState);
    setSetup((e.setup_type ?? "") as SetupType);
    setNotes(e.notes ?? "");
    setError(e.error_made ?? "");
    setEditId(e.id);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    if (!entryPrice || !dateStr) return;
    setSaving(true);
    const ep = parseFloat(entryPrice);
    const xp = exitPrice ? parseFloat(exitPrice) : null;
    const { pts, dollars } = calcPnl(ep, xp, direction);
    const body = {
      timestamp: parseTs(dateStr),
      symbol, direction,
      entryPrice: ep,
      exitPrice: xp,
      outcome:   outcome || null,
      pnlPts:    pts,
      pnlDollars: dollars,
      riskLevel, followedPlan,
      emotionState, setupType: setupType || null,
      notes: notes || null, errorMade: errorMade || null,
    };
    if (editId != null) {
      await fetch(`/api/journal/${editId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      await fetch("/api/journal", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    setSaving(false);
    resetForm();
    load();
  };

  const deleteEntry = async (id: number) => {
    if (!confirm("Delete this journal entry?")) return;
    await fetch(`/api/journal/${id}`, { method: "DELETE" });
    load();
  };

  const inputStyle: React.CSSProperties = {
    height: 30, padding: "0 8px", borderRadius: 4,
    background: MW.bg, border: `1px solid ${MW.border}`,
    color: MW.text, fontSize: 12, width: "100%",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10, color: MW.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 3, display: "block",
  };
  const fieldBox: React.CSSProperties = { display: "flex", flexDirection: "column" };

  const toggleBtn = (active: boolean, label: string, color: string, onClick: () => void) => (
    <button onClick={onClick} style={{
      padding: "3px 12px", borderRadius: 4, fontSize: 12, cursor: "pointer",
      background: active ? color + "22" : "transparent",
      border: `1px solid ${active ? color : MW.border}`,
      color: active ? color : MW.muted,
      fontWeight: active ? 700 : 400,
    }}>
      {label}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: MW.bg, color: MW.text, fontFamily: "'Trebuchet MS', 'Roboto', sans-serif", overflow: "hidden" }}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 12px", height: 44, background: MW.toolbar, borderBottom: `1px solid ${MW.border}`, flexShrink: 0 }}>
        <Link href="/">
          <button style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, cursor: "pointer", background: "transparent", border: `1px solid ${MW.border}`, color: MW.muted }}>
            ← Market
          </button>
        </Link>
        <div style={{ width: 1, height: 20, background: MW.border }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: MW.text }}>Trade Journal</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => { resetForm(); setShowForm(f => !f); }} style={{
          padding: "3px 12px", borderRadius: 4, fontSize: 11, cursor: "pointer",
          background: showForm ? "#1a72d422" : "transparent",
          border: `1px solid ${showForm ? MW.accent : MW.border}`,
          color: showForm ? "#60a5fa" : MW.muted,
        }}>
          {showForm ? "Hide Form" : "+ Log Trade"}
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Entry Form */}
        {showForm && (
          <div style={{ background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 6, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: MW.text, marginBottom: 12 }}>
              {editId != null ? "Edit Entry" : "Log a Trade"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>

              <div style={fieldBox}>
                <label style={labelStyle}>Date / Time</label>
                <input value={dateStr} onChange={e => setDateStr(e.target.value)} placeholder="YYYY-MM-DD HH:MM" style={inputStyle} />
              </div>

              <div style={fieldBox}>
                <label style={labelStyle}>Symbol</label>
                <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} style={inputStyle} />
              </div>

              <div style={fieldBox}>
                <label style={labelStyle}>Direction</label>
                <div style={{ display: "flex", gap: 4 }}>
                  {toggleBtn(direction === "Long",  "Long",  "#4ade80", () => setDir("Long"))}
                  {toggleBtn(direction === "Short", "Short", "#f87171", () => setDir("Short"))}
                </div>
              </div>

              <div style={fieldBox}>
                <label style={labelStyle}>Entry Price</label>
                <input type="number" value={entryPrice} onChange={e => setEntry(e.target.value)} placeholder="e.g. 5842.25" style={inputStyle} />
              </div>

              <div style={fieldBox}>
                <label style={labelStyle}>Exit Price</label>
                <input type="number" value={exitPrice} onChange={e => setExit(e.target.value)} placeholder="(leave blank if open)" style={inputStyle} />
              </div>

              <div style={fieldBox}>
                <label style={labelStyle}>Outcome</label>
                <select value={outcome} onChange={e => setOutcome(e.target.value as Outcome)} style={{ ...inputStyle, height: 30, cursor: "pointer" }}>
                  <option value="">— open —</option>
                  <option value="win_tp1">TP1 Win</option>
                  <option value="win_tp2">TP2 Win</option>
                  <option value="loss">Loss</option>
                  <option value="breakeven">Breakeven</option>
                </select>
              </div>

              <div style={fieldBox}>
                <label style={labelStyle}>Risk Level</label>
                <select value={riskLevel} onChange={e => setRisk(e.target.value as RiskLevel)} style={{ ...inputStyle, height: 30, cursor: "pointer" }}>
                  <option value="safe">Safe</option>
                  <option value="risky">Risky</option>
                  <option value="riskiest">Riskiest</option>
                </select>
              </div>

              <div style={fieldBox}>
                <label style={labelStyle}>Followed Plan?</label>
                <div style={{ display: "flex", gap: 4 }}>
                  {toggleBtn(followedPlan,  "Yes", "#4ade80", () => setFol(true))}
                  {toggleBtn(!followedPlan, "No",  "#f87171", () => setFol(false))}
                </div>
              </div>

              <div style={fieldBox}>
                <label style={labelStyle}>Emotion State</label>
                <select value={emotionState} onChange={e => setEmo(e.target.value as EmotionState)} style={{ ...inputStyle, height: 30, cursor: "pointer" }}>
                  <option value="calm">Calm</option>
                  <option value="fomo">FOMO</option>
                  <option value="fear">Fear</option>
                  <option value="revenge">Revenge</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div style={fieldBox}>
                <label style={labelStyle}>Setup Type</label>
                <select value={setupType} onChange={e => setSetup(e.target.value as SetupType)} style={{ ...inputStyle, height: 30, cursor: "pointer" }}>
                  <option value="">— unspecified —</option>
                  <option value="side_entry">Side Entry</option>
                  <option value="tabletop">Tabletop</option>
                  <option value="confluence">Confluence</option>
                  <option value="pattern">Pattern</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <div style={fieldBox}>
                <label style={labelStyle}>Notes</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="What happened, key observations..." style={{ ...inputStyle, height: "auto", padding: "6px 8px", resize: "vertical" }} />
              </div>
              <div style={fieldBox}>
                <label style={labelStyle}>Error / What Could Be Better</label>
                <textarea value={errorMade} onChange={e => setError(e.target.value)} rows={3} placeholder="Entered too early, chased price, ignored 60m veto..." style={{ ...inputStyle, height: "auto", padding: "6px 8px", resize: "vertical" }} />
              </div>
            </div>

            {entryPrice && exitPrice && (
              <div style={{ marginTop: 8, fontSize: 11, color: MW.muted }}>
                Auto P&L: {(() => {
                  const { pts, dollars } = calcPnl(parseFloat(entryPrice), parseFloat(exitPrice), direction);
                  if (pts == null) return "—";
                  return <span style={{ color: pnlColor(pts) }}>{fmtPnl(pts)} pts / {fmtPnl(dollars)} USD</span>;
                })()}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={save} disabled={saving || !entryPrice || !dateStr} style={{
                padding: "5px 20px", borderRadius: 4, fontSize: 12, cursor: "pointer", fontWeight: 700,
                background: "#1a72d4", border: "none", color: "#fff", opacity: saving ? 0.5 : 1,
              }}>
                {saving ? "Saving…" : editId != null ? "Update Entry" : "Save Trade"}
              </button>
              {editId != null && (
                <button onClick={resetForm} style={{ padding: "5px 14px", borderRadius: 4, fontSize: 12, cursor: "pointer", background: "transparent", border: `1px solid ${MW.border}`, color: MW.muted }}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {/* Stats Panel */}
        {stats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>

            {/* Summary card */}
            <div style={{ background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 6, padding: 14 }}>
              <div style={{ fontSize: 10, color: MW.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Overall Performance</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: MW.muted }}>Total Trades</span>
                  <span style={{ fontSize: 12, color: MW.text, fontWeight: 700 }}>{stats.total}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: MW.muted }}>Win Rate</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: stats.winRate >= 0.6 ? "#4ade80" : stats.winRate >= 0.45 ? "#f59e0b" : "#f87171" }}>
                    {stats.closed > 0 ? (stats.winRate * 100).toFixed(0) + "%" : "—"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: MW.muted }}>Wins / Losses</span>
                  <span style={{ fontSize: 12, color: MW.text }}>{stats.wins} / {stats.losses}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: MW.muted }}>Total P&L</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: pnlColor(stats.totalPnlDollars) }}>
                    {fmtPnl(stats.totalPnlDollars)} USD
                  </span>
                </div>
              </div>
            </div>

            {/* By emotion */}
            <div style={{ background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 6, padding: 14 }}>
              <div style={{ fontSize: 10, color: MW.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Win Rate by Emotion</div>
              {Object.entries(stats.byEmotion).length === 0 && <div style={{ fontSize: 11, color: MW.muted }}>No closed trades yet</div>}
              {Object.entries(stats.byEmotion).map(([em, s]) => (
                <div key={em} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: em === "calm" ? "#4ade80" : em === "fomo" || em === "revenge" ? "#f87171" : "#f59e0b" }}>
                    {EMOTION_LABEL[em] ?? em}
                  </span>
                  <span style={{ fontSize: 11, color: MW.text }}>
                    {s.count > 0 ? (s.wins / s.count * 100).toFixed(0) + "%" : "—"} ({s.count})
                  </span>
                </div>
              ))}
            </div>

            {/* By plan adherence */}
            <div style={{ background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 6, padding: 14 }}>
              <div style={{ fontSize: 10, color: MW.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Plan Adherence</div>
              {Object.entries(stats.byPlan).length === 0 && <div style={{ fontSize: 11, color: MW.muted }}>No closed trades yet</div>}
              {Object.entries(stats.byPlan).map(([k, s]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: k === "followed" ? "#4ade80" : "#f87171" }}>
                    {k === "followed" ? "Followed Plan" : "Deviated"}
                  </span>
                  <span style={{ fontSize: 11, color: MW.text }}>
                    {s.count > 0 ? (s.wins / s.count * 100).toFixed(0) + "%" : "—"} ({s.count})
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Trade List */}
        <div style={{ background: MW.panel, border: `1px solid ${MW.border}`, borderRadius: 6, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${MW.border}`, fontSize: 11, fontWeight: 700, color: MW.text }}>
            Trade History ({entries.length} entries)
          </div>
          {entries.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: MW.muted }}>
              No trades logged yet. Log your first trade above.
            </div>
          )}
          {entries.map(e => {
            const d = new Date(e.timestamp * 1000);
            const dateLabel = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
            const timeLabel = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
            const oc = e.outcome ?? "";
            const pnl = e.pnl_dollars;
            return (
              <div key={e.id} style={{
                display: "grid", gridTemplateColumns: "80px 60px 55px 80px 80px 80px 70px 1fr auto",
                gap: 8, padding: "7px 14px", borderBottom: `1px solid ${MW.border}22`,
                alignItems: "center", fontSize: 11,
              }}>
                <span style={{ color: MW.muted }}>{dateLabel} {timeLabel}</span>
                <span style={{ color: e.direction === "Long" ? "#4ade80" : "#f87171", fontWeight: 700 }}>{e.direction}</span>
                <span style={{ color: MW.muted }}>{e.symbol}</span>
                <span style={{ color: MW.text }}>@ {e.entry_price.toFixed(2)}</span>
                <span style={{ color: MW.muted }}>{e.exit_price != null ? `→ ${e.exit_price.toFixed(2)}` : "open"}</span>
                {oc ? (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: OUTCOME_BG[oc] ?? "#1e2535", color: OUTCOME_COLOR[oc] ?? MW.muted }}>
                    {OUTCOME_LABEL[oc] ?? oc}
                  </span>
                ) : <span style={{ fontSize: 10, color: MW.muted }}>Open</span>}
                <span style={{ color: pnlColor(pnl), fontWeight: pnl != null ? 700 : 400 }}>
                  {pnl != null ? `${pnl > 0 ? "+" : ""}$${pnl.toFixed(0)}` : "—"}
                </span>
                <span style={{ color: MW.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {[
                    e.emotion_state !== "calm" ? EMOTION_LABEL[e.emotion_state] : null,
                    !e.followed_plan ? "Deviated" : null,
                    e.notes,
                  ].filter(Boolean).join(" · ")}
                </span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => startEdit(e)} style={{ padding: "2px 8px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "transparent", border: `1px solid ${MW.border}`, color: MW.muted }}>
                    Edit
                  </button>
                  <button onClick={() => deleteEntry(e.id)} style={{ padding: "2px 8px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "transparent", border: `1px solid #3b1212`, color: "#f87171" }}>
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
