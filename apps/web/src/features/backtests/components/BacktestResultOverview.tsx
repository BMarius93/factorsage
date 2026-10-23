import type { BacktestCurvePointResponse } from "@intrinsic/contracts";
import type { BacktestMetricsView } from "../utils/metrics";
import { BacktestComparisonChart } from "./BacktestComparisonChart";
import { BacktestMetricsRow } from "./BacktestMetricsRow";
import styles from "./BacktestResultOverview.module.css";

export type BacktestResultOverviewProps = {
  /** Ascending curve points; grows with every checkpoint while a run executes. */
  readonly curve: readonly BacktestCurvePointResponse[];
  readonly metrics: BacktestMetricsView;
  /** The benchmark's own product name, from the run's snapshot. */
  readonly benchmarkName: string;
  /** The configured period: the chart's whole horizontal domain from the first render. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly initialCapital: number;
  readonly monthlyContribution: number;
  /**
   * The run is still producing data: the chart refuses gestures and holds its axes, and the
   * numbers say they are updating. A finished run with no curve shows a placeholder instead.
   */
  readonly populating: boolean;
};

/**
 * A run's chart and its eight result numbers, as one overview — the owner's result page and a
 * shared report (`docs/decisions/backtest-sharing-v1.md`) render this same component.
 *
 * The chart first: what the run *did* over the period, before the numbers that summarise it. The
 * three series are named by the legend under the plot, which is why there is no paragraph here
 * setting the comparison up — that sentence lives in the chart's own accessible description.
 *
 * One frame, one height. The chart is mounted as soon as the run exists, curve or not: its
 * horizontal domain is the configured period, which is known before the first day is simulated, so
 * the axis a user watches fill in is the axis the finished run will have. Only a run that ended with
 * nothing to draw falls back to a message.
 *
 * Side by side on a wide desktop — the chart about 70% of the width, the numbers a 2 x 4 grid
 * beside it — and stacked, chart first, wherever both would not fit comfortably. Only their
 * placement changes with the width; the same data reaches the same two components either way.
 */
export function BacktestResultOverview({
  curve,
  metrics,
  benchmarkName,
  periodStart,
  periodEnd,
  initialCapital,
  monthlyContribution,
  populating,
}: BacktestResultOverviewProps) {
  return (
    <div className={styles.overview} data-testid="backtest-overview">
      <div className={styles.chartFrame}>
        {!populating && curve.length === 0 ? (
          <p
            className={styles.chartPlaceholder}
            data-testid="backtest-chart-placeholder"
          >
            {/* A run that ended without a curve has nothing still to come, so promising progress
                would be false. */}
            This run produced no comparison curve.
          </p>
        ) : (
          <BacktestComparisonChart
            points={curve}
            benchmarkName={benchmarkName}
            ariaLabel={`Strategy portfolio value against ${benchmarkName} and cash. The same money invested three ways: each scenario receives the same initial capital and the same monthly contributions.`}
            periodStart={periodStart}
            periodEnd={periodEnd}
            populating={populating}
            initialCapital={initialCapital}
            monthlyContribution={monthlyContribution}
          />
        )}
      </div>

      {/* Then the eight numbers that summarise it. No surface of its own: a heading and a grid of
          tiles, so the totals do not read as a card inside the hero card. */}
      <BacktestMetricsRow
        metrics={metrics}
        benchmarkName={benchmarkName}
        caption={populating ? "Updating as the run progresses" : undefined}
      />
    </div>
  );
}
