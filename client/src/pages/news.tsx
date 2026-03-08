import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Newspaper,
  Download,
  ExternalLink,
  BarChart3,
  Filter,
  RefreshCw,
  Calendar,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  DollarSign,
  Globe,
  Briefcase,
  Activity,
  Bitcoin,
} from "lucide-react";
import { Link } from "wouter";

interface NewsArticle {
  id: number;
  title: string;
  description: string | null;
  content: string | null;
  url: string;
  source: string | null;
  imageUrl: string | null;
  publishedAt: string;
  category: string;
}

interface CategoryInfo {
  category: string;
  label: string;
}

const CATEGORY_CONFIG: Record<string, { icon: typeof TrendingUp; color: string; bgColor: string }> = {
  fed_policy: { icon: DollarSign, color: "#f59e0b", bgColor: "rgba(245, 158, 11, 0.15)" },
  market_crash: { icon: TrendingDown, color: "#ef4444", bgColor: "rgba(239, 68, 68, 0.15)" },
  market_rally: { icon: TrendingUp, color: "#22c55e", bgColor: "rgba(34, 197, 94, 0.15)" },
  inflation: { icon: Activity, color: "#f97316", bgColor: "rgba(249, 115, 22, 0.15)" },
  geopolitical: { icon: Globe, color: "#8b5cf6", bgColor: "rgba(139, 92, 246, 0.15)" },
  earnings: { icon: Briefcase, color: "#3b82f6", bgColor: "rgba(59, 130, 246, 0.15)" },
  recession: { icon: AlertTriangle, color: "#ef4444", bgColor: "rgba(239, 68, 68, 0.12)" },
  crypto: { icon: Bitcoin, color: "#f59e0b", bgColor: "rgba(245, 158, 11, 0.12)" },
};

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateFull(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function TimelineChart({ articles, onSelectArticle }: { articles: NewsArticle[]; onSelectArticle: (a: NewsArticle) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const sorted = useMemo(() => {
    return [...articles].sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
  }, [articles]);

  const categoryOrder = ["fed_policy", "market_crash", "market_rally", "inflation", "geopolitical", "earnings", "recession", "crypto"];

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || sorted.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padding = { top: 30, right: 20, bottom: 50, left: 60 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    const minTime = new Date(sorted[0].publishedAt).getTime();
    const maxTime = new Date(sorted[sorted.length - 1].publishedAt).getTime();
    const timeRange = maxTime - minTime || 1;

    ctx.fillStyle = "#131722";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "#1e222d";
    ctx.lineWidth = 1;

    const numTimeGridLines = Math.min(8, Math.max(4, Math.floor(chartW / 120)));
    for (let i = 0; i <= numTimeGridLines; i++) {
      const x = padding.left + (i / numTimeGridLines) * chartW;
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, padding.top + chartH);
      ctx.stroke();

      const t = new Date(minTime + (i / numTimeGridLines) * timeRange);
      ctx.fillStyle = "#787b86";
      ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(t.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), x, h - padding.bottom + 18);
    }

    const laneH = chartH / categoryOrder.length;
    for (let i = 0; i < categoryOrder.length; i++) {
      const y = padding.top + i * laneH;
      ctx.strokeStyle = "#1e222d";
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartW, y);
      ctx.stroke();

      const cat = categoryOrder[i];
      const cfg = CATEGORY_CONFIG[cat];
      ctx.fillStyle = cfg?.color || "#787b86";
      ctx.font = "9px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "right";
      const label = cat.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
      ctx.fillText(label.length > 10 ? label.slice(0, 9) + "…" : label, padding.left - 5, y + laneH / 2 + 3);
    }

    for (let i = 0; i < sorted.length; i++) {
      const article = sorted[i];
      const t = new Date(article.publishedAt).getTime();
      const x = padding.left + ((t - minTime) / timeRange) * chartW;
      const laneIdx = categoryOrder.indexOf(article.category);
      const lane = laneIdx >= 0 ? laneIdx : 0;
      const y = padding.top + lane * laneH + laneH / 2;

      const cfg = CATEGORY_CONFIG[article.category];
      const isHovered = hoveredIdx === i;
      const radius = isHovered ? 7 : 5;

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isHovered ? (cfg?.color || "#6366f1") : (cfg?.bgColor || "rgba(99, 102, 241, 0.3)");
      ctx.fill();
      ctx.strokeStyle = cfg?.color || "#6366f1";
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      ctx.stroke();
    }
  }, [sorted, hoveredIdx]);

  const handleMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || sorted.length === 0) return;

    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;

    const padding = { top: 30, right: 20, bottom: 50, left: 60 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    const minTime = new Date(sorted[0].publishedAt).getTime();
    const maxTime = new Date(sorted[sorted.length - 1].publishedAt).getTime();
    const timeRange = maxTime - minTime || 1;
    const laneH = chartH / 8;

    let closest = -1;
    let closestDist = Infinity;

    for (let i = 0; i < sorted.length; i++) {
      const t = new Date(sorted[i].publishedAt).getTime();
      const x = padding.left + ((t - minTime) / timeRange) * chartW;
      const laneIdx = ["fed_policy", "market_crash", "market_rally", "inflation", "geopolitical", "earnings", "recession", "crypto"].indexOf(sorted[i].category);
      const y = padding.top + (laneIdx >= 0 ? laneIdx : 0) * laneH + laneH / 2;

      const dist = Math.sqrt((mx - x) ** 2 + (my - y) ** 2);
      if (dist < 15 && dist < closestDist) {
        closest = i;
        closestDist = dist;
      }
    }

    setHoveredIdx(closest >= 0 ? closest : null);
    setTooltipPos(closest >= 0 ? { x: mx, y: my } : null);
  };

  const handleClick = () => {
    if (hoveredIdx !== null && sorted[hoveredIdx]) {
      onSelectArticle(sorted[hoveredIdx]);
    }
  };

  const hoveredArticle = hoveredIdx !== null ? sorted[hoveredIdx] : null;

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: 350 }}>
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { setHoveredIdx(null); setTooltipPos(null); }}
        onClick={handleClick}
        data-testid="news-timeline-chart"
      />
      {hoveredArticle && tooltipPos && (
        <div
          className="absolute z-20 bg-popover border rounded-md shadow-lg p-2.5 max-w-xs pointer-events-none"
          style={{
            left: Math.min(tooltipPos.x + 12, (containerRef.current?.offsetWidth || 400) - 280),
            top: Math.max(0, tooltipPos.y - 60),
          }}
          data-testid="news-tooltip"
        >
          <div className="text-[10px] text-muted-foreground mb-1">{formatDateFull(hoveredArticle.publishedAt)}</div>
          <div className="text-xs font-medium leading-tight line-clamp-2">{hoveredArticle.title}</div>
          <div className="text-[10px] text-muted-foreground mt-1">{hoveredArticle.source} · Click to view</div>
        </div>
      )}
    </div>
  );
}

export default function NewsPage() {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedArticle, setSelectedArticle] = useState<NewsArticle | null>(null);

  const { data: categories } = useQuery<CategoryInfo[]>({
    queryKey: ["/api/news/categories"],
  });

  const { data: articlesData, isLoading } = useQuery<{ articles: NewsArticle[]; total: number }>({
    queryKey: ["/api/news/articles", selectedCategory],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "500" });
      if (selectedCategory !== "all") params.set("category", selectedCategory);
      const res = await fetch(`/api/news/articles?${params}`);
      if (!res.ok) throw new Error("Failed to fetch articles");
      return res.json();
    },
  });

  const fetchNewsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/news/fetch", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/news/articles"] });
    },
  });

  const fetchHistoricalMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/news/fetch-historical", {
        fromDate: "2020-01-01",
        toDate: new Date().toISOString().slice(0, 10),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/news/articles"] });
    },
  });

  const articles = articlesData?.articles || [];

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of articles) {
      counts[a.category] = (counts[a.category] || 0) + 1;
    }
    return counts;
  }, [articles]);

  const dateRange = useMemo(() => {
    if (articles.length === 0) return null;
    const sorted = [...articles].sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
    return {
      from: formatDateShort(sorted[0].publishedAt),
      to: formatDateShort(sorted[sorted.length - 1].publishedAt),
    };
  }, [articles]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-sm px-4 py-2.5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 mr-2">
          <Newspaper className="w-5 h-5 text-primary" />
          <span className="font-semibold text-sm tracking-tight">Market News</span>
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Select value={selectedCategory} onValueChange={setSelectedCategory}>
            <SelectTrigger className="w-48 h-8 text-xs" data-testid="select-news-category">
              <Filter className="w-3.5 h-3.5 mr-1.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories?.map((c) => (
                <SelectItem key={c.category} value={c.category}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {dateRange && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Calendar className="w-3.5 h-3.5" />
              <span>{dateRange.from} — {dateRange.to}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Link href="/">
            <Button size="sm" variant="outline" data-testid="button-back-to-chart" className="text-xs gap-1.5 h-7">
              <BarChart3 className="w-3.5 h-3.5" />
              Chart
            </Button>
          </Link>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-fetch-news"
            className="text-xs gap-1.5 h-7"
            onClick={() => fetchNewsMutation.mutate()}
            disabled={fetchNewsMutation.isPending}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${fetchNewsMutation.isPending ? "animate-spin" : ""}`} />
            Fetch Latest
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-fetch-historical"
            className="text-xs gap-1.5 h-7"
            onClick={() => fetchHistoricalMutation.mutate()}
            disabled={fetchHistoricalMutation.isPending}
          >
            <Download className={`w-3.5 h-3.5 ${fetchHistoricalMutation.isPending ? "animate-spin" : ""}`} />
            Fetch Historical
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-3 flex flex-col gap-3">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">Loading news data...</span>
            </div>
          </div>
        ) : articles.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground max-w-md">
              <Newspaper className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <h2 className="text-lg font-semibold mb-2">No News Articles Yet</h2>
              <p className="text-sm mb-4">
                Fetch market-moving news from GNews to populate the timeline chart with major market events.
              </p>
              <div className="flex gap-2 justify-center">
                <Button
                  data-testid="button-empty-fetch"
                  onClick={() => fetchNewsMutation.mutate()}
                  disabled={fetchNewsMutation.isPending}
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${fetchNewsMutation.isPending ? "animate-spin" : ""}`} />
                  Fetch Latest News
                </Button>
                <Button
                  variant="outline"
                  data-testid="button-empty-fetch-historical"
                  onClick={() => fetchHistoricalMutation.mutate()}
                  disabled={fetchHistoricalMutation.isPending}
                >
                  <Download className={`w-4 h-4 mr-2 ${fetchHistoricalMutation.isPending ? "animate-spin" : ""}`} />
                  Fetch Historical
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-lg font-bold" data-testid="text-news-title">Market Event Timeline</h2>
              <span className="text-xs text-muted-foreground" data-testid="text-article-count">
                {articles.length} articles
              </span>
            </div>

            <div className="flex gap-2 flex-wrap">
              {Object.entries(CATEGORY_CONFIG).map(([cat, cfg]) => {
                const count = categoryCounts[cat] || 0;
                if (count === 0) return null;
                const Icon = cfg.icon;
                return (
                  <button
                    key={cat}
                    data-testid={`badge-category-${cat}`}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-all ${
                      selectedCategory === cat
                        ? "border-primary bg-primary/10 font-medium"
                        : "border-border/50 bg-card/50 hover:bg-card"
                    }`}
                    onClick={() => setSelectedCategory(selectedCategory === cat ? "all" : cat)}
                  >
                    <Icon className="w-3 h-3" style={{ color: cfg.color }} />
                    <span>{cat.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}</span>
                    <span className="text-muted-foreground">({count})</span>
                  </button>
                );
              })}
            </div>

            <div className="rounded-lg border bg-card overflow-hidden">
              <TimelineChart articles={articles} onSelectArticle={setSelectedArticle} />
            </div>

            <div className="grid gap-2" data-testid="news-article-list">
              {articles.slice(0, 50).map((article) => {
                const cfg = CATEGORY_CONFIG[article.category];
                const Icon = cfg?.icon || Newspaper;
                const isSelected = selectedArticle?.id === article.id;
                return (
                  <div
                    key={article.id}
                    data-testid={`article-card-${article.id}`}
                    className={`flex gap-3 p-3 rounded-lg border transition-all cursor-pointer hover:bg-accent/50 ${
                      isSelected ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border/50 bg-card"
                    }`}
                    onClick={() => setSelectedArticle(isSelected ? null : article)}
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center"
                        style={{ backgroundColor: cfg?.bgColor || "rgba(99, 102, 241, 0.15)" }}
                      >
                        <Icon className="w-4 h-4" style={{ color: cfg?.color || "#6366f1" }} />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-medium leading-tight line-clamp-2" data-testid={`text-article-title-${article.id}`}>
                          {article.title}
                        </h3>
                        <a
                          href={article.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="flex-shrink-0 text-muted-foreground hover:text-primary transition-colors"
                          data-testid={`link-article-${article.id}`}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-muted-foreground">{formatDateFull(article.publishedAt)}</span>
                        {article.source && (
                          <span className="text-[10px] text-muted-foreground">· {article.source}</span>
                        )}
                      </div>
                      {isSelected && article.description && (
                        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                          {article.description}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
