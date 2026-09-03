"use client";

import {
  AreaSeries,
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { ChartOverlaySeries, ChartPoint } from "../utils/chart-series";
import { CHART_COLORS } from "../utils/chart-theme";
import { formatLocalDate, formatMoney } from "../utils/format";
import styles from "./StockPriceChart.module.css";

/**
 * The shared oscillator pane. Every oscillator series draws into this one native Lightweight
 * Charts pane below the price pane, so all selected RSI periods share one fixed scale, one set of
 * reference lines, and the price chart's time scale and crosshair by construction. The library
 * creates the pane with the first series placed into it and removes it again with the last one.
 */
const OSCILLATOR_PANE_INDEX = 1;

/** Relative height of the oscillator pane; the price pane keeps its default factor of 1. */
const OSCILLATOR_PANE_STRETCH = 0.35;

/**
 * The 30/50/70 orientation levels, rendered once per pane on the canonically first oscillator
 * series: 30 marks oversold, 70 overbought, 50 the midline. Muted, dashed and without axis labels
 * so they orient the reading without competing with the data lines.
 */
const OSCILLATOR_REFERENCE_LEVELS = [
  { price: 30, title: "Oversold 30" },
  { price: 50, title: "50" },
  { price: 70, title: "Overbought 70" },
] as const;

/** An oscillator is unitless: legend and hover values never read as money. */
function formatOscillatorValue(value: number): string {
  return value.toFixed(1);
}

export type StockPriceChartProps = {
  /** Ascending daily closing prices for the selected range. */
  readonly points: readonly ChartPoint[];
  /** Overlay lines currently enabled; order controls legend order. */
  readonly overlays: readonly ChartOverlaySeries[];
  readonly currency: string;
  /** Dims the chart while a fuller history range is being loaded. */
  readonly loading?: boolean;
  /**
   * Identifies the viewport the chart should frame. The chart fits its content once per value,
   * so a new selected range reframes and everything else — new data for the same range, a new
   * overlay, any other rerender — leaves the window the user is looking at alone.
   */
  readonly fitKey: string;
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
  fitKey,
  ariaLabel,
}: StockPriceChartProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const overlaySeriesRef = useRef(new Map<string, ISeriesApi<"Line">>());
  // The one set of oscillator reference lines, attached to the canonically first oscillator
  // series. Tracking the owner is what keeps repeated toggling from duplicating the levels.
  const oscillatorReferenceRef = useRef<{
    owner: ISeriesApi<"Line">;
    lines: IPriceLine[];
  } | null>(null);
  // The crosshair handler is subscribed once; refs keep it reading current props.
  const crosshairContextRef = useRef<CrosshairContext>({ overlays, currency });
  crosshairContextRef.current = { overlays, currency };
  // The last `fitKey` this chart framed. Anything else that changes leaves the viewport alone.
  const fittedKeyRef = useRef<string | null>(null);

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
      // Standard Lightweight Charts navigation: drag the plot to pan through history, wheel or
      // pinch to zoom the time scale. `vertTouchDrag` stays off so a vertical swipe on a phone
      // keeps scrolling the page instead of being captured by the chart.
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: false },
        axisDoubleClickReset: { time: true, price: true },
      },
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
              // An oscillator is unitless; only price-scaled overlays read as money.
              overlay.placement === "OSCILLATOR_PANE"
                ? formatOscillatorValue(data.value)
                : formatMoney(data.value, currentCurrency),
              overlay.color,
            ),
          );
        }
      }
      legend.hidden = false;
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    // The visible window lives on the canvas, so the wrapper carries it as the DOM-visible
    // contract browser tests assert pan and zoom through — the same approach the oscillator
    // reference levels use. Written imperatively: a viewport change must never cost a render.
    const onVisibleLogicalRangeChange = (range: LogicalRange | null) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) {
        return;
      }
      if (!range) {
        delete wrapper.dataset.visibleRange;
        return;
      }
      wrapper.dataset.visibleRange = `${range.from.toFixed(2)}|${range.to.toFixed(2)}`;
    };
    chart
      .timeScale()
      .subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);

    chartRef.current = chart;
    priceSeriesRef.current = priceSeries;
    const overlaySeries = overlaySeriesRef.current;

    return () => {
      // chart.remove() disposes every series, pane, price line and subscription the instance
      // owns; the refs are cleared so a later effect run cannot touch disposed handles.
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart
        .timeScale()
        .unsubscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      overlaySeries.clear();
      oscillatorReferenceRef.current = null;
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
    // Framing happens once per selected range: on its first drawable frame, and again when the
    // fuller history behind a long range finishes arriving. After that the viewport belongs to
    // the user, and an ordinary data update or rerender must not snap it back.
    if (points.length > 0 && fittedKeyRef.current !== fitKey) {
      chart.timeScale().fitContent();
      if (!loading) {
        fittedKeyRef.current = fitKey;
      }
    }
  }, [points, fitKey, loading]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    const existing = overlaySeriesRef.current;
    const wanted = new Set(overlays.map((overlay) => overlay.id));
    for (const [id, series] of existing) {
      if (!wanted.has(id)) {
        // Removing the reference-line owner disposes its lines with it; forgetting that here
        // would try to detach lines from a dead series when the ownership moves on.
        if (oscillatorReferenceRef.current?.owner === series) {
          oscillatorReferenceRef.current = null;
        }
        chart.removeSeries(series);
        existing.delete(id);
      }
    }
    for (const overlay of overlays) {
      let series = existing.get(overlay.id);
      if (!series) {
        series =
          overlay.placement === "OSCILLATOR_PANE"
            ? chart.addSeries(
                LineSeries,
                {
                  color: overlay.color,
                  lineWidth: 2,
                  priceLineVisible: false,
                  lastValueVisible: false,
                  // The pane renders the catalog's fixed unit range instead of autoscaling, so
                  // every oscillator of the family shares one stable axis.
                  autoscaleInfoProvider: () => ({
                    priceRange: {
                      minValue: overlay.scale?.min ?? 0,
                      maxValue: overlay.scale?.max ?? 100,
                    },
                  }),
                  // Unitless axis labels; the chart-level formatter renders money.
                  priceFormat: {
                    type: "custom",
                    formatter: formatOscillatorValue,
                    minMove: 0.1,
                  },
                },
                OSCILLATOR_PANE_INDEX,
              )
            : chart.addSeries(LineSeries, {
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

    // One set of 30/50/70 reference levels per pane, owned by the canonically first oscillator
    // series. When that series changes or disappears the lines move or vanish with it — never
    // accumulating across repeated toggles.
    const firstOscillator = overlays.find(
      (overlay) => overlay.placement === "OSCILLATOR_PANE",
    );
    const owner = firstOscillator
      ? existing.get(firstOscillator.id)
      : undefined;
    const reference = oscillatorReferenceRef.current;
    if (reference && reference.owner !== owner) {
      for (const line of reference.lines) {
        reference.owner.removePriceLine(line);
      }
      oscillatorReferenceRef.current = null;
    }
    if (owner && !oscillatorReferenceRef.current) {
      oscillatorReferenceRef.current = {
        owner,
        lines: OSCILLATOR_REFERENCE_LEVELS.map((level) =>
          owner.createPriceLine({
            price: level.price,
            title: level.title,
            color: CHART_COLORS.oscillatorReference,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
          }),
        ),
      };
    }
    if (owner) {
      // Keep the price pane dominant: the oscillator pane takes roughly a quarter of the height.
      const oscillatorPane = chart.panes()[OSCILLATOR_PANE_INDEX];
      oscillatorPane?.setStretchFactor(OSCILLATOR_PANE_STRETCH);
    }
    // Deliberately no fitContent here: enabling or disabling an overlay is not a request to
    // reframe the history the user has scrolled to.
  }, [overlays]);

  const empty = points.length < 2;
  const hasOscillatorPane = overlays.some(
    (overlay) => overlay.placement === "OSCILLATOR_PANE",
  );

  return (
    <div
      ref={wrapperRef}
      className={styles.wrapper}
      data-loading={loading}
      data-oscillator-pane={hasOscillatorPane ? "true" : undefined}
      // The reference levels are drawn on canvas, so this is the DOM-visible contract the
      // browser tests assert them through.
      data-oscillator-levels={
        hasOscillatorPane
          ? OSCILLATOR_REFERENCE_LEVELS.map((level) => level.price).join(",")
          : undefined
      }
    >
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
