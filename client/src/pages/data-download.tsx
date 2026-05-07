import { useState, useCallback, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Download,
  CheckCircle,
  XCircle,
  Loader2,
  Database,
  Trash2,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Shield,
  ArrowLeft,
  Radio,
  ExternalLink,
  Upload,
  FileJson,
} from "lucide-react";
import { Link } from "wouter";

const TICKERS = ["SPY", "QQQ", "AAPL", "MSFT", "TSLA", "NVDA", "AMZN", "META", "GOOGL", "IWM", "DIA", "GLD"];
const CURRENT_YEAR = new Date().getFullYear();
const START_YEAR = CURRENT_YEAR - 4;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface MonthStatus {
  year: number;
  month: number;
  status: string;
  barCount: number;
}

interface DaySummary {
  date: string;
  bars: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export default function DataDownloadPage() {
  const [ticker, setTicker] = useState("SPY");
  const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set());
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [filterMonth, setFilterMonth] = useState("all");

  const { data: keyStatus } = useQuery<{ valid: boolean; message: string }>({
    queryKey: ["/api/data/verify-key"],
  });

  const { data: statusData, isLoading: statusLoading } = useQuery<{
    symbol: string;
    months: MonthStatus[];
    totalBars: number;
    totalDays: number;
  }>({
    queryKey: ["/api/data/status", ticker],
    refetchInterval: 5000,
  });

  const { data: dailyData } = useQuery<{ symbol: string; days: DaySummary[] }>({
    queryKey: ["/api/data/daily-summary", ticker],
    enabled: (statusData?.totalBars ?? 0) > 0,
  });

  const { data: mwSummary } = useQuery<{
    rows: Array<{ symbol: string; resolution: string; bar_count: number; first_bar: number; last_bar: number }>;
  }>({ queryKey: ["/api/data/mw-summary"], refetchInterval: 30_000 });

  const downloadMutation = useMutation({
    mutationFn: async (params: { symbol: string; year: number; month: number }) => {
      const res = await apiRequest("POST", "/api/data/download", params);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/data/status", ticker] });
      queryClient.invalidateQueries({ queryKey: ["/api/data/daily-summary", ticker] });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/data/clear/${ticker}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/data/status", ticker] });
      queryClient.invalidateQueries({ queryKey: ["/api/data/daily-summary", ticker] });
    },
  });

  const monthStatusMap = useMemo(() => {
    const map = new Map<string, MonthStatus>();
    if (statusData?.months) {
      for (const m of statusData.months) {
        map.set(`${m.year}-${m.month}`, m);
      }
    }
    return map;
  }, [statusData]);

  const toggleMonth = useCallback((key: string) => {
    setSelectedMonths(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    const keys: string[] = [];
    for (let y = START_YEAR; y <= CURRENT_YEAR; y++) {
      const maxMonth = y === CURRENT_YEAR ? new Date().getMonth() + 1 : 12;
      for (let m = 1; m <= maxMonth; m++) {
        const key = `${y}-${m}`;
        const st = monthStatusMap.get(key);
        if (!st || st.status !== "done") {
          keys.push(key);
        }
      }
    }
    setSelectedMonths(new Set(keys));
  }, [monthStatusMap]);

  const clearSelection = useCallback(() => {
    setSelectedMonths(new Set());
  }, []);

  const [downloadQueue, setDownloadQueue] = useState<string[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);

  // ── DATA PAGE FIX: Full JSON export / import state ────────────────────────
  const [importState, setImportState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [importMessage, setImportMessage] = useState("");

  // ── MW CSV import state ───────────────────────────────────────────────────
  const [csvSymbol, setCsvSymbol] = useState("MES");
  const [csvState, setCsvState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [csvMessage, setCsvMessage] = useState("");
  const [dumpState, setDumpState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [dumpMessage, setDumpMessage] = useState("");

  const startDownload = useCallback(async () => {
    const queue = Array.from(selectedMonths).sort();
    setDownloadQueue(queue);
    setIsDownloading(true);

    for (const key of queue) {
      const [y, m] = key.split("-").map(Number);
      try {
        await downloadMutation.mutateAsync({ symbol: ticker, year: y, month: m });
      } catch {
      }
      setDownloadQueue(prev => prev.filter(k => k !== key));
    }
    setIsDownloading(false);
    setSelectedMonths(new Set());
    queryClient.invalidateQueries({ queryKey: ["/api/data/status", ticker] });
    queryClient.invalidateQueries({ queryKey: ["/api/data/daily-summary", ticker] });
  }, [selectedMonths, ticker, downloadMutation]);

  const getMonthStyle = (year: number, month: number) => {
    const key = `${year}-${month}`;
    const st = monthStatusMap.get(key);
    const isSelected = selectedMonths.has(key);
    const isQueued = downloadQueue.includes(key);

    if (isQueued) return { bg: "bg-amber-500/20 border-amber-500/50", text: "text-amber-400", icon: "downloading" as const };
    if (st?.status === "done") return { bg: "bg-emerald-500/15 border-emerald-500/40", text: "text-emerald-400", icon: "done" as const };
    if (st?.status === "downloading") return { bg: "bg-amber-500/20 border-amber-500/50", text: "text-amber-400", icon: "downloading" as const };
    if (st?.status === "error") return { bg: "bg-red-500/15 border-red-500/40", text: "text-red-400", icon: "error" as const };
    if (isSelected) return { bg: "bg-blue-500/15 border-blue-500/50 ring-1 ring-blue-500/60", text: "text-blue-300", icon: "selected" as const };
    return { bg: "bg-[#1e222d] border-[#2a2e39]", text: "text-[#787b86]", icon: "none" as const };
  };

  // Handle JSON import: parse file, POST to /api/data/import-full, invalidate queries
  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // allow re-selecting the same file
    setImportState("loading");
    setImportMessage("");
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await fetch("/api/data/import-full", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(result.error ?? "Import failed");
      setImportMessage(`Imported ${result.candlesInserted.toLocaleString()} candles, ${result.signalsInserted.toLocaleString()} signals`);
      setImportState("done");
      queryClient.invalidateQueries({ queryKey: ["/api/data/status", data.symbol ?? ticker] });
      queryClient.invalidateQueries({ queryKey: ["/api/data/daily-summary", data.symbol ?? ticker] });
      queryClient.invalidateQueries({ queryKey: ["/api/data/mw-summary"] });
    } catch (err: any) {
      setImportMessage(err.message ?? "Failed to import");
      setImportState("error");
    }
  }, [ticker]);

  // Handle MW CSV file import (manual MW export or HistoryDumper output)
  const handleCsvImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    // Auto-detect symbol from filename: "MESM6 - 15 min - ETH.csv" → "MES"
    const nameMatch = file.name.match(/^([A-Z]+\d?)/i);
    if (nameMatch) {
      const raw = nameMatch[1].toUpperCase().replace(/[HMUZ]\d{1,2}$/, "");
      if (raw) setCsvSymbol(raw);
    }
    setCsvState("loading");
    setCsvMessage("");
    try {
      const csv = await file.text();
      const sym = csvSymbol.replace(/[HMUZ]\d{1,2}$/, "").toUpperCase();
      const res = await fetch("/api/data/import-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv, symbol: sym }),
      });
      const text = await res.text();
      let result: any;
      try { result = JSON.parse(text); } catch { throw new Error("Server not ready — restart npm run dev and try again"); }
      if (!res.ok || result.error) throw new Error(result.error ?? "Import failed");
      setCsvMessage(`Imported ${result.bars.toLocaleString()} bars (${result.resolution}m) for ${result.symbol}`);
      setCsvState("done");
      queryClient.invalidateQueries({ queryKey: ["/api/data/mw-summary"] });
    } catch (err: any) {
      setCsvMessage(err.message ?? "Failed to import CSV");
      setCsvState("error");
    }
  }, [csvSymbol]);

  const handleMwDumpImport = useCallback(async () => {
    setDumpState("loading");
    setDumpMessage("");
    try {
      const sym = csvSymbol.replace(/[HMUZ]\d{1,2}$/, "").toUpperCase();
      const res = await fetch("/api/data/import-mw-dump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym }),
      });
      const text = await res.text();
      let result: any;
      try { result = JSON.parse(text); } catch { throw new Error("Server not ready — restart npm run dev and try again"); }
      if (!res.ok || result.error) throw new Error(result.error ?? "Import failed");
      const fileList = (result.files as Array<{ file: string; bars: number; resolution: string }>)
        .map(f => `${f.resolution}m: ${f.bars.toLocaleString()} bars`).join(", ");
      setDumpMessage(`Loaded ${result.totalBars.toLocaleString()} bars for ${result.symbol} (${fileList})`);
      setDumpState("done");
      queryClient.invalidateQueries({ queryKey: ["/api/data/mw-summary"] });
    } catch (err: any) {
      setDumpMessage(err.message ?? "Failed");
      setDumpState("error");
    }
  }, [csvSymbol]);

  const isFutureMonth = (year: number, month: number) => {
    const now = new Date();
    return year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
  };

  const filteredDays = useMemo(() => {
    if (!dailyData?.days) return [];
    if (filterMonth === "all") return dailyData.days;
    return dailyData.days.filter(d => {
      const m = new Date(d.date).getMonth() + 1;
      return String(m) === filterMonth;
    });
  }, [dailyData, filterMonth]);

  return (
    <div className="flex flex-col h-full overflow-auto bg-[#131722] text-[#d1d4dc]">
      <div className="p-4 lg:p-6 max-w-6xl mx-auto w-full space-y-5">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Link href="/">
                <Button size="sm" variant="ghost" className="text-[#787b86] hover:text-white gap-1 -ml-2" data-testid="button-back-to-chart">
                  <ArrowLeft className="w-4 h-4" />
                  Chart
                </Button>
              </Link>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white" data-testid="text-data-download-title">Data Download</h1>
            <p className="text-sm text-[#787b86] mt-1">Download 5-min & 60-min candle data from Polygon.io</p>
          </div>
          {statusData && statusData.totalBars > 0 && (
            <div className="flex items-center gap-2 bg-[#1e222d] border border-[#2a2e39] rounded-lg px-3 py-2">
              <Database className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-medium text-white" data-testid="text-total-bars">
                {statusData.totalBars.toLocaleString()} bars
              </span>
              <span className="text-xs text-[#787b86]">for {ticker}</span>
            </div>
          )}
        </div>

        <div className={`rounded-lg border px-4 py-3 flex items-center gap-2 ${
          keyStatus?.valid
            ? "bg-emerald-500/10 border-emerald-500/30"
            : "bg-red-500/10 border-red-500/30"
        }`}>
          {keyStatus?.valid ? (
            <Shield className="w-4 h-4 text-emerald-400" />
          ) : (
            <XCircle className="w-4 h-4 text-red-400" />
          )}
          <span className={`text-sm font-medium ${keyStatus?.valid ? "text-emerald-400" : "text-red-400"}`}
                data-testid="text-api-key-status">
            {keyStatus?.message ?? "Checking API key..."}
          </span>
        </div>

        <div className="rounded-lg border border-[#2a2e39] bg-[#1a1e2e] p-4 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Select value={ticker} onValueChange={(v) => { setTicker(v); setSelectedMonths(new Set()); }}>
              <SelectTrigger className="w-28 bg-[#131722] border-[#2a2e39]" data-testid="select-data-ticker">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TICKERS.map(t => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              onClick={selectAll}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
              data-testid="button-select-all"
            >
              Select All
            </button>
            <span className="text-[#787b86]">|</span>
            <button
              onClick={clearSelection}
              className="text-sm text-[#787b86] hover:text-[#d1d4dc] transition-colors"
              data-testid="button-clear-selection"
            >
              Clear
            </button>
            <div className="ml-auto">
              <Button
                onClick={startDownload}
                disabled={selectedMonths.size === 0 || isDownloading || !keyStatus?.valid}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                data-testid="button-download"
              >
                {isDownloading ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 mr-2" />
                )}
                Download{selectedMonths.size > 0 ? ` (${selectedMonths.size})` : ""}
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            {Array.from({ length: CURRENT_YEAR - START_YEAR + 1 }, (_, i) => START_YEAR + i).map(year => (
              <div key={year} className="flex items-center gap-1.5">
                <span className="w-10 text-xs text-[#787b86] font-medium flex-shrink-0">{year}</span>
                <div className="flex gap-1 flex-wrap flex-1">
                  {MONTHS.map((monthName, mi) => {
                    const month = mi + 1;
                    if (isFutureMonth(year, month)) {
                      return (
                        <div key={mi} className="w-[72px] h-14 rounded border border-[#1e222d] bg-[#131722] flex items-center justify-center opacity-40">
                          <span className="text-[10px] text-[#787b86]">{monthName}</span>
                        </div>
                      );
                    }
                    const key = `${year}-${month}`;
                    const style = getMonthStyle(year, month);
                    const st = monthStatusMap.get(key);
                    return (
                      <button
                        key={mi}
                        onClick={() => {
                          if (st?.status === "done") return;
                          toggleMonth(key);
                        }}
                        disabled={isDownloading}
                        className={`w-[72px] h-14 rounded border ${style.bg} flex flex-col items-center justify-center transition-all hover:brightness-110 ${
                          st?.status === "done" ? "cursor-default" : "cursor-pointer"
                        }`}
                        data-testid={`button-month-${year}-${month}`}
                      >
                        <div className="flex items-center gap-1">
                          <span className="text-[11px] font-medium text-[#d1d4dc]">{monthName}</span>
                          {style.icon === "done" && <CheckCircle className="w-3 h-3 text-emerald-400" />}
                          {style.icon === "downloading" && <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />}
                          {style.icon === "error" && <XCircle className="w-3 h-3 text-red-400" />}
                        </div>
                        <span className={`text-[10px] ${style.text} font-mono`}>
                          {st?.status === "done" ? st.barCount.toLocaleString() : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-3 text-xs text-[#787b86] flex-wrap pt-1">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded border border-[#2a2e39] bg-[#1e222d] inline-block" /> No data
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded border border-emerald-500/40 bg-emerald-500/15 inline-block" />
              <CheckCircle className="w-3 h-3 text-emerald-400" /> Downloaded
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded border border-amber-500/50 bg-amber-500/20 inline-block" />
              <Loader2 className="w-3 h-3 text-amber-400" /> Downloading
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded border border-red-500/40 bg-red-500/15 inline-block" />
              <XCircle className="w-3 h-3 text-red-400" /> Error
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded border border-blue-500/50 bg-blue-500/15 ring-1 ring-blue-500/60 inline-block" /> Selected
            </span>
          </div>
        </div>

        {(statusData?.totalBars ?? 0) > 0 && (
          <div className="rounded-lg border border-[#2a2e39] bg-[#1a1e2e] p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-blue-400" />
                <h2 className="text-base font-semibold text-white" data-testid="text-stored-data-title">
                  Stored Data &mdash; {ticker}
                </h2>
                <span className="text-xs text-[#787b86]">
                  {statusData?.totalDays ?? 0} days / {statusData?.totalBars?.toLocaleString() ?? 0} bars
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select value={filterMonth} onValueChange={setFilterMonth}>
                  <SelectTrigger className="w-32 h-8 bg-[#131722] border-[#2a2e39] text-sm" data-testid="select-filter-month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All months</SelectItem>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => clearMutation.mutate()}
                  className="text-red-400 border-red-500/30 hover:bg-red-500/10"
                  disabled={clearMutation.isPending}
                  data-testid="button-clear-data"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  Clear Data
                </Button>
              </div>
            </div>

            <div className="border border-[#2a2e39] rounded overflow-hidden">
              <div className="grid grid-cols-[40px_1fr_80px_90px_80px_80px_90px_100px_90px] gap-0 text-xs font-medium text-[#787b86] bg-[#131722] px-3 py-2 border-b border-[#2a2e39]">
                <span></span>
                <span>DATE</span>
                <span className="text-right">BARS</span>
                <span className="text-right">OPEN</span>
                <span className="text-right">HIGH</span>
                <span className="text-right">LOW</span>
                <span className="text-right">CLOSE</span>
                <span className="text-right">VOLUME</span>
                <span className="text-right">CHANGE</span>
              </div>
              <div className="max-h-[400px] overflow-auto">
                {statusLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="px-3 py-2 border-b border-[#2a2e39]">
                      <Skeleton className="h-4 w-full" />
                    </div>
                  ))
                ) : filteredDays.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[#787b86] text-sm">
                    No data available
                  </div>
                ) : (
                  filteredDays.slice(0, 200).map((day) => {
                    const change = day.open > 0 ? ((day.close - day.open) / day.open) * 100 : 0;
                    const isUp = change >= 0;
                    const dateObj = new Date(day.date);
                    const dayName = dateObj.toLocaleDateString("en-US", { weekday: "short" });
                    return (
                      <div
                        key={day.date}
                        className="grid grid-cols-[40px_1fr_80px_90px_80px_80px_90px_100px_90px] gap-0 text-xs px-3 py-2 border-b border-[#2a2e39] hover:bg-[#1e222d] transition-colors"
                        data-testid={`row-day-${day.date}`}
                      >
                        <button
                          onClick={() => {
                            setExpandedDays(prev => {
                              const next = new Set(prev);
                              if (next.has(day.date)) next.delete(day.date);
                              else next.add(day.date);
                              return next;
                            });
                          }}
                          className="text-[#787b86] hover:text-white"
                        >
                          {expandedDays.has(day.date) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                        <span className="text-[#d1d4dc]">
                          {day.date} <span className="text-[#787b86] ml-1">{dayName}</span>
                        </span>
                        <span className="text-right text-[#787b86] flex items-center justify-end gap-1">
                          <BarChart3 className="w-3 h-3" /> {day.bars}
                        </span>
                        <span className="text-right font-mono text-[#d1d4dc]">{Number(day.open).toFixed(2)}</span>
                        <span className="text-right font-mono text-[#d1d4dc]">{Number(day.high).toFixed(2)}</span>
                        <span className="text-right font-mono text-[#d1d4dc]">{Number(day.low).toFixed(2)}</span>
                        <span className="text-right font-mono font-bold text-white">{Number(day.close).toFixed(2)}</span>
                        <span className="text-right font-mono text-[#787b86]">{Number(day.volume).toLocaleString()}</span>
                        <span className={`text-right font-mono flex items-center justify-end gap-0.5 ${isUp ? "text-emerald-400" : "text-red-400"}`}>
                          ~{isUp ? "+" : ""}{change.toFixed(2)}%
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── DATA PAGE FIX: Full JSON Export / Import ──────────────────── */}
      {/* Export: one JSON file with all candles + signals keyed by symbol+interval */}
      {/* Import: re-upload to restore exact chart state without losing any existing data */}
      <div className="mt-6 rounded-lg border border-[#2a2e39] bg-[#1a1e2e] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <FileJson className="w-4 h-4 text-blue-400" />
          <h2 className="text-sm font-semibold text-[#d1d4dc]">Full Dataset Export / Import</h2>
          <span className="text-xs text-[#787b86] ml-1">— candles + signals in one JSON file</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Export: download all candles + signals for the selected ticker */}
          <a
            href={`/api/data/export-full/${ticker}`}
            download
            className="flex items-center gap-2 px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors"
            data-testid="button-export-json"
          >
            <Download className="w-4 h-4" />
            Export {ticker} JSON
          </a>

          {/* Import: re-upload a previously exported JSON to restore state */}
          <label
            className="flex items-center gap-2 px-3 py-2 rounded border border-[#2a2e39] bg-[#131722] hover:bg-[#1e222d] text-[#d1d4dc] text-sm font-medium cursor-pointer transition-colors"
            data-testid="label-import-json"
          >
            <Upload className="w-4 h-4 text-blue-400" />
            Import JSON
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImportFile}
              data-testid="input-import-file"
            />
          </label>

          {importState === "loading" && (
            <span className="flex items-center gap-1 text-sm text-amber-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Importing…
            </span>
          )}
          {importState === "done" && (
            <span className="flex items-center gap-1 text-sm text-emerald-400">
              <CheckCircle className="w-3.5 h-3.5" /> {importMessage}
            </span>
          )}
          {importState === "error" && (
            <span className="flex items-center gap-1 text-sm text-red-400">
              <XCircle className="w-3.5 h-3.5" /> {importMessage}
            </span>
          )}
        </div>

        <p className="text-xs text-[#787b86]">
          Export saves all downloaded candles + locked signal levels to a single JSON. Import re-uploads it to restore exact chart state — new candles are appended, existing data is never overwritten.
        </p>
      </div>

      {/* ── MotiveWave CSV Import ─────────────────────────────────── */}
      <div className="mt-4 rounded-lg border border-[#2a2e39] bg-[#131722] p-5">
        <div className="flex items-center gap-2 mb-3">
          <Upload className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-semibold text-[#d1d4dc]">Import MotiveWave CSV</h2>
          <span className="text-xs text-[#787b86] ml-1">— MW manual export or HistoryDumper study output</span>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-3">
          {/* Symbol input */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#787b86]">Symbol:</span>
            <input
              value={csvSymbol}
              onChange={e => setCsvSymbol(e.target.value.toUpperCase())}
              className="w-20 px-2 py-1 text-xs rounded border border-[#2a2e39] bg-[#0d1117] text-[#d1d4dc] focus:outline-none focus:border-violet-500"
              placeholder="MES"
            />
          </div>

          {/* File upload: MW manual export CSV */}
          <label className="flex items-center gap-2 px-3 py-2 rounded border border-[#2a2e39] bg-[#131722] hover:bg-[#1e222d] text-[#d1d4dc] text-sm font-medium cursor-pointer transition-colors">
            <Upload className="w-4 h-4 text-violet-400" />
            Upload MW CSV
            <input type="file" accept=".csv" className="hidden" onChange={handleCsvImport} />
          </label>

          {/* Load from HistoryDumper dump file on disk */}
          <button
            onClick={handleMwDumpImport}
            disabled={dumpState === "loading"}
            className="flex items-center gap-2 px-3 py-2 rounded border border-[#2a2e39] bg-[#131722] hover:bg-[#1e222d] text-[#d1d4dc] text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Database className="w-4 h-4 text-violet-400" />
            {dumpState === "loading" ? "Loading…" : "Load MW Dump"}
          </button>

          {/* CSV status */}
          {csvState === "loading" && <span className="flex items-center gap-1 text-sm text-amber-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Importing…</span>}
          {csvState === "done"    && <span className="flex items-center gap-1 text-sm text-emerald-400"><CheckCircle className="w-3.5 h-3.5" /> {csvMessage}</span>}
          {csvState === "error"   && <span className="flex items-center gap-1 text-sm text-red-400"><XCircle className="w-3.5 h-3.5" /> {csvMessage}</span>}
          {dumpState === "loading" && <span className="flex items-center gap-1 text-sm text-amber-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading dump…</span>}
          {dumpState === "done"    && <span className="flex items-center gap-1 text-sm text-emerald-400"><CheckCircle className="w-3.5 h-3.5" /> {dumpMessage}</span>}
          {dumpState === "error"   && <span className="flex items-center gap-1 text-sm text-red-400"><XCircle className="w-3.5 h-3.5" /> {dumpMessage}</span>}
        </div>

        <div className="text-xs text-[#787b86] space-y-1">
          <p><span className="text-violet-400 font-medium">Upload MW CSV</span> — right-click any MW chart → Export Data → save as CSV. Supports MW format (DD/MM/YYYY) and volume like 17.8K. Resolution auto-detected from timestamp gaps.</p>
          <p><span className="text-violet-400 font-medium">Load MW Dump</span> — apply the <span className="text-[#d1d4dc]">HistoryDumper</span> study to any MW chart, then click this to load <code className="bg-[#1e222d] px-1 rounded">~/MotiveWave Extensions/dump_{"{symbol}"}_{"{res}"}.csv</code> directly from disk (no file picker needed).</p>
        </div>
      </div>

      {/* ── MotiveWave Live Candle Cache ──────────────────────────── */}
      <div className="mt-6 rounded-lg border border-[#2a2e39] bg-[#131722] p-5">
        <div className="flex items-center gap-2 mb-4">
          <Radio className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-[#d1d4dc]">MotiveWave Live Data Cache</h2>
          <span className="text-xs text-[#787b86] ml-1">— bars recorded from MW via WebSocket, stored locally</span>
        </div>

        {!mwSummary?.rows?.length ? (
          <p className="text-xs text-[#787b86]">No MotiveWave bars cached yet. Connect MotiveWave with the LiveBarRelay study to start recording.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#2a2e39]">
                  {["Symbol", "Interval", "Bars", "First Bar (UTC)", "Last Bar (UTC)", "Apply to Chart", "Download CSV"].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[#787b86] font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mwSummary.rows.map(row => {
                  const label = row.resolution === "1" ? "1m" : row.resolution === "5" ? "5m" : row.resolution === "60" ? "60m" : `${row.resolution}m`;
                  const chartInterval = row.resolution === "1" ? "1m" : row.resolution === "60" ? "60m" : "5m";
                  const first = new Date(row.first_bar * 1000).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
                  const last  = new Date(row.last_bar  * 1000).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
                  return (
                    <tr key={`${row.symbol}-${row.resolution}`} className="border-b border-[#1e2230] hover:bg-[#1c2030]">
                      <td className="px-3 py-2 font-semibold text-[#42a5f5]">{row.symbol}</td>
                      <td className="px-3 py-2 text-[#d1d4dc]">{label}</td>
                      <td className="px-3 py-2 text-[#d1d4dc] font-mono">{row.bar_count.toLocaleString()}</td>
                      <td className="px-3 py-2 text-[#787b86] font-mono">{first}</td>
                      <td className="px-3 py-2 text-[#787b86] font-mono">{last}</td>
                      <td className="px-3 py-2">
                        <a
                          href={`/?symbol=${encodeURIComponent(row.symbol)}&interval=${chartInterval}`}
                          className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300 transition-colors font-medium"
                        >
                          <ExternalLink className="w-3 h-3" />
                          View Chart
                        </a>
                      </td>
                      <td className="px-3 py-2">
                        <a
                          href={`/api/data/mw-export/${row.symbol}/${row.resolution}`}
                          download
                          className="flex items-center gap-1 text-[#42a5f5] hover:text-white transition-colors"
                        >
                          <Download className="w-3 h-3" />
                          {row.symbol}_{label}.csv
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
