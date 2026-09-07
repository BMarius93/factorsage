"use client";

import {
  BACKTEST_RUN_STATUS_LABELS,
  isTerminalBacktestStatus,
  type BacktestCurvePointResponse,
  type BacktestHoldingResponse,
  type BacktestRunConfigurationResponse,
  type BacktestRunStatus,
  type BacktestTradeResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRef } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import forms from "../../../components/ui/forms.module.css";
import { useBacktestRun } from "../hooks/use-backtest-run";
import {
  formatCount,
  formatDay,
  formatDerivedPercent,
  formatMoney,
  formatPeriod,
  formatTimestamp,
} from "../utils/format";
import {
  EMPTY_METRICS,
  liveMetrics,
  resultMetrics,
  type BacktestMetricsView,
} from "../utils/metrics";
import { BacktestComparisonChart } from "./BacktestComparisonChart";
import { BacktestHoldings } from "./BacktestHoldings";
import { BacktestMetricsRow } from "./BacktestMetricsRow";
import { BacktestTrades } from "./BacktestTrades";
import styles from "./BacktestRunView.module.css";

/** The exact copy the chart card shows until the first checkpoint carries a curve. */
export const CHART_PLACEHOLDER_TEXT =
  "Your results will appear here as the backtest progresses.";

/** Everything the result surfaces render, from the live snapshot or the durable result alike. */
type RunSnapshotView = {
  readonly curve: readonly BacktestCurvePointResponse[];
  readonly trades: readonly BacktestTradeResponse[];
  readonly holdings: readonly BacktestHoldingResponse[];
  readonly metrics: BacktestMetricsView;
  /** The run's true trade count, which can exceed the rows the payload carries. */
  readonly tradeCount: number;
};

function statusTone(status: BacktestRunStatus): string {
  switch (status) {
    case "COMPLETED":
      return "positive";
    case "FAILED":
      return "negative";
    case "RUNNING":
    case "FINALIZING":
      return "active";
    default:
      return "pending";
  }
}

function ConfigurationFacts({
  configuration,
}: {
  readonly configuration: BacktestRunConfigurationResponse;
}) {
  const facts: ReadonlyArray<{ label: string; value: string }> = [
    { label: "Stock list", value: configuration.stockListName },
    { label: "Stocks", value: formatCount(configuration.securityCount) },
    {
      label: "Period",
      value: formatPeriod(configuration.startDate, configuration.endDate),
    },
    { label: "Benchmark", value: configuration.benchmark.name },
    {
      label: "Initial capital",
      value: formatMoney(configuration.initialCapital),
    },
    {
      label: "Monthly contribution",
      value:
        configuration.monthlyContribution > 0
          ? formatMoney(configuration.monthlyContribution)
          : "None",
    },
    {
      label: "Max positions",
      value: formatCount(configuration.maximumPositions),
    },
    {
      // Derived from `maximumPositions`, never entered: the run reports the fraction it froze.
      label: "Full position",
      value: `${formatDerivedPercent(configuration.fullPositionPercent)}%`,
    },
  ];

  return (
    <dl className={styles.facts} data-testid="backtest-configuration">
      {facts.map((fact) => (
        <div key={fact.label} className={styles.fact}>
          <dt className={styles.factLabel}>{fact.label}</dt>
          <dd className={styles.factValue}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type BacktestRunViewProps = {
  readonly runId: string;
};

/**
 * One backtest run: the same page while it queues, while it executes, and once it is finished.
 *
 * There is deliberately no separate "results page". A run's identity, configuration and result
 * surfaces stay in place and fill in as checkpoints arrive, so watching a run finish never costs a
 * navigation, a reload or a layout jump — the chart replaces its own placeholder inside a frame
 * that already has the height it will keep.
 */
export function BacktestRunView({ runId }: BacktestRunViewProps) {
  const { loadStatus, run, status, percent, message, live, failure, retry } =
    useBacktestRun(runId);
  // The terminal checkpoint arrives one request before the refetched detail that carries the
  // durable result. Retaining the last snapshot is what keeps the chart, KPIs, holdings and trade
  // log on screen across that gap instead of blinking back to their empty states.
  const lastSnapshotRef = useRef<RunSnapshotView | null>(null);

  if (loadStatus === "loading") {
    return (
      <PageContainer>
        <div className={styles.page} aria-hidden="true">
          <div className={styles.skeletonHeader} />
          <div className={styles.skeletonCard} />
          <div className={styles.skeletonCard} />
        </div>
      </PageContainer>
    );
  }

  if (loadStatus === "not-found") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <div className={styles.statusPanel} data-testid="backtest-not-found">
            <h1 className={styles.statusTitle}>This backtest was not found</h1>
            <p className={styles.statusBody}>
              It may have been deleted, or it belongs to another account.
            </p>
            <Link className={styles.primaryLink} href="/backtests">
              Back to backtests
            </Link>
          </div>
        </div>
      </PageContainer>
    );
  }

  if (loadStatus === "error" || run === null || status === null) {
    return (
      <PageContainer>
        <div className={styles.page}>
          <div className={styles.statusPanel} role="alert">
            <h1 className={styles.statusTitle}>
              This backtest could not be loaded
            </h1>
            <p className={styles.statusBody}>
              This is usually temporary — try again in a moment.
            </p>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={retry}
            >
              Try again
            </button>
          </div>
        </div>
      </PageContainer>
    );
  }

  const { configuration } = run;
  const result = run.result;
  const terminal = isTerminalBacktestStatus(status);
  const completed = status === "COMPLETED";

  const arrived: RunSnapshotView | null = result
    ? {
        curve: result.curve,
        trades: result.trades,
        holdings: result.holdings,
        metrics: resultMetrics(result.summary),
        tradeCount: result.summary.totalTrades,
      }
    : live
      ? {
          curve: live.curve,
          trades: live.recentTrades,
          holdings: live.holdings,
          metrics: liveMetrics(live),
          tradeCount: live.tradeCount,
        }
      : null;
  if (arrived) {
    lastSnapshotRef.current = arrived;
  }
  const snapshot = arrived ?? lastSnapshotRef.current;
  const curve = snapshot?.curve ?? [];

  return (
    <PageContainer>
      <div
        className={styles.page}
        data-testid="backtest-run"
        data-status={status}
      >
        <div className={styles.breadcrumb}>
          <Link className={styles.backLink} href="/backtests">
            ← Backtests
          </Link>
        </div>

        <header className={styles.header}>
          <div className={styles.identity}>
            <h1 className={styles.title}>{configuration.strategyName}</h1>
            <p className={styles.lead}>
              {configuration.stockListName} ·{" "}
              {formatPeriod(configuration.startDate, configuration.endDate)} ·
              vs {configuration.benchmark.name}
            </p>
            <p className={styles.meta}>
              Queued {formatTimestamp(run.queuedAt)}
              {run.completedAt
                ? ` · Finished ${formatTimestamp(run.completedAt)}`
                : null}
            </p>
          </div>
          <span
            className={styles.statusPill}
            data-testid="backtest-status"
            data-tone={statusTone(status)}
          >
            {BACKTEST_RUN_STATUS_LABELS[status]}
          </span>
        </header>

        <section className={styles.card} aria-label="Run configuration">
          <ConfigurationFacts configuration={configuration} />
        </section>

        {terminal ? null : (
          <section
            className={styles.progressCard}
            data-testid="backtest-progress"
            aria-label="Backtest progress"
          >
            <div className={styles.progressHead}>
              <span className={styles.phase}>
                {BACKTEST_RUN_STATUS_LABELS[status]}
              </span>
              <span
                className={styles.percent}
                data-testid="backtest-progress-percent"
              >
                {Math.round(percent)}%
              </span>
            </div>
            <div
              className={styles.track}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              aria-valuetext={`${Math.round(percent)}% complete`}
            >
              <span
                className={styles.fill}
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            </div>
            {message ? (
              <p
                className={styles.progressMessage}
                data-testid="backtest-progress-message"
              >
                {message}
              </p>
            ) : null}
            {live ? (
              <p className={styles.progressDetail}>
                Simulated through {formatDay(live.simulatedThrough)} · day{" "}
                {formatCount(live.completedDays)} of{" "}
                {formatCount(live.totalDays)}
              </p>
            ) : null}
          </section>
        )}

        {status === "FAILED" ? (
          <div
            className={styles.failure}
            role="alert"
            data-testid="backtest-failure"
          >
            <h2 className={styles.failureTitle}>
              This backtest could not finish
            </h2>
            <p className={styles.failureBody}>
              {failure?.message ??
                "The run stopped before it produced a result."}
            </p>
            <Link className={styles.primaryLink} href="/backtests/new">
              Start a new backtest
            </Link>
          </div>
        ) : null}

        <section className={styles.card} aria-labelledby="backtest-chart-title">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle} id="backtest-chart-title">
              Growth
            </h2>
            <p className={styles.cardCaption}>
              Portfolio and {configuration.benchmark.name}, as percentage growth
              from the run&apos;s first simulated date.
            </p>
          </div>
          {/* One frame, one height: the placeholder and the chart occupy exactly the same box, so
              the first checkpoint swaps content without moving anything below it. */}
          <div className={styles.chartFrame}>
            {curve.length > 0 ? (
              <BacktestComparisonChart
                points={curve}
                benchmarkName={configuration.benchmark.name}
                ariaLabel={`Portfolio growth against ${configuration.benchmark.name}`}
              />
            ) : (
              <p
                className={styles.chartPlaceholder}
                data-testid="backtest-chart-placeholder"
              >
                {/* A run that ended without a curve has nothing still to come, so promising
                    progress would be false. */}
                {terminal
                  ? "This run produced no comparison curve."
                  : CHART_PLACEHOLDER_TEXT}
              </p>
            )}
          </div>
        </section>

        <BacktestMetricsRow
          metrics={snapshot?.metrics ?? EMPTY_METRICS}
          benchmarkName={configuration.benchmark.name}
          caption={terminal ? undefined : "Updating as the run progresses"}
        />

        <div className={styles.columns}>
          <BacktestHoldings
            holdings={snapshot?.holdings ?? []}
            title={completed ? "Final holdings" : "Holdings"}
            emptyMessage={
              completed
                ? "The run ended holding nothing."
                : "No positions have been opened yet."
            }
          />
          <BacktestTrades
            trades={snapshot?.trades ?? []}
            title={terminal ? "Trade log" : "Recent trades"}
            emptyMessage={
              terminal
                ? "This run made no trades."
                : "No trades have been executed yet."
            }
            {...(snapshot ? { truncatedFrom: snapshot.tradeCount } : {})}
          />
        </div>
      </div>
    </PageContainer>
  );
}
