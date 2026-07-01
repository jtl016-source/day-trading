// ── SCREENER — confluence-scored universe, pillar filters, transparency drawer ─
import { useMemo, useState } from "react";
import { C } from "../terminal/terminalStyles";
import { useApi, apiPost, fmtNum, GRADE_COLOR } from "./usePortfolio";

type Metrics = Record<string, number | string | null>;
interface Pillars { quality: P; value: P; momentum: P; smartMoney: P; congressInsider: P; }
interface P { score: number; max: number; metrics: Metrics; }
interface Row { ticker: string; total: number; grade: string; pillars: Pillars; flags: string[]; dataStale: boolean; }

const PILLAR_KEYS: (keyof Pillars)[] = ["quality", "value", "momentum", "smartMoney", "congressInsider"];
const PILLAR_LABEL: Record<string, string> = { quality: "Quality", value: "Value", momentum: "Momentum", smartMoney: "Smart Money", congressInsider: "Congress+Insider" };

export function Screener() {
  const { data, loading, refetch } = useApi<{ rows: Row[] }>("/api/portfolio/screener");
  const [active, setActive] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Row | null>(null);
  const [tickerInput, setTickerInput] = useState("");

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    if (!active.size) return all;
    return all.filter((r) => [...active].every((k) => {
      const p = r.pillars[k as keyof Pillars];
      return p.score >= p.max * 0.6; // chip = "strong in this pillar"
    }));
  }, [data, active]);

  const toggle = (k: string) => setActive((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const addTicker = async () => {
    const t = tickerInput.trim().toUpperCase();
    if (!t) return;
    await apiPost("/api/portfolio/watchlist", { ticker: t });
    setTickerInput(""); refetch();
  };

  return (
    <div className="tt-view">
      <div className="pf-panel-h" style={{ marginBottom: 14 }}>
        <div className="tt-filters" style={{ margin: 0 }}>
          {PILLAR_KEYS.map((k) => (
            <button key={k} className="tt-filter" onClick={() => toggle(k)}
              style={active.has(k) ? { color: C.accent, borderColor: "rgba(45,212,191,0.4)", background: "rgba(45,212,191,0.1)" } : undefined}>
              {PILLAR_LABEL[k]}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="pf-input" style={{ width: 130, padding: "7px 10px" }} placeholder="Add ticker…"
            value={tickerInput} onChange={(e) => setTickerInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTicker()} />
          <button className="pf-btn primary" onClick={addTicker}>+ Track</button>
        </div>
      </div>

      <div className="tt-table-wrap">
        <div className="tt-table" style={{ minWidth: 760 }}>
          <div className="tt-thead" style={{ gridTemplateColumns: "40px 1fr 0.7fr repeat(5,0.7fr)" }}>
            <span>#</span><span>TICKER</span><span className="r">SCORE</span>
            {PILLAR_KEYS.map((k) => <span key={k} className="r">{PILLAR_LABEL[k].split(" ")[0].toUpperCase()}</span>)}
          </div>
          <div className="tt-tbody">
            {!rows.length && <div className="tt-empty-row">{loading ? "SCORING UNIVERSE…" : "NO TICKERS — ADD SOME TO THE WATCHLIST ABOVE"}</div>}
            {rows.map((r, i) => (
              <div className="tt-trow clickable" key={r.ticker} onClick={() => setSel(r)}
                style={{ gridTemplateColumns: "40px 1fr 0.7fr repeat(5,0.7fr)" }}>
                <span className="dim mono">{i + 1}</span>
                <span style={{ fontWeight: 600 }}>{r.ticker}{r.dataStale && <i title="stale data" style={{ color: C.amber, marginLeft: 6 }}>•</i>}</span>
                <span className="r"><b className="pf-badge" style={{ color: GRADE_COLOR[r.grade], borderColor: GRADE_COLOR[r.grade] + "66" }}>{r.grade} {Math.round(r.total)}</b></span>
                {PILLAR_KEYS.map((k) => {
                  const p = r.pillars[k];
                  return <span key={k} className="r mono" style={{ color: p.score >= p.max * 0.6 ? C.accent : C.muted }}>{fmtNum(p.score, 0)}<i className="dim" style={{ fontStyle: "normal", fontSize: 10 }}>/{p.max}</i></span>;
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {sel && <Drawer row={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function Drawer({ row, onClose }: { row: Row; onClose: () => void }) {
  return (
    <>
      <div className="pf-drawer-back" onClick={onClose} />
      <div className="pf-drawer">
        <div className="pf-panel-h">
          <div><div className="pf-title" style={{ fontSize: 22 }}>{row.ticker}</div><div className="pf-sub">confluence breakdown</div></div>
          <b className="pf-badge" style={{ fontSize: 16, padding: "6px 12px", color: GRADE_COLOR[row.grade], borderColor: GRADE_COLOR[row.grade] + "66" }}>{row.grade} · {Math.round(row.total)}</b>
        </div>

        {!!row.flags.length && <div className="pf-flags" style={{ margin: "10px 0 18px" }}>{row.flags.map((f) => <span key={f} className="pf-flag">{f}</span>)}</div>}

        {PILLAR_KEYS.map((k) => {
          const p = row.pillars[k];
          return (
            <div className="pf-pillar" key={k} style={{ marginBottom: 18 }}>
              <div className="pf-pillar-top">
                <span className="pf-pillar-l">{PILLAR_LABEL[k]}</span>
                <span className="pf-pillar-v">{fmtNum(p.score, 1)} / {p.max}</span>
              </div>
              <div className="pf-track"><div className="pf-fill" style={{ width: `${Math.max(0, Math.min(100, (p.score / p.max) * 100))}%` }} /></div>
              <div className="pf-metrics">
                {Object.entries(p.metrics).map(([key, val]) => (
                  <div className="pf-metric" key={key}><span>{labelize(key)}</span><b>{val === null ? "—" : String(val)}</b></div>
                ))}
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button className="pf-btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}

const labelize = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/(\d+)/g, " $1");
