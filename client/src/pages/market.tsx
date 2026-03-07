import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CandlestickChart, type CandleBar } from "@/components/CandlestickChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp,
  TrendingDown,
  ChevronLeft,
  ChevronRight,
  Activity,
  BarChart3,
  Search,
} from "lucide-react";
import { Input } from "@/components/ui/input";

interface SymbolInfo {
  symbol: string;
  name: string;
}

interface SymbolsData {
  stocks: SymbolInfo[];
  etfs: SymbolInfo[];
  futures: SymbolInfo[];
  indices: SymbolInfo[];
}

interface DayInfo {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function formatPrice(n: number | undefined | null): string {
  if (n == null) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function formatVolume(v: number | undefined | null): string {
  if (v == null || v === 0) return "—";
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + "B";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return v.toString();
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateFull(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

export default function MarketPage() {
  const [selectedSymbol, setSelectedSymbol] = useState("SPY");
  const [selectedCategory, setSelectedCategory] = useState<keyof SymbolsData>("etfs");
  const [interval, setInterval] = useState<"15m" | "60m">("15m");
  const [symbolSearch, setSymbolSearch] = useState("");
  const [histDayIndex, setHistDayIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartIndex = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);

  const { data: symbolsData } = useQuery<SymbolsData>({
    queryKey: ["/api/market/symbols"],
  });

  const { data: quoteData } = useQuery<any>({
    queryKey: ["/api/market/quote", selectedSymbol],
    refetchInterval: 30000,
  });

  const { data: intradayData, isLoading: intradayLoading } = useQuery<{
    symbol: string;
    interval: string;
    meta: { regularMarketPrice?: number; previousClose?: number; currency?: string; exchangeName?: string };
    candles: CandleBar[];
  }>({
    queryKey: ["/api/market/intraday", selectedSymbol, interval],
    refetchInterval: 60000,
  });

  const { data: historicalDays, isLoading: histLoading } = useQuery<{
    symbol: string;
    days: DayInfo[];
  }>({
    queryKey: ["/api/market/historical-days", selectedSymbol],
  });

  const selectedDay = historicalDays?.days?.[histDayIndex];

  const { data: dayDetailData, isLoading: dayDetailLoading } = useQuery<{
    symbol: string;
    date: string;
    interval: string;
    candles: CandleBar[];
  }>({
    queryKey: ["/api/market/day-detail", selectedSymbol, selectedDay?.date, interval],
    enabled: !!selectedDay,
  });

  const currentPrice = quoteData?.regularMarketPrice ?? intradayData?.meta?.regularMarketPrice;
  const prevClose = quoteData?.regularMarketPreviousClose ?? intradayData?.meta?.previousClose;
  const priceChange = currentPrice != null && prevClose != null ? currentPrice - prevClose : null;
  const priceChangePct = priceChange != null && prevClose != null ? (priceChange / prevClose) * 100 : null;
  const isPositive = priceChange != null ? priceChange >= 0 : null;

  const allSymbolsForSearch = symbolsData
    ? [
        ...(symbolsData.stocks || []).map((s) => ({ ...s, category: "stocks" })),
        ...(symbolsData.etfs || []).map((s) => ({ ...s, category: "etfs" })),
        ...(symbolsData.futures || []).map((s) => ({ ...s, category: "futures" })),
        ...(symbolsData.indices || []).map((s) => ({ ...s, category: "indices" })),
      ]
    : [];

  const filteredSearch = symbolSearch.trim()
    ? allSymbolsForSearch.filter(
        (s) =>
          s.symbol.toLowerCase().includes(symbolSearch.toLowerCase()) ||
          s.name.toLowerCase().includes(symbolSearch.toLowerCase())
      )
    : [];

  const handleDragStart = useCallback((clientX: number) => {
    setIsDragging(true);
    dragStartX.current = clientX;
    dragStartIndex.current = histDayIndex;
  }, [histDayIndex]);

  const handleDragMove = useCallback((clientX: number) => {
    if (!isDragging || !historicalDays?.days) return;
    const dx = dragStartX.current - clientX;
    const step = Math.round(dx / 40);
    const newIndex = Math.max(0, Math.min(historicalDays.days.length - 1, dragStartIndex.current + step));
    setHistDayIndex(newIndex);
  }, [isDragging, historicalDays]);

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    const onMouseUp = () => handleDragEnd();
    const onMouseMove = (e: MouseEvent) => handleDragMove(e.clientX);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousemove", onMouseMove);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, [handleDragMove, handleDragEnd]);

  useEffect(() => {
    if (timelineRef.current && historicalDays?.days) {
      const cardWidth = 72;
      const containerWidth = timelineRef.current.offsetWidth;
      const scrollLeft = histDayIndex * cardWidth - containerWidth / 2 + cardWidth / 2;
      timelineRef.current.scrollTo({ left: Math.max(0, scrollLeft), behavior: "smooth" });
    }
  }, [histDayIndex, historicalDays]);

  const categoryLabels: Record<keyof SymbolsData, string> = {
    stocks: "Stocks",
    etfs: "ETFs",
    futures: "Futures",
    indices: "Indices",
  };

  const categorySymbols = symbolsData?.[selectedCategory] ?? [];

  return (
    <div className="flex flex-col h-full overflow-auto bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-sm px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 mr-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          <span className="font-semibold text-sm tracking-tight">MarketView</span>
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              data-testid="input-symbol-search"
              placeholder="Search symbol..."
              value={symbolSearch}
              onChange={(e) => setSymbolSearch(e.target.value)}
              className="pl-8 h-9 w-44 text-sm"
            />
            {filteredSearch.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-64 bg-popover border border-popover-border rounded-md shadow-lg z-50 overflow-hidden">
                {filteredSearch.slice(0, 8).map((s) => (
                  <button
                    key={s.symbol}
                    data-testid={`button-search-result-${s.symbol}`}
                    className="w-full px-3 py-2 text-left hover-elevate flex items-center justify-between gap-2 text-sm"
                    onClick={() => {
                      setSelectedSymbol(s.symbol);
                      setSelectedCategory(s.category as keyof SymbolsData);
                      setSymbolSearch("");
                    }}
                  >
                    <span className="font-medium">{s.symbol}</span>
                    <span className="text-muted-foreground text-xs truncate">{s.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-1 flex-wrap">
            {(Object.keys(categoryLabels) as (keyof SymbolsData)[]).map((cat) => (
              <Button
                key={cat}
                size="sm"
                variant={selectedCategory === cat ? "default" : "outline"}
                data-testid={`button-category-${cat}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {categoryLabels[cat]}
              </Button>
            ))}
          </div>
        </div>

        <Select value={interval} onValueChange={(v) => setInterval(v as "15m" | "60m")}>
          <SelectTrigger className="w-24" data-testid="select-interval">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="15m">15 min</SelectItem>
            <SelectItem value="60m">60 min</SelectItem>
          </SelectContent>
        </Select>
      </header>

      <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-auto">
        <aside className="lg:w-52 border-b lg:border-b-0 lg:border-r bg-sidebar flex-shrink-0 overflow-auto">
          <div className="p-2 flex flex-row lg:flex-col gap-1 flex-wrap lg:flex-nowrap">
            {categorySymbols.map((sym) => {
              const isSelected = sym.symbol === selectedSymbol;
              return (
                <button
                  key={sym.symbol}
                  data-testid={`button-symbol-${sym.symbol}`}
                  onClick={() => { setSelectedSymbol(sym.symbol); setHistDayIndex(0); }}
                  className={`text-left rounded-md px-3 py-2 text-sm transition-colors hover-elevate w-full lg:w-auto ${
                    isSelected
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground"
                  }`}
                >
                  <div className="font-semibold text-xs">{sym.symbol}</div>
                  <div className="text-xs text-muted-foreground truncate hidden lg:block">{sym.name}</div>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="flex-1 overflow-auto p-4 flex flex-col gap-6 min-w-0">
          <section>
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div>
                <div className="flex items-center gap-3 flex-wrap">
                  <h1 className="text-2xl font-bold tracking-tight" data-testid="text-symbol">{selectedSymbol}</h1>
                  {quoteData?.shortName && (
                    <span className="text-sm text-muted-foreground" data-testid="text-company-name">{quoteData.shortName}</span>
                  )}
                  <Badge variant="outline" className="text-xs" data-testid="badge-exchange">
                    {quoteData?.fullExchangeName ?? intradayData?.meta?.exchangeName ?? "—"}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  {currentPrice != null ? (
                    <span className="text-3xl font-bold font-mono" data-testid="text-current-price">
                      {formatPrice(currentPrice)}
                    </span>
                  ) : (
                    <Skeleton className="h-8 w-32" />
                  )}
                  {priceChange != null && (
                    <div
                      className={`flex items-center gap-1 ${isPositive ? "text-green-500" : "text-red-500"}`}
                      data-testid="text-price-change"
                    >
                      {isPositive ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                      <span className="font-semibold font-mono">{isPositive ? "+" : ""}{formatPrice(priceChange)}</span>
                      <span className="font-mono text-sm">({isPositive ? "+" : ""}{priceChangePct?.toFixed(2)}%)</span>
                    </div>
                  )}
                </div>
                <div className="flex gap-4 mt-2 text-xs text-muted-foreground flex-wrap">
                  {quoteData?.regularMarketVolume != null && (
                    <span>Vol: <span className="text-foreground font-medium">{formatVolume(quoteData.regularMarketVolume)}</span></span>
                  )}
                  {quoteData?.regularMarketDayHigh != null && (
                    <span>H: <span className="text-foreground font-medium">{formatPrice(quoteData.regularMarketDayHigh)}</span></span>
                  )}
                  {quoteData?.regularMarketDayLow != null && (
                    <span>L: <span className="text-foreground font-medium">{formatPrice(quoteData.regularMarketDayLow)}</span></span>
                  )}
                  {prevClose != null && (
                    <span>Prev Close: <span className="text-foreground font-medium">{formatPrice(prevClose)}</span></span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                <span className="text-xs text-muted-foreground">Today's Session · {interval} candles</span>
              </div>
            </div>

            <div className="rounded-lg border bg-card overflow-hidden">
              {intradayLoading ? (
                <div className="flex items-center justify-center" style={{ height: 420 }}>
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm">Loading market data...</span>
                  </div>
                </div>
              ) : intradayData?.candles?.length === 0 ? (
                <div className="flex items-center justify-center" style={{ height: 420 }}>
                  <div className="text-center text-muted-foreground">
                    <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No trading data available for today</p>
                    <p className="text-xs mt-1">Market may be closed or no data yet</p>
                  </div>
                </div>
              ) : (
                <CandlestickChart
                  candles={intradayData?.candles ?? []}
                  height={420}
                  showVolume={true}
                />
              )}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Historical Data</h2>
                <p className="text-sm text-muted-foreground">Past 200 trading days — drag or click to navigate</p>
              </div>
              {selectedDay && (
                <div className="text-right">
                  <div className="text-sm font-medium" data-testid="text-selected-date">{formatDateFull(selectedDay.date)}</div>
                  <div className="flex gap-3 text-xs text-muted-foreground mt-0.5 justify-end flex-wrap">
                    <span>O: <span className={`font-medium ${selectedDay.close >= selectedDay.open ? "text-green-500" : "text-red-500"}`}>{formatPrice(selectedDay.open)}</span></span>
                    <span>H: <span className="font-medium text-foreground">{formatPrice(selectedDay.high)}</span></span>
                    <span>L: <span className="font-medium text-foreground">{formatPrice(selectedDay.low)}</span></span>
                    <span>C: <span className={`font-medium ${selectedDay.close >= selectedDay.open ? "text-green-500" : "text-red-500"}`}>{formatPrice(selectedDay.close)}</span></span>
                  </div>
                </div>
              )}
            </div>

            <div className="mb-3 flex items-center gap-2">
              <Button
                size="icon"
                variant="outline"
                data-testid="button-hist-prev"
                disabled={histDayIndex <= 0}
                onClick={() => setHistDayIndex((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <div
                ref={timelineRef}
                data-testid="timeline-scroll"
                className="flex-1 overflow-x-auto select-none"
                style={{ cursor: isDragging ? "grabbing" : "grab", scrollbarWidth: "none" }}
                onMouseDown={(e) => { e.preventDefault(); handleDragStart(e.clientX); }}
                onTouchStart={(e) => handleDragStart(e.touches[0].clientX)}
                onTouchMove={(e) => handleDragMove(e.touches[0].clientX)}
                onTouchEnd={handleDragEnd}
              >
                <div className="flex gap-1 px-1 py-1" style={{ width: "max-content" }}>
                  {histLoading
                    ? Array.from({ length: 20 }).map((_, i) => (
                        <Skeleton key={i} className="w-16 h-14 rounded flex-shrink-0" />
                      ))
                    : (historicalDays?.days ?? []).map((day, idx) => {
                        const isUp = day.close >= day.open;
                        const isSelected = idx === histDayIndex;
                        const changePct = ((day.close - day.open) / day.open) * 100;
                        return (
                          <button
                            key={day.date}
                            data-testid={`button-day-${day.date}`}
                            onClick={() => setHistDayIndex(idx)}
                            className={`flex-shrink-0 w-16 rounded-md border px-1.5 py-1.5 text-center transition-all ${
                              isSelected
                                ? "border-primary bg-primary/10 ring-1 ring-primary"
                                : "border-border bg-card hover-elevate"
                            }`}
                          >
                            <div className="text-[9px] text-muted-foreground mb-0.5">{formatDate(day.date)}</div>
                            <div className={`text-[10px] font-semibold font-mono ${isUp ? "text-green-500" : "text-red-500"}`}>
                              {isUp ? "+" : ""}{changePct.toFixed(1)}%
                            </div>
                            <div className="text-[9px] text-muted-foreground font-mono">{formatPrice(day.close)}</div>
                            <div className={`h-0.5 rounded-full mt-1 ${isUp ? "bg-green-500" : "bg-red-500"}`} />
                          </button>
                        );
                      })}
                </div>
              </div>
              <Button
                size="icon"
                variant="outline"
                data-testid="button-hist-next"
                disabled={histDayIndex >= (historicalDays?.days?.length ?? 1) - 1}
                onClick={() => setHistDayIndex((i) => Math.min((historicalDays?.days?.length ?? 1) - 1, i + 1))}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>

            <div className="rounded-lg border bg-card overflow-hidden">
              {!selectedDay ? (
                <div className="flex items-center justify-center" style={{ height: 380 }}>
                  <Skeleton className="w-full h-full" />
                </div>
              ) : dayDetailLoading ? (
                <div className="flex items-center justify-center" style={{ height: 380 }}>
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm">Loading {formatDate(selectedDay.date)} data...</span>
                  </div>
                </div>
              ) : dayDetailData?.candles?.length === 0 ? (
                <div className="flex items-center justify-center" style={{ height: 380 }}>
                  <div className="text-center text-muted-foreground">
                    <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No intraday data for {formatDate(selectedDay.date)}</p>
                  </div>
                </div>
              ) : (
                <CandlestickChart
                  candles={dayDetailData?.candles ?? []}
                  height={380}
                  showVolume={true}
                />
              )}
            </div>

            {selectedDay && (
              <div className="mt-2 flex gap-2 text-xs text-muted-foreground justify-end">
                <span>{histDayIndex + 1} of {historicalDays?.days?.length ?? "—"} days</span>
                <span>·</span>
                <span>Vol: {formatVolume(selectedDay.volume)}</span>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
