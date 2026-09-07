"use client";

import type { BacktestCurvePointResponse } from "@intrinsic/contracts";
import {
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { BACKTEST_CHART_COLORS } from "../utils/chart-theme";
import { formatDay, formatSignedPercent } from "../utils/format";
import styles from "./BacktestComparisonChart.module.css";

export type BacktestComparisonChartProps = {
  /** Ascending curve points. Grows with every checkpoint while the run executes. */
  readonly points: readonly BacktestCurvePointResponse[];
  /** The benchmark's own product name, read from the run's snapshot — never hard-coded. */
  readonly benchmarkName: string;
  readonly ariaLabel: string;
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
 * Portfolio against benchmark, both as percentage growth from the run's first simulated date.
 *
 * One shared scale is the whole point: normalizing both series to the same starting point is what
 * makes "did this strategy beat the benchmark?" a question the eye can answer. A null benchmark
 * value is a genuine gap — a date the benchmark has no value at or before — and is drawn as a
 * break in the line rather than as zero, which would read as a flat benchmark that never moved.
 *
 * The chart instance is created once and mutated through `setData`, so a checkpoint extends the
 * curve without remounting anything and without a layout jump.
 */
export function BacktestComparisonChart({
  points,
  benchmarkName,
  ariaLabel,
}: BacktestComparisonChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const portfolioRef = useRef<ISeriesApi<"Line"> | null>(null);
  const benchmarkRef = useRef<ISeriesApi<"Line"> | null>(null);
  // How many points are currently drawn, so a checkpoint that extends the curve can be told from
  // a rerender that changed nothing.
  const drawnCountRef = useRef(0);
  // The crosshair handler is subscribed once; a ref keeps it reading the current benchmark name.
  const benchmarkNameRef = useRef(benchmarkName);
  benchmarkNameRef.current = benchmarkName;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: BACKTEST_CHART_COLORS.text,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        horzLines: { color: BACKTEST_CHART_COLORS.grid },
        vertLines: { visible: false },
      },
      rightPriceScale: { borderColor: BACKTEST_CHART_COLORS.axisBorder },
      timeScale: {
        borderColor: BACKTEST_CHART_COLORS.axisBorder,
        timeVisible: false,
        // The default 0.5px minimum bar spacing caps the visible window at roughly two thousand
        // daily bars, which would silently truncate a thirty-year run.
        minBarSpacing: 0.01,
      },
      crosshair: {
        horzLine: {
          color: BACKTEST_CHART_COLORS.crosshair,
          labelBackgroundColor: BACKTEST_CHART_COLORS.text,
        },
        vertLine: {
          color: BACKTEST_CHART_COLORS.crosshair,
          labelBackgroundColor: BACKTEST_CHART_COLORS.text,
        },
      },
      localization: { priceFormatter: formatSignedPercent },
      // A vertical swipe on a phone keeps scrolling the page instead of being captured here.
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

    const portfolio = chart.addSeries(LineSeries, {
      color: BACKTEST_CHART_COLORS.portfolio,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const benchmark = chart.addSeries(LineSeries, {
      color: BACKTEST_CHART_COLORS.benchmark,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    // Break-even. Both series start at zero by construction, so this is the line that says whether
    // either of them is up or down on the run.
    portfolio.createPriceLine({
      price: 0,
      color: BACKTEST_CHART_COLORS.baseline,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: "",
    });

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      const legend = legendRef.current;
      if (!legend) {
        return;
      }
      const portfolioPoint = param.seriesData.get(portfolio) as
        { value?: number } | undefined;
      if (param.time === undefined || portfolioPoint?.value === undefined) {
        legend.hidden = true;
        return;
      }
      const benchmarkPoint = param.seriesData.get(benchmark) as
        { value?: number } | undefined;
      legend.replaceChildren(legendRow(formatDay(String(param.time)), ""));
      legend.append(
        legendRow(
          "Portfolio",
          formatSignedPercent(portfolioPoint.value),
          BACKTEST_CHART_COLORS.portfolio,
        ),
      );
      legend.append(
        legendRow(
          benchmarkNameRef.current,
          // A gap is reported as a gap: the benchmark simply has no value on this date.
          benchmarkPoint?.value === undefined
            ? "—"
            : formatSignedPercent(benchmarkPoint.value),
          BACKTEST_CHART_COLORS.benchmark,
        ),
      );
      legend.hidden = false;
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    chartRef.current = chart;
    portfolioRef.current = portfolio;
    benchmarkRef.current = benchmark;

    return () => {
      // chart.remove() disposes every series, price line and subscription the instance owns; the
      // refs are cleared so a later effect run cannot touch disposed handles.
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
      portfolioRef.current = null;
      benchmarkRef.current = null;
      drawnCountRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const portfolio = portfolioRef.current;
    const benchmark = benchmarkRef.current;
    if (!chart || !portfolio || !benchmark) {
      return;
    }

    portfolio.setData(
      points.map((point) => ({
        time: point.date as Time,
        value: point.portfolioReturnPercent,
      })),
    );
    // Whitespace, not zero: a missing benchmark value breaks the line and leaves the time scale
    // aligned with the portfolio series it is being compared against.
    benchmark.setData(
      points.map((point) =>
        point.benchmarkReturnPercent === null
          ? { time: point.date as Time }
          : { time: point.date as Time, value: point.benchmarkReturnPercent },
      ),
    );

    // A backtest curve is a whole-run view that grows with each checkpoint, not navigable history:
    // keeping the entire run framed is what "watch it progress" means. Framing only when the curve
    // actually grew leaves an unrelated rerender alone, and polling stops at completion, so a
    // finished chart is never refit under a user exploring it.
    if (points.length > drawnCountRef.current) {
      chart.timeScale().fitContent();
    }
    drawnCountRef.current = points.length;
  }, [points]);

  const benchmarkPoints = points.reduce(
    (total, point) =>
      point.benchmarkReturnPercent === null ? total : total + 1,
    0,
  );

  return (
    <div
      className={styles.frame}
      data-testid="backtest-chart"
      // The curve lives on a canvas, so the wrapper carries it as the DOM-visible contract browser
      // tests assert growth and series presence through.
      data-series-count={benchmarkPoints > 0 ? 2 : 1}
      data-portfolio-points={points.length}
      data-benchmark-points={benchmarkPoints}
      data-curve-through={points.at(-1)?.date}
    >
      <div className={styles.wrapper}>
        <div
          ref={containerRef}
          className={styles.canvas}
          role="img"
          aria-label={ariaLabel}
        />
        <div
          ref={legendRef}
          data-testid="backtest-chart-legend"
          className={styles.legend}
          hidden
          aria-hidden="true"
        />
      </div>
      <div className={styles.series} data-testid="backtest-chart-series">
        <span className={styles.seriesItem}>
          <span
            className={styles.legendDot}
            style={{ backgroundColor: BACKTEST_CHART_COLORS.portfolio }}
            aria-hidden="true"
          />
          Portfolio
        </span>
        <span className={styles.seriesItem}>
          <span
            className={styles.legendDot}
            style={{ backgroundColor: BACKTEST_CHART_COLORS.benchmark }}
            aria-hidden="true"
          />
          {benchmarkName}
        </span>
      </div>
    </div>
  );
}
