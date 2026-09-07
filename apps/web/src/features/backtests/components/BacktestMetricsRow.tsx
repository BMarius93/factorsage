import type { ReactNode } from "react";
import {
  formatCount,
  formatDrawdownPercent,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
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
};

function toneOf(tile: Tile): string | undefined {
  if (tile.tone !== "signed" || tile.value === null || tile.value === 0) {
    return undefined;
  }
  return tile.value > 0 ? "positive" : "negative";
}

export type BacktestMetricsRowProps = {
  readonly metrics: BacktestMetricsView;
  /** The benchmark's own product name, so the comparison tile never says "S&P 500" by default. */
  readonly benchmarkName: string;
  readonly caption?: ReactNode;
};

/**
 * The eight numbers that describe a run, identical while it executes and after it completes.
 *
 * A metric that does not exist yet renders as a placeholder rather than a zero: a queued run has
 * not returned 0.00%, and a benchmark with no value at or before the run's first date has no
 * comparison to show. Presenting either as zero would be a fabricated result.
 */
export function BacktestMetricsRow({
  metrics,
  benchmarkName,
  caption,
}: BacktestMetricsRowProps) {
  const tiles: readonly Tile[] = [
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
      label: "Alpha",
      value: metrics.alphaPercent,
      render: formatSignedPercent,
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
      key: "max-drawdown",
      label: "Max drawdown",
      value: metrics.maxDrawdownPercent,
      render: formatDrawdownPercent,
      tone: "neutral",
    },
    {
      key: "trades",
      label: "Trades",
      value: metrics.tradeCount,
      render: formatCount,
      tone: "neutral",
    },
    {
      key: "open-positions",
      label: "Open positions",
      value: metrics.openPositions,
      render: formatCount,
      tone: "neutral",
    },
  ];

  return (
    <section className={styles.card} aria-labelledby="backtest-metrics-title">
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
              {tile.value === null
                ? METRIC_PLACEHOLDER
                : tile.render(tile.value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
