import { useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import MarketPage from "@/pages/market";
import DataDownloadPage from "@/pages/data-download";
import NewsPage from "@/pages/news";
import TimestampsPage from "@/pages/timestamps";
import TodaySignalsPage from "@/pages/today-signals";
import PredictionsPage from "@/pages/predictions";
import DiscordFeedPage from "@/pages/discord-feed";
import BacktestPage from "@/pages/backtest";
import TradeJournalPage from "@/pages/trade-journal";

function Router() {
  const [location] = useLocation();
  const onMarket = location === "/";

  return (
    <>
      {/*
        MarketPage is ALWAYS mounted so its WebSocket connections, signal computation,
        and notification useEffects keep running even when the user navigates away.
        It is hidden visually with display:none when not on "/".
      */}
      <div style={{
        display: onMarket ? "flex" : "none",
        flex: 1,
        flexDirection: "column",
        overflow: "hidden",
        minHeight: 0,
      }}>
        <MarketPage />
      </div>

      {/* Other routes are only rendered when not on the market page */}
      {!onMarket && (
        <Switch>
          <Route path="/data" component={DataDownloadPage} />
          <Route path="/news" component={NewsPage} />
          <Route path="/timestamps" component={TimestampsPage} />
          <Route path="/today" component={TodaySignalsPage} />
          <Route path="/predictions" component={PredictionsPage} />
          <Route path="/discord" component={DiscordFeedPage} />
          <Route path="/backtest" component={BacktestPage} />
          <Route path="/journal" component={TradeJournalPage} />
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
