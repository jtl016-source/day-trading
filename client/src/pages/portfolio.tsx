// ── PORTFOLIO — long-term research console (isolated module) ──────────────────
// A standalone route (/portfolio) styled with the MERIDIAN terminal CSS. Nothing
// here touches the futures engine, websocket, candle, or auto-trader code paths.
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { CSS } from "@/components/terminal/terminalStyles";
import { PF_CSS } from "@/components/portfolio/portfolioStyles";
import { Overview } from "@/components/portfolio/Overview";
import { Screener } from "@/components/portfolio/Screener";
import { SmartMoney } from "@/components/portfolio/SmartMoney";
import { Congress } from "@/components/portfolio/Congress";
import { useApi, freshness } from "@/components/portfolio/usePortfolio";

type View = "overview" | "screener" | "smartmoney" | "congress";
const VIEWS: { key: View; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "screener", label: "Screener" },
  { key: "smartmoney", label: "Smart Money" },
  { key: "congress", label: "Congress" },
];

export default function PortfolioPage() {
  const [, setLocation] = useLocation();
  const [view, setView] = useState<View>("overview");
  // Health ping = data freshness + budget + whether the FMP key is configured.
  const health = useApi<{ hasApiKey: boolean; budget: { used: number; hardCap: number } }>("/api/portfolio/health", 0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  return (
    <div className="tt-root">
      <style>{CSS}</style>
      <style>{PF_CSS}</style>
      <div className="tt-app" style={{ height: "100vh", overflowY: "auto" }}>
        <div className="pf-wrap">
          <div className="pf-head">
            <button className="pf-back" onClick={() => setLocation("/")}>‹ Terminal</button>
            <div>
              <div className="pf-title">PORT<b>FOLIO</b></div>
              <div className="pf-sub">Long-Term Research Console</div>
            </div>
            <div className="pf-fresh">
              {health.data && !health.data.hasApiKey && <span className="pf-stale">FMP_API_KEY not set</span>}
              {health.data?.hasApiKey && <span>FMP {health.data.budget.used}/{health.data.budget.hardCap} calls today</span>}
              <span>· synced {freshness(now)}</span>
            </div>
          </div>

          {!health.loading && health.data && !health.data.hasApiKey && (
            <div className="pf-keyhint" style={{ marginBottom: 18 }}>
              Set <b>FMP_API_KEY</b> in <span className="mono">.env</span> and restart the server to load fundamentals, 13F, congress and insider data. See PORTFOLIO_README.md.
            </div>
          )}

          <div className="pf-seg">
            {VIEWS.map((v) => (
              <button key={v.key} className={`pf-seg-btn${view === v.key ? " active" : ""}`} onClick={() => setView(v.key)}>{v.label}</button>
            ))}
          </div>

          {view === "overview" && <Overview />}
          {view === "screener" && <Screener />}
          {view === "smartmoney" && <SmartMoney />}
          {view === "congress" && <Congress />}
        </div>
      </div>

      <div className="pf-footer">
        Research tool — not investment advice. 13F data lags up to 135 days; congressional disclosures up to 45 days.
      </div>
    </div>
  );
}
