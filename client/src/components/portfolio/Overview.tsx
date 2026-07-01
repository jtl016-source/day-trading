// ── OVERVIEW — long-term holdings, allocation donut, core/satellite bar ───────
import { useMemo, useState } from "react";
import { C } from "../terminal/terminalStyles";
import { useApi, apiPost, fmtMoney, fmtNum, fmtPct, GRADE_COLOR } from "./usePortfolio";

interface HoldingRow {
  ticker: string; shares: number; costBasis: number; isCore?: boolean; note?: string;
  price: number; value: number; cost: number; pl: number; plPct: number; weight: number;
}
interface HoldingsResp {
  holdings: HoldingRow[]; totalValue: number; corePct: number; coreTargetPct: number; coreEtf: string; dataStale: boolean; asOf: number;
}
interface ScreenRow { ticker: string; total: number; grade: string; }

const DONUT_COLORS = ["#2dd4bf", "#1fd98a", "#ffb454", "#4d9bff", "#c4b5fd", "#ff8a5b", "#ff4d6d", "#7c8190"];

export function Overview() {
  const { data, loading, refetch } = useApi<HoldingsResp>("/api/portfolio/holdings", 60_000);
  const scores = useApi<{ rows: ScreenRow[] }>("/api/portfolio/screener?universe=holdings");
  const [modal, setModal] = useState<Partial<HoldingRow> | null>(null);

  const scoreMap = useMemo(() => {
    const m = new Map<string, ScreenRow>();
    for (const r of scores.data?.rows ?? []) m.set(r.ticker, r);
    return m;
  }, [scores.data]);

  const holdings = data?.holdings ?? [];
  const donut = useMemo(() => {
    if (!holdings.length) return "conic-gradient(rgba(255,255,255,0.05) 0 100%)";
    let acc = 0; const stops: string[] = [];
    holdings.forEach((h, i) => {
      const from = acc; acc += h.weight;
      stops.push(`${DONUT_COLORS[i % DONUT_COLORS.length]} ${from}% ${acc}%`);
    });
    return `conic-gradient(${stops.join(",")})`;
  }, [holdings]);

  const corePct = data?.corePct ?? 0;
  const target = data?.coreTargetPct ?? 70;
  const satPct = 100 - corePct;
  const satTarget = 100 - target;
  const over = satPct > satTarget + 0.5;

  const save = async () => {
    if (!modal?.ticker) return;
    await apiPost("/api/portfolio/holdings", {
      ticker: modal.ticker, shares: modal.shares ?? 0, costBasis: modal.costBasis ?? 0, isCore: !!modal.isCore,
    });
    setModal(null); refetch();
  };
  const del = async (ticker: string) => { await apiPost("/api/portfolio/holdings", { action: "delete", ticker }); refetch(); };

  return (
    <div className="tt-view">
      <div className="pf-row2">
        {/* holdings table */}
        <div className="pf-panel">
          <div className="pf-panel-h">
            <b>Long-Term Holdings</b>
            <button className="pf-btn primary" onClick={() => setModal({})}>+ Position</button>
          </div>
          <div className="tt-table-wrap" style={{ border: "none", background: "none" }}>
            <div className="tt-table" style={{ minWidth: 640 }}>
              <div className="tt-thead" style={{ gridTemplateColumns: "0.8fr 0.6fr 0.7fr 0.8fr 0.9fr 0.6fr 0.5fr 36px" }}>
                <span>TICKER</span><span className="r">SHARES</span><span className="r">COST</span>
                <span className="r">VALUE</span><span className="r">P/L</span><span className="r">WT%</span><span className="r">SCORE</span><span></span>
              </div>
              <div className="tt-tbody">
                {!holdings.length && <div className="tt-empty-row">{loading ? "LOADING…" : "NO POSITIONS — ADD ONE"}</div>}
                {holdings.map((h) => {
                  const s = scoreMap.get(h.ticker);
                  return (
                    <div className="tt-trow" key={h.ticker} style={{ gridTemplateColumns: "0.8fr 0.6fr 0.7fr 0.8fr 0.9fr 0.6fr 0.5fr 36px" }}>
                      <span style={{ fontWeight: 600 }}>{h.ticker}{h.isCore && <i style={{ color: C.accent, fontSize: 9, marginLeft: 6, fontStyle: "normal" }}>CORE</i>}</span>
                      <span className="mono r">{fmtNum(h.shares, 0)}</span>
                      <span className="mono r dim">{fmtNum(h.costBasis)}</span>
                      <span className="mono r">{fmtMoney(h.value)}</span>
                      <span className="mono r" style={{ color: h.pl >= 0 ? C.up : C.down }}>{fmtMoney(h.pl)} <i style={{ fontStyle: "normal", fontSize: 10 }}>({fmtPct(h.plPct)})</i></span>
                      <span className="mono r dim">{fmtNum(h.weight, 1)}</span>
                      <span className="r">{s ? <b className="pf-badge" style={{ color: GRADE_COLOR[s.grade], borderColor: GRADE_COLOR[s.grade] + "66" }}>{s.grade} {Math.round(s.total)}</b> : <i className="dim">—</i>}</span>
                      <span className="r"><button className="pf-star" title="Edit" onClick={() => setModal(h)}>✎</button></span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* allocation + core/satellite */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="pf-panel">
            <div className="pf-panel-h"><b>Allocation</b><span className="mono dim">{fmtMoney(data?.totalValue)}</span></div>
            <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
              <div className="pf-donut" style={{ background: donut }} />
              <div className="pf-legend">
                {holdings.slice(0, 8).map((h, i) => (
                  <div className="pf-leg-row" key={h.ticker}>
                    <span className="pf-leg-dot" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                    <span>{h.ticker}</span><span className="pf-leg-w mono">{fmtNum(h.weight, 1)}%</span>
                  </div>
                ))}
                {!holdings.length && <span className="dim" style={{ fontSize: 12 }}>No positions yet</span>}
              </div>
            </div>
          </div>
          <div className="pf-panel">
            <div className="pf-panel-h"><b>Core / Satellite</b><span className="mono dim">target {target}/{satTarget}</span></div>
            <div className={`pf-cs-bar${over ? " over" : ""}`}>
              <div className="pf-cs-core" style={{ width: `${Math.max(corePct, 8)}%` }}>{fmtNum(corePct, 0)}% CORE</div>
              <div className="pf-cs-sat" style={{ width: `${Math.max(satPct, 8)}%` }}>{fmtNum(satPct, 0)}% SAT</div>
            </div>
            <div className="pf-cs-note">
              {over
                ? <span className="pf-cs-warn">⚠ Satellites {fmtNum(satPct, 0)}% exceed the {satTarget}% target — trim individual picks toward {data?.coreEtf ?? "VTI"}.</span>
                : <span>Within target. Core index ({data?.coreEtf ?? "VTI"}) {fmtNum(corePct, 0)}% / individual picks {fmtNum(satPct, 0)}%. Mark a holding CORE when editing.</span>}
            </div>
          </div>
        </div>
      </div>

      {modal && (
        <div className="pf-modal-back" onClick={() => setModal(null)}>
          <div className="pf-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pf-panel-h"><b>{modal.ticker ? `Edit ${modal.ticker}` : "Add Position"}</b></div>
            <div className="pf-field"><label>Ticker</label>
              <input className="pf-input" value={modal.ticker ?? ""} disabled={!!modal.value}
                onChange={(e) => setModal({ ...modal, ticker: e.target.value.toUpperCase() })} placeholder="AAPL" /></div>
            <div className="pf-field"><label>Shares</label>
              <input className="pf-input" type="number" value={modal.shares ?? ""} onChange={(e) => setModal({ ...modal, shares: parseFloat(e.target.value) })} /></div>
            <div className="pf-field"><label>Cost Basis (per share)</label>
              <input className="pf-input" type="number" value={modal.costBasis ?? ""} onChange={(e) => setModal({ ...modal, costBasis: parseFloat(e.target.value) })} /></div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.muted, margin: "4px 0 16px" }}>
              <input type="checkbox" checked={!!modal.isCore} onChange={(e) => setModal({ ...modal, isCore: e.target.checked })} /> Core index ETF (counts toward core target)
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {modal.ticker && modal.value !== undefined && <button className="pf-btn ghost" style={{ marginRight: "auto", color: C.down }} onClick={() => { del(modal.ticker!); setModal(null); }}>Delete</button>}
              <button className="pf-btn ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="pf-btn primary" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
