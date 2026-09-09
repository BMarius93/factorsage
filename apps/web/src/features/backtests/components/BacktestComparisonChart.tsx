"use client";

import type { BacktestCurvePointResponse } from "@intrinsic/contracts";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { BACKTEST_CHART_COLORS } from "../utils/chart-theme";
import { formatCompactMoney, formatDay, formatMoney } from "../utils/format";
import styles from "./BacktestComparisonChart.module.css";

/** The `Cash` scenario's product label. It is never the Strategy's uninvested cash balance. */
export const CASH_SCENARIO_LABEL = "Cash";
export const STRATEGY_SCENARIO_LABEL = "Strategy";

export type BacktestComparisonChartProps = {
  /** Ascending curve points. Grows with every checkpoint while the run executes. */
  readonly points: readonly BacktestCurvePointResponse[];
  /** The benchmark's own product name, read from the run's snapshot — never hard-coded. */
  readonly benchmarkName: string;
  readonly ariaLabel: string;
  /**
   * The configured period. It fixes the horizontal axis for the whole run, so the not-yet-simulated
   * part stays empty instead of the chart reframing itself around whatever has been computed.
   */
  readonly periodStart: string;
  readonly periodEnd: string;
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
 * Three funded scenarios on one absolute currency axis: Strategy, the benchmark, and Cash.
 *
 * All three receive **the same external cash flows on the same dates** — the same initial capital
 * and the same monthly contributions — so the vertical distance between them is a difference in
 * what the money did, never in how much of it there was. That is what makes "was this strategy
 * worth it?" a question the eye can answer: the Cash line is the money doing nothing, the benchmark
 * line is the money bought passively, and the Strategy line is the money traded by the rules.
 *
 * It is deliberately not normalized to percentage growth. A return index answers "how fast did each
 * grow", which the KPI tiles below already report; this chart answers "what would I actually have",
 * which is the comparison the product is about.
 *
 * A null value is a genuine gap and is drawn as a break rather than as zero. Two things produce
 * one: a date the benchmark has no close at or before, and a run completed before the funded
 * benchmark scenario existed — such a run keeps its Strategy and Cash lines and simply has no
 * benchmark line, because that value is not derivable from what it stored.
 *
 * The chart instance is created once and mutated through `setData`, so a completed calendar year
 * extends the curve without remounting anything and without a layout jump.
 *
 * The horizontal axis is the **configured period**, fixed for the whole run. A running backtest
 * that reframed itself to whatever it had computed so far would rescale every time a year landed,
 * and the curve would appear to stand still while the axis raced ahead of it. Anchoring the scale
 * to `periodStart`..`periodEnd` instead means the not-yet-simulated part of the run is simply empty
 * and the lines fill in from the left. The anchors are whitespace points — a time with no value —
 * so nothing is added to any scenario.
 */
export function BacktestComparisonChart({
  points,
  benchmarkName,
  ariaLabel,
  periodStart,
  periodEnd,
}: BacktestComparisonChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const strategyRef = useRef<ISeriesApi<"Line"> | null>(null);
  const benchmarkRef = useRef<ISeriesApi<"Line"> | null>(null);
  const cashRef = useRef<ISeriesApi<"Line"> | null>(null);
  // Whitespace-only series whose two points pin the time scale to the configured period.
  const anchorRef = useRef<ISeriesApi<"Line"> | null>(null);
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
      // The axis is currency, and a thirty-year run's axis has to fit six-figure values without
      // wrapping, so the axis is compact while the hover readout carries the exact amount.
      localization: { priceFormatter: formatCompactMoney },
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

    const strategy = chart.addSeries(LineSeries, {
      color: BACKTEST_CHART_COLORS.strategy,
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
    const cash = chart.addSeries(LineSeries, {
      color: BACKTEST_CHART_COLORS.cash,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const anchor = chart.addSeries(LineSeries, {
      color: "rgba(0,0,0,0)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      const legend = legendRef.current;
      if (!legend) {
        return;
      }
      const valueOn = (series: ISeriesApi<"Line">): number | undefined =>
        (param.seriesData.get(series) as { value?: number } | undefined)?.value;
      const strategyValue = valueOn(strategy);
      if (param.time === undefined || strategyValue === undefined) {
        legend.hidden = true;
        return;
      }
      const benchmarkValue = valueOn(benchmark);
      const cashValue = valueOn(cash);
      legend.replaceChildren(legendRow(formatDay(String(param.time)), ""));
      legend.append(
        legendRow(
          STRATEGY_SCENARIO_LABEL,
          formatMoney(strategyValue),
          BACKTEST_CHART_COLORS.strategy,
        ),
      );
      legend.append(
        legendRow(
          benchmarkNameRef.current,
          // A gap is reported as a gap: the scenario simply has no value on this date.
          benchmarkValue === undefined ? "—" : formatMoney(benchmarkValue),
          BACKTEST_CHART_COLORS.benchmark,
        ),
      );
      legend.append(
        legendRow(
          CASH_SCENARIO_LABEL,
          cashValue === undefined ? "—" : formatMoney(cashValue),
          BACKTEST_CHART_COLORS.cash,
        ),
      );
      legend.hidden = false;
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    chartRef.current = chart;
    strategyRef.current = strategy;
    benchmarkRef.current = benchmark;
    cashRef.current = cash;
    anchorRef.current = anchor;

    return () => {
      // chart.remove() disposes every series, price line and subscription the instance owns; the
      // refs are cleared so a later effect run cannot touch disposed handles.
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
      strategyRef.current = null;
      benchmarkRef.current = null;
      cashRef.current = null;
      anchorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const strategy = strategyRef.current;
    const benchmark = benchmarkRef.current;
    const cash = cashRef.current;
    if (!chart || !strategy || !benchmark || !cash) {
      return;
    }

    strategy.setData(
      points.map((point) => ({
        time: point.date as Time,
        value: point.strategyValue,
      })),
    );
    // Whitespace, not zero: a missing benchmark value breaks the line and leaves the time scale
    // aligned with the scenarios it is being compared against.
    benchmark.setData(
      points.map((point) =>
        point.benchmarkValue === null
          ? { time: point.date as Time }
          : { time: point.date as Time, value: point.benchmarkValue },
      ),
    );
    cash.setData(
      points.map((point) => ({
        time: point.date as Time,
        value: point.cashBaselineValue,
      })),
    );
  }, [points]);

  // The configured period owns the axis. The anchor series carries only whitespace — the two
  // endpoints of the run, and nothing else — so the time scale spans the whole period from the
  // first render, before a single day has been simulated, and stops moving as years complete.
  useEffect(() => {
    const chart = chartRef.current;
    const anchor = anchorRef.current;
    if (!chart || !anchor || !periodStart || !periodEnd) {
      return;
    }
    anchor.setData([
      { time: periodStart as Time },
      { time: periodEnd as Time },
    ]);
    chart
      .timeScale()
      .setVisibleRange({ from: periodStart as Time, to: periodEnd as Time });
  }, [periodStart, periodEnd]);

  const benchmarkPoints = points.reduce(
    (total, point) => (point.benchmarkValue === null ? total : total + 1),
    0,
  );

  return (
    <div
      className={styles.frame}
      data-testid="backtest-chart"
      // The curves live on a canvas, so the wrapper carries them as the DOM-visible contract
      // browser tests assert growth and series presence through.
      data-series-count={benchmarkPoints > 0 ? 3 : 2}
      data-strategy-points={points.length}
      data-benchmark-points={benchmarkPoints}
      data-cash-points={points.length}
      data-curve-from={points[0]?.date}
      data-curve-through={points.at(-1)?.date}
      data-period-start={periodStart}
      data-period-end={periodEnd}
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
            style={{ backgroundColor: BACKTEST_CHART_COLORS.strategy }}
            aria-hidden="true"
          />
          {STRATEGY_SCENARIO_LABEL}
        </span>
        <span className={styles.seriesItem}>
          <span
            className={styles.legendDot}
            style={{ backgroundColor: BACKTEST_CHART_COLORS.benchmark }}
            aria-hidden="true"
          />
          {benchmarkName}
        </span>
        <span className={styles.seriesItem}>
          <span
            className={styles.legendDot}
            style={{ backgroundColor: BACKTEST_CHART_COLORS.cash }}
            aria-hidden="true"
          />
          {CASH_SCENARIO_LABEL}
        </span>
      </div>
    </div>
  );
}
