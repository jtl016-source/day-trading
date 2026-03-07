import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  ColorType,
} from "lightweight-charts";

export interface CandleBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface CandlestickChartProps {
  candles: CandleBar[];
  height?: number;
  showVolume?: boolean;
}

export function CandlestickChart({
  candles,
  height = 420,
  showVolume = true,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const isDark = document.documentElement.classList.contains("dark");

    const chart = createChart(containerRef.current, {
      width: containerRef.current.offsetWidth,
      height: showVolume ? height : height,
      layout: {
        background: {
          type: ColorType.Solid,
          color: isDark ? "hsl(210 6% 8%)" : "hsl(210 5% 98%)",
        },
        textColor: isDark ? "hsl(210 5% 70%)" : "hsl(210 6% 40%)",
        fontFamily: "var(--font-sans, sans-serif)",
        fontSize: 11,
      },
      grid: {
        vertLines: {
          color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
        },
        horzLines: {
          color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
        },
      },
      crosshair: {
        vertLine: {
          color: isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)",
          width: 1,
          style: 3,
        },
        horzLine: {
          color: isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)",
          width: 1,
          style: 3,
        },
      },
      timeScale: {
        borderColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      rightPriceScale: {
        borderColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
        scaleMargins: showVolume
          ? { top: 0.05, bottom: 0.25 }
          : { top: 0.05, bottom: 0.05 },
      },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
      },
    });

    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    candleSeriesRef.current = candleSeries;

    if (showVolume) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        color: "#6366f1",
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
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
    };
  }, [height, showVolume]);

  useEffect(() => {
    if (!candleSeriesRef.current || !chartRef.current) return;
    if (candles.length === 0) {
      candleSeriesRef.current.setData([]);
      volumeSeriesRef.current?.setData([]);
      return;
    }

    const sorted = [...candles].sort((a, b) => a.time - b.time);

    const candleData: CandlestickData[] = sorted.map((c) => ({
      time: c.time as any,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    candleSeriesRef.current.setData(candleData);

    if (volumeSeriesRef.current && sorted[0]?.volume != null) {
      const volData: HistogramData[] = sorted.map((c) => ({
        time: c.time as any,
        value: c.volume ?? 0,
        color: c.close >= c.open ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)",
      }));
      volumeSeriesRef.current.setData(volData);
    }

    chartRef.current.timeScale().fitContent();
  }, [candles]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height }}
      data-testid="candlestick-chart"
    />
  );
}
