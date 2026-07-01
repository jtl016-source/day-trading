import { useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import MarketPage from "@/pages/market";
import TradingTerminal from "@/pages/terminal";
import DataDownloadPage from "@/pages/data-download";
import NewsPage from "@/pages/news";
import TimestampsPage from "@/pages/timestamps";
import TodaySignalsPage from "@/pages/today-signals";
import PredictionsPage from "@/pages/predictions";
import DiscordFeedPage from "@/pages/discord-feed";
import BacktestPage from "@/pages/backtest";
import TradeJournalPage from "@/pages/trade-journal";
import PortfolioPage from "@/pages/portfolio"; // isolated long-term research module

function Router() {
  const [location] = useLocation();
  // MERIDIAN terminal is the visible face of the app at "/".
  const onTerminal = location === "/";
  // The legacy MarketPage chart/toolbar UI is retired from the home screen but kept
  // reachable at "/classic" (e.g. for settings the terminal doesn't yet expose).
  const onClassic = location === "/classic";

  return (
    <>
      {/*
        MarketPage is ALWAYS mounted so its WebSocket connections, signal computation,
        notification + AUTO-TRADE useEffects keep running — it is the ENGINE. The MERIDIAN
        terminal is a pure consumer of the data this engine produces. MarketPage is hidden
        with display:none except on "/classic".
      */}
      <div style={{
        display: onClassic ? "flex" : "none",
        flex: 1,
        flexDirection: "column",
        overflow: "hidden",
        minHeight: 0,
      }}>
        <MarketPage />
      </div>

      {/* MERIDIAN terminal — the home view */}
      {onTerminal && <TradingTerminal />}

      {/* Other routes are only rendered when not on the terminal / classic pages */}
      {!onTerminal && !onClassic && (
        <Switch>
          <Route path="/data" component={DataDownloadPage} />
          <Route path="/news" component={NewsPage} />
          <Route path="/timestamps" component={TimestampsPage} />
          <Route path="/today" component={TodaySignalsPage} />
          <Route path="/predictions" component={PredictionsPage} />
          <Route path="/discord" component={DiscordFeedPage} />
          <Route path="/backtest" component={BacktestPage} />
          <Route path="/journal" component={TradeJournalPage} />
          <Route path="/portfolio" component={PortfolioPage} />
          <Route component={NotFound} />
        </Switch>
      )}
    </>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="h-screen flex flex-col overflow-hidden">
          <Router />
        </div>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
