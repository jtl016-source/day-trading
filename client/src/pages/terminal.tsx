// terminal.tsx — Baxter trading terminal (root). The MARKET CHART is the full-screen
// background; the header, HUD, signal/settings panels and clock FLOAT on top of it.
// MarketPage stays mounted (hidden) in App.tsx as the engine; this page consumes its data.
//
// Decisions baked in: single-tier ("SAFE"), terminal replaces home, settings persist +
// mirror into the engine's mwb_settings, Pattern removed. Milk zones are an upload-picture
// feature (parsed via /api/zones/parse, stored per-symbol).
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { CSS } from "@/components/terminal/terminalStyles";
import { Ico } from "@/components/terminal/icons";
import { Brand, Toggle } from "@/components/terminal/controls";
import { TerminalLiveChart } from "@/components/terminal/TerminalLiveChart";
import { MarketView } from "@/components/terminal/MarketView";
import { SignalsView } from "@/components/terminal/SignalsView";
import { SettingsView } from "@/components/terminal/SettingsView";
import { InfoView } from "@/components/terminal/InfoView";
import { NewsTicker } from "@/components/terminal/NewsTicker";
import { Clock } from "@/components/terminal/Clock";
import { FootprintPanel } from "@/components/terminal/FootprintPanel";
import { STRATS } from "@/components/terminal/strategyMeta";
import { useTerminalData, type TerminalSignal } from "@/hooks/useTerminalData";
import {
  loadSettings, saveSettings, loadStrategies, saveStrategies, getEngineInterval, setEngineInterval,
  type TerminalSettings, type StrategyToggles,
} from "@/lib/terminalSettings";
import { loadMilkZones, uploadMilkZones, type MilkZone } from "@/lib/milkZones";

type Tab = "home" | "signals" | "settings" | "info";
type SideFilter = "All" | "LONG" | "SHORT";

// The four fractal probability concepts, each rendered individually on the chart and toggled on its own.
const PROB_OVERLAYS: Array<{ key: keyof StrategyToggles; label: string; color: string }> = [
  { key: "probValueArea", label: "Value Area (POC/VAH/VAL)", color: "#ffb454" },
  { key: "probRegime",    label: "Regime Ribbon (Hurst)",    color: "#1fd98a" },
  { key: "probForecast",  label: "Forecast Cone (fBm)",      color: "#2dd4bf" },
  { key: "probScaler",    label: "Target Levels (scaler)",   color: "#60a5fa" },
];

export default function TradingTerminal() {
  const [, setLocation] = useLocation(); // PORTFOLIO tab navigates to the isolated /portfolio route
  const [tab, setTab] = useState<Tab>("home");
  const [chartKey, setChartKey] = useState(0);
  const [stratOpen, setStratOpen] = useState(false);
  const [filter, setFilter] = useState<SideFilter>("All");
  const [chartSig, setChartSig] = useState<TerminalSignal | null>(null); // signal selected on the chart (shows TP/SL lines)

  const [settings, setSettings] = useState<TerminalSettings>(() => loadSettings());
  const [strategies, setStrategies] = useState<StrategyToggles>(() => loadStrategies());
  const [interval, setIntervalState] = useState<string>(() => getEngineInterval());
  // Switch the charting interval: persist into the engine's mwb_settings and bump chartKey
  // so the chart re-fetches + re-fits to the new interval's history.
  const changeInterval = (iv: string) => {
    if (iv === interval) return;
    setEngineInterval(iv);
    setIntervalState(iv);
    setChartKey((k) => k + 1);
  };

  useEffect(() => { saveSettings(settings); }, [settings]);
  useEffect(() => { saveStrategies(strategies); }, [strategies]);
  // Auto-trade follows the interval you're viewing: tell the server to fire signals on THIS
  // interval (the hidden engine mirrors server config live). Runs on mount + every interval change.
  useEffect(() => {
    fetch("/api/trade/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intervals: [interval] }),
    }).catch(() => {});
  }, [interval]);
  // Escape clears the selected signal (hides the TP/SL lines on the chart).
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setChartSig(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const { candles, signals, lastPrice, source, connected, feedStatus, loadMoreHistory, fullyLoaded, autoTradeFired } = useTerminalData(settings.symbol, interval, chartKey);

  // Visible "order placed" toast — the engine's own toast renders in the hidden MarketPage.
  const [tradeToast, setTradeToast] = useState<string | null>(null);
  useEffect(() => {
    if (!autoTradeFired) return;
    const f = autoTradeFired;
    setTradeToast(`AUTO-TRADE FIRED · ${f.contracts}x ${f.symbol} ${f.direction} @ ${f.price.toFixed(2)} (${f.interval})`);
    const t = setTimeout(() => setTradeToast(null), 9000);
    return () => clearTimeout(t);
  }, [autoTradeFired]);

  // ── Milk zones: uploaded pictures parsed into zones, stored per symbol ──
  const [milkZones, setMilkZones] = useState<MilkZone[]>(() => loadMilkZones(settings.symbol));
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setMilkZones(loadMilkZones(settings.symbol)); }, [settings.symbol]);

  // RULE (user): the MilkZone strategy is NOT a free toggle — it can only be ON when the
  // user has uploaded zones via a PNG. No upload → no milk zones (never fabricated). The
  // effective MilkZone flag passed to the chart/views is forced off until an upload exists.
  const milkUploaded = milkZones.length > 0;
  const effectiveStrategies = useMemo<StrategyToggles>(
    () => ({ ...strategies, MilkZone: strategies.MilkZone && milkUploaded }),
    [strategies, milkUploaded],
  );

  const onPickFile = async (file: File) => {
    setUploadBusy(true);
    setUploadMsg("Parsing…");
    const visibleHigh = candles.length ? Math.max(...candles.map((c) => c.h)) : undefined;
    const visibleLow = candles.length ? Math.min(...candles.map((c) => c.l)) : undefined;
    const res = await uploadMilkZones(file, settings.symbol, visibleHigh, visibleLow);
    setUploadBusy(false);
    if (res.error) { setUploadMsg(`Error: ${res.error}`); return; }
    if (res.count === 0) { setUploadMsg("No zones found in that image."); return; }
    setMilkZones(res.zones);
    setStrategies((p) => ({ ...p, MilkZone: true })); // show them immediately
    setUploadMsg(`Loaded ${res.count} zone${res.count === 1 ? "" : "s"}.`);
    setTimeout(() => setUploadMsg(null), 3000);
  };

  // Re-fit the chart on the reload button + when (re)entering the Market tab.
  const reloadChart = () => setChartKey((k) => k + 1);
  // goHome just switches to the Market tab — does NOT bump chartKey so the zoom/scroll
  // position is preserved. Only the reload button (reloadChart) resets the view.
  const goHome = () => setTab("home");

  const tabs: { id: Tab; label: string; icon: () => JSX.Element }[] = [
    { id: "home", label: "Market", icon: Ico.bars },
    { id: "signals", label: "Signals", icon: Ico.signal },
    { id: "info", label: "Info", icon: Ico.info },
    { id: "settings", label: "Settings", icon: Ico.sliders },
  ];

  return (
    <div className="tt-root tt-floating">
      <style>{CSS}</style>

      {/* The market IS the background */}
      <TerminalLiveChart
        candles={candles}
        signals={signals}
        milkZones={milkZones}
        symbol={settings.symbol}
        interval={interval}
        strategies={effectiveStrategies}
        chartKey={chartKey}
        onSignalClick={(s) => setChartSig(s && s.ts !== chartSig?.ts ? s : null)}
        selectedSig={chartSig}
        onNeedHistory={loadMoreHistory}
        fullyLoaded={fullyLoaded}
      />
      <div className="tt-overlay" />

      {/* hidden uploader for milk-zone pictures */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.mwml,.xml,.pdf"
        style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickFile(f); e.target.value = ""; }}
      />

      <div className="tt-app">
        <header className="tt-header">
          <Brand onClick={goHome} />

          <nav className="tt-tabs">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => (t.id === "home" ? goHome() : setTab(t.id))}
                className={"tt-tab" + (tab === t.id ? " active" : "")}>
                <span className="tt-tab-ico">{t.icon()}</span>{t.label}
              </button>
            ))}
            {/* PORTFOLIO — isolated long-term research module on its own route */}
            <button className="tt-tab" onClick={() => setLocation("/portfolio")}>Portfolio</button>
          </nav>

          <div className="tt-strat-wrap">
            <button className={"tt-strat-btn" + (stratOpen ? " open" : "")} onClick={() => setStratOpen((o) => !o)}>
              Strategies <span style={{ display: "inline-flex", transition: "transform .25s", transform: stratOpen ? "rotate(180deg)" : "none" }}>{Ico.chevron()}</span>
            </button>
            {stratOpen && (
              <>
                <div className="tt-backdrop" onClick={() => setStratOpen(false)} />
                <div className="tt-dropdown">
                  <span className="tt-corner tl" /><span className="tt-corner tr" />
                  <span className="tt-corner bl" /><span className="tt-corner br" />
                  <div className="tt-dd-head">CONFIRMATION STRATEGIES</div>
                  {STRATS.map((s, i) => (
                    <div key={s.key}>
                      <div className="tt-dd-row" style={{ animationDelay: 60 + i * 55 + "ms" }}>
                        <div className="tt-dd-info">
                          <div className="tt-dd-name">{s.key}<span className="tt-dd-stat">{s.stat}</span></div>
                          <div className="tt-dd-desc">{s.desc}</div>
                        </div>
                        <Toggle
                          on={s.key === "MilkZone" ? effectiveStrategies.MilkZone : strategies[s.key]}
                          disabled={s.key === "MilkZone" && !milkUploaded}
                          onClick={() => setStrategies((p) => ({ ...p, [s.key]: !p[s.key] }))}
                        />
                      </div>
                      {s.key === "MilkZone" && (
                        <>
                          <button className={"tt-dd-upload" + (uploadBusy ? " busy" : "")} disabled={uploadBusy}
                            onClick={() => fileInputRef.current?.click()}>
                            {Ico.bars()} {uploadBusy ? "Parsing…" : "Upload Zone Picture"}
                          </button>
                          <div className="tt-dd-upload-note">
                            {uploadMsg ?? (milkZones.length ? `${milkZones.length} zone${milkZones.length === 1 ? "" : "s"} loaded for ${settings.symbol}` : "Upload a chart screenshot to load milk zones")}
                          </div>
                        </>
                      )}
                      {/* Probability sub-overlays — each fractal concept shown individually on the chart */}
                      {s.key === "Probability" && strategies.Probability && (
                        <div className="tt-dd-suboverlays">
                          {PROB_OVERLAYS.map((po) => (
                            <div key={po.key} className="tt-dd-subrow">
                              <span className="tt-dd-subdot" style={{ background: po.color }} />
                              <span className="tt-dd-subname">{po.label}</span>
                              <Toggle
                                on={strategies[po.key]}
                                onClick={() => setStrategies((p) => ({ ...p, [po.key]: !p[po.key] }))}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </header>

        <NewsTicker />

        <main className={"tt-main" + (tab === "home" ? " passthrough" : "")}>
          <div className="tt-container">
            <div key={tab} className="tt-view">
              {tab === "home" && (
                <MarketView
                  symbol={settings.symbol}
                  candles={candles}
                  lastPrice={lastPrice}
                  onReload={reloadChart}
                  strategies={effectiveStrategies}
                  source={source}
                  connected={connected}
                  feedStatus={feedStatus}
                  interval={interval}
                  onIntervalChange={changeInterval}
                />
              )}
              {tab === "signals" && (
                <SignalsView signals={signals} candles={candles} filter={filter} setFilter={setFilter} symbol={settings.symbol} interval={interval} />
              )}
              {tab === "info" && <InfoView />}
              {tab === "settings" && <SettingsView s={settings} set={setSettings} />}
            </div>
          </div>
        </main>
      </div>

      {effectiveStrategies.Footprint && tab === "home" && (
        <FootprintPanel symbol={settings.symbol} interval={interval} />
      )}
      {/* Probability is now shown as individual ON-CHART overlays (Value Area / Regime / Forecast /
          Target levels) — the floating numeric panel was removed (it overlapped the dropdown). */}

      <Clock />

      {/* Visible auto-trade confirmation (the engine's toast is on the hidden page) */}
      {tradeToast && (
        <div style={{
          position: "fixed", top: 70, left: "50%", transform: "translateX(-50%)", zIndex: 50,
          background: "rgba(8,12,20,0.95)", border: "1px solid #ef5350",
          borderRadius: 8, padding: "10px 18px", color: "#ff6b7d",
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 700, letterSpacing: 0.5,
          boxShadow: "0 8px 30px -8px rgba(239,83,80,0.6)", pointerEvents: "none",
        }}>
          {tradeToast}
        </div>
      )}
    </div>
  );
}
