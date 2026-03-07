import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CandlestickChart, type CandleBar, type ChartHandle, type ZoneOverlay } from "@/components/CandlestickChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp,
  TrendingDown,
  Activity,
  BarChart3,
  Search,
  ChevronLeft,
  ChevronRight,
  History,
  CalendarDays,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from "lucide-react";
import { Input } from "@/components/ui/input";

interface SymbolInfo { symbol: string; name: string }
interface SymbolsData { stocks: SymbolInfo[]; etfs: SymbolInfo[]; futures: SymbolInfo[]; indices: SymbolInfo[] }
interface DayInfo { date: string; open: number; high: number; low: number; close: number; volume: number }

interface YellowBoxDay {
  date: string;
  poc: number;
  yellowTop: number;
  yellowBottom: number;
  resistanceTop: number;
  resistanceBot: number;
  supportTop: number;
  supportBot: number;
}

const LOOKBACK = 14;
const ZONE_THICKNESS_FRACTION = 0.3;
const MIN_RAW_DIFF = 0.001;

function computeYellowBoxZones(days: DayInfo[]): YellowBoxDay[] {
  const chronological = [...days].reverse();
  const zones: YellowBoxDay[] = [];
  const ranges: number[] = [];

  for (let i = 0; i < chronological.length; i++) {
    ranges.push(chronological[i].high - chronological[i].low);

    if (i < 1) continue;

    const curOpen = chronological[i].open;
    const prevClose = chronological[i - 1].close;

    const yellowBox = curOpen;
    const pointDiff = Math.abs(yellowBox - prevClose);
    let pct = pointDiff / prevClose;
    pct = Math.max(pct, MIN_RAW_DIFF);

    const lookbackStart = Math.max(0, i - LOOKBACK);
    const lookbackRanges = ranges.slice(lookbackStart, i);
    const avgRange = lookbackRanges.reduce((a, b) => a + b, 0) / lookbackRanges.length;

    const yellowTop = yellowBox + avgRange / 2;
    const yellowBottom = yellowBox - avgRange / 2;

    const pctDist = pct * yellowBox;
    const rStart = yellowTop + pctDist;
    const sStart = yellowBottom - pctDist;
    const zoneThick = pctDist * ZONE_THICKNESS_FRACTION;

    zones.push({
      date: chronological[i].date,
      poc: yellowBox,
      yellowTop,
      yellowBottom,
      resistanceTop: rStart + zoneThick,
      resistanceBot: rStart,
      supportTop: sStart,
      supportBot: sStart - zoneThick,
    });
  }

  return zones;
}

function buildZoneOverlays(
  zones: YellowBoxDay[],
  candles: CandleBar[]
): ZoneOverlay[] {
  if (zones.length === 0 || candles.length === 0) return [];

  const sorted = [...candles].sort((a, b) => a.time - b.time);

  const dayGroups = new Map<string, { first: number; last: number }>();
  for (const c of sorted) {
    const d = new Date(c.time * 1000);
    const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const existing = dayGroups.get(dateStr);
    if (!existing) {
      dayGroups.set(dateStr, { first: c.time, last: c.time });
    } else {
      existing.last = c.time;
    }
  }

  const zoneMap = new Map<string, YellowBoxDay>();
  for (const z of zones) {
    zoneMap.set(z.date, z);
  }

  const pocData: Array<{ time: number; value: number }> = [];
  const ytData: Array<{ time: number; value: number }> = [];
  const ybData: Array<{ time: number; value: number }> = [];
  const rtData: Array<{ time: number; value: number }> = [];
  const rbData: Array<{ time: number; value: number }> = [];
  const stData: Array<{ time: number; value: number }> = [];
  const sbData: Array<{ time: number; value: number }> = [];

  for (const [dateStr, bounds] of dayGroups) {
    const zone = zoneMap.get(dateStr);
    if (!zone) continue;

    pocData.push({ time: bounds.first, value: zone.poc });
    pocData.push({ time: bounds.last, value: zone.poc });

    ytData.push({ time: bounds.first, value: zone.yellowTop });
    ytData.push({ time: bounds.last, value: zone.yellowTop });

    ybData.push({ time: bounds.first, value: zone.yellowBottom });
    ybData.push({ time: bounds.last, value: zone.yellowBottom });

    rtData.push({ time: bounds.first, value: zone.resistanceTop });
    rtData.push({ time: bounds.last, value: zone.resistanceTop });

    rbData.push({ time: bounds.first, value: zone.resistanceBot });
    rbData.push({ time: bounds.last, value: zone.resistanceBot });

    stData.push({ time: bounds.first, value: zone.supportTop });
    stData.push({ time: bounds.last, value: zone.supportTop });

    sbData.push({ time: bounds.first, value: zone.supportBot });
    sbData.push({ time: bounds.last, value: zone.supportBot });
  }

  return [
    { data: ytData, color: "rgba(202, 178, 50, 0.7)", lineWidth: 1, lineStyle: 0, title: "YB Top" },
    { data: ybData, color: "rgba(202, 178, 50, 0.7)", lineWidth: 1, lineStyle: 0, title: "YB Bot" },
    { data: pocData, color: "rgba(168, 85, 247, 0.85)", lineWidth: 2, lineStyle: 4, title: "POC" },
    { data: rtData, color: "rgba(239, 68, 68, 0.6)", lineWidth: 1, lineStyle: 2, title: "R Top" },
    { data: rbData, color: "rgba(239, 68, 68, 0.6)", lineWidth: 1, lineStyle: 2, title: "R Bot" },
    { data: stData, color: "rgba(34, 197, 94, 0.6)", lineWidth: 1, lineStyle: 2, title: "S Top" },
    { data: sbData, color: "rgba(34, 197, 94, 0.6)", lineWidth: 1, lineStyle: 2, title: "S Bot" },
  ];
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
  const [highlightDayIndex, setHighlightDayIndex] = useState(0);
  const [showYellowBox, setShowYellowBox] = useState(true);

  const histChartRef = useRef<ChartHandle>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartIndex = useRef(0);
  const [dragIndex, setDragIndex] = useState(0);

  const { data: symbolsData } = useQuery<SymbolsData>({ queryKey: ["/api/market/symbols"] });

  const { data: quoteData } = useQuery<any>({
    queryKey: ["/api/market/quote", selectedSymbol],
    refetchInterval: 30000,
  });

  const { data: intradayData, isLoading: intradayLoading } = useQuery<{
    symbol: string; interval: string;
    meta: { regularMarketPrice?: number; previousClose?: number; currency?: string; exchangeName?: string };
    candles: CandleBar[];
  }>({
    queryKey: ["/api/market/intraday", selectedSymbol, interval],
    refetchInterval: 60000,
  });

  const { data: historicalDays, isLoading: histDaysLoading } = useQuery<{
    symbol: string; days: DayInfo[];
  }>({ queryKey: ["/api/market/historical-days", selectedSymbol] });

  const { data: continuousData, isLoading: continuousLoading } = useQuery<{
    symbol: string; interval: string; candles: CandleBar[];
  }>({
    queryKey: ["/api/market/historical-continuous", selectedSymbol, interval],
    staleTime: 5 * 60 * 1000,
  });

  const yellowBoxZones = useMemo(() => {
    if (!historicalDays?.days) return [];
    return computeYellowBoxZones(historicalDays.days);
  }, [historicalDays]);

  const zoneOverlays = useMemo(() => {
    if (!showYellowBox || yellowBoxZones.length === 0 || !continuousData?.candles?.length) return [];
    return buildZoneOverlays(yellowBoxZones, continuousData.candles);
  }, [showYellowBox, yellowBoxZones, continuousData]);

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

  const categoryLabels: Record<keyof SymbolsData, string> = {
    stocks: "Stocks", etfs: "ETFs", futures: "Futures", indices: "Indices",
  };
  const categorySymbols = symbolsData?.[selectedCategory] ?? [];

  useEffect(() => {
    if (!timelineRef.current || !historicalDays?.days) return;
    const cardWidth = 72;
    const containerWidth = timelineRef.current.offsetWidth;
    const scrollLeft = highlightDayIndex * cardWidth - containerWidth / 2 + cardWidth / 2;
    timelineRef.current.scrollTo({ left: Math.max(0, scrollLeft), behavior: "smooth" });
  }, [highlightDayIndex, historicalDays]);

  const jumpToDay = useCallback((idx: number) => {
    setHighlightDayIndex(idx);
    setDragIndex(idx);
    const days = historicalDays?.days;
    if (!days || !histChartRef.current) return;
    const day = days[idx];
    if (!day) return;
    const [y, m, d] = day.date.split("-").map(Number);
    const t = Math.floor(new Date(y, m - 1, d, 13, 30, 0).getTime() / 1000);
    histChartRef.current.scrollToTime(t);
  }, [historicalDays]);

  const handleDragStart = useCallback((clientX: number) => {
    isDragging.current = true;
    dragStartX.current = clientX;
    dragStartIndex.current = highlightDayIndex;
  }, [highlightDayIndex]);

  const handleDragMove = useCallback((clientX: number) => {
    if (!isDragging.current || !historicalDays?.days) return;
    const dx = dragStartX.current - clientX;
    const step = Math.round(dx / 40);
    const newIndex = Math.max(0, Math.min(historicalDays.days.length - 1, dragStartIndex.current + step));
    setDragIndex(newIndex);
    setHighlightDayIndex(newIndex);
  }, [historicalDays]);

  const handleDragEnd = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    jumpToDay(dragIndex);
  }, [dragIndex, jumpToDay]);

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

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground border rounded-md px-2 py-1">
            <span className="w-2 h-2 rounded-sm bg-green-500 inline-block" />RTH
            <span className="w-2 h-2 rounded-sm bg-green-300 inline-block ml-1" />ETH
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
        </div>
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
                  onClick={() => { setSelectedSymbol(sym.symbol); setHighlightDayIndex(0); }}
                  className={`text-left rounded-md px-3 py-2 text-sm transition-colors hover-elevate w-full lg:w-auto ${
                    isSelected ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground"
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
          <div className="flex flex-wrap items-start justify-between gap-3">
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
              <div className="flex gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
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
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Activity className="w-4 h-4 text-primary" />
              <span>Today's Session · {interval} candles · ETH + RTH</span>
            </div>
          </div>

          <section>
            <div className="rounded-lg border bg-card overflow-hidden">
              {intradayLoading ? (
                <div className="flex items-center justify-center" style={{ height: 380 }}>
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm">Loading today's market data...</span>
                  </div>
                </div>
              ) : !intradayData?.candles?.length ? (
                <div className="flex items-center justify-center" style={{ height: 380 }}>
                  <div className="text-center text-muted-foreground">
                    <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No trading data available for today</p>
                    <p className="text-xs mt-1">Market may be closed or pre-session</p>
                  </div>
                </div>
              ) : (
                <CandlestickChart candles={intradayData.candles} height={380} showVolume />
              )}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-primary" />
                <div>
                  <h2 className="text-base font-semibold tracking-tight">
                    {interval === "15m" ? "60-Day" : "200-Day"} Continuous History
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {interval === "15m"
                      ? "15m ETH + RTH · last 60 days · switch to 60m for full 200-day view"
                      : "60m ETH + RTH · full 200 trading days · drag timeline or zoom/pan"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={showYellowBox ? "default" : "outline"}
                  data-testid="button-toggle-yellowbox"
                  onClick={() => setShowYellowBox(!showYellowBox)}
                  className="text-xs h-7"
                >
                  {showYellowBox ? "Yellow Box ON" : "Yellow Box OFF"}
                </Button>
                {historicalDays?.days?.[highlightDayIndex] && (
                  <div className="flex items-center gap-1">
                    <CalendarDays className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium" data-testid="text-selected-date">
                      {formatDateFull(historicalDays.days[highlightDayIndex].date)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 mb-3">
              <Button
                size="icon"
                variant="outline"
                data-testid="button-hist-prev"
                disabled={highlightDayIndex <= 0}
                onClick={() => jumpToDay(Math.max(0, highlightDayIndex - 1))}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>

              <div
                ref={timelineRef}
                data-testid="timeline-scroll"
                className="flex-1 overflow-x-auto select-none"
                style={{ cursor: isDragging.current ? "grabbing" : "grab", scrollbarWidth: "none" }}
                onMouseDown={(e) => { e.preventDefault(); handleDragStart(e.clientX); }}
                onTouchStart={(e) => handleDragStart(e.touches[0].clientX)}
                onTouchMove={(e) => handleDragMove(e.touches[0].clientX)}
                onTouchEnd={handleDragEnd}
              >
                <div className="flex gap-1 px-1 py-1" style={{ width: "max-content" }}>
                  {histDaysLoading
                    ? Array.from({ length: 20 }).map((_, i) => (
                        <Skeleton key={i} className="w-16 h-14 rounded flex-shrink-0" />
                      ))
                    : (historicalDays?.days ?? []).map((day, idx) => {
                        const isUp = day.close >= day.open;
                        const isSelected = idx === highlightDayIndex;
                        const changePct = ((day.close - day.open) / day.open) * 100;
                        return (
                          <button
                            key={day.date}
                            data-testid={`button-day-${day.date}`}
                            onClick={() => jumpToDay(idx)}
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
                disabled={highlightDayIndex >= (historicalDays?.days?.length ?? 1) - 1}
                onClick={() => jumpToDay(Math.min((historicalDays?.days?.length ?? 1) - 1, highlightDayIndex + 1))}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>

            <div className="rounded-lg border bg-card overflow-hidden relative">
              <div className="absolute top-2 right-2 z-10 flex items-center gap-1 bg-card/90 backdrop-blur-sm border rounded-md p-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  data-testid="button-zoom-in"
                  className="h-7 w-7"
                  onClick={() => histChartRef.current?.zoomIn()}
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  data-testid="button-zoom-out"
                  className="h-7 w-7"
                  onClick={() => histChartRef.current?.zoomOut()}
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  data-testid="button-zoom-reset"
                  className="h-7 w-7"
                  onClick={() => histChartRef.current?.resetZoom()}
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </Button>
              </div>
              {continuousLoading ? (
                <div className="flex items-center justify-center" style={{ height: 440 }}>
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm">Loading continuous history...</span>
                    <span className="text-xs opacity-60">Fetching intraday data across multiple periods</span>
                  </div>
                </div>
              ) : !continuousData?.candles?.length ? (
                <div className="flex items-center justify-center" style={{ height: 440 }}>
                  <div className="text-center text-muted-foreground">
                    <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No historical data available</p>
                  </div>
                </div>
              ) : (
                <CandlestickChart
                  ref={histChartRef}
                  candles={continuousData.candles}
                  height={440}
                  showVolume
                  zoneOverlays={zoneOverlays}
                />
              )}
            </div>

            <div className="mt-2 flex gap-3 text-xs text-muted-foreground justify-between flex-wrap">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> RTH up
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-sm bg-red-500 inline-block" /> RTH down
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-sm bg-green-300 inline-block" /> ETH up
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-sm bg-red-300 inline-block" /> ETH down
                </span>
                {showYellowBox && (
                  <>
                    <span className="border-l border-border pl-3 flex items-center gap-1">
                      <span className="w-3 h-1 rounded-sm inline-block" style={{ backgroundColor: "rgba(202, 178, 50, 0.9)" }} /> Yellow Box
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-1 rounded-sm inline-block" style={{ backgroundColor: "rgba(168, 85, 247, 0.9)" }} /> POC
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-1 rounded-sm bg-red-500 inline-block" /> Resistance
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-1 rounded-sm bg-green-500 inline-block" /> Support
                    </span>
                  </>
                )}
              </div>
              <span>
                {continuousData?.candles?.length?.toLocaleString()} candles ·
                {historicalDays?.days?.length ?? "—"} trading days
              </span>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
