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
import { useEffect, useMemo, useRef } from "react";
import { useBoundedTimeScale } from "../../../components/charts/use-bounded-time-scale";
import { useValueDomainFloor } from "../../../components/charts/use-value-domain-floor";
import type { TimeDomain } from "../../../components/charts/time-domain";
import { BACKTEST_CHART_COLORS } from "../utils/chart-theme";
import { cashScenarioSpan, periodCalendarDays } from "../utils/chart-domain";
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
   * The configured period. It is the whole horizontal domain, known before the first day is
   * simulated and never widened, narrowed or re-derived from what has been computed.
   */
  readonly periodStart: string;
  readonly periodEnd: string;
  /**
   * The run is still producing data. The viewport is locked to the full period and every gesture
   * is refused, because a half-computed backtest is not something to inspect as if it were a
   * result; the value axis is held to a floor so arriving chunks extend the lines instead of
   * rescaling them.
   */
  readonly populating: boolean;
  /** The run's own capital plan, which is what the value axis can be sized from in advance. */
  readonly initialCapital: number;
  readonly monthlyContribution: number;
};

function legendRow(
  label: string,
  value: string,
  color?: string,
  dashed = false,
): HTMLElement {
  const row = document.createElement("span");
  row.className = styles.legendItem as string;
  if (color) {
    const dot = document.createElement("span");
    dot.className = styles.legendDot as string;
    dot.style.color = color;
    dot.style.backgroundColor = dashed ? "transparent" : color;
    if (dashed) {
      dot.dataset.shape = "dashed";
    }
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
 * **The horizontal domain is the configured period, whole, from the first render.** A whitespace
 * anchor puts a time point at each end, and the shared bounded time scale pins both edges to them,
 * so the axis spans 2000..2025 before a single day of 2000 has been computed and the lines fill in
 * from the left underneath it. Nothing here is ever fitted to what has been simulated: an axis that
 * tracked the computed prefix would race ahead of its own curve and rescale on every checkpoint.
 *
 * **The vertical domain is a floor, not a fixed range.** It starts at the span the Cash scenario is
 * already known to cover and only ever widens, so a year landing above everything drawn so far
 * widens the axis once and keeps it, while a year landing inside changes nothing. No value is ever
 * clipped and no value is ever invented: the not-yet-simulated part of the period is empty, the
 * crosshair reports nothing there, and the lines simply stop at the last observation that exists.
 *
 * The chart instance is created once and mutated through `setData`, so a completed calendar year
 * extends the curves without remounting anything and without a layout jump.
 */
export function BacktestComparisonChart({
  points,
  benchmarkName,
  ariaLabel,
  periodStart,
  periodEnd,
  populating,
  initialCapital,
  monthlyContribution,
}: BacktestComparisonChartProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const strategyRef = useRef<ISeriesApi<"Line"> | null>(null);
  const benchmarkRef = useRef<ISeriesApi<"Line"> | null>(null);
  const cashRef = useRef<ISeriesApi<"Line"> | null>(null);
  // Whitespace-only series carrying one slot per calendar day of the configured period. The slots
  // carry no value, so they add nothing to any scenario and nothing to the value axis; what they
  // give the chart is a horizontal domain that exists, at its true width, before any result does.
  const anchorRef = useRef<ISeriesApi<"Line"> | null>(null);
  // The crosshair handler is subscribed once; a ref keeps it reading the current benchmark name.
  const benchmarkNameRef = useRef(benchmarkName);
  benchmarkNameRef.current = benchmarkName;
  // The last date drawn, so a run that restarts — a requeued attempt re-simulates from day one —
  // is recognised as a regression rather than merged with what the dead attempt had reached.
  const drawnThroughRef = useRef<string | undefined>(undefined);

  const domain = useMemo<TimeDomain>(
    () => ({
      minTime: periodStart,
      maxTime: periodEnd,
      // The anchor is a real time point at the period's start, so the drawn domain is the whole
      // domain from the first render and the library's own edge pins are exact.
      oldestBar: periodStart,
      domainComplete: true,
      interaction: populating ? "LOCKED" : "BOUNDED",
    }),
    [periodStart, periodEnd, populating],
  );

  const valueFloor = useValueDomainFloor({
    // The Cash scenario's own span. It is the one part of a backtest whose shape is known before
    // it runs, it is guaranteed to be drawn, and it is never shown as a number — purely the
    // starting extent of the axis, which real data then widens.
    seed: useMemo(
      () =>
        cashScenarioSpan({
          initialCapital,
          monthlyContribution,
          periodStart,
          periodEnd,
        }),
      [initialCapital, monthlyContribution, periodStart, periodEnd],
    ),
    enforced: populating,
    resetKey: `${periodStart}|${periodEnd}`,
  });

  // The domain, materialized. A Lightweight Charts time scale is ordinal — bars sit one index
  // apart whatever the dates on them — so the period has to exist as slots before the curve can
  // occupy the fraction of it that has been computed.
  const domainDays = useMemo(
    () => periodCalendarDays(periodStart, periodEnd),
    [periodStart, periodEnd],
  );
  // The curve's days are days of the period, so the union of the two is the grid.
  const barCount = Math.max(domainDays.length, points.length);
  const timeScale = useBoundedTimeScale({
    domain,
    barCount,
    frame: { from: periodStart, to: periodEnd },
    // The viewport lives on the canvas, so the frame carries it as the DOM-visible contract
    // browser tests assert the bounds through — "a gesture never produced a date outside the
    // run's own period" is only answerable against the window the chart actually settled on.
    // Written imperatively: a viewport change must never cost a render.
    onVisibleRangeChange: () => {
      const frame = frameRef.current;
      const chart = chartRef.current;
      if (!frame || !chart) {
        return;
      }
      const dates = chart.timeScale().getVisibleRange();
      if (dates) {
        frame.dataset.visibleRange = `${String(dates.from)}|${String(dates.to)}`;
      } else {
        delete frame.dataset.visibleRange;
      }
    },
  });
  const { attachChart, showRange, syncAfterData } = timeScale;
  const { autoscaleInfoProvider, reset: resetValueFloor } = valueFloor;

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
        // Both edges of this chart are pinned, which makes the library's own minimum bar spacing
        // "whatever fits every point". Asking for less than that is how the default double-click
        // reset lands on exactly the configured period instead of an arbitrary 6px-per-bar window:
        // the request is clamped up to the full-period fit.
        barSpacing: 0.01,
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
    });

    const scenarioOptions = {
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider,
    };
    const strategy = chart.addSeries(LineSeries, {
      color: BACKTEST_CHART_COLORS.strategy,
      ...scenarioOptions,
    });
    const benchmark = chart.addSeries(LineSeries, {
      color: BACKTEST_CHART_COLORS.benchmark,
      ...scenarioOptions,
    });
    const cash = chart.addSeries(LineSeries, {
      color: BACKTEST_CHART_COLORS.cash,
      ...scenarioOptions,
      lineStyle: LineStyle.Dashed,
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
      // Nothing is reported on a date the run has not reached: the anchor and the empty part of
      // the period carry no observation, and a readout there would imply one exists.
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
          true,
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
    const detachTimeScale = attachChart(chart);

    return () => {
      // chart.remove() disposes every series, price line and subscription the instance owns; the
      // refs are cleared so a later effect run cannot touch disposed handles.
      detachTimeScale();
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
      strategyRef.current = null;
      benchmarkRef.current = null;
      cashRef.current = null;
      anchorRef.current = null;
      drawnThroughRef.current = undefined;
    };
  }, [attachChart, autoscaleInfoProvider]);

  useEffect(() => {
    const strategy = strategyRef.current;
    const benchmark = benchmarkRef.current;
    const cash = cashRef.current;
    if (!strategy || !benchmark || !cash) {
      return;
    }

    // A requeued attempt re-simulates from the first day, so its curve is shorter than what the
    // dead attempt had already drawn. `setData` replaces rather than merges, so the stale points
    // are gone either way; what has to go with them is the value axis the dead attempt widened.
    const through = points.at(-1)?.date;
    const regressed =
      drawnThroughRef.current !== undefined &&
      (through === undefined || through < drawnThroughRef.current);
    if (regressed) {
      resetValueFloor();
    }
    drawnThroughRef.current = through;

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

    // Lightweight Charts keeps the visible *logical* range across a data write, so a curve growing
    // from a hundred points to three hundred would leave the same window covering a third of the
    // period. Re-asserting the domain is what keeps the axis still while the lines fill in; it is
    // a no-op once the run is finished and the viewport belongs to the user.
    syncAfterData();
  }, [points, syncAfterData, resetValueFloor]);

  // The anchor, and the one framing of the period. Both depend only on the configured period, so a
  // year completing never touches either.
  //
  // Declared *after* the effect that draws the curves on purpose. React runs effects in order, and
  // a visible range is resolved against the time points that exist when it is written: framing
  // before the curves are drawn would name the period over a two-point scale, and the data write
  // that followed would leave that same two-bar logical window covering the first week of a
  // thirty-year run.
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || !periodStart || !periodEnd) {
      return;
    }
    anchor.setData(domainDays.map((day) => ({ time: day as Time })));
    showRange(periodStart, periodEnd);
  }, [domainDays, periodStart, periodEnd, showRange]);

  const benchmarkPoints = points.reduce(
    (total, point) => (point.benchmarkValue === null ? total : total + 1),
    0,
  );
  const simulatedThrough = points.at(-1)?.date;

  return (
    <div
      ref={frameRef}
      className={styles.frame}
      data-testid="backtest-chart"
      // The curves live on a canvas, so the wrapper carries them as the DOM-visible contract
      // browser tests assert growth, bounds and interaction through.
      data-series-count={benchmarkPoints > 0 ? 3 : 2}
      data-strategy-points={points.length}
      data-benchmark-points={benchmarkPoints}
      data-cash-points={points.length}
      data-curve-from={points[0]?.date}
      data-curve-through={simulatedThrough}
      data-period-start={periodStart}
      data-period-end={periodEnd}
      data-interaction={populating ? "locked" : "bounded"}
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
        {/* How far the lines have actually been drawn, in the caption row that already names the
            scenarios. The progress itself is the lines extending; this only says where they end,
            so a user reading a half-drawn chart knows it is half-drawn. */}
        {populating && simulatedThrough ? (
          <span
            className={styles.seriesProgress}
            data-testid="backtest-chart-progress"
          >
            Running · through {formatDay(simulatedThrough)}
          </span>
        ) : null}
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
            data-shape="dashed"
            style={{ color: BACKTEST_CHART_COLORS.cash }}
            aria-hidden="true"
          />
          {CASH_SCENARIO_LABEL}
        </span>
      </div>
    </div>
  );
}
