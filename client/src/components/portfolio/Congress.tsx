// ── CONGRESS — disclosures feed, leaderboard, followed politicians ────────────
import { useMemo, useState } from "react";
import { C } from "../terminal/terminalStyles";
import { useApi, apiPost, fmtDate, partyColor } from "./usePortfolio";

interface Trade { politician: string; party: string; chamber: string; ticker: string; type: "buy" | "sell"; amountRange: string; transactionDate: string; disclosureDate: string; lagDays: number; }
interface Leader { politician: string; party: string; chamber: string; buys: number; sells: number; topTickers: { ticker: string; count: number }[]; convictionTickers: string[]; estNotional: number; }

export function Congress() {
  const recent = useApi<{ trades: Trade[]; followed: string[] }>("/api/portfolio/congress/recent");
  const leaders = useApi<{ leaders: Leader[] }>("/api/portfolio/congress/leaders");
  const [followed, setFollowed] = useState<string[] | null>(null);
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem("pf_congress_banner") === "1");

  const follow = followed ?? recent.data?.followed ?? [];
  const toggleFollow = async (p: string) => {
    const res = await apiPost("/api/portfolio/congress/follow", { politician: p });
    setFollowed(res.followed ?? []);
  };

  const trades = useMemo(() => {
    const all = recent.data?.trades ?? [];
    return onlyFollowed ? all.filter((t) => follow.includes(t.politician)) : all;
  }, [recent.data, onlyFollowed, follow]);

  return (
    <div className="tt-view">
      {!dismissed && (
        <div className="pf-banner">
          ⚠ Congressional trades are disclosed up to 45 days late and are informational only — not a recommendation to trade.
          <button onClick={() => { localStorage.setItem("pf_congress_banner", "1"); setDismissed(true); }}>Got it</button>
        </div>
      )}

      <div className="pf-2col">
        {/* feed */}
        <div className="pf-panel">
          <div className="pf-panel-h">
            <b>Recent Disclosures</b>
            <button className="tt-filter" onClick={() => setOnlyFollowed((v) => !v)}
              style={onlyFollowed ? { color: C.amber, borderColor: "rgba(255,180,84,0.4)", background: "rgba(255,180,84,0.1)" } : undefined}>
              ★ Followed only
            </button>
          </div>
          <div className="tt-table" style={{ minWidth: 0 }}>
            <div className="tt-thead pf-feed-row" style={{ padding: "11px 14px" }}>
              <span>POLITICIAN</span><span>TICKER</span><span>SIDE</span><span className="r">AMOUNT</span><span className="r">DATES</span><span></span>
            </div>
            <div className="tt-tbody" style={{ maxHeight: 460, overflowY: "auto" }}>
              {recent.loading && <div className="tt-empty-row">LOADING DISCLOSURES…</div>}
              {!recent.loading && !trades.length && <div className="tt-empty-row">NO DISCLOSURES IN THE LAST 90 DAYS</div>}
              {trades.slice(0, 80).map((t, i) => (
                <div className="pf-feed-row" key={i}>
                  <div className="pf-pol">
                    <span className="pf-pol-dot" style={{ background: partyColor(t.party) }} />
                    <span style={{ fontWeight: 600 }}>{t.politician}</span>
                    <i className="dim" style={{ fontStyle: "normal", fontSize: 9, textTransform: "uppercase" }}>{t.chamber}</i>
                  </div>
                  <span style={{ fontWeight: 600 }}>{t.ticker}</span>
                  <span className={t.type === "buy" ? "pf-side-buy" : "pf-side-sell"}>{t.type.toUpperCase()}</span>
                  <span className="pf-tbl-num dim" style={{ fontSize: 11 }}>{t.amountRange}</span>
                  <span className="pf-tbl-num" style={{ fontSize: 11 }}>
                    {fmtDate(t.transactionDate)} <span className={t.lagDays > 30 ? "pf-lag" : "dim"}>+{t.lagDays}d</span>
                  </span>
                  <span className="r"><button className={`pf-star${follow.includes(t.politician) ? " on" : ""}`} onClick={() => toggleFollow(t.politician)}>★</button></span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* leaderboard */}
        <div className="pf-panel">
          <div className="pf-panel-h"><b>Most Active Buyers</b><span className="dim mono">90d</span></div>
          <div className="tt-tbody">
            {leaders.loading && <div className="tt-empty-row">LOADING…</div>}
            {(leaders.data?.leaders ?? []).slice(0, 14).map((l) => (
              <div key={l.politician} style={{ padding: "10px 4px", borderBottom: `1px solid ${C.lineSoft}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="pf-pol-dot" style={{ background: partyColor(l.party) }} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{l.politician}</span>
                  <button className={`pf-star${follow.includes(l.politician) ? " on" : ""}`} style={{ marginLeft: "auto" }} onClick={() => toggleFollow(l.politician)}>★</button>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 5, fontFamily: "var(--fm)", fontSize: 11 }}>
                  <span style={{ color: C.up }}>{l.buys} buys</span>
                  <span className="dim">{l.sells} sells</span>
                  {l.convictionTickers.length > 0 && <span style={{ color: C.amber }}>conviction: {l.convictionTickers.slice(0, 3).join(", ")}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
