"use client";

import {
  BACKTEST_FAILURE_PHASE_LABELS,
  BACKTEST_RUN_STATUS_LABELS,
  isTerminalBacktestStatus,
  type BacktestCurvePointResponse,
  type BacktestFailureResponse,
  type BacktestHoldingResponse,
  type BacktestMilestoneResponse,
  type BacktestRunConfigurationResponse,
  type BacktestRunStatus,
  type BacktestTradeResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRef, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Notice } from "../../../components/ui/Notice";
import { LinkedEntities } from "../../../components/ui/EntityReference";
import { FactGrid } from "../../../components/ui/FactGrid";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { DetailSkeleton } from "../../../components/ui/Skeleton";
import {
  StatusBadge,
  type StatusTone,
} from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import { useBacktestRun } from "../hooks/use-backtest-run";
import { failureGuidance } from "../utils/failure";
import { rerunHref } from "../utils/prefill";
import {
  formatCount,
  formatDay,
  formatDerivedPercent,
  formatMoney,
  formatPeriod,
  formatSignedPercent,
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

/** Everything the result surfaces render, from the live snapshot or the durable result alike. */
type RunSnapshotView = {
  readonly curve: readonly BacktestCurvePointResponse[];
  readonly trades: readonly BacktestTradeResponse[];
  readonly holdings: readonly BacktestHoldingResponse[];
  readonly metrics: BacktestMetricsView;
  /** The run's true trade count, which can exceed the rows the payload carries. */
  readonly tradeCount: number;
  /** The date these holdings are valued at, so a staler holding price can be called out. */
  readonly asOf: string;
};

function statusTone(status: BacktestRunStatus): StatusTone {
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

/**
 * Where a completed run came from, and what it executed with.
 *
 * The Strategy, Stock List and Benchmark are the run's provenance; everything else is the
 * configuration it froze. Both are read from the immutable submission snapshot, never re-derived
 * from the current rows — which is also why a reference can be present by name and absent by id:
 * the entity it named has since been deleted, and the run still describes it truthfully.
 */
function RunProvenance({
  configuration,
  queuedAt,
  completedAt,
}: {
  readonly configuration: BacktestRunConfigurationResponse;
  readonly queuedAt: string;
  readonly completedAt: string | null;
}) {
  return (
    // The whole block is the run's configuration: the entities it named and the parameters it
    // froze. The test id sits here rather than on the facts alone so "what did this run use?"
    // covers the Strategy, Stock List and Benchmark too.
    <div className={styles.provenance} data-testid="backtest-configuration">
      <LinkedEntities
        entities={[
          {
            label: "Strategy",
            kind: "strategy",
            name: `${configuration.strategyName} · v${configuration.strategyVersionNumber}`,
            ...(configuration.strategyId
              ? { href: `/strategies/${configuration.strategyId}` }
              : {}),
          },
          {
            label: "Stock list",
            kind: "list",
            name: configuration.stockListName,
            ...(configuration.stockListId
              ? { href: `/lists/${configuration.stockListId}` }
              : {}),
          },
          {
            // A Benchmark is system-owned comparison data with no page of its own.
            label: "Benchmark",
            kind: "benchmark",
            name: configuration.benchmark.name,
          },
        ]}
      />
      <FactGrid
        facts={[
          { label: "Stocks", value: formatCount(configuration.securityCount) },
          {
            label: "Period",
            value: formatPeriod(configuration.startDate, configuration.endDate),
          },
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
            // Derived from `maximumPositions`, never entered: the run reports the fraction
            // it froze.
            label: "Full position",
            value: `${formatDerivedPercent(configuration.fullPositionPercent)}%`,
          },
          { label: "Queued", value: formatTimestamp(queuedAt) },
          ...(completedAt
            ? [{ label: "Finished", value: formatTimestamp(completedAt) }]
            : []),
        ]}
      />
    </div>
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
/**
 * The run's completed years, in order.
 *
 * A thirty-year simulation can finish between two polls, so the live snapshot alone would show a
 * user nothing but the final state. Milestones are persisted per completed year and never
 * overwritten, so this reads the progression the run actually went through — including afterwards.
 */
function BacktestMilestoneTrail({
  milestones,
}: {
  readonly milestones: readonly BacktestMilestoneResponse[];
}) {
  if (milestones.length === 0) {
    return null;
  }
  const latest = milestones[milestones.length - 1] as BacktestMilestoneResponse;
  return (
    <div className={styles.milestones} data-testid="backtest-milestones">
      <p className={styles.milestoneCaption}>
        {formatCount(milestones.length)} simulated{" "}
        {milestones.length === 1 ? "year" : "years"} · through {latest.year}
      </p>
      <ol
        className={styles.milestoneList}
        data-testid="backtest-milestone-years"
        data-milestone-count={milestones.length}
      >
        {milestones.map((milestone) => (
          <li
            key={milestone.sequence}
            className={styles.milestone}
            data-year={milestone.year}
            title={`${milestone.year}: ${formatSignedPercent(
              milestone.portfolioReturnPercent,
            )} after ${formatCount(milestone.tradeCount)} trades`}
          >
            <span className={styles.milestoneYear}>{milestone.year}</span>
            <span
              className={styles.milestoneReturn}
              data-tone={
                milestone.portfolioReturnPercent >= 0 ? "positive" : "negative"
              }
            >
              {formatSignedPercent(milestone.portfolioReturnPercent)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The run's own id, selectable and copyable.
 *
 * A failed run is the one moment a user needs to quote an identifier back to someone, so it is
 * offered rather than left to be read off the address bar. Clipboard access can be refused, so the
 * id stays visible and selectable whether or not the copy succeeds.
 */
function RunIdentifier({ runId }: { readonly runId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={styles.runId}>
      <code data-testid="backtest-run-id">{runId}</code>
      <button
        type="button"
        className={styles.copyButton}
        data-testid="backtest-copy-run-id"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(runId)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/**
 * A failed run, told as cause and recovery (UI-031).
 *
 * The explanation comes from `failureGuidance`, never from the raw code; the code, the phase and
 * the run id are still one click away under "Details for support", which is what someone quoting
 * the failure back to support needs. The recovery opens New Backtest prefilled from this run's
 * immutable snapshot — the run itself is never changed.
 */
function FailurePanel({
  runId,
  failure,
  configuration,
}: {
  readonly runId: string;
  readonly failure: BacktestFailureResponse | null;
  readonly configuration: BacktestRunConfigurationResponse;
}) {
  const guidance = failureGuidance(failure);
  return (
    <Notice
      tone="error"
      announce="alert"
      testId="backtest-failure"
      title={guidance.title}
      actions={
        <>
          <Link
            className={forms.primaryButton}
            href={rerunHref(runId, configuration)}
            data-testid="backtest-failure-rerun"
          >
            {guidance.recovery === "edit"
              ? "Edit and run again"
              : "Run again with these settings"}
          </Link>
          <Link className={forms.secondaryButton} href="/backtests">
            Back to Backtests
          </Link>
        </>
      }
    >
      <p data-testid="backtest-failure-cause">{guidance.cause}</p>
      <p data-testid="backtest-failure-next">{guidance.next}</p>
      <details className={styles.support} data-testid="backtest-failure-facts">
        <summary>Details for support</summary>
        <dl className={styles.failureFacts}>
          {failure?.phase ? (
            <div className={styles.failureFact}>
              <dt>Stopped while</dt>
              <dd data-testid="backtest-failure-phase">
                {BACKTEST_FAILURE_PHASE_LABELS[failure.phase]}
              </dd>
            </div>
          ) : null}
          {failure?.code ? (
            <div className={styles.failureFact}>
              <dt>Failure code</dt>
              <dd data-testid="backtest-failure-code">
                <code>{failure.code}</code>
              </dd>
            </div>
          ) : null}
          <div className={styles.failureFact}>
            <dt>Run ID</dt>
            <dd>
              <RunIdentifier runId={runId} />
            </dd>
          </div>
        </dl>
      </details>
    </Notice>
  );
}

export function BacktestRunView({ runId }: BacktestRunViewProps) {
  const {
    loadStatus,
    run,
    status,
    percent,
    message,
    live,
    milestones,
    failure,
    retry,
  } = useBacktestRun(runId);
  // The terminal checkpoint arrives one request before the refetched detail that carries the
  // durable result. Retaining the last snapshot is what keeps the chart, KPIs, holdings and trade
  // log on screen across that gap instead of blinking back to their empty states.
  const lastSnapshotRef = useRef<RunSnapshotView | null>(null);

  if (loadStatus === "loading") {
    return (
      <PageContainer>
        <DetailSkeleton
          thing="backtest"
          back={{ href: "/backtests", label: "Backtests" }}
        />
      </PageContainer>
    );
  }

  if (loadStatus === "not-found") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <EmptyState
            as="h1"
            testId="backtest-not-found"
            title="Backtest not found"
            body={
              <p>It may have been deleted, or it belongs to another account.</p>
            }
            actions={
              <Link className={forms.secondaryButton} href="/backtests">
                Back to Backtests
              </Link>
            }
          />
        </div>
      </PageContainer>
    );
  }

  if (loadStatus === "error" || run === null || status === null) {
    return (
      <PageContainer>
        <div className={styles.page}>
          <EmptyState
            as="h1"
            variant="error"
            title="This backtest could not be loaded"
            body={<p>This is usually temporary — try again in a moment.</p>}
            actions={
              <button
                type="button"
                className={forms.secondaryButton}
                onClick={retry}
              >
                Try again
              </button>
            }
          />
        </div>
      </PageContainer>
    );
  }

  const { configuration } = run;
  const result = run.result;
  const terminal = isTerminalBacktestStatus(status);
  const completed = status === "COMPLETED";
  const failed = status === "FAILED";
  // Everything the chart is still producing data for. A locked viewport, a value axis that only
  // grows and a refused gesture all follow from this one question, and it is the run's lifecycle
  // that answers it — not whether a curve happens to have arrived yet.
  const populating = !terminal;

  const arrived: RunSnapshotView | null = result
    ? {
        curve: result.curve,
        trades: result.trades,
        holdings: result.holdings,
        metrics: resultMetrics(result.summary),
        tradeCount: result.summary.totalTrades,
        asOf: result.summary.lastSimulatedDate,
      }
    : live
      ? {
          curve: live.curve,
          trades: live.recentTrades,
          holdings: live.holdings,
          metrics: liveMetrics(live),
          tradeCount: live.tradeCount,
          asOf: live.simulatedThrough,
        }
      : null;
  if (arrived) {
    lastSnapshotRef.current = arrived;
  }
  // A failed run has no partial result, and the prefix a dead attempt reached is not one. The
  // payload drops its live snapshot for exactly that reason, so the retained one is dropped with
  // it: keeping the curve, KPIs and holdings on screen beside a failure would read as an outcome.
  if (failed) {
    lastSnapshotRef.current = null;
  }
  const snapshot = failed ? null : (arrived ?? lastSnapshotRef.current);
  const curve = snapshot?.curve ?? [];

  return (
    <PageContainer>
      <div
        className={styles.page}
        data-testid="backtest-run"
        data-status={status}
      >
        {/* The outcome hero. A user opens this page to see what the run did, so identity,
            status, the curve and the headline numbers are one surface above everything
            else; the configuration that produced them follows, collapsed. */}
        <SectionCard hero ariaLabel="Backtest result" testId="backtest-hero">
          <PageHeader
            variant="hero"
            back={{ href: "/backtests", label: "Backtests" }}
            title={configuration.strategyName}
            lead={`${configuration.stockListName} · ${formatPeriod(
              configuration.startDate,
              configuration.endDate,
            )} · vs ${configuration.benchmark.name}`}
            badges={
              <StatusBadge tone={statusTone(status)} testId="backtest-status">
                {BACKTEST_RUN_STATUS_LABELS[status]}
              </StatusBadge>
            }
            // A finished run's natural next step is a variation of it (UI-032). The failure panel
            // carries its own recovery, so the hero offers this only for a completed run.
            {...(completed
              ? {
                  actions: (
                    <Link
                      className={forms.secondaryButton}
                      href={rerunHref(runId, configuration)}
                      data-testid="backtest-edit-and-rerun"
                    >
                      Edit and run again
                    </Link>
                  ),
                }
              : {})}
          />

          {terminal && milestones.length > 0 ? (
            <div
              data-testid="backtest-milestones-summary"
              aria-label="Simulated years"
            >
              <BacktestMilestoneTrail milestones={milestones} />
            </div>
          ) : null}
          {terminal ? null : (
            <div data-testid="backtest-progress" aria-label="Backtest progress">
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
              <BacktestMilestoneTrail milestones={milestones} />
            </div>
          )}

          {failed ? (
            <FailurePanel
              runId={runId}
              failure={failure}
              configuration={configuration}
            />
          ) : null}

          {failed ? null : (
            <>
              <p className={styles.chartCaption}>
                {`Strategy, ${configuration.benchmark.name} and cash — the same money, invested three ways. Each scenario receives the same initial capital and the same monthly contributions.`}
              </p>
              {/* One frame, one height. The chart is mounted as soon as the run exists, curve or not:
              its horizontal domain is the configured period, which is known before the first day
              is simulated, so the axis a user watches fill in is the axis the finished run will
              have. Only a run that ended with nothing to draw falls back to a message. */}
              <div className={styles.chartFrame}>
                {terminal && curve.length === 0 ? (
                  <p
                    className={styles.chartPlaceholder}
                    data-testid="backtest-chart-placeholder"
                  >
                    {/* A run that ended without a curve has nothing still to come, so promising
                    progress would be false. */}
                    This run produced no comparison curve.
                  </p>
                ) : (
                  <BacktestComparisonChart
                    points={curve}
                    benchmarkName={configuration.benchmark.name}
                    ariaLabel={`Strategy portfolio value against ${configuration.benchmark.name} and cash`}
                    periodStart={configuration.startDate}
                    periodEnd={configuration.endDate}
                    populating={populating}
                    initialCapital={configuration.initialCapital}
                    monthlyContribution={configuration.monthlyContribution}
                  />
                )}
              </div>

              <BacktestMetricsRow
                metrics={snapshot?.metrics ?? EMPTY_METRICS}
                benchmarkName={configuration.benchmark.name}
                caption={
                  terminal ? undefined : "Updating as the run progresses"
                }
              />
            </>
          )}
        </SectionCard>

        {/* The inputs follow the outcome, and stay out of the way until asked for. */}
        <details
          className={styles.configuration}
          data-testid="run-configuration"
        >
          <summary className={styles.configurationSummary}>
            Run configuration
          </summary>
          <p className={styles.configurationCaption}>
            Read from this run&apos;s immutable submission snapshot, not from
            the strategy or list as they stand today.
          </p>
          <RunProvenance
            configuration={configuration}
            queuedAt={run.queuedAt}
            completedAt={run.completedAt}
          />
        </details>

        {/* A failed run never produced holdings or trades. Showing "No positions" and "Trade log
            0" under a failure read as if the run had executed and simply bought nothing (UI-031). */}
        {failed ? null : (
          <div className={styles.columns}>
            <BacktestHoldings
              holdings={snapshot?.holdings ?? []}
              {...(snapshot ? { asOf: snapshot.asOf } : {})}
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
        )}
      </div>
    </PageContainer>
  );
}
