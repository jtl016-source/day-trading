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

const RTH_UP = "#26a69a";
const RTH_DOWN = "#ef5350";
const RTH_UP_WICK = "#26a69a";
const RTH_DOWN_WICK = "#ef5350";

const ETH_UP = "#26a69a80";
const ETH_DOWN = "#ef535080";
const ETH_UP_WICK = "#26a69a99";
const ETH_DOWN_WICK = "#ef535099";

export const CandlestickChart = forwardRef<ChartHandle, CandlestickChartProps>(
  function CandlestickChart({ candles, height = 420, showVolume = true, zoneOverlays, bandOverlays, dragZoomEnabled = false, onDragZoomDone }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const bandCanvasRef = useRef<HTMLCanvasElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const overlaySeriesRef = useRef<ISeriesApi<"Line">[]>([]);
    const prevCandleKeyRef = useRef<string>("");
    const bandOverlaysRef = useRef<BandOverlay[] | undefined>(bandOverlays);

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
            color: isDark ? "#131722" : "#ffffff",
          },
          textColor: isDark ? "#787b86" : "#131722",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
          fontSize: 12,
        },
        grid: {
          vertLines: { color: isDark ? "#1e222d" : "#e1ecf2" },
          horzLines: { color: isDark ? "#1e222d" : "#e1ecf2" },
        },
        crosshair: {
          mode: 0,
          vertLine: {
            color: isDark ? "#758696" : "#9598a1",
            width: 1,
            style: LineStyle.Dashed,
            labelBackgroundColor: isDark ? "#363c4e" : "#131722",
          },
          horzLine: {
            color: isDark ? "#758696" : "#9598a1",
            width: 1,
            style: LineStyle.Dashed,
            labelBackgroundColor: isDark ? "#363c4e" : "#131722",
          },
        },
        timeScale: {
          borderColor: isDark ? "#2a2e39" : "#e1ecf2",
          timeVisible: true,
          secondsVisible: false,
          fixLeftEdge: false,
          fixRightEdge: true,
          rightOffset: 5,
        },
        rightPriceScale: {
          borderColor: isDark ? "#2a2e39" : "#e1ecf2",
          scaleMargins: showVolume
            ? { top: 0.05, bottom: 0.22 }
            : { top: 0.05, bottom: 0.05 },
          textColor: isDark ? "#787b86" : "#131722",
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
          color: "#26a69a80",
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
        prevCandleKeyRef.current = "";
        return;
      }

      const chart = chartRef.current;
      const ts = chart.timeScale();
      const prevRange = ts.getVisibleLogicalRange();

      const sorted = [...candles].sort((a, b) => a.time - b.time);
      const candleKey = `${sorted[0].time}-${sorted[sorted.length - 1].time}-${sorted.length}`;
      const isNewDataset = prevCandleKeyRef.current === "" || prevCandleKeyRef.current !== candleKey;
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
          color = isUp ? "rgba(38,166,154,0.2)" : "rgba(239,83,80,0.2)";
        } else {
          color = isUp ? "rgba(38,166,154,0.5)" : "rgba(239,83,80,0.5)";
        }
        volData.push({ time: c.time as any, value: c.volume ?? 0, color });
      }

      candleSeriesRef.current.setData(candleData);
      if (volumeSeriesRef.current) {
        volumeSeriesRef.current.setData(volData as HistogramData[]);
      }

      if (isNewDataset) {
        ts.fitContent();
      } else if (prevRange) {
        ts.setVisibleLogicalRange(prevRange);
      }

      prevCandleKeyRef.current = candleKey;
    }, [candles]);

    useEffect(() => {
      bandOverlaysRef.current = bandOverlays;
    }, [bandOverlays]);

    const drawBands = useCallback(() => {
      const canvas = bandCanvasRef.current;
      const chart = chartRef.current;
      const series = candleSeriesRef.current;
      const overlays = bandOverlaysRef.current;
      if (!canvas || !chart || !series || !overlays || overlays.length === 0) {
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

      for (const band of overlays) {
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
    }, []);

    useEffect(() => {
      const chart = chartRef.current;
      if (!chart) return;

      drawBands();

      chart.timeScale().subscribeVisibleLogicalRangeChange(drawBands);

      return () => {
        try {
          chart.timeScale().unsubscribeVisibleLogicalRangeChange(drawBands);
        } catch {}
      };
    }, [drawBands]);

    useEffect(() => {
      drawBands();
    }, [bandOverlays, drawBands]);

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
