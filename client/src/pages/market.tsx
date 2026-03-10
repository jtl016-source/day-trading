import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CandlestickChart, type CandleBar, type ChartHandle, type ZoneOverlay, type BandOverlay } from "@/components/CandlestickChart";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart3,
  Search,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Crosshair,
  Maximize2,
  Database,
  Newspaper,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";

interface SymbolInfo { symbol: string; name: string }
interface SymbolsData { stocks: SymbolInfo[]; etfs: SymbolInfo[]; futures: SymbolInfo[]; indices: SymbolInfo[] }
interface DayInfo { date: string; open: number; high: number; low: number; close: number; volume: number }

interface YellowBoxDay {
  date: string;
  poc: number;
  yellowTop: number;
  yellowBottom: number;
  avgRangeHigh: number;
  avgRangeLow: number;
  maxRangeHigh: number;
  maxRangeLow: number;
}

const LOOKBACK_DAYS = 50;
const YELLOW_BOX_FRACTION = 0.35;

function computeYellowBoxZones(days: DayInfo[]): YellowBoxDay[] {
  const chronological = [...days].reverse();
  const zones: YellowBoxDay[] = [];

  for (let i = 1; i < chronological.length; i++) {
    const prevClose = chronological[i - 1].close;
    const poc = prevClose;

    const lookbackStart = Math.max(0, i - LOOKBACK_DAYS);
    const upMoves: number[] = [];
    const downMoves: number[] = [];

    for (let j = lookbackStart; j < i; j++) {
      if (j < 1) continue;
      const pc = chronological[j - 1].close;
      upMoves.push(chronological[j].high - pc);
      downMoves.push(pc - chronological[j].low);
    }

    if (upMoves.length === 0) continue;

    const avgUp = upMoves.reduce((a, b) => a + b, 0) / upMoves.length;
    const avgDown = downMoves.reduce((a, b) => a + b, 0) / downMoves.length;
    const maxUp = Math.max(...upMoves);
    const maxDown = Math.max(...downMoves);

    const avgRange = (avgUp + avgDown) / 2;
    const halfBox = avgRange * YELLOW_BOX_FRACTION;

    zones.push({
      date: chronological[i].date,
      poc,
      yellowTop: poc + halfBox,
      yellowBottom: poc - halfBox,
      avgRangeHigh: poc + avgUp,
      avgRangeLow: poc - avgDown,
      maxRangeHigh: poc + maxUp,
      maxRangeLow: poc - maxDown,
    });
  }

  return zones;
}

function buildZoneOverlays(
  zones: YellowBoxDay[],
  candles: CandleBar[]
): { lines: ZoneOverlay[]; bands: BandOverlay[] } {
  if (zones.length === 0 || candles.length === 0) return { lines: [], bands: [] };

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
  const arHData: Array<{ time: number; value: number }> = [];
  const arLData: Array<{ time: number; value: number }> = [];
  const mrHData: Array<{ time: number; value: number }> = [];
  const mrLData: Array<{ time: number; value: number }> = [];
  const bands: BandOverlay[] = [];

  for (const [dateStr, bounds] of dayGroups) {
    const zone = zoneMap.get(dateStr);
    if (!zone) continue;

    pocData.push({ time: bounds.first, value: zone.poc });
    pocData.push({ time: bounds.last, value: zone.poc });

    ytData.push({ time: bounds.first, value: zone.yellowTop });
    ytData.push({ time: bounds.last, value: zone.yellowTop });

    ybData.push({ time: bounds.first, value: zone.yellowBottom });
    ybData.push({ time: bounds.last, value: zone.yellowBottom });

    arHData.push({ time: bounds.first, value: zone.avgRangeHigh });
    arHData.push({ time: bounds.last, value: zone.avgRangeHigh });

    arLData.push({ time: bounds.first, value: zone.avgRangeLow });
    arLData.push({ time: bounds.last, value: zone.avgRangeLow });

    mrHData.push({ time: bounds.first, value: zone.maxRangeHigh });
    mrHData.push({ time: bounds.last, value: zone.maxRangeHigh });

    mrLData.push({ time: bounds.first, value: zone.maxRangeLow });
    mrLData.push({ time: bounds.last, value: zone.maxRangeLow });

    bands.push({
      topPrice: zone.yellowTop,
      bottomPrice: zone.yellowBottom,
      fillColor: "rgba(180, 160, 40, 0.18)",
      fromTime: bounds.first,
      toTime: bounds.last,
    });
    bands.push({
      topPrice: zone.maxRangeHigh,
      bottomPrice: zone.avgRangeHigh,
      fillColor: "rgba(200, 40, 40, 0.15)",
      fromTime: bounds.first,
      toTime: bounds.last,
    });
    bands.push({
      topPrice: zone.avgRangeLow,
      bottomPrice: zone.maxRangeLow,
      fillColor: "rgba(30, 160, 60, 0.15)",
      fromTime: bounds.first,
      toTime: bounds.last,
    });
  }

  const dedup = (arr: Array<{ time: number; value: number }>) => {
    arr.sort((a, b) => a.time - b.time);
    const result: typeof arr = [];
    for (const pt of arr) {
      if (result.length > 0 && result[result.length - 1].time === pt.time) {
        result[result.length - 1].value = pt.value;
      } else {
        result.push(pt);
      }
    }
    return result;
  };

  const lines: ZoneOverlay[] = [
    { data: dedup(ytData), color: "rgba(210, 190, 50, 0.9)", lineWidth: 1, lineStyle: 2, title: "YB Top" },
    { data: dedup(ybData), color: "rgba(210, 190, 50, 0.9)", lineWidth: 1, lineStyle: 2, title: "YB Bot" },
    { data: dedup(pocData), color: "rgba(220, 220, 220, 0.8)", lineWidth: 1, lineStyle: 2, title: "POC" },
    { data: dedup(arHData), color: "rgba(220, 80, 80, 0.8)", lineWidth: 1, lineStyle: 2, title: "R Zone" },
    { data: dedup(arLData), color: "rgba(60, 180, 90, 0.8)", lineWidth: 1, lineStyle: 2, title: "S Zone" },
    { data: dedup(mrHData), color: "rgba(220, 80, 80, 0.5)", lineWidth: 1, lineStyle: 3, title: "Max R" },
    { data: dedup(mrLData), color: "rgba(60, 180, 90, 0.5)", lineWidth: 1, lineStyle: 3, title: "Max S" },
  ];

  return { lines, bands };
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
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function dateToTimestamp(dateStr: string, hour: number = 0): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(new Date(Date.UTC(y, m - 1, d, hour, 0, 0)).getTime() / 1000);
}

function aggregate5mTo15m(candles: CandleBar[]): CandleBar[] {
  if (candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const result: CandleBar[] = [];
  const FIFTEEN_MIN = 15 * 60;

  let bucket: CandleBar | null = null;
  let bucketStart = 0;

  for (const c of sorted) {
    const aligned = Math.floor(c.time / FIFTEEN_MIN) * FIFTEEN_MIN;
    if (bucket && bucketStart === aligned) {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume = (bucket.volume ?? 0) + (c.volume ?? 0);
      if (c.rth) bucket.rth = true;
    } else {
      if (bucket) result.push(bucket);
      bucketStart = aligned;
      bucket = { ...c, time: aligned };
    }
  }
  if (bucket) result.push(bucket);
  return result;
}

export default function MarketPage() {
  const [selectedSymbol, setSelectedSymbol] = useState("SPY");
  const [symbolDropdownOpen, setSymbolDropdownOpen] = useState(false);
  const [symbolSearch, setSymbolSearch] = useState("");
  const [showYellowBox, setShowYellowBox] = useState(true);
  const [dragZoomActive, setDragZoomActive] = useState(false);
  const [startDayIdx, setStartDayIdx] = useState(0);
  const [endDayIdx, setEndDayIdx] = useState(9);
  const [windowSize, setWindowSize] = useState(10);
  const [interval, setInterval] = useState<"5m" | "15m" | "60m">("5m");

  const chartRef = useRef<ChartHandle>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const symbolDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!symbolDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (symbolDropdownRef.current && !symbolDropdownRef.current.contains(e.target as Node)) {
        setSymbolDropdownOpen(false);
        setSymbolSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [symbolDropdownOpen]);

  const { data: symbolsData } = useQuery<SymbolsData>({ queryKey: ["/api/market/symbols"] });

  const { data: cachedDaysData, isLoading: daysLoading } = useQuery<{ symbol: string; days: DayInfo[] }>({
    queryKey: ["/api/data/cached-days", selectedSymbol],
    staleTime: 60 * 1000,
  });

  const sortedDays = useMemo(() => {
    if (!cachedDaysData?.days?.length) return [];
    return [...cachedDaysData.days].sort((a, b) => a.date.localeCompare(b.date));
  }, [cachedDaysData]);

  const hasCachedData = sortedDays.length > 0;

  useEffect(() => {
    if (sortedDays.length > 0) {
      const end = sortedDays.length - 1;
      const start = Math.max(0, end - windowSize + 1);
      setStartDayIdx(start);
      setEndDayIdx(end);
    }
  }, [sortedDays.length, selectedSymbol, windowSize]);

  const windowedDays = useMemo(() => {
    if (sortedDays.length === 0) return [];
    return sortedDays.slice(startDayIdx, endDayIdx + 1);
  }, [sortedDays, startDayIdx, endDayIdx]);

  const fromTimestamp = useMemo(() => {
    if (windowedDays.length === 0) return 0;
    return dateToTimestamp(windowedDays[0].date, 0);
  }, [windowedDays]);

  const toTimestamp = useMemo(() => {
    if (windowedDays.length === 0) return 0;
    return dateToTimestamp(windowedDays[windowedDays.length - 1].date, 23) + 3600;
  }, [windowedDays]);

  const fetchInterval = interval === "60m" ? "60m" : "5m";

  const { data: rawCandleData, isLoading: candlesLoading } = useQuery<{
    symbol: string; interval: string; candles: CandleBar[]; source: string;
  }>({
    queryKey: ["/api/data/cached-continuous", selectedSymbol, fetchInterval, fromTimestamp, toTimestamp],
    queryFn: async () => {
      const res = await fetch(`/api/data/cached-continuous/${selectedSymbol}/${fetchInterval}?from=${fromTimestamp}&to=${toTimestamp}`);
      if (!res.ok) throw new Error("Failed to fetch candles");
      return res.json();
    },
    enabled: hasCachedData && fromTimestamp > 0 && toTimestamp > 0,
    staleTime: 60 * 1000,
  });

  const candleData = useMemo(() => {
    if (!rawCandleData?.candles?.length) return rawCandleData;
    if (interval === "15m") {
      return { ...rawCandleData, candles: aggregate5mTo15m(rawCandleData.candles) };
    }
    return rawCandleData;
  }, [rawCandleData, interval]);

  const yellowBoxZones = useMemo(() => {
    if (!cachedDaysData?.days?.length) return [];
    return computeYellowBoxZones(cachedDaysData.days);
  }, [cachedDaysData]);

  const { zoneOverlays, bandOverlayData } = useMemo(() => {
    if (!showYellowBox || yellowBoxZones.length === 0 || !candleData?.candles?.length)
      return { zoneOverlays: [] as ZoneOverlay[], bandOverlayData: [] as BandOverlay[] };
    const result = buildZoneOverlays(yellowBoxZones, candleData.candles);
    return { zoneOverlays: result.lines, bandOverlayData: result.bands };
  }, [showYellowBox, yellowBoxZones, candleData]);

  const allSymbols = useMemo(() => {
    if (!symbolsData) return [];
    return [
      ...(symbolsData.etfs || []).map((s) => ({ ...s, category: "ETFs" })),
      ...(symbolsData.stocks || []).map((s) => ({ ...s, category: "Stocks" })),
      ...(symbolsData.futures || []).map((s) => ({ ...s, category: "Futures" })),
      ...(symbolsData.indices || []).map((s) => ({ ...s, category: "Indices" })),
    ];
  }, [symbolsData]);

  const filteredSymbols = useMemo(() => {
    const q = symbolSearch.trim().toLowerCase();
    if (!q) return allSymbols;
    return allSymbols.filter(
      (s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
    );
  }, [allSymbols, symbolSearch]);

  const groupedSymbols = useMemo(() => {
    const groups: Record<string, typeof filteredSymbols> = {};
    for (const s of filteredSymbols) {
      if (!groups[s.category]) groups[s.category] = [];
      groups[s.category].push(s);
    }
    return groups;
  }, [filteredSymbols]);

  const selectedSymbolName = allSymbols.find((s) => s.symbol === selectedSymbol)?.name ?? "";

  const shiftWindow = useCallback((direction: number) => {
    if (sortedDays.length === 0) return;
    const newStart = Math.max(0, Math.min(sortedDays.length - 1, startDayIdx + direction));
    const newEnd = Math.min(sortedDays.length - 1, newStart + windowSize - 1);
    setStartDayIdx(newStart);
    setEndDayIdx(newEnd);
  }, [sortedDays.length, startDayIdx, windowSize]);

  const jumpToRange = useCallback((idx: number) => {
    if (sortedDays.length === 0) return;
    const halfW = Math.floor(windowSize / 2);
    const center = Math.max(halfW, Math.min(sortedDays.length - 1 - (windowSize - halfW - 1), idx));
    const newStart = Math.max(0, center - halfW);
    const newEnd = Math.min(sortedDays.length - 1, newStart + windowSize - 1);
    setStartDayIdx(newStart);
    setEndDayIdx(newEnd);
  }, [sortedDays.length, windowSize]);

  const handleWindowSizeChange = useCallback((newSize: number) => {
    setWindowSize(newSize);
    if (sortedDays.length === 0) return;
    const newStart = Math.max(0, endDayIdx - newSize + 1);
    setStartDayIdx(newStart);
  }, [sortedDays.length, endDayIdx]);

  useEffect(() => {
    if (!timelineRef.current || sortedDays.length === 0) return;
    const cardWidth = 56;
    const containerWidth = timelineRef.current.offsetWidth;
    const centerIdx = Math.floor((startDayIdx + endDayIdx) / 2);
    const scrollLeft = centerIdx * cardWidth - containerWidth / 2 + cardWidth / 2;
    timelineRef.current.scrollTo({ left: Math.max(0, scrollLeft), behavior: "smooth" });
  }, [startDayIdx, endDayIdx, sortedDays.length]);

  const windowedCandleData = candleData?.candles ?? [];

  const currentDayInfo = windowedDays.length > 0 ? windowedDays[windowedDays.length - 1] : null;

  return (
    <div className="flex flex-col h-full overflow-auto bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-sm px-4 py-2.5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 mr-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          <span className="font-semibold text-sm tracking-tight">MarketView</span>
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="relative" ref={symbolDropdownRef}>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-symbol-dropdown"
              className="h-8 text-sm gap-1.5 min-w-[140px] justify-between font-semibold"
              onClick={() => { setSymbolDropdownOpen(!symbolDropdownOpen); setSymbolSearch(""); }}
            >
              <span>{selectedSymbol}</span>
              <span className="text-muted-foreground text-xs font-normal truncate max-w-[100px]">{selectedSymbolName}</span>
            </Button>
            {symbolDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-popover border rounded-md shadow-lg z-50 overflow-hidden">
                <div className="p-2 border-b">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      data-testid="input-symbol-search"
                      placeholder="Search symbol..."
                      value={symbolSearch}
                      onChange={(e) => setSymbolSearch(e.target.value)}
                      className="pl-8 h-8 text-sm"
                      autoFocus
                    />
                  </div>
                </div>
                <div className="max-h-80 overflow-auto">
                  {Object.entries(groupedSymbols).map(([category, symbols]) => (
                    <div key={category}>
                      <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/50 sticky top-0">{category}</div>
                      {symbols.map((s) => (
                        <button
                          key={s.symbol}
                          data-testid={`button-symbol-${s.symbol}`}
                          className={`w-full px-3 py-2 text-left hover:bg-accent flex items-center justify-between gap-2 text-sm ${
                            s.symbol === selectedSymbol ? "bg-accent font-medium" : ""
                          }`}
                          onClick={() => {
                            setSelectedSymbol(s.symbol);
                            setSymbolDropdownOpen(false);
                            setSymbolSearch("");
                          }}
                        >
                          <span className="font-medium text-xs">{s.symbol}</span>
                          <span className="text-muted-foreground text-xs truncate">{s.name}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {filteredSymbols.length === 0 && (
                    <div className="px-3 py-4 text-center text-sm text-muted-foreground">No symbols found</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link href="/news">
            <Button size="sm" variant="outline" data-testid="button-news" className="text-xs gap-1.5 h-7">
              <Newspaper className="w-3.5 h-3.5" />
              News
            </Button>
          </Link>
          <Link href="/data">
            <Button size="sm" variant="outline" data-testid="button-data-download" className="text-xs gap-1.5 h-7">
              <Database className="w-3.5 h-3.5" />
              Data
            </Button>
          </Link>
          <Select value={interval} onValueChange={(v) => setInterval(v as "5m" | "15m" | "60m")}>
            <SelectTrigger className="w-20 h-7 text-xs" data-testid="select-interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5m">5 min</SelectItem>
              <SelectItem value="15m">15 min</SelectItem>
              <SelectItem value="60m">60 min</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground border rounded-md px-2 py-1">
            <span className="w-2 h-2 rounded-sm inline-block" style={{ backgroundColor: "#26a69a" }} />RTH
            <span className="w-2 h-2 rounded-sm inline-block ml-1" style={{ backgroundColor: "#26a69a80" }} />ETH
          </div>
        </div>
      </header>

      <div className="flex flex-col flex-1 min-h-0 overflow-auto">
        <main className="flex-1 overflow-auto p-3 flex flex-col gap-3 min-w-0">
          {!hasCachedData && !daysLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-muted-foreground max-w-md">
                <Database className="w-12 h-12 mx-auto mb-4 opacity-30" />
                <h2 className="text-lg font-semibold mb-2">No Cached Data for {selectedSymbol}</h2>
                <p className="text-sm mb-4">
                  Download historical data first using the Data page to view charts with Yellow Box strategy overlays.
                </p>
                <Link href="/data">
                  <Button data-testid="button-go-to-data">
                    <Database className="w-4 h-4 mr-2" />
                    Go to Data Download
                  </Button>
                </Link>
              </div>
            </div>
          ) : daysLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <span className="text-sm">Loading cached data...</span>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-bold tracking-tight" data-testid="text-symbol">{selectedSymbol}</h1>
                  {currentDayInfo && (
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-muted-foreground">
                        O: <span className="text-foreground font-mono">{formatPrice(currentDayInfo.open)}</span>
                      </span>
                      <span className="text-muted-foreground">
                        H: <span className="text-foreground font-mono">{formatPrice(currentDayInfo.high)}</span>
                      </span>
                      <span className="text-muted-foreground">
                        L: <span className="text-foreground font-mono">{formatPrice(currentDayInfo.low)}</span>
                      </span>
                      <span className="text-muted-foreground">
                        C: <span className="text-foreground font-mono">{formatPrice(currentDayInfo.close)}</span>
                      </span>
                      <span className="text-muted-foreground">
                        V: <span className="text-foreground font-mono">{formatVolume(currentDayInfo.volume)}</span>
                      </span>
                    </div>
                  )}
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
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <CalendarDays className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Date Window:</span>
                </div>

                {windowedDays.length > 0 && (
                  <span className="text-xs font-medium" data-testid="text-date-range">
                    {formatDateFull(windowedDays[0].date)} — {formatDateFull(windowedDays[windowedDays.length - 1].date)}
                  </span>
                )}

                <div className="flex items-center gap-1 ml-auto">
                  <span className="text-xs text-muted-foreground">Days:</span>
                  <Select value={String(windowSize)} onValueChange={(v) => handleWindowSizeChange(Number(v))}>
                    <SelectTrigger className="w-20 h-7 text-xs" data-testid="select-window-size">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5 days</SelectItem>
                      <SelectItem value="10">10 days</SelectItem>
                      <SelectItem value="20">20 days</SelectItem>
                      <SelectItem value="40">40 days</SelectItem>
                      <SelectItem value="60">60 days</SelectItem>
                      <SelectItem value="120">120 days</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  size="icon"
                  variant="outline"
                  data-testid="button-window-prev"
                  disabled={startDayIdx <= 0}
                  onClick={() => shiftWindow(-windowSize)}
                  className="h-7 w-7"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-window-prev-day"
                  disabled={startDayIdx <= 0}
                  onClick={() => shiftWindow(-1)}
                  className="h-7 text-xs px-2"
                >
                  -1
                </Button>

                <div
                  ref={timelineRef}
                  data-testid="timeline-scroll"
                  className="flex-1 overflow-x-auto select-none"
                  style={{ scrollbarWidth: "none" }}
                >
                  <div className="flex gap-0.5 px-1 py-0.5" style={{ width: "max-content" }}>
                    {sortedDays.map((day, idx) => {
                      const isUp = day.close >= day.open;
                      const isInWindow = idx >= startDayIdx && idx <= endDayIdx;
                      const changePct = ((day.close - day.open) / day.open) * 100;
                      return (
                        <button
                          key={day.date}
                          data-testid={`button-day-${day.date}`}
                          onClick={() => jumpToRange(idx)}
                          className={`flex-shrink-0 w-12 rounded border px-1 py-1 text-center transition-all ${
                            isInWindow
                              ? "border-primary bg-primary/10 ring-1 ring-primary/50"
                              : "border-border/50 bg-card/50 hover:bg-card"
                          }`}
                        >
                          <div className="text-[8px] text-muted-foreground leading-tight">{formatDate(day.date)}</div>
                          <div className={`text-[9px] font-semibold font-mono leading-tight ${isUp ? "text-[#26a69a]" : "text-[#ef5350]"}`}>
                            {isUp ? "+" : ""}{changePct.toFixed(1)}%
                          </div>
                          <div className="h-0.5 rounded-full mt-0.5" style={{ backgroundColor: isUp ? "#26a69a" : "#ef5350", opacity: isInWindow ? 1 : 0.3 }} />
                        </button>
                      );
                    })}
                  </div>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-window-next-day"
                  disabled={endDayIdx >= sortedDays.length - 1}
                  onClick={() => shiftWindow(1)}
                  className="h-7 text-xs px-2"
                >
                  +1
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  data-testid="button-window-next"
                  disabled={endDayIdx >= sortedDays.length - 1}
                  onClick={() => shiftWindow(windowSize)}
                  className="h-7 w-7"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>

              <div className="rounded-lg border bg-card overflow-hidden relative flex-1" style={{ minHeight: 500 }}>
                <div className="absolute top-2 right-2 z-10 flex items-center gap-1 bg-card/90 backdrop-blur-sm border rounded-md p-0.5">
                  <Button
                    size="icon"
                    variant={dragZoomActive ? "default" : "ghost"}
                    data-testid="button-drag-zoom"
                    className="h-7 w-7"
                    title="Drag to zoom"
                    onClick={() => setDragZoomActive(!dragZoomActive)}
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    data-testid="button-zoom-reset"
                    className="h-7 w-7"
                    title="Fit all data"
                    onClick={() => { chartRef.current?.resetZoom(); setDragZoomActive(false); }}
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
                {candlesLoading ? (
                  <div className="flex items-center justify-center" style={{ height: 500 }}>
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm">Loading 5-min candle data...</span>
                    </div>
                  </div>
                ) : windowedCandleData.length === 0 ? (
                  <div className="flex items-center justify-center" style={{ height: 500 }}>
                    <div className="text-center text-muted-foreground">
                      <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">No candle data for selected window</p>
                    </div>
                  </div>
                ) : (
                  <CandlestickChart
                    ref={chartRef}
                    candles={windowedCandleData}
                    height={500}
                    showVolume
                    zoneOverlays={zoneOverlays}
                    bandOverlays={bandOverlayData}
                    dragZoomEnabled={dragZoomActive}
                    onDragZoomDone={() => setDragZoomActive(false)}
                  />
                )}
              </div>

              <div className="flex gap-3 text-xs text-muted-foreground justify-between flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: "#26a69a" }} /> RTH up
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: "#ef5350" }} /> RTH down
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: "#26a69a80" }} /> ETH up
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: "#ef535080" }} /> ETH down
                  </span>
                  {showYellowBox && (
                    <>
                      <span className="border-l border-border pl-3 flex items-center gap-1">
                        <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: "rgba(180, 160, 40, 0.35)" }} /> Yellow Box
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-3 h-1 rounded-sm inline-block" style={{ backgroundColor: "rgba(220, 220, 220, 0.8)" }} /> POC
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: "rgba(200, 40, 40, 0.25)" }} /> Avg Range
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-3 h-1 rounded-sm inline-block border-dashed border-b" style={{ borderColor: "rgba(220, 80, 80, 0.5)" }} /> Max Range
                      </span>
                    </>
                  )}
                </div>
                <span data-testid="text-bar-count">
                  {windowedCandleData.length.toLocaleString()} bars ·
                  {windowedDays.length} days ·
                  {interval} cached · {sortedDays.length} total days available
                </span>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
