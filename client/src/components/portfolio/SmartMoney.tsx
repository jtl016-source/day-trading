// ── SMART MONEY — superinvestor grid + cross-fund consensus ───────────────────
import { useState } from "react";
import { C } from "../terminal/terminalStyles";
import { useApi, fmtCompact, fmtNum } from "./usePortfolio";

interface FundSummary { cik: string; manager: string; fund: string; portfolioValue: number; asOf: string; topTickers: string[]; }
interface Holding { ticker: string; name: string; weight: number; marketValue: number; change: string; changePct: number | null; }
interface FullFund { cik: string; manager: string; fund: string; portfolioValue: number; asOf: string; topHoldings: Holding[]; newBuys: Holding[]; exits: Holding[]; }
interface ConsensusRow { ticker: string; holders: number; adders: number; funds: string[]; }

const CHANGE_COLOR: Record<string, string> = { new: "#2dd4bf", add: "#1fd98a", trim: "#ff8a5b", exit: "#ffb454", hold: "#7c8190" };

export function SmartMoney() {
  const funds = useApi<{ funds: FundSummary[] }>("/api/portfolio/smartmoney/funds");
  const consensus = useApi<{ consensus: ConsensusRow[] }>("/api/portfolio/smartmoney/consensus");
  const [openCik, setOpenCik] = useState<string | null>(null);

  return (
    <div className="tt-view pf-2col">
      {/* fund grid */}
      <div className="pf-panel">
        <div className="pf-panel-h"><b>Superinvestors</b><span className="dim mono">{funds.data?.funds?.length ?? 0} funds</span></div>
        {funds.loading && <div className="pf-empty">LOADING 13F HOLDINGS…</div>}
        <div className="pf-funds">
          {(funds.data?.funds ?? []).map((f) => (
            <div className="pf-fund" key={f.cik} onClick={() => setOpenCik(f.cik)}>
              <div className="pf-fund-mgr">{f.manager}</div>
              <div className="pf-fund-name">{f.fund}</div>
              <div className="pf-fund-val">{fmtCompact(f.portfolioValue)} · {f.asOf || "—"}</div>
              <div style={{ marginTop: 9 }}>
                {f.topTickers.length
                  ? f.topTickers.map((t) => <span key={t} className="tt-active-chip" style={{ marginRight: 5, marginBottom: 5, display: "inline-flex" }}>{t}</span>)
                  : <span className="dim" style={{ fontSize: 11 }}>no data (verify CIK)</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* consensus */}
      <div className="pf-panel">
        <div className="pf-panel-h"><b>Consensus — Most Owned</b><span className="dim mono">copy the best</span></div>
        <div className="tt-table" style={{ minWidth: 0 }}>
          <div className="tt-thead" style={{ gridTemplateColumns: "1fr 0.6fr 0.6fr 1.4fr" }}>
            <span>TICKER</span><span className="r">HOLDERS</span><span className="r">ADDING</span><span>FUNDS</span>
          </div>
          <div className="tt-tbody">
            {consensus.loading && <div className="tt-empty-row">BUILDING CONSENSUS…</div>}
            {(consensus.data?.consensus ?? []).slice(0, 30).map((r) => (
              <div className="tt-trow" key={r.ticker} style={{ gridTemplateColumns: "1fr 0.6fr 0.6fr 1.4fr" }}>
                <span style={{ fontWeight: 600 }}>{r.ticker}</span>
                <span className="r mono" style={{ color: C.accent }}>{r.holders}</span>
                <span className="r mono" style={{ color: r.adders ? C.up : C.muted }}>{r.adders}</span>
                <span className="dim" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.funds.slice(0, 3).join(", ")}{r.funds.length > 3 ? "…" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {openCik && <FundDrawer cik={openCik} onClose={() => setOpenCik(null)} />}
    </div>
  );
}

function FundDrawer({ cik, onClose }: { cik: string; onClose: () => void }) {
  const { data, loading } = useApi<{ fund: FullFund | null }>(`/api/portfolio/smartmoney/fund/${cik}`);
  const f = data?.fund;
  return (
    <>
      <div className="pf-drawer-back" onClick={onClose} />
      <div className="pf-drawer" style={{ width: "min(560px,94vw)" }}>
        <div className="pf-panel-h">
          <div><div className="pf-title" style={{ fontSize: 20 }}>{f?.manager ?? "…"}</div><div className="pf-sub">{f?.fund} · {f?.asOf}</div></div>
          <span className="mono" style={{ color: C.accent }}>{fmtCompact(f?.portfolioValue ?? 0)}</span>
        </div>
        {loading && <div className="pf-empty">LOADING HOLDINGS…</div>}
        {f && !f.topHoldings.length && <div className="pf-keyhint">No holdings returned — the CIK may be stale. See PORTFOLIO_README → "add/remove superinvestor CIKs".</div>}
        {f && !!f.topHoldings.length && (
          <div className="tt-table" style={{ minWidth: 0, marginTop: 8 }}>
            <div className="tt-thead" style={{ gridTemplateColumns: "1fr 0.6fr 0.7fr 0.8fr" }}>
              <span>TICKER</span><span className="r">WEIGHT</span><span className="r">VALUE</span><span className="r">QoQ</span>
            </div>
            <div className="tt-tbody">
              {f.topHoldings.map((h) => (
                <div className="tt-trow" key={h.ticker} style={{ gridTemplateColumns: "1fr 0.6fr 0.7fr 0.8fr" }}>
                  <span style={{ fontWeight: 600 }}>{h.ticker}</span>
                  <span className="r mono">{fmtNum(h.weight, 1)}%</span>
                  <span className="r mono dim">{fmtCompact(h.marketValue)}</span>
                  <span className="r mono" style={{ color: CHANGE_COLOR[h.change] ?? C.muted }}>{h.change.toUpperCase()}{h.changePct != null && h.change !== "new" && h.change !== "exit" ? ` ${fmtNum(h.changePct, 0)}%` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}><button className="pf-btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </>
  );
}
