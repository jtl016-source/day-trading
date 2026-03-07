import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type WhitespaceData,
  type LineData,
  LineStyle,
  ColorType,
} from "lightweight-charts";

export interface CandleBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  rth?: boolean;
}

export interface ZoneOverlay {
  data: Array<{ time: number; value: number }>;
  color: string;
  lineWidth: number;
  lineStyle?: number;
  title?: string;
}

export interface BandOverlay {
  topPrice: number;
  bottomPrice: number;
  fillColor: string;
  fromTime: number;
  toTime: number;
}

export interface ChartHandle {
  scrollToTime: (timestamp: number) => void;
  resetZoom: () => void;
}

interface CandlestickChartProps {
  candles: CandleBar[];
  height?: number;
  showVolume?: boolean;
  zoneOverlays?: ZoneOverlay[];
  bandOverlays?: BandOverlay[];
  dragZoomEnabled?: boolean;
  onDragZoomDone?: () => void;
}

const RTH_UP = "#22c55e";
const RTH_DOWN = "#ef4444";
const RTH_UP_WICK = "#22c55e";
const RTH_DOWN_WICK = "#ef4444";

const ETH_UP = "#86efac";
const ETH_DOWN = "#fca5a5";
const ETH_UP_WICK = "#4ade80";
const ETH_DOWN_WICK = "#f87171";

export const CandlestickChart = forwardRef<ChartHandle, CandlestickChartProps>(
  function CandlestickChart({ candles, height = 420, showVolume = true, zoneOverlays, bandOverlays, dragZoomEnabled = false, onDragZoomDone }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const bandCanvasRef = useRef<HTMLCanvasElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const overlaySeriesRef = useRef<ISeriesApi<"Line">[]>([]);

    const [dragState, setDragState] = useState<{
      active: boolean;
      startX: number;
      startY: number;
      curX: number;
      curY: number;
    } | null>(null);

    useImperativeHandle(ref, () => ({
      scrollToTime(timestamp: number) {
        if (!chartRef.current) return;
        const range = 12 * 3600;
        chartRef.current.timeScale().setVisibleRange({
          from: (timestamp - range) as any,
          to: (timestamp + range) as any,
        });
      },
      resetZoom() {
        if (!chartRef.current) return;
        chartRef.current.timeScale().fitContent();
      },
    }));

    const handleDragStart = useCallback((e: React.MouseEvent) => {
      if (!dragZoomEnabled) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setDragState({ active: true, startX: x, startY: y, curX: x, curY: y });
    }, [dragZoomEnabled]);

    const handleDragMove = useCallback((e: React.MouseEvent) => {
      if (!dragState?.active) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setDragState((prev) => prev ? { ...prev, curX: x, curY: y } : null);
    }, [dragState?.active]);

    const handleDragEnd = useCallback(() => {
      if (!dragState?.active || !chartRef.current) {
        setDragState(null);
        return;
      }

      const chart = chartRef.current;
      const ts = chart.timeScale();

      const leftX = Math.min(dragState.startX, dragState.curX);
      const rightX = Math.max(dragState.startX, dragState.curX);
      const width = rightX - leftX;

      if (width > 10) {
        const fromTime = ts.coordinateToTime(leftX);
        const toTime = ts.coordinateToTime(rightX);

        if (fromTime != null && toTime != null) {
          ts.setVisibleRange({
            from: fromTime,
            to: toTime,
          });
        }
      }

      setDragState(null);
      onDragZoomDone?.();
    }, [dragState, onDragZoomDone]);

    useEffect(() => {
      if (!dragZoomEnabled) return;
      const onGlobalMouseUp = () => {
        if (dragState?.active) handleDragEnd();
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setDragState(null);
          onDragZoomDone?.();
        }
      };
      window.addEventListener("mouseup", onGlobalMouseUp);
      window.addEventListener("keydown", onKeyDown);
      return () => {
        window.removeEventListener("mouseup", onGlobalMouseUp);
        window.removeEventListener("keydown", onKeyDown);
      };
    }, [dragZoomEnabled, dragState?.active, handleDragEnd, onDragZoomDone]);

    useEffect(() => {
      if (!containerRef.current) return;

      const isDark = document.documentElement.classList.contains("dark");

      const chart = createChart(containerRef.current, {
        width: containerRef.current.offsetWidth,
        height,
        layout: {
          background: {
            type: ColorType.Solid,
            color: isDark ? "hsl(220, 10%, 4%)" : "hsl(210, 5%, 98%)",
          },
          textColor: isDark ? "rgba(180,190,200,0.7)" : "rgba(30,40,50,0.55)",
          fontFamily: "var(--font-sans, sans-serif)",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)" },
          horzLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)" },
        },
        crosshair: {
          vertLine: {
            color: isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.2)",
            width: 1,
            style: 3,
          },
          horzLine: {
            color: isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.2)",
            width: 1,
            style: 3,
          },
        },
        timeScale: {
          borderColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
          timeVisible: true,
          secondsVisible: false,
          fixLeftEdge: false,
          fixRightEdge: true,
          rightOffset: 3,
        },
        rightPriceScale: {
          borderColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
          scaleMargins: showVolume
            ? { top: 0.05, bottom: 0.22 }
            : { top: 0.05, bottom: 0.05 },
        },
        handleScale: {
          axisPressedMouseMove: { time: true, price: true },
          mouseWheel: true,
          pinch: true,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
        },
      });

      chartRef.current = chart;

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: RTH_UP,
        downColor: RTH_DOWN,
        borderVisible: false,
        wickUpColor: RTH_UP_WICK,
        wickDownColor: RTH_DOWN_WICK,
      });
      candleSeriesRef.current = candleSeries;

      if (showVolume) {
        const volumeSeries = chart.addSeries(HistogramSeries, {
          color: "#6366f1",
          priceFormat: { type: "volume" },
          priceScaleId: "volume",
        });
        chart.priceScale("volume").applyOptions({
          scaleMargins: { top: 0.82, bottom: 0 },
        });
        volumeSeriesRef.current = volumeSeries;
      }

      const ro = new ResizeObserver(() => {
        if (containerRef.current) {
          chart.applyOptions({ width: containerRef.current.offsetWidth });
        }
      });
      ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
        chart.remove();
        chartRef.current = null;
        candleSeriesRef.current = null;
        volumeSeriesRef.current = null;
        overlaySeriesRef.current = [];
      };
    }, [height, showVolume]);

    useEffect(() => {
      if (!chartRef.current) return;
      chartRef.current.applyOptions({
        handleScroll: {
          mouseWheel: !dragZoomEnabled,
          pressedMouseMove: !dragZoomEnabled,
          horzTouchDrag: !dragZoomEnabled,
        },
        handleScale: {
          axisPressedMouseMove: !dragZoomEnabled ? { time: true, price: true } : { time: false, price: false },
          mouseWheel: !dragZoomEnabled,
          pinch: !dragZoomEnabled,
        },
      });
    }, [dragZoomEnabled]);

    useEffect(() => {
      if (!candleSeriesRef.current || !chartRef.current) return;
      if (candles.length === 0) {
        candleSeriesRef.current.setData([]);
        volumeSeriesRef.current?.setData([]);
        return;
      }

      const sorted = [...candles].sort((a, b) => a.time - b.time);
      const hasETHData = sorted.some((c) => c.rth === true || c.rth === false);

      function getUTCDate(ts: number): string {
        const d = new Date(ts * 1000);
        return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      }

      function mapCandle(c: CandleBar): CandlestickData {
        const isUp = c.close >= c.open;
        if (hasETHData && c.rth === false) {
          return {
            time: c.time as any,
            open: c.open, high: c.high, low: c.low, close: c.close,
            color: isUp ? ETH_UP : ETH_DOWN,
            wickColor: isUp ? ETH_UP_WICK : ETH_DOWN_WICK,
          };
        }
        return { time: c.time as any, open: c.open, high: c.high, low: c.low, close: c.close };
      }

      const candleData: (CandlestickData | WhitespaceData)[] = [];
      const volData: (HistogramData | WhitespaceData)[] = [];
      const GAP_COUNT = 3;

      for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];

        if (i > 0) {
          const prevDate = getUTCDate(sorted[i - 1].time);
          const curDate = getUTCDate(c.time);
          if (prevDate !== curDate) {
            const prevTime = sorted[i - 1].time;
            const nextTime = c.time;
            const step = Math.floor((nextTime - prevTime) / (GAP_COUNT + 1));
            for (let g = 1; g <= GAP_COUNT; g++) {
              const gapTime = (prevTime + step * g) as any;
              candleData.push({ time: gapTime });
              volData.push({ time: gapTime });
            }
          }
        }

        candleData.push(mapCandle(c));

        const isUp = c.close >= c.open;
        const isETH = hasETHData && c.rth === false;
        let color: string;
        if (isETH) {
          color = isUp ? "rgba(134,239,172,0.3)" : "rgba(252,165,165,0.3)";
        } else {
          color = isUp ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)";
        }
        volData.push({ time: c.time as any, value: c.volume ?? 0, color });
      }

      candleSeriesRef.current.setData(candleData);
      if (volumeSeriesRef.current) {
        volumeSeriesRef.current.setData(volData as HistogramData[]);
      }

      chartRef.current.timeScale().fitContent();
    }, [candles]);

    const drawBands = useCallback(() => {
      const canvas = bandCanvasRef.current;
      const chart = chartRef.current;
      const series = candleSeriesRef.current;
      if (!canvas || !chart || !series || !bandOverlays || bandOverlays.length === 0) {
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const ts = chart.timeScale();

      for (const band of bandOverlays) {
        const topY = series.priceToCoordinate(band.topPrice);
        const bottomY = series.priceToCoordinate(band.bottomPrice);
        if (topY == null || bottomY == null) continue;

        const leftX = ts.timeToCoordinate(band.fromTime as any);
        const rightX = ts.timeToCoordinate(band.toTime as any);
        if (leftX == null || rightX == null) continue;

        const x = Math.min(leftX, rightX);
        const w = Math.abs(rightX - leftX);
        const y = Math.min(topY, bottomY);
        const h = Math.abs(bottomY - topY);

        if (w > 0 && h > 0) {
          ctx.fillStyle = band.fillColor;
          ctx.fillRect(x, y, w, h);
        }
      }
    }, [bandOverlays]);

    useEffect(() => {
      const chart = chartRef.current;
      if (!chart) return;

      drawBands();

      chart.timeScale().subscribeVisibleLogicalRangeChange(drawBands);
      chart.subscribeCrosshairMove(drawBands);

      return () => {
        try {
          chart.timeScale().unsubscribeVisibleLogicalRangeChange(drawBands);
          chart.unsubscribeCrosshairMove(drawBands);
        } catch {}
      };
    }, [drawBands]);

    useEffect(() => {
      const chart = chartRef.current;
      if (!chart) return;

      for (const s of overlaySeriesRef.current) {
        try { chart.removeSeries(s); } catch {}
      }
      overlaySeriesRef.current = [];

      if (!zoneOverlays || zoneOverlays.length === 0) return;

      for (const overlay of zoneOverlays) {
        if (overlay.data.length === 0) continue;
        const series = chart.addSeries(LineSeries, {
          color: overlay.color,
          lineWidth: overlay.lineWidth as any,
          lineStyle: (overlay.lineStyle ?? LineStyle.Solid) as any,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
          title: overlay.title ?? "",
        });

        const lineData: LineData[] = overlay.data
          .sort((a, b) => a.time - b.time)
          .map((d) => ({ time: d.time as any, value: d.value }));

        series.setData(lineData);
        overlaySeriesRef.current.push(series);
      }
    }, [zoneOverlays]);

    const selRect = dragState?.active ? {
      left: Math.min(dragState.startX, dragState.curX),
      top: Math.min(dragState.startY, dragState.curY),
      width: Math.abs(dragState.curX - dragState.startX),
      height: Math.abs(dragState.curY - dragState.startY),
    } : null;

    return (
      <div
        style={{ width: "100%", height, position: "relative" }}
        data-testid="candlestick-chart"
      >
        <div ref={containerRef} style={{ width: "100%", height }} />
        <canvas
          ref={bandCanvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
        {dragZoomEnabled && (
          <div
            data-testid="drag-zoom-overlay"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              cursor: "crosshair",
              zIndex: 5,
            }}
            onMouseDown={handleDragStart}
            onMouseMove={handleDragMove}
            onMouseUp={handleDragEnd}
            onMouseLeave={() => { if (dragState?.active) handleDragEnd(); }}
          >
            {selRect && selRect.width > 2 && (
              <div
                data-testid="drag-zoom-selection"
                style={{
                  position: "absolute",
                  left: selRect.left,
                  top: selRect.top,
                  width: selRect.width,
                  height: selRect.height,
                  border: "2px solid rgba(99, 102, 241, 0.8)",
                  backgroundColor: "rgba(99, 102, 241, 0.1)",
                  borderRadius: 2,
                  pointerEvents: "none",
                }}
              />
            )}
          </div>
        )}
      </div>
    );
  }
);
