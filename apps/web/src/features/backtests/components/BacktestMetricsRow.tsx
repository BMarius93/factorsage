import type { ReactNode } from "react";
import {
  formatCount,
  formatDrawdownPercent,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
  formatSignedPoints,
  METRIC_PLACEHOLDER,
} from "../utils/format";
import type { BacktestMetricsView } from "../utils/metrics";
import styles from "./BacktestMetricsRow.module.css";

type Tone = "neutral" | "signed";

type Tile = {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly render: (value: number) => string;
  readonly tone: Tone;
  /**
   * The benchmark's figure for the same measure, written small beside the portfolio's in the
   * neutral text colour (BT-2). Omitted when the run has none — an executing run, a run without a
   * benchmark value — rather than shown as a placeholder.
   */
  readonly comparison?: number | null;
};

function toneOf(tile: Tile): string | undefined {
  if (tile.tone !== "signed" || tile.value === null || tile.value === 0) {
    return undefined;
  }
  return tile.value > 0 ? "positive" : "negative";
}

export type BacktestMetricsRowProps = {
  readonly metrics: BacktestMetricsView;
  /** The benchmark's own product name, so the comparison tile never names a benchmark by default. */
  readonly benchmarkName: string;
  readonly caption?: ReactNode;
};

/**
 * The eight numbers that describe a run, identical while it executes and after it completes.
 *
 * A metric that does not exist yet renders as a placeholder rather than a zero: a queued run has
 * not returned 0.00%, and a benchmark with no value at or before the run's first date has no
 * comparison to show. Presenting either as zero would be a fabricated result.
 *
 * Ordered by how a run is judged (BT-2): its annualized return and its worst decline first — each
 * with the benchmark's own figure beside it — then the cumulative returns and their difference,
 * then the money, then the activity. CAGR leads because it is the one return that compares a
 * thirty-year run with a three-year one.
 *
 * The section owns no surface. It is a heading and a grid of tiles inside the result hero, exactly
 * as Annual returns is, so the numbers read as part of one flat result rather than as a card nested
 * in a card. Where they sit is the run view's decision: beside the chart as a 2 x 4 grid from
 * 1,280px, under it on narrower screens.
 */
export function BacktestMetricsRow({
  metrics,
  benchmarkName,
  caption,
}: BacktestMetricsRowProps) {
  const tiles: readonly Tile[] = [
    {
      key: "cagr",
      label: "CAGR",
      value: metrics.portfolioCagrPercent,
      render: formatSignedPercent,
      tone: "signed",
      comparison: metrics.benchmarkCagrPercent,
    },
    {
      key: "max-drawdown",
      label: "Max drawdown",
      value: metrics.maxDrawdownPercent,
      render: formatDrawdownPercent,
      tone: "neutral",
      comparison: metrics.benchmarkMaxDrawdownPercent,
    },
    {
      key: "portfolio-return",
      label: "Portfolio return",
      value: metrics.portfolioReturnPercent,
      render: formatSignedPercent,
      tone: "signed",
    },
    {
      key: "benchmark-return",
      label: `${benchmarkName} return`,
      value: metrics.benchmarkReturnPercent,
      render: formatSignedPercent,
      tone: "signed",
    },
    {
      key: "alpha",
      // Not "Alpha": this is `portfolio return - benchmark return`, which is excess return. Alpha
      // in its usual sense is a regression intercept against a risk model, and calling a simple
      // difference by that name would claim a measurement the product has not made. The persisted
      // field keeps its name; only the word the user reads changes. It is a difference between two
      // percentages, so it is written in percentage points.
      label: "Excess return",
      value: metrics.alphaPercent,
      render: formatSignedPoints,
      tone: "signed",
    },
    {
      key: "portfolio-value",
      label: "Portfolio value",
      value: metrics.totalValue,
      render: formatMoney,
      tone: "neutral",
    },
    {
      key: "net-profit",
      label: "Net profit",
      value: metrics.netProfit,
      render: formatSignedMoney,
      tone: "signed",
    },
    {
      key: "trades",
      label: "Trades",
      value: metrics.tradeCount,
      render: formatCount,
      tone: "neutral",
    },
  ];

  return (
    <section
      className={styles.section}
      aria-labelledby="backtest-metrics-title"
      data-testid="backtest-results"
    >
      <div className={styles.head}>
        <h2 className={styles.title} id="backtest-metrics-title">
          Results
        </h2>
        {caption ? <p className={styles.caption}>{caption}</p> : null}
      </div>
      <dl className={styles.grid} data-testid="backtest-metrics">
        {tiles.map((tile) => (
          <div
            key={tile.key}
            className={styles.tile}
            data-testid={`metric-${tile.key}`}
            data-tone={toneOf(tile)}
          >
            <dt className={styles.label}>{tile.label}</dt>
            <dd className={styles.value}>
              <span className={styles.figure}>
                {tile.value === null
                  ? METRIC_PLACEHOLDER
                  : tile.render(tile.value)}
              </span>
              {tile.comparison !== undefined &&
              tile.comparison !== null &&
              tile.value !== null ? (
                <span
                  className={styles.comparison}
                  data-testid={`metric-${tile.key}-benchmark`}
                >
                  <span className={styles.srOnly}>, compared with </span>
                  {benchmarkName} {tile.render(tile.comparison)}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
