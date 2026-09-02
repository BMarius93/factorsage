"use client";

import {
  AreaSeries,
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { ChartOverlaySeries, ChartPoint } from "../utils/chart-series";
import { CHART_COLORS } from "../utils/chart-theme";
import { formatLocalDate, formatMoney } from "../utils/format";
import styles from "./StockPriceChart.module.css";

export type StockPriceChartProps = {
  /** Ascending daily closing prices for the selected range. */
  readonly points: readonly ChartPoint[];
  /** Overlay lines currently enabled; order controls legend order. */
  readonly overlays: readonly ChartOverlaySeries[];
  readonly currency: string;
  /** Dims the chart while a fuller history range is being loaded. */
  readonly loading?: boolean;
  readonly ariaLabel: string;
};

type CrosshairContext = {
  overlays: readonly ChartOverlaySeries[];
  currency: string;
};

function legendRow(label: string, value: string, color?: string): HTMLElement {
  const row = document.createElement("span");
  row.className = styles.legendItem as string;
  if (color) {
    const dot = document.createElement("span");
    dot.className = styles.legendDot as string;
    dot.style.backgroundColor = color;
    row.append(dot);
  }
  const name = document.createElement("span");
  name.textContent = label;
  const amount = document.createElement("strong");
  amount.textContent = value;
  row.append(name, amount);
  return row;
}

/**
 * Lightweight Charts integration for the Stock Details price history.
 *
 * The legend names the always-visible close plus every enabled overlay, using the label the
 * overlay carries — which is the canonical selectable-series label the `Indicators` picker shows,
 * so the two can never disagree.
 *
 * The chart instance is created once and mutated through series `setData` calls; hover updates go
 * straight to a legend DOM node via the crosshair subscription so pointer movement never causes a
 * React render. Zoom/scroll gestures are disabled: the visible window is owned by the range
 * selector, and vertical touch gestures keep scrolling the page on mobile.
 */
export function StockPriceChart({
  points,
  overlays,
  currency,
  loading = false,
  ariaLabel,
}: StockPriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const overlaySeriesRef = useRef(new Map<string, ISeriesApi<"Line">>());
  // The crosshair handler is subscribed once; refs keep it reading current props.
  const crosshairContextRef = useRef<CrosshairContext>({ overlays, currency });
  crosshairContextRef.current = { overlays, currency };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: CHART_COLORS.text,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        horzLines: { color: CHART_COLORS.grid },
        vertLines: { visible: false },
      },
      rightPriceScale: { borderColor: CHART_COLORS.axisBorder },
      timeScale: {
        borderColor: CHART_COLORS.axisBorder,
        timeVisible: false,
        // The default 0.5px minimum bar spacing caps the visible window at roughly two thousand
        // daily bars, which silently truncates fitContent() on decades of history (MAX range).
        minBarSpacing: 0.01,
      },
      crosshair: {
        horzLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.text },
        vertLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.text },
      },
      handleScroll: false,
      handleScale: false,
    });
    const priceSeries = chart.addSeries(AreaSeries, {
      lineColor: CHART_COLORS.price,
      topColor: CHART_COLORS.priceAreaTop,
      bottomColor: CHART_COLORS.priceAreaBottom,
      lineWidth: 2,
      priceLineVisible: false,
    });

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      const legend = legendRef.current;
      if (!legend) {
        return;
      }
      const priceData = param.seriesData.get(priceSeries) as
        | { value?: number }
        | undefined;
      if (param.time === undefined || priceData?.value === undefined) {
        legend.hidden = true;
        return;
      }
      const { overlays: currentOverlays, currency: currentCurrency } =
        crosshairContextRef.current;
      legend.replaceChildren(legendRow(formatLocalDate(String(param.time)), ""));
      legend.append(
        legendRow(
          "Close",
          formatMoney(priceData.value, currentCurrency),
          CHART_COLORS.price,
        ),
      );
      for (const overlay of currentOverlays) {
        const series = overlaySeriesRef.current.get(overlay.id);
        const data = series
          ? (param.seriesData.get(series) as { value?: number } | undefined)
          : undefined;
        if (data?.value !== undefined) {
          legend.append(
            legendRow(
              overlay.label,
              formatMoney(data.value, currentCurrency),
              overlay.color,
            ),
          );
        }
      }
      legend.hidden = false;
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    chartRef.current = chart;
    priceSeriesRef.current = priceSeries;
    const overlaySeries = overlaySeriesRef.current;

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      overlaySeries.clear();
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      localization: {
        priceFormatter: (value: number) => formatMoney(value, currency),
      },
    });
  }, [currency]);

  useEffect(() => {
    const chart = chartRef.current;
    const priceSeries = priceSeriesRef.current;
    if (!chart || !priceSeries) {
      return;
    }
    priceSeries.setData(
      points.map((point) => ({ time: point.date as Time, value: point.value })),
    );
    chart.timeScale().fitContent();
  }, [points]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    const existing = overlaySeriesRef.current;
    const wanted = new Set(overlays.map((overlay) => overlay.id));
    for (const [id, series] of existing) {
      if (!wanted.has(id)) {
        chart.removeSeries(series);
        existing.delete(id);
      }
    }
    for (const overlay of overlays) {
      let series = existing.get(overlay.id);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: overlay.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        existing.set(overlay.id, series);
      } else {
        // Overlay colour is assigned by position within the enabled set, so a reused series can
        // legitimately change colour when another overlay is added or removed.
        series.applyOptions({ color: overlay.color });
      }
      series.setData(
        overlay.points.map((point) => ({
          time: point.date as Time,
          value: point.value,
        })),
      );
    }
    chart.timeScale().fitContent();
  }, [overlays]);

  const empty = points.length < 2;

  return (
    <div className={styles.wrapper} data-loading={loading}>
      <div
        ref={containerRef}
        className={styles.canvas}
        role="img"
        aria-label={ariaLabel}
      />
      <div
        ref={legendRef}
        data-testid="chart-legend"
        className={styles.legend}
        hidden
        aria-hidden="true"
      />
      {empty ? (
        <p className={styles.emptyMessage} role="status">
          Not enough price history to draw a chart.
        </p>
      ) : null}
      {loading ? (
        <div className={styles.loadingOverlay} role="status" aria-label="Loading price history">
          <span className={styles.spinner} aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}
